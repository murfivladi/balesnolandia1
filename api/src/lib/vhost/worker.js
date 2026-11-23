// Рабочий поток для PHP (php-wasm, PHP 8.3) и Python (Pyodide). Отдельный поток нужен потому, что
// бесконечный цикл в PHP или Python нельзя прервать изнутри: главный поток просто завершает этот поток
// по таймауту и запускает новый. Каталог сайта монтируется в /site (NODEFS), больше скрипту ничего не видно.
import { parentPort } from 'node:worker_threads';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
let php = null;
let py = null;
let fetchSeq = 0;
const fetchWait = new Map();

// Сеть только через БалНет: запросы уходят в главный поток (DNS, TLS, сайт назначения).
function balnetFetch(req) {
  const id = ++fetchSeq;
  parentPort.postMessage({ type: 'fetch', id, req });
  return new Promise((resolve) => fetchWait.set(id, resolve));
}
globalThis.fetch = async () => { throw new Error('Выход в настоящий интернет закрыт: используйте balnet.fetch'); };

// ——— PHP ———

const PHP_PRELUDE = `<?php
if (!is_dir('/site/.data/sessions')) @mkdir('/site/.data/sessions', 0777, true);
// БалНет: база сайта и key-value. $db = balnet_db(); balnet_kv_get('k'); balnet_kv_set('k', $v, $ttl);
function balnet_db() {
  static $pdo = null;
  if ($pdo === null) {
    if (!is_dir('/site/.data')) mkdir('/site/.data', 0777, true);
    $pdo = new PDO('sqlite:/site/.data/site.sqlite');
    $pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $pdo->setAttribute(PDO::ATTR_DEFAULT_FETCH_MODE, PDO::FETCH_ASSOC);
    $pdo->exec('CREATE TABLE IF NOT EXISTS _kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)');
  }
  return $pdo;
}
function balnet_game_time() { return (int)($_SERVER['BALNET_GAME_TIME'] ?? 0); }
function balnet_kv_get($k) {
  $st = balnet_db()->prepare('SELECT v, exp FROM _kv WHERE k = ?'); $st->execute([$k]); $r = $st->fetch();
  if (!$r || ($r['exp'] && $r['exp'] <= balnet_game_time())) return null;
  return json_decode($r['v'], true);
}
function balnet_kv_set($k, $v, $ttl = null) {
  $st = balnet_db()->prepare('INSERT OR REPLACE INTO _kv (k, v, exp) VALUES (?, ?, ?)');
  return $st->execute([$k, json_encode($v, JSON_UNESCAPED_UNICODE), $ttl ? balnet_game_time() + (int)$ttl : null]);
}
function balnet_kv_delete($k) { return balnet_db()->prepare('DELETE FROM _kv WHERE k = ?')->execute([$k]); }
`;

async function getPhp() {
  if (php) return php;
  const U = await import('@php-wasm/universal');
  const dir = path.dirname(require.resolve('@php-wasm/node-8-3/package.json'));
  const loader = await import(pathToFileURL(path.join(dir, 'asyncify/php_8_3.js')).href);
  const p = new U.PHP(await U.loadPHPRuntime(loader, {}));
  p.mkdir('/internal/balnet');
  p.writeFile('/internal/balnet/prelude.php', PHP_PRELUDE);
  await U.setPhpIniEntries(p, {
    allow_url_fopen: '0',
    allow_url_include: '0',
    disable_functions: 'exec,shell_exec,system,passthru,proc_open,popen,pcntl_exec,fsockopen,pfsockopen,stream_socket_client,stream_socket_server,socket_create,curl_exec,curl_multi_exec,mail',
    auto_prepend_file: '/internal/balnet/prelude.php',
    display_errors: '1',
    error_reporting: 'E_ALL',
    memory_limit: '64M',
    'session.save_path': '/site/.data/sessions',
  });
  php = { p, M: p[U.__private__dont__use] };
  return php;
}

