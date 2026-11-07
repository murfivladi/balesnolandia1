// Сайт ca.gov.bln — БалСерт, государственный удостоверяющий центр БалНета. Сервер 50.1.0.10.
// Ключи УЦ и журнала прозрачности создаёт API при первом запуске (lib/pki.js).
const WEB = '50.1.0.10';

export async function up({ q }) {
  const gov = (await q("SELECT * FROM dns_zones WHERE name = 'gov.bln.'"))[0];
  if (gov) {
    await q("INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, 'ca.gov.bln.', 'A', 3600, ?)", [gov.id, WEB]);
    await q("INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, 'www.ca.gov.bln.', 'CNAME', 3600, 'ca.gov.bln.')", [gov.id]);
    await q('UPDATE dns_zones SET serial = serial + 1 WHERE id = ?', [gov.id]);
  }
  for (const host of ['ca.gov.bln', 'www.ca.gov.bln']) await q("INSERT IGNORE INTO net_vhosts (ip, host, target) VALUES (?, ?, 'app:ca')", [WEB, host]);
}
