// Этап 8: налоги и декларации, НДФЛ, штрафы и обжалования, неуплата, пособия, зарплаты
// госслужащих, имущество и ипотека, врач и страховка, выборы, визы, обращения, новости, бюджет.
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

async function player(email, name, birth = '1990-05-01', { children = [] } = {}) {
  const gov = client(app);
  await gov.post('/api/auth/gov/register', { email, password: 'password123', display_name: name });
  await gov.post('/api/gov/passport', { full_name: name, birth_date: birth, address: 'Влодоград', children });
  const me = await gov.get('/api/gov/me');
  const bank = client(app);
  await bank.post('/api/auth/bank/register', { email, password: 'password123', full_name: name, birth_date: birth, passport_no: me.passport.number });
  const links = await gov.get('/api/gov/links');
  await gov.post(`/api/gov/links/${links.links[0].id}/confirm`);
  const cur = (await bank.post('/api/bank/accounts', { type: 'current' })).account;
  const govId = (await one('SELECT id FROM gov_users WHERE email = ?', [email])).id;
  return { gov, bank, cur, govId, passport: me.passport.number, id: (await one('SELECT id FROM bank_users WHERE email = ?', [email])).id };
}

const bal = async (id) => Number((await one('SELECT balance FROM accounts WHERE id = ?', [id])).balance);
const budget = async () => Number((await one("SELECT balance FROM accounts WHERE system_code = 'BUDGET'")).balance);
const month = async () => (await one('SELECT month_index FROM game_clock WHERE id = 1')).month_index;
async function noMoneyFromAir() {
  assert.equal(await totalBalance(), 0, 'сумма всех счетов = 0');
}

let admin;
let anna;
let cop;

test('setup: admin with no fees, police officer', async () => {
  admin = client(app);
  await admin.post('/api/auth/gov/register', { email: 'admin@test.bf', password: 'password123', display_name: 'Админ' });
  await admin.patch('/api/admin/settings', {
    fraud_threshold: 0, fraud_velocity: 0, fraud_multiplier: 0, fee_ip: 0, start_balance: 100000, penalty_bp: 1000, sanction_months: 2, fine_due_months: 1,
    salary_police: 10000, ndfl_bp: 1000, benefits_approval: true, benefit_child: 1000, insurance_price: 3000,
  });
  anna = await player('anna@test.bf', 'Анна Гражданская', '1990-05-01', { children: [{ name: 'Миша', birth_date: '2015-01-01' }] });
  cop = await player('cop@test.bf', 'Пётр Полицейский');
  await admin.post('/api/admin/roles', { kind: 'gov', user_id: cop.govId, role: 'police', grant: true });
});

test('police fine, appeal accepted cancels it; unpaid fine gets penalties, arrest, travel ban, collection', async () => {
  const arts = (await cop.gov.get('/api/gov/fine-articles')).articles;
  const speed = arts.find((a) => a.code === '12.9');
  const look = await cop.gov.get(`/api/gov/work/police/citizen?passport=${anna.passport}`);
  assert.equal(look.citizen.full_name, 'Анна Гражданская');
  await assert.rejects(anna.gov.post('/api/gov/work/police/fines', { passport_no: anna.passport, article_id: speed.id }), /forbidden/);

  const f1 = await cop.gov.post('/api/gov/work/police/fines', { passport_no: anna.passport, article_id: speed.id });
  const f2 = await cop.gov.post('/api/gov/work/police/fines', { passport_no: anna.passport, text: 'Парковка на газоне', amount: 700 });
  let fines = (await anna.gov.get('/api/gov/fines')).fines;
  assert.equal(fines.length, 2);
  // Штраф виден и в банке.
  const charges = await anna.bank.get('/api/bank/state-charges');
  assert.equal(charges.invoices.filter((i) => i.kind === 'fine').length, 2);

  await anna.gov.post(`/api/gov/fines/${f2.id}/appeal`, { text: 'Я не парковалась на газоне, это был другой автомобиль.' });
  assert.equal((await admin.get('/api/admin/overview')).counts.pending_fine_appeals, 1);
  await admin.post(`/api/admin/fines/${f2.id}/appeal`, { accept: true, note: 'Ошибка' });
  fines = (await anna.gov.get('/api/gov/fines')).fines;
  assert.equal(fines.find((f) => f.id === f2.id).status, 'cancelled');

  // Штраф 1000 не оплачен: срок — 1 месяц, дальше пени 10% в месяц, через 2 месяца просрочки — арест.
  const due = (await one('SELECT due_month FROM invoices WHERE number = ?', [f1.invoice])).due_month;
  while ((await month()) <= due) await advance({ force: true });
  let inv = await one('SELECT * FROM invoices WHERE number = ?', [f1.invoice]);
  assert.equal(Number(inv.penalty), 100);
  assert.equal(Number(inv.amount), 1100);
  await advance({ force: true });
  inv = await one('SELECT * FROM invoices WHERE number = ?', [f1.invoice]);
  // Арест + взыскание: на счёте 100 000 стартового баланса — штраф списан, арест снят.
  assert.equal(inv.status, 'paid', 'долг взыскан с арестованного счёта');
  const sanctions = await q('SELECT * FROM citizen_sanctions WHERE citizen_id = (SELECT id FROM citizens WHERE passport_no = ?)', [anna.passport]);
  assert.ok(sanctions.some((s) => s.kind === 'arrest'));
  assert.ok(sanctions.every((s) => !s.active), 'после оплаты меры сняты');
  assert.equal((await one('SELECT status FROM accounts WHERE id = ?', [anna.cur.id])).status, 'active');
  await noMoneyFromAir();
});

