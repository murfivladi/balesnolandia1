// ВлодБанк Оплата (pay.bank.bln, этап Н9): страница оплаты для сайтов БалНета (карта и PIN или счёт ВлодБанка),
// кабинет бизнеса (ключи API, вебхуки, платежи и возвраты, подписки, онлайн-заказы, доставка), документация API,
// покупки покупателя и работа курьера.
import { useEffect, useState } from 'react';
import { get, post, patch } from '../shared/api.js';
import { fmtDate } from '../shared/i18n.js';
import { useRoute, pick, navigate } from '../shared/router.js';
import {
  Topbar, NavLink, Spinner, useAsync, Empty, ErrorBox, Badge, Button, ActionButton, Input, Select, Field, Form, Money, MoneyInput, Modal, Tabs, QR, useToast, useChannel,
} from '../shared/ui.jsx';
import { LoginForm } from '../shared/auth.jsx';
import { BankLogo } from '../shared/brand.jsx';
import { SiteFooter, Hero, Section, Features } from '../shared/site.jsx';
import { formatMoney } from '@bln/shared/money.js';
import { PurchasesPage, CourierPage, StatusBadge, PAY_STATUS, ORDER_STATUS, SUB_STATUS, PHYSICAL } from './purchases.jsx';
import { DocsPage } from './docs.jsx';

/** Открыть адрес БалНета во вкладке ВлодБраузера (страница оплаты работает во фрейме браузера). */
export function openInBrowser(url) {
  try {
    if (typeof window.__balnetOpen === 'function') { window.__balnetOpen(url); return; }
  } catch { /* не во ВлодБраузере */ }
  window.open(`../#${url}`, '_top');
}

export default function App() {
  const route = useRoute();
  const [me, setMe] = useState(undefined);
  const loadMe = () => get('/auth/me').then((r) => setMe(r.bank || null)).catch(() => setMe(null));
  useEffect(() => { loadMe(); }, []);
  const needBank = (render) => {
    if (me === undefined) return <Spinner />;
    if (!me) return <BankLoginCard onDone={loadMe} />;
    return render(me);
  };
  const body = pick([
    ['/c/:id', (p) => <Checkout id={p.id} me={me} onLogin={loadMe} />],
    ['/business', () => needBank(() => <Business />)],
    ['/business/:id', (p) => needBank(() => <Merchant id={Number(p.id)} />)],
    ['/docs', () => <DocsPage />],
    ['/purchases', () => needBank(() => <PurchasesPage />)],
    ['/courier', () => needBank(() => <CourierPage />)],
    ['*', () => <Landing />],
  ], route.path);
  const checkout = route.path.startsWith('/c/');
  return (
    <>
      <Topbar
        variant="site"
        brand={<><BankLogo /> <span>ВлодБанк <b>Оплата</b></span></>}
        nav={checkout ? null : (
          <>
            <NavLink href="#/business" path={route.path}>Бизнесу</NavLink>
            <NavLink href="#/docs" path={route.path}>Документация API</NavLink>
            <NavLink href="#/purchases" path={route.path}>Мои покупки</NavLink>
            <NavLink href="#/courier" path={route.path}>Курьерам</NavLink>
          </>
        )}
        right={me ? <span className="tb-btn" title={me.email}>👤 {me.full_name.split(' ')[0]}</span> : null}
      />
      <main style={{ flex: 1 }}>{body}</main>
      {!checkout && (
        <SiteFooter
          brand="ВлодБанк Оплата"
          about="Эквайринг ВлодБанка для сайтов БалНета: оплата картой и со счёта, возвраты, подписки, интернет-магазин на складе Кассы."
          columns={[
            { title: 'Бизнесу', links: [{ href: '#/business', label: 'Кабинет' }, { href: '#/docs', label: 'API и вебхуки' }, { href: '#/docs?s=oauth', label: 'Вход через ВлодПочту' }] },
            { title: 'Покупателям', links: [{ href: '#/purchases', label: 'Мои покупки' }, { href: '#/courier', label: 'Стать курьером' }, { href: '../bank/#/', label: 'ВлодБанк' }] },
          ]}
        />
      )}
    </>
  );
}

