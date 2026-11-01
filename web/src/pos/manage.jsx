import { useState } from 'react';
import { get, post, patch } from '../shared/api.js';
import { t, fmtDate } from '../shared/i18n.js';
import { pick } from '../shared/router.js';
import { Spinner, useAsync, Money, MoneyInput, Input, Select, Form, Modal, Empty, Badge, PhotoInput, Scanner, useToast, Seg, Field } from '../shared/ui.jsx';
import { formatMoney } from '@bln/shared/money.js';
import { applyShopColor } from './App.jsx';

const ACTIONS = {
  login: 'Вход кассира', shift_open: 'Открытие смены', shift_close: 'Закрытие смены', remove_item: 'Удаление из чека', clear_cart: 'Очистка чека',
  discount: 'Скидка', drawer_open: 'Открытие ящика', refund: 'Возврат', sale_cancel: 'Отмена чека', invoice_cash: 'Квитанция наличными',
  age_ok: 'Проверка возраста', age_denied: 'Отказ по возрасту', collection: 'Инкассация', qty_change: 'Изменение количества',
};

export function Manage({ session, route, onChange }) {
  const sub = route.path.split('/')[2] || 'products';
  const tabs = [['products', 'Товары'], ['staff', 'Персонал'], ['shop', 'Магазин'], ['reports', 'Отчёты'], ['shifts', 'Смены'], ['log', 'Журнал']];
  return (
    <>
      <div className="subnav"><div className="subnav-inner"><nav className="nav">{tabs.map(([k, l]) => <a key={k} href={`#/manage/${k}`} className={sub === k ? 'active' : ''}>{t(l)}</a>)}</nav></div></div>
      {pick([
        ['/manage', () => <Products />],
        ['/manage/products', () => <Products />],
        ['/manage/staff', () => <Staff />],
        ['/manage/shop', () => <ShopSettings session={session} onChange={onChange} />],
        ['/manage/reports', () => <Reports />],
        ['/manage/shifts', () => <Shifts />],
        ['/manage/log', () => <Log />],
        ['*', () => <Empty>{t('Страница не найдена')}</Empty>],
      ], route.path)}
    </>
  );
}

