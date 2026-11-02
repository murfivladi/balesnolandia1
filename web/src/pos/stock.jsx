// Склад магазина и закупки: остатки, движения, оптовая база БФ с инфляцией,
// заказы у других магазинов и входящие заказы.
import { useState } from 'react';
import { get, post, newIdemKey } from '../shared/api.js';
import { t, fmtDate } from '../shared/i18n.js';
import { Spinner, useAsync, Money, Input, Modal, Empty, Button, ActionButton, Badge, ErrorBox, useToast, Seg } from '../shared/ui.jsx';
import { formatMoney } from '@bln/shared/money.js';
import { sound } from '../shared/sounds.js';
import { qtyLabel, QTY } from './lib.js';

const MOVE_REASONS = {
  manual: 'Ручная корректировка', sale: 'Продажа', refund: 'Возврат', purchase: 'Закупка', writeoff: 'Списание', supply: 'Передача в магазин',
};
const STATUS = { pending: 'Ждёт решения', done: 'Выполнен', rejected: 'Отклонён', cancelled: 'Отменён' };

const milli = (unit, text) => {
  const s = String(text ?? '').replace(',', '.');
  const n = Number(s);
  if (!Number.isFinite(n) || n <= 0) return 0;
  // Штучные товары — только целые; весовые — граммы.
  return unit === 'kg' ? Math.round(n * 1000) : Math.round(n) * 1000;
};

