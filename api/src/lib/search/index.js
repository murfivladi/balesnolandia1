// Индекс и выдача ВлодПоиска. Инвертированный индекс в памяти (строится из базы после каждого обхода):
// поля с весами (заголовок, адрес, подзаголовки, тексты входящих ссылок, описание, текст), BM25,
// PageRank, свежесть для новостей, операторы site: "фраза" -слово, исправление опечаток, не больше двух
// результатов с одного сайта. Вертикали: веб, картинки, новости, товары (каталоги Касс).
import { q, one } from '../../db.js';
import { gameSeconds } from '../clock.js';
import { splitUrl, displayUrl } from '@bln/shared/balnet-url.js';
import { words, terms, stem, isStop, snippet, levenshtein, normQuery } from './text.js';
import { onIndexChange } from './crawler.js';
import { checkUrl } from './safe.js';

const DAY = 86400;
const PER_PAGE = 10;
const FIELD_W = { title: 4, url: 2, headings: 2, anchors: 2, description: 1.5, body: 1 };
const K1 = 1.2;
const B = 0.75;

let built = null;
let building = null;
onIndexChange(() => { built = null; });
export function resetIndex() { built = null; }

const urlWords = (url) => {
  const p = splitUrl(url);
  return p ? `${p.host.replace(/[.-]/g, ' ')} ${decodeURIComponent(p.path).replace(/[/._?=&-]/g, ' ')}` : '';
};

async function build() {
  const pages = await q("SELECT id, url, url_hash, host, kind, title, description, headings, body, pagerank, inlinks, first_seen, changed_at, published FROM search_pages WHERE status = 'indexed'");
  const anchorRows = await q("SELECT l.to_hash, GROUP_CONCAT(l.anchor SEPARATOR ' ') AS a FROM search_links l JOIN search_pages f ON f.id = l.from_id WHERE l.anchor <> '' AND f.status = 'indexed' GROUP BY l.to_hash");
  const anchors = new Map(anchorRows.map((r) => [r.to_hash, String(r.a || '').slice(0, 5000)]));
  const docs = [];
  const post = new Map(); // term → Map(docIdx → wtf)
  const vocab = new Map(); // слово → частота (для опечаток)
  let totalLen = 0;
  for (const p of pages) {
    const fields = {
      title: p.title || '', url: urlWords(p.url), headings: p.headings || '', anchors: anchors.get(p.url_hash) || '',
      description: p.description || '', body: String(p.body || '').slice(0, 60000),
    };
    const tf = new Map();
    let len = 0;
    for (const [f, w] of Object.entries(FIELD_W)) {
      for (const t of terms(fields[f])) { tf.set(t, (tf.get(t) || 0) + w); len += w; }
    }
    for (const w of words(`${fields.title} ${fields.body.slice(0, 20000)}`)) if (w.length > 2 && !isStop(w) && !/^\d+$/.test(w)) vocab.set(w, (vocab.get(w) || 0) + 1);
    const i = docs.length;
    docs.push({ ...p, len, pagerank: Number(p.pagerank) || 0, lower: `${fields.title} ${fields.body}`.toLowerCase().replace(/ё/g, 'е') });
    totalLen += len;
    for (const [t, v] of tf) {
      if (!post.has(t)) post.set(t, new Map());
      post.get(t).set(i, v);
    }
  }
  const avgPr = docs.length ? docs.reduce((s, d) => s + d.pagerank, 0) / docs.length || 1 : 1;
  return { docs, post, vocab, avgLen: docs.length ? totalLen / docs.length : 1, avgPr, at: Date.now() };
}

export async function getIndex() {
  if (built) return built;
  if (!building) building = build().then((b) => { built = b; building = null; return b; }, (e) => { building = null; throw e; });
  return building;
}

