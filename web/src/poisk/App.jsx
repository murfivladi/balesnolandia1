// ВлодПоиск (poisk.bln) — государственная поисковая система БалНета: выдача и вертикали (веб, картинки, новости,
// товары), подсказки и тренды, кабинет вебмастера, рекламный кабинет, справка о том, как работает поиск.
import { useEffect, useRef, useState } from 'react';
import { get, post, patch, del, apiBase, appUrl } from '../shared/api.js';
import { useLang } from '../shared/i18n.js';
import { useRoute, pick, navigate } from '../shared/router.js';
import {
  Topbar, NavLink, Spinner, useAsync, Empty, ErrorBox, Money, Badge, Button, ActionButton, Input, Field, useToast, MoneyInput, Tabs,
} from '../shared/ui.jsx';
import { PoiskLogo } from '../shared/brand.jsx';
import { SiteFooter, Section, Features, RequireGov, useGovUser } from '../shared/site.jsx';
import { formatMoney } from '@bln/shared/money.js';

const TABS = [['web', 'Всё'], ['images', 'Картинки'], ['news', 'Новости'], ['products', 'Товары']];
const STATUS = {
  indexed: ['ok', 'в индексе'], queued: ['', 'в очереди'], excluded: ['warn', 'исключена'], error: ['err', 'ошибка'], redirect: ['', 'переадресация'], gone: ['err', 'не найдена'],
};

/** Игровые секунды → «день 12, месяц 3». */
const gameDate = (sec) => { const s = Number(sec) || 0; return `день ${Math.floor((s % 2592000) / 86400) + 1}, месяц ${Math.floor(s / 2592000)}`; };
const gameDay = (d) => `д. ${(d % 30) + 1} м. ${Math.floor(d / 30)}`;

/** Открыть адрес БалНета во вкладке ВлодБраузера (госсайт работает во фрейме браузера). */
export function openInBrowser(url, newTab = false) {
  try {
    if (typeof window.__balnetOpen === 'function') { window.__balnetOpen(url, newTab); return; }
  } catch { /* не во ВлодБраузере */ }
  window.open(`../#${url}`, '_top');
}

export function Word({ size }) {
  return <span className="vp-word" style={size ? { fontSize: size } : undefined}><span className="a">Влод</span><span className="b">Поиск</span></span>;
}

function Fav({ host }) {
  const h = String(host || '?');
  let hue = 0;
  for (const ch of h) hue = (hue * 31 + ch.charCodeAt(0)) % 360;
  return <span className="vp-fav" style={{ background: `hsl(${hue} 55% 45%)` }} aria-hidden>{h[0].toUpperCase()}</span>;
}

export default function App() {
  useLang();
  const route = useRoute();
  const me = useGovUser();
  const serp = route.path === '/' && route.query.q;
  const nav = (
    <>
      <NavLink href="#/" path={route.path}>Поиск</NavLink>
      <NavLink href="#/trends" path={route.path}>Тренды</NavLink>
      <NavLink href="#/webmaster" path={route.path}>Вебмастерам</NavLink>
      <NavLink href="#/ads" path={route.path}>Реклама</NavLink>
      <NavLink href="#/about" path={route.path}>Как работает поиск</NavLink>
    </>
  );
  const right = me ? <a className="tb-btn" href="#/webmaster">{me.display_name || 'Кабинет'}</a> : <a className="tb-btn" href="#/webmaster">Войти</a>;
  const gate = (render) => <RequireGov app="poisk" siteName="poisk.bln">{render}</RequireGov>;
  return (
    <>
      {!serp && <Topbar variant="site" brand={<><PoiskLogo /> <Word /></>} nav={nav} right={right} />}
      <main style={{ flex: 1 }}>
        {pick([
          ['/', () => (serp ? <Serp q={route.query.q} tab={route.query.tab || 'web'} p={Number(route.query.p) || 1} /> : <Home />)],
          ['/trends', () => <Trends />],
          ['/webmaster', () => gate(() => <Webmaster />)],
          ['/webmaster/:id', (p) => gate(() => <WmSite id={p.id} tab={route.query.tab || 'overview'} />)],
          ['/ads', () => <AdsLanding me={me} />],
          ['/ads/cabinet', () => gate(() => <AdsCabinet />)],
          ['/ads/:id', (p) => gate(() => <Campaign id={p.id} />)],
          ['/about', () => <About />],
          ['*', () => <Empty>Страница не найдена</Empty>],
        ], route.path)}
      </main>
      <SiteFooter
        brand="ВлодПоиск"
        about="Государственная поисковая система БалНета. Робот VlodBot обходит сайты по ссылкам, учитывает robots.txt и sitemap; результаты ранжируются по тексту, ссылкам (PageRank) и свежести."
        columns={[
          { title: 'Поиск', links: [{ href: '#/', label: 'Главная' }, { href: '#/trends', label: 'Тренды' }, { href: '#/about', label: 'Как работает поиск' }] },
          { title: 'Бизнесу', links: [{ href: '#/webmaster', label: 'Вебмастерам' }, { href: '#/ads', label: 'Реклама' }, { href: '#/about#safe', label: 'Безопасный просмотр' }] },
          { title: 'Сервисы БалНета', links: [{ href: '../reg/#/', label: 'БалРег — домены' }, { href: '../hosting/#/', label: 'БалХост — хостинг' }, { href: '../ca/#/', label: 'БалСерт' }] },
        ]}
      />
    </>
  );
}

// ——— Строка поиска с подсказками ———

