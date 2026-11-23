// Покупки на сайтах БалНета (этап Н9): оплаты через эквайринг ВлодБанка, онлайн-заказы с кодом самовывоза,
// QR для курьера и цифровыми товарами, подписки с отменой. И работа курьера БалНета: взять заказ, вручить по QR.
// Общие страницы: в ВлодБанке (bank.bln/purchases) и на pay.bank.bln.
import { useState } from 'react';
import { get, post } from '../shared/api.js';
import { fmtDate } from '../shared/i18n.js';
import { Spinner, useAsync, Money, Empty, Button, ActionButton, Badge, ErrorBox, QR, Scanner, Input, Tabs, useToast } from '../shared/ui.jsx';

export const PAY_STATUS = {
  pending: ['Ждёт оплаты', 'warn'], paid: ['Оплачен', 'ok'], cancelled: ['Отменён', ''], expired: ['Истёк', ''], refunded: ['Возвращён', ''], partially_refunded: ['Частичный возврат', 'warn'],
};
export const ORDER_STATUS = {
  pending: ['Ждёт оплаты', 'warn'], paid: ['Оплачен, собирается', 'warn'], ready: ['Собран', 'ok'], delivering: ['В пути', 'warn'], delivered: ['Получен', 'ok'], cancelled: ['Отменён', ''], refunded: ['Возвращён', ''],
};
export const SUB_STATUS = { pending: ['Не оформлена', ''], active: ['Активна', 'ok'], past_due: ['Не оплачена', 'err'], cancelled: ['Отменена', ''] };
export const PHYSICAL = { pending: 'ждёт одобрения админа', approved: 'одобрена', rejected: 'отклонена', shipped: 'отправлена' };

export const StatusBadge = ({ map, status }) => {
  const [label, kind] = map[status] || [status, ''];
  return <Badge kind={kind}>{label}</Badge>;
};

const qty = (i) => (i.unit === 'kg' ? `${i.qty} кг` : `${i.qty} шт`);

function OrderCard({ o }) {
  const [qr, setQr] = useState(false);
  return (
    <div className="card pay-order">
      <div className="row-between">
        <div>
          <h3 style={{ margin: 0 }}>{o.shop}</h3>
          <div className="muted small">Заказ {o.id} · {fmtDate(o.paid_at || o.created_at)} · {o.delivery_title}</div>
        </div>
        <StatusBadge map={ORDER_STATUS} status={o.status} />
      </div>
      <div className="list" style={{ marginTop: 8 }}>
        {o.items.map((i) => (
          <div key={`${i.product_id}-${i.name}`} className="list-item">
            <div className="li-main"><div className="li-title">{i.name}</div><div className="li-sub">{qty(i)} × <Money value={i.price} /></div></div>
            <Money value={i.total} />
          </div>
        ))}
        {o.delivery_fee > 0 && <div className="list-item"><div className="li-main"><div className="li-title">Доставка курьером</div></div><Money value={o.delivery_fee} /></div>}
        <div className="list-item"><div className="li-main"><b>Итого</b></div><b><Money value={o.total} /></b></div>
      </div>
      {o.address && <p className="small">📍 {o.address}</p>}
      {o.physical_status && <p className="small">Реальная доставка: <b>{PHYSICAL[o.physical_status]}</b></p>}
      {o.pickup_code && (
        <div className="pay-code">
          <span className="muted small">Код для самовывоза — назовите на кассе</span>
          <b className="mono">{o.pickup_code}</b>
        </div>
      )}
      {o.handoff_token && (o.status === 'delivering' || o.status === 'ready') && (
        <div style={{ marginTop: 8 }}>
          {qr ? (
            <div className="center stack">
              <QR value={o.handoff_token} size={200} />
              <span className="tiny muted mono">{o.handoff_token}</span>
              <span className="small">Покажите QR курьеру при получении заказа</span>
            </div>
          ) : <Button onClick={() => setQr(true)}>Показать QR для курьера</Button>}
        </div>
      )}
      {o.digital?.length > 0 && (
        <div className="pay-digital">
          <b>Цифровые товары</b>
          {o.digital.map((d) => <div key={d.name}><div className="small muted">{d.name}</div><pre>{d.content}</pre></div>)}
        </div>
      )}
    </div>
  );
}

