import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './migrate.js';
import { startClock } from './lib/clock.js';
import { ensureJwtSecret } from './lib/secrets.js';
import { VERSION, watchForNewVersion } from './lib/version.js';
import { pool } from './db.js';

const app = await buildApp();

// Всё, что раньше делали скрипты на сервере: схема базы и секрет — при запуске.
if (config.migrateOnStart) await migrate({ log: (m) => app.log.info(m) });
await ensureJwtSecret();
if (config.gameClock) startClock();

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
