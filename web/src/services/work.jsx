// Этап 8: рабочие места госслужащих — обращения, полиция, налоговая, врач, пособия.
import { useState } from 'react';
import { get, post } from '../shared/api.js';
import { t, fmtDate } from '../shared/i18n.js';
import {
  Spinner, Empty, Modal, Form, useAsync, ActionButton, Badge, ErrorBox, Subnav, Input, Select, MoneyInput, Money, StatusBadge, Button,
} from '../shared/ui.jsx';
import { formatMoney, pct } from '@bln/shared/money.js';
import { ADDRESSEES } from './appeals.jsx';
import { DECL_STATUS } from './taxes.jsx';

const ROLE_TABS = {
  appeals: ['official', 'police', 'tax', 'doctor'],
  police: ['police'],
  tax: ['tax'],
  doctor: ['doctor'],
  benefits: ['official'],
};

export function WorkPage({ me, route }) {
  const roles = me?.roles || [];
  const isAdmin = roles.includes('admin');
  const can = (k) => isAdmin || ROLE_TABS[k].some((r) => roles.includes(r));
  const tabs = [['appeals', 'Обращения'], ['police', 'Полиция'], ['tax', 'Налоговая'], ['doctor', 'Врач'], ['benefits', 'Пособия']].filter(([k]) => can(k));
  const sub = route.path.split('/')[2] || tabs[0]?.[0];
  if (!tabs.length) return <div className="page"><Empty>{t('Нет доступа')}</Empty></div>;
  return (
    <div className="page">
      <h1>{t('Рабочее место')}</h1>
      <Subnav items={tabs.map(([k, l]) => [`#/work/${k}`, t(l), sub === k])} />
      {sub === 'appeals' && <AppealsDesk />}
      {sub === 'police' && can('police') && <PoliceDesk />}
      {sub === 'tax' && can('tax') && <TaxDesk />}
      {sub === 'doctor' && can('doctor') && <DoctorDesk />}
      {sub === 'benefits' && can('benefits') && <BenefitsDesk />}
    </div>
  );
}

// ——— Обращения ———
function AppealsDesk() {
  const [status, setStatus] = useState('open');
  const { data, loading, error, reload } = useAsync(() => get(`/gov/work/appeals?status=${status}`), [status]);
  const [answer, setAnswer] = useState(null);
  return (
    <div className="stack">
      <div className="row">
        {[['open', t('Ждут ответа')], ['answered', t('Отвеченные')]].map(([v, l]) => (
          <button key={v} className={`btn sm ${status === v ? '' : 'secondary'}`} onClick={() => setStatus(v)}>{l}</button>
        ))}
      </div>
      {loading && !data ? <Spinner /> : error ? <ErrorBox error={error} /> : !data.appeals.length ? <Empty>{t('Обращений нет')}</Empty> : (
        <div className="stack">
          {data.appeals.map((a) => (
            <div key={a.id} className="card">
              <div className="card-head">
                <div>
                  <b>{a.subject}</b>
                  <div className="small muted">{a.author} · {t(ADDRESSEES[a.addressee] || a.addressee)} · {fmtDate(a.created_at)}</div>
                </div>
                <Badge kind={a.status === 'answered' ? 'ok' : 'warn'}>{t(a.status === 'answered' ? 'Отвечено' : 'Ждёт ответа')}</Badge>
              </div>
              <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{a.body}</p>
              {a.answer && <div className="form-ok" style={{ whiteSpace: 'pre-wrap' }}>{a.answer}</div>}
              {a.status !== 'answered' && <div className="row"><Button size="sm" onClick={() => setAnswer(a)}>{t('Ответить')}</Button></div>}
            </div>
          ))}
        </div>
      )}
      {answer && <AnswerModal appeal={answer} onClose={() => setAnswer(null)} onDone={() => { setAnswer(null); reload(); }} />}
    </div>
  );
}

function AnswerModal({ appeal, onClose, onDone }) {
  const [text, setText] = useState('');
  return (
    <Modal title={appeal.subject} onClose={onClose}>
      <Form submitLabel={t('Отправить ответ')} onSubmit={async () => { await post(`/gov/work/appeals/${appeal.id}/answer`, { answer: text }); onDone(); }}>
        <p className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{appeal.body}</p>
        <label className="field">
          <span>{t('Ответ')}</span>
          <textarea className="input" rows={5} required minLength={2} maxLength={4000} value={text} onChange={(e) => setText(e.target.value)} />
        </label>
        <p className="small muted">{t('Ответ увидит автор обращения и получит уведомление.')}</p>
      </Form>
    </Modal>
  );
}

