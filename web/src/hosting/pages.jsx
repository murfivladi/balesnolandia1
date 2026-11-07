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
                  <div className="li-sub">{o.kind === 'virtual' ? <Badge kind="ok">серверный код</Badge> : <Badge>статика</Badge>} {o.disk_mb} МБ · до {o.max_sites} сайтов{o.kind === 'virtual' ? ` · ${o.rpm} запр./мин · CPU ${o.cpu_ms} мс · WebSocket ${o.ws_limit} · cron от ${o.cron_min} игр. мин` : ''} · сервер {o.server} ({o.ip})</div>
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
        <h1>{a.hoster} · «{a.plan}» {a.kind === 'virtual' && <Badge kind="ok">виртуальный</Badge>}</h1>
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
            {a.ssh && <><dt>SSH</dt><dd><span className="mono">ssh {a.ssh.user}@{a.ssh.host}</span> {a.ssh.enabled ? <Badge kind="ok">включён</Badge> : <Badge>нет пароля</Badge>}</dd></>}
            {a.kind === 'virtual' && a.limits && <><dt>Лимиты</dt><dd>{a.limits.rpm} запросов в минуту · CPU {a.limits.cpu_ms} мс на запрос · {a.limits.ws_limit} WebSocket · cron не чаще раза в {a.limits.cron_min} игр. мин</dd></>}
          </dl>
          <div className="meter" style={{ marginTop: 10 }} role="meter" aria-valuemin={0} aria-valuemax={a.disk_mb} aria-valuenow={Number((a.used_bytes / 1048576).toFixed(2))} aria-label="Занято места">
            <span style={{ width: `${Math.min(100, (a.used_bytes / (a.disk_mb * 1048576)) * 100)}%` }} />
          </div>
          {a.status !== 'reserved' && <SshPassword id={id} enabled={a.ssh?.enabled} onChange={reload} />}
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
                <div className="li-main">
                  <button className="link-btn mono" onClick={() => setSiteId(s.id)}>{s.cert?.status === 'valid' ? '🔒 ' : ''}{s.host}</button>
                </div>
                <a className="btn sm secondary" href={`../#${s.cert ? 'https' : 'http'}://${s.host}/`} target="_top">Открыть</a>
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
      {site && <SslCard key={`ssl${site.id}`} accountId={id} site={site} active={a.status === 'active'} onChange={reload} />}
      {site && a.kind === 'virtual' && <ServerCard key={`srv${site.id}`} accountId={id} site={site} canWrite={a.status === 'active'} />}
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
  const [plan, setPlan] = useState({ name: '', disk_mb: 50, max_sites: 5, price_month: 1000, server_id: '', kind: 'static', rpm: 300, cpu_ms: 100, ws_limit: 20, cron_min: 60 });
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
            <div className="li-main"><div className="li-title">«{p.name}» {p.kind === 'virtual' && <Badge kind="ok">виртуальный</Badge>}</div><div className="li-sub">{p.disk_mb} МБ · до {p.max_sites} сайтов{p.kind === 'virtual' ? ` · ${p.rpm} запр./мин · CPU ${p.cpu_ms} мс · WS ${p.ws_limit} · cron ${p.cron_min} мин` : ''}</div></div>
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
            <Select label="Вид" value={plan.kind} onChange={(e) => setPlan({ ...plan, kind: e.target.value })} options={[{ value: 'static', label: 'Статический (файлы)' }, { value: 'virtual', label: 'Виртуальный (серверный код, SQLite)' }]} />
            <Input label="Запросов в минуту" type="number" min="10" value={plan.rpm} onChange={(e) => setPlan({ ...plan, rpm: Number(e.target.value) })} />
            {plan.kind === 'virtual' && (
              <>
                <Input label="CPU-мс на запрос" type="number" min="10" max="2000" value={plan.cpu_ms} onChange={(e) => setPlan({ ...plan, cpu_ms: Number(e.target.value) })} />
                <Input label="Соединений WebSocket" type="number" min="0" value={plan.ws_limit} onChange={(e) => setPlan({ ...plan, ws_limit: Number(e.target.value) })} />
                <Input label="Шаг cron, игр. мин" type="number" min="1" value={plan.cron_min} onChange={(e) => setPlan({ ...plan, cron_min: Number(e.target.value) })} />
              </>
            )}
          </div>
          <MoneyInput label="Цена в игровой месяц (с НДС)" value={plan.price_month} onChange={(v) => setPlan({ ...plan, price_month: v })} />
        </Form>
      )}
    </div>
  );
}

