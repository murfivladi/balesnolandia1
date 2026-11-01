// Логика кассы: продажа, оплаты (наличные/карта/QR, раздельно), возвраты, смены, отчёты.
import { q, one, afterCommit, json } from '../db.js';
import { bad, notFound } from './errors.js';
import { getSettings, webUrl } from './settings.js';
import { post, sys } from './ledger.js';
import { publish } from './hub.js';
import { notify } from './notify.js';
import { checkCardLimits, primaryAccount } from './bank.js';
import { accrueCashback, revokeCashback, reviewIfLarge } from './finance.js';
import { randomToken, newVerifyCode } from './ids.js';
import { createInvoice } from './gov.js';
import { formatMoney, percentOf, vatIncluded } from '@bln/shared/money.js';

export const QTY_ONE = 1000;

export async function openShift(conn, staffId) {
  return one("SELECT * FROM shifts WHERE staff_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [staffId], conn);
}

export async function posLog(conn, { shopId, staffId = null, shiftId = null, action, saleId = null, data = null }) {
  await q('INSERT INTO pos_log (shop_id, staff_id, shift_id, action, sale_id, data) VALUES (?, ?, ?, ?, ?, ?)', [shopId, staffId, shiftId, action, saleId, data ? JSON.stringify(data) : null], conn);
}

/** Строки чека → позиции с суммами. Цены, варианты, добавки и наличие берутся только из базы. */
export async function buildItems(conn, shopId, lines, { checkStock = true, kiosk = false } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) throw bad('empty_sale', 'Чек пуст');
  if (lines.length > 200) throw bad('too_many', 'Слишком много позиций');
  const ids = [...new Set(lines.map((l) => Number(l.product_id)))];
  if (ids.some((id) => !Number.isSafeInteger(id))) throw bad('product_not_found', 'Товар не найден');
  const rows = await q(`SELECT * FROM products WHERE shop_id = ? AND id IN (${ids.map(() => '?').join(',')}) FOR UPDATE`, [shopId, ...ids], conn);
  const byId = new Map(rows.map((p) => [p.id, p]));
  const variants = new Map((await q(`SELECT * FROM product_variants WHERE active = 1 AND product_id IN (${ids.map(() => '?').join(',')})`, ids, conn)).map((v) => [v.id, v]));
  const mods = new Map((await q(`SELECT * FROM modifiers WHERE active = 1 AND product_id IN (${ids.map(() => '?').join(',')})`, ids, conn)).map((m) => [m.id, m]));
  const need = new Map();
  const items = lines.map((l) => {
    const p = byId.get(Number(l.product_id));
    if (!p || !p.active) throw bad('product_not_found', 'Товар не найден');
    if (kiosk && p.age_limit > 0) throw bad('age_kiosk', `Товар ${p.age_limit}+ продаётся только на кассе`);
    const qty = Math.round(Number(l.qty_milli));
    if (!Number.isSafeInteger(qty) || qty <= 0 || qty > 1e7) throw bad('invalid_qty', `Неверное количество: ${p.name}`);
    if (p.unit === 'pcs' && qty % QTY_ONE !== 0) throw bad('invalid_qty', `Штучный товар: ${p.name}`);
    need.set(p.id, (need.get(p.id) || 0) + qty);
    let price = Number(p.price);
    let name = p.name;
    let variantId = null;
    if (l.variant_id) {
      const v = variants.get(Number(l.variant_id));
      if (!v || v.product_id !== p.id) throw bad('variant_not_found', `Вариант не найден: ${p.name}`);
      price += Number(v.price_delta);
      name += ` (${v.name})`;
      variantId = v.id;
    }
    const modList = [];
    for (const mid of [...new Set((Array.isArray(l.modifier_ids) ? l.modifier_ids : []).map(Number))].slice(0, 20)) {
      const m = mods.get(mid);
      if (!m || m.product_id !== p.id) throw bad('modifier_not_found', `Добавка не найдена: ${p.name}`);
      price += Number(m.price);
      modList.push({ id: m.id, name: m.name, price: Number(m.price) });
    }
    if (modList.length) name += ` + ${modList.map((m) => m.name).join(', ')}`;
    if (price <= 0) throw bad('invalid_price', `Неверная цена: ${p.name}`);
    const total = Math.round((price * qty) / QTY_ONE);
    return {
      product_id: p.id, name: name.slice(0, 120), unit: p.unit, qty_milli: qty, price, total, age_limit: p.age_limit,
      variant_id: variantId, modifiers: modList.length ? modList : null, to_kitchen: !!p.to_kitchen, sent: l.sent ? 1 : 0,
    };
  });
  if (checkStock) {
    for (const [id, qty] of need) {
      const p = byId.get(id);
      if (p.track_stock && Number(p.stock_milli) < qty) throw bad('out_of_stock', `Нет в наличии: ${p.name}`, { product_id: id });
    }
  }
  return items;
}

/** Распределить скидку и НДС по позициям; сумма позиций = итог. */
function priceItems(items, discount, vatBp) {
  const subtotal = items.reduce((s, i) => s + i.total, 0);
  const d = Math.min(Math.max(0, discount), subtotal);
  let leftD = d;
  items.forEach((it, idx) => {
    const share = idx === items.length - 1 ? leftD : Math.floor((d * it.total) / (subtotal || 1));
    it.discount = Math.min(share, it.total);
    leftD -= it.discount;
    it.total -= it.discount;
    it.vat = vatIncluded(it.total, vatBp);
  });
  const total = subtotal - d;
  const vat = items.reduce((s, i) => s + i.vat, 0);
  return { subtotal, discount: d, total, vat };
}

/** Скидка по акциям магазина: автоматические + промокод. value — б.п. для % и влодинки для суммы. */
export async function promoDiscount(conn, shopId, items, code) {
  const subtotal = items.reduce((s, i) => s + i.total, 0);
  const promos = await q('SELECT * FROM promos WHERE shop_id = ? AND active = 1 AND (code IS NULL OR code = ?)', [shopId, code || ''], conn);
  if (code && !promos.some((p) => p.code === code)) throw bad('promo_invalid', 'Промокод не найден');
  let total = 0;
  const applied = [];
  for (const p of promos) {
    if (p.max_uses !== null && p.used >= p.max_uses) {
      if (p.code) throw bad('promo_used', 'Промокод больше не действует');
      continue;
    }
    if (subtotal < Number(p.min_total)) continue;
    const scope = p.product_id ? items.filter((i) => i.product_id === p.product_id) : items;
    const base = scope.reduce((s, i) => s + i.total, 0);
    let d = 0;
    if (p.kind === 'percent') d = percentOf(base, Number(p.value));
    else if (p.kind === 'amount') d = Number(p.value);
    else if (p.kind === 'qty') {
      const qty = scope.reduce((s, i) => s + i.qty_milli, 0) / QTY_ONE;
      if (qty >= p.min_qty) d = percentOf(base, Number(p.value));
    }
    if (d > 0) { total += d; applied.push({ id: p.id, title: p.title, amount: d }); }
  }
  return { amount: Math.min(total, subtotal), applied };
}

