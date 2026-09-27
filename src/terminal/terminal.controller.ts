import { Injectable, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { createServer as createNetServer, Server as NetServer, Socket } from 'node:net';
import { chmodSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Server as SshServer, Connection } from 'ssh2';
import { CommunityService } from '../community/community.service';
import { config } from '../config';
import { TerminalUi } from './terminal-ui';

@Injectable()
export class TerminalController implements OnApplicationBootstrap, OnApplicationShutdown {
  private sshServer?: SshServer;
  private telnetServer?: NetServer;
  private readonly clientTimes = new Map<string, number[]>();
  private readonly ipConnections = new Map<string, number>();
  private readonly sshClients = new Set<Connection>();
  private readonly telnetClients = new Set<Socket>();
  private lastClientSweep = 0;
  private active = 0;
  private readonly maxTrackedIps = 10_000;

  constructor(private readonly community: CommunityService) {}

  async onApplicationBootstrap() {
    if (config.ssh.enabled) this.startSsh();
    if (config.telnet.enabled) this.startTelnet();
  }

  async onApplicationShutdown() {
    for (const socket of this.telnetClients) socket.end('Server shutting down.\r\n');
    for (const client of this.sshClients) client.end();
    const forceClose = setTimeout(() => {
      for (const socket of this.telnetClients) socket.destroy();
      for (const client of this.sshClients) (client as any)._sock?.destroy();
    }, 1500);
    forceClose.unref();
    await Promise.all([this.closeServer(this.sshServer), this.closeServer(this.telnetServer)]);
    clearTimeout(forceClose);
  }

  private startSsh() {
    const path = config.ssh.hostKeyPath;
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existsSync(path)) {
      const generated = spawnSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', path], { stdio: 'ignore' });
      if (generated.status !== 0) throw new Error(`Could not create SSH host key at ${path}; install openssh or set SSH_HOST_KEY_PATH`);
    }
    chmodSync(path, 0o600);
    this.sshServer = new SshServer({ hostKeys: [readFileSync(path)], ident: 'OldBBS Terminal' }, (client, info) => {
      const ip = info.ip || 'unknown';
      if (!this.allowConnection(ip)) { client.end(); return; }
      this.sshClients.add(client);
      let released = false;
      let channels = 0;
      let shells = 0;
      let shellTimes: number[] = [];
      const release = () => {
        if (released) return;
        released = true;
        this.sshClients.delete(client);
        this.releaseConnection(ip);
        clearTimeout(authTimer);
        clearTimeout(lifetimeTimer);
      };
      const authTimer = setTimeout(() => { client.end(); setTimeout(() => (client as any)._sock?.destroy(), 1000).unref(); }, config.terminal.authTimeoutMs);
      const lifetimeTimer = setTimeout(() => { client.end(); setTimeout(() => (client as any)._sock?.destroy(), 1000).unref(); }, config.terminal.maxLifetimeMs);
      authTimer.unref(); lifetimeTimer.unref();
      client.on('close', release);
      client.on('end', release);
      client.on('error', () => undefined);
      client.on('authentication', (ctx) => {
        void (async () => {
          if (ctx.method === 'password') {
            const user = await this.community.terminalLogin(ctx.username, ctx.password, ip, true);
            if (user) { (client as any).oldbbsUser = user; ctx.accept(); } else ctx.reject();
            return;
          }
          if (ctx.method === 'publickey') {
            const user = await this.community.verifySshKey(ctx.username, ctx.key.data, ip, ctx.blob, ctx.signature, ctx.hashAlgo);
            if (user) { (client as any).oldbbsUser = user; ctx.accept(); } else ctx.reject();
            return;
          }
          ctx.reject();
        })().catch(() => ctx.reject());
      });
      client.on('tcpip', (_accept, reject) => reject());
      client.on('openssh.streamlocal', (_accept, reject) => reject());
      client.on('request', (_accept, reject) => reject?.());
      client.on('ready', () => {
        clearTimeout(authTimer);
        const user = (client as any).oldbbsUser;
        client.on('session', (accept, reject) => {
          if (channels >= config.ssh.maxChannelsPerConnection) { reject(); return; }
          channels++;
          let columns = 80;
          let terminal: TerminalUi | undefined;
          const session = accept();
          let channelReleased = false;
          const releaseChannel = () => { if (!channelReleased) { channelReleased = true; channels = Math.max(0, channels - 1); } };
          session.on('close', releaseChannel);
          session.on('pty', (acceptPty, _rejectPty, info) => { columns = info.cols || 80; acceptPty(); });
          session.on('window-change', (_acceptChange, _rejectChange, info) => terminal?.setWidth(info.cols));
          session.on('exec', (_acceptExec, rejectExec) => rejectExec());
          session.on('subsystem', (_acceptSubsystem, rejectSubsystem) => rejectSubsystem());
          session.on('env', (_acceptEnv, rejectEnv) => rejectEnv());
          session.on('x11', (_acceptX11, rejectX11) => rejectX11());
          session.on('shell', (acceptShell, rejectShell) => {
            const now = Date.now();
            shellTimes = shellTimes.filter((time) => now - time < 60_000);
            if (shells >= config.ssh.maxShellsPerConnection || shellTimes.length >= config.terminal.maxShellsPerMinute) { rejectShell(); return; }
            shellTimes.push(now);
            shells++;
            const channel = acceptShell();
            let idleTimer: NodeJS.Timeout;
            const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => { channel.end('\r\nIdle timeout.\r\n'); channel.destroy(); }, config.terminal.idleTimeoutMs); idleTimer.unref(); };
            resetIdle();
            channel.on('data', resetIdle);
            channel.on('close', () => { clearTimeout(idleTimer); shells = Math.max(0, shells - 1); releaseChannel(); });
            terminal = new TerminalUi({ input: channel, output: channel, remoteIp: ip }, this.community, user);
            terminal.setWidth(columns);
            void terminal.run();
          });
        });
      });
    });
    this.sshServer.on('error', (error: Error) => console.error('OldBBS SSH error:', error.message));
    this.sshServer.listen(config.ssh.port, config.ssh.host, () => console.log(`OldBBS SSH listening at ${config.ssh.host}:${config.ssh.port}`));
  }

  private startTelnet() {
    this.telnetServer = createNetServer((socket: Socket) => {
      const ip = socket.remoteAddress || 'unknown';
      if (!this.allowConnection(ip)) { socket.destroy(); return; }
      this.telnetClients.add(socket);
      let released = false;
      const release = () => { if (!released) { released = true; this.telnetClients.delete(socket); this.releaseConnection(ip); clearTimeout(authTimer); clearTimeout(lifetimeTimer); } };
      const authTimer = setTimeout(() => { socket.end('Login timeout.\r\n'); socket.destroy(); }, config.terminal.authTimeoutMs);
      const lifetimeTimer = setTimeout(() => { socket.end('Session limit reached.\r\n'); socket.destroy(); }, config.terminal.maxLifetimeMs);
      authTimer.unref(); lifetimeTimer.unref();
      socket.setTimeout(config.terminal.idleTimeoutMs);
      socket.on('timeout', () => { socket.end('Idle timeout.\r\n'); socket.destroy(); });
      socket.on('close', release);
      socket.on('error', () => undefined);
      const terminal = new TerminalUi({ input: socket, output: socket, telnet: true, remoteIp: ip, onLoginComplete: () => clearTimeout(authTimer) }, this.community);
      void terminal.run();
    });
    this.telnetServer.on('error', (error) => console.error('OldBBS Telnet error:', error.message));
    this.telnetServer.listen(config.telnet.port, config.telnet.host, () => console.log(`OldBBS Telnet listening at ${config.telnet.host}:${config.telnet.port}`));
  }

  private allowConnection(ip: string) {
    if (this.active >= config.terminal.maxConnections || (this.ipConnections.get(ip) || 0) >= config.terminal.maxConnectionsPerIp) return false;
    const now = Date.now();
    if (now - this.lastClientSweep >= 30_000) {
      this.lastClientSweep = now;
      for (const [address, recent] of this.clientTimes) {
        const fresh = recent.filter((time) => now - time < 5 * 60_000);
        if (fresh.length) this.clientTimes.set(address, fresh);
        else this.clientTimes.delete(address);
      }
    }
    if (!this.clientTimes.has(ip) && this.clientTimes.size >= this.maxTrackedIps) return false;
    const timestamps = (this.clientTimes.get(ip) || []).filter((time) => now - time < 60_000);
    if (timestamps.length >= 20) { this.clientTimes.set(ip, timestamps); return false; }
    timestamps.push(now);
    this.clientTimes.set(ip, timestamps);
    this.ipConnections.set(ip, (this.ipConnections.get(ip) || 0) + 1);
    this.active++;
    return true;
  }

  private releaseConnection(ip: string) {
    this.active = Math.max(0, this.active - 1);
    const count = (this.ipConnections.get(ip) || 1) - 1;
    if (count <= 0) this.ipConnections.delete(ip); else this.ipConnections.set(ip, count);
  }

  private closeServer(server?: NetServer | SshServer) {
    if (!server) return Promise.resolve();
    return new Promise<void>((resolve) => server.close(() => resolve()));
  }
}
