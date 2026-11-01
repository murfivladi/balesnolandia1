-- Этап 4. Касса: магазины, персонал, товары, смены, продажи, оплаты, возвраты, терминалы.
-- Количество хранится в тысячных долях: 1 шт = 1000, 1 кг = 1000 (то есть граммы).

CREATE TABLE shops (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  owner_id BIGINT NOT NULL,
  name VARCHAR(80) NOT NULL,
  type ENUM('shop','cafe') NOT NULL DEFAULT 'shop',
  color VARCHAR(16) NOT NULL DEFAULT '#0f766e',
  logo MEDIUMTEXT NULL,
  account_id BIGINT NOT NULL,
  inn VARCHAR(32) NOT NULL,
  ip_number VARCHAR(32) NOT NULL,
  address VARCHAR(160) NULL,
  receipt_footer VARCHAR(200) NULL,
  status ENUM('active','closed') NOT NULL DEFAULT 'active',
  next_sale_no INT NOT NULL DEFAULT 1,
  next_shift_no INT NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_shop_owner (owner_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE shop_staff (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id BIGINT NOT NULL,
  bank_user_id BIGINT NOT NULL,
  role ENUM('owner','cashier') NOT NULL DEFAULT 'cashier',
  pin_hash VARCHAR(100) NULL,
  salary BIGINT NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_staff (shop_id, bank_user_id)
) ENGINE=InnoDB;

CREATE TABLE products (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id BIGINT NOT NULL,
  name VARCHAR(120) NOT NULL,
  category VARCHAR(60) NOT NULL DEFAULT '',
  barcode VARCHAR(64) NULL,
  price BIGINT NOT NULL,
  cost BIGINT NOT NULL DEFAULT 0,
  unit ENUM('pcs','kg') NOT NULL DEFAULT 'pcs',
  age_limit TINYINT NOT NULL DEFAULT 0,
  photo MEDIUMTEXT NULL,
  track_stock TINYINT(1) NOT NULL DEFAULT 1,
  stock_milli BIGINT NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  sort INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_product_shop (shop_id, active),
  KEY idx_product_barcode (shop_id, barcode)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE stock_moves (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT NOT NULL,
  qty_milli BIGINT NOT NULL,
  reason ENUM('manual','sale','refund','purchase','writeoff') NOT NULL,
  ref_id BIGINT NULL,
  staff_id BIGINT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_stock_product (product_id, id)
) ENGINE=InnoDB;

CREATE TABLE shifts (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id BIGINT NOT NULL,
  staff_id BIGINT NOT NULL,
  number INT NOT NULL,
  status ENUM('open','closed') NOT NULL DEFAULT 'open',
  opening_float BIGINT NOT NULL DEFAULT 0,
  cash_collected BIGINT NOT NULL DEFAULT 0,
  closing_cash BIGINT NULL,
  z_report JSON NULL,
  opened_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  closed_at DATETIME(3) NULL,
  UNIQUE KEY uq_shift_number (shop_id, number),
  KEY idx_shift_status (shop_id, status)
) ENGINE=InnoDB;

CREATE TABLE sales (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id BIGINT NOT NULL,
  shift_id BIGINT NULL,
  staff_id BIGINT NOT NULL,
  number INT NULL,
  status ENUM('open','held','paid','cancelled') NOT NULL DEFAULT 'open',
  subtotal BIGINT NOT NULL DEFAULT 0,
  discount BIGINT NOT NULL DEFAULT 0,
  total BIGINT NOT NULL DEFAULT 0,
  vat BIGINT NOT NULL DEFAULT 0,
  vat_bp INT NOT NULL DEFAULT 0,
  tip BIGINT NOT NULL DEFAULT 0,
  tip_pct TINYINT NOT NULL DEFAULT 0,
  paid BIGINT NOT NULL DEFAULT 0,
  refunded BIGINT NOT NULL DEFAULT 0,
  age_checked VARCHAR(16) NULL,
  hold_label VARCHAR(60) NULL,
  verify_code VARCHAR(32) NULL,
  customer_user_id BIGINT NULL,
  receipt_email VARCHAR(190) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  paid_at DATETIME(3) NULL,
  UNIQUE KEY uq_sale_number (shop_id, number),
  UNIQUE KEY uq_sale_verify (verify_code),
  KEY idx_sale_shift (shift_id),
  KEY idx_sale_status (shop_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sale_items (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  sale_id BIGINT NOT NULL,
  product_id BIGINT NULL,
  name VARCHAR(120) NOT NULL,
  unit ENUM('pcs','kg') NOT NULL DEFAULT 'pcs',
  qty_milli BIGINT NOT NULL,
  price BIGINT NOT NULL,
  discount BIGINT NOT NULL DEFAULT 0,
  total BIGINT NOT NULL,
  vat BIGINT NOT NULL DEFAULT 0,
  age_limit TINYINT NOT NULL DEFAULT 0,
  refunded_milli BIGINT NOT NULL DEFAULT 0,
  KEY idx_item_sale (sale_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE sale_payments (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  sale_id BIGINT NOT NULL,
  method ENUM('cash','card','qr') NOT NULL,
  amount BIGINT NOT NULL,
  tip BIGINT NOT NULL DEFAULT 0,
  cash_given BIGINT NULL,
  change_given BIGINT NULL,
  card_id BIGINT NULL,
  payer_account_id BIGINT NULL,
  tx_id BIGINT NULL,
  refunded BIGINT NOT NULL DEFAULT 0,
  idem_key VARCHAR(100) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_payment_idem (idem_key),
  KEY idx_payment_sale (sale_id)
) ENGINE=InnoDB;

CREATE TABLE refunds (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  sale_id BIGINT NOT NULL,
  shift_id BIGINT NULL,
  staff_id BIGINT NOT NULL,
  amount BIGINT NOT NULL,
  method ENUM('cash','card','qr') NOT NULL,
  items JSON NOT NULL,
  tx_id BIGINT NULL,
  reason VARCHAR(160) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_refund_sale (sale_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Журнал действий кассира: удаления из чека, скидки, открытие ящика, возвраты.
CREATE TABLE pos_log (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id BIGINT NOT NULL,
  staff_id BIGINT NULL,
  shift_id BIGINT NULL,
  action VARCHAR(32) NOT NULL,
  sale_id BIGINT NULL,
  data JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_poslog_shop (shop_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Сопряжение касса ↔ терминал покупателя по 6-значному коду.
CREATE TABLE terminals (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id BIGINT NOT NULL,
  staff_id BIGINT NOT NULL,
  code CHAR(6) NOT NULL,
  status ENUM('waiting','paired','closed') NOT NULL DEFAULT 'waiting',
  pending JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  last_seen_at DATETIME(3) NULL,
  UNIQUE KEY uq_terminal_code (code)
) ENGINE=InnoDB;
