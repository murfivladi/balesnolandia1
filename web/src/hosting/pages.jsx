// БалХост (hosting.bln): тарифы, кабинет, сайты, файловый менеджер, кабинет партнёра-хостера.
import { useRef, useState } from 'react';
import { get, post, put, patch, del, appUrl } from '../shared/api.js';
import { useLang } from '../shared/i18n.js';
import {
  Spinner, useAsync, Input, Select, Form, Money, MoneyInput, Badge, ActionButton, ErrorBox, Button, Modal, useToast,
} from '../shared/ui.jsx';
import { gameDateLabel } from '@bln/shared/time.js';

const STATUS_KIND = { active: 'ok', reserved: 'warn', suspended: 'err' };
const mb = (bytes) => `${(Number(bytes) / 1048576).toFixed(Number(bytes) < 10485760 ? 2 : 1)} МБ`;
const fsize = (b) => (b < 1024 ? `${b} Б` : b < 1048576 ? `${(b / 1024).toFixed(1)} КБ` : mb(b));

function PayLink({ invoice, amount }) {
  return (
    <div className="form-warn row" style={{ justifyContent: 'space-between' }}>
      <span>Квитанция <span className="mono">{invoice}</span>{amount ? <> на <Money value={amount} /></> : null}</span>
      <a className="btn sm" href={appUrl('bank', `/pay/${invoice}`)}>Оплатить во ВлодБанке</a>
    </div>
  );
}

const readAsBase64 = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result).split(',')[1] || '');
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

export function HostingPage({ initialPlan = null }) {
  const lang = useLang();
  const { data, error, reload } = useAsync(() => get('/gov/hosting'), []);
  const orgs = useAsync(() => get('/gov/orgs'), []);
  const [pick, setPick] = useState(initialPlan);
  const [months, setMonths] = useState(1);
  const [owner, setOwner] = useState('');
  const [order, setOrder] = useState(null);
  if (!data) return error ? <div className="page"><ErrorBox error={error} /></div> : <Spinner />;
  return (
    <div className="page">
      <div className="page-head">
        <h1>Мой хостинг</h1>
        <span className="muted small">Игровая дата: {gameDateLabel(data.month, lang)}</span>
      </div>
      <p className="muted">Хостинг — место на сервере для файлов сайта (HTML, CSS, JS, картинки). Купите тариф, подключите к нему домен, поставьте в DNS домена A-запись на адрес сервера — и сайт откроется во ВлодБраузере.</p>
      <div className="grid grid-2">
        <div className="card">
          <h2>Мои хостинги</h2>
          {!data.accounts.length ? <p className="muted">Пока нет.</p> : (
            <div className="list">
              {data.accounts.map((a) => (
                <a key={a.id} href={`#/cabinet/${a.id}`} className="list-item" style={{ color: 'inherit' }}>
                  <div className="li-main">
                    <div className="li-title">{a.hoster} · «{a.plan}»</div>
                    <div className="li-sub">{a.sites.map((s) => s.host).join(', ') || 'сайтов нет'} · до {gameDateLabel(a.paid_until_month, lang)}</div>
                  </div>
                  <Badge kind={STATUS_KIND[a.status]}>{a.status_title}</Badge>
                </a>
              ))}
            </div>
          )}
        </div>
        <div className="card">
          <h2>Тарифы</h2>
          <div className="list">
            {data.offers.map((o) => (
              <label key={o.id} className="list-item" style={{ cursor: 'pointer' }}>
                <input type="radio" name="plan" checked={pick === o.id} onChange={() => { setPick(o.id); setOrder(null); }} />
                <div className="li-main">
                  <div className="li-title">{o.hoster} · «{o.name}»</div>
                  <div className="li-sub">{o.disk_mb} МБ · до {o.max_sites} сайтов · сервер {o.server} ({o.ip})</div>
                </div>
                <b><Money value={o.price_month} /></b><span className="small muted">/мес</span>
              </label>
            ))}
          </div>
          {pick && !order && (
            <Form submitLabel="Купить" onSubmit={async () => { setOrder(await post('/gov/hosting', { plan_id: pick, months, owner_org_id: owner ? Number(owner) : null })); reload(); }}>
              <Select label="Срок" value={months} onChange={(e) => setMonths(Number(e.target.value))} options={Array.from({ length: data.max_months }, (_, i) => ({ value: i + 1, label: `${i + 1} игр. мес.` }))} />
              {(orgs.data?.orgs || []).length > 0 && (
                <Select label="Владелец" value={owner} onChange={(e) => setOwner(e.target.value)} options={[{ value: '', label: 'Я сам' }, ...orgs.data.orgs.map((o) => ({ value: String(o.id), label: o.name }))]} />
              )}
            </Form>
          )}
          {order && (order.invoice ? <PayLink invoice={order.invoice} amount={order.amount} /> : <div className="form-ok">Хостинг работает. <a href={`#/cabinet/${order.account_id}`}>Открыть</a></div>)}
        </div>
      </div>
    </div>
  );
}

