// ВлодПоиск (poisk.bln): поиск и вертикали, подсказки, тренды, Safe Browsing для браузера, реклама в выдаче,
// рекламная сеть на сайтах игроков (через билет шлюза), кабинеты вебмастера и рекламодателя. Админка: обход,
// индекс, список опасных сайтов, жалобы, модерация объявлений.
import crypto from 'node:crypto';
import { tx, q, one } from '../db.js';
import { bad, notFound, int, need } from '../lib/errors.js';
import { needGov, needAdmin, actorOf } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { isPaused } from '../lib/clock.js';
import { getTicket } from '../lib/gateway.js';
import { splitUrl } from '@bln/shared/balnet-url.js';
import { THREATS } from '@bln/shared/balnet-safe.js';
import { searchWeb, searchNews, searchImages, searchProducts, suggest, trends, logQuery, logClick, indexStats, getIndex, resetIndex } from '../lib/search/index.js';
import { crawlTick, crawlAll, crawlerState, computePageRank, botFetch, resetCrawler } from '../lib/search/crawler.js';
import { terms } from '../lib/search/text.js';
import { prefixes, fullHashes, report, addEntry, setStatus, resetSafeCache } from '../lib/search/safe.js';
import {
  adAccount, topup, withdraw, createCampaign, ownCampaign, updateCampaign, campaignView, campaignStats, runAuction, click, resetAdCache,
} from '../lib/search/ads.js';
import { addSite, ownSite, siteView, verifySite, recrawl, inspect, addSitemap, setAdnet, requestReview, adnetSite } from '../lib/search/webmaster.js';

const TABS = new Set(['web', 'images', 'news', 'products']);
const IMG_RE = /^image\/(png|jpeg|gif|webp|avif|svg\+xml|x-icon)$/;
const clientOf = (req) => crypto.createHash('sha256').update(`${req.ip}|${req.headers['user-agent'] || ''}`).digest('hex').slice(0, 16);
const devClient = (id) => crypto.createHash('sha256').update(`dev:${id}`).digest('hex').slice(0, 16);
const parseBody = (b) => { if (typeof b === 'string') { try { return JSON.parse(b); } catch { return {}; } } return b || {}; };

async function online() {
  if (await isPaused()) throw bad('balnet_maintenance', 'БалНет на обслуживании');
}

export function resetSearch() {
  resetIndex();
  resetCrawler();
  resetSafeCache();
  resetAdCache();
}

