// Шлюз сайтов игроков (этапы Н4, Н7): /api/net/shim.js, /api/net/web/<билет>/<путь> (любой метод — на виртуальном
// тарифе отвечает server.js), /api/net/xfetch (запросы к другим сайтам по правилам CORS), /api/net/jar (cookies).
import { bad } from '../lib/errors.js';
import { isPaused } from '../lib/clock.js';
import {
  getTicket, securityHeaders, rewriteRootPaths, injectShim, servicePage, siteHeaders, SITE_HEADER_OK, cleanJar, applySetCookies, cookieHeader,
} from '../lib/gateway.js';
import { siteRespond, netRequest } from '../lib/vhost/respond.js';
import { siteByTarget } from '../lib/hosting.js';
import { SHIM_JS } from '../lib/balnet-shim.js';
import { splitUrl } from '@bln/shared/balnet-url.js';

const MAX_INLINE = 2 * 1024 * 1024;
const SHIM_ETAG = `"shim-${SHIM_JS.length}-${[...SHIM_JS].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7)}"`;

function page(reply, status, title, text) {
  securityHeaders(reply);
  return reply.code(status).type('text/html; charset=utf-8').send(servicePage(title, text));
}

/** Сайт по билету или служебная страница. */
async function siteOf(reply, ticket) {
  if (!ticket) {
    page(reply, 410, 'Ссылка устарела', 'Обновите страницу во ВлодБраузере — браузер заново найдёт сайт через DNS.');
    return null;
  }
  if (await isPaused()) {
    page(reply, 503, 'БалНет на обслуживании', 'Игровое время на паузе.');
    return null;
  }
  const site = await siteByTarget(ticket.target);
  if (!site) {
    page(reply, 404, '404 — сайт не найден на сервере', 'Хостинг для этого имени удалён.');
    return null;
  }
  if (site.account_status === 'suspended') {
    page(reply, 403, 'Сайт приостановлен', 'Хостинг этого сайта не оплачен. Владельцу: продлите тариф во ВлодУслугах.');
    return null;
  }
  if (site.account_status !== 'active') {
    page(reply, 404, '404 — сайт не найден на сервере', 'Хостинг этого сайта ещё не оплачен или удалён.');
    return null;
  }
  return site;
}

