// Вход для сайтов БалНета (этап Н9): OAuth 2.0 (RFC 6749) с кодом авторизации и PKCE (RFC 7636).
// Два провайдера: «Войти через ВлодПочту» (mail.bln — адрес ящика) и «Войти через ВлодУслуги»
// (gosuslugi.gov.bln — имя по паспорту и проверка возраста без даты рождения).
// Страница согласия — на госсайте; обмен кода на токен и userinfo — запросы сервера сайта по сети БалНета.
import crypto from 'node:crypto';
import { q, one, json } from '../../db.js';
import { bad, notFound, forbidden } from '../errors.js';
import { randomToken, withUnique } from '../ids.js';
import { normalizeUrl } from '@bln/shared/balnet-url.js';
import { ageFrom } from '@bln/shared/format.js';
import { sha256 } from './core.js';

export const PROVIDERS = {
  mail: { host: 'mail.bln', title: 'ВлодПочта', via: 'ВлодПочту', scopes: ['openid', 'profile', 'email'] },
  gov: { host: 'gosuslugi.gov.bln', title: 'ВлодУслуги', via: 'ВлодУслуги', scopes: ['openid', 'profile', 'age', 'passport'] },
};
export const SCOPE_TITLES = {
  openid: 'Знать, что это вы (постоянный идентификатор для этого сайта)',
  profile: 'Имя',
  email: 'Адрес ВлодПочты',
  age: 'Возраст: есть ли вам 14, 16, 18 и 21 год (без даты рождения)',
  passport: 'Имя по паспорту БФ и что паспорт действителен',
};
const CODE_MINUTES = 10;
const TOKEN_SECONDS = 3600;
const MAX_URIS = 10;

export const providerOf = (name) => {
  if (!PROVIDERS[name]) throw notFound('Неизвестный провайдер входа');
  return name;
};

/** Постоянный идентификатор пользователя для конкретного сайта (pairwise): сайты не могут сопоставить людей между собой. */
const pairwise = (client, provider, subject) => sha256(`${client.client_id}|${provider}|${subject}`).slice(0, 32);

function redirectList(v) {
  const list = (Array.isArray(v) ? v : String(v || '').split(/[\s,]+/)).map((s) => String(s).trim()).filter(Boolean);
  if (!list.length || list.length > MAX_URIS) throw bad('invalid_redirect', `Адреса возврата: от 1 до ${MAX_URIS}`);
  return [...new Set(list.map((u) => {
    const n = normalizeUrl(u);
    if (!n || n.startsWith('balnet://') || n.includes('#') || n.length > 500) throw bad('invalid_redirect', `Адрес возврата должен быть адресом сайта БалНета без #: ${u}`);
    return n;
  }))];
}

// ——— Приложения разработчиков ———

export function clientView(c, { secret = null } = {}) {
  return { id: c.id, client_id: c.client_id, name: c.name, site_url: c.site_url, redirect_uris: json(c.redirect_uris, []), status: c.status, created_at: c.created_at, ...(secret ? { client_secret: secret } : {}) };
}

export async function createClient(govUserId, { name, redirect_uris: uris, site_url: site = null }) {
  const title = String(name || '').trim().slice(0, 80);
  if (title.length < 2) throw bad('invalid_name', 'Название приложения — от 2 символов');
  const count = await one('SELECT COUNT(*) AS n FROM oauth_clients WHERE owner_gov_user_id = ?', [govUserId]);
  if (Number(count.n) >= 20) throw bad('too_many', 'Не больше 20 приложений');
  const secret = `cs_${randomToken(24)}`;
  const id = await withUnique(async () => {
    const r = await q('INSERT INTO oauth_clients (client_id, secret_hash, name, owner_gov_user_id, redirect_uris, site_url) VALUES (?, ?, ?, ?, ?, ?)',
      [`cl_${randomToken(12).replace(/[-_]/g, 'x')}`, sha256(secret), title, govUserId, JSON.stringify(redirectList(uris)), site ? normalizeUrl(String(site)) : null]);
    return r.insertId;
  });
  return clientView(await one('SELECT * FROM oauth_clients WHERE id = ?', [id]), { secret });
}

export async function ownClient(govUserId, id) {
  const c = await one('SELECT * FROM oauth_clients WHERE id = ? AND owner_gov_user_id = ?', [Number(id) || 0, govUserId]);
  if (!c) throw notFound('Приложение не найдено');
  return c;
}

export async function updateClient(c, b) {
  if (b.name !== undefined) await q('UPDATE oauth_clients SET name = ? WHERE id = ?', [String(b.name).trim().slice(0, 80) || c.name, c.id]);
  if (b.redirect_uris !== undefined) await q('UPDATE oauth_clients SET redirect_uris = ? WHERE id = ?', [JSON.stringify(redirectList(b.redirect_uris)), c.id]);
  if (b.site_url !== undefined) await q('UPDATE oauth_clients SET site_url = ? WHERE id = ?', [b.site_url ? normalizeUrl(String(b.site_url)) : null, c.id]);
  return clientView(await one('SELECT * FROM oauth_clients WHERE id = ?', [c.id]));
}

