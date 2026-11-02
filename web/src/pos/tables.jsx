// Столы кафе: карта зала и открытые счета. Позиции уходят на кухню, счёт
// закрывается обычным чеком со скидками, промокодом, баллами и чаевыми.
import { useCallback, useEffect, useMemo, useState } from 'react';
import { get, post, del } from '../shared/api.js';
import { t, locale } from '../shared/i18n.js';
import { Spinner, useAsync, useChannel, Money, MoneyInput, Input, Modal, Empty, Button, ActionButton, Badge, ErrorBox, useToast, Seg, Field } from '../shared/ui.jsx';
import { formatMoney } from '@bln/shared/money.js';
import { sound } from '../shared/sounds.js';
import { qtyLabel, QTY, parseWeight } from './lib.js';
import { ItemOptionsModal } from './options.jsx';
import { SalePayModal } from './pay.jsx';

const STATUS = { free: 'Свободен', busy: 'Открыт счёт', paying: 'Идёт оплата' };

export function Tables({ session, onSession }) {
  const { data, loading, reload } = useAsync(() => get('/pos/tables?all=1'), []);
  const [table, setTable] = useState(null);
  useChannel(`shop:${session.shop.id}`, (m) => { if (m.type === 'tables' || m.type === 'sale_paid') reload(); });

  if (loading && !data) return <Spinner />;
  if (table) return <TabPanel session={session} table={table} onBack={() => { setTable(null); reload(); }} onChanged={reload} onSession={onSession} />;

  const active = data.tables.filter((x) => x.active);
  const busy = active.filter((x) => x.tab).length;
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Столы')}</h1>
        <div className="row small muted">
          <Badge kind="ok">{t('Свободно')}: {active.length - busy}</Badge>
          <Badge kind="warn">{t('Открыто')}: {busy}</Badge>
        </div>
      </div>
      {!active.length ? <Empty>{t('Столов пока нет')}</Empty> : (
        <div className="tables-grid">
          {active.map((x) => (
            <button key={x.id} className={`table-card ${x.paying ? 'paying' : x.tab ? 'busy' : 'free'}`} onClick={() => setTable(x)}>
              <span className="tc-name">{x.name}</span>
              <span className="tc-sub">{x.seats} {t('мест')}</span>
              {x.tab ? (
                <>
                  <span className="tc-sum"><Money value={x.tab.total} /></span>
                  <span className="tc-sub">{x.tab.items_count} {t('позиций')} · {new Date(x.tab.opened_at).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}</span>
                </>
              ) : <span className="tc-sub">{t('Свободен')}</span>}
              <span className="tc-badge"><Badge kind={x.paying ? 'brand' : x.tab ? 'warn' : 'ok'}>{t(STATUS[x.paying ? 'paying' : x.tab ? 'busy' : 'free'])}</Badge></span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TabPanel({ session, table, onBack, onChanged, onSession }) {
  const [tab, setTab] = useState(undefined);
  const [error, setError] = useState(null);
  const [picker, setPicker] = useState(false);
  const [options, setOptions] = useState(null);
  const [weigh, setWeigh] = useState(null);
  const [move, setMove] = useState(false);
  const [checkout, setCheckout] = useState(false);
  const [paySale, setPaySale] = useState(null);
  const toast = useToast();

  const load = useCallback(async () => {
    try {
      const r = await get(`/pos/tables/${table.id}/tab`);
      setTab(r.tab);
      setError(null);
    } catch (e) { setError(e); }
  }, [table.id]);
  useEffect(() => { load(); }, [load]);
  useChannel(`shop:${session.shop.id}`, (m) => { if (m.type === 'tables' || (m.type === 'kitchen' && m.sale_id === tab?.id)) load(); });

  async function addLines(lines) {
    try {
      const r = await post(`/pos/tables/${table.id}/items`, { items: lines });
      setTab(r.tab);
      sound.beep();
      onChanged();
    } catch (e) { toast(e.message, 'err'); sound.decline(); }
  }

  async function removeItem(item) {
    if (!window.confirm(t('Убрать «{name}» из счёта?', { name: item.name }))) return;
    try {
      const r = await post(`/pos/tables/${table.id}/remove`, { item_id: item.id });
      setTab(r.tab);
      onChanged();
    } catch (e) { toast(e.message, 'err'); }
  }

  async function toKitchen() {
    try {
      const r = await post(`/pos/tables/${table.id}/kitchen`);
      toast(t('Отправлено на кухню, номер {n}', { n: r.order.queue_no }), 'ok');
      sound.approve();
      await load();
    } catch (e) { toast(e.message, 'err'); sound.decline(); }
  }

  async function cancelTab() {
    if (!window.confirm(t('Отменить счёт стола «{name}»? Позиции не будут проданы.', { name: table.name }))) return;
    try {
      await del(`/pos/tables/${table.id}/tab`);
      toast(t('Счёт отменён'), 'ok');
      onChanged();
      onBack();
    } catch (e) { toast(e.message, 'err'); }
  }

  if (tab === undefined) return <div className="page"><Spinner /></div>;

  const unsent = tab?.items?.filter((i) => !i.sent_to_kitchen && i.product_id) || [];

  return (
    <div className="page">
      <div className="page-head">
        <button className="btn ghost sm" onClick={onBack}>← {t('Столы')}</button>
        <h1 style={{ margin: 0 }}>{table.name}</h1>
        <span className="muted small">{table.seats} {t('мест')}</span>
        <div className="row" style={{ marginLeft: 'auto' }}>
          <Button kind="secondary" size="sm" onClick={() => setPicker(true)}>{t('Добавить блюда')}</Button>
          {session.shop.kitchen_enabled && (
            <Button kind="secondary" size="sm" disabled={!unsent.length} onClick={toKitchen}>👨‍🍳 {t('На кухню')}{unsent.length ? ` (${unsent.length})` : ''}</Button>
          )}
          <Button kind="secondary" size="sm" onClick={() => setMove(true)} disabled={!tab}>{t('Перенести')}</Button>
          {tab && <ActionButton kind="ghost" size="sm" confirm={t('Отменить счёт стола?')} action={cancelTab}>{t('Отменить счёт')}</ActionButton>}
        </div>
      </div>
      <ErrorBox error={error} />
      {!tab ? (
        <div className="card">
          <Empty>{t('Стол свободен. Откройте счёт и добавьте блюда.')}</Empty>
          <div className="center"><Button onClick={() => setPicker(true)}>{t('Открыть счёт')}</Button></div>
        </div>
      ) : (
        <div className="grid grid-2">
          <div className="card">
            <div className="card-head"><h2>{t('Счёт стола')}</h2><Badge kind="warn">№{tab.id}</Badge></div>
            {!tab.items.length ? <Empty>{t('В счёте пусто')}</Empty> : (
              <div className="list">
                {tab.items.map((i) => (
                  <div key={i.id} className="list-item">
                    <div className="li-main">
                      <div className="li-title">{i.name} {i.sent_to_kitchen && <Badge kind="ok">{t('на кухне')}</Badge>}</div>
                      <div className="li-sub">{qtyLabel(i.unit, i.qty_milli)} × {formatMoney(i.price)}</div>
                    </div>
                    <Money value={i.total} />
                    <button className="btn ghost sm" onClick={() => removeItem(i)} title={t('Убрать')}>✕</button>
                  </div>
                ))}
              </div>
            )}
            <div className="totals-box" style={{ marginTop: 12 }}>
              <div className="trow"><span>{t('Подытог')}</span><span>{formatMoney(tab.subtotal)}</span></div>
              <div className="trow big"><span>{t('К оплате')}</span><span><Money value={tab.total} /></span></div>
            </div>
            <div className="row" style={{ marginTop: 12 }}>
              <Button size="lg" className="grow" onClick={() => setCheckout(true)}>{t('Закрыть счёт и оплатить')}</Button>
            </div>
          </div>
          <div className="card">
            <h2>{t('Что дальше')}</h2>
            <div className="stack">
              <p className="muted small">{t('Открытый счёт хранится на сервере: к нему можно добавлять блюда в любой момент, а отправленные на кухню позиции отмечены.')}</p>
              <div className="row"><Badge kind="warn">{t('позиций')}: {tab.items.length}</Badge><Badge>{t('не отправлено')}: {unsent.length}</Badge></div>
              <Button kind="secondary" onClick={() => setPicker(true)}>{t('Добавить блюда')}</Button>
              {session.shop.kitchen_enabled && <Button kind="secondary" disabled={!unsent.length} onClick={toKitchen}>{t('Отправить на кухню')}</Button>}
              <a className="btn ghost" href="#/kitchen">{t('Экран кухни')}</a>
              <a className="btn ghost" href={`#/queue?shop=${session.shop.id}`}>{t('Табло очереди')}</a>
            </div>
          </div>
        </div>
      )}

      {picker && (
        <TabProductPicker
          onClose={() => setPicker(false)}
          onPick={(p) => {
            if ((p.variants || []).some((v) => v.active !== false) || (p.modifiers || []).some((m) => m.active !== false)) setOptions(p);
            else if (p.unit === 'kg') setWeigh({ product: p, grams: '' });
            else addLines([{ product_id: p.id, qty_milli: QTY }]);
          }}
        />
      )}
      {options && (
        <ItemOptionsModal
          product={options}
          onClose={() => setOptions(null)}
          onAdd={(line) => { addLines([{ product_id: options.id, ...line }]); setOptions(null); }}
        />
      )}
      {weigh && (
        <Modal title={weigh.product.name} onClose={() => setWeigh(null)}>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); const g = parseWeight(weigh.grams); if (g > 0) { addLines([{ product_id: weigh.product.id, qty_milli: g }]); setWeigh(null); } }}>
            <Input label={t('Вес: граммы или кг через запятую')} autoFocus value={weigh.grams} onChange={(e) => setWeigh({ ...weigh, grams: e.target.value })} />
            <Button type="submit">{t('Добавить')}</Button>
          </form>
        </Modal>
      )}
      {move && <MoveModal table={table} onClose={() => setMove(false)} onDone={() => { setMove(false); toast(t('Счёт перенесён'), 'ok'); onChanged(); onBack(); }} />}
      {checkout && tab && (
        <CheckoutModal
          table={table}
          tab={tab}
          onClose={() => setCheckout(false)}
          onDone={(saleId) => { setCheckout(false); setPaySale(saleId); }}
        />
      )}
      {paySale && (
        <SalePayModal session={session} saleId={paySale} onClose={() => { setPaySale(null); load(); onChanged(); }} onDone={() => { setPaySale(null); onChanged(); onSession(); onBack(); }} />
      )}
    </div>
  );
}

function TabProductPicker({ onClose, onPick }) {
  const { data, loading } = useAsync(() => get('/pos/products'), []);
  const [search, setSearch] = useState('');
  const [cat, setCat] = useState('');
  if (loading && !data) return <Modal title={t('Меню')} onClose={onClose}><Spinner /></Modal>;
  const products = data.products;
  const categories = [...new Set(products.map((p) => p.category).filter(Boolean))];
  const shown = products.filter((p) => (!cat || p.category === cat) && (!search || p.name.toLowerCase().includes(search.toLowerCase()) || p.barcode === search));
  return (
    <Modal title={t('Добавить блюда')} onClose={onClose} wide>
      <div className="stack">
        <input className="input" placeholder={t('Поиск или штрихкод')} value={search} onChange={(e) => setSearch(e.target.value)} autoFocus />
        {categories.length > 0 && (
          <div className="cats">
            <button className={!cat ? 'active' : ''} onClick={() => setCat('')}>{t('Все')}</button>
            {categories.map((c) => <button key={c} className={cat === c ? 'active' : ''} onClick={() => setCat(c)}>{c}</button>)}
          </div>
        )}
        <div className="tiles">
          {shown.map((p) => (
            <button key={p.id} className="tile" onClick={() => onPick(p)}>
              <div className="t-img" style={p.photo ? { backgroundImage: `url(${p.photo})` } : undefined}>{!p.photo && (p.unit === 'kg' ? '⚖' : '🍽')}</div>
              <span className="t-name">{p.name}</span>
              <span className="t-price">{formatMoney(p.price)}{p.unit === 'kg' ? ` / ${t('кг')}` : ''}</span>
            </button>
          ))}
        </div>
      </div>
    </Modal>
  );
}

function MoveModal({ table, onClose, onDone }) {
  const { data, loading } = useAsync(() => get('/pos/tables'), []);
  const [to, setTo] = useState(null);
  const [error, setError] = useState(null);
  if (loading && !data) return <Modal title={t('Перенести счёт')} onClose={onClose}><Spinner /></Modal>;
  const free = data.tables.filter((x) => x.id !== table.id && !x.tab);
  return (
    <Modal title={t('Перенести счёт')} onClose={onClose}>
      <div className="stack">
        <p className="muted small">{t('Счёт переедет на выбранный свободный стол.')}</p>
        {!free.length ? <Empty>{t('Свободных столов нет')}</Empty> : (
          <div className="tables-grid">
            {free.map((x) => (
              <button key={x.id} className="table-card free" style={{ borderColor: to === x.id ? 'var(--accent)' : undefined }} onClick={() => setTo(x.id)}>
                <span className="tc-name">{x.name}</span>
                <span className="tc-sub">{x.seats} {t('мест')}</span>
              </button>
            ))}
          </div>
        )}
        <ErrorBox error={error} />
        <div className="row">
          <Button kind="ghost" onClick={onClose}>{t('Отмена')}</Button>
          <ActionButton className="grow" disabled={!to} action={async () => {
            try { await post(`/pos/tables/${table.id}/move`, { to_table_id: to }); onDone(); } catch (e) { setError(e); }
          }}>{t('Перенести')}</ActionButton>
        </div>
      </div>
    </Modal>
  );
}

/** Закрытие счёта стола: скидки, промокод, баллы и чаевые до оплаты. */
function CheckoutModal({ table, tab, onClose, onDone }) {
  const [discount, setDiscount] = useState(0);
  const [promoCode, setPromoCode] = useState('');
  const [loyaltyRef, setLoyaltyRef] = useState('');
  const [redeem, setRedeem] = useState(0);
  const [tipPct, setTipPct] = useState(0);
  const [preview, setPreview] = useState(null);
  const [error, setError] = useState(null);
  const toast = useToast();
  const lines = useMemo(() => tab.items.map((i) => ({
    product_id: i.product_id,
    qty_milli: i.qty_milli,
    variant_id: i.variant_id || undefined,
    modifier_ids: (i.modifiers || []).map((m) => m.id),
  })), [tab]);

  useEffect(() => {
    let alive = true;
    const h = setTimeout(async () => {
      try {
        const r = await post('/pos/preview', { items: lines, discount, promo_code: promoCode.trim() || undefined, loyalty: loyaltyRef.trim() || undefined, redeem_points: redeem || undefined });
        if (alive) { setPreview(r); setError(null); }
      } catch (e) { if (alive) { setPreview(null); setError(e); } }
    }, 200);
    return () => { alive = false; clearTimeout(h); };
  }, [lines, discount, promoCode, loyaltyRef, redeem]);

  const subtotal = preview?.subtotal ?? tab.subtotal;
  const total = preview?.total ?? tab.total;
  const tip = Math.round(total * tipPct / 100);
  return (
    <Modal title={`${t('Счёт')} · ${table.name}`} onClose={onClose} wide>
      <div className="grid grid-2">
        <div className="stack">
          <div className="list small">
            {tab.items.map((i) => <div key={i.id} className="list-item"><div className="li-main">{i.name}</div><Money value={i.total} /></div>)}
          </div>
          {preview?.promo?.applied?.map((a) => <div key={a.id} className="row" style={{ justifyContent: 'space-between' }}><span className="promo-tag">🎁 {a.title}</span><span className="neg">−{formatMoney(a.amount)}</span></div>)}
          {preview?.loyalty && <div className="small muted">{preview.loyalty.full_name} · {preview.loyalty.points} {t('баллов')} · {t('доступно')} {preview.loyalty.available}</div>}
          <div className="totals-box">
            <div className="trow"><span>{t('Подытог')}</span><span>{formatMoney(subtotal)}</span></div>
            <div className="trow"><span>{t('Скидки')}</span><span className="neg">−{formatMoney(preview?.discount || 0)}</span></div>
            {tipPct > 0 && <div className="trow"><span>{t('Чаевые')} {tipPct}%</span><span>{formatMoney(tip)}</span></div>}
            <div className="trow big"><span>{t('К оплате')}</span><span>{formatMoney(total + tip)}</span></div>
          </div>
        </div>
        <div className="stack">
          <MoneyInput label={t('Ручная скидка')} value={discount || null} onChange={(v) => setDiscount(v || 0)} />
          <Input label={t('Промокод')} value={promoCode} onChange={(e) => setPromoCode(e.target.value.toUpperCase().replace(/\s/g, ''))} />
          <Input label={t('Карта лояльности или паспорт БФ')} value={loyaltyRef} onChange={(e) => setLoyaltyRef(e.target.value.toUpperCase())} />
          {preview?.loyalty && <Input label={t('Списать баллов')} type="number" min={0} max={preview.loyalty.available} value={redeem || ''} onChange={(e) => setRedeem(Math.max(0, Math.min(preview.loyalty.available, Number(e.target.value) || 0)))} />}
          <Field label={t('Чаевые кассиру')}>
            <Seg value={tipPct} onChange={setTipPct} options={[0, 5, 10, 15].map((p) => ({ value: p, label: `${p}%` }))} />
          </Field>
          <ErrorBox error={error} />
          <ActionButton kind="ok-btn" size="lg" disabled={!!error} action={async () => {
            try {
              const r = await post(`/pos/tables/${table.id}/checkout`, {
                discount, promo_code: promoCode.trim() || undefined, loyalty: loyaltyRef.trim() || undefined, redeem_points: redeem || undefined, tip_pct: tipPct,
              });
              toast(t('Счёт передан к оплате'), 'ok');
              onDone(r.sale.id);
            } catch (e) { setError(e); }
          }}>{t('Перейти к оплате')} {formatMoney(total + tip)}</ActionButton>
          <p className="small muted">{t('После оплаты счёт закроется, а стол снова станет свободным. Отмена оплаты вернёт счёт на стол.')}</p>
        </div>
      </div>
    </Modal>
  );
}
