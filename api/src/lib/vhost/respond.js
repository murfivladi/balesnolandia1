// Ответ сайта хостинга на HTTP-запрос — одна функция для всех, кто ходит на сайты: шлюз ВлодБраузера,
// fetch со страниц, робот ВлодПоиска и fetch из серверного кода других сайтов.
// Статический тариф — файлы. Виртуальный — сначала файл, иначе (и для POST/PUT/…) — onRequest из server.js.
import fs from 'node:fs/promises';
import { q } from '../../db.js';
import { resolve } from '../dns.js';
import { netSnapshot, connect } from '../net.js';
import { tlsFor, trustStore } from '../pki.js';
import { siteByTarget } from '../hosting.js';
import { gameSeconds } from '../clock.js';
import { accountDir, dirSize } from '../sitefs.js';
import { resolveFile, typeOf, siteHeaders } from '../gateway.js';
import { verifyTls } from '@bln/shared/balnet-pki.js';
import { splitUrl } from '@bln/shared/balnet-url.js';
import { runHandler, ScriptError } from './runtime.js';
import { withSite, siteDb, flush, sqlQuery, sqlRun, sqlExec, kvOp } from './store.js';
import { addLog } from './logs.js';

export const SERVER_FILES = new Set(['server.js', 'crontab']);
const PUBLIC_DNS = '50.0.0.53';
const MAX_DEPTH = 3;

/** Скрытые пути: служебные файлы сервера и всё, что начинается с точки (кроме .well-known). */
export function hiddenPath(urlPath, kind) {
  let rel;
  try { rel = decodeURIComponent(urlPath.split('?')[0]).replace(/^\/+/, ''); } catch { return false; }
  const parts = rel.split('/');
  if (parts.some((p) => p.startsWith('.') && p !== '.well-known')) return true;
  if (kind === 'virtual' && (SERVER_FILES.has(parts[0]) || parts[0] === 'server')) return true;
  return false;
}

// ——— Лимит запросов в минуту ———
const rpmCounters = new Map();
export function resetRateLimits() { rpmCounters.clear(); }
function overRpm(site) {
  const limit = Number(site.rpm || 0);
  if (!limit) return false;
  const minute = Math.floor(Date.now() / 60000);
  const c = rpmCounters.get(site.id);
  if (!c || c.minute !== minute) { rpmCounters.set(site.id, { minute, n: 1 }); return false; }
  c.n += 1;
  return c.n > limit;
}

