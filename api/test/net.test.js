// Этап Н2: сеть БалНета — аренда адресов, DNS (корень → TLD → NS), кэш по игровому времени,
// подключение к серверам, ping/traceroute, правка зон в админке, пауза.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { setup, client, pool, q } from './helpers.js';

let app;
let clock;
let admin;
let dev; // устройство абонента БалТелекома
let dev2; // абонент ВлодЛинка
const C1 = 'device-one-0001';
const C2 = 'device-two-0002';
let gameNow = 1000;

before(async () => {
  app = await setup();
  clock = await import('../src/lib/clock.js');
  clock.setGameTimeOverride(() => gameNow);
  (await import('../src/lib/dns.js')).flushResolverCache();
  admin = client(app);
  await admin.post('/api/auth/gov/register', { email: 'admin@test.bf', password: 'password123', display_name: 'Админ' });
  dev = client(app);
  dev2 = client(app);
});
after(async () => { clock.setGameTimeOverride(null); await app.close(); await pool.end(); });

const resolveA = (c, name, extra = {}) => c.post('/api/net/resolve', { client_id: extra.client || C1, name, type: extra.type || 'A', resolver: extra.resolver });

test('провайдеры и аренда адреса', async () => {
  const r = await dev.get('/api/net/providers');
  assert.deepEqual(r.providers.map((p) => p.code), ['baltelecom', 'vlodlink', 'balesno-mobile']);
  assert.deepEqual(r.public_resolvers.map((x) => x.ip), ['50.0.0.53']);
  await assert.rejects(dev.post('/api/net/resolve', { client_id: C1, name: 'bank.bln' }), /no_lease/);
  const l = await dev.post('/api/net/lease', { client_id: C1, provider: 'baltelecom' });
  assert.match(l.ip, /^60\.1\.1\.\d+$/);
  assert.equal(l.resolver_ip, '60.1.0.53');
  assert.equal(l.gateway, '60.1.0.1');
  assert.equal((await dev.post('/api/net/lease', { client_id: C1, provider: 'baltelecom' })).ip, l.ip, 'тот же адрес при повторном подключении');
  const l2 = await dev2.post('/api/net/lease', { client_id: C2, provider: 'vlodlink' });
  assert.match(l2.ip, /^60\.2\.1\.\d+$/);
  await assert.rejects(dev.post('/api/net/lease', { client_id: 'x', provider: 'baltelecom' }), /invalid/);
  await assert.rejects(dev.post('/api/net/lease', { client_id: 'device-xxx-9', provider: 'nope' }), /not_found/);
});

test('резолв идёт корень → TLD → госсерверы, потом из кэша', async () => {
  const r = await resolveA(dev, 'bank.bln');
  assert.equal(r.rcode, 'NOERROR');
  assert.deepEqual(r.answer.map((a) => a.data), ['50.1.0.10']);
  assert.equal(r.cached, false);
  assert.deepEqual(r.trace.map((t) => [t.server_name, t.kind]), [
    ['a.root.bln.', 'referral'], ['a.nic.bln.', 'referral'], ['ns1.gov.bln.', 'answer'],
  ]);
  assert.ok(r.ms > 0);
  const again = await resolveA(dev, 'bank.bln');
  assert.equal(again.cached, true);
  assert.equal(again.trace.length, 0);
  // Соседний домен: NS зоны bln. уже в кэше — корень пропускается, сразу к TLD-серверу.
  const k = await resolveA(dev, 'kassa.bln');
  assert.deepEqual(k.trace.map((t) => t.server_name), ['a.nic.bln.', 'ns1.gov.bln.']);
  // Имя внутри уже известной зоны: сразу к её серверам.
  const w = await resolveA(dev, 'www.bank.bln');
  assert.deepEqual(w.trace.map((t) => t.server_name), ['ns1.gov.bln.']);
});

test('TTL считается в игровых секундах', async () => {
  const first = await resolveA(dev, 'poisk.bln');
  assert.equal(first.answer[0].ttl, 3600);
  gameNow += 600;
  const mid = await resolveA(dev, 'poisk.bln');
  assert.equal(mid.cached, true);
  assert.equal(mid.answer[0].ttl, 3000);
  gameNow += 3001;
  const expired = await resolveA(dev, 'poisk.bln');
  assert.equal(expired.cached, false, 'запись устарела — резолвер снова спрашивает авторитетный сервер');
  assert.equal(expired.trace.at(-1).server_name, 'ns1.gov.bln.');
});

