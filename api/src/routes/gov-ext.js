// Этап 8. ВлодУслуги, расширение: налоги, штрафы и обжалования, пособия, имущество,
// врач и страховка, выборы, визы, обращения, новости. Рабочие места полицейского,
// налогового инспектора, врача и чиновника.
import { tx, q, one, json } from '../db.js';
import { bad, notFound, forbidden, int, str, amount as amountOf, need } from '../lib/errors.js';
import { needGov, needRole, actorOf } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { getSettings } from '../lib/settings.js';
import { currentMonth } from '../lib/clock.js';
import { citizenOf, activePassport, publicInvoice } from '../lib/gov.js';
import {
  issueFine, appealFine, submitDeclaration, assessTax, overdueInvoices, activeSanctions, applyBenefit, decideBenefit, benefitAmount, BENEFIT_TITLES,
  isInsured, buyInsurance, offerProperty, requestPurchase, propertyView, dealView, citizenByPassport, notifyCitizen,
} from '../lib/state.js';
import { ageFrom } from '@bln/shared/format.js';

const STAFF_ROLES = ['official', 'police', 'tax', 'doctor'];

export function fineView(f) {
  return {
    id: f.id, citizen_id: f.citizen_id, full_name: f.full_name, passport_no: f.passport_no, article_id: f.article_id, article: f.article_text, amount: Number(f.amount), note: f.note,
    status: f.status, invoice: f.invoice_number || null, invoice_amount: f.invoice_amount === undefined || f.invoice_amount === null ? null : Number(f.invoice_amount),
    appeal_status: f.appeal_status, appeal_text: f.appeal_text, appeal_note: f.appeal_note, created_at: f.created_at, officer: f.officer || null,
  };
}

export function declView(d) {
  return {
    id: d.id, year: d.year, document_id: d.document_id, period_from: d.period_from, period_to: d.period_to, income_auto: Number(d.income_auto), income: d.income === null ? null : Number(d.income),
    rate_bp: d.rate_bp, tax: d.tax === null ? null : Number(d.tax), status: d.status, due_month: d.due_month, invoice: d.invoice_number || null, full_name: d.full_name, passport_no: d.passport_no, submitted_at: d.submitted_at,
  };
}

function sanctionView(s) {
  return { id: s.id, citizen_id: s.citizen_id, kind: s.kind, reason: s.reason, active: !!s.active, created_at: s.created_at, lifted_at: s.lifted_at, full_name: s.full_name, passport_no: s.passport_no };
}

function slotView(s) {
  return {
    id: s.id, doctor: s.doctor_name, doctor_gov_user_id: s.doctor_gov_user_id, starts_at: s.starts_at, duration_min: s.duration_min, priority: !!s.priority, status: s.status,
    patient: s.patient_name || undefined, patient_passport: s.patient_passport || undefined, insured: !!s.insured, complaint: s.complaint, conclusion: s.conclusion, done_at: s.done_at,
  };
}

function appealView(a) {
  return { id: a.id, addressee: a.addressee, subject: a.subject, body: a.body, status: a.status, answer: a.answer, created_at: a.created_at, answered_at: a.answered_at, author: a.author || undefined };
}

export async function electionsView(conn, citizenId, { admin = false } = {}) {
  const els = await q("SELECT * FROM elections WHERE status <> 'cancelled' OR ? ORDER BY id DESC LIMIT 30", [admin ? 1 : 0], conn);
  const out = [];
  for (const e of els) {
    const cands = await q("SELECT c.id, c.citizen_id, c.program, c.status, c.votes, z.full_name FROM candidates c JOIN citizens z ON z.id = c.citizen_id WHERE c.election_id = ? AND (c.status = 'approved' OR ?) ORDER BY c.id", [e.id, admin ? 1 : 0], conn);
    const voted = citizenId ? await one('SELECT 1 AS x FROM votes WHERE election_id = ? AND citizen_id = ?', [e.id, citizenId], conn) : null;
    const turnout = await one('SELECT COUNT(*) AS n FROM votes WHERE election_id = ?', [e.id], conn);
    const showVotes = e.status === 'finished' || admin;
    out.push({
      id: e.id, title: e.title, description: e.description, status: e.status, created_at: e.created_at, finished_at: e.finished_at,
      turnout: Number(turnout.n), voted: !!voted, my_candidate: cands.some((c) => c.citizen_id === citizenId),
      candidates: cands.map((c) => ({ id: c.id, full_name: c.full_name, program: c.program, status: c.status, votes: showVotes ? c.votes : undefined, mine: c.citizen_id === citizenId })),
    });
  }
  return out;
}

