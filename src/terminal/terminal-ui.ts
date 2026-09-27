import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';
import iconv from 'iconv-lite';
import { HttpException } from '@nestjs/common';
import { PublicUser } from '../auth/auth.service';
import { CommunityService } from '../community/community.service';
import { config } from '../config';
import { centerColumns, wrapColumns } from './terminal-width';

export interface TerminalTransport {
  input: Readable;
  output: Writable;
  telnet?: boolean;
  remoteIp?: string;
  onLoginComplete?: () => void;
}

export class TerminalUi {
  private width = 80;
  private encoding: 'utf8' | 'gbk' = 'utf8';
  private ascii = false;
  private ansi = true;
  private user: PublicUser | null;
  private lastValidatedAt = 0;
  private closed = false;
  private decoder = iconv.getDecoder('utf8');
  private pendingLine = '';
  private pendingLength = 0;
  private lineWaiter?: { resolve: (value: string) => void; echo: boolean };
  private completedLines: string[] = [];
  private commandTimes: number[] = [];
  private expensiveCommandTimes: number[] = [];
  private telnetState = 0;
  private skipLineTerminatorSuffix = false;
  private lineOverflow = false;
  private static readonly maxLineLength = 4096;
  private static readonly maxQueuedLines = 32;
  private static readonly maxInputChunkBytes = 64 * 1024;

  constructor(private readonly io: TerminalTransport, private readonly community: CommunityService, authenticatedUser?: PublicUser) {
    this.user = authenticatedUser ?? null;
    io.input.on('data', (chunk: Buffer | string) => this.receive(chunk));
    io.input.on('close', () => this.closeInput());
    io.input.on('end', () => this.closeInput());
    io.output.on('close', () => this.closeInput());
    if (io.telnet) io.output.write(Buffer.from([255, 251, 1, 255, 253, 3])); // WILL ECHO, DO SUPPRESS-GO-AHEAD
    const channel = io.input as Readable & EventEmitter;
    channel.on('window-change', (info: { cols?: number }) => { if (info.cols && info.cols > 20) this.width = Math.min(info.cols, 240); });
  }

  setWidth(columns: number) { if (columns >= 20) this.width = Math.min(columns, 240); }

  async run() {
    try {
      this.write('\r\nOldBBS Terminal | OldBBS.CN\r\n');
      if (this.io.telnet) {
        this.write('Telnet connection is unencrypted. Never enter your OldBBS password.\r\n');
        this.write('Display [U]TF-8 / [G]BK-CP936 / [A]ASCII: ');
        const display = (await this.readLine()).trim().toLowerCase();
        this.setEncoding(display === 'g' ? 'gbk' : 'utf8');
        this.ascii = display === 'a';
        this.write('\r\nANSI sequences [Y/n]: ');
        this.ansi = (await this.readLine()).trim().toLowerCase() !== 'n';
        this.write('\r\nUsername (blank for anonymous): ');
        const username = (await this.readLine()).trim();
        if (username) {
          this.write('\r\nTerminal Access Key: ');
          const key = await this.readLine(false);
          const user = await this.community.terminalLogin(username, key, this.remoteIp(), false);
          if (!user) this.write('\r\nAccess key rejected. Master passwords are not accepted over Telnet; continuing as anonymous.\r\n');
          else this.user = user;
        }
        this.io.onLoginComplete?.();
      } else {
        this.write('Display [U]TF-8 / [G]BK-CP936 / [A]ASCII: ');
        const display = (await this.readLine()).trim().toLowerCase();
        this.setEncoding(display === 'g' ? 'gbk' : 'utf8');
        this.ascii = display === 'a';
        this.write('\r\nANSI sequences [Y/n]: ');
        this.ansi = (await this.readLine()).trim().toLowerCase() !== 'n';
      }
      this.write('\r\n');
      while (!this.closed) {
        try {
          if (!(await this.refreshIdentity())) break;
          await this.home();
          this.write('\r\nCommand (board number, N latest, S search, U profile, I inbox, M message, B bookmarks, Q quit): ');
          const command = (await this.readLine()).trim();
          if (command.toLowerCase() === 'q') break;
          if (!this.consumeCommandBudget(['n', 's', 'i', 'm', 'b'].includes(command.toLowerCase()))) {
            this.write('\r\n操作过于频繁，请稍后重试。\r\n');
            continue;
          }
          if (command.toLowerCase() === 'n') await this.latest();
          else if (command.toLowerCase() === 's') await this.search();
          else if (command.toLowerCase() === 'u') await this.profile();
          else if (command.toLowerCase() === 'i') await this.inbox();
          else if (command.toLowerCase() === 'm') await this.composeMessage();
          else if (command.toLowerCase() === 'b') await this.bookmarks();
          else if (/^\d+$/.test(command)) await this.board(Number(command));
        } catch (error) {
          this.write(`\r\n操作失败：${this.errorMessage(error)}\r\n`);
        }
      }
      this.write('\r\nDisconnected from OldBBS.\r\n');
    } catch { /* socket closed while waiting for a command */ }
    finally { this.closeInput(); }
  }

