-- Этап Н6: ВлодПоиск. Краулер и индекс страниц, ссылочный граф (PageRank), картинки, robots.txt,
-- журнал запросов (подсказки, тренды, статистика вебмастера), кабинет вебмастера, реклама и рекламная сеть,
-- Safe Browsing. Время в игровых секундах.

CREATE TABLE search_pages (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  url VARCHAR(600) NOT NULL,
  url_hash CHAR(64) NOT NULL,
  host VARCHAR(253) NOT NULL,
  kind ENUM('web','article','gov') NOT NULL DEFAULT 'web',
  status ENUM('queued','indexed','excluded','error','redirect','gone') NOT NULL DEFAULT 'queued',
  http_status SMALLINT NULL,
  reason VARCHAR(255) NULL,
  title VARCHAR(300) NULL,
  description VARCHAR(500) NULL,
  headings TEXT NULL,
  body MEDIUMTEXT NULL,
  lang VARCHAR(16) NULL,
  content_hash CHAR(64) NULL,
  published VARCHAR(40) NULL,
  canonical VARCHAR(600) NULL,
  redirect_to VARCHAR(600) NULL,
  source VARCHAR(16) NOT NULL DEFAULT 'link',
  first_seen BIGINT NOT NULL DEFAULT 0,
  fetched_at BIGINT NULL,
  changed_at BIGINT NULL,
  next_fetch BIGINT NOT NULL DEFAULT 0,
  crawl_interval BIGINT NOT NULL DEFAULT 86400,
  priority INT NOT NULL DEFAULT 0,
  fails INT NOT NULL DEFAULT 0,
  pagerank DOUBLE NOT NULL DEFAULT 0,
  inlinks INT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_search_url (url_hash),
  KEY idx_search_host (host),
  KEY idx_search_due (next_fetch, priority)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE search_links (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  from_id BIGINT NOT NULL,
  to_hash CHAR(64) NOT NULL,
  to_host VARCHAR(253) NOT NULL,
  anchor VARCHAR(200) NOT NULL DEFAULT '',
  nofollow TINYINT(1) NOT NULL DEFAULT 0,
  KEY idx_link_from (from_id),
  KEY idx_link_to (to_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE search_images (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  page_id BIGINT NOT NULL,
  src VARCHAR(600) NOT NULL,
  alt VARCHAR(300) NOT NULL DEFAULT '',
  KEY idx_img_page (page_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE search_robots (
  host VARCHAR(253) NOT NULL PRIMARY KEY,
  fetched_at BIGINT NOT NULL,
  status SMALLINT NOT NULL,
  body TEXT NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE search_queries (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  q VARCHAR(200) NOT NULL,
  qnorm VARCHAR(200) NOT NULL,
  vertical VARCHAR(16) NOT NULL DEFAULT 'web',
  client CHAR(16) NOT NULL DEFAULT '',
  at BIGINT NOT NULL,
  results INT NOT NULL DEFAULT 0,
  KEY idx_q_norm (qnorm),
  KEY idx_q_at (at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Показы и клики сайта в выдаче по дням: «Запросы» в кабинете вебмастера.
CREATE TABLE search_stats (
  host VARCHAR(253) NOT NULL,
  day INT NOT NULL,
  qnorm VARCHAR(200) NOT NULL,
  impressions INT NOT NULL DEFAULT 0,
  clicks INT NOT NULL DEFAULT 0,
  pos_sum INT NOT NULL DEFAULT 0,
  PRIMARY KEY (host, day, qnorm)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE search_sites (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  gov_user_id BIGINT NOT NULL,
  host VARCHAR(253) NOT NULL,
  token VARCHAR(64) NOT NULL,
  verified_at BIGINT NULL,
  method VARCHAR(8) NULL,
  recrawl_day INT NOT NULL DEFAULT -1,
  recrawl_used INT NOT NULL DEFAULT 0,
  adnet TINYINT(1) NOT NULL DEFAULT 0,
  earned_unpaid BIGINT NOT NULL DEFAULT 0,
  earned_total BIGINT NOT NULL DEFAULT 0,
  sitemaps JSON NULL,
  review_requested TINYINT(1) NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_wm_site (gov_user_id, host),
  KEY idx_wm_host (host)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Реклама: предоплаченный баланс рекламодателя лежит на системном счёте ADS.
INSERT INTO accounts (number, owner_kind, type, name, allow_negative, system_code) VALUES
  ('BF00000000000006', 'system', 'system', 'Рекламные балансы ВлодПоиска', 1, 'ADS');

CREATE TABLE search_ad_accounts (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  gov_user_id BIGINT NOT NULL,
  balance BIGINT NOT NULL DEFAULT 0,
  spent_total BIGINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_ad_account (gov_user_id)
) ENGINE=InnoDB;

CREATE TABLE search_ad_topups (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ad_account_id BIGINT NOT NULL,
  amount BIGINT NOT NULL,
  invoice VARCHAR(32) NULL,
  status ENUM('pending','paid') NOT NULL DEFAULT 'pending',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_topup_acc (ad_account_id)
) ENGINE=InnoDB;

CREATE TABLE search_campaigns (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ad_account_id BIGINT NOT NULL,
  name VARCHAR(80) NOT NULL,
  title VARCHAR(60) NOT NULL,
  text VARCHAR(150) NOT NULL,
  url VARCHAR(600) NOT NULL,
  keywords JSON NOT NULL,
  negatives JSON NULL,
  bid BIGINT NOT NULL,
  daily_budget BIGINT NOT NULL,
  network TINYINT(1) NOT NULL DEFAULT 1,
  status ENUM('active','paused','rejected','deleted') NOT NULL DEFAULT 'active',
  reject_reason VARCHAR(200) NULL,
  impressions BIGINT NOT NULL DEFAULT 0,
  clicks BIGINT NOT NULL DEFAULT 0,
  spent BIGINT NOT NULL DEFAULT 0,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_camp_acc (ad_account_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Показ объявления. price — цена клика по итогам аукциона (второй цены); клик проставляет clicked и cost.
CREATE TABLE search_ad_impressions (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  token CHAR(24) NOT NULL,
  campaign_id BIGINT NOT NULL,
  placement ENUM('serp','network','newtab') NOT NULL,
  at BIGINT NOT NULL,
  day INT NOT NULL,
  keyword VARCHAR(100) NULL,
  site_id BIGINT NULL,
  host VARCHAR(253) NULL,
  client CHAR(16) NOT NULL DEFAULT '',
  position TINYINT NOT NULL DEFAULT 1,
  price BIGINT NOT NULL,
  clicked TINYINT(1) NOT NULL DEFAULT 0,
  cost BIGINT NOT NULL DEFAULT 0,
  UNIQUE KEY uq_imp_token (token),
  KEY idx_imp_camp (campaign_id, day),
  KEY idx_imp_site (site_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE search_safe (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  expr VARCHAR(600) NOT NULL,
  hash CHAR(64) NOT NULL,
  threat ENUM('phishing','malware','unwanted') NOT NULL DEFAULT 'phishing',
  source ENUM('admin','report','auto') NOT NULL DEFAULT 'admin',
  status ENUM('suspected','confirmed','cleared') NOT NULL DEFAULT 'confirmed',
  note VARCHAR(300) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_safe_hash (hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE search_reports (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  url VARCHAR(600) NOT NULL,
  threat ENUM('phishing','malware','unwanted') NOT NULL DEFAULT 'phishing',
  comment VARCHAR(500) NULL,
  client CHAR(16) NOT NULL DEFAULT '',
  status ENUM('new','accepted','rejected') NOT NULL DEFAULT 'new',
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- poisk.bln теперь обычный госсайт-приложение (web/poisk), как остальные.
UPDATE net_vhosts SET target = 'app:poisk' WHERE target = 'poisk';
