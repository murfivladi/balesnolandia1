// Этап 8: покупка имущества — оплата со счёта, ипотека и автокредит, залог.
import { useState } from 'react';
import { get, post, newIdemKey } from '../shared/api.js';
import { t, fmtDate } from '../shared/i18n.js';
import { Money, MoneyInput, Input, Spinner, Empty, Modal, Form, useAsync, ActionButton, Badge, ErrorBox, Select, StatusBadge } from '../shared/ui.jsx';
import { formatMoney, pct } from '@bln/shared/money.js';
import { spendable } from './finance.jsx';

const KIND = { car: 'Автомобиль', realty: 'Недвижимость' };
const DEAL_STATUS = { pending: 'Ждёт оплаты', loan: 'Одобряется кредит', done: 'Завершена', cancelled: 'Отменена' };

export function BankPropertyPage({ tick }) {
  const { data, loading, error, reload } = useAsync(() => get('/bank/property'), [tick]);
  const { data: ov } = useAsync(() => get('/bank/overview'), [tick]);
  const [account, setAccount] = useState(null);
  const [loan, setLoan] = useState(null);
  const [done, setDone] = useState({});
  if ((loading && !data) || !ov) return <div className="page medium"><Spinner /></div>;
  if (error) return <div className="page medium"><ErrorBox error={error} /></div>;
  const accounts = spendable(ov.accounts);
  const acc = account || accounts[0]?.id;
  const open = data.deals.filter((d) => ['pending', 'loan'].includes(d.status));
  const closed = data.deals.filter((d) => !['pending', 'loan'].includes(d.status));
  return (
    <div className="page medium">
      <div className="page-head"><h1>{t('Имущество')}</h1><a className="btn secondary" href="#/credit">{t('Мои кредиты')}</a></div>
      <p className="muted">{t('Сделки с недвижимостью и автомобилями: оплата целиком со счёта или в ипотеку / автокредит с первым взносом.')}</p>
      {!open.length ? <Empty>{t('Сделок, ожидающих оплаты, нет')}</Empty> : (
        <div className="stack">
          {open.map((d) => (
            <div key={d.id} className="card">
              <div className="card-head">
                <div>
                  <b>{d.title}</b>
                  <div className="small muted">{t(KIND[d.kind] || d.kind)} · <span className="mono">{d.reg_number}</span> · {t('продавец')}: {d.seller_name}</div>
                </div>
                <div className="right">
                  <div style={{ fontSize: '1.2rem', fontWeight: 700 }}><Money value={d.price} /></div>
                  <StatusBadge status={d.status === 'loan' ? 'pending' : 'unpaid'} />
                </div>
              </div>
              {done[d.id] ? <div className="form-ok">{t('Оплачено. Имущество переоформлено на вас.')}</div> : d.status === 'loan' ? (
                <div className="form-warn">{t('Заявка на кредит отправлена админу. После одобрения деньги уйдут продавцу, а имущество — вам в залог до погашения.')}</div>
              ) : (
                <>
                  {accounts.length > 1 && (
                    <Select label={t('Счёт списания')} value={acc || ''} onChange={(e) => setAccount(Number(e.target.value))} options={accounts.map((a) => ({ value: a.id, label: `${t(a.name)} · ${formatMoney(a.balance)}` }))} />
                  )}
                  <div className="row">
                    <ActionButton action={async () => { await post(`/bank/property-deals/${d.id}/pay`, { account_id: acc }, { idem: newIdemKey() }); setDone((x) => ({ ...x, [d.id]: true })); reload(); }}>
                      {t('Оплатить')} {formatMoney(d.price)}
                    </ActionButton>
                    <button className="btn secondary" onClick={() => setLoan({ deal: d, months: 24, down_payment: Math.round(d.price * 0.2) })}>{t('В ипотеку / автокредит')}</button>
                  </div>
                  <p className="small muted">{t('Первый взнос — не меньше {sum}.', { sum: formatMoney(Math.round((d.price * data.terms.min_down_bp) / 10000)) })}</p>
                </>
              )}
            </div>
          ))}
        </div>
      )}

      <div className="card" style={{ marginTop: 16 }}>
        <h2>{t('Условия кредита')}</h2>
        <div className="grid grid-3">
          <div className="stat"><span className="label">{t('Ипотека')}</span><span className="value">{pct(data.terms.mortgage_rate_bp)}</span></div>
          <div className="stat"><span className="label">{t('Автокредит')}</span><span className="value">{pct(data.terms.auto_loan_rate_bp)}</span></div>
          <div className="stat"><span className="label">{t('Срок до, месяцев')}</span><span className="value">{data.terms.max_months}</span></div>
        </div>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>{t('Моё имущество')}</h2>
        {!data.properties.length ? <p className="muted">{t('Имущества пока нет')}</p> : (
          <div className="list">
            {data.properties.map((p) => (
              <div key={p.id} className="list-item">
                <div className="li-main">
                  <div className="li-title">{p.title} {p.lien_loan_id && <Badge kind="warn">{t('в залоге')}</Badge>}</div>
                  <div className="li-sub">{t(KIND[p.kind] || p.kind)} · <span className="mono">{p.reg_number}</span>{p.address ? ` · ${p.address}` : ''}</div>
                </div>
                <Money value={p.value} />
              </div>
            ))}
          </div>
        )}
      </div>

      {closed.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>{t('История сделок')}</h2>
          <div className="list">
            {closed.map((d) => (
              <div key={d.id} className="list-item">
                <div className="li-main"><div className="li-title">{d.title}</div><div className="li-sub">{fmtDate(d.closed_at || d.created_at)} · {t('продавец')}: {d.seller_name}</div></div>
                <Money value={d.price} />
                <Badge kind={d.status === 'done' ? 'ok' : ''}>{t(DEAL_STATUS[d.status] || d.status)}</Badge>
              </div>
            ))}
          </div>
        </div>
      )}

      {loan && <LoanModal data={loan} accounts={accounts} terms={data.terms} onClose={() => setLoan(null)} onDone={() => { setLoan(null); reload(); }} />}
    </div>
  );
}

