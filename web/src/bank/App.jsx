import { useEffect, useState } from 'react';
import { get, post, onUnauthorized, appUrl } from '../shared/api.js';
import { reconnect } from '../shared/ws.js';
import { t, useLang } from '../shared/i18n.js';
import { useRoute, pick, navigate } from '../shared/router.js';
import { Topbar, NavLink, DisclaimerBar, Spinner, useChannel, useIdle, useToast, Bell, Input, Form, Tabs, Empty, ErrorBox } from '../shared/ui.jsx';
import { BankLogo } from '../shared/brand.jsx';
import { SiteFooter, Hero, Section, Features } from '../shared/site.jsx';
import { LoginForm, AuthDisclaimer, NotificationsModal } from '../shared/auth.jsx';
import { Dashboard, AccountPage, OpenAccount, CardsPage, TransferPage, PayInvoice, QrPay, ReceiptPage, ProfilePage } from './pages.jsx';
import { NewCard, CreditPage, AutopayPage, CashbackPage } from './finance.jsx';
import { Atm } from './atm.jsx';
import { TellerPage } from './teller.jsx';
import { DebtsPage } from './debts.jsx';
import { PurchasesPage, CourierPage } from '../pay/purchases.jsx';

export default function App() {
  useLang();
  const route = useRoute();
  const [me, setMe] = useState(undefined);
  const [settings, setSettings] = useState(null);
  const [bell, setBell] = useState(0);
  const [showBell, setShowBell] = useState(false);
  const [tick, setTick] = useState(0); // обновление данных по WebSocket
  const toast = useToast();

  async function loadMe() {
    try {
      const r = await get('/auth/me');
      setMe(r.bank);
    } catch {
      setMe(null);
    }
  }

  useEffect(() => {
    loadMe();
    get('/public/settings').then(setSettings).catch(() => {});
    return onUnauthorized((path) => { if (!path.startsWith('/bank/atm')) setMe(null); });
  }, []);

  useEffect(() => {
    if (me) get('/notifications?kind=bank').then((r) => setBell(r.unread)).catch(() => {});
  }, [me]);

  useChannel(me ? `user:b${me.id}` : null, (m) => {
    if (m.type === 'balance') setTick((x) => x + 1);
    if (m.type === 'notification') {
      setBell((n) => n + 1);
      toast(m.notification.body || '', 'info', t(m.notification.title));
      setTick((x) => x + 1);
      if (/Паспорт|Регистрация/.test(m.notification.title)) loadMe();
    }
  });

  useIdle(settings?.idle_minutes, async () => {
    await post('/auth/bank/logout');
    setMe(null);
    toast(t('Сессия завершена из-за бездействия'), 'info');
  }, !!me && route.path !== '/atm');

  async function logout() {
    await post('/auth/bank/logout');
    reconnect();
    setMe(null);
    navigate('/');
  }

  const brand = <><BankLogo src={settings?.bank_logo} /> <span>ВлодБанк</span></>;

  // Банкомат — отдельный экран без входа в кабинет.
  if (route.path === '/atm') return <><Atm brand={brand} /><DisclaimerBar /></>;
  const footer = (
    <SiteFooter
      brand="ВлодБанк"
      about="Государственный банк Балесноландской Федерации: счета, карты, переводы, вклады и кредиты."
      columns={[
        { title: 'Частным клиентам', links: [{ href: '#/cards', label: 'Карты' }, { href: '#/transfer', label: 'Переводы' }, { href: '#/credit', label: 'Кредиты' }, { href: '#/cashback', label: 'Кешбэк' }] },
        { title: 'Сервисы', links: [{ href: '#/atm', label: 'Банкомат' }, { href: '#/pay', label: 'Оплата квитанций' }] },
        { title: 'Госсайты', links: [{ href: '../services/#/', label: 'ВлодУслуги' }, { href: '../nalog/#/', label: 'Налоговая служба' }] },
      ]}
    />
  );

  if (me === undefined) return <><Topbar variant="site" brand={brand} /><Spinner /></>;

  const isTeller = me?.roles?.some((r) => r === 'teller' || r === 'admin');
  const ready = me && me.status === 'active' && me.passport_verified;

  return (
    <>
      <Topbar
        variant="site"
        brand={brand}
        nav={ready && (
          <>
            <NavLink href="#/" path={route.path}>{t('Главная')}</NavLink>
            <NavLink href="#/cards" path={route.path}>{t('Карты')}</NavLink>
            <NavLink href="#/transfer" path={route.path}>{t('Переводы')}</NavLink>
            <NavLink href="#/pay" path={route.path}>{t('Платежи')}</NavLink>
            <NavLink href="#/credit" path={route.path}>{t('Кредиты')}</NavLink>
            <NavLink href="#/cashback" path={route.path}>{t('Кешбэк')}</NavLink>
            <NavLink href="#/debts" path={route.path}>{t('Долги')}</NavLink>
            <NavLink href="#/purchases" path={route.path}>{t('Покупки')}</NavLink>
            {isTeller && <NavLink href="#/teller" path={route.path}>{t('Операционист')}</NavLink>}
          </>
        )}
        right={me && (
          <>
            <Bell count={bell} onClick={() => setShowBell(true)} />
            <a className="tb-btn" href="#/profile" title={me.email}>👤</a>
            <button className="tb-btn" onClick={logout}>{t('Выйти')}</button>
          </>
        )}
      />
      {showBell && <NotificationsModal kind="bank" onClose={() => setShowBell(false)} onRead={() => setBell(0)} />}
      {!me ? <AuthScreen onDone={loadMe} /> : !ready ? <Gate me={me} onChange={loadMe} /> : (
        pick([
          ['/', () => <Dashboard tick={tick} />],
          ['/accounts/:id', (p) => <AccountPage id={p.id} tick={tick} />],
          ['/open', () => <OpenAccount />],
          ['/cards', () => <CardsPage tick={tick} />],
          ['/cards/new', () => <NewCard />],
          ['/transfer', () => <TransferPage />],
          ['/pay', () => <PayInvoice />],
          ['/credit', () => <CreditPage tick={tick} />],
          ['/pay/:no', (p) => <PayInvoice number={p.no} />],
          ['/qr/:token', (p) => <QrPay token={p.token} />],
          ['/autopay', () => <AutopayPage tick={tick} />],
          ['/cashback', () => <CashbackPage tick={tick} />],
          ['/debts', () => <DebtsPage tick={tick} />],
          ['/purchases', () => <PurchasesPage tick={tick} />],
          ['/courier', () => <CourierPage />],
          ['/receipt/:id', (p) => <ReceiptPage id={p.id} />],
          ['/profile', () => <ProfilePage me={me} />],
          ['/teller', () => (isTeller ? <TellerPage /> : <Empty>{t('Нет доступа')}</Empty>)],
          ['*', () => <Empty>{t('Страница не найдена')}</Empty>],
        ], route.path)
      )}
      {footer}
    </>
  );
}

