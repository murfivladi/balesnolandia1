// Одно WebSocket-соединение на вкладку с переподключением и подписками на каналы.
import { wsUrl } from './api.js';

const handlers = new Map(); // channel -> Set<fn>
const statusListeners = new Set();
let socket = null;
let connected = false;
let retry = 0;
let pingTimer = null;
let reconnectTimer = null;

function setConnected(v) {
  if (connected === v) return;
  connected = v;
  statusListeners.forEach((f) => f(v));
}

function send(msg) {
  if (socket && socket.readyState === 1) socket.send(JSON.stringify(msg));
}

function connect() {
  clearTimeout(reconnectTimer);
  try {
    socket = new WebSocket(wsUrl());
  } catch {
    scheduleReconnect();
    return;
  }
  socket.onopen = () => {
    retry = 0;
    setConnected(true);
    for (const [ch, set] of handlers) if (set.size) send({ op: 'sub', channel: ch, role: set.role, token: set.token });
    clearInterval(pingTimer);
    pingTimer = setInterval(() => send({ op: 'ping' }), 20000);
  };
  socket.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.channel && handlers.has(msg.channel)) handlers.get(msg.channel).forEach((f) => f(msg));
  };
  socket.onclose = () => {
    setConnected(false);
    clearInterval(pingTimer);
    scheduleReconnect();
  };
  socket.onerror = () => socket?.close();
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  retry = Math.min(retry + 1, 6);
  reconnectTimer = setTimeout(connect, 500 * 2 ** retry);
}

/** Подписаться на канал. role — для терминала покупателя, token — секрет канала (push:<устройство>). Возвращает отписку. */
export function subscribe(channel, fn, role, token) {
  if (!handlers.has(channel)) handlers.set(channel, new Set());
  const set = handlers.get(channel);
  if (role) set.role = role;
  if (token) set.token = token;
  set.add(fn);
  if (!socket) connect();
  else if (set.size === 1) send({ op: 'sub', channel, role, token });
  return () => {
    set.delete(fn);
    if (!set.size) {
      handlers.delete(channel);
      send({ op: 'unsub', channel });
    }
  };
}

/** Переподключиться (после входа/выхода меняются права на каналы). */
export function reconnect() {
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  setConnected(false);
  connect();
}

export function onWsStatus(fn) {
  statusListeners.add(fn);
  fn(connected);
  return () => statusListeners.delete(fn);
}

export function ensureSocket() {
  if (!socket) connect();
}
