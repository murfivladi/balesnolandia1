// БалРег (reg.bln) — Госрегистратор доменов БалНета: витрина, поиск, кабинет, партнёрам.
import { useState } from 'react';
import { get, put } from '../shared/api.js';
import { useLang } from '../shared/i18n.js';
import { useRoute, pick, navigate } from '../shared/router.js';
import { Topbar, NavLink, Spinner, useAsync, Empty, ErrorBox, Money, MoneyInput, ActionButton, Form, useToast } from '../shared/ui.jsx';
import { RegLogo } from '../shared/brand.jsx';
import { SiteFooter, Hero, Section, Features, RequireGov, GovLogin, useGovUser } from '../shared/site.jsx';
import { DomainsPage, DomainPage, DomainSearch } from './domains.jsx';

const BRAND = 'БалРег';

export default function App() {
  useLang();
  const route = useRoute();
  const me = useGovUser();
  const nav = (
    <>
      <NavLink href="#/" path={route.path}>Регистрация доменов</NavLink>
      <NavLink href="#/domains" path={route.path}>Мои домены</NavLink>
      <NavLink href="#/partners" path={route.path}>Партнёрам</NavLink>
    </>
  );
  const right = me
    ? <a className="tb-btn" href="#/domains" title={me.email}>{me.display_name || 'Кабинет'}</a>
    : <a className="tb-btn" href="#/domains">Войти</a>;
  return (
    <>
      <Topbar variant="site" brand={<><RegLogo /> <span>{BRAND}</span></>} nav={nav} right={right} />
      <main style={{ flex: 1 }}>
        {pick([
          ['/', () => <Home />],
          ['/search/:name', (p) => <SearchPage name={decodeURIComponent(p.name)} />],
          ['/domains', () => <RequireGov app="reg" siteName="reg.bln">{() => <DomainsPage />}</RequireGov>],
          ['/domains/:id', (p) => <RequireGov app="reg" siteName="reg.bln">{() => <DomainPage id={p.id} />}</RequireGov>],
          ['/partners', () => <RequireGov app="reg" siteName="reg.bln">{() => <Partners />}</RequireGov>],
          ['*', () => <Empty>Страница не найдена</Empty>],
        ], route.path)}
      </main>
      <SiteFooter
        brand={BRAND}
        about="Госрегистратор доменов БалНета. Регистрация в зонах .bln, .vlod, .shop, .com, бесплатный DNS-хостинг и защита данных в WHOIS."
        columns={[
          { title: 'Домены', links: [{ href: '#/', label: 'Проверить домен' }, { href: '#/domains', label: 'Мои домены' }, { href: '#/domains', label: 'Аукционы' }] },
          { title: 'Партнёрам', links: [{ href: '#/partners', label: 'Регистраторам' }, { href: '../nalog/#/', label: 'Получить лицензию' }] },
          { title: 'Сервисы БалНета', links: [{ href: '../hosting/#/', label: 'БалХост — хостинг' }, { href: '../services/#/', label: 'ВлодУслуги' }, { href: '../bank/#/', label: 'ВлодБанк' }] },
        ]}
      />
    </>
  );
}

function SearchForm({ initial = '', big = true }) {
  const [q, setQ] = useState(initial);
  return (
    <form className={big ? 'hero-search' : 'row nowrap'} onSubmit={(e) => {
      e.preventDefault();
      const name = q.trim().toLowerCase();
      if (name) navigate(`/search/${encodeURIComponent(name.includes('.') ? name : `${name}.bln`)}`);
    }} role="search">
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Придумайте имя: например, moy-sait" aria-label="Имя домена" className={big ? undefined : 'input'} />
      <button className="btn" type="submit">Проверить</button>
    </form>
  );
}

