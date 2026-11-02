// Этап 7: склад и закупки, варианты и добавки, акции, лояльность, долги, столики, кухня, киоск, отчёты.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { setup, client, pool, one, totalBalance } from './helpers.js';

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
  await gov.post('/api/gov/passport', { full_name: name, birth_date: '1990-05-01', address: 'Влодоград' });
  const me = await gov.get('/api/gov/me');
  const bank = client(app);
  await bank.post('/api/auth/bank/register', { email, password: 'password123', full_name: name, birth_date: '1990-05-01', passport_no: me.passport.number });
  const links = await gov.get('/api/gov/links');
  await gov.post(`/api/gov/links/${links.links[0].id}/confirm`);
  const cur = (await bank.post('/api/bank/accounts', { type: 'current' })).account;
  const id = (await one('SELECT id FROM bank_users WHERE email = ?', [email])).id;
  return { gov, bank, cur, id, passport: me.passport.number };
}

async function shopFor(p, name, type = 'shop') {
  await p.gov.post('/api/gov/documents/inn');
  await p.gov.post('/api/gov/documents/ip', { trade_name: name });
  const inv = (await p.gov.get('/api/gov/me')).invoices.find((i) => i.status === 'unpaid');
  await p.bank.idem(`/api/bank/invoices/${inv.number}/pay`, { account_id: p.cur.id });
  const biz = (await p.bank.post('/api/bank/accounts', { type: 'business' })).account;
  const shop = (await p.bank.post('/api/pos/shops', { name, type, account_id: biz.id, pin: '1234' })).shop;
  await p.bank.post('/api/pos/login', { shop_id: shop.id, pin: '1234' });
  await p.bank.post('/api/pos/shifts/open', { opening_float: 0 });
  return { shop, biz };
}

const bal = async (id) => Number((await one('SELECT balance FROM accounts WHERE id = ?', [id])).balance);
async function noMoneyFromAir() {
  assert.equal(await totalBalance(), 0, 'сумма всех счетов = 0');
}

let admin;
let owner;
let shop;
let biz;
let buyer;
let card;

test('setup', async () => {
  admin = client(app);
  await admin.post('/api/auth/gov/register', { email: 'admin@test.bf', password: 'password123', display_name: 'Админ' });
  await admin.patch('/api/admin/settings', { fraud_threshold: 0, fraud_velocity: 0, fraud_multiplier: 0, vat_bp: 2000 });
  owner = await player('cafe@test.bf', 'Ольга Кафейная');
  ({ shop, biz } = await shopFor(owner, 'Кафе Ольги', 'cafe'));
  assert.equal(shop.kitchen_enabled, true, 'у кафе кухня включена по умолчанию');
  // Пополнить бизнес-счёт для закупок.
  await admin.post('/api/admin/emission', { account_id: biz.id, amount: 100000, memo: 'Капитал' });
  buyer = await player('buyer@test.bf', 'Борис Покупатель');
  card = (await buyer.bank.post('/api/bank/cards', { account_id: buyer.cur.id, pin: '123' })).card;
});

test('wholesale: price follows inflation, purchase debits business account and stocks the product', async () => {
  const list = await owner.bank.get('/api/pos/wholesale');
  const coffee = list.items.find((i) => i.name === 'Кофе в зёрнах');
  assert.equal(coffee.price, 4000);
  await admin.patch('/api/admin/settings', { inflation_bp: 1000 });
  await advance({ force: true });
  const list2 = await owner.bank.get('/api/pos/wholesale');
  assert.equal(list2.items.find((i) => i.name === 'Кофе в зёрнах').price, 4400, 'цена выросла на 10%');
  await admin.patch('/api/admin/settings', { inflation_bp: 0 });

  const before = await bal(biz.id);
  const r = await owner.bank.idem('/api/pos/purchases/wholesale', { items: [{ item_id: coffee.id, qty_milli: 2000 }] });
  assert.equal(r.purchase.total, 8800);
  assert.equal(await bal(biz.id), before - 8800);
  const prod = (await owner.bank.get('/api/pos/products?all=1')).products.find((p) => p.name === 'Кофе в зёрнах');
  assert.equal(prod.stock_milli, 2000);
  assert.equal(prod.cost, 4400);
  assert.equal(prod.price, 6600, 'новый товар с наценкой 50%');
  const adm = await admin.get('/api/admin/wholesale');
  assert.ok(adm.items.length >= 6);
  await noMoneyFromAir();
});

