// Этап 6, ВлодБанк: кредиты, кредитная / детская / подарочная карта, автоплатежи, кешбэк.
import { useEffect, useState } from 'react';
import { get, post } from '../shared/api.js';
import { t, useLang } from '../shared/i18n.js';
import {
  Spinner, useAsync, Money, MoneyInput, Input, Select, Form, Modal, Empty, StatusBadge, ActionButton, Seg, Badge, ErrorBox, useToast, Field,
} from '../shared/ui.jsx';
import { BankCard, BACKGROUNDS } from '../shared/cards.jsx';
import { mmYY } from '@bln/shared/time.js';
import { formatMoney } from '@bln/shared/money.js';

const pct = (bp) => `${(Number(bp) / 100).toLocaleString('ru-RU')}%`;
const SCORE = { excellent: ['ok', 'Отличный'], good: ['ok', 'Хороший'], fair: ['warn', 'Средний'], poor: ['err', 'Низкий'] };
const LOAN_STATUS = { pending: 'pending', active: 'active', rejected: 'rejected', repaid: 'paid', cancelled: 'cancelled' };
const ROW_STATUS = { planned: ['', 'По графику'], paid: ['ok', 'Оплачен'], overdue: ['err', 'Просрочен'], cancelled: ['', 'Отменён'] };

/** Счета, с которых можно платить и переводить. */
export const spendable = (accounts) => accounts.filter((a) => a.status === 'active' && ['current', 'savings', 'business', 'credit', 'child'].includes(a.type));
const accOptions = (accounts) => accounts.map((a) => ({ value: a.id, label: `${t(a.name)} · ${formatMoney(a.balance)}` }));

function Row({ label, children, strong }) {
  return <div className="row" style={{ justifyContent: 'space-between' }}><span className={strong ? '' : 'muted'}>{label}</span>{strong ? <b>{children}</b> : <span>{children}</span>}</div>;
}

function BgPicker({ value, onChange }) {
  return (
    <Field label={t('Фон')}>
      <div className="row">
        {BACKGROUNDS.map((b) => <button key={b} type="button" className={`bg-${b}`} aria-label={b} onClick={() => onChange(b)} style={{ width: 44, height: 28, borderRadius: 6, border: value === b ? '3px solid var(--accent)' : '1px solid var(--line)', cursor: 'pointer' }} />)}
      </div>
    </Field>
  );
}

function PinPair({ f, setF }) {
  return (
    <div className="grid grid-2">
      <Input label={t('PIN — 3 цифры')} type="password" inputMode="numeric" maxLength={3} required value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '') })} />
      <Input label={t('PIN ещё раз')} type="password" inputMode="numeric" maxLength={3} required value={f.pin2} onChange={(e) => setF({ ...f, pin2: e.target.value.replace(/\D/g, '') })} />
    </div>
  );
}

