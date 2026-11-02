// Оплата чека: наличные со сдачей по купюрам, карта на кассе, карта на терминале,
// QR из приложения банка, раздельная оплата и запись в долг. Используется кассой,
// столиками и киоском (там разрешены только карта и QR).
import { useEffect, useRef, useState } from 'react';
import { get, post, newIdemKey } from '../shared/api.js';
import { t, tServer } from '../shared/i18n.js';
import {
  Modal, Spinner, Money, MoneyInput, Input, Button, ActionButton, Field, Seg, PinPad, Scanner, QR, ErrorBox, useToast, useChannel,
} from '../shared/ui.jsx';
import { parseCardScan } from '../shared/cards.jsx';
import { sound } from '../shared/sounds.js';
import { renderThermal, receiptBlocks, shareCanvas } from '../shared/thermal.js';
import { changeBreakdown, denominationLabel, formatMoney, NOTES } from '@bln/shared/money.js';
import { qtyLabel, methodLabel } from './lib.js';

const ALL_METHODS = ['cash', 'card', 'terminal', 'qr', 'debt'];

/** Создание продажи из черновика корзины и переход к оплате. */
export function PayModal({ session, terminal, draft, onClose, onDone }) {
  const [sale, setSale] = useState(null);
  const [error, setError] = useState(null);
  const created = useRef(false);

  useEffect(() => {
    if (created.current) return;
    created.current = true;
    post('/pos/sales', {
      items: draft.items,
      discount: draft.discount || 0,
      promo_code: draft.promo_code || undefined,
      loyalty: draft.loyalty || undefined,
      redeem_points: draft.redeem_points || undefined,
    }).then((r) => setSale(r.sale)).catch(setError);
  }, [draft]);

  if (error) return <Modal title={t('Оплата')} onClose={onClose}><ErrorBox error={error} /></Modal>;
  if (!sale) return <Modal title={t('Оплата')} onClose={onClose}><Spinner /></Modal>;
  if (sale.status === 'paid') return <ReceiptModal saleId={sale.id} onDone={onDone} />;
  return (
    <Modal title={`${t('Оплата')} · ${formatMoney(sale.total + sale.tip)}`} onClose={() => cancelOrClose(session, sale, onClose)} wide>
      <SalePay sale={sale} setSale={setSale} session={session} terminal={terminal} onClose={() => cancelOrClose(session, sale, onClose)} onDone={onDone} />
    </Modal>
  );
}

/** Оплата уже созданного чека (счёт стола, повторная оплата остатка). */
export function SalePayModal({ session, terminal, saleId, onClose, onDone, allowed }) {
  const [sale, setSale] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { get(`/pos/sales/${saleId}`).then((r) => setSale(r.sale)).catch(setError); }, [saleId]);
  if (error) return <Modal title={t('Оплата')} onClose={onClose}><ErrorBox error={error} /></Modal>;
  if (!sale) return <Modal title={t('Оплата')} onClose={onClose}><Spinner /></Modal>;
  if (sale.status === 'paid') return <ReceiptModal saleId={sale.id} onDone={onDone} />;
  return (
    <Modal title={`${t('Оплата')} · ${formatMoney(sale.total + sale.tip)}`} onClose={() => cancelOrClose(session, sale, onClose)} wide>
      <SalePay sale={sale} setSale={setSale} session={session} terminal={terminal} allowed={allowed} onClose={() => cancelOrClose(session, sale, onClose)} onDone={onDone} />
    </Modal>
  );
}

async function cancelOrClose(session, sale, onClose) {
  if (sale.status === 'open' && Number(sale.paid) === 0) {
    try { await post(`/pos/sales/${sale.id}/cancel`); } catch { /* чек уже закрыт */ }
  }
  onClose();
}

