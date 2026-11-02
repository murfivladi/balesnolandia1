// Отчёты владельцу: выручка и прибыль, популярные товары, кассиры, графики по дням
// и часам, категории, способы оплаты, источники, закупки, долги и склад.
import { useState } from 'react';
import { get } from '../shared/api.js';
import { t } from '../shared/i18n.js';
import { Spinner, useAsync, Money, Seg, Empty, Badge, Button } from '../shared/ui.jsx';
import { BarChart, LineChart, HBars } from '../shared/charts.jsx';
import { formatMoney } from '@bln/shared/money.js';
import { qtyLabel } from './lib.js';

export function Reports() {
  const [days, setDays] = useState(7);
  const { data, loading, reload } = useAsync(() => get(`/pos/reports?days=${days}`), [days]);
  if (loading && !data) return <Spinner />;
  if (!data) return <Empty>{t('Отчёт не загрузился')}</Empty>;

  const hours = Array.from({ length: 24 }, (_, h) => {
    const r = data.by_hour.find((x) => Number(x.hour) === h);
    return { label: String(h).padStart(2, '0'), value: r?.total || 0, hint: `${String(h).padStart(2, '0')}:00 — ${r ? formatMoney(r.total) : formatMoney(0)}` };
  });
  const dayLabel = (d) => {
    const s = String(d).slice(0, 10);
    const [y, m, dd] = s.split('-');
    return y ? `${dd}.${m}` : s;
  };
  const methods = [
    { key: 'cash', label: t('Наличные') },
    { key: 'card', label: t('Карта') },
    { key: 'qr', label: t('QR-оплата') },
    { key: 'debt', label: t('В долг') },
  ].map((m) => ({ label: m.label, value: data.by_method[m.key] || 0 }));
  const sources = [
    { key: 'pos', label: t('Касса') },
    { key: 'kiosk', label: t('Киоск') },
    { key: 'tab', label: t('Столы') },
  ].map((s) => ({ label: s.label, value: data.by_source[s.key]?.total || 0 }));

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Отчёты')}</h1>
        <Seg value={days} onChange={setDays} options={[{ value: 1, label: t('Сутки') }, { value: 7, label: t('7 дней') }, { value: 30, label: t('30 дней') }, { value: 90, label: t('90 дней') }]} />
        <Button kind="secondary" size="sm" onClick={reload}>{t('Обновить')}</Button>
      </div>

      <div className="grid grid-4">
        <Stat label={t('Выручка')} value={data.revenue} />
        <Stat label={t('Прибыль после НДС и закупки')} value={data.profit} />
        <Stat label={t('Средний чек')} value={data.avg_check} />
        <Stat label={t('Чеков')} value={data.sales} plain />
        <Stat label={t('НДС')} value={data.vat} />
        <Stat label={t('Скидки')} value={data.discounts} />
        <Stat label={t('Возвраты')} value={data.refunds} />
        <Stat label={t('Чаевые кассирам')} value={data.tips} />
      </div>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <div className="card-head"><h2>{t('Выручка по дням')}</h2><Badge>{t('за {n} дн.', { n: days })}</Badge></div>
          <LineChart
            data={data.by_day.map((d) => ({ label: dayLabel(d.day), value: d.total, hint: `${dayLabel(d.day)} — ${formatMoney(d.total)} (${d.sales} ${t('чеков')})` }))}
            empty={t('Продаж за период нет')}
          />
        </div>
        <div className="card">
          <h2>{t('Выручка по часам')}</h2>
          <BarChart data={hours} height={170} empty={t('Продаж за период нет')} />
        </div>
      </div>

      <div className="grid grid-3" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>{t('Категории')}</h2>
          <HBars data={data.by_category.map((c) => ({ label: c.category, value: c.total }))} empty={t('Продаж пока нет')} />
        </div>
        <div className="card">
          <h2>{t('Способы оплаты')}</h2>
          <HBars data={methods} empty={t('Продаж пока нет')} />
        </div>
        <div className="card">
          <h2>{t('Источники продаж')}</h2>
          <HBars data={sources} empty={t('Продаж пока нет')} />
        </div>
      </div>

      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>{t('Популярные товары')}</h2>
          {!data.top.length ? <p className="muted">{t('Продаж пока нет')}</p> : (
            <table className="table">
              <thead><tr><th>{t('Товар')}</th><th>{t('Продано')}</th><th>{t('Выручка')}</th></tr></thead>
              <tbody>{data.top.map((r) => <tr key={r.name}><td>{r.name}</td><td>{qtyLabel(r.unit, r.qty_milli)}</td><td className="num right"><Money value={r.total} /></td></tr>)}</tbody>
            </table>
          )}
        </div>
        <div className="card">
          <h2>{t('По кассирам')}</h2>
          {!data.by_cashier.length ? <p className="muted">{t('Продаж пока нет')}</p> : (
            <table className="table">
              <thead><tr><th>{t('Кассир')}</th><th>{t('Чеков')}</th><th>{t('Выручка')}</th><th>{t('Чаевые')}</th></tr></thead>
              <tbody>{data.by_cashier.map((r) => <tr key={r.name}><td>{r.name}</td><td>{r.sales}</td><td className="num"><Money value={r.total} /></td><td className="num"><Money value={r.tips} /></td></tr>)}</tbody>
            </table>
          )}
        </div>
      </div>

      <div className="grid grid-4" style={{ marginTop: 16 }}>
        <Stat label={t('Закупки за период')} value={data.purchases} />
        <Stat label={t('Долги покупателей')} value={data.debts_open} />
        <Stat label={t('Товар на складе')} value={data.stock_value} />
        <Stat label={t('Бизнес-счёт')} value={data.business_balance} />
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><h2>{t('Пора закупить')}</h2><Badge kind={data.low_stock.length ? 'warn' : 'ok'}>{data.low_stock.length}</Badge></div>
        {!data.low_stock.length ? <p className="muted">{t('Остатки в порядке')}</p> : (
          <table className="table">
            <thead><tr><th>{t('Товар')}</th><th>{t('Остаток')}</th><th /></tr></thead>
            <tbody>{data.low_stock.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td>
                <td className="num">{qtyLabel(p.unit, p.stock_milli)}</td>
                <td className="right"><a className="btn secondary sm" href="#/manage/purchases">{t('Закупить')}</a></td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
      <p className="small muted" style={{ marginTop: 12 }}>{t('Прибыль = выручка минус НДС и закупочная стоимость проданных товаров. Долги и закупки не входят в прибыль до оплаты.')}</p>
    </div>
  );
}

function Stat({ label, value, plain }) {
  return <div className="card stat"><span className="label">{label}</span><span className="value">{plain ? value : <Money value={value} />}</span></div>;
}
