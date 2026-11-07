import { session, posSession } from '../lib/auth.js';
import { subscribe, unsubscribe, dropSocket, publish } from '../lib/hub.js';
import { one, q } from '../db.js';
import { deviceOk } from '../lib/push.js';

/** WebSocket /ws. Клиент шлёт {op:'sub'|'unsub', channel}; сервер — события каналов.
 * push:<устройство> — сообщения push БалНета для ВлодБраузера, подписка с секретом устройства (token). */
export async function wsRoutes(app) {
  app.get('/ws', { websocket: true }, (socket, req) => {
    // Обработчики вешаем синхронно, иначе ранние сообщения потеряются.
    let bank = null, gov = null, pos = null, isAdmin = false;
    const ready = Promise.all([session(req, 'bank'), session(req, 'gov'), posSession(req)]).then(([b, g, p]) => {
      bank = b; gov = g; pos = p;
      isAdmin = [b, g].some((s) => s?.roles.includes('admin'));
      socket.send(JSON.stringify({ op: 'hello', bank: bank?.id || null, gov: gov?.id || null, shop: pos?.shopId || null }));
    }).catch(() => socket.close());

    async function allowed(channel, msg) {
      if (channel === 'clock') return true;
      // Страница оплаты: статус своего платежа (id платежа длинный и случайный).
      if (channel.startsWith('pay:pay_')) return channel.length > 16;
      if (channel.startsWith('push:')) return /^push:\d+$/.test(channel) && deviceOk(channel.slice(5), String(msg.token || ''));
      if (channel === 'admin') return isAdmin;
      if (channel.startsWith('user:b')) return bank && `user:b${bank.id}` === channel;
      if (channel.startsWith('user:g')) return gov && `user:g${gov.id}` === channel;
      if (channel.startsWith('shop:')) return (pos && `shop:${pos.shopId}` === channel) || isAdmin;
      if (channel.startsWith('terminal:')) {
        const code = channel.slice(9);
        if (!/^\d{6}$/.test(code)) return false;
        const t = await one("SELECT id FROM terminals WHERE code = ? AND status <> 'closed'", [code]);
        return !!t;
      }
      return false;
    }

    socket.on('message', async (raw) => {
      await ready;
      let msg;
      try { msg = JSON.parse(String(raw)); } catch { return; }
      if (msg.op === 'ping') return socket.send(JSON.stringify({ op: 'pong' }));
      const ch = String(msg.channel || '');
      if (msg.op === 'sub') {
        if (await allowed(ch, msg)) {
          subscribe(socket, ch);
          socket.send(JSON.stringify({ op: 'subscribed', channel: ch }));
          if (ch.startsWith('terminal:') && msg.role === 'terminal') {
            const code = ch.slice(9);
            await q("UPDATE terminals SET status = 'paired', last_seen_at = NOW(3) WHERE code = ? AND status <> 'closed'", [code]);
            publish(ch, { type: 'terminal_joined' });
            socket.__terminal = code;
          }
        } else {
          socket.send(JSON.stringify({ op: 'denied', channel: ch }));
        }
      } else if (msg.op === 'unsub') {
        unsubscribe(socket, ch);
      }
    });

    const alive = setInterval(() => socket.readyState === 1 && socket.ping(), 25000);
    socket.on('close', () => {
      clearInterval(alive);
      if (socket.__terminal) publish(`terminal:${socket.__terminal}`, { type: 'terminal_left' });
      dropSocket(socket);
    });
  });
}