function SearchBox({ initial = '', tab = 'web', autoFocus }) {
  const [text, setText] = useState(initial);
  const [sugg, setSugg] = useState([]);
  const [open, setOpen] = useState(false);
  const [sel, setSel] = useState(-1);
  const timer = useRef(null);
  useEffect(() => { setText(initial); }, [initial]);
  const go = (q) => {
    const v = String(q || '').trim();
    setOpen(false);
    if (v) navigate(`/?q=${encodeURIComponent(v)}${tab !== 'web' ? `&tab=${tab}` : ''}`);
  };
  const onChange = (v) => {
    setText(v);
    setSel(-1);
    clearTimeout(timer.current);
    if (!v.trim()) { setSugg([]); return; }
    timer.current = setTimeout(() => {
      get(`/search/suggest?q=${encodeURIComponent(v)}`).then((r) => { setSugg(r.suggestions); setOpen(true); }).catch(() => {});
    }, 150);
  };
  const onKey = (e) => {
    if (!open || !sugg.length) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(sugg.length - 1, s + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(-1, s - 1)); }
    else if (e.key === 'Escape') setOpen(false);
  };
  return (
    <div className="vp-box">
      <form role="search" onSubmit={(e) => { e.preventDefault(); go(sel >= 0 ? sugg[sel] : text); }}>
        <input
          value={text} onChange={(e) => onChange(e.target.value)} onKeyDown={onKey} onFocus={() => sugg.length && setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)} placeholder="Найдётся всё в БалНете" aria-label="Запрос" autoFocus={autoFocus} autoComplete="off"
        />
        <Button type="submit">Найти</Button>
      </form>
      {open && sugg.length > 0 && (
        <ul className="vp-sugg" role="listbox">
          {sugg.map((s, i) => <li key={s} className={i === sel ? 'is-sel' : ''}><button type="button" onMouseDown={() => go(s)}>🔍 {s}</button></li>)}
        </ul>
      )}
    </div>
  );
}

// ——— Главная ———

function Home() {
  const tr = useAsync(() => get('/search/trends'), []);
  const stats = useAsync(() => get('/search/stats'), []);
  return (
    <>
      <div className="vp-home">
        <Word />
        <SearchBox autoFocus />
        {!!tr.data?.trends.length && (
          <div className="vp-chips" aria-label="Сейчас ищут">
            <span className="muted small">Сейчас ищут:</span>
            {tr.data.trends.slice(0, 8).map((t) => <button key={t.q} className="vp-chip" onClick={() => navigate(`/?q=${encodeURIComponent(t.q)}`)}>{t.q}</button>)}
          </div>
        )}
        {stats.data && <p className="muted small">В индексе {stats.data.docs} страниц с {stats.data.hosts} сайтов БалНета</p>}
      </div>
      <Section muted title="ВлодПоиск для сайтов">
        <Features items={[
          { icon: '🕷', title: 'Робот VlodBot', text: 'Обходит БалНет по ссылкам и картам сайта, соблюдает robots.txt. Новые сайты хостинга находит сам.' },
          { icon: '🛠', title: 'Вебмастерам', text: 'Подтвердите права записью TXT — увидите индексацию, ошибки, запросы и сможете попросить переобход.' },
          { icon: '📣', title: 'Реклама', text: 'Объявления над выдачей по ключевым словам. Платите только за клики, сами задаёте ставку и бюджет.' },
          { icon: '🛡', title: 'Безопасный просмотр', text: 'Список фишинговых сайтов, по которому ВлодБраузер предупреждает об опасности.' },
        ]} />
      </Section>
    </>
  );
}

// ——— Выдача ———

function Snippet({ parts }) {
  return <p>{(parts || []).map((s, i) => (s.b ? <b key={i} className="hl">{s.t}</b> : <span key={i}>{s.t}</span>))}</p>;
}

