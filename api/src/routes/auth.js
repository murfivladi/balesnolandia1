import { tx, one, q } from '../db.js';
import { bad, unauthorized, forbidden, email as emailOf, str, need } from '../lib/errors.js';
import { hash, verifyHash, issue, clear, session, ensureBootstrapAdmin, rolesOf, posSession, actorOf } from '../lib/auth.js';
import { sendCode, checkCode } from '../lib/codes.js';
import { getSettings } from '../lib/settings.js';
import { notify, notifyAdmins } from '../lib/notify.js';
import { audit } from '../lib/audit.js';
import { normalizePassport } from '@bln/shared/format.js';

const limited = (max = 10) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });
const TABLE = { bank: 'bank_users', gov: 'gov_users' };

export function publicBankUser(u, roles = []) {
  return {
    id: u.id,
    email: u.email,
    full_name: u.full_name,
    birth_date: u.birth_date,
    passport_no: u.passport_no,
    passport_verified: !!u.passport_verified,
    gov_linked: !!u.gov_user_id,
    status: u.status,
    lang: u.lang,
    roles,
  };
}

export function publicGovUser(u, roles = []) {
  return { id: u.id, email: u.email, display_name: u.display_name, status: u.status, lang: u.lang, roles };
}

function kindParam(req) {
  const k = req.params.kind;
  if (k !== 'bank' && k !== 'gov') throw bad('invalid', 'Неизвестный сервис');
  return k;
}

function checkPassword(p) {
  const s = str(p, 'пароль', { min: 8, max: 100 });
  return s;
}

/** Запрос связки банковского аккаунта с паспортом: подтверждает владелец паспорта во ВлодУслугах. */
export async function requestPassportLink(conn, bankUser, passportNo) {
  const citizen = await one("SELECT c.* FROM citizens c JOIN passports p ON p.number = c.passport_no AND p.status = 'active' WHERE c.passport_no = ?", [passportNo], conn);
  if (!citizen) throw bad('passport_not_found', 'Паспорт БФ с таким номером не найден');
  await q("UPDATE passport_links SET status = 'rejected', decided_at = NOW(3) WHERE bank_user_id = ? AND status = 'pending'", [bankUser.id], conn);
  await q('INSERT INTO passport_links (bank_user_id, citizen_id) VALUES (?, ?)', [bankUser.id, citizen.id], conn);
  await q('UPDATE bank_users SET passport_no = ?, passport_verified = 0 WHERE id = ?', [passportNo, bankUser.id], conn);
  await notify(conn, 'gov', citizen.gov_user_id, {
    title: 'Подтвердите связку с ВлодБанком',
    body: `Аккаунт ВлодБанка ${bankUser.email} указал ваш паспорт ${passportNo}`,
    link: '#/links',
    email: true,
  });
}

