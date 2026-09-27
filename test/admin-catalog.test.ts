import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CatalogService } from '../src/community/catalog.service';

const admin: any = { id: 1, username: 'admin', nickname: 'Admin', role: 'admin', status: 'active' };

function serviceHarness(kind: 'devices' | 'software', existing: any, duplicate: any = null) {
  let saved: any = null;
  const repo: any = {
    findOneBy: async (where: any) => where.id !== undefined ? (where.id === existing.id ? existing : null) : (duplicate?.slug === where.slug ? duplicate : null),
    save: async (value: any) => { saved = { ...value }; return saved; },
  };
  const audit: any = { save: async (entry: any) => entry };
  const service: any = Object.create(CatalogService.prototype);
  service.users = { findOneBy: async ({ id }: any) => id === admin.id ? admin : null };
  service.auth = { publicUser: (user: any) => user };
  service.audit = audit;
  service[kind] = repo;
  return { service, getSaved: () => saved };
}

test('administrator can update device catalog data and regenerate its readable slug', async () => {
  const existing = { id: 4, slug: 'old-xperia-name', name: 'Old Xperia Name', brand: 'Sony Ericsson', model: 'X10', platform: 'Android', releaseYear: 2010, osVersions: null, cpu: null, ram: null, storage: null, screen: null, description: '', cover: null };
  const { service, getSaved } = serviceHarness('devices', existing);
  const updated = await service.updateDevice(4, admin, { name: 'Xperia X10 archive', brand: 'Sony Ericsson', model: 'X10', platform: 'Android', releaseYear: '2010', osVersions: 'Android 1.6–2.3', cpu: 'Snapdragon QSD8250', ram: '384 MB', storage: '1 GB', screen: '4 inch', description: 'Catalog QA', cover: 'https://example.test/x10.jpg' }, '127.0.0.1');
  assert.equal(updated.slug, 'xperia-x10-archive');
  assert.equal(getSaved().osVersions, 'Android 1.6–2.3');
  assert.equal(getSaved().cover, 'https://example.test/x10.jpg');
});

test('device and software catalog edits reject duplicate slugs and non-admin actors', async () => {
  const device = { id: 4, slug: 'xperia', name: 'Xperia', brand: 'Sony', model: 'X10', platform: 'Android' };
  const deviceHarness = serviceHarness('devices', device, { id: 9, slug: 'new-name' });
  await assert.rejects(deviceHarness.service.updateDevice(4, admin, { name: 'New Name', brand: 'Sony', model: 'X10', platform: 'Android' }), /already uses that name/);
  const userService: any = Object.create(CatalogService.prototype);
  userService.users = { findOneBy: async () => ({ ...admin, role: 'user' }) };
  userService.auth = { publicUser: (user: any) => user };
  await assert.rejects(userService.updateSoftware(2, { ...admin, role: 'user' }, { name: 'QQ', platform: 'Android', version: '2012' }), /Administrator role/);
});

test('administrator can update software metadata without changing its moderation status', async () => {
  const existing = { id: 7, slug: 'qq-2012', name: 'QQ 2012', platform: 'Android', version: '2012', developer: null, description: '', minimumOs: null, architectures: null, downloadUrl: null, fileName: null, fileSize: null, sha256: null, status: 'pending' };
  const { service, getSaved } = serviceHarness('software', existing);
  const updated = await service.updateSoftware(7, admin, { name: 'QQ 2012 classic', platform: 'Android', version: '2012.1', developer: 'Tencent', minimumOs: 'Android 2.1', architectures: 'armeabi', downloadUrl: 'https://downloads.example.test/qq.apk', fileName: 'qq.apk', fileSize: '1048576', sha256: 'a'.repeat(64), description: 'Catalog QA' });
  assert.equal(updated.slug, 'qq-2012-classic');
  assert.equal(getSaved().fileSize, '1048576');
  assert.equal(getSaved().status, 'pending');
  assert.equal(getSaved().sha256, 'a'.repeat(64));
});