/** Пароль SSH: вход из терминала ВлодБраузера (меню → Терминал → ssh u<номер>@<сервер>). */
function SshPassword({ id, enabled, onChange }) {
  const [pw, setPw] = useState('');
  const [open, setOpen] = useState(false);
  if (!open) return <p className="small" style={{ marginTop: 10 }}><button className="link-btn" onClick={() => setOpen(true)}>{enabled ? 'Сменить пароль SSH' : 'Включить доступ по SSH'}</button></p>;
  return (
    <Form submitLabel="Сохранить пароль" onSubmit={async () => { await post(`/gov/hosting/${id}/ssh`, { password: pw }); setPw(''); setOpen(false); onChange(); }}>
      <Input label="Пароль SSH" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} hint="Не короче 8 символов. Пустой — отключить SSH." />
    </Form>
  );
}

/** Серверный код сайта на виртуальном тарифе: журнал, база SQLite, key-value, cron. */
function ServerCard({ accountId, site, canWrite }) {
  const [tab, setTab] = useState('logs');
  const base = `/gov/hosting/${accountId}/sites/${site.id}`;
  const logs = useAsync(() => (tab === 'logs' ? get(`${base}/logs`) : Promise.resolve(null)), [tab, base]);
  const kv = useAsync(() => (tab === 'kv' || tab === 'cron' ? get(`${base}/kv`) : Promise.resolve(null)), [tab, base]);
  const [sql, setSql] = useState("SELECT name FROM sqlite_master WHERE type = 'table'");
  const [res, setRes] = useState(null);
  const toast = useToast();
  const LV = { error: 'err-text', warn: 'err-text', info: 'ok-text' };
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head">
        <h2>Серверный код — {site.host}</h2>
        {canWrite && <ActionButton size="sm" kind="secondary" okMessage="Созданы server.js и crontab — откройте сайт" action={() => post(`${base}/example`)}>Пример: гостевая книга</ActionButton>}
        <a className="btn sm ghost" href="#/docs">Справка по API</a>
      </div>
      <p className="small muted"><span className="mono">server.js</span> (JavaScript), <span className="mono">server.py</span> (Python) или файлы <span className="mono">.php</span> отвечают на запросы, которым не нашлось файла, и на все POST/PUT/DELETE. Их код, <span className="mono">crontab</span> и папка <span className="mono">.data</span> посетителям не видны.</p>
      <div className="tabs" role="tablist">
        {[['logs', 'Журнал'], ['sql', 'База SQLite'], ['kv', 'Key-value'], ['cron', 'Cron']].map(([k, l]) => <button key={k} role="tab" className={tab === k ? 'active' : ''} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {tab === 'logs' && (
        <div className="stack-sm">
          <div className="row"><Button size="sm" kind="secondary" onClick={logs.reload}>Обновить</Button><ActionButton size="sm" kind="ghost" action={async () => { await del(`${base}/logs`); logs.reload(); }}>Очистить</ActionButton></div>
          {!logs.data ? <Spinner /> : !logs.data.logs.length ? <p className="muted small">Журнал пуст. console.log в server.js пишет сюда, ошибки — тоже.</p> : (
            <pre className="mono small" style={{ whiteSpace: 'pre-wrap', maxHeight: 360, overflow: 'auto', margin: 0, background: 'var(--surface-2)', padding: 10, borderRadius: 8 }}>
              {logs.data.logs.slice().reverse().map((l, i) => <div key={i} className={LV[l.level] || ''}>{new Date(l.t).toLocaleTimeString('ru-RU')} [{l.level}] {l.text}</div>)}
            </pre>
          )}
        </div>
      )}
      {tab === 'sql' && (
        <div className="stack-sm">
          <textarea className="input mono" rows={4} value={sql} onChange={(e) => setSql(e.target.value)} aria-label="SQL" />
          <div className="row"><Button size="sm" disabled={!canWrite} onClick={async () => { try { setRes(await post(`${base}/sql`, { sql })); } catch (e) { toast(e.message, 'err'); } }}>Выполнить</Button><span className="small muted">Настоящий SQLite. Несколько команд — через «;».</span></div>
          {res && (
            <>
              <p className="small">Таблицы: <span className="mono">{res.tables.join(', ')}</span></p>
              {res.result.map((r, i) => (
                <div key={i} className="table-wrap"><table className="table"><thead><tr>{r.columns.map((c) => <th key={c}>{c}</th>)}</tr></thead>
                  <tbody>{r.rows.map((row, j) => <tr key={j}>{row.map((v, k) => <td key={k} className="mono small">{v === null ? 'NULL' : String(v)}</td>)}</tr>)}</tbody></table></div>
              ))}
              {!res.result.length && <p className="small ok-text">Выполнено.</p>}
            </>
          )}
        </div>
      )}
      {tab === 'kv' && (!kv.data ? <Spinner /> : !kv.data.keys.length ? <p className="muted small">Ключей нет. В server.js: kv.set('ключ', значение, {'{'} ttl: 3600 {'}'}).</p> : (
        <div className="table-wrap"><table className="table"><thead><tr><th>Ключ</th><th>Значение (JSON)</th><th>Истекает</th></tr></thead>
          <tbody>{kv.data.keys.map((k) => <tr key={k.key}><td className="mono">{k.key}</td><td className="mono small">{k.value}</td><td className="small">{k.exp ? gameDay(k.exp) : '—'}</td></tr>)}</tbody></table></div>
      ))}
      {tab === 'cron' && (!kv.data ? <Spinner /> : !kv.data.crontab ? <p className="muted small">Файла crontab нет. Создайте его в корне сайта: «0 9 * * * утро» — каждый игровой день в 9:00 вызовет onCron({'{'} name: 'утро' {'}'}).</p> : (
        <div className="stack-sm">
          {kv.data.crontab.errors.map((e) => <p key={e} className="err-text small">{e}</p>)}
          <ul className="small">{kv.data.crontab.jobs.map((j) => <li key={j.line}>строка {j.line}: <b>{j.name}</b></li>)}</ul>
          <p className="small muted">Время игровое: сейчас {gameDay(kv.data.now)}. Задачи проверяются каждые несколько секунд.</p>
        </div>
      ))}
    </div>
  );
}

const gameDay = (sec) => `день ${Math.floor((Number(sec) % 2592000) / 86400) + 1}, месяц ${Math.floor(Number(sec) / 2592000)}`;

/** SSL сайта: бесплатный сертификат БалСерта в один клик (HTTP-01 панель делает сама) или свой сертификат. */
function SslCard({ accountId, site, active, onChange }) {
  const [res, setRes] = useState(null);
  const [certId, setCertId] = useState('');
  const mine = useAsync(() => get('/gov/certs'), [site.id]);
  const base = `/gov/hosting/${accountId}/sites/${site.id}`;
  const c = site.cert;
  const own = (mine.data?.certs || []).filter((x) => x.status === 'valid');
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>HTTPS для {site.host}</h2>
      {c ? (
        <p>
          {c.status === 'valid' ? '🔒' : '⚠'} Установлен сертификат {c.policy} на <span className="mono">{c.names.join(', ')}</span>
          {' '}— {c.status === 'revoked' ? <b className="err-text">отозван</b> : <>до {gameDay(c.na)}</>}
          {c.auto_renew ? ' · продлевается автоматически' : ''}. <a href={`../ca/#/certs/${c.id}`}>Подробнее на БалСерте</a>
        </p>
      ) : <p className="muted">Сертификата нет: сайт открывается только по http, и ВлодБраузер пишет «Не защищено».</p>}
      <div className="row">
        {active && <ActionButton kind="primary" action={async () => { const r = await post(`${base}/ssl`); setRes(r); if (r.ok) onChange(); }}>{c ? 'Перевыпустить бесплатный SSL' : 'Бесплатный SSL (БалСерт DV)'}</ActionButton>}
        {own.length > 0 && (
          <>
            <select className="input" value={certId} onChange={(e) => setCertId(e.target.value)} aria-label="Свой сертификат">
              <option value="">— свой сертификат —</option>
              {own.map((x) => <option key={x.id} value={x.id}>{x.policy} · {x.names.join(', ')} · {x.issuer}</option>)}
            </select>
            <ActionButton disabled={!certId} action={async () => { await put(`${base}/cert`, { cert_id: Number(certId) }); onChange(); }}>Установить</ActionButton>
          </>
        )}
        {c && <ActionButton kind="ghost" confirm="Снять сертификат? Сайт снова будет только по http." action={async () => { await put(`${base}/cert`, { cert_id: null }); onChange(); }}>Снять</ActionButton>}
      </div>
      {res && !res.ok && (
        <div className="form-warn" style={{ marginTop: 8 }}>
          Не получилось подтвердить домен:
          <ul>{res.results.filter((r) => !r.ok).map((r, i) => <li key={i}>{r.error}</li>)}</ul>
          Проверьте, что A-запись {site.host} указывает на этот сервер и записи CAA разрешают «ca.gov.bln».
        </div>
      )}
      {res?.ok && <p className="ok-text">✔ Выпущен и установлен сертификат на {res.names.join(', ')}.</p>}
      <p className="small muted">Бесплатный SSL: панель сама кладёт файл проверки в <span className="mono">/.well-known/</span>, БалСерт заходит на сайт по http и выпускает сертификат. За месяц до конца срока продлевается сам. OV и EV — на <a href="../ca/#/order">ca.gov.bln</a>.</p>
    </div>
  );
}
