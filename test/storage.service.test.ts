import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ServiceUnavailableException } from '@nestjs/common';
import { ClamAvAttachmentScanner, DevelopmentAttachmentScanner, DisabledAttachmentScanner, StorageService } from '../src/storage/storage.service';

test('private attachments cannot be downloaded from hidden boards', async () => {
  const service: any = Object.create(StorageService.prototype);
  service.attachments = { findOneBy: async () => ({ id: 2, threadId: 4, uploaderId: 8, storageKey: 'attachment.pdf', scanStatus: 'clean' }) };
  service.threads = { findOneBy: async () => ({ id: 4, boardId: 3, status: 'visible' }) };
  service.boards = { findOneBy: async () => ({ id: 3, isHidden: true, minimumRole: null }) };

  await assert.rejects(service.getDownload(2, { id: 8, role: 'user' }), /Attachment not found/);
});

test('attachments pending malware scan cannot be downloaded', async () => {
  const service: any = Object.create(StorageService.prototype);
  service.attachments = { findOneBy: async () => ({ id: 2, threadId: null, uploaderId: 8, storageKey: 'attachment.pdf', scanStatus: 'pending_scan' }) };
  await assert.rejects(service.getDownload(2, { id: 8, role: 'user' }), /Attachment not found/);
});

test('development scanner explicitly marks files clean while disabled scanner rejects uploads', async () => {
  assert.equal(await new DevelopmentAttachmentScanner().scan('/unused'), 'clean');
  await assert.rejects(new DisabledAttachmentScanner().scan('/unused'), ServiceUnavailableException);
});

test('ClamAV scanner distinguishes clean, infected, and unavailable results', async () => {
  const scanner: any = new ClamAvAttachmentScanner();
  scanner.exec = async () => ({ stdout: '', stderr: '' });
  assert.equal(await scanner.scan('/unused'), 'clean');
  scanner.exec = async () => { throw Object.assign(new Error('infected'), { code: 1 }); };
  assert.equal(await scanner.scan('/unused'), 'rejected');
  scanner.exec = async () => { throw Object.assign(new Error('scanner stopped'), { code: 2 }); };
  assert.equal(await scanner.scan('/unused'), 'scan_failed');
  scanner.exec = async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); };
  await assert.rejects(scanner.scan('/unused'), ServiceUnavailableException);
});

test('attachment deletion removes stored bytes and releases quota after the database transaction', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oldbbs-storage-'));
  const path = join(root, 'test.bin');
  await writeFile(path, Buffer.from('stored'));
  const service: any = Object.create(StorageService.prototype);
  service.root = root;
  service.attachments = {
    findOneBy: async () => ({ id: 4, uploaderId: 8, storageKey: 'test.bin', fileSize: 6 }),
    count: async () => 0,
  };
  let quotaUpdated = false;
  service.db = { transaction: async (work: (manager: any) => Promise<void>) => work({
    getRepository: (entity: any) => entity.name === 'Attachment'
      ? { createQueryBuilder: () => ({ setLock() { return this; }, where() { return this; }, getOne: async () => ({ id: 4, uploaderId: 8, storageKey: 'test.bin', fileSize: 6 }) }), delete: async () => undefined }
      : { createQueryBuilder: () => ({ update() { return this; }, set() { return this; }, where() { return this; }, execute: async () => { quotaUpdated = true; } }) },
  }) };
  try {
    await service.deleteAttachment({ id: 8, role: 'user' }, 4);
    await assert.rejects(readFile(path));
    assert.equal(quotaUpdated, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('storage reconciliation refuses to treat a missing mount as an empty upload store', async () => {
  const service: any = Object.create(StorageService.prototype);
  service.root = join(tmpdir(), `oldbbs-missing-${Date.now()}`);
  await assert.rejects(service.reconcileStorage(), /refusing to reconcile attachment records/);
});

test('duplicate file uploads do not reveal whether another account uploaded the same SHA-256', async () => {
  const root = await mkdtemp(join(tmpdir(), 'oldbbs-dedup-'));
  await mkdir(join(root, '.incoming'), { recursive: true });
  const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=', 'base64');
  const service: any = Object.create(StorageService.prototype);
  service.root = root;
  service.incoming = join(root, '.incoming');
  service.attachments = { count: async () => 0, save: async (attachment: any) => ({ id: 1, ...attachment }) };
  service.scanner = { scan: async () => 'clean' };
  service.db = { transaction: async (work: (manager: any) => Promise<any>) => work({
    getRepository: (entity: any) => entity.name === 'User'
      ? { createQueryBuilder: () => ({ setLock() { return this; }, where() { return this; }, getOne: async () => ({ id: 8, status: 'active', storageUsedBytes: '0', storageQuotaBytes: '100000' }) }), update: async () => undefined }
      : { save: async (value: any) => ({ id: 1, ...value }) },
  }) };
  const upload = { buffer: image, size: image.length, originalname: 'same.png' } as Express.Multer.File;
  try {
    const one = await service.saveUpload({ id: 8, role: 'user' }, upload);
    const two = await service.saveUpload({ id: 9, role: 'user' }, upload);
    assert.equal(one.scanStatus, 'clean');
    assert.equal(two.scanStatus, 'clean');
  } finally { await rm(root, { recursive: true, force: true }); }
});
