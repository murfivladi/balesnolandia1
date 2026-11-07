// API-токены граждан (bln_…): Authorization: Bearer bln_… вместо cookie входа. Права (scopes) ограничивают адреса API.
// Через токен недоступны: вход, админка, сами токены. Банковские запросы — только «pay» (свои счета и оплата счетов).
import crypto from 'node:crypto';
import { q, one } from '../db.js';
import { bad, notFound, str } from './errors.js';

const G = '^/api/gov/';
export const SCOPES = {
  profile: { label: 'Профиль и паспорт (чтение)', kind: 'gov', re: [new RegExp(`${G}(me|passport)(/|$)`)], read: true },
  domains: { label: 'Домены, организации, регистраторы, аукционы', kind: 'gov', re: [new RegExp(`${G}(domains|orgs|auctions)(/|$)`)] },
  hosting: { label: 'Хостинг: аккаунты, сайты, файлы, хостеры', kind: 'gov', re: [new RegExp(`${G}(hosting|orgs)(/|$)`)] },
  certs: { label: 'Сертификаты и удостоверяющие центры', kind: 'gov', re: [new RegExp(`${G}(certs|cas)(/|$)`), new RegExp(`${G}hosting/\\d+/sites/\\d+/(ssl|cert)`)] },
  services: { label: 'Госуслуги: счета, заявления, налоги, штрафы, пособия, имущество', kind: 'gov', re: [new RegExp(`${G}(invoices|applications|documents|taxes|fines|benefits|properties|appeals|work|elections|doctor|insurance|deals)(/|$)`)] },
  mail: { label: 'ВлодПочта', kind: 'gov', re: [/^\/api\/mail\/(?!sync)/] },
  news: { label: 'БалНовости: свои СМИ и статьи', kind: 'gov', re: [/^\/api\/news\//] },
  hub: { label: 'ВлодХаб: репозитории, задачи, деплой', kind: 'gov', re: [/^\/api\/hub\/(?!tokens|git\/)/] },
  search: { label: 'ВлодПоиск: вебмастер и реклама', kind: 'gov', re: [/^\/api\/search\/(webmaster|ads|campaigns|adnet)/] },
  pay: { label: 'ВлодБанк: свои счета и оплата счетов (по связке с паспортом)', kind: 'bank', re: [/^\/api\/bank\/accounts\/?$/, /^\/api\/bank\/invoices\/[^/]+(\/pay)?$/] },
};
const NEVER = /^\/api\/(auth|admin)\/|^\/api\/gov\/api-tokens/;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

export function bearer(req) {
  const m = /^Bearer\s+(bln_[A-Za-z0-9_-]{20,})$/.exec(String(req.headers?.authorization || ''));
  return m ? m[1] : null;
}

/** Сессия по API-токену для запроса (или null). kind — 'gov' или 'bank'. */
export async function tokenSession(req, kind) {
  const raw = bearer(req);
  if (!raw) return null;
  const path = String(req.url || '').split('?')[0];
  if (NEVER.test(path)) return null;
  const t = await one('SELECT * FROM gov_api_tokens WHERE token_hash = ?', [sha(raw)]);
  if (!t) return null;
  const scopes = (typeof t.scopes === 'string' ? JSON.parse(t.scopes) : t.scopes) || [];
  const ok = scopes.some((s) => {
    const d = SCOPES[s];
    return d && d.kind === kind && d.re.some((re) => re.test(path)) && (!d.read || req.method === 'GET');
  });
  if (!ok) return null;
  q('UPDATE gov_api_tokens SET last_used = NOW(3) WHERE id = ?', [t.id]).catch(() => {});
  if (kind === 'gov') {
    const user = await one('SELECT * FROM gov_users WHERE id = ?', [t.gov_user_id]);
    if (!user || user.status === 'blocked' || user.status === 'rejected') return null;
    return { kind, id: user.id, user, roles: [], api: true, token: {} };
  }
  const link = await one("SELECT l.bank_user_id FROM passport_links l JOIN citizens c ON c.id = l.citizen_id WHERE c.gov_user_id = ? AND l.status = 'confirmed' ORDER BY l.id DESC LIMIT 1", [t.gov_user_id]);
  const user = link && (await one('SELECT * FROM bank_users WHERE id = ?', [link.bank_user_id]));
  if (!user || user.status === 'blocked' || user.status === 'rejected') return null;
  return { kind, id: user.id, user, roles: [], api: true, token: {} };
}

export async function listTokens(govId) {
  const rows = await q('SELECT id, name, prefix, scopes, last_used, created_at FROM gov_api_tokens WHERE gov_user_id = ? ORDER BY id DESC', [govId]);
  return rows.map((r) => ({ ...r, scopes: typeof r.scopes === 'string' ? JSON.parse(r.scopes) : r.scopes }));
}
export async function createToken(govId, b = {}) {
  const name = str(b.name, 'название', { min: 1, max: 80 });
  const scopes = [...new Set(Array.isArray(b.scopes) ? b.scopes : [])].filter((s) => SCOPES[s]);
  if (!scopes.length) throw bad('invalid', 'Выберите хотя бы одно право');
  const n = await one('SELECT COUNT(*) AS n FROM gov_api_tokens WHERE gov_user_id = ?', [govId]);
  if (Number(n.n) >= 20) throw bad('limit', 'Не больше 20 токенов');
  const token = `bln_${crypto.randomBytes(24).toString('base64url')}`;
  const r = await q('INSERT INTO gov_api_tokens (gov_user_id, name, token_hash, prefix, scopes) VALUES (?, ?, ?, ?, ?)', [govId, name, sha(token), token.slice(0, 12), JSON.stringify(scopes)]);
  return { id: r.insertId, token, scopes };
}
export async function deleteToken(govId, id) {
  const r = await q('DELETE FROM gov_api_tokens WHERE id = ? AND gov_user_id = ?', [id, govId]);
  if (!r.affectedRows) throw notFound('Токен не найден');
}
