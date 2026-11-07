// Домены игроков: регистрация через регистратора, продление, истечение и освобождение, аукцион, передача.
// Деньги: покупатель платит квитанцию регистратору; из неё НДС уходит в бюджет, оптовая цена — реестру зоны.
// Сроки — в игровых месяцах, год = 12 игровых месяцев.
import { q, one, tx } from '../db.js';
import { bad, notFound, forbidden, need } from './errors.js';
import { getSettings } from './settings.js';
import { currentMonth, onMonth } from './clock.js';
import { createInvoice, onInvoicePaid } from './gov.js';
import { notify } from './notify.js';
import { priceIndex } from './finance.js';
import { hasLicense, orgRole } from './orgs.js';
import { randomToken } from './ids.js';
import { ensureHostedZone, setDelegation, removeDelegation, domainNs, deleteDomainZone } from './zones.js';
import { invalidateNet } from './net.js';
import { fqdn, inZone } from '@bln/shared/balnet-dns.js';
import { isIP, normalizeIP } from '@bln/shared/balnet-ip.js';
import { vatIncluded, formatMoney } from '@bln/shared/money.js';

export const STATUS_TITLES = { reserved: 'ждёт оплаты', active: 'работает', expired: 'истёк — льготный период', redemption: 'истёк — восстановление', released: 'освобождён' };
const LINK = '#/domains';

export const newAuthCode = () => randomToken(9).replace(/[^A-Za-z0-9]/g, '').slice(0, 12).padEnd(12, 'x');
const disp = (name) => name.replace(/\.$/, '');

// ——— Имя и зона ———

/** «Vasya.BLN» → { name: 'vasya.bln.', label: 'vasya', tld }. Регистрируются только имена второго уровня под TLD. */
export async function parseDomain(conn, input) {
  const name = fqdn(String(input || ''));
  if (!name || name === '.') throw bad('invalid_name', 'Неверное имя домена: латиница, цифры и дефис');
  const tlds = await q('SELECT * FROM tlds WHERE active = 1', [], conn);
  let tld = null;
  for (const t of tlds) if (name !== t.name && inZone(name, t.name) && (!tld || t.name.length > tld.name.length)) tld = t;
  if (!tld) throw bad('no_tld', 'В этой зоне домены не регистрируются');
  const label = name.slice(0, -(tld.name.length + 1));
  if (label.includes('.')) throw bad('third_level', `Регистрируются только имена вида имя.${disp(tld.name)}`);
  if (label.startsWith('_') || label.length < 2) throw bad('invalid_name', 'Имя домена — от 2 символов: латиница, цифры, дефис');
  if (/^xn--/.test(label) || label.slice(2, 4) === '--') throw bad('invalid_name', 'Имя не может содержать «--» в 3–4 позиции');
  return { name, label, tld };
}

/** Свободно ли имя: нет живого домена, служебных записей, своей зоны и идущего аукциона. */
export async function availability(conn, name, tld) {
  if (await one('SELECT id FROM domains WHERE live_name = ?', [name], conn)) return { free: false, reason: 'Домен уже занят' };
  if (await one('SELECT id FROM dns_zones WHERE name = ?', [name], conn)) return { free: false, reason: 'Имя зарезервировано' };
  const rec = await one('SELECT id FROM dns_records WHERE zone_id = ? AND domain_id IS NULL AND (name = ? OR name LIKE ?) LIMIT 1', [tld.zone_id, name, `%.${name}`], conn);
  if (rec) return { free: false, reason: 'Имя зарезервировано за инфраструктурой БалНета' };
  const auc = await one("SELECT id, status FROM auctions WHERE name = ? AND status IN ('open','awaiting_payment')", [name], conn);
  if (auc) return { free: false, reason: 'Имя продаётся на аукционе', auction_id: auc.id };
  return { free: true };
}

// ——— Цены ———

async function index(conn) {
  return (await priceIndex(conn)).index;
}

/** Оптовая цена реестра за год с учётом инфляции. */
export async function wholesale(conn, tld) {
  return Math.round(Number(tld.wholesale_price) * (await index(conn)));
}

