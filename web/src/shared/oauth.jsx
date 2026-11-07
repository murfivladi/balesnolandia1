// Страница согласия «Войти через ВлодПочту / ВлодУслуги» (этап Н9, OAuth 2) и список подключённых сайтов.
// Решение пользователя превращается в переход на адрес возврата сайта с кодом — во вкладке ВлодБраузера.
import { Fragment, useEffect, useRef } from 'react';
import { get, post, del } from './api.js';
import { fmtDate } from './i18n.js';
import { Spinner, useAsync, ErrorBox, ActionButton, Empty, Badge } from './ui.jsx';

/** Перейти по адресу БалНета во вкладке ВлодБраузера (госсайт открыт во фрейме браузера). */
export function openBalnet(url) {
  try {
    if (typeof window.__balnetOpen === 'function') { window.__balnetOpen(url); return; }
  } catch { /* не во ВлодБраузере */ }
  window.open(`../#${url}`, '_top');
}

export function OAuthConsent({ provider, query }) {
  const info = useAsync(() => get(`/oauth/${provider}/authorize?${new URLSearchParams(query)}`), [provider, JSON.stringify(query)]);
  const auto = useRef(false);
  const decide = async (approve) => {
    const r = await post(`/oauth/${provider}/authorize`, { params: query, approve });
    openBalnet(r.redirect);
  };
  // Уже разрешали этому сайту те же данные — входим сразу, как настоящие провайдеры.
  useEffect(() => {
    if (info.data?.remembered && !auto.current && query.prompt !== 'consent') {
      auto.current = true;
      decide(true).catch(() => { auto.current = false; });
    }
  }, [info.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (info.error) return <div className="card oauth-card"><h2>Не удалось войти</h2><ErrorBox error={info.error} /><p className="small muted">Сообщите владельцу сайта: приложение или адрес возврата не зарегистрированы.</p></div>;
  if (!info.data) return <Spinner />;
  const d = info.data;
  if (d.remembered && query.prompt !== 'consent') return <div className="card oauth-card center"><Spinner /><p>Входим на {d.client.redirect_host}…</p></div>;
  return (
    <div className="card oauth-card stack">
      <div className="muted small">Вход через {d.provider_via}</div>
      <h2 style={{ margin: 0 }}>{d.client.name}</h2>
      <div className="small">хочет получить доступ к вашему аккаунту. После входа вы вернётесь на <b>{d.client.redirect_host}</b>.</div>
      <div>
        <b>Сайт узнает:</b>
        <ul className="small">
          {d.scopes.map((s) => <li key={s.scope}>{s.title}</li>)}
        </ul>
      </div>
      {d.preview && (
        <dl className="kv small">
          {Object.entries(d.preview).map(([k, v]) => <Fragment key={k}><dt>{k}</dt><dd>{typeof v === 'boolean' ? (v ? 'да' : 'нет') : String(v ?? '—')}</dd></Fragment>)}
        </dl>
      )}
      <p className="tiny muted">Пароль сайт не получит. Отозвать доступ можно в любой момент в разделе «Подключённые сайты» ВлодПочты.</p>
      <div className="row">
        <ActionButton action={() => decide(true)}>Разрешить и войти</ActionButton>
        <ActionButton kind="ghost" action={() => decide(false)}>Отмена</ActionButton>
      </div>
    </div>
  );
}

export function ConnectedApps() {
  const g = useAsync(() => get('/oauth/grants'), []);
  if (!g.data) return g.error ? <ErrorBox error={g.error} /> : <Spinner />;
  if (!g.data.grants.length) return <Empty>Вы ещё не входили на сайты через ВлодПочту или ВлодУслуги</Empty>;
  return (
    <div className="list">
      {g.data.grants.map((x) => (
        <div key={`${x.client_id}-${x.provider}`} className="list-item">
          <div className="li-main">
            <div className="li-title">{x.name}</div>
            <div className="li-sub">{x.site_url || ''} · через {x.provider_via} · {x.scopes.join(', ')} · {fmtDate(x.last_used_at || x.created_at)}</div>
          </div>
          <Badge>{x.provider_title}</Badge>
          <ActionButton size="sm" kind="ghost" confirm={`Отозвать доступ сайта «${x.name}»?`} action={async () => { await del(`/oauth/grants/${x.client_id}?provider=${x.provider}`); g.reload(); }}>Отозвать</ActionButton>
        </div>
      ))}
    </div>
  );
}

