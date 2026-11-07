import { useEffect, useState } from 'react';
import { get, post, onUnauthorized, appUrl } from '../shared/api.js';
import { reconnect } from '../shared/ws.js';
import { t, useLang, fmtDate, fmtBirth } from '../shared/i18n.js';
import { useRoute, pick, navigate } from '../shared/router.js';
import {
  Topbar, NavLink, DisclaimerBar, Spinner, useAsync, useChannel, useIdle, useToast, Bell, Input, Form, Select, PhotoInput,
  Money, StatusBadge, Empty, ActionButton, Badge, QR, ErrorBox, Modal, Tabs,
} from '../shared/ui.jsx';
import { ServicesLogo, CoatOfArms, Flag } from '../shared/brand.jsx';
import { LoginForm, AuthDisclaimer, NotificationsModal } from '../shared/auth.jsx';
import { IdCard, passportBlocks, MARITAL, DOC_DISCLAIMER } from '../shared/passport.jsx';
import { renderThermal, shareCanvas } from '../shared/thermal.js';
import { gameDateLabel, mmYY } from '@bln/shared/time.js';
import { OrgsPage, OrgPage, DomainsPage, DomainPage } from './domains.jsx';

const DOC_TITLES = { inn: 'ИНН', ip: 'Свидетельство ИП', driver: 'Водительские права', marriage: 'Свидетельство о браке', birth: 'Свидетельство о рождении', foreign_passport: 'Загранпаспорт', visa: 'Виза' };

export default function App() {
  useLang();
  const route = useRoute();
  const [me, setMe] = useState(undefined);
  const [settings, setSettings] = useState(null);
  const [bell, setBell] = useState(0);
  const [showBell, setShowBell] = useState(false);
  const toast = useToast();

  async function loadMe() {
    try {
      const r = await get('/auth/me');
      setMe(r.gov);
    } catch {
      setMe(null);
    }
  }

  useEffect(() => {
    loadMe();
    get('/public/settings').then(setSettings).catch(() => {});
    return onUnauthorized(() => setMe(null));
  }, []);

  useEffect(() => {
    if (!me) return;
    get('/notifications?kind=gov').then((r) => setBell(r.unread)).catch(() => {});
  }, [me]);

  useChannel(me ? `user:g${me.id}` : null, (m) => {
    if (m.type === 'notification') {
      setBell((n) => n + 1);
      toast(t(m.notification.title), 'info');
    }
  });

  useIdle(settings?.idle_minutes, async () => {
    await post('/auth/gov/logout');
    setMe(null);
    toast(t('Сессия завершена из-за бездействия'), 'info');
  }, !!me);

  async function logout() {
    await post('/auth/gov/logout');
    reconnect();
    setMe(null);
    navigate('/');
  }

  const isOfficial = me?.roles?.some((r) => ['admin', 'official'].includes(r));
  const publicPage = pick([
    ['/verify/passport/:code', (p) => <VerifyPassport code={p.code} />],
    ['/verify/receipt/:code', (p) => <VerifyReceipt code={p.code} />],
    ['/verify/document/:code', (p) => <VerifyDocument code={p.code} />],
  ], route.path);

  const brand = <><ServicesLogo src={settings?.gov_logo} /> <span>ВлодУслуги</span></>;

  if (me === undefined) return <><Topbar brand={brand} /><Spinner /></>;

  return (
    <>
      <Topbar
        brand={brand}
        nav={me && (
          <>
            <NavLink href="#/" path={route.path}>{t('Главная')}</NavLink>
            <NavLink href="#/passport" path={route.path}>{t('Паспорт')}</NavLink>
            <NavLink href="#/documents" path={route.path}>{t('Документы')}</NavLink>
            <NavLink href="#/invoices" path={route.path}>{t('Квитанции')}</NavLink>
            <NavLink href="#/applications" path={route.path}>{t('Заявления')}</NavLink>
            <NavLink href="#/orgs" path={route.path}>Организации</NavLink>
            <NavLink href="#/domains" path={route.path}>Домены</NavLink>
            {isOfficial && <NavLink href="#/queue" path={route.path}>{t('Рассмотрение')}</NavLink>}
          </>
        )}
        right={me && (
          <>
            <Bell count={bell} onClick={() => setShowBell(true)} />
            <button className="tb-btn" onClick={logout} title={me.email}>{t('Выйти')}</button>
          </>
        )}
      />
      {showBell && <NotificationsModal kind="gov" onClose={() => setShowBell(false)} onRead={() => setBell(0)} />}
      {publicPage || (!me ? <AuthScreen onDone={loadMe} /> : (
        pick([
          ['/', () => <Home me={me} />],
          ['/passport', () => <PassportPage />],
          ['/passport/edit', () => <PassportForm />],
          ['/documents', () => <DocumentsPage />],
          ['/invoices', () => <InvoicesPage />],
          ['/applications', () => <ApplicationsPage />],
          ['/links', () => <LinksPage />],
          ['/orgs', () => <OrgsPage />],
          ['/orgs/:id', (p) => <OrgPage id={p.id} />],
          ['/domains', () => <DomainsPage />],
          ['/domains/:id', (p) => <DomainPage id={p.id} />],
          ['/queue', () => (isOfficial ? <QueuePage /> : <Empty>{t('Нет доступа')}</Empty>)],
          ['*', () => <Empty>{t('Страница не найдена')}</Empty>],
        ], route.path)
      ))}
      <DisclaimerBar />
    </>
  );
}