export async function rotateSecret(c) {
  const secret = `cs_${randomToken(24)}`;
  await q('UPDATE oauth_clients SET secret_hash = ? WHERE id = ?', [sha256(secret), c.id]);
  await q('DELETE FROM oauth_tokens WHERE client_id = ?', [c.id]);
  return clientView(c, { secret });
}

export async function deleteClient(c) {
  for (const t of ['oauth_tokens', 'oauth_codes', 'oauth_grants']) await q(`DELETE FROM ${t} WHERE client_id = ?`, [c.id]);
  await q('DELETE FROM oauth_clients WHERE id = ?', [c.id]);
}

// ——— Авторизация (страница согласия на госсайте) ———

/** Кто входит: для ВлодПочты — ящик, для ВлодУслуг — аккаунт услуг. */
async function subjectOf(provider, govUserId) {
  if (provider === 'mail') {
    const a = await one('SELECT * FROM mail_accounts WHERE gov_user_id = ?', [govUserId]);
    if (!a) throw bad('no_mailbox', 'Сначала заведите ящик ВлодПочты');
    if (a.status !== 'active') throw forbidden('Ящик заблокирован');
    return a.id;
  }
  return govUserId;
}

/** Данные пользователя по scope — то же самое увидит сайт в userinfo. */
export async function claims(provider, subjectId, scopes) {
  const out = {};
  if (provider === 'mail') {
    const a = await one('SELECT a.*, g.display_name FROM mail_accounts a JOIN gov_users g ON g.id = a.gov_user_id WHERE a.id = ?', [subjectId]);
    if (!a) return null;
    if (scopes.includes('profile')) out.name = a.name || a.display_name;
    if (scopes.includes('email')) { out.email = `${a.login}@mail.bln`; out.email_verified = true; }
    return out;
  }
  const g = await one('SELECT * FROM gov_users WHERE id = ?', [subjectId]);
  if (!g) return null;
  const c = await one('SELECT * FROM citizens WHERE gov_user_id = ?', [subjectId]);
  const passport = c ? await one("SELECT number FROM passports WHERE citizen_id = ? AND status = 'active' ORDER BY id DESC LIMIT 1", [c.id]) : null;
  if (scopes.includes('profile')) out.name = c?.full_name || g.display_name;
  if (scopes.includes('age')) {
    const age = c && passport ? ageFrom(c.birth_date) : null;
    out.age_verified = age !== null;
    for (const n of [14, 16, 18, 21]) out[`age_over_${n}`] = age !== null && age >= n;
  }
  if (scopes.includes('passport')) {
    out.passport_verified = !!passport;
    out.full_name = passport ? c.full_name : null;
  }
  return out;
}

function parseScope(provider, raw) {
  const list = [...new Set(String(raw || 'openid').split(/[\s+,]+/).filter(Boolean))];
  const bad1 = list.find((s) => !PROVIDERS[provider].scopes.includes(s));
  if (bad1) throw bad('invalid_scope', `Неизвестное разрешение: ${bad1}`);
  if (!list.includes('openid')) list.unshift('openid');
  return list;
}

/** Проверка запроса авторизации: приложение, адрес возврата, разрешения, PKCE. */
export async function checkRequest(provider, p) {
  providerOf(provider);
  if (p.response_type && p.response_type !== 'code') throw bad('unsupported_response_type', 'Поддерживается только response_type=code');
  const client = await one("SELECT * FROM oauth_clients WHERE client_id = ? AND status = 'active'", [String(p.client_id || '')]);
  if (!client) throw bad('invalid_client', 'Приложение не найдено или заблокировано');
  const uri = normalizeUrl(String(p.redirect_uri || ''));
  if (!uri || !json(client.redirect_uris, []).includes(uri)) throw bad('invalid_redirect', 'Адрес возврата не зарегистрирован у приложения');
  const scopes = parseScope(provider, p.scope);
  if (p.code_challenge && p.code_challenge_method && p.code_challenge_method !== 'S256') throw bad('invalid_request', 'PKCE: только code_challenge_method=S256');
  if (p.code_challenge && !/^[A-Za-z0-9._~-]{43,128}$/.test(String(p.code_challenge))) throw bad('invalid_request', 'Неверный code_challenge');
  return { client, uri, scopes };
}

function withParams(uri, params) {
  const u = new URL(uri);
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') u.searchParams.set(k, v);
  return u.href;
}