function BankLoginCard({ onDone, title = 'Вход во ВлодБанк' }) {
  return (
    <div className="page narrow">
      <div className="login-card">
        <h2>{title}</h2>
        <p className="muted">Аккаунт ВлодБанка. Нет счёта — откройте его на <a href="../bank/#/">bank.bln</a>.</p>
        <LoginForm kind="bank" onDone={onDone} />
      </div>
    </div>
  );
}

function Landing() {
  const s = useAsync(() => get('/public/settings').catch(() => ({})), []);
  const fee = s.data?.online_fee_bp;
  return (
    <>
      <Hero kicker="pay.bank.bln · эквайринг ВлодБанка" title="Принимайте оплату на своём сайте" lead="Платёжная страница ВлодБанка, API для server.js, вебхуки с подписью, возвраты и подписки. Деньги — на бизнес-счёт, НДС уходит в бюджет сам." art="💳">
        <div className="row">
          <a className="btn light" href="#/business">Подключить магазин</a>
          <a className="btn ghost light" href="#/docs">Документация</a>
        </div>
      </Hero>
      <Section title="Как это работает">
        <Features items={[
          { icon: '🧾', title: 'Платёж по API', text: 'Сервер сайта создаёт платёж (POST /api/v1/payments) и отправляет покупателя на страницу pay.bank.bln.' },
          { icon: '🔐', title: 'Карта и PIN или счёт', text: 'Покупатель платит картой ВлодБанка с PIN или со своего счёта, войдя в банк. Сайт не видит данных карты.' },
          { icon: '📨', title: 'Вебхуки', text: 'После оплаты на сайт приходит событие payment.succeeded с подписью HMAC-SHA256 — проверьте её в server.js.' },
          { icon: '🛒', title: 'Магазин на складе Кассы', text: 'Каталог и остатки — из Кассы. Онлайн-заказ — это чек в Кассе: склад, кухня, баллы и отчёты как в зале.' },
          { icon: '🚚', title: 'Доставка', text: 'Самовывоз по коду, курьеры-игроки с подтверждением по QR, цифровые товары сразу после оплаты.' },
          { icon: '↩️', title: 'Возвраты и подписки', text: 'Полные и частичные возвраты, подписки с автосписанием каждый игровой месяц.' },
        ]} />
      </Section>
      <Section title="Тарифы" muted>
        <div className="grid grid-3">
          <div className="card"><h3>Комиссия банка</h3><p className="stat"><span className="value">{fee === undefined ? '—' : `${fee / 100}%`}</span><span className="label">от суммы без НДС, только с успешных оплат</span></p></div>
          <div className="card"><h3>НДС</h3><p>Включён в цену. Банк сам перечисляет его в Госбюджет БФ при оплате и забирает обратно при возврате.</p></div>
          <div className="card"><h3>Подключение</h3><p>Бесплатно для ИП с бизнес-счётом и организаций БФ. Ключи API — сразу.</p></div>
        </div>
      </Section>
    </>
  );
}

// ——— Страница оплаты ———

