// Логика кассы: продажа, оплаты (наличные/карта/QR, раздельно), возвраты, смены, отчёты.
import { q, one, afterCommit, json } from '../db.js';
import { bad, notFound } from './errors.js';
import { getSettings, webUrl } from './settings.js';
import { post, sys } from './ledger.js';
import { publish } from './hub.js';
import { notify } from './notify.js';
import { checkCardLimits, primaryAccount } from './bank.js';
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

/** Строки чека → позиции с суммами. Цены и наличие берутся только из базы. */
async function buildItems(conn, shopId, lines, { checkStock = true } = {}) {
  if (!Array.isArray(lines) || lines.length === 0) throw bad('empty_sale', 'Чек пуст');
  if (lines.length > 200) throw bad('too_many', 'Слишком много позиций');
  const ids = [...new Set(lines.map((l) => Number(l.product_id)))];
  const rows = await q(`SELECT * FROM products WHERE shop_id = ? AND id IN (${ids.map(() => '?').join(',')}) FOR UPDATE`, [shopId, ...ids], conn);
  const byId = new Map(rows.map((p) => [p.id, p]));
  const need = new Map();
  const items = lines.map((l) => {
    const p = byId.get(Number(l.product_id));
    if (!p || !p.active) throw bad('product_not_found', 'Товар не найден');
    const qty = Math.round(Number(l.qty_milli));
    if (!Number.isSafeInteger(qty) || qty <= 0 || qty > 1e7) throw bad('invalid_qty', `Неверное количество: ${p.name}`);
    if (p.unit === 'pcs' && qty % QTY_ONE !== 0) throw bad('invalid_qty', `Штучный товар: ${p.name}`);
    need.set(p.id, (need.get(p.id) || 0) + qty);
    const total = Math.round((Number(p.price) * qty) / QTY_ONE);
    return { product_id: p.id, name: p.name, unit: p.unit, qty_milli: qty, price: Number(p.price), total, age_limit: p.age_limit };
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

export async function createSale(conn, { shopId, staff, lines, discount = 0, tipPct = 0, heldLabel = null }) {
  const s = await getSettings();
  const shift = heldLabel ? null : await openShift(conn, staff.id);
  if (!heldLabel && !shift) throw bad('no_shift', 'Откройте смену');
  const items = await buildItems(conn, shopId, lines, { checkStock: !heldLabel });
  const vatBp = Number(s.vat_bp || 0);
  const totals = priceItems(items, Math.round(Number(discount) || 0), vatBp);
  if (![0, 5, 10, 15].includes(Number(tipPct))) throw bad('invalid_tip', 'Чаевые: 0, 5, 10 или 15%');
  const tip = Math.round((totals.total * Number(tipPct)) / 100);
  const res = await q(
    'INSERT INTO sales (shop_id, shift_id, staff_id, status, subtotal, discount, total, vat, vat_bp, tip, tip_pct, hold_label) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [shopId, shift?.id || null, staff.id, heldLabel ? 'held' : 'open', totals.subtotal, totals.discount, totals.total, totals.vat, vatBp, tip, Number(tipPct), heldLabel],
    conn,
  );
  for (const it of items) {
    await q('INSERT INTO sale_items (sale_id, product_id, name, unit, qty_milli, price, discount, total, vat, age_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [res.insertId, it.product_id, it.name, it.unit, it.qty_milli, it.price, it.discount, it.total, it.vat, it.age_limit], conn);
  }
  if (totals.discount > 0) await posLog(conn, { shopId, staffId: staff.id, shiftId: shift?.id, action: 'discount', saleId: res.insertId, data: { amount: totals.discount } });
  return loadSale(conn, res.insertId);
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
    items: (sale.items || []).map((i) => ({ id: i.id, product_id: i.product_id, name: i.name, unit: i.unit, qty_milli: n(i.qty_milli), price: n(i.price), discount: n(i.discount), total: n(i.total), vat: n(i.vat), age_limit: i.age_limit, refunded_milli: n(i.refunded_milli) })),
    payments: (sale.payments || []).map((p) => ({ id: p.id, method: p.method, amount: n(p.amount), tip: n(p.tip), cash_given: p.cash_given === null ? null : n(p.cash_given), change_given: p.change_given === null ? null : n(p.change_given), refunded: n(p.refunded), created_at: p.created_at })),
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
  const fresh = await one('SELECT paid, total, tip FROM sales WHERE id = ?', [sale.id], conn);
  if (Number(fresh.paid) < Number(fresh.total) + Number(fresh.tip)) return false;
  const sh = await one('SELECT next_sale_no FROM shops WHERE id = ? FOR UPDATE', [shop.id], conn);
  await q('UPDATE shops SET next_sale_no = next_sale_no + 1 WHERE id = ?', [shop.id], conn);
  await q("UPDATE sales SET status = 'paid', number = ?, verify_code = ?, paid_at = NOW(3) WHERE id = ?", [sh.next_sale_no, newVerifyCode(), sale.id], conn);
  for (const it of sale.items) {
    if (!it.product_id) continue;
    await q('UPDATE products SET stock_milli = stock_milli - ? WHERE id = ? AND track_stock = 1', [it.qty_milli, it.product_id], conn);
    await q("INSERT INTO stock_moves (product_id, qty_milli, reason, ref_id, staff_id) VALUES (?, ?, 'sale', ?, ?)", [it.product_id, -Number(it.qty_milli), sale.id, sale.staff_id], conn);
  }
  afterCommit(conn, () => publish(`shop:${shop.id}`, { type: 'sale_paid', sale_id: sale.id, number: sh.next_sale_no }));
  return true;
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
    if (p.method !== 'cash') {
      const entries = [
        { account: shop.account_id, amount: -(part.amount - part.vat) },
        { account: p.payer_account_id, amount: part.amount },
      ];
      if (part.vat) entries.push({ account: await sys('BUDGET', conn), amount: -part.vat });
      const r = await post(conn, { kind: 'refund', memo: `Возврат: ${shop.name}, чек №${sale.number}`, entries, ref: { type: 'sale', id: sale.id }, actor: { kind: 'bank', id: staff.bank_user_id }, idem: idem ? `${idem}:${p.id}` : null });
      txIds.push(r.id);
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
  for (const part of parts) byMethod[part.payment.method] = (byMethod[part.payment.method] || 0) + part.amount;
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
  const byMethod = { cash: 0, card: 0, qr: 0 };
  const tipsByMethod = { cash: 0, card: 0, qr: 0 };
  for (const p of pays) { byMethod[p.method] = Number(p.amount); tipsByMethod[p.method] = Number(p.tip); }
  const refundBy = { cash: 0, card: 0, qr: 0 };
  for (const r of refunds) for (const [m, v] of Object.entries(json(r.items, {}).by_method || {})) refundBy[m] = (refundBy[m] || 0) + Number(v);
  const inv = await one("SELECT COUNT(*) AS n, COALESCE(SUM(JSON_EXTRACT(data, '$.amount')),0) AS amount FROM pos_log WHERE shift_id = ? AND action = 'invoice_cash'", [shift.id], conn);
  const drawer = await one("SELECT COUNT(*) AS n FROM pos_log WHERE shift_id = ? AND action = 'drawer_open'", [shift.id], conn);
  const cashVat = await one("SELECT COALESCE(SUM(ROUND(s.vat * p.goods / NULLIF(s.total,0))),0) AS v FROM sales s JOIN (SELECT sale_id, SUM(amount - tip) AS goods FROM sale_payments WHERE method = 'cash' GROUP BY sale_id) p ON p.sale_id = s.id WHERE s.shift_id = ? AND s.status = 'paid'", [shift.id], conn);
  const expectedCash = Number(shift.opening_float) + byMethod.cash - refundBy.cash + Number(inv.amount) - Number(shift.cash_collected);
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
    refunds_total: refundBy.cash + refundBy.card + refundBy.qr,
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

const METHOD = { cash: 'Наличные', card: 'Карта', qr: 'QR' };
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
    `ИТОГО: ${formatMoney(r.sale.total)}`,
    `в т.ч. НДС ${r.sale.vat_bp / 100}%: ${formatMoney(r.sale.vat)}`,
    r.sale.tip ? `Чаевые: ${formatMoney(r.sale.tip)}` : null,
    ...r.sale.payments.map((p) => `${METHOD[p.method]}: ${formatMoney(p.amount)}${p.change_given ? ` (сдача ${formatMoney(p.change_given)})` : ''}`),
    '',
    `Проверка чека: ${r.verify_url}`,
    r.shop.footer || '',
  ];
  return lines.filter((l) => l !== null).join('\n');
}
