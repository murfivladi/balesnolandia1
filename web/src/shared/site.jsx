// Каркас «настоящего сайта» для сервисов БалНета: подвал с колонками, первый экран, блоки преимуществ и тарифов,
// вход «через ВлодУслуги». Шапка — Topbar с variant="site".
import { useEffect, useState } from 'react';
import { get } from './api.js';
import { DISCLAIMER, Spinner } from './ui.jsx';
import { CoatOfArms } from './brand.jsx';

/** Полоса над шапкой госсайта. */
export function GovStrip() {
  return <><CoatOfArms size={16} /><span>Официальный сайт · Балесноландская Федерация</span></>;
}

export function SiteFooter({ brand, about, columns = [], year = 2026 }) {
  return (
    <footer className="site-footer">
      <div className="site-footer-inner">
        <div className="site-footer-about">
          <div className="site-footer-brand">{brand}</div>
          {about && <p>{about}</p>}
        </div>
        {columns.map((c) => (
          <div key={c.title}>
            <h4>{c.title}</h4>
            <ul>{c.links.map((l) => <li key={l.label}><a href={l.href} target={l.top ? '_top' : undefined}>{l.label}</a></li>)}</ul>
          </div>
        ))}
      </div>
      <div className="site-footer-bottom">
        <span>© {year} {typeof brand === 'string' ? brand : ''}</span>
        <span>{DISCLAIMER}</span>
      </div>
    </footer>
  );
}

export function Hero({ kicker, title, lead, children, art, compact = false }) {
  return (
    <section className={`hero${compact ? ' compact' : ''}`}>
      <div className="hero-inner">
        <div>
          {kicker && <div className="hero-kicker">{kicker}</div>}
          <h1>{title}</h1>
          {lead && <p className="lead">{lead}</p>}
          {children}
        </div>
        {art && <div className="hero-art" aria-hidden>{art}</div>}
      </div>
    </section>
  );
}

export function Section({ title, lead, children, id, muted = false }) {
  return (
    <section className={`section-wrap${muted ? ' muted-bg' : ''}`} id={id}>
      <div className="section">
        {title && <h2 className="section-title">{title}</h2>}
        {lead && <p className="section-lead">{lead}</p>}
        {children}
      </div>
    </section>
  );
}

export function Features({ items }) {
  return (
    <div className="features">
      {items.map((f) => (
        <div key={f.title} className="feature">
          <div className="ico" aria-hidden>{f.icon}</div>
          <h3>{f.title}</h3>
          <p>{f.text}</p>
        </div>
      ))}
    </div>
  );
}

/** Ссылка на вход во ВлодУслугах с возвратом на этот сайт. */
export function govLoginHref(app, hash = '#/') {
  const back = `../${app}/${hash}`;
  return `../services/#/?return=${encodeURIComponent(back)}`;
}

/** Текущий пользователь ВлодУслуг (undefined — загрузка, null — не вошёл). */
export function useGovUser() {
  const [me, setMe] = useState(undefined);
  useEffect(() => {
    get('/auth/me').then((r) => setMe(r.gov || null)).catch(() => setMe(null));
  }, []);
  return me;
}

/** Блок входа: «Войти через ВлодУслуги». */
export function GovLogin({ app, siteName, hash }) {
  return (
    <div className="login-card">
      <h2>Вход на {siteName}</h2>
      <p className="muted">Используйте аккаунт ВлодУслуг — отдельный пароль не нужен.</p>
      <a className="btn gov-login-btn" href={govLoginHref(app, hash || location.hash || '#/')}>
        <CoatOfArms size={20} /> Войти через ВлодУслуги
      </a>
      <p className="small muted">Нет аккаунта? Он создаётся там же, во ВлодУслугах.</p>
    </div>
  );
}

/** Показывает children(me) только после входа, иначе — карточку входа. */
export function RequireGov({ app, siteName, children }) {
  const me = useGovUser();
  if (me === undefined) return <Spinner />;
  if (!me) return <div className="page narrow"><GovLogin app={app} siteName={siteName} /></div>;
  return children(me);
}
