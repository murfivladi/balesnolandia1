// ВлодХаб (vlodhub.bln) — git-хостинг БалНета: пользователи, токены доступа, репозитории, соавторы,
// задачи и запросы на слияние, деплой на хостинг по push. Сайт — на госсервере 50.1.0.10.
// Самодостаточный модуль: при сборке миграции копируются отдельно от бандла.
const GOV_NS = ['ns1.gov.bln.', 'ns2.gov.bln.'];
const NS_IPS = ['50.0.3.10', '50.0.3.11'];
const WEB = '50.1.0.10';

export async function up({ q }) {
  await q(`CREATE TABLE hub_users (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    gov_user_id BIGINT NOT NULL,
    login VARCHAR(39) NOT NULL,
    name VARCHAR(80) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_hub_gov (gov_user_id),
    UNIQUE KEY uq_hub_login (login)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await q(`CREATE TABLE hub_tokens (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT NOT NULL,
    name VARCHAR(80) NOT NULL,
    token_hash CHAR(64) NOT NULL,
    prefix VARCHAR(12) NOT NULL,
    last_used DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_hub_token (token_hash),
    KEY idx_hub_token_user (user_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await q(`CREATE TABLE hub_repos (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    owner_id BIGINT NOT NULL,
    name VARCHAR(100) NOT NULL,
    description VARCHAR(300) NULL,
    private TINYINT(1) NOT NULL DEFAULT 0,
    default_branch VARCHAR(100) NOT NULL DEFAULT 'main',
    deploy_site_id BIGINT NULL,
    deploy_branch VARCHAR(100) NULL,
    pushed_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_hub_repo (owner_id, name)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await q(`CREATE TABLE hub_collaborators (
    repo_id BIGINT NOT NULL,
    user_id BIGINT NOT NULL,
    PRIMARY KEY (repo_id, user_id)
  ) ENGINE=InnoDB`);
  await q(`CREATE TABLE hub_issues (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    repo_id BIGINT NOT NULL,
    number INT NOT NULL,
    kind ENUM('issue','pr') NOT NULL DEFAULT 'issue',
    title VARCHAR(200) NOT NULL,
    body TEXT NULL,
    author_id BIGINT NOT NULL,
    state ENUM('open','closed','merged') NOT NULL DEFAULT 'open',
    head VARCHAR(100) NULL,
    base VARCHAR(100) NULL,
    merged_oid CHAR(40) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_hub_issue (repo_id, number)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await q(`CREATE TABLE hub_comments (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    issue_id BIGINT NOT NULL,
    author_id BIGINT NOT NULL,
    body TEXT NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_hub_comment (issue_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);
  await q(`CREATE TABLE hub_deploys (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    repo_id BIGINT NOT NULL,
    site_id BIGINT NOT NULL,
    commit_oid CHAR(40) NOT NULL,
    status ENUM('ok','failed') NOT NULL,
    message VARCHAR(500) NULL,
    files JSON NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_hub_deploy (repo_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  const zone = async (name) => (await q('SELECT * FROM dns_zones WHERE name = ?', [name]))[0];
  const bln = await zone('bln.');
  const name = 'vlodhub.bln.';
  if (!(await zone(name))) {
    const z = await q("INSERT INTO dns_zones (name, kind, serial, dnssec) VALUES (?, 'domain', 2026110801, 1)", [name]);
    const rec = (n, type, ttl, data) => q('INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, ?, ?, ?)', [z.insertId, n, type, ttl, data]);
    for (const ip of NS_IPS) await q('INSERT INTO dns_zone_servers (zone_id, ip) VALUES (?, ?)', [z.insertId, ip]);
    await rec(name, 'SOA', 86400, `ns1.gov.bln. hostmaster.${name} 2026110801 7200 3600 1209600 300`);
    for (const ns of GOV_NS) await rec(name, 'NS', 172800, ns);
    await rec(name, 'A', 3600, WEB);
    await rec(`www.${name}`, 'CNAME', 3600, name);
    await rec(name, 'TXT', 3600, '"ВлодХаб - git-хостинг БалНета"');
    await rec(name, 'CAA', 3600, '0 issue "ca.gov.bln"');
    if (bln) {
      for (const ns of GOV_NS) await q('INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, ?, ?, ?)', [bln.id, name, 'NS', 172800, ns]);
      await q('UPDATE dns_zones SET serial = serial + 1 WHERE id = ?', [bln.id]);
    }
  }
  for (const host of ['vlodhub.bln', 'www.vlodhub.bln']) await q("INSERT IGNORE INTO net_vhosts (ip, host, target) VALUES (?, ?, 'app:hub')", [WEB, host]);
}
