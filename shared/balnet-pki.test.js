import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKey, signWith, verifySig, keyId, nameMatches, verifyTls, certHash, canonical, keyTag, dsDigest, rrsetData } from './balnet-pki.js';

async function cert(tbs, issuerKey) {
  return { tbs, sig: await signWith(issuerKey.pkcs8, tbs) };
}

let pki;
async function setup() {
  if (pki) return pki;
  const rootK = await generateKey();
  const caK = await generateKey();
  const leafK = await generateKey();
  const logK = await generateKey();
  const rootId = await keyId(rootK.spki);
  const caId = await keyId(caK.spki);
  const leafId = await keyId(leafK.spki);
  const root = await cert({ v: 1, serial: '01', issuer: { cn: 'Корень' }, subject: { cn: 'Корень' }, san: [], nb: 0, na: 1e9, spki: rootK.spki, ski: rootId, aki: rootId, ca: true, policy: 'root' }, rootK);
  const ca = await cert({ v: 1, serial: '02', issuer: { cn: 'Корень' }, subject: { cn: 'БалСерт' }, san: [], nb: 0, na: 1e8, spki: caK.spki, ski: caId, aki: rootId, ca: true, policy: 'ca' }, rootK);
  const leafTbs = { v: 1, serial: 'aa', issuer: { cn: 'БалСерт' }, subject: { cn: 'boris.bln', o: 'ООО Борис' }, san: ['boris.bln', '*.boris.bln'], nb: 100, na: 1000, spki: leafK.spki, ski: leafId, aki: caId, ca: false, policy: 'OV' };
  const leaf = await cert(leafTbs, caK);
  const hash = await certHash(leaf);
  const sctBody = { log_id: 'log1', index: 7, ts: 150, cert_hash: hash };
  const sct = { ...sctBody, sig: await signWith(logK.pkcs8, sctBody) };
  const ocspBody = { serial: 'aa', status: 'good', reason: null, this_update: 200 };
  const ocsp = { ...ocspBody, sig: await signWith(caK.pkcs8, ocspBody) };
  const trust = { roots: [{ spki: rootK.spki, name: 'Корень' }], ct_logs: [{ log_id: 'log1', spki: logK.spki }] };
  pki = { rootK, caK, leafK, logK, root, ca, leaf, leafTbs, sct, ocsp, trust };
  return pki;
}

test('подписи и канонический JSON', async () => {
  assert.equal(canonical({ b: 1, a: [2, { d: 1, c: null }] }), '{"a":[2,{"c":null,"d":1}],"b":1}');
  const k = await generateKey();
  const sig = await signWith(k.pkcs8, { x: 1, y: 'тест' });
  assert.ok(await verifySig(k.spki, { y: 'тест', x: 1 }, sig), 'порядок ключей не важен');
  assert.ok(!(await verifySig(k.spki, { x: 2, y: 'тест' }, sig)));
  assert.ok(!(await verifySig(k.spki, 'x', 'мусор')));
  assert.equal((await keyId(k.spki)).length, 16);
});

test('имена: точное и «*.» на один уровень', () => {
  assert.ok(nameMatches('boris.bln', 'BORIS.bln'));
  assert.ok(nameMatches('*.boris.bln', 'www.boris.bln'));
  assert.ok(!nameMatches('*.boris.bln', 'boris.bln'));
  assert.ok(!nameMatches('*.boris.bln', 'a.b.boris.bln'));
  assert.ok(!nameMatches('boris.bln', 'xboris.bln'));
});

