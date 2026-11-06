// Этап Н2: начальная сеть БалНета. Модуль самодостаточный (без импортов из src/lib): при сборке API
// миграции копируются в dist отдельно от бандла.
//
// Адресный план:
//   50.0.0.0/16   — корневые и TLD-серверы, госсерверы имён, публичный резолвер ВлодDNS
//   50.1.0.0/16   — госдата-центр БФ (сайты государства)
//   50.255.0.0/24 — точка обмена трафиком БалНет-IX
//   60.1.0.0/16, 60.2.0.0/16, 60.3.0.0/16 — провайдеры
//   ba1:1::/32    — IPv6 госдата-центра

const DAY = 86400;
const TTL_NS = 2 * DAY; // делегирования и glue, как в настоящем корне
const TTL_HOST = 3600;
const SOA_TIMERS = '7200 3600 1209600 300'; // refresh retry expire minimum (minimum — TTL отрицательных ответов)

const blocks = [
  ['50.0.0.0/16', 'infra', 'Координационный центр БалНета (корень и TLD)', '50.0.0.1', 3],
  ['50.1.0.0/16', 'datacenter', 'Госдата-центр БФ', '50.1.0.1', 4],
  ['50.255.0.0/24', 'ix', 'Точка обмена трафиком БалНет-IX', '50.255.0.1', 1],
  ['ba1:1::/32', 'datacenter', 'Госдата-центр БФ (IPv6)', null, 4],
];

const providers = [
  ['baltelecom', 'БалТелеком', '60.1.0.0/16', 6],
  ['vlodlink', 'ВлодЛинк', '60.2.0.0/16', 11],
  ['balesno-mobile', 'Балесно-Мобайл', '60.3.0.0/16', 28],
];

// ip, имя, вид
const hosts = [
  ['50.0.0.1', 'core.nic.bln.', 'router'],
  ['50.1.0.1', 'core.dc.gov.bln.', 'router'],
  ['50.255.0.1', 'ix.balnet.bln.', 'router'],
  ['50.0.0.10', 'a.root.bln.', 'auth'],
  ['50.0.0.11', 'b.root.bln.', 'auth'],
  ['50.0.1.10', 'a.nic.bln.', 'auth'],
  ['50.0.1.11', 'b.nic.bln.', 'auth'],
  ['50.0.2.10', 'a.nic.vlod.', 'auth'],
  ['50.0.3.10', 'ns1.gov.bln.', 'auth'],
  ['50.0.3.11', 'ns2.gov.bln.', 'auth'],
  ['50.0.0.53', 'dns.vlod.', 'resolver'],
  ['50.1.0.10', 'web1.dc.gov.bln.', 'web'],
  ['ba1:1::10', 'web1.dc.gov.bln.', 'web'],
  ['50.1.0.20', 'poisk1.dc.gov.bln.', 'web'],
];

const vhosts = [
  ['50.1.0.10', 'bank.bln', 'app:bank'],
  ['50.1.0.10', 'www.bank.bln', 'app:bank'],
  ['50.1.0.10', 'gosuslugi.gov.bln', 'app:services'],
  ['50.1.0.10', 'www.gosuslugi.gov.bln', 'app:services'],
  ['50.1.0.10', 'kassa.bln', 'app:pos'],
  ['50.1.0.10', 'www.kassa.bln', 'app:pos'],
  ['ba1:1::10', 'bank.bln', 'app:bank'],
  ['ba1:1::10', 'www.bank.bln', 'app:bank'],
  ['ba1:1::10', 'gosuslugi.gov.bln', 'app:services'],
  ['ba1:1::10', 'kassa.bln', 'app:pos'],
  ['50.1.0.20', 'poisk.bln', 'poisk'],
  ['50.1.0.20', 'www.poisk.bln', 'poisk'],
];

const ROOT = ['50.0.0.10', '50.0.0.11'];
const NIC_BLN = ['50.0.1.10', '50.0.1.11'];
const NIC_VLOD = ['50.0.2.10'];
const GOV_NS = ['50.0.3.10', '50.0.3.11'];

const soa = (mname) => `${mname} hostmaster.nic.bln. 2026110601 ${SOA_TIMERS}`;
const glue = (name, ip) => [name, ip.includes(':') ? 'AAAA' : 'A', TTL_NS, ip];
const ns = (zone, names) => names.map((n) => [zone, 'NS', TTL_NS, n]);

