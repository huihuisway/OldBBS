import { BadRequestException, ConflictException, Inject, Injectable, NotFoundException, OnApplicationBootstrap, OnApplicationShutdown, ServiceUnavailableException } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, writeFile, access, copyFile, readFile, readdir, stat, unlink, chmod } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { DataSource, MoreThan, Repository } from 'typeorm';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { fromBuffer } from 'file-type';
import { Attachment, Board, User } from '../database/entities';
import { config } from '../config';
import { PublicUser } from '../auth/auth.service';
import { Thread } from '../database/entities';
import { BoardPolicy } from '../community/board-policy';

const maxFileSize = 8 * 1024 * 1024;
const permittedMimeTypes = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp', 'application/pdf',
  'application/zip', 'application/x-dosexec', 'application/vnd.microsoft.portable-executable',
]);

export type ScanStatus = 'clean' | 'rejected' | 'scan_failed';
export interface AttachmentScanner { scan(path: string): Promise<ScanStatus>; }
export const ATTACHMENT_SCANNER = Symbol('ATTACHMENT_SCANNER');

@Injectable()
export class DisabledAttachmentScanner implements AttachmentScanner {
  async scan(_path: string): Promise<ScanStatus> { throw new ServiceUnavailableException('Attachments are disabled until a malware scanner is configured'); }
}

@Injectable()
export class DevelopmentAttachmentScanner implements AttachmentScanner {
  async scan(_path: string): Promise<ScanStatus> { return 'clean'; }
}

@Injectable()
export class ClamAvAttachmentScanner implements AttachmentScanner {
  private readonly exec = promisify(execFile);
  async scan(path: string): Promise<ScanStatus> {
    try {
      await this.exec(config.clamavCommand, ['--no-summary', '--quiet', path], { timeout: 30_000, maxBuffer: 64 * 1024 });
      return 'clean';
    } catch (error) {
      const code = (error as NodeJS.ErrnoException & { code?: number }).code;
      if (code === 1) return 'rejected';
      if (code === 'ENOENT') throw new ServiceUnavailableException('The malware scanner is unavailable');
      return 'scan_failed';
    }
  }
}