// ——— Выпуск карты любого вида ———
export function NewCard() {
  useLang();
  const { data } = useAsync(() => get('/bank/overview'), []);
  const { data: s } = useAsync(() => get('/public/settings'), []);
  const typeQuery = new URLSearchParams(location.hash.split('?')[1] || '').get('type');
  const [type, setType] = useState(['debit', 'credit', 'child', 'gift'].includes(typeQuery) ? typeQuery : 'debit');
  const [f, setF] = useState({ account_id: '', pin: '', pin2: '', background: 'classic', limit: null, child_name: '', child_email: '', pocket_amount: null, limit_tx: null, limit_daily: null, amount: null, holder: '' });
  const [done, setDone] = useState(null);
  if (!data || !s) return <Spinner />;
  const debitAccounts = data.accounts.filter((a) => ['current', 'business'].includes(a.type) && a.status === 'active');
  const payAccounts = spendable(data.accounts).filter((a) => a.type !== 'child');
  if (!debitAccounts.length) return <div className="page narrow"><Empty>{t('Сначала откройте расчётный счёт')} — <a href="#/open">{t('открыть')}</a></Empty></div>;
  const accountId = f.account_id || (type === 'gift' ? payAccounts[0]?.id : debitAccounts[0].id);

  if (done) {
    return (
      <div className="page narrow">
        <div className="card stack">
          {done.pending ? (
            <>
              <h2>{t('Заявка отправлена')}</h2>
              <p>{t('Кредитный лимит одобряет банк. Карта появится в разделе «Карты», когда заявку рассмотрят.')}</p>
              <a className="btn" href="#/credit">{t('Мои кредиты')}</a>
            </>
          ) : (
            <>
              <h2>{t('Карта выпущена')}</h2>
              <BankCard card={done.card} showCodes />
              {done.card.type === 'gift' && <div className="form-ok">{t('Передайте получателю номер карты и PIN. Карту можно потратить на кассе или зачислить на счёт во ВлодБанке.')}</div>}
              {done.card.type === 'child' && done.pocket_started && <div className="form-ok">{t('Первые карманные уже на карте.')}</div>}
              <div className="small muted">{t('Номер')}: <span className="mono">{done.card.number}</span> · {t('срок')} <span className="mono">{mmYY(done.card.exp_month)}</span></div>
              <a className="btn" href="#/cards">{t('Готово')}</a>
            </>
          )}
        </div>
      </div>
    );
  }

  async function submit() {
    if (f.pin !== f.pin2) throw new Error(t('PIN не совпадает'));
    if (type === 'debit') setDone(await post('/bank/cards', { account_id: accountId, pin: f.pin, background: f.background }));
    if (type === 'credit') {
      await post('/bank/credit-lines', { limit: f.limit, pin: f.pin, background: f.background });
      setDone({ pending: true });
    }
    if (type === 'child') setDone(await post('/bank/child-cards', { child_name: f.child_name, child_email: f.child_email || undefined, pin: f.pin, background: f.background, pocket_amount: f.pocket_amount, limit_tx: f.limit_tx, limit_daily: f.limit_daily }));
    if (type === 'gift') setDone(await post('/bank/gift-cards', { from_account: accountId, amount: f.amount, pin: f.pin, background: f.background, holder: f.holder || undefined }));
  }

  const preview = { number: '770000000000', exp_month: 36, type, holder_name: (type === 'child' ? f.child_name : type === 'gift' ? f.holder || 'GIFT' : data.user.full_name).toUpperCase(), background: f.background, last4: '0000' };
  const hints = {
    debit: t('Номер — 12 цифр, PIN — 3 цифры. 3 неверных PIN подряд замораживают карту на 1 минуту.'),
    credit: t('Лимит одобряет банк. Льготный период {g} мес. без процентов, дальше {r} в месяц. Минимальный платёж {m} от долга, просрочка — штраф {f}.', { g: s.credit_grace_months, r: pct(s.credit_rate_bp), m: pct(s.credit_min_payment_bp), f: formatMoney(s.credit_late_fee) }),
    child: t('Счёт детской карты — ваш: вы видите историю, ставите лимиты и карманные. Если у ребёнка есть аккаунт во ВлодБанке, укажите его email — карта появится и у него.'),
    gift: t('Деньги переводятся на карту сразу. Получатель тратит её на кассе или зачисляет на свой счёт.'),
  };
  return (
    <div className="page medium">
      <h1>{t('Выпустить карту')}</h1>
      <div style={{ marginBottom: 16 }}>
        <Seg value={type} onChange={(v) => { setType(v); setF({ ...f, account_id: '' }); }} options={[{ value: 'debit', label: t('Дебетовая') }, { value: 'credit', label: t('Кредитная') }, { value: 'child', label: t('Детская') }, { value: 'gift', label: t('Подарочная') }]} />
      </div>
      <div className="grid grid-2">
        <div className="card">
          <Form submitLabel={type === 'credit' ? t('Отправить заявку') : t('Выпустить')} onSubmit={submit}>
            {type === 'debit' && <Select label={t('Счёт')} value={accountId} onChange={(e) => setF({ ...f, account_id: Number(e.target.value) })} options={accOptions(debitAccounts)} />}
            {type === 'credit' && <MoneyInput label={t('Желаемый лимит')} value={f.limit} onChange={(v) => setF({ ...f, limit: v })} hint={t('Не больше {x}', { x: formatMoney(s.credit_max_limit) })} />}
            {type === 'child' && (
              <>
                <Input label={t('Имя ребёнка')} required value={f.child_name} onChange={(e) => setF({ ...f, child_name: e.target.value })} />
                <Input label={t('Email ребёнка во ВлодБанке (необязательно)')} type="email" value={f.child_email} onChange={(e) => setF({ ...f, child_email: e.target.value })} />
                <MoneyInput label={t('Карманные каждый игровой месяц')} value={f.pocket_amount} onChange={(v) => setF({ ...f, pocket_amount: v })} hint={t('Первые — сразу, с основного счёта. Пусто — без карманных.')} />
                <div className="grid grid-2">
                  <MoneyInput label={t('Лимит на операцию')} value={f.limit_tx} onChange={(v) => setF({ ...f, limit_tx: v })} />
                  <MoneyInput label={t('Лимит в сутки')} value={f.limit_daily} onChange={(v) => setF({ ...f, limit_daily: v })} />
                </div>
              </>
            )}
            {type === 'gift' && (
              <>
                <Select label={t('Оплатить со счёта')} value={accountId || ''} onChange={(e) => setF({ ...f, account_id: Number(e.target.value) })} options={accOptions(payAccounts)} />
                <MoneyInput label={t('Сумма на карте')} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} hint={s.gift_card_fee ? t('Стоимость оформления {x}', { x: formatMoney(s.gift_card_fee) }) : null} />
                <Input label={t('Кому (имя на карте)')} maxLength={60} value={f.holder} onChange={(e) => setF({ ...f, holder: e.target.value })} />
              </>
            )}
            <PinPair f={f} setF={setF} />
            <BgPicker value={f.background} onChange={(b) => setF({ ...f, background: b })} />
          </Form>
        </div>
        <div className="stack">
          <BankCard card={preview} hideNumber />
          <p className="small muted">{hints[type]}</p>
        </div>
      </div>
    </div>
  );
}

