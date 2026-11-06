import { createRoot } from 'react-dom/client';
import '../shared/styles.css';
import { Topbar, DisclaimerBar } from '../shared/ui.jsx';
import { CoatOfArms, Flag, BankLogo, ServicesLogo, PosLogo, AdminLogo } from '../shared/brand.jsx';
import { t, useLang } from '../shared/i18n.js';

function Landing() {
  useLang();
  const apps = [
    { href: '../', logo: <CoatOfArms size={44} />, title: 'ВлодБраузер', text: t('БалНет: bank.bln, gosuslugi.gov.bln, kassa.bln') },
    { href: '../services/', logo: <ServicesLogo size={44} />, title: 'ВлодУслуги', text: t('Паспорт БФ, документы, ИП, квитанции') },
    { href: '../bank/', logo: <BankLogo size={44} />, title: 'ВлодБанк', text: t('Счета, карты, переводы, банкомат') },
    { href: '../pos/', logo: <PosLogo size={44} />, title: t('Касса'), text: t('Продажи, терминал покупателя, чеки 58 мм') },
    { href: '../admin/', logo: <AdminLogo size={44} />, title: t('Админка'), text: t('Управление игрой') },
  ];
  return (
    <>
      <Topbar brand={<><CoatOfArms size={30} /> <span>{t('Балесноландская Федерация')}</span></>} />
      <main className="page">
        <div className="page-head"><Flag width={60} /><h1>{t('Игровая экономика Балесноландии')}</h1></div>
        <div className="landing">
          {apps.map((a) => (
            <a key={a.href} className="card" href={a.href}>
              {a.logo}
              <h2 style={{ margin: 0 }}>{a.title}</h2>
              <span className="muted">{a.text}</span>
            </a>
          ))}
        </div>
      </main>
      <DisclaimerBar />
    </>
  );
}

document.body.dataset.app = 'services';
createRoot(document.getElementById('root')).render(<Landing />);
