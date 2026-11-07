// Налоговая служба БФ (nalog.gov.bln): регистрация организаций (ООО, АО), кабинет организации, лицензии.
import { get } from '../shared/api.js';
import { useLang } from '../shared/i18n.js';
import { useRoute, pick } from '../shared/router.js';
import { Topbar, NavLink, Empty, Money, useAsync } from '../shared/ui.jsx';
import { NalogLogo } from '../shared/brand.jsx';
import { SiteFooter, Hero, Section, Features, RequireGov, GovStrip, useGovUser } from '../shared/site.jsx';
import { OrgsPage, OrgPage } from './orgs.jsx';

const BRAND = 'Налоговая служба БФ';

export default function App() {
  useLang();
  const route = useRoute();
  const me = useGovUser();
  const nav = (
    <>
      <NavLink href="#/" path={route.path}>Бизнесу</NavLink>
      <NavLink href="#/orgs" path={route.path}>Мои организации</NavLink>
      <NavLink href="#/licenses" path={route.path}>Лицензии</NavLink>
    </>
  );
  const right = me
    ? <a className="tb-btn" href="#/orgs" title={me.email}>{me.display_name || 'Кабинет'}</a>
    : <a className="tb-btn" href="#/orgs">Войти</a>;
  const gate = (render) => <RequireGov app="nalog" siteName="nalog.gov.bln">{render}</RequireGov>;
  return (
    <>
      <Topbar variant="site" strip={<GovStrip />} brand={<><NalogLogo /> <span>{BRAND}</span></>} nav={nav} right={right} />
      <main style={{ flex: 1 }}>
        {pick([
          ['/', () => <Home />],
          ['/licenses', () => <Licenses />],
          ['/orgs', () => gate(() => <OrgsPage />)],
          ['/orgs/:id', (p) => gate(() => <OrgPage id={p.id} />)],
          ['*', () => <Empty>Страница не найдена</Empty>],
        ], route.path)}
      </main>
      <SiteFooter
        brand={BRAND}
        about="Государственная регистрация юридических лиц и лицензирование деятельности в Балесноландской Федерации."
        columns={[
          { title: 'Бизнесу', links: [{ href: '#/orgs', label: 'Зарегистрировать ООО или АО' }, { href: '#/licenses', label: 'Лицензии' }] },
          { title: 'Госорганы', links: [{ href: '../services/#/', label: 'ВлодУслуги' }, { href: '../bank/#/', label: 'ВлодБанк' }] },
          { title: 'БалНет', links: [{ href: '../reg/#/', label: 'БалРег — домены' }, { href: '../hosting/#/', label: 'БалХост — хостинг' }] },
        ]}
      />
    </>
  );
}

function usePublic() {
  return useAsync(() => get('/public/settings'), []);
}

function Home() {
  const s = usePublic().data;
  return (
    <>
      <Hero
        kicker="Государственная услуга"
        title="Регистрация бизнеса онлайн"
        lead="Откройте ООО или АО без визита в ведомство: заявление, госпошлина через ВлодБанк — и у организации появляется ИНН и расчётный счёт."
        art="🏛"
      >
        <a className="btn light" href="#/orgs">Зарегистрировать организацию</a>
      </Hero>
      <Section title="Что можно сделать">
        <Features items={[
          { icon: '🏢', title: 'ООО и АО', text: <>Госпошлина {s ? <Money value={s.fee_org} /> : '—'}. Нужны паспорт БФ и ИНН (оформляется во ВлодУслугах).</> },
          { icon: '💼', title: 'Счёт организации', text: 'Открывается автоматически во ВлодБанке. Директор переводит деньги и оплачивает квитанции.' },
          { icon: '👥', title: 'Сотрудники', text: 'Добавляйте сотрудников по номеру паспорта — они работают от имени организации.' },
          { icon: '📜', title: 'Лицензии', text: 'Регистратор доменов, хостинг-провайдер — по заявлению с одобрением чиновника.' },
        ]} />
      </Section>
    </>
  );
}

function Licenses() {
  const s = usePublic().data;
  return (
    <>
      <Hero compact title="Лицензирование" lead="Некоторые виды деятельности в БалНете требуют лицензии. Её получает организация: директор подаёт заявление из кабинета организации." />
      <div className="page medium">
        <div className="card">
          <div className="list">
            <div className="list-item"><div className="li-main"><div className="li-title">Регистратор доменов</div><div className="li-sub">Продажа доменов в зонах .bln, .vlod, .shop, .com по своим ценам на <a href="../reg/#/partners">reg.bln</a></div></div></div>
            <div className="list-item"><div className="li-main"><div className="li-title">Хостинг-провайдер</div><div className="li-sub">Аренда серверов в дата-центре и продажа тарифов на <a href="../hosting/#/partners">hosting.bln</a>{s ? <> · аренда сервера <Money value={s.hosting_server_rent} />/мес</> : null}</div></div></div>
            <div className="list-item"><div className="li-main"><div className="li-title">Администратор доменной зоны</div><div className="li-sub">Назначается администрацией БалНета</div></div></div>
          </div>
          <p className="small muted" style={{ marginTop: 12 }}>Госпошлина за лицензию: {s ? <Money value={s.fee_license} /> : '—'}. Заявление рассматривает чиновник.</p>
          <a className="btn" href="#/orgs">Перейти к организациям</a>
        </div>
      </div>
    </>
  );
}