function Serp({ q, tab, p }) {
  const res = useAsync(() => get(`/search/search?q=${encodeURIComponent(q)}&tab=${tab}&p=${p}`), [q, tab, p]);
  useEffect(() => { document.title = `${q} — ВлодПоиск`; }, [q]);
  const openResult = (r) => {
    post('/search/click', { q, url: r.url }).catch(() => {});
    openInBrowser(r.url);
  };
  const openAd = async (ad) => {
    try { const r = await post('/search/ads/click', { token: ad.token }); openInBrowser(r.url); } catch { openInBrowser(ad.url); }
  };
  // Пока грузится новая вертикаль, старые данные не рисуем в чужом виде.
  const d = res.data?.tab === tab ? res.data : null;
  const tabHref = (t) => `#/?q=${encodeURIComponent(q)}${t !== 'web' ? `&tab=${t}` : ''}`;
  return (
    <>
      <header className="vp-serp-head">
        <a href="#/" aria-label="ВлодПоиск — главная" style={{ textDecoration: 'none' }}><Word size="1.6rem" /></a>
        <SearchBox key={q} initial={q} tab={tab} />
      </header>
      <nav className="vp-tabs" aria-label="Вертикали">
        {TABS.map(([t, label]) => <a key={t} href={tabHref(t)} className={t === tab ? 'is-on' : ''}>{label}</a>)}
      </nav>
      {!d ? (res.error ? <div className="vp-serp"><ErrorBox error={res.error} /></div> : <Spinner />) : d.tab === 'images' ? (
        <>
          <div className="vp-serp" style={{ paddingBottom: 0 }}><p className="vp-meta">Картинок: {d.total}</p></div>
          {!d.results.length ? <div className="vp-serp"><p>Картинок по запросу «{q}» не найдено.</p></div> : (
            <div className="vp-imgs">
              {d.results.map((r) => (
                <figure key={r.id} onClick={() => openResult({ url: r.page_url })} title={r.page_title}>
                  <img src={`${apiBase()}/api/search/img/${r.id}`} alt={r.alt} loading="lazy" />
                  <figcaption>{r.alt || r.page_title}</figcaption>
                  <figcaption>{r.host}</figcaption>
                </figure>
              ))}
            </div>
          )}
        </>
      ) : d.tab === 'products' ? (
        <>
          <div className="vp-serp" style={{ paddingBottom: 0 }}><p className="vp-meta">Товаров в Кассах: {d.total}. Цены магазинов на сегодня.</p></div>
          {!d.results.length ? <div className="vp-serp"><p>Товаров по запросу «{q}» не найдено.</p></div> : (
            <div className="vp-products">
              {d.results.map((r) => (
                <div key={r.id} className="card stack-sm">
                  {r.has_photo ? <img src={`${apiBase()}/api/search/product-photo/${r.id}`} alt="" loading="lazy" /> : null}
                  <b>{r.name}</b>
                  <span className="price"><Money value={r.price} />{r.unit === 'kg' ? ' / кг' : ''}</span>
                  <span className="small muted">{r.shop}{r.address ? `, ${r.address}` : ''}</span>
                  {r.category && <Badge>{r.category}</Badge>}
                </div>
              ))}
            </div>
          )}
        </>
      ) : (
        <div className="vp-serp">
          <p className="vp-meta">Результатов: {d.total}{d.ms !== undefined ? ` (${(d.ms / 1000).toFixed(2)} сек.)` : ''}</p>
          {d.suggestion && <p>Возможно, вы искали: <a href={`#/?q=${encodeURIComponent(d.suggestion)}`}><b><i>{d.suggestion}</i></b></a></p>}
          {d.partial && <p className="small muted">Не найдено страниц со всеми словами запроса — показаны результаты с частью слов.</p>}
          {!!d.ads?.length && (
            <div className="vp-ads">
              {d.ads.map((a) => (
                <article key={a.token} className="vp-res">
                  <div className="vp-url"><span className="vp-ad-label">Реклама</span> · {a.display}</div>
                  <button className="vp-title" onClick={() => openAd(a)}>{a.title}</button>
                  <p>{a.text}</p>
                </article>
              ))}
            </div>
          )}
          {d.results.map((r) => (
            <article key={r.url} className="vp-res">
              <div className="vp-url"><Fav host={r.host} /> {r.display}{r.date ? <span> · {gameDate(r.date)}</span> : null}{r.kind === 'gov' && <Badge kind="ok">госсайт</Badge>}</div>
              <button className="vp-title" onClick={() => openResult(r)}>{r.title}</button>
              <Snippet parts={r.snippet} />
            </article>
          ))}
          {!d.results.length && (
            <div>
              <p>По запросу <b>«{q}»</b> ничего не найдено.</p>
              <ul className="small"><li>Проверьте, нет ли опечаток.</li><li>Попробуйте другие или более общие слова.</li><li>Новые сайты появляются в поиске после обхода роботом.</li></ul>
            </div>
          )}
          {d.pages > 1 && (
            <nav className="vp-pager" aria-label="Страницы">
              {Array.from({ length: Math.min(10, d.pages) }, (_, i) => i + 1).map((n) => (
                <a key={n} className={`btn sm ${n === p ? '' : 'secondary'}`} href={`${tabHref(tab)}&p=${n}`}>{n}</a>
              ))}
            </nav>
          )}
        </div>
      )}
    </>
  );
}

// ——— Тренды ———

