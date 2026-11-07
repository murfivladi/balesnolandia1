// ВлодУслуги → Организации и Домены (этап Н3). Вход — аккаунт ВлодУслуг.
import { tx, q, one } from '../db.js';
import { bad, notFound, need, int, str, amount as amountArg } from '../lib/errors.js';
import { needGov, actorOf } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { citizenOf, activePassport, submitApplication, payInvoice } from '../lib/gov.js';
import { currentMonth } from '../lib/clock.js';
import { post } from '../lib/ledger.js';
import { getSettings } from '../lib/settings.js';
import { ORG_KINDS, LICENSE_KINDS, memberOrg, hasLicense, orgView } from '../lib/orgs.js';
import {
  parseDomain, availability, registrarOffers, wholesale, registerDomain, renewDomain, transferRegistrar, claimDomain,
  setNameservers, ownDomain, domainView, placeBid, newAuthCode,
} from '../lib/domains.js';
import { checkRecord, recordArgs, bumpSerial } from '../lib/zones.js';
import { invalidateNet } from '../lib/net.js';
import { relativeName } from '@bln/shared/balnet-dns.js';
import { vatIncluded } from '@bln/shared/money.js';

const disp = (n) => String(n).replace(/\.$/, '');

export async function domainRoutes(app) {
  const auth = { preHandler: needGov() };
  const actor = (req) => actorOf(req.gov);

  // ——— Организации ———
  app.get('/orgs', auth, async (req) => {
    const rows = await q("SELECT o.*, m.role FROM organizations o JOIN org_members m ON m.org_id = o.id WHERE m.gov_user_id = ? AND o.status = 'active' ORDER BY o.id", [req.gov.id]);
    const apps = await q("SELECT id, type, status, data, created_at FROM applications WHERE gov_user_id = ? AND type IN ('org','license') AND status IN ('pending','awaiting_payment') ORDER BY id DESC", [req.gov.id]);
    return { orgs: rows.map(orgView), kinds: ORG_KINDS, license_kinds: LICENSE_KINDS, pending: apps };
  });

  app.post('/orgs/apply', auth, async (req) => {
    const b = req.body || {};
    const kind = String(b.kind || '');
    need(kind === 'llc' || kind === 'jsc', 'Вид организации: ООО или АО');
    const name = str(b.name, 'название', { min: 2, max: 100 });
    const a = await tx(async (conn) => {
      const citizen = await citizenOf(req.gov.id, conn);
      if (!citizen || !(await activePassport(citizen.id, conn))) throw bad('no_passport', 'Сначала получите паспорт БФ');
      const inn = await one("SELECT id FROM documents WHERE citizen_id = ? AND type = 'inn' AND status = 'active'", [citizen.id], conn);
      if (!inn) throw bad('no_inn', 'Для регистрации организации нужен ИНН');
      if (await one("SELECT id FROM applications WHERE gov_user_id = ? AND type = 'org' AND status IN ('pending','awaiting_payment')", [req.gov.id], conn)) throw bad('already_pending', 'Заявление уже подано');
      const res = await submitApplication(conn, { govUserId: req.gov.id, citizenId: citizen.id, type: 'org', data: { kind, name } });
      await audit(conn, actor(req), 'gov.org_apply', 'application', res.id);
      return res;
    });
    return { application: { id: a.id, status: a.status } };
  });

  app.get('/orgs/:id', auth, async (req) => {
    const org = await memberOrg(null, int(req.params.id, 'id'), req.gov.id);
    const month = await currentMonth();
    const acc = await one('SELECT id, number, balance, status FROM accounts WHERE id = ?', [org.account_id]);
    const history = await q(
      `SELECT e.id, e.amount, e.balance_after, t.kind, t.memo, t.created_at FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id
       WHERE e.account_id = ? ORDER BY e.id DESC LIMIT 30`, [org.account_id],
    );
    const members = await q('SELECT m.gov_user_id, m.role, c.full_name, c.passport_no FROM org_members m LEFT JOIN citizens c ON c.gov_user_id = m.gov_user_id WHERE m.org_id = ? ORDER BY m.role, c.full_name', [org.id]);
    const licenses = await q('SELECT kind, number, status, issued_month, expires_month FROM licenses WHERE org_id = ? ORDER BY id DESC', [org.id]);
    const tlds = await q('SELECT * FROM tlds WHERE active = 1 ORDER BY name');
    const isRegistrar = await hasLicense(null, org.id, 'registrar', month);
    const prices = isRegistrar ? await q('SELECT tld_id, price FROM registrar_prices WHERE org_id = ?', [org.id]) : [];
    const s = await getSettings();
    const registrarTlds = isRegistrar ? await Promise.all(tlds.filter((t) => !t.restricted).map(async (t) => {
      const w = await wholesale(null, t);
      // Минимальная цена: после НДС регистратору должно хватить на оптовую цену реестра.
      const min = Math.ceil((w * (10000 + Number(s.vat_bp || 0))) / 10000);
      return { id: t.id, name: disp(t.name), wholesale: w, min_price: min, price: prices.find((p) => p.tld_id === t.id)?.price ?? null };
    })) : [];
    const registry = tlds.filter((t) => t.registry_org_id === org.id).map((t) => ({ id: t.id, name: disp(t.name), wholesale_price: Number(t.wholesale_price) }));
    const domains = isRegistrar ? await q("SELECT name, status, expires_month FROM domains WHERE registrar_org_id = ? AND status <> 'released' ORDER BY name LIMIT 200", [org.id]) : [];
    return {
      org: { ...orgView(org), account: acc ? { ...acc, balance: Number(acc.balance) } : null },
      history: history.map((h) => ({ ...h, amount: Number(h.amount), balance_after: Number(h.balance_after) })),
      members, licenses, is_registrar: isRegistrar, registrar_tlds: registrarTlds, registry, sold_domains: domains.map((d) => ({ ...d, name: disp(d.name) })),
    };
  });

  app.post('/orgs/:id/members', auth, async (req) => {
    await tx(async (conn) => {
      const org = await memberOrg(conn, int(req.params.id, 'id'), req.gov.id, { directorOnly: true });
      const c = await one('SELECT gov_user_id FROM citizens WHERE passport_no = ?', [String(req.body?.passport || '').trim().toUpperCase()], conn);
      if (!c) throw notFound('Гражданин с таким паспортом не найден');
      if (await one('SELECT role FROM org_members WHERE org_id = ? AND gov_user_id = ?', [org.id, c.gov_user_id], conn)) throw bad('already_member', 'Уже сотрудник');
      await q("INSERT INTO org_members (org_id, gov_user_id, role) VALUES (?, ?, 'staff')", [org.id, c.gov_user_id], conn);
      await audit(conn, actor(req), 'org.member_add', 'organization', org.id, { gov_user_id: c.gov_user_id });
    });
    return { ok: true };
  });

  app.delete('/orgs/:id/members/:uid', auth, async (req) => {
    await tx(async (conn) => {
      const org = await memberOrg(conn, int(req.params.id, 'id'), req.gov.id, { directorOnly: true });
      const uid = int(req.params.uid, 'uid');
      need(uid !== req.gov.id, 'Директор не может уволить себя');
      await q("DELETE FROM org_members WHERE org_id = ? AND gov_user_id = ? AND role = 'staff'", [org.id, uid], conn);
      await audit(conn, actor(req), 'org.member_remove', 'organization', org.id, { gov_user_id: uid });
    });
    return { ok: true };
  });

  // Перевод со счёта организации на любой счёт ВлодБанка (зарплата, вывод прибыли, оплата поставщику).
  app.post('/orgs/:id/transfer', auth, async (req) => {
    const b = req.body || {};
    const sum = amountArg(b.amount);
    const r = await tx(async (conn) => {
      const org = await memberOrg(conn, int(req.params.id, 'id'), req.gov.id, { directorOnly: true });
      const to = await one("SELECT id, status FROM accounts WHERE number = ? AND owner_kind <> 'system'", [String(b.to || '').trim().toUpperCase()], conn);
      if (!to) throw notFound('Счёт получателя не найден');
      need(to.id !== org.account_id, 'Это счёт самой организации');
      const res = await post(conn, {
        kind: 'org_transfer', memo: str(b.memo, 'назначение', { optional: true, max: 120 }) || `Перевод от ${ORG_KINDS[org.kind]} «${org.name}»`,
        entries: [{ account: org.account_id, amount: -sum }, { account: to.id, amount: sum }], actor: actor(req), idem: req.headers['idempotency-key'] ? `org:${org.id}:${req.headers['idempotency-key']}` : null,
      });
      await audit(conn, actor(req), 'org.transfer', 'organization', org.id, { to: b.to, amount: sum });
      return res;
    });
    return { ok: true, tx: r.id };
  });

  app.post('/orgs/:id/pay-invoice', auth, async (req) => {
    const r = await tx(async (conn) => {
      const org = await memberOrg(conn, int(req.params.id, 'id'), req.gov.id, { directorOnly: true });
      return payInvoice(conn, String(req.body?.number || '').trim().toUpperCase(), { fromAccount: org.account_id, via: 'bank', actor: actor(req) });
    });
    return { ok: true, tx: r.tx };
  });

  app.post('/orgs/:id/licenses', auth, async (req) => {
    const kind = String(req.body?.kind || '');
    need(LICENSE_KINDS[kind]?.applicable, 'Эту лицензию выдаёт только администрация БалНета');
    const a = await tx(async (conn) => {
      const org = await memberOrg(conn, int(req.params.id, 'id'), req.gov.id, { directorOnly: true });
      need(org.kind !== 'gov', 'Госучреждениям лицензию выдаёт администрация');
      if (await hasLicense(conn, org.id, kind, await currentMonth(conn))) throw bad('already_have', 'Лицензия уже действует');
      if (await one("SELECT id FROM applications WHERE type = 'license' AND status IN ('pending','awaiting_payment') AND JSON_EXTRACT(data, '$.org_id') = ? AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.kind')) = ?", [org.id, kind], conn)) throw bad('already_pending', 'Заявление уже подано');
      const citizen = await citizenOf(req.gov.id, conn);
      const res = await submitApplication(conn, { govUserId: req.gov.id, citizenId: citizen?.id || null, type: 'license', data: { org_id: org.id, kind, org_name: org.name, title: LICENSE_KINDS[kind].title } });
      await audit(conn, actor(req), 'org.license_apply', 'application', res.id, { kind });
      return res;
    });
    return { application: { id: a.id, status: a.status } };
  });

  // Цены регистратора на зоны (null — не продавать).
  app.put('/orgs/:id/prices', auth, async (req) => {
    const b = req.body || {};
    await tx(async (conn) => {
      const org = await memberOrg(conn, int(req.params.id, 'id'), req.gov.id, { directorOnly: true });
      need(await hasLicense(conn, org.id, 'registrar', await currentMonth(conn)), 'Нужна лицензия регистратора');
      const tld = await one('SELECT * FROM tlds WHERE id = ? AND active = 1', [int(b.tld_id, 'зона')], conn);
      if (!tld || tld.restricted) throw notFound('Зона не найдена');
      if (b.price === null || b.price === '') {
        await q('DELETE FROM registrar_prices WHERE org_id = ? AND tld_id = ?', [org.id, tld.id], conn);
        return;
      }
      const price = amountArg(b.price, 'цена');
      const s = await getSettings();
      need(price - vatIncluded(price, Number(s.vat_bp || 0)) >= (await wholesale(conn, tld)), 'Цена после НДС должна покрывать оптовую цену реестра', 'price_below_wholesale');
      await q('INSERT INTO registrar_prices (org_id, tld_id, price) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE price = VALUES(price)', [org.id, tld.id, price], conn);
      await audit(conn, actor(req), 'org.registrar_price', 'organization', org.id, { tld: tld.name, price });
    });
    return { ok: true };
  });

  // Реестр зоны задаёт оптовую цену.
  app.put('/orgs/:id/registry/:tld', auth, async (req) => {
    await tx(async (conn) => {
      const org = await memberOrg(conn, int(req.params.id, 'id'), req.gov.id, { directorOnly: true });
      const tld = await one('SELECT * FROM tlds WHERE id = ? AND registry_org_id = ?', [int(req.params.tld, 'зона'), org.id], conn);
      if (!tld) throw notFound('Организация не ведёт эту зону');
      const price = int(req.body?.wholesale_price, 'оптовая цена', { min: 0, max: 1e12 });
      await q('UPDATE tlds SET wholesale_price = ? WHERE id = ?', [price, tld.id], conn);
      await audit(conn, actor(req), 'org.registry_price', 'organization', org.id, { tld: tld.name, price });
    });
    return { ok: true };
  });

  // ——— Домены ———
  app.get('/domains/check', auth, async (req) => {
    const month = await currentMonth();
    const { name, tld } = await parseDomain(null, req.query.name);
    const av = await availability(null, name, tld);
    return { name: disp(name), tld: disp(tld.name), restricted: tld.restricted, ...av, offers: av.free ? await registrarOffers(null, tld, month) : [] };
  });

  app.get('/domains', auth, async (req) => {
    const rows = await q(
      `SELECT d.* FROM domains d LEFT JOIN org_members m ON m.org_id = d.owner_org_id AND m.gov_user_id = ?
       WHERE d.status <> 'released' AND (d.owner_gov_user_id = ? OR m.gov_user_id IS NOT NULL) ORDER BY d.name`, [req.gov.id, req.gov.id],
    );
    const tlds = await q('SELECT id, name, restricted FROM tlds WHERE active = 1 ORDER BY name');
    const auctions = await q("SELECT a.*, (SELECT MAX(amount) FROM auction_bids b WHERE b.auction_id = a.id) AS top, (SELECT COUNT(*) FROM auction_bids b WHERE b.auction_id = a.id) AS bids, (SELECT MAX(amount) FROM auction_bids b WHERE b.auction_id = a.id AND b.gov_user_id = ?) AS my_bid FROM auctions a WHERE a.status IN ('open','awaiting_payment') ORDER BY a.ends_month, a.id", [req.gov.id]);
    const s = await getSettings();
    return {
      domains: await Promise.all(rows.map((d) => domainView(null, d))),
      tlds: tlds.map((t) => ({ ...t, name: disp(t.name) })),
      auctions: auctions.map((a) => ({ id: a.id, name: disp(a.name), status: a.status, reason: a.reason, min_bid: Number(a.min_bid), top: a.top ? Number(a.top) : null, bids: Number(a.bids), my_bid: a.my_bid ? Number(a.my_bid) : null, ends_month: a.ends_month, winner_me: a.winner_gov_user_id === req.gov.id })),
      month: await currentMonth(),
      max_years: Number(s.domain_max_years || 10),
      redemption_fee: Number(s.domain_redemption_fee || 0),
    };
  });

  app.post('/domains', auth, async (req) => {
    const b = req.body || {};
    const r = await tx(async (conn) => {
      const citizen = await citizenOf(req.gov.id, conn);
      if (!citizen || !(await activePassport(citizen.id, conn))) throw bad('no_passport', 'Домены регистрируют граждане с паспортом БФ');
      const res = await registerDomain(conn, { govUserId: req.gov.id, name: b.name, registrarOrgId: b.registrar_org_id ? int(b.registrar_org_id, 'регистратор') : null, years: b.years, ownerOrgId: b.owner_org_id ? int(b.owner_org_id, 'организация') : null });
      await audit(conn, actor(req), 'domain.register', 'domain', res.domain_id, { name: b.name });
      return res;
    });
    return r;
  });

  app.get('/domains/:id', auth, async (req) => {
    const d = await ownDomain(null, int(req.params.id, 'id'), req.gov.id);
    const records = d.zone_id ? await q('SELECT id, name, type, ttl, data FROM dns_records WHERE zone_id = ? ORDER BY name, type, id', [d.zone_id]) : [];
    const tld = await one('SELECT * FROM tlds WHERE id = ?', [d.tld_id]);
    return {
      domain: await domainView(null, d, { withAuth: true }),
      records: records.map((r) => ({ ...r, rel: relativeName(r.name, d.name), locked: r.type === 'SOA' || (r.type === 'NS' && r.name === d.name) })),
      offers: await registrarOffers(null, tld, await currentMonth()),
    };
  });

  app.post('/domains/:id/renew', auth, async (req) => {
    const r = await tx(async (conn) => renewDomain(conn, { govUserId: req.gov.id, id: int(req.params.id, 'id'), years: req.body?.years }));
    return r;
  });

  app.post('/domains/:id/transfer-registrar', auth, async (req) => {
    const b = req.body || {};
    return tx(async (conn) => transferRegistrar(conn, { govUserId: req.gov.id, id: int(req.params.id, 'id'), registrarOrgId: b.registrar_org_id ? int(b.registrar_org_id, 'регистратор') : null, authCode: b.auth_code }));
  });

  app.post('/domains/claim', auth, async (req) => {
    const b = req.body || {};
    const r = await tx(async (conn) => {
      const res = await claimDomain(conn, { govUserId: req.gov.id, name: b.name, authCode: b.auth_code, ownerOrgId: b.owner_org_id ? int(b.owner_org_id, 'организация') : null });
      await audit(conn, actor(req), 'domain.claim', 'domain', res.id);
      return res;
    });
    return r;
  });

  app.post('/domains/:id/auth-code', auth, async (req) => {
    await tx(async (conn) => {
      const d = await ownDomain(conn, int(req.params.id, 'id'), req.gov.id, { lock: true });
      await q('UPDATE domains SET auth_code = ? WHERE id = ?', [newAuthCode(), d.id], conn);
    });
    return { ok: true };
  });

  app.post('/domains/:id/privacy', auth, async (req) => {
    const d = await ownDomain(null, int(req.params.id, 'id'), req.gov.id);
    await q('UPDATE domains SET privacy = ? WHERE id = ?', [req.body?.privacy ? 1 : 0, d.id]);
    return { ok: true };
  });

  app.post('/domains/:id/nameservers', auth, async (req) => {
    const b = req.body || {};
    await tx(async (conn) => setNameservers(conn, { govUserId: req.gov.id, id: int(req.params.id, 'id'), mode: b.mode === 'custom' ? 'custom' : 'hosted', ns: b.ns }));
    return { ok: true };
  });

  // Записи зоны на DNS-хостинге БалНета.
  async function hostedZone(conn, req) {
    const d = await ownDomain(conn, int(req.params.id, 'id'), req.gov.id, { lock: !!conn });
    need(d.zone_id, 'У домена нет зоны на DNS-хостинге БалНета');
    return { d, zone: await one('SELECT * FROM dns_zones WHERE id = ?', [d.zone_id], conn) };
  }

  app.post('/domains/:id/records', auth, async (req) => {
    await tx(async (conn) => {
      const { zone } = await hostedZone(conn, req);
      const rec = recordArgs(zone, req.body || {});
      need(!['SOA', 'NS'].includes(rec.type) || rec.name !== zone.name, 'SOA и NS вершины зоны задаёт DNS-хостинг');
      await checkRecord(conn, zone, rec);
      need(!(await one('SELECT id FROM dns_records WHERE zone_id = ? AND name = ? AND type = ? AND data = ?', [zone.id, rec.name, rec.type, rec.data], conn)), 'Такая запись уже есть');
      const count = await one('SELECT COUNT(*) AS n FROM dns_records WHERE zone_id = ?', [zone.id], conn);
      need(Number(count.n) < 200, 'В зоне не больше 200 записей');
      await q('INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, ?, ?, ?)', [zone.id, rec.name, rec.type, rec.ttl, rec.data], conn);
      await q('UPDATE dns_records SET ttl = ? WHERE zone_id = ? AND name = ? AND type = ?', [rec.ttl, zone.id, rec.name, rec.type], conn);
      await bumpSerial(conn, zone.id);
    });
    invalidateNet();
    return { ok: true };
  });

  app.patch('/domains/:id/records/:rid', auth, async (req) => {
    await tx(async (conn) => {
      const { zone } = await hostedZone(conn, req);
      const cur = await one('SELECT * FROM dns_records WHERE id = ? AND zone_id = ?', [int(req.params.rid, 'id'), zone.id], conn);
      if (!cur) throw notFound('Запись не найдена');
      need(!(cur.type === 'SOA' || (cur.type === 'NS' && cur.name === zone.name)), 'Эту запись задаёт DNS-хостинг');
      const b = req.body || {};
      const rec = recordArgs(zone, { name: b.name ?? cur.name, type: b.type ?? cur.type, ttl: b.ttl ?? cur.ttl, data: b.data ?? cur.data });
      need(!['SOA', 'NS'].includes(rec.type) || rec.name !== zone.name, 'SOA и NS вершины зоны задаёт DNS-хостинг');
      await checkRecord(conn, zone, rec, cur.id);
      await q('UPDATE dns_records SET name = ?, type = ?, ttl = ?, data = ? WHERE id = ?', [rec.name, rec.type, rec.ttl, rec.data, cur.id], conn);
      await bumpSerial(conn, zone.id);
    });
    invalidateNet();
    return { ok: true };
  });

  app.delete('/domains/:id/records/:rid', auth, async (req) => {
    await tx(async (conn) => {
      const { zone } = await hostedZone(conn, req);
      const cur = await one('SELECT * FROM dns_records WHERE id = ? AND zone_id = ?', [int(req.params.rid, 'id'), zone.id], conn);
      if (!cur) throw notFound('Запись не найдена');
      need(!(cur.type === 'SOA' || (cur.type === 'NS' && cur.name === zone.name)), 'Эту запись задаёт DNS-хостинг');
      await q('DELETE FROM dns_records WHERE id = ?', [cur.id], conn);
      await bumpSerial(conn, zone.id);
    });
    invalidateNet();
    return { ok: true };
  });

  app.post('/auctions/:id/bid', auth, async (req) => {
    const r = await tx(async (conn) => {
      const citizen = await citizenOf(req.gov.id, conn);
      if (!citizen || !(await activePassport(citizen.id, conn))) throw bad('no_passport', 'Участвовать могут граждане с паспортом БФ');
      return placeBid(conn, { govUserId: req.gov.id, auctionId: int(req.params.id, 'id'), amount: amountArg(req.body?.amount, 'ставка') });
    });
    return r;
  });
}
