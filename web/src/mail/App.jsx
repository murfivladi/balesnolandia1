// ВлодПочта (mail.bln): ящик логин@mail.bln, папки, чтение с проверками SPF/DKIM/DMARC и «Показать оригинал»,
// новое письмо, спам и обучение фильтра, почта для своего домена, аккаунт ВлодБраузера (устройства, сброс).
import { useEffect, useRef, useState } from 'react';
import { get, post, patch, del, apiBase } from '../shared/api.js';
import { useLang } from '../shared/i18n.js';
import { useRoute, pick, navigate } from '../shared/router.js';
import { Topbar, NavLink, Spinner, useAsync, Empty, ErrorBox, Badge, Button, ActionButton, Input, Field, useToast, useChannel } from '../shared/ui.jsx';
import { MailLogo } from '../shared/brand.jsx';
import { SiteFooter, Hero, Section, Features, GovLogin } from '../shared/site.jsx';
import { OAuthConsent, ConnectedApps } from '../shared/oauth.jsx';
import { Developers } from './developers.jsx';

const FOLDERS = [
  ['inbox', '📥', 'Входящие'], ['starred', '⭐', 'Помеченные'], ['sent', '📤', 'Отправленные'], ['spam', '⚠️', 'Спам'], ['trash', '🗑', 'Корзина'],
];
const AUTH_KIND = { pass: 'ok', fail: 'err', softfail: 'warn', permerror: 'err', temperror: 'warn', neutral: '', none: '' };
const when = (d) => {
  const t = new Date(d);
  return t.toDateString() === new Date().toDateString() ? t.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' }) : t.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
};
const who = (a) => (a?.name ? `${a.name}` : a?.address || '—');

export default function App() {
  useLang();
  const route = useRoute();
  const me = useAsync(() => get('/mail/me'), []);
  if (!me.data) return me.error ? <ErrorBox error={me.error} /> : <Spinner />;
  const acc = me.data.account;
  const right = acc ? <a className="tb-btn" href="#/settings">{acc.address}</a> : me.data.gov ? null : <a className="tb-btn" href="#/login">Войти</a>;
  let body;
  if (!me.data.gov) {
    body = pick([
      ['/login', () => <div className="page narrow"><GovLogin app="mail" siteName="mail.bln" hash="#/" /></div>],
      ['/oauth/authorize', () => <div className="page narrow"><GovLogin app="mail" siteName="mail.bln — вход на сайт через ВлодПочту" /></div>],
      ['/developers', () => <div className="page narrow"><GovLogin app="mail" siteName="mail.bln" /></div>],
      ['*', () => <Landing />],
    ], route.path);
  } else if (!acc) body = <ChooseLogin onDone={me.reload} name={me.data.gov.name} />;
  else {
    body = pick([
      ['/compose', () => <Mailbox me={me.data} route={route} compose />],
      ['/m/:id', (p) => <Mailbox me={me.data} route={route} openId={Number(p.id)} />],
      ['/settings', () => <Settings me={me.data} reload={me.reload} />],
      ['/domains', () => <Domains />],
      ['/browser', () => <BrowserAccount />],
      ['/oauth/authorize', () => <div className="page narrow"><OAuthConsent provider="mail" query={route.query} /></div>],
      ['/apps', () => <div className="page narrow stack"><h1>Подключённые сайты</h1><p className="muted">Сайты, на которые вы входили через ВлодПочту или ВлодУслуги. Отзыв доступа сразу гасит их токены.</p><div className="card"><ConnectedApps /></div></div>],
      ['/developers', () => <Developers />],
      ['/f/:folder', (p) => <Mailbox me={me.data} route={route} folder={p.folder} />],
      ['*', () => <Mailbox me={me.data} route={route} folder="inbox" />],
    ], route.path);
  }
  return (
    <>
      <Topbar variant="site" brand={<><MailLogo /> <span>ВлодПочта</span></>} nav={acc ? <><NavLink href="#/" path={route.path}>Почта</NavLink><NavLink href="#/domains" path={route.path}>Свой домен</NavLink><NavLink href="#/browser" path={route.path}>ВлодБраузер</NavLink><NavLink href="#/apps" path={route.path}>Сайты</NavLink><NavLink href="#/developers" path={route.path}>Разработчикам</NavLink></> : null} right={right} />
      <main style={{ flex: 1 }}>{body}</main>
      <SiteFooter
        brand="ВлодПочта"
        about="Почта БалНета: настоящие MX, SPF, DKIM и DMARC, спам-фильтр, почта на своём домене и аккаунт ВлодБраузера."
        columns={[
          { title: 'ВлодПочта', links: [{ href: '#/', label: 'Входящие' }, { href: '#/domains', label: 'Почта для домена' }, { href: '#/browser', label: 'Аккаунт браузера' }, { href: '#/apps', label: 'Подключённые сайты' }, { href: '#/developers', label: 'Вход через ВлодПочту для сайтов' }] },
          { title: 'Сервисы БалНета', links: [{ href: '../reg/#/', label: 'БалРег — домены' }, { href: '../hosting/#/', label: 'БалХост — хостинг' }, { href: '../poisk/#/', label: 'ВлодПоиск' }] },
        ]}
      />
    </>
  );
}

