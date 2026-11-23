// ВлодПоиск: разбор текста и страниц. Токены, стемминг (Snowball для русского, упрощённый Портер для латиницы),
// разбор HTML (заголовок, мета-теги, ссылки, картинки, текст), robots.txt (правила Google: длиннейшее совпадение,
// * и $), sitemap.xml, сниппеты с подсветкой.

// ——— Токены ———

const STOP = new Set(('и в во не что он на я с со как а то все она так его но да ты к у же вы за бы по только ее мне было вот от меня еще нет о из ему теперь когда даже ну вдруг ли если уже или ни быть был него до вас нибудь опять уж вам ведь там потом себя ничего ей может они тут где есть надо ней для мы тебя их чем была сам чтоб без будто чего раз тоже себе под будет ж тогда кто этот того потому этого какой совсем ним здесь этом один почти мой тем чтобы нее сейчас были куда зачем всех никогда можно при наконец два об другой хоть после над больше тот через эти нас про всего них какая много разве три эту моя впрочем хорошо свою этой перед иногда лучше чуть том нельзя такой им более всегда конечно всю между '
  + 'the a an and or of to in on for is are was be by with as at it this that from').split(' '));

/** Текст → слова в нижнем регистре (ё → е), без пунктуации. */
export function words(text) {
  return String(text || '').toLowerCase().replace(/ё/g, 'е').match(/[\p{L}\p{N}]+/gu) || [];
}

/** Слова → основы для индекса (без стоп-слов). */
export function terms(text, { keepStop = false } = {}) {
  const out = [];
  for (const w of words(text)) {
    if (w.length > 40) continue;
    if (!keepStop && STOP.has(w)) continue;
    out.push(stem(w));
  }
  return out;
}

export const isStop = (w) => STOP.has(w);

// ——— Стемминг ———

const RU_V = 'аеиоуыэюя';
const isV = (c) => RU_V.includes(c);
const byLen = (list) => list.split(' ').sort((a, b) => b.length - a.length);
const PERF1 = byLen('в вши вшись');
const PERF2 = byLen('ив ивши ившись ыв ывши ывшись');
const ADJ = byLen('ее ие ые ое ими ыми ей ий ый ой ем им ым ом его ого ему ому их ых ую юю ая яя ою ею');
const PART1 = byLen('ем нн вш ющ щ');
const PART2 = byLen('ивш ывш ующ');
const REFL = byLen('ся сь');
const VERB1 = byLen('ла на ете йте ли й л ем н ло но ет ют ны ть ешь нно');
const VERB2 = byLen('ила ыла ена ейте уйте ите или ыли ей уй ил ыл им ым ен ило ыло ено ят ует уют ит ыт ены ить ыть ишь ую ю');
const NOUN = byLen('а ев ов ие ье е иями ями ами еи ии и ией ей ой ий й иям ям ием ем ам ом о у ах иях ях ы ь ию ью ю ия ья я');
const SUPER = byLen('ейше ейш');

/** Отрезать окончание в зоне rv. group1 — окончание должно стоять после «а» или «я». */
function cut(rv, list, group1 = false) {
  for (const e of list) {
    if (!rv.endsWith(e)) continue;
    if (group1) {
      const prev = rv[rv.length - e.length - 1];
      if (prev !== 'а' && prev !== 'я') continue;
    }
    return rv.slice(0, rv.length - e.length);
  }
  return null;
}