function AuthScreen({ onDone }) {
  const [tab, setTab] = useState('login');
  const [viaErr, setViaErr] = useState(null);
  async function viaGov() {
    setViaErr(null);
    try {
      await post('/auth/bank/via-gov');
      reconnect();
      onDone();
    } catch (err) {
      if (err.status === 401) {
        setViaErr(t('Сначала войдите во ВлодУслуги в этом браузере, затем вернитесь сюда.'));
      } else setViaErr(err.message);
    }
  }
  return (
    <>
    <Hero
      kicker="Государственный банк Балесноландии"
      title="Ваши деньги — под защитой Федерации"
      lead="Счета, дебетовые и кредитные карты, переводы по номеру карты и счёта, вклады и кешбэк. Вход — через ВлодУслуги или по паролю."
      art={<div className="bank-card-art"><span>ВлодБанк</span><b>7700 •••• •••• 0042</b><small>ИМЯ ФАМИЛИЯ</small></div>}
    />
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="brand-big">
          <BankLogo size={64} />
          <h1 style={{ margin: 0 }}>ВлодБанк</h1>
          <div className="muted small">{t('Личный кабинет')}</div>
        </div>
        <Tabs value={tab} onChange={setTab} tabs={[{ value: 'login', label: t('Вход') }, { value: 'register', label: t('Регистрация') }]} />
        {tab === 'login' ? <LoginForm kind="bank" onDone={onDone} /> : <RegisterBank onDone={onDone} />}
        <hr className="sep" />
        <button className="btn secondary block" onClick={viaGov}>{t('Войти через ВлодУслуги')}</button>
        {viaErr && <div style={{ marginTop: 8 }}><ErrorBox error={viaErr} /> <a className="small" href={appUrl('services')}>{t('Открыть ВлодУслуги')}</a></div>}
        <div className="row" style={{ marginTop: 12, justifyContent: 'center' }}><a href="#/atm" className="small">{t('Банкомат')}</a></div>
        <div style={{ marginTop: 16 }}><AuthDisclaimer /></div>
      </div>
    </div>
    <Section muted title="Продукты банка">
      <Features items={[
        { icon: '💳', title: 'Дебетовые карты', text: 'Оплата на любой Кассе, по QR и в интернет-магазинах БалНета.' },
        { icon: '⇄', title: 'Переводы', text: 'По номеру карты, счёта или имени — мгновенно.' },
        { icon: '📈', title: 'Вклады', text: 'Накопительный счёт и срочный вклад с процентами каждый игровой месяц.' },
        { icon: '🎁', title: 'Кешбэк', text: 'Выберите категории месяца и получайте часть покупок обратно.' },
      ]} />
    </Section>
    </>
  );
}

