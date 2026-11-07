// Админка → БалНет: провайдеры, IP-блоки, хосты и сайты на них, DNS-зоны и записи, кэш резолверов.
import { tx, q, one } from '../db.js';
import { notFound, conflict, int, str, need } from '../lib/errors.js';
import { needAdmin, actorOf } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { netSnapshot, invalidateNet } from '../lib/net.js';
import { flushResolverCache, resolverCacheSize } from '../lib/dns.js';
import { parseCidr, longestMatch, nthIp, isIPv4 } from '@bln/shared/balnet-ip.js';
import { fqdn, inZone, RR_TYPES } from '@bln/shared/balnet-dns.js';
import { ipArg, bumpSerial, zoneFor, setPtr, checkRecord, recordArgs } from '../lib/zones.js';

const BLOCK_PURPOSES = ['infra', 'datacenter', 'provider', 'ix', 'hosting'];
const HOST_KINDS = ['router', 'auth', 'resolver', 'web'];
/** Цели vhost, которые может назначить админ: приложения проекта и ВлодПоиск. Сайты игроков — этап Н4. */
export const VHOST_TARGETS = ['app:bank', 'app:services', 'app:pos', 'app:reg', 'app:hosting', 'app:nalog', 'app:ca', 'app:poisk'];

export async function adminNetRoutes(app) {
  app.addHook('preHandler', needAdmin());
  const actor = (req) => actorOf(req.actor);
  const done = async (req, action, entity, id, data) => {
    invalidateNet();
    await audit(null, actor(req), action, entity, id, data);
  };

  app.get('/overview', async () => {
    const snap = await netSnapshot();
    const leases = await q('SELECT provider_id, COUNT(*) AS n FROM net_leases GROUP BY provider_id');
    const leaseBy = new Map(leases.map((l) => [l.provider_id, Number(l.n)]));
    const vhosts = await q('SELECT * FROM net_vhosts ORDER BY ip, host');
    return {
      providers: snap.providers.map((p) => ({ ...p, cidr: snap.blocks.find((b) => b.id === p.block_id)?.cidr || null, leases: leaseBy.get(p.id) || 0 })),
      blocks: snap.blocks,
      hosts: [...snap.hostByIp.values()].map((h) => ({ ...h, vhosts: vhosts.filter((v) => v.ip === h.ip), cache: h.kind === 'resolver' ? resolverCacheSize(h.ip) : undefined })),
      zones: [...snap.zoneById.values()].map((z) => ({ id: z.id, name: z.name, kind: z.kind, serial: z.serial, dnssec: z.dnssec, key_tag: z.key?.key_tag ?? null, servers: z.servers, records: [...z.names.values()].reduce((n, l) => n + l.length, 0) })).sort((a, b) => a.name.localeCompare(b.name)),
      vhost_targets: VHOST_TARGETS,
      record_types: RR_TYPES,
    };
  });

  // ——— IP-блоки ———
  app.post('/blocks', async (req) => {
    const b = req.body || {};
    const c = parseCidr(String(b.cidr || ''));
    need(c, 'Подсеть: например 60.4.0.0/16 (адрес — начало сети)');
    const purpose = String(b.purpose || '');
    need(BLOCK_PURPOSES.includes(purpose), `Назначение: ${BLOCK_PURPOSES.join(', ')}`);
    const cidr = `${c.ip}/${c.prefix}`;
    need(!(await one('SELECT id FROM net_ip_blocks WHERE cidr = ?', [cidr])), 'Такая подсеть уже есть');
    const gw = b.gateway_ip ? ipArg(b.gateway_ip, 'Шлюз') : null;
    const r = await q('INSERT INTO net_ip_blocks (cidr, purpose, holder, gateway_ip, latency_ms) VALUES (?,?,?,?,?)', [
      cidr, purpose, str(b.holder, 'владелец', { max: 120 }), gw, int(b.latency_ms ?? 5, 'задержка', { min: 0, max: 1000 }),
    ]);
    await done(req, 'net.block.create', 'net_block', r.insertId, { cidr });
    return { id: r.insertId };
  });

  app.delete('/blocks/:id', async (req) => {
    const id = int(req.params.id, 'id');
    const blk = await one('SELECT * FROM net_ip_blocks WHERE id = ?', [id]);
    if (!blk) throw notFound();
    need(!(await one('SELECT id FROM net_providers WHERE block_id = ?', [id])), 'Блок принадлежит провайдеру — сначала отключите провайдера');
    const snap = await netSnapshot();
    const inside = [...snap.hostByIp.keys()].filter((ip) => longestMatch(ip, [blk]));
    need(!inside.length, `В блоке есть хосты: ${inside.slice(0, 3).join(', ')}`);
    await q('DELETE FROM net_ip_blocks WHERE id = ?', [id]);
    await done(req, 'net.block.delete', 'net_block', id, { cidr: blk.cidr });
    return { ok: true };
  });

  // ——— Провайдеры ———
  app.post('/providers', async (req) => {
    const b = req.body || {};
    const code = String(b.code || '').trim().toLowerCase();
    need(/^[a-z0-9-]{2,32}$/.test(code), 'Код: латиница, цифры и дефис, 2–32 символа');
    const name = str(b.name, 'название', { max: 100 });
    const c = parseCidr(String(b.cidr || ''));
    need(c && isIPv4(c.ip) && c.prefix <= 22, 'Блок провайдера: IPv4-подсеть не меньше /22, например 60.4.0.0/16');
    const latency = int(b.latency_ms ?? 10, 'задержка', { min: 0, max: 1000 });
    const cidr = `${c.ip}/${c.prefix}`;
    const gw = nthIp(c, 1);
    const resolver = nthIp(c, 53);
    const id = await tx(async (conn) => {
      need(!(await one('SELECT id FROM net_providers WHERE code = ?', [code], conn)), 'Провайдер с таким кодом уже есть');
      need(!(await one('SELECT id FROM net_ip_blocks WHERE cidr = ?', [cidr], conn)), 'Такая подсеть уже есть');
      const p = await q('INSERT INTO net_providers (code, name, resolver_ip) VALUES (?,?,?)', [code, name, resolver], conn);
      const blk = await q("INSERT INTO net_ip_blocks (cidr, purpose, holder, gateway_ip, latency_ms, provider_id) VALUES (?, 'provider', ?, ?, ?, ?)", [cidr, name, gw, latency, p.insertId], conn);
      await q('UPDATE net_providers SET block_id = ? WHERE id = ?', [blk.insertId, p.insertId], conn);
      await q("INSERT INTO net_hosts (ip, name, kind, provider_id) VALUES (?, ?, 'router', ?), (?, ?, 'resolver', ?)", [gw, `gw.${code}.bln.`, p.insertId, resolver, `dns.${code}.bln.`, p.insertId], conn);
      await setPtr(conn, gw, `gw.${code}.bln.`);
      await setPtr(conn, resolver, `dns.${code}.bln.`);
      return p.insertId;
    });
    await done(req, 'net.provider.create', 'net_provider', id, { code, cidr });
    return { id };
  });

  app.patch('/providers/:id', async (req) => {
    const id = int(req.params.id, 'id');
    const b = req.body || {};
    const p = await one('SELECT * FROM net_providers WHERE id = ?', [id]);
    if (!p) throw notFound();
    const name = b.name !== undefined ? str(b.name, 'название', { max: 100 }) : p.name;
    const active = b.active !== undefined ? (b.active ? 1 : 0) : p.active;
    if (!active) {
      const others = await one('SELECT COUNT(*) AS n FROM net_providers WHERE active = 1 AND id <> ?', [id]);
      need(Number(others.n) > 0, 'Нельзя отключить последнего провайдера');
    }
    await q('UPDATE net_providers SET name = ?, active = ? WHERE id = ?', [name, active, id]);
    await done(req, 'net.provider.update', 'net_provider', id, { name, active: !!active });
    return { ok: true };
  });

  // ——— Хосты и сайты на них ———
  app.post('/hosts', async (req) => {
    const b = req.body || {};
    const ip = ipArg(b.ip);
    const name = fqdn(String(b.name || ''));
    need(name, 'Имя хоста: например web2.dc.gov.bln');
    const kind = String(b.kind || '');
    need(HOST_KINDS.includes(kind), `Вид: ${HOST_KINDS.join(', ')}`);
    const snap = await netSnapshot();
    const block = longestMatch(ip, snap.blocks);
    need(block, 'Адрес не входит ни в один IP-блок БалНета');
    await tx(async (conn) => {
      if (await one('SELECT ip FROM net_hosts WHERE ip = ?', [ip], conn)) throw conflict('exists', 'Хост с таким адресом уже есть');
      await q('INSERT INTO net_hosts (ip, name, kind, provider_id) VALUES (?,?,?,?)', [ip, name, kind, block.provider_id || null], conn);
      await setPtr(conn, ip, name);
    });
    await done(req, 'net.host.create', 'net_host', null, { ip, name, kind });
    return { ok: true };
  });

  app.patch('/hosts/:ip', async (req) => {
    const ip = ipArg(req.params.ip);
    const b = req.body || {};
    const h = await one('SELECT * FROM net_hosts WHERE ip = ?', [ip]);
    if (!h) throw notFound();
    const name = b.name !== undefined ? fqdn(String(b.name)) : h.name;
    need(name, 'Неверное имя хоста');
    const up = b.up !== undefined ? (b.up ? 1 : 0) : h.up;
    await tx(async (conn) => {
      await q('UPDATE net_hosts SET name = ?, up = ? WHERE ip = ?', [name, up, ip], conn);
      if (name !== h.name) await setPtr(conn, ip, name);
    });
    await done(req, 'net.host.update', 'net_host', null, { ip, name, up: !!up });
    return { ok: true };
  });

  app.delete('/hosts/:ip', async (req) => {
    const ip = ipArg(req.params.ip);
    const h = await one('SELECT * FROM net_hosts WHERE ip = ?', [ip]);
    if (!h) throw notFound();
    need(!(await one('SELECT id FROM net_providers WHERE resolver_ip = ?', [ip])), 'Это резолвер провайдера — его нельзя удалить');
    need(!(await one('SELECT zone_id FROM dns_zone_servers WHERE ip = ?', [ip])), 'Хост обслуживает DNS-зоны — сначала уберите его из зон');
    await tx(async (conn) => {
      await q('DELETE FROM net_vhosts WHERE ip = ?', [ip], conn);
      await q('DELETE FROM net_hosts WHERE ip = ?', [ip], conn);
      await setPtr(conn, ip, null);
    });
    await done(req, 'net.host.delete', 'net_host', null, { ip });
    return { ok: true };
  });

  app.post('/vhosts', async (req) => {
    const b = req.body || {};
    const ip = ipArg(b.ip);
    const host = fqdn(String(b.host || ''));
    need(host, 'Неверное имя сайта');
    const target = String(b.target || '');
    need(VHOST_TARGETS.includes(target), `Сайт: ${VHOST_TARGETS.join(', ')}`);
    const h = await one('SELECT kind FROM net_hosts WHERE ip = ?', [ip]);
    need(h?.kind === 'web', 'Сайты размещаются только на веб-серверах');
    try {
      await q('INSERT INTO net_vhosts (ip, host, target) VALUES (?,?,?)', [ip, host.slice(0, -1), target]);
    } catch (e) {
      if (e.code === 'ER_DUP_ENTRY') throw conflict('exists', 'Этот сайт на сервере уже настроен');
      throw e;
    }
    await done(req, 'net.vhost.create', 'net_vhost', null, { ip, host, target });
    return { ok: true };
  });

  app.delete('/vhosts/:id', async (req) => {
    const id = int(req.params.id, 'id');
    const v = await one('SELECT * FROM net_vhosts WHERE id = ?', [id]);
    if (!v) throw notFound();
    await q('DELETE FROM net_vhosts WHERE id = ?', [id]);
    await done(req, 'net.vhost.delete', 'net_vhost', id, v);
    return { ok: true };
  });

  // ——— Зоны ———
  app.get('/zones/:id', async (req) => {
    const id = int(req.params.id, 'id');
    const z = await one('SELECT * FROM dns_zones WHERE id = ?', [id]);
    if (!z) throw notFound();
    const servers = (await q('SELECT ip FROM dns_zone_servers WHERE zone_id = ?', [id])).map((r) => r.ip);
    const records = await q('SELECT id, name, type, ttl, data FROM dns_records WHERE zone_id = ? ORDER BY name, type, id', [id]);
    return { zone: { ...z, servers }, records };
  });

  // Новая зона: SOA и NS в самой зоне + делегирование (NS и glue) в родительской.
  app.post('/zones', async (req) => {
    const b = req.body || {};
    const name = fqdn(String(b.name || ''));
    need(name && name !== '.', 'Имя зоны: например shop.vlod');
    const servers = [...new Set((Array.isArray(b.servers) ? b.servers : []).map((s) => ipArg(s, 'Сервер')))];
    need(servers.length >= 1, 'Нужен хотя бы один сервер имён');
    const snap = await netSnapshot();
    const nsHosts = servers.map((ip) => snap.hostByIp.get(ip));
    need(nsHosts.every((h) => h?.kind === 'auth'), 'Серверы зоны должны быть авторитетными DNS-серверами (вид auth)');
    const id = await tx(async (conn) => {
      if (await one('SELECT id FROM dns_zones WHERE name = ?', [name], conn)) throw conflict('exists', 'Такая зона уже есть');
      const parent = await zoneFor(conn, name);
      need(parent, 'Нет родительской зоны');
      const kind = parent.name === '.' ? 'tld' : 'domain';
      const z = await q('INSERT INTO dns_zones (name, kind, serial) VALUES (?, ?, 1)', [name, kind], conn);
      for (const ip of servers) await q('INSERT INTO dns_zone_servers (zone_id, ip) VALUES (?,?)', [z.insertId, ip], conn);
      const mname = nsHosts[0].name;
      await q("INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, 'SOA', 86400, ?)", [z.insertId, name, `${mname} hostmaster.${name === '.' ? '' : name} 1 7200 3600 1209600 300`], conn);
      for (const h of nsHosts) {
        await q("INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, 'NS', 172800, ?)", [z.insertId, name, h.name], conn);
        await q("INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, 'NS', 172800, ?)", [parent.id, name, h.name], conn);
        // Glue: адрес сервера имён, если его имя внутри новой зоны (иначе до него не добраться).
        if (inZone(h.name, name)) {
          await q("INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, ?, 172800, ?)", [z.insertId, h.name, isIPv4(h.ip) ? 'A' : 'AAAA', h.ip], conn);
          await q("INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, ?, 172800, ?)", [parent.id, h.name, isIPv4(h.ip) ? 'A' : 'AAAA', h.ip], conn);
        }
      }
      await bumpSerial(conn, parent.id);
      return z.insertId;
    });
    await done(req, 'net.zone.create', 'dns_zone', id, { name, servers });
    return { id };
  });

  /** DNSSEC инфраструктурной зоны: ключ и DS у родителя ставятся автоматически, выключение их убирает. */
  app.patch('/zones/:id/dnssec', async (req) => {
    const id = int(req.params.id, 'id');
    const z = await one('SELECT * FROM dns_zones WHERE id = ?', [id]);
    if (!z) throw notFound();
    need(!z.domain_id, 'DNSSEC домена игрока включает его владелец на БалРеге');
    await tx(async (conn) => {
      await q('UPDATE dns_zones SET dnssec = ? WHERE id = ?', [req.body?.enabled ? 1 : 0, id], conn);
      if (!req.body?.enabled) {
        await q('DELETE FROM dnssec_keys WHERE zone_id = ?', [id], conn);
        const r = await q("DELETE FROM dns_records WHERE name = ? AND type = 'DS' AND domain_id IS NULL", [z.name], conn);
        if (r.affectedRows) for (const p of await q('SELECT id, name FROM dns_zones', [], conn)) if (p.id !== id && inZone(z.name, p.name)) await bumpSerial(conn, p.id);
      }
      await bumpSerial(conn, id);
    });
    await done(req, req.body?.enabled ? 'dns.dnssec_on' : 'dns.dnssec_off', 'dns_zone', id);
    return { ok: true };
  });

  app.delete('/zones/:id', async (req) => {
    const id = int(req.params.id, 'id');
    const z = await one('SELECT * FROM dns_zones WHERE id = ?', [id]);
    if (!z) throw notFound();
    need(z.kind !== 'root' && z.name !== 'in-addr.arpa.', 'Эту зону удалить нельзя');
    await tx(async (conn) => {
      const all = await q('SELECT id, name FROM dns_zones', [], conn);
      need(!all.some((x) => x.id !== id && x.name !== z.name && inZone(x.name, z.name)), 'Сначала удалите вложенные зоны');
      await q('DELETE FROM dns_zones WHERE id = ?', [id], conn);
      // Делегирование и glue в родительской зоне.
      const parent = all.filter((x) => x.id !== id && inZone(z.name, x.name)).sort((a, b) => b.name.length - a.name.length)[0];
      if (parent) {
        const suffix = `.${z.name}`;
        const rows = await q('SELECT id, name FROM dns_records WHERE zone_id = ?', [parent.id], conn);
        const ids = rows.filter((r) => r.name === z.name || r.name.endsWith(suffix)).map((r) => r.id);
        if (ids.length) await q(`DELETE FROM dns_records WHERE id IN (${ids.map(() => '?').join(',')})`, ids, conn);
        await bumpSerial(conn, parent.id);
      }
    });
    await done(req, 'net.zone.delete', 'dns_zone', id, { name: z.name });
    return { ok: true };
  });

  // ——— Записи ———
  app.post('/zones/:id/records', async (req) => {
    const id = int(req.params.id, 'id');
    const zone = await one('SELECT * FROM dns_zones WHERE id = ?', [id]);
    if (!zone) throw notFound();
    const rec = recordArgs(zone, req.body || {});
    const rid = await tx(async (conn) => {
      await checkRecord(conn, zone, rec);
      const dup = await one('SELECT id FROM dns_records WHERE zone_id = ? AND name = ? AND type = ? AND data = ?', [id, rec.name, rec.type, rec.data], conn);
      need(!dup, 'Такая запись уже есть');
      const r = await q('INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?,?,?,?,?)', [id, rec.name, rec.type, rec.ttl, rec.data], conn);
      // TTL одного набора (имя+тип) должен быть одинаковым.
      await q('UPDATE dns_records SET ttl = ? WHERE zone_id = ? AND name = ? AND type = ?', [rec.ttl, id, rec.name, rec.type], conn);
      await bumpSerial(conn, id);
      return r.insertId;
    });
    await done(req, 'net.record.create', 'dns_record', rid, { zone: zone.name, ...rec });
    return { id: rid };
  });

  app.patch('/records/:id', async (req) => {
    const id = int(req.params.id, 'id');
    const cur = await one('SELECT * FROM dns_records WHERE id = ?', [id]);
    if (!cur) throw notFound();
    const zone = await one('SELECT * FROM dns_zones WHERE id = ?', [cur.zone_id]);
    const b = req.body || {};
    const rec = recordArgs(zone, { name: b.name ?? cur.name, type: b.type ?? cur.type, ttl: b.ttl ?? cur.ttl, data: b.data ?? cur.data });
    if (cur.type === 'SOA') need(rec.type === 'SOA', 'SOA можно только изменить, не сменить тип');
    await tx(async (conn) => {
      await checkRecord(conn, zone, rec, id);
      await q('UPDATE dns_records SET name = ?, type = ?, ttl = ?, data = ? WHERE id = ?', [rec.name, rec.type, rec.ttl, rec.data, id], conn);
      await q('UPDATE dns_records SET ttl = ? WHERE zone_id = ? AND name = ? AND type = ?', [rec.ttl, zone.id, rec.name, rec.type], conn);
      if (rec.type !== 'SOA') await bumpSerial(conn, zone.id);
      else await q('UPDATE dns_zones SET serial = ? WHERE id = ?', [Number(rec.data.split(' ')[2]), zone.id], conn);
    });
    await done(req, 'net.record.update', 'dns_record', id, { zone: zone.name, ...rec });
    return { ok: true };
  });

  app.delete('/records/:id', async (req) => {
    const id = int(req.params.id, 'id');
    const cur = await one('SELECT * FROM dns_records WHERE id = ?', [id]);
    if (!cur) throw notFound();
    const zone = await one('SELECT * FROM dns_zones WHERE id = ?', [cur.zone_id]);
    need(cur.type !== 'SOA', 'SOA удалить нельзя');
    if (cur.type === 'NS' && cur.name === zone.name) {
      const n = await one("SELECT COUNT(*) AS n FROM dns_records WHERE zone_id = ? AND name = ? AND type = 'NS'", [zone.id, zone.name]);
      need(Number(n.n) > 1, 'У зоны должен остаться хотя бы один NS');
    }
    await tx(async (conn) => {
      await q('DELETE FROM dns_records WHERE id = ?', [id], conn);
      await bumpSerial(conn, zone.id);
    });
    await done(req, 'net.record.delete', 'dns_record', id, { zone: zone.name, name: cur.name, type: cur.type, data: cur.data });
    return { ok: true };
  });

  app.post('/cache/flush', async (req) => {
    const ip = req.body?.resolver ? ipArg(req.body.resolver) : null;
    flushResolverCache(ip);
    await audit(null, actor(req), 'net.cache.flush', null, null, { resolver: ip });
    return { ok: true };
  });
}
