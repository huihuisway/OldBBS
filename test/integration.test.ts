import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { NestFactory } from '@nestjs/core';
import { DataSource, In } from 'typeorm';
import { createClient } from 'redis';
import { AppModule } from '../src/app.module';
import { config } from '../src/config';
import { AuthService } from '../src/auth/auth.service';
import { CommunityService } from '../src/community/community.service';
import { RateLimitService } from '../src/common/rate-limit.service';
import { Attachment, Board, Bookmark, Conversation, LoginAttempt, Message, Notification, Post, Report, Thread, User } from '../src/database/entities';
import { DevelopmentAttachmentScanner, StorageService } from '../src/storage/storage.service';

const localDatabaseHost = Boolean(config.database.socketPath) || ['localhost', '127.0.0.1', '::1'].includes(config.database.host);
const localRedisHost = ['localhost', '127.0.0.1', '::1'].includes(config.redis.host);
const integrationEnabled = process.env.OLDBBS_INTEGRATION === '1'
  && localDatabaseHost
  && localRedisHost
  && (/_test$/.test(config.database.name) || process.env.OLDBBS_INTEGRATION_ALLOW_UNSUFFIXED_DB === '1');

test('optional MySQL and Redis service integration: account, forum, search, permissions, moderation, messages, notifications and attachments', { skip: !integrationEnabled }, async () => {
  const priorSsh = config.ssh.enabled, priorTelnet = config.telnet.enabled;
  const priorUploadDir = config.uploadDir;
  const storageRoot = await mkdtemp(join(tmpdir(), 'oldbbs-integration-storage-'));
  config.ssh.enabled = false;
  config.telnet.enabled = false;
  config.uploadDir = storageRoot;
  const app = await NestFactory.createApplicationContext(AppModule, { logger: false });
  const redis = createClient({ socket: { host: config.redis.host, port: config.redis.port }, password: config.redis.password || undefined });
  const data = app.get(DataSource);
  const auth = app.get(AuthService);
  const community = app.get(CommunityService);
  const storage = app.get(StorageService);
  (storage as any).scanner = new DevelopmentAttachmentScanner();
  const users = data.getRepository(User);
  const boards = data.getRepository(Board);
  const threads = data.getRepository(Thread);
  const posts = data.getRepository(Post);
  const conversations = data.getRepository(Conversation);
  const marker = `it${Date.now().toString(36)}`.slice(-12);
  const password = 'Integration-password-28';
  let ids: number[] = [];
  let boardIds: number[] = [];
  let threadIds: number[] = [];
  let conversationIds: number[] = [];
  try {
    await redis.connect();
    app.get(RateLimitService).configure(redis as any);
    const first = await auth.register({ username: `${marker}a`, nickname: 'Integration A', password }, '198.51.100.55');
    const second = await auth.register({ username: `${marker}b`, nickname: 'Integration B', password }, '198.51.100.55');
    const adminRow = await users.findOneByOrFail({ id: first.id });
    await users.update(adminRow.id, { role: 'admin' });
    const admin = await auth.findById(first.id);
    assert.ok(admin);
    ids = [first.id, second.id];
    const authenticated = await auth.authenticate(first.username, password, '198.51.100.55');
    assert.equal((await auth.validateSession(authenticated.id, await auth.sessionVersionFor(authenticated.id)))?.id, authenticated.id);

    const publicBoard = await boards.save(boards.create({ slug: `${marker}-public`, name: 'Integration public', description: '', parentId: null, sortOrder: 0, isHidden: false, isReadOnly: false, minimumRole: null }));
    const privateBoard = await boards.save(boards.create({ slug: `${marker}-admin`, name: 'Integration admin', description: '', parentId: null, sortOrder: 1, isHidden: false, isReadOnly: false, minimumRole: 3 }));
    boardIds = [publicBoard.id, privateBoard.id];
    const thread = await community.createThread(first, publicBoard.id, `${marker} Integration Thread`, 'Opening post', undefined, undefined, ['integration-shared-tag']);
    threadIds.push(thread.id);
    const reply = await community.createPost(second, thread.id, 'Integration reply');
    assert.equal(reply.floor, 2);
    assert.equal((await community.threadPage(thread.id, 1, 'user')).posts.length, 2);
    assert.ok((await community.search(`${marker} Integration`, 'guest')).threads.some((item: any) => item.id === thread.id));
    assert.ok((await community.notificationsFor(first.id)).some((item: any) => item.type === 'reply'));
    assert.equal((await community.profile(first.username, 'guest')).user.postCount, 1);
    assert.equal((await community.profile(first.username, 'admin')).user.postCount, 1);
    assert.equal(Number((await community.listTags('guest')).find((tag: any) => tag.slug === 'integration-shared-tag')?.threadCount), 1);

    const privateThread = await community.createThread(admin, privateBoard.id, `${marker} Private Thread`, 'Admin-only content', undefined, undefined, ['integration-shared-tag']);
    threadIds.push(privateThread.id);
    assert.equal((await community.search(`${marker} Private`, 'guest')).threads.some((item: any) => item.id === privateThread.id), false);
    assert.equal((await community.search(`${marker} Private`, 'admin')).threads.some((item: any) => item.id === privateThread.id), true);
    assert.equal((await community.profile(first.username, 'guest')).user.postCount, 1);
    assert.equal((await community.profile(first.username, 'admin')).user.postCount, 2);
    assert.equal(Number((await community.listTags('guest')).find((tag: any) => tag.slug === 'integration-shared-tag')?.threadCount), 1);
    assert.equal(Number((await community.listTags('admin')).find((tag: any) => tag.slug === 'integration-shared-tag')?.threadCount), 2);

    await community.toggleBookmark(first, thread.id);
    assert.ok((await community.bookmarksFor(first.id, 'user')).some((item: any) => item.id === thread.id));
    const conversationId = await community.sendMessage(first, second.username, 'Integration private message');
    conversationIds.push(conversationId);
    assert.equal((await community.conversation(second.id, conversationId)).messages.length, 1);
    assert.ok((await community.listConversations(second.id)).some((item: any) => item.id === conversationId));
    await community.createReport(second, 'thread', thread.id, 'Integration report');

    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j2ioAAAAASUVORK5CYII=', 'base64');
    const attachment = await storage.saveUpload(first, { buffer: png, size: png.length, originalname: 'integration.png' } as Express.Multer.File);
    assert.equal(attachment.scanStatus, 'clean');
    assert.equal((await storage.getDownload(attachment.id, first)).item.id, attachment.id);
    await storage.deleteAttachment(first, attachment.id);
    assert.equal(await data.getRepository(Attachment).countBy({ id: attachment.id }), 0);
    assert.equal((await users.findOneByOrFail({ id: first.id })).storageUsedBytes, '0');

    await community.moderationAction(admin, 'delete', 'thread', thread.id, {}, '198.51.100.55');
    assert.equal((await community.latest(1, 'user')).threads.some((item: any) => item.id === thread.id), false);
    await community.moderationAction(admin, 'restore', 'thread', thread.id, {}, '198.51.100.55');
    assert.equal((await community.latest(1, 'user')).threads.some((item: any) => item.id === thread.id), true);
  } finally {
    try {
      if (conversationIds.length) await conversations.delete({ id: In(conversationIds) });
      if (threadIds.length) {
        await posts.delete({ threadId: In(threadIds) });
        await threads.delete({ id: In(threadIds) });
      }
      if (ids.length) await data.getRepository(Attachment).delete({ uploaderId: In(ids) });
      if (boardIds.length) await boards.delete({ id: In(boardIds) });
      if (ids.length) {
        await data.getRepository(Bookmark).delete({ userId: In(ids) });
        await data.getRepository(Notification).delete({ userId: In(ids) });
        await data.getRepository(Report).delete({ reporterId: In(ids) });
        await data.getRepository(Message).delete({ senderId: In(ids) });
        await users.delete({ id: In(ids) });
      }
      await data.getRepository(LoginAttempt).delete({ ip: '198.51.100.55' });
    } finally {
      await redis.quit().catch(() => undefined);
      await app.close();
      config.ssh.enabled = priorSsh;
      config.telnet.enabled = priorTelnet;
      config.uploadDir = priorUploadDir;
      await rm(storageRoot, { recursive: true, force: true });
    }
  }
});
