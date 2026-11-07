// Эквайринг ВлодБанка (этап Н9): страница оплаты pay.bank.bln, кабинет мерчанта, покупки и подписки покупателя,
// курьеры-игроки, онлайн-заказы в Кассе, вход для сайтов (OAuth) и разделы админки.
import { q, one, tx, json } from '../db.js';
import { bad, notFound, int, str } from '../lib/errors.js';
import { needBank, needGov, needPos, needAdmin, session, actorOf } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { accountView, requireVerified } from '../lib/bank.js';
import {
  createMerchant, ownMerchant, merchantView, rotateKeys, createPayment, paymentView, checkoutInfo, payByCard, payByAccount, cancelPayment,
  refundPayment, refundsOf, returnTo, loadPayment, subscriptionView, cancelSubscription, emitEvent, deliverEvent, eventView, siteUrl, PAY_ORIGIN,
} from '../lib/pay/core.js';
import { orderView, shopOrder, markReady, pickup, shipPhysical, courierJobs, takeJob, dropJob, confirmHandoff, decidePhysical, DELIVERY } from '../lib/pay/orders.js';
import {
  providerOf, authorizeInfo, authorize, createClient, ownClient, updateClient, rotateSecret, deleteClient, clientView, grantsOf, revokeGrant, PROVIDERS, SCOPE_TITLES,
} from '../lib/pay/oauth.js';
import { randomToken } from '../lib/ids.js';

const n = (v) => Number(v || 0);

async function merchantStats(m) {
  const r = await one(
    "SELECT COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(vat),0) AS vat, COALESCE(SUM(fee),0) AS fee, COALESCE(SUM(refunded),0) AS refunded FROM pay_payments WHERE merchant_id = ? AND status IN ('paid','partially_refunded','refunded')",
    [m.id],
  );
  const subs = await one("SELECT COUNT(*) AS n FROM pay_subscriptions WHERE merchant_id = ? AND status IN ('active','past_due')", [m.id]);
  const orders = await one("SELECT COUNT(*) AS n FROM shop_orders WHERE merchant_id = ? AND status IN ('paid','ready','delivering')", [m.id]);
  return { payments: n(r.cnt), amount: n(r.amount), vat: n(r.vat), fee: n(r.fee), refunded: n(r.refunded), net: n(r.amount) - n(r.vat) - n(r.fee) - n(r.refunded), active_subscriptions: n(subs.n), open_orders: n(orders.n) };
}

