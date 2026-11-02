// Этап 8: выборы — выдвижение, тайное голосование, итоги.
import { useState } from 'react';
import { get, post } from '../shared/api.js';
import { t, fmtDate } from '../shared/i18n.js';
import { Spinner, Empty, Modal, Form, useAsync, ActionButton, Badge, ErrorBox, Button } from '../shared/ui.jsx';

const STATUS = { nomination: 'Выдвижение кандидатов', voting: 'Идёт голосование', finished: 'Выборы завершены', cancelled: 'Отменены' };
const STATUS_KIND = { nomination: 'warn', voting: 'brand', finished: 'ok', cancelled: '' };

export function ElectionsPage() {
  const { data, loading, error, reload } = useAsync(() => get('/gov/elections'), []);
  const [nominate, setNominate] = useState(null);
  const [vote, setVote] = useState(null);
  if (loading && !data) return <div className="page medium"><Spinner /></div>;
  if (error) return <div className="page medium"><ErrorBox error={error} /></div>;
  return (
    <div className="page medium">
      <h1>{t('Выборы')}</h1>
      <p className="muted">{t('Голосовать и выдвигаться можно с {age} лет. Один паспорт — один голос. Голос тайный: связь избирателя с кандидатом не хранится.', { age: data.vote_age })}</p>
      {!data.elections.length ? <Empty>{t('Выборов пока нет')}</Empty> : (
        <div className="stack">
          {data.elections.map((e) => {
            const winner = e.status === 'finished' && e.candidates.length ? [...e.candidates].sort((a, b) => (b.votes || 0) - (a.votes || 0))[0] : null;
            return (
              <div key={e.id} className="card">
                <div className="card-head">
                  <div>
                    <h2 style={{ margin: 0 }}>{e.title}</h2>
                    <div className="small muted">{t('Проголосовало')}: {e.turnout} · {STATUS[e.status] ? t(STATUS[e.status]) : e.status}{e.finished_at ? ` · ${fmtDate(e.finished_at, false)}` : ''}</div>
                  </div>
                  <Badge kind={STATUS_KIND[e.status]}>{t(STATUS[e.status] || e.status)}</Badge>
                </div>
                {e.description && <p className="small">{e.description}</p>}
                {e.status === 'voting' && e.voted && <div className="form-ok" style={{ marginBottom: 10 }}>{t('Ваш голос учтён.')}</div>}
                {e.my_candidate && e.status === 'nomination' && (
                  <div className="row" style={{ marginBottom: 10 }}>
                    <Badge kind="brand">{t('Вы кандидат')}</Badge>
                    <ActionButton kind="ghost" size="sm" confirm={t('Сняться с выборов?')} action={async () => { await post(`/gov/elections/${e.id}/withdraw`); reload(); }}>{t('Сняться')}</ActionButton>
                  </div>
                )}
                <div className="list">
                  {!e.candidates.length ? <Empty>{t('Кандидатов нет')}</Empty> : e.candidates.map((c) => (
                    <div key={c.id} className="list-item" style={{ alignItems: 'flex-start' }}>
                      <div className="li-main">
                        <div className="li-title">{c.full_name} {c.mine && <Badge kind="brand">{t('это вы')}</Badge>} {winner && winner.id === c.id && <Badge kind="ok">{t('победитель')}</Badge>}</div>
                        {c.program && <div className="li-sub" style={{ whiteSpace: 'pre-wrap' }}>{c.program}</div>}
                      </div>
                      <div className="right">
                        {c.votes !== undefined && <b>{c.votes} {t('голосов')}</b>}
                        {e.status === 'voting' && !e.voted && !c.mine && <Button size="sm" onClick={() => setVote({ election: e, candidate: c })}>{t('Голосовать')}</Button>}
                      </div>
                    </div>
                  ))}
                </div>
                {e.status === 'nomination' && !e.my_candidate && (
                  <div className="row" style={{ marginTop: 10 }}>
                    <Button kind="secondary" onClick={() => setNominate(e)}>{t('Выдвинуться')}</Button>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
      {nominate && <NominateModal election={nominate} onClose={() => setNominate(null)} onDone={() => { setNominate(null); reload(); }} />}
      {vote && (
        <Modal title={t('Голосование')} onClose={() => setVote(null)}>
          <div className="stack">
            <p>{t('Отдать голос за «{name}»? Голос нельзя изменить или отозвать.', { name: vote.candidate.full_name })}</p>
            <ActionButton action={async () => { await post(`/gov/elections/${vote.election.id}/vote`, { candidate_id: vote.candidate.id }); setVote(null); reload(); }}>{t('Подтвердить голос')}</ActionButton>
          </div>
        </Modal>
      )}
    </div>
  );
}

function NominateModal({ election, onClose, onDone }) {
  const [program, setProgram] = useState('');
  return (
    <Modal title={t('Выдвижение: {title}', { title: election.title })} onClose={onClose}>
      <Form submitLabel={t('Стать кандидатом')} onSubmit={async () => { await post(`/gov/elections/${election.id}/nominate`, { program }); onDone(); }}>
        <label className="field">
          <span>{t('Программа (от 10 знаков)')}</span>
          <textarea className="input" rows={6} minLength={10} maxLength={2000} required value={program} onChange={(e) => setProgram(e.target.value)} placeholder={t('Что вы сделаете, если победите')} />
        </label>
        <p className="small muted">{t('Сняться можно до начала голосования.')}</p>
      </Form>
    </Modal>
  );
}
