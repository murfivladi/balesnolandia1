// Этап 7. Склад и закупки: оптовая база админа (цены растут с инфляцией) и заказы
// у других магазинов. Деньги — только проводками с бизнес-счёта.
import { q, one, json, afterCommit } from '../db.js';
import { bad, notFound } from './errors.js';
import { post, sys } from './ledger.js';
import { publish } from './hub.js';
import { notify } from './notify.js';
import { priceIndex } from './finance.js';
import { formatMoney } from '@bln/shared/money.js';

const QTY_ONE = 1000;
/** Наценка по умолчанию для товара, созданного закупкой: цена = закупка × 1,5. */
const DEFAULT_MARKUP = 1.5;

export function wholesalePrice(item, index) {
  return Math.max(1, Math.round(Number(item.base_price) * index));
}

export function wholesaleView(w, index) {
  return { id: w.id, name: w.name, category: w.category, unit: w.unit, base_price: Number(w.base_price), price: wholesalePrice(w, index), barcode: w.barcode, photo: w.photo, age_limit: w.age_limit, active: !!w.active, sort: w.sort };
}

function checkQty(qty, unit, name) {
  if (!Number.isSafeInteger(qty) || qty <= 0 || qty > 1e9) throw bad('invalid_qty', `Неверное количество: ${name}`);
  if (unit === 'pcs' && qty % QTY_ONE !== 0) throw bad('invalid_qty', `Штучный товар: ${name}`);
}

/** Приход на склад со средневзвешенной закупочной ценой. */
async function receive(conn, product, qty, unitCost, { reason = 'purchase', refId = null, staffId = null } = {}) {
  const p = await one('SELECT * FROM products WHERE id = ? FOR UPDATE', [product.id], conn);
  const stock = Math.max(0, Number(p.stock_milli));
  const cost = stock > 0 ? Math.round((stock * Number(p.cost) + qty * unitCost) / (stock + qty)) : unitCost;
  await q('UPDATE products SET stock_milli = stock_milli + ?, cost = ? WHERE id = ?', [qty, cost, p.id], conn);
  await q('INSERT INTO stock_moves (product_id, qty_milli, reason, ref_id, staff_id) VALUES (?, ?, ?, ?, ?)', [p.id, qty, reason, refId, staffId], conn);
}

/** Товар магазина, в который приходит закупка: указанный, связанный или новый. */
async function targetProduct(conn, shopId, { productId, wholesaleItemId = null, template }) {
  if (productId) {
    const p = await one('SELECT * FROM products WHERE id = ? AND shop_id = ?', [productId, shopId], conn);
    if (!p) throw notFound('Товар магазина не найден');
    if (p.unit !== template.unit) throw bad('unit_mismatch', `Единицы не совпадают: ${p.name}`);
    return p;
  }
  const found = wholesaleItemId
    ? await one('SELECT * FROM products WHERE shop_id = ? AND wholesale_item_id = ? ORDER BY active DESC, id LIMIT 1', [shopId, wholesaleItemId], conn)
    : await one('SELECT * FROM products WHERE shop_id = ? AND name = ? AND unit = ? ORDER BY active DESC, id LIMIT 1', [shopId, template.name, template.unit], conn);
  if (found) return found;
  const r = await q(
    'INSERT INTO products (shop_id, name, category, barcode, price, cost, unit, age_limit, photo, track_stock, wholesale_item_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)',
    [shopId, template.name, template.category || '', template.barcode || null, template.price, 0, template.unit, template.age_limit || 0, template.photo || null, wholesaleItemId],
    conn,
  );
  return one('SELECT * FROM products WHERE id = ?', [r.insertId], conn);
}

/** Закупка у оптовой базы: оплата сразу, товар — сразу на склад. */
export async function buyWholesale(conn, { shop, staff, lines, idem = null }) {
  if (!Array.isArray(lines) || !lines.length || lines.length > 100) throw bad('empty', 'Укажите товары для закупки');
  const { index } = await priceIndex(conn);
  const picks = [];
  for (const l of lines) {
    const w = await one('SELECT * FROM wholesale_items WHERE id = ? AND active = 1', [Number(l.item_id) || 0], conn);
    if (!w) throw notFound('Товар оптовой базы не найден');
    const qty = Math.round(Number(l.qty_milli));
    checkQty(qty, w.unit, w.name);
    const unitPrice = wholesalePrice(w, index);
    picks.push({ w, qty, unitPrice, sum: Math.round((unitPrice * qty) / QTY_ONE), productId: l.product_id ? Number(l.product_id) : null });
  }
  const total = picks.reduce((s, p) => s + p.sum, 0);
  if (total <= 0) throw bad('invalid', 'Сумма закупки должна быть больше нуля');
  const r = await post(conn, {
    kind: 'wholesale_purchase',
    memo: `Закупка на оптовой базе: ${shop.name}`,
    entries: [{ account: shop.account_id, amount: -total }, { account: await sys('WHOLESALE', conn), amount: total }],
    actor: { kind: 'bank', id: staff.bank_user_id },
    idem,
    ref: { type: 'shop', id: shop.id },
  });
  if (r.duplicate) return { duplicate: true };
  const items = picks.map((p) => ({ item_id: p.w.id, name: p.w.name, unit: p.w.unit, qty_milli: p.qty, price: p.unitPrice, total: p.sum }));
  const ins = await q("INSERT INTO purchases (shop_id, source, status, items, total, tx_id, staff_id, decided_at) VALUES (?, 'wholesale', 'done', ?, ?, ?, ?, NOW(3))", [shop.id, JSON.stringify(items), total, r.id, staff.id], conn);
  for (const p of picks) {
    const prod = await targetProduct(conn, shop.id, {
      productId: p.productId,
      wholesaleItemId: p.w.id,
      template: { name: p.w.name, category: p.w.category, unit: p.w.unit, barcode: p.w.barcode, photo: p.w.photo, age_limit: p.w.age_limit, price: Math.round(p.unitPrice * DEFAULT_MARKUP) },
    });
    await receive(conn, prod, p.qty, p.unitPrice, { refId: ins.insertId, staffId: staff.id });
  }
  return { id: ins.insertId, total, tx: r.id };
}