const page = (status, title, text) => ({
  status, headers: { 'content-type': 'text/html; charset=utf-8' },
  body: Buffer.from(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui;max-width:560px;margin:12vh auto;padding:0 16px"><h1>${title}</h1><p>${text}</p></body></html>`),
});

async function hasServer(site) {
  return fs.stat(`${site.dir}/server.js`).then((s) => s.isFile(), () => false);
}

/** Выполнить обработчик сайта (onRequest, onCron, …) в очереди сайта, с базой и логами. */
export async function runSite(site, handler, arg, { depth = 0 } = {}) {
  return withSite(site.id, async () => {
    const now = await gameSeconds();
    let entry = null;
    const db = async () => entry || (entry = await siteDb(site));
    await db();
    const t0 = Date.now();
    try {
      const r = await runHandler({
        dir: site.dir, handler, arg, cpuMs: Number(site.cpu_ms) || 50,
        host: {
          log: (level, text) => addLog(site.id, level, text),
          now: () => now,
          db: (op, sql, params) => {
            if (op === 'query') return sqlQuery(entry, sql, params);
            if (op === 'run') return sqlRun(entry, sql, params);
            if (op === 'exec') return sqlExec(entry, sql);
            throw new Error('db: неизвестная операция');
          },
          kv: (op, a) => kvOp(entry, op, a, now),
          fetch: (req) => netRequest({ fromIp: site.server_ip, ...req, depth: depth + 1 }),
        },
      });
      return r.result;
    } catch (e) {
      if (e instanceof ScriptError) {
        addLog(site.id, 'error', `${handler}: ${e.message}${e.scriptStack ? `\n${e.scriptStack}` : ''}`);
        e.ms = Date.now() - t0;
      }
      throw e;
    } finally {
      if (entry?.dirty) {
        const quota = Number(site.disk_mb) * 1048576 - (await dirSize(accountDir(site.account_id)));
        await flush(site.id, { quotaLeft: quota }).catch((e) => addLog(site.id, 'error', e.message));
      }
    }
  });
}

/**
 * Ответ сайта: { status, headers, body: Buffer, dynamic, setCookies }.
 * req: { method, path (с ?query), headers, body (Buffer|string), ip, host, scheme }
 */
export async function siteRespond(site, req, { depth = 0 } = {}) {
  if (overRpm(site)) return { ...page(429, '429 — слишком много запросов', `Сайт превысил лимит тарифа: ${site.rpm} запросов в минуту.`), headers: { 'content-type': 'text/html; charset=utf-8', 'retry-after': '60' } };
  const method = String(req.method || 'GET').toUpperCase();
  const urlPath = String(req.path || '/').split('#')[0];
  const pathOnly = urlPath.split('?')[0];
  const virtual = site.kind === 'virtual';
  const hidden = hiddenPath(urlPath, site.kind);
  if ((method === 'GET' || method === 'HEAD') && !hidden) {
    const f = await resolveFile(site.dir, urlPath);
    if (f.status === 301) return { status: 301, headers: { location: f.location + (urlPath.includes('?') ? urlPath.slice(urlPath.indexOf('?')) : '') }, body: Buffer.alloc(0) };
    if (f.file && (f.status === 200 || !virtual || !(await hasServer(site)))) {
      const headers = { 'content-type': typeOf(f.file) };
      for (const [k, v] of Object.entries(await siteHeaders(site.dir, pathOnly))) headers[k] = v;
      return { status: f.status, headers, body: method === 'HEAD' ? Buffer.alloc(0) : await fs.readFile(f.file), file: f.file };
    }
    if (!virtual || !(await hasServer(site))) return { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.alloc(0), notFound: true };
  } else if (!virtual) {
    if (hidden) return { status: 404, headers: {}, body: Buffer.alloc(0), notFound: true };
    return page(405, '405 — метод не разрешён', 'Сайт размещён на статическом хостинге и не принимает отправку форм. Для серверного кода нужен виртуальный тариф.');
  } else if (!(await hasServer(site))) {
    return page(405, '405 — метод не разрешён', 'На сайте нет server.js — некому обработать запрос.');
  }
  const body = Buffer.isBuffer(req.body) ? req.body.toString('utf8') : String(req.body ?? '');
  const scheme = req.scheme || 'http';
  try {
    const out = await runSite(site, 'onRequest', {
      method, url: `${scheme}://${req.host || site.host}${urlPath}`, path: pathOnly, search: urlPath.includes('?') ? urlPath.slice(urlPath.indexOf('?')) : '',
      headers: req.headers || {}, body: body.slice(0, 1024 * 1024), ip: req.ip || null, host: req.host || site.host,
    }, { depth });
    const headers = {};
    for (const [k, v] of Object.entries(out.headers || {})) if (/^[a-z0-9-]{1,64}$/.test(k)) headers[k] = String(v).slice(0, 2000);
    if (!headers['content-type']) headers['content-type'] = 'text/plain; charset=utf-8';
    const buf = out.b64 ? Buffer.from(out.b64, 'base64') : Buffer.from(String(out.body ?? ''), 'utf8');
    const status = Number(out.status) >= 100 && Number(out.status) < 600 ? Number(out.status) : 200;
    return { status, headers, body: method === 'HEAD' ? Buffer.alloc(0) : buf, dynamic: true, setCookies: Array.isArray(out.cookies) ? out.cookies.slice(0, 20).map(String) : [] };
  } catch (e) {
    if (e instanceof ScriptError) {
      const title = e.kind === 'cpu' ? '508 — превышен лимит CPU' : e.kind === 'timeout' ? '504 — скрипт не ответил' : '500 — ошибка сервера';
      return page(e.kind === 'cpu' ? 508 : e.kind === 'timeout' ? 504 : 500, title, `Серверный код сайта завершился с ошибкой. Владельцу: смотрите журнал в панели БалХоста.`);
    }
    if (e.code === 'quota') return page(507, '507 — нет места', e.message);
    throw e;
  }
}

// ——— Запрос по сети БалНета (fetch сервера, робот, межсайтовые запросы) ———

function dnsCode(dns) {
  if (dns.rcode === 'NXDOMAIN') return 'DNS_PROBE_FINISHED_NXDOMAIN';
  if (dns.rcode === 'NOERROR') return 'ERR_NAME_NOT_RESOLVED';
  return 'ERR_NAME_RESOLUTION_FAILED';
}

/**
 * HTTP-запрос из точки fromIp: DNS → подключение → TLS → ответ сайта. Редиректы GET выполняются (до 5).
 * Возвращает { status, headers, body (строка), url } или { error }.
 */
export async function netRequest({ fromIp, url, method = 'GET', headers = {}, body = null, depth = 0, follow = true, binary = false, fresh = false }) {
  if (depth > MAX_DEPTH) return { error: 'Слишком длинная цепочка запросов между сайтами (больше 3)' };
  let cur = String(url || '');
  for (let hop = 0; hop < 6; hop++) {
    const p = splitUrl(cur);
    if (!p || (p.scheme !== 'http' && p.scheme !== 'https')) return { error: `Неверный адрес: ${cur}` };
    const dns = await resolve({ resolverIp: PUBLIC_DNS, clientIp: fromIp, clientProviderId: null, name: p.host, type: 'A', fresh });
    const ip = [...dns.answer].reverse().find((r) => r.type === 'A')?.data;
    if (!ip) return { error: dnsCode(dns) };
    const conn = connect(await netSnapshot(), fromIp, ip, p.host);
    if (!conn.ok) return { error: conn.code, ip };
    if (conn.target.startsWith('app:')) return { error: 'ERR_GOV_SITE: госсайты не принимают запросы от серверов (API для сайтов появятся с эквайрингом ВлодБанка)', ip, gov: true };
    if (p.scheme === 'https') {
      const tls = await tlsFor({ target: conn.target, host: p.host });
      if (!tls) return { error: 'ERR_CONNECTION_REFUSED', ip, note: 'на сервере нет сертификата (порт 443 закрыт)' };
      const v = await verifyTls({ tls, host: p.host, now: tls.time, trust: await trustStore() });
      if (!v.ok) return { error: v.code, ip };
    }
    const site = await siteByTarget(conn.target);
    let r;
    if (!site || site.account_status === 'deleted' || site.account_status === 'reserved') r = page(404, '404 — сайт не найден на сервере', 'Хостинг для этого имени удалён.');
    else if (site.account_status === 'suspended') r = page(403, 'Сайт приостановлен', 'Хостинг этого сайта не оплачен.');
    else r = await siteRespond(site, { method, path: p.path, headers: { ...headers, host: p.host }, body, ip: fromIp, host: p.host, scheme: p.scheme }, { depth });
    if (follow && [301, 302, 303, 307, 308].includes(r.status) && r.headers.location) {
      cur = new URL(r.headers.location, `${p.scheme}://${p.host}${p.path}`).href;
      if (r.status === 303 || ((r.status === 301 || r.status === 302) && method === 'POST')) { method = 'GET'; body = null; }
      continue;
    }
    const out = { status: r.status, headers: r.headers, url: cur, ip, siteId: site?.id || null, notFound: !!r.notFound };
    if (binary) out.buf = r.body;
    else out.body = r.body.toString('utf8');
    return out;
  }
  return { error: 'ERR_TOO_MANY_REDIRECTS' };
}

/** Виртуальные сайты с server.js (для cron и панели). */
export async function virtualSites() {
  return q("SELECT s.id FROM hosting_sites s JOIN hosting_accounts a ON a.id = s.account_id JOIN hosting_plans p ON p.id = a.plan_id WHERE a.status = 'active' AND p.kind = 'virtual'");
}
