// Этап Н9: деньги в сети — эквайринг ВлодБанка (pay.bank.bln), вход для сайтов через ВлодПочту и ВлодУслуги (OAuth 2),
// интернет-магазин на складе Кассы и доставка (самовывоз по коду, курьеры-игроки с QR, цифровые товары, реальная доставка).
// Самодостаточный модуль: при сборке миграции копируются отдельно от бандла.
const WEB = '50.1.0.10';
const WEB6 = 'ba1:1::10';
const T = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

export async function up({ q }) {
  // ——— Эквайринг ———
  await q(`CREATE TABLE pay_merchants (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    public_id VARCHAR(32) NOT NULL,
    name VARCHAR(80) NOT NULL,
    owner_bank_user_id BIGINT NOT NULL,
    org_id BIGINT NULL,
    account_id BIGINT NOT NULL,
    shop_id BIGINT NULL,
    site_url VARCHAR(255) NULL,
    webhook_url VARCHAR(255) NULL,
    webhook_secret VARCHAR(80) NOT NULL,
    courier_fee BIGINT NOT NULL DEFAULT 0,
    delivery JSON NULL,
    status ENUM('active','blocked') NOT NULL DEFAULT 'active',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_pay_merchant_public (public_id),
    UNIQUE KEY uq_pay_merchant_shop (shop_id),
    KEY idx_pay_merchant_owner (owner_bank_user_id)
  ) ${T}`);
  await q(`CREATE TABLE pay_keys (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    merchant_id BIGINT NOT NULL,
    kind ENUM('publishable','secret') NOT NULL,
    token_hash CHAR(64) NOT NULL,
    hint VARCHAR(24) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_used_at DATETIME(3) NULL,
    revoked_at DATETIME(3) NULL,
    UNIQUE KEY uq_pay_key_hash (token_hash),
    KEY idx_pay_key_merchant (merchant_id)
  ) ${T}`);
  await q(`CREATE TABLE pay_payments (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    public_id VARCHAR(40) NOT NULL,
    merchant_id BIGINT NOT NULL,
    kind ENUM('payment','order','subscription') NOT NULL DEFAULT 'payment',
    amount BIGINT NOT NULL,
    vat BIGINT NOT NULL DEFAULT 0,
    fee BIGINT NOT NULL DEFAULT 0,
    refunded BIGINT NOT NULL DEFAULT 0,
    description VARCHAR(255) NOT NULL,
    items JSON NULL,
    metadata JSON NULL,
    status ENUM('pending','paid','cancelled','expired','refunded','partially_refunded') NOT NULL DEFAULT 'pending',
    return_url VARCHAR(500) NULL,
    cancel_url VARCHAR(500) NULL,
    idem_key VARCHAR(80) NULL,
    method ENUM('card','account') NULL,
    payer_bank_user_id BIGINT NULL,
    payer_account_id BIGINT NULL,
    card_id BIGINT NULL,
    tx_id BIGINT NULL,
    order_id BIGINT NULL,
    subscription_id BIGINT NULL,
    period_month INT NULL,
    age_limit TINYINT NOT NULL DEFAULT 0,
    expires_at DATETIME(3) NOT NULL,
    paid_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_pay_public (public_id),
    UNIQUE KEY uq_pay_idem (merchant_id, idem_key),
    KEY idx_pay_merchant (merchant_id, id),
    KEY idx_pay_payer (payer_bank_user_id)
  ) ${T}`);
  await q(`CREATE TABLE pay_refunds (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    public_id VARCHAR(40) NOT NULL,
    payment_id BIGINT NOT NULL,
    amount BIGINT NOT NULL,
    vat BIGINT NOT NULL DEFAULT 0,
    tx_id BIGINT NULL,
    reason VARCHAR(255) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_pay_refund_public (public_id),
    KEY idx_pay_refund_payment (payment_id)
  ) ${T}`);
  await q(`CREATE TABLE pay_subscriptions (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    public_id VARCHAR(40) NOT NULL,
    merchant_id BIGINT NOT NULL,
    amount BIGINT NOT NULL,
    description VARCHAR(255) NOT NULL,
    period_months INT NOT NULL DEFAULT 1,
    status ENUM('pending','active','past_due','cancelled') NOT NULL DEFAULT 'pending',
    payer_bank_user_id BIGINT NULL,
    payer_account_id BIGINT NULL,
    next_month INT NULL,
    fails INT NOT NULL DEFAULT 0,
    return_url VARCHAR(500) NULL,
    metadata JSON NULL,
    idem_key VARCHAR(80) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    started_at DATETIME(3) NULL,
    cancelled_at DATETIME(3) NULL,
    UNIQUE KEY uq_pay_sub_public (public_id),
    UNIQUE KEY uq_pay_sub_idem (merchant_id, idem_key),
    KEY idx_pay_sub_due (status, next_month),
    KEY idx_pay_sub_payer (payer_bank_user_id)
  ) ${T}`);
  await q(`CREATE TABLE pay_events (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    public_id VARCHAR(40) NOT NULL,
    merchant_id BIGINT NOT NULL,
    type VARCHAR(40) NOT NULL,
    data JSON NOT NULL,
    status ENUM('pending','delivered','failed','skipped') NOT NULL DEFAULT 'pending',
    attempts INT NOT NULL DEFAULT 0,
    next_try_at DATETIME(3) NULL,
    last_code VARCHAR(40) NULL,
    last_error VARCHAR(500) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    delivered_at DATETIME(3) NULL,
    UNIQUE KEY uq_pay_event_public (public_id),
    KEY idx_pay_event_merchant (merchant_id, id),
    KEY idx_pay_event_due (status, next_try_at)
  ) ${T}`);

  // ——— OAuth 2: «Войти через ВлодПочту» и «Войти через ВлодУслуги» ———
  await q(`CREATE TABLE oauth_clients (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    client_id VARCHAR(40) NOT NULL,
    secret_hash CHAR(64) NOT NULL,
    name VARCHAR(80) NOT NULL,
    owner_gov_user_id BIGINT NOT NULL,
    redirect_uris JSON NOT NULL,
    site_url VARCHAR(255) NULL,
    status ENUM('active','blocked') NOT NULL DEFAULT 'active',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_oauth_client (client_id),
    KEY idx_oauth_owner (owner_gov_user_id)
  ) ${T}`);
  await q(`CREATE TABLE oauth_codes (
    code_hash CHAR(64) NOT NULL PRIMARY KEY,
    client_id BIGINT NOT NULL,
    provider ENUM('mail','gov') NOT NULL,
    subject_id BIGINT NOT NULL,
    scope VARCHAR(255) NOT NULL,
    redirect_uri VARCHAR(500) NOT NULL,
    challenge VARCHAR(128) NULL,
    nonce VARCHAR(128) NULL,
    expires_at DATETIME(3) NOT NULL,
    used_at DATETIME(3) NULL
  ) ${T}`);
  await q(`CREATE TABLE oauth_tokens (
    token_hash CHAR(64) NOT NULL PRIMARY KEY,
    client_id BIGINT NOT NULL,
    provider ENUM('mail','gov') NOT NULL,
    subject_id BIGINT NOT NULL,
    scope VARCHAR(255) NOT NULL,
    expires_at DATETIME(3) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_oauth_token_subject (provider, subject_id)
  ) ${T}`);
  await q(`CREATE TABLE oauth_grants (
    client_id BIGINT NOT NULL,
    provider ENUM('mail','gov') NOT NULL,
    subject_id BIGINT NOT NULL,
    scope VARCHAR(255) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    last_used_at DATETIME(3) NULL,
    PRIMARY KEY (client_id, provider, subject_id),
    KEY idx_oauth_grant_subject (provider, subject_id)
  ) ${T}`);

  // ——— Интернет-магазин на складе Кассы и доставка ———
  await q(`CREATE TABLE shop_orders (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    public_id VARCHAR(40) NOT NULL,
    shop_id BIGINT NOT NULL,
    merchant_id BIGINT NOT NULL,
    sale_id BIGINT NULL,
    payment_id BIGINT NULL,
    buyer_bank_user_id BIGINT NULL,
    status ENUM('pending','paid','ready','delivering','delivered','cancelled','refunded') NOT NULL DEFAULT 'pending',
    delivery ENUM('pickup','courier','digital','physical') NOT NULL,
    address VARCHAR(255) NULL,
    contact VARCHAR(120) NULL,
    items JSON NOT NULL,
    goods BIGINT NOT NULL,
    delivery_fee BIGINT NOT NULL DEFAULT 0,
    total BIGINT NOT NULL,
    pickup_code CHAR(6) NULL,
    handoff_token VARCHAR(40) NULL,
    courier_bank_user_id BIGINT NULL,
    physical_status ENUM('pending','approved','rejected','shipped') NULL,
    admin_note VARCHAR(255) NULL,
    decided_by BIGINT NULL,
    digital JSON NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    paid_at DATETIME(3) NULL,
    ready_at DATETIME(3) NULL,
    taken_at DATETIME(3) NULL,
    delivered_at DATETIME(3) NULL,
    UNIQUE KEY uq_order_public (public_id),
    UNIQUE KEY uq_order_handoff (handoff_token),
    KEY idx_order_shop (shop_id, status),
    KEY idx_order_buyer (buyer_bank_user_id),
    KEY idx_order_courier (status, delivery),
    KEY idx_order_physical (physical_status)
  ) ${T}`);
  await q('ALTER TABLE products ADD COLUMN online TINYINT(1) NOT NULL DEFAULT 0, ADD COLUMN digital_content TEXT NULL');
  await q("ALTER TABLE sales MODIFY source ENUM('pos','kiosk','tab','online') NOT NULL DEFAULT 'pos'");
  await q("ALTER TABLE sale_payments MODIFY method ENUM('cash','card','qr','debt','online') NOT NULL");
  await q("ALTER TABLE refunds MODIFY method ENUM('cash','card','qr','debt','online') NOT NULL");

  // ——— Сеть: pay.bank.bln на госсервере банка ———
  const zone = (await q("SELECT * FROM dns_zones WHERE name = 'bank.bln.'"))[0];
  if (zone) {
    const have = await q("SELECT id FROM dns_records WHERE zone_id = ? AND name = 'pay.bank.bln.'", [zone.id]);
    if (!have.length) {
      await q("INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, 'pay.bank.bln.', 'A', 3600, ?)", [zone.id, WEB]);
      await q("INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, 'pay.bank.bln.', 'AAAA', 3600, ?)", [zone.id, WEB6]);
      await q('UPDATE dns_zones SET serial = serial + 1 WHERE id = ?', [zone.id]);
    }
  }
  for (const ip of [WEB, WEB6]) {
    for (const host of ['pay.bank.bln', 'www.pay.bank.bln']) await q("INSERT IGNORE INTO net_vhosts (ip, host, target) VALUES (?, ?, 'app:pay')", [ip, host]);
  }
}
