// Этап Н10: push-уведомления.
// 1) Настоящий Web Push на телефон и компьютер: подписки пользователей ВлодБанка и ВлодУслуг (push_subscriptions).
// 2) Push-сервис БалНета push.bln: «устройства» ВлодБраузера, подписки сайтов (PushManager.subscribe)
//    и очередь сообщений. Сайт на госсервере 50.1.0.10.
// Самодостаточный модуль: при сборке миграции копируются отдельно от бандла.
const GOV_NS = ['ns1.gov.bln.', 'ns2.gov.bln.'];
const NS_IPS = ['50.0.3.10', '50.0.3.11'];
const WEB = '50.1.0.10';

export async function up({ q }) {
  await q(`ALTER TABLE push_subscriptions
    ADD COLUMN user_agent VARCHAR(200) NULL,
    ADD COLUMN last_ok_at DATETIME(3) NULL,
    ADD COLUMN fails INT NOT NULL DEFAULT 0`);

  // Устройство = профиль ВлодБраузера, включивший push. Секрет знает только браузер (хранится хеш).
  // web_* — настоящая подписка Web Push этого браузера: push БалНета приходит, даже когда вкладка закрыта.
  await q(`CREATE TABLE balnet_push_devices (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    token_hash CHAR(64) NOT NULL,
    label VARCHAR(80) NULL,
    web_endpoint VARCHAR(500) NULL,
    web_p256dh VARCHAR(200) NULL,
    web_auth VARCHAR(100) NULL,
    last_seen_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_bpush_dev (token_hash)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  // Подписка сайта: адрес https://push.bln/send/<token>. Ключи p256dh/auth — ключи получателя:
  // сайт шифрует ими тело (aes128gcm), push-сервис расшифровывает его от имени браузера.
  await q(`CREATE TABLE balnet_push_subs (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    device_id BIGINT NOT NULL,
    origin VARCHAR(300) NOT NULL,
    token VARCHAR(64) NOT NULL,
    app_server_key VARCHAR(100) NULL,
    p256dh VARCHAR(100) NOT NULL,
    priv VARCHAR(100) NOT NULL,
    auth VARCHAR(40) NOT NULL,
    pushes INT NOT NULL DEFAULT 0,
    last_push_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_bpush_token (token),
    UNIQUE KEY uq_bpush_origin (device_id, origin(190))
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  await q(`CREATE TABLE balnet_push_messages (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    device_id BIGINT NOT NULL,
    sub_id BIGINT NULL,
    origin VARCHAR(300) NOT NULL,
    title VARCHAR(200) NOT NULL,
    body VARCHAR(1000) NULL,
    url VARCHAR(500) NULL,
    tag VARCHAR(100) NULL,
    topic VARCHAR(32) NULL,
    urgency VARCHAR(10) NOT NULL DEFAULT 'normal',
    encrypted TINYINT(1) NOT NULL DEFAULT 0,
    expires_at DATETIME(3) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_bpush_msg (device_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`);

  const zone = async (name) => (await q('SELECT * FROM dns_zones WHERE name = ?', [name]))[0];
  const bln = await zone('bln.');
  const name = 'push.bln.';
  if (!(await zone(name))) {
    const z = await q("INSERT INTO dns_zones (name, kind, serial, dnssec) VALUES (?, 'domain', 2026110901, 1)", [name]);
    const rec = (n, type, ttl, data) => q('INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, ?, ?, ?)', [z.insertId, n, type, ttl, data]);
    for (const ip of NS_IPS) await q('INSERT INTO dns_zone_servers (zone_id, ip) VALUES (?, ?)', [z.insertId, ip]);
    await rec(name, 'SOA', 86400, `ns1.gov.bln. hostmaster.${name} 2026110901 7200 3600 1209600 300`);
    for (const ns of GOV_NS) await rec(name, 'NS', 172800, ns);
    await rec(name, 'A', 3600, WEB);
    await rec(`www.${name}`, 'CNAME', 3600, name);
    await rec(name, 'TXT', 3600, '"БалПуш - push-сервис БалНета (Web Push, RFC 8030)"');
    await rec(name, 'CAA', 3600, '0 issue "ca.gov.bln"');
    if (bln) {
      for (const ns of GOV_NS) await q('INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, ?, ?, ?)', [bln.id, name, 'NS', 172800, ns]);
      await q('UPDATE dns_zones SET serial = serial + 1 WHERE id = ?', [bln.id]);
    }
  }
  for (const host of ['push.bln', 'www.push.bln']) await q("INSERT IGNORE INTO net_vhosts (ip, host, target) VALUES (?, ?, 'app:push')", [WEB, host]);
}
