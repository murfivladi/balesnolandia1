// Статический хостинг БалНета: серверы (Госхостинг и арендованные хостерами), тарифы, аккаунты игроков, сайты.
// Деньги: аккаунт оплачивается квитанцией вперёд на N игровых месяцев; хостеру — цена минус НДС.
// Хостер платит дата-центру аренду сервера каждый игровой месяц со счёта организации.
import fs from 'node:fs/promises';
import { q, one, tx } from '../db.js';
import { bad, notFound, forbidden, need, conflict } from './errors.js';
import { getSettings } from './settings.js';
import { currentMonth, onMonth } from './clock.js';
import { createInvoice, onInvoicePaid } from './gov.js';
import { notify } from './notify.js';
import { post, sys } from './ledger.js';
import { orgRole, hasLicense } from './orgs.js';
import { invalidateNet } from './net.js';
import { setPtr } from './zones.js';
import { accountDir, siteDir, dirSize } from './sitefs.js';
import { closeDb } from './vhost/store.js';
import { fqdn } from '@bln/shared/balnet-dns.js';
import { nthIp } from '@bln/shared/balnet-ip.js';
import { vatIncluded, formatMoney } from '@bln/shared/money.js';

export const ACCOUNT_STATUS = { reserved: 'ждёт оплаты', active: 'работает', suspended: 'приостановлен за неуплату', deleted: 'удалён' };
const RENT_CIDR = '50.2.0.0/16';
const LINK = '#/hosting';
const disp = (n) => String(n).replace(/\.$/, '');

async function orgAccount(conn, orgId) {
  if (!orgId) return null;
  return (await one('SELECT account_id FROM organizations WHERE id = ?', [orgId], conn))?.account_id || null;
}

export async function hosterName(conn, orgId) {
  if (!orgId) return 'Госхостинг БалНета';
  return (await one('SELECT name FROM organizations WHERE id = ?', [orgId], conn))?.name || '—';
}

/** Тарифы на продажу: Госхостинг + хостеры с действующей лицензией и работающим сервером. */
export async function offers(conn, month) {
  const rows = await q("SELECT p.*, s.status AS server_status, s.name AS server_name, s.ip FROM hosting_plans p JOIN hosting_servers s ON s.id = p.server_id WHERE p.active = 1 AND s.status = 'active' ORDER BY p.org_id IS NOT NULL, p.price_month", [], conn);
  const out = [];
  for (const p of rows) {
    if (p.org_id && !(await hasLicense(conn, p.org_id, 'hosting', month))) continue;
    out.push({ id: p.id, org_id: p.org_id, hoster: await hosterName(conn, p.org_id), name: p.name, kind: p.kind, disk_mb: p.disk_mb, max_sites: p.max_sites, price_month: Number(p.price_month), rpm: p.rpm, cpu_ms: p.cpu_ms, ws_limit: p.ws_limit, cron_min: p.cron_min, server: disp(p.server_name), ip: p.ip });
  }
  return out;
}

/** Место на сервере уже обещано активным аккаунтам — не продаём больше, чем есть. */
async function freeDiskMb(conn, serverId) {
  const s = await one('SELECT disk_mb FROM hosting_servers WHERE id = ?', [serverId], conn);
  const used = await one("SELECT COALESCE(SUM(p.disk_mb), 0) AS mb FROM hosting_accounts a JOIN hosting_plans p ON p.id = a.plan_id WHERE a.server_id = ? AND a.status IN ('reserved','active','suspended')", [serverId], conn);
  return Number(s.disk_mb) - Number(used.mb);
}

async function splitsFor(conn, orgId, total) {
  if (!orgId) return null;
  const s = await getSettings();
  const vat = vatIncluded(total, Number(s.vat_bp || 0));
  return [{ account: await orgAccount(conn, orgId), amount: total - vat }, { account: null, amount: vat }];
}

async function checkMonths(m) {
  const s = await getSettings();
  const n = Number(m ?? 1);
  need(Number.isInteger(n) && n >= 1 && n <= Number(s.hosting_max_months || 12), `Срок: от 1 до ${s.hosting_max_months || 12} игровых месяцев`);
  return n;
}

