// Кнопка «Восстановить госсервисы»: на исправной сети ничего не меняет; после поломки DNS, vhost,
// доверия и сертификатов возвращает всё, и госсайты снова открываются по https.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { setup, client, pool, q, one } from './helpers.js';

let app;
let admin;
let clock;
before(async () => {
  app = await setup();
  clock = await import('../src/lib/clock.js');
  clock.setGameTimeOverride(() => 80000);
  admin = client(app);
  await admin.post('/api/auth/gov/register', { email: 'admin@test.bf', password: 'password123', display_name: 'Админ' });
});
after(async () => {
  clock.setGameTimeOverride(null);
  await fs.rm(process.env.BALNET_SITES_DIR, { recursive: true, force: true });
  await app.close();
  await pool.end();
});

const open = async (url) => {
  (await import('../src/lib/dns.js')).flushResolverCache();
  const { netRequest } = await import('../src/lib/vhost/respond.js');
  return netRequest({ fromIp: '50.1.0.20', url, fresh: true });
};

test('на исправной сети ничего не удаляется, повтор — без изменений', async () => {
  const first = await admin.post('/api/admin/pki/gov-restore');
  assert.ok(!first.changes.some((c) => /удал/.test(c)), first.changes.join('\n'));
  assert.deepEqual((await admin.post('/api/admin/pki/gov-restore')).changes, []);
});

test('поломка DNS, vhost, доверия и сертификата — всё восстановлено', async () => {
  const bank = await one("SELECT id FROM dns_zones WHERE name = 'bank.bln.'");
  await q("DELETE FROM dns_records WHERE zone_id = ? AND name = 'pay.bank.bln.'", [bank.id]);
  await q("UPDATE dns_records SET data = '50.2.0.99' WHERE zone_id = ? AND name = 'bank.bln.' AND type = 'A'", [bank.id]);
  const news = await one("SELECT id FROM dns_zones WHERE name = 'novosti.bln.'");
  await q('DELETE FROM dns_records WHERE zone_id = ?', [news.id]);
  await q('DELETE FROM dns_zones WHERE id = ?', [news.id]);
  await q("DELETE FROM net_vhosts WHERE host = 'reg.bln'");
  await q("INSERT INTO net_vhosts (ip, host, target) VALUES ('50.2.0.5', 'mail.bln', 'site:999')");
  const mz = await one("SELECT id FROM dns_zones WHERE name = 'mail.bln.'");
  await q("DELETE FROM dns_records WHERE zone_id = ? AND type = 'MX'", [mz.id]);
  const pay = await one("SELECT id FROM pki_certs WHERE gov_site = 1 AND status = 'valid' AND replaced_by IS NULL AND JSON_CONTAINS(names, '\"pay.bank.bln\"')");
  await q("UPDATE pki_certs SET status = 'revoked' WHERE id = ?", [pay.id]);
  (await import('../src/lib/net.js')).invalidateNet();
  assert.ok((await open('https://pay.bank.bln/api/v1/me')).error, 'pay.bank.bln сломан');

  const r = await admin.post('/api/admin/pki/gov-restore');
  assert.ok(r.changes.length >= 6, r.changes.join('\n'));
  for (const url of ['https://pay.bank.bln/api/v1/me', 'https://bank.bln/api/bank/accounts', 'https://novosti.bln/api/news/feed', 'https://reg.bln/api/gov/domains/zones', 'https://mail.bln/.well-known/openid-configuration']) {
    const x = await open(url);
    assert.ok(!x.error, `${url}: ${x.error}`);
  }
  assert.ok(await one("SELECT id FROM dns_records WHERE zone_id = ? AND type = 'MX'", [mz.id]));
  assert.ok(!(await one("SELECT id FROM net_vhosts WHERE host = 'mail.bln' AND target = 'site:999'")));
  assert.deepEqual((await admin.post('/api/admin/pki/gov-restore')).changes, [], 'повтор — без изменений');
});
