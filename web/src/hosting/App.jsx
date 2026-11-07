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
          ['/docs', () => <ServerDocs />],
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
                  {o.kind === 'virtual' ? (
                    <>
                      <li>серверный JavaScript, SQLite, key-value</li>
                      <li>{o.rpm} запросов/мин, CPU {o.cpu_ms} мс</li>
                      <li>cron, WebSocket ({o.ws_limit})</li>
                    </>
                  ) : <li>файловый менеджер и ZIP</li>}
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

const CODE = (t) => <pre className="mono small" style={{ whiteSpace: 'pre-wrap', background: 'var(--surface-2)', padding: 12, borderRadius: 8 }}>{t}</pre>;

/** Справка по серверному коду виртуального тарифа. */
function ServerDocs() {
  return (
    <div className="page narrow prose">
      <h1>Серверный код на БалХосте</h1>
      <p>На виртуальном тарифе в корне сайта может лежать <code>server.js</code> — JavaScript, который выполняется на сервере хостинга (движок QuickJS). Он отвечает на запросы, для которых нет файла, и на все POST, PUT, PATCH и DELETE. Статические файлы по-прежнему отдаются как есть.</p>
      <h2>Запрос и ответ</h2>
      {CODE(`export async function onRequest(req) {
  // req.method, req.path, req.url, req.query.get('page'), req.headers.get('accept'),
  // req.cookies.sid, req.ip (адрес посетителя в БалНете)
  // await req.text(), await req.json(), (await req.form()).get('name')
  if (req.path === '/api/hello') return Response.json({ hello: 'мир' });
  if (req.method === 'POST') return Response.redirect('/');
  return Response.html('<h1>Привет</h1>');
  // или new Response('текст', { status: 404, headers: { 'x-my': '1' } })
  //   .setCookie('sid', 'abc', { httpOnly: true, maxAge: 3600 })
}`)}
      <p>Модули: <code>import {'{'} x {'}'} from './lib.js'</code> — файлы своего сайта. npm нет.</p>
      <h2>База данных SQLite</h2>
      {CODE(`db.exec('CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, name TEXT)');
const { lastInsertRowid } = db.run('INSERT INTO users (name) VALUES (?)', ['Борис']);
const rows = db.query('SELECT * FROM users WHERE id > ?', [0]);
const one = db.get('SELECT COUNT(*) AS n FROM users');`)}
      <p>База — настоящий SQLite в файле <code>.data/site.sqlite</code>, занимает место по тарифу. Посмотреть и изменить её можно в «Моём хостинге» → «База SQLite».</p>
      <h2>Key-value</h2>
      {CODE(`kv.set('counter', 5);                 // любое значение JSON
kv.set('session:abc', { user: 1 }, { ttl: 86400 }); // живёт игровые сутки
kv.get('counter'); kv.delete('counter'); kv.list('session:');`)}
      <h2>Запросы к другим сайтам</h2>
      {CODE(`const r = await fetch('https://shop.bln/api/items');
const items = await r.json();`)}
      <p>Запрос идёт по сети БалНета с адреса вашего сервера: DNS, проверка сертификата HTTPS. Госсайты запросов от серверов не принимают.</p>
      <h2>Cron по игровому времени</h2>
      <p>Файл <code>crontab</code> в корне сайта, синтаксис как у настоящего cron: минута, час, день (1–30), месяц (1–12), день недели (0–6) и имя задачи.</p>
      {CODE(`# каждый игровой день в 9:00
0 9 * * * утро
# каждые 2 игровых часа
0 */2 * * * обновить-курсы`)}
      {CODE(`export function onCron(job) {
  console.log('задача', job.name, 'время', job.time);
}`)}
      <p>Тариф задаёт минимальный шаг: задача, которая срабатывает чаще, не запускается (ошибка в журнале).</p>
      <h2>Почта: свой почтовый сервер</h2>
      <p>Сайт принимает письма своего домена, если MX домена указывает на сайт (<code>@ MX 10 ваш-домен.</code>). Каждое письмо вызывает <code>onMail</code>; вернуть <code>{'{'} reject: 'текст' {'}'}</code> или <code>false</code> — отказать (отправитель получит ответ 550).</p>
      {CODE(`export async function onMail(m) {
  // m.from.address, m.to, m.subject, m.text, m.html, m.headers, m.raw
  // m.auth: { spf, dkim, dkim_domain, dmarc } — проверки сделал сервер
  if (m.auth.dmarc === 'fail') return { reject: 'Подделка отправителя' };
  db.run('INSERT INTO inbox (frm, subj) VALUES (?, ?)', [m.from.address, m.subject]);
}`)}
      <p>Отправка — <code>mail.send</code>: письмо уходит с адреса вашего сервера по MX получателя. Чтобы письма не попадали в спам, добавьте SPF (<code>v=spf1 ip4:адрес-сервера -all</code>) и подпись DKIM: ключ создаётся в панели сайта → «Почта», он лежит в <code>.dkim/селектор.key</code>.</p>
      {CODE(`const r = await mail.send({
  from: { name: 'Магазин', address: 'shop@my.bln' },
  to: 'anna@mail.bln', subject: 'Заказ принят', text: 'Спасибо!', html: '<b>Спасибо!</b>',
  dkim: 'mail',            // селектор ключа DKIM (необязательно)
});
// r.results: [{ rcpt, ok, code: '250' | '550' …, text, server }]`)}
      <p>Лимит — 30 писем в час с сайта. Подделать отправителя можно, но SPF, DKIM и DMARC получателя это увидят: письмо от bank.bln с чужого сервера ВлодПочта отклонит.</p>
      <h2>PHP 8.3</h2>
      <p>Файлы <code>.php</code> выполняются (исходник посетителям не отдаётся). Если в корне есть <code>index.php</code>, а <code>server.js</code> нет, все запросы без файла идут в него — как фронт-контроллер. Работают <code>$_GET</code>, <code>$_POST</code>, <code>$_COOKIE</code>, <code>header()</code>, <code>setcookie()</code>, сессии.</p>
      {CODE(`<?php
$db = balnet_db();                 // PDO SQLite — та же база, что у JavaScript
$db->exec('CREATE TABLE IF NOT EXISTS notes (t TEXT)');
balnet_kv_set('hits', (balnet_kv_get('hits') ?? 0) + 1, 86400);
echo 'Игровое время: ' . balnet_game_time();`)}
      <p>Выхода в сеть у PHP нет (allow_url_fopen и сокеты выключены): запросы к другим сайтам делайте из JavaScript или Python.</p>
      <h2>Python 3</h2>
      <p>Файл <code>server.py</code> (если нет <code>server.js</code>). Интерпретатор — Pyodide; первый запрос после простоя медленнее: интерпретатор загружается.</p>
      {CODE(`import balnet

async def on_request(req):          # req.method, req.path, req.query, req.form(), req.json(), req.cookies, req.ip
    db = balnet.db()                 # sqlite3, та же база сайта
    balnet.kv.set('hits', (balnet.kv.get('hits') or 0) + 1)
    r = await balnet.fetch('https://shop.bln/api/items')
    return balnet.json_response({'items': r.json()})
    # или balnet.html('<h1>Привет</h1>'), balnet.redirect('/'), balnet.Response('текст', 404)

def on_cron(job):
    print('задача', job['name'])     # print пишет в журнал`)}
      <p>В <code>crontab</code> можно запускать и скрипты: <code>0 3 * * * backup.php</code> или <code>*/30 * * * * report.py аргумент</code>.</p>
      <h2>Лимиты тарифа</h2>
      <ul>
        <li><b>CPU-мс на запрос</b> — время работы самого скрипта (ожидание fetch не считается). Превысили — ответ 508.</li>
        <li><b>Запросов в минуту</b> — на сайт; сверх лимита — 429.</li>
        <li><b>Память</b> — 32 МБ на запрос JavaScript, 64 МБ у PHP; <b>время</b> — не больше 15 секунд вместе с ожиданием.</li>
        <li><b>PHP и Python</b> выполняются в отдельных потоках по очереди (PHP — 2 одновременно, Python — 1); их лимит — время выполнения: CPU-мс тарифа × 20.</li>
      </ul>
      <p>Всё, что пишет <code>console.log</code>, и все ошибки видны в «Моём хостинге» → «Журнал».</p>
    </div>
  );
}
