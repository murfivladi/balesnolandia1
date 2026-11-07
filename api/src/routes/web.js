// Шлюз сайтов игроков (этап Н4): /api/net/shim.js, /api/net/web/<билет>/<путь>, /api/net/xfetch, /api/net/jar.
import fs from 'node:fs/promises';
import { bad } from '../lib/errors.js';
import { isPaused } from '../lib/clock.js';
import {
  getTicket, securityHeaders, resolveFile, typeOf, rewriteRootPaths, injectShim, servicePage, siteHeaders, SITE_HEADER_OK, cleanJar,
} from '../lib/gateway.js';
import { siteByTarget } from '../lib/hosting.js';
import { SHIM_JS } from '../lib/balnet-shim.js';
import { clientCtx, openFor } from './net.js';
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
  // Формы со страниц сайтов приходят как обычные формы браузера; тело статическому хостингу не нужно.
  app.addContentTypeParser(['application/x-www-form-urlencoded', 'multipart/form-data'], { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (req, body, done) => done(null, null));

  app.get('/shim.js', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    reply.header('Cache-Control', 'public, max-age=300');
    reply.header('ETag', SHIM_ETAG);
    if (req.headers['if-none-match'] === SHIM_ETAG) return reply.code(304).send();
    return reply.type('text/javascript; charset=utf-8').send(SHIM_JS);
  });

  const serve = async (req, reply) => {
    const ticketId = req.params.ticket;
    const ticket = getTicket(ticketId);
    const site = await siteOf(reply, ticket);
    if (!site) return reply;
    const prefix = `/api/net/web/${ticketId}`;
    const urlPath = `/${req.params['*'] || ''}`;
    const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
    const r = await resolveFile(site.dir, urlPath);
    if (r.status === 301) {
      securityHeaders(reply);
      return reply.code(301).header('Location', `${prefix}${r.location}${query}`).send();
    }
    if (!r.file) return page(reply, r.status, '404 — страница не найдена', `На сайте ${ticket.host} нет страницы ${urlPath}.`);
    securityHeaders(reply);
    for (const [k, v] of Object.entries(await siteHeaders(site.dir, urlPath))) if (SITE_HEADER_OK(k)) reply.header(k, v);
    const type = typeOf(r.file);
    reply.code(r.status).type(type);
    if (req.method === 'HEAD') return reply.send();
    const buf = await fs.readFile(r.file);
    if (type.startsWith('text/html')) {
      const html = rewriteRootPaths(buf.toString('utf8'), prefix, 'html');
      return reply.send(injectShim(html, {
        ticket: ticketId, prefix, origin: ticket.origin, cookies: ticket.cookies, local: ticket.local,
      }));
    }
    if (type.startsWith('text/css')) return reply.send(rewriteRootPaths(buf.toString('utf8'), prefix, 'css'));
    return reply.send(buf);
  };
  app.get('/web/:ticket/*', serve);
  app.get('/web/:ticket', async (req, reply) => reply.redirect(`/api/net/web/${req.params.ticket}/`));
  // Статический хостинг не обрабатывает формы: как настоящий веб-сервер без бэкенда — 405.
  app.post('/web/:ticket/*', async (req, reply) => page(reply, 405, '405 — метод не разрешён', 'Этот сайт размещён на статическом хостинге и не принимает отправку форм. Обработка форм появится вместе с серверным кодом (этап Н7).'));

  // fetch со страницы сайта к другому сайту БалНета. Правила как в браузере: свой origin — можно,
  // чужой — только если сайт разрешил (Access-Control-Allow-Origin в _headers).
  app.post('/xfetch', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    const ticket = getTicket(b?.ticket);
    if (!ticket) return { error: 'ticket', message: 'Страница устарела — обновите её' };
    const method = String(b.method || 'GET').toUpperCase();
    if (method !== 'GET' && method !== 'HEAD') return { error: 'method', message: `Статический сайт не принимает ${method}` };
    if (await isPaused()) return { error: 'maintenance', message: 'БалНет на обслуживании' };
    const target = splitUrl(String(b.url || ''));
    if (!target || (target.scheme !== 'http' && target.scheme !== 'https')) return { error: 'url', message: 'Неверный адрес' };
    let c;
    try { c = await clientCtx({ client_id: ticket.clientId, resolver: ticket.resolver }); } catch { return { error: 'network', message: 'Устройство не подключено к сети' }; }
    const r = await openFor(c, String(b.url));
    if (!r.ok) return { error: 'network', message: r.code };
    const targetOrigin = `${target.scheme}://${target.host}`;
    if (!r.target?.startsWith('site:')) return { error: 'cors', message: `CORS: ${targetOrigin} не разрешает запросы с ${ticket.origin}` };
    const site = await siteByTarget(r.target);
    if (!site || site.account_status !== 'active') return { error: 'network', message: 'Сайт недоступен' };
    const urlPath = target.path.split('#')[0];
    const pathOnly = urlPath.split('?')[0];
    if (targetOrigin !== ticket.origin) {
      const h = await siteHeaders(site.dir, pathOnly);
      const allow = h['access-control-allow-origin'];
      if (allow !== '*' && allow !== ticket.origin) return { error: 'cors', message: `CORS: ${targetOrigin} не разрешает запросы с ${ticket.origin}` };
    }
    const f = await resolveFile(site.dir, urlPath);
    if (!f.file) return { status: f.status === 301 ? 404 : f.status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from('Not Found').toString('base64') };
    const st = await fs.stat(f.file);
    if (st.size > MAX_INLINE) return { error: 'too_big', message: 'Ответ больше 2 МБ' };
    const buf = method === 'HEAD' ? Buffer.alloc(0) : await fs.readFile(f.file);
    return { status: f.status, headers: { 'content-type': typeOf(f.file) }, body: buf.toString('base64') };
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
}
