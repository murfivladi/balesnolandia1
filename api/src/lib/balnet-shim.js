// Shim сайтов игроков: встраивается шлюзом в каждую HTML-страницу. Работает внутри sandbox (непрозрачный origin):
// - сообщает ВлодБраузеру адрес и заголовок страницы, перехватывает ссылки, формы и window.open на другие сайты;
// - эмулирует document.cookie, localStorage и sessionStorage по доменам БалНета (данные хранит браузер);
// - fetch к другим сайтам БалНета идёт через шлюз с проверкой CORS по правилам БалНета.
// Код ниже — строка: её отдаёт GET /api/net/shim.js. Без шаблонных строк и «${» внутри.
export const SHIM_JS = String.raw`(function () {
  'use strict';
  var C = window.__BALNET__ || {};
  var PREFIX = C.prefix || '';
  var ORIGIN = C.origin || '';
  var API = location.protocol + '//' + location.host;
  function post(msg) {
    msg.__balnet = 1;
    msg.ticket = C.ticket;
    try { parent.postMessage(msg, '*'); } catch (e) { /* нет родителя */ }
  }
  function originOf(u) { return u.protocol + '//' + u.host; }
  function inGateway(u) { return originOf(u) === API && u.pathname.indexOf(PREFIX) === 0; }
  function toBalnet(href) {
    var u = new URL(href, location.href);
    if (inGateway(u)) return ORIGIN + (u.pathname.slice(PREFIX.length) || '/') + u.search + u.hash;
    // Корневой путь сайта («/page»), который скрипт собрал сам, — это путь на сайте, а не на сервере шлюза.
    if (originOf(u) === API) return ORIGIN + u.pathname + u.search + u.hash;
    return u.href;
  }
  /** Адрес из скрипта сайта → адрес в шлюзе (свой сайт) или null (чужой сайт / другая схема). */
  function ownToGateway(href) {
    var u = new URL(href, location.href);
    if (inGateway(u)) return u.href;
    if (originOf(u) === API || originOf(u) === ORIGIN) return API + PREFIX + u.pathname + u.search + u.hash;
    return null;
  }
  function toGateway(href) {
    var u = new URL(href);
    return API + PREFIX + u.pathname + u.search + u.hash;
  }
  function report() { post({ type: 'nav', url: toBalnet(location.href), title: document.title || '' }); }

  // ——— Навигация ———
  document.addEventListener('click', function (e) {
    if (e.defaultPrevented || e.button !== 0) return;
    var a = e.target && e.target.closest ? e.target.closest('a[href]') : null;
    if (!a) return;
    var raw = a.getAttribute('href') || '';
    if (/^mailto:/i.test(raw)) {
      e.preventDefault();
      var addr = raw.slice(7).split('?')[0];
      post({ type: 'open', url: 'https://mail.bln/compose?to=' + encodeURIComponent(decodeURIComponent(addr)), newTab: true });
      return;
    }
    if (raw.charAt(0) === '#' || /^(javascript|tel|data|blob):/i.test(raw)) return;
    var u = new URL(a.href, location.href);
    var newTab = a.target === '_blank' || e.ctrlKey || e.metaKey || e.shiftKey;
    if (inGateway(u) && !newTab) return;
    e.preventDefault();
    post({ type: 'open', url: toBalnet(u.href), newTab: newTab });
  }, true);

  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || f.tagName !== 'FORM') return;
    var method = (f.getAttribute('method') || 'GET').toUpperCase();
    var u = new URL(f.action || location.href, location.href);
    if (method !== 'GET' || inGateway(u)) return;
    e.preventDefault();
    var params = new URLSearchParams(new FormData(f));
    u.search = params.toString();
    post({ type: 'open', url: u.href, newTab: f.target === '_blank' });
  }, true);

  // ——— Пароли: ВлодБраузер предлагает сохранить и подставляет сохранённые ———
  function loginFields(f) {
    var pw = f.querySelector('input[type=password]');
    if (!pw) return null;
    var user = null;
    var inputs = f.querySelectorAll('input');
    for (var i = 0; i < inputs.length; i++) {
      var t = (inputs[i].type || 'text').toLowerCase();
      if (inputs[i] === pw) break;
      if (t === 'text' || t === 'email' || t === 'tel') user = inputs[i];
    }
    return { pw: pw, user: user };
  }
  document.addEventListener('submit', function (e) {
    var f = e.target;
    if (!f || f.tagName !== 'FORM') return;
    var l = loginFields(f);
    if (l && l.pw.value) post({ type: 'credential', username: l.user ? l.user.value : '', password: l.pw.value });
  }, true);
  var announced = false;
  function findLogin() {
    if (announced || !document.querySelector) return;
    if (document.querySelector('input[type=password]')) { announced = true; post({ type: 'login-form' }); }
  }
  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var m = e.data;
    if (!m || m.__balnet !== 1 || m.ticket !== C.ticket || m.type !== 'fill') return;
    var pw = document.querySelector('input[type=password]');
    if (!pw) return;
    var l = loginFields(pw.form || document) || { pw: pw, user: null };
    function set(el, v) {
      var d = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
      if (d && d.set) d.set.call(el, v); else el.value = v;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    if (l.user && m.username) set(l.user, String(m.username));
    set(l.pw, String(m.password || ''));
  });
  if (window.MutationObserver) {
    var mo = new MutationObserver(function () { findLogin(); if (announced) mo.disconnect(); });
    if (document.documentElement) mo.observe(document.documentElement, { childList: true, subtree: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', findLogin); else setTimeout(findLogin, 0);

  window.open = function (url) {
    if (url) post({ type: 'open', url: toBalnet(String(url)), newTab: true });
    return null;
  };

  ['pushState', 'replaceState'].forEach(function (m) {
    var orig = history[m];
    history[m] = function (state, title, url) {
      var args = [state, title];
      if (url !== undefined && url !== null) {
        var g = ownToGateway(String(url));
        args.push(g || url);
      }
      var r = orig.apply(this, args);
      report();
      return r;
    };
  });
  window.addEventListener('popstate', report);
  window.addEventListener('hashchange', report);

  // ——— Cookies и хранилища (данные сайта хранит ВлодБраузер) ———
  var jar = C.cookies || {};
  var local = C.local || {};
  var syncTimer = null;
  function sync() {
    clearTimeout(syncTimer);
    syncTimer = setTimeout(function () { post({ type: 'jar', cookies: jar, local: local }); }, 30);
  }
  function cookieString() {
    var out = [];
    var t = Date.now();
    Object.keys(jar).forEach(function (k) {
      if (jar[k].exp && jar[k].exp < t) { delete jar[k]; return; }
      if (jar[k].h) return; // HttpOnly: видит только сервер
      out.push(k + '=' + jar[k].v);
    });
    return out.join('; ');
  }
  function setCookie(s) {
    var parts = String(s).split(';');
    var kv = parts.shift();
    var i = kv.indexOf('=');
    if (i < 0) return;
    var name = kv.slice(0, i).trim();
    var value = kv.slice(i + 1).trim();
    if (!name) return;
    var exp = null;
    parts.forEach(function (p) {
      var j = p.indexOf('=');
      var k = (j < 0 ? p : p.slice(0, j)).trim().toLowerCase();
      var v = j < 0 ? '' : p.slice(j + 1).trim();
      if (k === 'max-age') exp = Date.now() + Number(v) * 1000;
      if (k === 'expires' && exp === null) { var d = Date.parse(v); if (!isNaN(d)) exp = d; }
    });
    if (jar[name] && jar[name].h) return; // HttpOnly-cookie скрипт страницы менять не может
    if (exp !== null && exp <= Date.now()) delete jar[name];
    else jar[name] = { v: value, exp: exp };
    sync();
  }
  // Сервер сайта выставил cookies (Set-Cookie) — забираем их из шлюза и отдаём ВлодБраузеру.
  function refreshJar() {
    if (!origFetchJar) return;
    origFetchJar(API + '/api/net/jar/' + encodeURIComponent(C.ticket)).then(function (r) { return r.json(); }).then(function (res) {
      if (!res || !res.cookies) return;
      jar = res.cookies;
      sync();
    }).catch(function () { /* нет связи */ });
  }
  var origFetchJar = window.fetch ? window.fetch.bind(window) : null;
  if (C.jarDirty) sync();
  try { Object.defineProperty(document, 'cookie', { configurable: true, get: cookieString, set: setCookie }); } catch (e) { /* ignore */ }

  function makeStorage(d, persist) {
    var s = {
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(d, k) ? d[k] : null; },
      setItem: function (k, v) { d[String(k)] = String(v); if (persist) sync(); },
      removeItem: function (k) { delete d[k]; if (persist) sync(); },
      clear: function () { Object.keys(d).forEach(function (k) { delete d[k]; }); if (persist) sync(); },
      key: function (i) { var ks = Object.keys(d); return i < ks.length ? ks[i] : null; },
    };
    Object.defineProperty(s, 'length', { get: function () { return Object.keys(d).length; } });
    return s;
  }
  try { Object.defineProperty(window, 'localStorage', { configurable: true, value: makeStorage(local, true) }); } catch (e) { /* ignore */ }
  try { Object.defineProperty(window, 'sessionStorage', { configurable: true, value: makeStorage({}, false) }); } catch (e) { /* ignore */ }

  // ——— fetch по правилам БалНета ———
  var origFetch = window.fetch ? window.fetch.bind(window) : null;
  if (origFetch) {
    window.fetch = function (input, init) {
      var href = typeof input === 'string' ? input : (input && input.url) || String(input);
      var u = new URL(href, location.href);
      if (!/^https?:$/.test(u.protocol)) return origFetch(input, init);
      var own = ownToGateway(u.href);
      if (own) {
        return origFetch(typeof input === 'string' || input instanceof URL ? own : new Request(own, input), init).then(function (r) {
          if (r.headers.get('X-Balnet-Jar')) refreshJar();
          return r;
        });
      }
      var method = ((init && init.method) || (input && input.method) || 'GET').toUpperCase();
      var hdrs = {};
      var hsrc = (init && init.headers) || null;
      if (hsrc) {
        if (typeof hsrc.forEach === 'function' && !Array.isArray(hsrc)) hsrc.forEach(function (v, k) { hdrs[k] = v; });
        else if (Array.isArray(hsrc)) hsrc.forEach(function (p) { hdrs[p[0]] = p[1]; });
        else Object.keys(hsrc).forEach(function (k) { hdrs[k] = hsrc[k]; });
      }
      var raw = init && init.body;
      if (raw instanceof URLSearchParams) { hdrs['content-type'] = hdrs['content-type'] || 'application/x-www-form-urlencoded;charset=UTF-8'; raw = raw.toString(); }
      if (raw !== undefined && raw !== null && typeof raw !== 'string') raw = String(raw);
      return origFetch(API + '/api/net/xfetch', {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ ticket: C.ticket, url: u.href, method: method, headers: hdrs, body: raw === undefined ? null : raw }),
      }).then(function (r) { return r.json(); }).then(function (res) {
        if (!res || res.error) {
          if (window.console) console.error('[БалНет] ' + ((res && res.message) || 'Запрос заблокирован') + ': ' + u.href);
          throw new TypeError('Failed to fetch');
        }
        var bin = atob(res.body || '');
        var bytes = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
        return new Response(bytes, { status: res.status, headers: res.headers });
      });
    };
  }

  // XMLHttpRequest: свой сайт — через шлюз; к чужим сайтам — как в браузере без разрешения CORS (ошибка).
  if (window.XMLHttpRequest) {
    var xopen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function (method, url) {
      var args = Array.prototype.slice.call(arguments);
      var own = ownToGateway(String(url));
      if (own) args[1] = own;
      return xopen.apply(this, args);
    };
  }

  // ——— WebSocket: соединение идёт через шлюз, а он — по сети БалНета до сервера сайта ———
  var NativeWS = window.WebSocket;
  if (NativeWS) {
    var BalnetWS = function (url, protocols) {
      var u = new URL(String(url), toBalnet(location.href).replace(/^http/, 'ws'));
      if (!/^wss?:$/.test(u.protocol)) throw new SyntaxError('WebSocket: нужен адрес ws:// или wss://');
      var gw = API.replace(/^http/, 'ws') + '/api/net/sock/' + encodeURIComponent(C.ticket) + '?url=' + encodeURIComponent(u.href);
      var ws = protocols ? new NativeWS(gw, protocols) : new NativeWS(gw);
      try { Object.defineProperty(ws, 'url', { value: u.href }); } catch (e) { /* только чтение */ }
      return ws;
    };
    BalnetWS.CONNECTING = 0; BalnetWS.OPEN = 1; BalnetWS.CLOSING = 2; BalnetWS.CLOSED = 3;
    BalnetWS.prototype = NativeWS.prototype;
    window.WebSocket = BalnetWS;
  }

  // ——— Рекламная сеть ВлодПоиска: <ins class="vlodads"></ins> ———
  function fillAds() {
    if (!origFetch || !document.querySelectorAll) return;
    var slots = document.querySelectorAll('ins.vlodads:not([data-filled])');
    Array.prototype.forEach.call(slots, function (ins) {
      ins.setAttribute('data-filled', '1');
      var path = new URL(toBalnet(location.href)).pathname;
      origFetch(API + '/api/search/adnet/serve', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ ticket: C.ticket, path: path }) })
        .then(function (r) { return r.json(); }).then(function (res) {
          var ad = res && res.ad;
          if (!ad) return;
          var box = document.createElement('a');
          box.href = '#';
          box.setAttribute('style', 'display:block;border:1px solid #c9d3e6;border-radius:8px;padding:10px 12px;font:14px/1.4 system-ui,sans-serif;text-decoration:none;color:#121826;background:#fff;max-width:480px');
          var lab = document.createElement('div');
          lab.setAttribute('style', 'font-size:11px;color:#5b6475;margin-bottom:2px');
          lab.textContent = 'Реклама · ВлодПоиск · ' + ad.display;
          var t = document.createElement('div');
          t.setAttribute('style', 'color:#1f4fbf;font-size:16px;font-weight:600');
          t.textContent = ad.title;
          var d = document.createElement('div');
          d.textContent = ad.text;
          box.appendChild(lab); box.appendChild(t); box.appendChild(d);
          box.addEventListener('click', function (e) {
            e.preventDefault();
            e.stopPropagation();
            origFetch(API + '/api/search/adnet/click', { method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ ticket: C.ticket, token: ad.token }) })
              .then(function (r) { return r.json(); }).then(function (c) { if (c && c.url) post({ type: 'open', url: c.url, newTab: false }); });
          });
          ins.appendChild(box);
        }).catch(function () { /* реклама недоступна */ });
    });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', fillAds);
  else setTimeout(fillAds, 0);

  // ——— Уведомления и Push API (этап Н10) ———
  // Разрешение и показ решает ВлодБраузер: сайт просит через postMessage, оболочка отвечает в этот фрейм.
  // Push API — только в защищённом контексте (https), как в Chrome. Service worker сайта в БалНете не запускается:
  // push-сервис push.bln доставляет сообщение браузеру, и тот сам показывает уведомление из JSON {title, body, url}.
  var secure = /^https:/.test(ORIGIN);
  var perm = secure ? (C.notif || 'default') : 'denied';
  var waiting = {};
  var notes = {};
  var seqN = 0;
  function ask(msg) {
    var id = 'q' + (++seqN) + '_' + Date.now();
    msg.id = id;
    return new Promise(function (resolve, reject) {
      waiting[id] = { resolve: resolve, reject: reject };
      post(msg);
    });
  }
  window.addEventListener('message', function (e) {
    if (e.source !== parent) return;
    var m = e.data;
    if (!m || m.__balnetShell !== 1) return;
    if (m.type === 'perm') perm = m.permission;
    if (m.type === 'reply' && waiting[m.id]) {
      var w = waiting[m.id];
      delete waiting[m.id];
      if (m.permission) perm = m.permission;
      if (m.error) { var err = new Error(m.error); err.name = m.errorName || 'Error'; w.reject(err); } else w.resolve(m.result);
    }
    if (m.type === 'notif-event' && notes[m.nid]) {
      var n = notes[m.nid];
      var ev = new Event(m.event);
      if (m.event === 'click' && typeof n.onclick === 'function') n.onclick(ev);
      if (m.event === 'close' && typeof n.onclose === 'function') n.onclose(ev);
      n.dispatchEvent(ev);
      if (m.event === 'close') delete notes[m.nid];
    }
  });
  function warn(text) { if (window.console) console.warn('[БалНет] ' + text); }
  function showNote(title, opts, n) {
    opts = opts || {};
    if (perm !== 'granted') { warn('Уведомление не показано: нет разрешения (Notification.permission = "' + perm + '")'); return false; }
    var nid = 'n' + (++seqN);
    if (n) notes[nid] = n;
    post({ type: 'notify', nid: nid, title: String(title).slice(0, 200), body: opts.body == null ? '' : String(opts.body).slice(0, 1000), tag: opts.tag ? String(opts.tag).slice(0, 100) : null, url: opts.data && opts.data.url ? String(opts.data.url) : null });
    return nid;
  }
  var BalnetNotification = function (title, opts) {
    if (!(this instanceof BalnetNotification)) throw new TypeError("Failed to construct 'Notification': Please use the 'new' operator");
    if (!arguments.length) throw new TypeError("Failed to construct 'Notification': 1 argument required");
    var et = document.createDocumentFragment ? document.createDocumentFragment() : null;
    var self = this;
    opts = opts || {};
    this.title = String(title);
    this.body = opts.body == null ? '' : String(opts.body);
    this.tag = opts.tag ? String(opts.tag) : '';
    this.data = opts.data === undefined ? null : opts.data;
    this.icon = opts.icon || '';
    this.onclick = null; this.onclose = null; this.onshow = null; this.onerror = null;
    this.addEventListener = function (t, f, o) { if (et) et.addEventListener(t, f, o); };
    this.removeEventListener = function (t, f, o) { if (et) et.removeEventListener(t, f, o); };
    this.dispatchEvent = function (ev) { return et ? et.dispatchEvent(ev) : true; };
    var nid = showNote(this.title, opts, this);
    this.close = function () { if (nid) post({ type: 'notify-close', nid: nid }); };
    setTimeout(function () {
      var ev = new Event(nid ? 'show' : 'error');
      if (nid && typeof self.onshow === 'function') self.onshow(ev);
      if (!nid && typeof self.onerror === 'function') self.onerror(ev);
      self.dispatchEvent(ev);
    }, 0);
  };
  Object.defineProperty(BalnetNotification, 'permission', { get: function () { return perm; } });
  BalnetNotification.maxActions = 0;
  BalnetNotification.requestPermission = function (cb) {
    var p;
    if (!secure) { warn('Уведомления доступны только сайтам на https://'); p = Promise.resolve('denied'); }
    else if (perm !== 'default') p = Promise.resolve(perm);
    else p = ask({ type: 'perm-request' }).then(function (r) { perm = r; return r; });
    if (typeof cb === 'function') p.then(cb);
    return p;
  };
  try { Object.defineProperty(window, 'Notification', { configurable: true, writable: true, value: BalnetNotification }); } catch (e) { /* ignore */ }

  function b64url(v) {
    if (v == null) return null;
    if (typeof v === 'string') return v.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    var bytes = v instanceof ArrayBuffer ? new Uint8Array(v) : new Uint8Array(v.buffer, v.byteOffset || 0, v.byteLength);
    var s = '';
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function bytesOf(s) {
    var b = atob(String(s).replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((String(s).length + 3) % 4));
    var out = new Uint8Array(b.length);
    for (var i = 0; i < b.length; i++) out[i] = b.charCodeAt(i);
    return out.buffer;
  }
  function makeSub(j) {
    if (!j) return null;
    return {
      endpoint: j.endpoint,
      expirationTime: null,
      options: { userVisibleOnly: true, applicationServerKey: j.applicationServerKey ? bytesOf(j.applicationServerKey) : null },
      getKey: function (name) { return j.keys && j.keys[name] ? bytesOf(j.keys[name]) : null; },
      toJSON: function () { return { endpoint: j.endpoint, expirationTime: null, keys: { p256dh: j.keys.p256dh, auth: j.keys.auth } }; },
      unsubscribe: function () { return ask({ type: 'push-unsubscribe' }); },
    };
  }
  var pushManager = {
    subscribe: function (opts) {
      opts = opts || {};
      if (!opts.userVisibleOnly) {
        var e = new Error('Chrome и ВлодБраузер требуют userVisibleOnly: true — каждое push-сообщение показывается пользователю');
        e.name = 'NotAllowedError';
        return Promise.reject(e);
      }
      return ask({ type: 'push-subscribe', applicationServerKey: b64url(opts.applicationServerKey) }).then(makeSub);
    },
    getSubscription: function () { return ask({ type: 'push-get' }).then(makeSub); },
    permissionState: function () { return Promise.resolve(perm === 'default' ? 'prompt' : perm); },
  };
  var registration = {
    scope: ORIGIN + '/',
    active: { state: 'activated', scriptURL: ORIGIN + '/sw.js' },
    installing: null,
    waiting: null,
    pushManager: pushManager,
    showNotification: function (title, opts) {
      return showNote(title, opts, null) ? Promise.resolve() : Promise.reject(new TypeError('No notification permission has been granted for this origin.'));
    },
    getNotifications: function () { return Promise.resolve([]); },
    update: function () { return Promise.resolve(registration); },
    unregister: function () { return Promise.resolve(true); },
    addEventListener: function () {},
    removeEventListener: function () {},
  };
  if (secure) {
    var swNote = false;
    var container = {
      controller: null,
      ready: Promise.resolve(registration),
      register: function (url, o) {
        registration.active.scriptURL = new URL(String(url), ORIGIN + '/').href;
        if (o && o.scope) registration.scope = new URL(String(o.scope), ORIGIN + '/').href;
        if (!swNote) { swNote = true; if (window.console) console.info('[БалНет] Service worker сайта не запускается: push-сообщения показывает ВлодБраузер (JSON {title, body, url})'); }
        return Promise.resolve(registration);
      },
      getRegistration: function () { return Promise.resolve(registration); },
      getRegistrations: function () { return Promise.resolve([registration]); },
      addEventListener: function () {},
      removeEventListener: function () {},
      startMessages: function () {},
    };
    try { Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: container }); } catch (e) { /* ignore */ }
  } else {
    try { Object.defineProperty(navigator, 'serviceWorker', { configurable: true, value: undefined }); } catch (e) { /* ignore */ }
  }

  // ——— Заголовок и адрес ———
  function watchTitle() {
    var head = document.head || document.documentElement;
    if (window.MutationObserver && head) new MutationObserver(report).observe(head, { subtree: true, childList: true, characterData: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { report(); watchTitle(); });
  else { report(); watchTitle(); }
})();
`;