/** Данные для страницы согласия. */
export async function authorizeInfo(provider, govUserId, p) {
  const { client, uri, scopes } = await checkRequest(provider, p);
  const subject = await subjectOf(provider, govUserId);
  const grant = await one('SELECT scope FROM oauth_grants WHERE client_id = ? AND provider = ? AND subject_id = ?', [client.id, provider, subject]);
  const granted = grant ? grant.scope.split(' ') : [];
  return {
    provider,
    provider_title: PROVIDERS[provider].title,
    provider_via: PROVIDERS[provider].via,
    client: { name: client.name, site_url: client.site_url, redirect_host: new URL(uri).host },
    scopes: scopes.map((s) => ({ scope: s, title: SCOPE_TITLES[s] })),
    remembered: scopes.every((s) => granted.includes(s)),
    preview: await claims(provider, subject, scopes),
  };
}

/** Решение пользователя: код авторизации или error=access_denied в адресе возврата. */
export async function authorize(provider, govUserId, p, approve) {
  const { client, uri, scopes } = await checkRequest(provider, p);
  const state = p.state ? String(p.state).slice(0, 500) : undefined;
  if (!approve) return { redirect: withParams(uri, { error: 'access_denied', error_description: 'Пользователь отказался', state }) };
  const subject = await subjectOf(provider, govUserId);
  const code = randomToken(32);
  await q('INSERT INTO oauth_codes (code_hash, client_id, provider, subject_id, scope, redirect_uri, challenge, nonce, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(3) + INTERVAL ? MINUTE)',
    [sha256(code), client.id, provider, subject, scopes.join(' '), uri, p.code_challenge || null, p.nonce ? String(p.nonce).slice(0, 128) : null, CODE_MINUTES]);
  await q('INSERT INTO oauth_grants (client_id, provider, subject_id, scope, last_used_at) VALUES (?, ?, ?, ?, NOW(3)) ON DUPLICATE KEY UPDATE scope = VALUES(scope), last_used_at = NOW(3)', [client.id, provider, subject, scopes.join(' ')]);
  return { redirect: withParams(uri, { code, state }) };
}

export async function grantsOf(govUserId) {
  const mail = await one('SELECT id FROM mail_accounts WHERE gov_user_id = ?', [govUserId]);
  const rows = await q(
    `SELECT g.*, c.name, c.site_url, c.client_id AS cid FROM oauth_grants g JOIN oauth_clients c ON c.id = g.client_id
     WHERE (g.provider = 'gov' AND g.subject_id = ?) OR (g.provider = 'mail' AND g.subject_id = ?) ORDER BY g.last_used_at DESC`,
    [govUserId, mail?.id || 0],
  );
  return rows.map((r) => ({ client_id: r.cid, name: r.name, site_url: r.site_url, provider: r.provider, provider_title: PROVIDERS[r.provider].title, provider_via: PROVIDERS[r.provider].via, scopes: r.scope.split(' '), created_at: r.created_at, last_used_at: r.last_used_at }));
}

export async function revokeGrant(govUserId, clientId, provider) {
  providerOf(provider);
  const c = await one('SELECT id FROM oauth_clients WHERE client_id = ?', [String(clientId)]);
  if (!c) throw notFound('Приложение не найдено');
  const subject = provider === 'mail' ? (await one('SELECT id FROM mail_accounts WHERE gov_user_id = ?', [govUserId]))?.id : govUserId;
  await q('DELETE FROM oauth_grants WHERE client_id = ? AND provider = ? AND subject_id = ?', [c.id, provider, subject || 0]);
  await q('DELETE FROM oauth_tokens WHERE client_id = ? AND provider = ? AND subject_id = ?', [c.id, provider, subject || 0]);
}

// ——— Точки сервера (запросы сайтов по сети БалНета) ———

/** Ошибка в формате RFC 6749 §5.2. */
const oauthErr = (status, error, description) => ({ status, body: { error, error_description: description }, headers: { 'cache-control': 'no-store' } });

function parseBody(headers, body) {
  const type = String(headers['content-type'] || '');
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
  if (type.includes('application/json')) { try { return JSON.parse(text || '{}'); } catch { return {}; } }
  return Object.fromEntries(new URLSearchParams(text));
}

async function clientAuth(headers, b) {
  let id = b.client_id;
  let secret = b.client_secret;
  const basic = /^Basic\s+(\S+)$/i.exec(String(headers.authorization || ''));
  if (basic) {
    const [u, ...rest] = Buffer.from(basic[1], 'base64').toString('utf8').split(':');
    id = decodeURIComponent(u);
    secret = decodeURIComponent(rest.join(':'));
  }
  const c = id ? await one("SELECT * FROM oauth_clients WHERE client_id = ? AND status = 'active'", [String(id)]) : null;
  if (!c || !secret) return null;
  const a = Buffer.from(sha256(secret));
  const e = Buffer.from(c.secret_hash);
  return a.length === e.length && crypto.timingSafeEqual(a, e) ? c : null;
}

