// Этап Н8: ВлодПочта — ящики, письма по MX через сеть БалНета, DKIM (Ed25519), SPF, DMARC, спам-фильтр,
// почта для своего домена, приём и отправка письма скриптом сайта (onMail, mail.send), отказы,
// аккаунт ВлодБраузера и синхронизация (сервер хранит только шифротекст).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setup, client, pool, sentMail } from './helpers.js';

let app;
let clock;
before(async () => {
  app = await setup();
  clock = await import('../src/lib/clock.js');
  clock.setGameTimeOverride(() => 300000);
  (await import('../src/lib/dns.js')).flushResolverCache();
});
after(async () => {
  await (await import('../src/lib/vhost/pool.js')).stopPools();
  clock.setGameTimeOverride(null);
  await fs.rm(process.env.BALNET_SITES_DIR, { recursive: true, force: true });
  await app.close();
  await pool.end();
});

async function player(email, name) {
  const gov = client(app);
  await gov.post('/api/auth/gov/register', { email, password: 'password123', display_name: name });
  await gov.post('/api/gov/passport', { full_name: name, birth_date: '1990-05-01', address: 'Влодоград' });
  const me = await gov.get('/api/gov/me');
  const bank = client(app);
  await bank.post('/api/auth/bank/register', { email, password: 'password123', full_name: name, birth_date: '1990-05-01', passport_no: me.passport.number });
  const links = await gov.get('/api/gov/links');
  await gov.post(`/api/gov/links/${links.links[0].id}/confirm`);
  const cur = (await bank.post('/api/bank/accounts', { type: 'current' })).account;
  return { gov, bank, cur };
}
const pay = (p, number) => p.bank.post(`/api/bank/invoices/${number}/pay`, { account_id: p.cur.id });
const inbox = async (p, folder = 'inbox') => (await p.gov.get(`/api/mail/messages?folder=${folder}`)).messages;

let admin;
let boris;
let anna;
let site;

test('ящики: логин@mail.bln, приветствие доставлено по MX с подписью DKIM', async () => {
  admin = client(app);
  await admin.post('/api/auth/gov/register', { email: 'admin@test.bf', password: 'password123', display_name: 'Админ' });
  await admin.patch('/api/admin/settings', { fraud_threshold: 0, fraud_velocity: 0, fraud_multiplier: 0, start_balance: 200000, transfer_fee_bp: 0, transfer_fee_min: 0, vat_bp: 0 });
  boris = await player('boris@test.bf', 'Борис Почтов');
  anna = await player('anna@test.bf', 'Анна Письмова');
  assert.equal((await boris.gov.get('/api/mail/me')).account, null);
  await assert.rejects(boris.gov.post('/api/mail/me', { login: 'postmaster' }), /зарезервирован/);
  await boris.gov.post('/api/mail/me', { login: 'boris' });
  await assert.rejects(anna.gov.post('/api/mail/me', { login: 'Boris' }), /занят/);
  await anna.gov.post('/api/mail/me', { login: 'anna' });
  const [w] = await inbox(boris);
  assert.equal(w.subject, 'Добро пожаловать во ВлодПочту');
  assert.deepEqual([w.auth.spf, w.auth.dkim, w.auth.dmarc], ['pass', 'pass', 'pass']);
  const raw = (await app.inject({ method: 'GET', url: `/api/mail/messages/${w.id}/raw`, headers: { cookie: [...boris.gov.jar].map(([k, v]) => `${k}=${v}`).join('; ') } })).body.replace(/\r\n[ \t]+/g, ' ');
  assert.match(raw, /^X-Spam-Status: No/m);
  assert.match(raw, /^Authentication-Results: mx\.mail\.bln; spf=pass smtp\.mailfrom=mail\.bln; dkim=pass header\.d=mail\.bln/m);
  assert.match(raw, /^Received: from mx\.mail\.bln \(\[50\.1\.0\.25\]\) by mx\.mail\.bln/m);
  assert.match(raw, /^DKIM-Signature: v=1; a=ed25519-sha256; c=relaxed\/relaxed; d=mail\.bln; s=vlod1/m);
  // На настоящую почту — только уведомление без текста письма.
  const note = sentMail.find((m) => m.to === 'boris@test.bf' && m.subject === 'Новое письмо в БалНете');
  assert.ok(note);
  assert.doesNotMatch(note.text, /Received/);
});

