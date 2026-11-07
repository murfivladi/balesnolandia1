import fs from 'node:fs/promises';
import { resetPkiCache } from '../lib/pki.js';
import { resetSearch } from './search.js';
import { closeAll } from '../lib/vhost/store.js';
import { tx, q, one, pool, json } from '../db.js';
import { bad, notFound, int, str, need } from '../lib/errors.js';
import { needAdmin, actorOf, rolesOf } from '../lib/auth.js';
import { getSettings, setSettings, DEFAULTS, SECRET_KEYS, resetSettingsCache, webUrl } from '../lib/settings.js';
import { sendMail, verifyMail } from '../lib/mail.js';
import { config } from '../config.js';
import { VERSION } from '../lib/version.js';
import { post, sys, reverse, clearSystemCache, recomputeBalance } from '../lib/ledger.js';
import { notify } from '../lib/notify.js';
import { audit } from '../lib/audit.js';
import { clockState, advance } from '../lib/clock.js';
import { publish } from '../lib/hub.js';
import { accountView, cardView } from '../lib/bank.js';
import { publicBankUser, publicGovUser } from './auth.js';
import { passportView } from './gov.js';
import { activePassport } from '../lib/gov.js';
import { formatMoney } from '@bln/shared/money.js';
import { invalidateNet } from '../lib/net.js';
import { flushResolverCache } from '../lib/dns.js';

export const ROLES = {
  admin: ['bank', 'gov'],
  teller: ['bank'],
  official: ['gov'],
  police: ['gov'],
  tax: ['gov'],
  doctor: ['gov'],
};

const SETTING_TYPES = Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, v === null ? 'image' : typeof v]));