export async function searchRoutes(app) {
  const auth = { preHandler: needGov() };
  const limited = (max) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

  // ——— Поиск ———
  app.get('/search', limited(120), async (req) => {
    await online();
    const qtext = String(req.query.q || '').trim().slice(0, 300);
    const tab = TABS.has(req.query.tab) ? req.query.tab : 'web';
    const page = Math.min(50, Math.max(1, Number(req.query.p) || 1));
    if (!qtext) return { q: '', tab, total: 0, results: [], ads: [] };
    const t0 = Date.now();
    let r;
    if (tab === 'images') r = await searchImages(qtext);
    else if (tab === 'news') r = await searchNews(qtext, { page });
    else if (tab === 'products') r = await searchProducts(qtext);
    else r = await searchWeb(qtext, { page });
    const client = clientOf(req);
    let ads = [];
    if (tab === 'web' && page === 1) ads = await runAuction({ stems: r.query.stems, placement: 'serp', limit: 3, client });
    await logQuery({ q: qtext, vertical: tab, client, results: r.total, shown: tab === 'web' ? r.results : [] });
    const { query, ...rest } = r;
    return { q: qtext, tab, ...rest, ads, ms: Date.now() - t0, operators: query ? { site: query.site, minus: query.minus.length, phrases: query.phrases } : null };
  });

  app.post('/click', limited(300), async (req) => {
    await logClick({ q: req.body?.q, url: req.body?.url });
    return { ok: true };
  });

  app.get('/suggest', limited(600), async (req) => ({ q: String(req.query.q || ''), suggestions: await suggest(req.query.q) }));
  app.get('/trends', async () => ({ trends: await trends() }));
  app.get('/stats', async () => indexStats());

  // Картинка из индекса: робот берёт файл с сайта (как кэш миниатюр поисковика).
  app.get('/img/:id', async (req, reply) => {
    const img = await one("SELECT i.src FROM search_images i JOIN search_pages p ON p.id = i.page_id WHERE i.id = ? AND p.status = 'indexed'", [int(req.params.id, 'id')]);
    if (!img) throw notFound('Картинки нет в индексе');
    const r = await botFetch(img.src, { binary: true });
    const type = String(r.type || '').split(';')[0];
    if (r.status !== 200 || !r.buf || !IMG_RE.test(type)) throw notFound('Картинка недоступна');
    reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type(type).send(r.buf);
  });

  app.get('/product-photo/:id', async (req, reply) => {
    const p = await one("SELECT p.photo FROM products p JOIN shops s ON s.id = p.shop_id WHERE p.id = ? AND p.active = 1 AND s.status = 'active'", [int(req.params.id, 'id')]);
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(p?.photo || '');
    if (!m) throw notFound('Фото нет');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type(m[1]).send(Buffer.from(m[2], 'base64'));
  });

  // ——— Safe Browsing (для ВлодБраузера) ———
  app.get('/sb/prefixes', async () => ({ ...(await prefixes()), threats: THREATS }));
  app.post('/sb/find', limited(300), async (req) => fullHashes(req.body?.prefixes));
  app.post('/sb/report', limited(20), async (req) => report({ ...req.body, client: clientOf(req) }));

  // ——— Реклама: клик в выдаче и плитка на новой вкладке ———
  app.post('/ads/click', limited(120), async (req) => click(req.body?.token, clientOf(req)));
  app.get('/ads/newtab', limited(120), async (req) => ({ ad: (await runAuction({ stems: [], placement: 'newtab', limit: 1, client: clientOf(req) }))[0] || null }));

  // ——— Рекламная сеть на сайтах игроков: запросы идут со страницы сайта (песочница) с билетом шлюза ———
  app.post('/adnet/serve', limited(300), async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    const b = parseBody(req.body);
    const t = getTicket(b.ticket);
    if (!t) return { ad: null, error: 'ticket' };
    const site = await adnetSite(t.host);
    if (!site) return { ad: null, error: 'Сайт не подключён к рекламной сети ВлодПоиска' };
    const path = String(b.path || '/').slice(0, 500);
    const idx = await getIndex();
    const url = `${t.origin}${path.startsWith('/') ? path : `/${path}`}`;
    const doc = idx.docs.find((d) => d.url === url) || idx.docs.find((d) => d.host === t.host);
    const stems = doc ? [...new Set(terms(`${doc.title || ''} ${doc.description || ''} ${String(doc.body || '').slice(0, 4000)}`))].slice(0, 300) : [];
    const [ad] = await runAuction({ stems, placement: 'network', limit: 1, client: devClient(t.clientId), siteId: site.id, host: t.host, excludeGovUser: site.gov_user_id });
    return { ad: ad ? { token: ad.token, title: ad.title, text: ad.text, display: ad.display } : null };
  });

  app.post('/adnet/click', limited(120), async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    const b = parseBody(req.body);
    const t = getTicket(b.ticket);
    if (!t) return { error: 'ticket' };
    const imp = await one('SELECT i.site_id, s.host FROM search_ad_impressions i JOIN search_sites s ON s.id = i.site_id WHERE i.token = ?', [String(b.token || '')]);
    if (!imp || imp.host !== t.host.replace(/^www\./, '')) return { error: 'Объявление не с этого сайта' };
    const r = await click(b.token, devClient(t.clientId));
    return { url: r.url };
  });

  // ——— Вебмастер ———
  app.get('/webmaster/sites', auth, async (req) => {
    const rows = await q('SELECT id, host, verified_at, adnet FROM search_sites WHERE gov_user_id = ? ORDER BY id', [req.gov.id]);
    const out = [];
    for (const r of rows) {
      const c = await one("SELECT COUNT(*) AS n FROM search_pages WHERE (host = ? OR host = ?) AND status = 'indexed'", [r.host, `www.${r.host}`]);
      out.push({ id: r.id, host: r.host, verified: !!r.verified_at, adnet: !!r.adnet, indexed: Number(c.n) });
    }
    const mine = await q("SELECT s.host FROM hosting_sites s JOIN hosting_accounts a ON a.id = s.account_id WHERE a.gov_user_id = ? AND a.status IN ('active','suspended')", [req.gov.id]).catch(() => []);
    return { sites: out, hosting: mine.map((m) => m.host) };
  });
  app.post('/webmaster/sites', auth, async (req) => ({ id: await addSite(req.gov.id, req.body?.host) }));
  app.get('/webmaster/sites/:id', auth, async (req) => ({ site: await siteView(await ownSite(int(req.params.id, 'id'), req.gov.id)) }));
  app.post('/webmaster/sites/:id/verify', auth, async (req) => verifySite(await ownSite(int(req.params.id, 'id'), req.gov.id), String(req.body?.method || 'dns')));
  app.post('/webmaster/sites/:id/recrawl', auth, async (req) => recrawl(await ownSite(int(req.params.id, 'id'), req.gov.id), req.body?.url));
  app.post('/webmaster/sites/:id/inspect', auth, async (req) => inspect(await ownSite(int(req.params.id, 'id'), req.gov.id), req.body?.url));
  app.post('/webmaster/sites/:id/sitemaps', auth, async (req) => addSitemap(await ownSite(int(req.params.id, 'id'), req.gov.id), req.body?.url));
  app.post('/webmaster/sites/:id/review', auth, async (req) => { await requestReview(await ownSite(int(req.params.id, 'id'), req.gov.id)); return { ok: true }; });
  app.patch('/webmaster/sites/:id', auth, async (req) => { await setAdnet(await ownSite(int(req.params.id, 'id'), req.gov.id), !!req.body?.adnet); return { ok: true }; });
  app.delete('/webmaster/sites/:id', auth, async (req) => {
    const s = await ownSite(int(req.params.id, 'id'), req.gov.id);
    need(!Number(s.earned_unpaid), 'Сначала дождитесь выплаты рекламной сети');
    await q('DELETE FROM search_sites WHERE id = ?', [s.id]);
    return { ok: true };
  });

  // ——— Рекламный кабинет ———
  app.get('/ads/account', auth, async (req) => {
    const a = await adAccount(null, req.gov.id);
    const camps = await q("SELECT * FROM search_campaigns WHERE ad_account_id = ? AND status <> 'deleted' ORDER BY id DESC", [a.id]);
    const topups = await q('SELECT id, amount, invoice, status, created_at FROM search_ad_topups WHERE ad_account_id = ? ORDER BY id DESC LIMIT 20', [a.id]);
    return { account: { id: a.id, balance: Number(a.balance), spent_total: Number(a.spent_total) }, campaigns: camps.map(campaignView), topups };
  });
  app.post('/ads/topup', auth, async (req) => tx((conn) => topup(conn, req.gov.id, req.body?.amount)));
  app.post('/ads/withdraw', auth, async (req) => tx((conn) => withdraw(conn, req.gov.id)));
  app.post('/ads/campaigns', auth, async (req) => tx(async (conn) => ({ id: await createCampaign(conn, req.gov.id, req.body || {}) })));
  app.get('/ads/campaigns/:id', auth, async (req) => {
    const c = await ownCampaign(null, int(req.params.id, 'id'), req.gov.id);
    return { campaign: campaignView(c), stats: await campaignStats(c.id) };
  });
  app.patch('/ads/campaigns/:id', auth, async (req) => tx(async (conn) => {
    const c = await ownCampaign(conn, int(req.params.id, 'id'), req.gov.id);
    await updateCampaign(conn, c, req.body || {});
    return { ok: true };
  }));
  /** Прогноз: какие объявления сейчас выигрывают по слову (без записи показов). */
  app.get('/ads/forecast', auth, async (req) => {
    const st = terms(String(req.query.q || ''));
    const rows = await q("SELECT c.id, c.bid, c.keywords FROM search_campaigns c JOIN search_ad_accounts a ON a.id = c.ad_account_id WHERE c.status = 'active' AND a.balance > 0");
    const bids = rows.filter((c) => (typeof c.keywords === 'string' ? JSON.parse(c.keywords) : c.keywords).some((k) => terms(k).every((t) => st.includes(t)))).map((c) => Number(c.bid)).sort((a, b) => b - a);
    const searches = await one('SELECT COUNT(*) AS n FROM search_queries WHERE qnorm LIKE ?', [`%${String(req.query.q || '').toLowerCase().slice(0, 60).replace(/[%_\\]/g, '\\$&')}%`]);
    return { competitors: bids.length, top_bid: bids[0] || null, searches: Number(searches.n) };
  });
}

