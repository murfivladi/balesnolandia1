// Этап 6. Финансы ВлодБанка: переводы с антифродом, кредитные / детские / подарочные карты,
// кредиты с графиком, автоплатежи, кешбэк, инфляция. Ежемесячные события — через onMonth.
import { q, one, tx, afterCommit } from '../db.js';
import { bad, notFound } from './errors.js';
import { getSettings } from './settings.js';
import { currentMonth, onMonth } from './clock.js';
import { post, sys, reverse } from './ledger.js';
import { notify, notifyAdmins } from './notify.js';
import { primaryAccount, transferFee, issueCard } from './bank.js';
import { newAccountNumber, withUnique } from './ids.js';
import { formatMoney, percentOf, annuitySchedule } from '@bln/shared/money.js';

// ——— Общее ———

/** Счёт клиента, который создаётся вместе с картой или кредитом. */
export async function createAccount(conn, { userId, type, name, creditLimit = 0 }) {
  const month = await currentMonth(conn);
  const id = await withUnique(async () => {
    const r = await q(
      'INSERT INTO accounts (number, owner_kind, owner_id, type, name, credit_limit, opened_month) VALUES (?, ?, ?, ?, ?, ?, ?)',
      [newAccountNumber(type), 'bank_user', userId, type, name.slice(0, 80), creditLimit, month],
      conn,
    );
    return r.insertId;
  });
  return one('SELECT * FROM accounts WHERE id = ?', [id], conn);
}

/** Кредитный рейтинг: 0…1000. Растёт за платежи вовремя, падает за просрочки. */
export async function adjustScore(conn, userId, delta) {
  await q('UPDATE bank_users SET credit_score = LEAST(1000, GREATEST(0, credit_score + ?)) WHERE id = ?', [delta, userId], conn);
}

export function scoreLevel(score) {
  if (score >= 750) return 'excellent';
  if (score >= 600) return 'good';
  if (score >= 400) return 'fair';
  return 'poor';
}

// ——— Антифрод ———

/**
 * Подозрителен ли перевод: крупный (≥ порога), необычный (в N раз больше обычных переводов
 * клиента) или слишком частый (много переводов за 10 минут). Возвращает причину или null.
 */
export async function transferSuspicion(conn, userId, amount, s) {
  const threshold = Number(s.fraud_threshold || 0);
  if (threshold > 0 && amount >= threshold) return `Крупный перевод: от ${formatMoney(threshold)}`;
  const velocity = Number(s.fraud_velocity || 0);
  if (velocity > 0) {
    const r = await one("SELECT COUNT(*) AS n FROM ledger_tx WHERE kind = 'transfer' AND actor_kind = 'bank' AND actor_id = ? AND created_at >= NOW(3) - INTERVAL 10 MINUTE", [userId], conn);
    if (Number(r.n) >= velocity) return `Много переводов подряд: ${Number(r.n)} за 10 минут`;
  }
  const mult = Number(s.fraud_multiplier || 0);
  if (mult > 1) {
    const rows = await q(
      "SELECT -e.amount AS a FROM ledger_tx t JOIN ledger_entries e ON e.tx_id = t.id AND e.amount < 0 WHERE t.kind = 'transfer' AND t.actor_kind = 'bank' AND t.actor_id = ? ORDER BY t.id DESC LIMIT 20",
      [userId],
      conn,
    );
    if (rows.length >= 5) {
      const avg = rows.reduce((x, r) => x + Number(r.a), 0) / rows.length;
      // Мелочь не трогаем: необычным считается перевод от пятой части порога.
      if (amount > avg * mult && amount >= threshold / 5) return `Необычно крупный перевод: в ${Math.floor(amount / avg)} раз больше обычного`;
    }
  }
  return null;
}

export async function addFraud(conn, { userId, kind, mode, amount, reason, data = null, txId = null }) {
  const r = await q('INSERT INTO fraud_queue (bank_user_id, kind, mode, amount, reason, data, tx_id) VALUES (?, ?, ?, ?, ?, ?, ?)', [userId, kind, mode, amount, reason, data ? JSON.stringify(data) : null, txId], conn);
  afterCommit(conn, () => notifyAdmins('queue', { queue: 'fraud', id: r.insertId }));
  return r.insertId;
}

/** Оплата картой / QR / снятие в банкомате проходят сразу, но крупные уходят админу на проверку. */
export async function reviewIfLarge(conn, { accountId, amount, kind, txId, cardId = null }) {
  const s = await getSettings();
  const threshold = Number(s.fraud_threshold || 0);
  if (!threshold || amount < threshold) return null;
  const acc = await one('SELECT owner_kind, owner_id FROM accounts WHERE id = ?', [accountId], conn);
  if (acc?.owner_kind !== 'bank_user') return null;
  return addFraud(conn, { userId: acc.owner_id, kind, mode: 'review', amount, reason: `Крупная операция: от ${formatMoney(threshold)}`, data: { account: accountId, card: cardId }, txId });
}

