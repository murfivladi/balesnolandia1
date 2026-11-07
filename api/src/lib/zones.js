// DNS-зоны в базе: проверка записей, serial, PTR, делегирования. Общее для админки и владельцев доменов.
import { q, one } from '../db.js';
import { bad, int, need } from './errors.js';
import { isIP, normalizeIP, reverseName, isIPv4 } from '@bln/shared/balnet-ip.js';
import { absoluteName, normalizeRdata, inZone, DnsInputError, RR_TYPES } from '@bln/shared/balnet-dns.js';

const MAX_TTL = 2 ** 31 - 1;

export function rdata(type, data) {
  try {
    return normalizeRdata(type, data);
  } catch (e) {
    if (e instanceof DnsInputError) throw bad('invalid_record', e.message);
    throw e;
  }
}

export function ipArg(v, what = 'IP-адрес') {
  need(isIP(String(v ?? '')), `${what}: неверный адрес`);
  return normalizeIP(String(v));
}

export async function bumpSerial(conn, zoneId) {
  const z = await one('SELECT serial FROM dns_zones WHERE id = ? FOR UPDATE', [zoneId], conn);
  const serial = (Number(z.serial) + 1) % 4294967296;
  await q('UPDATE dns_zones SET serial = ? WHERE id = ?', [serial, zoneId], conn);
  const soa = await one("SELECT id, data FROM dns_records WHERE zone_id = ? AND type = 'SOA' LIMIT 1", [zoneId], conn);
  if (soa) {
    const p = soa.data.split(' ');
    p[2] = String(serial);
    await q('UPDATE dns_records SET data = ? WHERE id = ?', [p.join(' '), soa.id], conn);
  }
}

/** Зона, внутри которой лежит имя (самая глубокая). */
export async function zoneFor(conn, name) {
  const zones = await q('SELECT * FROM dns_zones', [], conn);
  let best = null;
  for (const z of zones) if (inZone(name, z.name) && (!best || z.name.length > best.name.length)) best = z;
  return best;
}

export async function setPtr(conn, ip, name) {
  if (!isIPv4(ip)) return;
  const arpa = await one("SELECT id FROM dns_zones WHERE name = 'in-addr.arpa.'", [], conn);
  if (!arpa) return;
  const owner = reverseName(ip);
  await q("DELETE FROM dns_records WHERE zone_id = ? AND name = ? AND type = 'PTR'", [arpa.id, owner], conn);
  if (name) await q("INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, 'PTR', 3600, ?)", [arpa.id, owner, name], conn);
  await bumpSerial(conn, arpa.id);
}

export async function checkRecord(conn, zone, rec, exceptId = null) {
  const others = await q('SELECT id, type FROM dns_records WHERE zone_id = ? AND name = ? AND id <> ?', [zone.id, rec.name, exceptId || 0], conn);
  if (rec.type === 'CNAME') need(!others.length, 'CNAME не может стоять рядом с другими записями этого имени');
  else need(!others.some((o) => o.type === 'CNAME'), 'У этого имени уже есть CNAME — другие записи рядом с ним нельзя');
  if (rec.type === 'SOA') {
    need(rec.name === zone.name, 'SOA бывает только на вершине зоны (@)');
    need(!others.some((o) => o.type === 'SOA'), 'SOA в зоне уже есть');
  }
  if (rec.type === 'CNAME') need(rec.name !== zone.name, 'CNAME на вершине зоны запрещён (там SOA и NS)');
  // Имя не должно уходить в дочернюю зону, у которой свои серверы.
  const child = await zoneFor(conn, rec.name);
  need(child.id === zone.id, `Имя ${rec.name} относится к зоне ${child.name} — правьте её`);
}

export function recordArgs(zone, b) {
  const type = String(b.type || '').toUpperCase();
  need(RR_TYPES.includes(type), `Тип записи: ${RR_TYPES.join(', ')}`);
  const name = absoluteName(b.name, zone.name);
  need(name, 'Неверное имя записи');
  const ttl = int(b.ttl ?? 3600, 'TTL', { min: 0, max: MAX_TTL });
  return { name, type, ttl, data: rdata(type, b.data) };
}


