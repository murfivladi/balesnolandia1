import { useEffect, useMemo, useRef, useState } from 'react';
import { get, post, appUrl } from '../shared/api.js';
import { t, tServer } from '../shared/i18n.js';
import {
  Spinner, useAsync, useChannel, Money, MoneyInput, Input, Modal, Empty, Button, ActionButton, Scanner, QR, ErrorBox, useToast, Badge,
} from '../shared/ui.jsx';
import { sound } from '../shared/sounds.js';
import { renderThermal, reportBlocks, shareCanvas } from '../shared/thermal.js';
import { formatMoney } from '@bln/shared/money.js';
import { navigate } from '../shared/router.js';
import { QTY, qtyLabel, lineSum, lineKey, linePrice, lineName, parseWeight } from './lib.js';
import { ItemOptionsModal } from './options.jsx';
import { PayModal } from './pay.jsx';
import { DebtBook } from './debts.jsx';

export function Register({ session, onSession }) {
  const { data, reload: reloadProducts } = useAsync(() => get('/pos/products'), []);
  const [cart, setCart] = useState([]);
  const [discount, setDiscount] = useState(0);
  const [promoCode, setPromoCode] = useState('');
  const [loyaltyRef, setLoyaltyRef] = useState('');
  const [redeem, setRedeem] = useState(0);
  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [cat, setCat] = useState('');
  const [search, setSearch] = useState('');
  const [scan, setScan] = useState(false);
  const [options, setOptions] = useState(null);
  const [weigh, setWeigh] = useState(null);
  const [modal, setModal] = useState(null);
  const [terminal, setTerminal] = useState(null); // { code, paired }
  const toast = useToast();
  const searchRef = useRef(null);

  const products = useMemo(() => data?.products || [], [data]);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const categories = useMemo(() => [...new Set(products.map((p) => p.category).filter(Boolean))], [products]);
  const shown = products.filter((p) => (!cat || p.category === cat) && (!search || p.name.toLowerCase().includes(search.toLowerCase()) || p.barcode === search));
  const payload = useMemo(() => cart.map((l) => ({
    product_id: l.product_id,
    qty_milli: l.qty_milli,
    variant_id: l.variant_id || undefined,
    modifier_ids: l.modifier_ids?.length ? l.modifier_ids : undefined,
  })), [cart]);
  const subtotal = preview?.subtotal ?? cart.reduce((s, l) => {
    const p = byId.get(l.product_id);
    const v = p?.variants?.find((x) => x.id === l.variant_id);
    const mods = (p?.modifiers || []).filter((m) => l.modifier_ids?.includes(m.id));
    return s + (p ? lineSum(linePrice(p, v, mods), l.qty_milli) : 0);
  }, 0);
  const promoAmount = preview?.promo?.amount || 0;
  const pointsUsed = preview?.points_used || 0;
  const total = preview?.total ?? Math.max(0, subtotal - discount);

  useChannel(`shop:${session.shop.id}`, (m) => {
    if (m.type === 'sale_paid' || m.type === 'product_restored') reloadProducts();
    if (m.type === 'product_deleted') {
      const next = cart.filter((l) => l.product_id !== m.id);
      setCart(next);
      if (!next.length) resetDiscounts();
      reloadProducts();
      toast(t('Товар удалён из каталога'), 'err');
    }
  });

  // Сервер считает акции, промокод, баллы и НДС: касса показывает только его расчёт.
  useEffect(() => {
    if (!cart.length) { setPreview(null); setPreviewError(null); return undefined; }
    let alive = true;
    const h = setTimeout(async () => {
      try {
        const r = await post('/pos/preview', {
          items: payload,
          discount,
          promo_code: promoCode.trim() || undefined,
          loyalty: loyaltyRef.trim() || undefined,
          redeem_points: redeem || undefined,
        });
        if (alive) { setPreview(r); setPreviewError(null); }
      } catch (e) {
        if (alive) { setPreview(null); setPreviewError(e); }
      }
    }, 220);
    return () => { alive = false; clearTimeout(h); };
  }, [payload, discount, promoCode, loyaltyRef, redeem, cart.length]);

  // Показ корзины на терминале покупателя.
  useEffect(() => {
    if (!terminal?.paired) return undefined;
    const h = setTimeout(() => {
      post(`/pos/terminals/${terminal.code}/display`, {
        lines: cart.map((l, i) => {
          const p = byId.get(l.product_id);
          return { name: lineNameSafe(p, l), qty: qtyLabel(p?.unit, l.qty_milli), total: preview?.items?.[i]?.total ?? 0 };
        }),
        total,
      }).catch(() => {});
    }, 200);
    return () => clearTimeout(h);
  }, [cart, total, terminal, byId, preview]);

  function lineNameSafe(p, l) {
    if (!p) return '';
    const v = p.variants?.find((x) => x.id === l.variant_id);
    const mods = (p.modifiers || []).filter((m) => l.modifier_ids?.includes(m.id));
    return lineName(p, v, mods);
  }

  function resetDiscounts() {
    setDiscount(0);
    setPromoCode('');
    setLoyaltyRef('');
    setRedeem(0);
  }

  function stockLeft(p) {
    if (!p.track_stock) return Infinity;
    const inCart = cart.filter((l) => l.product_id === p.id).reduce((s, l) => s + l.qty_milli, 0);
    return p.stock_milli - inCart;
  }

  function pushLine(p, { variant_id = null, modifier_ids = [], qty_milli }) {
    if (stockLeft(p) < qty_milli) {
      toast(t('Нет в наличии: {name}', { name: p.name }), 'err');
      sound.decline();
      return false;
    }
    const key = lineKey(p.id, variant_id, modifier_ids);
    sound.beep();
    setCart((c) => {
      const i = c.findIndex((l) => l.key === key);
      if (i >= 0) return c.map((l, j) => (j === i ? { ...l, qty_milli: l.qty_milli + qty_milli } : l));
      return [...c, { key, product_id: p.id, variant_id, modifier_ids, qty_milli }];
    });
    return true;
  }

  function add(p, qty = QTY) {
    pushLine(p, { qty_milli: qty });
  }

  function pick(p) {
    if ((p.variants || []).some((v) => v.active !== false) || (p.modifiers || []).some((m) => m.active !== false)) setOptions(p);
    else if (p.unit === 'kg') setWeigh({ product: p, grams: '' });
    else add(p);
  }

  function onScanText(text) {
    setScan(false);
    const code = String(text).trim();
    const p = products.find((x) => x.barcode && x.barcode === code);
    if (p) pick(p);
    else { toast(t('Товар со штрихкодом {code} не найден', { code }), 'err'); sound.decline(); }
  }

  function changeQty(i, delta) {
    const l = cart[i];
    const p = byId.get(l.product_id);
    const q = l.qty_milli + delta * QTY;
    if (q <= 0) { remove(i); return; }
    if (delta > 0 && stockLeft(p) < QTY) return;
    setCart((c) => c.map((x, j) => (j === i ? { ...x, qty_milli: q } : x)));
  }

  function remove(i) {
    const l = cart[i];
    post('/pos/log', { action: 'remove_item', data: { name: lineNameSafe(byId.get(l.product_id), l), qty_milli: l.qty_milli } }).catch(() => {});
    setCart((c) => c.filter((_, j) => j !== i));
  }

  function clear() {
    if (cart.length) post('/pos/log', { action: 'clear_cart', data: { lines: cart.length, total } }).catch(() => {});
    setCart([]);
    resetDiscounts();
  }

  async function hold() {
    const label = window.prompt(t('Метка отложенного чека (необязательно)')) ?? null;
    if (label === null) return;
    await post('/pos/held', { items: payload, label });
    setCart([]);
    resetDiscounts();
    toast(t('Чек отложен'), 'ok');
    onSession();
  }

  async function openDrawer() {
    await post('/pos/log', { action: 'drawer_open' });
    sound.drawer();
  }

  useEffect(() => {
    const on = (e) => {
      if (e.key === 'F2') { e.preventDefault(); searchRef.current?.focus(); }
      if (e.key === 'F9' && cart.length && session.shift) { e.preventDefault(); setModal('pay'); }
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  });

  if (!session.shift) return <OpenShift onDone={onSession} />;
  if (!data) return <Spinner />;

  return (
    <div className="pos-shell">
      <div className="pos-left">
        <div className="row nowrap">
          <input
            ref={searchRef}
            className="input"
            placeholder={t('Поиск или штрихкод (F2)')}
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                const exact = products.find((p) => p.barcode && p.barcode === search.trim());
                if (exact) { pick(exact); setSearch(''); } else if (shown.length === 1) { pick(shown[0]); setSearch(''); }
              }
            }}
          />
          <button className="btn secondary" onClick={() => setScan(true)} title={t('Сканер')}>📷</button>
        </div>
        {categories.length > 0 && (
          <div className="cats">
            <button className={!cat ? 'active' : ''} onClick={() => setCat('')}>{t('Все')}</button>
            {categories.map((c) => <button key={c} className={cat === c ? 'active' : ''} onClick={() => setCat(c)}>{c}</button>)}
          </div>
        )}
        {!products.length ? (
          <Empty>{session.staff.role === 'owner' ? <>{t('Добавьте товары')} — <a href="#/manage/products">{t('каталог')}</a></> : t('Каталог пуст')}</Empty>
        ) : (
          <div className="tiles">
            {shown.map((p) => (
              <button key={p.id} className={`tile${stockLeft(p) <= 0 ? ' out' : ''}`} onClick={() => pick(p)}>
                <div className="t-img" style={p.photo ? { backgroundImage: `url(${p.photo})` } : undefined}>{!p.photo && (p.unit === 'kg' ? '⚖' : '🛒')}</div>
                {p.age_limit > 0 && <span className="t-age">{p.age_limit}+</span>}
                <span className="t-name">{p.name}</span>
                <span className="t-price">{formatMoney(p.price)}{p.unit === 'kg' ? ` / ${t('кг')}` : ''}</span>
                {p.track_stock && <span className="tiny muted">{t('остаток')}: {qtyLabel(p.unit, p.stock_milli)}</span>}
              </button>
            ))}
          </div>
        )}
        <div className="row" style={{ marginTop: 'auto' }}>
          <Button kind="secondary" size="sm" onClick={() => setModal('terminal')}>🖥 {terminal?.paired ? t('Терминал подключён') : t('Терминал')}</Button>
          <Button kind="secondary" size="sm" onClick={() => setModal('held')}>{t('Отложенные')} {session.held > 0 && <Badge kind="warn">{session.held}</Badge>}</Button>
          <Button kind="secondary" size="sm" onClick={() => setModal('refund')}>{t('Возврат')}</Button>
          <Button kind="secondary" size="sm" onClick={() => setModal('invoice')}>{t('Квитанция')}</Button>
          <Button kind="secondary" size="sm" onClick={() => setModal('debts')}>{t('Долги')}</Button>
          <Button kind="secondary" size="sm" onClick={() => setModal('age')}>{t('Проверка паспорта')}</Button>
          <Button kind="secondary" size="sm" onClick={openDrawer}>{t('Ящик')}</Button>
          <Button kind="secondary" size="sm" onClick={() => setModal('shift')}>{t('Смена')}</Button>
          {session.shop.type === 'cafe' && <Button kind="secondary" size="sm" onClick={() => navigate('/tables')}>{t('Столы')}</Button>}
          {session.shop.kitchen_enabled && <Button kind="secondary" size="sm" onClick={() => navigate('/kitchen')}>{t('Кухня')}</Button>}
          <Button kind="ghost" size="sm" onClick={() => navigate('/kiosk')}>{t('Киоск')}</Button>
        </div>
      </div>
      <div className="pos-right">
        <div className="cart">
          {!cart.length ? <Empty>{t('Чек пуст. Выберите товар или отсканируйте штрихкод.')}</Empty> : cart.map((l, i) => {
            const p = byId.get(l.product_id);
            if (!p) return null;
            const pl = preview?.items?.[i];
            return (
              <div key={l.key} className="cart-line">
                <span className="cl-name">{lineNameSafe(p, l)} {p.age_limit > 0 && <Badge kind="err">{p.age_limit}+</Badge>}</span>
                <span className="cl-sum"><Money value={pl ? pl.total + pl.discount : lineSum(linePrice(p, p.variants?.find((v) => v.id === l.variant_id), (p.modifiers || []).filter((m) => l.modifier_ids?.includes(m.id))), l.qty_milli)} /></span>
                <span className="cl-qty">
                  {p.unit === 'pcs' ? (
                    <>
                      <button className="qty-btn" onClick={() => changeQty(i, -1)}>−</button>
                      {l.qty_milli / QTY}
                      <button className="qty-btn" onClick={() => changeQty(i, 1)}>+</button>
                    </>
                  ) : qtyLabel('kg', l.qty_milli)}
                  × {formatMoney(pl ? pl.price : p.price)}
                </span>
                <button className="btn ghost sm" style={{ justifySelf: 'end' }} onClick={() => remove(i)} aria-label={t('Удалить')} title={t('Удалить товар из чека')}>✕ {t('Удалить')}</button>
              </div>
            );
          })}
        </div>
        <div className="cart-total">
          <div className="totals-box">
            <div className="trow"><span>{t('Подытог')}</span><span>{formatMoney(subtotal)}</span></div>
            {promoAmount > 0 && <div className="trow"><span>{t('Акции и промокод')} {preview?.promo?.applied?.map((x) => <span key={x.id} className="promo-tag">{x.title}</span>)}</span><span className="neg">−{formatMoney(promoAmount)}</span></div>}
            {discount > 0 && <div className="trow"><span>{t('Ручная скидка')}</span><span className="neg">−{formatMoney(discount)}</span></div>}
            {pointsUsed > 0 && <div className="trow"><span>{t('Баллы')}</span><span className="neg">−{formatMoney(pointsUsed)}</span></div>}
            {preview?.loyalty && <div className="trow small muted"><span>👤 {preview.loyalty.full_name}</span><span>{t('баллов')}: {preview.loyalty.points}</span></div>}
            <div className="trow big"><span>{t('Итого')}</span><span><Money value={total} /></span></div>
          </div>
          {previewError && <div className="form-error small">{tServer(previewError.message)}</div>}
          <div className="row nowrap">
            <Button kind="ghost" size="sm" disabled={!cart.length} onClick={() => setModal('discounts')}>{t('% и баллы')}</Button>
            <Button kind="ghost" size="sm" disabled={!cart.length} onClick={hold}>{t('Отложить')}</Button>
            <Button kind="ghost" size="sm" disabled={!cart.length} onClick={clear}>{t('Очистить')}</Button>
          </div>
          <Button size="lg" block disabled={!cart.length || !!previewError} onClick={() => setModal('pay')}>{t('Оплата')} (F9)</Button>
        </div>
      </div>

      {scan && <Scanner onScan={onScanText} onClose={() => setScan(false)} />}
      {options && (
        <ItemOptionsModal
          product={options}
          onClose={() => setOptions(null)}
          onAdd={(line) => { if (pushLine(options, line)) setOptions(null); }}
        />
      )}
      {weigh && (
        <Modal title={weigh.product.name} onClose={() => setWeigh(null)}>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); const g = parseWeight(weigh.grams); if (g > 0 && pushLine(weigh.product, { qty_milli: g })) setWeigh(null); }}>
            <Input label={t('Вес: граммы или кг через запятую')} autoFocus inputMode="decimal" value={weigh.grams} onChange={(e) => setWeigh({ ...weigh, grams: e.target.value })} />
            <p className="muted small">{formatMoney(weigh.product.price)} / {t('кг')}</p>
            <Button type="submit">{t('Добавить')}</Button>
          </form>
        </Modal>
      )}
      {modal === 'discounts' && (
        <DiscountsModal
          preview={preview}
          subtotal={subtotal}
          discount={discount}
          setDiscount={setDiscount}
          promoCode={promoCode}
          setPromoCode={setPromoCode}
          loyaltyRef={loyaltyRef}
          setLoyaltyRef={setLoyaltyRef}
          redeem={redeem}
          setRedeem={setRedeem}
          onClose={() => setModal(null)}
        />
      )}
      {modal === 'pay' && (
        <PayModal
          session={session}
          draft={{ items: payload, discount, promo_code: promoCode.trim() || undefined, loyalty: loyaltyRef.trim() || undefined, redeem_points: redeem || undefined }}
          terminal={terminal}
          onClose={() => setModal(null)}
          onDone={() => { setCart([]); resetDiscounts(); setModal(null); reloadProducts(); onSession(); }}
        />
      )}
      {modal === 'terminal' && <TerminalModal terminal={terminal} setTerminal={setTerminal} onClose={() => setModal(null)} />}
      {modal === 'held' && <HeldModal onClose={() => setModal(null)} onResume={(items) => {
        setCart(items.map((i) => ({ key: lineKey(i.product_id, i.variant_id, i.modifier_ids), product_id: i.product_id, variant_id: i.variant_id || null, modifier_ids: i.modifier_ids || [], qty_milli: Number(i.qty_milli) })));
        setModal(null);
        onSession();
      }} />}
      {modal === 'refund' && <RefundModal onClose={() => setModal(null)} />}
      {modal === 'invoice' && <InvoiceModal onClose={() => setModal(null)} />}
      {modal === 'age' && <AgeLookup onClose={() => setModal(null)} />}
      {modal === 'shift' && <ShiftModal session={session} onClose={() => setModal(null)} onClosed={() => { setModal(null); onSession(); }} />}
      {modal === 'debts' && (
        <Modal title={t('Долги')} onClose={() => setModal(null)} wide>
          <DebtBook session={session} />
        </Modal>
      )}
    </div>
  );
}

