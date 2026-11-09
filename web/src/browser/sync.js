// Аккаунт ВлодБраузера на ВлодПочте и синхронизация закладок, истории и паролей.
// Шифрование — в браузере: ключ AES-GCM 256 из кодовой фразы (PBKDF2-SHA256), сервер видит только шифротекст.
// Слияние без журнала правок: разница между текущим списком и снимком прошлой синхронизации даёт изменения
// и удаления (метки времени + «надгробия»), они накладываются на данные с сервера; конфликт версий — повтор.
import { post } from '../shared/api.js';

const ITERATIONS = 210000;
const TOMB_DAYS = 60;
const enc = new TextEncoder();
const dec = new TextDecoder();
const b64 = (u) => btoa(String.fromCharCode(...new Uint8Array(u)));
const unb64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
const CHECK = 'ВлодБраузер: кодовая фраза верна';

/** Ключ из кодовой фразы (неизвлекаемый — хранится в IndexedDB как CryptoKey). */
export async function deriveKey(phrase, salt, iterations = ITERATIONS) {
  const base = await crypto.subtle.importKey('raw', enc.encode(String(phrase).normalize('NFC')), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey({ name: 'PBKDF2', hash: 'SHA-256', salt: unb64(salt), iterations }, base, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
}

export async function encrypt(key, value) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const data = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, enc.encode(JSON.stringify(value)));
  return `${b64(iv)}.${b64(data)}`;
}

export async function decrypt(key, blob) {
  const [iv, data] = String(blob).split('.');
  const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: unb64(iv) }, key, unb64(data));
  return JSON.parse(dec.decode(plain));
}

/** Новая кодовая фраза: соль и проверочный блок уходят на сервер. */
export async function createPhrase(phrase) {
  const salt = b64(crypto.getRandomValues(new Uint8Array(16)));
  const key = await deriveKey(phrase, salt);
  return { key, salt, iterations: ITERATIONS, check: await encrypt(key, CHECK) };
}

/** Проверить фразу по блоку с сервера. null — фраза неверна. */
export async function unlock(phrase, info) {
  const key = await deriveKey(phrase, info.salt, info.iterations);
  try {
    return (await decrypt(key, info.check)) === CHECK ? key : null;
  } catch {
    return null;
  }
}

// ——— Коллекции ———

/** Ключ элемента и его «содержимое» для сравнения. */
export const COLLECTIONS = {
  bookmarks: { id: (x) => x.url, limit: 2000 },
  history: { id: (x) => `${x.ts}|${x.url}`, limit: 1000 },
  passwords: { id: (x) => `${x.origin}|${x.username}`, limit: 1000 },
  // Открытые вкладки каждого устройства: своё устройство пишет только свои, чужие видны в «Вкладки с других устройств».
  tabs: { id: (x) => `${x.device}|${x.url}`, limit: 500 },
  // Общие настройки браузера (веб и iOS): { k, v }.
  settings: { id: (x) => x.k, limit: 50 },
};

/** Вкладки других устройств, которые не обновлялись дольше этого, не показываются. */
export const TABS_STALE_DAYS = 30;

/** Чужие вкладки для показа: свежие, по устройствам. */
export function remoteTabsByDevice(list, ownDevice, now = Date.now()) {
  const out = new Map();
  for (const t of list || []) {
    if (t.device === ownDevice || now - (t.ts || 0) > TABS_STALE_DAYS * 86400000) continue;
    if (!out.has(t.device)) out.set(t.device, { device: t.device, name: t.deviceName || 'Устройство', ts: 0, tabs: [] });
    const d = out.get(t.device);
    d.tabs.push(t);
    d.ts = Math.max(d.ts, t.ts || 0);
  }
  return [...out.values()].sort((a, b) => b.ts - a.ts);
}
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Слить локальный список с серверным документом.
 * doc = { items: { id: { v, mt, pos } }, tomb: { id: mt } }, base — снимок прошлой синхронизации (список).
 * Возвращает { doc, list } — новый документ и список для браузера.
 */
export function merge(name, local, base, doc, now = Date.now()) {
  const c = COLLECTIONS[name];
  const items = { ...(doc?.items || {}) };
  const tomb = { ...(doc?.tomb || {}) };
  const baseMap = new Map((base || []).map((x) => [c.id(x), x]));
  const localMap = new Map(local.map((x, i) => [c.id(x), { x, i }]));
  for (const [id, { x, i }] of localMap) {
    const old = baseMap.get(id);
    // Изменено здесь после прошлой синхронизации — наша версия новее. Не менялось — остаётся то, что на сервере
    // (если другое устройство удалило элемент, его нет в items, и он пропадёт и здесь).
    if (!old || !same(old, x)) { items[id] = { v: x, mt: now, pos: i }; delete tomb[id]; }
  }
  for (const id of baseMap.keys()) {
    if (!localMap.has(id)) { delete items[id]; tomb[id] = now; }
  }
  for (const [id, t] of Object.entries(tomb)) if (now - t > TOMB_DAYS * 86400000) delete tomb[id];
  let list = Object.values(items);
  if (name === 'bookmarks') list.sort((a, b) => a.pos - b.pos);
  else if (name === 'history') list.sort((a, b) => b.v.ts - a.v.ts);
  else if (name === 'tabs') list.sort((a, b) => (b.v.ts || 0) - (a.v.ts || 0));
  list = list.slice(0, c.limit);
  const kept = new Set(list.map((e) => c.id(e.v)));
  for (const id of Object.keys(items)) if (!kept.has(id)) delete items[id];
  return { doc: { items, tomb }, list: list.map((e) => e.v) };
}

/**
 * Синхронизировать коллекции. acc — { token }, key — CryptoKey, get/set — локальные данные профиля:
 * get(name) → список, set(name, список), base(name) / setBase(name, список) — снимки, revs.
 */
export async function syncAll({ token, key, read, write, readBase, writeBase }) {
  const pulled = (await post('/mail/sync/pull', { token })).collections;
  const out = {};
  for (const name of Object.keys(COLLECTIONS)) {
    let remote = pulled[name] || null;
    for (let attempt = 0; attempt < 4; attempt++) {
      const doc = remote ? await decrypt(key, remote.blob) : null;
      const local = await read(name);
      const base = await readBase(name);
      const m = merge(name, local, base, doc);
      try {
        const changed = !doc || !same(doc, m.doc);
        const rev = changed ? (await post('/mail/sync/push', { token, collection: name, base_rev: remote?.rev || 0, blob: await encrypt(key, m.doc) })).rev : remote.rev;
        await write(name, m.list);
        await writeBase(name, m.list);
        out[name] = { count: m.list.length, rev };
        break;
      } catch (e) {
        if (e.status !== 409 || attempt === 3) throw e;
        remote = (await post('/mail/sync/pull', { token })).collections[name] || null;
      }
    }
  }
  return out;
}