test('письмо между ящиками, ответ, неизвестный адрес → отказ с SMTP-диалогом', async () => {
  const r = await boris.gov.post('/api/mail/send', { to: 'anna@mail.bln', subject: 'Привет, Анна', text: 'Как дела?' });
  assert.equal(r.results[0].ok, true);
  assert.equal(r.results[0].server, 'mx.mail.bln');
  const [m] = await inbox(anna);
  assert.equal(m.subject, 'Привет, Анна');
  assert.equal(m.from.address, 'boris@mail.bln');
  const full = (await anna.gov.get(`/api/mail/messages/${m.id}`)).message;
  assert.equal(full.text, 'Как дела?');
  assert.equal((await boris.gov.get('/api/mail/folders')).folders.sent.total, 1);
  const bad = await boris.gov.post('/api/mail/send', { to: 'nobody@mail.bln, x@nonexistent.bln', subject: 'тест', text: '…' });
  assert.deepEqual(bad.results.map((x) => x.code).sort(), ['550', '550']);
  const [b] = await inbox(boris);
  assert.match(b.subject, /^Не доставлено/);
  const bt = (await boris.gov.get(`/api/mail/messages/${b.id}`)).message.text;
  assert.match(bt, /5\.1\.1 Ящика nobody@mail\.bln нет/);
  assert.match(bt, /RCPT TO:<nobody@mail\.bln>/);
  assert.match(bt, /NXDOMAIN/);
  await assert.rejects(boris.gov.post('/api/mail/send', { from: 'anna@mail.bln', to: 'anna@mail.bln', text: 'x' }), /своих адресов/);
});

test('почта для своего домена: записи DNS, проверка, адрес info@ на домене', async () => {
  const r = await boris.gov.post('/api/gov/domains', { name: 'boris.bln' });
  await pay(boris, r.invoice);
  await assert.rejects(anna.gov.post('/api/mail/domains', { name: 'boris.bln' }), /владелец/);
  const { domain } = await boris.gov.post('/api/mail/domains', { name: 'boris.bln' });
  assert.deepEqual(domain.records.map((x) => x.type), ['MX', 'TXT', 'TXT', 'TXT']);
  let checks = (await boris.gov.post(`/api/mail/domains/${domain.id}/check`)).checks;
  assert.equal(checks.mx.ok, false);
  checks = (await boris.gov.post(`/api/mail/domains/${domain.id}/auto`)).checks;
  assert.deepEqual([checks.mx.ok, checks.spf.ok, checks.dkim.ok, checks.dmarc.ok], [true, true, true, true]);
  await boris.gov.post(`/api/mail/domains/${domain.id}/addresses`, { local: 'info' });
  await boris.gov.post(`/api/mail/domains/${domain.id}/addresses`, { local: 'sales', for: 'anna@mail.bln' });
  await anna.gov.post('/api/mail/send', { to: 'info@boris.bln', subject: 'Вопрос о товаре', text: 'Есть в наличии?' });
  const m = (await inbox(boris)).find((x) => x.subject === 'Вопрос о товаре');
  assert.ok(m);
  // Ответ с адреса своего домена: подпись d=boris.bln, DMARC проходит.
  await boris.gov.post('/api/mail/send', { from: 'info@boris.bln', to: 'anna@mail.bln', subject: 'Re: Вопрос о товаре', text: 'Есть!' });
  const reply = (await inbox(anna)).find((x) => x.subject === 'Re: Вопрос о товаре');
  assert.deepEqual([reply.auth.dkim, reply.auth.dkim_domain, reply.auth.dmarc], ['pass', 'boris.bln', 'pass']);
  await anna.gov.post('/api/mail/send', { to: 'sales@boris.bln', subject: 'Для Анны', text: 'x' });
  assert.ok((await inbox(anna)).some((x) => x.subject === 'Для Анны'), 'адрес на домене Бориса ведёт в ящик Анны');
});

