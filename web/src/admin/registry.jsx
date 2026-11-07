// Админка → БалНет → Домены и организации: зоны для регистрации, реестры, госучреждения, лицензии, споры, аукционы.
import { useState } from 'react';
import { get, post, patch } from '../shared/api.js';
import { Spinner, useAsync, Input, Select, Form, Money, MoneyInput, Badge, ActionButton, ErrorBox, useToast } from '../shared/ui.jsx';
import { gameDateLabel } from '@bln/shared/time.js';
import { useLang } from '../shared/i18n.js';

const STATUS_KIND = { active: 'ok', reserved: 'warn', expired: 'err', redemption: 'err' };
const STATUS_TITLE = { active: 'работает', reserved: 'ждёт оплаты', expired: 'льготный период', redemption: 'восстановление' };
const AUCTION_TITLE = { open: 'идёт', awaiting_payment: 'ждёт оплаты', done: 'продан', failed: 'не состоялся' };

export function RegistryAdmin() {
  const lang = useLang();
  const { data, error, reload } = useAsync(() => get('/admin/net/registry'), []);
  const [edit, setEdit] = useState({});
  const [org, setOrg] = useState({ name: '', director_passport: '' });
  const [lic, setLic] = useState({ org_id: '', kind: 'registrar' });
  const [auc, setAuc] = useState({ name: '', min_bid: 50000, months: 1 });
  const [tld, setTld] = useState({ zone: '', wholesale_price: 5000, gov_price: 6000 });
  const toast = useToast();
  if (!data) return error ? <ErrorBox error={error} /> : <Spinner />;
  const orgOptions = [{ value: '', label: '— Координационный центр (бюджет)' }, ...data.orgs.map((o) => ({ value: String(o.id), label: `${o.kind_title} «${o.name}»` }))];
  return (
    <div className="stack">
      <div className="card">
        <h2>Зоны для регистрации доменов</h2>
        <p className="small muted">Цены за год, в влодиках с НДС. Опт уходит реестру зоны (организации или в бюджет), цена Госрегистратора — в бюджет. Обе растут с индексом инфляции.</p>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Зона</th><th>Реестр</th><th>Опт (сейчас)</th><th>Госрегистратор</th><th>Доступ</th><th /></tr></thead>
            <tbody>
              {data.tlds.map((t) => {
                const e = edit[t.id] || {};
                return (
                  <tr key={t.id}>
                    <td className="mono">.{t.name}{!t.active && <> <Badge kind="err">закрыта</Badge></>}</td>
                    <td style={{ minWidth: 180 }}>
                      <select className="input" value={String(e.registry_org_id ?? t.registry_org_id ?? '')} onChange={(ev) => setEdit({ ...edit, [t.id]: { ...e, registry_org_id: ev.target.value } })} aria-label="Реестр зоны">
                        {orgOptions.map((o) => <option key={o.value} value={o.value}>{o.label}</option>)}
                      </select>
                    </td>
                    <td style={{ minWidth: 120 }}><MoneyInput value={e.wholesale_price ?? t.wholesale_price} onChange={(v) => setEdit({ ...edit, [t.id]: { ...e, wholesale_price: v } })} /><div className="small muted"><Money value={t.wholesale_now} /></div></td>
                    <td style={{ minWidth: 120 }}><MoneyInput value={e.gov_price ?? t.gov_price} onChange={(v) => setEdit({ ...edit, [t.id]: { ...e, gov_price: v } })} /></td>
                    <td>{t.restricted === 'gov' ? 'госучреждения' : 'все'}</td>
                    <td className="nowrap">
                      <ActionButton size="sm" okMessage="Сохранено" action={async () => {
                        await patch(`/admin/net/tlds/${t.id}`, { ...e, registry_org_id: e.registry_org_id === undefined ? undefined : (e.registry_org_id ? Number(e.registry_org_id) : null) });
                        setEdit({ ...edit, [t.id]: undefined });
                        reload();
                      }}>Сохранить</ActionButton>
                      <ActionButton size="sm" kind="ghost" action={async () => { await patch(`/admin/net/tlds/${t.id}`, { active: !t.active }); reload(); }}>{t.active ? 'Закрыть' : 'Открыть'}</ActionButton>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {data.candidate_zones.length > 0 && (
          <Form submitLabel="Открыть зону для регистрации" onSubmit={async () => { await post('/admin/net/tlds', tld); reload(); }}>
            <div className="grid grid-3">
              <Select label="Зона" value={tld.zone} onChange={(e) => setTld({ ...tld, zone: e.target.value })} options={[{ value: '', label: 'выберите…' }, ...data.candidate_zones.map((z) => ({ value: z.name, label: `.${z.name}` }))]} />
              <MoneyInput label="Опт за год" value={tld.wholesale_price} onChange={(v) => setTld({ ...tld, wholesale_price: v })} />
              <MoneyInput label="Цена Госрегистратора" value={tld.gov_price} onChange={(v) => setTld({ ...tld, gov_price: v })} />
            </div>
          </Form>
        )}
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h2>Организации</h2>
          <div className="list">
            {data.orgs.map((o) => (
              <div key={o.id} className="list-item">
                <div className="li-main"><div className="li-title">{o.kind_title} «{o.name}»</div><div className="li-sub">ИНН <span className="mono">{o.inn}</span> · директор: {o.director_name || '—'}</div></div>
                <ActionButton size="sm" kind="ghost" action={async () => {
                  const p = prompt('Паспорт нового директора');
                  if (p) { await patch(`/admin/net/orgs/${o.id}`, { director_passport: p }); reload(); }
                }}>Директор</ActionButton>
                <ActionButton size="sm" kind="ghost" confirm={`Закрыть «${o.name}»? Лицензии будут отозваны.`} action={async () => { await patch(`/admin/net/orgs/${o.id}`, { status: 'closed' }); reload(); }}>Закрыть</ActionButton>
              </div>
            ))}
          </div>
          <Form submitLabel="Создать госучреждение" onSubmit={async () => { await post('/admin/net/orgs', { kind: 'gov', ...org }); setOrg({ name: '', director_passport: '' }); toast('Госучреждение создано', 'ok'); reload(); }}>
            <h3>Новое госучреждение</h3>
            <Input label="Название" value={org.name} onChange={(e) => setOrg({ ...org, name: e.target.value })} placeholder="Министерство цифры БФ" />
            <Input label="Паспорт директора" value={org.director_passport} onChange={(e) => setOrg({ ...org, director_passport: e.target.value })} placeholder="BLN-0000-0000" />
          </Form>
        </div>
        <div className="card">
          <h2>Лицензии</h2>
          <div className="list">
            {data.licenses.map((l) => (
              <div key={l.id} className="list-item">
                <div className="li-main"><div className="li-title">{l.title}: {l.org_name}</div><div className="li-sub"><span className="mono">{l.number}</span>{l.expires_month != null ? ` · до ${gameDateLabel(l.expires_month, lang)}` : ''}</div></div>
                <Badge kind={l.status === 'active' ? 'ok' : 'err'}>{l.status === 'active' ? 'действует' : l.status === 'expired' ? 'истекла' : 'отозвана'}</Badge>
                {l.status === 'active' && <ActionButton size="sm" kind="ghost" confirm="Отозвать лицензию?" action={async () => { await post(`/admin/net/licenses/${l.id}/revoke`, { comment: prompt('Причина') || '' }); reload(); }}>Отозвать</ActionButton>}
              </div>
            ))}
          </div>
          <Form submitLabel="Выдать лицензию" onSubmit={async () => { await post('/admin/net/licenses', { org_id: Number(lic.org_id), kind: lic.kind }); reload(); }}>
            <div className="grid grid-2">
              <Select label="Организация" value={lic.org_id} onChange={(e) => setLic({ ...lic, org_id: e.target.value })} options={[{ value: '', label: 'выберите…' }, ...data.orgs.map((o) => ({ value: String(o.id), label: o.name }))]} />
              <Select label="Лицензия" value={lic.kind} onChange={(e) => setLic({ ...lic, kind: e.target.value })} options={Object.entries(data.license_kinds).map(([value, k]) => ({ value, label: k.title }))} />
            </div>
          </Form>
        </div>
      </div>

      <div className="grid grid-2">
        <div className="card">
          <h2>Домены игроков ({data.domains.length})</h2>
          <div className="list">
            {data.domains.map((d) => (
              <div key={d.id} className="list-item">
                <div className="li-main"><div className="li-title mono">{d.name}</div><div className="li-sub">{d.owner || '—'} · {d.registrar} · до {gameDateLabel(d.expires_month, lang)}</div></div>
                <Badge kind={STATUS_KIND[d.status]}>{STATUS_TITLE[d.status] || d.status}</Badge>
                <ActionButton size="sm" kind="ghost" action={async () => {
                  const passport = prompt('Паспорт нового владельца (решение по спору)');
                  if (!passport) return;
                  await post(`/admin/net/domains/${d.id}/owner`, { passport, reason: prompt('Основание') || 'Решение администрации' });
                  reload();
                }}>Владелец</ActionButton>
                <ActionButton size="sm" kind="ghost" action={async () => {
                  const reason = prompt(`Изъять ${d.name}? Укажите основание`);
                  if (reason) { await post(`/admin/net/domains/${d.id}/seize`, { reason }); reload(); }
                }}>Изъять</ActionButton>
              </div>
            ))}
          </div>
          <ActionButton kind="ghost" size="sm" okMessage="Сроки доменов и аукционы обработаны" action={async () => { await post('/admin/net/domains/tick'); reload(); }}>Обработать сроки сейчас</ActionButton>
        </div>
        <div className="card">
          <h2>Аукционы</h2>
          <div className="list">
            {data.auctions.map((a) => (
              <div key={a.id} className="list-item">
                <div className="li-main"><div className="li-title mono">{a.name}</div><div className="li-sub">{a.reason === 'premium' ? 'премиум' : 'освободился'} · до {gameDateLabel(a.ends_month, lang)} · {a.top ? <>ставка <Money value={a.top} /></> : <>старт <Money value={a.min_bid} /></>}</div></div>
                <Badge>{AUCTION_TITLE[a.status] || a.status}</Badge>
              </div>
            ))}
          </div>
          <Form submitLabel="Выставить на аукцион" onSubmit={async () => { await post('/admin/net/auctions', auc); setAuc({ name: '', min_bid: 50000, months: 1 }); reload(); }}>
            <h3>Премиум-имя</h3>
            <Input label="Домен" value={auc.name} onChange={(e) => setAuc({ ...auc, name: e.target.value })} placeholder="shop.bln" />
            <MoneyInput label="Стартовая цена" value={auc.min_bid} onChange={(v) => setAuc({ ...auc, min_bid: v })} />
            <Input label="Игровых месяцев" type="number" min="1" value={auc.months} onChange={(e) => setAuc({ ...auc, months: Number(e.target.value) })} />
          </Form>
        </div>
      </div>
    </div>
  );
}