/** Разбор запроса: слова, «фразы», -исключения, site:хост. */
export function parseQuery(raw) {
  let s = String(raw || '').slice(0, 300);
  const phrases = [];
  s = s.replace(/"([^"]+)"/g, (m, p) => { phrases.push(p.toLowerCase().replace(/ё/g, 'е').trim()); return ` ${p} `; });
  let site = null;
  const minus = [];
  const plain = [];
  for (const tok of s.split(/\s+/).filter(Boolean)) {
    const m = /^site:(.+)$/i.exec(tok);
    if (m) { site = m[1].toLowerCase().replace(/^https?:\/\//, '').replace(/\/.*$/, ''); continue; }
    if (tok.startsWith('-') && tok.length > 1) { minus.push(...terms(tok.slice(1), { keepStop: true })); continue; }
    plain.push(tok);
  }
  const text = plain.join(' ');
  let stems = terms(text);
  if (!stems.length) stems = terms(text, { keepStop: true });
  return { text, stems: [...new Set(stems)], minus, phrases, site, words: words(text) };
}

function bm25(idx, stems, i) {
  let s = 0;
  const N = idx.docs.length;
  for (const t of stems) {
    const pl = idx.post.get(t);
    const tf = pl?.get(i);
    if (!tf) continue;
    const idf = Math.log(1 + (N - pl.size + 0.5) / (pl.size + 0.5));
    s += idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * idx.docs[i].len) / idx.avgLen)));
  }
  return s;
}

function candidates(idx, pq) {
  if (!pq.stems.length) return { ids: [], partial: false };
  const lists = pq.stems.map((t) => idx.post.get(t) || new Map()).sort((a, b) => a.size - b.size);
  let ids = [...lists[0].keys()].filter((i) => lists.every((l) => l.has(i)));
  let partial = false;
  if (!ids.length && pq.stems.length > 1) {
    const need = Math.ceil(pq.stems.length / 2);
    const count = new Map();
    for (const l of lists) for (const i of l.keys()) count.set(i, (count.get(i) || 0) + 1);
    ids = [...count].filter(([, c]) => c >= need).map(([i]) => i);
    partial = ids.length > 0;
  }
  return { ids, partial };
}

function filterDocs(idx, ids, pq) {
  return ids.filter((i) => {
    const d = idx.docs[i];
    if (pq.site && d.host !== pq.site && !d.host.endsWith(`.${pq.site}`)) return false;
    if (pq.minus.some((t) => idx.post.get(t)?.has(i))) return false;
    if (pq.phrases.some((ph) => !d.lower.includes(ph))) return false;
    return true;
  });
}

function score(idx, pq, i, now, { news = false } = {}) {
  const d = idx.docs[i];
  let s = bm25(idx, pq.stems, i);
  s *= 1 + 0.35 * Math.log1p(d.pagerank / idx.avgPr);
  // Навигационный запрос: имя сайта целиком.
  const host = d.host.replace(/^www\./, '');
  if (pq.text.toLowerCase().replace(/\s+/g, '') === host || pq.words.join('.') === host || pq.words[0] === host.split('.')[0]) s *= 1.6;
  const age = Math.max(0, now - Number(d.changed_at || d.first_seen || 0));
  if (d.kind === 'article' || news) s *= 1 + (news ? 2 : 0.4) * Math.exp(-age / (7 * DAY));
  if (d.kind === 'gov') s *= 1.15;
  return s;
}

function suggestion(idx, pq, hits) {
  if (hits > 2) return null;
  let changedAny = false;
  const fixed = pq.words.map((w) => {
    if (w.length < 4 || idx.post.has(stem(w)) || isStop(w)) return w;
    let best = null;
    const cap = w.length <= 5 ? 1 : 2;
    for (const [v, c] of idx.vocab) {
      if (Math.abs(v.length - w.length) > cap || v[0] !== w[0] && cap === 1) continue;
      const dist = levenshtein(w, v, cap);
      if (dist <= cap && (!best || dist < best.d || (dist === best.d && c > best.c))) best = { v, d: dist, c };
    }
    if (best) { changedAny = true; return best.v; }
    return w;
  });
  return changedAny ? fixed.join(' ') : null;
}

const hostDisplay = (url) => displayUrl(url);

