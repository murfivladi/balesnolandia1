import Foundation

/// Скрипты, которые ВлодБраузер встраивает в страницы WKWebView.
enum Scripts {
    /// Консоль страницы → DevTools (мир страницы, до её скриптов).
    static let console = #"""
    (function () {
      if (window.__balnetConsole) return;
      window.__balnetConsole = 1;
      var h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.balnetConsole;
      if (!h) return;
      function fmt(v) {
        if (typeof v === 'string') return v;
        if (v instanceof Error) return v.name + ': ' + v.message;
        try { return JSON.stringify(v); } catch (e) { return String(v); }
      }
      function send(level, args) {
        try { h.postMessage({ level: level, text: Array.prototype.map.call(args, fmt).join(' ').slice(0, 4000) }); } catch (e) {}
      }
      ['log', 'info', 'warn', 'error', 'debug'].forEach(function (k) {
        var orig = console[k];
        console[k] = function () { send(k, arguments); if (orig) return orig.apply(console, arguments); };
      });
      window.addEventListener('error', function (e) { send('error', [e.message + (e.filename ? ' (' + e.filename + ':' + e.lineno + ')' : '')]); });
      window.addEventListener('unhandledrejection', function (e) { send('error', ['Uncaught (in promise) ' + fmt(e.reason)]); });
    })();
    """#

    /// Тема госсайта: shared/theme.js берёт её из localStorage bln_theme.
    static func theme(_ t: String) -> String {
        """
        (function () {
          try { localStorage.setItem('bln_theme', '\(t)'); } catch (e) {}
          try { document.documentElement.dataset.theme = '\(t)'; } catch (e) {}
        })();
        """
    }

    /// Госсайты (ВлодПоиск, ВлодПочта, оплата) открывают адреса БалНета во вкладке браузера.
    static let govOpen = #"""
    (function () {
      var h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.balnetGov;
      if (!h) return;
      window.__balnetOpen = function (url, newTab) { h.postMessage({ type: 'open', url: String(url || ''), newTab: !!newTab }); };
    })();
    """#

    /// Мост ВлодБраузера для госсайтов (web/src/shared/native.js): Face ID и PIN карт из Keychain.
    static let native = #"""
    (function () {
      var h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.balnetNative;
      if (!h || window.__balnetNative) return;
      window.__balnetNative = {
        confirm: function (reason) { return h.postMessage({ op: 'confirm', reason: String(reason || '') }); },
        hasPin: function (number) { return h.postMessage({ op: 'hasPin', number: String(number || '') }); },
        pin: function (number) { return h.postMessage({ op: 'pin', number: String(number || '') }); },
        offerPin: function (number, pin) { h.postMessage({ op: 'offerPin', number: String(number || ''), pin: String(pin || '') }); }
      };
    })();
    """#

    /// Мост shim шлюза → приложение. Работает в отдельном мире WebKit: сайт игрока не может вызвать приложение напрямую,
    /// только через postMessage, как во фрейме веб-ВлодБраузера. На верхнем уровне parent === window, поэтому
    /// сообщения shim приходят в это же окно. Запросы уведомлений и push пока отклоняются (этап И3).
    static let siteBridge = #"""
    (function () {
      var h = window.webkit && window.webkit.messageHandlers && window.webkit.messageHandlers.balnet;
      if (!h) return;
      function reply(m, extra) {
        var r = { __balnetShell: 1, type: 'reply', id: m.id };
        for (var k in extra) r[k] = extra[k];
        window.postMessage(r, '*');
      }
      window.addEventListener('message', function (e) {
        // Билет (ticket) сообщения сверяет приложение: чужой фрейм внутри страницы не выдаст себя за этот сайт.
        var m = e.data;
        if (!m || m.__balnet !== 1 || typeof m.type !== 'string') return;
        if (m.type === 'perm-request') { reply(m, { result: 'denied', permission: 'denied' }); return; }
        if (m.type === 'push-get') { reply(m, { result: null }); return; }
        if (m.type === 'push-subscribe' || m.type === 'push-unsubscribe') {
          reply(m, { error: 'Уведомления сайтов появятся в следующей версии ВлодБраузера для iOS', errorName: 'NotAllowedError' });
          return;
        }
        try { h.postMessage(JSON.parse(JSON.stringify(m))); } catch (err) {}
      });
    })();
    """#

    /// Дерево DOM для вкладки «Элементы» (глубина и число детей ограничены).
    static let domTree = #"""
    (function () {
      var count = 0;
      function node(n, depth) {
        if (count++ > 1500) return null;
        if (n.nodeType === 3) {
          var t = n.textContent.trim();
          return t ? { t: '#text', x: t.slice(0, 200) } : null;
        }
        if (n.nodeType === 8) return { t: '#comment', x: n.textContent.slice(0, 200) };
        if (n.nodeType !== 1) return null;
        var attrs = [];
        for (var i = 0; i < n.attributes.length && i < 20; i++) attrs.push([n.attributes[i].name, n.attributes[i].value.slice(0, 300)]);
        var out = { t: n.tagName.toLowerCase(), a: attrs, c: [] };
        if (depth < 14) {
          var kids = n.childNodes;
          for (var j = 0; j < kids.length && j < 80; j++) { var c = node(kids[j], depth + 1); if (c) out.c.push(c); }
          if (kids.length > 80) out.c.push({ t: '#more', x: '… ещё ' + (kids.length - 80) });
        }
        return out;
      }
      return JSON.stringify(node(document.documentElement, 0));
    })();
    """#

    /// cookies и localStorage страницы для вкладки «Хранилище» (госсайты; у сайтов игроков их хранит браузер).
    static let storage = #"""
    (function () {
      var local = {};
      try { for (var i = 0; i < localStorage.length; i++) { var k = localStorage.key(i); local[k] = localStorage.getItem(k); } } catch (e) {}
      var session = {};
      try { for (var j = 0; j < sessionStorage.length; j++) { var s = sessionStorage.key(j); session[s] = sessionStorage.getItem(s); } } catch (e) {}
      var cookie = '';
      try { cookie = document.cookie; } catch (e) {}
      return JSON.stringify({ cookie: cookie, local: local, session: session });
    })();
    """#

    static let source = "document.documentElement ? document.documentElement.outerHTML : ''"
}