/** Клиент программы лояльности по номеру карты ВлодБанка или паспорта БФ. */
export async function loyaltyCustomer(conn, ref) {
  const s = String(ref || '').trim().toUpperCase();
  if (!s) return null;
  const digits = s.replace(/\D/g, '');
  let u = null;
  if (/^BLN-/.test(s)) u = await one('SELECT id, full_name FROM bank_users WHERE passport_no = ? AND passport_verified = 1', [s], conn);
  else if (digits.length === 12) u = await one('SELECT u.id, u.full_name FROM cards c JOIN bank_users u ON u.id = COALESCE(c.holder_user_id, c.bank_user_id) WHERE c.number = ?', [digits], conn);
  if (!u) throw notFound('Клиент не найден: нужна карта ВлодБанка или паспорт БФ');
  return u;
}

export async function pointsOf(conn, shopId, userId, { lock = false } = {}) {
  const r = await one(`SELECT points FROM loyalty_points WHERE shop_id = ? AND bank_user_id = ?${lock ? ' FOR UPDATE' : ''}`, [shopId, userId], conn);
  return r ? Number(r.points) : 0;
}

export async function movePoints(conn, { shopId, userId, saleId = null, points, reason }) {
  if (!points) return;
  await q('INSERT INTO loyalty_points (shop_id, bank_user_id, points) VALUES (?, ?, GREATEST(0, ?)) ON DUPLICATE KEY UPDATE points = GREATEST(0, points + ?)', [shopId, userId, points, points], conn);
  await q('INSERT INTO loyalty_moves (shop_id, bank_user_id, sale_id, points, reason) VALUES (?, ?, ?, ?, ?)', [shopId, userId, saleId, points, reason], conn);
}

/** Вернуть списанные баллы, если чек отменён. */
export async function restorePoints(conn, sale) {
  if (!Number(sale.points_used) || !sale.loyalty_user_id) return;
  await movePoints(conn, { shopId: sale.shop_id, userId: sale.loyalty_user_id, saleId: sale.id, points: Number(sale.points_used), reason: 'restore' });
  await q('UPDATE sales SET points_used = 0 WHERE id = ?', [sale.id], conn);
}