// ——— Переводы ———

/**
 * Перевод со счёта на счёт с комиссией (между своими — без комиссии).
 * Используется переводами клиента, автоплатежами и одобрением задержанных переводов.
 */
export async function moveMoney(conn, { user, from, to, amount, memo = null, idem = null, kind = null, actor = null, meta = {} }) {
  if (to.id === from.id) throw bad('same_account', 'Нельзя перевести на тот же счёт');
  const own = to.owner_id === user.id && to.owner_kind === 'bank_user';
  const fee = own ? 0 : transferFee(amount, await getSettings());
  const entries = [{ account: from.id, amount: -(amount + fee) }, { account: to.id, amount }];
  if (fee) entries.push({ account: await sys('TREASURY', conn), amount: fee });
  const r = await post(conn, {
    kind: kind || (own ? 'transfer_own' : 'transfer'),
    memo: memo || (own ? 'Перевод между своими счетами' : `Перевод: ${user.full_name}`),
    entries,
    idem,
    actor: actor || { kind: 'bank', id: user.id },
    meta: { fee, from: from.id, to: to.id, amount, ...meta },
  });
  if (!r.duplicate && !own && to.owner_kind === 'bank_user') {
    await notify(conn, 'bank', to.owner_id, { title: `Поступление ${formatMoney(amount)}`, body: `От: ${user.full_name}${memo ? ` — ${memo}` : ''}`, link: `#/accounts/${to.id}` });
  }
  return { tx: r.id, fee, own, duplicate: !!r.duplicate };
}

/** Одобрение / отказ по записи антифрода. Задержанный перевод при одобрении выполняется. */
export async function decideFraud(id, { approve, actor, note = null }) {
  const item = await one('SELECT * FROM fraud_queue WHERE id = ?', [id]);
  if (!item) throw notFound();
  if (item.status !== 'pending') throw bad('decided', 'Решение уже принято');
  const data = typeof item.data === 'string' ? JSON.parse(item.data) : item.data || {};
  const decidedBy = `${actor.kind}:${actor.id}`;
  let status = approve ? 'approved' : 'rejected';
  let failNote = null;
  if (item.mode === 'hold' && approve) {
    try {
      await tx(async (conn) => {
        const user = await one('SELECT * FROM bank_users WHERE id = ?', [item.bank_user_id], conn);
        const from = await one('SELECT * FROM accounts WHERE id = ?', [data.from], conn);
        const to = await one('SELECT * FROM accounts WHERE id = ?', [data.to], conn);
        if (!from || !to || to.status === 'closed') throw bad('recipient_not_found', 'Счёт получателя не найден');
        const r = await moveMoney(conn, { user, from, to, amount: Number(item.amount), memo: data.memo, idem: data.idem || `fraud:${item.id}` });
        await q('UPDATE fraud_queue SET tx_id = ? WHERE id = ?', [r.tx, item.id], conn);
      });
    } catch (err) {
      if (!err.statusCode) throw err;
      status = 'failed';
      failNote = err.message;
    }
  }
  await tx(async (conn) => {
    if (item.mode === 'review' && !approve && item.tx_id) {
      const t = await one('SELECT reversed_by FROM ledger_tx WHERE id = ?', [item.tx_id], conn);
      if (!t.reversed_by) await reverse(conn, item.tx_id, { actor, memo: `Отмена подозрительной операции №${item.tx_id}` });
      if (data.card) await q("UPDATE cards SET status = 'frozen' WHERE id = ? AND status = 'active'", [data.card], conn);
    }
    await q('UPDATE fraud_queue SET status = ?, decided_by = ?, note = ?, decided_at = NOW(3) WHERE id = ?', [status, decidedBy, failNote || note, item.id], conn);
    const titles = {
      hold: { approved: 'Перевод одобрен и выполнен', rejected: 'Перевод отклонён службой безопасности', failed: 'Перевод не выполнен' },
      review: { approved: 'Операция проверена', rejected: 'Операция отменена службой безопасности' },
    };
    const title = titles[item.mode][status];
    if (title && !(item.mode === 'review' && approve)) {
      await notify(conn, 'bank', item.bank_user_id, { title, body: `${formatMoney(item.amount)}${failNote ? ` — ${failNote}` : note ? ` — ${note}` : ''}`, email: !approve });
    }
  });
  return { status, note: failNote };
}

// ——— Кредитные карты ———

export async function applyCreditLine(conn, user, { limit, pinHash, background }) {
  const s = await getSettings();
  if (limit > Number(s.credit_max_limit)) throw bad('limit_too_high', `Лимит не больше ${formatMoney(s.credit_max_limit)}`);
  const busy = await one("SELECT id FROM credit_lines WHERE bank_user_id = ? AND status IN ('pending','active')", [user.id], conn);
  if (busy) throw bad('has_credit_line', 'У вас уже есть кредитная карта или заявка');
  const r = await q('INSERT INTO credit_lines (bank_user_id, limit_requested, pin_hash, background) VALUES (?, ?, ?, ?)', [user.id, limit, pinHash, background], conn);
  afterCommit(conn, () => notifyAdmins('queue', { queue: 'credit', id: r.insertId }));
  return r.insertId;
}

