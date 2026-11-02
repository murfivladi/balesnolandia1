// Этап 8: врач — расписание, запись, страховка и заключения.
import { useState } from 'react';
import { get, post } from '../shared/api.js';
import { t, fmtDate } from '../shared/i18n.js';
import { Spinner, Empty, Modal, Form, useAsync, ActionButton, Badge, ErrorBox } from '../shared/ui.jsx';
import { formatMoney } from '@bln/shared/money.js';
import { mmYY } from '@bln/shared/time.js';

const VISIT_STATUS = { free: 'Свободно', booked: 'Записан', done: 'Приём проведён', cancelled: 'Отменён' };

export function DoctorPage() {
  const { data, loading, error, reload } = useAsync(() => get('/gov/doctor'), []);
  const [book, setBook] = useState(null);
  if (loading && !data) return <div className="page medium"><Spinner /></div>;
  if (error) return <div className="page medium"><ErrorBox error={error} /></div>;
  return (
    <div className="page medium">
      <h1>{t('Врач')}</h1>
      <div className="card stack">
        <div className="card-head">
          <h2>{t('Медицинская страховка')}</h2>
          <Badge kind={data.insured ? 'ok' : 'warn'}>{data.insured ? t('Действует') : t('Нет')}</Badge>
        </div>
        {data.insurance && <p className="small">{t('Полис действует до игрового месяца')} {mmYY(data.insurance.to_month)}.</p>}
        {data.insurance_invoice ? (
          <div className="stack">
            <div className="form-warn">{t('Квитанция на страховку выставлена: {sum}.', { sum: formatMoney(data.insurance_price) })}</div>
            <a className="btn" href="#/invoices">{t('Оплатить квитанцию')}</a>
          </div>
        ) : (
          <>
            <p className="small muted">{t('Полис на {n} игровых месяцев стоит {sum} и даёт доступ к приоритетным слотам.', { n: data.insurance_months, sum: formatMoney(data.insurance_price) })}</p>
            <ActionButton kind="secondary" action={async () => { await post('/gov/insurance'); reload(); }}>{data.insured ? t('Продлить страховку') : t('Оформить страховку')}</ActionButton>
          </>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>{t('Свободное время')}</h2>
        {!data.free.length ? <Empty>{t('Расписания пока нет — врач ещё не открыл слоты.')}</Empty> : (
          <div className="list">
            {data.free.map((s) => (
              <div key={s.id} className="list-item">
                <div className="li-main">
                  <div className="li-title">{fmtDate(s.starts_at, false)} · {t('{d} мин', { d: s.duration_min })}</div>
                  <div className="li-sub">{s.doctor}{s.priority ? ` · ${t('только со страховкой')}` : ''}</div>
                </div>
                {s.priority && !data.insured ? <Badge kind="warn">{t('Нужна страховка')}</Badge> : <ActionButton size="sm" action={async () => setBook(s)}>{t('Записаться')}</ActionButton>}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>{t('Мои приёмы')}</h2>
        {!data.visits.length ? <Empty>{t('Записей нет')}</Empty> : (
          <div className="list">
            {data.visits.map((s) => (
              <div key={s.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                <div className="li-main">
                  <div className="li-title">{fmtDate(s.starts_at, false)} · {s.doctor}</div>
                  <div className="li-sub">{VISIT_STATUS[s.status] ? t(VISIT_STATUS[s.status]) : s.status}{s.insured ? ` · ${t('по страховке')}` : ''}</div>
                  {s.complaint && <div className="small">{t('Жалобы')}: {s.complaint}</div>}
                  {s.conclusion && <div className="small"><b>{t('Заключение')}:</b> {s.conclusion}</div>}
                </div>
                {s.status === 'booked' && <ActionButton kind="ghost" size="sm" confirm={t('Отменить запись?')} action={async () => { await post(`/gov/doctor/slots/${s.id}/cancel`); reload(); }}>{t('Отменить')}</ActionButton>}
              </div>
            ))}
          </div>
        )}
      </div>
      <p className="small muted" style={{ marginTop: 12 }}>{t('Заключение врача — игровое. Приём не является медицинской помощью.')}</p>
      {book && <BookModal slot={book} onClose={() => setBook(null)} onDone={() => { setBook(null); reload(); }} />}
    </div>
  );
}

function BookModal({ slot, onClose, onDone }) {
  const [complaint, setComplaint] = useState('');
  return (
    <Modal title={t('Запись на приём')} onClose={onClose}>
      <Form submitLabel={t('Записаться')} onSubmit={async () => { await post(`/gov/doctor/slots/${slot.id}/book`, { complaint }); onDone(); }}>
        <p className="small muted">{fmtDate(slot.starts_at, false)} · {slot.doctor} · {t('{d} мин', { d: slot.duration_min })}</p>
        <label className="field">
          <span>{t('Что беспокоит')}</span>
          <textarea className="input" rows={4} maxLength={500} value={complaint} onChange={(e) => setComplaint(e.target.value)} placeholder={t('Необязательно')} />
        </label>
        <p className="small muted">{t('Можно держать не больше трёх записей одновременно.')}</p>
      </Form>
    </Modal>
  );
}
