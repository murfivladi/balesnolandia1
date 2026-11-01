import { q, json } from '../db.js';
import { config } from '../config.js';

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
  card_monthly_fee: 0,
  gift_card_fee: 0,
  // Кредиты и кредитные карты (ставки — в месяц)
  loan_rate_bp: 200,
  loan_max_amount: 1000000,
  loan_max_months: 24,
  loan_auto_approve_max: 0,
  loan_late_fee_bp: 1000,
  credit_rate_bp: 300,
  credit_grace_months: 2,
  credit_min_payment_bp: 1000,
  credit_late_fee: 500,
  credit_max_limit: 500000,
  // Кешбэк
  cashback_max_categories: 3,
  cashback_cap: 100000,
  // Антифрод
  fraud_threshold: 500000,
  fraud_multiplier: 5,
  fraud_velocity: 5,
  // Экономика
  inflation_bp: 0,
  // Госпошлины
  fee_passport: 0,
  fee_inn: 0,
  fee_ip: 5000,
  passport_valid_months: 120,
  // Адреса и почта — задаются в админке (раздел «Система»), .env для них не нужен
  public_web_url: '',
  cors_origins: '',
  smtp_host: '',
  smtp_port: 465,
  smtp_secure: true,
  smtp_user: '',
  smtp_password: '',
  mail_from: '',
};

/** Секреты: в админку не отдаются, в экспорт не попадают. */
export const SECRET_KEYS = ['smtp_password', 'jwt_secret'];

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
    card_monthly_fee: s.card_monthly_fee,
    gift_card_fee: s.gift_card_fee,
    loan_rate_bp: s.loan_rate_bp,
    loan_max_amount: s.loan_max_amount,
    loan_max_months: s.loan_max_months,
    loan_late_fee_bp: s.loan_late_fee_bp,
    credit_rate_bp: s.credit_rate_bp,
    credit_grace_months: s.credit_grace_months,
    credit_min_payment_bp: s.credit_min_payment_bp,
    credit_late_fee: s.credit_late_fee,
    credit_max_limit: s.credit_max_limit,
    cashback_max_categories: s.cashback_max_categories,
    cashback_cap: s.cashback_cap,
    inflation_bp: s.inflation_bp,
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

/** Публичный адрес фронтенда (для ссылок в QR, чеках, письмах). */
export async function webUrl() {
  const v = String((await getSettings()).public_web_url || '').trim();
  return (v || config.publicWebUrl).replace(/\/$/, '');
}

/** Разрешённые источники CORS: из .env, из админки и origin публичного адреса. */
export async function allowedOrigins() {
  const s = await getSettings();
  const out = new Set(config.corsOrigins);
  for (const o of String(s.cors_origins || '').split(/[\s,]+/)) if (o) out.add(o.replace(/\/$/, ''));
  try { out.add(new URL(await webUrl()).origin); } catch { /* неверный адрес */ }
  return out;
}
