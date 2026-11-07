// БалПуш (push.bln) — push-сервис БалНета (этап Н10): как сайту подписать посетителя и отправить ему push.
// Протокол настоящий: PushManager.subscribe в браузере, POST на адрес подписки с TTL, Urgency, Topic,
// подписью VAPID (RFC 8292) и телом aes128gcm (RFC 8291). Сам сервис — https://push.bln/send/<token>.
import { useLang } from '../shared/i18n.js';
import { useRoute, pick } from '../shared/router.js';
import { Topbar, NavLink, Empty } from '../shared/ui.jsx';
import { PushLogo } from '../shared/brand.jsx';
import { SiteFooter, Hero, Section, Features } from '../shared/site.jsx';

const BRAND = 'БалПуш';

const CLIENT = `// script.js на странице сайта (https!)
const KEY = 'BNc…'; // открытый ключ VAPID сервера сайта

async function enablePush() {
  const reg = await navigator.serviceWorker.register('/sw.js');
  if (await Notification.requestPermission() !== 'granted') return;
  const sub = await reg.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: KEY,
  });
  // endpoint = https://push.bln/send/…, keys = { p256dh, auth }
  await fetch('/subscribe', { method: 'POST', body: JSON.stringify(sub) });
}
document.querySelector('#push').onclick = enablePush;`;

const SERVER = `// server.js на виртуальном тарифе (QuickJS)
export async function onRequest(req) {
  if (req.path === '/key') {
    let k = kv.get('vapid');
    if (!k) { k = webpush.generateVAPIDKeys(); kv.set('vapid', k); }
    return Response.json({ publicKey: k.publicKey });
  }
  if (req.method === 'POST' && req.path === '/subscribe') {
    const sub = await req.json();
    db.exec('CREATE TABLE IF NOT EXISTS subs (endpoint TEXT PRIMARY KEY, json TEXT)');
    db.run('INSERT OR REPLACE INTO subs VALUES (?, ?)', [sub.endpoint, JSON.stringify(sub)]);
    return Response.json({ ok: true });
  }
  return new Response('Не найдено', { status: 404 });
}

// Разослать всем подписчикам (например, из onCron)
export async function notifyAll(title, body) {
  for (const row of db.query('SELECT json FROM subs')) {
    const sub = JSON.parse(row.json);
    try {
      await webpush.sendNotification(sub, JSON.stringify({ title, body, url: '/news' }), {
        TTL: 3600,
        urgency: 'normal',
        vapidDetails: { subject: 'mailto:me@мойсайт.bln', ...kv.get('vapid') },
      });
    } catch (e) {
      if (e.statusCode === 410 || e.statusCode === 404) db.run('DELETE FROM subs WHERE endpoint = ?', [sub.endpoint]);
    }
  }
}`;

const RAW = `POST /send/<token> HTTP/1.1
Host: push.bln
TTL: 3600
Urgency: high
Topic: order-42
Authorization: vapid t=<JWT ES256>, k=<открытый ключ VAPID>
Content-Encoding: aes128gcm
Content-Type: application/octet-stream

<salt 16 | rs 4096 | idlen 65 | ключ отправителя 65 | шифротекст AES-128-GCM>

HTTP/1.1 201 Created
Location: https://push.bln/m/17`;

const PLAIN = `// Учебный режим: подписка без applicationServerKey, тело — JSON без шифрования.
// Годится для PHP и Python, где нет библиотеки web-push.
await fetch(sub.endpoint, {
  method: 'POST',
  headers: { TTL: '60', 'Content-Type': 'application/json' },
  body: JSON.stringify({ title: 'Новый пост', body: 'Заходите почитать', url: '/blog/7' }),
});`;

const ERRORS = [
  ['201 Created', 'Сообщение принято. Браузер покажет его, а с включённым Web Push — и телефон.'],
  ['400 Bad Request', 'Нет заголовка TTL, неверные Urgency или Topic, тело не расшифровалось, текст без шифрования.'],
  ['401 Unauthorized', 'Подписка создана с applicationServerKey, а заголовка Authorization: vapid нет.'],
  ['403 Forbidden', 'Подпись JWT не сходится, ключ k не тот, aud не https://push.bln или истёк exp (не дальше 24 часов).'],
  ['410 Gone', 'Посетитель отписался или запретил уведомления. Удалите подписку у себя.'],
  ['413 Payload Too Large', 'Тело больше 4096 байт.'],
  ['429 Too Many Requests', 'Больше 30 сообщений в минуту на одну подписку.'],
];

export default function App() {
  useLang();
  const route = useRoute();
  const nav = (
    <>
      <NavLink href="#/" path={route.path}>О сервисе</NavLink>
      <NavLink href="#/docs" path={route.path}>Для разработчиков</NavLink>
      <NavLink href="#/protocol" path={route.path}>Протокол</NavLink>
    </>
  );
  return (
    <>
      <Topbar variant="site" brand={<><PushLogo /> <span>{BRAND}</span></>} nav={nav} right={<a className="tb-btn" href="#/docs">Начать</a>} />
      <main style={{ flex: 1 }}>
        {pick([
          ['/', () => <Home />],
          ['/docs', () => <Docs />],
          ['/protocol', () => <Protocol />],
          ['*', () => <Empty>Страница не найдена</Empty>],
        ], route.path)}
      </main>
      <SiteFooter
        brand={BRAND}
        about="Push-сервис БалНета. Принимает сообщения от серверов сайтов по протоколу Web Push и доставляет их во ВлодБраузер, а с Web Push — на телефон."
        columns={[
          { title: 'Документация', links: [{ href: '#/docs', label: 'Подключить push на сайт' }, { href: '#/protocol', label: 'Протокол и ошибки' }] },
          { title: 'Сервисы БалНета', links: [{ href: '../hosting/#/', label: 'БалХост — хостинг' }, { href: '../ca/#/', label: 'БалСерт — HTTPS' }, { href: '../hub/#/', label: 'ВлодХаб — git' }] },
        ]}
      />
    </>
  );
}

