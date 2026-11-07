// Push-уведомления (этап Н10).
// — Настоящий Web Push: подписки пользователей ВлодБанка и ВлодУслуг; notify() отправляет каждое уведомление
//   ленты на телефон и компьютер, даже когда приложение закрыто.
// — Push-сервис БалНета push.bln: сайты игроков подписывают посетителя через PushManager.subscribe во ВлодБраузере
//   и шлют сообщения своим сервером на https://push.bln/send/<token> по протоколу Web Push (RFC 8030):
//   TTL, Urgency, Topic, VAPID (RFC 8292), тело aes128gcm (RFC 8291). Браузер показывает уведомление,
//   а если включён настоящий Web Push — оно приходит и на телефон.
import crypto from 'node:crypto';
import { q, one } from '../db.js';
import { publish, listeners } from './hub.js';
import { webUrl } from './settings.js';
import { bad, forbidden } from './errors.js';
import { randomToken } from './ids.js';
import { newKeyPair, decrypt, verifyVapid, sendWebPush, endpointAllowed, fromB64, MAX_PAYLOAD } from './webpush.js';

export const PUSH_HOST = 'push.bln';
export const PUSH_ORIGIN = `https://${PUSH_HOST}`;
const MAX_SUBS_PER_USER = 10;
const MAX_INBOX = 200;
const MAX_TTL = 28 * 24 * 3600;
const RATE_PER_MIN = 30;
const URGENCY = ['very-low', 'low', 'normal', 'high'];

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const clip = (s, n) => (s == null ? null : String(s).slice(0, n));

function cleanSub(sub) {
  const endpoint = String(sub?.endpoint || '');
  const p256dh = String(sub?.keys?.p256dh || '');
  const auth = String(sub?.keys?.auth || '');
  if (!endpointAllowed(endpoint)) throw bad('push_endpoint', 'Адрес подписки — не известный push-сервис (FCM, Mozilla, Apple, Windows)');
  if (endpoint.length > 500) throw bad('push_endpoint', 'Слишком длинный адрес подписки');
  if (fromB64(p256dh).length !== 65 || fromB64(auth).length < 16 || p256dh.length > 200 || auth.length > 100) throw bad('push_keys', 'Неверные ключи подписки (p256dh, auth)');
  return { endpoint, p256dh, auth };
}

// ——— Настоящий Web Push для пользователей ———

export async function subscribeUser(kind, userId, sub, userAgent) {
  const s = cleanSub(sub);
  const ua = clip(userAgent, 200);
  // Тот же адрес мог принадлежать другому аккаунту на этом устройстве — переходит к текущему.
  await q(`INSERT INTO push_subscriptions (user_kind, user_id, endpoint, p256dh, auth, user_agent) VALUES (?, ?, ?, ?, ?, ?)
    ON DUPLICATE KEY UPDATE user_kind = VALUES(user_kind), user_id = VALUES(user_id), p256dh = VALUES(p256dh), auth = VALUES(auth), user_agent = VALUES(user_agent), fails = 0`,
  [kind, userId, s.endpoint, s.p256dh, s.auth, ua]);
  const extra = await q('SELECT id FROM push_subscriptions WHERE user_kind = ? AND user_id = ? ORDER BY id DESC LIMIT 100 OFFSET ?', [kind, userId, MAX_SUBS_PER_USER]);
  if (extra.length) await q(`DELETE FROM push_subscriptions WHERE id IN (${extra.map(() => '?').join(',')})`, extra.map((r) => r.id));
  return { ok: true };
}

export async function unsubscribeUser(kind, userId, endpoint) {
  const r = await q('DELETE FROM push_subscriptions WHERE user_kind = ? AND user_id = ? AND endpoint = ?', [kind, userId, String(endpoint || '')]);
  return { ok: true, removed: r.affectedRows };
}

