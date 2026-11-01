// Этап 8. Государство БФ: налоги и декларации ИП, штрафы и обжалования, неуплата (пени,
// арест счетов, запрет выезда, закрытие ИП), пособия, зарплаты госслужащих, имущество
// и сделки, медстраховка. Все деньги — проводки через «Госбюджет БФ».
import { q, one, tx, json, afterCommit } from '../db.js';
import { bad, notFound, forbidden } from './errors.js';
import { getSettings } from './settings.js';
import { currentMonth, onMonth } from './clock.js';
import { post, sys } from './ledger.js';
import { notify, notifyAdmins } from './notify.js';
import { createInvoice, onInvoicePaid, payInvoice, citizenOf } from './gov.js';
import { primaryAccount } from './bank.js';
import { randomDigits, withUnique } from './ids.js';
import { formatMoney, percentOf } from '@bln/shared/money.js';
import { ageFrom } from '@bln/shared/format.js';

// ——— Связь гражданина (ВлодУслуги) и клиента ВлодБанка ———

export async function bankUserOfCitizen(conn, citizen) {
  if (!citizen?.passport_no) return null;
  return one('SELECT * FROM bank_users WHERE passport_no = ? AND passport_verified = 1 ORDER BY id LIMIT 1', [citizen.passport_no], conn);
}

export async function citizenOfBankUser(conn, user) {
  if (!user?.passport_verified || !user.passport_no) return null;
  return one('SELECT * FROM citizens WHERE passport_no = ?', [user.passport_no], conn);
}

export async function citizenByPassport(conn, passportNo) {
  const c = await one('SELECT * FROM citizens WHERE passport_no = ?', [String(passportNo || '').trim().toUpperCase()], conn);
  if (!c) throw notFound('Гражданин с таким паспортом не найден');
  return c;
}

/** Уведомление гражданину во ВлодУслуги и (если есть связанный аккаунт) во ВлодБанк. */
export async function notifyCitizen(conn, citizen, { title, body = null, govLink = null, bankLink = null, email = false }) {
  await notify(conn, 'gov', citizen.gov_user_id, { title, body, link: govLink, email });
  const bu = await bankUserOfCitizen(conn, citizen);
  if (bu) await notify(conn, 'bank', bu.id, { title, body, link: bankLink || '#/state' });
}

/** Квитанция гражданину с уведомлением в оба кабинета. */
async function chargeCitizen(conn, citizen, { kind, purpose, amount, ref, dueMonth, govLink = '#/invoices' }) {
  const inv = await createInvoice(conn, { citizenId: citizen.id, govUserId: citizen.gov_user_id, kind, purpose, amount, ref, dueMonth });
  await notifyCitizen(conn, citizen, { title: `${purpose}: ${formatMoney(amount)}`, body: `Квитанция ${inv.number}${dueMonth !== null && dueMonth !== undefined ? ` — оплатить до игрового месяца ${dueMonth}` : ''}`, govLink, email: true });
  return inv;
}

// ——— Штрафы ———

export async function issueFine(conn, { citizen, article = null, text = null, amount = null, note = null, officer }) {
  const s = await getSettings();
  const month = await currentMonth(conn);
  const sum = article ? Number(article.amount) : Number(amount);
  if (!Number.isSafeInteger(sum) || sum <= 0) throw bad('invalid', 'Укажите сумму штрафа');
  const title = article ? `ст. ${article.code} — ${article.title}` : String(text || '').trim();
  if (title.length < 3) throw bad('invalid', 'Укажите статью или опишите нарушение');
  const r = await q('INSERT INTO fines (citizen_id, article_id, article_text, amount, note, officer_gov_user_id) VALUES (?, ?, ?, ?, ?, ?)', [citizen.id, article?.id || null, title.slice(0, 255), sum, note, officer?.id || null], conn);
  const inv = await chargeCitizen(conn, citizen, { kind: 'fine', purpose: `Штраф: ${title}`.slice(0, 255), amount: sum, ref: { type: 'fine', id: r.insertId }, dueMonth: month + Number(s.fine_due_months || 2), govLink: '#/fines' });
  await q('UPDATE fines SET invoice_id = ? WHERE id = ?', [inv.id, r.insertId], conn);
  return { id: r.insertId, invoice: inv.number };
}

onInvoicePaid('fine', async (conn, inv) => {
  await q("UPDATE fines SET status = 'paid' WHERE id = ? AND status = 'issued'", [inv.ref_id], conn);
});