// zone, kind, servers, records [name, type, ttl, data]
const zones = [
  ['.', 'root', ROOT, [
    ['.', 'SOA', DAY, soa('a.root.bln.')],
    ...ns('.', ['a.root.bln.', 'b.root.bln.']),
    ...ns('bln.', ['a.nic.bln.', 'b.nic.bln.']),
    ...['vlod.', 'shop.', 'com.'].flatMap((z) => ns(z, ['a.nic.vlod.'])),
    ...ns('in-addr.arpa.', ['a.root.bln.', 'b.root.bln.']),
    glue('a.root.bln.', '50.0.0.10'), glue('b.root.bln.', '50.0.0.11'),
    glue('a.nic.bln.', '50.0.1.10'), glue('b.nic.bln.', '50.0.1.11'),
    glue('a.nic.vlod.', '50.0.2.10'),
  ]],
  ['bln.', 'tld', NIC_BLN, [
    ['bln.', 'SOA', DAY, soa('a.nic.bln.')],
    ...ns('bln.', ['a.nic.bln.', 'b.nic.bln.']),
    ['a.nic.bln.', 'A', TTL_NS, '50.0.1.10'], ['b.nic.bln.', 'A', TTL_NS, '50.0.1.11'],
    ['a.root.bln.', 'A', TTL_NS, '50.0.0.10'], ['b.root.bln.', 'A', TTL_NS, '50.0.0.11'],
    ['core.nic.bln.', 'A', TTL_HOST, '50.0.0.1'],
    ['ix.balnet.bln.', 'A', TTL_HOST, '50.255.0.1'],
    ...['gov.bln.', 'edu.bln.', 'bank.bln.', 'kassa.bln.', 'poisk.bln.'].flatMap((z) => ns(z, ['ns1.gov.bln.', 'ns2.gov.bln.'])),
    glue('ns1.gov.bln.', '50.0.3.10'), glue('ns2.gov.bln.', '50.0.3.11'),
  ]],
  ['vlod.', 'tld', NIC_VLOD, [
    ['vlod.', 'SOA', DAY, soa('a.nic.vlod.')],
    ...ns('vlod.', ['a.nic.vlod.']),
    ['a.nic.vlod.', 'A', TTL_NS, '50.0.2.10'],
    ['dns.vlod.', 'A', TTL_HOST, '50.0.0.53'],
    ['dns.vlod.', 'TXT', TTL_HOST, '"ВлодDNS - публичный резолвер БалНета"'],
  ]],
  ...['shop.', 'com.'].map((z) => [z, 'tld', NIC_VLOD, [
    [z, 'SOA', DAY, soa('a.nic.vlod.')],
    ...ns(z, ['a.nic.vlod.']),
  ]]),
  ['gov.bln.', 'domain', GOV_NS, [
    ['gov.bln.', 'SOA', DAY, soa('ns1.gov.bln.')],
    ...ns('gov.bln.', ['ns1.gov.bln.', 'ns2.gov.bln.']),
    ['ns1.gov.bln.', 'A', TTL_NS, '50.0.3.10'], ['ns2.gov.bln.', 'A', TTL_NS, '50.0.3.11'],
    ['gosuslugi.gov.bln.', 'A', TTL_HOST, '50.1.0.10'],
    ['gosuslugi.gov.bln.', 'AAAA', TTL_HOST, 'ba1:1::10'],
    ['www.gosuslugi.gov.bln.', 'CNAME', TTL_HOST, 'gosuslugi.gov.bln.'],
    ['web1.dc.gov.bln.', 'A', TTL_HOST, '50.1.0.10'],
    ['web1.dc.gov.bln.', 'AAAA', TTL_HOST, 'ba1:1::10'],
    ['poisk1.dc.gov.bln.', 'A', TTL_HOST, '50.1.0.20'],
    ['core.dc.gov.bln.', 'A', TTL_HOST, '50.1.0.1'],
    ['gov.bln.', 'TXT', TTL_HOST, '"Правительство Балесноландской Федерации"'],
  ]],
  ['edu.bln.', 'domain', GOV_NS, [
    ['edu.bln.', 'SOA', DAY, soa('ns1.gov.bln.')],
    ...ns('edu.bln.', ['ns1.gov.bln.', 'ns2.gov.bln.']),
  ]],
  ...[['bank.bln.', 'ВлодБанк - государственный банк БФ'], ['kassa.bln.', 'Касса - сервис для магазинов БФ']].map(([z, txt]) => [z, 'domain', GOV_NS, [
    [z, 'SOA', DAY, soa('ns1.gov.bln.')],
    ...ns(z, ['ns1.gov.bln.', 'ns2.gov.bln.']),
    [z, 'A', TTL_HOST, '50.1.0.10'],
    [z, 'AAAA', TTL_HOST, 'ba1:1::10'],
    [`www.${z}`, 'CNAME', TTL_HOST, z],
    [z, 'TXT', TTL_HOST, `"${txt}"`],
    [z, 'CAA', TTL_HOST, '0 issue "ca.gov.bln"'],
  ]]),
  ['poisk.bln.', 'domain', GOV_NS, [
    ['poisk.bln.', 'SOA', DAY, soa('ns1.gov.bln.')],
    ...ns('poisk.bln.', ['ns1.gov.bln.', 'ns2.gov.bln.']),
    ['poisk.bln.', 'A', TTL_HOST, '50.1.0.20'],
    ['www.poisk.bln.', 'CNAME', TTL_HOST, 'poisk.bln.'],
    ['poisk.bln.', 'TXT', TTL_HOST, '"ВлодПоиск - официальный поисковик БФ"'],
  ]],
];