export async function createSale(conn, {
  shopId, staff, lines, discount = 0, tipPct = 0, heldLabel = null, promoCode = null, loyalty = null, redeemPoints = 0, tableId = null, source = 'pos',
}) {
  const s = await getSettings();
  const shift = heldLabel ? null : await openShift(conn, staff.id);
  if (!heldLabel && !shift) throw bad('no_shift', 'Откройте смену');
  const shop = await one('SELECT * FROM shops WHERE id = ?', [shopId], conn);
  const items = await buildItems(conn, shopId, lines, { checkStock: !heldLabel, kiosk: source === 'kiosk' });
  const vatBp = Number(s.vat_bp || 0);
  const subtotal = items.reduce((x, i) => x + i.total, 0);
  const code = promoCode ? String(promoCode).trim().toUpperCase().slice(0, 32) : null;
  const promo = heldLabel ? { amount: 0, applied: [] } : await promoDiscount(conn, shopId, items, code);
  const manual = source === 'kiosk' ? 0 : Math.min(Math.max(0, Math.round(Number(discount) || 0)), subtotal - promo.amount);
  // Баллы: не больше доли чека из настроек магазина и не больше баланса клиента.
  const customer = loyalty ? (typeof loyalty === 'object' ? loyalty : await loyaltyCustomer(conn, loyalty)) : null;
  let points = 0;
  const wantPoints = Math.max(0, Math.round(Number(redeemPoints) || 0));
  if (wantPoints && !heldLabel) {
    if (!customer) throw bad('no_customer', 'Укажите карту или паспорт клиента для списания баллов');
    const have = await pointsOf(conn, shopId, customer.id, { lock: true });
    const cap = percentOf(subtotal - promo.amount - manual, Number(shop.loyalty_max_bp || 0));
    points = Math.min(wantPoints, have, cap);
  }
  const totals = priceItems(items, promo.amount + manual + points, vatBp);
  if (![0, 5, 10, 15].includes(Number(tipPct))) throw bad('invalid_tip', 'Чаевые: 0, 5, 10 или 15%');
  const tip = Math.round((totals.total * Number(tipPct)) / 100);
  const res = await q(
    `INSERT INTO sales (shop_id, shift_id, staff_id, status, subtotal, discount, promo_discount, manual_discount, points_used, total, vat, vat_bp, tip, tip_pct, hold_label,
      promo_code, loyalty_user_id, table_id, source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [shopId, shift?.id || null, staff.id, heldLabel ? 'held' : 'open', totals.subtotal, totals.discount, promo.amount, manual, points, totals.total, totals.vat, vatBp, tip, Number(tipPct), heldLabel,
      promo.applied.length && code ? code : null, customer?.id || null, tableId, source],
    conn,
  );
  for (const it of items) {
    await q('INSERT INTO sale_items (sale_id, product_id, name, unit, qty_milli, price, discount, total, vat, age_limit, variant_id, modifiers, sent_to_kitchen) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      res.insertId, it.product_id, it.name, it.unit, it.qty_milli, it.price, it.discount, it.total, it.vat, it.age_limit, it.variant_id, it.modifiers ? JSON.stringify(it.modifiers) : null, it.sent,
    ], conn);
  }
  if (points) await movePoints(conn, { shopId, userId: customer.id, saleId: res.insertId, points: -points, reason: 'redeem' });
  if (manual > 0) await posLog(conn, { shopId, staffId: staff.id, shiftId: shift?.id, action: 'discount', saleId: res.insertId, data: { amount: manual } });
  if (promo.applied.length) await posLog(conn, { shopId, staffId: staff.id, shiftId: shift?.id, action: 'promo', saleId: res.insertId, data: { amount: promo.amount, promos: promo.applied.map((p) => p.title) } });
  const sale = await loadSale(conn, res.insertId);
  sale.promos = promo.applied;
  return sale;
}

// ——— Столики: открытый счёт стола — отложенный чек с table_id ———

/** Пересчитать отложенный чек без скидок и чаевых (позиции по полной цене). */
async function recomputeHeld(conn, saleId) {
  const sale = await one('SELECT vat_bp FROM sales WHERE id = ?', [saleId], conn);
  const items = await q('SELECT id, price, qty_milli FROM sale_items WHERE sale_id = ?', [saleId], conn);
  let subtotal = 0;
  let vat = 0;
  for (const i of items) {
    const total = Math.round((Number(i.price) * Number(i.qty_milli)) / QTY_ONE);
    const v = vatIncluded(total, sale.vat_bp);
    subtotal += total;
    vat += v;
    await q('UPDATE sale_items SET discount = 0, total = ?, vat = ? WHERE id = ?', [total, v, i.id], conn);
  }
  await q('UPDATE sales SET subtotal = ?, total = ?, vat = ?, discount = 0, promo_discount = 0, manual_discount = 0, tip = 0, tip_pct = 0, promo_code = NULL WHERE id = ?', [subtotal, subtotal, vat, saleId], conn);
}

/** Оплата счёта стола отменена — счёт возвращается на стол. */
export async function revertTab(conn, sale) {
  await restorePoints(conn, sale);
  const table = await one('SELECT name FROM shop_tables WHERE id = ?', [sale.table_id], conn);
  await q("UPDATE sales SET status = 'held', shift_id = NULL, hold_label = ?, loyalty_user_id = NULL WHERE id = ?", [table?.name || 'Стол', sale.id], conn);
  await recomputeHeld(conn, sale.id);
  return { ok: true, reverted: true };
}

export async function openTab(conn, shopId, tableId) {
  return one("SELECT * FROM sales WHERE shop_id = ? AND table_id = ? AND status = 'held' ORDER BY id DESC LIMIT 1 FOR UPDATE", [shopId, tableId], conn);
}

/** Добавить позиции в счёт стола (новый счёт, если стол свободен). */
export async function addToTab(conn, { shopId, staff, table, lines }) {
  const tab = await openTab(conn, shopId, table.id);
  if (!tab) return createSale(conn, { shopId, staff, lines, heldLabel: table.name, tableId: table.id, source: 'tab' });
  const items = await buildItems(conn, shopId, lines, { checkStock: false });
  for (const it of items) {
    await q('INSERT INTO sale_items (sale_id, product_id, name, unit, qty_milli, price, discount, total, vat, age_limit, variant_id, modifiers) VALUES (?, ?, ?, ?, ?, ?, 0, ?, 0, ?, ?, ?)', [
      tab.id, it.product_id, it.name, it.unit, it.qty_milli, it.price, it.total, it.age_limit, it.variant_id, it.modifiers ? JSON.stringify(it.modifiers) : null,
    ], conn);
  }
  await recomputeHeld(conn, tab.id);
  return loadSale(conn, tab.id);
}

export async function removeFromTab(conn, { tab, itemId, staff }) {
  const it = tab.items.find((i) => i.id === itemId);
  if (!it) throw notFound('Позиция не найдена');
  await q('DELETE FROM sale_items WHERE id = ?', [it.id], conn);
  await posLog(conn, { shopId: tab.shop_id, staffId: staff.id, action: 'remove_item', saleId: tab.id, data: { name: it.name, qty_milli: Number(it.qty_milli), sent: !!it.sent_to_kitchen } });
  if (tab.items.length === 1) {
    await q("UPDATE sales SET status = 'cancelled' WHERE id = ?", [tab.id], conn);
    return null;
  }
  await recomputeHeld(conn, tab.id);
  return loadSale(conn, tab.id);
}

/** Отправить на кухню ещё не отправленные позиции стола. */
export async function sendTabToKitchen(conn, { tab, table }) {
  const fresh = tab.items.filter((i) => !i.sent_to_kitchen && i.product_id);
  const flags = fresh.length ? await q(`SELECT id FROM products WHERE to_kitchen = 1 AND id IN (${fresh.map(() => '?').join(',')})`, fresh.map((i) => i.product_id), conn) : [];
  const ids = new Set(flags.map((r) => r.id));
  const list = fresh.filter((i) => ids.has(i.product_id));
  if (!list.length) throw bad('nothing_to_send', 'Нет новых блюд для кухни');
  const order = await createKitchenOrder(conn, tab.shop_id, { saleId: tab.id, label: table.name, items: list });
  await q(`UPDATE sale_items SET sent_to_kitchen = 1 WHERE id IN (${list.map(() => '?').join(',')})`, list.map((i) => i.id), conn);
  return order;
}

/** Закрыть счёт стола: обычный чек со скидками и баллами, дальше — оплата. */
export async function tabCheckout(conn, { tab, staff, discount = 0, promoCode = null, loyalty = null, redeemPoints = 0, tipPct = 0 }) {
  const lines = tab.items.map((i) => ({ product_id: i.product_id, qty_milli: Number(i.qty_milli), variant_id: i.variant_id, modifier_ids: (json(i.modifiers, []) || []).map((m) => m.id), sent: i.sent_to_kitchen }));
  await q("UPDATE sales SET status = 'cancelled' WHERE id = ?", [tab.id], conn);
  return createSale(conn, { shopId: tab.shop_id, staff, lines, discount, promoCode, loyalty, redeemPoints, tipPct, tableId: tab.table_id, source: 'tab' });
}

export async function loadSale(conn, saleId, { lock = false } = {}) {
  const sale = await one(`SELECT * FROM sales WHERE id = ?${lock ? ' FOR UPDATE' : ''}`, [saleId], conn);
  if (!sale) throw notFound('Чек не найден');
  sale.items = await q('SELECT * FROM sale_items WHERE sale_id = ? ORDER BY id', [saleId], conn);
  sale.payments = await q('SELECT * FROM sale_payments WHERE sale_id = ? ORDER BY id', [saleId], conn);
  return sale;
}

export function saleView(sale) {
  const n = (v) => Number(v);
  const due = n(sale.total) + n(sale.tip) - n(sale.paid);
  return {
    id: sale.id,
    shop_id: sale.shop_id,
    number: sale.number,
    status: sale.status,
    subtotal: n(sale.subtotal),
    discount: n(sale.discount),
    promo_discount: n(sale.promo_discount || 0),
    manual_discount: n(sale.manual_discount || 0),
    points_used: n(sale.points_used || 0),
    points_earned: n(sale.points_earned || 0),
    promo_code: sale.promo_code || null,
    loyalty_user_id: sale.loyalty_user_id || null,
    table_id: sale.table_id || null,
    source: sale.source || 'pos',
    queue_no: sale.queue_no || null,
    promos: sale.promos || undefined,
    total: n(sale.total),
    vat: n(sale.vat),
    vat_bp: sale.vat_bp,
    tip: n(sale.tip),
    tip_pct: sale.tip_pct,
    paid: n(sale.paid),
    due: Math.max(0, due),
    refunded: n(sale.refunded),
    age_limit: Math.max(0, ...(sale.items || []).map((i) => i.age_limit)),
    age_checked: sale.age_checked,
    hold_label: sale.hold_label,
    verify_code: sale.verify_code,
    created_at: sale.created_at,
    paid_at: sale.paid_at,
    items: (sale.items || []).map((i) => ({ id: i.id, product_id: i.product_id, variant_id: i.variant_id || null, modifiers: json(i.modifiers, null), sent_to_kitchen: !!i.sent_to_kitchen, name: i.name, unit: i.unit, qty_milli: n(i.qty_milli), price: n(i.price), discount: n(i.discount), total: n(i.total), vat: n(i.vat), age_limit: i.age_limit, refunded_milli: n(i.refunded_milli) })),
    payments: (sale.payments || []).map((p) => ({ id: p.id, method: p.method, debt_id: p.debt_id || null, amount: n(p.amount), tip: n(p.tip), cash_given: p.cash_given === null ? null : n(p.cash_given), change_given: p.change_given === null ? null : n(p.change_given), refunded: n(p.refunded), created_at: p.created_at })),
  };
}

function checkPayable(sale) {
  if (sale.status !== 'open') throw bad('sale_closed', sale.status === 'paid' ? 'Чек уже оплачен' : 'Чек закрыт');
  const ageLimit = Math.max(0, ...sale.items.map((i) => i.age_limit));
  if (ageLimit > 0 && !sale.age_checked) throw bad('age_check', `Проверьте паспорт покупателя (${ageLimit}+)`);
  return Number(sale.total) + Number(sale.tip) - Number(sale.paid);
}

/** Сколько из платежа идёт за товары, сколько — чаевые (чаевые покрываются последними). */
function splitPayment(sale, amount) {
  const goodsLeft = Math.max(0, Number(sale.total) - Number(sale.paid));
  const goods = Math.min(amount, goodsLeft);
  return { goods, tip: amount - goods };
}

/** Доля НДС в части оплаты за товары; последний платёж забирает остаток. */
function vatShare(sale, goods) {
  const total = Number(sale.total);
  if (!total || !goods) return 0;
  const paidGoods = Math.min(Number(sale.paid), total);
  if (paidGoods + goods >= total) {
    const before = Math.round((Number(sale.vat) * paidGoods) / total);
    return Number(sale.vat) - before;
  }
  return Math.round((Number(sale.vat) * goods) / total);
}

async function finalize(conn, sale, shop) {
  const fresh = await one('SELECT * FROM sales WHERE id = ?', [sale.id], conn);
  if (Number(fresh.paid) < Number(fresh.total) + Number(fresh.tip)) return false;
  const sh = await one('SELECT next_sale_no FROM shops WHERE id = ? FOR UPDATE', [shop.id], conn);
  await q('UPDATE shops SET next_sale_no = next_sale_no + 1 WHERE id = ?', [shop.id], conn);
  await q("UPDATE sales SET status = 'paid', number = ?, verify_code = ?, paid_at = NOW(3) WHERE id = ?", [sh.next_sale_no, newVerifyCode(), sale.id], conn);
  for (const it of sale.items) {
    if (!it.product_id) continue;
    await q('UPDATE products SET stock_milli = stock_milli - ? WHERE id = ? AND track_stock = 1', [it.qty_milli, it.product_id], conn);
    await q("INSERT INTO stock_moves (product_id, qty_milli, reason, ref_id, staff_id) VALUES (?, ?, 'sale', ?, ?)", [it.product_id, -Number(it.qty_milli), sale.id, sale.staff_id], conn);
  }
  if (fresh.promo_code) await q('UPDATE promos SET used = used + 1 WHERE shop_id = ? AND code = ?', [shop.id, fresh.promo_code], conn);
  // Баллы лояльности: клиент указан на кассе или оплатил своей картой / по QR.
  const customer = fresh.loyalty_user_id || fresh.customer_user_id;
  const s = await one('SELECT loyalty_bp, kitchen_enabled FROM shops WHERE id = ?', [shop.id], conn);
  if (customer && Number(s.loyalty_bp) > 0) {
    const earned = percentOf(Number(fresh.total), Number(s.loyalty_bp));
    if (earned > 0) {
      await movePoints(conn, { shopId: shop.id, userId: customer, saleId: sale.id, points: earned, reason: 'earn' });
      await q('UPDATE sales SET points_earned = ?, loyalty_user_id = ? WHERE id = ?', [earned, customer, sale.id], conn);
    }
  }
  // Кухня: позиции «на кухню», ещё не отправленные (открытый счёт стола отправляет их раньше).
  if (s.kitchen_enabled) {
    const cook = sale.items.filter((i) => i.product_id && !i.sent_to_kitchen);
    const flags = cook.length ? await q(`SELECT id FROM products WHERE to_kitchen = 1 AND id IN (${cook.map(() => '?').join(',')})`, cook.map((i) => i.product_id), conn) : [];
    const kitchenIds = new Set(flags.map((r) => r.id));
    const list = cook.filter((i) => kitchenIds.has(i.product_id));
    if (list.length) {
      const table = fresh.table_id ? await one('SELECT name FROM shop_tables WHERE id = ?', [fresh.table_id], conn) : null;
      const order = await createKitchenOrder(conn, shop.id, { saleId: sale.id, label: table?.name || (fresh.source === 'kiosk' ? 'Киоск' : null), items: list, queueNo: fresh.queue_no });
      await q('UPDATE sales SET queue_no = ? WHERE id = ?', [order.queue_no, sale.id], conn);
      await q(`UPDATE sale_items SET sent_to_kitchen = 1 WHERE id IN (${list.map(() => '?').join(',')})`, list.map((i) => i.id), conn);
    }
  }
  afterCommit(conn, () => publish(`shop:${shop.id}`, { type: 'sale_paid', sale_id: sale.id, number: sh.next_sale_no }));
  return true;
}

/** Заказ на кухню с номером в очереди (1…999 по кругу). */
export async function createKitchenOrder(conn, shopId, { saleId = null, label = null, items, queueNo = null }) {
  let no = queueNo;
  if (!no) {
    const sh = await one('SELECT next_queue_no FROM shops WHERE id = ? FOR UPDATE', [shopId], conn);
    no = sh.next_queue_no;
    await q('UPDATE shops SET next_queue_no = ? WHERE id = ?', [no >= 999 ? 1 : no + 1, shopId], conn);
  }
  const list = items.map((i) => ({ name: i.name, unit: i.unit, qty_milli: Number(i.qty_milli) }));
  const r = await q('INSERT INTO kitchen_orders (shop_id, sale_id, queue_no, label, items) VALUES (?, ?, ?, ?, ?)', [shopId, saleId, no, label, JSON.stringify(list)], conn);
  afterCommit(conn, () => publish(`shop:${shopId}`, { type: 'kitchen', id: r.insertId, queue_no: no, status: 'new' }));
  return { id: r.insertId, queue_no: no };
}

/** Безналичная оплата со счёта покупателя (карта или QR). */
async function applyAccountPayment(conn, { sale, shop, method, amount, payerAccountId, card = null, actor, idem }) {
  const due = checkPayable(sale);
  if (amount > due) throw bad('overpay', 'Сумма больше остатка к оплате');
  const s = await getSettings();
  const { goods, tip } = splitPayment(sale, amount);
  const vat = vatShare(sale, goods);
  const fee = percentOf(goods - vat, Number(s.acquiring_fee_bp || 0));
  const staff = await one('SELECT bank_user_id FROM shop_staff WHERE id = ?', [sale.staff_id], conn);
  const tipAccount = tip > 0 ? (await primaryAccount(staff.bank_user_id, conn))?.id || shop.account_id : null;
  const entries = [
    { account: payerAccountId, amount: -amount },
    { account: shop.account_id, amount: goods - vat - fee },
  ];
  if (vat) entries.push({ account: await sys('BUDGET', conn), amount: vat });
  if (fee) entries.push({ account: await sys('TREASURY', conn), amount: fee });
  if (tip) entries.push({ account: tipAccount, amount: tip });
  const r = await post(conn, {
    kind: method === 'qr' ? 'qr_payment' : 'card_payment',
    memo: `Покупка: ${shop.name}`,
    entries,
    idem,
    actor,
    cardId: card?.id || null,
    ref: { type: 'sale', id: sale.id },
    meta: { goods, vat, tip, fee },
  });
  if (r.duplicate) return { duplicate: true };
  // Кешбэк по категории магазина (если клиент выбрал её на этот месяц) и антифрод для крупных сумм.
  await accrueCashback(conn, { accountId: payerAccountId, shop, goods, saleId: sale.id });
  await reviewIfLarge(conn, { accountId: payerAccountId, amount, kind: method === 'qr' ? 'qr_payment' : 'card_payment', txId: r.id, cardId: card?.id || null });
  await q('INSERT INTO sale_payments (sale_id, method, amount, tip, card_id, payer_account_id, tx_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [sale.id, method, amount, tip, card?.id || null, payerAccountId, r.id], conn);
  await q('UPDATE sales SET paid = paid + ? WHERE id = ?', [amount, sale.id], conn);
  const payer = await one('SELECT owner_id FROM accounts WHERE id = ?', [payerAccountId], conn);
  if (payer?.owner_id) {
    await q('UPDATE sales SET customer_user_id = COALESCE(customer_user_id, ?) WHERE id = ?', [payer.owner_id, sale.id], conn);
    await notify(conn, 'bank', payer.owner_id, { title: `Покупка ${formatMoney(amount)}`, body: shop.name, link: `#/receipt/${sale.id}` });
  }
  return { tx: r.id, paid_now: amount, finished: await finalize(conn, sale, shop) };
}

