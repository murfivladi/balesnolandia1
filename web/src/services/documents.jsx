// Документы ВлодУслуг: ИНН, ИП, права, загранпаспорт и визы, брак и рождение.
// Каждый документ — заявление с госпошлиной; часть выдаётся через чиновника.
import { useState } from 'react';
import { get, post, appUrl } from '../shared/api.js';
import { t } from '../shared/i18n.js';
import {
  Spinner, Modal, Form, useAsync, ActionButton, Badge, QR, Input, Select, Money, StatusBadge,
} from '../shared/ui.jsx';
import { DOC_DISCLAIMER } from '../shared/passport.jsx';
import { formatMoney } from '@bln/shared/money.js';
import { mmYY } from '@bln/shared/time.js';
import { useGovMe, DOC_TITLES, DRIVER_CATEGORIES } from './lib.js';

export function DocumentsPage() {
  const { data, loading, reload } = useGovMe();
  const [form, setForm] = useState(null); // { type }
  const [show, setShow] = useState(null);
  const settings = useAsync(() => get('/public/settings'), []);
  const countries = useAsync(() => get('/gov/countries'), []);
  if (loading && !data) return <div className="page"><Spinner /></div>;
  const docs = data.documents;
  const s = settings.data || {};
  const active = (type) => docs.filter((d) => d.type === type && d.status === 'active');
  const pending = (type) => data.applications.find((a) => a.type === type && ['pending', 'awaiting_payment'].includes(a.status));
  const inn = active('inn')[0];
  const ip = active('ip')[0];
  const driver = active('driver')[0];
  const fp = active('foreign_passport')[0];
  const visas = active('visa');
  const marriage = active('marriage')[0];
  const birthplace = active('birth');
  const apply = (type, extra = {}) => setForm({ type, ...extra });
  const fees = {
    inn: s.fee_inn, ip: s.fee_ip, driver: s.fee_driver, foreign_passport: s.fee_foreign_passport, marriage: s.fee_marriage, birth: s.fee_birth,
  };
  return (
    <div className="page">
      <h1>{t('Документы')}</h1>
      {!data.passport && <div className="form-warn" style={{ marginBottom: 16 }}>{t('Сначала оформите паспорт БФ')} — <a href="#/passport/edit">{t('оформить')}</a></div>}
      <div className="grid grid-2">
        <DocCard title={t('ИНН')} doc={inn} pending={pending('inn')} fee={fees.inn} onApply={() => apply('inn')} disabled={!data.passport} hint={t('Идентификационный номер налогоплательщика. Нужен для ИП.')} />
        <DocCard
          title={t('Индивидуальный предприниматель')}
          doc={ip}
          pending={pending('ip')}
          fee={fees.ip}
          onApply={() => apply('ip')}
          disabled={!data.passport || !inn}
          hint={t('Регистрация ИП даёт право открыть бизнес-счёт и магазин.')}
          extra={ip && (
            <div className="stack">
              <p className="small">{ip.data.trade_name}{ip.data.activity ? ` — ${ip.data.activity}` : ''}</p>
              <div className="row">
                <a className="btn secondary sm" href={appUrl('bank', '/open')}>{t('Бизнес-счёт')}</a>
                <a className="btn secondary sm" href={appUrl('pos')}>{t('Касса')}</a>
              </div>
            </div>
          )}
        />
        <DocCard title={t('Водительские права')} doc={driver} pending={pending('driver')} fee={fees.driver} onApply={() => apply('driver')} disabled={!data.passport} hint={t('Выдаются с 16 лет. Категории A, B, C, AB, BC.')} extra={driver && <p className="small">{t('Категории')}: <b>{driver.data.categories}</b></p>} />
        <DocCard title={t('Загранпаспорт')} doc={fp} pending={pending('foreign_passport')} fee={fees.fee_foreign_passport ?? fees.foreign_passport} onApply={() => apply('foreign_passport')} disabled={!data.passport} hint={t('Нужен для виз. Не выдаётся при запрете выезда за неуплату.')} extra={fp && <p className="small">{t('Действует до')}: {mmYY(fp.expires_month)}</p>} />
        <div className="card stack">
          <div className="card-head"><h2>{t('Виза')}</h2>{visas.length > 0 && <Badge kind="ok">{visas.length}</Badge>}</div>
          <p className="small muted">{t('Виза открывается в страну из списка. Понадобится действующий загранпаспорт и оплата сбора.')}</p>
          {visas.map((v) => (
            <div key={v.id} className="row" style={{ justifyContent: 'space-between' }}>
              <div><b>{v.data.country}</b><div className="small muted mono">{v.number}</div></div>
              <div className="right small">{t('до')} {mmYY(v.expires_month)}<button className="btn ghost sm" onClick={() => setShow(v)}>QR</button></div>
            </div>
          ))}
          {pending('visa') ? (
            <div className="row"><StatusBadge status={pending('visa').status} />{pending('visa').status === 'awaiting_payment' && <a className="btn secondary sm" href="#/invoices">{t('Оплатить сбор')}</a>}</div>
          ) : (
            <button className="btn" disabled={!fp} onClick={() => apply('visa')}>{t('Оформить визу')}</button>
          )}
          {!fp && <p className="small muted">{t('Сначала получите загранпаспорт.')}</p>}
        </div>
        <DocCard title={t('Свидетельство о браке')} doc={marriage} pending={pending('marriage')} fee={fees.marriage} onApply={() => apply('marriage')} disabled={!data.passport} hint={t('Нужен паспорт супруга(и). Выдаёт чиновник — заявление проходит рассмотрение.')} />
        <div className="card stack">
          <div className="card-head"><h2>{t('Свидетельства о рождении')}</h2>{birthplace.length > 0 && <Badge kind="ok">{birthplace.length}</Badge>}</div>
          {birthplace.map((b) => (
            <div key={b.id} className="row" style={{ justifyContent: 'space-between' }}>
              <div><b>{b.data.child_name}</b><div className="small muted mono">{b.number} · {b.data.child_birth_date}</div></div>
              <button className="btn ghost sm" onClick={() => setShow(b)}>QR</button>
            </div>
          ))}
          {pending('birth') ? <StatusBadge status={pending('birth').status} /> : (
            <button className="btn secondary" disabled={!data.passport} onClick={() => apply('birth')}>{t('Зарегистрировать рождение')}</button>
          )}
          <p className="small muted">{t('Дети попадают в паспорт БФ и дают право на детское пособие.')}</p>
        </div>
      </div>

      {docs.length > 0 && (
        <div className="card" style={{ marginTop: 16 }}>
          <h2>{t('Все документы')}</h2>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('Документ')}</th><th>{t('Номер')}</th><th>{t('Выдан')}</th><th>{t('Статус')}</th><th /></tr></thead>
              <tbody>
                {docs.map((d) => (
                  <tr key={d.id}>
                    <td>{t(DOC_TITLES[d.type] || d.type)}</td>
                    <td className="mono">{d.number}</td>
                    <td>{mmYY(d.issued_month)}</td>
                    <td><StatusBadge status={d.status} /></td>
                    <td className="right"><button className="btn ghost sm" onClick={() => setShow(d)}>QR</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {form && (
        <Modal title={t(DOC_TITLES[form.type])} onClose={() => setForm(null)}>
          <DocForm form={form} settings={s} countries={countries.data?.countries || []} onDone={() => { setForm(null); reload(); }} />
        </Modal>
      )}
      {show && (
        <Modal title={t(DOC_TITLES[show.type] || show.type)} onClose={() => setShow(null)}>
          <div className="stack center" style={{ alignItems: 'center' }}>
            <b className="mono">{show.number}</b>
            <QR value={appUrl('services', `/verify/document/${show.verify_code}`)} size={200} />
            <p className="small muted">{t(DOC_DISCLAIMER)}</p>
          </div>
        </Modal>
      )}
    </div>
  );
}

function DocCard({ title, doc, pending, fee, onApply, disabled, hint, extra }) {
  return (
    <div className="card stack">
      <div className="card-head"><h2>{title}</h2>{doc && <StatusBadge status="active" />}</div>
      {doc ? (
        <>
          <p>{t('Номер')}: <b className="mono">{doc.number}</b></p>
          {extra}
        </>
      ) : pending ? (
        <div className="row">
          <StatusBadge status={pending.status} />
          {pending.status === 'awaiting_payment' && <a className="btn secondary sm" href="#/invoices">{t('Оплатить госпошлину')}</a>}
        </div>
      ) : (
        <>
          <p className="muted">{hint}</p>
          {fee > 0 && <p className="small muted">{t('Госпошлина')}: <Money value={fee} /></p>}
          <ActionButton action={async () => onApply()} disabled={disabled}>{t('Подать заявление')}</ActionButton>
        </>
      )}
    </div>
  );
}

function DocForm({ form, settings, countries, onDone }) {
  const [f, setF] = useState({ categories: 'B', country_id: countries.find((c) => c.visa_required)?.id || '', spouse: '', child_name: '', child_birth_date: '', trade_name: '', activity: '' });
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const fee = { inn: settings.fee_inn, ip: settings.fee_ip, driver: settings.fee_driver, foreign_passport: settings.fee_foreign_passport, marriage: settings.fee_marriage, birth: settings.fee_birth }[form.type] || 0;
  if (form.type === 'ip') {
    return (
      <Form submitLabel={t('Подать заявление')} onSubmit={async () => { await post('/gov/documents/ip', { trade_name: f.trade_name, activity: f.activity }); onDone(); }}>
        <Input label={t('Название (вывеска)')} required value={f.trade_name} onChange={set('trade_name')} />
        <Input label={t('Вид деятельности')} placeholder={t('Например: продажа продуктов')} value={f.activity} onChange={set('activity')} />
        {fee > 0 && <p className="small muted">{t('Госпошлина')}: {formatMoney(fee)}</p>}
      </Form>
    );
  }
  if (form.type === 'driver') {
    return (
      <Form submitLabel={t('Подать заявление')} onSubmit={async () => { await post('/gov/documents/driver', { categories: f.categories }); onDone(); }}>
        <Select label={t('Категории')} value={f.categories} onChange={set('categories')} options={DRIVER_CATEGORIES.map((c) => ({ value: c, label: c }))} />
        {fee > 0 && <p className="small muted">{t('Госпошлина')}: {formatMoney(fee)}</p>}
      </Form>
    );
  }
  if (form.type === 'visa') {
    const list = countries.filter((c) => c.visa_required);
    return (
      <Form submitLabel={t('Подать заявление')} onSubmit={async () => { await post('/gov/documents/visa', { country_id: f.country_id }); onDone(); }}>
        <Select label={t('Страна')} value={f.country_id} onChange={(e) => setF((x) => ({ ...x, country_id: Number(e.target.value) }))} options={list.map((c) => ({ value: c.id, label: `${c.name} · ${formatMoney(c.visa_fee)} · ${c.visa_months} ${t('мес.')}` }))} />
        <p className="small muted">{t('Безвизовые страны доступны по загранпаспорту, виза для них не нужна.')}</p>
      </Form>
    );
  }
  if (form.type === 'marriage') {
    return (
      <Form submitLabel={t('Подать заявление')} onSubmit={async () => { await post('/gov/documents/marriage', { spouse_passport: f.spouse }); onDone(); }}>
        <Input label={t('Паспорт супруга(и)')} placeholder="BLN-0000-0000" required value={f.spouse} onChange={(e) => setF((x) => ({ ...x, spouse: e.target.value.toUpperCase() }))} />
        <p className="small muted">{t('Второй человек должен быть не женат / не замужем. Заявление рассматривает чиновник.')}</p>
        {fee > 0 && <p className="small muted">{t('Госпошлина')}: {formatMoney(fee)}</p>}
      </Form>
    );
  }
  if (form.type === 'birth') {
    return (
      <Form submitLabel={t('Подать заявление')} onSubmit={async () => { await post('/gov/documents/birth', { child_name: f.child_name, child_birth_date: f.child_birth_date }); onDone(); }}>
        <Input label={t('Имя ребёнка')} required value={f.child_name} onChange={set('child_name')} />
        <Input label={t('Дата рождения')} type="date" required value={f.child_birth_date} onChange={set('child_birth_date')} />
        <p className="small muted">{t('Свидетельство о рождении выдаёт чиновник. Ребёнок появится в паспорте БФ и даст право на детское пособие.')}</p>
      </Form>
    );
  }
  return (
    <Form submitLabel={t('Подать заявление')} onSubmit={async () => { await post(`/gov/documents/${form.type}`); onDone(); }}>
      <p className="small muted">{t('Заявление уйдёт на рассмотрение. Госпошлина: {fee}.', { fee: formatMoney(fee) })}</p>
    </Form>
  );
}
