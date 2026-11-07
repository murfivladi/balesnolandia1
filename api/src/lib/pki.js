// Удостоверяющие центры БалНета (этап Н5): корни и промежуточные УЦ, выпуск сертификатов DV/OV/EV и самоподписанных,
// проверка домена (DNS-01, HTTP-01) и записей CAA, журнал прозрачности (CT) с подписанными отметками (SCT),
// статус отзыва (OCSP, «скрепляется» сервером), установка на сайты хостинга и автопродление.
// Криптография настоящая: ECDSA P-256 (shared/balnet-pki.js). Время — игровые секунды.
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { q, one, tx } from '../db.js';
import { notFound, forbidden, need } from './errors.js';
import { getSettings } from './settings.js';
import { gameSeconds, currentMonth, onMonth } from './clock.js';
import { createInvoice, onInvoicePaid } from './gov.js';
import { notify } from './notify.js';
import { orgRole, hasLicense } from './orgs.js';
import { resolve } from './dns.js';
import { netSnapshot, connect } from './net.js';
import { siteDir, safeJoin } from './sitefs.js';
import { generateKey, signWith, keyId, certHash, sha256Hex, nameMatches } from '@bln/shared/balnet-pki.js';
import { fqdn } from '@bln/shared/balnet-dns.js';
import { GOV_SITES, SEARCH_HOST } from '@bln/shared/balnet-url.js';
import { vatIncluded, formatMoney } from '@bln/shared/money.js';

export const MONTH = 30 * 86400;
const YEAR = 12 * MONTH;
export const GOV_CA_ID = 'ca.gov.bln';
/** Откуда УЦ проверяет домены: его сервер и публичный резолвер ВлодDNS (без кэша). */
const CA_VANTAGE = { clientIp: '50.1.0.10', resolverIp: '50.0.0.53' };
export const POLICIES = { DV: 'Проверка домена (DV)', OV: 'Проверка организации (OV)', EV: 'Расширенная проверка (EV)', self: 'Самоподписанный' };
export const REVOKE_REASONS = { unspecified: 'Без причины', keyCompromise: 'Ключ скомпрометирован', superseded: 'Заменён новым', cessationOfOperation: 'Сайт закрыт', affiliationChanged: 'Сменился владелец' };
const CHALLENGE_LABEL = '_balnet-challenge';
const WELL_KNOWN = '.well-known/balnet-challenge';

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const serial = () => crypto.randomBytes(12).toString('hex');
const disp = (n) => String(n).replace(/\.$/, '');

// ——— Инициализация: корень, БалСерт, журнал прозрачности, сертификаты госсайтов ———

let initP = null;
/** Ключи создаются один раз при первом обращении (в базе — только таблицы из миграции). */
export function ensurePki() {
  if (!initP) initP = init().catch((e) => { initP = null; throw e; });
  return initP;
}
export function resetPkiCache() {
  initP = null;
  ocspCache.clear();
  trustCache = null;
}

async function init() {
  const now = await gameSeconds();
  await tx(async (conn) => {
    await one("SELECT GET_LOCK('balnet_pki_init', 20) AS l", [], conn);
    try {
      if (!(await one("SELECT id FROM pki_cas WHERE kind = 'root' AND org_id IS NULL LIMIT 1", [], conn))) {
        const root = await makeCa(conn, { kind: 'root', name: 'Корневой УЦ БалНета', o: 'Координационный центр БалНета', years: 25, now, trusted: 1 });
        await makeCa(conn, { kind: 'ca', name: 'БалСерт', o: 'Координационный центр БалНета', identifier: GOV_CA_ID, parent: root, years: 8, now });
      }
      if (!(await one('SELECT id FROM pki_ct_logs LIMIT 1', [], conn))) {
        const k = await generateKey();
        await q('INSERT INTO pki_ct_logs (log_id, name, spki, pkcs8) VALUES (?, ?, ?, ?)', [await keyId(k.spki), 'Журнал прозрачности БалНета «Аргон»', k.spki, k.pkcs8], conn);
      }
    } finally {
      await one("SELECT RELEASE_LOCK('balnet_pki_init') AS l", [], conn);
    }
  });
  await renewGovCerts(now);
}

