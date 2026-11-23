-- Этап Н4: статический хостинг. Серверы (госхостинга и арендованные хостерами), тарифы, аккаунты, сайты, заказы.
-- Сайт на сервере — запись в net_vhosts с целью «site:<id>».

CREATE TABLE hosting_servers (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT NULL,
  ip VARCHAR(45) NOT NULL,
  name VARCHAR(253) NOT NULL,
  disk_mb INT NOT NULL,
  rent_price BIGINT NOT NULL DEFAULT 0,
  status ENUM('active','suspended','closed') NOT NULL DEFAULT 'active',
  paid_month INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_hosting_server_ip (ip),
  KEY idx_hosting_server_org (org_id)
) ENGINE=InnoDB;

CREATE TABLE hosting_plans (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT NULL,
  server_id INT NOT NULL,
  name VARCHAR(80) NOT NULL,
  disk_mb INT NOT NULL,
  max_sites INT NOT NULL DEFAULT 5,
  price_month BIGINT NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_plan_org (org_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE hosting_accounts (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  plan_id INT NOT NULL,
  server_id INT NOT NULL,
  org_id BIGINT NULL,
  owner_gov_user_id BIGINT NULL,
  owner_org_id BIGINT NULL,
  status ENUM('reserved','active','suspended','deleted') NOT NULL DEFAULT 'reserved',
  paid_until_month INT NOT NULL,
  used_bytes BIGINT NOT NULL DEFAULT 0,
  created_month INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_hacc_owner (owner_gov_user_id),
  KEY idx_hacc_server (server_id, status)
) ENGINE=InnoDB;

CREATE TABLE hosting_sites (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id BIGINT NOT NULL,
  host VARCHAR(253) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_site_account_host (account_id, host)
) ENGINE=InnoDB;

CREATE TABLE hosting_orders (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id BIGINT NOT NULL,
  gov_user_id BIGINT NOT NULL,
  months INT NOT NULL,
  amount BIGINT NOT NULL,
  invoice_id BIGINT NULL,
  status ENUM('pending','paid','cancelled') NOT NULL DEFAULT 'pending',
  created_month INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_horder_account (account_id, status)
) ENGINE=InnoDB;
