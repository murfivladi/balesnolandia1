// Восстановление госсервисов БалНета одной кнопкой админки: DNS-зоны и записи госсайтов, делегирование в .bln,
// привязки сайтов к госсерверам (vhost), доверие корневому УЦ и сертификаты госсайтов.
// Чужие записи на именах госсайтов (подмена A/CNAME, лишние NS, чужой vhost) удаляются.
import { q, one } from '../db.js';
import { invalidateNet } from './net.js';
import { flushResolverCache } from './dns.js';
import { renewGovCerts, ensurePki, resetPkiCache } from './pki.js';

const GOV_NS = ['ns1.gov.bln.', 'ns2.gov.bln.'];
const NS_IPS = ['50.0.3.10', '50.0.3.11'];
const WEB = '50.1.0.10';
const WEB6 = 'ba1:1::10';
const POISK = '50.1.0.20';
const MX = '50.1.0.25';
const H = 3600;

/** Сайты: имя → зона, адреса, цель vhost. */
const SITES = [
  ['bank.bln', 'bank.bln.', [WEB, WEB6], 'app:bank'],
  ['pay.bank.bln', 'bank.bln.', [WEB, WEB6], 'app:pay'],
  ['kassa.bln', 'kassa.bln.', [WEB, WEB6], 'app:pos'],
  ['gosuslugi.gov.bln', 'gov.bln.', [WEB, WEB6], 'app:services'],
  ['nalog.gov.bln', 'gov.bln.', [WEB], 'app:nalog'],
  ['ca.gov.bln', 'gov.bln.', [WEB], 'app:ca'],
  ['reg.bln', 'reg.bln.', [WEB], 'app:reg'],
  ['hosting.bln', 'hosting.bln.', [WEB], 'app:hosting'],
  ['mail.bln', 'mail.bln.', [WEB], 'app:mail'],
  ['vlodhub.bln', 'vlodhub.bln.', [WEB], 'app:hub'],
  ['novosti.bln', 'novosti.bln.', [WEB], 'app:news'],
  ['push.bln', 'push.bln.', [WEB], 'app:push'],
  ['poisk.bln', 'poisk.bln.', [POISK], 'app:poisk'],
];
const OWN_ZONES = ['gov.bln.', 'edu.bln.', 'bank.bln.', 'kassa.bln.', 'poisk.bln.', 'reg.bln.', 'hosting.bln.', 'mail.bln.', 'vlodhub.bln.', 'novosti.bln.', 'push.bln.'];
const typeOf = (ip) => (ip.includes(':') ? 'AAAA' : 'A');

