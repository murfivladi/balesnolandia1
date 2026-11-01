// Одноразовые коды на email: 6 цифр, 10 минут, 5 попыток.
import { q, one } from '../db.js';
import { bad } from './errors.js';
import { randomDigits } from './ids.js';
import { hash, verifyHash } from './auth.js';
import { sendMail } from './mail.js';

const TTL_MIN = 10;
const MAX_ATTEMPTS = 5;

export async function sendCode(kind, email) {
  const recent = await one('SELECT COUNT(*) AS n FROM email_codes WHERE user_kind = ? AND email = ? AND created_at > NOW(3) - INTERVAL 1 MINUTE', [kind, email]);
  if (recent.n >= 2) throw bad('too_many_codes', 'Подождите минуту перед новым кодом');
  const code = randomDigits(6);
  await q('UPDATE email_codes SET used_at = NOW(3) WHERE user_kind = ? AND email = ? AND used_at IS NULL', [kind, email]);
  await q('INSERT INTO email_codes (user_kind, email, code_hash, expires_at) VALUES (?, ?, ?, NOW(3) + INTERVAL ? MINUTE)', [kind, email, await hash(code), TTL_MIN]);
  const brand = kind === 'bank' ? 'ВлодБанк' : 'ВлодУслуги';
  await sendMail({ to: email, brand, subject: `${brand}: код входа ${code}`, text: `Ваш код для входа: ${code}\nКод действует ${TTL_MIN} минут. Никому его не сообщайте.` });
  return code;
}

export async function checkCode(kind, email, code) {
  const row = await one('SELECT * FROM email_codes WHERE user_kind = ? AND email = ? AND used_at IS NULL ORDER BY id DESC LIMIT 1', [kind, email]);
  if (!row || new Date(row.expires_at) < new Date()) throw bad('code_expired', 'Код истёк — запросите новый');
  if (row.attempts >= MAX_ATTEMPTS) throw bad('code_attempts', 'Слишком много попыток — запросите новый код');
  await q('UPDATE email_codes SET attempts = attempts + 1 WHERE id = ?', [row.id]);
  if (!(await verifyHash(String(code || '').trim(), row.code_hash))) {
    throw bad('code_wrong', `Неверный код. Осталось попыток: ${MAX_ATTEMPTS - row.attempts - 1}`);
  }
  await q('UPDATE email_codes SET used_at = NOW(3) WHERE id = ?', [row.id]);
  return true;
}
