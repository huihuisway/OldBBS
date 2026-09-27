import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { CommunityService } from '../src/community/community.service';
import { BoardPolicy, presentPost, wouldCreateBoardCycle } from '../src/community/board-policy';
import { Board, Post, Thread } from '../src/database/entities';
import { safeLocalNext } from '../src/common/redirect';
import { validCsrfToken } from '../src/common/csrf';
import { ModerationPolicy } from '../src/community/moderation-policy';
import { ModerationService } from '../src/community/moderation.service';
import { mysqlBooleanTerms } from '../src/common/fulltext';
import { WebController } from '../src/web/web.controller';

const board = (overrides: Partial<Board> = {}) => ({ id: 1, slug: 'restricted', name: 'Restricted', isHidden: false, isReadOnly: false, minimumRole: 2, ...overrides }) as Board;
const user = { id: 7, username: 'member', nickname: 'Member', role: 'user', status: 'active' } as any;

function serviceHarness() {
  const service: any = Object.create(CommunityService.prototype);
  const forumBoard = board();
  service.users = { findOneBy: async () => user, find: async () => [{ ...user, createdAt: new Date(), postCount: 1 }] };
  service.auth = { publicUser: (value: any) => value };
  service.rateLimits = { assertAllowed: async () => undefined };
  service.boards = { findOneBy: async () => forumBoard };
  service.threads = { findOneBy: async () => ({ id: 9, boardId: forumBoard.id, authorId: 8, status: 'visible', isLocked: false, viewCount: 0 }), findOne: async () => ({ id: 9, boardId: forumBoard.id, authorId: 8, status: 'visible', isLocked: false, viewCount: 0 }) };
  return { service, forumBoard };
}

test('minimumRole blocks thread creation and replies in the business layer', async () => {
  const { service } = serviceHarness();
  await assert.rejects(service.createThread(user, 1, 'A valid title', 'A valid post'), /Board not found/);
  await assert.rejects(service.createPost(user, 9, 'A valid reply'), /Board not found/);
});

test('ordinary users cannot edit or reply in a locked thread', async () => {
  const { service, forumBoard } = serviceHarness();
  forumBoard.minimumRole = null;
  const thread = { id: 9, boardId: 1, authorId: 7, status: 'visible', isLocked: true };
  service.threads.findOne = async () => thread;
  service.threads.findOneBy = async () => thread;
  service.posts = { findOneBy: async () => ({ id: 11, threadId: 9, authorId: 7, status: 'visible' }) };
  await assert.rejects(service.createPost(user, 9, 'A valid reply'), /thread is locked/);
  await assert.rejects(service.editPost(user, 11, 'An edited post'), /thread is locked/);
});

test('hidden board IDs cannot be read by an ordinary user', async () => {
  const { service, forumBoard } = serviceHarness();
  forumBoard.isHidden = true;
  await assert.rejects(service.getBoard(forumBoard.slug, 'user'), /Board not found/);
});

test('ordinary thread detail output redacts deleted and hidden post bodies', async () => {
  const { service, forumBoard } = serviceHarness();
  forumBoard.minimumRole = null;
  const thread = { id: 9, boardId: 1, authorId: 8, status: 'visible', viewCount: 0 } as Thread;
  service.threads.findOneBy = async () => thread;
  service.threads.increment = async () => undefined;
  const posts = [
    { id: 11, threadId: 9, authorId: 7, floor: 2, status: 'deleted', content: 'secret deleted body', createdAt: new Date() },
    { id: 12, threadId: 9, authorId: 7, floor: 3, status: 'hidden', content: 'secret hidden body', createdAt: new Date() },
  ] as Post[];
  service.posts = {
    createQueryBuilder: () => ({
      where() { return this; }, andWhere() { return this; }, orderBy() { return this; }, take() { return this; }, skip() { return this; },
      getManyAndCount: async () => [posts, 2],
    }),
    findOneBy: async () => null,
    update: async () => undefined,
  };
  service.tagsFor = async () => [];
  const result = await service.threadPage(9, 1, 'user');
  assert.deepEqual(result.posts.map((post: any) => post.content), [null, null]);
  assert.equal(JSON.stringify(result).includes('secret'), false);
  const moderatorView = presentPost(posts[0], 'moderator', user);
  assert.equal(moderatorView.content, 'secret deleted body');
});

test('post redaction only exposes the placeholder fields to regular users', () => {
  const post = { id: 3, threadId: 9, authorId: 2, floor: 8, status: 'deleted', content: 'private text', hiddenReason: 'private note', createdAt: new Date() } as any;
  const rendered = presentPost(post, 'user', { username: 'author' });
  assert.deepEqual(Object.keys(rendered).sort(), ['author', 'content', 'createdAt', 'floor', 'id', 'status', 'threadId'].sort());
  assert.equal(rendered.content, null);
  assert.equal('hiddenReason' in rendered, false);
});

test('board updates reject a self-parent and multi-level cycle', () => {
  const tree = [{ id: 1, parentId: null }, { id: 2, parentId: 1 }, { id: 3, parentId: 2 }] as Board[];
  assert.equal(wouldCreateBoardCycle(1, 1, tree), true);
  assert.equal(wouldCreateBoardCycle(1, 3, tree), true);
  assert.equal(wouldCreateBoardCycle(3, 1, tree), false);
  assert.equal(BoardPolicy.canWriteBoard(board({ minimumRole: 2 }), 'user'), false);
});

