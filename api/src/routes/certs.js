// БалСерт (ca.gov.bln) и SSL в панели хостинга: заявки на проверку домена, заказ сертификатов, отзыв, установка,
// УЦ организаций, поиск по журналу прозрачности. Админка: хранилище доверия и отзыв УЦ.
import { tx, q, one } from '../db.js';
import { notFound, need, int } from '../lib/errors.js';
import { needGov, needAdmin, actorOf } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { citizenOf, activePassport } from '../lib/gov.js';
import { memberOrg } from '../lib/orgs.js';
import { ownAccount } from '../lib/hosting.js';
import { invalidateNet } from '../lib/net.js';
import {
  ensurePki, caList, ctSearch, createChallenge, challengeView, validateChallenge, orderCert, selfSigned, ownCert, certView,
  revokeCert, installCert, autoSsl, createOrgCa, setCaPrices, govCa, POLICIES, REVOKE_REASONS, resetPkiCache,
} from '../lib/pki.js';

const parse = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
const pem = (label, b64) => `-----BEGIN ${label}-----\n${b64.match(/.{1,64}/g).join('\n')}\n-----END ${label}-----\n`;

async function needPassport(conn, govUserId) {
  const citizen = await citizenOf(govUserId, conn);
  need(citizen && (await activePassport(citizen.id, conn)), 'Сертификаты заказывают граждане с паспортом БФ');
}