test('travel ban blocks foreign passport; visas need a foreign passport', async () => {
  const p = await player('poor@test.bf', 'Нищий Должник');
  // Обнулим счёт, чтобы взыскание не прошло.
  await admin.post('/api/admin/emission', { account_id: p.cur.id, amount: -100000, memo: 'Изъятие' });
  await cop.gov.post('/api/gov/work/police/fines', { passport_no: p.passport, text: 'Хулиганство', amount: 500 });
  for (let i = 0; i < 4; i++) await advance({ force: true });
  const taxes = await p.gov.get('/api/gov/taxes');
  assert.ok(taxes.sanctions.some((s) => s.kind === 'travel_ban'));
  assert.ok(taxes.sanctions.some((s) => s.kind === 'arrest'));
  assert.equal((await one('SELECT status FROM accounts WHERE id = ?', [p.cur.id])).status, 'arrested');
  await assert.rejects(p.gov.post('/api/gov/documents/foreign_passport'), /travel_ban/);
  const debtors = await cop.gov.get('/api/gov/work/tax/debtors').catch((e) => e);
  assert.equal(debtors.status, 403, 'должников видит только налоговая');
  await admin.post('/api/admin/emission', { account_id: p.cur.id, amount: 5000, memo: 'Помощь' });
  // С арестованного счёта можно оплатить штраф.
  const inv = (await p.bank.get('/api/bank/state-charges')).invoices[0];
  await p.bank.idem(`/api/bank/invoices/${inv.number}/pay`, { account_id: p.cur.id });
  assert.equal((await p.gov.get('/api/gov/taxes')).sanctions.length, 0);

  const countries = (await anna.gov.get('/api/gov/countries')).countries;
  const svl = countries.find((c) => c.code === 'SVL');
  await assert.rejects(anna.gov.post('/api/gov/documents/visa', { country_id: svl.id }), /no_foreign_passport/);
  await anna.gov.post('/api/gov/documents/foreign_passport');
  let fp = (await anna.gov.get('/api/gov/me')).invoices.find((i) => i.status === 'unpaid' && i.purpose.includes('Загранпаспорт'));
  await anna.bank.idem(`/api/bank/invoices/${fp.number}/pay`, { account_id: anna.cur.id });
  await anna.gov.post('/api/gov/documents/visa', { country_id: svl.id });
  fp = (await anna.gov.get('/api/gov/me')).invoices.find((i) => i.status === 'unpaid' && i.purpose.includes('Виза'));
  assert.equal(fp.amount, 2000);
  await anna.bank.idem(`/api/bank/invoices/${fp.number}/pay`, { account_id: anna.cur.id });
  const docs = (await anna.gov.get('/api/gov/documents')).documents;
  assert.ok(docs.some((d) => d.type === 'foreign_passport' && d.status === 'active'));
  assert.ok(docs.some((d) => d.type === 'visa' && d.data.country_code === 'SVL'));
  await anna.gov.post('/api/gov/documents/driver');
  const dl = (await anna.gov.get('/api/gov/me')).invoices.find((i) => i.status === 'unpaid');
  await anna.bank.idem(`/api/bank/invoices/${dl.number}/pay`, { account_id: anna.cur.id });
  assert.ok((await anna.gov.get('/api/gov/documents')).documents.some((d) => d.type === 'driver'));
});

