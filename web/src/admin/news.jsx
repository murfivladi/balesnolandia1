// Админка БалНета → Новости: госновости от Правительства, закрепление, удаление, блокировка СМИ, сводка экономики.
import { useState } from 'react';
import { get, post, del } from '../shared/api.js';
import { Spinner, useAsync, Badge, ActionButton, ErrorBox, Button, Input, Select, Field, useToast } from '../shared/ui.jsx';

export function NewsAdmin() {
  const r = useAsync(() => get('/admin/news'), []);
  const toast = useToast();
  const [f, setF] = useState({ title: '', summary: '', body: '', category: 'politics', pinned: false });
  if (!r.data) return r.error ? <ErrorBox error={r.error} /> : <Spinner />;
  const d = r.data;
  return (
    <div className="stack">
      <form className="card stack" onSubmit={async (e) => {
        e.preventDefault();
        try { await post('/admin/news/articles', f); toast('Госновость опубликована'); setF({ ...f, title: '', summary: '', body: '' }); r.reload(); } catch (err) { toast(err.message, 'err'); }
      }}>
        <h2>Госновость на novosti.bln</h2>
        <Input label="Заголовок" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />
        <Select label="Рубрика" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })} options={Object.entries(d.categories).map(([value, label]) => ({ value, label }))} />
        <Input label="Анонс" value={f.summary} onChange={(e) => setF({ ...f, summary: e.target.value })} />
        <Field label="Текст"><textarea className="input" rows={6} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} required /></Field>
        <label className="row small"><input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} /> Закрепить наверху ленты</label>
        <div className="row"><Button>Опубликовать</Button>
          <ActionButton kind="ghost" okMessage="Сводка готова" action={async () => { await post('/admin/news/digest'); r.reload(); }}>Сводка экономики за текущий месяц</ActionButton></div>
      </form>
      <div className="card stack-sm">
        <h2>Редакции</h2>
        <div className="table-wrap"><table className="table"><tbody>
          {d.outlets.map((o) => (
            <tr key={o.slug}>
              <td><b>{o.title}</b> <span className="small muted">/{o.slug}</span></td>
              <td>{o.kind}</td><td>{o.articles}</td>
              <td className="small mono">{o.rss_url || ''}{o.last_error ? ` ⚠ ${o.last_error}` : ''}</td>
              <td>{o.kind === 'media' && <ActionButton size="sm" kind="ghost" action={async () => { await post(`/admin/news/outlets/${o.slug}/status`, { status: o.status === 'active' ? 'blocked' : 'active' }); r.reload(); }}>{o.status === 'active' ? 'Заблокировать' : 'Разблокировать'}</ActionButton>}</td>
            </tr>
          ))}
        </tbody></table></div>
      </div>
      <div className="card stack-sm">
        <h2>Последние статьи</h2>
        {d.articles.map((a) => (
          <div key={a.id} className="row">
            <span style={{ flex: 1 }}>{a.pinned && <Badge kind="err">закреплено</Badge>} {a.title} <span className="small muted">— {a.outlet.title}</span></span>
            <ActionButton size="sm" kind="ghost" action={async () => { await post(`/admin/news/articles/${a.id}/pin`, { pinned: !a.pinned }); r.reload(); }}>{a.pinned ? 'Открепить' : 'Закрепить'}</ActionButton>
            <ActionButton size="sm" kind="ghost" confirm="Удалить статью?" action={async () => { await del(`/admin/news/articles/${a.id}`); r.reload(); }}>Удалить</ActionButton>
          </div>
        ))}
      </div>
    </div>
  );
}
