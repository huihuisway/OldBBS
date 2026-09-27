import test from 'node:test';
import assert from 'node:assert/strict';
import { renderMarkdown, slugify } from '../src/common/content';

test('slugify emits a readable stable slug for English and Chinese names', () => {
  assert.equal(slugify('Xperia X10 记录'), 'xperia-x10-记录');
  assert.equal(slugify('---'), 'item');
});

test('markdown output keeps basic formatting and removes dangerous markup', () => {
  const html = renderMarkdown('# Hello\n\n**world** <script>alert(1)</script> [bad](javascript:alert(1))');
  assert.match(html, /<h1>Hello<\/h1>/);
  assert.match(html, /<strong>world<\/strong>/);
  assert.doesNotMatch(html, /<script/i);
  assert.doesNotMatch(html, /javascript:/i);
});

test('unsafe HTML attributes are removed from stored markdown rendering', () => {
  const html = renderMarkdown('<img src=x onerror="alert(1)">');
  assert.doesNotMatch(html, /onerror/i);
});
