import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { setup, client, pool, q, one, sentMail, totalBalance } from './helpers.js';

let app;
before(async () => { app = await setup(); });
after(async () => { await app.close(); await pool.end(); });

const lastCode = (email) => {
  const m = [...sentMail].reverse().find((x) => x.to === email);
  return /(\d{6})/.exec(m?.subject || '')?.[1];
};

/** Гражданин с паспортом и, по желанию, ИНН + ИП. */
async function citizen(email, name, birth = '1990-05-01') {
  const gov = client(app);
  await gov.post('/api/auth/gov/register', { email, password: 'password123', display_name: name });
  const r = await gov.post('/api/gov/passport', { full_name: name, birth_date: birth, address: 'Влодоград, ул. Первая, 1' });
  assert.equal(r.application.status, 'approved');
  const me = await gov.get('/api/gov/me');
  assert.match(me.passport.number, /^BLN-\d{4}-\d{4}$/);
  return { gov, passport: me.passport };
}

async function bankClient(email, name, gov, passportNo) {
  const bank = client(app);
  await bank.post('/api/auth/bank/register', { email, password: 'password123', full_name: name, birth_date: '1990-05-01', passport_no: passportNo });
  const links = await gov.get('/api/gov/links');
  await gov.post(`/api/gov/links/${links.links[0].id}/confirm`);
  return bank;
}

