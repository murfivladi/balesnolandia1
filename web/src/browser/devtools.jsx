// Инструменты разработчика ВлодБраузера (этап Н2 — вкладка Network): каждый переход на сайт,
// путь DNS-запроса по серверам, ответ, задержки и сервер, который ответил.
import { useState } from 'react';
import { formatRR } from '@bln/shared/balnet-dns.js';
import { displayUrl } from '@bln/shared/balnet-url.js';

const KIND_LABEL = {
  referral: 'делегирование →', answer: 'ответ', nodata: 'нет записей такого типа', NXDOMAIN: 'домена нет', REFUSED: 'отказ', SERVFAIL: 'сбой',
};

function statusOf(e) {
  if (e.failed) return { text: e.failed === 'maintenance' ? '503' : '(failed)', bad: true };
  if (e.ok) return { text: String(e.status || 200), bad: false };
  if (e.status) return { text: String(e.status), bad: true };
  return { text: '(failed)', bad: true };
}

function Bar({ label, ms, max }) {
  const w = max > 0 ? Math.max(2, (ms / max) * 100) : 0;
  return (
    <div className="dt-bar">
      <span>{label}</span>
      <span className="dt-bar-track"><span className="dt-bar-fill" style={{ width: `${w}%` }} /></span>
      <span className="mono">{ms} мс</span>
    </div>
  );
}

function Details({ e }) {
  const dns = e.dns;
  const t = e.timing || {};
  const max = Math.max(t.dns || 0, t.connect || 0, 1);
  return (
    <div className="dt-details">
      <section>
        <h4>Общее</h4>
        <dl className="bp-dl">
          <dt>URL</dt><dd className="mono">{e.url}</dd>
          <dt>Статус</dt><dd>{e.failed || e.code || `${e.status || 200} OK`}</dd>
          {e.ip && <><dt>Удалённый адрес</dt><dd className="mono">{e.ip}{e.server ? ` (${String(e.server).replace(/\.$/, '')})` : ''}</dd></>}
          {e.client_ip && <><dt>Ваш адрес</dt><dd className="mono">{e.client_ip}</dd></>}
          {e.target && <><dt>Сайт на сервере</dt><dd className="mono">{e.target}{e.gov ? ' — госсайт' : ''}</dd></>}
          {e.message && <><dt>Ошибка</dt><dd>{e.message}</dd></>}
        </dl>
      </section>
      {(t.dns !== undefined || t.connect !== undefined) && (
        <section>
          <h4>Тайминг (сеть БалНета)</h4>
          <Bar label="DNS" ms={t.dns || 0} max={max} />
          <Bar label="Подключение" ms={t.connect || 0} max={max} />
          <p className="bp-muted">Реальное время запроса к серверу игры: {e.total} мс.</p>
        </section>
      )}
      {dns && (
        <section>
          <h4>DNS: {dns.qname} {dns.qtype} → {dns.rcode}{dns.cached ? ' (из кэша резолвера)' : ''}</h4>
          <p>Резолвер: <span className="mono">{dns.resolver?.name || ''} {dns.resolver?.ip}</span>, {dns.ms} мс</p>
          {dns.trace?.length > 0 && (
            <ol className="dt-trace">
              {dns.trace.map((s, i) => (
                <li key={i}>
                  <span className="mono">{s.server_name} ({s.server})</span>
                  {' '}— {s.timeout ? 'не ответил (тайм-аут)' : KIND_LABEL[s.kind] || s.kind}, {s.ms} мс
                  {s.kind === 'referral' && <span className="bp-muted"> {s.authority.map((r) => r.data).join(', ')}</span>}
                </li>
              ))}
            </ol>
          )}
          {!!dns.answer?.length && <pre className="dt-pre">{dns.answer.map(formatRR).join('\n')}</pre>}
          {!dns.answer?.length && !!dns.authority?.length && <pre className="dt-pre">{dns.authority.map(formatRR).join('\n')}</pre>}
        </section>
      )}
    </div>
  );
}

export function DevTools({ log, tab, onClear, onClose }) {
  const [sel, setSel] = useState(null);
  const current = log.find((e) => e.id === sel) || log[log.length - 1] || null;
  return (
    <section className="dt" aria-label="Инструменты разработчика">
      <header className="dt-head">
        <span className="dt-tab is-active">Network</span>
        <span className="bp-muted dt-hint">Elements, Console, Application и Sources появятся вместе с сайтами игроков</span>
        <span className="bb-grow" />
        <button className="bb-icon" onClick={onClear} title="Очистить" aria-label="Очистить журнал">⌀</button>
        <button className="bb-icon" onClick={onClose} title="Закрыть (F12)" aria-label="Закрыть инструменты">✕</button>
      </header>
      <div className="dt-body">
        <div className="dt-list" role="table" aria-label="Запросы">
          <div className="dt-row dt-row-head" role="row"><span>Имя</span><span>Статус</span><span>IP</span><span>DNS</span><span>Время</span></div>
          {!log.length && <p className="bp-muted dt-empty">Журнал пуст. Откройте сайт или нажмите ↻ во вкладке «{tab.title}».</p>}
          {log.map((e) => {
            const st = statusOf(e);
            return (
              <button key={e.id} role="row" className={`dt-row ${current?.id === e.id ? 'is-sel' : ''} ${st.bad ? 'is-bad' : ''}`} onClick={() => setSel(e.id)}>
                <span className="bp-ellipsis">{displayUrl(e.url) || e.host}</span>
                <span>{st.text}</span>
                <span className="mono">{e.ip || '—'}</span>
                <span>{e.dns ? (e.dns.cached ? 'кэш' : `${e.dns.trace?.length || 0} запр.`) : '—'}</span>
                <span className="mono">{e.timing ? `${Math.round((e.timing.dns || 0) + (e.timing.connect || 0))} мс` : '—'}</span>
              </button>
            );
          })}
        </div>
        {current && <Details e={current} />}
      </div>
    </section>
  );
}
