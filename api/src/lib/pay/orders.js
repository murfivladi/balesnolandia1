// Интернет-магазин на складе Кассы (этап Н9): каталог для сайта, заказ с оплатой через эквайринг, чек в Кассе
// (источник «онлайн»: склад, кухня, баллы, отчёты, возвраты — как у обычной продажи), доставка:
// самовывоз по коду, курьер-игрок с подтверждением по QR, цифровой товар сразу после оплаты,
// реальная доставка — не чаще раза в неделю на покупателя и только после одобрения админа.
import { q, one, json, afterCommit } from '../../db.js';
import { bad, notFound, forbidden } from '../errors.js';
import { post } from '../ledger.js';
import { getSettings } from '../settings.js';
import { notify } from '../notify.js';
import { publish } from '../hub.js';
import { randomDigits, randomToken, withUnique } from '../ids.js';
import { primaryAccount } from '../bank.js';
import { accrueCashback } from '../finance.js';
import { buildItems, finalize, loadSale, refundSale, QTY_ONE } from '../pos.js';
import { formatMoney, vatIncluded } from '@bln/shared/money.js';
import { createPayment, emitEvent, publicId, recordRefund, siteUrl, paymentView } from './core.js';

export const DELIVERY = { pickup: 'Самовывоз', courier: 'Курьер', digital: 'Цифровой товар', physical: 'Реальная доставка' };
const DEFAULT_DELIVERY = { pickup: true, courier: false, digital: true, physical: false };

export const deliveryOf = (m) => ({ ...DEFAULT_DELIVERY, ...(json(m.delivery, null) || {}) });

async function shopOf(conn, merchant) {
  if (!merchant.shop_id) throw bad('no_shop', 'Магазин эквайринга не связан с магазином Кассы — подключите его в кабинете pay.bank.bln');
  const shop = await one('SELECT * FROM shops WHERE id = ?', [merchant.shop_id], conn);
  if (!shop || shop.status !== 'active') throw bad('shop_closed', 'Магазин Кассы закрыт');
  return shop;
}

/** Каталог для сайта: товары с отметкой «продаётся онлайн». */
export async function catalog(merchant) {
  const shop = await shopOf(null, merchant);
  const rows = await q('SELECT * FROM products WHERE shop_id = ? AND online = 1 AND active = 1 AND deleted_at IS NULL ORDER BY category, name', [shop.id]);
  return {
    shop: { name: shop.name, address: shop.address || null },
    delivery: { ...deliveryOf(merchant), courier_fee: Number(merchant.courier_fee) },
    products: rows.map((p) => ({
      id: p.id,
      name: p.name,
      category: p.category || null,
      price: Number(p.price),
      unit: p.unit,
      age_limit: p.age_limit,
      digital: !!p.digital_content,
      in_stock: p.track_stock ? Math.max(0, Number(p.stock_milli)) / QTY_ONE : null,
      photo: p.photo && String(p.photo).length < 200000 ? p.photo : null,
    })),
  };
}

function lineQty(l, unit) {
  const raw = l.qty_milli !== undefined ? Number(l.qty_milli) : Math.round(Number(l.qty ?? 1) * QTY_ONE);
  if (!Number.isSafeInteger(raw) || raw <= 0) throw bad('invalid_qty', 'Неверное количество');
  if (unit === 'pcs' && raw % QTY_ONE) throw bad('invalid_qty', 'Штучный товар — целое количество');
  return raw;
}