test('marriage and birth certificates go through an official', async () => {
  const bob = await player('bob@test.bf', 'Боб Женихов');
  await bob.gov.post('/api/gov/documents/marriage', { spouse_passport: anna.passport });
  let inv = (await bob.gov.get('/api/gov/me')).invoices.find((i) => i.status === 'unpaid');
  await bob.bank.idem(`/api/bank/invoices/${inv.number}/pay`, { account_id: bob.cur.id });
  const queue = await admin.get('/api/gov/queue');
  const app1 = queue.applications.find((a) => a.type === 'marriage');
  await admin.post(`/api/gov/applications/${app1.id}/approve`);
  assert.equal((await anna.gov.get('/api/gov/passport')).passport.marital_status, 'married');
  await anna.gov.post('/api/gov/documents/birth', { child_name: 'Соня', child_birth_date: '2020-02-02' });
  const q2 = await admin.get('/api/gov/queue');
  await admin.post(`/api/gov/applications/${q2.applications.find((a) => a.type === 'birth').id}/approve`);
  assert.equal((await anna.gov.get('/api/gov/passport')).passport.children.length, 2);
  inv = null;
});

test('benefits: child benefit approved by official and paid monthly from the budget; gov salaries with NDFL', async () => {
  const r = await anna.gov.post('/api/gov/benefits', { kind: 'child' });
  assert.equal(r.status, 'pending');
  await assert.rejects(anna.gov.post('/api/gov/benefits', { kind: 'pension' }), /too_young/);
  const list = await admin.get('/api/gov/work/benefits');
  await admin.post(`/api/gov/work/benefits/${list.benefits[0].id}/decide`, { approve: true });
  const a0 = await bal(anna.cur.id);
  const c0 = await bal(cop.cur.id);
  const b0 = await budget();
  await advance({ force: true });
  assert.equal(await bal(anna.cur.id), a0 + 2000, '2 ребёнка × 1000');
  assert.equal(await bal(cop.cur.id), c0 + 9000, 'зарплата 10 000 минус НДФЛ 10%');
  assert.equal(await budget(), b0 - 2000 - 9000);
  await noMoneyFromAir();
});

test('IP declaration once a game year: auto income from sales, tax invoice; property tax', async () => {
  const ivan = await player('ivan@test.bf', 'Иван Предприниматель');
  await ivan.gov.post('/api/gov/documents/inn');
  await ivan.gov.post('/api/gov/documents/ip', { trade_name: 'Лавка' });
  const biz = (await ivan.bank.post('/api/bank/accounts', { type: 'business' })).account;
  const shop = (await ivan.bank.post('/api/pos/shops', { name: 'Лавка Ивана', account_id: biz.id, pin: '1234' })).shop;
  await ivan.bank.post('/api/pos/login', { shop_id: shop.id, pin: '1234' });
  await ivan.bank.post('/api/pos/shifts/open', {});
  const prod = (await ivan.bank.post('/api/pos/products', { name: 'Пирог', price: 12000, stock_milli: 10000 })).product;
  const sale = (await ivan.bank.post('/api/pos/sales', { items: [{ product_id: prod.id, qty_milli: 1000 }] })).sale;
  await ivan.bank.post(`/api/pos/sales/${sale.id}/pay`, { method: 'cash', amount: 12000 });
  await ivan.bank.post('/api/pos/shifts/z', {});
  // Имущество Ивана — для налога на имущество.
  await admin.post('/api/admin/properties', { kind: 'realty', title: 'Дом у реки', value: 500000, owner_passport: ivan.passport });

  while ((await month()) % 12 !== 11) await advance({ force: true });
  await advance({ force: true });
  const taxes = await ivan.gov.get('/api/gov/taxes');
  const decl = taxes.declarations[0];
  assert.equal(decl.status, 'draft');
  assert.equal(decl.income_auto, 10000, 'выручка 12 000 без НДС 20%');
  assert.ok(taxes.invoices.some((i) => i.purpose.startsWith('Налог на имущество') && i.amount === 5000));
  await assert.rejects(ivan.gov.post(`/api/gov/taxes/declarations/${decl.id}/submit`, { income: 5000 }), /income_low/);
  const r = await ivan.gov.post(`/api/gov/taxes/declarations/${decl.id}/submit`, { income: 10000 });
  assert.equal(r.tax, 600);
  const inv = (await ivan.gov.get('/api/gov/taxes')).invoices.find((i) => i.purpose.startsWith('Налог ИП'));
  await ivan.bank.idem(`/api/bank/invoices/${inv.number}/pay`, { account_id: ivan.cur.id });
  assert.equal((await ivan.gov.get('/api/gov/taxes')).declarations[0].status, 'paid');
});

