import { useEffect, useState } from 'react';
import { get, post, newIdemKey } from '../shared/api.js';
import { t, fmtDate, useLang } from '../shared/i18n.js';
import { navigate } from '../shared/router.js';
import {
  Spinner, useAsync, Money, MoneyInput, Input, Select, Form, Modal, Empty, StatusBadge, ActionButton, Seg, Badge, ErrorBox, useToast, QR, Button, Field,
} from '../shared/ui.jsx';
import { BankCard, CardBarcode, BACKGROUNDS, CARD_TYPES, PrintCardButton } from '../shared/cards.jsx';
import { spendable, RedeemGift, PocketMoney } from './finance.jsx';
import { renderThermal, receiptBlocks, shareCanvas } from '../shared/thermal.js';
import { formatCardNumber } from '@bln/shared/format.js';
import { mmYY } from '@bln/shared/time.js';
import { formatMoney } from '@bln/shared/money.js';

export const ACCOUNT_TYPES = { current: 'Расчётный', savings: 'Накопительный', term: 'Вклад на срок', business: 'Бизнес-счёт', credit: 'Кредитная карта', loan: 'Кредит', child: 'Детская карта', gift: 'Подарочная карта' };
export const TX_KINDS = {
  transfer: 'Перевод', transfer_own: 'Между своими счетами', card_payment: 'Оплата картой', qr_payment: 'Оплата по QR', refund: 'Возврат покупки',
  atm_withdraw: 'Снятие в банкомате', atm_deposit: 'Внесение в банкомате', teller_withdraw: 'Выдача наличных', teller_deposit: 'Внесение наличных',
  emission: 'Зачисление от банка', start_balance: 'Стартовый баланс', interest: 'Проценты', invoice: 'Оплата квитанции', invoice_cash: 'Квитанция наличными',
  salary: 'Зарплата', collection: 'Инкассация', card_fee: 'Обслуживание карты', account_close: 'Закрытие счёта', deposit_maturity: 'Возврат вклада',
  reversal: 'Отмена операции', vat_cash: 'НДС с наличной выручки',
  loan_issue: 'Выдача кредита', loan_payment: 'Платёж по кредиту', loan_repay: 'Досрочное погашение', credit_repay: 'Погашение кредитной карты',
  credit_interest: 'Проценты по кредитной карте', credit_penalty: 'Штраф за просрочку', autopayment: 'Автоплатёж', pocket_money: 'Карманные',
  cashback: 'Кешбэк', gift_purchase: 'Покупка подарочной карты', gift_redeem: 'Зачисление подарочной карты',
};

const pct = (bp) => `${(bp / 100).toLocaleString('ru-RU')}%`;

function useOverview(tick) {
  return useAsync(() => get('/bank/overview'), [tick]);
}