/** Заказ с сайта: позиции и цены — только из каталога Кассы, сумма считается здесь. */
export async function createOrder(conn, merchant, b = {}, { idem = null } = {}) {
  if (idem) {
    const prev = await one('SELECT * FROM pay_payments WHERE merchant_id = ? AND idem_key = ?', [merchant.id, String(idem).slice(0, 80)], conn);
    if (prev?.order_id) return { order: await one('SELECT * FROM shop_orders WHERE id = ?', [prev.order_id], conn), payment: prev };
  }
  const shop = await shopOf(conn, merchant);
  const lines = Array.isArray(b.items) ? b.items : [];
  if (!lines.length || lines.length > 50) throw bad('empty_order', 'items: от 1 до 50 позиций');
  const ids = [...new Set(lines.map((l) => Number(l.product_id)))];
  const rows = await q(`SELECT * FROM products WHERE shop_id = ? AND deleted_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`, [shop.id, ...ids.map((x) => x || 0)], conn);
  const byId = new Map(rows.map((p) => [p.id, p]));
  const prepared = lines.map((l) => {
    const p = byId.get(Number(l.product_id));
    if (!p || !p.online || !p.active) throw bad('product_not_found', `Товар ${l.product_id} не продаётся онлайн`);
    return { product_id: p.id, qty_milli: lineQty(l, p.unit) };
  });
  const built = await buildItems(conn, shop.id, prepared, { checkStock: true, lock: false });
  const items = built.map((it) => {
    const p = byId.get(it.product_id);
    return { product_id: it.product_id, name: it.name, unit: it.unit, qty_milli: it.qty_milli, qty: it.qty_milli / QTY_ONE, price: it.price, total: it.total, age_limit: it.age_limit, digital: !!p.digital_content };
  });
  const allDigital = items.every((i) => i.digital);
  const delivery = String(b.delivery || (allDigital ? 'digital' : 'pickup'));
  if (!DELIVERY[delivery]) throw bad('invalid_delivery', 'delivery: pickup, courier, digital или physical');
  const allowed = deliveryOf(merchant);
  if (!allowed[delivery]) throw bad('delivery_off', `Магазин не предлагает способ «${DELIVERY[delivery]}»`);
  if (delivery === 'digital' && !allDigital) throw bad('not_digital', 'В заказе есть не цифровые товары — выберите самовывоз или доставку');
  const address = String(b.address || '').trim().slice(0, 255) || null;
  if ((delivery === 'courier' || delivery === 'physical') && (!address || address.length < 5)) throw bad('need_address', 'Укажите адрес доставки');
  const goods = items.reduce((s, i) => s + i.total, 0);
  const fee = delivery === 'courier' ? Number(merchant.courier_fee) : 0;
  const total = goods + fee;
  const ageLimit = Math.max(0, ...items.map((i) => i.age_limit || 0));
  const orderId = await withUnique(async () => {
    const r = await q(
      'INSERT INTO shop_orders (public_id, shop_id, merchant_id, delivery, address, contact, items, goods, delivery_fee, total) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [publicId('ord'), shop.id, merchant.id, delivery, address, String(b.contact || '').slice(0, 120) || null, JSON.stringify(items), goods, fee, total],
      conn,
    );
    return r.insertId;
  });
  const payment = await createPayment(conn, merchant, {
    amount: total,
    description: `Заказ в «${shop.name}»`,
    return_url: b.return_url,
    cancel_url: b.cancel_url,
    metadata: b.metadata,
  }, { idem, kind: 'order', orderId, ageLimit });
  await q('UPDATE shop_orders SET payment_id = ? WHERE id = ?', [payment.id, orderId], conn);
  return { order: await one('SELECT * FROM shop_orders WHERE id = ?', [orderId], conn), payment };
}

/** Реальная доставка — не чаще раза в N реальных дней на покупателя. */
async function checkPhysicalLimit(conn, userId, orderId) {
  const days = Number((await getSettings()).physical_delivery_days) || 7;
  const prev = await one(
    "SELECT id, paid_at FROM shop_orders WHERE buyer_bank_user_id = ? AND delivery = 'physical' AND id <> ? AND physical_status IN ('pending','approved','shipped') AND paid_at > NOW(3) - INTERVAL ? DAY LIMIT 1",
    [userId, orderId, days],
    conn,
  );
  if (prev) throw bad('physical_limit', `Реальная доставка — не чаще раза в ${days} дн. Выберите самовывоз или курьера БалНета`);
}