async function makeCa(conn, { kind, name, o, identifier = null, parent = null, years, now, trusted = 0, orgId = null }) {
  const k = await generateKey();
  const ski = await keyId(k.spki);
  const subject = { cn: name, o, c: 'БФ' };
  const p = parent ? { ...parent, cert: parse(parent.cert) } : null;
  const tbs = {
    v: 1, serial: serial(), issuer: p ? p.cert.tbs.subject : subject, subject, san: [],
    nb: Math.max(0, now - MONTH), na: now + years * YEAR, spki: k.spki, ski, aki: p ? p.ski : ski, ca: true,
    path_len: kind === 'root' ? 1 : 0, policy: kind === 'root' ? 'root' : 'ca',
  };
  const cert = { tbs, sig: await signWith(p ? p.pkcs8 : k.pkcs8, tbs) };
  const prices = kind === 'ca' && orgId ? { DV: 0, OV: 3000, EV: 15000 } : null;
  const r = await q('INSERT INTO pki_cas (org_id, parent_id, kind, name, identifier, cert, pkcs8, trusted, prices, ski) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    orgId, p?.id || null, kind, name, identifier, JSON.stringify(cert), k.pkcs8, trusted, prices ? JSON.stringify(prices) : null, ski,
  ], conn);
  trustCache = null;
  return one('SELECT * FROM pki_cas WHERE id = ?', [r.insertId], conn);
}

/** Хранилище доверия браузера: корни, журналы CT, отозванные УЦ. Как обновления Chrome — раздаётся всем. */
let trustCache = null;
export async function trustStore() {
  await ensurePki();
  if (trustCache && Date.now() - trustCache.at < 5000) return trustCache.value;
  const roots = await q("SELECT name, cert FROM pki_cas WHERE kind = 'root' AND trusted = 1 AND status = 'active' ORDER BY id");
  const logs = await q('SELECT log_id, name, spki FROM pki_ct_logs ORDER BY id');
  const revoked = await q("SELECT ski FROM pki_cas WHERE status = 'revoked' OR (parent_id IN (SELECT id FROM pki_cas WHERE status = 'revoked'))");
  const value = {
    roots: roots.map((r) => ({ name: r.name, spki: parse(r.cert).tbs.spki })),
    ct_logs: logs,
    revoked_cas: revoked.map((r) => r.ski),
  };
  trustCache = { at: Date.now(), value };
  return value;
}

// ——— CAA ———

function parseCaa(data) {
  const m = /^(\d+)\s+([a-z0-9]+)\s+"(.*)"$/i.exec(String(data).trim());
  return m ? { flags: Number(m[1]), tag: m[2].toLowerCase(), value: m[3].trim() } : null;
}

const fresh = (name, type) => resolve({ ...CA_VANTAGE, clientProviderId: null, name, type, fresh: true });

/**
 * Проверка CAA (RFC 8659): от имени вверх до первой найденной записи CAA. Для «*.» — сначала issuewild.
 * Нет записей — выпускать можно любому УЦ. Возвращает { ok, at, records }.
 */
export async function checkCaa(name, identifier) {
  const wildcard = name.startsWith('*.');
  let cur = fqdn(wildcard ? name.slice(2) : name);
  while (cur && cur !== '.') {
    const r = await fresh(cur, 'CAA');
    if (r.rcode === 'SERVFAIL' || r.rcode === 'TIMEOUT') return { ok: false, at: cur, error: 'Не удалось получить записи CAA (SERVFAIL)' };
    const set = r.answer.filter((x) => x.type === 'CAA').map((x) => parseCaa(x.data)).filter(Boolean);
    if (set.length) {
      if (set.some((x) => x.flags & 128 && !['issue', 'issuewild', 'iodef'].includes(x.tag))) return { ok: false, at: cur, error: 'Критичный неизвестный тег CAA' };
      let rel = wildcard ? set.filter((x) => x.tag === 'issuewild') : [];
      if (!rel.length) rel = set.filter((x) => x.tag === 'issue');
      if (!rel.length) return { ok: true, at: cur };
      const ok = rel.some((x) => x.value.split(';')[0].trim().toLowerCase() === identifier.toLowerCase());
      return { ok, at: cur, records: rel.map((x) => x.value), error: ok ? null : `CAA домена ${disp(cur)} разрешает выпуск только: ${rel.map((x) => x.value || '«никому»').join(', ')}` };
    }
    cur = cur.slice(cur.indexOf('.') + 1) || '.';
  }
  return { ok: true, at: null };
}

// ——— Проверка домена ———

export function normalizeNames(list) {
  const arr = (Array.isArray(list) ? list : String(list || '').split(/[\s,]+/)).map((x) => String(x).trim().toLowerCase().replace(/\.$/, '')).filter(Boolean);
  need(arr.length >= 1 && arr.length <= 10, 'Укажите от 1 до 10 имён');
  for (const n of arr) {
    const base = n.startsWith('*.') ? n.slice(2) : n;
    need(fqdn(base) && base.includes('.') && !base.includes('*'), `Неверное имя: ${n}`);
  }
  return [...new Set(arr)];
}

