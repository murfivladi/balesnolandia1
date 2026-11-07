// Криптография Web Push без сторонних библиотек: шифрование тела (RFC 8291, aes128gcm) и подпись VAPID (RFC 8292).
// Чистый модуль (без базы): им пользуются сервер, push-сервис БалНета push.bln и серверный код сайтов (QuickJS).
import crypto from 'node:crypto';

export const b64 = (buf) => Buffer.from(buf).toString('base64url');
export const fromB64 = (s) => Buffer.from(String(s || '').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_'), 'base64url');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data).digest();

export const RECORD_SIZE = 4096;
/** Наибольшее тело, которое помещается в одну запись aes128gcm (как у настоящих push-сервисов). */
export const MAX_PAYLOAD = 4096 - 86 - 17;

/** Новая пара P-256: { publicKey (65 байт, base64url), privateKey (d, base64url) }. */
export function newKeyPair() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return { publicKey: b64(ecdh.getPublicKey()), privateKey: b64(ecdh.getPrivateKey()) };
}

function isPoint(buf) {
  return buf.length === 65 && buf[0] === 4;
}

/** Открытый ключ P-256 из 65 байт → KeyObject (для проверки подписи). */
function publicKeyObject(raw) {
  return crypto.createPublicKey({ key: { kty: 'EC', crv: 'P-256', x: b64(raw.subarray(1, 33)), y: b64(raw.subarray(33)) }, format: 'jwk' });
}

function privateKeyObject(publicRaw, d) {
  return crypto.createPrivateKey({ key: { kty: 'EC', crv: 'P-256', x: b64(publicRaw.subarray(1, 33)), y: b64(publicRaw.subarray(33)), d: b64(d) }, format: 'jwk' });
}

function derive({ ecdhSecret, authSecret, uaPublic, asPublic, salt }) {
  const prkKey = hmac(authSecret, ecdhSecret);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), uaPublic, asPublic, Buffer.from([1])]);
  const ikm = hmac(prkKey, keyInfo);
  const prk = hmac(salt, ikm);
  const cek = hmac(prk, Buffer.from('Content-Encoding: aes128gcm\0\x01')).subarray(0, 16);
  const nonce = hmac(prk, Buffer.from('Content-Encoding: nonce\0\x01')).subarray(0, 12);
  return { cek, nonce };
}

/** Шифрование тела для подписки { p256dh, auth } (RFC 8291). Возвращает Buffer — тело запроса. */
export function encrypt(payload, { p256dh, auth }) {
  const uaPublic = fromB64(p256dh);
  const authSecret = fromB64(auth);
  if (!isPoint(uaPublic)) throw new Error('p256dh: нужен открытый ключ P-256 (65 байт)');
  if (authSecret.length < 16) throw new Error('auth: нужен секрет 16 байт');
  const data = Buffer.from(payload);
  if (data.length > MAX_PAYLOAD) throw new Error(`Тело больше ${MAX_PAYLOAD} байт`);
  const ecdh = crypto.createECDH('prime256v1');
  const asPublic = ecdh.generateKeys();
  const ecdhSecret = ecdh.computeSecret(uaPublic);
  const salt = crypto.randomBytes(16);
  const { cek, nonce } = derive({ ecdhSecret, authSecret, uaPublic, asPublic, salt });
  const cipher = crypto.createCipheriv('aes-128-gcm', cek, nonce);
  const body = Buffer.concat([cipher.update(Buffer.concat([data, Buffer.from([2])])), cipher.final(), cipher.getAuthTag()]);
  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(RECORD_SIZE, 16);
  header[20] = asPublic.length;
  return Buffer.concat([header, asPublic, body]);
}

/**
 * Расшифровка тела aes128gcm ключами получателя (privateKey — d, publicKey — 65 байт, auth).
 * Ошибка — исключение с понятным текстом (его увидит отправитель в ответе push-сервиса).
 */
export function decrypt(body, { publicKey, privateKey, auth }) {
  const buf = Buffer.from(body);
  if (buf.length < 21 + 65 + 17) throw new Error('aes128gcm: тело слишком короткое');
  const salt = buf.subarray(0, 16);
  const rs = buf.readUInt32BE(16);
  const idlen = buf[20];
  if (rs < 18) throw new Error('aes128gcm: неверный размер записи');
  if (idlen !== 65) throw new Error('aes128gcm: keyid должен быть открытым ключом отправителя (65 байт)');
  const asPublic = buf.subarray(21, 21 + idlen);
  const cipherText = buf.subarray(21 + idlen);
  if (cipherText.length > rs) throw new Error('aes128gcm: в Web Push тело — одна запись');
  if (!isPoint(asPublic)) throw new Error('aes128gcm: неверный ключ отправителя');
  const uaPublic = fromB64(publicKey);
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.setPrivateKey(fromB64(privateKey));
  let ecdhSecret;
  try { ecdhSecret = ecdh.computeSecret(asPublic); } catch { throw new Error('aes128gcm: ключ отправителя не на кривой P-256'); }
  const { cek, nonce } = derive({ ecdhSecret, authSecret: fromB64(auth), uaPublic, asPublic, salt });
  const decipher = crypto.createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(cipherText.subarray(cipherText.length - 16));
  let plain;
  try {
    plain = Buffer.concat([decipher.update(cipherText.subarray(0, cipherText.length - 16)), decipher.final()]);
  } catch {
    throw new Error('aes128gcm: не удалось расшифровать — тело зашифровано не для этой подписки (проверьте p256dh и auth)');
  }
  let end = plain.length - 1;
  while (end >= 0 && plain[end] === 0) end--;
  if (end < 0 || plain[end] !== 2) throw new Error('aes128gcm: нет разделителя последней записи (0x02)');
  return plain.subarray(0, end);
}