async function createOrder(conn, { account, govUserId, months, amount }) {
  const month = await currentMonth(conn);
  const o = await q('INSERT INTO hosting_orders (account_id, gov_user_id, months, amount, created_month) VALUES (?, ?, ?, ?, ?)', [account.id, govUserId, months, amount, month], conn);
  if (amount <= 0) {
    await q("UPDATE hosting_orders SET status = 'paid' WHERE id = ?", [o.insertId], conn);
    await applyOrder(conn, o.insertId);
    return { id: o.insertId, invoice: null, amount };
  }
  const plan = await one('SELECT name FROM hosting_plans WHERE id = ?', [account.plan_id], conn);
  const citizen = await one('SELECT id FROM citizens WHERE gov_user_id = ?', [govUserId], conn);
  const inv = await createInvoice(conn, {
    citizenId: citizen?.id || null, govUserId, kind: 'other', purpose: `Хостинг «${plan.name}» (${await hosterName(conn, account.org_id)}), ${months} игр. мес.`,
    amount, ref: { type: 'hosting_order', id: o.insertId }, splits: await splitsFor(conn, account.org_id, amount),
  });
  await q('UPDATE hosting_orders SET invoice_id = ? WHERE id = ?', [inv.id, o.insertId], conn);
  await notify(conn, 'gov', govUserId, { title: `Оплатите хостинг: ${formatMoney(amount)}`, body: `Квитанция ${inv.number}`, link: '#/invoices' });
  return { id: o.insertId, invoice: inv.number, amount };
}

async function applyOrder(conn, orderId) {
  const o = await one('SELECT * FROM hosting_orders WHERE id = ? FOR UPDATE', [orderId], conn);
  const a = await one('SELECT * FROM hosting_accounts WHERE id = ? FOR UPDATE', [o.account_id], conn);
  if (!a || a.status === 'deleted') return;
  const month = await currentMonth(conn);
  const base = a.status === 'reserved' ? month : Math.max(a.paid_until_month, month);
  await q("UPDATE hosting_accounts SET status = 'active', paid_until_month = ? WHERE id = ?", [base + o.months, a.id], conn);
  await fs.mkdir(accountDir(a.id), { recursive: true });
  invalidateNet();
  await notify(conn, 'gov', o.gov_user_id, { title: 'Хостинг оплачен', body: `Работает до ${base + o.months}-го игрового месяца`, link: `${LINK}/${a.id}` });
}

onInvoicePaid('hosting_order', async (conn, inv) => {
  await q("UPDATE hosting_orders SET status = 'paid' WHERE id = ?", [inv.ref_id], conn);
  await applyOrder(conn, inv.ref_id);
});

export async function buyHosting(conn, { govUserId, planId, months, ownerOrgId = null }) {
  const month = await currentMonth(conn);
  const plan = (await offers(conn, month)).find((p) => p.id === Number(planId));
  if (!plan) throw notFound('Тариф не найден или не продаётся');
  if (ownerOrgId && !(await orgRole(conn, ownerOrgId, govUserId))) throw forbidden('Вы не сотрудник этой организации');
  const m = await checkMonths(months);
  const row = await one('SELECT * FROM hosting_plans WHERE id = ?', [plan.id], conn);
  await one('SELECT id FROM hosting_servers WHERE id = ? FOR UPDATE', [row.server_id], conn);
  if ((await freeDiskMb(conn, row.server_id)) < row.disk_mb) throw bad('server_full', 'На сервере хостера закончилось место — выберите другой тариф');
  const r = await q("INSERT INTO hosting_accounts (plan_id, server_id, org_id, owner_gov_user_id, owner_org_id, status, paid_until_month, created_month) VALUES (?, ?, ?, ?, ?, 'reserved', ?, ?)", [
    row.id, row.server_id, row.org_id, ownerOrgId ? null : govUserId, ownerOrgId, month, month,
  ], conn);
  const account = await one('SELECT * FROM hosting_accounts WHERE id = ?', [r.insertId], conn);
  const order = await createOrder(conn, { account, govUserId, months: m, amount: Number(row.price_month) * m });
  return { account_id: account.id, ...order };
}