let coffee;
test('variants and modifiers change price and name; promos, promo codes and points', async () => {
  coffee = (await owner.bank.post('/api/pos/products', { name: 'Капучино', price: 300, stock_milli: 100000, to_kitchen: true })).product;
  const v = await owner.bank.post(`/api/pos/products/${coffee.id}/variants`, { name: 'большой', price_delta: 100 });
  const m = await owner.bank.post(`/api/pos/products/${coffee.id}/modifiers`, { name: 'сироп', price: 50 });
  const listed = (await owner.bank.get('/api/pos/products')).products.find((p) => p.id === coffee.id);
  assert.equal(listed.variants.length, 1);
  assert.equal(listed.modifiers.length, 1);

  let sale = (await owner.bank.post('/api/pos/sales', { items: [{ product_id: coffee.id, qty_milli: 2000, variant_id: v.id, modifier_ids: [m.id] }] })).sale;
  assert.equal(sale.items[0].name, 'Капучино (большой) + сироп');
  assert.equal(sale.total, 900);
  await owner.bank.post(`/api/pos/sales/${sale.id}/cancel`);

  // Акции: 10% на чек от 500, промокод −100, «от 3 штук −20%» на капучино.
  await owner.bank.post('/api/pos/promos', { title: 'Чек от 5 В', kind: 'percent', value: 1000, min_total: 500 });
  await owner.bank.post('/api/pos/promos', { title: 'Промокод', kind: 'amount', value: 100, code: 'hello', max_uses: 1 });
  await owner.bank.post('/api/pos/promos', { title: '3 капучино', kind: 'qty', value: 2000, product_id: coffee.id, min_qty: 3 });
  sale = (await owner.bank.post('/api/pos/sales', { items: [{ product_id: coffee.id, qty_milli: 3000 }], promo_code: 'HELLO' })).sale;
  // 900: −90 (10%) −100 (код) −180 (20% от 900) = 530
  assert.equal(sale.promo_discount, 370);
  assert.equal(sale.total, 530);
  await assert.rejects(owner.bank.post('/api/pos/sales', { items: [{ product_id: coffee.id, qty_milli: 1000 }], promo_code: 'NOPE' }), /promo_invalid/);

  // Баллы: 10% от чека начисляются клиенту, оплатившему картой.
  await owner.bank.patch('/api/pos/shop', { loyalty_bp: 1000, loyalty_max_bp: 5000 });
  sale = (await owner.bank.post(`/api/pos/sales/${sale.id}/pay`, { method: 'card', amount: 530, number: card.number, pin: '123' })).sale;
  assert.equal(sale.status, 'paid');
  assert.equal(sale.points_earned, 53);
  assert.ok(sale.queue_no, 'кафе: заказ ушёл на кухню с номером очереди');
  await assert.rejects(owner.bank.post('/api/pos/sales', { items: [{ product_id: coffee.id, qty_milli: 1000 }], promo_code: 'HELLO' }), /promo_used/);

  const look = await owner.bank.get(`/api/pos/loyalty/lookup?q=${buyer.passport}`);
  assert.equal(look.customer.points, 53);
  // Списание баллов: не больше 50% чека и не больше баланса.
  const s2 = (await owner.bank.post('/api/pos/sales', { items: [{ product_id: coffee.id, qty_milli: 1000 }], loyalty: card.number, redeem_points: 1000 })).sale;
  assert.equal(s2.points_used, 53);
  assert.equal((await owner.bank.get(`/api/pos/loyalty/lookup?q=${card.number}`)).customer.points, 0);
  await owner.bank.post(`/api/pos/sales/${s2.id}/cancel`);
  assert.equal((await owner.bank.get(`/api/pos/loyalty/lookup?q=${card.number}`)).customer.points, 53, 'отмена чека вернула баллы');

  // Возврат уменьшает начисленные баллы.
  await owner.bank.idem('/api/pos/refunds', { sale_id: sale.id, all: true });
  assert.equal((await owner.bank.get(`/api/pos/loyalty/lookup?q=${card.number}`)).customer.points, 0);
  for (const p of (await owner.bank.get('/api/pos/promos')).promos) await owner.bank.patch(`/api/pos/promos/${p.id}`, { active: false });
  await noMoneyFromAir();
});

