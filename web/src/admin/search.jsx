// Админка БалНета → ВлодПоиск: робот и индекс, удаление из выдачи, Безопасный просмотр (список, подозрения робота,
// жалобы, запросы проверки), модерация объявлений, выручка рекламы.
import { useState } from 'react';
import { get, post, patch } from '../shared/api.js';
import { Spinner, useAsync, Badge, ActionButton, ErrorBox, Money, Button } from '../shared/ui.jsx';

const ST = { indexed: 'ok', queued: '', excluded: 'warn', error: 'err', redirect: '', gone: 'err' };
const SAFE = { suspected: ['warn', 'подозрение'], confirmed: ['err', 'в списке'], cleared: ['', 'снят'] };

export function SearchAdmin() {
  const ov = useAsync(() => get('/admin/search/overview'), []);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState('');
  const pages = useAsync(() => get(`/admin/search/pages?q=${encodeURIComponent(q)}&status=${status}`), [q, status]);
  const safe = useAsync(() => get('/admin/search/safe'), []);
  const camps = useAsync(() => get('/admin/search/campaigns'), []);
  const [expr, setExpr] = useState('');
  if (!ov.data) return ov.error ? <ErrorBox error={ov.error} /> : <Spinner />;
  const o = ov.data;
  const reloadAll = () => { ov.reload(); pages.reload(); safe.reload(); };
  return (
    <div className="stack">
      <div className="card stack-sm">
        <h2>Робот и индекс</h2>
        <p>В индексе <b>{o.stats.docs}</b> страниц с <b>{o.stats.hosts}</b> сайтов, {o.stats.terms} слов. В очереди: {o.queued}. Статусы: {Object.entries(o.stats.by_status).map(([k, v]) => `${k} ${v}`).join(', ')}.</p>
        <p className="small muted">Последний такт: {o.crawler.last.at ? `${new Date(o.crawler.last.at).toLocaleTimeString('ru-RU')}, страниц ${o.crawler.last.done} (${Object.entries(o.crawler.last.results || {}).map(([k, v]) => `${k}: ${v}`).join(', ')})` : 'ещё не было'}. Робот работает сам каждые 4 секунды, пока идёт игровое время.</p>
        <div className="row">
          <ActionButton action={async () => { await post('/admin/search/crawl', { rounds: 1 }); reloadAll(); }}>Такт робота</ActionButton>
          <ActionButton kind="secondary" action={async () => { await post('/admin/search/crawl', { rounds: 20 }); reloadAll(); }}>Обойти всю очередь</ActionButton>
          <ActionButton kind="ghost" action={async () => { await post('/admin/search/pagerank'); reloadAll(); }}>Пересчитать PageRank</ActionButton>
        </div>
        <p className="small">Реклама: выручка в госбюджет <Money value={o.revenue} />, выплачено сайтам сети <Money value={o.payouts} />.</p>
        {!!o.top_queries.length && <p className="small muted">Частые запросы: {o.top_queries.map((x) => `${x.q} (${x.n})`).join(', ')}</p>}
      </div>

      <div className="card stack-sm">
        <h2>Страницы</h2>
        <div className="row">
          <input className="input mono" style={{ flex: 1, minWidth: 180 }} placeholder="адрес содержит…" value={q} onChange={(e) => setQ(e.target.value)} />
          <select className="input" value={status} onChange={(e) => setStatus(e.target.value)} aria-label="Статус">
            <option value="">все</option>{Object.keys(ST).map((k) => <option key={k} value={k}>{k}</option>)}
          </select>
        </div>
        {!pages.data ? <Spinner /> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Адрес</th><th>Статус</th><th>Причина</th><th>PR</th><th>Ссылок</th><th /></tr></thead>
              <tbody>
                {pages.data.pages.map((p) => (
                  <tr key={p.id}>
                    <td className="mono small" style={{ overflowWrap: 'anywhere' }}>{p.url}{p.title ? <div className="muted">{p.title}</div> : null}</td>
                    <td><Badge kind={ST[p.status]}>{p.kind === 'gov' ? 'госсайт' : p.status}</Badge></td>
                    <td className="small">{p.reason || (p.http_status ? `HTTP ${p.http_status}` : '')}</td>
                    <td>{p.pagerank}</td><td>{p.inlinks}</td>
                    <td className="row nowrap">
                      {p.kind !== 'gov' && p.status !== 'excluded' && <ActionButton size="sm" kind="danger" confirm="Удалить страницу из выдачи?" action={async () => { const reason = window.prompt('Основание (решение суда, жалоба…)', 'решение администрации'); if (reason !== null) { await post(`/admin/search/pages/${p.id}/remove`, { reason }); pages.reload(); } }}>Удалить из поиска</ActionButton>}
                      {p.kind !== 'gov' && p.status === 'excluded' && <ActionButton size="sm" kind="ghost" action={async () => { await post(`/admin/search/pages/${p.id}/restore`); pages.reload(); }}>Вернуть в очередь</ActionButton>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card stack-sm">
        <h2>Безопасный просмотр</h2>
        <p className="small muted">Подтверждённые записи попадают во ВлодБраузер (префиксы хешей SHA-256): красная страница «Обманный сайт», удаление из выдачи и рекламы. Робот сам отмечает подозрительные страницы — форму пароля на сайте, который выдаёт себя за госсайт.</p>
        <form className="row" onSubmit={async (e) => { e.preventDefault(); await post('/admin/search/safe', { expr, threat: 'phishing' }); setExpr(''); safe.reload(); }}>
          <input className="input mono" style={{ flex: 1, minWidth: 180 }} placeholder="evil.bln/ или evil.bln/login/" value={expr} onChange={(e) => setExpr(e.target.value)} />
          <Button type="submit" kind="danger">Добавить как фишинг</Button>
        </form>
        {!safe.data ? <Spinner /> : (
          <>
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Выражение</th><th>Угроза</th><th>Источник</th><th>Статус</th><th>Заметка</th><th /></tr></thead>
                <tbody>
                  {safe.data.list.map((x) => (
                    <tr key={x.id}>
                      <td className="mono">{x.expr}</td><td>{x.threat}</td><td>{{ admin: 'админ', auto: 'робот', report: 'жалоба' }[x.source]}</td>
                      <td><Badge kind={SAFE[x.status][0]}>{SAFE[x.status][1]}</Badge></td>
                      <td className="small">{x.note}</td>
                      <td className="row nowrap">
                        {x.status !== 'confirmed' && <ActionButton size="sm" kind="danger" action={async () => { await patch(`/admin/search/safe/${x.id}`, { status: 'confirmed' }); safe.reload(); }}>Подтвердить</ActionButton>}
                        {x.status !== 'cleared' && <ActionButton size="sm" kind="ghost" action={async () => { await patch(`/admin/search/safe/${x.id}`, { status: 'cleared' }); safe.reload(); }}>Снять</ActionButton>}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!!safe.data.reviews.length && <p className="form-warn">Запросили проверку после исправления: {safe.data.reviews.map((r) => r.host).join(', ')}</p>}
            <h3>Жалобы посетителей</h3>
            {!safe.data.reports.length ? <p className="muted small">Жалоб нет.</p> : (
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Адрес</th><th>Комментарий</th><th>Статус</th><th /></tr></thead>
                  <tbody>
                    {safe.data.reports.map((r) => (
                      <tr key={r.id}>
                        <td className="mono small">{r.url}</td><td className="small">{r.comment}</td><td>{r.status}</td>
                        <td className="row nowrap">{r.status === 'new' && (
                          <>
                            <ActionButton size="sm" kind="danger" action={async () => { await patch(`/admin/search/reports/${r.id}`, { status: 'accepted' }); safe.reload(); }}>В список</ActionButton>
                            <ActionButton size="sm" kind="ghost" action={async () => { await patch(`/admin/search/reports/${r.id}`, { status: 'rejected' }); safe.reload(); }}>Отклонить</ActionButton>
                          </>
                        )}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        )}
      </div>

      <div className="card stack-sm">
        <h2>Объявления</h2>
        {!camps.data ? <Spinner /> : !camps.data.campaigns.length ? <p className="muted">Объявлений нет.</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Объявление</th><th>Слова</th><th>Ставка</th><th>Клики</th><th>Статус</th><th /></tr></thead>
              <tbody>
                {camps.data.campaigns.map((c) => (
                  <tr key={c.id}>
                    <td><b>{c.title}</b><div className="small">{c.text}</div><div className="mono small muted">{c.url}</div></td>
                    <td className="small">{c.keywords.join(', ')}</td>
                    <td><Money value={c.bid} /></td><td>{c.clicks}</td>
                    <td><Badge kind={c.status === 'rejected' ? 'err' : c.status === 'active' ? 'ok' : ''}>{c.status_text}</Badge>{c.reject_reason ? <div className="small">{c.reject_reason}</div> : null}</td>
                    <td>{c.status === 'rejected'
                      ? <ActionButton size="sm" kind="ghost" action={async () => { await patch(`/admin/search/campaigns/${c.id}`, { status: 'active' }); camps.reload(); }}>Одобрить</ActionButton>
                      : <ActionButton size="sm" kind="danger" action={async () => { const reason = window.prompt('Причина отклонения', 'Нарушает правила рекламы'); if (reason !== null) { await patch(`/admin/search/campaigns/${c.id}`, { status: 'rejected', reason }); camps.reload(); } }}>Отклонить</ActionButton>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
