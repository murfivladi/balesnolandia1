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
    return u.href;
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
    history[m] = function () { var r = orig.apply(this, arguments); report(); return r; };
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
    if (exp !== null && exp <= Date.now()) delete jar[name];
    else jar[name] = { v: value, exp: exp };
    sync();
  }
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
      if (!/^https?:$/.test(u.protocol) || originOf(u) === API) return origFetch(input, init);
      if (originOf(u) === ORIGIN) return origFetch(toGateway(u.href), init);
      var method = (init && init.method) || 'GET';
      return origFetch(API + '/api/net/xfetch', {
        method: 'POST', headers: { 'Content-Type': 'text/plain' }, body: JSON.stringify({ ticket: C.ticket, url: u.href, method: method }),
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

  // ——— Заголовок и адрес ———
  function watchTitle() {
    var head = document.head || document.documentElement;
    if (window.MutationObserver && head) new MutationObserver(report).observe(head, { subtree: true, childList: true, characterData: true });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', function () { report(); watchTitle(); });
  else { report(); watchTitle(); }
})();
`;
