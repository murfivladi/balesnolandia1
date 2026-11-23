# БалНет — полная документация API для игроков

> Документ для разработчика (человека или ИИ), который пишет сайт в БалНете — в первую очередь **сайт своей хостинг-компании**.
> Всё ниже — реальное поведение сервера на момент написания. Если пример противоречит таблице маршрутов в Приложении А — права таблица (она собрана из кода).

---

## Содержание

0. [Как устроен БалНет — коротко](#0-как-устроен-балнет--коротко)
1. [Где работает ваш код: тарифы, файлы, лимиты](#1-где-работает-ваш-код)
2. [Серверный JavaScript: `server.js`](#2-серверный-javascript-serverjs)
3. [Python (`server.py`) и PHP](#3-python-serverpy-и-php)
4. [Cron, SSH, git (ВлодХаб)](#4-cron-ssh-git-влодхаб)
5. [Сеть БалНета: `fetch`, DNS, HTTPS, госсайты](#5-сеть-балнета)
6. [Доступ к API государства: токены `bln_…`](#6-доступ-к-api-государства-токены-bln_)
7. [**Свой хостинг на своём сайте** — пошагово и с полным кодом](#7-свой-хостинг-на-своём-сайте)
8. [Справочник: домены, DNS, регистраторы, аукционы](#8-домены-dns-регистраторы-аукционы)
9. [Справочник: хостинг (кабинет клиента и кабинет хостера)](#9-хостинг)
10. [Справочник: сертификаты HTTPS и УЦ](#10-сертификаты-https-и-удостоверяющие-центры)
11. [Эквайринг ВлодБанка `pay.bank.bln/api/v1`](#11-эквайринг-влодбанка)
12. [Вход через ВлодПочту и ВлодУслуги (OAuth 2 + PKCE)](#12-вход-через-влодпочту-и-влодуслуги-oauth-2--pkce)
13. [Почта: `mail.send`, `onMail`, свой домен](#13-почта)
14. [Web Push](#14-web-push)
15. [БалНовости](#15-балновости)
16. [ВлодПоиск: вебмастер, реклама, рекламная сеть](#16-влодпоиск-вебмастер-реклама)
17. [ВлодБанк по токену (`pay`) и госуслуги (`services`)](#17-влодбанк-по-токену-и-госуслуги)
18. [Что умеет страница сайта в браузере (shim)](#18-что-умеет-страница-сайта-в-браузере)
19. [Ошибки, деньги, время — общие правила](#19-ошибки-деньги-время)
20. [Чек-лист для ИИ-кодера: сайт хостинга](#20-чек-лист-для-ии-кодера-сайт-хостинга)
- [Приложение А. Все маршруты API, доступные игрокам](#приложение-а-все-маршруты-api)

---

## 0. Как устроен БалНет — коротко

- БалНет — игровой «интернет» внутри проекта Балесноландия. Свои IP (`50.x.x.x`), провайдеры, DNS (корень → TLD `.bln`, `.shop`, `.vlod`… → NS домена), сертификаты, поисковик, почта.
- Сайты игроков лежат на **серверах хостеров**. Открываются они во **ВлодБраузере** (на главной странице проекта) по адресам вида `https://boris.bln/`.
- Деньги — **влодики**. В API суммы всегда **целые влодинки**: 1 влодик = 100 влодинок. `15000` = 150 влодиков.
- **Время игровое.** В игровом месяце 30 игровых суток. Длину месяца в реальном времени задаёт админ: от 1 минуты до 31 реальных суток. Сроки хостинга, доменов и сертификатов считаются в игровых месяцах. `gameTime()` в коде сайта отдаёт игровые секунды.
- Госсайты (ВлодБанк, ВлодУслуги, БалРег, БалХост, БалСерт, ВлодПочта, ВлодПоиск, ВлодХаб, БалНовости, push.bln) — **настоящий код платформы**. Ваш сервер ходит к ним по сети БалНета только по https и только в их API.

| Госсайт | Адрес | Что там |
|---|---|---|
| ВлодУслуги | `gosuslugi.gov.bln` | паспорт, документы, ИП/ООО, квитанции, **токены API** |
| ВлодБанк | `bank.bln` | счета, переводы, оплата квитанций |
| Эквайринг | `pay.bank.bln` | приём оплаты на вашем сайте, `/api/v1` |
| БалРег | `reg.bln` | домены, DNS, регистраторы |
| БалХост | `hosting.bln` | госхостинг и кабинеты хостеров |
| БалСерт | `ca.gov.bln` | сертификаты, CT-журнал |
| Налоговая | `nalog.gov.bln` | организации, лицензии, налоги |
| ВлодПочта | `mail.bln` | почта, OAuth-провайдер |
| ВлодПоиск | `poisk.bln` | поиск, вебмастер, реклама |
| ВлодХаб | `vlodhub.bln` | git-хостинг |
| БалНовости | `novosti.bln` | новости, СМИ игроков |
| БалПуш | `push.bln` | push-сервис (Web Push) |

---

## 1. Где работает ваш код

### Тарифы хостинга
- **Статический** — только файлы: HTML, CSS, JS, картинки. Сервера нет.
- **Виртуальный** — файлы плюс серверный код: `server.js` (QuickJS), `server.py` (Pyodide, Python 3) или `*.php` (php-wasm, PHP 8.3). Ещё SQLite, key-value, WebSocket, cron, исходящий `fetch`, почта.

Лимиты задаёт тариф: место (МБ), число сайтов, запросов в минуту (`rpm`), CPU-мс на запрос (`cpu_ms`), WebSocket-соединений (`ws_limit`), минимальный шаг cron в игровых минутах (`cron_min`). Ещё есть максимальный размер файла (настройка админа, по умолчанию 5 МБ).

### Файлы сайта
- Корень каталога сайта = корень адреса: `index.html` → `https://сайт.bln/`.
- **Не отдаются посетителям:** `server.js`, `server.py`, `crontab`, всё в `.data/` (там лежит SQLite), исходники `*.php` (они выполняются).
- Особые файлы: `robots.txt` и `sitemap.xml` читает ВлодПоиск; `rss.xml` (или любой адрес ленты) забирают БалНовости.
- Кто обрабатывает запрос на виртуальном тарифе, по порядку:
  1. существующий статический файл отдаётся как есть;
  2. файл `*.php` по пути выполняется;
  3. `index.php` в каталоге, если путь заканчивается на `/`;
  4. `server.js`, если он есть;
  5. `server.py`;
  6. корневой `index.php` как фронт-контроллер.

### Как загружать файлы
- Через панель hosting.bln (файловый менеджер, ZIP).
- По SSH (раздел 4).
- Через git push во ВлодХаб с автодеплоем.
- **Через API** по токену: `PUT /api/gov/hosting/:id/sites/:sid/file` (раздел 9).

---

## 2. Серверный JavaScript `server.js`

Работает в QuickJS: это не Node.js, `require`/`import` npm-пакетов нет. Файл — ES-модуль; обработчики экспортируются функциями. Каждый вызов изолирован, глобальное состояние между запросами **не сохраняется** — используйте `db` и `kv`.

### Обработчики

```js
export async function onRequest(req) { /* HTTP-запрос посетителя или другого сервера → Response */ }
export function onCron(job) { /* задача из crontab: job.name, job.time (игровые секунды) */ }
export function onSocket(event) { /* WebSocket: event.type = 'open' | 'message' | 'close', event.socket, event.data */ }
export function onMail(msg) { /* письмо на адрес вашего домена (если MX указывает на ваш сервер) */ }
```

### `req` (Request)
| Поле | Что это |
|---|---|
| `req.method` | `GET`, `POST`, … |
| `req.path` | путь без query: `/api/orders` |
| `req.url` | полный адрес |
| `req.host` | имя сайта, на которое пришёл запрос |
| `req.ip` | IP клиента в БалНете |
| `req.headers.get(name)` | заголовок (имя в любом регистре) |
| `req.query.get(k)` / `.getAll(k)` / `.has(k)` | параметры адреса (URLSearchParams) |
| `req.cookies` | объект cookie сайта |
| `await req.text()` / `await req.json()` / `await req.form()` | тело запроса (`form()` — URLSearchParams из `application/x-www-form-urlencoded`) |

### `Response`
```js
new Response('текст', { status: 200, headers: { 'content-type': 'text/plain; charset=utf-8' } });
Response.json({ ok: true }, { status: 201 });
Response.html('<h1>Привет</h1>');
Response.redirect('/thanks');           // 302; второй аргумент — код
new Response(uint8array)                // бинарный ответ
res.setCookie('sid', 'abc', { maxAge: 3600, httpOnly: true, sameSite: 'Lax', path: '/' });  // можно цепочкой
```

### База SQLite сайта — `db`
```js
db.exec('CREATE TABLE IF NOT EXISTS orders (id INTEGER PRIMARY KEY, email TEXT, plan INTEGER, status TEXT, at INTEGER)');
db.run('INSERT INTO orders (email, plan, status, at) VALUES (?, ?, ?, ?)', [email, 3, 'new', gameTime()]); // → { changes, lastInsertRowid }
db.query('SELECT * FROM orders WHERE status = ?', ['new']);  // → массив строк
db.get('SELECT * FROM orders WHERE id = ?', [id]);           // → строка или null
```
Одна база на сайт: она общая для `server.js`, `server.py`, PHP и cron. Из панели доступна SQL-консоль (`POST …/sql`).

### Key-value — `kv`
```js
kv.set('visits', 10);                 // любое JSON-значение
kv.set('login:' + state, verifier, { ttl: 600 });   // ttl в игровых секундах
kv.get('visits'); kv.delete('visits'); kv.list('login:');
```

### Сеть — `fetch`
Работает как браузерный `fetch`, но запрос идёт **по сети БалНета** с IP вашего сервера: DNS → маршрут → TLS с проверкой сертификата.
```js
const r = await fetch('https://shop.anna.bln/api/items', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ q: 1 }) });
r.status; r.ok; r.url; r.headers.get('content-type'); await r.text(); await r.json();
```
- Ошибка сети бросает `TypeError('fetch: ERR_…')` с кодами в стиле Chrome: `ERR_NAME_NOT_RESOLVED`, `ERR_CONNECTION_REFUSED`, `ERR_CERT_*`, `ERR_TOO_MANY_REDIRECTS`.
- Сайты могут звать друг друга, но цепочка не длиннее 3 сайтов.
- Тело — строка. Бинарное тело передаётся как `{ bodyB64: '…' }`.
- Выйти в настоящий интернет нельзя: доступен только БалНет.

### Прочее
| Глобал | Что делает |
|---|---|
| `gameTime()` | игровые секунды (целое) |
| `console.log/info/warn/error` | журнал сайта в панели hosting.bln (`GET …/logs`) |
| `crypto.randomUUID()` | UUID |
| `crypto.hash('sha256', data)` | hex |
| `crypto.hmac('sha256', key, data)` | hex |
| `crypto.timingSafeEqual(a, b)` | сравнение подписей |
| `btoa` / `atob`, `URL`, `URLSearchParams`, `Headers` | как в браузере |
| `mail.send({...})` | письмо (раздел 13) |
| `sockets.send(id, data)` / `broadcast(data, {path, except})` / `close(id, reason)` / `list(path)` | WebSocket-клиенты (`data` — строка или объект → JSON) |
| `webpush.generateVAPIDKeys()` / `webpush.sendNotification(sub, payload, {vapidDetails})` | Web Push (раздел 14) |
| `setTimeout(fn)` | выполняет fn в конце текущего вызова (таймеров нет) |

### WebSocket
Страница открывает соединение `new WebSocket('wss://ваш.bln/chat')`: shim браузера проводит его через шлюз БалНета. На сервере:
```js
export function onSocket(e) {
  if (e.type === 'open') sockets.send(e.socket.id, { hello: true });
  if (e.type === 'message') sockets.broadcast({ from: e.socket.id, text: e.data }, { path: '/chat', except: e.socket.id });
}
```

---

## 3. Python `server.py` и PHP

### Python (Pyodide)
```python
import balnet

async def on_request(req):          # req.method, req.path, req.query, await req.form(), await req.json(), req.cookies, req.ip
    db = balnet.db()                 # sqlite3, та же база сайта
    balnet.kv.set('hits', (balnet.kv.get('hits') or 0) + 1)
    r = await balnet.fetch('https://shop.bln/api/items')
    return balnet.json_response({'items': r.json()})
    # или balnet.html('<h1>Привет</h1>'), balnet.redirect('/'), balnet.Response('текст', 404)
```

### PHP 8.3
Файлы `.php` выполняются. Работают `$_GET`, `$_POST`, `$_COOKIE`, `header()`, `setcookie()` и сессии. Корневой `index.php` без `server.js` становится фронт-контроллером для всех путей без файла.

---

## 4. Cron, SSH, git (ВлодХаб)

### `crontab` в корне сайта
```
# минута час день месяц день_недели задача      (время ИГРОВОЕ)
0 4 * * * уборка                 # вызовет onCron({ name: 'уборка', time })
*/30 * * * * report.py аргумент  # запустит скрипт
0 3 * * * backup.php
```
Шаг не может быть меньше `cron_min` тарифа.

### SSH
В панели задайте пароль (`POST /api/gov/hosting/:id/ssh {password}`). Вход: `u<номер аккаунта>@<IP сервера>` из терминала ВлодБраузера. Команды: `ls`, `cd`, `pwd`, `cat`, `head`, `tail`, `wc`, `grep`, `find`, `tree`, `mkdir`, `rm`, `rmdir`, `mv`, `cp`, `touch`, `echo`, `nano`/`vi`, `unzip`, `du`, `df`, `node`, `php`, `python3`, `sqlite3`, `git`, `whoami`, `hostname`, `date`, `exit`.

### ВлодХаб (`vlodhub.bln`)
- Это настоящий git по HTTP: `git clone https://логин:ТОКЕН@vlodhub.bln/логин/проект.git`. Из SSH хостинга адрес такой же; из интернета — `https://<сервер-API>/api/hub/git/логин/проект.git`.
- Токен git выпускается во ВлодХабе (`POST /api/hub/tokens`). Это **не** `bln_…`.
- **Деплой по push.** В настройках репозитория укажите сайт и ветку: после каждого push файлы выкладываются на хостинг.
- Задачи, запросы на слияние, соавторы и приватные репозитории — см. `/api/hub/*` в Приложении А.

---

## 5. Сеть БалНета

- Ваш сервер имеет IP хостера (`50.2.0.x` у хостеров-игроков, `50.1.0.x` у госхостинга). Исходящие запросы `fetch` резолвятся через публичный DNS БалНета.
- **Чтобы ваш сайт открывался по имени:** купите домен → подключите имя к аккаунту хостинга (`POST /hosting/:id/sites {host}`) → поставьте A-запись на IP сервера.
- **HTTPS:** бесплатный DV-сертификат одной кнопкой в панели (`POST /hosting/:id/sites/:sid/ssl`) или выпуск через БалСерт (раздел 10). Без сертификата порт 443 закрыт, и `https://` даёт `ERR_CONNECTION_REFUSED`.
- **Госсайты отвечают серверам только своим API и только по https:**
  - `https://<любой госсайт>/api/…` — REST API государства по токену `bln_…` (раздел 6);
  - `https://pay.bank.bln/api/v1/…` — эквайринг (ключи `sk_live_` / `pk_live_`);
  - `https://mail.bln/oauth/…`, `https://gosuslugi.gov.bln/oauth/…` — OAuth;
  - `https://push.bln/…` — приём Web Push;
  - `https://vlodhub.bln/<логин>/<репо>.git/…` — git.

  Любой другой адрес госсайта даёт `ERR_GOV_SITE`: его можно открыть только во ВлодБраузере.

---

## 6. Доступ к API государства: токены `bln_…`

### Выпуск
ВлодУслуги → **«Ключи API»** (`gosuslugi.gov.bln/#/api-tokens`). Выберите права. Токен показывается **один раз** — храните его как пароль: в `kv`, SQLite или в коде сервера, но **не на странице**. Можно выпустить до 20 токенов и отозвать любой.

### Права (scopes)
| Право | Разрешённые пути | Примечание |
|---|---|---|
| `profile` | `GET /api/gov/me`, `GET /api/gov/passport` | только чтение |
| `domains` | `/api/gov/domains…`, `/api/gov/orgs…`, `/api/gov/auctions…` | домены, DNS, организации, регистраторы |
| `hosting` | `/api/gov/hosting…`, `/api/gov/orgs…` | свои аккаунты **и кабинет хостера** |
| `certs` | `/api/gov/certs…`, `/api/gov/cas…`, `…/sites/:sid/ssl`, `…/sites/:sid/cert` | сертификаты |
| `services` | `/api/gov/invoices`, `applications`, `documents`, `taxes`, `fines`, `benefits`, `properties`, `appeals`, `work`, `elections`, `doctor`, `insurance`, `deals` | госуслуги |
| `mail` | `/api/mail/…` (кроме `sync`) | ВлодПочта |
| `news` | `/api/news/…` | свои СМИ и статьи |
| `hub` | `/api/hub/…` (кроме `tokens` и `git`) | ВлодХаб |
| `search` | `/api/search/webmaster…`, `ads…`, `campaigns…`, `adnet…` | вебмастер и реклама |
| `pay` | `GET /api/bank/accounts`, `GET /api/bank/invoices/:номер`, `POST /api/bank/invoices/:номер/pay` | банк гражданина по связке паспорта |

**Никогда** через токен: `/api/auth/*` (вход, пароль), `/api/admin/*`, `/api/gov/api-tokens`. Публичные адреса (поиск, лента новостей, тарифы, проверка домена) работают и без токена.

### Как звать
С сервера сайта по сети БалНета — **на любой госсайт по https**, путь как у API:
```js
const H = { authorization: 'Bearer ' + kv.get('bln_token'), 'content-type': 'application/json' };
const r = await fetch('https://reg.bln/api/gov/domains', { headers: H });
const { domains } = await r.json();
```
Хост не важен: `reg.bln`, `hosting.bln`, `gosuslugi.gov.bln`, `bank.bln` — запрос попадает в один и тот же API. Для читаемости зовите профильный госсайт.

Из **настоящего интернета** (бот, скрипт на ПК) — тот же путь на сервере API проекта: `https://<api-сервер>/api/gov/domains` с тем же заголовком. Адрес сервера API показан на странице «Ключи API».

Со **страницы** сайта в браузере (клиентский JS) API госсайтов закрыт: сайты работают в песочнице, `Origin: null` → `403 sandbox_origin`. Всё делайте через свой `server.js`.

### Ответы
- `401 unauthorized` — нет токена, он отозван, или у него нет права на этот путь.
- `403 forbidden` — право есть, но действие чужое (например, вы не директор организации).
- Тело ошибки: `{ "error": "код", "message": "текст по-русски", ...данные }`.

---

## 7. Свой хостинг на своём сайте

**Идея.** Вы — хостинг-компания (ООО/АО с лицензией хостера). Вы арендуете серверы у государства, создаёте тарифы и продаёте их **на своём сайте**. Деньги принимаете своим эквайрингом. Клиентские аккаунты выдаёте через API хостера. Ваши тарифы **по умолчанию не видны** на госхостинге hosting.bln (флаг `listed = false`). Выставить их на госвитрину можно по желанию.

### 7.1. Подготовка (один раз, руками или через API)
1. ВлодУслуги: паспорт → ИНН (`POST /api/gov/documents/inn`).
2. Организация: `POST /api/gov/orgs/apply { kind: 'llc', name: 'ВасяХост' }` → оплатить квитанцию → вы директор.
3. Лицензия хостинг-провайдера: `POST /api/gov/orgs/:id/licenses { kind: 'hosting' }` — заявка, оплачивается квитанцией; лицензия действует помесячно.
4. Пополнить счёт организации переводом во ВлодБанке.
5. Арендовать сервер: `POST /api/gov/orgs/:id/servers` → `{ id, ip, rent }`. Аренда списывается со счёта организации каждый игровой месяц. Если денег нет, сервер приостанавливается, а потом удаляется вместе с сайтами клиентов.
6. Тарифы: `POST /api/gov/orgs/:id/plans` (поля ниже). Запомните их `id`.
7. Эквайринг: ИП или организация с бизнес-счётом → pay.bank.bln → «Кабинет» → магазин → ключи `sk_live_…`, `pk_live_…` и секрет вебхуков `whsec_…`.
8. Токен `bln_…` директора с правом **`hosting`** (и `domains`, если продаёте домены как регистратор).
9. Свой домен и свой сайт на **виртуальном** тарифе: на нём работает `server.js` вашей компании.

### 7.2. Тариф
`POST /api/gov/orgs/:orgId/plans`
| Поле | Тип | Описание |
|---|---|---|
| `server_id` | int | ваш сервер |
| `name` | string ≤80 | название |
| `disk_mb` | int | место, не больше диска сервера |
| `max_sites` | int 1–100 | сколько имён можно подключить |
| `price_month` | влодинки | цена в игровой месяц (с НДС) — для госвитрины; на своём сайте берите сколько хотите |
| `kind` | `static` \| `virtual` | статический или с серверным кодом |
| `rpm` | int | запросов в минуту |
| `cpu_ms` | int 10–2000 | CPU на запрос (virtual) |
| `ws_limit` | int | WebSocket-соединений (virtual) |
| `cron_min` | int | минимальный шаг cron, игровых минут (virtual) |
| `listed` | bool, по умолчанию **false** | показывать ли на витрине hosting.bln |

`PATCH /api/gov/orgs/:orgId/plans/:pid { active?, price_month?, listed? }` — снять с продажи, сменить цену, убрать с витрины или выставить на неё.

Публичный список **ваших** тарифов (включая скрытые) — для страницы цен на вашем сайте:
`GET https://hosting.bln/api/gov/hosting/plans?org_id=<orgId>` (без токена) →
```json
{ "offers": [ { "id": 7, "org_id": 3, "hoster": "ВасяХост", "name": "Старт", "kind": "virtual", "disk_mb": 20, "max_sites": 2,
  "price_month": 50000, "listed": false, "rpm": 300, "cpu_ms": 100, "ws_limit": 20, "cron_min": 60, "server": "s5.dc.bln", "ip": "50.2.0.12" } ] }
```
Тариф попадает в список, только если он активен, сервер работает, а у организации есть лицензия в этом месяце.

### 7.3. API хостера — клиентские аккаунты
Все запросы идут от директора организации (cookie или токен `bln_…` с правом `hosting`).

| Метод и путь | Тело | Ответ |
|---|---|---|
| `GET /api/gov/orgs/:orgId/hosting` | — | сервер(ы), тарифы, лицензия, аренда |
| `GET /api/gov/orgs/:orgId/hosting/accounts` | — | `{ accounts: [Client], month }` |
| `GET /api/gov/orgs/:orgId/hosting/accounts/:aid` | — | `{ account: Client }` |
| `POST /api/gov/orgs/:orgId/hosting/accounts` | `plan_id`, **один из** `passport_no` \| `email` \| `gov_user_id`, `months` (1…макс., по умолчанию 1), `note` (≤200, например номер вашего заказа) | `{ account_id, paid_until_month }` |
| `POST …/accounts/:aid/extend` | `months` | `{ paid_until_month }` (от большего из «оплачено до» и текущего месяца) |
| `POST …/accounts/:aid/status` | `status: "active" \| "suspended"` | приостановить (например, за неоплату на вашем сайте) или включить; включить можно, только если срок не истёк |
| `DELETE …/accounts/:aid` | — | удалить аккаунт **вместе с файлами** и сайтами клиента |

`Client`:
```json
{ "id": 41, "plan_id": 7, "plan": "Старт", "status": "active", "paid_until_month": 15, "owner_gov_user_id": 12, "owner_name": "Борис",
  "note": "order-1001", "server_ip": "50.2.0.12", "ssh_user": "u41", "sites": ["boris.bln"], "used_bytes": 10240, "created_month": 12 }
```

Что важно:
- **Деньги.** При выдаче через API государство денег **не списывает**: вы уже получили их на своём сайте. Платите только аренду сервера и лицензию.
- **Клиент** должен быть гражданином с действующим паспортом. Ошибки: `404 Клиент не найден…`, `400 no_passport`.
- **Место.** Если на сервере закончилось место, приходит `400 server_full` — арендуйте ещё сервер.
- **Клиент получает уведомление** и видит аккаунт у себя на hosting.bln → «Мои хостинги». Дальше он сам подключает имена, грузит файлы и включает SSH — в панели или по своему токену.
- **Сроки.** Когда наступает `paid_until_month`, госхостинг сам приостанавливает аккаунт, а после льготного срока удаляет его. Продлевайте через `extend`, когда клиент платит на вашем сайте.
- Через `/api/gov/hosting/:id/…` хостер управляет только **своими** аккаунтами (где он владелец). Файлы клиента он не трогает — это делает клиент.

### 7.4. Полный пример: сайт хостинг-компании на `server.js`
Ниже готовый рабочий каркас: витрина тарифов → заказ (паспорт клиента) → оплата через эквайринг → вебхук → выдача аккаунта → продление → кабинет клиента.

```js
// server.js — сайт хостинга «ВасяХост» (виртуальный тариф)
// Секреты положите один раз через SQL-консоль панели или временный /setup, потом удалите /setup.
const ORG = 3;                                   // id вашей организации
const API = 'https://hosting.bln/api/gov';       // REST API государства
const PAY = 'https://pay.bank.bln/api/v1';       // эквайринг
const SITE = 'https://vasyahost.bln';

db.exec(`CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY, kind TEXT, plan_id INTEGER, months INTEGER, passport TEXT, account_id INTEGER,
  payment TEXT, amount INTEGER, status TEXT, at INTEGER)`);
db.exec('CREATE TABLE IF NOT EXISTS prices (plan_id INTEGER PRIMARY KEY, price INTEGER)');   // своя цена за месяц, влодинки

const tok = () => kv.get('bln_token');        // bln_… директора, право hosting
const sk = () => kv.get('sk_live');           // секретный ключ эквайринга
const whsec = () => kv.get('whsec');
const gov = (method, path, body) => fetch(API + path, {
  method, headers: { authorization: 'Bearer ' + tok(), 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
}).then(async (r) => ({ status: r.status, data: await r.json() }));
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const money = (v) => (v / 100).toLocaleString('ru-RU') + ' ВЛ';
const page = (title, body) => Response.html(`<!doctype html><html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(title)} — ВасяХост</title>
<style>body{font-family:system-ui;max-width:860px;margin:24px auto;padding:0 16px}.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(220px,1fr));gap:12px}.card{border:1px solid #ddd;border-radius:12px;padding:16px}</style></head>
<body><h1><a href="/">ВасяХост</a></h1>${body}</body></html>`);

async function plans() {
  const r = await fetch(`${API}/hosting/plans?org_id=${ORG}`);      // публично, без токена
  const { offers } = await r.json();
  const own = Object.fromEntries(db.query('SELECT * FROM prices').map((p) => [p.plan_id, p.price]));
  return offers.map((o) => ({ ...o, price: own[o.id] ?? o.price_month }));
}

async function createPayment(order) {
  const r = await fetch(PAY + '/payments', {
    method: 'POST',
    headers: { authorization: 'Bearer ' + sk(), 'content-type': 'application/json', 'idempotency-key': 'order-' + order.id },
    body: JSON.stringify({ amount: order.amount, description: `Хостинг ВасяХост, заказ №${order.id}`, return_url: `${SITE}/order/${order.id}`, metadata: { order: String(order.id) } }),
  });
  const p = await r.json();
  if (!r.ok) throw new Error(p.error?.message || 'платёж не создан');
  db.run('UPDATE orders SET payment = ? WHERE id = ?', [p.id, order.id]);
  return p.url;
}

async function fulfil(order) {               // вызывается после оплаты (вебхук или проверка)
  if (order.status === 'done') return;
  let r;
  if (order.kind === 'new') {
    r = await gov('POST', `/orgs/${ORG}/hosting/accounts`, { plan_id: order.plan_id, passport_no: order.passport, months: order.months, note: 'order-' + order.id });
    if (r.status === 200) db.run("UPDATE orders SET status = 'done', account_id = ? WHERE id = ?", [r.data.account_id, order.id]);
  } else {
    r = await gov('POST', `/orgs/${ORG}/hosting/accounts/${order.account_id}/extend`, { months: order.months });
    if (r.status === 200) db.run("UPDATE orders SET status = 'done' WHERE id = ?", [order.id]);
  }
  if (r.status !== 200) {
    console.error('выдача не удалась', order.id, r.data.message);
    db.run("UPDATE orders SET status = 'failed' WHERE id = ?", [order.id]);
    // деньги вернуть: POST /api/v1/refunds { payment }
    await fetch(PAY + '/refunds', { method: 'POST', headers: { authorization: 'Bearer ' + sk(), 'content-type': 'application/json' }, body: JSON.stringify({ payment: order.payment, reason: r.data.message }) });
  }
}

export async function onRequest(req) {
  // Главная: тарифы
  if (req.path === '/') {
    const list = await plans();
    return page('Тарифы', `<div class="grid">${list.map((p) => `<div class="card"><h3>${esc(p.name)}</h3>
      <p>${p.kind === 'virtual' ? 'Серверный код, SQLite, cron' : 'Статика'} · ${p.disk_mb} МБ · до ${p.max_sites} сайтов</p>
      <p><b>${money(p.price)}</b> / игр. месяц</p>
      <form method="post" action="/order"><input type="hidden" name="plan" value="${p.id}">
      <input name="passport" placeholder="Номер паспорта БФ" required> <select name="months">${[1, 3, 6, 12].map((m) => `<option>${m}</option>`).join('')}</select>
      <button>Купить</button></form></div>`).join('')}</div>
      <p><a href="/renew">Продлить хостинг</a></p>`);
  }
  // Заказ нового хостинга
  if (req.path === '/order' && req.method === 'POST') {
    const f = await req.form();
    const plan = (await plans()).find((p) => p.id === Number(f.get('plan')));
    if (!plan) return page('Ошибка', 'Тариф не найден');
    const months = Math.max(1, Math.min(12, Number(f.get('months')) || 1));
    const ins = db.run("INSERT INTO orders (kind, plan_id, months, passport, amount, status, at) VALUES ('new', ?, ?, ?, ?, 'pending', ?)",
      [plan.id, months, String(f.get('passport')).trim(), plan.price * months, gameTime()]);
    const order = db.get('SELECT * FROM orders WHERE id = ?', [ins.lastInsertRowid]);
    return Response.redirect(await createPayment(order));
  }
  // Продление: по номеру аккаунта
  if (req.path === '/renew') {
    if (req.method !== 'POST') return page('Продление', `<form method="post"><input name="account" placeholder="Номер аккаунта (u41 → 41)" required> <input name="months" value="1"> <button>Оплатить</button></form>`);
    const f = await req.form();
    const aid = Number(String(f.get('account')).replace(/\D/g, ''));
    const acc = await gov('GET', `/orgs/${ORG}/hosting/accounts/${aid}`);
    if (acc.status !== 200) return page('Ошибка', 'Аккаунт не найден у нашего хостинга');
    const price = (await plans()).find((p) => p.id === acc.data.account.plan_id)?.price;
    const months = Math.max(1, Math.min(12, Number(f.get('months')) || 1));
    const ins = db.run("INSERT INTO orders (kind, plan_id, months, account_id, amount, status, at) VALUES ('renew', ?, ?, ?, ?, 'pending', ?)",
      [acc.data.account.plan_id, months, aid, price * months, gameTime()]);
    return Response.redirect(await createPayment(db.get('SELECT * FROM orders WHERE id = ?', [ins.lastInsertRowid])));
  }
  // Возврат покупателя после оплаты: статус проверяем у банка, параметрам адреса не доверяем
  const m = /^\/order\/(\d+)$/.exec(req.path);
  if (m) {
    const order = db.get('SELECT * FROM orders WHERE id = ?', [Number(m[1])]);
    if (!order) return page('Заказ', 'Нет такого заказа');
    if (order.status === 'pending' && order.payment) {
      const p = await (await fetch(`${PAY}/payments/${order.payment}`, { headers: { authorization: 'Bearer ' + sk() } })).json();
      if (p.status === 'paid') { db.run("UPDATE orders SET status = 'paid' WHERE id = ?", [order.id]); await fulfil({ ...order, status: 'paid' }); }
    }
    const o = db.get('SELECT * FROM orders WHERE id = ?', [order.id]);
    return page('Заказ', o.status === 'done'
      ? `<p>Готово! Аккаунт <b>u${o.account_id}</b>. Управление — на <a href="https://hosting.bln/#/cabinet" target="_top">hosting.bln → Мои хостинги</a>.</p>`
      : `<p>Статус заказа: ${esc(o.status)}</p>`);
  }
  // Вебхук эквайринга
  if (req.path === '/webhooks/pay' && req.method === 'POST') {
    const body = await req.text();
    const sig = req.headers.get('vlod-signature') || '';
    const t = (/t=(\d+)/.exec(sig) || [])[1];
    const v1 = (/v1=([0-9a-f]+)/.exec(sig) || [])[1] || '';
    if (!crypto.timingSafeEqual(crypto.hmac('sha256', whsec(), t + '.' + body), v1)) return new Response('bad signature', { status: 400 });
    const e = JSON.parse(body);
    if (e.type === 'payment.succeeded') {
      const order = db.get("SELECT * FROM orders WHERE payment = ? AND status = 'pending'", [e.data.object.id]);
      if (order) { db.run("UPDATE orders SET status = 'paid' WHERE id = ?", [order.id]); await fulfil({ ...order, status: 'paid' }); }
    }
    return new Response('ok');
  }
  return new Response('Не найдено', { status: 404 });
}

// Раз в игровые сутки: приостановить клиентов, у которых срок вышел (госхостинг сделает это и сам), напомнить о продлении и т. п.
export async function onCron(job) {
  const r = await gov('GET', `/orgs/${ORG}/hosting/accounts`);
  for (const a of r.data.accounts || []) if (a.paid_until_month - r.data.month <= 1) console.log('скоро истекает', a.id, a.owner_name);
}
```
Для вебхуков в кабинете pay.bank.bln укажите адрес `https://vasyahost.bln/webhooks/pay`. В `crontab`: `0 6 * * * напоминания`.

### 7.5. Что ещё может сайт хостера
- **Продавать домены.** Если ваша организация — аккредитованный регистратор, домен клиенту покупается через `POST /api/gov/domains { name, registrar_org_id }` от имени клиента (клиент делает это сам по своему токену). Свои розничные цены — `PUT /api/gov/orgs/:id/prices { tld_id, price }`.
- **Выпускать сертификаты** клиентам как свой УЦ: `POST /api/gov/certs/org-ca` (нужна лицензия УЦ), цены — `PATCH /api/gov/certs/org-ca/:id { prices }`.
- **Свои почтовые сервисы.** Почта для домена — `/api/mail/domains`, свой SMTP — через `onMail` и `mail.send`.
- **Статистика** по клиентам: `used_bytes`, сайты, сроки — из `GET …/hosting/accounts`.
- **Панель управления на своём сайте.** Клиент выпускает свой токен с правом `hosting` и вставляет его на ваш сайт. Тогда ваш `server.js` может грузить его файлы (`PUT /api/gov/hosting/:id/sites/:sid/file`), подключать имена, читать логи и выпускать SSL. Держите токены клиентов только на сервере.

---

## 8. Домены, DNS, регистраторы, аукционы

Право `domains`. Пути от `/api/gov`.

| Метод и путь | Тело / query | Что делает |
|---|---|---|
| `GET /domains/zones` | — | зоны (TLD), их регистры, цены регистраторов (публично) |
| `GET /domains/check?name=x.bln` | — | свободен ли, цены (публично) |
| `GET /domains` | — | мои домены |
| `POST /domains` | `name`, `registrar_org_id?`, `years?`, `owner_org_id?` | купить → `{ invoice }` (квитанция; оплатить во ВлодБанке или `POST /api/bank/invoices/:номер/pay` по праву `pay`) |
| `GET /domains/:id` | — | домен, записи, NS, DNSSEC, WHOIS |
| `POST /domains/:id/renew` | `years` | продлить → квитанция |
| `POST /domains/:id/records` | `name` (`@`, `www`, `api`…), `type`, `ttl?`, `data` | DNS-запись |
| `PATCH /domains/:id/records/:rid` | те же поля | изменить |
| `DELETE /domains/:id/records/:rid` | — | удалить |
| `POST /domains/:id/nameservers` | `mode` (`hosted` — DNS-хостинг БалНета \| `custom`), `ns` [имена] | свои NS |
| `POST /domains/:id/dnssec` | `enabled` | DNSSEC |
| `POST /domains/:id/privacy` | `privacy` | скрыть WHOIS |
| `POST /domains/:id/auth-code` | — | код передачи |
| `POST /domains/:id/transfer-registrar` | `registrar_org_id`, `auth_code` | сменить регистратора |
| `POST /domains/claim` | `name`, `auth_code`, `owner_org_id?` | принять домен от другого владельца |
| `POST /auctions/:id/bid` | `amount` | ставка на освободившийся домен |

Типы записей: `A`, `AAAA`, `CNAME`, `MX` (`data: "10 mx.mail.bln."`), `TXT`, `NS`, `CAA`, `SRV`, `PTR` (обратные — ставит хостер). TTL — в игровых секундах.

**Организации и регистраторы** (`/orgs`):
`GET /orgs`, `POST /orgs/apply { kind: 'llc'|'jsc', name }` (ООО или АО; ИП оформляется документом `POST /api/gov/documents/ip`), `GET /orgs/:id`, `POST /orgs/:id/members { passport }`, `DELETE /orgs/:id/members/:uid`, `POST /orgs/:id/transfer { amount, to, memo }` (перевод со счёта организации), `POST /orgs/:id/pay-invoice { number }` (оплатить квитанцию со счёта организации), `POST /orgs/:id/licenses { kind }` (`hosting`, `registrar`, `ca`; `registry` выдаёт только администрация), `PUT /orgs/:id/prices { tld_id, price }` (розница регистратора), `PUT /orgs/:id/registry/:tld { wholesale_price }` (опт для регистра своей зоны).

Публично без входа: `GET /api/net/whois?q=…` и DNS-запросы `POST /api/net/resolve { client_id, name, type }` (их использует терминал браузера, см. Приложение А).

---

## 9. Хостинг

### Клиент (свой аккаунт)
Право `hosting`. `:id` — аккаунт, `:sid` — сайт (подключённое имя).

| Метод и путь | Тело / query | Что делает |
|---|---|---|
| `GET /hosting/plans?org_id=` | — | витрина (без `org_id` — только госхостинг и `listed`-тарифы) |
| `GET /hosting` | — | мои аккаунты + витрина |
| `POST /hosting` | `plan_id`, `months`, `owner_org_id?` | купить по квитанции (работает и для скрытого тарифа, если знаете id) |
| `GET /hosting/:id` | — | аккаунт: сайты, место, SSH, срок |
| `POST /hosting/:id/renew` | `months` | продлить → квитанция |
| `POST /hosting/:id/sites` | `host` | подключить имя → `{ id, host, ip }`; поставьте A-запись на `ip` |
| `DELETE /hosting/:id/sites/:sid` | — | отключить имя (файлы удаляются) |
| `GET /hosting/:id/sites/:sid/files?path=` | — | список файлов |
| `GET /hosting/:id/sites/:sid/file?path=` | — | файл |
| `PUT /hosting/:id/sites/:sid/file` | `path`, `content`, `binary?` (тогда `content` в base64) | записать файл |
| `POST /hosting/:id/sites/:sid/mkdir` | `path` | каталог |
| `POST /hosting/:id/sites/:sid/rename` | `from`, `to` | переименовать |
| `DELETE /hosting/:id/sites/:sid/file?path=` | — | удалить |
| `POST /hosting/:id/sites/:sid/zip` | `data` (base64 ZIP), `path?` | распаковать |
| `POST /hosting/:id/sites/:sid/example` | `overwrite?` | положить пример server.js |
| `GET /hosting/:id/sites/:sid/logs` / `DELETE` | — | журнал console.log и ошибок |
| `POST /hosting/:id/sites/:sid/sql` | `sql` | SQL-консоль базы сайта |
| `GET /hosting/:id/sites/:sid/kv` | — | содержимое key-value |
| `GET /hosting/:id/sites/:sid/analytics?days=` | — | просмотры, посетители, источники, запросы из поиска |
| `GET`/`POST /hosting/:id/sites/:sid/dkim` | `selector` | ключ DKIM для почты сайта |
| `POST /hosting/:id/ssh` | `password` | пароль SSH |
| `POST /hosting/:id/sites/:sid/ssl` | — | бесплатный DV-сертификат (право `certs`) |
| `PUT /hosting/:id/sites/:sid/cert` | `cert_id` | поставить свой сертификат (право `certs`) |

Пример: выложить сайт по API.
```js
const H = { authorization: 'Bearer bln_…', 'content-type': 'application/json' };
await fetch('https://hosting.bln/api/gov/hosting/41/sites/77/file', { method: 'PUT', headers: H, body: JSON.stringify({ path: 'index.html', content: '<h1>Привет</h1>' }) });
```

### Хостер (организация)
См. раздел 7: `GET /orgs/:id/hosting`, `POST /orgs/:id/servers`, `POST /orgs/:id/plans`, `PATCH /orgs/:id/plans/:pid`, `/orgs/:id/hosting/accounts…`.

---

## 10. Сертификаты HTTPS и удостоверяющие центры

Право `certs`. Пути от `/api/gov`.
| Метод и путь | Тело | Что делает |
|---|---|---|
| `GET /certs/cas` | — | УЦ в списке доверия (публично) |
| `GET /certs/ct?q=имя` | — | журнал прозрачности (публично) |
| `GET /certs`, `GET /certs/:id`, `GET /certs/:id/files` | — | мои сертификаты, PEM |
| `POST /certs/challenges` | `names` [имена], `method` (`dns` \| `http`) | проверка владения (как ACME): TXT `_acme-challenge` или файл `/.well-known/acme-challenge/…` |
| `POST /certs/challenges/:id/check` | `ca_id` | проверить |
| `POST /certs/orders` | `challenge_id`, `ca_id`, `policy` (`DV` \| `OV` \| `EV`), `owner_org_id?` | выпуск (OV/EV — для организаций, платно) |
| `POST /certs/self` | `names`, `owner_org_id?` | самоподписанный (браузер покажет ошибку) |
| `POST /certs/:id/revoke` | `reason` | отозвать |
| `POST /certs/org-ca` | `org_id`, `name`, `identifier` | свой УЦ (лицензия `ca`) |
| `PATCH /certs/org-ca/:id` | `prices` | цены своего УЦ |

---

## 11. Эквайринг ВлодБанка

Адрес — `https://pay.bank.bln/api/v1`, только с сервера по https. Ключ: `Authorization: Bearer sk_live_…` (секретный) или `pk_live_…` (публичный, годится только для `GET /products`). Ключи выдаются в кабинете pay.bank.bln для ИП или организации с бизнес-счётом.

| Метод и путь | Что делает |
|---|---|
| `GET /me` | проверить ключ, данные магазина |
| `POST /payments` | создать платёж → `{ id: 'pay_…', url, status: 'pending', … }`; отправьте покупателя на `url` |
| `GET /payments?limit=20` | последние |
| `GET /payments/:id` | платёж (**проверяйте статус здесь**, а не по параметрам return_url) |
| `POST /payments/:id/cancel` | отменить неоплаченный |
| `GET /payments/:id/refunds` | возвраты платежа |
| `POST /refunds` | `{ payment, amount?, reason? }` — без amount вернётся весь остаток. НДС возвращается, **комиссия банка — нет** |
| `POST /subscriptions` | `{ amount, description, period_months, return_url }` → `{ id: 'sub_…', url }` |
| `GET /subscriptions`, `GET /subscriptions/:id`, `POST /subscriptions/:id/cancel` | подписки |
| `GET /products` | каталог товаров Кассы «Продаётся онлайн» + варианты доставки |
| `POST /orders` | `{ items: [{product_id, qty}], delivery: 'pickup'\|'courier'\|'digital'\|'physical', address?, contact?, return_url }` → заказ + платёж |
| `GET /orders`, `GET /orders/:id` | заказы |
| `POST /orders/:id/refund` | `{ items?: [{product_id, qty}] }` — возврат через чек Кассы, товар возвращается на склад |
| `GET /events`, `GET /events/:id` | журнал событий (вебхуков) |

**`POST /payments`, поля:** `amount` (влодинки, с НДС), `description`, `return_url` (добавятся `?payment=pay_…&status=paid|cancelled`), `cancel_url?`, `items?` ([{name, qty, price}], сумма = amount), `metadata?` (до 20 ключей), `age_limit?` (18 — платит только совершеннолетний по паспорту), `expires_minutes?` (60). Заголовок `Idempotency-Key`: повтор с тем же ключом вернёт тот же платёж.

**Статусы:** `pending` → `paid` | `cancelled` | `expired`; после возвратов — `partially_refunded`, `refunded`. После оплаты: `vat` (НДС ушёл в бюджет), `fee` (комиссия), `net` (зачислено вам).

**Вебхуки.** POST с сервера `50.1.0.10`. Заголовки: `Vlod-Event-Id: evt_…`, `Vlod-Signature: t=…,v1=…` — HMAC-SHA256 секретом `whsec_…` от строки `t + "." + тело`. Отвечайте 2xx. При ошибке будут повторы через 1, 5, 30 минут, 2 и 6 часов. События: `payment.succeeded`, `payment.cancelled`, `refund.succeeded`, `subscription.activated`, `subscription.renewed`, `subscription.payment_failed`, `subscription.cancelled`, `order.paid`, `order.ready`, `order.delivering`, `order.delivered`, `order.approved`, `order.shipped`, `order.refunded`, `ping`. Пример проверки подписи — в разделе 7.4.

**Ошибки эквайринга:** `{ "error": { "code": "…", "message": "…" } }` с HTTP 400/401/403/404/409.

---

## 12. Вход через ВлодПочту и ВлодУслуги (OAuth 2 + PKCE)

Приложение и адреса возврата регистрируются во ВлодПочте: `mail.bln → Разработчикам` → `client_id` (`cl_…`) и `client_secret` (`cs_…`).

| Провайдер | authorize | scope |
|---|---|---|
| ВлодПочта | `https://mail.bln/oauth/authorize` | `openid profile email` |
| ВлодУслуги | `https://gosuslugi.gov.bln/oauth/authorize` | `openid profile age passport` |

1. Сайт отправляет пользователя на страницу входа: `authorize?response_type=code&client_id=…&redirect_uri=…&scope=…&state=…&code_challenge=…&code_challenge_method=S256`.
2. Пользователь возвращается с кодом. Ваш сервер обменивает его: `POST https://<провайдер>/oauth/token`, тело `application/x-www-form-urlencoded`: `grant_type=authorization_code`, `code`, `redirect_uri`, `client_id`, `client_secret`, `code_verifier` → `{ access_token, … }`.
3. Данные пользователя: `GET https://<провайдер>/oauth/userinfo` с `Authorization: Bearer <access_token>` → `{ sub, name, email, email_verified }`. Для ВлодУслуг с `age` — `age_over_14/16/18/21`, с `passport` — данные паспорта.

Правила: код живёт 10 минут и одноразовый, токен живёт час. `sub` постоянный, но **свой для каждого приложения**. Настройки провайдера — `/.well-known/openid-configuration`. Полный пример с PKCE: `pay.bank.bln/#/docs?s=oauth`.

> Удобно для сайта хостинга: «Войти через ВлодУслуги» со scope `passport` даёт номер паспорта клиента. Его можно сразу передать в `passport_no` при выдаче аккаунта, и клиенту не придётся вводить номер.

---

## 13. Почта

- **Отправка из кода:** `await mail.send({ from: 'robot@ваш.bln', to: 'vera@mail.bln' /* или массив */, subject, text, html?, replyTo?, inReplyTo?, headers?, dkim? })`. Письмо уходит с IP сервера по MX получателя. Чтобы его не считали спамом, настройте SPF (`TXT "v=spf1 ip4:<IP сервера> -all"`), DKIM (`…/sites/:sid/dkim`) и DMARC.
- **Приём:** MX домена на ваш сервер → `export function onMail(msg)`. Поля `msg`: `from`, `to`, `mailFrom`, `ip`, `helo`, `subject`, `text`, `html`, `messageId`, `headers`, `raw`, `auth: { spf, dkim, dkim_domain, dmarc, dmarc_policy }`. Чтобы отклонить письмо, верните `false` или `{ reject: 'причина' }`.
- **Почта на своём домене во ВлодПочте:** `/api/mail/domains` (добавить, проверить, авто-DNS, адреса, catch-all).
- **Ящик пользователя** по праву `mail`: `/api/mail/messages`, `/api/mail/send` и др. (Приложение А).

---

## 14. Web Push

1. На странице сайта (shim): `Notification.requestPermission()`, `navigator.serviceWorker.register('/sw.js')`, `reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey })` — как в настоящем браузере. Подписку `endpoint` + `keys` отправьте на свой сервер.
2. На сервере: `const keys = webpush.generateVAPIDKeys()` (один раз, сохраните в kv), затем
   `await webpush.sendNotification(subscription, { title, body, url }, { vapidDetails: { subject: 'mailto:robot@ваш.bln', publicKey, privateKey } })`.
   Шифрование `aes128gcm` и подпись VAPID делает хост, запрос уходит на `https://push.bln/…`. Код 404/410 значит, что подписка мертва: удалите её.
3. Уведомления приходят во ВлодБраузер, а если пользователь включил настоящий Web Push — и на его телефон.

---

## 15. БалНовости

Право `news`. Сайт — `novosti.bln`.
| Метод и путь | Тело / query | Что делает |
|---|---|---|
| `GET /api/news/meta` | — | рубрики: `politics`, `economy`, `society`, `tech`, `culture`, `sport` |
| `GET /api/news/feed` | `outlet?`, `category?`, `q?`, `page?` | лента (публично) |
| `GET /api/news/articles/:id` | — | статья |
| `GET /api/news/outlets`, `GET /api/news/outlets/:slug` | `page?` | редакции и их ленты |
| `GET /api/news/me` | — | мои СМИ |
| `POST /api/news/outlets` | `slug` (латиница, 3–40), `title`, `description?`, `rss_url?` | зарегистрировать СМИ (до 3) |
| `PATCH /api/news/outlets/:slug` | `title?`, `description?`, `rss_url?` | изменить |
| `POST /api/news/outlets/:slug/fetch` | — | забрать RSS/Atom сейчас → `{ added, error }` |
| `POST /api/news/outlets/:slug/articles` | `title`, `body`, `summary?`, `category?`, `author?` | опубликовать |
| `DELETE /api/news/articles/:id` | — | удалить свою |

RSS-ленту СМИ агрегатор забирает сам раз в игровой месяц. Статьи попадают во вкладку «Новости» ВлодПоиска. Хостинг-компании удобно вести так блог и объявления: новые тарифы, техработы.

---

## 16. ВлодПоиск: вебмастер, реклама

Право `search`. Публично: `GET /api/search/search?q=&tab=web|images|news|products&page=`, `GET /api/search/suggest?q=`, `GET /api/search/trends`.

- **Вебмастер:**
  - `POST /api/search/webmaster/sites { host }`;
  - подтверждение прав: `POST …/:id/verify { method: 'dns' }` — TXT-запись, которую покажет ответ;
  - `POST …/:id/recrawl { url }` — переобойти;
  - `POST …/:id/inspect { url }` — как робот видит страницу;
  - `POST …/:id/sitemaps { url }`;
  - `PATCH …/:id { adnet: true }` — включить рекламную сеть на сайте, вы получаете долю.
- **Реклама:**
  - `GET /api/search/ads/account`;
  - `POST /api/search/ads/topup { amount }`, `POST /api/search/ads/withdraw`;
  - `POST /api/search/ads/campaigns` — ключевые слова, ставка за клик, дневной бюджет, объявление;
  - `PATCH /api/search/ads/campaigns/:id`;
  - `GET /api/search/ads/forecast?q=` — прогноз.

  Аукцион второй цены, доход идёт в госбюджет.
- **Робот VlodBot** слушается `robots.txt`, `sitemap.xml`, `<meta name="robots" content="noindex">`, `rel=canonical`. Статьи с `og:type=article` попадают в новости.

---

## 17. ВлодБанк по токену и госуслуги

- Право **`pay`**: `GET /api/bank/accounts` (счета), `GET /api/bank/invoices/:номер`, `POST /api/bank/invoices/:номер/pay { account_id }`. Так сервер может сам оплачивать квитанции за домены, хостинг, лицензии и аренду со счёта гражданина, который связан с паспортом. Чтобы оплатить со счёта организации, используйте `POST /api/gov/orgs/:id/pay-invoice { number }` с правом `domains` или `hosting`.
- Право **`services`**: `GET /api/gov/invoices` (все мои квитанции), заявления, документы (`POST /api/gov/documents/:type`: `inn`, `ip`, `license`…), налоги, штрафы, пособия, имущество, обращения, работа, выборы, врач, страховка, сделки — см. Приложение А, раздел `/api/gov (gov-ext)`.

Переводы, кредиты, вклады и карты через токен **недоступны**: это только интернет-банк ВлодБанка.

---

## 18. Что умеет страница сайта в браузере

Страницы сайтов работают во ВлодБраузере в песочнице (iframe без allow-same-origin). Shim подставляет браузерные API, привязанные к домену БалНета:
- `document.cookie`, `localStorage`, `sessionStorage` — у каждого домена БалНета свои;
- `fetch` / `XMLHttpRequest` к своему сайту и другим сайтам БалНета (CORS проверяется по заголовкам сайта-получателя);
- `WebSocket` к сайтам БалНета;
- `window.open`, ссылки и формы работают в рамках браузера;
- `Notification`, `navigator.serviceWorker`, `PushManager` (раздел 14);
- баннеры рекламной сети, если сайт подключён к ней.

Нельзя: обращаться к API госсайтов со страницы, выходить в настоящий интернет, читать cookie других доменов. **Секреты (токены, ключи) никогда не кладите в HTML/JS страницы.**

---

## 19. Ошибки, деньги, время

- **REST-API государства:** `{ "error": "код", "message": "Сообщение", ...}` + HTTP-код. Частые коды:
  - `unauthorized` (401), `forbidden` (403), `not_found` (404);
  - `invalid` (400) — неверное поле, текст в `message`;
  - `insufficient_funds`, `no_passport`, `server_full`, `limit`, `taken`, `order_pending` (400);
  - `conflict`/`exists` (409).
- **Деньги** — целые влодинки. На покупки выставляется квитанция (`invoice` — номер вида `KV…`), оплатить её можно во ВлодБанке или по праву `pay`. НДС включён в цену, ставку задаёт админ.
- **Повтор POST:** заголовок `Idempotency-Key` поддерживают эквайринг и переводы.
- **Время:** месяцы и сутки игровые. Номер текущего месяца — `GET /api/clock` → `{ month, paused, minutes, last_tick_at, next_tick_at }`. `gameTime()` отдаёт игровые секунды (месяц = 2 592 000).
- **Лимиты:** запросы к API ограничены по частоте. Для серверного кода сайта действуют лимиты тарифа (rpm, CPU).

---

## 20. Чек-лист для ИИ-кодера: сайт хостинга

1. Виртуальный тариф, `server.js`, своя база заказов в `db`.
2. Секреты (`bln_token` с правом `hosting`, `sk_live`, `whsec`) — в `kv`, вне репозитория и HTML.
3. Витрина: `GET https://hosting.bln/api/gov/hosting/plans?org_id=ORG` плюс свои цены.
4. Заказ: паспорт клиента (или «Войти через ВлодУслуги», scope `passport`) → `POST pay.bank.bln/api/v1/payments` с `Idempotency-Key` → редирект на `url`.
5. Подтверждение: вебхук `payment.succeeded` с проверкой подписи **и/или** `GET /payments/:id` на странице возврата.
6. Выдача: `POST /api/gov/orgs/ORG/hosting/accounts { plan_id, passport_no, months, note }`. При ошибке — `POST /api/v1/refunds`.
7. Продление: `POST …/accounts/:aid/extend { months }` после оплаты.
8. Кабинет клиента на вашем сайте (по желанию): клиент даёт свой токен `hosting` → вы показываете его файлы, логи, SSL.
9. Следите за счётом организации: аренда серверов и лицензия списываются каждый игровой месяц.
10. Тарифы по умолчанию скрыты с hosting.bln (`listed: false`). Чтобы выйти на госвитрину — `PATCH /orgs/ORG/plans/:pid { listed: true }`.
11. Страница сайта — обычный HTML/JS. Все вызовы API делает только сервер.

---

## Приложение А. Все маршруты API

Собрано автоматически из кода сервера. «Доступ»:
- **публично** — без входа;
- **гражданин** — вход ВлодУслуг (cookie) **или токен `bln_…`**, если путь подходит под его право (раздел 6);
- **банк** — вход ВлодБанка (по токену — только пути права `pay`);
- **Касса** — вход в Кассу (по токену недоступно);
- **служащий** — роль госслужащего (полиция, налоговая, врач, кассир банка).

В «Параметрах» перечислены поля тела и query, которые читает обработчик. Параметры пути (`:id`) — в самом пути. Пути эквайринга `pay.bank.bln/api/v1` и OAuth — в разделах 11–12.

#### /api (auth)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| POST | `/api/auth/bank/register` | публично | тело: `email`, `password`, `full_name`, `birth_date`, `passport_no`, `lang` |
| POST | `/api/auth/gov/register` | публично | тело: `email`, `password`, `display_name`, `lang` |
| POST | `/api/auth/:kind/login` | публично | тело: `email`, `password` |
| POST | `/api/auth/:kind/code/send` | публично | тело: `email` |
| POST | `/api/auth/:kind/code/verify` | публично | тело: `email`, `code` |
| POST | `/api/auth/:kind/logout` | публично |  |
| GET | `/api/auth/me` | публично |  |
| POST | `/api/auth/:kind/password` | публично | тело: `password`, `old_password` |
| POST | `/api/auth/:kind/lang` | публично | тело: `lang` |
| POST | `/api/auth/bank/via-gov` | публично |  |

#### /api (common)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| GET | `/api/public/settings` | публично |  |
| GET | `/api/clock` | публично | query: `kind` |
| GET | `/api/notifications` | публично |  |
| POST | `/api/notifications/read` | публично | тело: `ids` |

#### /api/gov (gov)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| GET | `/api/gov/api-tokens` | гражданин |  |
| POST | `/api/gov/api-tokens` | гражданин |  |
| DELETE | `/api/gov/api-tokens/:id` | гражданин |  |
| GET | `/api/gov/me` | гражданин |  |
| POST | `/api/gov/passport` | гражданин |  |
| GET | `/api/gov/passport` | гражданин |  |
| GET | `/api/gov/documents` | гражданин |  |
| POST | `/api/gov/documents/:type` | гражданин | тело: `trade_name`, `activity`, `categories`, `country_id`, `spouse_passport`, `child_birth_date`, `child_name` |
| GET | `/api/gov/applications` | гражданин |  |
| POST | `/api/gov/applications/:id/cancel` | гражданин |  |
| GET | `/api/gov/invoices` | гражданин |  |
| GET | `/api/gov/invoices/:no` | публично |  |
| GET | `/api/gov/links` | гражданин |  |
| POST | `/api/gov/links/:id/:decision` | гражданин |  |
| GET | `/api/gov/verify/passport/:code` | публично |  |
| GET | `/api/gov/verify/document/:code` | публично |  |
| GET | `/api/gov/verify/receipt/:code` | публично |  |
| GET | `/api/gov/queue` | служащий |  |
| POST | `/api/gov/applications/:id/approve` | служащий |  |
| POST | `/api/gov/applications/:id/reject` | служащий | тело: `comment` |
| GET | `/api/gov/citizens` | служащий | query: `q` |
| GET | `/api/gov/citizens/:id` | служащий |  |

#### /api/gov (gov-ext)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| GET | `/api/gov/news` | публично | query: `limit` |
| GET | `/api/gov/countries` | публично |  |
| GET | `/api/gov/fine-articles` | публично |  |
| GET | `/api/gov/taxes` | гражданин |  |
| POST | `/api/gov/taxes/declarations/:id/submit` | гражданин | тело: `income` |
| GET | `/api/gov/fines` | гражданин |  |
| POST | `/api/gov/fines/:id/appeal` | гражданин | тело: `text` |
| GET | `/api/gov/benefits` | гражданин |  |
| POST | `/api/gov/benefits` | гражданин | тело: `kind` |
| GET | `/api/gov/properties` | гражданин |  |
| GET | `/api/gov/properties/market` | публично | query: `kind` |
| POST | `/api/gov/properties/:id/sell` | гражданин | тело: `unlist`, `buyer_passport`, `price` |
| POST | `/api/gov/properties/:id/buy` | гражданин |  |
| POST | `/api/gov/deals/:id/cancel` | гражданин |  |
| GET | `/api/gov/doctor` | гражданин |  |
| POST | `/api/gov/doctor/slots/:id/book` | гражданин | тело: `complaint` |
| POST | `/api/gov/doctor/slots/:id/cancel` | гражданин |  |
| POST | `/api/gov/insurance` | гражданин |  |
| GET | `/api/gov/elections` | гражданин |  |
| POST | `/api/gov/elections/:id/nominate` | гражданин | тело: `program` |
| POST | `/api/gov/elections/:id/withdraw` | гражданин |  |
| POST | `/api/gov/elections/:id/vote` | гражданин | тело: `candidate_id` |
| GET | `/api/gov/appeals` | гражданин |  |
| POST | `/api/gov/appeals` | гражданин | тело: `addressee`, `subject`, `body` |
| GET | `/api/gov/work/appeals` | служащий | query: `status` |
| POST | `/api/gov/work/appeals/:id/answer` | служащий | тело: `answer` |
| GET | `/api/gov/work/police/citizen` | служащий | query: `passport` |
| POST | `/api/gov/work/police/fines` | служащий | тело: `passport_no`, `article_id`, `text`, `amount`, `note` |
| GET | `/api/gov/work/police/fines` | служащий | query: `all` |
| GET | `/api/gov/work/tax/declarations` | служащий | query: `status` |
| GET | `/api/gov/work/tax/debtors` | служащий |  |
| POST | `/api/gov/work/tax/assess` | служащий | тело: `passport_no`, `amount`, `purpose` |
| GET | `/api/gov/work/doctor` | служащий |  |
| POST | `/api/gov/work/doctor/slots` | служащий | тело: `starts_at`, `duration_min`, `count`, `priority` |
| POST | `/api/gov/work/doctor/slots/:id/conclude` | служащий | тело: `conclusion` |
| POST | `/api/gov/work/doctor/slots/:id/cancel` | служащий |  |
| GET | `/api/gov/work/benefits` | служащий | query: `status` |
| POST | `/api/gov/work/benefits/:id/decide` | служащий | тело: `approve`, `note` |
| POST | `/api/gov/work/benefits/:id/stop` | служащий | тело: `note` |

#### /api/gov (domains)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| GET | `/api/gov/orgs` | гражданин |  |
| POST | `/api/gov/orgs/apply` | гражданин | тело: `kind`, `name` |
| GET | `/api/gov/orgs/:id` | гражданин |  |
| POST | `/api/gov/orgs/:id/members` | гражданин | тело: `passport` |
| DELETE | `/api/gov/orgs/:id/members/:uid` | гражданин |  |
| POST | `/api/gov/orgs/:id/transfer` | гражданин | тело: `amount`, `to`, `memo` |
| POST | `/api/gov/orgs/:id/pay-invoice` | гражданин | тело: `number` |
| POST | `/api/gov/orgs/:id/licenses` | гражданин | тело: `kind` |
| PUT | `/api/gov/orgs/:id/prices` | гражданин | тело: `tld_id`, `price` |
| PUT | `/api/gov/orgs/:id/registry/:tld` | гражданин | тело: `wholesale_price` |
| GET | `/api/gov/domains/zones` | публично |  |
| GET | `/api/gov/domains/check` | публично | query: `name` |
| GET | `/api/gov/domains` | гражданин |  |
| POST | `/api/gov/domains` | гражданин | тело: `name`, `registrar_org_id`, `years`, `owner_org_id` |
| GET | `/api/gov/domains/:id` | гражданин |  |
| POST | `/api/gov/domains/:id/renew` | гражданин | тело: `years` |
| POST | `/api/gov/domains/:id/transfer-registrar` | гражданин | тело: `registrar_org_id`, `auth_code` |
| POST | `/api/gov/domains/claim` | гражданин | тело: `name`, `auth_code`, `owner_org_id` |
| POST | `/api/gov/domains/:id/auth-code` | гражданин |  |
| POST | `/api/gov/domains/:id/privacy` | гражданин | тело: `privacy` |
| POST | `/api/gov/domains/:id/nameservers` | гражданин | тело: `mode`, `ns` |
| POST | `/api/gov/domains/:id/dnssec` | гражданин | тело: `enabled` |
| POST | `/api/gov/domains/:id/records` | гражданин |  |
| PATCH | `/api/gov/domains/:id/records/:rid` | гражданин | тело: `name`, `type`, `ttl`, `data` |
| DELETE | `/api/gov/domains/:id/records/:rid` | гражданин |  |
| POST | `/api/gov/auctions/:id/bid` | гражданин | тело: `amount` |

#### /api/gov (hosting)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| GET | `/api/gov/hosting/plans` | публично | query: `org_id` |
| GET | `/api/gov/hosting` | гражданин |  |
| POST | `/api/gov/hosting` | гражданин | тело: `plan_id`, `months`, `owner_org_id` |
| GET | `/api/gov/hosting/:id` | гражданин |  |
| POST | `/api/gov/hosting/:id/renew` | гражданин | тело: `months` |
| POST | `/api/gov/hosting/:id/sites` | гражданин | тело: `host` |
| DELETE | `/api/gov/hosting/:id/sites/:sid` | гражданин |  |
| GET | `/api/gov/hosting/:id/sites/:sid/files` | гражданин | query: `path` |
| GET | `/api/gov/hosting/:id/sites/:sid/file` | гражданин | query: `path` |
| PUT | `/api/gov/hosting/:id/sites/:sid/file` | гражданин | тело: `path`, `content`, `binary` |
| POST | `/api/gov/hosting/:id/sites/:sid/mkdir` | гражданин | тело: `path` |
| POST | `/api/gov/hosting/:id/sites/:sid/rename` | гражданин | тело: `from`, `to` |
| DELETE | `/api/gov/hosting/:id/sites/:sid/file` | гражданин | query: `path` |
| POST | `/api/gov/hosting/:id/sites/:sid/zip` | гражданин | тело: `data`, `path` |
| GET | `/api/gov/hosting/:id/sites/:sid/analytics` | гражданин | query: `days` |
| POST | `/api/gov/hosting/:id/ssh` | гражданин | тело: `password` |
| GET | `/api/gov/hosting/:id/sites/:sid/logs` | гражданин |  |
| DELETE | `/api/gov/hosting/:id/sites/:sid/logs` | гражданин |  |
| POST | `/api/gov/hosting/:id/sites/:sid/sql` | гражданин | тело: `sql` |
| GET | `/api/gov/hosting/:id/sites/:sid/kv` | гражданин |  |
| GET | `/api/gov/hosting/:id/sites/:sid/dkim` | гражданин |  |
| POST | `/api/gov/hosting/:id/sites/:sid/dkim` | гражданин | тело: `selector` |
| POST | `/api/gov/hosting/:id/sites/:sid/example` | гражданин | тело: `overwrite` |
| GET | `/api/gov/orgs/:id/hosting` | гражданин |  |
| POST | `/api/gov/orgs/:id/servers` | гражданин |  |
| POST | `/api/gov/orgs/:id/plans` | гражданин | тело: `server_id`, `disk_mb`, `name`, `max_sites`, `price_month`, `listed` |
| PATCH | `/api/gov/orgs/:id/plans/:pid` | гражданин | тело: `active`, `price_month`, `listed` |
| GET | `/api/gov/orgs/:id/hosting/accounts` | гражданин |  |
| GET | `/api/gov/orgs/:id/hosting/accounts/:aid` | гражданин |  |
| POST | `/api/gov/orgs/:id/hosting/accounts` | гражданин | тело: `plan_id`, `passport_no` или `email` или `gov_user_id`, `months`, `note` |
| POST | `/api/gov/orgs/:id/hosting/accounts/:aid/extend` | гражданин | тело: `months` |
| POST | `/api/gov/orgs/:id/hosting/accounts/:aid/status` | гражданин | тело: `status` |
| DELETE | `/api/gov/orgs/:id/hosting/accounts/:aid` | гражданин |  |

#### /api/gov (certs)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| GET | `/api/gov/certs/cas` | публично |  |
| GET | `/api/gov/certs/ct` | публично | query: `q` |
| GET | `/api/gov/certs` | гражданин |  |
| GET | `/api/gov/certs/:id` | гражданин |  |
| GET | `/api/gov/certs/:id/files` | гражданин |  |
| POST | `/api/gov/certs/challenges` | гражданин | тело: `names`, `method` |
| GET | `/api/gov/certs/challenges/:id` | гражданин |  |
| POST | `/api/gov/certs/challenges/:id/check` | гражданин | тело: `ca_id` |
| POST | `/api/gov/certs/orders` | гражданин | тело: `challenge_id`, `ca_id`, `policy`, `owner_org_id` |
| POST | `/api/gov/certs/self` | гражданин | тело: `owner_org_id`, `names` |
| POST | `/api/gov/certs/:id/revoke` | гражданин | тело: `reason` |
| POST | `/api/gov/hosting/:id/sites/:sid/ssl` | гражданин |  |
| PUT | `/api/gov/hosting/:id/sites/:sid/cert` | гражданин | тело: `cert_id` |
| POST | `/api/gov/certs/org-ca` | гражданин | тело: `org_id`, `name`, `identifier` |
| PATCH | `/api/gov/certs/org-ca/:id` | гражданин | тело: `prices` |

#### /api/bank (bank)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| GET | `/api/bank/overview` | банк |  |
| POST | `/api/bank/profile/passport` | публично | тело: `passport_no` |
| GET | `/api/bank/accounts` | банк |  |
| POST | `/api/bank/accounts` | банк | тело: `type`, `name`, `compound`, `term_months` |
| GET | `/api/bank/accounts/:id` | банк | query: `before` |
| POST | `/api/bank/accounts/:id/primary` | банк |  |
| POST | `/api/bank/accounts/:id/rename` | банк | тело: `name` |
| POST | `/api/bank/accounts/:id/close` | банк |  |
| GET | `/api/bank/cards` | банк |  |
| POST | `/api/bank/cards` | банк | тело: `account_id`, `pin`, `background` |
| POST | `/api/bank/cards/:id/freeze` | банк | тело: `frozen` |
| POST | `/api/bank/cards/:id/pin` | публично | тело: `pin` |
| POST | `/api/bank/cards/:id/limits` | банк | тело: `limit_tx`, `limit_daily` |
| POST | `/api/bank/cards/:id/design` | банк | тело: `background` |
| POST | `/api/bank/cards/:id/reissue` | банк | тело: `pin` |
| POST | `/api/bank/cards/:id/close` | банк |  |
| GET | `/api/bank/recipients` | банк | query: `q` |
| POST | `/api/bank/transfers/preview` | банк | тело: `amount`, `to` |
| POST | `/api/bank/transfers` | публично | тело: `amount`, `memo`, `from_account`, `to` |
| POST | `/api/bank/invoices/:no/pay` | банк | тело: `account_id` |
| GET | `/api/bank/qr-pay/:token` | банк |  |
| POST | `/api/bank/qr-pay/:token` | публично | тело: `account_id` |
| GET | `/api/bank/receipts/:saleId` | банк | тело: `token` |
| POST | `/api/bank/atm/session` | публично | тело: `number`, `exp`, `pin` |
| POST | `/api/bank/atm/balance` | публично | тело: `amount` |
| GET | `/api/bank/teller/clients` | служащий | query: `q` |
| GET | `/api/bank/teller/clients/:id` | служащий |  |
| POST | `/api/bank/teller/clients/:id/accounts` | служащий | тело: `type` |
| POST | `/api/bank/teller/clients/:id/cards` | служащий | тело: `account_id`, `pin` |
| POST | `/api/bank/teller/cash` | служащий | тело: `amount`, `direction`, `account_id` |
| GET | `/api/bank/teller/shops` | служащий |  |
| POST | `/api/bank/teller/collection` | служащий | тело: `amount`, `shop_id` |

#### /api/bank (finance)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| GET | `/api/bank/credit` | банк |  |
| POST | `/api/bank/credit-lines` | публично | тело: `limit`, `pin`, `background` |
| POST | `/api/bank/credit-lines/:id/autorepay` | банк | тело: `on` |
| POST | `/api/bank/loans/preview` | банк | тело: `amount`, `months` |
| POST | `/api/bank/loans` | публично | тело: `amount`, `months`, `purpose`, `pay_account_id` |
| POST | `/api/bank/loans/:id/cancel` | банк | тело: `account_id` |
| POST | `/api/bank/child-cards` | публично | тело: `child_name`, `pocket_amount`, `child_email`, `pin`, `background`, `limit_tx`, `limit_daily` |
| POST | `/api/bank/cards/:id/pocket` | банк | тело: `amount` |
| POST | `/api/bank/gift-cards` | публично | тело: `amount`, `from_account`, `pin`, `background`, `holder` |
| POST | `/api/bank/gift-cards/redeem` | публично | тело: `number`, `pin`, `account_id` |
| GET | `/api/bank/autopayments` | банк |  |
| POST | `/api/bank/autopayments` | публично | тело: `amount`, `title`, `remaining`, `kind`, `from_account`, `to`, `start_now` |
| POST | `/api/bank/autopayments/:id/status` | банк | тело: `status` |
| GET | `/api/bank/cashback` | банк |  |
| POST | `/api/bank/cashback` | банк | тело: `category_ids` |

#### /api/bank (bank-gov)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| GET | `/api/bank/state-charges` | банк |  |
| GET | `/api/bank/property` | банк |  |
| POST | `/api/bank/property-deals/:id/pay` | банк | тело: `account_id` |
| POST | `/api/bank/property-deals/:id/loan` | банк | тело: `down_payment`, `months`, `account_id` |

#### /api/bank (pos-ext)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| GET | `/api/bank/debts` | банк |  |
| POST | `/api/bank/debts/:id/pay` | банк | тело: `account_id`, `amount` |

#### /api/pos (pos)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| GET | `/api/pos/cashback-categories` | публично |  |
| GET | `/api/pos/my-shops` | банк |  |
| POST | `/api/pos/shops` | банк | тело: `account_id`, `pin`, `type`, `name`, `color`, `address`, `cashback_category_id` |
| POST | `/api/pos/login` | публично | тело: `shop_id`, `pin` |
| POST | `/api/pos/logout` | публично |  |
| GET | `/api/pos/session` | Касса |  |
| PATCH | `/api/pos/shop` | Касса (владелец) | тело: `logo`, `cashback_category_id`, `loyalty_bp`, `loyalty_max_bp`, `kitchen_enabled`, `name`, `type`, `color`, `address`, `receipt_footer` |
| GET | `/api/pos/staff` | Касса (владелец) |  |
| POST | `/api/pos/staff` | Касса (владелец) | тело: `email`, `pin`, `salary` |
| PATCH | `/api/pos/staff/:id` | Касса (владелец) | тело: `pin`, `salary`, `active` |
| GET | `/api/pos/products` | Касса | query: `all`, `deleted` |
| POST | `/api/pos/products` | Касса (владелец) | тело: `stock_milli` |
| PATCH | `/api/pos/products/:id` | Касса (владелец) |  |
| DELETE | `/api/pos/products/:id` | Касса (владелец) |  |
| POST | `/api/pos/products/:id/restore` | Касса (владелец) |  |
| POST | `/api/pos/stock` | Касса (владелец) | тело: `product_id`, `qty_milli` |
| POST | `/api/pos/shifts/open` | Касса | тело: `opening_float` |
| GET | `/api/pos/shifts/x` | Касса |  |
| POST | `/api/pos/shifts/z` | Касса | тело: `closing_cash` |
| GET | `/api/pos/shifts` | Касса (владелец) |  |
| POST | `/api/pos/sales` | Касса | тело: `items`, `discount`, `tip_pct`, `promo_code`, `loyalty`, `redeem_points`, `source` |
| POST | `/api/pos/preview` | Касса | тело: `items`, `discount`, `promo_code`, `loyalty`, `redeem_points` |
| GET | `/api/pos/sales/:id` | Касса |  |
| GET | `/api/pos/sales/by-number/:no` | Касса |  |
| POST | `/api/pos/sales/:id/tip` | Касса | тело: `tip_pct` |
| POST | `/api/pos/sales/:id/age` | Касса | тело: `code`, `passport_no` |
| POST | `/api/pos/sales/:id/pay` | публично | тело: `method`, `amount`, `customer`, `customer_name`, `note`, `cash_given`, `number`, `exp`, `pin` |
| POST | `/api/pos/sales/:id/qr` | Касса | тело: `terminal_code`, `amount` |
| POST | `/api/pos/sales/:id/cancel` | Касса |  |
| GET | `/api/pos/held` | Касса |  |
| POST | `/api/pos/held` | Касса | тело: `label`, `items` |
| POST | `/api/pos/held/:id/resume` | Касса |  |
| POST | `/api/pos/refunds` | Касса | тело: `sale_id`, `items`, `all`, `reason` |
| GET | `/api/pos/sales/:id/receipt` | Касса |  |
| POST | `/api/pos/sales/:id/email` | публично | тело: `email` |
| POST | `/api/pos/log` | Касса | тело: `action`, `data` |
| GET | `/api/pos/log` | Касса (владелец) |  |
| GET | `/api/pos/invoices/:no` | Касса |  |
| POST | `/api/pos/invoices/:no/pay-cash` | Касса |  |
| POST | `/api/pos/terminals` | Касса |  |
| POST | `/api/pos/terminals/:code/close` | Касса |  |
| POST | `/api/pos/terminals/:code/display` | Касса | тело: `lines`, `total`, `message` |
| POST | `/api/pos/terminals/:code/request` | Касса | тело: `sale_id`, `amount` |
| POST | `/api/pos/terminals/:code/cancel` | Касса |  |
| GET | `/api/pos/terminal/:code` | публично |  |
| POST | `/api/pos/terminal/:code/pay` | публично | тело: `request_id`, `number`, `exp`, `pin` |

#### /api/pos (pos-ext)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| POST | `/api/pos/products/:id/variants` | Касса (владелец) | тело: `price_delta`, `name`, `sort` |
| POST | `/api/pos/products/:id/modifiers` | Касса (владелец) | тело: `price`, `name`, `sort`, `active` |
| GET | `/api/pos/wholesale` | Касса |  |
| POST | `/api/pos/purchases/wholesale` | Касса (владелец) | тело: `items` |
| GET | `/api/pos/market` | Касса | query: `q` |
| POST | `/api/pos/purchases/shop` | Касса (владелец) | тело: `seller_shop_id`, `items`, `note` |
| GET | `/api/pos/purchases` | Касса (владелец) |  |
| POST | `/api/pos/orders/:id/:decision` | Касса (владелец) |  |
| POST | `/api/pos/purchases/:id/cancel` | Касса (владелец) |  |
| GET | `/api/pos/stock/summary` | Касса (владелец) |  |
| GET | `/api/pos/stock/moves` | Касса (владелец) | query: `product_id` |
| GET | `/api/pos/promos` | Касса |  |
| POST | `/api/pos/promos` | Касса (владелец) |  |
| PATCH | `/api/pos/promos/:id` | Касса (владелец) | тело: `active` |
| GET | `/api/pos/loyalty/lookup` | Касса | query: `q` |
| GET | `/api/pos/loyalty` | Касса (владелец) |  |
| GET | `/api/pos/debts` | Касса | query: `status` |
| POST | `/api/pos/debts/:id/repay` | Касса | тело: `amount`, `method`, `number`, `exp`, `pin` |
| POST | `/api/pos/debts/:id/write-off` | Касса (владелец) |  |
| GET | `/api/pos/tables` | Касса | query: `all` |
| POST | `/api/pos/tables` | Касса (владелец) | тело: `name`, `seats`, `sort` |
| PATCH | `/api/pos/tables/:id` | Касса (владелец) | тело: `name`, `seats`, `active` |
| GET | `/api/pos/tables/:id/tab` | Касса |  |
| POST | `/api/pos/tables/:id/items` | Касса | тело: `items` |
| POST | `/api/pos/tables/:id/remove` | Касса | тело: `item_id` |
| POST | `/api/pos/tables/:id/kitchen` | Касса |  |
| POST | `/api/pos/tables/:id/checkout` | Касса | тело: `discount`, `promo_code`, `loyalty`, `redeem_points`, `tip_pct` |
| POST | `/api/pos/tables/:id/move` | Касса | тело: `to_table_id` |
| DELETE | `/api/pos/tables/:id/tab` | Касса |  |
| GET | `/api/pos/kitchen` | Касса |  |
| POST | `/api/pos/kitchen/:id/status` | Касса | тело: `status` |
| GET | `/api/pos/queue` | Касса |  |
| GET | `/api/pos/public/queue/:shopId` | публично |  |
| POST | `/api/pos/kiosk/unlock` | Касса | тело: `pin` |
| GET | `/api/pos/reports` | Касса (владелец) | query: `days` |

#### /api/net (net)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| GET | `/api/net/providers` | публично |  |
| POST | `/api/net/lease` | публично | тело: `client_id`, `provider` |
| POST | `/api/net/resolve` | публично | тело: `name`, `type`, `dnssec`, `cd` |
| POST | `/api/net/query` | публично | тело: `server`, `name`, `type`, `recurse`, `dnssec`, `cd` |
| GET | `/api/net/trust` | публично |  |
| POST | `/api/net/open` | публично | тело: `url`, `jar`, `client_id`, `referrer`, `notifications` |
| POST | `/api/net/ping` | публично | тело: `host`, `count` |
| POST | `/api/net/traceroute` | публично | тело: `host` |
| POST | `/api/net/ssh/login` | публично | тело: `host`, `user`, `password` |
| POST | `/api/net/ssh/exec` | публично | тело: `session`, `line` |
| POST | `/api/net/ssh/save` | публично | тело: `session`, `path`, `content` |
| GET | `/api/net/whois` | публично | query: `q` |

#### /api/net (web)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| GET | `/api/net/shim.js` | публично |  |
| GET | `/api/net/web/:ticket/__balnet_redirect` | публично | query: `to` |
| GET | `/api/net/web/:ticket` | публично |  |
| POST | `/api/net/xfetch` | публично | тело: `method`, `url`, `headers`, `body`, `bodyB64` |
| GET | `/api/net/sock/:ticket` | публично | query: `url` |
| POST | `/api/net/jar` | публично | тело: `ticket`, `cookies`, `local`, `notifications` |
| GET | `/api/net/jar/:ticket` | публично |  |

#### /api/search (search)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| GET | `/api/search/search` | публично | query: `q`, `tab`, `p` |
| POST | `/api/search/click` | публично | тело: `q`, `url` |
| GET | `/api/search/suggest` | публично | query: `q` |
| GET | `/api/search/trends` | публично |  |
| GET | `/api/search/stats` | публично |  |
| GET | `/api/search/img/:id` | публично |  |
| GET | `/api/search/product-photo/:id` | публично |  |
| GET | `/api/search/sb/prefixes` | публично |  |
| POST | `/api/search/sb/find` | публично | тело: `prefixes` |
| POST | `/api/search/sb/report` | публично |  |
| POST | `/api/search/ads/click` | публично | тело: `token` |
| GET | `/api/search/ads/newtab` | публично |  |
| POST | `/api/search/adnet/serve` | публично |  |
| POST | `/api/search/adnet/click` | публично |  |
| GET | `/api/search/webmaster/sites` | гражданин |  |
| POST | `/api/search/webmaster/sites` | гражданин | тело: `host` |
| GET | `/api/search/webmaster/sites/:id` | гражданин |  |
| POST | `/api/search/webmaster/sites/:id/verify` | гражданин | тело: `method` |
| POST | `/api/search/webmaster/sites/:id/recrawl` | гражданин | тело: `url` |
| POST | `/api/search/webmaster/sites/:id/inspect` | гражданин | тело: `url` |
| POST | `/api/search/webmaster/sites/:id/sitemaps` | гражданин | тело: `url` |
| POST | `/api/search/webmaster/sites/:id/review` | гражданин |  |
| PATCH | `/api/search/webmaster/sites/:id` | гражданин | тело: `adnet` |
| DELETE | `/api/search/webmaster/sites/:id` | гражданин |  |
| GET | `/api/search/ads/account` | гражданин |  |
| POST | `/api/search/ads/topup` | гражданин | тело: `amount` |
| POST | `/api/search/ads/withdraw` | гражданин |  |
| POST | `/api/search/ads/campaigns` | гражданин |  |
| GET | `/api/search/ads/campaigns/:id` | гражданин |  |
| PATCH | `/api/search/ads/campaigns/:id` | гражданин |  |
| GET | `/api/search/ads/forecast` | гражданин | query: `q` |

#### /api/hub (hub)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| GET | `/api/hub/git/*` | публично |  |
| POST | `/api/hub/git/*` | публично |  |
| GET | `/api/hub/me` | публично |  |
| POST | `/api/hub/me` | гражданин | тело: `login`, `name` |
| GET | `/api/hub/tokens` | гражданин |  |
| POST | `/api/hub/tokens` | гражданин | тело: `name` |
| DELETE | `/api/hub/tokens/:id` | гражданин |  |
| GET | `/api/hub/repos` | публично | query: `owner` |
| POST | `/api/hub/repos` | гражданин |  |
| GET | `/api/hub/repos/:owner/:name` | публично |  |
| PATCH | `/api/hub/repos/:owner/:name` | гражданин | тело: `description`, `private`, `default_branch`, `deploy_site_id`, `deploy_branch` |
| DELETE | `/api/hub/repos/:owner/:name` | гражданин |  |
| GET | `/api/hub/deploy-targets` | гражданин |  |
| POST | `/api/hub/repos/:owner/:name/deploy` | гражданин |  |
| POST | `/api/hub/repos/:owner/:name/collaborators` | гражданин | тело: `login` |
| DELETE | `/api/hub/repos/:owner/:name/collaborators/:login` | гражданин |  |
| GET | `/api/hub/repos/:owner/:name/tree` | публично | query: `ref`, `path` |
| GET | `/api/hub/repos/:owner/:name/commits` | публично | query: `ref`, `limit` |
| GET | `/api/hub/repos/:owner/:name/commit/:oid` | публично |  |
| PUT | `/api/hub/repos/:owner/:name/file` | гражданин | тело: `branch`, `path`, `content`, `message` |
| POST | `/api/hub/repos/:owner/:name/branches` | гражданин | тело: `name`, `from` |
| GET | `/api/hub/repos/:owner/:name/issues` | публично | query: `kind`, `state` |
| POST | `/api/hub/repos/:owner/:name/issues` | гражданин | тело: `kind`, `title`, `head`, `base`, `body` |
| GET | `/api/hub/repos/:owner/:name/issues/:num` | публично |  |
| POST | `/api/hub/repos/:owner/:name/issues/:num/comments` | гражданин | тело: `body` |
| PATCH | `/api/hub/repos/:owner/:name/issues/:num` | гражданин | тело: `state` |
| POST | `/api/hub/repos/:owner/:name/issues/:num/merge` | гражданин |  |

#### /api/mail (mail)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| GET | `/api/mail/me` | публично |  |
| POST | `/api/mail/me` | гражданин | тело: `login`, `name` |
| PATCH | `/api/mail/me` | гражданин | тело: `name`, `signature`, `notify_email`, `spam_threshold` |
| GET | `/api/mail/folders` | гражданин |  |
| GET | `/api/mail/messages` | гражданин | query: `folder`, `q`, `before` |
| GET | `/api/mail/messages/:id` | гражданин |  |
| GET | `/api/mail/messages/:id/raw` | гражданин |  |
| PATCH | `/api/mail/messages/:id` | гражданин | тело: `seen`, `starred`, `folder` |
| POST | `/api/mail/messages/:id/spam` | гражданин | тело: `spam` |
| DELETE | `/api/mail/messages/:id` | гражданин |  |
| POST | `/api/mail/messages/:id/report` | гражданин | тело: `reason` |
| POST | `/api/mail/send` | публично |  |
| GET | `/api/mail/contacts` | гражданин | query: `q` |
| GET | `/api/mail/domains` | гражданин |  |
| POST | `/api/mail/domains` | гражданин | тело: `name` |
| POST | `/api/mail/domains/:id/check` | гражданин |  |
| POST | `/api/mail/domains/:id/auto` | гражданин |  |
| POST | `/api/mail/domains/:id/addresses` | гражданин | тело: `local`, `for` |
| DELETE | `/api/mail/domains/:id/addresses/:address` | гражданин |  |
| PATCH | `/api/mail/domains/:id` | гражданин | тело: `catch_all` |
| DELETE | `/api/mail/domains/:id` | гражданин |  |
| POST | `/api/mail/sync/devices` | публично | тело: `name` |
| GET | `/api/mail/sync/devices` | гражданин |  |
| DELETE | `/api/mail/sync/devices/:id` | гражданин |  |
| POST | `/api/mail/sync/reset` | гражданин | тело: `token` |
| POST | `/api/mail/sync/status` | публично |  |
| POST | `/api/mail/sync/key` | публично |  |
| POST | `/api/mail/sync/pull` | публично |  |
| POST | `/api/mail/sync/push` | публично | тело: `collection`, `base_rev`, `blob` |
| POST | `/api/mail/sync/signout` | публично |  |

#### /api/push (push)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| GET | `/api/push/key` | публично |  |
| GET | `/api/push/devices` | публично |  |
| POST | `/api/push/subscribe` | публично | тело: `subscription` |
| POST | `/api/push/unsubscribe` | публично | тело: `id`, `endpoint` |
| POST | `/api/push/test` | публично |  |

#### /api/net/push (push)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| POST | `/api/net/push/device` | публично | тело: `label` |
| POST | `/api/net/push/device/web` | публично | тело: `subscription` |
| POST | `/api/net/push/device/delete` | публично |  |
| POST | `/api/net/push/subs` | публично |  |
| POST | `/api/net/push/subscribe` | публично | тело: `origin`, `applicationServerKey` |
| POST | `/api/net/push/subscription` | публично | тело: `origin` |
| POST | `/api/net/push/unsubscribe` | публично | тело: `origin` |
| POST | `/api/net/push/inbox` | публично | тело: `after` |

#### /api/news (news)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| GET | `/api/news/meta` | публично |  |
| GET | `/api/news/feed` | публично | query: `outlet`, `category`, `q`, `page` |
| GET | `/api/news/articles/:id` | публично |  |
| GET | `/api/news/outlets` | публично |  |
| GET | `/api/news/outlets/:slug` | публично | query: `page` |
| GET | `/api/news/me` | публично |  |
| POST | `/api/news/outlets` | гражданин |  |
| PATCH | `/api/news/outlets/:slug` | гражданин |  |
| POST | `/api/news/outlets/:slug/fetch` | гражданин |  |
| POST | `/api/news/outlets/:slug/articles` | гражданин | тело: `author` |
| DELETE | `/api/news/articles/:id` | гражданин |  |

#### /api/pay (pay)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| GET | `/api/pay/checkout/:id` | публично |  |
| POST | `/api/pay/checkout/:id/card` | публично | тело: `number`, `exp`, `pin` |
| POST | `/api/pay/checkout/:id/account` | публично | тело: `account_id` |
| POST | `/api/pay/checkout/:id/cancel` | публично |  |
| GET | `/api/pay/merchant-options` | банк |  |
| GET | `/api/pay/merchants` | банк |  |
| POST | `/api/pay/merchants` | банк |  |
| GET | `/api/pay/merchants/:id` | банк |  |
| PATCH | `/api/pay/merchants/:id` | банк | тело: `name`, `site_url`, `webhook_url`, `courier_fee`, `delivery` |
| POST | `/api/pay/merchants/:id/keys` | банк |  |
| POST | `/api/pay/merchants/:id/webhook-secret` | банк |  |
| POST | `/api/pay/merchants/:id/webhook-test` | банк |  |
| POST | `/api/pay/merchants/:id/payments` | банк |  |
| GET | `/api/pay/merchants/:id/payments` | банк |  |
| GET | `/api/pay/merchants/:id/payments/:pid` | банк |  |
| POST | `/api/pay/merchants/:id/payments/:pid/refund` | банк | тело: `amount`, `reason` |
| GET | `/api/pay/merchants/:id/events` | банк |  |
| POST | `/api/pay/merchants/:id/events/:eid/resend` | банк |  |
| GET | `/api/pay/merchants/:id/subscriptions` | банк |  |
| POST | `/api/pay/merchants/:id/subscriptions/:sid/cancel` | банк |  |
| GET | `/api/pay/merchants/:id/orders` | банк |  |
| GET | `/api/pay/purchases` | банк |  |
| POST | `/api/pay/subscriptions/:id/cancel` | банк |  |
| GET | `/api/pay/courier/jobs` | банк |  |
| POST | `/api/pay/courier/jobs/:id/take` | банк |  |
| POST | `/api/pay/courier/jobs/:id/drop` | банк |  |
| POST | `/api/pay/courier/confirm` | банк | тело: `token` |

#### /api/pos (pay)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| GET | `/api/pos/online-orders` | Касса | query: `status` |
| POST | `/api/pos/online-orders/:id/ready` | Касса |  |
| POST | `/api/pos/online-orders/:id/pickup` | Касса | тело: `code` |
| POST | `/api/pos/online-orders/pickup` | Касса | тело: `code` |
| POST | `/api/pos/online-orders/:id/ship` | Касса | тело: `delivered` |

#### /api/oauth (pay)

| Метод | Путь | Доступ | Параметры |
|---|---|---|---|
| GET | `/api/oauth/providers` | публично |  |
| GET | `/api/oauth/:provider/authorize` | гражданин |  |
| POST | `/api/oauth/:provider/authorize` | гражданин | тело: `params`, `approve` |
| GET | `/api/oauth/clients` | гражданин |  |
| POST | `/api/oauth/clients` | гражданин |  |
| PATCH | `/api/oauth/clients/:id` | гражданин |  |
| POST | `/api/oauth/clients/:id/secret` | гражданин |  |
| DELETE | `/api/oauth/clients/:id` | гражданин |  |
| GET | `/api/oauth/grants` | гражданин |  |
| DELETE | `/api/oauth/grants/:clientId` | гражданин | query: `provider` |
