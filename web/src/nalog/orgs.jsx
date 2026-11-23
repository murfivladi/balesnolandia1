// Налоговая служба БФ (nalog.gov.bln): регистрация организаций, счёт, сотрудники, лицензии.
import { useState } from 'react';
import { get, post, del } from '../shared/api.js';
import { useLang, fmtDate } from '../shared/i18n.js';
import {
  Spinner, useAsync, Input, Select, Form, Money, MoneyInput, Badge, ActionButton, ErrorBox, useToast,
} from '../shared/ui.jsx';
import { gameDateLabel } from '@bln/shared/time.js';

// ——— Организации ———

export function OrgsPage() {
  const { data, error, reload } = useAsync(() => get('/gov/orgs'), []);
  const [f, setF] = useState({ kind: 'llc', name: '' });
  const toast = useToast();
  if (!data) return error ? <div className="page"><ErrorBox error={error} /></div> : <Spinner />;
  return (
    <div className="page medium">
      <h1>Организации</h1>
      <p className="muted">ООО и АО регистрируются по заявлению с госпошлиной. У организации свой счёт во ВлодБанке, сотрудники и лицензии: например, лицензия регистратора доменов БалНета.</p>
      {data.orgs.length > 0 && (
        <div className="list" style={{ marginBottom: 16 }}>
          {data.orgs.map((o) => (
            <a key={o.id} href={`#/orgs/${o.id}`} className="list-item" style={{ color: 'inherit' }}>
              <div className="li-main"><div className="li-title">{o.kind_title} «{o.name}»</div><div className="li-sub">ИНН <span className="mono">{o.inn}</span></div></div>
              <Badge>{o.role === 'director' ? 'директор' : 'сотрудник'}</Badge>
            </a>
          ))}
        </div>
      )}
      {data.pending.length > 0 && <div className="form-warn" style={{ marginBottom: 16 }}>Заявлений на рассмотрении или ждут оплаты: {data.pending.length} — <a href="../services/#/invoices">квитанции во ВлодУслугах</a></div>}
      <div className="card">
        <Form submitLabel="Подать заявление" onSubmit={async () => { await post('/gov/orgs/apply', f); setF({ kind: 'llc', name: '' }); toast('Заявление подано — оплатите госпошлину', 'ok'); reload(); }}>
          <h2>Зарегистрировать организацию</h2>
          <Select label="Вид" value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })} options={[{ value: 'llc', label: 'ООО — общество с ограниченной ответственностью' }, { value: 'jsc', label: 'АО — акционерное общество' }]} />
          <Input label="Название" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="ДоменКо" />
          <p className="small muted">Нужны паспорт БФ и ИНН. Госучреждения создаёт администрация.</p>
        </Form>
      </div>
    </div>
  );
}