function Checkout({ id, me, onLogin }) {
  const { data, error, loading, reload } = useAsync(() => get(`/pay/checkout/${id}`), [id, me?.id]);
  const [mode, setMode] = useState(null);
  const [done, setDone] = useState(null);
  useChannel(`pay:${id}`, () => reload());
  if (error) return <div className="page narrow"><ErrorBox error={error} /></div>;
  if (loading && !data) return <Spinner />;
  const p = data.payment;
  const back = (url) => { if (url) openInBrowser(url); };
  const finished = (r) => { setDone(r); setTimeout(() => back(r.redirect), 1500); };
  const method = mode || (p.kind === 'subscription' ? 'account' : data.payer ? 'account' : 'card');
  return (
    <div className="page narrow pay-checkout">
      <div className="card pay-summary">
        <div className="muted small">Оплата на сайте</div>
        <h2 style={{ margin: '4px 0' }}>{p.merchant.name}</h2>
        {p.merchant.site_url && <div className="small muted">{p.merchant.site_url.replace(/^https?:\/\//, '').replace(/\/$/, '')}</div>}
        <div className="pay-amount"><Money value={p.amount} /></div>
        <div>{p.description}</div>
        {p.subscription && <p className="small"><Badge kind="warn">Подписка</Badge> Сейчас списывается первый платёж, дальше — <b>{formatMoney(p.amount)} раз в {p.subscription.period_months} игр. мес.</b> со счёта. Отменить можно в разделе «Покупки».</p>}
        {p.items?.length > 0 && (
          <div className="list" style={{ marginTop: 8 }}>
            {p.items.map((i, n) => <div key={n} className="list-item"><div className="li-main"><div className="li-title">{i.name}</div><div className="li-sub">{i.qty} × {formatMoney(i.price)}</div></div><Money value={i.total ?? i.qty * i.price} /></div>)}
            {p.order?.delivery_fee > 0 && <div className="list-item"><div className="li-main">Доставка курьером</div><Money value={p.order.delivery_fee} /></div>}
          </div>
        )}
        {p.order && <p className="small muted">Доставка: {{ pickup: 'самовывоз из магазина', courier: `курьер, ${p.order.address}`, digital: 'цифровой товар — сразу после оплаты', physical: `реальная доставка (после одобрения админа), ${p.order.address}` }[p.order.delivery]}</p>}
        {p.age_limit > 0 && <p className="small"><Badge kind="warn">{p.age_limit}+</Badge> Возраст проверяется по паспорту БФ владельца счёта.</p>}
        <div className="tiny muted">в т.ч. НДС {p.vat_bp / 100}% · платёж {p.id}</div>
      </div>
      {done ? (
        <div className="card center stack">
          <div style={{ fontSize: 48 }}>✅</div>
          <h2>Оплачено</h2>
          <p className="muted">Возвращаем на сайт магазина…</p>
          {done.redirect && <Button onClick={() => back(done.redirect)}>Вернуться на сайт</Button>}
        </div>
      ) : p.status !== 'pending' ? (
        <div className="card center stack">
          <StatusBadge map={PAY_STATUS} status={p.status} />
          <p>{p.status === 'paid' || p.status.includes('refunded') ? 'Этот платёж уже оплачен.' : 'Ссылка на оплату больше не действует. Вернитесь на сайт и оформите заказ заново.'}</p>
          {p.return_url && <Button onClick={() => back(p.return_url)}>На сайт магазина</Button>}
        </div>
      ) : !p.merchant.active ? (
        <div className="card"><ErrorBox error={{ message: 'Магазин временно не принимает оплату' }} /></div>
      ) : (
        <div className="card">
          {p.kind !== 'subscription' && (
            <Tabs value={method} onChange={setMode} tabs={[{ value: 'card', label: '💳 Картой' }, { value: 'account', label: '🏦 Со счёта ВлодБанка' }]} />
          )}
          {method === 'card' ? <CardForm id={id} onDone={finished} /> : data.payer ? <AccountForm id={id} payer={data.payer} onDone={finished} /> : <LoginForm kind="bank" onDone={onLogin} />}
          <div className="row" style={{ marginTop: 12, justifyContent: 'space-between' }}>
            <span className="tiny muted">🔒 Данные карты видит только ВлодБанк</span>
            <ActionButton kind="ghost" size="sm" action={async () => { const r = await post(`/pay/checkout/${id}/cancel`); back(r.redirect); reload(); }}>Отказаться от оплаты</ActionButton>
          </div>
        </div>
      )}
    </div>
  );
}

function CardForm({ id, onDone }) {
  const [number, setNumber] = useState('');
  const [exp, setExp] = useState('');
  const [pin, setPin] = useState('');
  return (
    <Form submitLabel="Оплатить" onSubmit={async () => onDone(await post(`/pay/checkout/${id}/card`, { number, exp, pin }))}>
      <Input label="Номер карты" inputMode="numeric" autoComplete="cc-number" placeholder="77•• •••• ••••" value={number} onChange={(e) => setNumber(e.target.value.replace(/[^\d ]/g, '').slice(0, 15))} required />
      <div className="grid grid-2">
        <Input label="Срок (ММ/ГГ)" placeholder="12/29" autoComplete="cc-exp" value={exp} onChange={(e) => setExp(e.target.value.replace(/[^\d/]/g, '').slice(0, 5))} required />
        <Input label="PIN" type="password" inputMode="numeric" autoComplete="off" maxLength={3} value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 3))} required />
      </div>
    </Form>
  );
}