const ptrName = (ip) => `${ip.split('.').reverse().join('.')}.in-addr.arpa.`;

export async function up({ q }) {
  const allHosts = [...hosts];
  const blnExtra = [];
  for (const [cidr, purpose, holder, gw, lat] of blocks) {
    await q('INSERT INTO net_ip_blocks (cidr, purpose, holder, gateway_ip, latency_ms) VALUES (?,?,?,?,?)', [cidr, purpose, holder, gw, lat]);
  }
  for (const [code, name, cidr, lat] of providers) {
    const base = cidr.split('.').slice(0, 2).join('.');
    const resolver = `${base}.0.53`;
    const p = await q('INSERT INTO net_providers (code, name, resolver_ip) VALUES (?,?,?)', [code, name, resolver]);
    const b = await q('INSERT INTO net_ip_blocks (cidr, purpose, holder, gateway_ip, latency_ms, provider_id) VALUES (?,?,?,?,?,?)', [cidr, 'provider', name, `${base}.0.1`, lat, p.insertId]);
    await q('UPDATE net_providers SET block_id = ? WHERE id = ?', [b.insertId, p.insertId]);
    allHosts.push([`${base}.0.1`, `gw.${code}.bln.`, 'router', p.insertId]);
    allHosts.push([resolver, `dns.${code}.bln.`, 'resolver', p.insertId]);
    blnExtra.push([`gw.${code}.bln.`, 'A', TTL_HOST, `${base}.0.1`], [`dns.${code}.bln.`, 'A', TTL_HOST, resolver]);
  }
  for (const [ip, name, kind, providerId = null] of allHosts) {
    await q('INSERT INTO net_hosts (ip, name, kind, provider_id) VALUES (?,?,?,?)', [ip, name, kind, providerId]);
  }
  for (const [ip, host, target] of vhosts) {
    await q('INSERT INTO net_vhosts (ip, host, target) VALUES (?,?,?)', [ip, host, target]);
  }
  for (const [name, kind, servers, records] of zones) {
    const z = await q('INSERT INTO dns_zones (name, kind, serial) VALUES (?,?,?)', [name, kind, 2026110601]);
    for (const ip of servers) await q('INSERT INTO dns_zone_servers (zone_id, ip) VALUES (?,?)', [z.insertId, ip]);
    for (const [rn, type, ttl, data] of name === 'bln.' ? [...records, ...blnExtra] : records) {
      await q('INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?,?,?,?,?)', [z.insertId, rn, type, ttl, data]);
    }
  }
  // Обратная зона: PTR для всех IPv4-хостов (traceroute показывает имена маршрутизаторов).
  const arpa = await q('INSERT INTO dns_zones (name, kind, serial) VALUES (?,?,?)', ['in-addr.arpa.', 'reverse', 2026110601]);
  for (const ip of ROOT) await q('INSERT INTO dns_zone_servers (zone_id, ip) VALUES (?,?)', [arpa.insertId, ip]);
  await q('INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?,?,?,?,?)', [arpa.insertId, 'in-addr.arpa.', 'SOA', DAY, soa('a.root.bln.')]);
  for (const n of ['a.root.bln.', 'b.root.bln.']) await q('INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?,?,?,?,?)', [arpa.insertId, 'in-addr.arpa.', 'NS', TTL_NS, n]);
  for (const [ip, name] of allHosts) {
    if (ip.includes(':')) continue;
    await q('INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?,?,?,?,?)', [arpa.insertId, ptrName(ip), 'PTR', TTL_HOST, name]);
  }
}
