// Сеть БалНета: снимок инфраструктуры в памяти, маршруты (ping, traceroute), аренда адресов, подключение к серверу.
import { q, one } from '../db.js';
import { bad, notFound } from './errors.js';
import { longestMatch, nthIp, parseCidr } from '@bln/shared/balnet-ip.js';

// ——— Снимок: блоки, хосты, vhost, провайдеры, зоны и записи. Сбрасывается при любой правке в админке. ———
let snapPromise = null;

const invalidateHooks = [];
/** Подписка на сброс снимка сети (например, DNSSEC проверяет ключи новых зон). */
export function onNetInvalidate(fn) {
  invalidateHooks.push(fn);
}

export function invalidateNet() {
  snapPromise = null;
  for (const fn of invalidateHooks) fn();
}

async function build() {
  const [blocks, hosts, vhosts, providers, zones, servers, records, keys] = await Promise.all([
    q('SELECT * FROM net_ip_blocks'),
    q('SELECT * FROM net_hosts'),
    q('SELECT * FROM net_vhosts'),
    q('SELECT * FROM net_providers'),
    q('SELECT * FROM dns_zones'),
    q('SELECT * FROM dns_zone_servers'),
    q('SELECT id, zone_id, name, type, ttl, data FROM dns_records ORDER BY id'),
    q('SELECT zone_id, spki, pkcs8, key_tag FROM dnssec_keys'),
  ]);
  const hostByIp = new Map(hosts.map((h) => [h.ip, { ...h, up: !!h.up }]));
  const vhostsByIp = new Map();
  for (const v of vhosts) {
    if (!vhostsByIp.has(v.ip)) vhostsByIp.set(v.ip, new Map());
    vhostsByIp.get(v.ip).set(v.host, v.target);
  }
  const zoneById = new Map(zones.map((z) => [z.id, { ...z, dnssec: !!z.dnssec, servers: [], names: new Map() }]));
  for (const k of keys) if (zoneById.has(k.zone_id)) zoneById.get(k.zone_id).key = k;
  const zonesByServer = new Map();
  for (const s of servers) {
    const z = zoneById.get(s.zone_id);
    if (!z) continue;
    z.servers.push(s.ip);
    if (!zonesByServer.has(s.ip)) zonesByServer.set(s.ip, []);
    zonesByServer.get(s.ip).push(z);
  }
  for (const r of records) {
    const z = zoneById.get(r.zone_id);
    if (!z) continue;
    if (!z.names.has(r.name)) z.names.set(r.name, []);
    z.names.get(r.name).push({ name: r.name, type: r.type, ttl: r.ttl, data: r.data });
  }
  const zoneByName = new Map([...zoneById.values()].map((z) => [z.name, z]));
  return {
    blocks,
    hostByIp,
    vhostsByIp,
    providers: providers.map((p) => ({ ...p, active: !!p.active })),
    providerById: new Map(providers.map((p) => [p.id, p])),
    zoneById,
    zoneByName,
    zonesByServer,
  };
}

export function netSnapshot() {
  if (!snapPromise) snapPromise = build().catch((e) => { snapPromise = null; throw e; });
  return snapPromise;
}

// ——— Маршрут и задержки ———

const IX_IP = '50.255.0.1';
const jitter = (ms) => Math.max(0.1, ms * (0.92 + Math.random() * 0.16));
const round = (ms) => Math.round(ms * 10) / 10;

/**
 * Путь пакета от src до dst: шлюз отправителя → БалНет-IX → шлюз получателя → получатель.
 * Каждый шаг — { ip, rtt } с накопленной задержкой. reachable=false — нет маршрута до сети получателя.
 */
export function routeHops(snap, src, dst) {
  const sb = longestMatch(src, snap.blocks);
  const db = longestMatch(dst, snap.blocks);
  if (!db) {
    const hops = sb?.gateway_ip ? [{ ip: sb.gateway_ip, rtt: sb.latency_ms }] : [];
    return { reachable: false, hops };
  }
  if (sb && sb.id === db.id) return { reachable: true, hops: [{ ip: dst, rtt: 0.4 }] };
  const hops = [];
  let t = 0;
  if (sb?.gateway_ip && sb.gateway_ip !== dst) { t += sb.latency_ms; hops.push({ ip: sb.gateway_ip, rtt: t }); }
  if (sb?.purpose !== 'ix' && db.purpose !== 'ix') { t += 1; hops.push({ ip: IX_IP, rtt: t }); }
  if (db.gateway_ip && db.gateway_ip !== dst) { t += db.latency_ms; hops.push({ ip: db.gateway_ip, rtt: t }); }
  t += db.gateway_ip === dst ? db.latency_ms : 0.6;
  hops.push({ ip: dst, rtt: t });
  return { reachable: true, hops };
}

/** Время туда-обратно до хоста (мс) или null, если хост не ответит. */
export function rtt(snap, src, dst) {
  const r = routeHops(snap, src, dst);
  const host = snap.hostByIp.get(dst);
  if (!r.reachable || !host || !host.up) return null;
  return round(jitter(r.hops[r.hops.length - 1].rtt));
}

/** ping: count попыток. */
export function ping(snap, src, dst, count = 4) {
  const r = routeHops(snap, src, dst);
  const host = snap.hostByIp.get(dst);
  const base = r.hops[r.hops.length - 1]?.rtt;
  const replies = [];
  for (let i = 0; i < count; i++) {
    replies.push(r.reachable && host?.up ? { seq: i + 1, ttl: 64 - r.hops.length + 1, ms: round(jitter(base)) } : { seq: i + 1, lost: true });
  }
  return { ip: dst, name: host?.name || null, reachable: r.reachable, replies };
}

