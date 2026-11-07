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
    if (raw.charAt(0) === '#' || /^(javascript|mailto|tel|data|blob):/i.test(raw)) return;
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

  // ——— Заголовок и адрес ———
  function watchTitle() {
    var head = document.head || document.documentElement;
    if (window.MutationObserver && head) new MutationObserver(report).observe(head, { subtree: true, childList: true, characterData: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { report(); watchTitle(); });
  else { report(); watchTitle(); }
})();
`;
