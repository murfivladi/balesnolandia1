// ВлодБраузер — оболочка (этап Н1): вкладки, адресная строка, история, закладки, профили, инкогнито.
// Госсайты (bank.bln, gosuslugi.gov.bln, kassa.bln) — это существующие приложения проекта во фрейме того же origin.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { get } from '../shared/api.js';
import { useTheme } from '../shared/ui.jsx';
import { CoatOfArms } from '../shared/brand.jsx';
import {
  NEW_TAB, INTERNAL_PAGES, GOV_SITES, SEARCH_HOST, parseInput, resolveTarget, govAppPath, govUrlFromApp, displayUrl,
} from '@bln/shared/balnet-url.js';
import {
  profileStore, loadProfiles, saveProfiles, loadActiveProfile, saveActiveProfile, removeItem, PROFILE_COLORS, HISTORY_LIMIT,
} from './store.js';
import {
  NewTabPage, HistoryPage, BookmarksPage, SettingsPage, AboutPage, GamePage, SearchPage, ErrorPage, MaintenancePage, Favicon,
} from './pages.jsx';

const BASE = import.meta.env.BASE_URL;
const DEFAULT_SETTINGS = { home: NEW_TAB, bookmarksBar: true, restoreSession: true };
const MAX_BACK = 50;

let seq = 0;
const newId = () => `t${Date.now().toString(36)}${(seq++).toString(36)}`;

function titleFor(url) {
  const t = resolveTarget(url);
  if (t.kind === 'internal') return INTERNAL_PAGES[t.page];
  if (t.kind === 'gov') return t.site.title;
  if (t.kind === 'search') return t.query ? `${t.query} — ВлодПоиск` : 'ВлодПоиск';
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

/** Что показать в «замке» слева от адреса. */
function securityOf(url) {
  const t = resolveTarget(url);
  if (t.kind === 'gov') return { kind: 'gov', label: 'Госсайт БФ', owner: t.site.owner, host: t.host };
  if (t.kind === 'search') return { kind: 'gov', label: 'Госсайт БФ', owner: 'Правительство БФ', host: SEARCH_HOST };
  if (t.kind === 'internal') return { kind: 'internal', label: 'ВлодБраузер' };
  return { kind: 'none', label: '' };
}

/** Адрес фрейма → адрес БалНета: /bank/#/cards → https://bank.bln/cards */
function frameUrl(loc) {
  const rel = loc.pathname.startsWith(BASE) ? loc.pathname.slice(BASE.length) : loc.pathname.replace(/^\//, '');
  return govUrlFromApp(rel.split('/')[0], loc.hash);
}

// ——— Госсайт во фрейме ———

function GovFrame({ tab, target, theme, onFrameNav, onTitle }) {
  const ref = useRef(null);
  const cb = useRef({ onFrameNav, onTitle });
  useEffect(() => { cb.current = { onFrameNav, onTitle }; });
  const src = BASE + govAppPath(target.host, target.path);

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
      const sync = () => {
        const url = frameUrl(w.location);
        if (url) cb.current.onFrameNav(url);
        if (w.document.title) cb.current.onTitle(w.document.title);
      };
      w.addEventListener('hashchange', sync);
      sync();
    } catch { /* ignore */ }
  };

  return <iframe key={tab.reloadKey} ref={ref} className="bb-frame" src={src} title={tab.title} onLoad={onLoad} />;
}

// ——— Содержимое вкладки ———

