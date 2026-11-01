import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, q } from './db.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'migrations');

/** Разбивает SQL-файл на операторы по «;» в конце строки (без процедур и триггеров). */
export function splitSql(sql) {
  return sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n')
    .split(/;\s*(?:\n|$)/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export async function migrate({ log = console.log } = {}) {
  await q(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name VARCHAR(190) NOT NULL PRIMARY KEY,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ENGINE=InnoDB`);
  const done = new Set((await q('SELECT name FROM schema_migrations')).map((r) => r.name));
  const files = (await fs.readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  for (const f of files) {
    if (done.has(f)) continue;
    const sql = await fs.readFile(path.join(dir, f), 'utf8');
    log(`migrate: ${f}`);
    // DDL в MySQL неявно коммитит, поэтому миграции пишем так, чтобы их было просто повторить вручную.
    for (const stmt of splitSql(sql)) await q(stmt);
    await q('INSERT INTO schema_migrations (name) VALUES (?)', [f]);
  }
}

export async function dropAll() {
  const rows = await q('SHOW TABLES');
  await q('SET FOREIGN_KEY_CHECKS = 0');
  for (const r of rows) await q(`DROP TABLE IF EXISTS \`${Object.values(r)[0]}\``);
  await q('SET FOREIGN_KEY_CHECKS = 1');
}

export { pool };
