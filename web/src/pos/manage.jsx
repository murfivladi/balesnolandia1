import { useState } from 'react';
import { get, post, patch, del, appUrl } from '../shared/api.js';
import { t, fmtDate } from '../shared/i18n.js';
import { pick } from '../shared/router.js';
import { Spinner, useAsync, Money, MoneyInput, Input, Select, Form, Modal, Empty, Badge, PhotoInput, Scanner, useToast, Field, ActionButton, Subnav, QR, Button, ErrorBox } from '../shared/ui.jsx';
import { formatMoney } from '@bln/shared/money.js';
import { applyShopColor } from './App.jsx';
import { Stock, Purchases } from './stock.jsx';
import { Promos } from './promos.jsx';
import { Debts } from './debts.jsx';
import { TablesAdmin } from './tables-admin.jsx';
import { Reports } from './reports.jsx';

const ACTIONS = {
  login: 'Вход кассира', shift_open: 'Открытие смены', shift_close: 'Закрытие смены', remove_item: 'Удаление из чека', clear_cart: 'Очистка чека',
  discount: 'Ручная скидка', promo: 'Акция или промокод', drawer_open: 'Открытие ящика', refund: 'Возврат', sale_cancel: 'Отмена чека', invoice_cash: 'Квитанция наличными',
  age_ok: 'Проверка возраста', age_denied: 'Отказ по возрасту', collection: 'Инкассация', qty_change: 'Изменение количества',
  product_delete: 'Удаление товара', product_restore: 'Восстановление товара',
  debt: 'Продажа в долг', debt_cash: 'Погашение долга наличными',
  table_open: 'Открыт счёт стола', table_item: 'Добавлены блюда в счёт', table_checkout: 'Счёт стола передан к оплате', table_cancel: 'Счёт стола отменён',
  kitchen_send: 'Отправлено на кухню', kitchen_status: 'Статус кухни',
  purchase: 'Закупка на оптовой базе', purchase_order: 'Заказ у магазина', purchase_sold: 'Продажа другому магазину',
};

export function Manage({ session, route, onChange }) {
  const sub = route.path.split('/')[2] || 'products';
  const tabs = [
    ['products', 'Товары'], ['stock', 'Склад'], ['purchases', 'Закупки'], ['promos', 'Акции'], ['debts', 'Долги'],
    ...(session.shop.type === 'cafe' ? [['tables', 'Столы']] : []),
    ['reports', 'Отчёты'], ['staff', 'Персонал'], ['shop', 'Магазин'], ['shifts', 'Смены'], ['log', 'Журнал'],
  ];
  return (
    <>
      <Subnav items={tabs.map(([k, l]) => [`#/manage/${k}`, t(l), sub === k])} />
      {pick([
        ['/manage', () => <Products session={session} />],
        ['/manage/products', () => <Products session={session} />],
        ['/manage/stock', () => <Stock />],
        ['/manage/purchases', () => <Purchases />],
        ['/manage/promos', () => <Promos session={session} onChange={onChange} />],
        ['/manage/debts', () => <Debts session={session} />],
        ['/manage/tables', () => <TablesAdmin session={session} />],
        ['/manage/reports', () => <Reports />],
        ['/manage/staff', () => <Staff />],
        ['/manage/shop', () => <ShopSettings session={session} onChange={onChange} />],
        ['/manage/shifts', () => <Shifts />],
        ['/manage/log', () => <Log />],
        ['*', () => <Empty>{t('Страница не найдена')}</Empty>],
      ], route.path)}
    </>
  );
}

