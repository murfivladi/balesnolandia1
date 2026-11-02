// Этап 8: госпошлины, штрафы и налоги гражданина — оплата из ВлодБанка.
import { useState } from 'react';
import { get, post, newIdemKey } from '../shared/api.js';
import { t, fmtDate } from '../shared/i18n.js';
import { Money, Spinner, Empty, useAsync, ActionButton, Badge, ErrorBox, Select, StatusBadge } from '../shared/ui.jsx';
import { formatMoney } from '@bln/shared/money.js';
import { spendable } from './finance.jsx';

const SANCTION_TITLES = { arrest: 'Арест счетов', travel_ban: 'Запрет выезда из БФ', ip_closed: 'ИП закрыто' };

export function StateChargesPage({ tick }) {
  const { data, loading, error, reload } = useAsync(() => get('/bank/state-charges'), [tick]);
  const { data: ov } = useAsync(() => get('/bank/overview'), [tick]);
  const [account, setAccount] = useState(null);
  const [paid, setPaid] = useState({});
  if ((loading && !data) || !ov) return <div className="page medium"><Spinner /></div>;
  if (error) return <div className="page medium"><ErrorBox error={error} /></div>;
  const accounts = spendable(ov.accounts);
  const acc = account || accounts[0]?.id;
  const unpaid = data.invoices;
  const total = unpaid.reduce((s, i) => s + i.amount, 0);
  return (
    <div className="page medium">
      <div className="page-head">
        <h1>{t('Госуслуги и налоги')}</h1>
        {total > 0 && <div className="stat right"><span className="label">{t('К оплате')}</span><span className="value"><Money value={total} /></span></div>}
      </div>
      {data.sanctions.length > 0 && (
        <div className="card" style={{ borderColor: 'var(--err)', marginBottom: 16 }}>
          <h2>{t('Меры за неуплату')}</h2>
          <div className="list">
            {data.sanctions.map((s, i) => (
              <div key={i} className="list-item">
                <div className="li-main"><div className="li-title">{t(SANCTION_TITLES[s.kind] || s.kind)}</div><div className="li-sub">{t(s.reason)}</div></div>
                <Badge kind="err">{fmtDate(s.created_at, false)}</Badge>
              </div>
            ))}
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>{t('Оплатите все квитанции — меры снимутся автоматически.')}</p>
        </div>
      )}
      <div className="card">
        <div className="card-head"><h2>{t('Квитанции ВлодУслуг')}</h2>{unpaid.length > 0 && <a className="small" href="#/pay">{t('Оплата по номеру')}</a>}</div>
        {!unpaid.length ? <Empty>{t('Неоплаченных квитанций нет')}</Empty> : (
          <>
            {accounts.length > 1 && (
              <Select label={t('Счёт списания')} value={acc || ''} onChange={(e) => setAccount(Number(e.target.value))} options={accounts.map((a) => ({ value: a.id, label: `${t(a.name)} · ${formatMoney(a.balance)}` }))} />
            )}
            <div className="list">
              {unpaid.map((i) => (
                <div key={i.number} className="list-item">
                  <div className="li-main">
                    <div className="li-title">{t(i.purpose)}</div>
                    <div className="li-sub">№ <span className="mono">{i.number}</span>{i.due_month !== null ? ` · ${t('срок — месяц {n}', { n: i.due_month })}` : ''}{i.penalty > 0 ? ` · ${t('в т. ч. пени')} ${formatMoney(i.penalty)}` : ''}{i.frozen ? ` · ${t('заморожена')}` : ''}</div>
                  </div>
                  <div className="right"><b><Money value={i.amount} /></b></div>
                  {paid[i.number] ? <Badge kind="ok">{t('Оплачено')}</Badge> : (
                    <ActionButton size="sm" action={async () => { await post(`/bank/invoices/${i.number}/pay`, { account_id: acc }, { idem: newIdemKey() }); setPaid((p) => ({ ...p, [i.number]: true })); reload(); }}>{t('Оплатить')}</ActionButton>
                  )}
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      {data.paid.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>{t('Оплачено')}</h2>
          <div className="list">
            {data.paid.map((i) => (
              <div key={i.number} className="list-item">
                <div className="li-main"><div className="li-title">{t(i.purpose)}</div><div className="li-sub">{fmtDate(i.paid_at)}</div></div>
                <Money value={i.amount} />
                <StatusBadge status={i.status} />
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
