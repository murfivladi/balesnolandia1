// Игровое время: игровой месяц длится N реальных минут (настройка game_month_minutes).
// На каждый тик выполняются обработчики; повторный запуск безопасен (ключи идемпотентности).
import { tx, q, one } from '../db.js';
import { getSettings } from './settings.js';
import { publish } from './hub.js';
import { post, sys } from './ledger.js';
import { notify } from './notify.js';
import { percentOf, formatMoney } from '@bln/shared/money.js';

const handlers = [];

/** Зарегистрировать обработчик игрового месяца: fn(month, settings). */
export function onMonth(name, fn) {
  handlers.push({ name, fn });
}

// ——— Игровые секунды (TTL DNS, сроки в сети) ———
// В игровом месяце 30 игровых суток. Внутри месяца время идёт пропорционально реальному
// от last_tick_at; на паузе стоит. Значение монотонно: после снятия паузы не идёт назад.
const GAME_MONTH_SECONDS = 30 * 86400;
let gameCache = { at: 0, state: null };
let lastGame = 0;
let gameOverride = null;

/** Для тестов: подменить игровое время (null — вернуть настоящее). */
export function setGameTimeOverride(fn) {
  gameOverride = fn;
  lastGame = 0;
}

export async function gameSeconds() {
  if (gameOverride) return gameOverride();
  if (Date.now() - gameCache.at > 1000 || !gameCache.state) {
    const r = await one('SELECT month_index, last_tick_at, paused FROM game_clock WHERE id = 1');
    const s = await getSettings();
    gameCache = { at: Date.now(), state: { ...r, minutes: Number(s.game_month_minutes) || 10 } };
  }
  const st = gameCache.state;
  let t = (st?.month_index || 0) * GAME_MONTH_SECONDS;
  if (st && !st.paused) {
    const frac = Math.min(1, Math.max(0, (Date.now() - new Date(st.last_tick_at).getTime()) / (st.minutes * 60000)));
    t += Math.floor(frac * (GAME_MONTH_SECONDS - 1));
  }
  lastGame = Math.max(lastGame, t);
  return lastGame;
}

export async function isPaused() {
  const r = await one('SELECT paused FROM game_clock WHERE id = 1');
  return !!r?.paused;
}

export async function currentMonth(conn) {
  const r = await one('SELECT month_index FROM game_clock WHERE id = 1', [], conn);
  return r ? r.month_index : 0;
}

export async function clockState() {
  const r = await one('SELECT * FROM game_clock WHERE id = 1');
  const s = await getSettings();
  const minutes = Number(s.game_month_minutes) || 10;
  const next = new Date(new Date(r.last_tick_at).getTime() + minutes * 60000);
  return { month: r.month_index, paused: !!r.paused, minutes, last_tick_at: r.last_tick_at, next_tick_at: r.paused ? null : next };
}

/** Перевести часы на следующий месяц и выполнить обработчики. */
export async function advance({ force = false } = {}) {
  const s = await getSettings({ fresh: true });
  const minutes = Number(s.game_month_minutes) || 10;
  const month = await tx(async (conn) => {
    const r = await one('SELECT * FROM game_clock WHERE id = 1 FOR UPDATE', [], conn);
    if (!force) {
      if (r.paused) return null;
      if (Date.now() - new Date(r.last_tick_at).getTime() < minutes * 60000) return null;
    }
    await q('UPDATE game_clock SET month_index = month_index + 1, last_tick_at = NOW(3) WHERE id = 1', [], conn);
    return r.month_index + 1;
  });
  if (month === null) return null;
  for (const h of handlers) {
    try {
      await h.fn(month, s);
    } catch (err) {
      console.error(`clock handler ${h.name} failed`, err);
    }
  }
  publish('clock', { type: 'month', month });
  return month;
}

let timer = null;
export function startClock() {
  if (timer) return;
  timer = setInterval(() => advance().catch((e) => console.error('clock', e)), 5000);
  timer.unref?.();
}

export function stopClock() {
  clearInterval(timer);
  timer = null;
}

// ——— Обработчики ядра ———