function RegisterBank({ onDone }) {
  const [f, setF] = useState({ email: '', password: '', full_name: '', birth_date: '', passport_no: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Form submitLabel={t('Открыть доступ')} onSubmit={async () => { await post('/auth/bank/register', f); reconnect(); onDone(); }}>
      <Input label={t('Фамилия и имя')} required value={f.full_name} onChange={set('full_name')} />
      <Input label={t('Дата рождения')} type="date" required value={f.birth_date} onChange={set('birth_date')} />
      <Input label={t('Номер паспорта БФ')} placeholder="BLN-0000-0000" value={f.passport_no} onChange={set('passport_no')} hint={t('Без паспорта счёт открыть нельзя. Паспорт оформляется во ВлодУслугах.')} />
      <Input label="Email" type="email" required value={f.email} onChange={set('email')} />
      <Input label={t('Пароль (от 8 символов)')} type="password" minLength={8} required value={f.password} onChange={set('password')} autoComplete="new-password" />
    </Form>
  );
}

/** Пока аккаунт не одобрен или паспорт не подтверждён — объясняем, что делать. */
function Gate({ me, onChange }) {
  const [no, setNo] = useState(me.passport_no || '');
  const [sent, setSent] = useState(false);
  if (me.status === 'pending') {
    return (
      <div className="page narrow">
        <div className="card stack">
          <h2>{t('Регистрация на проверке')}</h2>
          <p>{t('Банк проверяет анкету. Мы пришлём уведомление, когда доступ откроется.')}</p>
          <button className="btn secondary" onClick={onChange}>{t('Проверить снова')}</button>
        </div>
      </div>
    );
  }
  return (
    <div className="page narrow">
      <div className="card stack">
        <h2>{t('Подтвердите паспорт БФ')}</h2>
        <p>{t('Укажите номер паспорта. Владелец паспорта подтвердит связку во ВлодУслугах (раздел «ВлодБанк»).')}</p>
        {me.passport_no && !sent && <div className="form-warn">{t('Ждём подтверждения паспорта {no} во ВлодУслугах', { no: me.passport_no })}</div>}
        {sent && <div className="form-ok">{t('Запрос отправлен. Подтвердите его во ВлодУслугах.')}</div>}
        <Form submitLabel={t('Отправить запрос')} onSubmit={async () => { await post('/bank/profile/passport', { passport_no: no }); setSent(true); onChange(); }}>
          <Input label={t('Номер паспорта БФ')} placeholder="BLN-0000-0000" required value={no} onChange={(e) => setNo(e.target.value)} />
        </Form>
        <div className="row">
          <a className="btn secondary" href={appUrl('services', '/links')} target="_blank" rel="noreferrer">{t('Открыть ВлодУслуги')}</a>
          <button className="btn ghost" onClick={onChange}>{t('Я подтвердил')}</button>
        </div>
      </div>
    </div>
  );
}
