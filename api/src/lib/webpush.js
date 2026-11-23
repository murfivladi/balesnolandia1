// Web Push сервера: ключи VAPID и отправка в настоящие push-сервисы (RFC 8030).
// Шифрование и подпись — в webpush-crypto.js (их же использует push-сервис БалНета push.bln).
import { encrypt, vapidHeader, newKeyPair } from './webpush-crypto.js';
import { one, q } from '../db.js';
import { config } from '../config.js';
import { webUrl } from './settings.js';

export { encrypt, decrypt, newKeyPair, vapidJwt, vapidHeader, verifyVapid, fromB64, MAX_PAYLOAD, RECORD_SIZE } from './webpush-crypto.js';

// ——— Ключи сервера (VAPID) ———

let vapidCache = null;

/** Ключи VAPID сервера: из VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY или созданные один раз и сохранённые в базе. */
export async function vapidKeys() {
  if (vapidCache) return vapidCache;
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    vapidCache = { publicKey: process.env.VAPID_PUBLIC_KEY, privateKey: process.env.VAPID_PRIVATE_KEY };
    return vapidCache;
  }
  const read = async () => {
    const row = await one("SELECT v FROM settings WHERE k = 'vapid_keys'");
    if (!row) return null;
    const v = typeof row.v === 'string' ? JSON.parse(row.v) : row.v;
    return v?.publicKey && v?.privateKey ? v : null;
  };
  let keys = await read();
  if (!keys) {
    await q("INSERT IGNORE INTO settings (k, v) VALUES ('vapid_keys', ?)", [JSON.stringify(newKeyPair())]);
    keys = await read(); // два процесса: берём записанное первым
  }
  vapidCache = keys;
  return keys;
}

export function resetVapidCache() {
  vapidCache = null;
}

// ——— Отправка в настоящие push-сервисы ———

// Адреса подписок приходят от браузера. Сервер ходит только к известным push-сервисам — не по любому URL.
const PUSH_HOSTS = [/(^|\.)fcm\.googleapis\.com$/, /(^|\.)android\.googleapis\.com$/, /(^|\.)push\.services\.mozilla\.com$/, /(^|\.)push\.apple\.com$/, /(^|\.)notify\.windows\.com$/];

export function endpointAllowed(endpoint) {
  let u;
  try { u = new URL(String(endpoint)); } catch { return false; }
  if (u.protocol !== 'https:' || u.port || u.username) return false;
  return PUSH_HOSTS.some((re) => re.test(u.hostname));
}

/** Контакт отправителя в VAPID (sub): https-адрес сайта или mailto — push-сервисы Apple и Mozilla требуют такой. */
async function vapidSubject() {
  if (process.env.VAPID_SUBJECT) return process.env.VAPID_SUBJECT;
  const site = await webUrl();
  return site.startsWith('https://') ? site : 'mailto:no-reply@vladislavb.ru';
}

/** Отправленные push в тестах (сеть не трогаем). */
export const sentPushes = [];

/**
 * Отправить уведомление на подписку { endpoint, p256dh, auth }.
 * Возвращает { status, gone } — gone: подписка больше не действует (404/410), её нужно удалить.
 */
export async function sendWebPush(sub, payload, { ttl = 86400, urgency = 'normal', topic = null, subject } = {}) {
  if (!endpointAllowed(sub.endpoint)) return { status: 0, gone: true, error: 'endpoint' };
  const keys = await vapidKeys();
  const body = encrypt(typeof payload === 'string' ? payload : JSON.stringify(payload), sub);
  const headers = {
    TTL: String(ttl),
    Urgency: urgency,
    'Content-Encoding': 'aes128gcm',
    'Content-Type': 'application/octet-stream',
    Authorization: vapidHeader({ audience: new URL(sub.endpoint).origin, subject: subject || (await vapidSubject()), ...keys }),
  };
  if (topic) headers.Topic = topic;
  if (config.env === 'test') {
    sentPushes.push({ endpoint: sub.endpoint, headers, body });
    return { status: 201, gone: false };
  }
  try {
    const res = await fetch(sub.endpoint, { method: 'POST', headers, body, signal: AbortSignal.timeout(10000) });
    return { status: res.status, gone: res.status === 404 || res.status === 410 };
  } catch (e) {
    return { status: 0, gone: false, error: e.message };
  }
}
