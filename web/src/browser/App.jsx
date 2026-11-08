// ВлодБраузер — оболочка (этап Н1): вкладки, адресная строка, история, закладки, профили, инкогнито.
// Госсайты (bank.bln, gosuslugi.gov.bln, kassa.bln) — это существующие приложения проекта во фрейме того же origin.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get } from '../shared/api.js';
import { useTheme } from '../shared/ui.jsx';
import { CoatOfArms } from '../shared/brand.jsx';
import {
  NEW_TAB, INTERNAL_PAGES, GOV_SITES, SEARCH_HOST, parseInput, resolveTarget, appPath, govUrlFromApp, displayUrl, searchQuery,
} from '@bln/shared/balnet-url.js';
import { DEFAULT_NET, newClientId, openUrl } from './net.js';
import { apiBase, post as apiPost } from '../shared/api.js';
import { splitUrl } from '@bln/shared/balnet-url.js';
import { DevTools } from './devtools.jsx';
import { checkTls, isBypassed, addBypass, CertErrorPage, CertViewer } from './certs.jsx';
import { checkSafe, isSafeBypassed, addSafeBypass, SafeBrowsingPage, reportPhishing } from './safe.jsx';
import { HSTS_PRELOAD } from '@bln/shared/balnet-url.js';
import { CERT_ERRORS } from '@bln/shared/balnet-pki.js';
import { TerminalPage } from './terminal.jsx';
import { syncAll, createPhrase, unlock } from './sync.js';
import { PasswordPrompt } from './passwords.jsx';
import { useBalnetPush, PermissionPrompt, PushToasts, NotificationsPage } from './push.jsx';
import {
  profileStore, loadProfiles, saveProfiles, loadActiveProfile, saveActiveProfile, removeItem, PROFILE_COLORS, HISTORY_LIMIT,
} from './store.js';
import {
  NewTabPage, HistoryPage, BookmarksPage, SettingsPage, AboutPage, GamePage, ErrorPage, MaintenancePage, Favicon,
} from './pages.jsx';

const BASE = import.meta.env.BASE_URL;
const DEFAULT_SETTINGS = { home: NEW_TAB, bookmarksBar: true, restoreSession: true, net: DEFAULT_NET, notifPerms: {} };
const NET_LOG_LIMIT = 200;
const MAX_BACK = 50;

let seq = 0;
const newId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

function titleFor(url) {
  const t = resolveTarget(url);
  if (t.kind === 'internal') return INTERNAL_PAGES[t.page];
  if (t.kind === 'web' && t.host === SEARCH_HOST) {
    const q = searchQuery(t.path);
    return q ? `${q} — ВлодПоиск` : 'ВлодПоиск';
  }
  if (t.kind === 'web' && GOV_SITES[t.host]) return GOV_SITES[t.host].title;
  return displayUrl(url);
}

const makeTab = (url = NEW_TAB) => ({ id: newId(), url, title: titleFor(url), back: [], fwd: [], reloadKey: 0 });

