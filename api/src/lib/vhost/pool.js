// Пул рабочих потоков PHP и Python. Отдельные очереди: PHP — до 2 потоков, Python — 1 (Pyodide тяжёлый).
// Задание дольше лимита — поток завершается и создаётся заново. Простаивающий поток через 5 минут
// останавливается и освобождает память.
import { Worker } from 'node:worker_threads';

const LIMITS = { php: 2, python: 1 };
const IDLE_MS = 5 * 60 * 1000;
const pools = { php: [], python: [] };
const queues = { php: [], python: [] };
let seq = 0;

function spawn(kind) {
  const w = new Worker(new URL('./worker.js', import.meta.url));
  const slot = { kind, w, busy: null, idleTimer: null, dead: false };
  w.on('message', (m) => {
    if (m.type === 'fetch') {
      const job = slot.busy;
      Promise.resolve(job?.onFetch ? job.onFetch(m.req) : { error: 'Сеть недоступна' })
        .catch((e) => ({ error: e.message }))
        .then((res) => { if (!slot.dead) w.postMessage({ type: 'fetchResult', id: m.id, res }); });
      return;
    }
    if (m.type === 'done' && slot.busy && slot.busy.id === m.id) {
      const job = slot.busy;
      clearTimeout(job.timer);
      slot.busy = null;
      if (m.error) job.reject(new Error(m.error));
      else job.resolve(m.result);
      next(kind);
    }
  });
  w.on('error', (e) => fail(slot, e));
  w.on('exit', () => fail(slot, new Error('Поток интерпретатора завершился')));
  pools[kind].push(slot);
  return slot;
}

function fail(slot, err) {
  if (slot.dead) return;
  slot.dead = true;
  pools[slot.kind] = pools[slot.kind].filter((s) => s !== slot);
  if (slot.busy) { clearTimeout(slot.busy.timer); slot.busy.reject(err); slot.busy = null; }
  next(slot.kind);
}

function next(kind) {
  if (!queues[kind].length) {
    for (const s of pools[kind]) {
      if (!s.busy && !s.idleTimer) s.idleTimer = setTimeout(() => { s.dead = true; pools[kind] = pools[kind].filter((x) => x !== s); s.w.terminate(); }, IDLE_MS);
    }
    return;
  }
  let slot = pools[kind].find((s) => !s.busy && !s.dead);
  if (!slot && pools[kind].length < LIMITS[kind]) slot = spawn(kind);
  if (!slot) return;
  clearTimeout(slot.idleTimer);
  slot.idleTimer = null;
  const job = queues[kind].shift();
  slot.busy = job;
  // Время считается с начала выполнения; первый запуск ещё и загружает интерпретатор.
  const limit = job.timeoutMs + (slot.warm ? 0 : 15000);
  slot.warm = true;
  job.timer = setTimeout(() => {
    const err = new Error('timeout');
    err.kind = 'timeout';
    slot.busy = null;
    job.reject(err);
    slot.dead = true;
    pools[kind] = pools[kind].filter((s) => s !== slot);
    slot.w.terminate();
    next(kind);
  }, limit);
  slot.w.postMessage({ id: job.id, kind, job: job.payload });
  next(kind);
}

/** Выполнить задание: kind — php | python; payload — см. worker.js. */
export function runInPool(kind, payload, { timeoutMs, onFetch }) {
  return new Promise((resolve, reject) => {
    if (queues[kind].length > 50) { reject(Object.assign(new Error('Очередь интерпретатора переполнена'), { kind: 'busy' })); return; }
    queues[kind].push({ id: ++seq, payload, timeoutMs, onFetch, resolve, reject });
    next(kind);
  });
}

export async function stopPools() {
  for (const kind of Object.keys(pools)) for (const s of pools[kind]) { s.dead = true; await s.w.terminate(); }
  pools.php = []; pools.python = [];
}