  private async home() {
    if (!(await this.refreshIdentity())) return;
    const home = await this.community.home(this.user?.role || 'guest');
    this.clear();
    this.write(this.rule());
    this.write(this.center('OLDBBS.CN'));
    this.write(this.center('Old devices and old software community'));
    this.write(this.rule());
    this.write(`Online in last 15 min: ${home.totals.online}  Today posts: ${home.totals.today}  Members: ${home.totals.users}\r\n\r\n`);
    const roots = home.boards.filter((board) => board.parentId === null);
    for (let i = 0; i < roots.length; i++) {
      const root = roots[i];
      this.write(this.menuLine(`${String(i + 1).padStart(2, ' ')}. ${root.name}`));
      for (const child of home.boards.filter((board) => board.parentId === root.id)) this.write(this.menuLine(`- ${child.name}`));
    }
    this.write('\r\nRecent threads:\r\n');
    for (const thread of home.threads.slice(0, 6)) this.write(this.menuLine(`${thread.title} (${thread.replyCount} replies)`));
  }

  private async board(index: number) {
    const all = await this.community.listBoards(false, this.user?.role || 'guest');
    const roots = all.filter((b) => b.parentId === null);
    const selected = roots[index - 1];
    if (!selected) return;
    const children = all.filter((b) => b.parentId === selected.id);
    if (children.length) {
      this.write(`\r\n${this.menuLine(selected.name)}`);
      children.forEach((b, i) => this.write(this.menuLine(`${i + 1}. ${b.name}`)));
      this.write('Choose board number, or B to return: ');
      const child = (await this.readLine()).trim();
      if (!/^\d+$/.test(child)) return;
      return this.showBoard(children[Number(child) - 1]?.slug);
    }
    return this.showBoard(selected.slug);
  }

  private async showBoard(slug?: string) {
    if (!slug) return;
    if (!(await this.refreshIdentity())) return;
    let page = 1;
    while (!this.closed) {
      const data = await this.community.listBoardThreads(slug, page, this.user?.role || 'guest');
      this.write(`\r\n${this.safeText(data.board.name)} — page ${page}/${data.pages}\r\n${this.rule()}`);
      data.threads.forEach((item: any, i: number) => this.write(this.menuLine(`${i + 1}. ${item.isPinned ? '[PIN] ' : ''}${item.title} — ${item.author?.nickname || 'unknown'} · ${item.replyCount} replies`)));
      this.write('\r\n[N] new thread [P] previous page [D] next page [B] back, or thread number: ');
      const choice = (await this.readLine()).trim().toLowerCase();
      if (choice === 'b') return;
      if (choice === 'p' && page > 1) { page--; continue; }
      if (choice === 'd' && page < data.pages) { page++; continue; }
      if (choice === 'n') { await this.newThread(data.board.id); continue; }
      if (/^\d+$/.test(choice)) { const target = data.threads[Number(choice) - 1]; if (target) await this.showThread(target.id); }
    }
  }

  private async showThread(id: number, page = 1): Promise<void> {
    if (!(await this.refreshIdentity())) return;
    const data = await this.community.threadPage(id, page, this.user?.role || 'guest');
    this.write(`\r\n${this.safeText(data.thread.title)}\r\n${this.rule()}`);
    for (const post of data.posts) {
      this.write(`#${post.floor} ${this.safeText(post.author?.nickname || 'unknown')} · ${post.createdAt.toISOString().slice(0, 16)}\r\n`);
      this.write(this.wrap(this.plain(post.content || '内容已隐藏。')) + '\r\n');
      this.write(this.rule());
    }
    this.write('[R] reply [Q] quote a floor [F] bookmark [P] previous page [D] next page [B] back: ');
    const choice = (await this.readLine()).trim().toLowerCase();
    if (choice === 'r') return this.reply(id);
    if (choice === 'f' && this.user) { const saved = await this.community.toggleBookmark(this.user, id); this.write(saved ? '\r\nBookmarked.\r\n' : '\r\nBookmark removed.\r\n'); return; }
    if (choice === 'q') {
      this.write('Floor number to quote: '); const floor = Number((await this.readLine()).trim());
      const post = data.posts.find((p) => p.floor === floor);
      if (post?.status === 'visible' && post.content) return this.reply(id, post.id, `> ${this.plain(post.content).split('\n').join('\n> ')}\n\n`);
    }
    if (choice === 'd' && page < data.pages) return this.showThread(id, page + 1);
    if (choice === 'p' && page > 1) return this.showThread(id, page - 1);
  }

