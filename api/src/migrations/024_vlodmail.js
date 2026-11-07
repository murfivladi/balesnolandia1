// Этап Н8: ВлодПочта (mail.bln) — почтовые ящики, свои домены, доставка по MX, SPF, DKIM, DMARC, спам-фильтр,
// аккаунт ВлодБраузера и синхронизация. Почтовый сервер mx.mail.bln — на госсервере 50.1.0.25.
// Самодостаточный модуль: при сборке миграции копируются отдельно от бандла.
import crypto from 'node:crypto';

const GOV_NS = ['ns1.gov.bln.', 'ns2.gov.bln.'];
const NS_IPS = ['50.0.3.10', '50.0.3.11'];
const WEB = '50.1.0.10';
const MX = '50.1.0.25';
const SELECTOR = 'vlod1';
const T = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

/** Ключ DKIM Ed25519 (RFC 8463): открытый — 32 байта в base64 для записи p=, закрытый — PKCS8 в base64. */
function dkimKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  return { pub: raw.toString('base64'), priv: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64') };
}

export async function up({ q }) {
  await q(`CREATE TABLE mail_accounts (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    gov_user_id BIGINT NOT NULL,
    login VARCHAR(40) NOT NULL,
    name VARCHAR(80) NULL,
    signature VARCHAR(500) NULL,
    notify_email TINYINT(1) NOT NULL DEFAULT 1,
    notified_at DATETIME(3) NULL,
    spam_threshold INT NOT NULL DEFAULT 50,
    status ENUM('active','blocked') NOT NULL DEFAULT 'active',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_mail_gov (gov_user_id),
    UNIQUE KEY uq_mail_login (login)
  ) ${T}`);
  // Домены, почту которых принимает ВлодПочта. owner_gov_user_id NULL — домен самой ВлодПочты (mail.bln).
  await q(`CREATE TABLE mail_domains (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    name VARCHAR(253) NOT NULL,
    owner_gov_user_id BIGINT NULL,
    selector VARCHAR(63) NOT NULL,
    dkim_public VARCHAR(100) NOT NULL,
    dkim_private VARCHAR(200) NOT NULL,
    catch_all_account_id BIGINT NULL,
    checks JSON NULL,
    checked_at DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_mail_domain (name)
  ) ${T}`);
  await q(`CREATE TABLE mail_addresses (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    address VARCHAR(320) NOT NULL,
    domain_id BIGINT NOT NULL,
    account_id BIGINT NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_mail_address (address),
    KEY idx_mail_address_account (account_id)
  ) ${T}`);
  await q(`CREATE TABLE mail_messages (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT NOT NULL,
    folder ENUM('inbox','sent','spam','trash','drafts') NOT NULL,
    rcpt VARCHAR(320) NULL,
    message_id VARCHAR(255) NULL,
    in_reply_to VARCHAR(255) NULL,
    from_addr VARCHAR(320) NOT NULL,
    from_name VARCHAR(200) NULL,
    to_addrs JSON NULL,
    cc_addrs JSON NULL,
    subject VARCHAR(500) NOT NULL DEFAULT '',
    snippet VARCHAR(300) NOT NULL DEFAULT '',
    body_text MEDIUMTEXT NULL,
    body_html MEDIUMTEXT NULL,
    raw MEDIUMTEXT NULL,
    auth JSON NULL,
    spam_score INT NOT NULL DEFAULT 0,
    spam_reasons JSON NULL,
    seen TINYINT(1) NOT NULL DEFAULT 0,
    starred TINYINT(1) NOT NULL DEFAULT 0,
    size INT NOT NULL DEFAULT 0,
    game_time BIGINT NOT NULL DEFAULT 0,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_mail_box (account_id, folder, id)
  ) ${T}`);
  // Журнал почтовых серверов: кто, кому, с какими проверками — без текста писем.
  await q(`CREATE TABLE mail_log (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    server VARCHAR(253) NOT NULL,
    from_ip VARCHAR(45) NOT NULL,
    helo VARCHAR(253) NULL,
    mail_from VARCHAR(320) NULL,
    header_from VARCHAR(320) NULL,
    rcpt VARCHAR(320) NOT NULL,
    status ENUM('delivered','spam','rejected','bounced','script') NOT NULL,
    code VARCHAR(16) NULL,
    detail VARCHAR(500) NULL,
    spf VARCHAR(16) NULL,
    dkim VARCHAR(16) NULL,
    dmarc VARCHAR(16) NULL,
    spam_score INT NULL,
    message_id VARCHAR(255) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_mail_log_at (created_at),
    KEY idx_mail_log_rcpt (rcpt)
  ) ${T}`);
  await q(`CREATE TABLE mail_contacts (
    account_id BIGINT NOT NULL,
    address VARCHAR(320) NOT NULL,
    name VARCHAR(200) NULL,
    sent INT NOT NULL DEFAULT 0,
    last_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (account_id, address)
  ) ${T}`);
  // Байесовский фильтр каждого ящика: обучается кнопками «Это спам» / «Не спам».
  await q(`CREATE TABLE mail_bayes (
    account_id BIGINT NOT NULL,
    token VARCHAR(64) NOT NULL,
    spam INT NOT NULL DEFAULT 0,
    ham INT NOT NULL DEFAULT 0,
    PRIMARY KEY (account_id, token)
  ) ${T}`);
  await q(`CREATE TABLE mail_bayes_totals (
    account_id BIGINT NOT NULL PRIMARY KEY,
    spam INT NOT NULL DEFAULT 0,
    ham INT NOT NULL DEFAULT 0
  ) ENGINE=InnoDB`);
  // Жалобы админу: копия письма видна админу только после жалобы (с записью в журнал аудита).
  await q(`CREATE TABLE mail_reports (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT NOT NULL,
    message_id BIGINT NOT NULL,
    reason VARCHAR(500) NULL,
    from_addr VARCHAR(320) NOT NULL,
    subject VARCHAR(500) NOT NULL,
    raw MEDIUMTEXT NULL,
    status ENUM('open','closed') NOT NULL DEFAULT 'open',
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    KEY idx_mail_reports (status, id)
  ) ${T}`);
  // Аккаунт ВлодБраузера: устройства, ключ шифрования (соль и проверочный блок) и зашифрованные данные.
  await q(`CREATE TABLE browser_devices (
    id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
    account_id BIGINT NOT NULL,
    name VARCHAR(80) NOT NULL,
    token_hash CHAR(64) NOT NULL,
    last_seen DATETIME(3) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    UNIQUE KEY uq_browser_token (token_hash),
    KEY idx_browser_dev_account (account_id)
  ) ${T}`);
  await q(`CREATE TABLE browser_sync_keys (
    account_id BIGINT NOT NULL PRIMARY KEY,
    salt VARCHAR(64) NOT NULL,
    iterations INT NOT NULL,
    check_blob TEXT NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
  ) ${T}`);
  await q(`CREATE TABLE browser_sync_data (
    account_id BIGINT NOT NULL,
    collection VARCHAR(20) NOT NULL,
    rev INT NOT NULL DEFAULT 0,
    blob_data MEDIUMTEXT NOT NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (account_id, collection)
  ) ENGINE=InnoDB`);

  // ——— Сеть: почтовый сервер, DNS зоны mail.bln ———
  const zone = async (name) => (await q('SELECT * FROM dns_zones WHERE name = ?', [name]))[0];
  const rec = (zoneId, n, type, ttl, data) => q('INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, ?, ?, ?)', [zoneId, n, type, ttl, data]);
  if (!(await q('SELECT ip FROM net_hosts WHERE ip = ?', [MX])).length) {
    await q("INSERT INTO net_hosts (ip, name, kind) VALUES (?, 'mx.mail.bln.', 'mail')", [MX]);
  }
  const arpa = await zone('in-addr.arpa.');
  if (arpa) {
    const ptr = `${MX.split('.').reverse().join('.')}.in-addr.arpa.`;
    await q("DELETE FROM dns_records WHERE zone_id = ? AND name = ? AND type = 'PTR'", [arpa.id, ptr]);
    await rec(arpa.id, ptr, 'PTR', 3600, 'mx.mail.bln.');
  }
  const key = dkimKey();
  const name = 'mail.bln.';
  const bln = await zone('bln.');
  if (!(await zone(name))) {
    const z = await q("INSERT INTO dns_zones (name, kind, serial, dnssec) VALUES (?, 'domain', 2026110901, 1)", [name]);
    const id = z.insertId;
    for (const ip of NS_IPS) await q('INSERT INTO dns_zone_servers (zone_id, ip) VALUES (?, ?)', [id, ip]);
    await rec(id, name, 'SOA', 86400, `ns1.gov.bln. hostmaster.${name} 2026110901 7200 3600 1209600 300`);
    for (const ns of GOV_NS) await rec(id, name, 'NS', 172800, ns);
    await rec(id, name, 'A', 3600, WEB);
    await rec(id, `www.${name}`, 'CNAME', 3600, name);
    await rec(id, `mx.${name}`, 'A', 3600, MX);
    await rec(id, name, 'MX', 3600, `10 mx.${name}`);
    await rec(id, name, 'TXT', 3600, '"v=spf1 ip4:50.1.0.25 -all"');
    await rec(id, `_spf.${name}`, 'TXT', 3600, '"v=spf1 ip4:50.1.0.25 -all"');
    await rec(id, `${SELECTOR}._domainkey.${name}`, 'TXT', 3600, `"v=DKIM1; k=ed25519; p=${key.pub}"`);
    await rec(id, `_dmarc.${name}`, 'TXT', 3600, '"v=DMARC1; p=reject; adkim=s; aspf=r"');
    await rec(id, name, 'CAA', 3600, '0 issue "ca.gov.bln"');
    if (bln) {
      for (const ns of GOV_NS) await rec(bln.id, name, 'NS', 172800, ns);
      await q('UPDATE dns_zones SET serial = serial + 1 WHERE id = ?', [bln.id]);
    }
  }
  await q('INSERT IGNORE INTO mail_domains (name, owner_gov_user_id, selector, dkim_public, dkim_private) VALUES (?, NULL, ?, ?, ?)', ['mail.bln', SELECTOR, key.pub, key.priv]);
  for (const host of ['mail.bln', 'www.mail.bln']) await q("INSERT IGNORE INTO net_vhosts (ip, host, target) VALUES (?, ?, 'app:mail')", [WEB, host]);

  // Госдомены сами писем не отправляют: SPF «-all» и DMARC «reject» — подделка письма от bank.bln не пройдёт.
  for (const zn of ['bank.bln.', 'gov.bln.', 'kassa.bln.', 'poisk.bln.', 'vlodhub.bln.']) {
    const z = await zone(zn);
    if (!z) continue;
    const have = await q("SELECT data FROM dns_records WHERE zone_id = ? AND type = 'TXT' AND (name = ? OR name = ?)", [z.id, zn, `_dmarc.${zn}`]);
    if (!have.some((r) => r.data.includes('v=spf1'))) await rec(z.id, zn, 'TXT', 3600, '"v=spf1 -all"');
    if (!have.some((r) => r.data.includes('v=DMARC1'))) await rec(z.id, `_dmarc.${zn}`, 'TXT', 3600, '"v=DMARC1; p=reject; sp=reject"');
    await q('UPDATE dns_zones SET serial = serial + 1 WHERE id = ?', [z.id]);
  }
}
