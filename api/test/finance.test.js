// Этап 6: кредитные / детские / подарочные карты, кредиты, автоплатежи, кешбэк, антифрод, инфляция.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { setup, client, pool, q, one, totalBalance } from './helpers.js';

let app;
let advance;
before(async () => {
  app = await setup();
  ({ advance } = await import('../src/lib/clock.js'));
});
after(async () => { await app.close(); await pool.end(); });

async function player(email, name) {
  const gov = client(app);
  await gov.post('/api/auth/gov/register', { email, password: 'password123', display_name: name });
  await gov.post('/api/gov/passport', { full_name: name, birth_date: '1990-05-01', address: 'Влодоград, ул. Вторая, 2' });
  const me = await gov.get('/api/gov/me');
  const bank = client(app);
  await bank.post('/api/auth/bank/register', { email, password: 'password123', full_name: name, birth_date: '1990-05-01', passport_no: me.passport.number });
  const links = await gov.get('/api/gov/links');
  await gov.post(`/api/gov/links/${links.links[0].id}/confirm`);
  const cur = (await bank.post('/api/bank/accounts', { type: 'current' })).account;
  return { gov, bank, cur, id: (await one('SELECT id FROM bank_users WHERE email = ?', [email])).id };
}

const bal = async (id) => Number((await one('SELECT balance FROM accounts WHERE id = ?', [id])).balance);
const score = async (id) => (await one('SELECT credit_score FROM bank_users WHERE id = ?', [id])).credit_score;

async function noMoneyFromAir() {
  assert.equal(await totalBalance(), 0, 'сумма всех счетов = 0');
  const mismatch = await q('SELECT a.id FROM accounts a LEFT JOIN (SELECT account_id, SUM(amount) s FROM ledger_entries GROUP BY account_id) e ON e.account_id = a.id WHERE a.balance <> COALESCE(e.s, 0)');
  assert.equal(mismatch.length, 0, 'кеш баланса = сумма проводок');
}

let admin;
let shopOwner;
let shop;

test('setup: admin and a shop', async () => {
  admin = client(app);
  await admin.post('/api/auth/gov/register', { email: 'admin@test.bf', password: 'password123', display_name: 'Админ' });
  // Антифрод пока выключен — включим в своём тесте.
  await admin.patch('/api/admin/settings', { fraud_threshold: 0, fraud_velocity: 0, fraud_multiplier: 0 });
  shopOwner = await player('shop@test.bf', 'Пётр Лавочкин');
  await shopOwner.gov.post('/api/gov/documents/inn');
  await shopOwner.gov.post('/api/gov/documents/ip', { trade_name: 'Кафе Петра' });
  const inv = (await shopOwner.gov.get('/api/gov/me')).invoices.find((i) => i.status === 'unpaid');
  await shopOwner.bank.idem(`/api/bank/invoices/${inv.number}/pay`, { account_id: shopOwner.cur.id });
  const biz = (await shopOwner.bank.post('/api/bank/accounts', { type: 'business' })).account;
  shop = (await shopOwner.bank.post('/api/pos/shops', { name: 'Кафе Петра', type: 'cafe', account_id: biz.id, pin: '1234' })).shop;
  const cats = (await client(app).get('/api/pos/cashback-categories')).categories;
  assert.equal(shop.cashback_category_id, cats.find((c) => c.name === 'Кафе и рестораны').id, 'кафе → категория по умолчанию');
  await shopOwner.bank.post('/api/pos/login', { shop_id: shop.id, pin: '1234' });
  await shopOwner.bank.post('/api/pos/shifts/open', { opening_float: 0 });
});

/** Продажа на кассе Петра, оплата картой. */
async function sell(price, card, pin = '123', qty = 1) {
  const prod = (await shopOwner.bank.post('/api/pos/products', { name: `Обед ${price}`, price, stock_milli: 1000000 })).product;
  const sale = (await shopOwner.bank.post('/api/pos/sales', { items: [{ product_id: prod.id, qty_milli: 1000 * qty }] })).sale;
  return (await shopOwner.bank.post(`/api/pos/sales/${sale.id}/pay`, { method: 'card', amount: price * qty, number: card.number, pin })).sale;
}

