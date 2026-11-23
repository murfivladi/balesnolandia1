// Этап Н5: удостоверяющие центры — проверка домена (DNS-01/HTTP-01), CAA, выпуск DV/OV/EV, журнал прозрачности,
// OCSP, отзыв, самоподписанные, установка на сайт, бесплатный SSL из панели, УЦ организации и хранилище доверия.
// Сертификаты проверяются тем же кодом, что и во ВлодБраузере (shared/balnet-pki.js).
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setup, client, pool, one } from './helpers.js';
import { verifyTls } from '@bln/shared/balnet-pki.js';

let app;
let clock;
let now = 50000;
before(async () => {
  app = await setup();
  clock = await import('../src/lib/clock.js');
  clock.setGameTimeOverride(() => now);
  (await import('../src/lib/dns.js')).flushResolverCache();
});
after(async () => {
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
const DEV = 'device-cert-001';

let admin;
let boris;
let anna;
let dev;
let trust;
let acc;
let site;
let dom;

const open = (url) => dev.post('/api/net/open', { client_id: DEV, url });
const check = async (url, host) => {
  const o = await open(url);
  if (!o.tls) return { code: 'NO_TLS' };
  return verifyTls({ tls: o.tls, host, now: o.tls.time, trust });
};
const rec = (data) => boris.gov.post(`/api/gov/domains/${dom.id}/records`, data);

test('setup: игроки, домен, хостинг с сайтом, хранилище доверия', async () => {
  admin = client(app);
  await admin.post('/api/auth/gov/register', { email: 'admin@test.bf', password: 'password123', display_name: 'Админ' });
  await admin.patch('/api/admin/settings', { fraud_threshold: 0, fraud_velocity: 0, fraud_multiplier: 0, start_balance: 200000, vat_bp: 2000, transfer_fee_bp: 0, transfer_fee_min: 0 });
  boris = await player('boris@test.bf', 'Борис Сайтов');
  anna = await player('anna@test.bf', 'Анна Злая');
  dev = client(app);
  await dev.post('/api/net/lease', { client_id: DEV, provider: 'baltelecom' });
  await pay(boris, (await boris.gov.post('/api/gov/domains', { name: 'boris.bln' })).invoice);
  dom = (await boris.gov.get('/api/gov/domains')).domains[0];
  const h = await boris.gov.get('/api/gov/hosting');
  const r = await boris.gov.post('/api/gov/hosting', { plan_id: h.offers[0].id, months: 3 });
  await pay(boris, r.invoice);
  acc = (await boris.gov.get(`/api/gov/hosting/${r.account_id}`)).account;
  site = await boris.gov.post(`/api/gov/hosting/${acc.id}/sites`, { host: 'boris.bln' });
  await rec({ name: '@', type: 'A', data: site.ip });
  await boris.gov.put(`/api/gov/hosting/${acc.id}/sites/${site.id}/file`, { path: 'index.html', content: '<html><body>Борис</body></html>' });

  trust = await dev.get('/api/net/trust');
  assert.equal(trust.roots.length, 1);
  assert.equal(trust.roots[0].name, 'Корневой УЦ БалНета');
  assert.equal(trust.ct_logs.length, 1);
});

test('госсайты открываются по https с проверенным сертификатом (EV у банка)', async () => {
  const bank = await check('https://bank.bln/', 'bank.bln');
  assert.equal(bank.ok, true, bank.code);
  assert.equal(bank.ev, true);
  assert.equal(bank.org, 'ВлодБанк');
  assert.equal(bank.issuer, 'БалСерт');
  assert.equal(bank.ocsp, 'good');
  const www = await check('https://www.gosuslugi.gov.bln/', 'www.gosuslugi.gov.bln');
  assert.equal(www.ok, true, www.code);
  assert.equal((await check('https://ca.gov.bln/', 'ca.gov.bln')).ok, true);
  assert.equal((await check('https://poisk.bln/?q=1', 'poisk.bln')).ok, true);
  // Без корня в хранилище — недоверенный УЦ.
  const o = await open('https://bank.bln/');
  assert.equal((await verifyTls({ tls: o.tls, host: 'bank.bln', now: o.tls.time, trust: { ...trust, roots: [] } })).code, 'ERR_CERT_AUTHORITY_INVALID');
});

test('DNS-01: TXT-запись, неверное значение, выпуск DV на домен и «*.»', async () => {
  const ch = await boris.gov.post('/api/gov/certs/challenges', { names: 'boris.bln *.boris.bln', method: 'dns' });
  assert.deepEqual(ch.names, ['boris.bln', '*.boris.bln']);
  assert.equal(ch.steps.length, 1, 'для домена и «*.» — одна TXT-запись');
  assert.equal(ch.steps[0].record, '_balnet-challenge.boris.bln');
  const no = await boris.gov.post('/api/gov/certs/orders', { challenge_id: ch.id, policy: 'DV' });
  assert.equal(no.ok, false);
  assert.match(no.results[0].error, /не найдена/);
  await rec({ name: '_balnet-challenge', type: 'TXT', data: 'не то' });
  assert.match((await boris.gov.post(`/api/gov/certs/challenges/${ch.id}/check`, {})).results[0].error, /другое значение/);
  await rec({ name: '_balnet-challenge', type: 'TXT', data: ch.token });
  const r = await boris.gov.post('/api/gov/certs/orders', { challenge_id: ch.id, policy: 'DV' });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.ok(r.cert_id);
  await assert.rejects(boris.gov.post('/api/gov/certs/orders', { challenge_id: ch.id, policy: 'DV' }), /уже использована/);
  const c = (await boris.gov.get(`/api/gov/certs/${r.cert_id}`)).cert;
  assert.equal(c.policy, 'DV');
  assert.deepEqual(c.names, ['boris.bln', '*.boris.bln']);
  assert.equal(c.issuer, 'БалСерт');
  assert.equal(c.status, 'valid');
  assert.ok(c.ct_index > 0);
  await assert.rejects(anna.gov.get(`/api/gov/certs/${r.cert_id}`), /not_found/);

  // Журнал прозрачности виден всем — как crt.sh.
  const ct = await dev.get('/api/gov/certs/ct?q=boris.bln');
  assert.equal(ct.entries.length, 1);
  assert.equal(ct.entries[0].issuer, 'БалСерт');
});

test('установка на сайт: https работает, имя не подходит — ошибка, http остаётся', async () => {
  const certs = (await boris.gov.get('/api/gov/certs')).certs;
  const dv = certs.find((c) => c.policy === 'DV');
  assert.equal((await open('https://boris.bln/')).tls, null);
  await boris.gov.put(`/api/gov/hosting/${acc.id}/sites/${site.id}/cert`, { cert_id: dv.id });
  await assert.rejects(anna.gov.put(`/api/gov/hosting/${acc.id}/sites/${site.id}/cert`, { cert_id: dv.id }), /not_found/);
  const o = await open('https://boris.bln/');
  assert.ok(o.ticket, 'страница по https отдаётся');
  const v = await verifyTls({ tls: o.tls, host: 'boris.bln', now: o.tls.time, trust });
  assert.equal(v.ok, true, v.code);
  assert.equal(v.org, null, 'у DV нет организации');
  assert.equal(v.ocsp, 'good');

  // Тот же сертификат на www (CNAME на сайт) — подходит по «*.».
  await boris.gov.post(`/api/gov/hosting/${acc.id}/sites`, { host: 'www.boris.bln' });
  await rec({ name: 'www', type: 'CNAME', data: 'boris.bln.' });
});

test('CAA: запрет чужого УЦ, issuewild, разрешение БалСерта', async () => {
  await rec({ name: '@', type: 'CAA', data: '0 issue "letsencrypt.example"' });
  const ch = await boris.gov.post('/api/gov/certs/challenges', { names: ['boris.bln'], method: 'dns' });
  await rec({ name: '_balnet-challenge', type: 'TXT', data: ch.token });
  const r = await boris.gov.post('/api/gov/certs/orders', { challenge_id: ch.id, policy: 'DV' });
  assert.equal(r.ok, false);
  assert.ok(r.results.some((x) => x.caa && /разрешает выпуск только: letsencrypt.example/.test(x.error)), JSON.stringify(r.results));

  await rec({ name: '@', type: 'CAA', data: '0 issue "ca.gov.bln"' });
  await rec({ name: '@', type: 'CAA', data: '0 issuewild ";"' });
  const w = await boris.gov.post('/api/gov/certs/challenges', { names: ['*.boris.bln'], method: 'dns' });
  await rec({ name: '_balnet-challenge', type: 'TXT', data: w.token });
  const rw = await boris.gov.post('/api/gov/certs/orders', { challenge_id: w.id, policy: 'DV' });
  assert.equal(rw.ok, false, 'issuewild ";" запрещает «*.» всем');
  const ok = await boris.gov.post('/api/gov/certs/orders', { challenge_id: ch.id, policy: 'DV' });
  assert.equal(ok.ok, true, JSON.stringify(ok.results));
});

test('HTTP-01: файл в .well-known; на «*.» нельзя; бесплатный SSL из панели', async () => {
  await assert.rejects(boris.gov.post('/api/gov/certs/challenges', { names: ['*.boris.bln'], method: 'http' }), /только через DNS/);
  const ch = await boris.gov.post('/api/gov/certs/challenges', { names: ['boris.bln'], method: 'http' });
  assert.equal(ch.steps[0].url, `http://boris.bln/.well-known/balnet-challenge/${ch.token}`);
  assert.match((await boris.gov.post(`/api/gov/certs/challenges/${ch.id}/check`, {})).results[0].error, /не найден \(404\)/);
  await boris.gov.put(`/api/gov/hosting/${acc.id}/sites/${site.id}/file`, { path: ch.steps[0].file, content: ch.token });
  const v = await boris.gov.post(`/api/gov/certs/challenges/${ch.id}/check`, {});
  assert.equal(v.ok, true, JSON.stringify(v.results));

  const auto = await boris.gov.post(`/api/gov/hosting/${acc.id}/sites/${site.id}/ssl`);
  assert.equal(auto.ok, true, JSON.stringify(auto.results));
  assert.deepEqual(auto.names, ['boris.bln'], 'www — отдельный сайт хостинга, в сертификат не входит');
  const c = (await boris.gov.get(`/api/gov/certs/${auto.cert_id}`)).cert;
  assert.equal(c.auto_renew, true);
  assert.deepEqual(c.sites.map((s) => s.host), ['boris.bln']);
  assert.equal((await check('https://boris.bln/', 'boris.bln')).ok, true);
});

test('самоподписанный: выпускается без проверки, браузер не доверяет; чужое имя — ошибка имени', async () => {
  const s = await anna.gov.post('/api/gov/certs/self', { names: ['bank.bln'] });
  const sb = await boris.gov.post('/api/gov/certs/self', { names: ['boris.bln'] });
  await boris.gov.put(`/api/gov/hosting/${acc.id}/sites/${site.id}/cert`, { cert_id: sb.cert_id });
  assert.equal((await check('https://boris.bln/', 'boris.bln')).code, 'ERR_CERT_AUTHORITY_INVALID');
  const anyDv = (await boris.gov.get('/api/gov/certs')).certs.find((c) => c.policy === 'DV' && c.names.length === 1 && c.status === 'valid');
  await boris.gov.put(`/api/gov/hosting/${acc.id}/sites/${site.id}/cert`, { cert_id: anyDv.id });
  const www = await boris.gov.get(`/api/gov/hosting/${acc.id}`);
  const wwwSite = www.account.sites.find((x) => x.host === 'www.boris.bln');
  await boris.gov.put(`/api/gov/hosting/${acc.id}/sites/${wwwSite.id}/cert`, { cert_id: anyDv.id });
  assert.equal((await check('https://www.boris.bln/', 'www.boris.bln')).code, 'ERR_CERT_COMMON_NAME_INVALID');
  await assert.rejects(boris.gov.put(`/api/gov/hosting/${acc.id}/sites/${site.id}/cert`, { cert_id: s.cert_id }), /not_found/, 'чужой сертификат не поставить');
});

test('отзыв: OCSP «revoked», браузер блокирует; поддельный статус не принимается', async () => {
  const c = (await boris.gov.get('/api/gov/certs')).certs.find((x) => x.sites.some((s) => s.host === 'boris.bln'));
  await boris.gov.post(`/api/gov/certs/${c.id}/revoke`, { reason: 'keyCompromise' });
  await assert.rejects(boris.gov.post(`/api/gov/certs/${c.id}/revoke`, { reason: 'keyCompromise' }), /уже отозван/);
  const o = await open('https://boris.bln/');
  assert.equal(o.tls.ocsp.status, 'revoked');
  assert.equal((await verifyTls({ tls: o.tls, host: 'boris.bln', now: o.tls.time, trust })).code, 'ERR_CERT_REVOKED');
  const forged = { ...o.tls, ocsp: { ...o.tls.ocsp, status: 'good' } };
  assert.equal((await verifyTls({ tls: forged, host: 'boris.bln', now: o.tls.time, trust })).ocsp, undefined, 'подделанный ответ OCSP игнорируется');
  assert.equal((await dev.get('/api/gov/certs/ct?q=boris.bln')).entries.find((e) => e.serial === c.serial).revoked, true);
});

test('срок: сертификат истекает по игровому времени', async () => {
  const auto = await boris.gov.post(`/api/gov/hosting/${acc.id}/sites/${site.id}/ssl`);
  const c = (await boris.gov.get(`/api/gov/certs/${auto.cert_id}`)).cert;
  const o = await open('https://boris.bln/');
  assert.equal((await verifyTls({ tls: o.tls, host: 'boris.bln', now: c.na + 1, trust })).code, 'ERR_CERT_DATE_INVALID');
});

test('OV/EV: организация в сертификате, оплата квитанцией', async () => {
  await boris.gov.post('/api/gov/documents/inn');
  await boris.gov.post('/api/gov/orgs/apply', { kind: 'llc', name: 'Борис и партнёры' });
  await pay(boris, (await boris.gov.get('/api/gov/invoices')).invoices.find((i) => i.purpose.includes('организации')).number);
  const orgs = (await boris.gov.get('/api/gov/orgs')).orgs;
  assert.ok(orgs.length, 'организация создана');
  const org = orgs[0];
  const ch = await boris.gov.post('/api/gov/certs/challenges', { names: ['boris.bln'], method: 'dns' });
  await rec({ name: '_balnet-challenge', type: 'TXT', data: ch.token });
  await assert.rejects(anna.gov.post('/api/gov/certs/orders', { challenge_id: ch.id, policy: 'OV', owner_org_id: org.id }), /not_found/);
  const r = await boris.gov.post('/api/gov/certs/orders', { challenge_id: ch.id, policy: 'EV', owner_org_id: org.id });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  assert.ok(r.invoice);
  assert.equal(r.amount, 20000);
  await pay(boris, r.invoice);
  const ev = (await boris.gov.get('/api/gov/certs')).certs.find((c) => c.policy === 'EV');
  assert.ok(ev, 'выпущен после оплаты');
  assert.equal(ev.owner_org_id, org.id);
  assert.match(ev.subject.o, /Борис и партнёры/);
  assert.equal(ev.subject.jurisdiction, 'Балесноландская Федерация');
  await boris.gov.put(`/api/gov/hosting/${acc.id}/sites/${site.id}/cert`, { cert_id: ev.id });
  const v = await check('https://boris.bln/', 'boris.bln');
  assert.equal(v.ok, true, v.code);
  assert.equal(v.ev, true);
  assert.match(v.org, /Борис и партнёры/);
});

test('УЦ организации: недоверенный корень, пока админ не включит; отзыв УЦ', async () => {
  const org = (await boris.gov.get('/api/gov/orgs')).orgs[0];
  await assert.rejects(boris.gov.post('/api/gov/certs/org-ca', { org_id: org.id, name: 'БорисСерт', identifier: 'ca.boris.bln' }), /лицензия удостоверяющего центра/);
  await boris.gov.post(`/api/gov/orgs/${org.id}/licenses`, { kind: 'ca' });
  await pay(boris, (await boris.gov.get('/api/gov/invoices')).invoices.find((i) => i.purpose.includes('Лицензия') && i.status === 'unpaid').number);
  const lic = (await admin.get('/api/gov/queue')).applications.find((x) => x.type === 'license');
  await admin.post(`/api/gov/applications/${lic.id}/approve`);
  const ca = await boris.gov.post('/api/gov/certs/org-ca', { org_id: org.id, name: 'БорисСерт', identifier: 'ca.boris.bln' });
  await boris.gov.patch(`/api/gov/certs/org-ca/${ca.ca_id}`, { prices: { DV: 0, OV: 100, EV: 500 } });
  const list = (await dev.get('/api/gov/certs/cas')).cas;
  assert.deepEqual(list.map((c) => `${c.name}:${c.trusted}`), ['БалСерт:true', 'БорисСерт:false']);

  // CAA сейчас разрешает только ca.gov.bln — УЦ Бориса не выпустит, пока владелец не разрешит.
  const ch = await boris.gov.post('/api/gov/certs/challenges', { names: ['boris.bln'], method: 'dns' });
  await rec({ name: '_balnet-challenge', type: 'TXT', data: ch.token });
  assert.equal((await boris.gov.post('/api/gov/certs/orders', { challenge_id: ch.id, ca_id: ca.ca_id, policy: 'DV' })).ok, false);
  await rec({ name: '@', type: 'CAA', data: '0 issue "ca.boris.bln"' });
  const r = await boris.gov.post('/api/gov/certs/orders', { challenge_id: ch.id, ca_id: ca.ca_id, policy: 'DV' });
  assert.equal(r.ok, true, JSON.stringify(r.results));
  await boris.gov.put(`/api/gov/hosting/${acc.id}/sites/${site.id}/cert`, { cert_id: r.cert_id });
  assert.equal((await check('https://boris.bln/', 'boris.bln')).code, 'ERR_CERT_AUTHORITY_INVALID', 'корня нет в браузерах');

  const cas = (await admin.get('/api/admin/pki/cas')).cas;
  const root = cas.find((c) => c.kind === 'root' && c.org_id === org.id);
  await admin.patch(`/api/admin/pki/cas/${root.id}`, { trusted: true });
  trust = await dev.get('/api/net/trust');
  assert.equal(trust.roots.length, 2);
  const ok = await check('https://boris.bln/', 'boris.bln');
  assert.equal(ok.ok, true, ok.code);
  assert.equal(ok.issuer, 'БорисСерт');

  await admin.post(`/api/admin/pki/cas/${ca.ca_id}/revoke`);
  trust = await dev.get('/api/net/trust');
  assert.equal((await check('https://boris.bln/', 'boris.bln')).code, 'ERR_CERT_REVOKED', 'отозванный УЦ — CRLSet');
});

test('госсертификаты перевыпускаются заранее', async () => {
  const before = await one("SELECT COUNT(*) AS n FROM pki_certs WHERE gov_site = 1 AND replaced_by IS NULL AND status = 'valid'");
  const { renewGovCerts } = await import('../src/lib/pki.js');
  now += 11 * 30 * 86400;
  await renewGovCerts(now);
  const after2 = await one("SELECT COUNT(*) AS n FROM pki_certs WHERE gov_site = 1 AND replaced_by IS NULL AND status = 'valid'");
  assert.equal(Number(after2.n), Number(before.n));
  assert.ok(Number((await one('SELECT COUNT(*) AS n FROM pki_certs WHERE gov_site = 1 AND replaced_by IS NOT NULL')).n) >= Number(before.n));
  assert.equal((await check('https://bank.bln/', 'bank.bln')).ok, true);
});

test('отзыв сертификата госсайта админом — сразу выпускается новый', async () => {
  const cur = await one("SELECT id FROM pki_certs WHERE gov_site = 1 AND status = 'valid' AND replaced_by IS NULL AND JSON_CONTAINS(names, '\"pay.bank.bln\"')");
  const r = await admin.post(`/api/admin/pki/certs/${cur.id}/revoke`, { reason: 'unspecified' });
  assert.equal(r.reissued, true);
  const fresh = await one("SELECT id FROM pki_certs WHERE gov_site = 1 AND status = 'valid' AND replaced_by IS NULL AND JSON_CONTAINS(names, '\"pay.bank.bln\"')");
  assert.ok(fresh && fresh.id !== cur.id);
  assert.equal((await admin.post('/api/admin/pki/gov-certs/renew')).ok, true);
});
