// Эквайринг ВлодБанка (этап Н9): мерчанты и API-ключи, платежи на странице pay.bank.bln (карта и PIN или счёт ВлодБанка),
// возвраты, подписки с автосписанием каждый игровой месяц, вебхуки с подписью HMAC-SHA256.
// Деньги — только проводками: покупатель → мерчант (за вычетом НДС и комиссии), НДС → Госбюджет, комиссия → Казна ВлодБанка.
import crypto from 'node:crypto';
import { q, one, tx, json, afterCommit } from '../../db.js';
import { bad, forbidden, notFound, unauthorized, HttpError } from '../errors.js';
import { post, sys } from '../ledger.js';
import { getSettings } from '../settings.js';
import { currentMonth, onMonth } from '../clock.js';
import { notify } from '../notify.js';
import { publish } from '../hub.js';
import { randomToken, withUnique } from '../ids.js';
import { requireVerified, authorizeCard, checkCardLimits, assertSpendable, ownAccount } from '../bank.js';
import { reviewIfLarge } from '../finance.js';
import { formatMoney, percentOf, vatIncluded } from '@bln/shared/money.js';
import { normalizeUrl } from '@bln/shared/balnet-url.js';
import { ageFrom } from '@bln/shared/format.js';

export const PAY_HOST = 'pay.bank.bln';
export const PAY_ORIGIN = `https://${PAY_HOST}`;
/** Сервер ВлодБанка в БалНете: с него уходят вебхуки. */
export const BANK_IP = '50.1.0.10';
export const CURRENCY = 'vlod';
const MAX_AMOUNT = 1e10;
/** Повторы вебхука: через 1, 5, 30 минут, 2 и 6 часов. */
const RETRY_MINUTES = [1, 5, 30, 120, 360];
const SUB_MAX_FAILS = 3;

export const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
export const publicId = (prefix) => `${prefix}_${randomToken(12).replace(/[-_]/g, 'x')}`;

/** Платёжная ошибка API — со своим кодом и HTTP-статусом. */
export const payError = (status, code, message) => new HttpError(status, code, message);

/** Адрес сайта БалНета для возврата покупателя: только http(s), без balnet://. */
export function siteUrl(u, name = 'Адрес') {
  if (u === undefined || u === null || u === '') return null;
  const n = normalizeUrl(String(u).trim());
  if (!n || n.startsWith('balnet://') || n.length > 500) throw bad('invalid_url', `${name}: нужен адрес сайта БалНета (https://…)`);
  return n;
}

function amountOf(v, name = 'amount') {
  const n = Number(v);
  if (!Number.isSafeInteger(n) || n <= 0 || n > MAX_AMOUNT) throw bad('invalid_amount', `${name}: целое число влодинок больше нуля`);
  return n;
}

function metaOf(v) {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) throw bad('invalid_metadata', 'metadata — объект «ключ: значение»');
  const keys = Object.keys(v);
  if (keys.length > 20) throw bad('invalid_metadata', 'metadata: не больше 20 ключей');
  const out = {};
  for (const k of keys) out[String(k).slice(0, 40)] = String(v[k] ?? '').slice(0, 500);
  return out;
}

function itemsOf(v, amount) {
  if (!v) return null;
  if (!Array.isArray(v) || v.length > 100) throw bad('invalid_items', 'items — список до 100 позиций');
  const out = v.map((i) => ({ name: String(i?.name || '').slice(0, 120) || 'Товар', qty: Math.max(1, Math.round(Number(i?.qty) || 1)), price: Math.max(0, Math.round(Number(i?.price) || 0)) }));
  const sum = out.reduce((s, i) => s + i.qty * i.price, 0);
  if (sum && sum !== amount) throw bad('items_mismatch', `Сумма позиций (${sum}) не равна amount (${amount})`);
  return out;
}

// ——— Мерчанты и ключи ———

/** Счёт для зачислений: бизнес-счёт ИП владельца или счёт организации, где он директор. */
async function settlementAccount(conn, user, accountId) {
  const a = await one('SELECT * FROM accounts WHERE id = ?', [Number(accountId) || 0], conn);
  if (!a || a.status === 'closed') throw notFound('Счёт не найден');
  if (a.owner_kind === 'bank_user' && a.owner_id === user.id && a.type === 'business') return { account: a, orgId: null };
  if (a.owner_kind === 'org' && user.gov_user_id) {
    const m = await one("SELECT m.role FROM org_members m JOIN organizations o ON o.id = m.org_id WHERE o.id = ? AND o.status = 'active' AND m.gov_user_id = ?", [a.owner_id, user.gov_user_id], conn);
    if (m?.role === 'director') return { account: a, orgId: a.owner_id };
  }
  throw bad('invalid_account', 'Деньги зачисляются на бизнес-счёт ИП или на счёт организации, где вы директор');
}