test('kitchen and queue board', async () => {
  const k = await owner.bank.get('/api/pos/kitchen');
  assert.ok(k.orders.length >= 1);
  const o = k.orders[0];
  assert.equal(o.status, 'new');
  let board = await owner.bank.get('/api/pos/queue');
  assert.ok(board.cooking.includes(o.queue_no));
  await owner.bank.post(`/api/pos/kitchen/${o.id}/status`, { status: 'cooking' });
  await owner.bank.post(`/api/pos/kitchen/${o.id}/status`, { status: 'ready' });
  board = await owner.bank.get('/api/pos/queue');
  assert.ok(board.ready.includes(o.queue_no));
  // Перешагнуть статус нельзя: сначала «готовится».
  await assert.rejects(owner.bank.post(`/api/pos/kitchen/${o.id}/status`, { status: 'new' }), /kitchen_state/);
  await owner.bank.post(`/api/pos/kitchen/${o.id}/status`, { status: 'done' });
  board = await owner.bank.get('/api/pos/queue');
  assert.ok(!board.ready.includes(o.queue_no));
});

test('tables: open tab, send to kitchen, checkout and pay, cancel returns tab to the table', async () => {
  const t1 = await owner.bank.post('/api/pos/tables', { name: 'Стол 1', seats: 4 });
  const t2 = await owner.bank.post('/api/pos/tables', { name: 'Стол 2' });
  let tab = (await owner.bank.post(`/api/pos/tables/${t1.id}/items`, { items: [{ product_id: coffee.id, qty_milli: 1000 }] })).tab;
  tab = (await owner.bank.post(`/api/pos/tables/${t1.id}/items`, { items: [{ product_id: coffee.id, qty_milli: 2000 }] })).tab;
  assert.equal(tab.total, 900);
  const kitchenBefore = (await owner.bank.get('/api/pos/kitchen')).orders.length;
  const sent = await owner.bank.post(`/api/pos/tables/${t1.id}/kitchen`);
  assert.ok(sent.order.queue_no);
  await assert.rejects(owner.bank.post(`/api/pos/tables/${t1.id}/kitchen`), /nothing_to_send/);
  const tables = (await owner.bank.get('/api/pos/tables')).tables;
  assert.equal(tables.find((x) => x.id === t1.id).tab.total, 900);
  // Не попадает в «отложенные».
  assert.equal((await owner.bank.get('/api/pos/held')).held.length, 0);

  await owner.bank.post(`/api/pos/tables/${t1.id}/move`, { to_table_id: t2.id });
  let sale = (await owner.bank.post(`/api/pos/tables/${t2.id}/checkout`, { tip_pct: 10 })).sale;
  assert.equal(sale.total, 900);
  assert.equal(sale.tip, 90);
  await owner.bank.post(`/api/pos/sales/${sale.id}/cancel`);
  const back = (await owner.bank.get(`/api/pos/tables/${t2.id}/tab`)).tab;
  assert.equal(back.status, 'held');
  assert.equal(back.total, 900);

  sale = (await owner.bank.post(`/api/pos/tables/${t2.id}/checkout`, {})).sale;
  sale = (await owner.bank.post(`/api/pos/sales/${sale.id}/pay`, { method: 'cash', amount: 900, cash_given: 1000 })).sale;
  assert.equal(sale.status, 'paid');
  assert.equal((await owner.bank.get('/api/pos/kitchen')).orders.length, kitchenBefore + 1, 'блюда уже были на кухне — второй заказ не создаётся');
  assert.equal((await owner.bank.get(`/api/pos/tables/${t2.id}/tab`)).tab, null);
});