/** Решение админа по заявке: при одобрении открывается кредитный счёт и выпускается карта. */
export async function decideCreditLine(conn, line, { approve, limit, actor, note = null }) {
  if (line.status !== 'pending') throw bad('decided', 'Решение уже принято');
  const decidedBy = `${actor.kind}:${actor.id}`;
  if (!approve) {
    await q("UPDATE credit_lines SET status = 'rejected', decided_by = ?, decision_note = ?, decided_at = NOW(3) WHERE id = ?", [decidedBy, note, line.id], conn);
    await notify(conn, 'bank', line.bank_user_id, { title: 'Кредитная карта: отказ', body: note || 'Банк не одобрил заявку', link: '#/credit', email: true });
    return null;
  }
  const user = await one('SELECT * FROM bank_users WHERE id = ?', [line.bank_user_id], conn);
  const acc = await createAccount(conn, { userId: user.id, type: 'credit', name: 'Кредитная карта', creditLimit: limit });
  const card = await issueCard(conn, { user, account: acc, pinHash: line.pin_hash, type: 'credit', background: line.background, issuedBy: decidedBy });
  await q("UPDATE credit_lines SET status = 'active', limit_approved = ?, account_id = ?, card_id = ?, pin_hash = NULL, decided_by = ?, decision_note = ?, decided_at = NOW(3), statement_month = ? WHERE id = ?", [limit, acc.id, card.id, decidedBy, note, await currentMonth(conn), line.id], conn);
  await notify(conn, 'bank', user.id, { title: 'Кредитная карта одобрена', body: `Лимит ${formatMoney(limit)}. Карта •••• ${card.number.slice(-4)}`, link: '#/cards', email: true });
  return card;
}

/** Изменить лимит действующей кредитной карты (админ). */
export async function setCreditLimit(conn, line, limit) {
  if (line.status !== 'active') throw bad('invalid_state', 'Кредитная карта не активна');
  await q('UPDATE accounts SET credit_limit = ? WHERE id = ?', [limit, line.account_id], conn);
  await q('UPDATE credit_lines SET limit_approved = ? WHERE id = ?', [limit, line.id], conn);
  await notify(conn, 'bank', line.bank_user_id, { title: `Новый кредитный лимит ${formatMoney(limit)}`, link: '#/credit' });
}

export async function creditLineView(line, conn) {
  const acc = line.account_id ? await one('SELECT balance, credit_limit FROM accounts WHERE id = ?', [line.account_id], conn) : null;
  const s = await getSettings();
  const debt = acc ? Math.max(0, -Number(acc.balance)) : 0;
  const month = await currentMonth(conn);
  let minPayment = 0;
  let paidSince = 0;
  if (line.status === 'active' && Number(line.statement_debt) > 0) {
    minPayment = Math.max(1, percentOf(Number(line.statement_debt), Number(s.credit_min_payment_bp)));
    const r = await one('SELECT COALESCE(SUM(amount),0) AS p FROM ledger_entries WHERE account_id = ? AND id > ? AND amount > 0', [line.account_id, line.statement_entry_id], conn);
    paidSince = Number(r.p);
  }
  const graceLeft = line.debt_since_month === null || debt === 0 ? Number(s.credit_grace_months) : Math.max(0, Number(s.credit_grace_months) - (month - line.debt_since_month));
  return {
    id: line.id,
    status: line.status,
    limit_requested: Number(line.limit_requested),
    limit: line.limit_approved === null ? null : Number(line.limit_approved),
    account_id: line.account_id,
    card_id: line.card_id,
    balance: acc ? Number(acc.balance) : 0,
    debt,
    available: acc ? Number(acc.balance) + Number(acc.credit_limit) : 0,
    autorepay: !!line.autorepay,
    statement_debt: Number(line.statement_debt),
    min_payment: minPayment,
    min_payment_left: Math.max(0, minPayment - paidSince),
    grace_months_left: graceLeft,
    rate_bp: Number(s.credit_rate_bp),
    overdue_count: line.overdue_count,
    decision_note: line.decision_note,
    created_at: line.created_at,
  };
}

// ——— Кредиты ———