function AccountForm({ id, payer, onDone }) {
  const [acc, setAcc] = useState(payer.accounts[0]?.id || '');
  if (!payer.verified) return <ErrorBox error={{ message: 'Подтвердите паспорт БФ во ВлодУслугах, чтобы платить со счёта' }} />;
  if (!payer.accounts.length) return <Empty>Нет счетов для оплаты</Empty>;
  return (
    <Form submitLabel="Оплатить со счёта" onSubmit={async () => onDone(await post(`/pay/checkout/${id}/account`, { account_id: Number(acc) }))}>
      <p className="small">Плательщик: <b>{payer.name}</b></p>
      <Select label="Счёт" value={acc} onChange={(e) => setAcc(e.target.value)} options={payer.accounts.map((a) => ({ value: a.id, label: `${a.name} · ${formatMoney(a.balance)}` }))} />
    </Form>
  );
}

// ——— Кабинет бизнеса ———

function Business() {
  const list = useAsync(() => get('/pay/merchants'), []);
  const [create, setCreate] = useState(false);
  const [keys, setKeys] = useState(null);
  if (list.error) return <div className="page"><ErrorBox error={list.error} /></div>;
  if (!list.data) return <Spinner />;
  return (
    <div className="page">
      <div className="page-head"><h1>Эквайринг: мои магазины</h1><Button onClick={() => setCreate(true)}>+ Подключить магазин</Button></div>
      {!list.data.merchants.length ? (
        <Empty>Магазинов пока нет. Подключите бизнес-счёт ИП или счёт организации — и получите ключи API.</Empty>
      ) : (
        <div className="grid grid-auto">
          {list.data.merchants.map((m) => (
            <a key={m.id} className="card pay-merchant" href={`#/business/${m.id}`}>
              <div className="row-between"><h3 style={{ margin: 0 }}>{m.name}</h3>{m.status === 'blocked' ? <Badge kind="err">Остановлен</Badge> : <Badge kind="ok">Принимает оплату</Badge>}</div>
              <div className="small muted">{m.site_url || 'сайт не указан'}{m.shop ? ` · Касса: ${m.shop.name}` : ''}</div>
              <dl className="kv small" style={{ marginTop: 8 }}>
                <dt>Оплат</dt><dd>{m.stats.payments}</dd>
                <dt>Оборот</dt><dd><Money value={m.stats.amount} /></dd>
                <dt>Вам на счёт</dt><dd><Money value={m.stats.net} /></dd>
              </dl>
            </a>
          ))}
        </div>
      )}
      {create && <CreateMerchant onClose={() => setCreate(false)} onDone={(r) => { setCreate(false); setKeys(r); list.reload(); }} />}
      {keys && <KeysModal keys={keys.keys} secret={keys.merchant.webhook_secret} onClose={() => { navigate(`/business/${keys.merchant.id}`); setKeys(null); }} />}
    </div>
  );
}

