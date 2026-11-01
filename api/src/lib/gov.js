// Логика ВлодУслуг: заявления, выдача паспорта и документов, квитанции.
import { q, one, json } from '../db.js';
import { bad, notFound } from './errors.js';
import { getSettings } from './settings.js';
import { currentMonth } from './clock.js';
import { post, sys } from './ledger.js';
import { notify, notifyAdmins } from './notify.js';
import { newPassportNumber, newInvoiceNumber, newVerifyCode, randomDigits, withUnique } from './ids.js';
import { formatMoney } from '@bln/shared/money.js';

export const APP_TITLES = {
  passport: 'Паспорт БФ',
  inn: 'ИНН',
  ip: 'Регистрация ИП',
};

const FEE_KEY = { passport: 'fee_passport', inn: 'fee_inn', ip: 'fee_ip' };

export async function citizenOf(govUserId, conn) {
  return one('SELECT * FROM citizens WHERE gov_user_id = ?', [govUserId], conn);
}

export async function activePassport(citizenId, conn) {
  return one("SELECT * FROM passports WHERE citizen_id = ? AND status = 'active'", [citizenId], conn);
}

export async function createInvoice(conn, { citizenId = null, govUserId = null, kind, purpose, amount, ref }) {
  return withUnique(async () => {
    const number = newInvoiceNumber();
    const res = await q(
      'INSERT INTO invoices (number, citizen_id, gov_user_id, kind, purpose, amount, ref_type, ref_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [number, citizenId, govUserId, kind, purpose, amount, ref?.type || null, ref?.id || null],
      conn,
    );
    return { id: res.insertId, number };
  });
}

/** Подать заявление. Если есть пошлина — сначала квитанция, потом рассмотрение. */
export async function submitApplication(conn, { govUserId, citizenId, type, data }) {
  const s = await getSettings();
  const fee = Number(s[FEE_KEY[type]] || 0);
  const res = await q('INSERT INTO applications (citizen_id, gov_user_id, type, status, data) VALUES (?, ?, ?, ?, ?)', [citizenId, govUserId, type, fee > 0 ? 'awaiting_payment' : 'pending', JSON.stringify(data || {})], conn);
  const appId = res.insertId;
  if (fee > 0) {
    const inv = await createInvoice(conn, { citizenId, govUserId, kind: 'fee', purpose: `Госпошлина: ${APP_TITLES[type] || type}`, amount: fee, ref: { type: 'application', id: appId } });
    await q('UPDATE applications SET invoice_id = ? WHERE id = ?', [inv.id, appId], conn);
    await notify(conn, 'gov', govUserId, { title: `Оплатите госпошлину ${formatMoney(fee)}`, body: `Квитанция ${inv.number}: ${APP_TITLES[type]}`, link: '#/invoices' });
    return one('SELECT * FROM applications WHERE id = ?', [appId], conn);
  }
  return processApplication(conn, appId);
}

function needsApproval(type, s) {
  return type === 'passport' && !!s.passport_approval;
}

/** Двигает заявление дальше: после оплаты — на рассмотрение или сразу выдача. */
export async function processApplication(conn, appId, { approvedBy = null } = {}) {
  const app = await one('SELECT * FROM applications WHERE id = ? FOR UPDATE', [appId], conn);
  if (!app) throw notFound('Заявление не найдено');
  const s = await getSettings();
  if (app.status === 'awaiting_payment') {
    const inv = app.invoice_id ? await one('SELECT status FROM invoices WHERE id = ?', [app.invoice_id], conn) : null;
    if (inv && inv.status !== 'paid') return app;
    await q("UPDATE applications SET status = 'pending' WHERE id = ?", [appId], conn);
    app.status = 'pending';
  }
  if (app.status !== 'pending') return app;
  if (needsApproval(app.type, s) && !approvedBy) {
    notifyAdmins('queue', { what: 'application', id: appId });
    return one('SELECT * FROM applications WHERE id = ?', [appId], conn);
  }
  const ref = await issueFor(conn, app);
  await q("UPDATE applications SET status = 'approved', result_ref = ?, decided_by = ?, decided_at = NOW(3) WHERE id = ?", [ref, approvedBy || 'auto', appId], conn);
  await notify(conn, 'gov', app.gov_user_id, { title: `Готово: ${APP_TITLES[app.type] || app.type}`, body: ref ? `Номер: ${ref}` : null, link: '#/', email: true });
  return one('SELECT * FROM applications WHERE id = ?', [appId], conn);
}

export async function rejectApplication(conn, appId, { by, comment }) {
  const app = await one('SELECT * FROM applications WHERE id = ? FOR UPDATE', [appId], conn);
  if (!app) throw notFound('Заявление не найдено');
  if (!['pending', 'awaiting_payment'].includes(app.status)) throw bad('invalid_state', 'Заявление уже рассмотрено');
  await q("UPDATE applications SET status = 'rejected', comment = ?, decided_by = ?, decided_at = NOW(3) WHERE id = ?", [comment || null, by, appId], conn);
  if (app.invoice_id) await q("UPDATE invoices SET status = 'cancelled' WHERE id = ? AND status = 'unpaid'", [app.invoice_id], conn);
  await notify(conn, 'gov', app.gov_user_id, { title: `Отказ: ${APP_TITLES[app.type] || app.type}`, body: comment || null, link: '#/applications' });
}

