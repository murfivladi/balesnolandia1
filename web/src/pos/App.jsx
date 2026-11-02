import { useEffect, useState } from 'react';
import { get, post, onUnauthorized, onOffline, appUrl } from '../shared/api.js';
import { reconnect, onWsStatus, ensureSocket } from '../shared/ws.js';
import { t, useLang } from '../shared/i18n.js';
import { useRoute } from '../shared/router.js';
import { Topbar, DisclaimerBar, Spinner, Form, Input, Select, PinPad, useAsync, Empty, OfflineScreen, ErrorBox, Badge } from '../shared/ui.jsx';
import { PosLogo } from '../shared/brand.jsx';
import { LoginForm, AuthDisclaimer } from '../shared/auth.jsx';
import { Register } from './register.jsx';
import { Manage } from './manage.jsx';
import { Terminal } from './terminal.jsx';
import { Tables } from './tables.jsx';
import { Kitchen } from './kitchen.jsx';
import { QueueBoard } from './queue.jsx';
import { Kiosk } from './kiosk.jsx';

export function applyShopColor(color) {
  if (!color) return;
  document.body.style.setProperty('--brand', color);
  document.body.style.setProperty('--accent', color);
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', color);
}

export default function App() {
  useLang();
  const route = useRoute();
  const [me, setMe] = useState(undefined);

  async function loadMe() {
    try {
      setMe(await get('/auth/me'));
    } catch {
      setMe({ bank: null, pos: null });
    }
  }
  useEffect(() => {
    loadMe();
    return onUnauthorized((path) => { if (!path.startsWith('/pos/terminal/')) loadMe(); });
  }, []);

  if (route.path === '/terminal' || route.path.startsWith('/terminal/')) return <Terminal initialCode={route.path.split('/')[2]} />;
  // Табло очереди открывается без входа: только номер магазина и номера заказов.
  if (route.path === '/queue' || route.path.startsWith('/queue/')) {
    const shopId = route.path.split('/')[2] || route.query.shop || '';
    return <><QueueBoard shopId={Number(shopId) || null} /><DisclaimerBar /></>;
  }
  if (me === undefined) return <><Topbar brand={<><PosLogo /> <span>{t('Касса')}</span></>} /><Spinner /></>;
  if (!me.bank) return <BankLogin onDone={loadMe} />;
  if (!me.pos) return <ShopPicker me={me} onDone={loadMe} />;
  return <PosShell onLogout={loadMe} route={route} />;
}

function BankLogin({ onDone }) {
  return (
    <>
      <Topbar brand={<><PosLogo /> <span>{t('Касса')}</span></>} />
      <div className="auth-wrap">
        <div className="card auth-card">
          <div className="brand-big"><PosLogo size={64} /><h1 style={{ margin: 0 }}>{t('Касса')}</h1><div className="muted small">{t('Вход аккаунтом ВлодБанка')}</div></div>
          <LoginForm kind="bank" onDone={onDone} />
          <hr className="sep" />
          <a className="btn secondary block" href="#/terminal">{t('Это терминал покупателя')}</a>
          <div style={{ marginTop: 16 }}><AuthDisclaimer /></div>
        </div>
      </div>
      <DisclaimerBar />
    </>
  );
}

