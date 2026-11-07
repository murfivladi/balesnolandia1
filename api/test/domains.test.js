// Этап Н3: организации, лицензии, регистраторы, домены (покупка, DNS, продление, истечение, аукцион, передача).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { setup, client, pool, q, one, totalBalance } from './helpers.js';

let app;
let advance;
let gameNow = 5000;
let clock;
before(async () => {
  app = await setup();
  clock = await import('../src/lib/clock.js');
  ({ advance } = clock);
  clock.setGameTimeOverride(() => gameNow);
  (await import('../src/lib/dns.js')).flushResolverCache();
});
after(async () => { clock.setGameTimeOverride(null); await app.close(); await pool.end(); });

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
  return { gov, bank, cur, passport: me.passport.number, govId: (await one('SELECT id FROM gov_users WHERE email = ?', [email])).id };
}

const bal = async (id) => Number((await one('SELECT balance FROM accounts WHERE id = ?', [id])).balance);
const budget = async () => Number((await one("SELECT balance FROM accounts WHERE system_code = 'BUDGET'")).balance);
const pay = (p, number) => p.bank.post(`/api/bank/invoices/${number}/pay`, { account_id: p.cur.id });
const month = async () => (await one('SELECT month_index FROM game_clock WHERE id = 1')).month_index;
const DEV = 'device-dom-0001';

let admin;
let anna; // будущий регистратор
let boris; // покупатель
let vera;
let regOrg;
let devClient;

async function resolve(name, type = 'A') {
  (await import('../src/lib/dns.js')).flushResolverCache();
  return devClient.post('/api/net/resolve', { client_id: DEV, name, type });
}

test('setup', async () => {
  admin = client(app);
  await admin.post('/api/auth/gov/register', { email: 'admin@test.bf', password: 'password123', display_name: 'Админ' });
  await admin.patch('/api/admin/settings', { fraud_threshold: 0, fraud_velocity: 0, fraud_multiplier: 0, start_balance: 100000, fee_org: 1000, fee_license: 500, vat_bp: 2000, inflation_bp: 0 });
  anna = await player('anna@test.bf', 'Анна Регистраторова');
  boris = await player('boris@test.bf', 'Борис Покупатель');
  vera = await player('vera@test.bf', 'Вера Наследница');
  devClient = client(app);
  await devClient.post('/api/net/lease', { client_id: DEV, provider: 'baltelecom' });
});

test('организация: ИНН, пошлина, счёт; лицензия регистратора с одобрением', async () => {
  await assert.rejects(anna.gov.post('/api/gov/orgs/apply', { kind: 'llc', name: 'ДоменКо' }), /no_inn/);
  await anna.gov.post('/api/gov/documents/inn');
  const a = await anna.gov.post('/api/gov/orgs/apply', { kind: 'llc', name: 'ДоменКо' });
  assert.equal(a.application.status, 'awaiting_payment');
  const inv = (await anna.gov.get('/api/gov/invoices')).invoices.find((i) => i.purpose.includes('организации'));
  await pay(anna, inv.number);
  const orgs = (await anna.gov.get('/api/gov/orgs')).orgs;
  assert.equal(orgs.length, 1);
  regOrg = orgs[0];
  assert.equal(regOrg.role, 'director');
  assert.match(regOrg.inn, /^\d{12}$/);
  const card = await anna.gov.get(`/api/gov/orgs/${regOrg.id}`);
  assert.equal(card.org.account.balance, 0);
  assert.equal(card.is_registrar, false);

  await assert.rejects(boris.gov.get(`/api/gov/orgs/${regOrg.id}`), /forbidden/);
  await assert.rejects(anna.gov.post(`/api/gov/orgs/${regOrg.id}/licenses`, { kind: 'registry' }), /администрация/);
  await anna.gov.post(`/api/gov/orgs/${regOrg.id}/licenses`, { kind: 'registrar' });
  const linv = (await anna.gov.get('/api/gov/invoices')).invoices.find((i) => i.purpose.includes('Лицензия') && i.status === 'unpaid');
  await pay(anna, linv.number);
  const queue = (await admin.get('/api/gov/queue')).applications;
  const app1 = queue.find((x) => x.type === 'license');
  await admin.post(`/api/gov/applications/${app1.id}/approve`);
  const card2 = await anna.gov.get(`/api/gov/orgs/${regOrg.id}`);
  assert.equal(card2.is_registrar, true);
  assert.equal(card2.licenses[0].kind, 'registrar');
  const bln = card2.registrar_tlds.find((t) => t.name === 'bln');
  assert.equal(bln.wholesale, 5000);
  assert.equal(bln.min_price, 6000, 'опт 50 В + НДС 20%');
  await assert.rejects(anna.gov.put(`/api/gov/orgs/${regOrg.id}/prices`, { tld_id: bln.id, price: 5900 }), /price_below_wholesale/);
  await anna.gov.put(`/api/gov/orgs/${regOrg.id}/prices`, { tld_id: bln.id, price: 7200 });
});