export async function certRoutes(app) {
  const auth = { preHandler: needGov() };
  const actor = (req) => actorOf(req.gov);

  // ——— Публично ———
  app.get('/certs/cas', async () => ({ cas: await caList(null), policies: POLICIES }));
  app.get('/certs/ct', async (req) => ({ entries: await ctSearch(req.query.q) }));

  // ——— Мои сертификаты ———
  app.get('/certs', auth, async (req) => {
    const rows = await q(
      `SELECT DISTINCT c.* FROM pki_certs c LEFT JOIN org_members m ON m.org_id = c.owner_org_id AND m.gov_user_id = ?
       WHERE c.gov_site = 0 AND (c.owner_gov_user_id = ? OR m.gov_user_id IS NOT NULL) ORDER BY c.id DESC LIMIT 200`, [req.gov.id, req.gov.id],
    );
    const certs = [];
    for (const c of rows) certs.push(await certView(null, c));
    const orders = await q("SELECT id, policy, amount, status, cert_id, created_at FROM pki_orders WHERE gov_user_id = ? AND status = 'pending' ORDER BY id DESC", [req.gov.id]);
    const myCas = await q("SELECT c.id, c.name, c.identifier, c.org_id, c.prices, c.status, r.trusted FROM pki_cas c JOIN org_members m ON m.org_id = c.org_id AND m.gov_user_id = ? LEFT JOIN pki_cas r ON r.id = c.parent_id WHERE c.kind = 'ca'", [req.gov.id]);
    return { certs, orders, my_cas: myCas.map((c) => ({ ...c, prices: parse(c.prices), trusted: !!c.trusted })), reasons: REVOKE_REASONS };
  });

  app.get('/certs/:id', auth, async (req) => {
    const c = await ownCert(null, int(req.params.id, 'id'), req.gov.id);
    return { cert: await certView(null, c) };
  });

  // Закрытый ключ и сертификат — для установки на свой сервер (как у настоящих УЦ).
  app.get('/certs/:id/files', auth, async (req) => {
    const c = await ownCert(null, int(req.params.id, 'id'), req.gov.id);
    return { key: pem('PRIVATE KEY', c.pkcs8), cert: JSON.stringify(parse(c.cert), null, 2) };
  });

  // ——— Проверка домена и заказ ———
  app.post('/certs/challenges', auth, async (req) => tx(async (conn) => {
    await needPassport(conn, req.gov.id);
    return createChallenge(conn, { govUserId: req.gov.id, names: req.body?.names, method: req.body?.method });
  }));

  app.get('/certs/challenges/:id', auth, async (req) => {
    const c = await one('SELECT * FROM pki_challenges WHERE id = ? AND gov_user_id = ?', [int(req.params.id, 'id'), req.gov.id]);
    if (!c) throw notFound('Заявка не найдена');
    return challengeView(c);
  });

  /** Предварительная проверка (ничего не выпускает). */
  app.post('/certs/challenges/:id/check', auth, async (req) => {
    const c = await one('SELECT * FROM pki_challenges WHERE id = ? AND gov_user_id = ?', [int(req.params.id, 'id'), req.gov.id]);
    if (!c) throw notFound('Заявка не найдена');
    const ca = req.body?.ca_id ? await one("SELECT * FROM pki_cas WHERE id = ? AND kind = 'ca'", [int(req.body.ca_id, 'УЦ')]) : await govCa(null);
    if (!ca) throw notFound('УЦ не найден');
    return validateChallenge(c, ca.identifier || '');
  });

  app.post('/certs/orders', auth, async (req) => {
    const b = req.body || {};
    return tx(async (conn) => {
      await needPassport(conn, req.gov.id);
      const r = await orderCert(conn, {
        govUserId: req.gov.id, challengeId: int(b.challenge_id, 'заявка'), caId: b.ca_id ? int(b.ca_id, 'УЦ') : null,
        policy: String(b.policy || 'DV'), ownerOrgId: b.owner_org_id ? int(b.owner_org_id, 'организация') : null,
      });
      if (r.cert_id) await audit(conn, actor(req), 'cert.issue', 'cert', r.cert_id);
      return r;
    });
  });

  app.post('/certs/self', auth, async (req) => tx(async (conn) => {
    const orgId = req.body?.owner_org_id ? int(req.body.owner_org_id, 'организация') : null;
    if (orgId) await memberOrg(conn, orgId, req.gov.id);
    const id = await selfSigned(conn, { govUserId: req.gov.id, names: req.body?.names, ownerOrg: orgId });
    return { cert_id: id };
  }));

  app.post('/certs/:id/revoke', auth, async (req) => tx(async (conn) => {
    const c = await ownCert(conn, int(req.params.id, 'id'), req.gov.id);
    await revokeCert(conn, c, String(req.body?.reason || 'unspecified'));
    await audit(conn, actor(req), 'cert.revoke', 'cert', c.id, { reason: req.body?.reason });
    return { ok: true };
  }));

  // ——— Панель хостинга: SSL сайта ———
  async function siteOf(conn, req) {
    const a = await ownAccount(conn, int(req.params.id, 'id'), req.gov.id);
    const s = await one('SELECT * FROM hosting_sites WHERE id = ? AND account_id = ?', [int(req.params.sid, 'сайт'), a.id], conn);
    if (!s) throw notFound('Сайт не найден');
    return { a, s };
  }

  app.post('/hosting/:id/sites/:sid/ssl', auth, async (req) => tx(async (conn) => {
    const { a, s } = await siteOf(conn, req);
    const r = await autoSsl(conn, { site: s, account: a, govUserId: req.gov.id });
    if (r.ok) await audit(conn, actor(req), 'cert.autossl', 'cert', r.cert_id, { host: s.host });
    return r;
  }));

  app.put('/hosting/:id/sites/:sid/cert', auth, async (req) => tx(async (conn) => {
    const { s } = await siteOf(conn, req);
    const certId = req.body?.cert_id ? int(req.body.cert_id, 'сертификат') : null;
    await installCert(conn, { site: s, certId, govUserId: req.gov.id });
    return { ok: true };
  }));

  // ——— УЦ организации ———
  app.post('/certs/org-ca', auth, async (req) => tx(async (conn) => {
    const orgId = int(req.body?.org_id, 'организация');
    await memberOrg(conn, orgId, req.gov.id, { directorOnly: true });
    const r = await createOrgCa(conn, { orgId, name: req.body?.name, identifier: req.body?.identifier });
    await audit(conn, actor(req), 'ca.create', 'pki_ca', r.ca_id);
    return r;
  }));

  app.patch('/certs/org-ca/:id', auth, async (req) => tx(async (conn) => {
    const ca = await one("SELECT * FROM pki_cas WHERE id = ? AND kind = 'ca' AND org_id IS NOT NULL", [int(req.params.id, 'id')], conn);
    if (!ca) throw notFound('УЦ не найден');
    await memberOrg(conn, ca.org_id, req.gov.id, { directorOnly: true });
    await setCaPrices(conn, { caId: ca.id, prices: req.body?.prices });
    return { ok: true };
  }));
}