/** Цены регистраторов на зону: Госрегистратор (null) + лицензированные организации. */
export async function registrarOffers(conn, tld, month) {
  const idx = await index(conn);
  const offers = [{ registrar_org_id: null, name: 'Госрегистратор БалНета', price: Math.round(Number(tld.gov_price) * idx) }];
  const rows = await q("SELECT o.id, o.name, rp.price FROM registrar_prices rp JOIN organizations o ON o.id = rp.org_id WHERE rp.tld_id = ? AND o.status = 'active'", [tld.id], conn);
  for (const r of rows) if (await hasLicense(conn, r.id, 'registrar', month)) offers.push({ registrar_org_id: r.id, name: r.name, price: Number(r.price) });
  return offers;
}

async function accountOfOrg(conn, orgId) {
  if (!orgId) return null;
  const o = await one('SELECT account_id FROM organizations WHERE id = ?', [orgId], conn);
  return o?.account_id || null;
}

/**
 * Разбивка оплаты: регистратору — цена минус НДС и опт; НДС — в бюджет; опт — реестру зоны (или в бюджет).
 * У Госрегистратора всё уходит в бюджет (splits = null).
 */
async function buildSplits(conn, { tld, registrarOrgId, total, years, extraBudget = 0 }) {
  if (!registrarOrgId) return null;
  const s = await getSettings();
  const goods = total - extraBudget;
  const vat = vatIncluded(goods, Number(s.vat_bp || 0));
  const whole = (await wholesale(conn, tld)) * years;
  const net = goods - vat - whole;
  if (net < 0) throw bad('price_below_wholesale', 'Цена регистратора ниже оптовой цены реестра — покупка невозможна');
  return [
    { account: await accountOfOrg(conn, registrarOrgId), amount: net },
    { account: null, amount: vat + extraBudget },
    { account: await accountOfOrg(conn, tld.registry_org_id), amount: whole },
  ];
}

async function priceAt(conn, tld, registrarOrgId, month) {
  const offer = (await registrarOffers(conn, tld, month)).find((o) => o.registrar_org_id === (registrarOrgId || null));
  if (!offer) throw bad('no_registrar', 'Регистратор не продаёт домены в этой зоне');
  return offer.price;
}

// ——— Заказы ———

const ORDER_TITLES = { register: 'Регистрация домена', renew: 'Продление домена', restore: 'Восстановление домена', transfer: 'Перенос домена к регистратору', auction: 'Покупка домена на аукционе' };

async function createOrder(conn, { kind, domain, govUserId, registrarOrgId, years, amount, splits, month }) {
  const o = await q('INSERT INTO domain_orders (kind, domain_id, gov_user_id, registrar_org_id, years, amount, created_month) VALUES (?, ?, ?, ?, ?, ?, ?)', [kind, domain.id, govUserId, registrarOrgId || null, years, amount, month], conn);
  if (amount <= 0) {
    await q("UPDATE domain_orders SET status = 'paid' WHERE id = ?", [o.insertId], conn);
    await applyOrder(conn, o.insertId);
    return { id: o.insertId, invoice: null };
  }
  const citizen = await one('SELECT id FROM citizens WHERE gov_user_id = ?', [govUserId], conn);
  const inv = await createInvoice(conn, {
    citizenId: citizen?.id || null, govUserId, kind: 'other', purpose: `${ORDER_TITLES[kind]} ${disp(domain.name)}${years ? `, ${years} г.` : ''}`, amount, ref: { type: 'domain_order', id: o.insertId }, splits,
  });
  await q('UPDATE domain_orders SET invoice_id = ? WHERE id = ?', [inv.id, o.insertId], conn);
  await notify(conn, 'gov', govUserId, { title: `Оплатите ${formatMoney(amount)}`, body: `Квитанция ${inv.number}: ${ORDER_TITLES[kind]} ${disp(domain.name)}`, link: '#/invoices' });
  return { id: o.insertId, invoice: inv.number };
}