// ——— VAPID ———

/** JWT ES256 для VAPID: aud — origin push-сервиса, exp — не дальше 24 часов. */
export function vapidJwt({ audience, subject, publicKey, privateKey, expSeconds = 12 * 3600, now = Date.now() }) {
  const header = b64(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + expSeconds, sub: subject }));
  const key = privateKeyObject(fromB64(publicKey), fromB64(privateKey));
  const sig = crypto.sign('sha256', Buffer.from(`${header}.${claims}`), { key, dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${b64(sig)}`;
}

export function vapidHeader(opts) {
  return `vapid t=${vapidJwt(opts)}, k=${opts.publicKey}`;
}

/**
 * Проверка заголовка Authorization: vapid t=…, k=… (как у push-сервиса).
 * Возвращает { ok, key, claims } или { ok: false, status, message }.
 */
export function verifyVapid(header, { audience, now = Date.now() }) {
  const m = /^vapid\s+(.+)$/i.exec(String(header || '').trim());
  if (!m) return { ok: false, status: 401, message: 'Нужен заголовок Authorization: vapid t=<JWT>, k=<открытый ключ>' };
  const params = {};
  for (const part of m[1].split(',')) {
    const i = part.indexOf('=');
    if (i > 0) params[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).trim();
  }
  if (!params.t || !params.k) return { ok: false, status: 401, message: 'VAPID: нужны параметры t (JWT) и k (ключ)' };
  const keyRaw = fromB64(params.k);
  if (!isPoint(keyRaw)) return { ok: false, status: 401, message: 'VAPID: k — открытый ключ P-256 (65 байт, base64url)' };
  const parts = params.t.split('.');
  if (parts.length !== 3) return { ok: false, status: 401, message: 'VAPID: t — это JWT из трёх частей' };
  let head;
  let claims;
  try {
    head = JSON.parse(fromB64(parts[0]).toString('utf8'));
    claims = JSON.parse(fromB64(parts[1]).toString('utf8'));
  } catch {
    return { ok: false, status: 401, message: 'VAPID: JWT не разбирается' };
  }
  if (head.alg !== 'ES256') return { ok: false, status: 401, message: 'VAPID: алгоритм подписи — только ES256' };
  const sig = fromB64(parts[2]);
  let good = false;
  try { good = sig.length === 64 && crypto.verify('sha256', Buffer.from(`${parts[0]}.${parts[1]}`), { key: publicKeyObject(keyRaw), dsaEncoding: 'ieee-p1363' }, sig); } catch { good = false; }
  if (!good) return { ok: false, status: 403, message: 'VAPID: подпись JWT не сходится с ключом k' };
  if (claims.aud !== audience) return { ok: false, status: 403, message: `VAPID: aud должен быть ${audience}` };
  const t = Math.floor(now / 1000);
  if (!Number.isFinite(claims.exp) || claims.exp <= t) return { ok: false, status: 403, message: 'VAPID: срок JWT (exp) истёк' };
  if (claims.exp > t + 24 * 3600) return { ok: false, status: 403, message: 'VAPID: exp не может быть дальше 24 часов' };
  if (claims.sub && !/^(mailto:|https:\/\/)/.test(String(claims.sub))) return { ok: false, status: 403, message: 'VAPID: sub — адрес mailto: или https://' };
  return { ok: true, key: params.k, claims };
}

/**
 * Запрос к push-сервису для подписки (как sendNotification из npm-пакета web-push):
 * { endpoint, headers, bodyB64 }. options: vapidDetails { subject, publicKey, privateKey }, TTL, urgency, topic.
 */
export function webpushPrepare(subscription, payload, options = {}) {
  const endpoint = String(subscription?.endpoint || '');
  let u;
  try { u = new URL(endpoint); } catch { throw new Error('webpush: у подписки нет endpoint'); }
  const headers = { TTL: String(Number.isFinite(Number(options.TTL)) ? Math.max(0, Math.floor(Number(options.TTL))) : 2419200) };
  if (options.urgency) headers.Urgency = String(options.urgency);
  if (options.topic) headers.Topic = String(options.topic);
  let body = Buffer.alloc(0);
  if (payload !== null && payload !== undefined && payload !== '') {
    if (!subscription.keys?.p256dh || !subscription.keys?.auth) throw new Error('webpush: для тела нужны keys.p256dh и keys.auth подписки');
    body = encrypt(String(payload), subscription.keys);
    headers['Content-Encoding'] = 'aes128gcm';
    headers['Content-Type'] = 'application/octet-stream';
  }
  const v = options.vapidDetails;
  if (v) {
    if (!v.publicKey || !v.privateKey) throw new Error('webpush: vapidDetails — publicKey и privateKey');
    if (!/^(mailto:|https:\/\/)/.test(String(v.subject || ''))) throw new Error('webpush: vapidDetails.subject — mailto: или https://');
    headers.Authorization = vapidHeader({ audience: u.origin, subject: v.subject, publicKey: v.publicKey, privateKey: v.privateKey });
  }
  return { endpoint, headers, bodyB64: body.toString('base64') };
}