// ——— Зачисление подарочной карты ———
export function RedeemGift({ accounts, onClose, onDone }) {
  const [f, setF] = useState({ number: '', pin: '', account_id: '' });
  const targets = accounts.filter((a) => ['current', 'savings', 'business'].includes(a.type) && a.status === 'active');
  const acc = f.account_id || targets[0]?.id;
  const toast = useToast();
  return (
    <Modal title={t('Зачислить подарочную карту')} onClose={onClose}>
      <Form submitLabel={t('Зачислить')} onSubmit={async () => {
        const r = await post('/bank/gift-cards/redeem', { number: f.number, pin: f.pin, account_id: acc });
        toast(t('Зачислено {x}', { x: formatMoney(r.amount) }), 'ok');
        onDone();
      }}>
        <Input label={t('Номер карты')} inputMode="numeric" placeholder="7700 0000 0000" required value={f.number} onChange={(e) => setF({ ...f, number: e.target.value })} />
        <Input label="PIN" type="password" inputMode="numeric" maxLength={3} required value={f.pin} onChange={(e) => setF({ ...f, pin: e.target.value.replace(/\D/g, '') })} />
        <Select label={t('На счёт')} value={acc || ''} onChange={(e) => setF({ ...f, account_id: Number(e.target.value) })} options={accOptions(targets)} />
      </Form>
    </Modal>
  );
}

