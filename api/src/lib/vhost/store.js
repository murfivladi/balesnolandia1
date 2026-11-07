// Данные сайта на виртуальном тарифе: SQLite (настоящий SQLite, собранный в WASM — sql.js) в файле
// <сайт>/.data/site.sqlite и key-value в таблице _kv той же базы. База держится в памяти, на диск пишется
// после каждого изменения. Запросы к одному сайту выполняются по очереди (как один процесс сервера).
import fs from 'node:fs/promises';
import path from 'node:path';
import initSqlJs from 'sql.js/dist/sql-wasm-inline.js';
import { bad } from '../errors.js';

let SQL = null;
const sqlReady = () => SQL || (SQL = initSqlJs());

export const DATA_DIR = '.data';
const DB_FILE = 'site.sqlite';
const MAX_OPEN = 30;
const open = new Map(); // siteId → { db, file, dirty, used }

/** Очередь на сайт: следующий запрос ждёт окончания предыдущего. */
const locks = new Map();
export function withSite(siteId, fn) {
  const prev = locks.get(siteId) || Promise.resolve();
  const run = prev.catch(() => {}).then(fn);
  const tail = run.catch(() => {});
  locks.set(siteId, tail);
  tail.then(() => { if (locks.get(siteId) === tail) locks.delete(siteId); });
  return run;
}

export async function siteDb(site) {
  const hit = open.get(site.id);
  if (hit && hit.dir === site.dir) { hit.used = Date.now(); return hit; }
  const S = await sqlReady();
  const file = path.join(site.dir, DATA_DIR, DB_FILE);
  let buf = null;
  try { buf = await fs.readFile(file); } catch { /* новой базы ещё нет */ }
  const db = buf ? new S.Database(buf) : new S.Database();
  db.run('CREATE TABLE IF NOT EXISTS _kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)');
  const entry = { db, file, dir: site.dir, dirty: !buf, used: Date.now() };
  open.set(site.id, entry);
  if (open.size > MAX_OPEN) {
    const old = [...open.entries()].filter(([id]) => id !== site.id).sort((a, b) => a[1].used - b[1].used)[0];
    if (old) { await flush(old[0]); old[1].db.close(); open.delete(old[0]); }
  }
  return entry;
}

/** Сохранить базу на диск (с проверкой квоты тарифа). */
export async function flush(siteId, { quotaLeft = Infinity } = {}) {
  const e = open.get(siteId);
  if (!e || !e.dirty) return;
  const bytes = e.db.export();
  let old = 0;
  try { old = (await fs.stat(e.file)).size; } catch { /* нет файла */ }
  if (bytes.length - old > quotaLeft) {
    // Не помещается: откатываем изменения в памяти к последней сохранённой версии.
    e.db.close();
    open.delete(siteId);
    throw bad('quota', 'База сайта не помещается в место по тарифу — изменения не сохранены');
  }
  await fs.mkdir(path.dirname(e.file), { recursive: true });
  await fs.writeFile(e.file, bytes);
  e.dirty = false;
}

/** Забыть базу в памяти (файл удалили, сайт удалён, сброс игры). */
export function closeDb(siteId) {
  const e = open.get(siteId);
  if (e) { try { e.db.close(); } catch { /* уже закрыта */ } open.delete(siteId); }
}
export function closeAll() { for (const id of [...open.keys()]) closeDb(id); }

const plain = (v) => (typeof v === 'bigint' ? Number(v) : v instanceof Uint8Array ? `[blob ${v.length} байт]` : v);

/** SQL от скрипта сайта: query — строки, run — изменения. */
export function sqlQuery(entry, sql, params = []) {
  const st = entry.db.prepare(String(sql));
  try {
    st.bind(params);
    const rows = [];
    while (st.step()) {
      const r = st.getAsObject();
      for (const k of Object.keys(r)) r[k] = plain(r[k]);
      rows.push(r);
      if (rows.length > 5000) throw bad('too_many_rows', 'Запрос вернул больше 5000 строк — добавьте LIMIT');
    }
    if (!/^\s*(select|pragma|with|explain)\b/i.test(sql)) entry.dirty = true;
    return rows;
  } finally {
    st.free();
  }
}

export function sqlRun(entry, sql, params = []) {
  entry.db.run(String(sql), params);
  entry.dirty = true;
  return { changes: entry.db.getRowsModified(), lastInsertRowid: Number(entry.db.exec('SELECT last_insert_rowid() AS id')[0]?.values[0][0] || 0) };
}

/** Несколько команд подряд (миграции схемы): db.exec. */
export function sqlExec(entry, sql) {
  const res = entry.db.exec(String(sql));
  entry.dirty = true;
  return res.map((r) => ({ columns: r.columns, rows: r.values.map((v) => v.map(plain)) }));
}

// ——— key-value ———

export function kvOp(entry, op, a, now) {
  const key = (k) => { const s = String(k ?? ''); if (!s || s.length > 512) throw bad('kv_key', 'Ключ — строка до 512 символов'); return s; };
  if (op === 'get') {
    const r = sqlQuery(entry, 'SELECT v, exp FROM _kv WHERE k = ?', [key(a.key)])[0];
    if (!r || (r.exp && r.exp <= now)) return null;
    return JSON.parse(r.v);
  }
  if (op === 'set') {
    const v = JSON.stringify(a.value ?? null);
    if (v.length > 512 * 1024) throw bad('kv_value', 'Значение больше 512 КБ');
    sqlRun(entry, 'INSERT OR REPLACE INTO _kv (k, v, exp) VALUES (?, ?, ?)', [key(a.key), v, a.ttl ? now + Math.max(1, Number(a.ttl)) : null]);
    return true;
  }
  if (op === 'delete') { sqlRun(entry, 'DELETE FROM _kv WHERE k = ?', [key(a.key)]); return true; }
  if (op === 'list') {
    const p = String(a.prefix || '');
    return sqlQuery(entry, "SELECT k FROM _kv WHERE k LIKE ? ESCAPE '\\' AND (exp IS NULL OR exp > ?) ORDER BY k LIMIT 1000", [`${p.replace(/[\\%_]/g, '\\$&')}%`, now]).map((r) => r.k);
  }
  throw bad('kv_op', 'Неизвестная операция kv');
}
