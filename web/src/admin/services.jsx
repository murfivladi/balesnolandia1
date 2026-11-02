// Этап 8, админка «Услуги»: статьи штрафов и жалобы, госбюджет, санкции, реестр
// имущества, страны и визы, выборы, новости БФ.
import { useState } from 'react';
import { get, post, patch } from '../shared/api.js';
import { t, fmtDate } from '../shared/i18n.js';
import {
  Spinner, Empty, Modal, Form, useAsync, ActionButton, Badge, ErrorBox, Button, Input, Select, MoneyInput, Money, PhotoInput, Tabs,
} from '../shared/ui.jsx';
import { BarChart, HBars } from '../shared/charts.jsx';
import { formatMoney } from '@bln/shared/money.js';
import { NEWS_KINDS } from '../services/news.jsx';

const APPEAL_STATUS = { pending: 'Жалоба на рассмотрении', accepted: 'Жалоба удовлетворена', rejected: 'Жалоба отклонена' };
const FINE_STATUS = { issued: 'Выписан', paid: 'Оплачен', cancelled: 'Отменён' };
const SANCTION_TITLES = { arrest: 'Арест счетов', travel_ban: 'Запрет выезда', ip_closed: 'ИП закрыто' };
const ELECTION_STATUS = { nomination: 'Выдвижение', voting: 'Голосование', finished: 'Завершены', cancelled: 'Отменены' };
const PROPERTY_KIND = { car: 'Автомобиль', realty: 'Недвижимость' };