export async function createChallenge(conn, { govUserId, names, method }) {
  const list = normalizeNames(names);
  need(method === 'dns' || method === 'http', 'Способ проверки: dns или http');
  if (method === 'http') need(!list.some((n) => n.startsWith('*.')), 'Сертификат на «*.» проверяется только через DNS (запись TXT)');
  const token = crypto.randomBytes(18).toString('base64url');
  const r = await q('INSERT INTO pki_challenges (gov_user_id, names, method, token) VALUES (?, ?, ?, ?)', [govUserId, JSON.stringify(list), method, token], conn);
  return challengeView({ id: r.insertId, names: list, method, token, status: 'pending' });
}

export function challengeView(c) {
  const names = parse(c.names);
  const bases = [...new Set(names.map((n) => (n.startsWith('*.') ? n.slice(2) : n)))];
  return {
    id: c.id, names, method: c.method, token: c.token, status: c.status,
    steps: c.method === 'dns'
      ? bases.map((b) => ({ name: b, record: `${CHALLENGE_LABEL}.${b}`, type: 'TXT', value: c.token }))
      : bases.map((b) => ({ name: b, url: `http://${b}/${WELL_KNOWN}/${c.token}`, file: `${WELL_KNOWN}/${c.token}`, value: c.token })),
  };
}

/** HTTP-01: УЦ сам заходит на http://имя/.well-known/… со своего сервера, как настоящий. */
async function httpFetch(name, file) {
  const dns = await fresh(name, 'A');
  const ip = [...dns.answer].reverse().find((r) => r.type === 'A')?.data;
  if (!ip) return { error: `${name}: нет A-записи (${dns.rcode})` };
  const conn = connect(await netSnapshot(), CA_VANTAGE.clientIp, ip, name);
  if (!conn.ok) return { error: `${name}: сервер ${ip} ответил ${conn.code}` };
  if (!conn.target.startsWith('site:')) return { error: `${name}: на ${ip} не сайт хостинга` };
  const s = await one('SELECT s.*, a.status AS account_status FROM hosting_sites s JOIN hosting_accounts a ON a.id = s.account_id WHERE s.id = ?', [Number(conn.target.slice(5))]);
  if (!s || s.account_status !== 'active') return { error: `${name}: сайт не работает` };
  try {
    return { body: (await fs.readFile(safeJoin(siteDir(s.account_id, s.host), file).full, 'utf8')).trim(), site: s };
  } catch {
    return { error: `${name}: файл /${file} не найден (404)` };
  }
}

/** Проверить все имена заявки. Возвращает { ok, results: [{ name, ok, error }] }. */
export async function validateChallenge(c, identifier) {
  const v = challengeView(c);
  const results = [];
  for (const step of v.steps) {
    let ok = false;
    let error = null;
    if (c.method === 'dns') {
      const r = await fresh(step.record, 'TXT');
      const vals = r.answer.filter((x) => x.type === 'TXT').map((x) => String(x.data).replace(/^"|"$/g, ''));
      ok = vals.includes(c.token);
      if (!ok) error = vals.length ? `TXT ${step.record}: другое значение` : `TXT ${step.record} не найдена (${r.rcode})`;
    } else {
      const r = await httpFetch(step.name, step.file);
      ok = r.body === c.token;
      if (!ok) error = r.error || `http://${step.name}/${step.file}: другое содержимое`;
    }
    results.push({ name: step.name, ok, error });
  }
  for (const n of v.names) {
    const caa = await checkCaa(n, identifier);
    if (!caa.ok) results.push({ name: n, ok: false, error: caa.error, caa: true });
  }
  return { ok: results.every((r) => r.ok), results };
}

// ——— Выпуск ———

async function caById(conn, id) {
  const ca = await one("SELECT * FROM pki_cas WHERE id = ? AND kind = 'ca'", [id], conn);
  if (!ca) throw notFound('Удостоверяющий центр не найден');
  return ca;
}

export async function govCa(conn) {
  await ensurePki();
  return one('SELECT * FROM pki_cas WHERE identifier = ? AND org_id IS NULL', [GOV_CA_ID], conn);
}

async function caPrices(ca) {
  if (ca.org_id) return parse(ca.prices) || { DV: 0, OV: 0, EV: 0 };
  const s = await getSettings();
  return { DV: 0, OV: Number(s.cert_ov_price || 0), EV: Number(s.cert_ev_price || 0) };
}

async function caMonths(policy) {
  const s = await getSettings();
  return policy === 'DV' ? Number(s.cert_dv_months || 3) : Number(s.cert_paid_months || 12);
}