test('CNAME, NXDOMAIN, NODATA, обратная зона', async () => {
  const w = await resolveA(dev, 'www.bank.bln');
  assert.deepEqual(w.answer.map((a) => `${a.type} ${a.data}`), ['CNAME bank.bln.', 'A 50.1.0.10']);
  const nx = await resolveA(dev, 'vasya.bln');
  assert.equal(nx.rcode, 'NXDOMAIN');
  assert.equal(nx.authority[0].type, 'SOA');
  assert.equal(nx.trace.at(-1).server_name, 'a.nic.bln.');
  const nx2 = await resolveA(dev, 'vasya.bln', { type: 'AAAA' });
  assert.equal(nx2.rcode, 'NXDOMAIN');
  assert.equal(nx2.cached, true, 'отрицательный ответ закэширован');
  const nodata = await resolveA(dev, 'bank.bln', { type: 'MX' });
  assert.equal(nodata.rcode, 'NOERROR');
  assert.equal(nodata.answer.length, 0);
  assert.equal(nodata.authority[0].type, 'SOA');
  const six = await resolveA(dev, 'bank.bln', { type: 'AAAA' });
  assert.deepEqual(six.answer.map((a) => a.data), ['ba1:1::10']);
  const ptr = await resolveA(dev, '10.0.1.50.in-addr.arpa', { type: 'PTR' });
  assert.deepEqual(ptr.answer.map((a) => a.data), ['web1.dc.gov.bln.']);
  await assert.rejects(resolveA(dev, 'bad..name'), /invalid_name/);
  await assert.rejects(resolveA(dev, 'bank.bln', { type: 'HINFO' }), /invalid_type/);
});

test('резолверы: чужой провайдер отказывает, публичный работает, не-резолвер молчит', async () => {
  const refused = await resolveA(dev, 'bank.bln', { resolver: '60.2.0.53' });
  assert.equal(refused.rcode, 'REFUSED');
  const pub = await resolveA(dev, 'bank.bln', { resolver: '50.0.0.53' });
  assert.equal(pub.rcode, 'NOERROR');
  assert.equal(pub.resolver.name, 'dns.vlod.');
  const t = await resolveA(dev, 'bank.bln', { resolver: '50.1.0.10' });
  assert.equal(t.rcode, 'TIMEOUT');
  const own = await resolveA(dev2, 'bank.bln', { client: C2 });
  assert.equal(own.rcode, 'NOERROR');
  assert.equal(own.cached, false, 'у каждого резолвера свой кэш');
});

test('dig @сервер без рекурсии', async () => {
  const root = await dev.post('/api/net/query', { client_id: C1, server: '50.0.0.10', name: 'bank.bln', recurse: false });
  assert.equal(root.aa, false);
  assert.deepEqual(root.authority.map((r) => r.data), ['a.nic.bln.', 'b.nic.bln.']);
  assert.deepEqual(root.additional.map((r) => r.data), ['50.0.1.10', '50.0.1.11']);
  const gov = await dev.post('/api/net/query', { client_id: C1, server: '50.0.3.10', name: 'gosuslugi.gov.bln', recurse: false });
  assert.equal(gov.aa, true);
  assert.equal(gov.answer[0].data, '50.1.0.10');
  const refused = await dev.post('/api/net/query', { client_id: C1, server: '50.0.3.10', name: 'shop', recurse: false });
  assert.equal(refused.rcode, 'REFUSED');
});

test('открытие сайта: DNS → подключение → госсайт', async () => {
  const o = await dev.post('/api/net/open', { client_id: C1, url: 'https://bank.bln/cards' });
  assert.equal(o.ok, true);
  assert.equal(o.ip, '50.1.0.10');
  assert.equal(o.target, 'app:bank');
  assert.equal(o.gov, true);
  assert.equal(o.server, 'web1.dc.gov.bln.');
  const s = await dev.post('/api/net/open', { client_id: C1, url: 'https://poisk.bln/?q=1' });
  assert.equal(s.target, 'poisk');
  const nx = await dev.post('/api/net/open', { client_id: C1, url: 'https://vasya.bln/' });
  assert.equal(nx.ok, false);
  assert.equal(nx.code, 'DNS_PROBE_FINISHED_NXDOMAIN');
  const byIp = await dev.post('/api/net/open', { client_id: C1, url: 'https://50.1.0.10/' });
  assert.equal(byIp.code, 'HTTP_404_NO_VHOST', 'по голому IP сервер не знает, какой сайт показать');
});

