// DNSSEC БалНета: ключи зон (ECDSA P-256, алгоритм 13), подписи RRSIG, доказательства отсутствия NSEC,
// записи DS у родителя. Подписывает авторитетный сервер при ответе; проверяют резолверы (lib/dns.js).
//   DNSKEY: «257 3 13 <ключ>»   DS: «<тег> 13 2 <sha256>»   NSEC: «<следующее имя> <типы>»
//   RRSIG:  «<тип> 13 <метки> <исходный TTL> <до> <с> <тег> <подписавший> <подпись>»
import { q, one, tx } from '../db.js';
import { generateKey, signWith, keyTag, dsDigest, rrsetData } from '@bln/shared/balnet-pki.js';
import { ancestry, inZone } from '@bln/shared/balnet-dns.js';
import { invalidateNet, onNetInvalidate } from './net.js';
import { bumpSerial } from './zones.js';

export const DNSKEY_TTL = 3600;
export const DS_TTL = 3600;
const WEEK = 7 * 86400;

const labelsOf = (name) => (name === '.' ? 0 : name.slice(0, -1).split('.').filter((l) => l !== '*').length);

/** Канонический порядок имён (RFC 4034): сравнение меток справа налево. */
export function canonicalCompare(a, b) {
  const la = a === '.' ? [] : a.slice(0, -1).split('.').reverse();
  const lb = b === '.' ? [] : b.slice(0, -1).split('.').reverse();
  for (let i = 0; i < Math.min(la.length, lb.length); i++) {
    if (la[i] !== lb[i]) return la[i] < lb[i] ? -1 : 1;
  }
  return la.length - lb.length;
}

// ——— Ключи ———

let ensureP = null;
onNetInvalidate(() => { ensureP = null; });
export function resetDnssecCache() {
  ensureP = null;
  sigCache.clear();
}

/** Ключи для всех подписанных зон и DS инфраструктурных зон у родителей (корень → TLD → госзоны). */
export function ensureDnssec() {
  if (!ensureP) ensureP = ensure().catch((e) => { ensureP = null; throw e; });
  return ensureP;
}

async function ensure() {
  let changed = false;
  await tx(async (conn) => {
    await one("SELECT GET_LOCK('balnet_dnssec', 20) AS l", [], conn);
    try {
      for (const z of await q('SELECT z.id FROM dns_zones z LEFT JOIN dnssec_keys k ON k.zone_id = z.id WHERE z.dnssec = 1 AND k.zone_id IS NULL', [], conn)) {
        await createKey(conn, z.id);
        changed = true;
      }
      // DS инфраструктурных зон (без владельца-игрока) ставит сам Координационный центр.
      const signed = await q('SELECT z.*, k.spki, k.key_tag FROM dns_zones z JOIN dnssec_keys k ON k.zone_id = z.id WHERE z.dnssec = 1 AND z.domain_id IS NULL', [], conn);
      const zones = await q('SELECT id, name FROM dns_zones', [], conn);
      for (const z of signed) {
        if (z.name === '.') continue;
        const parent = parentZone(zones, z.name);
        if (!parent) continue;
        const delegated = await one("SELECT id FROM dns_records WHERE zone_id = ? AND name = ? AND type = 'NS' LIMIT 1", [parent.id, z.name], conn);
        if (!delegated) continue;
        const data = await dsData(z.name, z.spki, z.key_tag);
        const have = await q("SELECT id, data FROM dns_records WHERE zone_id = ? AND name = ? AND type = 'DS'", [parent.id, z.name], conn);
        if (have.length === 1 && have[0].data === data) continue;
        await q("DELETE FROM dns_records WHERE zone_id = ? AND name = ? AND type = 'DS'", [parent.id, z.name], conn);
        await q("INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, 'DS', ?, ?)", [parent.id, z.name, DS_TTL, data], conn);
        await bumpSerial(conn, parent.id);
        changed = true;
      }
    } finally {
      await one("SELECT RELEASE_LOCK('balnet_dnssec') AS l", [], conn);
    }
  });
  if (changed) invalidateNet();
}

function parentZone(zones, name) {
  let best = null;
  for (const z of zones) if (z.name !== name && inZone(name, z.name) && (!best || z.name.length > best.name.length)) best = z;
  return best;
}

