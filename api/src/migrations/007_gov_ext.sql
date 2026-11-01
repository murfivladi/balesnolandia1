-- Этап 8. ВлодУслуги, расширение: налоги и декларации, штрафы и обжалования, неуплата,
-- пособия, имущество и ипотека, врач и страховка, выборы, визы, обращения, новости.

-- Квитанции: срок оплаты в игровых месяцах, накопленные пени, «заморожена» на время обжалования.
ALTER TABLE invoices
  ADD COLUMN due_month INT NULL,
  ADD COLUMN penalty BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN penalty_month INT NULL,
  ADD COLUMN frozen TINYINT(1) NOT NULL DEFAULT 0,
  ADD KEY idx_invoice_due (status, due_month);

-- Статьи штрафов (ведёт админ) и выписанные штрафы.
CREATE TABLE fine_articles (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(16) NOT NULL,
  title VARCHAR(160) NOT NULL,
  amount BIGINT NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO fine_articles (code, title, amount) VALUES
  ('12.9', 'Превышение скорости', 1000),
  ('12.12', 'Проезд на красный свет', 2000),
  ('12.37', 'Езда без водительских прав', 5000),
  ('20.1', 'Мелкое хулиганство', 1500),
  ('20.21', 'Нарушение общественного порядка', 1000),
  ('14.1', 'Торговля без регистрации ИП', 4000),
  ('6.24', 'Курение в неположенном месте', 500);

CREATE TABLE fines (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  citizen_id BIGINT NOT NULL,
  article_id BIGINT NULL,
  article_text VARCHAR(255) NOT NULL,
  amount BIGINT NOT NULL,
  note VARCHAR(255) NULL,
  officer_gov_user_id BIGINT NULL,
  invoice_id BIGINT NULL,
  status ENUM('issued','paid','cancelled') NOT NULL DEFAULT 'issued',
  appeal_text VARCHAR(1000) NULL,
  appeal_status ENUM('pending','accepted','rejected') NULL,
  appeal_note VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  appealed_at DATETIME(3) NULL,
  KEY idx_fine_citizen (citizen_id),
  KEY idx_fine_appeal (appeal_status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Декларации ИП: раз в игровой год, доход заполняется по продажам магазинов.
CREATE TABLE tax_declarations (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  citizen_id BIGINT NOT NULL,
  document_id BIGINT NOT NULL,
  year INT NOT NULL,
  period_from DATETIME(3) NULL,
  period_to DATETIME(3) NOT NULL,
  income_auto BIGINT NOT NULL DEFAULT 0,
  income BIGINT NULL,
  rate_bp INT NOT NULL,
  tax BIGINT NULL,
  status ENUM('draft','submitted','paid','auto') NOT NULL DEFAULT 'draft',
  due_month INT NOT NULL,
  invoice_id BIGINT NULL,
  submitted_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_decl (document_id, year),
  KEY idx_decl_citizen (citizen_id)
) ENGINE=InnoDB;

-- Меры за неуплату: арест счетов в ВлодБанке, запрет выезда, закрытие ИП.
CREATE TABLE citizen_sanctions (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  citizen_id BIGINT NOT NULL,
  kind ENUM('arrest','travel_ban','ip_closed') NOT NULL,
  reason VARCHAR(255) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  data JSON NULL,
  created_by VARCHAR(40) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  lifted_at DATETIME(3) NULL,
  KEY idx_sanction_citizen (citizen_id, active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Пособия из госбюджета.
CREATE TABLE benefits (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  citizen_id BIGINT NOT NULL,
  kind ENUM('child','pension','unemployment') NOT NULL,
  status ENUM('pending','active','rejected','stopped') NOT NULL DEFAULT 'pending',
  months_left INT NULL,
  last_month INT NULL,
  decided_by VARCHAR(40) NULL,
  note VARCHAR(255) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_benefit_status (status),
  KEY idx_benefit_citizen (citizen_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Реестр имущества: авто и недвижимость. Владелец — гражданин или государство (NULL).
CREATE TABLE properties (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind ENUM('car','realty') NOT NULL,
  title VARCHAR(120) NOT NULL,
  reg_number VARCHAR(32) NOT NULL,
  address VARCHAR(200) NULL,
  details VARCHAR(500) NULL,
  photo MEDIUMTEXT NULL,
  value BIGINT NOT NULL,
  owner_citizen_id BIGINT NULL,
  list_price BIGINT NULL,
  lien_loan_id BIGINT NULL,
  status ENUM('active','arrested') NOT NULL DEFAULT 'active',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_property_reg (reg_number),
  KEY idx_property_owner (owner_citizen_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE property_deals (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  property_id BIGINT NOT NULL,
  seller_citizen_id BIGINT NULL,
  buyer_citizen_id BIGINT NOT NULL,
  price BIGINT NOT NULL,
  status ENUM('pending','loan','done','cancelled') NOT NULL DEFAULT 'pending',
  loan_id BIGINT NULL,
  tx_id BIGINT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  closed_at DATETIME(3) NULL,
  KEY idx_deal_buyer (buyer_citizen_id, status),
  KEY idx_deal_property (property_id, status)
) ENGINE=InnoDB;

-- Ипотека и автокредит: кредит под сделку, деньги уходят продавцу, имущество в залоге.
ALTER TABLE loans
  ADD COLUMN deal_id BIGINT NULL,
  ADD COLUMN property_id BIGINT NULL,
  ADD COLUMN down_payment BIGINT NOT NULL DEFAULT 0;

-- Врач: слоты приёма, игровое заключение; страховка даёт доступ к приоритетным слотам.
CREATE TABLE doctor_slots (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  doctor_gov_user_id BIGINT NOT NULL,
  starts_at DATETIME(3) NOT NULL,
  duration_min INT NOT NULL DEFAULT 15,
  priority TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('free','booked','done','cancelled') NOT NULL DEFAULT 'free',
  patient_citizen_id BIGINT NULL,
  insured TINYINT(1) NOT NULL DEFAULT 0,
  complaint VARCHAR(500) NULL,
  conclusion VARCHAR(2000) NULL,
  booked_at DATETIME(3) NULL,
  done_at DATETIME(3) NULL,
  KEY idx_slot_doctor (doctor_gov_user_id, starts_at),
  KEY idx_slot_status (status, starts_at),
  KEY idx_slot_patient (patient_citizen_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE insurance_policies (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  citizen_id BIGINT NOT NULL,
  from_month INT NULL,
  to_month INT NULL,
  price BIGINT NOT NULL,
  invoice_id BIGINT NULL,
  status ENUM('awaiting_payment','active','cancelled') NOT NULL DEFAULT 'awaiting_payment',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_ins_citizen (citizen_id, status)
) ENGINE=InnoDB;

-- Выборы: один паспорт — один голос; тайна голосования — голос не связан с кандидатом.
CREATE TABLE elections (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(160) NOT NULL,
  description VARCHAR(2000) NULL,
  status ENUM('nomination','voting','finished','cancelled') NOT NULL DEFAULT 'nomination',
  created_by VARCHAR(40) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  finished_at DATETIME(3) NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE candidates (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  election_id BIGINT NOT NULL,
  citizen_id BIGINT NOT NULL,
  program VARCHAR(2000) NULL,
  status ENUM('approved','rejected','withdrawn') NOT NULL DEFAULT 'approved',
  votes INT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_candidate (election_id, citizen_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE votes (
  election_id BIGINT NOT NULL,
  citizen_id BIGINT NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (election_id, citizen_id)
) ENGINE=InnoDB;

-- Соседние страны и визы.
CREATE TABLE countries (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(80) NOT NULL,
  code CHAR(3) NOT NULL,
  visa_required TINYINT(1) NOT NULL DEFAULT 1,
  visa_fee BIGINT NOT NULL DEFAULT 0,
  visa_months INT NOT NULL DEFAULT 6,
  active TINYINT(1) NOT NULL DEFAULT 1,
  UNIQUE KEY uq_country_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO countries (name, code, visa_required, visa_fee, visa_months) VALUES
  ('Северная Влодония', 'SVL', 1, 2000, 6),
  ('Республика Остролесье', 'OST', 1, 3000, 12),
  ('Княжество Мирабель', 'MIR', 0, 0, 12);

-- Обращения к властям.
CREATE TABLE appeals (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  gov_user_id BIGINT NOT NULL,
  citizen_id BIGINT NULL,
  addressee ENUM('admin','official','police','tax','doctor') NOT NULL DEFAULT 'official',
  subject VARCHAR(160) NOT NULL,
  body VARCHAR(4000) NOT NULL,
  status ENUM('open','answered','closed') NOT NULL DEFAULT 'open',
  answer VARCHAR(4000) NULL,
  answered_by VARCHAR(40) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  answered_at DATETIME(3) NULL,
  KEY idx_appeal_user (gov_user_id),
  KEY idx_appeal_status (status, addressee)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Новости БФ: указы, законы, итоги выборов.
CREATE TABLE news (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  kind ENUM('news','decree','law','election') NOT NULL DEFAULT 'news',
  title VARCHAR(200) NOT NULL,
  body TEXT NOT NULL,
  pinned TINYINT(1) NOT NULL DEFAULT 0,
  published_by VARCHAR(40) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_news_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
