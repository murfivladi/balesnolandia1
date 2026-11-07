// ВлодУслуги → Хостинг (этап Н4): тарифы, аккаунты, сайты, файловый менеджер, ZIP. Кабинет хостера. Админка.
import { tx, q, one } from '../db.js';
import { bad, notFound, need, int, str, amount as amountArg } from '../lib/errors.js';
import { needGov, needAdmin, actorOf, hash } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { citizenOf, activePassport } from '../lib/gov.js';
import { currentMonth, gameSeconds } from '../lib/clock.js';
import { getSettings } from '../lib/settings.js';
import { memberOrg, hasLicense } from '../lib/orgs.js';
import {
  offers, buyHosting, ownAccount, renewHosting, addSite, removeSite, accountView, refreshUsage, rentServer, hostingMonth, deleteAccount, hosterName, siteByTarget,
} from '../lib/hosting.js';
import { accountDir, siteDir, listDir, readFile, writeFile, makeDir, removePath, renamePath, extractZip } from '../lib/sitefs.js';
import fs from 'node:fs/promises';
import { withSite, siteDb, flush, sqlExec, sqlQuery, closeDb } from '../lib/vhost/store.js';
import { getLogs, clearLogs } from '../lib/vhost/logs.js';
import { parseCrontab } from '../lib/vhost/cron.js';
import { EXAMPLE } from '../lib/vhost/example.js';
import { siteAnalytics } from '../lib/vhost/analytics.js';

/** Вид тарифа и лимиты из формы хостера или админа. */
function planKind(b) {
  const kind = b.kind === 'virtual' ? 'virtual' : 'static';
  const virt = kind === 'virtual';
  return [
    kind,
    int(b.rpm ?? (virt ? 300 : 600), 'запросов в минуту', { min: 10, max: 100000 }),
    virt ? int(b.cpu_ms ?? 100, 'CPU-мс на запрос', { min: 10, max: 2000 }) : 0,
    virt ? int(b.ws_limit ?? 20, 'соединений WebSocket', { min: 0, max: 1000 }) : 0,
    virt ? int(b.cron_min ?? 60, 'шаг cron, игр. мин', { min: 1, max: 43200 }) : 0,
  ];
}

async function limits(a) {
  const s = await getSettings();
  const plan = await one('SELECT disk_mb FROM hosting_plans WHERE id = ?', [a.plan_id]);
  return { quotaBytes: plan.disk_mb * 1048576, maxFileBytes: Number(s.hosting_max_file_kb || 5120) * 1024 };
}

