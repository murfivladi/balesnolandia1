// Краулер ВлодПоиска (VlodBot). Ходит по БалНету как обычный клиент: DNS через публичный резолвер, подключение
// к серверу со своего адреса 50.1.0.20, TLS с проверкой цепочки, robots.txt и sitemap, редиректы, коды ответа.
// Очередь по приоритету (переобход, PageRank, новые сайты) и адаптивный интервал: часто меняется — чаще заходим.
import crypto from 'node:crypto';
import { q, one } from '../../db.js';
import { netRequest } from '../vhost/respond.js';
import { gameSeconds, isPaused } from '../clock.js';
import { getSettings } from '../settings.js';
import { splitUrl, GOV_SITES } from '@bln/shared/balnet-url.js';
import { parseHtml, parseRobots, robotsAllows, parseSitemap } from './text.js';
import { GOV_PAGES } from './govpages.js';
import { autoFlag } from './safe.js';

export const BOT = { clientIp: '50.1.0.20', resolverIp: '50.0.0.53', agent: 'VlodBot/1.0 (+https://poisk.bln/webmaster)' };
const DAY = 86400;
const MIN_INTERVAL = DAY / 4;
const MAX_INTERVAL = 14 * DAY;
const MAX_PAGES_PER_HOST = 500;

export const urlHash = (url) => crypto.createHash('sha256').update(url).digest('hex');

const indexListeners = [];
/** Индекс подписывается на изменения: после обхода его надо перестроить. */
export function onIndexChange(fn) { indexListeners.push(fn); }
function changed() { for (const fn of indexListeners) fn(); }

/**
 * Запрос робота: { status, type, body, location, error, gov, ip }.
 * status 0 — до HTTP не дошло (error — код как в Chrome). Сайты на виртуальном тарифе отвечают своим server.js.
 */
export async function botFetch(url, { fresh = false, binary = false } = {}) {
  const r = await netRequest({ fromIp: BOT.clientIp, url, method: 'GET', headers: { 'user-agent': BOT.agent }, follow: false, binary, fresh });
  if (r.gov) return { status: 200, gov: true, ip: r.ip };
  if (r.error) return { status: 0, error: r.error, note: r.note || null, ip: r.ip || null };
  const type = r.headers['content-type'] || '';
  const out = { status: r.notFound ? 404 : r.status, ip: r.ip, type, siteId: r.siteId };
  if (r.headers.location) out.location = new URL(r.headers.location, url).href;
  if (binary) out.buf = r.buf;
  else out.body = type.startsWith('text/') || type.includes('xml') || type.includes('json') ? r.body : '';
  return out;
}

// ——— Страницы и очередь ———

/** Поставить адрес в очередь (если его ещё нет). Возвращает id страницы. */
export async function enqueue(url, { source = 'link', priority = 0, now = null } = {}) {
  const p = splitUrl(url);
  if (!p || (p.scheme !== 'http' && p.scheme !== 'https') || url.length > 600) return null;
  if (GOV_SITES[p.host] || GOV_SITES[p.host.replace(/^www\./, '')]) return null; // госсайты — из пререндера
  const hash = urlHash(url);
  const ex = await one('SELECT id, priority FROM search_pages WHERE url_hash = ?', [hash]);
  if (ex) {
    if (priority > ex.priority) await q('UPDATE search_pages SET priority = ? WHERE id = ?', [priority, ex.id]);
    return ex.id;
  }
  const n = await one('SELECT COUNT(*) AS n FROM search_pages WHERE host = ?', [p.host]);
  if (Number(n.n) >= MAX_PAGES_PER_HOST) return null;
  const t = now ?? (await gameSeconds());
  const r = await q('INSERT IGNORE INTO search_pages (url, url_hash, host, source, priority, first_seen, next_fetch) VALUES (?, ?, ?, ?, ?, ?, 0)', [url, hash, p.host, source, priority, t]);
  return r.insertId || (await one('SELECT id FROM search_pages WHERE url_hash = ?', [hash]))?.id || null;
}

/** Переобойти адрес как можно скорее (кнопка вебмастера). */
export async function requestRecrawl(url) {
  const id = await enqueue(url, { source: 'webmaster', priority: 100 });
  if (!id) return null;
  await q('UPDATE search_pages SET priority = 100, next_fetch = 0 WHERE id = ?', [id]);
  const host = splitUrl(url).host;
  await q('DELETE FROM search_robots WHERE host = ?', [host]);
  return id;
}