async function createKey(conn, zoneId) {
  const k = await generateKey();
  const tag = await keyTag(k.spki);
  await q('INSERT INTO dnssec_keys (zone_id, spki, pkcs8, key_tag) VALUES (?, ?, ?, ?)', [zoneId, k.spki, k.pkcs8, tag], conn);
  return { ...k, key_tag: tag };
}

export async function dsData(zoneName, spki, tag) {
  return `${tag} 13 2 ${await dsDigest(zoneName, spki)}`;
}

/** Включить DNSSEC на зоне домена игрока: ключ и DS в зоне TLD (через регистратора). */
export async function enableDomainDnssec(conn, domain, tld) {
  if (!domain.zone_id) throw new Error('no zone');
  await q('UPDATE dns_zones SET dnssec = 1 WHERE id = ?', [domain.zone_id], conn);
  let key = await one('SELECT * FROM dnssec_keys WHERE zone_id = ?', [domain.zone_id], conn);
  if (!key) key = await createKey(conn, domain.zone_id);
  await q("DELETE FROM dns_records WHERE zone_id = ? AND domain_id = ? AND type = 'DS'", [tld.zone_id, domain.id], conn);
  await q("INSERT INTO dns_records (zone_id, name, type, ttl, data, domain_id) VALUES (?, ?, 'DS', ?, ?, ?)", [tld.zone_id, domain.name, DS_TTL, await dsData(domain.name, key.spki, key.key_tag), domain.id], conn);
  await bumpSerial(conn, tld.zone_id);
  await bumpSerial(conn, domain.zone_id);
  invalidateNet();
}

/** Выключить: DS убирается у родителя; пока DS в кэше резолверов, домен будет «bogus» — как в жизни. */
export async function disableDomainDnssec(conn, domain, tld) {
  await q("DELETE FROM dns_records WHERE zone_id = ? AND domain_id = ? AND type = 'DS'", [tld.zone_id, domain.id], conn);
  await bumpSerial(conn, tld.zone_id);
  if (domain.zone_id) {
    await q('UPDATE dns_zones SET dnssec = 0 WHERE id = ?', [domain.zone_id], conn);
    await q('DELETE FROM dnssec_keys WHERE zone_id = ?', [domain.zone_id], conn);
    await bumpSerial(conn, domain.zone_id);
  }
  invalidateNet();
}

// ——— Подписи в ответах авторитетного сервера ———

const sigCache = new Map();

/** Окно действия подписи: с начала игровой недели минус сутки, 30 игровых суток. */
function window(now) {
  const inc = Math.max(0, Math.floor(now / WEEK) * WEEK - 86400);
  return { inc, exp: inc + 30 * 86400 };
}

async function rrsig(zone, set, now) {
  const { name, type, ttl } = set[0];
  // Ответ по шаблону «*.» подписан как шаблон: число меток меньше, чем в имени вопроса.
  const owner = set[0].wildcard || name;
  const { inc, exp } = window(now);
  const datas = set.map((r) => r.data);
  const key = `${zone.id}|${zone.serial}|${owner}|${type}|${ttl}|${inc}|${datas.slice().sort().join('\n')}`;
  let sig = sigCache.get(key);
  if (!sig) {
    sig = await signWith(zone.key.pkcs8, rrsetData(owner, type, ttl, datas, { signer: zone.name, inc, exp, labels: labelsOf(owner) }));
    if (sigCache.size > 20000) sigCache.clear();
    sigCache.set(key, sig);
  }
  return { name, type: 'RRSIG', ttl, data: `${type} 13 ${labelsOf(owner)} ${ttl} ${exp} ${inc} ${zone.key.key_tag} ${zone.name} ${sig}` };
}

