// Этап 8: пособия из госбюджета — детское, пенсия, по безработице.
import { useState } from 'react';
import { get, post } from '../shared/api.js';
import { t, fmtDate } from '../shared/i18n.js';
import { Spinner, Empty, useAsync, ActionButton, Badge, ErrorBox } from '../shared/ui.jsx';
import { formatMoney } from '@bln/shared/money.js';

const KIND_TITLES = { child: 'Детское пособие', pension: 'Пенсия', unemployment: 'Пособие по безработице' };
const STATUS_KINDS = { active: 'ok', pending: 'warn', rejected: 'err', stopped: '' };

export function BenefitsPage() {
  const { data, loading, error, reload } = useAsync(() => get('/gov/benefits'), []);
  const [busy, setBusy] = useState(null);
  if (loading && !data) return <div className="page medium"><Spinner /></div>;
  if (error) return <div className="page medium"><ErrorBox error={error} /></div>;
  const active = (kind) => data.benefits.find((b) => b.kind === kind && ['pending', 'active'].includes(b.status));
  const cards = [
    {
      kind: 'child',
      icon: '🧒',
      rule: t('{amount} за каждого ребёнка в паспорте. Детей: {n}.', { amount: formatMoney(data.amounts.child || 0), n: data.rules.children }),
      can: data.rules.children > 0,
    },
    {
      kind: 'pension',
      icon: '👵',
      rule: t('С {age} лет, {amount} в игровой месяц. Ваш возраст: {mine}.', { age: data.rules.pension_age, amount: formatMoney(data.amounts.pension || 0), mine: data.rules.age ?? '—' }),
      can: data.rules.age !== null && data.rules.age >= data.rules.pension_age,
    },
    {
      kind: 'unemployment',
      icon: '📄',
      rule: t('{amount} в месяц, не больше {n} месяцев. Нужно не работать и не иметь ИП.', { amount: formatMoney(data.amounts.unemployment || 0), n: data.rules.unemployment_months }),
      can: true,
    },
  ];
  return (
    <div className="page medium">
      <h1>{t('Пособия')}</h1>
      <p className="muted">{t('Пособия платит госбюджет БФ на счёт во ВлодБанке. Заявку рассматривает чиновник.')}</p>
      <div className="grid grid-3">
        {cards.map((c) => {
          const have = active(c.kind);
          return (
            <div key={c.kind} className="card stack">
              <div className="row" style={{ justifyContent: 'space-between' }}><b>{c.icon} {t(KIND_TITLES[c.kind])}</b>{have && <Badge kind={STATUS_KINDS[have.status]}>{t(have.status === 'pending' ? 'На рассмотрении' : 'Назначено')}</Badge>}</div>
              <p className="small muted">{c.rule}</p>
              {have ? <p className="small">{have.months_left !== null ? t('Осталось месяцев: {n}', { n: have.months_left }) : t('Выплачивается ежемесячно')}</p>
                : <ActionButton kind="secondary" busy={busy === c.kind} action={async () => { setBusy(c.kind); try { await post('/gov/benefits', { kind: c.kind }); reload(); } finally { setBusy(null); } }}>{t('Подать заявку')}</ActionButton>}
              {!c.can && !have && <p className="small muted">{t('Пока нет права на это пособие.')}</p>}
            </div>
          );
        })}
      </div>
      <div className="card" style={{ marginTop: 16 }}>
        <h2>{t('Мои заявки')}</h2>
        {!data.benefits.length ? <Empty>{t('Заявок пока нет')}</Empty> : (
          <div className="list">
            {data.benefits.map((b) => (
              <div key={b.id} className="list-item">
                <div className="li-main">
                  <div className="li-title">{t(b.title)}</div>
                  <div className="li-sub">{fmtDate(b.created_at)}{b.note ? ` · ${b.note}` : ''}</div>
                </div>
                <Badge kind={STATUS_KINDS[b.status]}>{t({ active: 'Назначено', pending: 'На рассмотрении', rejected: 'Отказ', stopped: 'Прекращено' }[b.status] || b.status)}</Badge>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
