// Сетевой стек ВлодБраузера: подключение к провайдеру (аренда IP), открытие сайтов через DNS, запросы терминала.
import { get, post, ApiError } from '../shared/api.js';

export const DEFAULT_NET = { provider: 'baltelecom', dnsMode: 'provider', dns: '' };
export const PUBLIC_DNS = '50.0.0.53';

/** Новый идентификатор устройства для профиля браузера. */
export function newClientId() {
  const r = crypto.randomUUID?.() || `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`;
  return `dev-${r.replace(/-/g, '').slice(0, 24)}`;
}

/** DNS-сервер из настроек: null — резолвер провайдера. */
export function resolverOf(net) {
  if (net.dnsMode === 'public') return PUBLIC_DNS;
  if (net.dnsMode === 'custom' && net.dns) return net.dns;
  return null;
}

const leases = new Map(); // `${client}|${provider}` → Promise<lease>

export function lease(clientId, provider, { fresh = false } = {}) {
  const key = `${clientId}|${provider}`;
  if (fresh) leases.delete(key);
  if (!leases.has(key)) {
    const p = post('/net/lease', { client_id: clientId, provider }).catch((e) => { leases.delete(key); throw e; });
    leases.set(key, p);
  }
  return leases.get(key);
}

let providersPromise = null;
export function providers() {
  if (!providersPromise) providersPromise = get('/net/providers').catch((e) => { providersPromise = null; throw e; });
  return providersPromise;
}

/**
 * Запрос к сетевому API от имени устройства. Если сервер забыл аренду (сброс игры) — подключаемся заново.
 * Ошибки приводятся к виду { failed: code }: maintenance, ERR_BALNET_UNREACHABLE, или текст ошибки.
 */
export async function netCall(path, body, net) {
  const attempt = async (fresh) => {
    const l = await lease(net.clientId, net.provider, { fresh });
    return { lease: l, data: await post(path, { client_id: net.clientId, resolver: resolverOf(net) || undefined, ...body }) };
  };
  try {
    try {
      return await attempt(false);
    } catch (e) {
      if (e instanceof ApiError && (e.code === 'no_lease' || e.code === 'not_found')) return await attempt(true);
      throw e;
    }
  } catch (e) {
    if (e instanceof ApiError && e.code === 'balnet_maintenance') return { failed: 'maintenance' };
    if (e instanceof ApiError && e.status === 0) return { failed: 'ERR_BALNET_UNREACHABLE' };
    if (e?.name === 'AbortError') return { failed: 'ERR_BALNET_UNREACHABLE' };
    return { failed: 'error', message: e.message || String(e) };
  }
}

/** Открыть адрес. jar — cookies и localStorage сайта из профиля (для сайтов игроков). */
export const openUrl = (url, net, jar, referrer) => netCall('/net/open', { url, jar, referrer: referrer || undefined }, net);