export async function applyLoan(conn, user, { amount, months, purpose, payAccountId }) {
  const s = await getSettings();
  if (amount > Number(s.loan_max_amount)) throw bad('amount_too_high', `Сумма кредита не больше ${formatMoney(s.loan_max_amount)}`);
  if (months < 1 || months > Number(s.loan_max_months)) throw bad('invalid_term', `Срок: от 1 до ${s.loan_max_months} игровых месяцев`);
  const pending = await one("SELECT COUNT(*) AS n FROM loans WHERE bank_user_id = ? AND status = 'pending'", [user.id], conn);
  if (Number(pending.n) > 0) throw bad('has_pending', 'Предыдущая заявка ещё на рассмотрении');
  const r = await q('INSERT INTO loans (bank_user_id, purpose, amount_requested, months_requested, pay_account_id) VALUES (?, ?, ?, ?, ?)', [user.id, purpose, amount, months, payAccountId], conn);
  const loan = await one('SELECT * FROM loans WHERE id = ?', [r.insertId], conn);
  // Небольшие кредиты при хорошем рейтинге банк одобряет сам.
  const auto = Number(s.loan_auto_approve_max);
  if (auto > 0 && amount <= auto && Number(user.credit_score) >= 500) {
    await issueLoan(conn, loan, { amount, months, rateBp: Number(s.loan_rate_bp), actor: { kind: 'system', id: 0 }, note: 'Одобрено автоматически' });
  } else {
    afterCommit(conn, () => notifyAdmins('queue', { queue: 'loan', id: loan.id }));
  }
  return one('SELECT * FROM loans WHERE id = ?', [loan.id], conn);
}

/** Выдача кредита: ссудный счёт уходит в минус на сумму кредита, деньги — на счёт клиента. */
export async function issueLoan(conn, loan, { amount, months, rateBp, actor, note = null }) {
  if (loan.status !== 'pending') throw bad('decided', 'Решение уже принято');
  const user = await one('SELECT * FROM bank_users WHERE id = ?', [loan.bank_user_id], conn);
  let pay = loan.pay_account_id ? await one("SELECT * FROM accounts WHERE id = ? AND owner_kind = 'bank_user' AND owner_id = ? AND status = 'active'", [loan.pay_account_id, user.id], conn) : null;
  if (!pay) pay = await primaryAccount(user.id, conn);
  if (!pay) throw bad('no_account', 'У клиента нет расчётного счёта');
  const month = await currentMonth(conn);
  const sched = annuitySchedule(amount, months, rateBp);
  const acc = await createAccount(conn, { userId: user.id, type: 'loan', name: `Кредит №${loan.id}`, creditLimit: amount });
  await post(conn, {
    kind: 'loan_issue',
    memo: `Выдача кредита №${loan.id}`,
    entries: [{ account: acc.id, amount: -amount }, { account: pay.id, amount }],
    ref: { type: 'loan', id: loan.id },
    idem: `loan_issue:${loan.id}`,
    actor,
  });
  for (const row of sched.rows) {
    await q('INSERT INTO loan_schedule (loan_id, n, due_month, principal, interest) VALUES (?, ?, ?, ?, ?)', [loan.id, row.n, month + row.n, row.principal, row.interest], conn);
  }
  await q("UPDATE loans SET status = 'active', amount = ?, months = ?, rate_bp = ?, payment = ?, loan_account_id = ?, pay_account_id = ?, issued_month = ?, decided_by = ?, decision_note = ?, decided_at = NOW(3) WHERE id = ?", [
    amount, months, rateBp, sched.payment, acc.id, pay.id, month, `${actor.kind}:${actor.id}`, note, loan.id,
  ], conn);
  await notify(conn, 'bank', user.id, { title: `Кредит выдан: ${formatMoney(amount)}`, body: `${months} мес., платёж ${formatMoney(sched.payment)} в игровой месяц`, link: '#/credit', email: true });
}

export async function rejectLoan(conn, loan, { actor, note }) {
  if (loan.status !== 'pending') throw bad('decided', 'Решение уже принято');
  await q("UPDATE loans SET status = 'rejected', decided_by = ?, decision_note = ?, decided_at = NOW(3) WHERE id = ?", [`${actor.kind}:${actor.id}`, note, loan.id], conn);
  await notify(conn, 'bank', loan.bank_user_id, { title: 'Кредит: отказ', body: note || 'Банк не одобрил заявку', link: '#/credit', email: true });
}

/** Списать один платёж графика. Ошибка «недостаточно средств» пробрасывается. */
async function payScheduleRow(conn, loan, row, fromAccountId, actor) {
  const total = Number(row.principal) + Number(row.interest) + Number(row.penalty);
  const entries = [{ account: fromAccountId, amount: -total }, { account: loan.loan_account_id, amount: Number(row.principal) }];
  const treasury = Number(row.interest) + Number(row.penalty);
  if (treasury) entries.push({ account: await sys('TREASURY', conn), amount: treasury });
  const r = await post(conn, {
    kind: 'loan_payment',
    memo: `Платёж №${row.n} по кредиту №${loan.id}`,
    entries,
    ref: { type: 'loan', id: loan.id },
    idem: `loan_pay:${row.id}`,
    actor,
  });
  await q("UPDATE loan_schedule SET status = 'paid', tx_id = ?, paid_at = NOW(3) WHERE id = ?", [r.id, row.id], conn);
  return total;
}