export async function payRoutes(app) {
  const bank = { preHandler: needBank({ active: true }) };

  // ——— Страница оплаты (pay.bank.bln/c/<id>) ———
  app.get('/checkout/:id', async (req) => {
    const info = await checkoutInfo(req.params.id);
    const s = await session(req, 'bank').catch(() => null);
    let payer = null;
    if (s && s.user.status === 'active') {
      const accounts = await q("SELECT * FROM accounts WHERE owner_kind = 'bank_user' AND owner_id = ? AND status = 'active' AND type IN ('current','savings','business','credit','child') ORDER BY is_primary DESC, id", [s.id]);
      payer = { name: s.user.full_name, verified: !!s.user.passport_verified, accounts: accounts.map(accountView) };
    }
    return { payment: info, payer };
  });
  app.post('/checkout/:id/card', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const b = req.body || {};
    const r = await payByCard(req.params.id, { number: b.number, exp: b.exp, pin: b.pin });
    return { ok: true, status: 'paid', redirect: r.redirect };
  });
  app.post('/checkout/:id/account', { ...bank, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const r = await payByAccount(req.params.id, req.bank.user, int(req.body?.account_id, 'счёт'));
    return { ok: true, status: 'paid', redirect: r.redirect };
  });
  app.post('/checkout/:id/cancel', async (req) => {
    const p = await tx((conn) => cancelPayment(conn, null, req.params.id, { byBuyer: true }));
    return { ok: true, redirect: returnTo(p, 'cancelled') };
  });

  // ——— Кабинет мерчанта ———
  app.get('/merchant-options', bank, async (req) => {
    const u = req.bank.user;
    const own = await q("SELECT * FROM accounts WHERE owner_kind = 'bank_user' AND owner_id = ? AND type = 'business' AND status <> 'closed'", [u.id]);
    const orgs = u.gov_user_id
      ? await q("SELECT a.*, o.name AS org_name FROM org_members m JOIN organizations o ON o.id = m.org_id AND o.status = 'active' JOIN accounts a ON a.id = o.account_id WHERE m.gov_user_id = ? AND m.role = 'director'", [u.gov_user_id])
      : [];
    const shops = await q("SELECT s.id, s.name, s.account_id FROM shops s LEFT JOIN pay_merchants m ON m.shop_id = s.id WHERE s.owner_id = ? AND s.status = 'active' AND m.id IS NULL", [u.id]);
    return {
      accounts: [...own.map((a) => ({ ...accountView(a), title: `${a.name} (ИП)` })), ...orgs.map((a) => ({ ...accountView(a), title: a.org_name }))],
      shops,
    };
  });
  app.get('/merchants', bank, async (req) => {
    const rows = await q('SELECT * FROM pay_merchants WHERE owner_bank_user_id = ? ORDER BY id', [req.bank.id]);
    return { merchants: await Promise.all(rows.map(async (m) => ({ ...(await merchantView(m)), stats: await merchantStats(m) }))) };
  });
  app.post('/merchants', bank, async (req) => {
    const r = await tx((conn) => createMerchant(conn, req.bank.user, req.body || {}));
    await audit(null, actorOf(req.bank), 'pay.merchant_create', 'pay_merchant', r.merchant.id, { name: r.merchant.name });
    return { merchant: await merchantView(r.merchant, { secret: true }), keys: r.keys };
  });
  app.get('/merchants/:id', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    return { merchant: { ...(await merchantView(m, { secret: true })), stats: await merchantStats(m) } };
  });
  app.patch('/merchants/:id', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const b = req.body || {};
    const set = [];
    const v = [];
    if (b.name !== undefined) { set.push('name = ?'); v.push(str(b.name, 'название', { min: 2, max: 80 })); }
    if (b.site_url !== undefined) { set.push('site_url = ?'); v.push(siteUrl(b.site_url, 'Сайт')); }
    if (b.webhook_url !== undefined) { set.push('webhook_url = ?'); v.push(siteUrl(b.webhook_url, 'Адрес вебхуков')); }
    if (b.courier_fee !== undefined) { set.push('courier_fee = ?'); v.push(int(b.courier_fee, 'стоимость доставки', { min: 0, max: 1e8 })); }
    if (b.delivery !== undefined) {
      const d = b.delivery || {};
      set.push('delivery = ?');
      v.push(JSON.stringify(Object.fromEntries(Object.keys(DELIVERY).map((k) => [k, !!d[k]]))));
    }
    if (set.length) await q(`UPDATE pay_merchants SET ${set.join(', ')} WHERE id = ?`, [...v, m.id]);
    return { merchant: await merchantView(await one('SELECT * FROM pay_merchants WHERE id = ?', [m.id]), { secret: true }) };
  });
  app.post('/merchants/:id/keys', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const keys = await tx((conn) => rotateKeys(conn, m.id));
    await audit(null, actorOf(req.bank), 'pay.keys_rotate', 'pay_merchant', m.id);
    return { keys };
  });
  app.post('/merchants/:id/webhook-secret', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const secret = `whsec_${randomToken(24)}`;
    await q('UPDATE pay_merchants SET webhook_secret = ? WHERE id = ?', [secret, m.id]);
    return { webhook_secret: secret };
  });
  app.post('/merchants/:id/webhook-test', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    if (!m.webhook_url) throw bad('no_webhook', 'Сначала укажите адрес вебхуков');
    const pid = await tx((conn) => emitEvent(conn, m.id, 'ping', { object: 'ping', merchant: m.public_id, message: 'Проверка вебхука ВлодБанка' }));
    const ev = await one('SELECT id FROM pay_events WHERE public_id = ?', [pid]);
    const r = await deliverEvent(ev.id);
    return { event: eventView(await one('SELECT * FROM pay_events WHERE id = ?', [ev.id])), delivered: r?.status === 'delivered' };
  });
  // Ссылка на оплату из кабинета — без своего сайта (счёт другу, оплата в чате).
  app.post('/merchants/:id/payments', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const p = await tx((conn) => createPayment(conn, m, { ...(req.body || {}), items: null, metadata: null }));
    return { payment: paymentView(p) };
  });
  app.get('/merchants/:id/payments', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const rows = await q(
      'SELECT p.*, u.full_name AS payer_name FROM pay_payments p LEFT JOIN bank_users u ON u.id = p.payer_bank_user_id WHERE p.merchant_id = ? ORDER BY p.id DESC LIMIT 200',
      [m.id],
    );
    return { payments: rows.map((p) => ({ ...paymentView(p), payer_name: p.payer_name || null })) };
  });
  app.get('/merchants/:id/payments/:pid', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const p = await loadPayment(req.params.pid);
    if (p.merchant_id !== m.id) throw notFound('Платёж не найден');
    return { payment: { ...paymentView(p), refunds: await refundsOf(p.id) } };
  });
  app.post('/merchants/:id/payments/:pid/refund', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const r = await tx((conn) => refundPayment(conn, m, { payment: req.params.pid, amount: req.body?.amount === '' ? undefined : req.body?.amount, reason: req.body?.reason }));
    return { refund: r.refund, payment: paymentView(r.payment) };
  });
  app.get('/merchants/:id/events', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const rows = await q('SELECT * FROM pay_events WHERE merchant_id = ? ORDER BY id DESC LIMIT 100', [m.id]);
    return { events: rows.map(eventView) };
  });
  app.post('/merchants/:id/events/:eid/resend', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const e = await one('SELECT * FROM pay_events WHERE public_id = ? AND merchant_id = ?', [req.params.eid, m.id]);
    if (!e) throw notFound('Событие не найдено');
    await q("UPDATE pay_events SET status = 'pending', attempts = 0, next_try_at = NOW(3) WHERE id = ?", [e.id]);
    await deliverEvent(e.id);
    return { event: eventView(await one('SELECT * FROM pay_events WHERE id = ?', [e.id])) };
  });
  app.get('/merchants/:id/subscriptions', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const rows = await q('SELECT s.*, u.full_name AS payer_name FROM pay_subscriptions s LEFT JOIN bank_users u ON u.id = s.payer_bank_user_id WHERE s.merchant_id = ? ORDER BY s.id DESC LIMIT 200', [m.id]);
    return { subscriptions: rows.map((s) => ({ ...subscriptionView(s), payer_name: s.payer_name || null })) };
  });
  app.post('/merchants/:id/subscriptions/:sid/cancel', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const s = await one('SELECT * FROM pay_subscriptions WHERE public_id = ? AND merchant_id = ?', [req.params.sid, m.id]);
    if (!s) throw notFound('Подписка не найдена');
    return { subscription: subscriptionView(await tx((conn) => cancelSubscription(conn, s, { by: 'merchant' }))) };
  });
  app.get('/merchants/:id/orders', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const rows = await q('SELECT * FROM shop_orders WHERE merchant_id = ? ORDER BY id DESC LIMIT 200', [m.id]);
    return { orders: rows.map((o) => orderView(o, { shop: true })) };
  });

  // ——— Покупатель: покупки на сайтах, заказы, подписки ———
  app.get('/purchases', bank, async (req) => {
    const pays = await q(
      "SELECT p.*, m.name AS merchant_name, m.site_url FROM pay_payments p JOIN pay_merchants m ON m.id = p.merchant_id WHERE p.payer_bank_user_id = ? AND p.status IN ('paid','partially_refunded','refunded') ORDER BY p.id DESC LIMIT 200",
      [req.bank.id],
    );
    const orders = await q('SELECT o.*, s.name AS shop_name FROM shop_orders o JOIN shops s ON s.id = o.shop_id WHERE o.buyer_bank_user_id = ? ORDER BY o.id DESC LIMIT 100', [req.bank.id]);
    const subs = await q('SELECT s.*, m.name AS merchant_name FROM pay_subscriptions s JOIN pay_merchants m ON m.id = s.merchant_id WHERE s.payer_bank_user_id = ? ORDER BY s.id DESC', [req.bank.id]);
    return {
      payments: pays.map((p) => ({ ...paymentView(p), merchant: p.merchant_name, site_url: p.site_url })),
      orders: orders.map((o) => ({ ...orderView(o, { buyer: true }), shop: o.shop_name })),
      subscriptions: subs.map((s) => ({ ...subscriptionView(s), merchant: s.merchant_name })),
    };
  });
  app.post('/subscriptions/:id/cancel', bank, async (req) => {
    const s = await one('SELECT * FROM pay_subscriptions WHERE public_id = ? AND payer_bank_user_id = ?', [req.params.id, req.bank.id]);
    if (!s) throw notFound('Подписка не найдена');
    return { subscription: subscriptionView(await tx((conn) => cancelSubscription(conn, s, { by: 'customer' }))) };
  });

  // ——— Курьеры БалНета ———
  app.get('/courier/jobs', bank, async (req) => ({ jobs: await courierJobs(req.bank.id) }));
  app.post('/courier/jobs/:id/take', bank, async (req) => {
    requireVerified(req.bank.user);
    const o = await tx((conn) => takeJob(conn, req.bank.user, req.params.id));
    return { order: orderView(o) };
  });
  app.post('/courier/jobs/:id/drop', bank, async (req) => ({ order: orderView(await tx((conn) => dropJob(conn, req.bank.user, req.params.id))) }));
  app.post('/courier/confirm', bank, async (req) => {
    const r = await tx((conn) => confirmHandoff(conn, req.bank.user, req.body?.token));
    return { order: orderView(r.order), tx: r.tx };
  });
}