export async function payByCard(conn, { sale, shop, card, amount, actor, idem }) {
  await checkCardLimits(conn, card, amount);
  return applyAccountPayment(conn, { sale, shop, method: 'card', amount, payerAccountId: card.account_id, card, actor, idem });
}

export async function payByCash(conn, { sale, shop, amount, cashGiven, idem = null }) {
  if (idem && (await one('SELECT id FROM sale_payments WHERE idem_key = ?', [idem], conn))) return { duplicate: true };
  const due = checkPayable(sale);
  if (amount > due) throw bad('overpay', 'Сумма больше остатка к оплате');
  const given = cashGiven === undefined || cashGiven === null ? amount : Number(cashGiven);
  if (!Number.isSafeInteger(given) || given < amount) throw bad('cash_short', 'Получено меньше суммы оплаты');
  const { tip } = splitPayment(sale, amount);
  await q('INSERT INTO sale_payments (sale_id, method, amount, tip, cash_given, change_given, idem_key) VALUES (?, ?, ?, ?, ?, ?, ?)', [sale.id, 'cash', amount, tip, given, given - amount, idem], conn);
  await q('UPDATE sales SET paid = paid + ? WHERE id = ?', [amount, sale.id], conn);
  return { change: given - amount, paid_now: amount, finished: await finalize(conn, sale, shop) };
}