async function finishLoanIfDone(conn, loan) {
  const left = await one("SELECT COUNT(*) AS n FROM loan_schedule WHERE loan_id = ? AND status IN ('planned','overdue')", [loan.id], conn);
  if (Number(left.n) > 0) return false;
  await q("UPDATE loans SET status = 'repaid', closed_at = NOW(3) WHERE id = ?", [loan.id], conn);
  await q("UPDATE accounts SET status = 'closed', credit_limit = 0, closed_at = NOW(3) WHERE id = ? AND balance = 0", [loan.loan_account_id], conn);
  await adjustScore(conn, loan.bank_user_id, 30);
  await notify(conn, 'bank', loan.bank_user_id, { title: `Кредит №${loan.id} погашен`, link: '#/credit' });
  return true;
}

/** Внести просроченные платежи сейчас (клиент). */
export async function payOverdue(conn, loan, fromAccountId, actor) {
  const rows = await q("SELECT * FROM loan_schedule WHERE loan_id = ? AND status = 'overdue' ORDER BY n", [loan.id], conn);
  if (!rows.length) throw bad('nothing_due', 'Просроченных платежей нет');
  let paid = 0;
  for (const row of rows) paid += await payScheduleRow(conn, loan, row, fromAccountId, actor);
  await finishLoanIfDone(conn, loan);
  return paid;
}

/** Досрочное погашение: остаток долга + проценты и пени по просроченным платежам. */
export async function repayLoan(conn, loan, fromAccountId, actor) {
  if (loan.status !== 'active') throw bad('invalid_state', 'Кредит не активен');
  const acc = await one('SELECT balance FROM accounts WHERE id = ? FOR UPDATE', [loan.loan_account_id], conn);
  const principal = -Number(acc.balance);
  const due = await one("SELECT COALESCE(SUM(interest + penalty),0) AS x FROM loan_schedule WHERE loan_id = ? AND status = 'overdue'", [loan.id], conn);
  const extra = Number(due.x);
  const entries = [{ account: fromAccountId, amount: -(principal + extra) }];
  if (principal) entries.push({ account: loan.loan_account_id, amount: principal });
  if (extra) entries.push({ account: await sys('TREASURY', conn), amount: extra });
  const r = await post(conn, { kind: 'loan_repay', memo: `Досрочное погашение кредита №${loan.id}`, entries, ref: { type: 'loan', id: loan.id }, actor });
  await q("UPDATE loan_schedule SET status = 'paid', tx_id = ?, paid_at = NOW(3) WHERE loan_id = ? AND status = 'overdue'", [r.id, loan.id], conn);
  await q("UPDATE loan_schedule SET status = 'cancelled' WHERE loan_id = ? AND status = 'planned'", [loan.id], conn);
  await adjustScore(conn, loan.bank_user_id, -10); // досрочное — без бонуса за дисциплину, +30 ниже за погашение
  await finishLoanIfDone(conn, loan);
  return principal + extra;
}

export async function loanView(loan, conn) {
  const rows = await q('SELECT * FROM loan_schedule WHERE loan_id = ? ORDER BY n', [loan.id], conn);
  const acc = loan.loan_account_id ? await one('SELECT balance FROM accounts WHERE id = ?', [loan.loan_account_id], conn) : null;
  const n = (v) => (v === null || v === undefined ? null : Number(v));
  return {
    id: loan.id,
    kind: loan.kind,
    purpose: loan.purpose,
    status: loan.status,
    amount_requested: n(loan.amount_requested),
    months_requested: loan.months_requested,
    amount: n(loan.amount),
    months: loan.months,
    rate_bp: loan.rate_bp,
    payment: n(loan.payment),
    pay_account_id: loan.pay_account_id,
    loan_account_id: loan.loan_account_id,
    principal_left: acc ? Math.max(0, -Number(acc.balance)) : 0,
    overdue: rows.filter((r) => r.status === 'overdue').reduce((x, r) => x + Number(r.principal) + Number(r.interest) + Number(r.penalty), 0),
    issued_month: loan.issued_month,
    decision_note: loan.decision_note,
    created_at: loan.created_at,
    schedule: rows.map((r) => ({ n: r.n, due_month: r.due_month, principal: n(r.principal), interest: n(r.interest), penalty: n(r.penalty), status: r.status })),
  };
}

// ——— Автоплатежи ———

