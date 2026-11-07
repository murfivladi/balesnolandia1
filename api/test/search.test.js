// Этап Н6: ВлодПоиск — краулер (robots.txt, sitemap, noindex, canonical, редиректы, 404), PageRank, BM25,
// выдача и вертикали, операторы, опечатки, подсказки, вебмастер (TXT, переобход, проверка адреса),
// реклама (аукцион второй цены, бюджет, повторные клики), рекламная сеть с долей сайта, Safe Browsing.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { setup, client, pool, one, totalBalance } from './helpers.js';

let app;
let clock;
let now = 50000;
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
const bal = async (id) => Number((await one('SELECT balance FROM accounts WHERE id = ?', [id])).balance);
const DEV = 'device-search-01';

let admin;
let boris;
let anna;
let dev;
const files = {};
const domains = {};
const put = (p, host, path, content) => p.gov.put(`${files[host]}/file`, { path, content });
const crawl = (rounds = 10) => admin.post('/api/admin/search/crawl', { rounds });
const search = (c, q, extra = '') => c.get(`/api/search/search?q=${encodeURIComponent(q)}${extra}`);
const page = (url) => one('SELECT * FROM search_pages WHERE url = ?', [url]);

test('setup: два сайта на хостинге', async () => {
  admin = client(app);
  await admin.post('/api/auth/gov/register', { email: 'admin@test.bf', password: 'password123', display_name: 'Админ' });
  await admin.patch('/api/admin/settings', { fraud_threshold: 0, fraud_velocity: 0, fraud_multiplier: 0, start_balance: 200000, transfer_fee_bp: 0, transfer_fee_min: 0, vat_bp: 0 });
  boris = await player('boris@test.bf', 'Борис Пекарев');
  anna = await player('anna@test.bf', 'Анна Ловкая');
  dev = client(app);
  await dev.post('/api/net/lease', { client_id: DEV, provider: 'baltelecom' });
  const plan = await admin.post('/api/admin/net/hosting/plans', { server_id: 1, name: 'Тест', disk_mb: 5, max_sites: 3, price_month: 0 });
  for (const [p, host] of [[boris, 'boris.bln'], [anna, 'anna.bln']]) {
    const r = await p.gov.post('/api/gov/domains', { name: host });
    await pay(p, r.invoice);
    const acc = await p.gov.post('/api/gov/hosting', { plan_id: plan.id, months: 3 });
    const s = await p.gov.post(`/api/gov/hosting/${acc.account_id}/sites`, { host });
    domains[host] = (await p.gov.get('/api/gov/domains')).domains[0];
    await p.gov.post(`/api/gov/domains/${domains[host].id}/records`, { name: '@', type: 'A', data: s.ip });
    files[host] = `/api/gov/hosting/${acc.account_id}/sites/${s.id}`;
  }
  await put(boris, 'boris.bln', 'index.html', `<!doctype html><html lang="ru"><head><title>Пекарня Бориса — свежий хлеб</title>
    <meta name="description" content="Свежий хлеб и пирожки каждый день в Влодограде."></head>
    <body><h1>Пекарня Бориса</h1><p>Печём ржаной хлеб, батоны и пирожки с капустой. Доставка по Влодограду.</p>
    <a href="/about.html">О пекарне</a> <a href="/secret/plan.html">План</a> <a href="/news/open.html">Новости</a>
    <a href="/old">Старое</a> <a href="/draft.html">Черновик</a> <a href="/copy.html">Копия</a> <a href="/missing.html">Нет</a>
    <img src="/img/baton.png" alt="Румяный батон"></body></html>`);
  await put(boris, 'boris.bln', 'about.html', '<html><head><title>О пекарне</title></head><body><p>Пекарня работает с первого игрового месяца. Мука из Балесноландии.</p><a href="/">Главная</a></body></html>');
  await put(boris, 'boris.bln', 'secret/plan.html', '<html><head><title>Секретный план</title></head><body>захват рынка круассанов</body></html>');
  await put(boris, 'boris.bln', 'news/open.html', '<html><head><title>Открылся второй магазин</title><meta property="og:type" content="article"></head><body><article>Пекарня Бориса открыла второй магазин на площади.</article></body></html>');
  await put(boris, 'boris.bln', 'old/index.html', '<html><head><title>Архив</title></head><body>архивная страница</body></html>');
  await put(boris, 'boris.bln', 'draft.html', '<html><head><title>Черновик</title><meta name="robots" content="noindex"></head><body>черновик рецепта эклеров</body></html>');
  await put(boris, 'boris.bln', 'copy.html', '<html><head><title>Копия главной</title><link rel="canonical" href="http://boris.bln/"></head><body>хлеб хлеб</body></html>');
  await put(boris, 'boris.bln', 'hidden.html', '<html><head><title>Тайный рецепт</title></head><body>Рецепт бородинского хлеба с кориандром.</body></html>');
  await put(boris, 'boris.bln', 'robots.txt', 'User-agent: *\nDisallow: /secret/\nSitemap: http://boris.bln/sitemap.xml\n');
  await put(boris, 'boris.bln', 'sitemap.xml', '<?xml version="1.0"?><urlset><url><loc>http://boris.bln/hidden.html</loc></url></urlset>');
  await boris.gov.put(`${files['boris.bln']}/file`, { path: 'img/baton.png', content: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString('base64'), binary: true });

  await put(anna, 'anna.bln', 'index.html', `<html><head><title>Блог Анны</title></head><body><h1>Мои любимые места</h1>
    <p>Где купить хлеб в Влодограде? Конечно, <a href="http://boris.bln/">лучший хлеб у Бориса</a>.</p>
    <p>Ещё <a href="http://boris.bln/about.html">история пекарни</a>. Читайте <a href="/login.html">вход</a>.</p></body></html>`);
  await put(anna, 'anna.bln', 'login.html', '<html><head><title>ВлодБанк — вход в интернет-банк</title></head><body><h1>ВлодБанк</h1><form><input name="card"><input type="password" name="pin"></form></body></html>');
});