export async function adminPkiRoutes(app) {
  app.addHook('preHandler', needAdmin());
  const actor = (req) => actorOf(req.actor);

  app.get('/cas', async () => {
    await ensurePki();
    const rows = await q('SELECT c.id, c.org_id, c.parent_id, c.kind, c.name, c.identifier, c.trusted, c.status, c.ski, c.created_at, o.name AS org_name FROM pki_cas c LEFT JOIN organizations o ON o.id = c.org_id ORDER BY c.id');
    const counts = await q('SELECT ca_id, COUNT(*) AS n, SUM(status = \'revoked\') AS revoked FROM pki_certs GROUP BY ca_id');
    const logs = await q('SELECT l.log_id, l.name, COUNT(e.idx) AS entries FROM pki_ct_logs l LEFT JOIN pki_ct_entries e ON e.log_id = l.log_id GROUP BY l.log_id, l.name');
    return { cas: rows.map((c) => ({ ...c, trusted: !!c.trusted, issued: Number(counts.find((x) => x.ca_id === c.id)?.n || 0) })), logs };
  });

  /** Включить/исключить корень из хранилища доверия браузеров. */
  app.patch('/cas/:id', async (req) => {
    const id = int(req.params.id, 'id');
    const ca = await one("SELECT * FROM pki_cas WHERE id = ? AND kind = 'root'", [id]);
    if (!ca) throw notFound('Корневой УЦ не найден');
    await q('UPDATE pki_cas SET trusted = ? WHERE id = ?', [req.body?.trusted ? 1 : 0, id]);
    resetPkiCache();
    await audit(null, actor(req), req.body?.trusted ? 'ca.trust' : 'ca.distrust', 'pki_ca', id);
    return { ok: true };
  });

  /** Отзыв УЦ: все его сертификаты перестают открываться (CRLSet в браузере). */
  app.post('/cas/:id/revoke', async (req) => {
    const id = int(req.params.id, 'id');
    need(await one('SELECT id FROM pki_cas WHERE id = ?', [id]), 'УЦ не найден');
    await q("UPDATE pki_cas SET status = 'revoked' WHERE id = ?", [id]);
    resetPkiCache();
    await audit(null, actor(req), 'ca.revoke', 'pki_ca', id);
    return { ok: true };
  });

  app.get('/certs', async (req) => {
    const s = String(req.query.q || '').trim().toLowerCase();
    const rows = await q(`SELECT * FROM pki_certs ${s ? 'WHERE names LIKE ?' : ''} ORDER BY id DESC LIMIT 100`, s ? [`%${s.replace(/[%_\\]/g, '\\$&')}%`] : []);
    const out = [];
    for (const c of rows) out.push(await certView(null, c));
    return { certs: out.map(({ cert, ...v }) => v) };
  });

  app.post('/certs/:id/revoke', async (req) => {
    const c = await one('SELECT * FROM pki_certs WHERE id = ?', [int(req.params.id, 'id')]);
    if (!c) throw notFound('Сертификат не найден');
    await tx((conn) => revokeCert(conn, c, String(req.body?.reason || 'unspecified')));
    invalidateNet();
    await audit(null, actor(req), 'cert.revoke', 'cert', c.id);
    return { ok: true };
  });
}