async function runPhp(job) {
  const { p, M } = await getPhp();
  if (!p.fileExists('/site')) p.mkdir('/site');
  M.FS.mount(M.FS.filesystems.NODEFS, { root: job.dir }, '/site');
  try {
    p.chdir('/site');
    const r = job.req || {};
    // Скрипт из консоли или cron: $argv/$argc как у php-cli (через загрузчик — в $_SERVER массивы нельзя).
    const cli = job.argv ? `<?php $argv = json_decode(${JSON.stringify(JSON.stringify(job.argv))}, true); $argc = count($argv); $_SERVER['argv'] = $argv; $_SERVER['argc'] = $argc; chdir(dirname('/site/${job.entry.replace(/'/g, '')}')); require '/site/${job.entry.replace(/'/g, '')}';` : null;
    const res = await p.run({
      ...(cli ? { code: cli } : { scriptPath: `/site/${job.entry}` }),
      relativeUri: `${r.path || '/'}${r.search || ''}`,
      method: r.method || 'GET',
      protocol: (r.url || '').startsWith('https') ? 'https' : 'http',
      headers: r.headers || {},
      body: new TextEncoder().encode(r.body || ''),
      $_SERVER: {
        REMOTE_ADDR: r.ip || '', SERVER_NAME: r.host || '', HTTP_HOST: r.host || '', BALNET_GAME_TIME: String(job.now || 0),
      },
    });
    const headers = {};
    const cookies = [];
    for (const [k, v] of Object.entries(res.headers || {})) {
      if (k === 'set-cookie') cookies.push(...v);
      else if (k !== 'x-powered-by') headers[k] = v.join(', ');
    }
    return { status: res.httpStatusCode, headers, cookies, body: Buffer.from(res.bytes).toString('base64'), b64: true, errors: res.errors || '' };
  } finally {
    p.chdir('/');
    try { M.FS.unmount('/site'); } catch { /* уже отмонтирован */ }
  }
}

// ——— Python ———

const PY_BALNET = `
import json, sqlite3, js
from pyodide.ffi import to_js

class _Response:
    def __init__(self, body='', status=200, headers=None):
        self.body, self.status, self.headers = body, status, dict(headers or {})
        self.cookies = []
    def set_cookie(self, name, value, max_age=None, http_only=False, path='/'):
        c = f"{name}={value}; Path={path}"
        if max_age is not None: c += f"; Max-Age={int(max_age)}"
        if http_only: c += "; HttpOnly"
        self.cookies.append(c)
        return self

def Response(body='', status=200, headers=None): return _Response(body, status, headers)
def json_response(obj, status=200): return _Response(json.dumps(obj, ensure_ascii=False), status, {'content-type': 'application/json; charset=utf-8'})
def html(body, status=200): return _Response(body, status, {'content-type': 'text/html; charset=utf-8'})
def redirect(url, status=302): return _Response('', status, {'location': url})

_db = None
def db():
    global _db
    if _db is None:
        import os
        os.makedirs('/site/.data', exist_ok=True)
        _db = sqlite3.connect('/site/.data/site.sqlite', isolation_level=None)
        _db.row_factory = sqlite3.Row
        _db.execute('CREATE TABLE IF NOT EXISTS _kv (k TEXT PRIMARY KEY, v TEXT NOT NULL, exp INTEGER)')
    return _db

GAME_TIME = 0
def game_time(): return GAME_TIME

class kv:
    @staticmethod
    def get(k):
        r = db().execute('SELECT v, exp FROM _kv WHERE k = ?', (k,)).fetchone()
        if not r or (r['exp'] and r['exp'] <= GAME_TIME): return None
        return json.loads(r['v'])
    @staticmethod
    def set(k, v, ttl=None):
        db().execute('INSERT OR REPLACE INTO _kv (k, v, exp) VALUES (?, ?, ?)', (k, json.dumps(v, ensure_ascii=False), GAME_TIME + int(ttl) if ttl else None))
    @staticmethod
    def delete(k): db().execute('DELETE FROM _kv WHERE k = ?', (k,))

class FetchResponse:
    def __init__(self, r): self.status, self.headers, self.text, self.url = r.get('status'), r.get('headers', {}), r.get('body', ''), r.get('url')
    def json(self): return json.loads(self.text)

async def fetch(url, method='GET', headers=None, body=None):
    r = json.loads(await js.balnetFetch(json.dumps({'url': url, 'method': method, 'headers': headers or {}, 'body': body})))
    if r.get('error'): raise IOError('fetch: ' + r['error'])
    return FetchResponse(r)

class Request:
    def __init__(self, d):
        self.method, self.path, self.url, self.ip, self.host = d['method'], d['path'], d['url'], d.get('ip'), d.get('host')
        self.headers = {k.lower(): v for k, v in (d.get('headers') or {}).items()}
        from urllib.parse import parse_qs
        self.query = {k: v[0] for k, v in parse_qs((d.get('search') or '').lstrip('?')).items()}
        self.body = d.get('body') or ''
        self.cookies = {}
        for part in self.headers.get('cookie', '').split(';'):
            if '=' in part:
                a, b = part.split('=', 1); self.cookies[a.strip()] = b.strip()
    def json(self): return json.loads(self.body or 'null')
    def form(self):
        from urllib.parse import parse_qs
        return {k: v[0] for k, v in parse_qs(self.body).items()}

def _normalize(res):
    if res is None: return {'status': 204, 'headers': {}, 'body': ''}
    if isinstance(res, _Response):
        h = {k.lower(): str(v) for k, v in res.headers.items()}
        h.setdefault('content-type', 'text/plain; charset=utf-8')
        return {'status': res.status, 'headers': h, 'body': res.body if isinstance(res.body, str) else json.dumps(res.body, ensure_ascii=False), 'cookies': res.cookies}
    if isinstance(res, str): return {'status': 200, 'headers': {'content-type': 'text/html; charset=utf-8'}, 'body': res}
    return {'status': 200, 'headers': {'content-type': 'application/json; charset=utf-8'}, 'body': json.dumps(res, ensure_ascii=False)}
`;

