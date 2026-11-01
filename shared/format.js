// Форматы номеров БФ.

/** 12 цифр карты → "7700 1234 5678" */
export function formatCardNumber(n) {
  return String(n || '').replace(/\D/g, '').replace(/(\d{4})(?=\d)/g, '$1 ');
}

export function maskCardNumber(n) {
  const d = String(n || '').replace(/\D/g, '');
  return d.length >= 4 ? `•••• ${d.slice(-4)}` : d;
}

export const PASSPORT_RE = /^BLN-\d{4}-\d{4}$/;

export function normalizePassport(s) {
  const d = String(s || '').toUpperCase().replace(/[^0-9]/g, '');
  if (d.length !== 8) return null;
  return `BLN-${d.slice(0, 4)}-${d.slice(4)}`;
}

/** Контрольная цифра (алгоритм Луна) — карты БФ используют её в последней позиции. */
export function luhnDigit(digits) {
  let sum = 0;
  const s = String(digits);
  for (let i = 0; i < s.length; i++) {
    let d = Number(s[s.length - 1 - i]);
    if (i % 2 === 0) { d *= 2; if (d > 9) d -= 9; }
    sum += d;
  }
  return (10 - (sum % 10)) % 10;
}

export function isValidCardNumber(n) {
  const d = String(n || '').replace(/\D/g, '');
  return d.length === 12 && luhnDigit(d.slice(0, 11)) === Number(d[11]);
}

export function ageFrom(birthDate, now = new Date()) {
  const b = new Date(birthDate);
  if (Number.isNaN(b.getTime())) return null;
  let age = now.getFullYear() - b.getFullYear();
  const m = now.getMonth() - b.getMonth();
  if (m < 0 || (m === 0 && now.getDate() < b.getDate())) age--;
  return age;
}