function OpenShift({ onDone }) {
  const [float, setFloat] = useState(null);
  return (
    <div className="page narrow">
      <div className="card">
        <h2>{t('Открытие смены')}</h2>
        <Form2 onSubmit={async () => { await post('/pos/shifts/open', { opening_float: float || 0 }); onDone(); }} label={t('Открыть смену')}>
          <MoneyInput label={t('Разменный фонд в ящике')} value={float} onChange={setFloat} big autoFocus />
        </Form2>
      </div>
    </div>
  );
}

function Form2({ onSubmit, label, children, kind }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return (
    <form className="stack" onSubmit={async (e) => { e.preventDefault(); setBusy(true); setError(null); try { await onSubmit(); } catch (err) { setError(err); } finally { setBusy(false); } }}>
      {children}
      <ErrorBox error={error} />
      <Button type="submit" busy={busy} block kind={kind}>{label}</Button>
    </form>
  );
}

/** Скидки и лояльность: ручная скидка, промокод, баллы магазина. Всё проверяет сервер. */
function DiscountsModal({ preview, subtotal, discount, setDiscount, promoCode, setPromoCode, loyaltyRef, setLoyaltyRef, redeem, setRedeem, onClose }) {
  const [lookup, setLookup] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  async function findCustomer() {
    setBusy(true);
    setError(null);
    try {
      setLookup(await get(`/pos/loyalty/lookup?q=${encodeURIComponent(loyaltyRef.trim())}`));
    } catch (e) {
      setLookup(null);
      setError(e);
    } finally { setBusy(false); }
  }
  const applied = preview?.promo?.applied || [];
  const available = preview?.loyalty?.available ?? 0;
  return (
    <Modal title={t('Скидки и баллы')} onClose={onClose} wide>
      <div className="stack">
        <div className="grid grid-2">
          <div className="stack">
            <h3 style={{ margin: 0 }}>{t('Ручная скидка')}</h3>
            <MoneyInput label={t('Сумма скидки')} value={discount || null} onChange={(v) => setDiscount(v || 0)} hint={t('Скидка записывается в журнал кассы.')} />
            <div className="row">{['5%', '10%', '15%', '20%'].map((p, i) => (
              <Button key={p} size="sm" kind="secondary" onClick={() => setDiscount(Math.round(subtotal * [5, 10, 15, 20][i] / 100))}>{p}</Button>
            ))}</div>
          </div>
          <div className="stack">
            <h3 style={{ margin: 0 }}>{t('Промокод')}</h3>
            <Input label={t('Код')} value={promoCode} onChange={(e) => setPromoCode(e.target.value.toUpperCase().replace(/\s/g, ''))} placeholder="SALE10" />
            {applied.length > 0 && (
              <div className="stack-sm">
                {applied.map((a) => <div key={a.id} className="row" style={{ justifyContent: 'space-between' }}><span className="promo-tag">🎁 {a.title}</span> <span className="neg">−{formatMoney(a.amount)}</span></div>)}
              </div>
            )}
            {!applied.length && <p className="small muted">{t('Акции магазина применяются автоматически, промокод — по коду.')}</p>}
          </div>
        </div>
        <hr className="sep" />
        <div className="stack">
          <h3 style={{ margin: 0 }}>{t('Карта лояльности')}</h3>
          <div className="row nowrap">
            <input className="input" placeholder={t('Номер карты ВлодБанка или паспорт БФ')} value={loyaltyRef} onChange={(e) => setLoyaltyRef(e.target.value.toUpperCase())} />
            <button type="button" className="btn secondary" onClick={findCustomer} disabled={busy}>{t('Найти')}</button>
          </div>
          <ErrorBox error={error} />
          {lookup && <div className="form-ok">{lookup.customer.name} · {lookup.customer.points} {t('баллов')}</div>}
          {!lookup && preview?.loyalty && <div className="form-ok">{preview.loyalty.full_name} · {preview.loyalty.points} {t('баллов')}</div>}
          {preview?.loyalty && (
            <div className="row">
              <Input label={t('Списать баллов')} type="number" min={0} max={available} value={redeem || ''} onChange={(e) => setRedeem(Math.max(0, Math.min(available, Number(e.target.value) || 0)))} hint={t('Можно списать до {n} баллов в этом чеке', { n: available })} />
              <Button size="sm" kind="secondary" onClick={() => setRedeem(available)}>{t('Списать всё')}</Button>
            </div>
          )}
        </div>
        <div className="totals-box">
          <div className="trow"><span>{t('Подытог')}</span><span>{formatMoney(subtotal)}</span></div>
          <div className="trow"><span>{t('Итого скидок')}</span><span className="neg">−{formatMoney((preview?.discount || 0))}</span></div>
          <div className="trow big"><span>{t('К оплате')}</span><span>{formatMoney(preview?.total ?? subtotal)}</span></div>
        </div>
        <Button onClick={onClose}>{t('Готово')}</Button>
      </div>
    </Modal>
  );
}

