import { useEffect, useState } from 'react';
import { get, post } from '../shared/api.js';
import { t, tServer } from '../shared/i18n.js';
import { Topbar, DisclaimerBar, Money, PinPad, Scanner, Button, Input, QR, ErrorBox, Spinner, useChannel } from '../shared/ui.jsx';
import { PosLogo } from '../shared/brand.jsx';
import { parseCardScan } from '../shared/cards.jsx';
import { sound } from '../shared/sounds.js';
import { navigate } from '../shared/router.js';
import { applyShopColor } from './App.jsx';

const KEY = 'bln_terminal_code';

/** Терминал покупателя: второе устройство, сопряжённое с кассой по 6-значному коду. */
export function Terminal({ initialCode }) {
  const [code, setCode] = useState(() => {
    if (initialCode) return initialCode;
    try { return localStorage.getItem(KEY) || ''; } catch { return ''; }
  });
  const [joined, setJoined] = useState(null); // { shop }
  const [error, setError] = useState(null);
  const [cart, setCart] = useState(null);
  const [request, setRequest] = useState(null);
  const [qr, setQr] = useState(null);
  const [result, setResult] = useState(null);

  async function join(c) {
    setError(null);
    try {
      const r = await get(`/pos/terminal/${c}`);
      setJoined(r);
      applyShopColor(r.shop.color);
      if (r.pending) setRequest({ ...r.pending, items: [] });
      try { localStorage.setItem(KEY, c); } catch { /* ignore */ }
    } catch (e) {
      setError(e);
      try { localStorage.removeItem(KEY); } catch { /* ignore */ }
    }
  }

  useEffect(() => {
    if (code && code.length === 6) join(code);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useChannel(joined ? `terminal:${code}` : null, (m) => {
    if (m.type === 'cart') { setCart(m); if (!request) setResult(null); }
    if (m.type === 'pay_request') { setRequest(m); setQr(null); setResult(null); sound.beep(); }
    if (m.type === 'qr') { setQr(m); setRequest(null); setResult(null); }
    if (m.type === 'cancelled') { setRequest(null); setQr(null); }
    if (m.type === 'pay_result' && m.ok) {
      setResult({ ok: true, amount: m.amount });
      setRequest(null);
      setQr(null);
      sound.approve();
      setTimeout(() => setResult(null), 5000);
    }
    if (m.type === 'pay_result' && !m.ok && !m.retry) {
      setResult({ ok: false, message: m.message });
      setRequest(null);
      sound.decline();
      setTimeout(() => setResult(null), 5000);
    }
    if (m.type === 'closed') { setJoined(null); setCart(null); setRequest(null); try { localStorage.removeItem(KEY); } catch { /* ignore */ } }
  }, 'terminal');

  const shopBrand = joined ? <><PosLogo src={joined.shop.logo} color={joined.shop.color} /> <span>{joined.shop.name}</span></> : <><PosLogo /> <span>{t('Терминал')}</span></>;

  return (
    <>
      <Topbar brand={shopBrand} homeHref="#/terminal" />
      <div className="page narrow" style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
        {!joined ? (
          <div className="card stack">
            <h2 className="center">{t('Подключение к кассе')}</h2>
            <p className="center muted">{t('Введите 6-значный код с экрана кассы')}</p>
            <input className="input big mono" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus />
            <ErrorBox error={error} />
            <Button size="lg" disabled={code.length !== 6} onClick={() => join(code)}>{t('Подключить')}</Button>
            <Button kind="ghost" onClick={() => navigate('/')}>{t('Это касса, а не терминал')}</Button>
          </div>
        ) : result ? (
          <div className={`fullscreen-result ${result.ok ? 'approved' : 'declined'}`} onClick={() => setResult(null)}>
            <div className="fr-icon">{result.ok ? '✓' : '✕'}</div>
            <div className="fr-title">{result.ok ? t('Оплачено') : t('Отказано')}</div>
            {result.ok ? <div style={{ fontSize: '1.6rem' }}><Money value={result.amount} /></div> : <div style={{ fontSize: '1.2rem' }}>{tServer(result.message)}</div>}
          </div>
        ) : request ? (
          <CardEntry code={code} request={request} onDone={() => {}} />
        ) : qr ? (
          <div className="card stack center" style={{ alignItems: 'center' }}>
            <h2>{t('Оплата по QR')}</h2>
            <div style={{ fontSize: '2rem', fontWeight: 800 }}><Money value={qr.amount} /></div>
            <div style={{ background: '#fff', padding: 12, borderRadius: 12 }}><QR value={qr.url} size={240} /></div>
            <p className="muted">{t('Отсканируйте камерой телефона и подтвердите оплату во ВлодБанке')}</p>
          </div>
        ) : (
          <div className="card stack">
            <h2>{t('Ваш чек')}</h2>
            {!cart || !cart.lines.length ? <p className="muted center" style={{ padding: 30 }}>{t('Добро пожаловать!')}</p> : (
              <div className="list">
                {cart.lines.map((l, i) => (
                  <div key={i} className="list-item"><div className="li-main"><div className="li-title">{l.name}</div><div className="li-sub">{l.qty}</div></div><Money value={l.total} /></div>
                ))}
              </div>
            )}
            <div className="ct-big row" style={{ justifyContent: 'space-between', fontSize: '1.8rem', fontWeight: 800 }}><span>{t('Итого')}</span><Money value={cart?.total || 0} /></div>
          </div>
        )}
      </div>
      <DisclaimerBar />
    </>
  );
}

function CardEntry({ code, request }) {
  const [number, setNumber] = useState('');
  const [exp, setExp] = useState('');
  const [step, setStep] = useState('card');
  const [scan, setScan] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  async function pay(pin) {
    setBusy(true);
    setError(null);
    try {
      await post(`/pos/terminal/${code}/pay`, { request_id: request.request_id, number, exp, pin });
    } catch (e) {
      setError(e);
      if (e.code !== 'pin_wrong') setStep('card');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="card stack">
      {request.items?.length > 0 && (
        <div className="list small">
          {request.items.map((i, n) => <div key={n} className="list-item"><div className="li-main">{i.name}</div><Money value={i.total} /></div>)}
        </div>
      )}
      <div className="center">
        <div className="muted">{t('К оплате')}</div>
        <div style={{ fontSize: '2.2rem', fontWeight: 800 }}><Money value={request.amount} /></div>
      </div>
      {step === 'card' ? (
        <>
          <Button size="lg" onClick={() => setScan(true)}>📷 {t('Приложите карту (QR / штрихкод)')}</Button>
          <Input label={t('или введите номер карты')} inputMode="numeric" placeholder="7700 0000 0000" value={number} onChange={(e) => setNumber(e.target.value.replace(/[^\d ]/g, ''))} />
          <Input label={t('Срок ММ/ГГ')} placeholder="01/04" value={exp} onChange={(e) => setExp(e.target.value)} />
          <Button size="lg" disabled={number.replace(/\D/g, '').length !== 12} onClick={() => setStep('pin')}>{t('Далее')}</Button>
        </>
      ) : busy ? <Spinner /> : (
        <>
          <PinPad length={3} title={t('Введите PIN')} onComplete={pay} />
          <Button kind="ghost" onClick={() => setStep('card')}>{t('Назад')}</Button>
        </>
      )}
      <ErrorBox error={error} />
      {scan && <Scanner onClose={() => setScan(false)} onScan={(text) => { setScan(false); const n = parseCardScan(text); if (n) { setNumber(n); setStep('pin'); sound.beep(); } }} />}
    </div>
  );
}