// ——— Касса: онлайн-заказы магазина ———
export async function posOnlineRoutes(app) {
  const pos = { preHandler: needPos() };
  app.get('/online-orders', pos, async (req) => {
    const status = req.query?.status === 'all' ? null : ['paid', 'ready', 'delivering'];
    const rows = await q(`SELECT * FROM shop_orders WHERE shop_id = ? AND status <> 'pending'${status ? " AND status IN ('paid','ready','delivering')" : ''} ORDER BY id DESC LIMIT 200`, [req.pos.shopId]);
    const merchant = await one('SELECT id, public_id, name FROM pay_merchants WHERE shop_id = ?', [req.pos.shopId]);
    return { orders: rows.map((o) => orderView(o, { shop: true })), merchant };
  });
  app.post('/online-orders/:id/ready', pos, async (req) => ({ order: orderView(await tx(async (conn) => markReady(conn, await shopOrder(conn, req.pos.shopId, req.params.id))), { shop: true }) }));
  app.post('/online-orders/:id/pickup', pos, async (req) => ({ order: orderView(await tx(async (conn) => pickup(conn, await shopOrder(conn, req.pos.shopId, req.params.id), req.body?.code)), { shop: true }) }));
  app.post('/online-orders/pickup', pos, async (req) => {
    const code = String(req.body?.code || '').trim();
    if (!/^\d{6}$/.test(code)) throw bad('wrong_code', 'Код заказа — 6 цифр');
    const o = await one("SELECT id FROM shop_orders WHERE shop_id = ? AND pickup_code = ? AND status IN ('paid','ready')", [req.pos.shopId, code]);
    if (!o) throw notFound('Заказ с таким кодом не найден');
    return { order: orderView(await tx(async (conn) => pickup(conn, await shopOrder(conn, req.pos.shopId, o.id), code)), { shop: true }) };
  });
  app.post('/online-orders/:id/ship', pos, async (req) => ({ order: orderView(await tx(async (conn) => shipPhysical(conn, await shopOrder(conn, req.pos.shopId, req.params.id), { delivered: !!req.body?.delivered })), { shop: true }) }));
}