test('property: state lot bought with a mortgage, lien until repaid; private sale paid in bank', async () => {
  const r = await admin.post('/api/admin/properties', { kind: 'realty', title: 'Квартира в центре', value: 200000, list_price: 200000 });
  const market = await anna.gov.get('/api/gov/properties/market');
  assert.ok(market.properties.some((p) => p.id === r.id));
  const deal = await anna.gov.post(`/api/gov/properties/${r.id}/buy`);
  await assert.rejects(anna.bank.post(`/api/bank/property-deals/${deal.deal_id}/loan`, { months: 12, down_payment: 10000, account_id: anna.cur.id }), /down_low/);
  const l = await anna.bank.post(`/api/bank/property-deals/${deal.deal_id}/loan`, { months: 12, down_payment: 40000, account_id: anna.cur.id });
  assert.equal(l.loan.kind, 'mortgage');
  assert.equal(l.loan.amount, 160000);
  const b0 = await budget();
  const a0 = await bal(anna.cur.id);
  await admin.post(`/api/admin/loans/${l.loan.id}/decision`, { approve: true });
  assert.equal(await budget(), b0 + 200000, 'государство получило полную цену');
  assert.equal(await bal(anna.cur.id), a0 - 40000, 'с покупателя — только первый взнос');
  let props = (await anna.gov.get('/api/gov/properties')).properties;
  const flat = props.find((p) => p.id === r.id);
  assert.equal(flat.lien_loan_id, l.loan.id);
  await assert.rejects(anna.gov.post(`/api/gov/properties/${r.id}/sell`, { price: 1000 }), /lien/);
  const loan = (await anna.bank.get('/api/bank/credit')).loans.find((x) => x.id === l.loan.id);
  assert.equal(loan.rate_bp, 100, 'ставка ипотеки');
  await admin.post('/api/admin/emission', { account_id: anna.cur.id, amount: 200000, memo: 'Наследство' });
  await anna.bank.post(`/api/bank/loans/${l.loan.id}/repay`, { account_id: anna.cur.id });
  props = (await anna.gov.get('/api/gov/properties')).properties;
  assert.equal(props.find((p) => p.id === r.id).lien_loan_id, null, 'залог снят после погашения');

  // Частная продажа: Анна предлагает квартиру Петру, Пётр платит из банка.
  await anna.gov.post(`/api/gov/properties/${r.id}/sell`, { price: 150000, buyer_passport: cop.passport });
  const pd = (await cop.bank.get('/api/bank/property')).deals[0];
  assert.equal(pd.price, 150000);
  await admin.post('/api/admin/emission', { account_id: cop.cur.id, amount: 150000, memo: 'Сбережения' });
  const a1 = await bal(anna.cur.id);
  await cop.bank.idem(`/api/bank/property-deals/${pd.id}/pay`, { account_id: cop.cur.id });
  assert.equal(await bal(anna.cur.id), a1 + 150000);
  assert.ok((await cop.gov.get('/api/gov/properties')).properties.some((p) => p.id === r.id));
  await noMoneyFromAir();
});

