// Перенос данных ВлодБраузера между устройствами (веб → iOS): файл JSON и короткий QR с закладками.
// Пароли сюда не попадают — они переносятся только синхронизацией, в зашифрованном виде.

export const EXPORT_FORMAT = 'vlodbrowser-export';
export const QR_PREFIX = 'VBX1:';
/** Сколько байт данных помещается в QR, который уверенно читает камера телефона. */
export const QR_MAX = 1800;

/** Файл экспорта: закладки, последние 500 записей истории, общие настройки. */
export function buildExport({ bookmarks = [], history = [], settings = {} }, now = Date.now()) {
  return {
    format: EXPORT_FORMAT,
    v: 1,
    created: now,
    bookmarks: bookmarks.map((b) => ({ url: b.url, title: b.title || '' })),
    history: history.slice(0, 500).map((h) => ({ url: h.url, title: h.title || '', ts: h.ts })),
    settings: { home: settings.home, neverSave: settings.neverSave || [] },
  };
}

/** QR с закладками: столько, сколько влезает. { text, count, total }. */
export function buildQr(bookmarks = []) {
  const items = [];
  let text = `${QR_PREFIX}${JSON.stringify({ b: items })}`;
  for (const b of bookmarks) {
    const next = [...items, [b.url, (b.title || '').slice(0, 60)]];
    const t = `${QR_PREFIX}${JSON.stringify({ b: next })}`;
    if (new TextEncoder().encode(t).length > QR_MAX) break;
    items.push(next[next.length - 1]);
    text = t;
  }
  return { text, count: items.length, total: bookmarks.length };
}

/** Разобрать файл или текст QR → { bookmarks, history, settings } или null. */
export function parseImport(text) {
  let s = String(text || '').trim();
  try {
    if (s.startsWith(QR_PREFIX)) {
      s = s.slice(QR_PREFIX.length);
      const d = JSON.parse(s);
      return { bookmarks: (d.b || []).filter((x) => Array.isArray(x) && /^https?:\/\//.test(x[0])).map(([url, title]) => ({ url, title: title || '' })), history: [], settings: {} };
    }
    const d = JSON.parse(s);
    if (d?.format !== EXPORT_FORMAT) return null;
    const ok = (x) => x && typeof x.url === 'string' && /^(https?|balnet):\/\//.test(x.url);
    return { bookmarks: (d.bookmarks || []).filter(ok), history: (d.history || []).filter(ok), settings: d.settings || {} };
  } catch {
    return null;
  }
}
