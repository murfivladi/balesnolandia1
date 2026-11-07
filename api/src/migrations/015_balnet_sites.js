// Отдельные сайты сервисов БалНета: reg.bln (БалРег — регистратор доменов), hosting.bln (БалХост — хостинг),
// nalog.gov.bln (Налоговая служба БФ — организации и лицензии). Все на госсервере 50.1.0.10.
// Самодостаточный модуль: при сборке миграции копируются отдельно от бандла.

const GOV_NS = ['ns1.gov.bln.', 'ns2.gov.bln.'];
const NS_IPS = ['50.0.3.10', '50.0.3.11'];
const WEB = '50.1.0.10';
const SOA = (z) => `ns1.gov.bln. hostmaster.${z} 2026110701 7200 3600 1209600 300`;

export async function up({ q }) {
  const zone = async (name) => (await q('SELECT * FROM dns_zones WHERE name = ?', [name]))[0];
  const bln = await zone('bln.');
  const gov = await zone('gov.bln.');
  const rec = (zoneId, name, type, ttl, data) => q('INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, ?, ?, ?)', [zoneId, name, type, ttl, data]);

  for (const [name, txt] of [['reg.bln.', 'БалРег - Госрегистратор доменов БалНета'], ['hosting.bln.', 'БалХост - Госхостинг БалНета']]) {
    if (await zone(name)) continue;
    const z = await q("INSERT INTO dns_zones (name, kind, serial) VALUES (?, 'domain', 2026110701)", [name]);
    for (const ip of NS_IPS) await q('INSERT INTO dns_zone_servers (zone_id, ip) VALUES (?, ?)', [z.insertId, ip]);
    await rec(z.insertId, name, 'SOA', 86400, SOA(name));
    for (const ns of GOV_NS) await rec(z.insertId, name, 'NS', 172800, ns);
    await rec(z.insertId, name, 'A', 3600, WEB);
    await rec(z.insertId, `www.${name}`, 'CNAME', 3600, name);
    await rec(z.insertId, name, 'TXT', 3600, `"${txt}"`);
    await rec(z.insertId, name, 'CAA', 3600, '0 issue "ca.gov.bln"');
    if (bln) for (const ns of GOV_NS) await rec(bln.id, name, 'NS', 172800, ns);
  }
  if (bln) await q('UPDATE dns_zones SET serial = serial + 1 WHERE id = ?', [bln.id]);
  if (gov) {
    await rec(gov.id, 'nalog.gov.bln.', 'A', 3600, WEB);
    await rec(gov.id, 'www.nalog.gov.bln.', 'CNAME', 3600, 'nalog.gov.bln.');
    await q('UPDATE dns_zones SET serial = serial + 1 WHERE id = ?', [gov.id]);
  }
  for (const [host, target] of [
    ['reg.bln', 'app:reg'], ['www.reg.bln', 'app:reg'],
    ['hosting.bln', 'app:hosting'], ['www.hosting.bln', 'app:hosting'],
    ['nalog.gov.bln', 'app:nalog'], ['www.nalog.gov.bln', 'app:nalog'],
  ]) {
    await q('INSERT IGNORE INTO net_vhosts (ip, host, target) VALUES (?, ?, ?)', [WEB, host, target]);
  }
}