/** Применить оплаченный заказ. */
async function applyOrder(conn, orderId) {
  const o = await one('SELECT * FROM domain_orders WHERE id = ? FOR UPDATE', [orderId], conn);
  const d = await one('SELECT * FROM domains WHERE id = ? FOR UPDATE', [o.domain_id], conn);
  const tld = await one('SELECT * FROM tlds WHERE id = ?', [d.tld_id], conn);
  const month = await currentMonth(conn);
  const add = 12 * o.years;
  if (o.kind === 'register' || o.kind === 'auction') {
    if (d.status !== 'reserved') throw bad('invalid_state', 'Домен уже не ждёт оплаты');
    await q("UPDATE domains SET status = 'active', created_month = ?, expires_month = ? WHERE id = ?", [month, month + add, d.id], conn);
  } else if (o.kind === 'renew' || o.kind === 'restore') {
    const base = d.status === 'active' ? d.expires_month : Math.max(d.expires_month, month);
    await q("UPDATE domains SET status = 'active', expires_month = ? WHERE id = ?", [base + add, d.id], conn);
  } else if (o.kind === 'transfer') {
    await q('UPDATE domains SET registrar_org_id = ?, expires_month = expires_month + ?, auth_code = ? WHERE id = ?', [o.registrar_org_id, add, newAuthCode(), d.id], conn);
  }
  const fresh = await one('SELECT * FROM domains WHERE id = ?', [d.id], conn);
  if (fresh.ns_mode === 'hosted') await ensureHostedZone(conn, fresh);
  await setDelegation(conn, fresh, tld, await domainNs(conn, fresh));
  invalidateNet();
  await notify(conn, 'gov', o.gov_user_id, { title: `${ORDER_TITLES[o.kind]}: ${disp(d.name)}`, body: `Домен работает до ${fresh.expires_month}-го игрового месяца`, link: LINK });
}

onInvoicePaid('domain_order', async (conn, inv) => {
  await q("UPDATE domain_orders SET status = 'paid' WHERE id = ?", [inv.ref_id], conn);
  await applyOrder(conn, inv.ref_id);
});

/** Кто может управлять доменом: владелец-гражданин или сотрудник организации-владельца. */
export async function canManage(conn, domain, govUserId) {
  if (domain.owner_gov_user_id === govUserId) return true;
  if (domain.owner_org_id) return !!(await orgRole(conn, domain.owner_org_id, govUserId));
  return false;
}

