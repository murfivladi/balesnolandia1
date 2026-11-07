// Адреса БалНета: разбор адресной строки, встроенные госсайты, коды ошибок ВлодБраузера.
// Общий модуль: им пользуется браузер (web/src/browser) и будут пользоваться DNS и шлюз API.

export const SEARCH_HOST = 'poisk.bln';
export const NEW_TAB = 'balnet://newtab/';

/** Внутренние страницы браузера: balnet://<имя>/ */
export const INTERNAL_PAGES = {
  newtab: 'Новая вкладка',
  history: 'История',
  bookmarks: 'Закладки',
  settings: 'Настройки',
  about: 'О ВлодБраузере',
  game: 'Курьер БалНета',
  terminal: 'Терминал',
};

/**
 * Встроенные госсайты: существующие приложения проекта, открытые под доменом БалНета.
 * app — папка приложения на реальном сайте (/bank/, /services/, /pos/), маршрут внутри — hash.
 */
export const GOV_SITES = {
  'bank.bln': { app: 'bank', title: 'ВлодБанк', owner: 'ВлодБанк (госбанк БФ)' },
  'gosuslugi.gov.bln': { app: 'services', title: 'ВлодУслуги', owner: 'Правительство БФ' },
  'kassa.bln': { app: 'pos', title: 'Касса', owner: 'Министерство торговли БФ' },
  'reg.bln': { app: 'reg', title: 'БалРег', owner: 'Координационный центр БалНета' },
  'hosting.bln': { app: 'hosting', title: 'БалХост', owner: 'Координационный центр БалНета' },
  'nalog.gov.bln': { app: 'nalog', title: 'Налоговая служба БФ', owner: 'Правительство БФ' },
  'ca.gov.bln': { app: 'ca', title: 'БалСерт', owner: 'Координационный центр БалНета' },
  'poisk.bln': { app: 'poisk', title: 'ВлодПоиск', owner: 'Правительство БФ' },
  'vlodhub.bln': { app: 'hub', title: 'ВлодХаб', owner: 'Координационный центр БалНета' },
};

