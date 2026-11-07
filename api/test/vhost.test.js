// Этап Н7: виртуальный хостинг — server.js в QuickJS, SQLite и key-value сайта, формы и POST, cookies
// (HttpOnly), fetch сервера к другим сайтам, CORS с предварительным запросом, лимит CPU и запросов в минуту,
// cron по игровому времени, SQL-консоль панели, робот ВлодПоиска видит динамические страницы.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setup, client, pool } from './helpers.js';

let app;
let clock;
let now = 100000;
before(async () => {
  app = await setup();
  clock = await import('../src/lib/clock.js');
  clock.setGameTimeOverride(() => now);
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
const pay = (p, number) => p.bank.post(`/api/bank/invoices/${number}/pay`, { account_id: p.cur.id });
const DEV = 'device-vhost-01';

let admin;
let boris;
let anna;
let dev;
const site = {};
const put = (host, path, content) => site[host].p.gov.put(`${site[host].f}/file`, { path, content });
const open = (url, jar) => dev.post('/api/net/open', { client_id: DEV, url, jar });
const web = (ticket, path, opts = {}) => app.inject({ method: opts.method || 'GET', url: `/api/net/web/${ticket}${path}`, payload: opts.body, headers: opts.headers || {} });

test('setup: виртуальный тариф Госхостинга, сайт со server.js', async () => {
  admin = client(app);
  await admin.post('/api/auth/gov/register', { email: 'admin@test.bf', password: 'password123', display_name: 'Админ' });
  await admin.patch('/api/admin/settings', { fraud_threshold: 0, fraud_velocity: 0, fraud_multiplier: 0, start_balance: 200000, transfer_fee_bp: 0, transfer_fee_min: 0, vat_bp: 0 });
  boris = await player('boris@test.bf', 'Борис Кодов');
  anna = await player('anna@test.bf', 'Анна Статик');
  dev = client(app);
  await dev.post('/api/net/lease', { client_id: DEV, provider: 'baltelecom' });
  const offers = (await boris.gov.get('/api/gov/hosting')).offers;
  const virt = offers.find((o) => o.name === 'Сервер');
  assert.equal(virt.kind, 'virtual');
  assert.equal(virt.cpu_ms, 100);
  const stat = offers.find((o) => o.name === 'Старт');
  for (const [p, host, plan] of [[boris, 'boris.bln', virt], [anna, 'anna.bln', stat]]) {
    const r = await p.gov.post('/api/gov/domains', { name: host });
    await pay(p, r.invoice);
    const acc = await p.gov.post('/api/gov/hosting', { plan_id: plan.id, months: 2 });
    await pay(p, acc.invoice);
    const s = await p.gov.post(`/api/gov/hosting/${acc.account_id}/sites`, { host });
    const d = (await p.gov.get('/api/gov/domains')).domains[0];
    await p.gov.post(`/api/gov/domains/${d.id}/records`, { name: '@', type: 'A', data: s.ip });
    site[host] = { p, f: `/api/gov/hosting/${acc.account_id}/sites/${s.id}`, id: s.id, acc: acc.account_id };
  }
  assert.equal((await boris.gov.get(`/api/gov/hosting/${site['boris.bln'].acc}`)).account.kind, 'virtual');
  await put('anna.bln', 'data.json', '{"hello":"anna"}');
  await put('anna.bln', 'server.js', 'export function onRequest() { return "секрет"; }');
});

test('server.js: SQLite, формы, редирект, key-value, файлы рядом со скриптом, скрытые файлы', async () => {
  const r = await boris.gov.post(`${site['boris.bln'].f}/example`);
  assert.deepEqual(r.files, ['server.js', 'crontab']);
  await put('boris.bln', 'style.css', 'body{color:red}');
  const o = await open('http://boris.bln/');
  assert.equal(o.ok, true);
  let res = await web(o.ticket, '/');
  assert.equal(res.statusCode, 200);
  assert.match(res.body, /Гостевая книга/);
  assert.match(res.body, /Посещений: 1/);
  assert.ok(res.body.includes('<script src="/api/net/shim.js">'), 'динамический HTML тоже получает shim');
  res = await web(o.ticket, '/sign', { method: 'POST', body: 'name=%D0%92%D0%B0%D1%81%D1%8F&text=%D0%9F%D1%80%D0%B8%D0%B2%D0%B5%D1%82%21', headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  assert.equal(res.statusCode, 302);
  assert.equal(res.headers.location, `/api/net/web/${o.ticket}/`, 'переадресация на свой сайт остаётся в шлюзе');
  res = await web(o.ticket, '/');
  assert.match(res.body, /<b>Вася:<\/b> Привет!/);
  assert.match(res.body, /Посещений: 2/);
  const api = await web(o.ticket, '/api/posts');
  assert.equal(api.headers['content-type'], 'application/json; charset=utf-8');
  assert.equal(JSON.parse(api.body)[0].text, 'Привет!');
  assert.equal((await web(o.ticket, '/style.css')).body, 'body{color:red}', 'статика отдаётся без скрипта');
  for (const hidden of ['/server.js', '/crontab', '/.data/site.sqlite']) assert.equal((await web(o.ticket, hidden)).statusCode, 404, `${hidden} скрыт`);
  assert.equal((await web(o.ticket, '/nope')).statusCode, 404, 'ответ скрипта 404');
  // Файл базы лежит на диске сайта и считается в месте по тарифу.
  const files = await boris.gov.get(`${site['boris.bln'].f}/files?path=.data`);
  assert.equal(files.entries[0].name, 'site.sqlite');
  // Статический тариф: server.js — обычный файл, POST не принимается.
  const a = await open('http://anna.bln/');
  assert.equal((await web(a.ticket, '/server.js')).body, 'export function onRequest() { return "секрет"; }');
  assert.equal((await web(a.ticket, '/x', { method: 'POST', body: 'a=1', headers: { 'content-type': 'text/plain' } })).statusCode, 405);
});

test('cookies: Set-Cookie с HttpOnly попадает в банку билета, но не в document.cookie', async () => {
  await put('boris.bln', 'server.js', `export async function onRequest(req) {
    if (req.path === '/login') return new Response('ok').setCookie('sid', 'секрет-42', { httpOnly: true }).setCookie('theme', 'dark');
    return Response.json({ sid: req.cookies.sid || null, theme: req.cookies.theme || null, ip: req.ip });
  }`);
  const o = await open('http://boris.bln/');
  const login = await web(o.ticket, '/login');
  assert.equal(login.headers['x-balnet-jar'], '1');
  const jar = JSON.parse((await web('x', '').then(() => app.inject({ method: 'GET', url: `/api/net/jar/${o.ticket}` }))).body);
  assert.equal(jar.cookies.sid.h, 1);
  assert.equal(jar.cookies.theme.h, undefined);
  const me = JSON.parse((await web(o.ticket, '/me')).body);
  assert.equal(me.sid, 'секрет-42');
  assert.equal(me.theme, 'dark');
  assert.match(me.ip, /^60\./, 'скрипт видит IP посетителя в БалНете');
  // Банка вернулась из браузера: следующий билет передаёт cookies серверу.
  const o2 = await open('http://boris.bln/', { cookies: jar.cookies, local: {} });
  assert.equal(JSON.parse((await web(o2.ticket, '/me')).body).theme, 'dark');
});

test('fetch из server.js по сети БалНета; CORS для страниц, в том числе предварительный OPTIONS', async () => {
  await put('boris.bln', 'server.js', `export async function onRequest(req) {
    if (req.path === '/proxy') { const r = await fetch('http://anna.bln/data.json'); return Response.json({ status: r.status, data: await r.json() }); }
    if (req.path === '/gov') { try { await fetch('https://bank.bln/'); return 'нет'; } catch (e) { return String(e.message); } }
    if (req.method === 'OPTIONS') return new Response('', { headers: { 'access-control-allow-origin': '*', 'access-control-allow-methods': 'PUT' } });
    if (req.method === 'PUT') return new Response('положено ' + await req.text(), { headers: { 'access-control-allow-origin': '*' } });
    return 'x';
  }`);
  const o = await open('http://boris.bln/');
  const proxy = JSON.parse((await web(o.ticket, '/proxy')).body);
  assert.deepEqual(proxy, { status: 200, data: { hello: 'anna' } });
  assert.match((await web(o.ticket, '/gov')).body, /ERR_GOV_SITE/);
  // Страница Анны отправляет PUT на сайт Бориса: сначала OPTIONS, потом сам запрос.
  const a = await open('http://anna.bln/');
  const xf = (b) => app.inject({ method: 'POST', url: '/api/net/xfetch', payload: JSON.stringify({ ticket: a.ticket, ...b }), headers: { 'content-type': 'text/plain', origin: 'null' } }).then((r) => JSON.parse(r.body));
  const put1 = await xf({ url: 'http://boris.bln/item', method: 'PUT', body: 'хлеб' });
  assert.equal(Buffer.from(put1.body, 'base64').toString(), 'положено хлеб');
  const del = await xf({ url: 'http://boris.bln/item', method: 'DELETE' });
  assert.equal(del.error, 'cors', 'DELETE не разрешён предварительным ответом');
});

test('лимиты: CPU-мс тарифа, ошибки в журнале, запросы в минуту', async () => {
  await put('boris.bln', 'server.js', `export function onRequest(req) {
    if (req.path === '/loop') { for (;;) {} }
    if (req.path === '/err') { console.log('перед ошибкой'); null.x; }
    return 'ok';
  }`);
  const o = await open('http://boris.bln/');
  const loop = await web(o.ticket, '/loop');
  assert.equal(loop.statusCode, 508);
  const err = await web(o.ticket, '/err');
  assert.equal(err.statusCode, 500);
  const logs = (await boris.gov.get(`${site['boris.bln'].f}/logs`)).logs;
  assert.ok(logs.some((l) => /лимит CPU тарифа: 100 мс/.test(l.text)));
  assert.ok(logs.some((l) => l.level === 'log' && l.text === 'перед ошибкой'));
  assert.ok(logs.some((l) => l.level === 'error' && /TypeError/.test(l.text)));
  assert.match((await web(o.ticket, '/')).body, /ok$/, 'после ошибок сайт работает');
  // 300 запросов в минуту по тарифу.
  let last;
  for (let i = 0; i < 300; i++) last = await web(o.ticket, '/style.css');
  assert.equal(last.statusCode, 429);
});

test('cron по игровому времени и минимальный шаг тарифа', async () => {
  const { cronTick } = await import('../src/lib/vhost/cron.js');
  const { q } = await import('../src/db.js');
  await q('UPDATE hosting_sites SET cron_at = NULL');
  await put('boris.bln', 'server.js', 'export function onCron(job) { kv.set("cron:" + job.name, (kv.get("cron:" + job.name) || 0) + 1); }');
  await put('boris.bln', 'crontab', '# комментарий\n0 * * * * ежечасно\n*/5 * * * * часто\n0 0 * * 0 воскресенье\n');
  const day = 86400 * 10; // 10-е игровые сутки, 00:00
  await cronTick({ now: day - 120 }); // первый проход только отмечает время
  assert.equal(await cronTick({ now: day + 30 }), 1, 'полночь: ежечасно (воскресенье — 10 % 7 = 3, не сегодня)');
  assert.equal(await cronTick({ now: day + 1800 }), 0);
  assert.equal(await cronTick({ now: day + 3600 * 5 }), 1, 'пропущенные часы — один запуск за проверку');
  const kvs = await boris.gov.get(`${site['boris.bln'].f}/kv`);
  assert.equal(kvs.keys.find((k) => k.key === 'cron:ежечасно').value, '2');
  assert.ok(!kvs.keys.some((k) => k.key === 'cron:часто'));
  const logs = (await boris.gov.get(`${site['boris.bln'].f}/logs`)).logs;
  assert.ok(logs.some((l) => /«часто» срабатывает чаще, чем раз в 60 игр\. мин/.test(l.text)));
  assert.equal(kvs.crontab.jobs.length, 3);
});

test('SQL-консоль панели и робот ВлодПоиска индексирует динамические страницы', async () => {
  (await import('../src/lib/vhost/respond.js')).resetRateLimits(); // новая минута
  const r = await boris.gov.post(`${site['boris.bln'].f}/sql`, { sql: "CREATE TABLE t (a TEXT); INSERT INTO t VALUES ('пирог'); SELECT a FROM t" });
  assert.deepEqual(r.result.at(-1).rows, [['пирог']]);
  assert.ok(r.tables.includes('posts') && r.tables.includes('_kv'));
  await assert.rejects(boris.gov.post(`${site['boris.bln'].f}/sql`, { sql: 'SELEC 1' }), /SQLite/);
  await assert.rejects(anna.gov.post(`${site['anna.bln'].f}/sql`, { sql: 'SELECT 1' }), /виртуальном тарифе/);
  await put('boris.bln', 'server.js', `export function onRequest(req) {
    const row = db.get('SELECT a FROM t');
    return Response.html('<html><head><title>Пекарня с базой</title></head><body>Сегодня в продаже: ' + row.a + '</body></html>');
  }`);
  await admin.post('/api/admin/search/crawl', { rounds: 5 });
  const s = await client(app).get('/api/search/search?q=пирог');
  assert.equal(s.results[0].url, 'http://boris.bln/');
  assert.equal(s.results[0].title, 'Пекарня с базой');
});