export async function ownDomain(conn, id, govUserId, { lock = false } = {}) {
  const d = await one(`SELECT * FROM domains WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [id], conn);
  if (!d || d.status === 'released') throw notFound('Домен не найден');
  if (!(await canManage(conn, d, govUserId))) throw forbidden('Это не ваш домен');
  return d;
}

async function checkYears(years) {
  const s = await getSettings();
  const y = Number(years ?? 1);
  need(Number.isInteger(y) && y >= 1 && y <= Number(s.domain_max_years || 10), `Срок: от 1 до ${s.domain_max_years || 10} лет`);
  return y;
}

/** Регистрация: имя резервируется, выставляется квитанция. После оплаты — домен работает. */
export async function registerDomain(conn, { govUserId, name: input, registrarOrgId = null, years, ownerOrgId = null }) {
  const month = await currentMonth(conn);
  const { name, tld } = await parseDomain(conn, input);
  const y = await checkYears(years);
  if (ownerOrgId && !(await orgRole(conn, ownerOrgId, govUserId))) throw forbidden('Вы не сотрудник этой организации');
  if (tld.restricted === 'gov') {
    const org = ownerOrgId ? await one('SELECT kind FROM organizations WHERE id = ?', [ownerOrgId], conn) : null;
    if (org?.kind !== 'gov') throw bad('restricted', `Домены в зоне ${disp(tld.name)} регистрируют только госучреждения: выберите владельцем госучреждение, где вы работаете`);
  }
  const av = await availability(conn, name, tld);
  if (!av.free) throw bad('taken', av.reason);
  const price = await priceAt(conn, tld, registrarOrgId, month);
  const total = price * y;
  const splits = await buildSplits(conn, { tld, registrarOrgId, total, years: y });
  const s = await getSettings();
  const r = await q("INSERT INTO domains (name, live_name, tld_id, owner_gov_user_id, owner_org_id, registrar_org_id, status, created_month, expires_month, auth_code) VALUES (?, ?, ?, ?, ?, ?, 'reserved', ?, ?, ?)", [
    name, name, tld.id, ownerOrgId ? null : govUserId, ownerOrgId || null, registrarOrgId || null, month, month + Number(s.domain_reserve_months || 1), newAuthCode(),
  ], conn);
  const domain = await one('SELECT * FROM domains WHERE id = ?', [r.insertId], conn);
  const order = await createOrder(conn, { kind: 'register', domain, govUserId, registrarOrgId, years: y, amount: total, splits, month });
  return { domain_id: domain.id, ...order, amount: total };
}

export async function renewDomain(conn, { govUserId, id, years }) {
  const d = await ownDomain(conn, id, govUserId, { lock: true });
  need(['active', 'expired', 'redemption'].includes(d.status), 'Этот домен нельзя продлить');
  if (await one("SELECT id FROM domain_orders WHERE domain_id = ? AND status = 'pending'", [d.id], conn)) throw bad('order_pending', 'По домену уже есть неоплаченная квитанция');
  const month = await currentMonth(conn);
  const y = await checkYears(years);
  const tld = await one('SELECT * FROM tlds WHERE id = ?', [d.tld_id], conn);
  // Если регистратор потерял лицензию или ушёл из зоны — продление идёт через Госрегистратора.
  const offers = await registrarOffers(conn, tld, month);
  const own = offers.find((o) => o.registrar_org_id === (d.registrar_org_id || null));
  const registrar = own ? d.registrar_org_id : null;
  if (!own) await q('UPDATE domains SET registrar_org_id = NULL WHERE id = ?', [d.id], conn);
  const price = (own || offers[0]).price;
  const s = await getSettings();
  const extra = d.status === 'redemption' ? Number(s.domain_redemption_fee || 0) : 0;
  const total = price * y + extra;
  const splits = await buildSplits(conn, { tld, registrarOrgId: registrar, total, years: y, extraBudget: extra });
  return createOrder(conn, { kind: d.status === 'redemption' ? 'restore' : 'renew', domain: d, govUserId, registrarOrgId: registrar, years: y, amount: total, splits, month });
}

/** Перенос к другому регистратору: оплата 1 года по цене нового регистратора, срок +1 год. */
export async function transferRegistrar(conn, { govUserId, id, registrarOrgId, authCode }) {
  const d = await ownDomain(conn, id, govUserId, { lock: true });
  need(d.status === 'active', 'Переносить можно только работающий домен');
  need(String(authCode || '') === d.auth_code, 'Неверный код авторизации', 'bad_auth_code');
  need((registrarOrgId || null) !== (d.registrar_org_id || null), 'Домен уже у этого регистратора');
  if (await one("SELECT id FROM domain_orders WHERE domain_id = ? AND status = 'pending'", [d.id], conn)) throw bad('order_pending', 'По домену уже есть неоплаченная квитанция');
  const month = await currentMonth(conn);
  const tld = await one('SELECT * FROM tlds WHERE id = ?', [d.tld_id], conn);
  const price = await priceAt(conn, tld, registrarOrgId, month);
  const splits = await buildSplits(conn, { tld, registrarOrgId, total: price, years: 1 });
  return createOrder(conn, { kind: 'transfer', domain: d, govUserId, registrarOrgId, years: 1, amount: price, splits, month });
}

/** Смена владельца по коду авторизации: новый владелец вводит имя и код. Код после передачи меняется. */
export async function claimDomain(conn, { govUserId, name: input, authCode, ownerOrgId = null }) {
  const name = fqdn(String(input || ''));
  const d = name && await one("SELECT * FROM domains WHERE live_name = ? AND status IN ('active','expired') FOR UPDATE", [name], conn);
  if (!d || String(authCode || '') !== d.auth_code) throw bad('bad_auth_code', 'Домен не найден или код авторизации неверный');
  if (ownerOrgId && !(await orgRole(conn, ownerOrgId, govUserId))) throw forbidden('Вы не сотрудник этой организации');
  const tld = await one('SELECT * FROM tlds WHERE id = ?', [d.tld_id], conn);
  if (tld.restricted === 'gov') {
    const org = ownerOrgId ? await one('SELECT kind FROM organizations WHERE id = ?', [ownerOrgId], conn) : null;
    need(org?.kind === 'gov', `Домены в зоне ${disp(tld.name)} принадлежат только госучреждениям`);
  }
  const prevUser = d.owner_gov_user_id;
  await q('UPDATE domains SET owner_gov_user_id = ?, owner_org_id = ?, auth_code = ?, privacy = 0 WHERE id = ?', [ownerOrgId ? null : govUserId, ownerOrgId || null, newAuthCode(), d.id], conn);
  if (prevUser && prevUser !== govUserId) await notify(conn, 'gov', prevUser, { title: `Домен ${disp(d.name)} передан`, body: 'Новый владелец ввёл код авторизации', link: LINK });
  return { id: d.id };
}

/** Серверы имён: хостинг БалНета или свои (с glue для серверов внутри домена). */
export async function setNameservers(conn, { govUserId, id, mode, ns }) {
  const d = await ownDomain(conn, id, govUserId, { lock: true });
  const tld = await one('SELECT * FROM tlds WHERE id = ?', [d.tld_id], conn);
  if (mode === 'hosted') {
    await q("UPDATE domains SET ns_mode = 'hosted', custom_ns = NULL WHERE id = ?", [d.id], conn);
    await ensureHostedZone(conn, { ...d });
  } else {
    need(Array.isArray(ns) && ns.length >= 1 && ns.length <= 6, 'Укажите от 1 до 6 серверов имён');
    const list = ns.map((x) => {
      const n = fqdn(String(x?.name || ''));
      need(n, `Неверное имя сервера: ${x?.name || ''}`);
      const raw = x?.ip ? String(x.ip).trim() : null;
      need(!raw || isIP(raw), `Неверный IP-адрес сервера ${disp(n)}`);
      return { name: n, ip: raw ? normalizeIP(raw) : null };
    });
    await q("UPDATE domains SET ns_mode = 'custom', custom_ns = ? WHERE id = ?", [JSON.stringify(list), d.id], conn);
  }
  const fresh = await one('SELECT * FROM domains WHERE id = ?', [d.id], conn);
  if (fresh.status === 'active') await setDelegation(conn, fresh, tld, await domainNs(conn, fresh));
  invalidateNet();
  return fresh;
}

// ——— Жизненный цикл и аукционы (каждый игровой месяц) ———

async function releaseDomain(conn, d) {
  await deleteDomainZone(conn, d);
  await q("UPDATE domains SET status = 'released', live_name = NULL WHERE id = ?", [d.id], conn);
  await q("UPDATE domain_orders SET status = 'cancelled' WHERE domain_id = ? AND status = 'pending'", [d.id], conn);
  await q("UPDATE invoices i JOIN domain_orders o ON o.invoice_id = i.id SET i.status = 'cancelled' WHERE o.domain_id = ? AND i.status = 'unpaid'", [d.id], conn);
}

export async function domainMonth(month) {
  const s = await getSettings();
  const grace = Number(s.domain_grace_months ?? 1);
  const redemption = Number(s.domain_redemption_months ?? 1);

  // Неоплаченные резервы — снимаются.
  for (const d of await q("SELECT * FROM domains WHERE status = 'reserved' AND expires_month <= ?", [month])) {
    await tx(async (conn) => releaseDomain(conn, d));
  }
  // Истёк срок — сайт перестаёт открываться (делегирование снято), идёт льготный период.
  for (const d of await q("SELECT * FROM domains WHERE status = 'active' AND expires_month <= ?", [month])) {
    await tx(async (conn) => {
      const tld = await one('SELECT * FROM tlds WHERE id = ?', [d.tld_id], conn);
      await removeDelegation(conn, d, tld);
      await q("UPDATE domains SET status = 'expired' WHERE id = ?", [d.id], conn);
      const who = d.owner_gov_user_id || (await one("SELECT director_gov_user_id AS id FROM organizations WHERE id = ?", [d.owner_org_id], conn))?.id;
      if (who) await notify(conn, 'gov', who, { title: `Домен ${disp(d.name)} истёк`, body: `Сайт не открывается. Продлите домен в течение ${grace} игр. мес. по обычной цене`, link: LINK, email: true });
    });
  }
  for (const d of await q("SELECT * FROM domains WHERE status = 'expired' AND expires_month + ? <= ?", [grace, month])) {
    await q("UPDATE domains SET status = 'redemption' WHERE id = ?", [d.id]);
  }
  // Конец восстановления — домен освобождается и уходит на аукцион.
  for (const d of await q("SELECT * FROM domains WHERE status = 'redemption' AND expires_month + ? <= ?", [grace + redemption, month])) {
    await tx(async (conn) => {
      await releaseDomain(conn, d);
      const tld = await one('SELECT * FROM tlds WHERE id = ?', [d.tld_id], conn);
      await q("INSERT INTO auctions (name, tld_id, reason, min_bid, ends_month) VALUES (?, ?, 'released', ?, ?)", [d.name, d.tld_id, Math.max(100, await wholesale(conn, tld)), month + Number(s.auction_months || 1)]);
    });
  }
  // Аукционы.
  for (const a of await q("SELECT * FROM auctions WHERE status = 'open' AND ends_month <= ?", [month])) {
    await tx(async (conn) => closeAuction(conn, a, month, s));
  }
  for (const a of await q("SELECT * FROM auctions WHERE status = 'awaiting_payment' AND pay_until_month < ?", [month])) {
    await tx(async (conn) => {
      const d = a.domain_id ? await one('SELECT * FROM domains WHERE id = ?', [a.domain_id], conn) : null;
      if (d?.status === 'reserved') await releaseDomain(conn, d);
      await q("UPDATE auctions SET status = 'failed' WHERE id = ?", [a.id], conn);
    });
  }
  invalidateNet();
}

async function closeAuction(conn, a, month, s) {
  const best = await one('SELECT * FROM auction_bids WHERE auction_id = ? ORDER BY amount DESC, id ASC LIMIT 1', [a.id], conn);
  if (!best) {
    await q("UPDATE auctions SET status = 'failed' WHERE id = ?", [a.id], conn);
    return;
  }
  const tld = await one('SELECT * FROM tlds WHERE id = ?', [a.tld_id], conn);
  const r = await q("INSERT INTO domains (name, live_name, tld_id, owner_gov_user_id, registrar_org_id, status, created_month, expires_month, auth_code) VALUES (?, ?, ?, ?, NULL, 'reserved', ?, ?, ?)", [
    a.name, a.name, a.tld_id, best.gov_user_id, month, month + Number(s.auction_pay_months || 1) + 1, newAuthCode(),
  ], conn);
  const domain = await one('SELECT * FROM domains WHERE id = ?', [r.insertId], conn);
  // Выручка аукциона — реестру зоны (или в бюджет).
  const registryAcc = await accountOfOrg(conn, tld.registry_org_id);
  const splits = registryAcc ? [{ account: registryAcc, amount: Number(best.amount) }] : null;
  await q("UPDATE auctions SET status = 'awaiting_payment', winner_gov_user_id = ?, winner_amount = ?, pay_until_month = ?, domain_id = ? WHERE id = ?", [best.gov_user_id, best.amount, month + Number(s.auction_pay_months || 1), domain.id, a.id], conn);
  await createOrder(conn, { kind: 'auction', domain, govUserId: best.gov_user_id, registrarOrgId: null, years: 1, amount: Number(best.amount), splits, month });
}

onInvoicePaid('domain_order', async (conn, inv) => {
  const o = await one('SELECT kind, domain_id FROM domain_orders WHERE id = ?', [inv.ref_id], conn);
  if (o?.kind === 'auction') await q("UPDATE auctions SET status = 'done' WHERE domain_id = ? AND status = 'awaiting_payment'", [o.domain_id], conn);
});

onMonth('domains', async (month) => { await domainMonth(month); });

export async function placeBid(conn, { govUserId, auctionId, amount }) {
  const a = await one("SELECT * FROM auctions WHERE id = ? AND status = 'open' FOR UPDATE", [auctionId], conn);
  if (!a) throw notFound('Аукцион не найден или закрыт');
  const top = await one('SELECT MAX(amount) AS m FROM auction_bids WHERE auction_id = ?', [a.id], conn);
  const min = Math.max(Number(a.min_bid), top?.m ? Number(top.m) + 100 : 0);
  need(Number.isSafeInteger(amount) && amount >= min, `Ставка — не меньше ${formatMoney(min)}`, 'bid_too_low');
  const prev = await one('SELECT gov_user_id FROM auction_bids WHERE auction_id = ? ORDER BY amount DESC, id ASC LIMIT 1', [a.id], conn);
  await q('INSERT INTO auction_bids (auction_id, gov_user_id, amount) VALUES (?, ?, ?)', [a.id, govUserId, amount], conn);
  if (prev && prev.gov_user_id !== govUserId) await notify(conn, 'gov', prev.gov_user_id, { title: `Вашу ставку перебили: ${disp(a.name)}`, body: `Новая ставка ${formatMoney(amount)}`, link: LINK });
  return { min_next: amount + 100 };
}

// ——— Представление и WHOIS ———

export async function domainView(conn, d, { withAuth = false } = {}) {
  const tld = await one('SELECT name FROM tlds WHERE id = ?', [d.tld_id], conn);
  const reg = d.registrar_org_id ? await one('SELECT name FROM organizations WHERE id = ?', [d.registrar_org_id], conn) : null;
  const pending = await one("SELECT o.id, o.kind, o.amount, i.number FROM domain_orders o LEFT JOIN invoices i ON i.id = o.invoice_id WHERE o.domain_id = ? AND o.status = 'pending' ORDER BY o.id DESC LIMIT 1", [d.id], conn);
  return {
    id: d.id, name: disp(d.name), tld: disp(tld?.name || ''), status: d.status, status_title: STATUS_TITLES[d.status],
    registrar: reg?.name || 'Госрегистратор БалНета', registrar_org_id: d.registrar_org_id,
    owner_org_id: d.owner_org_id, created_month: d.created_month, expires_month: d.expires_month, privacy: !!d.privacy,
    ns_mode: d.ns_mode, ns: (await domainNs(conn, d)).map((n) => ({ name: disp(n.name), ip: n.ip || null })), zone_id: d.zone_id,
    pending_order: pending ? { kind: pending.kind, amount: Number(pending.amount), invoice: pending.number } : null,
    ...(withAuth ? { auth_code: d.auth_code } : {}),
  };
}

export async function whoisDomain(conn, name) {
  const d = await one('SELECT * FROM domains WHERE live_name = ?', [name], conn);
  if (!d) return null;
  const reg = d.registrar_org_id ? await one('SELECT name FROM organizations WHERE id = ?', [d.registrar_org_id], conn) : null;
  let owner = 'Скрыто (защита данных)';
  if (!d.privacy) {
    if (d.owner_org_id) owner = (await one('SELECT name FROM organizations WHERE id = ?', [d.owner_org_id], conn))?.name || '—';
    else {
      const c = await one('SELECT full_name FROM citizens WHERE gov_user_id = ?', [d.owner_gov_user_id], conn);
      owner = c?.full_name || '—';
    }
  }
  return {
    kind: 'domain', name: disp(d.name), status: d.status, registrar: reg?.name || 'Госрегистратор БалНета', owner,
    created_month: d.created_month, expires_month: d.expires_month, ns: (await domainNs(conn, d)).map((n) => n.name),
  };
}

