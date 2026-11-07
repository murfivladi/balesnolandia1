// Админка → БалНет → Домены: зоны для регистрации и их реестры, организации и лицензии, споры, аукционы.
import { tx, q, one } from '../db.js';
import { bad, notFound, need, int, str, amount as amountArg } from '../lib/errors.js';
import { needAdmin, actorOf } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { currentMonth } from '../lib/clock.js';
import { getSettings } from '../lib/settings.js';
import { notify } from '../lib/notify.js';
import { invalidateNet } from '../lib/net.js';
import { createOrg, issueLicense, hasLicense, ORG_KINDS, LICENSE_KINDS } from '../lib/orgs.js';
import { parseDomain, availability, newAuthCode, wholesale, domainMonth } from '../lib/domains.js';
import { deleteDomainZone } from '../lib/zones.js';
import { fqdn } from '@bln/shared/balnet-dns.js';

const disp = (n) => String(n).replace(/\.$/, '');

async function citizenByPassport(conn, passport) {
  const c = await one('SELECT gov_user_id, full_name FROM citizens WHERE passport_no = ?', [String(passport || '').trim().toUpperCase()], conn);
  if (!c) throw notFound('Гражданин с таким паспортом не найден');
  return c;
}

export async function adminDomainRoutes(app) {
  app.addHook('preHandler', needAdmin());
  const actor = (req) => actorOf(req.actor);

  app.get('/registry', async () => {
    const month = await currentMonth();
    const tlds = await q('SELECT t.*, o.name AS registry_name FROM tlds t LEFT JOIN organizations o ON o.id = t.registry_org_id ORDER BY t.name');
    const orgs = await q("SELECT o.*, c.full_name AS director_name FROM organizations o LEFT JOIN citizens c ON c.gov_user_id = o.director_gov_user_id WHERE o.status = 'active' ORDER BY o.kind, o.name");
    const licenses = await q("SELECT l.*, o.name AS org_name FROM licenses l JOIN organizations o ON o.id = l.org_id ORDER BY l.id DESC LIMIT 200");
    const domains = await q("SELECT d.*, c.full_name AS owner_name, oo.name AS owner_org, r.name AS registrar FROM domains d LEFT JOIN citizens c ON c.gov_user_id = d.owner_gov_user_id LEFT JOIN organizations oo ON oo.id = d.owner_org_id LEFT JOIN organizations r ON r.id = d.registrar_org_id WHERE d.status <> 'released' ORDER BY d.name LIMIT 500");
    const auctions = await q("SELECT a.*, (SELECT MAX(amount) FROM auction_bids b WHERE b.auction_id = a.id) AS top FROM auctions a ORDER BY a.id DESC LIMIT 100");
    const tldZones = await q("SELECT z.id, z.name FROM dns_zones z LEFT JOIN tlds t ON t.zone_id = z.id WHERE t.id IS NULL AND z.domain_id IS NULL AND z.kind IN ('tld','domain') ORDER BY z.name");
    return {
      month,
      tlds: await Promise.all(tlds.map(async (t) => ({ ...t, name: disp(t.name), wholesale_now: await wholesale(null, t), wholesale_price: Number(t.wholesale_price), gov_price: Number(t.gov_price), active: !!t.active }))),
      orgs: orgs.map((o) => ({ ...o, kind_title: ORG_KINDS[o.kind] })),
      licenses: licenses.map((l) => ({ ...l, title: LICENSE_KINDS[l.kind]?.title || l.kind })),
      domains: domains.map((d) => ({ id: d.id, name: disp(d.name), status: d.status, owner: d.owner_org || d.owner_name, registrar: d.registrar || 'Госрегистратор', expires_month: d.expires_month })),
      auctions: auctions.map((a) => ({ ...a, name: disp(a.name), top: a.top ? Number(a.top) : null, min_bid: Number(a.min_bid) })),
      candidate_zones: tldZones.map((z) => ({ id: z.id, name: disp(z.name) })),
      org_kinds: ORG_KINDS,
      license_kinds: LICENSE_KINDS,
    };
  });

  // Открыть зону для регистрации доменов.
  app.post('/tlds', async (req) => {
    const b = req.body || {};
    const zone = await one('SELECT * FROM dns_zones WHERE name = ? AND domain_id IS NULL', [fqdn(String(b.zone || '')) || '']);
    if (!zone) throw notFound('Зона не найдена — сначала создайте её в «Зонах DNS»');
    need(!(await one('SELECT id FROM tlds WHERE zone_id = ?', [zone.id])), 'Зона уже открыта для регистрации');
    const r = await q('INSERT INTO tlds (zone_id, name, wholesale_price, gov_price, restricted) VALUES (?, ?, ?, ?, ?)', [
      zone.id, zone.name, int(b.wholesale_price ?? 5000, 'оптовая цена', { min: 0, max: 1e12 }), int(b.gov_price ?? 6000, 'цена Госрегистратора', { min: 0, max: 1e12 }), b.restricted === 'gov' ? 'gov' : null,
    ]);
    await audit(null, actor(req), 'net.tld.create', 'tld', r.insertId, { zone: zone.name });
    return { id: r.insertId };
  });

  app.patch('/tlds/:id', async (req) => {
    const id = int(req.params.id, 'id');
    const b = req.body || {};
    await tx(async (conn) => {
      const t = await one('SELECT * FROM tlds WHERE id = ? FOR UPDATE', [id], conn);
      if (!t) throw notFound();
      const wholesalePrice = b.wholesale_price !== undefined ? int(b.wholesale_price, 'оптовая цена', { min: 0, max: 1e12 }) : t.wholesale_price;
      const govPrice = b.gov_price !== undefined ? int(b.gov_price, 'цена Госрегистратора', { min: 0, max: 1e12 }) : t.gov_price;
      const active = b.active !== undefined ? (b.active ? 1 : 0) : t.active;
      const restricted = b.restricted !== undefined ? (b.restricted === 'gov' ? 'gov' : null) : t.restricted;
      let registry = t.registry_org_id;
      if (b.registry_org_id !== undefined) {
        registry = b.registry_org_id ? int(b.registry_org_id, 'организация') : null;
        if (registry) {
          const org = await one("SELECT id FROM organizations WHERE id = ? AND status = 'active'", [registry], conn);
          if (!org) throw notFound('Организация не найдена');
          const month = await currentMonth(conn);
          if (!(await hasLicense(conn, registry, 'registry', month))) await issueLicense(conn, { orgId: registry, kind: 'registry', month });
        }
      }
      await q('UPDATE tlds SET wholesale_price = ?, gov_price = ?, active = ?, restricted = ?, registry_org_id = ? WHERE id = ?', [wholesalePrice, govPrice, active, restricted, registry, id], conn);
      await audit(conn, actor(req), 'net.tld.update', 'tld', id, { wholesalePrice, govPrice, active, restricted, registry });
    });
    return { ok: true };
  });

  // ——— Организации и лицензии ———
  app.post('/orgs', async (req) => {
    const b = req.body || {};
    const kind = String(b.kind || 'gov');
    need(ORG_KINDS[kind], 'Вид организации: llc, jsc или gov');
    const name = str(b.name, 'название', { min: 2, max: 120 });
    const r = await tx(async (conn) => {
      const director = b.director_passport ? await citizenByPassport(conn, b.director_passport) : null;
      const org = await createOrg(conn, { kind, name, directorGovUserId: director?.gov_user_id || null, month: await currentMonth(conn) });
      await audit(conn, actor(req), 'org.create', 'organization', org.id, { kind, name });
      if (director) await notify(conn, 'gov', director.gov_user_id, { title: `Вы назначены директором: ${name}`, link: '#/orgs' });
      return org;
    });
    return r;
  });

  app.patch('/orgs/:id', async (req) => {
    const id = int(req.params.id, 'id');
    const b = req.body || {};
    await tx(async (conn) => {
      const org = await one('SELECT * FROM organizations WHERE id = ? FOR UPDATE', [id], conn);
      if (!org) throw notFound();
      if (b.director_passport) {
        const c = await citizenByPassport(conn, b.director_passport);
        await q("UPDATE org_members SET role = 'staff' WHERE org_id = ? AND role = 'director'", [id], conn);
        await q("INSERT INTO org_members (org_id, gov_user_id, role) VALUES (?, ?, 'director') ON DUPLICATE KEY UPDATE role = 'director'", [id, c.gov_user_id], conn);
        await q('UPDATE organizations SET director_gov_user_id = ? WHERE id = ?', [c.gov_user_id, id], conn);
        await notify(conn, 'gov', c.gov_user_id, { title: `Вы назначены директором: ${org.name}`, link: '#/orgs' });
      }
      if (b.status === 'closed') {
        const acc = await one('SELECT balance FROM accounts WHERE id = ?', [org.account_id], conn);
        need(Number(acc?.balance || 0) === 0, 'На счёте организации остались деньги');
        await q("UPDATE organizations SET status = 'closed' WHERE id = ?", [id], conn);
        await q("UPDATE accounts SET status = 'closed', closed_at = NOW(3) WHERE id = ?", [org.account_id], conn);
        await q("UPDATE licenses SET status = 'revoked', comment = 'Организация закрыта' WHERE org_id = ? AND status = 'active'", [id], conn);
        await q('UPDATE tlds SET registry_org_id = NULL WHERE registry_org_id = ?', [id], conn);
      }
      await audit(conn, actor(req), 'org.update', 'organization', id, b);
    });
    return { ok: true };
  });

  app.post('/licenses', async (req) => {
    const b = req.body || {};
    need(LICENSE_KINDS[b.kind], 'Неизвестная лицензия');
    const number = await tx(async (conn) => {
      const org = await one("SELECT id FROM organizations WHERE id = ? AND status = 'active'", [int(b.org_id, 'организация')], conn);
      if (!org) throw notFound('Организация не найдена');
      const month = await currentMonth(conn);
      if (await hasLicense(conn, org.id, b.kind, month)) throw bad('already_have', 'Лицензия уже действует');
      const s = await getSettings();
      const n = await issueLicense(conn, { orgId: org.id, kind: b.kind, month, months: b.months === null ? null : Number(b.months || s.license_months) || null });
      await audit(conn, actor(req), 'license.issue', 'organization', org.id, { kind: b.kind, number: n });
      return n;
    });
    return { number };
  });

  app.post('/licenses/:id/revoke', async (req) => {
    const id = int(req.params.id, 'id');
    await q("UPDATE licenses SET status = 'revoked', comment = ? WHERE id = ? AND status = 'active'", [str(req.body?.comment, 'причина', { optional: true, max: 255 }), id]);
    await audit(null, actor(req), 'license.revoke', 'license', id, req.body || {});
    return { ok: true };
  });

  // ——— Домены: споры и изъятие ———
  app.post('/domains/:id/owner', async (req) => {
    const id = int(req.params.id, 'id');
    const b = req.body || {};
    const reason = str(b.reason, 'основание', { min: 3, max: 255 });
    await tx(async (conn) => {
      const d = await one("SELECT * FROM domains WHERE id = ? AND status <> 'released' FOR UPDATE", [id], conn);
      if (!d) throw notFound();
      let userId = null;
      let orgId = null;
      if (b.org_id) orgId = (await one("SELECT id FROM organizations WHERE id = ? AND status = 'active'", [int(b.org_id, 'организация')], conn))?.id || null;
      else userId = (await citizenByPassport(conn, b.passport)).gov_user_id;
      need(userId || orgId, 'Укажите нового владельца');
      await q('UPDATE domains SET owner_gov_user_id = ?, owner_org_id = ?, auth_code = ? WHERE id = ?', [userId, orgId, newAuthCode(), id], conn);
      if (d.owner_gov_user_id) await notify(conn, 'gov', d.owner_gov_user_id, { title: `Домен ${disp(d.name)} передан по решению администрации`, body: reason, link: '#/domains' });
      if (userId) await notify(conn, 'gov', userId, { title: `Вам передан домен ${disp(d.name)}`, body: reason, link: '#/domains' });
      await audit(conn, actor(req), 'domain.force_owner', 'domain', id, { reason, userId, orgId });
    });
    return { ok: true };
  });

  app.post('/domains/:id/seize', async (req) => {
    const id = int(req.params.id, 'id');
    const reason = str(req.body?.reason, 'основание', { min: 3, max: 255 });
    await tx(async (conn) => {
      const d = await one("SELECT * FROM domains WHERE id = ? AND status <> 'released' FOR UPDATE", [id], conn);
      if (!d) throw notFound();
      await deleteDomainZone(conn, d);
      await q("UPDATE domains SET status = 'released', live_name = NULL WHERE id = ?", [id], conn);
      if (d.owner_gov_user_id) await notify(conn, 'gov', d.owner_gov_user_id, { title: `Домен ${disp(d.name)} изъят`, body: reason, link: '#/domains', email: true });
      await audit(conn, actor(req), 'domain.seize', 'domain', id, { reason });
    });
    invalidateNet();
    return { ok: true };
  });

  // Премиум-аукцион на свободное имя.
  app.post('/auctions', async (req) => {
    const b = req.body || {};
    const r = await tx(async (conn) => {
      const { name, tld } = await parseDomain(conn, b.name);
      const av = await availability(conn, name, tld);
      if (!av.free) throw bad('taken', av.reason);
      const month = await currentMonth(conn);
      const months = int(b.months ?? 1, 'срок', { min: 1, max: 24 });
      const res = await q("INSERT INTO auctions (name, tld_id, reason, min_bid, ends_month) VALUES (?, ?, 'premium', ?, ?)", [name, tld.id, amountArg(b.min_bid, 'стартовая цена'), month + months]);
      await audit(conn, actor(req), 'auction.create', 'auction', res.insertId, { name });
      return res.insertId;
    });
    return { id: r };
  });

  // Прогнать месячную обработку доменов сейчас (без перевода игровых часов) — для проверки и починки.
  app.post('/domains/tick', async () => {
    await domainMonth(await currentMonth());
    return { ok: true };
  });
}