function TerminalModal({ terminal, setTerminal, onClose }) {
  const [busy, setBusy] = useState(false);
  useChannel(terminal ? `terminal:${terminal.code}` : null, (m) => {
    if (m.type === 'terminal_joined') { setTerminal((x) => ({ ...x, paired: true })); sound.approve(); }
    if (m.type === 'terminal_left') setTerminal((x) => ({ ...x, paired: false }));
  });
  async function pair() {
    setBusy(true);
    try { setTerminal({ code: (await post('/pos/terminals')).code, paired: false }); } finally { setBusy(false); }
  }
  return (
    <Modal title={t('Терминал покупателя')} onClose={onClose}>
      <div className="stack center" style={{ alignItems: 'center' }}>
        {!terminal ? (
          <>
            <p>{t('Второе устройство (телефон или планшет) показывает чек покупателю и принимает карту и PIN.')}</p>
            <Button busy={busy} onClick={pair}>{t('Получить код сопряжения')}</Button>
          </>
        ) : (
          <>
            <p>{t('На втором устройстве откройте')}</p>
            <div className="mono small">{appUrl('pos', '/terminal')}</div>
            <div style={{ background: '#fff', padding: 8, borderRadius: 8 }}><QR value={appUrl('pos', `/terminal/${terminal.code}`)} size={160} /></div>
            <p>{t('и введите код')}</p>
            <div className="mono" style={{ fontSize: '2.4rem', letterSpacing: 8, fontWeight: 800 }}>{terminal.code}</div>
            {terminal.paired ? <div className="form-ok">✓ {t('Терминал подключён')}</div> : <><Spinner /><span className="muted">{t('Ждём терминал…')}</span></>}
            <Button kind="ghost" onClick={async () => { await post(`/pos/terminals/${terminal.code}/close`).catch(() => {}); setTerminal(null); }}>{t('Отключить терминал')}</Button>
          </>
        )}
      </div>
    </Modal>
  );
}

