import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './migrate.js';
import { startClock } from './lib/clock.js';
import { startCrawler } from './lib/search/crawler.js';
import { startCron } from './lib/vhost/cron.js';
import { startPayWorker } from './lib/pay/core.js';
import { ensureJwtSecret } from './lib/secrets.js';
import { VERSION, watchForNewVersion } from './lib/version.js';
import { patchNetworkInterfaces } from './lib/netinfo.js';
import { pool } from './db.js';

const app = await buildApp();

// Fastify печатает адреса при listen на 0.0.0.0 и для этого читает os.networkInterfaces().
// Там, где хостинг не отдаёт список интерфейсов, вызов падает уже после bind и убивает
// процесс; подмена делает лог адресов необязательным (lib/netinfo.js).
if (!patchNetworkInterfaces((err) => app.log.warn({ err }, 'Сетевые интерфейсы недоступны — адреса в логе не печатаются'))) {
  app.log.warn('Не удалось обезопасить os.networkInterfaces()');
}

// Всё, что раньше делали скрипты на сервере: схема базы и секрет — при запуске.
if (config.migrateOnStart) await migrate({ log: (m) => app.log.info(m) });
await ensureJwtSecret();
if (config.gameClock) { startClock(); startCrawler(); startCron(); startPayWorker(); }

await app.listen({ port: config.port, host: config.host });
app.log.info(`Балесноландия API ${VERSION} на ${config.host}:${config.port}`);

async function shutdown(reason, code = 0) {
  app.log.info(`${reason}: остановка`);
  await app.close();
  await pool.end();
  process.exit(code);
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => shutdown(sig));

if (config.restartOnDeploy && VERSION !== 'dev') {
  // Код 1 — чтобы служба перезапустила процесс и при Restart=on-failure.
  watchForNewVersion((v) => shutdown(`Загружена версия ${v}, перезапуск`, 1));
}
