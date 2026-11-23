// Аналитика сайтов хостинга: просмотры HTML-страниц через шлюз ВлодБраузера, посетители, источники,
// популярные страницы и запросы из ВлодПоиска (данные поисковика по хосту, как в кабинете вебмастера).
import crypto from 'node:crypto';
import { q } from '../../db.js';
import { gameSeconds, onMonth } from '../clock.js';
import { SEARCH_HOST } from '@bln/shared/balnet-url.js';

const DAY = 86400;

/** Записать просмотр. ticket: билет шлюза; first — первая страница билета (переход извне). */
export async function recordHit(site, ticket, path, { first }) {
  const day = Math.floor((await gameSeconds()) / DAY);
  const visitor = crypto.createHash('sha256').update(`${ticket.clientId}|${site.id}`).digest('hex').slice(0, 16);
  let source = 'internal';
  let refHost = null;
  if (first) {
    let h = null;
    try { h = ticket.referrer ? new URL(ticket.referrer).hostname : null; } catch { h = null; }
    if (!h) source = 'direct';
    else if (h === SEARCH_HOST || h === `www.${SEARCH_HOST}`) { source = 'search'; refHost = h; } else if (h === ticket.host) source = 'internal';
    else { source = 'site'; refHost = h; }
  }
  await q('INSERT INTO site_hits (site_id, day, path, visitor, source, ref_host) VALUES (?, ?, ?, ?, ?, ?)', [site.id, day, String(path).split('?')[0].slice(0, 300), visitor, source, refHost]);
}

export async function siteAnalytics(site, days = 14) {
  const today = Math.floor((await gameSeconds()) / DAY);
  const from = today - days + 1;
  const daily = await q('SELECT day, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM site_hits WHERE site_id = ? AND day >= ? GROUP BY day ORDER BY day', [site.id, from]);
  const total = await q('SELECT COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM site_hits WHERE site_id = ? AND day >= ?', [site.id, from]);
  const pages = await q('SELECT path, COUNT(*) AS views, COUNT(DISTINCT visitor) AS visitors FROM site_hits WHERE site_id = ? AND day >= ? GROUP BY path ORDER BY views DESC LIMIT 20', [site.id, from]);
  const sources = await q("SELECT source, ref_host, COUNT(*) AS visits FROM site_hits WHERE site_id = ? AND day >= ? AND source <> 'internal' GROUP BY source, ref_host ORDER BY visits DESC LIMIT 20", [site.id, from]);
  const hosts = [site.host, site.host.startsWith('www.') ? site.host.slice(4) : `www.${site.host}`];
  const queries = await q('SELECT qnorm, SUM(impressions) AS impressions, SUM(clicks) AS clicks, SUM(pos_sum) AS pos_sum FROM search_stats WHERE host IN (?, ?) AND day >= ? GROUP BY qnorm ORDER BY clicks DESC, impressions DESC LIMIT 20', [...hosts, from]);
  const n = (v) => Number(v || 0);
  const byDay = new Map(daily.map((d) => [d.day, d]));
  return {
    days, today,
    total: { views: n(total[0]?.views), visitors: n(total[0]?.visitors) },
    daily: Array.from({ length: days }, (_, i) => { const d = byDay.get(from + i); return { day: from + i, views: n(d?.views), visitors: n(d?.visitors) }; }),
    pages: pages.map((p) => ({ path: p.path, views: n(p.views), visitors: n(p.visitors) })),
    sources: sources.map((s) => ({ source: s.source, host: s.ref_host, visits: n(s.visits) })),
    queries: queries.map((x) => ({ q: x.qnorm, impressions: n(x.impressions), clicks: n(x.clicks), position: n(x.impressions) ? Math.round((n(x.pos_sum) / n(x.impressions)) * 10) / 10 : null })),
  };
}

// Храним три игровых месяца.
onMonth('site_hits_prune', async () => {
  const day = Math.floor((await gameSeconds()) / DAY);
  await q('DELETE FROM site_hits WHERE day < ?', [day - 90]);
});
