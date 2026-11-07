// Этап Н4: статический хостинг — тарифы, деньги, сайт на домене, файлы и ZIP, шлюз (CSP, shim, 404, пути),
// межсайтовый fetch по CORS БалНета, защита API от песочницы, приостановка и удаление, хостер с арендой сервера.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import zlib from 'node:zlib';
import fs from 'node:fs/promises';
import { setup, client, pool, one, totalBalance } from './helpers.js';

let app;
let advance;
let clock;
before(async () => {
  app = await setup();
  clock = await import('../src/lib/clock.js');
  ({ advance } = clock);
  clock.setGameTimeOverride(() => 9000);
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
  return { gov, bank, cur, passport: me.passport.number };
}
const pay = (p, number) => p.bank.post(`/api/bank/invoices/${number}/pay`, { account_id: p.cur.id });
const bal = async (id) => Number((await one('SELECT balance FROM accounts WHERE id = ?', [id])).balance);
const DEV = 'device-host-001';

/** Минимальный ZIP: stored и deflate. */
function zip(files) {
  const locals = [];
  const centrals = [];
  let offset = 0;
  for (const [name, text, deflate] of files) {
    const data = Buffer.from(text);
    const body = deflate ? zlib.deflateRawSync(data) : data;
    const nameBuf = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x800, 6); lh.writeUInt16LE(deflate ? 8 : 0, 8);
    lh.writeUInt32LE(body.length, 18); lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(nameBuf.length, 26);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x800, 8); ch.writeUInt16LE(deflate ? 8 : 0, 10);
    ch.writeUInt32LE(body.length, 20); ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(nameBuf.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, nameBuf, body);
    centrals.push(ch, nameBuf);
    offset += 30 + nameBuf.length + body.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

let admin;
let boris;
let anna;
let dev;
let acc;
let site;

async function open(url, jar) {
  return dev.post('/api/net/open', { client_id: DEV, url, jar });
}
async function web(ticket, path = '/', headers = {}) {
  return app.inject({ method: 'GET', url: `/api/net/web/${ticket}${path}`, headers });
}

test('setup: игроки, домен boris.bln, устройство', async () => {
  admin = client(app);
  await admin.post('/api/auth/gov/register', { email: 'admin@test.bf', password: 'password123', display_name: 'Админ' });
  await admin.patch('/api/admin/settings', { fraud_threshold: 0, fraud_velocity: 0, fraud_multiplier: 0, start_balance: 200000, vat_bp: 2000, hosting_max_file_kb: 600, transfer_fee_bp: 0, transfer_fee_min: 0 });
  boris = await player('boris@test.bf', 'Борис Сайтов');
  anna = await player('anna@test.bf', 'Анна Хостерова');
  dev = client(app);
  await dev.post('/api/net/lease', { client_id: DEV, provider: 'baltelecom' });
  for (const [p, name] of [[boris, 'boris.bln'], [anna, 'anna.bln']]) {
    const r = await p.gov.post('/api/gov/domains', { name });
    await pay(p, r.invoice);
  }
});

test('покупка тарифа Госхостинга: квитанция, деньги в бюджет, срок', async () => {
  const h = await boris.gov.get('/api/gov/hosting');
  assert.deepEqual(h.offers.map((o) => `${o.hoster}:${o.name}`), ['Госхостинг БалНета:Старт', 'Госхостинг БалНета:Блог']);
  const start = h.offers[0];
  assert.equal(start.ip, '50.1.0.30');
  const r = await boris.gov.post('/api/gov/hosting', { plan_id: start.id, months: 2 });
  assert.equal(r.amount, 1000);
  await assert.rejects(boris.gov.post(`/api/gov/hosting/${r.account_id}/sites`, { host: 'boris.bln' }), /не оплачен/);
  await pay(boris, r.invoice);
  acc = (await boris.gov.get(`/api/gov/hosting/${r.account_id}`)).account;
  assert.equal(acc.status, 'active');
  assert.equal(acc.paid_until_month, h.month + 2);
  await assert.rejects(anna.gov.get(`/api/gov/hosting/${acc.id}`), /not_found/);
});

test('сайт на домене: A-запись на сервер, файлы, шлюз с песочницей', async () => {
  site = await boris.gov.post(`/api/gov/hosting/${acc.id}/sites`, { host: 'boris.bln' });
  assert.equal(site.ip, '50.1.0.30');
  await assert.rejects(anna.gov.post(`/api/gov/hosting/${acc.id}/sites`, { host: 'x.bln' }), /not_found/);
  const domains = (await boris.gov.get('/api/gov/domains')).domains;
  await boris.gov.post(`/api/gov/domains/${domains[0].id}/records`, { name: '@', type: 'A', data: site.ip });

  const f = `/api/gov/hosting/${acc.id}/sites/${site.id}`;
  await boris.gov.put(`${f}/file`, { path: 'index.html', content: '<!doctype html><html><head><title>Борис</title><link rel="stylesheet" href="/style.css"></head><body><a href="https://bank.bln/">банк</a><img src="/img/logo.png"></body></html>' });
  await boris.gov.put(`${f}/file`, { path: 'style.css', content: 'body{background:url(/img/bg.png)}' });
  await boris.gov.put(`${f}/file`, { path: 'img/logo.png', content: Buffer.from([137, 80, 78, 71]).toString('base64'), binary: true });
  await boris.gov.put(`${f}/file`, { path: '_headers', content: '/*\n  X-Hello: world\n  Content-Security-Policy: none\n' });
  const list = await boris.gov.get(`${f}/files`);
  assert.deepEqual(list.entries.map((e) => e.name), ['img', '_headers', 'index.html', 'style.css']);
  assert.equal((await boris.gov.get(`${f}/file?path=index.html`)).text, true);

  const o = await open('https://boris.bln/');
  assert.equal(o.ok, true);
  assert.equal(o.target, `site:${site.id}`);
  assert.equal(o.gov, false);
  assert.equal(o.tls, false, 'у сайтов игроков пока нет сертификатов');
  assert.ok(o.ticket);
  const res = await web(o.ticket, '/');
  assert.equal(res.statusCode, 200);
  assert.match(res.headers['content-security-policy'], /^sandbox allow-scripts/);
  assert.equal(res.headers['access-control-allow-origin'], '*');
  assert.equal(res.headers['x-hello'], 'world');
  assert.ok(res.body.includes('<script src="/api/net/shim.js">'), 'shim встроен');
  assert.ok(res.body.includes(`href="/api/net/web/${o.ticket}/style.css"`), 'корневые пути переписаны');
  assert.ok(res.body.includes('href="https://bank.bln/"'), 'внешние ссылки не тронуты');
  assert.ok(res.body.includes('"origin":"https://boris.bln"'));
  const css = await web(o.ticket, '/style.css');
  assert.match(css.headers['content-type'], /text\/css/);
  assert.equal(css.body, `body{background:url(/api/net/web/${o.ticket}/img/bg.png)}`);
  const png = await web(o.ticket, '/img/logo.png');
  assert.equal(png.headers['content-type'], 'image/png');
  assert.equal((await web(o.ticket, '/_headers')).statusCode, 404, '_headers не отдаётся');
  assert.equal((await web(o.ticket, '/img')).statusCode, 301);
  const nf = await web(o.ticket, '/nope.html');
  assert.equal(nf.statusCode, 404);
  assert.match(nf.body, /404/);
  await boris.gov.put(`${f}/file`, { path: '404.html', content: '<html><head></head><body>Своя 404</body></html>' });
  const nf2 = await web(o.ticket, '/nope.html');
  assert.equal(nf2.statusCode, 404);
  assert.match(nf2.body, /Своя 404/);
  assert.equal((await web(o.ticket, '/..%2F..%2Fetc%2Fpasswd')).statusCode, 404, 'выход за каталог сайта невозможен');
  assert.equal((await web('нет-такого', '/')).statusCode, 410);
  const shim = await app.inject({ method: 'GET', url: '/api/net/shim.js' });
  assert.match(shim.body, /__BALNET__/);
  const post = await app.inject({ method: 'POST', url: `/api/net/web/${o.ticket}/form`, payload: 'a=1', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(post.statusCode, 405);
});

test('хранилища сайта: браузер передаёт cookies и localStorage, страница получает их', async () => {
  const o = await open('http://boris.bln/', { cookies: { theme: { v: 'dark', exp: null } }, local: { visits: '3' } });
  const res = await web(o.ticket, '/');
  assert.ok(res.body.includes('"cookies":{"theme":{"v":"dark","exp":null}}'));
  assert.ok(res.body.includes('"local":{"visits":"3"}'));
  assert.ok(res.body.includes('"origin":"http://boris.bln"'));
  await dev.post('/api/net/jar', { ticket: o.ticket, cookies: { theme: { v: 'light', exp: null } }, local: {} });
  assert.ok((await web(o.ticket, '/')).body.includes('"v":"light"'));
});

test('файлы: защита путей, размер файла, квота тарифа, ZIP', async () => {
  const f = `/api/gov/hosting/${acc.id}/sites/${site.id}`;
  await assert.rejects(boris.gov.put(`${f}/file`, { path: '../evil.html', content: 'x' }), /bad_path/);
  await assert.rejects(boris.gov.put(`${f}/file`, { path: 'a/../../evil.html', content: 'x' }), /bad_path/);
  await assert.rejects(boris.gov.get(`${f}/file?path=../../../etc/passwd`), /bad_path/);
  await assert.rejects(boris.gov.put(`${f}/file`, { path: 'big.bin', content: Buffer.alloc(700 * 1024).toString('base64'), binary: true }), /too_big/);

  await boris.gov.post(`${f}/zip`, { data: zip([['site/blog/index.html', '<html><head></head><body>Блог</body></html>', true], ['site/blog/post.txt', 'Привет', false]]).toString('base64') });
  const blog = await boris.gov.get(`${f}/files?path=blog`);
  assert.deepEqual(blog.entries.map((e) => e.name), ['index.html', 'post.txt'], 'общая папка архива снята');
  assert.equal((await boris.gov.get(`${f}/file?path=blog/post.txt`)).content, 'Привет');
  await assert.rejects(boris.gov.post(`${f}/zip`, { data: Buffer.from('not a zip').toString('base64') }), /bad_zip/);
  await assert.rejects(boris.gov.post(`${f}/zip`, { data: zip([['../escape.txt', 'x', false]]).toString('base64') }), /bad_path/);

  // Квота: тариф на 1 МБ.
  const plan = await admin.post('/api/admin/net/hosting/plans', { server_id: 1, name: 'Мини', disk_mb: 1, max_sites: 1, price_month: 0 });
  const small = await anna.gov.post('/api/gov/hosting', { plan_id: plan.id, months: 1 });
  assert.equal(small.invoice, null, 'бесплатный тариф работает сразу');
  const s2 = await anna.gov.post(`/api/gov/hosting/${small.account_id}/sites`, { host: 'anna.bln' });
  await assert.rejects(anna.gov.post(`/api/gov/hosting/${small.account_id}/sites`, { host: 'www.anna.bln' }), /не больше 1/);
  const g = `/api/gov/hosting/${small.account_id}/sites/${s2.id}`;
  const chunk = Buffer.alloc(500 * 1024, 1).toString('base64');
  await anna.gov.put(`${g}/file`, { path: 'a.bin', content: chunk, binary: true });
  await anna.gov.put(`${g}/file`, { path: 'b.bin', content: chunk, binary: true });
  await assert.rejects(anna.gov.put(`${g}/file`, { path: 'c.bin', content: chunk, binary: true }), /quota/);
  await anna.gov.delete(`${g}/file?path=b.bin`);
  await anna.gov.put(`${g}/file`, { path: 'data.json', content: '{"hello":"anna"}' });
  const annaDomain = (await anna.gov.get('/api/gov/domains')).domains[0];
  await anna.gov.post(`/api/gov/domains/${annaDomain.id}/records`, { name: '@', type: 'A', data: s2.ip });
});

test('fetch между сайтами по CORS БалНета; API закрыт для песочницы', async () => {
  const o = await open('http://boris.bln/');
  const xf = (url) => app.inject({ method: 'POST', url: '/api/net/xfetch', payload: JSON.stringify({ ticket: o.ticket, url }), headers: { 'content-type': 'text/plain', origin: 'null' } }).then((r) => JSON.parse(r.body));
  const own = await xf('http://boris.bln/blog/post.txt');
  assert.equal(Buffer.from(own.body, 'base64').toString(), 'Привет');
  const blocked = await xf('http://anna.bln/data.json');
  assert.equal(blocked.error, 'cors');
  const g = (await anna.gov.get('/api/gov/hosting')).accounts[0];
  await anna.gov.put(`/api/gov/hosting/${g.id}/sites/${g.sites[0].id}/file`, { path: '_headers', content: '/data.json\n  Access-Control-Allow-Origin: *\n' });
  const allowed = await xf('http://anna.bln/data.json');
  assert.equal(JSON.parse(Buffer.from(allowed.body, 'base64').toString()).hello, 'anna');
  assert.equal((await xf('https://bank.bln/')).error, 'cors', 'госсайты чужим сайтам не отвечают');
  assert.equal((await xf('http://vasya.bln/')).error, 'network');

  const me = await app.inject({ method: 'GET', url: '/api/gov/me', headers: { origin: 'null' } });
  assert.equal(me.statusCode, 403);
  assert.equal(JSON.parse(me.body).error, 'sandbox_origin');
  const pay2 = await app.inject({ method: 'POST', url: '/api/bank/transfers', payload: '{}', headers: { origin: 'null', 'content-type': 'text/plain' } });
  assert.equal(pay2.statusCode, 403);
});

test('хостер: лицензия, аренда сервера со счёта организации, свой тариф, доход с НДС', async () => {
  await anna.gov.post('/api/gov/documents/inn');
  await anna.gov.post('/api/gov/orgs/apply', { kind: 'llc', name: 'АннаХост' });
  const inv = (await anna.gov.get('/api/gov/invoices')).invoices.find((i) => i.status === 'unpaid');
  await pay(anna, inv.number);
  const org = (await anna.gov.get('/api/gov/orgs')).orgs[0];
  await assert.rejects(anna.gov.post(`/api/gov/orgs/${org.id}/servers`), /лицензия/);
  await admin.post('/api/admin/net/licenses', { org_id: org.id, kind: 'hosting' });
  const orgAcc = (await one('SELECT account_id, (SELECT number FROM accounts WHERE id = organizations.account_id) AS number FROM organizations WHERE id = ?', [org.id]));
  await assert.rejects(anna.gov.post(`/api/gov/orgs/${org.id}/servers`), /insufficient_funds/);
  // Пополнение счёта организации обычным переводом по номеру счёта.
  const prev = await anna.bank.post('/api/bank/transfers/preview', { to: { type: 'account', value: orgAcc.number }, amount: 10000 });
  assert.equal(prev.recipient.name, 'АннаХост');
  await anna.bank.post('/api/bank/transfers', { from_account: anna.cur.id, to: { type: 'account', value: orgAcc.number }, amount: 10000 });
  const srv = await anna.gov.post(`/api/gov/orgs/${org.id}/servers`);
  assert.match(srv.ip, /^50\.2\.0\.\d+$/);
  assert.equal(await bal(orgAcc.account_id), 10000 - srv.rent);
  const plan = await anna.gov.post(`/api/gov/orgs/${org.id}/plans`, { server_id: srv.id, name: 'Анна-Про', disk_mb: 50, max_sites: 5, price_month: 1200 });
  const offers = (await boris.gov.get('/api/gov/hosting')).offers;
  assert.ok(offers.some((x) => x.id === plan.id && x.hoster === 'АннаХост'));
  const before = await bal(orgAcc.account_id);
  const r = await boris.gov.post('/api/gov/hosting', { plan_id: plan.id, months: 1 });
  await pay(boris, r.invoice);
  assert.equal(await bal(orgAcc.account_id), before + 1000, 'хостеру 1200 минус НДС 200');
  const h = (await boris.gov.get(`/api/gov/hosting/${r.account_id}`)).account;
  assert.equal(h.server_ip, srv.ip);
  const ptr = await dev.post('/api/net/resolve', { client_id: DEV, name: `${srv.ip.split('.').reverse().join('.')}.in-addr.arpa`, type: 'PTR' });
  assert.equal(ptr.answer[0].data, `s${srv.id}.dc.bln.`);
  assert.equal(await totalBalance(), 0);
});

test('неуплата: сайт приостановлен, потом удалён вместе с файлами', async () => {
  const o = await open('http://boris.bln/');
  await advance({ force: true });
  await advance({ force: true });
  const sus = await web(o.ticket, '/');
  assert.equal(sus.statusCode, 403);
  assert.match(sus.body, /приостановлен/);
  assert.equal((await boris.gov.get(`/api/gov/hosting/${acc.id}`)).account.status, 'suspended');
  await assert.rejects(boris.gov.put(`/api/gov/hosting/${acc.id}/sites/${site.id}/file`, { path: 'x.txt', content: 'x' }), /приостановлен/);
  await advance({ force: true });
  await assert.rejects(boris.gov.get(`/api/gov/hosting/${acc.id}`), /not_found/);
  const after2 = await open('http://boris.bln/');
  assert.equal(after2.code, 'HTTP_404_NO_VHOST');
  const dir = `${process.env.BALNET_SITES_DIR}/${acc.id}`;
  assert.equal(await fs.stat(dir).catch(() => null), null, 'файлы удалены');
});