export async function restoreGovServices() {
  const log = [];
  const touched = new Set();
  const zone = (name) => one('SELECT * FROM dns_zones WHERE name = ?', [name]);

  // ——— Зоны госдоменов ———
  const zones = {};
  for (const name of OWN_ZONES) {
    let z = await zone(name);
    if (!z) {
      const r = await q("INSERT INTO dns_zones (name, kind, serial, dnssec) VALUES (?, 'domain', 2026110901, 1)", [name]);
      z = await zone(name);
      log.push(`создана зона ${name}`);
      touched.add(r.insertId);
    }
    zones[name] = z;
    const servers = (await q('SELECT ip FROM dns_zone_servers WHERE zone_id = ?', [z.id])).map((r) => r.ip);
    if (servers.join() !== NS_IPS.join()) {
      await q('DELETE FROM dns_zone_servers WHERE zone_id = ?', [z.id]);
      for (const ip of NS_IPS) await q('INSERT INTO dns_zone_servers (zone_id, ip) VALUES (?, ?)', [z.id, ip]);
      log.push(`${name}: серверы зоны → ns1/ns2.gov.bln`);
      touched.add(z.id);
    }
  }

  /** Привести набор записей name/type к нужным значениям (лишние удалить, недостающие добавить). */
  async function exact(z, name, type, datas, ttl = H) {
    const have = await q('SELECT id, data FROM dns_records WHERE zone_id = ? AND name = ? AND type = ?', [z.id, name, type]);
    for (const r of have) {
      if (!datas.includes(r.data)) {
        await q('DELETE FROM dns_records WHERE id = ?', [r.id]);
        log.push(`${name} ${type}: удалено «${r.data}»`);
        touched.add(z.id);
      }
    }
    for (const d of datas) {
      if (!have.some((r) => r.data === d)) {
        await q('INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, ?, ?, ?)', [z.id, name, type, ttl, d]);
        log.push(`${name} ${type}: добавлено «${d}»`);
        touched.add(z.id);
      }
    }
  }
  async function drop(z, name, types) {
    const r = await q(`DELETE FROM dns_records WHERE zone_id = ? AND name = ? AND type IN (${types.map(() => '?').join(',')})`, [z.id, name, ...types]);
    if (r.affectedRows) { log.push(`${name}: удалены лишние ${types.join('/')}`); touched.add(z.id); }
  }
  async function ensure(z, name, type, data, ttl = H) {
    if (!(await one('SELECT id FROM dns_records WHERE zone_id = ? AND name = ? AND type = ?', [z.id, name, type]))) {
      await q('INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, ?, ?, ?)', [z.id, name, type, ttl, data]);
      log.push(`${name} ${type}: добавлено`);
      touched.add(z.id);
    }
  }

  // Вершины зон: SOA, NS, CAA.
  for (const name of OWN_ZONES) {
    const z = zones[name];
    await ensure(z, name, 'SOA', `ns1.gov.bln. hostmaster.${name} 2026110901 7200 3600 1209600 300`, 86400);
    await exact(z, name, 'NS', GOV_NS, 172800);
    if (name !== 'gov.bln.' && name !== 'edu.bln.') await exact(z, name, 'CAA', ['0 issue "ca.gov.bln"']);
  }
  // Серверы имён государства.
  await exact(zones['gov.bln.'], 'ns1.gov.bln.', 'A', [NS_IPS[0]], 172800);
  await exact(zones['gov.bln.'], 'ns2.gov.bln.', 'A', [NS_IPS[1]], 172800);
  await exact(zones['gov.bln.'], 'web1.dc.gov.bln.', 'A', [WEB]);
  await exact(zones['gov.bln.'], 'poisk1.dc.gov.bln.', 'A', [POISK]);

  // Сайты: A/AAAA и www → CNAME.
  for (const [host, zn, ips] of SITES) {
    const z = zones[zn];
    const name = `${host}.`;
    await drop(z, name, ['CNAME']);
    for (const t of ['A', 'AAAA']) await exact(z, name, t, ips.filter((ip) => typeOf(ip) === t));
    await drop(z, `www.${name}`, ['A', 'AAAA']);
    await exact(z, `www.${name}`, 'CNAME', [name]);
  }

  // Почта mail.bln: MX, SPF, DKIM (ключ из базы ВлодПочты), DMARC.
  const mz = zones['mail.bln.'];
  await exact(mz, 'mx.mail.bln.', 'A', [MX]);
  await exact(mz, 'mail.bln.', 'MX', ['10 mx.mail.bln.']);
  const spf = (await q("SELECT id, data FROM dns_records WHERE zone_id = ? AND name = 'mail.bln.' AND type = 'TXT' AND data LIKE '%v=spf1%'", [mz.id]));
  if (spf.length !== 1 || spf[0].data !== '"v=spf1 ip4:50.1.0.25 -all"') {
    await q("DELETE FROM dns_records WHERE zone_id = ? AND name = 'mail.bln.' AND type = 'TXT' AND data LIKE '%v=spf1%'", [mz.id]);
    await q("INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, 'mail.bln.', 'TXT', 3600, '\"v=spf1 ip4:50.1.0.25 -all\"')", [mz.id]);
    log.push('mail.bln TXT: восстановлен SPF'); touched.add(mz.id);
  }
  await exact(mz, '_spf.mail.bln.', 'TXT', ['"v=spf1 ip4:50.1.0.25 -all"']);
  await exact(mz, '_dmarc.mail.bln.', 'TXT', ['"v=DMARC1; p=reject; adkim=s; aspf=r"']);
  const dk = await one("SELECT selector, dkim_public FROM mail_domains WHERE name = 'mail.bln'").catch(() => null);
  if (dk) await exact(mz, `${dk.selector}._domainkey.mail.bln.`, 'TXT', [`"v=DKIM1; k=ed25519; p=${dk.dkim_public}"`]);

  // Делегирование в зоне .bln и glue.
  const bln = await zone('bln.');
  if (bln) {
    for (const name of OWN_ZONES) await exact(bln, name, 'NS', GOV_NS, 172800);
    await exact(bln, 'ns1.gov.bln.', 'A', [NS_IPS[0]], 172800);
    await exact(bln, 'ns2.gov.bln.', 'A', [NS_IPS[1]], 172800);
  }
  for (const id of touched) await q('UPDATE dns_zones SET serial = serial + 1 WHERE id = ?', [id]);

  // ——— Привязки сайтов к госсерверам ———
  for (const [host, , ips, target] of SITES) {
    for (const h of [host, `www.${host}`]) {
      const bad = await q('SELECT id, ip, target FROM net_vhosts WHERE host = ? AND target <> ?', [h, target]);
      for (const b of bad) {
        await q('DELETE FROM net_vhosts WHERE id = ?', [b.id]);
        log.push(`vhost ${h} на ${b.ip} (${b.target}) удалён`);
      }
      for (const ip of ips) {
        const r = await q('INSERT IGNORE INTO net_vhosts (ip, host, target) VALUES (?, ?, ?)', [ip, h, target]);
        if (r.affectedRows) log.push(`vhost ${h} → ${ip} восстановлен`);
      }
    }
  }

  // ——— Доверие и сертификаты ———
  await ensurePki();
  const ca = await q("UPDATE pki_cas SET trusted = 1 WHERE kind = 'root' AND org_id IS NULL AND trusted = 0");
  if (ca.affectedRows) log.push('корневой УЦ БалНета снова в списке доверия');
  const st = await q("UPDATE pki_cas SET status = 'active' WHERE org_id IS NULL AND status <> 'active'");
  if (st.affectedRows) log.push('госУЦ снова активны');
  if (ca.affectedRows || st.affectedRows) resetPkiCache();
  const before = Number((await one("SELECT COUNT(*) AS n FROM pki_certs WHERE gov_site = 1 AND status = 'valid' AND replaced_by IS NULL")).n);
  await renewGovCerts();
  const after = Number((await one("SELECT COUNT(*) AS n FROM pki_certs WHERE gov_site = 1 AND status = 'valid' AND replaced_by IS NULL")).n);
  if (after > before) log.push(`выпущено сертификатов госсайтов: ${after - before}`);

  invalidateNet();
  flushResolverCache();
  return { changes: log, ok: true };
}
