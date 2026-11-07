// Аккаунт ВлодБраузера на ВлодПочте: устройства (токены), ключ шифрования и зашифрованные данные синхронизации.
// Сервер хранит только шифротекст (AES-GCM, ключ из кодовой фразы — PBKDF2 в браузере) и соль с проверочным блоком:
// прочитать закладки, историю и пароли без кодовой фразы нельзя — ни админу, ни базе.
import crypto from 'node:crypto';
import { q, one } from '../../db.js';
import { unauthorized, need, conflict } from '../errors.js';

export const COLLECTIONS = ['bookmarks', 'history', 'passwords'];
const MAX_BLOB = 2 * 1024 * 1024;
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');

export async function createDevice(accountId, name) {
  const n = await one('SELECT COUNT(*) AS n FROM browser_devices WHERE account_id = ?', [accountId]);
  need(Number(n.n) < 20, 'Не больше 20 устройств — удалите старые в настройках ВлодПочты');
  const token = `bsy_${crypto.randomBytes(24).toString('base64url')}`;
  await q('INSERT INTO browser_devices (account_id, name, token_hash, last_seen) VALUES (?, ?, ?, NOW(3))', [accountId, String(name || 'ВлодБраузер').slice(0, 80), sha(token)]);
  return token;
}

/** Устройство по токену (тело запроса): { device, account }. */
export async function deviceOf(token) {
  if (typeof token !== 'string' || !token.startsWith('bsy_')) throw unauthorized('Войдите во ВлодБраузер заново');
  const d = await one('SELECT d.*, a.login, a.name AS account_name, a.status FROM browser_devices d JOIN mail_accounts a ON a.id = d.account_id WHERE d.token_hash = ?', [sha(token)]);
  if (!d || d.status !== 'active') throw unauthorized('Устройство отключено от аккаунта — войдите заново');
  if (!d.last_seen || Date.now() - new Date(d.last_seen).getTime() > 60000) q('UPDATE browser_devices SET last_seen = NOW(3) WHERE id = ?', [d.id]).catch(() => {});
  return d;
}

export const keyOf = (accountId) => one('SELECT salt, iterations, check_blob FROM browser_sync_keys WHERE account_id = ?', [accountId]);

export async function setKey(accountId, { salt, iterations, check }) {
  need(/^[A-Za-z0-9+/=]{16,64}$/.test(String(salt || '')), 'Неверная соль');
  const it = Number(iterations);
  need(Number.isInteger(it) && it >= 100000 && it <= 2000000, 'Неверное число итераций PBKDF2');
  need(typeof check === 'string' && check.length < 2000, 'Неверный проверочный блок');
  if (await keyOf(accountId)) throw conflict('key_exists', 'Кодовая фраза уже задана — введите её');
  await q('INSERT INTO browser_sync_keys (account_id, salt, iterations, check_blob) VALUES (?, ?, ?, ?)', [accountId, salt, it, check]);
}

/** Сбросить синхронизацию: данные и ключ удаляются, устройства остаются (им нужно задать новую фразу). */
export async function wipe(accountId) {
  await q('DELETE FROM browser_sync_data WHERE account_id = ?', [accountId]);
  await q('DELETE FROM browser_sync_keys WHERE account_id = ?', [accountId]);
}

export async function pull(accountId) {
  const rows = await q('SELECT collection, rev, blob_data, updated_at FROM browser_sync_data WHERE account_id = ?', [accountId]);
  return Object.fromEntries(rows.map((r) => [r.collection, { rev: r.rev, blob: r.blob_data, updated_at: r.updated_at }]));
}

/** Записать коллекцию, если её версия не изменилась с base_rev (иначе 409 — браузер сливает и повторяет). */
export async function push(accountId, collection, baseRev, blob) {
  need(COLLECTIONS.includes(collection), 'Неизвестная коллекция');
  need(typeof blob === 'string' && blob.length <= MAX_BLOB, 'Данные больше 2 МБ');
  const base = Number(baseRev) || 0;
  if (base === 0) {
    const r = await q('INSERT IGNORE INTO browser_sync_data (account_id, collection, rev, blob_data) VALUES (?, ?, 1, ?)', [accountId, collection, blob]);
    if (r.affectedRows) return 1;
  } else {
    const r = await q('UPDATE browser_sync_data SET rev = rev + 1, blob_data = ?, updated_at = NOW(3) WHERE account_id = ? AND collection = ? AND rev = ?', [blob, accountId, collection, base]);
    if (r.affectedRows) return base + 1;
  }
  const cur = await one('SELECT rev FROM browser_sync_data WHERE account_id = ? AND collection = ?', [accountId, collection]);
  throw conflict('stale', 'Данные изменились на другом устройстве', { rev: cur?.rev || 0 });
}