let borisDomain;
test('покупка домена у регистратора: деньги делятся, DNS работает', async () => {
  const chk = await boris.gov.get('/api/gov/domains/check?name=Boris.bln');
  assert.equal(chk.free, true);
  assert.deepEqual(chk.offers.map((o) => o.price), [6000, 7200]);
  const taken = await boris.gov.get('/api/gov/domains/check?name=bank.bln');
  assert.equal(taken.free, false);
  await assert.rejects(boris.gov.get('/api/gov/domains/check?name=a.b.bln'), /third_level/);
  await assert.rejects(boris.gov.get('/api/gov/domains/check?name=x.zzz'), /no_tld/);
  await assert.rejects(boris.gov.post('/api/gov/domains', { name: 'my.gov.bln' }), /госучреждения/);

  const before = { total: await totalBalance(), budget: await budget(), boris: await bal(boris.cur.id), reg: await bal(regOrg.id && (await one('SELECT account_id FROM organizations WHERE id = ?', [regOrg.id])).account_id) };
  const r = await boris.gov.post('/api/gov/domains', { name: 'boris.bln', registrar_org_id: regOrg.id, years: 2 });
  assert.equal(r.amount, 14400);
  await assert.rejects(vera.gov.post('/api/gov/domains', { name: 'boris.bln' }), /taken/);
  let list = (await boris.gov.get('/api/gov/domains')).domains;
  assert.equal(list[0].status, 'reserved');
  assert.equal((await resolve('boris.bln')).rcode, 'NXDOMAIN', 'до оплаты домена в DNS нет');
  await pay(boris, r.invoice);
  list = (await boris.gov.get('/api/gov/domains')).domains;
  borisDomain = list[0];
  assert.equal(borisDomain.status, 'active');
  assert.equal(borisDomain.expires_month, (await month()) + 24);
  assert.equal(borisDomain.registrar, 'ДоменКо');
  const regAcc = (await one('SELECT account_id FROM organizations WHERE id = ?', [regOrg.id])).account_id;
  // 14 400: НДС 2 400 и опт 10 000 — в бюджет (реестр .bln ведёт Координационный центр), регистратору 2 000.
  assert.equal(await bal(boris.cur.id), before.boris - 14400);
  assert.equal(await bal(regAcc), before.reg + 2000);
  assert.equal(await budget(), before.budget + 12400);
  assert.equal(await totalBalance(), before.total);

  const ns = await resolve('boris.bln', 'NS');
  assert.deepEqual(ns.answer.map((x) => x.data).sort(), ['ns1.dns.bln.', 'ns2.dns.bln.']);
  assert.equal((await resolve('boris.bln')).rcode, 'NOERROR');
  const d = await boris.gov.get(`/api/gov/domains/${borisDomain.id}`);
  assert.ok(d.records.some((x) => x.type === 'SOA' && x.locked));
  await boris.gov.post(`/api/gov/domains/${borisDomain.id}/records`, { name: '@', type: 'A', data: '50.1.0.20', ttl: 300 });
  await boris.gov.post(`/api/gov/domains/${borisDomain.id}/records`, { name: 'www', type: 'CNAME', data: 'boris.bln' });
  await assert.rejects(boris.gov.post(`/api/gov/domains/${borisDomain.id}/records`, { name: '@', type: 'NS', data: 'evil.bln' }), /DNS-хостинг/);
  await assert.rejects(vera.gov.post(`/api/gov/domains/${borisDomain.id}/records`, { name: 'x', type: 'A', data: '1.2.3.4' }), /forbidden/);
  const a = await resolve('www.boris.bln');
  assert.deepEqual(a.answer.map((x) => `${x.type} ${x.data}`), ['CNAME boris.bln.', 'A 50.1.0.20']);
  assert.deepEqual(a.trace.filter((t) => !t.dnssec).map((t) => t.server_name), ['a.root.bln.', 'a.nic.bln.', 'ns1.dns.bln.']);

  const w = await devClient.get('/api/net/whois?q=boris.bln');
  assert.equal(w.registrar, 'ДоменКо');
  assert.equal(w.owner, 'Борис Покупатель');
  await boris.gov.post(`/api/gov/domains/${borisDomain.id}/privacy`, { privacy: true });
  assert.match((await devClient.get('/api/net/whois?q=boris.bln')).owner, /Скрыто/);
});

