// Кабинет вебмастера ВлодПоиска: добавление сайта, подтверждение прав (TXT-запись или HTML-файл), индексация
// и исключённые страницы с причинами, ошибки обхода, запросы (показы, клики, позиция), входящие ссылки,
// robots.txt, sitemap, переобход, проверка адреса, безопасность, рекламная сеть.
import crypto from 'node:crypto';
import { q, one } from '../../db.js';
import { bad, notFound, need } from '../errors.js';
import { getSettings } from '../settings.js';
import { gameSeconds } from '../clock.js';
import { resolve } from '../dns.js';
import { isHostLike, splitUrl, GOV_SITES } from '@bln/shared/balnet-url.js';
import { BOT, botFetch, requestRecrawl, robotsVerdict, urlHash } from './crawler.js';
import { parseHtml } from './text.js';
import { issuesFor } from './safe.js';

const DAY = 86400;
const parse = (v, d = null) => (v == null ? d : typeof v === 'string' ? JSON.parse(v) : v);
export const TXT_PREFIX = 'vlodpoisk-verification=';

export async function addSite(govUserId, rawHost) {
  const host = String(rawHost || '').trim().toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/\.$/, '');
  need(host && isHostLike(host) && !/^\d+(\.\d+){3}$/.test(host), 'Укажите имя сайта, например shop.bln');
  need(!GOV_SITES[host], 'Это госсайт');
  const ex = await one('SELECT id FROM search_sites WHERE gov_user_id = ? AND host = ?', [govUserId, host]);
  if (ex) return ex.id;
  const token = crypto.randomBytes(12).toString('hex');
  const r = await q('INSERT INTO search_sites (gov_user_id, host, token) VALUES (?, ?, ?)', [govUserId, host, token]);
  return r.insertId;
}

export async function ownSite(id, govUserId) {
  const s = await one('SELECT * FROM search_sites WHERE id = ? AND gov_user_id = ?', [id, govUserId]);
  if (!s) throw notFound('Сайт не найден');
  return s;
}

export function instructions(s) {
  return {
    dns: { record: s.host, type: 'TXT', value: `${TXT_PREFIX}${s.token}` },
    file: { url: `http://${s.host}/vlodpoisk-${s.token}.html`, content: `vlodpoisk-verification: ${s.token}` },
  };
}

/** Проверка прав: TXT на имени сайта или файл в корне (по https, потом по http). */
export async function verifySite(s, method) {
  let ok = false;
  let error = null;
  if (method === 'dns') {
    const r = await resolve({ resolverIp: BOT.resolverIp, clientIp: BOT.clientIp, clientProviderId: null, name: s.host, type: 'TXT', fresh: true });
    const vals = r.answer.filter((x) => x.type === 'TXT').map((x) => String(x.data).replace(/^"|"$/g, ''));
    ok = vals.includes(`${TXT_PREFIX}${s.token}`);
    if (!ok) error = vals.length ? `У ${s.host} есть TXT-записи, но нужной среди них нет` : `TXT-запись у ${s.host} не найдена (${r.rcode}). Подождите, пока истечёт TTL старых ответов`;
  } else if (method === 'file') {
    for (const scheme of ['https', 'http']) {
      const r = await botFetch(`${scheme}://${s.host}/vlodpoisk-${s.token}.html`, { fresh: true });
      if (r.status === 200 && String(r.body || '').includes(s.token)) { ok = true; break; }
      error = r.error ? `${scheme}: ${r.error}` : `${scheme}://${s.host}/vlodpoisk-${s.token}.html — ответ ${r.status}`;
    }
  } else throw bad('method', 'Способ: dns или file');
  if (ok) {
    await q('UPDATE search_sites SET verified_at = ?, method = ? WHERE id = ?', [await gameSeconds(), method, s.id]);
    await requestRecrawl(`http://${s.host}/`).catch(() => null);
  }
  return { ok, error };
}

