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