function CreateMerchant({ onClose, onDone }) {
  const opts = useAsync(() => get('/pay/merchant-options'), []);
  const [f, setF] = useState({ name: '', account_id: '', shop_id: '', site_url: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  if (!opts.data) return <Modal title="Подключить магазин" onClose={onClose}>{opts.error ? <ErrorBox error={opts.error} /> : <Spinner />}</Modal>;
  const o = opts.data;
  return (
    <Modal title="Подключить магазин" onClose={onClose}>
      {!o.accounts.length ? <Empty>Нужен бизнес-счёт ИП (откройте во ВлодБанке после регистрации ИП во ВлодУслугах) или счёт организации, где вы директор.</Empty> : (
        <Form submitLabel="Подключить" onSubmit={async () => onDone(await post('/pay/merchants', { ...f, account_id: Number(f.account_id) || null, shop_id: Number(f.shop_id) || null }))}>
          <Input label="Название (видно покупателю)" value={f.name} onChange={set('name')} required />
          <Input label="Сайт" placeholder="https://shop.vasya.bln/" value={f.site_url} onChange={set('site_url')} />
          <Select label="Магазин Кассы (для интернет-магазина)" value={f.shop_id} onChange={set('shop_id')} options={[{ value: '', label: '— без каталога, только платежи —' }, ...o.shops.map((s) => ({ value: s.id, label: s.name }))]} />
          {!f.shop_id && <Select label="Счёт для зачислений" value={f.account_id} onChange={set('account_id')} options={[{ value: '', label: 'Выберите счёт' }, ...o.accounts.map((a) => ({ value: a.id, label: `${a.title} · ${a.number}` }))]} />}
          {f.shop_id && <p className="small muted">Деньги будут поступать на бизнес-счёт магазина — туда же, куда и выручка кассы.</p>}
        </Form>
      )}
    </Modal>
  );
}

function KeysModal({ keys, secret, onClose }) {
  return (
    <Modal title="Ключи API" onClose={onClose} footer={<Button onClick={onClose}>Я сохранил ключи</Button>}>
      <p>Секретный ключ показывается <b>один раз</b>. Храните его только в server.js или настройках сервера — не в коде страниц.</p>
      <Field label="Публичный ключ (каталог товаров)"><code className="pay-key">{keys.publishable}</code></Field>
      <Field label="Секретный ключ"><code className="pay-key">{keys.secret}</code></Field>
      {secret && <Field label="Секрет подписи вебхуков"><code className="pay-key">{secret}</code></Field>}
    </Modal>
  );
}

function Merchant({ id }) {
  const m = useAsync(() => get(`/pay/merchants/${id}`), [id]);
  const [tab, setTab] = useState('payments');
  if (m.error) return <div className="page"><ErrorBox error={m.error} /></div>;
  if (!m.data) return <Spinner />;
  const mm = m.data.merchant;
  return (
    <div className="page">
      <div className="page-head">
        <h1>{mm.name}</h1>
        {mm.status === 'blocked' && <Badge kind="err">Приём платежей остановлен админом</Badge>}
        <a className="btn ghost" href="#/business">← Все магазины</a>
      </div>
      <div className="grid grid-4">
        <div className="card stat"><span className="label">Оплат</span><span className="value">{mm.stats.payments}</span></div>
        <div className="card stat"><span className="label">Оборот</span><span className="value"><Money value={mm.stats.amount} /></span></div>
        <div className="card stat"><span className="label">НДС и комиссия</span><span className="value"><Money value={mm.stats.vat + mm.stats.fee} /></span></div>
        <div className="card stat"><span className="label">На счёт (за вычетом возвратов)</span><span className="value"><Money value={mm.stats.net} /></span></div>
      </div>
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'payments', label: 'Платежи' },
        { value: 'link', label: 'Ссылка на оплату' },
        ...(mm.shop ? [{ value: 'orders', label: `Заказы${mm.stats.open_orders ? ` (${mm.stats.open_orders})` : ''}` }] : []),
        { value: 'subs', label: 'Подписки' },
        { value: 'events', label: 'Вебхуки' },
        { value: 'settings', label: 'Настройки и ключи' },
      ]} />
      {tab === 'payments' && <Payments id={id} onChange={m.reload} />}
      {tab === 'link' && <PayLink id={id} />}
      {tab === 'orders' && <Orders id={id} />}
      {tab === 'subs' && <Subs id={id} />}
      {tab === 'events' && <Events id={id} />}
      {tab === 'settings' && <Settings m={mm} onChange={m.reload} />}
    </div>
  );
}

