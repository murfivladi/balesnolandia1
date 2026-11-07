// Этап Н9: деньги в сети — эквайринг ВлодБанка (pay.bank.bln), вебхуки с подписью, возвраты, подписки,
// интернет-магазин на складе Кассы, доставка (самовывоз, курьер с QR, цифровой товар, реальная доставка с одобрением),
// «Войти через ВлодПочту» и «Войти через ВлодУслуги» (OAuth 2 с PKCE).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { setup, client, pool, one, q, totalBalance } from './helpers.js';

let app;
let clock;
let netRequest;
let flushWebhooks;
before(async () => {
  app = await setup();
  clock = await import('../src/lib/clock.js');
  clock.setGameTimeOverride(() => 300000);
  (await import('../src/lib/dns.js')).flushResolverCache();
  ({ netRequest } = await import('../src/lib/vhost/respond.js'));
  ({ flushWebhooks } = await import('../src/lib/pay/core.js'));
});
after(async () => {
  await (await import('../src/lib/vhost/pool.js')).stopPools();
  clock.setGameTimeOverride(null);
  await fs.rm(process.env.BALNET_SITES_DIR, { recursive: true, force: true });
  await app.close();
  await pool.end();
});

async function player(email, name, birth = '1990-05-01') {
  const gov = client(app);
  await gov.post('/api/auth/gov/register', { email, password: 'password123', display_name: name });
  await gov.post('/api/gov/passport', { full_name: name, birth_date: birth, address: 'Влодоград' });
  const me = await gov.get('/api/gov/me');
  const bank = client(app);
  await bank.post('/api/auth/bank/register', { email, password: 'password123', full_name: name, birth_date: birth, passport_no: me.passport.number });
  const links = await gov.get('/api/gov/links');
  await gov.post(`/api/gov/links/${links.links[0].id}/confirm`);
  const cur = (await bank.post('/api/bank/accounts', { type: 'current' })).account;
  const id = (await one('SELECT id FROM bank_users WHERE email = ?', [email])).id;
  return { gov, bank, cur, id };
}
const bal = async (id) => Number((await one('SELECT balance FROM accounts WHERE id = ?', [id])).balance);
const sysBal = async (code) => Number((await one('SELECT balance FROM accounts WHERE system_code = ?', [code])).balance);

let admin;
let owner;
let buyer;
let card;
let shop;
let biz;
let merchant;
let keys;
let site;

/** Запрос сервера сайта по сети БалНета (как fetch из server.js). */
async function api(method, path, body, { key = keys.secret, idem = null, host = 'pay.bank.bln' } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (key) headers.authorization = `Bearer ${key}`;
  if (idem) headers['idempotency-key'] = idem;
  const r = await netRequest({ fromIp: site.ip, url: `https://${host}${path}`, method, headers, body: body ? JSON.stringify(body) : null });
  assert.ok(!r.error, `сеть: ${r.error}`);
  return { status: r.status, body: JSON.parse(r.body) };
}

async function visit(dev, path) {
  const o = await dev.post('/api/net/open', { client_id: 'device-pay-01', url: `http://shop.bln${path}` });
  const res = await app.inject({ method: 'GET', url: `/api/net/web/${o.ticket}${path}` });
  return JSON.parse(res.body);
}