test('краулер: robots.txt, sitemap, noindex, canonical, редирект папки, 404, госсайты', async () => {
  const r = await crawl(15);
  assert.ok(r.done > 5, JSON.stringify(r));
  assert.equal((await page('http://boris.bln/')).status, 'indexed');
  const secret = await page('http://boris.bln/secret/plan.html');
  assert.equal(secret.status, 'excluded');
  assert.match(secret.reason, /robots\.txt \(Disallow: \/secret\/\)/);
  const hidden = await page('http://boris.bln/hidden.html');
  assert.equal(hidden.status, 'indexed', 'найдена по sitemap без ссылок');
  assert.equal(hidden.source, 'sitemap');
  assert.match((await page('http://boris.bln/draft.html')).reason, /noindex/);
  assert.match((await page('http://boris.bln/copy.html')).reason, /Канонический адрес/);
  const old = await page('http://boris.bln/old');
  assert.equal(old.status, 'redirect');
  assert.equal(old.redirect_to, 'http://boris.bln/old/');
  assert.equal((await page('http://boris.bln/old/')).status, 'indexed');
  assert.equal((await page('http://boris.bln/missing.html')).status, 'gone');
  assert.equal((await page('http://boris.bln/news/open.html')).kind, 'article');
  assert.equal((await page('https://gosuslugi.gov.bln/')).kind, 'gov');
  // Входящие ссылки с другого сайта поднимают PageRank.
  const home = await page('http://boris.bln/');
  const about = await page('http://boris.bln/about.html');
  assert.ok(home.inlinks >= 2);
  assert.ok(home.pagerank > (await page('http://boris.bln/hidden.html')).pagerank);
  assert.ok(about.pagerank > 0);
});

test('выдача: BM25 + PageRank, сниппет, операторы, опечатки, вертикали', async () => {
  const c = client(app);
  const r = await search(c, 'свежий хлеб');
  assert.equal(r.results[0].url, 'http://boris.bln/');
  assert.ok(r.results[0].snippet.some((s) => s.b && /хлеб/i.test(s.t)), 'слова запроса подсвечены');
  assert.ok(!r.results.some((x) => x.url.includes('/secret/') || x.url.includes('draft') || x.url.includes('copy')));
  // Текст ссылки с чужого сайта работает на страницу, куда она ведёт.
  const anchor = await search(c, 'история пекарни');
  assert.equal(anchor.results[0].url, 'http://boris.bln/about.html');
  const site = await search(c, 'хлеб site:anna.bln');
  assert.ok(site.results.length && site.results.every((x) => x.host === 'anna.bln'));
  const minus = await search(c, 'хлеб -бородинского');
  assert.ok(!minus.results.some((x) => x.url.endsWith('hidden.html')));
  const phrase = await search(c, '"бородинского хлеба"');
  assert.deepEqual(phrase.results.map((x) => x.url), ['http://boris.bln/hidden.html']);
  const typo = await search(c, 'пирожкки');
  assert.equal(typo.total, 0);
  assert.equal(typo.suggestion, 'пирожки');
  const gov = await search(c, 'получить паспорт');
  assert.equal(gov.results[0].host, 'gosuslugi.gov.bln');
  const news = await search(c, 'магазин', '&tab=news');
  assert.equal(news.results[0].url, 'http://boris.bln/news/open.html');
  const img = await search(c, 'батон', '&tab=images');
  assert.equal(img.results[0].alt, 'Румяный батон');
  const pic = await app.inject({ method: 'GET', url: `/api/search/img/${img.results[0].id}` });
  assert.equal(pic.statusCode, 200);
  assert.equal(pic.headers['content-type'], 'image/png');
});