/** Оплата заказа (внутри транзакции платежа): чек в Кассе, склад, кухня, доставка. */
export async function onOrderPaid(conn, payment, { merchant, payerAccountId, userId, txId }) {
  const order = await one('SELECT * FROM shop_orders WHERE id = ? FOR UPDATE', [payment.order_id], conn);
  if (!order || order.status !== 'pending') throw bad('order_closed', 'Заказ уже оплачен или отменён');
  const shop = await one('SELECT * FROM shops WHERE id = ?', [order.shop_id], conn);
  if (!shop || shop.status !== 'active') throw bad('shop_closed', 'Магазин закрыт');
  if (order.delivery === 'physical') await checkPhysicalLimit(conn, userId, order.id);
  const items = json(order.items, []);
  // Повторная проверка склада с блокировкой строк товаров: за время оплаты товар могли купить в зале.
  const built = await buildItems(conn, shop.id, items.map((i) => ({ product_id: i.product_id, qty_milli: i.qty_milli })), { checkStock: true });
  const goods = built.reduce((s, i) => s + i.total, 0);
  if (goods !== Number(order.goods)) throw bad('price_changed', 'Цены в магазине изменились — оформите заказ заново');
  const owner = await one("SELECT * FROM shop_staff WHERE shop_id = ? AND role = 'owner' AND active = 1 ORDER BY id LIMIT 1", [shop.id], conn);
  if (!owner) throw bad('shop_closed', 'У магазина нет владельца в Кассе');
  const vatBp = Number((await getSettings()).vat_bp || 0);
  const lines = built.map((it) => ({ ...it, vat: vatIncluded(it.total, vatBp) }));
  if (Number(order.delivery_fee) > 0) lines.push({ product_id: null, name: 'Доставка курьером', unit: 'pcs', qty_milli: QTY_ONE, price: Number(order.delivery_fee), total: Number(order.delivery_fee), vat: vatIncluded(Number(order.delivery_fee), vatBp), age_limit: 0, variant_id: null, modifiers: null, sent: 0 });
  const total = Number(order.total);
  const vat = lines.reduce((s, i) => s + i.vat, 0);
  const sale = await q(
    "INSERT INTO sales (shop_id, shift_id, staff_id, status, subtotal, discount, total, vat, vat_bp, source, customer_user_id) VALUES (?, NULL, ?, 'open', ?, 0, ?, ?, ?, 'online', ?)",
    [shop.id, owner.id, total, total, vat, vatBp, userId],
    conn,
  );
  for (const it of lines) {
    await q('INSERT INTO sale_items (sale_id, product_id, name, unit, qty_milli, price, discount, total, vat, age_limit, variant_id, modifiers, sent_to_kitchen) VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, NULL, NULL, 0)',
      [sale.insertId, it.product_id, it.name, it.unit, it.qty_milli, it.price, it.total, it.vat, it.age_limit || 0], conn);
  }
  await q("INSERT INTO sale_payments (sale_id, method, amount, tip, payer_account_id, tx_id) VALUES (?, 'online', ?, 0, ?, ?)", [sale.insertId, total, payerAccountId, txId], conn);
  await q('UPDATE sales SET paid = ? WHERE id = ?', [total, sale.insertId], conn);
  const loaded = await loadSale(conn, sale.insertId);
  await finalize(conn, loaded, shop);
  await accrueCashback(conn, { accountId: payerAccountId, shop, goods, saleId: sale.insertId });

  // Доставка: цифровые товары выдаются сразу, самовывоз — по коду, курьер — по QR у покупателя.
  const digital = [];
  for (const it of items.filter((i) => i.digital)) {
    const p = await one('SELECT digital_content FROM products WHERE id = ?', [it.product_id], conn);
    digital.push({ name: it.name, content: p?.digital_content || '' });
  }
  const set = { sale_id: sale.insertId, buyer_bank_user_id: userId, status: 'paid', digital: digital.length ? JSON.stringify(digital) : null };
  if (order.delivery === 'digital') Object.assign(set, { status: 'delivered' });
  if (order.delivery === 'pickup') set.pickup_code = randomDigits(6);
  if (order.delivery === 'courier') set.handoff_token = `ho_${randomToken(16)}`;
  if (order.delivery === 'physical') set.physical_status = 'pending';
  const keys = Object.keys(set);
  await q(`UPDATE shop_orders SET ${keys.map((k) => `${k} = ?`).join(', ')}, paid_at = NOW(3)${set.status === 'delivered' ? ', delivered_at = NOW(3)' : ''} WHERE id = ?`, [...keys.map((k) => set[k]), order.id], conn);
  await notify(conn, 'bank', shop.owner_id, { title: `Онлайн-заказ ${formatMoney(total)}`, body: `${shop.name}: ${DELIVERY[order.delivery]}`, link: '#/online' });
  const fresh = await one('SELECT * FROM shop_orders WHERE id = ?', [order.id], conn);
  afterCommit(conn, () => publish(`shop:${shop.id}`, { type: 'online_order', id: order.id }));
  await emitEvent(conn, merchant.id, 'order.paid', orderView(fresh));
  if (fresh.status === 'delivered') await emitEvent(conn, merchant.id, 'order.delivered', orderView(fresh));
}