// ——— Полиция ———
function PoliceDesk() {
  const [passport, setPassport] = useState('');
  const [look, setLook] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const [fine, setFine] = useState(null);
  const articles = useAsync(() => get('/gov/fine-articles'), []);
  const mine = useAsync(() => get('/gov/work/police/fines'), []);
  async function search(e) {
    e?.preventDefault();
    setErr(null); setLook(null); setBusy(true);
    try { setLook(await get(`/gov/work/police/citizen?passport=${encodeURIComponent(passport.trim().toUpperCase())}`)); } catch (e2) { setErr(e2); } finally { setBusy(false); }
  }
  return (
    <div className="stack">
      <form className="card row nowrap" onSubmit={search}>
        <input className="input" placeholder={t('Паспорт БФ: BLN-0000-0000')} value={passport} onChange={(e) => setPassport(e.target.value.toUpperCase())} />
        <button className="btn" disabled={busy || passport.length < 5}>{t('Проверить')}</button>
      </form>
      <ErrorBox error={err} />
      {look && (
        <div className="grid grid-2">
          <div className="card stack">
            <div className="card-head"><h2>{look.citizen.full_name}</h2><StatusBadge status={look.citizen.passport_status} /></div>
            <div className="small"><span className="mono">{look.citizen.passport_no}</span> · {t('возраст')}: {look.citizen.age}</div>
            <div className="small muted">{t('Прописка')}: {look.citizen.address}</div>
            <div className="small">{t('Документы')}: {look.documents.length ? look.documents.map((d) => `${d.type} ${d.number}`).join(', ') : t('нет')}</div>
            <div className="small">{t('Автомобили')}: {look.cars.length ? look.cars.map((c) => `${c.title} ${c.reg_number}`).join(', ') : t('нет')}</div>
            {look.sanctions.length > 0 && <div className="form-warn">{t('Меры')}: {look.sanctions.map((s) => t({ arrest: 'Арест счетов', travel_ban: 'Запрет выезда', ip_closed: 'ИП закрыто' }[s.kind])).join(', ')}</div>}
            <div className="row"><Button onClick={() => setFine({ passport: look.citizen.passport_no })}>{t('Выписать штраф')}</Button></div>
          </div>
          <div className="card">
            <h2>{t('Штрафы гражданина')}</h2>
            {!look.fines.length ? <p className="muted">{t('Штрафов нет')}</p> : (
              <div className="list">
                {look.fines.map((f) => (
                  <div key={f.id} className="list-item">
                    <div className="li-main"><div className="li-title">{t(f.article)}</div><div className="li-sub">{fmtDate(f.created_at)}{f.appeal_status ? ` · ${t('жалоба')}` : ''}</div></div>
                    <div className="right"><Money value={f.amount} /><StatusBadge status={f.status === 'issued' ? 'unpaid' : f.status === 'paid' ? 'paid' : 'cancelled'} /></div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
      <div className="card">
        <h2>{t('Мои выписанные штрафы')}</h2>
        {mine.loading && !mine.data ? <Spinner /> : !mine.data?.fines.length ? <p className="muted">{t('Пока пусто')}</p> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('Гражданин')}</th><th>{t('Статья')}</th><th>{t('Сумма')}</th><th>{t('Статус')}</th><th>{t('Выписан')}</th></tr></thead>
              <tbody>
                {mine.data.fines.map((f) => (
                  <tr key={f.id}>
                    <td>{f.full_name}<div className="tiny muted mono">{f.passport_no}</div></td>
                    <td className="small">{t(f.article)}</td>
                    <td className="num"><Money value={f.amount} /></td>
                    <td><StatusBadge status={f.status === 'issued' ? 'unpaid' : f.status === 'paid' ? 'paid' : 'cancelled'} /></td>
                    <td className="small">{fmtDate(f.created_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      {fine && <FineModal initial={fine} articles={articles.data?.articles || []} onClose={() => setFine(null)} onDone={() => { setFine(null); mine.reload(); if (passport) search(); }} />}
    </div>
  );
}

function FineModal({ initial, articles, onClose, onDone }) {
  const [f, setF] = useState({ passport_no: initial.passport, article_id: articles[0]?.id || '', text: '', amount: 500, note: '' });
  const free = !f.article_id;
  return (
    <Modal title={t('Выписать штраф')} onClose={onClose}>
      <Form submitLabel={t('Выписать')} onSubmit={async () => {
        await post('/gov/work/police/fines', free ? { passport_no: f.passport_no, text: f.text, amount: f.amount, note: f.note } : { passport_no: f.passport_no, article_id: f.article_id, note: f.note });
        onDone();
      }}>
        <Input label={t('Паспорт БФ')} required value={f.passport_no} onChange={(e) => setF({ ...f, passport_no: e.target.value.toUpperCase() })} />
        <Select label={t('Статья из списка')} value={f.article_id} onChange={(e) => setF({ ...f, article_id: Number(e.target.value) || '' })} options={[{ value: '', label: t('Свободный текст') }, ...articles.map((a) => ({ value: a.id, label: `${a.code} · ${a.title} · ${formatMoney(a.amount)}` }))]} />
        {free ? (
          <>
            <Input label={t('Нарушение')} required minLength={3} value={f.text} onChange={(e) => setF({ ...f, text: e.target.value })} />
            <MoneyInput label={t('Сумма штрафа')} value={f.amount} onChange={(v) => setF({ ...f, amount: v ?? 0 })} />
          </>
        ) : <p className="small muted">{t('Сумма берётся из статьи.')}</p>}
        <Input label={t('Комментарий')} value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} />
        <p className="small muted">{t('Гражданин получит уведомление и квитанцию. Штраф можно обжаловать.')}</p>
      </Form>
    </Modal>
  );
}

// ——— Налоговая ———
function TaxDesk() {
  const [status, setStatus] = useState('');
  const decls = useAsync(() => get(`/gov/work/tax/declarations${status ? `?status=${status}` : ''}`), [status]);
  const debtors = useAsync(() => get('/gov/work/tax/debtors'), []);
  const [assess, setAssess] = useState(false);
  return (
    <div className="stack">
      <div className="card">
        <div className="card-head"><h2>{t('Декларации')}</h2></div>
        <div className="row">
          {[['', t('Все')], ['draft', t('Черновики')], ['submitted', t('Поданные')], ['paid', t('Оплаченные')], ['auto', t('Автоматические')]].map(([v, l]) => (
            <button key={v} className={`btn sm ${status === v ? '' : 'secondary'}`} onClick={() => setStatus(v)}>{l}</button>
          ))}
        </div>
        {decls.loading && !decls.data ? <Spinner /> : !decls.data?.declarations.length ? <Empty>{t('Деклараций нет')}</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('ИП')}</th><th>{t('Год')}</th><th>{t('Доход по кассам')}</th><th>{t('Доход')}</th><th>{t('Налог')}</th><th>{t('Статус')}</th></tr></thead>
              <tbody>
                {decls.data.declarations.map((d) => (
                  <tr key={d.id}>
                    <td>{d.full_name}<div className="tiny muted mono">{d.passport_no}</div></td>
                    <td>{d.year}</td>
                    <td className="num"><Money value={d.income_auto} /></td>
                    <td className="num">{d.income === null ? '—' : <Money value={d.income} />}</td>
                    <td className="num">{d.tax === null ? '—' : <Money value={d.tax} />}<div className="tiny muted">{pct(d.rate_bp)}</div></td>
                    <td><Badge kind={d.status === 'paid' ? 'ok' : d.status === 'draft' ? 'warn' : ''}>{t(DECL_STATUS[d.status] || d.status)}</Badge></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      <div className="card">
        <div className="card-head">
          <h2>{t('Должники')}</h2>
          <Button size="sm" onClick={() => setAssess(true)}>{t('Доначислить налог')}</Button>
        </div>
        {debtors.loading && !debtors.data ? <Spinner /> : !debtors.data?.debtors.length ? <Empty>{t('Должников нет')}</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('Гражданин')}</th><th>{t('Квитанций')}</th><th>{t('Долг')}</th><th>{t('Пени')}</th><th>{t('Просрочка, мес.')}</th></tr></thead>
              <tbody>
                {debtors.data.debtors.map((d) => (
                  <tr key={d.id}>
                    <td>{d.full_name}<div className="tiny muted mono">{d.passport_no}</div></td>
                    <td>{d.n}</td>
                    <td className="num"><Money value={d.total} /></td>
                    <td className="num"><Money value={d.penalty} /></td>
                    <td>{d.months_late}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {debtors.data?.sanctions.length > 0 && (
          <>
            <h3>{t('Действующие меры')}</h3>
            <div className="list">
              {debtors.data.sanctions.map((s) => (
                <div key={s.id} className="list-item">
                  <div className="li-main"><div className="li-title">{s.full_name} <span className="tiny muted mono">{s.passport_no}</span></div><div className="li-sub">{t({ arrest: 'Арест счетов', travel_ban: 'Запрет выезда', ip_closed: 'ИП закрыто' }[s.kind])} · {t(s.reason)}</div></div>
                  <Badge kind="err">{fmtDate(s.created_at, false)}</Badge>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
      {assess && <AssessModal onClose={() => setAssess(false)} onDone={() => { setAssess(false); debtors.reload(); }} />}
    </div>
  );
}

function AssessModal({ onClose, onDone }) {
  const [f, setF] = useState({ passport_no: '', amount: 1000, purpose: '' });
  return (
    <Modal title={t('Доначисление налога')} onClose={onClose}>
      <Form submitLabel={t('Выставить квитанцию')} onSubmit={async () => { await post('/gov/work/tax/assess', f); onDone(); }}>
        <Input label={t('Паспорт БФ')} required value={f.passport_no} onChange={(e) => setF({ ...f, passport_no: e.target.value.toUpperCase() })} />
        <MoneyInput label={t('Сумма')} value={f.amount} onChange={(v) => setF({ ...f, amount: v ?? 0 })} />
        <Input label={t('Основание')} required minLength={3} value={f.purpose} onChange={(e) => setF({ ...f, purpose: e.target.value })} />
        <p className="small muted">{t('Квитанция придёт гражданину во ВлодУслуги и в банк.')}</p>
      </Form>
    </Modal>
  );
}

// ——— Врач ———
function DoctorDesk() {
  const { data, loading, error, reload } = useAsync(() => get('/gov/work/doctor'), []);
  const [form, setForm] = useState(null);
  const [conclude, setConclude] = useState(null);
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  return (
    <div className="stack">
      <div className="row"><Button onClick={() => setForm({ starts_at: '', duration_min: 15, count: 4, priority: false })}>{t('Добавить слоты')}</Button></div>
      {!data.slots.length ? <Empty>{t('Расписания нет')}</Empty> : (
        <div className="table-wrap card">
          <table className="table">
            <thead><tr><th>{t('Время')}</th><th>{t('Пациент')}</th><th>{t('Страховка')}</th><th>{t('Статус')}</th><th /></tr></thead>
            <tbody>
              {data.slots.map((s) => (
                <tr key={s.id}>
                  <td className="small">{fmtDate(s.starts_at, false)}<div className="tiny muted">{s.duration_min} {t('мин')}{s.priority ? ` · ${t('приоритет')}` : ''}</div></td>
                  <td className="small">{s.patient || '—'}{s.complaint ? <div className="tiny muted">{s.complaint}</div> : null}{s.conclusion ? <div className="tiny">{s.conclusion}</div> : null}</td>
                  <td>{s.insured ? <Badge kind="ok">{t('да')}</Badge> : '—'}</td>
                  <td><StatusBadge status={s.status === 'done' ? 'paid' : s.status === 'booked' ? 'pending' : s.status === 'cancelled' ? 'cancelled' : 'active'} /></td>
                  <td className="right">
                    {s.status === 'booked' && <ActionButton size="sm" action={async () => setConclude(s)}>{t('Заключение')}</ActionButton>}
                    {['free', 'booked'].includes(s.status) && <ActionButton kind="ghost" size="sm" confirm={t('Отменить приём?')} action={async () => { await post(`/gov/work/doctor/slots/${s.id}/cancel`); reload(); }}>{t('Отменить')}</ActionButton>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {form && (
        <Modal title={t('Расписание приёма')} onClose={() => setForm(null)}>
          <Form submitLabel={t('Создать')} onSubmit={async () => {
            await post('/gov/work/doctor/slots', { ...form, starts_at: new Date(form.starts_at).toISOString() });
            setForm(null); reload();
          }}>
            <Input label={t('Начало приёма')} type="datetime-local" required value={form.starts_at} onChange={(e) => setForm({ ...form, starts_at: e.target.value })} />
            <div className="grid grid-2">
              <Input label={t('Длительность, минут')} type="number" min={5} max={240} value={form.duration_min} onChange={(e) => setForm({ ...form, duration_min: Number(e.target.value) })} />
              <Input label={t('Сколько слотов')} type="number" min={1} max={48} value={form.count} onChange={(e) => setForm({ ...form, count: Number(e.target.value) })} />
            </div>
            <label className="check"><input type="checkbox" checked={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.checked })} /> {t('Только для пациентов со страховкой')}</label>
          </Form>
        </Modal>
      )}
      {conclude && <ConcludeModal slot={conclude} onClose={() => setConclude(null)} onDone={() => { setConclude(null); reload(); }} />}
    </div>
  );
}

function ConcludeModal({ slot, onClose, onDone }) {
  const [text, setText] = useState('');
  return (
    <Modal title={t('Заключение врача')} onClose={onClose}>
      <Form submitLabel={t('Сохранить заключение')} onSubmit={async () => { await post(`/gov/work/doctor/slots/${slot.id}/conclude`, { conclusion: text }); onDone(); }}>
        <p className="small muted">{slot.patient} · {fmtDate(slot.starts_at, false)}{slot.complaint ? ` · ${slot.complaint}` : ''}</p>
        <label className="field">
          <span>{t('Заключение')}</span>
          <textarea className="input" rows={5} required minLength={3} maxLength={2000} value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Игровое заключение')} />
        </label>
        <p className="small muted">{t('Пациент получит заключение в разделе «Врач».')}</p>
      </Form>
    </Modal>
  );
}

// ——— Пособия ———
function BenefitsDesk() {
  const [status, setStatus] = useState('pending');
  const { data, loading, error, reload } = useAsync(() => get(`/gov/work/benefits?status=${status}`), [status]);
  return (
    <div className="stack">
      <div className="row">
        {[['pending', t('Заявки')], ['active', t('Выплачиваются')], ['rejected', t('Отказы')], ['stopped', t('Прекращены')]].map(([v, l]) => (
          <button key={v} className={`btn sm ${status === v ? '' : 'secondary'}`} onClick={() => setStatus(v)}>{l}</button>
        ))}
      </div>
      {loading && !data ? <Spinner /> : error ? <ErrorBox error={error} /> : !data.benefits.length ? <Empty>{t('Заявок нет')}</Empty> : (
        <div className="table-wrap card">
          <table className="table">
            <thead><tr><th>{t('Гражданин')}</th><th>{t('Пособие')}</th><th>{t('Сумма в месяц')}</th><th>{t('Данные')}</th><th>{t('Подана')}</th><th /></tr></thead>
            <tbody>
              {data.benefits.map((b) => (
                <tr key={b.id}>
                  <td>{b.full_name}<div className="tiny muted mono">{b.passport_no}</div></td>
                  <td>{t(b.title)}</td>
                  <td className="num"><Money value={b.amount} /></td>
                  <td className="small">{t('возраст')}: {b.age} · {t('детей')}: {b.children}{b.months_left !== null ? ` · ${t('мес. осталось')}: ${b.months_left}` : ''}</td>
                  <td className="small">{fmtDate(b.created_at, false)}</td>
                  <td className="right">
                    {b.status === 'pending' && (
                      <>
                        <ActionButton size="sm" kind="ok-btn" action={async () => { await post(`/gov/work/benefits/${b.id}/decide`, { approve: true }); reload(); }}>{t('Назначить')}</ActionButton>{' '}
                        <ActionButton size="sm" kind="ghost" action={async () => { await post(`/gov/work/benefits/${b.id}/decide`, { approve: false, note: 'Нет права' }); reload(); }}>{t('Отказать')}</ActionButton>
                      </>
                    )}
                    {b.status === 'active' && <ActionButton size="sm" kind="ghost" confirm={t('Прекратить выплату?')} action={async () => { await post(`/gov/work/benefits/${b.id}/stop`, { note: 'Проверка' }); reload(); }}>{t('Прекратить')}</ActionButton>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="small muted">{t('Пособия платятся из госбюджета автоматически каждый игровой месяц.')}</p>
    </div>
  );
}
