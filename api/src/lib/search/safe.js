// Safe Browsing ВлодПоиска: список опасных адресов (выражения «хост/путь»), выдача 4-байтовых префиксов хешей
// браузерам и полных хешей по запросу, жалобы посетителей, автоматическое подозрение у краулера (форма пароля
// с чужим госбрендом), проверка админом.
import { q, one } from '../../db.js';
import { bad, notFound } from '../errors.js';
import { GOV_SITES } from '@bln/shared/balnet-url.js';
import { normalizeExpression, expressionHash, urlHashes, PREFIX_HEX } from '@bln/shared/balnet-safe.js';

export const SAFE_STATUS = { suspected: 'на проверке', confirmed: 'в списке', cleared: 'снят' };

let cache = null;
export function resetSafeCache() { cache = null; }

async function list() {
  if (cache && Date.now() - cache.at < 3000) return cache;
  const rows = await q("SELECT id, expr, hash, threat FROM search_safe WHERE status = 'confirmed'");
  const byHash = new Map(rows.map((r) => [r.hash, r]));
  const prefixes = [...new Set(rows.map((r) => r.hash.slice(0, PREFIX_HEX)))].sort();
  const version = rows.length ? `${rows.length}-${Math.max(...rows.map((r) => Number(r.id)))}` : '0';
  cache = { at: Date.now(), byHash, prefixes, version };
  return cache;
}

/** Обновление списка для браузера: префиксы хешей. */
export async function prefixes() {
  const l = await list();
  return { version: l.version, prefix_hex: PREFIX_HEX, prefixes: l.prefixes };
}

/** Полные хеши по префиксам: браузер присылает только префиксы — сервер не узнаёт, какой сайт открыт. */
export async function fullHashes(pref) {
  const want = new Set((Array.isArray(pref) ? pref : []).slice(0, 50).map((p) => String(p).toLowerCase()));
  const l = await list();
  const matches = [];
  for (const [hash, r] of l.byHash) if (want.has(hash.slice(0, PREFIX_HEX))) matches.push({ hash, threat: r.threat });
  return { matches, cache_seconds: 300 };
}

/** Проверка адреса на сервере (реклама, выдача). */
export async function checkUrl(url) {
  const l = await list();
  if (!l.byHash.size) return null;
  for (const h of await urlHashes(url)) {
    const r = l.byHash.get(h.hash);
    if (r) return { threat: r.threat, expr: r.expr };
  }
  return null;
}

export async function addEntry({ expr, threat = 'phishing', source = 'admin', status = 'confirmed', note = null }) {
  const e = normalizeExpression(expr);
  if (!e) throw bad('bad_expr', 'Нужен адрес вида evil.bln/ или evil.bln/login/');
  if (!['phishing', 'malware', 'unwanted'].includes(threat)) throw bad('bad_threat', 'Неизвестный тип угрозы');
  const hash = await expressionHash(e);
  const ex = await one('SELECT * FROM search_safe WHERE hash = ?', [hash]);
  if (ex) {
    // Автоматика и жалобы не отменяют решение админа.
    if (source === 'admin') await q('UPDATE search_safe SET status = ?, threat = ?, note = COALESCE(?, note), source = ? WHERE id = ?', [status, threat, note, source, ex.id]);
    resetSafeCache();
    return ex.id;
  }
  const r = await q('INSERT INTO search_safe (expr, hash, threat, source, status, note) VALUES (?, ?, ?, ?, ?, ?)', [e, hash, threat, source, status, note]);
  resetSafeCache();
  return r.insertId;
}

export async function setStatus(id, status) {
  if (!SAFE_STATUS[status]) throw bad('bad_status', 'Неизвестный статус');
  const r = await q('UPDATE search_safe SET status = ? WHERE id = ?', [status, id]);
  if (!r.affectedRows) throw notFound('Запись не найдена');
  resetSafeCache();
}

/** Краулер нашёл форму пароля на странице, которая выдаёт себя за госсайт, — в очередь админу. */
const BRANDS = Object.entries(GOV_SITES).map(([host, s]) => ({ host, re: new RegExp(s.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i') }));
export async function autoFlag(url, doc) {
  const host = new URL(url).hostname;
  const hay = `${doc.title} ${doc.headings} ${doc.text.slice(0, 5000)}`;
  const brand = BRANDS.find((b) => b.re.test(hay) && host !== b.host && !host.endsWith(`.${b.host}`));
  if (!brand) return;
  await addEntry({ expr: `${host}/`, threat: 'phishing', source: 'auto', status: 'suspected', note: `Форма пароля и упоминание «${GOV_SITES[brand.host].title}» на ${url}` });
}

export async function report({ url, threat, comment, client }) {
  const u = String(url || '').slice(0, 600);
  if (!/^https?:\/\//i.test(u)) throw bad('bad_url', 'Укажите адрес сайта');
  await q('INSERT INTO search_reports (url, threat, comment, client) VALUES (?, ?, ?, ?)', [u, ['phishing', 'malware', 'unwanted'].includes(threat) ? threat : 'phishing', String(comment || '').slice(0, 500) || null, client || '']);
  return { ok: true };
}

/** Проблемы безопасности сайта (для вебмастера): записи на этом хосте и его поддоменах. */
export async function issuesFor(host) {
  const rows = await q("SELECT id, expr, threat, status, note, created_at FROM search_safe WHERE status <> 'cleared' AND (expr LIKE ? OR expr LIKE ?)", [`${host}/%`, `%.${host}/%`]);
  return rows.filter((r) => r.status === 'confirmed');
}