let govSeeded = false;
/** Посев: корни сайтов хостинга (как зона .bln у поисковика) и пререндер госсайтов. */
export async function seed() {
  const now = await gameSeconds();
  if (!govSeeded) {
    for (const [url, title, description, body] of GOV_PAGES) {
      const host = splitUrl(url).host;
      await q(
        `INSERT INTO search_pages (url, url_hash, host, kind, status, http_status, title, description, body, source, first_seen, fetched_at, changed_at, next_fetch)
         VALUES (?, ?, ?, 'gov', 'indexed', 200, ?, ?, ?, 'gov', ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE title = VALUES(title), description = VALUES(description), body = VALUES(body), kind = 'gov', status = 'indexed'`,
        [url, urlHash(url), host, title, description, `${description} ${body}`, now, now, now, Number.MAX_SAFE_INTEGER],
      );
    }
    govSeeded = true;
    changed();
  }
  const sites = await q("SELECT s.host, s.cert_id FROM hosting_sites s JOIN hosting_accounts a ON a.id = s.account_id WHERE a.status = 'active'");
  for (const s of sites) {
    const url = `${s.cert_id ? 'https' : 'http'}://${s.host}/`;
    if (!(await one('SELECT id FROM search_pages WHERE host = ? LIMIT 1', [s.host]))) await enqueue(url, { source: 'seed', priority: 10, now });
  }
}
export function resetCrawler() { govSeeded = false; }

// ——— robots.txt и sitemap ———

async function robotsFor(scheme, host, now) {
  const row = await one('SELECT * FROM search_robots WHERE host = ?', [host]);
  if (row && now - Number(row.fetched_at) < DAY) return row;
  const r = await botFetch(`${scheme}://${host}/robots.txt`);
  // 4xx — роботу всё можно; нет ответа или 5xx — временно ничего нельзя (как у Google).
  const status = r.status || 0;
  const body = status === 200 ? String(r.body || '').slice(0, 60000) : null;
  await q('INSERT INTO search_robots (host, fetched_at, status, body) VALUES (?, ?, ?, ?) ON DUPLICATE KEY UPDATE fetched_at = VALUES(fetched_at), status = VALUES(status), body = VALUES(body)', [host, now, status, body]);
  // Сайтмапы: из robots.txt, стандартный /sitemap.xml и добавленные в кабинете вебмастера.
  const maps = new Set(body ? parseRobots(body).sitemaps : []);
  maps.add(`${scheme}://${host}/sitemap.xml`);
  for (const s of await q('SELECT sitemaps FROM search_sites WHERE host = ? AND verified_at IS NOT NULL', [host])) {
    for (const u of (typeof s.sitemaps === 'string' ? JSON.parse(s.sitemaps) : s.sitemaps) || []) maps.add(u);
  }
  for (const m of [...maps].slice(0, 5)) await readSitemap(m, now, 0);
  return { host, fetched_at: now, status, body };
}

async function readSitemap(url, now, depth) {
  const r = await botFetch(url);
  if (r.status !== 200 || !r.body) return 0;
  const sm = parseSitemap(r.body);
  let n = 0;
  for (const loc of sm.locs.slice(0, 1000)) {
    if (sm.index) { if (depth < 1) n += await readSitemap(loc, now, depth + 1); continue; }
    if (await enqueue(loc, { source: 'sitemap', priority: 3, now })) n++;
  }
  return n;
}

export function robotsVerdict(row, path) {
  if (!row) return { allowed: true, rule: null };
  const st = Number(row.status);
  if (st === 200) return robotsAllows(parseRobots(row.body), path);
  if (st >= 400 && st < 500) return { allowed: true, rule: null };
  return { allowed: false, rule: 'robots.txt недоступен — обход отложен' };
}

// ——— Обход страницы ———

const nextIn = (page, isChanged) => {
  const cur = Number(page.crawl_interval) || DAY;
  return Math.round(isChanged ? Math.max(MIN_INTERVAL, cur / 2) : Math.min(MAX_INTERVAL, cur * 1.5));
};

