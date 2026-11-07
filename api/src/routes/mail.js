// ВлодПочта: API сайта mail.bln (ящик, папки, письма, отправка, свои домены), аккаунт ВлодБраузера
// (устройства и синхронизация) и раздел админки (журнал серверов, жалобы, блокировки).
import { q, one } from '../db.js';
import { notFound, need, int, str } from '../lib/errors.js';
import { needGov, needAdmin, session, actorOf } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import {
  accountOf, needAccount, createAccount, addressesOf, addDomain, ownMailDomain, checkDomain, autoRecords, addAddress, requiredRecords,
  sendFromAccount, listView, fullView, MAIL_DOMAIN,
} from '../lib/mailnet/mailbox.js';
import { train } from '../lib/mailnet/spam.js';
import { createDevice, deviceOf, keyOf, setKey, wipe, pull, push, COLLECTIONS } from '../lib/mailnet/sync.js';

const FOLDERS = ['inbox', 'sent', 'spam', 'trash', 'drafts'];
const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v);

async function ownMessage(acc, id) {
  const m = await one('SELECT * FROM mail_messages WHERE id = ? AND account_id = ?', [int(id, 'id'), acc.id]);
  if (!m) throw notFound('Письмо не найдено');
  return m;
}

const domainView = (d, addrs) => ({ id: d.id, name: d.name, selector: d.selector, checks: J(d.checks), checked_at: d.checked_at, records: requiredRecords(d), addresses: addrs, catch_all: !!d.catch_all_account_id });