function AuthScreen({ onDone }) {
  const [tab, setTab] = useState('login');
  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="brand-big">
          <CoatOfArms size={56} />
          <h1 style={{ margin: 0 }}>ВлодУслуги</h1>
          <div className="muted small">{t('Госпортал Балесноландской Федерации')}</div>
        </div>
        <Tabs value={tab} onChange={setTab} tabs={[{ value: 'login', label: t('Вход') }, { value: 'register', label: t('Регистрация') }]} />
        {tab === 'login' ? <LoginForm kind="gov" onDone={onDone} /> : <RegisterGov onDone={onDone} />}
        <div style={{ marginTop: 16 }}><AuthDisclaimer /></div>
      </div>
    </div>
  );
}

function RegisterGov({ onDone }) {
  const [f, setF] = useState({ email: '', password: '', display_name: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Form submitLabel={t('Создать аккаунт')} onSubmit={async () => { await post('/auth/gov/register', f); reconnect(); onDone(); }}>
      <Input label={t('Как к вам обращаться')} required value={f.display_name} onChange={set('display_name')} />
      <Input label="Email" type="email" required value={f.email} onChange={set('email')} />
      <Input label={t('Пароль (от 8 символов)')} type="password" minLength={8} required value={f.password} onChange={set('password')} autoComplete="new-password" />
    </Form>
  );
}

function useGovMe() {
  const r = useAsync(() => get('/gov/me'), []);
  return r;
}

function Home({ me }) {
  const lang = useLang();
  const { data, loading, reload } = useGovMe();
  useChannel(`user:g${me.id}`, (m) => m.type === 'notification' && reload());
  if (loading && !data) return <Spinner />;
  const p = data.passport;
  const unpaid = data.invoices.filter((i) => i.status === 'unpaid');
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Здравствуйте, {name}', { name: p?.full_name?.split(' ')[0] || me.display_name })}</h1>
        <span className="muted small">{t('Игровая дата')}: {gameDateLabel(data.month, lang)}</span>
      </div>
      {data.links.length > 0 && (
        <div className="form-warn" style={{ marginBottom: 16 }}>
          {t('ВлодБанк просит подтвердить ваш паспорт')} — <a href="#/links">{t('посмотреть')}</a>
        </div>
      )}
      {unpaid.length > 0 && (
        <div className="form-warn" style={{ marginBottom: 16 }}>
          {t('Неоплаченных квитанций: {n}', { n: unpaid.length })} — <a href="#/invoices">{t('оплатить')}</a>
        </div>
      )}
      <div className="grid grid-2">
        <div className="card">
          <div className="card-head"><h2>{t('Паспорт БФ')}</h2>{p && <StatusBadge status={p.status} />}</div>
          {p ? (
            <div className="stack">
              <IdCard p={p} />
              <div className="row"><a className="btn secondary" href="#/passport">{t('Открыть паспорт')}</a></div>
            </div>
          ) : (
            <div className="stack">
              <p>{t('Паспорт БФ нужен для счёта во ВлодБанке, регистрации ИП, покупки товаров 18+ и выборов.')}</p>
              {data.applications.find((a) => a.type === 'passport' && ['pending', 'awaiting_payment'].includes(a.status))
                ? <div className="form-warn">{t('Заявление на паспорт на рассмотрении')}</div>
                : <a className="btn" href="#/passport/edit">{t('Оформить паспорт')}</a>}
            </div>
          )}
        </div>
        <div className="stack">
          <div className="card">
            <h2>{t('Услуги')}</h2>
            <div className="grid grid-2">
              <ServiceTile href="#/documents" icon="🪪" title={t('ИНН и ИП')} sub={t('Регистрация бизнеса')} />
              <ServiceTile href="#/invoices" icon="🧾" title={t('Квитанции')} sub={t('Пошлины, штрафы, налоги')} />
              <ServiceTile href="#/links" icon="🏦" title={t('ВлодБанк')} sub={t('Связка с паспортом')} />
              <ServiceTile href="#/orgs" icon="🏢" title="Организации" sub="ООО, АО, лицензии" />
              <ServiceTile href="#/domains" icon="🌐" title="Домены" sub="Сайты в БалНете" />
              <ServiceTile href={appUrl('bank')} icon="💳" title={t('Открыть ВлодБанк')} sub={t('Счета и карты')} />
            </div>
          </div>
          <div className="card">
            <h2>{t('Мои заявления')}</h2>
            {data.applications.length === 0 ? <p className="muted">{t('Заявлений пока нет')}</p> : (
              <div className="list">
                {data.applications.slice(0, 5).map((a) => (
                  <div key={a.id} className="list-item">
                    <div className="li-main"><div className="li-title">{t(a.title)}</div><div className="li-sub">{fmtDate(a.created_at)}{a.result_ref ? ` · ${a.result_ref}` : ''}</div></div>
                    <StatusBadge status={a.status} />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function ServiceTile({ href, icon, title, sub }) {
  return (
    <a href={href} className="card" style={{ padding: 14, boxShadow: 'none', color: 'inherit', textDecoration: 'none' }}>
      <div style={{ fontSize: '1.5rem' }}>{icon}</div>
      <b>{title}</b>
      <div className="muted small">{sub}</div>
    </a>
  );
}

function PassportPage() {
  const { data, loading } = useGovMe();
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  if (loading && !data) return <Spinner />;
  const p = data.passport;
  if (!p) return <PassportForm />;
  async function print() {
    setBusy(true);
    try {
      const canvas = await renderThermal(passportBlocks(p, t));
      const res = await shareCanvas(canvas, `passport-${p.number}.png`);
      if (res === 'downloaded') toast(t('PNG сохранён — откройте его в приложении принтера'), 'ok');
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="page medium">
      <div className="page-head">
        <h1>{t('Паспорт БФ')}</h1>
        <StatusBadge status={p.status} />
      </div>
      <div className="grid grid-2">
        <div className="stack">
          <IdCard p={p} />
          <div className="row">
            <button className="btn" onClick={print} disabled={busy}>{t('Печать 58 мм (PNG)')}</button>
            <button className="btn secondary" onClick={() => window.print()}>{t('Печать A4')}</button>
            <a className="btn ghost" href="#/passport/edit">{t('Изменить данные')}</a>
          </div>
        </div>
        <div className="card">
          <dl className="stack-sm" style={{ margin: 0 }}>
            <Row k={t('Номер')} v={<span className="mono">{p.number}</span>} />
            <Row k={t('Фамилия, имя')} v={p.full_name} />
            <Row k={t('Дата рождения')} v={fmtBirth(p.birth_date)} />
            <Row k={t('Прописка')} v={p.address || '—'} />
            <Row k={t('Семейное положение')} v={`${t(MARITAL[p.marital_status])}${p.spouse_name ? `, ${p.spouse_name}` : ''}`} />
            <Row k={t('Дети')} v={p.children?.length ? p.children.map((c) => `${c.name}${c.birth_date ? ` (${fmtBirth(c.birth_date)})` : ''}`).join(', ') : '—'} />
            <Row k={t('Выдан')} v={mmYY(p.issued_month)} />
            {p.expires_month !== null && <Row k={t('Действует до')} v={mmYY(p.expires_month)} />}
          </dl>
          <hr className="sep" />
          <p className="small muted">{t(DOC_DISCLAIMER)}</p>
        </div>
      </div>
    </div>
  );
}

function Row({ k, v }) {
  return (
    <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
      <span className="muted small">{k}</span>
      <span className="right" style={{ maxWidth: '65%' }}>{v}</span>
    </div>
  );
}

function PassportForm() {
  const { data, loading } = useGovMe();
  const [f, setF] = useState(null);
  const [done, setDone] = useState(null);
  useEffect(() => {
    if (data && !f) {
      const p = data.passport;
      setF({ full_name: p?.full_name || '', birth_date: p?.birth_date || '', photo: p?.photo || null, address: p?.address || '', marital_status: p?.marital_status || 'single', spouse_name: p?.spouse_name || '', children: p?.children || [] });
    }
  }, [data, f]);
  if ((loading && !data) || !f) return <Spinner />;
  const set = (k) => (e) => setF({ ...f, [k]: e.target ? e.target.value : e });
  if (done) {
    return (
      <div className="page narrow">
        <div className="card stack">
          <h2>{done.status === 'approved' ? t('Паспорт выдан') : t('Заявление принято')}</h2>
          {done.status === 'approved' && <p>{t('Номер паспорта')}: <b className="mono">{done.result_ref}</b></p>}
          {done.status === 'pending' && <p>{t('Заявление рассмотрит чиновник. Мы пришлём уведомление.')}</p>}
          {done.status === 'awaiting_payment' && <p>{t('Оплатите госпошлину — квитанция в разделе «Квитанции».')}</p>}
          <a className="btn" href={done.status === 'approved' ? '#/passport' : '#/'}>{t('Готово')}</a>
        </div>
      </div>
    );
  }
  return (
    <div className="page medium">
      <h1>{data.passport ? t('Замена паспорта / новые данные') : t('Заявление на паспорт БФ')}</h1>
      <div className="card">
        <Form submitLabel={t('Подать заявление')} onSubmit={async () => setDone((await post('/gov/passport', f)).application)}>
          <div className="grid grid-2">
            <Input label={t('Фамилия и имя')} required value={f.full_name} onChange={set('full_name')} />
            <Input label={t('Дата рождения')} type="date" required value={f.birth_date} onChange={set('birth_date')} />
          </div>
          <PhotoInput label={t('Фото (лицо, без головного убора)')} value={f.photo} onChange={set('photo')} maxSize={360} aspect={0.78} />
          <Input label={t('Игровая прописка')} placeholder={t('Город, улица, дом')} value={f.address} onChange={set('address')} />
          <div className="grid grid-2">
            <Select label={t('Семейное положение')} value={f.marital_status} onChange={set('marital_status')} options={Object.entries(MARITAL).map(([value, label]) => ({ value, label: t(label) }))} />
            {f.marital_status === 'married' && <Input label={t('Супруг(а)')} value={f.spouse_name} onChange={set('spouse_name')} />}
          </div>
          <div className="stack-sm">
            <span className="small muted">{t('Дети')}</span>
            {f.children.map((c, i) => (
              <div key={i} className="row nowrap">
                <input className="input" placeholder={t('Имя')} value={c.name} onChange={(e) => setF({ ...f, children: f.children.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)) })} />
                <input className="input" type="date" value={c.birth_date} onChange={(e) => setF({ ...f, children: f.children.map((x, j) => (j === i ? { ...x, birth_date: e.target.value } : x)) })} />
                <button type="button" className="btn ghost icon" onClick={() => setF({ ...f, children: f.children.filter((_, j) => j !== i) })}>✕</button>
              </div>
            ))}
            <div><button type="button" className="btn secondary sm" onClick={() => setF({ ...f, children: [...f.children, { name: '', birth_date: '' }] })}>+ {t('Добавить ребёнка')}</button></div>
          </div>
        </Form>
      </div>
    </div>
  );
}

function DocumentsPage() {
  const { data, loading, reload } = useGovMe();
  const [ipForm, setIpForm] = useState(null);
  const [show, setShow] = useState(null);
  if (loading && !data) return <Spinner />;
  const docs = data.documents;
  const inn = docs.find((d) => d.type === 'inn' && d.status === 'active');
  const ip = docs.find((d) => d.type === 'ip' && d.status === 'active');
  const pending = (type) => data.applications.find((a) => a.type === type && ['pending', 'awaiting_payment'].includes(a.status));
  return (
    <div className="page">
      <h1>{t('Документы')}</h1>
      {!data.passport && <div className="form-warn" style={{ marginBottom: 16 }}>{t('Сначала оформите паспорт БФ')} — <a href="#/passport/edit">{t('оформить')}</a></div>}
      <div className="grid grid-2">
        <div className="card stack">
          <div className="card-head"><h2>{t('ИНН')}</h2>{inn && <StatusBadge status="active" />}</div>
          {inn ? <p>{t('Номер')}: <b className="mono">{inn.number}</b></p> : pending('inn') ? <StatusBadge status={pending('inn').status} /> : (
            <>
              <p className="muted">{t('Идентификационный номер налогоплательщика. Нужен для ИП.')}</p>
              <ActionButton disabled={!data.passport} action={async () => { await post('/gov/documents/inn'); reload(); }} okMessage={t('Заявление подано')}>{t('Получить ИНН')}</ActionButton>
            </>
          )}
        </div>
        <div className="card stack">
          <div className="card-head"><h2>{t('Индивидуальный предприниматель')}</h2>{ip && <StatusBadge status="active" />}</div>
          {ip ? (
            <>
              <p>{t('Свидетельство')}: <b className="mono">{ip.number}</b></p>
              <p className="small">{ip.data.trade_name}{ip.data.activity ? ` — ${ip.data.activity}` : ''}</p>
              <p className="small muted">{t('Дальше: откройте бизнес-счёт во ВлодБанке и создайте магазин в кассе.')}</p>
              <div className="row">
                <a className="btn secondary" href={appUrl('bank', '/open')}>{t('Бизнес-счёт')}</a>
                <a className="btn secondary" href={appUrl('pos')}>{t('Касса')}</a>
              </div>
            </>
          ) : pending('ip') ? (
            <>
              <StatusBadge status={pending('ip').status} />
              {pending('ip').status === 'awaiting_payment' && <a className="btn" href="#/invoices">{t('Оплатить госпошлину')}</a>}
            </>
          ) : (
            <>
              <p className="muted">{t('Регистрация ИП даёт право открыть бизнес-счёт и магазин.')}</p>
              <button className="btn" disabled={!inn} onClick={() => setIpForm({ trade_name: '', activity: '' })}>{t('Зарегистрировать ИП')}</button>
              {!inn && <p className="small muted">{t('Сначала получите ИНН')}</p>}
            </>
          )}
        </div>
      </div>
      {docs.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>{t('Все документы')}</h2>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('Документ')}</th><th>{t('Номер')}</th><th>{t('Выдан')}</th><th>{t('Статус')}</th><th /></tr></thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td>{t(DOC_TITLES[d.type] || d.type)}</td>
                    <td className="mono">{d.number}</td>
                    <td>{mmYY(d.issued_month)}</td>
                    <td><StatusBadge status={d.status} /></td>
                    <td className="right"><button className="btn ghost sm" onClick={() => setShow(d)}>QR</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
      {ipForm && (
        <Modal title={t('Регистрация ИП')} onClose={() => setIpForm(null)}>
          <IpForm onDone={() => { setIpForm(null); reload(); }} />
        </Modal>
      )}
      {show && (
        <Modal title={t(DOC_TITLES[show.type])} onClose={() => setShow(null)}>
          <div className="stack center" style={{ alignItems: 'center' }}>
            <b className="mono">{show.number}</b>
            <QR value={appUrl('services', `/verify/document/${show.verify_code}`)} size={200} />
            <p className="small muted">{t(DOC_DISCLAIMER)}</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

function IpForm({ onDone }) {
  const { data: s } = useAsync(() => get('/public/settings'), []);
  const [f, setF] = useState({ trade_name: '', activity: '' });
  return (
    <Form submitLabel={t('Подать заявление')} onSubmit={async () => { await post('/gov/documents/ip', f); onDone(); }}>
      <Input label={t('Название (вывеска)')} required value={f.trade_name} onChange={(e) => setF({ ...f, trade_name: e.target.value })} />
      <Input label={t('Вид деятельности')} placeholder={t('Например: продажа продуктов')} value={f.activity} onChange={(e) => setF({ ...f, activity: e.target.value })} />
      {s && <p className="small muted">{t('Госпошлина')}: <Money value={s.fee_ip} /></p>}
    </Form>
  );
}

function InvoicesPage() {
  const { data, loading } = useAsync(() => get('/gov/invoices'), []);
  if (loading && !data) return <Spinner />;
  return (
    <div className="page medium">
      <h1>{t('Квитанции')}</h1>
      <p className="muted">{t('Оплатить можно во ВлодБанке или наличными на любой кассе по номеру квитанции.')}</p>
      {!data.invoices.length ? <Empty>{t('Квитанций нет')}</Empty> : (
        <div className="stack">
          {data.invoices.map((i) => (
            <div key={i.number} className="card">
              <div className="row" style={{ justifyContent: 'space-between' }}>
                <div>
                  <b>{t(i.purpose)}</b>
                  <div className="small muted">№ <span className="mono">{i.number}</span> · {fmtDate(i.created_at)}</div>
                </div>
                <div className="right">
                  <div style={{ fontSize: '1.2rem', fontWeight: 700 }}><Money value={i.amount} /></div>
                  <StatusBadge status={i.status} />
                </div>
              </div>
              {i.status === 'unpaid' && (
                <div className="row" style={{ marginTop: 12 }}>
                  <a className="btn" href={appUrl('bank', `/pay/${i.number}`)}>{t('Оплатить во ВлодБанке')}</a>
                  <span className="small muted">{t('или назовите номер на кассе')}</span>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ApplicationsPage() {
  const { data, loading, reload } = useAsync(() => get('/gov/applications'), []);
  if (loading && !data) return <Spinner />;
  return (
    <div className="page medium">
      <h1>{t('Заявления')}</h1>
      {!data.applications.length ? <Empty>{t('Заявлений пока нет')}</Empty> : (
        <div className="card">
          <div className="list">
            {data.applications.map((a) => (
              <div key={a.id} className="list-item">
                <div className="li-main">
                  <div className="li-title">{t(a.title)} <span className="muted small">№{a.id}</span></div>
                  <div className="li-sub">{fmtDate(a.created_at)}{a.result_ref ? ` · ${a.result_ref}` : ''}{a.comment ? ` · ${a.comment}` : ''}</div>
                </div>
                <StatusBadge status={a.status} />
                {['pending', 'awaiting_payment'].includes(a.status) && <ActionButton kind="ghost" size="sm" confirm={t('Отозвать заявление?')} action={async () => { await post(`/gov/applications/${a.id}/cancel`); reload(); }}>{t('Отозвать')}</ActionButton>}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function LinksPage() {
  const { data, loading, reload } = useAsync(() => get('/gov/links'), []);
  if (loading && !data) return <Spinner />;
  return (
    <div className="page medium">
      <h1>{t('Связка с ВлодБанком')}</h1>
      <p className="muted">{t('Аккаунт ВлодБанка отдельный. Подтвердите здесь, что он ваш, — тогда банк откроет вам счета.')}</p>
      <div className="card">
        <h2>{t('Запросы на подтверждение')}</h2>
        {!data.links.length ? <p className="muted">{t('Новых запросов нет')}</p> : (
          <div className="list">
            {data.links.map((l) => (
              <div key={l.id} className="list-item">
                <div className="li-main"><div className="li-title">{l.full_name}</div><div className="li-sub">{l.email} · {fmtDate(l.created_at)}</div></div>
                <ActionButton kind="ok-btn" size="sm" action={async () => { await post(`/gov/links/${l.id}/confirm`); reload(); }} okMessage={t('Подтверждено')}>{t('Это я')}</ActionButton>
                <ActionButton kind="ghost" size="sm" action={async () => { await post(`/gov/links/${l.id}/reject`); reload(); }}>{t('Не я')}</ActionButton>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="card">
        <h2>{t('Привязанные аккаунты')}</h2>
        {!data.linked.length ? <p className="muted">{t('Пока нет')}</p> : data.linked.map((b) => <div key={b.id}>{b.full_name} · <span className="muted">{b.email}</span></div>)}
      </div>
    </div>
  );
}

function QueuePage() {
  const { data, loading, reload, error } = useAsync(() => get('/gov/queue'), []);
  const [reject, setReject] = useState(null);
  const [comment, setComment] = useState('');
  useChannel('admin', (m) => m.type === 'queue' && reload());
  if (loading && !data) return <Spinner />;
  if (error) return <div className="page"><ErrorBox error={error} /></div>;
  return (
    <div className="page">
      <h1>{t('Рассмотрение заявлений')}</h1>
      {!data.applications.length ? <Empty>{t('Очередь пуста')}</Empty> : (
        <div className="grid grid-auto">
          {data.applications.map((a) => (
            <div key={a.id} className="card stack">
              <div className="card-head"><h3>{t(a.title)} №{a.id}</h3></div>
              {a.photo && <img src={a.photo} alt="" style={{ width: 120, borderRadius: 8 }} />}
              <div className="small">
                <div><b>{a.data.full_name || a.display_name}</b></div>
                {a.data.birth_date && <div>{t('Дата рождения')}: {fmtBirth(a.data.birth_date)}</div>}
                {a.data.address && <div>{t('Прописка')}: {a.data.address}</div>}
                {a.data.trade_name && <div>{t('Название')}: {a.data.trade_name}</div>}
                <div className="muted">{a.email} · {fmtDate(a.created_at)}</div>
              </div>
              <div className="row">
                <ActionButton kind="ok-btn" size="sm" action={async () => { await post(`/gov/applications/${a.id}/approve`); reload(); }} okMessage={t('Одобрено')}>{t('Одобрить')}</ActionButton>
                <button className="btn ghost sm" onClick={() => { setReject(a); setComment(''); }}>{t('Отказать')}</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {reject && (
        <Modal title={t('Отказ')} onClose={() => setReject(null)}>
          <Form submitLabel={t('Отказать')} submitKind="danger" onSubmit={async () => { await post(`/gov/applications/${reject.id}/reject`, { comment }); setReject(null); reload(); }}>
            <Input label={t('Причина')} value={comment} onChange={(e) => setComment(e.target.value)} />
          </Form>
        </Modal>
      )}
    </div>
  );
}

// ——— Публичная проверка по QR ———

function VerifyShell({ title, children }) {
  return (
    <div className="page narrow">
      <div className="card stack">
        <div className="row"><CoatOfArms size={36} /><div><b>{t('Проверка документа')}</b><div className="small muted">{title}</div></div><div className="grow" /><Flag width={36} /></div>
        {children}
      </div>
    </div>
  );
}

function Verdict({ ok, children }) {
  return <div className={ok ? 'form-ok' : 'form-error'} style={{ fontSize: '1.05rem', fontWeight: 600 }}>{ok ? '✓ ' : '✕ '}{children}</div>;
}

function VerifyPassport({ code }) {
  const { data, loading } = useAsync(() => get(`/gov/verify/passport/${code}`), [code]);
  return (
    <VerifyShell title={t('Паспорт БФ')}>
      {loading && !data ? <Spinner /> : !data.number ? <Verdict ok={false}>{t('Паспорт не найден')}</Verdict> : (
        <>
          <Verdict ok={data.valid}>{data.valid ? t('Паспорт действителен') : t('Паспорт недействителен')}</Verdict>
          <div className="row nowrap" style={{ alignItems: 'flex-start' }}>
            {data.photo && <img src={data.photo} alt="" style={{ width: 96, borderRadius: 8 }} />}
            <div className="stack-sm">
              <b style={{ fontSize: '1.1rem' }}>{data.full_name}</b>
              <span>{t('Дата рождения')}: {fmtBirth(data.birth_date)}</span>
              <span>{t('Возраст')}: <b>{data.age}</b> {data.age >= 18 ? <Badge kind="ok">18+</Badge> : <Badge kind="err">{t('до 18')}</Badge>}</span>
              <span className="mono">{data.number}</span>
            </div>
          </div>
        </>
      )}
    </VerifyShell>
  );
}

function VerifyDocument({ code }) {
  const { data, loading } = useAsync(() => get(`/gov/verify/document/${code}`), [code]);
  return (
    <VerifyShell title={t('Документ БФ')}>
      {loading && !data ? <Spinner /> : !data.number ? <Verdict ok={false}>{t('Документ не найден')}</Verdict> : (
        <>
          <Verdict ok={data.valid}>{t(DOC_TITLES[data.type])}: {data.valid ? t('действителен') : t('недействителен')}</Verdict>
          <div><b>{data.full_name}</b></div>
          <div className="mono">{data.number}</div>
          {data.data?.trade_name && <div>{data.data.trade_name}</div>}
        </>
      )}
    </VerifyShell>
  );
}

function VerifyReceipt({ code }) {
  const { data, loading } = useAsync(() => get(`/gov/verify/receipt/${code}`), [code]);
  return (
    <VerifyShell title={t('Кассовый чек')}>
      {loading && !data ? <Spinner /> : !data.valid ? <Verdict ok={false}>{t('Чек не найден')}</Verdict> : (
        <>
          <Verdict ok>{t('Чек зарегистрирован')}</Verdict>
          <div><b>{data.shop.name}</b><div className="small muted">{t('ИНН')} {data.shop.inn} · {data.shop.address}</div></div>
          <div className="small">{t('Чек')} №{data.number} · {fmtDate(data.paid_at)}</div>
          <div className="list">
            {data.items.map((i, n) => (
              <div key={n} className="list-item"><div className="li-main">{i.name}</div><Money value={Number(i.total)} /></div>
            ))}
          </div>
          <div className="row" style={{ justifyContent: 'space-between' }}><b>{t('Итого')}</b><b><Money value={data.total} /></b></div>
          <div className="row small muted" style={{ justifyContent: 'space-between' }}><span>{t('в т.ч. НДС')}</span><Money value={data.vat} /></div>
          {data.refunded > 0 && <div className="row small" style={{ justifyContent: 'space-between' }}><span>{t('Возвращено')}</span><Money value={data.refunded} /></div>}
        </>
      )}
    </VerifyShell>
  );
}
