// Шина WebSocket: каналы user:b<id>, user:g<id>, terminal:<code>, shop:<id>, admin, clock.

const channels = new Map(); // channel -> Set<socket>

export function subscribe(socket, channel) {
  if (!channels.has(channel)) channels.set(channel, new Set());
  channels.get(channel).add(socket);
  socket.__channels ??= new Set();
  socket.__channels.add(channel);
}

export function unsubscribe(socket, channel) {
  channels.get(channel)?.delete(socket);
  socket.__channels?.delete(channel);
  if (channels.get(channel)?.size === 0) channels.delete(channel);
}

export function dropSocket(socket) {
  for (const ch of socket.__channels || []) unsubscribe(socket, ch);
}

export function publish(channel, message) {
  const set = channels.get(channel);
  if (!set) return 0;
  const data = JSON.stringify({ channel, ...message });
  let n = 0;
  for (const s of set) {
    if (s.readyState === 1) { s.send(data); n++; }
  }
  return n;
}

export function listeners(channel) {
  return channels.get(channel)?.size || 0;
}

export const userChannel = (kind, id) => `user:${kind === 'bank' ? 'b' : 'g'}${id}`;
