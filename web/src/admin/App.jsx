import { useEffect, useState } from 'react';
import { get, post, patch, onUnauthorized } from '../shared/api.js';
import { reconnect } from '../shared/ws.js';
import { t, useLang, fmtDate, fmtBirth } from '../shared/i18n.js';
import { useRoute, pick } from '../shared/router.js';
import {
  Topbar, DisclaimerBar, Spinner, useAsync, useChannel, Money, MoneyInput, Input, Select, Form, Modal, Empty, Badge, StatusBadge, ActionButton,
  Seg, Tabs, ErrorBox, useToast, PhotoInput, Button, Field,
} from '../shared/ui.jsx';
import { AdminLogo } from '../shared/brand.jsx';
import { LoginForm, AuthDisclaimer } from '../shared/auth.jsx';
import { IdCard } from '../shared/passport.jsx';
import { CreditAdmin, FraudAdmin, CashbackAdmin, InflationCard } from './finance.jsx';
import { TX_KINDS, ACCOUNT_TYPES } from '../bank/pages.jsx';
import { gameDateLabel } from '@bln/shared/time.js';
import { formatMoney } from '@bln/shared/money.js';

const SECTIONS = [
  ['/', 'Обзор'], ['/bank', 'Банк'], ['/economy', 'Экономика'], ['/pos', 'Касса'], ['/services', 'Услуги'], ['/people', 'Люди'], ['/system', 'Система'],
];

export default function App() {
  useLang();
  const route = useRoute();
  const [me, setMe] = useState(undefined);
  const [queue, setQueue] = useState(0);

  async function loadMe() {
    try {
      setMe(await get('/admin/me'));
    } catch (e) {
      setMe(e.status === 403 ? { forbidden: true } : null);
    }
  }
  useEffect(() => {
    loadMe();
    return onUnauthorized(() => setMe(null));
  }, []);
  useEffect(() => {
    if (me && !me.forbidden) get('/admin/overview').then((r) => setQueue(r.counts.pending_bank + r.counts.pending_apps + r.counts.pending_credit + r.counts.pending_fraud)).catch(() => {});
  }, [me, route.path]);
  useChannel(me && !me.forbidden ? 'admin' : null, (m) => { if (m.type === 'queue') setQueue((n) => n + 1); });

  async function logout() {
    await post('/auth/gov/logout');
    await post('/auth/bank/logout');
    reconnect();
    setMe(null);
  }

  const brand = <><AdminLogo /> <span>{t('Админка')}</span></>;
  if (me === undefined) return <><Topbar brand={brand} /><Spinner /></>;
  if (!me || me.forbidden) return <><Topbar brand={brand} right={me?.forbidden && <button className="tb-btn" onClick={logout}>{t('Выйти')}</button>} /><AdminLogin forbidden={me?.forbidden} onDone={loadMe} /><DisclaimerBar /></>;

  const section = '/' + (route.path.split('/')[1] || '');
  return (
    <>
      <Topbar
        brand={brand}
        nav={SECTIONS.map(([href, label]) => (
          <a key={href} href={`#${href}`} className={section === href ? 'active' : ''}>{t(label)}{href === '/bank' && queue > 0 && <span className="badge-dot" style={{ marginLeft: 4 }}>{queue}</span>}</a>
        ))}
        right={<button className="tb-btn" onClick={logout} title={me.name}>{t('Выйти')}</button>}
      />
      {pick([
        ['/', () => <Overview />],
        ['/bank', () => <BankSection />],
        ['/economy', () => <Economy />],
        ['/pos', () => <PosSection />],
        ['/services', () => <ServicesSection />],
        ['/people', () => <People me={me} />],
        ['/system', () => <SystemSection />],
        ['*', () => <Empty>{t('Страница не найдена')}</Empty>],
      ], section)}
      <DisclaimerBar />
    </>
  );
}

function AdminLogin({ forbidden, onDone }) {
  const [kind, setKind] = useState('gov');
  return (
    <div className="auth-wrap">
      <div className="card auth-card">
        <div className="brand-big"><AdminLogo size={64} /><h1 style={{ margin: 0 }}>{t('Админка')}</h1></div>
        {forbidden && <div className="form-error" style={{ marginBottom: 12 }}>{t('У этого аккаунта нет роли admin')}</div>}
        <Field label={t('Аккаунт')}>
          <Seg value={kind} onChange={setKind} options={[{ value: 'gov', label: 'ВлодУслуги' }, { value: 'bank', label: 'ВлодБанк' }]} />
        </Field>
        <div style={{ marginTop: 12 }}><LoginForm key={kind} kind={kind} onDone={onDone} /></div>
        <div style={{ marginTop: 16 }}><AuthDisclaimer /></div>
      </div>
    </div>
  );
}

function Stat({ label, value, money }) {
  return <div className="card stat"><span className="label">{label}</span><span className="value">{money ? <Money value={value} /> : value}</span></div>;
}

function ClockCard({ clock, onChange }) {
  const lang = useLang();
  const [minutes, setMinutes] = useState(clock.minutes);
  return (
    <div className="card stack">
      <div className="card-head"><h2>{t('Игровое время')}</h2>{clock.paused ? <Badge kind="warn">{t('пауза')}</Badge> : <Badge kind="ok">{t('идёт')}</Badge>}</div>
      <div style={{ fontSize: '1.3rem', fontWeight: 700 }}>{gameDateLabel(clock.month, lang)}</div>
      <div className="small muted">{t('Месяц №{n}', { n: clock.month })}{clock.next_tick_at ? ` · ${t('следующий')}: ${fmtDate(clock.next_tick_at)}` : ''}</div>
      <div className="row">
        <input className="input" style={{ width: 90 }} type="number" min={1} max={1440} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
        <span className="small muted">{t('минут = 1 игровой месяц')}</span>
        <ActionButton size="sm" kind="secondary" action={async () => { await post('/admin/clock', { minutes: Number(minutes) }); onChange(); }}>{t('Сохранить')}</ActionButton>
      </div>
      <div className="row">
        <ActionButton kind="secondary" action={async () => { await post('/admin/clock', { paused: !clock.paused }); onChange(); }}>{clock.paused ? t('Продолжить') : t('Пауза')}</ActionButton>
        <ActionButton kind="ghost" confirm={t('Перевести часы на следующий месяц сейчас? Начислятся проценты и зарплаты.')} action={async () => { await post('/admin/clock', { advance: true }); onChange(); }}>{t('Следующий месяц ⏭')}</ActionButton>
      </div>
    </div>
  );
}

