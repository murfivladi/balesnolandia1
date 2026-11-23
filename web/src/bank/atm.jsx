import { useEffect, useState } from 'react';
import { post, newIdemKey } from '../shared/api.js';
import { t, tServer } from '../shared/i18n.js';
import { Topbar, Money, PinPad, Scanner, Button, MoneyInput } from '../shared/ui.jsx';
import { nativeHasPin, nativePin, nativeOfferPin } from '../shared/native.js';
import { parseCardScan } from '../shared/cards.jsx';
import { sound } from '../shared/sounds.js';
import { changeBreakdown, denominationLabel, formatMoney } from '@bln/shared/money.js';

const QUICK = [500, 1000, 2000, 5000, 10000, 20000];

/** Банкомат: карта + PIN → снять, внести, баланс. Работает без входа в кабинет. */
export function Atm({ brand }) {
  const [step, setStep] = useState('card');
  const [number, setNumber] = useState('');
  const [scan, setScan] = useState(false);
  const [session, setSession] = useState(null);
  const [error, setError] = useState(null);
  const [amount, setAmount] = useState(null);
  const [result, setResult] = useState(null);
  const [busy, setBusy] = useState(false);

  function reset() {
    setStep('card'); setNumber(''); setSession(null); setError(null); setAmount(null); setResult(null);
  }

  async function login(pin) {
    setBusy(true);
    setError(null);
    try {
      const s = await post('/bank/atm/session', { number, pin });
      nativeOfferPin(number, pin);
      setSession(s);
      setStep('menu');
      sound.approve();
    } catch (e) {
      setError(tServer(e.message));
      sound.decline();
    } finally {
      setBusy(false);
    }
  }

  async function op(kind, value) {
    setBusy(true);
    setError(null);
    try {
      const s = await post(`/bank/atm/${kind}`, { token: session.token, amount: value }, { idem: newIdemKey() });
      setSession({ ...session, ...s });
      setResult({ kind, amount: value });
      setStep('done');
      if (kind === 'withdraw') sound.drawer(); else sound.approve();
    } catch (e) {
      setError(tServer(e.message));
      sound.decline();
      if (e.status === 401) reset();
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Topbar brand={<>{brand} <span className="badge" style={{ background: 'rgba(255,255,255,.15)', color: 'inherit' }}>{t('Банкомат')}</span></>} homeHref="#/atm" right={<a className="tb-btn" href="#/">{t('Кабинет')}</a>} />
      <div className="page narrow">
        <div className="card stack" style={{ minHeight: 420 }}>
          {step === 'card' && (
            <>
              <h2 className="center">{t('Вставьте карту')}</h2>
              <p className="center muted">{t('Введите номер карты или отсканируйте QR / штрихкод с карты')}</p>
              <input className="input big mono" inputMode="numeric" placeholder="7700 0000 0000" value={number} onChange={(e) => setNumber(e.target.value.replace(/[^\d ]/g, ''))} />
              <div className="row">
                <Button block kind="secondary" onClick={() => setScan(true)}>📷 {t('Сканировать')}</Button>
                <Button block disabled={number.replace(/\D/g, '').length !== 12} onClick={() => setStep('pin')}>{t('Далее')}</Button>
              </div>
            </>
          )}
          {step === 'pin' && (
            <>
              <h2 className="center">{t('Введите PIN')}</h2>
              <p className="center mono muted">•••• {number.replace(/\D/g, '').slice(-4)}</p>
              <PinPad length={3} onComplete={login} disabled={busy} />
              <FaceIdPin number={number} onPin={login} disabled={busy} />
              {error && <div className="form-error">{error}</div>}
              <Button kind="ghost" onClick={reset}>{t('Вернуть карту')}</Button>
            </>
          )}
          {step === 'menu' && session && (
            <>
              <div className="center"><div className="muted">{session.holder} · •••• {session.last4}</div></div>
              <div className="grid grid-2">
                <Button size="lg" onClick={() => { setStep('withdraw'); setAmount(null); }}>{t('Снять наличные')}</Button>
                <Button size="lg" onClick={() => { setStep('deposit'); setAmount(null); }}>{t('Внести наличные')}</Button>
                <Button size="lg" kind="secondary" onClick={() => setStep('balance')}>{t('Баланс')}</Button>
                <Button size="lg" kind="ghost" onClick={reset}>{t('Забрать карту')}</Button>
              </div>
              {error && <div className="form-error">{error}</div>}
            </>
          )}
          {step === 'balance' && session && (
            <>
              <h2 className="center">{t('Доступно')}</h2>
              <div className="center" style={{ fontSize: '2.2rem', fontWeight: 800 }}><Money value={session.balance} /></div>
              <Button onClick={() => setStep('menu')}>{t('Назад')}</Button>
            </>
          )}
          {(step === 'withdraw' || step === 'deposit') && (
            <>
              <h2 className="center">{step === 'withdraw' ? t('Сумма снятия') : t('Сумма взноса')}</h2>
              {step === 'withdraw' && (
                <div className="grid grid-3">
                  {QUICK.map((v) => <Button key={v} kind="secondary" disabled={busy} onClick={() => op('withdraw', v)}>{formatMoney(v)}</Button>)}
                </div>
              )}
              <MoneyInput label={t('Другая сумма')} value={amount} onChange={setAmount} big hint={step === 'withdraw' ? t('Банкомат выдаёт купюры от 5 В') : t('Положите купюры и монеты в лоток')} />
              {error && <div className="form-error">{error}</div>}
              <div className="row">
                <Button kind="ghost" onClick={() => setStep('menu')}>{t('Назад')}</Button>
                <Button className="grow" busy={busy} disabled={!amount} onClick={() => op(step, amount)}>{t('Подтвердить')}</Button>
              </div>
            </>
          )}
          {step === 'done' && result && (
            <>
              <div className="center" style={{ fontSize: '3rem' }}>✓</div>
              <h2 className="center">{result.kind === 'withdraw' ? t('Заберите наличные') : t('Деньги зачислены')}</h2>
              <div className="center" style={{ fontSize: '1.8rem', fontWeight: 800 }}><Money value={result.amount} /></div>
              {result.kind === 'withdraw' && (
                <div className="change-grid" style={{ justifyContent: 'center' }}>
                  {changeBreakdown(result.amount).map((d) => <span key={d.value} className={`note ${d.kind}`}>{denominationLabel(d.value)} × {d.count}</span>)}
                </div>
              )}
              <div className="center muted">{t('Остаток')}: <Money value={session.balance} /></div>
              <div className="row">
                <Button block kind="secondary" onClick={() => setStep('menu')}>{t('Другая операция')}</Button>
                <Button block onClick={reset}>{t('Забрать карту')}</Button>
              </div>
            </>
          )}
        </div>
      </div>
      {scan && <Scanner onClose={() => setScan(false)} onScan={(text) => { const n = parseCardScan(text); setScan(false); if (n) { setNumber(n); setStep('pin'); sound.beep(); } }} />}
    </>
  );
}

/** ВлодБраузер для iOS: PIN карты сохранён в Keychain — вход в банкомат по Face ID. */
function FaceIdPin({ number, onPin, disabled }) {
  const [has, setHas] = useState(false);
  useEffect(() => {
    let alive = true;
    nativeHasPin(number).then((v) => { if (alive) setHas(v); });
    return () => { alive = false; };
  }, [number]);
  if (!has) return null;
  return <Button kind="secondary" disabled={disabled} onClick={async () => { const p = await nativePin(number); if (p) onPin(p); }}>{t('PIN по Face ID')}</Button>;
}