function ShopPicker({ me, onDone }) {
  const { data, loading, reload } = useAsync(() => get('/pos/my-shops'), []);
  const [shop, setShop] = useState(null);
  const [error, setError] = useState(null);
  const [create, setCreate] = useState(false);
  async function login(pin) {
    setError(null);
    try {
      await post('/pos/login', { shop_id: shop.id, pin });
      reconnect();
      onDone();
    } catch (e) {
      setError(e);
    }
  }
  async function logoutBank() {
    await post('/auth/bank/logout');
    reconnect();
    onDone();
  }
  return (
    <>
      <Topbar brand={<><PosLogo /> <span>{t('Касса')}</span></>} right={<button className="tb-btn" onClick={logoutBank}>{t('Выйти')}</button>} />
      <div className="page medium">
        {loading && !data ? <Spinner /> : shop ? (
          <div className="card stack" style={{ maxWidth: 380, margin: '0 auto' }}>
            <div className="row"><PosLogo src={shop.logo} color={shop.color} /><h2 style={{ margin: 0 }}>{shop.name}</h2></div>
            <PinPad length={4} title={t('PIN кассира')} onComplete={login} />
            <ErrorBox error={error} />
            <button className="btn ghost" onClick={() => { setShop(null); setError(null); }}>{t('Другой магазин')}</button>
          </div>
        ) : create ? (
          <CreateShop info={data.can_create} onDone={() => { setCreate(false); reload(); }} onCancel={() => setCreate(false)} />
        ) : (
          <>
            <div className="page-head"><h1>{t('Здравствуйте, {name}', { name: me.bank.full_name.split(' ')[0] })}</h1></div>
            {!data.shops.length ? <Empty>{t('Вы пока не работаете ни в одном магазине.')}</Empty> : (
              <div className="grid grid-auto">
                {data.shops.map((s) => (
                  <button key={s.id} className="card" style={{ textAlign: 'left', cursor: 'pointer', font: 'inherit', color: 'inherit', borderTop: `6px solid ${s.color}` }} onClick={() => setShop(s)}>
                    <div className="row"><PosLogo src={s.logo} color={s.color} /><b>{s.name}</b></div>
                    <div className="small muted" style={{ marginTop: 6 }}>{s.my_role === 'owner' ? t('Владелец') : t('Кассир')} · {s.type === 'cafe' ? t('Кафе') : t('Магазин')}</div>
                  </button>
                ))}
              </div>
            )}
            <div className="card" style={{ marginTop: 16 }}>
              <h2>{t('Открыть свой магазин')}</h2>
              <p className="muted">{t('Цепочка: ИП во ВлодУслугах → бизнес-счёт во ВлодБанке → магазин в кассе.')}</p>
              <div className="row">
                <Badge kind={data.can_create.has_ip ? 'ok' : 'warn'}>{data.can_create.has_ip ? '✓' : '✕'} {t('ИП')}</Badge>
                <Badge kind={data.can_create.business_accounts.length ? 'ok' : 'warn'}>{data.can_create.business_accounts.length ? '✓' : '✕'} {t('Бизнес-счёт')}</Badge>
              </div>
              <div className="row" style={{ marginTop: 12 }}>
                <button className="btn" disabled={!data.can_create.has_ip || !data.can_create.business_accounts.length} onClick={() => setCreate(true)}>{t('Создать магазин')}</button>
                {!data.can_create.has_ip && <a className="btn ghost" href={appUrl('services', '/documents')}>{t('Зарегистрировать ИП')}</a>}
                {data.can_create.has_ip && !data.can_create.business_accounts.length && <a className="btn ghost" href={appUrl('bank', '/open')}>{t('Открыть бизнес-счёт')}</a>}
              </div>
            </div>
            <div className="row" style={{ marginTop: 16 }}><a className="btn secondary" href="#/terminal">{t('Режим терминала покупателя')}</a></div>
          </>
        )}
      </div>
      <DisclaimerBar />
    </>
  );
}