test('doctor: slots, insurance priority, conclusion', async () => {
  const doc = await player('doc@test.bf', 'Доктор Айболит');
  await admin.post('/api/admin/roles', { kind: 'gov', user_id: doc.govId, role: 'doctor', grant: true });
  const start = new Date(Date.now() + 3600_000).toISOString();
  await doc.gov.post('/api/gov/work/doctor/slots', { starts_at: start, duration_min: 20, count: 2 });
  await doc.gov.post('/api/gov/work/doctor/slots', { starts_at: new Date(Date.now() + 7200_000).toISOString(), priority: true });
  let d = await anna.gov.get('/api/gov/doctor');
  assert.equal(d.free.length, 3);
  const prio = d.free.find((s) => s.priority);
  await assert.rejects(anna.gov.post(`/api/gov/doctor/slots/${prio.id}/book`, {}), /need_insurance/);
  const ins = await anna.gov.post('/api/gov/insurance');
  await anna.bank.idem(`/api/bank/invoices/${ins.invoice}/pay`, { account_id: anna.cur.id });
  d = await anna.gov.get('/api/gov/doctor');
  assert.equal(d.insured, true);
  await anna.gov.post(`/api/gov/doctor/slots/${prio.id}/book`, { complaint: 'Кашель' });
  const mine = await doc.gov.get('/api/gov/work/doctor');
  const booked = mine.slots.find((s) => s.status === 'booked');
  assert.equal(booked.insured, true);
  await doc.gov.post(`/api/gov/work/doctor/slots/${booked.id}/conclude`, { conclusion: 'ОРВИ, покой 2 игровых дня' });
  d = await anna.gov.get('/api/gov/doctor');
  assert.equal(d.visits[0].conclusion, 'ОРВИ, покой 2 игровых дня');
});

test('elections: nominate, vote once, results in news', async () => {
  const e = await admin.post('/api/admin/elections', { title: 'Мэр Влодограда' });
  await anna.gov.post(`/api/gov/elections/${e.id}/nominate`, { program: 'Больше парков и кафе' });
  await cop.gov.post(`/api/gov/elections/${e.id}/nominate`, { program: 'Порядок на улицах' });
  await assert.rejects(anna.gov.post(`/api/gov/elections/${e.id}/vote`, { candidate_id: 1 }), /closed/);
  await admin.post(`/api/admin/elections/${e.id}/status`, { status: 'voting' });
  const el = (await anna.gov.get('/api/gov/elections')).elections.find((x) => x.id === e.id);
  const annaCand = el.candidates.find((c) => c.mine);
  assert.equal(annaCand.votes, undefined, 'до конца выборов голоса скрыты');
  await anna.gov.post(`/api/gov/elections/${e.id}/vote`, { candidate_id: annaCand.id });
  await assert.rejects(anna.gov.post(`/api/gov/elections/${e.id}/vote`, { candidate_id: annaCand.id }), /already_voted/);
  await cop.gov.post(`/api/gov/elections/${e.id}/vote`, { candidate_id: annaCand.id });
  await admin.post(`/api/admin/elections/${e.id}/status`, { status: 'finished' });
  const news = (await client(app).get('/api/gov/news')).news;
  assert.ok(news[0].title.includes('Мэр Влодограда'));
  assert.ok(news[0].body.includes('Победитель: Анна Гражданская'));
});

test('appeals answered by staff; news by admin; budget overview', async () => {
  const ap = await anna.gov.post('/api/gov/appeals', { addressee: 'police', subject: 'Шумные соседи', body: 'Соседи шумят каждую ночь, примите меры.' });
  const list = await cop.gov.get('/api/gov/work/appeals');
  assert.ok(list.appeals.some((a) => a.id === ap.id));
  await cop.gov.post(`/api/gov/work/appeals/${ap.id}/answer`, { answer: 'Наряд направлен.' });
  assert.equal((await anna.gov.get('/api/gov/appeals')).appeals[0].status, 'answered');
  await admin.post('/api/admin/news', { kind: 'decree', title: 'Указ №1', body: 'Объявить день кафе.' });
  const b = await admin.get('/api/admin/budget?days=30');
  assert.ok(b.by_kind.some((k) => k.kind === 'benefit'));
  assert.ok(b.by_kind.some((k) => k.kind === 'gov_salary'));
  assert.equal(b.balance, await budget());
});
