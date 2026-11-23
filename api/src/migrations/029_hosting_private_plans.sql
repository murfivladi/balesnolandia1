-- Хостеры-игроки продают хостинг на своих сайтах через API. Их тарифы по умолчанию не показываются на витрине
-- госхостинга hosting.bln (listed = 0), но покупаются по id тарифа и выдаются клиентам через API хостера.
ALTER TABLE hosting_plans ADD COLUMN listed TINYINT(1) NOT NULL DEFAULT 0;
UPDATE hosting_plans SET listed = 1 WHERE org_id IS NULL;
ALTER TABLE hosting_accounts ADD COLUMN hoster_note VARCHAR(200) NULL;