test('мерчант: ИП подключает магазин Кассы к эквайрингу, ключи и сайт с вебхуком', async () => {
  admin = client(app);
  await admin.post('/api/auth/gov/register', { email: 'admin@test.bf', password: 'password123', display_name: 'Админ' });
  await admin.patch('/api/admin/settings', { fraud_threshold: 0, fraud_velocity: 0, fraud_multiplier: 0, start_balance: 500000, transfer_fee_bp: 0, transfer_fee_min: 0, vat_bp: 2000, online_fee_bp: 200 });
  owner = await player('shop@test.bf', 'Олег Лавочкин');
  buyer = await player('buyer@test.bf', 'Вера Покупкина');
  card = (await buyer.bank.post('/api/bank/cards', { account_id: buyer.cur.id, pin: '123' })).card;

  await owner.gov.post('/api/gov/documents/inn');
  await owner.gov.post('/api/gov/documents/ip', { trade_name: 'Лавка Олега' });
  const inv = (await owner.gov.get('/api/gov/me')).invoices.find((i) => i.status === 'unpaid');
  await owner.bank.idem(`/api/bank/invoices/${inv.number}/pay`, { account_id: owner.cur.id });
  biz = (await owner.bank.post('/api/bank/accounts', { type: 'business' })).account;
  shop = (await owner.bank.post('/api/pos/shops', { name: 'Лавка Олега', type: 'shop', account_id: biz.id, pin: '1234' })).shop;
  await owner.bank.post('/api/pos/login', { shop_id: shop.id, pin: '1234' });

  const opts = await owner.bank.get('/api/pay/merchant-options');
  assert.equal(opts.shops[0].id, shop.id);
  await assert.rejects(owner.bank.post('/api/pay/merchants', { name: 'Лавка', account_id: owner.cur.id }), /бизнес-счёт/);
  const r = await owner.bank.post('/api/pay/merchants', { name: 'Лавка Олега', account_id: biz.id, shop_id: shop.id, site_url: 'https://shop.bln/' });
  merchant = r.merchant;
  keys = r.keys;
  assert.match(keys.secret, /^sk_live_/);
  assert.match(keys.publishable, /^pk_live_/);
  assert.equal(merchant.account.id, biz.id);

  // Домен, виртуальный хостинг и server.js магазина: создаёт платёж и принимает вебхуки с проверкой подписи.
  const d = await owner.gov.post('/api/gov/domains', { name: 'shop.bln' });
  await owner.bank.idem(`/api/bank/invoices/${d.invoice}/pay`, { account_id: owner.cur.id });
  const virt = (await owner.gov.get('/api/gov/hosting')).offers.find((o) => o.kind === 'virtual');
  const acc = await owner.gov.post('/api/gov/hosting', { plan_id: virt.id, months: 6 });
  await owner.bank.idem(`/api/bank/invoices/${acc.invoice}/pay`, { account_id: owner.cur.id });
  const s = await owner.gov.post(`/api/gov/hosting/${acc.account_id}/sites`, { host: 'shop.bln' });
  site = { f: `/api/gov/hosting/${acc.account_id}/sites/${s.id}`, ip: s.ip };
  const dom = (await owner.gov.get('/api/gov/domains')).domains.find((x) => x.name === 'shop.bln');
  await owner.gov.post(`/api/gov/domains/${dom.id}/records`, { name: '@', type: 'A', data: s.ip });
  await owner.bank.patch(`/api/pay/merchants/${merchant.id}`, { webhook_url: 'http://shop.bln/hook', courier_fee: 300, delivery: { pickup: true, courier: true, digital: true, physical: true } });
  const secret = (await owner.bank.get(`/api/pay/merchants/${merchant.id}`)).merchant.webhook_secret;
  await owner.gov.put(`${site.f}/file`, { path: 'server.js', content: `
db.exec('CREATE TABLE IF NOT EXISTS ev (id TEXT, type TEXT, ok INTEGER, obj TEXT)');
const SK = ${JSON.stringify(keys.secret)};
const WH = ${JSON.stringify(secret)};
export async function onRequest(req) {
  if (req.path === '/buy') {
    const r = await fetch('https://pay.bank.bln/api/v1/payments', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + SK, 'content-type': 'application/json', 'idempotency-key': req.query.get('n') },
      body: JSON.stringify({ amount: 12000, description: 'Подарочный набор', return_url: 'https://shop.bln/thanks', metadata: { cart: req.query.get('n') } }),
    });
    return Response.json(await r.json(), { status: r.status });
  }
  if (req.path === '/hook') {
    const body = await req.text();
    const sig = req.headers.get('vlod-signature') || '';
    const t = (/t=(\\d+)/.exec(sig) || [])[1];
    const v1 = (/v1=([0-9a-f]+)/.exec(sig) || [])[1];
    const ok = crypto.timingSafeEqual(crypto.hmac('sha256', WH, t + '.' + body), v1 || '');
    const e = JSON.parse(body);
    db.run('INSERT INTO ev VALUES (?, ?, ?, ?)', [e.id, e.type, ok ? 1 : 0, JSON.stringify(e.data.object)]);
    return ok ? new Response('ok') : new Response('bad signature', { status: 400 });
  }
  if (req.path === '/events') return Response.json(db.query('SELECT * FROM ev'));
  return new Response('Лавка Олега');
}
` });
  const ping = await owner.bank.post(`/api/pay/merchants/${merchant.id}/webhook-test`);
  assert.equal(ping.delivered, true, `вебхук ping: ${ping.event.last_code} ${ping.event.last_error}`);
});

