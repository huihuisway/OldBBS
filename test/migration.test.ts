import test from 'node:test';
import assert from 'node:assert/strict';
import { InitialSchema1760000000000 } from '../src/database/migrations/1760000000000-InitialSchema';
import { AddIntegrityAndSecurity1760000001000 } from '../src/database/migrations/1760000001000-AddIntegrityAndSecurity';
import { BetaHardening1760000002000 } from '../src/database/migrations/1760000002000-BetaHardening';

test('initial migration defines the shared web and terminal data model', async () => {
  const statements: string[] = [];
  const migration = new InitialSchema1760000000000();
  await migration.up({ query: async (sql: string) => { statements.push(sql); } } as any);
  const ddl = statements.join('\n');
  for (const table of ['users', 'boards', 'threads', 'posts', 'devices', 'software', 'compatibility_reports', 'notifications', 'conversations', 'messages', 'bookmarks', 'follows', 'reports', 'audit_logs', 'terminal_access_keys', 'ssh_keys', 'tags', 'thread_tags', 'attachments', 'email_tokens', 'site_settings', 'login_attempts']) {
    assert.match(ddl, new RegExp(`CREATE TABLE ${table}\\b`), `${table} table is in the migration`);
  }
  assert.match(ddl, /UNIQUE KEY IDX_posts_thread_floor/);
  assert.match(ddl, /FULLTEXT KEY FT_posts_content/);
});

test('integrity migration adds the security columns and relational constraints', async () => {
  const statements: string[] = [];
  const migration = new AddIntegrityAndSecurity1760000001000();
  await migration.up({ query: async (sql: string) => {
    statements.push(sql);
    if (sql.startsWith('SELECT COUNT(*)')) return [{ count: 0 }];
    return [];
  } } as any);
  const ddl = statements.join('\n');
  assert.match(ddl, /ADD COLUMN sessionVersion/);
  assert.match(ddl, /ADD COLUMN storageQuotaBytes/);
  assert.match(ddl, /ADD COLUMN scanStatus enum\('pending_scan','clean','rejected'\)/);
  assert.match(ddl, /FK_threads_board FOREIGN KEY \(boardId\) REFERENCES boards\(id\) ON DELETE RESTRICT/);
  assert.match(ddl, /FK_posts_reply FOREIGN KEY \(replyToPostId\) REFERENCES posts\(id\) ON DELETE SET NULL/);
  assert.match(ddl, /FK_messages_conversation FOREIGN KEY \(conversationId\) REFERENCES conversations\(id\) ON DELETE CASCADE/);
});

test('integrity migration refuses required orphan rows before applying DDL', async () => {
  const statements: string[] = [];
  const migration = new AddIntegrityAndSecurity1760000001000();
  await assert.rejects(migration.up({ query: async (sql: string) => {
    statements.push(sql);
    if (sql.startsWith('SELECT COUNT(*)')) return [{ count: 2 }];
    return [];
  } } as any), /2 orphan row\(s\) need explicit repair/);
  assert.equal(statements.some((sql) => sql.startsWith('ALTER TABLE')), false);
});

test('beta migration adds review states, render cache, quota-safe scanner states and bounded FULLTEXT indexes', async () => {
  const statements: string[] = [];
  const migration = new BetaHardening1760000002000();
  await migration.up({ query: async (sql: string) => { statements.push(sql); return []; } } as any);
  const ddl = statements.join('\n');
  assert.match(ddl, /FULLTEXT KEY FT_threads_title \(title\)/);
  assert.match(ddl, /FULLTEXT KEY FT_software_search \(name, platform, version, developer\)/);
  assert.match(ddl, /ADD COLUMN reviewStatus enum\('draft','pending_review','published','rejected'\)/);
  assert.match(ddl, /ADD COLUMN renderedHtml longtext NULL/);
  assert.match(ddl, /scanStatus = 'scan_failed' WHERE scanStatus = 'pending_scan'/);
  assert.match(ddl, /UPDATE users u LEFT JOIN/);
  const rollback: string[] = [];
  await migration.down({ query: async (sql: string) => { rollback.push(sql); } } as any);
  assert.ok(rollback[0].includes("SET scanStatus = 'pending_scan' WHERE scanStatus = 'scan_failed'"));
  assert.ok(rollback[1].includes("MODIFY scanStatus enum('pending_scan','clean','rejected')"));
});