  private async latest() {
    if (!(await this.refreshIdentity())) return;
    const data = await this.community.home(this.user?.role || 'guest');
    this.write('\r\nLatest threads:\r\n');
    data.threads.forEach((t: any, i: number) => this.write(this.menuLine(`${i + 1}. ${t.title} (${t.replyCount} replies)`)));
    this.write('Open number, or Enter to return: ');
    const num = Number((await this.readLine()).trim()); if (num > 0 && data.threads[num - 1]) await this.showThread(data.threads[num - 1].id);
  }

  private async search() {
    if (!(await this.refreshIdentity(true))) return;
    await this.community.enforceTerminalRateLimit?.('search', this.user?.id, this.remoteIp(), 12, 60_000);
    this.write('\r\nSearch query: '); const query = (await this.readLine()).trim();
    const results = await this.community.search(query, this.user?.role || 'guest');
    this.write(`\r\n${results.threads.length} thread results:\r\n`);
    results.threads.forEach((t: any, i: number) => this.write(this.menuLine(`${i + 1}. ${t.title}`)));
    this.write('Open number, or Enter to return: ');
    const num = Number((await this.readLine()).trim()); if (num > 0 && results.threads[num - 1]) await this.showThread(results.threads[num - 1].id);
  }

  private async newThread(boardId: number) {
    if (!(await this.refreshIdentity(true))) return;
    if (!this.user) { this.write('\r\nSign in on the Web to post.\r\n'); return; }
    this.write('\r\nSubject: '); const title = await this.readLine();
    this.write('Message (enter lines; a single dot ends the post):\r\n'); const content = await this.readMultiline();
    await this.community.enforceTerminalRateLimit?.('thread.create', undefined, this.remoteIp(), 8, 10 * 60_000);
    const thread = await this.community.createThread(this.user, boardId, title, content);
    this.write(`\r\nCreated thread #${thread.id}.\r\n`);
  }

  private async reply(threadId: number, replyToPostId?: number, prefix = '') {
    if (!(await this.refreshIdentity(true))) return;
    if (!this.user) { this.write('\r\nSign in on the Web to reply.\r\n'); return; }
    this.write(`\r\nReply${prefix ? ' with quote' : ''} (a single dot ends the reply):\r\n${prefix}`); const content = prefix + await this.readMultiline();
    await this.community.enforceTerminalRateLimit?.('post.create', undefined, this.remoteIp(), 20, 10 * 60_000);
    const post = await this.community.createPost(this.user, threadId, content, replyToPostId);
    this.write(`\r\nReply posted as #${post.floor}.\r\n`);
  }

  private async profile() {
    if (!(await this.refreshIdentity())) return;
    const name = this.user?.username;
    if (!name) { this.write('\r\nAnonymous guest.\r\n'); return; }
    const profile = await this.community.profile(name, this.user?.role || 'guest');
    this.write(`\r\n${this.safeText(profile.user.nickname)} (@${profile.user.username}) · UID ${profile.user.id}\r\nPosts: ${profile.user.postCount}\r\n`);
    for (const thread of profile.threads) this.write(this.menuLine(`- ${thread.title}`));
  }

  private async inbox() {
    if (!(await this.refreshIdentity(true))) return;
    await this.community.enforceTerminalRateLimit?.('terminal.inbox', this.user?.id, this.remoteIp(), 12, 60_000);
    if (!this.user) { this.write('\r\nSign in on the Web to view notifications and messages.\r\n'); return; }
    const [notifications, conversations] = await Promise.all([this.community.notificationsFor(this.user.id), this.community.listConversations(this.user.id)]);
    this.write('\r\nNotifications:\r\n'); notifications.slice(0, 8).forEach((n) => this.write(` - ${this.safeText(n.title)}: ${this.safeText(n.body)}\r\n`));
    this.write('Messages:\r\n'); conversations.slice(0, 8).forEach((c: any, i: number) => this.write(` ${i + 1}. ${this.safeText(c.otherUser?.nickname || 'user')}\r\n`));
    this.write('Open conversation number, or Enter to return: ');
    const number = Number((await this.readLine()).trim()); const item: any = conversations[number - 1]; if (item) { const data = await this.community.conversation(this.user.id, item.id); await this.community.markConversationRead(this.user.id, item.id); for (const message of data.messages) this.write(`\r\n${message.createdAt.toISOString()}: ${this.safeText(message.body)}\r\n`); }
  }

