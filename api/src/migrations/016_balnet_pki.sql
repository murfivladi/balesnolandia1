-- Этап Н5: удостоверяющие центры, сертификаты, журнал прозрачности (CT), проверки домена, ключи DNSSEC.
-- Ключи создаёт API при первом запуске (lib/pki.js, lib/dnssec.js): здесь только таблицы.

CREATE TABLE pki_cas (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT NULL,
  parent_id INT NULL,
  kind ENUM('root','ca') NOT NULL,
  name VARCHAR(120) NOT NULL,
  identifier VARCHAR(253) NULL,
  cert JSON NOT NULL,
  pkcs8 TEXT NOT NULL,
  trusted TINYINT(1) NOT NULL DEFAULT 0,
  prices JSON NULL,
  ski VARCHAR(16) NOT NULL,
  status ENUM('active','revoked') NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pki_ct_logs (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  log_id VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(120) NOT NULL,
  spki TEXT NOT NULL,
  pkcs8 TEXT NOT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pki_certs (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  serial VARCHAR(40) NOT NULL UNIQUE,
  ca_id INT NULL,
  owner_gov_user_id BIGINT NULL,
  owner_org_id BIGINT NULL,
  policy VARCHAR(8) NOT NULL,
  names JSON NOT NULL,
  cert JSON NOT NULL,
  pkcs8 TEXT NOT NULL,
  sct JSON NULL,
  nb BIGINT NOT NULL,
  na BIGINT NOT NULL,
  status ENUM('valid','revoked') NOT NULL DEFAULT 'valid',
  revoked_reason VARCHAR(64) NULL,
  revoked_at BIGINT NULL,
  auto_renew TINYINT(1) NOT NULL DEFAULT 0,
  method VARCHAR(8) NULL,
  gov_site TINYINT(1) NOT NULL DEFAULT 0,
  replaced_by BIGINT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_cert_owner (owner_gov_user_id),
  KEY idx_cert_gov (gov_site, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pki_ct_entries (
  idx BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  log_id VARCHAR(32) NOT NULL,
  cert_id BIGINT NOT NULL,
  cert_hash CHAR(64) NOT NULL,
  prev_hash CHAR(64) NOT NULL,
  entry_hash CHAR(64) NOT NULL,
  ts BIGINT NOT NULL,
  names VARCHAR(2000) NOT NULL,
  issuer VARCHAR(120) NOT NULL,
  KEY idx_ct_cert (cert_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE pki_challenges (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  gov_user_id BIGINT NOT NULL,
  names JSON NOT NULL,
  method ENUM('dns','http') NOT NULL,
  token VARCHAR(64) NOT NULL,
  status ENUM('pending','used') NOT NULL DEFAULT 'pending',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_chal_user (gov_user_id)
) ENGINE=InnoDB;

CREATE TABLE pki_orders (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  gov_user_id BIGINT NOT NULL,
  owner_org_id BIGINT NULL,
  ca_id INT NOT NULL,
  challenge_id BIGINT NOT NULL,
  policy VARCHAR(8) NOT NULL,
  amount BIGINT NOT NULL,
  invoice_id BIGINT NULL,
  cert_id BIGINT NULL,
  status ENUM('pending','done','cancelled') NOT NULL DEFAULT 'pending',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE dnssec_keys (
  zone_id INT NOT NULL PRIMARY KEY,
  spki TEXT NOT NULL,
  pkcs8 TEXT NOT NULL,
  key_tag INT NOT NULL,
  CONSTRAINT fk_dnssec_zone FOREIGN KEY (zone_id) REFERENCES dns_zones (id) ON DELETE CASCADE
) ENGINE=InnoDB;

ALTER TABLE hosting_sites ADD COLUMN cert_id BIGINT NULL;