/** Веб-выдача. */
export async function searchWeb(raw, { page = 1 } = {}) {
  const idx = await getIndex();
  const now = await gameSeconds();
  const pq = parseQuery(raw);
  let { ids, partial } = candidates(idx, pq);
  if (!pq.stems.length && pq.site) ids = idx.docs.map((_, i) => i);
  ids = filterDocs(idx, ids, pq);
  const scored = ids.map((i) => ({ i, s: score(idx, pq, i, now) })).sort((a, b) => b.s - a.s);
  // Не больше двух результатов с одного хоста подряд (остальные — ниже), как кластеризация у Google.
  const perHost = new Map();
  const first = [];
  const rest = [];
  for (const x of scored) {
    const h = idx.docs[x.i].host;
    const n = perHost.get(h) || 0;
    perHost.set(h, n + 1);
    (n < 2 || pq.site ? first : rest).push(x);
  }
  const ordered = [];
  for (const x of [...first, ...rest]) {
    const d = idx.docs[x.i];
    if (await checkUrl(d.url)) continue; // опасные сайты не показываем
    ordered.push(x);
  }
  const total = ordered.length;
  const slice = ordered.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  const results = slice.map((x, k) => {
    const d = idx.docs[x.i];
    const snip = snippet(d.body || d.description || '', pq.stems);
    return {
      position: (page - 1) * PER_PAGE + k + 1, url: d.url, host: d.host, display: hostDisplay(d.url), title: d.title || hostDisplay(d.url),
      snippet: snip.some((s) => s.b) || !d.description ? snip : [{ t: d.description, b: false }],
      kind: d.kind, date: d.kind === 'article' ? Number(d.changed_at || d.first_seen) : null, score: Math.round(x.s * 1000) / 1000,
    };
  });
  return { query: pq, total, page, pages: Math.ceil(total / PER_PAGE), results, partial, suggestion: suggestion(idx, pq, total) };
}

export async function searchNews(raw, { page = 1 } = {}) {
  const idx = await getIndex();
  const now = await gameSeconds();
  const pq = parseQuery(raw);
  let ids = pq.stems.length ? candidates(idx, pq).ids : idx.docs.map((_, i) => i);
  ids = filterDocs(idx, ids, pq).filter((i) => idx.docs[i].kind === 'article');
  const scored = ids.map((i) => ({ i, s: pq.stems.length ? score(idx, pq, i, now, { news: true }) : -(now - Number(idx.docs[i].changed_at || 0)) })).sort((a, b) => b.s - a.s);
  const slice = scored.slice((page - 1) * PER_PAGE, page * PER_PAGE);
  return {
    total: scored.length, page, pages: Math.ceil(scored.length / PER_PAGE),
    results: slice.map((x) => {
      const d = idx.docs[x.i];
      return { url: d.url, host: d.host, display: hostDisplay(d.url), title: d.title || d.url, snippet: snippet(d.body || '', pq.stems, 180), date: Number(d.changed_at || d.first_seen), published: d.published };
    }),
  };
}

export async function searchImages(raw) {
  const pq = parseQuery(raw);
  if (!pq.stems.length) return { total: 0, results: [] };
  const rows = await q("SELECT i.id, i.src, i.alt, p.url AS page_url, p.title AS page_title, p.host, p.pagerank FROM search_images i JOIN search_pages p ON p.id = i.page_id WHERE p.status = 'indexed' LIMIT 5000");
  const out = [];
  for (const r of rows) {
    const alt = new Set(terms(r.alt));
    const title = new Set(terms(r.page_title || ''));
    const src = new Set(terms(urlWords(r.src)));
    let s = 0;
    for (const t of pq.stems) s += (alt.has(t) ? 3 : 0) + (src.has(t) ? 1.5 : 0) + (title.has(t) ? 1 : 0);
    if (!s || !/\.(png|jpe?g|gif|webp|svg|avif)(\?|$)/i.test(r.src)) continue;
    if (pq.site && r.host !== pq.site) continue;
    out.push({ id: r.id, alt: r.alt, page_url: r.page_url, page_title: r.page_title, host: r.host, display: displayUrl(r.page_url), s: s * (1 + 0.2 * Math.log1p(Number(r.pagerank))) });
  }
  out.sort((a, b) => b.s - a.s);
  return { total: out.length, results: out.slice(0, 60).map(({ s: _s, ...x }) => x) };
}

/** Товары из каталогов Касс (активные магазины). */
export async function searchProducts(raw) {
  const pq = parseQuery(raw);
  const ws = pq.words.filter((w) => w.length > 1 && !isStop(w)).slice(0, 5);
  if (!ws.length) return { total: 0, results: [] };
  const where = ws.map(() => '(LOWER(p.name) LIKE ? OR LOWER(p.category) LIKE ?)').join(' AND ');
  const args = ws.flatMap((w) => { const st = `%${stem(w).replace(/[%_\\]/g, '\\$&')}%`; return [st, st]; });
  const rows = await q(
    `SELECT p.id, p.name, p.category, p.price, p.unit, p.photo IS NOT NULL AS has_photo, s.name AS shop, s.address, s.type
     FROM products p JOIN shops s ON s.id = p.shop_id WHERE p.active = 1 AND s.status = 'active' AND ${where} ORDER BY p.price LIMIT 60`, args,
  );
  return { total: rows.length, results: rows.map((r) => ({ ...r, price: Number(r.price), has_photo: !!r.has_photo })) };
}

