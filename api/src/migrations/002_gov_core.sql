-- Этап 2. ВлодУслуги: граждане, паспорт БФ, документы (ИНН, ИП), заявления, квитанции.

CREATE TABLE citizens (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  gov_user_id BIGINT NOT NULL,
  full_name VARCHAR(120) NOT NULL,
  birth_date DATE NOT NULL,
  passport_no VARCHAR(16) NULL,
  photo MEDIUMTEXT NULL,
  address VARCHAR(255) NULL,
  marital_status ENUM('single','married','divorced','widowed') NOT NULL DEFAULT 'single',
  spouse_name VARCHAR(120) NULL,
  children JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_citizen_user (gov_user_id),
  UNIQUE KEY uq_citizen_passport (passport_no),
  KEY idx_citizen_name (full_name)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE passports (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  citizen_id BIGINT NOT NULL,
  number VARCHAR(16) NOT NULL,
  status ENUM('active','revoked','replaced') NOT NULL DEFAULT 'active',
  verify_code VARCHAR(32) NOT NULL,
  issued_month INT NOT NULL,
  expires_month INT NULL,
  issued_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_passport_number (number),
  UNIQUE KEY uq_passport_verify (verify_code),
  KEY idx_passport_citizen (citizen_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE documents (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  citizen_id BIGINT NOT NULL,
  type ENUM('inn','ip','driver','marriage','birth','foreign_passport','visa') NOT NULL,
  number VARCHAR(32) NOT NULL,
  status ENUM('active','revoked','expired','closed') NOT NULL DEFAULT 'active',
  data JSON NULL,
  verify_code VARCHAR(32) NOT NULL,
  issued_month INT NOT NULL,
  expires_month INT NULL,
  issued_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_doc_number (type, number),
  UNIQUE KEY uq_doc_verify (verify_code),
  KEY idx_doc_citizen (citizen_id, type)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE applications (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  citizen_id BIGINT NULL,
  gov_user_id BIGINT NOT NULL,
  type VARCHAR(32) NOT NULL,
  status ENUM('pending','awaiting_payment','approved','rejected','cancelled') NOT NULL DEFAULT 'pending',
  data JSON NULL,
  invoice_id BIGINT NULL,
  result_ref VARCHAR(64) NULL,
  comment VARCHAR(255) NULL,
  decided_by VARCHAR(40) NULL,
  decided_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_app_status (status, id),
  KEY idx_app_user (gov_user_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Квитанции: госпошлины, штрафы, налоги. Оплата через ВлодБанк или наличными на кассе.
CREATE TABLE invoices (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  number VARCHAR(20) NOT NULL,
  citizen_id BIGINT NULL,
  gov_user_id BIGINT NULL,
  kind ENUM('fee','fine','tax','other') NOT NULL,
  purpose VARCHAR(255) NOT NULL,
  amount BIGINT NOT NULL,
  status ENUM('unpaid','paid','cancelled') NOT NULL DEFAULT 'unpaid',
  ref_type VARCHAR(32) NULL,
  ref_id BIGINT NULL,
  paid_tx_id BIGINT NULL,
  paid_via ENUM('bank','cash') NULL,
  paid_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_invoice_number (number),
  KEY idx_invoice_citizen (citizen_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Связка аккаунта ВлодБанка с паспортом: гражданин подтверждает во ВлодУслугах.
CREATE TABLE passport_links (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bank_user_id BIGINT NOT NULL,
  citizen_id BIGINT NOT NULL,
  status ENUM('pending','confirmed','rejected') NOT NULL DEFAULT 'pending',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  decided_at DATETIME(3) NULL,
  KEY idx_link_citizen (citizen_id, status),
  KEY idx_link_bank (bank_user_id)
) ENGINE=InnoDB;
