import 'reflect-metadata';
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { ForbiddenException } from '@nestjs/common';
import { TerminalUi } from '../src/terminal/terminal-ui';
import { TerminalController } from '../src/terminal/terminal.controller';
import { centerColumns, stringWidth, wrapColumns } from '../src/terminal/terminal-width';
import { config } from '../src/config';

test('terminal line input is bounded and queued lines have a fixed maximum', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk) => { shown += chunk.toString(); });
  const ui: any = new TerminalUi({ input, output }, {} as any);
  ui.receive(Buffer.from(`${'a'.repeat(4097)}\r`));
  assert.equal(await ui.readLine(false), '');
  assert.match(shown, /输入过长/);
  ui.receive(Buffer.from('x\r'.repeat(40)));
  assert.equal(ui.completedLines.length, 32);
  input.destroy(); output.destroy();
});

test('terminal rate limits use the transport peer IP when the channel has no socket address', () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const terminal: any = new TerminalUi({ input, output, remoteIp: '203.0.113.22' }, {} as any);
  assert.equal(terminal.remoteIp(), '203.0.113.22');
  input.destroy(); output.destroy();
});

test('Chinese and combining characters use terminal display width', () => {
  assert.equal(stringWidth('论坛abc'), 7);
  assert.equal(stringWidth('e\u0301'), 1);
  assert.equal(centerColumns('中', 6), '  中  ');
  const wrapped = wrapColumns('中文中文', 5);
  assert.deepEqual(wrapped, ['中文', '中文']);
  assert.ok(wrapped.every((line) => stringWidth(line) <= 5));
});

test('an ordinary service error is displayed and leaves the terminal session open', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  let shown = '';
  output.on('data', (chunk) => { shown += chunk.toString(); });
  let homes = 0;
  const home = { boards: [], threads: [], totals: { online: 0, today: 0, users: 0 } };
  const community: any = {
    home: async () => { homes++; if (homes === 2) throw new ForbiddenException('Board is restricted'); return home; },
  };
  const ui = new TerminalUi({ input, output }, community);
  const running = ui.run();
  input.write(Buffer.from('u\r\rN\rQ\r'));
  await running;
  assert.match(shown, /操作失败：Board is restricted/);
  assert.match(shown, /Disconnected from OldBBS/);
  input.destroy(); output.destroy();
});

test('connection rate-limit entries expire and the map remains capped', () => {
  const controller: any = Object.create(TerminalController.prototype);
  const now = Date.now();
  controller.clientTimes = new Map([['expired', [now - 6 * 60_000]]]);
  controller.ipConnections = new Map();
  controller.lastClientSweep = now - 60_000;
  controller.active = 0;
  controller.maxClients = 10;
  controller.maxTrackedIps = 1;
  assert.equal(controller.allowConnection('fresh'), true);
  assert.equal(controller.clientTimes.has('expired'), false);
  assert.deepEqual([...controller.clientTimes.keys()], ['fresh']);
});

test('terminal refresh revokes a session when its account or session version changed', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const community: any = { validateTerminalIdentity: async (_id: number, _version: number) => null };
  const terminal: any = new TerminalUi({ input, output }, community, { id: 4, role: 'moderator', sessionVersion: 2 } as any);
  assert.equal(await terminal.refreshIdentity(true), false);
  assert.equal(terminal.user, null);
  assert.equal(input.destroyed, true);
  output.destroy();
});

test('terminal connection limits enforce per-IP concurrency and release counts', () => {
  const controller: any = Object.create(TerminalController.prototype);
  controller.clientTimes = new Map();
  controller.ipConnections = new Map();
  controller.lastClientSweep = Date.now();
  controller.active = 0;
  controller.maxTrackedIps = 10;
  const priorLimit = config.terminal.maxConnectionsPerIp;
  config.terminal.maxConnectionsPerIp = 1;
  try {
    assert.equal(controller.allowConnection('203.0.113.10'), true);
    assert.equal(controller.allowConnection('203.0.113.10'), false);
    controller.releaseConnection('203.0.113.10');
    assert.equal(controller.allowConnection('203.0.113.10'), true);
  } finally { config.terminal.maxConnectionsPerIp = priorLimit; }
});
