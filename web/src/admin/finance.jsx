// Этап 6, админка: кредиты и кредитные карты, антифрод, категории кешбэка, инфляция.
import { useState } from 'react';
import { get, post, patch } from '../shared/api.js';
import { t, useLang, fmtDate } from '../shared/i18n.js';
import { Spinner, useAsync, useChannel, Money, MoneyInput, Input, Form, Modal, Empty, Badge, StatusBadge, ActionButton, Seg, useToast } from '../shared/ui.jsx';
import { mmYY } from '@bln/shared/time.js';
import { formatMoney } from '@bln/shared/money.js';

const pct = (bp) => `${(Number(bp) / 100).toLocaleString('ru-RU')}%`;
const LOAN_STATUS = { pending: 'pending', active: 'active', rejected: 'rejected', repaid: 'paid', cancelled: 'cancelled' };
const FRAUD_KIND = { transfer: 'Перевод', card_payment: 'Оплата картой', qr_payment: 'Оплата по QR', atm_withdraw: 'Снятие в банкомате' };

function scoreBadge(score) {
  const kind = score >= 600 ? 'ok' : score >= 400 ? 'warn' : 'err';
  return <Badge kind={kind}>{t('рейтинг')} {score}</Badge>;
}

// ——— Кредиты ———
export function CreditAdmin() {
  useLang();
  const [status, setStatus] = useState('pending');
  const { data, loading, reload } = useAsync(() => get(`/admin/credit?status=${status === 'all' ? '' : status}`), [status]);
  const [loan, setLoan] = useState(null);
  const [line, setLine] = useState(null);
  useChannel('admin', (m) => m.type === 'queue' && ['loan', 'credit'].includes(m.queue) && reload());
  if (loading && !data) return <Spinner />;
  return (
    <div className="stack">
      <div className="grid grid-4">
        <div className="card stat"><span className="label">{t('Выдано кредитов (остаток)')}</span><span className="value"><Money value={data.portfolio.loans} /></span></div>
        <div className="card stat"><span className="label">{t('Долг по кредитным картам')}</span><span className="value"><Money value={data.portfolio.cards} /></span></div>
        <div className="card stat"><span className="label">{t('Просроченных платежей')}</span><span className="value">{data.portfolio.overdue}</span></div>
      </div>
      <Seg value={status} onChange={setStatus} options={[{ value: 'pending', label: t('Заявки') }, { value: 'active', label: t('Действующие') }, { value: 'all', label: t('Все') }]} />
      <div className="grid grid-2">
        <div className="card">
          <h2>{t('Кредиты')}</h2>
          {!data.loans.length ? <p className="muted">{t('Пусто')}</p> : (
            <div className="list">
              {data.loans.map((l) => (
                <div key={l.id} className="list-item clickable" onClick={() => setLoan(l)}>
                  <div className="li-main">
                    <div className="li-title">№{l.id} · {l.full_name} {scoreBadge(l.credit_score)}</div>
                    <div className="li-sub">{formatMoney(l.amount ?? l.amount_requested)} · {l.months ?? l.months_requested} {t('мес.')}{l.purpose ? ` · ${l.purpose}` : ''}{l.overdue ? ` · ${t('просрочено')} ${formatMoney(l.overdue)}` : ''}</div>
                  </div>
                  <StatusBadge status={LOAN_STATUS[l.status]} />
                </div>
              ))}
            </div>
          )}
        </div>
        <div className="card">
          <h2>{t('Кредитные карты')}</h2>
          {!data.credit_lines.length ? <p className="muted">{t('Пусто')}</p> : (
            <div className="list">
              {data.credit_lines.map((c) => (
                <div key={c.id} className="list-item clickable" onClick={() => setLine(c)}>
                  <div className="li-main">
                    <div className="li-title">{c.full_name} {scoreBadge(c.credit_score)}</div>
                    <div className="li-sub">{c.status === 'pending' ? `${t('просит')} ${formatMoney(c.limit_requested)}` : `${t('лимит')} ${formatMoney(c.limit || 0)} · ${t('долг')} ${formatMoney(c.debt)}`}{c.overdue_count ? ` · ${t('просрочек')} ${c.overdue_count}` : ''}</div>
                  </div>
                  <StatusBadge status={c.status} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
      {loan && <LoanModal loan={loan} onClose={() => setLoan(null)} onDone={() => { setLoan(null); reload(); }} />}
      {line && <LineModal line={line} onClose={() => setLine(null)} onDone={() => { setLine(null); reload(); }} />}
    </div>
  );
}

function LoanModal({ loan, onClose, onDone }) {
  const { data: s } = useAsync(() => get('/admin/settings'), []);
  const [f, setF] = useState({ amount: loan.amount_requested, months: loan.months_requested, rate: null, note: '' });
  if (!s) return <Modal title={t('Кредит')} onClose={onClose}><Spinner /></Modal>;
  const rate = f.rate ?? s.settings.loan_rate_bp / 100;
  return (
    <Modal title={`${t('Кредит')} №${loan.id} · ${loan.full_name}`} onClose={onClose} wide>
      <div className="stack">
        <div className="row">{scoreBadge(loan.credit_score)} <StatusBadge status={LOAN_STATUS[loan.status]} /> {loan.purpose && <span className="muted">{loan.purpose}</span>}</div>
        {loan.status === 'pending' ? (
          <Form submitLabel={t('Одобрить и выдать')} onSubmit={async () => { await post(`/admin/loans/${loan.id}/decision`, { approve: true, amount: f.amount, months: f.months, rate_bp: Math.round(Number(rate) * 100), note: f.note }); onDone(); }}
            extra={<ActionButton kind="danger" action={async () => { await post(`/admin/loans/${loan.id}/decision`, { approve: false, note: f.note }); onDone(); }}>{t('Отказать')}</ActionButton>}>
            <MoneyInput label={t('Сумма')} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} hint={t('Клиент просит {x}', { x: formatMoney(loan.amount_requested) })} />
            <div className="grid grid-2">
              <Input label={t('Срок, игровых месяцев')} type="number" min={1} value={f.months} onChange={(e) => setF({ ...f, months: Number(e.target.value) })} />
              <Input label={t('Ставка, % в месяц')} type="number" step="0.01" min={0} value={rate} onChange={(e) => setF({ ...f, rate: e.target.value })} />
            </div>
            <Input label={t('Комментарий клиенту')} maxLength={200} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
          </Form>
        ) : (
          <>
            <div className="row">{formatMoney(loan.amount || 0)} · {loan.months} {t('мес.')} · {pct(loan.rate_bp || 0)} · {t('платёж')} {formatMoney(loan.payment || 0)} · {t('остаток')} <b>{formatMoney(loan.principal_left)}</b></div>
            {loan.schedule.length > 0 && (
              <div className="table-wrap"><table className="table small">
                <thead><tr><th>№</th><th>{t('Месяц')}</th><th>{t('Долг')}</th><th>{t('Проценты')}</th><th>{t('Пени')}</th><th>{t('Статус')}</th></tr></thead>
                <tbody>{loan.schedule.map((r) => <tr key={r.n}><td>{r.n}</td><td className="mono">{mmYY(r.due_month)}</td><td className="num"><Money value={r.principal} /></td><td className="num"><Money value={r.interest} /></td><td className="num">{r.penalty ? <Money value={r.penalty} /> : '—'}</td><td>{t({ planned: 'по графику', paid: 'оплачен', overdue: 'просрочен', cancelled: 'отменён' }[r.status])}</td></tr>)}</tbody>
              </table></div>
            )}
          </>
        )}
      </div>
    </Modal>
  );
}

function LineModal({ line, onClose, onDone }) {
  const [limit, setLimit] = useState(line.limit ?? line.limit_requested);
  const [note, setNote] = useState('');
  return (
    <Modal title={`${t('Кредитная карта')} · ${line.full_name}`} onClose={onClose}>
      <div className="stack">
        <div className="row">{scoreBadge(line.credit_score)} <StatusBadge status={line.status} /></div>
        {line.status === 'active' && <div className="small">{t('Долг')}: <b>{formatMoney(line.debt)}</b> · {t('доступно')} {formatMoney(line.available)} · {t('просрочек')}: {line.overdue_count}</div>}
        {line.status === 'pending' && (
          <Form submitLabel={t('Одобрить')} onSubmit={async () => { await post(`/admin/credit-lines/${line.id}/decision`, { approve: true, limit, note }); onDone(); }}
            extra={<ActionButton kind="danger" action={async () => { await post(`/admin/credit-lines/${line.id}/decision`, { approve: false, note }); onDone(); }}>{t('Отказать')}</ActionButton>}>
            <MoneyInput label={t('Лимит')} value={limit} onChange={setLimit} hint={t('Клиент просит {x}', { x: formatMoney(line.limit_requested) })} />
            <Input label={t('Комментарий клиенту')} maxLength={200} value={note} onChange={(e) => setNote(e.target.value)} />
          </Form>
        )}
        {line.status === 'active' && (
          <Form submitLabel={t('Изменить лимит')} onSubmit={async () => { await post(`/admin/credit-lines/${line.id}/limit`, { limit: limit || 0 }); onDone(); }}>
            <MoneyInput label={t('Лимит')} value={limit} onChange={setLimit} />
          </Form>
        )}
      </div>
    </Modal>
  );
}

// ——— Антифрод ———
export function FraudAdmin() {
  useLang();
  const [status, setStatus] = useState('pending');
  const { data, loading, reload } = useAsync(() => get(`/admin/fraud?status=${status}`), [status]);
  const toast = useToast();
  useChannel('admin', (m) => m.type === 'queue' && m.queue === 'fraud' && reload());
  if (loading && !data) return <Spinner />;
  const decide = (id, approve) => async () => {
    const note = approve ? '' : window.prompt(t('Причина отказа (увидит клиент)')) || '';
    const r = await post(`/admin/fraud/${id}/decision`, { approve, note });
    if (r.status === 'failed') toast(t('Перевод не выполнен: {x}', { x: r.note }), 'err');
    reload();
  };
  return (
    <div className="stack">
      <p className="small muted">{t('Переводы, похожие на мошенничество, ждут решения: «Одобрить» выполняет перевод. Крупные оплаты картой и снятия уже прошли — «Отменить» делает сторно и замораживает карту.')}</p>
      <Seg value={status} onChange={setStatus} options={[{ value: 'pending', label: t('Ждут решения') }, { value: 'all', label: t('Все') }]} />
      {!data.items.length ? <Empty>{t('Очередь пуста')}</Empty> : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>{t('Клиент')}</th><th>{t('Операция')}</th><th className="right">{t('Сумма')}</th><th>{t('Причина')}</th><th /></tr></thead>
            <tbody>
              {data.items.map((i) => (
                <tr key={i.id}>
                  <td>{i.full_name}<div className="tiny muted">{i.email} · {fmtDate(i.created_at)}</div></td>
                  <td>{t(FRAUD_KIND[i.kind] || i.kind)} {i.mode === 'hold' ? <Badge kind="warn">{t('задержан')}</Badge> : <Badge>{t('проведён')}</Badge>}
                    {i.to && <div className="tiny muted">→ {i.to}</div>}{i.memo && <div className="tiny muted">«{i.memo}»</div>}</td>
                  <td className="num right"><Money value={i.amount} /></td>
                  <td className="small">{t(i.reason)}{i.note && <div className="tiny muted">{i.note}</div>}</td>
                  <td className="right nowrap">
                    {i.status === 'pending' ? (
                      <>
                        <ActionButton size="sm" kind="ok-btn" action={decide(i.id, true)}>{i.mode === 'hold' ? t('Одобрить') : t('Всё в порядке')}</ActionButton>{' '}
                        <ActionButton size="sm" kind="danger" action={decide(i.id, false)}>{i.mode === 'hold' ? t('Отклонить') : t('Отменить')}</ActionButton>
                      </>
                    ) : <StatusBadge status={{ approved: 'approved', rejected: 'rejected', failed: 'rejected' }[i.status]} />}
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

// ——— Кешбэк ———
export function CashbackAdmin() {
  useLang();
  const { data, loading, reload } = useAsync(() => get('/admin/cashback-categories'), []);
  const [edit, setEdit] = useState(null);
  if (loading && !data) return <Spinner />;
  return (
    <div className="stack" style={{ maxWidth: 760 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <p className="small muted">{t('Категорию магазину выбирает владелец в настройках кассы. Клиент выбирает категории на каждый игровой месяц.')}</p>
        <button className="btn" onClick={() => setEdit({ name: '', rate_bp: 300 })}>{t('Добавить')}</button>
      </div>
      <div className="card table-wrap">
        <table className="table">
          <thead><tr><th>{t('Категория')}</th><th>{t('Ставка')}</th><th>{t('Магазинов')}</th><th className="right">{t('Начислено')}</th><th /></tr></thead>
          <tbody>
            {data.categories.map((c) => (
              <tr key={c.id} className="clickable" onClick={() => setEdit(c)}>
                <td>{t(c.name)} {!c.active && <Badge>{t('выключена')}</Badge>}</td><td>{pct(c.rate_bp)}</td><td>{c.shops}</td><td className="num right"><Money value={c.accrued} /></td><td className="right">✎</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && (
        <Modal title={edit.id ? t('Категория кешбэка') : t('Новая категория')} onClose={() => setEdit(null)}>
          <Form onSubmit={async () => {
            const body = { name: edit.name, rate_bp: Math.round(Number(edit.rate_bp)), active: edit.active !== false };
            if (edit.id) await patch(`/admin/cashback-categories/${edit.id}`, body); else await post('/admin/cashback-categories', body);
            setEdit(null);
            reload();
          }}>
            <Input label={t('Название')} required value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />
            <Input label={t('Кешбэк, %')} type="number" step="0.01" min={0} max={50} value={edit.rate_bp / 100} onChange={(e) => setEdit({ ...edit, rate_bp: Math.round(Number(e.target.value) * 100) })} />
            {edit.id && <label className="check"><input type="checkbox" checked={edit.active !== false} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> {t('Действует')}</label>}
          </Form>
        </Modal>
      )}
    </div>
  );
}

// ——— Инфляция (карточка в «Экономике») ———
export function InflationCard() {
  useLang();
  const { data, loading, reload } = useAsync(() => get('/admin/inflation'), []);
  const [rate, setRate] = useState(null);
  const toast = useToast();
  useChannel('clock', () => reload());
  if (loading && !data) return <div className="card"><Spinner /></div>;
  const h = data.history;
  const max = Math.max(...h.map((x) => x.index));
  const min = Math.min(...h.map((x) => x.index));
  const last = h.at(-1);
  return (
    <div className="card stack">
      <h2>{t('Инфляция')}</h2>
      <div className="row" style={{ alignItems: 'baseline' }}>
        <span style={{ fontSize: '1.5rem', fontWeight: 700 }}>{last ? last.index.toFixed(3) : '1.000'}</span>
        <span className="muted small">{t('индекс цен (старт игры = 1,000)')}</span>
      </div>
      {h.length > 1 && <div className="chart-bars">{h.map((x) => <div key={x.month} className="bar" title={`${mmYY(x.month)}: ${x.index.toFixed(4)} (${pct(x.rate_bp)})`} style={{ height: `${max === min ? 50 : 10 + ((x.index - min) / (max - min)) * 90}%` }} />)}</div>}
      <Form submitLabel={t('Сохранить')} onSubmit={async () => { await patch('/admin/settings', { inflation_bp: Math.round(Number(rate ?? data.rate_bp / 100) * 100) }); toast(t('Сохранено'), 'ok'); reload(); }}>
        <Input label={t('Инфляция, % за игровой месяц')} type="number" step="0.01" min={0} value={rate ?? data.rate_bp / 100} onChange={(e) => setRate(e.target.value)} hint={t('Оптовые цены поднимаются на этот процент каждый игровой месяц (оптовая база — в расширении кассы).')} />
      </Form>
    </div>
  );
}