export async function webRoutes(app) {
  app.get('/shim.js', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    reply.header('Cache-Control', 'public, max-age=300');
    reply.header('ETag', SHIM_ETAG);
    if (req.headers['if-none-match'] === SHIM_ETAG) return reply.code(304).send();
    return reply.type('text/javascript; charset=utf-8').send(SHIM_JS);
  });

  // Страницы сайта: тело запроса передаётся как есть (формы, JSON, текст) — его разбирает server.js.
  await app.register(async (sub) => {
    sub.removeAllContentTypeParsers();
    sub.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (req, body, done) => done(null, body));
    const serve = async (req, reply) => {
      const ticketId = req.params.ticket;
      const ticket = getTicket(ticketId);
      const site = await siteOf(reply, ticket);
      if (!site) return reply;
      const prefix = `/api/net/web/${ticketId}`;
      const urlPath = `/${req.params['*'] || ''}`;
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      const headers = {};
      for (const k of ['content-type', 'accept', 'accept-language', 'user-agent']) if (req.headers[k]) headers[k] = String(req.headers[k]);
      const ck = cookieHeader(ticket.cookies);
      if (ck) headers.cookie = ck;
      headers.referer = ticket.origin + urlPath;
      const r = await siteRespond(site, { method: req.method, path: urlPath + query, headers, body: req.body || null, ip: ticket.clientIp, host: ticket.host, scheme: ticket.scheme });
      const jarChanged = applySetCookies(ticket, r.setCookies);
      securityHeaders(reply);
      if (jarChanged) reply.header('X-Balnet-Jar', '1');
      if (r.status >= 300 && r.status < 400 && r.headers.location) {
        // Переадресация внутри своего сайта остаётся в шлюзе; на другой сайт — через ВлодБраузер (shim).
        const loc = new URL(r.headers.location, `${ticket.origin}${urlPath}`);
        const same = `${loc.protocol}//${loc.host}` === ticket.origin;
        return reply.code(r.status).header('Location', same ? `${prefix}${loc.pathname}${loc.search}` : `${prefix}/__balnet_redirect?to=${encodeURIComponent(loc.href)}`).send();
      }
      if (r.notFound) return page(reply, 404, '404 — страница не найдена', `На сайте ${ticket.host} нет страницы ${urlPath}.`);
      for (const [k, v] of Object.entries(r.headers)) if (k !== 'content-type' && (SITE_HEADER_OK(k) || (r.dynamic && k === 'location'))) reply.header(k, v);
      const type = r.headers['content-type'] || 'application/octet-stream';
      reply.code(r.status).type(type);
      if (req.method === 'HEAD') return reply.send();
      if (type.startsWith('text/html')) {
        const html = rewriteRootPaths(r.body.toString('utf8'), prefix, 'html');
        return reply.send(injectShim(html, {
          ticket: ticketId, prefix, origin: ticket.origin, cookies: ticket.cookies, local: ticket.local, jarDirty: jarChanged,
        }));
      }
      if (type.startsWith('text/css')) return reply.send(rewriteRootPaths(r.body.toString('utf8'), prefix, 'css'));
      return reply.send(r.body);
    };
    // Переадресация сайта на чужой адрес: страница просит ВлодБраузер открыть его.
    sub.get('/web/:ticket/__balnet_redirect', async (req, reply) => {
      securityHeaders(reply);
      const to = String(req.query.to || '');
      const ticket = getTicket(req.params.ticket);
      if (!ticket || !/^https?:\/\//.test(to)) return page(reply, 400, 'Неверная переадресация', '');
      return reply.type('text/html; charset=utf-8').send(injectShim(`<!doctype html><html><head><title>Переадресация</title></head><body><script>parent.postMessage({__balnet:1,ticket:${JSON.stringify(req.params.ticket)},type:'open',url:${JSON.stringify(to).replace(/</g, '\\u003c')}},'*')</script></body></html>`, { ticket: req.params.ticket, prefix: `/api/net/web/${req.params.ticket}`, origin: ticket.origin, cookies: ticket.cookies, local: ticket.local }));
    });
    sub.route({ method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], url: '/web/:ticket/*', handler: serve });
    sub.get('/web/:ticket', async (req, reply) => reply.redirect(`/api/net/web/${req.params.ticket}/`));
  });

  // fetch со страницы сайта к другому сайту БалНета. Правила как в браузере: свой origin — можно,
  // чужой — только если сайт разрешил (Access-Control-Allow-Origin в _headers или в ответе server.js).
  // Для «непростых» запросов (PUT, DELETE, JSON) сначала идёт предварительный OPTIONS, как в браузере.
  app.post('/xfetch', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    const ticket = getTicket(b?.ticket);
    if (!ticket) return { error: 'ticket', message: 'Страница устарела — обновите её' };
    const method = String(b.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return { error: 'method', message: `Метод ${method} не поддерживается` };
    if (await isPaused()) return { error: 'maintenance', message: 'БалНет на обслуживании' };
    const target = splitUrl(String(b.url || ''));
    if (!target || (target.scheme !== 'http' && target.scheme !== 'https')) return { error: 'url', message: 'Неверный адрес' };
    const targetOrigin = `${target.scheme}://${target.host}`;
    const cross = targetOrigin !== ticket.origin;
    const headers = {};
    for (const [k, v] of Object.entries(b.headers || {}).slice(0, 30)) if (/^[a-z0-9-]{1,64}$/i.test(k) && !/^(cookie|host|origin)$/i.test(k)) headers[k.toLowerCase()] = String(v).slice(0, 2000);
    if (cross) headers.origin = ticket.origin;
    else { const ck = cookieHeader(ticket.cookies); if (ck) headers.cookie = ck; }
    const allowOf = async (res, pathOnly) => {
      const h = res.siteId ? { ...(await siteHeadersFor(res)), ...res.headers } : res.headers;
      return { origin: h['access-control-allow-origin'], methods: String(h['access-control-allow-methods'] || ''), pathOnly };
    };
    const ctype = String(headers['content-type'] || '').split(';')[0];
    const simple = ['GET', 'HEAD', 'POST'].includes(method) && (!ctype || ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'].includes(ctype));
    if (cross && !simple) {
      const pre = await netRequest({ fromIp: ticket.clientIp, url: b.url, method: 'OPTIONS', headers: { origin: ticket.origin, 'access-control-request-method': method }, follow: false });
      if (pre.error) return { error: 'network', message: pre.error };
      const a = await allowOf(pre);
      if ((a.origin !== '*' && a.origin !== ticket.origin) || (a.methods && a.methods !== '*' && !a.methods.toUpperCase().split(/\s*,\s*/).includes(method))) {
        return { error: 'cors', message: `CORS: предварительный запрос к ${targetOrigin} не разрешил ${method} с ${ticket.origin}` };
      }
    }
    const body = b.body === undefined || b.body === null ? null : Buffer.from(String(b.body), b.bodyB64 ? 'base64' : 'utf8');
    const res = await netRequest({ fromIp: ticket.clientIp, url: b.url, method, headers, body, binary: true });
    if (res.gov) return { error: 'cors', message: `CORS: ${targetOrigin} не разрешает запросы с ${ticket.origin}` };
    if (res.error) return { error: 'network', message: res.error };
    if (cross) {
      const a = await allowOf(res);
      if (a.origin !== '*' && a.origin !== ticket.origin) return { error: 'cors', message: `CORS: ${targetOrigin} не разрешает запросы с ${ticket.origin}` };
    } else if (res.headers['set-cookie']) {
      applySetCookies(ticket, [].concat(res.headers['set-cookie']));
    }
    if (res.buf.length > MAX_INLINE) return { error: 'too_big', message: 'Ответ больше 2 МБ' };
    const out = {};
    for (const [k, v] of Object.entries(res.headers)) if (k !== 'set-cookie') out[k] = v;
    return { status: res.status, headers: out, body: res.buf.toString('base64'), url: res.url };
  });

  // ВлодБраузер передаёт свежие cookies и localStorage сайта: они нужны следующим страницам этого билета.
  app.post('/jar', async (req) => {
    const t = getTicket(req.body?.ticket);
    if (!t) throw bad('ticket', 'Билет устарел');
    const jar = cleanJar(req.body);
    t.cookies = jar.cookies;
    t.local = jar.local;
    return { ok: true };
  });

  // Cookies, которые выставил сервер сайта (в том числе HttpOnly), — shim забирает их и отдаёт ВлодБраузеру.
  app.get('/jar/:ticket', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    const t = getTicket(req.params.ticket);
    if (!t) return { error: 'ticket' };
    return { cookies: t.cookies };
  });
}

/** Заголовки из _headers сайта для ответа netRequest (CORS статических сайтов). */
async function siteHeadersFor(res) {
  const site = await siteByTarget(`site:${res.siteId}`);
  if (!site) return {};
  return siteHeaders(site.dir, new URL(res.url).pathname);
}
