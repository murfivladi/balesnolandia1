// Этап 8, админка «Услуги»: статьи штрафов и жалобы, госбюджет, санкции, реестр имущества,
// страны и визы, новости, выборы.
import { tx, q, one } from '../db.js';
import { bad, notFound, int, str, amount as amountOf, need } from '../lib/errors.js';
import { needAdmin, actorOf } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { sys } from '../lib/ledger.js';
import { publish } from '../lib/hub.js';
import {
  decideFineAppeal, liftSanction, arrestAccounts, citizenByPassport, newRegNumber, propertyView, notifyCitizen,
} from '../lib/state.js';
import { fineView, electionsView } from './gov-ext.js';

const MAX_IMAGE = 400_000;

const BUDGET_KINDS = {
  vat: 'НДС с безналичных продаж', vat_cash: 'НДС с наличных и продаж в долг', invoice: 'Квитанции (оплата в банке)', invoice_cash: 'Квитанции (наличными на кассе)',
  salary: 'НДФЛ с зарплат кассиров', gov_salary: 'Зарплаты госслужащих', benefit: 'Пособия', card_payment: 'НДС с оплат картой', qr_payment: 'НДС с оплат по QR', refund: 'Возвраты НДС',
  property_purchase: 'Продажа госимущества', loan_issue: 'Продажа госимущества в кредит', emission: 'Эмиссия', reversal: 'Сторно',
};