// ——— Вход для сайтов: OAuth 2 через ВлодПочту и ВлодУслуги ———
export async function oauthRoutes(app) {
  const gov = { preHandler: needGov() };
  app.get('/providers', async () => ({ providers: PROVIDERS, scopes: SCOPE_TITLES }));
  app.get('/:provider/authorize', gov, async (req) => authorizeInfo(providerOf(req.params.provider), req.gov.id, req.query || {}));
  app.post('/:provider/authorize', gov, async (req) => {
    const b = req.body || {};
    return authorize(providerOf(req.params.provider), req.gov.id, b.params || {}, !!b.approve);
  });
  app.get('/clients', gov, async (req) => {
    const rows = await q('SELECT * FROM oauth_clients WHERE owner_gov_user_id = ? ORDER BY id', [req.gov.id]);
    return { clients: rows.map((c) => clientView(c)) };
  });
  app.post('/clients', gov, async (req) => ({ client: await createClient(req.gov.id, req.body || {}) }));
  app.patch('/clients/:id', gov, async (req) => ({ client: await updateClient(await ownClient(req.gov.id, req.params.id), req.body || {}) }));
  app.post('/clients/:id/secret', gov, async (req) => ({ client: await rotateSecret(await ownClient(req.gov.id, req.params.id)) }));
  app.delete('/clients/:id', gov, async (req) => {
    await deleteClient(await ownClient(req.gov.id, req.params.id));
    return { ok: true };
  });
  app.get('/grants', gov, async (req) => ({ grants: await grantsOf(req.gov.id) }));
  app.delete('/grants/:clientId', gov, async (req) => {
    await revokeGrant(req.gov.id, req.params.clientId, String(req.query?.provider || 'mail'));
    return { ok: true };
  });
}