let paymentId;
test('платёж: сайт создаёт его по API, покупатель платит картой на pay.bank.bln, НДС и комиссия разнесены', async () => {
  const dev = client(app);
  await dev.post('/api/net/lease', { client_id: 'device-pay-01', provider: 'baltelecom' });
  const created = await visit(dev, '/buy?n=cart-1');
  assert.equal(created.status, 'pending');
  assert.equal(created.amount, 12000);
  assert.match(created.url, /^https:\/\/pay\.bank\.bln\/c\/pay_/);
  paymentId = created.id;
  const again = await visit(dev, '/buy?n=cart-1');
  assert.equal(again.id, paymentId, 'ключ идемпотентности — тот же платёж');

  // Без ключа и с публичным ключом — отказ.
  assert.equal((await api('POST', '/api/v1/payments', { amount: 1, description: 'x' }, { key: null })).status, 401);
  assert.equal((await api('POST', '/api/v1/payments', { amount: 1, description: 'x' }, { key: keys.publishable })).status, 403);
  // По http госсайт API не отдаёт.
  const plain = await netRequest({ fromIp: site.ip, url: 'http://pay.bank.bln/api/v1/me', headers: { authorization: `Bearer ${keys.secret}` } });
  assert.equal(JSON.parse(plain.body).error.code, 'https_required');

  const info = (await buyer.bank.get(`/api/pay/checkout/${paymentId}`));
  assert.equal(info.payment.merchant.name, 'Лавка Олега');
  assert.equal(info.payer.accounts[0].id, buyer.cur.id);
  await assert.rejects(client(app).post(`/api/pay/checkout/${paymentId}/card`, { number: card.number, exp: card.exp_month, pin: '999' }), /PIN/);

  const sum0 = await totalBalance();
  const [b0, m0, budget0, treasury0] = [await bal(buyer.cur.id), await bal(biz.id), await sysBal('BUDGET'), await sysBal('TREASURY')];
  const paid = await client(app).post(`/api/pay/checkout/${paymentId}/card`, { number: card.number, exp: card.exp_month, pin: '123' });
  assert.match(paid.redirect, /^https:\/\/shop\.bln\/thanks\?payment=pay_.+&status=paid$/);
  await assert.rejects(client(app).post(`/api/pay/checkout/${paymentId}/card`, { number: card.number, exp: card.exp_month, pin: '123' }), /Уже оплачено/);
  // 12000: НДС 20% внутри = 2000, комиссия 2% от 10000 = 200, магазину 9800.
  assert.equal(await bal(buyer.cur.id), b0 - 12000);
  assert.equal(await bal(biz.id), m0 + 9800);
  assert.equal(await sysBal('BUDGET'), budget0 + 2000);
  assert.equal(await sysBal('TREASURY'), treasury0 + 200);
  assert.equal(await totalBalance(), sum0, 'деньги не из воздуха');

  const got = await api('GET', `/api/v1/payments/${paymentId}`);
  assert.deepEqual([got.body.status, got.body.vat, got.body.fee, got.body.net, got.body.method], ['paid', 2000, 200, 9800, 'card']);
  assert.equal(got.body.metadata.cart, 'cart-1');

  await flushWebhooks();
  const evs = await visit(dev, '/events');
  const ok = evs.find((e) => e.type === 'payment.succeeded');
  assert.equal(ok.ok, 1, 'подпись вебхука проверена скриптом сайта');
  assert.equal(JSON.parse(ok.obj).id, paymentId);
  const list = (await owner.bank.get(`/api/pay/merchants/${merchant.id}/events`)).events;
  assert.ok(list.find((e) => e.type === 'payment.succeeded').status === 'delivered');
});

