import { useState, useEffect } from 'react';
import { post, get } from './api.js';
import { reconnect } from './ws.js';
import { t } from './i18n.js';
import { Input, Form, Seg, DISCLAIMER, Modal, Empty, useAsync, Spinner, Button } from './ui.jsx';
import { pushSupport, currentSubscription, subscribePush } from './push.js';
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

/**
 * Push на это устройство (этап Н10): уведомления ленты приходят на телефон или компьютер, даже когда приложение закрыто.
 * Выключение удаляет подписку только у этого приложения — другие (банк, услуги, ВлодБраузер) продолжают её использовать.
 */
export function PushSwitch({ kind }) {
  const [st, setSt] = useState({ phase: 'check' });
  const support = pushSupport();
  const refresh = async () => {
    const sub = await currentSubscription();
    if (!sub) return setSt({ phase: 'off' });
    const r = await get(`/push/devices?kind=${kind}`).catch(() => ({ devices: [] }));
    const mine = r.devices.find((d) => d.endpoint === sub.endpoint);
    return setSt({ phase: mine ? 'on' : 'off', id: mine?.id });
  };
  useEffect(() => { refresh(); }, [kind]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = (fn) => async () => {
    setSt((v) => ({ ...v, busy: true, error: null, note: null }));
    try { await fn(); } catch (e) { setSt((v) => ({ ...v, busy: false, error: e.message })); return; }
    setSt((v) => ({ ...v, busy: false }));
  };
  const enable = run(async () => {
    const sub = await subscribePush();
    await post('/push/subscribe', { kind, subscription: sub.toJSON() });
    await refresh();
  });
  const disable = run(async () => {
    await post('/push/unsubscribe', { kind, id: st.id });
    await refresh();
  });
  const testPush = run(async () => {
    const r = await post('/push/test', { kind });
    setSt((v) => ({ ...v, note: r.sent ? t('Отправлено — уведомление появится через пару секунд') : t('Не отправлено: подписка не найдена') }));
  });
  return (
    <div className="card" style={{ padding: 12, marginBottom: 12 }}>
      <div className="row" style={{ gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <div style={{ flex: 1, minWidth: 180 }}>
          <b>{t('Push на это устройство')}</b>
          <div className="tiny muted">
            {!support.ok && st.phase !== 'on' ? t(support.reason)
              : st.phase === 'on' ? t('Включены: уведомления придут, даже когда приложение закрыто')
                : t('Получайте уведомления на телефон или компьютер, даже когда приложение закрыто')}
          </div>
        </div>
        {st.phase === 'check' ? <Spinner /> : st.phase === 'on' ? (
          <>
            <Button size="sm" kind="secondary" busy={st.busy} onClick={testPush}>{t('Проверить')}</Button>
            <Button size="sm" kind="ghost" busy={st.busy} onClick={disable}>{t('Выключить')}</Button>
          </>
        ) : support.ok && <Button size="sm" busy={st.busy} onClick={enable}>{t('Включить')}</Button>}
      </div>
      {st.error && <div className="tiny" style={{ color: 'var(--danger, #c0392b)', marginTop: 6 }}>{t(st.error)}</div>}
      {st.note && <div className="tiny muted" style={{ marginTop: 6 }}>{st.note}</div>}
    </div>
  );
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
      <PushSwitch kind={kind} />
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