// Проценты на накопительные счета и вклады. Сложный процент — капитализация,
// простой — выплата на основной расчётный счёт.
onMonth('interest', async (month) => {
  const accounts = await q("SELECT * FROM accounts WHERE type IN ('savings','term') AND status IN ('active','frozen','arrested') AND balance > 0 AND rate_bp > 0");
  for (const a of accounts) {
    const interest = percentOf(Number(a.balance), a.rate_bp);
    if (interest <= 0) continue;
    await tx(async (conn) => {
      let target = a.id;
      if (!a.compound) {
        const primary = await one("SELECT id FROM accounts WHERE owner_kind = 'bank_user' AND owner_id = ? AND type = 'current' AND status <> 'closed' ORDER BY is_primary DESC, id LIMIT 1", [a.owner_id], conn);
        if (primary) target = primary.id;
      }
      const r = await post(conn, {
        kind: 'interest',
        memo: `Проценты по счёту ${a.name}`,
        idem: `tick:${month}:interest:${a.id}`,
        entries: [{ account: await sys('TREASURY', conn), amount: -interest }, { account: target, amount: interest }],
        ref: { type: 'account', id: a.id },
        force: true,
      });
      if (!r.duplicate) await notify(conn, 'bank', a.owner_id, { title: `Начислены проценты ${formatMoney(interest)}`, body: a.name, link: `#/accounts/${a.id}` });
    }).catch((e) => console.error('interest', a.id, e.message));
  }
});

// Вклады на срок: в месяц окончания — перевод на расчётный счёт и закрытие.
onMonth('term_maturity', async (month) => {
  const due = await q("SELECT * FROM accounts WHERE type = 'term' AND status = 'active' AND matures_month IS NOT NULL AND matures_month <= ?", [month]);
  for (const a of due) {
    await tx(async (conn) => {
      const acc = await one('SELECT * FROM accounts WHERE id = ? FOR UPDATE', [a.id], conn);
      if (acc.status !== 'active') return;
      const primary = await one("SELECT id FROM accounts WHERE owner_kind = 'bank_user' AND owner_id = ? AND type = 'current' AND status <> 'closed' ORDER BY is_primary DESC, id LIMIT 1", [a.owner_id], conn);
      if (!primary) return;
      if (Number(acc.balance) > 0) {
        await post(conn, {
          kind: 'deposit_maturity',
          memo: `Возврат вклада ${acc.name}`,
          idem: `tick:${month}:maturity:${a.id}`,
          entries: [{ account: acc.id, amount: -Number(acc.balance) }, { account: primary.id, amount: Number(acc.balance) }],
          force: true,
        });
      }
      await q("UPDATE accounts SET status = 'closed', closed_at = NOW(3) WHERE id = ?", [a.id], conn);
      await notify(conn, 'bank', a.owner_id, { title: 'Срок вклада закончился', body: `${acc.name}: деньги переведены на расчётный счёт`, link: '#/' });
    }).catch((e) => console.error('maturity', a.id, e.message));
  }
});

// Карты с истёкшим сроком.
onMonth('card_expiry', async (month) => {
  await q("UPDATE cards SET status = 'expired' WHERE status IN ('active','frozen') AND exp_month < ?", [month]);
});

// Зарплата кассиров с бизнес-счёта магазина; НДФЛ удерживается и уходит в госбюджет.
onMonth('payroll', async (month, s) => {
  const staff = await q("SELECT st.*, sh.account_id AS shop_account, sh.name AS shop_name, sh.owner_id FROM shop_staff st JOIN shops sh ON sh.id = st.shop_id WHERE st.active = 1 AND st.salary > 0 AND sh.status = 'active' AND st.role = 'cashier'");
  for (const st of staff) {
    await tx(async (conn) => {
      const target = await one("SELECT id FROM accounts WHERE owner_kind = 'bank_user' AND owner_id = ? AND type = 'current' AND status <> 'closed' ORDER BY is_primary DESC, id LIMIT 1", [st.bank_user_id], conn);
      if (!target) return;
      const ndfl = percentOf(Number(st.salary), Number(s.ndfl_bp || 0));
      try {
        const r = await post(conn, {
          kind: 'salary',
          memo: `Зарплата: ${st.shop_name}`,
          idem: `tick:${month}:salary:${st.id}`,
          entries: [{ account: st.shop_account, amount: -Number(st.salary) }, { account: target.id, amount: Number(st.salary) - ndfl }, ...(ndfl ? [{ account: await sys('BUDGET', conn), amount: ndfl }] : [])],
          ref: { type: 'shop', id: st.shop_id },
          meta: { gross: Number(st.salary), ndfl },
        });
        if (!r.duplicate) await notify(conn, 'bank', st.bank_user_id, { title: `Зарплата ${formatMoney(Number(st.salary) - ndfl)}`, body: `${st.shop_name}${ndfl ? ` · НДФЛ ${formatMoney(ndfl)}` : ''}` });
      } catch (err) {
        if (err.code !== 'insufficient_funds') throw err;
        await notify(conn, 'bank', st.owner_id, { title: 'Не хватило денег на зарплату', body: `${st.shop_name}: пополните бизнес-счёт` });
      }
    }).catch((e) => console.error('payroll', st.id, e.message));
  }
});