function Overview() {
  const { data, loading, reload } = useAsync(() => get('/admin/overview'), []);
  useChannel('clock', () => reload());
  if (loading && !data) return <Spinner />;
  const c = data.counts;
  const e = data.economy;
  return (
    <div className="page">
      <h1>{t('Обзор')}</h1>
      {(c.pending_bank > 0 || c.pending_apps > 0 || c.pending_credit > 0 || c.pending_fraud > 0) && <div className="form-warn" style={{ marginBottom: 16 }}>{t('Ждут решения')}: {c.pending_bank} {t('регистраций')}, {c.pending_apps} {t('заявлений')}, {c.pending_credit} {t('кредитных заявок')}, {c.pending_fraud} {t('подозрительных операций')} — <a href="#/bank">{t('очередь')}</a></div>}
      <div className="grid grid-4">
        <Stat label={t('Клиенты банка')} value={c.bank_users} />
        <Stat label={t('Граждане с паспортом')} value={c.citizens} />
        <Stat label={t('Магазины')} value={c.shops} />
        <Stat label={t('Активные карты')} value={c.cards} />
        <Stat label={t('Денег в обороте')} value={e.money_supply} money />
        <Stat label={t('Выпущено эмиссией')} value={e.emitted} money />
        <Stat label={t('Госбюджет БФ')} value={e.budget} money />
        <Stat label={t('Казна ВлодБанка')} value={e.treasury} money />
      </div>
      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <ClockCard clock={data.clock} onChange={reload} />
        <div className="card">
          <h2>{t('Остатки по видам счетов')}</h2>
          <table className="table"><tbody>
            {e.by_type.map((r) => <tr key={r.type}><td>{t(ACCOUNT_TYPES[r.type] || r.type)}</td><td>{r.count}</td><td className="num right"><Money value={r.total} /></td></tr>)}
            <tr><td>{t('Наличные в обороте')}</td><td /><td className="num right"><Money value={e.cash} /></td></tr>
          </tbody></table>
        </div>
      </div>
    </div>
  );
}

// ——— Банк ———
function BankSection() {
  const [tab, setTab] = useState('queue');
  return (
    <div className="page">
      <h1>{t('Банк')}</h1>
      <Tabs value={tab} onChange={setTab} tabs={[
        { value: 'queue', label: t('Очередь заявок') }, { value: 'credit', label: t('Кредиты') }, { value: 'fraud', label: t('Антифрод') },
        { value: 'accounts', label: t('Счета') }, { value: 'cards', label: t('Карты') }, { value: 'emission', label: t('Эмиссия') }, { value: 'tx', label: t('Операции') },
        { value: 'cashback', label: t('Кешбэк') }, { value: 'tariffs', label: t('Тарифы и ставки') }, { value: 'credit_terms', label: t('Ставки кредитов') },
      ]} />
      {tab === 'credit' && <CreditAdmin />}
      {tab === 'fraud' && <FraudAdmin />}
      {tab === 'cashback' && <CashbackAdmin />}
      {tab === 'credit_terms' && <SettingsForm keys={CREDIT_KEYS} />}
      {tab === 'queue' && <Queue />}
      {tab === 'accounts' && <Accounts />}
      {tab === 'cards' && <Cards />}
      {tab === 'emission' && <Emission />}
      {tab === 'tx' && <Transactions />}
      {tab === 'tariffs' && <SettingsForm keys={BANK_KEYS} />}
    </div>
  );
}

