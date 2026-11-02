// Этап 8: налоги и декларации ИП, пени, квитанции и меры за неуплату.
import { useState } from 'react';
import { get, post } from '../shared/api.js';
import { t, fmtDate, useLang } from '../shared/i18n.js';
import { Money, MoneyInput, Empty, Spinner, Modal, Form, useAsync, Button, Badge, ErrorBox } from '../shared/ui.jsx';
import { formatMoney, pct } from '@bln/shared/money.js';
import { gameDateLabel } from '@bln/shared/time.js';

export const DECL_STATUS = { draft: 'Черновик', submitted: 'Подана', paid: 'Оплачена', auto: 'Подана автоматически' };
export const SANCTION_TITLES = { arrest: 'Арест счетов в ВлодБанке', travel_ban: 'Запрет выезда из БФ', ip_closed: 'ИП закрыто' };

export function TaxesPage() {
  const lang = useLang();
  const { data, loading, error, reload } = useAsync(() => get('/gov/taxes'), []);
  const [decl, setDecl] = useState(null);
  if (loading && !data) return <div className="page medium"><Spinner /></div>;
  if (error) return <div className="page medium"><ErrorBox error={error} /></div>;
  const open = data.invoices.filter((i) => i.status === 'unpaid');
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Налоги и декларации')}</h1>
        <span className="muted small">{t('Игровая дата')}: {gameDateLabel(data.month, lang)}</span>
      </div>
      {data.overdue > 0 && (
        <div className="form-warn" style={{ marginBottom: 16 }}>
          {t('Просрочено налогов и штрафов на {sum}. Пени растут каждый игровой месяц, затем счёт арестуют.', { sum: formatMoney(data.overdue) })}
        </div>
      )}
      {data.sanctions.length > 0 && (
        <div className="card" style={{ borderColor: 'var(--err)', marginBottom: 16 }}>
          <h2>{t('Меры за неуплату')}</h2>
          <div className="list">
            {data.sanctions.map((s) => (
              <div key={s.id} className="list-item">
                <div className="li-main">
                  <div className="li-title">{t(SANCTION_TITLES[s.kind] || s.kind)}</div>
                  <div className="li-sub">{t(s.reason)}</div>
                </div>
                <Badge kind="err">{fmtDate(s.created_at)}</Badge>
              </div>
            ))}
          </div>
          <p className="small muted" style={{ marginBottom: 0 }}>{t('Меры снимаются автоматически после оплаты всех налогов и штрафов.')}</p>
        </div>
      )}

      <div className="card">
        <div className="card-head"><h2>{t('Декларации ИП')}</h2></div>
        {!data.declarations.length ? <Empty>{t('Деклараций нет. Они появляются раз в игровой год, если вы зарегистрированы как ИП.')}</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('Год')}</th><th>{t('Доход по кассам')}</th><th>{t('Заявленный доход')}</th><th>{t('Налог')}</th><th>{t('Срок')}</th><th>{t('Статус')}</th><th /></tr></thead>
              <tbody>
                {data.declarations.map((d) => (
                  <tr key={d.id}>
                    <td>{d.year}<div className="tiny muted">{fmtDate(d.period_to, false)}</div></td>
                    <td className="num"><Money value={d.income_auto} /></td>
                    <td className="num">{d.income === null ? '—' : <Money value={d.income} />}</td>
                    <td className="num">{d.tax === null ? '—' : <Money value={d.tax} />}<div className="tiny muted">{pct(d.rate_bp)}</div></td>
                    <td className="small">{t('месяц {n}', { n: d.due_month })}</td>
                    <td><Badge kind={d.status === 'paid' ? 'ok' : d.status === 'draft' ? 'warn' : ''}>{t(DECL_STATUS[d.status] || d.status)}</Badge></td>
                    <td className="right">
                      {d.status === 'draft' && <Button size="sm" onClick={() => setDecl(d)}>{t('Подать')}</Button>}
                      {d.status !== 'draft' && d.invoice && d.tax > 0 && !open.some((i) => i.number === d.invoice) && <span className="tiny muted">{t('Оплачена')}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <p className="small muted">{t('Доход нельзя указать меньше выручки по кассам: налоговый инспектор видит продажи магазинов.')}</p>
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <div className="card-head"><h2>{t('Квитанции и пени')}</h2><a className="small" href="#/invoices">{t('Все квитанции')}</a></div>
        {!open.length ? <Empty>{t('Неоплаченных квитанций нет')}</Empty> : (
          <div className="list">
            {open.map((i) => (
              <div key={i.number} className="list-item">
                <div className="li-main">
                  <div className="li-title">{t(i.purpose)}</div>
                  <div className="li-sub">
                    № <span className="mono">{i.number}</span>
                    {i.due_month !== null ? ` · ${t('срок — месяц {n}', { n: i.due_month })}` : ''}
                    {i.penalty > 0 ? ` · ${t('в том числе пени')} ${formatMoney(i.penalty)}` : ''}
                    {i.frozen ? ` · ${t('заморожена на время обжалования')}` : ''}
                  </div>
                </div>
                <div className="right"><b><Money value={i.amount} /></b></div>
                <a className="btn secondary sm" href={`#/invoices`}>{t('Оплатить')}</a>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="card" style={{ marginTop: 16 }}>
        <h2>{t('Ставки и сроки')}</h2>
        <div className="grid grid-3">
          <div className="stat"><span className="label">{t('НДФЛ с зарплаты')}</span><span className="value">{pct(data.rates.ndfl_bp)}</span></div>
          <div className="stat"><span className="label">{t('Налог ИП с дохода')}</span><span className="value">{pct(data.rates.ip_tax_bp)}</span></div>
          <div className="stat"><span className="label">{t('Налог на имущество')}</span><span className="value">{pct(data.rates.property_tax_bp)}</span></div>
          <div className="stat"><span className="label">{t('Пени за месяц просрочки')}</span><span className="value">{pct(data.rates.penalty_bp)}</span></div>
          <div className="stat"><span className="label">{t('Меры через, месяцев')}</span><span className="value">{data.rates.sanction_months}</span></div>
          <div className="stat"><span className="label">{t('НДС')}</span><span className="value">{pct(data.rates.vat_bp)}</span></div>
        </div>
      </div>

      {decl && <DeclModal decl={decl} onClose={() => setDecl(null)} onDone={() => { setDecl(null); reload(); }} />}
    </div>
  );
}

function DeclModal({ decl, onClose, onDone }) {
  const [income, setIncome] = useState(decl.income_auto);
  return (
    <Modal title={t('Декларация за {year}-й игровой год', { year: decl.year })} onClose={onClose}>
      <Form submitLabel={t('Подать декларацию')} onSubmit={async () => { await post(`/gov/taxes/declarations/${decl.id}/submit`, { income }); onDone(); }}>
        <p className="small muted">{t('Доход по данным касс: {sum}. Меньше указать нельзя.', { sum: formatMoney(decl.income_auto) })}</p>
        <MoneyInput label={t('Доход за год, влодинки')} value={income} onChange={(v) => setIncome(v ?? 0)} />
        <p className="small">{t('Налог по ставке {rate}: ', { rate: pct(decl.rate_bp) })}<b>{formatMoney(Math.round((income * decl.rate_bp) / 10000))}</b></p>
        <p className="small muted">{t('После подачи выставим квитанцию. Оплатить можно во ВлодБанке или наличными на кассе.')}</p>
      </Form>
    </Modal>
  );
}
