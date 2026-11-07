// БалНовости: API сайта novosti.bln (лента, статьи, редакции СМИ игроков, RSS-агрегатор) и админка госновостей.
import { q, one } from '../db.js';
import { notFound, int, str } from '../lib/errors.js';
import { needGov, needAdmin, session, actorOf } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import {
  CATEGORIES, publish, removeArticle, outletBySlug, outletView, canEdit, createOutlet, updateOutlet, fetchFeed, economyDigest, category,
} from '../lib/news.js';
import { getSettings } from '../lib/settings.js';
import { clockState } from '../lib/clock.js';

const PAGE = 20;
const view = (a) => ({
  id: a.id, title: a.title, summary: a.summary, body: a.body, link: a.link, category: a.category, author: a.author, pinned: !!a.pinned,
  published: Number(a.published), outlet: { slug: a.slug, title: a.outlet_title, kind: a.outlet_kind },
});
const SELECT = 'SELECT a.*, o.slug, o.title AS outlet_title, o.kind AS outlet_kind FROM news_articles a JOIN news_outlets o ON o.id = a.outlet_id';

async function feed({ outlet = null, cat = null, text = null, page = 1 }) {
  const where = ["o.status = 'active'"];
  const args = [];
  if (outlet) { where.push('o.id = ?'); args.push(outlet.id); }
  if (cat) { where.push('a.category = ?'); args.push(category(cat)); }
  if (text) { where.push('(a.title LIKE ? OR a.summary LIKE ?)'); args.push(`%${text}%`, `%${text}%`); }
  const rows = await q(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY a.pinned DESC, a.published DESC, a.id DESC LIMIT ${PAGE + 1} OFFSET ${(page - 1) * PAGE}`, args);
  return { articles: rows.slice(0, PAGE).map(view), more: rows.length > PAGE };
}
const pageOf = (v) => (v ? int(v, 'страница', { min: 1, max: 1000 }) : 1);
const articleArgs = (b) => ({
  title: str(b.title, 'заголовок', { min: 3, max: 200 }),
  summary: b.summary ? str(b.summary, 'анонс', { max: 500 }) : null,
  body: str(b.body, 'текст', { min: 1, max: 50000 }),
  category: category(b.category),
});

export async function newsRoutes(app) {
  const auth = { preHandler: needGov() };

  app.get('/meta', async () => ({ categories: CATEGORIES }));
  app.get('/feed', async (req) => {
    const x = req.query || {};
    const outlet = x.outlet ? await outletBySlug(x.outlet) : null;
    return feed({ outlet, cat: x.category || null, text: x.q ? String(x.q).slice(0, 100) : null, page: pageOf(x.page) });
  });
  app.get('/articles/:id', async (req) => {
    const a = await one(`${SELECT} WHERE a.id = ? AND o.status = 'active'`, [int(req.params.id, 'id', { min: 1 })]);
    if (!a) throw notFound('Статья не найдена');
    return { article: view(a) };
  });
  app.get('/outlets', async () => {
    const rows = await q("SELECT o.*, (SELECT COUNT(*) FROM news_articles a WHERE a.outlet_id = o.id) AS n FROM news_outlets o WHERE o.status = 'active' ORDER BY FIELD(o.kind, 'gov', 'economy', 'media'), o.title");
    return { outlets: rows.map((o) => outletView(o, { articles: Number(o.n) })) };
  });
  app.get('/outlets/:slug', async (req) => {
    const o = await outletBySlug(req.params.slug);
    if (o.status !== 'active') throw notFound('Редакция заблокирована');
    const s = await session(req, 'gov').catch(() => null);
    return { outlet: outletView(o, { mine: !!s && Number(o.owner_gov_id) === Number(s.id) }), ...(await feed({ outlet: o, page: pageOf(req.query?.page) })) };
  });

  // ——— Кабинет СМИ ———
  app.get('/me', async (req) => {
    const s = await session(req, 'gov').catch(() => null);
    if (!s) return { gov: null, outlets: [] };
    const rows = await q("SELECT * FROM news_outlets WHERE owner_gov_id = ? AND kind = 'media' ORDER BY id", [s.id]);
    return { gov: { id: s.id }, outlets: rows.map((o) => outletView(o)) };
  });
  app.post('/outlets', auth, async (req) => {
    const o = await createOutlet(req.gov.id, req.body || {});
    await audit(null, actorOf(req.gov), 'news.outlet', 'news_outlet', o.id, { slug: o.slug });
    return { outlet: outletView(o) };
  });
  app.patch('/outlets/:slug', auth, async (req) => {
    const o = await outletBySlug(req.params.slug);
    canEdit(o, req.gov.id);
    return { outlet: outletView(await updateOutlet(o, req.body || {})) };
  });
  app.post('/outlets/:slug/fetch', auth, async (req) => {
    const o = await outletBySlug(req.params.slug);
    canEdit(o, req.gov.id);
    return fetchFeed(o);
  });
  app.post('/outlets/:slug/articles', auth, async (req) => {
    const o = await outletBySlug(req.params.slug);
    canEdit(o, req.gov.id);
    const a = await publish(o, { ...articleArgs(req.body || {}), author: req.body?.author ? str(req.body.author, 'автор', { max: 80 }) : o.title });
    return { article: { id: a.id } };
  });
  app.delete('/articles/:id', auth, async (req) => {
    const a = await one('SELECT a.id, o.* FROM news_articles a JOIN news_outlets o ON o.id = a.outlet_id WHERE a.id = ?', [int(req.params.id, 'id', { min: 1 })]);
    if (!a) throw notFound('Статья не найдена');
    canEdit(a, req.gov.id);
    await removeArticle(Number(req.params.id));
    return { ok: true };
  });
}

export async function adminNewsRoutes(app) {
  app.addHook('preHandler', needAdmin());
  const actor = (req) => actorOf(req.actor);
  app.get('/', async () => {
    const outlets = await q('SELECT o.*, (SELECT COUNT(*) FROM news_articles a WHERE a.outlet_id = o.id) AS n FROM news_outlets o ORDER BY o.id');
    const latest = await q(`${SELECT} ORDER BY a.id DESC LIMIT 50`);
    return { outlets: outlets.map((o) => outletView(o, { articles: Number(o.n), owner_gov_id: o.owner_gov_id })), articles: latest.map(view), categories: CATEGORIES };
  });
  app.post('/articles', async (req) => {
    const b = req.body || {};
    const o = await outletBySlug('gov');
    const a = await publish(o, { ...articleArgs(b), author: 'Пресс-служба Правительства', pinned: !!b.pinned });
    await audit(null, actor(req), 'news.gov', 'news_article', a.id, { title: a.title });
    return { article: { id: a.id } };
  });
  app.post('/articles/:id/pin', async (req) => {
    await q('UPDATE news_articles SET pinned = ? WHERE id = ?', [req.body?.pinned ? 1 : 0, int(req.params.id, 'id', { min: 1 })]);
    return { ok: true };
  });
  app.delete('/articles/:id', async (req) => {
    const id = int(req.params.id, 'id', { min: 1 });
    await removeArticle(id);
    await audit(null, actor(req), 'news.delete', 'news_article', id);
    return { ok: true };
  });
  app.post('/outlets/:slug/status', async (req) => {
    const o = await outletBySlug(req.params.slug);
    const status = req.body?.status === 'blocked' ? 'blocked' : 'active';
    await q('UPDATE news_outlets SET status = ? WHERE id = ?', [status, o.id]);
    await audit(null, actor(req), 'news.outlet_status', 'news_outlet', o.id, { status });
    return { ok: true };
  });
  app.post('/digest', async () => {
    const c = await clockState();
    const a = await economyDigest(c.month, await getSettings());
    return { article: a ? { id: a.id } : null };
  });
}