function groupSets(rrs) {
  const m = new Map();
  for (const r of rrs) {
    if (r.type === 'RRSIG') continue;
    const k = `${r.name}|${r.type}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.values()];
}

/** Имена зоны для цепочки NSEC (без того, что ниже точек делегирования). */
function nsecNames(zone) {
  if (zone.nsec) return zone.nsec;
  const cuts = [...zone.names.keys()].filter((n) => n !== zone.name && (zone.names.get(n) || []).some((r) => r.type === 'NS'));
  const names = [...zone.names.keys()].filter((n) => !cuts.some((c) => n !== c && inZone(n, c)));
  names.sort(canonicalCompare);
  zone.nsec = names;
  return names;
}

function nsecFor(zone, owner) {
  const names = nsecNames(zone);
  const i = names.indexOf(owner);
  const next = names[(i + 1) % names.length];
  const types = new Set((zone.names.get(owner) || []).map((r) => r.type));
  const cut = owner !== zone.name && types.has('NS');
  const list = cut ? [...types].filter((t) => t === 'NS' || t === 'DS') : [...types];
  if (owner === zone.name && zone.key) list.push('DNSKEY');
  list.push('RRSIG', 'NSEC');
  return { name: owner, type: 'NSEC', ttl: soaMin(zone), data: `${next} ${[...new Set(list)].sort().join(' ')}` };
}

function soaMin(zone) {
  const soa = (zone.names.get(zone.name) || []).find((r) => r.type === 'SOA');
  return soa ? Math.min(soa.ttl, Number(soa.data.split(' ')[6]) || 300) : 300;
}

/** Ближайшее имя зоны, предшествующее qname в каноническом порядке (покрывающая NSEC). */
function coveringOwner(zone, qname) {
  const names = nsecNames(zone);
  let prev = names[0];
  for (const n of names) {
    if (canonicalCompare(n, qname) <= 0) prev = n; else break;
  }
  return prev;
}

/**
 * Добавить в ответ DNSSEC-данные (как сервер на запрос с флагом DO): DNSKEY на вершине, NSEC для отрицательных
 * ответов, RRSIG на каждый набор, за который отвечает зона. Делегирование (NS у родителя) не подписывается.
 */
export async function signResponse(zone, resp, qname, qtype, now) {
  if (!zone?.key || !zone.dnssec) return resp;
  const out = { ...resp, answer: [...resp.answer], authority: [...resp.authority] };
  const referral = !resp.aa && resp.authority.some((r) => r.type === 'NS');
  if (resp.rcode === 'NXDOMAIN' || (resp.rcode === 'NOERROR' && !resp.answer.length && !referral)) {
    if (resp.rcode === 'NXDOMAIN') out.authority.push(nsecFor(zone, coveringOwner(zone, qname)));
    else {
      const exists = zone.names.has(qname);
      out.authority.push(nsecFor(zone, exists ? qname : coveringOwner(zone, qname)));
    }
  }
  if (referral) {
    const cut = resp.authority.find((r) => r.type === 'NS').name;
    const ds = (zone.names.get(cut) || []).filter((r) => r.type === 'DS');
    if (ds.length) out.authority.push(...ds);
    else out.authority.push(nsecFor(zone, cut)); // доказательство: у делегированной зоны нет DS (она не подписана)
  }
  const sigs = [];
  for (const set of groupSets(out.answer)) if (inZone(set[0].name, zone.name) || set[0].wildcard) sigs.push(['answer', await rrsig(zone, set, now)]);
  for (const set of groupSets(out.authority)) {
    if (referral && set[0].type === 'NS') continue;
    sigs.push(['authority', await rrsig(zone, set, now)]);
  }
  for (const [sec, s] of sigs) out[sec].push(s);
  out.answer = out.answer.map(({ wildcard, ...r }) => r);
  return out;
}

/** DNSKEY вершины зоны (синтезируется сервером из ключа зоны). */
export function dnskeyRR(zone) {
  return { name: zone.name, type: 'DNSKEY', ttl: DNSKEY_TTL, data: `257 3 13 ${zone.key.spki}` };
}

export function parseRrsig(data) {
  const p = String(data).split(' ');
  return { covered: p[0], alg: Number(p[1]), labels: Number(p[2]), ttl: Number(p[3]), exp: Number(p[4]), inc: Number(p[5]), tag: Number(p[6]), signer: p[7], sig: p[8] };
}

/** Владелец, по которому считалась подпись: для ответа по шаблону — «*.» + последние метки. */
export function signedOwner(name, labels) {
  const n = labelsOf(name);
  if (labels >= n) return name;
  const parts = name.slice(0, -1).split('.');
  return `*.${parts.slice(parts.length - labels).join('.')}.`;
}

export { ancestry };
