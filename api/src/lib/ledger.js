// Журнал проводок (двойная запись). Деньги не берутся из воздуха: каждая операция —
// набор строк ledger_entries с суммой 0 в одной транзакции MySQL.
import { q, one, afterCommit } from '../db.js';
import { bad, conflict } from './errors.js';
import { publish, userChannel } from './hub.js';

const systemIds = new Map();

/** id служебного счёта: EMISSION, TREASURY, BUDGET, CASH */
export async function sys(code, conn) {
  if (systemIds.has(code)) return systemIds.get(code);
  const row = await one('SELECT id FROM accounts WHERE system_code = ?', [code], conn);
  if (!row) throw new Error(`system account ${code} missing`);
  systemIds.set(code, row.id);
  return row.id;
}

export function clearSystemCache() {
  systemIds.clear();
}

export async function findIdem(conn, idemKey) {
  if (!idemKey) return null;
  return one('SELECT * FROM ledger_tx WHERE idem_key = ?', [idemKey], conn);
}

const DEBIT_BLOCKED = {
  frozen: 'Счёт заморожен',
  arrested: 'На счёт наложен арест',
  closed: 'Счёт закрыт',
};

/**
 * Провести операцию.
 * @param conn соединение внутри транзакции
 * @param {object} p
 * @param {string} p.kind  тип: transfer, emission, card_payment, atm_withdraw, ...
 * @param {{account:number, amount:number}[]} p.entries  amount > 0 — зачисление, < 0 — списание
 * @param {string} [p.idem]  ключ идемпотентности (уникален в журнале)
 * @param {boolean} [p.force] разрешить списание с замороженного/арестованного счёта (админ)
 * @returns {Promise<{id:number, duplicate?:boolean, balances:Map<number,number>}>}
 */
export async function post(conn, { kind, memo = null, entries, idem = null, actor = null, ref = null, meta = null, force = false, reversalOf = null, cardId = null }) {
  if (idem) {
    const prev = await findIdem(conn, idem);
    if (prev) return { id: prev.id, duplicate: true, balances: new Map() };
  }
  // Схлопываем повторы по счёту и убираем нули.
  const byAcc = new Map();
  for (const e of entries) {
    if (!Number.isSafeInteger(e.amount)) throw new Error('ledger: amount must be integer');
    byAcc.set(e.account, (byAcc.get(e.account) || 0) + e.amount);
  }
  for (const [k, v] of byAcc) if (v === 0) byAcc.delete(k);
  const sum = [...byAcc.values()].reduce((a, b) => a + b, 0);
  if (sum !== 0) throw new Error(`ledger: unbalanced tx (${sum})`);
  if (byAcc.size === 0) throw bad('empty_tx', 'Пустая операция');

  const ids = [...byAcc.keys()].sort((a, b) => a - b);
  // Блокируем строки счетов в одном порядке, чтобы не ловить взаимные блокировки.
  const rows = await q(`SELECT id, owner_kind, owner_id, balance, status, allow_negative, name FROM accounts WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY id FOR UPDATE`, ids, conn);
  if (rows.length !== ids.length) throw bad('account_not_found', 'Счёт не найден');
  const accs = new Map(rows.map((r) => [r.id, r]));

  for (const [id, amt] of byAcc) {
    const a = accs.get(id);
    if (a.status === 'closed') throw bad('account_closed', 'Счёт закрыт');
    if (amt < 0) {
      if (!force && a.status !== 'active') throw bad('account_' + a.status, DEBIT_BLOCKED[a.status] || 'Счёт недоступен');
      if (!a.allow_negative && Number(a.balance) + amt < 0) {
        throw bad('insufficient_funds', 'Недостаточно средств', { account: id });
      }
    }
  }

  let txId;
  try {
    const res = await q(
      'INSERT INTO ledger_tx (kind, memo, idem_key, actor_kind, actor_id, ref_type, ref_id, reversal_of, card_id, meta) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [kind, memo, idem, actor?.kind || null, actor?.id || null, ref?.type || null, ref?.id || null, reversalOf, cardId, meta ? JSON.stringify(meta) : null],
      conn,
    );
    txId = res.insertId;
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') throw conflict('duplicate', 'Операция уже выполняется');
    throw err;
  }

  const balances = new Map();
  for (const id of ids) {
    const a = accs.get(id);
    const after = Number(a.balance) + byAcc.get(id);
    balances.set(id, after);
    await q('UPDATE accounts SET balance = ? WHERE id = ?', [after, id], conn);
    await q('INSERT INTO ledger_entries (tx_id, account_id, amount, balance_after) VALUES (?, ?, ?, ?)', [txId, id, byAcc.get(id), after], conn);
  }

  // После коммита — сообщаем владельцам об изменении баланса.
  const owners = new Set(rows.filter((r) => r.owner_kind === 'bank_user').map((r) => r.owner_id));
  afterCommit(conn, () => {
    for (const uid of owners) publish(userChannel('bank', uid), { type: 'balance', tx: txId });
    publish('admin', { type: 'tx', tx: txId, kind });
  });

  return { id: txId, balances };
}

/** Сторно: обратная проводка. Арест и заморозка не мешают (решение админа). */
export async function reverse(conn, txId, { actor, memo } = {}) {
  const tx = await one('SELECT * FROM ledger_tx WHERE id = ? FOR UPDATE', [txId], conn);
  if (!tx) throw bad('not_found', 'Операция не найдена');
  if (tx.reversed_by) throw bad('already_reversed', 'Операция уже отменена');
  if (tx.reversal_of) throw bad('is_reversal', 'Нельзя отменить сторно');
  const entries = await q('SELECT account_id, amount FROM ledger_entries WHERE tx_id = ?', [txId], conn);
  const res = await post(conn, {
    kind: 'reversal',
    memo: memo || `Отмена операции №${txId}`,
    entries: entries.map((e) => ({ account: e.account_id, amount: -Number(e.amount) })),
    actor,
    ref: { type: 'tx', id: txId },
    reversalOf: txId,
    force: true,
  });
  await q('UPDATE ledger_tx SET reversed_by = ? WHERE id = ?', [res.id, txId], conn);
  return res;
}

/** Сумма проводок счёта — проверка кеша balance. */
export async function recomputeBalance(accountId, conn) {
  const r = await one('SELECT COALESCE(SUM(amount),0) AS s FROM ledger_entries WHERE account_id = ?', [accountId], conn);
  return Number(r.s);
}