test('login next accepts only same-site relative paths', () => {
  assert.equal(safeLocalNext('/threads/8?q=old#reply'), '/threads/8?q=old#reply');
  for (const value of ['https://evil.example/', '//evil.example/', '/\\evil.example', 'javascript:alert(1)', '/%5c%5cevil.example']) assert.equal(safeLocalNext(value), '/');
});

test('CSRF accepts the session token from a form or header, never from a cookie value', () => {
  assert.equal(validCsrfToken('session-token', 'session-token', undefined), true);
  assert.equal(validCsrfToken('session-token', undefined, 'session-token'), true);
  assert.equal(validCsrfToken('session-token', 'wrong', undefined), false);
  assert.equal(validCsrfToken('session-token', undefined, undefined), false);
  // A browser automatically sending a cookie is not represented by either accepted input.
  assert.equal(validCsrfToken('session-token', undefined, undefined), false);
});

test('multipart upload checks the parsed form token before saving the file', async () => {
  let saved = false;
  const controller: any = new WebController(
    { assertRole: (user: any) => user } as any,
    {} as any,
    { saveUpload: async () => { saved = true; return { id: 1 }; } } as any,
  );
  const req: any = { session: { csrfToken: 'session-token', user }, headers: {} };
  const res: any = { render: (_view: string, value: unknown) => value };
  await assert.rejects(controller.uploadAttachment({} as any, {}, req, res), /form expired/);
  assert.equal(saved, false);
  const result = await controller.uploadAttachment({} as any, { _csrf: 'session-token' }, req, res);
  assert.equal(saved, true);
  assert.deepEqual(result, { attachment: { id: 1 } });
});

test('moderation policy restricts moderator account penalties and board scope', () => {
  const moderator = { ...user, role: 'moderator' } as any;
  const targetUser = { id: 8, role: 'user', status: 'active' } as any;
  const targetMod = { id: 9, role: 'moderator', status: 'active' } as any;
  const targetAdmin = { id: 10, role: 'admin', status: 'active' } as any;
  assert.doesNotThrow(() => ModerationPolicy.assertCanModerateUser(moderator, targetUser));
  assert.throws(() => ModerationPolicy.assertCanModerateUser(moderator, targetMod), /regular user/);
  assert.throws(() => ModerationPolicy.assertCanModerateUser(moderator, targetAdmin), /regular user/);
  assert.doesNotThrow(() => ModerationPolicy.assertCanModerateUser({ ...user, role: 'admin' } as any, targetMod));
  assert.doesNotThrow(() => ModerationPolicy.assertCanManageBoard(moderator, board({ minimumRole: null })));
  assert.throws(() => ModerationPolicy.assertCanManageBoard(moderator, board({ minimumRole: 3 })), /Board not found/);
  assert.doesNotThrow(() => ModerationPolicy.assertCanManageBoard({ ...user, role: 'admin' } as any, board({ minimumRole: 3 })));
});

test('guessed moderation IDs cannot cross an admin-only board boundary', async () => {
  const service: any = Object.create(ModerationService.prototype);
  const moderator = { ...user, role: 'moderator' } as any;
  service.currentUser = async (actor: any) => actor;
  service.threads = { findOneBy: async () => ({ id: 99, boardId: 77, status: 'visible' }), update: async () => assert.fail('must not update') };
  service.boards = { findOneBy: async () => board({ id: 77, minimumRole: 3 }) };
  await assert.rejects(service.moderationAction(moderator, 'lock', 'thread', 99, {}, ''), /Board not found/);

  service.threads.findOneBy = async () => null;
  await assert.rejects(service.moderationAction(moderator, 'lock', 'thread', 100, {}, ''), /Thread not found/);
  service.posts = { findOneBy: async () => null };
  await assert.rejects(service.moderationAction(moderator, 'delete', 'post', 101, {}, ''), /Post not found/);
});

test('moderators cannot resolve a report for an inaccessible board', async () => {
  const service: any = Object.create(ModerationService.prototype);
  const moderator = { ...user, role: 'moderator' } as any;
  service.currentUser = async (actor: any) => actor;
  service.reports = { findOneBy: async () => ({ id: 4, targetType: 'thread', targetId: 99 }), update: async () => assert.fail('must not update') };
  service.threads = { findOneBy: async () => ({ id: 99, boardId: 77, status: 'visible' }) };
  service.boards = { findOneBy: async () => board({ id: 77, minimumRole: 3 }) };
  await assert.rejects(service.moderationAction(moderator, 'resolve', 'report', 4, {}, ''), /Board not found/);
});

test('FULLTEXT query terms split Chinese text for ngram and use whole words without it', () => {
  assert.equal(mysqlBooleanTerms('安卓手机', true), '+安卓* +卓手* +手机*');
  assert.equal(mysqlBooleanTerms('安卓手机', false), '+安卓手机*');
  assert.equal(mysqlBooleanTerms('legacy phone', false), '+legacy* +phone*');
});