export async function mailRoutes(app) {
  const auth = { preHandler: needGov() };
  const me = (req) => needAccount(req.gov.id);

  app.get('/me', async (req) => {
    const s = await session(req, 'gov').catch(() => null);
    if (!s) return { gov: null, account: null };
    const a = await accountOf(s.id);
    return {
      gov: { id: s.id, name: s.user.display_name },
      account: a ? { login: a.login, address: `${a.login}@${MAIL_DOMAIN}`, name: a.name, signature: a.signature, notify_email: !!a.notify_email, spam_threshold: a.spam_threshold, status: a.status } : null,
      addresses: a ? (await addressesOf(a.id)).map((x) => x.address) : [],
    };
  });
  app.post('/me', auth, async (req) => {
    const a = await createAccount(req.gov.id, req.body?.login, req.body?.name);
    return { login: a.login, address: `${a.login}@${MAIL_DOMAIN}` };
  });
  app.patch('/me', auth, async (req) => {
    const a = await me(req);
    const b = req.body || {};
    const set = [];
    const v = [];
    if (b.name !== undefined) { set.push('name = ?'); v.push(String(b.name || '').slice(0, 80) || null); }
    if (b.signature !== undefined) { set.push('signature = ?'); v.push(String(b.signature || '').slice(0, 500) || null); }
    if (b.notify_email !== undefined) { set.push('notify_email = ?'); v.push(b.notify_email ? 1 : 0); }
    if (b.spam_threshold !== undefined) { set.push('spam_threshold = ?'); v.push(int(b.spam_threshold, 'Порог', { min: 10, max: 200 })); }
    if (set.length) await q(`UPDATE mail_accounts SET ${set.join(', ')} WHERE id = ?`, [...v, a.id]);
    return { ok: true };
  });

  // ——— Папки и письма ———
  app.get('/folders', auth, async (req) => {
    const a = await me(req);
    const rows = await q('SELECT folder, COUNT(*) AS total, SUM(seen = 0) AS unread FROM mail_messages WHERE account_id = ? GROUP BY folder', [a.id]);
    const out = Object.fromEntries(FOLDERS.map((f) => [f, { total: 0, unread: 0 }]));
    for (const r of rows) out[r.folder] = { total: Number(r.total), unread: Number(r.unread || 0) };
    const starred = await one('SELECT COUNT(*) AS n FROM mail_messages WHERE account_id = ? AND starred = 1', [a.id]);
    return { folders: out, starred: Number(starred.n) };
  });

  app.get('/messages', auth, async (req) => {
    const a = await me(req);
    const folder = String(req.query.folder || 'inbox');
    const where = ['account_id = ?'];
    const v = [a.id];
    if (folder === 'starred') where.push('starred = 1');
    else { need(FOLDERS.includes(folder), 'Неизвестная папка'); where.push('folder = ?'); v.push(folder); }
    if (req.query.q) {
      const s = `%${String(req.query.q).slice(0, 100).replace(/[%_]/g, '\\$&')}%`;
      where.push('(subject LIKE ? OR from_addr LIKE ? OR from_name LIKE ? OR body_text LIKE ?)');
      v.push(s, s, s, s);
    }
    if (req.query.before) { where.push('id < ?'); v.push(int(req.query.before, 'before')); }
    const rows = await q(`SELECT id, folder, from_addr, from_name, to_addrs, subject, snippet, seen, starred, spam_score, created_at, game_time, auth FROM mail_messages WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 50`, v);
    return { messages: rows.map(listView) };
  });

  app.get('/messages/:id', auth, async (req) => {
    const a = await me(req);
    const m = await ownMessage(a, req.params.id);
    if (!m.seen) await q('UPDATE mail_messages SET seen = 1 WHERE id = ?', [m.id]);
    return { message: fullView({ ...m, seen: 1 }) };
  });

  app.get('/messages/:id/raw', auth, async (req, reply) => {
    const a = await me(req);
    const m = await ownMessage(a, req.params.id);
    reply.header('content-type', 'text/plain; charset=utf-8');
    return m.raw || '';
  });

  app.patch('/messages/:id', auth, async (req) => {
    const a = await me(req);
    const m = await ownMessage(a, req.params.id);
    const b = req.body || {};
    if (b.seen !== undefined) await q('UPDATE mail_messages SET seen = ? WHERE id = ?', [b.seen ? 1 : 0, m.id]);
    if (b.starred !== undefined) await q('UPDATE mail_messages SET starred = ? WHERE id = ?', [b.starred ? 1 : 0, m.id]);
    if (b.folder !== undefined) {
      need(['inbox', 'trash', 'spam'].includes(b.folder), 'Переместить можно во «Входящие», «Спам» или «Корзину»');
      await q('UPDATE mail_messages SET folder = ? WHERE id = ?', [b.folder, m.id]);
    }
    return { ok: true };
  });

  /** «Это спам» / «Не спам»: письмо переезжает и обучает фильтр ящика. */
  app.post('/messages/:id/spam', auth, async (req) => {
    const a = await me(req);
    const m = await ownMessage(a, req.params.id);
    const spam = !!req.body?.spam;
    await train(a.id, m, spam);
    await q('UPDATE mail_messages SET folder = ? WHERE id = ?', [spam ? 'spam' : 'inbox', m.id]);
    if (!spam) await q('INSERT IGNORE INTO mail_contacts (account_id, address, sent) VALUES (?, ?, 0)', [a.id, m.from_addr]);
    return { ok: true, folder: spam ? 'spam' : 'inbox' };
  });

  app.delete('/messages/:id', auth, async (req) => {
    const a = await me(req);
    const m = await ownMessage(a, req.params.id);
    if (m.folder === 'trash') await q('DELETE FROM mail_messages WHERE id = ?', [m.id]);
    else await q("UPDATE mail_messages SET folder = 'trash' WHERE id = ?", [m.id]);
    return { ok: true, deleted: m.folder === 'trash' };
  });

  /** Жалоба админу: копия письма уходит в очередь жалоб (админ видит письмо только так). */
  app.post('/messages/:id/report', auth, async (req) => {
    const a = await me(req);
    const m = await ownMessage(a, req.params.id);
    await q('INSERT INTO mail_reports (account_id, message_id, reason, from_addr, subject, raw) VALUES (?, ?, ?, ?, ?, ?)', [a.id, m.id, String(req.body?.reason || '').slice(0, 500) || null, m.from_addr, m.subject, m.raw]);
    return { ok: true };
  });

  app.post('/send', { ...auth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const a = await me(req);
    return sendFromAccount(a, req.body || {});
  });

  app.get('/contacts', auth, async (req) => {
    const a = await me(req);
    const s = `%${String(req.query.q || '').slice(0, 60)}%`;
    return { contacts: await q('SELECT address, name FROM mail_contacts WHERE account_id = ? AND address LIKE ? ORDER BY sent DESC, last_at DESC LIMIT 10', [a.id, s]) };
  });

  // ——— Почта для своего домена ———
  app.get('/domains', auth, async (req) => {
    const rows = await q('SELECT * FROM mail_domains WHERE owner_gov_user_id = ? ORDER BY id', [req.gov.id]);
    const out = [];
    for (const d of rows) {
      const addrs = await q('SELECT x.address, m.login FROM mail_addresses x JOIN mail_accounts m ON m.id = x.account_id WHERE x.domain_id = ? ORDER BY x.address', [d.id]);
      out.push(domainView(d, addrs.map((x) => ({ address: x.address, owner: `${x.login}@${MAIL_DOMAIN}` }))));
    }
    return { domains: out };
  });
  app.post('/domains', auth, async (req) => {
    await me(req);
    const d = await addDomain(req.gov.id, req.body?.name);
    await audit(null, actorOf(req.gov), 'mail.domain_add', 'mail_domain', d.id, { name: d.name });
    return { domain: domainView(d, []) };
  });
  app.post('/domains/:id/check', auth, async (req) => {
    const d = await ownMailDomain(req.gov.id, int(req.params.id, 'id'));
    return { checks: await checkDomain(d) };
  });
  app.post('/domains/:id/auto', auth, async (req) => {
    const d = await ownMailDomain(req.gov.id, int(req.params.id, 'id'));
    await autoRecords(d);
    return { checks: await checkDomain(d) };
  });
  app.post('/domains/:id/addresses', auth, async (req) => {
    const address = await addAddress(req.gov.id, int(req.params.id, 'id'), req.body?.local, req.body?.for || null);
    return { address };
  });
  app.delete('/domains/:id/addresses/:address', auth, async (req) => {
    const d = await ownMailDomain(req.gov.id, int(req.params.id, 'id'));
    await q('DELETE FROM mail_addresses WHERE domain_id = ? AND address = ?', [d.id, String(req.params.address).toLowerCase()]);
    return { ok: true };
  });
  app.patch('/domains/:id', auth, async (req) => {
    const d = await ownMailDomain(req.gov.id, int(req.params.id, 'id'));
    if (req.body?.catch_all !== undefined) {
      const a = req.body.catch_all ? await me(req) : null;
      await q('UPDATE mail_domains SET catch_all_account_id = ? WHERE id = ?', [a?.id || null, d.id]);
    }
    return { ok: true };
  });
  app.delete('/domains/:id', auth, async (req) => {
    const d = await ownMailDomain(req.gov.id, int(req.params.id, 'id'));
    await q('DELETE FROM mail_addresses WHERE domain_id = ?', [d.id]);
    await q('DELETE FROM mail_domains WHERE id = ?', [d.id]);
    await audit(null, actorOf(req.gov), 'mail.domain_remove', 'mail_domain', d.id, { name: d.name });
    return { ok: true };
  });

  // ——— Аккаунт ВлодБраузера ———
  /** Подключить браузер: нужен вход во ВлодУслуги и ящик. Токен живёт, пока устройство не удалят. */
  app.post('/sync/devices', { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const a = await me(req);
    const token = await createDevice(a.id, req.body?.name);
    const key = await keyOf(a.id);
    return { token, account: { login: a.login, address: `${a.login}@${MAIL_DOMAIN}`, name: a.name }, key: key ? { salt: key.salt, iterations: key.iterations, check: key.check_blob } : null };
  });
  app.get('/sync/devices', auth, async (req) => {
    const a = await me(req);
    const key = await keyOf(a.id);
    const data = await q('SELECT collection, rev, updated_at, LENGTH(blob_data) AS bytes FROM browser_sync_data WHERE account_id = ?', [a.id]);
    return { devices: await q('SELECT id, name, last_seen, created_at FROM browser_devices WHERE account_id = ? ORDER BY id DESC', [a.id]), has_key: !!key, data };
  });
  app.delete('/sync/devices/:id', auth, async (req) => {
    const a = await me(req);
    await q('DELETE FROM browser_devices WHERE id = ? AND account_id = ?', [int(req.params.id, 'id'), a.id]);
    return { ok: true };
  });
  app.post('/sync/reset', auth, async (req) => {
    const a = await me(req);
    await wipe(a.id);
    await audit(null, actorOf(req.gov), 'browser.sync_reset', 'mail_account', a.id);
    return { ok: true };
  });

  // Дальше — запросы самого браузера: токен устройства в теле (cookie для синхронизации не нужны).
  const dev = (req) => deviceOf(req.body?.token);
  app.post('/sync/status', async (req) => {
    const d = await dev(req);
    const key = await keyOf(d.account_id);
    return { account: { login: d.login, address: `${d.login}@${MAIL_DOMAIN}`, name: d.account_name }, device: { id: d.id, name: d.name }, key: key ? { salt: key.salt, iterations: key.iterations, check: key.check_blob } : null };
  });
  app.post('/sync/key', async (req) => {
    const d = await dev(req);
    await setKey(d.account_id, req.body || {});
    return { ok: true };
  });
  app.post('/sync/pull', async (req) => {
    const d = await dev(req);
    return { collections: await pull(d.account_id), names: COLLECTIONS };
  });
  app.post('/sync/push', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const d = await dev(req);
    need(await keyOf(d.account_id), 'Сначала задайте кодовую фразу синхронизации');
    const rev = await push(d.account_id, str(req.body?.collection, 'collection', { max: 20 }), req.body?.base_rev, req.body?.blob);
    return { rev };
  });
  app.post('/sync/signout', async (req) => {
    const d = await dev(req);
    await q('DELETE FROM browser_devices WHERE id = ?', [d.id]);
    return { ok: true };
  });
}

