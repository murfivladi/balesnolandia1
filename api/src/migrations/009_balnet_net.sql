-- Этап Н2: сеть БалНета — IP-блоки, хосты, провайдеры, аренда адресов, DNS-зоны и записи.
-- Имена в DNS хранятся полностью, в нижнем регистре и с точкой на конце: «bank.bln.», корень — «.».

CREATE TABLE net_providers (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  code VARCHAR(32) NOT NULL UNIQUE,
  name VARCHAR(100) NOT NULL,
  block_id INT NULL,
  resolver_ip VARCHAR(45) NOT NULL,
  active TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE net_ip_blocks (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  cidr VARCHAR(50) NOT NULL UNIQUE,
  purpose VARCHAR(16) NOT NULL,
  holder VARCHAR(120) NOT NULL,
  gateway_ip VARCHAR(45) NULL,
  latency_ms INT NOT NULL DEFAULT 5,
  provider_id INT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE net_hosts (
  ip VARCHAR(45) NOT NULL PRIMARY KEY,
  name VARCHAR(253) NOT NULL,
  kind VARCHAR(16) NOT NULL,
  up TINYINT(1) NOT NULL DEFAULT 1,
  provider_id INT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_net_hosts_kind (kind)
) ENGINE=InnoDB;

CREATE TABLE net_vhosts (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  ip VARCHAR(45) NOT NULL,
  host VARCHAR(253) NOT NULL,
  target VARCHAR(64) NOT NULL,
  UNIQUE KEY uq_vhost (ip, host)
) ENGINE=InnoDB;

CREATE TABLE net_leases (
  client_id VARCHAR(64) NOT NULL PRIMARY KEY,
  provider_id INT NOT NULL,
  ip VARCHAR(45) NOT NULL UNIQUE,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  seen_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE dns_zones (
  id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  kind VARCHAR(16) NOT NULL,
  serial INT UNSIGNED NOT NULL DEFAULT 1,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
) ENGINE=InnoDB;

CREATE TABLE dns_zone_servers (
  zone_id INT NOT NULL,
  ip VARCHAR(45) NOT NULL,
  PRIMARY KEY (zone_id, ip),
  INDEX idx_zone_servers_ip (ip),
  CONSTRAINT fk_zone_servers_zone FOREIGN KEY (zone_id) REFERENCES dns_zones (id) ON DELETE CASCADE
) ENGINE=InnoDB;

CREATE TABLE dns_records (
  id BIGINT NOT NULL AUTO_INCREMENT PRIMARY KEY,
  zone_id INT NOT NULL,
  name VARCHAR(255) NOT NULL,
  type VARCHAR(10) NOT NULL,
  ttl INT UNSIGNED NOT NULL DEFAULT 3600,
  data VARCHAR(1000) NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX idx_dns_records_zone (zone_id),
  INDEX idx_dns_records_name (name, type),
  CONSTRAINT fk_dns_records_zone FOREIGN KEY (zone_id) REFERENCES dns_zones (id) ON DELETE CASCADE
) ENGINE=InnoDB;
