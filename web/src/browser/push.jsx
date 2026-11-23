// Уведомления и push во ВлодБраузере (этап Н10).
// — Разрешение «Показывать уведомления» спрашивает оболочка, по каждому сайту и профилю (как Chrome).
//   В инкогнито — автоматический отказ, на http — Push API нет.
// — new Notification() и registration.showNotification() со страницы сайта показывает оболочка.
// — PushManager.subscribe(): «устройство» профиля в push-сервисе push.bln, подписка сайта (endpoint + ключи).
//   Сообщения от серверов сайтов приходят по WebSocket, а с настоящим Web Push — и на телефон, когда браузер закрыт.
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { post } from '../shared/api.js';
import { subscribe as wsSubscribe } from '../shared/ws.js';
import { pushSupport, subscribePush, swRegistration, currentSubscription } from '../shared/push.js';
import { Favicon } from './pages.jsx';

const LOG_LIMIT = 100;
const TOAST_MS = 8000;
const hostOf = (o) => { try { return new URL(o).host; } catch { return String(o || ''); } };
const sameOriginUrl = (raw, origin) => {
  try {
    const u = new URL(String(raw || '/'), `${origin}/`);
    return u.origin === origin ? u.href : `${origin}/`;
  } catch { return `${origin}/`; }
};

/** Сообщение в фрейм сайта (shim слушает __balnetShell). */
function toFrame(win, msg) {
  try { win?.postMessage({ __balnetShell: 1, ...msg }, '*'); } catch { /* фрейм закрыт */ }
}

/** Показать системное уведомление через service worker (когда вкладка браузера скрыта). */
async function osNotify(title, body, url, tag) {
  try {
    if (!('Notification' in window) || Notification.permission !== 'granted') return;
    const reg = await swRegistration();
    await reg.showNotification(title, { body, tag: tag || undefined, data: { url: `${location.origin}${import.meta.env.BASE_URL}#${url}` }, icon: `${import.meta.env.BASE_URL}icons/services-192.png` });
  } catch { /* нет service worker */ }
}