export async function appealFine(conn, { fine, text }) {
  if (fine.status !== 'issued') throw bad('invalid_state', 'Штраф уже оплачен или отменён');
  if (fine.appeal_status) throw bad('already_appealed', 'Жалоба уже подана');
  await q("UPDATE fines SET appeal_status = 'pending', appeal_text = ?, appealed_at = NOW(3) WHERE id = ?", [text, fine.id], conn);
  // Пока жалоба на рассмотрении, пени не начисляются.
  await q('UPDATE invoices SET frozen = 1 WHERE id = ?', [fine.invoice_id], conn);
  afterCommit(conn, () => notifyAdmins('queue', { queue: 'fine_appeal', id: fine.id }));
}

export async function decideFineAppeal(conn, { fine, accept, note = null }) {
  if (fine.appeal_status !== 'pending') throw bad('decided', 'Жалоба уже рассмотрена');
  const citizen = await one('SELECT * FROM citizens WHERE id = ?', [fine.citizen_id], conn);
  if (accept) {
    await q("UPDATE fines SET appeal_status = 'accepted', appeal_note = ?, status = 'cancelled' WHERE id = ?", [note, fine.id], conn);
    await q("UPDATE invoices SET status = 'cancelled', frozen = 0 WHERE id = ? AND status = 'unpaid'", [fine.invoice_id], conn);
    await liftIfClear(conn, citizen);
  } else {
    await q("UPDATE fines SET appeal_status = 'rejected', appeal_note = ? WHERE id = ?", [note, fine.id], conn);
    await q('UPDATE invoices SET frozen = 0 WHERE id = ?', [fine.invoice_id], conn);
  }
  await notifyCitizen(conn, citizen, { title: accept ? 'Жалоба на штраф удовлетворена — штраф отменён' : 'Жалоба на штраф отклонена', body: `${fine.article_text}${note ? ` — ${note}` : ''}`, govLink: '#/fines' });
}

// ——— Налоги: декларации ИП и налог на имущество ———

/** Доход ИП за период: выручка магазинов без НДС за вычетом возвратов. */
async function ipIncome(conn, bankUserId, from, to) {
  if (!bankUserId) return 0;
  const r = await one(`SELECT COALESCE(SUM(s.total - s.vat - s.refunded),0) AS x FROM sales s JOIN shops sh ON sh.id = s.shop_id
    WHERE sh.owner_id = ? AND s.status = 'paid' AND s.paid_at > ? AND s.paid_at <= ?`, [bankUserId, from || new Date(0), to], conn);
  return Math.max(0, Number(r.x));
}