test('свои серверы имён с glue', async () => {
  await assert.rejects(boris.gov.post(`/api/gov/domains/${borisDomain.id}/nameservers`, { mode: 'custom', ns: [{ name: 'ns1.boris.bln' }] }), /glue/);
  await boris.gov.post(`/api/gov/domains/${borisDomain.id}/nameservers`, { mode: 'custom', ns: [{ name: 'ns1.boris.bln', ip: '50.0.3.10' }] });
  const r = await resolve('boris.bln', 'NS');
  assert.equal(r.rcode, 'SERVFAIL', 'ns1.gov.bln не обслуживает зону boris.bln — делегирование «хромое»');
  await boris.gov.post(`/api/gov/domains/${borisDomain.id}/nameservers`, { mode: 'hosted' });
  assert.equal((await resolve('boris.bln')).answer[0].data, '50.1.0.20');
});

test('передача владельцу по коду и перенос регистратора', async () => {
  const d = (await boris.gov.get(`/api/gov/domains/${borisDomain.id}`)).domain;
  await assert.rejects(vera.gov.post('/api/gov/domains/claim', { name: 'boris.bln', auth_code: 'wrong' }), /bad_auth_code/);
  await vera.gov.post('/api/gov/domains/claim', { name: 'boris.bln', auth_code: d.auth_code });
  assert.equal((await boris.gov.get('/api/gov/domains')).domains.length, 0);
  const vd = (await vera.gov.get(`/api/gov/domains/${borisDomain.id}`)).domain;
  assert.notEqual(vd.auth_code, d.auth_code, 'код после передачи сменился');
  assert.equal(vd.privacy, false);
  // Перенос к Госрегистратору: год по его цене.
  const t = await vera.gov.post(`/api/gov/domains/${borisDomain.id}/transfer-registrar`, { registrar_org_id: null, auth_code: vd.auth_code });
  const before = vd.expires_month;
  await pay(vera, t.invoice);
  const after2 = (await vera.gov.get(`/api/gov/domains/${borisDomain.id}`)).domain;
  assert.equal(after2.registrar, 'Госрегистратор БалНета');
  assert.equal(after2.expires_month, before + 12);
});

