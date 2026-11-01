import { q } from '../db.js';
import { session } from '../lib/auth.js';
import { unauthorized, bad } from '../lib/errors.js';
import { getSettings, publicSettings } from '../lib/settings.js';
import { clockState } from '../lib/clock.js';

export async function commonRoutes(app) {
  app.get('/public/settings', async () => publicSettings(await getSettings()));
  app.get('/clock', async () => clockState());

  async function who(req) {
    const kind = req.query.kind === 'gov' ? 'gov' : req.query.kind === 'bank' ? 'bank' : null;
    if (!kind) throw bad('invalid', 'kind: bank | gov');
    const s = await session(req, kind);
    if (!s) throw unauthorized();
    return s;
  }

  app.get('/notifications', async (req) => {
    const s = await who(req);
    const items = await q('SELECT id, title, body, link, read_at, created_at FROM notifications WHERE user_kind = ? AND user_id = ? ORDER BY id DESC LIMIT 100', [s.kind, s.id]);
    const unread = items.filter((n) => !n.read_at).length;
    return { items, unread };
  });

  app.post('/notifications/read', async (req) => {
    const s = await who(req);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isSafeInteger) : null;
    if (ids && ids.length) {
      await q(`UPDATE notifications SET read_at = NOW(3) WHERE user_kind = ? AND user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`, [s.kind, s.id, ...ids]);
    } else {
      await q('UPDATE notifications SET read_at = NOW(3) WHERE user_kind = ? AND user_id = ? AND read_at IS NULL', [s.kind, s.id]);
    }
    return { ok: true };
  });
}