function LoanModal({ data, accounts, terms, onClose, onDone }) {
  const [f, setF] = useState({ down_payment: data.down_payment, months: data.months, account_id: accounts[0]?.id || null });
  const price = data.deal.price;
  const body = price - f.down_payment;
  return (
    <Modal title={t('Ипотека / автокредит')} onClose={onClose}>
      <Form submitLabel={t('Отправить заявку')} onSubmit={async () => {
        await post(`/bank/property-deals/${data.deal.id}/loan`, f);
        onDone();
      }}>
        <p className="small muted">{data.deal.title} · <b>{formatMoney(price)}</b></p>
        <MoneyInput label={t('Первый взнос')} value={f.down_payment} onChange={(v) => setF({ ...f, down_payment: v ?? 0 })} hint={t('Минимум {sum}', { sum: formatMoney(Math.round((price * terms.min_down_bp) / 10000)) })} />
        <Input label={t('Срок, месяцев')} type="number" min={1} max={terms.max_months} value={f.months} onChange={(e) => setF({ ...f, months: Number(e.target.value) })} />
        {accounts.length > 1 && (
          <Select label={t('Счёт для взноса и платежей')} value={f.account_id || ''} onChange={(e) => setF({ ...f, account_id: Number(e.target.value) })} options={accounts.map((a) => ({ value: a.id, label: `${t(a.name)} · ${formatMoney(a.balance)}` }))} />
        )}
        <div className="card" style={{ background: 'var(--surface-2)', boxShadow: 'none' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}><span>{t('Сумма кредита')}</span><b>{formatMoney(body)}</b></div>
          <div className="row" style={{ justifyContent: 'space-between' }}><span>{t('Ставка')}</span><b>{formatMoney(Math.round((body * (data.deal.kind === 'car' ? terms.auto_loan_rate_bp : terms.mortgage_rate_bp)) / 10000))} {t('в месяц')}</b></div>
        </div>
        <p className="small muted">{t('Заявку рассматривает админ. Деньги уйдут продавцу при одобрении, имущество будет в залоге до погашения.')}</p>
      </Form>
    </Modal>
  );
}