function Payments({ id, onChange }) {
  const list = useAsync(() => get(`/pay/merchants/${id}/payments`), [id]);
  const [refund, setRefund] = useState(null);
  if (!list.data) return list.error ? <ErrorBox error={list.error} /> : <Spinner />;
  if (!list.data.payments.length) return <Empty>Платежей пока нет. Создайте первый через API или ссылку на оплату.</Empty>;
  return (
    <div className="card">
      <div className="list">
        {list.data.payments.map((p) => (
          <div key={p.id} className="list-item">
            <div className="li-main">
              <div className="li-title">{p.description}</div>
              <div className="li-sub mono">{p.id} · {fmtDate(p.paid_at || p.created_at)}{p.payer_name ? ` · ${p.payer_name}` : ''}{p.method ? ` · ${p.method === 'card' ? 'карта' : 'счёт'}` : ''}{p.refunded ? ` · возвращено ${formatMoney(p.refunded)}` : ''}</div>
            </div>
            <Money value={p.amount} />
            <StatusBadge map={PAY_STATUS} status={p.status} />
            {['paid', 'partially_refunded'].includes(p.status) && <Button size="sm" kind="ghost" onClick={() => setRefund(p)}>Возврат</Button>}
          </div>
        ))}
      </div>
      {refund && <RefundModal id={id} p={refund} onClose={() => setRefund(null)} onDone={() => { setRefund(null); list.reload(); onChange(); }} />}
    </div>
  );
}

function RefundModal({ id, p, onClose, onDone }) {
  const left = p.amount - p.refunded;
  const [amount, setAmount] = useState(left);
  const [reason, setReason] = useState('');
  return (
    <Modal title={`Возврат: ${p.description}`} onClose={onClose}>
      <Form submitLabel="Вернуть деньги" onSubmit={async () => { await post(`/pay/merchants/${id}/payments/${p.id}/refund`, { amount: p.kind === 'order' ? undefined : amount, reason }); onDone(); }}>
        {p.kind === 'order'
          ? <p>Заказ возвращается целиком: деньги покупателю, товары — на склад Кассы. Частичный возврат заказа — по позициям через API или чек в Кассе.</p>
          : <MoneyInput label={`Сумма (можно до ${formatMoney(left)})`} value={amount} onChange={setAmount} />}
        <Input label="Причина" value={reason} onChange={(e) => setReason(e.target.value)} />
        <p className="small muted">НДС вернётся из бюджета, комиссия банка не возвращается. Деньги спишутся с вашего счёта.</p>
      </Form>
    </Modal>
  );
}

function PayLink({ id }) {
  const [f, setF] = useState({ amount: 0, description: '', return_url: '' });
  const [link, setLink] = useState(null);
  return (
    <div className="grid grid-2">
      <div className="card">
        <h2>Ссылка на оплату</h2>
        <p className="small muted">Без своего сайта: отправьте ссылку покупателю в почте или чате — он оплатит на pay.bank.bln.</p>
        <Form submitLabel="Создать ссылку" onSubmit={async () => setLink((await post(`/pay/merchants/${id}/payments`, { ...f, return_url: f.return_url || undefined })).payment)}>
          <MoneyInput label="Сумма" value={f.amount} onChange={(v) => setF({ ...f, amount: v })} />
          <Input label="За что" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} required />
          <Input label="Куда вернуть после оплаты (необязательно)" placeholder="https://…" value={f.return_url} onChange={(e) => setF({ ...f, return_url: e.target.value })} />
        </Form>
      </div>
      {link && (
        <div className="card center stack">
          <QR value={link.url} size={180} />
          <code className="pay-key">{link.url}</code>
          <Button kind="ghost" onClick={() => openInBrowser(link.url)}>Открыть страницу оплаты</Button>
          <span className="tiny muted">Ссылка действует до {fmtDate(link.expires_at)}</span>
        </div>
      )}
    </div>
  );
}

