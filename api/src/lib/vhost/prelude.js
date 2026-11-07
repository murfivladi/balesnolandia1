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
  USP.prototype.set = function (k, v) { this.delete(k); this._l.push([k, String(v)]); };
  USP.prototype.append = function (k, v) { this._l.push([k, String(v)]); };
  USP.prototype.delete = function (k) { this._l = this._l.filter(function (x) { return x[0] !== k; }); };
  USP.prototype.entries = function () { return this._l.slice()[Symbol.iterator](); };
  USP.prototype[Symbol.iterator] = USP.prototype.entries;
  USP.prototype.forEach = function (fn) { this._l.forEach(function (x) { fn(x[1], x[0]); }); };
  USP.prototype.toString = function () { return this._l.map(function (x) { return enc(x[0]) + '=' + enc(x[1]); }).join('&'); };
  g.URLSearchParams = USP;
  g.URL = function (u, base) {
    var m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(String(u));
    if (!m && base) {
      var b = new g.URL(base);
      var s = String(u);
      var path = s.charAt(0) === '/' ? s : b.pathname.replace(/[^/]*$/, '') + s;
      m = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]*)([^?#]*)(\?[^#]*)?(#.*)?$/i.exec(b.protocol + '//' + b.host + path);
    }
    if (!m) throw new TypeError('Неверный адрес: ' + u);
    this.protocol = m[1].toLowerCase() + ':'; this.host = m[2].toLowerCase(); this.hostname = this.host.replace(/:\d+$/, '');
    this.pathname = m[3] || '/'; this.search = m[4] || ''; this.hash = m[5] || '';
    this.origin = this.protocol + '//' + this.host; this.searchParams = new USP(this.search);
    this.href = this.origin + this.pathname + this.search + this.hash;
  };
  g.URL.prototype.toString = function () { return this.href; };

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
    return __fetch(JSON.stringify({ url: String(url), method: init.method || 'GET', headers: headers, body: init.body === undefined ? null : String(init.body) }))
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