/** Сама панель оплаты без модального окна. */
export function SalePay({ sale, setSale, session, terminal, onClose, onDone, allowed = ALL_METHODS }) {
  const [method, setMethod] = useState(null);
  const [part, setPart] = useState(null);
  const [declined, setDeclined] = useState(null);
  const toast = useToast();

  useChannel(`shop:${session.shop.id}`, async (m) => {
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

  if (sale.status === 'paid') return <ReceiptInline saleId={sale.id} onDone={onDone} />;

  const amount = part && part < sale.due ? part : sale.due;
  const needAge = sale.age_limit > 0 && !sale.age_checked;
  const goodsDue = Math.max(0, sale.total - sale.paid);
  const methods = ALL_METHODS.filter((m) => allowed.includes(m));
  const hasDebt = sale.payments.some((p) => p.method === 'debt');

  return (
    <div className="grid grid-2">
      <div className="stack">
        <div className="list small">
          {sale.items.map((i) => (
            <div key={i.id} className="list-item">
              <div className="li-main">{i.name} <span className="muted">{qtyLabel(i.unit, i.qty_milli)}</span></div>
              <Money value={i.total} />
            </div>
          ))}
        </div>
        {sale.promo_discount > 0 && <div className="row" style={{ justifyContent: 'space-between' }}><span>{t('Акции и промокод')}</span><span className="neg">−<Money value={sale.promo_discount} /></span></div>}
        {sale.manual_discount > 0 && <div className="row" style={{ justifyContent: 'space-between' }}><span>{t('Ручная скидка')}</span><span className="neg">−<Money value={sale.manual_discount} /></span></div>}
        {sale.points_used > 0 && <div className="row" style={{ justifyContent: 'space-between' }}><span>{t('Оплачено баллами')}</span><span className="neg">−<Money value={sale.points_used} /></span></div>}
        <div className="row" style={{ justifyContent: 'space-between' }}><span>{t('в т.ч. НДС')}</span><Money value={sale.vat} /></div>
        {sale.paid === 0 && (
          <Field label={t('Чаевые кассиру')}>
            <Seg value={sale.tip_pct} onChange={async (p) => setSale((await post(`/pos/sales/${sale.id}/tip`, { tip_pct: p })).sale)} options={[0, 5, 10, 15].map((p) => ({ value: p, label: `${p}%` }))} />
          </Field>
        )}
        {sale.tip > 0 && <div className="row" style={{ justifyContent: 'space-between' }}><span>{t('Чаевые')}</span><Money value={sale.tip} /></div>}
        {sale.payments.map((p) => (
          <div key={p.id} className="row small" style={{ justifyContent: 'space-between' }}>
            <span>✓ {methodLabel(p.method)}{p.method === 'debt' ? ` · ${t('в тетрадь долгов')}` : ''}</span>
            <Money value={p.amount} />
          </div>
        ))}
        <div className="ct-big row" style={{ justifyContent: 'space-between', fontSize: '1.5rem', fontWeight: 800 }}><span>{t('К оплате')}</span><Money value={sale.due} /></div>
        {hasDebt && sale.due > 0 && sale.due <= sale.tip && <div className="form-warn">{t('Товары записаны в долг. Осталось оплатить только чаевые.')}</div>}
      </div>
      <div className="stack">
        {needAge ? (
          <AgeCheck sale={sale} onOk={setSale} />
        ) : !method ? (
          <>
            <MoneyInput label={t('Сумма этой оплаты (для раздельной)')} value={part} onChange={setPart} hint={t('Пусто — вся сумма {sum}', { sum: formatMoney(sale.due) })} />
            {methods.includes('cash') && <Button size="lg" onClick={() => setMethod('cash')}>💵 {t('Наличные')}</Button>}
            {methods.includes('card') && <Button size="lg" onClick={() => setMethod('card')}>💳 {t('Карта — ввод на кассе')}</Button>}
            {methods.includes('terminal') && <Button size="lg" disabled={!terminal?.paired} onClick={() => setMethod('terminal')}>🖥 {t('Карта — на терминале')}</Button>}
            {methods.includes('qr') && <Button size="lg" onClick={() => setMethod('qr')}>▦ {t('QR из приложения банка')}</Button>}
            {methods.includes('debt') && goodsDue > 0 && (
              <Button size="lg" kind="secondary" onClick={() => setMethod('debt')}>📕 {t('В долг')}</Button>
            )}
            {methods.includes('debt') && goodsDue > 0 && (
              <p className="small muted">{t('Долг записывается в тетрадь магазина. Клиент ВлодБанка увидит его в приложении и сможет погасить переводом.')}</p>
            )}
            <Button kind="ghost" onClick={onClose}>{sale.paid ? t('Закрыть') : t('Отменить чек')}</Button>
          </>
        ) : method === 'cash' ? (
          <CashPay sale={sale} amount={amount} onBack={() => setMethod(null)} onPaid={(s) => { setSale(s); setMethod(null); setPart(null); }} />
        ) : method === 'card' ? (
          <CardPay sale={sale} amount={amount} onBack={() => setMethod(null)} onPaid={(s) => { setSale(s); setMethod(null); setPart(null); }} onDecline={setDeclined} />
        ) : method === 'terminal' ? (
          <TerminalPay sale={sale} amount={amount} code={terminal.code} onBack={() => setMethod(null)} onPaid={(s) => { setSale(s); setMethod(null); setPart(null); }} />
        ) : method === 'qr' ? (
          <QrPay sale={sale} amount={amount} terminal={terminal} onBack={() => setMethod(null)} />
        ) : (
          <DebtPay sale={sale} amount={goodsDue} onBack={() => setMethod(null)} onPaid={(s) => { setSale(s); setMethod(null); setPart(null); toast(t('Записано в долг'), 'ok'); }} />
        )}
      </div>
      {declined && <Declined reason={declined} onClose={() => setDeclined(null)} />}
    </div>
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
export function CardPay({ sale, amount, onBack, onPaid, onDecline }) {
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
      if (e.code === 'pin_wrong') { setError(e); sound.decline(); setStep('pin'); } else { onDecline(e.message); setStep('card'); }
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

/** Долг: имя должника и (если есть) карта или паспорт клиента ВлодБанка. */
function DebtPay({ sale, amount, onBack, onPaid }) {
  const [name, setName] = useState('');
  const [ref, setRef] = useState('');
  const [note, setNote] = useState('');
  const [error, setError] = useState(null);
  const toast = useToast();
  async function lookup() {
    setError(null);
    try {
      const r = await get(`/pos/loyalty/lookup?q=${encodeURIComponent(ref.trim())}`);
      setName(r.customer.name);
      toast(`${r.customer.name}: ${r.customer.points} ${t('баллов')}`, 'ok');
    } catch (e) { setError(e); }
  }
  return (
    <div className="stack">
      <div className="row" style={{ justifyContent: 'space-between' }}><span>{t('Записать в долг')}</span><b style={{ fontSize: '1.3rem' }}><Money value={amount} /></b></div>
      <div className="row nowrap">
        <input className="input" placeholder={t('Карта или паспорт клиента (необязательно)')} value={ref} onChange={(e) => setRef(e.target.value.toUpperCase())} />
        <button type="button" className="btn secondary" onClick={lookup}>{t('Найти')}</button>
      </div>
      <Input label={t('Кто должен')} value={name} onChange={(e) => setName(e.target.value)} hint={t('Имя и фамилия — так должник будет виден в тетради долгов.')} />
      <Input label={t('Комментарий')} value={note} onChange={(e) => setNote(e.target.value)} maxLength={200} />
      <ErrorBox error={error} />
      <div className="row">
        <Button kind="ghost" onClick={onBack}>{t('Назад')}</Button>
        <ActionButton
          className="grow"
          disabled={name.trim().length < 2}
          action={async () => {
            const r = await post(`/pos/sales/${sale.id}/pay`, { method: 'debt', amount, customer_name: name.trim(), customer: ref.trim() || undefined, note: note.trim() || undefined });
            onPaid(r.sale);
          }}
        >{t('Записать долг')}</ActionButton>
      </div>
      <p className="small muted">{t('Чаевые в долг не записываются. Если клиент — участник программы лояльности, долг появится у него во ВлодБанке.')}</p>
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

/** Чек на экране, PNG для термопринтера 58 мм и отправка на email. */
export function ReceiptModal({ saleId, onDone, title }) {
  return (
    <Modal title={title || t('Оплачено')} onClose={onDone} wide>
      <ReceiptInline saleId={saleId} onDone={onDone} />
    </Modal>
  );
}

export function ReceiptInline({ saleId, onDone }) {
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
    <div className="grid grid-2">
      <div>{img ? <div className="receipt-paper"><img src={img} alt={t('Чек')} /></div> : <Spinner />}</div>
      <div className="stack">
        {data && (
          <div className="form-ok" style={{ fontSize: '1.1rem' }}>
            ✓ {t('Чек')} №{data.sale.number} · <Money value={data.sale.total + data.sale.tip} />
            {data.sale.queue_no ? <div>{t('Номер заказа')}: <b>{data.sale.queue_no}</b></div> : null}
          </div>
        )}
        {data?.sale.payments.filter((p) => p.change_given).map((p) => (
          <div key={p.id} className="card" style={{ background: 'var(--surface-2)', boxShadow: 'none' }}>
            <b>{t('Сдача')}: <Money value={p.change_given} /></b>
            <div className="change-grid" style={{ marginTop: 6 }}>{changeBreakdown(p.change_given).map((d) => <span key={d.value} className={`note ${d.kind}`}>{denominationLabel(d.value)} × {d.count}</span>)}</div>
          </div>
        ))}
        {data?.sale.points_earned > 0 && <div className="small">{t('Начислено баллов за покупку')}: <b>{data.sale.points_earned}</b></div>}
        <Button disabled={!canvas} onClick={() => shareCanvas(canvas, `receipt-${data.sale.number}.png`)}>🖨 {t('Печать / поделиться PNG 58 мм')}</Button>
        <form className="row nowrap" onSubmit={async (e) => { e.preventDefault(); try { await post(`/pos/sales/${saleId}/email`, { email }); toast(t('Чек отправлен'), 'ok'); } catch (err) { toast(tServer(err.message), 'err'); } }}>
          <input className="input" type="email" placeholder={t('Email покупателя')} value={email} onChange={(e) => setEmail(e.target.value)} />
          <button className="btn secondary">{t('Отправить')}</button>
        </form>
        <Button size="lg" kind="ok-btn" onClick={onDone}>{t('Новый чек')}</Button>
      </div>
    </div>
  );
}
