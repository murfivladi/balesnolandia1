import { tx, q, one, json } from '../db.js';
import { bad, notFound, str, need, int } from '../lib/errors.js';
import { needGov, needRole, actorOf } from '../lib/auth.js';
import { citizenOf, activePassport, submitApplication, processApplication, rejectApplication, publicInvoice, APP_TITLES, hasTravelBan } from '../lib/gov.js';
import { notify } from '../lib/notify.js';
import { audit } from '../lib/audit.js';
import { currentMonth } from '../lib/clock.js';
import { ageFrom } from '@bln/shared/format.js';

const MARITAL = ['single', 'married', 'divorced', 'widowed'];
const MAX_PHOTO = 400_000; // ~300 КБ JPEG в data URL

function passportForm(b) {
  const full_name = str(b.full_name, 'ФИО', { min: 3, max: 120 });
  const birth_date = str(b.birth_date, 'дата рождения', { max: 10 });
  need(/^\d{4}-\d{2}-\d{2}$/.test(birth_date) && !Number.isNaN(Date.parse(birth_date)), 'Неверная дата рождения');
  const photo = b.photo ? String(b.photo) : null;
  if (photo) need(/^data:image\/(jpeg|png|webp);base64,/.test(photo) && photo.length < MAX_PHOTO, 'Фото: JPEG/PNG до 300 КБ');
  const marital_status = MARITAL.includes(b.marital_status) ? b.marital_status : 'single';
  const children = Array.isArray(b.children)
    ? b.children.slice(0, 12).map((c) => ({ name: String(c.name || '').slice(0, 80), birth_date: String(c.birth_date || '').slice(0, 10) })).filter((c) => c.name)
    : [];
  return {
    full_name,
    birth_date,
    photo,
    address: str(b.address, 'прописка', { optional: true, max: 200 }),
    marital_status,
    spouse_name: marital_status === 'married' ? str(b.spouse_name, 'супруг(а)', { optional: true, max: 120 }) : null,
    children,
  };
}

export function passportView(citizen, passport) {
  if (!citizen) return null;
  return {
    number: citizen.passport_no,
    full_name: citizen.full_name,
    birth_date: citizen.birth_date,
    photo: citizen.photo,
    address: citizen.address,
    marital_status: citizen.marital_status,
    spouse_name: citizen.spouse_name,
    children: json(citizen.children, []),
    status: passport?.status || null,
    verify_code: passport?.verify_code || null,
    issued_month: passport?.issued_month ?? null,
    expires_month: passport?.expires_month ?? null,
  };
}

function appView(a) {
  const data = json(a.data, {});
  if (data.photo) data.photo = '[фото]';
  return { id: a.id, type: a.type, title: APP_TITLES[a.type] || a.type, status: a.status, data, result_ref: a.result_ref, comment: a.comment, created_at: a.created_at, decided_at: a.decided_at, invoice_id: a.invoice_id };
}

