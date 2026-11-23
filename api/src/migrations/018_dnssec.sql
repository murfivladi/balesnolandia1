-- Этап Н5: DNSSEC. Инфраструктурные зоны (корень, TLD, госзоны, обратная зона) подписаны сразу;
-- зоны доменов игроков — по желанию владельца (DS публикует регистратор). Ключи создаёт API (lib/dnssec.js).
ALTER TABLE dns_zones ADD COLUMN dnssec TINYINT(1) NOT NULL DEFAULT 0;
UPDATE dns_zones SET dnssec = 1 WHERE domain_id IS NULL;
