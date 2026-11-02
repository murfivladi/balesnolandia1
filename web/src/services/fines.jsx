// Этап 8: штрафы гражданина и обжалование.
import { useState } from 'react';
import { get, post } from '../shared/api.js';
import { t, fmtDate } from '../shared/i18n.js';
import { Money, Spinner, Empty, Modal, Form, useAsync, Button, Badge, ErrorBox } from '../shared/ui.jsx';
import { formatMoney } from '@bln/shared/money.js';

const FINE_STATUS = { issued: 'Выписан', paid: 'Оплачен', cancelled: 'Отменён' };
const APPEAL_STATUS = { pending: 'Жалоба на рассмотрении', accepted: 'Жалоба удовлетворена', rejected: 'Жалоба отклонена' };

export function FinesPage() {
  const { data, loading, error, reload } = useAsync(() => get('/gov/fines'), []);
  const [appeal, setAppeal] = useState(null);
  if (loading && !data) return <div className="page medium"><Spinner /></div>;
  if (error) return <div className="page medium"><ErrorBox error={error} /></div>;
  const open = data.fines.filter((f) => f.status === 'issued');
  const total = open.reduce((s, f) => s + f.amount, 0);
  return (
    <div className="page medium">
      <div className="page-head">
        <h1>{t('Штрафы')}</h1>
        {open.length > 0 && <div className="stat right"><span className="label">{t('К оплате')}</span><span className="value"><Money value={total} /></span></div>}
      </div>
      <p className="muted">{t('Штраф выписывает полицейский. Обжаловать можно в течение месяца — жалобу рассматривает админ. Неуплата ведёт к пеням и аресту счетов.')}</p>
      {!data.fines.length ? <Empty>{t('Штрафов нет')}</Empty> : (
        <div className="stack">
          {data.fines.map((f) => (
            <div key={f.id} className="card">
              <div className="row" style={{ justifyContent: 'space-between', alignItems: 'flex-start' }}>
                <div>
                  <b>{t(f.article)}</b>
                  {f.article_id && <span className="small muted"> · {t('статья')}</span>}
                  <div className="small muted">{fmtDate(f.created_at)}{f.officer ? ` · ${t('полицейский')}: ${f.officer}` : ''}</div>
                  {f.note && <div className="small">{f.note}</div>}
                </div>
                <div className="right">
                  <div style={{ fontSize: '1.2rem', fontWeight: 700 }}><Money value={f.amount} /></div>
                  <Badge kind={f.status === 'paid' ? 'ok' : f.status === 'cancelled' ? '' : 'warn'}>{t(FINE_STATUS[f.status] || f.status)}</Badge>
                </div>
              </div>
              {f.invoice && <div className="small muted" style={{ marginTop: 6 }}>{t('Квитанция')}: <span className="mono">{f.invoice}</span>{f.status === 'issued' ? ' — ' : ''}{f.status === 'issued' && <a href="#/invoices">{t('оплатить')}</a>}</div>}
              {f.appeal_status && (
                <div className={`form-${f.appeal_status === 'accepted' ? 'ok' : 'warn'}`} style={{ marginTop: 10 }}>
                  {t(APPEAL_STATUS[f.appeal_status])}{f.appeal_note ? ` — ${f.appeal_note}` : ''}
                </div>
              )}
              <div className="row" style={{ marginTop: 10 }}>
                {f.status === 'issued' && !f.appeal_status && <Button kind="secondary" size="sm" onClick={() => setAppeal(f)}>{t('Обжаловать')}</Button>}
                {f.status === 'issued' && <a className="btn secondary sm" href="#/invoices">{t('Оплатить')}</a>}
              </div>
            </div>
          ))}
        </div>
      )}
      {appeal && <AppealModal fine={appeal} onClose={() => setAppeal(null)} onDone={() => { setAppeal(null); reload(); }} />}
    </div>
  );
}

function AppealModal({ fine, onClose, onDone }) {
  const [text, setText] = useState('');
  return (
    <Modal title={t('Обжалование штрафа')} onClose={onClose}>
      <Form submitLabel={t('Подать жалобу')} onSubmit={async () => { await post(`/gov/fines/${fine.id}/appeal`, { text }); onDone(); }}>
        <p className="small muted">{t('Штраф на {sum} по статье «{article}».', { sum: formatMoney(fine.amount), article: t(fine.article) })}</p>
        <label className="field">
          <span>{t('Почему штраф неверный')}</span>
          <textarea className="input" rows={5} minLength={10} maxLength={1000} required value={text} onChange={(e) => setText(e.target.value)} placeholder={t('Опишите обстоятельства — не меньше 10 знаков')} />
        </label>
        <p className="small muted">{t('Пока жалоба рассматривается, квитанция заморожена и пени не растут.')}</p>
      </Form>
    </Modal>
  );
}