export function Dashboard({ tick }) {
  const { data, loading, reload } = useOverview(tick);
  if (loading && !data) return <Spinner />;
  const total = data.accounts.reduce((s, a) => s + a.balance, 0);
  const cards = data.cards.filter((c) => ['active', 'frozen'].includes(c.status));
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Здравствуйте, {name}', { name: data.user.full_name.split(' ')[0] })}</h1>
        <div className="stat right"><span className="label">{t('Всего на счетах')}</span><span className="value"><Money value={total} /></span></div>
      </div>
      {!data.accounts.length && (
        <div className="card stack" style={{ marginBottom: 16 }}>
          <h2>{t('Откройте первый счёт')}</h2>
          <p>{t('Расчётный счёт — основной. На него придёт стартовый баланс, к нему привязываются карты.')}</p>
          <ActionButton action={async () => { await post('/bank/accounts', { type: 'current' }); reload(); }}>{t('Открыть расчётный счёт')}</ActionButton>
        </div>
      )}
      <div className="row" style={{ marginBottom: 16 }}>
        <a className="btn" href="#/transfer">{t('Перевести')}</a>
        <a className="btn secondary" href="#/pay">{t('Оплатить квитанцию')}</a>
        <a className="btn secondary" href="#/open">{t('Открыть счёт')}</a>
        <a className="btn secondary" href="#/cards/new">{t('Выпустить карту')}</a>
        <a className="btn secondary" href="#/autopay">{t('Автоплатежи')}</a>
        <a className="btn secondary" href="#/state">{t('Госуслуги')}</a>
        <a className="btn ghost" href="#/atm">{t('Банкомат')}</a>
      </div>
      <div className="grid grid-2">
        <div className="card">
          <div className="card-head"><h2>{t('Счета')}</h2></div>
          <div className="list">
            {data.accounts.map((a) => (
              <a key={a.id} className="list-item clickable" href={`#/accounts/${a.id}`} style={{ color: 'inherit', textDecoration: 'none' }}>
                <div className="li-main">
                  <div className="li-title">{t(a.name)} {a.is_primary && <Badge kind="brand">{t('основной')}</Badge>} {a.status !== 'active' && <StatusBadge status={a.status} />}</div>
                  <div className="li-sub mono">{a.number}{a.rate_bp ? ` · ${pct(a.rate_bp)} ${t('в месяц')}` : ''}{a.credit_limit && a.type === 'credit' ? ` · ${t('лимит')} ${formatMoney(a.credit_limit)}` : ''}</div>
                </div>
                <b><Money value={a.balance} /></b>
              </a>
            ))}
          </div>
        </div>
        <div className="card">
          <div className="card-head"><h2>{t('Карты')}</h2><a href="#/cards" className="small">{t('Все')}</a></div>
          {!cards.length ? <p className="muted">{t('Карт пока нет')} — <a href="#/cards/new">{t('выпустить')}</a></p> : (
            <div className="row" style={{ alignItems: 'flex-start' }}>
              {cards.slice(0, 3).map((c) => <a key={c.id} href="#/cards"><BankCard card={c} small /></a>)}
            </div>
          )}
        </div>
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h2>{t('Последние операции')}</h2>
        {!data.recent.length ? <p className="muted">{t('Операций пока нет')}</p> : <History rows={data.recent} />}
      </div>
    </div>
  );
}

export function History({ rows, showBalance = false }) {
  useLang();
  return (
    <div className="list">
      {rows.map((r) => (
        <div key={`${r.tx_id || r.id}-${r.account_id || ''}`} className="list-item">
          <div className="li-main">
            <div className="li-title">{t(r.memo || TX_KINDS[r.kind] || r.kind)}</div>
            <div className="li-sub">{t(TX_KINDS[r.kind] || r.kind)} · {fmtDate(r.created_at)}{r.reversed_by ? ` · ${t('отменена')}` : ''}</div>
          </div>
          <div className="right">
            <div className={r.amount > 0 ? 'amount-pos' : 'amount-neg'}><Money value={r.amount} plus /></div>
            {showBalance && <div className="tiny muted"><Money value={r.balance_after} /></div>}
          </div>
        </div>
      ))}
    </div>
  );
}

