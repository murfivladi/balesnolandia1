// Этап 8: реестр имущества, рынок, продажа и сделки. Оплата и ипотека — во ВлодБанке.
import { useState } from 'react';
import { get, post, appUrl } from '../shared/api.js';
import { t, fmtDate } from '../shared/i18n.js';
import { Money, MoneyInput, Input, Spinner, Empty, Modal, Form, useAsync, ActionButton, Badge, ErrorBox, Tabs } from '../shared/ui.jsx';
import { formatMoney } from '@bln/shared/money.js';

const KIND = { car: 'Автомобиль', realty: 'Недвижимость' };
const DEAL_STATUS = { pending: 'Ждёт оплаты', loan: 'Оформляется кредит', done: 'Завершена', cancelled: 'Отменена' };
const DEAL_KINDS = { pending: 'warn', loan: '', done: 'ok', cancelled: '' };

export function PropertyPage() {
  const [tab, setTab] = useState('mine');
  return (
    <div className="page">
      <h1>{t('Имущество')}</h1>
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'mine', label: t('Моё имущество') },
        { value: 'market', label: t('Рынок') },
        { value: 'deals', label: t('Сделки') },
      ]} />
      {tab === 'mine' && <MyProperty />}
      {tab === 'market' && <Market />}
      {tab === 'deals' && <Deals />}
    </div>
  );
}

function PropertyCard({ p, children }) {
  return (
    <div className="card stack">
      <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
        <div>
          <b>{p.title}</b>
          <div className="small muted">{t(KIND[p.kind] || p.kind)} · <span className="mono">{p.reg_number}</span></div>
          {p.address && <div className="small muted">{p.address}</div>}
        </div>
        <div className="right">
          <div><Money value={p.value} /></div>
          {p.lien_loan_id && <Badge kind="warn">{t('В залоге у банка')}</Badge>}
          {p.status === 'arrested' && <Badge kind="err">{t('Арестовано')}</Badge>}
        </div>
      </div>
      {p.details && <p className="small muted" style={{ margin: 0 }}>{p.details}</p>}
      {p.list_price !== null && <div className="small">{t('В продаже за {sum}', { sum: formatMoney(p.list_price) })}</div>}
      {children}
    </div>
  );
}

function MyProperty() {
  const { data, loading, error, reload } = useAsync(() => get('/gov/properties'), []);
  const [sell, setSell] = useState(null);
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  return (
    <div className="stack">
      {!data.properties.length ? <Empty>{t('Имущества нет. Купите лот на рынке или получите наследство от админа.')}</Empty> : (
        <div className="grid grid-2">
          {data.properties.map((p) => (
            <PropertyCard key={p.id} p={p}>
              <div className="row">
                {p.list_price === null && !p.lien_loan_id && p.status === 'active' && <button className="btn secondary sm" onClick={() => setSell(p)}>{t('Продать')}</button>}
                {p.list_price !== null && <ActionButton kind="ghost" size="sm" confirm={t('Снять с продажи?')} action={async () => { await post(`/gov/properties/${p.id}/sell`, { unlist: true }); reload(); }}>{t('Снять с продажи')}</ActionButton>}
                {p.lien_loan_id && <a className="btn secondary sm" href={appUrl('bank', '/credit')}>{t('Кредит и залог')}</a>}
              </div>
            </PropertyCard>
          ))}
        </div>
      )}
      {sell && <SellModal property={sell} onClose={() => setSell(null)} onDone={() => { setSell(null); reload(); }} />}
    </div>
  );
}

function SellModal({ property, onClose, onDone }) {
  const [price, setPrice] = useState(property.value);
  const [buyer, setBuyer] = useState('');
  return (
    <Modal title={t('Продажа: {title}', { title: property.title })} onClose={onClose}>
      <Form submitLabel={t('Выставить')} onSubmit={async () => {
        await post(`/gov/properties/${property.id}/sell`, { price, buyer_passport: buyer.trim() || undefined });
        onDone();
      }}>
        <MoneyInput label={t('Цена, влодинки')} value={price} onChange={(v) => setPrice(v ?? 0)} />
        <Input label={t('Паспорт покупателя (необязательно)')} placeholder="BLN-0000-0000" value={buyer} onChange={(e) => setBuyer(e.target.value.toUpperCase())} hint={t('Пусто — объявление появится на рынке для всех. С паспортом — предложение конкретному человеку.')} />
        <p className="small muted">{t('Покупатель оплатит сделку во ВлодБанке или возьмёт ипотеку / автокредит. Пока имущество в залоге, продать его нельзя.')}</p>
      </Form>
    </Modal>
  );
}

