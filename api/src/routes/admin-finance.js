// Этап 6, админка: кредиты и кредитные карты, антифрод, категории кешбэка, инфляция.
import { tx, q, one, json } from '../db.js';
import { bad, notFound, int, str, amount as amountOf } from '../lib/errors.js';
import { needAdmin, actorOf } from '../lib/auth.js';
import { getSettings } from '../lib/settings.js';
import { audit } from '../lib/audit.js';
import { decideCreditLine, setCreditLimit, creditLineView, issueLoan, rejectLoan, loanView, decideFraud, adjustScore } from '../lib/finance.js';

export async function adminFinanceRoutes(app) {
  app.addHook('preHandler', needAdmin());
  const actor = (req) => actorOf(req.actor);
  const note = (req) => str(req.body?.note, 'комментарий', { optional: true, max: 200 });

  // ——— Кредиты ———
  app.get('/credit', async (req) => {
    const status = String(req.query.status || '');
    const loans = await q(`SELECT l.*, u.full_name, u.credit_score FROM loans l JOIN bank_users u ON u.id = l.bank_user_id
      WHERE (? = '' OR l.status = ?) ORDER BY l.status = 'pending' DESC, l.id DESC LIMIT 200`, [status, status]);
    const lines = await q(`SELECT c.*, u.full_name, u.credit_score FROM credit_lines c JOIN bank_users u ON u.id = c.bank_user_id
      WHERE (? = '' OR c.status = ?) ORDER BY c.status = 'pending' DESC, c.id DESC LIMIT 200`, [status, status]);
    const portfolio = await one(`SELECT
      (SELECT COALESCE(-SUM(balance),0) FROM accounts WHERE type = 'loan' AND status <> 'closed') AS loans,
      (SELECT COALESCE(-SUM(LEAST(balance,0)),0) FROM accounts WHERE type = 'credit' AND status <> 'closed') AS cards,
      (SELECT COUNT(*) FROM loan_schedule s JOIN loans l ON l.id = s.loan_id AND l.status = 'active' WHERE s.status = 'overdue') AS overdue`);
    return {
      loans: await Promise.all(loans.map(async (l) => ({ ...(await loanView(l)), user_id: l.bank_user_id, full_name: l.full_name, credit_score: l.credit_score }))),
      credit_lines: await Promise.all(lines.map(async (c) => ({ ...(await creditLineView(c)), user_id: c.bank_user_id, full_name: c.full_name, credit_score: c.credit_score }))),
      portfolio: { loans: Number(portfolio.loans), cards: Number(portfolio.cards), overdue: Number(portfolio.overdue) },
    };
  });

  app.post('/loans/:id/decision', async (req) => {
    const b = req.body || {};
    const s = await getSettings();
    await tx(async (conn) => {
      const loan = await one('SELECT * FROM loans WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
      if (!loan) throw notFound();
      if (b.approve) {
        const amount = b.amount ? amountOf(b.amount) : Number(loan.amount_requested);
        const months = b.months ? int(b.months, 'срок', { min: 1, max: 600 }) : loan.months_requested;
        const rateBp = b.rate_bp !== undefined && b.rate_bp !== null && b.rate_bp !== '' ? int(b.rate_bp, 'ставка', { min: 0, max: 10000 }) : Number(loan.kind === 'mortgage' ? s.mortgage_rate_bp : loan.kind === 'auto' ? s.auto_loan_rate_bp : s.loan_rate_bp);
        await issueLoan(conn, loan, { amount, months, rateBp, actor: actor(req), note: note(req) });
      } else {
        await rejectLoan(conn, loan, { actor: actor(req), note: note(req) });
      }
      await audit(conn, actor(req), b.approve ? 'admin.loan_approve' : 'admin.loan_reject', 'loan', loan.id, b);
    });
    return { ok: true };
  });

  app.post('/credit-lines/:id/decision', async (req) => {
    const b = req.body || {};
    await tx(async (conn) => {
      const line = await one('SELECT * FROM credit_lines WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
      if (!line) throw notFound();
      const limit = b.approve ? (b.limit ? amountOf(b.limit, 'лимит') : Number(line.limit_requested)) : null;
      await decideCreditLine(conn, line, { approve: !!b.approve, limit, actor: actor(req), note: note(req) });
      await audit(conn, actor(req), b.approve ? 'admin.credit_approve' : 'admin.credit_reject', 'credit_line', line.id, { limit });
    });
    return { ok: true };
  });

  app.post('/credit-lines/:id/limit', async (req) => {
    const limit = int(req.body?.limit, 'лимит', { min: 0, max: 1e13 });
    await tx(async (conn) => {
      const line = await one('SELECT * FROM credit_lines WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
      if (!line) throw notFound();
      await setCreditLimit(conn, line, limit);
      await audit(conn, actor(req), 'admin.credit_limit', 'credit_line', line.id, { limit });
    });
    return { ok: true };
  });

  app.post('/users/bank/:id/score', async (req) => {
    const score = int(req.body?.score, 'рейтинг', { min: 0, max: 1000 });
    await tx(async (conn) => {
      const u = await one('SELECT credit_score FROM bank_users WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
      if (!u) throw notFound();
      await adjustScore(conn, Number(req.params.id), score - u.credit_score);
      await audit(conn, actor(req), 'admin.credit_score', 'bank_user', Number(req.params.id), { score });
    });
    return { ok: true };
  });

  // ——— Антифрод ———
  app.get('/fraud', async (req) => {
    const status = String(req.query.status || 'pending');
    const rows = await q(`SELECT f.*, u.full_name, u.email FROM fraud_queue f JOIN bank_users u ON u.id = f.bank_user_id
      WHERE (? = 'all' OR f.status = ?) ORDER BY f.id DESC LIMIT 200`, [status, status]);
    const out = [];
    for (const r of rows) {
      const data = json(r.data, {}) || {};
      let to = null;
      if (data.to) {
        const a = await one('SELECT a.number, a.name, u.full_name FROM accounts a LEFT JOIN bank_users u ON a.owner_kind = \'bank_user\' AND u.id = a.owner_id WHERE a.id = ?', [data.to]);
        to = a ? `${a.full_name || a.name} · ${a.number}` : null;
      }
      out.push({ id: r.id, user_id: r.bank_user_id, full_name: r.full_name, email: r.email, kind: r.kind, mode: r.mode, amount: Number(r.amount), reason: r.reason, memo: data.memo || null, to, tx_id: r.tx_id, status: r.status, note: r.note, decided_by: r.decided_by, created_at: r.created_at, decided_at: r.decided_at });
    }
    return { items: out };
  });

  app.post('/fraud/:id/decision', async (req) => {
    const res = await decideFraud(int(req.params.id, 'id'), { approve: !!req.body?.approve, actor: actor(req), note: note(req) });
    await audit(null, actor(req), req.body?.approve ? 'admin.fraud_approve' : 'admin.fraud_reject', 'fraud', Number(req.params.id), res);
    return { ok: true, ...res };
  });

  // ——— Кешбэк ———
  app.get('/cashback-categories', async () => {
    const rows = await q(`SELECT c.*, (SELECT COUNT(*) FROM shops s WHERE s.cashback_category_id = c.id) AS shops,
      (SELECT COALESCE(SUM(amount),0) FROM cashback_accruals a WHERE a.category_id = c.id) AS accrued FROM cashback_categories c ORDER BY c.sort, c.id`);
    return { categories: rows.map((r) => ({ ...r, active: !!r.active, accrued: Number(r.accrued) })) };
  });

  function catBody(b, partial = false) {
    const out = {};
    if (!partial || b.name !== undefined) out.name = str(b.name, 'название', { min: 2, max: 60 });
    if (!partial || b.rate_bp !== undefined) out.rate_bp = int(b.rate_bp ?? 0, 'ставка', { min: 0, max: 5000 });
    if (b.active !== undefined) out.active = b.active ? 1 : 0;
    if (b.sort !== undefined) out.sort = int(b.sort, 'порядок', { min: 0, max: 1000 });
    return out;
  }

  app.post('/cashback-categories', async (req) => {
    const c = catBody(req.body || {});
    const r = await q('INSERT INTO cashback_categories (name, rate_bp, sort) VALUES (?, ?, ?)', [c.name, c.rate_bp, c.sort ?? 99]);
    await audit(null, actor(req), 'admin.cashback_category', 'cashback_category', r.insertId, c);
    return { id: r.insertId };
  });

  app.patch('/cashback-categories/:id', async (req) => {
    const c = catBody(req.body || {}, true);
    const keys = Object.keys(c);
    if (!keys.length) throw bad('invalid', 'Нечего менять');
    const r = await q(`UPDATE cashback_categories SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => c[k]), int(req.params.id, 'id')]);
    if (!r.affectedRows) throw notFound();
    await audit(null, actor(req), 'admin.cashback_category', 'cashback_category', Number(req.params.id), c);
    return { ok: true };
  });

  // ——— Инфляция ———
  app.get('/inflation', async () => {
    const rows = await q('SELECT month, rate_bp, index_ppm FROM price_index ORDER BY month DESC LIMIT 60');
    return { history: rows.reverse().map((r) => ({ month: r.month, rate_bp: r.rate_bp, index: Number(r.index_ppm) / 1e6 })), rate_bp: (await getSettings()).inflation_bp };
  });
}
