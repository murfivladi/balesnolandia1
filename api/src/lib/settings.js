import { q, json } from '../db.js';

/** Все ставки и переключатели админа. Деньги — во влодинках, проценты — в базисных пунктах (100 = 1%). */
export const DEFAULTS = {
  // Система
  bank_registration_approval: false,
  passport_approval: false,
  start_balance: 100000,
  idle_minutes: 10,
  game_month_minutes: 10,
  bank_logo: null,
  gov_logo: null,
  // Законы и ставки
  vat_bp: 2000,
  // Тарифы банка
  transfer_fee_bp: 0,
  transfer_fee_min: 0,
  acquiring_fee_bp: 0,
  card_valid_months: 36,
  card_issue_fee: 0,
  card_reissue_fee: 0,
  savings_rate_bp: 50,
  term_rate_bp: 100,
  term_early_penalty_bp: 500,
  // Госпошлины
  fee_passport: 0,
  fee_inn: 0,
  fee_ip: 5000,
  passport_valid_months: 120,
};

let cache = null;
let cacheAt = 0;

export async function getSettings({ fresh = false } = {}) {
  if (!fresh && cache && Date.now() - cacheAt < 5000) return cache;
  const rows = await q('SELECT k, v FROM settings');
  const out = { ...DEFAULTS };
  for (const r of rows) out[r.k] = json(r.v, r.v);
  cache = out;
  cacheAt = Date.now();
  return out;
}

export async function getSetting(key) {
  return (await getSettings())[key];
}

export async function setSettings(patch) {
  for (const [k, v] of Object.entries(patch)) {
    if (!(k in DEFAULTS)) continue;
    await q('INSERT INTO settings (k, v) VALUES (?, ?) ON DUPLICATE KEY UPDATE v = VALUES(v)', [k, JSON.stringify(v)]);
  }
  cache = null;
  return getSettings({ fresh: true });
}

/** Публичная часть настроек — то, что можно отдать любому клиенту. */
export function publicSettings(s) {
  return {
    idle_minutes: s.idle_minutes,
    game_month_minutes: s.game_month_minutes,
    vat_bp: s.vat_bp,
    bank_logo: s.bank_logo,
    gov_logo: s.gov_logo,
    transfer_fee_bp: s.transfer_fee_bp,
    transfer_fee_min: s.transfer_fee_min,
    savings_rate_bp: s.savings_rate_bp,
    term_rate_bp: s.term_rate_bp,
    term_early_penalty_bp: s.term_early_penalty_bp,
    card_issue_fee: s.card_issue_fee,
    card_reissue_fee: s.card_reissue_fee,
    fee_passport: s.fee_passport,
    fee_inn: s.fee_inn,
    fee_ip: s.fee_ip,
    bank_registration_approval: s.bank_registration_approval,
    passport_approval: s.passport_approval,
  };
}

export function resetSettingsCache() {
  cache = null;
}
