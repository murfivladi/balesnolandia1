// БалСерт (ca.gov.bln) — государственный удостоверяющий центр БалНета: сертификаты HTTPS (DV, OV, EV),
// проверка домена DNS-01 и HTTP-01, мои сертификаты (отзыв, ключ, установка на сайт), журнал прозрачности,
// список центров сертификации и свой УЦ для организаций с лицензией.
import { useState } from 'react';
import { get, post, put, patch, appUrl } from '../shared/api.js';
import { useLang } from '../shared/i18n.js';
import { useRoute, pick, navigate } from '../shared/router.js';
import {
  Topbar, NavLink, Spinner, useAsync, Empty, ErrorBox, Money, Badge, Button, ActionButton, Input, Select, Field, useToast, MoneyInput,
} from '../shared/ui.jsx';
import { CaLogo } from '../shared/brand.jsx';
import { SiteFooter, Hero, Section, Features, RequireGov, useGovUser } from '../shared/site.jsx';

const BRAND = 'БалСерт';
const POLICY = { DV: 'DV — проверка домена', OV: 'OV — проверка организации', EV: 'EV — расширенная проверка', self: 'Самоподписанный' };
const STATUS = { valid: ['ok', 'действует'], expired: ['warn', 'истёк'], revoked: ['err', 'отозван'] };

/** Игровые секунды → «день 12, месяц 3». */
export function gameDate(sec) {
  const s = Number(sec) || 0;
  return `день ${Math.floor((s % 2592000) / 86400) + 1}, месяц ${Math.floor(s / 2592000)}`;
}

export default function App() {
  useLang();
  const route = useRoute();
  const me = useGovUser();
  const nav = (
    <>
      <NavLink href="#/" path={route.path}>Сертификаты</NavLink>
      <NavLink href="#/order" path={route.path}>Заказать</NavLink>
      <NavLink href="#/certs" path={route.path}>Мои</NavLink>
      <NavLink href="#/ct" path={route.path}>Журнал CT</NavLink>
      <NavLink href="#/cas" path={route.path}>Центры</NavLink>
    </>
  );
  const right = me
    ? <a className="tb-btn" href="#/certs" title={me.email}>{me.display_name || 'Кабинет'}</a>
    : <a className="tb-btn" href="#/certs">Войти</a>;
  const gate = (render) => <RequireGov app="ca" siteName="ca.gov.bln">{render}</RequireGov>;
  return (
    <>
      <Topbar variant="site" brand={<><CaLogo /> <span>{BRAND}</span></>} nav={nav} right={right} />
      <main style={{ flex: 1 }}>
        {pick([
          ['/', () => <Home />],
          ['/order', () => gate(() => <Order query={route.query} />)],
          ['/certs', () => gate(() => <MyCerts />)],
          ['/certs/:id', (p) => gate(() => <CertPage id={p.id} />)],
          ['/ct', () => <CtSearch q={route.query.q || ''} />],
          ['/cas', () => <Cas />],
          ['/docs', () => <Docs />],
          ['*', () => <Empty>Страница не найдена</Empty>],
        ], route.path)}
      </main>
      <SiteFooter
        brand={BRAND}
        about="Государственный удостоверяющий центр БалНета. Сертификаты выпускаются автоматически после проверки домена, записываются в публичный журнал прозрачности и проверяются ВлодБраузером."
        columns={[
          { title: 'Сертификаты', links: [{ href: '#/order', label: 'Заказать' }, { href: '#/certs', label: 'Мои сертификаты' }, { href: '#/docs', label: 'Как это работает' }] },
          { title: 'Прозрачность', links: [{ href: '#/ct', label: 'Журнал CT' }, { href: '#/cas', label: 'Центры сертификации' }] },
          { title: 'Сервисы БалНета', links: [{ href: '../reg/#/', label: 'БалРег — домены' }, { href: '../hosting/#/', label: 'БалХост — хостинг' }, { href: '../nalog/#/', label: 'Лицензии' }] },
        ]}
      />
    </>
  );
}

