// Валюта БФ: 1 влодик (В) = 100 влодинок. Все суммы — целые влодинки.

export const CURRENCY_SIGN = 'В';

/** Номиналы в влодинках: монеты и купюры. */
export const COINS = [1, 2, 5, 10, 20, 50, 100, 200];
export const NOTES = [500, 1000, 2000, 5000, 10000, 20000, 50000];
export const DENOMINATIONS = [...NOTES, ...COINS].sort((a, b) => b - a);

const NBSP_THIN = '\u00a0'; // неразрывный пробел между разрядами и перед «В»

/** 125000 → "1 250,00 В" */
export function formatMoney(minor, { sign = true, plus = false } = {}) {
  if (minor === null || minor === undefined || minor === '') return '—';
  let n = typeof minor === 'bigint' ? minor : BigInt(Math.trunc(Number(minor)));
  const neg = n < 0n;
  if (neg) n = -n;
  const whole = (n / 100n).toString();
  const frac = (n % 100n).toString().padStart(2, '0');
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, NBSP_THIN);
  const prefix = neg ? '−' : plus && n > 0n ? '+' : '';
  return `${prefix}${grouped},${frac}${sign ? NBSP_THIN + CURRENCY_SIGN : ''}`;
}

/** "1 250,5" / "1250.50" / "12" → влодинки (целое) или null, если не число. */
export function parseMoney(input) {
  if (typeof input === 'number') return Number.isFinite(input) ? Math.round(input * 100) : null;
  if (typeof input !== 'string') return null;
  const s = input.replace(/[\s\u00a0В]/g, '').replace(',', '.');
  if (!/^-?\d+(\.\d{0,2})?$/.test(s)) return null;
  const neg = s.startsWith('-');
  const [w, f = ''] = s.replace('-', '').split('.');
  const v = Number(w) * 100 + Number(f.padEnd(2, '0'));
  return neg ? -v : v;
}

/**
 * Раскладка сдачи по номиналам. Для набора номиналов БФ (канонический ряд 1-2-5)
 * жадный алгоритм даёт минимальное число купюр и монет.
 * @returns {{value:number,count:number,kind:'note'|'coin'}[]}
 */
export function changeBreakdown(amount) {
  const out = [];
  let rest = Math.max(0, Math.trunc(amount));
  for (const d of DENOMINATIONS) {
    if (rest >= d) {
      const count = Math.floor(rest / d);
      rest -= count * d;
      out.push({ value: d, count, kind: NOTES.includes(d) ? 'note' : 'coin' });
    }
  }
  return out;
}

/** Подпись номинала: 50 → "50 влодинок", 200 → "2 В", 5000 → "50 В". */
export function denominationLabel(value) {
  if (value < 100) return `${value} вл.`;
  return `${value / 100} ${CURRENCY_SIGN}`;
}

/** НДС, включённый в цену: total * rate/(1+rate), rate в базисных пунктах (2000 = 20%). */
export function vatIncluded(total, rateBp) {
  if (!rateBp) return 0;
  return Math.round((total * rateBp) / (10000 + rateBp));
}

/** Процент от суммы, rate в базисных пунктах, округление до влодинки. */
export function percentOf(amount, rateBp) {
  return Math.round((amount * rateBp) / 10000);
}

/**
 * Аннуитетный график кредита: равные платежи, в начале больше процентов.
 * rateBp — ставка за игровой месяц в базисных пунктах. Последний платёж закрывает остаток.
 * @returns {{payment:number, total:number, rows:{n:number, principal:number, interest:number}[]}}
 */
export function annuitySchedule(amount, months, rateBp) {
  const r = rateBp / 10000;
  const payment = r > 0 ? Math.ceil((amount * r) / (1 - (1 + r) ** -months)) : Math.ceil(amount / months);
  const rows = [];
  let left = amount;
  for (let n = 1; n <= months; n++) {
    const interest = Math.round(left * r);
    const principal = n === months ? left : Math.min(left, Math.max(0, payment - interest));
    rows.push({ n, principal, interest });
    left -= principal;
  }
  return { payment, total: rows.reduce((s, x) => s + x.principal + x.interest, 0), rows };
}