// ——— Карманные для детской карты (вкладка в карточке карты) ———
export function PocketMoney({ card, onChange }) {
  const { data, reload } = useAsync(() => get('/bank/autopayments'), [card.id]);
  const [amount, setAmount] = useState(undefined);
  const toast = useToast();
  const ap = data?.autopayments.find((a) => a.card_id === card.id && a.kind === 'pocket' && ['active', 'paused'].includes(a.status));
  useEffect(() => { if (data) setAmount(ap ? ap.amount : null); }, [data]); // eslint-disable-line react-hooks/exhaustive-deps
  if (!data || amount === undefined) return <Spinner />;
  return (
    <Form submitLabel={t('Сохранить')} onSubmit={async () => { await post(`/bank/cards/${card.id}/pocket`, { amount }); toast(t('Сохранено'), 'ok'); reload(); onChange?.(); }}>
      <MoneyInput label={t('Карманные каждый игровой месяц')} value={amount} onChange={setAmount} hint={t('Пусто — отключить. Деньги переводятся с основного счёта.')} />
      {ap?.last_error && <div className="form-warn">{t(ap.last_error)}</div>}
      {ap && <div className="small muted">{t('Следующее начисление')}: {mmYY(ap.next_month)}</div>}
    </Form>
  );
}

// ——— Кредиты и кредитная карта ———
export function CreditPage({ tick }) {
  useLang();
  const { data, loading, reload } = useAsync(() => get('/bank/credit'), [tick]);
  const { data: ov } = useAsync(() => get('/bank/overview'), [tick]);
  const [apply, setApply] = useState(false);
  if ((loading && !data) || !ov) return <Spinner />;
  const [kind, label] = SCORE[data.level];
  const cl = data.credit_line;
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Кредиты')}</h1>
        <button className="btn" onClick={() => setApply(true)}>{t('Взять кредит')}</button>
      </div>
      <div className="grid grid-2">
        <div className="card stack">
          <h2>{t('Кредитный рейтинг')}</h2>
          <div className="row" style={{ alignItems: 'baseline' }}><span style={{ fontSize: '2rem', fontWeight: 700 }}>{data.score}</span><span className="muted">/ 1000</span> <Badge kind={kind}>{t(label)}</Badge></div>
          <div className="score-bar"><div style={{ width: `${data.score / 10}%` }} /></div>
          <p className="small muted">{t('Растёт за платежи вовремя и погашенные кредиты, падает за просрочки. Банк смотрит на рейтинг при выдаче кредитов и лимитов.')}</p>
        </div>
        <CreditCardBox cl={cl} terms={data.terms} accounts={ov.accounts} onChange={reload} />
      </div>
      <h2 style={{ marginTop: 24 }}>{t('Мои кредиты')}</h2>
      {!data.loans.length ? <Empty>{t('Кредитов нет')}</Empty> : data.loans.map((l) => <LoanCard key={l.id} loan={l} accounts={ov.accounts} onChange={reload} />)}
      {apply && <LoanApply terms={data.terms} accounts={ov.accounts} onClose={() => setApply(false)} onDone={() => { setApply(false); reload(); }} />}
    </div>
  );
}

