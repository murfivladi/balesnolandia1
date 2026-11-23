// Менеджер паролей и аккаунт ВлодБраузера: предложение сохранить пароль, вход через ВлодПочту,
// кодовая фраза синхронизации, список паролей в настройках.
import { useState } from 'react';

const host = (origin) => origin.replace(/^https?:\/\//, '');

export function PasswordPrompt({ cred, onSave, onNever, onClose }) {
  const [show, setShow] = useState(false);
  return (
    <div className="bb-pwbar" role="dialog" aria-label="Сохранить пароль">
      <span>🔑 Сохранить пароль для <b>{host(cred.origin)}</b>?</span>
      <span className="bp-muted">{cred.username || '(без имени)'} · <button className="bp-link" onClick={() => setShow((v) => !v)}>{show ? cred.password : '••••••'}</button></span>
      {cred.origin.startsWith('http:') && <span className="bb-bad">⚠ сайт без HTTPS: пароль передан открыто</span>}
      <span className="bp-grow" />
      <button className="bp-btn bp-btn-primary" onClick={onSave}>Сохранить</button>
      <button className="bp-btn" onClick={onNever}>Никогда для этого сайта</button>
      <button className="bp-icon-btn" aria-label="Закрыть" onClick={onClose}>✕</button>
    </div>
  );
}

export function AccountSettings({ ctx }) {
  const [phrase, setPhrase] = useState('');
  const [phrase2, setPhrase2] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const acc = ctx.account;
  const run = async (fn) => {
    setBusy(true);
    setErr(null);
    try { await fn(); } catch (e) {
      if (e.status === 401) {
        setErr('Сначала войдите во ВлодПочту: откроется mail.bln — войдите и нажмите там «Подключить этот ВлодБраузер».');
        ctx.navigate('https://mail.bln/browser', { newTab: true });
      } else setErr(e.message);
    } finally { setBusy(false); }
  };
  if (ctx.incognito) return <section className="bp-card"><h2>Аккаунт ВлодБраузера</h2><p>В режиме инкогнито аккаунт и синхронизация не работают.</p></section>;
  const needNew = acc && !acc.key && !acc.keyInfo;
  const s = ctx.syncState;
  return (
    <section className="bp-card">
      <h2>Аккаунт ВлодБраузера</h2>
      {!acc ? (
        <>
          <p>Войдите аккаунтом ВлодПочты, чтобы закладки, история и пароли этого профиля были на всех ваших устройствах.</p>
          <button className="bp-btn bp-btn-primary" disabled={busy} onClick={() => run(ctx.signIn)}>✉ Войти через ВлодПочту</button>
        </>
      ) : (
        <>
          <p>Вы вошли: <b>{acc.address}</b>{acc.name ? ` (${acc.name})` : ''}.</p>
          {!acc.key ? (
            <form className="bp-stack" onSubmit={(e) => {
              e.preventDefault();
              if (needNew && phrase !== phrase2) { setErr('Фразы не совпадают'); return; }
              if (needNew && phrase.length < 8) { setErr('Кодовая фраза — не короче 8 символов'); return; }
              run(() => ctx.setPhrase(phrase));
            }}>
              <p>{needNew
                ? 'Придумайте кодовую фразу синхронизации. Ею данные шифруются прямо в браузере — ВлодПочта её не знает и восстановить не сможет.'
                : 'Введите кодовую фразу синхронизации, заданную на другом устройстве.'}</p>
              <input type="password" placeholder="Кодовая фраза" autoComplete="new-password" value={phrase} onChange={(e) => setPhrase(e.target.value)} aria-label="Кодовая фраза" />
              {needNew && <input type="password" placeholder="Ещё раз" autoComplete="new-password" value={phrase2} onChange={(e) => setPhrase2(e.target.value)} aria-label="Повтор кодовой фразы" />}
              <div><button className="bp-btn bp-btn-primary" disabled={busy}>{needNew ? 'Включить синхронизацию' : 'Разблокировать'}</button></div>
              {!needNew && <p className="bp-muted">Забыли фразу? Сбросьте синхронизацию на mail.bln → «ВлодБраузер» и задайте новую.</p>}
            </form>
          ) : (
            <p>
              {s.status === 'syncing' ? '⟳ Синхронизация…'
                : s.status === 'error' ? <span className="bb-bad">⚠ {s.error}</span>
                  : s.status === 'ok' ? `✓ Синхронизировано ${new Date(s.at).toLocaleTimeString('ru-RU')}: закладок ${s.result.bookmarks?.count ?? 0}, записей истории ${s.result.history?.count ?? 0}, паролей ${s.result.passwords?.count ?? 0}`
                    : 'Синхронизация включена.'}
            </p>
          )}
          <div className="bp-row">
            {acc.key && <button className="bp-btn" disabled={busy} onClick={() => run(ctx.syncNow)}>Синхронизировать сейчас</button>}
            <button className="bp-btn" onClick={() => ctx.navigate('https://mail.bln/browser', { newTab: true })}>Устройства</button>
            <button className="bp-btn" disabled={busy} onClick={() => { if (confirm('Выйти из аккаунта? Данные останутся в этом профиле.')) run(ctx.signOut); }}>Выйти</button>
          </div>
        </>
      )}
      {err && <p className="bb-bad">{err}</p>}
    </section>
  );
}

export function PasswordSettings({ ctx }) {
  const [shown, setShown] = useState({});
  const [filter, setFilter] = useState('');
  const list = ctx.passwords.filter((p) => `${p.origin} ${p.username}`.toLowerCase().includes(filter.toLowerCase()));
  return (
    <section className="bp-card">
      <h2>Пароли</h2>
      <p className="bp-muted">ВлодБраузер предлагает сохранить пароль, когда вы входите на сайт БалНета, и подставляет его по кнопке 🔑 в адресной строке.{ctx.account?.key ? ' Пароли синхронизируются в зашифрованном виде.' : ''}</p>
      {ctx.passwords.length > 5 && <input placeholder="Поиск паролей" value={filter} onChange={(e) => setFilter(e.target.value)} aria-label="Поиск паролей" />}
      {!list.length ? <p>Сохранённых паролей нет.</p> : list.map((p) => {
        const k = `${p.origin}|${p.username}`;
        return (
          <div key={k} className="bp-row">
            <b className="bp-ellipsis">{host(p.origin)}</b>
            <span className="bp-ellipsis">{p.username || '(без имени)'}</span>
            <span className="bp-grow" />
            <span className="bp-mono">{shown[k] ? p.password : '••••••'}</span>
            <button className="bp-icon-btn" title={shown[k] ? 'Скрыть' : 'Показать'} aria-label="Показать пароль" onClick={() => setShown((x) => ({ ...x, [k]: !x[k] }))}>👁</button>
            <button className="bp-icon-btn" title="Копировать" aria-label="Копировать пароль" onClick={() => navigator.clipboard?.writeText(p.password)}>⧉</button>
            <button className="bp-icon-btn" title="Удалить" aria-label="Удалить пароль" onClick={() => { if (confirm(`Удалить пароль для ${host(p.origin)}?`)) ctx.removePassword(p); }}>🗑</button>
          </div>
        );
      })}
      {(ctx.settings.neverSave || []).length > 0 && (
        <p className="bp-muted">Не предлагать сохранять: {ctx.settings.neverSave.map(host).join(', ')} <button className="bp-link" onClick={() => ctx.setSettings({ ...ctx.settings, neverSave: [] })}>очистить</button></p>
      )}
    </section>
  );
}
