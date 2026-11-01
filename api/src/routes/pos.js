import { tx, q, one, afterCommit } from '../db.js';
import { bad, notFound, forbidden, int, str, amount as amountOf, need, idemKey } from '../lib/errors.js';
import { needBank, needPos, issue, clear, hash, verifyHash, actorOf } from '../lib/auth.js';
import { getSettings, webUrl } from '../lib/settings.js';
import { publish } from '../lib/hub.js';
import { audit } from '../lib/audit.js';
import { sendMail } from '../lib/mail.js';
import { ipOf, innOf, authorizeCard, requireVerified, ownAccount } from '../lib/bank.js';
import { payInvoice, publicInvoice } from '../lib/gov.js';
import {
  openShift, posLog, createSale, loadSale, saleView, payByCard, payByCash, createQr, refundSale, shiftReport, settleCashVat, terminalBySale, receiptData, receiptText,
} from '../lib/pos.js';
import { newTerminalCode, withUnique } from '../lib/ids.js';
import { ageFrom } from '@bln/shared/format.js';

const limited = (max) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });
const COLOR_RE = /^#[0-9a-fA-F]{6}$/;
const MAX_IMAGE = 400_000;

function image(v, name) {
  if (v === undefined) return undefined;
  if (v === null || v === '') return null;
  need(typeof v === 'string' && /^data:image\/(jpeg|png|webp|svg\+xml);base64,/.test(v) && v.length < MAX_IMAGE, `${name}: изображение до 300 КБ`);
  return v;
}

function shopView(s) {
  return { id: s.id, name: s.name, type: s.type, color: s.color, logo: s.logo, inn: s.inn, ip_number: s.ip_number, address: s.address, receipt_footer: s.receipt_footer, status: s.status, account_id: s.account_id, cashback_category_id: s.cashback_category_id ?? null };
}

function productView(p) {
  return { id: p.id, name: p.name, category: p.category, barcode: p.barcode, price: Number(p.price), cost: Number(p.cost), unit: p.unit, age_limit: p.age_limit, photo: p.photo, track_stock: !!p.track_stock, stock_milli: Number(p.stock_milli), active: !!p.active, sort: p.sort };
}

/** Категория кешбэка магазина: выбранная владельцем или по умолчанию по типу (кафе / магазин). */
async function cashbackCategory(conn, id, type) {
  if (id) {
    const c = await one('SELECT id FROM cashback_categories WHERE id = ? AND active = 1', [Number(id) || 0], conn);
    if (!c) throw bad('invalid', 'Неизвестная категория кешбэка');
    return c.id;
  }
  const d = await one('SELECT id FROM cashback_categories WHERE name = ? AND active = 1', [type === 'cafe' ? 'Кафе и рестораны' : 'Продукты'], conn);
  return d?.id || null;
}

async function shopOf(req, conn) {
  return one('SELECT * FROM shops WHERE id = ?', [req.pos.shopId], conn);
}

function staffActor(req) {
  return { kind: 'bank', id: req.pos.bank.id };
}

