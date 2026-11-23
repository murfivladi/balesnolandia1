-- Этап Н7: аналитика сайтов хостинга. Просмотр страницы (HTML) через шлюз ВлодБраузера: день (игровой),
-- путь, анонимный посетитель (хеш устройства и сайта), источник: прямой заход, ВлодПоиск, другой сайт, переход внутри сайта.
CREATE TABLE site_hits (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  site_id BIGINT NOT NULL,
  day INT NOT NULL,
  path VARCHAR(300) NOT NULL,
  visitor CHAR(16) NOT NULL,
  source ENUM('direct','search','site','internal') NOT NULL,
  ref_host VARCHAR(253) NULL,
  KEY idx_hits_site_day (site_id, day)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
