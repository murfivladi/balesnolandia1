#!/usr/bin/env bash
# Подготовка VPS (Debian/Ubuntu) для API Балесноландии. Запускается деплоем от root (через sudo)
# при каждом деплое и ничего не ломает при повторе:
#   пакеты (nginx, certbot, MariaDB, Node.js 20, pm2) → база и пользователь → api/.env →
#   конфиг nginx → сертификат Let's Encrypt → перезагрузка nginx.
# Всё, что не нужно для первого запуска (адрес сайта, CORS, почта SMTP), настраивается в админке.
set -euo pipefail

DOMAIN="${DOMAIN:-bln-api.vladinc.ru}"
APP_DIR="${APP_DIR:?APP_DIR}"
APP_USER="${APP_USER:?APP_USER}"
PORT="${PORT:-3100}"
ADMIN_EMAILS="${ADMIN_EMAILS:-}"
CERTBOT_EMAIL="${CERTBOT_EMAIL:-}"
DB_NAME="${DB_NAME:-balesnolandia}"
DB_USER="${DB_USER:-balesnolandia}"
HERE="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$APP_DIR/api/.env"

log() { printf '\n==> %s\n' "$*"; }
have() { command -v "$1" >/dev/null 2>&1; }

[ "$(id -u)" = 0 ] || { echo "Нужен root (sudo)"; exit 1; }
export DEBIAN_FRONTEND=noninteractive

# ——— Пакеты ———
need_pkgs=()
have nginx || need_pkgs+=(nginx)
have certbot || need_pkgs+=(certbot)
have curl || need_pkgs+=(curl)
have openssl || need_pkgs+=(openssl)
if ! have mysql && ! have mariadb; then need_pkgs+=(mariadb-server); fi
if [ ${#need_pkgs[@]} -gt 0 ]; then
  log "Устанавливаю: ${need_pkgs[*]}"
  apt-get update -qq
  apt-get install -y -qq "${need_pkgs[@]}" ca-certificates gnupg
fi
systemctl enable --now nginx >/dev/null 2>&1 || true
systemctl enable --now mariadb >/dev/null 2>&1 || systemctl enable --now mysql >/dev/null 2>&1 || true

node_major=0
have node && node_major="$(node -p 'process.versions.node.split(".")[0]')"
if [ "$node_major" -lt 20 ]; then
  log "Устанавливаю Node.js 20"
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs
fi
have pm2 || { log "Устанавливаю pm2"; npm install -g pm2 --no-audit --no-fund >/dev/null; }

# ——— Каталог приложения ———
mkdir -p "$APP_DIR/api"
chown "$APP_USER": "$APP_DIR" "$APP_DIR/api"

# ——— .env: только то, что нужно для первого запуска ———
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
getv() { grep -E "^$1=" "$ENV_FILE" | tail -n1 | cut -d= -f2- || true; }
setv() {
  local k="$1" v="$2"
  if grep -qE "^$k=" "$ENV_FILE"; then
    local tmp; tmp="$(mktemp)"
    awk -v k="$k" -v v="$v" -F= 'BEGIN{OFS="="} $1==k {print k "=" v; next} {print}' "$ENV_FILE" > "$tmp"
    cat "$tmp" > "$ENV_FILE"; rm -f "$tmp"
  else
    printf '%s=%s\n' "$k" "$v" >> "$ENV_FILE"
  fi
}
setdefault() { [ -n "$(getv "$1")" ] || setv "$1" "$2"; }

setdefault NODE_ENV production
setdefault HOST 127.0.0.1
setdefault PORT "$PORT"
setdefault JWT_SECRET "$(openssl rand -hex 32)"
setdefault COOKIE_DOMAIN .vladinc.ru
setdefault COOKIE_SECURE true
# Адреса и почта — в админке (Система → Адреса и почта). ADMIN_EMAILS обновляется из секрета деплоя.
[ -n "$ADMIN_EMAILS" ] && setv ADMIN_EMAILS "$ADMIN_EMAILS"

# ——— База данных ———
if [ -z "$(getv DB_PASSWORD)" ]; then
  log "Создаю базу $DB_NAME и пользователя $DB_USER"
  DB_PASS="$(openssl rand -hex 24)"
  MYSQL=(mysql)
  have mariadb && MYSQL=(mariadb)
  if ! "${MYSQL[@]}" -e "SELECT 1" >/dev/null 2>&1; then
    echo "Нет доступа к MySQL/MariaDB от root через сокет."
    echo "Создайте базу вручную и пропишите DB_HOST, DB_NAME, DB_USER, DB_PASSWORD в $ENV_FILE"
    exit 1
  fi
  "${MYSQL[@]}" <<SQL
CREATE DATABASE IF NOT EXISTS \`$DB_NAME\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE USER IF NOT EXISTS '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
ALTER USER '$DB_USER'@'localhost' IDENTIFIED BY '$DB_PASS';
GRANT ALL PRIVILEGES ON \`$DB_NAME\`.* TO '$DB_USER'@'localhost';
FLUSH PRIVILEGES;
SQL
  setv DB_HOST 127.0.0.1
  setv DB_PORT 3306
  setv DB_NAME "$DB_NAME"
  setv DB_USER "$DB_USER"
  setv DB_PASSWORD "$DB_PASS"
fi
chown "$APP_USER": "$ENV_FILE"

# ——— nginx + Let's Encrypt ———
SITE=/etc/nginx/sites-available/balesnolandia-api.conf
render() { sed -e "s/__DOMAIN__/$DOMAIN/g" -e "s/__PORT__/$(getv PORT)/g" "$1" > "$SITE"; }
mkdir -p /var/www/certbot /etc/nginx/sites-enabled
ln -sf "$SITE" /etc/nginx/sites-enabled/balesnolandia-api.conf
CERT="/etc/letsencrypt/live/$DOMAIN/fullchain.pem"

if [ ! -f "$CERT" ]; then
  log "nginx (HTTP) и сертификат для $DOMAIN"
  render "$HERE/nginx-http.conf"
  nginx -t && systemctl reload nginx
  if [ -n "$CERTBOT_EMAIL" ]; then email_args=(--email "$CERTBOT_EMAIL"); else email_args=(--register-unsafely-without-email); fi
  if ! certbot certonly --webroot -w /var/www/certbot -d "$DOMAIN" --non-interactive --agree-tos "${email_args[@]}" \
      --deploy-hook "systemctl reload nginx"; then
    echo "Не удалось получить сертификат. Проверьте, что DNS-запись A для $DOMAIN указывает на этот сервер, и порт 80 открыт."
    exit 1
  fi
fi

log "nginx (HTTPS) → 127.0.0.1:$(getv PORT)"
render "$HERE/nginx-https.conf"
nginx -t
systemctl reload nginx

# Продление сертификатов: certbot ставит таймер systemd; на всякий случай проверим его.
systemctl enable --now certbot.timer >/dev/null 2>&1 || true

# ——— pm2 при загрузке системы ———
if [ ! -f "/etc/systemd/system/pm2-$APP_USER.service" ]; then
  log "Автозапуск pm2 для $APP_USER"
  APP_HOME="$(getent passwd "$APP_USER" | cut -d: -f6)"
  env PATH="$PATH" pm2 startup systemd -u "$APP_USER" --hp "$APP_HOME" >/dev/null
fi

log "Сервер готов"
