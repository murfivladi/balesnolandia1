// БалНовости (novosti.bln): статьи редакций (госновости, СМИ игроков), агрегатор RSS/Atom с сайтов БалНета,
// автособытия экономики раз в игровой месяц. Каждая статья попадает во вертикаль «Новости» ВлодПоиска.
import crypto from 'node:crypto';
import { q, one } from '../db.js';
import { bad, notFound, forbidden, str } from './errors.js';
import { gameSeconds, onMonth } from './clock.js';
import { netRequest } from './vhost/respond.js';
import { BOT } from './search/crawler.js';
import { resetIndex } from './search/index.js';
import { splitUrl } from '@bln/shared/balnet-url.js';
import { formatMoney } from '@bln/shared/money.js';

export const NEWS_HOST = 'novosti.bln';
export const CATEGORIES = {
  politics: 'Политика', economy: 'Экономика', society: 'Общество', tech: 'БалНет и технологии', culture: 'Культура', sport: 'Спорт',
};
const SLUG_RE = /^[a-z0-9](?:[a-z0-9-]{1,38}[a-z0-9])$/;
const RESERVED = new Set(['gov', 'economy', 'admin', 'api', 'new', 'feed', 'rss', 'a', 'outlets', 'my']);
const MAX_OUTLETS = 3;
const FEED_ITEMS = 20;
const urlHash = (u) => crypto.createHash('sha256').update(u).digest('hex');

export const articleUrl = (id) => `https://${NEWS_HOST}/a/${id}`;
export const category = (c) => (CATEGORIES[c] ? c : 'society');

// ——— Разбор RSS 2.0 и Atom ———

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
export function decode(s) {
  return String(s ?? '')
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, n) => ENT[n.toLowerCase()] ?? m);
}
export const plain = (s) => decode(decode(s).replace(/<[^>]*>/g, ' ')).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();

