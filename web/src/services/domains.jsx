// ВлодУслуги → Организации и Домены (этап Н3).
import { useState } from 'react';
import { get, post, put, del, patch, appUrl } from '../shared/api.js';
import { useLang, fmtDate } from '../shared/i18n.js';
import { navigate } from '../shared/router.js';
import {
  Spinner, useAsync, Input, Select, Form, Money, MoneyInput, Badge, ActionButton, ErrorBox, Modal, Button, useToast,
} from '../shared/ui.jsx';
import { gameDateLabel } from '@bln/shared/time.js';
import { humanTtl } from '@bln/shared/balnet-dns.js';
import { OrgHosting } from './hosting.jsx';

const STATUS_KIND = { active: 'ok', reserved: 'warn', expired: 'err', redemption: 'err', released: '' };
const RR_HINT = {
  A: '50.1.0.20', AAAA: 'ba1:1::10', CNAME: 'boris.bln.', MX: '10 mail.boris.bln.', TXT: 'Привет из БалНета', SRV: '10 5 443 web.boris.bln.', CAA: '0 issue "ca.gov.bln"', NS: 'ns1.example.bln.', PTR: 'host.boris.bln.',
};
const RR_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'SRV', 'CAA', 'NS'];

function PayLink({ invoice, amount }) {
  return (
    <div className="form-warn row" style={{ justifyContent: 'space-between' }}>
      <span>Квитанция <span className="mono">{invoice}</span>{amount ? <> на <Money value={amount} /></> : null}</span>
      <a className="btn sm" href={appUrl('bank', `/pay/${invoice}`)}>Оплатить во ВлодБанке</a>
    </div>
  );
}

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
      {data.pending.length > 0 && <div className="form-warn" style={{ marginBottom: 16 }}>Заявлений на рассмотрении или ждут оплаты: {data.pending.length} — <a href="#/invoices">квитанции</a></div>}
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
  const [prices, setPrices] = useState({});
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
            {director && o.kind !== 'gov' && !data.is_registrar && (
              <ActionButton kind="secondary" okMessage="Заявление подано: оплатите пошлину, затем его рассмотрит чиновник" action={async () => { await post(`/gov/orgs/${id}/licenses`, { kind: 'registrar' }); reload(); }}>Получить лицензию регистратора доменов</ActionButton>
            )}
          </div>
          {data.is_registrar && (
            <div className="card">
              <h2>Цены регистратора</h2>
              <p className="small muted">Цена за год, с НДС. После НДС должна покрывать оптовую цену реестра — она растёт с инфляцией.</p>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Зона</th><th>Опт</th><th>Мин.</th><th>Ваша цена</th><th /></tr></thead>
                  <tbody>
                    {data.registrar_tlds.map((t) => (
                      <tr key={t.id}>
                        <td className="mono">.{t.name}</td>
                        <td><Money value={t.wholesale} /></td>
                        <td><Money value={t.min_price} /></td>
                        <td style={{ minWidth: 140 }}>
                          <MoneyInput value={prices[t.id] ?? t.price ?? t.min_price} onChange={(v) => setPrices({ ...prices, [t.id]: v })} />
                        </td>
                        <td className="nowrap">
                          {director && <ActionButton size="sm" okMessage="Цена сохранена" action={async () => { await put(`/gov/orgs/${id}/prices`, { tld_id: t.id, price: prices[t.id] ?? t.price ?? t.min_price }); reload(); }}>{t.price == null ? 'Продавать' : 'Сохранить'}</ActionButton>}
                          {director && t.price != null && <ActionButton size="sm" kind="ghost" action={async () => { await put(`/gov/orgs/${id}/prices`, { tld_id: t.id, price: null }); reload(); }}>Снять</ActionButton>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {data.sold_domains.length > 0 && <p className="small">Доменов на обслуживании: {data.sold_domains.length}</p>}
            </div>
          )}
          <OrgHosting orgId={id} director={director} kind={o.kind} />
          {data.registry.length > 0 && (
            <div className="card">
              <h2>Реестр зон</h2>
              <p className="small muted">Вы администратор зоны: оптовая цена — сколько регистраторы платят вам за год каждого домена.</p>
              {data.registry.map((t) => (
                <Form key={t.id} submitLabel={`Сохранить для .${t.name}`} onSubmit={async () => { await put(`/gov/orgs/${id}/registry/${t.id}`, { wholesale_price: prices[`r${t.id}`] ?? t.wholesale_price }); toast('Оптовая цена сохранена', 'ok'); reload(); }}>
                  <MoneyInput label={`Оптовая цена .${t.name}`} value={prices[`r${t.id}`] ?? t.wholesale_price} onChange={(v) => setPrices({ ...prices, [`r${t.id}`]: v })} />
                </Form>
              ))}
            </div>
          )}
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

// ——— Домены ———

function DomainSearch({ data, onDone }) {
  const [name, setName] = useState('');
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);
  const [years, setYears] = useState(1);
  const [reg, setReg] = useState('');
  const [owner, setOwner] = useState('');
  const [order, setOrder] = useState(null);
  const orgs = useAsync(() => get('/gov/orgs'), []);
  const check = async (e) => {
    e?.preventDefault();
    setErr(null); setRes(null); setOrder(null);
    try {
      const q = name.includes('.') ? name : `${name}.bln`;
      const r = await get(`/gov/domains/check?name=${encodeURIComponent(q)}`);
      setRes(r);
      setReg(r.offers[0] ? String(r.offers[0].registrar_org_id ?? '') : '');
    } catch (ex) { setErr(ex); }
  };
  const offer = res?.offers.find((o) => String(o.registrar_org_id ?? '') === reg);
  return (
    <div className="card">
      <h2>Найти и зарегистрировать домен</h2>
      <form className="row nowrap" onSubmit={check}>
        <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="например, vasya.bln" aria-label="Имя домена" style={{ flex: 1 }} />
        <Button type="submit">Проверить</Button>
      </form>
      <p className="small muted">Зоны: {data.tlds.map((t) => `.${t.name}${t.restricted ? ' (госучреждения)' : ''}`).join(', ')}</p>
      <ErrorBox error={err} />
      {res && !res.free && <div className="form-warn">{res.name}: {res.reason}{res.auction_id ? ' — смотрите аукционы ниже' : ''}</div>}
      {res?.free && !order && (
        <Form submitLabel={offer ? `Заказать за ${((offer.price * years) / 100).toLocaleString('ru-RU')} В` : 'Заказать'} onSubmit={async () => {
          const r = await post('/gov/domains', { name: res.name, registrar_org_id: reg ? Number(reg) : null, years: Number(years), owner_org_id: owner ? Number(owner) : null });
          setOrder(r);
          onDone();
        }}>
          <div className="form-ok"><b>{res.name}</b> свободен</div>
          <Select label="Регистратор" value={reg} onChange={(e) => setReg(e.target.value)} options={res.offers.map((o) => ({ value: String(o.registrar_org_id ?? ''), label: `${o.name} — ${(o.price / 100).toLocaleString('ru-RU')} В/год` }))} />
          <Select label="Срок" value={years} onChange={(e) => setYears(Number(e.target.value))} options={Array.from({ length: data.max_years }, (_, i) => ({ value: i + 1, label: `${i + 1} г. (${(i + 1) * 12} игровых мес.)` }))} />
          {(orgs.data?.orgs || []).length > 0 && (
            <Select label="Владелец" value={owner} onChange={(e) => setOwner(e.target.value)} options={[{ value: '', label: 'Я сам' }, ...orgs.data.orgs.map((o) => ({ value: String(o.id), label: `${o.kind_title} «${o.name}»` }))]} />
          )}
        </Form>
      )}
      {order && (order.invoice ? <PayLink invoice={order.invoice} amount={order.amount} /> : <div className="form-ok">Домен зарегистрирован и уже работает.</div>)}
    </div>
  );
}

export function DomainsPage() {
  const lang = useLang();
  const { data, error, reload } = useAsync(() => get('/gov/domains'), []);
  const [claim, setClaim] = useState({ name: '', auth_code: '' });
  const [bids, setBids] = useState({});
  const toast = useToast();
  if (!data) return error ? <div className="page"><ErrorBox error={error} /></div> : <Spinner />;
  return (
    <div className="page">
      <div className="page-head">
        <h1>Домены БалНета</h1>
        <span className="muted small">Игровая дата: {gameDateLabel(data.month, lang)} · год домена = 12 игровых месяцев</span>
      </div>
      <div className="grid grid-2">
        <div className="stack">
          <DomainSearch data={data} onDone={reload} />
          <div className="card">
            <h2>Мои домены</h2>
            {!data.domains.length ? <p className="muted">Доменов пока нет.</p> : (
              <div className="list">
                {data.domains.map((d) => (
                  <a key={d.id} href={`#/domains/${d.id}`} className="list-item" style={{ color: 'inherit' }}>
                    <div className="li-main">
                      <div className="li-title mono">{d.name}</div>
                      <div className="li-sub">{d.registrar} · до {gameDateLabel(d.expires_month, lang)}{d.pending_order ? ` · ждёт оплаты ${(d.pending_order.amount / 100).toLocaleString('ru-RU')} В` : ''}</div>
                    </div>
                    <Badge kind={STATUS_KIND[d.status]}>{d.status_title}</Badge>
                  </a>
                ))}
              </div>
            )}
          </div>
        </div>
        <div className="stack">
          <div className="card">
            <Form submitLabel="Принять домен" onSubmit={async () => { await post('/gov/domains/claim', claim); setClaim({ name: '', auth_code: '' }); toast('Домен теперь ваш', 'ok'); reload(); }}>
              <h2>Получить домен по коду</h2>
              <p className="small muted">Владелец сообщает вам имя и код авторизации со страницы домена. После передачи код меняется.</p>
              <Input label="Домен" value={claim.name} onChange={(e) => setClaim({ ...claim, name: e.target.value })} placeholder="vasya.bln" />
              <Input label="Код авторизации" value={claim.auth_code} onChange={(e) => setClaim({ ...claim, auth_code: e.target.value })} className="input mono" />
            </Form>
          </div>
          <div className="card">
            <h2>Аукционы</h2>
            <p className="small muted">Освободившиеся и премиум-имена. Победитель получает квитанцию на сумму ставки.</p>
            {!data.auctions.length ? <p className="muted">Сейчас аукционов нет.</p> : (
              <div className="list">
                {data.auctions.map((a) => (
                  <div key={a.id} className="list-item" style={{ flexWrap: 'wrap' }}>
                    <div className="li-main">
                      <div className="li-title mono">{a.name}</div>
                      <div className="li-sub">
                        {a.status === 'open' ? <>до {gameDateLabel(a.ends_month, lang)} · ставок: {a.bids} · {a.top ? <>лидер <Money value={a.top} /></> : <>старт <Money value={a.min_bid} /></>}{a.my_bid ? <> · ваша <Money value={a.my_bid} /></> : null}</> : a.winner_me ? 'Вы победили — оплатите квитанцию' : 'Ждёт оплаты победителем'}
                      </div>
                    </div>
                    {a.status === 'open' && (
                      <form className="row nowrap" onSubmit={async (e) => {
                        e.preventDefault();
                        try { await post(`/gov/auctions/${a.id}/bid`, { amount: bids[a.id] || Math.max(a.min_bid, (a.top || 0) + 100) }); toast('Ставка принята', 'ok'); reload(); } catch (ex) { toast(ex.message, 'err'); }
                      }}>
                        <div style={{ width: 130 }}><MoneyInput value={bids[a.id] || Math.max(a.min_bid, (a.top || 0) + 100)} onChange={(v) => setBids({ ...bids, [a.id]: v })} /></div>
                        <Button size="sm" type="submit">Ставка</Button>
                      </form>
                    )}
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

function RecordForm({ initial, onSubmit, submitLabel }) {
  const [r, setR] = useState(initial);
  return (
    <Form submitLabel={submitLabel} onSubmit={async () => { await onSubmit({ ...r, ttl: Number(r.ttl) }); if (!initial.id) setR({ ...initial, type: r.type }); }}>
      <div className="grid grid-2">
        <Input label="Имя" value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="@ или www" />
        <Select label="Тип" value={r.type} onChange={(e) => setR({ ...r, type: e.target.value })} options={RR_TYPES.map((x) => ({ value: x, label: x }))} disabled={!!initial.id} />
      </div>
      <Input label="Значение" value={r.data} onChange={(e) => setR({ ...r, data: e.target.value })} placeholder={RR_HINT[r.type]} />
      <Input label="TTL, игровых секунд" type="number" min="0" value={r.ttl} onChange={(e) => setR({ ...r, ttl: e.target.value })} hint={humanTtl(r.ttl)} />
    </Form>
  );
}

export function DomainPage({ id }) {
  const lang = useLang();
  const { data, error, reload } = useAsync(() => get(`/gov/domains/${id}`), [id]);
  const [years, setYears] = useState(1);
  const [order, setOrder] = useState(null);
  const [showCode, setShowCode] = useState(false);
  const [ns, setNs] = useState(null);
  const [edit, setEdit] = useState(null);
  const [newReg, setNewReg] = useState('');
  const toast = useToast();
  if (!data) return error ? <div className="page"><ErrorBox error={error} /></div> : <Spinner />;
  const d = data.domain;
  const nsList = ns || d.ns.map((x) => ({ name: x.name, ip: x.ip || '' }));
  const currentOffer = data.offers.find((o) => (o.registrar_org_id ?? null) === (d.registrar_org_id ?? null)) || data.offers[0];
  const others = data.offers.filter((o) => (o.registrar_org_id ?? null) !== (d.registrar_org_id ?? null));
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="mono">{d.name}</h1>
        <Badge kind={STATUS_KIND[d.status]}>{d.status_title}</Badge>
        <a className="btn sm secondary" href={`../#${d.name}`} target="_top">Открыть во ВлодБраузере</a>
      </div>
      {d.pending_order && <PayLink invoice={d.pending_order.invoice} amount={d.pending_order.amount} />}
      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="stack">
          <div className="card">
            <h2>Домен</h2>
            <dl className="kv">
              <dt>Регистратор</dt><dd>{d.registrar}</dd>
              <dt>Зарегистрирован</dt><dd>{gameDateLabel(d.created_month, lang)}</dd>
              <dt>Оплачен до</dt><dd>{gameDateLabel(d.expires_month, lang)}</dd>
              <dt>Серверы имён</dt><dd className="mono small">{d.ns.map((x) => x.name).join(', ')}</dd>
            </dl>
            <label className="row nowrap small" style={{ marginTop: 8 }}>
              <input type="checkbox" checked={d.privacy} onChange={async (e) => { await post(`/gov/domains/${id}/privacy`, { privacy: e.target.checked }); reload(); }} />
              Скрыть мои данные в WHOIS
            </label>
            <div className="row" style={{ marginTop: 8 }}>
              <span className="small">Код авторизации: </span>
              <span className="mono">{showCode ? d.auth_code : '••••••••••••'}</span>
              <Button size="sm" kind="ghost" onClick={() => setShowCode((v) => !v)}>{showCode ? 'Скрыть' : 'Показать'}</Button>
              <ActionButton size="sm" kind="ghost" confirm="Сменить код? Старый перестанет работать." action={async () => { await post(`/gov/domains/${id}/auth-code`); reload(); }}>Сменить</ActionButton>
            </div>
            <p className="small muted">По этому коду домен можно передать другому человеку (раздел «Получить домен по коду») или перенести к другому регистратору.</p>
          </div>
          {d.status !== 'reserved' && (
            <div className="card">
              <h2>{d.status === 'redemption' ? 'Восстановить' : 'Продлить'}</h2>
              {d.status === 'expired' && <div className="form-warn">Срок истёк, сайт не открывается. В льготный период продление — по обычной цене.</div>}
              {d.status === 'redemption' && <div className="form-warn">Идёт период восстановления: к цене добавляется плата за восстановление. Потом домен освободится и уйдёт на аукцион.</div>}
              {order ? <PayLink invoice={order.invoice} /> : (
                <Form submitLabel={`Продлить на ${years} г. — ${((currentOffer.price * years) / 100).toLocaleString('ru-RU')} В${d.status === 'redemption' ? ' + восстановление' : ''}`} onSubmit={async () => { setOrder(await post(`/gov/domains/${id}/renew`, { years })); reload(); }}>
                  <Select label="Срок" value={years} onChange={(e) => setYears(Number(e.target.value))} options={Array.from({ length: 10 }, (_, i) => ({ value: i + 1, label: `${i + 1} г.` }))} />
                </Form>
              )}
            </div>
          )}
          {d.status === 'active' && others.length > 0 && (
            <div className="card">
              <Form submitLabel="Перенести" onSubmit={async () => { const r = await post(`/gov/domains/${id}/transfer-registrar`, { registrar_org_id: newReg ? Number(newReg) : null, auth_code: d.auth_code }); setOrder(r); reload(); }}>
                <h2>Сменить регистратора</h2>
                <p className="small muted">Новый регистратор берёт плату за год — срок домена увеличится на 12 игровых месяцев.</p>
                <Select label="Новый регистратор" value={newReg} onChange={(e) => setNewReg(e.target.value)} options={[{ value: '', label: 'выберите…' }, ...others.map((o) => ({ value: String(o.registrar_org_id ?? ''), label: `${o.name} — ${(o.price / 100).toLocaleString('ru-RU')} В` }))]} />
              </Form>
            </div>
          )}
        </div>
        <div className="stack">
          <div className="card">
            <h2>Серверы имён (NS)</h2>
            <label className="row nowrap small"><input type="radio" checked={d.ns_mode === 'hosted'} onChange={async () => { await post(`/gov/domains/${id}/nameservers`, { mode: 'hosted' }); setNs(null); reload(); }} /> DNS-хостинг БалНета (ns1/ns2.dns.bln) — записи правятся ниже</label>
            <label className="row nowrap small"><input type="radio" checked={d.ns_mode === 'custom'} onChange={() => setNs(nsList.length && d.ns_mode === 'custom' ? nsList : [{ name: '', ip: '' }])} /> Свои серверы имён</label>
            {(ns || d.ns_mode === 'custom') && (
              <Form submitLabel="Сохранить серверы" onSubmit={async () => { await post(`/gov/domains/${id}/nameservers`, { mode: 'custom', ns: nsList.filter((x) => x.name.trim()) }); setNs(null); toast('Делегирование обновлено', 'ok'); reload(); }}>
                {nsList.map((x, i) => (
                  <div key={i} className="grid grid-2">
                    <Input label={`Сервер ${i + 1}`} value={x.name} onChange={(e) => setNs(nsList.map((y, j) => (j === i ? { ...y, name: e.target.value } : y)))} placeholder="ns1.example.bln" />
                    <Input label="IP (если сервер внутри домена)" value={x.ip} onChange={(e) => setNs(nsList.map((y, j) => (j === i ? { ...y, ip: e.target.value } : y)))} placeholder="glue" />
                  </div>
                ))}
                {nsList.length < 6 && <Button type="button" kind="ghost" size="sm" onClick={() => setNs([...nsList, { name: '', ip: '' }])}>+ ещё сервер</Button>}
              </Form>
            )}
          </div>
          {d.ns_mode === 'hosted' && d.zone_id && (
            <div className="card">
              <h2>DNS-записи</h2>
              <p className="small muted">Например, A-запись @ — адрес сервера, где лежит сайт: его показывает раздел <a href="#/hosting">Хостинг</a>.</p>
              <div className="table-wrap">
                <table className="table">
                  <thead><tr><th>Имя</th><th>Тип</th><th>Значение</th><th>TTL</th><th /></tr></thead>
                  <tbody>
                    {data.records.map((r) => (
                      <tr key={r.id}>
                        <td className="mono small">{r.rel}</td>
                        <td><Badge>{r.type}</Badge></td>
                        <td className="mono small" style={{ wordBreak: 'break-all' }}>{r.data}</td>
                        <td className="small">{humanTtl(r.ttl)}</td>
                        <td className="nowrap">
                          {!r.locked && <Button size="sm" kind="ghost" onClick={() => setEdit({ id: r.id, name: r.rel, type: r.type, ttl: r.ttl, data: r.data })}>✎</Button>}
                          {!r.locked && <ActionButton size="sm" kind="ghost" confirm="Удалить запись?" action={async () => { await del(`/gov/domains/${id}/records/${r.id}`); reload(); }}>✕</ActionButton>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <h3>Новая запись</h3>
              <RecordForm initial={{ name: '@', type: 'A', ttl: 3600, data: '' }} submitLabel="Добавить" onSubmit={async (r) => { await post(`/gov/domains/${id}/records`, r); toast('Запись добавлена', 'ok'); reload(); }} />
            </div>
          )}
        </div>
      </div>
      {edit && (
        <Modal title="Изменить запись" onClose={() => setEdit(null)}>
          <RecordForm initial={edit} submitLabel="Сохранить" onSubmit={async (r) => { await patch(`/gov/domains/${id}/records/${edit.id}`, r); setEdit(null); reload(); }} />
        </Modal>
      )}
      <p style={{ marginTop: 16 }}><a href="#/domains" onClick={(e) => { e.preventDefault(); navigate('/domains'); }}>← Все домены</a></p>
    </div>
  );
}