/** traceroute: имя узла берётся из таблицы хостов (как PTR в обратной зоне). */
export function traceroute(snap, src, dst) {
  const r = routeHops(snap, src, dst);
  const hops = r.hops.map((h, i) => {
    const host = snap.hostByIp.get(h.ip);
    // Промежуточные маршрутизаторы отвечают, если не выключены; конечный узел — только если он есть и включён.
    const alive = i === r.hops.length - 1 ? !!host?.up : host?.up !== false;
    return { n: i + 1, ip: h.ip, name: host?.name || null, ms: alive ? [0, 1, 2].map(() => round(jitter(h.rtt))) : null };
  });
  if (!r.reachable) hops.push({ n: hops.length + 1, ip: null, name: null, ms: null, unreachable: true });
  return { ip: dst, hops };
}

// ——— Аренда адресов у провайдера (как DHCP) ———

const CLIENT_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function checkClientId(id) {
  if (typeof id !== 'string' || !CLIENT_RE.test(id)) throw bad('invalid', 'Неверный идентификатор устройства');
  return id;
}

export async function lease(clientId, providerCode) {
  checkClientId(clientId);
  const snap = await netSnapshot();
  const provider = snap.providers.find((p) => p.code === providerCode && p.active);
  if (!provider) throw notFound('Провайдер не найден');
  const block = snap.blocks.find((b) => b.id === provider.block_id);
  const cidr = block && parseCidr(block.cidr);
  if (!cidr) throw bad('no_block', 'У провайдера нет блока адресов');
  const cur = await one('SELECT * FROM net_leases WHERE client_id = ?', [clientId]);
  if (cur && cur.provider_id === provider.id) {
    await q('UPDATE net_leases SET seen_at = NOW(3) WHERE client_id = ?', [clientId]);
    return { ip: cur.ip, provider };
  }
  if (cur) await q('DELETE FROM net_leases WHERE client_id = ?', [clientId]);
  // Адреса клиентов — с x.x.1.0: в первой /24 провайдера живут шлюз и резолвер.
  const used = await one('SELECT COUNT(*) AS n FROM net_leases WHERE provider_id = ?', [provider.id]);
  for (let k = 0; k < 64; k++) {
    const n = 256 + Number(used.n) + k;
    const ip = nthIp(cidr, n);
    if (!ip || ip.endsWith('.0') || ip.endsWith('.255')) continue;
    try {
      await q('INSERT INTO net_leases (client_id, provider_id, ip) VALUES (?,?,?)', [clientId, provider.id, ip]);
      return { ip, provider };
    } catch (e) {
      if (e.code !== 'ER_DUP_ENTRY') throw e;
    }
  }
  throw bad('pool_exhausted', 'У провайдера закончились свободные адреса');
}

export async function clientOf(clientId) {
  checkClientId(clientId);
  const l = await one('SELECT * FROM net_leases WHERE client_id = ?', [clientId]);
  if (!l) throw bad('no_lease', 'Устройство не подключено к провайдеру');
  const snap = await netSnapshot();
  return { ip: l.ip, provider: snap.providerById.get(l.provider_id) };
}

// ——— Подключение к серверу по IP (для браузера и curl) ———

/**
 * Что ответит сервер на ip для имени host:
 *  ok — сайт найден (target: app:bank | app:services | app:pos | poisk);
 *  иначе code — ошибка как в Chrome.
 */
export function connect(snap, src, ip, host) {
  const route = routeHops(snap, src, ip);
  if (!route.reachable) return { ok: false, code: 'ERR_ADDRESS_UNREACHABLE', ip };
  const h = snap.hostByIp.get(ip);
  if (!h || !h.up) return { ok: false, code: 'ERR_CONNECTION_TIMED_OUT', ip };
  if (h.kind !== 'web') return { ok: false, code: 'ERR_CONNECTION_REFUSED', ip, server: h.name };
  const name = String(host).replace(/\.$/, '');
  const target = snap.vhostsByIp.get(ip)?.get(name) || null;
  const ms = round(jitter(route.hops[route.hops.length - 1].rtt));
  if (!target) return { ok: false, code: 'HTTP_404_NO_VHOST', ip, server: h.name, status: 404, ms };
  // Встроенные цели (приложения проекта и ВлодПоиск) настраивает только админ — это и есть госсайты.
  const gov = target.startsWith('app:') || target === 'poisk';
  return { ok: true, ip, server: h.name, target, gov, status: 200, ms };
}

/** whois: IP → блок адресов; имя → зона. */
export async function whois(query) {
  const snap = await netSnapshot();
  const s = String(query || '').trim().toLowerCase();
  const block = longestMatch(s, snap.blocks);
  if (block) {
    const prov = block.provider_id ? snap.providerById.get(block.provider_id) : null;
    return { kind: 'ip', cidr: block.cidr, holder: block.holder, purpose: block.purpose, provider: prov?.name || null, created_at: block.created_at };
  }
  const name = s.endsWith('.') ? s : `${s}.`;
  const zone = snap.zoneByName.get(name);
  if (zone) {
    const ns = (zone.names.get(zone.name) || []).filter((r) => r.type === 'NS').map((r) => r.data);
    return { kind: 'domain', name: zone.name.slice(0, -1), zone_kind: zone.kind, ns, created_at: zone.created_at, registrar: 'Координационный центр БалНета' };
  }
  return { kind: 'none' };
}