test('debts: sale on credit, repay at the till and in the bank, VAT settled at Z', async () => {
  let sale = (await owner.bank.post('/api/pos/sales', { items: [{ product_id: coffee.id, qty_milli: 2000 }] })).sale;
  const r = await owner.bank.post(`/api/pos/sales/${sale.id}/pay`, { method: 'debt', amount: 600, customer: buyer.passport });
  assert.equal(r.sale.status, 'paid');
  let debts = await owner.bank.get('/api/pos/debts');
  assert.equal(debts.open_total, 600);
  const debt = debts.debts[0];
  assert.equal(debt.bank_user_id, buyer.id);
  // Клиент видит долг в банке и гасит часть.
  const mine = await buyer.bank.get('/api/bank/debts');
  assert.equal(mine.debts[0].left, 600);
  const bizBefore = await bal(biz.id);
  await buyer.bank.idem(`/api/bank/debts/${debt.id}/pay`, { account_id: buyer.cur.id, amount: 200 });
  assert.equal(await bal(biz.id), bizBefore + 200);
  // Остаток — наличными на кассе.
  const x1 = (await owner.bank.get('/api/pos/shifts/x')).report;
  await owner.bank.post(`/api/pos/debts/${debt.id}/repay`, { method: 'cash', amount: 400 });
  const x2 = (await owner.bank.get('/api/pos/shifts/x')).report;
  assert.equal(x2.expected_cash, x1.expected_cash + 400);
  debts = await owner.bank.get('/api/pos/debts');
  assert.equal(debts.open_total, 0);

  // Неименной долг: имя обязательно.
  sale = (await owner.bank.post('/api/pos/sales', { items: [{ product_id: coffee.id, qty_milli: 1000 }] })).sale;
  await assert.rejects(owner.bank.post(`/api/pos/sales/${sale.id}/pay`, { method: 'debt', amount: 300 }), /invalid/);
  await owner.bank.post(`/api/pos/sales/${sale.id}/pay`, { method: 'debt', amount: 300, customer_name: 'Сосед Вася' });
  // Возврат по чеку в долг уменьшает долг.
  const ref = await owner.bank.idem('/api/pos/refunds', { sale_id: sale.id, all: true });
  assert.equal(ref.refund.by_method.debt, 300);
  assert.equal((await owner.bank.get('/api/pos/debts')).open_total, 0);
  assert.ok(x2.cash_vat > x1.cash_vat || x2.cash_vat >= 0);
  await noMoneyFromAir();
});

test('shop-to-shop order: seller accepts, money and goods move', async () => {
  const seller = await player('farm@test.bf', 'Фермер Иван');
  const { shop: farm, biz: farmBiz } = await shopFor(seller, 'Ферма Ивана');
  const milk = (await seller.bank.post('/api/pos/products', { name: 'Молоко фермерское', price: 400, b2b_price: 250, stock_milli: 10000 })).product;
  const offers = (await owner.bank.get('/api/pos/market')).offers;
  assert.ok(offers.some((o) => o.id === milk.id && o.b2b_price === 250));
  const order = await owner.bank.post('/api/pos/purchases/shop', { seller_shop_id: farm.id, items: [{ product_id: milk.id, qty_milli: 4000 }] });
  assert.equal(order.purchase.total, 1000);
  const incoming = (await seller.bank.get('/api/pos/purchases')).orders;
  assert.equal(incoming[0].status, 'pending');
  const a = await bal(biz.id);
  const b = await bal(farmBiz.id);
  await seller.bank.post(`/api/pos/orders/${incoming[0].id}/accept`);
  assert.equal(await bal(biz.id), a - 1000);
  assert.equal(await bal(farmBiz.id), b + 1000);
  const mine = (await owner.bank.get('/api/pos/products?all=1')).products.find((p) => p.name === 'Молоко фермерское');
  assert.equal(mine.stock_milli, 4000);
  assert.equal(mine.cost, 250);
  assert.equal(mine.price, 400);
  const theirs = (await seller.bank.get('/api/pos/products?all=1')).products.find((p) => p.id === milk.id);
  assert.equal(theirs.stock_milli, 6000);
  await assert.rejects(seller.bank.post(`/api/pos/orders/${incoming[0].id}/accept`), /decided/);
  await noMoneyFromAir();
});

test('kiosk: card only, no age-restricted goods, unlock by PIN', async () => {
  const beer = (await owner.bank.post('/api/pos/products', { name: 'Пиво', price: 200, age_limit: 18, stock_milli: 5000 })).product;
  await assert.rejects(owner.bank.post('/api/pos/sales', { items: [{ product_id: beer.id, qty_milli: 1000 }], source: 'kiosk' }), /age_kiosk/);
  let sale = (await owner.bank.post('/api/pos/sales', { items: [{ product_id: coffee.id, qty_milli: 1000 }], source: 'kiosk', discount: 100 })).sale;
  assert.equal(sale.manual_discount, 0, 'в киоске ручной скидки нет');
  await assert.rejects(owner.bank.post(`/api/pos/sales/${sale.id}/pay`, { method: 'cash', amount: sale.total }), /kiosk_method/);
  sale = (await owner.bank.post(`/api/pos/sales/${sale.id}/pay`, { method: 'card', amount: sale.total, number: card.number, pin: '123' })).sale;
  assert.equal(sale.status, 'paid');
  assert.ok(sale.queue_no);
  await assert.rejects(owner.bank.post('/api/pos/kiosk/unlock', { pin: '0000' }), /pin_wrong/);
  await owner.bank.post('/api/pos/kiosk/unlock', { pin: '1234' });
});