export function HostingAccountPage({ id }) {
  const lang = useLang();
  const { data, error, reload } = useAsync(() => get(`/gov/hosting/${id}`), [id]);
  const [host, setHost] = useState('');
  const [months, setMonths] = useState(1);
  const [order, setOrder] = useState(null);
  const [siteId, setSiteId] = useState(null);
  const toast = useToast();
  if (!data) return error ? <div className="page"><ErrorBox error={error} /></div> : <Spinner />;
  const a = data.account;
  const site = a.sites.find((s) => s.id === siteId) || a.sites[0];
  return (
    <div className="page">
      <div className="page-head">
        <h1>{a.hoster} · «{a.plan}»</h1>
        <Badge kind={STATUS_KIND[a.status]}>{a.status_title}</Badge>
      </div>
      {a.pending_order && <PayLink invoice={a.pending_order.invoice} amount={a.pending_order.amount} />}
      {a.status === 'suspended' && <div className="form-warn" style={{ marginTop: 12 }}>Хостинг не оплачен: сайты показывают «Сайт приостановлен». Продлите, иначе через льготный месяц файлы будут удалены.</div>}
      <div className="grid grid-2" style={{ marginTop: 16 }}>
        <div className="card">
          <dl className="kv">
            <dt>Сервер</dt><dd className="mono">{a.server} · {a.server_ip}</dd>
            <dt>Место</dt><dd>{mb(a.used_bytes)} из {a.disk_mb} МБ</dd>
            <dt>Оплачен до</dt><dd>{gameDateLabel(a.paid_until_month, lang)}</dd>
            <dt>Цена</dt><dd><Money value={a.price_month} /> в игровой месяц</dd>
          </dl>
          <div className="meter" style={{ marginTop: 10 }} role="meter" aria-valuemin={0} aria-valuemax={a.disk_mb} aria-valuenow={Number((a.used_bytes / 1048576).toFixed(2))} aria-label="Занято места">
            <span style={{ width: `${Math.min(100, (a.used_bytes / (a.disk_mb * 1048576)) * 100)}%` }} />
          </div>
          {order ? <PayLink invoice={order.invoice} amount={order.amount} /> : (a.status !== 'reserved' && (
            <Form submitLabel={`Продлить — ${((a.price_month * months) / 100).toLocaleString('ru-RU')} В`} onSubmit={async () => { setOrder(await post(`/gov/hosting/${id}/renew`, { months })); reload(); }}>
              <Select label="Продлить на" value={months} onChange={(e) => setMonths(Number(e.target.value))} options={Array.from({ length: 12 }, (_, i) => ({ value: i + 1, label: `${i + 1} игр. мес.` }))} />
            </Form>
          ))}
        </div>
        <div className="card">
          <h2>Сайты ({a.sites.length} из {a.max_sites})</h2>
          <div className="list">
            {a.sites.map((s) => (
              <div key={s.id} className="list-item">
                <div className="li-main"><button className="link-btn mono" onClick={() => setSiteId(s.id)}>{s.host}</button></div>
                <a className="btn sm secondary" href={`../#http://${s.host}/`} target="_top">Открыть</a>
                <ActionButton size="sm" kind="ghost" confirm={`Удалить сайт ${s.host} вместе с файлами?`} action={async () => { await del(`/gov/hosting/${id}/sites/${s.id}`); reload(); }}>✕</ActionButton>
              </div>
            ))}
          </div>
          {a.status === 'active' && (
            <Form submitLabel="Подключить" onSubmit={async () => { const r = await post(`/gov/hosting/${id}/sites`, { host }); setHost(''); toast(`Сайт добавлен. Поставьте A-запись ${r.host} → ${r.ip}`, 'ok'); reload(); }}>
              <Input label="Имя сайта" value={host} onChange={(e) => setHost(e.target.value)} placeholder="boris.bln или www.boris.bln" />
            </Form>
          )}
          <p className="small muted">Чтобы сайт открывался, в DNS домена нужна A-запись на <span className="mono">{a.server_ip}</span> — её можно поставить на сайте регистратора <a href="../reg/#/domains">reg.bln</a>.</p>
        </div>
      </div>
      {site && <FileManager key={site.id} accountId={id} site={site} canWrite={a.status === 'active'} onChange={reload} />}
    </div>
  );
}