test('скрипт сайта: onMail принимает письма для домена, mail.send отправляет с IP сервера (SPF, DKIM)', async () => {
  const r = await anna.gov.post('/api/gov/domains', { name: 'anna.bln' });
  await pay(anna, r.invoice);
  const virt = (await anna.gov.get('/api/gov/hosting')).offers.find((o) => o.kind === 'virtual');
  const acc = await anna.gov.post('/api/gov/hosting', { plan_id: virt.id, months: 2 });
  await pay(anna, acc.invoice);
  const s = await anna.gov.post(`/api/gov/hosting/${acc.account_id}/sites`, { host: 'anna.bln' });
  site = { f: `/api/gov/hosting/${acc.account_id}/sites/${s.id}`, ip: s.ip };
  const d = (await anna.gov.get('/api/gov/domains')).domains.find((x) => x.name === 'anna.bln');
  const rec = (body) => anna.gov.post(`/api/gov/domains/${d.id}/records`, body);
  await rec({ name: '@', type: 'A', data: s.ip });
  await rec({ name: '@', type: 'MX', data: '10 anna.bln.' });
  const dk = await anna.gov.post(`${site.f}/dkim`, { selector: 'robot' });
  assert.equal(dk.record.name, 'robot._domainkey');
  await rec({ name: dk.record.name, type: 'TXT', data: dk.record.data });
  await anna.gov.put(`${site.f}/file`, { path: 'server.js', content: `
db.exec('CREATE TABLE IF NOT EXISTS mail (subj TEXT, spf TEXT, dkim TEXT, frm TEXT)');
export async function onMail(m) {
  if (m.subject === 'спам') return { reject: 'Не принимаем' };
  db.run('INSERT INTO mail VALUES (?, ?, ?, ?)', [m.subject, m.auth.spf, m.auth.dkim, m.from.address]);
  // Автоответ: сначала без SPF-разрешения сервера.
  const r = await mail.send({ from: 'robot@anna.bln', to: m.from.address, subject: 'Автоответ: ' + m.subject, text: 'Спасибо, письмо получено', dkim: 'robot' });
  return r.ok ? true : { reject: 'автоответ не ушёл' };
}
export function onRequest() { return Response.json(db.query('SELECT * FROM mail')); }
` });
  const sent = await boris.gov.post('/api/mail/send', { to: 'hello@anna.bln', subject: 'Здравствуйте', text: 'Тест скрипта' });
  assert.equal(sent.results[0].ok, true);
  assert.equal(sent.results[0].server, 'anna.bln');
  const bounced = await boris.gov.post('/api/mail/send', { to: 'hello@anna.bln', subject: 'спам', text: 'x' });
  assert.match(bounced.results[0].text, /Не принимаем/);
  const auto = (await inbox(boris)).find((x) => x.subject === 'Автоответ: Здравствуйте');
  assert.ok(auto, 'автоответ скрипта пришёл в ящик');
  // SPF у anna.bln нет: none; подпись DKIM ключом сайта верна, DMARC нет.
  assert.deepEqual([auto.auth.spf, auto.auth.dkim, auto.auth.dkim_domain, auto.auth.dmarc], ['none', 'pass', 'anna.bln', 'none']);
  const { q } = await import('../src/db.js');
  const log = await q("SELECT * FROM mail_log WHERE status = 'script' ORDER BY id DESC LIMIT 1");
  assert.equal(log[0].from_ip, s.ip);
});

