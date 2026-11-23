// Push-уведомления (этап Н10).
// /api/push/*      — настоящий Web Push для ВлодБанка и ВлодУслуг: ключ VAPID, подписка устройства, проверка.
// /api/net/push/*  — ВлодБраузер: устройство push БалНета, подписки сайтов (PushManager), входящие сообщения.
import { session } from '../lib/auth.js';
import { bad, unauthorized } from '../lib/errors.js';
import { vapidKeys } from '../lib/webpush.js';
import {
  subscribeUser, unsubscribeUser, userDevices, removeUserDevice, pushToUser,
  createDevice, deviceAuth, setDeviceWeb, deleteDevice, siteSubscribe, siteSubscription, siteUnsubscribe, deviceSubs, inbox,
} from '../lib/push.js';

const limited = (max) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

async function who(req) {
  const kind = req.query.kind === 'gov' || req.body?.kind === 'gov' ? 'gov' : req.query.kind === 'bank' || req.body?.kind === 'bank' ? 'bank' : null;
  if (!kind) throw bad('invalid', 'kind: bank | gov');
  const s = await session(req, kind);
  if (!s) throw unauthorized();
  return s;
}

export async function pushRoutes(app) {
  app.get('/key', async () => ({ publicKey: (await vapidKeys()).publicKey }));

  app.get('/devices', async (req) => {
    const s = await who(req);
    return { devices: await userDevices(s.kind, s.id) };
  });

  app.post('/subscribe', limited(30), async (req) => {
    const s = await who(req);
    return subscribeUser(s.kind, s.id, req.body?.subscription, req.headers['user-agent']);
  });

  app.post('/unsubscribe', async (req) => {
    const s = await who(req);
    if (req.body?.id) return removeUserDevice(s.kind, s.id, req.body.id);
    return unsubscribeUser(s.kind, s.id, req.body?.endpoint);
  });

  app.post('/test', limited(5), async (req) => {
    const s = await who(req);
    const sent = await pushToUser(s.kind, s.id, { title: 'Проверка push-уведомлений', body: 'Если вы это видите — push на этом устройстве работает', link: '#/', tag: 'push-test' });
    return { ok: true, sent };
  });
}

/** API ВлодБраузера (настоящий origin браузера, не песочница сайтов). */
export async function netPushRoutes(app) {
  const dev = (req) => deviceAuth(req.body?.device, req.body?.token);

  app.post('/device', limited(10), async (req) => createDevice(req.body?.label));
  app.post('/device/web', limited(20), async (req) => setDeviceWeb(await dev(req), req.body?.subscription || null));
  app.post('/device/delete', async (req) => deleteDevice(await dev(req)));
  app.post('/subs', async (req) => ({ subs: await deviceSubs(await dev(req)) }));

  app.post('/subscribe', limited(60), async (req) => ({ subscription: await siteSubscribe(await dev(req), req.body?.origin, req.body?.applicationServerKey || null) }));
  app.post('/subscription', async (req) => ({ subscription: await siteSubscription(await dev(req), req.body?.origin) }));
  app.post('/unsubscribe', async (req) => siteUnsubscribe(await dev(req), req.body?.origin));

  app.post('/inbox', limited(120), async (req) => ({ messages: await inbox(await dev(req), req.body?.after) }));
}
