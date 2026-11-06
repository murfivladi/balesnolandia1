-- Этап Н3: организации, лицензии, зоны верхнего уровня, домены игроков, заказы, аукционы.

ALTER TABLE accounts MODIFY owner_kind ENUM('bank_user','system','org') NOT NULL;

-- Разбивка оплаты квитанции по получателям: [{ "account": id, "amount": n }]. Пусто — всё в госбюджет.
ALTER TABLE invoices ADD COLUMN splits JSON NULL;

CREATE TABLE organizations (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind ENUM('llc','jsc','gov') NOT NULL,
  name VARCHAR(120) NOT NULL,
  inn VARCHAR(12) NOT NULL,
  director_gov_user_id BIGINT NULL,
  account_id BIGINT NULL,
  status ENUM('active','closed') NOT NULL DEFAULT 'active',
  created_month INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_org_inn (inn),
  KEY idx_org_director (director_gov_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE org_members (
  org_id BIGINT NOT NULL,
  gov_user_id BIGINT NOT NULL,
  role ENUM('director','staff') NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (org_id, gov_user_id),
  KEY idx_member_user (gov_user_id)
) ENGINE=InnoDB;

CREATE TABLE licenses (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  org_id BIGINT NOT NULL,
  kind VARCHAR(16) NOT NULL,
  number VARCHAR(20) NOT NULL,
  status ENUM('active','revoked','expired') NOT NULL DEFAULT 'active',
  issued_month INT NOT NULL,
  expires_month INT NULL,
  comment VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_license_number (number),
  KEY idx_license_org (org_id, kind, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Зоны, где игроки регистрируют домены. registry_org_id NULL — реестр ведёт Координационный центр (деньги в бюджет).
-- gov_price — цена Госрегистратора БалНета (встроенный регистратор, деньги в бюджет).
CREATE TABLE tlds (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  zone_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  registry_org_id BIGINT NULL,
  wholesale_price BIGINT NOT NULL,
  gov_price BIGINT NOT NULL,
  restricted VARCHAR(8) NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_tld_name (name),
  UNIQUE KEY uq_tld_zone (zone_id)
) ENGINE=InnoDB;

CREATE TABLE registrar_prices (
  org_id BIGINT NOT NULL,
  tld_id INT NOT NULL,
  price BIGINT NOT NULL,
  PRIMARY KEY (org_id, tld_id)
) ENGINE=InnoDB;

-- live_name = name, пока домен занят; NULL после освобождения (история остаётся).
CREATE TABLE domains (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  live_name VARCHAR(255) NULL,
  tld_id INT NOT NULL,
  owner_gov_user_id BIGINT NULL,
  owner_org_id BIGINT NULL,
  registrar_org_id BIGINT NULL,
  status ENUM('reserved','active','expired','redemption','released') NOT NULL,
  created_month INT NOT NULL,
  expires_month INT NOT NULL,
  auth_code VARCHAR(32) NOT NULL,
  privacy TINYINT(1) NOT NULL DEFAULT 0,
  ns_mode ENUM('hosted','custom') NOT NULL DEFAULT 'hosted',
  custom_ns JSON NULL,
  zone_id INT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_domain_live (live_name),
  KEY idx_domain_owner (owner_gov_user_id),
  KEY idx_domain_org (owner_org_id),
  KEY idx_domain_status (status, expires_month)
) ENGINE=InnoDB;

CREATE TABLE domain_orders (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind ENUM('register','renew','transfer','restore','auction') NOT NULL,
  domain_id BIGINT NOT NULL,
  gov_user_id BIGINT NOT NULL,
  registrar_org_id BIGINT NULL,
  years INT NOT NULL DEFAULT 1,
  amount BIGINT NOT NULL,
  invoice_id BIGINT NULL,
  status ENUM('pending','paid','cancelled') NOT NULL DEFAULT 'pending',
  created_month INT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_order_domain (domain_id, status),
  KEY idx_order_user (gov_user_id)
) ENGINE=InnoDB;

CREATE TABLE auctions (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL,
  tld_id INT NOT NULL,
  reason ENUM('premium','released') NOT NULL,
  status ENUM('open','awaiting_payment','done','failed') NOT NULL DEFAULT 'open',
  min_bid BIGINT NOT NULL,
  ends_month INT NOT NULL,
  winner_gov_user_id BIGINT NULL,
  winner_amount BIGINT NULL,
  pay_until_month INT NULL,
  domain_id BIGINT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_auction_status (status, ends_month),
  KEY idx_auction_name (name)
) ENGINE=InnoDB;

CREATE TABLE auction_bids (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  auction_id BIGINT NOT NULL,
  gov_user_id BIGINT NOT NULL,
  amount BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_bid_auction (auction_id, amount)
) ENGINE=InnoDB;

-- DNS-данные доменов игроков (их зоны и делегирования в зонах TLD): по domain_id их убирает сброс игры.
ALTER TABLE dns_zones ADD COLUMN domain_id BIGINT NULL;
ALTER TABLE dns_records ADD COLUMN domain_id BIGINT NULL, ADD INDEX idx_dns_records_domain (domain_id);
