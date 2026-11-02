// Этап 7. Касса, расширение: склад и закупки, варианты и добавки, акции, лояльность,
// долги, столики, кухня и табло очереди, киоск, отчёты владельцу.
import { tx, q, one, json, afterCommit } from '../db.js';
import { bad, notFound, int, str, amount as amountOf, need, idemKey } from '../lib/errors.js';
import { needPos, needBank, verifyHash } from '../lib/auth.js';
import { publish } from '../lib/hub.js';
import { authorizeCard, checkCardLimits, ownAccount, assertSpendable } from '../lib/bank.js';
import { priceIndex } from '../lib/finance.js';
import {
  loadSale, saleView, loyaltyCustomer, pointsOf, repayDebt, openTab, addToTab, removeFromTab, sendTabToKitchen, tabCheckout,
} from '../lib/pos.js';
import { buyWholesale, orderFromShop, acceptOrder, purchaseView, wholesaleView } from '../lib/stock.js';

const KITCHEN_STATUSES = ['new', 'cooking', 'ready', 'done', 'cancelled'];

function debtView(d) {
  return { id: d.id, shop_id: d.shop_id, shop_name: d.shop_name, sale_id: d.sale_id, customer_name: d.customer_name, bank_user_id: d.bank_user_id, amount: Number(d.amount), paid: Number(d.paid), left: Number(d.amount) - Number(d.paid), status: d.status, note: d.note, created_at: d.created_at, paid_at: d.paid_at };
}

function promoView(p) {
  return { id: p.id, title: p.title, kind: p.kind, code: p.code, value: Number(p.value), product_id: p.product_id, min_qty: p.min_qty, min_total: Number(p.min_total), max_uses: p.max_uses, used: p.used, active: !!p.active };
}

function kitchenView(k) {
  return { id: k.id, sale_id: k.sale_id, queue_no: k.queue_no, label: k.label, items: json(k.items, []), status: k.status, created_at: k.created_at, updated_at: k.updated_at };
}

