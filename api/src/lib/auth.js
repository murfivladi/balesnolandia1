// Сессии: JWT в httpOnly cookie. Банк и Услуги — раздельные аккаунты и cookie.
// Срок жизни скользящий: каждый запрос продлевает сессию на «время бездействия».
import jwt from 'jsonwebtoken';
import bcrypt from 'bcryptjs';
import { config } from '../config.js';
import { one, q } from '../db.js';
import { unauthorized, forbidden } from './errors.js';
import { getSetting } from './settings.js';

export const COOKIE = { bank: 'bln_bank', gov: 'bln_gov', pos: 'bln_pos' };
const POS_SESSION_MINUTES = 12 * 60;

export const hash = (secret) => bcrypt.hash(String(secret), 10);
export const verifyHash = (secret, h) => (h ? bcrypt.compare(String(secret), h) : Promise.resolve(false));

function cookieOpts(maxAgeSec) {
  return {
    httpOnly: true,
    secure: config.cookieSecure,
    sameSite: 'lax',
    path: '/',
    domain: config.cookieDomain,
    maxAge: maxAgeSec,
  };
}

async function ttlMinutes(kind) {
  if (kind === 'pos') return POS_SESSION_MINUTES;
  return Number(await getSetting('idle_minutes')) || 10;
}

export async function issue(reply, kind, payload) {
  const minutes = await ttlMinutes(kind);
  const token = jwt.sign({ ...payload, k: kind }, config.jwtSecret, { expiresIn: minutes * 60 });
  reply.setCookie(COOKIE[kind], token, cookieOpts(minutes * 60));
}

export function clear(reply, kind) {
  reply.clearCookie(COOKIE[kind], { path: '/', domain: config.cookieDomain });
}

export function readToken(req, kind) {
  const raw = req.cookies?.[COOKIE[kind]];
  if (!raw) return null;
  try {
    const p = jwt.verify(raw, config.jwtSecret);
    return p.k === kind ? p : null;
  } catch {
    return null;
  }
}

export async function rolesOf(kind, id, conn) {
  const rows = await q('SELECT role FROM user_roles WHERE user_kind = ? AND user_id = ?', [kind, id], conn);
  return rows.map((r) => r.role);
}

/** Загрузить сессию нужного типа (кешируется на запросе). */
export async function session(req, kind) {
  req.__sess ??= {};
  if (kind in req.__sess) return req.__sess[kind];
  const p = readToken(req, kind);
  let s = null;
  if (p) {
    const table = kind === 'bank' ? 'bank_users' : 'gov_users';
    const user = await one(`SELECT * FROM ${table} WHERE id = ?`, [p.id]);
    if (user && user.status !== 'blocked' && user.status !== 'rejected') {
      s = { kind, id: user.id, user, roles: await rolesOf(kind, user.id), token: p };
    }
  }
  if (!s && req.headers?.authorization) {
    const { tokenSession } = await import('./apitokens.js');
    s = await tokenSession(req, kind);
  }
  req.__sess[kind] = s;
  return s;
}

/** Продлить cookie, если сессия жива (скользящее окно бездействия). */
async function touch(req, reply, s) {
  if (s.api) return;
  const age = Date.now() / 1000 - (s.token.iat || 0);
  if (age > 20) {
    await issue(reply, s.kind, { id: s.id });
    if (age > 60) q(`UPDATE ${s.kind === 'bank' ? 'bank_users' : 'gov_users'} SET last_seen_at = NOW(3) WHERE id = ?`, [s.id]).catch(() => {});
  }
}

export function needBank({ active = false } = {}) {
  return async (req, reply) => {
    const s = await session(req, 'bank');
    if (!s) throw unauthorized();
    if (active && s.user.status !== 'active') throw forbidden('Аккаунт ещё не одобрен');
    req.bank = s;
    await touch(req, reply, s);
  };
}

export function needGov() {
  return async (req, reply) => {
    const s = await session(req, 'gov');
    if (!s) throw unauthorized();
    req.gov = s;
    await touch(req, reply, s);
  };
}

/** Роль на любом из аккаунтов (банк или услуги). Кладёт найденную сессию в req.actor. */
export function needRole(...roles) {
  return async (req, reply) => {
    for (const kind of ['gov', 'bank']) {
      const s = await session(req, kind);
      if (s && (s.roles.includes('admin') || s.roles.some((r) => roles.includes(r)))) {
        req.actor = s;
        req[kind] = s;
        await touch(req, reply, s);
        return;
      }
    }
    const any = (await session(req, 'gov')) || (await session(req, 'bank'));
    throw any ? forbidden() : unauthorized();
  };
}

export const needAdmin = () => needRole('admin');

/** Кто совершает действие — для журнала и проводок. */
export const actorOf = (s) => (s ? { kind: s.kind, id: s.id } : null);

export async function ensureBootstrapAdmin(kind, user, conn) {
  if (config.adminEmails.includes(String(user.email).toLowerCase())) {
    await q('INSERT IGNORE INTO user_roles (user_kind, user_id, role, granted_by) VALUES (?, ?, ?, ?)', [kind, user.id, 'admin', 'env'], conn);
  }
}

/** Сессия кассы: магазин + сотрудник, после входа банком и PIN кассира.
 *  Живёт дольше банковской (12 ч), чтобы касса не выходила посреди смены. */
export async function posSession(req) {
  const p = readToken(req, 'pos');
  if (!p) return null;
  const user = await one('SELECT * FROM bank_users WHERE id = ?', [p.uid]);
  if (!user || user.status !== 'active') return null;
  const staff = await one('SELECT s.*, sh.status AS shop_status FROM shop_staff s JOIN shops sh ON sh.id = s.shop_id WHERE s.id = ? AND s.active = 1', [p.staff]);
  if (!staff || staff.shop_status !== 'active' || staff.bank_user_id !== user.id) return null;
  return { staff, shopId: staff.shop_id, token: p, bank: { kind: 'bank', id: user.id, user, roles: await rolesOf('bank', user.id) } };
}

export function needPos({ owner = false } = {}) {
  return async (req, reply) => {
    const s = await posSession(req);
    if (!s) throw unauthorized('Войдите в кассу');
    if (owner && s.staff.role !== 'owner') throw forbidden('Только для владельца магазина');
    req.pos = s;
    if (Date.now() / 1000 - (s.token.iat || 0) > 300) await issue(reply, 'pos', { uid: s.bank.id, staff: s.staff.id });
  };
}