test('credit card: application, admin limit, spending, statement, late fee, interest', async () => {
  const p = await player('credit@test.bf', 'Анна Кредитова');
  await p.bank.post('/api/bank/credit-lines', { limit: 50000, pin: '321' });
  await assert.rejects(p.bank.post('/api/bank/credit-lines', { limit: 10000, pin: '321' }), /has_credit_line/);
  const ov = await admin.get('/api/admin/overview');
  assert.equal(ov.counts.pending_credit, 1);

  const list = await admin.get('/api/admin/credit?status=pending');
  await admin.post(`/api/admin/credit-lines/${list.credit_lines[0].id}/decision`, { approve: true, limit: 30000 });
  const credit = await p.bank.get('/api/bank/credit');
  assert.equal(credit.credit_line.status, 'active');
  assert.equal(credit.credit_line.limit, 30000);
  const card = (await p.bank.get('/api/bank/cards')).cards.find((c) => c.type === 'credit');
  assert.equal(card.available, 30000);

  // Тратим больше, чем есть на расчётном, но в пределах лимита. Сверх лимита — отказ.
  await sell(20000, card, '321');
  await assert.rejects(sell(15000, card, '321'), /insufficient_funds/);
  assert.equal(await bal(card.account_id), -20000);
  await noMoneyFromAir();

  // Месяц 1: выписка — долг 200 В, минимальный платёж 10% = 20 В.
  await p.bank.post(`/api/bank/credit-lines/${credit.credit_line.id}/autorepay`, { on: false });
  await advance({ force: true });
  let cl = (await p.bank.get('/api/bank/credit')).credit_line;
  assert.equal(cl.statement_debt, 20000);
  assert.equal(cl.min_payment, 2000);

  // Месяц 2: не заплатили → штраф 5 В, рейтинг падает. Льготный период (2 мес.) ещё идёт — процентов нет.
  const s0 = await score(p.id);
  await advance({ force: true });
  assert.equal(await bal(card.account_id), -20500);
  assert.ok((await score(p.id)) < s0);
  cl = (await p.bank.get('/api/bank/credit')).credit_line;
  assert.equal(cl.overdue_count, 1);

  // Платим минимальный платёж переводом на кредитный счёт; месяц 3 — уже проценты 3%.
  await p.bank.idem('/api/bank/transfers', { from_account: p.cur.id, amount: 5000, to: { type: 'own', value: card.account_id } });
  await advance({ force: true });
  cl = (await p.bank.get('/api/bank/credit')).credit_line;
  assert.equal(cl.overdue_count, 1, 'минимальный платёж внесён');
  assert.equal(await bal(card.account_id), -(15500 + Math.round(15500 * 0.03)));

  // Закрыть с долгом нельзя.
  await assert.rejects(p.bank.post(`/api/bank/accounts/${card.account_id}/close`), /has_debt/);
  await noMoneyFromAir();
});

test('loans: annuity schedule, auto-debit, overdue penalty, early repayment', async () => {
  const p = await player('loan@test.bf', 'Борис Заёмов');
  const pv = await p.bank.post('/api/bank/loans/preview', { amount: 120000, months: 6 });
  assert.equal(pv.rows.length, 6);
  const loan = (await p.bank.post('/api/bank/loans', { amount: 120000, months: 6, purpose: 'Лавка' })).loan;
  assert.equal(loan.status, 'pending');
  await admin.post(`/api/admin/loans/${loan.id}/decision`, { approve: true });
  let mine = (await p.bank.get('/api/bank/credit')).loans[0];
  assert.equal(mine.status, 'active');
  assert.equal(mine.principal_left, 120000);
  assert.equal(await bal(p.cur.id), 100000 + 120000);
  await noMoneyFromAir();

  // Платёж 1 — автосписание.
  await advance({ force: true });
  mine = (await p.bank.get('/api/bank/credit')).loans[0];
  assert.equal(mine.schedule[0].status, 'paid');
  assert.equal(await bal(p.cur.id), 220000 - mine.payment);

  // Платёж 2 — денег нет → просрочка с пени 10%.
  const left = await bal(p.cur.id);
  await p.bank.idem('/api/bank/transfers', { from_account: p.cur.id, amount: left, to: { type: 'user', value: shopOwner.id } });
  const before2 = await score(p.id);
  await advance({ force: true });
  mine = (await p.bank.get('/api/bank/credit')).loans[0];
  assert.equal(mine.schedule[1].status, 'overdue');
  assert.equal(mine.schedule[1].penalty, Math.round((mine.schedule[1].principal + mine.schedule[1].interest) * 0.1));
  assert.ok((await score(p.id)) < before2);

  // Деньги вернулись — досрочное погашение всего остатка с пени.
  await admin.post('/api/admin/emission', { account_id: p.cur.id, amount: 300000, memo: 'Помощь' });
  await p.bank.post(`/api/bank/loans/${loan.id}/repay`, { account_id: p.cur.id });
  mine = (await p.bank.get('/api/bank/credit')).loans[0];
  assert.equal(mine.status, 'repaid');
  assert.equal(mine.principal_left, 0);
  const acc = await one('SELECT status FROM accounts WHERE id = ?', [mine.loan_account_id]);
  assert.equal(acc.status, 'closed');
  await noMoneyFromAir();
});