/** Snowball-стеммер русского языка (Портер). */
export function stemRu(word) {
  let i = 0;
  while (i < word.length && !isV(word[i])) i++;
  if (i >= word.length) return word;
  const pre = word.slice(0, i + 1);
  let rv = word.slice(i + 1);
  // R2 считается относительно всего слова; найдём позицию.
  const r1 = (() => { for (let k = 1; k < word.length; k++) if (!isV(word[k]) && isV(word[k - 1])) return k + 1; return word.length; })();
  const r2 = (() => { for (let k = r1 + 1; k < word.length; k++) if (!isV(word[k]) && isV(word[k - 1])) return k + 1; return word.length; })();

  // Шаг 1
  let r = cut(rv, PERF1, true) ?? cut(rv, PERF2);
  if (r !== null) rv = r;
  else {
    r = cut(rv, REFL);
    if (r !== null) rv = r;
    let done = false;
    for (const a of ADJ) {
      if (!rv.endsWith(a)) continue;
      let base = rv.slice(0, rv.length - a.length);
      const p = cut(base, PART1, true) ?? cut(base, PART2);
      if (p !== null) base = p;
      rv = base;
      done = true;
      break;
    }
    if (!done) {
      r = cut(rv, VERB1, true) ?? cut(rv, VERB2);
      if (r !== null) rv = r;
      else {
        r = cut(rv, NOUN);
        if (r !== null) rv = r;
      }
    }
  }
  // Шаг 2
  if (rv.endsWith('и')) rv = rv.slice(0, -1);
  // Шаг 3: словообразовательное «ост(ь)» в R2
  const r2InRv = Math.max(0, r2 - pre.length);
  for (const e of ['ость', 'ост']) {
    if (rv.endsWith(e) && rv.length - e.length >= r2InRv) { rv = rv.slice(0, -e.length); break; }
  }
  // Шаг 4
  if (rv.endsWith('нн')) rv = rv.slice(0, -1);
  else {
    const s = cut(rv, SUPER);
    if (s !== null) { rv = s; if (rv.endsWith('нн')) rv = rv.slice(0, -1); } else if (rv.endsWith('ь')) rv = rv.slice(0, -1);
  }
  return pre + rv;
}

/** Латиница: снять частые окончания (упрощённый Портер). */
export function stemEn(w) {
  if (w.length <= 3) return w;
  for (const [suf, rep] of [['ies', 'y'], ['sses', 'ss'], ['ing', ''], ['edly', ''], ['ed', ''], ['ly', ''], ['es', ''], ['s', '']]) {
    if (w.endsWith(suf) && w.length - suf.length >= 3) return w.slice(0, -suf.length) + rep;
  }
  return w;
}

export function stem(w) {
  if (/^[0-9]+$/.test(w)) return w;
  if (/[а-я]/.test(w)) return stemRu(w);
  return stemEn(w);
}

// ——— HTML ———

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…', copy: '©', reg: '®', deg: '°', middot: '·' };
export function decodeEntities(s) {
  return String(s).replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === '#') {
      const n = e[1] === 'x' || e[1] === 'X' ? parseInt(e.slice(2), 16) : Number(e.slice(1));
      return n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m;
    }
    return ENT[e.toLowerCase()] ?? m;
  });
}

const clean = (s) => decodeEntities(String(s).replace(/<[^>]*>/g, ' ')).replace(/\s+/g, ' ').trim();

export function attrs(tag) {
  const out = {};
  const re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;
  const inner = tag.replace(/^<\s*[a-zA-Z0-9]+/, '').replace(/\/?>$/, '');
  let m;
  while ((m = re.exec(inner))) out[m[1].toLowerCase()] = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
  return out;
}

