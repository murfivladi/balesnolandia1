// Версии нативных приложений. Сервер сообщает их приложениям (GET /api/app/ios), и те показывают
// баннер «Доступна новая версия». Меняется вместе с версией в ios/VlodBrowser.swiftpm (Package.swift и Config.swift).

export const IOS_APP = { version: '0.1.0', build: 1 };

/** Новее ли версия a, чем b (числа через точку). */
export function isNewer(a, b) {
  const x = String(a).split('.').map((n) => Number(n) || 0);
  const y = String(b).split('.').map((n) => Number(n) || 0);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] || 0;
    const q = y[i] || 0;
    if (p !== q) return p > q;
  }
  return false;
}
