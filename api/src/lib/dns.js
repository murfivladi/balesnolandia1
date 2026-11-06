// DNS БалНета: авторитетные серверы и рекурсивные резолверы с кэшем.
// Резолвер ходит по-настоящему: корень → TLD → авторитетный NS, следует делегированиям и glue,
// идёт по CNAME, кэширует ответы и отрицательные ответы (NXDOMAIN/NODATA) по TTL в игровых секундах.
import { netSnapshot, rtt } from './net.js';
import { ancestry, inZone, soaMinimum, fqdn, RR_TYPES } from '@bln/shared/balnet-dns.js';
import { bad } from './errors.js';
import { gameSeconds } from './clock.js';

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

/** Ответ авторитетного сервера ip на вопрос (qname, qtype) — без рекурсии. */
export function authoritative(snap, ip, qname, qtype) {
  const zones = snap.zonesByServer.get(ip) || [];
  let zone = null;
  for (const z of zones) if (inZone(qname, z.name) && (!zone || z.name.length > zone.name.length)) zone = z;
  if (!zone) return { rcode: 'REFUSED', aa: false, answer: [], authority: [], additional: [] };

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
  const rrs = zone.names.get(qname);
  const pick = (list, name) => {
    const m = list.filter((r) => qtype === 'ANY' || r.type === qtype).map((r) => ({ ...r, name }));
    if (m.length) return { rcode: 'NOERROR', aa: true, answer: m, authority: [], additional: [] };
    const cname = list.find((r) => r.type === 'CNAME');
    if (cname) return { rcode: 'NOERROR', aa: true, answer: [{ ...cname, name }], authority: [], additional: [] };
    return { rcode: 'NOERROR', aa: true, answer: [], authority: soa ? [soa] : [], additional: [] };
  };
  if (rrs) return pick(rrs, qname);
  if (hasDescendant(zone, qname)) return { rcode: 'NOERROR', aa: true, answer: [], authority: soa ? [soa] : [], additional: [] };

  // Wildcard: ближайший существующий предок внутри зоны, у которого есть «*.».
  for (const anc of ancestry(qname).slice(1)) {
    if (!inZone(anc, zone.name)) break;
    if (zone.names.has(anc) || hasDescendant(zone, anc)) {
      const wild = zone.names.get(`*.${anc === '.' ? '' : anc}`);
      if (wild) return pick(wild, qname);
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

function cacheRRset(ctx, rrs) {
  const groups = new Map();
  for (const r of rrs) {
    const k = `${r.name}|${r.type}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  for (const [k, list] of groups) {
    const ttl = Math.min(...list.map((r) => r.ttl));
    put(ctx.cache, k, { rrs: list.map(({ name, type, data }) => ({ name, type, data })), expires: ctx.now + ttl });
  }
}

function cacheGet(ctx, key) {
  const e = ctx.cache.get(key);
  if (!e) return null;
  if (e.expires <= ctx.now) { ctx.cache.delete(key); return null; }
  const ttl = e.expires - ctx.now;
  if (e.neg) return { neg: e.neg, soa: { ...e.soa, ttl } };
  return { rrs: e.rrs.map((r) => ({ ...r, ttl })) };
}

function cacheNegative(ctx, key, kind, soa) {
  if (!soa) return;
  const ttl = Math.min(soa.ttl, soaMinimum(soa.data));
  put(ctx.cache, key, { neg: kind, soa: { name: soa.name, type: 'SOA', data: soa.data }, expires: ctx.now + ttl });
}

// ——— Рекурсивный резолвер ———

function rootHints(snap) {
  const root = snap.zoneByName.get('.');
  return (root?.servers || []).map((ip) => ({ ip, name: snap.hostByIp.get(ip)?.name || ip }));
}

/** Ближайшие к qname известные серверы имён из кэша; иначе — корень. */
function closestServers(ctx, qname) {
  for (const anc of ancestry(qname)) {
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

function ask(ctx, servers, qname, qtype) {
  for (const s of servers) {
    if (ctx.queries++ >= MAX_QUERIES) return null;
    const ms = rtt(ctx.snap, ctx.resolverIp, s.ip);
    if (ms === null) {
      ctx.ms += TIMEOUT_MS;
      ctx.trace.push({ server: s.ip, server_name: s.name, qname, qtype, timeout: true, ms: TIMEOUT_MS });
      continue;
    }
    ctx.ms += ms;
    const resp = authoritative(ctx.snap, s.ip, qname, qtype);
    const kind = resp.rcode !== 'NOERROR' ? resp.rcode : resp.answer.length ? 'answer' : resp.aa ? 'nodata' : 'referral';
    ctx.trace.push({
      server: s.ip, server_name: s.name, qname, qtype, rcode: resp.rcode, aa: resp.aa, kind, ms,
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
  if (hit) { ctx.fromCache++; return hit.neg ? { rcode: 'NOERROR', answer: [], authority: [hit.soa] } : { rcode: 'NOERROR', answer: hit.rrs, authority: [] }; }
  const nx = cacheGet(ctx, `${qname}|*`);
  if (nx) { ctx.fromCache++; return { rcode: 'NXDOMAIN', answer: [], authority: [nx.soa] }; }
  if (qtype !== 'CNAME') {
    const cn = cacheGet(ctx, `${qname}|CNAME`);
    if (cn) {
      ctx.fromCache++;
      const sub = await iterate(ctx, cn.rrs[0].data, qtype, depth + 1);
      return { ...sub, answer: [...cn.rrs, ...sub.answer] };
    }
  }

  let { servers } = closestServers(ctx, qname);
  const seenZones = new Set();
  for (;;) {
    const resp = ask(ctx, servers, qname, qtype);
    if (!resp) return { rcode: 'SERVFAIL', answer: [], authority: [] };

    if (resp.rcode === 'NXDOMAIN') {
      cacheNegative(ctx, `${qname}|*`, 'NXDOMAIN', resp.authority.find((r) => r.type === 'SOA'));
      return { rcode: 'NXDOMAIN', answer: [], authority: resp.authority };
    }
    if (resp.answer.length) {
      cacheRRset(ctx, resp.answer);
      const direct = resp.answer.filter((r) => r.name === qname && (qtype === 'ANY' || r.type === qtype));
      if (direct.length) return { rcode: 'NOERROR', answer: resp.answer, authority: [] };
      const cname = resp.answer.find((r) => r.name === qname && r.type === 'CNAME');
      if (cname) {
        const sub = await iterate(ctx, cname.data, qtype, depth + 1);
        return { ...sub, answer: [cname, ...sub.answer] };
      }
      return { rcode: 'NOERROR', answer: resp.answer, authority: [] };
    }
    if (resp.aa) {
      cacheNegative(ctx, `${qname}|${qtype}`, 'NODATA', resp.authority.find((r) => r.type === 'SOA'));
      return { rcode: 'NOERROR', answer: [], authority: resp.authority };
    }

    // Делегирование: запоминаем NS и glue, идём к новым серверам.
    const nsSet = resp.authority.filter((r) => r.type === 'NS');
    if (!nsSet.length) return { rcode: 'SERVFAIL', answer: [], authority: [] };
    const cut = nsSet[0].name;
    if (seenZones.has(cut)) return { rcode: 'SERVFAIL', answer: [], authority: [] }; // петля делегирований
    seenZones.add(cut);
    cacheRRset(ctx, nsSet);
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

/** Проверка имени и типа вопроса. */
export function question(name, type = 'A') {
  const qname = fqdn(String(name || ''));
  if (!qname) throw bad('invalid_name', 'Неверное доменное имя');
  const qtype = String(type || 'A').toUpperCase();
  if (qtype !== 'ANY' && !RR_TYPES.includes(qtype)) throw bad('invalid_type', `Неизвестный тип записи: ${type}`);
  return { qname, qtype };
}

/**
 * Рекурсивный запрос клиента clientIp к резолверу resolverIp.
 * Ошибки уровня сети: timeout (по адресу нет резолвера или он выключен), refused (резолвер провайдера
 * обслуживает только своих абонентов).
 */
export async function resolve({ resolverIp, clientIp, clientProviderId, name, type }) {
  const { qname, qtype } = question(name, type);
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
  const ctx = { snap, resolverIp, cache: cacheOf(resolverIp), now: await gameSeconds(), trace: [], ms: 0, queries: 0, fromCache: 0 };
  const res = await iterate(ctx, qname, qtype);
  return { ...base, ...res, trace: ctx.trace, ms: Math.round((toResolver + ctx.ms) * 10) / 10, cached: ctx.trace.length === 0, time: ctx.now };
}

/** dig @сервер без рекурсии: прямой вопрос авторитетному серверу (или рекурсивный — резолверу). */
export async function queryServer({ serverIp, clientIp, clientProviderId, name, type, recurse = true }) {
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
    const r = await resolve({ resolverIp: serverIp, clientIp, clientProviderId, name, type });
    return { server: r.resolver, qname: r.qname, qtype: r.qtype, rcode: r.rcode, aa: false, ra: true, answer: r.answer, authority: r.authority, additional: [], ms: r.ms };
  }
  const { qname, qtype } = question(name, type);
  const ms = rtt(snap, clientIp, serverIp);
  if (!host || ms === null) return { server: { ip: serverIp, name: host?.name || null }, qname, qtype, rcode: 'TIMEOUT', answer: [], authority: [], additional: [], ms: 3 * TIMEOUT_MS };
  const resp = authoritative(snap, serverIp, qname, qtype);
  return { server: { ip: serverIp, name: host.name }, qname, qtype, ...resp, ra: false, ms };
}