test('возвраты: частичный и остаток, НДС возвращается из бюджета, больше оплаченного — нельзя', async () => {
  // Комиссия банка не возвращается: на полный возврат магазину нужны свои деньги на счёте.
  await admin.post('/api/admin/emission', { account_id: biz.id, amount: 50000, memo: 'Капитал' });
  const b0 = await bal(buyer.cur.id);
  const budget0 = await sysBal('BUDGET');
  const r1 = await api('POST', '/api/v1/refunds', { payment: paymentId, amount: 6000, reason: 'Не подошёл размер' });
  assert.equal(r1.status, 201);
  assert.equal(r1.body.vat, 1000);
  assert.equal(r1.body.payment_object.status, 'partially_refunded');
  assert.equal(await bal(buyer.cur.id), b0 + 6000);
  assert.equal(await sysBal('BUDGET'), budget0 - 1000);
  const tooMuch = await api('POST', '/api/v1/refunds', { payment: paymentId, amount: 7000 });
  assert.equal(tooMuch.status, 400);
  assert.equal(tooMuch.body.error.code, 'refund_exceeds');
  const r2 = await owner.bank.post(`/api/pay/merchants/${merchant.id}/payments/${paymentId}/refund`, {});
  assert.equal(r2.payment.status, 'refunded');
  assert.equal(r2.payment.refunded, 12000);
  const p = (await buyer.bank.get('/api/pay/purchases')).payments.find((x) => x.id === paymentId);
  assert.equal(p.refunded, 12000);
});

test('подписка: первый платёж со счёта, автосписание каждый игровой месяц, отмена покупателем', async () => {
  const r = await api('POST', '/api/v1/subscriptions', { amount: 1000, description: 'Клуб любителей чая', period_months: 1, return_url: 'https://shop.bln/club' });
  assert.equal(r.status, 201);
  assert.equal(r.body.status, 'pending');
  const pid = r.body.payment.id;
  await assert.rejects(client(app).post(`/api/pay/checkout/${pid}/card`, { number: card.number, exp: card.exp_month, pin: '123' }), /со счёта/);
  await buyer.bank.post(`/api/pay/checkout/${pid}/account`, { account_id: buyer.cur.id });
  const s1 = (await api('GET', `/api/v1/subscriptions/${r.body.id}`)).body;
  assert.equal(s1.status, 'active');
  const b0 = await bal(buyer.cur.id);
  await clock.advance({ force: true });
  assert.equal(await bal(buyer.cur.id), b0 - 1000, 'списание за следующий месяц');
  const s2 = (await api('GET', `/api/v1/subscriptions/${r.body.id}`)).body;
  assert.equal(s2.next_month, s1.next_month + 1);
  await buyer.bank.post(`/api/pay/subscriptions/${r.body.id}/cancel`);
  await clock.advance({ force: true });
  assert.equal(await bal(buyer.cur.id), b0 - 1000, 'после отмены не списывается');
  await flushWebhooks();
  const types = (await owner.bank.get(`/api/pay/merchants/${merchant.id}/events`)).events.map((e) => e.type);
  for (const t of ['subscription.activated', 'subscription.renewed', 'subscription.cancelled']) assert.ok(types.includes(t), t);
});

