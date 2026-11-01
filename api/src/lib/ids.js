import crypto from 'node:crypto';
import { luhnDigit } from '@bln/shared/format.js';

export function randomDigits(n) {
  let s = '';
  while (s.length < n) s += crypto.randomInt(0, 10);
  return s;
}

export function randomToken(bytes = 16) {
  return crypto.randomBytes(bytes).toString('base64url');
}

/** Номер карты БФ: 12 цифр, префикс 77, последняя — контрольная. */
export function newCardNumber() {
  const body = '77' + randomDigits(9);
  return body + luhnDigit(body);
}

/** Номер счёта: 16 знаков, BF + тип + цифры — не похож на IBAN и реальные счета. */
export function newAccountNumber(type) {
  const t = { current: '40', savings: '42', term: '43', gift: '44', business: '45', child: '46', credit: '47', loan: '48' }[type] || '49';
  return `BF${t}${randomDigits(12)}`;
}

export const newPassportNumber = () => `BLN-${randomDigits(4)}-${randomDigits(4)}`;
export const newInvoiceNumber = () => `KV${randomDigits(10)}`;
export const newVerifyCode = () => randomToken(12);
export const newTerminalCode = () => randomDigits(6);

/** Повторить вставку при совпадении уникального ключа (случайные номера). */
export async function withUnique(fn, tries = 8) {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY' && i < tries) continue;
      throw err;
    }
  }
}