export function orderView(o, { buyer = false, shop = false } = {}) {
  const v = {
    id: o.public_id,
    object: 'order',
    status: o.status,
    delivery: o.delivery,
    delivery_title: DELIVERY[o.delivery],
    address: o.address,
    contact: o.contact,
    items: json(o.items, []).map((i) => ({ product_id: i.product_id, name: i.name, unit: i.unit, qty: i.qty, price: i.price, total: i.total, digital: !!i.digital })),
    goods: Number(o.goods),
    delivery_fee: Number(o.delivery_fee),
    total: Number(o.total),
    physical_status: o.physical_status,
    created_at: o.created_at,
    paid_at: o.paid_at,
    ready_at: o.ready_at,
    delivered_at: o.delivered_at,
  };
  if (buyer) {
    v.pickup_code = o.status === 'delivered' ? null : o.pickup_code;
    v.handoff_token = o.status === 'delivered' ? null : o.handoff_token;
    v.digital = json(o.digital, null);
    v.sale_id = o.sale_id;
  }
  if (shop) {
    v.internal_id = o.id;
    v.sale_id = o.sale_id;
    v.has_courier = !!o.courier_bank_user_id;
    v.admin_note = o.admin_note;
  }
  return v;
}

async function orderEvent(conn, order, type) {
  const fresh = await one('SELECT * FROM shop_orders WHERE id = ?', [order.id], conn);
  await emitEvent(conn, order.merchant_id, type, orderView(fresh));
  afterCommit(conn, () => publish(`shop:${order.shop_id}`, { type: 'online_order', id: order.id }));
  return fresh;
}

// ——— Касса: сборка и выдача ———

export async function shopOrder(conn, shopId, id, { lock = true } = {}) {
  const o = await one(`SELECT * FROM shop_orders WHERE id = ? AND shop_id = ?${lock ? ' FOR UPDATE' : ''}`, [Number(id) || 0, shopId], conn);
  if (!o) throw notFound('Заказ не найден');
  return o;
}

/** Заказ собран: самовывоз ждёт покупателя, курьерский — появляется у курьеров. */
export async function markReady(conn, order) {
  if (order.status !== 'paid') throw bad('bad_status', 'Собрать можно только оплаченный заказ');
  if (order.delivery === 'physical' && order.physical_status !== 'approved') throw bad('need_approval', 'Реальную доставку сначала одобряет админ');
  await q("UPDATE shop_orders SET status = 'ready', ready_at = NOW(3) WHERE id = ?", [order.id], conn);
  const shop = await one('SELECT name FROM shops WHERE id = ?', [order.shop_id], conn);
  const text = { pickup: `Заберите заказ: код ${order.pickup_code}`, courier: 'Ищем курьера БалНета', physical: 'Заказ передаётся в реальную доставку' }[order.delivery] || 'Заказ готов';
  if (order.buyer_bank_user_id) await notify(conn, 'bank', order.buyer_bank_user_id, { title: `Заказ в «${shop.name}» собран`, body: text, link: '#/purchases' });
  return orderEvent(conn, order, 'order.ready');
}

/** Выдача самовывоза по 6-значному коду покупателя. */
export async function pickup(conn, order, code) {
  if (order.delivery !== 'pickup') throw bad('not_pickup', 'Это заказ не на самовывоз');
  if (!['paid', 'ready'].includes(order.status)) throw bad('bad_status', 'Заказ уже выдан или отменён');
  if (String(code || '').trim() !== order.pickup_code) throw bad('wrong_code', 'Неверный код заказа');
  await q("UPDATE shop_orders SET status = 'delivered', delivered_at = NOW(3) WHERE id = ?", [order.id], conn);
  if (order.buyer_bank_user_id) await notify(conn, 'bank', order.buyer_bank_user_id, { title: 'Заказ выдан', body: 'Спасибо за покупку!', link: '#/purchases' });
  return orderEvent(conn, order, 'order.delivered');
}

/** Реальная доставка отправлена (после одобрения админа) и получена. */
export async function shipPhysical(conn, order, { delivered = false } = {}) {
  if (order.delivery !== 'physical') throw bad('not_physical', 'Это не реальная доставка');
  if (order.physical_status !== 'approved' && order.physical_status !== 'shipped') throw bad('need_approval', 'Реальную доставку сначала одобряет админ');
  if (delivered) {
    await q("UPDATE shop_orders SET status = 'delivered', physical_status = 'shipped', delivered_at = NOW(3) WHERE id = ?", [order.id], conn);
    return orderEvent(conn, order, 'order.delivered');
  }
  await q("UPDATE shop_orders SET status = 'delivering', physical_status = 'shipped', taken_at = NOW(3) WHERE id = ?", [order.id], conn);
  return orderEvent(conn, order, 'order.shipped');
}

