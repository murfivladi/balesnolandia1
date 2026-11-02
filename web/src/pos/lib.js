// Общие расчёты кассы: количество в тысячных, подписи, суммы строк.
import { t } from '../shared/i18n.js';

export const QTY = 1000;

/** 1500, 'pcs' → «1,5 шт»? Штучные — только целые; весовые — три знака. */
export function qtyLabel(unit, q) {
  if (unit === 'kg') return `${(Number(q) / 1000).toFixed(3).replace('.', ',')} ${t('кг')}`;
  return `${Number(q) / 1000} ${t('шт')}`;
}

/** Сумма строки: цена в влодинках × количество в тысячных. */
export const lineSum = (price, qty) => Math.round((Number(price) * Number(qty)) / QTY);

/** Подпись способа оплаты. */
export function methodLabel(method) {
  return t({ cash: 'Наличные', card: 'Карта', qr: 'QR-оплата', debt: 'В долг' }[method] || method);
}

/** Строка чека: одинаковый товар с одинаковыми вариантом и добавками складывается. */
export function lineKey(productId, variantId, modifierIds) {
  const mods = [...(modifierIds || [])].map(Number).sort((a, b) => a - b).join(',');
  return `${productId}:${variantId || ''}:${mods}`;
}

/** Цена строки с учётом варианта и добавок. */
export function linePrice(product, variant, modifiers) {
  let price = Number(product.price);
  if (variant) price += Number(variant.price_delta || 0);
  for (const m of modifiers || []) price += Number(m.price || 0);
  return price;
}

/** Полное имя строки: товар (вариант) + добавки. */
export function lineName(product, variant, modifiers) {
  let name = variant ? `${product.name} (${variant.name})` : product.name;
  if (modifiers?.length) name += ` + ${modifiers.map((m) => m.name).join(', ')}`;
  return name;
}

/** Разбор введённого веса: «1234» — граммы, «1,234» или «1.234» — килограммы. */
export function parseWeight(text) {
  const s = String(text ?? '').trim().replace(',', '.');
  if (!s) return 0;
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.round(s.includes('.') ? n * 1000 : n);
}