const SCHEME_RE = /^([a-z][a-z0-9+.-]*):\/\//i;
const HOST_RE = /^(?=.{1,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{0,62}$/i;
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1?\d?\d)(\.(25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;

export function searchUrl(query) {
  return `https://${SEARCH_HOST}/?q=${encodeURIComponent(query)}`;
}

/** Похоже ли на имя хоста или IP (без схемы и пути). */
export function isHostLike(host) {
  const h = host.replace(/:\d+$/, '');
  return HOST_RE.test(h) || IPV4_RE.test(h);
}

/**
 * Разбор текста из адресной строки, как в Chrome:
 * схема → адрес; «bank.bln/cards» → https://bank.bln/cards; всё остальное → поиск во ВлодПоиске.
 * Возвращает нормализованный адрес или null для пустой строки.
 */
export function parseInput(text) {
  const s = String(text ?? '').trim();
  if (!s) return null;
  if (SCHEME_RE.test(s)) {
    const n = normalizeUrl(s);
    return n || searchUrl(s);
  }
  if (/\s/.test(s)) return searchUrl(s);
  const slash = s.search(/[/?#]/);
  const host = slash === -1 ? s : s.slice(0, slash);
  if (isHostLike(host)) return normalizeUrl(`https://${s}`) || searchUrl(s);
  return searchUrl(s);
}

/** Нормализация: схема и хост в нижнем регистре, пустой путь → «/». null — если адрес не разбирается. */
export function normalizeUrl(url) {
  const m = SCHEME_RE.exec(url);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  if (scheme === 'balnet') {
    const rest = url.slice(m[0].length);
    const [name, ...tail] = rest.split('/');
    const page = name.toLowerCase();
    if (!page) return null;
    return `balnet://${page}/${tail.join('/')}`;
  }
  if (scheme !== 'http' && scheme !== 'https') return null;
  let u;
  try { u = new URL(url); } catch { return null; }
  if (!u.hostname || !isHostLike(u.host)) return null;
  return `${scheme}://${u.host.toLowerCase()}${u.pathname || '/'}${u.search}${u.hash}`;
}

/** Разбор нормализованного адреса на части. */
export function splitUrl(url) {
  const m = SCHEME_RE.exec(url);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const rest = url.slice(m[0].length);
  const cut = rest.search(/[/?#]/);
  const host = (cut === -1 ? rest : rest.slice(0, cut)).toLowerCase();
  let path = cut === -1 ? '/' : rest.slice(cut);
  if (!path.startsWith('/')) path = `/${path}`;
  return { scheme, host, path };
}

/** Хосты в списке HSTS preload: браузер сам открывает их по https. */
export const HSTS_PRELOAD = new Set([...Object.keys(GOV_SITES), SEARCH_HOST]);

/** Параметр q из пути ВлодПоиска. */
export function searchQuery(path = '/') {
  return new URLSearchParams(path.split('?')[1]?.split('#')[0] || '').get('q') || '';
}

/**
 * Куда ведёт адрес:
 *  internal — страница браузера; web — сайт в БалНете (дальше DNS и подключение к серверу);
 *  upgrade — http для хоста из HSTS preload (браузер сам переходит на https); error — адрес не открыть.
 */
export function resolveTarget(url) {
  const p = splitUrl(url);
  if (!p) return { kind: 'error', code: 'ERR_INVALID_URL' };
  if (p.scheme === 'balnet') {
    if (!INTERNAL_PAGES[p.host]) return { kind: 'error', code: 'ERR_INVALID_URL' };
    return { kind: 'internal', page: p.host, path: p.path };
  }
  if (p.scheme !== 'https' && p.scheme !== 'http') return { kind: 'error', code: 'ERR_INVALID_URL' };
  if (p.scheme === 'http' && HSTS_PRELOAD.has(p.host)) return { kind: 'upgrade', url: `https://${p.host}${p.path}` };
  return { kind: 'web', scheme: p.scheme, host: p.host, path: p.path };
}

/** Путь приложения проекта: «bank», «/cards?x=1» → «bank/#/cards?x=1». */
export function appPath(app, path = '/') {
  const route = path.split('#')[0] || '/';
  return `${app}/#${route.startsWith('/') ? route : `/${route}`}`;
}

/** https://bank.bln/cards?x=1 → «bank/#/cards?x=1» (путь приложения от корня реального сайта). */
export function govAppPath(host, path = '/') {
  const site = GOV_SITES[host];
  return site ? appPath(site.app, path) : null;
}

/** Обратно: приложение и его hash → адрес БалНета. «bank», «#/cards» → https://bank.bln/cards */
export function govUrlFromApp(app, hash = '') {
  const host = Object.keys(GOV_SITES).find((h) => GOV_SITES[h].app === app);
  if (!host) return null;
  let route = String(hash).replace(/^#/, '') || '/';
  if (!route.startsWith('/')) route = `/${route}`;
  return `https://${host}${route}`;
}

/** Как Chrome показывает адрес без фокуса: без https:// и без «/» в конце пустого пути. */
export function displayUrl(url) {
  if (!url || url === NEW_TAB) return '';
  const p = splitUrl(url);
  if (!p) return url;
  if (p.scheme === 'balnet') return url.replace(/\/$/, '');
  let path = p.path;
  // Как Chrome: русские буквы и пробелы в адресе показываем как есть, а не %D0%BA…
  try { path = decodeURI(path); } catch { /* битое кодирование — показываем как есть */ }
  const shown = path === '/' ? p.host : `${p.host}${path}`;
  return p.scheme === 'https' ? shown : `http://${shown}`;
}

/** Тексты страниц ошибок. */
export const NET_ERRORS = {
  DNS_PROBE_FINISHED_NXDOMAIN: {
    title: 'Не удаётся найти сайт',
    text: (host) => `Не удалось найти IP-адрес сервера ${host}. Такого домена нет в БалНете, или его срок регистрации истёк.`,
    tips: ['Проверьте, нет ли опечатки в адресе.', 'Поищите сайт во ВлодПоиске.', 'Проверьте настройки DNS у провайдера.'],
  },
  ERR_INTERNET_DISCONNECTED: {
    title: 'Нет подключения к интернету',
    text: () => 'Устройство не подключено к сети, поэтому БалНет недоступен.',
    tips: ['Проверьте Wi-Fi или мобильную сеть.', 'Пока ждёте — сыграйте в «Курьера БалНета».'],
  },
  ERR_INVALID_URL: {
    title: 'Неверный адрес',
    text: () => 'Этот адрес нельзя открыть.',
    tips: ['Проверьте адрес.'],
  },
  ERR_CONNECTION_REFUSED: {
    title: 'Сайт не позволяет установить соединение',
    text: (host) => `Сервер ${host} отклонил подключение: по этому адресу работает не веб-сервер.`,
    tips: ['Проверьте A-запись домена.', 'Попробуйте позже.'],
  },
  ERR_NAME_NOT_RESOLVED: {
    title: 'Не удаётся найти сайт',
    text: (host) => `Домен ${host} существует, но у него нет IP-адреса (записей A и AAAA).`,
    tips: ['Владельцу сайта: добавьте A-запись.'],
  },
  DNS_PROBE_FINISHED_BAD_CONFIG: {
    title: 'DNS-сервер не отвечает',
    text: () => 'DNS-сервер, указанный в настройках, не ответил. Возможно, по этому адресу нет резолвера.',
    tips: ['Проверьте DNS-сервер в настройках ВлодБраузера.', 'Выберите «DNS провайдера» или ВлодDNS 50.0.0.53.'],
  },
  ERR_NAME_RESOLUTION_FAILED: {
    title: 'Ошибка DNS',
    text: (host) => `DNS-сервер не смог найти адрес ${host}: он отказал в запросе или серверы домена не отвечают.`,
    tips: ['Резолвер провайдера обслуживает только своих абонентов — проверьте настройки DNS.', 'Посмотрите путь запроса в DevTools → Network.'],
  },
  ERR_CONNECTION_TIMED_OUT: {
    title: 'Превышено время ожидания',
    text: (host) => `Сервер ${host} слишком долго не отвечает: по этому IP-адресу никого нет или сервер выключен.`,
    tips: ['Попробуйте позже.', 'Проверьте связь командой ping в терминале.'],
  },
  ERR_ADDRESS_UNREACHABLE: {
    title: 'Сайт недоступен',
    text: (host) => `До адреса сервера ${host} нет маршрута: такой сети в БалНете нет.`,
    tips: ['Проверьте A-запись домена.', 'Посмотрите маршрут командой traceroute.'],
  },
  HTTP_404_NO_VHOST: {
    title: '404 — сайт не найден на сервере',
    text: (host) => `Сервер ответил, но сайта ${host} на нём нет: хостинг не настроен для этого имени.`,
    tips: ['Владельцу сайта: проверьте настройки хостинга.'],
  },
  ERR_BALNET_UNREACHABLE: {
    title: 'Нет связи с БалНетом',
    text: () => 'Сервер БалНета не отвечает. Возможно, он перезапускается.',
    tips: ['Проверьте подключение к интернету.', 'Попробуйте через минуту.'],
  },
};
