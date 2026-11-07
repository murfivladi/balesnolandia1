# API игроков Балесноландии и создание собственного хостинга

Документ для разработчика и ИИ-кодера. Снимок реализации репозитория; при расхождении первичен код. Здесь описаны реальные возможности, а не обещание ещё не реализованных API. Все денежные суммы API — целые минимальные единицы (100 = 1 В), если конкретный метод явно не устанавливает иное; время в хостинге и cron — игровое.

## Главное о частном хостинге

Организация с действующей лицензией `hosting` может арендовать сервер, создать тариф и продавать его на своём сайте. На витрине и в форме покупки Госхостинга теперь показаны только тарифы, у которых `org_id == null`; тарифы частных организаций остаются в публичном API и доступны для покупки по ID. **Скрытие с витрины — не приватность**: API `GET /api/gov/hosting/plans` возвращает и частные предложения. Не публикуйте там секретные цены. Тариф не перестаёт быть доступным по прямому API.

### Реально поддерживаемый сценарий

1. Создайте организацию, подайте заявку на лицензию хостинга и оплатите пошлину; дождитесь одобрения. См. `/api/gov/orgs/:id/licenses` и соответствующие обработчики ниже.
2. Директор вызывает `POST /api/gov/orgs/:id/servers`, затем `POST /api/gov/orgs/:id/plans` с токеном `hosting` или сессией. `GET /api/gov/orgs/:id/hosting` возвращает серверы и все свои тарифы; участник организации может читать, изменения доступны директору.
3. На своей витрине берите `GET /api/gov/hosting/plans`, отбирайте предложения по `org_id` вашей организации. Показывайте `name`, `kind`, `disk_mb`, `max_sites`, `price_month`, сервер и ограничения. В выборке только активные тарифы активных серверов с действующей лицензией. Доступность места окончательно проверяется при покупке.
4. Покупатель со своим паспортом и своей авторизацией вызывает `POST /api/gov/hosting` с `plan_id`, `months` и необязательным `owner_org_id`. Ответ `{account_id, id, invoice, amount}`: `id` — заказ, `invoice` — номер квитанции или `null` при нулевой цене. Платный аккаунт резервируется и активируется после оплаты квитанции; бесплатный активируется сразу. Проверяйте статус в `GET /api/gov/hosting/:id`; не считайте создание заказа подтверждением оплаты. Квитанция оплачивается банковским методом покупателя (см. раздел банковских маршрутов).
5. Клиент управляет **своим** аккаунтом, подключает сайт, получает IP и прописывает A-запись у регистратора, загружает файлы, при необходимости устанавливает сертификат. Срок продлевается отдельной квитанцией. Нельзя выдавать покупателю доступ к чужому аккаунту под ключом хостера.

**Важно для архитектуры:** токен хостера не даёт права действовать от имени произвольного покупателя, и существующие маршруты не предоставляют хостеру общего доступа к файлам/аккаунтам всех клиентов. Для интеграции требуется авторизация именно покупателя либо отдельная реализация делегирования, которой сейчас нет. OAuth сервисов не следует автоматически считать выдачей `bln_`-токена или разрешением вызывать hosting API. Не просите пароль пользователя и не храните его API-токен в публичном JS; пользователь может управлять купленным аккаунтом также через существующий кабинет. Готового API полноценного white-label управления клиентами одним ключом в текущем коде нет.

### Создание тарифа

`POST /api/gov/orgs/:orgId/plans`, тело например:

```json
{"server_id": 1, "name": "Мой виртуальный", "disk_mb": 100, "max_sites": 5, "price_month": 1500, "kind": "virtual", "rpm": 300, "cpu_ms": 100, "ws_limit": 20, "cron_min": 60}
```

Ответ `{ "id": 123 }` (номера условные). `server_id` должен принадлежать организации и быть не закрытым; место 1..размер сервера, сайтов 1..100, `name` до 80 символов, цена — положительное целое. `kind` — `virtual` или `static` (иначе будет `static`); для virtual `rpm` 10..100000, `cpu_ms` 10..2000, `ws_limit` 0..1000, `cron_min` 1..43200. У static серверные лимиты обнуляются. `PATCH /api/gov/orgs/:orgId/plans/:planId` позволяет изменить только `active` и `price_month`; это не удаление тарифа и не редактирование его остальных параметров. Аренда и лицензия проверяются в игровой экономике, деньги за тариф распределяются с НДС.

Пример использования внешним сервером (адрес API и токен задаются в конфигурации):

```js
const API = process.env.BLN_API_BASE; // например https://ваш-сервер/api, без конечного /
const token = process.env.BLN_TOKEN; // хранить только на сервере
async function api(path, options = {}) {
  const res = await fetch(API + path, {
    ...options,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...options.headers },
  });
  const data = await res.json();
  if (!res.ok) throw new Error(`${data.error}: ${data.message}`);
  return data;
}
const { offers } = await api('/gov/hosting/plans');
const myOffers = offers.filter(p => p.org_id === Number(process.env.HOSTER_ORG_ID));
```

`org_id` и `server_id` выше — реальные значения из ответов, а не фиксированные идентификаторы. Для сайта внутри БалНета серверный JavaScript делает запрос на `https://hosting.bln/api/...` по сети БалНета; обычный браузерный код в песочнице не получает прямой доступ к государственному API. Не помещайте токен ни в клиентские файлы, ни в логи, ни в общедоступный репозиторий.

## Доступ и границы безопасности

В ВлодУслугах → «Ключи API» создаётся `bln_...` с набором прав. Секрет показывается при создании один раз; запрос `Authorization: Bearer bln_...`. До 20 токенов на пользователя, их можно отозвать. Управление токенами и вход/смена пароля требуют обычной сессии и недоступны через сам API-токен. Заблокированный или отклонённый пользователь не авторизуется. Право определяет допустимые пути, но не отменяет проверки владения, лицензии, роли и других условий конкретного маршрута.

| Scope | Допускаемые пути |
|---|---|
| `profile` | GET `/api/gov/me`, `/api/gov/passport` и вложенные пути |
| `domains` | `/api/gov/domains`, `/orgs`, `/auctions` и вложенные |
| `hosting` | `/api/gov/hosting`, `/orgs` и вложенные |
| `certs` | `/api/gov/certs`, `/cas` и `/hosting/:id/sites/:sid/ssl` или `/cert` |
| `services` | `/api/gov/invoices`, `applications`, `documents`, `taxes`, `fines`, `benefits`, `properties`, `appeals`, `work`, `elections`, `doctor`, `insurance`, `deals` и вложенные |
| `mail` | `/api/mail/`, кроме `/sync` |
| `news` | `/api/news/` |
| `hub` | `/api/hub/`, кроме `/tokens` и `/git/` |
| `search` | `/api/search/webmaster`, `/ads`, `/campaigns`, `/adnet` |
| `pay` | `/api/bank/accounts` и `/api/bank/invoices/:number[/pay]`; нужна подтверждённая связка с банком |

Некоторые API игроков используют другие способы входа: cookie-сессии госуслуг/банка/кассы, ключ мерчанта или OAuth. Наличие маршрута в каталоге не означает, что он доступен `bln_`-токену. Не предоставляйте клиентам токен владельца хостинга; минимизируйте scope. `domains` и `hosting` оба открывают пути `/orgs`, поэтому их права шире, чем только домены или только хостинг.

Обычные ошибки API: HTTP 400/401/403/404/409/429/500, JSON `{error, message, data?}`; конкретные проверки и коды видны ниже и в вызываемых библиотеках. Не повторяйте оплату или создание без проверки результата; используйте поддерживаемый `Idempotency-Key` там, где он реально реализован. Сетевой сбой не доказывает, что операция не произошла.

## Среда сайта

Статика отдаётся как файлы. На виртуальном тарифе `server.js` в QuickJS обрабатывает запросы без файла и POST/PUT/PATCH/DELETE; поддерживаются `onRequest`, `onCron`, SQLite `db`, `kv`, `fetch`, `mail.send`. Также доступны PHP 8.3 и Python/Pyodide с ограничениями, приоритет обработчиков зависит от наличия файлов. Подробные примеры и лимиты — `web/src/hosting/App.jsx` (ServerDocs), `api/src/lib/vhost/example.js`, `api/src/lib/vhost/prelude.js`, `api/src/lib/vhost/respond.js`. npm в QuickJS нет. База и файлы занимают квоту, лимиты запросов/CPU/cron задаются тарифом. Не считайте окружение Node.js полноценным сервером Node.

Эквайринг `https://pay.bank.bln/api/v1/...` и OAuth `.../oauth/...` — отдельные интерфейсы внутри БалНета, не путайте `sk_live_` и `bln_`. Официальные примеры и поля платежей, возвратов, подписок и webhook — `web/src/pay/docs.jsx`, а реальный диспетчер — `api/src/lib/pay/api.js`, правила в `api/src/lib/pay/core.js` и `oauth.js`. Проверяйте статус платежа у сервера, не доверяйте одному переходу пользователя по redirect URL. Webhook необходимо проверять согласно этой реализации. Эти API не являются правом управлять чужим хостингом.

## Как читать полный каталог

Далее перечислены обработчики неадминистративных HTTP-маршрутов, доступных игрокам через соответствующий тип сессии, специальные ключи либо публично. Путь содержит фактический префикс из `api/src/app.js`; `:id` — параметр пути, query задаётся через `?`, тело обычно JSON. Снимки JavaScript-обработчиков сохранены как точная техническая спецификация: они показывают поля `req.body`, `req.query`, проверки и возвращаемый объект. Для методов, делегирующих работу в `lib`, полный контракт и ограничения находятся в вызванной функции по указанному исходному пути; фрагмент сам по себе не является исчерпывающей JSON Schema. Общие функции, миграции и тесты — источники деталей и примеров. В каталоге также есть маршруты с cookie, а не только доступные токеном; привилегии не предполагать. Это снимок исходного кода, не интерактивная OpenAPI-схема.


## auth.js — `api/src/routes/auth.js`

### POST `/api/auth/bank/register`

Исходник: `api/src/routes/auth.js:60`.

```js
  app.post('/auth/bank/register', limited(5), async (req, reply) => {
    const b = req.body || {};
    const email = emailOf(b.email);
    const password = b.password ? checkPassword(b.password) : null;
    const fullName = str(b.full_name, 'имя', { min: 2, max: 120 });
    const birth = str(b.birth_date, 'дата рождения', { max: 10 });
    need(/^\d{4}-\d{2}-\d{2}$/.test(birth), 'Неверная дата рождения');
    const passportNo = b.passport_no ? normalizePassport(b.passport_no) : null;
    if (b.passport_no) need(passportNo, 'Номер паспорта: BLN-XXXX-XXXX');
    const s = await getSettings();
    const user = await tx(async (conn) => {
      if (await one('SELECT id FROM bank_users WHERE email = ?', [email], conn)) throw bad('email_taken', 'Этот email уже зарегистрирован');
      const res = await q(
        'INSERT INTO bank_users (email, password_hash, full_name, birth_date, status, lang) VALUES (?, ?, ?, ?, ?, ?)',
        [email, password ? await hash(password) : null, fullName, birth, s.bank_registration_approval ? 'pending' : 'active', b.lang === 'it' ? 'it' : 'ru'],
        conn,
      );
      const u = await one('SELECT * FROM bank_users WHERE id = ?', [res.insertId], conn);
      if (passportNo) await requestPassportLink(conn, u, passportNo);
      await ensureBootstrapAdmin('bank', u, conn);
      await audit(conn, { kind: 'bank', id: u.id }, 'bank.register', 'bank_user', u.id);
      return u;
    });
    if (user.status === 'pending') notifyAdmins('queue', { what: 'bank_registration' });
    await issue(reply, 'bank', { id: user.id });
    return { user: publicBankUser(await one('SELECT * FROM bank_users WHERE id = ?', [user.id]), await rolesOf('bank', user.id)) };
  });
```

### POST `/api/auth/gov/register`

Исходник: `api/src/routes/auth.js:88`.

```js
  app.post('/auth/gov/register', limited(5), async (req, reply) => {
    const b = req.body || {};
    const email = emailOf(b.email);
    const password = b.password ? checkPassword(b.password) : null;
    const name = str(b.display_name, 'имя', { min: 2, max: 120 });
    const user = await tx(async (conn) => {
      if (await one('SELECT id FROM gov_users WHERE email = ?', [email], conn)) throw bad('email_taken', 'Этот email уже зарегистрирован');
      const res = await q('INSERT INTO gov_users (email, password_hash, display_name, lang) VALUES (?, ?, ?, ?)', [email, password ? await hash(password) : null, name, b.lang === 'it' ? 'it' : 'ru'], conn);
      const u = await one('SELECT * FROM gov_users WHERE id = ?', [res.insertId], conn);
      await ensureBootstrapAdmin('gov', u, conn);
      await audit(conn, { kind: 'gov', id: u.id }, 'gov.register', 'gov_user', u.id);
      return u;
    });
    await issue(reply, 'gov', { id: user.id });
    return { user: publicGovUser(user, await rolesOf('gov', user.id)) };
  });
```

### POST `/api/auth/:kind/login`

Исходник: `api/src/routes/auth.js:105`.

```js
  app.post('/auth/:kind/login', limited(10), async (req, reply) => {
    const kind = kindParam(req);
    const email = emailOf(req.body?.email);
    const user = await one(`SELECT * FROM ${TABLE[kind]} WHERE email = ?`, [email]);
    const ok = user && (await verifyHash(String(req.body?.password || ''), user.password_hash));
    if (!ok) throw unauthorized('Неверный email или пароль');
    if (user.status === 'blocked') throw forbidden('Аккаунт заблокирован');
    if (user.status === 'rejected') throw forbidden('Регистрация отклонена');
    await ensureBootstrapAdmin(kind, user);
    await issue(reply, kind, { id: user.id });
    const roles = await rolesOf(kind, user.id);
    return { user: kind === 'bank' ? publicBankUser(user, roles) : publicGovUser(user, roles) };
  });
```

### POST `/api/auth/:kind/code/send`

Исходник: `api/src/routes/auth.js:119`.

```js
  app.post('/auth/:kind/code/send', limited(5), async (req) => {
    const kind = kindParam(req);
    const email = emailOf(req.body?.email);
    const user = await one(`SELECT id FROM ${TABLE[kind]} WHERE email = ?`, [email]);
    // Не раскрываем, есть ли аккаунт: ответ одинаковый.
    if (user) await sendCode(kind, email);
    return { ok: true };
  });
```

### POST `/api/auth/:kind/code/verify`

Исходник: `api/src/routes/auth.js:128`.

```js
  app.post('/auth/:kind/code/verify', limited(10), async (req, reply) => {
    const kind = kindParam(req);
    const email = emailOf(req.body?.email);
    await checkCode(kind, email, req.body?.code);
    const user = await one(`SELECT * FROM ${TABLE[kind]} WHERE email = ?`, [email]);
    if (!user) throw unauthorized('Аккаунт не найден');
    if (user.status === 'blocked') throw forbidden('Аккаунт заблокирован');
    await ensureBootstrapAdmin(kind, user);
    await issue(reply, kind, { id: user.id });
    const roles = await rolesOf(kind, user.id);
    return { user: kind === 'bank' ? publicBankUser(user, roles) : publicGovUser(user, roles) };
  });
```

### POST `/api/auth/:kind/logout`

Исходник: `api/src/routes/auth.js:141`.

```js
  app.post('/auth/:kind/logout', async (req, reply) => {
    const kind = req.params.kind;
    if (kind === 'bank' || kind === 'gov' || kind === 'pos') clear(reply, kind);
    if (kind === 'bank') clear(reply, 'pos');
    return { ok: true };
  });
```

### GET `/api/auth/me`

Исходник: `api/src/routes/auth.js:148`.

```js
  app.get('/auth/me', async (req) => {
    const [bank, gov, pos] = await Promise.all([session(req, 'bank'), session(req, 'gov'), posSession(req)]);
    return {
      bank: bank ? publicBankUser(bank.user, bank.roles) : null,
      gov: gov ? publicGovUser(gov.user, gov.roles) : null,
      pos: pos ? { shop_id: pos.shopId, staff_id: pos.staff.id, role: pos.staff.role } : null,
    };
  });
```

### POST `/api/auth/:kind/password`

Исходник: `api/src/routes/auth.js:157`.

```js
  app.post('/auth/:kind/password', limited(5), async (req) => {
    const kind = kindParam(req);
    const s = await session(req, kind);
    if (!s) throw unauthorized();
    const password = checkPassword(req.body?.password);
    if (s.user.password_hash && !(await verifyHash(String(req.body?.old_password || ''), s.user.password_hash))) {
      throw bad('wrong_password', 'Неверный текущий пароль');
    }
    await q(`UPDATE ${TABLE[kind]} SET password_hash = ? WHERE id = ?`, [await hash(password), s.id]);
    return { ok: true };
  });
```

### POST `/api/auth/:kind/lang`

Исходник: `api/src/routes/auth.js:169`.

```js
  app.post('/auth/:kind/lang', async (req) => {
    const kind = kindParam(req);
    const s = await session(req, kind);
    if (s) await q(`UPDATE ${TABLE[kind]} SET lang = ? WHERE id = ?`, [req.body?.lang === 'it' ? 'it' : 'ru', s.id]);
    return { ok: true };
  });

  // «Войти через ВлодУслуги»: нужен вход во ВлодУслуги и действующий паспорт.
```

### POST `/api/auth/bank/via-gov`

Исходник: `api/src/routes/auth.js:177`.

```js
  app.post('/auth/bank/via-gov', limited(10), async (req, reply) => {
    const gov = await session(req, 'gov');
    if (!gov) throw unauthorized('Сначала войдите во ВлодУслуги');
    const citizen = await one("SELECT c.* FROM citizens c JOIN passports p ON p.number = c.passport_no AND p.status = 'active' WHERE c.gov_user_id = ?", [gov.id]);
    const user = await tx(async (conn) => {
      let u = await one('SELECT * FROM bank_users WHERE gov_user_id = ?', [gov.id], conn);
      if (u) return u;
      if (!citizen) throw bad('no_passport', 'Для входа через ВлодУслуги нужен паспорт БФ');
      const sameEmail = await one('SELECT * FROM bank_users WHERE email = ?', [gov.user.email], conn);
      if (sameEmail) throw bad('email_taken', 'Аккаунт ВлодБанка с этим email уже есть — войдите паролем и укажите паспорт');
      const samePassport = await one('SELECT id FROM bank_users WHERE passport_no = ? AND passport_verified = 1', [citizen.passport_no], conn);
      if (samePassport) throw bad('passport_taken', 'К этому паспорту уже привязан другой аккаунт ВлодБанка');
      const s = await getSettings();
      const birth = citizen.birth_date instanceof Date ? citizen.birth_date.toISOString().slice(0, 10) : citizen.birth_date;
      const res = await q(
        'INSERT INTO bank_users (email, full_name, birth_date, passport_no, passport_verified, gov_user_id, status, lang) VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
        [gov.user.email, citizen.full_name, birth, citizen.passport_no, gov.id, s.bank_registration_approval ? 'pending' : 'active', gov.user.lang],
        conn,
      );
      u = await one('SELECT * FROM bank_users WHERE id = ?', [res.insertId], conn);
      await ensureBootstrapAdmin('bank', u, conn);
      await audit(conn, actorOf(gov), 'bank.register_via_gov', 'bank_user', u.id);
      return u;
    });
    if (user.status === 'blocked' || user.status === 'rejected') throw forbidden('Аккаунт ВлодБанка недоступен');
    await issue(reply, 'bank', { id: user.id });
    return { user: publicBankUser(user, await rolesOf('bank', user.id)) };
  });
}
```


## common.js — `api/src/routes/common.js`

### GET `/api/public/settings`

Исходник: `api/src/routes/common.js:8`.

```js
  app.get('/public/settings', async () => publicSettings(await getSettings()));
```

### GET `/api/clock`

Исходник: `api/src/routes/common.js:9`.

```js
  app.get('/clock', async () => clockState());

  async function who(req) {
    const kind = req.query.kind === 'gov' ? 'gov' : req.query.kind === 'bank' ? 'bank' : null;
    if (!kind) throw bad('invalid', 'kind: bank | gov');
    const s = await session(req, kind);
    if (!s) throw unauthorized();
    return s;
  }
```

### GET `/api/notifications`

Исходник: `api/src/routes/common.js:19`.

```js
  app.get('/notifications', async (req) => {
    const s = await who(req);
    const items = await q('SELECT id, title, body, link, read_at, created_at FROM notifications WHERE user_kind = ? AND user_id = ? ORDER BY id DESC LIMIT 100', [s.kind, s.id]);
    const unread = items.filter((n) => !n.read_at).length;
    return { items, unread };
  });
```

### POST `/api/notifications/read`

Исходник: `api/src/routes/common.js:26`.

```js
  app.post('/notifications/read', async (req) => {
    const s = await who(req);
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(Number).filter(Number.isSafeInteger) : null;
    if (ids && ids.length) {
      await q(`UPDATE notifications SET read_at = NOW(3) WHERE user_kind = ? AND user_id = ? AND read_at IS NULL AND id IN (${ids.map(() => '?').join(',')})`, [s.kind, s.id, ...ids]);
    } else {
      await q('UPDATE notifications SET read_at = NOW(3) WHERE user_kind = ? AND user_id = ? AND read_at IS NULL', [s.kind, s.id]);
    }
    return { ok: true };
  });
}
```


## gov.js — `api/src/routes/gov.js`

### GET `/api/gov/api-tokens`

Исходник: `api/src/routes/gov.js:61`.

```js
  app.get('/api-tokens', { preHandler: needGov() }, async (req) => ({ tokens: await listTokens(req.gov.id), scopes: Object.fromEntries(Object.entries(SCOPES).map(([k, v]) => [k, v.label])) }));
```

### POST `/api/gov/api-tokens`

Исходник: `api/src/routes/gov.js:62`.

```js
  app.post('/api-tokens', { preHandler: needGov() }, async (req) => {
    const t = await createToken(req.gov.id, req.body || {});
    await audit(null, actorOf(req.gov), 'gov.api_token', 'gov_api_token', t.id, { scopes: t.scopes });
    return t;
  });
```

### DELETE `/api/gov/api-tokens/:id`

Исходник: `api/src/routes/gov.js:67`.

```js
  app.delete('/api-tokens/:id', { preHandler: needGov() }, async (req) => {
    await deleteToken(req.gov.id, Number(req.params.id));
    return { ok: true };
  });
  const auth = { preHandler: needGov() };
```

### GET `/api/gov/me`

Исходник: `api/src/routes/gov.js:73`.

```js
  app.get('/me', auth, async (req) => {
    const citizen = await citizenOf(req.gov.id);
    const passport = citizen ? await activePassport(citizen.id) : null;
    const documents = citizen ? await q('SELECT id, type, number, status, data, verify_code, issued_month, expires_month FROM documents WHERE citizen_id = ? ORDER BY id', [citizen.id]) : [];
    const applications = await q('SELECT * FROM applications WHERE gov_user_id = ? ORDER BY id DESC LIMIT 30', [req.gov.id]);
    const invoices = await q("SELECT * FROM invoices WHERE gov_user_id = ? AND status <> 'cancelled' ORDER BY id DESC LIMIT 50", [req.gov.id]);
    const links = citizen ? await q("SELECT l.id, l.created_at, b.email, b.full_name FROM passport_links l JOIN bank_users b ON b.id = l.bank_user_id WHERE l.citizen_id = ? AND l.status = 'pending'", [citizen.id]) : [];
    return {
      passport: passportView(citizen, passport),
      documents: documents.map((d) => ({ ...d, data: json(d.data, {}) })),
      applications: applications.map(appView),
      invoices: invoices.map(publicInvoice),
      links,
      month: await currentMonth(),
    };
  });

  // Паспорт: первичная выдача или замена (обновление данных, фото).
```

### POST `/api/gov/passport`

Исходник: `api/src/routes/gov.js:91`.

```js
  app.post('/passport', auth, async (req) => {
    const data = passportForm(req.body || {});
    const result = await tx(async (conn) => {
      const pending = await one("SELECT id FROM applications WHERE gov_user_id = ? AND type = 'passport' AND status IN ('pending','awaiting_payment')", [req.gov.id], conn);
      if (pending) throw bad('already_pending', 'Заявление на паспорт уже на рассмотрении');
      const citizen = await citizenOf(req.gov.id, conn);
      const a = await submitApplication(conn, { govUserId: req.gov.id, citizenId: citizen?.id || null, type: 'passport', data });
      await audit(conn, actorOf(req.gov), 'gov.passport_apply', 'application', a.id);
      return a;
    });
    return { application: appView(result) };
  });
```

### GET `/api/gov/passport`

Исходник: `api/src/routes/gov.js:104`.

```js
  app.get('/passport', auth, async (req) => {
    const citizen = await citizenOf(req.gov.id);
    if (!citizen) return { passport: null };
    return { passport: passportView(citizen, await activePassport(citizen.id)) };
  });
```

### GET `/api/gov/documents`

Исходник: `api/src/routes/gov.js:110`.

```js
  app.get('/documents', auth, async (req) => {
    const citizen = await citizenOf(req.gov.id);
    if (!citizen) return { documents: [] };
    const docs = await q('SELECT * FROM documents WHERE citizen_id = ? ORDER BY id', [citizen.id]);
    return { documents: docs.map((d) => ({ ...d, data: json(d.data, {}) })) };
  });
```

### POST `/api/gov/documents/:type`

Исходник: `api/src/routes/gov.js:117`.

```js
  app.post('/documents/:type', auth, async (req) => {
    const type = req.params.type;
    if (!['inn', 'ip', 'driver', 'foreign_passport', 'visa', 'marriage', 'birth'].includes(type)) throw bad('unknown_type', 'Неизвестный документ');
    const b = req.body || {};
    const result = await tx(async (conn) => {
      const citizen = await citizenOf(req.gov.id, conn);
      if (!citizen || !(await activePassport(citizen.id, conn))) throw bad('no_passport', 'Сначала получите паспорт БФ');
      if (['inn', 'ip', 'driver', 'foreign_passport'].includes(type)) {
        const have = await one("SELECT id FROM documents WHERE citizen_id = ? AND type = ? AND status = 'active'", [citizen.id, type], conn);
        if (have) throw bad('already_have', 'Документ уже выдан');
      }
      const pending = await one("SELECT id FROM applications WHERE gov_user_id = ? AND type = ? AND status IN ('pending','awaiting_payment')", [req.gov.id, type], conn);
      if (pending) throw bad('already_pending', 'Заявление уже подано');
      let data = {};
      let fee = null;
      if (type === 'ip') {
        const inn = await one("SELECT id FROM documents WHERE citizen_id = ? AND type = 'inn' AND status = 'active'", [citizen.id], conn);
        if (!inn) throw bad('no_inn', 'Для регистрации ИП нужен ИНН');
        data = {
          trade_name: str(b.trade_name, 'название', { min: 2, max: 80 }),
          activity: str(b.activity, 'вид деятельности', { optional: true, max: 120 }),
        };
      }
      if (type === 'driver') {
        if (ageFrom(citizen.birth_date) < 16) throw bad('too_young', 'Права выдаются с 16 лет');
        data = { categories: ['A', 'B', 'C', 'AB', 'BC'].includes(b.categories) ? b.categories : 'B' };
      }
      if (type === 'foreign_passport' || type === 'visa') {
        if (await hasTravelBan(conn, citizen.id)) throw bad('travel_ban', 'Действует запрет выезда за неуплату');
      }
      if (type === 'visa') {
        const fp = await one("SELECT id FROM documents WHERE citizen_id = ? AND type = 'foreign_passport' AND status = 'active'", [citizen.id], conn);
        if (!fp) throw bad('no_foreign_passport', 'Сначала получите загранпаспорт');
        const c = await one('SELECT * FROM countries WHERE id = ? AND active = 1', [int(b.country_id, 'страна')], conn);
        if (!c) throw notFound('Страна не найдена');
        if (!c.visa_required) throw bad('visa_free', `В ${c.name} виза не нужна`);
        const month = await currentMonth(conn);
        const has = await one("SELECT id FROM documents WHERE citizen_id = ? AND type = 'visa' AND status = 'active' AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.country_code')) = ? AND (expires_month IS NULL OR expires_month >= ?)", [citizen.id, c.code, month], conn);
        if (has) throw bad('already_have', 'Виза в эту страну уже действует');
        data = { country_id: c.id, country: c.name };
        fee = Number(c.visa_fee);
      }
      if (type === 'marriage') {
        if (citizen.marital_status === 'married') throw bad('already_married', 'Вы уже состоите в браке');
        const sp = String(b.spouse_passport || '').trim().toUpperCase();
        const spouse = await one('SELECT id, full_name, marital_status FROM citizens WHERE passport_no = ?', [sp], conn);
        if (!spouse || spouse.id === citizen.id) throw notFound('Паспорт супруга(и) не найден');
        if (spouse.marital_status === 'married') throw bad('spouse_married', 'Этот человек уже состоит в браке');
        data = { spouse_passport: sp, spouse_name: spouse.full_name };
      }
      if (type === 'birth') {
        const d = str(b.child_birth_date, 'дата рождения', { max: 10 });
        need(/^\d{4}-\d{2}-\d{2}$/.test(d) && !Number.isNaN(Date.parse(d)), 'Неверная дата рождения');
        data = { child_name: str(b.child_name, 'имя ребёнка', { min: 2, max: 80 }), child_birth_date: d };
      }
      const a = await submitApplication(conn, { govUserId: req.gov.id, citizenId: citizen.id, type, data, fee });
      await audit(conn, actorOf(req.gov), `gov.${type}_apply`, 'application', a.id);
      return a;
    });
    return { application: appView(result) };
  });
```

### GET `/api/gov/applications`

Исходник: `api/src/routes/gov.js:179`.

```js
  app.get('/applications', auth, async (req) => {
    const rows = await q('SELECT * FROM applications WHERE gov_user_id = ? ORDER BY id DESC LIMIT 100', [req.gov.id]);
    return { applications: rows.map(appView) };
  });
```

### POST `/api/gov/applications/:id/cancel`

Исходник: `api/src/routes/gov.js:184`.

```js
  app.post('/applications/:id/cancel', auth, async (req) => {
    await tx(async (conn) => {
      const a = await one('SELECT * FROM applications WHERE id = ? AND gov_user_id = ? FOR UPDATE', [req.params.id, req.gov.id], conn);
      if (!a) throw notFound();
      if (!['pending', 'awaiting_payment'].includes(a.status)) throw bad('invalid_state', 'Заявление уже рассмотрено');
      await q("UPDATE applications SET status = 'cancelled' WHERE id = ?", [a.id], conn);
      if (a.invoice_id) await q("UPDATE invoices SET status = 'cancelled' WHERE id = ? AND status = 'unpaid'", [a.invoice_id], conn);
    });
    return { ok: true };
  });
```

### GET `/api/gov/invoices`

Исходник: `api/src/routes/gov.js:195`.

```js
  app.get('/invoices', auth, async (req) => {
    const rows = await q("SELECT * FROM invoices WHERE gov_user_id = ? AND status <> 'cancelled' ORDER BY id DESC LIMIT 100", [req.gov.id]);
    return { invoices: rows.map(publicInvoice) };
  });

  // Публично по номеру: для оплаты в банке и на кассе.
```

### GET `/api/gov/invoices/:no`

Исходник: `api/src/routes/gov.js:201`.

```js
  app.get('/invoices/:no', async (req) => {
    const inv = await one('SELECT i.*, c.full_name FROM invoices i LEFT JOIN citizens c ON c.id = i.citizen_id WHERE i.number = ?', [String(req.params.no).toUpperCase()]);
    if (!inv) throw notFound('Квитанция не найдена');
    const name = inv.full_name ? inv.full_name.split(' ').map((p, i) => (i === 0 ? p : p[0] + '.')).join(' ') : null;
    return { invoice: { ...publicInvoice(inv), payer: name } };
  });

  // Связка аккаунта ВлодБанка с паспортом.
```

### GET `/api/gov/links`

Исходник: `api/src/routes/gov.js:209`.

```js
  app.get('/links', auth, async (req) => {
    const citizen = await citizenOf(req.gov.id);
    if (!citizen) return { links: [], linked: [] };
    const links = await q("SELECT l.id, l.created_at, b.email, b.full_name FROM passport_links l JOIN bank_users b ON b.id = l.bank_user_id WHERE l.citizen_id = ? AND l.status = 'pending'", [citizen.id]);
    const linked = await q('SELECT id, email, full_name FROM bank_users WHERE passport_no = ? AND passport_verified = 1', [citizen.passport_no]);
    return { links, linked };
  });
```

### POST `/api/gov/links/:id/:decision`

Исходник: `api/src/routes/gov.js:217`.

```js
  app.post('/links/:id/:decision', auth, async (req) => {
    const decision = req.params.decision;
    if (!['confirm', 'reject'].includes(decision)) throw bad('invalid', 'confirm | reject');
    await tx(async (conn) => {
      const citizen = await citizenOf(req.gov.id, conn);
      const link = citizen && (await one("SELECT * FROM passport_links WHERE id = ? AND citizen_id = ? AND status = 'pending' FOR UPDATE", [req.params.id, citizen.id], conn));
      if (!link) throw notFound('Запрос не найден');
      if (decision === 'confirm') {
        const other = await one('SELECT id FROM bank_users WHERE passport_no = ? AND passport_verified = 1 AND id <> ?', [citizen.passport_no, link.bank_user_id], conn);
        if (other) throw bad('passport_taken', 'К паспорту уже привязан другой аккаунт ВлодБанка');
        await q('UPDATE bank_users SET passport_no = ?, passport_verified = 1, gov_user_id = ?, full_name = ?, birth_date = ? WHERE id = ?', [citizen.passport_no, req.gov.id, citizen.full_name, citizen.birth_date, link.bank_user_id], conn);
      }
      await q('UPDATE passport_links SET status = ?, decided_at = NOW(3) WHERE id = ?', [decision === 'confirm' ? 'confirmed' : 'rejected', link.id], conn);
      await notify(conn, 'bank', link.bank_user_id, {
        title: decision === 'confirm' ? 'Паспорт подтверждён' : 'Паспорт не подтверждён',
        body: decision === 'confirm' ? 'Теперь можно открывать счета и карты' : 'Владелец паспорта отклонил запрос',
        link: '#/',
      });
      await audit(conn, actorOf(req.gov), `gov.link_${decision}`, 'bank_user', link.bank_user_id);
    });
    return { ok: true };
  });

  // ——— Проверка документов по QR (публично) ———
```

### GET `/api/gov/verify/passport/:code`

Исходник: `api/src/routes/gov.js:241`.

```js
  app.get('/verify/passport/:code', async (req) => {
    const p = await one('SELECT p.*, c.full_name, c.birth_date, c.photo FROM passports p JOIN citizens c ON c.id = p.citizen_id WHERE p.verify_code = ?', [req.params.code]);
    if (!p) return { valid: false };
    const month = await currentMonth();
    const expired = p.expires_month !== null && p.expires_month < month;
    return {
      valid: p.status === 'active' && !expired,
      status: expired ? 'expired' : p.status,
      number: p.number,
      full_name: p.full_name,
      birth_date: p.birth_date,
      age: ageFrom(p.birth_date),
      photo: p.photo,
    };
  });
```

### GET `/api/gov/verify/document/:code`

Исходник: `api/src/routes/gov.js:257`.

```js
  app.get('/verify/document/:code', async (req) => {
    const d = await one('SELECT d.*, c.full_name FROM documents d JOIN citizens c ON c.id = d.citizen_id WHERE d.verify_code = ?', [req.params.code]);
    if (!d) return { valid: false };
    return { valid: d.status === 'active', type: d.type, number: d.number, status: d.status, full_name: d.full_name, data: json(d.data, {}), issued_month: d.issued_month };
  });
```

### GET `/api/gov/verify/receipt/:code`

Исходник: `api/src/routes/gov.js:263`.

```js
  app.get('/verify/receipt/:code', async (req) => {
    const s = await one('SELECT s.*, sh.name AS shop_name, sh.inn, sh.address FROM sales s JOIN shops sh ON sh.id = s.shop_id WHERE s.verify_code = ?', [req.params.code]);
    if (!s || s.status !== 'paid') return { valid: false };
    const items = await q('SELECT name, unit, qty_milli, price, total FROM sale_items WHERE sale_id = ?', [s.id]);
    return {
      valid: true,
      shop: { name: s.shop_name, inn: s.inn, address: s.address },
      number: s.number,
      total: Number(s.total),
      vat: Number(s.vat),
      refunded: Number(s.refunded),
      paid_at: s.paid_at,
      items,
    };
  });

  // ——— Рассмотрение заявлений (чиновник / админ) ———
  const official = { preHandler: needRole('official') };
```

### GET `/api/gov/queue`

Исходник: `api/src/routes/gov.js:282`.

```js
  app.get('/queue', official, async () => {
    const rows = await q("SELECT a.*, g.email, g.display_name FROM applications a JOIN gov_users g ON g.id = a.gov_user_id WHERE a.status = 'pending' ORDER BY a.id");
    return { applications: rows.map((a) => ({ ...appView(a), email: a.email, display_name: a.display_name, photo: json(a.data, {}).photo || null })) };
  });
```

### POST `/api/gov/applications/:id/approve`

Исходник: `api/src/routes/gov.js:287`.

```js
  app.post('/applications/:id/approve', official, async (req) => {
    const a = await tx(async (conn) => {
      const by = `${req.actor.kind}:${req.actor.id}`;
      const res = await processApplication(conn, int(req.params.id, 'id'), { approvedBy: by });
      await audit(conn, actorOf(req.actor), 'gov.application_approve', 'application', res.id);
      return res;
    });
    return { application: appView(a) };
  });
```

### POST `/api/gov/applications/:id/reject`

Исходник: `api/src/routes/gov.js:297`.

```js
  app.post('/applications/:id/reject', official, async (req) => {
    await tx(async (conn) => {
      await rejectApplication(conn, int(req.params.id, 'id'), { by: `${req.actor.kind}:${req.actor.id}`, comment: str(req.body?.comment, 'причина', { optional: true, max: 255 }) });
      await audit(conn, actorOf(req.actor), 'gov.application_reject', 'application', Number(req.params.id));
    });
    return { ok: true };
  });

  // Реестр граждан для сотрудников госорганов.
```

### GET `/api/gov/citizens`

Исходник: `api/src/routes/gov.js:306`.

```js
  app.get('/citizens', official, async (req) => {
    const term = `%${String(req.query.q || '').trim()}%`;
    const rows = await q('SELECT c.id, c.full_name, c.birth_date, c.passport_no, c.address, g.email FROM citizens c JOIN gov_users g ON g.id = c.gov_user_id WHERE c.full_name LIKE ? OR c.passport_no LIKE ? OR g.email LIKE ? ORDER BY c.full_name LIMIT 100', [term, term, term]);
    return { citizens: rows };
  });
```

### GET `/api/gov/citizens/:id`

Исходник: `api/src/routes/gov.js:312`.

```js
  app.get('/citizens/:id', official, async (req) => {
    const c = await one('SELECT * FROM citizens WHERE id = ?', [req.params.id]);
    if (!c) throw notFound();
    const docs = await q('SELECT * FROM documents WHERE citizen_id = ?', [c.id]);
    return { passport: passportView(c, await activePassport(c.id)), documents: docs.map((d) => ({ ...d, data: json(d.data, {}) })) };
  });

}
```


## gov-ext.js — `api/src/routes/gov-ext.js`

### GET `/api/gov/news`

Исходник: `api/src/routes/gov-ext.js:82`.

```js
  app.get('/news', async (req) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const rows = await q('SELECT id, kind, title, body, pinned, created_at FROM news ORDER BY pinned DESC, id DESC LIMIT ?', [limit]);
    return { news: rows.map((n) => ({ ...n, pinned: !!n.pinned })) };
  });
```

### GET `/api/gov/countries`

Исходник: `api/src/routes/gov-ext.js:88`.

```js
  app.get('/countries', async () => ({ countries: (await q('SELECT id, name, code, visa_required, visa_fee, visa_months FROM countries WHERE active = 1 ORDER BY name')).map((c) => ({ ...c, visa_required: !!c.visa_required, visa_fee: Number(c.visa_fee) })) }));
```

### GET `/api/gov/fine-articles`

Исходник: `api/src/routes/gov-ext.js:90`.

```js
  app.get('/fine-articles', async () => ({ articles: (await q('SELECT id, code, title, amount FROM fine_articles WHERE active = 1 ORDER BY code')).map((a) => ({ ...a, amount: Number(a.amount) })) }));

  // ——— Налоги ———
```

### GET `/api/gov/taxes`

Исходник: `api/src/routes/gov-ext.js:93`.

```js
  app.get('/taxes', auth, async (req) => {
    const c = await citizenOf(req.gov.id);
    if (!c) return { declarations: [], invoices: [], sanctions: [], overdue: 0, property_tax_bp: (await getSettings()).property_tax_bp };
    const month = await currentMonth();
    const decls = await q('SELECT d.*, i.number AS invoice_number FROM tax_declarations d LEFT JOIN invoices i ON i.id = d.invoice_id WHERE d.citizen_id = ? ORDER BY d.year DESC', [c.id]);
    const invs = await q("SELECT * FROM invoices WHERE citizen_id = ? AND kind IN ('tax','fine') AND status <> 'cancelled' ORDER BY status = 'unpaid' DESC, id DESC LIMIT 100", [c.id]);
    const overdue = await overdueInvoices(null, c.id, month);
    const s = await getSettings();
    return {
      month,
      declarations: decls.map(declView),
      invoices: invs.map(publicInvoice),
      overdue: overdue.reduce((x, i) => x + Number(i.amount), 0),
      sanctions: (await activeSanctions(null, c.id)).map(sanctionView),
      rates: { ndfl_bp: s.ndfl_bp, ip_tax_bp: s.ip_tax_bp, property_tax_bp: s.property_tax_bp, vat_bp: s.vat_bp, penalty_bp: s.penalty_bp, sanction_months: s.sanction_months },
    };
  });
```

### POST `/api/gov/taxes/declarations/:id/submit`

Исходник: `api/src/routes/gov-ext.js:111`.

```js
  app.post('/taxes/declarations/:id/submit', auth, async (req) => {
    const r = await tx(async (conn) => {
      const c = await me(req, conn, { passport: false });
      const decl = await one('SELECT * FROM tax_declarations WHERE id = ? AND citizen_id = ? FOR UPDATE', [int(req.params.id, 'id'), c.id], conn);
      if (!decl) throw notFound('Декларация не найдена');
      const income = req.body?.income === undefined || req.body?.income === null || req.body?.income === '' ? Number(decl.income_auto) : int(req.body.income, 'доход', { min: 0, max: 1e14 });
      const res = await submitDeclaration(conn, { decl, income });
      await audit(conn, actorOf(req.gov), 'gov.declaration_submit', 'tax_declaration', decl.id, { income });
      return res;
    });
    return r;
  });

  // ——— Штрафы ———
  const FINE_SELECT = `SELECT f.*, i.number AS invoice_number, i.amount AS invoice_amount, c.full_name, c.passport_no, g.display_name AS officer
    FROM fines f JOIN citizens c ON c.id = f.citizen_id LEFT JOIN invoices i ON i.id = f.invoice_id LEFT JOIN gov_users g ON g.id = f.officer_gov_user_id`;
```

### GET `/api/gov/fines`

Исходник: `api/src/routes/gov-ext.js:128`.

```js
  app.get('/fines', auth, async (req) => {
    const c = await citizenOf(req.gov.id);
    if (!c) return { fines: [] };
    return { fines: (await q(`${FINE_SELECT} WHERE f.citizen_id = ? ORDER BY f.id DESC`, [c.id])).map(fineView) };
  });
```

### POST `/api/gov/fines/:id/appeal`

Исходник: `api/src/routes/gov-ext.js:134`.

```js
  app.post('/fines/:id/appeal', auth, async (req) => {
    await tx(async (conn) => {
      const c = await me(req, conn, { passport: false });
      const fine = await one('SELECT * FROM fines WHERE id = ? AND citizen_id = ? FOR UPDATE', [int(req.params.id, 'id'), c.id], conn);
      if (!fine) throw notFound('Штраф не найден');
      await appealFine(conn, { fine, text: str(req.body?.text, 'текст жалобы', { min: 10, max: 1000 }) });
    });
    return { ok: true };
  });

  // ——— Пособия ———
```

### GET `/api/gov/benefits`

Исходник: `api/src/routes/gov-ext.js:145`.

```js
  app.get('/benefits', auth, async (req) => {
    const c = await citizenOf(req.gov.id);
    const s = await getSettings();
    const rows = c ? await q('SELECT * FROM benefits WHERE citizen_id = ? ORDER BY id DESC', [c.id]) : [];
    const amounts = c ? { child: await benefitAmount(c, 'child', s), pension: await benefitAmount(c, 'pension', s), unemployment: await benefitAmount(c, 'unemployment', s) } : {};
    return {
      benefits: rows.map((b) => ({ id: b.id, kind: b.kind, title: BENEFIT_TITLES[b.kind], status: b.status, months_left: b.months_left, note: b.note, created_at: b.created_at })),
      amounts,
      rules: { pension_age: s.pension_age, unemployment_months: s.benefit_unemployment_months, child_each: s.benefit_child, children: c ? json(c.children, []).length : 0, age: c ? ageFrom(c.birth_date) : null },
    };
  });
```

### POST `/api/gov/benefits`

Исходник: `api/src/routes/gov-ext.js:157`.

```js
  app.post('/benefits', auth, async (req) => {
    const r = await tx(async (conn) => applyBenefit(conn, await me(req, conn), String(req.body?.kind || '')));
    return r;
  });

  // ——— Имущество ———
  const PROP_SELECT = 'SELECT p.*, c.full_name AS owner_name FROM properties p LEFT JOIN citizens c ON c.id = p.owner_citizen_id';
  const DEAL_SELECT = `SELECT d.*, p.title, p.kind, p.reg_number, s.full_name AS seller_name, b.full_name AS buyer_name FROM property_deals d JOIN properties p ON p.id = d.property_id
    LEFT JOIN citizens s ON s.id = d.seller_citizen_id JOIN citizens b ON b.id = d.buyer_citizen_id`;
```

### GET `/api/gov/properties`

Исходник: `api/src/routes/gov-ext.js:167`.

```js
  app.get('/properties', auth, async (req) => {
    const c = await citizenOf(req.gov.id);
    if (!c) return { properties: [], deals: [] };
    const props = await q(`${PROP_SELECT} WHERE p.owner_citizen_id = ? ORDER BY p.id`, [c.id]);
    const deals = await q(`${DEAL_SELECT} WHERE (d.buyer_citizen_id = ? OR d.seller_citizen_id = ?) ORDER BY d.status IN ('pending','loan') DESC, d.id DESC LIMIT 50`, [c.id, c.id]);
    return { properties: props.map(propertyView), deals: deals.map(dealView), me: c.id };
  });
```

### GET `/api/gov/properties/market`

Исходник: `api/src/routes/gov-ext.js:175`.

```js
  app.get('/properties/market', async (req) => {
    const kind = ['car', 'realty'].includes(req.query.kind) ? req.query.kind : null;
    const rows = await q(`${PROP_SELECT} WHERE p.list_price IS NOT NULL AND p.lien_loan_id IS NULL AND p.status = 'active'${kind ? ' AND p.kind = ?' : ''} ORDER BY p.id DESC LIMIT 200`, kind ? [kind] : []);
    return { properties: rows.map((p) => ({ ...propertyView(p), owner_name: p.owner_name || 'Государство БФ' })) };
  });
```

### POST `/api/gov/properties/:id/sell`

Исходник: `api/src/routes/gov-ext.js:181`.

```js
  app.post('/properties/:id/sell', auth, async (req) => {
    const b = req.body || {};
    const r = await tx(async (conn) => {
      const c = await me(req, conn);
      const p = await one('SELECT * FROM properties WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
      if (!p) throw notFound('Имущество не найдено');
      if (b.unlist) {
        if (p.owner_citizen_id !== c.id) throw forbidden('Это не ваше имущество');
        await q('UPDATE properties SET list_price = NULL WHERE id = ?', [p.id], conn);
        return { ok: true };
      }
      const buyer = b.buyer_passport ? await citizenByPassport(conn, b.buyer_passport) : null;
      const dealId = await offerProperty(conn, { property: p, seller: c, price: amountOf(b.price, 'цена'), buyer });
      return { ok: true, deal_id: dealId };
    });
    return r;
  });
```

### POST `/api/gov/properties/:id/buy`

Исходник: `api/src/routes/gov-ext.js:199`.

```js
  app.post('/properties/:id/buy', auth, async (req) => {
    const id = await tx(async (conn) => {
      const c = await me(req, conn);
      const p = await one('SELECT * FROM properties WHERE id = ?', [int(req.params.id, 'id')], conn);
      if (!p) throw notFound('Имущество не найдено');
      return requestPurchase(conn, { property: p, buyer: c });
    });
    return { deal_id: id };
  });
```

### POST `/api/gov/deals/:id/cancel`

Исходник: `api/src/routes/gov-ext.js:209`.

```js
  app.post('/deals/:id/cancel', auth, async (req) => {
    await tx(async (conn) => {
      const c = await me(req, conn, { passport: false });
      const d = await one('SELECT * FROM property_deals WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
      if (!d || (d.buyer_citizen_id !== c.id && d.seller_citizen_id !== c.id)) throw notFound('Сделка не найдена');
      if (d.status !== 'pending') throw bad('invalid_state', d.status === 'loan' ? 'По сделке оформляется кредит — дождитесь решения банка' : 'Сделка закрыта');
      await q("UPDATE property_deals SET status = 'cancelled', closed_at = NOW(3) WHERE id = ?", [d.id], conn);
    });
    return { ok: true };
  });

  // ——— Врач и страховка ———
  const SLOT_SELECT = `SELECT s.*, g.display_name AS doctor_name, c.full_name AS patient_name, c.passport_no AS patient_passport FROM doctor_slots s
    JOIN gov_users g ON g.id = s.doctor_gov_user_id LEFT JOIN citizens c ON c.id = s.patient_citizen_id`;
```

### GET `/api/gov/doctor`

Исходник: `api/src/routes/gov-ext.js:224`.

```js
  app.get('/doctor', auth, async (req) => {
    const c = await citizenOf(req.gov.id);
    const month = await currentMonth();
    const free = await q(`${SLOT_SELECT} WHERE s.status = 'free' AND s.starts_at > NOW(3) ORDER BY s.starts_at LIMIT 200`);
    const mine = c ? await q(`${SLOT_SELECT} WHERE s.patient_citizen_id = ? ORDER BY s.starts_at DESC LIMIT 50`, [c.id]) : [];
    const policy = c ? await one("SELECT * FROM insurance_policies WHERE citizen_id = ? AND status = 'active' AND to_month >= ? ORDER BY to_month DESC LIMIT 1", [c.id, month]) : null;
    const pending = c ? await one("SELECT p.*, i.number FROM insurance_policies p LEFT JOIN invoices i ON i.id = p.invoice_id WHERE p.citizen_id = ? AND p.status = 'awaiting_payment'", [c.id]) : null;
    const s = await getSettings();
    return {
      free: free.map(slotView),
      visits: mine.map(slotView),
      insured: c ? await isInsured(null, c.id, month) : false,
      insurance: policy ? { from_month: policy.from_month, to_month: policy.to_month } : null,
      insurance_invoice: pending?.number || null,
      insurance_price: Number(s.insurance_price),
      insurance_months: s.insurance_months,
    };
  });
```

### POST `/api/gov/doctor/slots/:id/book`

Исходник: `api/src/routes/gov-ext.js:243`.

```js
  app.post('/doctor/slots/:id/book', auth, async (req) => {
    await tx(async (conn) => {
      const c = await me(req, conn);
      const slot = await one('SELECT * FROM doctor_slots WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
      if (!slot || slot.status !== 'free' || new Date(slot.starts_at) <= new Date()) throw bad('slot_taken', 'Время уже занято');
      const insured = await isInsured(conn, c.id, await currentMonth(conn));
      if (slot.priority && !insured) throw bad('need_insurance', 'Это время — только для пациентов со страховкой');
      const active = await one("SELECT COUNT(*) AS n FROM doctor_slots WHERE patient_citizen_id = ? AND status = 'booked'", [c.id], conn);
      if (Number(active.n) >= 3) throw bad('too_many', 'Не больше трёх записей одновременно');
      await q("UPDATE doctor_slots SET status = 'booked', patient_citizen_id = ?, insured = ?, complaint = ?, booked_at = NOW(3) WHERE id = ?", [c.id, insured ? 1 : 0, str(req.body?.complaint, 'жалобы', { optional: true, max: 500 }), slot.id], conn);
      await q('INSERT INTO notifications (user_kind, user_id, title, body, link) VALUES (?, ?, ?, ?, ?)', ['gov', slot.doctor_gov_user_id, 'Новая запись на приём', `${c.full_name}${insured ? ' · страховка' : ''}`, '#/work/doctor'], conn);
    });
    return { ok: true };
  });
```

### POST `/api/gov/doctor/slots/:id/cancel`

Исходник: `api/src/routes/gov-ext.js:258`.

```js
  app.post('/doctor/slots/:id/cancel', auth, async (req) => {
    const c = await citizenOf(req.gov.id);
    const r = await q("UPDATE doctor_slots SET status = 'free', patient_citizen_id = NULL, insured = 0, complaint = NULL, booked_at = NULL WHERE id = ? AND patient_citizen_id = ? AND status = 'booked'", [int(req.params.id, 'id'), c?.id || 0]);
    if (!r.affectedRows) throw notFound('Запись не найдена');
    return { ok: true };
  });
```

### POST `/api/gov/insurance`

Исходник: `api/src/routes/gov-ext.js:265`.

```js
  app.post('/insurance', auth, async (req) => {
    const r = await tx(async (conn) => buyInsurance(conn, await me(req, conn)));
    return r;
  });

  // ——— Выборы: один паспорт — один голос ———
```

### GET `/api/gov/elections`

Исходник: `api/src/routes/gov-ext.js:271`.

```js
  app.get('/elections', auth, async (req) => {
    const c = await citizenOf(req.gov.id);
    return { elections: await electionsView(null, c?.id || null), vote_age: (await getSettings()).vote_age };
  });

  async function voter(req, conn) {
    const c = await me(req, conn);
    const s = await getSettings();
    if (ageFrom(c.birth_date) < Number(s.vote_age)) throw forbidden(`Голосовать и выдвигаться можно с ${s.vote_age} лет`);
    return c;
  }
```

### POST `/api/gov/elections/:id/nominate`

Исходник: `api/src/routes/gov-ext.js:283`.

```js
  app.post('/elections/:id/nominate', auth, async (req) => {
    await tx(async (conn) => {
      const c = await voter(req, conn);
      const e = await one('SELECT * FROM elections WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
      if (!e || e.status !== 'nomination') throw bad('closed', 'Выдвижение закрыто');
      try {
        await q('INSERT INTO candidates (election_id, citizen_id, program) VALUES (?, ?, ?)', [e.id, c.id, str(req.body?.program, 'программа', { min: 10, max: 2000 })], conn);
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') throw bad('already', 'Вы уже кандидат');
        throw err;
      }
    });
    return { ok: true };
  });
```

### POST `/api/gov/elections/:id/withdraw`

Исходник: `api/src/routes/gov-ext.js:298`.

```js
  app.post('/elections/:id/withdraw', auth, async (req) => {
    const c = await citizenOf(req.gov.id);
    const r = await q("UPDATE candidates c JOIN elections e ON e.id = c.election_id SET c.status = 'withdrawn' WHERE c.election_id = ? AND c.citizen_id = ? AND e.status = 'nomination'", [int(req.params.id, 'id'), c?.id || 0]);
    if (!r.affectedRows) throw bad('closed', 'Сняться можно только до начала голосования');
    return { ok: true };
  });
```

### POST `/api/gov/elections/:id/vote`

Исходник: `api/src/routes/gov-ext.js:305`.

```js
  app.post('/elections/:id/vote', auth, async (req) => {
    await tx(async (conn) => {
      const c = await voter(req, conn);
      const e = await one('SELECT * FROM elections WHERE id = ?', [int(req.params.id, 'id')], conn);
      if (!e || e.status !== 'voting') throw bad('closed', 'Голосование не идёт');
      const cand = await one("SELECT id FROM candidates WHERE id = ? AND election_id = ? AND status = 'approved' FOR UPDATE", [int(req.body?.candidate_id, 'кандидат'), e.id], conn);
      if (!cand) throw notFound('Кандидат не найден');
      try {
        await q('INSERT INTO votes (election_id, citizen_id) VALUES (?, ?)', [e.id, c.id], conn);
      } catch (err) {
        if (err.code === 'ER_DUP_ENTRY') throw bad('already_voted', 'Вы уже проголосовали');
        throw err;
      }
      // Тайна голосования: голос учитывается счётчиком, связи «избиратель — кандидат» нет.
      await q('UPDATE candidates SET votes = votes + 1 WHERE id = ?', [cand.id], conn);
    });
    return { ok: true };
  });

  // ——— Обращения ———
```

### GET `/api/gov/appeals`

Исходник: `api/src/routes/gov-ext.js:325`.

```js
  app.get('/appeals', auth, async (req) => ({ appeals: (await q('SELECT * FROM appeals WHERE gov_user_id = ? ORDER BY id DESC LIMIT 100', [req.gov.id])).map(appealView) }));
```

### POST `/api/gov/appeals`

Исходник: `api/src/routes/gov-ext.js:327`.

```js
  app.post('/appeals', auth, async (req) => {
    const b = req.body || {};
    const to = ['admin', 'official', 'police', 'tax', 'doctor'].includes(b.addressee) ? b.addressee : 'official';
    const c = await citizenOf(req.gov.id);
    const r = await q('INSERT INTO appeals (gov_user_id, citizen_id, addressee, subject, body) VALUES (?, ?, ?, ?, ?)', [req.gov.id, c?.id || null, to, str(b.subject, 'тема', { min: 3, max: 160 }), str(b.body, 'текст', { min: 10, max: 4000 })]);
    return { id: r.insertId };
  });

  // ——— Рабочие места госслужащих ———
```

### GET `/api/gov/work/appeals`

Исходник: `api/src/routes/gov-ext.js:336`.

```js
  app.get('/work/appeals', staff, async (req) => {
    const roles = req.actor.roles.includes('admin') ? ['admin', ...STAFF_ROLES] : req.actor.roles;
    const status = req.query.status === 'answered' ? 'answered' : 'open';
    const rows = await q(`SELECT a.*, COALESCE(c.full_name, g.display_name) AS author FROM appeals a JOIN gov_users g ON g.id = a.gov_user_id LEFT JOIN citizens c ON c.id = a.citizen_id
      WHERE a.status = ? AND a.addressee IN (${roles.map(() => '?').join(',')}) ORDER BY a.id DESC LIMIT 200`, [status, ...roles]);
    return { appeals: rows.map(appealView) };
  });
```

### POST `/api/gov/work/appeals/:id/answer`

Исходник: `api/src/routes/gov-ext.js:344`.

```js
  app.post('/work/appeals/:id/answer', staff, async (req) => {
    await tx(async (conn) => {
      const a = await one('SELECT * FROM appeals WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
      if (!a) throw notFound();
      if (!req.actor.roles.includes('admin') && !req.actor.roles.includes(a.addressee)) throw forbidden();
      await q("UPDATE appeals SET status = 'answered', answer = ?, answered_by = ?, answered_at = NOW(3) WHERE id = ?", [str(req.body?.answer, 'ответ', { min: 2, max: 4000 }), `${req.actor.kind}:${req.actor.id}`, a.id], conn);
      await q('INSERT INTO notifications (user_kind, user_id, title, body, link) VALUES (?, ?, ?, ?, ?)', ['gov', a.gov_user_id, `Ответ на обращение: ${a.subject}`, null, '#/appeals'], conn);
    });
    return { ok: true };
  });

  // Полиция: проверка гражданина, штрафы.
```

### GET `/api/gov/work/police/citizen`

Исходник: `api/src/routes/gov-ext.js:356`.

```js
  app.get('/work/police/citizen', police, async (req) => {
    const c = await citizenByPassport(null, req.query.passport);
    const p = await activePassport(c.id);
    const docs = await q("SELECT type, number, status, expires_month FROM documents WHERE citizen_id = ? AND type IN ('driver','foreign_passport','visa')", [c.id]);
    const fines = await q(`${FINE_SELECT} WHERE f.citizen_id = ? ORDER BY f.id DESC LIMIT 20`, [c.id]);
    const props = await q("SELECT title, reg_number, kind FROM properties WHERE owner_citizen_id = ? AND kind = 'car'", [c.id]);
    return {
      citizen: { id: c.id, full_name: c.full_name, birth_date: c.birth_date, age: ageFrom(c.birth_date), photo: c.photo, passport_no: c.passport_no, passport_status: p?.status || 'none', address: c.address },
      documents: docs, fines: fines.map(fineView), cars: props, sanctions: (await activeSanctions(null, c.id)).map(sanctionView),
    };
  });
```

### POST `/api/gov/work/police/fines`

Исходник: `api/src/routes/gov-ext.js:368`.

```js
  app.post('/work/police/fines', police, async (req) => {
    const b = req.body || {};
    const r = await tx(async (conn) => {
      const citizen = await citizenByPassport(conn, b.passport_no);
      const article = b.article_id ? await one('SELECT * FROM fine_articles WHERE id = ? AND active = 1', [int(b.article_id, 'статья')], conn) : null;
      if (b.article_id && !article) throw notFound('Статья не найдена');
      const res = await issueFine(conn, {
        citizen,
        article,
        text: article ? null : str(b.text, 'нарушение', { min: 3, max: 255 }),
        amount: article ? null : amountOf(b.amount, 'сумма'),
        note: str(b.note, 'комментарий', { optional: true, max: 255 }),
        officer: req.actor.kind === 'gov' ? { id: req.actor.id } : null,
      });
      await audit(conn, actorOf(req.actor), 'police.fine', 'fine', res.id, { citizen: citizen.id });
      return res;
    });
    return r;
  });
```

### GET `/api/gov/work/police/fines`

Исходник: `api/src/routes/gov-ext.js:388`.

```js
  app.get('/work/police/fines', police, async (req) => {
    const all = req.actor.roles.includes('admin') && req.query.all === '1';
    const rows = await q(`${FINE_SELECT}${all ? '' : ' WHERE f.officer_gov_user_id = ?'} ORDER BY f.id DESC LIMIT 200`, all ? [] : [req.actor.kind === 'gov' ? req.actor.id : 0]);
    return { fines: rows.map(fineView) };
  });

  // Налоговая: декларации, должники, доначисление.
```

### GET `/api/gov/work/tax/declarations`

Исходник: `api/src/routes/gov-ext.js:395`.

```js
  app.get('/work/tax/declarations', taxRole, async (req) => {
    const status = ['draft', 'submitted', 'paid', 'auto'].includes(req.query.status) ? req.query.status : null;
    const rows = await q(`SELECT d.*, c.full_name, c.passport_no, i.number AS invoice_number FROM tax_declarations d JOIN citizens c ON c.id = d.citizen_id LEFT JOIN invoices i ON i.id = d.invoice_id${status ? ' WHERE d.status = ?' : ''} ORDER BY d.id DESC LIMIT 300`, status ? [status] : []);
    return { declarations: rows.map(declView) };
  });
```

### GET `/api/gov/work/tax/debtors`

Исходник: `api/src/routes/gov-ext.js:401`.

```js
  app.get('/work/tax/debtors', taxRole, async () => {
    const month = await currentMonth();
    const rows = await q(`SELECT c.id, c.full_name, c.passport_no, COUNT(*) AS n, SUM(i.amount) AS total, SUM(i.penalty) AS penalty, MIN(i.due_month) AS since
      FROM invoices i JOIN citizens c ON c.id = i.citizen_id WHERE i.status = 'unpaid' AND i.frozen = 0 AND i.kind IN ('tax','fine') AND i.due_month < ? GROUP BY c.id, c.full_name, c.passport_no ORDER BY total DESC LIMIT 300`, [month]);
    const sanctions = await q('SELECT s.*, c.full_name, c.passport_no FROM citizen_sanctions s JOIN citizens c ON c.id = s.citizen_id WHERE s.active = 1 ORDER BY s.id DESC');
    return {
      month,
      debtors: rows.map((r) => ({ ...r, n: Number(r.n), total: Number(r.total), penalty: Number(r.penalty), months_late: month - Number(r.since) })),
      sanctions: sanctions.map(sanctionView),
    };
  });
```

### POST `/api/gov/work/tax/assess`

Исходник: `api/src/routes/gov-ext.js:413`.

```js
  app.post('/work/tax/assess', taxRole, async (req) => {
    const b = req.body || {};
    const r = await tx(async (conn) => {
      const citizen = await citizenByPassport(conn, b.passport_no);
      const inv = await assessTax(conn, { citizen, amount: amountOf(b.amount, 'сумма'), purpose: str(b.purpose, 'основание', { min: 3, max: 200 }) });
      await audit(conn, actorOf(req.actor), 'tax.assess', 'citizen', citizen.id, { amount: Number(b.amount), invoice: inv.number });
      return inv;
    });
    return { invoice: r.number };
  });

  // Врач: расписание, приём, заключение.
```

### GET `/api/gov/work/doctor`

Исходник: `api/src/routes/gov-ext.js:425`.

```js
  app.get('/work/doctor', doctor, async (req) => {
    const id = req.actor.kind === 'gov' ? req.actor.id : 0;
    const rows = await q(`${SLOT_SELECT} WHERE s.doctor_gov_user_id = ? AND (s.status IN ('free','booked') OR s.done_at >= NOW(3) - INTERVAL 7 DAY) ORDER BY s.starts_at LIMIT 300`, [id]);
    return { slots: rows.map(slotView) };
  });
```

### POST `/api/gov/work/doctor/slots`

Исходник: `api/src/routes/gov-ext.js:431`.

```js
  app.post('/work/doctor/slots', doctor, async (req) => {
    need(req.actor.kind === 'gov', 'Расписание ведётся из аккаунта ВлодУслуг');
    const b = req.body || {};
    const start = new Date(String(b.starts_at || ''));
    need(!Number.isNaN(start.getTime()) && start > new Date(Date.now() - 60000), 'Укажите время приёма в будущем');
    const duration = int(Number(b.duration_min) || 15, 'длительность', { min: 5, max: 240 });
    const count = int(Number(b.count) || 1, 'количество', { min: 1, max: 48 });
    for (let i = 0; i < count; i++) {
      const at = new Date(start.getTime() + i * duration * 60000);
      await q('INSERT INTO doctor_slots (doctor_gov_user_id, starts_at, duration_min, priority) VALUES (?, ?, ?, ?)', [req.actor.id, at, duration, b.priority ? 1 : 0]);
    }
    return { ok: true, created: count };
  });

  async function mySlot(req, conn) {
    const s = await one('SELECT * FROM doctor_slots WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
    if (!s || (s.doctor_gov_user_id !== req.actor.id && !req.actor.roles.includes('admin'))) throw notFound('Приём не найден');
    return s;
  }
```

### POST `/api/gov/work/doctor/slots/:id/conclude`

Исходник: `api/src/routes/gov-ext.js:451`.

```js
  app.post('/work/doctor/slots/:id/conclude', doctor, async (req) => {
    await tx(async (conn) => {
      const s = await mySlot(req, conn);
      if (s.status !== 'booked') throw bad('invalid_state', 'На это время никто не записан');
      await q("UPDATE doctor_slots SET status = 'done', conclusion = ?, done_at = NOW(3) WHERE id = ?", [str(req.body?.conclusion, 'заключение', { min: 3, max: 2000 }), s.id], conn);
      const c = await one('SELECT * FROM citizens WHERE id = ?', [s.patient_citizen_id], conn);
      await notifyCitizen(conn, c, { title: 'Заключение врача готово', body: 'Игровое заключение — в разделе «Врач»', govLink: '#/doctor' });
    });
    return { ok: true };
  });
```

### POST `/api/gov/work/doctor/slots/:id/cancel`

Исходник: `api/src/routes/gov-ext.js:462`.

```js
  app.post('/work/doctor/slots/:id/cancel', doctor, async (req) => {
    await tx(async (conn) => {
      const s = await mySlot(req, conn);
      if (!['free', 'booked'].includes(s.status)) throw bad('invalid_state', 'Приём уже завершён');
      await q("UPDATE doctor_slots SET status = 'cancelled' WHERE id = ?", [s.id], conn);
      if (s.patient_citizen_id) {
        const c = await one('SELECT * FROM citizens WHERE id = ?', [s.patient_citizen_id], conn);
        await notifyCitizen(conn, c, { title: 'Приём у врача отменён', body: 'Запишитесь на другое время', govLink: '#/doctor' });
      }
    });
    return { ok: true };
  });

  // Чиновник: заявки на пособия.
```

### GET `/api/gov/work/benefits`

Исходник: `api/src/routes/gov-ext.js:476`.

```js
  app.get('/work/benefits', official, async (req) => {
    const status = ['pending', 'active', 'rejected', 'stopped'].includes(req.query.status) ? req.query.status : 'pending';
    const s = await getSettings();
    const rows = await q('SELECT b.*, c.full_name, c.passport_no, c.birth_date, c.children FROM benefits b JOIN citizens c ON c.id = b.citizen_id WHERE b.status = ? ORDER BY b.id DESC LIMIT 300', [status]);
    const out = [];
    for (const b of rows) out.push({ id: b.id, kind: b.kind, title: BENEFIT_TITLES[b.kind], status: b.status, full_name: b.full_name, passport_no: b.passport_no, age: ageFrom(b.birth_date), children: json(b.children, []).length, amount: await benefitAmount(b, b.kind, s), months_left: b.months_left, created_at: b.created_at });
    return { benefits: out };
  });
```

### POST `/api/gov/work/benefits/:id/decide`

Исходник: `api/src/routes/gov-ext.js:485`.

```js
  app.post('/work/benefits/:id/decide', official, async (req) => {
    await tx(async (conn) => {
      const b = await one('SELECT * FROM benefits WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
      if (!b) throw notFound();
      await decideBenefit(conn, { benefit: b, approve: !!req.body?.approve, by: `${req.actor.kind}:${req.actor.id}`, note: str(req.body?.note, 'комментарий', { optional: true, max: 255 }) });
      await audit(conn, actorOf(req.actor), req.body?.approve ? 'gov.benefit_approve' : 'gov.benefit_reject', 'benefit', b.id);
    });
    return { ok: true };
  });
```

### POST `/api/gov/work/benefits/:id/stop`

Исходник: `api/src/routes/gov-ext.js:495`.

```js
  app.post('/work/benefits/:id/stop', official, async (req) => {
    const r = await q("UPDATE benefits SET status = 'stopped', note = ? WHERE id = ? AND status = 'active'", [str(req.body?.note, 'причина', { optional: true, max: 255 }), int(req.params.id, 'id')]);
    if (!r.affectedRows) throw bad('invalid_state', 'Пособие не выплачивается');
    return { ok: true };
  });
}
```


## domains.js — `api/src/routes/domains.js`

### GET `/api/gov/orgs`

Исходник: `api/src/routes/domains.js:28`.

```js
  app.get('/orgs', auth, async (req) => {
    const rows = await q("SELECT o.*, m.role FROM organizations o JOIN org_members m ON m.org_id = o.id WHERE m.gov_user_id = ? AND o.status = 'active' ORDER BY o.id", [req.gov.id]);
    const apps = await q("SELECT id, type, status, data, created_at FROM applications WHERE gov_user_id = ? AND type IN ('org','license') AND status IN ('pending','awaiting_payment') ORDER BY id DESC", [req.gov.id]);
    return { orgs: rows.map(orgView), kinds: ORG_KINDS, license_kinds: LICENSE_KINDS, pending: apps };
  });
```

### POST `/api/gov/orgs/apply`

Исходник: `api/src/routes/domains.js:34`.

```js
  app.post('/orgs/apply', auth, async (req) => {
    const b = req.body || {};
    const kind = String(b.kind || '');
    need(kind === 'llc' || kind === 'jsc', 'Вид организации: ООО или АО');
    const name = str(b.name, 'название', { min: 2, max: 100 });
    const a = await tx(async (conn) => {
      const citizen = await citizenOf(req.gov.id, conn);
      if (!citizen || !(await activePassport(citizen.id, conn))) throw bad('no_passport', 'Сначала получите паспорт БФ');
      const inn = await one("SELECT id FROM documents WHERE citizen_id = ? AND type = 'inn' AND status = 'active'", [citizen.id], conn);
      if (!inn) throw bad('no_inn', 'Для регистрации организации нужен ИНН');
      if (await one("SELECT id FROM applications WHERE gov_user_id = ? AND type = 'org' AND status IN ('pending','awaiting_payment')", [req.gov.id], conn)) throw bad('already_pending', 'Заявление уже подано');
      const res = await submitApplication(conn, { govUserId: req.gov.id, citizenId: citizen.id, type: 'org', data: { kind, name } });
      await audit(conn, actor(req), 'gov.org_apply', 'application', res.id);
      return res;
    });
    return { application: { id: a.id, status: a.status } };
  });
```

### GET `/api/gov/orgs/:id`

Исходник: `api/src/routes/domains.js:52`.

```js
  app.get('/orgs/:id', auth, async (req) => {
    const org = await memberOrg(null, int(req.params.id, 'id'), req.gov.id);
    const month = await currentMonth();
    const acc = await one('SELECT id, number, balance, status FROM accounts WHERE id = ?', [org.account_id]);
    const history = await q(
      `SELECT e.id, e.amount, e.balance_after, t.kind, t.memo, t.created_at FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id
       WHERE e.account_id = ? ORDER BY e.id DESC LIMIT 30`, [org.account_id],
    );
    const members = await q('SELECT m.gov_user_id, m.role, c.full_name, c.passport_no FROM org_members m LEFT JOIN citizens c ON c.gov_user_id = m.gov_user_id WHERE m.org_id = ? ORDER BY m.role, c.full_name', [org.id]);
    const licenses = await q('SELECT kind, number, status, issued_month, expires_month FROM licenses WHERE org_id = ? ORDER BY id DESC', [org.id]);
    const tlds = await q('SELECT * FROM tlds WHERE active = 1 ORDER BY name');
    const isRegistrar = await hasLicense(null, org.id, 'registrar', month);
    const prices = isRegistrar ? await q('SELECT tld_id, price FROM registrar_prices WHERE org_id = ?', [org.id]) : [];
    const s = await getSettings();
    const registrarTlds = isRegistrar ? await Promise.all(tlds.filter((t) => !t.restricted).map(async (t) => {
      const w = await wholesale(null, t);
      // Минимальная цена: после НДС регистратору должно хватить на оптовую цену реестра.
      const min = Math.ceil((w * (10000 + Number(s.vat_bp || 0))) / 10000);
      return { id: t.id, name: disp(t.name), wholesale: w, min_price: min, price: prices.find((p) => p.tld_id === t.id)?.price ?? null };
    })) : [];
    const registry = tlds.filter((t) => t.registry_org_id === org.id).map((t) => ({ id: t.id, name: disp(t.name), wholesale_price: Number(t.wholesale_price) }));
    const domains = isRegistrar ? await q("SELECT name, status, expires_month FROM domains WHERE registrar_org_id = ? AND status <> 'released' ORDER BY name LIMIT 200", [org.id]) : [];
    return {
      org: { ...orgView(org), account: acc ? { ...acc, balance: Number(acc.balance) } : null },
      history: history.map((h) => ({ ...h, amount: Number(h.amount), balance_after: Number(h.balance_after) })),
      members, licenses, is_registrar: isRegistrar, registrar_tlds: registrarTlds, registry, sold_domains: domains.map((d) => ({ ...d, name: disp(d.name) })),
    };
  });
```

### POST `/api/gov/orgs/:id/members`

Исходник: `api/src/routes/domains.js:81`.

```js
  app.post('/orgs/:id/members', auth, async (req) => {
    await tx(async (conn) => {
      const org = await memberOrg(conn, int(req.params.id, 'id'), req.gov.id, { directorOnly: true });
      const c = await one('SELECT gov_user_id FROM citizens WHERE passport_no = ?', [String(req.body?.passport || '').trim().toUpperCase()], conn);
      if (!c) throw notFound('Гражданин с таким паспортом не найден');
      if (await one('SELECT role FROM org_members WHERE org_id = ? AND gov_user_id = ?', [org.id, c.gov_user_id], conn)) throw bad('already_member', 'Уже сотрудник');
      await q("INSERT INTO org_members (org_id, gov_user_id, role) VALUES (?, ?, 'staff')", [org.id, c.gov_user_id], conn);
      await audit(conn, actor(req), 'org.member_add', 'organization', org.id, { gov_user_id: c.gov_user_id });
    });
    return { ok: true };
  });
```

### DELETE `/api/gov/orgs/:id/members/:uid`

Исходник: `api/src/routes/domains.js:93`.

```js
  app.delete('/orgs/:id/members/:uid', auth, async (req) => {
    await tx(async (conn) => {
      const org = await memberOrg(conn, int(req.params.id, 'id'), req.gov.id, { directorOnly: true });
      const uid = int(req.params.uid, 'uid');
      need(uid !== req.gov.id, 'Директор не может уволить себя');
      await q("DELETE FROM org_members WHERE org_id = ? AND gov_user_id = ? AND role = 'staff'", [org.id, uid], conn);
      await audit(conn, actor(req), 'org.member_remove', 'organization', org.id, { gov_user_id: uid });
    });
    return { ok: true };
  });

  // Перевод со счёта организации на любой счёт ВлодБанка (зарплата, вывод прибыли, оплата поставщику).
```

### POST `/api/gov/orgs/:id/transfer`

Исходник: `api/src/routes/domains.js:105`.

```js
  app.post('/orgs/:id/transfer', auth, async (req) => {
    const b = req.body || {};
    const sum = amountArg(b.amount);
    const r = await tx(async (conn) => {
      const org = await memberOrg(conn, int(req.params.id, 'id'), req.gov.id, { directorOnly: true });
      const to = await one("SELECT id, status FROM accounts WHERE number = ? AND owner_kind <> 'system'", [String(b.to || '').trim().toUpperCase()], conn);
      if (!to) throw notFound('Счёт получателя не найден');
      need(to.id !== org.account_id, 'Это счёт самой организации');
      const res = await post(conn, {
        kind: 'org_transfer', memo: str(b.memo, 'назначение', { optional: true, max: 120 }) || `Перевод от ${ORG_KINDS[org.kind]} «${org.name}»`,
        entries: [{ account: org.account_id, amount: -sum }, { account: to.id, amount: sum }], actor: actor(req), idem: req.headers['idempotency-key'] ? `org:${org.id}:${req.headers['idempotency-key']}` : null,
      });
      await audit(conn, actor(req), 'org.transfer', 'organization', org.id, { to: b.to, amount: sum });
      return res;
    });
    return { ok: true, tx: r.id };
  });
```

### POST `/api/gov/orgs/:id/pay-invoice`

Исходник: `api/src/routes/domains.js:123`.

```js
  app.post('/orgs/:id/pay-invoice', auth, async (req) => {
    const r = await tx(async (conn) => {
      const org = await memberOrg(conn, int(req.params.id, 'id'), req.gov.id, { directorOnly: true });
      return payInvoice(conn, String(req.body?.number || '').trim().toUpperCase(), { fromAccount: org.account_id, via: 'bank', actor: actor(req) });
    });
    return { ok: true, tx: r.tx };
  });
```

### POST `/api/gov/orgs/:id/licenses`

Исходник: `api/src/routes/domains.js:131`.

```js
  app.post('/orgs/:id/licenses', auth, async (req) => {
    const kind = String(req.body?.kind || '');
    need(LICENSE_KINDS[kind]?.applicable, 'Эту лицензию выдаёт только администрация БалНета');
    const a = await tx(async (conn) => {
      const org = await memberOrg(conn, int(req.params.id, 'id'), req.gov.id, { directorOnly: true });
      need(org.kind !== 'gov', 'Госучреждениям лицензию выдаёт администрация');
      if (await hasLicense(conn, org.id, kind, await currentMonth(conn))) throw bad('already_have', 'Лицензия уже действует');
      if (await one("SELECT id FROM applications WHERE type = 'license' AND status IN ('pending','awaiting_payment') AND JSON_EXTRACT(data, '$.org_id') = ? AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.kind')) = ?", [org.id, kind], conn)) throw bad('already_pending', 'Заявление уже подано');
      const citizen = await citizenOf(req.gov.id, conn);
      const res = await submitApplication(conn, { govUserId: req.gov.id, citizenId: citizen?.id || null, type: 'license', data: { org_id: org.id, kind, org_name: org.name, title: LICENSE_KINDS[kind].title } });
      await audit(conn, actor(req), 'org.license_apply', 'application', res.id, { kind });
      return res;
    });
    return { application: { id: a.id, status: a.status } };
  });

  // Цены регистратора на зоны (null — не продавать).
```

### PUT `/api/gov/orgs/:id/prices`

Исходник: `api/src/routes/domains.js:148`.

```js
  app.put('/orgs/:id/prices', auth, async (req) => {
    const b = req.body || {};
    await tx(async (conn) => {
      const org = await memberOrg(conn, int(req.params.id, 'id'), req.gov.id, { directorOnly: true });
      need(await hasLicense(conn, org.id, 'registrar', await currentMonth(conn)), 'Нужна лицензия регистратора');
      const tld = await one('SELECT * FROM tlds WHERE id = ? AND active = 1', [int(b.tld_id, 'зона')], conn);
      if (!tld || tld.restricted) throw notFound('Зона не найдена');
      if (b.price === null || b.price === '') {
        await q('DELETE FROM registrar_prices WHERE org_id = ? AND tld_id = ?', [org.id, tld.id], conn);
        return;
      }
      const price = amountArg(b.price, 'цена');
      const s = await getSettings();
      need(price - vatIncluded(price, Number(s.vat_bp || 0)) >= (await wholesale(conn, tld)), 'Цена после НДС должна покрывать оптовую цену реестра', 'price_below_wholesale');
      await q('INSERT INTO registrar_prices (org_id, tld_id, price) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE price = VALUES(price)', [org.id, tld.id, price], conn);
      await audit(conn, actor(req), 'org.registrar_price', 'organization', org.id, { tld: tld.name, price });
    });
    return { ok: true };
  });

  // Реестр зоны задаёт оптовую цену.
```

### PUT `/api/gov/orgs/:id/registry/:tld`

Исходник: `api/src/routes/domains.js:169`.

```js
  app.put('/orgs/:id/registry/:tld', auth, async (req) => {
    await tx(async (conn) => {
      const org = await memberOrg(conn, int(req.params.id, 'id'), req.gov.id, { directorOnly: true });
      const tld = await one('SELECT * FROM tlds WHERE id = ? AND registry_org_id = ?', [int(req.params.tld, 'зона'), org.id], conn);
      if (!tld) throw notFound('Организация не ведёт эту зону');
      const price = int(req.body?.wholesale_price, 'оптовая цена', { min: 0, max: 1e12 });
      await q('UPDATE tlds SET wholesale_price = ? WHERE id = ?', [price, tld.id], conn);
      await audit(conn, actor(req), 'org.registry_price', 'organization', org.id, { tld: tld.name, price });
    });
    return { ok: true };
  });

  // ——— Домены ———
  // Публично, как на сайте любого регистратора: зоны и цены, проверка имени.
```

### GET `/api/gov/domains/zones`

Исходник: `api/src/routes/domains.js:183`.

```js
  app.get('/domains/zones', async () => {
    const month = await currentMonth();
    const tlds = await q('SELECT * FROM tlds WHERE active = 1 ORDER BY restricted IS NOT NULL, gov_price DESC, name');
    return {
      zones: await Promise.all(tlds.map(async (t) => {
        const offers = await registrarOffers(null, t, month);
        return { name: disp(t.name), restricted: t.restricted, price: offers[0].price, min_price: Math.min(...offers.map((o) => o.price)), registrars: offers.length };
      })),
    };
  });
```

### GET `/api/gov/domains/check`

Исходник: `api/src/routes/domains.js:194`.

```js
  app.get('/domains/check', async (req) => {
    const month = await currentMonth();
    const { name, tld } = await parseDomain(null, req.query.name);
    const av = await availability(null, name, tld);
    return { name: disp(name), tld: disp(tld.name), restricted: tld.restricted, ...av, offers: av.free ? await registrarOffers(null, tld, month) : [] };
  });
```

### GET `/api/gov/domains`

Исходник: `api/src/routes/domains.js:201`.

```js
  app.get('/domains', auth, async (req) => {
    const rows = await q(
      `SELECT d.* FROM domains d LEFT JOIN org_members m ON m.org_id = d.owner_org_id AND m.gov_user_id = ?
       WHERE d.status <> 'released' AND (d.owner_gov_user_id = ? OR m.gov_user_id IS NOT NULL) ORDER BY d.name`, [req.gov.id, req.gov.id],
    );
    const tlds = await q('SELECT id, name, restricted FROM tlds WHERE active = 1 ORDER BY name');
    const auctions = await q("SELECT a.*, (SELECT MAX(amount) FROM auction_bids b WHERE b.auction_id = a.id) AS top, (SELECT COUNT(*) FROM auction_bids b WHERE b.auction_id = a.id) AS bids, (SELECT MAX(amount) FROM auction_bids b WHERE b.auction_id = a.id AND b.gov_user_id = ?) AS my_bid FROM auctions a WHERE a.status IN ('open','awaiting_payment') ORDER BY a.ends_month, a.id", [req.gov.id]);
    const s = await getSettings();
    return {
      domains: await Promise.all(rows.map((d) => domainView(null, d))),
      tlds: tlds.map((t) => ({ ...t, name: disp(t.name) })),
      auctions: auctions.map((a) => ({ id: a.id, name: disp(a.name), status: a.status, reason: a.reason, min_bid: Number(a.min_bid), top: a.top ? Number(a.top) : null, bids: Number(a.bids), my_bid: a.my_bid ? Number(a.my_bid) : null, ends_month: a.ends_month, winner_me: a.winner_gov_user_id === req.gov.id })),
      month: await currentMonth(),
      max_years: Number(s.domain_max_years || 10),
      redemption_fee: Number(s.domain_redemption_fee || 0),
    };
  });
```

### POST `/api/gov/domains`

Исходник: `api/src/routes/domains.js:219`.

```js
  app.post('/domains', auth, async (req) => {
    const b = req.body || {};
    const r = await tx(async (conn) => {
      const citizen = await citizenOf(req.gov.id, conn);
      if (!citizen || !(await activePassport(citizen.id, conn))) throw bad('no_passport', 'Домены регистрируют граждане с паспортом БФ');
      const res = await registerDomain(conn, { govUserId: req.gov.id, name: b.name, registrarOrgId: b.registrar_org_id ? int(b.registrar_org_id, 'регистратор') : null, years: b.years, ownerOrgId: b.owner_org_id ? int(b.owner_org_id, 'организация') : null });
      await audit(conn, actor(req), 'domain.register', 'domain', res.domain_id, { name: b.name });
      return res;
    });
    return r;
  });
```

### GET `/api/gov/domains/:id`

Исходник: `api/src/routes/domains.js:231`.

```js
  app.get('/domains/:id', auth, async (req) => {
    const d = await ownDomain(null, int(req.params.id, 'id'), req.gov.id);
    const records = d.zone_id ? await q('SELECT id, name, type, ttl, data FROM dns_records WHERE zone_id = ? ORDER BY name, type, id', [d.zone_id]) : [];
    const tld = await one('SELECT * FROM tlds WHERE id = ?', [d.tld_id]);
    return {
      domain: await domainView(null, d, { withAuth: true }),
      records: records.map((r) => ({ ...r, rel: relativeName(r.name, d.name), locked: r.type === 'SOA' || (r.type === 'NS' && r.name === d.name) })),
      offers: await registrarOffers(null, tld, await currentMonth()),
    };
  });
```

### POST `/api/gov/domains/:id/renew`

Исходник: `api/src/routes/domains.js:242`.

```js
  app.post('/domains/:id/renew', auth, async (req) => {
    const r = await tx(async (conn) => renewDomain(conn, { govUserId: req.gov.id, id: int(req.params.id, 'id'), years: req.body?.years }));
    return r;
  });
```

### POST `/api/gov/domains/:id/transfer-registrar`

Исходник: `api/src/routes/domains.js:247`.

```js
  app.post('/domains/:id/transfer-registrar', auth, async (req) => {
    const b = req.body || {};
    return tx(async (conn) => transferRegistrar(conn, { govUserId: req.gov.id, id: int(req.params.id, 'id'), registrarOrgId: b.registrar_org_id ? int(b.registrar_org_id, 'регистратор') : null, authCode: b.auth_code }));
  });
```

### POST `/api/gov/domains/claim`

Исходник: `api/src/routes/domains.js:252`.

```js
  app.post('/domains/claim', auth, async (req) => {
    const b = req.body || {};
    const r = await tx(async (conn) => {
      const res = await claimDomain(conn, { govUserId: req.gov.id, name: b.name, authCode: b.auth_code, ownerOrgId: b.owner_org_id ? int(b.owner_org_id, 'организация') : null });
      await audit(conn, actor(req), 'domain.claim', 'domain', res.id);
      return res;
    });
    return r;
  });
```

### POST `/api/gov/domains/:id/auth-code`

Исходник: `api/src/routes/domains.js:262`.

```js
  app.post('/domains/:id/auth-code', auth, async (req) => {
    await tx(async (conn) => {
      const d = await ownDomain(conn, int(req.params.id, 'id'), req.gov.id, { lock: true });
      await q('UPDATE domains SET auth_code = ? WHERE id = ?', [newAuthCode(), d.id], conn);
    });
    return { ok: true };
  });
```

### POST `/api/gov/domains/:id/privacy`

Исходник: `api/src/routes/domains.js:270`.

```js
  app.post('/domains/:id/privacy', auth, async (req) => {
    const d = await ownDomain(null, int(req.params.id, 'id'), req.gov.id);
    await q('UPDATE domains SET privacy = ? WHERE id = ?', [req.body?.privacy ? 1 : 0, d.id]);
    return { ok: true };
  });
```

### POST `/api/gov/domains/:id/nameservers`

Исходник: `api/src/routes/domains.js:276`.

```js
  app.post('/domains/:id/nameservers', auth, async (req) => {
    const b = req.body || {};
    await tx(async (conn) => setNameservers(conn, { govUserId: req.gov.id, id: int(req.params.id, 'id'), mode: b.mode === 'custom' ? 'custom' : 'hosted', ns: b.ns }));
    return { ok: true };
  });

  // DNSSEC: подпись зоны на DNS-хостинге и запись DS в зоне TLD (её публикует регистратор).
```

### POST `/api/gov/domains/:id/dnssec`

Исходник: `api/src/routes/domains.js:283`.

```js
  app.post('/domains/:id/dnssec', auth, async (req) => {
    await tx(async (conn) => {
      const d = await ownDomain(conn, int(req.params.id, 'id'), req.gov.id, { lock: true });
      need(d.status === 'active', 'Домен не активен');
      const tld = await one('SELECT * FROM tlds WHERE id = ?', [d.tld_id], conn);
      if (req.body?.enabled) {
        need(d.ns_mode === 'hosted' && d.zone_id, 'DNSSEC на DNS-хостинге БалНета: переключите серверы имён на ns1/ns2.dns.bln');
        await enableDomainDnssec(conn, d, tld);
      } else await disableDomainDnssec(conn, d, tld);
      await audit(conn, actorOf(req.gov), req.body?.enabled ? 'domain.dnssec_on' : 'domain.dnssec_off', 'domain', d.id);
    });
    return { ok: true };
  });

  // Записи зоны на DNS-хостинге БалНета.
  async function hostedZone(conn, req) {
    const d = await ownDomain(conn, int(req.params.id, 'id'), req.gov.id, { lock: !!conn });
    need(d.zone_id, 'У домена нет зоны на DNS-хостинге БалНета');
    return { d, zone: await one('SELECT * FROM dns_zones WHERE id = ?', [d.zone_id], conn) };
  }
```

### POST `/api/gov/domains/:id/records`

Исходник: `api/src/routes/domains.js:304`.

```js
  app.post('/domains/:id/records', auth, async (req) => {
    await tx(async (conn) => {
      const { zone } = await hostedZone(conn, req);
      const rec = recordArgs(zone, req.body || {});
      need(!['SOA', 'NS'].includes(rec.type) || rec.name !== zone.name, 'SOA и NS вершины зоны задаёт DNS-хостинг');
      await checkRecord(conn, zone, rec);
      need(!(await one('SELECT id FROM dns_records WHERE zone_id = ? AND name = ? AND type = ? AND data = ?', [zone.id, rec.name, rec.type, rec.data], conn)), 'Такая запись уже есть');
      const count = await one('SELECT COUNT(*) AS n FROM dns_records WHERE zone_id = ?', [zone.id], conn);
      need(Number(count.n) < 200, 'В зоне не больше 200 записей');
      await q('INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, ?, ?, ?)', [zone.id, rec.name, rec.type, rec.ttl, rec.data], conn);
      await q('UPDATE dns_records SET ttl = ? WHERE zone_id = ? AND name = ? AND type = ?', [rec.ttl, zone.id, rec.name, rec.type], conn);
      await bumpSerial(conn, zone.id);
    });
    invalidateNet();
    return { ok: true };
  });
```

### PATCH `/api/gov/domains/:id/records/:rid`

Исходник: `api/src/routes/domains.js:321`.

```js
  app.patch('/domains/:id/records/:rid', auth, async (req) => {
    await tx(async (conn) => {
      const { zone } = await hostedZone(conn, req);
      const cur = await one('SELECT * FROM dns_records WHERE id = ? AND zone_id = ?', [int(req.params.rid, 'id'), zone.id], conn);
      if (!cur) throw notFound('Запись не найдена');
      need(!(cur.type === 'SOA' || (cur.type === 'NS' && cur.name === zone.name)), 'Эту запись задаёт DNS-хостинг');
      const b = req.body || {};
      const rec = recordArgs(zone, { name: b.name ?? cur.name, type: b.type ?? cur.type, ttl: b.ttl ?? cur.ttl, data: b.data ?? cur.data });
      need(!['SOA', 'NS'].includes(rec.type) || rec.name !== zone.name, 'SOA и NS вершины зоны задаёт DNS-хостинг');
      await checkRecord(conn, zone, rec, cur.id);
      await q('UPDATE dns_records SET name = ?, type = ?, ttl = ?, data = ? WHERE id = ?', [rec.name, rec.type, rec.ttl, rec.data, cur.id], conn);
      await bumpSerial(conn, zone.id);
    });
    invalidateNet();
    return { ok: true };
  });
```

### DELETE `/api/gov/domains/:id/records/:rid`

Исходник: `api/src/routes/domains.js:338`.

```js
  app.delete('/domains/:id/records/:rid', auth, async (req) => {
    await tx(async (conn) => {
      const { zone } = await hostedZone(conn, req);
      const cur = await one('SELECT * FROM dns_records WHERE id = ? AND zone_id = ?', [int(req.params.rid, 'id'), zone.id], conn);
      if (!cur) throw notFound('Запись не найдена');
      need(!(cur.type === 'SOA' || (cur.type === 'NS' && cur.name === zone.name)), 'Эту запись задаёт DNS-хостинг');
      await q('DELETE FROM dns_records WHERE id = ?', [cur.id], conn);
      await bumpSerial(conn, zone.id);
    });
    invalidateNet();
    return { ok: true };
  });
```

### POST `/api/gov/auctions/:id/bid`

Исходник: `api/src/routes/domains.js:351`.

```js
  app.post('/auctions/:id/bid', auth, async (req) => {
    const r = await tx(async (conn) => {
      const citizen = await citizenOf(req.gov.id, conn);
      if (!citizen || !(await activePassport(citizen.id, conn))) throw bad('no_passport', 'Участвовать могут граждане с паспортом БФ');
      return placeBid(conn, { govUserId: req.gov.id, auctionId: int(req.params.id, 'id'), amount: amountArg(req.body?.amount, 'ставка') });
    });
    return r;
  });
}
```


## hosting.js — `api/src/routes/hosting.js`

### GET `/api/gov/hosting/plans`

Исходник: `api/src/routes/hosting.js:45`.

```js
  app.get('/hosting/plans', async () => ({ offers: await offers(null, await currentMonth()) }));
```

### GET `/api/gov/hosting`

Исходник: `api/src/routes/hosting.js:47`.

```js
  app.get('/hosting', auth, async (req) => {
    const month = await currentMonth();
    const rows = await q(
      `SELECT a.* FROM hosting_accounts a LEFT JOIN org_members m ON m.org_id = a.owner_org_id AND m.gov_user_id = ?
       WHERE a.status <> 'deleted' AND (a.owner_gov_user_id = ? OR m.gov_user_id IS NOT NULL) ORDER BY a.id DESC`, [req.gov.id, req.gov.id],
    );
    const s = await getSettings();
    return { accounts: await Promise.all(rows.map((a) => accountView(null, a))), offers: await offers(null, month), month, max_months: Number(s.hosting_max_months || 12) };
  });
```

### POST `/api/gov/hosting`

Исходник: `api/src/routes/hosting.js:57`.

```js
  app.post('/hosting', auth, async (req) => {
    const b = req.body || {};
    return tx(async (conn) => {
      const citizen = await citizenOf(req.gov.id, conn);
      if (!citizen || !(await activePassport(citizen.id, conn))) throw bad('no_passport', 'Хостинг покупают граждане с паспортом БФ');
      const r = await buyHosting(conn, { govUserId: req.gov.id, planId: int(b.plan_id, 'тариф'), months: b.months, ownerOrgId: b.owner_org_id ? int(b.owner_org_id, 'организация') : null });
      await audit(conn, actor(req), 'hosting.buy', 'hosting_account', r.account_id);
      return r;
    });
  });
```

### GET `/api/gov/hosting/:id`

Исходник: `api/src/routes/hosting.js:68`.

```js
  app.get('/hosting/:id', auth, async (req) => {
    const a = await ownAccount(null, int(req.params.id, 'id'), req.gov.id);
    await refreshUsage(a.id);
    return { account: await accountView(null, { ...a, used_bytes: (await one('SELECT used_bytes FROM hosting_accounts WHERE id = ?', [a.id])).used_bytes }) };
  });
```

### POST `/api/gov/hosting/:id/renew`

Исходник: `api/src/routes/hosting.js:74`.

```js
  app.post('/hosting/:id/renew', auth, async (req) => tx(async (conn) => renewHosting(conn, { govUserId: req.gov.id, id: int(req.params.id, 'id'), months: req.body?.months })));
```

### POST `/api/gov/hosting/:id/sites`

Исходник: `api/src/routes/hosting.js:76`.

```js
  app.post('/hosting/:id/sites', auth, async (req) => tx(async (conn) => {
    const a = await ownAccount(conn, int(req.params.id, 'id'), req.gov.id);
    const r = await addSite(conn, { account: a, host: req.body?.host });
    await audit(conn, actor(req), 'hosting.site_add', 'hosting_account', a.id, { host: r.host });
    return r;
  }));
```

### DELETE `/api/gov/hosting/:id/sites/:sid`

Исходник: `api/src/routes/hosting.js:83`.

```js
  app.delete('/hosting/:id/sites/:sid', auth, async (req) => {
    await tx(async (conn) => {
      const a = await ownAccount(conn, int(req.params.id, 'id'), req.gov.id);
      await removeSite(conn, { account: a, siteId: int(req.params.sid, 'сайт') });
    });
    return { ok: true };
  });

  // ——— Файловый менеджер ———
  async function siteCtx(req, { write = false } = {}) {
    const a = await ownAccount(null, int(req.params.id, 'id'), req.gov.id);
    const s = await one('SELECT * FROM hosting_sites WHERE id = ? AND account_id = ?', [int(req.params.sid, 'сайт'), a.id]);
    if (!s) throw notFound('Сайт не найден');
    if (write) need(a.status === 'active', 'Хостинг приостановлен — файлы можно только смотреть и удалять');
    return { a, s, dir: siteDir(a.id, s.host), base: accountDir(a.id) };
  }
```

### GET `/api/gov/hosting/:id/sites/:sid/files`

Исходник: `api/src/routes/hosting.js:100`.

```js
  app.get('/hosting/:id/sites/:sid/files', auth, async (req) => {
    const { dir } = await siteCtx(req);
    return listDir(dir, req.query.path || '');
  });
```

### GET `/api/gov/hosting/:id/sites/:sid/file`

Исходник: `api/src/routes/hosting.js:105`.

```js
  app.get('/hosting/:id/sites/:sid/file', auth, async (req) => {
    const { dir } = await siteCtx(req);
    return readFile(dir, req.query.path || '');
  });
```

### PUT `/api/gov/hosting/:id/sites/:sid/file`

Исходник: `api/src/routes/hosting.js:110`.

```js
  app.put('/hosting/:id/sites/:sid/file', auth, async (req) => {
    const { a, dir, base } = await siteCtx(req, { write: true });
    const b = req.body || {};
    const r = await writeFile(dir, base, b.path, b.content, { binary: !!b.binary, ...(await limits(a)) });
    await refreshUsage(a.id);
    return r;
  });
```

### POST `/api/gov/hosting/:id/sites/:sid/mkdir`

Исходник: `api/src/routes/hosting.js:118`.

```js
  app.post('/hosting/:id/sites/:sid/mkdir', auth, async (req) => {
    const { dir } = await siteCtx(req, { write: true });
    return makeDir(dir, req.body?.path);
  });
```

### POST `/api/gov/hosting/:id/sites/:sid/rename`

Исходник: `api/src/routes/hosting.js:123`.

```js
  app.post('/hosting/:id/sites/:sid/rename', auth, async (req) => {
    const { dir } = await siteCtx(req, { write: true });
    return renamePath(dir, req.body?.from, req.body?.to);
  });
```

### DELETE `/api/gov/hosting/:id/sites/:sid/file`

Исходник: `api/src/routes/hosting.js:128`.

```js
  app.delete('/hosting/:id/sites/:sid/file', auth, async (req) => {
    const { a, s: site, dir } = await siteCtx(req);
    const r = await removePath(dir, req.query.path);
    closeDb(site.id);
    await refreshUsage(a.id);
    return r;
  });
```

### POST `/api/gov/hosting/:id/sites/:sid/zip`

Исходник: `api/src/routes/hosting.js:136`.

```js
  app.post('/hosting/:id/sites/:sid/zip', auth, async (req) => {
    const { a, s: site, dir, base } = await siteCtx(req, { write: true });
    const data = String(req.body?.data || '');
    need(data.length > 0, 'Пустой архив');
    const files = await extractZip(dir, base, Buffer.from(data, 'base64'), { ...(await limits(a)), into: req.body?.path || '' });
    closeDb(site.id);
    await refreshUsage(a.id);
    await audit(null, actor(req), 'hosting.zip', 'hosting_account', a.id, { files: files.length });
    return { files };
  });

  /** Аналитика сайта: посещения, посетители, страницы, источники, запросы из ВлодПоиска. */
```

### GET `/api/gov/hosting/:id/sites/:sid/analytics`

Исходник: `api/src/routes/hosting.js:148`.

```js
  app.get('/hosting/:id/sites/:sid/analytics', auth, async (req) => {
    const { s } = await siteCtx(req);
    return siteAnalytics(s, Math.min(60, Math.max(7, Number(req.query.days) || 14)));
  });

  /** Пароль SSH для аккаунта: вход ssh u<номер>@<адрес сервера> из терминала ВлодБраузера. */
```

### POST `/api/gov/hosting/:id/ssh`

Исходник: `api/src/routes/hosting.js:154`.

```js
  app.post('/hosting/:id/ssh', auth, async (req) => {
    const a = await ownAccount(null, int(req.params.id, 'id'), req.gov.id);
    const pw = String(req.body?.password || '');
    if (!pw) { await q('UPDATE hosting_accounts SET ssh_hash = NULL WHERE id = ?', [a.id]); return { enabled: false }; }
    need(pw.length >= 8, 'Пароль SSH — не короче 8 символов');
    await q('UPDATE hosting_accounts SET ssh_hash = ? WHERE id = ?', [await hash(pw), a.id]);
    await audit(null, actor(req), 'hosting.ssh_password', 'hosting_account', a.id);
    return { enabled: true };
  });

  // ——— Серверный код (виртуальный тариф): журнал, SQL-консоль, key-value, примеры ———
  async function vsite(req) {
    const c = await siteCtx(req);
    const site = await siteByTarget(`site:${c.s.id}`);
    need(site.kind === 'virtual', 'Серверный код работает на виртуальном тарифе');
    return { ...c, site };
  }
```

### GET `/api/gov/hosting/:id/sites/:sid/logs`

Исходник: `api/src/routes/hosting.js:172`.

```js
  app.get('/hosting/:id/sites/:sid/logs', auth, async (req) => {
    const { s } = await siteCtx(req);
    return { logs: getLogs(s.id) };
  });
```

### DELETE `/api/gov/hosting/:id/sites/:sid/logs`

Исходник: `api/src/routes/hosting.js:176`.

```js
  app.delete('/hosting/:id/sites/:sid/logs', auth, async (req) => {
    const { s } = await siteCtx(req);
    clearLogs(s.id);
    return { ok: true };
  });

  /** SQL-консоль базы сайта (как phpMyAdmin у хостера). */
```

### POST `/api/gov/hosting/:id/sites/:sid/sql`

Исходник: `api/src/routes/hosting.js:183`.

```js
  app.post('/hosting/:id/sites/:sid/sql', auth, async (req) => {
    const { a, site } = await vsite(req);
    const sql = str(req.body?.sql, 'SQL', { max: 20000 });
    return withSite(site.id, async () => {
      const e = await siteDb(site);
      let result;
      try { result = sqlExec(e, sql); } catch (err) { throw bad('sql', `SQLite: ${err.message}`); }
      const quota = (await limits(a)).quotaBytes - (await refreshUsage(a.id));
      await flush(site.id, { quotaLeft: quota });
      const tables = sqlQuery(e, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
      return { result: result.map((r) => ({ ...r, rows: r.rows.slice(0, 500) })), tables };
    });
  });
```

### GET `/api/gov/hosting/:id/sites/:sid/kv`

Исходник: `api/src/routes/hosting.js:197`.

```js
  app.get('/hosting/:id/sites/:sid/kv', auth, async (req) => {
    const { site } = await vsite(req);
    return withSite(site.id, async () => {
      const e = await siteDb(site);
      const now = await gameSeconds();
      const rows = sqlQuery(e, 'SELECT k, v, exp FROM _kv WHERE exp IS NULL OR exp > ? ORDER BY k LIMIT 500', [now]);
      const tables = sqlQuery(e, "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").map((r) => r.name);
      return { now, keys: rows.map((r) => ({ key: r.k, value: r.v.slice(0, 500), exp: r.exp })), tables, crontab: await fs.readFile(`${site.dir}/crontab`, 'utf8').then((t) => parseCrontab(t), () => null) };
    });
  });

  // ——— Почта сайта: ключ DKIM для mail.send({ dkim: селектор }) и запись для DNS ———
```

### GET `/api/gov/hosting/:id/sites/:sid/dkim`

Исходник: `api/src/routes/hosting.js:209`.

```js
  app.get('/hosting/:id/sites/:sid/dkim', auth, async (req) => {
    const { site } = await vsite(req);
    const { publicFromPrivate, dkimRecord } = await import('../lib/mailnet/dkim.js');
    const keys = [];
    for (const f of await fs.readdir(`${site.dir}/.dkim`).catch(() => [])) {
      if (!f.endsWith('.key')) continue;
      const sel = f.slice(0, -4);
      try {
        const pub = publicFromPrivate((await fs.readFile(`${site.dir}/.dkim/${f}`, 'utf8')).trim());
        keys.push({ selector: sel, record: { name: `${sel}._domainkey`, type: 'TXT', data: dkimRecord(pub) } });
      } catch { keys.push({ selector: sel, error: 'Ключ повреждён' }); }
    }
    return { keys, ip: site.server_ip, spf: `v=spf1 ip4:${site.server_ip} -all`, mx: `10 ${site.host}.` };
  });
```

### POST `/api/gov/hosting/:id/sites/:sid/dkim`

Исходник: `api/src/routes/hosting.js:223`.

```js
  app.post('/hosting/:id/sites/:sid/dkim', auth, async (req) => {
    const { a, dir, base, site } = await vsite(req);
    const sel = String(req.body?.selector || 'mail').trim().toLowerCase();
    need(/^[a-z0-9-]{1,63}$/.test(sel), 'Селектор: латиница, цифры и дефис');
    const { generateDkimKey, dkimRecord } = await import('../lib/mailnet/dkim.js');
    const k = generateDkimKey();
    await fs.mkdir(`${dir}/.dkim`, { recursive: true });
    await writeFile(dir, base, `.dkim/${sel}.key`, `${k.privateKey}\n`, await limits(a));
    await refreshUsage(a.id);
    await audit(null, actor(req), 'hosting.dkim', 'hosting_site', site.id, { selector: sel });
    return { selector: sel, record: { name: `${sel}._domainkey`, type: 'TXT', data: dkimRecord(k.publicKey) } };
  });

  /** Готовый пример: гостевая книга на SQLite с cron. */
```

### POST `/api/gov/hosting/:id/sites/:sid/example`

Исходник: `api/src/routes/hosting.js:237`.

```js
  app.post('/hosting/:id/sites/:sid/example', auth, async (req) => {
    const { a, dir, base } = await vsite(req);
    const lim = await limits(a);
    for (const [path, content] of Object.entries(EXAMPLE)) {
      const exists = await fs.stat(`${dir}/${path}`).then(() => true, () => false);
      if (!exists || req.body?.overwrite) await writeFile(dir, base, path, content, lim);
    }
    await refreshUsage(a.id);
    return { files: Object.keys(EXAMPLE) };
  });

  // ——— Кабинет хостера ———
```

### GET `/api/gov/orgs/:id/hosting`

Исходник: `api/src/routes/hosting.js:249`.

```js
  app.get('/orgs/:id/hosting', auth, async (req) => {
    const org = await memberOrg(null, int(req.params.id, 'id'), req.gov.id);
    const month = await currentMonth();
    const servers = await q("SELECT s.*, (SELECT COUNT(*) FROM hosting_accounts a WHERE a.server_id = s.id AND a.status IN ('active','suspended')) AS accounts, (SELECT COALESCE(SUM(p.disk_mb),0) FROM hosting_accounts a JOIN hosting_plans p ON p.id = a.plan_id WHERE a.server_id = s.id AND a.status IN ('reserved','active','suspended')) AS sold_mb FROM hosting_servers s WHERE s.org_id = ? AND s.status <> 'closed' ORDER BY s.id", [org.id]);
    const plans = await q('SELECT * FROM hosting_plans WHERE org_id = ? ORDER BY id', [org.id]);
    const s = await getSettings();
    return {
      licensed: await hasLicense(null, org.id, 'hosting', month),
      rent: Number(s.hosting_server_rent || 0),
      disk_mb: Number(s.hosting_server_disk_mb || 500),
      servers: servers.map((x) => ({ ...x, rent_price: Number(x.rent_price), accounts: Number(x.accounts), sold_mb: Number(x.sold_mb), name: x.name.replace(/\.$/, '') })),
      plans: plans.map((p) => ({ ...p, price_month: Number(p.price_month), active: !!p.active })),
    };
  });
```

### POST `/api/gov/orgs/:id/servers`

Исходник: `api/src/routes/hosting.js:264`.

```js
  app.post('/orgs/:id/servers', auth, async (req) => tx(async (conn) => {
    const org = await memberOrg(conn, int(req.params.id, 'id'), req.gov.id, { directorOnly: true });
    const r = await rentServer(conn, { orgId: org.id });
    await audit(conn, actor(req), 'hosting.server_rent', 'organization', org.id, r);
    return r;
  }));
```

### POST `/api/gov/orgs/:id/plans`

Исходник: `api/src/routes/hosting.js:271`.

```js
  app.post('/orgs/:id/plans', auth, async (req) => {
    const b = req.body || {};
    return tx(async (conn) => {
      const org = await memberOrg(conn, int(req.params.id, 'id'), req.gov.id, { directorOnly: true });
      need(await hasLicense(conn, org.id, 'hosting', await currentMonth(conn)), 'Нужна лицензия хостинг-провайдера');
      const server = await one("SELECT * FROM hosting_servers WHERE id = ? AND org_id = ? AND status <> 'closed'", [int(b.server_id, 'сервер'), org.id], conn);
      if (!server) throw notFound('Сервер не найден');
      const disk = int(b.disk_mb, 'место, МБ', { min: 1, max: server.disk_mb });
      const r = await q('INSERT INTO hosting_plans (org_id, server_id, name, disk_mb, max_sites, price_month, kind, rpm, cpu_ms, ws_limit, cron_min) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        org.id, server.id, str(b.name, 'название', { max: 80 }), disk, int(b.max_sites ?? 5, 'сайтов', { min: 1, max: 100 }), amountArg(b.price_month, 'цена'), ...planKind(b),
      ], conn);
      await audit(conn, actor(req), 'hosting.plan_create', 'organization', org.id, { plan: r.insertId });
      return { id: r.insertId };
    });
  });
```

### PATCH `/api/gov/orgs/:id/plans/:pid`

Исходник: `api/src/routes/hosting.js:287`.

```js
  app.patch('/orgs/:id/plans/:pid', auth, async (req) => {
    const b = req.body || {};
    await tx(async (conn) => {
      const org = await memberOrg(conn, int(req.params.id, 'id'), req.gov.id, { directorOnly: true });
      const p = await one('SELECT * FROM hosting_plans WHERE id = ? AND org_id = ?', [int(req.params.pid, 'тариф'), org.id], conn);
      if (!p) throw notFound('Тариф не найден');
      await q('UPDATE hosting_plans SET active = ?, price_month = ? WHERE id = ?', [b.active !== undefined ? (b.active ? 1 : 0) : p.active, b.price_month !== undefined ? amountArg(b.price_month, 'цена') : p.price_month, p.id], conn);
    });
    return { ok: true };
  });
}
```


## certs.js — `api/src/routes/certs.js`

### GET `/api/gov/certs/cas`

Исходник: `api/src/routes/certs.js:29`.

```js
  app.get('/certs/cas', async () => ({ cas: await caList(null), policies: POLICIES }));
```

### GET `/api/gov/certs/ct`

Исходник: `api/src/routes/certs.js:30`.

```js
  app.get('/certs/ct', async (req) => ({ entries: await ctSearch(req.query.q) }));

  // ——— Мои сертификаты ———
```

### GET `/api/gov/certs`

Исходник: `api/src/routes/certs.js:33`.

```js
  app.get('/certs', auth, async (req) => {
    const rows = await q(
      `SELECT DISTINCT c.* FROM pki_certs c LEFT JOIN org_members m ON m.org_id = c.owner_org_id AND m.gov_user_id = ?
       WHERE c.gov_site = 0 AND (c.owner_gov_user_id = ? OR m.gov_user_id IS NOT NULL) ORDER BY c.id DESC LIMIT 200`, [req.gov.id, req.gov.id],
    );
    const certs = [];
    for (const c of rows) certs.push(await certView(null, c));
    const orders = await q("SELECT id, policy, amount, status, cert_id, created_at FROM pki_orders WHERE gov_user_id = ? AND status = 'pending' ORDER BY id DESC", [req.gov.id]);
    const myCas = await q("SELECT c.id, c.name, c.identifier, c.org_id, c.prices, c.status, r.trusted FROM pki_cas c JOIN org_members m ON m.org_id = c.org_id AND m.gov_user_id = ? LEFT JOIN pki_cas r ON r.id = c.parent_id WHERE c.kind = 'ca'", [req.gov.id]);
    return { certs, orders, my_cas: myCas.map((c) => ({ ...c, prices: parse(c.prices), trusted: !!c.trusted })), reasons: REVOKE_REASONS };
  });
```

### GET `/api/gov/certs/:id`

Исходник: `api/src/routes/certs.js:45`.

```js
  app.get('/certs/:id', auth, async (req) => {
    const c = await ownCert(null, int(req.params.id, 'id'), req.gov.id);
    return { cert: await certView(null, c) };
  });

  // Закрытый ключ и сертификат — для установки на свой сервер (как у настоящих УЦ).
```

### GET `/api/gov/certs/:id/files`

Исходник: `api/src/routes/certs.js:51`.

```js
  app.get('/certs/:id/files', auth, async (req) => {
    const c = await ownCert(null, int(req.params.id, 'id'), req.gov.id);
    return { key: pem('PRIVATE KEY', c.pkcs8), cert: JSON.stringify(parse(c.cert), null, 2) };
  });

  // ——— Проверка домена и заказ ———
```

### POST `/api/gov/certs/challenges`

Исходник: `api/src/routes/certs.js:57`.

```js
  app.post('/certs/challenges', auth, async (req) => tx(async (conn) => {
    await needPassport(conn, req.gov.id);
    return createChallenge(conn, { govUserId: req.gov.id, names: req.body?.names, method: req.body?.method });
  }));
```

### GET `/api/gov/certs/challenges/:id`

Исходник: `api/src/routes/certs.js:62`.

```js
  app.get('/certs/challenges/:id', auth, async (req) => {
    const c = await one('SELECT * FROM pki_challenges WHERE id = ? AND gov_user_id = ?', [int(req.params.id, 'id'), req.gov.id]);
    if (!c) throw notFound('Заявка не найдена');
    return challengeView(c);
  });

  /** Предварительная проверка (ничего не выпускает). */
```

### POST `/api/gov/certs/challenges/:id/check`

Исходник: `api/src/routes/certs.js:69`.

```js
  app.post('/certs/challenges/:id/check', auth, async (req) => {
    const c = await one('SELECT * FROM pki_challenges WHERE id = ? AND gov_user_id = ?', [int(req.params.id, 'id'), req.gov.id]);
    if (!c) throw notFound('Заявка не найдена');
    const ca = req.body?.ca_id ? await one("SELECT * FROM pki_cas WHERE id = ? AND kind = 'ca'", [int(req.body.ca_id, 'УЦ')]) : await govCa(null);
    if (!ca) throw notFound('УЦ не найден');
    return validateChallenge(c, ca.identifier || '');
  });
```

### POST `/api/gov/certs/orders`

Исходник: `api/src/routes/certs.js:77`.

```js
  app.post('/certs/orders', auth, async (req) => {
    const b = req.body || {};
    return tx(async (conn) => {
      await needPassport(conn, req.gov.id);
      const r = await orderCert(conn, {
        govUserId: req.gov.id, challengeId: int(b.challenge_id, 'заявка'), caId: b.ca_id ? int(b.ca_id, 'УЦ') : null,
        policy: String(b.policy || 'DV'), ownerOrgId: b.owner_org_id ? int(b.owner_org_id, 'организация') : null,
      });
      if (r.cert_id) await audit(conn, actor(req), 'cert.issue', 'cert', r.cert_id);
      return r;
    });
  });
```

### POST `/api/gov/certs/self`

Исходник: `api/src/routes/certs.js:90`.

```js
  app.post('/certs/self', auth, async (req) => tx(async (conn) => {
    const orgId = req.body?.owner_org_id ? int(req.body.owner_org_id, 'организация') : null;
    if (orgId) await memberOrg(conn, orgId, req.gov.id);
    const id = await selfSigned(conn, { govUserId: req.gov.id, names: req.body?.names, ownerOrg: orgId });
    return { cert_id: id };
  }));
```

### POST `/api/gov/certs/:id/revoke`

Исходник: `api/src/routes/certs.js:97`.

```js
  app.post('/certs/:id/revoke', auth, async (req) => tx(async (conn) => {
    const c = await ownCert(conn, int(req.params.id, 'id'), req.gov.id);
    await revokeCert(conn, c, String(req.body?.reason || 'unspecified'));
    await audit(conn, actor(req), 'cert.revoke', 'cert', c.id, { reason: req.body?.reason });
    return { ok: true };
  }));

  // ——— Панель хостинга: SSL сайта ———
  async function siteOf(conn, req) {
    const a = await ownAccount(conn, int(req.params.id, 'id'), req.gov.id);
    const s = await one('SELECT * FROM hosting_sites WHERE id = ? AND account_id = ?', [int(req.params.sid, 'сайт'), a.id], conn);
    if (!s) throw notFound('Сайт не найден');
    return { a, s };
  }
```

### POST `/api/gov/hosting/:id/sites/:sid/ssl`

Исходник: `api/src/routes/certs.js:112`.

```js
  app.post('/hosting/:id/sites/:sid/ssl', auth, async (req) => tx(async (conn) => {
    const { a, s } = await siteOf(conn, req);
    const r = await autoSsl(conn, { site: s, account: a, govUserId: req.gov.id });
    if (r.ok) await audit(conn, actor(req), 'cert.autossl', 'cert', r.cert_id, { host: s.host });
    return r;
  }));
```

### PUT `/api/gov/hosting/:id/sites/:sid/cert`

Исходник: `api/src/routes/certs.js:119`.

```js
  app.put('/hosting/:id/sites/:sid/cert', auth, async (req) => tx(async (conn) => {
    const { s } = await siteOf(conn, req);
    const certId = req.body?.cert_id ? int(req.body.cert_id, 'сертификат') : null;
    await installCert(conn, { site: s, certId, govUserId: req.gov.id });
    return { ok: true };
  }));

  // ——— УЦ организации ———
```

### POST `/api/gov/certs/org-ca`

Исходник: `api/src/routes/certs.js:127`.

```js
  app.post('/certs/org-ca', auth, async (req) => tx(async (conn) => {
    const orgId = int(req.body?.org_id, 'организация');
    await memberOrg(conn, orgId, req.gov.id, { directorOnly: true });
    const r = await createOrgCa(conn, { orgId, name: req.body?.name, identifier: req.body?.identifier });
    await audit(conn, actor(req), 'ca.create', 'pki_ca', r.ca_id);
    return r;
  }));
```

### PATCH `/api/gov/certs/org-ca/:id`

Исходник: `api/src/routes/certs.js:135`.

```js
  app.patch('/certs/org-ca/:id', auth, async (req) => tx(async (conn) => {
    const ca = await one("SELECT * FROM pki_cas WHERE id = ? AND kind = 'ca' AND org_id IS NOT NULL", [int(req.params.id, 'id')], conn);
    if (!ca) throw notFound('УЦ не найден');
    await memberOrg(conn, ca.org_id, req.gov.id, { directorOnly: true });
    await setCaPrices(conn, { caId: ca.id, prices: req.body?.prices });
    return { ok: true };
  }));
}
```


## bank.js — `api/src/routes/bank.js`

### GET `/api/bank/overview`

Исходник: `api/src/routes/bank.js:70`.

```js
  app.get('/overview', auth, async (req) => {
    const accounts = await q("SELECT * FROM accounts WHERE owner_kind = 'bank_user' AND owner_id = ? AND status <> 'closed' ORDER BY is_primary DESC, type, id", [req.bank.id]);
    const cards = await myCards(req.bank.id);
    const link = await one("SELECT status, created_at FROM passport_links WHERE bank_user_id = ? ORDER BY id DESC LIMIT 1", [req.bank.id]);
    const recent = await q(
      `SELECT t.id, t.kind, t.memo, t.created_at, e.amount, e.account_id FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id
       WHERE e.account_id IN (SELECT id FROM accounts WHERE owner_kind = 'bank_user' AND owner_id = ?) ORDER BY e.id DESC LIMIT 10`,
      [req.bank.id],
    );
    return {
      user: publicBankUser(await freshUser(req.bank.id), req.bank.roles),
      accounts: accounts.map(accountView),
      cards,
      passport_link: link,
      has_ip: !!(await ipOf(req.bank.user)),
      recent: recent.map((r) => ({ ...r, amount: Number(r.amount) })),
    };
  });
```

### POST `/api/bank/profile/passport`

Исходник: `api/src/routes/bank.js:89`.

```js
  app.post('/profile/passport', { ...auth, ...limited(5) }, async (req) => {
    const no = normalizePassport(req.body?.passport_no);
    need(no, 'Номер паспорта: BLN-XXXX-XXXX');
    await tx(async (conn) => {
      const u = await freshUser(req.bank.id, conn);
      if (u.passport_verified) throw bad('already_verified', 'Паспорт уже подтверждён');
      await requestPassportLink(conn, u, no);
    });
    return { ok: true };
  });

  // ——— Счета ———
```

### GET `/api/bank/accounts`

Исходник: `api/src/routes/bank.js:101`.

```js
  app.get('/accounts', auth, async (req) => {
    const rows = await q("SELECT * FROM accounts WHERE owner_kind = 'bank_user' AND owner_id = ? AND status <> 'closed' ORDER BY is_primary DESC, id", [req.bank.id]);
    return { accounts: rows.map(accountView) };
  });
```

### POST `/api/bank/accounts`

Исходник: `api/src/routes/bank.js:106`.

```js
  app.post('/accounts', auth, async (req) => {
    const b = req.body || {};
    const a = await tx(async (conn) => {
      const u = await one('SELECT * FROM bank_users WHERE id = ? FOR UPDATE', [req.bank.id], conn);
      const acc = await openAccount(conn, u, { type: b.type, name: b.name ? String(b.name).trim() : null, compound: !!b.compound, termMonths: b.term_months ? Number(b.term_months) : null });
      await audit(conn, actorOf(req.bank), 'bank.account_open', 'account', acc.id, { type: acc.type });
      return acc;
    });
    return { account: accountView(a) };
  });
```

### GET `/api/bank/accounts/:id`

Исходник: `api/src/routes/bank.js:117`.

```js
  app.get('/accounts/:id', auth, async (req) => {
    const a = await ownAccount(req.bank.id, int(req.params.id, 'id'));
    const before = req.query.before ? int(req.query.before, 'before') : Number.MAX_SAFE_INTEGER;
    const rows = await q(
      `SELECT e.id, e.amount, e.balance_after, t.id AS tx_id, t.kind, t.memo, t.created_at, t.card_id, t.reversed_by, t.reversal_of
       FROM ledger_entries e JOIN ledger_tx t ON t.id = e.tx_id WHERE e.account_id = ? AND e.id < ? ORDER BY e.id DESC LIMIT 50`,
      [a.id, before],
    );
    return { account: accountView(a), history: rows.map((r) => ({ ...r, amount: Number(r.amount), balance_after: Number(r.balance_after) })) };
  });
```

### POST `/api/bank/accounts/:id/primary`

Исходник: `api/src/routes/bank.js:128`.

```js
  app.post('/accounts/:id/primary', auth, async (req) => {
    await tx(async (conn) => {
      const a = await ownAccount(req.bank.id, int(req.params.id, 'id'), conn, { lock: true });
      if (a.type !== 'current' || a.status === 'closed') throw bad('invalid', 'Основным может быть только расчётный счёт');
      await q("UPDATE accounts SET is_primary = 0 WHERE owner_kind = 'bank_user' AND owner_id = ?", [req.bank.id], conn);
      await q('UPDATE accounts SET is_primary = 1 WHERE id = ?', [a.id], conn);
    });
    return { ok: true };
  });
```

### POST `/api/bank/accounts/:id/rename`

Исходник: `api/src/routes/bank.js:138`.

```js
  app.post('/accounts/:id/rename', auth, async (req) => {
    const a = await ownAccount(req.bank.id, int(req.params.id, 'id'));
    await q('UPDATE accounts SET name = ? WHERE id = ?', [str(req.body?.name, 'название', { max: 80 }), a.id]);
    return { ok: true };
  });

  // Закрытие: остаток уходит на основной расчётный счёт; досрочно закрытый вклад — со штрафом.
```

### POST `/api/bank/accounts/:id/close`

Исходник: `api/src/routes/bank.js:145`.

```js
  app.post('/accounts/:id/close', auth, async (req) => {
    const res = await tx(async (conn) => {
      const a = await ownAccount(req.bank.id, int(req.params.id, 'id'), conn, { lock: true });
      if (a.status === 'closed') throw bad('account_closed', 'Счёт уже закрыт');
      if (a.status !== 'active') throw bad('account_' + a.status, 'Счёт заморожен или арестован');
      if (a.type === 'loan') throw bad('loan_account', 'Ссудный счёт закрывается после погашения кредита');
      if (a.type === 'credit' && Number(a.balance) < 0) throw bad('has_debt', 'Сначала погасите долг по кредитной карте');
      const cards = await one("SELECT COUNT(*) AS n FROM cards WHERE account_id = ? AND status IN ('active','frozen')", [a.id], conn);
      if (cards.n > 0) throw bad('has_cards', 'Сначала закройте карты этого счёта');
      if (a.type === 'business' && (await one("SELECT id FROM shops WHERE account_id = ? AND status = 'active'", [a.id], conn))) throw bad('has_shop', 'К счёту привязан магазин');
      const target = await one("SELECT * FROM accounts WHERE owner_kind = 'bank_user' AND owner_id = ? AND type = 'current' AND status = 'active' AND id <> ? ORDER BY is_primary DESC, id LIMIT 1", [req.bank.id, a.id], conn);
      const balance = Number(a.balance);
      let penalty = 0;
      if (balance > 0) {
        if (!target) throw bad('no_target', 'Нет другого расчётного счёта для остатка');
        const s = await getSettings();
        if (a.type === 'term') penalty = percentOf(balance, Number(s.term_early_penalty_bp || 0));
        const entries = [{ account: a.id, amount: -balance }, { account: target.id, amount: balance - penalty }];
        if (penalty) entries.push({ account: await sys('TREASURY', conn), amount: penalty });
        await post(conn, { kind: 'account_close', memo: `Закрытие счёта ${a.name}${penalty ? ' (штраф за досрочное закрытие)' : ''}`, entries, actor: actorOf(req.bank) });
      }
      await q("UPDATE accounts SET status = 'closed', is_primary = 0, credit_limit = 0, closed_at = NOW(3) WHERE id = ?", [a.id], conn);
      if (a.type === 'credit') await q("UPDATE credit_lines SET status = 'closed' WHERE account_id = ?", [a.id], conn);
      await q("UPDATE autopayments SET status = 'cancelled' WHERE (from_account_id = ? OR to_account_id = ?) AND status IN ('active','paused')", [a.id, a.id], conn);
      if (a.is_primary && target) await q('UPDATE accounts SET is_primary = 1 WHERE id = ?', [target.id], conn);
      await audit(conn, actorOf(req.bank), 'bank.account_close', 'account', a.id, { penalty });
      return { penalty };
    });
    return { ok: true, ...res };
  });

  // ——— Карты ———
```

### GET `/api/bank/cards`

Исходник: `api/src/routes/bank.js:177`.

```js
  app.get('/cards', auth, async (req) => ({ cards: await myCards(req.bank.id) }));
```

### POST `/api/bank/cards`

Исходник: `api/src/routes/bank.js:179`.

```js
  app.post('/cards', auth, async (req) => {
    const b = req.body || {};
    const card = await tx(async (conn) => {
      const u = await freshUser(req.bank.id, conn);
      const acc = await ownAccount(u.id, int(b.account_id, 'счёт'), conn, { lock: true });
      const c = await issueCard(conn, { user: u, account: acc, pin: b.pin, background: BACKGROUNDS.includes(b.background) ? b.background : 'classic' });
      await audit(conn, actorOf(req.bank), 'bank.card_issue', 'card', c.id);
      return c;
    });
    return { card: cardView(card) };
  });

  async function ownCard(req, conn) {
    const c = await one('SELECT * FROM cards WHERE id = ? AND bank_user_id = ?', [int(req.params.id, 'id'), req.bank.id], conn);
    if (!c) throw notFound('Карта не найдена');
    return c;
  }
```

### POST `/api/bank/cards/:id/freeze`

Исходник: `api/src/routes/bank.js:197`.

```js
  app.post('/cards/:id/freeze', auth, async (req) => {
    const c = await ownCard(req);
    const freeze = req.body?.frozen !== false;
    if (!['active', 'frozen'].includes(c.status)) throw bad('invalid_state', 'Карта недействительна');
    await q('UPDATE cards SET status = ? WHERE id = ?', [freeze ? 'frozen' : 'active', c.id]);
    await audit(null, actorOf(req.bank), freeze ? 'bank.card_freeze' : 'bank.card_unfreeze', 'card', c.id);
    return { ok: true, status: freeze ? 'frozen' : 'active' };
  });
```

### POST `/api/bank/cards/:id/pin`

Исходник: `api/src/routes/bank.js:206`.

```js
  app.post('/cards/:id/pin', { ...auth, ...limited(5) }, async (req) => {
    const c = await ownCard(req);
    const pin = checkPinFormat(req.body?.pin);
    await q('UPDATE cards SET pin_hash = ?, pin_fail = 0, locked_until = NULL WHERE id = ?', [await hash(pin), c.id]);
    await audit(null, actorOf(req.bank), 'bank.card_pin', 'card', c.id);
    return { ok: true };
  });
```

### POST `/api/bank/cards/:id/limits`

Исходник: `api/src/routes/bank.js:214`.

```js
  app.post('/cards/:id/limits', auth, async (req) => {
    const c = await ownCard(req);
    const lim = (v, n) => (v === null || v === undefined || v === '' ? null : amountOf(v, n));
    await q('UPDATE cards SET limit_tx = ?, limit_daily = ? WHERE id = ?', [lim(req.body?.limit_tx, 'лимит на операцию'), lim(req.body?.limit_daily, 'дневной лимит'), c.id]);
    return { ok: true };
  });
```

### POST `/api/bank/cards/:id/design`

Исходник: `api/src/routes/bank.js:221`.

```js
  app.post('/cards/:id/design', auth, async (req) => {
    const c = await ownCard(req);
    if (!BACKGROUNDS.includes(req.body?.background)) throw bad('invalid', 'Неизвестный фон');
    await q('UPDATE cards SET background = ? WHERE id = ?', [req.body.background, c.id]);
    return { ok: true };
  });
```

### POST `/api/bank/cards/:id/reissue`

Исходник: `api/src/routes/bank.js:228`.

```js
  app.post('/cards/:id/reissue', auth, async (req) => {
    const card = await tx(async (conn) => {
      const c = await ownCard(req, conn);
      if (!['active', 'frozen', 'expired', 'blocked'].includes(c.status)) throw bad('invalid_state', 'Карту нельзя перевыпустить');
      if (c.type === 'gift') throw bad('invalid_state', 'Подарочная карта не перевыпускается');
      const u = await freshUser(req.bank.id, conn);
      const acc = await ownAccount(u.id, c.account_id, conn, { lock: true });
      const pin = req.body?.pin ?? null;
      const nc = await issueCard(conn, { user: u, account: acc, pin: pin ?? '000', type: c.type, background: c.background, feeKey: 'card_reissue_fee', holderName: null, holderUserId: c.holder_user_id });
      await q('UPDATE cards SET holder_name = ? WHERE id = ?', [c.holder_name, nc.id], conn);
      await q('UPDATE autopayments SET card_id = ? WHERE card_id = ?', [nc.id, c.id], conn);
      await q('UPDATE credit_lines SET card_id = ? WHERE card_id = ?', [nc.id, c.id], conn);
      if (pin === null) await q('UPDATE cards SET pin_hash = ? WHERE id = ?', [c.pin_hash, nc.id]); // PIN сохраняется
      await q('UPDATE cards SET limit_tx = ?, limit_daily = ? WHERE id = ?', [c.limit_tx, c.limit_daily, nc.id]);
      await q("UPDATE cards SET status = 'reissued' WHERE id = ?", [c.id]);
      await audit(conn, actorOf(req.bank), 'bank.card_reissue', 'card', nc.id, { old: c.id });
      return one('SELECT * FROM cards WHERE id = ?', [nc.id], conn);
    });
    return { card: cardView(card) };
  });
```

### POST `/api/bank/cards/:id/close`

Исходник: `api/src/routes/bank.js:249`.

```js
  app.post('/cards/:id/close', auth, async (req) => {
    const c = await ownCard(req);
    await q("UPDATE cards SET status = 'blocked' WHERE id = ?", [c.id]);
    // Карманные деньги на закрытую детскую карту больше не переводятся.
    await q("UPDATE autopayments SET status = 'cancelled' WHERE card_id = ? AND status IN ('active','paused')", [c.id]);
    await audit(null, actorOf(req.bank), 'bank.card_close', 'card', c.id);
    return { ok: true };
  });

  // ——— Переводы ———
```

### GET `/api/bank/recipients`

Исходник: `api/src/routes/bank.js:259`.

```js
  app.get('/recipients', auth, async (req) => {
    const term = String(req.query.q || '').trim();
    if (term.length < 2) return { recipients: [] };
    const rows = await q(
      `SELECT u.id, u.full_name, a.number FROM bank_users u JOIN accounts a ON a.owner_kind = 'bank_user' AND a.owner_id = u.id AND a.type = 'current' AND a.status = 'active' AND a.is_primary = 1
       WHERE u.status = 'active' AND u.full_name LIKE ? AND u.id <> ? ORDER BY u.full_name LIMIT 20`,
      [`%${term}%`, req.bank.id],
    );
    return { recipients: rows.map((r) => ({ id: r.id, full_name: r.full_name, account_tail: r.number.slice(-4) })) };
  });
```

### POST `/api/bank/transfers/preview`

Исходник: `api/src/routes/bank.js:270`.

```js
  app.post('/transfers/preview', auth, async (req) => {
    const b = req.body || {};
    const amount = amountOf(b.amount);
    const to = await resolveRecipient(null, b.to, req.bank.id);
    const owner = to.owner_kind === 'org'
      ? await one('SELECT name AS full_name FROM organizations WHERE id = ?', [to.owner_id])
      : to.owner_id ? await one('SELECT full_name FROM bank_users WHERE id = ?', [to.owner_id]) : null;
    const own = to.owner_kind === 'bank_user' && to.owner_id === req.bank.id;
    const fee = own ? 0 : transferFee(amount, await getSettings());
    return { recipient: { name: owner?.full_name || to.name, account_tail: to.number.slice(-4), own }, amount, fee, total: amount + fee };
  });
```

### POST `/api/bank/transfers`

Исходник: `api/src/routes/bank.js:282`.

```js
  app.post('/transfers', { ...auth, ...limited(30) }, async (req) => {
    const b = req.body || {};
    const amount = amountOf(b.amount);
    const memo = str(b.memo, 'комментарий', { optional: true, max: 140 });
    const idem = idemKey(req, `b${req.bank.id}:transfer`);
    const result = await tx(async (conn) => {
      const prev = await findIdem(conn, idem);
      if (prev) return { tx: prev.id, duplicate: true };
      const u = await freshUser(req.bank.id, conn);
      requireVerified(u);
      const from = await ownAccount(u.id, int(b.from_account, 'счёт списания'), conn);
      assertSpendable(from);
      const to = await resolveRecipient(conn, b.to, u.id);
      if (to.id === from.id) throw bad('same_account', 'Нельзя перевести на тот же счёт');
      // Антифрод: подозрительный перевод чужому получателю ждёт решения админа.
      if (!(to.owner_kind === 'bank_user' && to.owner_id === u.id)) {
        if (idem) {
          const held = await one("SELECT id FROM fraud_queue WHERE bank_user_id = ? AND status = 'pending' AND JSON_UNQUOTE(JSON_EXTRACT(data, '$.idem')) = ?", [u.id, idem], conn);
          if (held) return { held: true, fraud_id: held.id };
        }
        const reason = await transferSuspicion(conn, u.id, amount, await getSettings());
        if (reason) {
          const fee = transferFee(amount, await getSettings());
          const available = Number(from.balance) + Number(from.credit_limit || 0);
          if (available < amount + fee) throw bad('insufficient_funds', 'Недостаточно средств', { account: from.id });
          const id = await addFraud(conn, { userId: u.id, kind: 'transfer', mode: 'hold', amount, reason, data: { from: from.id, to: to.id, memo, idem } });
          await notify(conn, 'bank', u.id, { title: 'Перевод на проверке', body: `${formatMoney(amount)}: служба безопасности банка проверит операцию`, link: '#/' });
          await audit(conn, actorOf(req.bank), 'bank.transfer_held', 'fraud', id, { amount, reason });
          return { held: true, fraud_id: id, reason };
        }
      }
      const r = await moveMoney(conn, { user: u, from, to, amount, memo, idem, actor: actorOf(req.bank) });
      return { tx: r.tx, fee: r.fee };
    });
    return { ok: true, ...result };
  });

  // ——— Квитанции ВлодУслуг ———
```

### POST `/api/bank/invoices/:no/pay`

Исходник: `api/src/routes/bank.js:320`.

```js
  app.post('/invoices/:no/pay', auth, async (req) => {
    const idem = idemKey(req, `b${req.bank.id}:invoice`);
    const res = await tx(async (conn) => {
      const prev = await findIdem(conn, idem);
      if (prev) return { tx: prev.id, duplicate: true };
      const u = await freshUser(req.bank.id, conn);
      requireVerified(u);
      const from = await ownAccount(u.id, int(req.body?.account_id, 'счёт'), conn);
      assertSpendable(from);
      const r = await payInvoice(conn, String(req.params.no).toUpperCase(), { fromAccount: from.id, via: 'bank', actor: actorOf(req.bank), idem, allowArrested: true });
      return { tx: r.tx };
    });
    return { ok: true, ...res };
  });

  // ——— Оплата по QR (касса/терминал) ———
```

### GET `/api/bank/qr-pay/:token`

Исходник: `api/src/routes/bank.js:336`.

```js
  app.get('/qr-pay/:token', auth, async (req) => ({ payment: await qrInfo(req.params.token) }));
```

### POST `/api/bank/qr-pay/:token`

Исходник: `api/src/routes/bank.js:338`.

```js
  app.post('/qr-pay/:token', { ...auth, ...limited(20) }, async (req) => {
    const res = await tx(async (conn) => {
      const u = await freshUser(req.bank.id, conn);
      requireVerified(u);
      const from = await ownAccount(u.id, int(req.body?.account_id, 'счёт'), conn);
      assertSpendable(from);
      return payQr(conn, req.params.token, { user: u, account: from });
    });
    return { ok: true, ...res };
  });

  // Чек покупки в истории ВлодБанка.
```

### GET `/api/bank/receipts/:saleId`

Исходник: `api/src/routes/bank.js:350`.

```js
  app.get('/receipts/:saleId', auth, async (req) => {
    const saleId = int(req.params.saleId, 'чек');
    const mine = await one("SELECT p.id FROM sale_payments p JOIN accounts a ON a.id = p.payer_account_id WHERE p.sale_id = ? AND a.owner_id = ? AND a.owner_kind = 'bank_user' LIMIT 1", [saleId, req.bank.id]);
    if (!mine) throw notFound('Чек не найден');
    return receiptData(saleId);
  });

  // ——— Банкомат: карта + PIN → короткая сессия на 3 минуты ———
  const ATM_SECONDS = 180;
  function atmCard(req) {
    try {
      const p = jwt.verify(String(req.body?.token || ''), config.jwtSecret);
      if (p.k !== 'atm') throw new Error();
      return p.card;
    } catch {
      throw unauthorized('Сессия банкомата истекла — вставьте карту снова');
    }
  }
  async function atmState(cardId) {
    const c = await one('SELECT c.*, a.balance, a.status AS account_status FROM cards c JOIN accounts a ON a.id = c.account_id WHERE c.id = ?', [cardId]);
    return { holder: c.holder_name, last4: c.number.slice(-4), balance: Number(c.balance) };
  }
```

### POST `/api/bank/atm/session`

Исходник: `api/src/routes/bank.js:373`.

```js
  app.post('/atm/session', limited(20), async (req) => {
    const card = await authorizeCard({ number: req.body?.number, exp: req.body?.exp, pin: req.body?.pin });
    const token = jwt.sign({ k: 'atm', card: card.id }, config.jwtSecret, { expiresIn: ATM_SECONDS });
    return { token, ...(await atmState(card.id)) };
  });
```

### POST `/api/bank/atm/balance`

Исходник: `api/src/routes/bank.js:379`.

```js
  app.post('/atm/balance', async (req) => atmState(atmCard(req)));

  for (const dir of ['withdraw', 'deposit']) {
    app.post(`/atm/${dir}`, limited(20), async (req) => {
      const cardId = atmCard(req);
      const amount = amountOf(req.body?.amount);
      if (dir === 'withdraw' && amount % 500 !== 0) throw bad('atm_notes', 'Банкомат выдаёт купюры от 5 В — сумма кратна 5 В');
      const idem = idemKey(req, `atm${cardId}:${dir}`);
      await tx(async (conn) => {
        if (await findIdem(conn, idem)) return;
        const card = await one('SELECT * FROM cards WHERE id = ?', [cardId], conn);
        if (card.status !== 'active') throw bad('card_blocked', 'Карта недействительна');
        if (dir === 'withdraw') await checkCardLimits(conn, card, amount);
        const cash = await sys('CASH', conn);
        const sign = dir === 'withdraw' ? -1 : 1;
        const r = await post(conn, {
          kind: dir === 'withdraw' ? 'atm_withdraw' : 'atm_deposit',
          memo: dir === 'withdraw' ? 'Снятие наличных в банкомате' : 'Внесение наличных в банкомате',
          entries: [{ account: card.account_id, amount: sign * amount }, { account: cash, amount: -sign * amount }],
          idem,
          cardId: card.id,
          actor: { kind: 'bank', id: card.bank_user_id },
        });
        if (dir === 'withdraw' && !r.duplicate) await reviewIfLarge(conn, { accountId: card.account_id, amount, kind: 'atm_withdraw', txId: r.id, cardId: card.id });
      });
      return { ok: true, ...(await atmState(cardId)) };
    });
  }

  // ——— Операционист ———
  const teller = { preHandler: needRole('teller') };
```

### GET `/api/bank/teller/clients`

Исходник: `api/src/routes/bank.js:411`.

```js
  app.get('/teller/clients', teller, async (req) => {
    const term = String(req.query.q || '').trim();
    if (term.length < 2) return { clients: [] };
    const digits = term.replace(/\D/g, '');
    const rows = await q(
      `SELECT DISTINCT u.id, u.full_name, u.email, u.passport_no, u.passport_verified, u.status FROM bank_users u
       LEFT JOIN cards c ON c.bank_user_id = u.id
       WHERE u.full_name LIKE ? OR u.email LIKE ? OR u.passport_no LIKE ? OR (? <> '' AND c.number = ?) ORDER BY u.full_name LIMIT 30`,
      [`%${term}%`, `%${term}%`, `%${term.toUpperCase()}%`, digits.length === 12 ? digits : '', digits],
    );
    return { clients: rows };
  });
```

### GET `/api/bank/teller/clients/:id`

Исходник: `api/src/routes/bank.js:424`.

```js
  app.get('/teller/clients/:id', teller, async (req) => {
    const u = await freshUser(int(req.params.id, 'id'));
    if (!u) throw notFound();
    const accounts = await q("SELECT * FROM accounts WHERE owner_kind = 'bank_user' AND owner_id = ? AND status <> 'closed' ORDER BY id", [u.id]);
    const cards = await q("SELECT * FROM cards WHERE bank_user_id = ? AND status <> 'reissued' ORDER BY id DESC", [u.id]);
    return { client: publicBankUser(u), accounts: accounts.map(accountView), cards: cards.map((c) => cardView(c)) };
  });
```

### POST `/api/bank/teller/clients/:id/accounts`

Исходник: `api/src/routes/bank.js:432`.

```js
  app.post('/teller/clients/:id/accounts', teller, async (req) => {
    const a = await tx(async (conn) => {
      const u = await one('SELECT * FROM bank_users WHERE id = ? FOR UPDATE', [int(req.params.id, 'id')], conn);
      if (!u) throw notFound();
      const acc = await openAccount(conn, u, { type: req.body?.type || 'current' });
      await audit(conn, actorOf(req.actor), 'teller.account_open', 'account', acc.id);
      return acc;
    });
    return { account: accountView(a) };
  });
```

### POST `/api/bank/teller/clients/:id/cards`

Исходник: `api/src/routes/bank.js:443`.

```js
  app.post('/teller/clients/:id/cards', teller, async (req) => {
    const card = await tx(async (conn) => {
      const u = await freshUser(int(req.params.id, 'id'), conn);
      if (!u) throw notFound();
      const acc = await ownAccount(u.id, int(req.body?.account_id, 'счёт'), conn, { lock: true });
      const c = await issueCard(conn, { user: u, account: acc, pin: req.body?.pin, issuedBy: `${req.actor.kind}:${req.actor.id}` });
      await notify(conn, 'bank', u.id, { title: 'Выпущена карта', body: `•••• ${c.number.slice(-4)} — выдана операционистом`, link: '#/cards' });
      await audit(conn, actorOf(req.actor), 'teller.card_issue', 'card', c.id);
      return c;
    });
    return { card: cardView(card) };
  });

  // Приём и выдача наличных клиенту.
```

### POST `/api/bank/teller/cash`

Исходник: `api/src/routes/bank.js:457`.

```js
  app.post('/teller/cash', teller, async (req) => {
    const b = req.body || {};
    const amount = amountOf(b.amount);
    const dir = b.direction === 'out' ? 'out' : 'in';
    await tx(async (conn) => {
      const acc = await one("SELECT * FROM accounts WHERE id = ? AND owner_kind = 'bank_user'", [int(b.account_id, 'счёт')], conn);
      if (!acc) throw notFound('Счёт не найден');
      const sign = dir === 'out' ? -1 : 1;
      await post(conn, {
        kind: dir === 'out' ? 'teller_withdraw' : 'teller_deposit',
        memo: dir === 'out' ? 'Выдача наличных в отделении' : 'Внесение наличных в отделении',
        entries: [{ account: acc.id, amount: sign * amount }, { account: await sys('CASH', conn), amount: -sign * amount }],
        idem: idemKey(req, `teller${req.actor.id}:cash`),
        actor: actorOf(req.actor),
      });
      await audit(conn, actorOf(req.actor), `teller.cash_${dir}`, 'account', acc.id, { amount });
    });
    return { ok: true };
  });
```

### GET `/api/bank/teller/shops`

Исходник: `api/src/routes/bank.js:477`.

```js
  app.get('/teller/shops', teller, async () => {
    const rows = await q("SELECT s.id, s.name, s.inn, a.number AS account_number, u.full_name AS owner FROM shops s JOIN accounts a ON a.id = s.account_id JOIN bank_users u ON u.id = s.owner_id WHERE s.status = 'active' ORDER BY s.name");
    return { shops: rows };
  });

  // Инкассация: наличные магазина сдаются в банк и зачисляются на бизнес-счёт.
```

### POST `/api/bank/teller/collection`

Исходник: `api/src/routes/bank.js:483`.

```js
  app.post('/teller/collection', teller, async (req) => {
    const amount = amountOf(req.body?.amount);
    await tx(async (conn) => {
      const shop = await one('SELECT * FROM shops WHERE id = ?', [int(req.body?.shop_id, 'магазин')], conn);
      if (!shop) throw notFound('Магазин не найден');
      const r = await post(conn, {
        kind: 'collection',
        memo: `Инкассация: ${shop.name}`,
        entries: [{ account: await sys('CASH', conn), amount: -amount }, { account: shop.account_id, amount }],
        idem: idemKey(req, `teller${req.actor.id}:collection`),
        actor: actorOf(req.actor),
        ref: { type: 'shop', id: shop.id },
      });
      const shift = await one("SELECT id FROM shifts WHERE shop_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1", [shop.id], conn);
      if (shift) await q('UPDATE shifts SET cash_collected = cash_collected + ? WHERE id = ?', [amount, shift.id], conn);
      await q('INSERT INTO pos_log (shop_id, shift_id, action, data) VALUES (?, ?, ?, ?)', [shop.id, shift?.id || null, 'collection', JSON.stringify({ amount, tx: r.id, teller: req.actor.id })], conn);
      await notify(conn, 'bank', shop.owner_id, { title: `Инкассация ${formatMoney(amount)}`, body: shop.name });
      await audit(conn, actorOf(req.actor), 'teller.collection', 'shop', shop.id, { amount });
    });
    return { ok: true };
  });

}
```


## finance.js — `api/src/routes/finance.js`

### GET `/api/bank/credit`

Исходник: `api/src/routes/finance.js:38`.

```js
  app.get('/credit', auth, async (req) => {
    const u = await one('SELECT credit_score FROM bank_users WHERE id = ?', [req.bank.id]);
    const line = await one("SELECT * FROM credit_lines WHERE bank_user_id = ? ORDER BY status IN ('active','pending') DESC, id DESC LIMIT 1", [req.bank.id]);
    const loans = await q("SELECT * FROM loans WHERE bank_user_id = ? ORDER BY status = 'active' DESC, id DESC LIMIT 30", [req.bank.id]);
    const s = await getSettings();
    return {
      score: u.credit_score,
      level: scoreLevel(u.credit_score),
      month: await currentMonth(),
      credit_line: line ? await creditLineView(line) : null,
      loans: await Promise.all(loans.map((l) => loanView(l))),
      terms: {
        loan_rate_bp: s.loan_rate_bp, loan_max_amount: s.loan_max_amount, loan_max_months: s.loan_max_months, loan_late_fee_bp: s.loan_late_fee_bp,
        credit_rate_bp: s.credit_rate_bp, credit_grace_months: s.credit_grace_months, credit_min_payment_bp: s.credit_min_payment_bp,
        credit_late_fee: s.credit_late_fee, credit_max_limit: s.credit_max_limit,
      },
    };
  });
```

### POST `/api/bank/credit-lines`

Исходник: `api/src/routes/finance.js:57`.

```js
  app.post('/credit-lines', { ...auth, ...limited(5) }, async (req) => {
    const b = req.body || {};
    const limit = amountOf(b.limit, 'лимит');
    const pinHash = await hash(checkPinFormat(b.pin));
    const id = await tx(async (conn) => {
      const u = await user(req, conn);
      if (!(await primaryAccount(u.id, conn))) throw bad('need_current', 'Сначала откройте расчётный счёт');
      const lineId = await applyCreditLine(conn, u, { limit, pinHash, background: bg(b.background) });
      await audit(conn, actorOf(req.bank), 'bank.credit_apply', 'credit_line', lineId, { limit });
      return lineId;
    });
    return { credit_line: await creditLineView(await one('SELECT * FROM credit_lines WHERE id = ?', [id])) };
  });
```

### POST `/api/bank/credit-lines/:id/autorepay`

Исходник: `api/src/routes/finance.js:71`.

```js
  app.post('/credit-lines/:id/autorepay', auth, async (req) => {
    const r = await q('UPDATE credit_lines SET autorepay = ? WHERE id = ? AND bank_user_id = ?', [req.body?.on ? 1 : 0, int(req.params.id, 'id'), req.bank.id]);
    if (!r.affectedRows) throw notFound();
    return { ok: true };
  });
```

### POST `/api/bank/loans/preview`

Исходник: `api/src/routes/finance.js:77`.

```js
  app.post('/loans/preview', auth, async (req) => {
    const s = await getSettings();
    const amount = amountOf(req.body?.amount);
    const months = int(req.body?.months, 'срок', { min: 1, max: Number(s.loan_max_months) });
    const sched = annuitySchedule(amount, months, Number(s.loan_rate_bp));
    return { amount, months, rate_bp: s.loan_rate_bp, payment: sched.payment, total: sched.total, overpay: sched.total - amount, rows: sched.rows };
  });
```

### POST `/api/bank/loans`

Исходник: `api/src/routes/finance.js:85`.

```js
  app.post('/loans', { ...auth, ...limited(5) }, async (req) => {
    const b = req.body || {};
    const amount = amountOf(b.amount);
    const months = int(b.months, 'срок', { min: 1, max: 600 });
    const purpose = str(b.purpose, 'цель', { optional: true, max: 140 });
    const loan = await tx(async (conn) => {
      const u = await user(req, conn);
      const pay = b.pay_account_id ? await ownAccount(u.id, int(b.pay_account_id, 'счёт'), conn) : await primaryAccount(u.id, conn);
      if (!pay || !['current', 'business'].includes(pay.type)) throw bad('need_current', 'Кредит зачисляется на расчётный или бизнес-счёт');
      const l = await applyLoan(conn, u, { amount, months, purpose, payAccountId: pay.id });
      await audit(conn, actorOf(req.bank), 'bank.loan_apply', 'loan', l.id, { amount, months });
      return l;
    });
    return { loan: await loanView(loan) };
  });

  async function myLoan(req, conn) {
    const l = await one('SELECT * FROM loans WHERE id = ? AND bank_user_id = ? FOR UPDATE', [int(req.params.id, 'id'), req.bank.id], conn);
    if (!l) throw notFound('Кредит не найден');
    return l;
  }
```

### POST `/api/bank/loans/:id/cancel`

Исходник: `api/src/routes/finance.js:107`.

```js
  app.post('/loans/:id/cancel', auth, async (req) => {
    await tx(async (conn) => {
      const l = await myLoan(req, conn);
      if (l.status !== 'pending') throw bad('invalid_state', 'Заявку уже рассмотрели');
      await q("UPDATE loans SET status = 'cancelled', closed_at = NOW(3) WHERE id = ?", [l.id], conn);
    });
    return { ok: true };
  });

  for (const action of ['repay', 'pay-overdue']) {
    app.post(`/loans/:id/${action}`, { ...auth, ...limited(10) }, async (req) => {
      const paid = await tx(async (conn) => {
        const u = await user(req, conn);
        const l = await myLoan(req, conn);
        if (l.status !== 'active') throw bad('invalid_state', 'Кредит не активен');
        const from = await ownAccount(u.id, int(req.body?.account_id, 'счёт'), conn);
        assertSpendable(from);
        const sum = action === 'repay' ? await repayLoan(conn, l, from.id, actorOf(req.bank)) : await payOverdue(conn, l, from.id, actorOf(req.bank));
        await audit(conn, actorOf(req.bank), `bank.loan_${action}`, 'loan', l.id, { amount: sum });
        return sum;
      });
      return { ok: true, paid };
    });
  }

  // ——— Детская карта: счёт родителя, держатель — ребёнок, карманные каждый месяц ———
```

### POST `/api/bank/child-cards`

Исходник: `api/src/routes/finance.js:133`.

```js
  app.post('/child-cards', { ...auth, ...limited(10) }, async (req) => {
    const b = req.body || {};
    const childName = str(b.child_name, 'имя ребёнка', { min: 2, max: 60 });
    const pocket = optAmount(b.pocket_amount, 'карманные');
    const res = await tx(async (conn) => {
      const u = await user(req, conn);
      const primary = await primaryAccount(u.id, conn);
      if (!primary) throw bad('need_current', 'Сначала откройте расчётный счёт');
      let holderUserId = null;
      if (b.child_email) {
        const child = await one('SELECT id FROM bank_users WHERE email = ?', [emailOf(b.child_email)], conn);
        if (!child) throw bad('child_not_found', 'Клиент с таким email не найден во ВлодБанке');
        if (child.id === u.id) throw bad('invalid', 'Это ваш собственный email');
        holderUserId = child.id;
      }
      const acc = await createAccount(conn, { userId: u.id, type: 'child', name: `Детская карта: ${childName}` });
      const card = await issueCard(conn, { user: u, account: acc, pin: b.pin, type: 'child', background: bg(b.background), holderName: childName, holderUserId });
      await q('UPDATE cards SET limit_tx = ?, limit_daily = ? WHERE id = ?', [optAmount(b.limit_tx, 'лимит на операцию'), optAmount(b.limit_daily, 'дневной лимит'), card.id], conn);
      let started = false;
      if (pocket) {
        const month = await currentMonth(conn);
        const r = await q("INSERT INTO autopayments (bank_user_id, kind, title, from_account_id, to_account_id, amount, next_month, card_id) VALUES (?, 'pocket', ?, ?, ?, ?, ?, ?)", [u.id, `Карманные: ${childName}`, primary.id, acc.id, pocket, month, card.id], conn);
        // Автостарт: первые карманные — сразу, дальше каждый игровой месяц.
        try {
          await moveMoney(conn, { user: u, from: primary, to: acc, amount: pocket, memo: `Карманные: ${childName}`, kind: 'pocket_money', idem: `ap:${r.insertId}:${month}` });
          await q('UPDATE autopayments SET last_month = ?, next_month = ? WHERE id = ?', [month, month + 1, r.insertId], conn);
          started = true;
        } catch (err) {
          if (err.code !== 'insufficient_funds') throw err;
          await q('UPDATE autopayments SET next_month = ? WHERE id = ?', [month + 1, r.insertId], conn);
        }
      }
      if (holderUserId) await notify(conn, 'bank', holderUserId, { title: 'Вам выпущена детская карта', body: `•••• ${card.number.slice(-4)} от ${u.full_name}`, link: '#/cards' });
      await audit(conn, actorOf(req.bank), 'bank.child_card', 'card', card.id, { pocket });
      return { card: await one('SELECT c.*, a.balance, a.credit_limit FROM cards c JOIN accounts a ON a.id = c.account_id WHERE c.id = ?', [card.id], conn), started };
    });
    return { card: cardView(res.card), pocket_started: res.started };
  });
```

### POST `/api/bank/cards/:id/pocket`

Исходник: `api/src/routes/finance.js:172`.

```js
  app.post('/cards/:id/pocket', auth, async (req) => {
    const amount = optAmount(req.body?.amount, 'карманные');
    await tx(async (conn) => {
      const c = await one("SELECT * FROM cards WHERE id = ? AND bank_user_id = ? AND type = 'child'", [int(req.params.id, 'id'), req.bank.id], conn);
      if (!c) throw notFound('Детская карта не найдена');
      const ap = await one("SELECT * FROM autopayments WHERE card_id = ? AND kind = 'pocket' AND status IN ('active','paused') ORDER BY id DESC LIMIT 1", [c.id], conn);
      if (!amount) {
        if (ap) await q("UPDATE autopayments SET status = 'cancelled' WHERE id = ?", [ap.id], conn);
        return;
      }
      if (ap) {
        await q("UPDATE autopayments SET amount = ?, status = 'active', fails = 0 WHERE id = ?", [amount, ap.id], conn);
      } else {
        const primary = await primaryAccount(req.bank.id, conn);
        if (!primary) throw bad('need_current', 'Нет расчётного счёта');
        await q("INSERT INTO autopayments (bank_user_id, kind, title, from_account_id, to_account_id, amount, next_month, card_id) VALUES (?, 'pocket', ?, ?, ?, ?, ?, ?)", [req.bank.id, `Карманные: ${c.holder_name}`, primary.id, c.account_id, amount, (await currentMonth(conn)) + 1, c.id], conn);
      }
    });
    return { ok: true };
  });

  // ——— Подарочные карты ———
```

### POST `/api/bank/gift-cards`

Исходник: `api/src/routes/finance.js:194`.

```js
  app.post('/gift-cards', { ...auth, ...limited(10) }, async (req) => {
    const b = req.body || {};
    const amount = amountOf(b.amount);
    const card = await tx(async (conn) => {
      const u = await user(req, conn);
      const from = await ownAccount(u.id, int(b.from_account, 'счёт оплаты'), conn);
      assertSpendable(from);
      const s = await getSettings();
      const fee = Number(s.gift_card_fee || 0);
      const acc = await createAccount(conn, { userId: u.id, type: 'gift', name: 'Подарочная карта' });
      const entries = [{ account: from.id, amount: -(amount + fee) }, { account: acc.id, amount }];
      if (fee) entries.push({ account: await sys('TREASURY', conn), amount: fee });
      await post(conn, { kind: 'gift_purchase', memo: `Подарочная карта на ${formatMoney(amount)}`, entries, actor: actorOf(req.bank) });
      const c = await issueCard(conn, { user: u, account: acc, pin: b.pin, type: 'gift', background: bg(b.background || 'gold'), chargeFee: false, holderName: str(b.holder, 'кому', { optional: true, max: 60 }) || 'GIFT' });
      await audit(conn, actorOf(req.bank), 'bank.gift_card', 'card', c.id, { amount });
      return one('SELECT c.*, a.balance, a.credit_limit FROM cards c JOIN accounts a ON a.id = c.account_id WHERE c.id = ?', [c.id], conn);
    });
    return { card: cardView(card) };
  });

  // Зачислить подарочную карту на свой счёт: номер + PIN, весь остаток переходит на счёт.
```

### POST `/api/bank/gift-cards/redeem`

Исходник: `api/src/routes/finance.js:215`.

```js
  app.post('/gift-cards/redeem', { ...auth, ...limited(10) }, async (req) => {
    const b = req.body || {};
    const card = await authorizeCard({ number: b.number, pin: b.pin });
    if (card.type !== 'gift') throw bad('not_gift', 'Это не подарочная карта');
    const amount = await tx(async (conn) => {
      const u = await user(req, conn);
      const to = await ownAccount(u.id, int(b.account_id, 'счёт зачисления'), conn);
      if (!['current', 'savings', 'business'].includes(to.type) || to.status === 'closed') throw bad('invalid_account', 'Выберите расчётный или накопительный счёт');
      const gift = await one('SELECT * FROM accounts WHERE id = ? FOR UPDATE', [card.account_id], conn);
      const sum = Number(gift.balance);
      if (sum <= 0) throw bad('gift_empty', 'На подарочной карте нет денег');
      await post(conn, { kind: 'gift_redeem', memo: 'Зачисление подарочной карты', entries: [{ account: gift.id, amount: -sum }, { account: to.id, amount: sum }], actor: actorOf(req.bank), cardId: card.id, force: true });
      await q("UPDATE cards SET status = 'blocked' WHERE id = ?", [card.id], conn);
      await q("UPDATE accounts SET status = 'closed', closed_at = NOW(3) WHERE id = ?", [gift.id], conn);
      if (gift.owner_id !== u.id) await notify(conn, 'bank', gift.owner_id, { title: 'Подарочная карта активирована', body: `•••• ${card.number.slice(-4)}: ${formatMoney(sum)} получил(а) ${u.full_name}` });
      await audit(conn, actorOf(req.bank), 'bank.gift_redeem', 'card', card.id, { amount: sum });
      return sum;
    });
    return { ok: true, amount };
  });

  // ——— Автоплатежи и подписки ———
```

### GET `/api/bank/autopayments`

Исходник: `api/src/routes/finance.js:237`.

```js
  app.get('/autopayments', auth, async (req) => {
    const rows = await q(
      `SELECT ap.*, a.name AS to_name, a.number AS to_number FROM autopayments ap JOIN accounts a ON a.id = ap.to_account_id
       WHERE ap.bank_user_id = ? AND ap.status <> 'cancelled' ORDER BY ap.status = 'active' DESC, ap.id DESC`,
      [req.bank.id],
    );
    // Для чужих счетов показываем имя владельца, а не название счёта.
    for (const r of rows) {
      const acc = await one('SELECT owner_id FROM accounts WHERE id = ?', [r.to_account_id]);
      if (acc && acc.owner_id !== req.bank.id) r.to_name = (await one('SELECT full_name FROM bank_users WHERE id = ?', [acc.owner_id]))?.full_name || r.to_name;
    }
    return { autopayments: rows.map(autopayView), month: await currentMonth() };
  });
```

### POST `/api/bank/autopayments`

Исходник: `api/src/routes/finance.js:251`.

```js
  app.post('/autopayments', { ...auth, ...limited(20) }, async (req) => {
    const b = req.body || {};
    const amount = amountOf(b.amount);
    const title = str(b.title, 'название', { min: 2, max: 80 });
    const remaining = b.remaining ? int(b.remaining, 'число платежей', { min: 1, max: 600 }) : null;
    const kind = b.kind === 'subscription' ? 'subscription' : 'transfer';
    const id = await tx(async (conn) => {
      const u = await user(req, conn);
      const from = await ownAccount(u.id, int(b.from_account, 'счёт списания'), conn);
      assertSpendable(from);
      const to = await resolveTarget(conn, b.to, u.id);
      if (to.id === from.id) throw bad('same_account', 'Нельзя перевести на тот же счёт');
      const month = await currentMonth(conn);
      const r = await q('INSERT INTO autopayments (bank_user_id, kind, title, from_account_id, to_account_id, amount, remaining, next_month) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [u.id, kind, title, from.id, to.id, amount, remaining, b.start_now ? month : month + 1], conn);
      await audit(conn, actorOf(req.bank), 'bank.autopay_create', 'autopayment', r.insertId, { amount });
      return r.insertId;
    });
    if (b.start_now) await runAutopayment({ id }, await currentMonth());
    const row = await one('SELECT ap.*, a.name AS to_name, a.number AS to_number FROM autopayments ap JOIN accounts a ON a.id = ap.to_account_id WHERE ap.id = ?', [id]);
    return { autopayment: autopayView(row) };
  });
```

### POST `/api/bank/autopayments/:id/status`

Исходник: `api/src/routes/finance.js:273`.

```js
  app.post('/autopayments/:id/status', auth, async (req) => {
    const status = String(req.body?.status || '');
    if (!['active', 'paused', 'cancelled'].includes(status)) throw bad('invalid', 'Статус: active, paused, cancelled');
    const ap = await one('SELECT * FROM autopayments WHERE id = ? AND bank_user_id = ?', [int(req.params.id, 'id'), req.bank.id]);
    if (!ap) throw notFound();
    if (['finished', 'cancelled'].includes(ap.status)) throw bad('invalid_state', 'Автоплатёж завершён');
    const month = await currentMonth();
    await q('UPDATE autopayments SET status = ?, fails = 0, next_month = GREATEST(next_month, ?) WHERE id = ?', [status, status === 'active' ? month + 1 : ap.next_month, ap.id]);
    return { ok: true };
  });

  // ——— Кешбэк ———
```

### GET `/api/bank/cashback`

Исходник: `api/src/routes/finance.js:285`.

```js
  app.get('/cashback', auth, async (req) => {
    const month = await currentMonth();
    const s = await getSettings();
    const categories = await q('SELECT id, name, rate_bp FROM cashback_categories WHERE active = 1 ORDER BY sort, id');
    const chosen = await q('SELECT category_id FROM cashback_choices WHERE bank_user_id = ? AND month = ?', [req.bank.id, month]);
    const acc = await one('SELECT COALESCE(SUM(amount),0) AS s FROM cashback_accruals WHERE bank_user_id = ? AND month = ?', [req.bank.id, month]);
    const history = await q("SELECT t.id, t.created_at, e.amount FROM ledger_tx t JOIN ledger_entries e ON e.tx_id = t.id AND e.amount > 0 JOIN accounts a ON a.id = e.account_id AND a.owner_kind = 'bank_user' AND a.owner_id = ? WHERE t.kind = 'cashback' ORDER BY t.id DESC LIMIT 12", [req.bank.id]);
    return {
      month,
      max: Number(s.cashback_max_categories),
      cap: Number(s.cashback_cap),
      categories,
      chosen: chosen.map((c) => c.category_id),
      accrued: Math.max(0, Number(acc.s)),
      history: history.map((h) => ({ ...h, amount: Number(h.amount) })),
    };
  });
```

### POST `/api/bank/cashback`

Исходник: `api/src/routes/finance.js:303`.

```js
  app.post('/cashback', auth, async (req) => {
    const ids = [...new Set((Array.isArray(req.body?.category_ids) ? req.body.category_ids : []).map(Number).filter(Number.isSafeInteger))];
    const s = await getSettings();
    if (!ids.length) throw bad('invalid', 'Выберите хотя бы одну категорию');
    if (ids.length > Number(s.cashback_max_categories)) throw bad('too_many', `Можно выбрать не больше ${s.cashback_max_categories} категорий`);
    await tx(async (conn) => {
      await user(req, conn);
      const month = await currentMonth(conn);
      const prev = await one('SELECT COUNT(*) AS n FROM cashback_choices WHERE bank_user_id = ? AND month = ?', [req.bank.id, month], conn);
      if (Number(prev.n) > 0) throw bad('already_chosen', 'Категории на этот месяц уже выбраны — новый выбор в следующем игровом месяце');
      const ok = await q(`SELECT id FROM cashback_categories WHERE active = 1 AND id IN (${ids.map(() => '?').join(',')})`, ids, conn);
      if (ok.length !== ids.length) throw bad('invalid', 'Неизвестная категория');
      for (const id of ids) await q('INSERT INTO cashback_choices (bank_user_id, month, category_id) VALUES (?, ?, ?)', [req.bank.id, month, id], conn);
    });
    return { ok: true };
  });
}

/** Получатель автоплатежа: номер карты или счёта. */
async function resolveTarget(conn, to, userId) {
  const value = String(to?.value ?? '').trim();
  let acc = null;
  if (to?.type === 'card') {
    const c = await one('SELECT * FROM cards WHERE number = ?', [value.replace(/\D/g, '')], conn);
    if (c && ['active', 'frozen'].includes(c.status) && c.type !== 'gift') acc = await one('SELECT * FROM accounts WHERE id = ?', [c.account_id], conn);
  } else if (to?.type === 'account' || to?.type === 'own') {
    acc = await one("SELECT * FROM accounts WHERE (number = ? OR id = ?) AND owner_kind = 'bank_user'", [value.toUpperCase(), to.type === 'own' ? Number(value) || 0 : 0], conn);
    if (acc && to.type === 'own' && acc.owner_id !== userId) throw forbidden();
  }
  if (!acc || acc.status === 'closed' || ['loan', 'gift'].includes(acc.type)) throw bad('recipient_not_found', 'Счёт получателя не найден');
  return acc;
}
```


## bank-gov.js — `api/src/routes/bank-gov.js`

### GET `/api/bank/state-charges`

Исходник: `api/src/routes/bank-gov.js:22`.

```js
  app.get('/state-charges', auth, async (req) => {
    const c = await citizenOfBankUser(null, req.bank.user);
    if (!c) return { invoices: [], sanctions: [] };
    const rows = await q("SELECT * FROM invoices WHERE citizen_id = ? AND status = 'unpaid' ORDER BY due_month IS NULL, due_month, id", [c.id]);
    const paid = await q("SELECT * FROM invoices WHERE citizen_id = ? AND status = 'paid' ORDER BY paid_at DESC LIMIT 20", [c.id]);
    return { invoices: rows.map(publicInvoice), paid: paid.map(publicInvoice), sanctions: (await activeSanctions(null, c.id)).map((s) => ({ kind: s.kind, reason: s.reason, created_at: s.created_at })) };
  });

  // Сделки с имуществом, где клиент — покупатель.
```

### GET `/api/bank/property`

Исходник: `api/src/routes/bank-gov.js:31`.

```js
  app.get('/property', auth, async (req) => {
    const c = await citizenOfBankUser(null, req.bank.user);
    if (!c) return { deals: [], properties: [] };
    const deals = await q(`SELECT d.*, p.title, p.kind, p.reg_number, s.full_name AS seller_name, b.full_name AS buyer_name FROM property_deals d JOIN properties p ON p.id = d.property_id
      LEFT JOIN citizens s ON s.id = d.seller_citizen_id JOIN citizens b ON b.id = d.buyer_citizen_id WHERE d.buyer_citizen_id = ? ORDER BY d.status IN ('pending','loan') DESC, d.id DESC LIMIT 50`, [c.id]);
    const props = await q('SELECT * FROM properties WHERE owner_citizen_id = ?', [c.id]);
    const s = await getSettings();
    return {
      deals: deals.map(dealView),
      properties: props.map(propertyView),
      terms: { mortgage_rate_bp: s.mortgage_rate_bp, auto_loan_rate_bp: s.auto_loan_rate_bp, max_months: s.mortgage_max_months, min_down_bp: s.mortgage_min_down_bp },
    };
  });

  async function myDeal(req, conn) {
    const c = await citizen(req, conn);
    const d = await one('SELECT * FROM property_deals WHERE id = ? AND buyer_citizen_id = ? FOR UPDATE', [int(req.params.id, 'id'), c.id], conn);
    if (!d) throw notFound('Сделка не найдена');
    return d;
  }
```

### POST `/api/bank/property-deals/:id/pay`

Исходник: `api/src/routes/bank-gov.js:52`.

```js
  app.post('/property-deals/:id/pay', auth, async (req) => {
    const idem = idemKey(req, `b${req.bank.id}:deal`);
    const r = await tx(async (conn) => {
      requireVerified(req.bank.user);
      const deal = await myDeal(req, conn);
      const acc = await ownAccount(req.bank.id, int(req.body?.account_id, 'счёт'), conn);
      assertSpendable(acc);
      return payDeal(conn, { deal, fromAccountId: acc.id, actor: actorOf(req.bank), idem });
    });
    return { ok: true, ...r };
  });

  // Ипотека (недвижимость) или автокредит: заявка уходит админу, деньги — продавцу при выдаче.
```

### POST `/api/bank/property-deals/:id/loan`

Исходник: `api/src/routes/bank-gov.js:65`.

```js
  app.post('/property-deals/:id/loan', auth, async (req) => {
    const b = req.body || {};
    const s = await getSettings();
    const loan = await tx(async (conn) => {
      requireVerified(req.bank.user);
      const deal = await myDeal(req, conn);
      if (deal.status !== 'pending') throw bad('invalid_state', 'По сделке уже оформляется кредит или она закрыта');
      const p = await checkDealOpen(conn, deal);
      const price = Number(deal.price);
      const down = b.down_payment ? amountOf(b.down_payment, 'первый взнос') : 0;
      if (down < percentOf(price, Number(s.mortgage_min_down_bp))) throw bad('down_low', `Первый взнос — не меньше ${formatMoney(percentOf(price, Number(s.mortgage_min_down_bp)))}`);
      if (down >= price) throw bad('down_high', 'Взнос покрывает всю цену — оплатите сделку целиком');
      const months = int(b.months, 'срок', { min: 1, max: Number(s.mortgage_max_months) });
      const acc = await ownAccount(req.bank.id, int(b.account_id, 'счёт'), conn);
      assertSpendable(acc);
      if (Number(acc.balance) < down) throw bad('insufficient_funds', 'На счёте не хватает денег на первый взнос');
      const kind = p.kind === 'car' ? 'auto' : 'mortgage';
      const r = await q('INSERT INTO loans (bank_user_id, kind, purpose, amount_requested, months_requested, pay_account_id, deal_id, property_id, down_payment) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        req.bank.id, kind, `${p.title} (${p.reg_number})`, price - down, months, acc.id, deal.id, p.id, down,
      ], conn);
      await q("UPDATE property_deals SET status = 'loan', loan_id = ? WHERE id = ?", [r.insertId, deal.id], conn);
      afterCommit(conn, () => notifyAdmins('queue', { queue: 'loan', id: r.insertId }));
      return { id: r.insertId, kind, amount: price - down };
    });
    return { loan };
  });
}
```


## pos.js — `api/src/routes/pos.js`

### GET `/api/pos/cashback-categories`

Исходник: `api/src/routes/pos.js:90`.

```js
  app.get('/cashback-categories', async () => ({ categories: await q('SELECT id, name, rate_bp FROM cashback_categories WHERE active = 1 ORDER BY sort, id') }));
```

### GET `/api/pos/my-shops`

Исходник: `api/src/routes/pos.js:92`.

```js
  app.get('/my-shops', bankAuth, async (req) => {
    const rows = await q("SELECT s.*, st.role AS my_role, st.pin_hash IS NOT NULL AS has_pin FROM shops s JOIN shop_staff st ON st.shop_id = s.id AND st.bank_user_id = ? AND st.active = 1 WHERE s.status = 'active' ORDER BY s.name", [req.bank.id]);
    const ip = await ipOf(req.bank.user);
    const business = await q("SELECT id, number, name, balance FROM accounts WHERE owner_kind = 'bank_user' AND owner_id = ? AND type = 'business' AND status = 'active'", [req.bank.id]);
    return {
      shops: rows.map((s) => ({ ...shopView(s), my_role: s.my_role, has_pin: !!s.has_pin })),
      can_create: { has_ip: !!ip, business_accounts: business.map((a) => ({ ...a, balance: Number(a.balance) })) },
    };
  });
```

### POST `/api/pos/shops`

Исходник: `api/src/routes/pos.js:102`.

```js
  app.post('/shops', bankAuth, async (req) => {
    const b = req.body || {};
    const shop = await tx(async (conn) => {
      const u = await one('SELECT * FROM bank_users WHERE id = ?', [req.bank.id], conn);
      requireVerified(u);
      const ip = await ipOf(u, conn);
      if (!ip) throw bad('no_ip', 'Нужно свидетельство ИП во ВлодУслугах');
      const acc = await ownAccount(u.id, int(b.account_id, 'бизнес-счёт'), conn);
      if (acc.type !== 'business' || acc.status !== 'active') throw bad('need_business', 'Нужен действующий бизнес-счёт ВлодБанка');
      const inn = await innOf(u, conn);
      const pin = String(b.pin || '');
      need(/^\d{4}$/.test(pin), 'PIN кассира — 4 цифры');
      const type = b.type === 'cafe' ? 'cafe' : 'shop';
      const res = await q('INSERT INTO shops (owner_id, name, type, color, account_id, inn, ip_number, address, cashback_category_id, kitchen_enabled) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
        u.id, str(b.name, 'название', { min: 2, max: 80 }), type, COLOR_RE.test(b.color) ? b.color : '#0f766e', acc.id, inn?.number || '', ip.number, str(b.address, 'адрес', { optional: true, max: 160 }),
        await cashbackCategory(conn, b.cashback_category_id, type), type === 'cafe' ? 1 : 0,
      ], conn);
      await q("INSERT INTO shop_staff (shop_id, bank_user_id, role, pin_hash) VALUES (?, ?, 'owner', ?)", [res.insertId, u.id, await hash(pin)], conn);
      await audit(conn, actorOf(req.bank), 'pos.shop_create', 'shop', res.insertId);
      return one('SELECT * FROM shops WHERE id = ?', [res.insertId], conn);
    });
    return { shop: shopView(shop) };
  });
```

### POST `/api/pos/login`

Исходник: `api/src/routes/pos.js:126`.

```js
  app.post('/login', { ...bankAuth, ...limited(10) }, async (req, reply) => {
    const shopId = int(req.body?.shop_id, 'магазин');
    const staff = await one("SELECT st.* FROM shop_staff st JOIN shops s ON s.id = st.shop_id AND s.status = 'active' WHERE st.shop_id = ? AND st.bank_user_id = ? AND st.active = 1", [shopId, req.bank.id]);
    if (!staff) throw forbidden('Вы не работаете в этом магазине');
    if (!staff.pin_hash) throw bad('no_pin', 'Владелец ещё не выдал вам PIN кассира');
    if (!(await verifyHash(String(req.body?.pin || ''), staff.pin_hash))) throw bad('pin_wrong', 'Неверный PIN кассира');
    await issue(reply, 'pos', { uid: req.bank.id, staff: staff.id });
    await posLog(null, { shopId, staffId: staff.id, action: 'login' });
    return { ok: true };
  });
```

### POST `/api/pos/logout`

Исходник: `api/src/routes/pos.js:137`.

```js
  app.post('/logout', async (req, reply) => {
    clear(reply, 'pos');
    return { ok: true };
  });
```

### GET `/api/pos/session`

Исходник: `api/src/routes/pos.js:142`.

```js
  app.get('/session', pos, async (req) => {
    const shop = await shopOf(req);
    const shift = await openShift(null, req.pos.staff.id);
    const held = await one("SELECT COUNT(*) AS n FROM sales WHERE shop_id = ? AND status = 'held' AND table_id IS NULL", [shop.id]);
    const s = await getSettings();
    return {
      shop: shopView(shop),
      staff: { id: req.pos.staff.id, role: req.pos.staff.role, name: req.pos.bank.user.full_name },
      shift: shift ? { id: shift.id, number: shift.number, opened_at: shift.opened_at, opening_float: Number(shift.opening_float) } : null,
      held: held.n,
      vat_bp: s.vat_bp,
      verify_base: `${await webUrl()}/services/#/verify/receipt/`,
    };
  });

  // ——— Настройки магазина (владелец) ———
```

### PATCH `/api/pos/shop`

Исходник: `api/src/routes/pos.js:158`.

```js
  app.patch('/shop', owner, async (req) => {
    const b = req.body || {};
    const shop = await shopOf(req);
    const logo = image(b.logo, 'логотип');
    const cat = b.cashback_category_id !== undefined ? await cashbackCategory(null, b.cashback_category_id, shop.type) : shop.cashback_category_id;
    await q('UPDATE shops SET cashback_category_id = ? WHERE id = ?', [cat, shop.id]);
    if (b.loyalty_bp !== undefined) await q('UPDATE shops SET loyalty_bp = ? WHERE id = ?', [int(Number(b.loyalty_bp) || 0, 'баллы', { min: 0, max: 5000 }), shop.id]);
    if (b.loyalty_max_bp !== undefined) await q('UPDATE shops SET loyalty_max_bp = ? WHERE id = ?', [int(Number(b.loyalty_max_bp) || 0, 'доля баллов', { min: 0, max: 10000 }), shop.id]);
    if (b.kitchen_enabled !== undefined) await q('UPDATE shops SET kitchen_enabled = ? WHERE id = ?', [b.kitchen_enabled ? 1 : 0, shop.id]);
    await q('UPDATE shops SET name = ?, type = ?, color = ?, address = ?, receipt_footer = ?, logo = ? WHERE id = ?', [
      b.name !== undefined ? str(b.name, 'название', { min: 2, max: 80 }) : shop.name,
      b.type === 'cafe' || b.type === 'shop' ? b.type : shop.type,
      COLOR_RE.test(b.color || '') ? b.color : shop.color,
      b.address !== undefined ? str(b.address, 'адрес', { optional: true, max: 160 }) : shop.address,
      b.receipt_footer !== undefined ? str(b.receipt_footer, 'подпись в чеке', { optional: true, max: 200 }) : shop.receipt_footer,
      logo === undefined ? shop.logo : logo,
      shop.id,
    ]);
    return { shop: shopView(await shopOf(req)) };
  });

  // ——— Персонал (владелец) ———
```

### GET `/api/pos/staff`

Исходник: `api/src/routes/pos.js:180`.

```js
  app.get('/staff', owner, async (req) => {
    const rows = await q('SELECT st.id, st.role, st.salary, st.active, st.pin_hash IS NOT NULL AS has_pin, u.full_name, u.email FROM shop_staff st JOIN bank_users u ON u.id = st.bank_user_id WHERE st.shop_id = ? ORDER BY st.role DESC, u.full_name', [req.pos.shopId]);
    return { staff: rows.map((r) => ({ ...r, salary: Number(r.salary), active: !!r.active, has_pin: !!r.has_pin })) };
  });
```

### POST `/api/pos/staff`

Исходник: `api/src/routes/pos.js:185`.

```js
  app.post('/staff', owner, async (req) => {
    const b = req.body || {};
    const email = String(b.email || '').trim().toLowerCase();
    const u = await one("SELECT id, full_name FROM bank_users WHERE email = ? AND status = 'active'", [email]);
    if (!u) throw notFound('Клиент ВлодБанка с таким email не найден');
    const pin = String(b.pin || '');
    need(/^\d{4}$/.test(pin), 'PIN кассира — 4 цифры');
    const salary = b.salary ? amountOf(b.salary, 'зарплата') : 0;
    await q("INSERT INTO shop_staff (shop_id, bank_user_id, role, pin_hash, salary) VALUES (?, ?, 'cashier', ?, ?) ON DUPLICATE KEY UPDATE active = 1, pin_hash = VALUES(pin_hash), salary = VALUES(salary)", [req.pos.shopId, u.id, await hash(pin), salary]);
    await audit(null, staffActor(req), 'pos.staff_add', 'shop', req.pos.shopId, { user: u.id });
    return { ok: true };
  });
```

### PATCH `/api/pos/staff/:id`

Исходник: `api/src/routes/pos.js:198`.

```js
  app.patch('/staff/:id', owner, async (req) => {
    const st = await one('SELECT * FROM shop_staff WHERE id = ? AND shop_id = ?', [int(req.params.id, 'id'), req.pos.shopId]);
    if (!st) throw notFound();
    const b = req.body || {};
    if (b.pin !== undefined) {
      need(/^\d{4}$/.test(String(b.pin)), 'PIN кассира — 4 цифры');
      await q('UPDATE shop_staff SET pin_hash = ? WHERE id = ?', [await hash(String(b.pin)), st.id]);
    }
    if (b.salary !== undefined) await q('UPDATE shop_staff SET salary = ? WHERE id = ?', [b.salary ? amountOf(b.salary, 'зарплата') : 0, st.id]);
    if (b.active !== undefined && st.role !== 'owner') await q('UPDATE shop_staff SET active = ? WHERE id = ?', [b.active ? 1 : 0, st.id]);
    return { ok: true };
  });

  // ——— Товары ———
```

### GET `/api/pos/products`

Исходник: `api/src/routes/pos.js:212`.

```js
  app.get('/products', pos, async (req) => {
    const isOwner = req.pos.staff.role === 'owner';
    const all = req.query.all === '1' && isOwner;
    const deleted = req.query.deleted === '1' && isOwner;
    const rows = await q(
      `SELECT * FROM products WHERE shop_id = ? AND deleted_at ${deleted ? 'IS NOT NULL' : 'IS NULL'}${all || deleted ? '' : ' AND active = 1'} ORDER BY category, sort, name, id`,
      [req.pos.shopId],
    );
    const extras = await productExtras(req.pos.shopId, { all });
    return { products: rows.map((p) => productView(p, extras)) };
  });

  function productFields(b, prev = {}) {
    const val = (k, f) => (b[k] !== undefined ? f(b[k]) : prev[k]);
    return {
      name: val('name', (v) => str(v, 'название', { max: 120 })),
      category: val('category', (v) => (v ? String(v).trim().slice(0, 60) : '')) ?? '',
      barcode: val('barcode', (v) => (v ? String(v).replace(/\s/g, '').slice(0, 64) : null)) ?? null,
      price: val('price', (v) => amountOf(v, 'цена')),
      cost: val('cost', (v) => (v === '' || v === null ? 0 : int(v, 'закупочная цена', { min: 0, max: 1e12 }))) ?? 0,
      b2b_price: val('b2b_price', (v) => (v === '' || v === null ? null : amountOf(v, 'оптовая цена'))) ?? null,
      to_kitchen: val('to_kitchen', (v) => (v ? 1 : 0)) ?? 0,
      unit: val('unit', (v) => (v === 'kg' ? 'kg' : 'pcs')) ?? 'pcs',
      age_limit: val('age_limit', (v) => int(Number(v) || 0, 'возраст', { min: 0, max: 21 })) ?? 0,
      photo: b.photo !== undefined ? image(b.photo, 'фото') : prev.photo ?? null,
      track_stock: val('track_stock', (v) => (v ? 1 : 0)) ?? 1,
      sort: val('sort', (v) => int(Number(v) || 0, 'порядок')) ?? 0,
      active: val('active', (v) => (v ? 1 : 0)) ?? 1,
      // Интернет-магазин (Н9): товар виден в каталоге сайта; цифровой товар выдаётся покупателю сразу после оплаты.
      online: val('online', (v) => (v ? 1 : 0)) ?? 0,
      digital_content: val('digital_content', (v) => (v ? String(v).slice(0, 5000) : null)) ?? null,
    };
  }
```

### POST `/api/pos/products`

Исходник: `api/src/routes/pos.js:246`.

```js
  app.post('/products', owner, async (req) => {
    const f = productFields(req.body || {});
    need(f.name && f.price, 'Укажите название и цену');
    const res = await q('INSERT INTO products (shop_id, name, category, barcode, price, cost, b2b_price, unit, age_limit, photo, track_stock, to_kitchen, sort, active, online, digital_content) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [req.pos.shopId, f.name, f.category, f.barcode, f.price, f.cost, f.b2b_price, f.unit, f.age_limit, f.photo, f.track_stock, f.to_kitchen, f.sort, f.active, f.online, f.digital_content]);
    const initial = Number(req.body?.stock_milli || 0);
    if (initial > 0) {
      await q('UPDATE products SET stock_milli = ? WHERE id = ?', [Math.round(initial), res.insertId]);
      await q("INSERT INTO stock_moves (product_id, qty_milli, reason, staff_id) VALUES (?, ?, 'manual', ?)", [res.insertId, Math.round(initial), req.pos.staff.id]);
    }
    return { product: await oneProduct(res.insertId) };
  });
```

### PATCH `/api/pos/products/:id`

Исходник: `api/src/routes/pos.js:258`.

```js
  app.patch('/products/:id', owner, async (req) => {
    const p = await one('SELECT * FROM products WHERE id = ? AND shop_id = ? AND deleted_at IS NULL', [int(req.params.id, 'id'), req.pos.shopId]);
    if (!p) throw notFound('Товар не найден');
    const f = productFields(req.body || {}, { ...p, price: Number(p.price), cost: Number(p.cost), b2b_price: p.b2b_price === null ? null : Number(p.b2b_price) });
    await q('UPDATE products SET name = ?, category = ?, barcode = ?, price = ?, cost = ?, b2b_price = ?, unit = ?, age_limit = ?, photo = ?, track_stock = ?, to_kitchen = ?, sort = ?, active = ?, online = ?, digital_content = ? WHERE id = ?', [f.name, f.category, f.barcode, f.price, f.cost, f.b2b_price, f.unit, f.age_limit, f.photo, f.track_stock, f.to_kitchen, f.sort, f.active, f.online, f.digital_content, p.id]);
    return { product: await oneProduct(p.id) };
  });

  // Удаление товара владельцем: мягкое, чтобы история чеков, возвратов и склада осталась цела.
```

### DELETE `/api/pos/products/:id`

Исходник: `api/src/routes/pos.js:267`.

```js
  app.delete('/products/:id', owner, async (req) => {
    const id = int(req.params.id, 'id');
    await tx(async (conn) => {
      const p = await one('SELECT * FROM products WHERE id = ? AND shop_id = ? AND deleted_at IS NULL FOR UPDATE', [id, req.pos.shopId], conn);
      if (!p) throw notFound('Товар не найден');
      await q('UPDATE products SET active = 0, deleted_at = NOW(3) WHERE id = ?', [p.id], conn);
      const shift = await openShift(conn, req.pos.staff.id);
      await posLog(conn, { shopId: req.pos.shopId, staffId: req.pos.staff.id, shiftId: shift?.id, action: 'product_delete', data: { name: p.name, barcode: p.barcode } });
      await audit(conn, staffActor(req), 'pos.product_delete', 'product', p.id, { name: p.name });
      afterCommit(conn, () => publish(`shop:${req.pos.shopId}`, { type: 'product_deleted', id: p.id }));
    });
    return { ok: true };
  });

  // Отмена удаления: вариант, добавка, остаток и оптовая цена сохраняются за товаром.
```

### POST `/api/pos/products/:id/restore`

Исходник: `api/src/routes/pos.js:282`.

```js
  app.post('/products/:id/restore', owner, async (req) => {
    const id = int(req.params.id, 'id');
    await tx(async (conn) => {
      const p = await one('SELECT * FROM products WHERE id = ? AND shop_id = ? AND deleted_at IS NOT NULL FOR UPDATE', [id, req.pos.shopId], conn);
      if (!p) throw notFound('Удалённый товар не найден');
      await q('UPDATE products SET active = 1, deleted_at = NULL WHERE id = ?', [p.id], conn);
      const shift = await openShift(conn, req.pos.staff.id);
      await posLog(conn, { shopId: req.pos.shopId, staffId: req.pos.staff.id, shiftId: shift?.id, action: 'product_restore', data: { name: p.name } });
      await audit(conn, staffActor(req), 'pos.product_restore', 'product', p.id, { name: p.name });
      afterCommit(conn, () => publish(`shop:${req.pos.shopId}`, { type: 'product_restored', id: p.id }));
    });
    return { product: await oneProduct(id) };
  });

  // Ручная корректировка остатка (полный склад и закупки — этап 7).
```

### POST `/api/pos/stock`

Исходник: `api/src/routes/pos.js:297`.

```js
  app.post('/stock', owner, async (req) => {
    const p = await one('SELECT * FROM products WHERE id = ? AND shop_id = ? AND deleted_at IS NULL', [int(req.body?.product_id, 'товар'), req.pos.shopId]);
    if (!p) throw notFound('Товар не найден');
    const delta = int(Math.round(Number(req.body?.qty_milli)), 'количество', { min: -1e9, max: 1e9 });
    await tx(async (conn) => {
      await q('UPDATE products SET stock_milli = stock_milli + ? WHERE id = ?', [delta, p.id], conn);
      await q("INSERT INTO stock_moves (product_id, qty_milli, reason, staff_id) VALUES (?, ?, ?, ?)", [p.id, delta, delta < 0 ? 'writeoff' : 'manual', req.pos.staff.id], conn);
    });
    return { product: await oneProduct(p.id) };
  });

  // ——— Смены ———
```

### POST `/api/pos/shifts/open`

Исходник: `api/src/routes/pos.js:309`.

```js
  app.post('/shifts/open', pos, async (req) => {
    const float = req.body?.opening_float ? int(req.body.opening_float, 'разменный фонд', { min: 0, max: 1e10 }) : 0;
    const shift = await tx(async (conn) => {
      if (await openShift(conn, req.pos.staff.id)) throw bad('shift_open', 'Смена уже открыта');
      const shop = await one('SELECT next_shift_no FROM shops WHERE id = ? FOR UPDATE', [req.pos.shopId], conn);
      await q('UPDATE shops SET next_shift_no = next_shift_no + 1 WHERE id = ?', [req.pos.shopId], conn);
      const r = await q('INSERT INTO shifts (shop_id, staff_id, number, opening_float) VALUES (?, ?, ?, ?)', [req.pos.shopId, req.pos.staff.id, shop.next_shift_no, float], conn);
      await posLog(conn, { shopId: req.pos.shopId, staffId: req.pos.staff.id, shiftId: r.insertId, action: 'shift_open', data: { opening_float: float } });
      return one('SELECT * FROM shifts WHERE id = ?', [r.insertId], conn);
    });
    return { shift: { id: shift.id, number: shift.number, opened_at: shift.opened_at, opening_float: Number(shift.opening_float) } };
  });
```

### GET `/api/pos/shifts/x`

Исходник: `api/src/routes/pos.js:322`.

```js
  app.get('/shifts/x', pos, async (req) => {
    const shift = await openShift(null, req.pos.staff.id);
    if (!shift) throw bad('no_shift', 'Смена не открыта');
    return { report: await shiftReport(null, shift), shop: shopView(await shopOf(req)), cashier: req.pos.bank.user.full_name };
  });
```

### POST `/api/pos/shifts/z`

Исходник: `api/src/routes/pos.js:328`.

```js
  app.post('/shifts/z', pos, async (req) => {
    const closing = req.body?.closing_cash !== undefined && req.body?.closing_cash !== null && req.body?.closing_cash !== '' ? int(req.body.closing_cash, 'наличные в ящике', { min: 0, max: 1e12 }) : null;
    const out = await tx(async (conn) => {
      const shift = await one("SELECT * FROM shifts WHERE staff_id = ? AND status = 'open' ORDER BY id DESC LIMIT 1 FOR UPDATE", [req.pos.staff.id], conn);
      if (!shift) throw bad('no_shift', 'Смена не открыта');
      const open = await one("SELECT COUNT(*) AS n FROM sales WHERE shift_id = ? AND status = 'open' AND paid > 0", [shift.id], conn);
      if (open.n) throw bad('open_sales', 'Есть недоплаченные чеки — завершите или отмените их');
      for (const o of await q("SELECT * FROM sales WHERE shift_id = ? AND status = 'open'", [shift.id], conn)) {
        if (o.source === 'tab' && o.table_id) await revertTab(conn, o);
        else {
          await restorePoints(conn, o);
          await q("UPDATE sales SET status = 'cancelled' WHERE id = ?", [o.id], conn);
        }
      }
      const report = await shiftReport(conn, shift);
      const shop = await one('SELECT * FROM shops WHERE id = ?', [shift.shop_id], conn);
      report.vat_settlement = await settleCashVat(conn, { shop, shift, amount: report.cash_vat });
      report.closing_cash = closing;
      report.difference = closing === null ? null : closing - report.expected_cash;
      report.shift.closed_at = new Date();
      report.shift.status = 'closed';
      await q("UPDATE shifts SET status = 'closed', closed_at = NOW(3), closing_cash = ?, z_report = ? WHERE id = ?", [closing, JSON.stringify(report), shift.id], conn);
      await posLog(conn, { shopId: shift.shop_id, staffId: req.pos.staff.id, shiftId: shift.id, action: 'shift_close', data: { closing_cash: closing } });
      return report;
    });
    return { report: out, shop: shopView(await shopOf(req)), cashier: req.pos.bank.user.full_name };
  });
```

### GET `/api/pos/shifts`

Исходник: `api/src/routes/pos.js:356`.

```js
  app.get('/shifts', owner, async (req) => {
    const rows = await q('SELECT sh.id, sh.number, sh.status, sh.opened_at, sh.closed_at, sh.opening_float, sh.closing_cash, sh.z_report, u.full_name FROM shifts sh JOIN shop_staff st ON st.id = sh.staff_id JOIN bank_users u ON u.id = st.bank_user_id WHERE sh.shop_id = ? ORDER BY sh.id DESC LIMIT 50', [req.pos.shopId]);
    return { shifts: rows.map((r) => ({ ...r, opening_float: Number(r.opening_float), z_report: typeof r.z_report === 'string' ? JSON.parse(r.z_report) : r.z_report })) };
  });

  // ——— Продажа ———
```

### POST `/api/pos/sales`

Исходник: `api/src/routes/pos.js:362`.

```js
  app.post('/sales', pos, async (req) => {
    const b = req.body || {};
    const sale = await tx(async (conn) => createSale(conn, {
      shopId: req.pos.shopId,
      staff: req.pos.staff,
      lines: b.items,
      discount: b.discount ? int(b.discount, 'скидка', { min: 0, max: 1e12 }) : 0,
      tipPct: Number(b.tip_pct || 0),
      promoCode: b.promo_code || null,
      loyalty: b.loyalty || null,
      redeemPoints: b.redeem_points ? int(b.redeem_points, 'баллы', { min: 0, max: 1e12 }) : 0,
      source: b.source === 'kiosk' ? 'kiosk' : 'pos',
    }));
    return { sale: saleView(sale) };
  });

  // Расчёт чека до создания продажи: акции, промокод, баллы и НДС считает сервер.
```

### POST `/api/pos/preview`

Исходник: `api/src/routes/pos.js:379`.

```js
  app.post('/preview', pos, async (req) => {
    const b = req.body || {};
    return previewSale(null, {
      shopId: req.pos.shopId,
      lines: b.items,
      discount: b.discount ? int(b.discount, 'скидка', { min: 0, max: 1e12 }) : 0,
      promoCode: b.promo_code || null,
      loyalty: b.loyalty || null,
      redeemPoints: b.redeem_points ? int(b.redeem_points, 'баллы', { min: 0, max: 1e12 }) : 0,
    });
  });
```

### GET `/api/pos/sales/:id`

Исходник: `api/src/routes/pos.js:391`.

```js
  app.get('/sales/:id', pos, async (req) => {
    const sale = await loadSale(null, int(req.params.id, 'id'));
    if (sale.shop_id !== req.pos.shopId) throw notFound('Чек не найден');
    return { sale: saleView(sale) };
  });
```

### GET `/api/pos/sales/by-number/:no`

Исходник: `api/src/routes/pos.js:397`.

```js
  app.get('/sales/by-number/:no', pos, async (req) => {
    const r = await one('SELECT id FROM sales WHERE shop_id = ? AND number = ?', [req.pos.shopId, int(req.params.no, 'номер')]);
    if (!r) throw notFound('Чек не найден');
    const sale = await loadSale(null, r.id);
    const refunds = await q('SELECT id, amount, method, items, reason, created_at FROM refunds WHERE sale_id = ? ORDER BY id', [r.id]);
    return { sale: saleView(sale), refunds };
  });
```

### POST `/api/pos/sales/:id/tip`

Исходник: `api/src/routes/pos.js:405`.

```js
  app.post('/sales/:id/tip', pos, async (req) => {
    const pct = Number(req.body?.tip_pct || 0);
    if (![0, 5, 10, 15].includes(pct)) throw bad('invalid_tip', 'Чаевые: 0, 5, 10 или 15%');
    const sale = await tx(async (conn) => {
      const s = await loadSale(conn, int(req.params.id, 'id'), { lock: true });
      if (s.shop_id !== req.pos.shopId) throw notFound();
      if (s.status !== 'open' || Number(s.paid) > 0) throw bad('sale_locked', 'Чаевые выбираются до оплаты');
      await q('UPDATE sales SET tip_pct = ?, tip = ? WHERE id = ?', [pct, Math.round((Number(s.total) * pct) / 100), s.id], conn);
      return loadSale(conn, s.id);
    });
    return { sale: saleView(sale) };
  });

  // Проверка возраста по QR паспорта БФ (или номеру паспорта).
```

### POST `/api/pos/sales/:id/age`

Исходник: `api/src/routes/pos.js:419`.

```js
  app.post('/sales/:id/age', pos, async (req) => {
    const code = String(req.body?.code || '').trim();
    const passportNo = String(req.body?.passport_no || '').trim().toUpperCase();
    const p = code
      ? await one('SELECT p.*, c.birth_date, c.full_name FROM passports p JOIN citizens c ON c.id = p.citizen_id WHERE p.verify_code = ?', [code.split('/').pop()])
      : await one('SELECT p.*, c.birth_date, c.full_name FROM passports p JOIN citizens c ON c.id = p.citizen_id WHERE p.number = ?', [passportNo]);
    if (!p || p.status !== 'active') throw bad('passport_invalid', 'Паспорт недействителен');
    const sale = await tx(async (conn) => {
      const s = await loadSale(conn, int(req.params.id, 'id'), { lock: true });
      if (s.shop_id !== req.pos.shopId) throw notFound();
      const limit = Math.max(0, ...s.items.map((i) => i.age_limit));
      const age = ageFrom(p.birth_date);
      if (age === null || age < limit) {
        await posLog(conn, { shopId: s.shop_id, staffId: req.pos.staff.id, shiftId: s.shift_id, action: 'age_denied', saleId: s.id, data: { passport: p.number, age } });
        throw bad('age_denied', `Покупателю ${age} — продажа ${limit}+ запрещена`);
      }
      await q('UPDATE sales SET age_checked = ? WHERE id = ?', [p.number, s.id], conn);
      await posLog(conn, { shopId: s.shop_id, staffId: req.pos.staff.id, shiftId: s.shift_id, action: 'age_ok', saleId: s.id, data: { passport: p.number, age } });
      return loadSale(conn, s.id);
    });
    return { sale: saleView(sale), customer: { full_name: p.full_name, age: ageFrom(p.birth_date) } };
  });

  async function payFlow(req, saleId, fn) {
    return tx(async (conn) => {
      const sale = await loadSale(conn, saleId, { lock: true });
      if (sale.shop_id !== req.pos.shopId) throw notFound('Чек не найден');
      const shop = await one('SELECT * FROM shops WHERE id = ?', [sale.shop_id], conn);
      const res = await fn(conn, sale, shop);
      return { ...res, sale: saleView(await loadSale(conn, sale.id)) };
    });
  }
```

### POST `/api/pos/sales/:id/pay`

Исходник: `api/src/routes/pos.js:452`.

```js
  app.post('/sales/:id/pay', { ...pos, ...limited(60) }, async (req) => {
    const b = req.body || {};
    const saleId = int(req.params.id, 'id');
    const method = b.method;
    const amount = amountOf(b.amount);
    const idem = idemKey(req, `pos${req.pos.staff.id}:pay`);
    if (method !== 'card') {
      const src = await one('SELECT source FROM sales WHERE id = ?', [saleId]);
      if (src?.source === 'kiosk') throw bad('kiosk_method', 'В киоске — только оплата картой или по QR');
    }
    if (method === 'debt') {
      const customer = b.customer ? await loyaltyCustomer(null, b.customer) : null;
      return payFlow(req, saleId, (conn, sale, shop) => payByDebt(conn, { sale, shop, amount, customerName: b.customer_name, customer, note: str(b.note, 'комментарий', { optional: true, max: 200 }) }));
    }
    if (method === 'cash') {
      const res = await payFlow(req, saleId, (conn, sale, shop) => payByCash(conn, { sale, shop, amount, cashGiven: b.cash_given !== undefined ? int(b.cash_given, 'получено') : null, idem }));
      return res;
    }
    if (method === 'card') {
      // Отказ показывает сама касса (экран «Отказано»); терминал сообщает об отказе через WebSocket.
      const card = await authorizeCard({ number: b.number, exp: b.exp, pin: b.pin });
      return payFlow(req, saleId, (conn, sale, shop) => payByCard(conn, { sale, shop, card, amount, actor: staffActor(req), idem }));
    }
    throw bad('invalid_method', 'Способ оплаты: наличные, карта или QR');
  });
```

### POST `/api/pos/sales/:id/qr`

Исходник: `api/src/routes/pos.js:478`.

```js
  app.post('/sales/:id/qr', pos, async (req) => {
    const saleId = int(req.params.id, 'id');
    const terminal = req.body?.terminal_code ? String(req.body.terminal_code) : null;
    const out = await tx(async (conn) => {
      const sale = await loadSale(conn, saleId, { lock: true });
      if (sale.shop_id !== req.pos.shopId) throw notFound();
      if (sale.status !== 'open') throw bad('sale_closed', 'Чек закрыт');
      const ageLimit = Math.max(0, ...sale.items.map((i) => i.age_limit));
      if (ageLimit > 0 && !sale.age_checked) throw bad('age_check', `Проверьте паспорт покупателя (${ageLimit}+)`);
      const due = Number(sale.total) + Number(sale.tip) - Number(sale.paid);
      const amount = req.body?.amount ? Math.min(amountOf(req.body.amount), due) : due;
      const shop = await one('SELECT * FROM shops WHERE id = ?', [sale.shop_id], conn);
      return createQr(conn, { sale, shop, amount });
    });
    if (terminal) {
      terminalBySale.set(saleId, terminal);
      publish(`terminal:${terminal}`, { type: 'qr', sale_id: saleId, ...out });
    }
    return out;
  });
```

### POST `/api/pos/sales/:id/cancel`

Исходник: `api/src/routes/pos.js:499`.

```js
  app.post('/sales/:id/cancel', pos, async (req) => {
    await tx(async (conn) => {
      const sale = await loadSale(conn, int(req.params.id, 'id'), { lock: true });
      if (sale.shop_id !== req.pos.shopId) throw notFound();
      if (!['open', 'held'].includes(sale.status)) throw bad('sale_closed', 'Чек уже закрыт');
      if (Number(sale.paid) > 0) throw bad('has_payments', 'По чеку уже есть оплата — оформите возврат после закрытия');
      // Отмена оплаты счёта стола возвращает счёт на стол.
      if (sale.status === 'open' && sale.source === 'tab' && sale.table_id) return revertTab(conn, sale);
      await restorePoints(conn, sale);
      await q("UPDATE sales SET status = 'cancelled' WHERE id = ?", [sale.id], conn);
      await posLog(conn, { shopId: sale.shop_id, staffId: req.pos.staff.id, shiftId: sale.shift_id, action: 'sale_cancel', saleId: sale.id, data: { total: Number(sale.total) } });
    });
    return { ok: true };
  });

  // Отложенные чеки.
```

### GET `/api/pos/held`

Исходник: `api/src/routes/pos.js:515`.

```js
  app.get('/held', pos, async (req) => {
    const rows = await q("SELECT s.id, s.hold_label, s.total, s.created_at, u.full_name FROM sales s JOIN shop_staff st ON st.id = s.staff_id JOIN bank_users u ON u.id = st.bank_user_id WHERE s.shop_id = ? AND s.status = 'held' AND s.table_id IS NULL ORDER BY s.id DESC", [req.pos.shopId]);
    return { held: rows.map((r) => ({ ...r, total: Number(r.total) })) };
  });
```

### POST `/api/pos/held`

Исходник: `api/src/routes/pos.js:520`.

```js
  app.post('/held', pos, async (req) => {
    const label = str(req.body?.label, 'метка', { optional: true, max: 60 }) || `Чек ${new Date().toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })}`;
    const sale = await tx(async (conn) => createSale(conn, { shopId: req.pos.shopId, staff: req.pos.staff, lines: req.body?.items, heldLabel: label }));
    return { sale: saleView(sale) };
  });
```

### POST `/api/pos/held/:id/resume`

Исходник: `api/src/routes/pos.js:526`.

```js
  app.post('/held/:id/resume', pos, async (req) => {
    const out = await tx(async (conn) => {
      const sale = await loadSale(conn, int(req.params.id, 'id'), { lock: true });
      if (sale.shop_id !== req.pos.shopId || sale.status !== 'held') throw notFound('Отложенный чек не найден');
      if (sale.table_id) throw bad('is_tab', 'Это счёт стола — откройте его в разделе «Столы»');
      await q("UPDATE sales SET status = 'cancelled' WHERE id = ?", [sale.id], conn);
      return sale.items.map((i) => ({ product_id: i.product_id, qty_milli: Number(i.qty_milli), variant_id: i.variant_id || undefined, modifier_ids: (json(i.modifiers, []) || []).map((m) => m.id) }));
    });
    return { items: out };
  });

  // ——— Возвраты ———
```

### POST `/api/pos/refunds`

Исходник: `api/src/routes/pos.js:538`.

```js
  app.post('/refunds', pos, async (req) => {
    const b = req.body || {};
    const idem = idemKey(req, `pos${req.pos.staff.id}:refund`);
    const out = await tx(async (conn) => {
      const sale = await loadSale(conn, int(b.sale_id, 'чек'), { lock: true });
      if (sale.shop_id !== req.pos.shopId) throw notFound('Чек не найден');
      const shop = await one('SELECT * FROM shops WHERE id = ?', [sale.shop_id], conn);
      const r = await refundSale(conn, { sale, shop, staff: req.pos.staff, lines: b.items, all: !!b.all, reason: str(b.reason, 'причина', { optional: true, max: 160 }), idem });
      afterCommit(conn, () => publish(`shop:${shop.id}`, { type: 'refund', sale_id: sale.id }));
      return { refund: r, sale: saleView(await loadSale(conn, sale.id)) };
    });
    return out;
  });

  // ——— Чек ———
```

### GET `/api/pos/sales/:id/receipt`

Исходник: `api/src/routes/pos.js:553`.

```js
  app.get('/sales/:id/receipt', pos, async (req) => {
    const r = await receiptData(int(req.params.id, 'id'));
    if (r.shop.id !== req.pos.shopId) throw notFound();
    return r;
  });
```

### POST `/api/pos/sales/:id/email`

Исходник: `api/src/routes/pos.js:559`.

```js
  app.post('/sales/:id/email', { ...pos, ...limited(10) }, async (req) => {
    const r = await receiptData(int(req.params.id, 'id'));
    if (r.shop.id !== req.pos.shopId) throw notFound();
    const to = String(req.body?.email || '').trim().toLowerCase();
    need(/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(to), 'Неверный email');
    await q('UPDATE sales SET receipt_email = ? WHERE id = ?', [to, r.sale.id]);
    await sendMail({ to, brand: r.shop.name, subject: `Чек №${r.sale.number} — ${r.shop.name}`, text: receiptText(r) });
    return { ok: true };
  });

  // ——— Журнал кассира и денежный ящик ———
```

### POST `/api/pos/log`

Исходник: `api/src/routes/pos.js:570`.

```js
  app.post('/log', pos, async (req) => {
    const action = String(req.body?.action || '');
    if (!['remove_item', 'drawer_open', 'qty_change', 'clear_cart'].includes(action)) throw bad('invalid', 'Неизвестное действие');
    const shift = await openShift(null, req.pos.staff.id);
    await posLog(null, { shopId: req.pos.shopId, staffId: req.pos.staff.id, shiftId: shift?.id, action, data: req.body?.data || null });
    return { ok: true };
  });
```

### GET `/api/pos/log`

Исходник: `api/src/routes/pos.js:578`.

```js
  app.get('/log', owner, async (req) => {
    const rows = await q('SELECT l.*, u.full_name FROM pos_log l LEFT JOIN shop_staff st ON st.id = l.staff_id LEFT JOIN bank_users u ON u.id = st.bank_user_id WHERE l.shop_id = ? ORDER BY l.id DESC LIMIT 200', [req.pos.shopId]);
    return { log: rows.map((r) => ({ ...r, data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data })) };
  });

  // ——— Квитанции ВлодУслуг наличными ———
```

### GET `/api/pos/invoices/:no`

Исходник: `api/src/routes/pos.js:584`.

```js
  app.get('/invoices/:no', pos, async (req) => {
    const inv = await one('SELECT * FROM invoices WHERE number = ?', [String(req.params.no).toUpperCase()]);
    if (!inv) throw notFound('Квитанция не найдена');
    return { invoice: publicInvoice(inv) };
  });
```

### POST `/api/pos/invoices/:no/pay-cash`

Исходник: `api/src/routes/pos.js:590`.

```js
  app.post('/invoices/:no/pay-cash', pos, async (req) => {
    const idem = idemKey(req, `pos${req.pos.staff.id}:invoice`);
    const res = await tx(async (conn) => {
      const shift = await openShift(conn, req.pos.staff.id);
      if (!shift) throw bad('no_shift', 'Откройте смену');
      const shop = await one('SELECT * FROM shops WHERE id = ?', [req.pos.shopId], conn);
      const r = await payInvoice(conn, String(req.params.no).toUpperCase(), { fromAccount: shop.account_id, via: 'cash', actor: staffActor(req), idem });
      await posLog(conn, { shopId: shop.id, staffId: req.pos.staff.id, shiftId: shift.id, action: 'invoice_cash', data: { number: r.invoice.number, amount: Number(r.invoice.amount) } });
      return { invoice: publicInvoice(r.invoice) };
    });
    return { ok: true, ...res };
  });

  // ——— Терминал покупателя ———
```

### POST `/api/pos/terminals`

Исходник: `api/src/routes/pos.js:604`.

```js
  app.post('/terminals', pos, async (req) => {
    await q("UPDATE terminals SET status = 'closed' WHERE staff_id = ? AND status <> 'closed'", [req.pos.staff.id]);
    const code = await withUnique(async () => {
      const c = newTerminalCode();
      await q('INSERT INTO terminals (shop_id, staff_id, code) VALUES (?, ?, ?)', [req.pos.shopId, req.pos.staff.id, c]);
      return c;
    });
    return { code };
  });
```

### POST `/api/pos/terminals/:code/close`

Исходник: `api/src/routes/pos.js:614`.

```js
  app.post('/terminals/:code/close', pos, async (req) => {
    await q("UPDATE terminals SET status = 'closed' WHERE code = ? AND shop_id = ?", [req.params.code, req.pos.shopId]);
    publish(`terminal:${req.params.code}`, { type: 'closed' });
    return { ok: true };
  });

  async function ownTerminal(req) {
    const t = await one("SELECT * FROM terminals WHERE code = ? AND shop_id = ? AND status <> 'closed'", [String(req.params.code), req.pos.shopId]);
    if (!t) throw notFound('Терминал не подключён');
    return t;
  }

  // Показ корзины на терминале (без записи в базу).
```

### POST `/api/pos/terminals/:code/display`

Исходник: `api/src/routes/pos.js:627`.

```js
  app.post('/terminals/:code/display', pos, async (req) => {
    await ownTerminal(req);
    const shop = await shopOf(req);
    const lines = Array.isArray(req.body?.lines) ? req.body.lines.slice(0, 100) : [];
    publish(`terminal:${req.params.code}`, { type: 'cart', shop: { name: shop.name, color: shop.color, logo: shop.logo }, lines, total: Number(req.body?.total || 0), message: req.body?.message || null });
    return { ok: true };
  });

  // Запрос оплаты картой на терминале.
```

### POST `/api/pos/terminals/:code/request`

Исходник: `api/src/routes/pos.js:636`.

```js
  app.post('/terminals/:code/request', pos, async (req) => {
    const t = await ownTerminal(req);
    const sale = await loadSale(null, int(req.body?.sale_id, 'чек'));
    if (sale.shop_id !== req.pos.shopId || sale.status !== 'open') throw bad('sale_closed', 'Чек закрыт');
    const due = Number(sale.total) + Number(sale.tip) - Number(sale.paid);
    const amount = req.body?.amount ? Math.min(amountOf(req.body.amount), due) : due;
    const shop = await shopOf(req);
    const pending = { sale_id: sale.id, amount, request_id: Date.now().toString(36) };
    await q('UPDATE terminals SET pending = ? WHERE id = ?', [JSON.stringify(pending), t.id]);
    terminalBySale.set(sale.id, t.code);
    publish(`terminal:${t.code}`, { type: 'pay_request', ...pending, shop: { name: shop.name, color: shop.color, logo: shop.logo }, items: saleView(sale).items.map((i) => ({ name: i.name, qty_milli: i.qty_milli, unit: i.unit, total: i.total })), total: Number(sale.total), tip: Number(sale.tip) });
    return { ok: true, ...pending };
  });
```

### POST `/api/pos/terminals/:code/cancel`

Исходник: `api/src/routes/pos.js:650`.

```js
  app.post('/terminals/:code/cancel', pos, async (req) => {
    const t = await ownTerminal(req);
    await q('UPDATE terminals SET pending = NULL WHERE id = ?', [t.id]);
    publish(`terminal:${t.code}`, { type: 'cancelled' });
    return { ok: true };
  });

  // Терминал (без входа): покупатель вводит карту и PIN.
```

### GET `/api/pos/terminal/:code`

Исходник: `api/src/routes/pos.js:658`.

```js
  app.get('/terminal/:code', limited(60), async (req) => {
    const t = await one("SELECT t.*, s.name, s.color, s.logo FROM terminals t JOIN shops s ON s.id = t.shop_id WHERE t.code = ? AND t.status <> 'closed'", [String(req.params.code)]);
    if (!t) throw notFound('Код не найден — проверьте код на экране кассы');
    return { shop: { name: t.name, color: t.color, logo: t.logo }, pending: typeof t.pending === 'string' ? JSON.parse(t.pending) : t.pending };
  });
```

### POST `/api/pos/terminal/:code/pay`

Исходник: `api/src/routes/pos.js:664`.

```js
  app.post('/terminal/:code/pay', limited(20), async (req) => {
    const code = String(req.params.code);
    const t = await one("SELECT * FROM terminals WHERE code = ? AND status <> 'closed'", [code]);
    if (!t) throw notFound('Терминал отключён');
    const pending = typeof t.pending === 'string' ? JSON.parse(t.pending) : t.pending;
    if (!pending || pending.request_id !== req.body?.request_id) throw bad('no_request', 'Нет запроса на оплату');
    let result;
    try {
      const card = await authorizeCard({ number: req.body?.number, exp: req.body?.exp, pin: req.body?.pin });
      result = await tx(async (conn) => {
        const sale = await loadSale(conn, pending.sale_id, { lock: true });
        const shop = await one('SELECT * FROM shops WHERE id = ?', [sale.shop_id], conn);
        const staff = await one('SELECT bank_user_id FROM shop_staff WHERE id = ?', [t.staff_id], conn);
        const r = await payByCard(conn, { sale, shop, card, amount: pending.amount, actor: { kind: 'bank', id: staff.bank_user_id }, idem: `terminal:${t.id}:${pending.request_id}` });
        await q('UPDATE terminals SET pending = NULL, last_seen_at = NOW(3) WHERE id = ?', [t.id], conn);
        return { ...r, sale: saleView(await loadSale(conn, sale.id)) };
      });
    } catch (err) {
      const retry = err.code === 'pin_wrong';
      publish(`terminal:${code}`, { type: 'pay_result', ok: false, code: err.code, message: err.message, retry });
      if (!retry) publish(`shop:${t.shop_id}`, { type: 'pay_declined', sale_id: pending.sale_id, reason: err.message });
      throw err;
    }
    publish(`terminal:${code}`, { type: 'pay_result', ok: true, sale_id: pending.sale_id, amount: pending.amount, finished: result.finished, method: 'card' });
    return { ok: true, finished: result.finished };
  });
}
```


## pos-ext.js — `api/src/routes/pos-ext.js`

### POST `/api/pos/products/:id/variants`

Исходник: `api/src/routes/pos-ext.js:60`.

```js
  app.post('/products/:id/variants', owner, async (req) => {
    const p = await ownProduct(req, req.params.id);
    const delta = int(Number(req.body?.price_delta) || 0, 'надбавка', { min: -Number(p.price) + 1, max: 1e10 });
    const r = await q('INSERT INTO product_variants (product_id, name, price_delta, sort) VALUES (?, ?, ?, ?)', [p.id, str(req.body?.name, 'название', { max: 60 }), delta, Number(req.body?.sort) || 0]);
    return { id: r.insertId };
  });
```

### POST `/api/pos/products/:id/modifiers`

Исходник: `api/src/routes/pos-ext.js:67`.

```js
  app.post('/products/:id/modifiers', owner, async (req) => {
    const p = await ownProduct(req, req.params.id);
    const price = int(Number(req.body?.price) || 0, 'цена добавки', { min: 0, max: 1e10 });
    const r = await q('INSERT INTO modifiers (product_id, name, price, sort) VALUES (?, ?, ?, ?)', [p.id, str(req.body?.name, 'название', { max: 60 }), price, Number(req.body?.sort) || 0]);
    return { id: r.insertId };
  });

  for (const [path, table] of [['variants', 'product_variants'], ['modifiers', 'modifiers']]) {
    app.patch(`/${path}/:id`, owner, async (req) => {
      const row = await one(`SELECT x.* FROM ${table} x JOIN products p ON p.id = x.product_id AND p.shop_id = ? AND p.deleted_at IS NULL WHERE x.id = ?`, [req.pos.shopId, int(req.params.id, 'id')]);
      if (!row) throw notFound();
      const b = req.body || {};
      const priceCol = table === 'modifiers' ? 'price' : 'price_delta';
      await q(`UPDATE ${table} SET name = ?, ${priceCol} = ?, active = ? WHERE id = ?`, [
        b.name !== undefined ? str(b.name, 'название', { max: 60 }) : row.name,
        b[priceCol] !== undefined ? int(Number(b[priceCol]) || 0, 'цена', { min: table === 'modifiers' ? 0 : -1e10, max: 1e10 }) : row[priceCol],
        b.active !== undefined ? (b.active ? 1 : 0) : row.active,
        row.id,
      ]);
      return { ok: true };
    });
  }

  // ——— Склад: оптовая база, рынок магазинов, закупки и заказы ———
```

### GET `/api/pos/wholesale`

Исходник: `api/src/routes/pos-ext.js:91`.

```js
  app.get('/wholesale', pos, async () => {
    const { index } = await priceIndex();
    const rows = await q('SELECT * FROM wholesale_items WHERE active = 1 ORDER BY category, sort, name');
    return { index, items: rows.map((w) => wholesaleView(w, index)) };
  });
```

### POST `/api/pos/purchases/wholesale`

Исходник: `api/src/routes/pos-ext.js:97`.

```js
  app.post('/purchases/wholesale', owner, async (req) => {
    const idem = idemKey(req, `pos${req.pos.staff.id}:wholesale`);
    const r = await tx(async (conn) => buyWholesale(conn, { shop: await shopOf(req, conn), staff: req.pos.staff, lines: req.body?.items, idem }));
    return { purchase: r };
  });

  // Оптовые предложения других магазинов (товары с ценой «оптом»).
```

### GET `/api/pos/market`

Исходник: `api/src/routes/pos-ext.js:104`.

```js
  app.get('/market', pos, async (req) => {
    const term = `%${String(req.query.q || '').trim()}%`;
    const rows = await q(`SELECT p.id, p.name, p.category, p.unit, p.b2b_price, p.stock_milli, p.track_stock, p.photo, s.id AS shop_id, s.name AS shop_name, s.color
      FROM products p JOIN shops s ON s.id = p.shop_id AND s.status = 'active'
      WHERE p.shop_id <> ? AND p.active = 1 AND p.deleted_at IS NULL AND p.b2b_price IS NOT NULL AND (p.name LIKE ? OR s.name LIKE ?) ORDER BY s.name, p.name LIMIT 300`, [req.pos.shopId, term, term]);
    return { offers: rows.map((r) => ({ ...r, b2b_price: Number(r.b2b_price), stock_milli: r.track_stock ? Number(r.stock_milli) : null, track_stock: !!r.track_stock })) };
  });
```

### POST `/api/pos/purchases/shop`

Исходник: `api/src/routes/pos-ext.js:112`.

```js
  app.post('/purchases/shop', owner, async (req) => {
    const b = req.body || {};
    const r = await tx(async (conn) => orderFromShop(conn, { shop: await shopOf(req, conn), staff: req.pos.staff, sellerShopId: int(b.seller_shop_id, 'магазин'), lines: b.items, note: str(b.note, 'комментарий', { optional: true, max: 200 }) }));
    return { purchase: r };
  });
```

### GET `/api/pos/purchases`

Исходник: `api/src/routes/pos-ext.js:118`.

```js
  app.get('/purchases', owner, async (req) => {
    const mine = await q('SELECT p.*, s.name AS seller_name FROM purchases p LEFT JOIN shops s ON s.id = p.seller_shop_id WHERE p.shop_id = ? ORDER BY p.id DESC LIMIT 100', [req.pos.shopId]);
    const incoming = await q('SELECT p.*, s.name AS shop_name FROM purchases p JOIN shops s ON s.id = p.shop_id WHERE p.seller_shop_id = ? ORDER BY p.status = \'pending\' DESC, p.id DESC LIMIT 100', [req.pos.shopId]);
    return { purchases: mine.map(purchaseView), orders: incoming.map(purchaseView) };
  });
```

### POST `/api/pos/orders/:id/:decision`

Исходник: `api/src/routes/pos-ext.js:124`.

```js
  app.post('/orders/:id/:decision', owner, async (req) => {
    const decision = req.params.decision;
    need(['accept', 'reject'].includes(decision), 'accept | reject');
    await tx(async (conn) => {
      const seller = await shopOf(req, conn);
      if (decision === 'accept') return acceptOrder(conn, { purchaseId: int(req.params.id, 'id'), seller, staff: req.pos.staff });
      const pur = await one('SELECT * FROM purchases WHERE id = ? AND seller_shop_id = ? FOR UPDATE', [int(req.params.id, 'id'), seller.id], conn);
      if (!pur) throw notFound('Заказ не найден');
      if (pur.status !== 'pending') throw bad('decided', 'Заказ уже обработан');
      await q("UPDATE purchases SET status = 'rejected', decided_at = NOW(3) WHERE id = ?", [pur.id], conn);
      afterCommit(conn, () => publish(`shop:${pur.shop_id}`, { type: 'order_done', id: pur.id }));
      return null;
    });
    return { ok: true };
  });
```

### POST `/api/pos/purchases/:id/cancel`

Исходник: `api/src/routes/pos-ext.js:140`.

```js
  app.post('/purchases/:id/cancel', owner, async (req) => {
    const r = await q("UPDATE purchases SET status = 'cancelled', decided_at = NOW(3) WHERE id = ? AND shop_id = ? AND status = 'pending'", [int(req.params.id, 'id'), req.pos.shopId]);
    if (!r.affectedRows) throw bad('decided', 'Заказ уже обработан');
    return { ok: true };
  });

  // Сводка склада и бизнес-счёт: нужны страницам «Склад» и «Закупки».
```

### GET `/api/pos/stock/summary`

Исходник: `api/src/routes/pos-ext.js:147`.

```js
  app.get('/stock/summary', owner, async (req) => {
    const n = (v) => Number(v || 0);
    const p = await one(`SELECT COUNT(*) AS positions,
      COALESCE(SUM(ROUND(cost * GREATEST(stock_milli, 0) / 1000)), 0) AS value,
      COALESCE(SUM(track_stock = 1 AND stock_milli > 0 AND stock_milli <= 5000), 0) AS low,
      COALESCE(SUM(track_stock = 1 AND stock_milli <= 0), 0) AS zero
      FROM products WHERE shop_id = ? AND deleted_at IS NULL AND active = 1`, [req.pos.shopId]);
    const shop = await shopOf(req);
    const acc = await one('SELECT balance FROM accounts WHERE id = ?', [shop.account_id]);
    const purchases = await one("SELECT COALESCE(SUM(total),0) AS s FROM purchases WHERE shop_id = ? AND status = 'pending'", [req.pos.shopId]);
    return {
      positions: n(p.positions), stock_value: n(p.value), low: n(p.low), zero: n(p.zero),
      business_balance: n(acc?.balance), pending_purchases: n(purchases.s),
    };
  });
```

### GET `/api/pos/stock/moves`

Исходник: `api/src/routes/pos-ext.js:163`.

```js
  app.get('/stock/moves', owner, async (req) => {
    const rows = await q(`SELECT m.*, p.name, p.unit FROM stock_moves m JOIN products p ON p.id = m.product_id WHERE p.shop_id = ?${req.query.product_id ? ' AND p.id = ?' : ''} ORDER BY m.id DESC LIMIT 200`, [req.pos.shopId, ...(req.query.product_id ? [Number(req.query.product_id)] : [])]);
    return { moves: rows.map((m) => ({ ...m, qty_milli: Number(m.qty_milli) })) };
  });

  // ——— Акции и промокоды ———
  function promoFields(b) {
    const kind = ['percent', 'amount', 'qty'].includes(b.kind) ? b.kind : null;
    need(kind, 'Вид акции: процент, сумма или за количество');
    const value = kind === 'amount' ? amountOf(b.value, 'скидка') : int(Number(b.value), 'процент (б.п.)', { min: 1, max: 10000 });
    const code = b.code ? String(b.code).trim().toUpperCase().replace(/\s/g, '') : null;
    if (code) need(/^[A-Z0-9А-ЯЁ_-]{3,32}$/.test(code), 'Промокод: 3–32 буквы или цифры');
    if (kind === 'qty') need(b.product_id, 'Скидка за количество — на конкретный товар');
    return {
      title: str(b.title, 'название', { max: 80 }), kind, value, code,
      product_id: b.product_id ? int(b.product_id, 'товар') : null,
      min_qty: kind === 'qty' ? int(Number(b.min_qty) || 0, 'от количества', { min: 2, max: 10000 }) : 0,
      min_total: b.min_total ? int(b.min_total, 'от суммы', { min: 0, max: 1e12 }) : 0,
      max_uses: b.max_uses ? int(b.max_uses, 'лимит', { min: 1, max: 1e6 }) : null,
      active: b.active === undefined ? 1 : b.active ? 1 : 0,
    };
  }
```

### GET `/api/pos/promos`

Исходник: `api/src/routes/pos-ext.js:186`.

```js
  app.get('/promos', pos, async (req) => ({ promos: (await q('SELECT * FROM promos WHERE shop_id = ? ORDER BY active DESC, id DESC', [req.pos.shopId])).map(promoView) }));
```

### POST `/api/pos/promos`

Исходник: `api/src/routes/pos-ext.js:188`.

```js
  app.post('/promos', owner, async (req) => {
    const f = promoFields(req.body || {});
    if (f.product_id) await ownProduct(req, f.product_id);
    try {
      const r = await q('INSERT INTO promos (shop_id, title, kind, code, value, product_id, min_qty, min_total, max_uses, active) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [req.pos.shopId, f.title, f.kind, f.code, f.value, f.product_id, f.min_qty, f.min_total, f.max_uses, f.active]);
      return { id: r.insertId };
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') throw bad('promo_exists', 'Такой промокод уже есть');
      throw err;
    }
  });
```

### PATCH `/api/pos/promos/:id`

Исходник: `api/src/routes/pos-ext.js:200`.

```js
  app.patch('/promos/:id', owner, async (req) => {
    const p = await one('SELECT * FROM promos WHERE id = ? AND shop_id = ?', [int(req.params.id, 'id'), req.pos.shopId]);
    if (!p) throw notFound();
    if (Object.keys(req.body || {}).length === 1 && req.body.active !== undefined) {
      await q('UPDATE promos SET active = ? WHERE id = ?', [req.body.active ? 1 : 0, p.id]);
      return { ok: true };
    }
    const f = promoFields({ ...promoView(p), ...req.body });
    await q('UPDATE promos SET title = ?, kind = ?, code = ?, value = ?, product_id = ?, min_qty = ?, min_total = ?, max_uses = ?, active = ? WHERE id = ?', [f.title, f.kind, f.code, f.value, f.product_id, f.min_qty, f.min_total, f.max_uses, f.active, p.id]);
    return { ok: true };
  });

  // ——— Лояльность: клиент по карте ВлодБанка или паспорту БФ ———
```

### GET `/api/pos/loyalty/lookup`

Исходник: `api/src/routes/pos-ext.js:213`.

```js
  app.get('/loyalty/lookup', pos, async (req) => {
    const u = await loyaltyCustomer(null, req.query.q);
    const parts = u.full_name.split(' ');
    return { customer: { id: u.id, name: [parts[0], ...parts.slice(1).map((p) => `${p[0]}.`)].join(' '), points: await pointsOf(null, req.pos.shopId, u.id) } };
  });
```

### GET `/api/pos/loyalty`

Исходник: `api/src/routes/pos-ext.js:219`.

```js
  app.get('/loyalty', owner, async (req) => {
    const rows = await q('SELECT l.points, l.updated_at, u.full_name FROM loyalty_points l JOIN bank_users u ON u.id = l.bank_user_id WHERE l.shop_id = ? AND l.points > 0 ORDER BY l.points DESC LIMIT 200', [req.pos.shopId]);
    return { members: rows.map((r) => ({ ...r, points: Number(r.points) })) };
  });

  // ——— Долги ———
```

### GET `/api/pos/debts`

Исходник: `api/src/routes/pos-ext.js:225`.

```js
  app.get('/debts', pos, async (req) => {
    const status = ['open', 'paid', 'written_off'].includes(req.query.status) ? req.query.status : 'open';
    const rows = await q('SELECT * FROM debts WHERE shop_id = ? AND status = ? ORDER BY id DESC LIMIT 300', [req.pos.shopId, status]);
    const sum = await one("SELECT COALESCE(SUM(amount - paid),0) AS s, COUNT(*) AS n FROM debts WHERE shop_id = ? AND status = 'open'", [req.pos.shopId]);
    return { debts: rows.map(debtView), open_total: Number(sum.s), open_count: Number(sum.n) };
  });
```

### POST `/api/pos/debts/:id/repay`

Исходник: `api/src/routes/pos-ext.js:232`.

```js
  app.post('/debts/:id/repay', pos, async (req) => {
    const b = req.body || {};
    const amount = amountOf(b.amount);
    const idem = idemKey(req, `pos${req.pos.staff.id}:debt`);
    const card = b.method === 'card' ? await authorizeCard({ number: b.number, exp: b.exp, pin: b.pin }) : null;
    const r = await tx(async (conn) => {
      const debt = await one('SELECT * FROM debts WHERE id = ? AND shop_id = ? FOR UPDATE', [int(req.params.id, 'id'), req.pos.shopId], conn);
      if (!debt) throw notFound('Долг не найден');
      const shop = await shopOf(req, conn);
      if (card) {
        await checkCardLimits(conn, card, amount);
        return repayDebt(conn, { debt, shop, amount, fromAccountId: card.account_id, cardId: card.id, actor: { kind: 'bank', id: req.pos.bank.id }, idem });
      }
      need(b.method === 'cash', 'Способ: наличные или карта');
      return repayDebt(conn, { debt, shop, amount, staff: req.pos.staff });
    });
    return r;
  });
```

### POST `/api/pos/debts/:id/write-off`

Исходник: `api/src/routes/pos-ext.js:251`.

```js
  app.post('/debts/:id/write-off', owner, async (req) => {
    const r = await q("UPDATE debts SET status = 'written_off' WHERE id = ? AND shop_id = ? AND status = 'open'", [int(req.params.id, 'id'), req.pos.shopId]);
    if (!r.affectedRows) throw bad('debt_closed', 'Долг уже закрыт');
    return { ok: true };
  });

  // ——— Столики и счета столов ———
```

### GET `/api/pos/tables`

Исходник: `api/src/routes/pos-ext.js:258`.

```js
  app.get('/tables', pos, async (req) => {
    const all = req.query.all === '1';
    const tables = await q(`SELECT * FROM shop_tables WHERE shop_id = ?${all ? '' : ' AND active = 1'} ORDER BY sort, id`, [req.pos.shopId]);
    const tabs = await q("SELECT id, table_id, total, created_at, (SELECT COUNT(*) FROM sale_items i WHERE i.sale_id = sales.id) AS items_count FROM sales WHERE shop_id = ? AND status = 'held' AND table_id IS NOT NULL", [req.pos.shopId]);
    const paying = await q("SELECT id, table_id FROM sales WHERE shop_id = ? AND status = 'open' AND table_id IS NOT NULL", [req.pos.shopId]);
    return {
      tables: tables.map((t) => {
        const tab = tabs.find((x) => x.table_id === t.id);
        return {
          id: t.id, name: t.name, seats: t.seats, active: !!t.active, sort: t.sort,
          tab: tab ? { id: tab.id, total: Number(tab.total), opened_at: tab.created_at, items_count: Number(tab.items_count) } : null,
          paying: paying.some((x) => x.table_id === t.id),
        };
      }),
    };
  });
```

### POST `/api/pos/tables`

Исходник: `api/src/routes/pos-ext.js:275`.

```js
  app.post('/tables', owner, async (req) => {
    const r = await q('INSERT INTO shop_tables (shop_id, name, seats, sort) VALUES (?, ?, ?, ?)', [req.pos.shopId, str(req.body?.name, 'название', { max: 40 }), int(Number(req.body?.seats) || 4, 'мест', { min: 1, max: 100 }), Number(req.body?.sort) || 0]);
    return { id: r.insertId };
  });
```

### PATCH `/api/pos/tables/:id`

Исходник: `api/src/routes/pos-ext.js:280`.

```js
  app.patch('/tables/:id', owner, async (req) => {
    const t = await one('SELECT * FROM shop_tables WHERE id = ? AND shop_id = ?', [int(req.params.id, 'id'), req.pos.shopId]);
    if (!t) throw notFound();
    const b = req.body || {};
    await q('UPDATE shop_tables SET name = ?, seats = ?, active = ? WHERE id = ?', [b.name !== undefined ? str(b.name, 'название', { max: 40 }) : t.name, b.seats !== undefined ? int(Number(b.seats), 'мест', { min: 1, max: 100 }) : t.seats, b.active !== undefined ? (b.active ? 1 : 0) : t.active, t.id]);
    return { ok: true };
  });

  async function tableOf(req, id, conn) {
    const t = await one('SELECT * FROM shop_tables WHERE id = ? AND shop_id = ? AND active = 1', [int(id, 'стол'), req.pos.shopId], conn);
    if (!t) throw notFound('Стол не найден');
    return t;
  }

  async function tabOf(req, tableId, conn) {
    const table = await tableOf(req, tableId, conn);
    const tab = await openTab(conn, req.pos.shopId, table.id);
    if (!tab) throw notFound('У стола нет открытого счёта');
    return { table, tab: await loadSale(conn, tab.id) };
  }
```

### GET `/api/pos/tables/:id/tab`

Исходник: `api/src/routes/pos-ext.js:301`.

```js
  app.get('/tables/:id/tab', pos, async (req) => {
    const table = await tableOf(req, req.params.id);
    const tab = await openTab(null, req.pos.shopId, table.id);
    return { table: { id: table.id, name: table.name }, tab: tab ? saleView(await loadSale(null, tab.id)) : null };
  });
```

### POST `/api/pos/tables/:id/items`

Исходник: `api/src/routes/pos-ext.js:307`.

```js
  app.post('/tables/:id/items', pos, async (req) => {
    const sale = await tx(async (conn) => addToTab(conn, { shopId: req.pos.shopId, staff: req.pos.staff, table: await tableOf(req, req.params.id, conn), lines: req.body?.items }));
    publish(`shop:${req.pos.shopId}`, { type: 'tables' });
    return { tab: saleView(sale) };
  });
```

### POST `/api/pos/tables/:id/remove`

Исходник: `api/src/routes/pos-ext.js:313`.

```js
  app.post('/tables/:id/remove', pos, async (req) => {
    const sale = await tx(async (conn) => {
      const { tab } = await tabOf(req, req.params.id, conn);
      return removeFromTab(conn, { tab, itemId: int(req.body?.item_id, 'позиция'), staff: req.pos.staff });
    });
    publish(`shop:${req.pos.shopId}`, { type: 'tables' });
    return { tab: sale ? saleView(sale) : null };
  });
```

### POST `/api/pos/tables/:id/kitchen`

Исходник: `api/src/routes/pos-ext.js:322`.

```js
  app.post('/tables/:id/kitchen', pos, async (req) => {
    const order = await tx(async (conn) => {
      const { tab, table } = await tabOf(req, req.params.id, conn);
      return sendTabToKitchen(conn, { tab, table });
    });
    return { order };
  });
```

### POST `/api/pos/tables/:id/checkout`

Исходник: `api/src/routes/pos-ext.js:330`.

```js
  app.post('/tables/:id/checkout', pos, async (req) => {
    const b = req.body || {};
    const sale = await tx(async (conn) => {
      const { tab } = await tabOf(req, req.params.id, conn);
      return tabCheckout(conn, {
        tab,
        staff: req.pos.staff,
        discount: b.discount ? int(b.discount, 'скидка', { min: 0, max: 1e12 }) : 0,
        promoCode: b.promo_code || null,
        loyalty: b.loyalty || null,
        redeemPoints: b.redeem_points ? int(b.redeem_points, 'баллы', { min: 0, max: 1e12 }) : 0,
        tipPct: Number(b.tip_pct || 0),
      });
    });
    publish(`shop:${req.pos.shopId}`, { type: 'tables' });
    return { sale: saleView(sale) };
  });

  // Перенос счёта на другой стол.
```

### POST `/api/pos/tables/:id/move`

Исходник: `api/src/routes/pos-ext.js:349`.

```js
  app.post('/tables/:id/move', pos, async (req) => {
    await tx(async (conn) => {
      const { tab } = await tabOf(req, req.params.id, conn);
      const to = await tableOf(req, req.body?.to_table_id, conn);
      if (await openTab(conn, req.pos.shopId, to.id)) throw bad('table_busy', 'У стола уже есть открытый счёт');
      await q('UPDATE sales SET table_id = ?, hold_label = ? WHERE id = ?', [to.id, to.name, tab.id], conn);
    });
    publish(`shop:${req.pos.shopId}`, { type: 'tables' });
    return { ok: true };
  });

  // Отмена (закрытие без оплаты) счёта стола: позиции не продаются, остаток не меняется.
```

### DELETE `/api/pos/tables/:id/tab`

Исходник: `api/src/routes/pos-ext.js:361`.

```js
  app.delete('/tables/:id/tab', pos, async (req) => {
    await tx(async (conn) => {
      const { tab } = await tabOf(req, req.params.id, conn);
      await q("UPDATE sales SET status = 'cancelled' WHERE id = ?", [tab.id], conn);
      await posLog(conn, {
        shopId: req.pos.shopId, staffId: req.pos.staff.id, action: 'table_cancel', saleId: tab.id,
        data: { total: Number(tab.total), items: tab.items.length },
      });
    });
    publish(`shop:${req.pos.shopId}`, { type: 'tables' });
    return { ok: true };
  });

  // ——— Кухня и табло очереди ———
```

### GET `/api/pos/kitchen`

Исходник: `api/src/routes/pos-ext.js:375`.

```js
  app.get('/kitchen', pos, async (req) => {
    const rows = await q("SELECT k.*, s.number AS sale_number FROM kitchen_orders k LEFT JOIN sales s ON s.id = k.sale_id WHERE k.shop_id = ? AND (k.status IN ('new','cooking','ready') OR (k.status = 'done' AND k.updated_at >= NOW(3) - INTERVAL 30 MINUTE)) ORDER BY k.id", [req.pos.shopId]);
    return { orders: rows.map(kitchenView) };
  });
```

### POST `/api/pos/kitchen/:id/status`

Исходник: `api/src/routes/pos-ext.js:380`.

```js
  app.post('/kitchen/:id/status', pos, async (req) => {
    const status = String(req.body?.status || '');
    need(KITCHEN_STATUSES.includes(status), 'Неверный статус');
    return tx(async (conn) => {
      const order = await one('SELECT * FROM kitchen_orders WHERE id = ? AND shop_id = ? FOR UPDATE', [int(req.params.id, 'id'), req.pos.shopId], conn);
      if (!order) throw notFound('Заказ не найден');
      if (order.status === status) return { ok: true, status };
      if (!(KITCHEN_NEXT[order.status] || []).includes(status)) throw bad('kitchen_state', 'Такой переход статуса недоступен');
      await q('UPDATE kitchen_orders SET status = ? WHERE id = ?', [status, order.id], conn);
      await posLog(conn, {
        shopId: req.pos.shopId, staffId: req.pos.staff.id, action: 'kitchen_status',
        data: { order: order.id, queue_no: order.queue_no, from: order.status, status },
      });
      afterCommit(conn, () => publish(`shop:${req.pos.shopId}`, { type: 'kitchen', id: order.id, queue_no: order.queue_no, status }));
      return { ok: true, status };
    });
  });
```

### GET `/api/pos/queue`

Исходник: `api/src/routes/pos-ext.js:398`.

```js
  app.get('/queue', pos, async (req) => queueBoard(req.pos.shopId));

  // Публичное табло очереди для экрана в зале: без входа, только номера заказов.
```

### GET `/api/pos/public/queue/:shopId`

Исходник: `api/src/routes/pos-ext.js:401`.

```js
  app.get('/public/queue/:shopId', limited(120), async (req) => queueBoard(int(req.params.shopId, 'магазин')));

  // ——— Киоск: выход из режима самообслуживания по PIN сотрудника ———
```

### POST `/api/pos/kiosk/unlock`

Исходник: `api/src/routes/pos-ext.js:404`.

```js
  app.post('/kiosk/unlock', pos, async (req) => {
    const st = await one('SELECT pin_hash FROM shop_staff WHERE id = ?', [req.pos.staff.id]);
    if (!(await verifyHash(String(req.body?.pin || ''), st.pin_hash))) throw bad('pin_wrong', 'Неверный PIN');
    return { ok: true };
  });

  // ——— Отчёты владельцу ———
```

### GET `/api/pos/reports`

Исходник: `api/src/routes/pos-ext.js:411`.

```js
  app.get('/reports', owner, async (req) => {
    const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
    const id = req.pos.shopId;
    const where = "s.shop_id = ? AND s.status = 'paid' AND s.paid_at >= NOW() - INTERVAL ? DAY";
    const totals = await one(`SELECT COUNT(*) AS n, COALESCE(SUM(total),0) AS revenue, COALESCE(SUM(vat),0) AS vat, COALESCE(SUM(refunded),0) AS refunded, COALESCE(SUM(discount),0) AS discounts, COALESCE(SUM(tip),0) AS tips FROM sales s WHERE ${where}`, [id, days]);
    const cost = await one(`SELECT COALESCE(SUM(ROUND(p.cost * (i.qty_milli - i.refunded_milli) / 1000)),0) AS cost FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN products p ON p.id = i.product_id WHERE ${where}`, [id, days]);
    const top = await q(`SELECT i.name, SUM(i.qty_milli - i.refunded_milli) AS qty_milli, SUM(i.total) AS total, MAX(i.unit) AS unit FROM sale_items i JOIN sales s ON s.id = i.sale_id WHERE ${where} GROUP BY i.name ORDER BY total DESC LIMIT 10`, [id, days]);
    const byCategory = await q(`SELECT COALESCE(NULLIF(p.category,''),'—') AS category, SUM(i.total) AS total FROM sale_items i JOIN sales s ON s.id = i.sale_id LEFT JOIN products p ON p.id = i.product_id WHERE ${where} GROUP BY category ORDER BY total DESC`, [id, days]);
    const byCashier = await q(`SELECT u.full_name, COUNT(*) AS n, SUM(s.total) AS total, SUM(s.tip) AS tips FROM sales s JOIN shop_staff st ON st.id = s.staff_id JOIN bank_users u ON u.id = st.bank_user_id WHERE ${where} GROUP BY u.full_name ORDER BY total DESC`, [id, days]);
    const byHour = await q(`SELECT HOUR(paid_at) AS h, COUNT(*) AS n, SUM(total) AS total FROM sales s WHERE ${where} GROUP BY HOUR(paid_at) ORDER BY h`, [id, days]);
    const byDay = await q(`SELECT DATE(paid_at) AS d, COUNT(*) AS n, SUM(total) AS total, SUM(refunded) AS refunded FROM sales s WHERE ${where} GROUP BY DATE(paid_at) ORDER BY d`, [id, days]);
    const byMethod = await q(`SELECT p.method, SUM(p.amount) AS total FROM sale_payments p JOIN sales s ON s.id = p.sale_id WHERE ${where} GROUP BY p.method`, [id, days]);
    const bySource = await q(`SELECT s.source, COUNT(*) AS n, SUM(s.total) AS total FROM sales s WHERE ${where} GROUP BY s.source`, [id, days]);
    const purchases = await one("SELECT COALESCE(SUM(total),0) AS s FROM purchases WHERE shop_id = ? AND status = 'done' AND decided_at >= NOW() - INTERVAL ? DAY", [id, days]);
    const debts = await one("SELECT COALESCE(SUM(amount - paid),0) AS s FROM debts WHERE shop_id = ? AND status = 'open'", [id]);
    const stockValue = await one('SELECT COALESCE(SUM(ROUND(cost * GREATEST(stock_milli,0) / 1000)),0) AS s FROM products WHERE shop_id = ? AND deleted_at IS NULL AND track_stock = 1', [id]);
    const low = await q('SELECT id, name, unit, stock_milli FROM products WHERE shop_id = ? AND deleted_at IS NULL AND active = 1 AND track_stock = 1 AND stock_milli <= 5000 ORDER BY stock_milli LIMIT 20', [id]);
    const balance = await one('SELECT a.balance FROM shops s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?', [id]);
    const revenue = Number(totals.revenue) - Number(totals.refunded);
    const n = (v) => Number(v || 0);
    return {
      days,
      sales: n(totals.n),
      revenue,
      vat: n(totals.vat),
      cost: n(cost.cost),
      profit: revenue - n(totals.vat) - n(cost.cost),
      discounts: n(totals.discounts),
      refunds: n(totals.refunded),
      tips: n(totals.tips),
      avg_check: n(totals.n) ? Math.round(n(totals.revenue) / n(totals.n)) : 0,
      purchases: n(purchases.s),
      debts_open: n(debts.s),
      stock_value: n(stockValue.s),
      business_balance: n(balance?.balance),
      top: top.map((r) => ({ name: r.name, unit: r.unit, qty_milli: n(r.qty_milli), total: n(r.total) })),
      by_category: byCategory.map((r) => ({ category: r.category, total: n(r.total) })),
      by_cashier: byCashier.map((r) => ({ name: r.full_name, sales: n(r.n), total: n(r.total), tips: n(r.tips) })),
      by_hour: byHour.map((r) => ({ hour: r.h, sales: n(r.n), total: n(r.total) })),
      by_day: byDay.map((r) => ({ day: r.d, sales: n(r.n), total: n(r.total) - n(r.refunded) })),
      by_method: Object.fromEntries(byMethod.map((r) => [r.method, n(r.total)])),
      by_source: Object.fromEntries(bySource.map((r) => [r.source, { sales: n(r.n), total: n(r.total) }])),
      low_stock: low.map((p) => ({ ...p, stock_milli: n(p.stock_milli) })),
    };
  });
}

/** Долги клиента ВлодБанка перед магазинами: видны в банке, гасятся переводом. */
```

### GET `/api/bank/debts`

Исходник: `api/src/routes/pos-ext.js:462`.

```js
  app.get('/debts', auth, async (req) => {
    const rows = await q("SELECT d.*, s.name AS shop_name FROM debts d JOIN shops s ON s.id = d.shop_id WHERE d.bank_user_id = ? ORDER BY d.status = 'open' DESC, d.id DESC LIMIT 100", [req.bank.id]);
    return { debts: rows.map(debtView) };
  });
```

### POST `/api/bank/debts/:id/pay`

Исходник: `api/src/routes/pos-ext.js:467`.

```js
  app.post('/debts/:id/pay', auth, async (req) => {
    const idem = idemKey(req, `b${req.bank.id}:debt`);
    const r = await tx(async (conn) => {
      const debt = await one('SELECT * FROM debts WHERE id = ? AND bank_user_id = ? FOR UPDATE', [int(req.params.id, 'id'), req.bank.id], conn);
      if (!debt) throw notFound('Долг не найден');
      const acc = await ownAccount(req.bank.id, int(req.body?.account_id, 'счёт'), conn);
      assertSpendable(acc);
      const shop = await one('SELECT * FROM shops WHERE id = ?', [debt.shop_id], conn);
      const amount = req.body?.amount ? amountOf(req.body.amount) : Number(debt.amount) - Number(debt.paid);
      return repayDebt(conn, { debt, shop, amount, fromAccountId: acc.id, actor: { kind: 'bank', id: req.bank.id }, idem });
    });
    return r;
  });
}
```


## net.js — `api/src/routes/net.js`

### GET `/api/net/providers`

Исходник: `api/src/routes/net.js:85`.

```js
  app.get('/providers', async () => {
    const snap = await netSnapshot();
    const publicResolvers = [...snap.hostByIp.values()].filter((h) => h.kind === 'resolver' && !h.provider_id && h.up).map((h) => ({ ip: h.ip, name: h.name }));
    return {
      providers: snap.providers.filter((p) => p.active).map((p) => ({ code: p.code, name: p.name, resolver_ip: p.resolver_ip })),
      public_resolvers: publicResolvers,
    };
  });
```

### POST `/api/net/lease`

Исходник: `api/src/routes/net.js:94`.

```js
  app.post('/lease', limited(30), async (req) => {
    const b = req.body || {};
    const r = await lease(b.client_id, String(b.provider || ''));
    const snap = await netSnapshot();
    const block = snap.blocks.find((x) => x.id === r.provider.block_id);
    return { ip: r.ip, provider: { code: r.provider.code, name: r.provider.name }, resolver_ip: r.provider.resolver_ip, gateway: block?.gateway_ip || null, netmask: block?.cidr || null };
  });
```

### POST `/api/net/resolve`

Исходник: `api/src/routes/net.js:102`.

```js
  app.post('/resolve', limited(240), async (req) => {
    await online();
    const c = await clientCtx(req.body || {});
    return resolve({ resolverIp: c.resolverIp, clientIp: c.ip, clientProviderId: c.provider.id, name: req.body.name, type: req.body.type || 'A', dnssec: !!req.body.dnssec, cd: !!req.body.cd });
  });
```

### POST `/api/net/query`

Исходник: `api/src/routes/net.js:108`.

```js
  app.post('/query', limited(240), async (req) => {
    await online();
    const b = req.body || {};
    const c = await clientCtx(b);
    const server = ipParam(b.server, 'Сервер') || c.resolverIp;
    return queryServer({ serverIp: server, clientIp: c.ip, clientProviderId: c.provider.id, name: b.name, type: b.type || 'A', recurse: b.recurse !== false, dnssec: !!b.dnssec, cd: !!b.cd });
  });

  /** Хранилище доверия ВлодБраузера: корневые УЦ, журналы прозрачности, отозванные УЦ. */
```

### GET `/api/net/trust`

Исходник: `api/src/routes/net.js:117`.

```js
  app.get('/trust', async () => trustStore());

  // Открытие адреса браузером: DNS → подключение к серверу → TLS (для https) → что показать.
  // tls: { chain, sct, ocsp, time } — браузер сам проверяет подписи; null — на сервере нет сертификата (порт 443 закрыт).
  // Для сайта игрока выдаётся билет шлюза (адрес песочницы) с хранилищами сайта от браузера.
```

### POST `/api/net/open`

Исходник: `api/src/routes/net.js:122`.

```js
  app.post('/open', limited(240), async (req) => {
    await online();
    const b = req.body || {};
    const c = await clientCtx(b);
    const r = await openFor(c, String(b.url || ''));
    if (!r.ok) return r;
    const p = splitUrl(r.url);
    if (p.scheme === 'https') r.tls = await tlsFor({ target: r.target, host: p.host });
    if (r.target?.startsWith('site:') && !(p.scheme === 'https' && !r.tls)) {
      const jar = cleanJar(b.jar);
      r.ticket = createTicket({ clientId: b.client_id, clientIp: c.ip, referrer: refOrigin(b.referrer), resolver: c.resolverIp, target: r.target, host: p.host, scheme: p.scheme, origin: `${p.scheme}://${p.host}`, notif: notifPermission(b.notifications, p.scheme), ...jar });
    }
    return r;
  });
```

### POST `/api/net/ping`

Исходник: `api/src/routes/net.js:137`.

```js
  app.post('/ping', limited(60), async (req) => {
    await online();
    const b = req.body || {};
    const c = await clientCtx(b);
    const { ip, dns } = await hostToIp(c, b.host);
    if (!ip) return { host: b.host, error: dnsErrorCode(dns), dns };
    const count = int(b.count ?? 4, 'count', { min: 1, max: 10 });
    return { host: b.host, ...ping(await netSnapshot(), c.ip, ip, count) };
  });
```

### POST `/api/net/traceroute`

Исходник: `api/src/routes/net.js:147`.

```js
  app.post('/traceroute', limited(30), async (req) => {
    await online();
    const b = req.body || {};
    const c = await clientCtx(b);
    const { ip, dns } = await hostToIp(c, b.host);
    if (!ip) return { host: b.host, error: dnsErrorCode(dns), dns };
    return { host: b.host, ...traceroute(await netSnapshot(), c.ip, ip) };
  });

  // ——— SSH на сервер хостинга: ssh u<номер>@<сервер> из терминала ВлодБраузера ———
```

### POST `/api/net/ssh/login`

Исходник: `api/src/routes/net.js:157`.

```js
  app.post('/ssh/login', limited(10), async (req) => {
    await online();
    const b = req.body || {};
    const c = await clientCtx(b);
    const { ip, dns } = await hostToIp(c, b.host);
    if (!ip) return { error: `ssh: Could not resolve hostname ${b.host}: ${dnsErrorCode(dns)}` };
    const snap = await netSnapshot();
    const reach = ping(snap, c.ip, ip, 1);
    if (!reach.reachable || reach.replies[0].lost) return { error: `ssh: connect to host ${b.host} port 22: Connection timed out` };
    const server = await one("SELECT * FROM hosting_servers WHERE ip = ? AND status = 'active'", [ip]);
    if (!server) return { error: `ssh: connect to host ${b.host} port 22: Connection refused` };
    const m = /^u(\d+)$/.exec(String(b.user || ''));
    const acc = m ? await one("SELECT * FROM hosting_accounts WHERE id = ? AND server_id = ? AND status IN ('active','suspended')", [Number(m[1]), server.id]) : null;
    if (!acc || !acc.ssh_hash || !(await verifyHash(String(b.password || ''), acc.ssh_hash))) return { error: `${b.user}@${b.host}: Permission denied (password).` };
    const name = String(server.name).replace(/\.$/, '').split('.')[0];
    const id = newSession(acc, name, ip);
    const s = getSession(id);
    return { session: id, prompt: prompt(s), motd: [`Добро пожаловать на ${String(server.name).replace(/\.$/, '')} (${ip}) — хостинг БалНета.`, 'help — список команд, exit — выход.', acc.status === 'suspended' ? 'Внимание: хостинг приостановлен за неуплату.' : ''].filter(Boolean) };
  });
```

### POST `/api/net/ssh/exec`

Исходник: `api/src/routes/net.js:177`.

```js
  app.post('/ssh/exec', limited(600), async (req) => {
    await online();
    const s = getSession(req.body?.session);
    if (!s) return { error: 'Connection closed by remote host (сессия истекла)', closed: true };
    const r = await shell(s, req.body?.line);
    if (r.exit) endSession(req.body.session);
    return { ...r, prompt: prompt(s) };
  });
```

### POST `/api/net/ssh/save`

Исходник: `api/src/routes/net.js:186`.

```js
  app.post('/ssh/save', limited(120), async (req) => {
    const s = getSession(req.body?.session);
    if (!s) return { error: 'Сессия истекла', closed: true };
    return saveFile(s, req.body?.path, req.body?.content);
  });
```

### GET `/api/net/whois`

Исходник: `api/src/routes/net.js:192`.

```js
  app.get('/whois', limited(60), async (req) => {
    await online();
    const name = fqdn(String(req.query.q || ''));
    const dom = name ? await whoisDomain(null, name) : null;
    return dom || whois(req.query.q);
  });
}
```


## web.js — `api/src/routes/web.js`

### GET `/api/net/shim.js`

Исходник: `api/src/routes/web.js:50`.

```js
  app.get('/shim.js', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    reply.header('Cross-Origin-Resource-Policy', 'cross-origin');
    reply.header('Cache-Control', 'public, max-age=300');
    reply.header('ETag', SHIM_ETAG);
    if (req.headers['if-none-match'] === SHIM_ETAG) return reply.code(304).send();
    return reply.type('text/javascript; charset=utf-8').send(SHIM_JS);
  });

  // Страницы сайта: тело запроса передаётся как есть (формы, JSON, текст) — его разбирает server.js.
  await app.register(async (sub) => {
    sub.removeAllContentTypeParsers();
    sub.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 1024 * 1024 }, (req, body, done) => done(null, body));
    const serve = async (req, reply) => {
      const ticketId = req.params.ticket;
      const ticket = getTicket(ticketId);
      const site = await siteOf(reply, ticket);
      if (!site) return reply;
      const prefix = `/api/net/web/${ticketId}`;
      const urlPath = `/${req.params['*'] || ''}`;
      const query = req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '';
      const headers = {};
      for (const k of ['content-type', 'accept', 'accept-language', 'user-agent']) if (req.headers[k]) headers[k] = String(req.headers[k]);
      const ck = cookieHeader(ticket.cookies);
      if (ck) headers.cookie = ck;
      headers.referer = ticket.origin + urlPath;
      const r = await siteRespond(site, { method: req.method, path: urlPath + query, headers, body: req.body || null, ip: ticket.clientIp, host: ticket.host, scheme: ticket.scheme });
      const jarChanged = applySetCookies(ticket, r.setCookies);
      securityHeaders(reply);
      if (jarChanged) reply.header('X-Balnet-Jar', '1');
      if (r.status >= 300 && r.status < 400 && r.headers.location) {
        // Переадресация внутри своего сайта остаётся в шлюзе; на другой сайт — через ВлодБраузер (shim).
        const loc = new URL(r.headers.location, `${ticket.origin}${urlPath}`);
        const same = `${loc.protocol}//${loc.host}` === ticket.origin;
        return reply.code(r.status).header('Location', same ? `${prefix}${loc.pathname}${loc.search}` : `${prefix}/__balnet_redirect?to=${encodeURIComponent(loc.href)}`).send();
      }
      if (r.notFound) return page(reply, 404, '404 — страница не найдена', `На сайте ${ticket.host} нет страницы ${urlPath}.`);
      for (const [k, v] of Object.entries(r.headers)) if (k !== 'content-type' && (SITE_HEADER_OK(k) || (r.dynamic && k === 'location'))) reply.header(k, v);
      const type = r.headers['content-type'] || 'application/octet-stream';
      reply.code(r.status).type(type);
      if (req.method === 'HEAD') return reply.send();
      if (type.startsWith('text/html')) {
        if (req.method === 'GET' && r.status === 200) {
          const first = !ticket.seen;
          ticket.seen = true;
          recordHit(site, ticket, urlPath, { first }).catch(() => {});
        }
        const html = rewriteRootPaths(r.body.toString('utf8'), prefix, 'html');
        return reply.send(injectShim(html, {
          ticket: ticketId, prefix, origin: ticket.origin, cookies: ticket.cookies, local: ticket.local, jarDirty: jarChanged, notif: ticket.notif || 'default',
        }));
      }
      if (type.startsWith('text/css')) return reply.send(rewriteRootPaths(r.body.toString('utf8'), prefix, 'css'));
      return reply.send(r.body);
    };
    // Переадресация сайта на чужой адрес: страница просит ВлодБраузер открыть его.
```

### GET `/api/net/web/:ticket/__balnet_redirect`

Исходник: `api/src/routes/web.js:106`.

```js
    sub.get('/web/:ticket/__balnet_redirect', async (req, reply) => {
      securityHeaders(reply);
      const to = String(req.query.to || '');
      const ticket = getTicket(req.params.ticket);
      if (!ticket || !/^https?:\/\//.test(to)) return page(reply, 400, 'Неверная переадресация', '');
      return reply.type('text/html; charset=utf-8').send(injectShim(`<!doctype html><html><head><title>Переадресация</title></head><body><script>parent.postMessage({__balnet:1,ticket:${JSON.stringify(req.params.ticket)},type:'open',url:${JSON.stringify(to).replace(/</g, '\\u003c')}},'*')</script></body></html>`, { ticket: req.params.ticket, prefix: `/api/net/web/${req.params.ticket}`, origin: ticket.origin, cookies: ticket.cookies, local: ticket.local }));
    });
    sub.route({ method: ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'], url: '/web/:ticket/*', handler: serve });
```

### GET `/api/net/web/:ticket`

Исходник: `api/src/routes/web.js:114`.

```js
    sub.get('/web/:ticket', async (req, reply) => reply.redirect(`/api/net/web/${req.params.ticket}/`));
  });

  // fetch со страницы сайта к другому сайту БалНета. Правила как в браузере: свой origin — можно,
  // чужой — только если сайт разрешил (Access-Control-Allow-Origin в _headers или в ответе server.js).
  // Для «непростых» запросов (PUT, DELETE, JSON) сначала идёт предварительный OPTIONS, как в браузере.
```

### POST `/api/net/xfetch`

Исходник: `api/src/routes/web.js:120`.

```js
  app.post('/xfetch', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    let b = req.body;
    if (typeof b === 'string') { try { b = JSON.parse(b); } catch { b = {}; } }
    const ticket = getTicket(b?.ticket);
    if (!ticket) return { error: 'ticket', message: 'Страница устарела — обновите её' };
    const method = String(b.method || 'GET').toUpperCase();
    if (!['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE'].includes(method)) return { error: 'method', message: `Метод ${method} не поддерживается` };
    if (await isPaused()) return { error: 'maintenance', message: 'БалНет на обслуживании' };
    const target = splitUrl(String(b.url || ''));
    if (!target || (target.scheme !== 'http' && target.scheme !== 'https')) return { error: 'url', message: 'Неверный адрес' };
    const targetOrigin = `${target.scheme}://${target.host}`;
    const cross = targetOrigin !== ticket.origin;
    const headers = {};
    for (const [k, v] of Object.entries(b.headers || {}).slice(0, 30)) if (/^[a-z0-9-]{1,64}$/i.test(k) && !/^(cookie|host|origin)$/i.test(k)) headers[k.toLowerCase()] = String(v).slice(0, 2000);
    if (cross) headers.origin = ticket.origin;
    else { const ck = cookieHeader(ticket.cookies); if (ck) headers.cookie = ck; }
    const allowOf = async (res, pathOnly) => {
      const h = res.siteId ? { ...(await siteHeadersFor(res)), ...res.headers } : res.headers;
      return { origin: h['access-control-allow-origin'], methods: String(h['access-control-allow-methods'] || ''), pathOnly };
    };
    const ctype = String(headers['content-type'] || '').split(';')[0];
    const simple = ['GET', 'HEAD', 'POST'].includes(method) && (!ctype || ['application/x-www-form-urlencoded', 'multipart/form-data', 'text/plain'].includes(ctype));
    if (cross && !simple) {
      const pre = await netRequest({ fromIp: ticket.clientIp, url: b.url, method: 'OPTIONS', headers: { origin: ticket.origin, 'access-control-request-method': method }, follow: false });
      if (pre.error) return { error: 'network', message: pre.error };
      const a = await allowOf(pre);
      if ((a.origin !== '*' && a.origin !== ticket.origin) || (a.methods && a.methods !== '*' && !a.methods.toUpperCase().split(/\s*,\s*/).includes(method))) {
        return { error: 'cors', message: `CORS: предварительный запрос к ${targetOrigin} не разрешил ${method} с ${ticket.origin}` };
      }
    }
    const body = b.body === undefined || b.body === null ? null : Buffer.from(String(b.body), b.bodyB64 ? 'base64' : 'utf8');
    const res = await netRequest({ fromIp: ticket.clientIp, url: b.url, method, headers, body, binary: true });
    if (res.gov) return { error: 'cors', message: `CORS: ${targetOrigin} не разрешает запросы с ${ticket.origin}` };
    if (res.error) return { error: 'network', message: res.error };
    if (cross) {
      const a = await allowOf(res);
      if (a.origin !== '*' && a.origin !== ticket.origin) return { error: 'cors', message: `CORS: ${targetOrigin} не разрешает запросы с ${ticket.origin}` };
    } else if (res.headers['set-cookie']) {
      applySetCookies(ticket, [].concat(res.headers['set-cookie']));
    }
    if (res.buf.length > MAX_INLINE) return { error: 'too_big', message: 'Ответ больше 2 МБ' };
    const out = {};
    for (const [k, v] of Object.entries(res.headers)) if (k !== 'set-cookie') out[k] = v;
    return { status: res.status, headers: out, body: res.buf.toString('base64'), url: res.url };
  });

  // WebSocket со страницы сайта: ws(s)://сайт/путь через шлюз. Как в браузере, соединение можно открыть
  // к любому сайту — сервер сам решает по Origin, принимать ли его.
```

### GET `/api/net/sock/:ticket`

Исходник: `api/src/routes/web.js:169`.

```js
  app.get('/sock/:ticket', { websocket: true }, (socket, req) => {
    const early = [];
    const hold = (m, bin) => early.push([m, bin]);
    socket.on('message', hold);
    (async () => {
      const ticket = getTicket(req.params.ticket);
      if (!ticket) return socket.close(4401, 'ticket');
      if (await isPaused()) return socket.close(1013, 'maintenance');
      const r = await reachSite({ fromIp: ticket.clientIp, url: String(req.query.url || '') });
      if (r.error) return socket.close(4502, String(r.error).slice(0, 120));
      socket.off('message', hold);
      const done = attach(socket, r.site, { path: r.path, query: r.query, ip: ticket.clientIp, origin: ticket.origin });
      for (const [m, bin] of early) socket.emit('message', m, bin); // встают в очередь после open
      await done;
      return undefined;
    })().catch(() => socket.close(1011, 'error'));
  });

  // ВлодБраузер передаёт свежие cookies и localStorage сайта: они нужны следующим страницам этого билета.
```

### POST `/api/net/jar`

Исходник: `api/src/routes/web.js:188`.

```js
  app.post('/jar', async (req) => {
    const t = getTicket(req.body?.ticket);
    if (!t) throw bad('ticket', 'Билет устарел');
    if (req.body.cookies || req.body.local) {
      const jar = cleanJar(req.body);
      t.cookies = jar.cookies;
      t.local = jar.local;
    }
    // Разрешение на уведомления меняет только ВлодБраузер (сайт из песочницы сюда не достаёт).
    if (['granted', 'denied', 'default'].includes(req.body?.notifications)) t.notif = t.scheme === 'https' ? req.body.notifications : 'denied';
    return { ok: true };
  });

  // Cookies, которые выставил сервер сайта (в том числе HttpOnly), — shim забирает их и отдаёт ВлодБраузеру.
```

### GET `/api/net/jar/:ticket`

Исходник: `api/src/routes/web.js:202`.

```js
  app.get('/jar/:ticket', async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    const t = getTicket(req.params.ticket);
    if (!t) return { error: 'ticket' };
    return { cookies: t.cookies };
  });
}

/** Заголовки из _headers сайта для ответа netRequest (CORS статических сайтов). */
async function siteHeadersFor(res) {
  const site = await siteByTarget(`site:${res.siteId}`);
  if (!site) return {};
  return siteHeaders(site.dir, new URL(res.url).pathname);
}
```


## search.js — `api/src/routes/search.js`

### GET `/api/search/search`

Исходник: `api/src/routes/search.js:44`.

```js
  app.get('/search', limited(120), async (req) => {
    await online();
    const qtext = String(req.query.q || '').trim().slice(0, 300);
    const tab = TABS.has(req.query.tab) ? req.query.tab : 'web';
    const page = Math.min(50, Math.max(1, Number(req.query.p) || 1));
    if (!qtext) return { q: '', tab, total: 0, results: [], ads: [] };
    const t0 = Date.now();
    let r;
    if (tab === 'images') r = await searchImages(qtext);
    else if (tab === 'news') r = await searchNews(qtext, { page });
    else if (tab === 'products') r = await searchProducts(qtext);
    else r = await searchWeb(qtext, { page });
    const client = clientOf(req);
    let ads = [];
    if (tab === 'web' && page === 1) ads = await runAuction({ stems: r.query.stems, placement: 'serp', limit: 3, client });
    await logQuery({ q: qtext, vertical: tab, client, results: r.total, shown: tab === 'web' ? r.results : [] });
    const { query, ...rest } = r;
    return { q: qtext, tab, ...rest, ads, ms: Date.now() - t0, operators: query ? { site: query.site, minus: query.minus.length, phrases: query.phrases } : null };
  });
```

### POST `/api/search/click`

Исходник: `api/src/routes/search.js:64`.

```js
  app.post('/click', limited(300), async (req) => {
    await logClick({ q: req.body?.q, url: req.body?.url });
    return { ok: true };
  });
```

### GET `/api/search/suggest`

Исходник: `api/src/routes/search.js:69`.

```js
  app.get('/suggest', limited(600), async (req) => ({ q: String(req.query.q || ''), suggestions: await suggest(req.query.q) }));
```

### GET `/api/search/trends`

Исходник: `api/src/routes/search.js:70`.

```js
  app.get('/trends', async () => ({ trends: await trends() }));
```

### GET `/api/search/stats`

Исходник: `api/src/routes/search.js:71`.

```js
  app.get('/stats', async () => indexStats());

  // Картинка из индекса: робот берёт файл с сайта (как кэш миниатюр поисковика).
```

### GET `/api/search/img/:id`

Исходник: `api/src/routes/search.js:74`.

```js
  app.get('/img/:id', async (req, reply) => {
    const img = await one("SELECT i.src FROM search_images i JOIN search_pages p ON p.id = i.page_id WHERE i.id = ? AND p.status = 'indexed'", [int(req.params.id, 'id')]);
    if (!img) throw notFound('Картинки нет в индексе');
    const r = await botFetch(img.src, { binary: true });
    const type = String(r.type || '').split(';')[0];
    if (r.status !== 200 || !r.buf || !IMG_RE.test(type)) throw notFound('Картинка недоступна');
    reply.header('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'; sandbox");
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type(type).send(r.buf);
  });
```

### GET `/api/search/product-photo/:id`

Исходник: `api/src/routes/search.js:86`.

```js
  app.get('/product-photo/:id', async (req, reply) => {
    const p = await one("SELECT p.photo FROM products p JOIN shops s ON s.id = p.shop_id WHERE p.id = ? AND p.active = 1 AND s.status = 'active'", [int(req.params.id, 'id')]);
    const m = /^data:(image\/(?:png|jpeg|webp|gif));base64,(.+)$/.exec(p?.photo || '');
    if (!m) throw notFound('Фото нет');
    reply.header('X-Content-Type-Options', 'nosniff');
    reply.header('Cache-Control', 'public, max-age=300');
    return reply.type(m[1]).send(Buffer.from(m[2], 'base64'));
  });

  // ——— Safe Browsing (для ВлодБраузера) ———
```

### GET `/api/search/sb/prefixes`

Исходник: `api/src/routes/search.js:96`.

```js
  app.get('/sb/prefixes', async () => ({ ...(await prefixes()), threats: THREATS }));
```

### POST `/api/search/sb/find`

Исходник: `api/src/routes/search.js:97`.

```js
  app.post('/sb/find', limited(300), async (req) => fullHashes(req.body?.prefixes));
```

### POST `/api/search/sb/report`

Исходник: `api/src/routes/search.js:98`.

```js
  app.post('/sb/report', limited(20), async (req) => report({ ...req.body, client: clientOf(req) }));

  // ——— Реклама: клик в выдаче и плитка на новой вкладке ———
```

### POST `/api/search/ads/click`

Исходник: `api/src/routes/search.js:101`.

```js
  app.post('/ads/click', limited(120), async (req) => click(req.body?.token, clientOf(req)));
```

### GET `/api/search/ads/newtab`

Исходник: `api/src/routes/search.js:102`.

```js
  app.get('/ads/newtab', limited(120), async (req) => ({ ad: (await runAuction({ stems: [], placement: 'newtab', limit: 1, client: clientOf(req) }))[0] || null }));

  // ——— Рекламная сеть на сайтах игроков: запросы идут со страницы сайта (песочница) с билетом шлюза ———
```

### POST `/api/search/adnet/serve`

Исходник: `api/src/routes/search.js:105`.

```js
  app.post('/adnet/serve', limited(300), async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    const b = parseBody(req.body);
    const t = getTicket(b.ticket);
    if (!t) return { ad: null, error: 'ticket' };
    const site = await adnetSite(t.host);
    if (!site) return { ad: null, error: 'Сайт не подключён к рекламной сети ВлодПоиска' };
    const path = String(b.path || '/').slice(0, 500);
    const idx = await getIndex();
    const url = `${t.origin}${path.startsWith('/') ? path : `/${path}`}`;
    const doc = idx.docs.find((d) => d.url === url) || idx.docs.find((d) => d.host === t.host);
    const stems = doc ? [...new Set(terms(`${doc.title || ''} ${doc.description || ''} ${String(doc.body || '').slice(0, 4000)}`))].slice(0, 300) : [];
    const [ad] = await runAuction({ stems, placement: 'network', limit: 1, client: devClient(t.clientId), siteId: site.id, host: t.host, excludeGovUser: site.gov_user_id });
    return { ad: ad ? { token: ad.token, title: ad.title, text: ad.text, display: ad.display } : null };
  });
```

### POST `/api/search/adnet/click`

Исходник: `api/src/routes/search.js:121`.

```js
  app.post('/adnet/click', limited(120), async (req, reply) => {
    reply.header('Access-Control-Allow-Origin', '*');
    const b = parseBody(req.body);
    const t = getTicket(b.ticket);
    if (!t) return { error: 'ticket' };
    const imp = await one('SELECT i.site_id, s.host FROM search_ad_impressions i JOIN search_sites s ON s.id = i.site_id WHERE i.token = ?', [String(b.token || '')]);
    if (!imp || imp.host !== t.host.replace(/^www\./, '')) return { error: 'Объявление не с этого сайта' };
    const r = await click(b.token, devClient(t.clientId));
    return { url: r.url };
  });

  // ——— Вебмастер ———
```

### GET `/api/search/webmaster/sites`

Исходник: `api/src/routes/search.js:133`.

```js
  app.get('/webmaster/sites', auth, async (req) => {
    const rows = await q('SELECT id, host, verified_at, adnet FROM search_sites WHERE gov_user_id = ? ORDER BY id', [req.gov.id]);
    const out = [];
    for (const r of rows) {
      const c = await one("SELECT COUNT(*) AS n FROM search_pages WHERE (host = ? OR host = ?) AND status = 'indexed'", [r.host, `www.${r.host}`]);
      out.push({ id: r.id, host: r.host, verified: !!r.verified_at, adnet: !!r.adnet, indexed: Number(c.n) });
    }
    const mine = await q("SELECT s.host FROM hosting_sites s JOIN hosting_accounts a ON a.id = s.account_id WHERE a.gov_user_id = ? AND a.status IN ('active','suspended')", [req.gov.id]).catch(() => []);
    return { sites: out, hosting: mine.map((m) => m.host) };
  });
```

### POST `/api/search/webmaster/sites`

Исходник: `api/src/routes/search.js:143`.

```js
  app.post('/webmaster/sites', auth, async (req) => ({ id: await addSite(req.gov.id, req.body?.host) }));
```

### GET `/api/search/webmaster/sites/:id`

Исходник: `api/src/routes/search.js:144`.

```js
  app.get('/webmaster/sites/:id', auth, async (req) => ({ site: await siteView(await ownSite(int(req.params.id, 'id'), req.gov.id)) }));
```

### POST `/api/search/webmaster/sites/:id/verify`

Исходник: `api/src/routes/search.js:145`.

```js
  app.post('/webmaster/sites/:id/verify', auth, async (req) => verifySite(await ownSite(int(req.params.id, 'id'), req.gov.id), String(req.body?.method || 'dns')));
```

### POST `/api/search/webmaster/sites/:id/recrawl`

Исходник: `api/src/routes/search.js:146`.

```js
  app.post('/webmaster/sites/:id/recrawl', auth, async (req) => recrawl(await ownSite(int(req.params.id, 'id'), req.gov.id), req.body?.url));
```

### POST `/api/search/webmaster/sites/:id/inspect`

Исходник: `api/src/routes/search.js:147`.

```js
  app.post('/webmaster/sites/:id/inspect', auth, async (req) => inspect(await ownSite(int(req.params.id, 'id'), req.gov.id), req.body?.url));
```

### POST `/api/search/webmaster/sites/:id/sitemaps`

Исходник: `api/src/routes/search.js:148`.

```js
  app.post('/webmaster/sites/:id/sitemaps', auth, async (req) => addSitemap(await ownSite(int(req.params.id, 'id'), req.gov.id), req.body?.url));
```

### POST `/api/search/webmaster/sites/:id/review`

Исходник: `api/src/routes/search.js:149`.

```js
  app.post('/webmaster/sites/:id/review', auth, async (req) => { await requestReview(await ownSite(int(req.params.id, 'id'), req.gov.id)); return { ok: true }; });
```

### PATCH `/api/search/webmaster/sites/:id`

Исходник: `api/src/routes/search.js:150`.

```js
  app.patch('/webmaster/sites/:id', auth, async (req) => { await setAdnet(await ownSite(int(req.params.id, 'id'), req.gov.id), !!req.body?.adnet); return { ok: true }; });
```

### DELETE `/api/search/webmaster/sites/:id`

Исходник: `api/src/routes/search.js:151`.

```js
  app.delete('/webmaster/sites/:id', auth, async (req) => {
    const s = await ownSite(int(req.params.id, 'id'), req.gov.id);
    need(!Number(s.earned_unpaid), 'Сначала дождитесь выплаты рекламной сети');
    await q('DELETE FROM search_sites WHERE id = ?', [s.id]);
    return { ok: true };
  });

  // ——— Рекламный кабинет ———
```

### GET `/api/search/ads/account`

Исходник: `api/src/routes/search.js:159`.

```js
  app.get('/ads/account', auth, async (req) => {
    const a = await adAccount(null, req.gov.id);
    const camps = await q("SELECT * FROM search_campaigns WHERE ad_account_id = ? AND status <> 'deleted' ORDER BY id DESC", [a.id]);
    const topups = await q('SELECT id, amount, invoice, status, created_at FROM search_ad_topups WHERE ad_account_id = ? ORDER BY id DESC LIMIT 20', [a.id]);
    return { account: { id: a.id, balance: Number(a.balance), spent_total: Number(a.spent_total) }, campaigns: camps.map(campaignView), topups };
  });
```

### POST `/api/search/ads/topup`

Исходник: `api/src/routes/search.js:165`.

```js
  app.post('/ads/topup', auth, async (req) => tx((conn) => topup(conn, req.gov.id, req.body?.amount)));
```

### POST `/api/search/ads/withdraw`

Исходник: `api/src/routes/search.js:166`.

```js
  app.post('/ads/withdraw', auth, async (req) => tx((conn) => withdraw(conn, req.gov.id)));
```

### POST `/api/search/ads/campaigns`

Исходник: `api/src/routes/search.js:167`.

```js
  app.post('/ads/campaigns', auth, async (req) => tx(async (conn) => ({ id: await createCampaign(conn, req.gov.id, req.body || {}) })));
```

### GET `/api/search/ads/campaigns/:id`

Исходник: `api/src/routes/search.js:168`.

```js
  app.get('/ads/campaigns/:id', auth, async (req) => {
    const c = await ownCampaign(null, int(req.params.id, 'id'), req.gov.id);
    return { campaign: campaignView(c), stats: await campaignStats(c.id) };
  });
```

### PATCH `/api/search/ads/campaigns/:id`

Исходник: `api/src/routes/search.js:172`.

```js
  app.patch('/ads/campaigns/:id', auth, async (req) => tx(async (conn) => {
    const c = await ownCampaign(conn, int(req.params.id, 'id'), req.gov.id);
    await updateCampaign(conn, c, req.body || {});
    return { ok: true };
  }));
  /** Прогноз: какие объявления сейчас выигрывают по слову (без записи показов). */
```

### GET `/api/search/ads/forecast`

Исходник: `api/src/routes/search.js:178`.

```js
  app.get('/ads/forecast', auth, async (req) => {
    const st = terms(String(req.query.q || ''));
    const rows = await q("SELECT c.id, c.bid, c.keywords FROM search_campaigns c JOIN search_ad_accounts a ON a.id = c.ad_account_id WHERE c.status = 'active' AND a.balance > 0");
    const bids = rows.filter((c) => (typeof c.keywords === 'string' ? JSON.parse(c.keywords) : c.keywords).some((k) => terms(k).every((t) => st.includes(t)))).map((c) => Number(c.bid)).sort((a, b) => b - a);
    const searches = await one('SELECT COUNT(*) AS n FROM search_queries WHERE qnorm LIKE ?', [`%${String(req.query.q || '').toLowerCase().slice(0, 60).replace(/[%_\\]/g, '\\$&')}%`]);
    return { competitors: bids.length, top_bid: bids[0] || null, searches: Number(searches.n) };
  });
}
```


## hub.js — `api/src/routes/hub.js`

### GET `/api/hub/git/*`

Исходник: `api/src/routes/hub.js:50`.

```js
    sub.get('/git/*', handler);
```

### POST `/api/hub/git/*`

Исходник: `api/src/routes/hub.js:51`.

```js
    sub.post('/git/*', handler);
  });

  // ——— Пользователь и токены ———
```

### GET `/api/hub/me`

Исходник: `api/src/routes/hub.js:55`.

```js
  app.get('/me', async (req) => {
    const s = await session(req, 'gov').catch(() => null);
    if (!s) return { gov: null, user: null };
    return { gov: { id: s.id }, user: await hubUser(s.id) };
  });
```

### POST `/api/hub/me`

Исходник: `api/src/routes/hub.js:60`.

```js
  app.post('/me', auth, async (req) => ({ user: await createUser(req.gov.id, req.body?.login, req.body?.name) }));
```

### GET `/api/hub/tokens`

Исходник: `api/src/routes/hub.js:61`.

```js
  app.get('/tokens', auth, async (req) => {
    const u = await me(req);
    return { tokens: await q('SELECT id, name, prefix, last_used, created_at FROM hub_tokens WHERE user_id = ? ORDER BY id DESC', [u.id]) };
  });
```

### POST `/api/hub/tokens`

Исходник: `api/src/routes/hub.js:65`.

```js
  app.post('/tokens', auth, async (req) => {
    const u = await me(req);
    const token = await createToken(u, req.body?.name);
    await audit(null, actorOf(req.gov), 'hub.token', 'hub_user', u.id);
    return { token, login: u.login };
  });
```

### DELETE `/api/hub/tokens/:id`

Исходник: `api/src/routes/hub.js:71`.

```js
  app.delete('/tokens/:id', auth, async (req) => {
    const u = await me(req);
    await q('DELETE FROM hub_tokens WHERE id = ? AND user_id = ?', [int(req.params.id, 'id'), u.id]);
    return { ok: true };
  });

  // ——— Репозитории ———
```

### GET `/api/hub/repos`

Исходник: `api/src/routes/hub.js:78`.

```js
  app.get('/repos', async (req) => {
    const u = await viewer(req);
    const owner = req.query.owner ? String(req.query.owner).toLowerCase() : null;
    const rows = await q(
      `SELECT r.*, u.login AS owner_login FROM hub_repos r JOIN hub_users u ON u.id = r.owner_id
       LEFT JOIN hub_collaborators c ON c.repo_id = r.id AND c.user_id = ?
       WHERE (r.private = 0 OR r.owner_id = ? OR c.user_id IS NOT NULL) ${owner ? 'AND u.login = ?' : ''}
       ORDER BY COALESCE(r.pushed_at, r.created_at) DESC LIMIT 100`, [u?.id || 0, u?.id || 0, ...(owner ? [owner] : [])],
    );
    return { repos: rows.map((r) => ({ owner: r.owner_login, name: r.name, description: r.description, private: !!r.private, pushed_at: r.pushed_at, mine: r.owner_id === u?.id })) };
  });
```

### POST `/api/hub/repos`

Исходник: `api/src/routes/hub.js:90`.

```js
  app.post('/repos', auth, async (req) => {
    const u = await me(req);
    const r = await createRepo(u, req.body || {});
    return { owner: u.login, name: r.name };
  });

  const ctx = async (req, level = 'read') => {
    const u = await viewer(req);
    const r = await repoFor(req.params.owner, req.params.name, u, level);
    return { ...r, user: u, gitdir: gitdirOf(r.repo) };
  };
```

### GET `/api/hub/repos/:owner/:name`

Исходник: `api/src/routes/hub.js:102`.

```js
  app.get('/repos/:owner/:name', async (req) => {
    const { repo, access, gitdir } = await ctx(req);
    const refs = await refsOf(gitdir);
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const deploys = await q('SELECT d.*, s.host FROM hub_deploys d LEFT JOIN hosting_sites s ON s.id = d.site_id WHERE d.repo_id = ? ORDER BY d.id DESC LIMIT 10', [repo.id]);
    const site = repo.deploy_site_id ? await one('SELECT id, host FROM hosting_sites WHERE id = ?', [repo.deploy_site_id]) : null;
    const counts = await one("SELECT SUM(kind = 'issue' AND state = 'open') AS issues, SUM(kind = 'pr' AND state = 'open') AS prs FROM hub_issues WHERE repo_id = ?", [repo.id]);
    const collabs = access.admin ? await q('SELECT u.login FROM hub_collaborators c JOIN hub_users u ON u.id = c.user_id WHERE c.repo_id = ?', [repo.id]) : [];
    return {
      repo: {
        owner: repo.owner_login, name: repo.name, description: repo.description, private: !!repo.private, default_branch: repo.default_branch,
        deploy: site ? { site_id: site.id, host: site.host, branch: repo.deploy_branch || repo.default_branch } : null, empty: !refs.length,
      },
      access,
      branches: refs.filter((r) => r.ref.startsWith('refs/heads/')).map((r) => ({ name: r.ref.slice(11), oid: r.oid })),
      tags: refs.filter((r) => r.ref.startsWith('refs/tags/')).map((r) => ({ name: r.ref.slice(10), oid: r.oid })),
      clone: { balnet: `https://vlodhub.bln/${repo.owner_login}/${repo.name}.git`, internet: `${req.protocol}://${host}/api/hub/git/${repo.owner_login}/${repo.name}.git` },
      open: { issues: Number(counts.issues || 0), prs: Number(counts.prs || 0) },
      deploys: deploys.map((d) => ({ id: d.id, host: d.host, commit: d.commit_oid, status: d.status, message: d.message, at: d.created_at })),
      collaborators: collabs.map((c) => c.login),
    };
  });
```

### PATCH `/api/hub/repos/:owner/:name`

Исходник: `api/src/routes/hub.js:125`.

```js
  app.patch('/repos/:owner/:name', auth, async (req) => {
    const { repo, gitdir } = await ctx(req, 'admin');
    const b = req.body || {};
    const set = {};
    if (b.description !== undefined) set.description = String(b.description).slice(0, 300) || null;
    if (b.private !== undefined) set.private = b.private ? 1 : 0;
    if (b.default_branch !== undefined) {
      need(BRANCH_RE.test(b.default_branch), 'Неверное имя ветки');
      await resolveCommit(gitdir, b.default_branch).catch(() => { throw bad('no_branch', 'Такой ветки нет'); });
      set.default_branch = b.default_branch;
      await fs.promises.writeFile(`${gitdir}/HEAD`, `ref: refs/heads/${b.default_branch}\n`);
    }
    if (b.deploy_site_id !== undefined) {
      if (b.deploy_site_id) {
        const targets = await deployTargets(req.gov.id);
        need(targets.some((t) => t.id === Number(b.deploy_site_id)), 'Выкладывать можно только на свои сайты хостинга');
        set.deploy_site_id = Number(b.deploy_site_id);
      } else set.deploy_site_id = null;
    }
    if (b.deploy_branch !== undefined) { need(!b.deploy_branch || BRANCH_RE.test(b.deploy_branch), 'Неверное имя ветки'); set.deploy_branch = b.deploy_branch || null; }
    const keys = Object.keys(set);
    if (keys.length) await q(`UPDATE hub_repos SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => set[k]), repo.id]);
    return { ok: true };
  });
```

### DELETE `/api/hub/repos/:owner/:name`

Исходник: `api/src/routes/hub.js:150`.

```js
  app.delete('/repos/:owner/:name', auth, async (req) => {
    const { repo } = await ctx(req, 'admin');
    await deleteRepo(repo);
    return { ok: true };
  });
```

### GET `/api/hub/deploy-targets`

Исходник: `api/src/routes/hub.js:156`.

```js
  app.get('/deploy-targets', auth, async (req) => ({ sites: await deployTargets(req.gov.id) }));
```

### POST `/api/hub/repos/:owner/:name/deploy`

Исходник: `api/src/routes/hub.js:158`.

```js
  app.post('/repos/:owner/:name/deploy', auth, async (req) => {
    const { repo, gitdir } = await ctx(req, 'admin');
    need(repo.deploy_site_id, 'Не выбран сайт для деплоя');
    return deploy(repo, await resolveCommit(gitdir, repo.deploy_branch || repo.default_branch));
  });
```

### POST `/api/hub/repos/:owner/:name/collaborators`

Исходник: `api/src/routes/hub.js:164`.

```js
  app.post('/repos/:owner/:name/collaborators', auth, async (req) => {
    const { repo } = await ctx(req, 'admin');
    const u = await one('SELECT id FROM hub_users WHERE login = ?', [String(req.body?.login || '').toLowerCase()]);
    if (!u) throw notFound('Пользователь ВлодХаба не найден');
    need(u.id !== repo.owner_id, 'Это владелец');
    await q('INSERT IGNORE INTO hub_collaborators (repo_id, user_id) VALUES (?, ?)', [repo.id, u.id]);
    return { ok: true };
  });
```

### DELETE `/api/hub/repos/:owner/:name/collaborators/:login`

Исходник: `api/src/routes/hub.js:172`.

```js
  app.delete('/repos/:owner/:name/collaborators/:login', auth, async (req) => {
    const { repo } = await ctx(req, 'admin');
    await q('DELETE c FROM hub_collaborators c JOIN hub_users u ON u.id = c.user_id WHERE c.repo_id = ? AND u.login = ?', [repo.id, req.params.login]);
    return { ok: true };
  });

  // ——— Файлы и коммиты ———
```

### GET `/api/hub/repos/:owner/:name/tree`

Исходник: `api/src/routes/hub.js:179`.

```js
  app.get('/repos/:owner/:name/tree', async (req) => {
    const { repo, gitdir } = await ctx(req);
    let oid;
    try { oid = await resolveCommit(gitdir, req.query.ref || repo.default_branch); } catch { return { empty: true }; }
    const r = await readPath(gitdir, oid, String(req.query.path || ''));
    if (!r) throw notFound('Нет такого пути');
    const rest = { ...r };
    delete rest.buf;
    const last = (await commits(gitdir, oid, 1))[0];
    return { commit: oid, last, ...rest, content: rest.content && rest.content.length > 500_000 ? null : rest.content };
  });
```

### GET `/api/hub/repos/:owner/:name/commits`

Исходник: `api/src/routes/hub.js:191`.

```js
  app.get('/repos/:owner/:name/commits', async (req) => {
    const { repo, gitdir } = await ctx(req);
    try { return { commits: await commits(gitdir, req.query.ref || repo.default_branch, Math.min(200, Number(req.query.limit) || 50)) }; } catch { return { commits: [] }; }
  });
```

### GET `/api/hub/repos/:owner/:name/commit/:oid`

Исходник: `api/src/routes/hub.js:196`.

```js
  app.get('/repos/:owner/:name/commit/:oid', async (req) => {
    const { gitdir } = await ctx(req);
    const oid = String(req.params.oid);
    need(/^[0-9a-f]{40}$/.test(oid), 'Неверный коммит');
    const c = await git.readCommit({ fs, gitdir, oid }).catch(() => null);
    if (!c) throw notFound('Коммит не найден');
    const files = await diffFiles(gitdir, c.commit.parent[0] || null, oid);
    return { oid, message: c.commit.message, author: c.commit.author.name, at: c.commit.author.timestamp * 1000, parents: c.commit.parent, files };
  });

  /** Правка файла в браузере — коммит в ветку. */
```

### PUT `/api/hub/repos/:owner/:name/file`

Исходник: `api/src/routes/hub.js:207`.

```js
  app.put('/repos/:owner/:name/file', auth, async (req) => {
    const { repo, gitdir, user } = await ctx(req, 'write');
    const b = req.body || {};
    const branch = String(b.branch || repo.default_branch);
    need(BRANCH_RE.test(branch), 'Неверное имя ветки');
    const filepath = String(b.path || '').replace(/^\/+/, '');
    need(filepath && !filepath.split('/').some((p) => !p || p === '.' || p === '..' || p === '.git'), 'Неверный путь файла');
    need(String(b.content ?? '').length <= 1024 * 1024, 'Файл больше 1 МБ — загрузите его через git push');
    const oid = await commitFile(gitdir, { branch, filepath, content: b.content ?? '', message: str(b.message || `Обновить ${filepath}`, 'сообщение', { max: 500 }), author: { name: user.name || user.login, email: `${user.login}@vlodhub.bln` } });
    await q('UPDATE hub_repos SET pushed_at = NOW(3) WHERE id = ?', [repo.id]);
    if (repo.deploy_site_id && branch === (repo.deploy_branch || repo.default_branch)) await deploy(repo, oid);
    return { commit: oid };
  });
```

### POST `/api/hub/repos/:owner/:name/branches`

Исходник: `api/src/routes/hub.js:221`.

```js
  app.post('/repos/:owner/:name/branches', auth, async (req) => {
    const { repo, gitdir } = await ctx(req, 'write');
    const name = String(req.body?.name || '');
    need(BRANCH_RE.test(name) && !name.includes('..'), 'Имя ветки: латиница, цифры, «/», «-», «_»');
    const from = await resolveCommit(gitdir, req.body?.from || repo.default_branch);
    await git.writeRef({ fs, gitdir, ref: `refs/heads/${name}`, value: from, force: false }).catch(() => { throw bad('exists', 'Такая ветка уже есть'); });
    return { ok: true };
  });

  // ——— Задачи и запросы на слияние ———
```

### GET `/api/hub/repos/:owner/:name/issues`

Исходник: `api/src/routes/hub.js:231`.

```js
  app.get('/repos/:owner/:name/issues', async (req) => {
    const { repo } = await ctx(req);
    const kind = req.query.kind === 'pr' ? 'pr' : 'issue';
    const state = ['open', 'closed', 'merged', 'all'].includes(req.query.state) ? req.query.state : 'open';
    const rows = await q(`SELECT * FROM hub_issues WHERE repo_id = ? AND kind = ? ${state === 'all' ? '' : state === 'closed' ? "AND state IN ('closed','merged')" : 'AND state = ?'} ORDER BY number DESC LIMIT 200`, [repo.id, kind, ...(state === 'open' || state === 'merged' ? [state] : [])]);
    const users = await loginsOf(rows.map((r) => r.author_id));
    return { issues: rows.map((r) => issueView(r, users)) };
  });
```

### POST `/api/hub/repos/:owner/:name/issues`

Исходник: `api/src/routes/hub.js:240`.

```js
  app.post('/repos/:owner/:name/issues', auth, async (req) => {
    const u = await me(req);
    const { repo, gitdir, access } = await ctx(req, 'read');
    const b = req.body || {};
    const kind = b.kind === 'pr' ? 'pr' : 'issue';
    const title = str(b.title, 'заголовок', { max: 200 });
    let head = null;
    let base = null;
    if (kind === 'pr') {
      need(access.write, 'Запрос на слияние создают участники репозитория (ветки — в этом репозитории)');
      head = String(b.head || '');
      base = String(b.base || repo.default_branch);
      need(head !== base, 'Выберите разные ветки');
      await resolveCommit(gitdir, head).catch(() => { throw bad('no_branch', `Нет ветки ${head}`); });
      await resolveCommit(gitdir, base).catch(() => { throw bad('no_branch', `Нет ветки ${base}`); });
    }
    const n = await one('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM hub_issues WHERE repo_id = ?', [repo.id]);
    await q('INSERT INTO hub_issues (repo_id, number, kind, title, body, author_id, head, base) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [repo.id, n.n, kind, title, String(b.body || '').slice(0, 20000) || null, u.id, head, base]);
    return { number: Number(n.n) };
  });

  const issueOf = async (repo, num) => {
    const i = await one('SELECT * FROM hub_issues WHERE repo_id = ? AND number = ?', [repo.id, int(num, 'номер')]);
    if (!i) throw notFound('Не найдено');
    return i;
  };
```

### GET `/api/hub/repos/:owner/:name/issues/:num`

Исходник: `api/src/routes/hub.js:267`.

```js
  app.get('/repos/:owner/:name/issues/:num', async (req) => {
    const { repo, gitdir, access } = await ctx(req);
    const i = await issueOf(repo, req.params.num);
    const comments = await q('SELECT * FROM hub_comments WHERE issue_id = ? ORDER BY id', [i.id]);
    const users = await loginsOf([i.author_id, ...comments.map((c) => c.author_id)]);
    const out = { issue: issueView(i, users), comments: comments.map((c) => ({ id: c.id, author: users.get(c.author_id), body: c.body, at: c.created_at })), access };
    if (i.kind === 'pr' && i.state === 'open') {
      try {
        const h = await resolveCommit(gitdir, i.head);
        const b = await resolveCommit(gitdir, i.base);
        const mb = await mergeBase(gitdir, h, b);
        const list = await commits(gitdir, h, 100);
        const cut = mb ? list.findIndex((c) => c.oid === mb) : -1;
        out.pr = { files: await diffFiles(gitdir, mb, h), commits: (cut >= 0 ? list.slice(0, cut) : list).slice(0, 50), up_to_date: mb === h, fast_forward: mb === b };
      } catch { out.pr = { error: 'Ветка удалена' }; }
    }
    return out;
  });
```

### POST `/api/hub/repos/:owner/:name/issues/:num/comments`

Исходник: `api/src/routes/hub.js:286`.

```js
  app.post('/repos/:owner/:name/issues/:num/comments', auth, async (req) => {
    const u = await me(req);
    const { repo } = await ctx(req);
    const i = await issueOf(repo, req.params.num);
    await q('INSERT INTO hub_comments (issue_id, author_id, body) VALUES (?, ?, ?)', [i.id, u.id, str(req.body?.body, 'комментарий', { max: 20000 })]);
    await q('UPDATE hub_issues SET updated_at = NOW(3) WHERE id = ?', [i.id]);
    return { ok: true };
  });
```

### PATCH `/api/hub/repos/:owner/:name/issues/:num`

Исходник: `api/src/routes/hub.js:295`.

```js
  app.patch('/repos/:owner/:name/issues/:num', auth, async (req) => {
    const u = await me(req);
    const { repo, access } = await ctx(req);
    const i = await issueOf(repo, req.params.num);
    need(access.write || i.author_id === u.id, 'Закрыть может автор или участник репозитория');
    need(i.state !== 'merged', 'Уже слито');
    const state = req.body?.state === 'open' ? 'open' : 'closed';
    await q('UPDATE hub_issues SET state = ?, updated_at = NOW(3) WHERE id = ?', [state, i.id]);
    return { ok: true };
  });
```

### POST `/api/hub/repos/:owner/:name/issues/:num/merge`

Исходник: `api/src/routes/hub.js:306`.

```js
  app.post('/repos/:owner/:name/issues/:num/merge', auth, async (req) => {
    const { repo, gitdir, user } = await ctx(req, 'write');
    const i = await issueOf(repo, req.params.num);
    need(i.kind === 'pr' && i.state === 'open', 'Сливать можно только открытый запрос на слияние');
    let r;
    try {
      r = await mergeBranches(gitdir, { base: i.base, head: i.head, author: { name: user.name || user.login, email: `${user.login}@vlodhub.bln`, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 }, message: `Слияние запроса #${i.number} из ${i.head}\n\n${i.title}` });
    } catch (e) {
      throw bad('conflict', e.code === 'MergeConflictError' || /conflict/i.test(e.message) ? `Конфликт слияния в файлах: ${(e.data?.filepaths || []).join(', ') || 'см. ветки'}. Слейте ${i.base} в ${i.head} локально и отправьте push.` : `Не удалось слить: ${e.message}`);
    }
    const oid = r.oid || (await resolveCommit(gitdir, i.base));
    await q("UPDATE hub_issues SET state = 'merged', merged_oid = ?, updated_at = NOW(3) WHERE id = ?", [oid, i.id]);
    await q('UPDATE hub_repos SET pushed_at = NOW(3) WHERE id = ?', [repo.id]);
    if (repo.deploy_site_id && i.base === (repo.deploy_branch || repo.default_branch)) await deploy(repo, oid);
    return { ok: true, commit: oid, fast_forward: !!r.fastForward };
  });
}
```


## mail.js — `api/src/routes/mail.js`

### GET `/api/mail/me`

Исходник: `api/src/routes/mail.js:29`.

```js
  app.get('/me', async (req) => {
    const s = await session(req, 'gov').catch(() => null);
    if (!s) return { gov: null, account: null };
    const a = await accountOf(s.id);
    return {
      gov: { id: s.id, name: s.user.display_name },
      account: a ? { login: a.login, address: `${a.login}@${MAIL_DOMAIN}`, name: a.name, signature: a.signature, notify_email: !!a.notify_email, spam_threshold: a.spam_threshold, status: a.status } : null,
      addresses: a ? (await addressesOf(a.id)).map((x) => x.address) : [],
    };
  });
```

### POST `/api/mail/me`

Исходник: `api/src/routes/mail.js:39`.

```js
  app.post('/me', auth, async (req) => {
    const a = await createAccount(req.gov.id, req.body?.login, req.body?.name);
    return { login: a.login, address: `${a.login}@${MAIL_DOMAIN}` };
  });
```

### PATCH `/api/mail/me`

Исходник: `api/src/routes/mail.js:43`.

```js
  app.patch('/me', auth, async (req) => {
    const a = await me(req);
    const b = req.body || {};
    const set = [];
    const v = [];
    if (b.name !== undefined) { set.push('name = ?'); v.push(String(b.name || '').slice(0, 80) || null); }
    if (b.signature !== undefined) { set.push('signature = ?'); v.push(String(b.signature || '').slice(0, 500) || null); }
    if (b.notify_email !== undefined) { set.push('notify_email = ?'); v.push(b.notify_email ? 1 : 0); }
    if (b.spam_threshold !== undefined) { set.push('spam_threshold = ?'); v.push(int(b.spam_threshold, 'Порог', { min: 10, max: 200 })); }
    if (set.length) await q(`UPDATE mail_accounts SET ${set.join(', ')} WHERE id = ?`, [...v, a.id]);
    return { ok: true };
  });

  // ——— Папки и письма ———
```

### GET `/api/mail/folders`

Исходник: `api/src/routes/mail.js:57`.

```js
  app.get('/folders', auth, async (req) => {
    const a = await me(req);
    const rows = await q('SELECT folder, COUNT(*) AS total, SUM(seen = 0) AS unread FROM mail_messages WHERE account_id = ? GROUP BY folder', [a.id]);
    const out = Object.fromEntries(FOLDERS.map((f) => [f, { total: 0, unread: 0 }]));
    for (const r of rows) out[r.folder] = { total: Number(r.total), unread: Number(r.unread || 0) };
    const starred = await one('SELECT COUNT(*) AS n FROM mail_messages WHERE account_id = ? AND starred = 1', [a.id]);
    return { folders: out, starred: Number(starred.n) };
  });
```

### GET `/api/mail/messages`

Исходник: `api/src/routes/mail.js:66`.

```js
  app.get('/messages', auth, async (req) => {
    const a = await me(req);
    const folder = String(req.query.folder || 'inbox');
    const where = ['account_id = ?'];
    const v = [a.id];
    if (folder === 'starred') where.push('starred = 1');
    else { need(FOLDERS.includes(folder), 'Неизвестная папка'); where.push('folder = ?'); v.push(folder); }
    if (req.query.q) {
      const s = `%${String(req.query.q).slice(0, 100).replace(/[%_]/g, '\\$&')}%`;
      where.push('(subject LIKE ? OR from_addr LIKE ? OR from_name LIKE ? OR body_text LIKE ?)');
      v.push(s, s, s, s);
    }
    if (req.query.before) { where.push('id < ?'); v.push(int(req.query.before, 'before')); }
    const rows = await q(`SELECT id, folder, from_addr, from_name, to_addrs, subject, snippet, seen, starred, spam_score, created_at, game_time, auth FROM mail_messages WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 50`, v);
    return { messages: rows.map(listView) };
  });
```

### GET `/api/mail/messages/:id`

Исходник: `api/src/routes/mail.js:83`.

```js
  app.get('/messages/:id', auth, async (req) => {
    const a = await me(req);
    const m = await ownMessage(a, req.params.id);
    if (!m.seen) await q('UPDATE mail_messages SET seen = 1 WHERE id = ?', [m.id]);
    return { message: fullView({ ...m, seen: 1 }) };
  });
```

### GET `/api/mail/messages/:id/raw`

Исходник: `api/src/routes/mail.js:90`.

```js
  app.get('/messages/:id/raw', auth, async (req, reply) => {
    const a = await me(req);
    const m = await ownMessage(a, req.params.id);
    reply.header('content-type', 'text/plain; charset=utf-8');
    return m.raw || '';
  });
```

### PATCH `/api/mail/messages/:id`

Исходник: `api/src/routes/mail.js:97`.

```js
  app.patch('/messages/:id', auth, async (req) => {
    const a = await me(req);
    const m = await ownMessage(a, req.params.id);
    const b = req.body || {};
    if (b.seen !== undefined) await q('UPDATE mail_messages SET seen = ? WHERE id = ?', [b.seen ? 1 : 0, m.id]);
    if (b.starred !== undefined) await q('UPDATE mail_messages SET starred = ? WHERE id = ?', [b.starred ? 1 : 0, m.id]);
    if (b.folder !== undefined) {
      need(['inbox', 'trash', 'spam'].includes(b.folder), 'Переместить можно во «Входящие», «Спам» или «Корзину»');
      await q('UPDATE mail_messages SET folder = ? WHERE id = ?', [b.folder, m.id]);
    }
    return { ok: true };
  });

  /** «Это спам» / «Не спам»: письмо переезжает и обучает фильтр ящика. */
```

### POST `/api/mail/messages/:id/spam`

Исходник: `api/src/routes/mail.js:111`.

```js
  app.post('/messages/:id/spam', auth, async (req) => {
    const a = await me(req);
    const m = await ownMessage(a, req.params.id);
    const spam = !!req.body?.spam;
    await train(a.id, m, spam);
    await q('UPDATE mail_messages SET folder = ? WHERE id = ?', [spam ? 'spam' : 'inbox', m.id]);
    if (!spam) await q('INSERT IGNORE INTO mail_contacts (account_id, address, sent) VALUES (?, ?, 0)', [a.id, m.from_addr]);
    return { ok: true, folder: spam ? 'spam' : 'inbox' };
  });
```

### DELETE `/api/mail/messages/:id`

Исходник: `api/src/routes/mail.js:121`.

```js
  app.delete('/messages/:id', auth, async (req) => {
    const a = await me(req);
    const m = await ownMessage(a, req.params.id);
    if (m.folder === 'trash') await q('DELETE FROM mail_messages WHERE id = ?', [m.id]);
    else await q("UPDATE mail_messages SET folder = 'trash' WHERE id = ?", [m.id]);
    return { ok: true, deleted: m.folder === 'trash' };
  });

  /** Жалоба админу: копия письма уходит в очередь жалоб (админ видит письмо только так). */
```

### POST `/api/mail/messages/:id/report`

Исходник: `api/src/routes/mail.js:130`.

```js
  app.post('/messages/:id/report', auth, async (req) => {
    const a = await me(req);
    const m = await ownMessage(a, req.params.id);
    await q('INSERT INTO mail_reports (account_id, message_id, reason, from_addr, subject, raw) VALUES (?, ?, ?, ?, ?, ?)', [a.id, m.id, String(req.body?.reason || '').slice(0, 500) || null, m.from_addr, m.subject, m.raw]);
    return { ok: true };
  });
```

### POST `/api/mail/send`

Исходник: `api/src/routes/mail.js:137`.

```js
  app.post('/send', { ...auth, config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (req) => {
    const a = await me(req);
    return sendFromAccount(a, req.body || {});
  });
```

### GET `/api/mail/contacts`

Исходник: `api/src/routes/mail.js:142`.

```js
  app.get('/contacts', auth, async (req) => {
    const a = await me(req);
    const s = `%${String(req.query.q || '').slice(0, 60)}%`;
    return { contacts: await q('SELECT address, name FROM mail_contacts WHERE account_id = ? AND address LIKE ? ORDER BY sent DESC, last_at DESC LIMIT 10', [a.id, s]) };
  });

  // ——— Почта для своего домена ———
```

### GET `/api/mail/domains`

Исходник: `api/src/routes/mail.js:149`.

```js
  app.get('/domains', auth, async (req) => {
    const rows = await q('SELECT * FROM mail_domains WHERE owner_gov_user_id = ? ORDER BY id', [req.gov.id]);
    const out = [];
    for (const d of rows) {
      const addrs = await q('SELECT x.address, m.login FROM mail_addresses x JOIN mail_accounts m ON m.id = x.account_id WHERE x.domain_id = ? ORDER BY x.address', [d.id]);
      out.push(domainView(d, addrs.map((x) => ({ address: x.address, owner: `${x.login}@${MAIL_DOMAIN}` }))));
    }
    return { domains: out };
  });
```

### POST `/api/mail/domains`

Исходник: `api/src/routes/mail.js:158`.

```js
  app.post('/domains', auth, async (req) => {
    await me(req);
    const d = await addDomain(req.gov.id, req.body?.name);
    await audit(null, actorOf(req.gov), 'mail.domain_add', 'mail_domain', d.id, { name: d.name });
    return { domain: domainView(d, []) };
  });
```

### POST `/api/mail/domains/:id/check`

Исходник: `api/src/routes/mail.js:164`.

```js
  app.post('/domains/:id/check', auth, async (req) => {
    const d = await ownMailDomain(req.gov.id, int(req.params.id, 'id'));
    return { checks: await checkDomain(d) };
  });
```

### POST `/api/mail/domains/:id/auto`

Исходник: `api/src/routes/mail.js:168`.

```js
  app.post('/domains/:id/auto', auth, async (req) => {
    const d = await ownMailDomain(req.gov.id, int(req.params.id, 'id'));
    await autoRecords(d);
    return { checks: await checkDomain(d) };
  });
```

### POST `/api/mail/domains/:id/addresses`

Исходник: `api/src/routes/mail.js:173`.

```js
  app.post('/domains/:id/addresses', auth, async (req) => {
    const address = await addAddress(req.gov.id, int(req.params.id, 'id'), req.body?.local, req.body?.for || null);
    return { address };
  });
```

### DELETE `/api/mail/domains/:id/addresses/:address`

Исходник: `api/src/routes/mail.js:177`.

```js
  app.delete('/domains/:id/addresses/:address', auth, async (req) => {
    const d = await ownMailDomain(req.gov.id, int(req.params.id, 'id'));
    await q('DELETE FROM mail_addresses WHERE domain_id = ? AND address = ?', [d.id, String(req.params.address).toLowerCase()]);
    return { ok: true };
  });
```

### PATCH `/api/mail/domains/:id`

Исходник: `api/src/routes/mail.js:182`.

```js
  app.patch('/domains/:id', auth, async (req) => {
    const d = await ownMailDomain(req.gov.id, int(req.params.id, 'id'));
    if (req.body?.catch_all !== undefined) {
      const a = req.body.catch_all ? await me(req) : null;
      await q('UPDATE mail_domains SET catch_all_account_id = ? WHERE id = ?', [a?.id || null, d.id]);
    }
    return { ok: true };
  });
```

### DELETE `/api/mail/domains/:id`

Исходник: `api/src/routes/mail.js:190`.

```js
  app.delete('/domains/:id', auth, async (req) => {
    const d = await ownMailDomain(req.gov.id, int(req.params.id, 'id'));
    await q('DELETE FROM mail_addresses WHERE domain_id = ?', [d.id]);
    await q('DELETE FROM mail_domains WHERE id = ?', [d.id]);
    await audit(null, actorOf(req.gov), 'mail.domain_remove', 'mail_domain', d.id, { name: d.name });
    return { ok: true };
  });

  // ——— Аккаунт ВлодБраузера ———
  /** Подключить браузер: нужен вход во ВлодУслуги и ящик. Токен живёт, пока устройство не удалят. */
```

### POST `/api/mail/sync/devices`

Исходник: `api/src/routes/mail.js:200`.

```js
  app.post('/sync/devices', { ...auth, config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const a = await me(req);
    const token = await createDevice(a.id, req.body?.name);
    const key = await keyOf(a.id);
    return { token, account: { login: a.login, address: `${a.login}@${MAIL_DOMAIN}`, name: a.name }, key: key ? { salt: key.salt, iterations: key.iterations, check: key.check_blob } : null };
  });
```

### GET `/api/mail/sync/devices`

Исходник: `api/src/routes/mail.js:206`.

```js
  app.get('/sync/devices', auth, async (req) => {
    const a = await me(req);
    const key = await keyOf(a.id);
    const data = await q('SELECT collection, rev, updated_at, LENGTH(blob_data) AS bytes FROM browser_sync_data WHERE account_id = ?', [a.id]);
    return { devices: await q('SELECT id, name, last_seen, created_at FROM browser_devices WHERE account_id = ? ORDER BY id DESC', [a.id]), has_key: !!key, data };
  });
```

### DELETE `/api/mail/sync/devices/:id`

Исходник: `api/src/routes/mail.js:212`.

```js
  app.delete('/sync/devices/:id', auth, async (req) => {
    const a = await me(req);
    await q('DELETE FROM browser_devices WHERE id = ? AND account_id = ?', [int(req.params.id, 'id'), a.id]);
    return { ok: true };
  });
```

### POST `/api/mail/sync/reset`

Исходник: `api/src/routes/mail.js:217`.

```js
  app.post('/sync/reset', auth, async (req) => {
    const a = await me(req);
    await wipe(a.id);
    await audit(null, actorOf(req.gov), 'browser.sync_reset', 'mail_account', a.id);
    return { ok: true };
  });

  // Дальше — запросы самого браузера: токен устройства в теле (cookie для синхронизации не нужны).
  const dev = (req) => deviceOf(req.body?.token);
```

### POST `/api/mail/sync/status`

Исходник: `api/src/routes/mail.js:226`.

```js
  app.post('/sync/status', async (req) => {
    const d = await dev(req);
    const key = await keyOf(d.account_id);
    return { account: { login: d.login, address: `${d.login}@${MAIL_DOMAIN}`, name: d.account_name }, device: { id: d.id, name: d.name }, key: key ? { salt: key.salt, iterations: key.iterations, check: key.check_blob } : null };
  });
```

### POST `/api/mail/sync/key`

Исходник: `api/src/routes/mail.js:231`.

```js
  app.post('/sync/key', async (req) => {
    const d = await dev(req);
    await setKey(d.account_id, req.body || {});
    return { ok: true };
  });
```

### POST `/api/mail/sync/pull`

Исходник: `api/src/routes/mail.js:236`.

```js
  app.post('/sync/pull', async (req) => {
    const d = await dev(req);
    return { collections: await pull(d.account_id), names: COLLECTIONS };
  });
```

### POST `/api/mail/sync/push`

Исходник: `api/src/routes/mail.js:240`.

```js
  app.post('/sync/push', { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } }, async (req) => {
    const d = await dev(req);
    need(await keyOf(d.account_id), 'Сначала задайте кодовую фразу синхронизации');
    const rev = await push(d.account_id, str(req.body?.collection, 'collection', { max: 20 }), req.body?.base_rev, req.body?.blob);
    return { rev };
  });
```

### POST `/api/mail/sync/signout`

Исходник: `api/src/routes/mail.js:246`.

```js
  app.post('/sync/signout', async (req) => {
    const d = await dev(req);
    await q('DELETE FROM browser_devices WHERE id = ?', [d.id]);
    return { ok: true };
  });
}
```


## news.js — `api/src/routes/news.js`

### GET `/api/news/meta`

Исходник: `api/src/routes/news.js:39`.

```js
  app.get('/meta', async () => ({ categories: CATEGORIES }));
```

### GET `/api/news/feed`

Исходник: `api/src/routes/news.js:40`.

```js
  app.get('/feed', async (req) => {
    const x = req.query || {};
    const outlet = x.outlet ? await outletBySlug(x.outlet) : null;
    return feed({ outlet, cat: x.category || null, text: x.q ? String(x.q).slice(0, 100) : null, page: pageOf(x.page) });
  });
```

### GET `/api/news/articles/:id`

Исходник: `api/src/routes/news.js:45`.

```js
  app.get('/articles/:id', async (req) => {
    const a = await one(`${SELECT} WHERE a.id = ? AND o.status = 'active'`, [int(req.params.id, 'id', { min: 1 })]);
    if (!a) throw notFound('Статья не найдена');
    return { article: view(a) };
  });
```

### GET `/api/news/outlets`

Исходник: `api/src/routes/news.js:50`.

```js
  app.get('/outlets', async () => {
    const rows = await q("SELECT o.*, (SELECT COUNT(*) FROM news_articles a WHERE a.outlet_id = o.id) AS n FROM news_outlets o WHERE o.status = 'active' ORDER BY FIELD(o.kind, 'gov', 'economy', 'media'), o.title");
    return { outlets: rows.map((o) => outletView(o, { articles: Number(o.n) })) };
  });
```

### GET `/api/news/outlets/:slug`

Исходник: `api/src/routes/news.js:54`.

```js
  app.get('/outlets/:slug', async (req) => {
    const o = await outletBySlug(req.params.slug);
    if (o.status !== 'active') throw notFound('Редакция заблокирована');
    const s = await session(req, 'gov').catch(() => null);
    return { outlet: outletView(o, { mine: !!s && Number(o.owner_gov_id) === Number(s.id) }), ...(await feed({ outlet: o, page: pageOf(req.query?.page) })) };
  });

  // ——— Кабинет СМИ ———
```

### GET `/api/news/me`

Исходник: `api/src/routes/news.js:62`.

```js
  app.get('/me', async (req) => {
    const s = await session(req, 'gov').catch(() => null);
    if (!s) return { gov: null, outlets: [] };
    const rows = await q("SELECT * FROM news_outlets WHERE owner_gov_id = ? AND kind = 'media' ORDER BY id", [s.id]);
    return { gov: { id: s.id }, outlets: rows.map((o) => outletView(o)) };
  });
```

### POST `/api/news/outlets`

Исходник: `api/src/routes/news.js:68`.

```js
  app.post('/outlets', auth, async (req) => {
    const o = await createOutlet(req.gov.id, req.body || {});
    await audit(null, actorOf(req.gov), 'news.outlet', 'news_outlet', o.id, { slug: o.slug });
    return { outlet: outletView(o) };
  });
```

### PATCH `/api/news/outlets/:slug`

Исходник: `api/src/routes/news.js:73`.

```js
  app.patch('/outlets/:slug', auth, async (req) => {
    const o = await outletBySlug(req.params.slug);
    canEdit(o, req.gov.id);
    return { outlet: outletView(await updateOutlet(o, req.body || {})) };
  });
```

### POST `/api/news/outlets/:slug/fetch`

Исходник: `api/src/routes/news.js:78`.

```js
  app.post('/outlets/:slug/fetch', auth, async (req) => {
    const o = await outletBySlug(req.params.slug);
    canEdit(o, req.gov.id);
    return fetchFeed(o);
  });
```

### POST `/api/news/outlets/:slug/articles`

Исходник: `api/src/routes/news.js:83`.

```js
  app.post('/outlets/:slug/articles', auth, async (req) => {
    const o = await outletBySlug(req.params.slug);
    canEdit(o, req.gov.id);
    const a = await publish(o, { ...articleArgs(req.body || {}), author: req.body?.author ? str(req.body.author, 'автор', { max: 80 }) : o.title });
    return { article: { id: a.id } };
  });
```

### DELETE `/api/news/articles/:id`

Исходник: `api/src/routes/news.js:89`.

```js
  app.delete('/articles/:id', auth, async (req) => {
    const a = await one('SELECT a.id, o.* FROM news_articles a JOIN news_outlets o ON o.id = a.outlet_id WHERE a.id = ?', [int(req.params.id, 'id', { min: 1 })]);
    if (!a) throw notFound('Статья не найдена');
    canEdit(a, req.gov.id);
    await removeArticle(Number(req.params.id));
    return { ok: true };
  });
}
```


## push.js — `api/src/routes/push.js`

### GET `/api/push/key`

Исходник: `api/src/routes/push.js:23`.

```js
  app.get('/key', async () => ({ publicKey: (await vapidKeys()).publicKey }));
```

### GET `/api/push/devices`

Исходник: `api/src/routes/push.js:25`.

```js
  app.get('/devices', async (req) => {
    const s = await who(req);
    return { devices: await userDevices(s.kind, s.id) };
  });
```

### POST `/api/push/subscribe`

Исходник: `api/src/routes/push.js:30`.

```js
  app.post('/subscribe', limited(30), async (req) => {
    const s = await who(req);
    return subscribeUser(s.kind, s.id, req.body?.subscription, req.headers['user-agent']);
  });
```

### POST `/api/push/unsubscribe`

Исходник: `api/src/routes/push.js:35`.

```js
  app.post('/unsubscribe', async (req) => {
    const s = await who(req);
    if (req.body?.id) return removeUserDevice(s.kind, s.id, req.body.id);
    return unsubscribeUser(s.kind, s.id, req.body?.endpoint);
  });
```

### POST `/api/push/test`

Исходник: `api/src/routes/push.js:41`.

```js
  app.post('/test', limited(5), async (req) => {
    const s = await who(req);
    const sent = await pushToUser(s.kind, s.id, { title: 'Проверка push-уведомлений', body: 'Если вы это видите — push на этом устройстве работает', link: '#/', tag: 'push-test' });
    return { ok: true, sent };
  });
}

/** API ВлодБраузера (настоящий origin браузера, не песочница сайтов). */
```

### POST `/api/net/push/device`

Исходник: `api/src/routes/push.js:52`.

```js
  app.post('/device', limited(10), async (req) => createDevice(req.body?.label));
```

### POST `/api/net/push/device/web`

Исходник: `api/src/routes/push.js:53`.

```js
  app.post('/device/web', limited(20), async (req) => setDeviceWeb(await dev(req), req.body?.subscription || null));
```

### POST `/api/net/push/device/delete`

Исходник: `api/src/routes/push.js:54`.

```js
  app.post('/device/delete', async (req) => deleteDevice(await dev(req)));
```

### POST `/api/net/push/subs`

Исходник: `api/src/routes/push.js:55`.

```js
  app.post('/subs', async (req) => ({ subs: await deviceSubs(await dev(req)) }));
```

### POST `/api/net/push/subscribe`

Исходник: `api/src/routes/push.js:57`.

```js
  app.post('/subscribe', limited(60), async (req) => ({ subscription: await siteSubscribe(await dev(req), req.body?.origin, req.body?.applicationServerKey || null) }));
```

### POST `/api/net/push/subscription`

Исходник: `api/src/routes/push.js:58`.

```js
  app.post('/subscription', async (req) => ({ subscription: await siteSubscription(await dev(req), req.body?.origin) }));
```

### POST `/api/net/push/unsubscribe`

Исходник: `api/src/routes/push.js:59`.

```js
  app.post('/unsubscribe', async (req) => siteUnsubscribe(await dev(req), req.body?.origin));
```

### POST `/api/net/push/inbox`

Исходник: `api/src/routes/push.js:61`.

```js
  app.post('/inbox', limited(120), async (req) => ({ messages: await inbox(await dev(req), req.body?.after) }));
}
```


## pay.js — `api/src/routes/pay.js`

### GET `/api/pay/checkout/:id`

Исходник: `api/src/routes/pay.js:34`.

```js
  app.get('/checkout/:id', async (req) => {
    const info = await checkoutInfo(req.params.id);
    const s = await session(req, 'bank').catch(() => null);
    let payer = null;
    if (s && s.user.status === 'active') {
      const accounts = await q("SELECT * FROM accounts WHERE owner_kind = 'bank_user' AND owner_id = ? AND status = 'active' AND type IN ('current','savings','business','credit','child') ORDER BY is_primary DESC, id", [s.id]);
      payer = { name: s.user.full_name, verified: !!s.user.passport_verified, accounts: accounts.map(accountView) };
    }
    return { payment: info, payer };
  });
```

### POST `/api/pay/checkout/:id/card`

Исходник: `api/src/routes/pay.js:44`.

```js
  app.post('/checkout/:id/card', { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const b = req.body || {};
    const r = await payByCard(req.params.id, { number: b.number, exp: b.exp, pin: b.pin });
    return { ok: true, status: 'paid', redirect: r.redirect };
  });
```

### POST `/api/pay/checkout/:id/account`

Исходник: `api/src/routes/pay.js:49`.

```js
  app.post('/checkout/:id/account', { ...bank, config: { rateLimit: { max: 20, timeWindow: '1 minute' } } }, async (req) => {
    const r = await payByAccount(req.params.id, req.bank.user, int(req.body?.account_id, 'счёт'));
    return { ok: true, status: 'paid', redirect: r.redirect };
  });
```

### POST `/api/pay/checkout/:id/cancel`

Исходник: `api/src/routes/pay.js:53`.

```js
  app.post('/checkout/:id/cancel', async (req) => {
    const p = await tx((conn) => cancelPayment(conn, null, req.params.id, { byBuyer: true }));
    return { ok: true, redirect: returnTo(p, 'cancelled') };
  });

  // ——— Кабинет мерчанта ———
```

### GET `/api/pay/merchant-options`

Исходник: `api/src/routes/pay.js:59`.

```js
  app.get('/merchant-options', bank, async (req) => {
    const u = req.bank.user;
    const own = await q("SELECT * FROM accounts WHERE owner_kind = 'bank_user' AND owner_id = ? AND type = 'business' AND status <> 'closed'", [u.id]);
    const orgs = u.gov_user_id
      ? await q("SELECT a.*, o.name AS org_name FROM org_members m JOIN organizations o ON o.id = m.org_id AND o.status = 'active' JOIN accounts a ON a.id = o.account_id WHERE m.gov_user_id = ? AND m.role = 'director'", [u.gov_user_id])
      : [];
    const shops = await q("SELECT s.id, s.name, s.account_id FROM shops s LEFT JOIN pay_merchants m ON m.shop_id = s.id WHERE s.owner_id = ? AND s.status = 'active' AND m.id IS NULL", [u.id]);
    return {
      accounts: [...own.map((a) => ({ ...accountView(a), title: `${a.name} (ИП)` })), ...orgs.map((a) => ({ ...accountView(a), title: a.org_name }))],
      shops,
    };
  });
```

### GET `/api/pay/merchants`

Исходник: `api/src/routes/pay.js:71`.

```js
  app.get('/merchants', bank, async (req) => {
    const rows = await q('SELECT * FROM pay_merchants WHERE owner_bank_user_id = ? ORDER BY id', [req.bank.id]);
    return { merchants: await Promise.all(rows.map(async (m) => ({ ...(await merchantView(m)), stats: await merchantStats(m) }))) };
  });
```

### POST `/api/pay/merchants`

Исходник: `api/src/routes/pay.js:75`.

```js
  app.post('/merchants', bank, async (req) => {
    const r = await tx((conn) => createMerchant(conn, req.bank.user, req.body || {}));
    await audit(null, actorOf(req.bank), 'pay.merchant_create', 'pay_merchant', r.merchant.id, { name: r.merchant.name });
    return { merchant: await merchantView(r.merchant, { secret: true }), keys: r.keys };
  });
```

### GET `/api/pay/merchants/:id`

Исходник: `api/src/routes/pay.js:80`.

```js
  app.get('/merchants/:id', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    return { merchant: { ...(await merchantView(m, { secret: true })), stats: await merchantStats(m) } };
  });
```

### PATCH `/api/pay/merchants/:id`

Исходник: `api/src/routes/pay.js:84`.

```js
  app.patch('/merchants/:id', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const b = req.body || {};
    const set = [];
    const v = [];
    if (b.name !== undefined) { set.push('name = ?'); v.push(str(b.name, 'название', { min: 2, max: 80 })); }
    if (b.site_url !== undefined) { set.push('site_url = ?'); v.push(siteUrl(b.site_url, 'Сайт')); }
    if (b.webhook_url !== undefined) { set.push('webhook_url = ?'); v.push(siteUrl(b.webhook_url, 'Адрес вебхуков')); }
    if (b.courier_fee !== undefined) { set.push('courier_fee = ?'); v.push(int(b.courier_fee, 'стоимость доставки', { min: 0, max: 1e8 })); }
    if (b.delivery !== undefined) {
      const d = b.delivery || {};
      set.push('delivery = ?');
      v.push(JSON.stringify(Object.fromEntries(Object.keys(DELIVERY).map((k) => [k, !!d[k]]))));
    }
    if (set.length) await q(`UPDATE pay_merchants SET ${set.join(', ')} WHERE id = ?`, [...v, m.id]);
    return { merchant: await merchantView(await one('SELECT * FROM pay_merchants WHERE id = ?', [m.id]), { secret: true }) };
  });
```

### POST `/api/pay/merchants/:id/keys`

Исходник: `api/src/routes/pay.js:101`.

```js
  app.post('/merchants/:id/keys', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const keys = await tx((conn) => rotateKeys(conn, m.id));
    await audit(null, actorOf(req.bank), 'pay.keys_rotate', 'pay_merchant', m.id);
    return { keys };
  });
```

### POST `/api/pay/merchants/:id/webhook-secret`

Исходник: `api/src/routes/pay.js:107`.

```js
  app.post('/merchants/:id/webhook-secret', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const secret = `whsec_${randomToken(24)}`;
    await q('UPDATE pay_merchants SET webhook_secret = ? WHERE id = ?', [secret, m.id]);
    return { webhook_secret: secret };
  });
```

### POST `/api/pay/merchants/:id/webhook-test`

Исходник: `api/src/routes/pay.js:113`.

```js
  app.post('/merchants/:id/webhook-test', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    if (!m.webhook_url) throw bad('no_webhook', 'Сначала укажите адрес вебхуков');
    const pid = await tx((conn) => emitEvent(conn, m.id, 'ping', { object: 'ping', merchant: m.public_id, message: 'Проверка вебхука ВлодБанка' }));
    const ev = await one('SELECT id FROM pay_events WHERE public_id = ?', [pid]);
    const r = await deliverEvent(ev.id);
    return { event: eventView(await one('SELECT * FROM pay_events WHERE id = ?', [ev.id])), delivered: r?.status === 'delivered' };
  });
  // Ссылка на оплату из кабинета — без своего сайта (счёт другу, оплата в чате).
```

### POST `/api/pay/merchants/:id/payments`

Исходник: `api/src/routes/pay.js:122`.

```js
  app.post('/merchants/:id/payments', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const p = await tx((conn) => createPayment(conn, m, { ...(req.body || {}), items: null, metadata: null }));
    return { payment: paymentView(p) };
  });
```

### GET `/api/pay/merchants/:id/payments`

Исходник: `api/src/routes/pay.js:127`.

```js
  app.get('/merchants/:id/payments', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const rows = await q(
      'SELECT p.*, u.full_name AS payer_name FROM pay_payments p LEFT JOIN bank_users u ON u.id = p.payer_bank_user_id WHERE p.merchant_id = ? ORDER BY p.id DESC LIMIT 200',
      [m.id],
    );
    return { payments: rows.map((p) => ({ ...paymentView(p), payer_name: p.payer_name || null })) };
  });
```

### GET `/api/pay/merchants/:id/payments/:pid`

Исходник: `api/src/routes/pay.js:135`.

```js
  app.get('/merchants/:id/payments/:pid', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const p = await loadPayment(req.params.pid);
    if (p.merchant_id !== m.id) throw notFound('Платёж не найден');
    return { payment: { ...paymentView(p), refunds: await refundsOf(p.id) } };
  });
```

### POST `/api/pay/merchants/:id/payments/:pid/refund`

Исходник: `api/src/routes/pay.js:141`.

```js
  app.post('/merchants/:id/payments/:pid/refund', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const r = await tx((conn) => refundPayment(conn, m, { payment: req.params.pid, amount: req.body?.amount === '' ? undefined : req.body?.amount, reason: req.body?.reason }));
    return { refund: r.refund, payment: paymentView(r.payment) };
  });
```

### GET `/api/pay/merchants/:id/events`

Исходник: `api/src/routes/pay.js:146`.

```js
  app.get('/merchants/:id/events', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const rows = await q('SELECT * FROM pay_events WHERE merchant_id = ? ORDER BY id DESC LIMIT 100', [m.id]);
    return { events: rows.map(eventView) };
  });
```

### POST `/api/pay/merchants/:id/events/:eid/resend`

Исходник: `api/src/routes/pay.js:151`.

```js
  app.post('/merchants/:id/events/:eid/resend', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const e = await one('SELECT * FROM pay_events WHERE public_id = ? AND merchant_id = ?', [req.params.eid, m.id]);
    if (!e) throw notFound('Событие не найдено');
    await q("UPDATE pay_events SET status = 'pending', attempts = 0, next_try_at = NOW(3) WHERE id = ?", [e.id]);
    await deliverEvent(e.id);
    return { event: eventView(await one('SELECT * FROM pay_events WHERE id = ?', [e.id])) };
  });
```

### GET `/api/pay/merchants/:id/subscriptions`

Исходник: `api/src/routes/pay.js:159`.

```js
  app.get('/merchants/:id/subscriptions', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const rows = await q('SELECT s.*, u.full_name AS payer_name FROM pay_subscriptions s LEFT JOIN bank_users u ON u.id = s.payer_bank_user_id WHERE s.merchant_id = ? ORDER BY s.id DESC LIMIT 200', [m.id]);
    return { subscriptions: rows.map((s) => ({ ...subscriptionView(s), payer_name: s.payer_name || null })) };
  });
```

### POST `/api/pay/merchants/:id/subscriptions/:sid/cancel`

Исходник: `api/src/routes/pay.js:164`.

```js
  app.post('/merchants/:id/subscriptions/:sid/cancel', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const s = await one('SELECT * FROM pay_subscriptions WHERE public_id = ? AND merchant_id = ?', [req.params.sid, m.id]);
    if (!s) throw notFound('Подписка не найдена');
    return { subscription: subscriptionView(await tx((conn) => cancelSubscription(conn, s, { by: 'merchant' }))) };
  });
```

### GET `/api/pay/merchants/:id/orders`

Исходник: `api/src/routes/pay.js:170`.

```js
  app.get('/merchants/:id/orders', bank, async (req) => {
    const m = await ownMerchant(req.bank.id, req.params.id);
    const rows = await q('SELECT * FROM shop_orders WHERE merchant_id = ? ORDER BY id DESC LIMIT 200', [m.id]);
    return { orders: rows.map((o) => orderView(o, { shop: true })) };
  });

  // ——— Покупатель: покупки на сайтах, заказы, подписки ———
```

### GET `/api/pay/purchases`

Исходник: `api/src/routes/pay.js:177`.

```js
  app.get('/purchases', bank, async (req) => {
    const pays = await q(
      "SELECT p.*, m.name AS merchant_name, m.site_url FROM pay_payments p JOIN pay_merchants m ON m.id = p.merchant_id WHERE p.payer_bank_user_id = ? AND p.status IN ('paid','partially_refunded','refunded') ORDER BY p.id DESC LIMIT 200",
      [req.bank.id],
    );
    const orders = await q('SELECT o.*, s.name AS shop_name FROM shop_orders o JOIN shops s ON s.id = o.shop_id WHERE o.buyer_bank_user_id = ? ORDER BY o.id DESC LIMIT 100', [req.bank.id]);
    const subs = await q('SELECT s.*, m.name AS merchant_name FROM pay_subscriptions s JOIN pay_merchants m ON m.id = s.merchant_id WHERE s.payer_bank_user_id = ? ORDER BY s.id DESC', [req.bank.id]);
    return {
      payments: pays.map((p) => ({ ...paymentView(p), merchant: p.merchant_name, site_url: p.site_url })),
      orders: orders.map((o) => ({ ...orderView(o, { buyer: true }), shop: o.shop_name })),
      subscriptions: subs.map((s) => ({ ...subscriptionView(s), merchant: s.merchant_name })),
    };
  });
```

### POST `/api/pay/subscriptions/:id/cancel`

Исходник: `api/src/routes/pay.js:190`.

```js
  app.post('/subscriptions/:id/cancel', bank, async (req) => {
    const s = await one('SELECT * FROM pay_subscriptions WHERE public_id = ? AND payer_bank_user_id = ?', [req.params.id, req.bank.id]);
    if (!s) throw notFound('Подписка не найдена');
    return { subscription: subscriptionView(await tx((conn) => cancelSubscription(conn, s, { by: 'customer' }))) };
  });

  // ——— Курьеры БалНета ———
```

### GET `/api/pay/courier/jobs`

Исходник: `api/src/routes/pay.js:197`.

```js
  app.get('/courier/jobs', bank, async (req) => ({ jobs: await courierJobs(req.bank.id) }));
```

### POST `/api/pay/courier/jobs/:id/take`

Исходник: `api/src/routes/pay.js:198`.

```js
  app.post('/courier/jobs/:id/take', bank, async (req) => {
    requireVerified(req.bank.user);
    const o = await tx((conn) => takeJob(conn, req.bank.user, req.params.id));
    return { order: orderView(o) };
  });
```

### POST `/api/pay/courier/jobs/:id/drop`

Исходник: `api/src/routes/pay.js:203`.

```js
  app.post('/courier/jobs/:id/drop', bank, async (req) => ({ order: orderView(await tx((conn) => dropJob(conn, req.bank.user, req.params.id))) }));
```

### POST `/api/pay/courier/confirm`

Исходник: `api/src/routes/pay.js:204`.

```js
  app.post('/courier/confirm', bank, async (req) => {
    const r = await tx((conn) => confirmHandoff(conn, req.bank.user, req.body?.token));
    return { order: orderView(r.order), tx: r.tx };
  });
}

// ——— Касса: онлайн-заказы магазина ———
```

### GET `/api/pos/online-orders`

Исходник: `api/src/routes/pay.js:213`.

```js
  app.get('/online-orders', pos, async (req) => {
    const status = req.query?.status === 'all' ? null : ['paid', 'ready', 'delivering'];
    const rows = await q(`SELECT * FROM shop_orders WHERE shop_id = ? AND status <> 'pending'${status ? " AND status IN ('paid','ready','delivering')" : ''} ORDER BY id DESC LIMIT 200`, [req.pos.shopId]);
    const merchant = await one('SELECT id, public_id, name FROM pay_merchants WHERE shop_id = ?', [req.pos.shopId]);
    return { orders: rows.map((o) => orderView(o, { shop: true })), merchant };
  });
```

### POST `/api/pos/online-orders/:id/ready`

Исходник: `api/src/routes/pay.js:219`.

```js
  app.post('/online-orders/:id/ready', pos, async (req) => ({ order: orderView(await tx(async (conn) => markReady(conn, await shopOrder(conn, req.pos.shopId, req.params.id))), { shop: true }) }));
```

### POST `/api/pos/online-orders/:id/pickup`

Исходник: `api/src/routes/pay.js:220`.

```js
  app.post('/online-orders/:id/pickup', pos, async (req) => ({ order: orderView(await tx(async (conn) => pickup(conn, await shopOrder(conn, req.pos.shopId, req.params.id), req.body?.code)), { shop: true }) }));
```

### POST `/api/pos/online-orders/pickup`

Исходник: `api/src/routes/pay.js:221`.

```js
  app.post('/online-orders/pickup', pos, async (req) => {
    const code = String(req.body?.code || '').trim();
    if (!/^\d{6}$/.test(code)) throw bad('wrong_code', 'Код заказа — 6 цифр');
    const o = await one("SELECT id FROM shop_orders WHERE shop_id = ? AND pickup_code = ? AND status IN ('paid','ready')", [req.pos.shopId, code]);
    if (!o) throw notFound('Заказ с таким кодом не найден');
    return { order: orderView(await tx(async (conn) => pickup(conn, await shopOrder(conn, req.pos.shopId, o.id), code)), { shop: true }) };
  });
```

### POST `/api/pos/online-orders/:id/ship`

Исходник: `api/src/routes/pay.js:228`.

```js
  app.post('/online-orders/:id/ship', pos, async (req) => ({ order: orderView(await tx(async (conn) => shipPhysical(conn, await shopOrder(conn, req.pos.shopId, req.params.id), { delivered: !!req.body?.delivered })), { shop: true }) }));
}

// ——— Вход для сайтов: OAuth 2 через ВлодПочту и ВлодУслуги ———
```

### GET `/api/oauth/providers`

Исходник: `api/src/routes/pay.js:234`.

```js
  app.get('/providers', async () => ({ providers: PROVIDERS, scopes: SCOPE_TITLES }));
```

### GET `/api/oauth/:provider/authorize`

Исходник: `api/src/routes/pay.js:235`.

```js
  app.get('/:provider/authorize', gov, async (req) => authorizeInfo(providerOf(req.params.provider), req.gov.id, req.query || {}));
```

### POST `/api/oauth/:provider/authorize`

Исходник: `api/src/routes/pay.js:236`.

```js
  app.post('/:provider/authorize', gov, async (req) => {
    const b = req.body || {};
    return authorize(providerOf(req.params.provider), req.gov.id, b.params || {}, !!b.approve);
  });
```

### GET `/api/oauth/clients`

Исходник: `api/src/routes/pay.js:240`.

```js
  app.get('/clients', gov, async (req) => {
    const rows = await q('SELECT * FROM oauth_clients WHERE owner_gov_user_id = ? ORDER BY id', [req.gov.id]);
    return { clients: rows.map((c) => clientView(c)) };
  });
```

### POST `/api/oauth/clients`

Исходник: `api/src/routes/pay.js:244`.

```js
  app.post('/clients', gov, async (req) => ({ client: await createClient(req.gov.id, req.body || {}) }));
```

### PATCH `/api/oauth/clients/:id`

Исходник: `api/src/routes/pay.js:245`.

```js
  app.patch('/clients/:id', gov, async (req) => ({ client: await updateClient(await ownClient(req.gov.id, req.params.id), req.body || {}) }));
```

### POST `/api/oauth/clients/:id/secret`

Исходник: `api/src/routes/pay.js:246`.

```js
  app.post('/clients/:id/secret', gov, async (req) => ({ client: await rotateSecret(await ownClient(req.gov.id, req.params.id)) }));
```

### DELETE `/api/oauth/clients/:id`

Исходник: `api/src/routes/pay.js:247`.

```js
  app.delete('/clients/:id', gov, async (req) => {
    await deleteClient(await ownClient(req.gov.id, req.params.id));
    return { ok: true };
  });
```

### GET `/api/oauth/grants`

Исходник: `api/src/routes/pay.js:251`.

```js
  app.get('/grants', gov, async (req) => ({ grants: await grantsOf(req.gov.id) }));
```

### DELETE `/api/oauth/grants/:clientId`

Исходник: `api/src/routes/pay.js:252`.

```js
  app.delete('/grants/:clientId', gov, async (req) => {
    await revokeGrant(req.gov.id, req.params.clientId, String(req.query?.provider || 'mail'));
    return { ok: true };
  });
}

// ——— Админка: эквайринг, реальная доставка, приложения OAuth ———
```

## Специальные маршруты и дополнительные источники

Диспетчер эквайринга не использует обычный `app.get/post`: см. `api/src/lib/pay/api.js` и `web/src/pay/docs.jsx`. Шлюз также регистрирует wildcard `sub.route`: все GET/HEAD/POST/PUT/PATCH/DELETE/OPTIONS `/api/net/web/:ticket/*`; билет внутренний и получается в ходе навигации ВлодБраузера. WebSocket-маршруты и Git могут регистрироваться нестандартно: `api/src/routes/ws.js`, `api/src/routes/hub.js`, `api/src/lib/vhost/sockets.js`. Некоторые пути из этого приложения требуют специализированную сессию и не поддерживают пользовательский токен.

Проверяйте актуальность: `api/src/app.js` (префиксы), `api/src/lib/apitokens.js` (права), `api/src/lib/auth.js` (сессии), `api/test/` (примеры и проверки). Админские API намеренно не включены: они не являются API обычного игрока. Поскольку этот каталог содержит фрагменты кода, он не заменяет проверку ограничений в `lib` и интеграционные тесты на конкретной версии сервера.

## Приложение: `api/src/lib/pay/api.js`

Снимок исходного справочного кода и обработчиков; зависимости и точные проверки — в исходном репозитории.

```js
// API госсайтов для серверов сайтов БалНета (этап Н9). Запрос идёт по сети: DNS → подключение к 50.1.0.10 → TLS → сюда.
//  pay.bank.bln/api/v1/…  — эквайринг ВлодБанка (ключ sk_live_… или pk_live_… в Authorization: Bearer);
//  mail.bln/oauth/…, gosuslugi.gov.bln/oauth/… — обмен кода на токен и данные пользователя (OAuth 2).
import { q, one, tx } from '../../db.js';
import { HttpError } from '../errors.js';
import {
  merchantByKey, createPayment, loadPayment, paymentView, cancelPayment, refundPayment, refundsOf, createSubscription, subscriptionView,
  cancelSubscription, eventView, apiError, payError, merchantView,
} from './core.js';
import { catalog, createOrder, orderView, refundOrderPayment } from './orders.js';
import { oauthHttp } from './oauth.js';

function parseJson(headers, body) {
  const text = Buffer.isBuffer(body) ? body.toString('utf8') : String(body || '');
  if (!text.trim()) return {};
  const type = String(headers['content-type'] || '');
  if (type.includes('application/x-www-form-urlencoded')) return Object.fromEntries(new URLSearchParams(text));
  try {
    const v = JSON.parse(text);
    return v && typeof v === 'object' ? v : {};
  } catch {
    throw payError(400, 'invalid_json', 'Тело запроса — JSON');
  }
}

const out = (status, body, headers = {}) => ({ status, headers: { 'content-type': 'application/json; charset=utf-8', ...headers }, body: Buffer.from(JSON.stringify(body)) });

async function orderOut(o, conn) {
  const p = o.payment_id ? await one('SELECT * FROM pay_payments WHERE id = ?', [o.payment_id], conn) : null;
  return { ...orderView(o), payment: p ? paymentView(p) : null };
}

async function ownPayment(merchant, id) {
  const p = await loadPayment(id);
  if (p.merchant_id !== merchant.id) throw payError(404, 'payment_not_found', 'Платёж не найден');
  return p;
}

async function ownOrder(merchant, id, conn, lock = false) {
  const o = await one(`SELECT * FROM shop_orders WHERE public_id = ? AND merchant_id = ?${lock ? ' FOR UPDATE' : ''}`, [String(id), merchant.id], conn);
  if (!o) throw payError(404, 'order_not_found', 'Заказ не найден');
  return o;
}

async function ownSub(merchant, id, conn) {
  const s = await one('SELECT * FROM pay_subscriptions WHERE public_id = ? AND merchant_id = ?', [String(id), merchant.id], conn);
  if (!s) throw payError(404, 'subscription_not_found', 'Подписка не найдена');
  return s;
}

const limitOf = (search) => Math.min(Math.max(Number(new URLSearchParams(search).get('limit')) || 20, 1), 100);

/** Эквайринг: маршруты /api/v1. */
async function payApi({ method, path, headers, body }) {
  const [rawPath, search = ''] = path.split('?');
  const parts = rawPath.replace(/^\/api\/v1\/?/, '').split('/').filter(Boolean);
  const idem = headers['idempotency-key'] ? String(headers['idempotency-key']).slice(0, 80) : null;
  const [res, id, action] = parts;
  const route = `${method} ${res || ''}${id ? '/:id' : ''}${action ? `/${action}` : ''}`;

  if (route === 'GET products') {
    const m = await merchantByKey(headers.authorization, { secret: false });
    return out(200, await catalog(m));
  }
  const m = await merchantByKey(headers.authorization);
  const b = method === 'POST' ? parseJson(headers, body) : {};
  switch (route) {
    case 'GET me':
      return out(200, { object: 'merchant', ...(await merchantView(m)), id: m.public_id, keys: undefined, account: undefined });
    case 'POST payments': {
      const p = await tx((conn) => createPayment(conn, m, b, { idem }));
      return out(200, paymentView(p));
    }
    case 'GET payments': {
      const rows = await q('SELECT * FROM pay_payments WHERE merchant_id = ? ORDER BY id DESC LIMIT ?', [m.id, limitOf(search)]);
      return out(200, { object: 'list', data: rows.map(paymentView) });
    }
    case 'GET payments/:id': {
      const p = await ownPayment(m, id);
      return out(200, { ...paymentView(p), refunds: await refundsOf(p.id) });
    }
    case 'POST payments/:id/cancel':
      return out(200, paymentView(await tx((conn) => cancelPayment(conn, m, id))));
    case 'GET payments/:id/refunds':
      return out(200, { object: 'list', data: await refundsOf((await ownPayment(m, id)).id) });
    case 'POST refunds': {
      const r = await tx((conn) => refundPayment(conn, m, { payment: b.payment, amount: b.amount, reason: b.reason }));
      return out(201, { ...r.refund, payment_object: paymentView(r.payment) });
    }
    case 'POST subscriptions': {
      const r = await tx((conn) => createSubscription(conn, m, b, { idem }));
      return out(201, { ...subscriptionView(r.sub), url: paymentView(r.payment).url, payment: paymentView(r.payment) });
    }
    case 'GET subscriptions': {
      const rows = await q('SELECT * FROM pay_subscriptions WHERE merchant_id = ? ORDER BY id DESC LIMIT ?', [m.id, limitOf(search)]);
      return out(200, { object: 'list', data: rows.map(subscriptionView) });
    }
    case 'GET subscriptions/:id':
      return out(200, subscriptionView(await ownSub(m, id)));
    case 'POST subscriptions/:id/cancel':
      return out(200, subscriptionView(await tx(async (conn) => cancelSubscription(conn, await ownSub(m, id, conn), { by: 'merchant' }))));
    case 'POST orders': {
      const r = await tx(async (conn) => {
        const o = await createOrder(conn, m, b, { idem });
        return orderOut(o.order, conn);
      });
      return out(201, r);
    }
    case 'GET orders': {
      const rows = await q('SELECT * FROM shop_orders WHERE merchant_id = ? ORDER BY id DESC LIMIT ?', [m.id, limitOf(search)]);
      return out(200, { object: 'list', data: rows.map((o) => orderView(o)) });
    }
    case 'GET orders/:id':
      return out(200, await orderOut(await ownOrder(m, id)));
    case 'POST orders/:id/refund': {
      const r = await tx(async (conn) => {
        const o = await ownOrder(m, id, conn, true);
        const p = await one('SELECT * FROM pay_payments WHERE id = ? FOR UPDATE', [o.payment_id], conn);
        if (!p || !['paid', 'partially_refunded'].includes(p.status)) throw payError(400, 'not_refundable', 'Заказ не оплачен');
        const lines = Array.isArray(b.items) && b.items.length ? b.items : null;
        const res2 = await refundOrderPayment(conn, m, p, { amount: Number(p.amount) - Number(p.refunded), reason: b.reason || null, lines });
        return { ...res2.refund, order: await orderOut(await one('SELECT * FROM shop_orders WHERE id = ?', [o.id], conn), conn) };
      });
      return out(201, r);
    }
    case 'GET events': {
      const rows = await q('SELECT * FROM pay_events WHERE merchant_id = ? ORDER BY id DESC LIMIT ?', [m.id, limitOf(search)]);
      return out(200, { object: 'list', data: rows.map(eventView) });
    }
    case 'GET events/:id': {
      const e = await one('SELECT * FROM pay_events WHERE public_id = ? AND merchant_id = ?', [String(id), m.id]);
      if (!e) throw payError(404, 'event_not_found', 'Событие не найдено');
      return out(200, eventView(e));
    }
    default:
      throw payError(404, 'not_found', `Нет такого метода: ${method} ${rawPath}. Документация — https://pay.bank.bln/docs`);
  }
}

/** HTTP-ответ госсайта по сети БалНета или null (этот путь госсайт серверам не отдаёт). */
let injector = null;
/** Связать с приложением Fastify: остальной API госсайтов (/api/…) отвечает серверам сайтов по токену bln_…. */
export function setGovInjector(fn) { injector = fn; }

async function restApi({ method, path, headers, body }) {
  const h = { ...headers };
  delete h.cookie; delete h.host; delete h['content-length'];
  const r = await injector({ method, url: path, headers: h, payload: body && body.length !== 0 ? body : undefined });
  const keep = Object.fromEntries(Object.entries(r.headers).filter(([k]) => /^(content-type|location|cache-control)$/i.test(k)));
  return { status: r.statusCode, headers: keep, body: r.rawPayload };
}

export async function govHttp(target, { method = 'GET', path = '/', headers = {}, body = null }) {
  const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), String(v)]));
  const m = String(method).toUpperCase();
  try {
    if (target === 'app:pay' && path.startsWith('/api/v1')) return await payApi({ method: m, path, headers: h, body });
    const provider = target === 'app:mail' ? 'mail' : target === 'app:services' ? 'gov' : null;
    if (provider) {
      const r = await oauthHttp(provider, { method: m, path, headers: h, body });
      if (r) return out(r.status, r.body, r.headers || {});
    }
    if (injector && /^\/api\/(?!auth\/|admin\/)/.test(path)) return await restApi({ method: m, path, headers: h, body });
  } catch (err) {
    if (!(err instanceof HttpError)) console.error('gov api', err);
    const e = apiError(err);
    return out(e.status, e.body);
  }
  return null;
}

```

## Приложение: `web/src/pay/docs.jsx`

Снимок исходного справочного кода и обработчиков; зависимости и точные проверки — в исходном репозитории.

```js
// Документация для разработчиков сайтов БалНета (этап Н9): API эквайринга, вебхуки, интернет-магазин и доставка,
// вход через ВлодПочту и ВлодУслуги (OAuth 2 + PKCE). Примеры — для server.js на виртуальном тарифе.
import { useRoute } from '../shared/router.js';

const SECTIONS = [
  ['start', 'Быстрый старт'],
  ['payments', 'Платежи'],
  ['webhooks', 'Вебхуки'],
  ['refunds', 'Возвраты'],
  ['subscriptions', 'Подписки'],
  ['shop', 'Магазин и доставка'],
  ['oauth', 'Вход через ВлодПочту и ВлодУслуги'],
  ['errors', 'Ошибки'],
];

const Code = ({ children }) => <pre className="pay-code-block"><code>{children.trim()}</code></pre>;

export function DocsPage() {
  const route = useRoute();
  const cur = route.query.s || 'start';
  return (
    <div className="page pay-docs">
      <div className="pay-docs-grid">
        <nav className="pay-docs-nav">
          {SECTIONS.map(([id, title]) => <a key={id} href={`#/docs?s=${id}`} className={cur === id ? 'active' : ''}>{title}</a>)}
        </nav>
        <article className="card pay-docs-body">{BODY[cur] ? BODY[cur]() : BODY.start()}</article>
      </div>
    </div>
  );
}

const BODY = {
  start: () => (
    <>
      <h1>API эквайринга ВлодБанка</h1>
      <p>Адрес API — <code>https://pay.bank.bln/api/v1</code>. Запросы делает <b>сервер вашего сайта</b> (server.js, server.py или PHP на виртуальном тарифе) по сети БалНета: DNS, подключение к 50.1.0.10 и проверка сертификата ВлодБанка — как в настоящем интернете. Только https.</p>
      <ol>
        <li>Зарегистрируйте ИП во ВлодУслугах и откройте бизнес-счёт во ВлодБанке (или будьте директором организации).</li>
        <li>Подключите магазин в <a href="#/business">кабинете</a> — получите ключи <code>pk_live_…</code> и <code>sk_live_…</code>.</li>
        <li>Создайте платёж из server.js и отправьте покупателя по ссылке <code>url</code>.</li>
        <li>Примите вебхук <code>payment.succeeded</code> и выдайте товар.</li>
      </ol>
      <p>Ключ передаётся в заголовке <code>Authorization: Bearer sk_live_…</code>. Секретный ключ — только на сервере, публичный подходит лишь для каталога товаров. Суммы — целые <b>влодинки</b> (1 влодик = 100 влодинок).</p>
      <Code>{`
// server.js — кнопка «Купить» ведёт на /buy
const SK = 'sk_live_…'; // из кабинета pay.bank.bln

export async function onRequest(req) {
  if (req.path === '/buy') {
    const r = await fetch('https://pay.bank.bln/api/v1/payments', {
      method: 'POST',
      headers: { authorization: 'Bearer ' + SK, 'content-type': 'application/json', 'idempotency-key': 'cart-' + req.query.get('cart') },
      body: JSON.stringify({ amount: 15000, description: 'Футболка БалНета', return_url: 'https://shop.vasya.bln/thanks' }),
    });
    const p = await r.json();
    if (!r.ok) return new Response(p.error.message, { status: 400 });
    return Response.redirect(p.url); // https://pay.bank.bln/c/pay_…
  }
  return new Response('Магазин Васи');
}`}</Code>
    </>
  ),
  payments: () => (
    <>
      <h1>Платежи</h1>
      <h3>POST /api/v1/payments</h3>
      <table className="table small">
        <tbody>
          <tr><td><code>amount</code></td><td>сумма во влодинках, НДС включён</td></tr>
          <tr><td><code>description</code></td><td>за что платёж — видно покупателю</td></tr>
          <tr><td><code>return_url</code></td><td>куда вернуть после оплаты; добавятся <code>?payment=pay_…&amp;status=paid</code></td></tr>
          <tr><td><code>cancel_url</code></td><td>куда вернуть при отказе (по умолчанию return_url, <code>status=cancelled</code>)</td></tr>
          <tr><td><code>items</code></td><td>необязательно: <code>[{'{ name, qty, price }'}]</code>, сумма должна совпасть с amount</td></tr>
          <tr><td><code>metadata</code></td><td>до 20 ключей — вернутся в платеже и вебхуках (номер заказа и т. п.)</td></tr>
          <tr><td><code>age_limit</code></td><td>18 — оплатить сможет только совершеннолетний по паспорту БФ</td></tr>
          <tr><td><code>expires_minutes</code></td><td>срок ссылки, по умолчанию 60 минут</td></tr>
        </tbody>
      </table>
      <p>Заголовок <code>Idempotency-Key</code> защищает от двойного платежа: повтор с тем же ключом вернёт тот же платёж.</p>
      <Code>{`
{
  "id": "pay_Xq3…", "object": "payment", "status": "pending", "amount": 15000, "currency": "vlod",
  "url": "https://pay.bank.bln/c/pay_Xq3…", "description": "Футболка БалНета",
  "vat": 0, "fee": 0, "net": null, "refunded": 0, "metadata": {}, "expires_at": "…"
}`}</Code>
      <p>Статусы: <code>pending</code> → <code>paid</code> | <code>cancelled</code> | <code>expired</code>; после возвратов — <code>partially_refunded</code>, <code>refunded</code>.</p>
      <p>После оплаты: <code>vat</code> — НДС (ушёл в Госбюджет), <code>fee</code> — комиссия банка, <code>net</code> — зачислено на ваш счёт.</p>
      <h3>Другие методы</h3>
      <ul>
        <li><code>GET /api/v1/payments/{'{id}'}</code> — платёж и его возвраты. Проверяйте статус здесь, а не по параметрам return_url — их может подделать кто угодно.</li>
        <li><code>GET /api/v1/payments?limit=20</code> — последние платежи.</li>
        <li><code>POST /api/v1/payments/{'{id}'}/cancel</code> — отменить неоплаченный.</li>
        <li><code>GET /api/v1/me</code> — проверить ключ.</li>
      </ul>
    </>
  ),
  webhooks: () => (
    <>
      <h1>Вебхуки</h1>
      <p>Укажите адрес вебхуков в кабинете. После каждого события ВлодБанк делает <code>POST</code> с сервера 50.1.0.10 с JSON и заголовками:</p>
      <ul>
        <li><code>Vlod-Event-Id: evt_…</code> — уникальный id (обрабатывайте событие один раз);</li>
        <li><code>Vlod-Signature: t=1700000000,v1=…</code> — HMAC-SHA256 секретом <code>whsec_…</code> от строки <code>t + "." + тело</code>.</li>
      </ul>
      <p>Ответьте кодом 2xx. Иначе — повторы через 1, 5, 30 минут, 2 и 6 часов, потом событие помечается «не доставлено» (его можно переотправить из кабинета).</p>
      <Code>{`
const WH = 'whsec_…';

export async function onRequest(req) {
  if (req.path === '/webhooks/vlodbank' && req.method === 'POST') {
    const body = await req.text();
    const sig = req.headers.get('vlod-signature') || '';
    const t = (/t=(\\d+)/.exec(sig) || [])[1];
    const v1 = (/v1=([0-9a-f]+)/.exec(sig) || [])[1] || '';
    if (!crypto.timingSafeEqual(crypto.hmac('sha256', WH, t + '.' + body), v1)) return new Response('bad signature', { status: 400 });
    const e = JSON.parse(body);
    if (e.type === 'payment.succeeded') {
      db.run('UPDATE orders SET paid = 1 WHERE payment = ?', [e.data.object.id]);
    }
    return new Response('ok');
  }
}`}</Code>
      <p>События: <code>payment.succeeded</code>, <code>payment.cancelled</code>, <code>refund.succeeded</code>, <code>subscription.activated</code>, <code>subscription.renewed</code>, <code>subscription.payment_failed</code>, <code>subscription.cancelled</code>, <code>order.paid</code>, <code>order.ready</code>, <code>order.delivering</code>, <code>order.delivered</code>, <code>order.approved</code>, <code>order.shipped</code>, <code>order.refunded</code>, <code>ping</code>.</p>
      <p>В PHP — <code>hash_hmac('sha256', $t . '.' . $body, $secret)</code>, в Python — <code>hmac.new(secret.encode(), (t + '.' + body).encode(), 'sha256').hexdigest()</code>.</p>
    </>
  ),
  refunds: () => (
    <>
      <h1>Возвраты</h1>
      <Code>{`
POST /api/v1/refunds
{ "payment": "pay_…", "amount": 5000, "reason": "Не подошёл размер" }  // без amount — весь остаток`}</Code>
      <p>Деньги уходят с вашего счёта на счёт, с которого платил покупатель. НДС возвращается из бюджета пропорционально, <b>комиссия банка не возвращается</b> — на полный возврат нужны свои деньги на счёте.</p>
      <p>Онлайн-заказы магазина возвращаются через чек Кассы, и товар возвращается на склад: <code>POST /api/v1/orders/{'{id}'}/refund</code> с <code>items: [{'{ product_id, qty }'}]</code> или без них — целиком.</p>
    </>
  ),
  subscriptions: () => (
    <>
      <h1>Подписки</h1>
      <Code>{`
POST /api/v1/subscriptions
{ "amount": 1000, "description": "VIP на форуме", "period_months": 1, "return_url": "https://forum.bln/vip" }
→ { "id": "sub_…", "status": "pending", "url": "https://pay.bank.bln/c/pay_…" }`}</Code>
      <p>Покупатель подтверждает первый платёж со своего счёта ВлодБанка. Дальше банк списывает сумму в начале каждого периода (в игровых месяцах) и присылает <code>subscription.renewed</code>. Если денег нет — <code>subscription.payment_failed</code>, после трёх неудач подписка отменяется.</p>
      <p>Отменить: <code>POST /api/v1/subscriptions/{'{id}'}/cancel</code>. Покупатель тоже может отменить её в разделе «Покупки» ВлодБанка.</p>
    </>
  ),
  shop: () => (
    <>
      <h1>Интернет-магазин на складе Кассы</h1>
      <p>Подключите к эквайрингу магазин Кассы и отметьте товары «Продаётся онлайн». Цены и остатки сайт берёт из Кассы — подделать цену в заказе нельзя.</p>
      <Code>{`
GET /api/v1/products            // можно публичным ключом pk_live_…
→ { "shop": {…}, "delivery": { "pickup": true, "courier": true, "digital": true, "physical": false, "courier_fee": 300 },
    "products": [{ "id": 12, "name": "Чай Влодский", "price": 2500, "unit": "pcs", "in_stock": 5, "digital": false }] }

POST /api/v1/orders
{ "items": [{ "product_id": 12, "qty": 2 }], "delivery": "courier", "address": "Влодоград, ул. Почтовая, 5",
  "contact": "Вера, ВлодПочта vera@mail.bln", "return_url": "https://shop.vasya.bln/orders" }
→ { "id": "ord_…", "status": "pending", "total": 5300, "payment": { "url": "https://pay.bank.bln/c/pay_…" } }`}</Code>
      <p>После оплаты заказ становится чеком Кассы с источником «онлайн»: склад списывается, блюда уходят на кухню, начисляются баллы, всё видно в отчётах. Сборка и выдача — в Кассе, раздел «Онлайн-заказы».</p>
      <h3>Доставка</h3>
      <ul>
        <li><b>pickup</b> — самовывоз: покупатель получает 6-значный код и называет его на кассе.</li>
        <li><b>courier</b> — курьер БалНета: собранный заказ видят курьеры на pay.bank.bln/courier. При вручении курьер сканирует QR покупателя, и стоимость доставки переводится ему с бизнес-счёта магазина.</li>
        <li><b>digital</b> — цифровой товар: текст из поля «Цифровой товар» в Кассе (ключ, ссылка, код) появляется у покупателя сразу после оплаты.</li>
        <li><b>physical</b> — настоящая доставка в реальном мире: не чаще раза в неделю на покупателя и только после одобрения админа. При отказе деньги возвращаются автоматически.</li>
      </ul>
    </>
  ),
  oauth: () => (
    <>
      <h1>Вход через ВлодПочту и ВлодУслуги</h1>
      <p>OAuth 2.0 с кодом авторизации и PKCE. Зарегистрируйте приложение и адреса возврата во ВлодПочте: <a href="../mail/#/developers">mail.bln → Разработчикам</a>. Пароль пользователя ваш сайт никогда не видит.</p>
      <table className="table small">
        <tbody>
          <tr><td>ВлодПочта</td><td><code>https://mail.bln/oauth/authorize</code></td><td>scope: <code>openid profile email</code></td></tr>
          <tr><td>ВлодУслуги</td><td><code>https://gosuslugi.gov.bln/oauth/authorize</code></td><td>scope: <code>openid profile age passport</code></td></tr>
        </tbody>
      </table>
      <p><code>age</code> отдаёт <code>age_over_14/16/18/21</code> по паспорту БФ — без даты рождения. Для казино и магазинов 18+ этого достаточно.</p>
      <Code>{`
const CLIENT = 'cl_…', SECRET = 'cs_…', BACK = 'https://shop.vasya.bln/auth/callback';

export async function onRequest(req) {
  if (req.path === '/login') {
    const state = crypto.randomUUID();
    const verifier = crypto.randomUUID() + crypto.randomUUID();           // 43+ символа
    const challenge = b64url(crypto.hash('sha256', verifier));             // SHA-256 → base64url
    kv.set('login:' + state, verifier, { ttl: 600 });
    return Response.redirect('https://mail.bln/oauth/authorize?' + new URLSearchParams({
      response_type: 'code', client_id: CLIENT, redirect_uri: BACK, scope: 'openid profile email',
      state, code_challenge: challenge, code_challenge_method: 'S256',
    }));
  }
  if (req.path === '/auth/callback') {
    const state = req.query.get('state');
    const verifier = kv.get('login:' + state);
    if (!verifier) return new Response('Сессия входа истекла', { status: 400 });
    const t = await (await fetch('https://mail.bln/oauth/token', {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'authorization_code', code: req.query.get('code'), redirect_uri: BACK,
        client_id: CLIENT, client_secret: SECRET, code_verifier: verifier }).toString(),
    })).json();
    const me = await (await fetch('https://mail.bln/oauth/userinfo', { headers: { authorization: 'Bearer ' + t.access_token } })).json();
    // me = { sub, name, email: 'vera@mail.bln', email_verified: true }
    return Response.redirect('/').setCookie('user', me.email, { httpOnly: true });
  }
}

// hex → base64url (crypto.hash возвращает hex)
function b64url(hex) {
  let s = ''; for (let i = 0; i < hex.length; i += 2) s += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(s).replace(/\\+/g, '-').replace(/\\//g, '_').replace(/=+$/, '');
}`}</Code>
      <p><code>sub</code> — постоянный идентификатор пользователя <b>для вашего приложения</b>: другие сайты получат другой. Код действует 10 минут и одноразовый; повтор кода отзывает выданный по нему токен. Токен живёт час.</p>
      <p>Настройки провайдера: <code>/.well-known/openid-configuration</code>. Пользователь видит подключённые сайты во ВлодПочте и может отозвать доступ.</p>
    </>
  ),
  errors: () => (
    <>
      <h1>Ошибки</h1>
      <Code>{`
HTTP 400
{ "error": { "code": "refund_exceeds", "message": "Можно вернуть не больше 60,00 В" } }`}</Code>
      <table className="table small">
        <tbody>
          <tr><td>401 <code>no_api_key</code>, <code>invalid_api_key</code></td><td>нет ключа или он отозван</td></tr>
          <tr><td>403 <code>secret_key_required</code></td><td>публичным ключом можно только читать каталог</td></tr>
          <tr><td>403 <code>merchant_blocked</code></td><td>приём платежей остановлен админом</td></tr>
          <tr><td>400 <code>https_required</code></td><td>API — только по https://</td></tr>
          <tr><td>400 <code>invalid_amount</code>, <code>invalid_url</code>, <code>items_mismatch</code></td><td>неверные параметры</td></tr>
          <tr><td>400 <code>out_of_stock</code>, <code>product_not_found</code>, <code>delivery_off</code></td><td>заказ магазина</td></tr>
          <tr><td>400 <code>merchant_funds</code></td><td>на счёте магазина не хватает денег для возврата</td></tr>
          <tr><td>404 <code>payment_not_found</code>, <code>order_not_found</code></td><td>нет такого объекта у вашего магазина</td></tr>
        </tbody>
      </table>
    </>
  ),
};

```

## Приложение: `api/src/lib/vhost/example.js`

Снимок исходного справочного кода и обработчиков; зависимости и точные проверки — в исходном репозитории.

```js
// Пример серверного кода для виртуального тарифа: гостевая книга на SQLite, счётчик в key-value, cron.
export const EXAMPLE = {
  'server.js': `// Гостевая книга: серверный JavaScript БалНета (QuickJS).
// db — SQLite сайта, kv — ключ-значение, fetch — запросы к другим сайтам, console.log — журнал в панели БалХоста.
db.exec('CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY, name TEXT, text TEXT, at INTEGER)');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function onRequest(req) {
  if (req.method === 'POST' && req.path === '/sign') {
    const form = await req.form();
    const name = (form.get('name') || 'Аноним').slice(0, 40);
    const text = (form.get('text') || '').slice(0, 500);
    if (text) db.run('INSERT INTO posts (name, text, at) VALUES (?, ?, ?)', [name, text, gameTime()]);
    return Response.redirect('/');
  }
  if (req.path === '/api/posts') {
    return Response.json(db.query('SELECT name, text, at FROM posts ORDER BY id DESC LIMIT 50'));
  }
  if (req.path !== '/') return new Response('Не найдено', { status: 404 });
  const visits = (kv.get('visits') || 0) + 1;
  kv.set('visits', visits);
  const posts = db.query('SELECT name, text FROM posts ORDER BY id DESC LIMIT 20');
  return Response.html(\`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Гостевая книга</title></head>
<body style="font-family:system-ui;max-width:640px;margin:24px auto;padding:0 16px">
<h1>Гостевая книга</h1><p>Посещений: \${visits}</p>
<form method="post" action="/sign"><input name="name" placeholder="Имя"> <input name="text" placeholder="Сообщение" required> <button>Написать</button></form>
<ul>\${posts.map((p) => \`<li><b>\${esc(p.name)}:</b> \${esc(p.text)}</li>\`).join('')}</ul>
</body></html>\`);
}

// Вызывается по расписанию из файла crontab (игровое время).
export function onCron(job) {
  const old = db.run('DELETE FROM posts WHERE at < ?', [job.time - 30 * 86400]);
  console.log('Уборка: удалено записей старше месяца —', old.changes);
}
`,
  crontab: `# минута час день месяц день_недели задача  (игровое время)
0 4 * * * уборка
`,
};

```