// ——— Админка: эквайринг, реальная доставка, приложения OAuth ———
export async function adminPayRoutes(app) {
  app.addHook('preHandler', needAdmin());
  app.get('/overview', async () => {
    const t = await one("SELECT COUNT(*) AS cnt, COALESCE(SUM(amount),0) AS amount, COALESCE(SUM(vat),0) AS vat, COALESCE(SUM(fee),0) AS fee, COALESCE(SUM(refunded),0) AS refunded FROM pay_payments WHERE status IN ('paid','partially_refunded','refunded')");
    const m = await one("SELECT COUNT(*) AS n, SUM(status = 'blocked') AS blocked FROM pay_merchants");
    const s = await one("SELECT COUNT(*) AS n FROM pay_subscriptions WHERE status IN ('active','past_due')");
    const ev = await one("SELECT SUM(status = 'failed') AS failed, SUM(status = 'pending') AS pending FROM pay_events");
    const ph = await one("SELECT COUNT(*) AS n FROM shop_orders WHERE physical_status = 'pending'");
    const c = await one('SELECT COUNT(*) AS n FROM oauth_clients');
    return {
      payments: n(t.cnt), amount: n(t.amount), vat: n(t.vat), fee: n(t.fee), refunded: n(t.refunded), merchants: n(m.n), blocked: n(m.blocked),
      subscriptions: n(s.n), webhooks_failed: n(ev.failed), webhooks_pending: n(ev.pending), physical_pending: n(ph.n), oauth_clients: n(c.n),
    };
  });
  app.get('/merchants', async () => {
    const rows = await q('SELECT m.*, u.full_name AS owner_name FROM pay_merchants m JOIN bank_users u ON u.id = m.owner_bank_user_id ORDER BY m.id DESC LIMIT 500');
    return { merchants: await Promise.all(rows.map(async (m) => ({ ...(await merchantView(m)), owner_name: m.owner_name, stats: await merchantStats(m) }))) };
  });
  app.post('/merchants/:id/block', async (req) => {
    const id = int(req.params.id, 'id');
    const blocked = !!req.body?.blocked;
    await q('UPDATE pay_merchants SET status = ? WHERE id = ?', [blocked ? 'blocked' : 'active', id]);
    await audit(null, actorOf(req.actor), blocked ? 'pay.merchant_block' : 'pay.merchant_unblock', 'pay_merchant', id, { reason: req.body?.reason || null });
    return { ok: true };
  });
  app.get('/payments', async () => {
    const rows = await q('SELECT p.*, m.name AS merchant_name, u.full_name AS payer_name FROM pay_payments p JOIN pay_merchants m ON m.id = p.merchant_id LEFT JOIN bank_users u ON u.id = p.payer_bank_user_id ORDER BY p.id DESC LIMIT 300');
    return { payments: rows.map((p) => ({ ...paymentView(p), merchant: p.merchant_name, payer_name: p.payer_name })) };
  });
  app.get('/physical', async (req) => {
    const all = req.query?.all === '1';
    const rows = await q(
      `SELECT o.*, s.name AS shop_name, u.full_name AS buyer_name, u.email AS buyer_email FROM shop_orders o JOIN shops s ON s.id = o.shop_id LEFT JOIN bank_users u ON u.id = o.buyer_bank_user_id
       WHERE o.delivery = 'physical' AND o.physical_status IS NOT NULL${all ? '' : " AND o.physical_status = 'pending'"} ORDER BY o.id DESC LIMIT 200`,
    );
    return { orders: rows.map((o) => ({ ...orderView(o, { shop: true }), shop: o.shop_name, buyer: o.buyer_name, buyer_email: o.buyer_email })) };
  });
  app.post('/physical/:id', async (req) => {
    const o = await tx((conn) => decidePhysical(conn, req.params.id, { approve: !!req.body?.approve, note: req.body?.note || null, adminId: req.actor.id }));
    await audit(null, actorOf(req.actor), req.body?.approve ? 'pay.physical_approve' : 'pay.physical_reject', 'shop_order', o.id, { note: req.body?.note || null });
    return { order: orderView(o, { shop: true }) };
  });
  app.get('/oauth-clients', async () => {
    const rows = await q('SELECT c.*, g.display_name AS owner_name, (SELECT COUNT(*) FROM oauth_grants x WHERE x.client_id = c.id) AS users FROM oauth_clients c JOIN gov_users g ON g.id = c.owner_gov_user_id ORDER BY c.id DESC LIMIT 500');
    return { clients: rows.map((c) => ({ ...clientView(c), owner_name: c.owner_name, users: n(c.users) })) };
  });
  app.post('/oauth-clients/:id/block', async (req) => {
    const id = int(req.params.id, 'id');
    await q('UPDATE oauth_clients SET status = ? WHERE id = ?', [req.body?.blocked ? 'blocked' : 'active', id]);
    if (req.body?.blocked) await q('DELETE FROM oauth_tokens WHERE client_id = ?', [id]);
    await audit(null, actorOf(req.actor), req.body?.blocked ? 'oauth.client_block' : 'oauth.client_unblock', 'oauth_client', id);
    return { ok: true };
  });
}

export { PAY_ORIGIN, json };
