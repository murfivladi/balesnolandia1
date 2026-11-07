// Касса → Онлайн-заказы (этап Н9): заказы с сайта магазина, оплаченные через ВлодБанк. Сборка, выдача самовывоза
// по коду покупателя, передача курьерам БалНета и отправка реальной доставки после одобрения админа.
import { useState } from 'react';
import { get, post } from '../shared/api.js';
import { t, fmtDate } from '../shared/i18n.js';
import { Spinner, useAsync, Money, Empty, Badge, ActionButton, Button, ErrorBox, Seg, useChannel, useToast } from '../shared/ui.jsx';
import { sound } from '../shared/sounds.js';

const STATUS = { paid: ['Собрать', 'warn'], ready: ['Собран', 'ok'], delivering: ['У курьера', 'warn'], delivered: ['Выдан', 'ok'], refunded: ['Возврат', ''], cancelled: ['Отменён', ''] };
const DELIVERY = { pickup: '🏪 Самовывоз', courier: '🛵 Курьер', digital: '💾 Цифровой', physical: '📦 Реальная доставка' };
const PHYS = { pending: 'ждёт одобрения админа', approved: 'одобрена админом', rejected: 'отклонена', shipped: 'отправлена' };

export function OnlineOrders({ session }) {
  const [filter, setFilter] = useState('open');
  const list = useAsync(() => get(`/pos/online-orders${filter === 'all' ? '?status=all' : ''}`), [filter]);
  const [code, setCode] = useState('');
  const toast = useToast();
  useChannel(`shop:${session.shop.id}`, (m) => {
    if (m.type === 'online_order') {
      list.reload();
      try { sound.approve(); } catch { /* без звука */ }
    }
  });
  if (list.error) return <div className="page"><ErrorBox error={list.error} /></div>;
  if (!list.data) return <Spinner />;
  const { orders, merchant } = list.data;
  const issue = async () => {
    try {
      await post('/pos/online-orders/pickup', { code });
      toast(t('Заказ выдан'), 'ok');
      setCode('');
      list.reload();
    } catch (e) { toast(e.message, 'err'); }
  };
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Онлайн-заказы')}</h1>
        <Seg value={filter} onChange={setFilter} options={[{ value: 'open', label: t('В работе') }, { value: 'all', label: t('Все') }]} />
      </div>
      {!merchant && <p className="muted">{t('Магазин не подключён к эквайрингу. Подключите его на pay.bank.bln → «Бизнесу» и отметьте товары «Продаётся онлайн».')}</p>}
      <form className="card row" onSubmit={(e) => { e.preventDefault(); issue(); }}>
        <b>{t('Выдать самовывоз')}</b>
        <input className="input mono" style={{ maxWidth: 160, letterSpacing: 4 }} inputMode="numeric" maxLength={6} placeholder="000000" value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} />
        <Button type="submit" disabled={code.length !== 6}>{t('Выдать по коду')}</Button>
        <span className="small muted">{t('Покупатель называет 6 цифр из раздела «Покупки» ВлодБанка')}</span>
      </form>
      {!orders.length ? <Empty>{filter === 'open' ? t('Заказов в работе нет') : t('Онлайн-заказов пока не было')}</Empty> : (
        <div className="grid grid-auto" style={{ marginTop: 16 }}>
          {orders.map((o) => {
            const [label, kind] = STATUS[o.status] || [o.status, ''];
            return (
              <div key={o.id} className="card stack-sm">
                <div className="row-between"><b>{DELIVERY[o.delivery]}</b><Badge kind={kind}>{t(label)}</Badge></div>
                <div className="tiny muted mono">{o.id} · {fmtDate(o.paid_at)}{o.sale_id ? ` · ${t('чек')} #${o.sale_id}` : ''}</div>
                <ul className="small" style={{ margin: '4px 0', paddingLeft: 18 }}>
                  {o.items.map((i) => <li key={`${i.product_id}-${i.name}`}>{i.name} × {i.qty}{i.digital ? ' 💾' : ''}</li>)}
                </ul>
                <div className="row-between"><span className="small">{t('Итого')}</span><b><Money value={o.total} /></b></div>
                {o.address && <div className="small">📍 {o.address}</div>}
                {o.contact && <div className="small">☎ {o.contact}</div>}
                {o.physical_status && <div className="small">{t('Реальная доставка')}: <b>{t(PHYS[o.physical_status])}</b>{o.admin_note ? ` — ${o.admin_note}` : ''}</div>}
                {o.delivery === 'courier' && o.status === 'delivering' && <div className="small">🛵 {t('Курьер везёт заказ')}</div>}
                <div className="row">
                  {o.status === 'paid' && (o.delivery !== 'physical' || o.physical_status === 'approved') && (
                    <ActionButton size="sm" action={async () => { await post(`/pos/online-orders/${o.internal_id}/ready`); list.reload(); }}>
                      {o.delivery === 'courier' ? t('Собран — вызвать курьера') : t('Собран')}
                    </ActionButton>
                  )}
                  {o.delivery === 'physical' && o.status === 'ready' && <ActionButton size="sm" action={async () => { await post(`/pos/online-orders/${o.internal_id}/ship`, {}); list.reload(); }}>{t('Отправлен')}</ActionButton>}
                  {o.delivery === 'physical' && o.status === 'delivering' && <ActionButton size="sm" action={async () => { await post(`/pos/online-orders/${o.internal_id}/ship`, { delivered: true }); list.reload(); }}>{t('Доставлен')}</ActionButton>}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
