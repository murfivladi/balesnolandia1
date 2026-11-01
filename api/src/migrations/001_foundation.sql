-- Этап 1. Фундамент: настройки, игровое время, журнал, уведомления, коды, роли, проводки.

CREATE TABLE settings (
  k VARCHAR(64) NOT NULL PRIMARY KEY,
  v JSON NOT NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE game_clock (
  id TINYINT NOT NULL PRIMARY KEY,
  month_index INT NOT NULL DEFAULT 0,
  last_tick_at DATETIME(3) NOT NULL,
  paused TINYINT(1) NOT NULL DEFAULT 0
) ENGINE=InnoDB;

INSERT INTO game_clock (id, month_index, last_tick_at, paused) VALUES (1, 0, CURRENT_TIMESTAMP(3), 0);

CREATE TABLE audit_log (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  actor_kind VARCHAR(16) NULL,
  actor_id BIGINT NULL,
  action VARCHAR(64) NOT NULL,
  entity VARCHAR(32) NULL,
  entity_id BIGINT NULL,
  data JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_audit_entity (entity, entity_id),
  KEY idx_audit_actor (actor_kind, actor_id),
  KEY idx_audit_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notifications (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_kind ENUM('bank','gov') NOT NULL,
  user_id BIGINT NOT NULL,
  title VARCHAR(200) NOT NULL,
  body TEXT NULL,
  link VARCHAR(255) NULL,
  read_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_notif_user (user_kind, user_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE push_subscriptions (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_kind ENUM('bank','gov') NOT NULL,
  user_id BIGINT NOT NULL,
  endpoint VARCHAR(500) NOT NULL,
  p256dh VARCHAR(200) NOT NULL,
  auth VARCHAR(100) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_push_endpoint (endpoint(255)),
  KEY idx_push_user (user_kind, user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE email_codes (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  user_kind ENUM('bank','gov') NOT NULL,
  email VARCHAR(190) NOT NULL,
  code_hash VARCHAR(100) NOT NULL,
  attempts INT NOT NULL DEFAULT 0,
  expires_at DATETIME(3) NOT NULL,
  used_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_codes_email (user_kind, email, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE user_roles (
  user_kind ENUM('bank','gov') NOT NULL,
  user_id BIGINT NOT NULL,
  role VARCHAR(16) NOT NULL,
  granted_by VARCHAR(40) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (user_kind, user_id, role)
) ENGINE=InnoDB;

-- Аккаунты ВлодУслуг и ВлодБанка — раздельные.
CREATE TABLE gov_users (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(190) NOT NULL,
  password_hash VARCHAR(100) NULL,
  display_name VARCHAR(120) NOT NULL,
  status ENUM('active','blocked') NOT NULL DEFAULT 'active',
  lang CHAR(2) NOT NULL DEFAULT 'ru',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NULL,
  UNIQUE KEY uq_gov_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE bank_users (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(190) NOT NULL,
  password_hash VARCHAR(100) NULL,
  full_name VARCHAR(120) NOT NULL,
  birth_date DATE NULL,
  passport_no VARCHAR(16) NULL,
  passport_verified TINYINT(1) NOT NULL DEFAULT 0,
  gov_user_id BIGINT NULL,
  status ENUM('pending','active','blocked','rejected') NOT NULL DEFAULT 'pending',
  start_bonus_paid TINYINT(1) NOT NULL DEFAULT 0,
  lang CHAR(2) NOT NULL DEFAULT 'ru',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NULL,
  UNIQUE KEY uq_bank_email (email),
  KEY idx_bank_passport (passport_no),
  KEY idx_bank_name (full_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Счета: клиентские, бизнес и служебные (Эмиссия, Казна, Госбюджет, Наличные).
CREATE TABLE accounts (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  number VARCHAR(20) NOT NULL,
  owner_kind ENUM('bank_user','system') NOT NULL,
  owner_id BIGINT NULL,
  type ENUM('current','savings','term','business','system') NOT NULL,
  name VARCHAR(80) NOT NULL,
  balance BIGINT NOT NULL DEFAULT 0,
  status ENUM('active','frozen','arrested','closed') NOT NULL DEFAULT 'active',
  allow_negative TINYINT(1) NOT NULL DEFAULT 0,
  system_code VARCHAR(32) NULL,
  rate_bp INT NOT NULL DEFAULT 0,
  compound TINYINT(1) NOT NULL DEFAULT 0,
  term_months INT NULL,
  opened_month INT NOT NULL DEFAULT 0,
  matures_month INT NULL,
  is_primary TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  closed_at DATETIME(3) NULL,
  UNIQUE KEY uq_acc_number (number),
  UNIQUE KEY uq_acc_system (system_code),
  KEY idx_acc_owner (owner_kind, owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ledger_tx (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind VARCHAR(32) NOT NULL,
  memo VARCHAR(255) NULL,
  idem_key VARCHAR(100) NULL,
  actor_kind VARCHAR(16) NULL,
  actor_id BIGINT NULL,
  ref_type VARCHAR(32) NULL,
  ref_id BIGINT NULL,
  reversal_of BIGINT NULL,
  reversed_by BIGINT NULL,
  meta JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_tx_idem (idem_key),
  KEY idx_tx_kind (kind, id),
  KEY idx_tx_ref (ref_type, ref_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE ledger_entries (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  tx_id BIGINT NOT NULL,
  account_id BIGINT NOT NULL,
  amount BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  KEY idx_le_account (account_id, id),
  KEY idx_le_tx (tx_id),
  CONSTRAINT fk_le_tx FOREIGN KEY (tx_id) REFERENCES ledger_tx(id),
  CONSTRAINT fk_le_acc FOREIGN KEY (account_id) REFERENCES accounts(id)
) ENGINE=InnoDB;

INSERT INTO accounts (number, owner_kind, type, name, allow_negative, system_code) VALUES
  ('BF00000000000001', 'system', 'system', 'Эмиссия', 1, 'EMISSION'),
  ('BF00000000000002', 'system', 'system', 'Казна ВлодБанка', 1, 'TREASURY'),
  ('BF00000000000003', 'system', 'system', 'Госбюджет БФ', 1, 'BUDGET'),
  ('BF00000000000004', 'system', 'system', 'Наличные в обороте', 1, 'CASH');