function Queue() {
  const { data, loading, reload } = useAsync(() => get('/admin/queue'), []);
  useChannel('admin', (m) => m.type === 'queue' && reload());
  if (loading && !data) return <Spinner />;
  return (
    <div className="grid grid-2">
      <div className="card">
        <h2>{t('Регистрации во ВлодБанке')}</h2>
        {!data.bank_registrations.length ? <p className="muted">{t('Очередь пуста')}</p> : (
          <div className="list">
            {data.bank_registrations.map((u) => (
              <div key={u.id} className="list-item">
                <div className="li-main"><div className="li-title">{u.full_name}</div><div className="li-sub">{u.email} · {u.passport_no || t('без паспорта')} · {fmtDate(u.created_at)}</div></div>
                <ActionButton size="sm" kind="ok-btn" action={async () => { await post(`/admin/users/bank/${u.id}/status`, { status: 'active' }); reload(); }}>{t('Одобрить')}</ActionButton>
                <ActionButton size="sm" kind="ghost" action={async () => { await post(`/admin/users/bank/${u.id}/status`, { status: 'rejected' }); reload(); }}>{t('Отклонить')}</ActionButton>
              </div>
            ))}
          </div>
        )}
      </div>
      <div className="card">
        <h2>{t('Заявления ВлодУслуг')}</h2>
        {!data.applications.length ? <p className="muted">{t('Очередь пуста')}</p> : (
          <div className="list">
            {data.applications.map((a) => (
              <div key={a.id} className="list-item">
                {a.data.photo && <img src={a.data.photo} alt="" style={{ width: 44, height: 56, objectFit: 'cover', borderRadius: 6 }} />}
                <div className="li-main"><div className="li-title">{a.type} · {a.data.full_name || a.display_name}</div><div className="li-sub">{a.data.birth_date ? fmtBirth(a.data.birth_date) + ' · ' : ''}{a.email}</div></div>
                <ActionButton size="sm" kind="ok-btn" action={async () => { await post(`/gov/applications/${a.id}/approve`); reload(); }}>{t('Одобрить')}</ActionButton>
                <ActionButton size="sm" kind="ghost" action={async () => { await post(`/gov/applications/${a.id}/reject`, { comment: window.prompt(t('Причина отказа')) || '' }); reload(); }}>{t('Отказать')}</ActionButton>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Accounts() {
  const [q, setQ] = useState('');
  const { data, loading, reload } = useAsync(() => get(`/admin/accounts?q=${encodeURIComponent(q)}`), [q]);
  const [open, setOpen] = useState(null);
  return (
    <div className="stack">
      <input className="input" placeholder={t('Поиск: номер, владелец')} value={q} onChange={(e) => setQ(e.target.value)} />
      {loading && !data ? <Spinner /> : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>{t('Счёт')}</th><th>{t('Владелец')}</th><th>{t('Вид')}</th><th>{t('Статус')}</th><th className="right">{t('Баланс')}</th></tr></thead>
            <tbody>
              {data.accounts.map((a) => (
                <tr key={a.id} className="clickable" onClick={() => setOpen(a.id)}>
                  <td><span className="mono small">{a.number}</span><div className="tiny muted">{a.name}</div></td>
                  <td>{a.owner_kind === 'system' ? <Badge kind="brand">{t('служебный')}</Badge> : a.owner_name}</td>
                  <td>{t(ACCOUNT_TYPES[a.type] || a.type)}</td>
                  <td><StatusBadge status={a.status} /></td>
                  <td className="num right"><Money value={a.balance} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <AccountModal id={open} onClose={() => { setOpen(null); reload(); }} />}
    </div>
  );
}

function AccountModal({ id, onClose }) {
  const { data, loading, reload } = useAsync(() => get(`/admin/accounts/${id}`), [id]);
  return (
    <Modal title={t('Счёт')} onClose={onClose} wide>
      {loading && !data ? <Spinner /> : (
        <div className="stack">
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <div><b>{data.account.name}</b> <span className="mono small">{data.account.number}</span><div className="small muted">{data.account.owner_name || data.account.system_code}</div></div>
            <div className="right"><div style={{ fontSize: '1.4rem', fontWeight: 700 }}><Money value={data.account.balance} /></div>
              <div className="tiny muted">{t('по проводкам')}: <Money value={data.account.ledger_balance} /> {data.account.ledger_balance === data.account.balance ? '✓' : '⚠'}</div></div>
          </div>
          {data.account.owner_kind === 'bank_user' && (
            <div className="row">
              <StatusBadge status={data.account.status} />
              {['active', 'frozen', 'arrested'].filter((s) => s !== data.account.status).map((s) => (
                <ActionButton key={s} size="sm" kind={s === 'active' ? 'ok-btn' : 'secondary'} action={async () => { await post(`/admin/accounts/${id}/status`, { status: s }); reload(); }}>
                  {{ active: t('Разблокировать'), frozen: t('Заморозить'), arrested: t('Арестовать') }[s]}
                </ActionButton>
              ))}
            </div>
          )}
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>№</th><th>{t('Дата')}</th><th>{t('Операция')}</th><th className="right">{t('Сумма')}</th><th className="right">{t('Остаток')}</th></tr></thead>
              <tbody>
                {data.history.map((h) => (
                  <tr key={`${h.tx_id}`}>
                    <td className="small">{h.tx_id}</td><td className="small nowrap">{fmtDate(h.created_at)}</td>
                    <td>{h.memo || t(TX_KINDS[h.kind] || h.kind)}{h.reversed_by ? <Badge kind="err">{t('отменена')}</Badge> : null}</td>
                    <td className={`num right ${h.amount > 0 ? 'ok' : ''}`}><Money value={h.amount} plus /></td>
                    <td className="num right muted"><Money value={h.balance_after} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Modal>
  );
}

function Cards() {
  const [q, setQ] = useState('');
  const { data, loading, reload } = useAsync(() => get(`/admin/cards?q=${encodeURIComponent(q)}`), [q]);
  return (
    <div className="stack">
      <input className="input" placeholder={t('Поиск: номер карты, владелец')} value={q} onChange={(e) => setQ(e.target.value)} />
      {loading && !data ? <Spinner /> : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>{t('Номер')}</th><th>{t('Владелец')}</th><th>{t('Вид')}</th><th>{t('Статус')}</th><th /></tr></thead>
            <tbody>
              {data.cards.map((c) => (
                <tr key={c.id}>
                  <td className="mono">{c.number}</td><td>{c.owner_name}</td><td>{c.type}</td><td><StatusBadge status={c.status} />{c.locked_until && <Badge kind="warn">PIN</Badge>}</td>
                  <td className="right nowrap">
                    {c.status !== 'active' && !['reissued', 'expired'].includes(c.status) && <ActionButton size="sm" kind="ok-btn" action={async () => { await post(`/admin/cards/${c.id}/status`, { status: 'active' }); reload(); }}>{t('Активировать')}</ActionButton>}
                    {c.status === 'active' && <ActionButton size="sm" kind="secondary" action={async () => { await post(`/admin/cards/${c.id}/status`, { status: 'blocked' }); reload(); }}>{t('Блокировать')}</ActionButton>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function Emission() {
  const { data, loading, reload } = useAsync(() => get('/admin/emission'), []);
  const [f, setF] = useState({ account_number: '', amount: null, memo: '', dir: 1 });
  const toast = useToast();
  return (
    <div className="grid grid-2">
      <div className="card">
        <h2>{t('Выпуск и изъятие денег')}</h2>
        <Form submitLabel={f.dir > 0 ? t('Выпустить') : t('Изъять')} onSubmit={async () => {
          await post('/admin/emission', { account_number: f.account_number, amount: f.dir * (f.amount || 0), memo: f.memo });
          toast(t('Проведено'), 'ok');
          setF({ ...f, amount: null, memo: '' });
          reload();
        }}>
          <Seg value={f.dir} onChange={(d) => setF({ ...f, dir: d })} options={[{ value: 1, label: t('Выпуск') }, { value: -1, label: t('Изъятие') }]} />
          <Input label={t('Номер счёта')} required value={f.account_number} onChange={(e) => setF({ ...f, account_number: e.target.value.toUpperCase() })} />
          <MoneyInput label={t('Сумма')} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} />
          <Input label={t('Основание')} required value={f.memo} onChange={(e) => setF({ ...f, memo: e.target.value })} />
        </Form>
      </div>
      <div className="card">
        <div className="card-head"><h2>{t('Журнал эмиссии')}</h2>{data && <b><Money value={data.emitted} /></b>}</div>
        {loading && !data ? <Spinner /> : (
          <div className="list">
            {data.journal.map((r) => (
              <div key={`${r.id}`} className="list-item">
                <div className="li-main"><div className="li-title">{r.memo}</div><div className="li-sub">{r.full_name || r.name} · {r.number} · {fmtDate(r.created_at)}{r.reversed_by ? ` · ${t('отменена')}` : ''}</div></div>
                <span className={r.amount > 0 ? 'amount-pos' : 'amount-neg'}><Money value={r.amount} plus /></span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function Transactions() {
  const [kind, setKind] = useState('');
  const { data, loading, reload } = useAsync(() => get(`/admin/tx?kind=${kind}`), [kind]);
  return (
    <div className="stack">
      <Select value={kind} onChange={(e) => setKind(e.target.value)} options={[{ value: '', label: t('Все операции') }, ...Object.entries(TX_KINDS).map(([value, label]) => ({ value, label: t(label) }))]} />
      {loading && !data ? <Spinner /> : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>№</th><th>{t('Дата')}</th><th>{t('Операция')}</th><th>{t('Проводки')}</th><th /></tr></thead>
            <tbody>
              {data.tx.map((x) => (
                <tr key={x.id}>
                  <td className="small">{x.id}</td>
                  <td className="small nowrap">{fmtDate(x.created_at)}</td>
                  <td>{t(TX_KINDS[x.kind] || x.kind)}<div className="tiny muted">{x.memo}</div>{x.reversed_by && <Badge kind="err">{t('отменена')} → {x.reversed_by}</Badge>}{x.reversal_of && <Badge>{t('сторно')} {x.reversal_of}</Badge>}</td>
                  <td className="small">{x.entries.map((e, i) => <div key={i} className="row nowrap" style={{ justifyContent: 'space-between', gap: 12 }}><span>{e.full_name || e.name}</span><span className={`num ${e.amount > 0 ? 'ok' : ''}`}>{formatMoney(e.amount, { plus: true })}</span></div>)}</td>
                  <td className="right">{!x.reversed_by && !x.reversal_of && <ActionButton size="sm" kind="ghost" confirm={t('Отменить операцию №{n}? Будет создана обратная проводка.', { n: x.id })} action={async () => { await post(`/admin/tx/${x.id}/reverse`); reload(); }}>{t('Отменить')}</ActionButton>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ——— Настройки ———
const SETTING_LABELS = {
  bank_registration_approval: ['Одобрение регистраций во ВлодБанке вручную', 'bool'],
  passport_approval: ['Выдача паспорта только после одобрения', 'bool'],
  start_balance: ['Стартовый баланс нового клиента', 'money'],
  idle_minutes: ['Автовыход после бездействия, минут', 'int'],
  game_month_minutes: ['Длина игрового месяца, минут', 'int'],
  vat_bp: ['НДС, %', 'pct'],
  transfer_fee_bp: ['Комиссия за перевод, %', 'pct'],
  transfer_fee_min: ['Минимальная комиссия за перевод', 'money'],
  acquiring_fee_bp: ['Комиссия эквайринга с магазина, %', 'pct'],
  card_valid_months: ['Срок действия карты, игровых месяцев', 'int'],
  card_issue_fee: ['Стоимость выпуска карты', 'money'],
  card_reissue_fee: ['Стоимость перевыпуска карты', 'money'],
  savings_rate_bp: ['Ставка накопительного счёта, % в месяц', 'pct'],
  term_rate_bp: ['Ставка вклада на срок, % в месяц', 'pct'],
  term_early_penalty_bp: ['Штраф за досрочное закрытие вклада, %', 'pct'],
  card_monthly_fee: ['Обслуживание карты в игровой месяц', 'money'],
  gift_card_fee: ['Стоимость оформления подарочной карты', 'money'],
  loan_rate_bp: ['Ставка по кредиту, % в месяц', 'pct'],
  loan_max_amount: ['Максимальная сумма кредита', 'money'],
  loan_max_months: ['Максимальный срок кредита, игровых месяцев', 'int'],
  loan_auto_approve_max: ['Одобрять кредиты автоматически до суммы (0 — всё вручную)', 'money'],
  loan_late_fee_bp: ['Пени за просроченный платёж, % от платежа в месяц', 'pct'],
  credit_rate_bp: ['Ставка по кредитной карте, % в месяц', 'pct'],
  credit_grace_months: ['Льготный период кредитной карты, игровых месяцев', 'int'],
  credit_min_payment_bp: ['Минимальный платёж по кредитной карте, % от долга', 'pct'],
  credit_late_fee: ['Штраф за пропуск минимального платежа', 'money'],
  credit_max_limit: ['Максимальный лимит кредитной карты', 'money'],
  cashback_max_categories: ['Сколько категорий кешбэка можно выбрать', 'int'],
  cashback_cap: ['Максимальный кешбэк в игровой месяц', 'money'],
  fraud_threshold: ['Антифрод: крупная операция от (0 — выключено)', 'money'],
  fraud_multiplier: ['Антифрод: необычный перевод — во сколько раз больше обычного (0 — выключено)', 'int'],
  fraud_velocity: ['Антифрод: переводов за 10 минут (0 — выключено)', 'int'],
  inflation_bp: ['Инфляция, % за игровой месяц', 'pct'],
  fee_passport: ['Госпошлина: паспорт', 'money'],
  fee_inn: ['Госпошлина: ИНН', 'money'],
  fee_ip: ['Госпошлина: регистрация ИП', 'money'],
  passport_valid_months: ['Срок действия паспорта, игровых месяцев (0 — бессрочно)', 'int'],
  bank_logo: ['Логотип ВлодБанка', 'image'],
  gov_logo: ['Логотип ВлодУслуг', 'image'],
};
const BANK_KEYS = ['start_balance', 'transfer_fee_bp', 'transfer_fee_min', 'acquiring_fee_bp', 'card_valid_months', 'card_issue_fee', 'card_reissue_fee', 'card_monthly_fee', 'gift_card_fee', 'savings_rate_bp', 'term_rate_bp', 'term_early_penalty_bp', 'cashback_max_categories', 'cashback_cap'];
const CREDIT_KEYS = ['loan_rate_bp', 'loan_max_amount', 'loan_max_months', 'loan_auto_approve_max', 'loan_late_fee_bp', 'credit_rate_bp', 'credit_grace_months', 'credit_min_payment_bp', 'credit_late_fee', 'credit_max_limit', 'fraud_threshold', 'fraud_multiplier', 'fraud_velocity'];
const LAW_KEYS = ['vat_bp', 'fee_passport', 'fee_inn', 'fee_ip', 'passport_valid_months'];
const SYSTEM_KEYS = ['bank_registration_approval', 'passport_approval', 'idle_minutes', 'game_month_minutes', 'bank_logo', 'gov_logo'];

function SettingsForm({ keys }) {
  const { data, loading } = useAsync(() => get('/admin/settings'), []);
  const [f, setF] = useState(null);
  const toast = useToast();
  useEffect(() => { if (data) setF(data.settings); }, [data]);
  if ((loading && !data) || !f) return <Spinner />;
  return (
    <div className="card" style={{ maxWidth: 640 }}>
      <Form onSubmit={async () => {
        const patchBody = Object.fromEntries(keys.map((k) => [k, f[k]]));
        setF((await patch('/admin/settings', patchBody)).settings);
        toast(t('Сохранено'), 'ok');
      }}>
        {keys.map((k) => {
          const [label, type] = SETTING_LABELS[k];
          if (type === 'bool') return <label key={k} className="check"><input type="checkbox" checked={!!f[k]} onChange={(e) => setF({ ...f, [k]: e.target.checked })} /> {t(label)}</label>;
          if (type === 'money') return <MoneyInput key={k} label={t(label)} value={f[k]} onChange={(v) => setF({ ...f, [k]: v ?? 0 })} />;
          if (type === 'pct') return <Input key={k} label={t(label)} type="number" step="0.01" min={0} value={f[k] / 100} onChange={(e) => setF({ ...f, [k]: Math.round(Number(e.target.value) * 100) })} />;
          if (type === 'image') return <PhotoInput key={k} label={t(label)} value={f[k]} onChange={(v) => setF({ ...f, [k]: v })} maxSize={256} />;
          return <Input key={k} label={t(label)} type="number" min={0} value={f[k]} onChange={(e) => setF({ ...f, [k]: Number(e.target.value) })} />;
        })}
      </Form>
    </div>
  );
}

// ——— Экономика ———
function Economy() {
  const { data, loading, reload } = useAsync(() => get('/admin/economy'), []);
  useChannel('clock', () => reload());
  if (loading && !data) return <Spinner />;
  const maxVol = Math.max(1, ...data.daily.map((d) => d.volume));
  return (
    <div className="page">
      <h1>{t('Экономика')}</h1>
      <div className="grid grid-4">
        <Stat label={t('Денег в обороте')} value={data.money_supply} money />
        <Stat label={t('На счетах')} value={data.deposits} money />
        <Stat label={t('Наличные')} value={data.cash} money />
        <Stat label={t('Выпущено эмиссией')} value={data.emitted} money />
        <Stat label={t('Долги клиентов банку')} value={data.debt} money />
        <Stat label={t('Казна ВлодБанка')} value={data.treasury} money />
        <Stat label={t('Госбюджет БФ')} value={data.budget} money />
      </div>
      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <h2>{t('Оборот по дням')}</h2>
          <div className="chart-bars">{data.daily.map((d) => <div key={d.day} className="bar" title={`${d.day}: ${formatMoney(d.volume)} · ${d.count}`} style={{ height: `${(d.volume / maxVol) * 100}%` }} />)}</div>
          <div className="chart-labels">{data.daily.map((d) => <span key={d.day}>{String(d.day).slice(5, 10)}</span>)}</div>
        </div>
        <div className="card">
          <h2>{t('Самые богатые')}</h2>
          <table className="table"><tbody>{data.richest.map((r, i) => <tr key={r.id}><td>{i + 1}</td><td>{r.full_name}</td><td className="num right"><Money value={r.total} /></td></tr>)}</tbody></table>
        </div>
      </div>
      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <ClockCard clock={data.clock} onChange={reload} />
        <div className="card">
          <h2>{t('Операции за 7 дней')}</h2>
          <table className="table"><tbody>{data.kinds.map((k) => <tr key={k.kind}><td>{t(TX_KINDS[k.kind] || k.kind)}</td><td className="right">{k.n}</td></tr>)}</tbody></table>
        </div>
      </div>
      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <InflationCard />
      </div>
    </div>
  );
}

// ——— Касса ———
function PosSection() {
  const [tab, setTab] = useState('shops');
  return (
    <div className="page">
      <h1>{t('Касса')}</h1>
      <Tabs
        value={tab}
        onChange={setTab}
        tabs={[
          { value: 'shops', label: t('Магазины') },
          { value: 'wholesale', label: t('Оптовая база') },
          { value: 'purchases', label: t('Закупки') },
        ]}
      />
      {tab === 'shops' && <AdminShops />}
      {tab === 'wholesale' && <WholesaleBase />}
      {tab === 'purchases' && <PurchasesAdmin />}
    </div>
  );
}

function AdminShops() {
  const { data, loading, reload } = useAsync(() => get('/admin/shops'), []);
  if (loading && !data) return <Spinner />;
  return (
    <div className="stack">
      {!data.shops.length ? <Empty>{t('Магазинов пока нет')}</Empty> : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>{t('Магазин')}</th><th>{t('Владелец')}</th><th>{t('Чеков')}</th><th>{t('Выручка')}</th><th>{t('Бизнес-счёт')}</th><th>{t('Статус')}</th><th /></tr></thead>
            <tbody>
              {data.shops.map((s) => (
                <tr key={s.id}>
                  <td><span style={{ display: 'inline-block', width: 10, height: 10, borderRadius: 3, background: s.color, marginRight: 6 }} />{s.name}<div className="tiny muted">{t('ИНН')} {s.inn} · {s.ip_number}</div></td>
                  <td>{s.owner}</td><td>{s.sales}</td><td className="num"><Money value={s.revenue} /></td><td className="num"><Money value={s.balance} /></td>
                  <td><StatusBadge status={s.status} /></td>
                  <td className="right"><ActionButton size="sm" kind="ghost" action={async () => { await post(`/admin/shops/${s.id}/status`, { status: s.status === 'active' ? 'closed' : 'active' }); reload(); }}>{s.status === 'active' ? t('Закрыть') : t('Открыть')}</ActionButton></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** Оптовая база: сюда закупаются магазины. Цены растут вместе с индексом инфляции. */
function WholesaleBase() {
  const { data, loading, reload } = useAsync(() => get('/admin/wholesale'), []);
  const [edit, setEdit] = useState(null);
  const [q, setQ] = useState('');
  if (loading && !data) return <Spinner />;
  const needle = q.trim().toLowerCase();
  const items = data.items.filter((w) => !needle || `${w.name} ${w.category}`.toLowerCase().includes(needle));
  return (
    <div className="stack">
      <div className="grid grid-4">
        <div className="stat"><span className="label">{t('Индекс цен')}</span><span className="value">×{(data.index / 1e6).toFixed(3)}</span><span className="tiny muted">{data.month}</span></div>
        <div className="stat"><span className="label">{t('Позиций')}</span><span className="value">{data.items.length}</span></div>
        <div className="stat"><span className="label">{t('Закуплено')}</span><span className="value"><Money value={data.sales.total} /></span><span className="tiny muted">{t('закупок')}: {data.sales.count}</span></div>
        <div className="stat"><span className="label">{t('История индекса')}</span><span className="value">{data.history.length}</span><span className="tiny muted">{t('месяцев')}</span></div>
      </div>
      <div className="row">
        <input className="input grow" placeholder={t('Поиск по названию или категории')} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button onClick={() => setEdit({})}>+ {t('Позиция')}</Button>
      </div>
      {!items.length ? <Empty>{t('Позиций нет')}</Empty> : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>{t('Товар')}</th><th>{t('Категория')}</th><th>{t('Ед.')}</th><th className="right">{t('База')}</th><th className="right">{t('С индексом')}</th><th>{t('Штрихкод')}</th><th>{t('18+')}</th><th>{t('Статус')}</th><th /></tr></thead>
            <tbody>
              {items.map((w) => (
                <tr key={w.id}>
                  <td><div className="row" style={{ gap: 8 }}>{w.photo && <img src={w.photo} alt="" style={{ width: 32, height: 32, borderRadius: 6, objectFit: 'cover' }} />}<span>{w.name}</span></div></td>
                  <td className="small muted">{w.category || '—'}</td>
                  <td className="small">{w.unit === 'kg' ? t('кг') : t('шт')}</td>
                  <td className="num right"><Money value={w.base_price} /></td>
                  <td className="num right"><b><Money value={w.price} /></b></td>
                  <td className="mono tiny">{w.barcode || '—'}</td>
                  <td>{w.age_limit ? `${w.age_limit}+` : '—'}</td>
                  <td><StatusBadge status={w.active ? 'active' : 'closed'} /></td>
                  <td className="right"><Button size="sm" kind="ghost" onClick={() => setEdit(w)}>{t('Изменить')}</Button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data.history.length > 0 && (
        <div className="card">
          <h2>{t('Индекс инфляции по месяцам')}</h2>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('Месяц')}</th><th className="right">{t('Ставка')}</th><th className="right">{t('Индекс')}</th></tr></thead>
              <tbody>{data.history.map((h) => <tr key={h.month}><td>{h.month}</td><td className="num right">{(h.rate_bp / 100).toLocaleString('ru-RU')}%</td><td className="num right">×{h.index.toFixed(3)}</td></tr>)}</tbody>
            </table>
          </div>
        </div>
      )}
      {edit && (
        <WholesaleModal
          item={edit}
          onClose={() => setEdit(null)}
          onDone={() => { setEdit(null); reload(); }}
        />
      )}
      <p className="small muted">{t('Магазины закупаются по цене с индексом. Базовая цена меняется здесь, индекс считает экономика города.')}</p>
    </div>
  );
}

function WholesaleModal({ item, onClose, onDone }) {
  const [f, setF] = useState({
    name: item.name || '', category: item.category || '', unit: item.unit || 'pcs', base_price: item.base_price || 0,
    barcode: item.barcode || '', age_limit: item.age_limit || 0, sort: item.sort || 0, photo: item.photo || null, active: item.active !== false,
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <Modal title={item.id ? t('Изменить позицию') : t('Новая позиция оптовой базы')} onClose={onClose} wide>
      <Form
        submitLabel={item.id ? t('Сохранить') : t('Добавить')}
        onSubmit={async () => {
          const body = {
            name: f.name, category: f.category, unit: f.unit, base_price: f.base_price, barcode: f.barcode || null,
            age_limit: Number(f.age_limit) || 0, sort: Number(f.sort) || 0, active: f.active, photo: f.photo,
          };
          if (item.id) await patch(`/admin/wholesale/${item.id}`, body);
          else await post('/admin/wholesale', body);
          onDone();
        }}
      >
        <div className="grid grid-2">
          <Input label={t('Название')} required value={f.name} onChange={set('name')} />
          <Input label={t('Категория')} value={f.category} onChange={set('category')} hint={t('Например: продукты, бытовая химия')} />
          <Select label={t('Единица')} value={f.unit} onChange={set('unit')} options={[{ value: 'pcs', label: t('шт') }, { value: 'kg', label: t('кг') }]} />
          <MoneyInput label={t('Базовая цена')} value={f.base_price} onChange={(v) => setF({ ...f, base_price: v })} hint={t('К ней прибавится индекс инфляции')} />
          <Input label={t('Штрихкод')} value={f.barcode} onChange={set('barcode')} />
          <Input label={t('Возрастное ограничение')} type="number" min="0" max="21" value={f.age_limit} onChange={set('age_limit')} hint={t('0 — без ограничения')} />
          <Input label={t('Порядок')} type="number" value={f.sort} onChange={set('sort')} />
          <label className="row" style={{ alignItems: 'center', gap: 8 }}><input type="checkbox" checked={!!f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} />{t('В продаже')}</label>
        </div>
        <PhotoInput label={t('Фото')} value={f.photo} onChange={(photo) => setF({ ...f, photo })} />
      </Form>
    </Modal>
  );
}

/** Закупки всех магазинов: у оптовой базы и друг у друга. */
function PurchasesAdmin() {
  const { data, loading, reload } = useAsync(() => get('/admin/purchases'), []);
  const [filter, setFilter] = useState('all');
  if (loading && !data) return <Spinner />;
  const list = data.purchases.filter((p) => filter === 'all' || p.source === filter);
  const sum = list.filter((p) => p.status === 'done').reduce((s, p) => s + p.total, 0);
  const SOURCE = { wholesale: 'Оптовая база', shop: 'Магазин', market: 'Рынок', order: 'Заказ' };
  return (
    <div className="stack">
      <div className="grid grid-3">
        <div className="stat"><span className="label">{t('Закупок')}</span><span className="value">{list.length}</span></div>
        <div className="stat"><span className="label">{t('Оборот закупок')}</span><span className="value"><Money value={sum} /></span></div>
        <div className="stat"><span className="label">{t('Отменено')}</span><span className="value">{list.filter((p) => p.status === 'cancelled').length}</span></div>
      </div>
      <div className="row">
        <Seg
          value={filter}
          onChange={setFilter}
          options={[{ value: 'all', label: t('Все') }, ...Object.entries(SOURCE).map(([value, label]) => ({ value, label: t(label) }))]}
        />
        <Button kind="ghost" size="sm" onClick={reload}>{t('Обновить')}</Button>
      </div>
      {!list.length ? <Empty>{t('Закупок нет')}</Empty> : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>#</th><th>{t('Дата')}</th><th>{t('Покупатель')}</th><th>{t('Источник')}</th><th>{t('Продавец')}</th><th className="right">{t('Сумма')}</th><th>{t('Статус')}</th></tr></thead>
            <tbody>
              {list.map((p) => (
                <tr key={p.id}>
                  <td className="mono">{p.id}</td>
                  <td className="small">{fmtDate(p.created_at)}</td>
                  <td>{p.shop_name}</td>
                  <td className="small">{t(SOURCE[p.source] || p.source)}</td>
                  <td className="small muted">{p.seller_name || '—'}</td>
                  <td className="num right"><Money value={p.total} /></td>
                  <td><StatusBadge status={p.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ——— Услуги ———
function ServicesSection() {
  const [tab, setTab] = useState('citizens');
  return (
    <div className="page">
      <h1>{t('Услуги')}</h1>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'citizens', label: t('Реестр граждан') }, { value: 'queue', label: t('Заявления') }, { value: 'laws', label: t('Законы и ставки') }, { value: 'invoices', label: t('Квитанции') }]} />
      {tab === 'citizens' && <Citizens />}
      {tab === 'queue' && <Queue />}
      {tab === 'laws' && <SettingsForm keys={LAW_KEYS} />}
      {tab === 'invoices' && <Invoices />}
    </div>
  );
}

function Citizens() {
  const [q, setQ] = useState('');
  const { data, loading } = useAsync(() => get(`/admin/citizens?q=${encodeURIComponent(q)}`), [q]);
  const [open, setOpen] = useState(null);
  return (
    <div className="stack">
      <input className="input" placeholder={t('Поиск: имя, паспорт, email')} value={q} onChange={(e) => setQ(e.target.value)} />
      {loading && !data ? <Spinner /> : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>{t('Гражданин')}</th><th>{t('Дата рождения')}</th><th>{t('Паспорт')}</th><th>{t('Прописка')}</th></tr></thead>
            <tbody>
              {data.citizens.map((c) => (
                <tr key={c.id} className="clickable" onClick={() => setOpen(c.gov_user_id)}>
                  <td>{c.full_name}<div className="tiny muted">{c.email}</div></td><td>{fmtBirth(c.birth_date)}</td>
                  <td><span className="mono">{c.passport_no}</span> {c.passport_status && <StatusBadge status={c.passport_status} />}</td><td className="small">{c.address}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {open && <GovUserModal id={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function GovUserModal({ id, onClose }) {
  const { data, loading, reload } = useAsync(() => get(`/admin/users/gov/${id}`), [id]);
  return (
    <Modal title={t('Гражданин')} onClose={onClose} wide>
      {loading && !data ? <Spinner /> : (
        <div className="grid grid-2">
          <div className="stack">
            {data.passport ? <IdCard p={data.passport} /> : <Empty>{t('Паспорта нет')}</Empty>}
            {data.passport && (
              <div className="row">
                <StatusBadge status={data.passport.status} />
                <ActionButton size="sm" kind={data.passport.status === 'active' ? 'danger' : 'ok-btn'} confirm={t('Изменить статус паспорта?')} action={async () => { await post(`/admin/passports/${data.passport.number}/status`, { status: data.passport.status === 'active' ? 'revoked' : 'active' }); reload(); }}>
                  {data.passport.status === 'active' ? t('Аннулировать') : t('Восстановить')}
                </ActionButton>
              </div>
            )}
          </div>
          <div className="stack">
            <div><b>{data.user.display_name}</b> · <span className="muted">{data.user.email}</span></div>
            <h3>{t('Документы')}</h3>
            {!data.documents.length ? <p className="muted">—</p> : data.documents.map((d) => (
              <div key={d.id} className="row"><span>{d.type} <span className="mono">{d.number}</span></span><StatusBadge status={d.status} />
                {d.status === 'active' && <ActionButton size="sm" kind="ghost" action={async () => { await post(`/admin/documents/${d.id}/status`, { status: 'revoked' }); reload(); }}>{t('Аннулировать')}</ActionButton>}
              </div>
            ))}
            <h3>{t('Квитанции')}</h3>
            {data.invoices.map((i) => <div key={i.number} className="row small"><span className="mono">{i.number}</span><span>{i.purpose}</span><Money value={i.amount} /><StatusBadge status={i.status} /></div>)}
          </div>
        </div>
      )}
    </Modal>
  );
}

function Invoices() {
  const { data, loading } = useAsync(() => get('/admin/invoices'), []);
  if (loading && !data) return <Spinner />;
  return (
    <div className="card table-wrap">
      <table className="table">
        <thead><tr><th>№</th><th>{t('Назначение')}</th><th>{t('Плательщик')}</th><th>{t('Сумма')}</th><th>{t('Статус')}</th><th>{t('Оплата')}</th></tr></thead>
        <tbody>{data.invoices.map((i) => <tr key={i.id}><td className="mono small">{i.number}</td><td>{i.purpose}</td><td className="small">{i.email}</td><td className="num"><Money value={i.amount} /></td><td><StatusBadge status={i.status} /></td><td className="small">{i.paid_via || ''}</td></tr>)}</tbody>
      </table>
    </div>
  );
}

// ——— Люди и роли ———
const ROLE_LABELS = { admin: 'Админ', teller: 'Операционист банка', official: 'Чиновник', police: 'Полицейский', tax: 'Налоговый инспектор', doctor: 'Врач' };

function People({ me }) {
  const [kind, setKind] = useState('bank');
  const [q, setQ] = useState('');
  const { data, loading, reload } = useAsync(() => get(`/admin/users?kind=${kind}&q=${encodeURIComponent(q)}`), [kind, q]);
  const roles = useAsync(() => get('/admin/roles'), []);
  const available = Object.entries(ROLE_LABELS).filter(([r]) => (kind === 'bank' ? ['admin', 'teller'] : ['admin', 'official', 'police', 'tax', 'doctor']).includes(r));
  return (
    <div className="page">
      <h1>{t('Люди')}</h1>
      <div className="row" style={{ marginBottom: 12 }}>
        <Seg value={kind} onChange={setKind} options={[{ value: 'bank', label: 'ВлодБанк' }, { value: 'gov', label: 'ВлодУслуги' }]} />
        <input className="input" style={{ maxWidth: 320 }} placeholder={t('Поиск')} value={q} onChange={(e) => setQ(e.target.value)} />
      </div>
      {loading && !data ? <Spinner /> : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>{t('Имя')}</th><th>Email</th><th>{t('Паспорт')}</th><th>{t('Статус')}</th><th>{t('Роли')}</th><th /></tr></thead>
            <tbody>
              {data.users.map((u) => (
                <tr key={u.id}>
                  <td>{u.full_name || u.display_name}</td>
                  <td className="small">{u.email}</td>
                  <td className="mono small">{u.passport_no}{kind === 'bank' && u.passport_no && (u.passport_verified ? ' ✓' : ' ?')}</td>
                  <td><StatusBadge status={u.status} /></td>
                  <td>
                    <div className="row" style={{ gap: 4 }}>
                      {available.map(([r, label]) => {
                        const has = u.roles.includes(r);
                        const self = r === 'admin' && kind === me.kind && u.id === me.id;
                        return (
                          <button key={r} type="button" disabled={self} className={`badge ${has ? 'brand' : ''}`} style={{ cursor: self ? 'default' : 'pointer', border: 0 }} title={t(label)}
                            onClick={async () => { await post('/admin/roles', { kind, user_id: u.id, role: r, grant: !has }); reload(); roles.reload(); }}>
                            {has ? '✓ ' : '+ '}{t(label)}
                          </button>
                        );
                      })}
                    </div>
                  </td>
                  <td className="right nowrap">
                    {u.status !== 'blocked'
                      ? <ActionButton size="sm" kind="ghost" confirm={t('Заблокировать аккаунт?')} action={async () => { await post(`/admin/users/${kind}/${u.id}/status`, { status: 'blocked' }); reload(); }}>{t('Блок')}</ActionButton>
                      : <ActionButton size="sm" kind="ghost" action={async () => { await post(`/admin/users/${kind}/${u.id}/status`, { status: 'active' }); reload(); }}>{t('Разблокировать')}</ActionButton>}
                    {kind === 'bank' && u.status === 'pending' && <ActionButton size="sm" kind="ok-btn" action={async () => { await post(`/admin/users/bank/${u.id}/status`, { status: 'active' }); reload(); }}>{t('Одобрить')}</ActionButton>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card" style={{ marginTop: 16 }}>
        <h2>{t('Назначенные роли')}</h2>
        {roles.data && (!roles.data.roles.length ? <p className="muted">—</p> : (
          <table className="table"><tbody>{roles.data.roles.map((r) => <tr key={`${r.user_kind}-${r.user_id}-${r.role}`}><td><Badge kind="brand">{t(ROLE_LABELS[r.role] || r.role)}</Badge></td><td>{r.name}</td><td className="small muted">{r.email} · {r.user_kind === 'bank' ? 'ВлодБанк' : 'ВлодУслуги'}</td></tr>)}</tbody></table>
        ))}
        <p className="small muted">{t('Сотрудники госорганов получают зарплату из госбюджета (этап 8). Один человек может иметь несколько ролей.')}</p>
      </div>
    </div>
  );
}

// ——— Система ———
function SystemSection() {
  const [tab, setTab] = useState('settings');
  return (
    <div className="page">
      <h1>{t('Система')}</h1>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'settings', label: t('Переключатели и логотипы') }, { value: 'server', label: t('Адреса и почта') }, { value: 'data', label: t('Экспорт / импорт / сброс') }, { value: 'audit', label: t('Журнал действий') }]} />
      {tab === 'settings' && <SettingsForm keys={SYSTEM_KEYS} />}
      {tab === 'server' && <ServerSettings />}
      {tab === 'data' && <DataTools />}
      {tab === 'audit' && <Audit />}
    </div>
  );
}

/** Адреса сайта и SMTP — то, что раньше было в .env, теперь меняется без перезапуска. */
function ServerSettings() {
  const { data, loading } = useAsync(() => get('/admin/settings'), []);
  const server = useAsync(() => get('/admin/server'), []);
  const [f, setF] = useState(null);
  const [to, setTo] = useState('');
  const toast = useToast();
  useEffect(() => { if (data) setF({ ...data.settings }); }, [data]);
  if ((loading && !data) || !f) return <Spinner />;
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  return (
    <div className="grid grid-2">
      <div className="card">
        <Form onSubmit={async () => {
          const body = {
            public_web_url: f.public_web_url, cors_origins: f.cors_origins,
            smtp_host: f.smtp_host, smtp_port: Number(f.smtp_port) || 465, smtp_secure: !!f.smtp_secure, smtp_user: f.smtp_user, mail_from: f.mail_from,
          };
          if (f.smtp_password) body.smtp_password = f.smtp_password;
          const r = await patch('/admin/settings', body);
          setF({ ...r.settings });
          server.reload();
          toast(t('Сохранено'), 'ok');
        }}>
          <h2>{t('Адреса')}</h2>
          <Input label={t('Адрес сайта')} placeholder="https://balesnolandia.vladislavb.ru" value={f.public_web_url} onChange={set('public_web_url')} hint={t('Для ссылок в QR, чеках и письмах. Пусто — адрес из деплоя')} />
          <Input label={t('Дополнительные адреса фронтенда (CORS)')} placeholder="https://www.balesnolandia.vladislavb.ru" value={f.cors_origins} onChange={set('cors_origins')} hint={t('Через запятую. Адрес сайта разрешён всегда.')} />
          <h2 style={{ marginTop: 8 }}>{t('Почта (SMTP)')}</h2>
          <p className="small muted">{t('Пока SMTP не задан, письма с кодами входа пишутся в лог сервера — входите по паролю.')}</p>
          <div className="grid grid-2">
            <Input label={t('SMTP-сервер')} placeholder="smtp.vladislavb.ru" value={f.smtp_host} onChange={set('smtp_host')} />
            <Input label={t('Порт')} type="number" min={1} max={65535} value={f.smtp_port} onChange={set('smtp_port')} />
          </div>
          <label className="check"><input type="checkbox" checked={!!f.smtp_secure} onChange={set('smtp_secure')} /> {t('SSL/TLS (порт 465)')}</label>
          <div className="grid grid-2">
            <Input label={t('Логин')} autoComplete="off" value={f.smtp_user} onChange={set('smtp_user')} />
            <Input label={t('Пароль')} type="password" autoComplete="new-password" placeholder={f.smtp_password_set ? '••••••••' : ''} value={f.smtp_password} onChange={set('smtp_password')} hint={f.smtp_password_set ? t('Задан. Оставьте пустым, чтобы не менять.') : null} />
          </div>
          <Input label={t('Отправитель')} placeholder="Балесноландия <no-reply@vladislavb.ru>" value={f.mail_from} onChange={set('mail_from')} />
        </Form>
      </div>
      <div className="stack">
        <div className="card stack">
          <h2>{t('Тестовое письмо')}</h2>
          <Input label="Email" type="email" value={to} onChange={(e) => setTo(e.target.value)} placeholder={t('Ваш email')} />
          <ActionButton kind="secondary" action={async () => { const r = await post('/admin/mail/test', { to }); toast(t('Письмо отправлено на {email}', { email: r.to }), 'ok'); }}>{t('Отправить тестовое письмо')}</ActionButton>
        </div>
        {server.data && (
          <div className="card">
            <h2>{t('Сервер')}</h2>
            <table className="table"><tbody>
              <tr><td>{t('Адрес сайта')}</td><td className="small">{server.data.web_url}</td></tr>
              <tr><td>{t('Почта')}</td><td>{t(server.data.mail)}</td></tr>
              <tr><td>{t('Домен cookie')}</td><td className="mono small">{server.data.cookie_domain || '—'}</td></tr>
              <tr><td>Node.js</td><td className="mono small">{server.data.node}</td></tr>
              <tr><td>{t('База данных')}</td><td className="mono small">{server.data.db}</td></tr>
              <tr><td>{t('Игровой таймер')}</td><td>{server.data.game_clock ? t('идёт') : t('выключен')}</td></tr>
            </tbody></table>
          </div>
        )}
      </div>
    </div>
  );
}

function DataTools() {
  const toast = useToast();
  const [confirm, setConfirm] = useState('');
  const [keep, setKeep] = useState(true);
  const [error, setError] = useState(null);
  async function exportJson() {
    const data = await get('/admin/export');
    const blob = new Blob([JSON.stringify(data)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `balesnolandia-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
  }
  async function importJson(file) {
    if (!file) return;
    if (!window.confirm(t('Импорт заменит ВСЕ данные игры содержимым файла. Продолжить?'))) return;
    setError(null);
    try {
      await post('/admin/import', JSON.parse(await file.text()));
      toast(t('Импорт выполнен'), 'ok');
    } catch (e) { setError(e); }
  }
  return (
    <div className="grid grid-2">
      <div className="card stack">
        <h2>{t('Экспорт и импорт')}</h2>
        <p className="muted">{t('Полная копия базы в JSON: аккаунты, счета, проводки, документы, магазины.')}</p>
        <ActionButton action={exportJson}>{t('Скачать экспорт JSON')}</ActionButton>
        <label className="btn secondary">{t('Импортировать JSON…')}<input type="file" accept="application/json" hidden onChange={(e) => importJson(e.target.files?.[0])} /></label>
        <ErrorBox error={error} />
      </div>
      <div className="card stack" style={{ borderColor: 'var(--err)' }}>
        <h2 className="err">{t('Полный сброс игры')}</h2>
        <p>{t('Удаляются все игроки, счета, проводки, документы и магазины. Аккаунты с ролью admin сохраняются.')}</p>
        <label className="check"><input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} /> {t('Сохранить настройки и ставки')}</label>
        <Input label={t('Введите слово СБРОС')} value={confirm} onChange={(e) => setConfirm(e.target.value)} />
        <Button kind="danger" disabled={confirm !== 'СБРОС'} onClick={async () => {
          try { await post('/admin/reset', { confirm, keep_settings: keep }); toast(t('Игра сброшена'), 'ok'); setConfirm(''); } catch (e) { setError(e); }
        }}>{t('Сбросить')}</Button>
      </div>
    </div>
  );
}

function Audit() {
  const { data, loading } = useAsync(() => get('/admin/audit'), []);
  if (loading && !data) return <Spinner />;
  return (
    <div className="card table-wrap">
      <table className="table">
        <thead><tr><th>{t('Время')}</th><th>{t('Кто')}</th><th>{t('Действие')}</th><th>{t('Объект')}</th><th>{t('Данные')}</th></tr></thead>
        <tbody>{data.log.map((l) => <tr key={l.id}><td className="small nowrap">{fmtDate(l.created_at)}</td><td className="small">{l.actor_kind}:{l.actor_id}</td><td>{l.action}</td><td className="small">{l.entity ? `${l.entity}#${l.entity_id}` : ''}</td><td className="small muted">{l.data ? JSON.stringify(l.data) : ''}</td></tr>)}</tbody>
      </table>
    </div>
  );
}
