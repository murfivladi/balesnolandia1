// БалНовости (novosti.bln) — лента новостей Балесноландии: госновости, сводки экономики и СМИ граждан
// (своя редакция или лента RSS/Atom с сайта в БалНете).
import { useState } from 'react';
import { get, post, patch, del } from '../shared/api.js';
import { useLang } from '../shared/i18n.js';
import { useRoute, pick, navigate } from '../shared/router.js';
import { Topbar, NavLink, Spinner, useAsync, Empty, ErrorBox, Badge, Button, ActionButton, Input, Field, Select, useToast } from '../shared/ui.jsx';
import { NewsLogo } from '../shared/brand.jsx';
import { SiteFooter, GovLogin } from '../shared/site.jsx';

const CATS = { politics: 'Политика', economy: 'Экономика', society: 'Общество', tech: 'БалНет и технологии', culture: 'Культура', sport: 'Спорт' };
const KIND = { gov: ['ok', 'госновости'], economy: ['warn', 'автосводка'], media: ['', 'СМИ'] };
const DAY = 86400;
const gameDate = (t) => `день ${Math.floor(Number(t) / DAY) % 30 + 1}, месяц ${Math.floor(Number(t) / (30 * DAY))}`;

export default function App() {
  useLang();
  const route = useRoute();
  const me = useAsync(() => get('/news/me'), []);
  const nav = (
    <>
      <NavLink href="#/" path={route.path}>Главное</NavLink>
      {Object.entries(CATS).map(([k, v]) => <NavLink key={k} href={`#/c/${k}`} path={route.path}>{v}</NavLink>)}
      <NavLink href="#/outlets" path={route.path}>Редакции</NavLink>
    </>
  );
  const right = me.data?.gov ? <a className="tb-btn" href="#/my">Моё СМИ</a> : <a className="tb-btn" href="#/login">Войти</a>;
  return (
    <>
      <Topbar variant="site" brand={<><NewsLogo /> <span>БалНовости</span></>} nav={nav} right={right} />
      <main style={{ flex: 1 }}>
        {pick([
          ['/', () => <Feed title="Главные новости" />],
          ['/c/:cat', (p) => <Feed key={p.cat} title={CATS[p.cat] || 'Новости'} params={{ category: p.cat }} />],
          ['/search', () => <Feed key={route.query?.q} title={`Поиск: ${route.query?.q || ''}`} params={{ q: route.query?.q || '' }} />],
          ['/a/:id', (p) => <Article id={p.id} />],
          ['/outlets', () => <Outlets />],
          ['/s/:slug', (p) => <Outlet key={p.slug} slug={p.slug} />],
          ['/login', () => <div className="page narrow"><GovLogin app="news" siteName="novosti.bln" hash="#/my" /></div>],
          ['/my', () => (me.data?.gov ? <My me={me} /> : <div className="page narrow"><GovLogin app="news" siteName="novosti.bln" hash="#/my" /></div>)],
          ['*', () => <Empty>Страница не найдена</Empty>],
        ], route.path)}
      </main>
      <SiteFooter
        brand="БалНовости"
        about="Новости Балесноландии: официальные сообщения Правительства, сводки экономики каждый игровой месяц и независимые СМИ граждан."
        columns={[
          { title: 'Разделы', links: Object.entries(CATS).slice(0, 4).map(([k, v]) => ({ href: `#/c/${k}`, label: v })) },
          { title: 'СМИ', links: [{ href: '#/outlets', label: 'Все редакции' }, { href: '#/my', label: 'Открыть своё СМИ' }, { href: '../poisk/#/', label: 'ВлодПоиск' }] },
        ]}
      />
    </>
  );
}

function SearchBox() {
  const [v, setV] = useState('');
  return (
    <form className="row" onSubmit={(e) => { e.preventDefault(); if (v.trim()) navigate(`/search?q=${encodeURIComponent(v.trim())}`); }}>
      <input className="input" style={{ flex: 1 }} value={v} onChange={(e) => setV(e.target.value)} placeholder="Поиск по новостям" />
      <Button kind="secondary">Найти</Button>
    </form>
  );
}

function Card({ a, big = false }) {
  const [k, label] = KIND[a.outlet.kind] || KIND.media;
  return (
    <a className="card stack-sm" href={`#/a/${a.id}`} style={{ textDecoration: 'none', color: 'inherit', ...(big ? { gridColumn: '1 / -1' } : {}) }}>
      <div className="row small muted" style={{ flexWrap: 'wrap', gap: 6 }}>
        {a.pinned && <Badge kind="err">важно</Badge>}
        <Badge kind={k}>{label}</Badge>
        <span>{a.outlet.title}</span>·<span>{CATS[a.category] || ''}</span>·<span>{gameDate(a.published)}</span>
      </div>
      <h3 style={{ margin: 0, fontSize: big ? '1.5rem' : '1.1rem' }}>{a.title}</h3>
      {a.summary && <p className="muted" style={{ margin: 0 }}>{a.summary}</p>}
    </a>
  );
}