export async function createDeclarations(conn, { year, month, s }) {
  const ips = await q("SELECT id, issued_at, citizen_id FROM documents WHERE type = 'ip' AND status = 'active'", [], conn);
  const now = new Date();
  let n = 0;
  for (const ip of ips) {
    const docId = ip.id;
    if (await one('SELECT id FROM tax_declarations WHERE document_id = ? AND year = ?', [docId, year], conn)) continue;
    const prev = await one('SELECT period_to FROM tax_declarations WHERE document_id = ? ORDER BY year DESC LIMIT 1', [docId], conn);
    const who = await one('SELECT * FROM citizens WHERE id = ?', [ip.citizen_id], conn);
    const bu = await bankUserOfCitizen(conn, who);
    const from = prev?.period_to || ip.issued_at;
    const income = await ipIncome(conn, bu?.id, from, now);
    await q('INSERT INTO tax_declarations (citizen_id, document_id, year, period_from, period_to, income_auto, rate_bp, due_month) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [who.id, docId, year, from, now, income, Number(s.ip_tax_bp || 0), month + Number(s.declaration_due_months || 2)], conn);
    await notifyCitizen(conn, who, { title: `Подайте декларацию ИП за ${year}-й игровой год`, body: `Доход по данным касс: ${formatMoney(income)}. Срок — игровой месяц ${month + Number(s.declaration_due_months || 2)}`, govLink: '#/taxes', email: true });
    n++;
  }
  return n;
}

export async function submitDeclaration(conn, { decl, income, auto = false }) {
  if (decl.status !== 'draft') throw bad('invalid_state', 'Декларация уже подана');
  if (!auto && income < Number(decl.income_auto)) throw bad('income_low', `Доход не может быть меньше данных касс: ${formatMoney(decl.income_auto)}`);
  const s = await getSettings();
  const month = await currentMonth(conn);
  const tax = percentOf(income, decl.rate_bp);
  const citizen = await one('SELECT * FROM citizens WHERE id = ?', [decl.citizen_id], conn);
  let invId = null;
  if (tax > 0) {
    const inv = await chargeCitizen(conn, citizen, { kind: 'tax', purpose: `Налог ИП за ${decl.year}-й год`, amount: tax, ref: { type: 'declaration', id: decl.id }, dueMonth: auto ? month : Math.max(month, decl.due_month) + Number(s.tax_due_months || 2), govLink: '#/taxes' });
    invId = inv.id;
  }
  await q('UPDATE tax_declarations SET income = ?, tax = ?, status = ?, invoice_id = ?, submitted_at = NOW(3) WHERE id = ?', [income, tax, tax > 0 ? (auto ? 'auto' : 'submitted') : 'paid', invId, decl.id], conn);
  return { tax };
}

onInvoicePaid('declaration', async (conn, inv) => {
  await q("UPDATE tax_declarations SET status = 'paid' WHERE id = ?", [inv.ref_id], conn);
});

async function propertyTaxes(conn, { year, month, s }) {
  const rate = Number(s.property_tax_bp || 0);
  if (!rate) return;
  const props = await q('SELECT * FROM properties WHERE owner_citizen_id IS NOT NULL', [], conn);
  for (const p of props) {
    const purpose = `Налог на имущество за ${year}-й год: ${p.title}`;
    if (await one("SELECT id FROM invoices WHERE ref_type = 'property_tax' AND ref_id = ? AND purpose = ?", [p.id, purpose], conn)) continue;
    const tax = percentOf(Number(p.value), rate);
    if (tax <= 0) continue;
    const citizen = await one('SELECT * FROM citizens WHERE id = ?', [p.owner_citizen_id], conn);
    await chargeCitizen(conn, citizen, { kind: 'tax', purpose, amount: tax, ref: { type: 'property_tax', id: p.id }, dueMonth: month + Number(s.tax_due_months || 2), govLink: '#/taxes' });
  }
}

/** Доначисление налоговым инспектором. */
export async function assessTax(conn, { citizen, amount, purpose }) {
  const s = await getSettings();
  const month = await currentMonth(conn);
  return chargeCitizen(conn, citizen, { kind: 'tax', purpose: `Доначисление налога: ${purpose}`.slice(0, 255), amount, ref: { type: 'assessment', id: citizen.id }, dueMonth: month + Number(s.tax_due_months || 2), govLink: '#/taxes' });
}

// Раз в 12 игровых месяцев — декларации ИП и налог на имущество.
onMonth('state_year', async (month, s) => {
  if (month <= 0 || month % 12 !== 0) return;
  const year = month / 12;
  await tx((conn) => createDeclarations(conn, { year, month, s })).catch((e) => console.error('declarations', e.message));
  await tx((conn) => propertyTaxes(conn, { year, month, s })).catch((e) => console.error('property_tax', e.message));
});

// ——— Неуплата: пени, арест, запрет выезда, закрытие ИП ———

/** Просроченные налоги и штрафы гражданина (кроме обжалуемых). */
export async function overdueInvoices(conn, citizenId, month) {
  return q("SELECT * FROM invoices WHERE citizen_id = ? AND status = 'unpaid' AND frozen = 0 AND kind IN ('tax','fine') AND due_month IS NOT NULL AND due_month < ? ORDER BY id", [citizenId, month], conn);
}

export async function activeSanctions(conn, citizenId) {
  return q('SELECT * FROM citizen_sanctions WHERE citizen_id = ? AND active = 1 ORDER BY id', [citizenId], conn);
}

async function addSanction(conn, citizen, kind, reason, data = null, by = 'system') {
  if (await one('SELECT id FROM citizen_sanctions WHERE citizen_id = ? AND kind = ? AND active = 1', [citizen.id, kind], conn)) return false;
  await q('INSERT INTO citizen_sanctions (citizen_id, kind, reason, data, created_by) VALUES (?, ?, ?, ?, ?)', [citizen.id, kind, reason, data ? JSON.stringify(data) : null, by], conn);
  return true;
}

/** Арест: счета клиента во ВлодБанке (кроме кредитных) — списывать можно только в счёт долга. */
export async function arrestAccounts(conn, citizen, reason, by = 'system') {
  const bu = await bankUserOfCitizen(conn, citizen);
  if (!bu) return false;
  const accs = await q("SELECT id FROM accounts WHERE owner_kind = 'bank_user' AND owner_id = ? AND status = 'active' AND type IN ('current','savings','business')", [bu.id], conn);
  const added = await addSanction(conn, citizen, 'arrest', reason, { accounts: accs.map((a) => a.id) }, by);
  if (!added) return false;
  if (accs.length) await q(`UPDATE accounts SET status = 'arrested' WHERE id IN (${accs.map(() => '?').join(',')})`, accs.map((a) => a.id), conn);
  await notifyCitizen(conn, citizen, { title: 'Арест счетов во ВлодБанке', body: `${reason}. Погасите долг — арест снимется автоматически`, govLink: '#/taxes', email: true });
  return true;
}

export async function liftSanction(conn, sanction) {
  if (!sanction.active) return;
  await q('UPDATE citizen_sanctions SET active = 0, lifted_at = NOW(3) WHERE id = ?', [sanction.id], conn);
  if (sanction.kind === 'arrest') {
    const ids = json(sanction.data, {})?.accounts || [];
    if (ids.length) await q(`UPDATE accounts SET status = 'active' WHERE status = 'arrested' AND id IN (${ids.map(() => '?').join(',')})`, ids, conn);
  }
  const citizen = await one('SELECT * FROM citizens WHERE id = ?', [sanction.citizen_id], conn);
  const title = { arrest: 'Арест со счетов снят', travel_ban: 'Запрет выезда снят', ip_closed: 'Запрет на ИП снят' }[sanction.kind];
  await notifyCitizen(conn, citizen, { title, govLink: '#/taxes' });
}

/** Долгов не осталось — снимаем арест и запрет выезда (закрытие ИП не отменяется). */
export async function liftIfClear(conn, citizen) {
  if (!citizen) return;
  const month = await currentMonth(conn);
  if ((await overdueInvoices(conn, citizen.id, month)).length) return;
  for (const sn of await activeSanctions(conn, citizen.id)) {
    if (sn.kind === 'arrest' || sn.kind === 'travel_ban') await liftSanction(conn, sn);
  }
}

onInvoicePaid('*', async (conn, inv) => {
  if (!inv.citizen_id || !['tax', 'fine'].includes(inv.kind)) return;
  const citizen = await one('SELECT * FROM citizens WHERE id = ?', [inv.citizen_id], conn);
  await liftIfClear(conn, citizen);
});

/** Взыскание: просроченное списывается с арестованных счетов, если там хватает денег. */
async function collect(conn, citizen, month) {
  const sn = await one("SELECT * FROM citizen_sanctions WHERE citizen_id = ? AND kind = 'arrest' AND active = 1", [citizen.id], conn);
  if (!sn) return 0;
  const ids = json(sn.data, {})?.accounts || [];
  let paid = 0;
  for (const inv of await overdueInvoices(conn, citizen.id, month)) {
    const acc = ids.length ? await one(`SELECT id FROM accounts WHERE id IN (${ids.map(() => '?').join(',')}) AND balance >= ? AND status <> 'closed' ORDER BY balance DESC LIMIT 1`, [...ids, Number(inv.amount)], conn) : null;
    if (!acc) continue;
    await payInvoice(conn, inv.number, { fromAccount: acc.id, via: 'bank', actor: { kind: 'system', id: 0 }, idem: `collect:${inv.id}`, force: true });
    paid += Number(inv.amount);
  }
  return paid;
}

onMonth('state_debts', async (month, s) => {
  // Автоподача просроченных деклараций по данным касс.
  for (const d of await q("SELECT * FROM tax_declarations WHERE status = 'draft' AND due_month < ?", [month])) {
    await tx(async (conn) => {
      const decl = await one('SELECT * FROM tax_declarations WHERE id = ? FOR UPDATE', [d.id], conn);
      if (decl.status !== 'draft') return;
      await submitDeclaration(conn, { decl, income: Number(decl.income_auto), auto: true });
    }).catch((e) => console.error('declaration auto', d.id, e.message));
  }
  // Пени: процент от суммы без пени за каждый просроченный месяц.
  const rate = Number(s.penalty_bp || 0);
  if (rate > 0) {
    const due = await q("SELECT * FROM invoices WHERE status = 'unpaid' AND frozen = 0 AND kind IN ('tax','fine') AND due_month IS NOT NULL AND due_month < ? AND (penalty_month IS NULL OR penalty_month < ?)", [month, month]);
    for (const inv of due) {
      const pen = percentOf(Number(inv.amount) - Number(inv.penalty), rate);
      await q("UPDATE invoices SET amount = amount + ?, penalty = penalty + ?, penalty_month = ? WHERE id = ? AND status = 'unpaid'", [pen, pen, month, inv.id]);
    }
  }
  // Меры к должникам по сроку самой старой просрочки.
  const debtors = await q("SELECT citizen_id, MIN(due_month) AS since, SUM(amount) AS total FROM invoices WHERE status = 'unpaid' AND frozen = 0 AND kind IN ('tax','fine') AND due_month IS NOT NULL AND due_month < ? AND citizen_id IS NOT NULL GROUP BY citizen_id", [month]);
  for (const d of debtors) {
    await tx(async (conn) => {
      const citizen = await one('SELECT * FROM citizens WHERE id = ?', [d.citizen_id], conn);
      const late = month - Number(d.since);
      const reason = `Неуплата налогов и штрафов: ${formatMoney(d.total)}`;
      if (late >= Number(s.sanction_months || 3)) {
        await arrestAccounts(conn, citizen, reason);
        if (await addSanction(conn, citizen, 'travel_ban', reason)) {
          await notifyCitizen(conn, citizen, { title: 'Запрет выезда из БФ', body: reason, govLink: '#/taxes' });
        }
        if (await collect(conn, citizen, month)) return;
      }
      if (late >= Number(s.ip_close_months || 6)) {
        const ip = await one("SELECT * FROM documents WHERE citizen_id = ? AND type = 'ip' AND status = 'active'", [citizen.id], conn);
        if (ip) {
          await q("UPDATE documents SET status = 'closed' WHERE id = ?", [ip.id], conn);
          const bu = await bankUserOfCitizen(conn, citizen);
          if (bu) await q("UPDATE shops SET status = 'closed' WHERE owner_id = ?", [bu.id], conn);
          await addSanction(conn, citizen, 'ip_closed', reason, { document: ip.id });
          await notifyCitizen(conn, citizen, { title: 'ИП закрыто за неуплату', body: `${ip.number}: магазины закрыты`, govLink: '#/taxes', email: true });
        }
      }
    }).catch((e) => console.error('debtor', d.citizen_id, e.message));
  }
});

// Сроки документов в игровых месяцах.
onMonth('documents_expiry', async (month) => {
  await q("UPDATE documents SET status = 'expired' WHERE status = 'active' AND expires_month IS NOT NULL AND expires_month < ?", [month]);
});

// ——— Пособия ———

export const BENEFIT_TITLES = { child: 'Детское пособие', pension: 'Пенсия', unemployment: 'Пособие по безработице' };

export async function benefitAmount(citizen, kind, s) {
  if (kind === 'child') return Number(s.benefit_child || 0) * json(citizen.children, []).length;
  if (kind === 'pension') return Number(s.benefit_pension || 0);
  return Number(s.benefit_unemployment || 0);
}

export async function applyBenefit(conn, citizen, kind) {
  if (!BENEFIT_TITLES[kind]) throw bad('invalid', 'Неизвестное пособие');
  const s = await getSettings();
  if (await one("SELECT id FROM benefits WHERE citizen_id = ? AND kind = ? AND status IN ('pending','active')", [citizen.id, kind], conn)) throw bad('already', 'Пособие уже назначено или заявка на рассмотрении');
  if (kind === 'child' && !json(citizen.children, []).length) throw bad('no_children', 'В паспорте нет детей');
  if (kind === 'pension' && ageFrom(citizen.birth_date) < Number(s.pension_age)) throw bad('too_young', `Пенсия — с ${s.pension_age} лет`);
  const bu = await bankUserOfCitizen(conn, citizen);
  if (!bu) throw bad('no_bank', 'Пособие выплачивается на счёт ВлодБанка — привяжите паспорт к банку');
  if (kind === 'unemployment') {
    const job = await one('SELECT id FROM shop_staff WHERE bank_user_id = ? AND active = 1', [bu.id], conn);
    const ip = await one("SELECT id FROM documents WHERE citizen_id = ? AND type = 'ip' AND status = 'active'", [citizen.id], conn);
    const gov = await one("SELECT role FROM user_roles WHERE user_kind = 'gov' AND user_id = ? AND role IN ('official','police','tax','doctor')", [citizen.gov_user_id], conn);
    if (job || ip || gov) throw bad('employed', 'Вы работаете или зарегистрированы как ИП');
  }
  const months = kind === 'unemployment' ? Number(s.benefit_unemployment_months || 6) : null;
  const status = s.benefits_approval ? 'pending' : 'active';
  const r = await q('INSERT INTO benefits (citizen_id, kind, status, months_left, decided_by) VALUES (?, ?, ?, ?, ?)', [citizen.id, kind, status, months, status === 'active' ? 'auto' : null], conn);
  if (status === 'pending') afterCommit(conn, () => notifyAdmins('queue', { queue: 'benefit', id: r.insertId }));
  return { id: r.insertId, status };
}

export async function decideBenefit(conn, { benefit, approve, by, note = null }) {
  if (benefit.status !== 'pending') throw bad('decided', 'Заявка уже рассмотрена');
  await q('UPDATE benefits SET status = ?, decided_by = ?, note = ? WHERE id = ?', [approve ? 'active' : 'rejected', by, note, benefit.id], conn);
  const citizen = await one('SELECT * FROM citizens WHERE id = ?', [benefit.citizen_id], conn);
  await notifyCitizen(conn, citizen, { title: `${BENEFIT_TITLES[benefit.kind]}: ${approve ? 'назначено' : 'отказ'}`, body: note, govLink: '#/benefits' });
}

onMonth('benefits', async (month, s) => {
  for (const b of await q("SELECT * FROM benefits WHERE status = 'active' AND (last_month IS NULL OR last_month < ?)", [month])) {
    await tx(async (conn) => {
      const ben = await one('SELECT * FROM benefits WHERE id = ? FOR UPDATE', [b.id], conn);
      if (ben.status !== 'active' || (ben.last_month !== null && ben.last_month >= month)) return;
      const citizen = await one('SELECT * FROM citizens WHERE id = ?', [ben.citizen_id], conn);
      const amount = await benefitAmount(citizen, ben.kind, s);
      const bu = await bankUserOfCitizen(conn, citizen);
      const target = bu ? await primaryAccount(bu.id, conn) : null;
      if (amount > 0 && target) {
        await post(conn, {
          kind: 'benefit',
          memo: BENEFIT_TITLES[ben.kind],
          entries: [{ account: await sys('BUDGET', conn), amount: -amount }, { account: target.id, amount }],
          idem: `benefit:${ben.id}:${month}`,
          force: true,
          ref: { type: 'benefit', id: ben.id },
        });
        await notify(conn, 'bank', bu.id, { title: `${BENEFIT_TITLES[ben.kind]} ${formatMoney(amount)}`, body: 'Выплата из госбюджета БФ' });
      }
      const left = ben.months_left === null ? null : ben.months_left - 1;
      await q('UPDATE benefits SET last_month = ?, months_left = ?, status = ? WHERE id = ?', [month, left, left !== null && left <= 0 ? 'stopped' : 'active', ben.id], conn);
    }).catch((e) => console.error('benefit', b.id, e.message));
  }
});

// ——— Зарплаты госслужащих из госбюджета (с удержанием НДФЛ) ———

export const GOV_SALARY_ROLES = ['official', 'police', 'tax', 'doctor'];

onMonth('gov_salaries', async (month, s) => {
  const rows = await q(`SELECT user_id, GROUP_CONCAT(role) AS roles FROM user_roles WHERE user_kind = 'gov' AND role IN (${GOV_SALARY_ROLES.map(() => '?').join(',')}) GROUP BY user_id`, GOV_SALARY_ROLES);
  for (const r of rows) {
    await tx(async (conn) => {
      const roles = String(r.roles).split(',');
      const gross = roles.reduce((x, role) => x + Number(s[`salary_${role}`] || 0), 0);
      if (gross <= 0) return;
      const citizen = await citizenOf(r.user_id, conn);
      const bu = citizen ? await bankUserOfCitizen(conn, citizen) : null;
      const target = bu ? await primaryAccount(bu.id, conn) : null;
      if (!target) {
        await notify(conn, 'gov', r.user_id, { title: 'Зарплата не выплачена', body: 'Привяжите паспорт к счёту ВлодБанка' });
        return;
      }
      const ndfl = percentOf(gross, Number(s.ndfl_bp || 0));
      const res = await post(conn, {
        kind: 'gov_salary',
        memo: 'Зарплата госслужащего',
        entries: [{ account: await sys('BUDGET', conn), amount: -(gross - ndfl) }, { account: target.id, amount: gross - ndfl }],
        idem: `gsalary:${month}:${r.user_id}`,
        force: true,
        meta: { gross, ndfl, roles },
      });
      if (!res.duplicate) await notify(conn, 'bank', bu.id, { title: `Зарплата ${formatMoney(gross - ndfl)}`, body: `Госбюджет БФ · НДФЛ ${formatMoney(ndfl)}` });
    }).catch((e) => console.error('gov_salary', r.user_id, e.message));
  }
});

// ——— Медстраховка ———

export async function isInsured(conn, citizenId, month) {
  return !!(await one("SELECT id FROM insurance_policies WHERE citizen_id = ? AND status = 'active' AND from_month <= ? AND to_month >= ?", [citizenId, month, month], conn));
}

export async function buyInsurance(conn, citizen) {
  const s = await getSettings();
  const price = Number(s.insurance_price || 0);
  if (await one("SELECT id FROM insurance_policies WHERE citizen_id = ? AND status = 'awaiting_payment'", [citizen.id], conn)) throw bad('already_pending', 'Квитанция на страховку уже выставлена');
  const r = await q('INSERT INTO insurance_policies (citizen_id, price) VALUES (?, ?)', [citizen.id, price], conn);
  if (price <= 0) {
    await activateInsurance(conn, r.insertId);
    return { id: r.insertId };
  }
  const inv = await createInvoice(conn, { citizenId: citizen.id, govUserId: citizen.gov_user_id, kind: 'fee', purpose: 'Медицинская страховка', amount: price, ref: { type: 'insurance', id: r.insertId } });
  await q('UPDATE insurance_policies SET invoice_id = ? WHERE id = ?', [inv.id, r.insertId], conn);
  return { id: r.insertId, invoice: inv.number, amount: price };
}

async function activateInsurance(conn, policyId) {
  const s = await getSettings();
  const month = await currentMonth(conn);
  const p = await one('SELECT * FROM insurance_policies WHERE id = ?', [policyId], conn);
  const cur = await one("SELECT MAX(to_month) AS m FROM insurance_policies WHERE citizen_id = ? AND status = 'active' AND to_month >= ?", [p.citizen_id, month], conn);
  const from = cur?.m !== null && cur?.m !== undefined ? Number(cur.m) + 1 : month;
  await q("UPDATE insurance_policies SET status = 'active', from_month = ?, to_month = ? WHERE id = ?", [from, from + Number(s.insurance_months || 12) - 1, p.id], conn);
  const citizen = await one('SELECT * FROM citizens WHERE id = ?', [p.citizen_id], conn);
  await notify(conn, 'gov', citizen.gov_user_id, { title: 'Медстраховка действует', body: `До игрового месяца ${from + Number(s.insurance_months || 12) - 1}`, link: '#/doctor' });
}

onInvoicePaid('insurance', async (conn, inv) => activateInsurance(conn, inv.ref_id));

// ——— Имущество и сделки ———

export const PROPERTY_KINDS = { car: 'Автомобиль', realty: 'Недвижимость' };

export async function newRegNumber(conn, kind) {
  return withUnique(async () => {
    const n = kind === 'car' ? `А${randomDigits(3)}ВЛ` : `НД-${randomDigits(6)}`;
    if (await one('SELECT id FROM properties WHERE reg_number = ?', [n], conn)) {
      const e = new Error('dup');
      e.code = 'ER_DUP_ENTRY';
      throw e;
    }
    return n;
  });
}

export function propertyView(p) {
  return {
    id: p.id, kind: p.kind, title: p.title, reg_number: p.reg_number, address: p.address, details: p.details, photo: p.photo, value: Number(p.value),
    owner_citizen_id: p.owner_citizen_id, owner_name: p.owner_name ?? undefined, list_price: p.list_price === null ? null : Number(p.list_price),
    lien_loan_id: p.lien_loan_id, status: p.status, created_at: p.created_at,
  };
}

export function dealView(d) {
  return {
    id: d.id, property_id: d.property_id, title: d.title, kind: d.kind, reg_number: d.reg_number, seller_citizen_id: d.seller_citizen_id, seller_name: d.seller_name || (d.seller_citizen_id ? null : 'Государство БФ'),
    buyer_citizen_id: d.buyer_citizen_id, buyer_name: d.buyer_name, price: Number(d.price), status: d.status, loan_id: d.loan_id, created_at: d.created_at, closed_at: d.closed_at,
  };
}

/** Продавец выставляет имущество на продажу всем или предлагает конкретному покупателю. */
export async function offerProperty(conn, { property, seller, price, buyer = null }) {
  if (property.owner_citizen_id !== (seller?.id ?? null)) throw forbidden('Это не ваше имущество');
  if (property.lien_loan_id) throw bad('lien', 'Имущество в залоге у банка до погашения кредита');
  if (property.status !== 'active') throw bad('arrested', 'Имущество под арестом');
  if (!buyer) {
    await q('UPDATE properties SET list_price = ? WHERE id = ?', [price, property.id], conn);
    return null;
  }
  if (buyer.id === seller?.id) throw bad('invalid', 'Нельзя продать самому себе');
  const r = await q('INSERT INTO property_deals (property_id, seller_citizen_id, buyer_citizen_id, price) VALUES (?, ?, ?, ?)', [property.id, seller?.id ?? null, buyer.id, price], conn);
  await notifyCitizen(conn, buyer, { title: `Предложение купить: ${property.title}`, body: `${formatMoney(price)} — оплата во ВлодБанке (можно в ипотеку / автокредит)`, govLink: '#/property', bankLink: '#/property' });
  return r.insertId;
}

/** Покупатель откликается на объявление. */
export async function requestPurchase(conn, { property, buyer }) {
  if (property.list_price === null) throw bad('not_for_sale', 'Имущество не продаётся');
  if (property.owner_citizen_id === buyer.id) throw bad('invalid', 'Это ваше имущество');
  const open = await one("SELECT id FROM property_deals WHERE property_id = ? AND buyer_citizen_id = ? AND status IN ('pending','loan')", [property.id, buyer.id], conn);
  if (open) return open.id;
  const r = await q('INSERT INTO property_deals (property_id, seller_citizen_id, buyer_citizen_id, price) VALUES (?, ?, ?, ?)', [property.id, property.owner_citizen_id, buyer.id, Number(property.list_price)], conn);
  return r.insertId;
}

/** Счёт продавца для расчёта по сделке: основной счёт во ВлодБанке или госбюджет. */
export async function sellerAccount(conn, deal) {
  if (!deal.seller_citizen_id) return sys('BUDGET', conn);
  const seller = await one('SELECT * FROM citizens WHERE id = ?', [deal.seller_citizen_id], conn);
  const bu = await bankUserOfCitizen(conn, seller);
  const acc = bu ? await primaryAccount(bu.id, conn) : null;
  if (!acc) throw bad('seller_no_account', 'У продавца нет расчётного счёта во ВлодБанке');
  return acc.id;
}

export async function checkDealOpen(conn, deal) {
  const p = await one('SELECT * FROM properties WHERE id = ? FOR UPDATE', [deal.property_id], conn);
  if ((p.owner_citizen_id ?? null) !== (deal.seller_citizen_id ?? null)) throw bad('owner_changed', 'Имущество уже продано');
  if (p.lien_loan_id) throw bad('lien', 'Имущество в залоге');
  if (p.status !== 'active') throw bad('arrested', 'Имущество под арестом');
  return p;
}

/** Переход права собственности. */
export async function transferProperty(conn, { deal, txId, lienLoanId = null }) {
  const p = await one('SELECT * FROM properties WHERE id = ?', [deal.property_id], conn);
  await q('UPDATE properties SET owner_citizen_id = ?, list_price = NULL, lien_loan_id = ? WHERE id = ?', [deal.buyer_citizen_id, lienLoanId, p.id], conn);
  await q("UPDATE property_deals SET status = 'done', tx_id = ?, closed_at = NOW(3) WHERE id = ?", [txId, deal.id], conn);
  await q("UPDATE property_deals SET status = 'cancelled', closed_at = NOW(3) WHERE property_id = ? AND id <> ? AND status IN ('pending','loan')", [p.id, deal.id], conn);
  const buyer = await one('SELECT * FROM citizens WHERE id = ?', [deal.buyer_citizen_id], conn);
  await notifyCitizen(conn, buyer, { title: `Вы владелец: ${p.title}`, body: `${p.reg_number}${lienLoanId ? ' · в залоге у ВлодБанка до погашения кредита' : ''}`, govLink: '#/property', bankLink: '#/property' });
  if (deal.seller_citizen_id) {
    const seller = await one('SELECT * FROM citizens WHERE id = ?', [deal.seller_citizen_id], conn);
    await notifyCitizen(conn, seller, { title: `Продано: ${p.title}`, body: formatMoney(deal.price), govLink: '#/property' });
  }
}

/** Оплата сделки целиком со счёта покупателя. */
export async function payDeal(conn, { deal, fromAccountId, actor, idem }) {
  if (deal.status !== 'pending') throw bad('invalid_state', deal.status === 'loan' ? 'По сделке оформляется кредит' : 'Сделка закрыта');
  await checkDealOpen(conn, deal);
  const r = await post(conn, {
    kind: 'property_purchase',
    memo: `Покупка имущества (сделка №${deal.id})`,
    entries: [{ account: fromAccountId, amount: -Number(deal.price) }, { account: await sellerAccount(conn, deal), amount: Number(deal.price) }],
    actor,
    idem,
    ref: { type: 'property_deal', id: deal.id },
  });
  if (r.duplicate) return { duplicate: true };
  await transferProperty(conn, { deal, txId: r.id });
  return { tx: r.id };
}