// ——— Штрафы ———
export function FineArticles() {
  const { data, loading, reload } = useAsync(() => get('/admin/fine-articles'), []);
  const [edit, setEdit] = useState(null);
  if (loading && !data) return <Spinner />;
  return (
    <div className="stack">
      <div className="row"><Button onClick={() => setEdit({ code: '', title: '', amount: 1000 })}>{t('Добавить статью')}</Button></div>
      <div className="card table-wrap">
        <table className="table">
          <thead><tr><th>{t('Статья')}</th><th>{t('Название')}</th><th>{t('Штраф')}</th><th>{t('Активна')}</th><th /></tr></thead>
          <tbody>
            {data.articles.map((a) => (
              <tr key={a.id}>
                <td className="mono">{a.code}</td>
                <td>{t(a.title)}</td>
                <td className="num"><Money value={a.amount} /></td>
                <td>{a.active ? <Badge kind="ok">{t('да')}</Badge> : <Badge>{t('нет')}</Badge>}</td>
                <td className="right">
                  <button className="btn ghost sm" onClick={() => setEdit(a)}>{t('Изменить')}</button>{' '}
                  <ActionButton kind="ghost" size="sm" action={async () => { await patch(`/admin/fine-articles/${a.id}`, { active: !a.active }); reload(); }}>{a.active ? t('Выключить') : t('Включить')}</ActionButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <ArticleModal article={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

function ArticleModal({ article, onClose, onDone }) {
  const [f, setF] = useState({ code: article.code, title: article.title, amount: article.amount });
  return (
    <Modal title={article.id ? t('Статья штрафа') : t('Новая статья')} onClose={onClose}>
      <Form submitLabel={t('Сохранить')} onSubmit={async () => {
        if (article.id) await patch(`/admin/fine-articles/${article.id}`, f);
        else await post('/admin/fine-articles', f);
        onDone();
      }}>
        <Input label={t('Номер статьи')} required maxLength={16} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} />
        <Input label={t('Название')} required maxLength={160} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <MoneyInput label={t('Сумма штрафа')} value={f.amount} onChange={(v) => setF({ ...f, amount: v ?? 0 })} />
      </Form>
    </Modal>
  );
}

export function FineAppeals() {
  const [all, setAll] = useState(false);
  const { data, loading, error, reload } = useAsync(() => get(`/admin/fines${all ? '' : '?appeal=pending'}`), [all]);
  const [note, setNote] = useState(null);
  return (
    <div className="stack">
      <Tabs value={all ? 'all' : 'pending'} onChange={(v) => setAll(v === 'all')} tabs={[{ value: 'pending', label: t('Жалобы на рассмотрении') }, { value: 'all', label: t('Все штрафы') }]} />
      {loading && !data ? <Spinner /> : error ? <ErrorBox error={error} /> : !data.fines.length ? <Empty>{t('Штрафов нет')}</Empty> : (
        <div className="stack">
          {data.fines.map((f) => (
            <div key={f.id} className="card">
              <div className="card-head">
                <div>
                  <b>{t(f.article)}</b>
                  <div className="small muted">{f.full_name} · <span className="mono">{f.passport_no}</span> · {fmtDate(f.created_at)}{f.officer ? ` · ${t('полицейский')}: ${f.officer}` : ''}</div>
                </div>
                <div className="right"><Money value={f.amount} /><Badge kind={f.status === 'paid' ? 'ok' : f.status === 'cancelled' ? '' : 'warn'}>{t(FINE_STATUS[f.status] || f.status)}</Badge></div>
              </div>
              {f.note && <p className="small muted">{f.note}</p>}
              {f.appeal_text && <div className="form-warn" style={{ whiteSpace: 'pre-wrap' }}>{t('Жалоба')}: {f.appeal_text}</div>}
              {f.appeal_status ? (
                <div className="row" style={{ marginTop: 10 }}>
                  <Badge kind={f.appeal_status === 'accepted' ? 'ok' : f.appeal_status === 'rejected' ? 'err' : 'warn'}>{t(APPEAL_STATUS[f.appeal_status])}</Badge>
                  {f.appeal_note && <span className="small muted">{f.appeal_note}</span>}
                  {f.appeal_status === 'pending' && (
                    <>
                      <ActionButton size="sm" kind="ok-btn" action={async () => { await post(`/admin/fines/${f.id}/appeal`, { accept: true }); reload(); }}>{t('Удовлетворить')}</ActionButton>
                      <Button size="sm" kind="ghost" onClick={() => setNote({ fine: f, accept: false })}>{t('Отклонить')}</Button>
                    </>
                  )}
                </div>
              ) : <p className="small muted">{t('Жалобы нет')}</p>}
            </div>
          ))}
        </div>
      )}
      {note && <NoteModal data={note} onClose={() => setNote(null)} onDone={() => { setNote(null); reload(); }} />}
    </div>
  );
}

function NoteModal({ data, onClose, onDone }) {
  const [text, setText] = useState('');
  return (
    <Modal title={t('Решение по жалобе')} onClose={onClose}>
      <Form submitLabel={t('Отправить')} onSubmit={async () => { await post(`/admin/fines/${data.fine.id}/appeal`, { accept: data.accept, note: text }); onDone(); }}>
        <p className="small muted">{data.fine.full_name} · {t(data.fine.article)}</p>
        <Input label={t('Комментарий')} value={text} onChange={(e) => setText(e.target.value)} hint={t('Его увидит гражданин')} />
      </Form>
    </Modal>
  );
}

// ——— Госбюджет ———
export function GovBudget() {
  const [days, setDays] = useState(30);
  const { data, loading, error, reload } = useAsync(() => get(`/admin/budget?days=${days}`), [days]);
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  return (
    <div className="stack">
      <div className="row">
        {[7, 30, 90, 365].map((d) => <button key={d} className={`btn sm ${days === d ? '' : 'secondary'}`} onClick={() => setDays(d)}>{t('{n} дней', { n: d })}</button>)}
        <span className="spacer" />
        <ActionButton kind="ghost" action={async () => reload()}>{t('Обновить')}</ActionButton>
      </div>
      <div className="grid grid-3">
        <div className="card stat"><span className="label">{t('Остаток госбюджета')}</span><span className="value"><Money value={data.balance} /></span></div>
        <div className="card stat"><span className="label">{t('Доходы')}</span><span className="value amount-pos"><Money value={data.income} /></span></div>
        <div className="card stat"><span className="label">{t('Расходы')}</span><span className="value amount-neg"><Money value={data.expense} /></span></div>
      </div>
      <div className="card">
        <h2>{t('Динамика по дням')}</h2>
        <BarChart data={data.daily.map((d) => ({ label: String(d.day).slice(5), value: d.income, hint: `${t('Доход')} ${formatMoney(d.income)} · ${t('расход')} ${formatMoney(d.expense)}` }))} empty={t('Данных нет')} />
      </div>
      <div className="card">
        <h2>{t('Доходы и расходы по видам')}</h2>
        {!data.by_kind.length ? <Empty>{t('Операций нет')}</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('Вид')}</th><th>{t('Доход')}</th><th>{t('Расход')}</th><th>{t('Операций')}</th></tr></thead>
              <tbody>
                {data.by_kind.map((k) => (
                  <tr key={k.kind}>
                    <td>{t(k.title)}</td>
                    <td className="num amount-pos">{k.income ? <Money value={k.income} /> : '—'}</td>
                    <td className="num amount-neg">{k.expense ? <Money value={k.expense} /> : '—'}</td>
                    <td>{k.count}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
      <div className="grid grid-2">
        <div className="card">
          <h2>{t('Оплаченные квитанции')}</h2>
          {!data.invoices.length ? <p className="muted">{t('Нет')}</p> : <HBars data={data.invoices.map((i) => ({ label: t({ tax: 'Налоги', fine: 'Штрафы', fee: 'Пошлины' }[i.kind] || i.kind), value: i.total, hint: `${i.count}` }))} />}
        </div>
        <div className="card">
          <h2>{t('Ждут оплаты')}</h2>
          <div className="stat"><span className="label">{t('Квитанций')}</span><span className="value">{data.receivable.count}</span></div>
          <div className="stat"><span className="label">{t('Сумма')}</span><span className="value"><Money value={data.receivable.total} /></span></div>
        </div>
      </div>
    </div>
  );
}

// ——— Санкции ———
export function Sanctions() {
  const [all, setAll] = useState(false);
  const { data, loading, error, reload } = useAsync(() => get(`/admin/sanctions${all ? '?all=1' : ''}`), [all]);
  const [form, setForm] = useState(null);
  return (
    <div className="stack">
      <div className="row">
        <button className={`btn sm ${!all ? '' : 'secondary'}`} onClick={() => setAll(false)}>{t('Действующие')}</button>
        <button className={`btn sm ${all ? '' : 'secondary'}`} onClick={() => setAll(true)}>{t('Все')}</button>
        <span className="spacer" />
        <Button onClick={() => setForm({ kind: 'arrest', passport_no: '', reason: '' })}>{t('Назначить меру')}</Button>
      </div>
      {loading && !data ? <Spinner /> : error ? <ErrorBox error={error} /> : !data.sanctions.length ? <Empty>{t('Санкций нет')}</Empty> : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>{t('Гражданин')}</th><th>{t('Мера')}</th><th>{t('Основание')}</th><th>{t('Назначена')}</th><th>{t('Действует')}</th><th /></tr></thead>
            <tbody>
              {data.sanctions.map((s) => (
                <tr key={s.id}>
                  <td>{s.full_name}<div className="tiny muted mono">{s.passport_no}</div></td>
                  <td>{t(SANCTION_TITLES[s.kind] || s.kind)}</td>
                  <td className="small">{t(s.reason)}</td>
                  <td className="small">{fmtDate(s.created_at, false)}</td>
                  <td>{s.active ? <Badge kind="err">{t('да')}</Badge> : <Badge>{fmtDate(s.lifted_at, false)}</Badge>}</td>
                  <td className="right">{s.active && <ActionButton size="sm" kind="ghost" confirm={t('Снять меру?')} action={async () => { await post(`/admin/sanctions/${s.id}/lift`); reload(); }}>{t('Снять')}</ActionButton>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {form && <SanctionModal form={form} onClose={() => setForm(null)} onDone={() => { setForm(null); reload(); }} />}
    </div>
  );
}

function SanctionModal({ form, onClose, onDone }) {
  const [f, setF] = useState(form);
  return (
    <Modal title={t('Мера за неуплату')} onClose={onClose}>
      <Form submitLabel={t('Назначить')} onSubmit={async () => { await post('/admin/sanctions', f); onDone(); }}>
        <Select label={t('Мера')} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} options={[{ value: 'arrest', label: t('Арест счетов') }, { value: 'travel_ban', label: t('Запрет выезда') }]} />
        <Input label={t('Паспорт БФ')} required value={f.passport_no} onChange={(e) => setF({ ...f, passport_no: e.target.value.toUpperCase() })} />
        <Input label={t('Основание')} required minLength={3} value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} />
        <p className="small muted">{t('Арест блокирует счета до погашения долга; запрет выезда не даёт получить загранпаспорт и визу.')}</p>
      </Form>
    </Modal>
  );
}

// ——— Имущество ———
export function AdminProperties({ tick }) {
  const [q, setQ] = useState('');
  const { data, loading, error, reload } = useAsync(() => get(`/admin/properties?q=${encodeURIComponent(q)}`), [q, tick]);
  const [edit, setEdit] = useState(null);
  return (
    <div className="stack">
      <div className="row">
        <input className="input" placeholder={t('Поиск: название, рег. номер, владелец')} value={q} onChange={(e) => setQ(e.target.value)} />
        <Button onClick={() => setEdit({ kind: 'realty', title: '', value: 100000, list_price: null, address: '', details: '', owner_passport: '', photo: null })}>{t('Добавить имущество')}</Button>
      </div>
      {loading && !data ? <Spinner /> : error ? <ErrorBox error={error} /> : !data.properties.length ? <Empty>{t('Имущества нет')}</Empty> : (
        <div className="card table-wrap">
          <table className="table">
            <thead><tr><th>{t('Название')}</th><th>{t('Тип')}</th><th>{t('Рег. номер')}</th><th>{t('Владелец')}</th><th>{t('Оценка')}</th><th>{t('В продаже')}</th><th /></tr></thead>
            <tbody>
              {data.properties.map((p) => (
                <tr key={p.id}>
                  <td>{p.title}{p.address ? <div className="tiny muted">{p.address}</div> : null}</td>
                  <td>{t(PROPERTY_KIND[p.kind] || p.kind)}</td>
                  <td className="mono small">{p.reg_number}</td>
                  <td className="small">{p.owner_name}</td>
                  <td className="num"><Money value={p.value} /></td>
                  <td className="num">{p.list_price === null ? '—' : <Money value={p.list_price} />}{p.lien_loan_id ? <div className="tiny muted">{t('залог')}</div> : null}</td>
                  <td className="right"><button className="btn ghost sm" onClick={() => setEdit({ ...p, owner_passport: '' })}>{t('Изменить')}</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {edit && <PropertyModal property={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

function PropertyModal({ property, onClose, onDone }) {
  const [f, setF] = useState({
    kind: property.kind, title: property.title, value: property.value, list_price: property.list_price,
    address: property.address || '', details: property.details || '', reg_number: property.reg_number || '',
    owner_passport: property.owner_passport || '', photo: property.photo || null,
  });
  return (
    <Modal title={property.id ? t('Имущество') : t('Новое имущество')} onClose={onClose} wide>
      <Form submitLabel={t('Сохранить')} onSubmit={async () => {
        const body = { ...f, owner_passport: f.owner_passport.trim() || undefined, list_price: f.list_price || null, photo: f.photo || null };
        if (property.id) await patch(`/admin/properties/${property.id}`, body);
        else await post('/admin/properties', body);
        onDone();
      }}>
        <div className="grid grid-2">
          <Select label={t('Тип')} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} options={[{ value: 'realty', label: t('Недвижимость') }, { value: 'car', label: t('Автомобиль') }]} />
          <Input label={t('Название')} required maxLength={120} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
          <MoneyInput label={t('Оценка')} value={f.value} onChange={(v) => setF({ ...f, value: v ?? 0 })} />
          <MoneyInput label={t('Цена на рынке (0 — не продаётся)')} value={f.list_price} onChange={(v) => setF({ ...f, list_price: v })} />
          <Input label={t('Адрес')} value={f.address} onChange={(e) => setF({ ...f, address: e.target.value })} />
          <Input label={t('Рег. номер (пусто — сгенерируем)')} value={f.reg_number} onChange={(e) => setF({ ...f, reg_number: e.target.value.toUpperCase() })} />
        </div>
        <Input label={t('Паспорт владельца (пусто — государство БФ)')} value={f.owner_passport} onChange={(e) => setF({ ...f, owner_passport: e.target.value.toUpperCase() })} hint={t('Владелец получит уведомление и налог на имущество.')} />
        <Input label={t('Описание')} value={f.details} onChange={(e) => setF({ ...f, details: e.target.value })} />
        <PhotoInput label={t('Фото')} value={f.photo} onChange={(v) => setF({ ...f, photo: v })} maxSize={400} />
      </Form>
    </Modal>
  );
}

// ——— Страны и визы ———
export function CountriesAdmin() {
  const { data, loading, error, reload } = useAsync(() => get('/admin/countries'), []);
  const [edit, setEdit] = useState(null);
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  return (
    <div className="stack">
      <div className="row"><Button onClick={() => setEdit({ name: '', code: '', visa_required: true, visa_fee: 2000, visa_months: 6 })}>{t('Добавить страну')}</Button></div>
      <div className="card table-wrap">
        <table className="table">
          <thead><tr><th>{t('Страна')}</th><th>{t('Код')}</th><th>{t('Виза')}</th><th>{t('Сбор')}</th><th>{t('Срок')}</th><th>{t('Активна')}</th><th /></tr></thead>
          <tbody>
            {data.countries.map((c) => (
              <tr key={c.id}>
                <td>{c.name}</td>
                <td className="mono">{c.code}</td>
                <td>{c.visa_required ? <Badge kind="warn">{t('нужна')}</Badge> : <Badge kind="ok">{t('безвизовая')}</Badge>}</td>
                <td className="num">{c.visa_fee ? <Money value={c.visa_fee} /> : '—'}</td>
                <td>{c.visa_months} {t('мес.')}</td>
                <td>{c.active ? <Badge kind="ok">{t('да')}</Badge> : <Badge>{t('нет')}</Badge>}</td>
                <td className="right">
                  <button className="btn ghost sm" onClick={() => setEdit(c)}>{t('Изменить')}</button>{' '}
                  <ActionButton kind="ghost" size="sm" action={async () => { await patch(`/admin/countries/${c.id}`, { active: !c.active }); reload(); }}>{c.active ? t('Выключить') : t('Включить')}</ActionButton>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {edit && <CountryModal country={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

function CountryModal({ country, onClose, onDone }) {
  const [f, setF] = useState({ ...country });
  return (
    <Modal title={country.id ? t('Страна') : t('Новая страна')} onClose={onClose}>
      <Form submitLabel={t('Сохранить')} onSubmit={async () => {
        const body = { name: f.name, visa_required: !!f.visa_required, visa_fee: f.visa_fee, visa_months: f.visa_months };
        if (country.id) await patch(`/admin/countries/${country.id}`, body);
        else await post('/admin/countries', { ...body, code: f.code });
        onDone();
      }}>
        <Input label={t('Название')} required maxLength={80} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} />
        {!country.id && <Input label={t('Код (3 буквы)')} required maxLength={3} value={f.code} onChange={(e) => setF({ ...f, code: e.target.value.toUpperCase() })} />}
        <label className="check"><input type="checkbox" checked={!!f.visa_required} onChange={(e) => setF({ ...f, visa_required: e.target.checked })} /> {t('Нужна виза')}</label>
        <div className="grid grid-2">
          <MoneyInput label={t('Сбор за визу')} value={f.visa_fee} onChange={(v) => setF({ ...f, visa_fee: v ?? 0 })} />
          <Input label={t('Срок визы, месяцев')} type="number" min={1} max={600} value={f.visa_months} onChange={(e) => setF({ ...f, visa_months: Number(e.target.value) })} />
        </div>
      </Form>
    </Modal>
  );
}

// ——— Выборы ———
export function ElectionsAdmin() {
  const { data, loading, error, reload } = useAsync(() => get('/admin/elections'), []);
  const [create, setCreate] = useState(null);
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  return (
    <div className="stack">
      <div className="row"><Button onClick={() => setCreate({ title: '', description: '' })}>{t('Новые выборы')}</Button></div>
      {!data.elections.length ? <Empty>{t('Выборов нет')}</Empty> : data.elections.map((e) => (
        <div key={e.id} className="card">
          <div className="card-head">
            <div>
              <b>{e.title}</b>
              <div className="small muted">{t(ELECTION_STATUS[e.status] || e.status)} · {t('голосов')}: {e.turnout}{e.finished_at ? ` · ${fmtDate(e.finished_at, false)}` : ''}</div>
            </div>
            <div className="row">
              <Badge kind={e.status === 'finished' ? 'ok' : e.status === 'voting' ? 'brand' : 'warn'}>{t(ELECTION_STATUS[e.status] || e.status)}</Badge>
              {['nomination', 'voting'].includes(e.status) && (
                <>
                  {e.status === 'nomination' && <ActionButton size="sm" action={async () => { await post(`/admin/elections/${e.id}/status`, { status: 'voting' }); reload(); }}>{t('Начать голосование')}</ActionButton>}
                  <ActionButton size="sm" kind="secondary" action={async () => { await post(`/admin/elections/${e.id}/status`, { status: 'finished' }); reload(); }}>{t('Завершить')}</ActionButton>
                  <ActionButton size="sm" kind="ghost" confirm={t('Отменить выборы?')} action={async () => { await post(`/admin/elections/${e.id}/status`, { status: 'cancelled' }); reload(); }}>{t('Отменить')}</ActionButton>
                </>
              )}
            </div>
          </div>
          {e.description && <p className="small">{e.description}</p>}
          <div className="list">
            {!e.candidates.length ? <p className="muted small">{t('Кандидатов нет')}</p> : e.candidates.map((c) => (
              <div key={c.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                <div className="li-main">
                  <div className="li-title">{c.full_name} <Badge kind={c.status === 'approved' ? 'ok' : c.status === 'rejected' ? 'err' : ''}>{t({ approved: 'допущен', rejected: 'снят', withdrawn: 'самоотвод' }[c.status] || c.status)}</Badge></div>
                  {c.program && <div className="li-sub" style={{ whiteSpace: 'pre-wrap' }}>{c.program}</div>}
                </div>
                <div className="right">
                  <b>{c.votes ?? 0} {t('голосов')}</b>
                  {e.status === 'nomination' && c.status === 'approved' && (
                    <div className="row"><ActionButton size="sm" kind="ghost" action={async () => { await post(`/admin/candidates/${c.id}/status`, { status: 'rejected' }); reload(); }}>{t('Не допустить')}</ActionButton></div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}
      {create && (
        <Modal title={t('Новые выборы')} onClose={() => setCreate(null)}>
          <Form submitLabel={t('Создать')} onSubmit={async () => { await post('/admin/elections', create); setCreate(null); reload(); }}>
            <Input label={t('Название')} required maxLength={160} value={create.title} onChange={(e) => setCreate({ ...create, title: e.target.value })} />
            <Input label={t('Описание')} value={create.description} onChange={(e) => setCreate({ ...create, description: e.target.value })} />
            <p className="small muted">{t('Сначала этап выдвижения. Кандидатов можно допускать и снимать до начала голосования.')}</p>
          </Form>
        </Modal>
      )}
    </div>
  );
}

// ——— Новости ———
export function NewsAdmin() {
  const { data, loading, error, reload } = useAsync(() => get('/gov/news?limit=100'), []);
  const [edit, setEdit] = useState(null);
  if (loading && !data) return <Spinner />;
  if (error) return <ErrorBox error={error} />;
  return (
    <div className="stack">
      <div className="row"><Button onClick={() => setEdit({ kind: 'news', title: '', body: '', pinned: false })}>{t('Написать новость')}</Button></div>
      {!data.news.length ? <Empty>{t('Новостей нет')}</Empty> : data.news.map((n) => (
        <div key={n.id} className="card">
          <div className="card-head">
            <div>
              <b>{n.title}</b>
              <div className="small muted">{t(NEWS_KINDS[n.kind] || n.kind)} · {fmtDate(n.created_at)}</div>
            </div>
            <div className="row">
              {n.pinned && <Badge kind="brand">{t('закреплено')}</Badge>}
              <button className="btn ghost sm" onClick={() => setEdit(n)}>{t('Изменить')}</button>
              <ActionButton kind="ghost" size="sm" confirm={t('Удалить новость?')} action={async () => { await patch(`/admin/news/${n.id}`, { delete: true }); reload(); }}>{t('Удалить')}</ActionButton>
            </div>
          </div>
          <p className="small" style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{n.body}</p>
        </div>
      ))}
      {edit && <NewsModal news={edit} onClose={() => setEdit(null)} onDone={() => { setEdit(null); reload(); }} />}
    </div>
  );
}

function NewsModal({ news, onClose, onDone }) {
  const [f, setF] = useState({ kind: news.kind, title: news.title, body: news.body, pinned: !!news.pinned });
  return (
    <Modal title={news.id ? t('Новость') : t('Новая новость')} onClose={onClose}>
      <Form submitLabel={t('Сохранить')} onSubmit={async () => {
        if (news.id) await patch(`/admin/news/${news.id}`, { title: f.title, body: f.body, pinned: f.pinned });
        else await post('/admin/news', f);
        onDone();
      }}>
        <Select label={t('Тип')} value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} options={Object.entries(NEWS_KINDS).map(([value, label]) => ({ value, label: t(label) }))} />
        <Input label={t('Заголовок')} required maxLength={200} value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} />
        <label className="field">
          <span>{t('Текст')}</span>
          <textarea className="input" rows={8} required value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        </label>
        <label className="check"><input type="checkbox" checked={f.pinned} onChange={(e) => setF({ ...f, pinned: e.target.checked })} /> {t('Закрепить наверху')}</label>
      </Form>
    </Modal>
  );
}
