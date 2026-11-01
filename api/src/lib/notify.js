// Уведомления: лента в кабинете + WebSocket (+ email по желанию). Web Push — этап 9.
import { q, afterCommit, one } from '../db.js';
import { publish, userChannel } from './hub.js';
import { sendMail } from './mail.js';

export async function notify(conn, kind, userId, { title, body = null, link = null, email = false }) {
  const res = await q('INSERT INTO notifications (user_kind, user_id, title, body, link) VALUES (?, ?, ?, ?, ?)', [kind, userId, title, body, link], conn);
  const id = res.insertId;
  afterCommit(conn, async () => {
    publish(userChannel(kind, userId), { type: 'notification', notification: { id, title, body, link } });
    if (email) {
      const u = await one(`SELECT email FROM ${kind === 'bank' ? 'bank_users' : 'gov_users'} WHERE id = ?`, [userId]);
      if (u) await sendMail({ to: u.email, brand: kind === 'bank' ? 'ВлодБанк' : 'ВлодУслуги', subject: title, text: body || title });
    }
  });
  return id;
}

export function notifyAdmins(type, data = {}) {
  publish('admin', { type, ...data });
}
