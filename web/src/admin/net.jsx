// Админка → БалНет: провайдеры, IP-блоки и серверы, сайты на серверах, DNS-зоны и записи.
import { useState } from 'react';
import { get, post, patch, del } from '../shared/api.js';
import {
  Spinner, useAsync, Input, Select, Form, Modal, Empty, Badge, ActionButton, Tabs, ErrorBox, Button, useToast,
} from '../shared/ui.jsx';
import { relativeName, humanTtl } from '@bln/shared/balnet-dns.js';
import { RegistryAdmin } from './registry.jsx';
import { HostingAdmin } from './hosting.jsx';

const KIND_LABEL = { router: 'маршрутизатор', auth: 'DNS-сервер зон', resolver: 'резолвер', web: 'веб-сервер' };
const PURPOSE_LABEL = { infra: 'инфраструктура', datacenter: 'дата-центр', provider: 'провайдер', ix: 'точка обмена', hosting: 'хостинг' };
const TARGET_LABEL = { 'app:bank': 'ВлодБанк', 'app:services': 'ВлодУслуги', 'app:pos': 'Касса', poisk: 'ВлодПоиск' };
const strip = (n) => String(n || '').replace(/\.$/, '');

export function NetSection() {
  const [tab, setTab] = useState('registry');
  const ov = useAsync(() => get('/admin/net/overview'), []);
  return (
    <div className="page">
      <h1>БалНет</h1>
      <p className="muted">Сеть ВлодБраузера: провайдеры выдают игрокам IP-адреса, DNS идёт по цепочке корень → зона верхнего уровня → серверы имён домена. TTL считается в игровых секундах (в игровом месяце 30 игровых суток).</p>
      <Tabs value={tab} onChange={setTab} tabs={[{ value: 'registry', label: 'Домены и организации' }, { value: 'hosting', label: 'Хостинг' }, { value: 'zones', label: 'Зоны DNS' }, { value: 'hosts', label: 'Адреса и серверы' }, { value: 'providers', label: 'Провайдеры' }]} />
      <ErrorBox error={ov.error} />
      {tab === 'registry' && <RegistryAdmin />}
      {tab === 'hosting' && <HostingAdmin />}
      {!ov.data ? <Spinner /> : (
        <>
          {tab === 'zones' && <Zones ov={ov.data} reload={ov.reload} />}
          {tab === 'hosts' && <Hosts ov={ov.data} reload={ov.reload} />}
          {tab === 'providers' && <Providers ov={ov.data} reload={ov.reload} />}
        </>
      )}
    </div>
  );
}

// ——— Провайдеры ———