export async function createMerchant(conn, user, { name, account_id: accountId, shop_id: shopId = null, site_url: site = null }) {
  requireVerified(user);
  const title = String(name || '').trim().slice(0, 80);
  if (title.length < 2) throw bad('invalid_name', 'Название магазина — от 2 символов');
  let shop = null;
  if (shopId) {
    shop = await one("SELECT * FROM shops WHERE id = ? AND owner_id = ? AND status = 'active'", [Number(shopId), user.id], conn);
    if (!shop) throw notFound('Магазин Кассы не найден');
    if (await one('SELECT id FROM pay_merchants WHERE shop_id = ?', [shop.id], conn)) throw bad('shop_linked', 'Этот магазин уже подключён к эквайрингу');
  }
  // Интернет-магазин на складе Кассы получает деньги на бизнес-счёт магазина — туда же идут возвраты чеков.
  const { account, orgId } = await settlementAccount(conn, user, shop ? shop.account_id : accountId);
  const count = await one('SELECT COUNT(*) AS n FROM pay_merchants WHERE owner_bank_user_id = ?', [user.id], conn);
  if (Number(count.n) >= 10) throw bad('too_many', 'Не больше 10 магазинов эквайринга');
  const id = await withUnique(async () => {
    const r = await q(
      'INSERT INTO pay_merchants (public_id, name, owner_bank_user_id, org_id, account_id, shop_id, site_url, webhook_secret) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [publicId('m'), title, user.id, orgId, account.id, shop?.id || null, siteUrl(site, 'Сайт'), `whsec_${randomToken(24)}`],
      conn,
    );
    return r.insertId;
  });
  const keys = await rotateKeys(conn, id);
  return { merchant: await one('SELECT * FROM pay_merchants WHERE id = ?', [id], conn), keys };
}

/** Новая пара ключей (старые отзываются). Секретный ключ показывается один раз. */
export async function rotateKeys(conn, merchantId) {
  await q('UPDATE pay_keys SET revoked_at = NOW(3) WHERE merchant_id = ? AND revoked_at IS NULL', [merchantId], conn);
  const out = {};
  for (const [kind, prefix] of [['publishable', 'pk_live_'], ['secret', 'sk_live_']]) {
    const token = prefix + randomToken(24);
    await q('INSERT INTO pay_keys (merchant_id, kind, token_hash, hint) VALUES (?, ?, ?, ?)', [merchantId, kind, sha256(token), `${prefix}…${token.slice(-4)}`], conn);
    out[kind] = token;
  }
  return out;
}

/** Мерчант по ключу из заголовка Authorization: Bearer <ключ>. */
export async function merchantByKey(header, { secret = true } = {}) {
  const m = /^Bearer\s+(\S+)$/i.exec(String(header || ''));
  if (!m) throw payError(401, 'no_api_key', 'Нужен API-ключ: Authorization: Bearer sk_live_…');
  const key = await one('SELECT * FROM pay_keys WHERE token_hash = ? AND revoked_at IS NULL', [sha256(m[1])]);
  if (!key) throw payError(401, 'invalid_api_key', 'Неверный или отозванный API-ключ');
  if (secret && key.kind !== 'secret') throw payError(403, 'secret_key_required', 'Для этого запроса нужен секретный ключ sk_live_…');
  const merchant = await one('SELECT * FROM pay_merchants WHERE id = ?', [key.merchant_id]);
  if (!merchant || merchant.status !== 'active') throw payError(403, 'merchant_blocked', 'Приём платежей для этого магазина остановлен');
  q('UPDATE pay_keys SET last_used_at = NOW(3) WHERE id = ?', [key.id]).catch(() => {});
  return merchant;
}

export async function ownMerchant(userId, id, conn) {
  const m = await one('SELECT * FROM pay_merchants WHERE id = ? AND owner_bank_user_id = ?', [Number(id) || 0, userId], conn);
  if (!m) throw notFound('Магазин эквайринга не найден');
  return m;
}

