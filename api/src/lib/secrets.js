import crypto from 'node:crypto';
import { one, q } from '../db.js';
import { config } from '../config.js';

// MySQL отдаёт JSON-столбец разобранным, MariaDB — то разобранным, то текстом.
function text(v) {
  if (typeof v !== 'string') return v == null ? null : String(v);
  try {
    const p = JSON.parse(v);
    return typeof p === 'string' ? p : v;
  } catch {
    return v;
  }
}

async function stored() {
  const row = await one("SELECT v FROM settings WHERE k = 'jwt_secret'");
  return row ? text(row.v) : null;
}

/** Секрет подписи сессий: из JWT_SECRET, иначе создаётся один раз и хранится в базе. */
export async function ensureJwtSecret() {
  if (config.jwtSecret) return;
  let secret = await stored();
  if (!secret) {
    await q("INSERT IGNORE INTO settings (k, v) VALUES ('jwt_secret', ?)", [JSON.stringify(crypto.randomBytes(32).toString('hex'))]);
    // Если два процесса стартовали одновременно — берём то, что записалось первым.
    secret = await stored();
  }
  config.jwtSecret = secret;
}
