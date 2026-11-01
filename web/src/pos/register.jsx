import { useEffect, useMemo, useRef, useState } from 'react';
import { get, post, newIdemKey, appUrl } from '../shared/api.js';
import { t, tServer } from '../shared/i18n.js';
import {
  Spinner, useAsync, useChannel, Money, MoneyInput, Input, Modal, Empty, Button, ActionButton, Seg, PinPad, Scanner, QR, ErrorBox, useToast, Badge, Field,
} from '../shared/ui.jsx';
import { parseCardScan } from '../shared/cards.jsx';
import { sound } from '../shared/sounds.js';
import { renderThermal, receiptBlocks, reportBlocks, shareCanvas } from '../shared/thermal.js';
import { changeBreakdown, denominationLabel, formatMoney, NOTES } from '@bln/shared/money.js';

const QTY = 1000;
const qtyLabel = (unit, q) => (unit === 'kg' ? `${(q / 1000).toFixed(3).replace('.', ',')} ${t('кг')}` : `${q / 1000} ${t('шт')}`);
const lineSum = (p, q) => Math.round((p.price * q) / QTY);

export function Register({ session, onSession }) {
  const { data, reload: reloadProducts } = useAsync(() => get('/pos/products'), []);
  const [cart, setCart] = useState([]);
  const [discount, setDiscount] = useState(0);
  const [cat, setCat] = useState('');
  const [search, setSearch] = useState('');
  const [scan, setScan] = useState(false);
  const [weigh, setWeigh] = useState(null);
  const [modal, setModal] = useState(null);
  const [terminal, setTerminal] = useState(null); // { code, paired }
  const toast = useToast();
  const searchRef = useRef(null);

  const products = useMemo(() => data?.products || [], [data]);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const categories = useMemo(() => [...new Set(products.map((p) => p.category).filter(Boolean))], [products]);
  const shown = products.filter((p) => (!cat || p.category === cat) && (!search || p.name.toLowerCase().includes(search.toLowerCase()) || p.barcode === search));
  const subtotal = cart.reduce((s, l) => s + lineSum(byId.get(l.product_id) || { price: 0 }, l.qty_milli), 0);
  const total = Math.max(0, subtotal - discount);

  useChannel(`shop:${session.shop.id}`, (m) => {
    if (m.type === 'sale_paid') reloadProducts();
  });

  // Показ корзины на терминале покупателя.
  useEffect(() => {
    if (!terminal?.paired) return undefined;
    const h = setTimeout(() => {
      post(`/pos/terminals/${terminal.code}/display`, {
        lines: cart.map((l) => { const p = byId.get(l.product_id); return { name: p?.name, qty: qtyLabel(p?.unit, l.qty_milli), total: lineSum(p, l.qty_milli) }; }),
        total,
      }).catch(() => {});
    }, 200);
    return () => clearTimeout(h);
  }, [cart, total, terminal, byId]);

  function stockLeft(p) {
    if (!p.track_stock) return Infinity;
    const inCart = cart.filter((l) => l.product_id === p.id).reduce((s, l) => s + l.qty_milli, 0);
    return p.stock_milli - inCart;
  }

  function add(p, qty = QTY) {
    if (stockLeft(p) < qty) {
      toast(t('Нет в наличии: {name}', { name: p.name }), 'err');
      sound.decline();
      return;
    }
    sound.beep();
    setCart((c) => {
      const i = c.findIndex((l) => l.product_id === p.id);
      if (i >= 0 && p.unit === 'pcs') return c.map((l, j) => (j === i ? { ...l, qty_milli: l.qty_milli + qty } : l));
      return [...c, { product_id: p.id, qty_milli: qty }];
    });
  }

  function pick(p) {
    if (p.unit === 'kg') setWeigh({ product: p, grams: '' });
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
    setCart((c) => {
      const l = c[i];
      const p = byId.get(l.product_id);
      const q = l.qty_milli + delta * QTY;
      if (q <= 0) {
        post('/pos/log', { action: 'remove_item', data: { name: p?.name, qty_milli: l.qty_milli } }).catch(() => {});
        return c.filter((_, j) => j !== i);
      }
      if (delta > 0 && stockLeft(p) < QTY) return c;
      return c.map((x, j) => (j === i ? { ...x, qty_milli: q } : x));
    });
  }

  function remove(i) {
    const l = cart[i];
    post('/pos/log', { action: 'remove_item', data: { name: byId.get(l.product_id)?.name, qty_milli: l.qty_milli } }).catch(() => {});
    setCart((c) => c.filter((_, j) => j !== i));
  }

  function clear() {
    if (cart.length) post('/pos/log', { action: 'clear_cart', data: { lines: cart.length, total } }).catch(() => {});
    setCart([]);
    setDiscount(0);
  }

  async function hold() {
    const label = window.prompt(t('Метка отложенного чека (необязательно)')) ?? null;
    if (label === null) return;
    await post('/pos/held', { items: cart, label });
    setCart([]);
    setDiscount(0);
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
          <Button kind="secondary" size="sm" onClick={() => setModal('age')}>{t('Проверка паспорта')}</Button>
          <Button kind="secondary" size="sm" onClick={openDrawer}>{t('Ящик')}</Button>
          <Button kind="secondary" size="sm" onClick={() => setModal('shift')}>{t('Смена')}</Button>
        </div>
      </div>
      <div className="pos-right">
        <div className="cart">
          {!cart.length ? <Empty>{t('Чек пуст. Выберите товар или отсканируйте штрихкод.')}</Empty> : cart.map((l, i) => {
            const p = byId.get(l.product_id);
            if (!p) return null;
            return (
              <div key={i} className="cart-line">
                <span className="cl-name">{p.name} {p.age_limit > 0 && <Badge kind="err">{p.age_limit}+</Badge>}</span>
                <span className="cl-sum"><Money value={lineSum(p, l.qty_milli)} /></span>
                <span className="cl-qty">
                  {p.unit === 'pcs' ? (
                    <>
                      <button className="qty-btn" onClick={() => changeQty(i, -1)}>−</button>
                      {l.qty_milli / QTY}
                      <button className="qty-btn" onClick={() => changeQty(i, 1)}>+</button>
                    </>
                  ) : qtyLabel('kg', l.qty_milli)}
                  × {formatMoney(p.price)}
                </span>
                <button className="btn ghost sm" style={{ justifySelf: 'end' }} onClick={() => remove(i)} aria-label={t('Удалить')}>✕</button>
              </div>
            );
          })}
        </div>
        <div className="cart-total">
          {discount > 0 && <div className="row" style={{ justifyContent: 'space-between' }}><span>{t('Скидка')}</span><span>−<Money value={discount} /></span></div>}
          <div className="ct-big"><span>{t('Итого')}</span><Money value={total} /></div>
          <div className="row nowrap">
            <Button kind="ghost" size="sm" disabled={!cart.length} onClick={() => setModal('discount')}>%</Button>
            <Button kind="ghost" size="sm" disabled={!cart.length} onClick={hold}>{t('Отложить')}</Button>
            <Button kind="ghost" size="sm" disabled={!cart.length} onClick={clear}>{t('Очистить')}</Button>
          </div>
          <Button size="lg" block disabled={!cart.length} onClick={() => setModal('pay')}>{t('Оплата')} (F9)</Button>
        </div>
      </div>

      {scan && <Scanner onScan={onScanText} onClose={() => setScan(false)} />}
      {weigh && (
        <Modal title={weigh.product.name} onClose={() => setWeigh(null)}>
          <form className="stack" onSubmit={(e) => { e.preventDefault(); const g = Math.round(Number(String(weigh.grams).replace(',', '.')) * (String(weigh.grams).includes(',') || String(weigh.grams).includes('.') ? 1000 : 1)); if (g > 0) { add(weigh.product, g); setWeigh(null); } }}>
            <Input label={t('Вес: граммы или кг через запятую')} autoFocus inputMode="decimal" value={weigh.grams} onChange={(e) => setWeigh({ ...weigh, grams: e.target.value })} />
            <p className="muted small">{formatMoney(weigh.product.price)} / {t('кг')}</p>
            <Button type="submit">{t('Добавить')}</Button>
          </form>
        </Modal>
      )}
      {modal === 'discount' && <DiscountModal subtotal={subtotal} value={discount} onClose={() => setModal(null)} onSet={(v) => { setDiscount(v); setModal(null); }} />}
      {modal === 'pay' && (
        <PayModal
          session={session}
          cart={cart}
          discount={discount}
          terminal={terminal}
          onClose={() => setModal(null)}
          onDone={() => { setCart([]); setDiscount(0); setModal(null); reloadProducts(); }}
        />
      )}
      {modal === 'terminal' && <TerminalModal terminal={terminal} setTerminal={setTerminal} onClose={() => setModal(null)} />}
      {modal === 'held' && <HeldModal onClose={() => setModal(null)} onResume={(items) => { setCart(items); setModal(null); onSession(); }} />}
      {modal === 'refund' && <RefundModal onClose={() => setModal(null)} />}
      {modal === 'invoice' && <InvoiceModal onClose={() => setModal(null)} />}
      {modal === 'age' && <AgeLookup onClose={() => setModal(null)} />}
      {modal === 'shift' && <ShiftModal session={session} onClose={() => setModal(null)} onClosed={() => { setModal(null); onSession(); }} />}
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

function DiscountModal({ subtotal, value, onClose, onSet }) {
  const [mode, setMode] = useState('pct');
  const [pct, setPct] = useState(10);
  const [amount, setAmount] = useState(value || null);
  const result = mode === 'pct' ? Math.round((subtotal * pct) / 100) : Math.min(amount || 0, subtotal);
  return (
    <Modal title={t('Скидка')} onClose={onClose}>
      <div className="stack">
        <Seg value={mode} onChange={setMode} options={[{ value: 'pct', label: '%' }, { value: 'sum', label: t('Сумма') }]} />
        {mode === 'pct' ? (
          <div className="row">{[5, 10, 15, 20, 25, 50].map((p) => <Button key={p} kind={pct === p ? '' : 'secondary'} onClick={() => setPct(p)}>{p}%</Button>)}</div>
        ) : <MoneyInput label={t('Сумма скидки')} value={amount} onChange={setAmount} />}
        <div className="row" style={{ justifyContent: 'space-between' }}><span>{t('Скидка')}</span><b><Money value={result} /></b></div>
        <div className="row">
          <Button kind="ghost" onClick={() => onSet(0)}>{t('Убрать скидку')}</Button>
          <Button className="grow" onClick={() => onSet(result)}>{t('Применить')}</Button>
        </div>
        <p className="small muted">{t('Скидка записывается в журнал кассы.')}</p>
      </div>
    </Modal>
  );
}

/** Оплата: чаевые → проверка возраста → способ оплаты (можно несколько раз) → чек. */
function PayModal({ session, cart, discount, terminal, onClose, onDone }) {
  const [sale, setSale] = useState(null);
  const [error, setError] = useState(null);
  const [method, setMethod] = useState(null);
  const [part, setPart] = useState(null);
  const [declined, setDeclined] = useState(null);
  const created = useRef(false);
  const toast = useToast();

  useEffect(() => {
    if (created.current) return;
    created.current = true;
    post('/pos/sales', { items: cart, discount }).then((r) => setSale(r.sale)).catch(setError);
  }, [cart, discount]);

  useChannel(`shop:${session.shop.id}`, async (m) => {
    if (!sale) return;
    if ((m.type === 'qr_paid' || m.type === 'sale_paid') && m.sale_id === sale.id) {
      const r = await get(`/pos/sales/${sale.id}`);
      setSale(r.sale);
      if (m.type === 'qr_paid') { sound.approve(); setMethod(null); }
    }
    if (m.type === 'pay_declined' && m.sale_id === sale.id) {
      sound.decline();
      setDeclined(m.reason);
    }
  });

  async function cancel() {
    if (sale && sale.status === 'open' && sale.paid === 0) {
      try { await post(`/pos/sales/${sale.id}/cancel`); } catch { /* ignore */ }
    }
    if (sale && sale.paid > 0 && sale.status === 'open') {
      toast(t('По чеку уже есть оплата — доведите оплату до конца'), 'err');
      return;
    }
    onClose();
  }

  if (error) return <Modal title={t('Оплата')} onClose={onClose}><ErrorBox error={error} /></Modal>;
  if (!sale) return <Modal title={t('Оплата')} onClose={onClose}><Spinner /></Modal>;
  if (sale.status === 'paid') return <ReceiptModal saleId={sale.id} onDone={onDone} />;

  const amount = part && part < sale.due ? part : sale.due;
  const needAge = sale.age_limit > 0 && !sale.age_checked;

  return (
    <Modal title={`${t('Оплата')} · ${formatMoney(sale.total + sale.tip)}`} onClose={cancel} wide>
      <div className="grid grid-2">
        <div className="stack">
          <div className="list small">
            {sale.items.map((i) => (
              <div key={i.id} className="list-item"><div className="li-main">{i.name} <span className="muted">{qtyLabel(i.unit, i.qty_milli)}</span></div><Money value={i.total} /></div>
            ))}
          </div>
          {sale.discount > 0 && <div className="row" style={{ justifyContent: 'space-between' }}><span>{t('Скидка')}</span><span>−<Money value={sale.discount} /></span></div>}
          <div className="row" style={{ justifyContent: 'space-between' }}><span>{t('в т.ч. НДС')}</span><Money value={sale.vat} /></div>
          {sale.paid === 0 && (
            <Field label={t('Чаевые кассиру')}>
              <Seg value={sale.tip_pct} onChange={async (p) => setSale((await post(`/pos/sales/${sale.id}/tip`, { tip_pct: p })).sale)} options={[0, 5, 10, 15].map((p) => ({ value: p, label: `${p}%` }))} />
            </Field>
          )}
          {sale.tip > 0 && <div className="row" style={{ justifyContent: 'space-between' }}><span>{t('Чаевые')}</span><Money value={sale.tip} /></div>}
          {sale.payments.map((p) => (
            <div key={p.id} className="row small" style={{ justifyContent: 'space-between' }}><span>✓ {t({ cash: 'Наличные', card: 'Карта', qr: 'QR-оплата' }[p.method])}</span><Money value={p.amount} /></div>
          ))}
          <div className="ct-big row" style={{ justifyContent: 'space-between', fontSize: '1.5rem', fontWeight: 800 }}><span>{t('К оплате')}</span><Money value={sale.due} /></div>
        </div>
        <div className="stack">
          {needAge ? <AgeCheck sale={sale} onOk={setSale} /> : !method ? (
            <>
              <MoneyInput label={t('Сумма этой оплаты (для раздельной)')} value={part} onChange={setPart} hint={t('Пусто — вся сумма {sum}', { sum: formatMoney(sale.due) })} />
              <Button size="lg" onClick={() => setMethod('cash')}>💵 {t('Наличные')}</Button>
              <Button size="lg" onClick={() => setMethod('card')}>💳 {t('Карта — ввод на кассе')}</Button>
              <Button size="lg" disabled={!terminal?.paired} onClick={() => setMethod('terminal')}>🖥 {t('Карта — на терминале')}</Button>
              <Button size="lg" onClick={() => setMethod('qr')}>▦ {t('QR из приложения банка')}</Button>
              <Button kind="ghost" onClick={cancel}>{sale.paid ? t('Закрыть') : t('Отменить чек')}</Button>
            </>
          ) : method === 'cash' ? (
            <CashPay sale={sale} amount={amount} onBack={() => setMethod(null)} onPaid={(s) => { setSale(s); setMethod(null); setPart(null); }} />
          ) : method === 'card' ? (
            <CardPay sale={sale} amount={amount} onBack={() => setMethod(null)} onPaid={(s) => { setSale(s); setMethod(null); setPart(null); }} onDecline={setDeclined} />
          ) : method === 'terminal' ? (
            <TerminalPay sale={sale} amount={amount} code={terminal.code} onBack={() => setMethod(null)} onPaid={(s) => { setSale(s); setMethod(null); setPart(null); }} />
          ) : (
            <QrPay sale={sale} amount={amount} terminal={terminal} onBack={() => setMethod(null)} />
          )}
        </div>
      </div>
      {declined && <Declined reason={declined} onClose={() => setDeclined(null)} />}
    </Modal>
  );
}

export function Declined({ reason, onClose }) {
  useEffect(() => {
    const h = setTimeout(onClose, 4000);
    return () => clearTimeout(h);
  }, [onClose]);
  return (
    <div className="fullscreen-result declined" onClick={onClose} role="alert">
      <div className="fr-icon">✕</div>
      <div className="fr-title">{t('Отказано')}</div>
      <div style={{ fontSize: '1.2rem' }}>{tServer(reason)}</div>
    </div>
  );
}

function AgeCheck({ sale, onOk }) {
  const [scan, setScan] = useState(false);
  const [no, setNo] = useState('');
  const [error, setError] = useState(null);
  const [who, setWho] = useState(null);
  async function check(body) {
    setError(null);
    try {
      const r = await post(`/pos/sales/${sale.id}/age`, body);
      setWho(r.customer);
      sound.approve();
      setTimeout(() => onOk(r.sale), 900);
    } catch (e) {
      setError(e);
      sound.decline();
    }
  }
  return (
    <div className="stack">
      <div className="form-warn"><b>{sale.age_limit}+</b> — {t('проверьте паспорт БФ покупателя')}</div>
      <Button size="lg" onClick={() => setScan(true)}>📷 {t('Сканировать QR паспорта')}</Button>
      <form className="row nowrap" onSubmit={(e) => { e.preventDefault(); check({ passport_no: no }); }}>
        <input className="input" placeholder="BLN-0000-0000" value={no} onChange={(e) => setNo(e.target.value.toUpperCase())} />
        <button className="btn secondary">{t('Проверить')}</button>
      </form>
      {who && <div className="form-ok">✓ {who.full_name}, {who.age}</div>}
      <ErrorBox error={error} />
      {scan && <Scanner onClose={() => setScan(false)} onScan={(text) => { setScan(false); check({ code: text }); }} />}
    </div>
  );
}

function CashPay({ sale, amount, onBack, onPaid }) {
  const [given, setGiven] = useState(amount);
  const [idem] = useState(newIdemKey);
  const change = (given || 0) - amount;
  const quick = [amount, ...NOTES.filter((n) => n > amount).slice(0, 4)];
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}><span>{t('К оплате наличными')}</span><b style={{ fontSize: '1.3rem' }}><Money value={amount} /></b></div>
      <MoneyInput label={t('Получено от покупателя')} value={given} onChange={setGiven} big autoFocus />
      <div className="row">{quick.map((v) => <Button key={v} size="sm" kind="secondary" onClick={() => setGiven(v)}>{formatMoney(v)}</Button>)}</div>
      {change >= 0 ? (
        <div className="card" style={{ background: 'var(--surface-2)', boxShadow: 'none' }}>
          <div className="row" style={{ justifyContent: 'space-between' }}><b>{t('Сдача')}</b><b style={{ fontSize: '1.4rem' }}><Money value={change} /></b></div>
          <div className="change-grid" style={{ marginTop: 8 }}>
            {changeBreakdown(change).map((d) => <span key={d.value} className={`note ${d.kind}`}>{denominationLabel(d.value)} × {d.count}</span>)}
          </div>
        </div>
      ) : <div className="form-error">{t('Получено меньше суммы')}</div>}
      <div className="row">
        <Button kind="ghost" onClick={onBack}>{t('Назад')}</Button>
        <ActionButton className="grow" kind="ok-btn" disabled={change < 0} action={async () => {
          const r = await post(`/pos/sales/${sale.id}/pay`, { method: 'cash', amount, cash_given: given }, { idem });
          sound.drawer();
          onPaid(r.sale);
        }}>{t('Принять наличные')}</ActionButton>
      </div>
    </div>
  );
}