function Orders({ id }) {
  const list = useAsync(() => get(`/pay/merchants/${id}/orders`), [id]);
  if (!list.data) return list.error ? <ErrorBox error={list.error} /> : <Spinner />;
  if (!list.data.orders.length) return <Empty>Онлайн-заказов пока нет. Отметьте товары «Продаётся онлайн» в Кассе и создавайте заказы через POST /api/v1/orders.</Empty>;
  return (
    <div className="card">
      <p className="small muted">Сборка и выдача заказов — в Кассе, раздел «Онлайн-заказы».</p>
      <div className="list">
        {list.data.orders.map((o) => (
          <div key={o.id} className="list-item">
            <div className="li-main">
              <div className="li-title">{o.items.map((i) => `${i.name} × ${i.qty}`).join(', ')}</div>
              <div className="li-sub mono">{o.id} · {o.delivery_title}{o.physical_status ? ` (${PHYSICAL[o.physical_status]})` : ''} · {fmtDate(o.paid_at || o.created_at)}</div>
            </div>
            <Money value={o.total} />
            <StatusBadge map={ORDER_STATUS} status={o.status} />
          </div>
        ))}
      </div>
    </div>
  );
}

function Subs({ id }) {
  const list = useAsync(() => get(`/pay/merchants/${id}/subscriptions`), [id]);
  if (!list.data) return list.error ? <ErrorBox error={list.error} /> : <Spinner />;
  if (!list.data.subscriptions.length) return <Empty>Подписок пока нет. Создайте через POST /api/v1/subscriptions.</Empty>;
  return (
    <div className="card"><div className="list">
      {list.data.subscriptions.map((s) => (
        <div key={s.id} className="list-item">
          <div className="li-main"><div className="li-title">{s.description}</div><div className="li-sub mono">{s.id} · {s.payer_name || 'ещё не оформлена'} · раз в {s.period_months} мес.{s.fails ? ` · неудачных списаний: ${s.fails}` : ''}</div></div>
          <Money value={s.amount} />
          <StatusBadge map={SUB_STATUS} status={s.status} />
          {s.status !== 'cancelled' && <ActionButton size="sm" kind="ghost" confirm="Отменить подписку покупателя?" action={async () => { await post(`/pay/merchants/${id}/subscriptions/${s.id}/cancel`); list.reload(); }}>Отменить</ActionButton>}
        </div>
      ))}
    </div></div>
  );
}

const EV_STATUS = { pending: ['повтор позже', 'warn'], delivered: ['доставлено', 'ok'], failed: ['не доставлено', 'err'], skipped: ['нет адреса', ''] };

function Events({ id }) {
  const list = useAsync(() => get(`/pay/merchants/${id}/events`), [id]);
  const [open, setOpen] = useState(null);
  if (!list.data) return list.error ? <ErrorBox error={list.error} /> : <Spinner />;
  return (
    <div className="card">
      <p className="small muted">События уходят POST-запросом на адрес вебхуков с сервера ВлодБанка (50.1.0.10) по сети БалНета. Ответ 2xx — доставлено, иначе повтор через 1, 5, 30 минут, 2 и 6 часов.</p>
      {!list.data.events.length ? <Empty>Событий пока нет</Empty> : (
        <div className="list">
          {list.data.events.map((e) => (
            <div key={e.id} className="list-item">
              <div className="li-main" onClick={() => setOpen(e)} style={{ cursor: 'pointer' }}>
                <div className="li-title mono">{e.type}</div>
                <div className="li-sub">{fmtDate(e.created_at)} · попыток: {e.attempts}{e.last_code ? ` · ответ ${e.last_code}` : ''}</div>
              </div>
              <StatusBadge map={EV_STATUS} status={e.status} />
              <ActionButton size="sm" kind="ghost" action={async () => { await post(`/pay/merchants/${id}/events/${e.id}/resend`); list.reload(); }}>Повторить</ActionButton>
            </div>
          ))}
        </div>
      )}
      {open && (
        <Modal title={open.type} onClose={() => setOpen(null)} wide>
          {open.last_error && <p className="small"><b>Последняя ошибка:</b> {open.last_error}</p>}
          <pre className="pay-code-block">{JSON.stringify({ id: open.id, type: open.type, data: { object: open.data } }, null, 2)}</pre>
        </Modal>
      )}
    </div>
  );
}

