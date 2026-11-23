// Service worker Балесноландии: приложения ставятся как PWA и открываются без сети
// (деньги и данные — только онлайн: API не кешируется).
const CACHE = 'bln-v3';
const SHELLS = ['./', './apps/', './bank/', './pos/', './services/', './admin/'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELLS).catch(() => {})).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  if (req.method !== 'GET' || url.origin !== location.origin || url.pathname.includes('/api/')) return;
  if (req.mode === 'navigate') {
    // Страницы — сначала сеть, без сети — последняя сохранённая версия.
    e.respondWith(fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    }).catch(() => caches.match(req).then((r) => r || caches.match('./'))));
    return;
  }
  if (url.pathname.includes('/assets/') || url.pathname.includes('/icons/')) {
    // Файлы сборки с хешем в имени — из кеша.
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(req, copy));
      return res;
    })));
  }
});

// Web Push (этап Н10): уведомления ВлодБанка, ВлодУслуг и сайтов БалНета приходят, даже когда приложение закрыто.
// Тело расшифровывает сам браузер (aes128gcm), здесь — JSON { title, body, url, app, tag }.
const ICONS = { bank: 'icons/bank-192.png', services: 'icons/services-192.png', browser: 'icons/services-192.png' };

// Приложение открыто и в фокусе — оно само покажет уведомление (по WebSocket), второе системное не нужно.
async function focusedApp(app) {
  const path = new URL(app === 'browser' ? './' : `./${app}/`, self.registration.scope).pathname;
  const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  return wins.some((w) => w.focused && w.visibilityState === 'visible' && new URL(w.url).pathname === path);
}

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { body: e.data ? e.data.text() : '' }; }
  const icon = new URL(ICONS[data.app] || ICONS.services, self.registration.scope).href;
  e.waitUntil(focusedApp(data.app).catch(() => false).then((skip) => skip ? null : self.registration.showNotification(data.title || 'Балесноландия', {
    body: data.body || '',
    icon,
    badge: icon,
    tag: data.tag || undefined,
    renotify: !!data.tag,
    data: { url: data.url || self.registration.scope },
  })));
});

// Клик: если приложение уже открыто — переходим в нём, иначе открываем новое окно.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = e.notification.data?.url || self.registration.scope;
  e.waitUntil((async () => {
    const target = new URL(url, self.registration.scope);
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of wins) {
      const u = new URL(w.url);
      if (u.origin === target.origin && u.pathname === target.pathname && 'focus' in w) {
        await w.focus();
        if ('navigate' in w && w.url !== target.href) await w.navigate(target.href).catch(() => {});
        return;
      }
    }
    await self.clients.openWindow(target.href);
  })());
});
