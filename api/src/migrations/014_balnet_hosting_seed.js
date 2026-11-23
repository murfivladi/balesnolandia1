// Этап Н4: дата-центр для аренды серверов (50.2.0.0/16) и Госхостинг БалНета на 50.1.0.30 с двумя тарифами.
// Самодостаточный модуль: при сборке миграции копируются отдельно от бандла.

const ptr = (ip) => `${ip.split('.').reverse().join('.')}.in-addr.arpa.`;

export async function up({ q }) {
  const arpa = (await q("SELECT id FROM dns_zones WHERE name = 'in-addr.arpa.'"))[0];
  const gov = (await q("SELECT id FROM dns_zones WHERE name = 'gov.bln.'"))[0];
  const addPtr = async (ip, name) => {
    if (arpa) await q("INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, 'PTR', 3600, ?)", [arpa.id, ptr(ip), name]);
  };
  await q("INSERT INTO net_ip_blocks (cidr, purpose, holder, gateway_ip, latency_ms) VALUES ('50.2.0.0/16', 'hosting', 'Дата-центр БалНета (аренда серверов)', '50.2.0.1', 5)");
  await q("INSERT INTO net_hosts (ip, name, kind) VALUES ('50.2.0.1', 'core.dc.bln.', 'router')");
  await addPtr('50.2.0.1', 'core.dc.bln.');

  await q("INSERT INTO net_hosts (ip, name, kind) VALUES ('50.1.0.30', 'hosting1.dc.gov.bln.', 'web')");
  await addPtr('50.1.0.30', 'hosting1.dc.gov.bln.');
  if (gov) await q("INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, 'hosting1.dc.gov.bln.', 'A', 3600, '50.1.0.30')", [gov.id]);
  const s = await q("INSERT INTO hosting_servers (org_id, ip, name, disk_mb, rent_price) VALUES (NULL, '50.1.0.30', 'hosting1.dc.gov.bln.', 2000, 0)");
  await q("INSERT INTO hosting_plans (org_id, server_id, name, disk_mb, max_sites, price_month) VALUES (NULL, ?, 'Старт', 20, 3, 500), (NULL, ?, 'Блог', 100, 10, 1500)", [s.insertId, s.insertId]);
}
