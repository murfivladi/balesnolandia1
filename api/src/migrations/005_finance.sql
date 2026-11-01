-- Этап 6. Игровое время и финансы: кредитные, детские и подарочные карты, кредиты,
-- автоплатежи, кешбэк, антифрод, инфляция.

-- Новые виды счетов: кредитный (карта с лимитом), ссудный (долг по кредиту),
-- детский (счёт детской карты родителя), подарочный (баланс подарочной карты).
ALTER TABLE accounts MODIFY type ENUM('current','savings','term','business','system','credit','loan','child','gift') NOT NULL;

-- Разрешённый минус по счёту: лимит кредитной карты или сумма кредита.
ALTER TABLE accounts ADD COLUMN credit_limit BIGINT NOT NULL DEFAULT 0 AFTER allow_negative;

-- Кредитный рейтинг клиента: 0…1000, старт 500.
ALTER TABLE bank_users ADD COLUMN credit_score INT NOT NULL DEFAULT 500;

-- Держатель карты, если это не владелец счёта (детская карта ребёнка с аккаунтом в банке).
ALTER TABLE cards ADD COLUMN holder_user_id BIGINT NULL AFTER bank_user_id, ADD KEY idx_card_holder (holder_user_id);

-- Кредитные карты: заявка на лимит → решение админа → счёт и карта.
CREATE TABLE credit_lines (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bank_user_id BIGINT NOT NULL,
  account_id BIGINT NULL,
  card_id BIGINT NULL,
  limit_requested BIGINT NOT NULL,
  limit_approved BIGINT NULL,
  pin_hash VARCHAR(100) NULL,
  background VARCHAR(32) NOT NULL DEFAULT 'classic',
  status ENUM('pending','active','rejected','closed') NOT NULL DEFAULT 'pending',
  autorepay TINYINT(1) NOT NULL DEFAULT 1,
  debt_since_month INT NULL,
  statement_debt BIGINT NOT NULL DEFAULT 0,
  statement_month INT NULL,
  statement_entry_id BIGINT NOT NULL DEFAULT 0,
  overdue_count INT NOT NULL DEFAULT 0,
  decided_by VARCHAR(40) NULL,
  decision_note VARCHAR(200) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  decided_at DATETIME(3) NULL,
  KEY idx_cl_user (bank_user_id),
  KEY idx_cl_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Кредиты: аннуитетный график, автосписание каждый игровой месяц.
CREATE TABLE loans (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bank_user_id BIGINT NOT NULL,
  kind VARCHAR(16) NOT NULL DEFAULT 'consumer',
  purpose VARCHAR(140) NULL,
  amount_requested BIGINT NOT NULL,
  months_requested INT NOT NULL,
  amount BIGINT NULL,
  months INT NULL,
  rate_bp INT NULL,
  payment BIGINT NULL,
  loan_account_id BIGINT NULL,
  pay_account_id BIGINT NULL,
  status ENUM('pending','active','rejected','repaid','cancelled') NOT NULL DEFAULT 'pending',
  issued_month INT NULL,
  decided_by VARCHAR(40) NULL,
  decision_note VARCHAR(200) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  decided_at DATETIME(3) NULL,
  closed_at DATETIME(3) NULL,
  KEY idx_loan_user (bank_user_id),
  KEY idx_loan_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE loan_schedule (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  loan_id BIGINT NOT NULL,
  n INT NOT NULL,
  due_month INT NOT NULL,
  principal BIGINT NOT NULL,
  interest BIGINT NOT NULL,
  penalty BIGINT NOT NULL DEFAULT 0,
  penalty_month INT NULL,
  status ENUM('planned','overdue','paid','cancelled') NOT NULL DEFAULT 'planned',
  tx_id BIGINT NULL,
  paid_at DATETIME(3) NULL,
  UNIQUE KEY uq_ls (loan_id, n),
  KEY idx_ls_due (status, due_month)
) ENGINE=InnoDB;

-- Автоплатежи и подписки: перевод каждый игровой месяц. Карманные деньги — тоже автоплатёж.
CREATE TABLE autopayments (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bank_user_id BIGINT NOT NULL,
  kind ENUM('transfer','subscription','pocket') NOT NULL DEFAULT 'transfer',
  title VARCHAR(80) NOT NULL,
  from_account_id BIGINT NOT NULL,
  to_account_id BIGINT NOT NULL,
  amount BIGINT NOT NULL,
  remaining INT NULL,
  status ENUM('active','paused','finished','cancelled') NOT NULL DEFAULT 'active',
  next_month INT NOT NULL,
  last_month INT NULL,
  last_error VARCHAR(200) NULL,
  fails INT NOT NULL DEFAULT 0,
  card_id BIGINT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_ap_user (bank_user_id),
  KEY idx_ap_due (status, next_month)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Кешбэк: категории (ведёт админ), выбор клиента на игровой месяц, начисления.
CREATE TABLE cashback_categories (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(60) NOT NULL,
  rate_bp INT NOT NULL DEFAULT 0,
  active TINYINT(1) NOT NULL DEFAULT 1,
  sort INT NOT NULL DEFAULT 0
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO cashback_categories (name, rate_bp, sort) VALUES
  ('Продукты', 300, 1),
  ('Кафе и рестораны', 500, 2),
  ('Одежда и обувь', 400, 3),
  ('Развлечения', 500, 4),
  ('Услуги', 200, 5),
  ('Прочее', 100, 6);

ALTER TABLE shops ADD COLUMN cashback_category_id BIGINT NULL;

UPDATE shops SET cashback_category_id = (SELECT id FROM cashback_categories WHERE name = IF(shops.type = 'cafe', 'Кафе и рестораны', 'Продукты') LIMIT 1);

CREATE TABLE cashback_choices (
  bank_user_id BIGINT NOT NULL,
  month INT NOT NULL,
  category_id BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (bank_user_id, month, category_id)
) ENGINE=InnoDB;

CREATE TABLE cashback_accruals (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bank_user_id BIGINT NOT NULL,
  month INT NOT NULL,
  category_id BIGINT NOT NULL,
  sale_id BIGINT NULL,
  amount BIGINT NOT NULL,
  paid_tx_id BIGINT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_cba_user (bank_user_id, month),
  KEY idx_cba_sale (sale_id)
) ENGINE=InnoDB;

-- Антифрод: переводы держатся до решения админа, крупные оплаты картой — на проверку после.
CREATE TABLE fraud_queue (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  bank_user_id BIGINT NOT NULL,
  kind VARCHAR(24) NOT NULL,
  mode ENUM('hold','review') NOT NULL,
  amount BIGINT NOT NULL,
  reason VARCHAR(200) NOT NULL,
  data JSON NULL,
  tx_id BIGINT NULL,
  status ENUM('pending','approved','rejected','failed') NOT NULL DEFAULT 'pending',
  decided_by VARCHAR(40) NULL,
  note VARCHAR(200) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  decided_at DATETIME(3) NULL,
  KEY idx_fraud_status (status, id),
  KEY idx_fraud_user (bank_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Инфляция: ставка и накопленный индекс цен (1 000 000 = 1,0) по игровым месяцам.
-- Оптовые цены (этап 7) умножаются на этот индекс.
CREATE TABLE price_index (
  month INT NOT NULL PRIMARY KEY,
  rate_bp INT NOT NULL,
  index_ppm BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

INSERT INTO price_index (month, rate_bp, index_ppm) VALUES (0, 0, 1000000);
