// Серверный JavaScript сайтов в QuickJS (WASM). Каждый вызов — свой рантайм: изоляция от сервера и других
// сайтов, лимит памяти, лимит CPU-мс тарифа (время только самого JS, ожидание fetch не считается),
// общий таймаут. Модули сайта (import './lib.js') читаются из каталога сайта.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { newQuickJSWASMModuleFromVariant } from 'quickjs-emscripten-core';
import variant from '@jitl/quickjs-singlefile-mjs-release-sync';
import { safeJoin } from '../sitefs.js';
import { PRELUDE } from './prelude.js';

let QJ = null;
const quickjs = () => QJ || (QJ = newQuickJSWASMModuleFromVariant(variant));

const MEMORY = 32 * 1024 * 1024;
const WALL_MS = 15000;
const MAX_SOURCE = 512 * 1024;

export class ScriptError extends Error {
  constructor(message, { kind = 'error', stack = null } = {}) {
    super(message);
    this.kind = kind;
    this.scriptStack = stack;
  }
}

function resolveModule(base, name) {
  if (!name.startsWith('./') && !name.startsWith('../') && !name.startsWith('/')) throw new Error(`Модуль «${name}»: в БалНете нет npm — подключайте свои файлы через ./`);
  const dir = path.posix.dirname(base);
  return path.posix.normalize(name.startsWith('/') ? name.slice(1) : path.posix.join(dir, name)).replace(/^\/+/, '');
}

/**
 * Выполнить обработчик сайта.
 * host: { log(level, text), db(op, sql, params) → value, kv(op, args) → value, fetch(req) → Promise<res>, now() → number }
 * Возвращает { result, cpuMs } или бросает ScriptError (kind: error | cpu | memory | timeout | missing).
 */
export async function runHandler({ dir, entry = 'server.js', handler, arg, cpuMs, host }) {
  const QJS = await quickjs();
  const src = (() => {
    try {
      const { full } = safeJoin(dir, entry);
      const st = fs.statSync(full);
      if (st.size > MAX_SOURCE) throw new ScriptError(`${entry} больше 512 КБ`);
      return fs.readFileSync(full, 'utf8');
    } catch (e) {
      if (e instanceof ScriptError) throw e;
      throw new ScriptError(`Нет файла ${entry}`, { kind: 'missing' });
    }
  })();
  const rt = QJS.newRuntime();
  rt.setMemoryLimit(MEMORY);
  rt.setMaxStackSize(1024 * 1024);
  let used = 0;
  let slice = 0;
  let cpuKill = false;
  rt.setInterruptHandler(() => {
    if (used + (performance.now() - slice) > cpuMs) { cpuKill = true; return true; }
    return false;
  });
  rt.setModuleLoader(
    (name) => {
      try {
        return fs.readFileSync(safeJoin(dir, name).full, 'utf8');
      } catch {
        return { error: new Error(`Модуль ${name} не найден`) };
      }
    },
    (base, name) => resolveModule(base, name),
  );
  const ctx = rt.newContext();
  const pending = new Set();
  const enter = (fn) => {
    slice = performance.now();
    try { return fn(); } finally { used += performance.now() - slice; }
  };
  const fail = (h) => {
    const e = ctx.dump(h);
    h.dispose();
    if (cpuKill) return new ScriptError(`Превышен лимит CPU тарифа: ${cpuMs} мс на запрос`, { kind: 'cpu' });
    const msg = typeof e === 'object' && e ? `${e.name || 'Error'}: ${e.message}` : String(e);
    if (/out of memory/i.test(msg)) return new ScriptError('Скрипт превысил лимит памяти 32 МБ', { kind: 'memory' });
    return new ScriptError(msg, { stack: e?.stack || null });
  };
  try {
    const def = (name, fn) => { const h = ctx.newFunction(name, fn); ctx.setProp(ctx.global, name, h); h.dispose(); };
    def('__log', (lv, text) => { host.log(ctx.getString(lv), ctx.getString(text)); });
    const hostCall = (fn) => {
      try { return ctx.newString(JSON.stringify(fn() ?? null)); } catch (e) {
        throw new Error(e.message);
      }
    };
    def('__db', (op, sql, params) => hostCall(() => host.db(ctx.getString(op), ctx.getString(sql), JSON.parse(ctx.getString(params)))));
    def('__kv', (op, args) => hostCall(() => host.kv(ctx.getString(op), JSON.parse(ctx.getString(args)))));
    def('__now', () => ctx.newNumber(host.now()));
    def('__ws', (op, args) => hostCall(() => {
      if (!host.ws) throw new Error('WebSocket доступен на виртуальном тарифе');
      return host.ws(ctx.getString(op), JSON.parse(ctx.getString(args)));
    }));
    def('__uuid', () => ctx.newString(crypto.randomUUID()));
    def('__fetch', (reqH) => {
      const d = ctx.newPromise();
      const req = JSON.parse(ctx.getString(reqH));
      const p = Promise.resolve().then(() => host.fetch(req)).then(
        (r) => r, (e) => ({ error: e.message || String(e) }),
      ).then((r) => {
        pending.delete(p);
        if (!ctx.alive) return;
        try { const s = ctx.newString(JSON.stringify(r)); d.resolve(s); s.dispose(); d.dispose(); } catch { /* рантайм уже закрыт */ }
      });
      pending.add(p);
      return d.handle;
    });
    const pre = enter(() => ctx.evalCode(PRELUDE, 'prelude.js'));
    if (pre.error) throw fail(pre.error);
    pre.value.dispose();
    const mod = enter(() => ctx.evalCode(src, entry, { type: 'module' }));
    if (mod.error) throw fail(mod.error);
    ctx.setProp(ctx.global, '__mod', mod.value);
    mod.value.dispose();
    const handle = ctx.getProp(ctx.global, '__handle');
    const a1 = ctx.newString(handler);
    const a2 = ctx.newString(JSON.stringify(arg ?? null));
    const call = enter(() => ctx.callFunction(handle, ctx.undefined, a1, a2));
    handle.dispose(); a1.dispose(); a2.dispose();
    if (call.error) throw fail(call.error);
    const promise = call.value;
    const native = ctx.resolvePromise(promise);
    promise.dispose();
    let settled = null;
    native.then((r) => { settled = r; });
    const deadline = Date.now() + WALL_MS;
    for (;;) {
      const jobs = enter(() => rt.executePendingJobs());
      if (jobs.error) throw fail(jobs.error);
      await new Promise((r) => setImmediate(r));
      if (settled) break;
      if (pending.size) await Promise.race([...pending, new Promise((r) => setTimeout(r, 50))]);
      else if (!rt.hasPendingJob()) await new Promise((r) => setTimeout(r, 1));
      if (Date.now() > deadline) throw new ScriptError('Скрипт не ответил за 15 секунд', { kind: 'timeout' });
      if (cpuKill) throw new ScriptError(`Превышен лимит CPU тарифа: ${cpuMs} мс на запрос`, { kind: 'cpu' });
    }
    if (settled.error) throw fail(settled.error);
    const out = JSON.parse(ctx.getString(settled.value));
    settled.value.dispose();
    if (out.missing) throw new ScriptError(`В ${entry} нет функции ${handler}`, { kind: 'missing' });
    return { result: out, cpuMs: Math.round(used * 10) / 10 };
  } finally {
    try {
      ctx.dispose();
      rt.dispose();
    } catch {
      // Незакрытые объекты скрипта (например, при таймауте) ломают экземпляр WASM — следующий вызов создаст новый.
      QJ = null;
    }
  }
}
