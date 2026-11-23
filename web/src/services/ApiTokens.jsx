// ВлодУслуги → Ключи API: токены bln_… для серверов сайтов БалНета и программ из интернета.
import { useState } from 'react';
import { get, post, del, apiBase } from '../shared/api.js';
import { Spinner, useAsync, ErrorBox, ActionButton, Input, Empty, useToast, Button } from '../shared/ui.jsx';

const EXAMPLES = [
  ['Домены и DNS', "await fetch('https://reg.bln/api/gov/domains', { headers })"],
  ['Новая DNS-запись', "await fetch('https://reg.bln/api/gov/domains/ID/records', { method: 'POST', headers, body: JSON.stringify({ name: '@', type: 'A', data: '50.2.0.10' }) })"],
  ['Хостинг и сайты', "await fetch('https://hosting.bln/api/gov/hosting', { headers })"],
  ['Оплатить счёт', "await fetch('https://bank.bln/api/bank/invoices/НОМЕР/pay', { method: 'POST', headers, body: JSON.stringify({ account_id: ID }) })"],
  ['Статья в своё СМИ', "await fetch('https://novosti.bln/api/news/outlets/СМИ/articles', { method: 'POST', headers, body: JSON.stringify({ title, body }) })"],
];

export function ApiTokensPage() {
  const r = useAsync(() => get('/gov/api-tokens'), []);
  const toast = useToast();
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState(['domains', 'hosting']);
  const [made, setMade] = useState(null);
  if (!r.data) return r.error ? <ErrorBox error={r.error} /> : <Spinner />;
  const { tokens, scopes: all } = r.data;
  return (
    <div className="page narrow stack">
      <h1>Ключи API</h1>
      <p className="muted">Токен позволяет серверу вашего сайта (server.js, cron, SSH) или программе из интернета управлять доменами, хостингом, сертификатами, почтой, новостями, ВлодХабом и госуслугами от вашего имени — в пределах выбранных прав. Вход, смена пароля, админка и сами токены через API недоступны.</p>
      <form className="card stack" onSubmit={async (e) => {
        e.preventDefault();
        try { const t = await post('/gov/api-tokens', { name, scopes }); setMade(t); setName(''); r.reload(); } catch (err) { toast(err.message, 'err'); }
      }}>
        <Input label="Название" value={name} onChange={(e) => setName(e.target.value)} placeholder="Сервер моего магазина" required />
        <div className="stack-sm">
          {Object.entries(all).map(([k, label]) => (
            <label key={k} className="row small"><input type="checkbox" checked={scopes.includes(k)} onChange={(e) => setScopes(e.target.checked ? [...scopes, k] : scopes.filter((s) => s !== k))} /> <b className="mono">{k}</b> — {label}</label>
          ))}
        </div>
        <Button>Создать токен</Button>
      </form>
      {made && <div className="form-ok stack-sm"><b>Скопируйте токен — больше он не покажется:</b><span className="mono" style={{ overflowWrap: 'anywhere' }}>{made.token}</span></div>}
      <div className="card stack-sm">
        <h2>Ваши токены</h2>
        {!tokens.length ? <Empty>Токенов нет</Empty> : tokens.map((t) => (
          <div key={t.id} className="row">
            <span style={{ flex: 1 }}><b>{t.name}</b> <span className="mono small">{t.prefix}…</span><br /><span className="small muted">{t.scopes.join(', ')}{t.last_used ? ` · использован ${new Date(t.last_used).toLocaleString('ru-RU')}` : ''}</span></span>
            <ActionButton size="sm" kind="ghost" confirm="Отозвать токен?" action={async () => { await del(`/gov/api-tokens/${t.id}`); r.reload(); }}>Отозвать</ActionButton>
          </div>
        ))}
      </div>
      <div className="card stack-sm">
        <h2>Как пользоваться</h2>
        <p className="small">Из server.js — по сети БалНета на любой госсайт по https (reg.bln, hosting.bln, ca.gov.bln, bank.bln, mail.bln, novosti.bln, vlodhub.bln, gosuslugi.gov.bln), путь — как у API: <span className="mono">/api/…</span>.</p>
        <pre className="mono small" style={{ whiteSpace: 'pre-wrap' }}>{"const headers = { authorization: 'Bearer bln_…', 'content-type': 'application/json' };\n"}{EXAMPLES.map(([t, c]) => `// ${t}\n${c}\n`).join('')}</pre>
        <p className="small">Из настоящего интернета — тот же путь на сервере API: <span className="mono">{apiBase()}/gov/domains</span> с заголовком <span className="mono">Authorization: Bearer bln_…</span>.</p>
      </div>
    </div>
  );
}