function CreditCardBox({ cl, terms, accounts, onChange }) {
  const toast = useToast();
  if (!cl || ['rejected', 'closed'].includes(cl.status)) {
    return (
      <div className="card stack">
        <h2>{t('Кредитная карта')}</h2>
        {cl?.status === 'rejected' && <div className="form-warn">{t('Прошлая заявка отклонена')}{cl.decision_note ? `: ${cl.decision_note}` : ''}</div>}
        <p className="small muted">{t('Льготный период {g} мес., дальше {r} в месяц на долг. Лимит до {x}.', { g: terms.credit_grace_months, r: pct(terms.credit_rate_bp), x: formatMoney(terms.credit_max_limit) })}</p>
        <a className="btn" href="#/cards/new?type=credit">{t('Оформить кредитную карту')}</a>
      </div>
    );
  }
  if (cl.status === 'pending') {
    return <div className="card stack"><h2>{t('Кредитная карта')}</h2><StatusBadge status="pending" /><p>{t('Заявка на лимит {x} на рассмотрении.', { x: formatMoney(cl.limit_requested) })}</p></div>;
  }
  const from = spendable(accounts).find((a) => a.type === 'current');
  return (
    <div className="card stack">
      <div className="card-head"><h2>{t('Кредитная карта')}</h2><StatusBadge status="active" /></div>
      <Row label={t('Лимит')}><Money value={cl.limit} /></Row>
      <Row label={t('Доступно')}><Money value={cl.available} /></Row>
      <Row label={t('Долг')} strong><Money value={cl.debt} /></Row>
      {cl.debt > 0 && <Row label={t('Без процентов ещё')}>{t('{n} мес.', { n: cl.grace_months_left })}</Row>}
      {cl.min_payment > 0 && <Row label={t('Минимальный платёж до конца месяца')}><Money value={cl.min_payment_left} /></Row>}
      {cl.overdue_count > 0 && <div className="form-warn">{t('Просрочек: {n}', { n: cl.overdue_count })}</div>}
      <label className="check"><input type="checkbox" checked={cl.autorepay} onChange={async (e) => { await post(`/bank/credit-lines/${cl.id}/autorepay`, { on: e.target.checked }); toast(t('Сохранено'), 'ok'); onChange(); }} /> {t('Автопогашение минимального платежа с основного счёта')}</label>
      <div className="row">
        {cl.debt > 0 && from && <a className="btn" href={`#/transfer?from=${from.id}&to=${cl.account_id}`}>{t('Погасить долг')}</a>}
        <a className="btn secondary" href={`#/accounts/${cl.account_id}`}>{t('История')}</a>
      </div>
    </div>
  );
}

function LoanApply({ terms, accounts, onClose, onDone }) {
  const [f, setF] = useState({ amount: null, months: 12, purpose: '', pay_account_id: '' });
  const [pv, setPv] = useState(null);
  const targets = accounts.filter((a) => ['current', 'business'].includes(a.type) && a.status === 'active');
  const acc = f.pay_account_id || targets[0]?.id;
  useEffect(() => {
    setPv(null);
    if (!f.amount || !f.months) return undefined;
    const h = setTimeout(() => post('/bank/loans/preview', { amount: f.amount, months: f.months }).then(setPv).catch(() => {}), 300);
    return () => clearTimeout(h);
  }, [f.amount, f.months]);
  return (
    <Modal title={t('Заявка на кредит')} onClose={onClose}>
      <Form submitLabel={t('Отправить заявку')} onSubmit={async () => { await post('/bank/loans', { ...f, pay_account_id: acc }); onDone(); }}>
        <MoneyInput label={t('Сумма')} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} hint={t('До {x}', { x: formatMoney(terms.loan_max_amount) })} />
        <Input label={t('Срок, игровых месяцев')} type="number" min={1} max={terms.loan_max_months} value={f.months} onChange={(e) => setF({ ...f, months: Number(e.target.value) })} />
        <Input label={t('Цель (необязательно)')} maxLength={140} value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} />
        <Select label={t('Зачислить и списывать платежи')} value={acc || ''} onChange={(e) => setF({ ...f, pay_account_id: Number(e.target.value) })} options={accOptions(targets)} />
        {pv && (
          <div className="card" style={{ background: 'var(--surface-2)', boxShadow: 'none' }}>
            <Row label={t('Ставка')}>{pct(pv.rate_bp)} {t('в месяц')}</Row>
            <Row label={t('Платёж')} strong><Money value={pv.payment} /></Row>
            <Row label={t('Переплата')}><Money value={pv.overpay} /></Row>
            <p className="tiny muted">{t('Платёж списывается автоматически каждый игровой месяц. Просрочка — пени {p} от платежа и снижение рейтинга.', { p: pct(terms.loan_late_fee_bp) })}</p>
          </div>
        )}
      </Form>
    </Modal>
  );
}

