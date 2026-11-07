// Файлы сайтов игроков на диске: <sitesDir>/<аккаунт>/<сайт>/... Защита от выхода за пределы каталога, квота, ZIP.
import fs from 'node:fs/promises';
import path from 'node:path';
import zlib from 'node:zlib';
import { config } from '../config.js';
import { bad } from './errors.js';

const NAME_RE = /^[^/\\:*?"<>|]{1,100}$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;
const MAX_DEPTH = 16;

export const accountDir = (accountId) => path.join(config.sitesDir, String(Number(accountId)));
export const siteDir = (accountId, host) => path.join(accountDir(accountId), String(host).replace(/[^a-z0-9.-]/g, '_'));

/** Относительный путь внутри сайта → абсолютный. Бросает ошибку на «..», пустые и странные имена. */
export function safeJoin(base, rel) {
  const parts = String(rel ?? '').replace(/\\/g, '/').split('/').filter((p) => p !== '' && p !== '.');
  if (parts.length > MAX_DEPTH) throw bad('bad_path', 'Слишком глубокая вложенность папок');
  for (const p of parts) {
    if (p === '..' || !NAME_RE.test(p) || CONTROL_RE.test(p) || p.trim() !== p) throw bad('bad_path', `Недопустимое имя: ${p}`);
  }
  const full = path.join(base, ...parts);
  if (full !== base && !full.startsWith(base + path.sep)) throw bad('bad_path', 'Путь вне сайта');
  return { full, rel: parts.join('/') };
}

/** Размер каталога в байтах (без ссылок). */
export async function dirSize(dir) {
  let total = 0;
  let entries;
  try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return 0; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) total += await dirSize(p);
    else if (e.isFile()) total += (await fs.stat(p)).size;
  }
  return total;
}

export async function listDir(base, rel) {
  const { full, rel: clean } = safeJoin(base, rel);
  let entries;
  try { entries = await fs.readdir(full, { withFileTypes: true }); } catch (e) {
    if (e.code === 'ENOENT') return { path: clean, entries: [] };
    if (e.code === 'ENOTDIR') throw bad('not_dir', 'Это файл, а не папка');
    throw e;
  }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory() && !e.isFile()) continue;
    const st = await fs.stat(path.join(full, e.name));
    out.push({ name: e.name, dir: e.isDirectory(), size: e.isFile() ? st.size : 0, mtime: st.mtime });
  }
  out.sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
  return { path: clean, entries: out };
}

const TEXT_EXT = new Set(['html', 'htm', 'css', 'js', 'mjs', 'json', 'txt', 'md', 'svg', 'xml', 'csv', 'webmanifest']);
export const isTextName = (name) => TEXT_EXT.has(String(name).split('.').pop().toLowerCase()) || name === '_headers' || name === '_redirects';

export async function readFile(base, rel) {
  const { full, rel: clean } = safeJoin(base, rel);
  const st = await fs.stat(full).catch(() => null);
  if (!st || !st.isFile()) throw bad('not_found', 'Файл не найден');
  const buf = await fs.readFile(full);
  const text = isTextName(clean) && st.size <= 1024 * 1024;
  return { path: clean, size: st.size, text, content: text ? buf.toString('utf8') : buf.toString('base64') };
}

async function ensureQuota(accountBase, extraBytes, quotaBytes) {
  const used = await dirSize(accountBase);
  if (used + extraBytes > quotaBytes) throw bad('quota', `Не хватает места по тарифу: занято ${(used / 1048576).toFixed(1)} из ${(quotaBytes / 1048576).toFixed(0)} МБ`);
}

/** Записать файл. content — текст или base64 (binary=true). */
export async function writeFile(base, accountBase, rel, content, { binary = false, quotaBytes, maxFileBytes }) {
  const { full, rel: clean } = safeJoin(base, rel);
  if (!clean) throw bad('bad_path', 'Не указано имя файла');
  const buf = binary ? Buffer.from(String(content || ''), 'base64') : Buffer.from(String(content ?? ''), 'utf8');
  if (buf.length > maxFileBytes) throw bad('too_big', `Файл больше ${Math.round(maxFileBytes / 1024)} КБ`);
  const old = await fs.stat(full).catch(() => null);
  if (old?.isDirectory()) throw bad('is_dir', 'Здесь папка с таким именем');
  await ensureQuota(accountBase, buf.length - (old?.size || 0), quotaBytes);
  await fs.mkdir(path.dirname(full), { recursive: true });
  await fs.writeFile(full, buf);
  return { path: clean, size: buf.length };
}