export async function hostingRoutes(app) {
  const auth = { preHandler: needGov() };
  const actor = (req) => actorOf(req.gov);

  // Публично: тарифы всех хостеров (витрина сайта БалХоста).
  app.get('/hosting/plans', async () => ({ offers: await offers(null, await currentMonth()) }));

  app.get('/hosting', auth, async (req) => {
    const month = await currentMonth();
    const rows = await q(
      `SELECT a.* FROM hosting_accounts a LEFT JOIN org_members m ON m.org_id = a.owner_org_id AND m.gov_user_id = ?
       WHERE a.status <> 'deleted' AND (a.owner_gov_user_id = ? OR m.gov_user_id IS NOT NULL) ORDER BY a.id DESC`, [req.gov.id, req.gov.id],
    );
    const s = await getSettings();
    return { accounts: await Promise.all(rows.map((a) => accountView(null, a))), offers: await offers(null, month), month, max_months: Number(s.hosting_max_months || 12) };
  });

  app.post('/hosting', auth, async (req) => {
    const b = req.body || {};
    return tx(async (conn) => {
      const citizen = await citizenOf(req.gov.id, conn);
      if (!citizen || !(await activePassport(citizen.id, conn))) throw bad('no_passport', 'Хостинг покупают граждане с паспортом БФ');
      const r = await buyHosting(conn, { govUserId: req.gov.id, planId: int(b.plan_id, 'тариф'), months: b.months, ownerOrgId: b.owner_org_id ? int(b.owner_org_id, 'организация') : null });
      await audit(conn, actor(req), 'hosting.buy', 'hosting_account', r.account_id);
      return r;
    });
  });

  app.get('/hosting/:id', auth, async (req) => {
    const a = await ownAccount(null, int(req.params.id, 'id'), req.gov.id);
    await refreshUsage(a.id);
    return { account: await accountView(null, { ...a, used_bytes: (await one('SELECT used_bytes FROM hosting_accounts WHERE id = ?', [a.id])).used_bytes }) };
  });

  app.post('/hosting/:id/renew', auth, async (req) => tx(async (conn) => renewHosting(conn, { govUserId: req.gov.id, id: int(req.params.id, 'id'), months: req.body?.months })));

  app.post('/hosting/:id/sites', auth, async (req) => tx(async (conn) => {
    const a = await ownAccount(conn, int(req.params.id, 'id'), req.gov.id);
    const r = await addSite(conn, { account: a, host: req.body?.host });
    await audit(conn, actor(req), 'hosting.site_add', 'hosting_account', a.id, { host: r.host });
    return r;
  }));

  app.delete('/hosting/:id/sites/:sid', auth, async (req) => {
    await tx(async (conn) => {
      const a = await ownAccount(conn, int(req.params.id, 'id'), req.gov.id);
      await removeSite(conn, { account: a, siteId: int(req.params.sid, 'сайт') });
    });
    return { ok: true };
  });

  // ——— Файловый менеджер ———
  async function siteCtx(req, { write = false } = {}) {
    const a = await ownAccount(null, int(req.params.id, 'id'), req.gov.id);
    const s = await one('SELECT * FROM hosting_sites WHERE id = ? AND account_id = ?', [int(req.params.sid, 'сайт'), a.id]);
    if (!s) throw notFound('Сайт не найден');
    if (write) need(a.status === 'active', 'Хостинг приостановлен — файлы можно только смотреть и удалять');
    return { a, s, dir: siteDir(a.id, s.host), base: accountDir(a.id) };
  }

  app.get('/hosting/:id/sites/:sid/files', auth, async (req) => {
    const { dir } = await siteCtx(req);
    return listDir(dir, req.query.path || '');
  });

  app.get('/hosting/:id/sites/:sid/file', auth, async (req) => {
    const { dir } = await siteCtx(req);
    return readFile(dir, req.query.path || '');
  });

  app.put('/hosting/:id/sites/:sid/file', auth, async (req) => {
    const { a, dir, base } = await siteCtx(req, { write: true });
    const b = req.body || {};
    const r = await writeFile(dir, base, b.path, b.content, { binary: !!b.binary, ...(await limits(a)) });
    await refreshUsage(a.id);
    return r;
  });

  app.post('/hosting/:id/sites/:sid/mkdir', auth, async (req) => {
    const { dir } = await siteCtx(req, { write: true });
    return makeDir(dir, req.body?.path);
  });

  app.post('/hosting/:id/sites/:sid/rename', auth, async (req) => {
    const { dir } = await siteCtx(req, { write: true });
    return renamePath(dir, req.body?.from, req.body?.to);
  });

  app.delete('/hosting/:id/sites/:sid/file', auth, async (req) => {
    const { a, s: site, dir } = await siteCtx(req);
    const r = await removePath(dir, req.query.path);
    closeDb(site.id);
    await refreshUsage(a.id);
    return r;
  });

  app.post('/hosting/:id/sites/:sid/zip', auth, async (req) => {
    const { a, s: site, dir, base } = await siteCtx(req, { write: true });
    const data = String(req.body?.data || '');
    need(data.length > 0, 'Пустой архив');
    const files = await extractZip(dir, base, Buffer.from(data, 'base64'), { ...(await limits(a)), into: req.body?.path || '' });
    closeDb(site.id);
    await refreshUsage(a.id);
    await audit(null, actor(req), 'hosting.zip', 'hosting_account', a.id, { files: files.length });
    return { files };
  });

  /** Аналитика сайта: посещения, посетители, страницы, источники, запросы из ВлодПоиска. */
  app.get('/hosting/:id/sites/:sid/analytics', auth, async (req) => {
    const { s } = await siteCtx(req);
    return siteAnalytics(s, Math.min(60, Math.max(7, Number(req.query.days) || 14)));
  });

  /** Пароль SSH для аккаунта: вход ssh u<номер>@<адрес сервера> из терминала ВлодБраузера. */
  app.post('/hosting/:id/ssh', auth, async (req) => {
    const a = await ownAccount(null, int(req.params.id, 'id'), req.gov.id);
    const pw = String(req.body?.password || '');
    if (!pw) { await q('UPDATE hosting_accounts SET ssh_hash = NULL WHERE id = ?', [a.id]); return { enabled: false }; }
    need(pw.length >= 8, 'Пароль SSH — не короче 8 символов');
    await q('UPDATE hosting_accounts SET ssh_hash = ? WHERE id = ?', [await hash(pw), a.id]);
    await audit(null, actor(req), 'hosting.ssh_password', 'hosting_account', a.id);
    return { enabled: true };
  });

  // ——— Серверный код (виртуальный тариф): журнал, SQL-консоль, key-value, примеры ———
  async function vsite(req) {
    const c = await siteCtx(req);
    const site = await siteByTarget(`site:${c.s.id}`);
    need(site.kind === 'virtual', 'Серверный код работает на виртуальном тарифе');
    return { ...c, site };
  }

  app.get('/hosting/:id/sites/:sid/logs', auth, async (req) => {
    const { s } = await siteCtx(req);
    return { logs: getLogs(s.id) };
  });
  app.delete('/hosting/:id/sites/:sid/logs', auth, async (req) => {
    const { s } = await siteCtx(req);
    clearLogs(s.id);
    return { ok: true };
  });

  /** SQL-консоль базы сайта (как phpMyAdmin у хостера). */
  app.post('/hosting/:id/sites/:sid/sql', auth, async (req) => {
    const { a, site } = await vsite(req);
    const sql = str(req.body?.sql, 'SQL', { max: 20000 });
    return withSite(site.id, async () => {
      const e = await siteDb(site);
      let result;
      try { result = sqlExec(e, sql); } catch (err) { throw bad('sql', `SQLite: ${err.message}`); }
      const quota = (await limits(a)).quotaBytes - (await refreshUsage(a.id));
      await flush(site.id, { quotaLeft: quota });
      const tables = sqlQuery(e, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
      return { result: result.map((r) => ({ ...r, rows: r.rows.slice(0, 500) })), tables };
    });
  });

  app.get('/hosting/:id/sites/:sid/kv', auth, async (req) => {
    const { site } = await vsite(req);
    return withSite(site.id, async () => {
      const e = await siteDb(site);
      const now = await gameSeconds();
      const rows = sqlQuery(e, 'SELECT k, v, exp FROM _kv WHERE exp IS NULL OR exp > ? ORDER BY k LIMIT 500', [now]);
      const tables = sqlQuery(e, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
      return { now, keys: rows.map((r) => ({ key: r.k, value: r.v.slice(0, 500), exp: r.exp })), tables, crontab: await fs.readFile(`${site.dir}/crontab`, 'utf8').then((t) => parseCrontab(t), () => null) };
    });
  });

  // ——— Почта сайта: ключ DKIM для mail.send({ dkim: селектор }) и запись для DNS ———
  app.get('/hosting/:id/sites/:sid/dkim', auth, async (req) => {
    const { site } = await vsite(req);
    const { publicFromPrivate, dkimRecord } = await import('../lib/mailnet/dkim.js');
    const keys = [];
    for (const f of await fs.readdir(`${site.dir}/.dkim`).catch(() => [])) {
      if (!f.endsWith('.key')) continue;
      const sel = f.slice(0, -4);
      try {
        const pub = publicFromPrivate((await fs.readFile(`${site.dir}/.dkim/${f}`, 'utf8')).trim());
        keys.push({ selector: sel, record: { name: `${sel}._domainkey`, type: 'TXT', data: dkimRecord(pub) } });
      } catch { keys.push({ selector: sel, error: 'Ключ повреждён' }); }
    }
    return { keys, ip: site.server_ip, spf: `v=spf1 ip4:${site.server_ip} -all`, mx: `10 ${site.host}.` };
  });
  app.post('/hosting/:id/sites/:sid/dkim', auth, async (req) => {
    const { a, dir, base, site } = await vsite(req);
    const sel = String(req.body?.selector || 'mail').trim().toLowerCase();
    need(/^[a-z0-9-]{1,63}$/.test(sel), 'Селектор: латиница, цифры и дефис');
    const { generateDkimKey, dkimRecord } = await import('../lib/mailnet/dkim.js');
    const k = generateDkimKey();
    await fs.mkdir(`${dir}/.dkim`, { recursive: true });
    await writeFile(dir, base, `.dkim/${sel}.key`, `${k.privateKey}\n`, await limits(a));
    await refreshUsage(a.id);
    await audit(null, actor(req), 'hosting.dkim', 'hosting_site', site.id, { selector: sel });
    return { selector: sel, record: { name: `${sel}._domainkey`, type: 'TXT', data: dkimRecord(k.publicKey) } };
  });

  /** Готовый пример: гостевая книга на SQLite с cron. */
  app.post('/hosting/:id/sites/:sid/example', auth, async (req) => {
    const { a, dir, base } = await vsite(req);
    const lim = await limits(a);
    for (const [path, content] of Object.entries(EXAMPLE)) {
      const exists = await fs.stat(`${dir}/${path}`).then(() => true, () => false);
      if (!exists || req.body?.overwrite) await writeFile(dir, base, path, content, lim);
    }
    await refreshUsage(a.id);
    return { files: Object.keys(EXAMPLE) };
  });

  // ——— Кабинет хостера ———
  app.get('/orgs/:id/hosting', auth, async (req) => {
    const org = await memberOrg(null, int(req.params.id, 'id'), req.gov.id);
    const month = await currentMonth();
    const servers = await q("SELECT s.*, (SELECT COUNT(*) FROM hosting_accounts a WHERE a.server_id = s.id AND a.status IN ('active','suspended')) AS accounts, (SELECT COALESCE(SUM(p.disk_mb),0) FROM hosting_accounts a JOIN hosting_plans p ON p.id = a.plan_id WHERE a.server_id = s.id AND a.status IN ('reserved','active','suspended')) AS sold_mb FROM hosting_servers s WHERE s.org_id = ? AND s.status <> 'closed' ORDER BY s.id", [org.id]);
    const plans = await q('SELECT * FROM hosting_plans WHERE org_id = ? ORDER BY id', [org.id]);
    const s = await getSettings();
    return {
      licensed: await hasLicense(null, org.id, 'hosting', month),
      rent: Number(s.hosting_server_rent || 0),
      disk_mb: Number(s.hosting_server_disk_mb || 500),
      servers: servers.map((x) => ({ ...x, rent_price: Number(x.rent_price), accounts: Number(x.accounts), sold_mb: Number(x.sold_mb), name: x.name.replace(/\.$/, '') })),
      plans: plans.map((p) => ({ ...p, price_month: Number(p.price_month), active: !!p.active })),
    };
  });

  app.post('/orgs/:id/servers', auth, async (req) => tx(async (conn) => {
    const org = await memberOrg(conn, int(req.params.id, 'id'), req.gov.id, { directorOnly: true });
    const r = await rentServer(conn, { orgId: org.id });
    await audit(conn, actor(req), 'hosting.server_rent', 'organization', org.id, r);
    return r;
  }));

  app.post('/orgs/:id/plans', auth, async (req) => {
    const b = req.body || {};
    return tx(async (conn) => {
      const org = await memberOrg(conn, int(req.params.id, 'id'), req.gov.id, { directorOnly: true });
      need(await hasLicense(conn, org.id, 'hosting', await currentMonth(conn)), 'Нужна лицензия хостинг-провайдера');
      const server = await one("SELECT * FROM hosting_servers WHERE id = ? AND org_id = ? AND status <> 'closed'", [int(b.server_id, 'сервер'), org.id], conn);
      if (!server) throw notFound('Сервер не найден');
      const disk = int(b.disk_mb, 'место, МБ', { min: 1, max: server.disk_mb });
      const r = await q('INSERT INTO hosting_plans (org_id, server_id, name, disk_mb, max_sites, price_month, kind, rpm, cpu_ms, ws_limit, cron_min) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        org.id, server.id, str(b.name, 'название', { max: 80 }), disk, int(b.max_sites ?? 5, 'сайтов', { min: 1, max: 100 }), amountArg(b.price_month, 'цена'), ...planKind(b),
      ], conn);
      await audit(conn, actor(req), 'hosting.plan_create', 'organization', org.id, { plan: r.insertId });
      return { id: r.insertId };
    });
  });

  app.patch('/orgs/:id/plans/:pid', auth, async (req) => {
    const b = req.body || {};
    await tx(async (conn) => {
      const org = await memberOrg(conn, int(req.params.id, 'id'), req.gov.id, { directorOnly: true });
      const p = await one('SELECT * FROM hosting_plans WHERE id = ? AND org_id = ?', [int(req.params.pid, 'тариф'), org.id], conn);
      if (!p) throw notFound('Тариф не найден');
      await q('UPDATE hosting_plans SET active = ?, price_month = ? WHERE id = ?', [b.active !== undefined ? (b.active ? 1 : 0) : p.active, b.price_month !== undefined ? amountArg(b.price_month, 'цена') : p.price_month, p.id], conn);
    });
    return { ok: true };
  });
}

export async function adminHostingRoutes(app) {
  app.addHook('preHandler', needAdmin());
  const actor = (req) => actorOf(req.actor);

  app.get('/hosting', async () => {
    const servers = await q("SELECT s.*, (SELECT COUNT(*) FROM hosting_accounts a WHERE a.server_id = s.id AND a.status IN ('active','suspended')) AS accounts FROM hosting_servers s WHERE s.status <> 'closed' ORDER BY s.org_id IS NOT NULL, s.id");
    const plans = await q('SELECT * FROM hosting_plans ORDER BY org_id IS NOT NULL, id');
    const accounts = await q("SELECT a.*, p.name AS plan, c.full_name, o.name AS org FROM hosting_accounts a JOIN hosting_plans p ON p.id = a.plan_id LEFT JOIN citizens c ON c.gov_user_id = a.owner_gov_user_id LEFT JOIN organizations o ON o.id = a.owner_org_id WHERE a.status IN ('active','suspended','reserved') ORDER BY a.id DESC LIMIT 300");
    const sites = await q('SELECT account_id, host FROM hosting_sites');
    return {
      servers: await Promise.all(servers.map(async (s) => ({ ...s, name: s.name.replace(/\.$/, ''), hoster: await hosterName(null, s.org_id), rent_price: Number(s.rent_price), accounts: Number(s.accounts) }))),
      plans: await Promise.all(plans.map(async (p) => ({ ...p, hoster: await hosterName(null, p.org_id), price_month: Number(p.price_month), active: !!p.active }))),
      accounts: accounts.map((a) => ({ id: a.id, status: a.status, plan: a.plan, owner: a.org || a.full_name, paid_until_month: a.paid_until_month, used_bytes: Number(a.used_bytes), sites: sites.filter((s) => s.account_id === a.id).map((s) => s.host) })),
    };
  });

  // Тарифы Госхостинга.
  app.post('/hosting/plans', async (req) => {
    const b = req.body || {};
    const server = await one('SELECT * FROM hosting_servers WHERE id = ? AND org_id IS NULL', [int(b.server_id, 'сервер')]);
    if (!server) throw notFound('Сервер Госхостинга не найден');
    const r = await q('INSERT INTO hosting_plans (org_id, server_id, name, disk_mb, max_sites, price_month, kind, rpm, cpu_ms, ws_limit, cron_min) VALUES (NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
      server.id, str(b.name, 'название', { max: 80 }), int(b.disk_mb, 'место', { min: 1, max: server.disk_mb }), int(b.max_sites ?? 5, 'сайтов', { min: 1, max: 100 }), int(b.price_month, 'цена', { min: 0, max: 1e12 }), ...planKind(b),
    ]);
    await audit(null, actor(req), 'hosting.gov_plan', 'hosting_plan', r.insertId);
    return { id: r.insertId };
  });

  app.patch('/hosting/plans/:id', async (req) => {
    const b = req.body || {};
    const p = await one('SELECT * FROM hosting_plans WHERE id = ?', [int(req.params.id, 'id')]);
    if (!p) throw notFound();
    await q('UPDATE hosting_plans SET active = ?, price_month = ? WHERE id = ?', [b.active !== undefined ? (b.active ? 1 : 0) : p.active, b.price_month !== undefined ? int(b.price_month, 'цена', { min: 0, max: 1e12 }) : p.price_month, p.id]);
    await audit(null, actor(req), 'hosting.plan_update', 'hosting_plan', p.id, b);
    return { ok: true };
  });

  app.delete('/hosting/accounts/:id', async (req) => {
    const a = await one("SELECT * FROM hosting_accounts WHERE id = ? AND status <> 'deleted'", [int(req.params.id, 'id')]);
    if (!a) throw notFound();
    await deleteAccount(a);
    await audit(null, actor(req), 'hosting.account_delete', 'hosting_account', a.id, { reason: req.body?.reason || null });
    return { ok: true };
  });

  app.post('/hosting/tick', async () => {
    await hostingMonth(await currentMonth());
    return { ok: true };
  });
}
