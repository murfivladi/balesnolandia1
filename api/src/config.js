import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// Настройки: .env (разработка) и bln.env рядом с server.mjs — его собирает деплой из секретов
// и загружает по FTP вместе с кодом.
export const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: [path.resolve('.env'), path.resolve('bln.env'), path.join(APP_DIR, '.env'), path.join(APP_DIR, 'bln.env')], quiet: true });

const env = process.env;
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);
const prod = (env.NODE_ENV || 'development') === 'production';

export const config = {
  env: env.NODE_ENV || 'development',
  port: Number(env.PORT || 3100),
  host: env.HOST || '127.0.0.1',
  db: {
    host: env.DB_HOST || '127.0.0.1',
    port: Number(env.DB_PORT || 3306),
    user: env.DB_USER || 'bln',
    password: env.DB_PASSWORD || 'bln',
    database: env.DB_NAME || 'bln',
  },
  // В продакшене без JWT_SECRET секрет создаётся при первом запуске и хранится в базе (lib/secrets.js).
  jwtSecret: env.JWT_SECRET || (prod ? null : 'dev-secret-change-me'),
  // Миграции при старте — по умолчанию в продакшене, чтобы деплой был только загрузкой файлов.
  migrateOnStart: env.MIGRATE_ON_START ? env.MIGRATE_ON_START === 'true' : prod,
  // Перезапуск после новой загрузки (файл VERSION изменился) — процесс завершается, менеджер процессов поднимает заново.
  restartOnDeploy: (env.RESTART_ON_DEPLOY || 'on') === 'on',
  // Адреса пишет в .env деплой (deploy/setup-server.sh); адрес сайта и почта уточняются в админке.
  // Cookie по умолчанию — только для хоста API: браузер шлёт их с сайта, потому что это один сайт (vladislavb.ru).
  cookieDomain: env.COOKIE_DOMAIN || undefined,
  cookieSecure: env.COOKIE_SECURE ? env.COOKIE_SECURE === 'true' : prod,
  corsOrigins: list(env.CORS_ORIGINS || (prod ? 'https://balesnolandia.vladislavb.ru' : 'http://localhost:5173')),
  publicWebUrl: (env.PUBLIC_WEB_URL || (prod ? 'https://balesnolandia.vladislavb.ru' : 'http://localhost:5173')).replace(/\/$/, ''),
  adminEmails: list(env.ADMIN_EMAILS).map((e) => e.toLowerCase()),
  mail: {
    transport: env.MAIL_TRANSPORT || 'console',
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 465),
    secure: env.SMTP_SECURE !== 'false',
    user: env.SMTP_USER,
    password: env.SMTP_PASSWORD,
    from: env.MAIL_FROM || 'Балесноландия <no-reply@vladislavb.ru>',
  },
  gameClock: (env.GAME_CLOCK || 'on') === 'on',
  // Файлы сайтов игроков (статический хостинг БалНета). Каталог не трогает деплой.
  sitesDir: env.BALNET_SITES_DIR || path.join(APP_DIR, 'balnet-sites'),
};

