// Игровое время: номер игрового месяца от начала игры (0 = январь 1-го года БФ).

export const MONTHS_RU = ['январь', 'февраль', 'март', 'апрель', 'май', 'июнь', 'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь'];
export const MONTHS_IT = ['gennaio', 'febbraio', 'marzo', 'aprile', 'maggio', 'giugno', 'luglio', 'agosto', 'settembre', 'ottobre', 'novembre', 'dicembre'];

export function gameMonthParts(index) {
  const i = Math.max(0, Math.trunc(index));
  return { month: (i % 12) + 1, year: Math.floor(i / 12) + 1 };
}

/** Срок карты: ММ/ГГ */
export function mmYY(index) {
  const { month, year } = gameMonthParts(index);
  return `${String(month).padStart(2, '0')}/${String(year % 100).padStart(2, '0')}`;
}

/** "ММ/ГГ" → индекс игрового месяца или null */
export function parseMmYY(s) {
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{2})\s*$/.exec(String(s || ''));
  if (!m) return null;
  const month = Number(m[1]);
  const year = Number(m[2]);
  if (month < 1 || month > 12 || year < 1) return null;
  return (year - 1) * 12 + (month - 1);
}

export function gameDateLabel(index, lang = 'ru') {
  const { month, year } = gameMonthParts(index);
  const names = lang === 'it' ? MONTHS_IT : MONTHS_RU;
  return lang === 'it' ? `${names[month - 1]} anno ${year}` : `${names[month - 1]} ${year} г. БФ`;
}