test('loans: small loans auto-approved', async () => {
  await admin.patch('/api/admin/settings', { loan_auto_approve_max: 50000 });
  const p = await player('auto@test.bf', 'Вера Быстрова');
  const loan = (await p.bank.post('/api/bank/loans', { amount: 30000, months: 3 })).loan;
  assert.equal(loan.status, 'active');
  assert.equal(loan.schedule.length, 3);
  await noMoneyFromAir();
});

test('child card: parent account, limits, pocket money autostart, child sees the card', async () => {
  const parent = await player('parent@test.bf', 'Ольга Мамина');
  const kid = await player('kid@test.bf', 'Миша Мамин');
  const r = await parent.bank.post('/api/bank/child-cards', { child_name: 'Миша Мамин', child_email: 'kid@test.bf', pin: '111', pocket_amount: 2000, limit_tx: 1500 });
  assert.equal(r.pocket_started, true);
  assert.equal(r.card.type, 'child');
  assert.equal(r.card.balance, 2000);
  assert.equal(r.card.holder_name, 'MISHA MAMIN');

  const kidCards = (await kid.bank.get('/api/bank/cards')).cards;
  const kc = kidCards.find((c) => c.type === 'child');
  assert.ok(kc.managed_by_parent);
  // Ребёнок не управляет картой — только родитель.
  await assert.rejects(kid.bank.post(`/api/bank/cards/${kc.id}/freeze`), /not_found/);

  // Лимит на операцию 15 В.
  await assert.rejects(sell(1800, kc, '111'), /limit_tx/);
  await sell(1000, kc, '111');
  assert.equal(await bal(kc.account_id), 1000);

  // Следующий месяц — ещё карманные.
  await advance({ force: true });
  assert.equal(await bal(kc.account_id), 3000);
  await parent.bank.post(`/api/bank/cards/${kc.id}/pocket`, { amount: 0 });
  await advance({ force: true });
  assert.equal(await bal(kc.account_id), 3000, 'карманные отключены');
  await noMoneyFromAir();
});

test('gift card: buy, spend at POS, redeem to another account', async () => {
  const giver = await player('giver@test.bf', 'Глеб Дарьев');
  const friend = await player('friend@test.bf', 'Дина Подаркова');
  const gift = (await giver.bank.post('/api/bank/gift-cards', { from_account: giver.cur.id, amount: 10000, pin: '777', holder: 'Дина' })).card;
  assert.equal(gift.type, 'gift');
  assert.equal(gift.balance, 10000);
  await sell(2500, gift, '777');
  // На подарочную карту переводить нельзя.
  await assert.rejects(friend.bank.post('/api/bank/transfers/preview', { amount: 100, to: { type: 'card', value: gift.number } }), /recipient_gift/);
  await assert.rejects(friend.bank.post('/api/bank/gift-cards/redeem', { number: gift.number, pin: '000', account_id: friend.cur.id }), /pin_wrong/);
  const red = await friend.bank.post('/api/bank/gift-cards/redeem', { number: gift.number, pin: '777', account_id: friend.cur.id });
  assert.equal(red.amount, 7500);
  assert.equal(await bal(friend.cur.id), 107500);
  await assert.rejects(friend.bank.post('/api/bank/gift-cards/redeem', { number: gift.number, pin: '777', account_id: friend.cur.id }), /card_blocked/);
  await noMoneyFromAir();
});

test('autopayments: monthly transfer, limited count, pause after failures', async () => {
  const p = await player('ap@test.bf', 'Ирина Платёжкина');
  const shopAcc = await one('SELECT number FROM accounts WHERE id = ?', [shop.account_id]);
  const ap = (await p.bank.post('/api/bank/autopayments', { title: 'Подписка на обеды', kind: 'subscription', from_account: p.cur.id, amount: 1000, remaining: 2, to: { type: 'account', value: shopAcc.number }, start_now: true })).autopayment;
  assert.equal(await bal(p.cur.id), 99000);
  await advance({ force: true });
  assert.equal(await bal(p.cur.id), 98000);
  let list = (await p.bank.get('/api/bank/autopayments')).autopayments;
  assert.equal(list.find((a) => a.id === ap.id).status, 'finished');

  const big = (await p.bank.post('/api/bank/autopayments', { title: 'Слишком дорого', from_account: p.cur.id, amount: 5000000, to: { type: 'account', value: shopAcc.number } })).autopayment;
  for (let i = 0; i < 3; i++) await advance({ force: true });
  list = (await p.bank.get('/api/bank/autopayments')).autopayments;
  const b = list.find((a) => a.id === big.id);
  assert.equal(b.status, 'paused');
  assert.match(b.last_error, /Недостаточно/);
  await noMoneyFromAir();
});