test('ledger, gov, bank, pos — full chain', async () => {
  // ВлодУслуги: паспорт, ИНН, ИП (с госпошлиной 50 В по умолчанию)
  const owner = await citizen('owner@test.bf', 'Иван Петров');
  await owner.gov.post('/api/gov/documents/inn');
  const ipApp = await owner.gov.post('/api/gov/documents/ip', { trade_name: 'Лавка Ивана' });
  assert.equal(ipApp.application.status, 'awaiting_payment');
  let me = await owner.gov.get('/api/gov/me');
  const invoice = me.invoices.find((i) => i.status === 'unpaid');
  assert.equal(invoice.amount, 5000);

  // ВлодБанк: регистрация с паспортом, подтверждение во ВлодУслугах
  const bank = await bankClient('owner@test.bf', 'Иван Петров', owner.gov, owner.passport.number);
  let ov = await bank.get('/api/bank/overview');
  assert.equal(ov.user.passport_verified, true);

  const cur = (await bank.post('/api/bank/accounts', { type: 'current' })).account;
  assert.equal(cur.is_primary, true);
  ov = await bank.get('/api/bank/overview');
  assert.equal(ov.accounts[0].balance, 100000, 'стартовый баланс 1000 В');

  // Оплата госпошлины → ИП выдаётся
  await bank.idem(`/api/bank/invoices/${invoice.number}/pay`, { account_id: cur.id });
  me = await owner.gov.get('/api/gov/me');
  assert.ok(me.documents.find((d) => d.type === 'ip'), 'ИП выдан после оплаты');
  const budget = await one("SELECT balance FROM accounts WHERE system_code = 'BUDGET'");
  assert.equal(Number(budget.balance), 5000);

  // Бизнес-счёт и магазин
  const biz = (await bank.post('/api/bank/accounts', { type: 'business' })).account;
  const shop = (await bank.post('/api/pos/shops', { name: 'Лавка Ивана', account_id: biz.id, pin: '1234' })).shop;
  await bank.post('/api/pos/login', { shop_id: shop.id, pin: '1234' });
  const p1 = (await bank.post('/api/pos/products', { name: 'Хлеб', price: 250, stock_milli: 10000, category: 'Выпечка' })).product;
  const p2 = (await bank.post('/api/pos/products', { name: 'Сыр', price: 1200, unit: 'kg', stock_milli: 5000 })).product;
  const beer = (await bank.post('/api/pos/products', { name: 'Квас', price: 300, age_limit: 18, stock_milli: 5000 })).product;

  // Покупатель с картой
  const buyerC = await citizen('buyer@test.bf', 'Мария Сидорова', '2000-01-01');
  const buyer = await bankClient('buyer@test.bf', 'Мария Сидорова', buyerC.gov, buyerC.passport.number);
  const bacc = (await buyer.post('/api/bank/accounts', { type: 'current' })).account;
  const card = (await buyer.post('/api/bank/cards', { account_id: bacc.id, pin: '123' })).card;
  assert.equal(card.number.length, 12);

  const sum0 = await totalBalance();

  // Продажа без смены — нельзя
  await assert.rejects(bank.post('/api/pos/sales', { items: [{ product_id: p1.id, qty_milli: 1000 }] }), /no_shift/);
  await bank.post('/api/pos/shifts/open', { opening_float: 10000 });

  // Чек: 2 хлеба + 0,5 кг сыра = 500 + 600 = 1100; чаевые 10% = 110
  let sale = (await bank.post('/api/pos/sales', { items: [{ product_id: p1.id, qty_milli: 2000 }, { product_id: p2.id, qty_milli: 500 }], tip_pct: 10 })).sale;
  assert.equal(sale.total, 1100);
  assert.equal(sale.tip, 110);
  assert.equal(sale.vat, 183); // 20/120 от 1100 по позициям: 83 + 100

  // Неверный PIN ×3 → блокировка на минуту
  const pay = { method: 'card', amount: 600, number: card.number, exp: card.exp_month, pin: '000' };
  await assert.rejects(bank.post(`/api/pos/sales/${sale.id}/pay`, pay), /pin_wrong/);
  await assert.rejects(bank.post(`/api/pos/sales/${sale.id}/pay`, pay), /pin_wrong/);
  await assert.rejects(bank.post(`/api/pos/sales/${sale.id}/pay`, pay), /card_locked/);
  await assert.rejects(bank.post(`/api/pos/sales/${sale.id}/pay`, { ...pay, pin: '123' }), /card_locked/);
  await q('UPDATE cards SET locked_until = NULL WHERE id = ?', [card.id]);

  // Раздельная оплата: 600 картой (двойное нажатие с тем же ключом — одно списание), остаток наличными
  const key = { 'idempotency-key': 'double-tap-1' };
  const r1 = await bank.post(`/api/pos/sales/${sale.id}/pay`, { ...pay, pin: '123' }, key);
  const r2 = await bank.post(`/api/pos/sales/${sale.id}/pay`, { ...pay, pin: '123' }, key);
  assert.equal(r1.sale.paid, 600);
  assert.equal(r2.sale.paid, 600, 'повтор не списал второй раз');
  sale = (await bank.post(`/api/pos/sales/${sale.id}/pay`, { method: 'cash', amount: 610, cash_given: 1000 })).sale;
  assert.equal(sale.status, 'paid');
  assert.equal(sale.number, 1);
  assert.equal(sale.payments[1].change_given, 390);

  const buyerAcc = await one('SELECT balance FROM accounts WHERE id = ?', [bacc.id]);
  assert.equal(Number(buyerAcc.balance), 100000 - 600);
  // Деньги не берутся из воздуха: сумма всех счетов (с эмиссией) = 0
  assert.equal(await totalBalance(), 0);
  assert.equal(sum0, 0);

  // Остаток товара уменьшился
  const bread = await one('SELECT stock_milli FROM products WHERE id = ?', [p1.id]);
  assert.equal(Number(bread.stock_milli), 8000);

  // Возрастной товар: без проверки паспорта — нельзя
  const s2 = (await bank.post('/api/pos/sales', { items: [{ product_id: beer.id, qty_milli: 1000 }] })).sale;
  await assert.rejects(bank.post(`/api/pos/sales/${s2.id}/pay`, { method: 'cash', amount: 300 }), /age_check/);
  await bank.post(`/api/pos/sales/${s2.id}/age`, { code: buyerC.passport.verify_code });
  const s2paid = (await bank.post(`/api/pos/sales/${s2.id}/pay`, { method: 'cash', amount: 300 })).sale;
  assert.equal(s2paid.status, 'paid');

  // Чек и проверка во ВлодУслугах
  const receipt = await bank.get(`/api/pos/sales/${sale.id}/receipt`);
  assert.equal(receipt.shop.ip_number.startsWith('IP'), true);
  const verified = await client(app).get(`/api/gov/verify/receipt/${receipt.sale.verify_code}`);
  assert.equal(verified.valid, true);
  assert.equal(verified.total, 1100);

  // Возврат части: 1 хлеб (250) — безнал первым → на карту покупателя
  const refund = await bank.post('/api/pos/refunds', { sale_id: sale.id, items: [{ item_id: sale.items[0].id, qty_milli: 1000 }] });
  assert.equal(refund.refund.amount, 250);
  assert.equal(refund.refund.by_method.card, 250);
  assert.equal(Number((await one('SELECT balance FROM accounts WHERE id = ?', [bacc.id])).balance), 100000 - 600 + 250);
  assert.equal(await totalBalance(), 0);

  // Z-отчёт: НДС с наличных списывается с бизнес-счёта
  const z = await bank.post('/api/pos/shifts/z', { closing_cash: 10000 + 610 + 300 });
  assert.equal(z.report.sales_count, 2);
  assert.equal(z.report.by_method.cash, 910);
  assert.equal(z.report.expected_cash, 10000 + 910);
  assert.equal(z.report.difference, 0);
  assert.ok(z.report.vat_settlement.settled > 0);
});

