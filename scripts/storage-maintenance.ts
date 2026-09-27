import 'reflect-metadata';
import { access, readdir, stat, unlink } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AppDataSource } from '../src/database/data-source';
import { config } from '../src/config';

async function main() {
  await AppDataSource.initialize();
  try {
    const root = resolve(config.uploadDir);
    const rootInfo = await stat(root).catch(() => null);
    if (!rootInfo?.isDirectory()) throw new Error(`Upload storage directory is missing: ${root}; refusing to reconcile attachment records`);
    const rows = await AppDataSource.query('SELECT id, storageKey FROM attachments') as Array<{ id: number; storageKey: string }>;
    const known = new Set(rows.map((row) => row.storageKey));
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    let orphanFilesRemoved = 0;
    for (const entry of entries) {
      if (!entry.isFile() || entry.name === '.incoming' || known.has(entry.name)) continue;
      await unlink(join(root, entry.name)).catch(() => undefined);
      orphanFilesRemoved++;
    }
    const missingIds: number[] = [];
    for (const row of rows) {
      try { await access(join(root, row.storageKey)); }
      catch { missingIds.push(row.id); }
    }
    await AppDataSource.transaction(async (manager) => {
      if (missingIds.length) await manager.query(`DELETE FROM attachments WHERE id IN (${missingIds.map(() => '?').join(',')})`, missingIds);
      await manager.query("UPDATE users u LEFT JOIN (SELECT uploaderId, SUM(fileSize) AS usedBytes FROM attachments WHERE scanStatus <> 'rejected' GROUP BY uploaderId) a ON a.uploaderId = u.id SET u.storageUsedBytes = COALESCE(a.usedBytes, 0)");
    });
    console.log(JSON.stringify({ orphanFilesRemoved, missingRowsRemoved: missingIds.length, quotasRebuilt: true }));
  } finally {
    if (AppDataSource.isInitialized) await AppDataSource.destroy();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
