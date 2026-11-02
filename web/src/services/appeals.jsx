// Этап 8: обращения к властям — жалобы и письма.
import { useState } from 'react';
import { get, post } from '../shared/api.js';
import { t, fmtDate } from '../shared/i18n.js';
import { Spinner, Empty, Modal, Form, useAsync, Button, Badge, ErrorBox, Select } from '../shared/ui.jsx';

export const ADDRESSEES = {
  admin: 'Администрация БФ',
  official: 'Чиновник',
  police: 'Полиция',
  tax: 'Налоговая инспекция',
  doctor: 'Врач / поликлиника',
};

export function AppealsPage() {
  const { data, loading, error, reload } = useAsync(() => get('/gov/appeals'), []);
  const [open, setOpen] = useState(false);
  if (loading && !data) return <div className="page medium"><Spinner /></div>;
  if (error) return <div className="page medium"><ErrorBox error={error} /></div>;
  return (
    <div className="page medium">
      <div className="page-head"><h1>{t('Обращения')}</h1><Button onClick={() => setOpen(true)}>{t('Написать обращение')}</Button></div>
      <p className="muted">{t('Обращение рассматривает выбранное ведомство и отвечает здесь же. Ответ придёт уведомлением.')}</p>
      {!data.appeals.length ? <Empty>{t('Обращений пока нет')}</Empty> : (
        <div className="stack">
          {data.appeals.map((a) => (
            <div key={a.id} className="card">
              <div className="card-head">
                <div>
                  <b>{a.subject}</b>
                  <div className="small muted">{t(ADDRESSEES[a.addressee] || a.addressee)} · {fmtDate(a.created_at)}</div>
                </div>
                <Badge kind={a.status === 'answered' ? 'ok' : a.status === 'closed' ? '' : 'warn'}>{t({ open: 'Ждёт ответа', answered: 'Есть ответ', closed: 'Закрыто' }[a.status] || a.status)}</Badge>
              </div>
              <p className="small" style={{ whiteSpace: 'pre-wrap' }}>{a.body}</p>
              {a.answer && (
                <div className="form-ok" style={{ whiteSpace: 'pre-wrap' }}><b>{t('Ответ')}:</b> {a.answer}<div className="tiny muted">{fmtDate(a.answered_at)}</div></div>
              )}
            </div>
          ))}
        </div>
      )}
      {open && <NewAppeal onClose={() => setOpen(false)} onDone={() => { setOpen(false); reload(); }} />}
    </div>
  );
}

function NewAppeal({ onClose, onDone }) {
  const [f, setF] = useState({ addressee: 'official', subject: '', body: '' });
  return (
    <Modal title={t('Новое обращение')} onClose={onClose}>
      <Form submitLabel={t('Отправить')} onSubmit={async () => { await post('/gov/appeals', f); onDone(); }}>
        <Select label={t('Кому')} value={f.addressee} onChange={(e) => setF({ ...f, addressee: e.target.value })} options={Object.entries(ADDRESSEES).map(([value, label]) => ({ value, label: t(label) }))} />
        <label className="field">
          <span>{t('Тема')}</span>
          <input className="input" required minLength={3} maxLength={160} value={f.subject} onChange={(e) => setF({ ...f, subject: e.target.value })} />
        </label>
        <label className="field">
          <span>{t('Текст (от 10 знаков)')}</span>
          <textarea className="input" rows={6} required minLength={10} maxLength={4000} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} />
        </label>
      </Form>
    </Modal>
  );
}
