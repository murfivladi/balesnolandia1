// WebSocket сайтов на виртуальном тарифе. Посетитель (shim в странице) открывает соединение со шлюзом,
// шлюз проходит путь как браузер (DNS, подключение к серверу, TLS для wss) и держит соединение.
// Каждое событие (open, message, close) вызывает onSocket(event) из server.js; состояние — в db и kv,
// отправка — sockets.send / sockets.broadcast. Лимит одновременных соединений — по тарифу.
import crypto from 'node:crypto';
import { runSite, setWsHost } from './respond.js';
import { addLog } from './logs.js';

const MAX_MESSAGE = 64 * 1024;
const MAX_RATE = 20; // сообщений в секунду на соединение
const bySite = new Map(); // siteId → Map(id → conn)

export const socketCount = (siteId) => bySite.get(siteId)?.size || 0;

function hostFor(siteId) {
  const conns = () => bySite.get(siteId) || new Map();
  return (op, a) => {
    if (op === 'send') {
      const c = conns().get(String(a.id));
      if (!c) return false;
      c.ws.send(String(a.data).slice(0, MAX_MESSAGE));
      return true;
    }
    if (op === 'broadcast') {
      let n = 0;
      for (const c of conns().values()) {
        if (a.path && c.path !== a.path) continue;
        if (a.except && c.id === a.except) continue;
        c.ws.send(String(a.data).slice(0, MAX_MESSAGE));
        n++;
      }
      return n;
    }
    if (op === 'close') {
      const c = conns().get(String(a.id));
      if (c) c.ws.close(1000, String(a.reason || '').slice(0, 120));
      return !!c;
    }
    if (op === 'list') return [...conns().values()].filter((c) => !a.path || c.path === a.path).map((c) => ({ id: c.id, path: c.path, ip: c.ip }));
    throw new Error('sockets: неизвестная операция');
  };
}

setWsHost(hostFor);

const info = (c) => ({ id: c.id, path: c.path, query: c.query, ip: c.ip, origin: c.origin });

async function event(site, c, type, data) {
  try {
    const r = await runSite(site, 'onSocket', { type, socket: info(c), data: data ?? null }, { ws: hostFor(site.id) });
    return r?.value;
  } catch (e) {
    if (e.kind === 'missing') {
      addLog(site.id, 'error', 'WebSocket: в server.js нет функции onSocket(event)');
      c.ws.close(1011, 'no handler');
    } else if (!e.kind) addLog(site.id, 'error', `onSocket(${type}): ${e.message}`);
    return undefined;
  }
}

/** Подключить сокет посетителя к сайту. */
export async function attach(ws, site, { path, query, ip, origin }) {
  if (!bySite.has(site.id)) bySite.set(site.id, new Map());
  const conns = bySite.get(site.id);
  if (conns.size >= Number(site.ws_limit || 0)) {
    ws.close(1013, 'ws limit');
    addLog(site.id, 'warn', `WebSocket: отказ — достигнут лимит тарифа (${site.ws_limit} соединений)`);
    return;
  }
  const c = { id: crypto.randomBytes(6).toString('hex'), ws, path, query, ip, origin, sec: 0, n: 0, queue: Promise.resolve() };
  conns.set(c.id, c);
  // События одного соединения — строго по порядку.
  const push = (type, data) => { c.queue = c.queue.then(() => event(site, c, type, data)); return c.queue; };
  ws.on('message', (raw, isBinary) => {
    const s = Math.floor(Date.now() / 1000);
    if (c.sec !== s) { c.sec = s; c.n = 0; }
    if (++c.n > MAX_RATE) { ws.close(1008, 'rate limit'); return; }
    if (isBinary || raw.length > MAX_MESSAGE) { ws.close(1009, 'too big'); return; }
    push('message', String(raw));
  });
  ws.on('close', () => {
    conns.delete(c.id);
    push('close');
  });
  const accepted = await push('open');
  if (accepted === false) ws.close(1008, 'rejected');
}

export function closeSiteSockets(siteId) {
  for (const c of bySite.get(siteId)?.values() || []) c.ws.close(1001, 'site gone');
  bySite.delete(siteId);
}
