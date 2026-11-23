// Страница скачивания ВлодБраузера для iOS: архив проекта Swift Playgrounds и инструкция.
import { createRoot } from 'react-dom/client';
import '../shared/styles.css';
import { Topbar, DisclaimerBar } from '../shared/ui.jsx';
import { CoatOfArms } from '../shared/brand.jsx';
import { IOS_APP } from '@bln/shared/app-versions.js';

const ZIP = 'VlodBrowser.swiftpm.zip';

function IosPage() {
  return (
    <>
      <Topbar brand={<><CoatOfArms size={30} /> <span>ВлодБраузер для iOS</span></>} />
      <main className="page" style={{ maxWidth: 760 }}>
        <div className="page-head">
          <img src="icon.png" alt="" width={72} height={72} style={{ borderRadius: 16 }} />
          <div>
            <h1 style={{ margin: 0 }}>ВлодБраузер для iPhone и iPad</h1>
            <span className="muted">Версия {IOS_APP.version} · iOS 16 и новее</span>
          </div>
        </div>

        <div className="card">
          <p>Нативный браузер БалНета: вкладки, госсайты bank.bln и gosuslugi.gov.bln, сайты игроков, проверка сертификатов, терминал (dig, ping, ssh) и инструменты разработчика.</p>
          <p><a className="btn" href={ZIP} download>Скачать {ZIP}</a></p>
        </div>

        <div className="card">
          <h2>Как установить на iPad или Mac</h2>
          <ol>
            <li>Установите бесплатное приложение <b>Swift Playgrounds</b> из App Store.</li>
            <li>Нажмите «Скачать» выше. Архив попадёт в «Файлы» → «Загрузки».</li>
            <li>Нажмите на архив — рядом появится папка <code>VlodBrowser.swiftpm</code>.</li>
            <li>Нажмите на <code>VlodBrowser.swiftpm</code> — проект откроется в Swift Playgrounds.</li>
            <li>Нажмите ▶︎ «Запустить». Приложение откроется во весь экран; в следующий раз запускайте его из Swift Playgrounds.</li>
          </ol>
          <p className="muted">Когда выйдет новая версия, ВлодБраузер покажет баннер «Доступна новая версия» — скачайте архив снова и откройте его так же.</p>
        </div>

        <div className="card">
          <h2>iPhone</h2>
          <p>На iPhone нет Swift Playgrounds, поэтому для телефона приложение появится через TestFlight — ссылку дадим здесь. Пока на iPhone можно пользоваться веб-версией: <a href="../">ВлодБраузер в браузере</a>.</p>
        </div>

        <div className="card">
          <h2>Если не запускается</h2>
          <ul>
            <li>Обновите iPadOS и Swift Playgrounds до последней версии.</li>
            <li>Сделайте снимок экрана с ошибкой и пришлите администратору игры.</li>
          </ul>
        </div>
      </main>
      <DisclaimerBar />
    </>
  );
}

document.body.dataset.app = 'services';
createRoot(document.getElementById('root')).render(<IosPage />);
