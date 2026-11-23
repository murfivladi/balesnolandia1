// DNS БалНета: авторитетные серверы и рекурсивные резолверы с кэшем.
// Резолвер ходит по-настоящему: корень → TLD → авторитетный NS, следует делегированиям и glue,
// идёт по CNAME, кэширует ответы и отрицательные ответы (NXDOMAIN/NODATA) по TTL в игровых секундах.
import { netSnapshot, rtt } from './net.js';
import { ancestry, inZone, soaMinimum, fqdn, QUERY_TYPES } from '@bln/shared/balnet-dns.js';
import { verifySig, dsDigest, rrsetData } from '@bln/shared/balnet-pki.js';
import { bad } from './errors.js';
import { gameSeconds } from './clock.js';
import { signResponse, dnskeyRR, parseRrsig, signedOwner, canonicalCompare, ensureDnssec } from './dnssec.js';

const MAX_QUERIES = 40;
const MAX_CNAME = 8;
const TIMEOUT_MS = 1000;
const CACHE_LIMIT = 5000;

// ——— Авторитетный сервер ———

function soaOf(zone) {
  return (zone.names.get(zone.name) || []).find((r) => r.type === 'SOA') || null;
}

function hasDescendant(zone, name) {
  const suffix = name === '.' ? '' : `.${name}`;
  for (const n of zone.names.keys()) if (n !== name && n.endsWith(suffix)) return true;
  return false;
}

/** Ответ авторитетного сервера ip на вопрос (qname, qtype) — без рекурсии и без DNSSEC-данных. */
export function authoritative(snap, ip, qname, qtype) {
  return answerFrom(snap, ip, qname, qtype).resp;
}

/** То же с флагом DO: подписи RRSIG, NSEC, DS в делегированиях (если зона подписана). */
export async function authoritativeDo(snap, ip, qname, qtype, now) {
  const { zone, resp } = answerFrom(snap, ip, qname, qtype);
  return signResponse(zone, resp, qname, qtype, now);
}

function answerFrom(snap, ip, qname, qtype) {
  const zones = snap.zonesByServer.get(ip) || [];
  let zone = null;
  // DS лежит у родителя: если сервер держит и родительскую зону, отвечает из неё.
  for (const z of zones) {
    if (!inZone(qname, z.name) || (qtype === 'DS' && z.name === qname && qname !== '.')) continue;
    if (!zone || z.name.length > zone.name.length) zone = z;
  }
  if (!zone) return { zone: null, resp: { rcode: 'REFUSED', aa: false, answer: [], authority: [], additional: [] } };
  return { zone, resp: zoneAnswer(zone, qname, qtype) };
}