function Feed({ title, params = {}, outlet }) {
  const [page, setPage] = useState(1);
  const qs = new URLSearchParams({ ...params, ...(outlet ? { outlet } : {}), page: String(page) }).toString();
  const r = useAsync(() => get(`/news/feed?${qs}`), [qs]);
  return (
    <div className="page stack">
      {!outlet && <><h1 style={{ margin: 0 }}>{title}</h1><SearchBox /></>}
      {r.error ? <ErrorBox error={r.error} /> : !r.data ? <Spinner /> : !r.data.articles.length ? <Empty>Пока новостей нет</Empty> : (
        <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(280px, 1fr))' }}>
          {r.data.articles.map((a, i) => <Card key={a.id} a={a} big={i === 0 && page === 1 && !outlet} />)}
        </div>
      )}
      <div className="row">
        {page > 1 && <Button kind="ghost" onClick={() => setPage(page - 1)}>← Новее</Button>}
        {r.data?.more && <Button kind="ghost" onClick={() => setPage(page + 1)}>Раньше →</Button>}
      </div>
    </div>
  );
}

function Article({ id }) {
  const r = useAsync(() => get(`/news/articles/${id}`), [id]);
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <Spinner />;
  const a = r.data.article;
  return (
    <article className="page narrow stack">
      <div className="row small muted" style={{ flexWrap: 'wrap', gap: 6 }}>
        <a href={`#/s/${a.outlet.slug}`}>{a.outlet.title}</a>·<a href={`#/c/${a.category}`}>{CATS[a.category]}</a>·<span>{gameDate(a.published)}</span>{a.author && <>·<span>{a.author}</span></>}
      </div>
      <h1 style={{ margin: 0 }}>{a.title}</h1>
      {a.summary && <p style={{ fontSize: '1.1rem', fontWeight: 500 }}>{a.summary}</p>}
      {a.body && a.body.split(/\n+/).map((p, i) => <p key={i}>{p}</p>)}
      {a.link && <p><a className="btn secondary" href={a.link} target="_top" rel="noopener">Читать на сайте издания →</a></p>}
    </article>
  );
}

function Outlets() {
  const r = useAsync(() => get('/news/outlets'), []);
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <Spinner />;
  return (
    <div className="page stack">
      <h1 style={{ margin: 0 }}>Редакции</h1>
      <div style={{ display: 'grid', gap: 12, gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))' }}>
        {r.data.outlets.map((o) => (
          <a key={o.slug} className="card stack-sm" href={`#/s/${o.slug}`} style={{ textDecoration: 'none', color: 'inherit' }}>
            <div className="row"><b>{o.title}</b><Badge kind={KIND[o.kind][0]}>{KIND[o.kind][1]}</Badge></div>
            {o.description && <span className="small muted">{o.description}</span>}
            <span className="small muted">Статей: {o.articles}{o.rss_url ? ' · RSS' : ''}</span>
          </a>
        ))}
      </div>
      <p className="muted">Хотите своё издание? <a href="#/my">Откройте СМИ</a> — пишите статьи прямо здесь или подключите RSS-ленту своего сайта.</p>
    </div>
  );
}

function Outlet({ slug }) {
  const r = useAsync(() => get(`/news/outlets/${slug}`), [slug]);
  if (r.error) return <ErrorBox error={r.error} />;
  if (!r.data) return <Spinner />;
  const o = r.data.outlet;
  return (
    <div className="stack">
      <div className="page stack-sm" style={{ paddingBottom: 0 }}>
        <div className="row"><h1 style={{ margin: 0 }}>{o.title}</h1><Badge kind={KIND[o.kind][0]}>{KIND[o.kind][1]}</Badge>{o.mine && <a className="btn sm secondary" href="#/my">Редакция</a>}</div>
        {o.description && <p className="muted" style={{ margin: 0 }}>{o.description}</p>}
        {o.rss_url && <span className="small muted mono">RSS: {o.rss_url}</span>}
      </div>
      <Feed outlet={slug} />
    </div>
  );
}