/** Оплата в долг: запись в тетрадь долгов магазина. НДС — при Z-отчёте, как с наличных. */
export async function payByDebt(conn, { sale, shop, amount, customerName, customer = null, note = null }) {
  const due = checkPayable(sale);
  if (amount > due) throw bad('overpay', 'Сумма больше остатка к оплате');
  if (amount > Number(sale.total) - Number(sale.paid)) throw bad('debt_tip', 'Чаевые в долг не записываются');
  const name = String(customerName || customer?.full_name || '').trim().slice(0, 120);
  if (name.length < 2) throw bad('invalid', 'Укажите имя должника');
  const d = await q('INSERT INTO debts (shop_id, sale_id, customer_name, bank_user_id, amount, note) VALUES (?, ?, ?, ?, ?, ?)', [shop.id, sale.id, name, customer?.id || null, amount, note], conn);
  await q("INSERT INTO sale_payments (sale_id, method, amount, tip, debt_id) VALUES (?, 'debt', ?, 0, ?)", [sale.id, amount, d.insertId], conn);
  await q('UPDATE sales SET paid = paid + ? WHERE id = ?', [amount, sale.id], conn);
  if (customer?.id) {
    await q('UPDATE sales SET customer_user_id = COALESCE(customer_user_id, ?) WHERE id = ?', [customer.id, sale.id], conn);
    await notify(conn, 'bank', customer.id, { title: `Долг магазину ${formatMoney(amount)}`, body: `${shop.name}: погасите в разделе «Долги»`, link: '#/debts' });
  }
  await posLog(conn, { shopId: shop.id, staffId: sale.staff_id, shiftId: sale.shift_id, action: 'debt', saleId: sale.id, data: { amount, customer: name } });
  return { debt_id: d.insertId, paid_now: amount, finished: await finalize(conn, sale, shop) };
}