function Products() {
  const { data, loading, reload } = useAsync(() => get('/pos/products?all=1'), []);
  const [edit, setEdit] = useState(null);
  const [stock, setStock] = useState(null);
  if (loading && !data) return <Spinner />;
  return (
    <div className="page">
      <div className="page-head"><h1>{t('Товары')}</h1><button className="btn" onClick={() => setEdit({ unit: 'pcs', age_limit: 0, track_stock: true, active: true })}>+ {t('Товар')}</button></div>
      {!data.products.length ? <Empty>{t('Каталог пуст')}</Empty> : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th /><th>{t('Название')}</th><th>{t('Категория')}</th><th>{t('Цена')}</th><th>{t('Закупка')}</th><th>{t('Остаток')}</th><th /></tr></thead>
            <tbody>
              {data.products.map((p) => (
                <tr key={p.id} style={{ opacity: p.active ? 1 : 0.5 }}>
                  <td style={{ width: 48 }}>{p.photo ? <img src={p.photo} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6 }} /> : null}</td>
                  <td>{p.name} {p.age_limit > 0 && <Badge kind="err">{p.age_limit}+</Badge>}<div className="tiny muted mono">{p.barcode}</div></td>
                  <td>{p.category}</td>
                  <td className="num">{formatMoney(p.price)}{p.unit === 'kg' ? ` / ${t('кг')}` : ''}</td>
                  <td className="num muted">{formatMoney(p.cost)}</td>
                  <td className="num">{p.track_stock ? (p.unit === 'kg' ? `${(p.stock_milli / 1000).toFixed(3)} ${t('кг')}` : `${p.stock_milli / 1000} ${t('шт')}`) : '∞'}</td>
                  <td className="right nowrap">
                    <button className="btn ghost sm" onClick={() => setStock(p)}>{t('Остаток')}</button>
                    <button className="btn secondary sm" onClick={() => setEdit(p)}>{t('Изменить')}</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <ProductModal product={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
      {stock && <StockModal product={stock} onClose={() => setStock(null)} onSaved={() => { setStock(null); reload(); }} />}
    </div>
  );
}

function ProductModal({ product, onClose, onSaved }) {
  const [f, setF] = useState({ ...product, price: product.price ?? null, cost: product.cost ?? null, stock: null });
  const [scan, setScan] = useState(false);
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e });
  return (
    <Modal title={product.id ? t('Товар') : t('Новый товар')} onClose={onClose} wide>
      <Form onSubmit={async () => {
        const body = { name: f.name, category: f.category, barcode: f.barcode, price: f.price, cost: f.cost || 0, unit: f.unit, age_limit: Number(f.age_limit) || 0, photo: f.photo || null, track_stock: !!f.track_stock, active: !!f.active };
        if (product.id) await patch(`/pos/products/${product.id}`, body);
        else await post('/pos/products', { ...body, stock_milli: f.stock ? Math.round(Number(f.stock) * 1000) : 0 });
        onSaved();
      }}>
        <div className="grid grid-2">
          <Input label={t('Название')} required value={f.name || ''} onChange={set('name')} />
          <Input label={t('Категория')} value={f.category || ''} onChange={set('category')} />
        </div>
        <div className="grid grid-3">
          <Select label={t('Единица')} value={f.unit} onChange={set('unit')} options={[{ value: 'pcs', label: t('штучный') }, { value: 'kg', label: t('весовой, за кг') }]} />
          <MoneyInput label={f.unit === 'kg' ? t('Цена за кг') : t('Цена')} value={f.price} onChange={set('price')} />
          <MoneyInput label={t('Закупочная цена')} value={f.cost} onChange={set('cost')} />
        </div>
        <div className="grid grid-3">
          <Field label={t('Штрихкод')}>
            <div className="row nowrap"><input className="input" value={f.barcode || ''} onChange={set('barcode')} /><button type="button" className="btn secondary icon" onClick={() => setScan(true)}>📷</button></div>
          </Field>
          <Select label={t('Возраст')} value={String(f.age_limit || 0)} onChange={set('age_limit')} options={[{ value: '0', label: t('без ограничения') }, { value: '16', label: '16+' }, { value: '18', label: '18+' }, { value: '21', label: '21+' }]} />
          {!product.id && <Input label={f.unit === 'kg' ? t('Начальный остаток, кг') : t('Начальный остаток, шт')} type="number" min={0} step="any" value={f.stock || ''} onChange={set('stock')} />}
        </div>
        <PhotoInput label={t('Фото')} value={f.photo} onChange={set('photo')} maxSize={320} aspect={1} />
        <div className="row">
          <label className="check"><input type="checkbox" checked={!!f.track_stock} onChange={set('track_stock')} /> {t('Учитывать остаток')}</label>
          <label className="check"><input type="checkbox" checked={!!f.active} onChange={set('active')} /> {t('В продаже')}</label>
        </div>
      </Form>
      {scan && <Scanner onClose={() => setScan(false)} onScan={(text) => { setScan(false); setF((x) => ({ ...x, barcode: String(text).trim() })); }} />}
    </Modal>
  );
}

function StockModal({ product, onClose, onSaved }) {
  const [mode, setMode] = useState('add');
  const [qty, setQty] = useState('');
  const unit = product.unit === 'kg' ? t('кг') : t('шт');
  return (
    <Modal title={`${t('Остаток')}: ${product.name}`} onClose={onClose}>
      <Form onSubmit={async () => {
        const q = Math.round(Number(String(qty).replace(',', '.')) * 1000);
        const delta = mode === 'set' ? q - product.stock_milli : mode === 'add' ? q : -q;
        await post('/pos/stock', { product_id: product.id, qty_milli: delta });
        onSaved();
      }}>
        <p>{t('Сейчас')}: <b>{product.stock_milli / 1000} {unit}</b></p>
        <Seg value={mode} onChange={setMode} options={[{ value: 'add', label: t('Приход') }, { value: 'remove', label: t('Списание') }, { value: 'set', label: t('Инвентаризация') }]} />
        <Input label={`${t('Количество')}, ${unit}`} inputMode="decimal" required value={qty} onChange={(e) => setQty(e.target.value)} />
        <p className="small muted">{t('Закупки у оптовой базы и других магазинов появятся в расширении кассы.')}</p>
      </Form>
    </Modal>
  );
}

function Staff() {
  const { data, loading, reload } = useAsync(() => get('/pos/staff'), []);
  const [add, setAdd] = useState(null);
  const [edit, setEdit] = useState(null);
  if (loading && !data) return <Spinner />;
  return (
    <div className="page medium">
      <div className="page-head"><h1>{t('Персонал')}</h1><button className="btn" onClick={() => setAdd({ email: '', pin: '', salary: null })}>+ {t('Кассир')}</button></div>
      <div className="card">
        <div className="list">
          {data.staff.map((s) => (
            <div key={s.id} className="list-item">
              <div className="li-main"><div className="li-title">{s.full_name} <Badge kind={s.role === 'owner' ? 'brand' : ''}>{s.role === 'owner' ? t('владелец') : t('кассир')}</Badge> {!s.active && <Badge kind="err">{t('уволен')}</Badge>}</div><div className="li-sub">{s.email} · {t('зарплата')} {formatMoney(s.salary)} / {t('игр. месяц')}</div></div>
              <button className="btn secondary sm" onClick={() => setEdit({ ...s, pin: '' })}>{t('Изменить')}</button>
            </div>
          ))}
        </div>
      </div>
      <p className="small muted">{t('Зарплата кассира выплачивается каждый игровой месяц с бизнес-счёта магазина.')}</p>
      {add && (
        <Modal title={t('Новый кассир')} onClose={() => setAdd(null)}>
          <Form onSubmit={async () => { await post('/pos/staff', add); setAdd(null); reload(); }}>
            <Input label={t('Email аккаунта ВлодБанка')} type="email" required value={add.email} onChange={(e) => setAdd({ ...add, email: e.target.value })} />
            <Input label={t('PIN кассира — 4 цифры')} inputMode="numeric" maxLength={4} required value={add.pin} onChange={(e) => setAdd({ ...add, pin: e.target.value.replace(/\D/g, '') })} />
            <MoneyInput label={t('Зарплата за игровой месяц')} value={add.salary} onChange={(v) => setAdd({ ...add, salary: v })} />
          </Form>
        </Modal>
      )}
      {edit && (
        <Modal title={edit.full_name} onClose={() => setEdit(null)}>
          <Form onSubmit={async () => {
            await patch(`/pos/staff/${edit.id}`, { salary: edit.salary || 0, ...(edit.pin ? { pin: edit.pin } : {}), active: edit.active });
            setEdit(null);
            reload();
          }}>
            <Input label={t('Новый PIN (пусто — не менять)')} inputMode="numeric" maxLength={4} value={edit.pin} onChange={(e) => setEdit({ ...edit, pin: e.target.value.replace(/\D/g, '') })} />
            <MoneyInput label={t('Зарплата за игровой месяц')} value={edit.salary} onChange={(v) => setEdit({ ...edit, salary: v })} />
            {edit.role !== 'owner' && <label className="check"><input type="checkbox" checked={!!edit.active} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> {t('Работает')}</label>}
          </Form>
        </Modal>
      )}
    </div>
  );
}

function ShopSettings({ session, onChange }) {
  const [f, setF] = useState({ ...session.shop });
  const { data: cats } = useAsync(() => get('/pos/cashback-categories'), []);
  const toast = useToast();
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? e.target.value : e });
  return (
    <div className="page medium">
      <h1>{t('Магазин')}</h1>
      <div className="card">
        <Form onSubmit={async () => {
          const r = await patch('/pos/shop', { name: f.name, type: f.type, color: f.color, address: f.address, receipt_footer: f.receipt_footer, logo: f.logo || null, cashback_category_id: f.cashback_category_id ? Number(f.cashback_category_id) : undefined });
          applyShopColor(r.shop.color);
          toast(t('Сохранено'), 'ok');
          onChange();
        }}>
          <div className="grid grid-2">
            <Input label={t('Название')} value={f.name} onChange={set('name')} />
            <Select label={t('Тип')} value={f.type} onChange={set('type')} options={[{ value: 'shop', label: t('Магазин') }, { value: 'cafe', label: t('Кафе') }]} />
          </div>
          <div className="grid grid-2">
            <Input label={t('Цвет')} type="color" value={f.color} onChange={set('color')} />
            <Input label={t('Адрес')} value={f.address || ''} onChange={set('address')} />
          </div>
          <Input label={t('Подпись внизу чека')} value={f.receipt_footer || ''} onChange={set('receipt_footer')} maxLength={200} />
          {cats && <Select label={t('Категория для кешбэка ВлодБанка')} value={f.cashback_category_id || ''} onChange={set('cashback_category_id')} options={cats.categories.map((c) => ({ value: c.id, label: t(c.name) }))} hint={t('Покупатели, выбравшие эту категорию, получат кешбэк за оплату картой или по QR.')} />}
          <PhotoInput label={t('Логотип')} value={f.logo} onChange={set('logo')} maxSize={256} />
          <div className="small muted">{t('ИНН')}: {f.inn} · {t('ИП')}: {f.ip_number}</div>
        </Form>
      </div>
    </div>
  );
}

