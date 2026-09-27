import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource, InjectRepository } from '@nestjs/typeorm';
import { DataSource, MoreThan, Repository } from 'typeorm';
import { AuthService, PublicUser } from '../auth/auth.service';
import { slugify } from '../common/content';
import { BoardPolicy, BoardRole, wouldCreateBoardCycle } from './board-policy';
import { ModerationPolicy } from './moderation-policy';
import { AuditLog, Board, CompatibilityReport, Device, Notification, Post, Report, SiteSetting, Software, Thread, User } from '../database/entities';

@Injectable()
export class ModerationService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly auth: AuthService,
    @InjectRepository(Board) private readonly boards: Repository<Board>,
    @InjectRepository(Thread) private readonly threads: Repository<Thread>,
    @InjectRepository(Post) private readonly posts: Repository<Post>,
    @InjectRepository(User) private readonly users: Repository<User>,
    @InjectRepository(Device) private readonly devices: Repository<Device>,
    @InjectRepository(Software) private readonly software: Repository<Software>,
    @InjectRepository(CompatibilityReport) private readonly reportsCompat: Repository<CompatibilityReport>,
    @InjectRepository(Notification) private readonly notifications: Repository<Notification>,
    @InjectRepository(Report) private readonly reports: Repository<Report>,
    @InjectRepository(AuditLog) private readonly audit: Repository<AuditLog>,
    @InjectRepository(SiteSetting) private readonly settings: Repository<SiteSetting>,
  ) {}

  async createReport(user: PublicUser, targetType: string, targetId: number, reason: string) {
    user = await this.currentUser(user);
    if (!['post', 'thread', 'user', 'software', 'device'].includes(targetType)) throw new BadRequestException('Unsupported report type');
    if (!Number.isSafeInteger(targetId) || targetId < 1) throw new BadRequestException('Report target is invalid');
    if (!reason.trim() || reason.length > 2000) throw new BadRequestException('Please provide a reason (up to 2000 characters)');
    return this.reports.save({ reporterId: user.id, targetType, targetId, reason: reason.trim(), status: 'open', handledById: null });
  }

  async createBoard(input: Partial<Board>, actor: PublicUser) {
    actor = await this.currentUser(actor);
    if (actor.role !== 'admin') throw new ForbiddenException('Administrator role is required');
    if (!input.name?.trim()) throw new BadRequestException('Board name is required');
    const slug = slugify(input.slug || input.name);
    const parentId = input.parentId ? Number(input.parentId) : null;
    if (parentId !== null && (!Number.isSafeInteger(parentId) || !(await this.boards.existsBy({ id: parentId })))) throw new BadRequestException('Parent board does not exist');
    const minimumRole = this.boardMinimumRole(input.minimumRole);
    const board = await this.boards.save(this.boards.create({ name: input.name.trim().slice(0, 120), slug, description: (input.description || '').slice(0, 2000), parentId, sortOrder: Number(input.sortOrder) || 0, theme: 'classic', icon: null, isHidden: false, isReadOnly: false, minimumRole }));
    await this.log(actor, 'board.create', 'board', board.id, {});
    return board;
  }

  async updateBoard(id: number, actor: PublicUser, input: Partial<Board>) {
    actor = await this.currentUser(actor);
    if (actor.role !== 'admin') throw new ForbiddenException('Administrator role is required');
    const board = await this.boards.findOneBy({ id });
    if (!board) throw new NotFoundException('Board not found');
    const parentId = input.parentId === undefined ? board.parentId : (input.parentId ? Number(input.parentId) : null);
    if (parentId !== null && (!Number.isSafeInteger(parentId) || !(await this.boards.existsBy({ id: parentId })))) throw new BadRequestException('Parent board does not exist');
    const minimumRole = input.minimumRole === undefined ? board.minimumRole : this.boardMinimumRole(input.minimumRole);
    await this.db.transaction(async (manager) => {
      const rows = await manager.query('SELECT id, parentId FROM boards FOR UPDATE') as Array<{ id: number; parentId: number | null }>;
      if (wouldCreateBoardCycle(id, parentId, rows)) throw new BadRequestException('This parent would create a board cycle');
      await manager.getRepository(Board).update(id, { name: input.name?.trim().slice(0, 120) || board.name, description: input.description?.slice(0, 2000) ?? board.description, parentId, sortOrder: input.sortOrder === undefined ? board.sortOrder : Number(input.sortOrder), isHidden: input.isHidden === undefined ? board.isHidden : Boolean(input.isHidden), isReadOnly: input.isReadOnly === undefined ? board.isReadOnly : Boolean(input.isReadOnly), minimumRole });
    });
    await this.log(actor, 'board.update', 'board', id, input as Record<string, unknown>);
  }

  async moderationAction(actor: PublicUser, action: string, targetType: string, targetId: number, input: Record<string, unknown>, ip: string) {
    actor = await this.currentUser(actor);
    ModerationPolicy.assertModerator(actor);
    let metadata: Record<string, unknown> = {};
    if (targetType === 'post' && ['delete', 'restore'].includes(action)) {
      const post = await this.posts.findOneBy({ id: targetId });
      if (!post) throw new NotFoundException('Post not found');
      const thread = await this.threads.findOneBy({ id: post.threadId });
      const board = thread ? await this.boards.findOneBy({ id: thread.boardId }) : null;
      ModerationPolicy.assertCanModeratePost(actor, post, thread, board);
      const nextStatus = action === 'delete' ? 'deleted' : 'visible';
      if (post.status !== nextStatus) await this.db.transaction(async (manager) => {
        const thread = await manager.getRepository(Thread).createQueryBuilder('t').setLock('pessimistic_write').where('t.id = :threadId', { threadId: post.threadId }).getOne();
        if (!thread) throw new NotFoundException('Thread not found');
        const lockedPost = await manager.getRepository(Post).createQueryBuilder('p').setLock('pessimistic_write').where('p.id = :postId', { postId: targetId }).getOne();
        if (!lockedPost || lockedPost.status === nextStatus) return;
        const visibilityDelta = Number(nextStatus === 'visible') - Number(lockedPost.status === 'visible');
        await manager.getRepository(Post).update(targetId, { status: nextStatus, deletedAt: action === 'delete' ? new Date() : null });
        if (thread.status === 'visible' && lockedPost.floor > 1 && visibilityDelta !== 0) await manager.getRepository(Thread).update(thread.id, { replyCount: Math.max(0, thread.replyCount + visibilityDelta) });
        const lastVisiblePost = await manager.getRepository(Post).findOne({ where: { threadId: thread.id, status: 'visible' }, order: { createdAt: 'DESC', id: 'DESC' } });
        await manager.getRepository(Thread).update(thread.id, { lastPostId: lastVisiblePost?.id ?? null, lastPostAt: lastVisiblePost?.createdAt ?? null });
        if (thread.status === 'visible' && visibilityDelta !== 0) await manager.query('UPDATE users SET postCount = GREATEST(postCount + ?, 0) WHERE id = ?', [visibilityDelta, lockedPost.authorId]);
      });
      metadata = { postId: targetId, action };
    } else if (targetType === 'thread' && ['delete', 'restore', 'lock', 'unlock', 'pin', 'unpin', 'feature', 'unfeature', 'move'].includes(action)) {
      const thread = await this.threads.findOneBy({ id: targetId });
      if (!thread) throw new NotFoundException('Thread not found');
      const sourceBoard = await this.boards.findOneBy({ id: thread.boardId });
      ModerationPolicy.assertCanModerateThread(actor, thread, sourceBoard);
      const patch: Partial<Thread> = {};
      if (action === 'delete' || action === 'restore') patch.status = action === 'delete' ? 'deleted' : 'visible';
      if (action === 'lock' || action === 'unlock') patch.isLocked = action === 'lock';
      if (action === 'pin' || action === 'unpin') patch.isPinned = action === 'pin';
      if (action === 'feature' || action === 'unfeature') patch.isFeatured = action === 'feature';
      if (action === 'move') {
        const boardId = Number(input.boardId);
        const targetBoard = boardId ? await this.boards.findOneBy({ id: boardId }) : null;
        ModerationPolicy.assertCanManageBoard(actor, targetBoard);
        patch.boardId = boardId;
      }
      if (patch.status && patch.status !== thread.status) {
        await this.db.transaction(async (manager) => {
          const repo = manager.getRepository(Thread);
          const locked = await repo.createQueryBuilder('t').setLock('pessimistic_write').where('t.id = :id', { id: targetId }).getOne();
          if (!locked || locked.status === patch.status) return;
          const enteringVisible = patch.status === 'visible';
          const counts = await manager.query("SELECT authorId, COUNT(*) AS total FROM posts WHERE threadId = ? AND status = 'visible' GROUP BY authorId", [targetId]) as Array<{ authorId: number; total: number | string }>;
          for (const row of counts) {
            const total = Number(row.total);
            await manager.query(`UPDATE users SET postCount = GREATEST(postCount ${enteringVisible ? '+' : '-'} ?, 0) WHERE id = ?`, [total, row.authorId]);
          }
          const next = { ...patch };
          if (enteringVisible) {
            const replyCount = await manager.getRepository(Post).count({ where: { threadId: targetId, status: 'visible', floor: MoreThan(1) } });
            const lastVisiblePost = await manager.getRepository(Post).findOne({ where: { threadId: targetId, status: 'visible' }, order: { createdAt: 'DESC', id: 'DESC' } });
            Object.assign(next, { replyCount, lastPostId: lastVisiblePost?.id ?? null, lastPostAt: lastVisiblePost?.createdAt ?? null });
          }
          await repo.update(targetId, next);
        });
      } else await this.threads.update(targetId, patch);
      metadata = patch;
    } else if (targetType === 'user' && ['ban', 'unban'].includes(action)) {
      const target = await this.users.findOneBy({ id: targetId });
      if (!target) throw new NotFoundException('User not found');
      ModerationPolicy.assertCanModerateUser(actor, target);
      const reason = String(input.reason || 'Violation of community rules').slice(0, 500);
      await this.db.transaction(async (manager) => {
        const locked = await manager.getRepository(User).createQueryBuilder('u').setLock('pessimistic_write').where('u.id = :id', { id: targetId }).getOne();
        if (!locked) throw new NotFoundException('User not found');
        ModerationPolicy.assertCanModerateUser(actor, locked);
        if (action === 'ban' && locked.role === 'admin' && locked.status === 'active') {
          const activeAdmins = await manager.query("SELECT id FROM users WHERE role = 'admin' AND status = 'active' FOR UPDATE") as Array<{ id: number }>;
          if (activeAdmins.length <= 1) throw new ForbiddenException('The last active administrator cannot be banned');
        }
        await manager.getRepository(User).createQueryBuilder().update(User).set({
          status: action === 'ban' ? 'banned' : 'active',
          banReason: action === 'ban' ? reason : null,
          sessionVersion: () => '`sessionVersion` + 1',
        }).where('id = :id', { id: targetId }).execute();
      });
      metadata = { reason: action === 'ban' ? reason : null };
    } else if (targetType === 'user' && action === 'force_logout') {
      if (actor.role !== 'admin') throw new ForbiddenException('Administrator role is required');
      await this.auth.forceLogout(targetId); metadata = { sessionVersionRevoked: true };
    } else if (targetType === 'user' && action === 'warn') {
      const target = await this.users.findOneBy({ id: targetId });
      if (!target) throw new NotFoundException('User not found');
      ModerationPolicy.assertCanModerateUser(actor, target);
      const reason = String(input.reason || '').trim().slice(0, 1000);
      if (!reason) throw new BadRequestException('Warning reason is required');
      await this.notifications.save({ userId: targetId, type: 'moderation', title: 'Community warning', body: reason, url: '/notifications', isRead: false });
      metadata = { reason };
    } else if (targetType === 'report' && ['resolve', 'dismiss'].includes(action)) {
      const report = await this.reports.findOneBy({ id: targetId });
      if (!report) throw new NotFoundException('Report not found');
      if (report.targetType === 'thread') {
        const thread = await this.threads.findOneBy({ id: report.targetId });
        const board = thread ? await this.boards.findOneBy({ id: thread.boardId }) : null;
        ModerationPolicy.assertCanModerateThread(actor, thread, board);
      } else if (report.targetType === 'post') {
        const post = await this.posts.findOneBy({ id: report.targetId });
        const thread = post ? await this.threads.findOneBy({ id: post.threadId }) : null;
        const board = thread ? await this.boards.findOneBy({ id: thread.boardId }) : null;
        ModerationPolicy.assertCanModeratePost(actor, post, thread, board);
      }
      await this.reports.update(targetId, { status: action === 'resolve' ? 'resolved' : 'dismissed', handledById: actor.id });
      metadata = { priorStatus: report.status };
    } else if (targetType === 'compatibility' && ['approve', 'reject', 'delete'].includes(action)) {
      const report = await this.reportsCompat.findOneBy({ id: targetId });
      if (!report) throw new NotFoundException('Compatibility report not found');
      const status = action === 'approve' ? 'approved' : action === 'reject' ? 'rejected' : 'deleted';
      await this.reportsCompat.update(targetId, { status });
      metadata = { status };
    } else if (targetType === 'software' && ['publish', 'reject'].includes(action)) {
      if (!(await this.software.existsBy({ id: targetId }))) throw new NotFoundException('Software not found');
      await this.software.update(targetId, { status: action === 'publish' ? 'published' : 'rejected' });
    } else if (targetType === 'device' && ['publish', 'reject', 'delete', 'restore'].includes(action)) {
      if (['delete', 'restore'].includes(action) && actor.role !== 'admin') throw new ForbiddenException('Administrator role is required');
      const device = await this.devices.findOneBy({ id: targetId });
      if (!device) throw new NotFoundException('Device not found');
      if (action === 'delete' || action === 'restore') {
        await this.devices.update(targetId, { status: action === 'delete' ? 'deleted' : 'active' });
        metadata = { status: action === 'delete' ? 'deleted' : 'active' };
      } else {
        const reviewStatus = action === 'publish' ? 'published' : 'rejected';
        await this.devices.update(targetId, { reviewStatus });
        metadata = { reviewStatus };
      }
    } else throw new BadRequestException('Unsupported moderation action');
    await this.log(actor, `${targetType}.${action}`, targetType, targetId, metadata, ip);
  }

  async adminOverview(role: BoardRole = 'admin') {
    if (role === 'admin') {
      const [users, threads, posts, pendingReports, reports] = await Promise.all([this.users.count(), this.threads.count(), this.posts.count(), this.reports.count({ where: { status: 'open' } }), this.reports.find({ where: { status: 'open' }, order: { createdAt: 'ASC' }, take: 100 })]);
      return { users, threads, posts, pendingReports, reports };
    }
    const threadQuery = this.threads.createQueryBuilder('t').where('t.status = :visible', { visible: 'visible' });
    BoardPolicy.applyReadableBoardScope(threadQuery, 't', role);
    const postQuery = this.posts.createQueryBuilder('p').innerJoin(Thread, 't', 't.id = p.threadId AND t.status = :threadStatus', { threadStatus: 'visible' })
      .where('p.status = :postStatus', { postStatus: 'visible' });
    BoardPolicy.applyReadableBoardScope(postQuery, 't', role);
    const scopedReports = await this.scopedReports(role);
    const [users, threads, posts, pendingReports, reports] = await Promise.all([
      this.users.count({ where: { status: 'active' } }), threadQuery.getCount(), postQuery.getCount(),
      scopedReports.clone().andWhere('r.status = :open', { open: 'open' }).getCount(),
      scopedReports.clone().andWhere('r.status = :open', { open: 'open' }).orderBy('r.createdAt', 'ASC').take(100).getMany(),
    ]);
    return { users, threads, posts, pendingReports, reports };
  }

  async updateUserRole(actor: PublicUser, targetId: number, role: User['role'], ip = '') {
    actor = await this.currentUser(actor);
    if (actor.role !== 'admin') throw new ForbiddenException('Administrator role is required');
    if (!['user', 'moderator', 'admin'].includes(role)) throw new BadRequestException('Role is invalid');
    let previousRole: User['role'] = 'user';
    await this.db.transaction(async (manager) => {
      const target = await manager.getRepository(User).createQueryBuilder('u').setLock('pessimistic_write').where('u.id = :targetId', { targetId }).getOne();
      if (!target) throw new NotFoundException('User not found');
      previousRole = target.role;
      if (target.role === 'admin' && role !== 'admin' && target.status === 'active') {
        const activeAdmins = await manager.query("SELECT id FROM users WHERE role = 'admin' AND status = 'active' FOR UPDATE") as Array<{ id: number }>;
        if (activeAdmins.length <= 1) throw new ForbiddenException('The last active administrator cannot be demoted');
      }
      await manager.getRepository(User).createQueryBuilder().update(User).set({ role, sessionVersion: () => '`sessionVersion` + 1' }).where('id = :targetId', { targetId }).execute();
    });
    await this.log(actor, 'user.role.update', 'user', targetId, { from: previousRole, to: role }, ip);
  }
  async adminReports(role: BoardRole = 'admin') { return (await this.scopedReports(role)).orderBy('r.status', 'ASC').addOrderBy('r.createdAt', 'ASC').take(300).getMany(); }
  async adminDevices() { return this.devices.find({ order: { updatedAt: 'DESC' }, take: 300 }); }
  async adminSoftware() { return this.software.find({ order: { status: 'ASC', updatedAt: 'DESC' }, take: 300 }); }
  async adminCompatibilityReports() { return this.reportsCompat.find({ order: { createdAt: 'DESC' }, take: 300 }); }
  async auditLogs() { return this.audit.find({ order: { createdAt: 'DESC' }, take: 300 }); }

  async siteSettings() {
    const rows = await this.settings.find();
    const values = new Map(rows.map((row) => [row.key, row.value]));
    return { announcement: values.get('site_announcement') || '', registrationEnabled: values.get('registration_enabled') || 'environment' };
  }

  async updateSiteSettings(actor: PublicUser, input: { announcement: string; registrationEnabled: string }, ip: string) {
    actor = await this.currentUser(actor);
    if (actor.role !== 'admin') throw new ForbiddenException('Administrator role is required');
    const values = [
      ['site_announcement', input.announcement.slice(0, 2000)],
      ['registration_enabled', input.registrationEnabled === 'true' ? 'true' : input.registrationEnabled === 'false' ? 'false' : 'environment'],
    ] as const;
    for (const [key, value] of values) await this.settings.save({ key, value, updatedById: actor.id });
    await this.log(actor, 'site.settings.update', 'site', null, { keys: values.map(([key]) => key) }, ip);
  }

  private async currentUser(user: PublicUser): Promise<PublicUser> {
    const current = await this.users.findOneBy({ id: user.id });
    if (!current || current.status !== 'active') throw new ForbiddenException('This account is not active');
    return this.auth.publicUser(current);
  }
  private boardMinimumRole(value: unknown): number | null {
    if (value === null || value === undefined || String(value) === '') return null;
    const role = Number(value);
    if (!Number.isInteger(role) || role < 0 || role > 3) throw new BadRequestException('Minimum role must be an integer from 0 to 3');
    return role;
  }
  private async scopedReports(role: BoardRole) {
    const query = this.reports.createQueryBuilder('r');
    if (role === 'admin') return query;
    const accessibleBoardIds = (await this.boards.find()).filter((board) => BoardPolicy.canReadBoard(board, role)).map((board) => board.id);
    if (!accessibleBoardIds.length) return query.andWhere("r.targetType NOT IN ('thread', 'post')");
    return query.andWhere(`(
      r.targetType NOT IN ('thread', 'post')
      OR (r.targetType = 'thread' AND r.targetId IN (SELECT rt.id FROM threads rt WHERE rt.boardId IN (:...accessibleBoardIds)))
      OR (r.targetType = 'post' AND r.targetId IN (SELECT rp.id FROM posts rp INNER JOIN threads rt ON rt.id = rp.threadId WHERE rt.boardId IN (:...accessibleBoardIds)))
    )`, { accessibleBoardIds });
  }
  private async log(actor: PublicUser, action: string, targetType: string, targetId: number | null, metadata: Record<string, unknown>, ip = '') {
    await this.audit.save({ actorId: actor.id, action, targetType, targetId, metadata, ip: ip.slice(0, 45) || null });
  }
}