export async function runAutopayment(ap, month) {
  try {
    await tx(async (conn) => {
      const a = await one('SELECT * FROM autopayments WHERE id = ? FOR UPDATE', [ap.id], conn);
      if (a.status !== 'active' || a.next_month > month) return;
      const user = await one('SELECT * FROM bank_users WHERE id = ?', [a.bank_user_id], conn);
      const from = await one('SELECT * FROM accounts WHERE id = ?', [a.from_account_id], conn);
      const to = await one('SELECT * FROM accounts WHERE id = ?', [a.to_account_id], conn);
      if (!to || to.status === 'closed') throw bad('recipient_not_found', 'Счёт получателя закрыт');
      await moveMoney(conn, { user, from, to, amount: Number(a.amount), memo: a.title, kind: a.kind === 'pocket' ? 'pocket_money' : 'autopayment', idem: `ap:${a.id}:${month}` });
      const remaining = a.remaining === null ? null : a.remaining - 1;
      await q('UPDATE autopayments SET last_month = ?, next_month = ?, remaining = ?, status = ?, fails = 0, last_error = NULL WHERE id = ?', [month, month + 1, remaining, remaining === 0 ? 'finished' : 'active', a.id], conn);
    });
  } catch (err) {
    if (!err.statusCode) throw err;
    await tx(async (conn) => {
      const a = await one('SELECT * FROM autopayments WHERE id = ? FOR UPDATE', [ap.id], conn);
      const fails = a.fails + 1;
      await q('UPDATE autopayments SET next_month = ?, fails = ?, last_error = ?, status = ? WHERE id = ?', [month + 1, fails, err.message.slice(0, 200), fails >= 3 ? 'paused' : 'active', a.id], conn);
      await notify(conn, 'bank', a.bank_user_id, { title: `Автоплатёж не прошёл: ${a.title}`, body: `${err.message}${fails >= 3 ? '. Автоплатёж приостановлен после 3 неудач' : ''}`, link: '#/autopay' });
    });
  }
}

// ——— Кешбэк ———

/** Начислить кешбэк за покупку (выплата — в начале следующего игрового месяца). */
export async function accrueCashback(conn, { accountId, shop, goods, saleId }) {
  if (!shop.cashback_category_id || goods <= 0) return 0;
  const acc = await one('SELECT owner_kind, owner_id, type FROM accounts WHERE id = ?', [accountId], conn);
  if (acc?.owner_kind !== 'bank_user' || !['current', 'credit', 'child', 'savings'].includes(acc.type)) return 0;
  const month = await currentMonth(conn);
  const cat = await one('SELECT c.* FROM cashback_choices x JOIN cashback_categories c ON c.id = x.category_id AND c.active = 1 WHERE x.bank_user_id = ? AND x.month = ? AND x.category_id = ?', [acc.owner_id, month, shop.cashback_category_id], conn);
  if (!cat) return 0;
  const amount = percentOf(goods, cat.rate_bp);
  if (amount <= 0) return 0;
  await q('INSERT INTO cashback_accruals (bank_user_id, month, category_id, sale_id, amount) VALUES (?, ?, ?, ?, ?)', [acc.owner_id, month, cat.id, saleId, amount], conn);
  return amount;
}

/** Возврат покупки уменьшает ещё не выплаченный кешбэк. */
export async function revokeCashback(conn, { saleId, accountId, amount, saleTotal }) {
  const acc = await one('SELECT owner_id FROM accounts WHERE id = ?', [accountId], conn);
  if (!acc) return;
  const rows = await q('SELECT category_id, month, SUM(amount) AS s FROM cashback_accruals WHERE sale_id = ? AND bank_user_id = ? AND paid_tx_id IS NULL GROUP BY category_id, month', [saleId, acc.owner_id], conn);
  for (const r of rows) {
    const cut = Math.min(Number(r.s), Math.round((Number(r.s) * amount) / Math.max(1, saleTotal)));
    if (cut > 0) await q('INSERT INTO cashback_accruals (bank_user_id, month, category_id, sale_id, amount) VALUES (?, ?, ?, ?, ?)', [acc.owner_id, r.month, r.category_id, saleId, -cut], conn);
  }
}

// ——— Инфляция ———

export async function priceIndex(conn) {
  const r = await one('SELECT * FROM price_index ORDER BY month DESC LIMIT 1', [], conn);
  return r ? { month: r.month, rate_bp: r.rate_bp, index: Number(r.index_ppm) / 1e6 } : { month: 0, rate_bp: 0, index: 1 };
}

// ——— Ежемесячные события ———

// Обслуживание карт (дебетовые, кредитные, детские; подарочные — бесплатно).
onMonth('card_fees', async (month, s) => {
  const fee = Number(s.card_monthly_fee || 0);
  if (fee <= 0) return;
  const cards = await q("SELECT id, account_id, bank_user_id, number, type FROM cards WHERE status IN ('active','frozen') AND type IN ('debit','credit','child')");
  for (const c of cards) {
    await tx(async (conn) => {
      await post(conn, {
        kind: 'card_fee',
        memo: `Обслуживание карты •••• ${c.number.slice(-4)}`,
        entries: [{ account: c.account_id, amount: -fee }, { account: await sys('TREASURY', conn), amount: fee }],
        idem: `tick:${month}:cardfee:${c.id}`,
        cardId: c.id,
        force: true,
        overLimit: c.type === 'credit',
      });
    }).catch((e) => {
      if (e.code === 'insufficient_funds') return tx((conn) => notify(conn, 'bank', c.bank_user_id, { title: 'Не списана плата за обслуживание карты', body: `•••• ${c.number.slice(-4)}: недостаточно средств` }));
      console.error('card_fee', c.id, e.message);
      return null;
    });
  }
});