function cleanSettings(body) {
  const out = {};
  for (const [k, v] of Object.entries(body || {})) {
    const t = SETTING_TYPES[k];
    if (!t) continue;
    if (t === 'boolean') out[k] = !!v;
    else if (t === 'number') {
      const n = Number(v);
      need(Number.isSafeInteger(n) && n >= 0, `Неверное значение: ${k}`);
      out[k] = n;
    } else if (t === 'image') {
      need(v === null || v === '' || (typeof v === 'string' && /^data:image\//.test(v) && v.length < 500_000), `Изображение до 350 КБ: ${k}`);
      out[k] = v || null;
    } else if (t === 'string') {
      // Пустой секрет из формы означает «не менять»; очистка — явным null.
      if (SECRET_KEYS.includes(k) && (v === '' || v === undefined)) continue;
      need(v === null || typeof v === 'string', `Неверное значение: ${k}`);
      const sv = String(v ?? '').trim();
      need(sv.length <= 500, `Слишком длинное значение: ${k}`);
      out[k] = sv;
    }
  }
  if (out.public_web_url) need(/^https?:\/\/[^\s]+$/.test(out.public_web_url), 'Адрес сайта: https://…');
  if (out.smtp_port !== undefined) need(out.smtp_port >= 1 && out.smtp_port <= 65535, 'Порт SMTP: от 1 до 65535');
  if ('idle_minutes' in out) need(out.idle_minutes >= 1 && out.idle_minutes <= 240, 'Автовыход: от 1 до 240 минут');
  if ('game_month_minutes' in out) need(out.game_month_minutes >= 1 && out.game_month_minutes <= 1440, 'Игровой месяц: от 1 до 1440 минут');
  return out;
}

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/;
const KEEP_ON_RESET = new Set(['schema_migrations', 'settings', 'cashback_categories', 'wholesale_items', 'fine_articles', 'countries',
  // Инфраструктура БалНета — настройка админа, а не игровые данные. Аренды адресов (net_leases) сбрасываются.
  'net_providers', 'net_ip_blocks', 'net_hosts', 'net_vhosts', 'dns_zones', 'dns_zone_servers', 'dns_records', 'tlds',
  // Госхостинг (серверы и тарифы без организации) — настройка админа; хостеров убираем отдельно.
  'hosting_servers', 'hosting_plans']);

async function tableNames(conn) {
  const rows = await q('SHOW TABLES', [], conn);
  return rows.map((r) => Object.values(r)[0]).filter((t) => t !== 'schema_migrations');
}

export async function adminRoutes(app) {
  app.addHook('preHandler', needAdmin());
  const actor = (req) => actorOf(req.actor);

  app.get('/me', async (req) => ({ kind: req.actor.kind, id: req.actor.id, name: req.actor.user.full_name || req.actor.user.display_name, roles: req.actor.roles }));

  // ——— Обзор и экономика ———
  app.get('/overview', async () => {
    const counts = await one(`SELECT
      (SELECT COUNT(*) FROM bank_users) AS bank_users,
      (SELECT COUNT(*) FROM gov_users) AS gov_users,
      (SELECT COUNT(*) FROM citizens WHERE passport_no IS NOT NULL) AS citizens,
      (SELECT COUNT(*) FROM shops WHERE status = 'active') AS shops,
      (SELECT COUNT(*) FROM bank_users WHERE status = 'pending') AS pending_bank,
      (SELECT COUNT(*) FROM applications WHERE status = 'pending') AS pending_apps,
      (SELECT COUNT(*) FROM cards WHERE status = 'active') AS cards,
      (SELECT COUNT(*) FROM loans WHERE status = 'pending') + (SELECT COUNT(*) FROM credit_lines WHERE status = 'pending') AS pending_credit,
      (SELECT COUNT(*) FROM fraud_queue WHERE status = 'pending') AS pending_fraud,
      (SELECT COUNT(*) FROM fines WHERE appeal_status = 'pending') AS pending_fine_appeals,
      (SELECT COUNT(*) FROM benefits WHERE status = 'pending') AS pending_benefits,
      (SELECT COUNT(*) FROM appeals WHERE status = 'open') AS open_appeals,
      (SELECT COUNT(*) FROM citizen_sanctions WHERE active = 1) AS sanctions`);
    for (const k of Object.keys(counts)) counts[k] = Number(counts[k]);
    return { counts, economy: await economy(), clock: await clockState() };
  });

  async function economy() {
    const sysRows = await q("SELECT system_code, balance FROM accounts WHERE owner_kind = 'system'");
    const sysBal = Object.fromEntries(sysRows.map((r) => [r.system_code, Number(r.balance)]));
    const byType = await q("SELECT type, COUNT(*) AS n, COALESCE(SUM(balance),0) AS total FROM accounts WHERE owner_kind = 'bank_user' AND status <> 'closed' GROUP BY type");
    // Деньги клиентов — положительные остатки; долги по кредитам и кредитным картам — отдельно.
    const pos = await one("SELECT COALESCE(SUM(GREATEST(balance,0)),0) AS p, COALESCE(-SUM(LEAST(balance,0)),0) AS d FROM accounts WHERE owner_kind = 'bank_user' AND status <> 'closed'");
    const deposits = Number(pos.p);
    const idx = await one('SELECT index_ppm, rate_bp FROM price_index ORDER BY month DESC LIMIT 1');
    return {
      emitted: -(sysBal.EMISSION || 0),
      treasury: sysBal.TREASURY || 0,
      budget: sysBal.BUDGET || 0,
      cash: sysBal.CASH || 0,
      wholesale: sysBal.WHOLESALE || 0,
      deposits,
      money_supply: deposits + (sysBal.CASH || 0),
      debt: Number(pos.d),
      price_index: idx ? Number(idx.index_ppm) / 1e6 : 1,
      inflation_bp: idx ? idx.rate_bp : 0,
      by_type: byType.map((r) => ({ type: r.type, count: Number(r.n), total: Number(r.total) })),
    };
  }

  app.get('/economy', async () => {
    const richest = await q(`SELECT u.id, u.full_name, SUM(a.balance) AS total FROM accounts a JOIN bank_users u ON u.id = a.owner_id
      WHERE a.owner_kind = 'bank_user' AND a.status <> 'closed' GROUP BY u.id, u.full_name ORDER BY total DESC LIMIT 15`);
    const daily = await q(`SELECT DATE(t.created_at) AS d, COUNT(DISTINCT t.id) AS n, COALESCE(SUM(CASE WHEN e.amount > 0 THEN e.amount ELSE 0 END),0) AS volume
      FROM ledger_tx t JOIN ledger_entries e ON e.tx_id = t.id WHERE t.created_at >= CURDATE() - INTERVAL 13 DAY GROUP BY DATE(t.created_at) ORDER BY d`);
    const kinds = await q(`SELECT t.kind, COUNT(*) AS n FROM ledger_tx t WHERE t.created_at >= NOW() - INTERVAL 7 DAY GROUP BY t.kind ORDER BY n DESC`);
    return {
      ...(await economy()),
      richest: richest.map((r) => ({ ...r, total: Number(r.total) })),
      daily: daily.map((r) => ({ day: r.d, count: Number(r.n), volume: Number(r.volume) })),
      kinds,
      clock: await clockState(),
    };
  });

  // ——— Настройки ———
  /** Настройки без секретов: вместо пароля — признак «задан». */
  function masked(s) {
    const out = { ...s };
    for (const k of SECRET_KEYS) {
      out[`${k}_set`] = !!s[k];
      out[k] = '';
    }
    return out;
  }

  app.get('/settings', async () => ({ settings: masked(await getSettings({ fresh: true })), defaults: DEFAULTS }));

  // Сведения о сервере и о том, откуда берутся адреса и почта.
  app.get('/server', async () => {
    const s = await getSettings();
    const db = await one('SELECT VERSION() AS v');
    return {
      version: VERSION,
      node: process.version,
      db: db.v,
      env: config.env,
      web_url: await webUrl(),
      cookie_domain: config.cookieDomain || null,
      mail: s.smtp_host ? 'smtp (админка)' : config.mail.transport === 'smtp' && config.mail.host ? 'smtp (.env)' : 'лог сервера',
      game_clock: config.gameClock,
    };
  });

  // Тестовое письмо: проверка SMTP из админки.
  app.post('/mail/test', async (req) => {
    const to = String(req.body?.to || req.actor.user.email || '').trim();
    need(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to), 'Неверный email');
    try {
      await verifyMail();
      await sendMail({ to, subject: 'Тестовое письмо Балесноландии', text: 'Почта настроена: письма с кодами входа и уведомлениями будут приходить.' });
    } catch (err) {
      throw bad('mail_failed', `Почта не отправлена: ${err.message}`);
    }
    return { ok: true, to };
  });

  app.patch('/settings', async (req) => {
    const patch = cleanSettings(req.body);
    const s = masked(await setSettings(patch));
    await audit(null, actor(req), 'admin.settings', null, null, Object.fromEntries(Object.entries(patch).map(([k, v]) => [k, SECRET_KEYS.includes(k) ? '[скрыто]' : typeof v === 'string' && v.length > 100 ? '[image]' : v])));
    return { settings: s };
  });

  // ——— Игровое время ———
  app.post('/clock', async (req) => {
    const b = req.body || {};
    if (b.paused !== undefined) await q('UPDATE game_clock SET paused = ?, last_tick_at = NOW(3) WHERE id = 1', [b.paused ? 1 : 0]);
    if (b.minutes !== undefined) await setSettings(cleanSettings({ game_month_minutes: b.minutes }));
    let month = null;
    if (b.advance) month = await advance({ force: true });
    await audit(null, actor(req), 'admin.clock', null, null, b);
    publish('clock', { type: 'state' });
    return { clock: await clockState(), advanced: month };
  });

  // ——— Люди и роли ———
  app.get('/users', async (req) => {
    const kind = req.query.kind === 'gov' ? 'gov' : 'bank';
    const term = `%${String(req.query.q || '').trim()}%`;
    const rows = kind === 'bank'
      ? await q('SELECT * FROM bank_users WHERE full_name LIKE ? OR email LIKE ? OR passport_no LIKE ? ORDER BY id DESC LIMIT 200', [term, term, term])
      : await q('SELECT g.*, c.full_name, c.passport_no FROM gov_users g LEFT JOIN citizens c ON c.gov_user_id = g.id WHERE g.display_name LIKE ? OR g.email LIKE ? OR c.full_name LIKE ? OR c.passport_no LIKE ? ORDER BY g.id DESC LIMIT 200', [term, term, term, term]);
    const roles = await q('SELECT user_id, role FROM user_roles WHERE user_kind = ?', [kind]);
    const byUser = new Map();
    for (const r of roles) byUser.set(r.user_id, [...(byUser.get(r.user_id) || []), r.role]);
    return {
      users: rows.map((u) => (kind === 'bank'
        ? { ...publicBankUser(u, byUser.get(u.id) || []), created_at: u.created_at, last_seen_at: u.last_seen_at }
        : { ...publicGovUser(u, byUser.get(u.id) || []), full_name: u.full_name, passport_no: u.passport_no, created_at: u.created_at, last_seen_at: u.last_seen_at })),
    };
  });

  app.get('/users/:kind/:id', async (req) => {
    const kind = req.params.kind === 'gov' ? 'gov' : 'bank';
    const id = int(req.params.id, 'id');
    if (kind === 'bank') {
      const u = await one('SELECT * FROM bank_users WHERE id = ?', [id]);
      if (!u) throw notFound();
      const accounts = await q("SELECT * FROM accounts WHERE owner_kind = 'bank_user' AND owner_id = ? ORDER BY id", [id]);
      const cards = await q('SELECT * FROM cards WHERE bank_user_id = ? ORDER BY id DESC', [id]);
      const shops = await q('SELECT id, name, status FROM shops WHERE owner_id = ?', [id]);
      const loans = await q('SELECT id, amount, amount_requested, months, status, created_at FROM loans WHERE bank_user_id = ? ORDER BY id DESC', [id]);
      const fraud = await q('SELECT id, kind, mode, amount, reason, status, created_at FROM fraud_queue WHERE bank_user_id = ? ORDER BY id DESC LIMIT 20', [id]);
      return {
        user: publicBankUser(u, await rolesOf('bank', id)), accounts: accounts.map(accountView), cards: cards.map((c) => cardView(c)), shops,
        loans: loans.map((l) => ({ ...l, amount: l.amount === null ? null : Number(l.amount), amount_requested: Number(l.amount_requested) })),
        fraud: fraud.map((f) => ({ ...f, amount: Number(f.amount) })),
      };
    }
    const u = await one('SELECT * FROM gov_users WHERE id = ?', [id]);
    if (!u) throw notFound();
    const c = await one('SELECT * FROM citizens WHERE gov_user_id = ?', [id]);
    const docs = c ? await q('SELECT * FROM documents WHERE citizen_id = ? ORDER BY id', [c.id]) : [];
    const apps = await q('SELECT id, type, status, created_at FROM applications WHERE gov_user_id = ? ORDER BY id DESC', [id]);
    const invoices = await q('SELECT number, purpose, amount, status FROM invoices WHERE gov_user_id = ? ORDER BY id DESC', [id]);
    return { user: publicGovUser(u, await rolesOf('gov', id)), passport: c ? passportView(c, await activePassport(c.id)) : null, documents: docs.map((d) => ({ ...d, data: json(d.data, {}) })), applications: apps, invoices: invoices.map((i) => ({ ...i, amount: Number(i.amount) })) };
  });

  app.post('/users/:kind/:id/status', async (req) => {
    const kind = req.params.kind === 'gov' ? 'gov' : 'bank';
    const id = int(req.params.id, 'id');
    const status = String(req.body?.status || '');
    const allowed = kind === 'bank' ? ['active', 'blocked', 'pending', 'rejected'] : ['active', 'blocked'];
    if (!allowed.includes(status)) throw bad('invalid', 'Неверный статус');
    await tx(async (conn) => {
      await q(`UPDATE ${kind === 'bank' ? 'bank_users' : 'gov_users'} SET status = ? WHERE id = ?`, [status, id], conn);
      if (kind === 'bank' && status === 'active') await notify(conn, 'bank', id, { title: 'Регистрация одобрена', body: 'Добро пожаловать во ВлодБанк', link: '#/', email: true });
      await audit(conn, actor(req), `admin.user_${status}`, `${kind}_user`, id);
    });
    return { ok: true };
  });

  app.get('/roles', async () => {
    const rows = await q(`SELECT r.user_kind, r.user_id, r.role, r.created_at, COALESCE(b.full_name, g.display_name) AS name, COALESCE(b.email, g.email) AS email
      FROM user_roles r LEFT JOIN bank_users b ON r.user_kind = 'bank' AND b.id = r.user_id LEFT JOIN gov_users g ON r.user_kind = 'gov' AND g.id = r.user_id ORDER BY r.role, name`);
    return { roles: rows, available: ROLES };
  });

  app.post('/roles', async (req) => {
    const { kind, user_id: userId, role, grant } = req.body || {};
    if (!ROLES[role] || !ROLES[role].includes(kind)) throw bad('invalid_role', 'Эту роль нельзя выдать такому аккаунту');
    const id = int(userId, 'пользователь');
    if (!grant && role === 'admin' && kind === req.actor.kind && id === req.actor.id) throw bad('self', 'Нельзя снять админа с самого себя');
    await tx(async (conn) => {
      if (grant) {
        await q('INSERT IGNORE INTO user_roles (user_kind, user_id, role, granted_by) VALUES (?, ?, ?, ?)', [kind, id, role, `${req.actor.kind}:${req.actor.id}`], conn);
        await notify(conn, kind, id, { title: `Назначена роль: ${role}` });
      } else {
        await q('DELETE FROM user_roles WHERE user_kind = ? AND user_id = ? AND role = ?', [kind, id, role], conn);
      }
      await audit(conn, actor(req), grant ? 'admin.role_grant' : 'admin.role_revoke', `${kind}_user`, id, { role });
    });
    return { ok: true };
  });

  // ——— Очередь заявок ———
  app.get('/queue', async () => {
    const bank = await q("SELECT * FROM bank_users WHERE status = 'pending' ORDER BY id");
    const apps = await q("SELECT a.*, g.email, g.display_name FROM applications a JOIN gov_users g ON g.id = a.gov_user_id WHERE a.status = 'pending' ORDER BY a.id");
    return {
      bank_registrations: bank.map((u) => ({ ...publicBankUser(u), created_at: u.created_at })),
      applications: apps.map((a) => ({ id: a.id, type: a.type, data: json(a.data, {}), created_at: a.created_at, email: a.email, display_name: a.display_name })),
    };
  });

  // ——— Счета, карты, эмиссия, операции ———
  app.get('/accounts', async (req) => {
    const term = String(req.query.q || '').trim();
    const like = `%${term}%`;
    const rows = await q(`SELECT a.*, u.full_name FROM accounts a LEFT JOIN bank_users u ON a.owner_kind = 'bank_user' AND u.id = a.owner_id
      WHERE (? = '' OR a.number LIKE ? OR a.name LIKE ? OR u.full_name LIKE ?) ORDER BY a.owner_kind = 'system' DESC, a.id DESC LIMIT 200`, [term, like, like, like]);
    return { accounts: rows.map((a) => ({ ...accountView(a), owner_kind: a.owner_kind, owner_id: a.owner_id, owner_name: a.full_name, system_code: a.system_code })) };
  });

  app.get('/accounts/:id', async (req) => {
    const a = await one('SELECT a.*, u.full_name FROM accounts a LEFT JOIN bank_users u ON a.owner_kind = \'bank_user\' AND u.id = a.owner_id WHERE a.id = ?', [int(req.params.id, 'id')]);
    if (!a) throw notFound();
    const history = await q('SELECT e.amount, e.balance_after, t.id AS tx_id, t.kind, t.memo, t.created_at, t.reversed_by, t.reversal_of FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id WHERE e.account_id = ? ORDER BY e.id DESC LIMIT 200', [a.id]);
    return { account: { ...accountView(a), owner_kind: a.owner_kind, owner_id: a.owner_id, owner_name: a.full_name, system_code: a.system_code, ledger_balance: await recomputeBalance(a.id) }, history: history.map((h) => ({ ...h, amount: Number(h.amount), balance_after: Number(h.balance_after) })) };
  });

  app.post('/accounts/:id/status', async (req) => {
    const status = String(req.body?.status || '');
    if (!['active', 'frozen', 'arrested'].includes(status)) throw bad('invalid', 'Статус: active, frozen, arrested');
    await tx(async (conn) => {
      const a = await one("SELECT * FROM accounts WHERE id = ? AND owner_kind = 'bank_user'", [int(req.params.id, 'id')], conn);
      if (!a) throw notFound();
      await q('UPDATE accounts SET status = ? WHERE id = ?', [status, a.id], conn);
      const title = { active: 'Счёт разблокирован', frozen: 'Счёт заморожен банком', arrested: 'На счёт наложен арест' }[status];
      await notify(conn, 'bank', a.owner_id, { title, body: `${a.name} ${a.number}`, email: status !== 'active' });
      await audit(conn, actor(req), `admin.account_${status}`, 'account', a.id);
    });
    return { ok: true };
  });

  app.get('/cards', async (req) => {
    const term = String(req.query.q || '').replace(/\s/g, '');
    const rows = await q("SELECT c.*, u.full_name FROM cards c JOIN bank_users u ON u.id = c.bank_user_id WHERE (? = '' OR c.number LIKE ? OR u.full_name LIKE ?) ORDER BY c.id DESC LIMIT 200", [term, `%${term}%`, `%${req.query.q || ''}%`]);
    return { cards: rows.map((c) => ({ ...cardView(c), owner_name: c.full_name, bank_user_id: c.bank_user_id })) };
  });

  app.post('/cards/:id/status', async (req) => {
    const status = String(req.body?.status || '');
    if (!['active', 'frozen', 'blocked'].includes(status)) throw bad('invalid', 'Статус: active, frozen, blocked');
    const c = await one('SELECT * FROM cards WHERE id = ?', [int(req.params.id, 'id')]);
    if (!c) throw notFound();
    await q('UPDATE cards SET status = ?, pin_fail = 0, locked_until = NULL WHERE id = ?', [status, c.id]);
    await audit(null, actor(req), `admin.card_${status}`, 'card', c.id);
    return { ok: true };
  });

  // Эмиссия: выпуск (amount > 0) или изъятие (amount < 0). Каждая проводка — в журнале.
  app.post('/emission', async (req) => {
    const b = req.body || {};
    const amount = int(b.amount, 'сумма', { min: -1e13, max: 1e13 });
    need(amount !== 0, 'Сумма не может быть нулём');
    const memo = str(b.memo, 'основание', { min: 2, max: 200 });
    const r = await tx(async (conn) => {
      const acc = await one('SELECT * FROM accounts WHERE id = ? OR number = ?', [Number(b.account_id) || 0, String(b.account_number || '').toUpperCase()], conn);
      if (!acc) throw notFound('Счёт не найден');
      if (acc.system_code === 'EMISSION') throw bad('invalid', 'Нельзя эмитировать на счёт эмиссии');
      const res = await post(conn, {
        kind: 'emission',
        memo,
        entries: [{ account: await sys('EMISSION', conn), amount: -amount }, { account: acc.id, amount }],
        actor: actor(req),
        force: true,
        idem: b.idem ? `admin:emission:${String(b.idem).slice(0, 60)}` : null,
      });
      if (acc.owner_kind === 'bank_user') await notify(conn, 'bank', acc.owner_id, { title: `${amount > 0 ? 'Зачисление' : 'Списание'} ${formatMoney(Math.abs(amount))}`, body: memo });
      await audit(conn, actor(req), 'admin.emission', 'account', acc.id, { amount, memo, tx: res.id });
      return res;
    });
    return { ok: true, tx: r.id };
  });

  app.get('/emission', async () => {
    const rows = await q(`SELECT t.id, t.memo, t.created_at, t.actor_kind, t.actor_id, t.reversed_by, e.amount, a.number, a.name, u.full_name
      FROM ledger_tx t JOIN ledger_entries e ON e.tx_id = t.id AND e.account_id <> (SELECT id FROM accounts WHERE system_code = 'EMISSION')
      JOIN accounts a ON a.id = e.account_id LEFT JOIN bank_users u ON a.owner_kind = 'bank_user' AND u.id = a.owner_id
      WHERE t.kind IN ('emission','start_balance') ORDER BY t.id DESC LIMIT 300`);
    return { journal: rows.map((r) => ({ ...r, amount: Number(r.amount) })), emitted: -Number((await one("SELECT balance FROM accounts WHERE system_code = 'EMISSION'")).balance) };
  });

  app.get('/tx', async (req) => {
    const kind = String(req.query.kind || '');
    const before = req.query.before ? int(req.query.before, 'before') : Number.MAX_SAFE_INTEGER;
    const rows = await q(`SELECT * FROM ledger_tx WHERE id < ? AND (? = '' OR kind = ?) ORDER BY id DESC LIMIT 100`, [before, kind, kind]);
    const ids = rows.map((r) => r.id);
    const entries = ids.length
      ? await q(`SELECT e.tx_id, e.account_id, e.amount, a.number, a.name, a.owner_kind, u.full_name FROM ledger_entries e JOIN accounts a ON a.id = e.account_id LEFT JOIN bank_users u ON a.owner_kind = 'bank_user' AND u.id = a.owner_id WHERE e.tx_id IN (${ids.map(() => '?').join(',')})`, ids)
      : [];
    return {
      tx: rows.map((t) => ({ id: t.id, kind: t.kind, memo: t.memo, created_at: t.created_at, reversed_by: t.reversed_by, reversal_of: t.reversal_of, actor: t.actor_kind ? `${t.actor_kind}:${t.actor_id}` : null, entries: entries.filter((e) => e.tx_id === t.id).map((e) => ({ ...e, amount: Number(e.amount) })) })),
    };
  });

  app.post('/tx/:id/reverse', async (req) => {
    const r = await tx(async (conn) => {
      const res = await reverse(conn, int(req.params.id, 'id'), { actor: actor(req), memo: req.body?.memo ? String(req.body.memo).slice(0, 200) : undefined });
      await audit(conn, actor(req), 'admin.tx_reverse', 'tx', Number(req.params.id), { reversal: res.id });
      return res;
    });
    return { ok: true, tx: r.id };
  });

  // ——— Касса ———
  app.get('/shops', async () => {
    const rows = await q(`SELECT s.id, s.name, s.type, s.color, s.status, s.inn, s.ip_number, s.created_at, u.full_name AS owner, a.balance,
      (SELECT COUNT(*) FROM sales x WHERE x.shop_id = s.id AND x.status = 'paid') AS sales, (SELECT COALESCE(SUM(total),0) FROM sales x WHERE x.shop_id = s.id AND x.status = 'paid') AS revenue
      FROM shops s JOIN bank_users u ON u.id = s.owner_id JOIN accounts a ON a.id = s.account_id ORDER BY s.id DESC`);
    return { shops: rows.map((s) => ({ ...s, balance: Number(s.balance), revenue: Number(s.revenue) })) };
  });

  app.post('/shops/:id/status', async (req) => {
    const status = req.body?.status === 'closed' ? 'closed' : 'active';
    await q('UPDATE shops SET status = ? WHERE id = ?', [status, int(req.params.id, 'id')]);
    await audit(null, actor(req), `admin.shop_${status}`, 'shop', Number(req.params.id));
    return { ok: true };
  });

  // ——— Услуги: реестр, документы ———
  app.get('/citizens', async (req) => {
    const term = `%${String(req.query.q || '').trim()}%`;
    const rows = await q(`SELECT c.id, c.gov_user_id, c.full_name, c.birth_date, c.passport_no, c.address, c.marital_status, p.status AS passport_status, g.email
      FROM citizens c JOIN gov_users g ON g.id = c.gov_user_id LEFT JOIN passports p ON p.number = c.passport_no
      WHERE c.full_name LIKE ? OR c.passport_no LIKE ? OR g.email LIKE ? ORDER BY c.full_name LIMIT 300`, [term, term, term]);
    return { citizens: rows };
  });

  app.post('/passports/:number/status', async (req) => {
    const status = req.body?.status === 'revoked' ? 'revoked' : 'active';
    const p = await one('SELECT p.*, c.gov_user_id FROM passports p JOIN citizens c ON c.id = p.citizen_id WHERE p.number = ?', [String(req.params.number).toUpperCase()]);
    if (!p) throw notFound();
    await tx(async (conn) => {
      await q('UPDATE passports SET status = ? WHERE id = ?', [status, p.id], conn);
      await notify(conn, 'gov', p.gov_user_id, { title: status === 'revoked' ? 'Паспорт аннулирован' : 'Паспорт восстановлен', body: p.number });
      await audit(conn, actor(req), `admin.passport_${status}`, 'passport', p.id);
    });
    return { ok: true };
  });

  app.post('/documents/:id/status', async (req) => {
    const status = ['active', 'revoked', 'closed'].includes(req.body?.status) ? req.body.status : null;
    need(status, 'Статус: active, revoked, closed');
    await q('UPDATE documents SET status = ? WHERE id = ?', [status, int(req.params.id, 'id')]);
    await audit(null, actor(req), `admin.document_${status}`, 'document', Number(req.params.id));
    return { ok: true };
  });

  app.get('/invoices', async () => {
    const rows = await q('SELECT i.*, g.email FROM invoices i LEFT JOIN gov_users g ON g.id = i.gov_user_id ORDER BY i.id DESC LIMIT 300');
    return { invoices: rows.map((i) => ({ ...i, amount: Number(i.amount) })) };
  });

  app.get('/audit', async () => {
    const rows = await q('SELECT * FROM audit_log ORDER BY id DESC LIMIT 300');
    return { log: rows.map((r) => ({ ...r, data: json(r.data, null) })) };
  });

  // ——— Система: экспорт / импорт / сброс ———
  app.get('/export', async (req, reply) => {
    const conn = await pool.getConnection();
    try {
      const out = { format: 'balesnolandia-export', version: 1, exported_at: new Date().toISOString(), tables: {} };
      for (const t of await tableNames(conn)) {
        const [rows] = await conn.query(`SELECT * FROM \`${t}\``);
        // Пароли почты и прочие секреты в файл экспорта не попадают.
        out.tables[t] = t === 'settings' ? rows.filter((r) => !SECRET_KEYS.includes(r.k)) : rows;
      }
      await audit(null, actor(req), 'admin.export');
      reply.header('Content-Disposition', `attachment; filename="balesnolandia-${new Date().toISOString().slice(0, 10)}.json"`);
      return out;
    } finally {
      conn.release();
    }
  });

  app.post('/import', { bodyLimit: 100 * 1024 * 1024 }, async (req) => {
    const data = req.body;
    if (!data || data.format !== 'balesnolandia-export' || typeof data.tables !== 'object') throw bad('invalid_file', 'Это не файл экспорта Балесноландии');
    const conn = await pool.getConnection();
    try {
      const known = new Set(await tableNames(conn));
      // JSON-колонки: при экспорте mysql2 отдаёт их разобранными, а строку — без кавычек.
      // При импорте такое значение надо снова превратить в JSON-текст, иначе MySQL его не примет.
      const [meta] = await conn.query("SELECT TABLE_NAME AS t, COLUMN_NAME AS c FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND DATA_TYPE = 'json'");
      const jsonCols = new Map();
      for (const m of meta) {
        if (!jsonCols.has(m.t)) jsonCols.set(m.t, new Set());
        jsonCols.get(m.t).add(m.c);
      }
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      await conn.beginTransaction();
      for (const t of known) await conn.query(`DELETE FROM \`${t}\``);
      for (const [t, rows] of Object.entries(data.tables)) {
        if (!known.has(t) || !Array.isArray(rows) || rows.length === 0) continue;
        const cols = Object.keys(rows[0]);
        const jsonSet = jsonCols.get(t);
        for (let i = 0; i < rows.length; i += 200) {
          const chunk = rows.slice(i, i + 200);
          const values = chunk.map((r) => cols.map((c) => {
            const v = r[c];
            if (v === null || v === undefined) return null;
            if (typeof v === 'object') return JSON.stringify(v);
            if (jsonSet?.has(c)) {
              if (typeof v === 'string') {
                try { JSON.parse(v); return v; } catch { return JSON.stringify(v); }
              }
              return JSON.stringify(v);
            }
            if (typeof v === 'string' && ISO_RE.test(v)) return new Date(v);
            return v;
          }));
          await conn.query(`INSERT INTO \`${t}\` (${cols.map((c) => `\`${c}\``).join(',')}) VALUES ?`, [values]);
        }
      }
      await conn.commit();
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw bad('import_failed', `Импорт не удался: ${err.message}`);
    } finally {
      await conn.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {});
      conn.release();
    }
    clearSystemCache();
    resetSettingsCache();
    await audit(null, actor(req), 'admin.import');
    return { ok: true };
  });

  // Полный сброс игры. Админские аккаунты и их роли сохраняются, настройки — по желанию.
  app.post('/reset', async (req) => {
    if (req.body?.confirm !== 'СБРОС') throw bad('confirm', 'Для сброса введите слово СБРОС');
    const keepSettings = req.body?.keep_settings !== false;
    const conn = await pool.getConnection();
    try {
      const admins = (await q("SELECT user_kind, user_id FROM user_roles WHERE role = 'admin'", [], conn));
      const keepBank = admins.filter((a) => a.user_kind === 'bank').map((a) => a.user_id);
      const keepGov = admins.filter((a) => a.user_kind === 'gov').map((a) => a.user_id);
      await conn.query('SET FOREIGN_KEY_CHECKS = 0');
      await conn.beginTransaction();
      for (const t of await tableNames(conn)) {
        if (KEEP_ON_RESET.has(t) && (t !== 'settings' || keepSettings)) continue;
        if (t === 'bank_users') {
          await conn.query(`DELETE FROM bank_users${keepBank.length ? ` WHERE id NOT IN (${keepBank.join(',')})` : ''}`);
          await conn.query('UPDATE bank_users SET start_bonus_paid = 0, passport_verified = 0, passport_no = NULL, gov_user_id = NULL');
        } else if (t === 'gov_users') {
          await conn.query(`DELETE FROM gov_users${keepGov.length ? ` WHERE id NOT IN (${keepGov.join(',')})` : ''}`);
        } else if (t === 'user_roles') {
          await conn.query("DELETE FROM user_roles WHERE role <> 'admin'");
        } else {
          await conn.query(`DELETE FROM \`${t}\``);
        }
      }
      await conn.query("INSERT INTO accounts (number, owner_kind, type, name, allow_negative, system_code) VALUES ('BF00000000000001','system','system','Эмиссия',1,'EMISSION'),('BF00000000000002','system','system','Казна ВлодБанка',1,'TREASURY'),('BF00000000000003','system','system','Госбюджет БФ',1,'BUDGET'),('BF00000000000004','system','system','Наличные в обороте',1,'CASH'),('BF00000000000005','system','system','Оптовая база БФ',1,'WHOLESALE'),('BF00000000000006','system','system','Рекламные балансы ВлодПоиска',1,'ADS')");
      // Хостинг игроков: арендованные серверы и их адреса, сайты на серверах, тарифы хостеров.
      const rented = (await q('SELECT ip FROM hosting_servers WHERE org_id IS NOT NULL', [], conn)).map((r) => r.ip);
      await conn.query("DELETE FROM net_vhosts WHERE target LIKE 'site:%'");
      for (const ip of rented) {
        await conn.query('DELETE FROM net_hosts WHERE ip = ?', [ip]);
        await conn.query("DELETE FROM dns_records WHERE type = 'PTR' AND name = ?", [`${ip.split('.').reverse().join('.')}.in-addr.arpa.`]);
      }
      await conn.query('DELETE FROM hosting_plans WHERE org_id IS NOT NULL');
      await conn.query('DELETE FROM hosting_servers WHERE org_id IS NOT NULL');
      // DNS доменов игроков живёт в сохраняемых таблицах сети — убираем его отдельно.
      await conn.query('DELETE FROM dns_records WHERE domain_id IS NOT NULL');
      await conn.query('DELETE FROM dns_zones WHERE domain_id IS NOT NULL');
      await conn.query('UPDATE tlds SET registry_org_id = NULL');
      await conn.query('INSERT INTO game_clock (id, month_index, last_tick_at, paused) VALUES (1, 0, NOW(3), 0)');
      await conn.query('INSERT INTO price_index (month, rate_bp, index_ppm) VALUES (0, 0, 1000000)');
      await conn.commit();
      invalidateNet();
      flushResolverCache();
      resetPkiCache();
      resetSearch();
      closeAll();
      await fs.rm(config.sitesDir, { recursive: true, force: true }).catch(() => {});
    } catch (err) {
      await conn.rollback().catch(() => {});
      throw err;
    } finally {
      await conn.query('SET FOREIGN_KEY_CHECKS = 1').catch(() => {});
      conn.release();
    }
    clearSystemCache();
    resetSettingsCache();
    await audit(null, actor(req), 'admin.reset', null, null, { keep_settings: keepSettings });
    publish('clock', { type: 'reset' });
    return { ok: true };
  });
}
