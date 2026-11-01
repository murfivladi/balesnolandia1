// Этап 7, админка: оптовая база и цены (с учётом индекса инфляции).
import { q, one } from '../db.js';
import { notFound, int, str, amount as amountOf, need } from '../lib/errors.js';
import { needAdmin, actorOf } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { priceIndex } from '../lib/finance.js';
import { wholesaleView } from '../lib/stock.js';

const MAX_IMAGE = 400_000;

export async function adminPosRoutes(app) {
  app.addHook('preHandler', needAdmin());
  const actor = (req) => actorOf(req.actor);

  function fields(b, prev = {}) {
    const val = (k, f) => (b[k] !== undefined ? f(b[k]) : prev[k]);
    const photo = b.photo !== undefined ? (b.photo || null) : prev.photo ?? null;
    if (photo) need(/^data:image\//.test(photo) && photo.length < MAX_IMAGE, 'Фото до 300 КБ');
    return {
      name: val('name', (v) => str(v, 'название', { max: 120 })),
      category: val('category', (v) => String(v || '').trim().slice(0, 60)) ?? '',
      unit: val('unit', (v) => (v === 'kg' ? 'kg' : 'pcs')) ?? 'pcs',
      base_price: val('base_price', (v) => amountOf(v, 'базовая цена')),
      barcode: val('barcode', (v) => (v ? String(v).replace(/\s/g, '').slice(0, 64) : null)) ?? null,
      age_limit: val('age_limit', (v) => int(Number(v) || 0, 'возраст', { min: 0, max: 21 })) ?? 0,
      active: val('active', (v) => (v ? 1 : 0)) ?? 1,
      sort: val('sort', (v) => int(Number(v) || 0, 'порядок')) ?? 0,
      photo,
    };
  }

  app.get('/wholesale', async () => {
    const idx = await priceIndex();
    const rows = await q('SELECT * FROM wholesale_items ORDER BY active DESC, category, sort, name');
    const sold = await one("SELECT COALESCE(SUM(total),0) AS s, COUNT(*) AS n FROM purchases WHERE source = 'wholesale' AND status = 'done'");
    const history = await q('SELECT month, rate_bp, index_ppm FROM price_index ORDER BY month DESC LIMIT 24');
    return {
      index: idx.index,
      month: idx.month,
      items: rows.map((w) => wholesaleView(w, idx.index)),
      sales: { total: Number(sold.s), count: Number(sold.n) },
      history: history.map((h) => ({ month: h.month, rate_bp: h.rate_bp, index: Number(h.index_ppm) / 1e6 })).reverse(),
    };
  });

  app.post('/wholesale', async (req) => {
    const f = fields(req.body || {});
    need(f.name && f.base_price, 'Укажите название и цену');
    const r = await q('INSERT INTO wholesale_items (name, category, unit, base_price, barcode, age_limit, active, sort, photo) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [f.name, f.category, f.unit, f.base_price, f.barcode, f.age_limit, f.active, f.sort, f.photo]);
    await audit(null, actor(req), 'admin.wholesale_add', 'wholesale_item', r.insertId, { name: f.name, base_price: f.base_price });
    return { id: r.insertId };
  });

  app.patch('/wholesale/:id', async (req) => {
    const w = await one('SELECT * FROM wholesale_items WHERE id = ?', [int(req.params.id, 'id')]);
    if (!w) throw notFound();
    const f = fields(req.body || {}, { ...w, base_price: Number(w.base_price) });
    await q('UPDATE wholesale_items SET name = ?, category = ?, unit = ?, base_price = ?, barcode = ?, age_limit = ?, active = ?, sort = ?, photo = ? WHERE id = ?', [f.name, f.category, f.unit, f.base_price, f.barcode, f.age_limit, f.active, f.sort, f.photo, w.id]);
    await audit(null, actor(req), 'admin.wholesale_edit', 'wholesale_item', w.id, { base_price: f.base_price, active: f.active });
    return { ok: true };
  });

  // Все закупки и заказы между магазинами.
  app.get('/purchases', async () => {
    const rows = await q(`SELECT p.id, p.source, p.status, p.total, p.created_at, s.name AS shop_name, x.name AS seller_name FROM purchases p
      JOIN shops s ON s.id = p.shop_id LEFT JOIN shops x ON x.id = p.seller_shop_id ORDER BY p.id DESC LIMIT 200`);
    return { purchases: rows.map((r) => ({ ...r, total: Number(r.total) })) };
  });
}