export async function userDevices(kind, userId) {
  const rows = await q('SELECT id, endpoint, user_agent, created_at, last_ok_at FROM push_subscriptions WHERE user_kind = ? AND user_id = ? ORDER BY id DESC', [kind, userId]);
  return rows.map((r) => ({ id: r.id, service: new URL(r.endpoint).hostname, endpoint: r.endpoint, user_agent: r.user_agent, created_at: r.created_at, last_ok_at: r.last_ok_at }));
}

export async function removeUserDevice(kind, userId, id) {
  await q('DELETE FROM push_subscriptions WHERE user_kind = ? AND user_id = ? AND id = ?', [kind, userId, Number(id)]);
  return { ok: true };
}

/** Отправка на одну подписку с учётом ответа сервиса: 404/410 — удалить, 5 неудач подряд — удалить. */
async function sendTracked(table, row, keys, payload, opts) {
  const r = await sendWebPush(keys, payload, opts);
  if (table === 'user') {
    if (r.gone) await q('DELETE FROM push_subscriptions WHERE id = ?', [row.id]);
    else if (r.status >= 200 && r.status < 300) await q('UPDATE push_subscriptions SET last_ok_at = NOW(3), fails = 0 WHERE id = ?', [row.id]);
    else await q('DELETE FROM push_subscriptions WHERE id = ? AND fails >= 4', [row.id]).then(() => q('UPDATE push_subscriptions SET fails = fails + 1 WHERE id = ?', [row.id]));
  } else if (r.gone) {
    await q('UPDATE balnet_push_devices SET web_endpoint = NULL, web_p256dh = NULL, web_auth = NULL WHERE id = ?', [row.id]);
  }
  return r;
}

/** Уведомление ленты → Web Push на все устройства пользователя. link — маршрут приложения (#/...). */
export async function pushToUser(kind, userId, { title, body = null, link = null, tag = null }) {
  const subs = await q('SELECT * FROM push_subscriptions WHERE user_kind = ? AND user_id = ?', [kind, userId]);
  if (!subs.length) return 0;
  const app = kind === 'bank' ? 'bank' : 'services';
  const url = `${await webUrl()}/${app}/${link && String(link).startsWith('#') ? link : ''}`;
  const payload = { title: clip(title, 200), body: clip(body, 500) || '', url, app, tag };
  let n = 0;
  for (const s of subs) {
    const r = await sendTracked('user', s, s, payload, { ttl: 86400, urgency: 'normal' });
    if (r.status >= 200 && r.status < 300) n++;
  }
  return n;
}

// ——— Устройства ВлодБраузера ———

export async function createDevice(label) {
  const token = randomToken(24);
  const r = await q('INSERT INTO balnet_push_devices (token_hash, label, last_seen_at) VALUES (?, ?, NOW(3))', [sha(token), clip(label, 80) || null]);
  return { id: r.insertId, token };
}

/** Устройство по номеру и секрету — или ошибка 403. */
export async function deviceAuth(id, token) {
  const d = await one('SELECT * FROM balnet_push_devices WHERE id = ?', [Number(id) || 0]);
  if (!d || !token || d.token_hash !== sha(token)) throw forbidden('Устройство push БалНета не найдено — включите уведомления заново');
  return d;
}

export async function deviceOk(id, token) {
  const d = await one('SELECT token_hash FROM balnet_push_devices WHERE id = ?', [Number(id) || 0]);
  return !!d && !!token && d.token_hash === sha(token);
}

export async function setDeviceWeb(device, sub) {
  if (!sub) {
    await q('UPDATE balnet_push_devices SET web_endpoint = NULL, web_p256dh = NULL, web_auth = NULL WHERE id = ?', [device.id]);
    return { ok: true, web: false };
  }
  const s = cleanSub(sub);
  await q('UPDATE balnet_push_devices SET web_endpoint = ?, web_p256dh = ?, web_auth = ? WHERE id = ?', [s.endpoint, s.p256dh, s.auth, device.id]);
  return { ok: true, web: true };
}