/** Подписать сертификат, записать в CT, сохранить. subject.o — для OV/EV. */
export async function issueCert(conn, { ca, names, policy, subject = {}, ownerGov = null, ownerOrg = null, autoRenew = false, method = null, govSite = false, months = null }) {
  const now = await gameSeconds();
  const k = await generateKey();
  const caCert = parse(ca.cert);
  const m = months || (await caMonths(policy));
  const tbs = {
    v: 1, serial: serial(), issuer: caCert.tbs.subject, subject: { cn: names[0], ...subject }, san: names,
    nb: Math.max(0, now - 3600), na: Math.min(now + m * MONTH, caCert.tbs.na), spki: k.spki, ski: await keyId(k.spki), aki: ca.ski, ca: false, policy,
  };
  const cert = { tbs, sig: await signWith(ca.pkcs8, tbs) };
  const r = await q(
    'INSERT INTO pki_certs (serial, ca_id, owner_gov_user_id, owner_org_id, policy, names, cert, pkcs8, nb, na, auto_renew, method, gov_site) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [tbs.serial, ca.id, ownerGov, ownerOrg, policy, JSON.stringify(names), JSON.stringify(cert), k.pkcs8, tbs.nb, tbs.na, autoRenew ? 1 : 0, method, govSite ? 1 : 0],
    conn,
  );
  const sct = await logCert(conn, r.insertId, cert, ca.name, now);
  await q('UPDATE pki_certs SET sct = ? WHERE id = ?', [JSON.stringify(sct), r.insertId], conn);
  return r.insertId;
}

/** Журнал прозрачности: запись с цепочкой хешей (только дописывается) и подписанная отметка SCT. */
async function logCert(conn, certId, cert, issuerName, now) {
  const log = await one('SELECT * FROM pki_ct_logs ORDER BY id LIMIT 1 FOR UPDATE', [], conn);
  const prev = await one('SELECT entry_hash FROM pki_ct_entries WHERE log_id = ? ORDER BY idx DESC LIMIT 1', [log.log_id], conn);
  const hash = await certHash(cert);
  const prevHash = prev?.entry_hash || '0'.repeat(64);
  const entryHash = await sha256Hex(`${prevHash}|${hash}|${now}`);
  const r = await q('INSERT INTO pki_ct_entries (log_id, cert_id, cert_hash, prev_hash, entry_hash, ts, names, issuer) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    log.log_id, certId, hash, prevHash, entryHash, now, cert.tbs.san.join(' ').slice(0, 2000), issuerName,
  ], conn);
  const body = { log_id: log.log_id, index: r.insertId, ts: now, cert_hash: hash };
  return { ...body, sig: await signWith(log.pkcs8, body) };
}

/** Самоподписанный: кто угодно, на любые имена, без проверки и без журнала — браузер ему не доверяет. */
export async function selfSigned(conn, { govUserId, names, ownerOrg = null }) {
  const list = normalizeNames(names);
  const now = await gameSeconds();
  const k = await generateKey();
  const ski = await keyId(k.spki);
  const subject = { cn: list[0] };
  const tbs = { v: 1, serial: serial(), issuer: subject, subject, san: list, nb: now, na: now + YEAR, spki: k.spki, ski, aki: ski, ca: false, policy: 'self' };
  const cert = { tbs, sig: await signWith(k.pkcs8, tbs) };
  const r = await q('INSERT INTO pki_certs (serial, ca_id, owner_gov_user_id, owner_org_id, policy, names, cert, pkcs8, nb, na) VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)', [
    tbs.serial, ownerOrg ? null : govUserId, ownerOrg, 'self', JSON.stringify(list), JSON.stringify(cert), k.pkcs8, tbs.nb, tbs.na,
  ], conn);
  return r.insertId;
}

/** Субъект OV/EV: организация проверяется по госреестру (nalog.gov.bln). */
async function orgSubject(conn, { orgId, govUserId, policy }) {
  need(orgId, 'Для OV и EV нужна организация-владелец');
  const org = await one("SELECT * FROM organizations WHERE id = ? AND status = 'active'", [orgId], conn);
  if (!org) throw notFound('Организация не найдена в реестре');
  const role = await orgRole(conn, orgId, govUserId);
  if (!role) throw forbidden('Вы не сотрудник этой организации');
  if (policy === 'EV') need(role === 'director', 'Сертификат EV заказывает только директор организации');
  const kinds = { llc: 'ООО', jsc: 'АО', gov: '' };
  const o = `${kinds[org.kind] ? `${kinds[org.kind]} ` : ''}«${org.name}»`.replace(/^«(.*)»$/, '$1');
  return policy === 'EV' ? { o, c: 'БФ', inn: org.inn, jurisdiction: 'Балесноландская Федерация' } : { o, c: 'БФ' };
}

/**
 * Заказ сертификата: проверка домена по заявке challenge_id, CAA, организации; DV бесплатно — сразу,
 * платный — квитанция (выпуск после оплаты). Возвращает { cert_id } или { order_id, invoice, amount }.
 */