let tea;
let ebook;
test('интернет-магазин: каталог Кассы, заказ на самовывоз — чек в Кассе, склад списан, выдача по коду', async () => {
  tea = (await owner.bank.post('/api/pos/products', { name: 'Чай Влодский', price: 2500, stock_milli: 5000, online: true })).product;
  ebook = (await owner.bank.post('/api/pos/products', { name: 'Книга «БалНет для чайников» (PDF)', price: 1500, track_stock: false, online: true, digital_content: 'Ссылка: https://shop.bln/books/balnet.pdf, код TEA-42' })).product;
  await owner.bank.post('/api/pos/products', { name: 'Секретный товар', price: 100, stock_milli: 1000 });
  const cat = (await api('GET', '/api/v1/products', null, { key: keys.publishable })).body;
  assert.deepEqual(cat.products.map((p) => p.name).sort(), ['Книга «БалНет для чайников» (PDF)', 'Чай Влодский']);
  assert.equal(cat.products.find((p) => p.id === tea.id).in_stock, 5);
  assert.equal(cat.products.find((p) => p.id === ebook.id).digital, true);
  assert.equal(JSON.stringify(cat).includes('TEA-42'), false, 'содержимое цифрового товара до оплаты не видно');

  const tooMany = await api('POST', '/api/v1/orders', { items: [{ product_id: tea.id, qty: 9 }], delivery: 'pickup' });
  assert.equal(tooMany.body.error.code, 'out_of_stock');
  const o = await api('POST', '/api/v1/orders', { items: [{ product_id: tea.id, qty: 2 }], delivery: 'pickup', return_url: 'https://shop.bln/order' });
  assert.equal(o.status, 201);
  assert.equal(o.body.total, 5000);
  assert.equal(o.body.status, 'pending');
  await client(app).post(`/api/pay/checkout/${o.body.payment.id}/card`, { number: card.number, exp: card.exp_month, pin: '123' });
  const prod = (await owner.bank.get('/api/pos/products')).products.find((p) => p.id === tea.id);
  assert.equal(prod.stock_milli, 3000, 'склад Кассы уменьшился');
  const sale = await one("SELECT * FROM sales WHERE source = 'online' ORDER BY id DESC LIMIT 1");
  assert.equal(Number(sale.total), 5000);
  assert.equal(sale.status, 'paid');
  const mine = (await buyer.bank.get('/api/pay/purchases')).orders.find((x) => x.id === o.body.id);
  assert.match(mine.pickup_code, /^\d{6}$/);
  const list = (await owner.bank.get('/api/pos/online-orders')).orders;
  const row = list.find((x) => x.id === o.body.id);
  await owner.bank.post(`/api/pos/online-orders/${row.internal_id}/ready`);
  await assert.rejects(owner.bank.post('/api/pos/online-orders/pickup', { code: '000000' }), /не найден/);
  const done = await owner.bank.post('/api/pos/online-orders/pickup', { code: mine.pickup_code });
  assert.equal(done.order.status, 'delivered');
  const state = (await api('GET', `/api/v1/orders/${o.body.id}`)).body;
  assert.equal(state.status, 'delivered');
});

test('цифровой товар выдаётся сразу; возврат заказа по позициям возвращает и деньги, и склад', async () => {
  const o = await api('POST', '/api/v1/orders', { items: [{ product_id: ebook.id, qty: 1 }, { product_id: tea.id, qty: 1 }], delivery: 'pickup' });
  await buyer.bank.post(`/api/pay/checkout/${o.body.payment.id}/account`, { account_id: buyer.cur.id });
  const mine = (await buyer.bank.get('/api/pay/purchases')).orders.find((x) => x.id === o.body.id);
  assert.match(mine.digital[0].content, /TEA-42/);
  const b0 = await bal(buyer.cur.id);
  const r = await api('POST', `/api/v1/orders/${o.body.id}/refund`, { items: [{ product_id: tea.id, qty: 1 }], reason: 'Передумал' });
  assert.equal(r.status, 201, JSON.stringify(r.body));
  assert.equal(r.body.amount, 2500);
  assert.equal(await bal(buyer.cur.id), b0 + 2500);
  assert.equal((await owner.bank.get('/api/pos/products')).products.find((p) => p.id === tea.id).stock_milli, 2000 + 1000 - 0, 'чай вернулся на склад');
  assert.equal(r.body.order.status, 'paid');

  const dig = await api('POST', '/api/v1/orders', { items: [{ product_id: ebook.id, qty: 1 }] });
  assert.equal(dig.body.delivery, 'digital');
  await buyer.bank.post(`/api/pay/checkout/${dig.body.payment.id}/account`, { account_id: buyer.cur.id });
  assert.equal((await api('GET', `/api/v1/orders/${dig.body.id}`)).body.status, 'delivered');
});

