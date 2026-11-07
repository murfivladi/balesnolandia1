// Safe Browsing ВлодПоиска (как Google Safe Browsing v4): адрес → набор выражений «хост-суффикс + префикс пути»,
// от каждого — SHA-256. Браузер скачивает 4-байтовые префиксы хешей списка, при совпадении спрашивает полные хеши.
// Сам адрес страницы на сервер не уходит.
import { sha256Hex } from './balnet-pki.js';

export const THREATS = {
  phishing: { title: 'Обманный сайт', text: 'Злоумышленники на этом сайте могут обманом вынудить вас ввести пароль, номер карты или другие личные данные.' },
  malware: { title: 'Сайт содержит вредоносное ПО', text: 'Этот сайт может попытаться установить на устройство опасные программы, которые крадут или удаляют данные.' },
  unwanted: { title: 'Сайт с нежелательным ПО', text: 'Сайт может обманом заставить вас установить программы, которые мешают работе браузера.' },
};

export const PREFIX_HEX = 8; // 4 байта

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

/** Канонический вид: хост в нижнем регистре без точки в конце, путь без «//», «./», «../». */
export function canonicalize(url) {
  let u;
  try { u = new URL(String(url).trim()); } catch { return null; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase().replace(/\.+$/, '').replace(/^\.+/, '');
  if (!host) return null;
  const parts = [];
  for (const p of u.pathname.split('/').slice(1)) {
    if (p === '.' ) continue;
    if (p === '..') { parts.pop(); continue; }
    parts.push(p);
  }
  let path = `/${parts.filter((p, i) => p !== '' || i === parts.length - 1).join('/')}`;
  path = path.replace(/\/{2,}/g, '/');
  return { host, path, query: u.search ? u.search.slice(1) : '' };
}

/** Выражения для проверки: до 5 хостов × до 6 путей. */
export function urlExpressions(url) {
  const c = canonicalize(url);
  if (!c) return [];
  const hosts = [c.host];
  if (!IPV4.test(c.host)) {
    const labels = c.host.split('.');
    const tail = labels.slice(-5);
    for (let i = 1; i < tail.length - 1 && hosts.length < 5; i++) {
      const h = tail.slice(i).join('.');
      if (!hosts.includes(h)) hosts.push(h);
    }
  }
  const paths = [];
  if (c.query) paths.push(`${c.path}?${c.query}`);
  paths.push(c.path);
  if (c.path !== '/') paths.push('/');
  const segs = c.path.split('/').filter(Boolean);
  for (let i = 1; i < segs.length && paths.length < 6; i++) {
    const p = `/${segs.slice(0, i).join('/')}/`;
    if (!paths.includes(p)) paths.push(p);
  }
  const out = [];
  for (const h of hosts) for (const p of paths) out.push(h + p);
  return [...new Set(out)];
}

/** Выражение из списка («evil.bln/», «evil.bln/login/») → канонический вид. */
export function normalizeExpression(expr) {
  const s = String(expr || '').trim().replace(/^https?:\/\//i, '');
  if (!s) return null;
  const c = canonicalize(`http://${s.includes('/') ? s : `${s}/`}`);
  if (!c) return null;
  return c.host + c.path + (c.query ? `?${c.query}` : '');
}

export const expressionHash = (expr) => sha256Hex(expr);

/** Хеши всех выражений адреса: [{ expr, hash, prefix }]. */
export async function urlHashes(url) {
  const out = [];
  for (const expr of urlExpressions(url)) {
    const hash = await sha256Hex(expr);
    out.push({ expr, hash, prefix: hash.slice(0, PREFIX_HEX) });
  }
  return out;
}
