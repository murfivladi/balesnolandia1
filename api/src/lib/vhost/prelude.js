// Окружение серверного JavaScript сайта (выполняется внутри QuickJS перед server.js).
// Хост даёт функции __log, __db, __kv, __fetch, __now; всё остальное — здесь.
export const PRELUDE = String.raw`
(function () {
  'use strict';
  var g = globalThis;
  function str(v) {
    if (typeof v === 'string') return v;
    try { return JSON.stringify(v); } catch (e) { return String(v); }
  }
  function mk(level) {
    return function () { __log(level, Array.prototype.map.call(arguments, str).join(' ')); };
  }
  g.console = { log: mk('log'), info: mk('info'), warn: mk('warn'), error: mk('error'), debug: mk('log') };

  // ——— base64 ———
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
  g.btoa = function (s) {
    s = String(s); var out = '';
    for (var i = 0; i < s.length; i += 3) {
      var a = s.charCodeAt(i), b = s.charCodeAt(i + 1), c = s.charCodeAt(i + 2);
      if (a > 255 || b > 255 || c > 255) throw new Error('btoa: символ вне Latin1');
      var n = (a << 16) | ((b || 0) << 8) | (c || 0);
      out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63] + (i + 1 < s.length ? B64[(n >> 6) & 63] : '=') + (i + 2 < s.length ? B64[n & 63] : '=');
    }
    return out;
  };
  g.atob = function (s) {
    s = String(s).replace(/[^A-Za-z0-9+/]/g, ''); var out = '';
    for (var i = 0; i < s.length; i += 4) {
      var n = (B64.indexOf(s[i]) << 18) | (B64.indexOf(s[i + 1]) << 12) | ((B64.indexOf(s[i + 2]) & 63) << 6) | (B64.indexOf(s[i + 3]) & 63);
      out += String.fromCharCode((n >> 16) & 255);
      if (s[i + 2] !== undefined) out += String.fromCharCode((n >> 8) & 255);
      if (s[i + 3] !== undefined) out += String.fromCharCode(n & 255);
    }
    return out;
  };

  // ——— URLSearchParams и URL ———
  function dec(s) { try { return decodeURIComponent(String(s).replace(/\+/g, ' ')); } catch (e) { return s; } }
  function enc(s) { return encodeURIComponent(String(s)).replace(/%20/g, '+'); }
  function USP(init) {
    this._l = [];
    if (typeof init === 'string') {
      var s = init.charAt(0) === '?' ? init.slice(1) : init;
      var self = this;
      s.split('&').forEach(function (p) { if (!p) return; var i = p.indexOf('='); self._l.push(i < 0 ? [dec(p), ''] : [dec(p.slice(0, i)), dec(p.slice(i + 1))]); });
    } else if (init && typeof init === 'object') {
      var keys = Object.keys(init);
      for (var k = 0; k < keys.length; k++) this._l.push([keys[k], String(init[keys[k]])]);
    }
  }
  USP.prototype.get = function (k) { for (var i = 0; i < this._l.length; i++) if (this._l[i][0] === k) return this._l[i][1]; return null; };
  USP.prototype.getAll = function (k) { return this._l.filter(function (x) { return x[0] === k; }).map(function (x) { return x[1]; }); };
  USP.prototype.has = function (k) { return this.get(k) !== null; };
  // Изменения searchParams сразу видны в url.search и url.href — как в браузере.
  USP.prototype._sync = function () { if (this._url) { var q = this.toString(); this._url._search = q ? '?' + q : ''; } };
  USP.prototype.set = function (k, v) {
    k = String(k); var done = false;
    this._l = this._l.filter(function (x) { if (x[0] !== k) return true; if (done) return false; done = true; x[1] = String(v); return true; });
    if (!done) this._l.push([k, String(v)]);
    this._sync();
  };
  USP.prototype.append = function (k, v) { this._l.push([String(k), String(v)]); this._sync(); };
  USP.prototype.delete = function (k) { k = String(k); this._l = this._l.filter(function (x) { return x[0] !== k; }); this._sync(); };
  USP.prototype.sort = function () { this._l.sort(function (a, b) { return a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0; }); this._sync(); };
  USP.prototype.keys = function () { return this._l.map(function (x) { return x[0]; })[Symbol.iterator](); };
  USP.prototype.values = function () { return this._l.map(function (x) { return x[1]; })[Symbol.iterator](); };
  USP.prototype.entries = function () { return this._l.map(function (x) { return [x[0], x[1]]; })[Symbol.iterator](); };
  USP.prototype[Symbol.iterator] = USP.prototype.entries;
  USP.prototype.forEach = function (fn) { var self = this; this._l.forEach(function (x) { fn(x[1], x[0], self); }); };
  USP.prototype.toString = function () { return this._l.map(function (x) { return enc(x[0]) + '=' + enc(x[1]); }).join('&'); };
  Object.defineProperty(USP.prototype, 'size', { get: function () { return this._l.length; } });
  g.URLSearchParams = function (init) {
    USP.call(this, init instanceof USP ? init.toString() : Array.isArray(init) ? '' : init);
    if (Array.isArray(init)) for (var i = 0; i < init.length; i++) this._l.push([String(init[i][0]), String(init[i][1])]);
  };
  g.URLSearchParams.prototype = USP.prototype;
  USP.prototype.constructor = g.URLSearchParams;
  var URL_RE = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i;
  function parseUrl(u, base) {
    var m = URL_RE.exec(String(u));
    if (!m && base !== undefined) {
      var b = base instanceof g.URL ? base : new g.URL(base);
      var s = String(u);
      var path;
      if (s.charAt(0) === '?') path = b.pathname + s;
      else if (s.charAt(0) === '#') path = b.pathname + b.search + s;
      else if (s.slice(0, 2) === '//') return parseUrl(b.protocol + s);
      else path = s.charAt(0) === '/' ? s : b.pathname.replace(/[^/]*$/, '') + s;
      m = URL_RE.exec(b.protocol + '//' + b.host + path);
    }
    if (!m) throw new TypeError('Неверный адрес: ' + u);
    return m;
  }
  g.URL = function (u, base) {
    var m = parseUrl(u, base);
    this.protocol = m[1].toLowerCase() + ':'; this.host = m[2].toLowerCase();
    this.pathname = m[3] || '/'; this.hash = m[5] || '';
    this._search = m[4] && m[4] !== '?' ? m[4] : '';
    this._sp = new USP(this._search);
    this._sp._url = this;
  };
  Object.defineProperties(g.URL.prototype, {
    hostname: { get: function () { return this.host.replace(/:\d+$/, ''); }, set: function (v) { var p = /:\d+$/.exec(this.host); this.host = String(v).toLowerCase() + (p ? p[0] : ''); } },
    port: { get: function () { var p = /:(\d+)$/.exec(this.host); return p ? p[1] : ''; }, set: function (v) { this.host = this.hostname + (v ? ':' + v : ''); } },
    origin: { get: function () { return this.protocol + '//' + this.host; } },
    search: {
      get: function () { return this._search; },
      set: function (v) { v = String(v); if (v && v.charAt(0) !== '?') v = '?' + v; this._search = v === '?' ? '' : v; this._sp._l = new USP(this._search)._l; },
    },
    searchParams: { get: function () { return this._sp; } },
    href: {
      get: function () { return this.protocol + '//' + this.host + this.pathname + this._search + this.hash; },
      set: function (v) { g.URL.call(this, v); },
    },
  });
  g.URL.prototype.toString = function () { return this.href; };
  g.URL.prototype.toJSON = function () { return this.href; };

  // ——— Headers, Request, Response ———
  function Headers(init) {
    this._h = {};
    if (init) { var self = this; Object.keys(init).forEach(function (k) { self._h[k.toLowerCase()] = String(init[k]); }); }
  }
  Headers.prototype.get = function (k) { var v = this._h[String(k).toLowerCase()]; return v === undefined ? null : v; };
  Headers.prototype.set = function (k, v) { this._h[String(k).toLowerCase()] = String(v); };
  Headers.prototype.has = function (k) { return String(k).toLowerCase() in this._h; };
  Headers.prototype.delete = function (k) { delete this._h[String(k).toLowerCase()]; };
  Headers.prototype.toObject = function () { return Object.assign({}, this._h); };
  g.Headers = Headers;

  function parseCookies(h) {
    var out = {};
    String(h || '').split(';').forEach(function (p) { var i = p.indexOf('='); if (i > 0) out[p.slice(0, i).trim()] = dec(p.slice(i + 1).trim()); });
    return out;
  }
  function Request(r) {
    this.method = r.method; this.url = r.url; this.path = r.path; this.ip = r.ip; this.host = r.host;
    this.headers = new Headers(r.headers);
    this.query = new USP(r.search || '');
    this.cookies = parseCookies(this.headers.get('cookie'));
    this._body = r.body || '';
  }
  Request.prototype.text = function () { return Promise.resolve(this._body); };
  Request.prototype.json = function () { var b = this._body; return new Promise(function (ok) { ok(JSON.parse(b || 'null')); }); };
  Request.prototype.form = function () { return Promise.resolve(new USP(this._body)); };
  Request.prototype.formData = Request.prototype.form;
  g.Request = Request;

  function Response(body, init) {
    init = init || {};
    this.status = init.status || 200;
    this.headers = init.headers instanceof Headers ? init.headers : new Headers(init.headers || {});
    this.cookies = [];
    if (body === undefined || body === null) body = '';
    if (body instanceof Uint8Array) { var s = ''; for (var i = 0; i < body.length; i++) s += String.fromCharCode(body[i]); this._b64 = btoa(s); this._body = ''; }
    else this._body = String(body);
    this.ok = this.status >= 200 && this.status < 300;
  }
  Response.prototype.text = function () { return Promise.resolve(this._body); };
  Response.prototype.json = function () { var b = this._body; return new Promise(function (ok) { ok(JSON.parse(b)); }); };
  Response.prototype.setCookie = function (name, value, opt) {
    opt = opt || {};
    var c = name + '=' + encodeURIComponent(value) + '; Path=' + (opt.path || '/');
    if (opt.maxAge !== undefined) c += '; Max-Age=' + Number(opt.maxAge);
    if (opt.httpOnly) c += '; HttpOnly';
    if (opt.sameSite) c += '; SameSite=' + opt.sameSite;
    this.cookies.push(c);
    return this;
  };
  Response.json = function (o, init) {
    init = init || {}; var h = new Headers(init.headers || {}); h.set('content-type', 'application/json; charset=utf-8');
    return new Response(JSON.stringify(o), { status: init.status, headers: h });
  };
  Response.redirect = function (url, status) { return new Response('', { status: status || 302, headers: { location: url } }); };
  Response.html = function (html, init) {
    init = init || {}; var h = new Headers(init.headers || {}); h.set('content-type', 'text/html; charset=utf-8');
    return new Response(html, { status: init.status, headers: h });
  };
  g.Response = Response;

  // ——— База, key-value, сеть ———
  g.db = {
    query: function (sql, params) { return JSON.parse(__db('query', String(sql), JSON.stringify(params || []))); },
    get: function (sql, params) { return g.db.query(sql, params)[0] || null; },
    run: function (sql, params) { return JSON.parse(__db('run', String(sql), JSON.stringify(params || []))); },
    exec: function (sql) { return JSON.parse(__db('exec', String(sql), '[]')); },
  };
  g.kv = {
    get: function (key) { return JSON.parse(__kv('get', JSON.stringify({ key: key }))); },
    set: function (key, value, opt) { return JSON.parse(__kv('set', JSON.stringify({ key: key, value: value, ttl: opt && opt.ttl }))); },
    delete: function (key) { return JSON.parse(__kv('delete', JSON.stringify({ key: key }))); },
    list: function (prefix) { return JSON.parse(__kv('list', JSON.stringify({ prefix: prefix || '' }))); },
  };
  g.fetch = function (url, init) {
    init = init || {};
    var headers = init.headers instanceof Headers ? init.headers.toObject() : (init.headers || {});
    return __fetch(JSON.stringify({ url: String(url), method: init.method || 'GET', headers: headers, body: init.body === undefined || init.body === null ? null : String(init.body), bodyB64: init.bodyB64 || undefined }))
      .then(function (s) {
        var r = JSON.parse(s);
        if (r.error) throw new TypeError('fetch: ' + r.error);
        var res = new Response(r.body, { status: r.status, headers: r.headers });
        res.url = r.url;
        return res;
      });
  };
  g.gameTime = function () { return __now(); };
  // Почта: письмо уходит с адреса сервера сайта по MX получателя (SPF проверит этот адрес).
  g.mail = {
    send: function (m) {
      return __mail(JSON.stringify(m || {})).then(function (s) {
        var r = JSON.parse(s);
        if (r && r.error) throw new Error(r.error);
        return r;
      });
    },
  };
  // WebSocket-соединения посетителей с сайтом (живут между вызовами onSocket).
  function wsData(d) { return typeof d === 'string' ? d : JSON.stringify(d); }
  g.sockets = {
    send: function (id, data) { return JSON.parse(__ws('send', JSON.stringify({ id: id, data: wsData(data) }))); },
    broadcast: function (data, opt) { return JSON.parse(__ws('broadcast', JSON.stringify({ data: wsData(data), path: opt && opt.path, except: opt && opt.except }))); },
    close: function (id, reason) { return JSON.parse(__ws('close', JSON.stringify({ id: id, reason: reason || '' }))); },
    list: function (path) { return JSON.parse(__ws('list', JSON.stringify({ path: path || null }))); },
  };
  g.crypto = {
    randomUUID: function () { return __uuid(); },
    // crypto.hmac('sha256', ключ, данные) и crypto.hash('sha256', данные) → hex. Сравнение подписей — timingSafeEqual.
    hmac: function (alg, key, data) { return __hash(String(alg), String(key), String(data)); },
    hash: function (alg, data) { return __hash(String(alg), '', String(data)); },
    timingSafeEqual: function (a, b) {
      a = String(a); b = String(b);
      if (a.length !== b.length) return false;
      var r = 0; for (var i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
      return r === 0;
    },
  };
  // Web Push (этап Н10): API как у npm-пакета web-push. Шифрование aes128gcm и подпись VAPID делает хост.
  g.webpush = {
    generateVAPIDKeys: function () { return JSON.parse(__webpush('keys', '{}')); },
    sendNotification: function (subscription, payload, options) {
      var p = JSON.parse(__webpush('prepare', JSON.stringify({ subscription: subscription, payload: payload === undefined || payload === null ? null : typeof payload === 'string' ? payload : JSON.stringify(payload), options: options || {} })));
      return g.fetch(p.endpoint, { method: 'POST', headers: p.headers, bodyB64: p.bodyB64 }).then(function (res) {
        return res.text().then(function (text) {
          if (res.status >= 400) {
            var e = new Error('Push-сервис ответил ' + res.status + ': ' + text.trim());
            e.name = 'WebPushError'; e.statusCode = res.status; e.body = text; e.endpoint = p.endpoint;
            throw e;
          }
          return { statusCode: res.status, body: text, headers: res.headers.toObject ? res.headers.toObject() : {} };
        });
      });
    },
  };
  g.setTimeout = function (fn) { Promise.resolve().then(fn); return 0; };

  function normalize(res) {
    if (res === undefined || res === null) return { status: 204, headers: {}, body: '' };
    if (res instanceof Response) return { status: res.status, headers: res.headers.toObject(), cookies: res.cookies, body: res._body, b64: res._b64 };
    if (typeof res === 'string') return { status: 200, headers: { 'content-type': 'text/html; charset=utf-8' }, body: res };
    if (typeof res === 'object' && (res.body !== undefined || res.status !== undefined)) {
      return { status: res.status || 200, headers: new Headers(res.headers || {}).toObject(), body: typeof res.body === 'string' ? res.body : JSON.stringify(res.body === undefined ? '' : res.body) };
    }
    return { status: 200, headers: { 'content-type': 'application/json; charset=utf-8' }, body: JSON.stringify(res) };
  }

  g.__handle = function (name, json) {
    var mod = g.__mod || {};
    if (name === '__script__') {
      var main = mod.main || (mod.default && mod.default.main);
      return Promise.resolve(typeof main === 'function' ? main(JSON.parse(json)) : null).then(function (v) { return JSON.stringify({ ok: true, value: v === undefined ? null : v }); });
    }
    var fn = mod[name] || (mod.default && mod.default[name]);
    if (typeof fn !== 'function') return Promise.resolve(JSON.stringify({ missing: true }));
    var arg = JSON.parse(json);
    if (name === 'onRequest') arg = new Request(arg);
    if (name === 'onSocket' && arg.socket) {
      var sid = arg.socket.id;
      arg.socket.send = function (d) { return g.sockets.send(sid, d); };
      arg.socket.close = function (r) { return g.sockets.close(sid, r); };
    }
    return Promise.resolve().then(function () { return fn(arg); }).then(function (res) {
      return JSON.stringify(name === 'onRequest' ? normalize(res) : { ok: true, value: res === undefined ? null : res });
    });
  };
})();
`;
