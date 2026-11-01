import { useState } from 'react';
import { post, get } from './api.js';
import { reconnect } from './ws.js';
import { t } from './i18n.js';
import { Input, Form, Seg, DISCLAIMER, Modal, Empty, useAsync, Spinner } from './ui.jsx';
import { fmtDate } from './i18n.js';

/** Вход по паролю или по коду на email. kind: bank | gov */
export function LoginForm({ kind, onDone }) {
  const [mode, setMode] = useState('password');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false);

  async function done(res) {
    reconnect();
    onDone?.(res.user);
  }

  return (
    <div className="stack">
      <Seg value={mode} onChange={(m) => { setMode(m); setSent(false); }} options={[{ value: 'password', label: t('Пароль') }, { value: 'code', label: t('Код на email') }]} />
      {mode === 'password' ? (
        <Form submitLabel={t('Войти')} onSubmit={async () => done(await post(`/auth/${kind}/login`, { email, password }))}>
          <Input label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <Input label={t('Пароль')} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Form>
      ) : !sent ? (
        <Form submitLabel={t('Получить код')} onSubmit={async () => { await post(`/auth/${kind}/code/send`, { email }); setSent(true); }}>
          <Input label="Email" type="email" autoComplete="email" required value={email} onChange={(e) => setEmail(e.target.value)} />
          <p className="muted small">{t('Пришлём 6 цифр. Код действует 10 минут.')}</p>
        </Form>
      ) : (
        <Form submitLabel={t('Войти')} onSubmit={async () => done(await post(`/auth/${kind}/code/verify`, { email, code }))} extra={<button type="button" className="btn ghost" onClick={() => setSent(false)}>{t('Назад')}</button>}>
          <p className="small">{t('Код отправлен на {email}', { email })}</p>
          <Input label={t('Код из письма')} inputMode="numeric" autoComplete="one-time-code" maxLength={6} required value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
        </Form>
      )}
    </div>
  );
}

export function AuthDisclaimer() {
  return <div className="disclaimer-box">{t(DISCLAIMER)} {t('Не используйте пароли от настоящих сервисов.')}</div>;
}

/** Лента уведомлений. */
export function NotificationsModal({ kind, onClose, onRead }) {
  const { data, loading } = useAsync(async () => {
    const r = await get(`/notifications?kind=${kind}`);
    if (r.unread) {
      await post(`/notifications/read?kind=${kind}`, {});
      onRead?.();
    }
    return r;
  }, [kind]);
  return (
    <Modal title={t('Уведомления')} onClose={onClose}>
      {loading && !data ? <Spinner /> : !data?.items.length ? <Empty>{t('Пока ничего нет')}</Empty> : (
        <div className="list">
          {data.items.map((n) => (
            <a key={n.id} className="list-item clickable" href={n.link || undefined} onClick={onClose} style={{ color: 'inherit', textDecoration: 'none' }}>
              <div className="li-main">
                <div className="li-title">{!n.read_at && <span className="badge brand" style={{ marginRight: 6 }}>{t('новое')}</span>}{t(n.title)}</div>
                {n.body && <div className="li-sub">{n.body}</div>}
              </div>
              <div className="tiny muted nowrap">{fmtDate(n.created_at)}</div>
            </a>
          ))}
        </div>
      )}
    </Modal>
  );
}