/** Права проверяются заново: TXT убрали или файл удалили — права пропадают (как у Search Console). */
async function stillVerified(s) {
  if (!s.verified_at) return false;
  const now = await gameSeconds();
  if (now - Number(s.verified_at) < 7 * DAY) return true;
  const r = await verifySite(s, s.method || 'dns');
  if (!r.ok) await q('UPDATE search_sites SET verified_at = NULL, adnet = 0 WHERE id = ?', [s.id]);
  return r.ok;
}

const hostWhere = '(host = ? OR host = ?)';
const hostArgs = (s) => [s.host, `www.${s.host}`];

export async function siteView(s) {
  const base = { id: s.id, host: s.host, verified: !!s.verified_at, method: s.method, instructions: instructions(s), adnet: !!s.adnet };
  if (!(await stillVerified(s))) return { ...base, verified: false };
  const now = await gameSeconds();
  const day = Math.floor(now / DAY);
  const pages = await q(`SELECT id, url, status, http_status, reason, title, fetched_at, next_fetch, pagerank, inlinks, source FROM search_pages WHERE ${hostWhere} ORDER BY status = 'indexed' DESC, pagerank DESC, id LIMIT 500`, hostArgs(s));
  const counts = {};
  for (const p of pages) counts[p.status] = (counts[p.status] || 0) + 1;
  const queries = await q(`SELECT qnorm, SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(pos_sum) AS pos_sum FROM search_stats WHERE ${hostWhere} AND day > ? GROUP BY qnorm ORDER BY impressions DESC LIMIT 50`, [...hostArgs(s), day - 30]);
  const daily = await q(`SELECT day, SUM(impressions) AS impressions, SUM(clicks) AS clicks FROM search_stats WHERE ${hostWhere} AND day > ? GROUP BY day ORDER BY day`, [...hostArgs(s), day - 14]);
  const links = await q(`SELECT f.host, COUNT(*) AS n FROM search_links l JOIN search_pages f ON f.id = l.from_id WHERE l.to_host IN (?, ?) AND f.host NOT IN (?, ?) AND f.status = 'indexed' GROUP BY f.host ORDER BY n DESC LIMIT 30`, [...hostArgs(s), ...hostArgs(s)]);
  const robots = await one('SELECT * FROM search_robots WHERE host = ?', [s.host]);
  const set = await getSettings();
  const adnet = await one("SELECT COUNT(*) AS impressions, COALESCE(SUM(clicked), 0) AS clicks FROM search_ad_impressions WHERE site_id = ? AND placement = 'network'", [s.id]);
  return {
    ...base,
    now,
    counts,
    pages: pages.map((p) => ({ ...p, pagerank: Math.round(Number(p.pagerank) * 100) / 100 })),
    queries: queries.map((r) => ({ q: r.qnorm, impressions: Number(r.impressions), clicks: Number(r.clicks), ctr: Number(r.impressions) ? Math.round((Number(r.clicks) / Number(r.impressions)) * 1000) / 10 : 0, position: Number(r.impressions) ? Math.round((Number(r.pos_sum) / Number(r.impressions)) * 10) / 10 : null })),
    daily: daily.map((r) => ({ day: r.day, impressions: Number(r.impressions), clicks: Number(r.clicks) })),
    links: links.map((r) => ({ host: r.host, n: Number(r.n) })),
    robots: robots ? { status: Number(robots.status), body: robots.body, fetched_at: Number(robots.fetched_at) } : null,
    sitemaps: parse(s.sitemaps, []),
    recrawl: { limit: Number(set.search_recrawl_daily || 10), used: Number(s.recrawl_day) === day ? Number(s.recrawl_used) : 0 },
    security: await issuesFor(s.host),
    review_requested: !!s.review_requested,
    adnet_stats: { impressions: Number(adnet.impressions), clicks: Number(adnet.clicks), earned_unpaid: Number(s.earned_unpaid), earned_total: Number(s.earned_total), share_bp: Number(set.ad_network_share_bp || 0) },
    snippet: `<ins class="vlodads" data-format="auto"></ins>`,
  };
}