export async function canManageAccount(conn, a, govUserId) {
  if (a.owner_gov_user_id === govUserId) return true;
  if (a.owner_org_id) return !!(await orgRole(conn, a.owner_org_id, govUserId));
  return false;
}

export async function ownAccount(conn, id, govUserId) {
  const a = await one("SELECT * FROM hosting_accounts WHERE id = ? AND status <> 'deleted'", [id], conn);
  if (!a || !(await canManageAccount(conn, a, govUserId))) throw notFound('Хостинг не найден');
  return a;
}

export async function renewHosting(conn, { govUserId, id, months }) {
  const a = await ownAccount(conn, id, govUserId);
  need(a.status === 'active' || a.status === 'suspended', 'Этот хостинг нельзя продлить');
  if (await one("SELECT id FROM hosting_orders WHERE account_id = ? AND status = 'pending'", [a.id], conn)) throw bad('order_pending', 'Уже есть неоплаченная квитанция');
  const plan = await one('SELECT * FROM hosting_plans WHERE id = ?', [a.plan_id], conn);
  const m = await checkMonths(months);
  return createOrder(conn, { account: a, govUserId, months: m, amount: Number(plan.price_month) * m });
}

/** Подключить имя к аккаунту: на сервере хостера появляется сайт (vhost). Адрес сервера владелец ставит в A-запись. */
export async function addSite(conn, { account, host: input }) {
  need(account.status === 'active', 'Хостинг не оплачен');
  const host = fqdn(String(input || ''));
  need(host && host.split('.').length >= 3, 'Имя сайта: например boris.bln или www.boris.bln');
  const name = disp(host);
  const plan = await one('SELECT max_sites FROM hosting_plans WHERE id = ?', [account.plan_id], conn);
  const n = await one('SELECT COUNT(*) AS n FROM hosting_sites WHERE account_id = ?', [account.id], conn);
  need(Number(n.n) < plan.max_sites, `По тарифу не больше ${plan.max_sites} сайтов`);
  const server = await one('SELECT * FROM hosting_servers WHERE id = ?', [account.server_id], conn);
  if (await one('SELECT id FROM net_vhosts WHERE ip = ? AND host = ?', [server.ip, name], conn)) throw conflict('exists', 'Сайт с таким именем на этом сервере уже есть');
  const r = await q('INSERT INTO hosting_sites (account_id, host) VALUES (?, ?)', [account.id, name], conn);
  await q('INSERT INTO net_vhosts (ip, host, target) VALUES (?, ?, ?)', [server.ip, name, `site:${r.insertId}`], conn);
  await fs.mkdir(siteDir(account.id, name), { recursive: true });
  invalidateNet();
  return { id: r.insertId, host: name, ip: server.ip };
}

export async function removeSite(conn, { account, siteId }) {
  const s = await one('SELECT * FROM hosting_sites WHERE id = ? AND account_id = ?', [siteId, account.id], conn);
  if (!s) throw notFound('Сайт не найден');
  await q('DELETE FROM net_vhosts WHERE target = ?', [`site:${s.id}`], conn);
  await q('DELETE FROM hosting_sites WHERE id = ?', [s.id], conn);
  await fs.rm(siteDir(account.id, s.host), { recursive: true, force: true });
  closeDb(s.id);
  invalidateNet();
}

/** Сайт по цели vhost «site:<id>»: аккаунт, каталог, статус. */
export async function siteByTarget(target) {
  const id = Number(String(target).slice(5));
  const s = await one('SELECT s.*, a.status AS account_status, a.plan_id, a.server_id, p.kind, p.rpm, p.cpu_ms, p.ws_limit, p.cron_min, p.disk_mb, h.ip AS server_ip FROM hosting_sites s JOIN hosting_accounts a ON a.id = s.account_id JOIN hosting_plans p ON p.id = a.plan_id JOIN hosting_servers h ON h.id = a.server_id WHERE s.id = ?', [id]);
  if (!s) return null;
  return { ...s, dir: siteDir(s.account_id, s.host) };
}