/** Абсолютный адрес ссылки относительно страницы; только http(s) БалНета, без #фрагмента. */
export function absUrl(href, base) {
  const h = String(href || '').trim();
  if (!h || /^(javascript|mailto|tel|data|blob):/i.test(h) || h.startsWith('#')) return null;
  let u;
  try { u = new URL(h, base); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  u.hash = '';
  return `${u.protocol}//${u.host.toLowerCase()}${u.pathname || '/'}${u.search}`;
}

/** Разбор HTML-страницы для индекса. */
export function parseHtml(html, baseUrl) {
  const src = String(html).slice(0, 2_000_000);
  const noScript = src
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)\b[\s\S]*?<\/\1\s*>/gi, ' ');
  const title = clean(/<title[^>]*>([\s\S]*?)<\/title>/i.exec(noScript)?.[1] || '').slice(0, 300);
  const meta = {};
  for (const m of noScript.match(/<meta\b[^>]*>/gi) || []) {
    const a = attrs(m);
    const key = (a.name || a.property || a['http-equiv'] || '').toLowerCase();
    if (key && a.content !== undefined) meta[key] = a.content;
  }
  const robots = `${meta.robots || ''},${meta.vlodbot || ''}`.toLowerCase();
  let canonical = null;
  for (const m of noScript.match(/<link\b[^>]*>/gi) || []) {
    const a = attrs(m);
    if (String(a.rel || '').toLowerCase().split(/\s+/).includes('canonical') && a.href) canonical = absUrl(a.href, baseUrl);
  }
  const baseTag = /<base\b[^>]*>/i.exec(noScript);
  const base = (baseTag && absUrl(attrs(baseTag[0]).href, baseUrl)) || baseUrl;
  const links = [];
  const re = /<a\b([^>]*)>([\s\S]*?)<\/a\s*>/gi;
  let m;
  while ((m = re.exec(noScript)) && links.length < 300) {
    const a = attrs(`<a ${m[1]}>`);
    const url = absUrl(a.href, base);
    if (!url) continue;
    const img = /<img\b[^>]*>/i.exec(m[2]);
    const anchor = (clean(m[2]) || (img ? attrs(img[0]).alt : '') || '').slice(0, 200);
    links.push({ url, anchor, nofollow: /\b(nofollow|ugc|sponsored)\b/i.test(a.rel || '') });
  }
  const images = [];
  for (const t of noScript.match(/<img\b[^>]*>/gi) || []) {
    const a = attrs(t);
    const url = absUrl(a.src, base);
    if (url && images.length < 50) images.push({ src: url, alt: (a.alt || a.title || '').slice(0, 300) });
  }
  const headings = [];
  for (const h of noScript.match(/<h[1-3]\b[^>]*>[\s\S]*?<\/h[1-3]\s*>/gi) || []) headings.push(clean(h));
  const bodyHtml = /<body[^>]*>([\s\S]*)<\/body>/i.exec(noScript)?.[1] ?? noScript.replace(/<head[^>]*>[\s\S]*?<\/head>/i, ' ');
  const text = clean(bodyHtml.replace(/<(br|p|div|li|h[1-6]|tr|section|article)\b/gi, ' <$1')).slice(0, 100_000);
  const ogType = (meta['og:type'] || '').toLowerCase();
  const published = meta['article:published_time'] || /<time\b[^>]*datetime=["']([^"']+)["']/i.exec(noScript)?.[1] || null;
  const hasPassword = /<input\b[^>]*type\s*=\s*["']?password/i.test(src);
  return {
    title,
    description: (meta.description || meta['og:description'] || '').slice(0, 500),
    keywords: meta.keywords || '',
    noindex: /\b(noindex|none)\b/.test(robots),
    nofollow: /\b(nofollow|none)\b/.test(robots),
    canonical,
    lang: (/<html\b[^>]*\blang=["']?([a-zA-Z-]+)/i.exec(src)?.[1] || '').toLowerCase() || null,
    links,
    images,
    headings: headings.join(' · ').slice(0, 2000),
    text,
    article: ogType === 'article' || /<article\b/i.test(noScript) && !!published,
    published: published ? String(published).slice(0, 40) : null,
    hasPassword,
  };
}

// ——— robots.txt ———

/** Разбор robots.txt: группы { agents, rules: [{ allow, path }] } и Sitemap. */
export function parseRobots(text) {
  const groups = [];
  const sitemaps = [];
  let cur = null;
  let lastWasAgent = false;
  for (const raw of String(text || '').split(/\r?\n/).slice(0, 2000)) {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (k === 'user-agent') {
      if (!lastWasAgent || !cur) { cur = { agents: [], rules: [] }; groups.push(cur); }
      cur.agents.push(v.toLowerCase());
      lastWasAgent = true;
      continue;
    }
    lastWasAgent = false;
    if (k === 'sitemap') { if (v) sitemaps.push(v); continue; }
    if (!cur) continue;
    if (k === 'allow' || k === 'disallow') {
      if (k === 'disallow' && !v) continue; // пустой Disallow — всё разрешено
      cur.rules.push({ allow: k === 'allow', path: v });
    }
  }
  return { groups, sitemaps };
}

function ruleMatch(pattern, path) {
  const anchored = pattern.endsWith('$');
  const p = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(`^${p.split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}${anchored ? '$' : ''}`);
  return re.test(path);
}

/** Можно ли роботу agent заходить на path. Правило с самым длинным шаблоном побеждает, при равенстве — Allow. */
export function robotsAllows(robots, path, agent = 'vlodbot') {
  const ag = agent.toLowerCase();
  let group = robots.groups.find((g) => g.agents.some((a) => a !== '*' && ag.includes(a)));
  if (!group) group = robots.groups.find((g) => g.agents.includes('*'));
  if (!group) return { allowed: true, rule: null };
  let best = null;
  for (const r of group.rules) {
    if (!ruleMatch(r.path, path)) continue;
    if (!best || r.path.length > best.path.length || (r.path.length === best.path.length && r.allow)) best = r;
  }
  return { allowed: !best || best.allow, rule: best ? `${best.allow ? 'Allow' : 'Disallow'}: ${best.path}` : null };
}

// ——— sitemap.xml ———

export function parseSitemap(xml) {
  const locs = [];
  const re = /<loc>\s*([^<\s]+)\s*<\/loc>/gi;
  let m;
  while ((m = re.exec(String(xml || ''))) && locs.length < 5000) locs.push(decodeEntities(m[1]));
  return { index: /<sitemapindex\b/i.test(xml), locs };
}

// ——— Сниппет ———

/**
 * Фрагмент текста вокруг слов запроса: [{ t, b }] (b — подсветить). Безопасно для React — без HTML.
 */
export function snippet(text, queryStems, max = 220) {
  const src = String(text || '');
  if (!src) return [];
  const qs = new Set(queryStems);
  const toks = [];
  const re = /[\p{L}\p{N}]+/gu;
  let m;
  while ((m = re.exec(src))) toks.push({ i: m.index, w: m[0], hit: qs.has(stem(m[0].toLowerCase().replace(/ё/g, 'е'))) });
  let start = 0;
  if (toks.length) {
    let bestScore = -1;
    let bestAt = 0;
    const win = 30;
    for (let k = 0; k < toks.length; k += 3) {
      let sc = 0;
      const seen = new Set();
      for (let j = k; j < Math.min(toks.length, k + win); j++) if (toks[j].hit && !seen.has(toks[j].w.toLowerCase())) { seen.add(toks[j].w.toLowerCase()); sc += 1; }
      if (sc > bestScore) { bestScore = sc; bestAt = k; }
      if (k > 4000) break;
    }
    start = bestScore > 0 ? toks[Math.max(0, bestAt - 3)].i : 0;
  }
  let end = Math.min(src.length, start + max);
  if (end < src.length) { const sp = src.lastIndexOf(' ', end); if (sp > start + max / 2) end = sp; }
  const out = [];
  if (start > 0) out.push({ t: '… ', b: false });
  let pos = start;
  for (const t of toks) {
    if (t.i < start || t.i + t.w.length > end) continue;
    if (!t.hit) continue;
    if (t.i > pos) out.push({ t: src.slice(pos, t.i), b: false });
    out.push({ t: t.w, b: true });
    pos = t.i + t.w.length;
  }
  if (pos < end) out.push({ t: src.slice(pos, end), b: false });
  if (end < src.length) out.push({ t: ' …', b: false });
  return out;
}

/** Расстояние Левенштейна (для «Возможно, вы искали»). */
export function levenshtein(a, b, cap = 3) {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      rowMin = Math.min(rowMin, cur[j]);
    }
    if (rowMin > cap) return cap + 1;
    prev = cur;
  }
  return prev[b.length];
}

/** Нормализация запроса для журнала, подсказок и статистики. */
export const normQuery = (q) => words(q).join(' ').slice(0, 200);
