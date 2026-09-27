import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';
import { resolve } from 'node:path';
import nunjucks from 'nunjucks';
import { TerminalUi } from '../src/terminal/terminal-ui';

const views = new nunjucks.Environment(new nunjucks.FileSystemLoader(resolve(process.cwd(), 'views')), { autoescape: true });

const sampleBoards = [
  { id: 1, slug: 'android', name: 'Android', description: '', parentId: null },
  { id: 2, slug: 'android-general', name: 'Android 综合', description: '', parentId: 1 },
  { id: 3, slug: 'computers', name: '老电脑', description: '', parentId: null },
];

test('home and board directory keep child boards nested under their parent', () => {
  const context = {
    boards: sampleBoards,
    threads: [],
    announcement: '',
    totals: { today: 0, threads: 0, users: 0, online: 0 },
    currentUser: null,
    csrfToken: '',
  };
  const home = views.render('home/index.njk', context);
  const directory = views.render('boards/index.njk', context);

  assert.match(home, /<strong><a href="\/boards\/android">Android<\/a><\/strong>/);
  assert.match(home, /class="sub-board"><a href="\/boards\/android-general">Android 综合<\/a>/);
  assert.doesNotMatch(home, /<strong><a href="\/boards\/android-general">/);
  assert.equal((directory.match(/<h2>/g) || []).length, 2);
  assert.match(directory, /<h2><a href="\/boards\/android">Android<\/a><\/h2>/);
  assert.match(directory, /<li><a href="\/boards\/android-general">Android 综合<\/a><\/li>/);
});

test('guest layout does not show settings and admin links that return 401', () => {
  const guest = views.render('layouts/main.njk', { currentUser: null, csrfToken: '' });
  assert.doesNotMatch(guest, /href="\/settings"/);
  assert.doesNotMatch(guest, /href="\/admin"/);

  const member = views.render('layouts/main.njk', {
    currentUser: { username: 'member', nickname: 'Member', role: 'user', theme: 'classic' },
    csrfToken: 'csrf',
  });
  assert.match(member, /href="\/settings"/);
  assert.doesNotMatch(member, /href="\/admin"/);
});

test('terminal line reader accepts SSH CR and consumes CRLF or Telnet CR-NUL suffixes', async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  const terminal = new TerminalUi({ input, output }, {} as never);
  const readLine = () => (terminal as any).readLine(false) as Promise<string>;

  const sshLine = readLine();
  input.write(Buffer.from('U\r'));
  assert.equal(await sshLine, 'U');

  const crlfLine = readLine();
  input.write(Buffer.from('\n'));
  let crlfSettled = false;
  void crlfLine.then(() => { crlfSettled = true; });
  await new Promise<void>((resolve) => setImmediate(resolve));
  assert.equal(crlfSettled, false);
  input.write(Buffer.from('G\r\n'));
  assert.equal(await crlfLine, 'G');

  const telnet = new TerminalUi({ input: new PassThrough(), output: new PassThrough(), telnet: true }, {} as never);
  const telnetInput = (telnet as any).io.input as PassThrough;
  const telnetLine = (telnet as any).readLine(false) as Promise<string>;
  telnetInput.write(Buffer.from([0x41, 0x0d, 0x00]));
  assert.equal(await telnetLine, 'A');

  input.destroy();
  output.destroy();
  telnetInput.destroy();
  ((telnet as any).io.output as PassThrough).destroy();
});