/** Заказ у другого магазина по его оптовой цене (b2b_price). Продавец подтверждает. */
export async function orderFromShop(conn, { shop, staff, sellerShopId, lines, note = null }) {
  const seller = await one("SELECT * FROM shops WHERE id = ? AND status = 'active'", [sellerShopId], conn);
  if (!seller) throw notFound('Магазин-продавец не найден');
  if (seller.id === shop.id) throw bad('same_shop', 'Нельзя заказать у своего магазина');
  if (!Array.isArray(lines) || !lines.length || lines.length > 100) throw bad('empty', 'Укажите товары для заказа');
  const items = [];
  for (const l of lines) {
    const p = await one('SELECT * FROM products WHERE id = ? AND shop_id = ? AND active = 1 AND b2b_price IS NOT NULL', [Number(l.product_id) || 0, seller.id], conn);
    if (!p) throw notFound('Товар продавца не найден или не продаётся оптом');
    const qty = Math.round(Number(l.qty_milli));
    checkQty(qty, p.unit, p.name);
    const price = Number(p.b2b_price);
    items.push({ seller_product_id: p.id, product_id: l.target_product_id ? Number(l.target_product_id) : null, name: p.name, category: p.category, unit: p.unit, qty_milli: qty, price, retail: Number(p.price), total: Math.round((price * qty) / QTY_ONE) });
  }
  const total = items.reduce((s, i) => s + i.total, 0);
  const r = await q("INSERT INTO purchases (shop_id, source, seller_shop_id, status, items, total, staff_id, note) VALUES (?, 'shop', ?, 'pending', ?, ?, ?, ?)", [shop.id, seller.id, JSON.stringify(items), total, staff.id, note], conn);
  await notify(conn, 'bank', seller.owner_id, { title: `Заказ от магазина «${shop.name}»`, body: `${formatMoney(total)} — подтвердите в кассе: Управление → Склад` });
  afterCommit(conn, () => publish(`shop:${seller.id}`, { type: 'order', id: r.insertId }));
  return { id: r.insertId, total };
}

/** Продавец подтверждает заказ: деньги с бизнес-счёта покупателя, товар — со склада продавца. */
export async function acceptOrder(conn, { purchaseId, seller, staff }) {
  const pur = await one('SELECT * FROM purchases WHERE id = ? FOR UPDATE', [purchaseId], conn);
  if (!pur || pur.seller_shop_id !== seller.id) throw notFound('Заказ не найден');
  if (pur.status !== 'pending') throw bad('decided', 'Заказ уже обработан');
  const buyer = await one('SELECT * FROM shops WHERE id = ?', [pur.shop_id], conn);
  if (buyer.status !== 'active') throw bad('shop_closed', 'Магазин покупателя закрыт');
  const items = json(pur.items, []);
  for (const it of items) {
    const p = await one('SELECT * FROM products WHERE id = ? FOR UPDATE', [it.seller_product_id], conn);
    if (!p) throw notFound(`Товар не найден: ${it.name}`);
    if (p.track_stock && Number(p.stock_milli) < it.qty_milli) throw bad('out_of_stock', `Нет в наличии: ${p.name}`);
  }
  const r = await post(conn, {
    kind: 'b2b_purchase',
    memo: `Закупка у магазина «${seller.name}»`,
    entries: [{ account: buyer.account_id, amount: -Number(pur.total) }, { account: seller.account_id, amount: Number(pur.total) }],
    actor: { kind: 'bank', id: staff.bank_user_id },
    idem: `b2b:${pur.id}`,
    ref: { type: 'purchase', id: pur.id },
  }).catch((err) => {
    if (err.code === 'insufficient_funds') throw bad('buyer_funds', 'На бизнес-счёте покупателя не хватает денег');
    throw err;
  });
  for (const it of items) {
    await q('UPDATE products SET stock_milli = stock_milli - ? WHERE id = ? AND track_stock = 1', [it.qty_milli, it.seller_product_id], conn);
    await q("INSERT INTO stock_moves (product_id, qty_milli, reason, ref_id, staff_id) VALUES (?, ?, 'supply', ?, ?)", [it.seller_product_id, -it.qty_milli, pur.id, staff.id], conn);
    const prod = await targetProduct(conn, buyer.id, { productId: it.product_id, template: { name: it.name, category: it.category, unit: it.unit, price: it.retail || Math.round(it.price * DEFAULT_MARKUP) } });
    await receive(conn, prod, it.qty_milli, it.price, { refId: pur.id });
  }
  await q("UPDATE purchases SET status = 'done', tx_id = ?, decided_at = NOW(3) WHERE id = ?", [r.id, pur.id], conn);
  await notify(conn, 'bank', buyer.owner_id, { title: `Заказ у «${seller.name}» выполнен`, body: `${formatMoney(pur.total)}: товар на складе` });
  afterCommit(conn, () => publish(`shop:${buyer.id}`, { type: 'order_done', id: pur.id }));
  return { tx: r.id };
}

export function purchaseView(p) {
  return { id: p.id, shop_id: p.shop_id, shop_name: p.shop_name, source: p.source, seller_shop_id: p.seller_shop_id, seller_name: p.seller_name, status: p.status, items: json(p.items, []), total: Number(p.total), note: p.note, created_at: p.created_at, decided_at: p.decided_at };
}