const PY_RUN = `
import sys, json, importlib, io, contextlib, traceback, asyncio, types
import balnet
balnet.GAME_TIME = _job_now
balnet._db = None
if '/site' not in sys.path: sys.path.insert(0, '/site')
for _m in [m for m, mod in list(sys.modules.items()) if getattr(mod, '__file__', '') and str(getattr(mod, '__file__', '')).startswith('/site/')]:
    del sys.modules[_m]
_out = io.StringIO()
async def _main():
    with contextlib.redirect_stdout(_out), contextlib.redirect_stderr(_out):
        if _job_mode == 'script':
            sys.argv = [_job_entry] + list(_job_args)
            code = open('/site/' + _job_entry, encoding='utf-8').read()
            g = {'__name__': '__main__', '__file__': '/site/' + _job_entry}
            exec(compile(code, '/site/' + _job_entry, 'exec'), g)
            return {'ok': True}
        mod = importlib.import_module('server')
        fn = getattr(mod, _job_handler, None)
        if fn is None: return {'missing': True}
        arg = balnet.Request(json.loads(_job_arg)) if _job_handler == 'on_request' else json.loads(_job_arg)
        res = fn(arg)
        if asyncio.iscoroutine(res): res = await res
        return balnet._normalize(res) if _job_handler == 'on_request' else {'ok': True}
try:
    _res = await _main()
except Exception:
    _res = {'error': traceback.format_exc(limit=8)}
finally:
    if balnet._db is not None:
        balnet._db.close(); balnet._db = None
_res['log'] = _out.getvalue()[-8000:]
json.dumps(_res, ensure_ascii=False)
`;

async function getPy() {
  if (py) return py;
  const { loadPyodide } = await import('pyodide');
  const indexURL = path.dirname(require.resolve('pyodide/package.json')) + path.sep;
  py = await loadPyodide({ indexURL, stdout: () => {}, stderr: () => {} });
  py.FS.mkdirTree('/py');
  py.FS.writeFile('/py/balnet.py', PY_BALNET);
  py.runPython("import sys\nsys.path.insert(0, '/py')\nimport js\nfrom pyodide.ffi import create_proxy");
  // balnet.fetch в Python обращается к js.balnetFetch.
  globalThis.balnetFetch = async (s) => JSON.stringify(await balnetFetch(JSON.parse(s)));
  return py;
}

async function runPython(job) {
  const p = await getPy();
  p.FS.mkdirTree('/site');
  p.mountNodeFS('/site', job.dir);
  try {
    p.globals.set('_job_mode', job.mode);
    p.globals.set('_job_entry', job.entry);
    p.globals.set('_job_args', p.toPy(job.argv || []));
    p.globals.set('_job_handler', job.handler || 'on_request');
    p.globals.set('_job_arg', JSON.stringify(job.req ?? job.arg ?? null));
    p.globals.set('_job_now', job.now || 0);
    return JSON.parse(await p.runPythonAsync(PY_RUN));
  } finally {
    try { p.FS.unmount('/site'); } catch { /* уже отмонтирован */ }
  }
}

parentPort.on('message', async (m) => {
  if (m.type === 'fetchResult') {
    const w = fetchWait.get(m.id);
    if (w) { fetchWait.delete(m.id); w(m.res); }
    return;
  }
  try {
    const result = m.kind === 'php' ? await runPhp(m.job) : await runPython(m.job);
    parentPort.postMessage({ type: 'done', id: m.id, result });
  } catch (e) {
    parentPort.postMessage({ type: 'done', id: m.id, error: String(e?.message || e) });
  }
});