export async function orderCert(conn, { govUserId, challengeId, caId, policy, ownerOrgId = null, autoRenew = false }) {
  need(['DV', 'OV', 'EV'].includes(policy), 'Вид сертификата: DV, OV или EV');
  const c = await one('SELECT * FROM pki_challenges WHERE id = ? AND gov_user_id = ?', [challengeId, govUserId], conn);
  if (!c) throw notFound('Заявка на проверку не найдена');
  need(c.status === 'pending', 'Эта проверка уже использована — создайте новую');
  const ca = caId ? await caById(conn, caId) : await govCa(conn);
  need(ca.status === 'active', 'Этот УЦ отозван');
  if (ca.org_id) need(await hasLicense(conn, ca.org_id, 'ca', await currentMonth(conn)), 'У этого УЦ нет действующей лицензии');
  if (ownerOrgId && policy === 'DV' && !(await orgRole(conn, ownerOrgId, govUserId))) throw forbidden('Вы не сотрудник этой организации');
  const subject = policy === 'DV' ? {} : await orgSubject(conn, { orgId: ownerOrgId, govUserId, policy });
  const v = await validateChallenge(c, ca.identifier || '');
  if (!v.ok) return { ok: false, results: v.results };
  await q("UPDATE pki_challenges SET status = 'used' WHERE id = ?", [c.id], conn);
  const price = Number((await caPrices(ca))[policy] || 0);
  if (price <= 0) {
    const id = await issueCert(conn, { ca, names: parse(c.names), policy, subject, ownerGov: ownerOrgId ? null : govUserId, ownerOrg: ownerOrgId, autoRenew, method: c.method });
    return { ok: true, cert_id: id, results: v.results };
  }
  const o = await q('INSERT INTO pki_orders (gov_user_id, owner_org_id, ca_id, challenge_id, policy, amount) VALUES (?, ?, ?, ?, ?, ?)', [govUserId, ownerOrgId, ca.id, c.id, policy, price], conn);
  const citizen = await one('SELECT id FROM citizens WHERE gov_user_id = ?', [govUserId], conn);
  const splits = ca.org_id ? await orgSplits(conn, ca.org_id, price) : null;
  const inv = await createInvoice(conn, {
    citizenId: citizen?.id || null, govUserId, kind: 'other', purpose: `Сертификат ${policy} (${ca.name}): ${parse(c.names).join(', ')}`.slice(0, 200),
    amount: price, ref: { type: 'cert_order', id: o.insertId }, splits,
  });
  await q('UPDATE pki_orders SET invoice_id = ? WHERE id = ?', [inv.id, o.insertId], conn);
  await notify(conn, 'gov', govUserId, { title: `Оплатите сертификат: ${formatMoney(price)}`, body: `Квитанция ${inv.number}`, link: '#/invoices' });
  return { ok: true, order_id: o.insertId, invoice: inv.number, amount: price, results: v.results };
}

async function orgSplits(conn, orgId, total) {
  const s = await getSettings();
  const vat = vatIncluded(total, Number(s.vat_bp || 0));
  const acc = (await one('SELECT account_id FROM organizations WHERE id = ?', [orgId], conn))?.account_id;
  return [{ account: acc, amount: total - vat }, { account: null, amount: vat }];
}

onInvoicePaid('cert_order', async (conn, inv) => {
  const o = await one("SELECT * FROM pki_orders WHERE id = ? AND status = 'pending' FOR UPDATE", [inv.ref_id], conn);
  if (!o) return;
  const c = await one('SELECT * FROM pki_challenges WHERE id = ?', [o.challenge_id], conn);
  const caRow = await one('SELECT * FROM pki_cas WHERE id = ?', [o.ca_id], conn);
  const subject = await orgSubject(conn, { orgId: o.owner_org_id, govUserId: o.gov_user_id, policy: o.policy });
  const id = await issueCert(conn, { ca: caRow, names: parse(c.names), policy: o.policy, subject, ownerOrg: o.owner_org_id, method: c.method });
  await q("UPDATE pki_orders SET status = 'done', cert_id = ? WHERE id = ?", [id, o.id], conn);
  await notify(conn, 'gov', o.gov_user_id, { title: `Сертификат ${o.policy} выпущен`, body: parse(c.names).join(', '), link: '#/certs' });
});

// ——— Просмотр, отзыв, установка ———

export async function canManageCert(conn, cert, govUserId) {
  if (cert.owner_gov_user_id && Number(cert.owner_gov_user_id) === Number(govUserId)) return true;
  if (cert.owner_org_id && (await orgRole(conn, cert.owner_org_id, govUserId))) return true;
  return false;
}

export async function ownCert(conn, id, govUserId) {
  const c = await one('SELECT * FROM pki_certs WHERE id = ?', [id], conn);
  if (!c || !(await canManageCert(conn, c, govUserId))) throw notFound('Сертификат не найден');
  return c;
}

