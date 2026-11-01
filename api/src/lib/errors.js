export class HttpError extends Error {
  constructor(status, code, message, data) {
    super(message || code);
    this.statusCode = status;
    this.code = code;
    this.data = data;
  }
}

export const bad = (code, message, data) => new HttpError(400, code, message, data);
export const unauthorized = (message = 'Нужно войти') => new HttpError(401, 'unauthorized', message);
export const forbidden = (message = 'Недостаточно прав') => new HttpError(403, 'forbidden', message);
export const notFound = (message = 'Не найдено') => new HttpError(404, 'not_found', message);
export const conflict = (code, message, data) => new HttpError(409, code, message, data);

/** Проверка входных данных без схем: простые и читаемые сообщения. */
export function need(cond, message, code = 'invalid') {
  if (!cond) throw bad(code, message);
}

export function int(v, name, { min = -Infinity, max = Infinity } = {}) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (!Number.isSafeInteger(n) || n < min || n > max) throw bad('invalid', `Неверное значение: ${name}`);
  return n;
}

export function str(v, name, { min = 1, max = 255, optional = false } = {}) {
  if ((v === undefined || v === null || v === '') && optional) return null;
  if (typeof v !== 'string') throw bad('invalid', `Не заполнено: ${name}`);
  const s = v.trim();
  if (s.length < min || s.length > max) throw bad('invalid', `Неверная длина: ${name}`);
  return s;
}

export function email(v) {
  const s = str(v, 'email', { max: 190 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(s)) throw bad('invalid_email', 'Неверный email');
  return s;
}

export function amount(v, name = 'сумма') {
  return int(v, name, { min: 1, max: 1e13 });
}

/** Ключ идемпотентности от клиента, привязанный к пользователю. */
export function idemKey(req, scope) {
  const k = req.headers['idempotency-key'];
  if (!k) return null;
  return `${scope}:${String(k).slice(0, 64)}`;
}

