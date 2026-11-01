process.env.NODE_ENV = 'test';
process.env.DB_NAME = process.env.TEST_DB_NAME || 'bln_test';
process.env.MAIL_TRANSPORT = 'console';
process.env.ADMIN_EMAILS = 'admin@test.bf';
process.env.GAME_CLOCK = 'off';

const { buildApp } = await import('../src/app.js');
const { migrate, dropAll } = await import('../src/migrate.js');
const { pool, q, one } = await import('../src/db.js');
const { clearSystemCache } = await import('../src/lib/ledger.js');
const { resetSettingsCache } = await import('../src/lib/settings.js');
const { sentMail } = await import('../src/lib/mail.js');

export { pool, q, one, sentMail };

export async function setup() {
  await dropAll();
  await migrate({ log: () => {} });
  clearSystemCache();
  resetSettingsCache();
  const app = await buildApp({ logger: false });
  await app.ready();
  return app;
}

/** Клиент с банкой cookie поверх app.inject. */
let clients = 0;
export function client(app) {
  const jar = new Map();
  let n = 0;
  // У каждого клиента свой адрес — ограничение частоты считается по IP, как у живых игроков.
  const ip = `10.0.${Math.floor(++clients / 250)}.${clients % 250}`;
  async function call(method, url, body, headers = {}) {
    const cookie = [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
    const res = await app.inject({ method, url, payload: body, remoteAddress: ip, headers: { ...(cookie ? { cookie } : {}), ...headers } });
    for (const c of res.cookies) {
      if (!c.value || (c.expires && new Date(c.expires) < new Date())) jar.delete(c.name);
      else jar.set(c.name, c.value);
    }
    const data = res.body ? JSON.parse(res.body) : null;
    if (res.statusCode >= 400) {
      const err = new Error(`${method} ${url} → ${res.statusCode} ${data?.error}: ${data?.message}`);
      err.status = res.statusCode;
      err.code = data?.error;
      err.body = data;
      throw err;
    }
    return data;
  }
  return {
    jar,
    get: (u) => call('GET', u),
    post: (u, b = {}, h) => call('POST', u, b, h),
    patch: (u, b = {}) => call('PATCH', u, b),
    idem: (u, b = {}) => call('POST', u, b, { 'idempotency-key': `k${Date.now()}${n++}` }),
  };
}

export async function totalBalance() {
  const r = await one('SELECT COALESCE(SUM(balance),0) AS s FROM accounts');
  return Number(r.s);
}
