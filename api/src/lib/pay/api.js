// API госсайтов для серверов сайтов БалНета (этап Н9). Запрос идёт по сети: DNS → подключение к 50.1.0.10 → TLS → сюда.
//  pay.bank.bln/api/v1/…  — эквайринг ВлодБанка (ключ sk_live_… или pk_live_… в Authorization: Bearer);
//  mail.bln/oauth/…, gosuslugi.gov.bln/oauth/… — обмен кода на токен и данные пользователя (OAuth 2).
import { q, one, tx } from '../../db.js';
import { HttpError } from '../errors.js';
import {
  merchantByKey, createPayment, loadPayment, paymentView, cancelPayment, refundPayment, refundsOf, createSubscription, subscriptionView,
  cancelSubscription, eventView, apiError, payError, merchantView,
} from './core.js';
import { catalog, createOrder, orderView, refundOrderPayment } from './orders.js';
import { oauthHttp } from './oauth.js';

function parseJson(headers, body) {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
  if (!text.trim()) return {};
  const type = String(headers['content-type'] || '');
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw payError(400, 'invalid_json', 'Тело запроса — JSON');
  }
}

const out = (status, body, headers = {}) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body: Buffer.from(JSON.stringify(body)) });

async function orderOut(o, conn) {
  const p = o.payment_id ? await one('SELECT * FROM pay_payments WHERE id = ?', [o.payment_id], conn) : null;
  return { ...orderView(o), payment: p ? paymentView(p) : null };
}

async function ownPayment(merchant, id) {
  const p = await loadPayment(id);
  if (p.merchant_id !== merchant.id) throw payError(404, 'payment_not_found', 'Платёж не найден');
  return p;
}

async function ownOrder(merchant, id, conn, lock = false) {
  const o = await one(`SELECT * FROM shop_orders WHERE public_id = ? AND merchant_id = ?${lock ? ' FOR UPDATE' : ''}`, [String(id), merchant.id], conn);
  if (!o) throw payError(404, 'order_not_found', 'Заказ не найден');
  return o;
}

async function ownSub(merchant, id, conn) {
  const s = await one('SELECT * FROM pay_subscriptions WHERE public_id = ? AND merchant_id = ?', [String(id), merchant.id], conn);
  if (!s) throw payError(404, 'subscription_not_found', 'Подписка не найдена');
  return s;
}

const limitOf = (search) => Math.min(Math.max(Number(new URLSearchParams(search).get('limit')) || 20, 1), 100);

