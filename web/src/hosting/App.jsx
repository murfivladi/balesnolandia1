// БалХост (hosting.bln) — Госхостинг БалНета: тарифы всех хостеров, кабинет, файлы сайтов, кабинет партнёра.
import { get } from '../shared/api.js';
import { useLang } from '../shared/i18n.js';
import { useRoute, pick } from '../shared/router.js';
import { Topbar, NavLink, Spinner, useAsync, Empty, ErrorBox, Money } from '../shared/ui.jsx';
import { HostLogo } from '../shared/brand.jsx';
import { SiteFooter, Hero, Section, Features, RequireGov, useGovUser } from '../shared/site.jsx';
import { HostingPage, HostingAccountPage, OrgHosting } from './pages.jsx';

const BRAND = 'БалХост';

export default function App() {
  useLang();
  const route = useRoute();
  const me = useGovUser();
  const nav = (
    <>
      <NavLink href="#/" path={route.path}>Тарифы</NavLink>
      <NavLink href="#/cabinet" path={route.path}>Мой хостинг</NavLink>
      <NavLink href="#/partners" path={route.path}>Хостерам</NavLink>
    </>
  );
  const right = me
    ? <a className="tb-btn" href="#/cabinet" title={me.email}>{me.display_name || 'Кабинет'}</a>
    : <a className="tb-btn" href="#/cabinet">Войти</a>;
  const gate = (render) => <RequireGov app="hosting" siteName="hosting.bln">{render}</RequireGov>;
  return (
    <>
      <Topbar variant="site" brand={<><HostLogo /> <span>{BRAND}</span></>} nav={nav} right={right} />
      <main style={{ flex: 1 }}>
        {pick([
          ['/', () => <Home />],
          ['/cabinet', () => gate(() => <HostingPage initialPlan={Number(route.query.plan) || null} />)],
          ['/cabinet/:id', (p) => gate(() => <HostingAccountPage id={p.id} />)],
          ['/partners', () => gate(() => <Partners />)],
          ['*', () => <Empty>Страница не найдена</Empty>],
        ], route.path)}
      </main>
      <SiteFooter
        brand={BRAND}
        about="Госхостинг БалНета: место для HTML, CSS, JS и картинок вашего сайта, файловый менеджер и загрузка ZIP. Плюс тарифы хостеров-партнёров."
        columns={[
          { title: 'Хостинг', links: [{ href: '#/', label: 'Тарифы' }, { href: '#/cabinet', label: 'Мой хостинг' }] },
          { title: 'Партнёрам', links: [{ href: '#/partners', label: 'Стать хостером' }, { href: '../nalog/#/', label: 'Лицензии' }] },
          { title: 'Сервисы БалНета', links: [{ href: '../reg/#/', label: 'БалРег — домены' }, { href: '../services/#/', label: 'ВлодУслуги' }, { href: '../bank/#/', label: 'ВлодБанк' }] },
        ]}
      />
    </>
  );
}

function Home() {
  const plans = useAsync(() => get('/gov/hosting/plans'), []);
  const offers = plans.data?.offers || [];
  const best = offers.length > 1 ? offers[1].id : offers[0]?.id;
  return (
    <>
      <Hero
        kicker="Хостинг для сайтов БалНета"
        title="Сайт в БалНете — без своего сервера"
        lead="Загрузите HTML, CSS и картинки, подключите домен — и сайт открывается во ВлодБраузере у всех жителей Федерации."
        art="🗄"
      >
        <a className="btn light" href="#/cabinet">Выбрать тариф</a>
      </Hero>
      <Section title="Тарифы" lead="Цена за игровой месяц, с НДС. Оплата квитанцией вперёд на 1–12 месяцев.">
        {!plans.data ? (plans.error ? <ErrorBox error={plans.error} /> : <Spinner />) : (
          <div className="plans">
            {offers.map((o) => (
              <div key={o.id} className={`plan${o.id === best ? ' featured' : ''}`}>
                {o.id === best && <span className="plan-badge">Популярный</span>}
                <div className="small muted">{o.hoster}</div>
                <h3 style={{ margin: 0 }}>«{o.name}»</h3>
                <div className="price"><Money value={o.price_month} /> <small>/ мес</small></div>
                <ul>
                  <li>{o.disk_mb} МБ на диске</li>
                  <li>до {o.max_sites} сайтов</li>
                  <li>файловый менеджер и ZIP</li>
                  <li>сервер {o.ip}</li>
                </ul>
                <a className="btn" href={`#/cabinet?plan=${o.id}`}>Заказать</a>
              </div>
            ))}
          </div>
        )}
      </Section>
      <Section muted title="Всё для статического сайта">
        <Features items={[
          { icon: '📁', title: 'Файловый менеджер', text: 'Папки, редактор кода, загрузка файлов и целых архивов ZIP.' },
          { icon: '🛡', title: 'Песочница', text: 'Код сайта выполняется изолированно: он не видит ни браузер, ни ВлодБанк посетителя.' },
          { icon: '🍪', title: 'Cookies и localStorage', text: 'Работают как в настоящем браузере — у каждого сайта свои.' },
          { icon: '🔗', title: 'CORS через _headers', text: 'Разрешите другим сайтам читать ваши данные строкой Access-Control-Allow-Origin.' },
        ]} />
      </Section>
      <Section title="Как запустить сайт">
        <ol className="steps">
          <li><b>Домен</b> — зарегистрируйте на <a href="../reg/#/">БалРеге</a>.</li>
          <li><b>Тариф</b> — выберите выше и оплатите квитанцию во ВлодБанке.</li>
          <li><b>Сайт</b> — в «Моём хостинге» подключите домен и загрузите файлы, начните с index.html.</li>
          <li><b>DNS</b> — поставьте A-запись домена на адрес сервера из карточки тарифа.</li>
        </ol>
      </Section>
    </>
  );
}

function Partners() {
  const orgs = useAsync(() => get('/gov/orgs'), []);
  if (!orgs.data) return orgs.error ? <div className="page"><ErrorBox error={orgs.error} /></div> : <Spinner />;
  const mine = orgs.data.orgs.filter((o) => o.role === 'director');
  return (
    <div className="page">
      <h1>Хостерам</h1>
      <p className="muted">Организация с лицензией хостинг-провайдера арендует серверы в дата-центре БалНета и продаёт свои тарифы на этой витрине. Аренда списывается со счёта организации каждый игровой месяц.</p>
      {!mine.length && <div className="card"><p>Вы не директор ни одной организации. Зарегистрируйте ООО или АО в <a href="../nalog/#/">Налоговой службе</a>.</p></div>}
      <div className="stack">
        {mine.map((o) => (
          <div key={o.id}>
            <h2>{o.kind_title} «{o.name}»</h2>
            <OrgHosting orgId={o.id} director kind={o.kind} />
          </div>
        ))}
      </div>
    </div>
  );
}
