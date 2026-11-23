// Этап Н10: push-уведомления. Шифрование aes128gcm (RFC 8291) и VAPID (RFC 8292); настоящий Web Push
// для ВлодБанка и ВлодУслуг (уведомления ленты уходят на устройства); push-сервис БалНета push.bln:
// устройство ВлодБраузера, подписка сайта, отправка сервером сайта по сети БалНета, TTL, Topic, 410 после отписки.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import { setup, client, pool } from './helpers.js';

let app;
let clock;
let wp;
let netRequest;
let clientIp;

before(async () => {
  app = await setup();
  clock = await import('../src/lib/clock.js');
  clock.setGameTimeOverride(() => 200000);
  (await import('../src/lib/dns.js')).flushResolverCache();
  wp = await import('../src/lib/webpush.js');
  wp.resetVapidCache();
  ({ netRequest } = await import('../src/lib/vhost/respond.js'));
  const dev = client(app);
  clientIp = (await dev.post('/api/net/lease', { client_id: 'device-push-01', provider: 'baltelecom' })).ip;
});
after(async () => {
  await (await import('../src/lib/vhost/pool.js')).stopPools();
  await fs.rm(process.env.BALNET_SITES_DIR, { recursive: true, force: true });
  clock.setGameTimeOverride(null);
  await app.close();
  await pool.end();
});

/** «Браузер»: пара ключей получателя и секрет auth, как у PushSubscription. */
function receiver() {
  const ecdh = crypto.createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    priv: ecdh.getPrivateKey().toString('base64url'),
    keys: { p256dh: ecdh.getPublicKey().toString('base64url'), auth: crypto.randomBytes(16).toString('base64url') },
  };
}
const open = (r, body) => JSON.parse(wp.decrypt(body, { publicKey: r.keys.p256dh, privateKey: r.priv, auth: r.keys.auth }).toString('utf8'));

test('aes128gcm: шифрование и расшифровка, чужой ключ не подходит', () => {
  const r = receiver();
  const body = wp.encrypt(JSON.stringify({ title: 'Привет' }), r.keys);
  assert.equal(body.readUInt32BE(16), 4096);
  assert.equal(body[20], 65);
  assert.deepEqual(open(r, body), { title: 'Привет' });
  const other = receiver();
  assert.throws(() => open({ ...other, keys: { ...other.keys, auth: r.keys.auth } }, body), /не удалось расшифровать/);
  assert.throws(() => wp.encrypt('x'.repeat(4000), r.keys), /больше/);
});

test('VAPID: подпись, проверка, aud и срок', () => {
  const k = wp.newKeyPair();
  const h = wp.vapidHeader({ audience: 'https://push.bln', subject: 'mailto:a@b.bf', ...k });
  const ok = wp.verifyVapid(h, { audience: 'https://push.bln' });
  assert.equal(ok.ok, true);
  assert.equal(ok.key, k.publicKey);
  assert.equal(wp.verifyVapid(h, { audience: 'https://other.bln' }).status, 403);
  const old = wp.vapidHeader({ audience: 'https://push.bln', subject: 'mailto:a@b.bf', ...k, now: Date.now() - 13 * 3600 * 1000 });
  assert.match(wp.verifyVapid(old, { audience: 'https://push.bln' }).message, /истёк/);
  const stranger = wp.newKeyPair();
  const forged = h.replace(`k=${k.publicKey}`, `k=${stranger.publicKey}`);
  assert.match(wp.verifyVapid(forged, { audience: 'https://push.bln' }).message, /подпись/);
  assert.equal(wp.verifyVapid('Bearer x', { audience: 'https://push.bln' }).status, 401);
});

