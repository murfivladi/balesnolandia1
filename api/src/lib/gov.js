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
  driver: 'Водительские права',
  foreign_passport: 'Загранпаспорт',
  visa: 'Виза',
  marriage: 'Свидетельство о браке',
  birth: 'Свидетельство о рождении',
};

const FEE_KEY = { passport: 'fee_passport', inn: 'fee_inn', ip: 'fee_ip', driver: 'fee_driver', foreign_passport: 'fee_foreign_passport', marriage: 'fee_marriage', birth: 'fee_birth' };

// Что делать, когда оплачена квитанция определённого вида (штраф, налог, страховка…).
const invoiceHooks = new Map();
export function onInvoicePaid(refType, fn) {
  invoiceHooks.set(refType, [...(invoiceHooks.get(refType) || []), fn]);
}

/** Действующий запрет выезда гражданина. */
export async function hasTravelBan(conn, citizenId) {
  return !!(await one("SELECT id FROM citizen_sanctions WHERE citizen_id = ? AND kind = 'travel_ban' AND active = 1", [citizenId], conn));
}

export async function citizenOf(govUserId, conn) {
  return one('SELECT * FROM citizens WHERE gov_user_id = ?', [govUserId], conn);
}

export async function activePassport(citizenId, conn) {
  return one("SELECT * FROM passports WHERE citizen_id = ? AND status = 'active'", [citizenId], conn);
}

export async function createInvoice(conn, { citizenId = null, govUserId = null, kind, purpose, amount, ref, dueMonth = null }) {
  return withUnique(async () => {
    const number = newInvoiceNumber();
    const res = await q(
      'INSERT INTO invoices (number, citizen_id, gov_user_id, kind, purpose, amount, ref_type, ref_id, due_month) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [number, citizenId, govUserId, kind, purpose, amount, ref?.type || null, ref?.id || null, dueMonth],
      conn,
    );
    return { id: res.insertId, number };
  });
}

/** Подать заявление. Если есть пошлина — сначала квитанция, потом рассмотрение. */
export async function submitApplication(conn, { govUserId, citizenId, type, data, fee: feeOverride = null }) {
  const s = await getSettings();
  const fee = feeOverride !== null ? Number(feeOverride) : Number(s[FEE_KEY[type]] || 0);
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
  if (type === 'marriage' || type === 'birth') return true;
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
  return issueDocument(conn, { app, data, citizen, month, s });
}

/** Новый документ гражданина со сроком в игровых месяцах. */
async function addDocument(conn, { citizenId, type, prefix, digits = 8, month, expires = null, data }) {
  return withUnique(async () => {
    const n = `${prefix}${randomDigits(digits)}`;
    await q('INSERT INTO documents (citizen_id, type, number, verify_code, issued_month, expires_month, data) VALUES (?, ?, ?, ?, ?, ?, ?)', [citizenId, type, n, newVerifyCode(), month, expires, JSON.stringify(data)], conn);
    return n;
  });
}

