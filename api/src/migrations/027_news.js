// Этап Н10: БалНовости (novosti.bln) — госновости от админа, СМИ игроков (своя редакция или RSS/Atom
// с их сайтов), автособытия экономики каждый игровой месяц. Сайт — на госсервере 50.1.0.10.
// Самодостаточный модуль: при сборке миграции копируются отдельно от бандла.
const GOV_NS = ['ns1.gov.bln.', 'ns2.gov.bln.'];
const NS_IPS = ['50.0.3.10', '50.0.3.11'];
const WEB = '50.1.0.10';

export async function up({ q }) {
  await q(`CREATE TABLE news_outlets (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    slug VARCHAR(40) NOT NULL,
    title VARCHAR(80) NOT NULL,
    description VARCHAR(300) NULL,
    kind ENUM('gov','media','economy') NOT NULL DEFAULT 'media',
    owner_gov_id BIGINT NULL,
    rss_url VARCHAR(600) NULL,
    status ENUM('active','blocked') NOT NULL DEFAULT 'active',
    last_fetch BIGINT NULL,
    last_error VARCHAR(300) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_news_slug (slug),
    KEY idx_news_owner (owner_gov_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await q(`CREATE TABLE news_articles (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    outlet_id BIGINT NOT NULL,
    guid VARCHAR(255) NOT NULL,
    title VARCHAR(200) NOT NULL,
    summary VARCHAR(500) NULL,
    body MEDIUMTEXT NULL,
    link VARCHAR(600) NULL,
    category VARCHAR(20) NOT NULL DEFAULT 'society',
    author VARCHAR(80) NULL,
    pinned TINYINT(1) NOT NULL DEFAULT 0,
    published BIGINT NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_news_guid (outlet_id, guid),
    KEY idx_news_pub (published)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await q("INSERT IGNORE INTO news_outlets (slug, title, description, kind) VALUES ('gov', 'Правительство БФ', 'Официальные новости государства Балесноландия', 'gov'), ('economy', 'Экономика БФ', 'Автоматическая сводка: цены, инфляция, банки, БалНет — каждый игровой месяц', 'economy')");

  const zone = async (name) => (await q('SELECT * FROM dns_zones WHERE name = ?', [name]))[0];
  const bln = await zone('bln.');
  const name = 'novosti.bln.';
  if (!(await zone(name))) {
    const z = await q("INSERT INTO dns_zones (name, kind, serial, dnssec) VALUES (?, 'domain', 2026110901, 1)", [name]);
    const rec = (n, type, ttl, data) => q('INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, ?, ?, ?)', [z.insertId, n, type, ttl, data]);
    for (const ip of NS_IPS) await q('INSERT INTO dns_zone_servers (zone_id, ip) VALUES (?, ?)', [z.insertId, ip]);
    await rec(name, 'SOA', 86400, `ns1.gov.bln. hostmaster.${name} 2026110901 7200 3600 1209600 300`);
    for (const ns of GOV_NS) await rec(name, 'NS', 172800, ns);
    await rec(name, 'A', 3600, WEB);
    await rec(`www.${name}`, 'CNAME', 3600, name);
    await rec(name, 'TXT', 3600, '"БалНовости - новости Балесноландии"');
    await rec(name, 'CAA', 3600, '0 issue "ca.gov.bln"');
    if (bln) {
      for (const ns of GOV_NS) await q('INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, ?, ?, ?)', [bln.id, name, 'NS', 172800, ns]);
      await q('UPDATE dns_zones SET serial = serial + 1 WHERE id = ?', [bln.id]);
    }
  }
  for (const host of ['novosti.bln', 'www.novosti.bln']) await q("INSERT IGNORE INTO net_vhosts (ip, host, target) VALUES (?, ?, 'app:news')", [WEB, host]);
}