// ——— Журнал запросов, подсказки, тренды, статистика для вебмастера ———

export async function logQuery({ q: raw, vertical, client, results, shown = [] }) {
  const qn = normQuery(raw);
  if (!qn) return;
  const at = await gameSeconds();
  await q('INSERT INTO search_queries (q, qnorm, vertical, client, at, results) VALUES (?, ?, ?, ?, ?, ?)', [String(raw).slice(0, 200), qn, vertical, client || '', at, results]);
  const day = Math.floor(at / DAY);
  const seen = new Set();
  for (const r of shown) {
    if (seen.has(r.host)) continue;
    seen.add(r.host);
    await q('INSERT INTO search_stats (host, day, qnorm, impressions, clicks, pos_sum) VALUES (?, ?, ?, 1, 0, ?) ON DUPLICATE KEY UPDATE impressions = impressions + 1, pos_sum = pos_sum + VALUES(pos_sum)', [r.host, day, qn, r.position]);
  }
}

export async function logClick({ q: raw, url }) {
  const qn = normQuery(raw);
  const p = splitUrl(String(url || ''));
  if (!qn || !p) return;
  const day = Math.floor((await gameSeconds()) / DAY);
  await q('INSERT INTO search_stats (host, day, qnorm, impressions, clicks, pos_sum) VALUES (?, ?, ?, 0, 1, 0) ON DUPLICATE KEY UPDATE clicks = clicks + 1', [p.host, day, qn]);
}

/** Подсказки: популярные запросы (минимум два разных человека — чужие личные запросы не всплывают) и заголовки сайтов. */
export async function suggest(prefix) {
  const p = normQuery(prefix);
  if (!p) return [];
  const since = (await gameSeconds()) - 30 * DAY;
  const rows = await q('SELECT qnorm, COUNT(*) AS n, COUNT(DISTINCT client) AS c FROM search_queries WHERE qnorm LIKE ? AND at >= ? GROUP BY qnorm HAVING c >= 2 ORDER BY n DESC LIMIT 8', [`${p.replace(/[%_\\]/g, '\\$&')}%`, since]);
  const out = rows.map((r) => r.qnorm);
  if (out.length < 8) {
    const idx = await getIndex();
    for (const d of idx.docs) {
      const t = (d.title || '').toLowerCase().replace(/ё/g, 'е');
      if (t.startsWith(p) && !out.includes(t)) out.push(t.slice(0, 80));
      if (out.length >= 8) break;
    }
  }
  return out;
}

/** Тренды: запросы последних игровых суток против среднего за неделю до них. */
export async function trends() {
  const now = await gameSeconds();
  const rows = await q('SELECT qnorm, SUM(at >= ?) AS today, SUM(at < ?) AS week, COUNT(DISTINCT client) AS c FROM search_queries WHERE at >= ? GROUP BY qnorm HAVING c >= 2 AND today > 0 ORDER BY today DESC LIMIT 30', [now - DAY, now - DAY, now - 8 * DAY]);
  return rows.map((r) => {
    const today = Number(r.today);
    const avg = Number(r.week) / 7;
    return { q: r.qnorm, today, growth: avg ? Math.round(((today - avg) / avg) * 100) : null };
  }).sort((a, b) => (b.growth ?? 1000) - (a.growth ?? 1000) || b.today - a.today).slice(0, 15);
}

export async function indexStats() {
  const idx = await getIndex();
  const by = await q('SELECT status, COUNT(*) AS n FROM search_pages GROUP BY status');
  const hosts = await one("SELECT COUNT(DISTINCT host) AS n FROM search_pages WHERE status = 'indexed'");
  return { docs: idx.docs.length, terms: idx.post.size, hosts: Number(hosts.n), by_status: Object.fromEntries(by.map((r) => [r.status, Number(r.n)])) };
}
