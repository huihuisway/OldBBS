import { readFile, readdir } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import nunjucks from 'nunjucks';

const root = resolve('views');
const env = new nunjucks.Environment(new nunjucks.FileSystemLoader(root, { noCache: true }), { autoescape: true });
env.addFilter('markdown', (value) => String(value || ''));

async function templates(dir) {
  const results = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = resolve(dir, entry.name);
    if (entry.isDirectory()) results.push(...await templates(path));
    else if (entry.name.endsWith('.njk')) results.push(path);
  }
  return results;
}

let failures = 0;
for (const path of await templates(root)) {
  const name = relative(root, path).replaceAll('\\', '/');
  const source = await readFile(path, 'utf8');
  if (/<\s*(?:details|summary)\b/i.test(source)) { failures++; console.error(`${name}: key controls must not depend on details/summary`); }
  if (/<tr\b[^>]*>\s*<form\b|<form\b[^>]*>\s*<td\b/i.test(source)) { failures++; console.error(`${name}: invalid form/table structure`); }
  let formDepth = 0;
  for (const match of source.matchAll(/<\/?form\b[^>]*>/gi)) {
    if (/^<\//.test(match[0])) formDepth = Math.max(0, formDepth - 1);
    else if (formDepth) { failures++; console.error(`${name}: nested forms are invalid HTML`); }
    else formDepth++;
  }
  if (formDepth !== 0) { failures++; console.error(`${name}: unbalanced form element`); }
  const date = new Date();
  const user = { id: 1, username: 'sample', nickname: 'Sample', role: 'user', status: 'active', createdAt: date, lastOnlineAt: date, postCount: 0, signature: '', theme: 'classic', lowBandwidth: false };
  try { env.render(name, { boards: [], threads: [], posts: [], users: [], devices: [], software: [], reports: [], keys: [], items: [], conversations: [], logs: [], tags: [], messages: [], currentUser: user, csrfToken: '', user, device: { id: 1, slug: 'sample', name: 'Sample device' }, thread: { id: 1, title: 'Sample thread', replyCount: 0, viewCount: 0, isPinned: false, isFeatured: false, isLocked: false }, board: { id: 1, slug: 'sample', name: 'Sample board' }, attachment: { id: 1, originalName: 'sample.zip', fileSize: 1, sha256: '0'.repeat(64), scanStatus: 'pending_scan' }, tag: { name: 'sample' }, otherUser: user, conversation: { id: 1 }, status: 404, meta: { page: 1, page_size: 25, total: 0 }, page: 1, pages: 1, query: '', queryParam: '', quote: null, canModerate: false }); }
  catch (error) { failures++; console.error(`${name}: ${error.message}`); }
}
if (failures) process.exit(1);
console.log(`Template syntax passed for ${(await templates(root)).length} Nunjucks views.`);