export async function makeDir(base, rel) {
  const { full, rel: clean } = safeJoin(base, rel);
  if (!clean) throw bad('bad_path', 'Не указано имя папки');
  await fs.mkdir(full, { recursive: true });
  return { path: clean };
}

export async function removePath(base, rel) {
  const { full, rel: clean } = safeJoin(base, rel);
  if (!clean) throw bad('bad_path', 'Нельзя удалить корень сайта');
  await fs.rm(full, { recursive: true, force: true });
  return { path: clean };
}

export async function renamePath(base, from, to) {
  const a = safeJoin(base, from);
  const b = safeJoin(base, to);
  if (!a.rel || !b.rel) throw bad('bad_path', 'Не указано имя');
  if (await fs.stat(b.full).catch(() => null)) throw bad('exists', 'Файл с таким именем уже есть');
  await fs.mkdir(path.dirname(b.full), { recursive: true });
  await fs.rename(a.full, b.full);
  return { path: b.rel };
}

// ——— ZIP (хранение и deflate) без сторонних библиотек ———

/** Разобрать ZIP: [{ name, data }]. Ограничения: число файлов, итоговый размер, размер файла. */
export function unzip(buf, { maxFiles = 2000, maxTotal, maxFile }) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw bad('bad_zip', 'Это не ZIP-архив');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  if (count > maxFiles) throw bad('bad_zip', `В архиве больше ${maxFiles} файлов`);
  const files = [];
  let total = 0;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw bad('bad_zip', 'Повреждённый ZIP');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const elen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString(flags & 0x800 ? 'utf8' : 'latin1');
    p += 46 + nlen + elen + clen;
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || /(^|\/)\.DS_Store$/.test(name)) continue;
    if (flags & 1) throw bad('bad_zip', 'Архивы с паролем не поддерживаются');
    if (usize > maxFile) throw bad('too_big', `Файл ${name} больше ${Math.round(maxFile / 1024)} КБ`);
    total += usize;
    if (total > maxTotal) throw bad('quota', 'Архив не помещается в место по тарифу');
    if (buf.readUInt32LE(local) !== 0x04034b50) throw bad('bad_zip', 'Повреждённый ZIP');
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const raw = buf.subarray(start, start + csize);
    let data;
    if (method === 0) data = Buffer.from(raw);
    else if (method === 8) data = zlib.inflateRawSync(raw, { maxOutputLength: usize + 1 });
    else throw bad('bad_zip', `Метод сжатия ${method} не поддерживается (нужен обычный ZIP)`);
    if (data.length !== usize) throw bad('bad_zip', `Размер файла ${name} не совпадает с заявленным`);
    files.push({ name, data });
  }
  return files;
}

/** Распаковать ZIP в каталог сайта. Если все файлы лежат в одной папке — она снимается (как у архива сайта из конструктора). */
export async function extractZip(base, accountBase, buf, { quotaBytes, maxFileBytes, into = '' }) {
  const used = await dirSize(accountBase);
  let files = unzip(buf, { maxTotal: Math.max(0, quotaBytes - used), maxFile: maxFileBytes });
  for (const f of files) safeJoin(base, f.name); // «..», абсолютные пути и странные имена — отказ до записи
  const roots = new Set(files.map((f) => f.name.split('/')[0]));
  if (roots.size === 1 && files.every((f) => f.name.includes('/'))) {
    const root = [...roots][0];
    files = files.map((f) => ({ ...f, name: f.name.slice(root.length + 1) }));
  }
  const written = [];
  for (const f of files) {
    const { full, rel } = safeJoin(base, into ? `${into}/${f.name}` : f.name);
    if (!rel) continue;
    await fs.mkdir(path.dirname(full), { recursive: true });
    await fs.writeFile(full, f.data);
    written.push(rel);
  }
  return written;
}
