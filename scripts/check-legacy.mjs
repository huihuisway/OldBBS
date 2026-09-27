import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const jsRoot = new URL('../public/js/', import.meta.url);
const cssRoot = new URL('../public/css/', import.meta.url);
const viewsRoot = new URL('../views/', import.meta.url);
const bannedJs = /\b(?:const|let|async|await|Promise)\b|=>|\?\.|\bfetch\s*\(/;

async function files(dir, extension) {
  let names;
  try { names = await readdir(fileURLToPath(dir), { withFileTypes: true }); } catch { return []; }
  const found = [];
  for (const item of names) {
    const path = join(fileURLToPath(dir), item.name);
    if (item.isDirectory()) found.push(...await files(new URL(`${item.name}/`, dir), extension));
    else if (item.name.endsWith(extension)) found.push(path);
  }
  return found;
}

const failures = [];
for (const path of await files(jsRoot, '.js')) {
  const source = await readFile(path, 'utf8');
  if (bannedJs.test(source)) failures.push(`${path}: uses syntax/API outside the Legacy JS baseline`);
}
for (const path of await files(cssRoot, '.css')) {
  const source = (await readFile(path, 'utf8')).replace(/\/\*[\s\S]*?\*\//g, '');
  if (/display\s*:\s*grid\b/i.test(source)) failures.push(`${path}: display:grid is not allowed in core CSS`);
}
for (const path of await files(viewsRoot, '.njk')) {
  const source = await readFile(path, 'utf8');
  if (/<\s*script\b/i.test(source)) failures.push(`${path}: core SSR templates must not depend on JavaScript`);
  if (/\b(?:onclick|onsubmit|onchange)\s*=/i.test(source) || /\b(?:fetch|XMLHttpRequest)\s*\(/i.test(source)) failures.push(`${path}: core navigation and forms must work without JavaScript`);
  if (/\b(?:window\.location|location\.href|history\.pushState|router-outlet|ng-view|data-reactroot|hydrateRoot|createRoot)\b/i.test(source)) failures.push(`${path}: client-rendered or SPA navigation is not allowed in core views`);
  for (const form of source.matchAll(/<form\b([^>]*)>/gi)) {
    if (!/\bmethod\s*=\s*["'](?:get|post)["']/i.test(form[1]) || !/\baction\s*=\s*["']/i.test(form[1])) {
      failures.push(`${path}: every core form needs a native method and action`);
    }
  }
}
if (failures.length) { console.error(failures.join('\n')); process.exit(1); }
console.log('Legacy checks passed: core SSR has native forms, no required JavaScript, no CSS Grid, and no incompatible core scripts.');