// ——— Курьеры-игроки ———

export async function courierJobs(userId) {
  const rows = await q(
    `SELECT o.*, s.name AS shop_name, s.address AS shop_address FROM shop_orders o JOIN shops s ON s.id = o.shop_id
     WHERE o.delivery = 'courier' AND ((o.status = 'ready' AND o.courier_bank_user_id IS NULL) OR (o.status = 'delivering' AND o.courier_bank_user_id = ?))
     ORDER BY o.ready_at LIMIT 100`,
    [userId],
  );
  return rows.map((o) => ({
    id: o.id, order: o.public_id, shop: o.shop_name, from: o.shop_address, to: o.address, contact: o.contact, fee: Number(o.delivery_fee),
    items: json(o.items, []).map((i) => `${i.name} × ${i.qty}`), status: o.status, mine: o.courier_bank_user_id === userId, ready_at: o.ready_at,
  }));
}

export async function takeJob(conn, user, id) {
  const o = await one("SELECT * FROM shop_orders WHERE id = ? AND delivery = 'courier' FOR UPDATE", [Number(id) || 0], conn);
  if (!o) throw notFound('Заказ не найден');
  if (o.status !== 'ready' || o.courier_bank_user_id) throw bad('taken', 'Заказ уже взял другой курьер');
  if (o.buyer_bank_user_id === user.id) throw bad('own_order', 'Свой заказ доставить нельзя');
  const shop = await one('SELECT owner_id FROM shops WHERE id = ?', [o.shop_id], conn);
  if (shop.owner_id === user.id) throw bad('own_shop', 'Владелец магазина не может быть курьером своего заказа');
  await q("UPDATE shop_orders SET status = 'delivering', courier_bank_user_id = ?, taken_at = NOW(3) WHERE id = ?", [user.id, o.id], conn);
  if (o.buyer_bank_user_id) await notify(conn, 'bank', o.buyer_bank_user_id, { title: 'Курьер везёт заказ', body: `${user.full_name}. Покажите QR из раздела «Покупки» при получении`, link: '#/purchases' });
  return orderEvent(conn, o, 'order.delivering');
}

export async function dropJob(conn, user, id) {
  const o = await one('SELECT * FROM shop_orders WHERE id = ? AND courier_bank_user_id = ? FOR UPDATE', [Number(id) || 0, user.id], conn);
  if (!o || o.status !== 'delivering') throw notFound('Заказ не найден');
  await q("UPDATE shop_orders SET status = 'ready', courier_bank_user_id = NULL, taken_at = NULL WHERE id = ?", [o.id], conn);
  return orderEvent(conn, o, 'order.ready');
}

/** Курьер сканирует QR покупателя: заказ вручён, оплата доставки — курьеру с бизнес-счёта магазина. */
export async function confirmHandoff(conn, user, token) {
  const o = await one('SELECT * FROM shop_orders WHERE handoff_token = ? FOR UPDATE', [String(token || '').trim()], conn);
  if (!o) throw notFound('QR заказа не найден');
  if (o.courier_bank_user_id !== user.id) throw forbidden('Этот заказ везёт другой курьер');
  if (o.status !== 'delivering') throw bad('bad_status', 'Заказ уже вручён или отменён');
  const shop = await one('SELECT * FROM shops WHERE id = ?', [o.shop_id], conn);
  const to = await primaryAccount(user.id, conn);
  let txId = null;
  if (Number(o.delivery_fee) > 0 && to) {
    const r = await post(conn, {
      kind: 'courier_fee',
      memo: `Доставка заказа: ${shop.name}`,
      entries: [{ account: shop.account_id, amount: -Number(o.delivery_fee) }, { account: to.id, amount: Number(o.delivery_fee) }],
      idem: `courier:${o.id}`,
      ref: { type: 'shop_order', id: o.id },
      actor: { kind: 'bank', id: user.id },
    }).catch((err) => {
      if (err.code === 'insufficient_funds') throw bad('shop_funds', 'На бизнес-счёте магазина не хватает денег на оплату доставки — свяжитесь с магазином');
      throw err;
    });
    txId = r.id;
  }
  await q("UPDATE shop_orders SET status = 'delivered', delivered_at = NOW(3) WHERE id = ?", [o.id], conn);
  if (o.buyer_bank_user_id) await notify(conn, 'bank', o.buyer_bank_user_id, { title: 'Заказ вручён', body: shop.name, link: '#/purchases' });
  await notify(conn, 'bank', user.id, { title: `Доставка выполнена: +${formatMoney(o.delivery_fee)}`, body: shop.name });
  const fresh = await orderEvent(conn, o, 'order.delivered');
  return { order: fresh, tx: txId };
}