export async function adminSearchRoutes(app) {
  app.addHook('preHandler', needAdmin());
  const actor = (req) => actorOf(req.actor);

  app.get('/overview', async () => {
    const stats = await indexStats();
    const due = await one("SELECT COUNT(*) AS n FROM search_pages WHERE kind <> 'gov' AND next_fetch <= (SELECT MAX(next_fetch) FROM search_pages WHERE status = 'queued')");
    const queued = await one("SELECT COUNT(*) AS n FROM search_pages WHERE status = 'queued'");
    const revenue = await one("SELECT COALESCE(SUM(e.amount), 0) AS s FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id WHERE t.kind = 'ads_revenue' AND e.amount > 0");
    const payouts = await one("SELECT COALESCE(SUM(e.amount), 0) AS s FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id WHERE t.kind = 'ads_payout' AND e.amount > 0");
    const top = await q('SELECT qnorm, COUNT(*) AS n FROM search_queries GROUP BY qnorm ORDER BY n DESC LIMIT 20');
    return { stats, crawler: crawlerState(), queued: Number(queued.n), due: Number(due?.n || 0), revenue: Number(revenue.s), payouts: Number(payouts.s), top_queries: top.map((r) => ({ q: r.qnorm, n: Number(r.n) })) };
  });

  app.post('/crawl', async (req) => {
    const rounds = Math.min(50, Math.max(1, Number(req.body?.rounds) || 1));
    const done = rounds === 1 ? (await crawlTick({ limit: 50 })).done : await crawlAll({ rounds });
    return { done, crawler: crawlerState() };
  });
  app.post('/pagerank', async () => ({ pages: await computePageRank() }));

  app.get('/pages', async (req) => {
    const s = String(req.query.q || '').trim().toLowerCase();
    const st = String(req.query.status || '');
    const where = [];
    const args = [];
    if (s) { where.push('url LIKE ?'); args.push(`%${s.replace(/[%_\\]/g, '\\$&')}%`); }
    if (st) { where.push('status = ?'); args.push(st); }
    const rows = await q(`SELECT id, url, host, kind, status, http_status, reason, title, pagerank, inlinks, fetched_at, next_fetch, priority FROM search_pages ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY pagerank DESC, id DESC LIMIT 200`, args);
    return { pages: rows.map((r) => ({ ...r, pagerank: Math.round(Number(r.pagerank) * 100) / 100 })) };
  });

  /** Удалить из выдачи (по закону или жалобе): страница исключается и не возвращается при обходе до снятия. */
  app.post('/pages/:id/remove', async (req) => {
    const id = int(req.params.id, 'id');
    await q("UPDATE search_pages SET status = 'excluded', reason = ?, next_fetch = 9007199254740991 WHERE id = ?", [`Удалено из поиска: ${String(req.body?.reason || 'решение администрации').slice(0, 150)}`, id]);
    resetIndex();
    await audit(null, actor(req), 'search.remove', 'search_page', id);
    return { ok: true };
  });
  app.post('/pages/:id/restore', async (req) => {
    await q("UPDATE search_pages SET status = 'queued', reason = NULL, next_fetch = 0, priority = 50 WHERE id = ? AND kind <> 'gov'", [int(req.params.id, 'id')]);
    return { ok: true };
  });

  app.get('/safe', async () => {
    const list = await q('SELECT * FROM search_safe ORDER BY status = \'suspected\' DESC, id DESC LIMIT 300');
    const reports = await q("SELECT * FROM search_reports ORDER BY status = 'new' DESC, id DESC LIMIT 200");
    const reviews = await q('SELECT id, host, gov_user_id FROM search_sites WHERE review_requested = 1');
    return { list, reports, reviews };
  });
  app.post('/safe', async (req) => {
    const id = await addEntry({ expr: req.body?.expr, threat: req.body?.threat, source: 'admin', status: 'confirmed', note: req.body?.note || null });
    await audit(null, actor(req), 'safe.add', 'search_safe', id, { expr: req.body?.expr });
    return { id };
  });
  app.patch('/safe/:id', async (req) => {
    const id = int(req.params.id, 'id');
    await setStatus(id, String(req.body?.status || ''));
    if (req.body?.status === 'cleared') {
      const e = await one('SELECT expr FROM search_safe WHERE id = ?', [id]);
      const host = e?.expr.split('/')[0];
      if (host) await q('UPDATE search_sites SET review_requested = 0 WHERE host = ?', [host]);
    }
    await audit(null, actor(req), `safe.${req.body?.status}`, 'search_safe', id);
    return { ok: true };
  });
  app.patch('/reports/:id', async (req) => {
    const id = int(req.params.id, 'id');
    const r = await one('SELECT * FROM search_reports WHERE id = ?', [id]);
    if (!r) throw notFound('Жалоба не найдена');
    const accept = req.body?.status === 'accepted';
    await q('UPDATE search_reports SET status = ? WHERE id = ?', [accept ? 'accepted' : 'rejected', id]);
    if (accept) {
      const p = splitUrl(r.url);
      await addEntry({ expr: req.body?.expr || `${p.host}/`, threat: r.threat, source: 'admin', status: 'confirmed', note: `Жалоба №${id}` });
    }
    return { ok: true };
  });

  app.get('/campaigns', async () => {
    const rows = await q("SELECT c.*, a.gov_user_id, a.balance FROM search_campaigns c JOIN search_ad_accounts a ON a.id = c.ad_account_id WHERE c.status <> 'deleted' ORDER BY c.id DESC LIMIT 200");
    return { campaigns: rows.map((c) => ({ ...campaignView(c), gov_user_id: c.gov_user_id, balance: Number(c.balance) })) };
  });
  app.patch('/campaigns/:id', async (req) => {
    const id = int(req.params.id, 'id');
    const st = req.body?.status === 'rejected' ? 'rejected' : 'active';
    await q('UPDATE search_campaigns SET status = ?, reject_reason = ? WHERE id = ? AND status <> \'deleted\'', [st, st === 'rejected' ? String(req.body?.reason || 'Нарушает правила рекламы').slice(0, 200) : null, id]);
    resetAdCache();
    await audit(null, actor(req), `ad.${st}`, 'search_campaign', id);
    return { ok: true };
  });
}