function Providers({ ov, reload }) {
  const [f, setF] = useState({ code: '', name: '', cidr: '', latency_ms: 10 });
  const toast = useToast();
  return (
    <div className="grid grid-2">
      <div className="card">
        <h2>Провайдеры</h2>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Провайдер</th><th>Сеть</th><th>DNS</th><th>Абонентов</th><th /></tr></thead>
            <tbody>
              {ov.providers.map((p) => (
                <tr key={p.id}>
                  <td><b>{p.name}</b><div className="muted small mono">{p.code}</div></td>
                  <td className="mono">{p.cidr}</td>
                  <td className="mono">{p.resolver_ip}</td>
                  <td>{p.leases}</td>
                  <td>
                    <ActionButton size="sm" kind="ghost" action={async () => { await patch(`/admin/net/providers/${p.id}`, { active: !p.active }); reload(); }}>
                      {p.active ? 'Отключить' : 'Включить'}
                    </ActionButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <p className="muted small">Отключённый провайдер пропадает из выбора в браузере. Его абоненты получат новый адрес у другого провайдера.</p>
      </div>
      <div className="card">
        <Form submitLabel="Добавить провайдера" onSubmit={async () => {
          await post('/admin/net/providers', { ...f, latency_ms: Number(f.latency_ms) });
          setF({ code: '', name: '', cidr: '', latency_ms: 10 });
          toast('Провайдер добавлен', 'ok');
          reload();
        }}>
          <h2>Новый провайдер</h2>
          <Input label="Название" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="БалСвязь" />
          <Input label="Код" value={f.code} onChange={(e) => setF({ ...f, code: e.target.value })} placeholder="balsvyaz" hint="Латиница: из него получатся имена gw.<код>.bln и dns.<код>.bln" />
          <Input label="Сеть адресов" value={f.cidr} onChange={(e) => setF({ ...f, cidr: e.target.value })} placeholder="60.4.0.0/16" hint="Шлюз — первый адрес сети, резолвер — .53" />
          <Input label="Задержка до шлюза, мс" type="number" min="0" value={f.latency_ms} onChange={(e) => setF({ ...f, latency_ms: e.target.value })} />
        </Form>
      </div>
    </div>
  );
}

// ——— Адреса и серверы ———

function Hosts({ ov, reload }) {
  const [bf, setBf] = useState({ cidr: '', purpose: 'datacenter', holder: '', gateway_ip: '', latency_ms: 5 });
  const [hf, setHf] = useState({ ip: '', name: '', kind: 'web' });
  const [vh, setVh] = useState({});
  const toast = useToast();
  return (
    <>
      <div className="card">
        <h2>Серверы</h2>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Адрес</th><th>Имя</th><th>Вид</th><th>Сайты</th><th /></tr></thead>
            <tbody>
              {ov.hosts.sort((a, b) => a.ip.localeCompare(b.ip, 'en', { numeric: true })).map((h) => (
                <tr key={h.ip}>
                  <td className="mono">{h.ip}</td>
                  <td className="mono small">{strip(h.name)}</td>
                  <td>{KIND_LABEL[h.kind] || h.kind}{!h.up && <> <Badge kind="err">выключен</Badge></>}{h.kind === 'resolver' && <div className="muted small">в кэше: {h.cache}</div>}</td>
                  <td>
                    {h.vhosts.map((v) => (
                      <div key={v.id} className="row nowrap small">
                        <span className="mono">{v.host}</span> → {TARGET_LABEL[v.target] || v.target}
                        <ActionButton size="sm" kind="ghost" confirm={`Убрать сайт ${v.host} с сервера?`} action={async () => { await del(`/admin/net/vhosts/${v.id}`); reload(); }}>✕</ActionButton>
                      </div>
                    ))}
                    {h.kind === 'web' && (
                      <form className="row nowrap" onSubmit={async (e) => {
                        e.preventDefault();
                        try {
                          await post('/admin/net/vhosts', { ip: h.ip, host: vh[h.ip]?.host || '', target: vh[h.ip]?.target || ov.vhost_targets[0] });
                          setVh({ ...vh, [h.ip]: {} });
                          reload();
                        } catch (err) { toast(err.message, 'err'); }
                      }}>
                        <input className="input" style={{ maxWidth: 160 }} placeholder="имя сайта" value={vh[h.ip]?.host || ''} onChange={(e) => setVh({ ...vh, [h.ip]: { ...vh[h.ip], host: e.target.value } })} aria-label="Имя сайта" />
                        <select className="input" style={{ maxWidth: 130 }} value={vh[h.ip]?.target || ov.vhost_targets[0]} onChange={(e) => setVh({ ...vh, [h.ip]: { ...vh[h.ip], target: e.target.value } })} aria-label="Что показывать">
                          {ov.vhost_targets.map((x) => <option key={x} value={x}>{TARGET_LABEL[x] || x}</option>)}
                        </select>
                        <Button size="sm" kind="secondary" type="submit">+</Button>
                      </form>
                    )}
                  </td>
                  <td className="nowrap">
                    <ActionButton size="sm" kind="ghost" action={async () => { await patch(`/admin/net/hosts/${encodeURIComponent(h.ip)}`, { up: !h.up }); reload(); }}>{h.up ? 'Выключить' : 'Включить'}</ActionButton>
                    {h.kind === 'resolver' && <ActionButton size="sm" kind="ghost" okMessage="Кэш очищен" action={async () => { await post('/admin/net/cache/flush', { resolver: h.ip }); reload(); }}>Сбросить кэш</ActionButton>}
                    <ActionButton size="sm" kind="ghost" confirm={`Удалить сервер ${h.ip}?`} action={async () => { await del(`/admin/net/hosts/${encodeURIComponent(h.ip)}`); reload(); }}>Удалить</ActionButton>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <Form submitLabel="Добавить сервер" onSubmit={async () => { await post('/admin/net/hosts', hf); setHf({ ip: '', name: '', kind: 'web' }); toast('Сервер добавлен', 'ok'); reload(); }}>
            <h2>Новый сервер</h2>
            <Input label="IP-адрес" value={hf.ip} onChange={(e) => setHf({ ...hf, ip: e.target.value })} placeholder="50.1.0.30" hint="Адрес должен входить в один из IP-блоков" />
            <Input label="Имя" value={hf.name} onChange={(e) => setHf({ ...hf, name: e.target.value })} placeholder="web2.dc.gov.bln" hint="Для traceroute и обратной зоны (PTR) — запись появится сама" />
            <Select label="Вид" value={hf.kind} onChange={(e) => setHf({ ...hf, kind: e.target.value })} options={Object.entries(KIND_LABEL).map(([value, label]) => ({ value, label }))} />
          </Form>
        </div>
        <div className="card">
          <h2>IP-блоки</h2>
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>Сеть</th><th>Владелец</th><th>Шлюз</th><th /></tr></thead>
              <tbody>
                {ov.blocks.map((b) => (
                  <tr key={b.id}>
                    <td className="mono">{b.cidr}</td>
                    <td>{b.holder}<div className="muted small">{PURPOSE_LABEL[b.purpose] || b.purpose}, {b.latency_ms} мс</div></td>
                    <td className="mono small">{b.gateway_ip || '—'}</td>
                    <td><ActionButton size="sm" kind="ghost" confirm={`Удалить блок ${b.cidr}?`} action={async () => { await del(`/admin/net/blocks/${b.id}`); reload(); }}>✕</ActionButton></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <Form submitLabel="Добавить блок" onSubmit={async () => { await post('/admin/net/blocks', { ...bf, latency_ms: Number(bf.latency_ms) }); setBf({ cidr: '', purpose: 'datacenter', holder: '', gateway_ip: '', latency_ms: 5 }); reload(); }}>
            <Input label="Сеть" value={bf.cidr} onChange={(e) => setBf({ ...bf, cidr: e.target.value })} placeholder="50.2.0.0/16" />
            <Input label="Владелец" value={bf.holder} onChange={(e) => setBf({ ...bf, holder: e.target.value })} placeholder="Дата-центр «Север»" />
            <Select label="Назначение" value={bf.purpose} onChange={(e) => setBf({ ...bf, purpose: e.target.value })} options={Object.entries(PURPOSE_LABEL).filter(([v]) => v !== 'provider').map(([value, label]) => ({ value, label }))} />
            <Input label="Шлюз (необязательно)" value={bf.gateway_ip} onChange={(e) => setBf({ ...bf, gateway_ip: e.target.value })} placeholder="50.2.0.1" />
            <Input label="Задержка, мс" type="number" min="0" value={bf.latency_ms} onChange={(e) => setBf({ ...bf, latency_ms: e.target.value })} />
          </Form>
        </div>
      </div>
    </>
  );
}

// ——— Зоны DNS ———

function Zones({ ov, reload }) {
  const [open, setOpen] = useState(null);
  const [zf, setZf] = useState({ name: '', servers: [] });
  const auth = ov.hosts.filter((h) => h.kind === 'auth');
  if (open) return <ZoneEditor id={open} types={ov.record_types} onBack={() => { setOpen(null); reload(); }} />;
  return (
    <div className="grid grid-2">
      <div className="card">
        <h2>Зоны</h2>
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Зона</th><th>Серверы</th><th>Записей</th><th>Serial</th></tr></thead>
            <tbody>
              {ov.zones.map((z) => (
                <tr key={z.id} style={{ cursor: 'pointer' }} onClick={() => setOpen(z.id)}>
                  <td><a href="#/net" onClick={(e) => { e.preventDefault(); setOpen(z.id); }} className="mono">{z.name}</a><div className="muted small">{z.kind}</div></td>
                  <td className="mono small">{z.servers.join(', ')}</td>
                  <td>{z.records}</td>
                  <td className="mono small">{z.serial}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="card">
        <Form submitLabel="Создать зону" onSubmit={async () => { const r = await post('/admin/net/zones', zf); setZf({ name: '', servers: [] }); reload(); setOpen(r.id); }}>
          <h2>Новая зона</h2>
          <p className="muted small">Создаются SOA и NS, а в родительской зоне — делегирование (NS) и, если нужно, glue. Игроки начнут регистрировать домены на этапе Н3.</p>
          <Input label="Имя зоны" value={zf.name} onChange={(e) => setZf({ ...zf, name: e.target.value })} placeholder="news.bln" />
          <fieldset className="stack" style={{ border: 0, padding: 0, margin: 0 }}>
            <legend className="small muted">Серверы имён</legend>
            {auth.map((h) => (
              <label key={h.ip} className="row nowrap small">
                <input type="checkbox" checked={zf.servers.includes(h.ip)} onChange={(e) => setZf({ ...zf, servers: e.target.checked ? [...zf.servers, h.ip] : zf.servers.filter((x) => x !== h.ip) })} />
                <span className="mono">{strip(h.name)} ({h.ip})</span>
              </label>
            ))}
          </fieldset>
        </Form>
      </div>
    </div>
  );
}

const EMPTY_REC = { name: '', type: 'A', ttl: 3600, data: '' };

function ZoneEditor({ id, types, onBack }) {
  const z = useAsync(() => get(`/admin/net/zones/${id}`), [id]);
  const [rf, setRf] = useState(EMPTY_REC);
  const [edit, setEdit] = useState(null);
  if (!z.data) return <>{z.error ? <ErrorBox error={z.error} /> : <Spinner />}</>;
  const zone = z.data.zone;
  const hint = {
    A: '50.1.0.10', AAAA: 'ba1:1::10', CNAME: 'bank.bln.', MX: '10 mx.bank.bln.', TXT: 'v=spf1 -all', NS: 'ns1.gov.bln.', SRV: '10 5 443 web.bank.bln.', CAA: '0 issue "ca.gov.bln"', PTR: 'web1.dc.gov.bln.', SOA: 'ns1.gov.bln. hostmaster.gov.bln. 1 7200 3600 1209600 300',
  }[rf.type];
  return (
    <div className="card">
      <div className="row">
        <Button kind="ghost" size="sm" onClick={onBack}>← Все зоны</Button>
        <h2 className="mono" style={{ margin: 0 }}>{zone.name}</h2>
        <span className="muted small">serial {zone.serial}, серверы: {zone.servers.join(', ')}</span>
        <span style={{ flex: 1 }} />
        {zone.kind !== 'root' && zone.name !== 'in-addr.arpa.' && (
          <ActionButton kind="danger" size="sm" confirm={`Удалить зону ${zone.name} и делегирование в родительской зоне?`} action={async () => { await del(`/admin/net/zones/${id}`); onBack(); }}>Удалить зону</ActionButton>
        )}
      </div>
      <div className="table-wrap" style={{ marginTop: 12 }}>
        <table className="table">
          <thead><tr><th>Имя</th><th>TTL</th><th>Тип</th><th>Данные</th><th /></tr></thead>
          <tbody>
            {z.data.records.map((r) => (
              <tr key={r.id}>
                <td className="mono small">{relativeName(r.name, zone.name)}</td>
                <td className="small" title={`${r.ttl} игровых секунд`}>{humanTtl(r.ttl)}</td>
                <td><Badge>{r.type}</Badge></td>
                <td className="mono small" style={{ wordBreak: 'break-all' }}>{r.data}</td>
                <td className="nowrap">
                  <Button size="sm" kind="ghost" onClick={() => setEdit({ ...r, name: relativeName(r.name, zone.name) })}>✎</Button>
                  {r.type !== 'SOA' && <ActionButton size="sm" kind="ghost" confirm="Удалить запись?" action={async () => { await del(`/admin/net/records/${r.id}`); z.reload(); }}>✕</ActionButton>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!z.data.records.length && <Empty>Записей нет</Empty>}
      <div style={{ maxWidth: 560, marginTop: 16 }}>
        <Form submitLabel="Добавить запись" onSubmit={async () => { await post(`/admin/net/zones/${id}/records`, { ...rf, ttl: Number(rf.ttl) }); setRf({ ...EMPTY_REC, type: rf.type }); z.reload(); }}>
          <h3>Новая запись</h3>
          <div className="grid grid-2">
            <Input label="Имя" value={rf.name} onChange={(e) => setRf({ ...rf, name: e.target.value })} placeholder="@ или www" />
            <Select label="Тип" value={rf.type} onChange={(e) => setRf({ ...rf, type: e.target.value })} options={types.map((x) => ({ value: x, label: x }))} />
          </div>
          <Input label="Данные" value={rf.data} onChange={(e) => setRf({ ...rf, data: e.target.value })} placeholder={hint} />
          <Input label="TTL (игровые секунды)" type="number" min="0" value={rf.ttl} onChange={(e) => setRf({ ...rf, ttl: e.target.value })} hint={humanTtl(rf.ttl)} />
        </Form>
      </div>
      {edit && (
        <Modal title="Изменить запись" onClose={() => setEdit(null)}>
          <Form onSubmit={async () => { await patch(`/admin/net/records/${edit.id}`, { name: edit.name, type: edit.type, ttl: Number(edit.ttl), data: edit.data }); setEdit(null); z.reload(); }}>
            <Input label="Имя" value={edit.name} onChange={(e) => setEdit({ ...edit, name: e.target.value })} disabled={edit.type === 'SOA'} />
            <Input label="Данные" value={edit.data} onChange={(e) => setEdit({ ...edit, data: e.target.value })} />
            <Input label="TTL (игровые секунды)" type="number" min="0" value={edit.ttl} onChange={(e) => setEdit({ ...edit, ttl: e.target.value })} hint={humanTtl(edit.ttl)} />
          </Form>
        </Modal>
      )}
    </div>
  );
}
