// Долги клиента магазинам («тетрадь долгов» кассы). Погашение — со своего счёта
// в один клик или частично; после оплаты магазин получает деньги сразу.
import { useState } from 'react';
import { get, post, newIdemKey } from '../shared/api.js';
import { t, fmtDate } from '../shared/i18n.js';
import { Spinner, useAsync, Money, MoneyInput, Select, Modal, Empty, Button, Badge, ErrorBox, useToast } from '../shared/ui.jsx';
import { formatMoney } from '@bln/shared/money.js';
import { spendable } from './finance.jsx';

export function DebtsPage({ tick }) {
  const { data, loading, reload } = useAsync(() => get('/bank/debts'), [tick]);
  const { data: accounts } = useAsync(() => get('/bank/accounts'), [tick]);
  const [pay, setPay] = useState(null);
  const toast = useToast();
  if (loading && !data) return <Spinner />;
  const open = data.debts.filter((d) => d.status === 'open');
  const closed = data.debts.filter((d) => d.status !== 'open');
  const total = open.reduce((s, d) => s + d.left, 0);
  return (
    <div className="page medium">
      <div className="page-head">
        <h1>{t('Долги магазинам')}</h1>
        <div className="stat right"><span className="label">{t('Всего долгов')}</span><span className="value"><Money value={total} /></span></div>
      </div>
      <p className="muted">{t('Здесь собраны покупки в долг в магазинах Балесноландии. Оплатите с любого счёта — магазин получит деньги сразу, долг закроется.')}</p>
      {!open.length ? <Empty>{t('Открытых долгов нет')}</Empty> : (
        <div className="card">
          <div className="list">
            {open.map((d) => (
              <div key={d.id} className="list-item">
                <div className="li-main">
                  <div className="li-title">{d.shop_name}</div>
                  <div className="li-sub">{fmtDate(d.created_at)}{d.note ? ` · ${d.note}` : ''}{d.sale_id ? ` · ${t('чек')} #${d.sale_id}` : ''}</div>
                </div>
                <div className="right">
                  <b className="num"><Money value={d.left} /></b>
                  {d.paid > 0 && <div className="tiny muted">{t('оплачено')} {formatMoney(d.paid)} {t('из')} {formatMoney(d.amount)}</div>}
                </div>
                <Button size="sm" onClick={() => setPay(d)}>{t('Погасить')}</Button>
              </div>
            ))}
          </div>
        </div>
      )}
      {closed.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>{t('Закрытые долги')}</h2>
          <div className="list">
            {closed.map((d) => (
              <div key={d.id} className="list-item">
                <div className="li-main"><div className="li-title">{d.shop_name}</div><div className="li-sub">{fmtDate(d.paid_at || d.created_at)}</div></div>
                <Money value={d.amount} />
                <Badge kind={d.status === 'paid' ? 'ok' : ''}>{t({ paid: 'Закрыт', written_off: 'Списан' }[d.status] || d.status)}</Badge>
              </div>
            ))}
          </div>
        </div>
      )}
      {pay && (
        <PayDebt
          debt={pay}
          accounts={spendable(accounts?.accounts || [])}
          onClose={() => setPay(null)}
          onDone={() => { setPay(null); toast(t('Долг погашен'), 'ok'); reload(); }}
        />
      )}
      <p className="small muted" style={{ marginTop: 12 }}>{t('Долг в магазине — не кредит ВлодБанка: проценты не начисляются, кредитный рейтинг не меняется.')}</p>
    </div>
  );
}

function PayDebt({ debt, accounts, onClose, onDone }) {
  const [accountId, setAccountId] = useState(accounts[0]?.id || '');
  const [amount, setAmount] = useState(debt.left);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [idem] = useState(newIdemKey);
  async function submit() {
    setBusy(true);
    setError(null);
    try {
      await post(`/bank/debts/${debt.id}/pay`, { account_id: Number(accountId), amount }, { idem });
      onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }
  return (
    <Modal title={`${t('Погашение долга')} · ${debt.shop_name}`} onClose={onClose}>
      <div className="stack">
        <div className="row" style={{ justifyContent: 'space-between' }}><span>{t('Долг')}</span><b><Money value={debt.left} /></b></div>
        {!accounts.length ? <div className="form-error">{t('Нет счёта, с которого можно заплатить')}</div> : (
          <>
            <Select label={t('Счёт списания')} value={accountId} onChange={(e) => setAccountId(Number(e.target.value))} options={accounts.map((a) => ({ value: a.id, label: `${t(a.name)} · ${formatMoney(a.balance)}` }))} />
            <MoneyInput label={t('Сумма')} value={amount} onChange={setAmount} hint={t('Можно погасить часть долга')} />
            <ErrorBox error={error} />
            <div className="row">
              <Button kind="ghost" onClick={onClose}>{t('Отмена')}</Button>
              <Button className="grow" busy={busy} disabled={!accountId || !amount || amount <= 0} onClick={submit}>{t('Заплатить')} {formatMoney(amount || 0)}</Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