// Кредитные карты: минимальный платёж, штраф за просрочку, проценты после льготного периода, новая выписка.
onMonth('credit_cards', async (month, s) => {
  const lines = await q("SELECT * FROM credit_lines WHERE status = 'active' AND (statement_month IS NULL OR statement_month < ?)", [month]);
  for (const l of lines) {
    await tx(async (conn) => {
      const line = await one('SELECT * FROM credit_lines WHERE id = ? FOR UPDATE', [l.id], conn);
      if (line.status !== 'active' || (line.statement_month !== null && line.statement_month >= month)) return;
      const accId = line.account_id;
      const treasury = await sys('TREASURY', conn);
      const prevDebt = Number(line.statement_debt);
      if (prevDebt > 0) {
        const required = Math.max(1, percentOf(prevDebt, Number(s.credit_min_payment_bp)));
        const paidRow = await one('SELECT COALESCE(SUM(amount),0) AS p FROM ledger_entries WHERE account_id = ? AND id > ? AND amount > 0', [accId, line.statement_entry_id], conn);
        let paid = Number(paidRow.p);
        if (paid < required && line.autorepay) {
          const primary = await primaryAccount(line.bank_user_id, conn);
          if (primary && primary.status === 'active') {
            const take = Math.min(required - paid, Math.max(0, Number(primary.balance)));
            if (take > 0) {
              await post(conn, { kind: 'credit_repay', memo: 'Автопогашение кредитной карты', entries: [{ account: primary.id, amount: -take }, { account: accId, amount: take }], idem: `tick:${month}:cc_auto:${line.id}` });
              paid += take;
            }
          }
        }
        if (paid < required) {
          const fee = Number(s.credit_late_fee || 0);
          if (fee > 0) await post(conn, { kind: 'credit_penalty', memo: 'Штраф за просрочку по кредитной карте', entries: [{ account: accId, amount: -fee }, { account: treasury, amount: fee }], idem: `tick:${month}:cc_fee:${line.id}`, force: true, overLimit: true });
          await q('UPDATE credit_lines SET overdue_count = overdue_count + 1 WHERE id = ?', [line.id], conn);
          await adjustScore(conn, line.bank_user_id, -40);
          await notify(conn, 'bank', line.bank_user_id, { title: 'Просрочка по кредитной карте', body: `Не внесён минимальный платёж ${formatMoney(required)}${fee ? `. Штраф ${formatMoney(fee)}` : ''}`, link: '#/credit', email: true });
        } else {
          await adjustScore(conn, line.bank_user_id, 5);
        }
      }
      // Проценты: только после льготного периода с момента появления долга.
      let acc = await one('SELECT balance FROM accounts WHERE id = ?', [accId], conn);
      let debt = Math.max(0, -Number(acc.balance));
      let since = line.debt_since_month;
      if (debt === 0) since = null;
      else if (since === null) since = month - 1; // долг появился в прошедшем месяце
      if (debt > 0 && month - since > Number(s.credit_grace_months)) {
        const interest = percentOf(debt, Number(s.credit_rate_bp));
        if (interest > 0) {
          await post(conn, { kind: 'credit_interest', memo: 'Проценты по кредитной карте', entries: [{ account: accId, amount: -interest }, { account: treasury, amount: interest }], idem: `tick:${month}:cc_int:${line.id}`, force: true, overLimit: true });
          acc = await one('SELECT balance FROM accounts WHERE id = ?', [accId], conn);
          debt = Math.max(0, -Number(acc.balance));
        }
      }
      const last = await one('SELECT COALESCE(MAX(id),0) AS id FROM ledger_entries WHERE account_id = ?', [accId], conn);
      await q('UPDATE credit_lines SET debt_since_month = ?, statement_debt = ?, statement_month = ?, statement_entry_id = ? WHERE id = ?', [since, debt, month, last.id, line.id], conn);
      if (debt > 0) {
        const min = Math.max(1, percentOf(debt, Number(s.credit_min_payment_bp)));
        await notify(conn, 'bank', line.bank_user_id, { title: `Выписка по кредитной карте: долг ${formatMoney(debt)}`, body: `Минимальный платёж ${formatMoney(min)} — до следующего игрового месяца`, link: '#/credit' });
      }
    }).catch((e) => console.error('credit_cards', l.id, e.message));
  }
});