test('подсказки только из запросов нескольких людей, тренды', async () => {
  const a = client(app);
  await a.get('/api/search/search?q=ржаной%20хлеб');
  let s = await a.get('/api/search/suggest?q=ржан');
  assert.ok(!s.suggestions.includes('ржаной хлеб'), 'запрос одного человека не всплывает');
  const other = await app.inject({ method: 'GET', url: '/api/search/search?q=ржаной%20хлеб', remoteAddress: '10.9.9.9' });
  assert.equal(other.statusCode, 200);
  s = await a.get('/api/search/suggest?q=ржан');
  assert.ok(s.suggestions.includes('ржаной хлеб'));
  const t = await a.get('/api/search/trends');
  assert.ok(t.trends.some((x) => x.q === 'ржаной хлеб'));
});

let borisSite;
test('вебмастер: подтверждение TXT, отчёт, переобход, проверка адреса', async () => {
  borisSite = (await boris.gov.post('/api/search/webmaster/sites', { host: 'boris.bln' })).id;
  await assert.rejects(anna.gov.get(`/api/search/webmaster/sites/${borisSite}`), /not_found/);
  let v = (await boris.gov.get(`/api/search/webmaster/sites/${borisSite}`)).site;
  assert.equal(v.verified, false);
  assert.match(v.instructions.dns.value, /^vlodpoisk-verification=[0-9a-f]{24}$/);
  const fail = await boris.gov.post(`/api/search/webmaster/sites/${borisSite}/verify`, { method: 'dns' });
  assert.equal(fail.ok, false);
  await assert.rejects(boris.gov.post(`/api/search/webmaster/sites/${borisSite}/recrawl`, { url: 'http://boris.bln/' }), /подтвердите права/);
  await boris.gov.post(`/api/gov/domains/${domains['boris.bln'].id}/records`, { name: '@', type: 'TXT', data: v.instructions.dns.value });
  const ok = await boris.gov.post(`/api/search/webmaster/sites/${borisSite}/verify`, { method: 'dns' });
  assert.equal(ok.ok, true, ok.error);
  v = (await boris.gov.get(`/api/search/webmaster/sites/${borisSite}`)).site;
  assert.ok(v.counts.indexed >= 5);
  assert.ok(v.pages.some((p) => p.status === 'excluded' && /robots/.test(p.reason)));
  assert.ok(v.queries.some((x) => x.q === 'свежий хлеб' && x.impressions >= 1 && x.position === 1));
  assert.ok(v.links.some((l) => l.host === 'anna.bln'));

  await put(boris, 'boris.bln', 'about.html', '<html><head><title>О пекарне</title></head><body>Теперь печём багеты по-балесноландски.</body></html>');
  assert.equal((await search(client(app), 'багеты')).total, 0, 'до переобхода индекс старый');
  const rc = await boris.gov.post(`/api/search/webmaster/sites/${borisSite}/recrawl`, { url: 'http://boris.bln/about.html' });
  assert.equal(rc.left, 9);
  await assert.rejects(boris.gov.post(`/api/search/webmaster/sites/${borisSite}/recrawl`, { url: 'http://anna.bln/' }), /Адрес должен быть на boris\.bln/);
  await admin.post('/api/admin/search/crawl', { rounds: 1 });
  assert.equal((await search(client(app), 'багеты')).results[0].url, 'http://boris.bln/about.html');
  assert.equal((await boris.gov.get(`/api/search/webmaster/sites/${borisSite}`)).site.robots.status, 200);

  const ins = await boris.gov.post(`/api/search/webmaster/sites/${borisSite}/inspect`, { url: 'http://boris.bln/secret/plan.html' });
  assert.equal(ins.robots.allowed, false);
  assert.equal(ins.live.status, 200);
  assert.equal(ins.index.status, 'excluded');
});