export async function govRoutes(app) {
  const auth = { preHandler: needGov() };

  app.get('/me', auth, async (req) => {
    const citizen = await citizenOf(req.gov.id);
    const passport = citizen ? await activePassport(citizen.id) : null;
    const documents = citizen ? await q('SELECT id, type, number, status, data, verify_code, issued_month, expires_month FROM documents WHERE citizen_id = ? ORDER BY id', [citizen.id]) : [];
    const applications = await q('SELECT * FROM applications WHERE gov_user_id = ? ORDER BY id DESC LIMIT 30', [req.gov.id]);
    const invoices = await q("SELECT * FROM invoices WHERE gov_user_id = ? AND status <> 'cancelled' ORDER BY id DESC LIMIT 50", [req.gov.id]);
    const links = citizen ? await q("SELECT l.id, l.created_at, b.email, b.full_name FROM passport_links l JOIN bank_users b ON b.id = l.bank_user_id WHERE l.citizen_id = ? AND l.status = 'pending'", [citizen.id]) : [];
    return {
      passport: passportView(citizen, passport),
      documents: documents.map((d) => ({ ...d, data: json(d.data, {}) })),
      applications: applications.map(appView),
      invoices: invoices.map(publicInvoice),
      links,
      month: await currentMonth(),
    };
  });

  // Паспорт: первичная выдача или замена (обновление данных, фото).
  app.post('/passport', auth, async (req) => {
    const data = passportForm(req.body || {});
    const result = await tx(async (conn) => {
      const pending = await one("SELECT id FROM applications WHERE gov_user_id = ? AND type = 'passport' AND status IN ('pending','awaiting_payment')", [req.gov.id], conn);
      if (pending) throw bad('already_pending', 'Заявление на паспорт уже на рассмотрении');
      const citizen = await citizenOf(req.gov.id, conn);
      const a = await submitApplication(conn, { govUserId: req.gov.id, citizenId: citizen?.id || null, type: 'passport', data });
      await audit(conn, actorOf(req.gov), 'gov.passport_apply', 'application', a.id);
      return a;
    });
    return { application: appView(result) };
  });

  app.get('/passport', auth, async (req) => {
    const citizen = await citizenOf(req.gov.id);
    if (!citizen) return { passport: null };
    return { passport: passportView(citizen, await activePassport(citizen.id)) };
  });

  app.get('/documents', auth, async (req) => {
    const citizen = await citizenOf(req.gov.id);
    if (!citizen) return { documents: [] };
    const docs = await q('SELECT * FROM documents WHERE citizen_id = ? ORDER BY id', [citizen.id]);
    return { documents: docs.map((d) => ({ ...d, data: json(d.data, {}) })) };
  });

  app.post('/documents/:type', auth, async (req) => {
    const type = req.params.type;
    if (!['inn', 'ip', 'driver', 'foreign_passport', 'visa', 'marriage', 'birth'].includes(type)) throw bad('unknown_type', 'Неизвестный документ');
    const b = req.body || {};
    const result = await tx(async (conn) => {
      const citizen = await citizenOf(req.gov.id, conn);
      if (!citizen || !(await activePassport(citizen.id, conn))) throw bad('no_passport', 'Сначала получите паспорт БФ');
      if (['inn', 'ip', 'driver', 'foreign_passport'].includes(type)) {
        const have = await one("SELECT id FROM documents WHERE citizen_id = ? AND type = ? AND status = 'active'", [citizen.id, type], conn);
        if (have) throw bad('already_have', 'Документ уже выдан');
      }
      const pending = await one("SELECT id FROM applications WHERE gov_user_id = ? AND type = ? AND status IN ('pending','awaiting_payment')", [req.gov.id, type], conn);
      if (pending) throw bad('already_pending', 'Заявление уже подано');
      let data = {};
      let fee = null;
      if (type === 'ip') {
        const inn = await one("SELECT id FROM documents WHERE citizen_id = ? AND type = 'inn' AND status = 'active'", [citizen.id], conn);
        if (!inn) throw bad('no_inn', 'Для регистрации ИП нужен ИНН');
        data = {
          trade_name: str(b.trade_name, 'название', { min: 2, max: 80 }),
          activity: str(b.activity, 'вид деятельности', { optional: true, max: 120 }),
        };
      }
      if (type === 'driver') {
        if (ageFrom(citizen.birth_date) < 16) throw bad('too_young', 'Права выдаются с 16 лет');
        data = { categories: ['A', 'B', 'C', 'AB', 'BC'].includes(b.categories) ? b.categories : 'B' };
      }
      if (type === 'foreign_passport' || type === 'visa') {
        if (await hasTravelBan(conn, citizen.id)) throw bad('travel_ban', 'Действует запрет выезда за неуплату');
      }
      if (type === 'visa') {
        const fp = await one("SELECT id FROM documents WHERE citizen_id = ? AND type = 'foreign_passport' AND status = 'active'", [citizen.id], conn);
        if (!fp) throw bad('no_foreign_passport', 'Сначала получите загранпаспорт');
        const c = await one('SELECT * FROM countries WHERE id = ? AND active = 1', [int(b.country_id, 'страна')], conn);
        if (!c) throw notFound('Страна не найдена');
        if (!c.visa_required) throw bad('visa_free', `В ${c.name} виза не нужна`);
        const month = await currentMonth(conn);
        const has = await one("SELECT id FROM documents WHERE citizen_id = ? AND type = 'visa' AND status = 'active' AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.country_code')) = ? AND (expires_month IS NULL OR expires_month >= ?)", [citizen.id, c.code, month], conn);
        if (has) throw bad('already_have', 'Виза в эту страну уже действует');
        data = { country_id: c.id, country: c.name };
        fee = Number(c.visa_fee);
      }
      if (type === 'marriage') {
        if (citizen.marital_status === 'married') throw bad('already_married', 'Вы уже состоите в браке');
        const sp = String(b.spouse_passport || '').trim().toUpperCase();
        const spouse = await one('SELECT id, full_name, marital_status FROM citizens WHERE passport_no = ?', [sp], conn);
        if (!spouse || spouse.id === citizen.id) throw notFound('Паспорт супруга(и) не найден');
        if (spouse.marital_status === 'married') throw bad('spouse_married', 'Этот человек уже состоит в браке');
        data = { spouse_passport: sp, spouse_name: spouse.full_name };
      }
      if (type === 'birth') {
        const d = str(b.child_birth_date, 'дата рождения', { max: 10 });
        need(/^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)), 'Неверная дата рождения');
        data = { child_name: str(b.child_name, 'имя ребёнка', { min: 2, max: 80 }), child_birth_date: d };
      }
      const a = await submitApplication(conn, { govUserId: req.gov.id, citizenId: citizen.id, type, data, fee });
      await audit(conn, actorOf(req.gov), `gov.${type}_apply`, 'application', a.id);
      return a;
    });
    return { application: appView(result) };
  });

  app.get('/applications', auth, async (req) => {
    const rows = await q('SELECT * FROM applications WHERE gov_user_id = ? ORDER BY id DESC LIMIT 100', [req.gov.id]);
    return { applications: rows.map(appView) };
  });

  app.post('/applications/:id/cancel', auth, async (req) => {
    await tx(async (conn) => {
      const a = await one('SELECT * FROM applications WHERE id = ? AND gov_user_id = ? FOR UPDATE', [req.params.id, req.gov.id], conn);
      if (!a) throw notFound();
      if (!['pending', 'awaiting_payment'].includes(a.status)) throw bad('invalid_state', 'Заявление уже рассмотрено');
      await q("UPDATE applications SET status = 'cancelled' WHERE id = ?", [a.id], conn);
      if (a.invoice_id) await q("UPDATE invoices SET status = 'cancelled' WHERE id = ? AND status = 'unpaid'", [a.invoice_id], conn);
    });
    return { ok: true };
  });

  app.get('/invoices', auth, async (req) => {
    const rows = await q("SELECT * FROM invoices WHERE gov_user_id = ? AND status <> 'cancelled' ORDER BY id DESC LIMIT 100", [req.gov.id]);
    return { invoices: rows.map(publicInvoice) };
  });

  // Публично по номеру: для оплаты в банке и на кассе.
  app.get('/invoices/:no', async (req) => {
    const inv = await one('SELECT i.*, c.full_name FROM invoices i LEFT JOIN citizens c ON c.id = i.citizen_id WHERE i.number = ?', [String(req.params.no).toUpperCase()]);
    if (!inv) throw notFound('Квитанция не найдена');
    const name = inv.full_name ? inv.full_name.split(' ').map((p, i) => (i === 0 ? p : p[0] + '.')).join(' ') : null;
    return { invoice: { ...publicInvoice(inv), payer: name } };
  });

  // Связка аккаунта ВлодБанка с паспортом.
  app.get('/links', auth, async (req) => {
    const citizen = await citizenOf(req.gov.id);
    if (!citizen) return { links: [], linked: [] };
    const links = await q("SELECT l.id, l.created_at, b.email, b.full_name FROM passport_links l JOIN bank_users b ON b.id = l.bank_user_id WHERE l.citizen_id = ? AND l.status = 'pending'", [citizen.id]);
    const linked = await q('SELECT id, email, full_name FROM bank_users WHERE passport_no = ? AND passport_verified = 1', [citizen.passport_no]);
    return { links, linked };
  });

  app.post('/links/:id/:decision', auth, async (req) => {
    const decision = req.params.decision;
    if (!['confirm', 'reject'].includes(decision)) throw bad('invalid', 'confirm | reject');
    await tx(async (conn) => {
      const citizen = await citizenOf(req.gov.id, conn);
      const link = citizen && (await one("SELECT * FROM passport_links WHERE id = ? AND citizen_id = ? AND status = 'pending' FOR UPDATE", [req.params.id, citizen.id], conn));
      if (!link) throw notFound('Запрос не найден');
      if (decision === 'confirm') {
        const other = await one('SELECT id FROM bank_users WHERE passport_no = ? AND passport_verified = 1 AND id <> ?', [citizen.passport_no, link.bank_user_id], conn);
        if (other) throw bad('passport_taken', 'К паспорту уже привязан другой аккаунт ВлодБанка');
        await q('UPDATE bank_users SET passport_no = ?, passport_verified = 1, gov_user_id = ?, full_name = ?, birth_date = ? WHERE id = ?', [citizen.passport_no, req.gov.id, citizen.full_name, citizen.birth_date, link.bank_user_id], conn);
      }
      await q('UPDATE passport_links SET status = ?, decided_at = NOW(3) WHERE id = ?', [decision === 'confirm' ? 'confirmed' : 'rejected', link.id], conn);
      await notify(conn, 'bank', link.bank_user_id, {
        title: decision === 'confirm' ? 'Паспорт подтверждён' : 'Паспорт не подтверждён',
        body: decision === 'confirm' ? 'Теперь можно открывать счета и карты' : 'Владелец паспорта отклонил запрос',
        link: '#/',
      });
      await audit(conn, actorOf(req.gov), `gov.link_${decision}`, 'bank_user', link.bank_user_id);
    });
    return { ok: true };
  });

  // ——— Проверка документов по QR (публично) ———
  app.get('/verify/passport/:code', async (req) => {
    const p = await one('SELECT p.*, c.full_name, c.birth_date, c.photo FROM passports p JOIN citizens c ON c.id = p.citizen_id WHERE p.verify_code = ?', [req.params.code]);
    if (!p) return { valid: false };
    const month = await currentMonth();
    const expired = p.expires_month !== null && p.expires_month < month;
    return {
      valid: p.status === 'active' && !expired,
      status: expired ? 'expired' : p.status,
      number: p.number,
      full_name: p.full_name,
      birth_date: p.birth_date,
      age: ageFrom(p.birth_date),
      photo: p.photo,
    };
  });

  app.get('/verify/document/:code', async (req) => {
    const d = await one('SELECT d.*, c.full_name FROM documents d JOIN citizens c ON c.id = d.citizen_id WHERE d.verify_code = ?', [req.params.code]);
    if (!d) return { valid: false };
    return { valid: d.status === 'active', type: d.type, number: d.number, status: d.status, full_name: d.full_name, data: json(d.data, {}), issued_month: d.issued_month };
  });

  app.get('/verify/receipt/:code', async (req) => {
    const s = await one('SELECT s.*, sh.name AS shop_name, sh.inn, sh.address FROM sales s JOIN shops sh ON sh.id = s.shop_id WHERE s.verify_code = ?', [req.params.code]);
    if (!s || s.status !== 'paid') return { valid: false };
    const items = await q('SELECT name, unit, qty_milli, price, total FROM sale_items WHERE sale_id = ?', [s.id]);
    return {
      valid: true,
      shop: { name: s.shop_name, inn: s.inn, address: s.address },
      number: s.number,
      total: Number(s.total),
      vat: Number(s.vat),
      refunded: Number(s.refunded),
      paid_at: s.paid_at,
      items,
    };
  });

  // ——— Рассмотрение заявлений (чиновник / админ) ———
  const official = { preHandler: needRole('official') };

  app.get('/queue', official, async () => {
    const rows = await q("SELECT a.*, g.email, g.display_name FROM applications a JOIN gov_users g ON g.id = a.gov_user_id WHERE a.status = 'pending' ORDER BY a.id");
    return { applications: rows.map((a) => ({ ...appView(a), email: a.email, display_name: a.display_name, photo: json(a.data, {}).photo || null })) };
  });

  app.post('/applications/:id/approve', official, async (req) => {
    const a = await tx(async (conn) => {
      const by = `${req.actor.kind}:${req.actor.id}`;
      const res = await processApplication(conn, int(req.params.id, 'id'), { approvedBy: by });
      await audit(conn, actorOf(req.actor), 'gov.application_approve', 'application', res.id);
      return res;
    });
    return { application: appView(a) };
  });

  app.post('/applications/:id/reject', official, async (req) => {
    await tx(async (conn) => {
      await rejectApplication(conn, int(req.params.id, 'id'), { by: `${req.actor.kind}:${req.actor.id}`, comment: str(req.body?.comment, 'причина', { optional: true, max: 255 }) });
      await audit(conn, actorOf(req.actor), 'gov.application_reject', 'application', Number(req.params.id));
    });
    return { ok: true };
  });

  // Реестр граждан для сотрудников госорганов.
  app.get('/citizens', official, async (req) => {
    const term = `%${String(req.query.q || '').trim()}%`;
    const rows = await q('SELECT c.id, c.full_name, c.birth_date, c.passport_no, c.address, g.email FROM citizens c JOIN gov_users g ON g.id = c.gov_user_id WHERE c.full_name LIKE ? OR c.passport_no LIKE ? OR g.email LIKE ? ORDER BY c.full_name LIMIT 100', [term, term, term]);
    return { citizens: rows };
  });

  app.get('/citizens/:id', official, async (req) => {
    const c = await one('SELECT * FROM citizens WHERE id = ?', [req.params.id]);
    if (!c) throw notFound();
    const docs = await q('SELECT * FROM documents WHERE citizen_id = ?', [c.id]);
    return { passport: passportView(c, await activePassport(c.id)), documents: docs.map((d) => ({ ...d, data: json(d.data, {}) })) };
  });

}
