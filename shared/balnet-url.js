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
};

/**
 * Встроенные госсайты: существующие приложения проекта, открытые под доменом БалНета.
 * app — папка приложения на реальном сайте (/bank/, /services/, /pos/), маршрут внутри — hash.
 */
export const GOV_SITES = {
  'bank.bln': { app: 'bank', title: 'ВлодБанк', owner: 'ВлодБанк (госбанк БФ)' },
  'gosuslugi.gov.bln': { app: 'services', title: 'ВлодУслуги', owner: 'Правительство БФ' },
  'kassa.bln': { app: 'pos', title: 'Касса', owner: 'Министерство торговли БФ' },
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

/**
 * Куда ведёт адрес:
 *  internal — страница браузера; search — ВлодПоиск; gov — встроенный госсайт;
 *  upgrade — http госсайта (HSTS: браузер сам переходит на https); error — код ошибки.
 * Этап Н1: DNS ещё нет, поэтому любой другой домен — NXDOMAIN.
 */
export function resolveTarget(url) {
  const p = splitUrl(url);
  if (!p) return { kind: 'error', code: 'ERR_INVALID_URL' };
  if (p.scheme === 'balnet') {
    if (!INTERNAL_PAGES[p.host]) return { kind: 'error', code: 'ERR_INVALID_URL' };
    return { kind: 'internal', page: p.host, path: p.path };
  }
  if (p.host === SEARCH_HOST) {
    if (p.scheme !== 'https') return { kind: 'upgrade', url: `https://${p.host}${p.path}` };
    const q = new URLSearchParams(p.path.split('?')[1]?.split('#')[0] || '').get('q') || '';
    return { kind: 'search', query: q };
  }
  const site = GOV_SITES[p.host];
  if (site) {
    if (p.scheme !== 'https') return { kind: 'upgrade', url: `https://${p.host}${p.path}` };
    return { kind: 'gov', host: p.host, site, path: p.path };
  }
  return { kind: 'error', code: 'DNS_PROBE_FINISHED_NXDOMAIN', host: p.host };
}

/** https://bank.bln/cards?x=1 → «bank/#/cards?x=1» (путь приложения от корня реального сайта). */
export function govAppPath(host, path = '/') {
  const site = GOV_SITES[host];
  if (!site) return null;
  const route = path.split('#')[0] || '/';
  return `${site.app}/#${route.startsWith('/') ? route : `/${route}`}`;
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
  const shown = p.path === '/' ? p.host : `${p.host}${p.path}`;
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
    text: (host) => `Сервер ${host} отклонил подключение.`,
    tips: ['Попробуйте позже.'],
  },
};