function HeldModal({ onClose, onResume }) {
  const { data, loading } = useAsync(() => get('/pos/held'), []);
  return (
    <Modal title={t('Отложенные чеки')} onClose={onClose}>
      {loading && !data ? <Spinner /> : !data.held.length ? <Empty>{t('Нет отложенных чеков')}</Empty> : (
        <div className="list">
          {data.held.map((h) => (
            <div key={h.id} className="list-item">
              <div className="li-main"><div className="li-title">{h.hold_label}</div><div className="li-sub">{h.full_name}</div></div>
              <Money value={h.total} />
              <ActionButton size="sm" action={async () => onResume((await post(`/pos/held/${h.id}/resume`)).items)}>{t('Вернуть')}</ActionButton>
            </div>
          ))}
        </div>
      )}
    </Modal>
  );
}

function RefundModal({ onClose }) {
  const [no, setNo] = useState('');
  const [data, setData] = useState(null);
  const [sel, setSel] = useState({});
  const [error, setError] = useState(null);
  const [result, setResult] = useState(null);
  const [reason, setReason] = useState('');
  const [idem] = useState(() => `${Date.now()}-${Math.random()}`.replace(/\D/g, '').slice(0, 12));
  async function find() {
    setError(null);
    setData(null);
    setResult(null);
    try {
      const r = await get(`/pos/sales/by-number/${encodeURIComponent(no)}`);
      setData(r);
      setSel({});
    } catch (e) { setError(e); }
  }
  const items = data?.sale.items || [];
  return (
    <Modal title={t('Возврат по чеку')} onClose={onClose} wide>
      <div className="stack">
        <form className="row nowrap" onSubmit={(e) => { e.preventDefault(); find(); }}>
          <input className="input" inputMode="numeric" placeholder={t('Номер чека')} value={no} onChange={(e) => setNo(e.target.value.replace(/\D/g, ''))} autoFocus />
          <button className="btn secondary">{t('Найти')}</button>
        </form>
        <ErrorBox error={error} />
        {result && (
          <div className="form-ok">
            {t('Возврат оформлен')}: <Money value={result.amount} />
            {result.cash > 0 && <div><b>{t('Выдайте наличными')}: <Money value={result.cash} /></b></div>}
            {(result.by_method.card || result.by_method.qr) && <div>{t('На карту / счёт покупателя')}: <Money value={(result.by_method.card || 0) + (result.by_method.qr || 0)} /></div>}
          </div>
        )}
        {data && !result && (
          <>
            <div className="small muted">{t('Чек')} №{data.sale.number} · <Money value={data.sale.total} /> · {data.sale.payments.map((p) => t({ cash: 'Наличные', card: 'Карта', qr: 'QR-оплата', debt: 'В долг' }[p.method])).join(' + ')}{data.sale.refunded ? ` · ${t('уже возвращено')} ${formatMoney(data.sale.refunded)}` : ''}</div>
            <table className="table">
              <thead><tr><th>{t('Товар')}</th><th>{t('Куплено')}</th><th>{t('Вернуть')}</th></tr></thead>
              <tbody>
                {items.map((i) => {
                  const left = i.qty_milli - i.refunded_milli;
                  return (
                    <tr key={i.id}>
                      <td>{i.name}<div className="tiny muted"><Money value={i.total} /></div></td>
                      <td>{qtyLabel(i.unit, i.qty_milli)}{i.refunded_milli ? <div className="tiny muted">−{qtyLabel(i.unit, i.refunded_milli)}</div> : null}</td>
                      <td>
                        {left > 0 ? (
                          <input className="input" style={{ width: 110 }} type="number" min={0} step={i.unit === 'kg' ? 0.001 : 1} max={left / 1000} value={sel[i.id] ?? ''} placeholder="0" onChange={(e) => setSel({ ...sel, [i.id]: e.target.value })} />
                        ) : <span className="muted">{t('возвращено')}</span>}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
            <Input label={t('Причина')} value={reason} onChange={(e) => setReason(e.target.value)} />
            <div className="row">
              <ActionButton kind="secondary" confirm={t('Вернуть весь чек?')} action={async () => { setResult((await post('/pos/refunds', { sale_id: data.sale.id, all: true, reason }, { idem })).refund); sound.drawer(); }}>{t('Вернуть всё')}</ActionButton>
              <ActionButton className="grow" disabled={!Object.values(sel).some((v) => Number(v) > 0)} action={async () => {
                const lines = Object.entries(sel).filter(([, v]) => Number(v) > 0).map(([id, v]) => ({ item_id: Number(id), qty_milli: Math.round(Number(v) * 1000) }));
                setResult((await post('/pos/refunds', { sale_id: data.sale.id, items: lines, reason }, { idem })).refund);
                sound.drawer();
              }}>{t('Вернуть выбранное')}</ActionButton>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}

function InvoiceModal({ onClose }) {
  const [no, setNo] = useState('');
  const [inv, setInv] = useState(null);
  const [error, setError] = useState(null);
  const [paid, setPaid] = useState(false);
  const [idem] = useState(() => `${Date.now()}-${Math.random()}`.replace(/\D/g, '').slice(0, 12));
  return (
    <Modal title={t('Оплата квитанции ВлодУслуг наличными')} onClose={onClose}>
      <div className="stack">
        <form className="row nowrap" onSubmit={async (e) => { e.preventDefault(); setError(null); setInv(null); try { setInv((await get(`/pos/invoices/${encodeURIComponent(no.trim())}`)).invoice); } catch (err) { setError(err); } }}>
          <input className="input" placeholder={t('Номер квитанции')} value={no} onChange={(e) => setNo(e.target.value.toUpperCase())} autoFocus />
          <button className="btn secondary">{t('Найти')}</button>
        </form>
        <ErrorBox error={error} />
        {inv && (
          <>
            <div className="card" style={{ background: 'var(--surface-2)', boxShadow: 'none' }}>
              <b>{t(inv.purpose)}</b>
              <div style={{ fontSize: '1.4rem', fontWeight: 700 }}><Money value={inv.amount} /></div>
              <span className="badge">{inv.status === 'paid' ? t('Оплачено') : t('Не оплачено')}</span>
            </div>
            {paid ? <div className="form-ok">{t('Квитанция оплачена. Наличные положите в ящик.')}</div> : inv.status === 'unpaid' && (
              <>
                <p className="small muted">{t('Магазин принимает наличные и перечисляет сумму в госбюджет со своего бизнес-счёта.')}</p>
                <ActionButton kind="ok-btn" action={async () => { await post(`/pos/invoices/${inv.number}/pay-cash`, {}, { idem }); setPaid(true); sound.drawer(); }}>{t('Принять')} {formatMoney(inv.amount)}</ActionButton>
              </>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function AgeLookup({ onClose }) {
  const [scan, setScan] = useState(true);
  const [res, setRes] = useState(null);
  const [error, setError] = useState(null);
  async function check(text) {
    setScan(false);
    const code = String(text).split('/').pop();
    try { setRes(await get(`/gov/verify/passport/${encodeURIComponent(code)}`)); } catch (e) { setError(e); }
  }
  return (
    <Modal title={t('Проверка паспорта БФ')} onClose={onClose}>
      {scan ? <Scanner onClose={() => setScan(false)} onScan={check} /> : null}
      <ErrorBox error={error} />
      {res && (
        <div className="stack">
          <div className={res.valid ? 'form-ok' : 'form-error'}>{res.valid ? t('Паспорт действителен') : t('Паспорт недействителен')}</div>
          {res.number && <div className="row">{res.photo && <img src={res.photo} alt="" style={{ width: 80, borderRadius: 8 }} />}<div><b>{res.full_name}</b><div>{t('Возраст')}: <b>{res.age}</b></div></div></div>}
        </div>
      )}
      <Button kind="secondary" onClick={() => { setRes(null); setScan(true); }}>{t('Сканировать')}</Button>
    </Modal>
  );
}

function ShiftModal({ session, onClose, onClosed }) {
  const [rep, setRep] = useState(null);
  const [z, setZ] = useState(false);
  const [closing, setClosing] = useState(null);
  const [img, setImg] = useState(null);
  const [canvas, setCanvas] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { get('/pos/shifts/x').then(setRep).catch(setError); }, []);
  async function show(r, isZ) {
    const c = await renderThermal(reportBlocks(r.report, { shop: r.shop, cashier: r.cashier, z: isZ }, t));
    setCanvas(c);
    setImg(c.toDataURL('image/png'));
  }
  if (img) {
    return (
      <Modal title={z ? t('Z-отчёт') : t('X-отчёт')} onClose={z ? onClosed : () => setImg(null)} wide>
        <div className="grid grid-2">
          <div className="receipt-paper"><img src={img} alt="" /></div>
          <div className="stack">
            <Button onClick={() => shareCanvas(canvas, `${z ? 'z' : 'x'}-report.png`)}>🖨 {t('Печать / поделиться PNG')}</Button>
            <Button kind="secondary" onClick={z ? onClosed : () => setImg(null)}>{t('Готово')}</Button>
          </div>
        </div>
      </Modal>
    );
  }
  return (
    <Modal title={`${t('Смена')} №${session.shift.number}`} onClose={onClose}>
      <ErrorBox error={error} />
      {!rep ? <Spinner /> : (
        <div className="stack">
          <div className="grid grid-2">
            <div className="stat"><span className="label">{t('Чеков')}</span><span className="value">{rep.report.sales_count}</span></div>
            <div className="stat"><span className="label">{t('Выручка')}</span><span className="value"><Money value={rep.report.revenue} /></span></div>
            <div className="stat"><span className="label">{t('Наличные')}</span><span className="value"><Money value={rep.report.by_method.cash} /></span></div>
            <div className="stat"><span className="label">{t('Ожидается в ящике')}</span><span className="value"><Money value={rep.report.expected_cash} /></span></div>
          </div>
          {!z ? (
            <div className="row">
              <Button kind="secondary" onClick={() => show(rep, false)}>{t('X-отчёт')}</Button>
              <Button kind="danger" onClick={() => { setZ(true); setClosing(rep.report.expected_cash); }}>{t('Закрыть смену (Z)')}</Button>
            </div>
          ) : (
            <Form2 kind="danger" label={t('Закрыть смену')} onSubmit={async () => { const r = await post('/pos/shifts/z', { closing_cash: closing }); await show(r, true); }}>
              <MoneyInput label={t('Пересчитайте наличные в ящике')} value={closing} onChange={setClosing} big />
              <p className="small muted">{t('НДС с наличной выручки спишется с бизнес-счёта. После закрытия сдайте наличные операционисту (инкассация).')}</p>
            </Form2>
          )}
        </div>
      )}
    </Modal>
  );
}