export async function govExtRoutes(app) {
  const auth = { preHandler: needGov() };
  const police = { preHandler: needRole('police') };
  const taxRole = { preHandler: needRole('tax') };
  const doctor = { preHandler: needRole('doctor') };
  const official = { preHandler: needRole('official') };
  const staff = { preHandler: needRole(...STAFF_ROLES) };

  async function me(req, conn, { passport = true } = {}) {
    const c = await citizenOf(req.gov.id, conn);
    if (!c) throw bad('no_passport', 'Сначала получите паспорт БФ');
    if (passport && !(await activePassport(c.id, conn))) throw bad('no_passport', 'Паспорт недействителен');
    return c;
  }

  // ——— Публичное: новости, страны, статьи штрафов ———
  app.get('/news', async (req) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const rows = await q('SELECT id, kind, title, body, pinned, created_at FROM news ORDER BY pinned DESC, id DESC LIMIT ?', [limit]);
    return { news: rows.map((n) => ({ ...n, pinned: !!n.pinned })) };
  });

  app.get('/countries', async () => ({ countries: (await q('SELECT id, name, code, visa_required, visa_fee, visa_months FROM countries WHERE active = 1 ORDER BY name')).map((c) => ({ ...c, visa_required: !!c.visa_required, visa_fee: Number(c.visa_fee) })) }));

  app.get('/fine-articles', async () => ({ articles: (await q('SELECT id, code, title, amount FROM fine_articles WHERE active = 1 ORDER BY code')).map((a) => ({ ...a, amount: Number(a.amount) })) }));

  // ——— Налоги ———
  app.get('/taxes', auth, async (req) => {
    const c = await citizenOf(req.gov.id);
    if (!c) return { declarations: [], invoices: [], sanctions: [], overdue: 0, property_tax_bp: (await getSettings()).property_tax_bp };
    const month = await currentMonth();
    const decls = await q('SELECT d.*, i.number AS invoice_number FROM tax_declarations d LEFT JOIN invoices i ON i.id = d.invoice_id WHERE d.citizen_id = ? ORDER BY d.year DESC', [c.id]);
    const invs = await q("SELECT * FROM invoices WHERE citizen_id = ? AND kind IN ('tax','fine') AND status <> 'cancelled' ORDER BY status = 'unpaid' DESC, id DESC LIMIT 100", [c.id]);
    const overdue = await overdueInvoices(null, c.id, month);
    const s = await getSettings();
    return {
      month,
      declarations: decls.map(declView),
      invoices: invs.map(publicInvoice),
      overdue: overdue.reduce((x, i) => x + Number(i.amount), 0),
      sanctions: (await activeSanctions(null, c.id)).map(sanctionView),
      rates: { ndfl_bp: s.ndfl_bp, ip_tax_bp: s.ip_tax_bp, property_tax_bp: s.property_tax_bp, vat_bp: s.vat_bp, penalty_bp: s.penalty_bp, sanction_months: s.sanction_months },
    };
  });

  app.post('/taxes/declarations/:id/submit', auth, async (req) => {
    const r = await tx(async (conn) => {
      const c = await me(req, conn, { passport: false });
      const decl = await one('SELECT * FROM tax_declarations WHERE id = ? AND citizen_id = ? FOR UPDATE', [int(req.params.id, 'id'), c.id], conn);
      if (!decl) throw notFound('Декларация не найдена');
      const income = req.body?.income === undefined || req.body?.income === null || req.body?.income === '' ? Number(decl.income_auto) : int(req.body.income, 'доход', { min: 0, max: 1e14 });
      const res = await submitDeclaration(conn, { decl, income });
      await audit(conn, actorOf(req.gov), 'gov.declaration_submit', 'tax_declaration', decl.id, { income });
      return res;
    });
    return r;
  });

  // ——— Штрафы ———
  const FINE_SELECT = `SELECT f.*, i.number AS invoice_number, i.amount AS invoice_amount, c.full_name, c.passport_no, g.display_name AS officer
    FROM fines f JOIN citizens c ON c.id = f.citizen_id LEFT JOIN invoices i ON i.id = f.invoice_id LEFT JOIN gov_users g ON g.id = f.officer_gov_user_id`;

  app.get('/fines', auth, async (req) => {
    const c = await citizenOf(req.gov.id);
    if (!c) return { fines: [] };
    return { fines: (await q(`${FINE_SELECT} WHERE f.citizen_id = ? ORDER BY f.id DESC`, [c.id])).map(fineView) };
  });

  app.post('/fines/:id/appeal', auth, async (req) => {
    await tx(async (conn) => {
      const c = await me(req, conn, { passport: false });
      const fine = await one('SELECT * FROM fines WHERE id = ? AND citizen_id = ? FOR UPDATE', [int(req.params.id, 'id'), c.id], conn);
      if (!fine) throw notFound('Штраф не найден');
      await appealFine(conn, { fine, text: str(req.body?.text, 'текст жалобы', { min: 10, max: 1000 }) });
    });
    return { ok: true };
  });

  // ——— Пособия ———
  app.get('/benefits', auth, async (req) => {
    const c = await citizenOf(req.gov.id);
    const s = await getSettings();
    const rows = c ? await q('SELECT * FROM benefits WHERE citizen_id = ? ORDER BY id DESC', [c.id]) : [];
    const amounts = c ? { child: await benefitAmount(c, 'child', s), pension: await benefitAmount(c, 'pension', s), unemployment: await benefitAmount(c, 'unemployment', s) } : {};
    return {
      benefits: rows.map((b) => ({ id: b.id, kind: b.kind, title: BENEFIT_TITLES[b.kind], status: b.status, months_left: b.months_left, note: b.note, created_at: b.created_at })),
      amounts,
      rules: { pension_age: s.pension_age, unemployment_months: s.benefit_unemployment_months, child_each: s.benefit_child, children: c ? json(c.children, []).length : 0, age: c ? ageFrom(c.birth_date) : null },
    };
  });

  app.post('/benefits', auth, async (req) => {
    const r = await tx(async (conn) => applyBenefit(conn, await me(req, conn), String(req.body?.kind || '')));
    return r;
  });

  // ——— Имущество ———
  const PROP_SELECT = 'SELECT p.*, c.full_name AS owner_name FROM properties p LEFT JOIN citizens c ON c.id = p.owner_citizen_id';
  const DEAL_SELECT = `SELECT d.*, p.title, p.kind, p.reg_number, s.full_name AS seller_name, b.full_name AS buyer_name FROM property_deals d JOIN properties p ON p.id = d.property_id
    LEFT JOIN citizens s ON s.id = d.seller_citizen_id JOIN citizens b ON b.id = d.buyer_citizen_id`;

  app.get('/properties', auth, async (req) => {
    const c = await citizenOf(req.gov.id);
    if (!c) return { properties: [], deals: [] };
    const props = await q(`${PROP_SELECT} WHERE p.owner_citizen_id = ? ORDER BY p.id`, [c.id]);
    const deals = await q(`${DEAL_SELECT} WHERE (d.buyer_citizen_id = ? OR d.seller_citizen_id = ?) ORDER BY d.status IN ('pending','loan') DESC, d.id DESC LIMIT 50`, [c.id, c.id]);
    return { properties: props.map(propertyView), deals: deals.map(dealView), me: c.id };
  });

  app.get('/properties/market', async (req) => {
    const kind = ['car', 'realty'].includes(req.query.kind) ? req.query.kind : null;
    const rows = await q(`${PROP_SELECT} WHERE p.list_price IS NOT NULL AND p.lien_loan_id IS NULL AND p.status = 'active'${kind ? ' AND p.kind = ?' : ''} ORDER BY p.id DESC LIMIT 200`, kind ? [kind] : []);
    return { properties: rows.map((p) => ({ ...propertyView(p), owner_name: p.owner_name || 'Государство БФ' })) };
  });

  app.post('/properties/:id/sell', auth, async (req) => {
    const b = req.body || {};
    const r = await tx(async (conn) => {
      const c = await me(req, conn);
      const p = await one('SELECT * FROM properties WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
      if (!p) throw notFound('Имущество не найдено');
      if (b.unlist) {
        if (p.owner_citizen_id !== c.id) throw forbidden('Это не ваше имущество');
        await q('UPDATE properties SET list_price = NULL WHERE id = ?', [p.id], conn);
        return { ok: true };
      }
      const buyer = b.buyer_passport ? await citizenByPassport(conn, b.buyer_passport) : null;
      const dealId = await offerProperty(conn, { property: p, seller: c, price: amountOf(b.price, 'цена'), buyer });
      return { ok: true, deal_id: dealId };
    });
    return r;
  });

  app.post('/properties/:id/buy', auth, async (req) => {
    const id = await tx(async (conn) => {
      const c = await me(req, conn);
      const p = await one('SELECT * FROM properties WHERE id = ?', [int(req.params.id, 'id')], conn);
      if (!p) throw notFound('Имущество не найдено');
      return requestPurchase(conn, { property: p, buyer: c });
    });
    return { deal_id: id };
  });

  app.post('/deals/:id/cancel', auth, async (req) => {
    await tx(async (conn) => {
      const c = await me(req, conn, { passport: false });
      const d = await one('SELECT * FROM property_deals WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
      if (!d || (d.buyer_citizen_id !== c.id && d.seller_citizen_id !== c.id)) throw notFound('Сделка не найдена');
      if (d.status !== 'pending') throw bad('invalid_state', d.status === 'loan' ? 'По сделке оформляется кредит — дождитесь решения банка' : 'Сделка закрыта');
      await q("UPDATE property_deals SET status = 'cancelled', closed_at = NOW(3) WHERE id = ?", [d.id], conn);
    });
    return { ok: true };
  });

  // ——— Врач и страховка ———
  const SLOT_SELECT = `SELECT s.*, g.display_name AS doctor_name, c.full_name AS patient_name, c.passport_no AS patient_passport FROM doctor_slots s
    JOIN gov_users g ON g.id = s.doctor_gov_user_id LEFT JOIN citizens c ON c.id = s.patient_citizen_id`;

  app.get('/doctor', auth, async (req) => {
    const c = await citizenOf(req.gov.id);
    const month = await currentMonth();
    const free = await q(`${SLOT_SELECT} WHERE s.status = 'free' AND s.starts_at > NOW(3) ORDER BY s.starts_at LIMIT 200`);
    const mine = c ? await q(`${SLOT_SELECT} WHERE s.patient_citizen_id = ? ORDER BY s.starts_at DESC LIMIT 50`, [c.id]) : [];
    const policy = c ? await one("SELECT * FROM insurance_policies WHERE citizen_id = ? AND status = 'active' AND to_month >= ? ORDER BY to_month DESC LIMIT 1", [c.id, month]) : null;
    const pending = c ? await one("SELECT p.*, i.number FROM insurance_policies p LEFT JOIN invoices i ON i.id = p.invoice_id WHERE p.citizen_id = ? AND p.status = 'awaiting_payment'", [c.id]) : null;
    const s = await getSettings();
    return {
      free: free.map(slotView),
      visits: mine.map(slotView),
      insured: c ? await isInsured(null, c.id, month) : false,
      insurance: policy ? { from_month: policy.from_month, to_month: policy.to_month } : null,
      insurance_invoice: pending?.number || null,
      insurance_price: Number(s.insurance_price),
      insurance_months: s.insurance_months,
    };
  });

  app.post('/doctor/slots/:id/book', auth, async (req) => {
    await tx(async (conn) => {
      const c = await me(req, conn);
      const slot = await one('SELECT * FROM doctor_slots WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
      if (!slot || slot.status !== 'free' || new Date(slot.starts_at) <= new Date()) throw bad('slot_taken', 'Время уже занято');
      const insured = await isInsured(conn, c.id, await currentMonth(conn));
      if (slot.priority && !insured) throw bad('need_insurance', 'Это время — только для пациентов со страховкой');
      const active = await one("SELECT COUNT(*) AS n FROM doctor_slots WHERE patient_citizen_id = ? AND status = 'booked'", [c.id], conn);
      if (Number(active.n) >= 3) throw bad('too_many', 'Не больше трёх записей одновременно');
      await q("UPDATE doctor_slots SET status = 'booked', patient_citizen_id = ?, insured = ?, complaint = ?, booked_at = NOW(3) WHERE id = ?", [c.id, insured ? 1 : 0, str(req.body?.complaint, 'жалобы', { optional: true, max: 500 }), slot.id], conn);
      await q('INSERT INTO notifications (user_kind, user_id, title, body, link) VALUES (?, ?, ?, ?, ?)', ['gov', slot.doctor_gov_user_id, 'Новая запись на приём', `${c.full_name}${insured ? ' · страховка' : ''}`, '#/work/doctor'], conn);
    });
    return { ok: true };
  });

  app.post('/doctor/slots/:id/cancel', auth, async (req) => {
    const c = await citizenOf(req.gov.id);
    const r = await q("UPDATE doctor_slots SET status = 'free', patient_citizen_id = NULL, insured = 0, complaint = NULL, booked_at = NULL WHERE id = ? AND patient_citizen_id = ? AND status = 'booked'", [int(req.params.id, 'id'), c?.id || 0]);
    if (!r.affectedRows) throw notFound('Запись не найдена');
    return { ok: true };
  });

  app.post('/insurance', auth, async (req) => {
    const r = await tx(async (conn) => buyInsurance(conn, await me(req, conn)));
    return r;
  });

  // ——— Выборы: один паспорт — один голос ———
  app.get('/elections', auth, async (req) => {
    const c = await citizenOf(req.gov.id);
    return { elections: await electionsView(null, c?.id || null), vote_age: (await getSettings()).vote_age };
  });

  async function voter(req, conn) {
    const c = await me(req, conn);
    const s = await getSettings();
    if (ageFrom(c.birth_date) < Number(s.vote_age)) throw forbidden(`Голосовать и выдвигаться можно с ${s.vote_age} лет`);
    return c;
  }

  app.post('/elections/:id/nominate', auth, async (req) => {
    await tx(async (conn) => {
      const c = await voter(req, conn);
      const e = await one('SELECT * FROM elections WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
      if (!e || e.status !== 'nomination') throw bad('closed', 'Выдвижение закрыто');
      try {
        await q('INSERT INTO candidates (election_id, citizen_id, program) VALUES (?, ?, ?)', [e.id, c.id, str(req.body?.program, 'программа', { min: 10, max: 2000 })], conn);
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') throw bad('already', 'Вы уже кандидат');
        throw err;
      }
    });
    return { ok: true };
  });

  app.post('/elections/:id/withdraw', auth, async (req) => {
    const c = await citizenOf(req.gov.id);
    const r = await q("UPDATE candidates c JOIN elections e ON e.id = c.election_id SET c.status = 'withdrawn' WHERE c.election_id = ? AND c.citizen_id = ? AND e.status = 'nomination'", [int(req.params.id, 'id'), c?.id || 0]);
    if (!r.affectedRows) throw bad('closed', 'Сняться можно только до начала голосования');
    return { ok: true };
  });

  app.post('/elections/:id/vote', auth, async (req) => {
    await tx(async (conn) => {
      const c = await voter(req, conn);
      const e = await one('SELECT * FROM elections WHERE id = ?', [int(req.params.id, 'id')], conn);
      if (!e || e.status !== 'voting') throw bad('closed', 'Голосование не идёт');
      const cand = await one("SELECT id FROM candidates WHERE id = ? AND election_id = ? AND status = 'approved' FOR UPDATE", [int(req.body?.candidate_id, 'кандидат'), e.id], conn);
      if (!cand) throw notFound('Кандидат не найден');
      try {
        await q('INSERT INTO votes (election_id, citizen_id) VALUES (?, ?)', [e.id, c.id], conn);
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') throw bad('already_voted', 'Вы уже проголосовали');
        throw err;
      }
      // Тайна голосования: голос учитывается счётчиком, связи «избиратель — кандидат» нет.
      await q('UPDATE candidates SET votes = votes + 1 WHERE id = ?', [cand.id], conn);
    });
    return { ok: true };
  });

  // ——— Обращения ———
  app.get('/appeals', auth, async (req) => ({ appeals: (await q('SELECT * FROM appeals WHERE gov_user_id = ? ORDER BY id DESC LIMIT 100', [req.gov.id])).map(appealView) }));

  app.post('/appeals', auth, async (req) => {
    const b = req.body || {};
    const to = ['admin', 'official', 'police', 'tax', 'doctor'].includes(b.addressee) ? b.addressee : 'official';
    const c = await citizenOf(req.gov.id);
    const r = await q('INSERT INTO appeals (gov_user_id, citizen_id, addressee, subject, body) VALUES (?, ?, ?, ?, ?)', [req.gov.id, c?.id || null, to, str(b.subject, 'тема', { min: 3, max: 160 }), str(b.body, 'текст', { min: 10, max: 4000 })]);
    return { id: r.insertId };
  });

  // ——— Рабочие места госслужащих ———
  app.get('/work/appeals', staff, async (req) => {
    const roles = req.actor.roles.includes('admin') ? ['admin', ...STAFF_ROLES] : req.actor.roles;
    const status = req.query.status === 'answered' ? 'answered' : 'open';
    const rows = await q(`SELECT a.*, COALESCE(c.full_name, g.display_name) AS author FROM appeals a JOIN gov_users g ON g.id = a.gov_user_id LEFT JOIN citizens c ON c.id = a.citizen_id
      WHERE a.status = ? AND a.addressee IN (${roles.map(() => '?').join(',')}) ORDER BY a.id DESC LIMIT 200`, [status, ...roles]);
    return { appeals: rows.map(appealView) };
  });

  app.post('/work/appeals/:id/answer', staff, async (req) => {
    await tx(async (conn) => {
      const a = await one('SELECT * FROM appeals WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
      if (!a) throw notFound();
      if (!req.actor.roles.includes('admin') && !req.actor.roles.includes(a.addressee)) throw forbidden();
      await q("UPDATE appeals SET status = 'answered', answer = ?, answered_by = ?, answered_at = NOW(3) WHERE id = ?", [str(req.body?.answer, 'ответ', { min: 2, max: 4000 }), `${req.actor.kind}:${req.actor.id}`, a.id], conn);
      await q('INSERT INTO notifications (user_kind, user_id, title, body, link) VALUES (?, ?, ?, ?, ?)', ['gov', a.gov_user_id, `Ответ на обращение: ${a.subject}`, null, '#/appeals'], conn);
    });
    return { ok: true };
  });

  // Полиция: проверка гражданина, штрафы.
  app.get('/work/police/citizen', police, async (req) => {
    const c = await citizenByPassport(null, req.query.passport);
    const p = await activePassport(c.id);
    const docs = await q("SELECT type, number, status, expires_month FROM documents WHERE citizen_id = ? AND type IN ('driver','foreign_passport','visa')", [c.id]);
    const fines = await q(`${FINE_SELECT} WHERE f.citizen_id = ? ORDER BY f.id DESC LIMIT 20`, [c.id]);
    const props = await q("SELECT title, reg_number, kind FROM properties WHERE owner_citizen_id = ? AND kind = 'car'", [c.id]);
    return {
      citizen: { id: c.id, full_name: c.full_name, birth_date: c.birth_date, age: ageFrom(c.birth_date), photo: c.photo, passport_no: c.passport_no, passport_status: p?.status || 'none', address: c.address },
      documents: docs, fines: fines.map(fineView), cars: props, sanctions: (await activeSanctions(null, c.id)).map(sanctionView),
    };
  });

  app.post('/work/police/fines', police, async (req) => {
    const b = req.body || {};
    const r = await tx(async (conn) => {
      const citizen = await citizenByPassport(conn, b.passport_no);
      const article = b.article_id ? await one('SELECT * FROM fine_articles WHERE id = ? AND active = 1', [int(b.article_id, 'статья')], conn) : null;
      if (b.article_id && !article) throw notFound('Статья не найдена');
      const res = await issueFine(conn, {
        citizen,
        article,
        text: article ? null : str(b.text, 'нарушение', { min: 3, max: 255 }),
        amount: article ? null : amountOf(b.amount, 'сумма'),
        note: str(b.note, 'комментарий', { optional: true, max: 255 }),
        officer: req.actor.kind === 'gov' ? { id: req.actor.id } : null,
      });
      await audit(conn, actorOf(req.actor), 'police.fine', 'fine', res.id, { citizen: citizen.id });
      return res;
    });
    return r;
  });

  app.get('/work/police/fines', police, async (req) => {
    const all = req.actor.roles.includes('admin') && req.query.all === '1';
    const rows = await q(`${FINE_SELECT}${all ? '' : ' WHERE f.officer_gov_user_id = ?'} ORDER BY f.id DESC LIMIT 200`, all ? [] : [req.actor.kind === 'gov' ? req.actor.id : 0]);
    return { fines: rows.map(fineView) };
  });

  // Налоговая: декларации, должники, доначисление.
  app.get('/work/tax/declarations', taxRole, async (req) => {
    const status = ['draft', 'submitted', 'paid', 'auto'].includes(req.query.status) ? req.query.status : null;
    const rows = await q(`SELECT d.*, c.full_name, c.passport_no, i.number AS invoice_number FROM tax_declarations d JOIN citizens c ON c.id = d.citizen_id LEFT JOIN invoices i ON i.id = d.invoice_id${status ? ' WHERE d.status = ?' : ''} ORDER BY d.id DESC LIMIT 300`, status ? [status] : []);
    return { declarations: rows.map(declView) };
  });

  app.get('/work/tax/debtors', taxRole, async () => {
    const month = await currentMonth();
    const rows = await q(`SELECT c.id, c.full_name, c.passport_no, COUNT(*) AS n, SUM(i.amount) AS total, SUM(i.penalty) AS penalty, MIN(i.due_month) AS since
      FROM invoices i JOIN citizens c ON c.id = i.citizen_id WHERE i.status = 'unpaid' AND i.frozen = 0 AND i.kind IN ('tax','fine') AND i.due_month < ? GROUP BY c.id, c.full_name, c.passport_no ORDER BY total DESC LIMIT 300`, [month]);
    const sanctions = await q('SELECT s.*, c.full_name, c.passport_no FROM citizen_sanctions s JOIN citizens c ON c.id = s.citizen_id WHERE s.active = 1 ORDER BY s.id DESC');
    return {
      month,
      debtors: rows.map((r) => ({ ...r, n: Number(r.n), total: Number(r.total), penalty: Number(r.penalty), months_late: month - Number(r.since) })),
      sanctions: sanctions.map(sanctionView),
    };
  });

  app.post('/work/tax/assess', taxRole, async (req) => {
    const b = req.body || {};
    const r = await tx(async (conn) => {
      const citizen = await citizenByPassport(conn, b.passport_no);
      const inv = await assessTax(conn, { citizen, amount: amountOf(b.amount, 'сумма'), purpose: str(b.purpose, 'основание', { min: 3, max: 200 }) });
      await audit(conn, actorOf(req.actor), 'tax.assess', 'citizen', citizen.id, { amount: Number(b.amount), invoice: inv.number });
      return inv;
    });
    return { invoice: r.number };
  });

  // Врач: расписание, приём, заключение.
  app.get('/work/doctor', doctor, async (req) => {
    const id = req.actor.kind === 'gov' ? req.actor.id : 0;
    const rows = await q(`${SLOT_SELECT} WHERE s.doctor_gov_user_id = ? AND (s.status IN ('free','booked') OR s.done_at >= NOW(3) - INTERVAL 7 DAY) ORDER BY s.starts_at LIMIT 300`, [id]);
    return { slots: rows.map(slotView) };
  });

  app.post('/work/doctor/slots', doctor, async (req) => {
    need(req.actor.kind === 'gov', 'Расписание ведётся из аккаунта ВлодУслуг');
    const b = req.body || {};
    const start = new Date(String(b.starts_at || ''));
    need(!Number.isNaN(start.getTime()) && start > new Date(Date.now() - 60000), 'Укажите время приёма в будущем');
    const duration = int(Number(b.duration_min) || 15, 'длительность', { min: 5, max: 240 });
    const count = int(Number(b.count) || 1, 'количество', { min: 1, max: 48 });
    for (let i = 0; i < count; i++) {
      const at = new Date(start.getTime() + i * duration * 60000);
      await q('INSERT INTO doctor_slots (doctor_gov_user_id, starts_at, duration_min, priority) VALUES (?, ?, ?, ?)', [req.actor.id, at, duration, b.priority ? 1 : 0]);
    }
    return { ok: true, created: count };
  });

  async function mySlot(req, conn) {
    const s = await one('SELECT * FROM doctor_slots WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
    if (!s || (s.doctor_gov_user_id !== req.actor.id && !req.actor.roles.includes('admin'))) throw notFound('Приём не найден');
    return s;
  }

  app.post('/work/doctor/slots/:id/conclude', doctor, async (req) => {
    await tx(async (conn) => {
      const s = await mySlot(req, conn);
      if (s.status !== 'booked') throw bad('invalid_state', 'На это время никто не записан');
      await q("UPDATE doctor_slots SET status = 'done', conclusion = ?, done_at = NOW(3) WHERE id = ?", [str(req.body?.conclusion, 'заключение', { min: 3, max: 2000 }), s.id], conn);
      const c = await one('SELECT * FROM citizens WHERE id = ?', [s.patient_citizen_id], conn);
      await notifyCitizen(conn, c, { title: 'Заключение врача готово', body: 'Игровое заключение — в разделе «Врач»', govLink: '#/doctor' });
    });
    return { ok: true };
  });

  app.post('/work/doctor/slots/:id/cancel', doctor, async (req) => {
    await tx(async (conn) => {
      const s = await mySlot(req, conn);
      if (!['free', 'booked'].includes(s.status)) throw bad('invalid_state', 'Приём уже завершён');
      await q("UPDATE doctor_slots SET status = 'cancelled' WHERE id = ?", [s.id], conn);
      if (s.patient_citizen_id) {
        const c = await one('SELECT * FROM citizens WHERE id = ?', [s.patient_citizen_id], conn);
        await notifyCitizen(conn, c, { title: 'Приём у врача отменён', body: 'Запишитесь на другое время', govLink: '#/doctor' });
      }
    });
    return { ok: true };
  });

  // Чиновник: заявки на пособия.
  app.get('/work/benefits', official, async (req) => {
    const status = ['pending', 'active', 'rejected', 'stopped'].includes(req.query.status) ? req.query.status : 'pending';
    const s = await getSettings();
    const rows = await q('SELECT b.*, c.full_name, c.passport_no, c.birth_date, c.children FROM benefits b JOIN citizens c ON c.id = b.citizen_id WHERE b.status = ? ORDER BY b.id DESC LIMIT 300', [status]);
    const out = [];
    for (const b of rows) out.push({ id: b.id, kind: b.kind, title: BENEFIT_TITLES[b.kind], status: b.status, full_name: b.full_name, passport_no: b.passport_no, age: ageFrom(b.birth_date), children: json(b.children, []).length, amount: await benefitAmount(b, b.kind, s), months_left: b.months_left, created_at: b.created_at });
    return { benefits: out };
  });

  app.post('/work/benefits/:id/decide', official, async (req) => {
    await tx(async (conn) => {
      const b = await one('SELECT * FROM benefits WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
      if (!b) throw notFound();
      await decideBenefit(conn, { benefit: b, approve: !!req.body?.approve, by: `${req.actor.kind}:${req.actor.id}`, note: str(req.body?.note, 'комментарий', { optional: true, max: 255 }) });
      await audit(conn, actorOf(req.actor), req.body?.approve ? 'gov.benefit_approve' : 'gov.benefit_reject', 'benefit', b.id);
    });
    return { ok: true };
  });

  app.post('/work/benefits/:id/stop', official, async (req) => {
    const r = await q("UPDATE benefits SET status = 'stopped', note = ? WHERE id = ? AND status = 'active'", [str(req.body?.note, 'причина', { optional: true, max: 255 }), int(req.params.id, 'id')]);
    if (!r.affectedRows) throw bad('invalid_state', 'Пособие не выплачивается');
    return { ok: true };
  });
}
