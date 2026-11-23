// Клиент API. В разработке — относительный /api через прокси Vite,
// в продакшене — VITE_API_URL (например, https://api.balesnolandia.vladislavb.ru).
const BASE = (import.meta.env.VITE_API_URL || '').replace(/\/$/, '');

export class ApiError extends Error {
  constructor(status, code, message, data) {
    super(message || code);
    this.status = status;
    this.code = code;
    this.data = data;
  }
}

const listeners = new Set();
/** Подписка на 401 — приложения показывают экран входа. */
export function onUnauthorized(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

let offline = false;
const offlineListeners = new Set();
export function onOffline(fn) {
  offlineListeners.add(fn);
  return () => offlineListeners.delete(fn);
}
function setOffline(v) {
  if (offline === v) return;
  offline = v;
  offlineListeners.forEach((f) => f(v));
}

/** Если API не отвечает дольше этого — запрос прерывается и показывается «нет связи с сервером», а не бесконечный спиннер. */
const REQUEST_TIMEOUT_MS = 20000;

export function newIdemKey() {
  return (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/-/g, '');
}

/** Объединить несколько AbortSignal в одну. */
function combineSignals(signals) {
  const controller = new AbortController();
  const abort = () => controller.abort();
  for (const s of signals) {
    if (!s) continue;
    if (s.aborted) { abort(); break; }
    s.addEventListener('abort', abort, { once: true });
  }
  return controller.signal;
}

export async function api(path, { method = 'GET', body, idem, signal, timeout = REQUEST_TIMEOUT_MS } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idem) headers['Idempotency-Key'] = idem === true ? newIdemKey() : idem;
  let res;
  let timeoutId;
  try {
    const fetchSignal = combineSignals([
      signal,
      timeout && timeout > 0 ? (() => {
        const c = new AbortController();
        timeoutId = setTimeout(() => c.abort(), timeout);
        return c.signal;
      })() : null,
    ]);
    res = await fetch(`${BASE}/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'include',
      signal: fetchSignal,
    });
  } catch (err) {
    if (timeoutId) clearTimeout(timeoutId);
    if (err.name === 'AbortError') {
      setOffline(true);
      throw err;
    }
    setOffline(true);
    throw new ApiError(0, 'network', 'Нет связи с сервером');
  }
  if (timeoutId) clearTimeout(timeoutId);
  setOffline(false);
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { data = null; }
  if (!res.ok) {
    if (res.status === 401) listeners.forEach((f) => f(path));
    throw new ApiError(res.status, data?.error || 'error', data?.message || `Ошибка ${res.status}`, data?.data);
  }
  return data;
}

/** Адрес API (пусто — тот же сайт). Нужен для фреймов шлюза сайтов БалНета. */
export const apiBase = () => BASE;

export const get = (p, o) => api(p, o);
export const post = (p, body, o = {}) => api(p, { ...o, method: 'POST', body: body ?? {} });
export const patch = (p, body, o = {}) => api(p, { ...o, method: 'PATCH', body: body ?? {} });
export const put = (p, body, o = {}) => api(p, { ...o, method: 'PUT', body: body ?? {} });
export const del = (p, o = {}) => api(p, { ...o, method: 'DELETE' });

export function wsUrl() {
  const explicit = import.meta.env.VITE_WS_URL;
  if (explicit) return explicit;
  if (BASE) return BASE.replace(/^http/, 'ws') + '/ws';
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

/** Публичный адрес фронтенда для QR (ссылки на другие приложения). */
export function appUrl(app, hash = '') {
  const base = `${location.origin}${import.meta.env.BASE_URL}${app}/`;
  return hash ? `${base}#${hash.startsWith('/') ? hash : '/' + hash}` : base;
}