export async function authRoutes(app) {
  app.post('/auth/bank/register', limited(5), async (req, reply) => {
    const b = req.body || {};
    const email = emailOf(b.email);
    const password = b.password ? checkPassword(b.password) : null;
    const fullName = str(b.full_name, 'имя', { min: 2, max: 120 });
    const birth = str(b.birth_date, 'дата рождения', { max: 10 });
    need(/^\d{4}-\d{2}-\d{2}$/.test(birth), 'Неверная дата рождения');
    const passportNo = b.passport_no ? normalizePassport(b.passport_no) : null;
    if (b.passport_no) need(passportNo, 'Номер паспорта: BLN-XXXX-XXXX');
    const s = await getSettings();
    const user = await tx(async (conn) => {
      if (await one('SELECT id FROM bank_users WHERE email = ?', [email], conn)) throw bad('email_taken', 'Этот email уже зарегистрирован');
      const res = await q(
        'INSERT INTO bank_users (email, password_hash, full_name, birth_date, status, lang) VALUES (?, ?, ?, ?, ?, ?)',
        [email, password ? await hash(password) : null, fullName, birth, s.bank_registration_approval ? 'pending' : 'active', b.lang === 'it' ? 'it' : 'ru'],
        conn,
      );
      const u = await one('SELECT * FROM bank_users WHERE id = ?', [res.insertId], conn);
      if (passportNo) await requestPassportLink(conn, u, passportNo);
      await ensureBootstrapAdmin('bank', u, conn);
      await audit(conn, { kind: 'bank', id: u.id }, 'bank.register', 'bank_user', u.id);
      return u;
    });
    if (user.status === 'pending') notifyAdmins('queue', { what: 'bank_registration' });
    await issue(reply, 'bank', { id: user.id });
    return { user: publicBankUser(await one('SELECT * FROM bank_users WHERE id = ?', [user.id]), await rolesOf('bank', user.id)) };
  });

  app.post('/auth/gov/register', limited(5), async (req, reply) => {
    const b = req.body || {};
    const email = emailOf(b.email);
    const password = b.password ? checkPassword(b.password) : null;
    const name = str(b.display_name, 'имя', { min: 2, max: 120 });
    const user = await tx(async (conn) => {
      if (await one('SELECT id FROM gov_users WHERE email = ?', [email], conn)) throw bad('email_taken', 'Этот email уже зарегистрирован');
      const res = await q('INSERT INTO gov_users (email, password_hash, display_name, lang) VALUES (?, ?, ?, ?)', [email, password ? await hash(password) : null, name, b.lang === 'it' ? 'it' : 'ru'], conn);
      const u = await one('SELECT * FROM gov_users WHERE id = ?', [res.insertId], conn);
      await ensureBootstrapAdmin('gov', u, conn);
      await audit(conn, { kind: 'gov', id: u.id }, 'gov.register', 'gov_user', u.id);
      return u;
    });
    await issue(reply, 'gov', { id: user.id });
    return { user: publicGovUser(user, await rolesOf('gov', user.id)) };
  });

  app.post('/auth/:kind/login', limited(10), async (req, reply) => {
    const kind = kindParam(req);
    const email = emailOf(req.body?.email);
    const user = await one(`SELECT * FROM ${TABLE[kind]} WHERE email = ?`, [email]);
    const ok = user && (await verifyHash(String(req.body?.password || ''), user.password_hash));
    if (!ok) throw unauthorized('Неверный email или пароль');
    if (user.status === 'blocked') throw forbidden('Аккаунт заблокирован');
    if (user.status === 'rejected') throw forbidden('Регистрация отклонена');
    await ensureBootstrapAdmin(kind, user);
    await issue(reply, kind, { id: user.id });
    const roles = await rolesOf(kind, user.id);
    return { user: kind === 'bank' ? publicBankUser(user, roles) : publicGovUser(user, roles) };
  });

  app.post('/auth/:kind/code/send', limited(5), async (req) => {
    const kind = kindParam(req);
    const email = emailOf(req.body?.email);
    const user = await one(`SELECT id FROM ${TABLE[kind]} WHERE email = ?`, [email]);
    // Не раскрываем, есть ли аккаунт: ответ одинаковый.
    if (user) await sendCode(kind, email);
    return { ok: true };
  });

  app.post('/auth/:kind/code/verify', limited(10), async (req, reply) => {
    const kind = kindParam(req);
    const email = emailOf(req.body?.email);
    await checkCode(kind, email, req.body?.code);
    const user = await one(`SELECT * FROM ${TABLE[kind]} WHERE email = ?`, [email]);
    if (!user) throw unauthorized('Аккаунт не найден');
    if (user.status === 'blocked') throw forbidden('Аккаунт заблокирован');
    await ensureBootstrapAdmin(kind, user);
    await issue(reply, kind, { id: user.id });
    const roles = await rolesOf(kind, user.id);
    return { user: kind === 'bank' ? publicBankUser(user, roles) : publicGovUser(user, roles) };
  });

  app.post('/auth/:kind/logout', async (req, reply) => {
    const kind = req.params.kind;
    if (kind === 'bank' || kind === 'gov' || kind === 'pos') clear(reply, kind);
    if (kind === 'bank') clear(reply, 'pos');
    return { ok: true };
  });

  app.get('/auth/me', async (req) => {
    const [bank, gov, pos] = await Promise.all([session(req, 'bank'), session(req, 'gov'), posSession(req)]);
    return {
      bank: bank ? publicBankUser(bank.user, bank.roles) : null,
      gov: gov ? publicGovUser(gov.user, gov.roles) : null,
      pos: pos ? { shop_id: pos.shopId, staff_id: pos.staff.id, role: pos.staff.role } : null,
    };
  });

  app.post('/auth/:kind/password', limited(5), async (req) => {
    const kind = kindParam(req);
    const s = await session(req, kind);
    if (!s) throw unauthorized();
    const password = checkPassword(req.body?.password);
    if (s.user.password_hash && !(await verifyHash(String(req.body?.old_password || ''), s.user.password_hash))) {
      throw bad('wrong_password', 'Неверный текущий пароль');
    }
    await q(`UPDATE ${TABLE[kind]} SET password_hash = ? WHERE id = ?`, [await hash(password), s.id]);
    return { ok: true };
  });

  app.post('/auth/:kind/lang', async (req) => {
    const kind = kindParam(req);
    const s = await session(req, kind);
    if (s) await q(`UPDATE ${TABLE[kind]} SET lang = ? WHERE id = ?`, [req.body?.lang === 'it' ? 'it' : 'ru', s.id]);
    return { ok: true };
  });

  // «Войти через ВлодУслуги»: нужен вход во ВлодУслуги и действующий паспорт.
  app.post('/auth/bank/via-gov', limited(10), async (req, reply) => {
    const gov = await session(req, 'gov');
    if (!gov) throw unauthorized('Сначала войдите во ВлодУслуги');
    const citizen = await one("SELECT c.* FROM citizens c JOIN passports p ON p.number = c.passport_no AND p.status = 'active' WHERE c.gov_user_id = ?", [gov.id]);
    const user = await tx(async (conn) => {
      let u = await one('SELECT * FROM bank_users WHERE gov_user_id = ?', [gov.id], conn);
      if (u) return u;
      if (!citizen) throw bad('no_passport', 'Для входа через ВлодУслуги нужен паспорт БФ');
      const sameEmail = await one('SELECT * FROM bank_users WHERE email = ?', [gov.user.email], conn);
      if (sameEmail) throw bad('email_taken', 'Аккаунт ВлодБанка с этим email уже есть — войдите паролем и укажите паспорт');
      const samePassport = await one('SELECT id FROM bank_users WHERE passport_no = ? AND passport_verified = 1', [citizen.passport_no], conn);
      if (samePassport) throw bad('passport_taken', 'К этому паспорту уже привязан другой аккаунт ВлодБанка');
      const s = await getSettings();
      const birth = citizen.birth_date instanceof Date ? citizen.birth_date.toISOString().slice(0, 10) : citizen.birth_date;
      const res = await q(
        'INSERT INTO bank_users (email, full_name, birth_date, passport_no, passport_verified, gov_user_id, status, lang) VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
        [gov.user.email, citizen.full_name, birth, citizen.passport_no, gov.id, s.bank_registration_approval ? 'pending' : 'active', gov.user.lang],
        conn,
      );
      u = await one('SELECT * FROM bank_users WHERE id = ?', [res.insertId], conn);
      await ensureBootstrapAdmin('bank', u, conn);
      await audit(conn, actorOf(gov), 'bank.register_via_gov', 'bank_user', u.id);
      return u;
    });
    if (user.status === 'blocked' || user.status === 'rejected') throw forbidden('Аккаунт ВлодБанка недоступен');
    await issue(reply, 'bank', { id: user.id });
    return { user: publicBankUser(user, await rolesOf('bank', user.id)) };
  });
}