export function useBalnetPush({ store, incognito, perms, setPerms, navigate, selectTab, label }) {
  const [device, setDevice] = useState(null);
  const [log, setLog] = useState([]);
  const [toasts, setToasts] = useState([]);
  const [prompts, setPrompts] = useState([]);
  const frames = useRef(new Map()); // id вкладки → { win, origin, ticket }
  const live = useRef({});
  live.current = { device, perms, incognito, store };

  useEffect(() => {
    let alive = true;
    setDevice(null);
    setLog([]);
    if (!store) return undefined;
    Promise.all([store.get('push:device', null), store.get('push:log', [])]).then(([d, l]) => {
      if (!alive) return;
      setDevice(d);
      setLog(Array.isArray(l) ? l : []);
    });
    return () => { alive = false; };
  }, [store]);

  const saveDevice = useCallback((d) => { setDevice(d); live.current.store?.set('push:device', d); }, []);
  const addLog = useCallback((items) => setLog((cur) => {
    const seen = new Set(cur.map((x) => x.id));
    const next = [...items.filter((x) => !seen.has(x.id)).map((x) => ({ ...x, unread: true })).reverse(), ...cur].slice(0, LOG_LIMIT);
    live.current.store?.set('push:log', next);
    return next;
  }), []);
  const markRead = useCallback(() => setLog((cur) => {
    const next = cur.map((x) => (x.unread ? { ...x, unread: false } : x));
    live.current.store?.set('push:log', next);
    return next;
  }), []);
  const clearLog = useCallback(() => { setLog([]); live.current.store?.set('push:log', []); }, []);

  const devCall = useCallback(async (path, body = {}) => {
    const d = live.current.device;
    if (!d) throw new Error('Push в этом профиле ещё не включён');
    try {
      return await post(`/net/push/${path}`, { device: d.id, token: d.token, ...body });
    } catch (e) {
      if (e.status === 403) { saveDevice(null); live.current.store?.remove('push:device'); }
      throw e;
    }
  }, [saveDevice]);

  const ensureDevice = useCallback(async () => {
    if (live.current.device) return live.current.device;
    if (live.current.incognito) throw Object.assign(new Error('В режиме инкогнито push недоступен'), { name: 'NotAllowedError' });
    const d = await post('/net/push/device', { label });
    const dev = { id: d.id, token: d.token, web: false };
    live.current.device = dev;
    saveDevice(dev);
    return dev;
  }, [label, saveDevice]);

  // ——— Тосты ———
  const dropToast = useCallback((key, reason = 'close') => setToasts((list) => {
    const t = list.find((x) => x.key === key);
    if (t?.nid && reason === 'close') toFrame(frames.current.get(t.tabId)?.win, { type: 'notif-event', nid: t.nid, event: 'close' });
    return list.filter((x) => x.key !== key);
  }), []);
  const showToast = useCallback((t) => {
    const key = `${Date.now()}-${Math.random()}`;
    setToasts((list) => [...list.filter((x) => !(t.tag && x.origin === t.origin && x.tag === t.tag)), { ...t, key }].slice(-4));
    setTimeout(() => dropToast(key, 'timeout'), TOAST_MS);
  }, [dropToast]);
  const clickToast = useCallback((t) => {
    dropToast(t.key, 'click');
    const f = t.tabId && frames.current.get(t.tabId);
    if (t.nid && f) {
      selectTab(t.tabId);
      toFrame(f.win, { type: 'notif-event', nid: t.nid, event: 'click' });
      return;
    }
    navigate(t.url || `${t.origin}/`, { newTab: true });
  }, [dropToast, navigate, selectTab]);

  // ——— Входящие push: WebSocket + очередь при запуске ———
  const deviceId = device?.id;
  const deviceToken = device?.token;
  useEffect(() => {
    if (!deviceId) return undefined;
    let alive = true;
    const pull = () => post('/net/push/inbox', { device: deviceId, token: deviceToken, after: 0 })
      .then((r) => { if (alive) addLog(r.messages.map((m) => ({ ...m, ts: Date.parse(m.created_at) || Date.now() }))); })
      .catch((e) => { if (e.status === 403 && alive) { saveDevice(null); live.current.store?.remove('push:device'); } });
    pull();
    const off = wsSubscribe(`push:${deviceId}`, (m) => {
      if (m.type !== 'push' || !m.message) return;
      const msg = { ...m.message, ts: Date.now() };
      if (msg.id) addLog([msg]);
      if (document.visibilityState === 'visible') showToast({ origin: msg.origin, title: msg.title, body: msg.body, url: msg.url, tag: msg.tag });
      else if (!live.current.device?.web) osNotify(msg.title, `${hostOf(msg.origin)}${msg.body ? ` — ${msg.body}` : ''}`, msg.url, msg.tag);
    }, undefined, deviceToken);
    return () => { alive = false; off(); };
  }, [deviceId, deviceToken, addLog, showToast, saveDevice]);

  // ——— Разрешения ———
  const permOf = useCallback((origin) => (/^https:/.test(origin) ? (live.current.perms?.[origin] || 'default') : 'denied'), []);

  const setPermission = useCallback(async (origin, value) => {
    const prev = live.current.perms?.[origin] || 'default';
    const next = { ...(live.current.perms || {}) };
    if (value === 'granted' || value === 'denied') next[origin] = value; else delete next[origin];
    live.current.perms = next;
    setPerms(next);
    const shown = value || 'default';
    for (const f of frames.current.values()) {
      if (f.origin !== origin) continue;
      toFrame(f.win, { type: 'perm', permission: shown });
      post('/net/jar', { ticket: f.ticket, notifications: shown }).catch(() => {});
    }
    // Как в Chrome: без разрешения подписка на push сайта отменяется.
    if (prev === 'granted' && shown !== 'granted' && live.current.device) await devCall('unsubscribe', { origin }).catch(() => {});
  }, [setPerms, devCall]);

  const askPermission = useCallback((tabId, origin) => new Promise((resolve) => {
    if (live.current.incognito) { setTimeout(() => resolve('denied'), 1500); return; } // инкогнито: отказ без вопроса, как Chrome
    const cur = permOf(origin);
    if (cur !== 'default') { resolve(cur); return; }
    setPrompts((list) => (list.some((p) => p.origin === origin && p.tabId === tabId)
      ? list.map((p) => (p.origin === origin && p.tabId === tabId ? { ...p, waiters: [...p.waiters, resolve] } : p))
      : [...list, { key: `${tabId}|${origin}`, tabId, origin, waiters: [resolve] }]));
  }), [permOf]);

  const answerPrompt = useCallback(async (p, value) => {
    setPrompts((list) => list.filter((x) => x.key !== p.key));
    if (value) await setPermission(p.origin, value);
    p.waiters.forEach((w) => w(value || 'default'));
  }, [setPermission]);

  // ——— Сообщения от shim ———
  const onFrameMessage = useCallback(async (m, { tabId, origin, win }) => {
    const reply = (result, extra = {}) => toFrame(win, { type: 'reply', id: m.id, result, permission: permOf(origin), ...extra });
    const fail = (e, name) => toFrame(win, { type: 'reply', id: m.id, error: e.message || String(e), errorName: name || e.name || 'Error', permission: permOf(origin) });
    const secure = /^https:/.test(origin);
    switch (m.type) {
      case 'perm-request':
        if (!secure) return reply('denied');
        return reply(await askPermission(tabId, origin));
      case 'notify': {
        if (permOf(origin) !== 'granted') return undefined;
        const n = { origin, title: String(m.title || hostOf(origin)).slice(0, 200), body: String(m.body || '').slice(0, 1000), url: sameOriginUrl(m.url, origin), tag: m.tag || null, tabId, nid: m.nid };
        if (document.visibilityState === 'visible') showToast(n);
        else osNotify(n.title, `${hostOf(origin)}${n.body ? ` — ${n.body}` : ''}`, n.url, n.tag);
        return undefined;
      }
      case 'notify-close':
        setToasts((list) => list.filter((x) => !(x.nid === m.nid && x.tabId === tabId)));
        return toFrame(win, { type: 'notif-event', nid: m.nid, event: 'close' });
      case 'push-subscribe': {
        if (!secure) return fail(new Error('Push API доступен только на https'), 'NotSupportedError');
        if (live.current.incognito) return fail(new Error('В режиме инкогнито push недоступен'), 'NotAllowedError');
        const perm = await askPermission(tabId, origin);
        if (perm !== 'granted') return fail(new Error('Registration failed - permission denied'), 'NotAllowedError');
        try {
          await ensureDevice();
          const r = await devCall('subscribe', { origin, applicationServerKey: m.applicationServerKey || undefined });
          return reply(r.subscription);
        } catch (e) {
          return fail(e, e.code === 'push_invalid_state' ? 'InvalidStateError' : e.code === 'push_key' ? 'InvalidAccessError' : 'AbortError');
        }
      }
      case 'push-get':
        if (!live.current.device || !secure) return reply(null);
        try { return reply((await devCall('subscription', { origin })).subscription); } catch { return reply(null); }
      case 'push-unsubscribe':
        if (!live.current.device) return reply(false);
        try { return reply((await devCall('unsubscribe', { origin })).removed); } catch (e) { return fail(e); }
      default:
        return undefined;
    }
  }, [askPermission, devCall, ensureDevice, permOf, showToast]);

  const dropFrame = useCallback((tabId) => frames.current.delete(tabId), []);
  const seenFrame = useCallback((tabId, f) => frames.current.set(tabId, f), []);

  // ——— Настоящий Web Push для push БалНета (телефон, закрытый браузер) ———
  const enableWeb = useCallback(async () => {
    const d = await ensureDevice();
    const sub = await subscribePush();
    await devCall('device/web', { subscription: sub.toJSON() });
    saveDevice({ ...d, web: true });
  }, [ensureDevice, devCall, saveDevice]);
  const disableWeb = useCallback(async () => {
    await devCall('device/web', { subscription: null });
    saveDevice({ ...live.current.device, web: false });
  }, [devCall, saveDevice]);
  // Подписка браузера могла смениться (переустановка, очистка данных) — обновим её у устройства.
  useEffect(() => {
    if (!device?.web) return;
    currentSubscription().then((sub) => {
      if (sub) devCall('device/web', { subscription: sub.toJSON() }).catch(() => {});
      else saveDevice({ ...live.current.device, web: false });
    });
  }, [device?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const unread = useMemo(() => log.filter((x) => x.unread).length, [log]);

  return {
    device, log, unread, toasts, prompts, markRead, clearLog,
    permOf, setPermission, answerPrompt, onFrameMessage, dropFrame, seenFrame, clickToast, dropToast,
    enableWeb, disableWeb, subs: () => devCall('subs').then((r) => r.subs),
    forget: async () => { if (live.current.device) await devCall('device/delete').catch(() => {}); saveDevice(null); live.current.store?.remove('push:device'); },
  };
}

// ——— Интерфейс ———

/** Запрос разрешения под адресной строкой, как в Chrome. */
export function PermissionPrompt({ prompt, onAnswer }) {
  return (
    <div className="bb-popover bb-perm" role="dialog" aria-label="Запрос разрешения">
      <p><b>{hostOf(prompt.origin)}</b> запрашивает разрешение на:</p>
      <p className="bb-perm-what">🔔 Показ уведомлений</p>
      <div className="bb-perm-actions">
        <button className="bp-btn" onClick={() => onAnswer(prompt, 'denied')}>Блокировать</button>
        <button className="bp-btn bp-btn-primary" onClick={() => onAnswer(prompt, 'granted')}>Разрешить</button>
      </div>
      <button className="bb-perm-close" aria-label="Закрыть" onClick={() => onAnswer(prompt, null)}>✕</button>
    </div>
  );
}

export function PushToasts({ items, onClick, onClose }) {
  if (!items.length) return null;
  return (
    <div className="bb-toasts" aria-live="polite">
      {items.map((t) => (
        <div key={t.key} className="bb-toast" role="alert">
          <button className="bb-toast-main" onClick={() => onClick(t)}>
            <Favicon url={`${t.origin}/`} size={20} />
            <span className="bb-toast-text">
              <b className="bp-ellipsis">{t.title}</b>
              {t.body && <span>{t.body}</span>}
              <span className="bp-muted">{hostOf(t.origin)}</span>
            </span>
          </button>
          <button className="bb-tab-close" aria-label="Закрыть уведомление" onClick={() => onClose(t.key)}>✕</button>
        </div>
      ))}
    </div>
  );
}

const PERM_TITLES = { granted: 'Разрешено', denied: 'Заблокировано' };

/** balnet://notifications/ — полученные push, разрешения сайтов, Web Push на телефон. */
export function NotificationsPage({ ctx }) {
  const p = ctx.push;
  const [subs, setSubs] = useState(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const support = pushSupport();
  const perms = Object.entries(ctx.settings.notifPerms || {}).sort(([a], [b]) => a.localeCompare(b));
  useEffect(() => { p.markRead(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!p.device) { setSubs([]); return; }
    p.subs().then(setSubs, () => setSubs([]));
  }, [p.device?.id]); // eslint-disable-line react-hooks/exhaustive-deps
  const run = (fn) => async () => {
    setBusy(true); setError(null);
    try { await fn(); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  return (
    <div className="bp-page bp-list-page">
      <header className="bp-page-head"><h1>Уведомления</h1></header>
      <section className="bp-card">
        <h2>Push на это устройство</h2>
        {ctx.incognito ? <p className="bp-muted">В режиме инкогнито сайты не могут показывать уведомления.</p> : (
          <>
            <p>Сообщения сайтов БалНета приходят, пока открыт ВлодБраузер. Включите Web Push — и они придут на телефон или компьютер, даже когда браузер закрыт.</p>
            {p.device?.web
              ? <p><b className="bb-ok">✓ Web Push включён</b> <button className="bp-btn" disabled={busy} onClick={run(p.disableWeb)}>Выключить</button></p>
              : support.ok ? <button className="bp-btn bp-btn-primary" disabled={busy} onClick={run(p.enableWeb)}>Включить Web Push</button>
                : <p className="bp-muted">{support.reason}</p>}
            {error && <p className="bb-bad">{error}</p>}
          </>
        )}
      </section>
      <section className="bp-card">
        <h2>Сайты</h2>
        {!perms.length && <p className="bp-muted">Ни один сайт пока не спрашивал разрешения. Сайт попросит его сам — через Notification.requestPermission() или PushManager.subscribe().</p>}
        {perms.map(([origin, v]) => (
          <div key={origin} className="bp-row">
            <Favicon url={`${origin}/`} />
            <b className="bp-ellipsis">{hostOf(origin)}</b>
            <span className="bp-grow" />
            {subs?.some((s) => s.origin === origin) && <span className="bp-muted" title="Сайт подписан на push">📨 push</span>}
            <select value={v} aria-label={`Уведомления от ${hostOf(origin)}`} onChange={(e) => ctx.push.setPermission(origin, e.target.value === 'default' ? null : e.target.value)}>
              <option value="granted">{PERM_TITLES.granted}</option>
              <option value="denied">{PERM_TITLES.denied}</option>
              <option value="default">Спрашивать</option>
            </select>
          </div>
        ))}
      </section>
      <section className="bp-card">
        <h2>Полученные push-сообщения</h2>
        {!p.log.length && <p className="bp-muted">Пока ничего. Сервер сайта отправляет сообщение на адрес подписки https://push.bln/send/… — подробности на push.bln.</p>}
        {p.log.map((m) => (
          <button key={m.id} className="bp-row bp-row-btn" onClick={() => ctx.navigate(m.url || `${m.origin}/`, { newTab: true })}>
            <Favicon url={`${m.origin}/`} />
            <span className="bb-toast-text">
              <b>{m.title}</b>
              {m.body && <span>{m.body}</span>}
              <span className="bp-muted">{hostOf(m.origin)} · {new Date(m.ts).toLocaleString('ru-RU')}{m.encrypted ? ' · 🔒 aes128gcm' : ''}</span>
            </span>
          </button>
        ))}
        {p.log.length > 0 && <button className="bp-btn" onClick={p.clearLog}>Очистить</button>}
        {p.device && <p className="bp-muted">Устройство push БалНета №{p.device.id}. <button className="bp-link" onClick={() => { if (confirm('Отключить push в этом профиле? Все подписки сайтов будут отменены.')) p.forget(); }}>Отключить push в профиле</button></p>}
      </section>
    </div>
  );
}
