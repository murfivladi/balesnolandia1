-- Этап Н7: виртуальный хостинг. Тарифы получают вид (статический / виртуальный) и настоящие лимиты:
-- запросы в минуту, CPU-мс на запрос, соединения WebSocket, минимальный шаг cron (игровые минуты).
ALTER TABLE hosting_plans
  ADD COLUMN kind ENUM('static','virtual') NOT NULL DEFAULT 'static',
  ADD COLUMN rpm INT NOT NULL DEFAULT 600,
  ADD COLUMN cpu_ms INT NOT NULL DEFAULT 0,
  ADD COLUMN ws_limit INT NOT NULL DEFAULT 0,
  ADD COLUMN cron_min INT NOT NULL DEFAULT 0;

-- Последний проверенный момент cron (игровые секунды).
ALTER TABLE hosting_sites ADD COLUMN cron_at BIGINT NULL;

INSERT INTO hosting_plans (org_id, server_id, name, disk_mb, max_sites, price_month, kind, rpm, cpu_ms, ws_limit, cron_min)
SELECT NULL, s.id, 'Сервер', 100, 3, 2500, 'virtual', 300, 100, 20, 60 FROM hosting_servers s WHERE s.org_id IS NULL ORDER BY s.id LIMIT 1;
INSERT INTO hosting_plans (org_id, server_id, name, disk_mb, max_sites, price_month, kind, rpm, cpu_ms, ws_limit, cron_min)
SELECT NULL, s.id, 'Сервер Про', 300, 10, 6000, 'virtual', 1200, 300, 100, 10 FROM hosting_servers s WHERE s.org_id IS NULL ORDER BY s.id LIMIT 1;