function Landing() {
  return (
    <>
      <Hero kicker="mail.bln · почта БалНета" title="Почта, которая работает как настоящая" lead="Письма идут по MX через сеть БалНета, подписываются DKIM и проверяются SPF и DMARC. Подделку письма от банка видно сразу." art="✉️">
        <a className="btn light" href="#/login">Создать ящик</a>
      </Hero>
      <Section title="Что умеет ВлодПочта">
        <Features items={[
          { icon: '🔏', title: 'DKIM и DMARC', text: 'Каждое письмо подписано ключом Ed25519, получатель видит результаты проверок в «Показать оригинал».' },
          { icon: '🛡', title: 'Спам-фильтр', text: 'Правила и байесовский фильтр, который учится на ваших кнопках «Спам» и «Не спам».' },
          { icon: '🌐', title: 'Свой домен', text: 'info@ваш-домен.bln: MX, SPF, DKIM и DMARC в один клик, если домен на DNS БалНета.' },
          { icon: '🧭', title: 'Аккаунт браузера', text: 'Синхронизация закладок, истории и паролей ВлодБраузера. Данные шифруются кодовой фразой ещё в браузере.' },
        ]} />
      </Section>
    </>
  );
}

function ChooseLogin({ onDone, name: initial }) {
  const [login, setLogin] = useState('');
  const [name, setName] = useState(initial || '');
  const toast = useToast();
  return (
    <div className="page narrow">
      <h1>Ваш адрес во ВлодПочте</h1>
      <form className="card stack" onSubmit={async (e) => { e.preventDefault(); try { await post('/mail/me', { login, name }); onDone(); } catch (ex) { toast(ex.message, 'err'); } }}>
        <Field label="Адрес">
          <div className="row"><input className="input" style={{ flex: 1 }} value={login} onChange={(e) => setLogin(e.target.value.toLowerCase())} placeholder="boris" required /><b>@mail.bln</b></div>
        </Field>
        <Input label="Имя отправителя" value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit">Создать ящик</Button>
      </form>
    </div>
  );
}

// ——— Ящик ———

