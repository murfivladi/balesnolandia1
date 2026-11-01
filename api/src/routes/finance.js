// Этап 6, ВлодБанк: кредиты, кредитные / детские / подарочные карты, автоплатежи, кешбэк.
import { tx, q, one } from '../db.js';
import { bad, notFound, forbidden, int, str, amount as amountOf, email as emailOf } from '../lib/errors.js';
import { needBank, actorOf, hash } from '../lib/auth.js';
import { getSettings } from '../lib/settings.js';
import { currentMonth } from '../lib/clock.js';
import { post, sys } from '../lib/ledger.js';
import { notify } from '../lib/notify.js';
import { audit } from '../lib/audit.js';
import { requireVerified, ownAccount, primaryAccount, issueCard, cardView, checkPinFormat, authorizeCard, assertSpendable } from '../lib/bank.js';
import {
  createAccount, applyCreditLine, creditLineView, applyLoan, loanView, repayLoan, payOverdue, scoreLevel, runAutopayment, moveMoney,
} from '../lib/finance.js';
import { annuitySchedule, formatMoney } from '@bln/shared/money.js';

const BACKGROUNDS = ['classic', 'waves', 'grid', 'sunset', 'forest', 'night', 'gold', 'mint'];
const bg = (v) => (BACKGROUNDS.includes(v) ? v : 'classic');
const limited = (max) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });
const optAmount = (v, n) => (v === null || v === undefined || v === '' || Number(v) === 0 ? null : amountOf(v, n));

async function user(req, conn) {
  const u = await one('SELECT * FROM bank_users WHERE id = ?', [req.bank.id], conn);
  requireVerified(u);
  return u;
}

function autopayView(a) {
  return {
    id: a.id, kind: a.kind, title: a.title, from_account_id: a.from_account_id, to_account_id: a.to_account_id, to_name: a.to_name, to_number: a.to_number,
    amount: Number(a.amount), remaining: a.remaining, status: a.status, next_month: a.next_month, last_month: a.last_month, last_error: a.last_error, card_id: a.card_id,
  };
}