test('подделка From: SPF -all и DMARC reject у bank.bln — письмо отклонено; фишинг попадает в спам', async () => {
  await anna.gov.put(`${site.f}/file`, { path: 'server.js', content: `
export async function onRequest(req) {
  const to = req.query.get('to');
  const fake = await mail.send({ from: { name: 'ВлодБанк', address: 'security@bank.bln' }, to, subject: 'Карта заблокирована', text: 'x' });
  const spam = await mail.send({ from: 'promo@anna.bln', to, subject: 'ВЫИГРЫШ МИЛЛИОН!!!', text: 'Срочно! Бесплатно! Вы выиграли приз в лотерее. Подтвердите PIN карты ВлодБанка по ссылке', html: '<p>Срочно! <a href="http://anna.bln/x">bank.bln</a></p>' });
  return Response.json({ fake: fake.results[0], spam: spam.results[0] });
}` });
  const dev = client(app);
  await dev.post('/api/net/lease', { client_id: 'device-mail-02', provider: 'baltelecom' });
  const o = await dev.post('/api/net/open', { client_id: 'device-mail-02', url: 'http://anna.bln/?to=boris@mail.bln' });
  const res = JSON.parse((await app.inject({ method: 'GET', url: `/api/net/web/${o.ticket}/?to=boris@mail.bln` })).body);
  assert.equal(res.fake.code, '550');
  assert.match(res.fake.text, /DMARC/);
  assert.equal(res.spam.ok, true);
  const sp = (await inbox(boris, 'spam')).find((x) => x.subject === 'ВЫИГРЫШ МИЛЛИОН!!!');
  assert.ok(sp, 'спам — в папке «Спам»');
  const full = (await boris.gov.get(`/api/mail/messages/${sp.id}`)).message;
  assert.ok(full.spam_reasons.some((x) => x.rule === 'LINK_MISMATCH'));
  assert.ok(full.spam_reasons.some((x) => x.rule === 'GOV_IMPERSONATION'));
  // «Не спам» возвращает письмо и учит фильтр.
  assert.equal((await boris.gov.post(`/api/mail/messages/${sp.id}/spam`, { spam: false })).folder, 'inbox');
  await boris.gov.post(`/api/mail/messages/${sp.id}/report`, { reason: 'фишинг' });
  const reps = (await admin.get('/api/admin/mail/reports')).reports;
  assert.equal(reps[0].subject, 'ВЫИГРЫШ МИЛЛИОН!!!');
  assert.match((await admin.get(`/api/admin/mail/reports/${reps[0].id}`)).report.raw, /DKIM|Received/);
  assert.ok((await admin.get('/api/admin/mail/log')).log.some((x) => x.status === 'rejected' && x.dmarc === 'fail'));
});

test('аккаунт ВлодБраузера: устройство, кодовая фраза, синхронизация с конфликтом версий', async () => {
  const shell = client(app); // запросы браузера — без cookie, только токен
  await assert.rejects(shell.post('/api/mail/sync/devices', {}), /войти|401/i);
  const dev1 = await boris.gov.post('/api/mail/sync/devices', { name: 'Ноутбук' });
  assert.equal(dev1.key, null);
  assert.match(dev1.token, /^bsy_/);
  await shell.post('/api/mail/sync/key', { token: dev1.token, salt: 'c2FsdHNhbHRzYWx0c2FsdA==', iterations: 210000, check: 'iv.cipher' });
  await assert.rejects(shell.post('/api/mail/sync/key', { token: dev1.token, salt: 'c2FsdHNhbHRzYWx0c2FsdA==', iterations: 210000, check: 'x' }), /уже задана/);
  assert.equal((await shell.post('/api/mail/sync/push', { token: dev1.token, collection: 'bookmarks', base_rev: 0, blob: 'enc1' })).rev, 1);
  const dev2 = await boris.gov.post('/api/mail/sync/devices', { name: 'Телефон' });
  assert.equal(dev2.key.iterations, 210000, 'второе устройство получает соль для кодовой фразы');
  const pulled = await shell.post('/api/mail/sync/pull', { token: dev2.token });
  assert.equal(pulled.collections.bookmarks.blob, 'enc1');
  assert.equal((await shell.post('/api/mail/sync/push', { token: dev2.token, collection: 'bookmarks', base_rev: 1, blob: 'enc2' })).rev, 2);
  await assert.rejects(shell.post('/api/mail/sync/push', { token: dev1.token, collection: 'bookmarks', base_rev: 1, blob: 'enc-old' }), (e) => e.status === 409);
  const list = await boris.gov.get('/api/mail/sync/devices');
  assert.equal(list.devices.length, 2);
  await boris.gov.delete(`/api/mail/sync/devices/${list.devices.find((x) => x.name === 'Телефон').id}`);
  await assert.rejects(shell.post('/api/mail/sync/pull', { token: dev2.token }), (e) => e.status === 401);
  await boris.gov.post('/api/mail/sync/reset');
  assert.equal((await shell.post('/api/mail/sync/status', { token: dev1.token })).key, null);
});