function Settings({ m, onChange }) {
  const [f, setF] = useState({ name: m.name, site_url: m.site_url || '', webhook_url: m.webhook_url || '', courier_fee: m.courier_fee, delivery: m.delivery });
  const [keys, setKeys] = useState(null);
  const [secret, setSecret] = useState(m.webhook_secret);
  const toast = useToast();
  const d = f.delivery;
  const toggle = (k) => setF({ ...f, delivery: { ...d, [k]: !d[k] } });
  return (
    <div className="grid grid-2">
      <div className="card">
        <h2>Магазин</h2>
        <Form onSubmit={async () => { await patch(`/pay/merchants/${m.id}`, { ...f, site_url: f.site_url || null, webhook_url: f.webhook_url || null }); toast('Сохранено', 'ok'); onChange(); }}>
          <Input label="Название" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
          <Input label="Сайт" value={f.site_url} onChange={(e) => setF({ ...f, site_url: e.target.value })} placeholder="https://shop.vasya.bln/" />
          <Input label="Адрес вебхуков" value={f.webhook_url} onChange={(e) => setF({ ...f, webhook_url: e.target.value })} placeholder="https://shop.vasya.bln/webhooks/vlodbank" hint="POST с JSON и заголовком Vlod-Signature" />
          {m.shop && (
            <Field label="Способы доставки">
              <div className="stack-sm">
                {[['pickup', 'Самовывоз по коду'], ['courier', 'Курьеры БалНета'], ['digital', 'Цифровые товары'], ['physical', 'Реальная доставка (с одобрением админа)']].map(([k, label]) => (
                  <label key={k} className="row"><input type="checkbox" checked={!!d[k]} onChange={() => toggle(k)} /> {label}</label>
                ))}
              </div>
            </Field>
          )}
          {m.shop && d.courier && <MoneyInput label="Стоимость доставки курьером (идёт курьеру)" value={f.courier_fee} onChange={(v) => setF({ ...f, courier_fee: v })} />}
        </Form>
      </div>
      <div className="card stack">
        <h2>Ключи API</h2>
        {m.keys.map((k) => <div key={k.kind} className="row-between"><span>{k.kind === 'secret' ? 'Секретный' : 'Публичный'}: <code>{k.hint}</code></span><span className="tiny muted">{k.last_used_at ? `использован ${fmtDate(k.last_used_at)}` : 'не использовался'}</span></div>)}
        <ActionButton kind="ghost" confirm="Выпустить новые ключи? Старые перестанут работать сразу." action={async () => setKeys((await post(`/pay/merchants/${m.id}/keys`)).keys)}>Выпустить новые ключи</ActionButton>
        <h3>Подпись вебхуков</h3>
        <code className="pay-key">{secret}</code>
        <div className="row">
          <ActionButton kind="ghost" size="sm" confirm="Сменить секрет подписи? Обновите его в server.js." action={async () => setSecret((await post(`/pay/merchants/${m.id}/webhook-secret`)).webhook_secret)}>Сменить секрет</ActionButton>
          <ActionButton kind="ghost" size="sm" action={async () => { const r = await post(`/pay/merchants/${m.id}/webhook-test`); toast(r.delivered ? 'Вебхук ping доставлен' : `Не доставлено: ${r.event.last_code || ''} ${r.event.last_error || ''}`, r.delivered ? 'ok' : 'err'); }}>Отправить тестовый ping</ActionButton>
        </div>
        <p className="small muted">Магазин в БалНете: <code>{m.public_id}</code>. Зачисления: {m.account?.name} ({m.account?.number}).</p>
      </div>
      {keys && <KeysModal keys={keys} onClose={() => setKeys(null)} />}
    </div>
  );
}
