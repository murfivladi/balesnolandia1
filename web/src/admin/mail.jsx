// Админка БалНета → ВлодПочта: статистика, журнал почтовых серверов (без текста писем), ящики и блокировки,
// домены, жалобы. Текст письма админ видит только по жалобе — каждое открытие пишется в журнал аудита.
import { useState } from 'react';
import { get, post } from '../shared/api.js';
import { Spinner, useAsync, Badge, ActionButton, ErrorBox } from '../shared/ui.jsx';

const ST = { delivered: 'ok', spam: 'warn', rejected: 'err', bounced: 'err', script: '' };
const AK = { pass: 'ok', fail: 'err', softfail: 'warn', permerror: 'err' };

export function MailAdmin() {
  const st = useAsync(() => get('/admin/mail/stats'), []);
  const [q, setQ] = useState('');
  const log = useAsync(() => get(`/admin/mail/log?q=${encodeURIComponent(q)}`), [q]);
  const acc = useAsync(() => get('/admin/mail/accounts'), []);
  const doms = useAsync(() => get('/admin/mail/domains'), []);
  const reps = useAsync(() => get('/admin/mail/reports'), []);
  const [open, setOpen] = useState(null);
  if (!st.data) return st.error ? <ErrorBox error={st.error} /> : <Spinner />;
  const s = st.data;
  return (
    <div className="stack">
      <div className="card stack-sm">
        <h2>ВлодПочта</h2>
        <p>Ящиков <b>{s.accounts}</b>, доменов <b>{s.domains}</b>, писем <b>{s.messages}</b> ({Math.round(s.bytes / 1024)} КБ). За сутки: {Object.entries(s.day).map(([k, v]) => `${k} ${v}`).join(', ') || 'писем не было'}. Открытых жалоб: <b>{s.open_reports}</b>.</p>
      </div>
      <div className="card stack-sm">
        <h2>Жалобы</h2>
        {!reps.data ? <Spinner /> : !reps.data.reports.length ? <p className="muted">Жалоб нет.</p> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Когда</th><th>Ящик</th><th>От</th><th>Тема</th><th>Причина</th><th /></tr></thead>
            <tbody>{reps.data.reports.map((r) => (
              <tr key={r.id}><td className="small">{new Date(r.created_at).toLocaleString('ru-RU')}</td><td>{r.login}</td><td className="mono small">{r.from_addr}</td><td>{r.subject}</td><td className="small">{r.reason}</td>
                <td className="row">
                  <ActionButton size="sm" kind="ghost" action={async () => setOpen((await get(`/admin/mail/reports/${r.id}`)).report)}>Открыть письмо</ActionButton>
                  {r.status === 'open' && <ActionButton size="sm" action={async () => { await post(`/admin/mail/reports/${r.id}/close`); reps.reload(); st.reload(); }}>Закрыть</ActionButton>}
                </td></tr>
            ))}</tbody></table></div>
        )}
        {open && <><p className="small muted">Открытие письма записано в журнал аудита.</p><pre className="mono small" style={{ whiteSpace: 'pre-wrap', maxHeight: 400, overflow: 'auto', background: 'var(--surface-2)', padding: 10, borderRadius: 8 }}>{open.raw}</pre></>}
      </div>
      <div className="card stack-sm">
        <h2>Журнал почтовых серверов</h2>
        <input className="input" placeholder="адрес или IP" value={q} onChange={(e) => setQ(e.target.value)} />
        {!log.data ? <Spinner /> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Когда</th><th>Сервер</th><th>Откуда</th><th>MAIL FROM / From</th><th>Кому</th><th>Итог</th><th>SPF</th><th>DKIM</th><th>DMARC</th></tr></thead>
            <tbody>{log.data.log.map((l) => (
              <tr key={l.id}><td className="small">{new Date(l.created_at).toLocaleString('ru-RU')}</td><td className="small">{l.server}</td><td className="mono small">{l.from_ip}</td>
                <td className="mono small">{l.mail_from}{l.header_from && l.header_from !== l.mail_from ? ` / ${l.header_from}` : ''}</td><td className="mono small">{l.rcpt}</td>
                <td><Badge kind={ST[l.status]}>{l.status} {l.code}</Badge>{l.detail && <div className="small muted">{l.detail}</div>}</td>
                {['spf', 'dkim', 'dmarc'].map((k) => <td key={k}>{l[k] && <Badge kind={AK[l[k]] || ''}>{l[k]}</Badge>}</td>)}
              </tr>
            ))}</tbody></table></div>
        )}
      </div>
      <div className="card stack-sm">
        <h2>Ящики</h2>
        {!acc.data ? <Spinner /> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Адрес</th><th>Владелец</th><th>Писем</th><th>Статус</th><th /></tr></thead>
            <tbody>{acc.data.accounts.map((a) => (
              <tr key={a.id}><td className="mono">{a.login}@mail.bln</td><td>{a.display_name}</td><td>{a.messages}</td><td><Badge kind={a.status === 'active' ? 'ok' : 'err'}>{a.status === 'active' ? 'работает' : 'заблокирован'}</Badge></td>
                <td><ActionButton size="sm" kind="ghost" confirm={a.status === 'active' ? 'Заблокировать ящик?' : 'Разблокировать?'} action={async () => { await post(`/admin/mail/accounts/${a.id}/status`, { status: a.status === 'active' ? 'blocked' : 'active' }); acc.reload(); }}>{a.status === 'active' ? 'Заблокировать' : 'Разблокировать'}</ActionButton></td></tr>
            ))}</tbody></table></div>
        )}
      </div>
      <div className="card stack-sm">
        <h2>Домены</h2>
        {!doms.data ? <Spinner /> : <ul>{doms.data.domains.map((d) => <li key={d.id}><b>{d.name}</b> — {d.owner || 'ВлодПочта'}, адресов {d.addresses}</li>)}</ul>}
      </div>
    </div>
  );
}