async function issueDocument(conn, { app, data, citizen, month, s }) {
  const base = { full_name: citizen.full_name, birth_date: citizen.birth_date, passport: citizen.passport_no };
  if (app.type === 'driver') {
    await q("UPDATE documents SET status = 'closed' WHERE citizen_id = ? AND type = 'driver' AND status = 'active'", [citizen.id], conn);
    return addDocument(conn, { citizenId: citizen.id, type: 'driver', prefix: 'DL', month, expires: month + Number(s.driver_valid_months || 120), data: { ...base, categories: data.categories || 'B' } });
  }
  if (app.type === 'foreign_passport') {
    if (await hasTravelBan(conn, citizen.id)) throw bad('travel_ban', 'Запрет выезда: загранпаспорт не выдаётся');
    await q("UPDATE documents SET status = 'closed' WHERE citizen_id = ? AND type = 'foreign_passport' AND status = 'active'", [citizen.id], conn);
    return addDocument(conn, { citizenId: citizen.id, type: 'foreign_passport', prefix: 'FP', month, expires: month + Number(s.foreign_passport_months || 60), data: { ...base, photo: !!citizen.photo } });
  }
  if (app.type === 'visa') {
    if (await hasTravelBan(conn, citizen.id)) throw bad('travel_ban', 'Запрет выезда: виза не выдаётся');
    const fp = await one("SELECT number FROM documents WHERE citizen_id = ? AND type = 'foreign_passport' AND status = 'active'", [citizen.id], conn);
    if (!fp) throw bad('no_foreign_passport', 'Нужен загранпаспорт');
    const c = await one('SELECT * FROM countries WHERE id = ?', [data.country_id], conn);
    if (!c) throw bad('no_country', 'Страна не найдена');
    return addDocument(conn, { citizenId: citizen.id, type: 'visa', prefix: `V${c.code}`, digits: 6, month, expires: month + Number(c.visa_months || 6), data: { ...base, country: c.name, country_code: c.code, foreign_passport: fp.number } });
  }
  if (app.type === 'marriage') {
    const spouse = await one('SELECT * FROM citizens WHERE passport_no = ?', [data.spouse_passport], conn);
    if (!spouse) throw bad('no_spouse', 'Паспорт супруга(и) не найден');
    if (spouse.id === citizen.id) throw bad('invalid', 'Нельзя вступить в брак с собой');
    const number = await addDocument(conn, { citizenId: citizen.id, type: 'marriage', prefix: 'MR', month, data: { ...base, spouse: spouse.full_name, spouse_passport: spouse.passport_no } });
    await q("INSERT INTO documents (citizen_id, type, number, verify_code, issued_month, data) VALUES (?, 'marriage', ?, ?, ?, ?)", [spouse.id, `${number}-2`, newVerifyCode(), month, JSON.stringify({ full_name: spouse.full_name, passport: spouse.passport_no, spouse: citizen.full_name, spouse_passport: citizen.passport_no })], conn);
    await q("UPDATE citizens SET marital_status = 'married', spouse_name = ? WHERE id = ?", [spouse.full_name, citizen.id], conn);
    await q("UPDATE citizens SET marital_status = 'married', spouse_name = ? WHERE id = ?", [citizen.full_name, spouse.id], conn);
    await notify(conn, 'gov', spouse.gov_user_id, { title: 'Брак зарегистрирован', body: `Супруг(а): ${citizen.full_name}. Свидетельство ${number}-2`, link: '#/documents' });
    return number;
  }
  if (app.type === 'birth') {
    const children = json(citizen.children, []);
    children.push({ name: data.child_name, birth_date: data.child_birth_date });
    await q('UPDATE citizens SET children = ? WHERE id = ?', [JSON.stringify(children), citizen.id], conn);
    return addDocument(conn, { citizenId: citizen.id, type: 'birth', prefix: 'BR', month, data: { child_name: data.child_name, child_birth_date: data.child_birth_date, parent: citizen.full_name, parent_passport: citizen.passport_no } });
  }
  throw bad('unknown_type', 'Неизвестный тип заявления');
}

/**
 * Оплатить квитанцию. via: 'bank' — со счёта клиента; 'cash' — на кассе магазина
 * (магазин принимает наличные как агент и перечисляет сумму со своего бизнес-счёта).
 */
export async function payInvoice(conn, number, { fromAccount, via, actor, idem, force = false, allowArrested = false }) {
  const inv = await one('SELECT * FROM invoices WHERE number = ? FOR UPDATE', [number], conn);
  if (!inv) throw notFound('Квитанция не найдена');
  if (inv.status === 'paid') throw bad('already_paid', 'Квитанция уже оплачена');
  if (inv.status === 'cancelled') throw bad('cancelled', 'Квитанция аннулирована');
  // Налоги и штрафы можно погасить и с арестованного счёта — арест для этого и наложен.
  if (allowArrested && ['tax', 'fine'].includes(inv.kind)) {
    const acc = await one('SELECT status FROM accounts WHERE id = ?', [fromAccount], conn);
    if (acc?.status === 'arrested') force = true;
  }
  const r = await post(conn, {
    kind: via === 'cash' ? 'invoice_cash' : 'invoice',
    memo: `${inv.purpose} (${inv.number})`,
    entries: [{ account: fromAccount, amount: -Number(inv.amount) }, { account: await sys('BUDGET', conn), amount: Number(inv.amount) }],
    idem,
    actor,
    force,
    ref: { type: 'invoice', id: inv.id },
  });
  await q("UPDATE invoices SET status = 'paid', paid_tx_id = ?, paid_via = ?, paid_at = NOW(3) WHERE id = ?", [r.id, via, inv.id], conn);
  if (inv.gov_user_id) await notify(conn, 'gov', inv.gov_user_id, { title: 'Квитанция оплачена', body: `${inv.purpose}: ${formatMoney(inv.amount)}`, link: '#/invoices' });
  if (inv.ref_type === 'application') await processApplication(conn, inv.ref_id);
  for (const fn of [...(invoiceHooks.get(inv.ref_type) || []), ...(invoiceHooks.get('*') || [])]) await fn(conn, inv);
  return { invoice: { ...inv, status: 'paid' }, tx: r.id };
}

export function publicInvoice(inv) {
  return {
    number: inv.number, kind: inv.kind, purpose: inv.purpose, amount: Number(inv.amount), penalty: Number(inv.penalty || 0), due_month: inv.due_month ?? null, frozen: !!inv.frozen,
    status: inv.status, created_at: inv.created_at, paid_at: inv.paid_at, paid_via: inv.paid_via,
  };
}
