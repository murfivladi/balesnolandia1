import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import websocket from '@fastify/websocket';
import { config } from './config.js';
import { HttpError } from './lib/errors.js';
import { allowedOrigins } from './lib/settings.js';
import { VERSION } from './lib/version.js';
import { wsRoutes } from './routes/ws.js';
import { authRoutes } from './routes/auth.js';
import { commonRoutes } from './routes/common.js';
import { govRoutes } from './routes/gov.js';
import { bankRoutes } from './routes/bank.js';
import { financeRoutes } from './routes/finance.js';
import { adminFinanceRoutes } from './routes/admin-finance.js';
import { posRoutes } from './routes/pos.js';
import { adminRoutes } from './routes/admin.js';
import { posExtRoutes, bankDebtRoutes } from './routes/pos-ext.js';
import { adminPosRoutes } from './routes/admin-pos.js';
import { govExtRoutes } from './routes/gov-ext.js';
import { adminGovRoutes } from './routes/admin-gov.js';
import { bankGovRoutes } from './routes/bank-gov.js';
import { netRoutes } from './routes/net.js';
import { adminNetRoutes } from './routes/admin-net.js';
import { domainRoutes } from './routes/domains.js';
import { adminDomainRoutes } from './routes/admin-domains.js';
import { webRoutes } from './routes/web.js';
import { hostingRoutes, adminHostingRoutes } from './routes/hosting.js';
import { certRoutes, adminPkiRoutes } from './routes/certs.js';
import { searchRoutes, adminSearchRoutes } from './routes/search.js';
import { hubRoutes } from './routes/hub.js';
import { mailRoutes, adminMailRoutes } from './routes/mail.js';
import { payRoutes, posOnlineRoutes, oauthRoutes, adminPayRoutes } from './routes/pay.js';
import { pushRoutes, netPushRoutes } from './routes/push.js';
import { newsRoutes, adminNewsRoutes } from './routes/news.js';

export async function buildApp({ logger = config.env !== 'test' } = {}) {
  const app = Fastify({
    logger: logger ? { level: config.env === 'production' ? 'info' : 'debug' } : false,
    bodyLimit: 6 * 1024 * 1024, // фото товаров и паспортов приходят data URL
    trustProxy: true,
  });

  await app.register(cookie);
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin || config.env !== 'production') return cb(null, true);
      allowedOrigins().then((set) => cb(null, set.has(origin)), () => cb(null, false));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'],
    allowedHeaders: ['Content-Type', 'Idempotency-Key'],
  });
  await app.register(rateLimit, { global: false });
  await app.register(websocket);

  app.setErrorHandler((err, req, reply) => {
    if (err instanceof HttpError) {
      return reply.status(err.statusCode).send({ error: err.code, message: err.message, data: err.data });
    }
    if (err.statusCode === 429) {
      return reply.status(429).send({ error: 'rate_limited', message: 'Слишком много попыток — подождите немного' });
    }
    if (err.validation) {
      return reply.status(400).send({ error: 'invalid', message: err.message });
    }
    if (err.statusCode && err.statusCode < 500) {
      return reply.status(err.statusCode).send({ error: err.code || 'error', message: err.message });
    }
    req.log.error(err);
    if (config.env === 'test') console.error(err);
    return reply.status(500).send({ error: 'server_error', message: 'Ошибка сервера' });
  });

  // Сайты игроков работают в песочнице (Origin: null). Им открыт только шлюз БалНета —
  // остальной API (банк, услуги, касса) на такие запросы не отвечает.
  const SANDBOX_OK = ['/api/net/web/', '/api/net/xfetch', '/api/net/shim.js', '/api/net/sock/', '/api/net/jar/', '/api/search/adnet/'];
  app.addHook('onRequest', async (req, reply) => {
    if (req.headers.origin === 'null' && !SANDBOX_OK.some((p) => req.url.startsWith(p))) {
      return reply.code(403).send({ error: 'sandbox_origin', message: 'Запросы со страниц сайтов БалНета к этому API запрещены' });
    }
    return undefined;
  });

  app.get('/api/health', async () => ({ ok: true, version: VERSION, time: new Date().toISOString() }));

  await app.register(wsRoutes);
  await app.register(authRoutes, { prefix: '/api' });
  await app.register(commonRoutes, { prefix: '/api' });
  await app.register(govRoutes, { prefix: '/api/gov' });
  await app.register(govExtRoutes, { prefix: '/api/gov' });
  await app.register(bankRoutes, { prefix: '/api/bank' });
  await app.register(financeRoutes, { prefix: '/api/bank' });
  await app.register(posRoutes, { prefix: '/api/pos' });
  await app.register(posExtRoutes, { prefix: '/api/pos' });
  await app.register(bankDebtRoutes, { prefix: '/api/bank' });
  await app.register(bankGovRoutes, { prefix: '/api/bank' });
  await app.register(adminRoutes, { prefix: '/api/admin' });
  await app.register(adminFinanceRoutes, { prefix: '/api/admin' });
  await app.register(adminPosRoutes, { prefix: '/api/admin' });
  await app.register(adminGovRoutes, { prefix: '/api/admin' });
  await app.register(netRoutes, { prefix: '/api/net' });
  await app.register(adminNetRoutes, { prefix: '/api/admin/net' });
  await app.register(domainRoutes, { prefix: '/api/gov' });
  await app.register(adminDomainRoutes, { prefix: '/api/admin/net' });
  await app.register(webRoutes, { prefix: '/api/net' });
  await app.register(hostingRoutes, { prefix: '/api/gov' });
  await app.register(adminHostingRoutes, { prefix: '/api/admin/net' });
  await app.register(certRoutes, { prefix: '/api/gov' });
  await app.register(adminPkiRoutes, { prefix: '/api/admin/pki' });
  await app.register(searchRoutes, { prefix: '/api/search' });
  await app.register(hubRoutes, { prefix: '/api/hub' });
  await app.register(mailRoutes, { prefix: '/api/mail' });
  await app.register(adminMailRoutes, { prefix: '/api/admin/mail' });
  await app.register(pushRoutes, { prefix: '/api/push' });
  await app.register(netPushRoutes, { prefix: '/api/net/push' });
  await app.register(newsRoutes, { prefix: '/api/news' });
  await app.register(adminNewsRoutes, { prefix: '/api/admin/news' });
  await app.register(adminSearchRoutes, { prefix: '/api/admin/search' });
  await app.register(payRoutes, { prefix: '/api/pay' });
  await app.register(posOnlineRoutes, { prefix: '/api/pos' });
  await app.register(oauthRoutes, { prefix: '/api/oauth' });
  await app.register(adminPayRoutes, { prefix: '/api/admin/pay' });

  (await import('./lib/pay/api.js')).setGovInjector((opts) => app.inject(opts));

  return app;
}
