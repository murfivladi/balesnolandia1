// Внутренние страницы ВлодБраузера: новая вкладка, история, закладки, настройки, о браузере,
// страницы ошибок и «БалНет на обслуживании».
import { useEffect, useMemo, useState } from 'react';
import { AccountSettings, PasswordSettings } from './passwords.jsx';
import { CoatOfArms } from '../shared/brand.jsx';
import { DISCLAIMER } from '../shared/ui.jsx';
import { GOV_SITES, NET_ERRORS, displayUrl, searchUrl, parseInput } from '@bln/shared/balnet-url.js';
import { CourierGame } from './game.jsx';
import { providers, lease, PUBLIC_DNS } from './net.js';
import { isIP } from '@bln/shared/balnet-ip.js';
import { get, post } from '../shared/api.js';

export function Disclaimer() {
  return <p className="bp-disclaimer">{DISCLAIMER}</p>;
}

export function Favicon({ url, size = 16 }) {
  const host = (displayUrl(url) || '?').replace(/^http:\/\//, '').split(/[/.]/)[0];
  const letter = (host[0] || '?').toUpperCase();
  let hue = 0;
  for (const ch of host) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return (
    <span className="bp-fav" style={{ width: size, height: size, fontSize: size * 0.62, background: `hsl(${hue} 55% 45%)` }} aria-hidden>
      {letter}
    </span>
  );
}

export function VlodPoiskLogo({ size = 40 }) {
  return (
    <span className="bp-poisk-logo" style={{ fontSize: size }}>
      <span style={{ color: '#1f4fbf' }}>Влод</span><span style={{ color: '#b8901f' }}>Поиск</span>
    </span>
  );
}

function SearchBox({ initial = '', onSearch, autoFocus }) {
  const [q, setQ] = useState(initial);
  return (
    <form className="bp-search" onSubmit={(e) => { e.preventDefault(); if (q.trim()) onSearch(q.trim()); }} role="search">
      <span aria-hidden>🔍</span>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Искать во ВлодПоиске или ввести адрес" aria-label="Поиск" autoFocus={autoFocus} />
    </form>
  );
}

const plural = (n, one, few, many) => {
  const a = n % 10; const b = n % 100;
  if (a === 1 && b !== 11) return one;
  if (a >= 2 && a <= 4 && (b < 10 || b >= 20)) return few;
  return many;
};

export function NewTabPage({ ctx }) {
  const tiles = useMemo(() => {
    const gov = Object.entries(GOV_SITES).map(([host, s]) => ({ url: `https://${host}/`, title: s.title }));
    const counts = new Map();
    for (const h of ctx.history) {
      const key = h.url.replace(/[?#].*$/, '');
      if (key.startsWith('balnet://') || key.includes('://poisk.bln/') || gov.some((g) => g.url === key)) continue;
      const c = counts.get(key) || { url: key, title: h.title, n: 0 };
      c.n += 1;
      counts.set(key, c);
    }
    const top = [...counts.values()].sort((a, b) => b.n - a.n).slice(0, Math.max(2, 10 - gov.length));
    return [...gov, ...top];
  }, [ctx.history]);
  const clock = ctx.clock;
  return (
    <div className={`bp-page bp-newtab ${ctx.incognito ? 'is-incognito' : ''}`}>
      {ctx.incognito ? (
        <div className="bp-incog-intro">
          <div className="bp-incog-icon" aria-hidden>🕶</div>
          <h1>Режим инкогнито</h1>
          <p>ВлодБраузер не сохранит историю, вкладки и закладки этого режима — всё исчезнет при выходе из инкогнито.</p>
          <p>Вход на госсайты (bank.bln, gosuslugi.gov.bln, kassa.bln) общий с обычным режимом: если вы вошли там, вы вошли и здесь. Выходите из аккаунта вручную.</p>
          <p className="bp-muted">Ваши действия всё равно видны сайтам, которые вы открываете, и вашему провайдеру БалНета.</p>
        </div>
      ) : (
        <div className="bp-newtab-logo"><CoatOfArms size={56} /><VlodPoiskLogo size={44} /></div>
      )}
      <SearchBox onSearch={(q) => ctx.navigate(parseInput(q))} autoFocus />
      <div className="bp-tiles">
        {tiles.map((t) => (
          <button key={t.url} className="bp-tile" onClick={() => ctx.navigate(t.url)} title={t.url}>
            <Favicon url={t.url} size={32} />
            <span>{t.title || displayUrl(t.url)}</span>
          </button>
        ))}
      </div>
      {!ctx.incognito && <SponsoredTile ctx={ctx} />}
      {clock && (
        <div className="bp-widget">
          <b>Игровое время БФ:</b>{' '}
          {clock.paused ? 'пауза — БалНет на обслуживании' : `${clock.month} ${plural(clock.month, 'месяц', 'месяца', 'месяцев')} с основания, игровой месяц = ${clock.minutes} мин`}
        </div>
      )}
      <Disclaimer />
    </div>
  );
}

/** Рекламная плитка рекламной сети ВлодПоиска (помечена «Реклама»). */
function SponsoredTile({ ctx }) {
  const [ad, setAd] = useState(null);
  useEffect(() => {
    let alive = true;
    get('/search/ads/newtab').then((r) => { if (alive) setAd(r.ad); }).catch(() => {});
    return () => { alive = false; };
  }, []);
  if (!ad) return null;
  const open = () => post('/search/ads/click', { token: ad.token }).then((r) => ctx.navigate(r.url), () => ctx.navigate(ad.url));
  return (
    <button className="bp-ad" onClick={open}>
      <span className="bp-muted"><b>Реклама</b> · {ad.display}</span>
      <b className="bp-ad-title">{ad.title}</b>
      <span>{ad.text}</span>
    </button>
  );
}

function dayLabel(ts) {
  const d = new Date(ts);
  const today = new Date();
  const y = new Date(); y.setDate(today.getDate() - 1);
  if (d.toDateString() === today.toDateString()) return 'Сегодня';
  if (d.toDateString() === y.toDateString()) return 'Вчера';
  return d.toLocaleDateString('ru-RU', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

export function HistoryPage({ ctx }) {
  const [q, setQ] = useState('');
  const items = ctx.history.filter((h) => !q || `${h.title} ${h.url}`.toLowerCase().includes(q.toLowerCase()));
  const groups = [];
  for (const h of items) {
    const label = dayLabel(h.ts);
    if (!groups.length || groups[groups.length - 1].label !== label) groups.push({ label, items: [] });
    groups[groups.length - 1].items.push(h);
  }
  return (
    <div className="bp-page bp-list-page">
      <header className="bp-page-head">
        <h1>История</h1>
        <input className="bp-filter" placeholder="Поиск в истории" value={q} onChange={(e) => setQ(e.target.value)} />
        <button className="bp-btn" disabled={!ctx.history.length} onClick={() => { if (confirm('Очистить всю историю этого профиля?')) ctx.clearHistory(); }}>Очистить историю</button>
      </header>
      {ctx.incognito && <p className="bp-muted">В режиме инкогнито история не сохраняется.</p>}
      {!groups.length && <p className="bp-muted">{q ? 'Ничего не найдено.' : 'История пуста.'}</p>}
      {groups.map((g) => (
        <section key={g.label} className="bp-card">
          <h2>{g.label}</h2>
          {g.items.map((h) => (
            <div key={`${h.ts}-${h.url}`} className="bp-row">
              <span className="bp-time">{new Date(h.ts).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}</span>
              <Favicon url={h.url} />
              <button className="bp-link" onClick={() => ctx.navigate(h.url)}>{h.title || displayUrl(h.url)}</button>
              <span className="bp-muted bp-ellipsis">{displayUrl(h.url)}</span>
              <button className="bp-icon-btn" title="Удалить из истории" aria-label="Удалить из истории" onClick={() => ctx.removeHistory(h)}>✕</button>
            </div>
          ))}
        </section>
      ))}
    </div>
  );
}

export function BookmarksPage({ ctx }) {
  const [edit, setEdit] = useState(null);
  return (
    <div className="bp-page bp-list-page">
      <header className="bp-page-head">
        <h1>Закладки</h1>
        <button className="bp-btn" onClick={() => {
          const raw = prompt('Адрес закладки', 'bank.bln');
          const url = raw && parseInput(raw);
          if (url) ctx.addBookmark(url, prompt('Название', displayUrl(url)) || displayUrl(url));
        }}>Добавить закладку</button>
      </header>
      {!ctx.bookmarks.length && <p className="bp-muted">Закладок пока нет. Нажмите ☆ в адресной строке, чтобы добавить страницу.</p>}
      {!!ctx.bookmarks.length && (
        <section className="bp-card">
          {ctx.bookmarks.map((b, i) => (
            <div key={b.url} className="bp-row">
              <Favicon url={b.url} />
              {edit === b.url ? (
                <form className="bp-inline-form" onSubmit={(e) => { e.preventDefault(); ctx.renameBookmark(b.url, e.target.elements.title.value); setEdit(null); }}>
                  <input name="title" defaultValue={b.title} autoFocus aria-label="Название" />
                  <button className="bp-btn">Сохранить</button>
                </form>
              ) : (
                <button className="bp-link" onClick={() => ctx.navigate(b.url)}>{b.title}</button>
              )}
              <span className="bp-muted bp-ellipsis">{displayUrl(b.url)}</span>
              <button className="bp-icon-btn" title="Выше" aria-label="Выше" disabled={i === 0} onClick={() => ctx.moveBookmark(b.url, -1)}>↑</button>
              <button className="bp-icon-btn" title="Переименовать" aria-label="Переименовать" onClick={() => setEdit(b.url)}>✎</button>
              <button className="bp-icon-btn" title="Удалить" aria-label="Удалить" onClick={() => ctx.removeBookmark(b.url)}>✕</button>
            </div>
          ))}
        </section>
      )}
    </div>
  );
}

export function SettingsPage({ ctx }) {
  const s = ctx.settings;
  const profile = ctx.profiles.find((p) => p.id === ctx.profileId);
  return (
    <div className="bp-page bp-list-page">
      <header className="bp-page-head"><h1>Настройки</h1></header>
      <section className="bp-card">
        <h2>Внешний вид</h2>
        <label className="bp-check"><input type="checkbox" checked={s.bookmarksBar} onChange={(e) => ctx.setSettings({ ...s, bookmarksBar: e.target.checked })} /> Показывать панель закладок</label>
        <label className="bp-check"><input type="checkbox" checked={ctx.theme === 'dark'} onChange={ctx.toggleTheme} /> Тёмная тема</label>
      </section>
      <section className="bp-card">
        <h2>При запуске и кнопка «Домой»</h2>
        <label className="bp-check"><input type="radio" name="home" checked={s.home === 'balnet://newtab/'} onChange={() => ctx.setSettings({ ...s, home: 'balnet://newtab/' })} /> Новая вкладка</label>
        <label className="bp-check"><input type="radio" name="home" checked={s.home !== 'balnet://newtab/'} onChange={() => ctx.setSettings({ ...s, home: 'https://gosuslugi.gov.bln/' })} /> Страница:</label>
        {s.home !== 'balnet://newtab/' && (
          <form className="bp-inline-form" onSubmit={(e) => { e.preventDefault(); const u = parseInput(e.target.elements.home.value); if (u) ctx.setSettings({ ...s, home: u }); }}>
            <input name="home" defaultValue={displayUrl(s.home)} aria-label="Домашняя страница" />
            <button className="bp-btn">Сохранить</button>
          </form>
        )}
        <label className="bp-check"><input type="checkbox" checked={s.restoreSession} onChange={(e) => ctx.setSettings({ ...s, restoreSession: e.target.checked })} /> Восстанавливать вкладки при запуске</label>
      </section>
      <NetworkSettings ctx={ctx} />
      <section className="bp-card">
        <h2>Поисковая система</h2>
        <p>ВлодПоиск (poisk.bln) — официальный поисковик БФ.</p>
      </section>
      <section className="bp-card">
        <h2>Профили</h2>
        {ctx.profiles.map((p) => (
          <div key={p.id} className="bp-row">
            <span className="bp-avatar" style={{ background: p.color }}>{p.name[0]}</span>
            <b>{p.name}</b>{p.id === ctx.profileId && <span className="bp-muted"> — текущий</span>}
            <span className="bp-grow" />
            <button className="bp-icon-btn" title="Переименовать" aria-label="Переименовать" onClick={() => { const n = prompt('Имя профиля', p.name); if (n?.trim()) ctx.renameProfile(p.id, n.trim()); }}>✎</button>
            {p.id !== ctx.profileId && <button className="bp-btn" onClick={() => ctx.switchProfile(p.id)}>Открыть</button>}
            {ctx.profiles.length > 1 && <button className="bp-icon-btn" title="Удалить профиль" aria-label="Удалить профиль" onClick={() => { if (confirm(`Удалить профиль «${p.name}» вместе с историей и закладками?`)) ctx.deleteProfile(p.id); }}>🗑</button>}
          </div>
        ))}
        <button className="bp-btn" onClick={ctx.addProfile}>Добавить профиль</button>
        <p className="bp-muted">У каждого профиля свой аккаунт ВлодБраузера и своя синхронизация.</p>
      </section>
      <AccountSettings ctx={ctx} />
      <PasswordSettings ctx={ctx} />
      <section className="bp-card">
        <h2>Конфиденциальность</h2>
        <p>Данные профиля «{profile?.name}» хранятся в этом браузере{ctx.account?.key ? ' и в зашифрованном виде — в аккаунте ВлодБраузера' : ''}.</p>
        <button className="bp-btn" onClick={() => { if (confirm('Удалить историю этого профиля?')) ctx.clearHistory(); }}>Удалить историю</button>
      </section>
    </div>
  );
}

export function AboutPage() {
  return (
    <div className="bp-page bp-list-page">
      <header className="bp-page-head"><CoatOfArms size={40} /><h1>О ВлодБраузере</h1></header>
      <section className="bp-card">
        <p><b>ВлодБраузер</b> — браузер БалНета, вымышленного интернета Балесноландской Федерации.</p>
        <p>Версия Н8: вкладки, история, закладки, профили, инкогнито; настоящий DNS БалНета, HTTPS с проверкой сертификатов, Безопасный просмотр, терминал и DevTools → Network; аккаунт ВлодБраузера на ВлодПочте с зашифрованной синхронизацией и менеджер паролей.</p>
        <p>Значок «Госсайт БФ» в адресной строке рисует сам браузер. Сайт не может его подделать: если значка нет — это не госсайт, даже если страница выглядит так же.</p>
        <p>Горячие клавиши: Ctrl+L — адресная строка, Ctrl+D — закладка, Ctrl+H — история, Alt+← и Alt+→ — назад и вперёд, Alt+T — новая вкладка, Ctrl+R — перезагрузить, Alt+W — закрыть вкладку.</p>
      </section>
      <Disclaimer />
    </div>
  );
}

export function ErrorPage({ code, host, onReload, ctx, ip }) {
  const e = NET_ERRORS[code] || NET_ERRORS.ERR_INVALID_URL;
  const [game, setGame] = useState(code === 'ERR_INTERNET_DISCONNECTED');
  return (
    <div className="bp-page bp-error">
      <div className="bp-error-icon" aria-hidden>{code === 'ERR_INTERNET_DISCONNECTED' ? '📡' : '🗺'}</div>
      <h1>{e.title}</h1>
      <p>{e.text(host || '')}</p>
      <ul>{e.tips.map((t) => <li key={t}>{t}</li>)}</ul>
      {ip && <p className="bp-muted">IP-адрес сервера: {ip}</p>}
      <p className="bp-code">{code}</p>
      <div className="bp-error-actions">
        <button className="bp-btn bp-btn-primary" onClick={onReload}>Перезагрузить</button>
        {host && <button className="bp-btn" onClick={() => ctx.navigate(searchUrl(host))}>Искать «{host}»</button>}
        {!game && <button className="bp-btn" onClick={() => setGame(true)}>Сыграть в «Курьера»</button>}
      </div>
      {game && <CourierGame />}
    </div>
  );
}

export function MaintenancePage({ onReload }) {
  return (
    <div className="bp-page bp-error">
      <div className="bp-error-icon" aria-hidden>🛠</div>
      <h1>БалНет на обслуживании</h1>
      <p>Игровое время Балесноландии на паузе. Пока часы стоят, сайты БалНета не открываются.</p>
      <p className="bp-code">ERR_BALNET_MAINTENANCE</p>
      <div className="bp-error-actions"><button className="bp-btn bp-btn-primary" onClick={onReload}>Проверить снова</button></div>
      <CourierGame />
    </div>
  );
}

export function GamePage() {
  return (
    <div className="bp-page bp-error">
      <h1>Курьер БалНета</h1>
      <CourierGame />
    </div>
  );
}

/** Настройки → Сеть: провайдер, полученный адрес, DNS-сервер. */
function NetworkSettings({ ctx }) {
  const net = ctx.net;
  const [list, setList] = useState(null);
  const [info, setInfo] = useState(null);
  const [error, setError] = useState('');
  const [custom, setCustom] = useState(net.dns || '');
  useEffect(() => { providers().then(setList).catch(() => setError('Нет связи с сервером БалНета')); }, []);
  useEffect(() => {
    let alive = true;
    setInfo(null);
    lease(net.clientId, net.provider).then((l) => { if (alive) { setInfo(l); setError(''); } }).catch((e) => { if (alive) setError(e.message); });
    return () => { alive = false; };
  }, [net.clientId, net.provider]);
  return (
    <section className="bp-card">
      <h2>Сеть</h2>
      <label className="bp-field">
        <span>Интернет-провайдер</span>
        <select value={net.provider} onChange={(e) => ctx.setNet({ provider: e.target.value })}>
          {(list?.providers || [{ code: net.provider, name: net.provider }]).map((p) => <option key={p.code} value={p.code}>{p.name}</option>)}
        </select>
      </label>
      {info && (
        <dl className="bp-dl">
          <dt>IP-адрес</dt><dd className="mono">{info.ip}</dd>
          <dt>Сеть</dt><dd className="mono">{info.netmask}</dd>
          <dt>Шлюз</dt><dd className="mono">{info.gateway}</dd>
          <dt>DNS провайдера</dt><dd className="mono">{info.resolver_ip}</dd>
        </dl>
      )}
      {error && <p className="bp-err">{error}</p>}
      <h3>DNS-сервер</h3>
      <label className="bp-check"><input type="radio" name="dns" checked={net.dnsMode === 'provider'} onChange={() => ctx.setNet({ dnsMode: 'provider' })} /> DNS провайдера{info ? ` (${info.resolver_ip})` : ''}</label>
      <label className="bp-check"><input type="radio" name="dns" checked={net.dnsMode === 'public'} onChange={() => ctx.setNet({ dnsMode: 'public' })} /> ВлодDNS — публичный резолвер ({PUBLIC_DNS})</label>
      <label className="bp-check"><input type="radio" name="dns" checked={net.dnsMode === 'custom'} onChange={() => ctx.setNet({ dnsMode: 'custom' })} /> Свой DNS-сервер:</label>
      {net.dnsMode === 'custom' && (
        <form className="bp-inline-form" onSubmit={(e) => { e.preventDefault(); if (isIP(custom.trim())) ctx.setNet({ dns: custom.trim() }); }}>
          <input value={custom} onChange={(e) => setCustom(e.target.value)} placeholder="например 60.1.0.53" aria-label="Адрес DNS-сервера" className="mono" />
          <button className="bp-btn" disabled={!isIP(custom.trim())}>Сохранить</button>
        </form>
      )}
      {net.dnsMode === 'custom' && net.dns && <p className="bp-muted">Сейчас: {net.dns}. Резолвер провайдера отвечает только своим абонентам; неверный адрес — сайты не откроются.</p>}
      <p className="bp-muted">Новые настройки действуют для следующих переходов. Открытые вкладки обновите кнопкой ↻.</p>
    </section>
  );
}
