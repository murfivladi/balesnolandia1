// Логика ВлодБанка: счета, карты, PIN, лимиты, списания по карте.
import { q, one, tx } from '../db.js';
import { bad, forbidden, notFound } from './errors.js';
import { getSettings } from './settings.js';
import { currentMonth } from './clock.js';
import { post, sys } from './ledger.js';
import { hash, verifyHash } from './auth.js';
import { newAccountNumber, newCardNumber, withUnique } from './ids.js';
import { notify } from './notify.js';
import { formatMoney, percentOf } from '@bln/shared/money.js';
import { isValidCardNumber } from '@bln/shared/format.js';
import { parseMmYY } from '@bln/shared/time.js';

export const ACCOUNT_NAMES = { current: 'Расчётный счёт', savings: 'Накопительный счёт', term: 'Вклад', business: 'Бизнес-счёт' };
const PIN_LOCK_SECONDS = 60;
const PIN_MAX_FAILS = 3;

export function requireVerified(user) {
  if (user.status !== 'active') throw forbidden('Аккаунт ещё не одобрен банком');
  if (!user.passport_verified) throw forbidden('Сначала подтвердите паспорт БФ во ВлодУслугах');
}

export async function primaryAccount(userId, conn) {
  return one("SELECT * FROM accounts WHERE owner_kind = 'bank_user' AND owner_id = ? AND type = 'current' AND status <> 'closed' ORDER BY is_primary DESC, id LIMIT 1", [userId], conn);
}

export async function ownAccount(userId, accountId, conn, { lock = false } = {}) {
  const a = await one(`SELECT * FROM accounts WHERE id = ? AND owner_kind = 'bank_user' AND owner_id = ?${lock ? ' FOR UPDATE' : ''}`, [accountId, userId], conn);
  if (!a) throw notFound('Счёт не найден');
  return a;
}

/** Действующее свидетельство ИП владельца банковского аккаунта (через паспорт). */
export async function ipOf(user, conn) {
  if (!user.passport_verified || !user.passport_no) return null;
  return one("SELECT d.*, c.full_name FROM documents d JOIN citizens c ON c.id = d.citizen_id WHERE c.passport_no = ? AND d.type = 'ip' AND d.status = 'active' ORDER BY d.id DESC LIMIT 1", [user.passport_no], conn);
}

export async function innOf(user, conn) {
  if (!user.passport_no) return null;
  return one("SELECT d.number FROM documents d JOIN citizens c ON c.id = d.citizen_id WHERE c.passport_no = ? AND d.type = 'inn' AND d.status = 'active' ORDER BY d.id DESC LIMIT 1", [user.passport_no], conn);
}

export async function openAccount(conn, user, { type, name, compound = false, termMonths = null }) {
  if (!ACCOUNT_NAMES[type]) throw bad('invalid_type', 'Неизвестный вид счёта');
  requireVerified(user);
  const s = await getSettings();
  const month = await currentMonth(conn);
  if (type === 'business' && !(await ipOf(user, conn))) throw bad('no_ip', 'Бизнес-счёт открывается только для ИП (свидетельство во ВлодУслугах)');
  const hasCurrent = await primaryAccount(user.id, conn);
  if (type !== 'current' && !hasCurrent) throw bad('need_current', 'Сначала откройте расчётный счёт');
  let rate = 0;
  if (type === 'savings') rate = Number(s.savings_rate_bp);
  if (type === 'term') {
    if (!termMonths || termMonths < 1 || termMonths > 120) throw bad('invalid_term', 'Срок вклада: от 1 до 120 игровых месяцев');
    rate = Number(s.term_rate_bp);
  }
  const id = await withUnique(async () => {
    const r = await q(
      'INSERT INTO accounts (number, owner_kind, owner_id, type, name, rate_bp, compound, term_months, opened_month, matures_month, is_primary) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [newAccountNumber(type), 'bank_user', user.id, type, (name || ACCOUNT_NAMES[type]).slice(0, 80), rate, compound ? 1 : 0, type === 'term' ? termMonths : null, month, type === 'term' ? month + termMonths : null, type === 'current' && !hasCurrent ? 1 : 0],
      conn,
    );
    return r.insertId;
  });
  // Стартовый баланс — один раз, на первый расчётный счёт, из эмиссии.
  if (type === 'current' && !user.start_bonus_paid && Number(s.start_balance) > 0) {
    const fresh = await one('SELECT start_bonus_paid FROM bank_users WHERE id = ? FOR UPDATE', [user.id], conn);
    if (!fresh.start_bonus_paid) {
      await post(conn, {
        kind: 'start_balance',
        memo: 'Стартовый баланс',
        entries: [{ account: await sys('EMISSION', conn), amount: -Number(s.start_balance) }, { account: id, amount: Number(s.start_balance) }],
        idem: `start:${user.id}`,
      });
      await q('UPDATE bank_users SET start_bonus_paid = 1 WHERE id = ?', [user.id], conn);
    }
  }
  return one('SELECT * FROM accounts WHERE id = ?', [id], conn);
}

