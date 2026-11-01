import { useCallback, useEffect, useRef, useState, createContext, useContext } from 'react';
import QRCode from 'qrcode';
import JsBarcode from 'jsbarcode';
import { t, tServer, useLang, setLang } from './i18n.js';
import { applyTheme, initialTheme } from './theme.js';
import { formatMoney, parseMoney } from '@bln/shared/money.js';
import { subscribe } from './ws.js';

export const DISCLAIMER = 'Игровой сервис. Не является банком, госорганом, платёжным средством или удостоверением личности.';

// ——— Хуки ———

/** Загрузка данных: { data, error, loading, reload, setData } */
export function useAsync(fn, deps = []) {
  const [state, setState] = useState({ data: null, error: null, loading: true });
  const seq = useRef(0);
  const run = useCallback(async () => {
    const n = ++seq.current;
    setState((s) => ({ ...s, loading: true, error: null }));
    try {
      const data = await fn();
      if (n === seq.current) setState({ data, error: null, loading: false });
    } catch (error) {
      if (n === seq.current) setState((s) => ({ ...s, error, loading: false }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => { run(); }, [run]);
  return { ...state, reload: run, setData: (d) => setState((s) => ({ ...s, data: typeof d === 'function' ? d(s.data) : d })) };
}

/** Подписка на канал WebSocket на время жизни компонента. */
export function useChannel(channel, handler, role) {
  const ref = useRef(handler);
  ref.current = handler;
  useEffect(() => {
    if (!channel) return undefined;
    return subscribe(channel, (m) => ref.current(m), role);
  }, [channel, role]);
}

/** Автовыход после бездействия. */
export function useIdle(minutes, onIdle, enabled = true) {
  const cb = useRef(onIdle);
  cb.current = onIdle;
  useEffect(() => {
    if (!enabled || !minutes) return undefined;
    let timer;
    const reset = () => {
      clearTimeout(timer);
      timer = setTimeout(() => cb.current(), minutes * 60000);
    };
    const events = ['mousemove', 'keydown', 'pointerdown', 'scroll', 'touchstart'];
    events.forEach((e) => window.addEventListener(e, reset, { passive: true }));
    reset();
    return () => {
      clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, reset));
    };
  }, [minutes, enabled]);
}

export function useTheme() {
  const [theme, setTheme] = useState(() => {
    const th = initialTheme();
    applyTheme(th);
    return th;
  });
  const toggle = () => {
    const next = theme === 'dark' ? 'light' : 'dark';
    applyTheme(next);
    setTheme(next);
  };
  return [theme, toggle];
}

// ——— Тосты ———
const ToastCtx = createContext(() => {});
export const useToast = () => useContext(ToastCtx);

export function ToastProvider({ children }) {
  const [items, setItems] = useState([]);
  const push = useCallback((msg, kind = 'info', title) => {
    const id = Math.random();
    setItems((xs) => [...xs, { id, msg, kind, title }]);
    setTimeout(() => setItems((xs) => xs.filter((x) => x.id !== id)), kind === 'err' ? 6000 : 4000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((x) => (
          <div key={x.id} className={`toast ${x.kind}`} onClick={() => setItems((xs) => xs.filter((y) => y.id !== x.id))}>
            {x.title && <b>{x.title}</b>}
            {x.msg}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

// ——— Базовые элементы ———

export function Money({ value, plus = false, className = '' }) {
  return <span className={`num ${className}`}>{formatMoney(value, { plus })}</span>;
}

export function Spinner() {
  return <div className="spinner" aria-label={t('Загрузка')} />;
}

export function ErrorBox({ error }) {
  if (!error) return null;
  const msg = typeof error === 'string' ? error : error.message;
  return <div className="form-error">{tServer(msg)}</div>;
}

export function Empty({ children }) {
  return <div className="empty">{children}</div>;
}

export function Field({ label, hint, children }) {
  return (
    <label className="field">
      {label && <span>{label}</span>}
      {children}
      {hint && <small className="hint">{hint}</small>}
    </label>
  );
}

export function Input({ label, hint, ...props }) {
  return (
    <Field label={label} hint={hint}>
      <input className="input" {...props} />
    </Field>
  );
}

export function Select({ label, hint, options, ...props }) {
  return (
    <Field label={label} hint={hint}>
      <select className="input" {...props}>
        {options.map((o) => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
    </Field>
  );
}

/** Поле суммы: пользователь вводит «12,50», наружу отдаются влодинки. */
export function MoneyInput({ label, value, onChange, hint, autoFocus, big }) {
  const [text, setText] = useState(value ? formatMoney(value, { sign: false }).replace(/\u00a0/g, ' ') : '');
  useEffect(() => {
    if (value === null || value === undefined || value === '') { if (parseMoney(text) !== null) setText(''); return; }
    if (parseMoney(text) !== value) setText(formatMoney(value, { sign: false }).replace(/\u00a0/g, ''));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);
  return (
    <Field label={label} hint={hint}>
      <input
        className={`input${big ? ' big' : ''}`}
        inputMode="decimal"
        placeholder="0,00"
        value={text}
        autoFocus={autoFocus}
        onChange={(e) => {
          setText(e.target.value);
          const v = parseMoney(e.target.value);
          onChange(v === null ? null : v);
        }}
      />
    </Field>
  );
}

export function Button({ children, busy, kind = '', size = '', block, className = '', ...props }) {
  return (
    <button {...props} className={`btn ${kind} ${size} ${block ? 'block' : ''} ${className}`} disabled={busy || props.disabled}>
      {busy ? '…' : children}
    </button>
  );
}

/** Кнопка с асинхронным действием: блокируется на время запроса, показывает ошибку тостом. */
export function ActionButton({ action, children, okMessage, confirm, ...props }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  return (
    <Button
      {...props}
      busy={busy}
      onClick={async (e) => {
        e.preventDefault();
        if (confirm && !window.confirm(confirm)) return;
        setBusy(true);
        try {
          await action();
          if (okMessage) toast(okMessage, 'ok');
        } catch (err) {
          toast(tServer(err.message), 'err');
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
    </Button>
  );
}

export function Badge({ kind = '', children }) {
  return <span className={`badge ${kind}`}>{children}</span>;
}

export function Modal({ title, onClose, children, footer, wide }) {
  useEffect(() => {
    const on = (e) => e.key === 'Escape' && onClose?.();
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose?.()}>
      <div className={`modal${wide ? ' wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          {onClose && <button className="btn ghost sm icon" onClick={onClose} aria-label={t('Закрыть')}>✕</button>}
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Tabs({ tabs, value, onChange }) {
  return (
    <div className="tabs" role="tablist">
      {tabs.map((tb) => (
        <button key={tb.value} role="tab" aria-selected={value === tb.value} className={value === tb.value ? 'active' : ''} onClick={() => onChange(tb.value)}>
          {tb.label}
        </button>
      ))}
    </div>
  );
}

export function Seg({ options, value, onChange }) {
  return (
    <div className="seg">
      {options.map((o) => (
        <button key={String(o.value)} type="button" className={value === o.value ? 'active' : ''} onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/** Форма с отправкой: перехватывает ошибки и показывает их над кнопкой. */
export function Form({ onSubmit, children, submitLabel, submitKind = '', block = true, extra }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  return (
    <form
      className="stack"
      onSubmit={async (e) => {
        e.preventDefault();
        setBusy(true);
        setError(null);
        try {
          await onSubmit();
        } catch (err) {
          setError(err);
        } finally {
          setBusy(false);
        }
      }}
    >
      {children}
      <ErrorBox error={error} />
      <div className="row">
        <Button type="submit" busy={busy} block={block} kind={submitKind}>{submitLabel || t('Сохранить')}</Button>
        {extra}
      </div>
    </form>
  );
}

// ——— QR, штрихкод, сканер, фото ———

export function QR({ value, size = 160, margin = 1 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && value) QRCode.toCanvas(ref.current, value, { width: size, margin, errorCorrectionLevel: 'M' }).catch(() => {});
  }, [value, size, margin]);
  return <canvas ref={ref} width={size} height={size} style={{ width: size, height: size, display: 'block' }} />;
}

export function Barcode({ value, height = 40, width = 1.6, fontSize = 12, displayValue = true }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && value) {
      try {
        JsBarcode(ref.current, value, { format: 'CODE128', height, width, fontSize, displayValue, margin: 0, background: 'transparent' });
      } catch { /* неподходящее значение */ }
    }
  }, [value, height, width, fontSize, displayValue]);
  return <svg ref={ref} />;
}

/** Сканер QR и штрихкодов камерой (html5-qrcode грузится по требованию). */
export function Scanner({ onScan, onClose }) {
  const id = useRef(`scan-${Math.random().toString(36).slice(2)}`);
  const [error, setError] = useState(null);
  const done = useRef(false);
  useEffect(() => {
    let scanner;
    let cancelled = false;
    (async () => {
      try {
        const { Html5Qrcode } = await import('html5-qrcode');
        if (cancelled) return;
        scanner = new Html5Qrcode(id.current, { verbose: false });
        await scanner.start(
          { facingMode: 'environment' },
          { fps: 10, qrbox: { width: 260, height: 180 } },
          (text) => {
            if (done.current) return;
            done.current = true;
            onScan(text);
          },
          () => {},
        );
      } catch (err) {
        setError(err?.message || String(err));
      }
    })();
    return () => {
      cancelled = true;
      if (scanner?.isScanning) scanner.stop().catch(() => {});
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return (
    <Modal title={t('Сканер')} onClose={onClose}>
      <div id={id.current} className="scanner-box" />
      {error && <div className="form-error" style={{ marginTop: 12 }}>{t('Камера недоступна')}: {error}</div>}
      <p className="muted small center" style={{ marginTop: 10 }}>{t('Наведите камеру на QR-код или штрихкод')}</p>
    </Modal>
  );
}

/** Загрузка фото с диска или камеры телефона; сжимаем до maxSize px в JPEG. */
export function PhotoInput({ value, onChange, label, maxSize = 480, aspect }) {
  const inputRef = useRef(null);
  async function onFile(file) {
    if (!file) return;
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.src = url;
    await img.decode();
    let w = img.naturalWidth;
    let h = img.naturalHeight;
    let sx = 0, sy = 0, sw = w, sh = h;
    if (aspect) {
      const cur = w / h;
      if (cur > aspect) { sw = h * aspect; sx = (w - sw) / 2; } else { sh = w / aspect; sy = (h - sh) / 2; }
      w = sw; h = sh;
    }
    const scale = Math.min(1, maxSize / Math.max(w, h));
    const c = document.createElement('canvas');
    c.width = Math.round(w * scale);
    c.height = Math.round(h * scale);
    c.getContext('2d').drawImage(img, sx, sy, sw, sh, 0, 0, c.width, c.height);
    URL.revokeObjectURL(url);
    onChange(c.toDataURL('image/jpeg', 0.82));
  }
  return (
    <Field label={label}>
      <div className="row">
        {value ? <img src={value} alt="" style={{ width: 72, height: 72, objectFit: 'cover', borderRadius: 8, border: '1px solid var(--line)' }} /> : null}
        <button type="button" className="btn secondary sm" onClick={() => inputRef.current?.click()}>{value ? t('Заменить фото') : t('Загрузить или снять фото')}</button>
        {value && <button type="button" className="btn ghost sm" onClick={() => onChange(null)}>{t('Убрать')}</button>}
        <input ref={inputRef} type="file" accept="image/*" capture="environment" hidden onChange={(e) => onFile(e.target.files?.[0])} />
      </div>
    </Field>
  );
}

/** Цифровая клавиатура для PIN. */
export function PinPad({ length = 3, onComplete, disabled, title }) {
  const [pin, setPin] = useState('');
  useEffect(() => {
    if (pin.length === length) {
      onComplete(pin);
      setPin('');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pin]);
  useEffect(() => {
    const on = (e) => {
      if (disabled) return;
      if (/^\d$/.test(e.key)) setPin((p) => (p.length < length ? p + e.key : p));
      if (e.key === 'Backspace') setPin((p) => p.slice(0, -1));
    };
    window.addEventListener('keydown', on);
    return () => window.removeEventListener('keydown', on);
  }, [length, disabled]);
  const press = (d) => !disabled && setPin((p) => (p.length < length ? p + d : p));
  return (
    <div>
      {title && <div className="center muted">{title}</div>}
      <div className="pin-dots">{Array.from({ length }, (_, i) => <span key={i} className={i < pin.length ? 'on' : ''} />)}</div>
      <div className="pinpad">
        {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map((d) => <button key={d} type="button" onClick={() => press(d)}>{d}</button>)}
        <button type="button" onClick={() => setPin('')}>C</button>
        <button type="button" onClick={() => press('0')}>0</button>
        <button type="button" onClick={() => setPin((p) => p.slice(0, -1))}>⌫</button>
      </div>
    </div>
  );
}

// ——— Каркас приложения ———

export function LangThemeSwitch() {
  const lang = useLang();
  const [theme, toggle] = useTheme();
  return (
    <>
      <button className="tb-btn" onClick={() => setLang(lang === 'ru' ? 'it' : 'ru')} title={t('Язык')} aria-label={t('Язык')}>
        {lang === 'ru' ? 'IT' : 'RU'}
      </button>
      <button className="tb-btn" onClick={toggle} title={t('Тема')} aria-label={t('Тема')}>
        {theme === 'dark' ? '☀' : '☾'}
      </button>
    </>
  );
}

export function DisclaimerBar() {
  useLang();
  return <footer className="disclaimer">{t(DISCLAIMER)}</footer>;
}

export function Topbar({ brand, nav, right, homeHref = '#/' }) {
  return (
    <header className="topbar">
      <div className="topbar-inner">
        <a className="brand" href={homeHref}>{brand}</a>
        {nav && <nav className="nav">{nav}</nav>}
        <div className="spacer" />
        {right}
        <LangThemeSwitch />
      </div>
    </header>
  );
}

export function NavLink({ href, children, path }) {
  const active = path !== undefined && (href === '#/' ? path === '/' : path.startsWith(href.slice(1)));
  return <a href={href} className={active ? 'active' : ''}>{children}</a>;
}

/** Колокольчик уведомлений. */
export function Bell({ count, onClick }) {
  return (
    <button className="tb-btn" onClick={onClick} aria-label={t('Уведомления')} title={t('Уведомления')}>
      🔔{count > 0 && <span className="badge-dot">{count}</span>}
    </button>
  );
}

export function OfflineScreen() {
  return (
    <div className="offline" role="alert">
      <div style={{ fontSize: '3rem' }}>⚠</div>
      <h2>{t('Нет связи с сервером')}</h2>
      <p>{t('Касса заблокирована до восстановления связи. Не принимайте оплату картой.')}</p>
      <div className="spinner" />
    </div>
  );
}

export function StatusBadge({ status }) {
  const map = {
    active: ['ok', 'Активен'], paid: ['ok', 'Оплачено'], approved: ['ok', 'Выдано'], confirmed: ['ok', 'Подтверждено'], open: ['brand', 'Открыта'],
    pending: ['warn', 'На рассмотрении'], awaiting_payment: ['warn', 'Ждёт оплаты'], unpaid: ['warn', 'Не оплачено'], frozen: ['warn', 'Заморожен'], held: ['warn', 'Отложен'],
    rejected: ['err', 'Отказ'], blocked: ['err', 'Заблокирован'], arrested: ['err', 'Арест'], cancelled: ['', 'Отменено'], closed: ['', 'Закрыт'], expired: ['err', 'Истёк'], revoked: ['err', 'Аннулирован'], reissued: ['', 'Перевыпущена'],
  };
  const [kind, label] = map[status] || ['', status];
  return <Badge kind={kind}>{t(label)}</Badge>;
}
