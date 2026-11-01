import { buildApp } from './app.js';
import { config } from './config.js';
import { migrate } from './migrate.js';
import { startClock } from './lib/clock.js';
import { pool } from './db.js';

const app = await buildApp();

if (process.env.MIGRATE_ON_START === 'true') await migrate({ log: (m) => app.log.info(m) });
if (config.gameClock) startClock();

await app.listen({ port: config.port, host: config.host });

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, async () => {
    app.log.info(`${sig}: shutting down`);
    await app.close();
    await pool.end();
    process.exit(0);
  });
}
