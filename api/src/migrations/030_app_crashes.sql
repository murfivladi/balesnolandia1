-- Отчёты о сбоях нативных приложений (ВлодБраузер для iOS). Приложение отправляет их при следующем запуске;
-- админ видит их в «Система → Сбои приложений». Личных данных нет: версия, устройство, текст ошибки и стек.
CREATE TABLE app_crash_reports (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  platform VARCHAR(16) NOT NULL,
  version VARCHAR(20) NOT NULL,
  build INT NOT NULL DEFAULT 0,
  device VARCHAR(80) NULL,
  os VARCHAR(40) NULL,
  kind VARCHAR(40) NOT NULL,
  message VARCHAR(1000) NOT NULL,
  stack TEXT NULL,
  happened_at DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  KEY idx_crash_created (created_at)
);