/** Со вклада на срок деньги не тратятся напрямую — только закрытием вклада. */
export function assertSpendable(account) {
  if (account.type === 'term') throw bad('term_locked', 'Со вклада на срок нельзя платить — закройте вклад');
}

export function checkPinFormat(pin) {
  if (!/^\d{3}$/.test(String(pin || ''))) throw bad('invalid_pin', 'PIN — 3 цифры');
  return String(pin);
}

export async function issueCard(conn, { user, account, pin, type = 'debit', background = 'classic', issuedBy = null, chargeFee = true, feeKey = 'card_issue_fee' }) {
  requireVerified(user);
  if (account.owner_id !== user.id || account.owner_kind !== 'bank_user') throw forbidden();
  if (!['current', 'business'].includes(account.type)) throw bad('invalid_account', 'Карту можно привязать к расчётному или бизнес-счёту');
  if (account.status === 'closed') throw bad('account_closed', 'Счёт закрыт');
  const s = await getSettings();
  const month = await currentMonth(conn);
  const fee = chargeFee ? Number(s[feeKey] || 0) : 0;
  if (fee > 0) {
    await post(conn, {
      kind: 'card_fee',
      memo: feeKey === 'card_reissue_fee' ? 'Перевыпуск карты' : 'Выпуск карты',
      entries: [{ account: account.id, amount: -fee }, { account: await sys('TREASURY', conn), amount: fee }],
    });
  }
  const pinHash = await hash(checkPinFormat(pin));
  const holder = translit(user.full_name).toUpperCase().slice(0, 26);
  const id = await withUnique(async () => {
    const r = await q(
      'INSERT INTO cards (account_id, bank_user_id, number, exp_month, pin_hash, type, holder_name, background, issued_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [account.id, user.id, newCardNumber(), month + Number(s.card_valid_months || 36), pinHash, type, holder, background, issuedBy],
      conn,
    );
    return r.insertId;
  });
  return one('SELECT * FROM cards WHERE id = ?', [id], conn);
}