/** Оплата картой на экране кассы: экран можно перевернуть к покупателю. */
function CardPay({ sale, amount, onBack, onPaid, onDecline }) {
  const [flip, setFlip] = useState(false);
  const [number, setNumber] = useState('');
  const [exp, setExp] = useState('');
  const [step, setStep] = useState('card');
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [idem] = useState(newIdemKey);
  async function pay(pin) {
    setBusy(true);
    setError(null);
    try {
      const r = await post(`/pos/sales/${sale.id}/pay`, { method: 'card', amount, number, exp, pin }, { idem });
      sound.approve();
      onPaid(r.sale);
    } catch (e) {
      if (e.code === 'pin_wrong') { setError(e); sound.decline(); } else { onDecline(e.message); setStep('card'); }
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className={`stack${flip ? ' flip' : ''}`}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b style={{ fontSize: '1.3rem' }}><Money value={amount} /></b>
        <Button size="sm" kind="secondary" onClick={() => setFlip(!flip)}>⟲ {flip ? t('К кассиру') : t('К покупателю')}</Button>
      </div>
      {step === 'card' ? (
        <>
          <Input label={t('Номер карты')} inputMode="numeric" placeholder="7700 0000 0000" value={number} onChange={(e) => setNumber(e.target.value.replace(/[^\d ]/g, ''))} />
          <Input label={t('Срок ММ/ГГ')} placeholder="01/04" value={exp} onChange={(e) => setExp(e.target.value)} />
          <div className="row">
            <Button kind="secondary" onClick={() => setScan(true)}>📷 {t('QR / штрихкод карты')}</Button>
            <Button className="grow" disabled={number.replace(/\D/g, '').length !== 12} onClick={() => setStep('pin')}>{t('Далее')}</Button>
          </div>
          <Button kind="ghost" onClick={onBack}>{t('Назад')}</Button>
        </>
      ) : (
        <>
          <PinPad length={3} title={t('Покупатель вводит PIN')} onComplete={pay} disabled={busy} />
          <ErrorBox error={error} />
          <Button kind="ghost" onClick={() => setStep('card')}>{t('Назад')}</Button>
        </>
      )}
      {scan && <Scanner onClose={() => setScan(false)} onScan={(text) => { setScan(false); const n = parseCardScan(text); if (n) { setNumber(n); setStep('pin'); sound.beep(); } }} />}
    </div>
  );
}

function TerminalPay({ sale, amount, code, onBack, onPaid }) {
  const [state, setState] = useState('sending');
  const [error, setError] = useState(null);
  useEffect(() => {
    post(`/pos/terminals/${code}/request`, { sale_id: sale.id, amount }).then(() => setState('waiting')).catch((e) => { setError(e); setState('error'); });
  }, [code, sale.id, amount]);
  useChannel(`terminal:${code}`, async (m) => {
    if (m.type === 'pay_result') {
      if (m.ok) {
        sound.approve();
        const r = await get(`/pos/sales/${sale.id}`);
        onPaid(r.sale);
      } else if (!m.retry) {
        setError(m.message);
        setState('declined');
      }
    }
  });
  return (
    <div className="stack center" style={{ alignItems: 'center' }}>
      <div style={{ fontSize: '3rem' }}>🖥</div>
      <b style={{ fontSize: '1.4rem' }}><Money value={amount} /></b>
      {state === 'waiting' && <><p>{t('Покупатель оплачивает на терминале…')}</p><Spinner /></>}
      <ErrorBox error={error} />
      <Button kind="ghost" onClick={async () => { await post(`/pos/terminals/${code}/cancel`).catch(() => {}); onBack(); }}>{t('Отменить')}</Button>
    </div>
  );
}

function QrPay({ sale, amount, terminal, onBack }) {
  const [qr, setQr] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    post(`/pos/sales/${sale.id}/qr`, { amount, terminal_code: terminal?.paired ? terminal.code : undefined }).then(setQr).catch(setError);
  }, [sale.id, amount, terminal]);
  return (
    <div className="stack center" style={{ alignItems: 'center' }}>
      <ErrorBox error={error} />
      {qr ? (
        <>
          <div style={{ background: '#fff', padding: 10, borderRadius: 12 }}><QR value={qr.url} size={220} /></div>
          <p>{t('Покупатель сканирует QR камерой телефона и подтверждает оплату во ВлодБанке.')}</p>
          <b><Money value={qr.amount} /></b>
          <Spinner />
        </>
      ) : !error && <Spinner />}
      <Button kind="ghost" onClick={onBack}>{t('Назад')}</Button>
    </div>
  );
}

