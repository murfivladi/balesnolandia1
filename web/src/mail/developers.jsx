// ВлодПочта → Разработчикам (этап Н9): приложения OAuth для кнопок «Войти через ВлодПочту» и «Войти через ВлодУслуги».
import { useState } from 'react';
import { get, post, patch, del } from '../shared/api.js';
import { fmtDate } from '../shared/i18n.js';
import { Spinner, useAsync, Empty, ErrorBox, Button, ActionButton, Input, Form, Modal, Field } from '../shared/ui.jsx';

export function Developers() {
  const list = useAsync(() => get('/oauth/clients'), []);
  const [create, setCreate] = useState(false);
  const [secret, setSecret] = useState(null);
  return (
    <div className="page medium stack">
      <div className="page-head"><h1>Вход для сайтов</h1><Button onClick={() => setCreate(true)}>+ Новое приложение</Button></div>
      <p className="muted">Добавьте на свой сайт кнопки «Войти через ВлодПочту» и «Войти через ВлодУслуги» (OAuth 2 с PKCE). Сайт получит адрес почты, имя или проверку возраста — но не пароль. Пример кода — в <a href="../pay/#/docs?s=oauth">документации</a>.</p>
      <div className="card small">
        <dl className="kv">
          <dt>Авторизация</dt><dd><code>https://mail.bln/oauth/authorize</code> · <code>https://gosuslugi.gov.bln/oauth/authorize</code></dd>
          <dt>Токен</dt><dd><code>POST https://mail.bln/oauth/token</code> (или gosuslugi.gov.bln)</dd>
          <dt>Данные</dt><dd><code>GET /oauth/userinfo</code> с <code>Authorization: Bearer</code></dd>
          <dt>Разрешения</dt><dd>ВлодПочта: <code>openid profile email</code>; ВлодУслуги: <code>openid profile age passport</code></dd>
        </dl>
      </div>
      {!list.data ? (list.error ? <ErrorBox error={list.error} /> : <Spinner />) : !list.data.clients.length ? <Empty>Приложений пока нет</Empty> : list.data.clients.map((c) => (
        <ClientCard key={c.id} c={c} onChange={list.reload} onSecret={setSecret} />
      ))}
      {create && (
        <CreateClient onClose={() => setCreate(false)} onDone={(c) => { setCreate(false); setSecret(c); list.reload(); }} />
      )}
      {secret && (
        <Modal title="Данные приложения" onClose={() => setSecret(null)} footer={<Button onClick={() => setSecret(null)}>Я сохранил секрет</Button>}>
          <p>Секрет показывается <b>один раз</b> — храните его только на сервере сайта.</p>
          <Field label="client_id"><code className="pay-key">{secret.client_id}</code></Field>
          <Field label="client_secret"><code className="pay-key">{secret.client_secret}</code></Field>
        </Modal>
      )}
    </div>
  );
}

function CreateClient({ onClose, onDone }) {
  const [f, setF] = useState({ name: '', site_url: '', redirect_uris: '' });
  return (
    <Modal title="Новое приложение" onClose={onClose}>
      <Form submitLabel="Создать" onSubmit={async () => onDone((await post('/oauth/clients', { ...f, site_url: f.site_url || null })).client)}>
        <Input label="Название (видно на странице входа)" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        <Input label="Сайт" placeholder="https://shop.vasya.bln/" value={f.site_url} onChange={(e) => setF({ ...f, site_url: e.target.value })} />
        <Field label="Адреса возврата (по одному в строке)" hint="Код придёт только на эти адреса: https://shop.vasya.bln/auth/callback">
          <textarea className="input" rows={3} value={f.redirect_uris} onChange={(e) => setF({ ...f, redirect_uris: e.target.value })} required />
        </Field>
      </Form>
    </Modal>
  );
}

function ClientCard({ c, onChange, onSecret }) {
  const [uris, setUris] = useState(c.redirect_uris.join('\n'));
  return (
    <div className="card stack">
      <div className="row-between">
        <div><h3 style={{ margin: 0 }}>{c.name}</h3><div className="small muted">{c.site_url || 'сайт не указан'} · создано {fmtDate(c.created_at)}{c.status === 'blocked' ? ' · заблокировано админом' : ''}</div></div>
        <code>{c.client_id}</code>
      </div>
      <Form submitLabel="Сохранить адреса" block={false} onSubmit={async () => { await patch(`/oauth/clients/${c.id}`, { redirect_uris: uris }); onChange(); }}>
        <Field label="Адреса возврата"><textarea className="input" rows={2} value={uris} onChange={(e) => setUris(e.target.value)} /></Field>
      </Form>
      <div className="row">
        <ActionButton kind="ghost" size="sm" confirm="Выпустить новый секрет? Старый перестанет работать, выданные токены отзовутся." action={async () => onSecret((await post(`/oauth/clients/${c.id}/secret`)).client)}>Новый секрет</ActionButton>
        <ActionButton kind="danger" size="sm" confirm={`Удалить приложение «${c.name}»? Пользователи не смогут войти.`} action={async () => { await del(`/oauth/clients/${c.id}`); onChange(); }}>Удалить</ActionButton>
      </div>
    </div>
  );
}