export async function posExtRoutes(app) {
  const pos = { preHandler: needPos() };
  const owner = { preHandler: needPos({ owner: true }) };
  const shopOf = (req, conn) => one('SELECT * FROM shops WHERE id = ?', [req.pos.shopId], conn);

  // ——— Варианты и добавки (владелец) ———
  async function ownProduct(req, id, conn) {
    const p = await one('SELECT * FROM products WHERE id = ? AND shop_id = ? AND deleted_at IS NULL', [int(id, 'товар'), req.pos.shopId], conn);
    if (!p) throw notFound('Товар не найден');
    return p;
  }

  app.post('/products/:id/variants', owner, async (req) => {
    const p = await ownProduct(req, req.params.id);
    const delta = int(Number(req.body?.price_delta) || 0, 'надбавка', { min: -Number(p.price) + 1, max: 1e10 });
    const r = await q('INSERT INTO product_variants (product_id, name, price_delta, sort) VALUES (?, ?, ?, ?)', [p.id, str(req.body?.name, 'название', { max: 60 }), delta, Number(req.body?.sort) || 0]);
    return { id: r.insertId };
  });

  app.post('/products/:id/modifiers', owner, async (req) => {
    const p = await ownProduct(req, req.params.id);
    const price = int(Number(req.body?.price) || 0, 'цена добавки', { min: 0, max: 1e10 });
    const r = await q('INSERT INTO modifiers (product_id, name, price, sort) VALUES (?, ?, ?, ?)', [p.id, str(req.body?.name, 'название', { max: 60 }), price, Number(req.body?.sort) || 0]);
    return { id: r.insertId };
  });

  for (const [path, table] of [['variants', 'product_variants'], ['modifiers', 'modifiers']]) {
    app.patch(`/${path}/:id`, owner, async (req) => {
      const row = await one(`SELECT x.* FROM ${table} x JOIN products p ON p.id = x.product_id AND p.shop_id = ? AND p.deleted_at IS NULL WHERE x.id = ?`, [req.pos.shopId, int(req.params.id, 'id')]);
      if (!row) throw notFound();
      const b = req.body || {};
      const priceCol = table === 'modifiers' ? 'price' : 'price_delta';
      await q(`UPDATE ${table} SET name = ?, ${priceCol} = ?, active = ? WHERE id = ?`, [
        b.name !== undefined ? str(b.name, 'название', { max: 60 }) : row.name,
        b[priceCol] !== undefined ? int(Number(b[priceCol]) || 0, 'цена', { min: table === 'modifiers' ? 0 : -1e10, max: 1e10 }) : row[priceCol],
        b.active !== undefined ? (b.active ? 1 : 0) : row.active,
        row.id,
      ]);
      return { ok: true };
    });
  }

  // ——— Склад: оптовая база, рынок магазинов, закупки и заказы ———
  app.get('/wholesale', pos, async () => {
    const { index } = await priceIndex();
    const rows = await q('SELECT * FROM wholesale_items WHERE active = 1 ORDER BY category, sort, name');
    return { index, items: rows.map((w) => wholesaleView(w, index)) };
  });

  app.post('/purchases/wholesale', owner, async (req) => {
    const idem = idemKey(req, `pos${req.pos.staff.id}:wholesale`);
    const r = await tx(async (conn) => buyWholesale(conn, { shop: await shopOf(req, conn), staff: req.pos.staff, lines: req.body?.items, idem }));
    return { purchase: r };
  });

  // Оптовые предложения других магазинов (товары с ценой «оптом»).
  app.get('/market', pos, async (req) => {
    const term = `%${String(req.query.q || '').trim()}%`;
    const rows = await q(`SELECT p.id, p.name, p.category, p.unit, p.b2b_price, p.stock_milli, p.track_stock, p.photo, s.id AS shop_id, s.name AS shop_name, s.color
      FROM products p JOIN shops s ON s.id = p.shop_id AND s.status = 'active'
      WHERE p.shop_id <> ? AND p.active = 1 AND p.deleted_at IS NULL AND p.b2b_price IS NOT NULL AND (p.name LIKE ? OR s.name LIKE ?) ORDER BY s.name, p.name LIMIT 300`, [req.pos.shopId, term, term]);
    return { offers: rows.map((r) => ({ ...r, b2b_price: Number(r.b2b_price), stock_milli: r.track_stock ? Number(r.stock_milli) : null, track_stock: !!r.track_stock })) };
  });

  app.post('/purchases/shop', owner, async (req) => {
    const b = req.body || {};
    const r = await tx(async (conn) => orderFromShop(conn, { shop: await shopOf(req, conn), staff: req.pos.staff, sellerShopId: int(b.seller_shop_id, 'магазин'), lines: b.items, note: str(b.note, 'комментарий', { optional: true, max: 200 }) }));
    return { purchase: r };
  });

  app.get('/purchases', owner, async (req) => {
    const mine = await q('SELECT p.*, s.name AS seller_name FROM purchases p LEFT JOIN shops s ON s.id = p.seller_shop_id WHERE p.shop_id = ? ORDER BY p.id DESC LIMIT 100', [req.pos.shopId]);
    const incoming = await q('SELECT p.*, s.name AS shop_name FROM purchases p JOIN shops s ON s.id = p.shop_id WHERE p.seller_shop_id = ? ORDER BY p.status = \'pending\' DESC, p.id DESC LIMIT 100', [req.pos.shopId]);
    return { purchases: mine.map(purchaseView), orders: incoming.map(purchaseView) };
  });

  app.post('/orders/:id/:decision', owner, async (req) => {
    const decision = req.params.decision;
    need(['accept', 'reject'].includes(decision), 'accept | reject');
    await tx(async (conn) => {
      const seller = await shopOf(req, conn);
      if (decision === 'accept') return acceptOrder(conn, { purchaseId: int(req.params.id, 'id'), seller, staff: req.pos.staff });
      const pur = await one('SELECT * FROM purchases WHERE id = ? AND seller_shop_id = ? FOR UPDATE', [int(req.params.id, 'id'), seller.id], conn);
      if (!pur) throw notFound('Заказ не найден');
      if (pur.status !== 'pending') throw bad('decided', 'Заказ уже обработан');
      await q("UPDATE purchases SET status = 'rejected', decided_at = NOW(3) WHERE id = ?", [pur.id], conn);
      afterCommit(conn, () => publish(`shop:${pur.shop_id}`, { type: 'order_done', id: pur.id }));
      return null;
    });
    return { ok: true };
  });

  app.post('/purchases/:id/cancel', owner, async (req) => {
    const r = await q("UPDATE purchases SET status = 'cancelled', decided_at = NOW(3) WHERE id = ? AND shop_id = ? AND status = 'pending'", [int(req.params.id, 'id'), req.pos.shopId]);
    if (!r.affectedRows) throw bad('decided', 'Заказ уже обработан');
    return { ok: true };
  });

  app.get('/stock/moves', owner, async (req) => {
    const rows = await q(`SELECT m.*, p.name, p.unit FROM stock_moves m JOIN products p ON p.id = m.product_id WHERE p.shop_id = ?${req.query.product_id ? ' AND p.id = ?' : ''} ORDER BY m.id DESC LIMIT 200`, [req.pos.shopId, ...(req.query.product_id ? [Number(req.query.product_id)] : [])]);
    return { moves: rows.map((m) => ({ ...m, qty_milli: Number(m.qty_milli) })) };
  });

  // ——— Акции и промокоды ———
  function promoFields(b) {
    const kind = ['percent', 'amount', 'qty'].includes(b.kind) ? b.kind : null;
    need(kind, 'Вид акции: процент, сумма или за количество');
    const value = kind === 'amount' ? amountOf(b.value, 'скидка') : int(Number(b.value), 'процент (б.п.)', { min: 1, max: 10000 });
    const code = b.code ? String(b.code).trim().toUpperCase().replace(/\s/g, '') : null;
    if (code) need(/^[A-Z0-9А-ЯЁ_-]{3,32}$/.test(code), 'Промокод: 3–32 буквы или цифры');
    if (kind === 'qty') need(b.product_id, 'Скидка за количество — на конкретный товар');
    return {
      title: str(b.title, 'название', { max: 80 }), kind, value, code,
      product_id: b.product_id ? int(b.product_id, 'товар') : null,
      min_qty: kind === 'qty' ? int(Number(b.min_qty) || 0, 'от количества', { min: 2, max: 10000 }) : 0,
      min_total: b.min_total ? int(b.min_total, 'от суммы', { min: 0, max: 1e12 }) : 0,
      max_uses: b.max_uses ? int(b.max_uses, 'лимит', { min: 1, max: 1e6 }) : null,
      active: b.active === undefined ? 1 : b.active ? 1 : 0,
    };
  }

  app.get('/promos', pos, async (req) => ({ promos: (await q('SELECT * FROM promos WHERE shop_id = ? ORDER BY active DESC, id DESC', [req.pos.shopId])).map(promoView) }));

  app.post('/promos', owner, async (req) => {
    const f = promoFields(req.body || {});
    if (f.product_id) await ownProduct(req, f.product_id);
    try {
      const r = await q('INSERT INTO promos (shop_id, title, kind, code, value, product_id, min_qty, min_total, max_uses, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [req.pos.shopId, f.title, f.kind, f.code, f.value, f.product_id, f.min_qty, f.min_total, f.max_uses, f.active]);
      return { id: r.insertId };
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw bad('promo_exists', 'Такой промокод уже есть');
      throw err;
    }
  });

  app.patch('/promos/:id', owner, async (req) => {
    const p = await one('SELECT * FROM promos WHERE id = ? AND shop_id = ?', [int(req.params.id, 'id'), req.pos.shopId]);
    if (!p) throw notFound();
    if (Object.keys(req.body || {}).length === 1 && req.body.active !== undefined) {
      await q('UPDATE promos SET active = ? WHERE id = ?', [req.body.active ? 1 : 0, p.id]);
      return { ok: true };
    }
    const f = promoFields({ ...promoView(p), ...req.body });
    await q('UPDATE promos SET title = ?, kind = ?, code = ?, value = ?, product_id = ?, min_qty = ?, min_total = ?, max_uses = ?, active = ? WHERE id = ?', [f.title, f.kind, f.code, f.value, f.product_id, f.min_qty, f.min_total, f.max_uses, f.active, p.id]);
    return { ok: true };
  });

  // ——— Лояльность: клиент по карте ВлодБанка или паспорту БФ ———
  app.get('/loyalty/lookup', pos, async (req) => {
    const u = await loyaltyCustomer(null, req.query.q);
    const parts = u.full_name.split(' ');
    return { customer: { id: u.id, name: [parts[0], ...parts.slice(1).map((p) => `${p[0]}.`)].join(' '), points: await pointsOf(null, req.pos.shopId, u.id) } };
  });

  app.get('/loyalty', owner, async (req) => {
    const rows = await q('SELECT l.points, l.updated_at, u.full_name FROM loyalty_points l JOIN bank_users u ON u.id = l.bank_user_id WHERE l.shop_id = ? AND l.points > 0 ORDER BY l.points DESC LIMIT 200', [req.pos.shopId]);
    return { members: rows.map((r) => ({ ...r, points: Number(r.points) })) };
  });

  // ——— Долги ———
  app.get('/debts', pos, async (req) => {
    const status = ['open', 'paid', 'written_off'].includes(req.query.status) ? req.query.status : 'open';
    const rows = await q('SELECT * FROM debts WHERE shop_id = ? AND status = ? ORDER BY id DESC LIMIT 300', [req.pos.shopId, status]);
    const sum = await one("SELECT COALESCE(SUM(amount - paid),0) AS s, COUNT(*) AS n FROM debts WHERE shop_id = ? AND status = 'open'", [req.pos.shopId]);
    return { debts: rows.map(debtView), open_total: Number(sum.s), open_count: Number(sum.n) };
  });

  app.post('/debts/:id/repay', pos, async (req) => {
    const b = req.body || {};
    const amount = amountOf(b.amount);
    const idem = idemKey(req, `pos${req.pos.staff.id}:debt`);
    const card = b.method === 'card' ? await authorizeCard({ number: b.number, exp: b.exp, pin: b.pin }) : null;
    const r = await tx(async (conn) => {
      const debt = await one('SELECT * FROM debts WHERE id = ? AND shop_id = ? FOR UPDATE', [int(req.params.id, 'id'), req.pos.shopId], conn);
      if (!debt) throw notFound('Долг не найден');
      const shop = await shopOf(req, conn);
      if (card) {
        await checkCardLimits(conn, card, amount);
        return repayDebt(conn, { debt, shop, amount, fromAccountId: card.account_id, cardId: card.id, actor: { kind: 'bank', id: req.pos.bank.id }, idem });
      }
      need(b.method === 'cash', 'Способ: наличные или карта');
      return repayDebt(conn, { debt, shop, amount, staff: req.pos.staff });
    });
    return r;
  });

  app.post('/debts/:id/write-off', owner, async (req) => {
    const r = await q("UPDATE debts SET status = 'written_off' WHERE id = ? AND shop_id = ? AND status = 'open'", [int(req.params.id, 'id'), req.pos.shopId]);
    if (!r.affectedRows) throw bad('debt_closed', 'Долг уже закрыт');
    return { ok: true };
  });

  // ——— Столики и счета столов ———
  app.get('/tables', pos, async (req) => {
    const all = req.query.all === '1';
    const tables = await q(`SELECT * FROM shop_tables WHERE shop_id = ?${all ? '' : ' AND active = 1'} ORDER BY sort, id`, [req.pos.shopId]);
    const tabs = await q("SELECT id, table_id, total, created_at FROM sales WHERE shop_id = ? AND status = 'held' AND table_id IS NOT NULL", [req.pos.shopId]);
    const paying = await q("SELECT id, table_id FROM sales WHERE shop_id = ? AND status = 'open' AND table_id IS NOT NULL", [req.pos.shopId]);
    return {
      tables: tables.map((t) => {
        const tab = tabs.find((x) => x.table_id === t.id);
        return { id: t.id, name: t.name, seats: t.seats, active: !!t.active, sort: t.sort, tab: tab ? { id: tab.id, total: Number(tab.total), opened_at: tab.created_at } : null, paying: paying.some((x) => x.table_id === t.id) };
      }),
    };
  });

  app.post('/tables', owner, async (req) => {
    const r = await q('INSERT INTO shop_tables (shop_id, name, seats, sort) VALUES (?, ?, ?, ?)', [req.pos.shopId, str(req.body?.name, 'название', { max: 40 }), int(Number(req.body?.seats) || 4, 'мест', { min: 1, max: 100 }), Number(req.body?.sort) || 0]);
    return { id: r.insertId };
  });

  app.patch('/tables/:id', owner, async (req) => {
    const t = await one('SELECT * FROM shop_tables WHERE id = ? AND shop_id = ?', [int(req.params.id, 'id'), req.pos.shopId]);
    if (!t) throw notFound();
    const b = req.body || {};
    await q('UPDATE shop_tables SET name = ?, seats = ?, active = ? WHERE id = ?', [b.name !== undefined ? str(b.name, 'название', { max: 40 }) : t.name, b.seats !== undefined ? int(Number(b.seats), 'мест', { min: 1, max: 100 }) : t.seats, b.active !== undefined ? (b.active ? 1 : 0) : t.active, t.id]);
    return { ok: true };
  });

  async function tableOf(req, id, conn) {
    const t = await one('SELECT * FROM shop_tables WHERE id = ? AND shop_id = ? AND active = 1', [int(id, 'стол'), req.pos.shopId], conn);
    if (!t) throw notFound('Стол не найден');
    return t;
  }

  async function tabOf(req, tableId, conn) {
    const table = await tableOf(req, tableId, conn);
    const tab = await openTab(conn, req.pos.shopId, table.id);
    if (!tab) throw notFound('У стола нет открытого счёта');
    return { table, tab: await loadSale(conn, tab.id) };
  }

  app.get('/tables/:id/tab', pos, async (req) => {
    const table = await tableOf(req, req.params.id);
    const tab = await openTab(null, req.pos.shopId, table.id);
    return { table: { id: table.id, name: table.name }, tab: tab ? saleView(await loadSale(null, tab.id)) : null };
  });

  app.post('/tables/:id/items', pos, async (req) => {
    const sale = await tx(async (conn) => addToTab(conn, { shopId: req.pos.shopId, staff: req.pos.staff, table: await tableOf(req, req.params.id, conn), lines: req.body?.items }));
    publish(`shop:${req.pos.shopId}`, { type: 'tables' });
    return { tab: saleView(sale) };
  });

  app.post('/tables/:id/remove', pos, async (req) => {
    const sale = await tx(async (conn) => {
      const { tab } = await tabOf(req, req.params.id, conn);
      return removeFromTab(conn, { tab, itemId: int(req.body?.item_id, 'позиция'), staff: req.pos.staff });
    });
    publish(`shop:${req.pos.shopId}`, { type: 'tables' });
    return { tab: sale ? saleView(sale) : null };
  });

  app.post('/tables/:id/kitchen', pos, async (req) => {
    const order = await tx(async (conn) => {
      const { tab, table } = await tabOf(req, req.params.id, conn);
      return sendTabToKitchen(conn, { tab, table });
    });
    return { order };
  });

  app.post('/tables/:id/checkout', pos, async (req) => {
    const b = req.body || {};
    const sale = await tx(async (conn) => {
      const { tab } = await tabOf(req, req.params.id, conn);
      return tabCheckout(conn, {
        tab,
        staff: req.pos.staff,
        discount: b.discount ? int(b.discount, 'скидка', { min: 0, max: 1e12 }) : 0,
        promoCode: b.promo_code || null,
        loyalty: b.loyalty || null,
        redeemPoints: b.redeem_points ? int(b.redeem_points, 'баллы', { min: 0, max: 1e12 }) : 0,
        tipPct: Number(b.tip_pct || 0),
      });
    });
    publish(`shop:${req.pos.shopId}`, { type: 'tables' });
    return { sale: saleView(sale) };
  });

  // Перенос счёта на другой стол.
  app.post('/tables/:id/move', pos, async (req) => {
    await tx(async (conn) => {
      const { tab } = await tabOf(req, req.params.id, conn);
      const to = await tableOf(req, req.body?.to_table_id, conn);
      if (await openTab(conn, req.pos.shopId, to.id)) throw bad('table_busy', 'У стола уже есть открытый счёт');
      await q('UPDATE sales SET table_id = ?, hold_label = ? WHERE id = ?', [to.id, to.name, tab.id], conn);
    });
    publish(`shop:${req.pos.shopId}`, { type: 'tables' });
    return { ok: true };
  });

  // ——— Кухня и табло очереди ———
  app.get('/kitchen', pos, async (req) => {
    const rows = await q("SELECT * FROM kitchen_orders WHERE shop_id = ? AND (status IN ('new','cooking','ready') OR (status = 'done' AND updated_at >= NOW(3) - INTERVAL 30 MINUTE)) ORDER BY id", [req.pos.shopId]);
    return { orders: rows.map(kitchenView) };
  });

  app.post('/kitchen/:id/status', pos, async (req) => {
    const status = String(req.body?.status || '');
    need(KITCHEN_STATUSES.includes(status), 'Неверный статус');
    const r = await q('UPDATE kitchen_orders SET status = ? WHERE id = ? AND shop_id = ?', [status, int(req.params.id, 'id'), req.pos.shopId]);
    if (!r.affectedRows) throw notFound();
    publish(`shop:${req.pos.shopId}`, { type: 'kitchen', id: Number(req.params.id), status });
    return { ok: true };
  });

  app.get('/queue', pos, async (req) => {
    const shop = await shopOf(req);
    const rows = await q("SELECT queue_no, status, label FROM kitchen_orders WHERE shop_id = ? AND status IN ('new','cooking','ready') ORDER BY id", [req.pos.shopId]);
    return {
      shop: { name: shop.name, color: shop.color, logo: shop.logo },
      cooking: rows.filter((r) => r.status !== 'ready').map((r) => r.queue_no),
      ready: rows.filter((r) => r.status === 'ready').map((r) => r.queue_no),
    };
  });

  // ——— Киоск: выход из режима самообслуживания по PIN сотрудника ———
  app.post('/kiosk/unlock', pos, async (req) => {
    const st = await one('SELECT pin_hash FROM shop_staff WHERE id = ?', [req.pos.staff.id]);
    if (!(await verifyHash(String(req.body?.pin || ''), st.pin_hash))) throw bad('pin_wrong', 'Неверный PIN');
    return { ok: true };
  });

  // ——— Отчёты владельцу ———
  app.get('/reports', owner, async (req) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    const id = req.pos.shopId;
    const where = "s.shop_id = ? AND s.status = 'paid' AND s.paid_at >= NOW() - INTERVAL ? DAY";
    const totals = await one(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS revenue, COALESCE(SUM(vat),0) AS vat, COALESCE(SUM(refunded),0) AS refunded, COALESCE(SUM(discount),0) AS discounts, COALESCE(SUM(tip),0) AS tips FROM sales s WHERE ${where}`, [id, days]);
    const cost = await one(`SELECT COALESCE(SUM(ROUND(p.cost * (i.qty_milli - i.refunded_milli) / 1000)),0) AS cost FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN products p ON p.id = i.product_id WHERE ${where}`, [id, days]);
    const top = await q(`SELECT i.name, SUM(i.qty_milli - i.refunded_milli) AS qty_milli, SUM(i.total) AS total, MAX(i.unit) AS unit FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE ${where} GROUP BY i.name ORDER BY total DESC LIMIT 10`, [id, days]);
    const byCategory = await q(`SELECT COALESCE(NULLIF(p.category,''),'—') AS category, SUM(i.total) AS total FROM sale_items i JOIN sales s ON s.id = i.sale_id LEFT JOIN products p ON p.id = i.product_id WHERE ${where} GROUP BY category ORDER BY total DESC`, [id, days]);
    const byCashier = await q(`SELECT u.full_name, COUNT(*) AS n, SUM(s.total) AS total, SUM(s.tip) AS tips FROM sales s JOIN shop_staff st ON st.id = s.staff_id JOIN bank_users u ON u.id = st.bank_user_id WHERE ${where} GROUP BY u.full_name ORDER BY total DESC`, [id, days]);
    const byHour = await q(`SELECT HOUR(paid_at) AS h, COUNT(*) AS n, SUM(total) AS total FROM sales s WHERE ${where} GROUP BY HOUR(paid_at) ORDER BY h`, [id, days]);
    const byDay = await q(`SELECT DATE(paid_at) AS d, COUNT(*) AS n, SUM(total) AS total, SUM(refunded) AS refunded FROM sales s WHERE ${where} GROUP BY DATE(paid_at) ORDER BY d`, [id, days]);
    const byMethod = await q(`SELECT p.method, SUM(p.amount) AS total FROM sale_payments p JOIN sales s ON s.id = p.sale_id WHERE ${where} GROUP BY p.method`, [id, days]);
    const bySource = await q(`SELECT s.source, COUNT(*) AS n, SUM(s.total) AS total FROM sales s WHERE ${where} GROUP BY s.source`, [id, days]);
    const purchases = await one("SELECT COALESCE(SUM(total),0) AS s FROM purchases WHERE shop_id = ? AND status = 'done' AND decided_at >= NOW() - INTERVAL ? DAY", [id, days]);
    const debts = await one("SELECT COALESCE(SUM(amount - paid),0) AS s FROM debts WHERE shop_id = ? AND status = 'open'", [id]);
    const stockValue = await one('SELECT COALESCE(SUM(ROUND(cost * GREATEST(stock_milli,0) / 1000)),0) AS s FROM products WHERE shop_id = ? AND deleted_at IS NULL AND track_stock = 1', [id]);
    const low = await q('SELECT id, name, unit, stock_milli FROM products WHERE shop_id = ? AND deleted_at IS NULL AND active = 1 AND track_stock = 1 AND stock_milli <= 5000 ORDER BY stock_milli LIMIT 20', [id]);
    const balance = await one('SELECT a.balance FROM shops s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?', [id]);
    const revenue = Number(totals.revenue) - Number(totals.refunded);
    const n = (v) => Number(v || 0);
    return {
      days,
      sales: n(totals.n),
      revenue,
      vat: n(totals.vat),
      cost: n(cost.cost),
      profit: revenue - n(totals.vat) - n(cost.cost),
      discounts: n(totals.discounts),
      refunds: n(totals.refunded),
      tips: n(totals.tips),
      avg_check: n(totals.n) ? Math.round(n(totals.revenue) / n(totals.n)) : 0,
      purchases: n(purchases.s),
      debts_open: n(debts.s),
      stock_value: n(stockValue.s),
      business_balance: n(balance?.balance),
      top: top.map((r) => ({ name: r.name, unit: r.unit, qty_milli: n(r.qty_milli), total: n(r.total) })),
      by_category: byCategory.map((r) => ({ category: r.category, total: n(r.total) })),
      by_cashier: byCashier.map((r) => ({ name: r.full_name, sales: n(r.n), total: n(r.total), tips: n(r.tips) })),
      by_hour: byHour.map((r) => ({ hour: r.h, sales: n(r.n), total: n(r.total) })),
      by_day: byDay.map((r) => ({ day: r.d, sales: n(r.n), total: n(r.total) - n(r.refunded) })),
      by_method: Object.fromEntries(byMethod.map((r) => [r.method, n(r.total)])),
      by_source: Object.fromEntries(bySource.map((r) => [r.source, { sales: n(r.n), total: n(r.total) }])),
      low_stock: low.map((p) => ({ ...p, stock_milli: n(p.stock_milli) })),
    };
  });
}

/** Долги клиента ВлодБанка перед магазинами: видны в банке, гасятся переводом. */
export async function bankDebtRoutes(app) {
  const auth = { preHandler: needBank({ active: true }) };

  app.get('/debts', auth, async (req) => {
    const rows = await q("SELECT d.*, s.name AS shop_name FROM debts d JOIN shops s ON s.id = d.shop_id WHERE d.bank_user_id = ? ORDER BY d.status = 'open' DESC, d.id DESC LIMIT 100", [req.bank.id]);
    return { debts: rows.map(debtView) };
  });

  app.post('/debts/:id/pay', auth, async (req) => {
    const idem = idemKey(req, `b${req.bank.id}:debt`);
    const r = await tx(async (conn) => {
      const debt = await one('SELECT * FROM debts WHERE id = ? AND bank_user_id = ? FOR UPDATE', [int(req.params.id, 'id'), req.bank.id], conn);
      if (!debt) throw notFound('Долг не найден');
      const acc = await ownAccount(req.bank.id, int(req.body?.account_id, 'счёт'), conn);
      assertSpendable(acc);
      const shop = await one('SELECT * FROM shops WHERE id = ?', [debt.shop_id], conn);
      const amount = req.body?.amount ? amountOf(req.body.amount) : Number(debt.amount) - Number(debt.paid);
      return repayDebt(conn, { debt, shop, amount, fromAccountId: acc.id, actor: { kind: 'bank', id: req.bank.id }, idem });
    });
    return r;
  });
}