export function PurchasesPage({ tick }) {
  const { data, error, loading, reload } = useAsync(() => get('/pay/purchases'), [tick]);
  const [tab, setTab] = useState('orders');
  if (error) return <ErrorBox error={error} />;
  if (loading && !data) return <Spinner />;
  const activeSubs = data.subscriptions.filter((s) => s.status !== 'cancelled');
  return (
    <div className="page medium">
      <div className="page-head"><h1>Покупки на сайтах</h1></div>
      <p className="muted">Оплаты через ВлодБанк на сайтах БалНета, заказы с доставкой и подписки. Деньги за возврат приходят на тот счёт, с которого вы платили.</p>
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'orders', label: `Заказы (${data.orders.length})` },
        { value: 'payments', label: `Оплаты (${data.payments.length})` },
        { value: 'subs', label: `Подписки (${activeSubs.length})` },
      ]} />
      {tab === 'orders' && (data.orders.length ? <div className="stack">{data.orders.map((o) => <OrderCard key={o.id} o={o} />)}</div> : <Empty>Заказов пока нет</Empty>)}
      {tab === 'payments' && (data.payments.length ? (
        <div className="card"><div className="list">
          {data.payments.map((p) => (
            <div key={p.id} className="list-item">
              <div className="li-main"><div className="li-title">{p.merchant}</div><div className="li-sub">{p.description} · {fmtDate(p.paid_at)}{p.refunded ? ` · возвращено ${p.refunded / 100} В` : ''}</div></div>
              <Money value={-p.amount} />
              <StatusBadge map={PAY_STATUS} status={p.status} />
            </div>
          ))}
        </div></div>
      ) : <Empty>Оплат на сайтах пока не было</Empty>)}
      {tab === 'subs' && (data.subscriptions.length ? (
        <div className="card"><div className="list">
          {data.subscriptions.map((s) => (
            <div key={s.id} className="list-item">
              <div className="li-main">
                <div className="li-title">{s.merchant}</div>
                <div className="li-sub">{s.description} · раз в {s.period_months} игр. мес.{s.next_month && s.status !== 'cancelled' ? ` · следующее списание в месяце ${s.next_month}` : ''}</div>
              </div>
              <Money value={s.amount} />
              <StatusBadge map={SUB_STATUS} status={s.status} />
              {s.status !== 'cancelled' && s.status !== 'pending' && <ActionButton size="sm" kind="ghost" confirm="Отменить подписку? Списания прекратятся." okMessage="Подписка отменена" action={async () => { await post(`/pay/subscriptions/${s.id}/cancel`); reload(); }}>Отменить</ActionButton>}
            </div>
          ))}
        </div></div>
      ) : <Empty>Подписок нет</Empty>)}
    </div>
  );
}

export function CourierPage() {
  const { data, error, loading, reload } = useAsync(() => get('/pay/courier/jobs'), []);
  const [scan, setScan] = useState(false);
  const [token, setToken] = useState('');
  const toast = useToast();
  if (error) return <ErrorBox error={error} />;
  if (loading && !data) return <Spinner />;
  const confirm = async (tok) => {
    try {
      await post('/pay/courier/confirm', { token: tok });
      toast('Заказ вручён — оплата доставки на вашем счёте', 'ok');
      setToken('');
      reload();
    } catch (e) { toast(e.message, 'err'); }
  };
  const mine = data.jobs.filter((j) => j.mine);
  const open = data.jobs.filter((j) => !j.mine);
  return (
    <div className="page medium">
      <div className="page-head"><h1>Курьер БалНета</h1></div>
      <p className="muted">Возьмите собранный заказ, заберите его в магазине и отвезите покупателю. При вручении отсканируйте QR из его раздела «Покупки» — оплата доставки сразу придёт на ваш счёт.</p>
      {mine.length > 0 && (
        <div className="card">
          <h2>Мои доставки</h2>
          <div className="list">
            {mine.map((j) => (
              <div key={j.id} className="list-item">
                <div className="li-main"><div className="li-title">{j.shop} → {j.to}</div><div className="li-sub">{j.items.join(', ')}{j.contact ? ` · ${j.contact}` : ''}</div></div>
                <Money value={j.fee} />
                <ActionButton size="sm" kind="ghost" action={async () => { await post(`/pay/courier/jobs/${j.id}/drop`); reload(); }}>Отказаться</ActionButton>
              </div>
            ))}
          </div>
          <div className="row" style={{ marginTop: 12, gap: 8, flexWrap: 'wrap' }}>
            <Button kind="primary" onClick={() => setScan(true)}>📷 Сканировать QR покупателя</Button>
            <Input placeholder="или код ho_…" value={token} onChange={(e) => setToken(e.target.value.trim())} />
            <Button disabled={!token} onClick={() => confirm(token)}>Вручить</Button>
          </div>
        </div>
      )}
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Свободные заказы</h2>
        {!open.length ? <Empty>Сейчас заказов для доставки нет</Empty> : (
          <div className="list">
            {open.map((j) => (
              <div key={j.id} className="list-item">
                <div className="li-main">
                  <div className="li-title">{j.shop}{j.from ? ` (${j.from})` : ''}</div>
                  <div className="li-sub">Куда: {j.to} · {j.items.join(', ')}</div>
                </div>
                <b><Money value={j.fee} /></b>
                <ActionButton size="sm" okMessage="Заказ ваш — заберите его в магазине" action={async () => { await post(`/pay/courier/jobs/${j.id}/take`); reload(); }}>Взять</ActionButton>
              </div>
            ))}
          </div>
        )}
      </div>
      {scan && <Scanner onClose={() => setScan(false)} onScan={(v) => { setScan(false); confirm(String(v).trim()); }} />}
    </div>
  );
}