function Products({ session }) {
  const [showDeleted, setShowDeleted] = useState(false);
  const { data, loading, reload } = useAsync(() => get(`/pos/products?all=1${showDeleted ? '&deleted=1' : ''}`), [showDeleted]);
  const [edit, setEdit] = useState(null);
  if (loading && !data) return <Spinner />;
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Товары')}</h1>
        <div className="row nowrap">
          <button className="btn ghost sm" onClick={() => setShowDeleted(!showDeleted)}>{t(showDeleted ? 'Скрыть удалённые' : 'Показать удалённые')}</button>
          <button className="btn" onClick={() => setEdit({ unit: 'pcs', age_limit: 0, track_stock: true, active: true })}>+ {t('Товар')}</button>
        </div>
      </div>
      {!data.products.length ? <Empty>{t(showDeleted ? 'Удалённых товаров нет' : 'Каталог пуст')}</Empty> : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th /><th>{t('Название')}</th><th>{t('Цена')}</th><th>{t('Закупка')}</th><th>{t('Оптом')}</th><th>{t('Остаток')}</th><th>{t('Модификации')}</th><th /></tr></thead>
            <tbody>
              {data.products.map((p) => (
                <tr key={p.id} style={{ opacity: p.deleted_at ? 0.7 : p.active ? 1 : 0.5 }}>
                  <td style={{ width: 48 }}>{p.photo ? <img src={p.photo} alt="" style={{ width: 40, height: 40, objectFit: 'cover', borderRadius: 6 }} /> : null}</td>
                  <td>
                    {p.name} {p.age_limit > 0 && <Badge kind="err">{p.age_limit}+</Badge>} {p.deleted_at && <Badge kind="err">{t('Удалён')}</Badge>} {p.to_kitchen && <Badge kind="brand">{t('кухня')}</Badge>}
                    <div className="tiny muted mono">{p.barcode}</div>
                    <div className="tiny muted">{p.category}</div>
                  </td>
                  <td className="num">{formatMoney(p.price)}{p.unit === 'kg' ? ` / ${t('кг')}` : ''}</td>
                  <td className="num muted">{formatMoney(p.cost)}</td>
                  <td className="num muted">{p.b2b_price !== null ? formatMoney(p.b2b_price) : '—'}</td>
                  <td className="num">{p.track_stock ? (p.unit === 'kg' ? `${(p.stock_milli / 1000).toFixed(3)} ${t('кг')}` : `${p.stock_milli / 1000} ${t('шт')}`) : '∞'}</td>
                  <td className="small muted">{(p.variants?.length || 0) + (p.modifiers?.length || 0) || '—'}</td>
                  <td className="right nowrap">
                    {showDeleted ? (
                      <ActionButton size="sm" action={async () => { await post(`/pos/products/${p.id}/restore`); reload(); }} okMessage={t('Товар восстановлен')}>{t('Восстановить')}</ActionButton>
                    ) : (
                      <>
                        <button className="btn ghost sm" onClick={() => setEdit(p)}>{t('Изменить')}</button>
                        <ActionButton
                          kind="danger"
                          size="sm"
                          confirm={t('Удалить товар «{name}»? Он исчезнет из кассы, но останется в истории продаж.', { name: p.name })}
                          action={async () => { await del(`/pos/products/${p.id}`); reload(); }}
                          okMessage={t('Товар удалён')}
                        >{t('Удалить')}</ActionButton>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">{t('Удалённые товары не видны кассирам и не попадают в новые чеки; историю продаж и возвраты можно посмотреть в отчётах.')}</p>
      {edit && <ProductModal product={edit} kitchen={session.shop.kitchen_enabled} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

function ProductModal({ product, kitchen, onClose, onSaved }) {
  const [f, setF] = useState({ ...product, price: product.price ?? null, cost: product.cost ?? null, b2b_price: product.b2b_price ?? null, stock: null });
  const [variants, setVariants] = useState((product.variants || []).map((v) => ({ ...v })));
  const [modifiers, setModifiers] = useState((product.modifiers || []).map((m) => ({ ...m })));
  const [scan, setScan] = useState(false);
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e });
  const toast = useToast();

  async function saveVariants(productId) {
    for (const v of variants) {
      if (!v.name?.trim()) continue;
      if (!v.id) await post(`/pos/products/${productId}/variants`, { name: v.name, price_delta: Number(v.price_delta) || 0 });
      else if (v._dirty) await patch(`/pos/variants/${v.id}`, { name: v.name, price_delta: Number(v.price_delta) || 0, active: v.active !== false });
      else if (v.active === false && v._wasActive !== false) await patch(`/pos/variants/${v.id}`, { active: false });
    }
    for (const m of modifiers) {
      if (!m.name?.trim()) continue;
      if (!m.id) await post(`/pos/products/${productId}/modifiers`, { name: m.name, price: Number(m.price) || 0 });
      else if (m._dirty) await patch(`/pos/modifiers/${m.id}`, { name: m.name, price: Number(m.price) || 0, active: m.active !== false });
      else if (m.active === false && m._wasActive !== false) await patch(`/pos/modifiers/${m.id}`, { active: false });
    }
  }

  return (
    <Modal title={product.id ? t('Товар') : t('Новый товар')} onClose={onClose} wide>
      <Form onSubmit={async () => {
        setError(null);
        try {
          const body = {
            name: f.name, category: f.category, barcode: f.barcode, price: f.price, cost: f.cost || 0,
            b2b_price: f.b2b_price || null, unit: f.unit, age_limit: Number(f.age_limit) || 0,
            photo: f.photo || null, track_stock: !!f.track_stock, to_kitchen: !!f.to_kitchen, active: !!f.active,
          };
          let id = product.id;
          if (id) await patch(`/pos/products/${id}`, body);
          else id = (await post('/pos/products', { ...body, stock_milli: f.stock ? Math.round(Number(String(f.stock).replace(',', '.')) * 1000) : 0 })).product.id;
          await saveVariants(id);
          onSaved();
        } catch (e) { setError(e); }
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
          <MoneyInput label={t('Оптовая цена для магазинов')} value={f.b2b_price} onChange={set('b2b_price')} hint={t('Пусто — не продаётся оптом')} />
          <Field label={t('Штрихкод')}>
            <div className="row nowrap"><input className="input" value={f.barcode || ''} onChange={set('barcode')} /><button type="button" className="btn secondary icon" onClick={() => setScan(true)}>📷</button></div>
          </Field>
          <Select label={t('Возраст')} value={String(f.age_limit || 0)} onChange={set('age_limit')} options={[{ value: '0', label: t('без ограничения') }, { value: '16', label: '16+' }, { value: '18', label: '18+' }, { value: '21', label: '21+' }]} />
        </div>
        <PhotoInput label={t('Фото')} value={f.photo} onChange={set('photo')} maxSize={320} aspect={1} />
        {!product.id && <Input label={f.unit === 'kg' ? t('Начальный остаток, кг') : t('Начальный остаток, шт')} type="number" min={0} step="any" value={f.stock || ''} onChange={set('stock')} />}
        <div className="row">
          <label className="check"><input type="checkbox" checked={!!f.track_stock} onChange={set('track_stock')} /> {t('Учитывать остаток')}</label>
          <label className="check"><input type="checkbox" checked={!!f.active} onChange={set('active')} /> {t('В продаже')}</label>
          {kitchen && <label className="check"><input type="checkbox" checked={!!f.to_kitchen} onChange={set('to_kitchen')} /> {t('Готовится на кухне')}</label>}
        </div>
        <hr className="sep" />
        <VariantEditor title={t('Варианты')} hint={t('Например: размер, молоко, сироп. Надбавка прибавляется к цене товара.')} rows={variants} setRows={setVariants} priceKey="price_delta" />
        <ModifierEditor rows={modifiers} setRows={setModifiers} />
        <ErrorBox error={error} />
      </Form>
      {scan && <Scanner onClose={() => setScan(false)} onScan={(text) => { setScan(false); setF((x) => ({ ...x, barcode: String(text).trim() })); toast(t('Штрихкод считан'), 'ok'); }} />}
    </Modal>
  );
}

function VariantEditor({ title, hint, rows, setRows, priceKey }) {
  const update = (i, patchRow) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patchRow } : r)));
  return (
    <div className="stack">
      <div className="card-head"><h3 style={{ margin: 0 }}>{title}</h3><span className="small muted">{hint}</span></div>
      {rows.map((v, i) => (
        <div key={v.id || `n${i}`} className="row nowrap">
          <input className="input" placeholder={t('Название')} value={v.name || ''} onChange={(e) => update(i, { name: e.target.value, _dirty: true })} />
          <input className="input" style={{ width: 120 }} type="number" step="1" placeholder="0" value={v[priceKey] ?? 0} onChange={(e) => update(i, { [priceKey]: e.target.value, _dirty: true })} title={t('Надбавка в влодинках')} />
          <span className="small muted nowrap">+{formatMoney(Number(v[priceKey]) || 0)}</span>
          <label className="check" title={t('Включён')}><input type="checkbox" checked={v.active !== false} onChange={(e) => update(i, { active: e.target.checked, _dirty: true })} /></label>
          <button type="button" className="btn ghost sm" title={t('Убрать')} onClick={() => setRows((rs) => (v.id ? rs.map((r, j) => (j === i ? { ...r, active: false, _dirty: true } : r)) : rs.filter((_, j) => j !== i)))}>✕</button>
        </div>
      ))}
      <Button type="button" kind="secondary" size="sm" onClick={() => setRows((rs) => [...rs, { name: '', price_delta: 0, price: 0, active: true, _dirty: true }])}>+ {t('Добавить')}</Button>
    </div>
  );
}

function ModifierEditor({ rows, setRows }) {
  const update = (i, patchRow) => setRows((rs) => rs.map((r, j) => (j === i ? { ...r, ...patchRow } : r)));
  return (
    <div className="stack">
      <div className="card-head"><h3 style={{ margin: 0 }}>{t('Добавки')}</h3><span className="small muted">{t('Например: сыр, бекон, без сахара.')}</span></div>
      {rows.map((m, i) => (
        <div key={m.id || `n${i}`} className="row nowrap">
          <input className="input" placeholder={t('Название')} value={m.name || ''} onChange={(e) => update(i, { name: e.target.value, _dirty: true })} />
          <input className="input" style={{ width: 120 }} type="number" step="1" placeholder="0" value={m.price ?? 0} onChange={(e) => update(i, { price: e.target.value, _dirty: true })} title={t('Цена в влодинках')} />
          <span className="small muted nowrap">+{formatMoney(Number(m.price) || 0)}</span>
          <label className="check" title={t('Включена')}><input type="checkbox" checked={m.active !== false} onChange={(e) => update(i, { active: e.target.checked, _dirty: true })} /></label>
          <button type="button" className="btn ghost sm" title={t('Убрать')} onClick={() => setRows((rs) => (m.id ? rs.map((r, j) => (j === i ? { ...r, active: false, _dirty: true } : r)) : rs.filter((_, j) => j !== i)))}>✕</button>
        </div>
      ))}
      <Button type="button" kind="secondary" size="sm" onClick={() => setRows((rs) => [...rs, { name: '', price: 0, active: true, _dirty: true }])}>+ {t('Добавить')}</Button>
    </div>
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
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e });
  const queueUrl = appUrl('pos', `/queue?shop=${session.shop.id}`);
  return (
    <div className="page medium">
      <h1>{t('Магазин')}</h1>
      <div className="card">
        <Form onSubmit={async () => {
          const r = await patch('/pos/shop', {
            name: f.name, type: f.type, color: f.color, address: f.address, receipt_footer: f.receipt_footer, logo: f.logo || null,
            cashback_category_id: f.cashback_category_id ? Number(f.cashback_category_id) : undefined,
            kitchen_enabled: !!f.kitchen_enabled,
          });
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
          <label className="check"><input type="checkbox" checked={!!f.kitchen_enabled} onChange={set('kitchen_enabled')} /> {t('Кухня и очередь: позиции с отметкой «готовится на кухне» уходят на экран кухни')}</label>
          <div className="small muted">{t('ИНН')}: {f.inn} · {t('ИП')}: {f.ip_number}</div>
        </Form>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h2>{t('Экраны')}</h2>
        <div className="stack">
          <div className="row"><a className="btn secondary" href="#/tables">{t('Столы')}</a><a className="btn secondary" href="#/kitchen">{t('Кухня')}</a><a className="btn secondary" href="#/kiosk">{t('Киоск')}</a></div>
          <div className="row" style={{ alignItems: 'flex-start', gap: 16 }}>
            <div style={{ background: '#fff', padding: 8, borderRadius: 10 }}><QR value={queueUrl} size={140} /></div>
            <div className="stack-sm">
              <b>{t('Табло очереди для зала')}</b>
              <span className="small muted">{t('Открывается без входа на любом телевизоре или планшете.')}</span>
              <span className="mono tiny" style={{ wordBreak: 'break-all' }}>{queueUrl}</span>
              <a className="btn secondary sm" href={`#/queue?shop=${session.shop.id}`}>{t('Открыть')}</a>
            </div>
          </div>
        </div>
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