  private async composeMessage() {
    if (!(await this.refreshIdentity(true))) return;
    if (!this.user) { this.write('\r\nSign in on the Web to send private messages.\r\n'); return; }
    this.write('\r\nRecipient username: '); const recipient = (await this.readLine()).trim();
    this.write('Message (a single dot ends the message):\r\n'); const body = await this.readMultiline(10_000);
    await this.community.enforceTerminalRateLimit?.('message.create', undefined, this.remoteIp(), 12, 10 * 60_000);
    const id = await this.community.sendMessage(this.user, recipient, body);
    this.write(`\r\nMessage sent. Conversation #${id}.\r\n`);
  }

  private async bookmarks() {
    if (!(await this.refreshIdentity())) return;
    if (!this.user) { this.write('\r\nSign in on the Web to view bookmarks.\r\n'); return; }
    const threads: any[] = await this.community.bookmarksFor(this.user.id, this.user.role);
    this.write('\r\nBookmarks:\r\n'); threads.forEach((t, i) => this.write(this.menuLine(`${i + 1}. ${t.title}`)));
    this.write('Open number, or Enter to return: '); const number = Number((await this.readLine()).trim()); if (threads[number - 1]) await this.showThread(threads[number - 1].id);
  }

  private async readLine(echo = Boolean(this.io.telnet)): Promise<string> {
    const line = this.completedLines.length ? this.completedLines.shift() || '' : await new Promise<string>((resolve) => {
      if (this.closed) return resolve('');
      this.lineWaiter = { resolve, echo };
    });
    if (line === '\0__line_too_long__') { this.write('\r\n输入过长，已忽略。\r\n'); return ''; }
    return line;
  }

  private async readMultiline(maxLength = 100_000) {
    const lines: string[] = [];
    let length = 0;
    let tooLong = false;
    while (!this.closed) {
      this.write('> ');
      const line = await this.readLine();
      if (line === '.') break;
      length += line.length + 1;
      if (length > maxLength) tooLong = true;
      if (!tooLong) lines.push(line);
    }
    if (tooLong) throw new Error(`正文最多允许 ${maxLength} 个字符`);
    return lines.join('\n');
  }

  private receive(chunk: Buffer | string) {
    let buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    if (buffer.length > TerminalUi.maxInputChunkBytes) { this.write('\r\n输入过大，已断开连接。\r\n'); this.closeInput(); this.io.input.destroy(); return; }
    if (this.io.telnet) buffer = this.stripTelnet(buffer);
    if (!buffer.length) return;
    const decoded = this.decoder.write(buffer);
    for (const character of decoded) {
      if (this.skipLineTerminatorSuffix) {
        this.skipLineTerminatorSuffix = false;
        if (character === '\n' || character === '\0') continue;
      }
      if (character === '\r' || character === '\n') {
        const line = this.lineOverflow ? '\0__line_too_long__' : this.pendingLine;
        this.pendingLine = '';
        this.pendingLength = 0;
        this.lineOverflow = false;
        const waiter = this.lineWaiter;
        this.lineWaiter = undefined;
        if (waiter) { if (waiter.echo && this.io.telnet) this.write('\r\n'); waiter.resolve(line); }
        else if (this.completedLines.length < TerminalUi.maxQueuedLines) this.completedLines.push(line);
        // SSH PTYs commonly send CR, while Telnet clients may send CRLF or CR-NUL.
        if (character === '\r') this.skipLineTerminatorSuffix = true;
      } else if (character === '\u007f' || character === '\b') {
        if (this.pendingLine) {
          this.pendingLine = Array.from(this.pendingLine).slice(0, -1).join('');
          this.pendingLength = Math.max(0, this.pendingLength - 1);
          if (this.lineWaiter?.echo && this.io.telnet) this.write('\b \b');
        }
      } else if (character >= ' ' || character === '\t') {
        if (this.lineOverflow) continue;
        if (this.pendingLength >= TerminalUi.maxLineLength) {
          this.pendingLine = '';
          this.pendingLength = 0;
          this.lineOverflow = true;
        } else {
          this.pendingLine += character;
          this.pendingLength++;
          if (this.lineWaiter?.echo && this.io.telnet) this.write(character);
        }
      }
    }
  }

