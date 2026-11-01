import { migrate, pool } from '../src/migrate.js';

try {
  await migrate();
  console.log('migrate: ok');
} catch (err) {
  console.error(err);
  process.exitCode = 1;
} finally {
  await pool.end();
}