/** Эквайринг: маршруты /api/v1. */
async function payApi({ method, path, headers, body }) {
  const [rawPath, search = ''] = path.split('?');
  const parts = rawPath.replace(/^\/api\/v1\/?/, '').split('/').filter(Boolean);
  const idem = headers['idempotency-key'] ? String(headers['idempotency-key']).slice(0, 80) : null;
  const [res, id, action] = parts;
  const route = `${method} ${res || ''}${id ? '/:id' : ''}${action ? `/${action}` : ''}`;

  if (route === 'GET products') {
    const m = await merchantByKey(headers.authorization, { secret: false });
    return out(200, await catalog(m));
  }
  const m = await merchantByKey(headers.authorization);
  const b = method === 'POST' ? parseJson(headers, body) : {};
  switch (route) {
    case 'GET me':
      return out(200, { object: 'merchant', ...(await merchantView(m)), id: m.public_id, keys: undefined, account: undefined });
    case 'POST payments': {
      const p = await tx((conn) => createPayment(conn, m, b, { idem }));
      return out(200, paymentView(p));
    }
    case 'GET payments': {
      const rows = await q('SELECT * FROM pay_payments WHERE merchant_id = ? ORDER BY id DESC LIMIT ?', [m.id, limitOf(search)]);
      return out(200, { object: 'list', data: rows.map(paymentView) });
    }
    case 'GET payments/:id': {
      const p = await ownPayment(m, id);
      return out(200, { ...paymentView(p), refunds: await refundsOf(p.id) });
    }
    case 'POST payments/:id/cancel':
      return out(200, paymentView(await tx((conn) => cancelPayment(conn, m, id))));
    case 'GET payments/:id/refunds':
      return out(200, { object: 'list', data: await refundsOf((await ownPayment(m, id)).id) });
    case 'POST refunds': {
      const r = await tx((conn) => refundPayment(conn, m, { payment: b.payment, amount: b.amount, reason: b.reason }));
      return out(201, { ...r.refund, payment_object: paymentView(r.payment) });
    }
    case 'POST subscriptions': {
      const r = await tx((conn) => createSubscription(conn, m, b, { idem }));
      return out(201, { ...subscriptionView(r.sub), url: paymentView(r.payment).url, payment: paymentView(r.payment) });
    }
    case 'GET subscriptions': {
      const rows = await q('SELECT * FROM pay_subscriptions WHERE merchant_id = ? ORDER BY id DESC LIMIT ?', [m.id, limitOf(search)]);
      return out(200, { object: 'list', data: rows.map(subscriptionView) });
    }
    case 'GET subscriptions/:id':
      return out(200, subscriptionView(await ownSub(m, id)));
    case 'POST subscriptions/:id/cancel':
      return out(200, subscriptionView(await tx(async (conn) => cancelSubscription(conn, await ownSub(m, id, conn), { by: 'merchant' }))));
    case 'POST orders': {
      const r = await tx(async (conn) => {
        const o = await createOrder(conn, m, b, { idem });
        return orderOut(o.order, conn);
      });
      return out(201, r);
    }
    case 'GET orders': {
      const rows = await q('SELECT * FROM shop_orders WHERE merchant_id = ? ORDER BY id DESC LIMIT ?', [m.id, limitOf(search)]);
      return out(200, { object: 'list', data: rows.map((o) => orderView(o)) });
    }
    case 'GET orders/:id':
      return out(200, await orderOut(await ownOrder(m, id)));
    case 'POST orders/:id/refund': {
      const r = await tx(async (conn) => {
        const o = await ownOrder(m, id, conn, true);
        const p = await one('SELECT * FROM pay_payments WHERE id = ? FOR UPDATE', [o.payment_id], conn);
        if (!p || !['paid', 'partially_refunded'].includes(p.status)) throw payError(400, 'not_refundable', 'Заказ не оплачен');
        const lines = Array.isArray(b.items) && b.items.length ? b.items : null;
        const res2 = await refundOrderPayment(conn, m, p, { amount: Number(p.amount) - Number(p.refunded), reason: b.reason || null, lines });
        return { ...res2.refund, order: await orderOut(await one('SELECT * FROM shop_orders WHERE id = ?', [o.id], conn), conn) };
      });
      return out(201, r);
    }
    case 'GET events': {
      const rows = await q('SELECT * FROM pay_events WHERE merchant_id = ? ORDER BY id DESC LIMIT ?', [m.id, limitOf(search)]);
      return out(200, { object: 'list', data: rows.map(eventView) });
    }
    case 'GET events/:id': {
      const e = await one('SELECT * FROM pay_events WHERE public_id = ? AND merchant_id = ?', [String(id), m.id]);
      if (!e) throw payError(404, 'event_not_found', 'Событие не найдено');
      return out(200, eventView(e));
    }
    default:
      throw payError(404, 'not_found', `Нет такого метода: ${method} ${rawPath}. Документация — https://pay.bank.bln/docs`);
  }
}

/** HTTP-ответ госсайта по сети БалНета или null (этот путь госсайт серверам не отдаёт). */
let injector = null;
/** Связать с приложением Fastify: остальной API госсайтов (/api/…) отвечает серверам сайтов по токену bln_…. */
export function setGovInjector(fn) { injector = fn; }

async function restApi({ method, path, headers, body }) {
  const h = { ...headers };
  delete h.cookie; delete h.host; delete h['content-length'];
  const r = await injector({ method, url: path, headers: h, payload: body && body.length !== 0 ? body : undefined });
  const keep = Object.fromEntries(Object.entries(r.headers).filter(([k]) => /^(content-type|location|cache-control)$/i.test(k)));
  return { status: r.statusCode, headers: keep, body: r.rawPayload };
}

export async function govHttp(target, { method = 'GET', path = '/', headers = {}, body = null }) {
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const m = String(method).toUpperCase();
  try {
    if (target === 'app:pay' && path.startsWith('/api/v1')) return await payApi({ method: m, path, headers: h, body });
    const provider = target === 'app:mail' ? 'mail' : target === 'app:services' ? 'gov' : null;
    if (provider) {
      const r = await oauthHttp(provider, { method: m, path, headers: h, body });
      if (r) return out(r.status, r.body, r.headers || {});
    }
    if (injector && /^\/api\/(?!auth\/|admin\/)/.test(path)) return await restApi({ method: m, path, headers: h, body });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error('gov api', err);
    const e = apiError(err);
    return out(e.status, e.body);
  }
  return null;
}