let zoneId;
test('админ: зона, записи, проверки, делегирование', async () => {
  const ov = await admin.get('/api/admin/net/overview');
  assert.ok(ov.zones.some((z) => z.name === 'bank.bln.'));
  await assert.rejects(dev.get('/api/admin/net/overview'), /unauthorized|forbidden/);
  await assert.rejects(admin.post('/api/admin/net/zones', { name: 'test.shop', servers: ['50.1.0.10'] }), /авторитетными/);
  zoneId = (await admin.post('/api/admin/net/zones', { name: 'test.shop', servers: ['50.0.3.10', '50.0.3.11'] })).id;
  const shop = ov.zones.find((z) => z.name === 'shop.');
  const shopZone = await admin.get(`/api/admin/net/zones/${shop.id}`);
  assert.ok(shopZone.records.some((r) => r.name === 'test.shop.' && r.type === 'NS' && r.data === 'ns1.gov.bln.'), 'делегирование в родителе');
  assert.ok(shopZone.zone.serial > shop.serial, 'serial родителя вырос');

  await admin.post(`/api/admin/net/zones/${zoneId}/records`, { name: '@', type: 'A', ttl: 300, data: '50.1.0.10' });
  await assert.rejects(admin.post(`/api/admin/net/zones/${zoneId}/records`, { name: '@', type: 'CNAME', data: 'bank.bln' }), /CNAME/);
  await assert.rejects(admin.post(`/api/admin/net/zones/${zoneId}/records`, { name: 'x', type: 'A', data: 'не-адрес' }), /A: нужен IPv4/);
  await assert.rejects(admin.post(`/api/admin/net/zones/${zoneId}/records`, { name: 'x.bank.bln.', type: 'A', data: '50.1.0.10' }), /Неверное имя/);
  await admin.post(`/api/admin/net/zones/${zoneId}/records`, { name: 'mail', type: 'MX', data: '10 mx.test.shop' });
  await admin.post(`/api/admin/net/zones/${zoneId}/records`, { name: '*', type: 'A', data: '50.1.0.99' });
  const z = await admin.get(`/api/admin/net/zones/${zoneId}`);
  const soa = z.records.find((r) => r.type === 'SOA');
  assert.equal(Number(soa.data.split(' ')[2]), z.zone.serial);
  await assert.rejects(admin.delete(`/api/admin/net/records/${soa.id}`), /SOA/);

  const r = await resolveA(dev, 'test.shop');
  assert.deepEqual(r.trace.map((t) => t.server_name), ['a.root.bln.', 'a.nic.vlod.', 'ns1.gov.bln.']);
  assert.equal(r.answer[0].data, '50.1.0.10');
  const wild = await resolveA(dev, 'anything.test.shop');
  assert.equal(wild.answer[0].name, 'anything.test.shop.');
  assert.equal(wild.answer[0].data, '50.1.0.99');
  const ent = await resolveA(dev, 'mail.test.shop');
  assert.equal(ent.rcode, 'NOERROR');
  assert.equal(ent.answer.length, 0, 'у имени есть только MX — A нет');
});

test('подключение: нет сайта, нет сервера, нет сети; vhost от админа', async () => {
  const noVhost = await dev.post('/api/net/open', { client_id: C1, url: 'https://test.shop/' });
  assert.equal(noVhost.code, 'HTTP_404_NO_VHOST');
  await assert.rejects(admin.post('/api/admin/net/vhosts', { ip: '50.0.3.10', host: 'test.shop', target: 'poisk' }), /веб-серверах/);
  await assert.rejects(admin.post('/api/admin/net/vhosts', { ip: '50.1.0.10', host: 'test.shop', target: 'evil' }), /Сайт/);
  await admin.post('/api/admin/net/vhosts', { ip: '50.1.0.10', host: 'test.shop', target: 'poisk' });
  const ok = await dev.post('/api/net/open', { client_id: C1, url: 'https://test.shop/' });
  assert.equal(ok.ok, true);
  assert.equal(ok.target, 'poisk');
  const timedOut = await dev.post('/api/net/open', { client_id: C1, url: 'https://x.test.shop/' });
  assert.equal(timedOut.code, 'ERR_CONNECTION_TIMED_OUT', 'по 50.1.0.99 никого нет');
  await admin.post(`/api/admin/net/zones/${zoneId}/records`, { name: 'ns', type: 'A', data: '50.0.3.10' });
  assert.equal((await dev.post('/api/net/open', { client_id: C1, url: 'https://ns.test.shop/' })).code, 'ERR_CONNECTION_REFUSED');
  await admin.post(`/api/admin/net/zones/${zoneId}/records`, { name: 'far', type: 'A', data: '70.0.0.1' });
  assert.equal((await dev.post('/api/net/open', { client_id: C1, url: 'https://far.test.shop/' })).code, 'ERR_ADDRESS_UNREACHABLE');
});

