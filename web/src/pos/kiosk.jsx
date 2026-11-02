// Киоск самообслуживания без кассира: витрина, корзина, оплата только картой или
// по QR, чек и номер заказа. Выход — по PIN сотрудника, простой — возврат на витрину.
import { useEffect, useMemo, useRef, useState } from 'react';
import { get, post, onOffline } from '../shared/api.js';
import { t, tServer, locale } from '../shared/i18n.js';
import { Spinner, useAsync, useChannel, Money, PinPad, Modal, Empty, Button, Badge, useToast, OfflineScreen } from '../shared/ui.jsx';
import { PosLogo } from '../shared/brand.jsx';
import { sound } from '../shared/sounds.js';
import { formatMoney } from '@bln/shared/money.js';
import { renderThermal, receiptBlocks, shareCanvas } from '../shared/thermal.js';
import { onWsStatus, ensureSocket } from '../shared/ws.js';
import { navigate } from '../shared/router.js';
import { QTY, qtyLabel, lineSum, lineKey, linePrice, lineName, parseWeight } from './lib.js';
import { ItemOptionsModal } from './options.jsx';
import { SalePay } from './pay.jsx';

const IDLE_MS = 75_000;
const DONE_MS = 25_000;
const PAY_IDLE_MS = 120_000;

