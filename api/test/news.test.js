// Этап Н10: БалНовости — госновости от админа, СМИ игрока (редакция и RSS-лента с его сайта по сети БалНета),
// автосводка экономики по игровому месяцу, вертикаль «Новости» ВлодПоиска, блокировка СМИ.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setup, client, pool } from './helpers.js';

let app;
let clock;
const now = 70000;
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

let admin;
let boris;
let files;

test('parseFeed: RSS 2.0 и Atom', async () => {
  const { parseFeed } = await import('../src/lib/news.js');
  const rss = parseFeed('<rss><channel><title>Т</title><item><title><![CDATA[Хлеб &amp; соль]]></title><link>http://a.bln/1</link><guid>g1</guid><description>&lt;b&gt;Свежий&lt;/b&gt; хлеб</description></item></channel></rss>');
  assert.equal(rss.items[0].title, 'Хлеб & соль');
  assert.equal(rss.items[0].summary, 'Свежий хлеб');
  const atom = parseFeed('<feed><title>A</title><entry><title>Запись</title><id>urn:1</id><link rel="alternate" href="http://a.bln/e"/><summary>текст</summary></entry></feed>');
  assert.deepEqual([atom.items[0].guid, atom.items[0].link], ['urn:1', 'http://a.bln/e']);
  assert.equal(parseFeed('<html>не лента</html>'), null);
});

test('госновость от админа, лента и статья', async () => {
  admin = client(app);
  await admin.post('/api/auth/gov/register', { email: 'admin@test.bf', password: 'password123', display_name: 'Админ' });
  await admin.patch('/api/admin/settings', { fraud_threshold: 0, fraud_velocity: 0, fraud_multiplier: 0, start_balance: 200000, transfer_fee_bp: 0, transfer_fee_min: 0, vat_bp: 0 });
  const r = await admin.post('/api/admin/news/articles', { title: 'Открыт новый мост через Влоду', summary: 'Мост соединил два района', body: 'Подробности открытия.', category: 'society', pinned: true });
  const anon = client(app);
  const f = await anon.get('/api/news/feed');
  assert.equal(f.articles[0].id, r.article.id);
  assert.equal(f.articles[0].outlet.kind, 'gov');
  assert.equal(f.articles[0].pinned, true);
  assert.equal((await anon.get(`/api/news/articles/${r.article.id}`)).article.body, 'Подробности открытия.');
  const s = await anon.get(`/api/search/search?q=${encodeURIComponent('мост')}&tab=news`);
  assert.ok(JSON.stringify(s).includes('novosti.bln/a/'), 'статья во вертикали новостей');
  await assert.rejects(anon.post('/api/admin/news/articles', { title: 'xxx', body: 'y' }));
});

test('СМИ игрока: своя статья и RSS-лента с сайта', async () => {
  boris = await player('boris@test.bf', 'Борис Пекарев');
  const pay = (number) => boris.bank.post(`/api/bank/invoices/${number}/pay`, { account_id: boris.cur.id });
  const plan = await admin.post('/api/admin/net/hosting/plans', { server_id: 1, name: 'Тест', disk_mb: 5, max_sites: 3, price_month: 0 });
  const d = await boris.gov.post('/api/gov/domains', { name: 'boris.bln' });
  await pay(d.invoice);
  const acc = await boris.gov.post('/api/gov/hosting', { plan_id: plan.id, months: 3 });
  const site = await boris.gov.post(`/api/gov/hosting/${acc.account_id}/sites`, { host: 'boris.bln' });
  const dom = (await boris.gov.get('/api/gov/domains')).domains[0];
  await boris.gov.post(`/api/gov/domains/${dom.id}/records`, { name: '@', type: 'A', data: site.ip });
  files = `/api/gov/hosting/${acc.account_id}/sites/${site.id}`;
  await boris.gov.put(`${files}/file`, { path: 'rss.xml', content: '<?xml version="1.0"?><rss version="2.0"><channel><title>Вестник</title><item><title>Новый батон</title><link>http://boris.bln/baton.html</link><guid>baton</guid><description>Батон с изюмом</description></item><item><title>Скидки на пирожки</title><guid>sale</guid></item></channel></rss>' });

  await assert.rejects(boris.gov.post('/api/news/outlets', { slug: 'gov', title: 'Фейк' }), /Адрес редакции/);
  const o = await boris.gov.post('/api/news/outlets', { slug: 'vestnik', title: 'Вестник Бориса', rss_url: 'http://boris.bln/rss.xml' });
  assert.equal(o.outlet.slug, 'vestnik');
  let fetched = await boris.gov.post('/api/news/outlets/vestnik/fetch');
  assert.deepEqual(fetched, { added: 2, error: null });
  fetched = await boris.gov.post('/api/news/outlets/vestnik/fetch');
  assert.equal(fetched.added, 0, 'без дублей');
  const own = await boris.gov.post('/api/news/outlets/vestnik/articles', { title: 'Интервью с пекарем', body: 'Текст интервью', category: 'culture' });
  const page = await client(app).get('/api/news/outlets/vestnik');
  assert.equal(page.articles.length, 3);
  assert.ok(page.articles.some((a) => a.link === 'http://boris.bln/baton.html'));

  await boris.gov.patch('/api/news/outlets/vestnik', { rss_url: 'http://boris.bln/nope.xml' });
  const bad = await boris.gov.post('/api/news/outlets/vestnik/fetch');
  assert.match(bad.error, /404/);

  const anna = await player('anna@test.bf', 'Анна');
  await assert.rejects(anna.gov.post('/api/news/outlets/vestnik/articles', { title: 'Чужое', body: 'x' }), /не ваша/);
  await assert.rejects(anna.gov.delete(`/api/news/articles/${own.article.id}`), /не ваша/);
  await boris.gov.delete(`/api/news/articles/${own.article.id}`);

  await admin.post('/api/admin/news/outlets/vestnik/status', { status: 'blocked' });
  assert.ok(!(await client(app).get('/api/news/feed')).articles.some((a) => a.outlet.slug === 'vestnik'));
  await assert.rejects(boris.gov.post('/api/news/outlets/vestnik/articles', { title: 'Ещё', body: 'x' }), /заблокирована/);
});

test('автосводка экономики за игровой месяц — один раз', async () => {
  await admin.patch('/api/admin/settings', { inflation_bp: 250 });
  const a = await admin.post('/api/admin/news/digest');
  assert.ok(a.article);
  assert.equal((await admin.post('/api/admin/news/digest')).article, null);
  const f = await client(app).get('/api/news/feed?category=economy');
  assert.match(f.articles[0].title, /цены выросли на 2,5%/);
  assert.equal(f.articles[0].outlet.slug, 'economy');
});

test('длина игрового месяца — до реального месяца', async () => {
  await admin.post('/api/admin/clock', { minutes: 43200 });
  assert.equal((await admin.get('/api/admin/overview')).clock.minutes, 43200);
  await assert.rejects(admin.post('/api/admin/clock', { minutes: 50000 }), /44640/);
});
