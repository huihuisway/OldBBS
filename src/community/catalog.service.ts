import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { AuthService, PublicUser } from '../auth/auth.service';
import { mysqlBooleanTerms } from '../common/fulltext';
import { slugify } from '../common/content';
import { AuditLog, CompatibilityReport, Device, Software, User } from '../database/entities';
import { rethrowReadableDatabaseError } from '../common/database-errors';

@Injectable()
export class CatalogService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly auth: AuthService,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Device) private readonly devices: Repository<Device>,
    @InjectRepository(Software) private readonly software: Repository<Software>,
    @InjectRepository(CompatibilityReport) private readonly reports: Repository<CompatibilityReport>,
    @InjectRepository(AuditLog) private readonly audit: Repository<AuditLog>,
  ) {}

  async createDevice(user: PublicUser, input: Partial<Device>) {
    user = await this.currentUser(user);
    const name = String(input.name ?? '').trim(), brand = String(input.brand ?? '').trim(), model = String(input.model ?? '').trim(), platform = String(input.platform ?? '').trim();
    if (!name || !brand || !model || !platform) throw new BadRequestException('Name, brand, model and platform are required');
    if (name.length > 180 || brand.length > 100 || model.length > 120 || platform.length > 80) throw new BadRequestException('A device field exceeds its maximum length');
    const releaseYear = input.releaseYear === null || input.releaseYear === undefined || String(input.releaseYear) === '' ? null : Number(input.releaseYear);
    if (releaseYear !== null && (!Number.isInteger(releaseYear) || releaseYear < 1800 || releaseYear > 2100)) throw new BadRequestException('Release year must be between 1800 and 2100');
    const description = String(input.description || '');
    if (description.length > 100_000) throw new BadRequestException('Device description is too long');
    try {
      return await this.devices.save(this.devices.create({ brand, model, name, platform, slug: slugify(name), releaseYear, osVersions: input.osVersions || null, cpu: input.cpu || null, ram: input.ram || null, storage: input.storage || null, screen: input.screen || null, description, cover: null, reviewStatus: ['admin', 'moderator'].includes(user.role) ? 'published' : 'pending_review', authorId: user.id }));
    } catch (error) { rethrowReadableDatabaseError(error, 'A device already uses that name'); }
  }

  async updateDevice(id: number, actor: PublicUser, input: Partial<Device>, ip = '') {
    actor = await this.currentUser(actor);
    if (actor.role !== 'admin') throw new ForbiddenException('Administrator role is required');
    const device = await this.devices.findOneBy({ id });
    if (!device) throw new NotFoundException('Device not found');
    const name = String(input.name ?? '').trim(), brand = String(input.brand ?? '').trim(), model = String(input.model ?? '').trim(), platform = String(input.platform ?? '').trim();
    if (!name || !brand || !model || !platform) throw new BadRequestException('Name, brand, model and platform are required');
    if (name.length > 180 || brand.length > 100 || model.length > 120 || platform.length > 80) throw new BadRequestException('A device field exceeds its maximum length');
    const slug = slugify(name);
    const duplicate = await this.devices.findOneBy({ slug });
    if (duplicate && duplicate.id !== id) throw new ConflictException('A device already uses that name');
    const yearText = String(input.releaseYear ?? '').trim();
    const releaseYear = yearText ? Number(yearText) : null;
    if (releaseYear !== null && (!Number.isInteger(releaseYear) || releaseYear < 1800 || releaseYear > 2100)) throw new BadRequestException('Release year must be between 1800 and 2100');
    const cover = String(input.cover ?? '').trim();
    if (cover && !/^https?:\/\//i.test(cover)) throw new BadRequestException('Cover URL must use HTTP or HTTPS');
    const optional = {
      osVersions: String(input.osVersions ?? '').trim() || null,
      cpu: String(input.cpu ?? '').trim() || null,
      ram: String(input.ram ?? '').trim() || null,
      storage: String(input.storage ?? '').trim() || null,
      screen: String(input.screen ?? '').trim() || null,
      description: String(input.description ?? '').slice(0, 100_000),
    };
    if ((optional.osVersions && optional.osVersions.length > 10_000) || (optional.cpu && optional.cpu.length > 160) || (optional.ram && optional.ram.length > 80) || (optional.storage && optional.storage.length > 100) || (optional.screen && optional.screen.length > 120)) throw new BadRequestException('A device specification exceeds its maximum length');
    let saved: Device;
    try { saved = await this.devices.save({ ...device, name, brand, model, platform, slug, releaseYear, ...optional, cover: cover || null }); }
    catch (error) { rethrowReadableDatabaseError(error, 'A device already uses that name'); }
    await this.log(actor, 'device.update', 'device', id, { fields: ['name', 'brand', 'model', 'platform', 'releaseYear', 'specifications', 'description', 'cover'] }, ip);
    return saved;
  }

  async listDevices(page = 1, query = '', pageSize = 25) {
    const { safePage, take, q } = this.pageInput(page, query, pageSize);
    const qb = this.devices.createQueryBuilder('d').where('d.status = :status AND d.reviewStatus = :reviewStatus', { status: 'active', reviewStatus: 'published' });
    if (q) {
      const terms = mysqlBooleanTerms(q, await this.hasNgramParser());
      if (Array.from(q).length < 2 || !terms) qb.andWhere('1 = 0');
      else qb.andWhere('MATCH(d.name, d.brand, d.model) AGAINST (:terms IN BOOLEAN MODE)', { terms });
    }
    const [data, total] = await qb.orderBy('d.name', 'ASC').addOrderBy('d.id', 'ASC').skip((safePage - 1) * take).take(take).getManyAndCount();
    return { data, meta: { page: safePage, page_size: take, total } };
  }

  async createSoftware(user: PublicUser, input: Partial<Software>) {
    user = await this.currentUser(user);
    const name = String(input.name || '').trim(), platform = String(input.platform || '').trim(), version = String(input.version || '').trim();
    if (!name || !platform || !version) throw new BadRequestException('Name, platform and version are required');
    if (name.length > 180 || platform.length > 80 || version.length > 80) throw new BadRequestException('A software field exceeds its maximum length');
    const downloadUrl = String(input.downloadUrl || '').trim(), sha256 = String(input.sha256 || '').trim();
    if (downloadUrl && !/^https?:\/\//i.test(downloadUrl)) throw new BadRequestException('Download URL must use HTTP or HTTPS');
    if (downloadUrl.length > 1000) throw new BadRequestException('Download URL is too long');
    if (sha256 && !/^[a-f0-9]{64}$/i.test(sha256)) throw new BadRequestException('SHA-256 must be 64 hexadecimal characters');
    const description = String(input.description || '');
    if (description.length > 100_000) throw new BadRequestException('Software description is too long');
    try {
      return await this.software.save(this.software.create({ slug: slugify(name), name, platform, version, developer: input.developer || null, description, minimumOs: input.minimumOs || null, architectures: input.architectures || null, downloadUrl: downloadUrl || null, fileName: input.fileName || null, fileSize: null, sha256: sha256.toLowerCase() || null, status: user.role === 'admin' || user.role === 'moderator' ? 'published' : 'pending_review', authorId: user.id }));
    } catch (error) { rethrowReadableDatabaseError(error, 'Software with that name already exists'); }
  }

  async updateSoftware(id: number, actor: PublicUser, input: Partial<Software>, ip = '') {
    actor = await this.currentUser(actor);
    if (actor.role !== 'admin') throw new ForbiddenException('Administrator role is required');
    const item = await this.software.findOneBy({ id });
    if (!item) throw new NotFoundException('Software not found');
    const name = String(input.name ?? '').trim(), platform = String(input.platform ?? '').trim(), version = String(input.version ?? '').trim();
    if (!name || !platform || !version) throw new BadRequestException('Name, platform and version are required');
    if (name.length > 180 || platform.length > 80 || version.length > 80) throw new BadRequestException('A software field exceeds its maximum length');
    const slug = slugify(name), duplicate = await this.software.findOneBy({ slug });
    if (duplicate && duplicate.id !== id) throw new ConflictException('Software with that name already exists');
    const developer = String(input.developer ?? '').trim(), minimumOs = String(input.minimumOs ?? '').trim(), architectures = String(input.architectures ?? '').trim();
    const description = String(input.description ?? '').slice(0, 100_000), downloadUrl = String(input.downloadUrl ?? '').trim(), fileName = String(input.fileName ?? '').trim();
    const fileSizeText = String(input.fileSize ?? '').trim(), fileSize = fileSizeText ? Number(fileSizeText) : null, sha256 = String(input.sha256 ?? '').trim().toLowerCase();
    if (developer.length > 180 || minimumOs.length > 100 || architectures.length > 10_000 || fileName.length > 255) throw new BadRequestException('A software field exceeds its maximum length');
    if (downloadUrl && !/^https?:\/\//i.test(downloadUrl)) throw new BadRequestException('Download URL must use HTTP or HTTPS');
    if (downloadUrl.length > 1000) throw new BadRequestException('Download URL is too long');
    if (fileSize !== null && (!Number.isSafeInteger(fileSize) || fileSize < 0)) throw new BadRequestException('File size must be a non-negative integer');
    if (sha256 && !/^[a-f0-9]{64}$/.test(sha256)) throw new BadRequestException('SHA-256 must contain 64 hexadecimal characters');
    let saved: Software;
    try { saved = await this.software.save({ ...item, name, slug, platform, version, developer: developer || null, minimumOs: minimumOs || null, architectures: architectures || null, description, downloadUrl: downloadUrl || null, fileName: fileName || null, fileSize: fileSize === null ? null : String(fileSize), sha256: sha256 || null }); }
    catch (error) { rethrowReadableDatabaseError(error, 'Software with that name already exists'); }
    await this.log(actor, 'software.update', 'software', id, { fields: ['name', 'platform', 'version', 'developer', 'minimumOs', 'architectures', 'description', 'downloadUrl', 'fileName', 'fileSize', 'sha256'] }, ip);
    return saved;
  }

  async listSoftware(page = 1, query = '', pageSize = 25) {
    const { safePage, take, q } = this.pageInput(page, query, pageSize);
    const qb = this.software.createQueryBuilder('s').where('s.status = :status', { status: 'published' });
    if (q) {
      const terms = mysqlBooleanTerms(q, await this.hasNgramParser());
      if (Array.from(q).length < 2 || !terms) qb.andWhere('1 = 0');
      else qb.andWhere('MATCH(s.name, s.platform, s.version, s.developer) AGAINST (:terms IN BOOLEAN MODE)', { terms });
    }
    const [data, total] = await qb.orderBy('s.createdAt', 'DESC').addOrderBy('s.id', 'DESC').skip((safePage - 1) * take).take(take).getManyAndCount();
    return { data, meta: { page: safePage, page_size: take, total } };
  }

  async addCompatibilityReport(user: PublicUser, input: { deviceId: number; softwareId: number; systemVersion: string; result: CompatibilityReport['result']; notes?: string }) {
    user = await this.currentUser(user);
    if (!(await this.devices.existsBy({ id: input.deviceId, status: 'active', reviewStatus: 'published' })) || !(await this.software.existsBy({ id: input.softwareId, status: 'published' }))) throw new NotFoundException('Device or software not found');
    if (!['working', 'partial', 'broken', 'unknown'].includes(input.result)) throw new BadRequestException('Invalid compatibility result');
    const systemVersion = input.systemVersion.trim();
    if (!systemVersion || systemVersion.length > 100 || (input.notes || '').length > 3000) throw new BadRequestException('System version and notes exceed their allowed lengths');
    return this.reports.save({ ...input, authorId: user.id, systemVersion, notes: (input.notes || '').trim(), status: 'pending' });
  }

  private pageInput(page: number, query: string, pageSize: number) {
    return { safePage: Math.max(1, Math.min(10000, Math.trunc(page) || 1)), take: Math.max(1, Math.min(100, Math.trunc(pageSize) || 25)), q: query.trim().slice(0, 80) };
  }

  private ngramParser?: Promise<boolean>;
  private async hasNgramParser(): Promise<boolean> {
    this.ngramParser ??= this.db.query("SELECT PLUGIN_STATUS FROM INFORMATION_SCHEMA.PLUGINS WHERE PLUGIN_NAME = 'ngram'")
      .then((rows: Array<{ PLUGIN_STATUS?: string }>) => rows.some((row) => row.PLUGIN_STATUS === 'ACTIVE'))
      .catch(() => false);
    return this.ngramParser;
  }

  private async currentUser(user: PublicUser) {
    const current = await this.users.findOneBy({ id: user.id });
    if (!current || current.status !== 'active') throw new ForbiddenException('This account is not active');
    return this.auth.publicUser(current);
  }

  private async log(actor: PublicUser, action: string, targetType: string, targetId: number, metadata: Record<string, unknown>, ip = '') {
    await this.audit.save({ actorId: actor.id, action, targetType, targetId, metadata, ip: ip.slice(0, 45) || null });
  }
}