test('cashback: choose categories once a month, accrue on card purchase, pay next month, cut on refund', async () => {
  const p = await player('cb@test.bf', 'Кира Кешбэкова');
  const card = (await p.bank.post('/api/bank/cards', { account_id: p.cur.id, pin: '555' })).card;
  const cb = await p.bank.get('/api/bank/cashback');
  const cafe = cb.categories.find((c) => c.name === 'Кафе и рестораны');
  await assert.rejects(p.bank.post('/api/bank/cashback', { category_ids: cb.categories.slice(0, 4).map((c) => c.id) }), /too_many/);
  await p.bank.post('/api/bank/cashback', { category_ids: [cafe.id] });
  await assert.rejects(p.bank.post('/api/bank/cashback', { category_ids: [cafe.id] }), /already_chosen/);

  const sale = await sell(5000, card, '555', 2);
  let now = await p.bank.get('/api/bank/cashback');
  assert.equal(now.accrued, 500, '5% за кафе');
  // Возврат половины чека уменьшает кешбэк.
  await shopOwner.bank.post('/api/pos/refunds', { sale_id: sale.id, items: [{ item_id: sale.items[0].id, qty_milli: 1000 }] });
  now = await p.bank.get('/api/bank/cashback');
  assert.equal(now.accrued, 250);

  const before1 = await bal(p.cur.id);
  await advance({ force: true });
  assert.equal(await bal(p.cur.id), before1 + 250);
  now = await p.bank.get('/api/bank/cashback');
  assert.deepEqual(now.chosen, [], 'выбор категорий сброшен на новый месяц');
  await noMoneyFromAir();
});

test('antifraud: large transfer held until admin decides, large card payment reviewed', async () => {
  await admin.patch('/api/admin/settings', { fraud_threshold: 30000, fraud_velocity: 0, fraud_multiplier: 5 });
  const p = await player('fraud@test.bf', 'Фёдор Рискин');
  const r = await p.bank.idem('/api/bank/transfers', { from_account: p.cur.id, amount: 40000, to: { type: 'user', value: shopOwner.id } });
  assert.equal(r.held, true);
  assert.equal(await bal(p.cur.id), 100000, 'деньги не списаны');
  // Между своими — без проверки.
  const sav = (await p.bank.post('/api/bank/accounts', { type: 'savings' })).account;
  const own = await p.bank.idem('/api/bank/transfers', { from_account: p.cur.id, amount: 40000, to: { type: 'own', value: sav.id } });
  assert.ok(own.tx);
  await p.bank.idem('/api/bank/transfers', { from_account: sav.id, amount: 40000, to: { type: 'own', value: p.cur.id } });

  let queue = (await admin.get('/api/admin/fraud')).items;
  const item = queue.find((x) => x.id === r.fraud_id);
  assert.equal(item.mode, 'hold');
  await admin.post(`/api/admin/fraud/${item.id}/decision`, { approve: true });
  assert.equal(await bal(p.cur.id), 60000, 'одобренный перевод выполнен');

  const r2 = await p.bank.idem('/api/bank/transfers', { from_account: p.cur.id, amount: 35000, to: { type: 'user', value: shopOwner.id } });
  await admin.post(`/api/admin/fraud/${r2.fraud_id}/decision`, { approve: false, note: 'Похоже на мошенничество' });
  assert.equal(await bal(p.cur.id), 60000);

  // Крупная оплата картой проходит, но уходит на проверку; отказ — сторно и заморозка карты.
  const card = (await p.bank.post('/api/bank/cards', { account_id: p.cur.id, pin: '999' })).card;
  await sell(30000, card, '999');
  assert.equal(await bal(p.cur.id), 30000);
  queue = (await admin.get('/api/admin/fraud')).items;
  const rev = queue.find((x) => x.mode === 'review' && x.user_id === p.id);
  await admin.post(`/api/admin/fraud/${rev.id}/decision`, { approve: false });
  assert.equal(await bal(p.cur.id), 60000, 'операция отменена');
  assert.equal((await one('SELECT status FROM cards WHERE id = ?', [card.id])).status, 'frozen');
  await admin.patch('/api/admin/settings', { fraud_threshold: 0 });
  await noMoneyFromAir();
});

test('inflation: price index grows by the admin rate each month', async () => {
  await admin.patch('/api/admin/settings', { inflation_bp: 200 });
  const before1 = (await admin.get('/api/admin/economy')).price_index;
  await advance({ force: true });
  const e = await admin.get('/api/admin/economy');
  assert.ok(Math.abs(e.price_index - before1 * 1.02) < 1e-5);
  const h = await admin.get('/api/admin/inflation');
  assert.equal(h.history.at(-1).rate_bp, 200);
});

test('reset keeps cashback categories and price index base', async () => {
  await admin.post('/api/admin/reset', { confirm: 'СБРОС' });
  assert.ok(Number((await one('SELECT COUNT(*) AS n FROM cashback_categories')).n) >= 6);
  assert.equal(Number((await one('SELECT index_ppm FROM price_index WHERE month = 0')).index_ppm), 1000000);
});
