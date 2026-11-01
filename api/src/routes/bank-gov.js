// Этап 8, ВлодБанк: налоги и штрафы гражданина, сделки с имуществом, ипотека и автокредит.
import { tx, q, one, afterCommit } from '../db.js';
import { bad, notFound, int, amount as amountOf, idemKey } from '../lib/errors.js';
import { needBank, actorOf } from '../lib/auth.js';
import { getSettings } from '../lib/settings.js';
import { ownAccount, assertSpendable, requireVerified } from '../lib/bank.js';
import { notifyAdmins } from '../lib/notify.js';
import { publicInvoice } from '../lib/gov.js';
import { citizenOfBankUser, payDeal, checkDealOpen, dealView, propertyView, activeSanctions } from '../lib/state.js';
import { formatMoney, percentOf } from '@bln/shared/money.js';

export async function bankGovRoutes(app) {
  const auth = { preHandler: needBank({ active: true }) };

  async function citizen(req, conn) {
    const c = await citizenOfBankUser(conn, req.bank.user);
    if (!c) throw bad('no_passport', 'Подтвердите паспорт БФ во ВлодУслугах');
    return c;
  }

  // Квитанции ВлодУслуг на имя клиента: налоги, штрафы, пошлины.
  app.get('/state-charges', auth, async (req) => {
    const c = await citizenOfBankUser(null, req.bank.user);
    if (!c) return { invoices: [], sanctions: [] };
    const rows = await q("SELECT * FROM invoices WHERE citizen_id = ? AND status = 'unpaid' ORDER BY due_month IS NULL, due_month, id", [c.id]);
    const paid = await q("SELECT * FROM invoices WHERE citizen_id = ? AND status = 'paid' ORDER BY paid_at DESC LIMIT 20", [c.id]);
    return { invoices: rows.map(publicInvoice), paid: paid.map(publicInvoice), sanctions: (await activeSanctions(null, c.id)).map((s) => ({ kind: s.kind, reason: s.reason, created_at: s.created_at })) };
  });

  // Сделки с имуществом, где клиент — покупатель.
  app.get('/property', auth, async (req) => {
    const c = await citizenOfBankUser(null, req.bank.user);
    if (!c) return { deals: [], properties: [] };
    const deals = await q(`SELECT d.*, p.title, p.kind, p.reg_number, s.full_name AS seller_name, b.full_name AS buyer_name FROM property_deals d JOIN properties p ON p.id = d.property_id
      LEFT JOIN citizens s ON s.id = d.seller_citizen_id JOIN citizens b ON b.id = d.buyer_citizen_id WHERE d.buyer_citizen_id = ? ORDER BY d.status IN ('pending','loan') DESC, d.id DESC LIMIT 50`, [c.id]);
    const props = await q('SELECT * FROM properties WHERE owner_citizen_id = ?', [c.id]);
    const s = await getSettings();
    return {
      deals: deals.map(dealView),
      properties: props.map(propertyView),
      terms: { mortgage_rate_bp: s.mortgage_rate_bp, auto_loan_rate_bp: s.auto_loan_rate_bp, max_months: s.mortgage_max_months, min_down_bp: s.mortgage_min_down_bp },
    };
  });

  async function myDeal(req, conn) {
    const c = await citizen(req, conn);
    const d = await one('SELECT * FROM property_deals WHERE id = ? AND buyer_citizen_id = ? FOR UPDATE', [int(req.params.id, 'id'), c.id], conn);
    if (!d) throw notFound('Сделка не найдена');
    return d;
  }

  app.post('/property-deals/:id/pay', auth, async (req) => {
    const idem = idemKey(req, `b${req.bank.id}:deal`);
    const r = await tx(async (conn) => {
      requireVerified(req.bank.user);
      const deal = await myDeal(req, conn);
      const acc = await ownAccount(req.bank.id, int(req.body?.account_id, 'счёт'), conn);
      assertSpendable(acc);
      return payDeal(conn, { deal, fromAccountId: acc.id, actor: actorOf(req.bank), idem });
    });
    return { ok: true, ...r };
  });

  // Ипотека (недвижимость) или автокредит: заявка уходит админу, деньги — продавцу при выдаче.
  app.post('/property-deals/:id/loan', auth, async (req) => {
    const b = req.body || {};
    const s = await getSettings();
    const loan = await tx(async (conn) => {
      requireVerified(req.bank.user);
      const deal = await myDeal(req, conn);
      if (deal.status !== 'pending') throw bad('invalid_state', 'По сделке уже оформляется кредит или она закрыта');
      const p = await checkDealOpen(conn, deal);
      const price = Number(deal.price);
      const down = b.down_payment ? amountOf(b.down_payment, 'первый взнос') : 0;
      if (down < percentOf(price, Number(s.mortgage_min_down_bp))) throw bad('down_low', `Первый взнос — не меньше ${formatMoney(percentOf(price, Number(s.mortgage_min_down_bp)))}`);
      if (down >= price) throw bad('down_high', 'Взнос покрывает всю цену — оплатите сделку целиком');
      const months = int(b.months, 'срок', { min: 1, max: Number(s.mortgage_max_months) });
      const acc = await ownAccount(req.bank.id, int(b.account_id, 'счёт'), conn);
      assertSpendable(acc);
      if (Number(acc.balance) < down) throw bad('insufficient_funds', 'На счёте не хватает денег на первый взнос');
      const kind = p.kind === 'car' ? 'auto' : 'mortgage';
      const r = await q('INSERT INTO loans (bank_user_id, kind, purpose, amount_requested, months_requested, pay_account_id, deal_id, property_id, down_payment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        req.bank.id, kind, `${p.title} (${p.reg_number})`, price - down, months, acc.id, deal.id, p.id, down,
      ], conn);
      await q("UPDATE property_deals SET status = 'loan', loan_id = ? WHERE id = ?", [r.insertId, deal.id], conn);
      afterCommit(conn, () => notifyAdmins('queue', { queue: 'loan', id: r.insertId }));
      return { id: r.insertId, kind, amount: price - down };
    });
    return { loan };
  });
}