async function needVerified(s) {
  need(await stillVerified(s), 'Сначала подтвердите права на сайт');
}

function ownUrl(s, url) {
  const p = splitUrl(String(url || '').trim());
  need(p && (p.scheme === 'http' || p.scheme === 'https'), 'Нужен полный адрес: https://сайт/страница');
  need(p.host === s.host || p.host === `www.${s.host}` || p.host.endsWith(`.${s.host}`), `Адрес должен быть на ${s.host}`);
  return `${p.scheme}://${p.host}${p.path.split('#')[0]}`;
}

export async function recrawl(s, url) {
  await needVerified(s);
  const u = ownUrl(s, url);
  const set = await getSettings();
  const day = Math.floor((await gameSeconds()) / DAY);
  const used = Number(s.recrawl_day) === day ? Number(s.recrawl_used) : 0;
  need(used < Number(set.search_recrawl_daily || 10), `Лимит переобхода — ${set.search_recrawl_daily} адресов в игровые сутки`);
  await q('UPDATE search_sites SET recrawl_day = ?, recrawl_used = ? WHERE id = ?', [day, used + 1, s.id]);
  await requestRecrawl(u);
  return { ok: true, url: u, left: Number(set.search_recrawl_daily) - used - 1 };
}

/** Проверка адреса: что видит робот прямо сейчас и что в индексе. */
export async function inspect(s, url) {
  await needVerified(s);
  const u = ownUrl(s, url);
  const p = splitUrl(u);
  const robots = await one('SELECT * FROM search_robots WHERE host = ?', [p.host]);
  const live = await botFetch(u, { fresh: true });
  const page = await one('SELECT status, http_status, reason, title, fetched_at, canonical, inlinks, pagerank FROM search_pages WHERE url_hash = ?', [urlHash(u)]);
  let doc = null;
  if (live.status === 200 && live.type?.startsWith('text/html')) {
    const d = parseHtml(live.body, u);
    doc = { title: d.title, description: d.description, noindex: d.noindex, nofollow: d.nofollow, canonical: d.canonical, links: d.links.length, images: d.images.length };
  }
  return {
    url: u,
    robots: robotsVerdict(robots, p.path),
    live: { status: live.status, error: live.error || null, note: live.note || null, type: live.type || null, location: live.location || null, ip: live.ip || null, doc },
    index: page ? { ...page, pagerank: Math.round(Number(page.pagerank) * 100) / 100 } : null,
  };
}

export async function addSitemap(s, url) {
  await needVerified(s);
  const u = ownUrl(s, url);
  const list = parse(s.sitemaps, []);
  if (!list.includes(u)) list.push(u);
  await q('UPDATE search_sites SET sitemaps = ? WHERE id = ?', [JSON.stringify(list.slice(-10)), s.id]);
  await q('DELETE FROM search_robots WHERE host = ?', [s.host]); // при следующем заходе робот прочитает карты сайта
  return { sitemaps: list };
}

export async function setAdnet(s, on) {
  await needVerified(s);
  await q('UPDATE search_sites SET adnet = ? WHERE id = ?', [on ? 1 : 0, s.id]);
}

export async function requestReview(s) {
  await needVerified(s);
  need((await issuesFor(s.host)).length, 'Проблем безопасности нет');
  await q('UPDATE search_sites SET review_requested = 1 WHERE id = ?', [s.id]);
}

/** Сайт рекламной сети по хосту (подтверждённый, с включённой рекламой). */
export async function adnetSite(host) {
  const h = String(host || '').replace(/^www\./, '');
  return one('SELECT * FROM search_sites WHERE host = ? AND verified_at IS NOT NULL AND adnet = 1 ORDER BY id LIMIT 1', [h]);
}