export async function merchantView(m, { secret = false } = {}) {
  const keys = await q('SELECT kind, hint, created_at, last_used_at FROM pay_keys WHERE merchant_id = ? AND revoked_at IS NULL', [m.id]);
  const acc = await one('SELECT number, name, balance FROM accounts WHERE id = ?', [m.account_id]);
  const shop = m.shop_id ? await one('SELECT id, name FROM shops WHERE id = ?', [m.shop_id]) : null;
  return {
    id: m.id,
    public_id: m.public_id,
    name: m.name,
    status: m.status,
    site_url: m.site_url,
    webhook_url: m.webhook_url,
    webhook_secret: secret ? m.webhook_secret : `${m.webhook_secret.slice(0, 10)}…`,
    courier_fee: Number(m.courier_fee),
    delivery: json(m.delivery, null) || { pickup: true, courier: false, digital: true, physical: false },
    account: acc ? { id: m.account_id, number: acc.number, name: acc.name, balance: Number(acc.balance) } : null,
    shop,
    org_id: m.org_id,
    keys: keys.map((k) => ({ kind: k.kind, hint: k.hint, created_at: k.created_at, last_used_at: k.last_used_at })),
    created_at: m.created_at,
  };
}

// ——— События и вебхуки ———

/** Подпись вебхука: Vlod-Signature: t=<unix>,v1=<hex HMAC-SHA256(secret, "t.body")>. */
export function signWebhook(secret, t, body) {
  return crypto.createHmac('sha256', secret).update(`${t}.${body}`).digest('hex');
}

export async function emitEvent(conn, merchantId, type, object) {
  const pid = publicId('evt');
  const r = await q('INSERT INTO pay_events (public_id, merchant_id, type, data, next_try_at) VALUES (?, ?, ?, ?, NOW(3))', [pid, merchantId, type, JSON.stringify(object)], conn);
  afterCommit(conn, () => { deliverEvent(r.insertId).catch((e) => console.error('webhook', e)); });
  return pid;
}