export function OrgPage({ id }) {
  const lang = useLang();
  const { data, error, reload } = useAsync(() => get(`/gov/orgs/${id}`), [id]);
  const [tr, setTr] = useState({ to: '', amount: 0, memo: '' });
  const [inv, setInv] = useState('');
  const [passport, setPassport] = useState('');
  const toast = useToast();
  if (!data) return error ? <div className="page"><ErrorBox error={error} /></div> : <Spinner />;
  const o = data.org;
  const director = o.role === 'director';
  return (
    <div className="page">
      <div className="page-head">
        <h1>{o.kind_title} «{o.name}»</h1>
        <span className="muted small">ИНН <span className="mono">{o.inn}</span> · вы {director ? 'директор' : 'сотрудник'}</span>
      </div>
      <div className="grid grid-2">
        <div className="stack">
          <div className="card">
            <h2>Счёт организации</h2>
            <div className="row" style={{ justifyContent: 'space-between' }}>
              <span className="mono">{o.account?.number}</span>
              <b style={{ fontSize: '1.3rem' }}><Money value={o.account?.balance || 0} /></b>
            </div>
            <p className="small muted">На этот счёт приходят деньги от продаж. Пополнить его можно переводом во ВлодБанке по номеру счёта.</p>
            {director && (
              <>
                <Form submitLabel="Перевести" onSubmit={async () => { await post(`/gov/orgs/${id}/transfer`, tr); setTr({ to: '', amount: 0, memo: '' }); toast('Перевод выполнен', 'ok'); reload(); }}>
                  <h3>Перевод со счёта</h3>
                  <Input label="Номер счёта получателя" value={tr.to} onChange={(e) => setTr({ ...tr, to: e.target.value })} placeholder="BF40…" />
                  <MoneyInput label="Сумма" value={tr.amount} onChange={(v) => setTr({ ...tr, amount: v })} />
                  <Input label="Назначение" value={tr.memo} onChange={(e) => setTr({ ...tr, memo: e.target.value })} placeholder="Зарплата за месяц" />
                </Form>
                <Form submitLabel="Оплатить со счёта организации" onSubmit={async () => { await post(`/gov/orgs/${id}/pay-invoice`, { number: inv }); setInv(''); toast('Квитанция оплачена', 'ok'); reload(); }}>
                  <h3>Оплата квитанции</h3>
                  <Input label="Номер квитанции" value={inv} onChange={(e) => setInv(e.target.value)} placeholder="KV…" />
                </Form>
              </>
            )}
          </div>
          <div className="card">
            <h2>Сотрудники</h2>
            <div className="list">
              {data.members.map((m) => (
                <div key={m.gov_user_id} className="list-item">
                  <div className="li-main"><div className="li-title">{m.full_name || '—'}</div><div className="li-sub mono">{m.passport_no}</div></div>
                  <Badge>{m.role === 'director' ? 'директор' : 'сотрудник'}</Badge>
                  {director && m.role !== 'director' && <ActionButton size="sm" kind="ghost" confirm="Уволить сотрудника?" action={async () => { await del(`/gov/orgs/${id}/members/${m.gov_user_id}`); reload(); }}>✕</ActionButton>}
                </div>
              ))}
            </div>
            {director && (
              <Form submitLabel="Добавить сотрудника" onSubmit={async () => { await post(`/gov/orgs/${id}/members`, { passport }); setPassport(''); reload(); }}>
                <Input label="Номер паспорта" value={passport} onChange={(e) => setPassport(e.target.value)} placeholder="BLN-0000-0000" />
              </Form>
            )}
          </div>
        </div>
        <div className="stack">
          <div className="card">
            <h2>Лицензии</h2>
            {!data.licenses.length && <p className="muted">Лицензий нет.</p>}
            <div className="list">
              {data.licenses.map((l) => (
                <div key={l.number} className="list-item">
                  <div className="li-main">
                    <div className="li-title">{({ registrar: 'Регистратор доменов', registry: 'Администратор доменной зоны', hosting: 'Хостинг-провайдер' })[l.kind] || l.kind}</div>
                    <div className="li-sub"><span className="mono">{l.number}</span>{l.expires_month != null ? ` · до ${gameDateLabel(l.expires_month, lang)}` : ' · бессрочно'}</div>
                  </div>
                  <Badge kind={l.status === 'active' ? 'ok' : 'err'}>{l.status === 'active' ? 'действует' : l.status === 'expired' ? 'истекла' : 'отозвана'}</Badge>
                </div>
              ))}
            </div>
            {director && o.kind !== 'gov' && (
              <div className="row" style={{ marginTop: 10 }}>
                {!data.licenses.some((l) => l.kind === 'registrar' && l.status === 'active') && (
                  <ActionButton kind="secondary" okMessage="Заявление подано: оплатите пошлину во ВлодУслугах, затем его рассмотрит чиновник" action={async () => { await post(`/gov/orgs/${id}/licenses`, { kind: 'registrar' }); reload(); }}>Лицензия регистратора доменов</ActionButton>
                )}
                {!data.licenses.some((l) => l.kind === 'hosting' && l.status === 'active') && (
                  <ActionButton kind="secondary" okMessage="Заявление подано: оплатите пошлину во ВлодУслугах, затем его рассмотрит чиновник" action={async () => { await post(`/gov/orgs/${id}/licenses`, { kind: 'hosting' }); reload(); }}>Лицензия хостинг-провайдера</ActionButton>
                )}
              </div>
            )}
          </div>
          {(data.is_registrar || data.registry.length > 0) && (
            <div className="card">
              <h2>Регистратор доменов</h2>
              <p className="small muted">Цены на домены, оптовые цены зон и проданные домены — в кабинете партнёра на сайте регистратора.</p>
              <a className="btn secondary" href="../reg/#/partners">Открыть кабинет на reg.bln</a>
            </div>
          )}
          <div className="card">
            <h2>Хостинг</h2>
            <p className="small muted">Лицензия хостинг-провайдера, аренда серверов и тарифы — в кабинете партнёра на сайте БалХоста.</p>
            <a className="btn secondary" href="../hosting/#/partners">Открыть кабинет на hosting.bln</a>
          </div>
          <div className="card">
            <h2>Операции по счёту</h2>
            {!data.history.length ? <p className="muted">Операций нет.</p> : (
              <div className="list">
                {data.history.map((h) => (
                  <div key={h.id} className="list-item">
                    <div className="li-main"><div className="li-title small">{h.memo || h.kind}</div><div className="li-sub">{fmtDate(h.created_at)}</div></div>
                    <Money value={h.amount} plus />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

