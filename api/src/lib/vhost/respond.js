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
import { withSite, siteDb, flush, sqlQuery, sqlRun, sqlExec, kvOp, closeDb } from './store.js';
import { runInPool } from './pool.js';
import { gitHttp, isGitPath } from '../hub/hub.js';
import { addLog } from './logs.js';

export const SERVER_FILES = new Set(['server.js', 'server.py', 'crontab']);
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
// Сокеты сайта доступны из любого обработчика (onRequest и onCron тоже могут рассылать сообщения).
let wsHost = null;
export function setWsHost(fn) { wsHost = fn; }
export function resetRateLimits() { rpmCounters.clear(); }
function overRpm(site) {
  const limit = Number(site.rpm || 0);
  if (!limit) return false;
  // Скользящее окно в 60 секунд: время каждого запроса за последнюю минуту.
  const t = Date.now();
  let list = rpmCounters.get(site.id);
  if (!list) { list = []; rpmCounters.set(site.id, list); }
  while (list.length && list[0] <= t - 60000) list.shift();
  if (list.length >= limit) return true;
  list.push(t);
  return false;
}

const page = (status, title, text) => ({
  status, headers: { 'content-type': 'text/html; charset=utf-8' },
  body: Buffer.from(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>${title}</title></head><body style="font-family:system-ui;max-width:560px;margin:12vh auto;padding:0 16px"><h1>${title}</h1><p>${text}</p></body></html>`),
});

const isFile = (p) => fs.stat(p).then((s) => s.isFile(), () => false);
async function hasServer(site) {
  return (await isFile(`${site.dir}/server.js`)) || (await isFile(`${site.dir}/server.py`)) || (await isFile(`${site.dir}/index.php`));
}

/** Кто обрабатывает запрос виртуального сайта: файл .php, server.js, server.py или index.php (фронт-контроллер). */
async function pickHandler(site, pathOnly) {
  let rel;
  try { rel = decodeURIComponent(pathOnly).replace(/^\/+/, ''); } catch { rel = ''; }
  if (/\.php$/i.test(rel) && !rel.split('/').some((p) => p === '..') && (await isFile(`${site.dir}/${rel}`))) return { kind: 'php', entry: rel };
  if ((rel === '' || rel.endsWith('/')) && (await isFile(`${site.dir}/${rel}index.php`))) return { kind: 'php', entry: `${rel}index.php` };
  if (await isFile(`${site.dir}/server.js`)) return { kind: 'js' };
  if (await isFile(`${site.dir}/server.py`)) return { kind: 'python', entry: 'server.py' };
  if (await isFile(`${site.dir}/index.php`)) return { kind: 'php', entry: 'index.php' };
  return null;
}

/** PHP или Python в рабочем потоке. База — тот же файл SQLite: копию в памяти перед запуском сохраняем и закрываем. */
export async function runExternal(site, kind, payload, { depth = 0 } = {}) {
  return withSite(site.id, async () => {
    await flush(site.id).catch(() => {});
    closeDb(site.id);
    const timeoutMs = Math.max(1000, (Number(site.cpu_ms) || 50) * 20);
    let r;
    try {
      r = await runInPool(kind, { ...payload, dir: site.dir, now: await gameSeconds() }, {
        timeoutMs,
        onFetch: (req) => netRequest({ fromIp: site.server_ip, ...req, depth: depth + 1 }),
      });
    } catch (e) {
      const msg = e.kind === 'timeout' ? `${kind === 'php' ? 'PHP' : 'Python'}: превышено время выполнения ${timeoutMs} мс` : `${kind}: ${e.message}`;
      addLog(site.id, 'error', msg);
      throw new ScriptError(msg, { kind: e.kind === 'timeout' ? 'timeout' : 'error' });
    }
    if (r.errors) addLog(site.id, 'error', `PHP: ${r.errors}`);
    if (r.log) addLog(site.id, 'log', r.log.trimEnd());
    if (r.error) { addLog(site.id, 'error', `Python: ${r.error}`); throw new ScriptError(r.error); }
    if (r.missing) throw new ScriptError(`В ${payload.entry} нет функции ${payload.handler}`, { kind: 'missing' });
    return r;
  });
}

/** Выполнить обработчик сайта (onRequest, onCron, …) в очереди сайта, с базой и логами. */
export async function runSite(site, handler, arg, { depth = 0, ws = null, script = 'server.js', onLog = null, chain = [] } = {}) {
  return withSite(site.id, async () => {
    const now = await gameSeconds();
    let entry = null;
    const db = async () => entry || (entry = await siteDb(site));
    await db();
    const t0 = Date.now();
    try {
      const r = await runHandler({
        dir: site.dir, entry: script, handler, arg, cpuMs: Number(site.cpu_ms) || 50,
        host: {
          log: (level, text) => { addLog(site.id, level, text); onLog?.(level, text); },
          now: () => now,
          db: (op, sql, params) => {
            if (op === 'query') return sqlQuery(entry, sql, params);
            if (op === 'run') return sqlRun(entry, sql, params);
            if (op === 'exec') return sqlExec(entry, sql);
            throw new Error('db: неизвестная операция');
          },
          kv: (op, a) => kvOp(entry, op, a, now),
          fetch: (req) => netRequest({ fromIp: site.server_ip, ...req, depth: depth + 1 }),
          ws: ws || (wsHost ? wsHost(site.id) : null),
          mail: async (req) => {
            const { sendFromSite } = await import('../mailnet/mailbox.js');
            return sendFromSite(site, req, { depth: depth + 1, chain: [...chain, site.id] });
          },
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
    if (f.file && virtual && /\.php$/i.test(f.file)) { /* исходник PHP не отдаём — выполняем ниже */ } else if (f.file && (f.status === 200 || !virtual || !(await hasServer(site)))) {
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
  const handler = await pickHandler(site, pathOnly);
  if (!handler) return { status: 404, headers: { 'content-type': 'text/html; charset=utf-8' }, body: Buffer.alloc(0), notFound: true };
  const reqArg = {
    method, url: `${scheme}://${req.host || site.host}${urlPath}`, path: pathOnly, search: urlPath.includes('?') ? urlPath.slice(urlPath.indexOf('?')) : '',
    headers: req.headers || {}, body: body.slice(0, 1024 * 1024), ip: req.ip || null, host: req.host || site.host,
  };
  try {
    const out = handler.kind === 'js'
      ? await runSite(site, 'onRequest', reqArg, { depth })
      : await runExternal(site, handler.kind, { mode: 'request', entry: handler.entry, handler: 'on_request', req: reqArg }, { depth });
    const headers = {};
    for (const [k, v] of Object.entries(out.headers || {})) if (/^[a-z0-9-]{1,64}$/.test(k)) headers[k] = String(v).slice(0, 2000);
    if (!headers['content-type']) headers['content-type'] = 'text/plain; charset=utf-8';
    const buf = out.b64 === true ? Buffer.from(out.body, 'base64') : out.b64 ? Buffer.from(out.b64, 'base64') : Buffer.from(String(out.body ?? ''), 'utf8');
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
    if (conn.target === 'app:hub' && isGitPath(p.path)) {
      // ВлодХаб принимает git по HTTP (clone, fetch, push) — как настоящий git-хостинг.
      if (p.scheme === 'https' && !(await tlsFor({ target: conn.target, host: p.host }))) return { error: 'ERR_CONNECTION_REFUSED', ip };
      const g = await gitHttp({ method, path: p.path, headers, body: Buffer.isBuffer(body) ? body : Buffer.from(body || '') });
      const out = { status: g.status, headers: g.headers, url: cur, ip, siteId: null };
      if (binary) out.buf = g.body; else out.body = g.body.toString('utf8');
      return out;
    }
    if (conn.target.startsWith('app:')) {
      // Госсайты отвечают серверам только своим API: эквайринг pay.bank.bln/api/v1 и OAuth ВлодПочты и ВлодУслуг.
      if (p.scheme === 'https' && !(await tlsFor({ target: conn.target, host: p.host }))) return { error: 'ERR_CONNECTION_REFUSED', ip };
      const { govHttp } = await import('../pay/api.js');
      const g = p.scheme === 'https'
        ? await govHttp(conn.target, { method, path: p.path, headers, body })
        : { status: 400, headers: { 'content-type': 'application/json; charset=utf-8' }, body: Buffer.from(JSON.stringify({ error: { code: 'https_required', message: 'API госсайтов — только по https://' } })) };
      if (!g) return { error: 'ERR_GOV_SITE: этот адрес госсайта открывается только во ВлодБраузере (серверам доступны pay.bank.bln/api/v1 и /oauth/…)', ip, gov: true };
      const res = { status: g.status, headers: g.headers, url: cur, ip, siteId: null, gov: true };
      if (binary) res.buf = g.body; else res.body = g.body.toString('utf8');
      return res;
    }
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

/** Дойти до сайта по сети, не делая HTTP-запроса (WebSocket): { site, host } или { error }. */
export async function reachSite({ fromIp, url }) {
  const p = splitUrl(String(url || '').replace(/^ws(s?):/i, 'http$1:'));
  if (!p || (p.scheme !== 'http' && p.scheme !== 'https')) return { error: 'Неверный адрес WebSocket' };
  const dns = await resolve({ resolverIp: PUBLIC_DNS, clientIp: fromIp, clientProviderId: null, name: p.host, type: 'A' });
  const ip = [...dns.answer].reverse().find((r) => r.type === 'A')?.data;
  if (!ip) return { error: dnsCode(dns) };
  const conn = connect(await netSnapshot(), fromIp, ip, p.host);
  if (!conn.ok) return { error: conn.code };
  if (conn.target.startsWith('app:')) return { error: 'ERR_GOV_SITE' };
  if (p.scheme === 'https') {
    const tls = await tlsFor({ target: conn.target, host: p.host });
    if (!tls) return { error: 'ERR_CONNECTION_REFUSED' };
    const v = await verifyTls({ tls, host: p.host, now: tls.time, trust: await trustStore() });
    if (!v.ok) return { error: v.code };
  }
  const site = await siteByTarget(conn.target);
  if (!site || site.account_status !== 'active') return { error: 'Сайт недоступен' };
  if (site.kind !== 'virtual') return { error: 'Сайт на статическом тарифе не принимает WebSocket' };
  return { site, host: p.host, path: p.path.split('?')[0], query: p.path.includes('?') ? p.path.slice(p.path.indexOf('?') + 1) : '' };
}

/** Виртуальные сайты с server.js (для cron и панели). */
export async function virtualSites() {
  return q("SELECT s.id FROM hosting_sites s JOIN hosting_accounts a ON a.id = s.account_id JOIN hosting_plans p ON p.id = a.plan_id WHERE a.status = 'active' AND p.kind = 'virtual'");
}
