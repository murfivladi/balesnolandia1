// Выдать роль admin существующему аккаунту: npm run make-admin -- email@example.com [bank|gov]
import { pool, one, q } from '../src/db.js';

const [email, kind = 'gov'] = process.argv.slice(2);
if (!email) {
  console.error('usage: npm run make-admin -- <email> [bank|gov]');
  process.exit(1);
}
const table = kind === 'bank' ? 'bank_users' : 'gov_users';
const user = await one(`SELECT id FROM ${table} WHERE email = ?`, [email.toLowerCase()]);
if (!user) {
  console.error(`no ${kind} account with email ${email}`);
  process.exitCode = 1;
} else {
  await q('INSERT IGNORE INTO user_roles (user_kind, user_id, role, granted_by) VALUES (?, ?, ?, ?)', [kind, user.id, 'admin', 'cli']);
  console.log(`admin granted to ${kind}:${user.id}`);
}
await pool.end();