test('проверка соединения: успех и все ошибки', async () => {
  const p = await setup();
  const tls = { chain: [p.leaf, p.ca], sct: p.sct, ocsp: p.ocsp };
  const ok = await verifyTls({ tls, host: 'www.boris.bln', now: 300, trust: p.trust });
  assert.equal(ok.ok, true, ok.code);
  assert.equal(ok.org, 'ООО Борис');
  assert.equal(ok.issuer, 'БалСерт');
  assert.equal(ok.ocsp, 'good');

  assert.equal((await verifyTls({ tls, host: 'anna.bln', now: 300, trust: p.trust })).code, 'ERR_CERT_COMMON_NAME_INVALID');
  assert.equal((await verifyTls({ tls, host: 'boris.bln', now: 5000, trust: p.trust })).code, 'ERR_CERT_DATE_INVALID');
  assert.equal((await verifyTls({ tls, host: 'boris.bln', now: 50, trust: p.trust })).code, 'ERR_CERT_DATE_INVALID');
  assert.equal((await verifyTls({ tls, host: 'boris.bln', now: 300, trust: { ...p.trust, roots: [] } })).code, 'ERR_CERT_AUTHORITY_INVALID');
  assert.equal((await verifyTls({ tls: { ...tls, sct: undefined }, host: 'boris.bln', now: 300, trust: p.trust })).code, 'ERR_CERTIFICATE_TRANSPARENCY_REQUIRED');
  assert.equal((await verifyTls({ tls: { ...tls, ocsp: undefined }, host: 'boris.bln', now: 300, trust: p.trust })).ok, true, 'нет статуса — мягкий отказ');

  // Подделка: изменили имя в сертификате — подпись УЦ не сходится.
  const forged = { ...p.leaf, tbs: { ...p.leafTbs, san: ['bank.bln'] } };
  assert.equal((await verifyTls({ tls: { ...tls, chain: [forged, p.ca] }, host: 'bank.bln', now: 300, trust: p.trust })).code, 'ERR_CERT_INVALID');

  // Отзыв.
  const rev = { serial: 'aa', status: 'revoked', reason: 'keyCompromise', this_update: 250 };
  const revoked = { ...rev, sig: await signWith(p.caK.pkcs8, rev) };
  assert.equal((await verifyTls({ tls: { ...tls, ocsp: revoked }, host: 'boris.bln', now: 300, trust: p.trust })).code, 'ERR_CERT_REVOKED');
  // Поддельный статус «отозван» (не подписан издателем) игнорируется.
  assert.equal((await verifyTls({ tls: { ...tls, ocsp: { ...rev, sig: revoked.sig.replace(/^./, 'A') } }, host: 'boris.bln', now: 300, trust: p.trust })).ok, true);

  // Самоподписанный.
  const selfK = await generateKey();
  const sid = await keyId(selfK.spki);
  const self = await cert({ v: 1, serial: 'ff', issuer: { cn: 'boris.bln' }, subject: { cn: 'boris.bln' }, san: ['boris.bln'], nb: 0, na: 1e9, spki: selfK.spki, ski: sid, aki: sid, ca: false, policy: 'self' }, selfK);
  assert.equal((await verifyTls({ tls: { chain: [self] }, host: 'boris.bln', now: 300, trust: p.trust })).code, 'ERR_CERT_AUTHORITY_INVALID');

  // Сертификат, выпущенный не-УЦ (лист подписывает другой лист).
  const evilK = await generateKey();
  const evil = await cert({ ...p.leafTbs, serial: 'bb', aki: await keyId(p.leafK.spki), ski: await keyId(evilK.spki), spki: evilK.spki }, p.leafK);
  assert.equal((await verifyTls({ tls: { chain: [evil, p.leaf, p.ca], sct: p.sct }, host: 'boris.bln', now: 300, trust: p.trust })).code, 'ERR_CERT_INVALID');
});

test('DNSSEC: тег ключа, DS, данные RRSIG', async () => {
  const k = await generateKey();
  const tag = await keyTag(k.spki);
  assert.ok(tag >= 0 && tag <= 65535);
  assert.equal((await dsDigest('bank.bln.', k.spki)).length, 64);
  assert.equal(rrsetData('a.', 'A', 60, ['2', '1'], { signer: 'a.' }), rrsetData('a.', 'A', 60, ['1', '2'], { signer: 'a.' }));
});
