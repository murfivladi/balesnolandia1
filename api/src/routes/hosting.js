// ВлодУслуги → Хостинг (этап Н4): тарифы, аккаунты, сайты, файловый менеджер, ZIP. Кабинет хостера. Админка.
import { tx, q, one } from '../db.js';
import { bad, notFound, need, int, str, amount as amountArg } from '../lib/errors.js';
import { needGov, needAdmin, actorOf } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { citizenOf, activePassport } from '../lib/gov.js';
import { currentMonth } from '../lib/clock.js';
import { getSettings } from '../lib/settings.js';
import { memberOrg, hasLicense } from '../lib/orgs.js';
import {
  offers, buyHosting, ownAccount, renewHosting, addSite, removeSite, accountView, refreshUsage, rentServer, hostingMonth, deleteAccount, hosterName,
} from '../lib/hosting.js';
import { accountDir, siteDir, listDir, readFile, writeFile, makeDir, removePath, renamePath, extractZip } from '../lib/sitefs.js';

async function limits(a) {
  const s = await getSettings();
  const plan = await one('SELECT disk_mb FROM hosting_plans WHERE id = ?', [a.plan_id]);
  return { quotaBytes: plan.disk_mb * 1048576, maxFileBytes: Number(s.hosting_max_file_kb || 5120) * 1024 };
}

export async function hostingRoutes(app) {
  const auth = { preHandler: needGov() };
  const actor = (req) => actorOf(req.gov);

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
    const { a, dir } = await siteCtx(req);
    const r = await removePath(dir, req.query.path);
    await refreshUsage(a.id);
    return r;
  });

  app.post('/hosting/:id/sites/:sid/zip', auth, async (req) => {
    const { a, dir, base } = await siteCtx(req, { write: true });
    const data = String(req.body?.data || '');
    need(data.length > 0, 'Пустой архив');
    const files = await extractZip(dir, base, Buffer.from(data, 'base64'), { ...(await limits(a)), into: req.body?.path || '' });
    await refreshUsage(a.id);
    await audit(null, actor(req), 'hosting.zip', 'hosting_account', a.id, { files: files.length });
    return { files };
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
      const r = await q('INSERT INTO hosting_plans (org_id, server_id, name, disk_mb, max_sites, price_month) VALUES (?, ?, ?, ?, ?, ?)', [
        org.id, server.id, str(b.name, 'название', { max: 80 }), disk, int(b.max_sites ?? 5, 'сайтов', { min: 1, max: 100 }), amountArg(b.price_month, 'цена'),
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
    const r = await q('INSERT INTO hosting_plans (org_id, server_id, name, disk_mb, max_sites, price_month) VALUES (NULL, ?, ?, ?, ?, ?)', [
      server.id, str(b.name, 'название', { max: 80 }), int(b.disk_mb, 'место', { min: 1, max: server.disk_mb }), int(b.max_sites ?? 5, 'сайтов', { min: 1, max: 100 }), int(b.price_month, 'цена', { min: 0, max: 1e12 }),
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