// Кредиты: автосписание платежей по графику, пени за просрочку.
onMonth('loans', async (month, s) => {
  const rows = await q("SELECT r.*, l.bank_user_id FROM loan_schedule r JOIN loans l ON l.id = r.loan_id AND l.status = 'active' WHERE r.status IN ('planned','overdue') AND r.due_month <= ? ORDER BY r.loan_id, r.n", [month]);
  for (const row of rows) {
    try {
      await tx(async (conn) => {
        const loan = await one('SELECT * FROM loans WHERE id = ? FOR UPDATE', [row.loan_id], conn);
        const fresh = await one('SELECT * FROM loan_schedule WHERE id = ?', [row.id], conn);
        if (loan.status !== 'active' || !['planned', 'overdue'].includes(fresh.status)) return;
        let from = await one("SELECT * FROM accounts WHERE id = ? AND status = 'active'", [loan.pay_account_id], conn);
        if (!from) from = await primaryAccount(loan.bank_user_id, conn);
        if (!from) throw bad('no_account', 'Нет счёта для списания');
        const total = await payScheduleRow(conn, loan, fresh, from.id, { kind: 'system', id: 0 });
        if (fresh.status === 'planned') await adjustScore(conn, loan.bank_user_id, 5);
        if (!(await finishLoanIfDone(conn, loan))) {
          await notify(conn, 'bank', loan.bank_user_id, { title: `Списан платёж по кредиту ${formatMoney(total)}`, body: `Кредит №${loan.id}, платёж №${fresh.n}`, link: '#/credit' });
        }
      });
    } catch (err) {
      if (!err.statusCode) { console.error('loans', row.id, err.message); continue; }
      await tx(async (conn) => {
        const fresh = await one('SELECT * FROM loan_schedule WHERE id = ? FOR UPDATE', [row.id], conn);
        if (fresh.penalty_month !== null && fresh.penalty_month >= month) return;
        const penalty = percentOf(Number(fresh.principal) + Number(fresh.interest), Number(s.loan_late_fee_bp));
        await q("UPDATE loan_schedule SET status = 'overdue', penalty = penalty + ?, penalty_month = ? WHERE id = ?", [penalty, month, row.id], conn);
        await adjustScore(conn, row.bank_user_id, fresh.status === 'planned' ? -50 : -20);
        await notify(conn, 'bank', row.bank_user_id, { title: 'Просрочен платёж по кредиту', body: `Кредит №${row.loan_id}, платёж №${fresh.n}: ${err.message}${penalty ? `. Пени ${formatMoney(penalty)}` : ''}`, link: '#/credit', email: true });
      }).catch((e) => console.error('loans overdue', row.id, e.message));
    }
  }
});

// Автоплатежи, подписки, карманные деньги.
onMonth('autopayments', async (month) => {
  const due = await q("SELECT id FROM autopayments WHERE status = 'active' AND next_month <= ? ORDER BY id", [month]);
  for (const ap of due) await runAutopayment(ap, month).catch((e) => console.error('autopayment', ap.id, e.message));
});

// Кешбэк за прошедшие месяцы: выплата из казны на основной счёт, не больше лимита в месяц.
onMonth('cashback', async (month, s) => {
  const cap = Number(s.cashback_cap || 0);
  const groups = await q('SELECT bank_user_id, month, SUM(amount) AS s FROM cashback_accruals WHERE month < ? AND paid_tx_id IS NULL GROUP BY bank_user_id, month', [month]);
  for (const g of groups) {
    await tx(async (conn) => {
      let amount = Math.max(0, Number(g.s));
      if (cap > 0) amount = Math.min(amount, cap);
      let txId = 0;
      const target = await primaryAccount(g.bank_user_id, conn);
      if (amount > 0 && target) {
        const r = await post(conn, {
          kind: 'cashback',
          memo: 'Кешбэк за покупки',
          entries: [{ account: await sys('TREASURY', conn), amount: -amount }, { account: target.id, amount }],
          idem: `cashback:${g.bank_user_id}:${g.month}`,
          force: true,
        });
        txId = r.id;
        if (!r.duplicate) await notify(conn, 'bank', g.bank_user_id, { title: `Кешбэк ${formatMoney(amount)}`, body: 'Выберите категории на новый месяц', link: '#/cashback' });
      }
      await q('UPDATE cashback_accruals SET paid_tx_id = ? WHERE bank_user_id = ? AND month = ? AND paid_tx_id IS NULL', [txId, g.bank_user_id, g.month], conn);
    }).catch((e) => console.error('cashback', g.bank_user_id, e.message));
  }
});

// Инфляция: индекс цен растёт на ставку админа (оптовые цены — этап 7).
onMonth('inflation', async (month, s) => {
  const prev = await one('SELECT index_ppm FROM price_index WHERE month < ? ORDER BY month DESC LIMIT 1', [month]);
  const rate = Number(s.inflation_bp || 0);
  const base = prev ? Number(prev.index_ppm) : 1e6;
  await q('INSERT IGNORE INTO price_index (month, rate_bp, index_ppm) VALUES (?, ?, ?)', [month, rate, Math.round((base * (10000 + rate)) / 10000)]);
});