function Market() {
  const [kind, setKind] = useState('');
  const { data, loading, error, reload } = useAsync(() => get(`/gov/properties/market${kind ? `?kind=${kind}` : ''}`), [kind]);
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  return (
    <div className="stack">
      <div className="row">
        <span className="small muted">{t('Показать')}:</span>
        {[['', t('Всё')], ['realty', t('Недвижимость')], ['car', t('Автомобили')]].map(([v, l]) => (
          <button key={v} className={`btn sm ${kind === v ? '' : 'secondary'}`} onClick={() => setKind(v)}>{l}</button>
        ))}
      </div>
      {!data.properties.length ? <Empty>{t('На рынке пока пусто')}</Empty> : (
        <div className="grid grid-2">
          {data.properties.map((p) => (
            <PropertyCard key={p.id} p={p}>
              <div className="small muted">{t('Продавец')}: {p.owner_name || t('Государство БФ')}</div>
              <div className="row">
                <BuyButton p={p} onDone={reload} />
              </div>
            </PropertyCard>
          ))}
        </div>
      )}
      <p className="small muted">{t('Оплата — во ВлодБанке: целиком со счёта или в ипотеку / автокредит с первым взносом.')}</p>
    </div>
  );
}

function BuyButton({ p, onDone }) {
  const [busy, setBusy] = useState(false);
  const [deal, setDeal] = useState(null);
  return (
    <>
      <ActionButton busy={busy} action={async () => { setBusy(true); try { setDeal(await post(`/gov/properties/${p.id}/buy`)); onDone(); } finally { setBusy(false); } }}>
        {t('Купить за {sum}', { sum: formatMoney(p.list_price) })}
      </ActionButton>
      {deal && (
        <Modal title={t('Заявка на покупку')} onClose={() => setDeal(null)}>
          <div className="stack">
            <div className="form-ok">{t('Сделка создана. Оплатите её во ВлодБанке — там же можно оформить ипотеку или автокредит.')}</div>
            <a className="btn" href={appUrl('bank', '/property')}>{t('Перейти в ВлодБанк')}</a>
          </div>
        </Modal>
      )}
    </>
  );
}

function Deals() {
  const { data, loading, error, reload } = useAsync(() => get('/gov/properties'), []);
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  if (!data.deals.length) return <Empty>{t('Сделок пока нет')}</Empty>;
  return (
    <div className="card table-wrap">
      <table className="table">
        <thead><tr><th>{t('Имущество')}</th><th>{t('Покупатель')}</th><th>{t('Продавец')}</th><th>{t('Цена')}</th><th>{t('Создана')}</th><th>{t('Статус')}</th><th /></tr></thead>
        <tbody>
          {data.deals.map((d) => (
            <tr key={d.id}>
              <td>{d.title}<div className="tiny muted mono">{d.reg_number}</div></td>
              <td>{d.buyer_name}</td>
              <td>{d.seller_name || t('Государство БФ')}</td>
              <td className="num"><Money value={d.price} /></td>
              <td className="small">{fmtDate(d.created_at, false)}</td>
              <td><Badge kind={DEAL_KINDS[d.status]}>{t(DEAL_STATUS[d.status] || d.status)}</Badge></td>
              <td className="right">
                {d.status === 'pending' && d.buyer_citizen_id === data.me && <a className="btn sm" href={appUrl('bank', '/property')}>{t('Оплатить')}</a>}
                {['pending', 'loan'].includes(d.status) && <ActionButton kind="ghost" size="sm" confirm={t('Отменить сделку?')} action={async () => { await post(`/gov/deals/${d.id}/cancel`); reload(); }}>{t('Отменить')}</ActionButton>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
