import jwt from 'jsonwebtoken';
import { tx, q, one } from '../db.js';
import { config } from '../config.js';
import { bad, notFound, forbidden, unauthorized, int, str, amount as amountOf, need, idemKey } from '../lib/errors.js';
import { needBank, needRole, actorOf } from '../lib/auth.js';
import { getSettings } from '../lib/settings.js';
import { post, sys, findIdem } from '../lib/ledger.js';
import { notify } from '../lib/notify.js';
import { audit } from '../lib/audit.js';
import { payInvoice } from '../lib/gov.js';
import { requestPassportLink, publicBankUser } from './auth.js';
import {
  requireVerified, primaryAccount, ownAccount, openAccount, issueCard, cardView, accountView, authorizeCard,
  checkCardLimits, transferFee, checkPinFormat, ipOf, assertSpendable,
} from '../lib/bank.js';
import { payQr, qrInfo, receiptData } from '../lib/pos.js';
import { moveMoney, transferSuspicion, addFraud, reviewIfLarge } from '../lib/finance.js';
import { hash } from '../lib/auth.js';
import { formatMoney, percentOf } from '@bln/shared/money.js';
import { normalizePassport } from '@bln/shared/format.js';

const BACKGROUNDS = ['classic', 'waves', 'grid', 'sunset', 'forest', 'night', 'gold', 'mint'];
const limited = (max) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

async function freshUser(id, conn) {
  return one('SELECT * FROM bank_users WHERE id = ?', [id], conn);
}

/** Получатель перевода → счёт зачисления. */
async function resolveRecipient(conn, to, userId) {
  const type = to?.type;
  const value = String(to?.value ?? '').trim();
  if (type === 'card') {
    const c = await one('SELECT * FROM cards WHERE number = ?', [value.replace(/\D/g, '')], conn);
    if (!c || !['active', 'frozen'].includes(c.status)) throw bad('recipient_not_found', 'Карта получателя не найдена');
    if (c.type === 'gift') throw bad('recipient_gift', 'На подарочную карту переводить нельзя');
    return one('SELECT * FROM accounts WHERE id = ?', [c.account_id], conn);
  }
  if (type === 'account' || type === 'own') {
    const a = await one("SELECT * FROM accounts WHERE (number = ? OR id = ?) AND owner_kind = 'bank_user'", [value.toUpperCase(), type === 'own' ? Number(value) || 0 : 0], conn);
    if (!a || a.status === 'closed') throw bad('recipient_not_found', 'Счёт получателя не найден');
    if (type === 'own' && a.owner_id !== userId) throw forbidden();
    if (a.type === 'loan') throw bad('recipient_loan', 'Кредит погашается по графику или досрочно в разделе «Кредиты»');
    if (a.type === 'gift') throw bad('recipient_gift', 'На подарочную карту переводить нельзя');
    return a;
  }
  if (type === 'user') {
    const a = await primaryAccount(Number(value), conn);
    if (!a) throw bad('recipient_not_found', 'У получателя нет расчётного счёта');
    return a;
  }
  throw bad('invalid', 'Укажите получателя');
}

/** Карты клиента: свои и детские, где он держатель (ребёнок видит свою карту, управляет родитель). */
async function myCards(userId) {
  const rows = await q(
    "SELECT c.*, a.balance, a.credit_limit FROM cards c JOIN accounts a ON a.id = c.account_id WHERE (c.bank_user_id = ? OR c.holder_user_id = ?) AND c.status <> 'reissued' ORDER BY c.id DESC",
    [userId, userId],
  );
  return rows.map((c) => ({ ...cardView(c), managed_by_parent: c.bank_user_id !== userId }));
}

