// Хранилище ВлодБраузера: IndexedDB (ключ → значение), у каждого профиля свои ключи.
// Если IndexedDB недоступна (приватный режим, запрет сайта), данные живут в памяти до закрытия вкладки.
// Инкогнито всегда пишет только в память.

const DB_NAME = 'bln-browser';
const STORE = 'kv';

let dbPromise = null;
const memory = new Map();

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve) => {
    try {
      if (!('indexedDB' in window)) { resolve(null); return; }
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbPromise;
}

function tx(db, mode, fn) {
  return new Promise((resolve) => {
    try {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req?.result);
      t.onerror = () => resolve(undefined);
      t.onabort = () => resolve(undefined);
    } catch { resolve(undefined); }
  });
}

export async function getItem(key, fallback) {
  if (memory.has(key)) return memory.get(key);
  const db = await openDb();
  if (!db) return fallback;
  const v = await tx(db, 'readonly', (s) => s.get(key));
  return v === undefined ? fallback : v;
}

export async function setItem(key, value) {
  memory.set(key, value);
  const db = await openDb();
  if (!db) return;
  await tx(db, 'readwrite', (s) => s.put(value, key));
}

export async function removeItem(key) {
  memory.delete(key);
  const db = await openDb();
  if (!db) return;
  await tx(db, 'readwrite', (s) => s.delete(key));
}

/**
 * Хранилище одного профиля. Для инкогнито — только память, без следов в IndexedDB.
 * Ключи: <профиль>:history, :bookmarks, :settings, :session.
 */
export function profileStore(profileId, incognito) {
  if (incognito) {
    const mem = new Map();
    return {
      get: async (k, fb) => (mem.has(k) ? mem.get(k) : fb),
      set: async (k, v) => { mem.set(k, v); },
      remove: async (k) => { mem.delete(k); },
    };
  }
  const p = (k) => `${profileId}:${k}`;
  return {
    get: (k, fb) => getItem(p(k), fb),
    set: (k, v) => setItem(p(k), v),
    remove: (k) => removeItem(p(k)),
  };
}

export const PROFILE_COLORS = ['#1f4fbf', '#0f766e', '#b8901f', '#7c3aed', '#c2410c', '#be185d', '#475569'];

export async function loadProfiles() {
  const list = await getItem('profiles', null);
  if (Array.isArray(list) && list.length) return list;
  const first = [{ id: 'p1', name: 'Профиль 1', color: PROFILE_COLORS[0] }];
  await setItem('profiles', first);
  return first;
}

export const saveProfiles = (list) => setItem('profiles', list);
export const loadActiveProfile = () => getItem('activeProfile', 'p1');
export const saveActiveProfile = (id) => setItem('activeProfile', id);

export const HISTORY_LIMIT = 2000;
