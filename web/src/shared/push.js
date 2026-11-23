// Настоящий Web Push этого браузера (этап Н10): service worker, разрешение, подписка с ключом VAPID сервера.
// Нужен защищённый контекст (https или localhost). На iPhone и iPad push работает только у приложения,
// добавленного на экран «Домой» (iOS 16.4+).
import { get } from './api.js';

export function pushSupport() {
  if (typeof window === 'undefined') return { ok: false, reason: 'нет окна' };
  if (!window.isSecureContext) return { ok: false, reason: 'Push работает только по https' };
  if (!('serviceWorker' in navigator) || !('PushManager' in window) || !('Notification' in window)) {
    const ios = /iPhone|iPad|iPod/.test(navigator.userAgent);
    return { ok: false, reason: ios ? 'На iPhone и iPad добавьте приложение на экран «Домой» (Поделиться → На экран «Домой») и включите push там' : 'Этот браузер не поддерживает push-уведомления' };
  }
  if (Notification.permission === 'denied') return { ok: false, denied: true, reason: 'Уведомления запрещены в настройках браузера для этого сайта' };
  return { ok: true };
}

/** Service worker приложения: уже зарегистрированный или новый (в разработке он не регистрируется сам). */
export async function swRegistration() {
  const scope = import.meta.env.BASE_URL;
  const have = await navigator.serviceWorker.getRegistration(scope);
  if (have) return have;
  await navigator.serviceWorker.register(`${scope}sw.js`, { scope });
  return navigator.serviceWorker.ready;
}

const b64ToBytes = (s) => {
  const b = atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4));
  return Uint8Array.from(b, (c) => c.charCodeAt(0));
};
const sameKey = (buf, b64) => {
  if (!buf) return false;
  const a = new Uint8Array(buf);
  const k = b64ToBytes(b64);
  return a.length === k.length && a.every((x, i) => x === k[i]);
};

/** Текущая подписка этого браузера (или null), если она сделана с ключом нашего сервера. */
export async function currentSubscription() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  try {
    const reg = await navigator.serviceWorker.getRegistration(import.meta.env.BASE_URL);
    const sub = await reg?.pushManager.getSubscription();
    if (!sub) return null;
    const { publicKey } = await get('/push/key');
    return sameKey(sub.options?.applicationServerKey, publicKey) ? sub : null;
  } catch {
    return null;
  }
}

/**
 * Запросить разрешение и подписаться. Возвращает PushSubscription (JSON для сервера — sub.toJSON()).
 * Подписка у браузера одна на сайт: её используют и ВлодБанк, и ВлодУслуги, и ВлодБраузер.
 * Поэтому «выключить» — значит удалить её на сервере у своего приложения, а не отменить в браузере.
 */
export async function subscribePush() {
  const s = pushSupport();
  if (!s.ok) throw new Error(s.reason);
  const perm = await Notification.requestPermission();
  if (perm !== 'granted') throw new Error(perm === 'denied' ? 'Уведомления запрещены — разрешите их в настройках браузера' : 'Разрешение не дано');
  const reg = await swRegistration();
  const { publicKey } = await get('/push/key');
  let sub = await reg.pushManager.getSubscription();
  if (sub && !sameKey(sub.options?.applicationServerKey, publicKey)) {
    await sub.unsubscribe();
    sub = null;
  }
  return sub || reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64ToBytes(publicKey) });
}