export async function adminGovRoutes(app) {
  app.addHook('preHandler', needAdmin());
  const actor = (req) => actorOf(req.actor);

  // ——— Штрафы: статьи и жалобы ———
  app.get('/fine-articles', async () => ({ articles: (await q('SELECT * FROM fine_articles ORDER BY active DESC, code')).map((a) => ({ ...a, amount: Number(a.amount), active: !!a.active })) }));

  app.post('/fine-articles', async (req) => {
    const b = req.body || {};
    const r = await q('INSERT INTO fine_articles (code, title, amount) VALUES (?, ?, ?)', [str(b.code, 'номер статьи', { max: 16 }), str(b.title, 'название', { max: 160 }), amountOf(b.amount, 'сумма')]);
    await audit(null, actor(req), 'admin.fine_article_add', 'fine_article', r.insertId, b);
    return { id: r.insertId };
  });

  app.patch('/fine-articles/:id', async (req) => {
    const a = await one('SELECT * FROM fine_articles WHERE id = ?', [int(req.params.id, 'id')]);
    if (!a) throw notFound();
    const b = req.body || {};
    await q('UPDATE fine_articles SET code = ?, title = ?, amount = ?, active = ? WHERE id = ?', [
      b.code !== undefined ? str(b.code, 'номер статьи', { max: 16 }) : a.code,
      b.title !== undefined ? str(b.title, 'название', { max: 160 }) : a.title,
      b.amount !== undefined ? amountOf(b.amount, 'сумма') : a.amount,
      b.active !== undefined ? (b.active ? 1 : 0) : a.active,
      a.id,
    ]);
    return { ok: true };
  });

  app.get('/fines', async (req) => {
    const appeal = req.query.appeal === 'pending';
    const rows = await q(`SELECT f.*, i.number AS invoice_number, i.amount AS invoice_amount, c.full_name, c.passport_no, g.display_name AS officer
      FROM fines f JOIN citizens c ON c.id = f.citizen_id LEFT JOIN invoices i ON i.id = f.invoice_id LEFT JOIN gov_users g ON g.id = f.officer_gov_user_id
      ${appeal ? "WHERE f.appeal_status = 'pending'" : ''} ORDER BY f.id DESC LIMIT 300`);
    return { fines: rows.map(fineView) };
  });

  app.post('/fines/:id/appeal', async (req) => {
    await tx(async (conn) => {
      const fine = await one('SELECT * FROM fines WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
      if (!fine) throw notFound();
      await decideFineAppeal(conn, { fine, accept: !!req.body?.accept, note: str(req.body?.note, 'комментарий', { optional: true, max: 255 }) });
      await audit(conn, actor(req), req.body?.accept ? 'admin.fine_appeal_accept' : 'admin.fine_appeal_reject', 'fine', fine.id);
    });
    return { ok: true };
  });

  // ——— Госбюджет: доходы и расходы по видам операций ———
  app.get('/budget', async (req) => {
    const days = Math.min(365, Math.max(1, Number(req.query.days) || 30));
    const budget = await sys('BUDGET');
    const bal = await one('SELECT balance FROM accounts WHERE id = ?', [budget]);
    const rows = await q(`SELECT t.kind, SUM(CASE WHEN e.amount > 0 THEN e.amount ELSE 0 END) AS income, SUM(CASE WHEN e.amount < 0 THEN -e.amount ELSE 0 END) AS expense, COUNT(*) AS n
      FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id WHERE e.account_id = ? AND t.created_at >= NOW() - INTERVAL ? DAY GROUP BY t.kind ORDER BY income DESC`, [budget, days]);
    const byInvoice = await q(`SELECT i.kind, COUNT(*) AS n, SUM(i.amount) AS total FROM invoices i WHERE i.status = 'paid' AND i.paid_at >= NOW() - INTERVAL ? DAY GROUP BY i.kind`, [days]);
    const daily = await q(`SELECT DATE(t.created_at) AS d, SUM(CASE WHEN e.amount > 0 THEN e.amount ELSE 0 END) AS income, SUM(CASE WHEN e.amount < 0 THEN -e.amount ELSE 0 END) AS expense
      FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id WHERE e.account_id = ? AND t.created_at >= NOW() - INTERVAL ? DAY GROUP BY DATE(t.created_at) ORDER BY d`, [budget, days]);
    const unpaid = await one("SELECT COUNT(*) AS n, COALESCE(SUM(amount),0) AS s FROM invoices WHERE status = 'unpaid' AND kind IN ('tax','fine')");
    const n = (v) => Number(v || 0);
    return {
      days,
      balance: n(bal.balance),
      by_kind: rows.map((r) => ({ kind: r.kind, title: BUDGET_KINDS[r.kind] || r.kind, income: n(r.income), expense: n(r.expense), count: n(r.n) })),
      income: rows.reduce((x, r) => x + n(r.income), 0),
      expense: rows.reduce((x, r) => x + n(r.expense), 0),
      invoices: byInvoice.map((r) => ({ kind: r.kind, count: n(r.n), total: n(r.total) })),
      daily: daily.map((r) => ({ day: r.d, income: n(r.income), expense: n(r.expense) })),
      receivable: { count: n(unpaid.n), total: n(unpaid.s) },
    };
  });

  // ——— Санкции за неуплату ———
  app.get('/sanctions', async (req) => {
    const all = req.query.all === '1';
    const rows = await q(`SELECT s.*, c.full_name, c.passport_no FROM citizen_sanctions s JOIN citizens c ON c.id = s.citizen_id${all ? '' : ' WHERE s.active = 1'} ORDER BY s.id DESC LIMIT 300`);
    return { sanctions: rows.map((s) => ({ id: s.id, kind: s.kind, reason: s.reason, active: !!s.active, created_by: s.created_by, created_at: s.created_at, lifted_at: s.lifted_at, full_name: s.full_name, passport_no: s.passport_no })) };
  });

  app.post('/sanctions/:id/lift', async (req) => {
    await tx(async (conn) => {
      const s = await one('SELECT * FROM citizen_sanctions WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
      if (!s || !s.active) throw notFound();
      await liftSanction(conn, s);
      await audit(conn, actor(req), 'admin.sanction_lift', 'sanction', s.id);
    });
    return { ok: true };
  });

  app.post('/sanctions', async (req) => {
    const b = req.body || {};
    need(['arrest', 'travel_ban'].includes(b.kind), 'Мера: арест счетов или запрет выезда');
    await tx(async (conn) => {
      const c = await citizenByPassport(conn, b.passport_no);
      const reason = str(b.reason, 'основание', { min: 3, max: 255 });
      const by = `${req.actor.kind}:${req.actor.id}`;
      if (b.kind === 'arrest') {
        if (!(await arrestAccounts(conn, c, reason, by))) throw bad('already', 'Арест уже действует или нет счетов в банке');
      } else {
        if (await one("SELECT id FROM citizen_sanctions WHERE citizen_id = ? AND kind = 'travel_ban' AND active = 1", [c.id], conn)) throw bad('already', 'Запрет выезда уже действует');
        await q("INSERT INTO citizen_sanctions (citizen_id, kind, reason, created_by) VALUES (?, 'travel_ban', ?, ?)", [c.id, reason, by], conn);
        await notifyCitizen(conn, c, { title: 'Запрет выезда из БФ', body: reason, govLink: '#/taxes' });
      }
      await audit(conn, actor(req), `admin.sanction_${b.kind}`, 'citizen', c.id, { reason });
    });
    return { ok: true };
  });

  // ——— Реестр имущества ———
  app.get('/properties', async (req) => {
    const term = `%${String(req.query.q || '').trim()}%`;
    const rows = await q('SELECT p.*, c.full_name AS owner_name FROM properties p LEFT JOIN citizens c ON c.id = p.owner_citizen_id WHERE p.title LIKE ? OR p.reg_number LIKE ? OR c.full_name LIKE ? ORDER BY p.id DESC LIMIT 300', [term, term, term]);
    return { properties: rows.map((p) => ({ ...propertyView(p), owner_name: p.owner_name || 'Государство БФ' })) };
  });

  function propFields(b, prev = {}) {
    const val = (k, f) => (b[k] !== undefined ? f(b[k]) : prev[k]);
    const photo = b.photo !== undefined ? (b.photo || null) : prev.photo ?? null;
    if (photo) need(/^data:image\//.test(photo) && photo.length < MAX_IMAGE, 'Фото до 300 КБ');
    return {
      kind: val('kind', (v) => (v === 'car' ? 'car' : 'realty')),
      title: val('title', (v) => str(v, 'название', { max: 120 })),
      address: val('address', (v) => str(v, 'адрес', { optional: true, max: 200 })) ?? null,
      details: val('details', (v) => str(v, 'описание', { optional: true, max: 500 })) ?? null,
      value: val('value', (v) => amountOf(v, 'оценка')),
      list_price: val('list_price', (v) => (v === null || v === '' ? null : amountOf(v, 'цена продажи'))) ?? null,
      status: val('status', (v) => (v === 'arrested' ? 'arrested' : 'active')) ?? 'active',
      photo,
    };
  }

  app.post('/properties', async (req) => {
    const b = req.body || {};
    const f = propFields(b);
    need(f.title && f.value, 'Укажите название и оценку');
    const id = await tx(async (conn) => {
      const owner = b.owner_passport ? await citizenByPassport(conn, b.owner_passport) : null;
      const reg = b.reg_number ? str(b.reg_number, 'рег. номер', { max: 32 }).toUpperCase() : await newRegNumber(conn, f.kind);
      if (await one('SELECT id FROM properties WHERE reg_number = ?', [reg], conn)) throw bad('reg_taken', 'Такой рег. номер уже есть');
      const r = await q('INSERT INTO properties (kind, title, reg_number, address, details, photo, value, owner_citizen_id, list_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [f.kind, f.title, reg, f.address, f.details, f.photo, f.value, owner?.id || null, owner ? null : f.list_price], conn);
      if (owner) await notifyCitizen(conn, owner, { title: `Имущество зарегистрировано: ${f.title}`, body: reg, govLink: '#/property' });
      await audit(conn, actor(req), 'admin.property_add', 'property', r.insertId, { title: f.title, owner: owner?.id || null });
      return r.insertId;
    });
    return { id };
  });

  app.patch('/properties/:id', async (req) => {
    const p = await one('SELECT * FROM properties WHERE id = ?', [int(req.params.id, 'id')]);
    if (!p) throw notFound();
    const f = propFields(req.body || {}, { ...p, value: Number(p.value), list_price: p.list_price === null ? null : Number(p.list_price) });
    await q('UPDATE properties SET kind = ?, title = ?, address = ?, details = ?, photo = ?, value = ?, list_price = ?, status = ? WHERE id = ?', [f.kind, f.title, f.address, f.details, f.photo, f.value, f.list_price, f.status, p.id]);
    await audit(null, actor(req), 'admin.property_edit', 'property', p.id);
    return { ok: true };
  });

  // ——— Страны и визы ———
  app.get('/countries', async () => ({ countries: (await q('SELECT * FROM countries ORDER BY active DESC, name')).map((c) => ({ ...c, visa_required: !!c.visa_required, visa_fee: Number(c.visa_fee), active: !!c.active })) }));

  app.post('/countries', async (req) => {
    const b = req.body || {};
    const code = str(b.code, 'код', { min: 3, max: 3 }).toUpperCase();
    try {
      const r = await q('INSERT INTO countries (name, code, visa_required, visa_fee, visa_months) VALUES (?, ?, ?, ?, ?)', [str(b.name, 'название', { max: 80 }), code, b.visa_required === false ? 0 : 1, int(Number(b.visa_fee) || 0, 'сбор', { min: 0, max: 1e12 }), int(Number(b.visa_months) || 6, 'срок', { min: 1, max: 600 })]);
      return { id: r.insertId };
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw bad('exists', 'Страна с таким кодом уже есть');
      throw err;
    }
  });

  app.patch('/countries/:id', async (req) => {
    const c = await one('SELECT * FROM countries WHERE id = ?', [int(req.params.id, 'id')]);
    if (!c) throw notFound();
    const b = req.body || {};
    await q('UPDATE countries SET name = ?, visa_required = ?, visa_fee = ?, visa_months = ?, active = ? WHERE id = ?', [
      b.name !== undefined ? str(b.name, 'название', { max: 80 }) : c.name,
      b.visa_required !== undefined ? (b.visa_required ? 1 : 0) : c.visa_required,
      b.visa_fee !== undefined ? int(Number(b.visa_fee) || 0, 'сбор', { min: 0, max: 1e12 }) : c.visa_fee,
      b.visa_months !== undefined ? int(Number(b.visa_months), 'срок', { min: 1, max: 600 }) : c.visa_months,
      b.active !== undefined ? (b.active ? 1 : 0) : c.active,
      c.id,
    ]);
    return { ok: true };
  });

  // ——— Новости, указы, законы ———
  app.post('/news', async (req) => {
    const b = req.body || {};
    const kind = ['news', 'decree', 'law', 'election'].includes(b.kind) ? b.kind : 'news';
    const r = await q('INSERT INTO news (kind, title, body, pinned, published_by) VALUES (?, ?, ?, ?, ?)', [kind, str(b.title, 'заголовок', { max: 200 }), str(b.body, 'текст', { max: 20000 }), b.pinned ? 1 : 0, `${req.actor.kind}:${req.actor.id}`]);
    publish('clock', { type: 'news', id: r.insertId });
    await audit(null, actor(req), 'admin.news', 'news', r.insertId);
    return { id: r.insertId };
  });

  app.patch('/news/:id', async (req) => {
    const n = await one('SELECT * FROM news WHERE id = ?', [int(req.params.id, 'id')]);
    if (!n) throw notFound();
    const b = req.body || {};
    if (b.delete) {
      await q('DELETE FROM news WHERE id = ?', [n.id]);
      return { ok: true };
    }
    await q('UPDATE news SET title = ?, body = ?, pinned = ? WHERE id = ?', [b.title !== undefined ? str(b.title, 'заголовок', { max: 200 }) : n.title, b.body !== undefined ? str(b.body, 'текст', { max: 20000 }) : n.body, b.pinned !== undefined ? (b.pinned ? 1 : 0) : n.pinned, n.id]);
    return { ok: true };
  });

  // ——— Выборы ———
  app.get('/elections', async () => ({ elections: await electionsView(null, null, { admin: true }) }));

  app.post('/elections', async (req) => {
    const b = req.body || {};
    const r = await q('INSERT INTO elections (title, description, created_by) VALUES (?, ?, ?)', [str(b.title, 'название', { max: 160 }), str(b.description, 'описание', { optional: true, max: 2000 }), `${req.actor.kind}:${req.actor.id}`]);
    await audit(null, actor(req), 'admin.election_create', 'election', r.insertId);
    return { id: r.insertId };
  });

  app.post('/elections/:id/status', async (req) => {
    const status = String(req.body?.status || '');
    need(['nomination', 'voting', 'finished', 'cancelled'].includes(status), 'Неверный этап');
    await tx(async (conn) => {
      const e = await one('SELECT * FROM elections WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
      if (!e) throw notFound();
      if (e.status === 'finished' || e.status === 'cancelled') throw bad('closed', 'Выборы уже завершены');
      if (status === 'voting') {
        const c = await one("SELECT COUNT(*) AS n FROM candidates WHERE election_id = ? AND status = 'approved'", [e.id], conn);
        if (Number(c.n) < 1) throw bad('no_candidates', 'Нет кандидатов');
      }
      await q(`UPDATE elections SET status = ?${status === 'finished' ? ', finished_at = NOW(3)' : ''} WHERE id = ?`, [status, e.id], conn);
      if (status === 'finished') {
        // Итоги выборов публикуются в новостях БФ.
        const cands = await q("SELECT c.votes, z.full_name FROM candidates c JOIN citizens z ON z.id = c.citizen_id WHERE c.election_id = ? AND c.status = 'approved' ORDER BY c.votes DESC", [e.id], conn);
        const total = cands.reduce((x, c) => x + Number(c.votes), 0);
        const lines = cands.map((c, i) => `${i + 1}. ${c.full_name} — ${c.votes} (${total ? Math.round((c.votes * 1000) / total) / 10 : 0}%)`);
        const winner = cands[0] && (!cands[1] || cands[0].votes > cands[1].votes) ? cands[0].full_name : null;
        await q("INSERT INTO news (kind, title, body, pinned, published_by) VALUES ('election', ?, ?, 1, 'system')", [`Итоги выборов: ${e.title}`, `${winner ? `Победитель: ${winner}.\n\n` : 'Равенство голосов — нужен второй тур.\n\n'}Проголосовало: ${total}.\n${lines.join('\n')}`], conn);
      }
      await audit(conn, actor(req), `admin.election_${status}`, 'election', e.id);
    });
    return { ok: true };
  });

  app.post('/candidates/:id/status', async (req) => {
    const status = req.body?.status === 'rejected' ? 'rejected' : 'approved';
    const r = await q("UPDATE candidates c JOIN elections e ON e.id = c.election_id SET c.status = ? WHERE c.id = ? AND e.status = 'nomination'", [status, int(req.params.id, 'id')]);
    if (!r.affectedRows) throw bad('closed', 'Кандидатов можно менять только на этапе выдвижения');
    return { ok: true };
  });
}