export async function refreshUsage(accountId) {
  const bytes = await dirSize(accountDir(accountId));
  await q('UPDATE hosting_accounts SET used_bytes = ? WHERE id = ?', [bytes, accountId]);
  return bytes;
}

// ——— Хостер: аренда серверов и тарифы ———

export async function rentServer(conn, { orgId }) {
  const month = await currentMonth(conn);
  need(await hasLicense(conn, orgId, 'hosting', month), 'Нужна лицензия хостинг-провайдера');
  const s = await getSettings();
  const rent = Number(s.hosting_server_rent || 0);
  const acc = await orgAccount(conn, orgId);
  const count = await one('SELECT COUNT(*) AS n FROM hosting_servers', [], conn);
  let ip = null;
  for (let k = 10 + Number(count.n); k < 65000; k++) {
    const cand = nthIp(RENT_CIDR, k);
    if (!(await one('SELECT ip FROM net_hosts WHERE ip = ?', [cand], conn))) { ip = cand; break; }
  }
  need(ip, 'В дата-центре закончились адреса');
  if (rent > 0) await post(conn, { kind: 'hosting_rent', memo: `Аренда сервера ${ip} в дата-центре БалНета`, entries: [{ account: acc, amount: -rent }, { account: await sys('BUDGET', conn), amount: rent }] });
  const r = await q('INSERT INTO hosting_servers (org_id, ip, name, disk_mb, rent_price, paid_month) VALUES (?, ?, ?, ?, ?, ?)', [orgId, ip, 'tmp', Number(s.hosting_server_disk_mb || 500), rent, month], conn);
  const name = `s${r.insertId}.dc.bln.`;
  await q('UPDATE hosting_servers SET name = ? WHERE id = ?', [name, r.insertId], conn);
  await q("INSERT INTO net_hosts (ip, name, kind) VALUES (?, ?, 'web')", [ip, name], conn);
  await setPtr(conn, ip, name);
  invalidateNet();
  return { id: r.insertId, ip, name: disp(name), rent };
}

/** Каждый игровой месяц: аренда серверов, приостановка и удаление неоплаченных аккаунтов. */
export async function hostingMonth(month) {
  const s = await getSettings();
  const grace = Number(s.hosting_grace_months ?? 1);
  for (const srv of await q("SELECT * FROM hosting_servers WHERE org_id IS NOT NULL AND status IN ('active','suspended') AND paid_month < ?", [month])) {
    await tx(async (conn) => {
      const acc = await orgAccount(conn, srv.org_id);
      const due = Number(srv.rent_price) * (month - srv.paid_month);
      try {
        if (due > 0) await post(conn, { kind: 'hosting_rent', memo: `Аренда сервера ${srv.ip}`, entries: [{ account: acc, amount: -due }, { account: await sys('BUDGET', conn), amount: due }] });
        await q("UPDATE hosting_servers SET paid_month = ?, status = 'active' WHERE id = ?", [month, srv.id], conn);
        await q('UPDATE net_hosts SET up = 1 WHERE ip = ?', [srv.ip], conn);
      } catch (e) {
        if (e.code !== 'insufficient_funds' && e.code !== 'account_frozen' && e.code !== 'account_arrested') throw e;
        if (srv.status !== 'suspended') {
          await q("UPDATE hosting_servers SET status = 'suspended' WHERE id = ?", [srv.id], conn);
          await q('UPDATE net_hosts SET up = 0 WHERE ip = ?', [srv.ip], conn);
          const org = await one('SELECT director_gov_user_id AS d, name FROM organizations WHERE id = ?', [srv.org_id], conn);
          if (org?.d) await notify(conn, 'gov', org.d, { title: `Сервер ${srv.ip} выключен за неуплату аренды`, body: `Пополните счёт «${org.name}»: долг спишется в начале следующего месяца`, link: '#/orgs', email: true });
        }
      }
    });
  }
  for (const a of await q("SELECT * FROM hosting_accounts WHERE status = 'reserved' AND created_month < ?", [month])) {
    await q("UPDATE hosting_accounts SET status = 'deleted' WHERE id = ?", [a.id]);
    await q("UPDATE hosting_orders SET status = 'cancelled' WHERE account_id = ? AND status = 'pending'", [a.id]);
    await q("UPDATE invoices i JOIN hosting_orders o ON o.invoice_id = i.id SET i.status = 'cancelled' WHERE o.account_id = ? AND i.status = 'unpaid'", [a.id]);
  }
  for (const a of await q("SELECT * FROM hosting_accounts WHERE status = 'active' AND paid_until_month <= ?", [month])) {
    await q("UPDATE hosting_accounts SET status = 'suspended' WHERE id = ?", [a.id]);
    const who = a.owner_gov_user_id || (await one('SELECT director_gov_user_id AS d FROM organizations WHERE id = ?', [a.owner_org_id]))?.d;
    if (who) await tx(async (conn) => notify(conn, 'gov', who, { title: 'Хостинг приостановлен за неуплату', body: `Продлите в течение ${grace} игр. мес., иначе файлы сайтов будут удалены`, link: `${LINK}/${a.id}`, email: true }));
  }
  for (const a of await q("SELECT * FROM hosting_accounts WHERE status = 'suspended' AND paid_until_month + ? <= ?", [grace, month])) {
    await deleteAccount(a);
  }
  invalidateNet();
}