test('курьер БалНета: берёт собранный заказ, вручает по QR покупателя и получает оплату доставки', async () => {
  const courier = await player('courier@test.bf', 'Костя Курьеров');
  await assert.rejects(api('POST', '/api/v1/orders', { items: [{ product_id: tea.id, qty: 1 }], delivery: 'courier' }).then((r) => { if (r.status >= 400) throw new Error(r.body.error.message); }), /адрес/);
  const o = await api('POST', '/api/v1/orders', { items: [{ product_id: tea.id, qty: 1 }], delivery: 'courier', address: 'Влодоград, ул. Почтовая, 5' });
  assert.equal(o.body.total, 2800);
  await client(app).post(`/api/pay/checkout/${o.body.payment.id}/card`, { number: card.number, exp: card.exp_month, pin: '123' });
  assert.equal((await courier.bank.get('/api/pay/courier/jobs')).jobs.length, 0, 'до сборки заказ курьерам не виден');
  const row = (await owner.bank.get('/api/pos/online-orders')).orders.find((x) => x.id === o.body.id);
  await owner.bank.post(`/api/pos/online-orders/${row.internal_id}/ready`);
  const [job] = (await courier.bank.get('/api/pay/courier/jobs')).jobs;
  assert.equal(job.fee, 300);
  await assert.rejects(buyer.bank.post(`/api/pay/courier/jobs/${job.id}/take`), /Свой заказ/);
  await courier.bank.post(`/api/pay/courier/jobs/${job.id}/take`);
  const token = (await buyer.bank.get('/api/pay/purchases')).orders.find((x) => x.id === o.body.id).handoff_token;
  assert.match(token, /^ho_/);
  const c0 = await bal(courier.cur.id);
  const biz0 = await bal(biz.id);
  const done = await courier.bank.post('/api/pay/courier/confirm', { token });
  assert.equal(done.order.status, 'delivered');
  assert.equal(await bal(courier.cur.id), c0 + 300);
  assert.equal(await bal(biz.id), biz0 - 300);
});

test('реальная доставка: только после одобрения админа и не чаще раза в неделю; отказ — возврат денег', async () => {
  const o1 = await api('POST', '/api/v1/orders', { items: [{ product_id: tea.id, qty: 1 }], delivery: 'physical', address: 'Москва, ул. Настоящая, 1, кв. 2' });
  await buyer.bank.post(`/api/pay/checkout/${o1.body.payment.id}/account`, { account_id: buyer.cur.id });
  const row = (await owner.bank.get('/api/pos/online-orders')).orders.find((x) => x.id === o1.body.id);
  assert.equal(row.physical_status, 'pending');
  await assert.rejects(owner.bank.post(`/api/pos/online-orders/${row.internal_id}/ready`), /одобряет админ/);
  const o2 = await api('POST', '/api/v1/orders', { items: [{ product_id: tea.id, qty: 1 }], delivery: 'physical', address: 'Москва, ул. Настоящая, 1, кв. 2' });
  await assert.rejects(buyer.bank.post(`/api/pay/checkout/${o2.body.payment.id}/account`, { account_id: buyer.cur.id }), /не чаще раза/);
  const [queued] = (await admin.get('/api/admin/pay/physical')).orders;
  assert.equal(queued.id, o1.body.id);
  const b0 = await bal(buyer.cur.id);
  await admin.post(`/api/admin/pay/physical/${queued.internal_id}`, { approve: false, note: 'Адрес вне зоны доставки' });
  assert.equal(await bal(buyer.cur.id), b0 + 2500);
  assert.equal((await api('GET', `/api/v1/orders/${o1.body.id}`)).body.status, 'refunded');
  // После отказа лимит не действует: новый заказ одобряется и отправляется.
  await buyer.bank.post(`/api/pay/checkout/${o2.body.payment.id}/account`, { account_id: buyer.cur.id });
  const q2 = (await admin.get('/api/admin/pay/physical')).orders.find((x) => x.id === o2.body.id);
  await admin.post(`/api/admin/pay/physical/${q2.internal_id}`, { approve: true });
  await owner.bank.post(`/api/pos/online-orders/${q2.internal_id}/ready`);
  await owner.bank.post(`/api/pos/online-orders/${q2.internal_id}/ship`, { delivered: true });
  assert.equal((await api('GET', `/api/v1/orders/${o2.body.id}`)).body.status, 'delivered');
  const ov = await admin.get('/api/admin/pay/overview');
  assert.ok(ov.payments >= 8 && ov.fee > 0);
});

