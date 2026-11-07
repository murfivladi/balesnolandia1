// БалРег (reg.bln) → домены: поиск и заказ, кабинет, DNS-записи, передача, аукционы.
import { useEffect, useState } from 'react';
import { get, post, del, patch, appUrl } from '../shared/api.js';
import { useLang } from '../shared/i18n.js';
import {
  Spinner, useAsync, Input, Select, Form, Money, MoneyInput, Badge, ActionButton, ErrorBox, Modal, Button, useToast,
} from '../shared/ui.jsx';
import { gameDateLabel } from '@bln/shared/time.js';
import { humanTtl } from '@bln/shared/balnet-dns.js';

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

// ——— Домены ———

export function DomainSearch({ data, onDone, initial = '' }) {
  const [name, setName] = useState(initial);
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);
  const [years, setYears] = useState(1);
  const [reg, setReg] = useState('');
  const [owner, setOwner] = useState('');
  const [order, setOrder] = useState(null);
  const orgs = useAsync(() => get('/gov/orgs'), []);
  // Пришли с главной (поиск по имени) — сразу проверяем.
  useEffect(() => { if (initial) check(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const check = async (e) => {
    e?.preventDefault();
    setErr(null); setRes(null); setOrder(null);
    try {
      const q = name.includes('.') ? name : `${name}.bln`;
      const r = await get(`/gov/domains/check?name=${encodeURIComponent(q)}`);
      // Список организаций свежий: вас могли назначить директором уже после открытия страницы.
      await orgs.reload();
      setRes(r);
      setReg(r.offers[0] ? String(r.offers[0].registrar_org_id ?? '') : '');
      setOwner('');
    } catch (ex) { setErr(ex); }
  };
  const offer = res?.offers.find((o) => String(o.registrar_org_id ?? '') === reg);
  // В зонах госучреждений (.gov.bln, .edu.bln) владелец — только госучреждение, где вы работаете.
  const myOrgs = orgs.data?.orgs || [];
  const govOnly = res?.restricted === 'gov';
  const ownerOptions = govOnly
    ? myOrgs.filter((o) => o.kind === 'gov').map((o) => ({ value: String(o.id), label: `${o.kind_title} «${o.name}»` }))
    : [{ value: '', label: 'Я сам' }, ...myOrgs.map((o) => ({ value: String(o.id), label: `${o.kind_title} «${o.name}»` }))];
  const ownerValue = govOnly && !ownerOptions.some((o) => o.value === owner) ? (ownerOptions[0]?.value || '') : owner;
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
      {res?.free && !order && govOnly && !ownerOptions.length && (
        <div className="form-warn">
          {res.name} свободен, но в зоне .{res.tld} домены регистрируют только госучреждения. Вы не состоите ни в одном госучреждении:
          его создаёт администрация и назначает директора. Если вас уже назначили — обновите страницу.
        </div>
      )}
      {res?.free && !order && (!govOnly || ownerOptions.length > 0) && (
        <Form submitLabel={offer ? `Заказать за ${((offer.price * years) / 100).toLocaleString('ru-RU')} В` : 'Заказать'} onSubmit={async () => {
          const r = await post('/gov/domains', { name: res.name, registrar_org_id: reg ? Number(reg) : null, years: Number(years), owner_org_id: ownerValue ? Number(ownerValue) : null });
          setOrder(r);
          onDone();
        }}>
          <div className="form-ok"><b>{res.name}</b> свободен</div>
          <Select label="Регистратор" value={reg} onChange={(e) => setReg(e.target.value)} options={res.offers.map((o) => ({ value: String(o.registrar_org_id ?? ''), label: `${o.name} — ${(o.price / 100).toLocaleString('ru-RU')} В/год` }))} />
          <Select label="Срок" value={years} onChange={(e) => setYears(Number(e.target.value))} options={Array.from({ length: data.max_years }, (_, i) => ({ value: i + 1, label: `${i + 1} г. (${(i + 1) * 12} игровых мес.)` }))} />
          {(govOnly || myOrgs.length > 0) && (
            <Select label="Владелец" value={ownerValue} onChange={(e) => setOwner(e.target.value)} options={ownerOptions} hint={govOnly ? 'В этой зоне владельцем может быть только госучреждение' : undefined} />
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
              <p className="small muted">Например, A-запись @ — адрес сервера, где лежит сайт: его показывает раздел <a href="../hosting/#/">БалХост</a>.</p>
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
      <p style={{ marginTop: 16 }}><a href="#/domains">← Все домены</a></p>
    </div>
  );
}