test('истечение → льготный период → восстановление → освобождение → аукцион', async () => {
  const r = await boris.gov.post('/api/gov/domains', { name: 'short.bln', years: 1 });
  await pay(boris, r.invoice);
  const id = (await boris.gov.get('/api/gov/domains')).domains.find((x) => x.name === 'short.bln').id;
  await boris.gov.post(`/api/gov/domains/${id}/records`, { name: '@', type: 'A', data: '50.1.0.10' });
  for (let i = 0; i < 12; i++) await advance({ force: true });
  let d = (await boris.gov.get(`/api/gov/domains/${id}`)).domain;
  assert.equal(d.status, 'expired');
  assert.equal((await resolve('short.bln')).rcode, 'NXDOMAIN', 'делегирование снято — сайт не открывается');
  // Продление в льготный период по обычной цене возвращает домен.
  const rn = await boris.gov.post(`/api/gov/domains/${id}/renew`, { years: 1 });
  await pay(boris, rn.invoice);
  d = (await boris.gov.get(`/api/gov/domains/${id}`)).domain;
  assert.equal(d.status, 'active');
  assert.equal((await resolve('short.bln')).answer[0].data, '50.1.0.10', 'зона сохранилась');

  for (let i = 0; i < 12; i++) await advance({ force: true });
  await advance({ force: true });
  d = (await boris.gov.get(`/api/gov/domains/${id}`)).domain;
  assert.equal(d.status, 'redemption');
  await advance({ force: true });
  assert.equal((await boris.gov.get('/api/gov/domains')).domains.some((x) => x.name === 'short.bln'), false, 'домен освобождён');
  const chk = await vera.gov.get('/api/gov/domains/check?name=short.bln');
  assert.equal(chk.free, false);
  assert.ok(chk.auction_id, 'имя ушло на аукцион');

  const auc = (await vera.gov.get('/api/gov/domains')).auctions.find((a) => a.name === 'short.bln');
  await assert.rejects(vera.gov.post(`/api/gov/auctions/${auc.id}/bid`, { amount: 100 }), /bid_too_low/);
  await vera.gov.post(`/api/gov/auctions/${auc.id}/bid`, { amount: 8000 });
  await anna.gov.post(`/api/gov/auctions/${auc.id}/bid`, { amount: 9000 });
  await vera.gov.post(`/api/gov/auctions/${auc.id}/bid`, { amount: 9500 });
  await advance({ force: true });
  const inv = (await vera.gov.get('/api/gov/invoices')).invoices.find((i) => i.purpose.includes('аукционе') && i.status === 'unpaid');
  assert.equal(inv.amount, 9500);
  const b0 = await budget();
  await pay(vera, inv.number);
  assert.equal(await budget(), b0 + 9500);
  const mine = (await vera.gov.get('/api/gov/domains')).domains.find((x) => x.name === 'short.bln');
  assert.equal(mine.status, 'active');
  assert.equal((await resolve('short.bln', 'SOA')).rcode, 'NOERROR', 'новая зона на хостинге');
  assert.equal((await resolve('short.bln')).answer.length, 0, 'старые записи прежнего владельца удалены');
});

test('неоплаченный резерв снимается', async () => {
  await boris.gov.post('/api/gov/domains', { name: 'unpaid.vlod' });
  assert.equal((await vera.gov.get('/api/gov/domains/check?name=unpaid.vlod')).free, false);
  await advance({ force: true });
  assert.equal((await vera.gov.get('/api/gov/domains/check?name=unpaid.vlod')).free, true);
});