function Mailbox({ me, route, folder: f0, openId = null, compose = false }) {
  const [folder, setFolder] = useState(f0 || 'inbox');
  const [q, setQ] = useState('');
  const counts = useAsync(() => get('/mail/folders'), []);
  const list = useAsync(() => get(`/mail/messages?folder=${folder}${q ? `&q=${encodeURIComponent(q)}` : ''}`), [folder, q]);
  const [reply, setReply] = useState(null);
  useEffect(() => { if (f0) setFolder(f0); }, [f0]);
  useChannel(me.gov ? `user:g${me.gov.id}` : null, (m) => { if (m.type === 'mail') { counts.reload(); list.reload(); } });
  const refresh = () => { counts.reload(); list.reload(); };
  return (
    <div className="ml">
      <aside className="ml-side">
        <a className="btn block" href="#/compose" onClick={() => setReply(null)}>✏️ Написать</a>
        {FOLDERS.map(([k, ico, label]) => {
          const c = k === 'starred' ? null : counts.data?.folders[k];
          return (
            <a key={k} href={`#/f/${k}`} className={`ml-folder ${folder === k && !openId && !compose ? 'is-on' : ''}`}>
              <span>{ico} {label}</span>
              {c && (k === 'inbox' || k === 'spam' ? c.unread > 0 && <b>{c.unread}</b> : null)}
            </a>
          );
        })}
      </aside>
      <section className="ml-main">
        {compose ? <Compose me={me} reply={reply || (route.query.to ? { to: route.query.to, subject: route.query.subject || '' } : null)} onSent={() => { setReply(null); refresh(); navigate('/f/sent'); }} />
          : openId ? <Message id={openId} me={me} onChange={refresh} onReply={(r) => { setReply(r); navigate('/compose'); }} />
            : (
              <>
                <div className="ml-tools">
                  <input className="input" placeholder="Поиск в письмах" defaultValue={q} onKeyDown={(e) => { if (e.key === 'Enter') setQ(e.target.value.trim()); }} />
                  <Button kind="ghost" size="sm" onClick={refresh}>↻</Button>
                </div>
                {!list.data ? <Spinner /> : !list.data.messages.length ? <Empty>{q ? 'Ничего не найдено' : 'Писем нет'}</Empty> : (
                  <div className="ml-list">
                    {list.data.messages.map((m) => (
                      <a key={m.id} href={`#/m/${m.id}`} className={`ml-row ${m.seen ? '' : 'is-new'}`}>
                        <span className="ml-star" aria-hidden>{m.starred ? '⭐' : ''}</span>
                        <span className="ml-from ml-ell">{folder === 'sent' ? `Кому: ${(m.to || []).map((t) => t.address).join(', ')}` : who(m.from)}</span>
                        <span className="ml-subj ml-ell"><b>{m.subject || '(без темы)'}</b> <span className="muted">— {m.snippet}</span></span>
                        {m.auth?.dmarc === 'fail' && <Badge kind="err">DMARC</Badge>}
                        <span className="ml-date small muted">{when(m.created_at)}</span>
                      </a>
                    ))}
                  </div>
                )}
              </>
            )}
        {route.path === '/' && <p className="small muted" style={{ marginTop: 12 }}>Ваш адрес: <b>{me.account.address}</b>{me.addresses.length > 1 ? ` · ещё ${me.addresses.slice(1).join(', ')}` : ''}</p>}
      </section>
    </div>
  );
}

function AuthBadges({ auth }) {
  if (!auth || auth.local) return null;
  const items = [['SPF', auth.spf, auth.spf_why], ['DKIM', auth.dkim, auth.dkim_why || (auth.dkim_domain ? `подпись домена ${auth.dkim_domain}` : null)], ['DMARC', auth.dmarc, auth.dmarc_why]];
  return (
    <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
      {items.map(([k, v, why]) => <span key={k} title={why || ''}><Badge kind={AUTH_KIND[v] ?? ''}>{k}: {v || 'none'}</Badge></span>)}
      {auth.ip && <span className="small muted">сервер {auth.ptr || auth.helo} [{auth.ip}]</span>}
    </div>
  );
}

/** HTML письма — во фрейме без скриптов; ссылки открываются во ВлодБраузере. */
function HtmlBody({ html }) {
  const ref = useRef(null);
  const onLoad = () => {
    const d = ref.current?.contentDocument;
    if (!d) return;
    ref.current.style.height = `${Math.min(2000, d.documentElement.scrollHeight + 16)}px`;
    d.addEventListener('click', (e) => {
      const a = e.target.closest?.('a[href]');
      if (!a) return;
      e.preventDefault();
      const open = window.__balnetOpen || window.parent?.__balnetOpen;
      if (open) open(a.getAttribute('href'), true);
      else window.open(a.href, '_blank', 'noopener');
    });
  };
  return <iframe ref={ref} title="Письмо" sandbox="allow-same-origin" srcDoc={`<base target="_blank"><style>body{font:15px/1.5 system-ui,sans-serif;margin:0;overflow-wrap:anywhere}img{max-width:100%}</style>${html}`} onLoad={onLoad} style={{ width: '100%', border: 0, minHeight: 120 }} />;
}