// ——— Зоны доменов игроков ———

export const HOSTED_NS = ['ns1.dns.bln.', 'ns2.dns.bln.'];

/** Серверы бесплатного DNS-хостинга регистраторов: [{ name, ip }]. */
export async function hostedServers(conn) {
  return q(`SELECT ip, name FROM net_hosts WHERE name IN (${HOSTED_NS.map(() => '?').join(',')}) AND kind = 'auth' ORDER BY name`, HOSTED_NS, conn);
}

/** Зона домена на DNS-хостинге (ns1/ns2.dns.bln). Создаётся один раз и живёт, пока домен не освобождён. */
export async function ensureHostedZone(conn, domain) {
  if (domain.zone_id) return domain.zone_id;
  const servers = await hostedServers(conn);
  need(servers.length, 'DNS-хостинг БалНета не настроен');
  const z = await q("INSERT INTO dns_zones (name, kind, serial, domain_id) VALUES (?, 'domain', 1, ?)", [domain.name, domain.id], conn);
  for (const s of servers) {
    await q('INSERT INTO dns_zone_servers (zone_id, ip) VALUES (?, ?)', [z.insertId, s.ip], conn);
    await q("INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, 'NS', 172800, ?)", [z.insertId, domain.name, s.name], conn);
  }
  await q("INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, 'SOA', 86400, ?)", [z.insertId, domain.name, `${servers[0].name} hostmaster.dns.bln. 1 7200 3600 1209600 300`], conn);
  await q('UPDATE domains SET zone_id = ? WHERE id = ?', [z.insertId, domain.id], conn);
  return z.insertId;
}

/**
 * Делегирование домена в зоне TLD: NS-записи и glue (адрес обязателен, если сервер имён внутри самого домена).
 * ns: [{ name, ip }] — ip нужен только для glue.
 */
export async function setDelegation(conn, domain, tld, ns) {
  // DS (DNSSEC) остаётся: владелец убирает его сам, иначе домен станет «bogus» — как в жизни.
  await q("DELETE FROM dns_records WHERE zone_id = ? AND domain_id = ? AND type <> 'DS'", [tld.zone_id, domain.id], conn);
  for (const n of ns) {
    await q("INSERT INTO dns_records (zone_id, name, type, ttl, data, domain_id) VALUES (?, ?, 'NS', 172800, ?, ?)", [tld.zone_id, domain.name, n.name, domain.id], conn);
    if (inZone(n.name, domain.name)) {
      need(n.ip, `Для сервера ${n.name} внутри домена нужен IP-адрес (glue)`);
      await q('INSERT INTO dns_records (zone_id, name, type, ttl, data, domain_id) VALUES (?, ?, ?, 172800, ?, ?)', [tld.zone_id, n.name, isIPv4(n.ip) ? 'A' : 'AAAA', n.ip, domain.id], conn);
    }
  }
  await bumpSerial(conn, tld.zone_id);
}

export async function removeDelegation(conn, domain, tld) {
  const r = await q('DELETE FROM dns_records WHERE zone_id = ? AND domain_id = ?', [tld.zone_id, domain.id], conn);
  if (r.affectedRows) await bumpSerial(conn, tld.zone_id);
}

/** Серверы имён домена в текущем режиме. */
export async function domainNs(conn, domain) {
  if (domain.ns_mode === 'custom') return (typeof domain.custom_ns === 'string' ? JSON.parse(domain.custom_ns) : domain.custom_ns) || [];
  return (await hostedServers(conn)).map((s) => ({ name: s.name, ip: null }));
}

export async function deleteDomainZone(conn, domain) {
  if (domain.zone_id) await q('DELETE FROM dns_zones WHERE id = ?', [domain.zone_id], conn);
  await q('DELETE FROM dns_records WHERE domain_id = ?', [domain.id], conn);
  await q('UPDATE domains SET zone_id = NULL WHERE id = ?', [domain.id], conn);
}