async function issueFor(conn, app) {
  const data = json(app.data, {});
  const month = await currentMonth(conn);
  const s = await getSettings();
  if (app.type === 'passport') {
    let citizen = await citizenOf(app.gov_user_id, conn);
    const fields = [data.full_name, data.birth_date, data.photo || null, data.address || null, data.marital_status || 'single', data.spouse_name || null, JSON.stringify(data.children || [])];
    if (!citizen) {
      const res = await q('INSERT INTO citizens (gov_user_id, full_name, birth_date, photo, address, marital_status, spouse_name, children) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [app.gov_user_id, ...fields], conn);
      citizen = await one('SELECT * FROM citizens WHERE id = ?', [res.insertId], conn);
    } else {
      await q('UPDATE citizens SET full_name = ?, birth_date = ?, photo = COALESCE(?, photo), address = ?, marital_status = ?, spouse_name = ?, children = ? WHERE id = ?', [...fields, citizen.id], conn);
    }
    await q('UPDATE applications SET citizen_id = ? WHERE id = ?', [citizen.id, app.id], conn);
    const expires = s.passport_valid_months ? month + Number(s.passport_valid_months) : null;
    if (citizen.passport_no) {
      // Замена паспорта: номер сохраняется, обновляются данные и код проверки.
      await q("UPDATE passports SET status = 'active', verify_code = ?, issued_month = ?, expires_month = ?, issued_at = NOW(3) WHERE number = ?", [newVerifyCode(), month, expires, citizen.passport_no], conn);
      return citizen.passport_no;
    }
    const number = await withUnique(async () => {
      const n = newPassportNumber();
      await q('INSERT INTO passports (citizen_id, number, verify_code, issued_month, expires_month) VALUES (?, ?, ?, ?, ?)', [citizen.id, n, newVerifyCode(), month, expires], conn);
      return n;
    });
    await q('UPDATE citizens SET passport_no = ? WHERE id = ?', [number, citizen.id], conn);
    return number;
  }
  const citizen = await citizenOf(app.gov_user_id, conn);
  if (!citizen) throw bad('no_passport', 'Сначала получите паспорт БФ');
  if (app.type === 'inn') {
    return withUnique(async () => {
      const n = randomDigits(10);
      await q("INSERT INTO documents (citizen_id, type, number, verify_code, issued_month, data) VALUES (?, 'inn', ?, ?, ?, ?)", [citizen.id, n, newVerifyCode(), month, JSON.stringify({ full_name: citizen.full_name })], conn);
      return n;
    });
  }
  if (app.type === 'ip') {
    const inn = await one("SELECT number FROM documents WHERE citizen_id = ? AND type = 'inn' AND status = 'active'", [citizen.id], conn);
    if (!inn) throw bad('no_inn', 'Для регистрации ИП нужен ИНН');
    return withUnique(async () => {
      const n = `IP${randomDigits(8)}`;
      await q("INSERT INTO documents (citizen_id, type, number, verify_code, issued_month, data) VALUES (?, 'ip', ?, ?, ?, ?)", [citizen.id, n, newVerifyCode(), month, JSON.stringify({ full_name: citizen.full_name, inn: inn.number, trade_name: data.trade_name || null, activity: data.activity || null })], conn);
      return n;
    });
  }
  throw bad('unknown_type', 'Неизвестный тип заявления');
}

/**
 * Оплатить квитанцию. via: 'bank' — со счёта клиента; 'cash' — на кассе магазина
 * (магазин принимает наличные как агент и перечисляет сумму со своего бизнес-счёта).
 */
export async function payInvoice(conn, number, { fromAccount, via, actor, idem }) {
  const inv = await one('SELECT * FROM invoices WHERE number = ? FOR UPDATE', [number], conn);
  if (!inv) throw notFound('Квитанция не найдена');
  if (inv.status === 'paid') throw bad('already_paid', 'Квитанция уже оплачена');
  if (inv.status === 'cancelled') throw bad('cancelled', 'Квитанция аннулирована');
  const r = await post(conn, {
    kind: via === 'cash' ? 'invoice_cash' : 'invoice',
    memo: `${inv.purpose} (${inv.number})`,
    entries: [{ account: fromAccount, amount: -Number(inv.amount) }, { account: await sys('BUDGET', conn), amount: Number(inv.amount) }],
    idem,
    actor,
    ref: { type: 'invoice', id: inv.id },
  });
  await q("UPDATE invoices SET status = 'paid', paid_tx_id = ?, paid_via = ?, paid_at = NOW(3) WHERE id = ?", [r.id, via, inv.id], conn);
  if (inv.gov_user_id) await notify(conn, 'gov', inv.gov_user_id, { title: 'Квитанция оплачена', body: `${inv.purpose}: ${formatMoney(inv.amount)}`, link: '#/invoices' });
  if (inv.ref_type === 'application') await processApplication(conn, inv.ref_id);
  return { invoice: { ...inv, status: 'paid' }, tx: r.id };
}

export function publicInvoice(inv) {
  return { number: inv.number, kind: inv.kind, purpose: inv.purpose, amount: Number(inv.amount), status: inv.status, created_at: inv.created_at, paid_at: inv.paid_at, paid_via: inv.paid_via };
}