function Reports() {
  const [days, setDays] = useState(7);
  const { data, loading } = useAsync(() => get(`/pos/reports?days=${days}`), [days]);
  if (loading && !data) return <Spinner />;
  const maxHour = Math.max(1, ...data.by_hour.map((h) => h.total));
  return (
    <div className="page">
      <div className="page-head"><h1>{t('Отчёты')}</h1><Seg value={days} onChange={setDays} options={[{ value: 1, label: t('Сутки') }, { value: 7, label: t('7 дней') }, { value: 30, label: t('30 дней') }]} /></div>
      <div className="grid grid-4">
        <div className="card stat"><span className="label">{t('Выручка')}</span><span className="value"><Money value={data.revenue} /></span></div>
        <div className="card stat"><span className="label">{t('Прибыль (без НДС и закупки)')}</span><span className="value"><Money value={data.profit} /></span></div>
        <div className="card stat"><span className="label">{t('Чеков')}</span><span className="value">{data.sales}</span></div>
        <div className="card stat"><span className="label">{t('Бизнес-счёт')}</span><span className="value"><Money value={data.business_balance} /></span></div>
      </div>
      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>{t('Популярные товары')}</h2>
          {!data.top.length ? <p className="muted">{t('Продаж пока нет')}</p> : (
            <table className="table"><tbody>{data.top.map((r) => <tr key={r.name}><td>{r.name}</td><td className="num right"><Money value={r.total} /></td></tr>)}</tbody></table>
          )}
        </div>
        <div className="card">
          <h2>{t('По кассирам')}</h2>
          {!data.by_cashier.length ? <p className="muted">{t('Продаж пока нет')}</p> : (
            <table className="table"><thead><tr><th>{t('Кассир')}</th><th>{t('Чеков')}</th><th>{t('Выручка')}</th><th>{t('Чаевые')}</th></tr></thead>
              <tbody>{data.by_cashier.map((r) => <tr key={r.name}><td>{r.name}</td><td>{r.sales}</td><td className="num"><Money value={r.total} /></td><td className="num"><Money value={r.tips} /></td></tr>)}</tbody></table>
          )}
        </div>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h2>{t('Выручка по часам')}</h2>
        <div className="chart-bars">{Array.from({ length: 24 }, (_, h) => { const r = data.by_hour.find((x) => x.hour === h); return <div key={h} className="bar" title={`${h}:00 — ${r ? formatMoney(r.total) : '0'}`} style={{ height: `${((r?.total || 0) / maxHour) * 100}%` }} />; })}</div>
        <div className="chart-labels">{Array.from({ length: 24 }, (_, h) => <span key={h}>{h % 3 === 0 ? h : ''}</span>)}</div>
      </div>
    </div>
  );
}