export async function certView(conn, c, { now = null } = {}) {
  const t = now ?? (await gameSeconds());
  const cert = parse(c.cert);
  const ca = c.ca_id ? await one('SELECT name, org_id FROM pki_cas WHERE id = ?', [c.ca_id], conn) : null;
  const sites = await q('SELECT s.id, s.host, s.account_id FROM hosting_sites s WHERE s.cert_id = ?', [c.id], conn);
  return {
    id: c.id, serial: c.serial, policy: c.policy, policy_title: POLICIES[c.policy], names: parse(c.names), issuer: ca?.name || 'самоподписанный',
    subject: cert.tbs.subject, nb: Number(c.nb), na: Number(c.na), now: t, days_left: Math.floor((Number(c.na) - t) / 86400),
    status: c.status === 'revoked' ? 'revoked' : t > Number(c.na) ? 'expired' : 'valid', revoked_reason: c.revoked_reason,
    auto_renew: !!c.auto_renew, replaced_by: c.replaced_by, owner_org_id: c.owner_org_id, ct_index: parse(c.sct)?.index ?? null,
    sites, cert, created_at: c.created_at,
  };
}

export async function revokeCert(conn, cert, reason = 'unspecified') {
  need(REVOKE_REASONS[reason], 'Неизвестная причина отзыва');
  need(cert.status !== 'revoked', 'Сертификат уже отозван');
  need(cert.policy !== 'self', 'Самоподписанный сертификат некому отзывать — просто удалите его с сайта');
  await q("UPDATE pki_certs SET status = 'revoked', revoked_reason = ?, revoked_at = ?, auto_renew = 0 WHERE id = ?", [reason, await gameSeconds(), cert.id], conn);
  ocspCache.delete(cert.serial);
}

/** Установить сертификат на сайт хостинга (как в панели: любой свой сертификат, даже неподходящий). */
export async function installCert(conn, { site, certId, govUserId }) {
  if (certId === null) {
    await q('UPDATE hosting_sites SET cert_id = NULL WHERE id = ?', [site.id], conn);
    return;
  }
  const c = await ownCert(conn, certId, govUserId);
  need(c.status !== 'revoked', 'Сертификат отозван — установить нельзя');
  await q('UPDATE hosting_sites SET cert_id = ? WHERE id = ?', [c.id, site.id], conn);
}

/** Бесплатный SSL в панели хостинга: панель сама кладёт файл проверки, БалСерт проверяет HTTP-01, ставит и продлевает. */
export async function autoSsl(conn, { site, account, govUserId }) {
  need(account.status === 'active', 'Хостинг не оплачен');
  const names = [site.host];
  const www = `www.${site.host}`;
  const wwwSite = await one('SELECT id FROM hosting_sites WHERE account_id = ? AND host = ?', [account.id, www], conn);
  const ca = await govCa(conn);
  const tryNames = wwwSite || site.host.startsWith('www.') ? names : [...names, www];
  let result = null;
  for (const list of [tryNames, names]) {
    const ch = await createChallenge(conn, { govUserId, names: list, method: 'http' });
    const row = await one('SELECT * FROM pki_challenges WHERE id = ?', [ch.id], conn);
    await placeTokens(account, site, row);
    const v = await validateChallenge(row, GOV_CA_ID);
    await removeTokens(account, site, row);
    if (v.ok) {
      await q("UPDATE pki_challenges SET status = 'used' WHERE id = ?", [row.id], conn);
      const id = await issueCert(conn, { ca, names: list, policy: 'DV', ownerGov: account.owner_org_id ? null : govUserId, ownerOrg: account.owner_org_id, autoRenew: true, method: 'auto' });
      const old = site.cert_id;
      await q('UPDATE hosting_sites SET cert_id = ? WHERE id = ?', [id, site.id], conn);
      if (old) await q('UPDATE pki_certs SET replaced_by = ?, auto_renew = 0 WHERE id = ?', [id, old], conn);
      return { ok: true, cert_id: id, names: list, results: v.results };
    }
    result = v;
    if (list.length === 1) break;
  }
  return { ok: false, results: result.results };
}

async function placeTokens(account, site, ch) {
  // Файл проверки кладётся в каталог сайта, на который реально указывает DNS имени (сайт или www-сайт хостинга).
  for (const s of await q('SELECT * FROM hosting_sites WHERE account_id = ?', [account.id])) {
    const dir = path.join(siteDir(account.id, s.host), WELL_KNOWN);
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(path.join(dir, ch.token), ch.token);
  }
  void site;
}

async function removeTokens(account, site, ch) {
  for (const s of await q('SELECT * FROM hosting_sites WHERE account_id = ?', [account.id])) {
    await fs.rm(path.join(siteDir(account.id, s.host), WELL_KNOWN, ch.token), { force: true });
    await fs.rmdir(path.join(siteDir(account.id, s.host), WELL_KNOWN)).catch(() => {});
    await fs.rmdir(path.join(siteDir(account.id, s.host), '.well-known')).catch(() => {});
  }
  void site;
}