export function Kiosk({ session, onSession }) {
  const { data, loading, reload } = useAsync(() => get('/pos/products'), []);
  const [phase, setPhase] = useState('attract'); // attract | catalog | pay | done
  const [cart, setCart] = useState([]);
  const [sale, setSale] = useState(null);
  const [options, setOptions] = useState(null);
  const [weigh, setWeigh] = useState(null);
  const [locked, setLocked] = useState(false);
  const [cat, setCat] = useState('');
  const [search, setSearch] = useState('');
  const [wsUp, setWsUp] = useState(true);
  const [apiDown, setApiDown] = useState(false);
  const [lostAt, setLostAt] = useState(null);
  const [now, setNow] = useState(Date.now());
  const lastAction = useRef(Date.now());
  const saleRef = useRef(null);
  const toast = useToast();

  useEffect(() => { saleRef.current = sale; }, [sale]);

  useEffect(() => {
    ensureSocket();
    const off1 = onWsStatus((up) => { setWsUp(up); setLostAt(up ? null : Date.now()); });
    const off2 = onOffline(setApiDown);
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => { off1(); off2(); clearInterval(h); };
  }, []);

  // Возврат на витрину после простоя и после выдачи чека.
  useEffect(() => {
    const h = setInterval(() => {
      if (locked) return;
      if (phase === 'catalog' && Date.now() - lastAction.current > IDLE_MS) reset();
      if (phase === 'done' && Date.now() - lastAction.current > DONE_MS) reset();
      // Брошенную оплату отменяем, чтобы чек не остался открытым.
      if (phase === 'pay' && Date.now() - lastAction.current > PAY_IDLE_MS) {
        const open = saleRef.current;
        if (open?.id) post(`/pos/sales/${open.id}/cancel`).catch(() => {});
        setSale(null);
        setPhase('catalog');
        lastAction.current = Date.now();
      }
    }, 1000);
    return () => clearInterval(h);
  }, [phase, locked]);

  useChannel(`shop:${session.shop.id}`, (m) => {
    if (m.type === 'product_deleted' || m.type === 'product_restored') reload();
  });

  function touch() { lastAction.current = Date.now(); }

  function reset() {
    setCart([]);
    setSale(null);
    setPhase('attract');
    setCat('');
    setSearch('');
    setOptions(null);
    setWeigh(null);
  }

  const products = useMemo(() => (data?.products || []).filter((p) => !p.age_limit), [data]);
  const byId = useMemo(() => new Map(products.map((p) => [p.id, p])), [products]);
  const categories = useMemo(() => [...new Set(products.map((p) => p.category).filter(Boolean))], [products]);
  const shown = products.filter((p) => (!cat || p.category === cat) && (!search || p.name.toLowerCase().includes(search.toLowerCase()) || p.barcode === search));
  const payload = cart.map((l) => ({ product_id: l.product_id, qty_milli: l.qty_milli, variant_id: l.variant_id || undefined, modifier_ids: l.modifier_ids?.length ? l.modifier_ids : undefined }));
  const subtotal = cart.reduce((s, l) => {
    const p = byId.get(l.product_id);
    const v = p?.variants?.find((x) => x.id === l.variant_id);
    const mods = (p?.modifiers || []).filter((m) => l.modifier_ids?.includes(m.id));
    return s + (p ? lineSum(linePrice(p, v, mods), l.qty_milli) : 0);
  }, 0);


  // Чек оплачен — показываем номер заказа и через 25 секунд возвращаемся на витрину.
  useEffect(() => {
    if (phase === 'pay' && sale?.status === 'paid') {
      setPhase('done');
      touch();
      sound.approve();
      onSession();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sale?.status, phase]);

  const offline = apiDown || (!wsUp && lostAt && now - lostAt > 3000);
  if (offline) return <OfflineScreen />;
  if (loading && !data) return <div className="kiosk"><Spinner /></div>;

  function stockLeft(p) {
    if (!p.track_stock) return Infinity;
    return p.stock_milli - cart.filter((l) => l.product_id === p.id).reduce((s, l) => s + l.qty_milli, 0);
  }

  function pushLine(p, { variant_id = null, modifier_ids = [], qty_milli }) {
    if (stockLeft(p) < qty_milli) { toast(t('Нет в наличии: {name}', { name: p.name }), 'err'); sound.decline(); return false; }
    const key = lineKey(p.id, variant_id, modifier_ids);
    sound.beep();
    setCart((c) => {
      const i = c.findIndex((l) => l.key === key);
      if (i >= 0) return c.map((l, j) => (j === i ? { ...l, qty_milli: l.qty_milli + qty_milli } : l));
      return [...c, { key, product_id: p.id, variant_id, modifier_ids, qty_milli }];
    });
    touch();
    return true;
  }

  function pick(p) {
    if ((p.variants || []).some((v) => v.active !== false) || (p.modifiers || []).some((m) => m.active !== false)) setOptions(p);
    else if (p.unit === 'kg') setWeigh({ product: p, grams: '' });
    else pushLine(p, { qty_milli: QTY });
  }

  async function startPay() {
    touch();
    try {
      const r = await post('/pos/sales', { items: payload, source: 'kiosk' });
      setSale(r.sale);
      setPhase('pay');
      sound.approve();
    } catch (e) { toast(tServer(e.message), 'err'); sound.decline(); }
  }

  async function cancelPay() {
    if (sale?.id) await post(`/pos/sales/${sale.id}/cancel`).catch(() => {});
    setSale(null);
    setPhase('catalog');
    touch();
  }
  async function downloadReceipt() {
    try {
      const r = await get(`/pos/sales/${sale.id}/receipt`);
      const canvas = await renderThermal(receiptBlocks(r, t));
      await shareCanvas(canvas, `receipt-${r.sale.number}.png`);
    } catch (e) { toast(tServer(e.message), 'err'); }
  }

  return (
    <div className="kiosk" onClick={touch}>
      <div className="kiosk-head">
        <div className="kh-brand"><PosLogo src={session.shop.logo} color={session.shop.color} size={40} /> {session.shop.name}</div>
        <div className="kh-right">
          <Badge kind="warn">{t('Киоск самообслуживания')}</Badge>
          <span className="mono">{new Date(now).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}</span>
          <button className="btn ghost sm" onClick={(e) => { e.stopPropagation(); setLocked(true); }} title={t('Выход для сотрудника')}>🔒</button>
        </div>
      </div>
      {!session.shift ? (
        <div className="kiosk-attract">
          <h1>{t('Киоск не готов')}</h1>
          <p className="muted">{t('Откройте смену на кассе, чтобы киоск принимал оплату.')}</p>
          <Button onClick={() => navigate('/')}>{t('На кассу')}</Button>
        </div>
      ) : phase === 'attract' ? (
        <div className="kiosk-attract">
          <h1>{t('Добро пожаловать!')}</h1>
          <p style={{ fontSize: '1.15rem', maxWidth: 520 }}>{t('Выберите товары на экране и оплатите картой или по QR. Кассир не нужен.')}</p>
          <Button className="ka-btn" size="lg" kind="ok-btn" onClick={() => { touch(); setPhase('catalog'); }}>{t('Начать покупки')}</Button>
          <p className="small muted">{t('Товары 18+ продаются только на кассе с проверкой паспорта.')}</p>
        </div>
      ) : phase === 'catalog' ? (
        <div className="kiosk-body">
          <div className="kiosk-catalog">
            <div className="row nowrap">
              <input className="input" placeholder={t('Поиск или штрихкод')} value={search} onChange={(e) => { setSearch(e.target.value); touch(); }} />
            </div>
            {categories.length > 0 && (
              <div className="cats">
                <button className={!cat ? 'active' : ''} onClick={() => { setCat(''); touch(); }}>{t('Все')}</button>
                {categories.map((c) => <button key={c} className={cat === c ? 'active' : ''} onClick={() => { setCat(c); touch(); }}>{c}</button>)}
              </div>
            )}
            {!shown.length ? <Empty>{t('Ничего не найдено')}</Empty> : (
              <div className="tiles">
                {shown.map((p) => (
                  <button key={p.id} className={`tile${stockLeft(p) <= 0 ? ' out' : ''}`} onClick={() => pick(p)}>
                    <div className="t-img" style={p.photo ? { backgroundImage: `url(${p.photo})` } : undefined}>{!p.photo && (p.unit === 'kg' ? '⚖' : '🛒')}</div>
                    <span className="t-name">{p.name}</span>
                    <span className="t-price">{formatMoney(p.price)}{p.unit === 'kg' ? ` / ${t('кг')}` : ''}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="kiosk-cart">
            <div className="cart">
              {!cart.length ? <Empty>{t('Корзина пуста')}</Empty> : cart.map((l, i) => {
                const p = byId.get(l.product_id);
                if (!p) return null;
                const v = p.variants?.find((x) => x.id === l.variant_id);
                const mods = (p.modifiers || []).filter((m) => l.modifier_ids?.includes(m.id));
                return (
                  <div key={l.key} className="cart-line">
                    <span className="cl-name">{lineName(p, v, mods)}</span>
                    <span className="cl-sum"><Money value={lineSum(linePrice(p, v, mods), l.qty_milli)} /></span>
                    <span className="cl-qty">
                      {p.unit === 'pcs' ? (
                        <>
                          <button className="qty-btn" onClick={() => setCart((c) => (l.qty_milli <= QTY ? c.filter((_, j) => j !== i) : c.map((x, j) => (j === i ? { ...x, qty_milli: x.qty_milli - QTY } : x))))}>−</button>
                          {l.qty_milli / QTY}
                          <button className="qty-btn" disabled={stockLeft(p) < QTY} onClick={() => pushLine(p, { variant_id: l.variant_id, modifier_ids: l.modifier_ids, qty_milli: QTY })}>+</button>
                        </>
                      ) : qtyLabel('kg', l.qty_milli)}
                    </span>
                    <button className="btn ghost sm" onClick={() => setCart((c) => c.filter((_, j) => j !== i))}>✕</button>
                  </div>
                );
              })}
            </div>
            <div className="cart-total">
              <div className="ct-big"><span>{t('Итого')}</span><Money value={subtotal} /></div>
              <Button size="lg" block disabled={!cart.length} onClick={startPay}>{t('Оплатить картой')}</Button>
              <div className="row"><Button kind="ghost" size="sm" disabled={!cart.length} onClick={() => setCart([])}>{t('Очистить')}</Button></div>
            </div>
          </div>
        </div>
      ) : phase === 'pay' && sale ? (
        <div className="page medium" style={{ width: '100%' }}>
          <div className="card">
            <div className="card-head"><h2>{t('Оплата')}</h2><Badge kind="warn">{t('Киоск')}</Badge></div>
            <SalePay
              sale={sale}
              setSale={setSale}
              session={session}
              allowed={['card', 'qr']}
              onClose={cancelPay}
              onDone={() => { setPhase('done'); touch(); }}
            />
          </div>
        </div>
      ) : (
        <div className="kiosk-done">
          <div style={{ fontSize: '3rem' }}>✓</div>
          <h1 style={{ margin: 0 }}>{t('Оплачено')}</h1>
          {sale?.queue_no ? (
            <>
              <div className="small muted">{t('Номер вашего заказа')}</div>
              <div className="kd-no">{sale.queue_no}</div>
              <p>{t('Следите за табло очереди — номер появится, когда заказ будет готов.')}</p>
            </>
          ) : <p>{t('Спасибо за покупку!')}</p>}
          <div className="row">
            <Button kind="secondary" onClick={downloadReceipt}>🖨 {t('Скачать чек')}</Button>
            <Button kind="ok-btn" onClick={() => { touch(); reset(); }}>{t('Новый заказ')}</Button>
          </div>
        </div>
      )}

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
            <input className="input big" inputMode="decimal" autoFocus placeholder={t('Вес: граммы или кг через запятую')} value={weigh.grams} onChange={(e) => setWeigh({ ...weigh, grams: e.target.value })} />
            <p className="muted small">{formatMoney(weigh.product.price)} / {t('кг')}</p>
            <Button type="submit">{t('Добавить')}</Button>
          </form>
        </Modal>
      )}
      {locked && (
        <Modal title={t('Выход из киоска')} onClose={() => setLocked(false)}>
          <div className="stack">
            <p className="muted small">{t('Введите PIN сотрудника, чтобы вернуться на кассу.')}</p>
            <PinPad length={4} title={t('PIN сотрудника')} onComplete={async (pin) => {
              try {
                await post('/pos/kiosk/unlock', { pin });
                setLocked(false);
                navigate('/');
              } catch (e) {
                toast(tServer(e.message), 'err');
                sound.decline();
              }
            }} />
          </div>
        </Modal>
      )}
    </div>
  );
}