function Shifts() {
  const { data, loading } = useAsync(() => get('/pos/shifts'), []);
  if (loading && !data) return <Spinner />;
  return (
    <div className="page">
      <h1>{t('Смены')}</h1>
      <div className="card table-wrap">
        <table className="table">
          <thead><tr><th>№</th><th>{t('Кассир')}</th><th>{t('Открыта')}</th><th>{t('Закрыта')}</th><th>{t('Выручка')}</th><th>{t('Расхождение')}</th></tr></thead>
          <tbody>
            {data.shifts.map((s) => (
              <tr key={s.id}>
                <td>{s.number}</td><td>{s.full_name}</td><td>{fmtDate(s.opened_at)}</td><td>{s.closed_at ? fmtDate(s.closed_at) : <Badge kind="brand">{t('открыта')}</Badge>}</td>
                <td className="num">{s.z_report ? <Money value={s.z_report.revenue} /> : '—'}</td>
                <td className="num">{s.z_report?.difference ? <span className="err"><Money value={s.z_report.difference} /></span> : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Log() {
  const { data, loading } = useAsync(() => get('/pos/log'), []);
  if (loading && !data) return <Spinner />;
  return (
    <div className="page">
      <h1>{t('Журнал действий')}</h1>
      <div className="card table-wrap">
        <table className="table">
          <thead><tr><th>{t('Время')}</th><th>{t('Сотрудник')}</th><th>{t('Действие')}</th><th>{t('Детали')}</th></tr></thead>
          <tbody>
            {data.log.map((l) => (
              <tr key={l.id}>
                <td className="nowrap">{fmtDate(l.created_at)}</td>
                <td>{l.full_name || '—'}</td>
                <td>{t(ACTIONS[l.action] || l.action)}</td>
                <td className="small muted">{l.data ? Object.entries(l.data).map(([k, v]) => `${k}: ${typeof v === 'object' ? JSON.stringify(v) : v}`).join(', ') : ''}{l.sale_id ? ` · ${t('чек')} #${l.sale_id}` : ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