// ——— TLS при открытии сайта ———

const ocspCache = new Map(); // serial → { staple, until }

/** Ответ OCSP, подписанный выпустившим УЦ. Сервер «скрепляет» его к рукопожатию. */
async function ocspFor(cert, now) {
  if (!cert.ca_id) return null;
  const hit = ocspCache.get(cert.serial);
  if (hit && hit.until > now && hit.status === cert.status) return hit.staple;
  const ca = await one('SELECT pkcs8 FROM pki_cas WHERE id = ?', [cert.ca_id]);
  const body = { serial: cert.serial, status: cert.status === 'revoked' ? 'revoked' : 'good', reason: cert.status === 'revoked' ? cert.revoked_reason : null, this_update: now };
  const staple = { ...body, sig: await signWith(ca.pkcs8, body) };
  if (ocspCache.size > 2000) ocspCache.clear();
  ocspCache.set(cert.serial, { staple, until: now + 86400, status: cert.status });
  return staple;
}

async function chainOf(cert) {
  const chain = [parse(cert.cert)];
  let caId = cert.ca_id;
  for (let i = 0; caId && i < 4; i++) {
    const ca = await one('SELECT kind, parent_id, cert FROM pki_cas WHERE id = ?', [caId]);
    if (!ca) break;
    if (ca.kind === 'root') break; // корень браузер берёт из своего хранилища
    chain.push(parse(ca.cert));
    caId = ca.parent_id;
  }
  return chain;
}

/** Что сервер предъявляет при https: для госсайта — его сертификат, для сайта игрока — установленный в панели. */
export async function tlsFor({ target, host }) {
  await ensurePki();
  const now = await gameSeconds();
  let cert = null;
  if (target.startsWith('site:')) {
    cert = await one('SELECT c.* FROM hosting_sites s JOIN pki_certs c ON c.id = s.cert_id WHERE s.id = ?', [Number(target.slice(5))]);
  } else {
    const rows = await q("SELECT * FROM pki_certs WHERE gov_site = 1 AND status = 'valid' AND replaced_by IS NULL ORDER BY id DESC");
    cert = rows.find((r) => parse(r.names).some((n) => nameMatches(n, host))) || null;
  }
  if (!cert) return null;
  return { chain: await chainOf(cert), sct: parse(cert.sct) || undefined, ocsp: (await ocspFor(cert, now)) || undefined, time: now };
}

// ——— Госсайты и продление ———

const GOV_CERTS = () => {
  const hosts = [...new Set([...Object.keys(GOV_SITES), SEARCH_HOST])];
  return hosts.map((h) => ({ names: [h, `www.${h}`], policy: h.endsWith('bank.bln') ? 'EV' : 'OV', o: h.endsWith('bank.bln') ? 'ВлодБанк' : GOV_SITES[h]?.owner || 'Координационный центр БалНета' }));
};

/** Сертификаты госсайтов: выпуск при старте и перевыпуск за 2 игровых месяца до конца. */
export async function renewGovCerts(now) {
  const t = now ?? (await gameSeconds());
  await tx(async (conn) => {
    const ca = await one('SELECT * FROM pki_cas WHERE identifier = ? AND org_id IS NULL', [GOV_CA_ID], conn);
    if (!ca) return;
    const have = await q("SELECT * FROM pki_certs WHERE gov_site = 1 AND status = 'valid' AND replaced_by IS NULL FOR UPDATE", [], conn);
    for (const g of GOV_CERTS()) {
      const cur = have.find((c) => parse(c.names)[0] === g.names[0]);
      if (cur && Number(cur.na) - t > 2 * MONTH) continue;
      const subject = g.policy === 'EV' ? { o: g.o, c: 'БФ', jurisdiction: 'Балесноландская Федерация' } : { o: g.o, c: 'БФ' };
      const id = await issueCert(conn, { ca, names: g.names, policy: g.policy, subject, govSite: true, months: 12 });
      if (cur) await q('UPDATE pki_certs SET replaced_by = ? WHERE id = ?', [id, cur.id], conn);
    }
  });
}