export async function adminMailRoutes(app) {
  app.addHook('preHandler', needAdmin());

  app.get('/stats', async () => {
    const [acc, dom, msg, log] = await Promise.all([
      one('SELECT COUNT(*) AS n FROM mail_accounts'),
      one('SELECT COUNT(*) AS n FROM mail_domains'),
      one('SELECT COUNT(*) AS n, COALESCE(SUM(size), 0) AS bytes FROM mail_messages'),
      q('SELECT status, COUNT(*) AS n FROM mail_log WHERE created_at > NOW() - INTERVAL 1 DAY GROUP BY status'),
    ]);
    const reports = await one("SELECT COUNT(*) AS n FROM mail_reports WHERE status = 'open'");
    return { accounts: Number(acc.n), domains: Number(dom.n), messages: Number(msg.n), bytes: Number(msg.bytes), day: Object.fromEntries(log.map((r) => [r.status, Number(r.n)])), open_reports: Number(reports.n) };
  });
  // Журнал серверов: без текста писем — только конверт и результаты проверок.
  app.get('/log', async (req) => {
    const where = [];
    const v = [];
    if (req.query.q) { const s = `%${String(req.query.q).slice(0, 100)}%`; where.push('(rcpt LIKE ? OR mail_from LIKE ? OR header_from LIKE ? OR from_ip LIKE ?)'); v.push(s, s, s, s); }
    if (req.query.status) { where.push('status = ?'); v.push(String(req.query.status)); }
    return { log: await q(`SELECT * FROM mail_log ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id DESC LIMIT 200`, v) };
  });
  app.get('/accounts', async (req) => {
    const s = `%${String(req.query.q || '').slice(0, 60)}%`;
    return { accounts: await q('SELECT m.id, m.login, m.name, m.status, m.created_at, g.display_name, (SELECT COUNT(*) FROM mail_messages x WHERE x.account_id = m.id) AS messages FROM mail_accounts m JOIN gov_users g ON g.id = m.gov_user_id WHERE m.login LIKE ? OR g.display_name LIKE ? ORDER BY m.id DESC LIMIT 200', [s, s]) };
  });
  app.post('/accounts/:id/status', async (req) => {
    const status = req.body?.status === 'blocked' ? 'blocked' : 'active';
    await q('UPDATE mail_accounts SET status = ? WHERE id = ?', [status, int(req.params.id, 'id')]);
    await audit(null, actorOf(req.actor), `mail.account_${status}`, 'mail_account', int(req.params.id, 'id'));
    return { ok: true };
  });
  app.get('/domains', async () => ({ domains: await q('SELECT d.id, d.name, d.checks, d.created_at, g.display_name AS owner, (SELECT COUNT(*) FROM mail_addresses a WHERE a.domain_id = d.id) AS addresses FROM mail_domains d LEFT JOIN gov_users g ON g.id = d.owner_gov_user_id ORDER BY d.id') }));
  app.get('/reports', async () => ({ reports: await q('SELECT r.id, r.reason, r.from_addr, r.subject, r.status, r.created_at, m.login FROM mail_reports r JOIN mail_accounts m ON m.id = r.account_id ORDER BY r.status = \'open\' DESC, r.id DESC LIMIT 200') }));
  // Само письмо админ открывает только по жалобе, и каждое открытие пишется в журнал аудита.
  app.get('/reports/:id', async (req) => {
    const r = await one('SELECT * FROM mail_reports WHERE id = ?', [int(req.params.id, 'id')]);
    if (!r) throw notFound();
    await audit(null, actorOf(req.actor), 'mail.report_view', 'mail_report', r.id);
    return { report: r };
  });
  app.post('/reports/:id/close', async (req) => {
    await q("UPDATE mail_reports SET status = 'closed' WHERE id = ?", [int(req.params.id, 'id')]);
    await audit(null, actorOf(req.actor), 'mail.report_close', 'mail_report', int(req.params.id, 'id'));
    return { ok: true };
  });
}