function Trends() {
  const tr = useAsync(() => get('/search/trends'), []);
  const max = Math.max(1, ...(tr.data?.trends || []).map((t) => t.today));
  return (
    <div className="page narrow">
      <h1>Тренды</h1>
      <p className="muted">Что ищут в БалНете за последние игровые сутки и насколько чаще, чем в среднем за неделю. Учитываются запросы, которые задавали хотя бы два разных человека.</p>
      {!tr.data ? <Spinner /> : !tr.data.trends.length ? <Empty>Пока мало запросов.</Empty> : (
        <div className="card stack">
          {tr.data.trends.map((t, i) => (
            <div key={t.q} className="stack-sm">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <a href={`#/?q=${encodeURIComponent(t.q)}`}>{i + 1}. {t.q}</a>
                <span className="small muted">{t.today} запр.{t.growth === null ? ' · новое' : ` · ${t.growth > 0 ? '+' : ''}${t.growth}%`}</span>
              </div>
              <div className="vp-bar" style={{ width: `${(t.today / max) * 100}%` }} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ——— Вебмастер ———

function Webmaster() {
  const list = useAsync(() => get('/search/webmaster/sites'), []);
  const [host, setHost] = useState('');
  const toast = useToast();
  const add = async (h) => {
    try { const r = await post('/search/webmaster/sites', { host: h }); navigate(`/webmaster/${r.id}`); } catch (e) { toast(e.message, 'err'); }
  };
  const d = list.data;
  const suggestions = (d?.hosting || []).filter((h) => !d.sites.some((s) => s.host === h));
  return (
    <div className="page">
      <h1>ВлодПоиск для вебмастеров</h1>
      <p className="muted">Добавьте сайт и подтвердите, что он ваш. После этого видно, какие страницы в поиске, почему другие исключены, по каким запросам вас находят и кто на вас ссылается.</p>
      {!d ? (list.error ? <ErrorBox error={list.error} /> : <Spinner />) : (
        <>
          {d.sites.length > 0 && (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>Сайт</th><th>Права</th><th>В поиске</th><th>Рекламная сеть</th></tr></thead>
                <tbody>
                  {d.sites.map((s) => (
                    <tr key={s.id}>
                      <td><a href={`#/webmaster/${s.id}`} className="mono">{s.host}</a></td>
                      <td>{s.verified ? <Badge kind="ok">подтверждены</Badge> : <Badge kind="warn">не подтверждены</Badge>}</td>
                      <td>{s.verified ? s.indexed : '—'}</td>
                      <td>{s.adnet ? 'включена' : '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <form className="card row" style={{ marginTop: 16 }} onSubmit={(e) => { e.preventDefault(); add(host); }}>
            <input className="input mono" style={{ flex: 1, minWidth: 180 }} placeholder="shop.bln" value={host} onChange={(e) => setHost(e.target.value)} aria-label="Имя сайта" />
            <Button type="submit">Добавить сайт</Button>
          </form>
          {suggestions.length > 0 && (
            <p className="small">Ваши сайты на хостинге: {suggestions.map((h) => <button key={h} className="vp-chip" onClick={() => add(h)}>+ {h}</button>)}</p>
          )}
        </>
      )}
    </div>
  );
}

const WM_TABS = [
  { value: 'overview', label: 'Сводка' }, { value: 'pages', label: 'Страницы' }, { value: 'queries', label: 'Запросы' }, { value: 'links', label: 'Ссылки' },
  { value: 'tools', label: 'Инструменты' }, { value: 'security', label: 'Безопасность' }, { value: 'adnet', label: 'Рекламная сеть' },
];

function WmSite({ id, tab }) {
  const [v, setV] = useState(0);
  const site = useAsync(() => get(`/search/webmaster/sites/${id}`), [id, v]);
  const reload = () => setV((x) => x + 1);
  const s = site.data?.site;
  if (!s) return <div className="page">{site.error ? <ErrorBox error={site.error} /> : <Spinner />}</div>;
  return (
    <div className="page">
      <p className="small"><a href="#/webmaster">← Мои сайты</a></p>
      <h1 className="mono">{s.host}</h1>
      {!s.verified ? <Verify s={s} onDone={reload} /> : (
        <>
          <Tabs tabs={WM_TABS} value={tab} onChange={(t) => navigate(`/webmaster/${id}?tab=${t}`)} />
          {tab === 'overview' && <WmOverview s={s} />}
          {tab === 'pages' && <WmPages s={s} />}
          {tab === 'queries' && <WmQueries s={s} />}
          {tab === 'links' && <WmLinks s={s} />}
          {tab === 'tools' && <WmTools s={s} onDone={reload} />}
          {tab === 'security' && <WmSecurity s={s} onDone={reload} />}
          {tab === 'adnet' && <WmAdnet s={s} onDone={reload} />}
        </>
      )}
    </div>
  );
}

function Verify({ s, onDone }) {
  const [res, setRes] = useState(null);
  const toast = useToast();
  const check = async (method) => {
    try {
      const r = await post(`/search/webmaster/sites/${s.id}/verify`, { method });
      setRes(r);
      if (r.ok) { toast('Права подтверждены', 'ok'); onDone(); }
    } catch (e) { toast(e.message, 'err'); }
  };
  const i = s.instructions;
  return (
    <div className="stack">
      <p>Подтвердите, что вы владелец сайта, одним из способов. Права проверяются и дальше — не удаляйте запись или файл.</p>
      <div className="grid grid-auto">
        <div className="card stack-sm">
          <h3>Запись TXT в DNS</h3>
          <p className="small">На <a href="../reg/#/domains">БалРеге</a> добавьте домену запись:</p>
          <dl className="kv small"><dt>Имя</dt><dd className="mono">@ ({i.dns.record})</dd><dt>Тип</dt><dd>TXT</dd><dt>Значение</dt><dd className="mono">{i.dns.value}</dd></dl>
          <ActionButton action={() => check('dns')}>Проверить TXT</ActionButton>
        </div>
        <div className="card stack-sm">
          <h3>HTML-файл</h3>
          <p className="small">В файловом менеджере <a href="../hosting/#/">БалХоста</a> создайте в корне сайта файл:</p>
          <dl className="kv small"><dt>Адрес</dt><dd className="mono">{i.file.url}</dd><dt>Содержимое</dt><dd className="mono">{i.file.content}</dd></dl>
          <ActionButton action={() => check('file')}>Проверить файл</ActionButton>
        </div>
      </div>
      {res && !res.ok && <p className="err-text">✖ {res.error}</p>}
    </div>
  );
}

function Stat({ label, value }) {
  return <div className="card"><div className="small muted">{label}</div><div style={{ fontSize: '1.6rem', fontWeight: 700 }}>{value}</div></div>;
}

function WmOverview({ s }) {
  const imps = s.daily.reduce((a, d) => a + d.impressions, 0);
  const clicks = s.daily.reduce((a, d) => a + d.clicks, 0);
  const max = Math.max(1, ...s.daily.map((d) => d.impressions));
  return (
    <div className="stack">
      <div className="grid grid-4">
        <Stat label="В поиске" value={s.counts.indexed || 0} />
        <Stat label="Исключено" value={(s.counts.excluded || 0) + (s.counts.redirect || 0) + (s.counts.gone || 0)} />
        <Stat label="Ошибки" value={s.counts.error || 0} />
        <Stat label="Показы / клики за 14 сут." value={`${imps} / ${clicks}`} />
      </div>
      {s.security.length > 0 && <div className="form-warn">⚠ ВлодПоиск считает сайт опасным: <a href={`#/webmaster/${s.id}?tab=security`}>подробнее</a>.</div>}
      <div className="card">
        <h3>Показы в поиске по дням</h3>
        {!s.daily.length ? <p className="muted">Сайт ещё не показывался в выдаче.</p> : (
          <div className="stack-sm">
            {s.daily.map((d) => (
              <div key={d.day} className="row nowrap small"><span style={{ width: 90 }}>{gameDay(d.day)}</span><div className="vp-bar" style={{ width: `${(d.impressions / max) * 70}%` }} /><span>{d.impressions} / {d.clicks}</span></div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function WmPages({ s }) {
  const [f, setF] = useState('all');
  const list = s.pages.filter((p) => f === 'all' || p.status === f);
  return (
    <div className="stack">
      <div className="row">
        {['all', 'indexed', 'excluded', 'error', 'redirect', 'gone', 'queued'].map((k) => (
          <button key={k} className={`vp-chip${f === k ? ' is-on' : ''}`} style={f === k ? { borderColor: 'var(--accent)', color: 'var(--accent)' } : undefined} onClick={() => setF(k)}>
            {k === 'all' ? `Все (${s.pages.length})` : `${STATUS[k][1]} (${s.counts[k] || 0})`}
          </button>
        ))}
      </div>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Адрес</th><th>Статус</th><th>Причина</th><th>Обход</th><th>PR</th></tr></thead>
          <tbody>
            {list.map((p) => (
              <tr key={p.id}>
                <td className="mono small" style={{ overflowWrap: 'anywhere' }}>{p.url}{p.title ? <div className="muted">{p.title}</div> : null}</td>
                <td><Badge kind={STATUS[p.status][0]}>{STATUS[p.status][1]}</Badge></td>
                <td className="small">{p.reason || (p.http_status ? `HTTP ${p.http_status}` : '—')}</td>
                <td className="small">{p.fetched_at ? gameDate(p.fetched_at) : 'ещё не был'}</td>
                <td className="small">{p.pagerank}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function WmQueries({ s }) {
  if (!s.queries.length) return <Empty>По каким запросам вас находят, будет видно после первых показов в выдаче.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table">
        <thead><tr><th>Запрос</th><th>Показы</th><th>Клики</th><th>CTR</th><th>Средняя позиция</th></tr></thead>
        <tbody>
          {s.queries.map((x) => (
            <tr key={x.q}><td><a href={`#/?q=${encodeURIComponent(x.q)}`}>{x.q}</a></td><td>{x.impressions}</td><td>{x.clicks}</td><td>{x.ctr}%</td><td>{x.position ?? '—'}</td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function WmLinks({ s }) {
  if (!s.links.length) return <Empty>На сайт пока никто не ссылается. Внешние ссылки поднимают PageRank страниц.</Empty>;
  return (
    <div className="table-wrap">
      <table className="table"><thead><tr><th>Сайт</th><th>Ссылок</th></tr></thead>
        <tbody>{s.links.map((l) => <tr key={l.host}><td className="mono">{l.host}</td><td>{l.n}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

function WmTools({ s, onDone }) {
  const [url, setUrl] = useState(`http://${s.host}/`);
  const [ins, setIns] = useState(null);
  const [sm, setSm] = useState(`http://${s.host}/sitemap.xml`);
  const toast = useToast();
  const run = async (fn) => { try { return await fn(); } catch (e) { toast(e.message, 'err'); return null; } };
  return (
    <div className="stack">
      <div className="card stack-sm">
        <h3>Проверка адреса</h3>
        <p className="small muted">Робот откроет страницу прямо сейчас и покажет, что видит, и что о ней знает индекс.</p>
        <div className="row"><input className="input mono" style={{ flex: 1, minWidth: 200 }} value={url} onChange={(e) => setUrl(e.target.value)} aria-label="Адрес страницы" /></div>
        <div className="row">
          <ActionButton action={async () => setIns(await post(`/search/webmaster/sites/${s.id}/inspect`, { url }))}>Проверить</ActionButton>
          <Button kind="secondary" onClick={() => run(async () => { const r = await post(`/search/webmaster/sites/${s.id}/recrawl`, { url }); toast(`Адрес поставлен в очередь робота. Осталось на сегодня: ${r.left}`, 'ok'); onDone(); })}>
            Переобойти ({s.recrawl.limit - s.recrawl.used} из {s.recrawl.limit})
          </Button>
        </div>
        {ins && (
          <dl className="kv small">
            <dt>robots.txt</dt><dd>{ins.robots.allowed ? <span className="ok-text">разрешено</span> : <span className="err-text">запрещено ({ins.robots.rule})</span>}</dd>
            <dt>Ответ сервера</dt><dd>{ins.live.error ? <span className="err-text">{ins.live.error}{ins.live.note ? ` — ${ins.live.note}` : ''}</span> : `HTTP ${ins.live.status}${ins.live.type ? `, ${ins.live.type.split(';')[0]}` : ''}${ins.live.location ? ` → ${ins.live.location}` : ''}`}</dd>
            {ins.live.ip && <><dt>IP сервера</dt><dd className="mono">{ins.live.ip}</dd></>}
            {ins.live.doc && <><dt>Заголовок</dt><dd>{ins.live.doc.title || '—'}</dd><dt>Мета robots</dt><dd>{ins.live.doc.noindex ? 'noindex ' : ''}{ins.live.doc.nofollow ? 'nofollow' : ''}{!ins.live.doc.noindex && !ins.live.doc.nofollow ? 'нет запретов' : ''}</dd><dt>Ссылок / картинок</dt><dd>{ins.live.doc.links} / {ins.live.doc.images}</dd>{ins.live.doc.canonical && <><dt>Канонический</dt><dd className="mono">{ins.live.doc.canonical}</dd></>}</>}
            <dt>В индексе</dt><dd>{ins.index ? <><Badge kind={STATUS[ins.index.status][0]}>{STATUS[ins.index.status][1]}</Badge> {ins.index.reason || ''} {ins.index.fetched_at ? `· обход: ${gameDate(ins.index.fetched_at)}` : ''}</> : 'робот этот адрес ещё не видел'}</dd>
          </dl>
        )}
      </div>
      <div className="card stack-sm">
        <h3>robots.txt</h3>
        {!s.robots ? <p className="muted small">Робот ещё не читал robots.txt (или файл сбросили для переобхода).</p> : s.robots.status === 200 ? <pre className="mono small" style={{ whiteSpace: 'pre-wrap', margin: 0 }}>{s.robots.body || '(пусто)'}</pre> : <p className="small">Ответ {s.robots.status || 'нет ответа'} — {s.robots.status >= 400 && s.robots.status < 500 ? 'файла нет, роботу можно всё' : 'робот временно не обходит сайт'}.</p>}
      </div>
      <div className="card stack-sm">
        <h3>Файлы Sitemap</h3>
        {s.sitemaps.length ? <ul className="mono small">{s.sitemaps.map((x) => <li key={x}>{x}</li>)}</ul> : <p className="small muted">Робот сам смотрит /sitemap.xml и строки Sitemap: в robots.txt.</p>}
        <div className="row">
          <input className="input mono" style={{ flex: 1, minWidth: 200 }} value={sm} onChange={(e) => setSm(e.target.value)} aria-label="Адрес sitemap" />
          <ActionButton action={async () => { await post(`/search/webmaster/sites/${s.id}/sitemaps`, { url: sm }); onDone(); }} okMessage="Sitemap добавлен">Добавить</ActionButton>
        </div>
      </div>
      <div className="row"><ActionButton kind="danger" confirm="Удалить сайт из кабинета?" action={async () => { await del(`/search/webmaster/sites/${s.id}`); navigate('/webmaster'); }}>Удалить сайт из кабинета</ActionButton></div>
    </div>
  );
}

function WmSecurity({ s, onDone }) {
  if (!s.security.length) return <div className="card"><p className="ok-text">✔ Проблем безопасности не найдено. ВлодБраузер открывает сайт без предупреждений.</p></div>;
  return (
    <div className="card stack-sm">
      <h3 className="err-text">Сайт в списке Безопасного просмотра</h3>
      <p>Посетители ВлодБраузера видят красную страницу «Опасный сайт», сайт не показывается в поиске и рекламе.</p>
      <ul>{s.security.map((x) => <li key={x.id}><span className="mono">{x.expr}</span> — {x.threat === 'phishing' ? 'фишинг (выдаёт себя за другой сайт, просит пароль)' : x.threat === 'malware' ? 'вредоносное ПО' : 'нежелательное ПО'}{x.note ? <div className="small muted">{x.note}</div> : null}</li>)}</ul>
      <p className="small">Уберите опасное содержимое и попросите проверку — её выполнит администрация БалНета.</p>
      {s.review_requested ? <Badge kind="warn">проверка запрошена</Badge> : <ActionButton action={async () => { await post(`/search/webmaster/sites/${s.id}/review`); onDone(); }} okMessage="Запрос отправлен">Я всё исправил — проверьте</ActionButton>}
    </div>
  );
}

function WmAdnet({ s, onDone }) {
  const a = s.adnet_stats;
  return (
    <div className="stack">
      <div className="card stack-sm">
        <h3>Рекламная сеть ВлодПоиска</h3>
        <p>Объявления рекламодателей на вашем сайте подбираются по его содержимому. Вы получаете <b>{a.share_bp / 100}%</b> от стоимости каждого клика; выплата — раз в игровой месяц на счёт во ВлодБанке.</p>
        <label className="row"><input type="checkbox" checked={s.adnet} onChange={async (e) => { await patch(`/search/webmaster/sites/${s.id}`, { adnet: e.target.checked }); onDone(); }} /> Показывать рекламу на сайте</label>
        <p className="small">Вставьте этот код в HTML страницы там, где должен быть рекламный блок:</p>
        <pre className="mono small" style={{ whiteSpace: 'pre-wrap', margin: 0, background: 'var(--surface-2)', padding: 10, borderRadius: 8 }}>{s.snippet}</pre>
      </div>
      <div className="grid grid-4">
        <Stat label="Показы" value={a.impressions} />
        <Stat label="Клики" value={a.clicks} />
        <Stat label="К выплате" value={formatMoney(a.earned_unpaid)} />
        <Stat label="Заработано всего" value={formatMoney(a.earned_total)} />
      </div>
    </div>
  );
}

// ——— Реклама ———

function AdsLanding({ me }) {
  return (
    <div className="page narrow stack">
      <h1>Реклама во ВлодПоиске</h1>
      <p>Ваше объявление — над результатами поиска по нужным словам и на сайтах рекламной сети. Оплата только за клики.</p>
      <ol className="steps">
        <li><b>Пополните баланс</b> — квитанцией во ВлодБанке.</li>
        <li><b>Создайте кампанию</b> — заголовок, текст, ссылка, ключевые слова, ставка за клик и дневной бюджет.</li>
        <li><b>Аукцион</b> — при каждом поиске объявления ранжируются по ставке × качеству (CTR). Платите не свою ставку, а минимум, нужный, чтобы обойти следующего (аукцион второй цены).</li>
      </ol>
      <p className="small muted">Ключевое слово срабатывает, если все его слова есть в запросе (в любой форме: «хлеб» найдёт «хлеба»). Минус-слова отключают показ. Повторный клик того же человека за сутки не оплачивается.</p>
      <div><a className="btn" href="#/ads/cabinet">{me ? 'Рекламный кабинет' : 'Войти и начать'}</a></div>
    </div>
  );
}

const CAMP_KIND = { active: 'ok', paused: '', rejected: 'err' };

function CampaignForm({ initial, onSave, submitLabel }) {
  const [f, setF] = useState(() => ({
    name: '', title: '', text: '', url: '', keywords: '', negatives: '', bid: 100, daily_budget: 1000, network: true,
    ...initial, ...(initial ? { keywords: initial.keywords.join('\n'), negatives: initial.negatives.join('\n') } : {}),
  }));
  const [fc, setFc] = useState(null);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e }));
  const firstKw = f.keywords.split('\n')[0]?.trim();
  useEffect(() => {
    if (!firstKw) { setFc(null); return undefined; }
    const t = setTimeout(() => get(`/search/ads/forecast?q=${encodeURIComponent(firstKw)}`).then(setFc).catch(() => {}), 300);
    return () => clearTimeout(t);
  }, [firstKw]);
  return (
    <form className="stack" onSubmit={(e) => { e.preventDefault(); onSave({ ...f, keywords: f.keywords.split('\n'), negatives: f.negatives.split('\n') }); }}>
      <Input label="Название кампании" value={f.name} onChange={set('name')} required />
      <div className="vp-res card" style={{ marginBottom: 0 }} aria-label="Предпросмотр">
        <div className="vp-url"><span className="vp-ad-label">Реклама</span> · {(f.url || 'ваш-сайт.bln').replace(/^https?:\/\//, '')}</div>
        <span className="vp-title">{f.title || 'Заголовок объявления'}</span>
        <p>{f.text || 'Текст объявления'}</p>
      </div>
      <Input label={`Заголовок (${f.title.length}/56)`} value={f.title} maxLength={56} onChange={set('title')} required />
      <Input label={`Текст (${f.text.length}/140)`} value={f.text} maxLength={140} onChange={set('text')} required />
      <Input label="Ссылка" value={f.url} onChange={set('url')} placeholder="https://shop.bln/" required />
      <Field label="Ключевые слова" hint="По одному на строке: «купить хлеб», «пирожки»">
        <textarea className="input" rows={4} value={f.keywords} onChange={set('keywords')} />
      </Field>
      {fc && <p className="small muted">По «{firstKw}»: искали {fc.searches} раз, конкурентов — {fc.competitors}{fc.top_bid ? `, высшая ставка ${formatMoney(fc.top_bid)}` : ''}.</p>}
      <Field label="Минус-слова" hint="Объявление не покажется, если в запросе есть одно из них">
        <textarea className="input" rows={2} value={f.negatives} onChange={set('negatives')} />
      </Field>
      <div className="grid grid-2">
        <MoneyInput label="Ставка за клик" value={f.bid} onChange={set('bid')} />
        <MoneyInput label="Дневной бюджет" value={f.daily_budget} onChange={set('daily_budget')} />
      </div>
      <label className="row"><input type="checkbox" checked={!!f.network} onChange={set('network')} /> Показывать и в рекламной сети на сайтах</label>
      <Button type="submit">{submitLabel}</Button>
    </form>
  );
}

function AdsCabinet() {
  const [v, setV] = useState(0);
  const acc = useAsync(() => get('/search/ads/account'), [v]);
  const [amount, setAmount] = useState(5000);
  const [inv, setInv] = useState(null);
  const [creating, setCreating] = useState(false);
  const toast = useToast();
  const d = acc.data;
  if (!d) return <div className="page">{acc.error ? <ErrorBox error={acc.error} /> : <Spinner />}</div>;
  return (
    <div className="page stack">
      <h1>Рекламный кабинет</h1>
      <div className="grid grid-2">
        <div className="card stack-sm">
          <div className="small muted">Баланс</div>
          <div style={{ fontSize: '1.8rem', fontWeight: 700 }}><Money value={d.account.balance} /></div>
          <div className="small muted">Потрачено всего: <Money value={d.account.spent_total} /></div>
          {d.account.balance > 0 && <ActionButton kind="secondary" size="sm" confirm="Вернуть весь остаток на счёт во ВлодБанке? Кампании перестанут показываться." action={async () => { await post('/search/ads/withdraw'); setV((x) => x + 1); }} okMessage="Остаток возвращён">Вернуть остаток</ActionButton>}
        </div>
        <div className="card stack-sm">
          <MoneyInput label="Пополнить на" value={amount} onChange={setAmount} />
          <ActionButton action={async () => setInv(await post('/search/ads/topup', { amount }))}>Выставить квитанцию</ActionButton>
          {inv && (
            <div className="form-warn row" style={{ justifyContent: 'space-between' }}>
              <span>Квитанция <span className="mono">{inv.invoice}</span> на <Money value={inv.amount} /></span>
              <a className="btn sm" href={appUrl('bank', `/pay/${inv.invoice}`)}>Оплатить во ВлодБанке</a>
            </div>
          )}
        </div>
      </div>
      <div className="card-head"><h2>Кампании</h2><Button size="sm" onClick={() => setCreating((x) => !x)}>{creating ? 'Отмена' : '+ Новая кампания'}</Button></div>
      {creating && (
        <div className="card">
          <CampaignForm submitLabel="Запустить" onSave={async (f) => {
            try { const r = await post('/search/ads/campaigns', f); toast('Кампания запущена', 'ok'); navigate(`/ads/${r.id}`); } catch (e) { toast(e.message, 'err'); }
          }} />
        </div>
      )}
      {!d.campaigns.length ? <Empty>Кампаний пока нет.</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Кампания</th><th>Статус</th><th>Ставка</th><th>Показы</th><th>Клики</th><th>CTR</th><th>Расход</th></tr></thead>
            <tbody>
              {d.campaigns.map((c) => (
                <tr key={c.id}>
                  <td><a href={`#/ads/${c.id}`}>{c.name}</a><div className="small muted">{c.keywords.slice(0, 4).join(', ')}</div></td>
                  <td><Badge kind={CAMP_KIND[c.status]}>{c.status_text}</Badge></td>
                  <td><Money value={c.bid} /></td>
                  <td>{c.impressions}</td><td>{c.clicks}</td><td>{c.ctr}%</td><td><Money value={c.spent} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Campaign({ id }) {
  const [v, setV] = useState(0);
  const r = useAsync(() => get(`/search/ads/campaigns/${id}`), [id, v]);
  const [edit, setEdit] = useState(false);
  const toast = useToast();
  const c = r.data?.campaign;
  if (!c) return <div className="page">{r.error ? <ErrorBox error={r.error} /> : <Spinner />}</div>;
  const save = async (body) => { try { await patch(`/search/ads/campaigns/${id}`, body); setEdit(false); setV((x) => x + 1); toast('Сохранено', 'ok'); } catch (e) { toast(e.message, 'err'); } };
  return (
    <div className="page stack">
      <p className="small"><a href="#/ads/cabinet">← Кампании</a></p>
      <div className="card-head"><h1 style={{ margin: 0 }}>{c.name}</h1><Badge kind={CAMP_KIND[c.status]}>{c.status_text}</Badge></div>
      {c.reject_reason && <div className="form-warn">Модератор: {c.reject_reason}. Исправьте объявление — после сохранения оно снова начнёт показываться.</div>}
      <div className="row">
        {c.status === 'active' && <Button kind="secondary" onClick={() => save({ status: 'paused' })}>Остановить</Button>}
        {c.status === 'paused' && <Button onClick={() => save({ status: 'active' })}>Запустить</Button>}
        <Button kind="secondary" onClick={() => setEdit((x) => !x)}>{edit ? 'Отмена' : 'Изменить'}</Button>
        <ActionButton kind="danger" confirm="Удалить кампанию?" action={async () => { await patch(`/search/ads/campaigns/${id}`, { status: 'deleted' }); navigate('/ads/cabinet'); }}>Удалить</ActionButton>
      </div>
      {edit ? <div className="card"><CampaignForm initial={c} submitLabel="Сохранить" onSave={save} /></div> : (
        <>
          <div className="grid grid-4">
            <Stat label="Показы" value={c.impressions} /><Stat label="Клики" value={c.clicks} /><Stat label="CTR" value={`${c.ctr}%`} /><Stat label="Расход" value={formatMoney(c.spent)} />
          </div>
          <div className="card">
            <h3>По ключевым словам и площадкам</h3>
            {!r.data.stats.keywords.length ? <p className="muted">Показов ещё не было.</p> : (
              <div className="table-wrap"><table className="table">
                <thead><tr><th>Слово</th><th>Площадка</th><th>Показы</th><th>Клики</th><th>Расход</th><th>Позиция</th></tr></thead>
                <tbody>{r.data.stats.keywords.map((k, i) => (
                  <tr key={i}><td>{k.keyword || '—'}</td><td>{{ serp: 'поиск', network: 'сеть', newtab: 'новая вкладка' }[k.placement]}</td><td>{k.impressions}</td><td>{k.clicks}</td><td><Money value={k.cost} /></td><td>{k.pos.toFixed(1)}</td></tr>
                ))}</tbody>
              </table></div>
            )}
          </div>
          <dl className="kv card">
            <dt>Объявление</dt><dd><b>{c.title}</b><br />{c.text}<br /><span className="mono small">{c.url}</span></dd>
            <dt>Ключевые слова</dt><dd>{c.keywords.join(', ') || '—'}</dd>
            <dt>Минус-слова</dt><dd>{c.negatives.join(', ') || '—'}</dd>
            <dt>Ставка / бюджет</dt><dd><Money value={c.bid} /> за клик, <Money value={c.daily_budget} /> в сутки</dd>
            <dt>Рекламная сеть</dt><dd>{c.network ? 'да' : 'нет'}</dd>
          </dl>
        </>
      )}
    </div>
  );
}

// ——— Справка ———

function About() {
  return (
    <div className="page narrow prose">
      <h1>Как работает ВлодПоиск</h1>
      <h2>1. Робот</h2>
      <p>VlodBot ходит по БалНету как обычный посетитель: спрашивает DNS через публичный резолвер 50.0.0.53, подключается к серверу со своего адреса 50.1.0.20 и проверяет сертификат HTTPS. Новые сайты хостинга он находит сам, дальше — по ссылкам и файлам sitemap.xml.</p>
      <p>Перед обходом робот читает <code>/robots.txt</code>. Правила для <code>User-agent: VlodBot</code> важнее правил для <code>*</code>; из подходящих правил побеждает самое длинное, при равенстве — Allow. Шаблоны <code>*</code> и <code>$</code> поддерживаются. Если robots.txt нет (404), можно всё; если сервер не отвечает — обход откладывается.</p>
      <p>Страница не попадёт в поиск, если в ней <code>&lt;meta name="robots" content="noindex"&gt;</code> или <code>rel="canonical"</code> указывает на другой адрес. Ссылки с <code>rel="nofollow"</code> не передают вес. Часто меняющиеся страницы робот посещает чаще.</p>
      <h2>2. Ранжирование</h2>
      <ul>
        <li><b>Текст</b> — формула BM25 по словам запроса в заголовке, адресе, подзаголовках, описании, тексте и в текстах ссылок на страницу с других страниц. Слова приводятся к основе: «хлеба», «хлебом» и «хлеб» — одно слово.</li>
        <li><b>PageRank</b> — чем больше страниц (и чем они важнее) ссылаются на страницу, тем она выше.</li>
        <li><b>Свежесть</b> — для новостей (страниц с <code>og:type=article</code>).</li>
        <li>Не больше двух результатов с одного сайта подряд.</li>
      </ul>
      <h2>3. Операторы</h2>
      <p><code>site:shop.bln</code> — только этот сайт; <code>"точная фраза"</code>; <code>-слово</code> — исключить.</p>
      <h2 id="safe">4. Безопасный просмотр</h2>
      <p>ВлодПоиск ведёт список фишинговых и вредоносных адресов. ВлодБраузер скачивает только первые 4 байта хешей SHA-256 записей, а при совпадении уточняет полный хеш — поэтому ВлодПоиск не узнаёт, какие сайты вы открываете. Опасные сайты не показываются в поиске и рекламе. Сообщить о фишинге можно из меню ВлодБраузера.</p>
      <h2>5. Реклама</h2>
      <p>Объявления помечены словом «Реклама» и не влияют на обычную выдачу. Доход ВлодПоиска поступает в госбюджет БФ.</p>
    </div>
  );
}
