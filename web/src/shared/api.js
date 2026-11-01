// Клиент API. В разработке — относительный /api через прокси Vite,
// в продакшене — VITE_API_URL (например, https://api.vladinc.ru).
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

export function newIdemKey() {
  return (crypto.randomUUID?.() || `${Date.now()}-${Math.random()}`).replace(/-/g, '');
}

export async function api(path, { method = 'GET', body, idem, signal } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (idem) headers['Idempotency-Key'] = idem === true ? newIdemKey() : idem;
  let res;
  try {
    res = await fetch(`${BASE}/api${path}`, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      credentials: 'include',
      signal,
    });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    setOffline(true);
    throw new ApiError(0, 'network', 'Нет связи с сервером');
  }
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

export const get = (p, o) => api(p, o);
export const post = (p, body, o = {}) => api(p, { ...o, method: 'POST', body: body ?? {} });
export const patch = (p, body, o = {}) => api(p, { ...o, method: 'PATCH', body: body ?? {} });

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