export async function financeRoutes(app) {
  const auth = { preHandler: needBank() };

  // ——— Кредиты и кредитная карта ———
  app.get('/credit', auth, async (req) => {
    const u = await one('SELECT credit_score FROM bank_users WHERE id = ?', [req.bank.id]);
    const line = await one("SELECT * FROM credit_lines WHERE bank_user_id = ? ORDER BY status IN ('active','pending') DESC, id DESC LIMIT 1", [req.bank.id]);
    const loans = await q("SELECT * FROM loans WHERE bank_user_id = ? ORDER BY status = 'active' DESC, id DESC LIMIT 30", [req.bank.id]);
    const s = await getSettings();
    return {
      score: u.credit_score,
      level: scoreLevel(u.credit_score),
      month: await currentMonth(),
      credit_line: line ? await creditLineView(line) : null,
      loans: await Promise.all(loans.map((l) => loanView(l))),
      terms: {
        loan_rate_bp: s.loan_rate_bp, loan_max_amount: s.loan_max_amount, loan_max_months: s.loan_max_months, loan_late_fee_bp: s.loan_late_fee_bp,
        credit_rate_bp: s.credit_rate_bp, credit_grace_months: s.credit_grace_months, credit_min_payment_bp: s.credit_min_payment_bp,
        credit_late_fee: s.credit_late_fee, credit_max_limit: s.credit_max_limit,
      },
    };
  });

  app.post('/credit-lines', { ...auth, ...limited(5) }, async (req) => {
    const b = req.body || {};
    const limit = amountOf(b.limit, 'лимит');
    const pinHash = await hash(checkPinFormat(b.pin));
    const id = await tx(async (conn) => {
      const u = await user(req, conn);
      if (!(await primaryAccount(u.id, conn))) throw bad('need_current', 'Сначала откройте расчётный счёт');
      const lineId = await applyCreditLine(conn, u, { limit, pinHash, background: bg(b.background) });
      await audit(conn, actorOf(req.bank), 'bank.credit_apply', 'credit_line', lineId, { limit });
      return lineId;
    });
    return { credit_line: await creditLineView(await one('SELECT * FROM credit_lines WHERE id = ?', [id])) };
  });

  app.post('/credit-lines/:id/autorepay', auth, async (req) => {
    const r = await q('UPDATE credit_lines SET autorepay = ? WHERE id = ? AND bank_user_id = ?', [req.body?.on ? 1 : 0, int(req.params.id, 'id'), req.bank.id]);
    if (!r.affectedRows) throw notFound();
    return { ok: true };
  });

  app.post('/loans/preview', auth, async (req) => {
    const s = await getSettings();
    const amount = amountOf(req.body?.amount);
    const months = int(req.body?.months, 'срок', { min: 1, max: Number(s.loan_max_months) });
    const sched = annuitySchedule(amount, months, Number(s.loan_rate_bp));
    return { amount, months, rate_bp: s.loan_rate_bp, payment: sched.payment, total: sched.total, overpay: sched.total - amount, rows: sched.rows };
  });

  app.post('/loans', { ...auth, ...limited(5) }, async (req) => {
    const b = req.body || {};
    const amount = amountOf(b.amount);
    const months = int(b.months, 'срок', { min: 1, max: 600 });
    const purpose = str(b.purpose, 'цель', { optional: true, max: 140 });
    const loan = await tx(async (conn) => {
      const u = await user(req, conn);
      const pay = b.pay_account_id ? await ownAccount(u.id, int(b.pay_account_id, 'счёт'), conn) : await primaryAccount(u.id, conn);
      if (!pay || !['current', 'business'].includes(pay.type)) throw bad('need_current', 'Кредит зачисляется на расчётный или бизнес-счёт');
      const l = await applyLoan(conn, u, { amount, months, purpose, payAccountId: pay.id });
      await audit(conn, actorOf(req.bank), 'bank.loan_apply', 'loan', l.id, { amount, months });
      return l;
    });
    return { loan: await loanView(loan) };
  });

  async function myLoan(req, conn) {
    const l = await one('SELECT * FROM loans WHERE id = ? AND bank_user_id = ? FOR UPDATE', [int(req.params.id, 'id'), req.bank.id], conn);
    if (!l) throw notFound('Кредит не найден');
    return l;
  }

  app.post('/loans/:id/cancel', auth, async (req) => {
    await tx(async (conn) => {
      const l = await myLoan(req, conn);
      if (l.status !== 'pending') throw bad('invalid_state', 'Заявку уже рассмотрели');
      await q("UPDATE loans SET status = 'cancelled', closed_at = NOW(3) WHERE id = ?", [l.id], conn);
    });
    return { ok: true };
  });

  for (const action of ['repay', 'pay-overdue']) {
    app.post(`/loans/:id/${action}`, { ...auth, ...limited(10) }, async (req) => {
      const paid = await tx(async (conn) => {
        const u = await user(req, conn);
        const l = await myLoan(req, conn);
        if (l.status !== 'active') throw bad('invalid_state', 'Кредит не активен');
        const from = await ownAccount(u.id, int(req.body?.account_id, 'счёт'), conn);
        assertSpendable(from);
        const sum = action === 'repay' ? await repayLoan(conn, l, from.id, actorOf(req.bank)) : await payOverdue(conn, l, from.id, actorOf(req.bank));
        await audit(conn, actorOf(req.bank), `bank.loan_${action}`, 'loan', l.id, { amount: sum });
        return sum;
      });
      return { ok: true, paid };
    });
  }

  // ——— Детская карта: счёт родителя, держатель — ребёнок, карманные каждый месяц ———
  app.post('/child-cards', { ...auth, ...limited(10) }, async (req) => {
    const b = req.body || {};
    const childName = str(b.child_name, 'имя ребёнка', { min: 2, max: 60 });
    const pocket = optAmount(b.pocket_amount, 'карманные');
    const res = await tx(async (conn) => {
      const u = await user(req, conn);
      const primary = await primaryAccount(u.id, conn);
      if (!primary) throw bad('need_current', 'Сначала откройте расчётный счёт');
      let holderUserId = null;
      if (b.child_email) {
        const child = await one('SELECT id FROM bank_users WHERE email = ?', [emailOf(b.child_email)], conn);
        if (!child) throw bad('child_not_found', 'Клиент с таким email не найден во ВлодБанке');
        if (child.id === u.id) throw bad('invalid', 'Это ваш собственный email');
        holderUserId = child.id;
      }
      const acc = await createAccount(conn, { userId: u.id, type: 'child', name: `Детская карта: ${childName}` });
      const card = await issueCard(conn, { user: u, account: acc, pin: b.pin, type: 'child', background: bg(b.background), holderName: childName, holderUserId });
      await q('UPDATE cards SET limit_tx = ?, limit_daily = ? WHERE id = ?', [optAmount(b.limit_tx, 'лимит на операцию'), optAmount(b.limit_daily, 'дневной лимит'), card.id], conn);
      let started = false;
      if (pocket) {
        const month = await currentMonth(conn);
        const r = await q("INSERT INTO autopayments (bank_user_id, kind, title, from_account_id, to_account_id, amount, next_month, card_id) VALUES (?, 'pocket', ?, ?, ?, ?, ?, ?)", [u.id, `Карманные: ${childName}`, primary.id, acc.id, pocket, month, card.id], conn);
        // Автостарт: первые карманные — сразу, дальше каждый игровой месяц.
        try {
          await moveMoney(conn, { user: u, from: primary, to: acc, amount: pocket, memo: `Карманные: ${childName}`, kind: 'pocket_money', idem: `ap:${r.insertId}:${month}` });
          await q('UPDATE autopayments SET last_month = ?, next_month = ? WHERE id = ?', [month, month + 1, r.insertId], conn);
          started = true;
        } catch (err) {
          if (err.code !== 'insufficient_funds') throw err;
          await q('UPDATE autopayments SET next_month = ? WHERE id = ?', [month + 1, r.insertId], conn);
        }
      }
      if (holderUserId) await notify(conn, 'bank', holderUserId, { title: 'Вам выпущена детская карта', body: `•••• ${card.number.slice(-4)} от ${u.full_name}`, link: '#/cards' });
      await audit(conn, actorOf(req.bank), 'bank.child_card', 'card', card.id, { pocket });
      return { card: await one('SELECT c.*, a.balance, a.credit_limit FROM cards c JOIN accounts a ON a.id = c.account_id WHERE c.id = ?', [card.id], conn), started };
    });
    return { card: cardView(res.card), pocket_started: res.started };
  });

  app.post('/cards/:id/pocket', auth, async (req) => {
    const amount = optAmount(req.body?.amount, 'карманные');
    await tx(async (conn) => {
      const c = await one("SELECT * FROM cards WHERE id = ? AND bank_user_id = ? AND type = 'child'", [int(req.params.id, 'id'), req.bank.id], conn);
      if (!c) throw notFound('Детская карта не найдена');
      const ap = await one("SELECT * FROM autopayments WHERE card_id = ? AND kind = 'pocket' AND status IN ('active','paused') ORDER BY id DESC LIMIT 1", [c.id], conn);
      if (!amount) {
        if (ap) await q("UPDATE autopayments SET status = 'cancelled' WHERE id = ?", [ap.id], conn);
        return;
      }
      if (ap) {
        await q("UPDATE autopayments SET amount = ?, status = 'active', fails = 0 WHERE id = ?", [amount, ap.id], conn);
      } else {
        const primary = await primaryAccount(req.bank.id, conn);
        if (!primary) throw bad('need_current', 'Нет расчётного счёта');
        await q("INSERT INTO autopayments (bank_user_id, kind, title, from_account_id, to_account_id, amount, next_month, card_id) VALUES (?, 'pocket', ?, ?, ?, ?, ?, ?)", [req.bank.id, `Карманные: ${c.holder_name}`, primary.id, c.account_id, amount, (await currentMonth(conn)) + 1, c.id], conn);
      }
    });
    return { ok: true };
  });

  // ——— Подарочные карты ———
  app.post('/gift-cards', { ...auth, ...limited(10) }, async (req) => {
    const b = req.body || {};
    const amount = amountOf(b.amount);
    const card = await tx(async (conn) => {
      const u = await user(req, conn);
      const from = await ownAccount(u.id, int(b.from_account, 'счёт оплаты'), conn);
      assertSpendable(from);
      const s = await getSettings();
      const fee = Number(s.gift_card_fee || 0);
      const acc = await createAccount(conn, { userId: u.id, type: 'gift', name: 'Подарочная карта' });
      const entries = [{ account: from.id, amount: -(amount + fee) }, { account: acc.id, amount }];
      if (fee) entries.push({ account: await sys('TREASURY', conn), amount: fee });
      await post(conn, { kind: 'gift_purchase', memo: `Подарочная карта на ${formatMoney(amount)}`, entries, actor: actorOf(req.bank) });
      const c = await issueCard(conn, { user: u, account: acc, pin: b.pin, type: 'gift', background: bg(b.background || 'gold'), chargeFee: false, holderName: str(b.holder, 'кому', { optional: true, max: 60 }) || 'GIFT' });
      await audit(conn, actorOf(req.bank), 'bank.gift_card', 'card', c.id, { amount });
      return one('SELECT c.*, a.balance, a.credit_limit FROM cards c JOIN accounts a ON a.id = c.account_id WHERE c.id = ?', [c.id], conn);
    });
    return { card: cardView(card) };
  });

  // Зачислить подарочную карту на свой счёт: номер + PIN, весь остаток переходит на счёт.
  app.post('/gift-cards/redeem', { ...auth, ...limited(10) }, async (req) => {
    const b = req.body || {};
    const card = await authorizeCard({ number: b.number, pin: b.pin });
    if (card.type !== 'gift') throw bad('not_gift', 'Это не подарочная карта');
    const amount = await tx(async (conn) => {
      const u = await user(req, conn);
      const to = await ownAccount(u.id, int(b.account_id, 'счёт зачисления'), conn);
      if (!['current', 'savings', 'business'].includes(to.type) || to.status === 'closed') throw bad('invalid_account', 'Выберите расчётный или накопительный счёт');
      const gift = await one('SELECT * FROM accounts WHERE id = ? FOR UPDATE', [card.account_id], conn);
      const sum = Number(gift.balance);
      if (sum <= 0) throw bad('gift_empty', 'На подарочной карте нет денег');
      await post(conn, { kind: 'gift_redeem', memo: 'Зачисление подарочной карты', entries: [{ account: gift.id, amount: -sum }, { account: to.id, amount: sum }], actor: actorOf(req.bank), cardId: card.id, force: true });
      await q("UPDATE cards SET status = 'blocked' WHERE id = ?", [card.id], conn);
      await q("UPDATE accounts SET status = 'closed', closed_at = NOW(3) WHERE id = ?", [gift.id], conn);
      if (gift.owner_id !== u.id) await notify(conn, 'bank', gift.owner_id, { title: 'Подарочная карта активирована', body: `•••• ${card.number.slice(-4)}: ${formatMoney(sum)} получил(а) ${u.full_name}` });
      await audit(conn, actorOf(req.bank), 'bank.gift_redeem', 'card', card.id, { amount: sum });
      return sum;
    });
    return { ok: true, amount };
  });

  // ——— Автоплатежи и подписки ———
  app.get('/autopayments', auth, async (req) => {
    const rows = await q(
      `SELECT ap.*, a.name AS to_name, a.number AS to_number FROM autopayments ap JOIN accounts a ON a.id = ap.to_account_id
       WHERE ap.bank_user_id = ? AND ap.status <> 'cancelled' ORDER BY ap.status = 'active' DESC, ap.id DESC`,
      [req.bank.id],
    );
    // Для чужих счетов показываем имя владельца, а не название счёта.
    for (const r of rows) {
      const acc = await one('SELECT owner_id FROM accounts WHERE id = ?', [r.to_account_id]);
      if (acc && acc.owner_id !== req.bank.id) r.to_name = (await one('SELECT full_name FROM bank_users WHERE id = ?', [acc.owner_id]))?.full_name || r.to_name;
    }
    return { autopayments: rows.map(autopayView), month: await currentMonth() };
  });

  app.post('/autopayments', { ...auth, ...limited(20) }, async (req) => {
    const b = req.body || {};
    const amount = amountOf(b.amount);
    const title = str(b.title, 'название', { min: 2, max: 80 });
    const remaining = b.remaining ? int(b.remaining, 'число платежей', { min: 1, max: 600 }) : null;
    const kind = b.kind === 'subscription' ? 'subscription' : 'transfer';
    const id = await tx(async (conn) => {
      const u = await user(req, conn);
      const from = await ownAccount(u.id, int(b.from_account, 'счёт списания'), conn);
      assertSpendable(from);
      const to = await resolveTarget(conn, b.to, u.id);
      if (to.id === from.id) throw bad('same_account', 'Нельзя перевести на тот же счёт');
      const month = await currentMonth(conn);
      const r = await q('INSERT INTO autopayments (bank_user_id, kind, title, from_account_id, to_account_id, amount, remaining, next_month) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [u.id, kind, title, from.id, to.id, amount, remaining, b.start_now ? month : month + 1], conn);
      await audit(conn, actorOf(req.bank), 'bank.autopay_create', 'autopayment', r.insertId, { amount });
      return r.insertId;
    });
    if (b.start_now) await runAutopayment({ id }, await currentMonth());
    const row = await one('SELECT ap.*, a.name AS to_name, a.number AS to_number FROM autopayments ap JOIN accounts a ON a.id = ap.to_account_id WHERE ap.id = ?', [id]);
    return { autopayment: autopayView(row) };
  });

  app.post('/autopayments/:id/status', auth, async (req) => {
    const status = String(req.body?.status || '');
    if (!['active', 'paused', 'cancelled'].includes(status)) throw bad('invalid', 'Статус: active, paused, cancelled');
    const ap = await one('SELECT * FROM autopayments WHERE id = ? AND bank_user_id = ?', [int(req.params.id, 'id'), req.bank.id]);
    if (!ap) throw notFound();
    if (['finished', 'cancelled'].includes(ap.status)) throw bad('invalid_state', 'Автоплатёж завершён');
    const month = await currentMonth();
    await q('UPDATE autopayments SET status = ?, fails = 0, next_month = GREATEST(next_month, ?) WHERE id = ?', [status, status === 'active' ? month + 1 : ap.next_month, ap.id]);
    return { ok: true };
  });

  // ——— Кешбэк ———
  app.get('/cashback', auth, async (req) => {
    const month = await currentMonth();
    const s = await getSettings();
    const categories = await q('SELECT id, name, rate_bp FROM cashback_categories WHERE active = 1 ORDER BY sort, id');
    const chosen = await q('SELECT category_id FROM cashback_choices WHERE bank_user_id = ? AND month = ?', [req.bank.id, month]);
    const acc = await one('SELECT COALESCE(SUM(amount),0) AS s FROM cashback_accruals WHERE bank_user_id = ? AND month = ?', [req.bank.id, month]);
    const history = await q("SELECT t.id, t.created_at, e.amount FROM ledger_tx t JOIN ledger_entries e ON e.tx_id = t.id AND e.amount > 0 JOIN accounts a ON a.id = e.account_id AND a.owner_kind = 'bank_user' AND a.owner_id = ? WHERE t.kind = 'cashback' ORDER BY t.id DESC LIMIT 12", [req.bank.id]);
    return {
      month,
      max: Number(s.cashback_max_categories),
      cap: Number(s.cashback_cap),
      categories,
      chosen: chosen.map((c) => c.category_id),
      accrued: Math.max(0, Number(acc.s)),
      history: history.map((h) => ({ ...h, amount: Number(h.amount) })),
    };
  });

  app.post('/cashback', auth, async (req) => {
    const ids = [...new Set((Array.isArray(req.body?.category_ids) ? req.body.category_ids : []).map(Number).filter(Number.isSafeInteger))];
    const s = await getSettings();
    if (!ids.length) throw bad('invalid', 'Выберите хотя бы одну категорию');
    if (ids.length > Number(s.cashback_max_categories)) throw bad('too_many', `Можно выбрать не больше ${s.cashback_max_categories} категорий`);
    await tx(async (conn) => {
      await user(req, conn);
      const month = await currentMonth(conn);
      const prev = await one('SELECT COUNT(*) AS n FROM cashback_choices WHERE bank_user_id = ? AND month = ?', [req.bank.id, month], conn);
      if (Number(prev.n) > 0) throw bad('already_chosen', 'Категории на этот месяц уже выбраны — новый выбор в следующем игровом месяце');
      const ok = await q(`SELECT id FROM cashback_categories WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')})`, ids, conn);
      if (ok.length !== ids.length) throw bad('invalid', 'Неизвестная категория');
      for (const id of ids) await q('INSERT INTO cashback_choices (bank_user_id, month, category_id) VALUES (?, ?, ?)', [req.bank.id, month, id], conn);
    });
    return { ok: true };
  });
}

/** Получатель автоплатежа: номер карты или счёта. */
async function resolveTarget(conn, to, userId) {
  const value = String(to?.value ?? '').trim();
  let acc = null;
  if (to?.type === 'card') {
    const c = await one('SELECT * FROM cards WHERE number = ?', [value.replace(/\D/g, '')], conn);
    if (c && ['active', 'frozen'].includes(c.status) && c.type !== 'gift') acc = await one('SELECT * FROM accounts WHERE id = ?', [c.account_id], conn);
  } else if (to?.type === 'account' || to?.type === 'own') {
    acc = await one("SELECT * FROM accounts WHERE (number = ? OR id = ?) AND owner_kind = 'bank_user'", [value.toUpperCase(), to.type === 'own' ? Number(value) || 0 : 0], conn);
    if (acc && to.type === 'own' && acc.owner_id !== userId) throw forbidden();
  }
  if (!acc || acc.status === 'closed' || ['loan', 'gift'].includes(acc.type)) throw bad('recipient_not_found', 'Счёт получателя не найден');
  return acc;
}

