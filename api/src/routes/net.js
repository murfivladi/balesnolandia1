// API сети БалНета для ВлодБраузера и его терминала. Вход не нужен: «устройство» — это client_id профиля браузера,
// которому провайдер выдаёт IP-адрес. Во время паузы игрового времени БалНет на обслуживании.
import { HttpError, bad, int } from '../lib/errors.js';
import { netSnapshot, lease, clientOf, ping, traceroute, connect, whois } from '../lib/net.js';
import { resolve, queryServer } from '../lib/dns.js';
import { isPaused } from '../lib/clock.js';
import { isIP, normalizeIP } from '@bln/shared/balnet-ip.js';
import { splitUrl } from '@bln/shared/balnet-url.js';

const limited = (max) => ({ config: { rateLimit: { max, timeWindow: '1 minute' } } });

async function online() {
  if (await isPaused()) throw new HttpError(503, 'balnet_maintenance', 'БалНет на обслуживании: игровое время на паузе');
}

function ipParam(v, what) {
  if (v === undefined || v === null || v === '') return null;
  if (!isIP(String(v))) throw bad('invalid_ip', `${what}: нужен IP-адрес`);
  return normalizeIP(String(v));
}

/** Клиент и его резолвер: свой (настройка браузера) или резолвер провайдера. */
async function clientCtx(body) {
  const c = await clientOf(body.client_id);
  const resolverIp = ipParam(body.resolver, 'DNS-сервер') || c.provider.resolver_ip;
  return { ...c, resolverIp };
}

/** Имя или IP → IP через резолвер клиента. Сначала IPv4 (A), если нет — IPv6 (AAAA). */
async function hostToIp(c, host) {
  const h = String(host || '').trim();
  if (!h) throw bad('invalid', 'Не указан адрес');
  if (isIP(h)) return { ip: normalizeIP(h), dns: null };
  const args = { resolverIp: c.resolverIp, clientIp: c.ip, clientProviderId: c.provider.id, name: h };
  let dns = await resolve({ ...args, type: 'A' });
  let ip = [...dns.answer].reverse().find((r) => r.type === 'A')?.data || null;
  if (!ip && dns.rcode === 'NOERROR') {
    const v6 = await resolve({ ...args, type: 'AAAA' });
    const ip6 = [...v6.answer].reverse().find((r) => r.type === 'AAAA')?.data;
    if (ip6) { dns = v6; ip = ip6; }
  }
  return { ip, dns };
}

/** Ошибка резолва → код как в Chrome. */
export function dnsErrorCode(dns) {
  if (dns.rcode === 'NXDOMAIN') return 'DNS_PROBE_FINISHED_NXDOMAIN';
  if (dns.rcode === 'NOERROR') return 'ERR_NAME_NOT_RESOLVED'; // имя есть, но адресов (A/AAAA) у него нет
  if (dns.rcode === 'TIMEOUT') return 'DNS_PROBE_FINISHED_BAD_CONFIG';
  return 'ERR_NAME_RESOLUTION_FAILED';
}

export async function netRoutes(app) {
  app.get('/providers', async () => {
    const snap = await netSnapshot();
    const publicResolvers = [...snap.hostByIp.values()].filter((h) => h.kind === 'resolver' && !h.provider_id && h.up).map((h) => ({ ip: h.ip, name: h.name }));
    return {
      providers: snap.providers.filter((p) => p.active).map((p) => ({ code: p.code, name: p.name, resolver_ip: p.resolver_ip })),
      public_resolvers: publicResolvers,
    };
  });

  app.post('/lease', limited(30), async (req) => {
    const b = req.body || {};
    const r = await lease(b.client_id, String(b.provider || ''));
    const snap = await netSnapshot();
    const block = snap.blocks.find((x) => x.id === r.provider.block_id);
    return { ip: r.ip, provider: { code: r.provider.code, name: r.provider.name }, resolver_ip: r.provider.resolver_ip, gateway: block?.gateway_ip || null, netmask: block?.cidr || null };
  });

  app.post('/resolve', limited(240), async (req) => {
    await online();
    const c = await clientCtx(req.body || {});
    return resolve({ resolverIp: c.resolverIp, clientIp: c.ip, clientProviderId: c.provider.id, name: req.body.name, type: req.body.type || 'A' });
  });

  app.post('/query', limited(240), async (req) => {
    await online();
    const b = req.body || {};
    const c = await clientCtx(b);
    const server = ipParam(b.server, 'Сервер') || c.resolverIp;
    return queryServer({ serverIp: server, clientIp: c.ip, clientProviderId: c.provider.id, name: b.name, type: b.type || 'A', recurse: b.recurse !== false });
  });

  // Открытие адреса браузером: DNS → подключение к серверу → что показать.
  app.post('/open', limited(240), async (req) => {
    await online();
    const b = req.body || {};
    const c = await clientCtx(b);
    const p = splitUrl(String(b.url || ''));
    if (!p || (p.scheme !== 'https' && p.scheme !== 'http')) throw bad('invalid_url', 'Неверный адрес');
    const started = Date.now();
    const { ip, dns } = await hostToIp(c, p.host);
    const base = { url: b.url, host: p.host, client_ip: c.ip, resolver_ip: c.resolverIp, dns };
    if (!ip) return { ...base, ok: false, code: dnsErrorCode(dns), timing: { dns: dns?.ms || 0 } };
    const snap = await netSnapshot();
    const conn = connect(snap, c.ip, ip, p.host);
    return { ...base, ...conn, ok: conn.ok, timing: { dns: dns?.ms || 0, connect: conn.ms || 0, server: Date.now() - started } };
  });

  app.post('/ping', limited(60), async (req) => {
    await online();
    const b = req.body || {};
    const c = await clientCtx(b);
    const { ip, dns } = await hostToIp(c, b.host);
    if (!ip) return { host: b.host, error: dnsErrorCode(dns), dns };
    const count = int(b.count ?? 4, 'count', { min: 1, max: 10 });
    return { host: b.host, ...ping(await netSnapshot(), c.ip, ip, count) };
  });

  app.post('/traceroute', limited(30), async (req) => {
    await online();
    const b = req.body || {};
    const c = await clientCtx(b);
    const { ip, dns } = await hostToIp(c, b.host);
    if (!ip) return { host: b.host, error: dnsErrorCode(dns), dns };
    return { host: b.host, ...traceroute(await netSnapshot(), c.ip, ip) };
  });

  app.get('/whois', limited(60), async (req) => {
    await online();
    return whois(req.query.q);
  });
}