function CreateShop({ info, onDone, onCancel }) {
  const [f, setF] = useState({ name: '', type: 'shop', color: '#0f766e', address: '', account_id: info.business_accounts[0]?.id, pin: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="card">
      <h2>{t('Новый магазин')}</h2>
      <Form submitLabel={t('Создать')} onSubmit={async () => { await post('/pos/shops', { ...f, account_id: Number(f.account_id) }); onDone(); }} extra={<button type="button" className="btn ghost" onClick={onCancel}>{t('Отмена')}</button>}>
        <Input label={t('Название')} required value={f.name} onChange={set('name')} />
        <div className="grid grid-2">
          <Select label={t('Тип')} value={f.type} onChange={set('type')} options={[{ value: 'shop', label: t('Магазин') }, { value: 'cafe', label: t('Кафе') }]} />
          <Input label={t('Цвет')} type="color" value={f.color} onChange={set('color')} />
        </div>
        <Input label={t('Адрес')} value={f.address} onChange={set('address')} />
        <Select label={t('Бизнес-счёт для выручки')} value={f.account_id} onChange={set('account_id')} options={info.business_accounts.map((a) => ({ value: a.id, label: `${a.name} · ${a.number}` }))} />
        <Input label={t('Ваш PIN кассира — 4 цифры')} type="password" inputMode="numeric" maxLength={4} required value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '') })} />
      </Form>
    </div>
  );
}

function PosShell({ onLogout, route }) {
  const { data: session, reload, error } = useAsync(() => get('/pos/session'), []);
  const [wsUp, setWsUp] = useState(true);
  const [apiDown, setApiDown] = useState(false);
  const [lostAt, setLostAt] = useState(null);
  const [now, setNow] = useState(Date.now());

  useEffect(() => {
    ensureSocket();
    const off1 = onWsStatus((up) => { setWsUp(up); setLostAt(up ? null : Date.now()); });
    const off2 = onOffline(setApiDown);
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => { off1(); off2(); clearInterval(timer); };
  }, []);
  useEffect(() => { if (session) applyShopColor(session.shop.color); }, [session]);

  // Касса блокируется, если связи нет дольше 3 секунд.
  const offline = apiDown || (!wsUp && lostAt && now - lostAt > 3000);

  async function lock() {
    await post('/pos/logout');
    reconnect();
    onLogout();
  }

  if (error) return <div className="page"><ErrorBox error={error} /><button className="btn" onClick={lock}>{t('Выйти')}</button></div>;
  if (!session) return <Spinner />;
  const isOwner = session.staff.role === 'owner';
  const manage = route.path.startsWith('/manage');
  const kiosk = route.path === '/kiosk';
  const root = route.path === '/';
  const tables = route.path.startsWith('/tables');
  const kitchen = route.path.startsWith('/kitchen');

  if (kiosk) {
    return (
      <>
        <Kiosk session={session} onSession={reload} />
        {offline && <OfflineScreen />}
        <DisclaimerBar />
      </>
    );
  }

  return (
    <>
      <Topbar
        brand={<><PosLogo src={session.shop.logo} color={session.shop.color} /> <span>{session.shop.name}</span></>}
        nav={(
          <>
            <a href="#/" className={root ? 'active' : ''}>{t('Продажа')}</a>
            {session.shop.type === 'cafe' && <a href="#/tables" className={tables ? 'active' : ''}>{t('Столы')}</a>}
            {session.shop.kitchen_enabled && <a href="#/kitchen" className={kitchen ? 'active' : ''}>{t('Кухня')}</a>}
            {session.shop.kitchen_enabled && <a href={`#/queue?shop=${session.shop.id}`}>{t('Очередь')}</a>}
            {isOwner && <a href="#/manage" className={manage ? 'active' : ''}>{t('Управление')}</a>}
          </>
        )}
        right={(
          <>
            <span className="small" style={{ opacity: .85 }}>{session.staff.name}{session.shift ? ` · ${t('смена')} №${session.shift.number}` : ''}</span>
            <button className="tb-btn" onClick={lock} title={t('Заблокировать кассу')}>🔒</button>
          </>
        )}
      />
      {manage && isOwner ? <Manage session={session} route={route} onChange={reload} />
        : tables ? <Tables session={session} onSession={reload} />
          : kitchen ? <Kitchen session={session} />
            : <Register session={session} onSession={reload} />}
      {offline && <OfflineScreen />}
      <DisclaimerBar />
    </>
  );
}

