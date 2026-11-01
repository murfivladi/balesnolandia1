import { useEffect, useState } from 'react';
import { get, post, newIdemKey } from '../shared/api.js';
import { t } from '../shared/i18n.js';
import { Spinner, useAsync, Money, MoneyInput, Input, Select, Form, Modal, Empty, StatusBadge, Tabs, useToast, Badge } from '../shared/ui.jsx';
import { formatMoney } from '@bln/shared/money.js';
import { ACCOUNT_TYPES } from './pages.jsx';
import { PrintCardButton } from '../shared/cards.jsx';

/** Рабочее место операциониста: клиенты, карты, наличные, инкассация. */
export function TellerPage() {
  const [tab, setTab] = useState('clients');
  return (
    <div className="page">
      <h1>{t('Операционист')}</h1>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'clients', label: t('Клиенты') }, { value: 'collection', label: t('Инкассация') }]} />
      {tab === 'clients' ? <Clients /> : <Collection />}
    </div>
  );
}

function Clients() {
  const [q, setQ] = useState('');
  const [list, setList] = useState([]);
  const [open, setOpen] = useState(null);
  useEffect(() => {
    if (q.trim().length < 2) { setList([]); return undefined; }
    const h = setTimeout(() => get(`/bank/teller/clients?q=${encodeURIComponent(q)}`).then((r) => setList(r.clients)).catch(() => {}), 250);
    return () => clearTimeout(h);
  }, [q]);
  return (
    <div className="grid grid-2">
      <div className="card stack">
        <Input label={t('Поиск: имя, email, паспорт или номер карты')} value={q} onChange={(e) => setQ(e.target.value)} autoFocus />
        <div className="list">
          {list.map((c) => (
            <button key={c.id} type="button" className="list-item clickable" style={{ border: 0, background: open === c.id ? 'var(--surface-2)' : 'none', font: 'inherit', color: 'inherit', textAlign: 'left' }} onClick={() => setOpen(c.id)}>
              <div className="li-main"><div className="li-title">{c.full_name}</div><div className="li-sub">{c.email} · {c.passport_no || t('без паспорта')}</div></div>
              <StatusBadge status={c.status} />
            </button>
          ))}
          {q.length >= 2 && !list.length && <p className="muted">{t('Никого не нашли')}</p>}
        </div>
      </div>
      <div>{open ? <ClientCard id={open} /> : <Empty>{t('Выберите клиента')}</Empty>}</div>
    </div>
  );
}

