// Этап Н5: DNSSEC — подписанные инфраструктурные зоны, цепочка доверия от якоря корня, AD у резолвера,
// NSEC для NXDOMAIN/NODATA, домен игрока без подписи (insecure), включение (secure), поломка DS (bogus → SERVFAIL).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { setup, client, pool, q } from './helpers.js';

let app;
let clock;
let now = 20000;
let dns;
before(async () => {
  app = await setup();
  clock = await import('../src/lib/clock.js');
  clock.setGameTimeOverride(() => now);
  dns = await import('../src/lib/dns.js');
  dns.flushResolverCache();
});
after(async () => {
  clock.setGameTimeOverride(null);
  await app.close();
  await pool.end();
});

const DEV = 'device-dnssec-01';
let dev;
let boris;
let dom;

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
  return { gov, bank, cur };
}
const resolve = (name, type = 'A', extra = {}) => dev.post('/api/net/resolve', { client_id: DEV, name, type, ...extra });
const dig = (server, name, type, extra = {}) => dev.post('/api/net/query', { client_id: DEV, server, name, type, recurse: false, dnssec: true, ...extra });

test('setup', async () => {
  const admin = client(app);
  await admin.post('/api/auth/gov/register', { email: 'admin@test.bf', password: 'password123', display_name: 'Админ' });
  await admin.patch('/api/admin/settings', { fraud_threshold: 0, fraud_velocity: 0, fraud_multiplier: 0, start_balance: 200000, transfer_fee_bp: 0, transfer_fee_min: 0 });
  dev = client(app);
  await dev.post('/api/net/lease', { client_id: DEV, provider: 'baltelecom' });
  boris = await player('boris@test.bf', 'Борис');
  const r = await boris.gov.post('/api/gov/domains', { name: 'boris.bln' });
  await boris.bank.post(`/api/bank/invoices/${r.invoice}/pay`, { account_id: boris.cur.id });
  dom = (await boris.gov.get('/api/gov/domains')).domains[0];
  await boris.gov.post(`/api/gov/domains/${dom.id}/records`, { name: '@', type: 'A', data: '50.1.0.30' });
  await boris.gov.post(`/api/gov/domains/${dom.id}/records`, { name: '*.shop', type: 'A', data: '50.1.0.31' });
});

test('госзоны подписаны: AD, DS у родителя, DNSKEY и RRSIG у сервера', async () => {
  const r = await resolve('bank.bln');
  assert.equal(r.rcode, 'NOERROR');
  assert.equal(r.ad, true);
  assert.equal(r.dnssec, 'secure');
  assert.ok(r.trace.some((t) => t.dnssec && t.qtype === 'DNSKEY'), 'резолвер проверял ключи');
  assert.ok(!r.answer.some((x) => x.type === 'RRSIG'), 'без DO подписи клиенту не отдаются');
  const withDo = await resolve('bank.bln', 'A', { dnssec: true });
  assert.ok(withDo.answer.some((x) => x.type === 'RRSIG' && x.data.startsWith('A 13 2 ')));

  const ds = await resolve('gov.bln', 'DS');
  assert.equal(ds.ad, true);
  assert.match(ds.answer[0].data, /^\d+ 13 2 [0-9a-f]{64}$/);
  const key = await dig('50.0.3.10', 'gov.bln', 'DNSKEY');
  assert.match(key.answer[0].data, /^257 3 13 /);
  assert.ok(key.answer.some((x) => x.type === 'RRSIG'));
  // Делегирование из bln. в домен игрока: NS не подписаны, DS нет — доказано NSEC.
  const ref = await dig('50.0.1.10', 'boris.bln', 'A');
  assert.ok(ref.authority.some((x) => x.type === 'NSEC' && x.name === 'boris.bln.' && !/\bDS\b/.test(x.data)), JSON.stringify(ref.authority));
});

test('NXDOMAIN и NODATA доказаны NSEC и тоже «secure»', async () => {
  const nx = await resolve('nope-nope.gov.bln', 'A', { dnssec: true });
  assert.equal(nx.rcode, 'NXDOMAIN');
  assert.equal(nx.ad, true);
  assert.ok(nx.authority.some((x) => x.type === 'NSEC'));
  const nodata = await resolve('bank.bln', 'MX');
  assert.equal(nodata.rcode, 'NOERROR');
  assert.equal(nodata.answer.length, 0);
  assert.equal(nodata.ad, true);
});

test('домен игрока без DNSSEC — insecure; включение — secure, шаблон «*.» тоже', async () => {
  const r = await resolve('boris.bln');
  assert.equal(r.answer[0].data, '50.1.0.30');
  assert.equal(r.ad, false);
  assert.equal(r.dnssec, 'insecure');

  await boris.gov.post(`/api/gov/domains/${dom.id}/dnssec`, { enabled: true });
  const view = (await boris.gov.get(`/api/gov/domains/${dom.id}`)).domain;
  assert.equal(view.dnssec.signed, true);
  assert.equal(view.dnssec.ds.length, 1);
  dns.flushResolverCache();
  const s = await resolve('boris.bln');
  assert.equal(s.dnssec, 'secure');
  const w = await resolve('x.shop.boris.bln', 'A', { dnssec: true });
  assert.equal(w.answer[0].data, '50.1.0.31');
  assert.equal(w.dnssec, 'secure');
  assert.ok(w.answer.some((x) => x.type === 'RRSIG' && x.data.startsWith('A 13 3 ')), 'подпись шаблона: 3 метки');
});

test('неверный DS у родителя — bogus: резолвер отвечает SERVFAIL; dig +cd отключает проверку', async () => {
  await q("UPDATE dns_records SET data = CONCAT(SUBSTRING_INDEX(data, ' ', 3), ' ', REPEAT('a', 64)) WHERE domain_id = ? AND type = 'DS'", [dom.id]);
  (await import('../src/lib/net.js')).invalidateNet();
  dns.flushResolverCache();
  const r = await resolve('boris.bln');
  assert.equal(r.rcode, 'SERVFAIL');
  assert.match(r.ede, /DNSSEC Bogus: DNSKEY зоны boris\.bln\. не совпадает с DS/);
  const o = await dev.post('/api/net/open', { client_id: DEV, url: 'http://boris.bln/' });
  assert.equal(o.code, 'ERR_NAME_RESOLUTION_FAILED');
  const cd = await resolve('boris.bln', 'A', { cd: true });
  assert.equal(cd.answer[0].data, '50.1.0.30');

  // Выключили DNSSEC: резолверы живут по кэшу (DS, ключ, подписанные записи) до конца TTL, потом — insecure.
  await boris.gov.post(`/api/gov/domains/${dom.id}/dnssec`, { enabled: true });
  dns.flushResolverCache();
  assert.equal((await resolve('boris.bln')).dnssec, 'secure');
  await boris.gov.post(`/api/gov/domains/${dom.id}/dnssec`, { enabled: false });
  assert.equal((await resolve('boris.bln')).dnssec, 'secure', 'пока всё из кэша');
  now += 3700;
  const later = await resolve('boris.bln');
  assert.equal(later.rcode, 'NOERROR');
  assert.equal(later.dnssec, 'insecure');
});