// ——— Админ: очередь реальной доставки ———

export async function decidePhysical(conn, id, { approve, note = null, adminId }) {
  const o = await one("SELECT * FROM shop_orders WHERE id = ? AND delivery = 'physical' FOR UPDATE", [Number(id) || 0], conn);
  if (!o) throw notFound('Заказ не найден');
  if (o.physical_status !== 'pending') throw bad('decided', 'Заявка уже рассмотрена');
  await q('UPDATE shop_orders SET physical_status = ?, admin_note = ?, decided_by = ? WHERE id = ?', [approve ? 'approved' : 'rejected', note ? String(note).slice(0, 255) : null, adminId, o.id], conn);
  const shop = await one('SELECT * FROM shops WHERE id = ?', [o.shop_id], conn);
  if (!approve) {
    // Отказ: заказ отменяется, деньги возвращаются покупателю целиком.
    const merchant = await one('SELECT * FROM pay_merchants WHERE id = ?', [o.merchant_id], conn);
    const p = await one('SELECT * FROM pay_payments WHERE id = ? FOR UPDATE', [o.payment_id], conn);
    await refundOrderPayment(conn, merchant, p, { amount: Number(p.amount) - Number(p.refunded), reason: `Реальная доставка не одобрена${note ? `: ${note}` : ''}` });
  } else {
    await notify(conn, 'bank', shop.owner_id, { title: 'Реальная доставка одобрена', body: `${shop.name}: соберите и отправьте заказ`, link: '#/online' });
    if (o.buyer_bank_user_id) await notify(conn, 'bank', o.buyer_bank_user_id, { title: 'Реальная доставка одобрена', body: shop.name, link: '#/purchases' });
    await orderEvent(conn, o, 'order.approved');
  }
  return one('SELECT * FROM shop_orders WHERE id = ?', [o.id], conn);
}

// ——— Возвраты заказов: через чек Кассы (склад возвращается) ———

export async function refundOrderPayment(conn, merchant, p, { amount, reason = null, lines = null }) {
  const order = await one('SELECT * FROM shop_orders WHERE id = ? FOR UPDATE', [p.order_id], conn);
  if (!order?.sale_id) throw bad('not_refundable', 'Заказ ещё не оплачен');
  const left = Number(p.amount) - Number(p.refunded);
  const all = !lines;
  if (all && amount !== left) throw bad('order_refund_items', 'Частичный возврат заказа — по позициям: POST /api/v1/orders/{id}/refund с items');
  const sale = await loadSale(conn, order.sale_id, { lock: true });
  const shop = await one('SELECT * FROM shops WHERE id = ?', [order.shop_id], conn);
  const staff = await one('SELECT * FROM shop_staff WHERE id = ?', [sale.staff_id], conn);
  let saleLines = null;
  if (lines) {
    saleLines = [];
    for (const l of lines) {
      const it = sale.items.find((i) => i.product_id === Number(l.product_id));
      if (!it) throw bad('invalid_item', `Позиции ${l.product_id} нет в заказе`);
      saleLines.push({ item_id: it.id, qty_milli: lineQty(l, it.unit) });
    }
  }
  const r = await refundSale(conn, { sale, shop, staff, lines: saleLines, all, reason: reason || 'Возврат онлайн-заказа' }).catch((err) => {
    if (err.code === 'insufficient_funds') throw bad('merchant_funds', 'На бизнес-счёте магазина не хватает денег для возврата');
    throw err;
  });
  const row = await one('SELECT tx_id FROM refunds WHERE id = ?', [r.id], conn);
  const vat = Math.round((Number(p.vat) * r.amount) / Number(p.amount));
  const res = await recordRefund(conn, merchant, p, { amount: r.amount, vat, reason, txId: row?.tx_id || null, skipLedger: true });
  const fullyRefunded = Number(res.payment.refunded) >= Number(p.amount);
  if (fullyRefunded) await q("UPDATE shop_orders SET status = 'refunded' WHERE id = ?", [order.id], conn);
  await orderEvent(conn, order, fullyRefunded ? 'order.refunded' : 'order.partially_refunded');
  return res;
}

export { paymentView, siteUrl };