export async function deleteAccount(a) {
  await tx(async (conn) => {
    await q("DELETE v FROM net_vhosts v JOIN hosting_sites s ON v.target = CONCAT('site:', s.id) WHERE s.account_id = ?", [a.id], conn);
    await q('DELETE FROM hosting_sites WHERE account_id = ?', [a.id], conn);
    await q("UPDATE hosting_accounts SET status = 'deleted', used_bytes = 0 WHERE id = ?", [a.id], conn);
    await q("UPDATE hosting_orders SET status = 'cancelled' WHERE account_id = ? AND status = 'pending'", [a.id], conn);
  });
  await fs.rm(accountDir(a.id), { recursive: true, force: true });
}

onMonth('hosting', async (month) => { await hostingMonth(month); });

export async function accountView(conn, a) {
  const plan = await one('SELECT * FROM hosting_plans WHERE id = ?', [a.plan_id], conn);
  const server = await one('SELECT ip, name FROM hosting_servers WHERE id = ?', [a.server_id], conn);
  const rows = await q('SELECT s.id, s.host, s.cert_id, c.policy, c.na, c.status AS cert_status, c.names, c.auto_renew FROM hosting_sites s LEFT JOIN pki_certs c ON c.id = s.cert_id WHERE s.account_id = ? ORDER BY s.host', [a.id], conn);
  const sites = rows.map((r) => ({
    id: r.id, host: r.host,
    cert: r.cert_id ? { id: r.cert_id, policy: r.policy, na: Number(r.na), status: r.cert_status, auto_renew: !!r.auto_renew, names: typeof r.names === 'string' ? JSON.parse(r.names) : r.names } : null,
  }));
  const pending = await one("SELECT o.amount, i.number FROM hosting_orders o LEFT JOIN invoices i ON i.id = o.invoice_id WHERE o.account_id = ? AND o.status = 'pending' ORDER BY o.id DESC LIMIT 1", [a.id], conn);
  return {
    id: a.id, status: a.status, status_title: ACCOUNT_STATUS[a.status], hoster: await hosterName(conn, a.org_id), plan: plan?.name, kind: plan?.kind || 'static', limits: plan ? { rpm: plan.rpm, cpu_ms: plan.cpu_ms, ws_limit: plan.ws_limit, cron_min: plan.cron_min } : null, disk_mb: plan?.disk_mb, max_sites: plan?.max_sites, price_month: Number(plan?.price_month || 0),
    server_ip: server?.ip, server: disp(server?.name || ''), ssh: { user: `u${a.id}`, host: server?.ip, enabled: !!a.ssh_hash }, paid_until_month: a.paid_until_month, used_bytes: Number(a.used_bytes), owner_org_id: a.owner_org_id,
    sites, pending_order: pending ? { amount: Number(pending.amount), invoice: pending.number } : null,
  };
}