const inflight = new Map();
/** Отправить событие на webhook_url мерчанта по сети БалНета (с сервера ВлодБанка). */
export function deliverEvent(id) {
  if (inflight.has(id)) return inflight.get(id);
  const p = doDeliver(id).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

async function doDeliver(id) {
  const ev = await one('SELECT * FROM pay_events WHERE id = ?', [id]);
  if (!ev || ev.status === 'delivered') return ev;
  const m = await one('SELECT * FROM pay_merchants WHERE id = ?', [ev.merchant_id]);
  if (!m?.webhook_url) {
    await q("UPDATE pay_events SET status = 'skipped', next_try_at = NULL, last_error = 'webhook_url не указан' WHERE id = ?", [id]);
    return { ...ev, status: 'skipped' };
  }
  const t = Math.floor(Date.now() / 1000);
  const body = JSON.stringify({ id: ev.public_id, object: 'event', type: ev.type, created: Math.floor(new Date(ev.created_at).getTime() / 1000), data: { object: json(ev.data, {}) } });
  const { netRequest } = await import('../vhost/respond.js');
  let res;
  try {
    res = await netRequest({
      fromIp: BANK_IP,
      url: m.webhook_url,
      method: 'POST',
      follow: false,
      headers: { 'content-type': 'application/json', 'user-agent': 'VlodBank-Webhooks/1.0', 'vlod-event-id': ev.public_id, 'vlod-signature': `t=${t},v1=${signWebhook(m.webhook_secret, t, body)}` },
      body,
    });
  } catch (e) {
    res = { error: e.message };
  }
  const attempts = ev.attempts + 1;
  if (!res.error && res.status >= 200 && res.status < 300) {
    await q("UPDATE pay_events SET status = 'delivered', attempts = ?, last_code = ?, last_error = NULL, delivered_at = NOW(3), next_try_at = NULL WHERE id = ?", [attempts, String(res.status), id]);
    return { ...ev, status: 'delivered' };
  }
  const code = res.error ? String(res.error).slice(0, 40) : String(res.status);
  const err = res.error ? String(res.error).slice(0, 500) : String(res.body || '').slice(0, 500);
  const wait = RETRY_MINUTES[attempts - 1];
  if (wait === undefined) await q("UPDATE pay_events SET status = 'failed', attempts = ?, last_code = ?, last_error = ?, next_try_at = NULL WHERE id = ?", [attempts, code, err, id]);
  else await q('UPDATE pay_events SET attempts = ?, last_code = ?, last_error = ?, next_try_at = NOW(3) + INTERVAL ? MINUTE WHERE id = ?', [attempts, code, err, wait, id]);
  return { ...ev, status: wait === undefined ? 'failed' : 'pending', attempts };
}

/** Повторы по расписанию (воркер раз в 30 секунд). */
export async function deliverDue(limit = 20) {
  const rows = await q("SELECT id FROM pay_events WHERE status = 'pending' AND next_try_at <= NOW(3) ORDER BY next_try_at LIMIT ?", [limit]);
  for (const r of rows) await deliverEvent(r.id);
  return rows.length;
}

/** Дождаться отправки всех вебхуков, запущенных после коммита (для тестов и админки). */
export async function flushWebhooks() {
  while (inflight.size) await Promise.allSettled([...inflight.values()]);
}

let worker = null;
export function startPayWorker() {
  if (worker) return;
  worker = setInterval(() => deliverDue().catch((e) => console.error('pay worker', e)), 30000);
  worker.unref?.();
}

export function eventView(e) {
  return { id: e.public_id, type: e.type, status: e.status, attempts: e.attempts, last_code: e.last_code, last_error: e.last_error, created_at: e.created_at, delivered_at: e.delivered_at, next_try_at: e.next_try_at, data: json(e.data, {}) };
}

// ——— Платежи ———

export async function createPayment(conn, merchant, b = {}, { idem = null, kind = 'payment', orderId = null, subscriptionId = null, ageLimit = 0 } = {}) {
  if (idem) {
    const prev = await one('SELECT * FROM pay_payments WHERE merchant_id = ? AND idem_key = ?', [merchant.id, String(idem).slice(0, 80)], conn);
    if (prev) return prev;
  }
  const amount = amountOf(b.amount);
  const description = String(b.description || '').trim().slice(0, 255);
  if (!description) throw bad('invalid_description', 'description: за что платёж');
  const s = await getSettings();
  const minutes = Math.min(Math.max(Number(b.expires_minutes) || Number(s.pay_link_minutes) || 60, 5), 7 * 24 * 60);
  const id = await withUnique(async () => {
    const r = await q(
      `INSERT INTO pay_payments (public_id, merchant_id, kind, amount, description, items, metadata, return_url, cancel_url, idem_key, order_id, subscription_id, age_limit, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(3) + INTERVAL ? MINUTE)`,
      [publicId('pay'), merchant.id, kind, amount, description, JSON.stringify(itemsOf(b.items, amount)), JSON.stringify(metaOf(b.metadata)), siteUrl(b.return_url, 'return_url'),
        siteUrl(b.cancel_url, 'cancel_url'), idem ? String(idem).slice(0, 80) : null, orderId, subscriptionId, Math.max(0, Math.min(21, Number(b.age_limit ?? ageLimit) || 0)), minutes],
      conn,
    );
    return r.insertId;
  });
  return one('SELECT * FROM pay_payments WHERE id = ?', [id], conn);
}

const isExpired = (p) => p.status === 'pending' && new Date(p.expires_at) < new Date();

/** Платёж по публичному id; просроченный помечается expired. */
export async function loadPayment(publicIdValue, conn, { lock = false } = {}) {
  const p = await one(`SELECT * FROM pay_payments WHERE public_id = ?${lock ? ' FOR UPDATE' : ''}`, [String(publicIdValue || '')], conn);
  if (!p) throw payError(404, 'payment_not_found', 'Платёж не найден');
  if (isExpired(p)) {
    await q("UPDATE pay_payments SET status = 'expired' WHERE id = ? AND status = 'pending'", [p.id], conn);
    p.status = 'expired';
  }
  return p;
}

export const checkoutUrl = (p) => `${PAY_ORIGIN}/c/${p.public_id}`;

export function paymentView(p) {
  return {
    id: p.public_id,
    object: 'payment',
    kind: p.kind,
    amount: Number(p.amount),
    currency: CURRENCY,
    status: p.status,
    description: p.description,
    items: json(p.items, null),
    metadata: json(p.metadata, null) || {},
    url: checkoutUrl(p),
    return_url: p.return_url,
    vat: Number(p.vat),
    fee: Number(p.fee),
    net: p.status === 'pending' ? null : Number(p.amount) - Number(p.vat) - Number(p.fee),
    refunded: Number(p.refunded),
    method: p.method,
    created: Math.floor(new Date(p.created_at).getTime() / 1000),
    created_at: p.created_at,
    paid_at: p.paid_at,
    expires_at: p.expires_at,
  };
}

/** Публичные данные для страницы оплаты (без внутренних id). */
export async function checkoutInfo(pid) {
  const p = await loadPayment(pid);
  const m = await one('SELECT name, site_url, status FROM pay_merchants WHERE id = ?', [p.merchant_id]);
  const sub = p.subscription_id ? await one('SELECT period_months, status FROM pay_subscriptions WHERE id = ?', [p.subscription_id]) : null;
  const order = p.order_id ? await one('SELECT public_id, delivery, address, items, goods, delivery_fee FROM shop_orders WHERE id = ?', [p.order_id]) : null;
  return {
    id: p.public_id,
    kind: p.kind,
    amount: Number(p.amount),
    description: p.description,
    items: order ? json(order.items, []).map((i) => ({ name: i.name, qty: i.qty, price: i.price, total: i.total, digital: !!i.digital })) : json(p.items, null),
    status: p.status,
    merchant: { name: m.name, site_url: m.site_url, active: m.status === 'active' },
    age_limit: p.age_limit,
    expires_at: p.expires_at,
    paid_at: p.paid_at,
    return_url: p.return_url,
    cancel_url: p.cancel_url,
    subscription: sub ? { period_months: sub.period_months } : null,
    order: order ? { id: order.public_id, delivery: order.delivery, address: order.address, goods: Number(order.goods), delivery_fee: Number(order.delivery_fee) } : null,
    vat_bp: Number((await getSettings()).vat_bp || 0),
  };
}

/** Куда вернуть покупателя после оплаты или отмены. */
export function returnTo(p, status) {
  const base = status === 'paid' ? p.return_url : p.cancel_url || p.return_url;
  if (!base) return null;
  const u = new URL(base);
  u.searchParams.set('payment', p.public_id);
  u.searchParams.set('status', status);
  return u.href;
}

/**
 * Списать деньги по платежу внутри транзакции: со счёта покупателя мерчанту, НДС — в бюджет, комиссия — банку.
 * После оплаты — продолжение по виду платежа (заказ магазина, подписка) и событие payment.succeeded.
 */
export async function settle(conn, p, { accountId, userId, card = null, method, auto = false }) {
  const m = await one('SELECT * FROM pay_merchants WHERE id = ?', [p.merchant_id], conn);
  if (m.status !== 'active') throw bad('merchant_blocked', 'Магазин временно не принимает оплату');
  const acc = await one('SELECT * FROM accounts WHERE id = ?', [accountId], conn);
  if (!acc) throw notFound('Счёт не найден');
  assertSpendable(acc);
  if (acc.id === m.account_id) throw bad('self_payment', 'Нельзя оплатить со счёта самого магазина');
  if (p.age_limit > 0) {
    const u = await one('SELECT birth_date FROM bank_users WHERE id = ?', [userId], conn);
    if (!u?.birth_date || ageFrom(u.birth_date) < p.age_limit) throw bad('age_limit', `Покупка только с ${p.age_limit} лет (по паспорту БФ)`);
  }
  const s = await getSettings();
  const amount = Number(p.amount);
  const vat = vatIncluded(amount, Number(s.vat_bp || 0));
  const fee = percentOf(amount - vat, Number(s.online_fee_bp || 0));
  const entries = [{ account: acc.id, amount: -amount }, { account: m.account_id, amount: amount - vat - fee }];
  if (vat) entries.push({ account: await sys('BUDGET', conn), amount: vat });
  if (fee) entries.push({ account: await sys('TREASURY', conn), amount: fee });
  const r = await post(conn, {
    kind: 'online_payment',
    memo: `Оплата на сайте: ${m.name}`,
    entries,
    idem: `pay:${p.id}`,
    actor: { kind: 'bank', id: userId },
    cardId: card?.id || null,
    ref: { type: 'pay_payment', id: p.id },
    meta: { merchant: m.public_id, payment: p.public_id, vat, fee, auto },
  });
  if (r.duplicate) throw bad('already_paid', 'Платёж уже оплачен');
  await q("UPDATE pay_payments SET status = 'paid', vat = ?, fee = ?, method = ?, payer_bank_user_id = ?, payer_account_id = ?, card_id = ?, tx_id = ?, paid_at = NOW(3) WHERE id = ?",
    [vat, fee, method, userId, acc.id, card?.id || null, r.id, p.id], conn);
  if (!auto) await reviewIfLarge(conn, { accountId: acc.id, amount, kind: 'online_payment', txId: r.id, cardId: card?.id || null });
  const fresh = await one('SELECT * FROM pay_payments WHERE id = ?', [p.id], conn);
  if (p.kind === 'order') {
    const { onOrderPaid } = await import('./orders.js');
    await onOrderPaid(conn, fresh, { merchant: m, payerAccountId: acc.id, userId, txId: r.id });
  }
  if (p.kind === 'subscription' && !auto) await activateSubscription(conn, fresh, { accountId: acc.id, userId });
  await notify(conn, 'bank', userId, { title: `Оплата ${formatMoney(amount)}`, body: `${m.name}: ${p.description}`, link: '#/purchases' });
  await emitEvent(conn, m.id, 'payment.succeeded', paymentView(fresh));
  afterCommit(conn, () => publish(`pay:${p.public_id}`, { type: 'paid' }));
  return { tx: r.id, payment: fresh };
}

/** Оплата картой: номер, срок, PIN. Карта и PIN проверяются до транзакции (счётчик ошибок сохраняется). */
export async function payByCard(pid, { number, exp, pin }) {
  const pre = await loadPayment(pid);
  if (pre.status !== 'pending') throw bad('not_payable', pre.status === 'paid' ? 'Уже оплачено' : 'Платёж недействителен');
  if (pre.kind === 'subscription') throw bad('subscription_account', 'Подписка оплачивается со счёта ВлодБанка — войдите в банк на этой странице');
  const card = await authorizeCard({ number, exp, pin });
  const owner = await one('SELECT * FROM bank_users WHERE id = ?', [card.bank_user_id]);
  return tx(async (conn) => {
    const p = await loadPayment(pid, conn, { lock: true });
    if (p.status !== 'pending') throw bad('not_payable', 'Платёж недействителен');
    await checkCardLimits(conn, card, Number(p.amount));
    const res = await settle(conn, p, { accountId: card.account_id, userId: card.holder_user_id || owner.id, card, method: 'card' });
    return { ...res, redirect: returnTo(res.payment, 'paid') };
  });
}

/** Оплата со счёта ВлодБанка (покупатель вошёл в банк). */
export async function payByAccount(pid, user, accountId) {
  requireVerified(user);
  return tx(async (conn) => {
    const p = await loadPayment(pid, conn, { lock: true });
    if (p.status !== 'pending') throw bad('not_payable', p.status === 'paid' ? 'Уже оплачено' : 'Платёж недействителен');
    const acc = await ownAccount(user.id, accountId, conn);
    const res = await settle(conn, p, { accountId: acc.id, userId: user.id, method: 'account' });
    return { ...res, redirect: returnTo(res.payment, 'paid') };
  });
}

export async function cancelPayment(conn, merchant, pid, { byBuyer = false } = {}) {
  const p = await loadPayment(pid, conn, { lock: true });
  if (!byBuyer && p.merchant_id !== merchant.id) throw payError(404, 'payment_not_found', 'Платёж не найден');
  if (p.status !== 'pending') throw bad('not_pending', 'Отменить можно только неоплаченный платёж');
  await q("UPDATE pay_payments SET status = 'cancelled' WHERE id = ?", [p.id], conn);
  if (p.order_id) await q("UPDATE shop_orders SET status = 'cancelled' WHERE id = ? AND status = 'pending'", [p.order_id], conn);
  if (p.subscription_id) await q("UPDATE pay_subscriptions SET status = 'cancelled', cancelled_at = NOW(3) WHERE id = ? AND status = 'pending'", [p.subscription_id], conn);
  const fresh = await one('SELECT * FROM pay_payments WHERE id = ?', [p.id], conn);
  await emitEvent(conn, p.merchant_id, 'payment.cancelled', paymentView(fresh));
  return fresh;
}

// ——— Возвраты ———

/** Возврат: со счёта мерчанта покупателю, НДС — обратно из бюджета. Комиссия банка не возвращается. */
export async function refundPayment(conn, merchant, { payment: pid, amount, reason = null }) {
  const p = await loadPayment(pid, conn, { lock: true });
  if (p.merchant_id !== merchant.id) throw payError(404, 'payment_not_found', 'Платёж не найден');
  if (!['paid', 'partially_refunded'].includes(p.status)) throw bad('not_refundable', 'Вернуть можно только оплаченный платёж');
  const left = Number(p.amount) - Number(p.refunded);
  const sum = amount === undefined || amount === null ? left : amountOf(amount);
  if (sum > left) throw bad('refund_exceeds', `Можно вернуть не больше ${formatMoney(left)}`);
  if (p.kind === 'order') {
    const { refundOrderPayment } = await import('./orders.js');
    return refundOrderPayment(conn, merchant, p, { amount: sum, reason });
  }
  const vatBefore = Math.round((Number(p.vat) * Number(p.refunded)) / Number(p.amount));
  const vat = sum === left ? Number(p.vat) - vatBefore : Math.round((Number(p.vat) * sum) / Number(p.amount));
  return recordRefund(conn, merchant, p, { amount: sum, vat, reason });
}

/** Проводка возврата и событие refund.succeeded (общая для платежей и заказов). */
export async function recordRefund(conn, merchant, p, { amount, vat, reason, txId = null, skipLedger = false }) {
  let tx = txId;
  if (!skipLedger) {
    const entries = [{ account: merchant.account_id, amount: -(amount - vat) }, { account: p.payer_account_id, amount }];
    if (vat) entries.push({ account: await sys('BUDGET', conn), amount: -vat });
    const r = await post(conn, { kind: 'online_refund', memo: `Возврат: ${merchant.name}`, entries, ref: { type: 'pay_payment', id: p.id }, actor: { kind: 'bank', id: merchant.owner_bank_user_id } })
      .catch((err) => {
        if (err.code === 'insufficient_funds') throw bad('merchant_funds', 'На счёте магазина не хватает денег для возврата');
        throw err;
      });
    tx = r.id;
  }
  const rid = publicId('re');
  await q('INSERT INTO pay_refunds (public_id, payment_id, amount, vat, tx_id, reason) VALUES (?, ?, ?, ?, ?, ?)', [rid, p.id, amount, vat, tx, reason ? String(reason).slice(0, 255) : null], conn);
  const refunded = Number(p.refunded) + amount;
  await q('UPDATE pay_payments SET refunded = ?, status = ? WHERE id = ?', [refunded, refunded >= Number(p.amount) ? 'refunded' : 'partially_refunded', p.id], conn);
  if (p.payer_bank_user_id) await notify(conn, 'bank', p.payer_bank_user_id, { title: `Возврат ${formatMoney(amount)}`, body: merchant.name, link: '#/purchases' });
  const fresh = await one('SELECT * FROM pay_payments WHERE id = ?', [p.id], conn);
  const refund = { id: rid, object: 'refund', amount, vat, payment: p.public_id, reason: reason || null, status: 'succeeded' };
  await emitEvent(conn, merchant.id, 'refund.succeeded', { ...refund, payment_object: paymentView(fresh) });
  return { refund, payment: fresh };
}

export async function refundsOf(paymentId) {
  const rows = await q('SELECT * FROM pay_refunds WHERE payment_id = ? ORDER BY id', [paymentId]);
  return rows.map((r) => ({ id: r.public_id, amount: Number(r.amount), vat: Number(r.vat), reason: r.reason, created_at: r.created_at }));
}

// ——— Подписки ———

export function subscriptionView(s) {
  return {
    id: s.public_id,
    object: 'subscription',
    amount: Number(s.amount),
    currency: CURRENCY,
    description: s.description,
    period_months: s.period_months,
    status: s.status,
    next_month: s.next_month,
    fails: s.fails,
    metadata: json(s.metadata, null) || {},
    created_at: s.created_at,
    started_at: s.started_at,
    cancelled_at: s.cancelled_at,
  };
}

/** Подписка: первый платёж покупатель подтверждает на pay.bank.bln, дальше — автосписание каждый период. */
export async function createSubscription(conn, merchant, b = {}, { idem = null } = {}) {
  if (idem) {
    const prev = await one('SELECT * FROM pay_subscriptions WHERE merchant_id = ? AND idem_key = ?', [merchant.id, String(idem).slice(0, 80)], conn);
    if (prev) return { sub: prev, payment: await one('SELECT * FROM pay_payments WHERE subscription_id = ? ORDER BY id LIMIT 1', [prev.id], conn) };
  }
  const amount = amountOf(b.amount);
  const description = String(b.description || '').trim().slice(0, 255);
  if (!description) throw bad('invalid_description', 'description: за что подписка');
  const period = Number(b.period_months ?? 1);
  if (!Number.isInteger(period) || period < 1 || period > 12) throw bad('invalid_period', 'period_months: от 1 до 12 игровых месяцев');
  const id = await withUnique(async () => {
    const r = await q('INSERT INTO pay_subscriptions (public_id, merchant_id, amount, description, period_months, return_url, metadata, idem_key) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [publicId('sub'), merchant.id, amount, description, period, siteUrl(b.return_url, 'return_url'), JSON.stringify(metaOf(b.metadata)), idem ? String(idem).slice(0, 80) : null], conn);
    return r.insertId;
  });
  const payment = await createPayment(conn, merchant, { amount, description: `${description} (подписка)`, return_url: b.return_url, cancel_url: b.cancel_url, metadata: b.metadata }, { kind: 'subscription', subscriptionId: id });
  return { sub: await one('SELECT * FROM pay_subscriptions WHERE id = ?', [id], conn), payment };
}

async function activateSubscription(conn, p, { accountId, userId }) {
  const sub = await one('SELECT * FROM pay_subscriptions WHERE id = ? FOR UPDATE', [p.subscription_id], conn);
  if (!sub || sub.status !== 'pending') return;
  const month = await currentMonth(conn);
  await q("UPDATE pay_subscriptions SET status = 'active', payer_bank_user_id = ?, payer_account_id = ?, next_month = ?, started_at = NOW(3) WHERE id = ?", [userId, accountId, month + sub.period_months, sub.id], conn);
  await q('UPDATE pay_payments SET period_month = ? WHERE id = ?', [month, p.id], conn);
  await emitEvent(conn, sub.merchant_id, 'subscription.activated', subscriptionView(await one('SELECT * FROM pay_subscriptions WHERE id = ?', [sub.id], conn)));
}

export async function cancelSubscription(conn, sub, { by }) {
  if (sub.status === 'cancelled') throw bad('cancelled', 'Подписка уже отменена');
  await q("UPDATE pay_subscriptions SET status = 'cancelled', cancelled_at = NOW(3) WHERE id = ?", [sub.id], conn);
  const fresh = await one('SELECT * FROM pay_subscriptions WHERE id = ?', [sub.id], conn);
  await emitEvent(conn, sub.merchant_id, 'subscription.cancelled', { ...subscriptionView(fresh), cancelled_by: by });
  if (by === 'merchant' && sub.payer_bank_user_id) {
    const m = await one('SELECT name FROM pay_merchants WHERE id = ?', [sub.merchant_id], conn);
    await notify(conn, 'bank', sub.payer_bank_user_id, { title: 'Подписка отменена магазином', body: `${m.name}: ${sub.description}`, link: '#/purchases' });
  }
  return fresh;
}

/** Списание очередного периода подписки (каждый игровой месяц). */
export async function chargeSubscription(subId, month) {
  return tx(async (conn) => {
    const sub = await one('SELECT * FROM pay_subscriptions WHERE id = ? FOR UPDATE', [subId], conn);
    if (!sub || !['active', 'past_due'].includes(sub.status) || sub.next_month > month) return null;
    const merchant = await one('SELECT * FROM pay_merchants WHERE id = ?', [sub.merchant_id], conn);
    const idem = `sub:${sub.id}:${sub.next_month}:${sub.fails}`;
    const p = await createPayment(conn, merchant, { amount: Number(sub.amount), description: `${sub.description} (подписка)` }, { idem, kind: 'subscription', subscriptionId: sub.id });
    if (p.status === 'paid') return 'paid';
    try {
      await settle(conn, p, { accountId: sub.payer_account_id, userId: sub.payer_bank_user_id, method: 'account', auto: true });
    } catch (err) {
      if (!(err instanceof HttpError)) throw err;
      await q("UPDATE pay_payments SET status = 'cancelled' WHERE id = ?", [p.id], conn);
      const fails = sub.fails + 1;
      const status = fails >= SUB_MAX_FAILS ? 'cancelled' : 'past_due';
      await q(`UPDATE pay_subscriptions SET fails = ?, status = ?${status === 'cancelled' ? ', cancelled_at = NOW(3)' : ''} WHERE id = ?`, [fails, status, sub.id], conn);
      const fresh = await one('SELECT * FROM pay_subscriptions WHERE id = ?', [sub.id], conn);
      await emitEvent(conn, sub.merchant_id, status === 'cancelled' ? 'subscription.cancelled' : 'subscription.payment_failed', { ...subscriptionView(fresh), reason: err.message });
      await notify(conn, 'bank', sub.payer_bank_user_id, { title: status === 'cancelled' ? 'Подписка отменена: 3 неудачных списания' : 'Не удалось оплатить подписку', body: `${merchant.name}: ${err.message}`, link: '#/purchases' });
      return status;
    }
    await q('UPDATE pay_payments SET period_month = ? WHERE id = ?', [sub.next_month, p.id], conn);
    await q("UPDATE pay_subscriptions SET status = 'active', fails = 0, next_month = next_month + period_months WHERE id = ?", [sub.id], conn);
    await emitEvent(conn, sub.merchant_id, 'subscription.renewed', subscriptionView(await one('SELECT * FROM pay_subscriptions WHERE id = ?', [sub.id], conn)));
    return 'paid';
  });
}

onMonth('pay_subscriptions', async (month) => {
  const due = await q("SELECT id FROM pay_subscriptions WHERE status IN ('active','past_due') AND next_month <= ?", [month]);
  for (const s of due) {
    try { await chargeSubscription(s.id, month); } catch (e) { console.error('subscription charge', s.id, e); }
  }
});

/** Ошибки API без лишних полей: { error: { code, message } }. */
export function apiError(err) {
  if (err instanceof HttpError) return { status: err.statusCode, body: { error: { code: err.code, message: err.message } } };
  console.error(err);
  return { status: 500, body: { error: { code: 'server_error', message: 'Ошибка сервера ВлодБанка' } } };
}

export { unauthorized, forbidden };
