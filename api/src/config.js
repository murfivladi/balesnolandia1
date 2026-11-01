import 'dotenv/config';

const env = process.env;
const list = (v) => (v || '').split(',').map((s) => s.trim()).filter(Boolean);

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
  jwtSecret: env.JWT_SECRET || 'dev-secret-change-me',
  cookieDomain: env.COOKIE_DOMAIN || undefined,
  cookieSecure: env.COOKIE_SECURE === 'true',
  corsOrigins: list(env.CORS_ORIGINS || 'http://localhost:5173'),
  publicWebUrl: (env.PUBLIC_WEB_URL || 'http://localhost:5173/balesnolandia').replace(/\/$/, ''),
  adminEmails: list(env.ADMIN_EMAILS).map((e) => e.toLowerCase()),
  mail: {
    transport: env.MAIL_TRANSPORT || 'console',
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 465),
    secure: env.SMTP_SECURE !== 'false',
    user: env.SMTP_USER,
    password: env.SMTP_PASSWORD,
    from: env.MAIL_FROM || 'Балесноландия <no-reply@vladinc.ru>',
  },
  gameClock: (env.GAME_CLOCK || 'on') === 'on',
};

if (config.env === 'production' && config.jwtSecret === 'dev-secret-change-me') {
  throw new Error('JWT_SECRET must be set in production');
}
