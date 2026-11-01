import mysql from 'mysql2/promise';
import { config } from './config.js';

export const pool = mysql.createPool({
  ...config.db,
  connectionLimit: 10,
  charset: 'utf8mb4',
  timezone: 'Z',
  dateStrings: ['DATE'],
  supportBigNumbers: true,
  bigNumberStrings: false,
  decimalNumbers: true,
  multipleStatements: false,
});

/** Выполнить fn(conn) в транзакции. Повторяет при deadlock. */
export async function tx(fn, { retries = 3 } = {}) {
  for (let attempt = 0; ; attempt++) {
    const conn = await pool.getConnection();
    try {
      conn.__after = [];
      await conn.beginTransaction();
      const result = await fn(conn);
      await conn.commit();
      for (const cb of conn.__after) {
        try { await cb(); } catch (e) { console.error('afterCommit', e); }
      }
      return result;
    } catch (err) {
      try { await conn.rollback(); } catch { /* соединение могло умереть */ }
      if ((err.code === 'ER_LOCK_DEADLOCK' || err.code === 'ER_LOCK_WAIT_TIMEOUT') && attempt < retries) continue;
      throw err;
    } finally {
      conn.__after = null;
      conn.release();
    }
  }
}

/** Выполнить после успешного коммита (уведомления, WebSocket). Вне транзакции — сразу. */
export function afterCommit(conn, cb) {
  if (conn && Array.isArray(conn.__after)) conn.__after.push(cb);
  else Promise.resolve().then(cb).catch((e) => console.error('afterCommit', e));
}

export async function q(sql, params = [], conn = pool) {
  const [rows] = await (conn || pool).query(sql, params);
  return rows;
}

export async function one(sql, params = [], conn = pool) {
  const rows = await q(sql, params, conn);
  return rows[0] || null;
}

/** MariaDB отдаёт JSON-столбцы строкой, MySQL — объектом. */
export function json(v, fallback = null) {
  if (v === null || v === undefined) return fallback;
  if (typeof v === 'string') {
    try { return JSON.parse(v); } catch { return fallback; }
  }
  return v;
}
