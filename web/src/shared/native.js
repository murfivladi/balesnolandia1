// Мост с нативным ВлодБраузером для iOS (window.__balnetNative): Face ID перед оплатой и PIN карты из Keychain.
// В обычном браузере моста нет — функции ничего не делают, сайт работает как раньше.

const bridge = () => (typeof window !== 'undefined' ? window.__balnetNative : null);

/** Подтвердить операцию Face ID. Без приложения — true; отказ → ошибка с понятным текстом. */
export async function nativeConfirm(reason) {
  const n = bridge();
  if (!n?.confirm) return true;
  const ok = await n.confirm(String(reason || 'Подтвердите операцию'));
  if (!ok) throw new Error('Операция не подтверждена (Face ID)');
  return true;
}

/** Есть ли в приложении сохранённый PIN этой карты (чтобы показать кнопку «PIN по Face ID»). */
export async function nativeHasPin(number) {
  const n = bridge();
  return n?.hasPin ? !!(await n.hasPin(String(number).replace(/\D/g, ''))) : false;
}

/** PIN карты из Keychain после Face ID или null. */
export async function nativePin(number) {
  const n = bridge();
  return n?.pin ? (await n.pin(String(number).replace(/\D/g, ''))) || null : null;
}

/** После успешной оплаты приложение предложит сохранить PIN для Face ID (само спрашивает пользователя). */
export function nativeOfferPin(number, pin) {
  const n = bridge();
  if (n?.offerPin) n.offerPin(String(number).replace(/\D/g, ''), String(pin));
}

export const hasNative = () => !!bridge();