/** Погашение долга: наличными на кассе (в ящик) или со счёта (карта, банк) на бизнес-счёт. */
export async function repayDebt(conn, { debt, shop, amount, fromAccountId = null, actor = null, cardId = null, idem = null, staff = null }) {
  if (debt.status !== 'open') throw bad('debt_closed', 'Долг уже закрыт');
  const left = Number(debt.amount) - Number(debt.paid);
  const pay = Math.min(amount, left);
  if (pay <= 0) throw bad('invalid', 'Неверная сумма');
  let txId = null;
  if (fromAccountId) {
    const r = await post(conn, {
      kind: 'debt_repay',
      memo: `Погашение долга: ${shop.name}`,
      entries: [{ account: fromAccountId, amount: -pay }, { account: shop.account_id, amount: pay }],
      actor,
      cardId,
      idem,
      ref: { type: 'debt', id: debt.id },
    });
    if (r.duplicate) return { duplicate: true };
    txId = r.id;
  } else {
    const shift = await openShift(conn, staff.id);
    if (!shift) throw bad('no_shift', 'Откройте смену');
    await posLog(conn, { shopId: shop.id, staffId: staff.id, shiftId: shift.id, action: 'debt_cash', data: { amount: pay, debt: debt.id } });
  }
  const done = pay === left;
  await q(`UPDATE debts SET paid = paid + ?, status = ?, paid_at = ${done ? 'NOW(3)' : 'paid_at'} WHERE id = ?`, [pay, done ? 'paid' : 'open', debt.id], conn);
  await notify(conn, 'bank', shop.owner_id, { title: `Погашен долг ${formatMoney(pay)}`, body: `${debt.customer_name} · ${shop.name}` });
  return { paid: pay, left: left - pay, tx: txId };
}

// ——— QR-оплата из приложения банка ———
const QR_MINUTES = 10;

export async function createQr(conn, { sale, shop, amount }) {
  const token = randomToken(18);
  await q("UPDATE qr_payments SET status = 'cancelled' WHERE kind = 'sale' AND ref_id = ? AND status = 'pending'", [sale.id], conn);
  await q('INSERT INTO qr_payments (token, kind, ref_id, amount, title, expires_at) VALUES (?, ?, ?, ?, ?, NOW(3) + INTERVAL ? MINUTE)', [token, 'sale', sale.id, amount, `${shop.name}: чек`, QR_MINUTES], conn);
  return { token, url: `${await webUrl()}/bank/#/qr/${token}`, amount, expires_minutes: QR_MINUTES };
}

export async function qrInfo(token) {
  const r = await one('SELECT * FROM qr_payments WHERE token = ?', [token]);
  if (!r) throw notFound('Платёж не найден');
  const expired = r.status === 'pending' && new Date(r.expires_at) < new Date();
  let items = [];
  if (r.kind === 'sale') items = await q('SELECT name, qty_milli, unit, total FROM sale_items WHERE sale_id = ?', [r.ref_id]);
  return { title: r.title, amount: Number(r.amount), status: expired ? 'expired' : r.status, items };
}

export async function payQr(conn, token, { user, account }) {
  const r = await one('SELECT * FROM qr_payments WHERE token = ? FOR UPDATE', [token], conn);
  if (!r) throw notFound('Платёж не найден');
  if (r.status !== 'pending') throw bad('qr_used', r.status === 'paid' ? 'Уже оплачено' : 'QR недействителен');
  if (new Date(r.expires_at) < new Date()) throw bad('qr_expired', 'Срок действия QR истёк');
  if (r.kind !== 'sale') throw bad('qr_kind', 'Неизвестный вид платежа');
  const sale = await loadSale(conn, r.ref_id, { lock: true });
  const shop = await one('SELECT * FROM shops WHERE id = ?', [sale.shop_id], conn);
  const res = await applyAccountPayment(conn, { sale, shop, method: 'qr', amount: Number(r.amount), payerAccountId: account.id, actor: { kind: 'bank', id: user.id }, idem: `qr:${r.id}` });
  await q("UPDATE qr_payments SET status = 'paid', payer_user_id = ?, tx_id = ? WHERE id = ?", [user.id, res.tx || null, r.id], conn);
  afterCommit(conn, () => {
    publish(`shop:${shop.id}`, { type: 'qr_paid', sale_id: sale.id, amount: Number(r.amount) });
    const term = terminalBySale.get(sale.id);
    if (term) publish(`terminal:${term}`, { type: 'pay_result', ok: true, sale_id: sale.id, amount: Number(r.amount), method: 'qr' });
  });
  return { tx: res.tx, sale_id: sale.id };
}

/** Какой терминал показывает какой чек (для уведомления об оплате по QR). */
export const terminalBySale = new Map();

// ——— Возвраты ———
/**
 * Возврат по чеку целиком или частью. Деньги возвращаются тем же способом:
 * сначала безналичные платежи (на счёт плательщика), затем наличные.
 */
