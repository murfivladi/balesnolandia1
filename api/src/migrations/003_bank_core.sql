-- Этап 3. ВлодБанк: карты, QR-платежи.

CREATE TABLE cards (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  account_id BIGINT NOT NULL,
  bank_user_id BIGINT NOT NULL,
  number CHAR(12) NOT NULL,
  exp_month INT NOT NULL,
  pin_hash VARCHAR(100) NOT NULL,
  type ENUM('debit','credit','child','gift') NOT NULL DEFAULT 'debit',
  status ENUM('active','frozen','blocked','expired','reissued') NOT NULL DEFAULT 'active',
  holder_name VARCHAR(60) NOT NULL,
  pin_fail INT NOT NULL DEFAULT 0,
  locked_until DATETIME(3) NULL,
  limit_tx BIGINT NULL,
  limit_daily BIGINT NULL,
  background VARCHAR(32) NOT NULL DEFAULT 'classic',
  issued_by VARCHAR(40) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_card_number (number),
  KEY idx_card_user (bank_user_id),
  KEY idx_card_account (account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Одноразовые QR для оплаты из приложения банка (касса, терминал, переводы).
CREATE TABLE qr_payments (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  token VARCHAR(40) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  ref_id BIGINT NULL,
  amount BIGINT NOT NULL,
  title VARCHAR(160) NOT NULL,
  status ENUM('pending','paid','cancelled','expired') NOT NULL DEFAULT 'pending',
  payer_user_id BIGINT NULL,
  tx_id BIGINT NULL,
  expires_at DATETIME(3) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_qr_token (token)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Операции по карте: для дневных лимитов и истории карты.
ALTER TABLE ledger_tx ADD COLUMN card_id BIGINT NULL, ADD KEY idx_tx_card (card_id, created_at);
