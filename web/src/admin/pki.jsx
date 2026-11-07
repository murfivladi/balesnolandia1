// Админка БалНета → Сертификаты: хранилище доверия ВлодБраузера (корни), отзыв УЦ, поиск и отзыв сертификатов, журнал CT.
import { useState } from 'react';
import { get, post, patch } from '../shared/api.js';
import { Spinner, useAsync, Badge, ActionButton, ErrorBox } from '../shared/ui.jsx';

const day = (s) => `д. ${Math.floor((Number(s) % 2592000) / 86400) + 1}, м. ${Math.floor(Number(s) / 2592000)}`;

export function PkiAdmin() {
  const cas = useAsync(() => get('/admin/pki/cas'), []);
  const [q, setQ] = useState('');
  const certs = useAsync(() => get(`/admin/pki/certs?q=${encodeURIComponent(q)}`), [q]);
  if (!cas.data) return cas.error ? <ErrorBox error={cas.error} /> : <Spinner />;
  return (
    <div className="stack">
      <div className="card">
        <h2>Центры сертификации</h2>
        <p className="small muted">Корень «в браузерах» попадает в хранилище доверия ВлодБраузера: всем его сертификатам доверяют. Отзыв центра блокирует все его сертификаты (как CRLSet в Chrome).</p>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Центр</th><th>Вид</th><th>Организация</th><th>CAA</th><th>Выпущено</th><th>Статус</th><th /></tr></thead>
            <tbody>
              {cas.data.cas.map((c) => (
                <tr key={c.id}>
                  <td><b>{c.name}</b> <span className="mono small muted">{c.ski}</span></td>
                  <td>{c.kind === 'root' ? 'корень' : 'выпускающий'}</td>
                  <td>{c.org_name || 'Координационный центр'}</td>
                  <td className="mono small">{c.identifier || '—'}</td>
                  <td>{c.issued}</td>
                  <td>
                    {c.status === 'revoked' ? <Badge kind="err">отозван</Badge> : c.kind === 'root' ? (c.trusted ? <Badge kind="ok">в браузерах</Badge> : <Badge kind="warn">не в браузерах</Badge>) : <Badge kind="ok">действует</Badge>}
                  </td>
                  <td className="row nowrap">
                    {c.kind === 'root' && c.status === 'active' && (
                      <ActionButton size="sm" kind="ghost" confirm={c.trusted ? 'Убрать корень из браузеров? Все его сайты получат ERR_CERT_AUTHORITY_INVALID.' : 'Включить корень в хранилище доверия всех браузеров?'} action={async () => { await patch(`/admin/pki/cas/${c.id}`, { trusted: !c.trusted }); cas.reload(); }}>
                        {c.trusted ? 'Убрать из браузеров' : 'Включить в браузеры'}
                      </ActionButton>
                    )}
                    {c.status === 'active' && c.org_id && <ActionButton size="sm" kind="danger" confirm="Отозвать центр сертификации навсегда?" action={async () => { await post(`/admin/pki/cas/${c.id}/revoke`); cas.reload(); }}>Отозвать</ActionButton>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="small muted">Журналы прозрачности: {cas.data.logs.map((l) => `${l.name} — ${l.entries} записей`).join('; ')}</p>
      </div>
      <div className="card">
        <h2>Сертификаты</h2>
        <input className="input mono" placeholder="поиск по имени: boris.bln" value={q} onChange={(e) => setQ(e.target.value)} />
        {!certs.data ? <Spinner /> : (
          <div className="table-wrap" style={{ marginTop: 8 }}>
            <table className="table">
              <thead><tr><th>Имена</th><th>Вид</th><th>Издатель</th><th>До</th><th>Статус</th><th /></tr></thead>
              <tbody>
                {certs.data.certs.map((c) => (
                  <tr key={c.id}>
                    <td className="mono small">{c.names.join(', ')}</td>
                    <td>{c.policy}</td>
                    <td>{c.issuer}</td>
                    <td className="small">{day(c.na)}</td>
                    <td>{c.status === 'valid' ? <Badge kind="ok">действует</Badge> : c.status === 'revoked' ? <Badge kind="err">отозван</Badge> : <Badge kind="warn">истёк</Badge>}</td>
                    <td>{c.status === 'valid' && c.policy !== 'self' && <ActionButton size="sm" kind="ghost" confirm="Отозвать сертификат?" action={async () => { await post(`/admin/pki/certs/${c.id}/revoke`, { reason: 'unspecified' }); certs.reload(); }}>Отозвать</ActionButton>}</td>
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