export async function posRoutes(app) {
  const bankAuth = { preHandler: needBank() };
  const pos = { preHandler: needPos() };
  const owner = { preHandler: needPos({ owner: true }) };

  // ——— Магазины: создание и вход ———
  app.get('/cashback-categories', async () => ({ categories: await q('SELECT id, name, rate_bp FROM cashback_categories WHERE active = 1 ORDER BY sort, id') }));

  app.get('/my-shops', bankAuth, async (req) => {
    const rows = await q("SELECT s.*, st.role AS my_role, st.pin_hash IS NOT NULL AS has_pin FROM shops s JOIN shop_staff st ON st.shop_id = s.id AND st.bank_user_id = ? AND st.active = 1 WHERE s.status = 'active' ORDER BY s.name", [req.bank.id]);
    const ip = await ipOf(req.bank.user);
    const business = await q("SELECT id, number, name, balance FROM accounts WHERE owner_kind = 'bank_user' AND owner_id = ? AND type = 'business' AND status = 'active'", [req.bank.id]);
    return {
      shops: rows.map((s) => ({ ...shopView(s), my_role: s.my_role, has_pin: !!s.has_pin })),
      can_create: { has_ip: !!ip, business_accounts: business.map((a) => ({ ...a, balance: Number(a.balance) })) },
    };
  });

  app.post('/shops', bankAuth, async (req) => {
    const b = req.body || {};
    const shop = await tx(async (conn) => {
      const u = await one('SELECT * FROM bank_users WHERE id = ?', [req.bank.id], conn);
      requireVerified(u);
      const ip = await ipOf(u, conn);
      if (!ip) throw bad('no_ip', 'Нужно свидетельство ИП во ВлодУслугах');
      const acc = await ownAccount(u.id, int(b.account_id, 'бизнес-счёт'), conn);
      if (acc.type !== 'business' || acc.status !== 'active') throw bad('need_business', 'Нужен действующий бизнес-счёт ВлодБанка');
      const inn = await innOf(u, conn);
      const pin = String(b.pin || '');
      need(/^\d{4}$/.test(pin), 'PIN кассира — 4 цифры');
      const type = b.type === 'cafe' ? 'cafe' : 'shop';
      const res = await q('INSERT INTO shops (owner_id, name, type, color, account_id, inn, ip_number, address, cashback_category_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        u.id, str(b.name, 'название', { min: 2, max: 80 }), type, COLOR_RE.test(b.color) ? b.color : '#0f766e', acc.id, inn?.number || '', ip.number, str(b.address, 'адрес', { optional: true, max: 160 }),
        await cashbackCategory(conn, b.cashback_category_id, type),
      ], conn);
      await q("INSERT INTO shop_staff (shop_id, bank_user_id, role, pin_hash) VALUES (?, ?, 'owner', ?)", [res.insertId, u.id, await hash(pin)], conn);
      await audit(conn, actorOf(req.bank), 'pos.shop_create', 'shop', res.insertId);
      return one('SELECT * FROM shops WHERE id = ?', [res.insertId], conn);
    });
    return { shop: shopView(shop) };
  });

  app.post('/login', { ...bankAuth, ...limited(10) }, async (req, reply) => {
    const shopId = int(req.body?.shop_id, 'магазин');
    const staff = await one("SELECT st.* FROM shop_staff st JOIN shops s ON s.id = st.shop_id AND s.status = 'active' WHERE st.shop_id = ? AND st.bank_user_id = ? AND st.active = 1", [shopId, req.bank.id]);
    if (!staff) throw forbidden('Вы не работаете в этом магазине');
    if (!staff.pin_hash) throw bad('no_pin', 'Владелец ещё не выдал вам PIN кассира');
    if (!(await verifyHash(String(req.body?.pin || ''), staff.pin_hash))) throw bad('pin_wrong', 'Неверный PIN кассира');
    await issue(reply, 'pos', { uid: req.bank.id, staff: staff.id });
    await posLog(null, { shopId, staffId: staff.id, action: 'login' });
    return { ok: true };
  });

  app.post('/logout', async (req, reply) => {
    clear(reply, 'pos');
    return { ok: true };
  });

  app.get('/session', pos, async (req) => {
    const shop = await shopOf(req);
    const shift = await openShift(null, req.pos.staff.id);
    const held = await one("SELECT COUNT(*) AS n FROM sales WHERE shop_id = ? AND status = 'held'", [shop.id]);
    const s = await getSettings();
    return {
      shop: shopView(shop),
      staff: { id: req.pos.staff.id, role: req.pos.staff.role, name: req.pos.bank.user.full_name },
      shift: shift ? { id: shift.id, number: shift.number, opened_at: shift.opened_at, opening_float: Number(shift.opening_float) } : null,
      held: held.n,
      vat_bp: s.vat_bp,
      verify_base: `${await webUrl()}/services/#/verify/receipt/`,
    };
  });

  // ——— Настройки магазина (владелец) ———
  app.patch('/shop', owner, async (req) => {
    const b = req.body || {};
    const shop = await shopOf(req);
    const logo = image(b.logo, 'логотип');
    const cat = b.cashback_category_id !== undefined ? await cashbackCategory(null, b.cashback_category_id, shop.type) : shop.cashback_category_id;
    await q('UPDATE shops SET cashback_category_id = ? WHERE id = ?', [cat, shop.id]);
    await q('UPDATE shops SET name = ?, type = ?, color = ?, address = ?, receipt_footer = ?, logo = ? WHERE id = ?', [
      b.name !== undefined ? str(b.name, 'название', { min: 2, max: 80 }) : shop.name,
      b.type === 'cafe' || b.type === 'shop' ? b.type : shop.type,
      COLOR_RE.test(b.color || '') ? b.color : shop.color,
      b.address !== undefined ? str(b.address, 'адрес', { optional: true, max: 160 }) : shop.address,
      b.receipt_footer !== undefined ? str(b.receipt_footer, 'подпись в чеке', { optional: true, max: 200 }) : shop.receipt_footer,
      logo === undefined ? shop.logo : logo,
      shop.id,
    ]);
    return { shop: shopView(await shopOf(req)) };
  });

  // ——— Персонал (владелец) ———
  app.get('/staff', owner, async (req) => {
    const rows = await q('SELECT st.id, st.role, st.salary, st.active, st.pin_hash IS NOT NULL AS has_pin, u.full_name, u.email FROM shop_staff st JOIN bank_users u ON u.id = st.bank_user_id WHERE st.shop_id = ? ORDER BY st.role DESC, u.full_name', [req.pos.shopId]);
    return { staff: rows.map((r) => ({ ...r, salary: Number(r.salary), active: !!r.active, has_pin: !!r.has_pin })) };
  });

  app.post('/staff', owner, async (req) => {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const u = await one("SELECT id, full_name FROM bank_users WHERE email = ? AND status = 'active'", [email]);
    if (!u) throw notFound('Клиент ВлодБанка с таким email не найден');
    const pin = String(b.pin || '');
    need(/^\d{4}$/.test(pin), 'PIN кассира — 4 цифры');
    const salary = b.salary ? amountOf(b.salary, 'зарплата') : 0;
    await q("INSERT INTO shop_staff (shop_id, bank_user_id, role, pin_hash, salary) VALUES (?, ?, 'cashier', ?, ?) ON DUPLICATE KEY UPDATE active = 1, pin_hash = VALUES(pin_hash), salary = VALUES(salary)", [req.pos.shopId, u.id, await hash(pin), salary]);
    await audit(null, staffActor(req), 'pos.staff_add', 'shop', req.pos.shopId, { user: u.id });
    return { ok: true };
  });

  app.patch('/staff/:id', owner, async (req) => {
    const st = await one('SELECT * FROM shop_staff WHERE id = ? AND shop_id = ?', [int(req.params.id, 'id'), req.pos.shopId]);
    if (!st) throw notFound();
    const b = req.body || {};
    if (b.pin !== undefined) {
      need(/^\d{4}$/.test(String(b.pin)), 'PIN кассира — 4 цифры');
      await q('UPDATE shop_staff SET pin_hash = ? WHERE id = ?', [await hash(String(b.pin)), st.id]);
    }
    if (b.salary !== undefined) await q('UPDATE shop_staff SET salary = ? WHERE id = ?', [b.salary ? amountOf(b.salary, 'зарплата') : 0, st.id]);
    if (b.active !== undefined && st.role !== 'owner') await q('UPDATE shop_staff SET active = ? WHERE id = ?', [b.active ? 1 : 0, st.id]);
    return { ok: true };
  });

  // ——— Товары ———
  app.get('/products', pos, async (req) => {
    const all = req.query.all === '1' && req.pos.staff.role === 'owner';
    const rows = await q(`SELECT * FROM products WHERE shop_id = ?${all ? '' : ' AND active = 1'} ORDER BY category, sort, name`, [req.pos.shopId]);
    return { products: rows.map(productView) };
  });

  function productFields(b, prev = {}) {
    const val = (k, f) => (b[k] !== undefined ? f(b[k]) : prev[k]);
    return {
      name: val('name', (v) => str(v, 'название', { max: 120 })),
      category: val('category', (v) => (v ? String(v).trim().slice(0, 60) : '')) ?? '',
      barcode: val('barcode', (v) => (v ? String(v).replace(/\s/g, '').slice(0, 64) : null)) ?? null,
      price: val('price', (v) => amountOf(v, 'цена')),
      cost: val('cost', (v) => (v === '' || v === null ? 0 : int(v, 'закупочная цена', { min: 0, max: 1e12 }))) ?? 0,
      unit: val('unit', (v) => (v === 'kg' ? 'kg' : 'pcs')) ?? 'pcs',
      age_limit: val('age_limit', (v) => int(Number(v) || 0, 'возраст', { min: 0, max: 21 })) ?? 0,
      photo: b.photo !== undefined ? image(b.photo, 'фото') : prev.photo ?? null,
      track_stock: val('track_stock', (v) => (v ? 1 : 0)) ?? 1,
      sort: val('sort', (v) => int(Number(v) || 0, 'порядок')) ?? 0,
      active: val('active', (v) => (v ? 1 : 0)) ?? 1,
    };
  }

  app.post('/products', owner, async (req) => {
    const f = productFields(req.body || {});
    need(f.name && f.price, 'Укажите название и цену');
    const res = await q('INSERT INTO products (shop_id, name, category, barcode, price, cost, unit, age_limit, photo, track_stock, sort, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [req.pos.shopId, f.name, f.category, f.barcode, f.price, f.cost, f.unit, f.age_limit, f.photo, f.track_stock, f.sort, f.active]);
    const initial = Number(req.body?.stock_milli || 0);
    if (initial > 0) {
      await q('UPDATE products SET stock_milli = ? WHERE id = ?', [Math.round(initial), res.insertId]);
      await q("INSERT INTO stock_moves (product_id, qty_milli, reason, staff_id) VALUES (?, ?, 'manual', ?)", [res.insertId, Math.round(initial), req.pos.staff.id]);
    }
    return { product: productView(await one('SELECT * FROM products WHERE id = ?', [res.insertId])) };
  });

  app.patch('/products/:id', owner, async (req) => {
    const p = await one('SELECT * FROM products WHERE id = ? AND shop_id = ?', [int(req.params.id, 'id'), req.pos.shopId]);
    if (!p) throw notFound('Товар не найден');
    const f = productFields(req.body || {}, { ...p, price: Number(p.price), cost: Number(p.cost) });
    await q('UPDATE products SET name = ?, category = ?, barcode = ?, price = ?, cost = ?, unit = ?, age_limit = ?, photo = ?, track_stock = ?, sort = ?, active = ? WHERE id = ?', [f.name, f.category, f.barcode, f.price, f.cost, f.unit, f.age_limit, f.photo, f.track_stock, f.sort, f.active, p.id]);
    return { product: productView(await one('SELECT * FROM products WHERE id = ?', [p.id])) };
  });

  // Ручная корректировка остатка (полный склад и закупки — этап 7).
  app.post('/stock', owner, async (req) => {
    const p = await one('SELECT * FROM products WHERE id = ? AND shop_id = ?', [int(req.body?.product_id, 'товар'), req.pos.shopId]);
    if (!p) throw notFound('Товар не найден');
    const delta = int(Math.round(Number(req.body?.qty_milli)), 'количество', { min: -1e9, max: 1e9 });
    await tx(async (conn) => {
      await q('UPDATE products SET stock_milli = stock_milli + ? WHERE id = ?', [delta, p.id], conn);
      await q("INSERT INTO stock_moves (product_id, qty_milli, reason, staff_id) VALUES (?, ?, ?, ?)", [p.id, delta, delta < 0 ? 'writeoff' : 'manual', req.pos.staff.id], conn);
    });
    return { product: productView(await one('SELECT * FROM products WHERE id = ?', [p.id])) };
  });

  // ——— Смены ———
  app.post('/shifts/open', pos, async (req) => {
    const float = req.body?.opening_float ? int(req.body.opening_float, 'разменный фонд', { min: 0, max: 1e10 }) : 0;
    const shift = await tx(async (conn) => {
      if (await openShift(conn, req.pos.staff.id)) throw bad('shift_open', 'Смена уже открыта');
      const shop = await one('SELECT next_shift_no FROM shops WHERE id = ? FOR UPDATE', [req.pos.shopId], conn);
      await q('UPDATE shops SET next_shift_no = next_shift_no + 1 WHERE id = ?', [req.pos.shopId], conn);
      const r = await q('INSERT INTO shifts (shop_id, staff_id, number, opening_float) VALUES (?, ?, ?, ?)', [req.pos.shopId, req.pos.staff.id, shop.next_shift_no, float], conn);
      await posLog(conn, { shopId: req.pos.shopId, staffId: req.pos.staff.id, shiftId: r.insertId, action: 'shift_open', data: { opening_float: float } });
      return one('SELECT * FROM shifts WHERE id = ?', [r.insertId], conn);
    });
    return { shift: { id: shift.id, number: shift.number, opened_at: shift.opened_at, opening_float: Number(shift.opening_float) } };
  });

  app.get('/shifts/x', pos, async (req) => {
    const shift = await openShift(null, req.pos.staff.id);
    if (!shift) throw bad('no_shift', 'Смена не открыта');
    return { report: await shiftReport(null, shift), shop: shopView(await shopOf(req)), cashier: req.pos.bank.user.full_name };
  });

  app.post('/shifts/z', pos, async (req) => {
    const closing = req.body?.closing_cash !== undefined && req.body?.closing_cash !== null && req.body?.closing_cash !== '' ? int(req.body.closing_cash, 'наличные в ящике', { min: 0, max: 1e12 }) : null;
    const out = await tx(async (conn) => {
      const shift = await one("SELECT * FROM shifts WHERE staff_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1 FOR UPDATE", [req.pos.staff.id], conn);
      if (!shift) throw bad('no_shift', 'Смена не открыта');
      const open = await one("SELECT COUNT(*) AS n FROM sales WHERE shift_id = ? AND status = 'open' AND paid > 0", [shift.id], conn);
      if (open.n) throw bad('open_sales', 'Есть недоплаченные чеки — завершите или отмените их');
      await q("UPDATE sales SET status = 'cancelled' WHERE shift_id = ? AND status = 'open'", [shift.id], conn);
      const report = await shiftReport(conn, shift);
      const shop = await one('SELECT * FROM shops WHERE id = ?', [shift.shop_id], conn);
      report.vat_settlement = await settleCashVat(conn, { shop, shift, amount: report.cash_vat });
      report.closing_cash = closing;
      report.difference = closing === null ? null : closing - report.expected_cash;
      report.shift.closed_at = new Date();
      report.shift.status = 'closed';
      await q("UPDATE shifts SET status = 'closed', closed_at = NOW(3), closing_cash = ?, z_report = ? WHERE id = ?", [closing, JSON.stringify(report), shift.id], conn);
      await posLog(conn, { shopId: shift.shop_id, staffId: req.pos.staff.id, shiftId: shift.id, action: 'shift_close', data: { closing_cash: closing } });
      return report;
    });
    return { report: out, shop: shopView(await shopOf(req)), cashier: req.pos.bank.user.full_name };
  });

  app.get('/shifts', owner, async (req) => {
    const rows = await q('SELECT sh.id, sh.number, sh.status, sh.opened_at, sh.closed_at, sh.opening_float, sh.closing_cash, sh.z_report, u.full_name FROM shifts sh JOIN shop_staff st ON st.id = sh.staff_id JOIN bank_users u ON u.id = st.bank_user_id WHERE sh.shop_id = ? ORDER BY sh.id DESC LIMIT 50', [req.pos.shopId]);
    return { shifts: rows.map((r) => ({ ...r, opening_float: Number(r.opening_float), z_report: typeof r.z_report === 'string' ? JSON.parse(r.z_report) : r.z_report })) };
  });

  // ——— Продажа ———
  app.post('/sales', pos, async (req) => {
    const b = req.body || {};
    const sale = await tx(async (conn) => createSale(conn, {
      shopId: req.pos.shopId,
      staff: req.pos.staff,
      lines: b.items,
      discount: b.discount ? int(b.discount, 'скидка', { min: 0, max: 1e12 }) : 0,
      tipPct: Number(b.tip_pct || 0),
    }));
    return { sale: saleView(sale) };
  });

  app.get('/sales/:id', pos, async (req) => {
    const sale = await loadSale(null, int(req.params.id, 'id'));
    if (sale.shop_id !== req.pos.shopId) throw notFound('Чек не найден');
    return { sale: saleView(sale) };
  });

  app.get('/sales/by-number/:no', pos, async (req) => {
    const r = await one('SELECT id FROM sales WHERE shop_id = ? AND number = ?', [req.pos.shopId, int(req.params.no, 'номер')]);
    if (!r) throw notFound('Чек не найден');
    const sale = await loadSale(null, r.id);
    const refunds = await q('SELECT id, amount, method, items, reason, created_at FROM refunds WHERE sale_id = ? ORDER BY id', [r.id]);
    return { sale: saleView(sale), refunds };
  });

  app.post('/sales/:id/tip', pos, async (req) => {
    const pct = Number(req.body?.tip_pct || 0);
    if (![0, 5, 10, 15].includes(pct)) throw bad('invalid_tip', 'Чаевые: 0, 5, 10 или 15%');
    const sale = await tx(async (conn) => {
      const s = await loadSale(conn, int(req.params.id, 'id'), { lock: true });
      if (s.shop_id !== req.pos.shopId) throw notFound();
      if (s.status !== 'open' || Number(s.paid) > 0) throw bad('sale_locked', 'Чаевые выбираются до оплаты');
      await q('UPDATE sales SET tip_pct = ?, tip = ? WHERE id = ?', [pct, Math.round((Number(s.total) * pct) / 100), s.id], conn);
      return loadSale(conn, s.id);
    });
    return { sale: saleView(sale) };
  });

  // Проверка возраста по QR паспорта БФ (или номеру паспорта).
  app.post('/sales/:id/age', pos, async (req) => {
    const code = String(req.body?.code || '').trim();
    const passportNo = String(req.body?.passport_no || '').trim().toUpperCase();
    const p = code
      ? await one('SELECT p.*, c.birth_date, c.full_name FROM passports p JOIN citizens c ON c.id = p.citizen_id WHERE p.verify_code = ?', [code.split('/').pop()])
      : await one('SELECT p.*, c.birth_date, c.full_name FROM passports p JOIN citizens c ON c.id = p.citizen_id WHERE p.number = ?', [passportNo]);
    if (!p || p.status !== 'active') throw bad('passport_invalid', 'Паспорт недействителен');
    const sale = await tx(async (conn) => {
      const s = await loadSale(conn, int(req.params.id, 'id'), { lock: true });
      if (s.shop_id !== req.pos.shopId) throw notFound();
      const limit = Math.max(0, ...s.items.map((i) => i.age_limit));
      const age = ageFrom(p.birth_date);
      if (age === null || age < limit) {
        await posLog(conn, { shopId: s.shop_id, staffId: req.pos.staff.id, shiftId: s.shift_id, action: 'age_denied', saleId: s.id, data: { passport: p.number, age } });
        throw bad('age_denied', `Покупателю ${age} — продажа ${limit}+ запрещена`);
      }
      await q('UPDATE sales SET age_checked = ? WHERE id = ?', [p.number, s.id], conn);
      await posLog(conn, { shopId: s.shop_id, staffId: req.pos.staff.id, shiftId: s.shift_id, action: 'age_ok', saleId: s.id, data: { passport: p.number, age } });
      return loadSale(conn, s.id);
    });
    return { sale: saleView(sale), customer: { full_name: p.full_name, age: ageFrom(p.birth_date) } };
  });

  async function payFlow(req, saleId, fn) {
    return tx(async (conn) => {
      const sale = await loadSale(conn, saleId, { lock: true });
      if (sale.shop_id !== req.pos.shopId) throw notFound('Чек не найден');
      const shop = await one('SELECT * FROM shops WHERE id = ?', [sale.shop_id], conn);
      const res = await fn(conn, sale, shop);
      return { ...res, sale: saleView(await loadSale(conn, sale.id)) };
    });
  }

  app.post('/sales/:id/pay', { ...pos, ...limited(60) }, async (req) => {
    const b = req.body || {};
    const saleId = int(req.params.id, 'id');
    const method = b.method;
    const amount = amountOf(b.amount);
    const idem = idemKey(req, `pos${req.pos.staff.id}:pay`);
    if (method === 'cash') {
      const res = await payFlow(req, saleId, (conn, sale, shop) => payByCash(conn, { sale, shop, amount, cashGiven: b.cash_given !== undefined ? int(b.cash_given, 'получено') : null, idem }));
      return res;
    }
    if (method === 'card') {
      // Отказ показывает сама касса (экран «Отказано»); терминал сообщает об отказе через WebSocket.
      const card = await authorizeCard({ number: b.number, exp: b.exp, pin: b.pin });
      return payFlow(req, saleId, (conn, sale, shop) => payByCard(conn, { sale, shop, card, amount, actor: staffActor(req), idem }));
    }
    throw bad('invalid_method', 'Способ оплаты: наличные, карта или QR');
  });

  app.post('/sales/:id/qr', pos, async (req) => {
    const saleId = int(req.params.id, 'id');
    const terminal = req.body?.terminal_code ? String(req.body.terminal_code) : null;
    const out = await tx(async (conn) => {
      const sale = await loadSale(conn, saleId, { lock: true });
      if (sale.shop_id !== req.pos.shopId) throw notFound();
      if (sale.status !== 'open') throw bad('sale_closed', 'Чек закрыт');
      const ageLimit = Math.max(0, ...sale.items.map((i) => i.age_limit));
      if (ageLimit > 0 && !sale.age_checked) throw bad('age_check', `Проверьте паспорт покупателя (${ageLimit}+)`);
      const due = Number(sale.total) + Number(sale.tip) - Number(sale.paid);
      const amount = req.body?.amount ? Math.min(amountOf(req.body.amount), due) : due;
      const shop = await one('SELECT * FROM shops WHERE id = ?', [sale.shop_id], conn);
      return createQr(conn, { sale, shop, amount });
    });
    if (terminal) {
      terminalBySale.set(saleId, terminal);
      publish(`terminal:${terminal}`, { type: 'qr', sale_id: saleId, ...out });
    }
    return out;
  });

  app.post('/sales/:id/cancel', pos, async (req) => {
    await tx(async (conn) => {
      const sale = await loadSale(conn, int(req.params.id, 'id'), { lock: true });
      if (sale.shop_id !== req.pos.shopId) throw notFound();
      if (!['open', 'held'].includes(sale.status)) throw bad('sale_closed', 'Чек уже закрыт');
      if (Number(sale.paid) > 0) throw bad('has_payments', 'По чеку уже есть оплата — оформите возврат после закрытия');
      await q("UPDATE sales SET status = 'cancelled' WHERE id = ?", [sale.id], conn);
      await posLog(conn, { shopId: sale.shop_id, staffId: req.pos.staff.id, shiftId: sale.shift_id, action: 'sale_cancel', saleId: sale.id, data: { total: Number(sale.total) } });
    });
    return { ok: true };
  });

  // Отложенные чеки.
  app.get('/held', pos, async (req) => {
    const rows = await q("SELECT s.id, s.hold_label, s.total, s.created_at, u.full_name FROM sales s JOIN shop_staff st ON st.id = s.staff_id JOIN bank_users u ON u.id = st.bank_user_id WHERE s.shop_id = ? AND s.status = 'held' ORDER BY s.id DESC", [req.pos.shopId]);
    return { held: rows.map((r) => ({ ...r, total: Number(r.total) })) };
  });

  app.post('/held', pos, async (req) => {
    const label = str(req.body?.label, 'метка', { optional: true, max: 60 }) || `Чек ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
    const sale = await tx(async (conn) => createSale(conn, { shopId: req.pos.shopId, staff: req.pos.staff, lines: req.body?.items, heldLabel: label }));
    return { sale: saleView(sale) };
  });

  app.post('/held/:id/resume', pos, async (req) => {
    const out = await tx(async (conn) => {
      const sale = await loadSale(conn, int(req.params.id, 'id'), { lock: true });
      if (sale.shop_id !== req.pos.shopId || sale.status !== 'held') throw notFound('Отложенный чек не найден');
      await q("UPDATE sales SET status = 'cancelled' WHERE id = ?", [sale.id], conn);
      return sale.items.map((i) => ({ product_id: i.product_id, qty_milli: Number(i.qty_milli) }));
    });
    return { items: out };
  });

  // ——— Возвраты ———
  app.post('/refunds', pos, async (req) => {
    const b = req.body || {};
    const idem = idemKey(req, `pos${req.pos.staff.id}:refund`);
    const out = await tx(async (conn) => {
      const sale = await loadSale(conn, int(b.sale_id, 'чек'), { lock: true });
      if (sale.shop_id !== req.pos.shopId) throw notFound('Чек не найден');
      const shop = await one('SELECT * FROM shops WHERE id = ?', [sale.shop_id], conn);
      const r = await refundSale(conn, { sale, shop, staff: req.pos.staff, lines: b.items, all: !!b.all, reason: str(b.reason, 'причина', { optional: true, max: 160 }), idem });
      afterCommit(conn, () => publish(`shop:${shop.id}`, { type: 'refund', sale_id: sale.id }));
      return { refund: r, sale: saleView(await loadSale(conn, sale.id)) };
    });
    return out;
  });

  // ——— Чек ———
  app.get('/sales/:id/receipt', pos, async (req) => {
    const r = await receiptData(int(req.params.id, 'id'));
    if (r.shop.id !== req.pos.shopId) throw notFound();
    return r;
  });

  app.post('/sales/:id/email', { ...pos, ...limited(10) }, async (req) => {
    const r = await receiptData(int(req.params.id, 'id'));
    if (r.shop.id !== req.pos.shopId) throw notFound();
    const to = String(req.body?.email || '').trim().toLowerCase();
    need(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to), 'Неверный email');
    await q('UPDATE sales SET receipt_email = ? WHERE id = ?', [to, r.sale.id]);
    await sendMail({ to, brand: r.shop.name, subject: `Чек №${r.sale.number} — ${r.shop.name}`, text: receiptText(r) });
    return { ok: true };
  });

  // ——— Журнал кассира и денежный ящик ———
  app.post('/log', pos, async (req) => {
    const action = String(req.body?.action || '');
    if (!['remove_item', 'drawer_open', 'qty_change', 'clear_cart'].includes(action)) throw bad('invalid', 'Неизвестное действие');
    const shift = await openShift(null, req.pos.staff.id);
    await posLog(null, { shopId: req.pos.shopId, staffId: req.pos.staff.id, shiftId: shift?.id, action, data: req.body?.data || null });
    return { ok: true };
  });

  app.get('/log', owner, async (req) => {
    const rows = await q('SELECT l.*, u.full_name FROM pos_log l LEFT JOIN shop_staff st ON st.id = l.staff_id LEFT JOIN bank_users u ON u.id = st.bank_user_id WHERE l.shop_id = ? ORDER BY l.id DESC LIMIT 200', [req.pos.shopId]);
    return { log: rows.map((r) => ({ ...r, data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data })) };
  });

  // ——— Квитанции ВлодУслуг наличными ———
  app.get('/invoices/:no', pos, async (req) => {
    const inv = await one('SELECT * FROM invoices WHERE number = ?', [String(req.params.no).toUpperCase()]);
    if (!inv) throw notFound('Квитанция не найдена');
    return { invoice: publicInvoice(inv) };
  });

  app.post('/invoices/:no/pay-cash', pos, async (req) => {
    const idem = idemKey(req, `pos${req.pos.staff.id}:invoice`);
    const res = await tx(async (conn) => {
      const shift = await openShift(conn, req.pos.staff.id);
      if (!shift) throw bad('no_shift', 'Откройте смену');
      const shop = await one('SELECT * FROM shops WHERE id = ?', [req.pos.shopId], conn);
      const r = await payInvoice(conn, String(req.params.no).toUpperCase(), { fromAccount: shop.account_id, via: 'cash', actor: staffActor(req), idem });
      await posLog(conn, { shopId: shop.id, staffId: req.pos.staff.id, shiftId: shift.id, action: 'invoice_cash', data: { number: r.invoice.number, amount: Number(r.invoice.amount) } });
      return { invoice: publicInvoice(r.invoice) };
    });
    return { ok: true, ...res };
  });

  // ——— Терминал покупателя ———
  app.post('/terminals', pos, async (req) => {
    await q("UPDATE terminals SET status = 'closed' WHERE staff_id = ? AND status <> 'closed'", [req.pos.staff.id]);
    const code = await withUnique(async () => {
      const c = newTerminalCode();
      await q('INSERT INTO terminals (shop_id, staff_id, code) VALUES (?, ?, ?)', [req.pos.shopId, req.pos.staff.id, c]);
      return c;
    });
    return { code };
  });

  app.post('/terminals/:code/close', pos, async (req) => {
    await q("UPDATE terminals SET status = 'closed' WHERE code = ? AND shop_id = ?", [req.params.code, req.pos.shopId]);
    publish(`terminal:${req.params.code}`, { type: 'closed' });
    return { ok: true };
  });

  async function ownTerminal(req) {
    const t = await one("SELECT * FROM terminals WHERE code = ? AND shop_id = ? AND status <> 'closed'", [String(req.params.code), req.pos.shopId]);
    if (!t) throw notFound('Терминал не подключён');
    return t;
  }

  // Показ корзины на терминале (без записи в базу).
  app.post('/terminals/:code/display', pos, async (req) => {
    await ownTerminal(req);
    const shop = await shopOf(req);
    const lines = Array.isArray(req.body?.lines) ? req.body.lines.slice(0, 100) : [];
    publish(`terminal:${req.params.code}`, { type: 'cart', shop: { name: shop.name, color: shop.color, logo: shop.logo }, lines, total: Number(req.body?.total || 0), message: req.body?.message || null });
    return { ok: true };
  });

  // Запрос оплаты картой на терминале.
  app.post('/terminals/:code/request', pos, async (req) => {
    const t = await ownTerminal(req);
    const sale = await loadSale(null, int(req.body?.sale_id, 'чек'));
    if (sale.shop_id !== req.pos.shopId || sale.status !== 'open') throw bad('sale_closed', 'Чек закрыт');
    const due = Number(sale.total) + Number(sale.tip) - Number(sale.paid);
    const amount = req.body?.amount ? Math.min(amountOf(req.body.amount), due) : due;
    const shop = await shopOf(req);
    const pending = { sale_id: sale.id, amount, request_id: Date.now().toString(36) };
    await q('UPDATE terminals SET pending = ? WHERE id = ?', [JSON.stringify(pending), t.id]);
    terminalBySale.set(sale.id, t.code);
    publish(`terminal:${t.code}`, { type: 'pay_request', ...pending, shop: { name: shop.name, color: shop.color, logo: shop.logo }, items: saleView(sale).items.map((i) => ({ name: i.name, qty_milli: i.qty_milli, unit: i.unit, total: i.total })), total: Number(sale.total), tip: Number(sale.tip) });
    return { ok: true, ...pending };
  });

  app.post('/terminals/:code/cancel', pos, async (req) => {
    const t = await ownTerminal(req);
    await q('UPDATE terminals SET pending = NULL WHERE id = ?', [t.id]);
    publish(`terminal:${t.code}`, { type: 'cancelled' });
    return { ok: true };
  });

  // Терминал (без входа): покупатель вводит карту и PIN.
  app.get('/terminal/:code', limited(60), async (req) => {
    const t = await one("SELECT t.*, s.name, s.color, s.logo FROM terminals t JOIN shops s ON s.id = t.shop_id WHERE t.code = ? AND t.status <> 'closed'", [String(req.params.code)]);
    if (!t) throw notFound('Код не найден — проверьте код на экране кассы');
    return { shop: { name: t.name, color: t.color, logo: t.logo }, pending: typeof t.pending === 'string' ? JSON.parse(t.pending) : t.pending };
  });

  app.post('/terminal/:code/pay', limited(20), async (req) => {
    const code = String(req.params.code);
    const t = await one("SELECT * FROM terminals WHERE code = ? AND status <> 'closed'", [code]);
    if (!t) throw notFound('Терминал отключён');
    const pending = typeof t.pending === 'string' ? JSON.parse(t.pending) : t.pending;
    if (!pending || pending.request_id !== req.body?.request_id) throw bad('no_request', 'Нет запроса на оплату');
    let result;
    try {
      const card = await authorizeCard({ number: req.body?.number, exp: req.body?.exp, pin: req.body?.pin });
      result = await tx(async (conn) => {
        const sale = await loadSale(conn, pending.sale_id, { lock: true });
        const shop = await one('SELECT * FROM shops WHERE id = ?', [sale.shop_id], conn);
        const staff = await one('SELECT bank_user_id FROM shop_staff WHERE id = ?', [t.staff_id], conn);
        const r = await payByCard(conn, { sale, shop, card, amount: pending.amount, actor: { kind: 'bank', id: staff.bank_user_id }, idem: `terminal:${t.id}:${pending.request_id}` });
        await q('UPDATE terminals SET pending = NULL, last_seen_at = NOW(3) WHERE id = ?', [t.id], conn);
        return { ...r, sale: saleView(await loadSale(conn, sale.id)) };
      });
    } catch (err) {
      const retry = err.code === 'pin_wrong';
      publish(`terminal:${code}`, { type: 'pay_result', ok: false, code: err.code, message: err.message, retry });
      if (!retry) publish(`shop:${t.shop_id}`, { type: 'pay_declined', sale_id: pending.sale_id, reason: err.message });
      throw err;
    }
    publish(`terminal:${code}`, { type: 'pay_result', ok: true, sale_id: pending.sale_id, amount: pending.amount, finished: result.finished, method: 'card' });
    return { ok: true, finished: result.finished };
  });

  // ——— Отчёт владельцу (кратко; полные отчёты — этап 7) ———
  app.get('/reports', owner, async (req) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    const totals = await one(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS revenue, COALESCE(SUM(vat),0) AS vat, COALESCE(SUM(refunded),0) AS refunded FROM sales WHERE shop_id = ? AND status = 'paid' AND paid_at >= NOW() - INTERVAL ? DAY`, [req.pos.shopId, days]);
    const cost = await one(`SELECT COALESCE(SUM(ROUND(p.cost * (i.qty_milli - i.refunded_milli) / 1000)),0) AS cost FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN products p ON p.id = i.product_id WHERE s.shop_id = ? AND s.status = 'paid' AND s.paid_at >= NOW() - INTERVAL ? DAY`, [req.pos.shopId, days]);
    const top = await q(`SELECT i.name, SUM(i.qty_milli - i.refunded_milli) AS qty_milli, SUM(i.total) AS total FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE s.shop_id = ? AND s.status = 'paid' AND s.paid_at >= NOW() - INTERVAL ? DAY GROUP BY i.name ORDER BY total DESC LIMIT 10`, [req.pos.shopId, days]);
    const byCashier = await q(`SELECT u.full_name, COUNT(*) AS n, SUM(s.total) AS total, SUM(s.tip) AS tips FROM sales s JOIN shop_staff st ON st.id = s.staff_id JOIN bank_users u ON u.id = st.bank_user_id WHERE s.shop_id = ? AND s.status = 'paid' AND s.paid_at >= NOW() - INTERVAL ? DAY GROUP BY u.full_name ORDER BY total DESC`, [req.pos.shopId, days]);
    const byHour = await q(`SELECT HOUR(paid_at) AS h, COUNT(*) AS n, SUM(total) AS total FROM sales WHERE shop_id = ? AND status = 'paid' AND paid_at >= NOW() - INTERVAL ? DAY GROUP BY HOUR(paid_at) ORDER BY h`, [req.pos.shopId, days]);
    const balance = await one('SELECT a.balance FROM shops s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?', [req.pos.shopId]);
    const revenue = Number(totals.revenue) - Number(totals.refunded);
    return {
      days,
      sales: Number(totals.n),
      revenue,
      vat: Number(totals.vat),
      cost: Number(cost.cost),
      profit: revenue - Number(totals.vat) - Number(cost.cost),
      business_balance: Number(balance?.balance || 0),
      top: top.map((r) => ({ name: r.name, qty_milli: Number(r.qty_milli), total: Number(r.total) })),
      by_cashier: byCashier.map((r) => ({ name: r.full_name, sales: Number(r.n), total: Number(r.total), tips: Number(r.tips) })),
      by_hour: byHour.map((r) => ({ hour: r.h, sales: Number(r.n), total: Number(r.total) })),
    };
  });
}