function TabContent({ tab, ctx }) {
  const t = resolveTarget(tab.url);
  const reload = () => ctx.reload(tab.id);
  const net = t.kind === 'gov' || t.kind === 'search';
  if (net && ctx.clock?.paused) return <MaintenancePage onReload={() => { ctx.refreshClock(); reload(); }} />;
  if (net && !ctx.online) return <ErrorPage key={tab.reloadKey} code="ERR_INTERNET_DISCONNECTED" onReload={reload} ctx={ctx} />;
  switch (t.kind) {
    case 'internal':
      if (t.page === 'newtab') return <NewTabPage key={tab.reloadKey} ctx={ctx} />;
      if (t.page === 'history') return <HistoryPage key={tab.reloadKey} ctx={ctx} />;
      if (t.page === 'bookmarks') return <BookmarksPage key={tab.reloadKey} ctx={ctx} />;
      if (t.page === 'settings') return <SettingsPage key={tab.reloadKey} ctx={ctx} />;
      if (t.page === 'about') return <AboutPage key={tab.reloadKey} />;
      return <GamePage key={tab.reloadKey} />;
    case 'search':
      return <SearchPage key={tab.reloadKey} ctx={ctx} query={t.query} />;
    case 'gov':
      return (
        <GovFrame
          tab={tab}
          target={t}
          theme={ctx.theme}
          onFrameNav={(url) => ctx.navigate(url, { tabId: tab.id })}
          onTitle={(title) => ctx.setTitle(tab.id, title)}
        />
      );
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
  const sec = securityOf(tab.url);

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
    ctx.navigate(url);
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
        {sec.kind === 'gov' ? <>🛡<span className="bb-chip-text">{sec.label}</span></> : sec.kind === 'internal' ? <CoatOfArms size={14} /> : 'ⓘ'}
      </button>
      {info && (
        <>
          <div className="bb-backdrop" onClick={() => setInfo(false)} />
          <div className="bb-popover bb-siteinfo" role="dialog" aria-label="Сведения о сайте">
            {sec.kind === 'gov' && (
              <>
                <b className="bb-ok">🛡 Проверенный госсайт БФ</b>
                <p>{sec.host} — официальный сайт. Владелец: {sec.owner}.</p>
                <p className="bp-muted">Этот значок рисует ВлодБраузер, а не сайт. Копия сайта по другому адресу значка не получит.</p>
              </>
            )}
            {sec.kind === 'internal' && <p>Это страница ВлодБраузера.</p>}
            {sec.kind === 'none' && <p>Сайт не открыт: {displayUrl(tab.url) || 'пустая вкладка'}.</p>}
          </div>
        </>
      )}
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
      const [history, bookmarks, settings, session] = await Promise.all([
        store.get('history', []), store.get('bookmarks', []), store.get('settings', {}), store.get('session', null),
      ]);
      const s = { ...DEFAULT_SETTINGS, ...settings };
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
      if (alive) setData({ owner: storeKey, tabs, activeId, history, bookmarks, settings: s });
    })();
    return () => { alive = false; };
  }, [store, storeKey, incognito]);

  // Сохранение — только в хранилище того профиля, которому принадлежат данные.
  const own = data && data.owner === storeKey;
  useEffect(() => { if (own) store.set('history', data.history); }, [own, store, data?.history]);
  useEffect(() => { if (own) store.set('bookmarks', data.bookmarks); }, [own, store, data?.bookmarks]);
  useEffect(() => { if (own) store.set('settings', data.settings); }, [own, store, data?.settings]);
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

  const navigate = useCallback((input, { tabId, newTab } = {}) => {
    let url = input;
    if (!url) return;
    const target = resolveTarget(url);
    if (target.kind === 'upgrade') url = target.url;
    const title = titleFor(url);
    update((d) => {
      let { tabs, activeId, history } = d;
      if (newTab) {
        const t = makeTab(url);
        tabs = [...tabs, t];
        activeId = t.id;
      } else {
        const id = tabId || activeId;
        const cur = tabs.find((t) => t.id === id);
        if (!cur || cur.url === url) return d;
        tabs = tabs.map((t) => (t.id !== id ? t : { ...t, back: [...t.back, t.url].slice(-MAX_BACK), fwd: [], url, title }));
      }
      if (!incognito && url !== NEW_TAB) history = [{ url, title, ts: Date.now() }, ...history].slice(0, HISTORY_LIMIT);
      return { ...d, tabs, activeId, history };
    });
    setMenu(null);
    setGrid(false);
  }, [update, incognito]);

  const setTitle = useCallback((tabId, title) => update((d) => {
    const tab = d.tabs.find((t) => t.id === tabId);
    if (!tab || tab.title === title) return d;
    const tabs = d.tabs.map((t) => (t.id === tabId ? { ...t, title } : t));
    const history = d.history[0]?.url === tab.url ? [{ ...d.history[0], title }, ...d.history.slice(1)] : d.history;
    return { ...d, tabs, history };
  }), [update]);

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
    await Promise.all(['history', 'bookmarks', 'settings', 'session'].map((k) => removeItem(`${id}:${k}`)));
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
    ['Курьер БалНета', '', () => navigate('balnet://game/', { newTab: true })],
    null,
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

      <div className="bb-views">
        {data.tabs.map((t) => (
          <div key={t.id} className="bb-view" hidden={t.id !== active.id}>
            <TabContent tab={t} ctx={ctx} />
          </div>
        ))}
      </div>

      <nav className="bb-bottombar" aria-label="Навигация">
        <button className="bb-icon" disabled={!active.back.length} onClick={() => step(active.id, -1)} aria-label="Назад">←</button>
        <button className="bb-icon" disabled={!active.fwd.length} onClick={() => step(active.id, 1)} aria-label="Вперёд">→</button>
        <button className="bb-icon" onClick={() => openTab()} aria-label="Новая вкладка">＋</button>
        <button className="bb-icon" onClick={() => reload(active.id)} aria-label="Перезагрузить">↻</button>
        <button className="bb-icon" onClick={() => setMenu('main')} aria-label="Меню">⋮</button>
      </nav>

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
          {incognito ? <p className="bb-menu-note">🕶 Режим инкогнито</p> : <p className="bb-menu-note">Профиль: <b>{profile?.name}</b></p>}
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