function zoneAnswer(zone, qname, qtype) {
  // Делегирование: ближайшая к вершине зоны точка разреза между вершиной и qname.
  const chain = ancestry(qname).reverse(); // от корня к qname
  for (const n of chain) {
    if (n === zone.name || !inZone(n, zone.name)) continue;
    const nsSet = (zone.names.get(n) || []).filter((r) => r.type === 'NS');
    if (nsSet.length && !(n === qname && qtype === 'DS')) {
      const additional = [];
      for (const ns of nsSet) {
        if (!inZone(ns.data, zone.name)) continue;
        for (const g of zone.names.get(ns.data) || []) if (g.type === 'A' || g.type === 'AAAA') additional.push(g);
      }
      return { rcode: 'NOERROR', aa: false, answer: [], authority: nsSet, additional };
    }
  }

  const soa = soaOf(zone);
  if (qtype === 'DNSKEY' && qname === zone.name && zone.key && zone.dnssec) return { rcode: 'NOERROR', aa: true, answer: [dnskeyRR(zone)], authority: [], additional: [] };
  const rrs = zone.names.get(qname);
  const pick = (list, name, wild = null) => {
    const m = list.filter((r) => qtype === 'ANY' || r.type === qtype).map((r) => ({ ...r, name, ...(wild ? { wildcard: wild } : {}) }));
    if (m.length) return { rcode: 'NOERROR', aa: true, answer: m, authority: [], additional: [] };
    const cname = list.find((r) => r.type === 'CNAME');
    if (cname) {
      // Как настоящие серверы: цепочку CNAME внутри своей зоны сразу дописываем в ответ.
      const answer = [{ ...cname, name, ...(wild ? { wildcard: wild } : {}) }];
      let target = cname.data;
      for (let i = 0; i < 8 && inZone(target, zone.name); i++) {
        const next = zone.names.get(target) || [];
        const hit = next.filter((r) => qtype === 'ANY' || r.type === qtype);
        if (hit.length) { answer.push(...hit); break; }
        const c2 = next.find((r) => r.type === 'CNAME');
        if (!c2) break;
        answer.push(c2);
        target = c2.data;
      }
      return { rcode: 'NOERROR', aa: true, answer, authority: [], additional: [] };
    }
    return { rcode: 'NOERROR', aa: true, answer: [], authority: soa ? [soa] : [], additional: [] };
  };
  if (rrs) return pick(rrs, qname);
  if (hasDescendant(zone, qname)) return { rcode: 'NOERROR', aa: true, answer: [], authority: soa ? [soa] : [], additional: [] };

  // Wildcard: ближайший существующий предок внутри зоны, у которого есть «*.».
  for (const anc of ancestry(qname).slice(1)) {
    if (!inZone(anc, zone.name)) break;
    if (zone.names.has(anc) || hasDescendant(zone, anc)) {
      const wname = `*.${anc === '.' ? '' : anc}`;
      const wild = zone.names.get(wname);
      if (wild) return pick(wild, qname, wname);
      break;
    }
  }
  return { rcode: 'NXDOMAIN', aa: true, answer: [], authority: soa ? [soa] : [], additional: [] };
}

// ——— Кэш резолверов ———

const caches = new Map(); // ip резолвера → Map(ключ → запись)

function cacheOf(ip) {
  if (!caches.has(ip)) caches.set(ip, new Map());
  return caches.get(ip);
}

export function flushResolverCache(ip) {
  if (ip) caches.delete(ip); else caches.clear();
}

export function resolverCacheSize(ip) {
  return caches.get(ip)?.size || 0;
}

function put(cache, key, value) {
  if (cache.size >= CACHE_LIMIT) cache.delete(cache.keys().next().value);
  cache.delete(key);
  cache.set(key, value);
}

