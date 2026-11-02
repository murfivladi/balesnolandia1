// Этап 8: новости БФ — указы, законы, итоги выборов. Страница открыта без входа.
import { useState } from 'react';
import { get } from '../shared/api.js';
import { t, fmtDate } from '../shared/i18n.js';
import { Spinner, Empty, useAsync, Badge, ErrorBox, Tabs } from '../shared/ui.jsx';

export const NEWS_KINDS = { news: 'Новость', decree: 'Указ', law: 'Закон', election: 'Выборы' };
const KIND_BADGE = { news: '', decree: 'warn', law: 'brand', election: 'ok' };

export function NewsPage() {
  const { data, loading, error } = useAsync(() => get('/gov/news?limit=100'), []);
  const [kind, setKind] = useState('');
  if (loading && !data) return <div className="page medium"><Spinner /></div>;
  if (error) return <div className="page medium"><ErrorBox error={error} /></div>;
  const list = data.news.filter((n) => !kind || n.kind === kind);
  return (
    <div className="page medium">
      <h1>{t('Новости БФ')}</h1>
      <Tabs value={kind} onChange={setKind} tabs={[{ value: '', label: t('Все') }, ...Object.entries(NEWS_KINDS).map(([value, label]) => ({ value, label: t(label) }))]} />
      {!list.length ? <Empty>{t('Новостей пока нет')}</Empty> : (
        <div className="stack">
          {list.map((n) => (
            <div key={n.id} className="card">
              <div className="card-head">
                <div>
                  <h2 style={{ margin: 0 }}>{n.title}</h2>
                  <div className="small muted">{fmtDate(n.created_at)}</div>
                </div>
                <div className="row">
                  {n.pinned && <Badge kind="brand">{t('закреплено')}</Badge>}
                  <Badge kind={KIND_BADGE[n.kind]}>{t(NEWS_KINDS[n.kind] || n.kind)}</Badge>
                </div>
              </div>
              <p className="small" style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{n.body}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