test('transfers, ATM, teller, admin', async () => {
  const admin = client(app);
  await admin.post('/api/auth/gov/register', { email: 'admin@test.bf', password: 'password123', display_name: 'Админ' });
  const ov = await admin.get('/api/admin/overview');
  assert.ok(ov.counts.bank_users >= 2);

  const ivan = await one("SELECT id FROM bank_users WHERE email = 'owner@test.bf'");
  const maria = await one("SELECT id FROM bank_users WHERE email = 'buyer@test.bf'");
  const ivanAcc = await one("SELECT * FROM accounts WHERE owner_id = ? AND type = 'current'", [ivan.id]);
  const mariaAcc = await one("SELECT * FROM accounts WHERE owner_id = ? AND type = 'current'", [maria.id]);

  // Комиссия 1%, минимум 0,50 В
  await admin.patch('/api/admin/settings', { transfer_fee_bp: 100, transfer_fee_min: 50 });

  const maria2 = client(app);
  await maria2.post('/api/auth/bank/login', { email: 'buyer@test.bf', password: 'password123' });
  const before = Number(mariaAcc.balance);
  const prev = await maria2.post('/api/bank/transfers/preview', { amount: 10000, to: { type: 'user', value: ivan.id } });
  assert.equal(prev.fee, 100);
  await maria2.idem('/api/bank/transfers', { from_account: mariaAcc.id, amount: 10000, to: { type: 'account', value: ivanAcc.number }, memo: 'За хлеб' });
  assert.equal(Number((await one('SELECT balance FROM accounts WHERE id = ?', [mariaAcc.id])).balance), before - 10100);

  // Банкомат: снять 50 В
  const card = await one("SELECT * FROM cards WHERE bank_user_id = ? AND status = 'active'", [maria.id]);
  const atm = client(app);
  const ses = await atm.post('/api/bank/atm/session', { number: card.number, pin: '123' });
  await assert.rejects(atm.post('/api/bank/atm/withdraw', { token: ses.token, amount: 250 }), /atm_notes/);
  const w = await atm.post('/api/bank/atm/withdraw', { token: ses.token, amount: 5000 });
  assert.equal(w.balance, before - 10100 - 5000);
  const cash = await one("SELECT balance FROM accounts WHERE system_code = 'CASH'");
  assert.equal(Number(cash.balance), 5000);

  // Лимит на операцию
  await maria2.post(`/api/bank/cards/${card.id}/limits`, { limit_tx: 1000, limit_daily: null });
  await assert.rejects(atm.post('/api/bank/atm/withdraw', { token: ses.token, amount: 1500 }), /limit_tx/);

  // Роль операциониста: инкассация магазина
  const ivanBank = client(app);
  await ivanBank.post('/api/auth/bank/login', { email: 'owner@test.bf', password: 'password123' });
  await assert.rejects(ivanBank.get('/api/bank/teller/shops'), /forbidden/);
  await admin.post('/api/admin/roles', { kind: 'bank', user_id: ivan.id, role: 'teller', grant: true });
  const shops = await ivanBank.get('/api/bank/teller/shops');
  await ivanBank.post('/api/bank/teller/collection', { shop_id: shops.shops[0].id, amount: 900 });

  // Эмиссия и отмена
  const em = await admin.post('/api/admin/emission', { account_id: mariaAcc.id, amount: 77700, memo: 'Премия' });
  await admin.post(`/api/admin/tx/${em.tx}/reverse`);
  await assert.rejects(admin.post(`/api/admin/tx/${em.tx}/reverse`), /already_reversed/);

  // Арест счёта блокирует списания
  await admin.post(`/api/admin/accounts/${mariaAcc.id}/status`, { status: 'arrested' });
  await assert.rejects(maria2.idem('/api/bank/transfers', { from_account: mariaAcc.id, amount: 100, to: { type: 'user', value: ivan.id } }), /account_arrested/);
  await admin.post(`/api/admin/accounts/${mariaAcc.id}/status`, { status: 'active' });

  // Кеш баланса совпадает с суммой проводок на всех счетах
  const mismatch = await q('SELECT a.id FROM accounts a LEFT JOIN (SELECT account_id, SUM(amount) s FROM ledger_entries GROUP BY account_id) e ON e.account_id = a.id WHERE a.balance <> COALESCE(e.s, 0)');
  assert.equal(mismatch.length, 0);
  assert.equal(await totalBalance(), 0);

  // Экспорт → импорт → данные на месте
  const dump = await admin.get('/api/admin/export');
  assert.ok(dump.tables.ledger_tx.length > 5);
  const txCount = dump.tables.ledger_tx.length;
  await admin.post('/api/admin/import', dump);
  assert.equal(Number((await one('SELECT COUNT(*) AS n FROM ledger_tx')).n), txCount);
  assert.equal(await totalBalance(), 0);

  // Вход по коду на email
  const coder = client(app);
  await coder.post('/api/auth/bank/code/send', { email: 'buyer@test.bf' });
  await assert.rejects(coder.post('/api/auth/bank/code/verify', { email: 'buyer@test.bf', code: '000000' }), /code_wrong/);
  const me = await coder.post('/api/auth/bank/code/verify', { email: 'buyer@test.bf', code: lastCode('buyer@test.bf') });
  assert.equal(me.user.email, 'buyer@test.bf');

  // Сброс сохраняет админа
  await admin.post('/api/admin/reset', { confirm: 'СБРОС' });
  assert.equal(Number((await one('SELECT COUNT(*) AS n FROM bank_users')).n), 0);
  const adminMe = await admin.get('/api/admin/me');
  assert.equal(adminMe.kind, 'gov');
});