export async function bankRoutes(app) {
  const auth = { preHandler: needBank() };

  app.get('/overview', auth, async (req) => {
    const accounts = await q("SELECT * FROM accounts WHERE owner_kind = 'bank_user' AND owner_id = ? AND status <> 'closed' ORDER BY is_primary DESC, type, id", [req.bank.id]);
    const cards = await myCards(req.bank.id);
    const link = await one("SELECT status, created_at FROM passport_links WHERE bank_user_id = ? ORDER BY id DESC LIMIT 1", [req.bank.id]);
    const recent = await q(
      `SELECT t.id, t.kind, t.memo, t.created_at, e.amount, e.account_id FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id
       WHERE e.account_id IN (SELECT id FROM accounts WHERE owner_kind = 'bank_user' AND owner_id = ?) ORDER BY e.id DESC LIMIT 10`,
      [req.bank.id],
    );
    return {
      user: publicBankUser(await freshUser(req.bank.id), req.bank.roles),
      accounts: accounts.map(accountView),
      cards,
      passport_link: link,
      has_ip: !!(await ipOf(req.bank.user)),
      recent: recent.map((r) => ({ ...r, amount: Number(r.amount) })),
    };
  });

  app.post('/profile/passport', { ...auth, ...limited(5) }, async (req) => {
    const no = normalizePassport(req.body?.passport_no);
    need(no, 'Номер паспорта: BLN-XXXX-XXXX');
    await tx(async (conn) => {
      const u = await freshUser(req.bank.id, conn);
      if (u.passport_verified) throw bad('already_verified', 'Паспорт уже подтверждён');
      await requestPassportLink(conn, u, no);
    });
    return { ok: true };
  });

  // ——— Счета ———
  app.get('/accounts', auth, async (req) => {
    const rows = await q("SELECT * FROM accounts WHERE owner_kind = 'bank_user' AND owner_id = ? AND status <> 'closed' ORDER BY is_primary DESC, id", [req.bank.id]);
    return { accounts: rows.map(accountView) };
  });

  app.post('/accounts', auth, async (req) => {
    const b = req.body || {};
    const a = await tx(async (conn) => {
      const u = await one('SELECT * FROM bank_users WHERE id = ? FOR UPDATE', [req.bank.id], conn);
      const acc = await openAccount(conn, u, { type: b.type, name: b.name ? String(b.name).trim() : null, compound: !!b.compound, termMonths: b.term_months ? Number(b.term_months) : null });
      await audit(conn, actorOf(req.bank), 'bank.account_open', 'account', acc.id, { type: acc.type });
      return acc;
    });
    return { account: accountView(a) };
  });

  app.get('/accounts/:id', auth, async (req) => {
    const a = await ownAccount(req.bank.id, int(req.params.id, 'id'));
    const before = req.query.before ? int(req.query.before, 'before') : Number.MAX_SAFE_INTEGER;
    const rows = await q(
      `SELECT e.id, e.amount, e.balance_after, t.id AS tx_id, t.kind, t.memo, t.created_at, t.card_id, t.reversed_by, t.reversal_of
       FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id WHERE e.account_id = ? AND e.id < ? ORDER BY e.id DESC LIMIT 50`,
      [a.id, before],
    );
    return { account: accountView(a), history: rows.map((r) => ({ ...r, amount: Number(r.amount), balance_after: Number(r.balance_after) })) };
  });

  app.post('/accounts/:id/primary', auth, async (req) => {
    await tx(async (conn) => {
      const a = await ownAccount(req.bank.id, int(req.params.id, 'id'), conn, { lock: true });
      if (a.type !== 'current' || a.status === 'closed') throw bad('invalid', 'Основным может быть только расчётный счёт');
      await q("UPDATE accounts SET is_primary = 0 WHERE owner_kind = 'bank_user' AND owner_id = ?", [req.bank.id], conn);
      await q('UPDATE accounts SET is_primary = 1 WHERE id = ?', [a.id], conn);
    });
    return { ok: true };
  });

  app.post('/accounts/:id/rename', auth, async (req) => {
    const a = await ownAccount(req.bank.id, int(req.params.id, 'id'));
    await q('UPDATE accounts SET name = ? WHERE id = ?', [str(req.body?.name, 'название', { max: 80 }), a.id]);
    return { ok: true };
  });

  // Закрытие: остаток уходит на основной расчётный счёт; досрочно закрытый вклад — со штрафом.
  app.post('/accounts/:id/close', auth, async (req) => {
    const res = await tx(async (conn) => {
      const a = await ownAccount(req.bank.id, int(req.params.id, 'id'), conn, { lock: true });
      if (a.status === 'closed') throw bad('account_closed', 'Счёт уже закрыт');
      if (a.status !== 'active') throw bad('account_' + a.status, 'Счёт заморожен или арестован');
      if (a.type === 'loan') throw bad('loan_account', 'Ссудный счёт закрывается после погашения кредита');
      if (a.type === 'credit' && Number(a.balance) < 0) throw bad('has_debt', 'Сначала погасите долг по кредитной карте');
      const cards = await one("SELECT COUNT(*) AS n FROM cards WHERE account_id = ? AND status IN ('active','frozen')", [a.id], conn);
      if (cards.n > 0) throw bad('has_cards', 'Сначала закройте карты этого счёта');
      if (a.type === 'business' && (await one("SELECT id FROM shops WHERE account_id = ? AND status = 'active'", [a.id], conn))) throw bad('has_shop', 'К счёту привязан магазин');
      const target = await one("SELECT * FROM accounts WHERE owner_kind = 'bank_user' AND owner_id = ? AND type = 'current' AND status = 'active' AND id <> ? ORDER BY is_primary DESC, id LIMIT 1", [req.bank.id, a.id], conn);
      const balance = Number(a.balance);
      let penalty = 0;
      if (balance > 0) {
        if (!target) throw bad('no_target', 'Нет другого расчётного счёта для остатка');
        const s = await getSettings();
        if (a.type === 'term') penalty = percentOf(balance, Number(s.term_early_penalty_bp || 0));
        const entries = [{ account: a.id, amount: -balance }, { account: target.id, amount: balance - penalty }];
        if (penalty) entries.push({ account: await sys('TREASURY', conn), amount: penalty });
        await post(conn, { kind: 'account_close', memo: `Закрытие счёта ${a.name}${penalty ? ' (штраф за досрочное закрытие)' : ''}`, entries, actor: actorOf(req.bank) });
      }
      await q("UPDATE accounts SET status = 'closed', is_primary = 0, credit_limit = 0, closed_at = NOW(3) WHERE id = ?", [a.id], conn);
      if (a.type === 'credit') await q("UPDATE credit_lines SET status = 'closed' WHERE account_id = ?", [a.id], conn);
      await q("UPDATE autopayments SET status = 'cancelled' WHERE (from_account_id = ? OR to_account_id = ?) AND status IN ('active','paused')", [a.id, a.id], conn);
      if (a.is_primary && target) await q('UPDATE accounts SET is_primary = 1 WHERE id = ?', [target.id], conn);
      await audit(conn, actorOf(req.bank), 'bank.account_close', 'account', a.id, { penalty });
      return { penalty };
    });
    return { ok: true, ...res };
  });

  // ——— Карты ———
  app.get('/cards', auth, async (req) => ({ cards: await myCards(req.bank.id) }));

  app.post('/cards', auth, async (req) => {
    const b = req.body || {};
    const card = await tx(async (conn) => {
      const u = await freshUser(req.bank.id, conn);
      const acc = await ownAccount(u.id, int(b.account_id, 'счёт'), conn, { lock: true });
      const c = await issueCard(conn, { user: u, account: acc, pin: b.pin, background: BACKGROUNDS.includes(b.background) ? b.background : 'classic' });
      await audit(conn, actorOf(req.bank), 'bank.card_issue', 'card', c.id);
      return c;
    });
    return { card: cardView(card) };
  });

  async function ownCard(req, conn) {
    const c = await one('SELECT * FROM cards WHERE id = ? AND bank_user_id = ?', [int(req.params.id, 'id'), req.bank.id], conn);
    if (!c) throw notFound('Карта не найдена');
    return c;
  }

  app.post('/cards/:id/freeze', auth, async (req) => {
    const c = await ownCard(req);
    const freeze = req.body?.frozen !== false;
    if (!['active', 'frozen'].includes(c.status)) throw bad('invalid_state', 'Карта недействительна');
    await q('UPDATE cards SET status = ? WHERE id = ?', [freeze ? 'frozen' : 'active', c.id]);
    await audit(null, actorOf(req.bank), freeze ? 'bank.card_freeze' : 'bank.card_unfreeze', 'card', c.id);
    return { ok: true, status: freeze ? 'frozen' : 'active' };
  });

  app.post('/cards/:id/pin', { ...auth, ...limited(5) }, async (req) => {
    const c = await ownCard(req);
    const pin = checkPinFormat(req.body?.pin);
    await q('UPDATE cards SET pin_hash = ?, pin_fail = 0, locked_until = NULL WHERE id = ?', [await hash(pin), c.id]);
    await audit(null, actorOf(req.bank), 'bank.card_pin', 'card', c.id);
    return { ok: true };
  });

  app.post('/cards/:id/limits', auth, async (req) => {
    const c = await ownCard(req);
    const lim = (v, n) => (v === null || v === undefined || v === '' ? null : amountOf(v, n));
    await q('UPDATE cards SET limit_tx = ?, limit_daily = ? WHERE id = ?', [lim(req.body?.limit_tx, 'лимит на операцию'), lim(req.body?.limit_daily, 'дневной лимит'), c.id]);
    return { ok: true };
  });

  app.post('/cards/:id/design', auth, async (req) => {
    const c = await ownCard(req);
    if (!BACKGROUNDS.includes(req.body?.background)) throw bad('invalid', 'Неизвестный фон');
    await q('UPDATE cards SET background = ? WHERE id = ?', [req.body.background, c.id]);
    return { ok: true };
  });

  app.post('/cards/:id/reissue', auth, async (req) => {
    const card = await tx(async (conn) => {
      const c = await ownCard(req, conn);
      if (!['active', 'frozen', 'expired', 'blocked'].includes(c.status)) throw bad('invalid_state', 'Карту нельзя перевыпустить');
      if (c.type === 'gift') throw bad('invalid_state', 'Подарочная карта не перевыпускается');
      const u = await freshUser(req.bank.id, conn);
      const acc = await ownAccount(u.id, c.account_id, conn, { lock: true });
      const pin = req.body?.pin ?? null;
      const nc = await issueCard(conn, { user: u, account: acc, pin: pin ?? '000', type: c.type, background: c.background, feeKey: 'card_reissue_fee', holderName: null, holderUserId: c.holder_user_id });
      await q('UPDATE cards SET holder_name = ? WHERE id = ?', [c.holder_name, nc.id], conn);
      await q('UPDATE autopayments SET card_id = ? WHERE card_id = ?', [nc.id, c.id], conn);
      await q('UPDATE credit_lines SET card_id = ? WHERE card_id = ?', [nc.id, c.id], conn);
      if (pin === null) await q('UPDATE cards SET pin_hash = ? WHERE id = ?', [c.pin_hash, nc.id]); // PIN сохраняется
      await q('UPDATE cards SET limit_tx = ?, limit_daily = ? WHERE id = ?', [c.limit_tx, c.limit_daily, nc.id]);
      await q("UPDATE cards SET status = 'reissued' WHERE id = ?", [c.id]);
      await audit(conn, actorOf(req.bank), 'bank.card_reissue', 'card', nc.id, { old: c.id });
      return one('SELECT * FROM cards WHERE id = ?', [nc.id], conn);
    });
    return { card: cardView(card) };
  });

  app.post('/cards/:id/close', auth, async (req) => {
    const c = await ownCard(req);
    await q("UPDATE cards SET status = 'blocked' WHERE id = ?", [c.id]);
    // Карманные деньги на закрытую детскую карту больше не переводятся.
    await q("UPDATE autopayments SET status = 'cancelled' WHERE card_id = ? AND status IN ('active','paused')", [c.id]);
    await audit(null, actorOf(req.bank), 'bank.card_close', 'card', c.id);
    return { ok: true };
  });

  // ——— Переводы ———
  app.get('/recipients', auth, async (req) => {
    const term = String(req.query.q || '').trim();
    if (term.length < 2) return { recipients: [] };
    const rows = await q(
      `SELECT u.id, u.full_name, a.number FROM bank_users u JOIN accounts a ON a.owner_kind = 'bank_user' AND a.owner_id = u.id AND a.type = 'current' AND a.status = 'active' AND a.is_primary = 1
       WHERE u.status = 'active' AND u.full_name LIKE ? AND u.id <> ? ORDER BY u.full_name LIMIT 20`,
      [`%${term}%`, req.bank.id],
    );
    return { recipients: rows.map((r) => ({ id: r.id, full_name: r.full_name, account_tail: r.number.slice(-4) })) };
  });

  app.post('/transfers/preview', auth, async (req) => {
    const b = req.body || {};
    const amount = amountOf(b.amount);
    const to = await resolveRecipient(null, b.to, req.bank.id);
    const owner = to.owner_id ? await one('SELECT full_name FROM bank_users WHERE id = ?', [to.owner_id]) : null;
    const own = to.owner_id === req.bank.id;
    const fee = own ? 0 : transferFee(amount, await getSettings());
    return { recipient: { name: owner?.full_name || to.name, account_tail: to.number.slice(-4), own }, amount, fee, total: amount + fee };
  });

  app.post('/transfers', { ...auth, ...limited(30) }, async (req) => {
    const b = req.body || {};
    const amount = amountOf(b.amount);
    const memo = str(b.memo, 'комментарий', { optional: true, max: 140 });
    const idem = idemKey(req, `b${req.bank.id}:transfer`);
    const result = await tx(async (conn) => {
      const prev = await findIdem(conn, idem);
      if (prev) return { tx: prev.id, duplicate: true };
      const u = await freshUser(req.bank.id, conn);
      requireVerified(u);
      const from = await ownAccount(u.id, int(b.from_account, 'счёт списания'), conn);
      assertSpendable(from);
      const to = await resolveRecipient(conn, b.to, u.id);
      if (to.id === from.id) throw bad('same_account', 'Нельзя перевести на тот же счёт');
      // Антифрод: подозрительный перевод чужому получателю ждёт решения админа.
      if (to.owner_id !== u.id) {
        if (idem) {
          const held = await one("SELECT id FROM fraud_queue WHERE bank_user_id = ? AND status = 'pending' AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.idem')) = ?", [u.id, idem], conn);
          if (held) return { held: true, fraud_id: held.id };
        }
        const reason = await transferSuspicion(conn, u.id, amount, await getSettings());
        if (reason) {
          const fee = transferFee(amount, await getSettings());
          const available = Number(from.balance) + Number(from.credit_limit || 0);
          if (available < amount + fee) throw bad('insufficient_funds', 'Недостаточно средств', { account: from.id });
          const id = await addFraud(conn, { userId: u.id, kind: 'transfer', mode: 'hold', amount, reason, data: { from: from.id, to: to.id, memo, idem } });
          await notify(conn, 'bank', u.id, { title: 'Перевод на проверке', body: `${formatMoney(amount)}: служба безопасности банка проверит операцию`, link: '#/' });
          await audit(conn, actorOf(req.bank), 'bank.transfer_held', 'fraud', id, { amount, reason });
          return { held: true, fraud_id: id, reason };
        }
      }
      const r = await moveMoney(conn, { user: u, from, to, amount, memo, idem, actor: actorOf(req.bank) });
      return { tx: r.tx, fee: r.fee };
    });
    return { ok: true, ...result };
  });

  // ——— Квитанции ВлодУслуг ———
  app.post('/invoices/:no/pay', auth, async (req) => {
    const idem = idemKey(req, `b${req.bank.id}:invoice`);
    const res = await tx(async (conn) => {
      const prev = await findIdem(conn, idem);
      if (prev) return { tx: prev.id, duplicate: true };
      const u = await freshUser(req.bank.id, conn);
      requireVerified(u);
      const from = await ownAccount(u.id, int(req.body?.account_id, 'счёт'), conn);
      assertSpendable(from);
      const r = await payInvoice(conn, String(req.params.no).toUpperCase(), { fromAccount: from.id, via: 'bank', actor: actorOf(req.bank), idem });
      return { tx: r.tx };
    });
    return { ok: true, ...res };
  });

  // ——— Оплата по QR (касса/терминал) ———
  app.get('/qr-pay/:token', auth, async (req) => ({ payment: await qrInfo(req.params.token) }));

  app.post('/qr-pay/:token', { ...auth, ...limited(20) }, async (req) => {
    const res = await tx(async (conn) => {
      const u = await freshUser(req.bank.id, conn);
      requireVerified(u);
      const from = await ownAccount(u.id, int(req.body?.account_id, 'счёт'), conn);
      assertSpendable(from);
      return payQr(conn, req.params.token, { user: u, account: from });
    });
    return { ok: true, ...res };
  });

  // Чек покупки в истории ВлодБанка.
  app.get('/receipts/:saleId', auth, async (req) => {
    const saleId = int(req.params.saleId, 'чек');
    const mine = await one("SELECT p.id FROM sale_payments p JOIN accounts a ON a.id = p.payer_account_id WHERE p.sale_id = ? AND a.owner_id = ? AND a.owner_kind = 'bank_user' LIMIT 1", [saleId, req.bank.id]);
    if (!mine) throw notFound('Чек не найден');
    return receiptData(saleId);
  });

  // ——— Банкомат: карта + PIN → короткая сессия на 3 минуты ———
  const ATM_SECONDS = 180;
  function atmCard(req) {
    try {
      const p = jwt.verify(String(req.body?.token || ''), config.jwtSecret);
      if (p.k !== 'atm') throw new Error();
      return p.card;
    } catch {
      throw unauthorized('Сессия банкомата истекла — вставьте карту снова');
    }
  }
  async function atmState(cardId) {
    const c = await one('SELECT c.*, a.balance, a.status AS account_status FROM cards c JOIN accounts a ON a.id = c.account_id WHERE c.id = ?', [cardId]);
    return { holder: c.holder_name, last4: c.number.slice(-4), balance: Number(c.balance) };
  }

  app.post('/atm/session', limited(20), async (req) => {
    const card = await authorizeCard({ number: req.body?.number, exp: req.body?.exp, pin: req.body?.pin });
    const token = jwt.sign({ k: 'atm', card: card.id }, config.jwtSecret, { expiresIn: ATM_SECONDS });
    return { token, ...(await atmState(card.id)) };
  });

  app.post('/atm/balance', async (req) => atmState(atmCard(req)));

  for (const dir of ['withdraw', 'deposit']) {
    app.post(`/atm/${dir}`, limited(20), async (req) => {
      const cardId = atmCard(req);
      const amount = amountOf(req.body?.amount);
      if (dir === 'withdraw' && amount % 500 !== 0) throw bad('atm_notes', 'Банкомат выдаёт купюры от 5 В — сумма кратна 5 В');
      const idem = idemKey(req, `atm${cardId}:${dir}`);
      await tx(async (conn) => {
        if (await findIdem(conn, idem)) return;
        const card = await one('SELECT * FROM cards WHERE id = ?', [cardId], conn);
        if (card.status !== 'active') throw bad('card_blocked', 'Карта недействительна');
        if (dir === 'withdraw') await checkCardLimits(conn, card, amount);
        const cash = await sys('CASH', conn);
        const sign = dir === 'withdraw' ? -1 : 1;
        const r = await post(conn, {
          kind: dir === 'withdraw' ? 'atm_withdraw' : 'atm_deposit',
          memo: dir === 'withdraw' ? 'Снятие наличных в банкомате' : 'Внесение наличных в банкомате',
          entries: [{ account: card.account_id, amount: sign * amount }, { account: cash, amount: -sign * amount }],
          idem,
          cardId: card.id,
          actor: { kind: 'bank', id: card.bank_user_id },
        });
        if (dir === 'withdraw' && !r.duplicate) await reviewIfLarge(conn, { accountId: card.account_id, amount, kind: 'atm_withdraw', txId: r.id, cardId: card.id });
      });
      return { ok: true, ...(await atmState(cardId)) };
    });
  }

  // ——— Операционист ———
  const teller = { preHandler: needRole('teller') };

  app.get('/teller/clients', teller, async (req) => {
    const term = String(req.query.q || '').trim();
    if (term.length < 2) return { clients: [] };
    const digits = term.replace(/\D/g, '');
    const rows = await q(
      `SELECT DISTINCT u.id, u.full_name, u.email, u.passport_no, u.passport_verified, u.status FROM bank_users u
       LEFT JOIN cards c ON c.bank_user_id = u.id
       WHERE u.full_name LIKE ? OR u.email LIKE ? OR u.passport_no LIKE ? OR (? <> '' AND c.number = ?) ORDER BY u.full_name LIMIT 30`,
      [`%${term}%`, `%${term}%`, `%${term.toUpperCase()}%`, digits.length === 12 ? digits : '', digits],
    );
    return { clients: rows };
  });

  app.get('/teller/clients/:id', teller, async (req) => {
    const u = await freshUser(int(req.params.id, 'id'));
    if (!u) throw notFound();
    const accounts = await q("SELECT * FROM accounts WHERE owner_kind = 'bank_user' AND owner_id = ? AND status <> 'closed' ORDER BY id", [u.id]);
    const cards = await q("SELECT * FROM cards WHERE bank_user_id = ? AND status <> 'reissued' ORDER BY id DESC", [u.id]);
    return { client: publicBankUser(u), accounts: accounts.map(accountView), cards: cards.map((c) => cardView(c, { full: false })) };
  });

  app.post('/teller/clients/:id/accounts', teller, async (req) => {
    const a = await tx(async (conn) => {
      const u = await one('SELECT * FROM bank_users WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
      if (!u) throw notFound();
      const acc = await openAccount(conn, u, { type: req.body?.type || 'current' });
      await audit(conn, actorOf(req.actor), 'teller.account_open', 'account', acc.id);
      return acc;
    });
    return { account: accountView(a) };
  });

  app.post('/teller/clients/:id/cards', teller, async (req) => {
    const card = await tx(async (conn) => {
      const u = await freshUser(int(req.params.id, 'id'), conn);
      if (!u) throw notFound();
      const acc = await ownAccount(u.id, int(req.body?.account_id, 'счёт'), conn, { lock: true });
      const c = await issueCard(conn, { user: u, account: acc, pin: req.body?.pin, issuedBy: `${req.actor.kind}:${req.actor.id}` });
      await notify(conn, 'bank', u.id, { title: 'Выпущена карта', body: `•••• ${c.number.slice(-4)} — выдана операционистом`, link: '#/cards' });
      await audit(conn, actorOf(req.actor), 'teller.card_issue', 'card', c.id);
      return c;
    });
    return { card: cardView(card) };
  });

  // Приём и выдача наличных клиенту.
  app.post('/teller/cash', teller, async (req) => {
    const b = req.body || {};
    const amount = amountOf(b.amount);
    const dir = b.direction === 'out' ? 'out' : 'in';
    await tx(async (conn) => {
      const acc = await one("SELECT * FROM accounts WHERE id = ? AND owner_kind = 'bank_user'", [int(b.account_id, 'счёт')], conn);
      if (!acc) throw notFound('Счёт не найден');
      const sign = dir === 'out' ? -1 : 1;
      await post(conn, {
        kind: dir === 'out' ? 'teller_withdraw' : 'teller_deposit',
        memo: dir === 'out' ? 'Выдача наличных в отделении' : 'Внесение наличных в отделении',
        entries: [{ account: acc.id, amount: sign * amount }, { account: await sys('CASH', conn), amount: -sign * amount }],
        idem: idemKey(req, `teller${req.actor.id}:cash`),
        actor: actorOf(req.actor),
      });
      await audit(conn, actorOf(req.actor), `teller.cash_${dir}`, 'account', acc.id, { amount });
    });
    return { ok: true };
  });

  app.get('/teller/shops', teller, async () => {
    const rows = await q("SELECT s.id, s.name, s.inn, a.number AS account_number, u.full_name AS owner FROM shops s JOIN accounts a ON a.id = s.account_id JOIN bank_users u ON u.id = s.owner_id WHERE s.status = 'active' ORDER BY s.name");
    return { shops: rows };
  });

  // Инкассация: наличные магазина сдаются в банк и зачисляются на бизнес-счёт.
  app.post('/teller/collection', teller, async (req) => {
    const amount = amountOf(req.body?.amount);
    await tx(async (conn) => {
      const shop = await one('SELECT * FROM shops WHERE id = ?', [int(req.body?.shop_id, 'магазин')], conn);
      if (!shop) throw notFound('Магазин не найден');
      const r = await post(conn, {
        kind: 'collection',
        memo: `Инкассация: ${shop.name}`,
        entries: [{ account: await sys('CASH', conn), amount: -amount }, { account: shop.account_id, amount }],
        idem: idemKey(req, `teller${req.actor.id}:collection`),
        actor: actorOf(req.actor),
        ref: { type: 'shop', id: shop.id },
      });
      const shift = await one("SELECT id FROM shifts WHERE shop_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [shop.id], conn);
      if (shift) await q('UPDATE shifts SET cash_collected = cash_collected + ? WHERE id = ?', [amount, shift.id], conn);
      await q('INSERT INTO pos_log (shop_id, shift_id, action, data) VALUES (?, ?, ?, ?)', [shop.id, shift?.id || null, 'collection', JSON.stringify({ amount, tx: r.id, teller: req.actor.id })], conn);
      await notify(conn, 'bank', shop.owner_id, { title: `Инкассация ${formatMoney(amount)}`, body: shop.name });
      await audit(conn, actorOf(req.actor), 'teller.collection', 'shop', shop.id, { amount });
    });
    return { ok: true };
  });

}
