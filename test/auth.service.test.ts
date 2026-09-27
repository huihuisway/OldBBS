import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AuthService } from '../src/auth/auth.service';
import { TerminalAccountService } from '../src/community/terminal-account.service';

function createAuthHarness() {
  const users: any[] = [];
  const attempts: any[] = [];
  let nextUserId = 1;
  const userRepo: any = {
    create: (value: any) => ({ ...value }),
    save: async (value: any) => { const row = { sessionVersion: 0, storageQuotaBytes: '104857600', storageUsedBytes: '0', ...value, id: nextUserId++, createdAt: new Date(), updatedAt: new Date(), lastOnlineAt: null }; users.push(row); return row; },
    findOne: async ({ where }: any) => {
      const predicates = Array.isArray(where) ? where : [where];
      return users.find((user) => predicates.some((predicate) => Object.entries(predicate).every(([key, value]) => user[key] === value))) || null;
    },
    update: async (id: number, patch: any) => { const row = users.find((candidate) => candidate.id === id); if (row) Object.assign(row, patch); },
    existsBy: async ({ id }: any) => users.some((user) => user.id === id),
    createQueryBuilder: () => {
      let identity = '';
      let userId = 0;
      let patch: any;
      let updateMode = false;
      return {
        addSelect() { return this; },
        update() { updateMode = true; return this; },
        set(value: any) { patch = value; return this; },
        where(query: string, params: any) { identity = params.identity || ''; userId = params.userId || (query.includes('u.id') ? params.id : 0) || 0; return this; },
        getOne: async () => users.find((user) => userId ? user.id === userId : user.username === identity || user.email === identity) || null,
        execute: async () => { const row = users.find((user) => user.id === userId); if (row && updateMode) for (const [key, value] of Object.entries(patch)) row[key] = typeof value === 'function' ? Number(row[key] || 0) + 1 : value; return { affected: row ? 1 : 0 }; },
      };
    },
  };
  const attemptRepo: any = {
    create: (value: any) => ({ ...value }),
    save: async (value: any) => { const row = { ...value, id: attempts.length + 1, createdAt: new Date() }; attempts.push(row); return row; },
    update: async (id: number, patch: any) => { const row = attempts.find((candidate) => candidate.id === id); if (row) Object.assign(row, patch); },
    delete: async ({ createdAt }: any) => { const before = attempts.length; for (let i = attempts.length - 1; i >= 0; i--) if (attempts[i].createdAt < createdAt._value) attempts.splice(i, 1); return { affected: before - attempts.length }; },
    createQueryBuilder: () => {
      let params: any = {};
      let where = '';
      return {
        where(query: string, value: any) { where = query; params = value; return this; },
        andWhere(query: string, value?: any) { where += ` ${query}`; params = { ...params, ...value }; return this; },
        getCount: async () => attempts.filter((item) => {
          return (!where.includes('a.identity') || item.identity === params.identity) &&
            (!where.includes('a.ip') || item.ip === params.ip) &&
            (!where.includes('a.succeeded = false') || !item.succeeded) &&
            (!params.since || item.createdAt >= params.since);
        }).length,
      };
    },
  };
  const settings: any = { findOneBy: async () => null };
  return { service: new AuthService(userRepo, attemptRepo, settings), users, attempts };
}

test('registration stores a scrypt hash and login authenticates case-insensitive usernames', async () => {
  const { service, users } = createAuthHarness();
  const created = await service.register({ username: 'RetroFan', password: 'a-long-unique-password' }, '192.0.2.8');
  assert.equal(created.username, 'retrofan');
  assert.equal(users.length, 1);
  assert.match(users[0].passwordHash, /^scrypt\$32768\$/);
  assert.doesNotMatch(users[0].passwordHash, /a-long-unique-password/);
  const loggedIn = await service.authenticate('RETROFAN', 'a-long-unique-password', '192.0.2.8');
  assert.equal(loggedIn.id, created.id);
});

test('login rejects an incorrect password and rate-limits repeated failures', async () => {
  const { service } = createAuthHarness();
  await service.register({ username: 'rateuser', password: 'another-long-password' }, '192.0.2.9');
  await assert.rejects(service.authenticate('rateuser', 'wrong-password', '192.0.2.9'), /incorrect/);
  for (let i = 0; i < 7; i++) await assert.rejects(service.authenticate('rateuser', 'wrong-password', '192.0.2.9'));
  await assert.rejects(service.authenticate('rateuser', 'another-long-password', '192.0.2.9'), /Too many/);
});

test('password changes and bans revoke existing session versions', async () => {
  const { service, users } = createAuthHarness();
  const created = await service.register({ username: 'sessionuser', password: 'a-very-long-password' }, '192.0.2.15');
  assert.ok(await service.validateSession(created.id, 0));
  await service.changePassword(created.id, 'a-very-long-password', 'another-long-password');
  assert.equal(await service.validateSession(created.id, 0), null);
  assert.ok(await service.validateSession(created.id, 1));
  await service.ban(created.id, 'moderation', true);
  assert.equal(await service.validateSession(created.id, 1), null);
  assert.equal(users[0].sessionVersion, 2);
});

test('role checks deny guests and ordinary users from admin operations', () => {
  const { service } = createAuthHarness();
  assert.throws(() => service.assertRole(undefined, ['admin']), /Sign in/);
  assert.throws(() => service.assertRole({ role: 'user', status: 'active' } as any, ['admin']), /permission/);
  assert.equal(service.assertRole({ role: 'admin', status: 'active' } as any, ['admin']).role, 'admin');
});

test('Telnet terminal login never falls back to the site password', async () => {
  const service: any = Object.create(TerminalAccountService.prototype);
  let mainPasswordChecked = false;
  service.auth = { authenticate: async () => { mainPasswordChecked = true; throw new Error('should not be called'); } };
  service.authenticateTerminalKey = async () => null;
  const user = await service.terminalLogin('admin', 'main-site-password', '192.0.2.10', false);
  assert.equal(user, null);
  assert.equal(mainPasswordChecked, false);
});