export async function refundSale(conn, { sale, shop, staff, lines, all = false, reason = null, idem }) {
  if (sale.status !== 'paid') throw bad('not_paid', 'Возврат возможен только по оплаченному чеку');
  const shift = await openShift(conn, staff.id);
  const picks = [];
  for (const it of sale.items) {
    const left = Number(it.qty_milli) - Number(it.refunded_milli);
    let qty = 0;
    if (all) qty = left;
    else {
      const l = (lines || []).find((x) => Number(x.item_id) === it.id);
      if (l) qty = Math.round(Number(l.qty_milli));
    }
    if (!qty) continue;
    if (qty < 0 || qty > left) throw bad('invalid_qty', `Неверное количество возврата: ${it.name}`);
    if (it.unit === 'pcs' && qty % QTY_ONE !== 0) throw bad('invalid_qty', `Штучный товар: ${it.name}`);
    const amount = qty === left
      ? Number(it.total) - Math.round((Number(it.total) * Number(it.refunded_milli)) / Number(it.qty_milli))
      : Math.round((Number(it.total) * qty) / Number(it.qty_milli));
    const vat = qty === left
      ? Number(it.vat) - Math.round((Number(it.vat) * Number(it.refunded_milli)) / Number(it.qty_milli))
      : Math.round((Number(it.vat) * qty) / Number(it.qty_milli));
    picks.push({ item: it, qty, amount, vat });
  }
  if (!picks.length) throw bad('nothing_to_refund', 'Нечего возвращать');
  const total = picks.reduce((s, p) => s + p.amount, 0);
  const totalVat = picks.reduce((s, p) => s + p.vat, 0);

  // Распределяем по платежам (без чаевых): сначала безнал, затем наличные.
  const payments = [...sale.payments].sort((a, b) => (a.method === 'cash') - (b.method === 'cash'));
  let left = total;
  let vatLeft = totalVat;
  const parts = [];
  for (const p of payments) {
    if (left <= 0) break;
    const refundable = Number(p.amount) - Number(p.tip) - Number(p.refunded);
    const take = Math.min(refundable, left);
    if (take <= 0) continue;
    const vat = take === left ? vatLeft : Math.round((totalVat * take) / total);
    parts.push({ payment: p, amount: take, vat });
    left -= take;
    vatLeft -= vat;
  }
  if (left > 0) throw bad('refund_exceeds', 'Сумма возврата больше оплаченной');

  const txIds = [];
  for (const part of parts) {
    const p = part.payment;
    if (p.method === 'debt') {
      // Долг уменьшается; то, что по нему уже погашено, выдаётся наличными.
      const d = await one('SELECT * FROM debts WHERE id = ? FOR UPDATE', [p.debt_id], conn);
      const open = d && d.status === 'open' ? Number(d.amount) - Number(d.paid) : 0;
      const cut = Math.min(open, part.amount);
      if (cut > 0) {
        const left = Number(d.amount) - cut;
        await q(`UPDATE debts SET amount = ?, status = ? WHERE id = ?`, [left, left <= Number(d.paid) ? 'paid' : 'open', d.id], conn);
      }
      part.debt = cut;
      part.cash = part.amount - cut;
    } else if (p.method !== 'cash') {
      const entries = [
        { account: shop.account_id, amount: -(part.amount - part.vat) },
        { account: p.payer_account_id, amount: part.amount },
      ];
      if (part.vat) entries.push({ account: await sys('BUDGET', conn), amount: -part.vat });
      const r = await post(conn, { kind: 'refund', memo: `Возврат: ${shop.name}, чек №${sale.number}`, entries, ref: { type: 'sale', id: sale.id }, actor: { kind: 'bank', id: staff.bank_user_id }, idem: idem ? `${idem}:${p.id}` : null });
      txIds.push(r.id);
      await revokeCashback(conn, { saleId: sale.id, accountId: p.payer_account_id, amount: part.amount, saleTotal: Number(sale.total) });
      const payer = await one('SELECT owner_id FROM accounts WHERE id = ?', [p.payer_account_id], conn);
      if (payer) await notify(conn, 'bank', payer.owner_id, { title: `Возврат ${formatMoney(part.amount)}`, body: shop.name });
    }
    await q('UPDATE sale_payments SET refunded = refunded + ? WHERE id = ?', [part.amount, p.id], conn);
  }
  for (const pk of picks) {
    await q('UPDATE sale_items SET refunded_milli = refunded_milli + ? WHERE id = ?', [pk.qty, pk.item.id], conn);
    if (pk.item.product_id) {
      await q('UPDATE products SET stock_milli = stock_milli + ? WHERE id = ? AND track_stock = 1', [pk.qty, pk.item.product_id], conn);
      await q("INSERT INTO stock_moves (product_id, qty_milli, reason, ref_id, staff_id) VALUES (?, ?, 'refund', ?, ?)", [pk.item.product_id, pk.qty, sale.id, staff.id], conn);
    }
  }
  await q('UPDATE sales SET refunded = refunded + ? WHERE id = ?', [total, sale.id], conn);
  const byMethod = {};
  const addM = (m, v) => { if (v) byMethod[m] = (byMethod[m] || 0) + v; };
  for (const part of parts) {
    if (part.payment.method === 'debt') { addM('debt', part.debt); addM('cash', part.cash); } else addM(part.payment.method, part.amount);
  }
  // Баллы лояльности, начисленные за чек, уменьшаются пропорционально возврату.
  if (Number(sale.points_earned) > 0 && sale.loyalty_user_id) {
    const cut = Math.round((Number(sale.points_earned) * total) / Math.max(1, Number(sale.total)));
    if (cut > 0) await movePoints(conn, { shopId: shop.id, userId: sale.loyalty_user_id, saleId: sale.id, points: -cut, reason: 'refund' });
  }
  const mainMethod = Object.entries(byMethod).sort((a, b) => b[1] - a[1])[0][0];
  const ins = await q('INSERT INTO refunds (sale_id, shift_id, staff_id, amount, method, items, tx_id, reason) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [
    sale.id, shift?.id || null, staff.id, total, mainMethod,
    JSON.stringify({ items: picks.map((p) => ({ item_id: p.item.id, name: p.item.name, qty_milli: p.qty, amount: p.amount })), by_method: byMethod }),
    txIds[0] || null, reason,
  ], conn);
  await posLog(conn, { shopId: shop.id, staffId: staff.id, shiftId: shift?.id, action: 'refund', saleId: sale.id, data: { amount: total, by_method: byMethod } });
  return { id: ins.insertId, amount: total, by_method: byMethod, cash: byMethod.cash || 0 };
}