async function setPage(id, fields) {
  const keys = Object.keys(fields);
  await q(`UPDATE search_pages SET ${keys.map((k) => `\`${k}\` = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => fields[k]), id]);
}

/** Обойти одну страницу. Возвращает итог для журнала. */
export async function crawlPage(page, now) {
  const p = splitUrl(page.url);
  const robots = await robotsFor(p.scheme, p.host, now);
  const rv = robotsVerdict(robots, p.path);
  if (!rv.allowed) {
    await setPage(page.id, { status: 'excluded', reason: `Запрещено в robots.txt (${rv.rule})`, fetched_at: now, next_fetch: now + DAY, priority: 0 });
    return 'robots';
  }
  const r = await botFetch(page.url);
  const base = { fetched_at: now, http_status: r.status || null, priority: 0 };
  if (r.gov) {
    await setPage(page.id, { ...base, status: 'excluded', reason: 'Госсайт — индексируется по пререндеру', next_fetch: now + MAX_INTERVAL });
    return 'gov';
  }
  if (r.error || r.status >= 500 || r.status === 403 || r.status === 429) {
    const fails = Number(page.fails) + 1;
    const reason = r.error ? `${r.error}${r.note ? ` — ${r.note}` : ''}` : r.status === 403 ? '403 — сайт приостановлен' : r.status === 429 ? '429 — сайт ограничил частоту запросов' : `${r.status} — ошибка сервера`;
    // Временная ошибка: проиндексированная страница остаётся в выдаче ещё два обхода.
    const keep = page.status === 'indexed' && fails < 3;
    await setPage(page.id, { ...base, fails, reason, status: keep ? 'indexed' : 'error', next_fetch: now + Math.min(MAX_INTERVAL, MIN_INTERVAL * 2 ** fails) });
    return 'error';
  }
  if ([301, 302, 303, 307, 308].includes(r.status) && r.location) {
    await setPage(page.id, { ...base, fails: 0, status: 'redirect', redirect_to: r.location, reason: `Переадресация на ${r.location}`, next_fetch: now + MAX_INTERVAL });
    await enqueue(r.location, { source: 'link', priority: Number(page.priority) || 1, now });
    await dropLinks(page.id);
    return 'redirect';
  }
  if (r.status === 404 || r.status === 410) {
    await setPage(page.id, { ...base, fails: 0, status: 'gone', reason: `${r.status} — страница не найдена`, next_fetch: now + MAX_INTERVAL, body: null });
    await dropLinks(page.id);
    return 'gone';
  }
  if (!r.type?.startsWith('text/html') && !r.type?.startsWith('text/plain')) {
    await setPage(page.id, { ...base, fails: 0, status: 'excluded', reason: `Не страница (${(r.type || '').split(';')[0]})`, next_fetch: now + MAX_INTERVAL });
    return 'excluded';
  }
  const hash = crypto.createHash('sha256').update(r.body || '').digest('hex');
  const isChanged = hash !== page.content_hash;
  const interval = nextIn(page, isChanged || !page.content_hash);
  if (!isChanged && page.status === 'indexed') {
    await setPage(page.id, { ...base, fails: 0, next_fetch: now + interval, crawl_interval: interval });
    return 'same';
  }
  if (r.type.startsWith('text/plain')) {
    const name = decodeURIComponent(p.path.split('/').pop() || p.path);
    await setPage(page.id, { ...base, fails: 0, status: 'indexed', reason: null, title: name.slice(0, 300), description: null, headings: null, body: String(r.body).slice(0, 100000), content_hash: hash, changed_at: now, next_fetch: now + interval, crawl_interval: interval, kind: 'web' });
    return 'indexed';
  }
  const doc = parseHtml(r.body, page.url);
  const common = { ...base, fails: 0, content_hash: hash, changed_at: now, next_fetch: now + interval, crawl_interval: interval };
  if (!doc.nofollow) await saveLinks(page, doc.links, now);
  else await dropLinks(page.id);
  if (doc.hasPassword) await autoFlag(page.url, doc);
  if (doc.noindex) {
    await setPage(page.id, { ...common, status: 'excluded', reason: 'Запрещено мета-тегом robots: noindex', body: null });
    return 'excluded';
  }
  if (doc.canonical && doc.canonical !== page.url) {
    await setPage(page.id, { ...common, status: 'excluded', canonical: doc.canonical, reason: `Канонический адрес — ${doc.canonical}`, body: null });
    await enqueue(doc.canonical, { source: 'link', priority: 2, now });
    return 'excluded';
  }
  await setPage(page.id, {
    ...common,
    status: 'indexed', reason: null, canonical: doc.canonical,
    title: doc.title || null, description: doc.description || null, headings: doc.headings || null,
    body: [doc.keywords, doc.text].filter(Boolean).join(' ').slice(0, 100000), lang: doc.lang,
    kind: doc.article ? 'article' : 'web', published: doc.published,
  });
  await q('DELETE FROM search_images WHERE page_id = ?', [page.id]);
  for (const img of doc.images) await q('INSERT INTO search_images (page_id, src, alt) VALUES (?, ?, ?)', [page.id, img.src.slice(0, 600), img.alt]);
  return 'indexed';
}

async function dropLinks(pageId) {
  await q('DELETE FROM search_links WHERE from_id = ?', [pageId]);
  await q('DELETE FROM search_images WHERE page_id = ?', [pageId]);
}

async function saveLinks(page, links, now) {
  await q('DELETE FROM search_links WHERE from_id = ?', [page.id]);
  const seen = new Set();
  const rows = [];
  for (const l of links) {
    if (seen.has(l.url) || l.url.length > 600) continue;
    seen.add(l.url);
    const host = splitUrl(l.url)?.host;
    if (!host) continue;
    rows.push([page.id, urlHash(l.url), host, l.anchor.slice(0, 200), l.nofollow ? 1 : 0]);
    if (!l.nofollow) await enqueue(l.url, { source: 'link', priority: 1, now });
  }
  if (rows.length) await q('INSERT INTO search_links (from_id, to_hash, to_host, anchor, nofollow) VALUES ?', [rows]);
}

// ——— PageRank ———

/** PageRank по ссылочному графу проиндексированных страниц (d = 0.85). Средний ранг = 1. */
export async function computePageRank() {
  const nodes = await q("SELECT id, url_hash FROM search_pages WHERE status = 'indexed'");
  if (!nodes.length) return 0;
  const idx = new Map(nodes.map((n, i) => [n.url_hash, i]));
  const byId = new Map(nodes.map((n, i) => [n.id, i]));
  const links = await q('SELECT from_id, to_hash FROM search_links WHERE nofollow = 0');
  const out = nodes.map(() => []);
  for (const l of links) {
    const a = byId.get(l.from_id);
    const b = idx.get(l.to_hash);
    if (a === undefined || b === undefined || a === b) continue;
    if (!out[a].includes(b)) out[a].push(b);
  }
  const N = nodes.length;
  const d = 0.85;
  let pr = new Array(N).fill(1 / N);
  for (let it = 0; it < 40; it++) {
    const next = new Array(N).fill((1 - d) / N);
    let dangling = 0;
    for (let i = 0; i < N; i++) {
      if (!out[i].length) { dangling += pr[i]; continue; }
      const share = (d * pr[i]) / out[i].length;
      for (const j of out[i]) next[j] += share;
    }
    for (let i = 0; i < N; i++) next[i] += (d * dangling) / N;
    pr = next;
  }
  const inl = new Array(N).fill(0);
  for (let i = 0; i < N; i++) for (const j of out[i]) inl[j]++;
  for (let k = 0; k < N; k += 200) {
    const chunk = nodes.slice(k, k + 200);
    const ids = chunk.map((n) => n.id);
    const caseP = chunk.map((n, i) => `WHEN ${Number(n.id)} THEN ${(pr[k + i] * N).toFixed(6)}`).join(' ');
    const caseL = chunk.map((n, i) => `WHEN ${Number(n.id)} THEN ${inl[k + i]}`).join(' ');
    await q(`UPDATE search_pages SET pagerank = CASE id ${caseP} END, inlinks = CASE id ${caseL} END WHERE id IN (${ids.join(',')})`);
  }
  changed();
  return N;
}

// ——— Такт краулера ———

let running = false;
let lastRun = { at: null, results: {} };
export const crawlerState = () => ({ running, last: lastRun });

/** Один такт: посев, затем до limit страниц по приоритету (не больше 4 с одного хоста). */
export async function crawlTick({ limit = null } = {}) {
  if (running) return { skipped: true };
  running = true;
  try {
    const s = await getSettings();
    const n = limit ?? Number(s.search_crawl_batch || 12);
    await seed();
    const now = await gameSeconds();
    const due = await q("SELECT * FROM search_pages WHERE kind <> 'gov' AND next_fetch <= ? ORDER BY priority DESC, pagerank DESC, next_fetch, id LIMIT ?", [now, n * 4]);
    const perHost = new Map();
    const results = {};
    let done = 0;
    for (const page of due) {
      if (done >= n) break;
      const c = perHost.get(page.host) || 0;
      if (c >= 4) continue;
      perHost.set(page.host, c + 1);
      let r;
      try { r = await crawlPage(page, now); } catch (e) {
        r = 'crash';
        await setPage(page.id, { status: 'error', reason: `Ошибка робота: ${String(e.message).slice(0, 150)}`, next_fetch: now + DAY });
      }
      results[r] = (results[r] || 0) + 1;
      done++;
    }
    if (done) await computePageRank();
    lastRun = { at: new Date().toISOString(), results, done };
    return { done, results };
  } finally {
    running = false;
  }
}

/** Обходить, пока очередь не опустеет (тесты, кнопка в админке). */
export async function crawlAll({ rounds = 20 } = {}) {
  let total = 0;
  for (let i = 0; i < rounds; i++) {
    const r = await crawlTick({ limit: 50 });
    if (!r.done) break;
    total += r.done;
  }
  return total;
}

let timer = null;
export function startCrawler() {
  if (timer) return;
  timer = setInterval(() => {
    isPaused().then((p) => (p ? null : crawlTick())).catch((e) => console.error('crawler', e));
  }, 4000);
  timer.unref?.();
}