function Home() {
  const zones = useAsync(() => get('/gov/domains/zones'), []);
  return (
    <>
      <Hero
        kicker="Госрегистратор БалНета"
        title="Ваше имя в БалНете — за минуту"
        lead="Проверьте свободное имя, зарегистрируйте домен и сразу получите бесплатный DNS. Сайт подключите на БалХосте."
        art="🌐"
      >
        <SearchForm />
        <div className="hero-chips">
          {(zones.data?.zones || []).filter((z) => !z.restricted).map((z) => <span key={z.name}>.{z.name} от {(z.min_price / 100).toLocaleString('ru-RU')} В</span>)}
        </div>
      </Hero>
      <Section title="Цены на домены" lead="За год регистрации (12 игровых месяцев), с НДС. Регистраторы-партнёры могут продавать дешевле.">
        {!zones.data ? <Spinner /> : (
          <div className="zone-prices">
            {zones.data.zones.map((z) => (
              <div key={z.name} className="zone-price">
                <b>.{z.name}</b>
                {z.restricted ? <span className="small muted">для госучреждений</span> : <><Money value={z.price} /><div className="small muted">в год</div></>}
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section muted title="Почему БалРег">
        <Features items={[
          { icon: '⚡', title: 'Работает сразу', text: 'После оплаты квитанции домен делегируется на наши серверы имён ns1/ns2.dns.bln.' },
          { icon: '🛠', title: 'Бесплатный DNS', text: 'Записи A, AAAA, CNAME, MX, TXT, SRV, CAA в удобном редакторе. Или свои серверы имён.' },
          { icon: '🕶', title: 'Защита данных', text: 'Скройте имя владельца в WHOIS одним переключателем.' },
          { icon: '🔁', title: 'Передача и аукцион', text: 'Передайте домен по коду авторизации, ловите освободившиеся имена на аукционе.' },
        ]} />
      </Section>
      <Section title="Как запустить сайт">
        <ol className="steps">
          <li><b>Домен.</b> Найдите и зарегистрируйте имя на этой странице.</li>
          <li><b>Хостинг.</b> Купите тариф на <a href="../hosting/#/">БалХосте</a> и подключите к нему домен.</li>
          <li><b>DNS.</b> В разделе «Мои домены» поставьте A-запись на адрес сервера хостинга.</li>
          <li><b>Готово.</b> Откройте имя во ВлодБраузере.</li>
        </ol>
      </Section>
    </>
  );
}

function SearchPage({ name }) {
  const me = useGovUser();
  const check = useAsync(() => get(`/gov/domains/check?name=${encodeURIComponent(name)}`), [name]);
  const cab = useAsync(() => (me ? get('/gov/domains') : Promise.resolve(null)), [me]);
  return (
    <>
      <Hero compact title={`Проверка: ${name}`}>
        <SearchForm key={name} initial={name.replace(/\.bln$/, '')} />
      </Hero>
      <div className="page medium">
        <ErrorBox error={check.error} />
        {!check.data && !check.error && <Spinner />}
        {check.data && !check.data.free && <div className="card"><h2>{check.data.name} занят</h2><p className="muted">{check.data.reason}</p></div>}
        {check.data?.free && me === null && (
          <div className="card">
            <h2 className="ok">{check.data.name} свободен</h2>
            <div className="list">
              {check.data.offers.map((o) => <div key={o.name} className="list-item"><div className="li-main">{o.name}</div><b><Money value={o.price} /></b><span className="small muted">/год</span></div>)}
            </div>
            <GovLogin app="reg" siteName="reg.bln" hash={`#/search/${encodeURIComponent(name)}`} />
          </div>
        )}
        {check.data?.free && me && (cab.data ? <DomainSearch data={cab.data} initial={name} onDone={() => {}} /> : <Spinner />)}
      </div>
    </>
  );
}

/** Кабинет регистратора-партнёра: цены по зонам и оптовые цены своих зон. */
function Partners() {
  const orgs = useAsync(() => get('/gov/orgs'), []);
  if (!orgs.data) return orgs.error ? <div className="page"><ErrorBox error={orgs.error} /></div> : <Spinner />;
  const mine = orgs.data.orgs.filter((o) => o.role === 'director');
  return (
    <div className="page">
      <h1>Регистраторам</h1>
      <p className="muted">Организация с лицензией регистратора продаёт домены по своим ценам. Деньги приходят на счёт организации: цена минус НДС и оптовая цена реестра.</p>
      {!mine.length && <div className="card"><p>Вы не директор ни одной организации. Зарегистрируйте ООО или АО в <a href="../nalog/#/">Налоговой службе</a>.</p></div>}
      {mine.map((o) => <PartnerOrg key={o.id} id={o.id} />)}
    </div>
  );
}

function PartnerOrg({ id }) {
  const { data, error, reload } = useAsync(() => get(`/gov/orgs/${id}`), [id]);
  const [prices, setPrices] = useState({});
  const toast = useToast();
  if (!data) return error ? <ErrorBox error={error} /> : <Spinner />;
  const o = data.org;
  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>{o.kind_title} «{o.name}»</h2>
        <span className="small muted">Счёт: <Money value={o.account?.balance || 0} /></span>
      </div>
      {!data.is_registrar && (
        <p style={{ marginTop: 12 }}>Лицензии регистратора нет. <a href={`../nalog/#/orgs/${o.id}`}>Получить её в Налоговой службе</a>.</p>
      )}
      {data.is_registrar && (
        <div className="table-wrap" style={{ marginTop: 12 }}>
          <table className="table">
            <thead><tr><th>Зона</th><th>Опт</th><th>Мин. цена</th><th>Ваша цена</th><th /></tr></thead>
            <tbody>
              {data.registrar_tlds.map((t) => (
                <tr key={t.id}>
                  <td className="mono">.{t.name}</td>
                  <td><Money value={t.wholesale} /></td>
                  <td><Money value={t.min_price} /></td>
                  <td style={{ minWidth: 140 }}><MoneyInput value={prices[t.id] ?? t.price ?? t.min_price} onChange={(v) => setPrices({ ...prices, [t.id]: v })} /></td>
                  <td className="nowrap">
                    <ActionButton size="sm" okMessage="Цена сохранена" action={async () => { await put(`/gov/orgs/${o.id}/prices`, { tld_id: t.id, price: prices[t.id] ?? t.price ?? t.min_price }); reload(); }}>{t.price == null ? 'Продавать' : 'Сохранить'}</ActionButton>
                    {t.price != null && <ActionButton size="sm" kind="ghost" action={async () => { await put(`/gov/orgs/${o.id}/prices`, { tld_id: t.id, price: null }); reload(); }}>Снять</ActionButton>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {data.sold_domains.length > 0 && <p className="small">Доменов на обслуживании: {data.sold_domains.length}</p>}
        </div>
      )}
      {data.registry.map((t) => (
        <Form key={t.id} submitLabel={`Сохранить опт .${t.name}`} onSubmit={async () => { await put(`/gov/orgs/${o.id}/registry/${t.id}`, { wholesale_price: prices[`r${t.id}`] ?? t.wholesale_price }); toast('Оптовая цена сохранена', 'ok'); reload(); }}>
          <h3>Реестр зоны .{t.name}</h3>
          <MoneyInput label="Оптовая цена за год" value={prices[`r${t.id}`] ?? t.wholesale_price} onChange={(v) => setPrices({ ...prices, [`r${t.id}`]: v })} />
        </Form>
      ))}
    </div>
  );
}