/** Кэш наборов записей вместе с их подписями RRSIG (резолвер с DNSSEC хранит их рядом). */
function cacheRRset(ctx, rrs) {
  const groups = new Map();
  const sigs = new Map();
  for (const r of rrs) {
    if (r.type === 'RRSIG') {
      const k = `${r.name}|${r.data.split(' ')[0]}`;
      if (!sigs.has(k)) sigs.set(k, []);
      sigs.get(k).push(r);
      continue;
    }
    if (r.type === 'NSEC') continue;
    const k = `${r.name}|${r.type}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const [k, list] of groups) {
    const ttl = Math.min(...list.map((r) => r.ttl));
    const strip = (x) => x.map(({ name, type, data }) => ({ name, type, data }));
    put(ctx.cache, k, { rrs: strip(list), sigs: strip(sigs.get(k) || []), expires: ctx.now + ttl });
  }
}

function cacheGet(ctx, key) {
  const e = ctx.cache.get(key);
  if (!e) return null;
  if (e.expires <= ctx.now) { ctx.cache.delete(key); return null; }
  const ttl = e.expires - ctx.now;
  if (e.neg) return { neg: e.neg, soa: { ...e.soa, ttl }, proof: (e.proof || []).map((r) => ({ ...r, ttl })) };
  return { rrs: e.rrs.map((r) => ({ ...r, ttl })), sigs: (e.sigs || []).map((r) => ({ ...r, ttl })) };
}

function cacheNegative(ctx, key, kind, authority) {
  const soa = authority.find((r) => r.type === 'SOA');
  if (!soa) return;
  const ttl = Math.min(soa.ttl, soaMinimum(soa.data));
  const proof = authority.filter((r) => r.type === 'NSEC' || r.type === 'RRSIG').map(({ name, type, data }) => ({ name, type, data }));
  put(ctx.cache, key, { neg: kind, soa: { name: soa.name, type: 'SOA', data: soa.data }, proof, expires: ctx.now + ttl });
}

// ——— Рекурсивный резолвер ———

function rootHints(snap) {
  const root = snap.zoneByName.get('.');
  return (root?.servers || []).map((ip) => ({ ip, name: snap.hostByIp.get(ip)?.name || ip }));
}

/** Ближайшие к qname известные серверы имён из кэша; иначе — корень. */
function closestServers(ctx, qname, qtype) {
  for (const anc of ancestry(qname)) {
    if (qtype === 'DS' && anc === qname && qname !== '.') continue; // DS спрашивают у родителя
    const ns = cacheGet(ctx, `${anc}|NS`);
    if (!ns) continue;
    const servers = [];
    for (const r of ns.rrs) {
      const a = cacheGet(ctx, `${r.data}|A`);
      for (const x of a?.rrs || []) servers.push({ ip: x.data, name: r.data });
    }
    if (servers.length) return { zone: anc, servers };
  }
  return { zone: '.', servers: rootHints(ctx.snap) };
}

async function ask(ctx, servers, qname, qtype) {
  for (const s of servers) {
    if (ctx.queries++ >= MAX_QUERIES) return null;
    const ms = rtt(ctx.snap, ctx.resolverIp, s.ip);
    if (ms === null) {
      ctx.ms += TIMEOUT_MS;
      ctx.trace.push({ server: s.ip, server_name: s.name, qname, qtype, timeout: true, ms: TIMEOUT_MS, ...(ctx.validating ? { dnssec: true } : {}) });
      continue;
    }
    ctx.ms += ms;
    const resp = await authoritativeDo(ctx.snap, s.ip, qname, qtype, ctx.now);
    const kind = resp.rcode !== 'NOERROR' ? resp.rcode : resp.answer.length ? 'answer' : resp.aa ? 'nodata' : 'referral';
    ctx.trace.push({
      server: s.ip, server_name: s.name, qname, qtype, rcode: resp.rcode, aa: resp.aa, kind, ms, ...(ctx.validating ? { dnssec: true } : {}),
      answer: resp.answer, authority: resp.authority, additional: resp.additional,
    });
    if (resp.rcode === 'REFUSED' || resp.rcode === 'SERVFAIL') continue;
    return resp;
  }
  return null;
}

async function iterate(ctx, qname, qtype, depth = 0) {
  if (depth > MAX_CNAME) return { rcode: 'SERVFAIL', answer: [], authority: [] };

  const hit = cacheGet(ctx, `${qname}|${qtype}`);
  if (hit) { ctx.fromCache++; return hit.neg ? { rcode: 'NOERROR', answer: [], authority: [hit.soa, ...hit.proof] } : { rcode: 'NOERROR', answer: [...hit.rrs, ...hit.sigs], authority: [] }; }
  const nx = cacheGet(ctx, `${qname}|*`);
  if (nx) { ctx.fromCache++; return { rcode: 'NXDOMAIN', answer: [], authority: [nx.soa, ...nx.proof] }; }
  if (qtype !== 'CNAME') {
    const cn = cacheGet(ctx, `${qname}|CNAME`);
    if (cn) {
      ctx.fromCache++;
      const sub = await iterate(ctx, cn.rrs[0].data, qtype, depth + 1);
      return { ...sub, answer: [...cn.rrs, ...cn.sigs, ...sub.answer] };
    }
  }

  let { servers } = closestServers(ctx, qname, qtype);
  const seenZones = new Set();
  for (;;) {
    const resp = await ask(ctx, servers, qname, qtype);
    if (!resp) return { rcode: 'SERVFAIL', answer: [], authority: [] };

    if (resp.rcode === 'NXDOMAIN') {
      cacheNegative(ctx, `${qname}|*`, 'NXDOMAIN', resp.authority);
      return { rcode: 'NXDOMAIN', answer: [], authority: resp.authority };
    }
    if (resp.answer.length) {
      cacheRRset(ctx, resp.answer);
      const direct = resp.answer.filter((r) => r.name === qname && (qtype === 'ANY' || r.type === qtype));
      if (direct.length) return { rcode: 'NOERROR', answer: resp.answer, authority: [] };
      const sigsOf = (name) => resp.answer.filter((r) => r.type === 'RRSIG' && r.name === name);
      // Цепочка CNAME: если сервер дописал цель — готово, иначе спрашиваем цель отдельно.
      let name = qname;
      const chain = [];
      for (;;) {
        const c = resp.answer.find((r) => r.name === name && r.type === 'CNAME');
        if (!c) break;
        chain.push(c, ...sigsOf(name).filter((x) => x.data.startsWith('CNAME ')));
        name = c.data;
      }
      if (chain.length) {
        const fin = resp.answer.filter((r) => r.name === name && (qtype === 'ANY' || r.type === qtype));
        if (fin.length) return { rcode: 'NOERROR', answer: [...chain, ...fin, ...sigsOf(name).filter((x) => !x.data.startsWith('CNAME '))], authority: [] };
        const sub = await iterate(ctx, name, qtype, depth + 1);
        return { ...sub, answer: [...chain, ...sub.answer] };
      }
      return { rcode: 'NOERROR', answer: resp.answer, authority: [] };
    }
    if (resp.aa) {
      cacheNegative(ctx, `${qname}|${qtype}`, 'NODATA', resp.authority);
      return { rcode: 'NOERROR', answer: [], authority: resp.authority };
    }

    // Делегирование: запоминаем NS и glue, идём к новым серверам.
    const nsSet = resp.authority.filter((r) => r.type === 'NS');
    if (!nsSet.length) return { rcode: 'SERVFAIL', answer: [], authority: [] };
    const cut = nsSet[0].name;
    if (seenZones.has(cut)) return { rcode: 'SERVFAIL', answer: [], authority: [] }; // петля делегирований
    seenZones.add(cut);
    cacheRRset(ctx, nsSet);
    const dsSet = resp.authority.filter((r) => r.type === 'DS' || (r.type === 'RRSIG' && r.data.startsWith('DS ')));
    if (dsSet.length) cacheRRset(ctx, dsSet);
    if (resp.additional.length) cacheRRset(ctx, resp.additional);
    const next = [];
    for (const ns of nsSet) {
      for (const g of resp.additional) if (g.name === ns.data && g.type === 'A') next.push({ ip: g.data, name: ns.data });
    }
    if (!next.length) {
      // Glue нет — сначала узнаём адрес сервера имён отдельным запросом.
      for (const ns of nsSet) {
        if (ns.data === qname || inZone(ns.data, cut)) continue; // без glue внутри своей зоны не найти
        const sub = await iterate(ctx, ns.data, 'A', depth + 1);
        for (const a of sub.answer) if (a.type === 'A') next.push({ ip: a.data, name: ns.data });
        if (next.length) break;
      }
    }
    if (!next.length) return { rcode: 'SERVFAIL', answer: [], authority: [] };
    servers = next;
  }
}

// ——— Проверка DNSSEC в резолвере ———
// Цепочка доверия: якорь (ключ корня, встроен в резолвер) → DS у родителя → DNSKEY зоны → RRSIG ответа.
// secure — всё подписано и сходится (флаг AD); insecure — домен без DNSSEC (доказано NSEC у подписанного родителя);
// bogus — подписи нет там, где должна быть, или не сходится: резолвер отвечает SERVFAIL.

const SEC_TTL = 3600;

function setsOf(rrs) {
  const m = new Map();
  for (const r of rrs) {
    if (r.type === 'RRSIG') continue;
    const k = `${r.name}|${r.type}`;
    if (!m.has(k)) m.set(k, []);
    m.get(k).push(r);
  }
  return [...m.values()];
}

/** Проверить подпись набора записей ключами зоны. */
async function verifySet(ctx, set, sigs, keys) {
  const { name, type } = set[0];
  for (const sr of sigs.filter((x) => x.name === name)) {
    const s = parseRrsig(sr.data);
    if (s.covered !== type || s.alg !== 13 || !keys.has(s.tag)) continue;
    if (ctx.now < s.inc || ctx.now > s.exp) continue;
    const owner = signedOwner(name, s.labels);
    const data = rrsetData(owner, type, s.ttl, set.map((r) => r.data), { signer: s.signer, inc: s.inc, exp: s.exp, labels: s.labels });
    if (await verifySig(keys.get(s.tag), data, s.sig)) return true;
  }
  return false;
}

const signerOf = (sigs, name, type) => sigs.map((r) => ({ r, s: parseRrsig(r.data) })).find((x) => x.r.name === name && x.s.covered === type)?.s.signer || null;

/** Безопасность зоны: { status, keys: Map(тег → ключ), why }. Кэшируется резолвером на час игрового времени. */
async function zoneSecurity(ctx, zone, depth = 0) {
  const key = `${zone}|SEC`;
  const hit = ctx.cache.get(key);
  if (hit && hit.expires > ctx.now) return hit.sec;
  const sec = await computeSecurity(ctx, zone, depth);
  put(ctx.cache, key, { sec, expires: ctx.now + SEC_TTL });
  return sec;
}

async function computeSecurity(ctx, zone, depth) {
  if (depth > 12) return { status: 'bogus', why: 'Слишком длинная цепочка доверия' };
  const dk = async () => {
    const r = await iterate(ctx, zone, 'DNSKEY');
    return { set: r.answer.filter((x) => x.type === 'DNSKEY' && x.name === zone), sigs: r.answer.filter((x) => x.type === 'RRSIG') };
  };
  if (zone === '.') {
    const anchor = ctx.snap.zoneByName.get('.')?.key;
    if (!anchor) return { status: 'insecure' };
    const { set, sigs } = await dk();
    const keys = new Map([[anchor.key_tag, anchor.spki]]);
    if (!set.some((x) => x.data.split(' ')[3] === anchor.spki) || !(await verifySet(ctx, set, sigs, keys))) return { status: 'bogus', why: 'Ключ корня не совпадает с якорем доверия' };
    return { status: 'secure', keys };
  }
  const ds = await iterate(ctx, zone, 'DS');
  const dsSet = ds.answer.filter((x) => x.type === 'DS' && x.name === zone);
  const dsSigs = [...ds.answer, ...ds.authority].filter((x) => x.type === 'RRSIG');
  if (ds.rcode !== 'NOERROR' && ds.rcode !== 'NXDOMAIN') return { status: 'bogus', why: `Не удалось получить DS для ${zone} (${ds.rcode})` };
  const soa = ds.authority.find((x) => x.type === 'SOA');
  const parent = signerOf(dsSigs, zone, 'DS') || signerOf(dsSigs, soa?.name, 'SOA') || soa?.name || ancestry(zone)[1] || '.';
  const ps = await zoneSecurity(ctx, parent, depth + 1);
  if (ps.status !== 'secure') return { status: ps.status, why: ps.why };
  if (dsSet.length) {
    if (!(await verifySet(ctx, dsSet, dsSigs, ps.keys))) return { status: 'bogus', why: `Подпись DS ${zone} неверна` };
    const { set, sigs } = await dk();
    for (const d of dsSet) {
      const [tag, , , digest] = d.data.split(' ');
      for (const k of set) {
        const spki = k.data.split(' ')[3];
        if ((await dsDigest(zone, spki)) !== digest) continue;
        const keys = new Map([[Number(tag), spki]]);
        if (await verifySet(ctx, set, sigs, keys)) return { status: 'secure', keys };
      }
    }
    return { status: 'bogus', why: `DNSKEY зоны ${zone} не совпадает с DS у родителя` };
  }
  // DS нет: подписанный родитель должен доказать это записью NSEC.
  const nsec = ds.authority.find((x) => x.type === 'NSEC' && x.name === zone);
  if (nsec && !nsec.data.split(' ').slice(1).includes('DS') && soa && (await verifySet(ctx, [nsec], dsSigs, ps.keys))) return { status: 'insecure' };
  return { status: 'bogus', why: `Нет доказательства отсутствия DS для ${zone}` };
}

/** Вершина зоны для имени без подписи: ближайший предок с известными NS. */
function apexOf(ctx, name) {
  for (const anc of ancestry(name)) if (cacheGet(ctx, `${anc}|NS`)) return anc;
  return '.';
}

function nsecCovers(nsec, qname) {
  const [next] = nsec.data.split(' ');
  const afterOwner = canonicalCompare(nsec.name, qname) < 0;
  const beforeNext = canonicalCompare(qname, next) < 0 || canonicalCompare(next, nsec.name) <= 0;
  return afterOwner && beforeNext;
}

async function validate(ctx, qname, qtype, res) {
  if (res.rcode === 'NXDOMAIN' || (res.rcode === 'NOERROR' && !res.answer.some((r) => r.type !== 'RRSIG'))) {
    const soa = res.authority.find((r) => r.type === 'SOA');
    if (!soa) return { status: 'insecure' };
    const sigs = res.authority.filter((r) => r.type === 'RRSIG');
    const signer = signerOf(sigs, soa.name, 'SOA');
    const zs = await zoneSecurity(ctx, signer || soa.name);
    if (zs.status !== 'secure') return zs;
    if (!signer || !(await verifySet(ctx, [soa], sigs, zs.keys))) return { status: 'bogus', why: 'SOA в отрицательном ответе не подписана' };
    const nsecs = res.authority.filter((r) => r.type === 'NSEC');
    for (const n of nsecs) if (!(await verifySet(ctx, [n], sigs, zs.keys))) return { status: 'bogus', why: 'Подпись NSEC неверна' };
    if (res.rcode === 'NXDOMAIN') {
      if (nsecs.some((n) => nsecCovers(n, qname))) return { status: 'secure' };
      return { status: 'bogus', why: 'Нет доказательства NXDOMAIN (NSEC)' };
    }
    const own = nsecs.find((n) => n.name === qname);
    if (own && !own.data.split(' ').slice(1).some((t) => t === qtype || t === 'CNAME')) return { status: 'secure' };
    if (nsecs.some((n) => nsecCovers(n, qname) && inZone(n.data.split(' ')[0], qname))) return { status: 'secure' }; // пустой нетерминал
    return { status: 'bogus', why: 'Нет доказательства отсутствия записи (NSEC)' };
  }
  const sigs = res.answer.filter((r) => r.type === 'RRSIG');
  for (const set of setsOf(res.answer)) {
    const signer = signerOf(sigs, set[0].name, set[0].type);
    const zs = await zoneSecurity(ctx, signer || apexOf(ctx, set[0].name));
    if (zs.status === 'bogus') return zs;
    if (zs.status === 'insecure') return zs;
    if (!signer || !inZone(set[0].name, signer)) return { status: 'bogus', why: `Набор ${set[0].name} ${set[0].type} не подписан` };
    if (!(await verifySet(ctx, set, sigs, zs.keys))) return { status: 'bogus', why: `Подпись ${set[0].name} ${set[0].type} неверна` };
  }
  return { status: 'secure' };
}

/** Проверка имени и типа вопроса. */
export function question(name, type = 'A') {
  const qname = fqdn(String(name || ''));
  if (!qname) throw bad('invalid_name', 'Неверное доменное имя');
  const qtype = String(type || 'A').toUpperCase();
  if (qtype !== 'ANY' && !QUERY_TYPES.includes(qtype)) throw bad('invalid_type', `Неизвестный тип записи: ${type}`);
  return { qname, qtype };
}

/**
 * Рекурсивный запрос клиента clientIp к резолверу resolverIp.
 * Ошибки уровня сети: timeout (по адресу нет резолвера или он выключен), refused (резолвер провайдера
 * обслуживает только своих абонентов).
 */
export async function resolve({ resolverIp, clientIp, clientProviderId, name, type, fresh = false, dnssec = false, cd = false }) {
  const { qname, qtype } = question(name, type);
  await ensureDnssec();
  const snap = await netSnapshot();
  const host = snap.hostByIp.get(resolverIp);
  const toResolver = rtt(snap, clientIp, resolverIp);
  const base = { resolver: { ip: resolverIp, name: host?.name || null }, qname, qtype };
  if (!host || host.kind !== 'resolver' || toResolver === null) {
    return { ...base, rcode: 'TIMEOUT', answer: [], authority: [], trace: [], ms: 3 * TIMEOUT_MS, cached: false };
  }
  if (host.provider_id && host.provider_id !== clientProviderId) {
    return { ...base, rcode: 'REFUSED', answer: [], authority: [], trace: [], ms: toResolver, cached: false };
  }
  // fresh — без кэша: так проверяет домены удостоверяющий центр (всегда идёт к авторитетным серверам).
  const ctx = { snap, resolverIp, cache: fresh ? new Map() : cacheOf(resolverIp), now: await gameSeconds(), trace: [], ms: 0, queries: 0, fromCache: 0 };
  let res = await iterate(ctx, qname, qtype);
  // Резолверы БалНета проверяют DNSSEC. cd — «проверку не делать» (dig +cd).
  let sec = { status: 'insecure' };
  if (!cd && (res.rcode === 'NOERROR' || res.rcode === 'NXDOMAIN')) {
    ctx.validating = true; // запросы DS/DNSKEY для проверки помечаются в трассе
    sec = await validate(ctx, qname, qtype, res);
    ctx.validating = false;
  }
  if (sec.status === 'bogus') res = { rcode: 'SERVFAIL', answer: [], authority: [], ede: `DNSSEC Bogus: ${sec.why}` };
  // Без DO клиенту не нужны RRSIG и NSEC.
  const clean = (rrs) => (dnssec ? rrs : rrs.filter((r) => r.type !== 'RRSIG' && r.type !== 'NSEC'));
  return {
    ...base, ...res, answer: clean(res.answer), authority: clean(res.authority), ad: sec.status === 'secure', dnssec: sec.status,
    trace: ctx.trace, ms: Math.round((toResolver + ctx.ms) * 10) / 10, cached: ctx.trace.length === 0, time: ctx.now,
  };
}

/** dig @сервер без рекурсии: прямой вопрос авторитетному серверу (или рекурсивный — резолверу). */
export async function queryServer({ serverIp, clientIp, clientProviderId, name, type, recurse = true, dnssec = false, cd = false }) {
  const snap = await netSnapshot();
  const host = snap.hostByIp.get(serverIp);
  if (host?.kind === 'resolver') {
    if (!recurse) {
      const { qname, qtype } = question(name, type);
      const ctx = { snap, resolverIp: serverIp, cache: cacheOf(serverIp), now: await gameSeconds() };
      const hit = cacheGet(ctx, `${qname}|${qtype}`);
      const ms = rtt(snap, clientIp, serverIp);
      if (ms === null) return { server: { ip: serverIp, name: host.name }, qname, qtype, rcode: 'TIMEOUT', answer: [], authority: [], additional: [], ms: 3 * TIMEOUT_MS };
      return { server: { ip: serverIp, name: host.name }, qname, qtype, rcode: 'NOERROR', aa: false, answer: hit && !hit.neg ? hit.rrs : [], authority: [], additional: [], ms };
    }
    const r = await resolve({ resolverIp: serverIp, clientIp, clientProviderId, name, type, dnssec, cd });
    return { server: r.resolver, qname: r.qname, qtype: r.qtype, rcode: r.rcode, aa: false, ra: true, ad: r.ad, ede: r.ede, answer: r.answer, authority: r.authority, additional: [], ms: r.ms };
  }
  const { qname, qtype } = question(name, type);
  const ms = rtt(snap, clientIp, serverIp);
  if (!host || ms === null) return { server: { ip: serverIp, name: host?.name || null }, qname, qtype, rcode: 'TIMEOUT', answer: [], authority: [], additional: [], ms: 3 * TIMEOUT_MS };
  await ensureDnssec();
  const resp = dnssec ? await authoritativeDo(await netSnapshot(), serverIp, qname, qtype, await gameSeconds()) : authoritative(await netSnapshot(), serverIp, qname, qtype);
  return { server: { ip: serverIp, name: host.name }, qname, qtype, ...resp, ra: false, ms };
}