const TEMPLATE = `<!doctype html>
<html lang="ru">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Мой сайт в БалНете</title>
  <link rel="stylesheet" href="style.css">
</head>
<body>
  <h1>Привет из БалНета!</h1>
  <p>Этот сайт лежит на хостинге и открывается во ВлодБраузере.</p>
</body>
</html>
`;

function FileManager({ accountId, site, canWrite, onChange }) {
  const [path, setPath] = useState('');
  const base = `/gov/hosting/${accountId}/sites/${site.id}`;
  const list = useAsync(() => get(`${base}/files?path=${encodeURIComponent(path)}`), [path, site.id]);
  const [file, setFile] = useState(null);
  const [text, setText] = useState('');
  const [newName, setNewName] = useState('');
  const upload = useRef(null);
  const zipInput = useRef(null);
  const toast = useToast();
  const join = (name) => (path ? `${path}/${name}` : name);
  const refresh = () => { list.reload(); onChange(); };
  const open = async (name) => {
    const f = await get(`${base}/file?path=${encodeURIComponent(join(name))}`);
    setFile(f);
    setText(f.text ? f.content : '');
  };
  const crumbs = path ? path.split('/') : [];
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>Файлы сайта <span className="mono">{site.host}</span></h2>
        {canWrite && (
          <div className="row">
            <Button size="sm" kind="secondary" onClick={() => upload.current?.click()}>Загрузить файлы</Button>
            <Button size="sm" kind="secondary" onClick={() => zipInput.current?.click()}>Загрузить ZIP</Button>
          </div>
        )}
      </div>
      <input ref={upload} type="file" multiple hidden onChange={async (e) => {
        const files = [...e.target.files];
        e.target.value = '';
        try {
          for (const f of files) await put(`${base}/file`, { path: join(f.name), content: await readAsBase64(f), binary: true });
          toast(`Загружено файлов: ${files.length}`, 'ok');
        } catch (err) { toast(err.message, 'err'); }
        refresh();
      }} />
      <input ref={zipInput} type="file" accept=".zip,application/zip" hidden onChange={async (e) => {
        const f = e.target.files[0];
        e.target.value = '';
        if (!f) return;
        try {
          const r = await post(`${base}/zip`, { data: await readAsBase64(f), path });
          toast(`Распаковано файлов: ${r.files.length}`, 'ok');
        } catch (err) { toast(err.message, 'err'); }
        refresh();
      }} />
      <nav className="row small" style={{ margin: '10px 0' }} aria-label="Путь">
        <button className="link-btn" onClick={() => setPath('')}>{site.host}</button>
        {crumbs.map((c, i) => (
          <span key={i}>/ <button className="link-btn" onClick={() => setPath(crumbs.slice(0, i + 1).join('/'))}>{c}</button></span>
        ))}
      </nav>
      <ErrorBox error={list.error} />
      {!list.data ? <Spinner /> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Имя</th><th>Размер</th><th /></tr></thead>
            <tbody>
              {path && <tr><td colSpan={3}><button className="link-btn" onClick={() => setPath(crumbs.slice(0, -1).join('/'))}>↑ на уровень выше</button></td></tr>}
              {list.data.entries.map((e) => (
                <tr key={e.name}>
                  <td>
                    {e.dir
                      ? <button className="link-btn" onClick={() => setPath(join(e.name))}>📁 {e.name}</button>
                      : <button className="link-btn mono" onClick={() => open(e.name)}>{e.name}</button>}
                  </td>
                  <td className="small muted">{e.dir ? '' : fsize(e.size)}</td>
                  <td className="nowrap">
                    {canWrite && <ActionButton size="sm" kind="ghost" action={async () => {
                      const to = prompt('Новое имя', e.name);
                      if (to && to !== e.name) { await post(`${base}/rename`, { from: join(e.name), to: join(to) }); refresh(); }
                    }}>✎</ActionButton>}
                    <ActionButton size="sm" kind="ghost" confirm={`Удалить ${e.name}?`} action={async () => { await del(`${base}/file?path=${encodeURIComponent(join(e.name))}`); refresh(); }}>✕</ActionButton>
                  </td>
                </tr>
              ))}
              {!list.data.entries.length && <tr><td colSpan={3} className="muted">Папка пуста. {canWrite && !path && 'Создайте index.html — это главная страница сайта.'}</td></tr>}
            </tbody>
          </table>
        </div>
      )}
      {canWrite && (
        <form className="row" style={{ marginTop: 12 }} onSubmit={(e) => e.preventDefault()}>
          <input className="input" style={{ maxWidth: 220 }} value={newName} onChange={(e) => setNewName(e.target.value)} placeholder="index.html" aria-label="Имя нового файла или папки" />
          <Button size="sm" type="button" onClick={() => {
            const name = newName.trim() || 'index.html';
            setFile({ path: join(name), text: true, size: 0, isNew: true });
            setText(name.endsWith('.html') ? TEMPLATE : '');
            setNewName('');
          }}>Новый файл</Button>
          <ActionButton size="sm" kind="secondary" action={async () => { if (!newName.trim()) return; await post(`${base}/mkdir`, { path: join(newName.trim()) }); setNewName(''); refresh(); }}>Новая папка</ActionButton>
        </form>
      )}
      {file && (
        <Modal title={file.path} wide onClose={() => setFile(null)} footer={file.text && canWrite ? (
          <ActionButton okMessage="Сохранено" action={async () => { await put(`${base}/file`, { path: file.path, content: text }); setFile(null); refresh(); }}>Сохранить</ActionButton>
        ) : null}>
          {file.text
            ? <textarea className="input mono code-editor" value={text} onChange={(e) => setText(e.target.value)} readOnly={!canWrite} spellCheck={false} aria-label="Содержимое файла" />
            : <p className="muted">Двоичный файл, {fsize(file.size)}. Редактировать его здесь нельзя — загрузите новую версию.</p>}
        </Modal>
      )}
    </div>
  );
}