function tag(xml, name) {
  const m = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i').exec(xml);
  return m ? m[1] : null;
}
function atomLink(xml) {
  const links = [...xml.matchAll(/<link\b([^>]*)\/?>/gi)].map((m) => m[1]);
  const pickHref = (a) => /href\s*=\s*["']([^"']+)["']/i.exec(a)?.[1];
  const alt = links.find((a) => !/rel\s*=/i.test(a) || /rel\s*=\s*["']alternate["']/i.test(a));
  return alt ? decode(pickHref(alt)) : null;
}

/** Ленты RSS 2.0 и Atom → { title, items: [{ guid, title, link, summary, date }] }. */
export function parseFeed(xml) {
  const text = String(xml || '');
  const atom = /<feed[\s>]/i.test(text) && !/<rss[\s>]/i.test(text);
  const blocks = [...text.matchAll(atom ? /<entry[\s>][\s\S]*?<\/entry>/gi : /<item[\s>][\s\S]*?<\/item>/gi)].map((m) => m[0]);
  if (!blocks.length && !/<(rss|feed|channel)[\s>]/i.test(text)) return null;
  const items = blocks.map((b) => {
    const title = plain(tag(b, 'title'));
    const link = atom ? atomLink(b) : plain(tag(b, 'link'));
    const summary = plain(atom ? tag(b, 'summary') || tag(b, 'content') : tag(b, 'description') || tag(b, 'content:encoded'));
    const guid = plain(atom ? tag(b, 'id') : tag(b, 'guid')) || link || title;
    const dateRaw = plain(atom ? tag(b, 'updated') || tag(b, 'published') : tag(b, 'pubDate') || tag(b, 'dc:date'));
    const date = dateRaw ? Date.parse(dateRaw) : NaN;
    return { guid: guid.slice(0, 255), title: title.slice(0, 200), link: link || null, summary: summary.slice(0, 500), date: Number.isFinite(date) ? date : null };
  }).filter((i) => i.title && i.guid);
  const head = atom ? text : tag(text, 'channel') || text;
  return { title: plain(tag(head.replace(/<(item|entry)[\s>][\s\S]*$/i, ''), 'title')), items };
}

// ——— Статьи ———

async function indexArticle(a, outlet) {
  const url = articleUrl(a.id);
  const now = Number(a.published);
  await q(
    `INSERT INTO search_pages (url, url_hash, host, kind, status, http_status, title, description, body, source, published, first_seen, fetched_at, changed_at, next_fetch)
     VALUES (?, ?, ?, 'article', 'indexed', 200, ?, ?, ?, 'news', ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE title = VALUES(title), description = VALUES(description), body = VALUES(body), status = 'indexed', changed_at = VALUES(changed_at)`,
    [url, urlHash(url), NEWS_HOST, `${a.title} — ${outlet.title}`.slice(0, 300), (a.summary || '').slice(0, 500), `${a.summary || ''} ${a.body || ''} ${outlet.title}`.slice(0, 100000), String(now), now, now, now, Number.MAX_SAFE_INTEGER],
  );
  resetIndex();
}
async function unindexArticle(id) {
  await q("UPDATE search_pages SET status = 'gone' WHERE url_hash = ?", [urlHash(articleUrl(id))]);
  resetIndex();
}

/** Опубликовать статью редакции. Повтор guid — без дубля (null). */
export async function publish(outlet, { guid, title, summary = null, body = null, link = null, category: cat = 'society', author = null, pinned = false, published = null }) {
  const t = published ?? (await gameSeconds());
  const g = String(guid || crypto.randomUUID()).slice(0, 255);
  const r = await q(
    'INSERT IGNORE INTO news_articles (outlet_id, guid, title, summary, body, link, category, author, pinned, published) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    [outlet.id, g, String(title).slice(0, 200), summary ? String(summary).slice(0, 500) : null, body, link, category(cat), author, pinned ? 1 : 0, t],
  );
  if (!r.affectedRows) return null;
  const a = await one('SELECT * FROM news_articles WHERE id = ?', [r.insertId]);
  await indexArticle(a, outlet);
  return a;
}

export async function removeArticle(id) {
  await q('DELETE FROM news_articles WHERE id = ?', [id]);
  await unindexArticle(id);
}

export async function outletBySlug(slug) {
  const o = await one('SELECT * FROM news_outlets WHERE slug = ?', [String(slug || '')]);
  if (!o) throw notFound('Редакция не найдена');
  return o;
}
export const outletView = (o, extra = {}) => ({
  slug: o.slug, title: o.title, description: o.description, kind: o.kind, rss_url: o.rss_url, status: o.status,
  last_fetch: o.last_fetch, last_error: o.last_error, ...extra,
});
export function canEdit(o, govId) {
  if (o.kind !== 'media' || Number(o.owner_gov_id) !== Number(govId)) throw forbidden('Это не ваша редакция');
  if (o.status !== 'active') throw forbidden('Редакция заблокирована');
}

function checkFeedUrl(u) {
  if (!u) return null;
  const p = splitUrl(String(u).trim());
  if (!p || (p.scheme !== 'http' && p.scheme !== 'https')) throw bad('invalid', 'Адрес ленты: http(s)://сайт.bln/rss.xml');
  return `${p.scheme}://${p.host}${p.path}`.slice(0, 600);
}

/** Зарегистрировать СМИ игрока. */
export async function createOutlet(govId, b = {}) {
  const slug = String(b.slug || '').toLowerCase().trim();
  if (!SLUG_RE.test(slug) || RESERVED.has(slug)) throw bad('invalid', 'Адрес редакции: 3–40 латинских букв, цифр и дефисов');
  const n = await one("SELECT COUNT(*) AS n FROM news_outlets WHERE owner_gov_id = ? AND kind = 'media'", [govId]);
  if (Number(n.n) >= MAX_OUTLETS) throw bad('limit', `Не больше ${MAX_OUTLETS} редакций на гражданина`);
  if (await one('SELECT id FROM news_outlets WHERE slug = ?', [slug])) throw bad('taken', 'Этот адрес уже занят');
  const title = str(b.title, 'название', { min: 2, max: 80 });
  const description = b.description ? str(b.description, 'описание', { max: 300 }) : null;
  const r = await q("INSERT INTO news_outlets (slug, title, description, kind, owner_gov_id, rss_url) VALUES (?, ?, ?, 'media', ?, ?)", [slug, title, description, govId, checkFeedUrl(b.rss_url)]);
  return one('SELECT * FROM news_outlets WHERE id = ?', [r.insertId]);
}
export async function updateOutlet(o, b = {}) {
  const title = b.title !== undefined ? str(b.title, 'название', { min: 2, max: 80 }) : o.title;
  const description = b.description !== undefined ? (b.description ? str(b.description, 'описание', { max: 300 }) : null) : o.description;
  const rss = b.rss_url !== undefined ? checkFeedUrl(b.rss_url) : o.rss_url;
  await q('UPDATE news_outlets SET title = ?, description = ?, rss_url = ?, last_error = IF(? <=> rss_url, last_error, NULL) WHERE id = ?', [title, description, rss, rss, o.id]);
  return one('SELECT * FROM news_outlets WHERE id = ?', [o.id]);
}

/** Забрать ленту СМИ по сети БалНета (как агрегатор с сервера novosti.bln). */
export async function fetchFeed(o) {
  if (!o.rss_url) return { added: 0, error: 'У редакции нет адреса ленты' };
  const now = await gameSeconds();
  const fail = async (error) => {
    await q('UPDATE news_outlets SET last_fetch = ?, last_error = ? WHERE id = ?', [now, String(error).slice(0, 300), o.id]);
    return { added: 0, error };
  };
  const r = await netRequest({ fromIp: BOT.clientIp, url: o.rss_url, headers: { 'user-agent': 'BalNovosti/1.0 (+https://novosti.bln)', accept: 'application/rss+xml, application/atom+xml, application/xml' } });
  if (r.error) return fail(r.error);
  if (r.status !== 200) return fail(`Сайт ответил ${r.status}`);
  const feed = parseFeed(r.body);
  if (!feed) return fail('Это не лента RSS или Atom');
  let added = 0;
  for (const it of feed.items.slice(0, FEED_ITEMS).reverse()) {
    const a = await publish(o, { guid: it.guid, title: it.title, summary: it.summary || null, link: it.link, author: o.title, category: 'society', published: now });
    if (a) added++;
  }
  await q('UPDATE news_outlets SET last_fetch = ?, last_error = NULL WHERE id = ?', [now, o.id]);
  return { added, error: null };
}

export async function fetchAllFeeds() {
  const list = await q("SELECT * FROM news_outlets WHERE kind = 'media' AND status = 'active' AND rss_url IS NOT NULL");
  for (const o of list) await fetchFeed(o).catch((e) => console.error('news feed', o.slug, e.message));
}

// ——— Автособытия экономики ———

const pct = (bp) => `${(Number(bp) / 100).toLocaleString('ru-RU', { maximumFractionDigits: 2 })}%`;
async function count(sql, params = []) {
  try { return Number((await one(sql, params))?.n || 0); } catch { return null; }
}

/** Сводка игрового месяца: инфляция, индекс цен, деньги, БалНет. */
export async function economyDigest(month, s = {}) {
  const outlet = await one("SELECT * FROM news_outlets WHERE slug = 'economy'");
  if (!outlet) return null;
  const rate = Number(s.inflation_bp || 0);
  const idx = await one('SELECT index_ppm FROM price_index WHERE month <= ? ORDER BY month DESC LIMIT 1', [month]).catch(() => null);
  const money = await one("SELECT COALESCE(SUM(balance), 0) AS n FROM accounts WHERE status <> 'closed'").catch(() => null);
  const domains = await count("SELECT COUNT(*) AS n FROM domains WHERE status = 'active'");
  const sites = await count("SELECT COUNT(*) AS n FROM hosting_sites s JOIN hosting_accounts a ON a.id = s.account_id WHERE a.status = 'active'");
  const media = await count("SELECT COUNT(*) AS n FROM news_outlets WHERE kind = 'media' AND status = 'active'");
  const lines = [
    `Инфляция за месяц: ${pct(rate)}.`,
    idx ? `Индекс потребительских цен: ${(Number(idx.index_ppm) / 1e4).toLocaleString('ru-RU', { maximumFractionDigits: 2 })} (базовый — 100).` : null,
    money ? `На счетах граждан и компаний: ${formatMoney(Number(money.n))}.` : null,
    domains !== null ? `Действующих доменов в БалНете: ${domains}.` : null,
    sites !== null ? `Сайтов на хостинге: ${sites}.` : null,
    media !== null ? `Независимых СМИ: ${media}.` : null,
  ].filter(Boolean);
  const title = rate > 0 ? `Итоги месяца ${month}: цены выросли на ${pct(rate)}` : rate < 0 ? `Итоги месяца ${month}: цены снизились на ${pct(-rate)}` : `Итоги месяца ${month}: цены не изменились`;
  return publish(outlet, { guid: `month-${month}`, title, summary: lines.slice(0, 2).join(' '), body: lines.join('\n'), category: 'economy', author: 'Автосводка' });
}

onMonth('news', async (month, s) => {
  await economyDigest(month, s);
  await fetchAllFeeds();
});
