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

  return app;
}