test('game clock pays interest and salaries', async () => {
  const { advance } = await import('../src/lib/clock.js');
  const c = await citizen('saver@test.bf', 'Олег Копилкин');
  const bank = await bankClient('saver@test.bf', 'Олег Копилкин', c.gov, c.passport.number);
  const cur = (await bank.post('/api/bank/accounts', { type: 'current' })).account;
  const sav = (await bank.post('/api/bank/accounts', { type: 'savings', compound: true })).account;
  await bank.idem('/api/bank/transfers', { from_account: cur.id, amount: 50000, to: { type: 'own', value: sav.id } });
  const m = await advance({ force: true });
  assert.equal(m, 1);
  const after1 = await one('SELECT balance FROM accounts WHERE id = ?', [sav.id]);
  assert.equal(Number(after1.balance), 50250, '0,5% в месяц капитализация');
  assert.equal(await totalBalance(), 0);
});

test('admin: addresses and SMTP live in settings, secrets are hidden', async () => {
  const admin = client(app);
  await admin.post('/api/auth/gov/login', { email: 'admin@test.bf', password: 'password123' });
  const r = await admin.patch('/api/admin/settings', { public_web_url: 'https://example.bf/game/', smtp_host: '', smtp_password: 'top-secret', mail_from: 'Игра <no-reply@example.bf>' });
  assert.equal(r.settings.smtp_password, '');
  assert.equal(r.settings.smtp_password_set, true);
  // Пустой пароль из формы не стирает сохранённый
  await admin.patch('/api/admin/settings', { smtp_password: '' });
  const row = await one("SELECT v FROM settings WHERE k = 'smtp_password'");
  assert.match(String(row.v), /top-secret/);
  const dump = await admin.get('/api/admin/export');
  assert.ok(!JSON.stringify(dump.tables.settings).includes('top-secret'), 'секрет не уходит в экспорт');
  const audit = await admin.get('/api/admin/audit');
  assert.ok(!JSON.stringify(audit).includes('top-secret'), 'секрет не пишется в журнал');
  const { webUrl } = await import('../src/lib/settings.js');
  assert.equal(await webUrl(), 'https://example.bf/game');
  await assert.rejects(admin.patch('/api/admin/settings', { public_web_url: 'not a url' }), /invalid/);
  const srv = await admin.get('/api/admin/server');
  assert.equal(srv.web_url, 'https://example.bf/game');
});