test('Web Push пользователя: подписка, уведомление ленты уходит на устройство, отписка', async () => {
  const gov = client(app);
  await gov.post('/api/auth/gov/register', { email: 'push@test.bf', password: 'password123', display_name: 'Пушкин' });
  const { one } = await import('./helpers.js');
  const userId = (await one("SELECT id FROM gov_users WHERE email = 'push@test.bf'")).id;
  const { publicKey } = await gov.get('/api/push/key');
  assert.equal(Buffer.from(publicKey, 'base64url').length, 65);
  const r = receiver();
  const endpoint = 'https://fcm.googleapis.com/fcm/send/test-endpoint-1';
  await assert.rejects(gov.post('/api/push/subscribe', { kind: 'gov', subscription: { endpoint: 'http://127.0.0.1/x', keys: r.keys } }), /push-сервис/);
  await assert.rejects(gov.post('/api/push/subscribe', { kind: 'gov', subscription: { endpoint, keys: { p256dh: 'abc', auth: 'x' } } }), /ключи/);
  await assert.rejects(client(app).post('/api/push/subscribe', { kind: 'gov', subscription: { endpoint, keys: r.keys } }), /401/);
  await gov.post('/api/push/subscribe', { kind: 'gov', subscription: { endpoint, keys: r.keys } });
  await gov.post('/api/push/subscribe', { kind: 'gov', subscription: { endpoint, keys: r.keys } }); // повтор — та же подписка
  assert.equal((await gov.get('/api/push/devices?kind=gov')).devices.length, 1);

  wp.sentPushes.length = 0;
  const { notify } = await import('../src/lib/notify.js');
  await notify(null, 'gov', userId, { title: 'Квитанция оплачена', body: 'Госпошлина', link: '#/invoices' });
  await new Promise((res) => setTimeout(res, 200));
  assert.equal(wp.sentPushes.length, 1);
  const sent = wp.sentPushes[0];
  assert.equal(sent.endpoint, endpoint);
  assert.equal(sent.headers['Content-Encoding'], 'aes128gcm');
  assert.ok(sent.headers.TTL);
  const v = wp.verifyVapid(sent.headers.Authorization, { audience: 'https://fcm.googleapis.com' });
  assert.equal(v.ok, true);
  assert.equal(v.key, publicKey);
  const msg = open(r, sent.body);
  assert.equal(msg.title, 'Квитанция оплачена');
  assert.equal(msg.body, 'Госпошлина');
  assert.match(msg.url, /\/services\/#\/invoices$/);

  wp.sentPushes.length = 0;
  assert.equal((await gov.post('/api/push/test', { kind: 'gov' })).sent, 1);
  assert.equal(open(r, wp.sentPushes[0].body).title, 'Проверка push-уведомлений');

  await gov.post('/api/push/unsubscribe', { kind: 'gov', endpoint });
  assert.equal((await gov.get('/api/push/devices?kind=gov')).devices.length, 0);
});

test('push.bln: устройство ВлодБраузера, подписка сайта, отправка с сервера сайта по сети БалНета', async () => {
  const br = client(app);
  const dev = await br.post('/api/net/push/device', { label: 'Профиль 1' });
  const auth = { device: dev.id, token: dev.token };
  await assert.rejects(br.post('/api/net/push/subscribe', { device: dev.id, token: 'wrong', origin: 'https://shop.bln' }), /403/);
  await assert.rejects(br.post('/api/net/push/subscribe', { ...auth, origin: 'http://shop.bln' }), /https/);

  const vapid = wp.newKeyPair(); // ключи сервера сайта
  const { subscription: sub } = await br.post('/api/net/push/subscribe', { ...auth, origin: 'https://shop.bln', applicationServerKey: vapid.publicKey });
  assert.match(sub.endpoint, /^https:\/\/push\.bln\/send\/[A-Za-z0-9_-]+$/);
  assert.equal(Buffer.from(sub.keys.p256dh, 'base64url').length, 65);
  const again = await br.post('/api/net/push/subscribe', { ...auth, origin: 'https://shop.bln', applicationServerKey: vapid.publicKey });
  assert.equal(again.subscription.endpoint, sub.endpoint);
  await assert.rejects(br.post('/api/net/push/subscribe', { ...auth, origin: 'https://shop.bln', applicationServerKey: wp.newKeyPair().publicKey }), /InvalidStateError/);
  assert.equal((await br.post('/api/net/push/subscription', { ...auth, origin: 'https://shop.bln' })).subscription.endpoint, sub.endpoint);

  const send = (headers, body) => netRequest({ fromIp: clientIp, url: sub.endpoint, method: 'POST', headers, body });
  const signed = () => wp.vapidHeader({ audience: 'https://push.bln', subject: 'mailto:owner@shop.bln', ...vapid });
  const info = await netRequest({ fromIp: clientIp, url: 'https://push.bln/' });
  assert.equal(info.status, 200);
  assert.match(info.body, /RFC 8030/);
  assert.match((await netRequest({ fromIp: clientIp, url: sub.endpoint.replace('https:', 'http:'), method: 'POST', headers: { ttl: '60' } })).error, /REFUSED/);
  assert.equal((await send({ authorization: signed() }, null)).status, 400); // нет TTL
  assert.equal((await send({ ttl: '60' }, null)).status, 401); // нет VAPID
  const wrongAud = wp.vapidHeader({ audience: 'https://shop.bln', subject: 'mailto:o@shop.bln', ...vapid });
  assert.equal((await send({ ttl: '60', authorization: wrongAud }, null)).status, 403);
  const otherKey = wp.newKeyPair();
  assert.match((await send({ ttl: '60', authorization: wp.vapidHeader({ audience: 'https://push.bln', subject: 'mailto:x@y.bf', ...otherKey }) }, null)).body, /не совпадает/);

  // Настоящий Web Push этого браузера: сообщение сайта придёт и на телефон.
  const phone = receiver();
  await br.post('/api/net/push/device/web', { ...auth, subscription: { endpoint: 'https://updates.push.services.mozilla.com/wpush/v2/abc', keys: phone.keys } });
  wp.sentPushes.length = 0;

  const enc = wp.encrypt(JSON.stringify({ title: 'Скидка 20%', body: 'Только сегодня', url: '/sale', tag: 'sale' }), sub.keys);
  const ok = await send({ ttl: '3600', urgency: 'high', 'content-encoding': 'aes128gcm', 'content-type': 'application/octet-stream', authorization: signed() }, enc);
  assert.equal(ok.status, 201, ok.body);
  assert.match(ok.headers.location, /^https:\/\/push\.bln\/m\/\d+$/);
  const bad = Buffer.from(enc);
  bad[bad.length - 1] ^= 1;
  assert.match((await send({ ttl: '60', 'content-encoding': 'aes128gcm', authorization: signed() }, bad)).body, /расшифровать/);

  let box = (await br.post('/api/net/push/inbox', { ...auth, after: 0 })).messages;
  assert.equal(box.length, 1);
  assert.equal(box[0].title, 'Скидка 20%');
  assert.equal(box[0].url, 'https://shop.bln/sale');
  assert.equal(box[0].urgency, 'high');
  assert.equal(box[0].encrypted, 1);

  await new Promise((res) => setTimeout(res, 100));
  assert.equal(wp.sentPushes.length, 1);
  const onPhone = open(phone, wp.sentPushes[0].body);
  assert.equal(onPhone.title, 'Скидка 20%');
  assert.match(onPhone.body, /^shop\.bln — Только сегодня/);
  assert.match(onPhone.url, /\/#https:\/\/shop\.bln\/sale$/);

  // Без applicationServerKey VAPID не нужен; JSON без шифрования — учебный режим. Чужой url заменяется главной.
  const { subscription: blog } = await br.post('/api/net/push/subscribe', { ...auth, origin: 'https://blog.bln' });
  const plain = (body, extra = {}) => netRequest({ fromIp: clientIp, url: blog.endpoint, method: 'POST', headers: { ttl: '60', 'content-type': 'application/json', ...extra }, body });
  assert.equal((await plain(JSON.stringify({ title: 'Новый пост', url: 'https://evil.bln/' }), { topic: 'news' })).status, 201);
  assert.equal((await plain(JSON.stringify({ title: 'Новый пост 2' }), { topic: 'news' })).status, 201); // заменяет предыдущий
  assert.equal((await plain('просто текст')).status, 400);
  assert.equal((await plain('{}', { urgency: 'asap' })).status, 400);
  box = (await br.post('/api/net/push/inbox', { ...auth, after: 0 })).messages;
  const posts = box.filter((m) => m.origin === 'https://blog.bln');
  assert.equal(posts.length, 1);
  assert.equal(posts[0].title, 'Новый пост 2');
  assert.equal(posts[0].url, 'https://blog.bln/');
  assert.equal((await br.post('/api/net/push/inbox', { ...auth, after: box[box.length - 1].id })).messages.length, 0);

  // TTL 0 без браузера на связи — не хранится.
  assert.equal((await plain('{"title":"срочно"}', { ttl: '0' })).status, 201);
  assert.equal((await br.post('/api/net/push/inbox', { ...auth, after: 0 })).messages.some((m) => m.title === 'срочно'), false);

  const subs = (await br.post('/api/net/push/subs', auth)).subs;
  assert.deepEqual(subs.map((s) => s.origin), ['https://blog.bln', 'https://shop.bln']);

  await br.post('/api/net/push/unsubscribe', { ...auth, origin: 'https://shop.bln' });
  assert.equal((await send({ ttl: '60', authorization: signed() }, null)).status, 410);
  await br.post('/api/net/push/device/delete', auth);
  await assert.rejects(br.post('/api/net/push/inbox', { ...auth, after: 0 }), /403/);
});

test('push.bln в DNS и с сертификатом госсайта; разрешение на уведомления — только для https', async () => {
  const dev = client(app);
  const r = await dev.post('/api/net/open', { client_id: 'device-push-01', url: 'https://push.bln/' });
  assert.equal(r.ok, true);
  assert.equal(r.target, 'app:push');
  assert.ok(r.tls);
});

test('server.js сайта шлёт push сам: webpush.sendNotification с VAPID и шифрованием (как npm web-push)', async () => {
  const admin = client(app);
  await admin.post('/api/auth/gov/register', { email: 'admin@test.bf', password: 'password123', display_name: 'Админ' });
  await admin.patch('/api/admin/settings', { fraud_threshold: 0, fraud_velocity: 0, fraud_multiplier: 0, start_balance: 200000, transfer_fee_bp: 0, transfer_fee_min: 0, vat_bp: 0 });
  const gov = client(app);
  await gov.post('/api/auth/gov/register', { email: 'shop@test.bf', password: 'password123', display_name: 'Борис Пушев' });
  await gov.post('/api/gov/passport', { full_name: 'Борис Пушев', birth_date: '1990-05-01', address: 'Влодоград' });
  const me = await gov.get('/api/gov/me');
  const bank = client(app);
  await bank.post('/api/auth/bank/register', { email: 'shop@test.bf', password: 'password123', full_name: 'Борис Пушев', birth_date: '1990-05-01', passport_no: me.passport.number });
  await gov.post(`/api/gov/links/${(await gov.get('/api/gov/links')).links[0].id}/confirm`);
  const cur = (await bank.post('/api/bank/accounts', { type: 'current' })).account;
  const pay = (number) => bank.post(`/api/bank/invoices/${number}/pay`, { account_id: cur.id });
  const virt = (await gov.get('/api/gov/hosting')).offers.find((o) => o.kind === 'virtual');
  await pay((await gov.post('/api/gov/domains', { name: 'pushshop.bln' })).invoice);
  const acc = await gov.post('/api/gov/hosting', { plan_id: virt.id, months: 2 });
  await pay(acc.invoice);
  const st = await gov.post(`/api/gov/hosting/${acc.account_id}/sites`, { host: 'pushshop.bln' });
  const d = (await gov.get('/api/gov/domains')).domains[0];
  await gov.post(`/api/gov/domains/${d.id}/records`, { name: '@', type: 'A', data: st.ip });
  await gov.put(`/api/gov/hosting/${acc.account_id}/sites/${st.id}/file`, {
    path: 'server.js',
    content: `export async function onRequest(req) {
  if (req.path === '/key') {
    let k = kv.get('vapid');
    if (!k) { k = webpush.generateVAPIDKeys(); kv.set('vapid', k); }
    return Response.json({ publicKey: k.publicKey });
  }
  if (req.method === 'POST' && req.path === '/notify') {
    const sub = await req.json();
    try {
      const r = await webpush.sendNotification(sub, JSON.stringify({ title: 'Заказ готов', body: 'Заберите в магазине', url: '/orders' }), { TTL: 600, urgency: 'high', vapidDetails: { subject: 'mailto:boris@pushshop.bln', ...kv.get('vapid') } });
      return Response.json({ status: r.statusCode });
    } catch (e) {
      return Response.json({ status: e.statusCode, error: e.message });
    }
  }
  return new Response('нет', { status: 404 });
}`,
  });
  const key = JSON.parse((await netRequest({ fromIp: clientIp, url: 'http://pushshop.bln/key' })).body).publicKey;
  const br = client(app);
  const dev = await br.post('/api/net/push/device', {});
  const auth = { device: dev.id, token: dev.token };
  const { subscription } = await br.post('/api/net/push/subscribe', { ...auth, origin: 'https://pushshop.bln', applicationServerKey: key });
  const r = await netRequest({ fromIp: clientIp, url: 'http://pushshop.bln/notify', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(subscription) });
  assert.deepEqual(JSON.parse(r.body), { status: 201 });
  const box = (await br.post('/api/net/push/inbox', { ...auth, after: 0 })).messages;
  assert.equal(box.length, 1);
  assert.equal(box[0].title, 'Заказ готов');
  assert.equal(box[0].url, 'https://pushshop.bln/orders');
  assert.equal(box[0].encrypted, 1);
  assert.equal(box[0].urgency, 'high');
  // Отписался — сервер сайта получает 410 и должен забыть подписку.
  await br.post('/api/net/push/unsubscribe', { ...auth, origin: 'https://pushshop.bln' });
  const gone = await netRequest({ fromIp: clientIp, url: 'http://pushshop.bln/notify', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(subscription) });
  assert.equal(JSON.parse(gone.body).status, 410);
});