function LoanCard({ loan, accounts, onChange }) {
  const [open, setOpen] = useState(loan.status === 'active');
  const from = spendable(accounts).filter((a) => !['credit', 'child'].includes(a.type));
  const [acc, setAcc] = useState(from[0]?.id);
  const toast = useToast();
  const paid = loan.schedule.filter((r) => r.status === 'paid').length;
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <div className="row" style={{ justifyContent: 'space-between', cursor: 'pointer' }} onClick={() => setOpen(!open)}>
        <div>
          <b>{t('Кредит №{n}', { n: loan.id })}</b> {loan.purpose && <span className="muted">· {loan.purpose}</span>}
          <div className="small muted">{loan.amount ? `${formatMoney(loan.amount)} · ${loan.months} ${t('мес.')} · ${pct(loan.rate_bp)} ${t('в месяц')}` : `${formatMoney(loan.amount_requested)} · ${loan.months_requested} ${t('мес.')}`}</div>
        </div>
        <div className="right">
          <StatusBadge status={LOAN_STATUS[loan.status]} />
          {loan.status === 'active' && <div className="small">{t('Остаток')}: <b><Money value={loan.principal_left} /></b></div>}
        </div>
      </div>
      {open && (
        <div className="stack" style={{ marginTop: 12 }}>
          {loan.status === 'pending' && <ActionButton kind="ghost" confirm={t('Отозвать заявку?')} action={async () => { await post(`/bank/loans/${loan.id}/cancel`); onChange(); }}>{t('Отозвать заявку')}</ActionButton>}
          {loan.status === 'rejected' && loan.decision_note && <div className="form-warn">{loan.decision_note}</div>}
          {loan.status === 'active' && (
            <>
              <div className="row">
                <span className="small">{t('Платёж')}: <b><Money value={loan.payment} /></b> · {t('оплачено {a} из {b}', { a: paid, b: loan.schedule.length })}</span>
              </div>
              {loan.overdue > 0 && <div className="form-warn">{t('Просрочено')}: <Money value={loan.overdue} /></div>}
              <div className="row">
                <select className="input" style={{ maxWidth: 260 }} value={acc || ''} onChange={(e) => setAcc(Number(e.target.value))}>
                  {from.map((a) => <option key={a.id} value={a.id}>{t(a.name)} · {formatMoney(a.balance)}</option>)}
                </select>
                {loan.overdue > 0 && <ActionButton kind="secondary" action={async () => { await post(`/bank/loans/${loan.id}/pay-overdue`, { account_id: acc }); toast(t('Просрочка погашена'), 'ok'); onChange(); }}>{t('Оплатить просрочку')}</ActionButton>}
                <ActionButton kind="secondary" confirm={t('Погасить кредит полностью?')} action={async () => { await post(`/bank/loans/${loan.id}/repay`, { account_id: acc }); toast(t('Кредит погашен'), 'ok'); onChange(); }}>{t('Погасить досрочно')}</ActionButton>
              </div>
            </>
          )}
          {loan.schedule.length > 0 && (
            <div className="table-wrap">
              <table className="table small">
                <thead><tr><th>№</th><th>{t('Месяц')}</th><th>{t('Долг')}</th><th>{t('Проценты')}</th><th>{t('Пени')}</th><th /></tr></thead>
                <tbody>
                  {loan.schedule.map((r) => {
                    const [k, l] = ROW_STATUS[r.status];
                    return <tr key={r.n}><td>{r.n}</td><td className="mono">{mmYY(r.due_month)}</td><td className="num"><Money value={r.principal} /></td><td className="num"><Money value={r.interest} /></td><td className="num">{r.penalty ? <Money value={r.penalty} /> : '—'}</td><td><Badge kind={k}>{t(l)}</Badge></td></tr>;
                  })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ——— Автоплатежи ———
export function AutopayPage({ tick }) {
  useLang();
  const { data, loading, reload } = useAsync(() => get('/bank/autopayments'), [tick]);
  const { data: ov } = useAsync(() => get('/bank/overview'), []);
  const [add, setAdd] = useState(false);
  if ((loading && !data) || !ov) return <Spinner />;
  const KIND = { transfer: 'Перевод', subscription: 'Подписка', pocket: 'Карманные' };
  const ST = { active: ['ok', 'Активен'], paused: ['warn', 'Пауза'], finished: ['', 'Завершён'] };
  return (
    <div className="page medium">
      <div className="page-head"><h1>{t('Автоплатежи')}</h1><button className="btn" onClick={() => setAdd(true)}>{t('Новый автоплатёж')}</button></div>
      <p className="muted small">{t('Списываются в начале каждого игрового месяца. После 3 неудачных попыток подряд автоплатёж ставится на паузу.')}</p>
      {!data.autopayments.length ? <Empty>{t('Автоплатежей нет')}</Empty> : (
        <div className="card list">
          {data.autopayments.map((a) => {
            const [k, l] = ST[a.status] || ['', a.status];
            return (
              <div key={a.id} className="list-item">
                <div className="li-main">
                  <div className="li-title">{a.title} <Badge kind={k}>{t(l)}</Badge></div>
                  <div className="li-sub">{t(KIND[a.kind])} · {a.to_name} · {t('следующий')}: {mmYY(a.next_month)}{a.remaining !== null ? ` · ${t('осталось {n}', { n: a.remaining })}` : ''}</div>
                  {a.last_error && <div className="tiny" style={{ color: 'var(--err)' }}>{t(a.last_error)}</div>}
                </div>
                <div className="right stack-sm">
                  <b><Money value={a.amount} /></b>
                  {a.status !== 'finished' && a.kind !== 'pocket' && (
                    <div className="row nowrap">
                      <ActionButton size="sm" kind="ghost" action={async () => { await post(`/bank/autopayments/${a.id}/status`, { status: a.status === 'active' ? 'paused' : 'active' }); reload(); }}>{a.status === 'active' ? t('Пауза') : t('Включить')}</ActionButton>
                      <ActionButton size="sm" kind="ghost" confirm={t('Удалить автоплатёж?')} action={async () => { await post(`/bank/autopayments/${a.id}/status`, { status: 'cancelled' }); reload(); }}>✕</ActionButton>
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
      {add && <AutopayForm accounts={ov.accounts} onClose={() => setAdd(false)} onDone={() => { setAdd(false); reload(); }} />}
    </div>
  );
}

function AutopayForm({ accounts, onClose, onDone }) {
  const from = spendable(accounts);
  const [f, setF] = useState({ title: '', kind: 'transfer', from_account: from[0]?.id, mode: 'card', value: '', amount: null, remaining: '', start_now: false });
  return (
    <Modal title={t('Новый автоплатёж')} onClose={onClose}>
      <Form submitLabel={t('Создать')} onSubmit={async () => {
        await post('/bank/autopayments', { title: f.title, kind: f.kind, from_account: f.from_account, amount: f.amount, remaining: f.remaining || null, start_now: f.start_now, to: { type: f.mode, value: f.value } });
        onDone();
      }}>
        <Seg value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={[{ value: 'transfer', label: t('Перевод') }, { value: 'subscription', label: t('Подписка') }]} />
        <Input label={t('Название')} required maxLength={80} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <Select label={t('Откуда')} value={f.from_account || ''} onChange={(e) => setF({ ...f, from_account: Number(e.target.value) })} options={accOptions(from)} />
        <Seg value={f.mode} onChange={(v) => setF({ ...f, mode: v, value: '' })} options={[{ value: 'card', label: t('На карту') }, { value: 'account', label: t('На счёт') }, { value: 'own', label: t('Между своими') }]} />
        {f.mode === 'own'
          ? <Select label={t('Куда')} value={f.value} onChange={(e) => setF({ ...f, value: e.target.value })} options={[{ value: '', label: '—' }, ...accounts.filter((a) => a.id !== f.from_account && a.status === 'active' && !['loan', 'gift', 'term'].includes(a.type)).map((a) => ({ value: String(a.id), label: t(a.name) }))]} />
          : <Input label={f.mode === 'card' ? t('Номер карты получателя') : t('Номер счёта получателя')} required value={f.value} onChange={(e) => setF({ ...f, value: e.target.value.toUpperCase() })} />}
        <MoneyInput label={t('Сумма каждый месяц')} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} />
        <Input label={t('Сколько раз (пусто — бессрочно)')} type="number" min={1} value={f.remaining} onChange={(e) => setF({ ...f, remaining: e.target.value })} />
        <label className="check"><input type="checkbox" checked={f.start_now} onChange={(e) => setF({ ...f, start_now: e.target.checked })} /> {t('Первый платёж — сейчас')}</label>
      </Form>
    </Modal>
  );
}

// ——— Кешбэк ———
export function CashbackPage({ tick }) {
  useLang();
  const { data, loading, reload } = useAsync(() => get('/bank/cashback'), [tick]);
  const [pick, setPick] = useState([]);
  const [error, setError] = useState(null);
  const toast = useToast();
  if (loading && !data) return <Spinner />;
  const locked = data.chosen.length > 0;
  const sel = locked ? data.chosen : pick;
  const toggle = (id) => setPick(pick.includes(id) ? pick.filter((x) => x !== id) : pick.length >= data.max ? pick : [...pick, id]);
  return (
    <div className="page medium">
      <h1>{t('Кешбэк')}</h1>
      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        <div className="card"><div className="stat"><span className="label">{t('Накоплено в этом месяце')}</span><span className="value"><Money value={data.accrued} /></span></div><p className="small muted">{t('Выплата — в начале следующего игрового месяца на основной счёт, не больше {x} в месяц.', { x: formatMoney(data.cap) })}</p></div>
        <div className="card"><p className="small">{t('Выберите до {n} категорий на игровой месяц. Кешбэк начисляется за оплату картой или по QR в магазинах выбранных категорий. Сменить выбор можно в следующем месяце.', { n: data.max })}</p></div>
      </div>
      <div className="grid grid-auto">
        {data.categories.map((c) => {
          const on = sel.includes(c.id);
          return (
            <button key={c.id} type="button" className="card" disabled={locked} onClick={() => toggle(c.id)} style={{ textAlign: 'left', cursor: locked ? 'default' : 'pointer', outline: on ? '2px solid var(--accent)' : 'none', font: 'inherit', color: 'inherit' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}><b>{t(c.name)}</b>{on && <Badge kind="ok">✓</Badge>}</div>
              <div style={{ fontSize: '1.5rem', fontWeight: 700 }}>{pct(c.rate_bp)}</div>
            </button>
          );
        })}
      </div>
      <ErrorBox error={error} />
      {!locked && (
        <div style={{ marginTop: 16 }}>
          <ActionButton disabled={!pick.length} action={async () => { setError(null); try { await post('/bank/cashback', { category_ids: pick }); toast(t('Категории выбраны'), 'ok'); reload(); } catch (e) { setError(e); } }}>{t('Выбрать ({n} из {m})', { n: pick.length, m: data.max })}</ActionButton>
        </div>
      )}
      {data.history.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>{t('Выплаты')}</h2>
          <div className="list">{data.history.map((h) => <div key={h.id} className="list-item"><div className="li-main">{t('Кешбэк за покупки')}</div><span className="amount-pos"><Money value={h.amount} plus /></span></div>)}</div>
        </div>
      )}
    </div>
  );
}