  private stripTelnet(buffer: Buffer): Buffer {
    const output: number[] = [];
    for (const byte of buffer) {
      if (this.telnetState === 0) { if (byte === 255) this.telnetState = 1; else output.push(byte); }
      else if (this.telnetState === 1) {
        if (byte === 250) this.telnetState = 3;
        else if (byte >= 251 && byte <= 254) this.telnetState = 2;
        else if (byte === 255) { output.push(byte); this.telnetState = 0; }
        else this.telnetState = 0;
      } else if (this.telnetState === 2) this.telnetState = 0;
      else if (this.telnetState === 3) { if (byte === 255) this.telnetState = 4; }
      else if (this.telnetState === 4) this.telnetState = byte === 240 ? 0 : 3;
    }
    return Buffer.from(output);
  }

  private setEncoding(encoding: 'utf8' | 'gbk') { this.encoding = encoding; this.decoder = iconv.getDecoder(encoding); }

  private closeInput() {
    this.closed = true;
    const waiter = this.lineWaiter;
    this.lineWaiter = undefined;
    this.pendingLine = '';
    this.pendingLength = 0;
    this.completedLines = [];
    waiter?.resolve(this.pendingLine);
    if (!this.io.output.destroyed) this.io.output.end();
  }
  private async refreshIdentity(force = false): Promise<boolean> {
    if (!this.user) return true;
    if (!force && Date.now() - this.lastValidatedAt < 45_000) return true;
    const fresh = await this.community.validateTerminalIdentity?.(this.user.id, this.user.sessionVersion);
    if (!fresh) {
      this.write('\r\n登录状态已失效，请重新连接登录。\r\n');
      this.user = null;
      this.closeInput();
      this.io.input.destroy();
      return false;
    }
    this.user = fresh;
    this.lastValidatedAt = Date.now();
    return true;
  }
  private consumeCommandBudget(expensive: boolean) {
    const now = Date.now();
    this.commandTimes = this.commandTimes.filter((time) => now - time < 60_000);
    this.expensiveCommandTimes = this.expensiveCommandTimes.filter((time) => now - time < 60_000);
    if (this.commandTimes.length >= config.terminal.commandRateLimit) return false;
    if (expensive && this.expensiveCommandTimes.length >= config.terminal.expensiveCommandRateLimit) return false;
    this.commandTimes.push(now);
    if (expensive) this.expensiveCommandTimes.push(now);
    return true;
  }
  private write(value: string) {
    const text = this.ascii ? value.replace(/[^\x00-\x7F]/g, '?') : value;
    this.io.output.write(this.encoding === 'gbk' ? iconv.encode(text, 'gbk') : text);
  }
  private clear() { if (this.ansi) this.write('\x1b[2J\x1b[H'); else this.write('\r\n'); }
  private rule() { return `+${'-'.repeat(Math.max(18, Math.min(this.width - 2, 78)))}+\r\n`; }
  private center(text: string) { const inner = Math.min(this.width - 2, 78); return `|${centerColumns(text, inner)}|\r\n`; }
  private menuLine(value: string) { return wrapColumns(this.safeText(value), Math.max(20, this.width - 4)).map((line, index) => `${index ? '    ' : '  '}${line}`).join('\r\n') + '\r\n'; }
  private plain(value: string) { return this.safeText(value).replace(/```[\s\S]*?```/g, (code) => code.replace(/```[^\n]*\n?|```/g, '')).replace(/!\[([^\]]*)\]\([^)]*\)/g, '[image: $1]').replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 <$2>').replace(/[#*_`~]/g, '').slice(0, 6000); }
  private wrap(value: string) { return wrapColumns(value, Math.max(24, this.width - 4)).join('\r\n'); }
  private safeText(value: unknown) { return String(value ?? '').replace(/[\x00-\x08\x0B-\x1F\x7F-\x9F]/g, ' '); }
  private errorMessage(error: unknown) {
    if (error instanceof HttpException) {
      const response = error.getResponse();
      if (error.getStatus() < 500) return this.safeText(typeof response === 'string' ? response : (response as any)?.message || error.message).slice(0, 240);
    }
    if (error instanceof Error && /最多允许/.test(error.message)) return this.safeText(error.message);
    return '服务暂时无法完成此操作，请稍后再试。';
  }
  private remoteIp() { return this.io.remoteIp || (this.io.input as any).remoteAddress || 'unknown'; }
}