export function ReceiptModal({ saleId, onDone, title }) {
  const [img, setImg] = useState(null);
  const [canvas, setCanvas] = useState(null);
  const [data, setData] = useState(null);
  const [email, setEmail] = useState('');
  const toast = useToast();
  useEffect(() => {
    (async () => {
      const r = await get(`/pos/sales/${saleId}/receipt`);
      setData(r);
      const c = await renderThermal(receiptBlocks(r, t));
      setCanvas(c);
      setImg(c.toDataURL('image/png'));
    })().catch((e) => toast(e.message, 'err'));
  }, [saleId, toast]);
  return (
    <Modal title={title || t('Оплачено')} onClose={onDone} wide>
      <div className="grid grid-2">
        <div>{img ? <div className="receipt-paper"><img src={img} alt={t('Чек')} /></div> : <Spinner />}</div>
        <div className="stack">
          {data && <div className="form-ok" style={{ fontSize: '1.1rem' }}>✓ {t('Чек')} №{data.sale.number} · <Money value={data.sale.total + data.sale.tip} /></div>}
          {data?.sale.payments.filter((p) => p.change_given).map((p) => (
            <div key={p.id} className="card" style={{ background: 'var(--surface-2)', boxShadow: 'none' }}>
              <b>{t('Сдача')}: <Money value={p.change_given} /></b>
              <div className="change-grid" style={{ marginTop: 6 }}>{changeBreakdown(p.change_given).map((d) => <span key={d.value} className={`note ${d.kind}`}>{denominationLabel(d.value)} × {d.count}</span>)}</div>
            </div>
          ))}
          <Button disabled={!canvas} onClick={() => shareCanvas(canvas, `receipt-${data.sale.number}.png`)}>🖨 {t('Печать / поделиться PNG 58 мм')}</Button>
          <form className="row nowrap" onSubmit={async (e) => { e.preventDefault(); try { await post(`/pos/sales/${saleId}/email`, { email }); toast(t('Чек отправлен'), 'ok'); } catch (err) { toast(tServer(err.message), 'err'); } }}>
            <input className="input" type="email" placeholder={t('Email покупателя')} value={email} onChange={(e) => setEmail(e.target.value)} />
            <button className="btn secondary">{t('Отправить')}</button>
          </form>
          <Button size="lg" kind="ok-btn" onClick={onDone}>{t('Новый чек')}</Button>
        </div>
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
  const [idem] = useState(newIdemKey);
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
            <div className="small muted">{t('Чек')} №{data.sale.number} · <Money value={data.sale.total} /> · {data.sale.payments.map((p) => t({ cash: 'Наличные', card: 'Карта', qr: 'QR-оплата' }[p.method])).join(' + ')}{data.sale.refunded ? ` · ${t('уже возвращено')} ${formatMoney(data.sale.refunded)}` : ''}</div>
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
  const [idem] = useState(newIdemKey);
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