test('OAuth: «Войти через ВлодПочту» с PKCE и «Войти через ВлодУслуги» с проверкой возраста', async () => {
  await buyer.gov.post('/api/mail/me', { login: 'vera' });
  const cl = (await owner.gov.post('/api/oauth/clients', { name: 'Лавка Олега', redirect_uris: ['https://shop.bln/auth/callback'], site_url: 'https://shop.bln/' })).client;
  assert.match(cl.client_secret, /^cs_/);
  const verifier = crypto.randomBytes(32).toString('base64url');
  const challenge = crypto.createHash('sha256').update(verifier).digest('base64url');
  const params = { response_type: 'code', client_id: cl.client_id, redirect_uri: 'https://shop.bln/auth/callback', scope: 'openid profile email', state: 'st-1', code_challenge: challenge, code_challenge_method: 'S256' };
  await assert.rejects(buyer.gov.get(`/api/oauth/mail/authorize?${new URLSearchParams({ ...params, redirect_uri: 'https://evil.bln/cb' })}`), /не зарегистрирован/);
  const info = await buyer.gov.get(`/api/oauth/mail/authorize?${new URLSearchParams(params)}`);
  assert.equal(info.client.name, 'Лавка Олега');
  assert.equal(info.preview.email, 'vera@mail.bln');
  const denied = await buyer.gov.post('/api/oauth/mail/authorize', { params, approve: false });
  assert.match(denied.redirect, /error=access_denied&.*state=st-1/);
  const { redirect } = await buyer.gov.post('/api/oauth/mail/authorize', { params, approve: true });
  const code = new URL(redirect).searchParams.get('code');
  assert.equal(new URL(redirect).searchParams.get('state'), 'st-1');

  const form = (o) => new URLSearchParams(o).toString();
  const tok = async (o, host = 'mail.bln') => {
    const r = await netRequest({ fromIp: site.ip, url: `https://${host}/oauth/token`, method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: form(o) });
    return { status: r.status, body: JSON.parse(r.body) };
  };
  const base = { grant_type: 'authorization_code', code, redirect_uri: 'https://shop.bln/auth/callback', client_id: cl.client_id, client_secret: cl.client_secret };
  assert.equal((await tok({ ...base, client_secret: 'cs_wrong' })).body.error, 'invalid_client');
  assert.equal((await tok({ ...base, code_verifier: 'x'.repeat(43) })).body.error, 'invalid_grant');
  const t = await tok({ ...base, code_verifier: verifier });
  assert.equal(t.status, 200, JSON.stringify(t.body));
  assert.equal(t.body.token_type, 'Bearer');
  const ui = await netRequest({ fromIp: site.ip, url: 'https://mail.bln/oauth/userinfo', headers: { authorization: `Bearer ${t.body.access_token}` } });
  const user = JSON.parse(ui.body);
  assert.deepEqual([user.email, user.email_verified, user.name], ['vera@mail.bln', true, 'Вера Покупкина']);
  assert.equal(user.sub, t.body.sub);
  // Повтор кода — признак перехвата: отказ и отзыв выданного по нему токена (RFC 6749 §4.1.2).
  assert.equal((await tok({ ...base, code_verifier: verifier })).body.error, 'invalid_grant', 'код одноразовый');
  assert.equal((await netRequest({ fromIp: site.ip, url: 'https://mail.bln/oauth/userinfo', headers: { authorization: `Bearer ${t.body.access_token}` } })).status, 401);
  const again = await buyer.gov.post('/api/oauth/mail/authorize', { params, approve: true });
  const t2 = await tok({ ...base, code: new URL(again.redirect).searchParams.get('code'), code_verifier: verifier });
  const disc = JSON.parse((await netRequest({ fromIp: site.ip, url: 'https://gosuslugi.gov.bln/.well-known/openid-configuration' })).body);
  assert.equal(disc.token_endpoint, 'https://gosuslugi.gov.bln/oauth/token');

  // ВлодУслуги: возраст по паспорту без даты рождения.
  const teen = await player('teen@test.bf', 'Петя Юный', '2015-01-01');
  const gp = { client_id: cl.client_id, redirect_uri: 'https://shop.bln/auth/callback', scope: 'openid age passport', state: 's' };
  const g1 = await teen.gov.post('/api/oauth/gov/authorize', { params: gp, approve: true });
  const tg = await tok({ grant_type: 'authorization_code', code: new URL(g1.redirect).searchParams.get('code'), redirect_uri: gp.redirect_uri, client_id: cl.client_id, client_secret: cl.client_secret }, 'gosuslugi.gov.bln');
  const gi = JSON.parse((await netRequest({ fromIp: site.ip, url: 'https://gosuslugi.gov.bln/oauth/userinfo', headers: { authorization: `Bearer ${tg.body.access_token}` } })).body);
  assert.deepEqual([gi.age_verified, gi.age_over_14, gi.age_over_18, gi.passport_verified, gi.full_name], [true, false, false, true, 'Петя Юный']);
  assert.equal(gi.birth_date, undefined);
  // Подключённые приложения: отзыв доступа гасит токены.
  const grants = (await buyer.gov.get('/api/oauth/grants')).grants;
  assert.equal(grants[0].name, 'Лавка Олега');
  await buyer.gov.delete(`/api/oauth/grants/${cl.client_id}?provider=mail`);
  const ui2 = await netRequest({ fromIp: site.ip, url: 'https://mail.bln/oauth/userinfo', headers: { authorization: `Bearer ${t2.body.access_token}` } });
  assert.equal(ui2.status, 401);
  const rows = await q('SELECT COUNT(*) AS n FROM oauth_tokens');
  assert.equal(Number(rows[0].n), 1);
});

test('вебхук: ошибка сайта — повтор по расписанию, блокировка мерчанта останавливает приём; деньги сходятся', async () => {
  await owner.bank.patch(`/api/pay/merchants/${merchant.id}`, { webhook_url: 'http://shop.bln/nope' });
  await owner.gov.put(`${site.f}/file`, { path: 'server.js', content: 'export function onRequest() { return new Response("down", { status: 503 }); }' });
  const t = await owner.bank.post(`/api/pay/merchants/${merchant.id}/webhook-test`);
  assert.equal(t.delivered, false);
  assert.deepEqual([t.event.status, t.event.attempts, t.event.last_code], ['pending', 1, '503']);
  assert.ok(new Date(t.event.next_try_at) > new Date(), 'следующая попытка — позже');
  await admin.post(`/api/admin/pay/merchants/${merchant.id}/block`, { blocked: true, reason: 'проверка' });
  const r = await api('POST', '/api/v1/payments', { amount: 100, description: 'x' });
  assert.equal(r.body.error.code, 'merchant_blocked');
  await admin.post(`/api/admin/pay/merchants/${merchant.id}/block`, { blocked: false });
  assert.equal(await totalBalance(), 0, 'сумма всех счетов = 0');
});
