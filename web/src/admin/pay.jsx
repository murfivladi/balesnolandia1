// Админка БалНета → Эквайринг (этап Н9): обороты, НДС и комиссия банка, магазины и их блокировка, последние платежи,
// очередь реальной доставки (не чаще раза в неделю на покупателя, только после одобрения) и приложения OAuth.
import { useState } from 'react';
import { get, post } from '../shared/api.js';
import { fmtDate } from '../shared/i18n.js';
import { Spinner, useAsync, Badge, ActionButton, ErrorBox, Money, Empty, Input } from '../shared/ui.jsx';

const PS = { paid: ['оплачен', 'ok'], pending: ['ждёт оплаты', 'warn'], refunded: ['возвращён', ''], partially_refunded: ['частичный возврат', 'warn'], cancelled: ['отменён', ''], expired: ['истёк', ''] };

export function PayAdmin() {
  const ov = useAsync(() => get('/admin/pay/overview'), []);
  const phys = useAsync(() => get('/admin/pay/physical'), []);
  const mer = useAsync(() => get('/admin/pay/merchants'), []);
  const pays = useAsync(() => get('/admin/pay/payments'), []);
  const apps = useAsync(() => get('/admin/pay/oauth-clients'), []);
  const [note, setNote] = useState({});
  if (!ov.data) return ov.error ? <ErrorBox error={ov.error} /> : <Spinner />;
  const s = ov.data;
  const reload = () => { ov.reload(); phys.reload(); mer.reload(); };
  return (
    <div className="stack">
      <div className="card stack-sm">
        <h2>Эквайринг ВлодБанка</h2>
        <p>
          Оплат <b>{s.payments}</b> на <b><Money value={s.amount} /></b>: НДС в бюджет <b><Money value={s.vat} /></b>, комиссия банка <b><Money value={s.fee} /></b>, возвращено <Money value={s.refunded} />.
          Магазинов <b>{s.merchants}</b>{s.blocked ? ` (остановлено ${s.blocked})` : ''}, активных подписок <b>{s.subscriptions}</b>, приложений входа <b>{s.oauth_clients}</b>.
          {s.webhooks_failed ? <> Недоставленных вебхуков: <Badge kind="err">{s.webhooks_failed}</Badge>.</> : null}
        </p>
        <p className="small muted">Комиссия, срок ссылки и лимит реальной доставки — в «Система → Настройки»: online_fee_bp, pay_link_minutes, physical_delivery_days.</p>
      </div>

      <div className="card stack-sm">
        <h2>Реальная доставка — очередь {s.physical_pending ? <Badge kind="warn">{s.physical_pending}</Badge> : null}</h2>
        <p className="small muted">Физическая доставка в реальном мире — не чаще раза в неделю на покупателя. При отказе заказ отменяется и деньги возвращаются покупателю автоматически.</p>
        {!phys.data ? <Spinner /> : !phys.data.orders.length ? <Empty>Заявок нет</Empty> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Когда</th><th>Магазин</th><th>Покупатель</th><th>Состав</th><th>Адрес</th><th>Сумма</th><th>Решение</th></tr></thead>
            <tbody>{phys.data.orders.map((o) => (
              <tr key={o.id}>
                <td className="small">{fmtDate(o.paid_at)}</td>
                <td>{o.shop}</td>
                <td className="small">{o.buyer}<div className="tiny muted">{o.buyer_email}</div></td>
                <td className="small">{o.items.map((i) => `${i.name} × ${i.qty}`).join(', ')}</td>
                <td className="small">{o.address}{o.contact ? <div className="tiny muted">{o.contact}</div> : null}</td>
                <td><Money value={o.total} /></td>
                <td>
                  <div className="row">
                    <Input placeholder="комментарий" value={note[o.internal_id] || ''} onChange={(e) => setNote({ ...note, [o.internal_id]: e.target.value })} />
                    <ActionButton size="sm" okMessage="Одобрено" action={async () => { await post(`/admin/pay/physical/${o.internal_id}`, { approve: true, note: note[o.internal_id] }); reload(); }}>Одобрить</ActionButton>
                    <ActionButton size="sm" kind="danger" confirm="Отклонить? Деньги вернутся покупателю." okMessage="Отклонено, деньги возвращены" action={async () => { await post(`/admin/pay/physical/${o.internal_id}`, { approve: false, note: note[o.internal_id] }); reload(); }}>Отклонить</ActionButton>
                  </div>
                </td>
              </tr>
            ))}</tbody></table></div>
        )}
      </div>

      <div className="card stack-sm">
        <h2>Магазины</h2>
        {!mer.data ? <Spinner /> : !mer.data.merchants.length ? <Empty>Магазинов пока нет</Empty> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Магазин</th><th>Владелец</th><th>Сайт</th><th>Оплат</th><th>Оборот</th><th>Статус</th><th /></tr></thead>
            <tbody>{mer.data.merchants.map((m) => (
              <tr key={m.id}>
                <td>{m.name}<div className="tiny muted mono">{m.public_id}{m.shop ? ` · Касса: ${m.shop.name}` : ''}</div></td>
                <td>{m.owner_name}</td>
                <td className="small">{m.site_url || '—'}</td>
                <td>{m.stats.payments}</td>
                <td><Money value={m.stats.amount} /></td>
                <td><Badge kind={m.status === 'active' ? 'ok' : 'err'}>{m.status === 'active' ? 'работает' : 'остановлен'}</Badge></td>
                <td>
                  <ActionButton size="sm" kind={m.status === 'active' ? 'danger' : ''} confirm={m.status === 'active' ? `Остановить приём платежей «${m.name}»?` : undefined}
                    action={async () => { await post(`/admin/pay/merchants/${m.id}/block`, { blocked: m.status === 'active' }); mer.reload(); ov.reload(); }}>
                    {m.status === 'active' ? 'Остановить' : 'Возобновить'}
                  </ActionButton>
                </td>
              </tr>
            ))}</tbody></table></div>
        )}
      </div>

      <div className="card stack-sm">
        <h2>Последние платежи</h2>
        {!pays.data ? <Spinner /> : !pays.data.payments.length ? <Empty>Платежей нет</Empty> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Когда</th><th>Магазин</th><th>За что</th><th>Плательщик</th><th>Сумма</th><th>НДС</th><th>Комиссия</th><th>Статус</th></tr></thead>
            <tbody>{pays.data.payments.map((p) => (
              <tr key={p.id}>
                <td className="small">{fmtDate(p.paid_at || p.created_at)}</td>
                <td>{p.merchant}</td>
                <td className="small">{p.description}</td>
                <td className="small">{p.payer_name || '—'}</td>
                <td><Money value={p.amount} /></td>
                <td><Money value={p.vat} /></td>
                <td><Money value={p.fee} /></td>
                <td><Badge kind={PS[p.status]?.[1] || ''}>{PS[p.status]?.[0] || p.status}</Badge></td>
              </tr>
            ))}</tbody></table></div>
        )}
      </div>

      <div className="card stack-sm">
        <h2>Приложения «Войти через ВлодПочту / ВлодУслуги»</h2>
        {!apps.data ? <Spinner /> : !apps.data.clients.length ? <Empty>Приложений нет</Empty> : (
          <div className="table-wrap"><table className="table"><thead><tr><th>Приложение</th><th>Владелец</th><th>Адреса возврата</th><th>Пользователей</th><th /></tr></thead>
            <tbody>{apps.data.clients.map((c) => (
              <tr key={c.id}>
                <td>{c.name}<div className="tiny muted mono">{c.client_id}</div></td>
                <td>{c.owner_name}</td>
                <td className="small">{c.redirect_uris.join(', ')}</td>
                <td>{c.users}</td>
                <td>
                  <ActionButton size="sm" kind={c.status === 'active' ? 'danger' : ''} confirm={c.status === 'active' ? 'Заблокировать приложение? Все его токены будут отозваны.' : undefined}
                    action={async () => { await post(`/admin/pay/oauth-clients/${c.id}/block`, { blocked: c.status === 'active' }); apps.reload(); }}>
                    {c.status === 'active' ? 'Заблокировать' : 'Разблокировать'}
                  </ActionButton>
                </td>
              </tr>
            ))}</tbody></table></div>
        )}
      </div>
    </div>
  );
}