function ClientCard({ id }) {
  const { data, loading, reload } = useAsync(() => get(`/bank/teller/clients/${id}`), [id]);
  const [cash, setCash] = useState(null);
  const [card, setCard] = useState(null);
  const [issued, setIssued] = useState(null);
  const toast = useToast();
  if (loading && !data) return <Spinner />;
  const c = data.client;
  return (
    <div className="card stack">
      <div>
        <h2 style={{ marginBottom: 2 }}>{c.full_name}</h2>
        <div className="small muted">{c.email} · {c.passport_no || '—'} {c.passport_verified ? <Badge kind="ok">{t('паспорт подтверждён')}</Badge> : <Badge kind="warn">{t('паспорт не подтверждён')}</Badge>}</div>
      </div>
      <h3>{t('Счета')}</h3>
      {!data.accounts.length ? <p className="muted">{t('Счетов нет')}</p> : (
        <div className="list">
          {data.accounts.map((a) => (
            <div key={a.id} className="list-item">
              <div className="li-main"><div className="li-title">{a.name}</div><div className="li-sub mono">{a.number} · {t(ACCOUNT_TYPES[a.type])}</div></div>
              <b><Money value={a.balance} /></b>
              <button className="btn sm secondary" onClick={() => setCash({ account: a, direction: 'in', amount: null })}>{t('Внести')}</button>
              <button className="btn sm secondary" onClick={() => setCash({ account: a, direction: 'out', amount: null })}>{t('Выдать')}</button>
            </div>
          ))}
        </div>
      )}
      <div className="row">
        {c.passport_verified && <button className="btn sm ghost" onClick={async () => { try { await post(`/bank/teller/clients/${id}/accounts`, { type: 'current' }); reload(); } catch (e) { toast(e.message, 'err'); } }}>{t('Открыть расчётный счёт')}</button>}
        {data.accounts.length > 0 && <button className="btn sm" onClick={() => setCard({ account_id: data.accounts[0].id, pin: '' })}>{t('Выдать карту')}</button>}
      </div>
      <h3>{t('Карты')}</h3>
      {!data.cards.length ? <p className="muted">{t('Карт нет')}</p> : data.cards.map((k) => <div key={k.id} className="row small"><span className="mono">{k.number}</span><StatusBadge status={k.status} />{['active', 'frozen'].includes(k.status) && <PrintCardButton card={k} kind="ghost" size="sm" />}</div>)}

      {cash && (
        <Modal title={cash.direction === 'in' ? t('Приём наличных') : t('Выдача наличных')} onClose={() => setCash(null)}>
          <Form submitLabel={t('Провести')} onSubmit={async () => {
            await post('/bank/teller/cash', { account_id: cash.account.id, direction: cash.direction, amount: cash.amount }, { idem: newIdemKey() });
            toast(t('Операция проведена'), 'ok');
            setCash(null);
            reload();
          }}>
            <p className="small">{cash.account.name} · <span className="mono">{cash.account.number}</span> · <Money value={cash.account.balance} /></p>
            <MoneyInput label={t('Сумма')} value={cash.amount} onChange={(v) => setCash({ ...cash, amount: v })} big autoFocus />
            <p className="small muted">{cash.direction === 'in' ? t('Пересчитайте купюры клиента перед зачислением.') : t('Выдайте клиенту наличные после проведения.')}</p>
          </Form>
        </Modal>
      )}
      {issued && (
        <Modal title={t('Карта выпущена')} onClose={() => setIssued(null)}>
          <div className="stack">
            <div className="mono" style={{ fontSize: '1.3rem' }}>{issued.number}</div>
            <PrintCardButton card={issued} kind="" />
          </div>
        </Modal>
      )}
      {card && (
        <Modal title={t('Выдача карты')} onClose={() => setCard(null)}>
          <Form submitLabel={t('Выпустить')} onSubmit={async () => {
            const r = await post(`/bank/teller/clients/${id}/cards`, card);
            toast(`${t('Карта выпущена')}: ${r.card.number}`, 'ok');
            setCard(null);
            setIssued(r.card);
            reload();
          }}>
            <Select label={t('Счёт')} value={card.account_id} onChange={(e) => setCard({ ...card, account_id: Number(e.target.value) })} options={data.accounts.filter((a) => ['current', 'business'].includes(a.type)).map((a) => ({ value: a.id, label: `${a.name} · ${formatMoney(a.balance)}` }))} />
            <Input label={t('PIN — клиент вводит сам, 3 цифры')} type="password" inputMode="numeric" maxLength={3} required value={card.pin} onChange={(e) => setCard({ ...card, pin: e.target.value.replace(/\D/g, '') })} />
          </Form>
        </Modal>
      )}
    </div>
  );
}

function Collection() {
  const { data, loading } = useAsync(() => get('/bank/teller/shops'), []);
  const [shop, setShop] = useState('');
  const [amount, setAmount] = useState(null);
  const [idem, setIdem] = useState(newIdemKey);
  const toast = useToast();
  if (loading && !data) return <Spinner />;
  if (!data.shops.length) return <Empty>{t('Магазинов пока нет')}</Empty>;
  const shopId = shop || data.shops[0].id;
  return (
    <div className="card" style={{ maxWidth: 520 }}>
      <p className="muted">{t('Примите наличные из кассы магазина и зачислите их на бизнес-счёт.')}</p>
      <Form submitLabel={t('Провести инкассацию')} onSubmit={async () => {
        await post('/bank/teller/collection', { shop_id: shopId, amount }, { idem });
        toast(t('Инкассация проведена'), 'ok');
        setAmount(null);
        setIdem(newIdemKey());
      }}>
        <Select label={t('Магазин')} value={shopId} onChange={(e) => setShop(Number(e.target.value))} options={data.shops.map((s) => ({ value: s.id, label: `${s.name} — ${s.owner}` }))} />
        <MoneyInput label={t('Сумма наличных')} value={amount} onChange={setAmount} big />
      </Form>
    </div>
  );
}
