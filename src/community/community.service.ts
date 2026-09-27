import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, In, Repository } from 'typeorm';
import { AuthService, PublicUser } from '../auth/auth.service';
import { MARKDOWN_RENDER_VERSION, renderMarkdown, slugify } from '../common/content';
import { RateLimitService } from '../common/rate-limit.service';
import { BoardPolicy, BoardRole, presentPost } from './board-policy';
import { SearchService } from './search.service';
import { MessagingService } from './messaging.service';
import { CatalogService } from './catalog.service';
import { ModerationService } from './moderation.service';
import { TerminalAccountService } from './terminal-account.service';
import {
  Board, Bookmark, CompatibilityReport, Device, Follow,
  Notification, Post, Software, Tag, ThreadTag, Thread, User,
} from '../database/entities';

@Injectable()
export class CommunityService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly auth: AuthService,
    private readonly searchService: SearchService,
    private readonly messaging: MessagingService,
    private readonly catalog: CatalogService,
    private readonly moderation: ModerationService,
    private readonly terminalAccounts: TerminalAccountService,
    private readonly rateLimits: RateLimitService,
    @InjectRepository(Board) private readonly boards: Repository<Board>,
    @InjectRepository(Thread) private readonly threads: Repository<Thread>,
    @InjectRepository(Post) private readonly posts: Repository<Post>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Device) private readonly devices: Repository<Device>,
    @InjectRepository(Software) private readonly software: Repository<Software>,
    @InjectRepository(CompatibilityReport) private readonly reportsCompat: Repository<CompatibilityReport>,
    @InjectRepository(Bookmark) private readonly bookmarks: Repository<Bookmark>,
    @InjectRepository(Follow) private readonly follows: Repository<Follow>,
    @InjectRepository(Tag) private readonly tags: Repository<Tag>,
    @InjectRepository(ThreadTag) private readonly threadTags: Repository<ThreadTag>,
  ) {}

  async home(userRole: PublicUser['role'] | 'guest' = 'guest') {
    const visibleBoards = await this.listBoards(false, userRole);
    const visibleIds = visibleBoards.map((board) => board.id);
    if (!visibleIds.length) return { boards: [], threads: [], announcement: '', totals: { threads: 0, users: await this.users.count({ where: { status: 'active' } }), posts: 0, today: 0, online: 0 } };
    const start = new Date(new Date().setHours(0, 0, 0, 0));
    const [threads, threadCount, userCount, postCount, today, usersOnline, siteSettings] = await Promise.all([
      BoardPolicy.applyReadableBoardScope(this.threads.createQueryBuilder('t').where('t.status = :status', { status: 'visible' }), 't', userRole)
        .orderBy('t.isPinned', 'DESC').addOrderBy('t.lastPostAt', 'DESC').take(12).getMany(),
      BoardPolicy.applyReadableBoardScope(this.threads.createQueryBuilder('t').where('t.status = :status', { status: 'visible' }), 't', userRole).getCount(),
      this.users.count({ where: { status: 'active' } }),
      this.posts.createQueryBuilder('p').innerJoin(Thread, 't', 't.id = p.threadId AND t.status = :threadStatus', { threadStatus: 'visible' })
        .where('p.status = :postStatus', { postStatus: 'visible' }).andWhere('t.boardId IN (:...visibleBoardIds)', { visibleBoardIds: visibleIds }).getCount(),
      this.posts.createQueryBuilder('p').innerJoin(Thread, 't', 't.id = p.threadId AND t.status = :threadStatus', { threadStatus: 'visible' })
        .where('p.status = :postStatus AND p.createdAt >= :start', { postStatus: 'visible', start }).andWhere('t.boardId IN (:...visibleBoardIds)', { visibleBoardIds: visibleIds }).getCount(),
      this.users.createQueryBuilder('u').where('u.status = :status AND u.lastOnlineAt >= :since', { status: 'active', since: new Date(Date.now() - 15 * 60_000) }).getCount(),
      this.moderation.siteSettings(),
    ]);
    return { boards: visibleBoards, threads: await this.enrichThreads(threads, userRole), announcement: siteSettings.announcement, totals: { threads: threadCount, users: userCount, posts: postCount, today, online: usersOnline } };
  }

  async listBoards(_includeHidden = false, userRole: BoardRole = 'guest') {
    const rows = await this.boards.find({ order: { sortOrder: 'ASC', id: 'ASC' } });
    return rows.filter((board) => BoardPolicy.canReadBoard(board, userRole));
  }

  async getBoard(slug: string, userRole: PublicUser['role'] | 'guest' = 'guest') {
    const board = await this.boards.findOneBy({ slug });
    if (!board) throw new NotFoundException('Board not found');
    BoardPolicy.assertBoardReadable(board, userRole);
    return board;
  }

  async listBoardThreads(slug: string, page = 1, userRole: PublicUser['role'] | 'guest' = 'guest') {
    const board = await this.getBoard(slug, userRole);
    const take = 30;
    const safePage = Math.max(1, Math.min(10000, Math.trunc(page) || 1));
    const [threads, count] = await this.threads.findAndCount({ where: { boardId: board.id, status: 'visible' }, order: { isPinned: 'DESC', lastPostAt: 'DESC', id: 'DESC' }, take, skip: (safePage - 1) * take });
    return { board, threads: await this.enrichThreads(threads, userRole), count, page: safePage, pages: Math.max(1, Math.ceil(count / take)) };
  }

  async threadPage(id: number, page = 1, userRole: BoardRole = 'guest', quotePostId?: number) {
    const candidate = await this.threads.findOneBy({ id });
    const board = candidate ? await this.boards.findOneBy({ id: candidate.boardId }) : null;
    BoardPolicy.assertThreadReadable(candidate, board, userRole);
    const thread = candidate;
    await this.threads.increment({ id }, 'viewCount', 1);
    const take = 20;
    const safePage = Math.max(1, Math.min(10000, Math.trunc(page) || 1));
    const postQuery = this.posts.createQueryBuilder('p').where('p.threadId = :threadId', { threadId: thread.id });
    if (!['moderator', 'admin'].includes(userRole)) postQuery.andWhere('p.status = :visible', { visible: 'visible' });
    const [posts, count] = await postQuery.orderBy('p.floor', 'ASC').take(take).skip((safePage - 1) * take).getManyAndCount();
    await this.ensureRendered(posts, userRole);
    const authors = await this.users.find({ where: { id: In([...new Set(posts.map((p) => p.authorId))]) } });
    const authorMap = new Map(authors.map((u) => [u.id, this.auth.publicUser(u)]));
    const quotePost = quotePostId ? await this.posts.findOneBy({ id: quotePostId, threadId: thread.id, status: 'visible' }) : null;
    if (quotePostId && !quotePost) throw new NotFoundException('Quoted post not found');
    const safePosts = posts.map((post) => presentPost(post, userRole, authorMap.get(post.authorId)));
    return { thread: { ...thread, viewCount: thread.viewCount + 1 }, board, posts: safePosts, quote: quotePost ? { postId: quotePost.id, floor: quotePost.floor, content: quotePost.content.slice(0, 2000) } : null, tags: await this.tagsFor([thread.id]), count, page: safePage, pages: Math.max(1, Math.ceil(count / take)) };
  }

  async createThread(user: PublicUser, boardId: number, title: string, content: string, deviceId?: number, softwareId?: number, tagNames: string[] = []) {
    user = await this.currentUser(user);
    await this.rateLimits.assertAllowed('thread.create', { userId: user.id }, 8, 10 * 60_000);
    const board = await this.boards.findOneBy({ id: boardId });
    BoardPolicy.assertBoardWritable(board, user.role);
    this.validatePost(title, content);
    if (deviceId && !(await this.devices.existsBy({ id: deviceId, status: 'active', reviewStatus: 'published' }))) throw new NotFoundException('Device not found');
    if (softwareId && !(await this.software.existsBy({ id: softwareId, status: 'published' }))) throw new NotFoundException('Software not found');
    const cleanTags = [...new Set(tagNames.map((name) => name.trim().slice(0, 48)).filter(Boolean))].slice(0, 8);
    return this.db.transaction(async (manager) => {
      const thread = await manager.getRepository(Thread).save(manager.getRepository(Thread).create({ boardId, authorId: user.id, title: title.trim(), slug: slugify(title), type: 'normal', status: 'visible', deviceId: deviceId || null, softwareId: softwareId || null, isPinned: false, isFeatured: false, isLocked: false, replyCount: 0, viewCount: 0, lastPostId: null, lastPostAt: new Date() }));
      const normalizedContent = content.trim();
      const post = await manager.getRepository(Post).save(manager.getRepository(Post).create({ threadId: thread.id, authorId: user.id, content: normalizedContent, renderedHtml: renderMarkdown(normalizedContent), renderVersion: MARKDOWN_RENDER_VERSION, contentFormat: 'markdown', floor: 1, replyToPostId: null, status: 'visible', deletedAt: null }));
      await manager.getRepository(Thread).update(thread.id, { lastPostId: post.id, lastPostAt: post.createdAt });
      await manager.getRepository(User).increment({ id: user.id }, 'postCount', 1);
      for (const name of cleanTags) {
        const tagRepo = manager.getRepository(Tag);
        const slug = slugify(name).slice(0, 64);
        await tagRepo.createQueryBuilder().insert().values({ name, slug }).orIgnore().updateEntity(false).execute();
        const tag = await tagRepo.findOneBy({ slug });
        if (tag) await manager.getRepository(ThreadTag).save({ threadId: thread.id, tagId: tag.id });
      }
      return { ...thread, lastPostId: post.id };
    });
  }

  async createPost(user: PublicUser, threadId: number, content: string, replyToPostId?: number) {
    user = await this.currentUser(user);
    await this.rateLimits.assertAllowed('post.create', { userId: user.id }, 20, 10 * 60_000);
    this.validatePost('reply', content);
    const thread = await this.threads.findOne({ where: { id: threadId, status: 'visible' } });
    if (!thread) throw new NotFoundException('Thread not found');
    const board = await this.boards.findOneBy({ id: thread.boardId });
    BoardPolicy.assertBoardWritable(board, user.role);
    if (thread.isLocked && !['moderator', 'admin'].includes(user.role)) throw new ForbiddenException('This thread is locked');
    let replyTo: Post | null = null;
    if (replyToPostId) {
      replyTo = await this.posts.findOne({ where: { id: replyToPostId, threadId, status: 'visible' } });
      if (!replyTo) throw new NotFoundException('Quoted post not found');
    }
    return this.db.transaction(async (manager) => {
      const lockedThread = await manager.getRepository(Thread).createQueryBuilder('t').setLock('pessimistic_write').where('t.id = :threadId', { threadId }).getOne();
      if (!lockedThread || lockedThread.status !== 'visible') throw new NotFoundException('Thread not found');
      const lockedBoard = await manager.getRepository(Board).findOneBy({ id: lockedThread.boardId });
      BoardPolicy.assertBoardWritable(lockedBoard, user.role);
      if (lockedThread.isLocked && !['moderator', 'admin'].includes(user.role)) throw new ForbiddenException('This thread is locked');
      const postRepo = manager.getRepository(Post);
      const max = await postRepo.createQueryBuilder('p').select('MAX(p.floor)', 'floor').where('p.threadId = :threadId', { threadId }).getRawOne<{ floor: string | null }>();
      const normalizedContent = content.trim();
      const post = await postRepo.save(postRepo.create({ threadId, authorId: user.id, content: normalizedContent, renderedHtml: renderMarkdown(normalizedContent), renderVersion: MARKDOWN_RENDER_VERSION, contentFormat: 'markdown', floor: Number(max?.floor || 0) + 1, replyToPostId: replyTo?.id || null, status: 'visible', deletedAt: null }));
      await manager.getRepository(Thread).update(threadId, { replyCount: lockedThread.replyCount + 1, lastPostId: post.id, lastPostAt: post.createdAt });
      await manager.getRepository(User).increment({ id: user.id }, 'postCount', 1);
      if (thread.authorId !== user.id) await manager.getRepository(Notification).save({ userId: thread.authorId, type: 'reply', title: 'Your thread has a new reply', body: `${user.nickname} replied to “${thread.title}”`, url: `/threads/${thread.id}/${thread.slug}` });
      if (replyTo && replyTo.authorId !== user.id && replyTo.authorId !== thread.authorId) await manager.getRepository(Notification).save({ userId: replyTo.authorId, type: 'quote', title: 'Someone quoted your post', body: `${user.nickname} quoted your post in “${thread.title}”`, url: `/threads/${thread.id}/${thread.slug}#post-${post.id}` });
      return post;
    });
  }

  async editPost(actor: PublicUser, id: number, content: string) {
    actor = await this.currentUser(actor);
    await this.rateLimits.assertAllowed('post.edit', { userId: actor.id }, 30, 60_000);
    this.validatePost('edit', content);
    const post = await this.posts.findOneBy({ id });
    if (!post || post.status !== 'visible') throw new NotFoundException('Post not found');
    const thread = await this.threads.findOne({ where: { id: post.threadId, status: 'visible' } });
    const board = thread ? await this.boards.findOneBy({ id: thread.boardId }) : null;
    BoardPolicy.assertThreadReadable(thread, board, actor.role);
    if (thread.isLocked && !['moderator', 'admin'].includes(actor.role)) throw new ForbiddenException('This thread is locked');
    if (post.authorId !== actor.id && !['moderator', 'admin'].includes(actor.role)) throw new ForbiddenException('You cannot edit this post');
    const normalizedContent = content.trim();
    await this.posts.update(id, { content: normalizedContent, renderedHtml: renderMarkdown(normalizedContent), renderVersion: MARKDOWN_RENDER_VERSION });
    return post.threadId;
  }

  async toggleBookmark(user: PublicUser, threadId: number) {
    user = await this.currentUser(user);
    const thread = await this.threads.findOne({ where: { id: threadId, status: 'visible' } });
    const board = thread ? await this.boards.findOneBy({ id: thread.boardId }) : null;
    BoardPolicy.assertThreadReadable(thread, board, user.role);
    const found = await this.bookmarks.findOneBy({ userId: user.id, threadId });
    if (found) { await this.bookmarks.delete(found.id); return false; }
    await this.bookmarks.save({ userId: user.id, threadId });
    return true;
  }

  async bookmarksFor(userId: number, userRole: PublicUser['role'] | 'guest' = 'guest') {
    const query = this.threads.createQueryBuilder('t').innerJoin(Bookmark, 'bookmark', 'bookmark.threadId = t.id AND bookmark.userId = :userId', { userId })
      .addSelect('bookmark.createdAt').addSelect('bookmark.id').where('t.status = :status', { status: 'visible' });
    BoardPolicy.applyReadableBoardScope(query, 't', userRole);
    const threads = await query.orderBy('bookmark.createdAt', 'DESC').addOrderBy('bookmark.id', 'DESC').take(100).getMany();
    return this.enrichThreads(threads, userRole);
  }

  async followUser(user: PublicUser, targetId: number) {
    user = await this.currentUser(user);
    if (user.id === targetId) throw new BadRequestException('You cannot follow yourself');
    if (!(await this.users.existsBy({ id: targetId, status: 'active' }))) throw new NotFoundException('User not found');
    const found = await this.follows.findOneBy({ userId: user.id, targetUserId: targetId });
    if (found) { await this.follows.delete(found.id); return false; }
    await this.follows.save({ userId: user.id, targetUserId: targetId });
    return true;
  }

  async profile(username: string, userRole: PublicUser['role'] | 'guest' = 'guest') {
    const user = await this.auth.findByUsername(username);
    if (!user) throw new NotFoundException('User not found');
    const threadQuery = this.threads.createQueryBuilder('t').where('t.authorId = :authorId AND t.status = :status', { authorId: user.id, status: 'visible' });
    BoardPolicy.applyReadableBoardScope(threadQuery, 't', userRole);
    const recent = await threadQuery.orderBy('t.createdAt', 'DESC').take(10).getMany();
    const postQuery = this.posts.createQueryBuilder('p').innerJoin(Thread, 't', 't.id = p.threadId AND t.status = :threadStatus', { threadStatus: 'visible' })
      .where('p.authorId = :authorId AND p.status = :postStatus', { authorId: user.id, postStatus: 'visible' });
    BoardPolicy.applyReadableBoardScope(postQuery, 't', userRole);
    const visiblePostCount = await postQuery.clone().getCount();
    const posts = await postQuery.orderBy('p.createdAt', 'DESC').take(10).getMany();
    const [following, followers, followingCount, followerCount] = await Promise.all([
      this.follows.createQueryBuilder('f').innerJoin(User, 'u', 'u.id = f.targetUserId AND u.status = :active', { active: 'active' }).where('f.userId = :id', { id: user.id }).orderBy('f.createdAt', 'DESC').take(50).getMany(),
      this.follows.createQueryBuilder('f').innerJoin(User, 'u', 'u.id = f.userId AND u.status = :active', { active: 'active' }).where('f.targetUserId = :id', { id: user.id }).orderBy('f.createdAt', 'DESC').take(50).getMany(),
      this.follows.count({ where: { userId: user.id } }), this.follows.count({ where: { targetUserId: user.id } }),
    ]);
    const listUsers = async (rows: Follow[], column: 'userId' | 'targetUserId') => {
      const ids = rows.map((row) => row[column]);
      const found = ids.length ? await this.users.find({ where: { id: In(ids), status: 'active' } }) : [];
      const byId = new Map(found.map((item) => [item.id, this.auth.publicUser(item)]));
      return ids.map((id) => byId.get(id)).filter(Boolean);
    };
    return { user: { ...user, postCount: visiblePostCount }, threads: await this.enrichThreads(recent, userRole), posts, following: await listUsers(following, 'targetUserId'), followers: await listUsers(followers, 'userId'), followingCount, followerCount };
  }

  async search(query: string, userRole: BoardRole = 'guest', page = 1) { return this.searchService.search(query, userRole, page); }
  async validateTerminalIdentity(userId: number, sessionVersion: number) { return this.auth.validateSession(userId, sessionVersion); }
  async enforceTerminalRateLimit(action: string, userId: number | undefined, ip: string, limit: number, windowMs: number) { return this.rateLimits.assertAllowed(action, { userId, ip }, limit, windowMs); }

  async createReport(user: PublicUser, targetType: string, targetId: number, reason: string) { user = await this.currentUser(user); await this.rateLimits.assertAllowed('report.create', { userId: user.id }, 8, 60 * 60_000); return this.moderation.createReport(user, targetType, targetId, reason); }

  async notificationsFor(userId: number) { return this.messaging.notificationsFor(userId); }
  async markNotificationsRead(userId: number) { return this.messaging.markNotificationsRead(userId); }
  async unreadCount(userId: number) { return this.messaging.unreadCount(userId); }
  async sendMessage(sender: PublicUser, toUsername: string, body: string) { sender = await this.currentUser(sender); await this.rateLimits.assertAllowed('message.create', { userId: sender.id }, 12, 10 * 60_000); return this.messaging.sendMessage(sender, toUsername, body); }
  async listConversations(userId: number) { return this.messaging.listConversations(userId); }
  async conversation(userId: number, conversationId: number) { return this.messaging.conversation(userId, conversationId); }
  async markConversationRead(userId: number, conversationId: number) { return this.messaging.markConversationRead(userId, conversationId); }
  async hideConversation(userId: number, conversationId: number) { return this.messaging.hideConversation(userId, conversationId); }

  async createDevice(user: PublicUser, input: Partial<Device>) { user = await this.currentUser(user); await this.rateLimits.assertAllowed('catalog.submit', { userId: user.id }, 8, 60 * 60_000); return this.catalog.createDevice(user, input); }
  async updateDevice(id: number, actor: PublicUser, input: Partial<Device>, ip = '') { return this.catalog.updateDevice(id, actor, input, ip); }

  async devicePage(slug: string, userRole: PublicUser['role'] | 'guest' = 'guest') {
    const device = await this.devices.findOneBy({ slug, status: 'active', reviewStatus: 'published' });
    if (!device) throw new NotFoundException('Device not found');
    const threadQuery = this.threads.createQueryBuilder('t').where('t.deviceId = :deviceId AND t.status = :status', { deviceId: device.id, status: 'visible' });
    BoardPolicy.applyReadableBoardScope(threadQuery, 't', userRole);
    const [threads, reports] = await Promise.all([threadQuery.orderBy('t.lastPostAt', 'DESC').take(30).getMany(), this.reportsCompat.find({ where: { deviceId: device.id, status: 'approved' }, order: { createdAt: 'DESC' }, take: 50 })]);
    const softwareIds = [...new Set(reports.map((report) => report.softwareId))];
    const relatedSoftware = softwareIds.length ? await this.software.find({ where: { id: In(softwareIds), status: 'published' } }) : [];
    return { device, threads: await this.enrichThreads(threads, userRole), reports, software: relatedSoftware };
  }

  async listDevices(page = 1, query = '', pageSize = 25) { return this.catalog.listDevices(page, query, pageSize); }

  async latest(page = 1, userRole: BoardRole = 'guest') {
    const safePage = Math.max(1, Math.min(10000, Math.trunc(page) || 1));
    const take = 20;
    const boardIds = (await this.listBoards(false, userRole)).map((board) => board.id);
    if (!boardIds.length) return { threads: [], page: safePage, pages: 1, count: 0 };
    const [threads, total] = await this.threads.findAndCount({ where: { status: 'visible', boardId: In(boardIds) }, order: { isPinned: 'DESC', lastPostAt: 'DESC', id: 'DESC' }, take, skip: (safePage - 1) * take });
    return { threads: await this.enrichThreads(threads, userRole), page: safePage, pages: Math.max(1, Math.ceil(total / take)), count: total };
  }

  async createSoftware(user: PublicUser, input: Partial<Software>) { user = await this.currentUser(user); await this.rateLimits.assertAllowed('catalog.submit', { userId: user.id }, 8, 60 * 60_000); return this.catalog.createSoftware(user, input); }
  async updateSoftware(id: number, actor: PublicUser, input: Partial<Software>, ip = '') { return this.catalog.updateSoftware(id, actor, input, ip); }

  async listSoftware(page = 1, query = '', pageSize = 25) { return this.catalog.listSoftware(page, query, pageSize); }

  async listTags(userRole: BoardRole = 'guest') {
    const minimumRole = { guest: 0, user: 1, moderator: 2, admin: 3 }[userRole];
    return this.tags.createQueryBuilder('tag').innerJoin(ThreadTag, 'tt', 'tt.tagId = tag.id')
      .innerJoin(Thread, 't', 't.id = tt.threadId AND t.status = :threadStatus', { threadStatus: 'visible' })
      .innerJoin(Board, 'b', 'b.id = t.boardId')
      .where('(b.isHidden = false OR :tagRole IN (\'moderator\', \'admin\')) AND (b.minimumRole IS NULL OR b.minimumRole <= :minimumRole)', { tagRole: userRole, minimumRole })
      .select('tag.id', 'id').addSelect('tag.name', 'name').addSelect('tag.slug', 'slug').addSelect('COUNT(DISTINCT t.id)', 'threadCount')
      .groupBy('tag.id').orderBy('threadCount', 'DESC').take(100).getRawMany();
  }

  async tagPage(slug: string, userRole: PublicUser['role'] | 'guest' = 'guest') {
    const tag = await this.tags.findOneBy({ slug });
    if (!tag) throw new NotFoundException('Tag not found');
    const query = this.threads.createQueryBuilder('t').innerJoin(ThreadTag, 'tt', 'tt.threadId = t.id AND tt.tagId = :tagId', { tagId: tag.id }).where('t.status = :status', { status: 'visible' });
    BoardPolicy.applyReadableBoardScope(query, 't', userRole);
    const threads = await query.orderBy('t.lastPostAt', 'DESC').take(100).getMany();
    if (!threads.length) throw new NotFoundException('Tag not found');
    return { tag, threads: await this.enrichThreads(threads, userRole) };
  }

  async softwarePage(slug: string, userRole: PublicUser['role'] | 'guest' = 'guest') {
    const software = await this.software.findOne({ where: { slug, status: 'published' } });
    if (!software) throw new NotFoundException('Software not found');
    const threadQuery = this.threads.createQueryBuilder('t').where('t.softwareId = :softwareId AND t.status = :status', { softwareId: software.id, status: 'visible' });
    BoardPolicy.applyReadableBoardScope(threadQuery, 't', userRole);
    const [reports, threads] = await Promise.all([this.reportsCompat.find({ where: { softwareId: software.id, status: 'approved' }, order: { createdAt: 'DESC' }, take: 50 }), threadQuery.orderBy('t.lastPostAt', 'DESC').take(30).getMany()]);
    const deviceIds = [...new Set(reports.map((report) => report.deviceId))];
    const devices = deviceIds.length ? await this.devices.find({ where: { id: In(deviceIds), status: 'active', reviewStatus: 'published' } }) : [];
    return { software, reports: reports.map((report) => ({ ...report, device: devices.find((device) => device.id === report.deviceId) })), threads: await this.enrichThreads(threads, userRole) };
  }

  async addCompatibilityReport(user: PublicUser, input: { deviceId: number; softwareId: number; systemVersion: string; result: CompatibilityReport['result']; notes?: string }) { user = await this.currentUser(user); await this.rateLimits.assertAllowed('compatibility.submit', { userId: user.id }, 30, 60 * 60_000); return this.catalog.addCompatibilityReport(user, input); }

  async createBoard(input: Partial<Board>, actor: PublicUser) { return this.moderation.createBoard(input, actor); }
  async updateBoard(id: number, actor: PublicUser, input: Partial<Board>) { return this.moderation.updateBoard(id, actor, input); }
  async moderationAction(actor: PublicUser, action: string, targetType: string, targetId: number, input: Record<string, unknown>, ip: string) { return this.moderation.moderationAction(actor, action, targetType, targetId, input, ip); }
  async updateUserRole(actor: PublicUser, targetId: number, role: User['role'], ip = '') { return this.moderation.updateUserRole(actor, targetId, role, ip); }
  async adminOverview(role: BoardRole = 'admin') { return this.moderation.adminOverview(role); }
  async adminReports(role: BoardRole = 'admin') { return this.moderation.adminReports(role); }
  async adminDevices() { return this.moderation.adminDevices(); }
  async adminSoftware() { return this.moderation.adminSoftware(); }
  async adminCompatibilityReports() { return this.moderation.adminCompatibilityReports(); }
  async auditLogs() { return this.moderation.auditLogs(); }
  async siteSettings() { return this.moderation.siteSettings(); }
  async updateSiteSettings(actor: PublicUser, input: { announcement: string; registrationEnabled: string }, ip: string) { return this.moderation.updateSiteSettings(actor, input, ip); }

  async terminalAccessKeys(userId: number) { return this.terminalAccounts.terminalAccessKeys(userId); }
  async createTerminalKey(user: PublicUser, name: string) { user = await this.currentUser(user); await this.rateLimits.assertAllowed('terminal-key.create', { userId: user.id }, 5, 24 * 60 * 60_000); return this.terminalAccounts.createTerminalKey(user, name); }
  async revokeTerminalKey(userId: number, keyId: number) { return this.terminalAccounts.revokeTerminalKey(userId, keyId); }
  async authenticateTerminalKey(raw: string, ip: string) { return this.terminalAccounts.authenticateTerminalKey(raw, ip); }
  async addSshKey(user: PublicUser, name: string, publicKeyText: string) { return this.terminalAccounts.addSshKey(user, name, publicKeyText); }
  async listSshKeys(userId: number) { return this.terminalAccounts.listSshKeys(userId); }
  async revokeSshKey(userId: number, keyId: number) { return this.terminalAccounts.revokeSshKey(userId, keyId); }
  async verifySshKey(username: string, key: Buffer, ip: string, signedData?: Buffer, signature?: Buffer, hashAlgo?: string) { return this.terminalAccounts.verifySshKey(username, key, ip, signedData, signature, hashAlgo); }
  async terminalLogin(username: string, secret: string, ip: string, allowPassword: boolean) { return this.terminalAccounts.terminalLogin(username, secret, ip, allowPassword); }

  async recentPosts(userId: number, limit = 20, userRole: BoardRole = 'guest') {
    const query = this.posts.createQueryBuilder('p').innerJoin(Thread, 't', 't.id = p.threadId AND t.status = :threadStatus', { threadStatus: 'visible' })
      .where('p.authorId = :userId AND p.status = :postStatus', { userId, postStatus: 'visible' });
    BoardPolicy.applyReadableBoardScope(query, 't', userRole);
    return query.orderBy('p.createdAt', 'DESC').addOrderBy('p.id', 'DESC').take(Math.max(1, Math.min(100, Math.trunc(limit) || 20))).getMany();
  }

  private validatePost(title: string, content: string) {
    if (!title.trim() || title.length > 180) throw new BadRequestException('Title must contain 1–180 characters');
    if (!content.trim() || content.length > 100_000) throw new BadRequestException('Post must contain 1–100000 characters');
  }

  private async enrichThreads(threads: Thread[], userRole: PublicUser['role'] | 'guest' = 'guest') {
    if (!threads.length) return [];
    const [users, boards] = await Promise.all([
      this.users.find({ where: { id: In([...new Set(threads.map((t) => t.authorId))]) } }),
      this.boards.find({ where: { id: In([...new Set(threads.map((t) => t.boardId))]) } }),
    ]);
    const userMap = new Map(users.map((u) => [u.id, this.auth.publicUser(u)]));
    const boardMap = new Map(boards.map((b) => [b.id, b]));
    const threadTagRows = await this.tagsFor(threads.map((thread) => thread.id));
    const levels: Record<string, number> = { guest: 0, user: 1, moderator: 2, admin: 3 };
    return threads.map((thread) => ({ ...thread, author: userMap.get(thread.authorId), board: boardMap.get(thread.boardId), tags: threadTagRows.filter((tag) => tag.threadId === thread.id) })).filter((thread: any) => thread.board && ((!thread.board.isHidden || ['moderator', 'admin'].includes(userRole)) && (thread.board.minimumRole === null || levels[userRole] >= thread.board.minimumRole)));
  }

  private async currentUser(user: PublicUser): Promise<PublicUser> {
    const current = await this.users.findOneBy({ id: user.id });
    if (!current || current.status !== 'active') throw new ForbiddenException('This account is not active');
    return this.auth.publicUser(current);
  }

  private async ensureRendered(posts: Post[], userRole: BoardRole) {
    const shouldRender = ['moderator', 'admin'].includes(userRole);
    await Promise.all(posts.filter((post) => (post.status === 'visible' || shouldRender) && (post.renderVersion !== MARKDOWN_RENDER_VERSION || post.renderedHtml === null))
      .map(async (post) => {
        post.renderedHtml = renderMarkdown(post.content);
        post.renderVersion = MARKDOWN_RENDER_VERSION;
        await this.posts.update(post.id, { renderedHtml: post.renderedHtml, renderVersion: post.renderVersion });
      }));
  }

  private async tagsFor(threadIds: number[]) {
    if (!threadIds.length) return [];
    return this.threadTags.createQueryBuilder('tt').innerJoin(Tag, 'tag', 'tag.id = tt.tagId').select('tt.threadId', 'threadId').addSelect('tag.id', 'id').addSelect('tag.name', 'name').addSelect('tag.slug', 'slug').where('tt.threadId IN (:...threadIds)', { threadIds }).getRawMany<{ threadId: number; id: number; name: string; slug: string }>();
  }


}
