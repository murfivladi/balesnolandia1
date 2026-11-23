-- API-токены граждан: сервер сайта (или программа из интернета) работает с доменами, хостингом, сертификатами,
-- почтой, новостями, ВлодХабом и госуслугами от имени гражданина, в пределах выданных прав.
CREATE TABLE gov_api_tokens (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  gov_user_id BIGINT NOT NULL,
  name VARCHAR(80) NOT NULL,
  token_hash CHAR(64) NOT NULL,
  prefix VARCHAR(16) NOT NULL,
  scopes JSON NOT NULL,
  last_used DATETIME(3) NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE KEY uq_api_token (token_hash),
  KEY idx_api_token_user (gov_user_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