// ——— Смены и отчёты ———
export async function shiftReport(conn, shift) {
  const sales = await one("SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS total, COALESCE(SUM(vat),0) AS vat, COALESCE(SUM(tip),0) AS tips, COALESCE(SUM(discount),0) AS discount FROM sales WHERE shift_id = ? AND status = 'paid'", [shift.id], conn);
  const pays = await q("SELECT p.method, COALESCE(SUM(p.amount),0) AS amount, COALESCE(SUM(p.tip),0) AS tip FROM sale_payments p JOIN sales s ON s.id = p.sale_id WHERE s.shift_id = ? AND s.status = 'paid' GROUP BY p.method", [shift.id], conn);
  const refunds = await q('SELECT items FROM refunds WHERE shift_id = ?', [shift.id], conn);
  const byMethod = { cash: 0, card: 0, qr: 0, debt: 0 };
  const tipsByMethod = { cash: 0, card: 0, qr: 0, debt: 0 };
  for (const p of pays) { byMethod[p.method] = Number(p.amount); tipsByMethod[p.method] = Number(p.tip); }
  const refundBy = { cash: 0, card: 0, qr: 0, debt: 0 };
  for (const r of refunds) for (const [m, v] of Object.entries(json(r.items, {}).by_method || {})) refundBy[m] = (refundBy[m] || 0) + Number(v);
  const inv = await one("SELECT COUNT(*) AS n, COALESCE(SUM(JSON_EXTRACT(data, '$.amount')),0) AS amount FROM pos_log WHERE shift_id = ? AND action = 'invoice_cash'", [shift.id], conn);
  const drawer = await one("SELECT COUNT(*) AS n FROM pos_log WHERE shift_id = ? AND action = 'drawer_open'", [shift.id], conn);
  const debtCash = await one("SELECT COUNT(*) AS n, COALESCE(SUM(JSON_EXTRACT(data, '$.amount')),0) AS amount FROM pos_log WHERE shift_id = ? AND action = 'debt_cash'", [shift.id], conn);
  // НДС с наличных и с продаж в долг перечисляется при закрытии смены.
  const cashVat = await one("SELECT COALESCE(SUM(ROUND(s.vat * p.goods / NULLIF(s.total,0))),0) AS v FROM sales s JOIN (SELECT sale_id, SUM(amount - tip) AS goods FROM sale_payments WHERE method IN ('cash','debt') GROUP BY sale_id) p ON p.sale_id = s.id WHERE s.shift_id = ? AND s.status = 'paid'", [shift.id], conn);
  const expectedCash = Number(shift.opening_float) + byMethod.cash - refundBy.cash + Number(inv.amount) + Number(debtCash.amount) - Number(shift.cash_collected);
  return {
    shift: { id: shift.id, number: shift.number, opened_at: shift.opened_at, closed_at: shift.closed_at, status: shift.status },
    sales_count: Number(sales.n),
    revenue: Number(sales.total),
    vat: Number(sales.vat),
    cash_vat: Number(cashVat.v),
    discounts: Number(sales.discount),
    tips: Number(sales.tips),
    tips_by_method: tipsByMethod,
    by_method: byMethod,
    refunds: refundBy,
    refunds_total: refundBy.cash + refundBy.card + refundBy.qr + refundBy.debt,
    debts_cash: { count: Number(debtCash.n), amount: Number(debtCash.amount) },
    invoices_cash: { count: Number(inv.n), amount: Number(inv.amount) },
    drawer_opens: Number(drawer.n),
    opening_float: Number(shift.opening_float),
    collected: Number(shift.cash_collected),
    expected_cash: expectedCash,
  };
}

/** НДС с наличной выручки смены: списывается с бизнес-счёта, а если денег нет — выставляется квитанция. */
export async function settleCashVat(conn, { shop, shift, amount }) {
  if (amount <= 0) return { settled: 0 };
  try {
    const r = await post(conn, {
      kind: 'vat_cash',
      memo: `НДС с наличной выручки, смена №${shift.number}`,
      entries: [{ account: shop.account_id, amount: -amount }, { account: await sys('BUDGET', conn), amount }],
      idem: `vat_cash:${shift.id}`,
      ref: { type: 'shift', id: shift.id },
    });
    return { settled: amount, tx: r.id };
  } catch (err) {
    if (err.code !== 'insufficient_funds' && !String(err.code).startsWith('account_')) throw err;
    const owner = await one('SELECT u.gov_user_id, c.id AS citizen_id FROM bank_users u LEFT JOIN citizens c ON c.passport_no = u.passport_no WHERE u.id = ?', [shop.owner_id], conn);
    const inv = await createInvoice(conn, { citizenId: owner?.citizen_id || null, govUserId: owner?.gov_user_id || null, kind: 'tax', purpose: `НДС с наличной выручки: ${shop.name}, смена №${shift.number}`, amount, ref: { type: 'shift', id: shift.id } });
    await notify(conn, 'bank', shop.owner_id, { title: 'Выставлена квитанция на НДС', body: `${inv.number}: ${formatMoney(amount)} — на бизнес-счёте не хватило денег` });
    return { settled: 0, invoice: inv.number };
  }
}

/** Данные чека для экрана, PNG 58 мм и письма. */
export async function receiptData(saleId) {
  const sale = await loadSale(null, saleId);
  if (sale.status !== 'paid') throw bad('not_paid', 'Чек ещё не оплачен');
  const shop = await one('SELECT * FROM shops WHERE id = ?', [sale.shop_id]);
  const cashier = await one('SELECT u.full_name FROM shop_staff st JOIN bank_users u ON u.id = st.bank_user_id WHERE st.id = ?', [sale.staff_id]);
  const shift = sale.shift_id ? await one('SELECT number FROM shifts WHERE id = ?', [sale.shift_id]) : null;
  const refunds = await q('SELECT amount, method, created_at FROM refunds WHERE sale_id = ? ORDER BY id', [sale.id]);
  return {
    shop: { id: shop.id, name: shop.name, inn: shop.inn, ip_number: shop.ip_number, address: shop.address, logo: shop.logo, footer: shop.receipt_footer, color: shop.color },
    sale: saleView(sale),
    cashier: cashier?.full_name || '',
    shift: shift?.number || null,
    refunds: refunds.map((r) => ({ ...r, amount: Number(r.amount) })),
    verify_url: `${await webUrl()}/services/#/verify/receipt/${sale.verify_code}`,
  };
}

const METHOD = { cash: 'Наличные', card: 'Карта', qr: 'QR', debt: 'В долг' };
export function receiptText(r) {
  const lines = [
    r.shop.name,
    r.shop.address || '',
    `ИНН ${r.shop.inn}  ИП ${r.shop.ip_number}`,
    `Кассовый чек №${r.sale.number}`,
    `Кассир: ${r.cashier}${r.shift ? `, смена №${r.shift}` : ''}`,
    '',
    ...r.sale.items.map((i) => `${i.name}\n  ${i.unit === 'kg' ? `${(i.qty_milli / 1000).toFixed(3)} кг` : `${i.qty_milli / QTY_ONE} шт`} × ${formatMoney(i.price)} = ${formatMoney(i.total)}`),
    '',
    r.sale.discount ? `Скидка: ${formatMoney(r.sale.discount)}` : null,
    r.sale.points_used ? `Оплачено баллами: ${formatMoney(r.sale.points_used)}` : null,
    `ИТОГО: ${formatMoney(r.sale.total)}`,
    `в т.ч. НДС ${r.sale.vat_bp / 100}%: ${formatMoney(r.sale.vat)}`,
    r.sale.tip ? `Чаевые: ${formatMoney(r.sale.tip)}` : null,
    ...r.sale.payments.map((p) => `${METHOD[p.method]}: ${formatMoney(p.amount)}${p.change_given ? ` (сдача ${formatMoney(p.change_given)})` : ''}`),
    '',
    r.sale.points_earned ? `Начислено баллов: ${r.sale.points_earned}` : null,
    r.sale.queue_no ? `Номер заказа: ${r.sale.queue_no}` : null,
    `Проверка чека: ${r.verify_url}`,
    r.shop.footer || '',
  ];
  return lines.filter((l) => l !== null).join('\n');
}