export function Stock() {
  const { data: summary, reload: reloadSummary } = useAsync(() => get('/pos/stock/summary'), []);
  const { data, loading, reload } = useAsync(() => get('/pos/products?all=1'), []);
  const { data: moves, reload: reloadMoves } = useAsync(() => get('/pos/stock/moves'), []);
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState('all');
  const [stock, setStock] = useState(null);
  const [showMoves, setShowMoves] = useState(false);

  if (loading && !data) return <Spinner />;
  const products = data.products.filter((p) => {
    if (search && !p.name.toLowerCase().includes(search.toLowerCase()) && p.barcode !== search) return false;
    if (filter === 'low') return p.track_stock && p.stock_milli > 0 && p.stock_milli <= 5000;
    if (filter === 'zero') return p.track_stock && p.stock_milli <= 0;
    return true;
  });
  const low = data.products.filter((p) => p.track_stock && p.stock_milli <= 5000 && p.active);

  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Склад')}</h1>
        <a className="btn secondary sm" href="#/manage/purchases">{t('Закупить')}</a>
      </div>
      <div className="grid grid-4">
        <div className="card stat"><span className="label">{t('Товар на складе')}</span><span className="value"><Money value={summary?.stock_value || 0} /></span></div>
        <div className="card stat"><span className="label">{t('Позиций')}</span><span className="value">{summary?.positions || 0}</span></div>
        <div className="card stat"><span className="label">{t('Мало остатка')}</span><span className="value">{summary?.low || 0}</span></div>
        <div className="card stat"><span className="label">{t('Нет в наличии')}</span><span className="value">{summary?.zero || 0}</span></div>
      </div>
      {low.length > 0 && (
        <div className="form-warn" style={{ marginTop: 12 }}>
          {t('Пора закупить')}: {low.slice(0, 6).map((p) => p.name).join(', ')}{low.length > 6 ? ` +${low.length - 6}` : ''} — <a href="#/manage/purchases">{t('на оптовую базу')}</a>
        </div>
      )}
      <div className="card" style={{ marginTop: 16 }}>
        <div className="row" style={{ marginBottom: 10 }}>
          <input className="input" style={{ maxWidth: 280 }} placeholder={t('Поиск по названию или штрихкоду')} value={search} onChange={(e) => setSearch(e.target.value)} />
          <Seg value={filter} onChange={setFilter} options={[{ value: 'all', label: t('Все') }, { value: 'low', label: t('Мало') }, { value: 'zero', label: t('Нет') }]} />
          <Button kind="ghost" size="sm" style={{ marginLeft: 'auto' }} onClick={() => setShowMoves(!showMoves)}>{showMoves ? t('Скрыть движения') : t('Движения склада')}</Button>
        </div>
        {!products.length ? <Empty>{t('Товаров нет')}</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th /><th>{t('Товар')}</th><th>{t('Остаток')}</th><th>{t('Закупка')}</th><th>{t('Цена')}</th><th>{t('Наценка')}</th><th>{t('Стоимость запаса')}</th><th /></tr></thead>
              <tbody>
                {products.map((p) => {
                  const margin = p.cost > 0 ? Math.round(((p.price - p.cost) / p.cost) * 100) : null;
                  const stockPct = p.track_stock ? Math.max(0, Math.min(100, (p.stock_milli / 10000) * 100)) : 100;
                  const level = !p.track_stock ? '' : p.stock_milli <= 0 ? 'zero' : p.stock_milli <= 5000 ? 'low' : '';
                  return (
                    <tr key={p.id} style={{ opacity: p.active ? 1 : .55 }}>
                      <td style={{ width: 44 }}>{p.photo ? <img src={p.photo} alt="" style={{ width: 36, height: 36, objectFit: 'cover', borderRadius: 6 }} /> : null}</td>
                      <td>
                        {p.name} {!p.active && <Badge kind="err">{t('не в продаже')}</Badge>}
                        <div className="tiny muted">{p.category}{p.barcode ? ` · ${p.barcode}` : ''}</div>
                      </td>
                      <td>
                        {p.track_stock ? (
                          <div className="stock-row">
                            <span className="num">{qtyLabel(p.unit, p.stock_milli)}</span>
                            <span className={`stock-bar ${level}`}><i style={{ width: `${stockPct}%` }} /></span>
                          </div>
                        ) : <span className="muted">∞</span>}
                      </td>
                      <td className="num">{formatMoney(p.cost)}</td>
                      <td className="num">{formatMoney(p.price)}{p.unit === 'kg' ? ` / ${t('кг')}` : ''}</td>
                      <td className="num">{margin === null ? '—' : `${margin}%`}</td>
                      <td className="num">{p.track_stock ? formatMoney(Math.round(p.cost * Math.max(0, p.stock_milli) / 1000)) : '—'}</td>
                      <td className="right nowrap"><Button kind="secondary" size="sm" onClick={() => setStock(p)}>{t('Остаток')}</Button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted">{t('Остаток уменьшается при продаже и возвращается при возврате. Закупки на оптовой базе сразу приходуются на склад по средневзвешенной цене.')}</p>
      </div>

      {showMoves && (
        <div className="card" style={{ marginTop: 16 }}>
          <div className="card-head"><h2>{t('Движения склада')}</h2><Button kind="ghost" size="sm" onClick={reloadMoves}>{t('Обновить')}</Button></div>
          {!moves?.moves.length ? <Empty>{t('Движений пока нет')}</Empty> : (
            <div className="table-wrap">
              <table className="table">
                <thead><tr><th>{t('Время')}</th><th>{t('Товар')}</th><th>{t('Количество')}</th><th>{t('Причина')}</th></tr></thead>
                <tbody>{moves.moves.map((m) => (
                  <tr key={m.id}>
                    <td className="small nowrap">{fmtDate(m.created_at)}</td>
                    <td>{m.name}</td>
                    <td className={`num ${m.qty_milli > 0 ? 'amount-pos' : 'amount-neg'}`}>{m.qty_milli > 0 ? '+' : ''}{qtyLabel(m.unit, m.qty_milli)}</td>
                    <td className="small">{t(MOVE_REASONS[m.reason] || m.reason)}</td>
                  </tr>
                ))}</tbody>
              </table>
            </div>
          )}
        </div>
      )}
      {stock && <StockModal product={stock} onClose={() => setStock(null)} onSaved={() => { setStock(null); reload(); reloadMoves(); reloadSummary(); }} />}
    </div>
  );
}

function StockModal({ product, onClose, onSaved }) {
  const [mode, setMode] = useState('add');
  const [qty, setQty] = useState('');
  const unit = product.unit === 'kg' ? t('кг') : t('шт');
  const q = milli(product.unit, qty);
  const delta = mode === 'set' ? q - product.stock_milli : mode === 'add' ? q : -Math.min(q, Math.max(0, product.stock_milli));
  return (
    <Modal title={`${t('Остаток')}: ${product.name}`} onClose={onClose}>
      <form className="stack" onSubmit={async (e) => {
        e.preventDefault();
        await post('/pos/stock', { product_id: product.id, qty_milli: delta });
        onSaved();
      }}>
        <p>{t('Сейчас')}: <b>{qtyLabel(product.unit, product.stock_milli)}</b></p>
        <Seg value={mode} onChange={setMode} options={[{ value: 'add', label: t('Приход') }, { value: 'remove', label: t('Списание') }, { value: 'set', label: t('Инвентаризация') }]} />
        <Input label={`${t('Количество')}, ${unit}`} inputMode="decimal" required value={qty} onChange={(e) => setQty(e.target.value)} />
        <p className="small muted">{mode === 'set' ? t('После инвентаризации остаток станет равен введённому числу.') : t('Каждое движение попадает в журнал склада.')}</p>
        <Button type="submit" disabled={mode === 'set' ? delta === 0 : !q}>{t('Сохранить')}</Button>
      </form>
    </Modal>
  );
}

// ——— Закупки ———

export function Purchases() {
  const [tab, setTab] = useState('wholesale');
  const { data: summary, reload: reloadSummary } = useAsync(() => get('/pos/stock/summary'), []);
  const [refresh, setRefresh] = useState(0);
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Закупки')}</h1>
        <Badge kind="brand">{t('Бизнес-счёт')}: <Money value={summary?.business_balance || 0} /></Badge>
      </div>
      <div className="row" style={{ marginBottom: 12 }}>
        <Seg value={tab} onChange={setTab} options={[
          { value: 'wholesale', label: t('Оптовая база') },
          { value: 'market', label: t('У магазинов') },
          { value: 'orders', label: t('Входящие заказы') },
          { value: 'history', label: t('История') },
        ]} />
        {summary?.pending_purchases > 0 && <Badge kind="warn">{t('Заказов в работе')}: {summary.pending_purchases}</Badge>}
      </div>
      {tab === 'wholesale' && <Wholesale balance={summary?.business_balance || 0} onDone={() => { reloadSummary(); setRefresh((x) => x + 1); }} />}
      {tab === 'market' && <Market onDone={() => { reloadSummary(); setRefresh((x) => x + 1); }} />}
      {tab === 'orders' && <Orders onDone={() => { reloadSummary(); setRefresh((x) => x + 1); }} />}
      {tab === 'history' && <History refresh={refresh} onDone={() => reloadSummary()} />}
    </div>
  );
}

function Wholesale({ balance, onDone }) {
  const { data, loading } = useAsync(() => get('/pos/wholesale'), []);
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('');
  const [cart, setCart] = useState([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [idem] = useState(newIdemKey);
  const toast = useToast();

  if (loading && !data) return <Spinner />;
  const categories = [...new Set(data.items.map((i) => i.category).filter(Boolean))];
  const shown = data.items.filter((i) => (!cat || i.category === cat) && (!search || i.name.toLowerCase().includes(search.toLowerCase()) || i.barcode === search));
  const total = cart.reduce((s, l) => s + l.total, 0);
  const enough = total <= balance;

  function add(item) {
    setCart((c) => {
      const i = c.findIndex((x) => x.item_id === item.id);
      if (i >= 0) {
        const qty = c[i].qty_milli + (item.unit === 'kg' ? 1000 : QTY);
        return c.map((x, j) => (j === i ? { ...x, qty_milli: qty, total: Math.round(x.price * qty / QTY) } : x));
      }
      const qty = item.unit === 'kg' ? 1000 : QTY;
      return [...c, { item_id: item.id, name: item.name, unit: item.unit, price: item.price, qty_milli: qty, total: Math.round(item.price * qty / QTY) }];
    });
    sound.click();
  }

  function setQty(item, text) {
    const qty = milli(item.unit, text);
    setCart((c) => c.map((x) => (x.item_id === item.item_id ? { ...x, qty_milli: qty, total: Math.round(x.price * qty / QTY) } : x)));
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const r = await post('/pos/purchases/wholesale', { items: cart.map((l) => ({ item_id: l.item_id, qty_milli: l.qty_milli })) }, { idem });
      toast(t('Закупка оформлена: {sum}', { sum: formatMoney(r.purchase.total) }), 'ok');
      setCart([]);
      onDone();
    } catch (e) { setError(e); } finally { setBusy(false); }
  }

  return (
    <div className="grid grid-2">
      <div className="card">
        <div className="card-head"><h2>{t('Оптовая база БФ')}</h2><Badge kind="brand">{t('индекс цен')}: ×{Number(data.index).toFixed(2)}</Badge></div>
        <div className="row" style={{ marginBottom: 10 }}>
          <input className="input" placeholder={t('Поиск товара')} value={search} onChange={(e) => setSearch(e.target.value)} />
        </div>
        {categories.length > 0 && (
          <div className="cats" style={{ marginBottom: 10 }}>
            <button className={!cat ? 'active' : ''} onClick={() => setCat('')}>{t('Все')}</button>
            {categories.map((c) => <button key={c} className={cat === c ? 'active' : ''} onClick={() => setCat(c)}>{c}</button>)}
          </div>
        )}
        {!shown.length ? <Empty>{t('Товаров нет')}</Empty> : (
          <div className="list">
            {shown.map((i) => (
              <div key={i.id} className="list-item">
                <div className="li-main">
                  <div className="li-title">{i.name} {i.age_limit > 0 && <Badge kind="err">{i.age_limit}+</Badge>}</div>
                  <div className="li-sub">{i.category} · {t('за')} {i.unit === 'kg' ? t('кг') : t('шт')} · {t('базовая цена')} {formatMoney(i.base_price)}</div>
                </div>
                <div className="right">
                  <b className="num">{formatMoney(i.price)}</b>
                  <div><Button size="sm" kind="secondary" onClick={() => add(i)}>+ {t('В закупку')}</Button></div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="card">
        <div className="card-head"><h2>{t('Закупка')}</h2><Badge>{cart.length}</Badge></div>
        {!cart.length ? <Empty>{t('Добавьте товары из оптовой базы')}</Empty> : (
          <div className="stack">
            {cart.map((l) => (
              <div key={l.item_id} className="purchase-line">
                <div>{l.name}<div className="tiny muted">{formatMoney(l.price)} / {l.unit === 'kg' ? t('кг') : t('шт')}</div></div>
                <input className="input" style={{ width: 92 }} inputMode="decimal" value={l.unit === 'kg' ? (l.qty_milli / 1000) : l.qty_milli / 1000} onChange={(e) => setQty(l, e.target.value)} />
                <div className="right"><b className="num">{formatMoney(l.total)}</b><div><button className="btn ghost sm" onClick={() => setCart((c) => c.filter((x) => x.item_id !== l.item_id))}>✕</button></div></div>
              </div>
            ))}
            <hr className="sep" />
            <div className="totals-box">
              <div className="trow"><span>{t('Товаров')}</span><span>{t('позиций')}: {cart.length}</span></div>
              <div className="trow big"><span>{t('К оплате')}</span><span>{formatMoney(total)}</span></div>
            </div>
            {!enough && <div className="form-warn">{t('На бизнес-счёте не хватает денег: пополните счёт или сократите закупку.')}</div>}
            <ErrorBox error={error} />
            <Button size="lg" busy={busy} disabled={!cart.length || !enough} onClick={submit}>{t('Оплатить с бизнес-счёта')} {formatMoney(total)}</Button>
            <p className="small muted">{t('Оплата списывается с бизнес-счёта, товар сразу приходит на склад. Цены уже с учётом инфляции.')}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Market({ onDone }) {
  const [q, setQ] = useState('');
  const { data, loading, reload } = useAsync(() => get(`/pos/market?q=${encodeURIComponent(q)}`), [q]);
  const [seller, setSeller] = useState(null);
  const [cart, setCart] = useState([]);
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const toast = useToast();

  function add(offer) {
    if (seller && seller.id !== offer.shop_id && !window.confirm(t('Заказ оформляется одному магазину. Начать заказ у «{name}»?', { name: offer.shop_name }))) return;
    if (!seller || seller.id !== offer.shop_id) {
      setSeller({ id: offer.shop_id, name: offer.shop_name });
      setCart([{ product_id: offer.id, name: offer.name, unit: offer.unit, price: offer.b2b_price, qty_milli: offer.unit === 'kg' ? 1000 : QTY }]);
      return;
    }
    setCart((c) => {
      const i = c.findIndex((x) => x.product_id === offer.id);
      if (i >= 0) return c.map((x, j) => (j === i ? { ...x, qty_milli: x.qty_milli + (offer.unit === 'kg' ? 1000 : QTY) } : x));
      return [...c, { product_id: offer.id, name: offer.name, unit: offer.unit, price: offer.b2b_price, qty_milli: offer.unit === 'kg' ? 1000 : QTY }];
    });
  }

  const total = cart.reduce((s, l) => s + Math.round((l.price * l.qty_milli) / QTY), 0);
  async function submit() {
    setError(null);
    try {
      await post('/pos/purchases/shop', { seller_shop_id: seller.id, note: note.trim() || undefined, items: cart.map((l) => ({ product_id: l.product_id, qty_milli: l.qty_milli })) });
      toast(t('Заказ отправлен магазину «{name}»', { name: seller.name }), 'ok');
      setCart([]);
      setSeller(null);
      setNote('');
      reload();
      onDone();
    } catch (e) { setError(e); }
  }

  return (
    <div className="grid grid-2">
      <div className="card">
        <div className="card-head"><h2>{t('Оптовые предложения магазинов')}</h2></div>
        <input className="input" placeholder={t('Поиск товара или магазина')} value={q} onChange={(e) => setQ(e.target.value)} />
        {loading && !data ? <Spinner /> : !data.offers.length ? <Empty>{t('Предложений пока нет')}</Empty> : (
          <div className="list" style={{ marginTop: 10 }}>
            {data.offers.map((o) => (
              <div key={`${o.shop_id}-${o.id}`} className="list-item">
                <div className="li-main">
                  <div className="li-title">{o.name}</div>
                  <div className="li-sub"><span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: o.color, marginRight: 5 }} />{o.shop_name} · {o.category} · {o.unit === 'kg' ? t('за кг') : t('за шт')}{o.track_stock ? ` · ${t('остаток')}: ${qtyLabel(o.unit, o.stock_milli)}` : ''}</div>
                </div>
                <div className="right"><b className="num">{formatMoney(o.b2b_price)}</b><div><Button size="sm" kind="secondary" onClick={() => add(o)}>+ {t('В заказ')}</Button></div></div>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="card">
        <div className="card-head"><h2>{t('Заказ магазину')}</h2>{seller && <Badge kind="brand">{seller.name}</Badge>}</div>
        {!cart.length ? <Empty>{t('Выберите товары у магазина-продавца')}</Empty> : (
          <div className="stack">
            {cart.map((l) => (
              <div key={l.product_id} className="purchase-line">
                <div>{l.name}</div>
                <input className="input" style={{ width: 92 }} inputMode="decimal" value={l.unit === 'kg' ? l.qty_milli / 1000 : l.qty_milli / 1000} onChange={(e) => {
                  const qty = milli(l.unit, e.target.value);
                  setCart((c) => c.map((x) => (x.product_id === l.product_id ? { ...x, qty_milli: qty } : x)));
                }} />
                <div className="right"><b className="num">{formatMoney(Math.round(l.price * l.qty_milli / QTY))}</b><div><button className="btn ghost sm" onClick={() => setCart((c) => c.filter((x) => x.product_id !== l.product_id))}>✕</button></div></div>
              </div>
            ))}
            <div className="totals-box"><div className="trow big"><span>{t('Сумма заказа')}</span><span>{formatMoney(total)}</span></div></div>
            <Input label={t('Комментарий продавцу')} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
            <ErrorBox error={error} />
            <Button size="lg" disabled={!cart.length} onClick={submit}>{t('Отправить заказ')}</Button>
            <p className="small muted">{t('Продавец подтвердит заказ, спишет товар со своего склада и получит деньги на бизнес-счёт.')}</p>
          </div>
        )}
      </div>
    </div>
  );
}

function Orders({ onDone }) {
  const { data, loading, reload } = useAsync(() => get('/pos/purchases'), []);
  const toast = useToast();
  if (loading && !data) return <Spinner />;
  const pending = data.orders.filter((o) => o.status === 'pending');
  const other = data.orders.filter((o) => o.status !== 'pending');
  async function decide(order, action) {
    await post(`/pos/orders/${order.id}/${action}`);
    toast(action === 'accept' ? t('Заказ принят') : t('Заказ отклонён'), 'ok');
    reload();
    onDone();
  }
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h2>{t('Ждут подтверждения')}</h2><Badge kind="warn">{pending.length}</Badge></div>
        {!pending.length ? <Empty>{t('Новых заказов нет')}</Empty> : pending.map((o) => (
          <div key={o.id} className="card" style={{ boxShadow: 'none', background: 'var(--surface-2)' }}>
            <div className="card-head">
              <h3 style={{ margin: 0 }}>{t('Заказ от «{name}»', { name: o.shop_name })}</h3>
              <Badge kind="warn">{t('Ждёт решения')}</Badge>
              <b style={{ marginLeft: 'auto' }}><Money value={o.total} /></b>
            </div>
            <div className="small muted">{fmtDate(o.created_at)}{o.note ? ` · ${o.note}` : ''}</div>
            <div className="stack-sm" style={{ margin: '8px 0' }}>
              {o.items.map((i, k) => <div key={k} className="row" style={{ justifyContent: 'space-between' }}><span>{i.name} · {qtyLabel(i.unit, i.qty_milli)}</span><span className="num">{formatMoney(i.total)}</span></div>)}
            </div>
            <div className="row">
              <ActionButton kind="ok-btn" action={() => decide(o, 'accept')}>{t('Принять и отгрузить')}</ActionButton>
              <ActionButton kind="ghost" confirm={t('Отклонить заказ?')} action={() => decide(o, 'reject')}>{t('Отклонить')}</ActionButton>
            </div>
          </div>
        ))}
        <p className="small muted">{t('При принятии заказа деньги приходят на бизнес-счёт, товар списывается со склада и приходуется у покупателя.')}</p>
      </div>
      {other.length > 0 && (
        <div className="card">
          <h2>{t('История входящих')}</h2>
          <table className="table">
            <tbody>{other.map((o) => (
              <tr key={o.id}><td>{o.shop_name}</td><td>{fmtDate(o.created_at, false)}</td><td><Badge kind={o.status === 'done' ? 'ok' : 'err'}>{t(STATUS[o.status])}</Badge></td><td className="num right"><Money value={o.total} /></td></tr>
            ))}</tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function History({ refresh, onDone }) {
  const { data, loading, reload } = useAsync(() => get('/pos/purchases'), [refresh]);
  const [open, setOpen] = useState(null);
  const toast = useToast();
  if (loading && !data) return <Spinner />;
  return (
    <div className="card">
      <div className="card-head"><h2>{t('Мои закупки и заказы')}</h2><Button kind="ghost" size="sm" onClick={reload}>{t('Обновить')}</Button></div>
      {!data.purchases.length ? <Empty>{t('Закупок пока нет')}</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>№</th><th>{t('Когда')}</th><th>{t('Источник')}</th><th>{t('Позиции')}</th><th>{t('Сумма')}</th><th>{t('Статус')}</th><th /></tr></thead>
            <tbody>{data.purchases.map((p) => (
              <tr key={p.id}>
                <td>{p.id}</td>
                <td className="small nowrap">{fmtDate(p.created_at)}</td>
                <td>{p.source === 'wholesale' ? t('Оптовая база БФ') : t('Магазин «{name}»', { name: p.seller_name || '—' })}</td>
                <td>{p.items.length}</td>
                <td className="num"><Money value={p.total} /></td>
                <td><Badge kind={p.status === 'done' ? 'ok' : p.status === 'pending' ? 'warn' : p.status === 'rejected' ? 'err' : ''}>{t(STATUS[p.status])}</Badge></td>
                <td className="right nowrap">
                  <Button kind="ghost" size="sm" onClick={() => setOpen(open === p.id ? null : p.id)}>{open === p.id ? t('Скрыть') : t('Состав')}</Button>
                  {p.status === 'pending' && <ActionButton size="sm" kind="ghost" confirm={t('Отменить заказ?')} action={async () => { await post(`/pos/purchases/${p.id}/cancel`); toast(t('Заказ отменён'), 'ok'); reload(); onDone(); }}>{t('Отменить')}</ActionButton>}
                </td>
              </tr>
            ))}</tbody>
          </table>
        </div>
      )}
      {open && (() => {
        const p = data.purchases.find((x) => x.id === open);
        return p ? (
          <div className="card" style={{ boxShadow: 'none', background: 'var(--surface-2)', marginTop: 10 }}>
            <b>{t('Состав закупки')} №{p.id}</b>
            {p.items.map((i, k) => <div key={k} className="row" style={{ justifyContent: 'space-between' }}><span>{i.name} · {qtyLabel(i.unit, i.qty_milli)}</span><span className="num">{formatMoney(i.total)}</span></div>)}
          </div>
        ) : null;
      })()}
    </div>
  );
}
