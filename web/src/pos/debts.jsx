// Тетрадь долгов магазина: продажа в долг, погашение наличными и картой,
// списание безнадёжного долга владельцем.
import { useState } from 'react';
import { get, post } from '../shared/api.js';
import { t, fmtDate } from '../shared/i18n.js';
import { Spinner, useAsync, Money, MoneyInput, Input, Modal, Empty, Button, ActionButton, Badge, ErrorBox, useToast, Seg } from '../shared/ui.jsx';
import { formatMoney } from '@bln/shared/money.js';
import { sound } from '../shared/sounds.js';

export function Debts({ session }) {
  return (
    <div className="page">
      <h1>{t('Долги')}</h1>
      <DebtBook session={session} />
    </div>
  );
}

export function DebtBook({ session, onClose }) {
  const [status, setStatus] = useState('open');
  const { data, loading, reload } = useAsync(() => get(`/pos/debts?status=${status}`), [status]);
  const [repay, setRepay] = useState(null);
  const toast = useToast();
  const isOwner = session?.staff?.role === 'owner';

  if (loading && !data) return <Spinner />;
  return (
    <div className="stack">
      <div className="grid grid-2">
        <div className="stat card"><span className="label">{t('Открытые долги')}</span><span className="value"><Money value={data.open_total} /></span></div>
        <div className="stat card"><span className="label">{t('Должников')}</span><span className="value">{data.open_count}</span></div>
      </div>
      <div className="row">
        <Seg value={status} onChange={setStatus} options={[{ value: 'open', label: t('Открытые') }, { value: 'paid', label: t('Закрытые') }, { value: 'written_off', label: t('Списанные') }]} />
        {onClose && <Button kind="ghost" size="sm" style={{ marginLeft: 'auto' }} onClick={onClose}>{t('Закрыть')}</Button>}
      </div>
      <div className="card">
        {!data.debts.length ? <Empty>{t('Долгов нет')}</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('Должник')}</th><th>{t('Когда')}</th><th>{t('Сумма')}</th><th>{t('Оплачено')}</th><th>{t('Осталось')}</th><th>{t('Статус')}</th><th /></tr></thead>
              <tbody>{data.debts.map((d) => (
                <tr key={d.id}>
                  <td>
                    {d.customer_name}
                    {d.bank_user_id ? <div><Badge kind="brand">{t('клиент ВлодБанка')}</Badge></div> : null}
                    {d.note ? <div className="tiny muted">{d.note}</div> : null}
                  </td>
                  <td className="small nowrap">{fmtDate(d.created_at, false)}{d.sale_id ? <div className="tiny muted">{t('чек')} #{d.sale_id}</div> : null}</td>
                  <td className="num"><Money value={d.amount} /></td>
                  <td className="num"><Money value={d.paid} /></td>
                  <td className="num"><b><Money value={d.left} /></b></td>
                  <td><Badge kind={d.status === 'open' ? 'warn' : d.status === 'paid' ? 'ok' : ''}>{t({ open: 'Открыт', paid: 'Закрыт', written_off: 'Списан' }[d.status])}</Badge></td>
                  <td className="right nowrap">
                    {d.status === 'open' && <Button kind="secondary" size="sm" onClick={() => setRepay(d)}>{t('Погасить')}</Button>}
                    {d.status === 'open' && isOwner && (
                      <ActionButton
                        size="sm"
                        kind="ghost"
                        confirm={t('Списать долг «{name}» на {sum}? Магазин не получит эти деньги.', { name: d.customer_name, sum: formatMoney(d.left) })}
                        action={async () => { await post(`/pos/debts/${d.id}/write-off`); toast(t('Долг списан'), 'ok'); reload(); }}
                      >{t('Списать')}</ActionButton>
                    )}
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <p className="small muted">{t('Долг клиента ВлодБанка виден ему в приложении банка: он может погасить его переводом. Наличные и карта на кассе закрывают долг сразу.')}</p>
      </div>
      {repay && <RepayModal debt={repay} onClose={() => setRepay(null)} onDone={() => { setRepay(null); reload(); sound.approve(); }} />}
    </div>
  );
}

function RepayModal({ debt, onClose, onDone }) {
  const [method, setMethod] = useState('cash');
  const [amount, setAmount] = useState(debt.left);
  const [number, setNumber] = useState('');
  const [exp, setExp] = useState('');
  const [pin, setPin] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function pay() {
    setBusy(true);
    setError(null);
    try {
      const body = { amount, method };
      if (method === 'card') { body.number = number; body.exp = exp; body.pin = pin; }
      const r = await post(`/pos/debts/${debt.id}/repay`, body);
      toast(`${t('Погашено')}: ${formatMoney(r.paid)}${r.left ? ` · ${t('осталось')} ${formatMoney(r.left)}` : ''}`, 'ok');
      onDone();
    } catch (e) { setError(e); sound.decline(); } finally { setBusy(false); }
  }
  return (
    <Modal title={`${t('Погашение долга')} · ${debt.customer_name}`} onClose={onClose}>
      <div className="stack">
        <div className="row" style={{ justifyContent: 'space-between' }}><span>{t('Долг')}</span><b><Money value={debt.amount} /></b></div>
        <div className="row" style={{ justifyContent: 'space-between' }}><span>{t('Осталось')}</span><b><Money value={debt.left} /></b></div>
        <MoneyInput label={t('Сумма погашения')} value={amount} onChange={setAmount} hint={t('Можно погасить часть долга')} />
        <Seg value={method} onChange={setMethod} options={[{ value: 'cash', label: t('Наличные') }, { value: 'card', label: t('Карта') }]} />
        {method === 'card' && (
          <>
            <Input label={t('Номер карты')} inputMode="numeric" value={number} onChange={(e) => setNumber(e.target.value.replace(/[^\d ]/g, ''))} />
            <div className="grid grid-2">
              <Input label={t('Срок ММ/ГГ')} value={exp} onChange={(e) => setExp(e.target.value)} placeholder="01/04" />
              <Input label={t('PIN')} inputMode="numeric" maxLength={3} type="password" value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
            </div>
          </>
        )}
        {method === 'cash' && <p className="small muted">{t('Наличные положите в ящик. Сумма попадёт в кассу смены.')}</p>}
        <ErrorBox error={error} />
        <div className="row">
          <Button kind="ghost" onClick={onClose}>{t('Отмена')}</Button>
          <Button className="grow" busy={busy} disabled={!amount || amount <= 0} onClick={pay}>{t('Принять')} {formatMoney(amount || 0)}</Button>
        </div>
      </div>
    </Modal>
  );
}
