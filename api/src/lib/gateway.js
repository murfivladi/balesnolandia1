// Шлюз сайтов игроков: билет «устройство + сайт» → выдача файлов из хостинга в изолированную песочницу.
// Каждый ответ идёт с CSP sandbox: даже открытый напрямую, код сайта выполняется в непрозрачном origin
// и не может читать cookies и API ВлодБанка.
import fs from 'node:fs/promises';
import path from 'node:path';
import { randomToken } from './ids.js';
import { safeJoin } from './sitefs.js';

const TICKET_TTL_MS = 3 * 60 * 60 * 1000;
const MAX_TICKETS = 20000;
const tickets = new Map();

export function createTicket(data) {
  if (tickets.size >= MAX_TICKETS) tickets.delete(tickets.keys().next().value);
  const id = randomToken(18).replace(/[^A-Za-z0-9]/g, '').slice(0, 24);
  tickets.set(id, { ...data, cookies: data.cookies || {}, local: data.local || {}, expires: Date.now() + TICKET_TTL_MS });
  return id;
}

export function getTicket(id) {
  const t = tickets.get(String(id || ''));
  if (!t) return null;
  if (t.expires < Date.now()) { tickets.delete(id); return null; }
  return t;
}

/** Хранилища сайта (cookies, localStorage) приходят от ВлодБраузера. Размер ограничен. */
export function cleanJar(jar) {
  const out = { cookies: {}, local: {} };
  let size = 0;
  const add = (v) => { size += String(v).length; return size < 200_000; };
  for (const [k, v] of Object.entries(jar?.cookies || {}).slice(0, 100)) {
    if (typeof k !== 'string' || !v || typeof v.v !== 'string' || !add(k + v.v)) continue;
    out.cookies[k.slice(0, 200)] = { v: v.v.slice(0, 4096), exp: Number.isFinite(v.exp) ? v.exp : null };
  }
  for (const [k, v] of Object.entries(jar?.local || {}).slice(0, 1000)) {
    if (typeof v !== 'string' || !add(k + v)) continue;
    out.local[String(k).slice(0, 500)] = v;
  }
  return out;
}

export const SANDBOX_CSP = 'sandbox allow-scripts allow-forms allow-popups allow-modals allow-downloads';

export function securityHeaders(reply) {
  reply.header('Content-Security-Policy', SANDBOX_CSP);
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'no-referrer');
  reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
  reply.header('Access-Control-Allow-Origin', '*');
  reply.header('Cache-Control', 'no-store');
}

const TYPES = {
  html: 'text/html; charset=utf-8', htm: 'text/html; charset=utf-8', css: 'text/css; charset=utf-8', js: 'text/javascript; charset=utf-8', mjs: 'text/javascript; charset=utf-8',
  json: 'application/json; charset=utf-8', txt: 'text/plain; charset=utf-8', md: 'text/plain; charset=utf-8', xml: 'application/xml; charset=utf-8', csv: 'text/csv; charset=utf-8',
  svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', avif: 'image/avif', ico: 'image/x-icon',
  woff: 'font/woff', woff2: 'font/woff2', ttf: 'font/ttf', otf: 'font/otf', mp3: 'audio/mpeg', ogg: 'audio/ogg', wav: 'audio/wav', mp4: 'video/mp4', webm: 'video/webm',
  pdf: 'application/pdf', webmanifest: 'application/manifest+json', wasm: 'application/wasm',
};
export const typeOf = (name) => TYPES[String(name).split('.').pop().toLowerCase()] || 'application/octet-stream';
const HIDDEN = new Set(['_headers', '_redirects']);