@Injectable()
export class StorageService implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly root = resolve(config.uploadDir);
  private readonly incoming = resolve(config.uploadDir, '.incoming');
  private cleanupTimer?: NodeJS.Timeout;
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    @InjectRepository(Attachment) private readonly attachments: Repository<Attachment>,
    @InjectRepository(Thread) private readonly threads: Repository<Thread>,
    @InjectRepository(Board) private readonly boards: Repository<Board>,
    @Inject(ATTACHMENT_SCANNER) private readonly scanner: AttachmentScanner,
  ) {}

  async onApplicationBootstrap() {
    await mkdir(this.incoming, { recursive: true, mode: 0o700 });
    await this.cleanIncoming();
    this.cleanupTimer = setInterval(() => { void this.cleanIncoming(); }, 60 * 60_000);
    this.cleanupTimer.unref();
  }

  onApplicationShutdown() { if (this.cleanupTimer) clearInterval(this.cleanupTimer); }

  async saveUpload(user: PublicUser, file: Express.Multer.File, threadId?: number) {
    if (!file || (!file.buffer?.length && !file.path)) throw new BadRequestException('Select a file first');
    if (file.size > maxFileSize) throw new BadRequestException('Files must be 8 MB or smaller');
    if (threadId && !(await this.canAccessThread(threadId, user))) throw new NotFoundException('Thread not found');
    const uploadedAt = new Date();
    if (await this.attachments.count({ where: { uploaderId: user.id, createdAt: MoreThan(new Date(uploadedAt.getTime() - 60 * 60_000)) } }) >= 20) throw new ConflictException('Upload limit reached. Try again later.');
    const bytes = file.buffer?.length ? file.buffer : await readFile(file.path!);
    const detected = await fromBuffer(bytes);
    if (!detected || !permittedMimeTypes.has(detected.mime)) throw new BadRequestException('File type is not supported');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const originalName = basename(file.originalname.replace(/[\r\n\0]/g, '').replace(/\\/g, '/')).slice(0, 255) || 'attachment';
    const extension = detected.ext.replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12) || 'bin';
    const storageKey = `${randomUUID()}.${extension}`;
    const destination = join(this.root, storageKey);
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    try {
      if (file.path) await copyFile(file.path, destination);
      else await writeFile(destination, bytes, { flag: 'wx', mode: 0o600 });
      await chmod(destination, 0o600);
      const scanStatus = await this.scanner.scan(destination);
      const item = await this.db.transaction(async (manager) => {
        const owner = await manager.getRepository(User).createQueryBuilder('u').setLock('pessimistic_write').where('u.id = :id', { id: user.id }).getOne();
        if (!owner || owner.status !== 'active') throw new NotFoundException('User not found');
        if (Number(owner.storageUsedBytes || 0) + file.size > Number(owner.storageQuotaBytes || 0)) throw new ConflictException('Your attachment storage quota has been reached');
        const saved = await manager.getRepository(Attachment).save({ storageKey, originalName, mimeType: detected.mime, fileSize: file.size, sha256, scanStatus, uploaderId: user.id, threadId: threadId || null });
        if (scanStatus !== 'rejected') await manager.getRepository(User).update(user.id, { storageUsedBytes: () => '`storageUsedBytes` + ' + Number(file.size) } as any);
        return saved;
      });
      if (scanStatus === 'rejected') await unlink(destination).catch(() => undefined);
      return item;
    } catch (error) {
      await unlink(destination).catch(() => undefined);
      throw error;
    } finally {
      if (file.path) await unlink(file.path).catch(() => undefined);
    }
  }

  async deleteAttachment(user: PublicUser, id: number) {
    const item = await this.attachments.findOneBy({ id });
    if (!item || (item.uploaderId !== user.id && user.role !== 'admin')) throw new NotFoundException('Attachment not found');
    await this.db.transaction(async (manager) => {
      const current = await manager.getRepository(Attachment).createQueryBuilder('a').setLock('pessimistic_write').where('a.id = :id', { id }).getOne();
      if (!current) return;
      await manager.getRepository(Attachment).delete(id);
      await manager.getRepository(User).createQueryBuilder().update(User)
        .set({ storageUsedBytes: () => 'GREATEST(storageUsedBytes - ' + Number(current.fileSize) + ', 0)' }).where('id = :userId', { userId: current.uploaderId }).execute();
    });
    const references = await this.attachments.count({ where: { storageKey: item.storageKey } });
    if (!references) await unlink(join(this.root, item.storageKey)).catch((error: NodeJS.ErrnoException) => { if (error.code !== 'ENOENT') throw error; });
  }

  async reconcileStorage() {
    const rootInfo = await stat(this.root).catch(() => null);
    if (!rootInfo?.isDirectory()) throw new ServiceUnavailableException('Upload storage directory is missing; refusing to reconcile attachment records');
    const rows = await this.attachments.find({ select: { id: true, storageKey: true } });
    const known = new Set(rows.map((row) => row.storageKey));
    const entries = await readdir(this.root, { withFileTypes: true });
    let orphanFilesRemoved = 0;
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === '.incoming' || known.has(entry.name)) continue;
      await unlink(join(this.root, entry.name)).catch(() => undefined);
      orphanFilesRemoved++;
    }
    const missing = (await Promise.all(rows.map(async (row) => await access(join(this.root, row.storageKey)).then(() => false).catch(() => true) ? row : null))).filter((row): row is typeof rows[number] => row !== null);
    for (const row of missing) await this.attachments.delete(row.id);
    await this.db.query("UPDATE users u LEFT JOIN (SELECT uploaderId, SUM(fileSize) AS usedBytes FROM attachments WHERE scanStatus <> 'rejected' GROUP BY uploaderId) a ON a.uploaderId = u.id SET u.storageUsedBytes = COALESCE(a.usedBytes, 0)");
    return { orphanFilesRemoved, missingRowsRemoved: missing.length, quotaUsersRebuilt: true };
  }

  async getDownload(id: number, user?: PublicUser) {
    const item = await this.attachments.findOneBy({ id });
    if (!item || item.scanStatus !== 'clean') throw new NotFoundException('Attachment not found');
    if (item.threadId) {
      if (!(await this.canAccessThread(item.threadId, user))) throw new NotFoundException('Attachment not found');
    } else if (!user || (user.id !== item.uploaderId && !['moderator', 'admin'].includes(user.role))) throw new NotFoundException('Attachment not found');
    const path = resolve(this.root, item.storageKey);
    if (!path.startsWith(`${this.root}/`)) throw new NotFoundException('Attachment not found');
    await access(path).catch(() => { throw new NotFoundException('Attachment not found'); });
    return { item, path };
  }

  private async canAccessThread(threadId: number, user?: PublicUser) {
    const thread = await this.threads.findOneBy({ id: threadId, status: 'visible' });
    if (!thread) return false;
    const board = await this.boards.findOneBy({ id: thread.boardId });
    if (!board) return false;
    return BoardPolicy.canReadThread(thread, board, user?.role || 'guest');
  }

  private async cleanIncoming() {
    const entries = await readdir(this.incoming, { withFileTypes: true }).catch(() => []);
    const cutoff = Date.now() - 60 * 60_000;
    for (const entry of entries) {
      if (!entry.isFile()) continue;
      const path = join(this.incoming, entry.name);
      const info = await stat(path).catch(() => null);
      if (info && info.mtimeMs < cutoff) await unlink(path).catch(() => undefined);
    }
  }
}
