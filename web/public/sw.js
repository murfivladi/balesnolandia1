// Service worker Балесноландии: приложения ставятся как PWA и открываются без сети
// (деньги и данные — только онлайн: API не кешируется).
const CACHE = 'bln-v2';
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

// Web Push (этап 9): показ уведомлений, пришедших с сервера.
self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { data = { title: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Балесноландия', { body: data.body || '', icon: './icons/services-192.png', data: { url: data.url } }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  if (e.notification.data?.url) e.waitUntil(self.clients.openWindow(e.notification.data.url));
});