let borisCamp;
test('реклама: пополнение, аукцион второй цены с качеством, бюджет, повторный клик бесплатен', async () => {
  const total0 = await totalBalance();
  for (const p of [boris, anna]) {
    const t = await p.gov.post('/api/search/ads/topup', { amount: 5000 });
    await pay(p, t.invoice);
  }
  assert.equal((await boris.gov.get('/api/search/ads/account')).account.balance, 5000);
  await assert.rejects(boris.gov.post('/api/search/ads/campaigns', { name: 'x', title: 'x', text: 'x', url: 'http://boris.bln/', keywords: ['хлеб'], bid: 10, daily_budget: 1000 }), /Ставка/);
  borisCamp = (await boris.gov.post('/api/search/ads/campaigns', { name: 'Хлеб', title: 'Пекарня Бориса', text: 'Свежий хлеб с доставкой', url: 'http://boris.bln/', keywords: ['хлеб', 'пирожки'], negatives: ['бесплатно'], bid: 100, daily_budget: 150, network: true })).id;
  await (anna.gov.post('/api/search/ads/campaigns', { name: 'Блог', title: 'Блог Анны', text: 'Где купить хлеб', url: 'http://anna.bln/', keywords: ['купить хлеб'], bid: 200, daily_budget: 1000, network: false })).id;

  const c = client(app);
  let r = await search(c, 'где купить хлеб');
  assert.deepEqual(r.ads.map((a) => a.title), ['Блог Анны', 'Пекарня Бориса']);
  const imp = await one('SELECT price FROM search_ad_impressions WHERE token = ?', [r.ads[0].token]);
  assert.equal(Number(imp.price), 101, 'вторая цена: ранг следующего / качество + 1');
  assert.equal(Number((await one('SELECT price FROM search_ad_impressions WHERE token = ?', [r.ads[1].token])).price), 50, 'последнему — минимальная ставка');
  assert.equal((await search(c, 'хлеб бесплатно')).ads.length, 0, 'минус-слово и неподходящая фраза');
  assert.equal((await search(c, 'купить')).ads.length, 0, 'фраза «купить хлеб» должна быть в запросе целиком');

  const k = await c.post('/api/search/ads/click', { token: r.ads[0].token });
  assert.equal(k.url, 'http://anna.bln/');
  assert.equal(k.charged, 101);
  r = await search(c, 'купить хлеб');
  const k2 = await c.post('/api/search/ads/click', { token: r.ads.find((a) => a.title === 'Блог Анны').token });
  assert.equal(k2.charged, 0, 'тот же посетитель в те же сутки — без списания');
  assert.equal((await anna.gov.get('/api/search/ads/account')).account.balance, 4899);
  // Дневной бюджет Бориса 150 при ставке 100 и цене 50: после двух кликов объявление больше не показывается.
  for (const ip of ['10.7.0.1', '10.7.0.2']) {
    const res = JSON.parse((await app.inject({ method: 'GET', url: '/api/search/search?q=пирожки', remoteAddress: ip })).body);
    const ad = res.ads.find((a) => a.title === 'Пекарня Бориса');
    await app.inject({ method: 'POST', url: '/api/search/ads/click', payload: { token: ad.token }, remoteAddress: ip });
  }
  assert.equal((await search(client(app), 'пирожки')).ads.length, 0, 'дневной бюджет исчерпан');
  now += 86400;
  assert.equal((await search(client(app), 'пирожки')).ads.length, 1, 'новые сутки — снова показывается');
  assert.equal(await totalBalance(), total0, 'деньги не появляются из воздуха');
  const st = await boris.gov.get(`/api/search/ads/campaigns/${borisCamp}`);
  assert.equal(st.campaign.clicks, 2);
  assert.ok(st.stats.keywords.some((x) => x.keyword === 'пирожки'));
});

