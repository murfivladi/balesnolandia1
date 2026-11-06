// Этап Н3: DNS-хостинг для доменов игроков (ns1/ns2.dns.bln) и зоны, открытые для регистрации.
// Самодостаточный модуль: при сборке миграции копируются отдельно от бандла.

const HOSTING = [['50.0.4.10', 'ns1.dns.bln.'], ['50.0.4.11', 'ns2.dns.bln.']];
// имя зоны, оптовая цена реестра и цена Госрегистратора за год (влодинки), ограничение
const TLDS = [
  ['bln.', 5000, 6000, null],
  ['vlod.', 3000, 3600, null],
  ['shop.', 4000, 4800, null],
  ['com.', 4000, 4800, null],
  ['gov.bln.', 0, 0, 'gov'],
  ['edu.bln.', 0, 0, 'gov'],
];

export async function up({ q }) {
  const bln = (await q("SELECT id FROM dns_zones WHERE name = 'bln.'"))[0];
  const arpa = (await q("SELECT id FROM dns_zones WHERE name = 'in-addr.arpa.'"))[0];
  for (const [ip, name] of HOSTING) {
    await q("INSERT INTO net_hosts (ip, name, kind) VALUES (?, ?, 'auth')", [ip, name]);
    if (bln) await q("INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, 'A', 172800, ?)", [bln.id, name, ip]);
    if (arpa) await q("INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, 'PTR', 3600, ?)", [arpa.id, `${ip.split('.').reverse().join('.')}.in-addr.arpa.`, name]);
  }
  for (const [name, wholesale, gov, restricted] of TLDS) {
    const z = (await q('SELECT id FROM dns_zones WHERE name = ?', [name]))[0];
    if (!z) continue;
    await q('INSERT INTO tlds (zone_id, name, wholesale_price, gov_price, restricted) VALUES (?,?,?,?,?)', [z.id, name, wholesale, gov, restricted]);
  }
}