test('ping и traceroute', async () => {
  const p = await dev.post('/api/net/ping', { client_id: C1, host: 'bank.bln', count: 3 });
  assert.equal(p.ip, '50.1.0.10');
  assert.equal(p.replies.length, 3);
  assert.ok(p.replies.every((x) => x.ms > 0 && !x.lost));
  const tr = await dev.post('/api/net/traceroute', { client_id: C1, host: 'bank.bln' });
  assert.deepEqual(tr.hops.map((h) => h.name), ['gw.baltelecom.bln.', 'ix.balnet.bln.', 'core.dc.gov.bln.', 'web1.dc.gov.bln.']);
  assert.ok(tr.hops[3].ms[0] > tr.hops[0].ms[0]);
  const far = await dev.post('/api/net/traceroute', { client_id: C1, host: '70.0.0.1' });
  assert.ok(far.hops.at(-1).unreachable);
  const nx = await dev.post('/api/net/ping', { client_id: C1, host: 'vasya.bln' });
  assert.equal(nx.error, 'DNS_PROBE_FINISHED_NXDOMAIN');
  // Выключенный сервер не отвечает.
  await admin.patch('/api/admin/net/hosts/50.1.0.20', { up: false });
  const down = await dev.post('/api/net/ping', { client_id: C1, host: '50.1.0.20', count: 2 });
  assert.ok(down.replies.every((x) => x.lost));
  await admin.patch('/api/admin/net/hosts/50.1.0.20', { up: true });
  const w = await dev.get('/api/net/whois?q=60.1.1.5');
  assert.equal(w.holder, 'БалТелеком');
  assert.equal((await dev.get('/api/net/whois?q=bank.bln')).ns.length, 2);
});

test('провайдер и хост из админки; удаление зоны убирает делегирование', async () => {
  await admin.post('/api/admin/net/providers', { code: 'test-isp', name: 'Тест-провайдер', cidr: '60.9.0.0/16', latency_ms: 3 });
  const l = await dev.post('/api/net/lease', { client_id: 'device-three-03', provider: 'test-isp' });
  assert.match(l.ip, /^60\.9\.1\./);
  assert.equal(l.resolver_ip, '60.9.0.53');
  const ptr = await resolveA(dev, '1.0.9.60.in-addr.arpa', { type: 'PTR' });
  assert.equal(ptr.answer[0].data, 'gw.test-isp.bln.');
  await assert.rejects(admin.post('/api/admin/net/hosts', { ip: '80.0.0.1', name: 'x.bln', kind: 'web' }), /блок/);
  await admin.post('/api/admin/net/hosts', { ip: '50.1.0.40', name: 'web3.dc.gov.bln', kind: 'web' });

  await admin.delete(`/api/admin/net/zones/${zoneId}`);
  await admin.post('/api/admin/net/cache/flush', {});
  const gone = await resolveA(dev, 'test.shop');
  assert.equal(gone.rcode, 'NXDOMAIN');
  const shopRows = await q("SELECT COUNT(*) AS n FROM dns_records WHERE name LIKE '%test.shop.'");
  assert.equal(Number(shopRows[0].n), 0);
});

test('пауза игрового времени — БалНет на обслуживании', async () => {
  await q('UPDATE game_clock SET paused = 1 WHERE id = 1');
  await assert.rejects(resolveA(dev, 'bank.bln'), /balnet_maintenance/);
  await q('UPDATE game_clock SET paused = 0 WHERE id = 1');
  assert.equal((await resolveA(dev, 'bank.bln')).rcode, 'NOERROR');
});