export async function deleteDevice(device) {
  await q('DELETE FROM balnet_push_messages WHERE device_id = ?', [device.id]);
  await q('DELETE FROM balnet_push_subs WHERE device_id = ?', [device.id]);
  await q('DELETE FROM balnet_push_devices WHERE id = ?', [device.id]);
  return { ok: true };
}

// ——— Подписки сайтов ———

const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/;

/** Push API работает только в защищённом контексте: подписаться может лишь сайт на https. */
export function cleanOrigin(origin) {
  const m = /^https:\/\/([^/:?#]+)$/.exec(String(origin || '').toLowerCase());
  if (!m || !HOST_RE.test(m[1])) throw bad('push_origin', 'Push доступен только сайтам на https:// (защищённый контекст)');
  return `https://${m[1]}`;
}

function subJson(s) {
  return {
    endpoint: `${PUSH_ORIGIN}/send/${s.token}`,
    expirationTime: null,
    keys: { p256dh: s.p256dh, auth: s.auth },
    applicationServerKey: s.app_server_key || null,
  };
}

export async function siteSubscribe(device, origin, applicationServerKey) {
  const o = cleanOrigin(origin);
  let key = null;
  if (applicationServerKey) {
    const raw = fromB64(applicationServerKey);
    if (raw.length !== 65 || raw[0] !== 4) throw bad('push_key', 'applicationServerKey — открытый ключ VAPID P-256 (65 байт)');
    key = raw.toString('base64url');
  }
  const cur = await one('SELECT * FROM balnet_push_subs WHERE device_id = ? AND origin = ?', [device.id, o]);
  if (cur) {
    // Как в Chrome: подписка уже есть с другим ключом — сначала unsubscribe().
    if ((cur.app_server_key || null) !== key) throw bad('push_invalid_state', 'InvalidStateError: подписка уже есть с другим applicationServerKey — сначала отмените её (unsubscribe)');
    return subJson(cur);
  }
  const kp = newKeyPair();
  const s = { device_id: device.id, origin: o, token: randomToken(32), app_server_key: key, p256dh: kp.publicKey, priv: kp.privateKey, auth: randomToken(16) };
  await q('INSERT INTO balnet_push_subs (device_id, origin, token, app_server_key, p256dh, priv, auth) VALUES (?, ?, ?, ?, ?, ?, ?)',
    [s.device_id, s.origin, s.token, s.app_server_key, s.p256dh, s.priv, s.auth]);
  return subJson(s);
}

export async function siteSubscription(device, origin) {
  const s = await one('SELECT * FROM balnet_push_subs WHERE device_id = ? AND origin = ?', [device.id, cleanOrigin(origin)]);
  return s ? subJson(s) : null;
}

export async function siteUnsubscribe(device, origin) {
  const o = cleanOrigin(origin);
  const r = await q('DELETE FROM balnet_push_subs WHERE device_id = ? AND origin = ?', [device.id, o]);
  return { ok: true, removed: r.affectedRows > 0 };
}

export async function deviceSubs(device) {
  const rows = await q('SELECT origin, pushes, last_push_at, created_at FROM balnet_push_subs WHERE device_id = ? ORDER BY origin', [device.id]);
  return rows;
}

export async function inbox(device, after = 0) {
  await q('UPDATE balnet_push_devices SET last_seen_at = NOW(3) WHERE id = ?', [device.id]);
  const rows = await q('SELECT id, origin, title, body, url, tag, urgency, encrypted, created_at FROM balnet_push_messages WHERE device_id = ? AND id > ? AND expires_at > NOW(3) ORDER BY id DESC LIMIT 100', [device.id, Number(after) || 0]);
  return rows.reverse();
}

// ——— push.bln: приём сообщений от серверов сайтов ———

const rate = new Map(); // id подписки → [время запросов]
function rateOk(id) {
  const t = Date.now();
  const list = (rate.get(id) || []).filter((x) => t - x < 60000);
  if (list.length >= RATE_PER_MIN) { rate.set(id, list); return false; }
  list.push(t);
  rate.set(id, list);
  if (rate.size > 5000) rate.delete(rate.keys().next().value);
  return true;
}

function reply(status, text, headers = {}) {
  return { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers }, body: Buffer.from(text ? `${text}\n` : '') };
}

const INFO = `БалПуш — push-сервис БалНета (Web Push, RFC 8030).
Подписку создаёт ВлодБраузер: registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey }).
Отправка: POST https://push.bln/send/<token>
  TTL: <секунды>                       — обязательно
  Urgency: very-low | low | normal | high
  Topic: <до 32 символов>              — новое сообщение заменяет старое с тем же Topic
  Authorization: vapid t=<JWT>, k=<ключ> — если подписка создана с applicationServerKey
  Content-Encoding: aes128gcm          — тело зашифровано ключами подписки (p256dh, auth)
Тело — JSON {"title","body","url","tag"} или текст. Без шифрования принимается JSON (учебный режим).
Ответ 201 Created — сообщение принято.`;

function parseMessage(text, origin) {
  const host = new URL(origin).host;
  let msg = null;
  const s = text.trim();
  if (s.startsWith('{')) {
    try { msg = JSON.parse(s); } catch { msg = null; }
  }
  if (!msg || typeof msg !== 'object') msg = s ? { title: host, body: s } : { title: host, body: 'Сайт обновился в фоновом режиме' };
  const title = clip(msg.title || msg.notification?.title || host, 200).trim() || host;
  const body = clip(msg.body ?? msg.notification?.body ?? '', 1000);
  // Ссылка уведомления — только на свой сайт: чужой адрес заменяется главной страницей.
  let url = `${origin}/`;
  const raw = msg.url || msg.data?.url || msg.notification?.data?.url;
  if (raw) {
    try {
      const u = new URL(String(raw), `${origin}/`);
      if (u.origin === origin) url = u.href.slice(0, 500);
    } catch { /* оставляем главную */ }
  }
  return { title, body, url, tag: clip(msg.tag || msg.notification?.tag || null, 100) };
}

/**
 * HTTP-запрос к push.bln по сети БалНета (fetch сервера сайта, curl из терминала).
 * Возвращает { status, headers, body: Buffer } — как ответ сайта.
 */
export async function pushService({ method, path, headers = {}, body = null }) {
  const p = String(path || '/').split('?')[0];
  const h = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), String(v)]));
  if (p === '/' || p === '') {
    if (method !== 'GET' && method !== 'HEAD') return reply(405, 'Метод не разрешён', { allow: 'GET' });
    return reply(200, method === 'HEAD' ? '' : INFO);
  }
  const m = /^\/send\/([A-Za-z0-9_-]{20,64})$/.exec(p);
  if (!m) return reply(404, 'Не найдено. Адрес отправки: /send/<token> из подписки');
  if (method === 'OPTIONS') return reply(204, '', { allow: 'POST' });
  if (method !== 'POST') return reply(405, 'Отправка — только POST', { allow: 'POST' });
  const sub = await one('SELECT * FROM balnet_push_subs WHERE token = ?', [m[1]]);
  if (!sub) return reply(410, 'Gone: подписки нет — посетитель отписался. Удалите её у себя');
  if (h.ttl === undefined || !/^\d+$/.test(h.ttl.trim())) return reply(400, 'Нужен заголовок TTL: сколько секунд хранить сообщение (0 — только если устройство на связи)');
  const ttl = Math.min(Number(h.ttl), MAX_TTL);
  const urgency = (h.urgency || 'normal').trim().toLowerCase();
  if (!URGENCY.includes(urgency)) return reply(400, 'Urgency: very-low, low, normal или high');
  const topic = h.topic ? h.topic.trim() : null;
  if (topic && !/^[A-Za-z0-9_-]{1,32}$/.test(topic)) return reply(400, 'Topic: до 32 символов из A-Z a-z 0-9 _ -');
  if (sub.app_server_key) {
    const v = verifyVapid(h.authorization, { audience: PUSH_ORIGIN });
    if (!v.ok) return reply(v.status, v.message);
    if (v.key !== sub.app_server_key) return reply(403, 'VAPID: ключ k не совпадает с applicationServerKey подписки');
  }
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body == null ? '' : String(body));
  if (buf.length > 4096) return reply(413, 'Payload Too Large: тело push — не больше 4096 байт');
  const enc = (h['content-encoding'] || '').trim().toLowerCase();
  let text = '';
  if (buf.length) {
    if (enc === 'aes128gcm') {
      try { text = decrypt(buf, { publicKey: sub.p256dh, privateKey: sub.priv, auth: sub.auth }).toString('utf8'); } catch (e) { return reply(400, e.message); }
    } else if (enc && enc !== 'identity') {
      return reply(415, `Content-Encoding ${enc} не поддерживается: нужен aes128gcm`);
    } else {
      if (buf.length > MAX_PAYLOAD) return reply(413, `Без шифрования — не больше ${MAX_PAYLOAD} байт`);
      text = buf.toString('utf8');
      if (!/^\s*\{/.test(text)) return reply(400, 'Без шифрования принимается только JSON {"title","body","url"}. Текст — зашифруйте (Content-Encoding: aes128gcm)');
    }
  }
  if (!rateOk(sub.id)) return reply(429, 'Too Many Requests: не больше 30 сообщений в минуту на подписку', { 'retry-after': '60' });
  const msg = parseMessage(text, sub.origin);
  await q('UPDATE balnet_push_subs SET pushes = pushes + 1, last_push_at = NOW(3) WHERE id = ?', [sub.id]);
  const id = await deliver(sub, msg, { ttl, urgency, topic, encrypted: enc === 'aes128gcm' });
  return reply(201, '', { location: `${PUSH_ORIGIN}/m/${id || 0}`, ttl: String(ttl) });
}