function Home() {
  const cas = useAsync(() => get('/gov/certs/cas'), []);
  const gov = cas.data?.cas.find((c) => !c.org_id);
  return (
    <>
      <Hero
        kicker="ca.gov.bln · удостоверяющий центр"
        title="Замок 🔒 в адресной строке — для вашего сайта"
        lead="Сертификат доказывает посетителю, что он на настоящем сайте, и шифрует всё, что он вводит. DV — бесплатно и за минуту."
        art="🔐"
      >
        <a className="btn light" href="#/order">Получить сертификат</a>
        <a className="btn ghost light" href="#/docs">Как это работает</a>
      </Hero>
      <Section title="Виды сертификатов" lead="Цены БалСерта за сертификат. Срок DV — 3 игровых месяца с автопродлением в БалХосте, OV и EV — 12.">
        {!cas.data ? (cas.error ? <ErrorBox error={cas.error} /> : <Spinner />) : (
          <div className="plans">
            {[
              ['DV', 'Проверка домена', ['Доказывает, что сайт ваш', 'Проверка по DNS или файлу на сайте', 'Можно на *.домен', 'Выпуск за минуту']],
              ['OV', 'Проверка организации', ['Название организации в сертификате', 'Проверка по госреестру', 'Для магазинов и сервисов']],
              ['EV', 'Расширенная проверка', ['Организация, ИНН и юрисдикция', 'Заказывает только директор', 'Для банков и госсайтов']],
            ].map(([k, title, items]) => (
              <div key={k} className={`plan${k === 'DV' ? ' featured' : ''}`}>
                {k === 'DV' && <span className="plan-badge">Бесплатно</span>}
                <div className="small muted">{k}</div>
                <h3 style={{ margin: 0 }}>{title}</h3>
                <div className="price">{gov?.prices[k] ? <Money value={gov.prices[k]} /> : '0 В'}</div>
                <ul>{items.map((i) => <li key={i}>{i}</li>)}</ul>
                <a className="btn" href={`#/order?policy=${k}`}>Заказать</a>
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section muted title="Честно и проверяемо">
        <Features items={[
          { icon: '📜', title: 'Журнал прозрачности', text: 'Каждый выпущенный сертификат публично записан. Найдите все сертификаты своего домена в журнале CT.' },
          { icon: '🧾', title: 'CAA', text: 'Запись CAA в DNS запрещает чужим центрам выпускать сертификаты на ваш домен.' },
          { icon: '🚫', title: 'Отзыв', text: 'Украли ключ — отзовите сертификат. ВлодБраузер узнает об этом из ответа OCSP.' },
          { icon: '🔏', title: 'Настоящая криптография', text: 'ECDSA P-256 и SHA-256. Браузер сам проверяет подписи всей цепочки до корня.' },
        ]} />
      </Section>
      <Section title="Как получить">
        <ol className="steps">
          <li><b>Сайт</b> — на <a href="../hosting/#/">БалХосте</a> кнопка «Бесплатный SSL» сделает всё сама.</li>
          <li><b>Или вручную</b> — укажите имена и подтвердите домен: запись TXT или файл на сайте.</li>
          <li><b>Выпуск</b> — DV сразу, OV и EV — после оплаты квитанции во ВлодБанке.</li>
          <li><b>Установка</b> — в «Моих сертификатах» выберите сайт хостинга.</li>
        </ol>
      </Section>
    </>
  );
}

function PayLink({ invoice, amount }) {
  return (
    <div className="form-warn row" style={{ justifyContent: 'space-between' }}>
      <span>Квитанция <span className="mono">{invoice}</span>{amount ? <> на <Money value={amount} /></> : null}</span>
      <a className="btn sm" href={appUrl('bank', `/pay/${invoice}`)}>Оплатить во ВлодБанке</a>
    </div>
  );
}

function Results({ results }) {
  if (!results?.length) return null;
  return (
    <ul className="plain stack-sm" style={{ margin: '8px 0' }}>
      {results.map((r, i) => (
        <li key={i} className={r.ok ? 'ok-text' : 'err-text'}>{r.ok ? '✔' : '✖'} <span className="mono">{r.name}</span>{r.error ? ` — ${r.error}` : ' — подтверждено'}</li>
      ))}
    </ul>
  );
}

// ——— Заказ ———

function Order({ query }) {
  const [names, setNames] = useState(query.names || '');
  const [method, setMethod] = useState('dns');
  const [ch, setCh] = useState(null);
  const [check, setCheck] = useState(null);
  const [caId, setCaId] = useState('');
  const [policy, setPolicy] = useState(query.policy || 'DV');
  const [owner, setOwner] = useState('');
  const [res, setRes] = useState(null);
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const cas = useAsync(() => get('/gov/certs/cas'), []);
  const orgs = useAsync(() => get('/gov/orgs'), []);
  const toast = useToast();
  const list = (cas.data?.cas || []).filter((c) => c.status === 'active');
  const ca = list.find((c) => String(c.id) === caId) || list.find((c) => !c.org_id);
  const price = ca?.prices?.[policy] || 0;

  const start = async (e) => {
    e.preventDefault();
    setErr(null); setRes(null); setCheck(null);
    try { setCh(await post('/gov/certs/challenges', { names, method })); } catch (ex) { setErr(ex); }
  };
  const verify = async () => {
    setBusy(true);
    try { setCheck(await post(`/gov/certs/challenges/${ch.id}/check`, { ca_id: ca?.id })); } catch (ex) { toast(ex.message, 'err'); }
    setBusy(false);
  };
  const order = async () => {
    setBusy(true);
    try {
      const r = await post('/gov/certs/orders', { challenge_id: ch.id, ca_id: ca?.id, policy, owner_org_id: owner || undefined });
      setRes(r);
      if (r.cert_id) { toast('Сертификат выпущен', 'ok'); navigate(`/certs/${r.cert_id}`); }
    } catch (ex) { toast(ex.message, 'err'); }
    setBusy(false);
  };

  return (
    <div className="page narrow">
      <h1>Заказ сертификата</h1>
      <ol className="steps">
        <li className={ch ? 'done' : ''}><b>Имена и способ проверки</b></li>
        <li className={check?.ok ? 'done' : ''}><b>Подтверждение домена</b></li>
        <li><b>Центр, вид и выпуск</b></li>
      </ol>
      {!ch ? (
        <form className="card stack" onSubmit={start}>
          <Field label="Имена в сертификате" hint="Через пробел или запятую, до 10. Например: boris.bln www.boris.bln или *.boris.bln">
            <textarea className="input mono" rows={2} value={names} onChange={(e) => setNames(e.target.value)} required />
          </Field>
          <Select
            label="Как подтвердить, что домен ваш"
            value={method}
            onChange={(e) => setMethod(e.target.value)}
            options={[{ value: 'dns', label: 'DNS-01 — запись TXT в зоне домена (подходит для *.)' }, { value: 'http', label: 'HTTP-01 — файл на сайте' }]}
          />
          {err && <ErrorBox error={err} />}
          <Button kind="primary" type="submit">Дальше</Button>
        </form>
      ) : (
        <div className="stack">
          <div className="card">
            <h2>Подтвердите домен</h2>
            {ch.method === 'dns' ? (
              <>
                <p>Добавьте в зону домена (на <a href="../reg/#/cabinet">БалРеге</a> → DNS-записи) запись:</p>
                <table className="table"><thead><tr><th>Имя</th><th>Тип</th><th>Значение</th></tr></thead>
                  <tbody>{ch.steps.map((s) => <tr key={s.record}><td className="mono">{s.record}</td><td>TXT</td><td className="mono">{s.value}</td></tr>)}</tbody>
                </table>
              </>
            ) : (
              <>
                <p>Положите на сайт (в БалХосте → файлы) файл с этим содержимым — БалСерт сам откроет адрес:</p>
                <table className="table"><thead><tr><th>Файл</th><th>Содержимое</th></tr></thead>
                  <tbody>{ch.steps.map((s) => <tr key={s.url}><td className="mono small">{s.url}</td><td className="mono">{s.value}</td></tr>)}</tbody>
                </table>
              </>
            )}
            <p className="small muted">Ещё БалСерт проверит записи CAA: если они есть, в них должен быть разрешён выбранный центр.</p>
            <div className="row">
              <Button busy={busy} onClick={verify}>Проверить</Button>
              <Button kind="ghost" onClick={() => { setCh(null); setCheck(null); }}>Изменить имена</Button>
            </div>
            <Results results={check?.results} />
          </div>
          <div className="card stack">
            <h2>Выпуск</h2>
            <Select
              label="Центр сертификации"
              value={String(ca?.id || '')}
              onChange={(e) => setCaId(e.target.value)}
              options={list.map((c) => ({ value: String(c.id), label: `${c.name} (${c.org_name})${c.trusted ? '' : ' — нет в браузерах!'}` }))}
            />
            <Select
              label="Вид"
              value={policy}
              onChange={(e) => setPolicy(e.target.value)}
              options={['DV', 'OV', 'EV'].map((k) => ({ value: k, label: `${POLICY[k]} — ${ca?.prices?.[k] ? `${(ca.prices[k] / 100).toLocaleString('ru')} В` : 'бесплатно'}` }))}
            />
            <Select
              label={policy === 'DV' ? 'Владелец' : 'Организация (из госреестра)'}
              value={owner}
              onChange={(e) => setOwner(e.target.value)}
              options={[...(policy === 'DV' ? [{ value: '', label: 'Я сам' }] : [{ value: '', label: '— выберите —' }]), ...(orgs.data?.orgs || []).map((o) => ({ value: String(o.id), label: `${o.kind_title} «${o.name}»` }))]}
            />
            {res?.ok === false && <Results results={res.results} />}
            {res?.invoice && <PayLink invoice={res.invoice} amount={res.amount} />}
            {!res?.invoice && <Button kind="primary" busy={busy} onClick={order}>{price ? <>Заказать за <Money value={price} /></> : 'Выпустить бесплатно'}</Button>}
            {res?.invoice && <p className="small muted">После оплаты сертификат появится в «<a href="#/certs">Моих сертификатах</a>».</p>}
          </div>
        </div>
      )}
    </div>
  );
}

// ——— Мои сертификаты ———

function MyCerts() {
  const { data, error, reload } = useAsync(() => get('/gov/certs'), []);
  const [selfNames, setSelfNames] = useState('');
  if (!data) return error ? <div className="page"><ErrorBox error={error} /></div> : <Spinner />;
  return (
    <div className="page">
      <div className="page-head">
        <h1>Мои сертификаты</h1>
        <a className="btn" href="#/order">Заказать</a>
      </div>
      {!data.certs.length ? <Empty>Сертификатов пока нет. Самый простой путь — кнопка «Бесплатный SSL» у сайта в БалХосте.</Empty> : (
        <div className="table-wrap">
          <table className="table">
            <thead><tr><th>Имена</th><th>Вид</th><th>Издатель</th><th>До</th><th>Статус</th><th>Сайты</th></tr></thead>
            <tbody>
              {data.certs.map((c) => (
                <tr key={c.id} onClick={() => navigate(`/certs/${c.id}`)} style={{ cursor: 'pointer' }}>
                  <td className="mono small">{c.names.join(', ')}</td>
                  <td>{c.policy}</td>
                  <td>{c.issuer}</td>
                  <td className="small">{gameDate(c.na)}</td>
                  <td><Badge kind={STATUS[c.status][0]}>{STATUS[c.status][1]}</Badge>{c.auto_renew && <span className="small muted"> · автопродление</span>}</td>
                  <td className="mono small">{c.sites.map((s) => s.host).join(', ') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="card" style={{ marginTop: 16 }}>
        <h2>Самоподписанный сертификат</h2>
        <p className="small muted">Без проверки и без журнала — для тестов. ВлодБраузер покажет посетителям «Ваше подключение не защищено».</p>
        <div className="row">
          <input className="input mono" placeholder="test.boris.bln" value={selfNames} onChange={(e) => setSelfNames(e.target.value)} />
          <ActionButton action={async () => { const r = await post('/gov/certs/self', { names: selfNames }); setSelfNames(''); await reload(); navigate(`/certs/${r.cert_id}`); }}>Создать</ActionButton>
        </div>
      </div>
      <OrgCa myCas={data.my_cas} reload={reload} />
    </div>
  );
}

function CertPage({ id }) {
  const { data, error, reload } = useAsync(() => get(`/gov/certs/${id}`), [id]);
  const hosting = useAsync(() => get('/gov/hosting'), []);
  const [files, setFiles] = useState(null);
  const [reason, setReason] = useState('superseded');
  const [site, setSite] = useState('');
  if (!data) return error ? <div className="page"><ErrorBox error={error} /></div> : <Spinner />;
  const c = data.cert;
  const sites = (hosting.data?.accounts || []).flatMap((a) => (a.sites || []).map((s) => ({ ...s, account_id: a.id })));
  const t = c.cert.tbs;
  return (
    <div className="page">
      <div className="page-head">
        <h1 className="mono">{c.names[0]}</h1>
        <Badge kind={STATUS[c.status][0]}>{STATUS[c.status][1]}</Badge>
        <span className="muted">{POLICY[c.policy]}</span>
      </div>
      <div className="grid grid-2">
        <div className="card">
          <h2>Сертификат</h2>
          <dl className="kv">
            <dt>Имена</dt><dd className="mono small">{c.names.join(', ')}</dd>
            <dt>Кому выдан</dt><dd>{[t.subject.cn, t.subject.o, t.subject.inn && `ИНН ${t.subject.inn}`].filter(Boolean).join(', ')}</dd>
            <dt>Издатель</dt><dd>{c.issuer}</dd>
            <dt>Действует</dt><dd>{gameDate(c.nb)} — {gameDate(c.na)}{c.status === 'valid' ? ` (осталось ${c.days_left} игр. дн.)` : ''}</dd>
            <dt>Серийный номер</dt><dd className="mono small">{c.serial}</dd>
            {c.ct_index !== null && <><dt>Журнал CT</dt><dd><a href={`#/ct?q=${encodeURIComponent(c.names[0].replace(/^\*\./, ''))}`}>запись № {c.ct_index}</a></dd></>}
            {c.revoked_reason && <><dt>Причина отзыва</dt><dd>{c.revoked_reason}</dd></>}
            <dt>Автопродление</dt><dd>{c.auto_renew ? 'да (БалХост)' : 'нет'}</dd>
          </dl>
          <div className="row" style={{ marginTop: 8 }}>
            <ActionButton kind="ghost" size="sm" action={async () => setFiles(await get(`/gov/certs/${id}/files`))}>Ключ и сертификат</ActionButton>
          </div>
          {files && (
            <div className="stack-sm" style={{ marginTop: 8 }}>
              <div className="form-warn small">Закрытый ключ — секрет. Кто его знает, может выдавать себя за ваш сайт: тогда сертификат нужно отозвать.</div>
              <textarea className="input mono small" rows={5} readOnly value={files.key} />
              <textarea className="input mono small" rows={6} readOnly value={files.cert} />
            </div>
          )}
        </div>
        <div className="stack">
          <div className="card">
            <h2>Установлен на сайтах</h2>
            {c.sites.length ? <ul className="plain">{c.sites.map((s) => <li key={s.id} className="mono">{s.host}</li>)}</ul> : <p className="muted">Нигде.</p>}
            {c.status !== 'revoked' && sites.length > 0 && (
              <div className="row">
                <select className="input" value={site} onChange={(e) => setSite(e.target.value)}>
                  <option value="">— сайт в БалХосте —</option>
                  {sites.map((s) => <option key={s.id} value={`${s.account_id}/${s.id}`}>{s.host}</option>)}
                </select>
                <ActionButton disabled={!site} okMessage="Сертификат установлен" action={async () => { const [a, s] = site.split('/'); await put(`/gov/hosting/${a}/sites/${s}/cert`, { cert_id: c.id }); reload(); }}>Установить</ActionButton>
              </div>
            )}
            {sites.length > 0 && !c.names.some((n) => sites.some((s) => s.host === n || (n.startsWith('*.') && s.host.endsWith(n.slice(1))))) && <p className="small muted">Ни один ваш сайт не подходит под имена сертификата — браузер покажет ошибку имени.</p>}
          </div>
          {c.status === 'valid' && c.policy !== 'self' && (
            <div className="card">
              <h2>Отозвать</h2>
              <p className="small muted">Отзыв нельзя отменить. Браузеры перестанут открывать сайт с этим сертификатом.</p>
              <div className="row">
                <select className="input" value={reason} onChange={(e) => setReason(e.target.value)}>
                  <option value="superseded">Заменён новым</option>
                  <option value="keyCompromise">Ключ скомпрометирован</option>
                  <option value="cessationOfOperation">Сайт закрыт</option>
                  <option value="affiliationChanged">Сменился владелец</option>
                  <option value="unspecified">Без причины</option>
                </select>
                <ActionButton kind="danger" confirm="Отозвать сертификат навсегда?" okMessage="Сертификат отозван" action={async () => { await post(`/gov/certs/${id}/revoke`, { reason }); reload(); }}>Отозвать</ActionButton>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ——— УЦ организации ———

function OrgCa({ myCas, reload }) {
  const orgs = useAsync(() => get('/gov/orgs'), []);
  const [form, setForm] = useState({ org_id: '', name: '', identifier: '' });
  const directors = (orgs.data?.orgs || []).filter((o) => o.role === 'director');
  if (!directors.length && !myCas.length) return null;
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Свой удостоверяющий центр</h2>
      <p className="small muted">Организация с лицензией «Удостоверяющий центр» (<a href="../nalog/#/">Налоговая служба</a>) создаёт корень и выпускающий центр со своими ценами. Браузеры начнут доверять корню, когда Координационный центр включит его в хранилище доверия.</p>
      {myCas.map((ca) => <CaPrices key={ca.id} ca={ca} reload={reload} />)}
      {!myCas.length && (
        <div className="grid grid-3">
          <Select label="Организация" value={form.org_id} onChange={(e) => setForm({ ...form, org_id: e.target.value })} options={[{ value: '', label: '—' }, ...directors.map((o) => ({ value: String(o.id), label: o.name }))]} />
          <Input label="Название центра" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="БорисСерт" />
          <Input label="Идентификатор для CAA" value={form.identifier} onChange={(e) => setForm({ ...form, identifier: e.target.value })} placeholder="ca.boris.bln" />
          <ActionButton okMessage="Центр создан" action={async () => { await post('/gov/certs/org-ca', { ...form, org_id: Number(form.org_id) }); reload(); }}>Создать центр</ActionButton>
        </div>
      )}
    </div>
  );
}

function CaPrices({ ca, reload }) {
  const [p, setP] = useState(ca.prices || { DV: 0, OV: 0, EV: 0 });
  return (
    <div className="stack-sm">
      <p><b>{ca.name}</b> · CAA: <span className="mono">{ca.identifier}</span> · {ca.trusted ? <Badge kind="ok">в браузерах</Badge> : <Badge kind="warn">ждёт включения в браузеры</Badge>}</p>
      <div className="grid grid-3">
        {['DV', 'OV', 'EV'].map((k) => <MoneyInput key={k} label={`Цена ${k}`} value={p[k]} onChange={(v) => setP({ ...p, [k]: v || 0 })} />)}
      </div>
      <ActionButton size="sm" okMessage="Цены сохранены" action={async () => { await patch(`/gov/certs/org-ca/${ca.id}`, { prices: p }); reload(); }}>Сохранить цены</ActionButton>
    </div>
  );
}

// ——— Журнал прозрачности и список центров ———

function CtSearch({ q }) {
  const [text, setText] = useState(q);
  const res = useAsync(() => (q ? get(`/gov/certs/ct?q=${encodeURIComponent(q)}`) : Promise.resolve(null)), [q]);
  return (
    <div className="page">
      <h1>Журнал прозрачности</h1>
      <p className="muted">Все сертификаты от центров БалНета публично записаны в журнал «Аргон». Владелец домена может проверить, не выпустил ли кто-то сертификат на его имя.</p>
      <form className="row" onSubmit={(e) => { e.preventDefault(); navigate(`/ct?q=${encodeURIComponent(text.trim())}`); }}>
        <input className="input mono" placeholder="boris.bln" value={text} onChange={(e) => setText(e.target.value)} />
        <Button type="submit">Искать</Button>
      </form>
      {q && (!res.data ? (res.error ? <ErrorBox error={res.error} /> : <Spinner />) : !res.data.entries.length ? <Empty>Записей с «{q}» нет.</Empty> : (
        <div className="table-wrap" style={{ marginTop: 16 }}>
          <table className="table">
            <thead><tr><th>№</th><th>Записан</th><th>Имена</th><th>Издатель</th><th>Вид</th><th>Действует до</th><th>Статус</th></tr></thead>
            <tbody>
              {res.data.entries.map((e) => (
                <tr key={e.index}>
                  <td>{e.index}</td>
                  <td className="small">{gameDate(e.ts)}</td>
                  <td className="mono small">{e.names.join(', ')}</td>
                  <td>{e.issuer}</td>
                  <td>{e.policy}</td>
                  <td className="small">{gameDate(e.na)}</td>
                  <td>{e.revoked ? <Badge kind="err">отозван</Badge> : <Badge kind="ok">—</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </div>
  );
}

function Cas() {
  const { data, error } = useAsync(() => get('/gov/certs/cas'), []);
  if (!data) return error ? <div className="page"><ErrorBox error={error} /></div> : <Spinner />;
  return (
    <div className="page">
      <h1>Центры сертификации БалНета</h1>
      <p className="muted">ВлодБраузер доверяет только корням из своего хранилища. Список ведёт Координационный центр БалНета.</p>
      <div className="table-wrap">
        <table className="table">
          <thead><tr><th>Центр</th><th>Организация</th><th>CAA</th><th>DV</th><th>OV</th><th>EV</th><th>Выпущено</th><th>Доверие</th></tr></thead>
          <tbody>
            {data.cas.map((c) => (
              <tr key={c.id}>
                <td><b>{c.name}</b></td>
                <td>{c.org_name}</td>
                <td className="mono small">{c.identifier}</td>
                {['DV', 'OV', 'EV'].map((k) => <td key={k}>{c.prices[k] ? <Money value={c.prices[k]} /> : '0'}</td>)}
                <td>{c.issued}</td>
                <td>{c.status !== 'active' ? <Badge kind="err">отозван</Badge> : c.trusted ? <Badge kind="ok">в браузерах</Badge> : <Badge kind="warn">нет</Badge>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function Docs() {
  return (
    <div className="page narrow prose">
      <h1>Как работает HTTPS в БалНете</h1>
      <h2>Сертификат и цепочка</h2>
      <p>Сертификат связывает имя сайта с открытым ключом сервера и подписан центром сертификации. Цепочка: сертификат сайта → «БалСерт» → «Корневой УЦ БалНета». Корень встроен во ВлодБраузер, и браузер проверяет каждую подпись сам (ECDSA P-256).</p>
      <h2>Проверка домена</h2>
      <p><b>DNS-01</b> — запись TXT <span className="mono">_balnet-challenge.ваш-домен</span>; подходит для сертификатов на <span className="mono">*.домен</span>. <b>HTTP-01</b> — файл <span className="mono">/.well-known/balnet-challenge/токен</span> на сайте. Центр проверяет со своего сервера, без кэша DNS.</p>
      <h2>CAA</h2>
      <p>Запись <span className="mono">0 issue "ca.gov.bln"</span> разрешает выпуск только БалСерту, <span className="mono">0 issuewild ";"</span> запрещает сертификаты на <span className="mono">*.</span>. Записи ищутся от имени вверх до первой найденной.</p>
      <h2>Журнал прозрачности и отзыв</h2>
      <p>Сертификат без подписанной отметки журнала (SCT) браузер не примет. Отозванный сертификат сервер «скрепляет» с ответом OCSP, подписанным центром, — и браузер показывает ERR_CERT_REVOKED.</p>
      <h2>Ошибки браузера</h2>
      <ul>
        <li><b>ERR_CERT_COMMON_NAME_INVALID</b> — сертификат выдан на другое имя.</li>
        <li><b>ERR_CERT_DATE_INVALID</b> — срок истёк (продлите или включите автопродление).</li>
        <li><b>ERR_CERT_AUTHORITY_INVALID</b> — самоподписанный или центр не в браузерах.</li>
        <li><b>ERR_CERT_REVOKED</b> — отозван.</li>
      </ul>
      <h2>DNSSEC</h2>
      <p>Подпись DNS-зоны защищает сами записи (A, TXT, CAA) от подмены. Включается на БалРеге в карточке домена: регистратор публикует запись DS в зоне TLD, и резолверы проверяют подписи до корня.</p>
    </div>
  );
}