/** Автопродление бесплатных сертификатов из панели хостинга за игровой месяц до конца. */
export async function renewAutoCerts(now) {
  const t = now ?? (await gameSeconds());
  const due = await q("SELECT * FROM pki_certs WHERE auto_renew = 1 AND status = 'valid' AND replaced_by IS NULL AND na - ? < ?", [t, MONTH]);
  for (const c of due) {
    await tx(async (conn) => {
      const site = await one('SELECT * FROM hosting_sites WHERE cert_id = ?', [c.id], conn);
      const account = site && (await one('SELECT * FROM hosting_accounts WHERE id = ?', [site.account_id], conn));
      const who = c.owner_gov_user_id || (c.owner_org_id && (await one('SELECT director_gov_user_id AS d FROM organizations WHERE id = ?', [c.owner_org_id], conn))?.d);
      if (!site || !account || account.status !== 'active') {
        await q('UPDATE pki_certs SET auto_renew = 0 WHERE id = ?', [c.id], conn);
        return;
      }
      const r = await autoSsl(conn, { site, account, govUserId: who });
      if (!r.ok && who) {
        await notify(conn, 'gov', who, { title: `Не удалось продлить сертификат ${site.host}`, body: r.results.filter((x) => !x.ok).map((x) => x.error).join('; ').slice(0, 300), link: '#/hosting', email: true });
      }
    });
  }
}

onMonth('certs', async () => {
  await ensurePki();
  const now = await gameSeconds();
  await renewGovCerts(now);
  await renewAutoCerts(now);
});

// ——— УЦ организаций ———

/** Организация с лицензией УЦ создаёт корень и выпускающий УЦ. В браузерах корень появится, когда админ включит его в хранилище. */
export async function createOrgCa(conn, { orgId, name, identifier }) {
  const month = await currentMonth(conn);
  need(await hasLicense(conn, orgId, 'ca', month), 'Нужна лицензия удостоверяющего центра');
  need(!(await one('SELECT id FROM pki_cas WHERE org_id = ? AND status = ?', [orgId, 'active'], conn)), 'У организации уже есть УЦ');
  const nm = String(name || '').trim();
  need(nm.length >= 2 && nm.length <= 60, 'Название УЦ: от 2 до 60 символов');
  const id = String(identifier || '').trim().toLowerCase().replace(/\.$/, '');
  need(fqdn(id) && id.includes('.'), 'Идентификатор для CAA — доменное имя, например ca.mycompany.bln');
  need(!(await one('SELECT id FROM pki_cas WHERE identifier = ?', [id], conn)), 'Такой идентификатор уже занят');
  const org = await one('SELECT name FROM organizations WHERE id = ?', [orgId], conn);
  const now = await gameSeconds();
  const root = await makeCa(conn, { kind: 'root', name: `${nm} Root`, o: org.name, years: 20, now, orgId });
  const ca = await makeCa(conn, { kind: 'ca', name: nm, o: org.name, identifier: id, parent: root, years: 8, now, orgId });
  return { root_id: root.id, ca_id: ca.id };
}

export async function caList(conn) {
  await ensurePki();
  const rows = await q("SELECT c.*, r.trusted AS root_trusted, r.status AS root_status, o.name AS org_name FROM pki_cas c LEFT JOIN pki_cas r ON r.id = c.parent_id LEFT JOIN organizations o ON o.id = c.org_id WHERE c.kind = 'ca' ORDER BY c.org_id IS NOT NULL, c.id", [], conn);
  const out = [];
  for (const c of rows) {
    out.push({
      id: c.id, name: c.name, org_id: c.org_id, org_name: c.org_name || 'Координационный центр БалНета', identifier: c.identifier,
      trusted: !!c.root_trusted && c.root_status === 'active' && c.status === 'active', status: c.status, prices: await caPrices(c),
      issued: Number((await one('SELECT COUNT(*) AS n FROM pki_certs WHERE ca_id = ?', [c.id], conn)).n),
    });
  }
  return out;
}

export async function setCaPrices(conn, { caId, prices }) {
  const p = {};
  for (const k of ['DV', 'OV', 'EV']) {
    const v = Number(prices?.[k] ?? 0);
    need(Number.isSafeInteger(v) && v >= 0 && v <= 10_000_000, `Цена ${k}: целое число от 0`);
    p[k] = v;
  }
  await q('UPDATE pki_cas SET prices = ? WHERE id = ?', [JSON.stringify(p), caId], conn);
}

/** Поиск в журнале прозрачности, как crt.sh: по имени (и поддоменам). */
export async function ctSearch(query) {
  await ensurePki();
  const s = String(query || '').trim().toLowerCase().replace(/^\*\./, '').replace(/\.$/, '');
  if (!s) return [];
  const like = `%${s.replace(/[%_\\]/g, '\\$&')}%`;
  const rows = await q('SELECT e.idx, e.ts, e.names, e.issuer, e.cert_hash, c.serial, c.nb, c.na, c.policy, c.status FROM pki_ct_entries e JOIN pki_certs c ON c.id = e.cert_id WHERE e.names LIKE ? ORDER BY e.idx DESC LIMIT 100', [like]);
  return rows.map((r) => ({ index: Number(r.idx), ts: Number(r.ts), names: r.names.split(' '), issuer: r.issuer, hash: r.cert_hash, serial: r.serial, nb: Number(r.nb), na: Number(r.na), policy: r.policy, revoked: r.status === 'revoked' }));
}

