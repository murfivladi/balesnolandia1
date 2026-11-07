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
  fee_driver: 2000,
  driver_valid_months: 120,
  fee_foreign_passport: 5000,
  foreign_passport_months: 60,
  fee_marriage: 1000,
  fee_birth: 0,
  // Налоги (этап 8): НДФЛ с зарплат, налог ИП с дохода раз в игровой год, налог на имущество
  ndfl_bp: 1300,
  ip_tax_bp: 600,
  property_tax_bp: 100,
  declaration_due_months: 2,
  fine_due_months: 2,
  tax_due_months: 2,
  // Неуплата: пени в месяц, через сколько месяцев просрочки — арест и запрет выезда, закрытие ИП
  penalty_bp: 100,
  sanction_months: 3,
  ip_close_months: 6,
  // Пособия (в игровой месяц) и зарплаты госслужащих
  benefits_approval: true,
  benefit_child: 3000,
  benefit_pension: 20000,
  pension_age: 65,
  benefit_unemployment: 10000,
  benefit_unemployment_months: 6,
  salary_official: 30000,
  salary_police: 30000,
  salary_tax: 30000,
  salary_doctor: 35000,
  // Ипотека и автокредит (ставки — в месяц)
  mortgage_rate_bp: 100,
  auto_loan_rate_bp: 150,
  mortgage_max_months: 120,
  mortgage_min_down_bp: 2000,
  // Медстраховка и выборы
  insurance_price: 5000,
  insurance_months: 12,
  vote_age: 18,
  // БалНет (этап Н3): организации, лицензии, домены. Сроки — в игровых месяцах.
  fee_org: 10000,
  fee_license: 20000,
  license_months: 24,
  domain_max_years: 10,
  domain_reserve_months: 1,
  domain_grace_months: 1,
  domain_redemption_months: 1,
  domain_redemption_fee: 2000,
  auction_months: 1,
  auction_pay_months: 1,
  // Хостинг (этап Н4)
  hosting_server_rent: 3000,
  hosting_server_disk_mb: 500,
  hosting_grace_months: 1,
  hosting_max_months: 12,
  hosting_max_file_kb: 5120,
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
    fee_driver: s.fee_driver,
    fee_foreign_passport: s.fee_foreign_passport,
    fee_marriage: s.fee_marriage,
    fee_birth: s.fee_birth,
    ndfl_bp: s.ndfl_bp,
    ip_tax_bp: s.ip_tax_bp,
    property_tax_bp: s.property_tax_bp,
    declaration_due_months: s.declaration_due_months,
    penalty_bp: s.penalty_bp,
    sanction_months: s.sanction_months,
    benefit_child: s.benefit_child,
    benefit_pension: s.benefit_pension,
    pension_age: s.pension_age,
    benefit_unemployment: s.benefit_unemployment,
    benefit_unemployment_months: s.benefit_unemployment_months,
    mortgage_rate_bp: s.mortgage_rate_bp,
    auto_loan_rate_bp: s.auto_loan_rate_bp,
    mortgage_max_months: s.mortgage_max_months,
    mortgage_min_down_bp: s.mortgage_min_down_bp,
    insurance_price: s.insurance_price,
    insurance_months: s.insurance_months,
    vote_age: s.vote_age,
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
