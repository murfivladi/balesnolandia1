// API для сайтов: токен гражданина bln_… с правами; сервер сайта по сети БалНета (как fetch из server.js)
// управляет доменами, DNS, хостингом, новостями и платит счета; без прав, без токена и к админке — отказ.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setup, client, pool } from './helpers.js';

let app;
let clock;
before(async () => {
  app = await setup();
  clock = await import('../src/lib/clock.js');
  clock.setGameTimeOverride(() => 90000);
  (await import('../src/lib/dns.js')).flushResolverCache();
});
after(async () => {
  clock.setGameTimeOverride(null);
  await fs.rm(process.env.BALNET_SITES_DIR, { recursive: true, force: true });
  await app.close();
  await pool.end();
});

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

test('сервер сайта работает с доменами, хостингом, новостями и оплатой через API по токену', async () => {
  const { netRequest } = await import('../src/lib/vhost/respond.js');
  const admin = client(app);
  await admin.post('/api/auth/gov/register', { email: 'admin@test.bf', password: 'password123', display_name: 'Админ' });
  await admin.patch('/api/admin/settings', { fraud_threshold: 0, fraud_velocity: 0, fraud_multiplier: 0, start_balance: 200000, transfer_fee_bp: 0, transfer_fee_min: 0, vat_bp: 0 });
  const boris = await player('boris@test.bf', 'Борис');
  const plan = await admin.post('/api/admin/net/hosting/plans', { server_id: 1, name: 'Тест', disk_mb: 5, max_sites: 3, price_month: 0 });
  const d = await boris.gov.post('/api/gov/domains', { name: 'boris.bln' });
  await boris.bank.post(`/api/bank/invoices/${d.invoice}/pay`, { account_id: boris.cur.id });
  const acc = await boris.gov.post('/api/gov/hosting', { plan_id: plan.id, months: 3 });
  const site = await boris.gov.post(`/api/gov/hosting/${acc.account_id}/sites`, { host: 'boris.bln' });

  const meta = await boris.gov.get('/api/gov/api-tokens');
  assert.ok(meta.scopes.domains && meta.scopes.pay);
  await assert.rejects(boris.gov.post('/api/gov/api-tokens', { name: 'пусто', scopes: [] }), /право/);
  const tk = await boris.gov.post('/api/gov/api-tokens', { name: 'Сервер сайта', scopes: ['domains', 'hosting', 'news', 'pay'] });
  assert.match(tk.token, /^bln_/);
  const H = { authorization: `Bearer ${tk.token}`, 'content-type': 'application/json' };
  const call = async (method, url, body) => {
    const r = await netRequest({ fromIp: site.ip, url, method, headers: H, body: body ? JSON.stringify(body) : null });
    assert.ok(!r.error, r.error);
    return { status: r.status, json: JSON.parse(r.body || 'null') };
  };

  // Домены и DNS — с любого госсайта, например reg.bln.
  let r = await call('GET', 'https://reg.bln/api/gov/domains');
  assert.equal(r.status, 200);
  const dom = r.json.domains.find((x) => x.name.startsWith('boris.bln'));
  r = await call('POST', `https://reg.bln/api/gov/domains/${dom.id}/records`, { name: '@', type: 'A', data: site.ip });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  // Покупка ещё одного домена и оплата счёта через банк по тому же токену.
  r = await call('POST', 'https://reg.bln/api/gov/domains', { name: 'pirozhki.bln' });
  assert.equal(r.status, 200, JSON.stringify(r.json));
  const accs = await call('GET', 'https://bank.bln/api/bank/accounts');
  const curId = accs.json.accounts.find((a) => a.type === 'current').id;
  const paid = await call('POST', `https://bank.bln/api/bank/invoices/${r.json.invoice}/pay`, { account_id: curId });
  assert.equal(paid.status, 200, JSON.stringify(paid.json));
  assert.ok((await boris.gov.get('/api/gov/domains')).domains.some((x) => x.name.startsWith('pirozhki.bln')));
  // Хостинг и новости.
  r = await call('GET', 'https://hosting.bln/api/gov/hosting');
  assert.equal(r.status, 200);
  r = await call('POST', 'https://novosti.bln/api/news/outlets', { slug: 'boris-news', title: 'Новости Бориса' });
  assert.equal(r.status, 200, JSON.stringify(r.json));

  // Без нужного права, без токена, к админке и к самим токенам — отказ.
  assert.equal((await call('GET', 'https://ca.gov.bln/api/gov/certs')).status, 401);
  assert.match((await netRequest({ fromIp: site.ip, url: 'https://gosuslugi.gov.bln/api/admin/overview', headers: H })).error, /ERR_GOV_SITE/);
  assert.equal((await call('GET', 'https://gosuslugi.gov.bln/api/gov/api-tokens')).status, 401);
  const anon = await netRequest({ fromIp: site.ip, url: 'https://reg.bln/api/gov/domains' });
  assert.equal(anon.status, 401);
  const http = await netRequest({ fromIp: site.ip, url: 'http://reg.bln/api/gov/domains', headers: H });
  assert.equal(http.status, 400, 'только https');
  // Тот же токен — из настоящего интернета.
  const inet = await app.inject({ method: 'GET', url: '/api/gov/hosting', headers: { authorization: H.authorization } });
  assert.equal(inet.statusCode, 200);

  await boris.gov.delete(`/api/gov/api-tokens/${tk.id}`);
  assert.equal((await call('GET', 'https://reg.bln/api/gov/domains')).status, 401);
});