/** Кабинет организации → Хостинг: лицензия, аренда серверов, тарифы. */
export function OrgHosting({ orgId, director, kind }) {
  const { data, error, reload } = useAsync(() => get(`/gov/orgs/${orgId}/hosting`), [orgId]);
  const [plan, setPlan] = useState({ name: '', disk_mb: 50, max_sites: 5, price_month: 1000, server_id: '' });
  const toast = useToast();
  if (!data) return error ? <ErrorBox error={error} /> : null;
  if (!data.licensed) {
    if (!director || kind === 'gov') return null;
    return (
      <div className="card">
        <h2>Хостинг-провайдер</h2>
        <p className="small muted">С лицензией организация арендует серверы в дата-центре БалНета (<Money value={data.rent} /> в игровой месяц за {data.disk_mb} МБ) и продаёт игрокам свои тарифы.</p>
        <ActionButton kind="secondary" okMessage="Заявление подано: оплатите пошлину, затем его рассмотрит чиновник" action={async () => { await post(`/gov/orgs/${orgId}/licenses`, { kind: 'hosting' }); reload(); }}>Получить лицензию хостинг-провайдера</ActionButton>
      </div>
    );
  }
  return (
    <div className="card">
      <h2>Хостинг: серверы и тарифы</h2>
      <div className="list">
        {data.servers.map((s) => (
          <div key={s.id} className="list-item">
            <div className="li-main">
              <div className="li-title mono">{s.name} · {s.ip}</div>
              <div className="li-sub">продано {s.sold_mb} из {s.disk_mb} МБ · клиентов {s.accounts} · аренда <Money value={s.rent_price} />/мес</div>
            </div>
            <Badge kind={s.status === 'active' ? 'ok' : 'err'}>{s.status === 'active' ? 'работает' : 'выключен за неуплату'}</Badge>
          </div>
        ))}
      </div>
      {director && (
        <ActionButton kind="secondary" confirm={`Арендовать сервер? Аренда ${(data.rent / 100).toLocaleString('ru-RU')} В спишется со счёта организации сразу и далее каждый игровой месяц.`} action={async () => { const r = await post(`/gov/orgs/${orgId}/servers`); toast(`Сервер ${r.ip} арендован`, 'ok'); reload(); }}>Арендовать сервер</ActionButton>
      )}
      <h3>Тарифы</h3>
      <div className="list">
        {data.plans.map((p) => (
          <div key={p.id} className="list-item">
            <div className="li-main"><div className="li-title">«{p.name}»</div><div className="li-sub">{p.disk_mb} МБ · до {p.max_sites} сайтов</div></div>
            <Money value={p.price_month} />
            {director && <ActionButton size="sm" kind="ghost" action={async () => { await patch(`/gov/orgs/${orgId}/plans/${p.id}`, { active: !p.active }); reload(); }}>{p.active ? 'Снять с продажи' : 'Продавать'}</ActionButton>}
          </div>
        ))}
      </div>
      {director && data.servers.length > 0 && (
        <Form submitLabel="Создать тариф" onSubmit={async () => { await post(`/gov/orgs/${orgId}/plans`, { ...plan, server_id: Number(plan.server_id || data.servers[0].id) }); toast('Тариф создан', 'ok'); reload(); }}>
          <div className="grid grid-2">
            <Input label="Название" value={plan.name} onChange={(e) => setPlan({ ...plan, name: e.target.value })} placeholder="Профи" />
            <Select label="Сервер" value={plan.server_id} onChange={(e) => setPlan({ ...plan, server_id: e.target.value })} options={data.servers.map((s) => ({ value: String(s.id), label: s.ip }))} />
            <Input label="Место, МБ" type="number" min="1" value={plan.disk_mb} onChange={(e) => setPlan({ ...plan, disk_mb: Number(e.target.value) })} />
            <Input label="Сайтов" type="number" min="1" value={plan.max_sites} onChange={(e) => setPlan({ ...plan, max_sites: Number(e.target.value) })} />
          </div>
          <MoneyInput label="Цена в игровой месяц (с НДС)" value={plan.price_month} onChange={(v) => setPlan({ ...plan, price_month: v })} />
        </Form>
      )}
    </div>
  );
}