test('госучреждение регистрирует домен в gov.bln; админ: реестр зоны и споры', async () => {
  const gov = await admin.post('/api/admin/net/orgs', { kind: 'gov', name: 'Минцифры БФ', director_passport: anna.passport });
  await anna.gov.post('/api/gov/domains', { name: 'digital.gov.bln', owner_org_id: gov.id });
  const dd = (await anna.gov.get('/api/gov/domains')).domains.find((x) => x.name === 'digital.gov.bln');
  assert.equal(dd.status, 'active', 'в зоне gov.bln регистрация бесплатная — сразу работает');
  const ns = await resolve('digital.gov.bln', 'NS');
  assert.ok(ns.answer.some((x) => x.data === 'ns1.dns.bln.'));

  // Лицензия регистратора (24 игровых месяца) истекла, пока шли месяцы прошлого теста. Без неё регистратор не продаёт.
  assert.equal((await anna.gov.get(`/api/gov/orgs/${regOrg.id}`)).is_registrar, false);
  await admin.post('/api/admin/net/licenses', { org_id: regOrg.id, kind: 'registrar' });
  const reg = await admin.get('/api/admin/net/registry');
  const vlod = reg.tlds.find((t) => t.name === 'vlod');
  await admin.patch(`/api/admin/net/tlds/${vlod.id}`, { registry_org_id: regOrg.id });
  const lic = (await anna.gov.get(`/api/gov/orgs/${regOrg.id}`)).licenses.map((l) => l.kind);
  assert.ok(lic.includes('registry'), 'реестру выдана лицензия');
  await anna.gov.put(`/api/gov/orgs/${regOrg.id}/registry/${vlod.id}`, { wholesale_price: 2000 });
  const regAcc = (await one('SELECT account_id FROM organizations WHERE id = ?', [regOrg.id])).account_id;
  const before = await bal(regAcc);
  const r = await vera.gov.post('/api/gov/domains', { name: 'vera.vlod' });
  await pay(vera, r.invoice);
  assert.equal(await bal(regAcc), before, 'у Госрегистратора всё уходит в бюджет');
  await anna.gov.put(`/api/gov/orgs/${regOrg.id}/prices`, { tld_id: vlod.id, price: 3000 });
  const r2 = await vera.gov.post('/api/gov/domains', { name: 'vera2.vlod', registrar_org_id: regOrg.id });
  await pay(vera, r2.invoice);
  // 3000: НДС 500, опт 2000 — реестру (ДоменКо), регистратору (тоже ДоменКо) 500.
  assert.equal(await bal(regAcc), before + 2500);

  const vd = (await vera.gov.get('/api/gov/domains')).domains.find((x) => x.name === 'vera.vlod');
  await admin.post(`/api/admin/net/domains/${vd.id}/owner`, { passport: boris.passport, reason: 'Решение по спору о товарном знаке' });
  assert.ok((await boris.gov.get('/api/gov/domains')).domains.some((x) => x.name === 'vera.vlod'));
  await admin.post(`/api/admin/net/domains/${vd.id}/seize`, { reason: 'Фишинг' });
  assert.equal((await resolve('vera.vlod')).rcode, 'NXDOMAIN');
  await admin.post('/api/admin/net/auctions', { name: 'top.bln', min_bid: 50000 });
  assert.equal((await boris.gov.get('/api/gov/domains/check?name=top.bln')).free, false);
});

test('директор переводит деньги со счёта организации; сотрудники', async () => {
  const regAcc = (await one('SELECT account_id FROM organizations WHERE id = ?', [regOrg.id])).account_id;
  const have = await bal(regAcc);
  await anna.gov.post(`/api/gov/orgs/${regOrg.id}/members`, { passport: boris.passport });
  await assert.rejects(boris.gov.post(`/api/gov/orgs/${regOrg.id}/transfer`, { to: anna.cur.number, amount: 100 }), /директор/);
  assert.equal((await boris.gov.get(`/api/gov/orgs/${regOrg.id}`)).org.role, 'staff');
  const before = await bal(anna.cur.id);
  await anna.gov.post(`/api/gov/orgs/${regOrg.id}/transfer`, { to: anna.cur.number, amount: have });
  assert.equal(await bal(anna.cur.id), before + have);
  assert.equal(await bal(regAcc), 0);
  await assert.rejects(anna.gov.post(`/api/gov/orgs/${regOrg.id}/transfer`, { to: anna.cur.number, amount: 1 }), /insufficient_funds/);
  assert.equal(await totalBalance(), 0, 'сумма всех счетов = 0');
});

test('сброс игры убирает DNS доменов игроков, а сеть и зоны TLD остаются', async () => {
  await admin.post('/api/admin/reset', { confirm: 'СБРОС' });
  assert.equal(Number((await one('SELECT COUNT(*) AS n FROM domains')).n), 0);
  assert.equal(Number((await one('SELECT COUNT(*) AS n FROM dns_records WHERE domain_id IS NOT NULL')).n), 0);
  assert.equal(Number((await one('SELECT COUNT(*) AS n FROM dns_zones WHERE domain_id IS NOT NULL')).n), 0);
  assert.equal(Number((await one('SELECT COUNT(*) AS n FROM tlds WHERE registry_org_id IS NOT NULL')).n), 0);
  assert.ok(Number((await one('SELECT COUNT(*) AS n FROM tlds')).n) >= 6);
  await devClient.post('/api/net/lease', { client_id: DEV, provider: 'baltelecom' });
  assert.equal((await resolve('bank.bln')).rcode, 'NOERROR');
  assert.equal((await resolve('boris.bln')).rcode, 'NXDOMAIN');
  void q;
});
