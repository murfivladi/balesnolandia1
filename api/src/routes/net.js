// API сети БалНета для ВлодБраузера и его терминала. Вход не нужен: «устройство» — это client_id профиля браузера,
// которому провайдер выдаёт IP-адрес. Во время паузы игрового времени БалНет на обслуживании.
import { HttpError, bad, int } from '../lib/errors.js';
import { netSnapshot, lease, clientOf, ping, traceroute, connect, whois } from '../lib/net.js';
import { resolve, queryServer } from '../lib/dns.js';
import { isPaused } from '../lib/clock.js';
import { isIP, normalizeIP } from '@bln/shared/balnet-ip.js';
import { splitUrl } from '@bln/shared/balnet-url.js';
import { fqdn } from '@bln/shared/balnet-dns.js';
import { whoisDomain } from '../lib/domains.js';
import { createTicket, cleanJar } from '../lib/gateway.js';
import { tlsFor, trustStore } from '../lib/pki.js';
import { one } from '../db.js';
import { verifyHash } from '../lib/auth.js';
import { newSession, getSession, endSession, shell, saveFile, prompt } from '../lib/vhost/ssh.js';

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
export async function clientCtx(body) {
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

/** Открыть адрес от имени устройства: { ok, ip, target, gov, server, code, dns, timing }. */
export async function openFor(c, url) {
  const p = splitUrl(url);
  if (!p || (p.scheme !== 'https' && p.scheme !== 'http')) throw bad('invalid_url', 'Неверный адрес');
  const started = Date.now();
  const { ip, dns } = await hostToIp(c, p.host);
  const base = { url, host: p.host, client_ip: c.ip, resolver_ip: c.resolverIp, dns };
  if (!ip) return { ...base, ok: false, code: dnsErrorCode(dns), timing: { dns: dns?.ms || 0 } };
  const snap = await netSnapshot();
  const conn = connect(snap, c.ip, ip, p.host);
  return { ...base, ...conn, ok: conn.ok, timing: { dns: dns?.ms || 0, connect: conn.ms || 0, server: Date.now() - started } };
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
    return resolve({ resolverIp: c.resolverIp, clientIp: c.ip, clientProviderId: c.provider.id, name: req.body.name, type: req.body.type || 'A', dnssec: !!req.body.dnssec, cd: !!req.body.cd });
  });

  app.post('/query', limited(240), async (req) => {
    await online();
    const b = req.body || {};
    const c = await clientCtx(b);
    const server = ipParam(b.server, 'Сервер') || c.resolverIp;
    return queryServer({ serverIp: server, clientIp: c.ip, clientProviderId: c.provider.id, name: b.name, type: b.type || 'A', recurse: b.recurse !== false, dnssec: !!b.dnssec, cd: !!b.cd });
  });

  /** Хранилище доверия ВлодБраузера: корневые УЦ, журналы прозрачности, отозванные УЦ. */
  app.get('/trust', async () => trustStore());

  // Открытие адреса браузером: DNS → подключение к серверу → TLS (для https) → что показать.
  // tls: { chain, sct, ocsp, time } — браузер сам проверяет подписи; null — на сервере нет сертификата (порт 443 закрыт).
  // Для сайта игрока выдаётся билет шлюза (адрес песочницы) с хранилищами сайта от браузера.
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
      r.ticket = createTicket({ clientId: b.client_id, clientIp: c.ip, resolver: c.resolverIp, target: r.target, host: p.host, scheme: p.scheme, origin: `${p.scheme}://${p.host}`, ...jar });
    }
    return r;
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

  // ——— SSH на сервер хостинга: ssh u<номер>@<сервер> из терминала ВлодБраузера ———
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
    const id = newSession(acc, name);
    const s = getSession(id);
    return { session: id, prompt: prompt(s), motd: [`Добро пожаловать на ${String(server.name).replace(/\.$/, '')} (${ip}) — хостинг БалНета.`, 'help — список команд, exit — выход.', acc.status === 'suspended' ? 'Внимание: хостинг приостановлен за неуплату.' : ''].filter(Boolean) };
  });

  app.post('/ssh/exec', limited(600), async (req) => {
    await online();
    const s = getSession(req.body?.session);
    if (!s) return { error: 'Connection closed by remote host (сессия истекла)', closed: true };
    const r = await shell(s, req.body?.line);
    if (r.exit) endSession(req.body.session);
    return { ...r, prompt: prompt(s) };
  });

  app.post('/ssh/save', limited(120), async (req) => {
    const s = getSession(req.body?.session);
    if (!s) return { error: 'Сессия истекла', closed: true };
    return saveFile(s, req.body?.path, req.body?.content);
  });

  app.get('/whois', limited(60), async (req) => {
    await online();
    const name = fqdn(String(req.query.q || ''));
    const dom = name ? await whoisDomain(null, name) : null;
    return dom || whois(req.query.q);
  });
}