const TR = { а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'i', к: 'k', л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'kh', ц: 'ts', ч: 'ch', ш: 'sh', щ: 'shch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'iu', я: 'ia' };
export function translit(s) {
  return String(s || '').split('').map((ch) => {
    const low = ch.toLowerCase();
    if (low in TR) return ch === low ? TR[low] : TR[low].toUpperCase();
    return ch;
  }).join('');
}

export function cardView(c, { full = true } = {}) {
  return {
    id: c.id,
    account_id: c.account_id,
    number: full ? c.number : `•••• ${c.number.slice(-4)}`,
    last4: c.number.slice(-4),
    exp_month: c.exp_month,
    type: c.type,
    status: c.status,
    holder_name: c.holder_name,
    limit_tx: c.limit_tx === null ? null : Number(c.limit_tx),
    limit_daily: c.limit_daily === null ? null : Number(c.limit_daily),
    background: c.background,
    locked_until: c.locked_until && new Date(c.locked_until) > new Date() ? c.locked_until : null,
    created_at: c.created_at,
  };
}

export function accountView(a) {
  return {
    id: a.id,
    number: a.number,
    type: a.type,
    name: a.name,
    balance: Number(a.balance),
    status: a.status,
    rate_bp: a.rate_bp,
    compound: !!a.compound,
    term_months: a.term_months,
    opened_month: a.opened_month,
    matures_month: a.matures_month,
    is_primary: !!a.is_primary,
    created_at: a.created_at,
  };
}

/**
 * Проверка карты и PIN. Выполняется ВНЕ денежной транзакции, чтобы счётчик ошибок
 * сохранялся даже при отказе. 3 неверных PIN подряд — заморозка на 1 минуту.
 */
export async function authorizeCard({ number, exp, pin }) {
  const digits = String(number || '').replace(/\D/g, '');
  if (!isValidCardNumber(digits)) throw bad('card_invalid', 'Неверный номер карты');
  const card = await one('SELECT * FROM cards WHERE number = ?', [digits]);
  if (!card) throw bad('card_invalid', 'Карта не найдена');
  if (exp !== undefined && exp !== null && exp !== '') {
    const m = typeof exp === 'number' ? exp : parseMmYY(exp);
    if (m !== card.exp_month) throw bad('card_invalid', 'Неверный срок действия карты');
  }
  if (card.locked_until && new Date(card.locked_until) > new Date()) {
    const sec = Math.ceil((new Date(card.locked_until) - new Date()) / 1000);
    throw bad('card_locked', `Карта временно заблокирована. Повторите через ${sec} с`, { seconds: sec });
  }
  if (card.status === 'frozen') throw bad('card_frozen', 'Карта заморожена');
  if (card.status === 'expired' || card.exp_month < (await currentMonth())) throw bad('card_expired', 'Срок действия карты истёк');
  if (card.status !== 'active') throw bad('card_blocked', 'Карта недействительна');
  if (!(await verifyHash(String(pin || ''), card.pin_hash))) {
    const fails = card.pin_fail + 1;
    if (fails >= PIN_MAX_FAILS) {
      await q('UPDATE cards SET pin_fail = 0, locked_until = NOW(3) + INTERVAL ? SECOND WHERE id = ?', [PIN_LOCK_SECONDS, card.id]);
      await tx(async (conn) => notify(conn, 'bank', card.bank_user_id, { title: 'Карта заблокирована на 1 минуту', body: `3 неверных PIN по карте •••• ${card.number.slice(-4)}` }));
      throw bad('card_locked', 'Неверный PIN. Карта заблокирована на 1 минуту', { seconds: PIN_LOCK_SECONDS });
    }
    await q('UPDATE cards SET pin_fail = ? WHERE id = ?', [fails, card.id]);
    throw bad('pin_wrong', `Неверный PIN. Осталось попыток: ${PIN_MAX_FAILS - fails}`);
  }
  if (card.pin_fail) await q('UPDATE cards SET pin_fail = 0 WHERE id = ?', [card.id]);
  return card;
}

/** Проверка лимитов карты перед списанием (внутри транзакции). */
export async function checkCardLimits(conn, card, amount) {
  if (card.limit_tx !== null && amount > Number(card.limit_tx)) throw bad('limit_tx', `Превышен лимит на операцию (${formatMoney(card.limit_tx)})`);
  if (card.limit_daily !== null) {
    const r = await one(
      "SELECT COALESCE(-SUM(e.amount),0) AS spent FROM ledger_tx t JOIN ledger_entries e ON e.tx_id = t.id AND e.account_id = ? WHERE t.card_id = ? AND t.created_at >= CURDATE() AND e.amount < 0",
      [card.account_id, card.id],
      conn,
    );
    if (Number(r.spent) + amount > Number(card.limit_daily)) throw bad('limit_daily', `Превышен дневной лимит карты (${formatMoney(card.limit_daily)})`);
  }
}

export function transferFee(amount, s) {
  const fee = Math.max(percentOf(amount, Number(s.transfer_fee_bp || 0)), Number(s.transfer_fee_min || 0));
  return fee;
}
