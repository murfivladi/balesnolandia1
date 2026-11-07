// Безопасный просмотр во ВлодБраузере (как Google Safe Browsing v4): локальный список 4-байтовых префиксов
// хешей от ВлодПоиска; при совпадении браузер спрашивает полные хеши по префиксу — сам адрес на сервер не уходит.
import { useState } from 'react';
import { get, post } from '../shared/api.js';
import { urlHashes, THREATS } from '@bln/shared/balnet-safe.js';

let listP = null;
let listAt = 0;
function prefixList() {
  if (!listP || Date.now() - listAt > 5 * 60000) {
    listAt = Date.now();
    listP = get('/search/sb/prefixes').then((r) => new Set(r.prefixes)).catch((e) => { listP = null; throw e; });
  }
  return listP;
}
export function refreshSafeList() { listP = null; }

const fullCache = new Map(); // префикс → { at, matches }

/** null — адрес безопасен (или список недоступен); { threat, expr } — опасен. */
export async function checkSafe(url) {
  let set;
  try { set = await prefixList(); } catch { return null; }
  if (!set.size) return null;
  const hashes = await urlHashes(url);
  const hit = hashes.filter((h) => set.has(h.prefix));
  if (!hit.length) return null;
  const want = [...new Set(hit.map((h) => h.prefix))].filter((p) => !(fullCache.get(p)?.at > Date.now() - 300000));
  if (want.length) {
    try {
      const r = await post('/search/sb/find', { prefixes: want });
      for (const p of want) fullCache.set(p, { at: Date.now(), matches: r.matches.filter((m) => m.hash.startsWith(p)) });
    } catch { return null; }
  }
  for (const h of hit) {
    const m = fullCache.get(h.prefix)?.matches.find((x) => x.hash === h.hash);
    if (m) return { threat: m.threat, expr: h.expr };
  }
  return null;
}

// «Всё равно перейти» — до закрытия браузера, как в Chrome.
const bypass = new Set();
export const isSafeBypassed = (host) => bypass.has(host);
export const addSafeBypass = (host) => bypass.add(host);

export function reportPhishing(url, comment = '') {
  return post('/search/sb/report', { url, threat: 'phishing', comment });
}

/** Красная страница «Обманный сайт». */
export function SafeBrowsingPage({ host, url, verdict, onBack, onProceed }) {
  const [adv, setAdv] = useState(false);
  const t = THREATS[verdict.threat] || THREATS.phishing;
  return (
    <div className="bp-page bp-error bp-unsafe">
      <div className="bp-error-icon" aria-hidden>⛔</div>
      <h1>{t.title}</h1>
      <p>{t.text}</p>
      <p>Сайт <b>{host}</b> в списке Безопасного просмотра ВлодПоиска.</p>
      <div className="bp-error-actions">
        <button className="bp-btn" onClick={() => setAdv((v) => !v)}>{adv ? 'Скрыть подробности' : 'Подробнее'}</button>
        <button className="bp-btn bp-btn-primary" onClick={onBack}>Вернуться к безопасной странице</button>
      </div>
      {adv && (
        <div className="bp-certerr-adv">
          <p>ВлодПоиск недавно обнаружил {verdict.threat === 'phishing' ? 'фишинг' : 'опасное содержимое'} на этом сайте (запись «{verdict.expr}»). Такие сайты выдают себя за другие — например, за ВлодБанк, — чтобы украсть пароли и данные карт.</p>
          <p>Владелец сайта может исправить проблему и запросить проверку в кабинете вебмастера ВлодПоиска.</p>
          <p><button className="bp-link bp-danger" onClick={onProceed}>Перейти на этот небезопасный сайт</button></p>
          <p className="bp-muted">Адрес: {url}</p>
        </div>
      )}
    </div>
  );
}