async function deliver(sub, msg, { ttl, urgency, topic, encrypted }) {
  const ch = `push:${sub.device_id}`;
  const online = listeners(ch) > 0;
  let id = 0;
  // TTL 0 — доставить сейчас или никогда: в очередь не ставим, если браузер не на связи.
  if (ttl > 0 || online) {
    if (topic) await q('DELETE FROM balnet_push_messages WHERE device_id = ? AND sub_id = ? AND topic = ?', [sub.device_id, sub.id, topic]);
    const r = await q('INSERT INTO balnet_push_messages (device_id, sub_id, origin, title, body, url, tag, topic, urgency, encrypted, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, DATE_ADD(NOW(3), INTERVAL ? SECOND))',
      [sub.device_id, sub.id, sub.origin, msg.title, msg.body, msg.url, msg.tag, topic, urgency, encrypted ? 1 : 0, Math.max(ttl, 60)]);
    id = r.insertId;
    const old = await q('SELECT id FROM balnet_push_messages WHERE device_id = ? ORDER BY id DESC LIMIT 1 OFFSET ?', [sub.device_id, MAX_INBOX]);
    if (old.length) await q('DELETE FROM balnet_push_messages WHERE device_id = ? AND id <= ?', [sub.device_id, old[0].id]);
  }
  publish(ch, { type: 'push', message: { id, origin: sub.origin, ...msg, urgency, encrypted: encrypted ? 1 : 0 } });
  const dev = await one('SELECT * FROM balnet_push_devices WHERE id = ?', [sub.device_id]);
  if (dev?.web_endpoint) {
    const url = `${await webUrl()}/#${msg.url}`;
    // На телефон — с адресом сайта в заголовке, как Chrome подписывает уведомления сайтов.
    sendTracked('device', dev, { endpoint: dev.web_endpoint, p256dh: dev.web_p256dh, auth: dev.web_auth },
      { title: msg.title, body: `${new URL(sub.origin).host}${msg.body ? ` — ${msg.body}` : ''}`, url, app: 'browser', tag: msg.tag || `bln-${sub.id}` },
      { ttl, urgency, topic }).catch(() => {});
  }
  return id;
}