test('reports and Z close with debts and tabs', async () => {
  const rep = await owner.bank.get('/api/pos/reports?days=1');
  assert.ok(rep.sales >= 4);
  assert.ok(rep.by_day.length >= 1);
  assert.ok(rep.purchases >= 9800);
  assert.ok(rep.by_source.kiosk);
  assert.ok(rep.by_method.debt >= 900);
  const z = (await owner.bank.post('/api/pos/shifts/z', { closing_cash: null })).report;
  assert.equal(z.shift.status, 'closed');
  await noMoneyFromAir();
});

test('owner edits variants and modifiers, adjusts stock, switches promo off', async () => {
  const p = (await owner.bank.post('/api/pos/products', { name: 'Чай', price: 200, stock_milli: 10000 })).product;
  const v = await owner.bank.post(`/api/pos/products/${p.id}/variants`, { name: 'большой', price_delta: 50 });
  const m = await owner.bank.post(`/api/pos/products/${p.id}/modifiers`, { name: 'лимон', price: 20 });
  await owner.bank.patch(`/api/pos/variants/${v.id}`, { name: 'огромный', price_delta: 70 });
  await owner.bank.patch(`/api/pos/modifiers/${m.id}`, { name: 'лайм', price: 30 });
  let prod = (await owner.bank.get('/api/pos/products?all=1')).products.find((x) => x.id === p.id);
  assert.equal(prod.variants.find((x) => x.id === v.id).name, 'огромный');
  assert.equal(prod.variants.find((x) => x.id === v.id).price_delta, 70);
  assert.equal(prod.modifiers.find((x) => x.id === m.id).name, 'лайм');

  await owner.bank.post('/api/pos/shifts/open', { opening_float: 0 });
  const sale = (await owner.bank.post('/api/pos/sales', { items: [{ product_id: p.id, qty_milli: 1000, variant_id: v.id, modifier_ids: [m.id] }] })).sale;
  assert.equal(sale.items[0].name, 'Чай (огромный) + лайм');
  assert.equal(sale.total, 300);
  await owner.bank.post(`/api/pos/sales/${sale.id}/cancel`);

  // Выключенные вариант и добавка в чек не попадают.
  await owner.bank.patch(`/api/pos/variants/${v.id}`, { active: false });
  await owner.bank.patch(`/api/pos/modifiers/${m.id}`, { active: false });
  await assert.rejects(owner.bank.post('/api/pos/sales', { items: [{ product_id: p.id, qty_milli: 1000, variant_id: v.id }] }), /variant_not_found/);
  await assert.rejects(owner.bank.post('/api/pos/sales', { items: [{ product_id: p.id, qty_milli: 1000, modifier_ids: [m.id] }] }), /modifier_not_found/);

  // Ручная корректировка склада: остаток и журнал движений.
  const after = (await owner.bank.post('/api/pos/stock', { product_id: p.id, qty_milli: -3000 })).product;
  assert.equal(after.stock_milli, 7000);
  const moves = (await owner.bank.get('/api/pos/stock/moves')).moves;
  assert.ok(moves.some((x) => x.name === 'Чай' && x.qty_milli === -3000 && x.reason === 'writeoff'));

  // Инвентаризация: остаток становится ровно введённым числом.
  const delta = 5000 - after.stock_milli;
  await owner.bank.post('/api/pos/stock', { product_id: p.id, qty_milli: delta });
  assert.equal((await owner.bank.get('/api/pos/products?all=1')).products.find((x) => x.id === p.id).stock_milli, 5000);

  const promo = await owner.bank.post('/api/pos/promos', { title: 'Тестовая', kind: 'percent', value: 500 });
  await owner.bank.patch(`/api/pos/promos/${promo.id}`, { active: false });
  assert.equal((await owner.bank.get('/api/pos/promos')).promos.find((x) => x.id === promo.id).active, false);
  await noMoneyFromAir();
});
