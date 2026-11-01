-- Этап 7. Касса, расширение: склад и закупки, скидки и лояльность, варианты и добавки,
-- долги, столики, кухня и очередь, киоск, отчёты.

-- Оптовая база админа: цена = базовая цена × индекс цен (инфляция).
INSERT INTO accounts (number, owner_kind, type, name, allow_negative, system_code) VALUES
  ('BF00000000000005', 'system', 'system', 'Оптовая база БФ', 1, 'WHOLESALE');

CREATE TABLE wholesale_items (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(120) NOT NULL,
  category VARCHAR(60) NOT NULL DEFAULT '',
  unit ENUM('pcs','kg') NOT NULL DEFAULT 'pcs',
  base_price BIGINT NOT NULL,
  barcode VARCHAR(64) NULL,
  photo MEDIUMTEXT NULL,
  age_limit TINYINT NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  sort INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO wholesale_items (name, category, unit, base_price, sort) VALUES
  ('Хлеб', 'Продукты', 'pcs', 150, 1),
  ('Молоко 1 л', 'Продукты', 'pcs', 250, 2),
  ('Яблоки', 'Овощи и фрукты', 'kg', 300, 3),
  ('Кофе в зёрнах', 'Кафе', 'kg', 4000, 4),
  ('Сахар', 'Продукты', 'kg', 200, 5),
  ('Вода 0,5 л', 'Напитки', 'pcs', 100, 6);

-- Товар магазина: цена для других магазинов (оптом), отправка на кухню.
ALTER TABLE products
  ADD COLUMN b2b_price BIGINT NULL AFTER cost,
  ADD COLUMN to_kitchen TINYINT(1) NOT NULL DEFAULT 0 AFTER track_stock,
  ADD COLUMN wholesale_item_id BIGINT NULL;

CREATE TABLE product_variants (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT NOT NULL,
  name VARCHAR(60) NOT NULL,
  price_delta BIGINT NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  sort INT NOT NULL DEFAULT 0,
  KEY idx_variant_product (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE modifiers (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  product_id BIGINT NOT NULL,
  name VARCHAR(60) NOT NULL,
  price BIGINT NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  sort INT NOT NULL DEFAULT 0,
  KEY idx_modifier_product (product_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE sale_items
  ADD COLUMN variant_id BIGINT NULL,
  ADD COLUMN modifiers JSON NULL,
  ADD COLUMN promo_discount BIGINT NOT NULL DEFAULT 0;

ALTER TABLE stock_moves MODIFY reason ENUM('manual','sale','refund','purchase','writeoff','supply') NOT NULL;

-- Закупки: у оптовой базы (сразу) или у другого магазина (заказ → продавец подтверждает).
CREATE TABLE purchases (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id BIGINT NOT NULL,
  source ENUM('wholesale','shop') NOT NULL,
  seller_shop_id BIGINT NULL,
  status ENUM('pending','done','rejected','cancelled') NOT NULL DEFAULT 'pending',
  items JSON NOT NULL,
  total BIGINT NOT NULL,
  tx_id BIGINT NULL,
  staff_id BIGINT NULL,
  note VARCHAR(200) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  decided_at DATETIME(3) NULL,
  KEY idx_purchase_shop (shop_id, id),
  KEY idx_purchase_seller (seller_shop_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Акции и промокоды. kind: percent — % от чека или товара; amount — сумма от чека;
-- qty — % на товар от N штук. Без кода — применяется сама.
CREATE TABLE promos (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id BIGINT NOT NULL,
  title VARCHAR(80) NOT NULL,
  kind ENUM('percent','amount','qty') NOT NULL,
  code VARCHAR(32) NULL,
  value BIGINT NOT NULL,
  product_id BIGINT NULL,
  min_qty INT NOT NULL DEFAULT 0,
  min_total BIGINT NOT NULL DEFAULT 0,
  max_uses INT NULL,
  used INT NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_promo_shop (shop_id, active),
  UNIQUE KEY uq_promo_code (shop_id, code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Лояльность: баллы магазина у клиента ВлодБанка (1 балл = 1 влодинка скидки).
ALTER TABLE shops
  ADD COLUMN loyalty_bp INT NOT NULL DEFAULT 0,
  ADD COLUMN loyalty_max_bp INT NOT NULL DEFAULT 5000,
  ADD COLUMN kitchen_enabled TINYINT(1) NOT NULL DEFAULT 0,
  ADD COLUMN next_queue_no INT NOT NULL DEFAULT 1;

UPDATE shops SET kitchen_enabled = 1 WHERE type = 'cafe';

CREATE TABLE loyalty_points (
  shop_id BIGINT NOT NULL,
  bank_user_id BIGINT NOT NULL,
  points BIGINT NOT NULL DEFAULT 0,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (shop_id, bank_user_id)
) ENGINE=InnoDB;

CREATE TABLE loyalty_moves (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id BIGINT NOT NULL,
  bank_user_id BIGINT NOT NULL,
  sale_id BIGINT NULL,
  points BIGINT NOT NULL,
  reason ENUM('earn','redeem','refund','restore') NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_lm_user (shop_id, bank_user_id, id),
  KEY idx_lm_sale (sale_id)
) ENGINE=InnoDB;

ALTER TABLE sales
  ADD COLUMN promo_discount BIGINT NOT NULL DEFAULT 0 AFTER discount,
  ADD COLUMN manual_discount BIGINT NOT NULL DEFAULT 0 AFTER promo_discount,
  ADD COLUMN points_used BIGINT NOT NULL DEFAULT 0 AFTER manual_discount,
  ADD COLUMN points_earned BIGINT NOT NULL DEFAULT 0 AFTER points_used,
  ADD COLUMN promo_code VARCHAR(32) NULL,
  ADD COLUMN loyalty_user_id BIGINT NULL,
  ADD COLUMN table_id BIGINT NULL,
  ADD COLUMN source ENUM('pos','kiosk','tab') NOT NULL DEFAULT 'pos',
  ADD COLUMN queue_no INT NULL,
  ADD KEY idx_sale_table (shop_id, table_id, status);

ALTER TABLE sale_payments MODIFY method ENUM('cash','card','qr','debt') NOT NULL;
ALTER TABLE sale_payments ADD COLUMN debt_id BIGINT NULL;
ALTER TABLE refunds MODIFY method ENUM('cash','card','qr','debt') NOT NULL;

-- Долги: «тетрадь долгов» магазина. Если покупатель — клиент ВлодБанка, долг виден
-- ему в банке и гасится переводом; иначе — на кассе наличными или картой.
CREATE TABLE debts (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id BIGINT NOT NULL,
  sale_id BIGINT NULL,
  customer_name VARCHAR(120) NOT NULL,
  bank_user_id BIGINT NULL,
  amount BIGINT NOT NULL,
  paid BIGINT NOT NULL DEFAULT 0,
  status ENUM('open','paid','written_off') NOT NULL DEFAULT 'open',
  note VARCHAR(200) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  paid_at DATETIME(3) NULL,
  KEY idx_debt_shop (shop_id, status),
  KEY idx_debt_user (bank_user_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Столики кафе: открытый счёт стола — отложенный чек с table_id.
CREATE TABLE shop_tables (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id BIGINT NOT NULL,
  name VARCHAR(40) NOT NULL,
  seats INT NOT NULL DEFAULT 4,
  active TINYINT(1) NOT NULL DEFAULT 1,
  sort INT NOT NULL DEFAULT 0,
  KEY idx_table_shop (shop_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Кухня и очередь: «новый → готовится → готов → выдан».
CREATE TABLE kitchen_orders (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  shop_id BIGINT NOT NULL,
  sale_id BIGINT NULL,
  queue_no INT NOT NULL,
  label VARCHAR(60) NULL,
  items JSON NOT NULL,
  status ENUM('new','cooking','ready','done','cancelled') NOT NULL DEFAULT 'new',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  KEY idx_kitchen_shop (shop_id, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Позиции открытого счёта стола, уже отправленные на кухню.
ALTER TABLE sale_items ADD COLUMN sent_to_kitchen TINYINT(1) NOT NULL DEFAULT 0;