/** Netlify-подобный _headers: «/путь» или «/папка/*», ниже — «  Заголовок: значение». */
export async function siteHeaders(dir, urlPath) {
  let text;
  try { text = await fs.readFile(path.join(dir, '_headers'), 'utf8'); } catch { return {}; }
  const out = {};
  let match = false;
  for (const line of text.split('\n').slice(0, 500)) {
    if (!line.trim() || line.trim().startsWith('#')) continue;
    if (!/^\s/.test(line)) {
      const pat = line.trim();
      match = pat === urlPath || (pat.endsWith('*') && urlPath.startsWith(pat.slice(0, -1)));
      continue;
    }
    if (!match) continue;
    const i = line.indexOf(':');
    if (i < 0) continue;
    const k = line.slice(0, i).trim().toLowerCase();
    const v = line.slice(i + 1).trim();
    if (/^[a-z0-9-]{1,64}$/.test(k) && v.length < 1000) out[k] = v;
  }
  return out;
}
/** Какие заголовки сайт может задать сам. Безопасность (CSP, CORS для шлюза) — только шлюз. */
const SITE_HEADER_OK = (k) => k === 'cache-control' || k === 'content-language' || k.startsWith('x-') && k !== 'x-content-type-options' && k !== 'x-frame-options';

/** Найти файл по пути URL: каталог → index.html; иначе 404.html сайта. */
export async function resolveFile(dir, urlPath) {
  let rel;
  try {
    rel = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, '');
  } catch {
    return { status: 400 };
  }
  if (rel.split('/').some((p) => HIDDEN.has(p))) return { status: 404 };
  let full;
  try { ({ full } = safeJoin(dir, rel)); } catch { return { status: 404 }; }
  const st = await fs.stat(full).catch(() => null);
  if (st?.isDirectory()) {
    if (rel && !urlPath.split('?')[0].endsWith('/')) return { status: 301, location: `${urlPath.split('?')[0]}/` };
    const index = path.join(full, 'index.html');
    if ((await fs.stat(index).catch(() => null))?.isFile()) return { status: 200, file: index };
  } else if (st?.isFile()) return { status: 200, file: full };
  const nf = path.join(dir, '404.html');
  if ((await fs.stat(nf).catch(() => null))?.isFile()) return { status: 404, file: nf };
  return { status: 404 };
}

/** Абсолютные пути сайта («/style.css») в HTML и CSS ведём через шлюз. */
export function rewriteRootPaths(text, prefix, kind) {
  const fix = (u) => (u.startsWith('/') && !u.startsWith('//') ? prefix + u : u);
  if (kind === 'css') return text.replace(/url\(\s*(['"]?)(\/[^'")]*)\1\s*\)/g, (m, q, u) => `url(${q}${fix(u)}${q})`);
  return text
    .replace(/(\s(?:src|href|action|poster|data)\s*=\s*)(["'])(\/[^"']*)\2/gi, (m, a, q, u) => `${a}${q}${fix(u)}${q}`)
    .replace(/url\(\s*(['"]?)(\/[^'")]*)\1\s*\)/g, (m, q, u) => `url(${q}${fix(u)}${q})`);
}

/** Вставить shim и данные сайта в начало HTML. */
export function injectShim(html, cfg) {
  const json = JSON.stringify(cfg).replace(/</g, '\\u003c');
  const tag = `<script>window.__BALNET__=${json};</script><script src="/api/net/shim.js"></script>`;
  const m = /<head[^>]*>/i.exec(html);
  if (m) return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  const d = /<!doctype[^>]*>/i.exec(html);
  if (d) return html.slice(0, d.index + d[0].length) + tag + html.slice(d.index + d[0].length);
  return tag + html;
}

/** Служебная страница шлюза (404, приостановлен, устарела ссылка). */
export function servicePage(title, text) {
  const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>${esc(title)}</title>
<style>body{font-family:system-ui,sans-serif;max-width:560px;margin:12vh auto;padding:0 16px;color:#121826;background:#f4f6fa}h1{font-size:1.5rem}p{color:#5b6475}@media (prefers-color-scheme:dark){body{background:#0e1117;color:#e8ebf2}p{color:#9aa3b5}}</style>
</head><body><h1>${esc(title)}</h1><p>${esc(text)}</p></body></html>`;
}

export { SITE_HEADER_OK };