async function tokenEndpoint(provider, { headers, body }) {
  const b = parseBody(headers, body);
  const client = await clientAuth(headers, b);
  if (!client) return oauthErr(401, 'invalid_client', 'Неверный client_id или client_secret');
  if (b.grant_type !== 'authorization_code') return oauthErr(400, 'unsupported_grant_type', 'Поддерживается grant_type=authorization_code');
  const code = await one('SELECT * FROM oauth_codes WHERE code_hash = ?', [sha256(String(b.code || ''))]);
  if (!code || code.client_id !== client.id || code.provider !== provider) return oauthErr(400, 'invalid_grant', 'Код авторизации не найден');
  if (code.used_at) {
    // Повтор кода — признак перехвата: отзываем выданные по нему токены (RFC 6749 §4.1.2).
    await q('DELETE FROM oauth_tokens WHERE client_id = ? AND provider = ? AND subject_id = ?', [client.id, provider, code.subject_id]);
    return oauthErr(400, 'invalid_grant', 'Код авторизации уже использован');
  }
  if (new Date(code.expires_at) < new Date()) return oauthErr(400, 'invalid_grant', 'Срок кода авторизации истёк (10 минут)');
  if (normalizeUrl(String(b.redirect_uri || '')) !== code.redirect_uri) return oauthErr(400, 'invalid_grant', 'redirect_uri не совпадает с запросом авторизации');
  if (code.challenge) {
    const v = String(b.code_verifier || '');
    const h = crypto.createHash('sha256').update(v).digest('base64url');
    if (!v || h !== code.challenge) return oauthErr(400, 'invalid_grant', 'PKCE: неверный code_verifier');
  }
  const used = await q('UPDATE oauth_codes SET used_at = NOW(3) WHERE code_hash = ? AND used_at IS NULL', [code.code_hash]);
  if (!used.affectedRows) return oauthErr(400, 'invalid_grant', 'Код авторизации уже использован');
  const token = `at_${randomToken(32)}`;
  await q('INSERT INTO oauth_tokens (token_hash, client_id, provider, subject_id, scope, expires_at) VALUES (?, ?, ?, ?, ?, NOW(3) + INTERVAL ? SECOND)', [sha256(token), client.id, provider, code.subject_id, code.scope, TOKEN_SECONDS]);
  return { status: 200, headers: { 'cache-control': 'no-store' }, body: { access_token: token, token_type: 'Bearer', expires_in: TOKEN_SECONDS, scope: code.scope, sub: pairwise(client, provider, code.subject_id) } };
}

async function userinfoEndpoint(provider, { headers }) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(headers.authorization || ''));
  if (!m) return { status: 401, headers: { 'www-authenticate': 'Bearer' }, body: { error: 'invalid_token', error_description: 'Нужен заголовок Authorization: Bearer <access_token>' } };
  const t = await one('SELECT t.*, c.client_id AS cid FROM oauth_tokens t JOIN oauth_clients c ON c.id = t.client_id WHERE t.token_hash = ? AND t.provider = ?', [sha256(m[1]), provider]);
  if (!t || new Date(t.expires_at) < new Date()) return { status: 401, headers: { 'www-authenticate': 'Bearer error="invalid_token"' }, body: { error: 'invalid_token', error_description: 'Токен недействителен или истёк' } };
  const scopes = t.scope.split(' ');
  const c = await claims(provider, t.subject_id, scopes);
  if (!c) return { status: 401, body: { error: 'invalid_token', error_description: 'Пользователь удалён' } };
  return { status: 200, headers: { 'cache-control': 'no-store' }, body: { sub: pairwise({ client_id: t.cid }, provider, t.subject_id), ...c } };
}

function discovery(provider) {
  const base = `https://${PROVIDERS[provider].host}`;
  return {
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    userinfo_endpoint: `${base}/oauth/userinfo`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'client_secret_basic'],
    scopes_supported: PROVIDERS[provider].scopes,
    subject_types_supported: ['pairwise'],
  };
}

/** HTTP-запрос сервера сайта к mail.bln или gosuslugi.gov.bln. null — путь не относится к OAuth. */
export async function oauthHttp(provider, { method, path, headers, body }) {
  const p = path.split('?')[0];
  if (p === '/.well-known/openid-configuration' || p === '/.well-known/oauth-authorization-server') return method === 'GET' ? { status: 200, body: discovery(provider) } : null;
  if (p === '/oauth/token') return method === 'POST' ? tokenEndpoint(provider, { headers, body }) : oauthErr(405, 'invalid_request', 'Только POST');
  if (p === '/oauth/userinfo') return method === 'GET' || method === 'POST' ? userinfoEndpoint(provider, { headers }) : oauthErr(405, 'invalid_request', 'GET или POST');
  return null;
}