export function AccountPage({ id, tick }) {
  const { data, loading, reload } = useAsync(() => get(`/bank/accounts/${id}`), [id, tick]);
  const [more, setMore] = useState([]);
  const [rename, setRename] = useState(null);
  const [showReq, setShowReq] = useState(false);
  useEffect(() => setMore([]), [id, tick]);
  if (loading && !data) return <Spinner />;
  const a = data.account;
  const rows = [...data.history, ...more];
  async function loadMore() {
    const last = rows[rows.length - 1];
    const r = await get(`/bank/accounts/${id}?before=${last.id}`);
    setMore((m) => [...m, ...r.history]);
  }
  return (
    <div className="page medium">
      <div className="page-head">
        <h1>{t(a.name)}</h1>
        <StatusBadge status={a.status} />
      </div>
      <div className="card">
        <div className="row" style={{ justifyContent: 'space-between' }}>
          <div className="stat"><span className="label">{t('Баланс')}</span><span className="value"><Money value={a.balance} /></span></div>
          <div className="stat right">
            <span className="label">{t(ACCOUNT_TYPES[a.type])}</span>
            <span className="mono">{a.number}</span>
            {a.rate_bp > 0 && <span className="small">{pct(a.rate_bp)} {t('в месяц')}, {a.compound ? t('сложный процент') : t('простой процент')}</span>}
            {a.matures_month !== null && <span className="small">{t('до')} {mmYY(a.matures_month)}</span>}
            {a.credit_limit > 0 && <span className="small">{t(a.type === 'loan' ? 'Сумма кредита' : 'Кредитный лимит')}: {formatMoney(a.credit_limit)}</span>}
          </div>
        </div>
        <div className="row" style={{ marginTop: 14 }}>
          {!['loan', 'gift', 'term'].includes(a.type) && <a className="btn" href={`#/transfer?from=${a.id}`}>{t('Перевести')}</a>}
          {a.type === 'loan' && <a className="btn" href="#/credit">{t('График платежей')}</a>}
          <button className="btn secondary" onClick={() => setShowReq(true)}>{t('Реквизиты')}</button>
          <button className="btn ghost" onClick={() => setRename(a.name)}>{t('Переименовать')}</button>
          {a.type === 'current' && !a.is_primary && <ActionButton kind="ghost" action={async () => { await post(`/bank/accounts/${a.id}/primary`); reload(); }}>{t('Сделать основным')}</ActionButton>}
          {!a.is_primary && a.type !== 'loan' && (
            <ActionButton kind="ghost" confirm={a.type === 'term' ? t('Досрочное закрытие вклада — со штрафом. Закрыть?') : t('Закрыть счёт? Остаток уйдёт на основной счёт.')} action={async () => { await post(`/bank/accounts/${a.id}/close`); navigate('/'); }}>
              {t('Закрыть счёт')}
            </ActionButton>
          )}
        </div>
      </div>
      <div className="card">
        <h2>{t('История')}</h2>
        {!rows.length ? <p className="muted">{t('Операций пока нет')}</p> : <History rows={rows} showBalance />}
        {rows.length >= 50 && rows.length % 50 === 0 && <button className="btn ghost block" onClick={loadMore}>{t('Показать ещё')}</button>}
      </div>
      {rename !== null && (
        <Modal title={t('Название счёта')} onClose={() => setRename(null)}>
          <Form onSubmit={async () => { await post(`/bank/accounts/${a.id}/rename`, { name: rename }); setRename(null); reload(); }}>
            <Input value={rename} onChange={(e) => setRename(e.target.value)} maxLength={80} />
          </Form>
        </Modal>
      )}
      {showReq && (
        <Modal title={t('Реквизиты')} onClose={() => setShowReq(false)}>
          <div className="stack center" style={{ alignItems: 'center' }}>
            <div className="mono" style={{ fontSize: '1.2rem' }}>{a.number}</div>
            <QR value={`BLNACC:${a.number}`} size={180} />
            <p className="small muted">{t('Покажите QR или продиктуйте номер счёта для перевода.')}</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

export function OpenAccount() {
  const { data: s } = useAsync(() => get('/public/settings'), []);
  const { data: ov } = useAsync(() => get('/bank/overview'), []);
  const [type, setType] = useState('current');
  const [compound, setCompound] = useState(true);
  const [term, setTerm] = useState(12);
  const [name, setName] = useState('');
  if (!s || !ov) return <Spinner />;
  const opts = [
    { value: 'current', label: t('Расчётный'), desc: t('Основной счёт для карт и переводов') },
    { value: 'savings', label: t('Накопительный'), desc: t('{p} в игровой месяц на остаток', { p: pct(s.savings_rate_bp) }) },
    { value: 'term', label: t('Вклад на срок'), desc: t('{p} в месяц; досрочное закрытие — штраф {f}', { p: pct(s.term_rate_bp), f: pct(s.term_early_penalty_bp) }) },
    { value: 'business', label: t('Бизнес-счёт'), desc: ov.has_ip ? t('Для ИП: платежи с кассы и инкассация') : t('Нужно свидетельство ИП во ВлодУслугах') },
  ];
  return (
    <div className="page medium">
      <h1>{t('Открыть счёт')}</h1>
      <div className="grid grid-2" style={{ marginBottom: 16 }}>
        {opts.map((o) => (
          <button key={o.value} type="button" className="card" onClick={() => setType(o.value)} style={{ textAlign: 'left', cursor: 'pointer', outline: type === o.value ? '2px solid var(--accent)' : 'none', font: 'inherit', color: 'inherit' }}>
            <b>{o.label}</b>
            <div className="small muted">{o.desc}</div>
          </button>
        ))}
      </div>
      <div className="card">
        <Form submitLabel={t('Открыть')} onSubmit={async () => {
          const r = await post('/bank/accounts', { type, compound, term_months: term, name: name || undefined });
          navigate(`/accounts/${r.account.id}`);
        }}>
          <Input label={t('Название (необязательно)')} value={name} onChange={(e) => setName(e.target.value)} maxLength={80} />
          {(type === 'savings' || type === 'term') && (
            <Field label={t('Проценты')}>
              <Seg value={compound} onChange={setCompound} options={[{ value: true, label: t('Сложные — капитализация') }, { value: false, label: t('Простые — на расчётный счёт') }]} />
            </Field>
          )}
          {type === 'term' && <Input label={t('Срок, игровых месяцев')} type="number" min={1} max={120} value={term} onChange={(e) => setTerm(Number(e.target.value))} />}
        </Form>
      </div>
    </div>
  );
}

export function CardsPage({ tick }) {
  const { data, loading, reload } = useAsync(() => get('/bank/cards'), [tick]);
  const { data: ov } = useAsync(() => get('/bank/overview'), [tick]);
  const [open, setOpen] = useState(null);
  const [redeem, setRedeem] = useState(false);
  if ((loading && !data) || !ov) return <Spinner />;
  const card = open && data.cards.find((c) => c.id === open);
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Карты')}</h1>
        <div className="row">
          <button className="btn secondary" onClick={() => setRedeem(true)}>🎁 {t('Зачислить подарочную')}</button>
          <a className="btn" href="#/cards/new">{t('Выпустить карту')}</a>
        </div>
      </div>
      {!data.cards.length ? <Empty>{t('Карт пока нет')}</Empty> : (
        <div className="grid grid-auto">
          {data.cards.map((c) => (
            <div key={c.id} className="stack-sm" style={{ cursor: 'pointer' }} onClick={() => setOpen(c.id)}>
              <BankCard card={c} />
              <div className="row small">
                <StatusBadge status={c.status} /> <span className="muted">{t(CARD_TYPES[c.type])}</span>
                {c.balance !== undefined && <span className="right nowrap" style={{ marginLeft: 'auto' }} title={c.type === 'credit' ? t('Доступно') : t('Баланс')}><b><Money value={c.type === 'credit' ? c.available : c.balance} /></b></span>}
              </div>
              {c.managed_by_parent && <div className="tiny muted">{t('Картой управляет родитель')}</div>}
            </div>
          ))}
        </div>
      )}
      {card && <CardModal card={card} onClose={() => setOpen(null)} onChange={reload} />}
      {redeem && <RedeemGift accounts={ov.accounts} onClose={() => setRedeem(false)} onDone={() => { setRedeem(false); reload(); }} />}
    </div>
  );
}

function CardModal({ card, onClose, onChange }) {
  const [tab, setTab] = useState('main');
  const [pin, setPin] = useState('');
  const [limits, setLimits] = useState({ limit_tx: card.limit_tx, limit_daily: card.limit_daily });
  const toast = useToast();
  const act = (fn, msg) => async () => { await fn(); toast(msg, 'ok'); onChange(); };
  const usable = ['active', 'frozen'].includes(card.status);
  const tabs = [{ value: 'main', label: t('Управление') }, { value: 'pin', label: 'PIN' }, { value: 'limits', label: t('Лимиты') }, { value: 'design', label: t('Дизайн') }];
  if (card.type === 'child') tabs.splice(3, 0, { value: 'pocket', label: t('Карманные') });
  if (card.type === 'gift') tabs.splice(2, 1);
  return (
    <Modal title={`${t('Карта')} •••• ${card.last4}`} onClose={onClose} wide>
      <div className="grid grid-2">
        <div className="stack">
          <BankCard card={card} showCodes />
          <CardBarcode number={card.number} />
          {card.number && !String(card.number).includes('•') && <PrintCardButton card={card} />}
          <div className="small muted">{t('Номер')}: <span className="mono">{formatCardNumber(card.number)}</span> · {t('срок')} <span className="mono">{mmYY(card.exp_month)}</span></div>
          {card.locked_until && <div className="form-warn">{t('Карта временно заблокирована после 3 неверных PIN')}</div>}
        </div>
        <div className="stack">
          {card.balance !== undefined && (
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="muted">{card.type === 'credit' ? t('Доступно') : t('Баланс')}</span>
              <b><Money value={card.type === 'credit' ? card.available : card.balance} /></b>
              <a className="small" href={`#/accounts/${card.account_id}`}>{t('История')}</a>
            </div>
          )}
          {card.managed_by_parent ? <div className="form-warn">{t('Это ваша детская карта. Лимиты, PIN и карманные настраивает родитель.')}</div> : <>
          <Seg value={tab} onChange={setTab} options={tabs} />
          {tab === 'pocket' && <PocketMoney card={card} onChange={onChange} />}
          {tab === 'main' && (
            <div className="stack">
              <StatusBadge status={card.status} />
              {usable && (card.status === 'frozen'
                ? <ActionButton kind="ok-btn" action={act(() => post(`/bank/cards/${card.id}/freeze`, { frozen: false }), t('Карта разморожена'))}>{t('Разморозить')}</ActionButton>
                : <ActionButton kind="secondary" action={act(() => post(`/bank/cards/${card.id}/freeze`, { frozen: true }), t('Карта заморожена'))}>❄ {t('Заморозить')}</ActionButton>)}
              {card.type !== 'gift' && <ActionButton kind="secondary" confirm={t('Выпустить новую карту взамен этой? Номер изменится, PIN сохранится.')} action={act(() => post(`/bank/cards/${card.id}/reissue`), t('Карта перевыпущена'))}>{t('Перевыпустить')}</ActionButton>}
              {usable && <ActionButton kind="danger" confirm={t('Закрыть карту навсегда?')} action={act(() => post(`/bank/cards/${card.id}/close`), t('Карта закрыта'))}>{t('Закрыть карту')}</ActionButton>}
            </div>
          )}
          {tab === 'pin' && (
            <Form submitLabel={t('Сменить PIN')} onSubmit={async () => { await post(`/bank/cards/${card.id}/pin`, { pin }); setPin(''); toast(t('PIN изменён'), 'ok'); }}>
              <Input label={t('Новый PIN — 3 цифры')} type="password" inputMode="numeric" maxLength={3} pattern="\d{3}" required value={pin} onChange={(e) => setPin(e.target.value.replace(/\D/g, ''))} />
            </Form>
          )}
          {tab === 'limits' && (
            <Form submitLabel={t('Сохранить лимиты')} onSubmit={async () => { await post(`/bank/cards/${card.id}/limits`, limits); toast(t('Лимиты сохранены'), 'ok'); onChange(); }}>
              <MoneyInput label={t('На одну операцию')} value={limits.limit_tx} onChange={(v) => setLimits({ ...limits, limit_tx: v })} hint={t('Пусто — без лимита')} />
              <MoneyInput label={t('В сутки')} value={limits.limit_daily} onChange={(v) => setLimits({ ...limits, limit_daily: v })} hint={t('Пусто — без лимита')} />
            </Form>
          )}
          {tab === 'design' && (
            <div className="grid grid-2">
              {BACKGROUNDS.map((b) => (
                <button key={b} type="button" className={`bank-card small bg-${b}`} style={{ border: card.background === b ? '3px solid var(--accent)' : '0', cursor: 'pointer', minHeight: 70 }} onClick={act(() => post(`/bank/cards/${card.id}/design`, { background: b }), t('Дизайн обновлён'))} aria-label={b} />
              ))}
            </div>
          )}
          </>}
        </div>
      </div>
    </Modal>
  );
}

export function TransferPage() {
  const { data } = useAsync(() => get('/bank/overview'), []);
  const query = new URLSearchParams(location.hash.split('?')[1] || '');
  const fromQuery = Number(query.get('from')) || null;
  const toQuery = query.get('to') || '';
  const [mode, setMode] = useState(toQuery ? 'own' : 'card');
  const [from, setFrom] = useState(fromQuery);
  const [value, setValue] = useState(toQuery);
  const [amount, setAmount] = useState(null);
  const [memo, setMemo] = useState('');
  const [preview, setPreview] = useState(null);
  const [search, setSearch] = useState('');
  const [found, setFound] = useState([]);
  const [picked, setPicked] = useState(null);
  const [idem, setIdem] = useState(newIdemKey);
  const [done, setDone] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    if (mode !== 'user' || search.trim().length < 2) { setFound([]); return undefined; }
    const h = setTimeout(() => get(`/bank/recipients?q=${encodeURIComponent(search)}`).then((r) => setFound(r.recipients)).catch(() => {}), 250);
    return () => clearTimeout(h);
  }, [search, mode]);
  if (!data) return <Spinner />;
  const accounts = spendable(data.accounts);
  const ownTargets = data.accounts.filter((a) => a.status === 'active' && !['loan', 'gift'].includes(a.type));
  const fromId = from || accounts[0]?.id;
  const to = mode === 'user' ? { type: 'user', value: picked?.id } : mode === 'own' ? { type: 'own', value } : { type: mode, value };

  if (done) {
    return (
      <div className="page narrow">
        <div className="card stack center" style={{ alignItems: 'center' }}>
          <div style={{ fontSize: '3rem' }}>{done.held ? '⏳' : '✓'}</div>
          <h2>{done.held ? t('Перевод на проверке') : t('Перевод выполнен')}</h2>
          {done.held && <p className="small muted center">{t('Служба безопасности банка проверит операцию. Деньги спишутся после одобрения — мы пришлём уведомление.')}</p>}
          <div style={{ fontSize: '1.6rem', fontWeight: 700 }}><Money value={done.amount} /></div>
          <div className="muted">{done.recipient.name}</div>
          <div className="row"><a className="btn" href="#/">{t('На главную')}</a><button className="btn secondary" onClick={() => { setDone(null); setPreview(null); setAmount(null); setIdem(newIdemKey()); }}>{t('Ещё перевод')}</button></div>
        </div>
      </div>
    );
  }

  return (
    <div className="page medium">
      <h1>{t('Перевод')}</h1>
      <div className="card stack">
        <Seg value={mode} onChange={(m) => { setMode(m); setValue(''); setPicked(null); setPreview(null); }} options={[
          { value: 'card', label: t('По номеру карты') }, { value: 'account', label: t('По номеру счёта') }, { value: 'user', label: t('По имени') }, { value: 'own', label: t('Между своими') },
        ]} />
        <Select label={t('Откуда')} value={fromId || ''} onChange={(e) => { setFrom(Number(e.target.value)); setPreview(null); }} options={accounts.map((a) => ({ value: a.id, label: `${t(a.name)} · ${formatMoney(a.balance)}` }))} />
        {mode === 'card' && <Input label={t('Номер карты получателя')} inputMode="numeric" placeholder="7700 0000 0000" value={value} onChange={(e) => { setValue(e.target.value); setPreview(null); }} />}
        {mode === 'account' && <Input label={t('Номер счёта получателя')} placeholder="BF40…" value={value} onChange={(e) => { setValue(e.target.value.toUpperCase()); setPreview(null); }} />}
        {mode === 'own' && <Select label={t('Куда')} value={value} onChange={(e) => { setValue(e.target.value); setPreview(null); }} options={[{ value: '', label: '—' }, ...ownTargets.filter((a) => a.id !== fromId).map((a) => ({ value: String(a.id), label: `${t(a.name)} · ${formatMoney(a.balance)}` }))]} />}
        {mode === 'user' && (
          <div className="stack-sm">
            <Input label={t('Имя получателя')} value={search} onChange={(e) => { setSearch(e.target.value); setPicked(null); setPreview(null); }} />
            {!picked && found.map((r) => (
              <button key={r.id} type="button" className="list-item clickable" style={{ border: 0, background: 'none', font: 'inherit', color: 'inherit', textAlign: 'left' }} onClick={() => { setPicked(r); setSearch(r.full_name); }}>
                <div className="li-main"><div className="li-title">{r.full_name}</div><div className="li-sub">{t('счёт')} ••{r.account_tail}</div></div>
              </button>
            ))}
          </div>
        )}
        <MoneyInput label={t('Сумма')} value={amount} onChange={(v) => { setAmount(v); setPreview(null); }} />
        <Input label={t('Сообщение получателю')} maxLength={140} value={memo} onChange={(e) => setMemo(e.target.value)} />
        <ErrorBox error={error} />
        {!preview ? (
          <ActionButton disabled={!amount} action={async () => { setError(null); try { setPreview(await post('/bank/transfers/preview', { amount, to })); } catch (e) { setError(e); } }}>{t('Продолжить')}</ActionButton>
        ) : (
          <div className="stack">
            <div className="card" style={{ background: 'var(--surface-2)', boxShadow: 'none' }}>
              <div className="row" style={{ justifyContent: 'space-between' }}><span>{t('Получатель')}</span><b>{preview.recipient.name} ••{preview.recipient.account_tail}</b></div>
              <div className="row" style={{ justifyContent: 'space-between' }}><span>{t('Сумма')}</span><Money value={preview.amount} /></div>
              <div className="row" style={{ justifyContent: 'space-between' }}><span>{t('Комиссия')}</span><Money value={preview.fee} /></div>
              <div className="row" style={{ justifyContent: 'space-between' }}><b>{t('Спишется')}</b><b><Money value={preview.total} /></b></div>
            </div>
            <ActionButton action={async () => {
              setError(null);
              try {
                const r = await post('/bank/transfers', { from_account: fromId, amount, to, memo }, { idem });
                setDone({ ...preview, held: !!r.held });
              } catch (e) { setError(e); }
            }}>{t('Перевести')} {formatMoney(preview.total)}</ActionButton>
          </div>
        )}
      </div>
    </div>
  );
}

export function PayInvoice({ number }) {
  const [no, setNo] = useState(number || '');
  const [inv, setInv] = useState(null);
  const [error, setError] = useState(null);
  const [account, setAccount] = useState(null);
  const [paid, setPaid] = useState(false);
  const [idem] = useState(newIdemKey);
  const { data } = useAsync(() => get('/bank/overview'), []);
  useEffect(() => { if (number) lookup(number); }, [number]);
  async function lookup(n) {
    setError(null);
    setInv(null);
    try { setInv((await get(`/gov/invoices/${encodeURIComponent(n.trim())}`)).invoice); } catch (e) { setError(e); }
  }
  if (!data) return <Spinner />;
  const accounts = spendable(data.accounts);
  const acc = account || accounts[0]?.id;
  return (
    <div className="page narrow">
      <div className="page-head"><h1>{t('Оплата квитанции ВлодУслуг')}</h1><a className="btn secondary" href="#/autopay">{t('Автоплатежи')}</a></div>
      <div className="card stack">
        <form className="row nowrap" onSubmit={(e) => { e.preventDefault(); lookup(no); }}>
          <input className="input" placeholder={t('Номер квитанции')} value={no} onChange={(e) => setNo(e.target.value.toUpperCase())} />
          <button className="btn secondary">{t('Найти')}</button>
        </form>
        <ErrorBox error={error} />
        {inv && (
          <>
            <div className="card" style={{ background: 'var(--surface-2)', boxShadow: 'none' }}>
              <b>{t(inv.purpose)}</b>
              {inv.payer && <div className="small muted">{t('Плательщик')}: {inv.payer}</div>}
              <div style={{ fontSize: '1.5rem', fontWeight: 700 }}><Money value={inv.amount} /></div>
              <StatusBadge status={inv.status} />
            </div>
            {paid ? <div className="form-ok">{t('Оплачено. Квитанция погашена во ВлодУслугах.')}</div> : inv.status === 'unpaid' && (
              <>
                <Select label={t('Счёт списания')} value={acc || ''} onChange={(e) => setAccount(Number(e.target.value))} options={accounts.map((a) => ({ value: a.id, label: `${t(a.name)} · ${formatMoney(a.balance)}` }))} />
                <ActionButton action={async () => { await post(`/bank/invoices/${inv.number}/pay`, { account_id: acc }, { idem }); setPaid(true); }}>{t('Оплатить')} {formatMoney(inv.amount)}</ActionButton>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
}

export function QrPay({ token }) {
  const { data, loading, error, reload } = useAsync(() => get(`/bank/qr-pay/${token}`), [token]);
  const { data: ov } = useAsync(() => get('/bank/overview'), []);
  const [account, setAccount] = useState(null);
  const [paid, setPaid] = useState(null);
  if ((loading && !data) || !ov) return <Spinner />;
  if (error) return <div className="page narrow"><ErrorBox error={error} /></div>;
  const p = data.payment;
  const accounts = spendable(ov.accounts);
  const acc = account || accounts[0]?.id;
  return (
    <div className="page narrow">
      <h1>{t('Оплата по QR')}</h1>
      <div className="card stack">
        <b>{p.title}</b>
        {p.items.length > 0 && (
          <div className="list small">
            {p.items.map((i, n) => <div key={n} className="list-item"><div className="li-main">{i.name}</div><Money value={Number(i.total)} /></div>)}
          </div>
        )}
        <div className="row" style={{ justifyContent: 'space-between' }}><b>{t('К оплате')}</b><b style={{ fontSize: '1.4rem' }}><Money value={p.amount} /></b></div>
        {paid ? (
          <>
            <div className="form-ok">{t('Оплачено')}</div>
            <a className="btn" href={`#/receipt/${paid.sale_id}`}>{t('Чек')}</a>
          </>
        ) : p.status !== 'pending' ? <StatusBadge status={p.status} /> : (
          <>
            <Select label={t('Счёт списания')} value={acc || ''} onChange={(e) => setAccount(Number(e.target.value))} options={accounts.map((a) => ({ value: a.id, label: `${t(a.name)} · ${formatMoney(a.balance)}` }))} />
            <ActionButton action={async () => { setPaid(await post(`/bank/qr-pay/${token}`, { account_id: acc })); reload(); }}>{t('Оплатить')} {formatMoney(p.amount)}</ActionButton>
          </>
        )}
      </div>
    </div>
  );
}

export function ReceiptPage({ id }) {
  const [img, setImg] = useState(null);
  const [canvas, setCanvas] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => {
    (async () => {
      try {
        const r = await get(`/bank/receipts/${id}`);
        const c = await renderThermal(receiptBlocks(r, t));
        setCanvas(c);
        setImg(c.toDataURL('image/png'));
      } catch (e) { setError(e); }
    })();
  }, [id]);
  return (
    <div className="page narrow">
      <h1>{t('Чек')}</h1>
      <ErrorBox error={error} />
      {!img && !error && <Spinner />}
      {img && (
        <div className="stack">
          <div className="receipt-paper"><img src={img} alt={t('Чек')} /></div>
          <Button onClick={() => shareCanvas(canvas, `receipt-${id}.png`)}>{t('Скачать / поделиться PNG')}</Button>
        </div>
      )}
    </div>
  );
}

export function ProfilePage({ me }) {
  const [f, setF] = useState({ old_password: '', password: '' });
  const toast = useToast();
  return (
    <div className="page narrow">
      <h1>{t('Профиль')}</h1>
      <div className="card stack">
        <div><b>{me.full_name}</b></div>
        <div className="muted">{me.email}</div>
        <div>{t('Паспорт')}: <span className="mono">{me.passport_no}</span> {me.passport_verified ? <Badge kind="ok">{t('подтверждён')}</Badge> : <Badge kind="warn">{t('не подтверждён')}</Badge>}</div>
        {me.roles.length > 0 && <div>{t('Роли')}: {me.roles.map((r) => <Badge key={r} kind="brand">{r}</Badge>)}</div>}
      </div>
      <div className="card">
        <h2>{t('Сменить пароль')}</h2>
        <Form submitLabel={t('Сменить')} onSubmit={async () => { await post('/auth/bank/password', f); setF({ old_password: '', password: '' }); toast(t('Пароль изменён'), 'ok'); }}>
          <Input label={t('Текущий пароль')} type="password" value={f.old_password} onChange={(e) => setF({ ...f, old_password: e.target.value })} autoComplete="current-password" />
          <Input label={t('Новый пароль (от 8 символов)')} type="password" minLength={8} required value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" />
        </Form>
      </div>
    </div>
  );
}

