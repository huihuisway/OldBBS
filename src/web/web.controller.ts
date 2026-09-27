import { Body, Controller, ForbiddenException, Get, Param, ParseIntPipe, Post, Query, Req, Res, StreamableFile, UploadedFile, UseInterceptors } from '@nestjs/common';
import { Request, Response } from 'express';
import { createReadStream } from 'node:fs';
import { mkdirSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { FileInterceptor } from '@nestjs/platform-express';
import { diskStorage } from 'multer';
import { AuthService, PublicUser } from '../auth/auth.service';
import { CommunityService } from '../community/community.service';
import { config } from '../config';
import { safeLocalNext } from '../common/redirect';
import { assertCsrfToken } from '../common/csrf';
import { StorageService } from '../storage/storage.service';

type WebRequest = Request & { session: any; user?: PublicUser };

@Controller()
export class WebController {
  constructor(private readonly auth: AuthService, private readonly community: CommunityService, private readonly storage: StorageService) {}

  @Get('/') async home(@Req() req: WebRequest, @Res() res: Response) { return res.render('home/index.njk', await this.community.home(req.session?.user?.role || 'guest')); }
  @Get('/boards') async boards(@Req() req: WebRequest, @Res() res: Response) { return res.render('boards/index.njk', { boards: await this.community.listBoards(false, req.session?.user?.role || 'guest') }); }
  @Get('/boards/:slug') async board(@Param('slug') slug: string, @Query('page') page: string, @Req() req: WebRequest, @Res() res: Response) { return res.render('boards/show.njk', await this.community.listBoardThreads(slug, this.page(page), req.session?.user?.role || 'guest')); }

  @Get('/threads/new') async newThread(@Query('board') boardId: string, @Req() req: WebRequest, @Res() res: Response) {
    const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']);
    return res.render('threads/new.njk', { boards: await this.community.listBoards(false, user.role), devices: (await this.community.listDevices(1, '', 100)).data, software: (await this.community.listSoftware(1, '', 100)).data, selectedBoard: Number(boardId) || null });
  }
  @Post('/threads') async createThread(@Body() body: any, @Req() req: WebRequest, @Res() res: Response) {
    this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']);
    const tags = String(body.tags || '').split(',').map((tag: string) => tag.trim()).filter(Boolean);
    const thread = await this.community.createThread(req.session.user, Number(body.boardId), String(body.title || ''), String(body.content || ''), body.deviceId ? Number(body.deviceId) : undefined, body.softwareId ? Number(body.softwareId) : undefined, tags);
    return res.redirect(303, `/threads/${thread.id}/${thread.slug}`);
  }
  @Get(['/threads/:id/:slug', '/threads/:id']) async thread(@Param('id', ParseIntPipe) id: number, @Query('page') page: string, @Query('quote') quote: string, @Req() req: WebRequest, @Res() res: Response) { const role = req.session?.user?.role || 'guest'; const quoteId = /^\d+$/.test(quote || '') ? Number(quote) : undefined; return res.render('threads/show.njk', { ...await this.community.threadPage(id, this.page(page), role, quoteId), boards: await this.community.listBoards(false, role), canModerate: ['moderator', 'admin'].includes(role) }); }
  @Post('/threads/:id/replies') async reply(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Req() req: WebRequest, @Res() res: Response) {
    this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']);
    const post = await this.community.createPost(req.session.user, id, String(body.content || ''), body.replyToPostId ? Number(body.replyToPostId) : undefined);
    return res.redirect(303, `/threads/${id}/thread#post-${post.id}`);
  }
  @Post('/posts/:id/edit') async editPost(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Req() req: WebRequest, @Res() res: Response) {
    this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']);
    const threadId = await this.community.editPost(req.session.user, id, String(body.content || ''));
    return res.redirect(303, `/threads/${threadId}/thread#post-${id}`);
  }
  @Post('/threads/:id/bookmark') async bookmark(@Param('id', ParseIntPipe) id: number, @Req() req: WebRequest, @Res() res: Response) {
    this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']);
    await this.community.toggleBookmark(req.session.user, id);
    return res.redirect(303, safeLocalNext(req.get('referer') || `/threads/${id}/thread`));
  }

  @Get('/latest') async latest(@Query('page') page: string, @Req() req: WebRequest, @Res() res: Response) { return res.render('threads/latest.njk', await this.community.latest(this.page(page), req.session?.user?.role || 'guest')); }
  @Get('/search') async search(@Query('q') query: string, @Query('page') page: string, @Req() req: WebRequest, @Res() res: Response) { return res.render('search/results.njk', { ...(await this.community.search(query || '', req.session?.user?.role || 'guest', this.page(page))), queryParam: encodeURIComponent(query || '') }); }
  @Get('/tags') async tags(@Req() req: WebRequest, @Res() res: Response) { return res.render('tags/index.njk', { tags: await this.community.listTags(req.session?.user?.role || 'guest') }); }
  @Get('/tags/:slug') async tagPage(@Param('slug') slug: string, @Req() req: WebRequest, @Res() res: Response) { return res.render('tags/show.njk', await this.community.tagPage(slug, req.session?.user?.role || 'guest')); }

  @Get('/register') async registerPage(@Res() res: Response) { return res.render('auth/register.njk', { registrationEnabled: await this.auth.registrationOpen() }); }
  @Post('/register') async register(@Body() body: any, @Req() req: WebRequest, @Res() res: Response) {
    const user = await this.auth.register({ username: String(body.username || ''), nickname: String(body.nickname || ''), email: String(body.email || ''), password: String(body.password || '') }, req.ip || 'unknown');
    await this.startSession(req, user);
    return res.redirect(303, '/');
  }
  @Get('/login') loginPage(@Query('next') next: string, @Res() res: Response) { return res.render('auth/login.njk', { next: safeLocalNext(next) }); }
  @Post('/login') async login(@Body() body: any, @Req() req: WebRequest, @Res() res: Response) {
    const user = await this.auth.authenticate(String(body.identity || ''), String(body.password || ''), req.ip || 'unknown');
    await this.startSession(req, user);
    return res.redirect(303, safeLocalNext(body.next));
  }
  @Post('/logout') async logout(@Req() req: WebRequest, @Res() res: Response) { await new Promise<void>((resolve, reject) => req.session.destroy((e: unknown) => e ? reject(e) : resolve())); res.clearCookie('oldbbs.sid'); return res.redirect(303, '/'); }

  @Get('/users/:username') async profile(@Param('username') username: string, @Req() req: WebRequest, @Res() res: Response) { return res.render('users/show.njk', await this.community.profile(username, req.session?.user?.role || 'guest')); }
  @Post('/users/:id/follow') async follow(@Param('id', ParseIntPipe) id: number, @Req() req: WebRequest, @Res() res: Response) { this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); await this.community.followUser(req.session.user, id); return res.redirect(303, safeLocalNext(req.get('referer') || '/')); }
  @Get('/settings') settings(@Req() req: WebRequest, @Res() res: Response) { this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); return res.render('users/settings.njk'); }
  @Post('/settings') async saveSettings(@Body() body: any, @Req() req: WebRequest, @Res() res: Response) {
    const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']);
    this.assertSecure(req);
    await this.auth.updateProfile(user.id, { nickname: String(body.nickname || ''), signature: String(body.signature || ''), theme: String(body.theme || 'classic'), lowBandwidth: body.lowBandwidth === 'on' });
    req.session.user = await this.auth.findById(user.id);
    return res.redirect(303, '/settings');
  }
  @Post('/settings/password') async changePassword(@Body() body: any, @Req() req: WebRequest, @Res() res: Response) {
    const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); this.assertSecure(req);
    await this.auth.changePassword(user.id, String(body.currentPassword || ''), String(body.password || ''));
    await new Promise<void>((resolve, reject) => req.session.destroy((error: unknown) => error ? reject(error) : resolve()));
    res.clearCookie('oldbbs.sid');
    return res.redirect(303, '/login');
  }

  @Get('/terminal-keys') async terminalKeyPage(@Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); this.assertSecure(req); return res.render('users/terminal-keys.njk', { keys: await this.community.terminalAccessKeys(user.id) }); }
  @Post('/terminal-keys') async createTerminalKey(@Body() body: any, @Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); this.assertSecure(req); const key = await this.community.createTerminalKey(user, String(body.name || '')); return res.render('users/terminal-key-created.njk', { key }); }
  @Post('/terminal-keys/:id/revoke') async revokeTerminalKey(@Param('id', ParseIntPipe) id: number, @Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); this.assertSecure(req); await this.community.revokeTerminalKey(user.id, id); return res.redirect(303, '/terminal-keys'); }
  @Get('/ssh-keys') async sshKeysPage(@Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); this.assertSecure(req); return res.render('users/ssh-keys.njk', { keys: await this.community.listSshKeys(user.id) }); }
  @Post('/ssh-keys') async addSshKey(@Body() body: any, @Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); this.assertSecure(req); await this.community.addSshKey(user, String(body.name || ''), String(body.publicKey || '')); return res.redirect(303, '/ssh-keys'); }
  @Post('/ssh-keys/:id/revoke') async revokeSshKey(@Param('id', ParseIntPipe) id: number, @Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); this.assertSecure(req); await this.community.revokeSshKey(user.id, id); return res.redirect(303, '/ssh-keys'); }

  @Get('/bookmarks') async bookmarks(@Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); return res.render('threads/latest.njk', { title: 'Bookmarks', threads: await this.community.bookmarksFor(user.id, user.role) }); }
  @Post('/reports') async report(@Body() body: any, @Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); await this.community.createReport(user, String(body.targetType || ''), Number(body.targetId), String(body.reason || '')); return res.redirect(303, safeLocalNext(req.get('referer') || '/')); }

  @Get('/attachments/new') attachmentForm(@Req() req: WebRequest, @Res() res: Response) { this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); return res.render('attachments/new.njk'); }
  @Post('/attachments') @UseInterceptors(FileInterceptor('file', { storage: diskStorage({ destination: (_req, _file, callback) => { const path = join(config.uploadDir, '.incoming'); mkdirSync(path, { recursive: true, mode: 0o700 }); callback(null, path); }, filename: (_req, _file, callback) => callback(null, `${randomUUID()}.upload`) }), limits: { fileSize: 8 * 1024 * 1024 } }))
  async uploadAttachment(@UploadedFile() file: Express.Multer.File | undefined, @Body() body: any, @Req() req: WebRequest, @Res() res: Response) {
    assertCsrfToken(req.session?.csrfToken, body?._csrf, req.headers['x-csrf-token']);
    const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']);
    const attachment = await this.storage.saveUpload(user, file as Express.Multer.File, body.threadId ? Number(body.threadId) : undefined);
    return res.render('attachments/created.njk', { attachment });
  }
  @Post('/attachments/:id/delete') async deleteAttachment(@Param('id', ParseIntPipe) id: number, @Req() req: WebRequest, @Res() res: Response) {
    const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']);
    await this.storage.deleteAttachment(user, id);
    return res.redirect(303, '/attachments/new');
  }
  @Get('/attachments/:id') async downloadAttachment(@Param('id', ParseIntPipe) id: number, @Req() req: WebRequest, @Res({ passthrough: true }) res: Response) {
    const { item, path } = await this.storage.getDownload(id, req.session?.user);
    res.setHeader('Content-Disposition', `attachment; filename="download"; filename*=UTF-8''${encodeURIComponent(item.originalName)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Cache-Control', 'private, no-store');
    return new StreamableFile(createReadStream(path), { type: 'application/octet-stream', disposition: `attachment; filename="download"`, length: item.fileSize });
  }

  @Get('/notifications') async notifications(@Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); const items = await this.community.notificationsFor(user.id); return res.render('users/notifications.njk', { items }); }
  @Post('/notifications/read') async markNotificationsRead(@Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); await this.community.markNotificationsRead(user.id); return res.redirect(303, '/notifications'); }
  @Get('/messages') async messages(@Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); return res.render('messages/index.njk', { conversations: await this.community.listConversations(user.id) }); }
  @Get('/messages/:id') async conversation(@Param('id', ParseIntPipe) id: number, @Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); return res.render('messages/show.njk', await this.community.conversation(user.id, id)); }
  @Post('/messages/:id/read') async markConversationRead(@Param('id', ParseIntPipe) id: number, @Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); await this.community.markConversationRead(user.id, id); return res.redirect(303, `/messages/${id}`); }
  @Post('/messages') async sendMessage(@Body() body: any, @Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); const id = await this.community.sendMessage(user, String(body.to || ''), String(body.body || '')); return res.redirect(303, `/messages/${id}`); }
  @Post('/messages/:id/hide') async hideConversation(@Param('id', ParseIntPipe) id: number, @Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); await this.community.hideConversation(user.id, id); return res.redirect(303, '/messages'); }

  @Get('/devices') async devices(@Query('page') page: string, @Query('q') query: string, @Res() res: Response) { const q = (query || '').slice(0, 80); return res.render('devices/index.njk', { ...(await this.community.listDevices(this.page(page), q)), query: q, queryParam: encodeURIComponent(q) }); }
  @Get('/devices/new') deviceForm(@Req() req: WebRequest, @Res() res: Response) { this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); return res.render('devices/new.njk'); }
  @Post('/devices') async createDevice(@Body() body: any, @Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); const device = await this.community.createDevice(user, body); if (device.reviewStatus !== 'published') return res.status(202).render('devices/submitted.njk', { kind: 'device' }); return res.redirect(303, `/devices/${device.slug}`); }
  @Get('/devices/:slug') async device(@Param('slug') slug: string, @Req() req: WebRequest, @Res() res: Response) { return res.render('devices/show.njk', await this.community.devicePage(slug, req.session?.user?.role || 'guest')); }
  @Get('/compatibility-reports/new') async compatibilityForm(@Query('deviceId') deviceId: string, @Query('softwareId') softwareId: string, @Req() req: WebRequest, @Res() res: Response) { this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); return res.render('devices/compatibility-report.njk', { devices: (await this.community.listDevices(1, '', 100)).data, software: (await this.community.listSoftware(1, '', 100)).data, selectedDevice: Number(deviceId), selectedSoftware: Number(softwareId) }); }
  @Get('/software') async software(@Query('page') page: string, @Query('q') query: string, @Res() res: Response) { const q = (query || '').slice(0, 80); return res.render('software/index.njk', { ...(await this.community.listSoftware(this.page(page), q)), query: q, queryParam: encodeURIComponent(q) }); }
  @Get('/software/new') softwareForm(@Req() req: WebRequest, @Res() res: Response) { this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); return res.render('software/new.njk'); }
  @Post('/software') async createSoftware(@Body() body: any, @Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); const item = await this.community.createSoftware(user, body); if (item.status !== 'published') return res.status(202).render('devices/submitted.njk', { kind: 'software' }); return res.redirect(303, `/software/${item.slug}`); }
  @Get('/software/:slug') async softwarePage(@Param('slug') slug: string, @Req() req: WebRequest, @Res() res: Response) { return res.render('software/show.njk', await this.community.softwarePage(slug, req.session?.user?.role || 'guest')); }
  @Post('/compatibility-reports') async compatibilityReport(@Body() body: any, @Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['user', 'moderator', 'admin']); await this.community.addCompatibilityReport(user, { deviceId: Number(body.deviceId), softwareId: Number(body.softwareId), systemVersion: String(body.systemVersion || ''), result: body.result, notes: String(body.notes || '') }); return res.redirect(303, safeLocalNext(req.get('referer') || '/devices')); }

  @Get('/admin') async admin(@Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['admin', 'moderator']); return res.render('admin/index.njk', await this.community.adminOverview(user.role)); }
  @Get('/admin/boards') async adminBoards(@Req() req: WebRequest, @Res() res: Response) { this.auth.assertRole(req.session.user, ['admin']); return res.render('admin/boards.njk', { boards: await this.community.listBoards(true, 'admin') }); }
  @Get('/admin/users') async adminUsers(@Query('q') query: string, @Req() req: WebRequest, @Res() res: Response) { this.auth.assertRole(req.session.user, ['admin']); return res.render('admin/users.njk', { query: query || '', users: await this.auth.listUsers(query || '') }); }
  @Post('/admin/users/:id/role') async updateAdminUserRole(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Req() req: WebRequest, @Res() res: Response) { const actor = this.auth.assertRole(req.session.user, ['admin']); await this.community.updateUserRole(actor, id, String(body.role) as any, req.ip || ''); return res.redirect(303, `/admin/users?q=${encodeURIComponent(String(body.q || ''))}`); }
  @Get('/admin/reports') async adminReports(@Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['admin', 'moderator']); return res.render('admin/reports.njk', { reports: await this.community.adminReports(user.role) }); }
  @Get('/admin/devices') async adminDevices(@Req() req: WebRequest, @Res() res: Response) { this.auth.assertRole(req.session.user, ['admin']); return res.render('admin/devices.njk', { devices: await this.community.adminDevices() }); }
  @Post('/admin/devices/:id') async updateAdminDevice(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['admin']); const device = await this.community.updateDevice(id, user, body, req.ip || ''); return res.redirect(303, `/admin/devices#device-${device.id}`); }
  @Get('/admin/software') async adminSoftware(@Req() req: WebRequest, @Res() res: Response) { this.auth.assertRole(req.session.user, ['admin']); return res.render('admin/software.njk', { software: await this.community.adminSoftware() }); }
  @Post('/admin/software/:id') async updateAdminSoftware(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['admin']); const item = await this.community.updateSoftware(id, user, body, req.ip || ''); return res.redirect(303, `/admin/software#software-${item.id}`); }
  @Get('/admin/compatibility') async adminCompatibility(@Req() req: WebRequest, @Res() res: Response) { this.auth.assertRole(req.session.user, ['admin', 'moderator']); return res.render('admin/compatibility.njk', { reports: await this.community.adminCompatibilityReports() }); }
  @Get('/admin/audit') async adminAudit(@Req() req: WebRequest, @Res() res: Response) { this.auth.assertRole(req.session.user, ['admin']); return res.render('admin/audit.njk', { logs: await this.community.auditLogs() }); }
  @Get('/admin/settings') async adminSettings(@Req() req: WebRequest, @Res() res: Response) { this.auth.assertRole(req.session.user, ['admin']); return res.render('admin/settings.njk', await this.community.siteSettings()); }
  @Post('/admin/settings') async saveAdminSettings(@Body() body: any, @Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['admin']); await this.community.updateSiteSettings(user, { announcement: String(body.announcement || ''), registrationEnabled: String(body.registrationEnabled || 'environment') }, req.ip || ''); return res.redirect(303, '/admin/settings'); }
  @Post('/admin/boards') async adminCreateBoard(@Body() body: any, @Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['admin']); await this.community.createBoard(body, user); return res.redirect(303, '/admin/boards'); }
  @Post('/admin/boards/:id') async adminUpdateBoard(@Param('id', ParseIntPipe) id: number, @Body() body: any, @Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['admin']); await this.community.updateBoard(id, user, { ...body, isHidden: body.isHidden === 'on', isReadOnly: body.isReadOnly === 'on' }); return res.redirect(303, '/admin/boards'); }
  @Post('/admin/moderate/:targetType/:targetId/:action') async moderate(@Param('targetType') targetType: string, @Param('targetId', ParseIntPipe) targetId: number, @Param('action') action: string, @Body() body: any, @Req() req: WebRequest, @Res() res: Response) { const user = this.auth.assertRole(req.session.user, ['admin', 'moderator']); await this.community.moderationAction(user, action, targetType, targetId, body, req.ip || ''); return res.redirect(303, safeLocalNext(req.get('referer') || '/admin')); }

  private page(raw: string | undefined): number { const value = Number(raw || 1); return Number.isInteger(value) && value > 0 ? Math.min(value, 10000) : 1; }
  private assertSecure(req: WebRequest) { if (!req.secure && !(config.nodeEnv !== 'production' && ['127.0.0.1', '::1'].includes(req.ip || ''))) throw new ForbiddenException('Secure HTTPS is required for account security settings'); }
  private async startSession(req: WebRequest, user: PublicUser) { await new Promise<void>((resolve, reject) => req.session.regenerate((error: unknown) => error ? reject(error) : resolve())); req.session.user = user; req.session.authVersion = await this.auth.sessionVersionFor(user.id); req.session.csrfToken = require('node:crypto').randomBytes(24).toString('hex'); await new Promise<void>((resolve, reject) => req.session.save((error: unknown) => error ? reject(error) : resolve())); }
}