function My({ me }) {
  const outlets = me.data.outlets;
  const [cur, setCur] = useState(outlets[0]?.slug || null);
  const o = outlets.find((x) => x.slug === cur);
  return (
    <div className="page stack">
      <h1 style={{ margin: 0 }}>Моё СМИ</h1>
      {outlets.length > 0 && (
        <div className="row">{outlets.map((x) => <Button key={x.slug} kind={x.slug === cur ? '' : 'ghost'} size="sm" onClick={() => setCur(x.slug)}>{x.title}</Button>)}
          <Button kind={cur ? 'ghost' : ''} size="sm" onClick={() => setCur(null)}>+ Новое СМИ</Button></div>
      )}
      {o ? <Editorial key={o.slug} o={o} onChange={me.reload} /> : <NewOutlet onDone={(slug) => { me.reload(); setCur(slug); }} />}
    </div>
  );
}

function NewOutlet({ onDone }) {
  const [f, setF] = useState({ slug: '', title: '', description: '', rss_url: '' });
  const toast = useToast();
  return (
    <form className="card stack" onSubmit={async (e) => {
      e.preventDefault();
      try { const r = await post('/news/outlets', f); toast('СМИ зарегистрировано'); onDone(r.outlet.slug); } catch (err) { toast(err.message, 'err'); }
    }}>
      <h2 style={{ margin: 0 }}>Зарегистрировать СМИ</h2>
      <Input label="Название" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />
      <Input label="Адрес (novosti.bln/s/…)" value={f.slug} onChange={(e) => setF({ ...f, slug: e.target.value.toLowerCase() })} placeholder="vlodograd-times" required />
      <Input label="Описание" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      <Input label="Лента RSS или Atom (необязательно)" hint="Например https://мой-сайт.bln/rss.xml — агрегатор заберёт новые статьи раз в игровой месяц или по кнопке" value={f.rss_url} onChange={(e) => setF({ ...f, rss_url: e.target.value })} />
      <Button>Зарегистрировать</Button>
    </form>
  );
}

function Editorial({ o, onChange }) {
  const toast = useToast();
  const [rss, setRss] = useState(o.rss_url || '');
  const [a, setA] = useState({ title: '', summary: '', body: '', category: 'society' });
  const feed = useAsync(() => get(`/news/feed?outlet=${o.slug}`), [o.slug]);
  return (
    <div className="stack">
      <div className="card stack">
        <div className="row"><h2 style={{ margin: 0 }}>{o.title}</h2><a href={`#/s/${o.slug}`}>novosti.bln/s/{o.slug}</a></div>
        <div className="row">
          <input className="input mono" style={{ flex: 1 }} value={rss} onChange={(e) => setRss(e.target.value)} placeholder="https://сайт.bln/rss.xml" />
          <ActionButton size="sm" kind="secondary" okMessage="Сохранено" action={async () => { await patch(`/news/outlets/${o.slug}`, { rss_url: rss }); onChange(); }}>Сохранить</ActionButton>
          {o.rss_url && <ActionButton size="sm" action={async () => {
            const r = await post(`/news/outlets/${o.slug}/fetch`);
            if (r.error) toast(`Лента: ${r.error}`, 'err'); else toast(`Новых статей: ${r.added}`);
            feed.reload(); onChange();
          }}>Обновить ленту</ActionButton>}
        </div>
        {o.last_error && <div className="form-error">Последняя загрузка ленты: {o.last_error}</div>}
      </div>
      <form className="card stack" onSubmit={async (e) => {
        e.preventDefault();
        try { await post(`/news/outlets/${o.slug}/articles`, a); toast('Статья опубликована'); setA({ title: '', summary: '', body: '', category: a.category }); feed.reload(); } catch (err) { toast(err.message, 'err'); }
      }}>
        <h3 style={{ margin: 0 }}>Новая статья</h3>
        <Input label="Заголовок" value={a.title} onChange={(e) => setA({ ...a, title: e.target.value })} required />
        <Select label="Рубрика" value={a.category} onChange={(e) => setA({ ...a, category: e.target.value })} options={Object.entries(CATS).filter(([k]) => k !== 'politics' || true).map(([value, label]) => ({ value, label }))} />
        <Input label="Анонс" value={a.summary} onChange={(e) => setA({ ...a, summary: e.target.value })} />
        <Field label="Текст"><textarea className="input" rows={8} value={a.body} onChange={(e) => setA({ ...a, body: e.target.value })} required /></Field>
        <Button>Опубликовать</Button>
      </form>
      <div className="stack-sm">
        <h3 style={{ margin: 0 }}>Опубликовано</h3>
        {!feed.data ? <Spinner /> : !feed.data.articles.length ? <Empty>Пока ничего</Empty> : feed.data.articles.map((x) => (
          <div key={x.id} className="card row">
            <a href={`#/a/${x.id}`} style={{ flex: 1 }}>{x.title}</a>
            <ActionButton size="sm" kind="ghost" confirm="Удалить статью?" action={async () => { await del(`/news/articles/${x.id}`); feed.reload(); }}>Удалить</ActionButton>
          </div>
        ))}
      </div>
    </div>
  );
}