/** Адрес из ссылки вида bln.vladislavb.qzz.io/#bank.bln/cards — открывается в новой вкладке. */
function takeUrlFromHash() {
  const raw = decodeURIComponent(location.hash.replace(/^#/, ''));
  if (!raw) return null;
  try { history.replaceState(null, '', location.pathname + location.search); } catch { /* ignore */ }
  return parseInput(raw);
}

/**
 * Что показать в «замке» слева от адреса. Значок госсайта ставится только по ответу сервера:
 * сайт открыт с госсервера (vhost — приложение проекта или ВлодПоиск). Подменённый DNS его не даст.
 */
function securityOf(tab) {
  const t = resolveTarget(tab.url);
  if (t.kind === 'internal') return { kind: 'internal', label: 'ВлодБраузер' };
  const c = tab.conn;
  const mine = t.kind === 'web' && c?.host === t.host;
  // https: решает проверка сертификата браузером. Ошибка (пропущенная вручную) — красное «Не защищено».
  if (mine && c.unsafe) return { kind: 'danger', label: 'Опасный сайт', host: t.host, ip: c.ip, cert: c.cert, tls: c.tls, unsafe: c.unsafe };
  if (mine && t.scheme === 'https' && c.cert && !c.cert.ok) return { kind: 'danger', label: 'Не защищено', host: t.host, ip: c.ip, cert: c.cert, tls: c.tls };
  if (mine && c.gov && c.cert?.ok) {
    return { kind: 'gov', label: 'Госсайт БФ', owner: GOV_SITES[t.host]?.owner || 'Правительство БФ', host: t.host, ip: c.ip, cert: c.cert, tls: c.tls };
  }
  if (mine && t.scheme === 'https' && c.cert?.ok) return { kind: 'secure', label: '', host: t.host, ip: c.ip, cert: c.cert, tls: c.tls };
  if (t.kind === 'web' && t.scheme === 'http') return { kind: 'insecure', label: 'Не защищено', host: t.host, ip: c?.ip };
  return { kind: 'none', label: '', host: t.host, ip: c?.ip };
}

/** Адрес фрейма → адрес БалНета: /bank/#/cards на хосте bank.bln → https://bank.bln/cards */
function frameUrl(loc, app, host) {
  const rel = loc.pathname.startsWith(BASE) ? loc.pathname.slice(BASE.length) : loc.pathname.replace(/^\//, '');
  const frameApp = rel.split('/')[0];
  if (frameApp === app) {
    let route = loc.hash.replace(/^#/, '') || '/';
    if (!route.startsWith('/')) route = `/${route}`;
    return `https://${host}${route}`;
  }
  return govUrlFromApp(frameApp, loc.hash); // ссылка в другое приложение — его госадрес
}

// ——— Госсайт во фрейме ———

function GovFrame({ tab, app, host, path, theme, onFrameNav, onTitle, onOpen, onSignIn }) {
  const ref = useRef(null);
  const cb = useRef({ onFrameNav, onTitle, onOpen, onSignIn, app, host });
  useEffect(() => { cb.current = { onFrameNav, onTitle, onOpen, onSignIn, app, host }; });
  const src = BASE + appPath(app, path);

  useEffect(() => {
    const id = setInterval(() => {
      try {
        const d = ref.current?.contentDocument;
        if (d?.title) cb.current.onTitle(d.title);
      } catch { /* фрейм ещё грузится */ }
    }, 1000);
    return () => clearInterval(id);
  }, []);

  useEffect(() => {
    try { ref.current.contentDocument.documentElement.dataset.theme = theme; } catch { /* ignore */ }
  }, [theme]);

  const onLoad = () => {
    try {
      const w = ref.current.contentWindow;
      w.document.documentElement.dataset.theme = theme;
      // Госсайт (ВлодПоиск и др.) открывает адреса БалНета во вкладке браузера.
      w.__balnetOpen = (url, newTab) => {
        const u = parseInput(String(url || ''));
        if (u && !u.startsWith('balnet://')) cb.current.onOpen(u, !!newTab);
      };
      // ВлодПочта может подключить этот браузер к аккаунту (вход во ВлодБраузер). Только настоящий mail.bln.
      if (cb.current.app === 'mail' && cb.current.onSignIn) w.__balnetBrowserSignIn = () => cb.current.onSignIn();
      // Приложение и хост берём текущие, а не из момента загрузки фрейма: вкладка могла уйти на другой сайт.
      const sync = () => {
        const url = frameUrl(w.location, cb.current.app, cb.current.host);
        if (url) cb.current.onFrameNav(url);
        if (w.document.title) cb.current.onTitle(w.document.title);
      };
      w.addEventListener('hashchange', sync);
      sync();
    } catch { /* ignore */ }
  };

  return <iframe key={`${tab.reloadKey}|${app}|${host}`} ref={ref} className="bb-frame" src={src} title={tab.title} onLoad={onLoad} />;
}

// ——— Сайт игрока: песочница шлюза ———

const SANDBOX = 'allow-scripts allow-forms allow-popups allow-modals allow-downloads';
const siteFrames = new Map(); // id вкладки → { win(), ticket, origin }

/** Заполнить форму входа на сайте игрока сохранённым паролем. */
function fillPassword(tabId, cred) {
  const f = siteFrames.get(tabId);
  const w = f?.win();
  if (!w || f.origin !== cred.origin) return false;
  w.postMessage({ __balnet: 1, ticket: f.ticket, type: 'fill', username: cred.username, password: cred.password }, '*');
  return true;
}

/**
 * Сайт игрока во фрейме-песочнице (непрозрачный origin, CSP sandbox от шлюза).
 * Shim внутри сообщает адрес, заголовок, переходы и хранилища. Сообщения принимаются только от этого фрейма
 * и только с адресами этого же сайта — подделать адресную строку на другой домен сайт не может.
 */
function SiteFrame({ tab, ticket, origin, path, ctx }) {
  const ref = useRef(null);
  const lastUrl = useRef(tab.url);
  const cb = useRef(ctx);
  useEffect(() => { cb.current = ctx; });
  const gateway = (p) => `${apiBase()}/api/net/web/${ticket}${p.startsWith('/') ? p : `/${p}`}`;
  const [src] = useState(() => gateway(path));
  // Окно сайта — для автозаполнения паролей (сообщение уходит только в этот фрейм).
  useEffect(() => {
    siteFrames.set(tab.id, { win: () => ref.current?.contentWindow, ticket, origin });
    return () => { if (siteFrames.get(tab.id)?.ticket === ticket) siteFrames.delete(tab.id); };
  }, [tab.id, ticket, origin]);

  useEffect(() => {
    if (tab.url === lastUrl.current) return;
    lastUrl.current = tab.url;
    const p = splitUrl(tab.url);
    if (p && ref.current) ref.current.src = gateway(p.path);
  }, [tab.url]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const sameSite = (u) => {
      try { return new URL(u).origin === origin; } catch { return false; }
    };
    const on = (e) => {
      if (!ref.current || e.source !== ref.current.contentWindow) return;
      const m = e.data;
      if (!m || m.__balnet !== 1 || m.ticket !== ticket) return;
      const c = cb.current;
      // Оболочка знает открытые фреймы сайта: им приходит новое разрешение на уведомления.
      c.push.seenFrame(tab.id, { win: e.source, origin, ticket });
      // Служебная страница переадресации шлюза — не адрес сайта: её nav не должен перебить переход.
      if (m.type === 'nav' && typeof m.url === 'string' && sameSite(m.url) && !new URL(m.url).pathname.startsWith('/__balnet_redirect')) {
        lastUrl.current = m.url;
        c.navigate(m.url, { tabId: tab.id });
        if (m.title) c.setTitle(tab.id, String(m.title).slice(0, 200));
      } else if (m.type === 'open' && typeof m.url === 'string') {
        const url = parseInput(m.url);
        if (url && !url.startsWith('balnet://')) c.navigate(url, m.newTab ? { newTab: true, referrer: lastUrl.current } : { tabId: tab.id });
      } else if (m.type === 'login-form') {
        c.patchConn(tab.id, { loginForm: true });
      } else if (m.type === 'credential' && typeof m.password === 'string' && m.password) {
        c.offerPassword({ origin, username: String(m.username || '').slice(0, 200), password: m.password.slice(0, 500), tabId: tab.id });
      } else if (m.type === 'jar') {
        const jar = { cookies: m.cookies || {}, local: m.local || {} };
        c.saveJar(origin, jar);
        apiPost('/net/jar', { ticket, ...jar }).catch(() => {});
      } else if (typeof m.type === 'string') {
        // Уведомления и Push API сайта решает оболочка (разрешение по сайту, показ, подписка в push.bln).
        c.push.onFrameMessage(m, { tabId: tab.id, origin, ticket, win: e.source });
      }
    };
    window.addEventListener('message', on);
    return () => { window.removeEventListener('message', on); cb.current.push.dropFrame(tab.id); };
  }, [ticket, origin, tab.id]);

  return <iframe ref={ref} className="bb-frame" sandbox={SANDBOX} src={src} title={tab.title} referrerPolicy="no-referrer" />;
}

// ——— Сайт БалНета: DNS → подключение к серверу → содержимое ———

function WebTab({ tab, target, ctx }) {
  const [st, setSt] = useState({ phase: 'loading' });
  const latest = useRef(null);
  latest.current = { tab, ctx };
  // Новый запрос — только при смене хоста, схемы или перезагрузке: переходы внутри сайта DNS не трогают.
  const key = `${target.scheme}|${target.host}|${tab.reloadKey}`;
  useEffect(() => {
    let alive = true;
    const { tab: tb, ctx: c } = latest.current;
    setSt({ phase: 'loading', key });
    const t0 = performance.now();
    const origin = `${target.scheme}://${target.host}`;
    c.loadJar(origin).then((jar) => openUrl(tb.url, c.net, jar, tb.ref, c.push.permOf(origin))).then(async (r) => {
      if (!alive) return;
      const total = Math.round(performance.now() - t0);
      if (r.failed) {
        const code = r.failed === 'maintenance' ? 'maintenance' : r.failed === 'error' ? 'ERR_BALNET_UNREACHABLE' : r.failed;
        setSt({ phase: 'failed', code, key });
        c.setConn(tb.id, null);
        c.logNet(tb.id, { url: tb.url, host: target.host, failed: code, message: r.message, total });
        return;
      }
      const d = r.data;
      if (d.ok && target.scheme === 'https' && !d.tls) {
        // На сервере нет сертификата (порт 443 закрыт). Как Chrome с автопереходом на HTTPS: откат на http —
        // кроме сайтов из списка HSTS, им http запрещён.
        if (HSTS_PRELOAD.has(target.host)) {
          setSt({ phase: 'done', d: { ...d, ok: false, code: 'ERR_CONNECTION_REFUSED' }, key });
          c.logNet(tb.id, { ...d, ok: false, code: 'ERR_CONNECTION_REFUSED', lease: r.lease, total });
          return;
        }
        c.logNet(tb.id, { ...d, lease: r.lease, total, note: 'https на сервере нет — переход на http' });
        c.replaceUrl(tb.id, tb.url.replace(/^https:/, 'http:'));
        return;
      }
      let cert = null;
      if (d.ok && d.tls) {
        try { cert = await checkTls(d.tls, target.host); } catch (e) { cert = { ok: false, code: 'ERR_CERT_INVALID', message: e.message }; }
        if (!alive) return;
      }
      // Безопасный просмотр: префиксы хешей адреса против списка ВлодПоиска (госсайты не проверяются).
      const sb = d.ok && !d.gov ? await checkSafe(tb.url) : null;
      if (!alive) return;
      const conn = { ok: d.ok, gov: !!d.gov, ip: d.ip, host: target.host, cert, tls: d.tls || null, unsafe: sb };
      c.setConn(tb.id, conn);
      c.logNet(tb.id, { ...d, lease: r.lease, total, cert, safe: sb });
      if (sb && !isSafeBypassed(target.host)) {
        setSt({ phase: 'unsafe', d, sb, key });
        return;
      }
      if (cert && !cert.ok && !isBypassed(target.host, cert.hash)) {
        setSt({ phase: 'certerror', d, cert, key });
        return;
      }
      setSt({ phase: 'done', d, key });
    });
    return () => { alive = false; };
  }, [key, target.host, target.scheme]);

  const reload = () => ctx.reload(tab.id);
  if (!ctx.online) return <ErrorPage code="ERR_INTERNET_DISCONNECTED" onReload={reload} ctx={ctx} />;
  // Ответ, полученный для другого сайта (до смены адреса), не показываем — иначе старый фрейм получит новый путь.
  if (st.phase === 'loading' || st.key !== key) {
    return <div className="bp-page bp-connecting"><span className="bp-spinner" aria-hidden /> Подключение к {target.host}…</div>;
  }
  if (st.phase === 'failed') {
    if (st.code === 'maintenance') return <MaintenancePage onReload={() => { ctx.refreshClock(); reload(); }} />;
    return <ErrorPage code={st.code} host={target.host} onReload={reload} ctx={ctx} />;
  }
  if (st.phase === 'unsafe') {
    return (
      <SafeBrowsingPage
        host={target.host}
        url={tab.url}
        verdict={st.sb}
        onBack={() => ctx.navigate(NEW_TAB, { tabId: tab.id })}
        onProceed={() => { addSafeBypass(target.host); ctx.reload(tab.id); }}
      />
    );
  }
  if (st.phase === 'certerror') {
    return (
      <>
        <CertErrorPage
          host={target.host}
          cert={st.cert}
          onBack={() => ctx.navigate(NEW_TAB, { tabId: tab.id })}
          onProceed={() => { addBypass(target.host, st.cert.hash); ctx.reload(tab.id); }}
          onShowCert={() => setSt((v) => ({ ...v, viewer: true }))}
        />
        {st.viewer && <CertViewer tls={st.d.tls} verdict={st.cert} host={target.host} onClose={() => setSt((v) => ({ ...v, viewer: false }))} />}
      </>
    );
  }
  const d = st.d;
  if (!d.ok) return <ErrorPage code={d.code} host={target.host} onReload={reload} ctx={ctx} ip={d.ip} dns={d.dns} />;
  if (d.target?.startsWith('site:') && d.ticket) {
    return <SiteFrame tab={tab} ticket={d.ticket} origin={`${target.scheme}://${target.host}`} path={target.path} ctx={ctx} />;
  }
  if (d.target?.startsWith('app:')) {
    return (
      <GovFrame
        tab={tab}
        app={d.target.slice(4)}
        host={target.host}
        path={target.path}
        theme={ctx.theme}
        onFrameNav={(url) => ctx.navigate(url, { tabId: tab.id })}
        onTitle={(title) => ctx.setTitle(tab.id, title)}
        onOpen={(url, newTab) => ctx.navigate(url, newTab ? { newTab: true, referrer: tab.url } : { tabId: tab.id })}
        onSignIn={ctx.incognito ? null : ctx.signIn}
      />
    );
  }
  return <ErrorPage code="HTTP_404_NO_VHOST" host={target.host} onReload={reload} ctx={ctx} />;
}

// ——— Содержимое вкладки ———

function TabContent({ tab, ctx }) {
  const t = resolveTarget(tab.url);
  const reload = () => ctx.reload(tab.id);
  switch (t.kind) {
    case 'internal':
      if (t.page === 'newtab') return <NewTabPage key={tab.reloadKey} ctx={ctx} />;
      if (t.page === 'history') return <HistoryPage key={tab.reloadKey} ctx={ctx} />;
      if (t.page === 'bookmarks') return <BookmarksPage key={tab.reloadKey} ctx={ctx} />;
      if (t.page === 'settings') return <SettingsPage key={tab.reloadKey} ctx={ctx} />;
      if (t.page === 'about') return <AboutPage key={tab.reloadKey} />;
      if (t.page === 'terminal') return <TerminalPage key={tab.reloadKey} ctx={ctx} />;
      if (t.page === 'notifications') return <NotificationsPage key={tab.reloadKey} ctx={ctx} />;
      return <GamePage key={tab.reloadKey} />;
    case 'web':
      return <WebTab tab={tab} target={t} ctx={ctx} />;
    default:
      return <ErrorPage key={tab.reloadKey} code={t.code} host={t.host} onReload={reload} ctx={ctx} />;
  }
}

// ——— Адресная строка ———

function AddressBar({ tab, inputRef, ctx }) {
  const [text, setText] = useState('');
  const [focus, setFocus] = useState(false);
  const [sel, setSel] = useState(0);
  const [info, setInfo] = useState(false);
  const [viewer, setViewer] = useState(false);
  const [keys, setKeys] = useState(false);
  const sec = securityOf(tab);
  const tabOrigin = (() => { const t = resolveTarget(tab.url); return t.kind === 'web' ? `${t.scheme}://${t.host}` : null; })();
  const saved = tabOrigin && tab.conn?.loginForm ? ctx.passwords.filter((p) => p.origin === tabOrigin) : [];

  useEffect(() => { if (!focus) setText(displayUrl(tab.url)); }, [tab.url, focus]);

  const suggestions = useMemo(() => {
    const q = text.trim().toLowerCase();
    if (!focus || !q) return [];
    const go = parseInput(text);
    const first = resolveTarget(go).kind === 'search'
      ? { url: go, label: `${text.trim()} — Искать во ВлодПоиске`, icon: '🔍' }
      : { url: go, label: displayUrl(go), icon: '🌐' };
    const seen = new Set([go]);
    const out = [first];
    const pool = [
      ...Object.entries(GOV_SITES).map(([h, s]) => ({ url: `https://${h}/`, title: s.title })),
      ...ctx.bookmarks,
      ...ctx.history,
    ];
    for (const p of pool) {
      if (out.length >= 7) break;
      if (seen.has(p.url) || p.url.startsWith('balnet://newtab')) continue;
      if (`${p.title} ${p.url}`.toLowerCase().includes(q)) {
        seen.add(p.url);
        out.push({ url: p.url, label: p.title ? `${p.title} — ${displayUrl(p.url)}` : displayUrl(p.url), icon: null });
      }
    }
    return out;
  }, [text, focus, ctx.bookmarks, ctx.history]);

  const submit = (url) => {
    if (!url) return;
    ctx.navigate(url, { typed: true }); // набран вручную — без Referer, прямой заход
    setFocus(false);
    inputRef.current?.blur();
  };

  const bookmarked = ctx.bookmarks.some((b) => b.url === tab.url);
  const canBookmark = tab.url !== NEW_TAB;

  return (
    <div className={`bb-omnibox ${focus ? 'is-focus' : ''}`}>
      <button
        className={`bb-chip bb-chip-${sec.kind}`}
        onClick={() => setInfo((v) => !v)}
        title={sec.kind === 'gov' ? 'Сведения о сайте' : 'Сведения'}
        aria-label="Сведения о сайте"
      >
        {sec.kind === 'gov' ? <>🛡<span className="bb-chip-text">{sec.label}</span></>
          : sec.kind === 'internal' ? <CoatOfArms size={14} />
            : sec.kind === 'secure' ? <span aria-label="Подключение защищено">🔒</span>
              : sec.kind === 'insecure' || sec.kind === 'danger' ? <>⚠<span className="bb-chip-text">{sec.label}</span></> : 'ⓘ'}
      </button>
      {info && (
        <>
          <div className="bb-backdrop" onClick={() => setInfo(false)} />
          <div className="bb-popover bb-siteinfo" role="dialog" aria-label="Сведения о сайте">
            {sec.kind === 'gov' && (
              <>
                <b className="bb-ok">🛡 Проверенный госсайт БФ</b>
                <p>{sec.host} — официальный сайт. Владелец: {sec.owner}.</p>
                <p>Сервер: {sec.ip} (госдата-центр).</p>
                <p className="bp-muted">Значок ставит ВлодБраузер: сервер — госсервер, сертификат {sec.cert.ev ? 'EV ' : ''}выдан «{sec.cert.issuer}» для «{sec.cert.org}». Копия сайта по другому адресу значка не получит.</p>
              </>
            )}
            {sec.kind === 'secure' && (
              <>
                <b className="bb-ok">🔒 Подключение защищено</b>
                <p>Данные (пароли, номера карт) передаются на {sec.host} в зашифрованном виде.</p>
                <p>Сертификат действителен. Выдан: {sec.cert.issuer}.{sec.cert.org ? ` Владелец: ${sec.cert.org}${sec.cert.ev ? ' (EV)' : ''}.` : ' Проверен только домен (DV) — кто владелец, неизвестно.'}</p>
              </>
            )}
            {sec.kind === 'danger' && sec.unsafe && (
              <>
                <b className="bb-bad">⛔ Опасный сайт</b>
                <p>Сайт в списке Безопасного просмотра ВлодПоиска ({sec.unsafe.threat === 'phishing' ? 'фишинг' : 'вредоносное ПО'}). Вы перешли на него, несмотря на предупреждение. Не вводите здесь пароли и данные карт.</p>
              </>
            )}
            {sec.kind === 'danger' && !sec.unsafe && (
              <>
                <b className="bb-bad">⚠ Подключение не защищено</b>
                <p>{CERT_ERRORS[sec.cert.code] || 'Сертификат недействителен'} ({sec.cert.code}). Вы перешли на сайт, несмотря на предупреждение. Не вводите здесь пароли и данные карт.</p>
              </>
            )}
            {sec.tls && <p><button className="bp-link" onClick={() => { setInfo(false); setViewer(true); }}>📄 Сертификат</button>{sec.cert?.ocsp ? ` · статус: ${sec.cert.ocsp === 'good' ? 'не отозван' : 'отозван'}` : ''}</p>}
            {sec.kind === 'internal' && <p>Это страница ВлодБраузера.</p>}
            {sec.kind === 'insecure' && <p><b>Соединение не защищено.</b> Сайт {sec.host} открыт по http: всё, что вы вводите, видно провайдеру и любому на пути. Не вводите здесь пароли.</p>}
            {sec.kind === 'none' && <p>{sec.host ? `Сайт ${sec.host}${sec.ip ? `, сервер ${sec.ip}` : ''}.` : `Сайт не открыт: ${displayUrl(tab.url) || 'пустая вкладка'}.`}</p>}
          </div>
        </>
      )}
      {viewer && sec.tls && <CertViewer tls={sec.tls} verdict={sec.cert} host={sec.host} onClose={() => setViewer(false)} />}
      <input
        ref={inputRef}
        className="bb-url"
        value={text}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        aria-label="Адрес и поиск"
        placeholder="Введите адрес или запрос для ВлодПоиска"
        onChange={(e) => { setText(e.target.value); setSel(0); }}
        onFocus={(e) => { setFocus(true); setText(tab.url === NEW_TAB ? '' : tab.url); const el = e.target; setTimeout(() => el.select(), 0); }}
        onBlur={() => setTimeout(() => setFocus(false), 150)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel((s) => Math.min(suggestions.length - 1, s + 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((s) => Math.max(0, s - 1)); }
          else if (e.key === 'Enter') { e.preventDefault(); submit(suggestions[sel]?.url || parseInput(text)); }
          else if (e.key === 'Escape') { setText(displayUrl(tab.url)); e.target.blur(); }
        }}
      />
      {saved.length > 0 && (
        <button className="bb-icon" title="Заполнить сохранённым паролем" aria-label="Пароли" onClick={() => setKeys((v) => !v)}>🔑</button>
      )}
      {keys && (
        <>
          <div className="bb-backdrop" onClick={() => setKeys(false)} />
          <div className="bb-popover bb-menu bb-keys" role="menu">
            <p className="bb-menu-note">Сохранённые пароли для {sec.host}</p>
            {saved.map((p) => (
              <button key={p.username} role="menuitem" onClick={() => { setKeys(false); if (!fillPassword(tab.id, p)) window.alert('На странице нет формы входа'); }}>
                <span>👤 {p.username || '(без имени)'}</span><span className="bp-muted">••••••</span>
              </button>
            ))}
          </div>
        </>
      )}
      {canBookmark && (
        <button
          className={`bb-icon ${bookmarked ? 'is-on' : ''}`}
          onClick={() => ctx.toggleBookmark(tab.url, tab.title)}
          title={bookmarked ? 'Удалить закладку' : 'Добавить в закладки (Ctrl+D)'}
          aria-label={bookmarked ? 'Удалить закладку' : 'Добавить в закладки'}
        >{bookmarked ? '★' : '☆'}</button>
      )}
      {focus && suggestions.length > 0 && (
        <ul className="bb-suggest" role="listbox">
          {suggestions.map((s, i) => (
            <li key={s.url} role="option" aria-selected={i === sel}>
              <button className={i === sel ? 'is-sel' : ''} onMouseDown={(e) => { e.preventDefault(); submit(s.url); }}>
                {s.icon ? <span className="bb-sug-icon">{s.icon}</span> : <Favicon url={s.url} />}
                <span className="bp-ellipsis">{s.label}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ——— Браузер ———

export default function App() {
  const [theme, toggleTheme] = useTheme();
  const [profiles, setProfiles] = useState(null);
  const [profileId, setProfileId] = useState(null);
  const [incognito, setIncognito] = useState(false);
  const [data, setData] = useState(null);
  const [clock, setClock] = useState(null);
  const [online, setOnline] = useState(() => navigator.onLine !== false);
  const [menu, setMenu] = useState(null); // 'main' | 'profile' | null
  const [grid, setGrid] = useState(false);
  const [devtools, setDevtools] = useState(false);
  const [netLog, setNetLog] = useState({}); // id вкладки → записи журнала сети
  const [account, setAccount] = useState(null); // аккаунт ВлодБраузера: { token, login, address, name, key? }
  const [syncState, setSyncState] = useState({ status: 'idle' });
  const [pwPrompt, setPwPrompt] = useState(null);
  const inputRef = useRef(null);

  const storeKey = profileId ? `${profileId}:${incognito ? 'incognito' : 'main'}` : null;
  const store = useMemo(() => (profileId ? profileStore(profileId, incognito) : null), [profileId, incognito]);

  // Профили
  useEffect(() => {
    (async () => {
      const list = await loadProfiles();
      const active = await loadActiveProfile();
      setProfiles(list);
      setProfileId(list.some((p) => p.id === active) ? active : list[0].id);
    })();
  }, []);

  // Данные профиля
  useEffect(() => {
    if (!store) return undefined;
    let alive = true;
    setData(null);
    (async () => {
      const [history, bookmarks, settings, session, passwords, acc, syncKey] = await Promise.all([
        store.get('history', []), store.get('bookmarks', []), store.get('settings', {}), store.get('session', null),
        store.get('passwords', []), store.get('account', null), store.get('syncKey', null),
      ]);
      if (alive) setAccount(acc && !incognito ? { ...acc, key: syncKey || null } : null);
      const s = { ...DEFAULT_SETTINGS, ...settings, net: { ...DEFAULT_NET, ...(settings.net || {}) } };
      if (!s.net.clientId) s.net.clientId = newClientId(); // «устройство» профиля: ему провайдер выдаёт IP
      let tabs;
      let activeId;
      if (!incognito && s.restoreSession && session?.tabs?.length) {
        tabs = session.tabs.map((t) => ({ ...t, reloadKey: 0 }));
        activeId = tabs.some((t) => t.id === session.activeId) ? session.activeId : tabs[0].id;
      } else {
        tabs = [makeTab(incognito ? NEW_TAB : s.home)];
        activeId = tabs[0].id;
      }
      const start = takeUrlFromHash();
      if (start) {
        const t = makeTab(start);
        // Пустую стартовую вкладку ссылка заменяет, к восстановленным — добавляется.
        tabs = tabs.length === 1 && tabs[0].url === NEW_TAB ? [t] : [...tabs, t];
        activeId = t.id;
      }
      if (alive) setData({ owner: storeKey, tabs, activeId, history, bookmarks, passwords, settings: s });
    })();
    return () => { alive = false; };
  }, [store, storeKey, incognito]);

  // Сохранение — только в хранилище того профиля, которому принадлежат данные.
  const own = data && data.owner === storeKey;
  useEffect(() => { if (own) store.set('history', data.history); }, [own, store, data?.history]);
  useEffect(() => { if (own) store.set('bookmarks', data.bookmarks); }, [own, store, data?.bookmarks]);
  useEffect(() => { if (own) store.set('settings', data.settings); }, [own, store, data?.settings]);
  useEffect(() => { if (own) store.set('passwords', data.passwords); }, [own, store, data?.passwords]);
  useEffect(() => {
    if (!own) return;
    const tabs = data.tabs.map(({ id, url, title, back, fwd }) => ({ id, url, title, back, fwd }));
    store.set('session', { tabs, activeId: data.activeId });
  }, [own, store, data?.tabs, data?.activeId]);

  // Игровое время: пауза = «БалНет на обслуживании».
  const refreshClock = useCallback(() => { get('/clock').then(setClock).catch(() => setClock(null)); }, []);
  useEffect(() => {
    refreshClock();
    const id = setInterval(refreshClock, 60000);
    return () => clearInterval(id);
  }, [refreshClock]);

  useEffect(() => {
    const on = () => setOnline(true);
    const off = () => setOnline(false);
    window.addEventListener('online', on);
    window.addEventListener('offline', off);
    return () => { window.removeEventListener('online', on); window.removeEventListener('offline', off); };
  }, []);

  const update = useCallback((fn) => setData((d) => (d ? fn(d) : d)), []);

  const navigate = useCallback((input, { tabId, newTab, typed = false, referrer = null } = {}) => {
    let url = input;
    if (!url) return;
    const target = resolveTarget(url);
    if (target.kind === 'upgrade') url = target.url;
    const title = titleFor(url);
    update((d) => {
      let { tabs, activeId, history } = d;
      if (newTab) {
        const t = { ...makeTab(url), ref: /^https?:/.test(referrer || '') ? referrer : null };
        tabs = [...tabs, t];
        activeId = t.id;
      } else {
        const id = tabId || activeId;
        const cur = tabs.find((t) => t.id === id);
        if (!cur || cur.url === url) return d;
        // Откуда пришли (для Referer): страница вкладки, если переход по ссылке, а не набран вручную.
        const ref = typed ? null : referrer || (/^https?:/.test(cur.url) ? cur.url : null);
        tabs = tabs.map((t) => (t.id !== id ? t : { ...t, back: [...t.back, t.url].slice(-MAX_BACK), fwd: [], url, title, ref }));
      }
      if (!incognito && url !== NEW_TAB) history = [{ url, title, ts: Date.now() }, ...history].slice(0, HISTORY_LIMIT);
      return { ...d, tabs, activeId, history };
    });
    setMenu(null);
    setGrid(false);
  }, [update, incognito]);

  // Уведомления и push сайтов (этап Н10): разрешения — в настройках профиля.
  const selectRef = useRef(null);
  const setPerms = useCallback((perms) => update((d) => ({ ...d, settings: { ...d.settings, notifPerms: perms } })), [update]);
  const selectById = useCallback((id) => selectRef.current?.(id), []);
  const push = useBalnetPush({
    store: data && data.owner === storeKey ? store : null,
    incognito,
    perms: data?.settings.notifPerms,
    setPerms,
    navigate,
    selectTab: selectById,
    label: profiles?.find((p) => p.id === profileId)?.name,
  });

  // Клик по системному уведомлению открывает /#<адрес> — открываем его в новой вкладке.
  useEffect(() => {
    const on = () => { const u = takeUrlFromHash(); if (u) navigate(u, { newTab: true }); };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, [navigate]);

  const setTitle = useCallback((tabId, title) => update((d) => {
    const tab = d.tabs.find((t) => t.id === tabId);
    if (!tab || tab.title === title) return d;
    const tabs = d.tabs.map((t) => (t.id === tabId ? { ...t, title } : t));
    const history = d.history[0]?.url === tab.url ? [{ ...d.history[0], title }, ...d.history.slice(1)] : d.history;
    return { ...d, tabs, history };
  }), [update]);

  const setConn = useCallback((tabId, conn) => update((d) => ({ ...d, tabs: d.tabs.map((t) => (t.id === tabId ? { ...t, conn } : t)) })), [update]);
  const patchConn = useCallback((tabId, p) => update((d) => ({ ...d, tabs: d.tabs.map((t) => (t.id === tabId && t.conn ? { ...t, conn: { ...t.conn, ...p } } : t)) })), [update]);

  // ——— Аккаунт ВлодБраузера и синхронизация ———
  const dataRef = useRef(null);
  dataRef.current = data;
  const signIn = useCallback(async () => {
    if (!store || incognito) throw new Error('В инкогнито вход в аккаунт браузера недоступен');
    const prof = (await loadProfiles()).find((p) => p.id === profileId);
    const r = await apiPost('/mail/sync/devices', { name: `ВлодБраузер · ${prof?.name || 'профиль'} · ${/Mobi/.test(navigator.userAgent) ? 'телефон' : 'компьютер'}` });
    const acc = { token: r.token, login: r.account.login, address: r.account.address, name: r.account.name, keyInfo: r.key };
    await store.set('account', acc);
    await store.remove('syncKey');
    setAccount({ ...acc, key: null });
    return acc;
  }, [store, incognito, profileId]);
  const signOut = useCallback(async () => {
    if (account?.token) await apiPost('/mail/sync/signout', { token: account.token }).catch(() => {});
    await Promise.all(['account', 'syncKey', 'syncBase:bookmarks', 'syncBase:history', 'syncBase:passwords'].map((k) => store.remove(k)));
    setAccount(null);
    setSyncState({ status: 'idle' });
  }, [account, store]);
  const runSync = useCallback(async (acc = account) => {
    if (!acc?.key || !store) return;
    setSyncState((x) => ({ ...x, status: 'syncing' }));
    try {
      const r = await syncAll({
        token: acc.token,
        key: acc.key,
        read: async (name) => dataRef.current?.[name] || [],
        write: async (name, list) => update((d) => ({ ...d, [name]: list })),
        readBase: (name) => store.get(`syncBase:${name}`, null),
        writeBase: (name, list) => store.set(`syncBase:${name}`, list),
      });
      setSyncState({ status: 'ok', at: Date.now(), result: r });
    } catch (e) {
      if (e.status === 401) { await Promise.all(['account', 'syncKey'].map((k) => store.remove(k))); setAccount(null); }
      setSyncState({ status: 'error', at: Date.now(), error: e.message });
    }
  }, [account, store, update]);
  /** Кодовая фраза: задать новую (первое устройство) или ввести существующую. */
  const setPhrase = useCallback(async (phrase) => {
    const st = await apiPost('/mail/sync/status', { token: account.token });
    let key;
    if (st.key) {
      key = await unlock(phrase, st.key);
      if (!key) throw new Error('Неверная кодовая фраза');
    } else {
      const made = await createPhrase(phrase);
      await apiPost('/mail/sync/key', { token: account.token, salt: made.salt, iterations: made.iterations, check: made.check });
      key = made.key;
    }
    await store.set('syncKey', key);
    const acc = { ...account, key, keyInfo: st.key };
    setAccount(acc);
    await runSync(acc);
  }, [account, store, runSync]);
  // Синхронизация при запуске, раз в минуту и вскоре после правки закладок и паролей.
  const syncRef = useRef(runSync);
  syncRef.current = runSync;
  const hasKey = !!account?.key;
  useEffect(() => {
    if (!hasKey) return undefined;
    syncRef.current();
    const id = setInterval(() => syncRef.current(), 60000);
    return () => clearInterval(id);
  }, [hasKey]);
  useEffect(() => {
    if (!hasKey) return undefined;
    const t = setTimeout(() => syncRef.current(), 3000);
    return () => clearTimeout(t);
  }, [hasKey, data?.bookmarks, data?.passwords]);

  // ——— Пароли ———
  const savePassword = useCallback((cred) => update((d) => ({
    ...d, passwords: [{ origin: cred.origin, username: cred.username, password: cred.password, updated: Date.now() }, ...(d.passwords || []).filter((p) => !(p.origin === cred.origin && p.username === cred.username))],
  })), [update]);
  const offerPassword = useCallback((cred) => {
    if (incognito) return;
    const d = dataRef.current;
    const never = d?.settings?.neverSave || [];
    if (never.includes(cred.origin)) return;
    if ((d?.passwords || []).some((p) => p.origin === cred.origin && p.username === cred.username && p.password === cred.password)) return;
    setPwPrompt(cred);
  }, [incognito]);
  // Сменить адрес вкладки без новой записи в истории «Назад» (переход https → http у сайтов без сертификата).
  const replaceUrl = useCallback((tabId, url) => update((d) => ({
    ...d,
    tabs: d.tabs.map((t) => (t.id === tabId ? { ...t, url, title: titleFor(url) } : t)),
    history: d.history[0] && d.history[0].url.replace(/^https:/, 'http:') === url ? [{ ...d.history[0], url }, ...d.history.slice(1)] : d.history,
  })), [update]);
  // Cookies и localStorage сайтов игроков — в хранилище профиля (в инкогнито — только в памяти).
  const loadJar = useCallback((origin) => (store ? store.get(`site:${origin}`, {}) : Promise.resolve({})), [store]);
  const saveJar = useCallback((origin, jar) => { if (store) store.set(`site:${origin}`, jar); }, [store]);
  const logNet = useCallback((tabId, entry) => setNetLog((m) => ({
    ...m, [tabId]: [...(m[tabId] || []), { id: `${Date.now()}-${Math.random()}`, ts: Date.now(), ...entry }].slice(-NET_LOG_LIMIT),
  })), []);

  const step = (tabId, dir) => update((d) => ({
    ...d,
    tabs: d.tabs.map((t) => {
      if (t.id !== tabId) return t;
      if (dir < 0 && t.back.length) return { ...t, url: t.back[t.back.length - 1], back: t.back.slice(0, -1), fwd: [t.url, ...t.fwd], title: titleFor(t.back[t.back.length - 1]) };
      if (dir > 0 && t.fwd.length) return { ...t, url: t.fwd[0], fwd: t.fwd.slice(1), back: [...t.back, t.url], title: titleFor(t.fwd[0]) };
      return t;
    }),
  }));

  const reload = useCallback((tabId) => {
    refreshClock();
    update((d) => ({ ...d, tabs: d.tabs.map((t) => (t.id === tabId ? { ...t, reloadKey: t.reloadKey + 1 } : t)) }));
  }, [update, refreshClock]);

  const openTab = (url = NEW_TAB) => {
    const t = makeTab(url);
    update((d) => ({ ...d, tabs: [...d.tabs, t], activeId: t.id }));
    setMenu(null);
    if (url === NEW_TAB) setTimeout(() => inputRef.current?.focus(), 50);
  };

  const closeTab = (tabId) => update((d) => {
    const i = d.tabs.findIndex((t) => t.id === tabId);
    let tabs = d.tabs.filter((t) => t.id !== tabId);
    if (!tabs.length) tabs = [makeTab(NEW_TAB)];
    const activeId = d.activeId === tabId ? tabs[Math.min(i, tabs.length - 1)].id : d.activeId;
    return { ...d, tabs, activeId };
  });

  const selectTab = (tabId) => { update((d) => ({ ...d, activeId: tabId })); setGrid(false); };
  selectRef.current = selectTab;

  // Закладки
  const setBookmarks = (fn) => update((d) => ({ ...d, bookmarks: fn(d.bookmarks) }));
  const toggleBookmark = (url, title) => setBookmarks((b) => (b.some((x) => x.url === url) ? b.filter((x) => x.url !== url) : [...b, { url, title: title || displayUrl(url) }]));

  // Профили
  const switchProfile = (id) => { saveActiveProfile(id); setIncognito(false); setProfileId(id); setMenu(null); };
  const addProfile = async () => {
    const id = `p${Date.now().toString(36)}`;
    const list = [...profiles, { id, name: `Профиль ${profiles.length + 1}`, color: PROFILE_COLORS[profiles.length % PROFILE_COLORS.length] }];
    await saveProfiles(list);
    setProfiles(list);
    switchProfile(id);
  };
  const renameProfile = async (id, name) => {
    const list = profiles.map((p) => (p.id === id ? { ...p, name } : p));
    await saveProfiles(list);
    setProfiles(list);
  };
  const deleteProfile = async (id) => {
    const list = profiles.filter((p) => p.id !== id);
    await saveProfiles(list);
    await Promise.all(['history', 'bookmarks', 'settings', 'session', 'passwords', 'account', 'syncKey', 'syncBase:bookmarks', 'syncBase:history', 'syncBase:passwords'].map((k) => removeItem(`${id}:${k}`)));
    setProfiles(list);
  };

  const active = data?.tabs.find((t) => t.id === data.activeId) || data?.tabs[0];

  useEffect(() => {
    document.title = active ? `${active.title} — ВлодБраузер${incognito ? ' (инкогнито)' : ''}` : 'ВлодБраузер';
  }, [active, incognito]);

  // Горячие клавиши (работают, когда фокус в оболочке, а не внутри сайта).
  const keys = useRef(null);
  keys.current = (e) => {
    if (!active) return;
    const mod = e.ctrlKey || e.metaKey;
    const k = e.key.toLowerCase();
    if (mod && k === 'l') { e.preventDefault(); inputRef.current?.focus(); }
    else if (mod && k === 'd') { e.preventDefault(); toggleBookmark(active.url, active.title); }
    else if (mod && k === 'h') { e.preventDefault(); navigate('balnet://history/', { newTab: true }); }
    else if (mod && k === 'r') { e.preventDefault(); reload(active.id); }
    else if (e.key === 'F5') { e.preventDefault(); reload(active.id); }
    else if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); step(active.id, -1); }
    else if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); step(active.id, 1); }
    else if (e.altKey && k === 't') { e.preventDefault(); openTab(); }
    else if (e.altKey && k === 'w') { e.preventDefault(); closeTab(active.id); }
    else if (e.key === 'F12' || (mod && e.shiftKey && k === 'i')) { e.preventDefault(); setDevtools((v) => !v); }
  };
  useEffect(() => {
    const on = (e) => keys.current(e);
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, []);

  if (!data || !profiles || !active) return <div className="bb-loading"><CoatOfArms size={48} /> ВлодБраузер…</div>;

  const profile = profiles.find((p) => p.id === profileId);
  const ctx = {
    navigate,
    reload,
    setTitle,
    refreshClock,
    clock,
    online,
    theme,
    toggleTheme,
    incognito,
    history: data.history,
    bookmarks: data.bookmarks,
    settings: data.settings,
    setSettings: (s) => update((d) => ({ ...d, settings: s })),
    net: data.settings.net,
    setNet: (n) => update((d) => ({ ...d, settings: { ...d.settings, net: { ...d.settings.net, ...n } } })),
    setConn,
    patchConn,
    offerPassword,
    replaceUrl,
    account,
    syncState,
    signIn,
    signOut,
    setPhrase,
    syncNow: () => runSync(),
    passwords: data.passwords || [],
    removePassword: (p) => update((d) => ({ ...d, passwords: d.passwords.filter((x) => !(x.origin === p.origin && x.username === p.username)) })),
    savePassword,
    loadJar,
    saveJar,
    logNet,
    clearHistory: () => update((d) => ({ ...d, history: [] })),
    removeHistory: (h) => update((d) => ({ ...d, history: d.history.filter((x) => x !== h && !(x.ts === h.ts && x.url === h.url)) })),
    toggleBookmark,
    addBookmark: (url, title) => setBookmarks((b) => (b.some((x) => x.url === url) ? b : [...b, { url, title }])),
    removeBookmark: (url) => setBookmarks((b) => b.filter((x) => x.url !== url)),
    renameBookmark: (url, title) => setBookmarks((b) => b.map((x) => (x.url === url ? { ...x, title: title || x.title } : x))),
    moveBookmark: (url, dir) => setBookmarks((b) => {
      const i = b.findIndex((x) => x.url === url);
      const j = i + dir;
      if (i < 0 || j < 0 || j >= b.length) return b;
      const c = [...b];
      [c[i], c[j]] = [c[j], c[i]];
      return c;
    }),
    push,
    selectTab,
    profiles,
    profileId,
    switchProfile,
    addProfile,
    renameProfile,
    deleteProfile,
  };

  const avatar = incognito
    ? <span className="bp-avatar bb-incog-avatar" title="Инкогнито">🕶</span>
    : <span className="bp-avatar" style={{ background: profile?.color }}>{profile?.name[0]}</span>;

  const menuItems = [
    ['Новая вкладка', 'Alt+T', () => openTab()],
    incognito ? ['Выйти из инкогнито', '', () => { setIncognito(false); setMenu(null); }] : ['Новое окно инкогнито', '', () => { setIncognito(true); setMenu(null); }],
    null,
    ['История', 'Ctrl+H', () => navigate('balnet://history/', { newTab: true })],
    ['Закладки', '', () => navigate('balnet://bookmarks/', { newTab: true })],
    ['Терминал', '', () => navigate('balnet://terminal/', { newTab: true })],
    ['Уведомления', push.unread ? <span className="bb-menu-badge">{push.unread}</span> : '', () => navigate('balnet://notifications/', { newTab: true })],
    [devtools ? 'Закрыть инструменты разработчика' : 'Инструменты разработчика', 'F12', () => { setDevtools((v) => !v); setMenu(null); }],
    ['Курьер БалНета', '', () => navigate('balnet://game/', { newTab: true })],
    null,
    ['Сообщить об обманном сайте', '', () => {
      setMenu(null);
      const t = resolveTarget(active?.url || '');
      if (t.kind !== 'web') { window.alert('Откройте сайт, о котором хотите сообщить.'); return; }
      const comment = window.prompt(`Сообщить ВлодПоиску, что ${t.host} — обманный сайт (фишинг)? Можно добавить комментарий:`, '');
      if (comment === null) return;
      reportPhishing(active.url, comment).then(() => window.alert('Спасибо! Сайт проверит администрация БалНета.'), (e) => window.alert(e.message));
    }],
    [theme === 'dark' ? 'Светлая тема' : 'Тёмная тема', '', () => { toggleTheme(); setMenu(null); }],
    ['Настройки', '', () => navigate('balnet://settings/', { newTab: true })],
    ['Все приложения (без браузера)', '', () => { location.href = `${BASE}apps/`; }],
    ['О ВлодБраузере', '', () => navigate('balnet://about/', { newTab: true })],
  ];

  return (
    <div className={`bb ${incognito ? 'is-incognito' : ''}`}>
      <div className="bb-tabstrip" role="tablist" aria-label="Вкладки">
        {data.tabs.map((t) => (
          <div
            key={t.id}
            role="tab"
            aria-selected={t.id === active.id}
            className={`bb-tab ${t.id === active.id ? 'is-active' : ''}`}
            onMouseDown={(e) => { if (e.button === 1) { e.preventDefault(); closeTab(t.id); } }}
            onClick={() => selectTab(t.id)}
            title={t.title}
          >
            {t.url === NEW_TAB || t.url.startsWith('balnet://') ? <CoatOfArms size={14} /> : <Favicon url={t.url} />}
            <span className="bb-tab-title">{t.title}</span>
            <button className="bb-tab-close" aria-label={`Закрыть вкладку ${t.title}`} onClick={(e) => { e.stopPropagation(); closeTab(t.id); }}>✕</button>
          </div>
        ))}
        <button className="bb-newtab" onClick={() => openTab()} title="Новая вкладка (Alt+T)" aria-label="Новая вкладка">+</button>
        <span className="bb-grow" />
        <button className="bb-profile" onClick={() => setMenu(menu === 'profile' ? null : 'profile')} aria-label="Профиль">{avatar}</button>
      </div>

      <div className="bb-toolbar">
        <button className="bb-icon" disabled={!active.back.length} onClick={() => step(active.id, -1)} title="Назад (Alt+←)" aria-label="Назад">←</button>
        <button className="bb-icon bb-hide-m" disabled={!active.fwd.length} onClick={() => step(active.id, 1)} title="Вперёд (Alt+→)" aria-label="Вперёд">→</button>
        <button className="bb-icon bb-hide-m" onClick={() => reload(active.id)} title="Перезагрузить (Ctrl+R)" aria-label="Перезагрузить">↻</button>
        <button className="bb-icon" onClick={() => navigate(data.settings.home)} title="Домой" aria-label="Домой">⌂</button>
        <AddressBar tab={active} inputRef={inputRef} ctx={ctx} />
        <button className="bb-icon bb-show-m bb-tabcount" onClick={() => setGrid(true)} aria-label={`Вкладки: ${data.tabs.length}`}>{data.tabs.length > 99 ? ':D' : data.tabs.length}</button>
        <button className="bb-icon bb-show-m bb-profile" onClick={() => setMenu(menu === 'profile' ? null : 'profile')} aria-label="Профиль">{avatar}</button>
        <button className="bb-icon" onClick={() => setMenu(menu === 'main' ? null : 'main')} title="Меню" aria-label="Меню">⋮</button>
      </div>

      {data.settings.bookmarksBar && data.bookmarks.length > 0 && (
        <div className="bb-bookmarks" aria-label="Панель закладок">
          {data.bookmarks.map((b) => (
            <button key={b.url} className="bb-bm" onClick={() => navigate(b.url)} title={b.url}>
              <Favicon url={b.url} /><span>{b.title}</span>
            </button>
          ))}
        </div>
      )}

      {pwPrompt && (
        <PasswordPrompt
          cred={pwPrompt}
          onSave={() => { savePassword(pwPrompt); setPwPrompt(null); }}
          onNever={() => { update((d) => ({ ...d, settings: { ...d.settings, neverSave: [...(d.settings.neverSave || []), pwPrompt.origin] } })); setPwPrompt(null); }}
          onClose={() => setPwPrompt(null)}
        />
      )}

      <div className={`bb-main ${devtools ? 'with-devtools' : ''}`}>
        <div className="bb-views">
          {data.tabs.map((t) => (
            <div key={t.id} className="bb-view" hidden={t.id !== active.id}>
              <TabContent tab={t} ctx={ctx} />
            </div>
          ))}
        </div>
        {devtools && <DevTools log={netLog[active.id] || []} tab={active} onClear={() => setNetLog((m) => ({ ...m, [active.id]: [] }))} onClose={() => setDevtools(false)} />}
      </div>

      <nav className="bb-bottombar" aria-label="Навигация">
        <button className="bb-icon" disabled={!active.back.length} onClick={() => step(active.id, -1)} aria-label="Назад">←</button>
        <button className="bb-icon" disabled={!active.fwd.length} onClick={() => step(active.id, 1)} aria-label="Вперёд">→</button>
        <button className="bb-icon" onClick={() => openTab()} aria-label="Новая вкладка">＋</button>
        <button className="bb-icon" onClick={() => reload(active.id)} aria-label="Перезагрузить">↻</button>
        <button className="bb-icon" onClick={() => setMenu('main')} aria-label="Меню">⋮</button>
      </nav>

      {(() => {
        const pr = push.prompts.find((x) => x.tabId === active.id);
        return pr ? <PermissionPrompt prompt={pr} onAnswer={push.answerPrompt} /> : null;
      })()}
      <PushToasts items={push.toasts} onClick={push.clickToast} onClose={push.dropToast} />

      {menu && <div className="bb-backdrop" onClick={() => setMenu(null)} />}
      {menu === 'main' && (
        <div className="bb-popover bb-menu" role="menu">
          {menuItems.map((m, i) => (m ? (
            <button key={m[0]} role="menuitem" onClick={m[2]}><span>{m[0]}</span><span className="bp-muted">{m[1]}</span></button>
          ) : <hr key={`sep${i}`} />))}
        </div>
      )}
      {menu === 'profile' && (
        <div className="bb-popover bb-menu bb-profile-menu" role="menu">
          {incognito ? <p className="bb-menu-note">🕶 Режим инкогнито</p> : <p className="bb-menu-note">Профиль: <b>{profile?.name}</b><br />{account ? <>✉ {account.address}{account.key ? (syncState.status === 'error' ? ' · ⚠ ошибка синхронизации' : ' · синхронизация включена') : ' · нужна кодовая фраза'}</> : 'Вход в аккаунт не выполнен'}</p>}
          {!incognito && !account && <button role="menuitem" onClick={() => navigate('balnet://settings/', { newTab: true })}>Войти через ВлодПочту</button>}
          {profiles.map((p) => (
            <button key={p.id} role="menuitem" onClick={() => switchProfile(p.id)}>
              <span><span className="bp-avatar bp-avatar-sm" style={{ background: p.color }}>{p.name[0]}</span> {p.name}</span>
              {p.id === profileId && !incognito && <span>✓</span>}
            </button>
          ))}
          <hr />
          <button role="menuitem" onClick={() => { setMenu(null); addProfile(); }}>Добавить профиль</button>
          {incognito
            ? <button role="menuitem" onClick={() => { setIncognito(false); setMenu(null); }}>Выйти из инкогнито</button>
            : <button role="menuitem" onClick={() => { setIncognito(true); setMenu(null); }}>Инкогнито</button>}
          <button role="menuitem" onClick={() => navigate('balnet://settings/', { newTab: true })}>Управлять профилями</button>
        </div>
      )}

      {grid && (
        <div className="bb-grid" role="dialog" aria-label="Вкладки">
          <div className="bb-grid-head">
            <b>Вкладки ({data.tabs.length})</b>
            <button className="bp-btn" onClick={() => { openTab(); setGrid(false); }}>＋ Новая</button>
            <button className="bp-btn" onClick={() => setGrid(false)}>Готово</button>
          </div>
          <div className="bb-grid-list">
            {data.tabs.map((t) => (
              <div key={t.id} className={`bb-grid-card ${t.id === active.id ? 'is-active' : ''}`}>
                <button className="bb-grid-open" onClick={() => selectTab(t.id)}>
                  <Favicon url={t.url} size={28} />
                  <b className="bp-ellipsis">{t.title}</b>
                  <span className="bp-muted bp-ellipsis">{displayUrl(t.url) || 'Новая вкладка'}</span>
                </button>
                <button className="bb-tab-close" onClick={() => closeTab(t.id)} aria-label={`Закрыть ${t.title}`}>✕</button>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