test('рекламная сеть: объявление на сайте Анны, доля сайта, выплата в конце месяца', async () => {
  const site = (await anna.gov.post('/api/search/webmaster/sites', { host: 'anna.bln' })).id;
  const v = (await anna.gov.get(`/api/search/webmaster/sites/${site}`)).site;
  await anna.gov.put(`${files['anna.bln']}/file`, { path: `vlodpoisk-${v.instructions.file.url.split('vlodpoisk-')[1].replace('.html', '')}.html`, content: v.instructions.file.content });
  assert.equal((await anna.gov.post(`/api/search/webmaster/sites/${site}/verify`, { method: 'file' })).ok, true);
  const o = await dev.post('/api/net/open', { client_id: DEV, url: 'http://anna.bln/' });
  let serve = await app.inject({ method: 'POST', url: '/api/search/adnet/serve', payload: JSON.stringify({ ticket: o.ticket, path: '/' }), headers: { 'content-type': 'text/plain', origin: 'null' } });
  assert.equal(JSON.parse(serve.body).ad, null, 'сеть не включена');
  await anna.gov.patch(`/api/search/webmaster/sites/${site}`, { adnet: true });
  serve = await app.inject({ method: 'POST', url: '/api/search/adnet/serve', payload: JSON.stringify({ ticket: o.ticket, path: '/' }), headers: { 'content-type': 'text/plain', origin: 'null' } });
  assert.equal(serve.statusCode, 200, 'песочнице сайта путь сети открыт');
  const ad = JSON.parse(serve.body).ad;
  assert.equal(ad.title, 'Пекарня Бориса', 'по содержимому страницы (хлеб); свои объявления Анне не показываются');
  const before = await bal(anna.cur.id);
  const k = await app.inject({ method: 'POST', url: '/api/search/adnet/click', payload: JSON.stringify({ ticket: o.ticket, token: ad.token }), headers: { 'content-type': 'text/plain', origin: 'null' } });
  assert.equal(JSON.parse(k.body).url, 'http://boris.bln/');
  const s = await one('SELECT earned_unpaid FROM search_sites WHERE id = ?', [site]);
  assert.equal(Number(s.earned_unpaid), 34, '68 % от цены клика 50');
  await clock.advance({ force: true });
  assert.equal(await bal(anna.cur.id), before + 34);
  assert.equal(Number((await one('SELECT earned_unpaid FROM search_sites WHERE id = ?', [site])).earned_unpaid), 0);
  // Чужой билет не может кликать по объявлениям этого сайта.
  const ob = await dev.post('/api/net/open', { client_id: DEV, url: 'http://boris.bln/' });
  const bad = await app.inject({ method: 'POST', url: '/api/search/adnet/click', payload: JSON.stringify({ ticket: ob.ticket, token: ad.token }), headers: { 'content-type': 'text/plain' } });
  assert.match(JSON.parse(bad.body).error, /не с этого сайта/);
});

test('Safe Browsing: краулер заподозрил фишинг, админ подтвердил, префиксы и полные хеши, выдача и реклама', async () => {
  const list = await admin.get('/api/admin/search/safe');
  const sus = list.list.find((x) => x.expr === 'anna.bln/');
  assert.equal(sus.status, 'suspected');
  assert.equal(sus.source, 'auto');
  assert.equal((await client(app).get('/api/search/sb/prefixes')).prefixes.length, 0, 'подозрение не попадает в браузеры');
  await admin.patch(`/api/admin/search/safe/${sus.id}`, { status: 'confirmed' });
  const hash = crypto.createHash('sha256').update('anna.bln/').digest('hex');
  const pre = await client(app).get('/api/search/sb/prefixes');
  assert.deepEqual(pre.prefixes, [hash.slice(0, 8)]);
  const full = await client(app).post('/api/search/sb/find', { prefixes: [hash.slice(0, 8), 'deadbeef'] });
  assert.deepEqual(full.matches, [{ hash, threat: 'phishing' }]);
  const r = await search(client(app), 'хлеб');
  assert.ok(!r.results.some((x) => x.host === 'anna.bln'), 'опасный сайт убран из выдачи');
  assert.ok(!r.ads.some((a) => a.url.includes('anna.bln')));
  await assert.rejects(boris.gov.post('/api/search/ads/campaigns', { name: 'x', title: 'x', text: 'x', url: 'http://anna.bln/login.html', keywords: ['x'], bid: 100, daily_budget: 100 }), /опасных/);
  await client(app).post('/api/search/sb/report', { url: 'http://boris.bln/secret/plan.html', threat: 'phishing', comment: 'странно' });
  assert.equal((await admin.get('/api/admin/search/safe')).reports.length, 1);
  await admin.patch(`/api/admin/search/safe/${sus.id}`, { status: 'cleared' });
  assert.equal((await client(app).get('/api/search/sb/prefixes')).prefixes.length, 0);
});