function Message({ id, me, onChange, onReply }) {
  const m = useAsync(() => get(`/mail/messages/${id}`), [id]);
  const [raw, setRaw] = useState(null);
  const [why, setWhy] = useState(false);
  const toast = useToast();
  useEffect(() => { if (m.data) onChange(); }, [m.data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!m.data) return m.error ? <ErrorBox error={m.error} /> : <Spinner />;
  const x = m.data.message;
  const act = async (fn, msg) => { await fn(); if (msg) toast(msg, 'ok'); onChange(); };
  const quote = `\n\n${new Date(x.created_at).toLocaleString('ru-RU')}, ${x.from.name || x.from.address} пишет:\n${(x.text || '').split('\n').map((l) => `> ${l}`).join('\n')}`;
  const showRaw = async () => {
    const r = await fetch(`${apiBase()}/api/mail/messages/${id}/raw`, { credentials: 'include' });
    setRaw(await r.text());
  };
  return (
    <article className="ml-msg stack">
      <div className="row" style={{ flexWrap: 'wrap', gap: 6 }}>
        <Button size="sm" kind="ghost" onClick={() => history.back()}>← Назад</Button>
        <Button size="sm" onClick={() => onReply({ to: x.from.address, subject: /^re:/i.test(x.subject) ? x.subject : `Re: ${x.subject}`, text: quote, inReplyTo: x.message_id, from: x.rcpt && me.addresses.includes(x.rcpt) ? x.rcpt : undefined })}>↩ Ответить</Button>
        <Button size="sm" kind="ghost" onClick={() => onReply({ subject: `Fwd: ${x.subject}`, text: `\n\n---------- Пересланное письмо ----------\nОт: ${x.from.address}\nТема: ${x.subject}\n\n${x.text || ''}` })}>↪ Переслать</Button>
        <ActionButton size="sm" kind="ghost" action={() => act(() => patch(`/mail/messages/${id}`, { starred: !x.starred })).then(m.reload)}>{x.starred ? '★ Снять пометку' : '☆ Пометить'}</ActionButton>
        {x.folder === 'spam'
          ? <ActionButton size="sm" kind="ghost" action={() => act(() => post(`/mail/messages/${id}/spam`, { spam: false }), 'Письмо перенесено во «Входящие», фильтр учтёт это').then(m.reload)}>Не спам</ActionButton>
          : x.folder !== 'sent' && <ActionButton size="sm" kind="ghost" action={() => act(() => post(`/mail/messages/${id}/spam`, { spam: true }), 'Письмо в «Спаме», фильтр учтёт это').then(m.reload)}>Это спам</ActionButton>}
        <ActionButton size="sm" kind="ghost" action={() => act(() => del(`/mail/messages/${id}`), x.folder === 'trash' ? 'Удалено навсегда' : 'В корзине').then(() => history.back())}>🗑 Удалить</ActionButton>
        <Button size="sm" kind="ghost" onClick={showRaw}>Показать оригинал</Button>
        <ActionButton size="sm" kind="ghost" confirm="Отправить письмо администрации БалНета? Администратор увидит его текст." action={() => act(() => post(`/mail/messages/${id}/report`, { reason: window.prompt('Что не так с письмом?') || '' }), 'Жалоба отправлена')}>Пожаловаться</ActionButton>
      </div>
      <h1 style={{ margin: 0 }}>{x.subject || '(без темы)'}</h1>
      <div>
        <b>{x.from.name || x.from.address}</b> <span className="muted">&lt;{x.from.address}&gt;</span>
        <div className="small muted">Кому: {(x.to || []).map((t) => t.address).join(', ') || x.rcpt}{x.cc?.length ? ` · Копия: ${x.cc.map((t) => t.address).join(', ')}` : ''} · {new Date(x.created_at).toLocaleString('ru-RU')}</div>
      </div>
      <AuthBadges auth={x.auth} />
      {x.auth?.dmarc === 'fail' && <div className="form-error">⚠ Отправитель не подтверждён: домен {x.from.address.split('@')[1]} не подписывал это письмо. Не вводите пароли и данные карт по ссылкам из него.</div>}
      {x.folder === 'spam' && (
        <div className="form-error">
          Письмо в «Спаме»: оценка {(x.spam_score / 10).toFixed(1)}. <button className="ml-link" onClick={() => setWhy((v) => !v)}>{why ? 'Скрыть' : 'Почему?'}</button>
          {why && <ul>{x.spam_reasons.map((r) => <li key={r.rule}>{r.text} ({r.points > 0 ? '+' : ''}{(r.points / 10).toFixed(1)})</li>)}</ul>}
        </div>
      )}
      <div className="card">{x.html ? <HtmlBody html={x.html} /> : <div style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{x.text}</div>}</div>
      {raw !== null && (
        <div className="stack-sm">
          <div className="row"><b>Оригинал письма ({x.size} байт)</b><Button size="sm" kind="ghost" onClick={() => setRaw(null)}>Скрыть</Button></div>
          <pre className="vh-code" style={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>{raw}</pre>
        </div>
      )}
    </article>
  );
}

function Compose({ me, reply, onSent }) {
  const [f, setF] = useState(() => ({ from: reply?.from || me.addresses[0], to: reply?.to || '', cc: '', subject: reply?.subject || '', text: reply?.text || '', inReplyTo: reply?.inReplyTo || null }));
  const [sugg, setSugg] = useState([]);
  const [res, setRes] = useState(null);
  const toast = useToast();
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  useEffect(() => {
    const last = f.to.split(/[,;]/).pop().trim();
    if (last.length < 2) { setSugg([]); return undefined; }
    const t = setTimeout(() => get(`/mail/contacts?q=${encodeURIComponent(last)}`).then((r) => setSugg(r.contacts), () => {}), 200);
    return () => clearTimeout(t);
  }, [f.to]);
  return (
    <form className="ml-msg stack" onSubmit={async (e) => {
      e.preventDefault();
      try {
        const r = await post('/mail/send', f);
        const bad = r.results.filter((x) => !x.ok);
        if (bad.length) { setRes(r.results); toast('Не всем получателям удалось доставить — подробности в письме «Не доставлено»', 'err'); } else { toast('Письмо отправлено', 'ok'); onSent(); }
      } catch (ex) { toast(ex.message, 'err'); }
    }}>
      <h1 style={{ margin: 0 }}>Новое письмо</h1>
      {me.addresses.length > 1 && (
        <Field label="От кого"><select className="input" value={f.from} onChange={set('from')}>{me.addresses.map((a) => <option key={a}>{a}</option>)}</select></Field>
      )}
      <Field label="Кому" hint="Несколько адресов — через запятую">
        <input className="input" value={f.to} onChange={set('to')} required placeholder="anna@mail.bln" list="ml-contacts" />
        <datalist id="ml-contacts">{sugg.map((c) => <option key={c.address} value={f.to.replace(/[^,;]*$/, (m) => (m.startsWith(' ') ? ' ' : '') + c.address)} />)}</datalist>
      </Field>
      <Input label="Копия" value={f.cc} onChange={set('cc')} />
      <Input label="Тема" value={f.subject} onChange={set('subject')} />
      <textarea className="input" rows={14} value={f.text} onChange={set('text')} style={{ fontFamily: 'inherit' }} />
      <div className="row"><Button type="submit">Отправить</Button><span className="small muted">Письмо уйдёт с сервера mx.mail.bln с подписью DKIM.</span></div>
      {res && <div className="stack-sm">{res.map((r) => <div key={r.rcpt} className={r.ok ? 'form-ok' : 'form-error'}><b>{r.rcpt}</b>: {r.code} {r.text}</div>)}</div>}
    </form>
  );
}

// ——— Настройки ———

function Settings({ me, reload }) {
  const a = me.account;
  const [f, setF] = useState({ name: a.name || '', signature: a.signature || '', notify_email: a.notify_email, spam_threshold: a.spam_threshold / 10 });
  const toast = useToast();
  return (
    <div className="page narrow stack">
      <h1>Настройки ящика</h1>
      <form className="card stack" onSubmit={async (e) => { e.preventDefault(); try { await patch('/mail/me', { ...f, spam_threshold: Math.round(Number(f.spam_threshold) * 10) }); toast('Сохранено', 'ok'); reload(); } catch (ex) { toast(ex.message, 'err'); } }}>
        <p>Адреса: {me.addresses.map((x) => <Badge key={x}>{x}</Badge>)}</p>
        <Input label="Имя отправителя" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        <Field label="Подпись"><textarea className="input" rows={3} value={f.signature} onChange={(e) => setF({ ...f, signature: e.target.value })} /></Field>
        <Input label="Порог спама (баллы)" type="number" step="0.5" min="1" max="20" value={f.spam_threshold} onChange={(e) => setF({ ...f, spam_threshold: e.target.value })} hint="Письма с оценкой выше уходят в «Спам». По умолчанию 5." />
        <label className="row"><input type="checkbox" checked={f.notify_email} onChange={(e) => setF({ ...f, notify_email: e.target.checked })} /> Сообщать о новых письмах на настоящий email (без текста письма, не чаще раза в 15 минут)</label>
        <Button type="submit">Сохранить</Button>
      </form>
    </div>
  );
}

// ——— Свой домен ———

function Domains() {
  const d = useAsync(() => get('/mail/domains'), []);
  const [name, setName] = useState('');
  const toast = useToast();
  return (
    <div className="page stack">
      <h1>Почта для своего домена</h1>
      <p className="muted">Подключите домен с БалРега — и получайте письма на info@ваш-домен. Нужно добавить четыре записи DNS: MX, SPF, DKIM и DMARC.</p>
      <form className="card row" onSubmit={async (e) => { e.preventDefault(); try { await post('/mail/domains', { name }); setName(''); d.reload(); } catch (ex) { toast(ex.message, 'err'); } }}>
        <input className="input" style={{ flex: 1, minWidth: 160 }} placeholder="vasya.bln" value={name} onChange={(e) => setName(e.target.value.toLowerCase())} required />
        <Button type="submit">Подключить</Button>
      </form>
      {!d.data ? <Spinner /> : !d.data.domains.length ? <Empty>Доменов пока нет.</Empty> : d.data.domains.map((x) => <DomainCard key={x.id} d={x} reload={d.reload} />)}
    </div>
  );
}

function DomainCard({ d, reload }) {
  const [checks, setChecks] = useState(d.checks);
  const [local, setLocal] = useState('');
  const [forLogin, setFor] = useState('');
  const toast = useToast();
  const ok = checks && Object.values(checks).every((c) => c.ok);
  return (
    <div className="card stack">
      <div className="card-head"><h2>{d.name}</h2>{checks ? <Badge kind={ok ? 'ok' : 'warn'}>{ok ? 'всё настроено' : 'не все записи'}</Badge> : <Badge>не проверен</Badge>}</div>
      <div className="vh-files">
        {d.records.map((r) => (
          <div key={r.key} className="vh-row" style={{ flexWrap: 'wrap' }}>
            <span style={{ minWidth: 24 }}>{checks ? (checks[r.key]?.ok ? '✅' : '❌') : '•'}</span>
            <b style={{ minWidth: 150 }}>{r.title}</b>
            <span className="mono small" style={{ flex: 1, overflowWrap: 'anywhere' }}>{r.name} {r.type} {r.data}</span>
          </div>
        ))}
      </div>
      <div className="row" style={{ flexWrap: 'wrap' }}>
        <ActionButton action={async () => setChecks((await post(`/mail/domains/${d.id}/check`)).checks)}>Проверить</ActionButton>
        <ActionButton kind="ghost" okMessage="Записи добавлены в зону домена" action={async () => setChecks((await post(`/mail/domains/${d.id}/auto`)).checks)}>Добавить записи автоматически</ActionButton>
        <ActionButton kind="ghost" confirm={`Отключить почту для ${d.name}? Адреса на домене удалятся.`} action={async () => { await del(`/mail/domains/${d.id}`); reload(); }}>Отключить</ActionButton>
      </div>
      <h3>Адреса</h3>
      {d.addresses.length ? d.addresses.map((a) => (
        <div key={a.address} className="row"><b>{a.address}</b><span className="small muted">→ {a.owner}</span>
          <ActionButton size="sm" kind="ghost" action={async () => { await del(`/mail/domains/${d.id}/addresses/${encodeURIComponent(a.address)}`); reload(); }}>Удалить</ActionButton>
        </div>
      )) : <p className="muted small">Адресов нет.</p>}
      <form className="row" style={{ flexWrap: 'wrap' }} onSubmit={async (e) => { e.preventDefault(); try { await post(`/mail/domains/${d.id}/addresses`, { local, for: forLogin || null }); setLocal(''); setFor(''); reload(); } catch (ex) { toast(ex.message, 'err'); } }}>
        <input className="input" style={{ width: 140 }} placeholder="info" value={local} onChange={(e) => setLocal(e.target.value)} required /><b>@{d.name}</b>
        <input className="input" style={{ width: 200 }} placeholder="в ящик (по умолчанию ваш)" value={forLogin} onChange={(e) => setFor(e.target.value)} />
        <Button type="submit" size="sm">Добавить адрес</Button>
      </form>
      <label className="row small"><input type="checkbox" defaultChecked={d.catch_all} onChange={(e) => patch(`/mail/domains/${d.id}`, { catch_all: e.target.checked })} /> Принимать письма на любые адреса домена в мой ящик</label>
    </div>
  );
}

// ——— Аккаунт ВлодБраузера ———

function BrowserAccount() {
  const d = useAsync(() => get('/mail/sync/devices'), []);
  const [done, setDone] = useState(false);
  const toast = useToast();
  // Открыто во ВлодБраузере: оболочка даёт функцию подключения этого браузера к аккаунту.
  const signIn = typeof window.__balnetBrowserSignIn === 'function' ? window.__balnetBrowserSignIn : null;
  return (
    <div className="page narrow stack">
      <h1>Аккаунт ВлодБраузера</h1>
      <p className="muted">Войдите во ВлодБраузер аккаунтом ВлодПочты — закладки, история и пароли будут на всех ваших устройствах. Данные шифруются кодовой фразой в самом браузере: ВлодПочта хранит только шифротекст.</p>
      {signIn && (
        <div className="card stack-sm">
          {done ? <b>✅ Этот ВлодБраузер подключён. Откройте настройки браузера, чтобы ввести кодовую фразу.</b> : (
            <ActionButton action={async () => { await signIn(); setDone(true); d.reload(); }}>Подключить этот ВлодБраузер</ActionButton>
          )}
        </div>
      )}
      {!d.data ? <Spinner /> : (
        <>
          <h2>Устройства</h2>
          {!d.data.devices.length ? <Empty>Браузеры не подключены. Откройте mail.bln во ВлодБраузере или войдите в его настройках.</Empty> : (
            <div className="vh-files">
              {d.data.devices.map((x) => (
                <div key={x.id} className="vh-row"><b style={{ flex: 1 }}>{x.name}</b><span className="small muted">{x.last_seen ? `был в сети ${new Date(x.last_seen).toLocaleString('ru-RU')}` : ''}</span>
                  <ActionButton size="sm" kind="ghost" confirm="Отключить устройство от аккаунта?" action={async () => { await del(`/mail/sync/devices/${x.id}`); d.reload(); }}>Отключить</ActionButton>
                </div>
              ))}
            </div>
          )}
          <h2>Данные синхронизации</h2>
          <p className="small">{d.data.has_key ? 'Кодовая фраза задана.' : 'Кодовая фраза ещё не задана.'} {d.data.data.map((c) => `${{ bookmarks: 'закладки', history: 'история', passwords: 'пароли' }[c.collection]}: ${Math.round(c.bytes / 1024)} КБ`).join(' · ')}</p>
          <ActionButton kind="danger" confirm="Удалить все синхронизированные данные и забыть кодовую фразу? На устройствах данные останутся." okMessage="Данные синхронизации удалены" action={async () => { await post('/mail/sync/reset'); d.reload(); toast('Задайте новую кодовую фразу в настройках браузера', 'ok'); }}>Сбросить синхронизацию (забыл кодовую фразу)</ActionButton>
        </>
      )}
    </div>
  );
}