function Home() {
  return (
    <>
      <Hero
        kicker="push.bln · push-сервис БалНета"
        title="Уведомления вашего сайта — даже когда вкладка закрыта"
        lead="Посетитель нажимает «Разрешить», а ваш сервер присылает ему новость, статус заказа или сообщение из чата. Протокол тот же, что у Chrome и Firefox."
        art="🔔"
      >
        <a className="btn light" href="#/docs">Подключить за 10 минут</a>
      </Hero>
      <Section title="Как это устроено">
        <Features items={[
          { icon: '🙋', title: '1. Разрешение', text: 'Сайт на https вызывает Notification.requestPermission(). ВлодБраузер сам спрашивает посетителя — по каждому сайту и профилю.' },
          { icon: '📮', title: '2. Подписка', text: 'pushManager.subscribe() выдаёт адрес https://push.bln/send/… и ключи p256dh и auth. Сайт сохраняет подписку у себя на сервере.' },
          { icon: '🚀', title: '3. Отправка', text: 'Сервер сайта шлёт POST на адрес подписки: с TTL, подписью VAPID и телом, зашифрованным ключами подписки.' },
          { icon: '📱', title: '4. Доставка', text: 'БалПуш передаёт сообщение во ВлодБраузер. Если посетитель включил Web Push — уведомление придёт и на телефон.' },
        ]} />
      </Section>
      <Section title="Правила" muted>
        <ul>
          <li>Push и уведомления работают только на <b>https</b> — нужен сертификат (БалСерт выдаёт DV бесплатно).</li>
          <li>В режиме инкогнито сайты не могут показывать уведомления: ВлодБраузер отвечает «denied».</li>
          <li>Каждое push-сообщение показывается посетителю (<code>userVisibleOnly: true</code>) — тихих push нет.</li>
          <li>Посетитель может в любой момент запретить уведомления в меню ВлодБраузера → «Уведомления». Тогда подписка отменяется, и ваш сервер получит <code>410 Gone</code>.</li>
          <li>Ссылка в уведомлении — только на ваш сайт. Чужой адрес заменяется вашей главной страницей.</li>
        </ul>
      </Section>
    </>
  );
}

function Docs() {
  return (
    <>
      <Hero compact kicker="Для разработчиков" title="Push на вашем сайте" lead="Нужен виртуальный тариф БалХоста (server.js) и сертификат https." />
      <Section title="1. Страница: разрешение и подписка">
        <p>В БалНете service worker сайта не запускается: сообщение показывает сам ВлодБраузер. Но <code>register()</code>, <code>ready</code> и <code>pushManager</code> работают как обычно — код подойдёт и для настоящего интернета.</p>
        <pre className="vh-code">{CLIENT}</pre>
      </Section>
      <Section title="2. Сервер: ключи VAPID и рассылка" muted>
        <p>В server.js есть <code>webpush</code> с тем же API, что у npm-пакета <code>web-push</code>: <code>generateVAPIDKeys()</code> и <code>sendNotification(подписка, тело, параметры)</code>. Шифрование aes128gcm и подпись JWT ES256 он делает сам.</p>
        <pre className="vh-code">{SERVER}</pre>
        <p className="muted">Тело — JSON: <code>title</code>, <code>body</code>, <code>url</code> (страница вашего сайта, откроется по клику), <code>tag</code> (новое уведомление с тем же tag заменяет старое). Простой текст покажется как body.</p>
      </Section>
      <Section title="Без библиотеки (PHP, Python, curl)">
        <pre className="vh-code">{PLAIN}</pre>
      </Section>
    </>
  );
}

function Protocol() {
  return (
    <>
      <Hero compact kicker="Web Push" title="Протокол" lead="RFC 8030 (доставка), RFC 8291 (шифрование тела), RFC 8292 (VAPID)." />
      <Section title="Запрос к push.bln">
        <pre className="vh-code">{RAW}</pre>
        <ul>
          <li><b>TTL</b> — обязателен: сколько секунд хранить сообщение, пока браузер не на связи (до 28 дней). <code>0</code> — доставить сейчас или никогда.</li>
          <li><b>Urgency</b> — very-low, low, normal или high.</li>
          <li><b>Topic</b> — до 32 символов. Новое сообщение с тем же Topic заменяет недоставленное старое.</li>
          <li><b>Authorization</b> — нужен, если подписку создали с applicationServerKey. JWT: aud = https://push.bln, exp — не дальше 24 часов, sub — mailto: или https://.</li>
          <li><b>Content-Encoding: aes128gcm</b> — тело зашифровано открытым ключом p256dh и секретом auth из подписки. Push-сервис хранит ключи получателя от имени браузера и расшифровывает сообщение при доставке.</li>
        </ul>
      </Section>
      <Section title="Ответы" muted>
        <div className="list">
          {ERRORS.map(([code, text]) => (
            <div key={code} className="list-item">
              <div className="li-main"><div className="li-title">{code}</div><div className="li-sub">{text}</div></div>
            </div>
          ))}
        </div>
      </Section>
    </>
  );
}
