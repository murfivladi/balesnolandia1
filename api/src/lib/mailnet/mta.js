// Почтовая доставка БалНета (MTA): письмо идёт по-настоящему — MX домена получателя через DNS, адрес сервера,
// маршрут по сети, SMTP-диалог (220 → EHLO → MAIL FROM → RCPT TO → DATA → 250). Принимает либо сервер
// ВлодПочты mx.mail.bln, либо скрипт игрока на виртуальном тарифе (onMail в server.js).
import crypto from 'node:crypto';
import { q } from '../../db.js';
import { resolve } from '../dns.js';
import { netSnapshot, rtt } from '../net.js';
import { siteByTarget } from '../hosting.js';
import { gameSeconds } from '../clock.js';
import { prependHeader, rfcDate, domainOf, MAX_RAW, parseMessage } from './message.js';
import { verifyDkim } from './dkim.js';
import { checkSpf, checkDmarc } from './auth.js';

export const VLOD_MX_IP = '50.1.0.25';
export const VLOD_MX = 'mx.mail.bln';
const PUBLIC_DNS = '50.0.0.53';
export const MAX_RCPTS = 20;
const MAX_DEPTH = 3;
const disp = (n) => String(n || '').replace(/\.$/, '');

let receivers = { vlod: null, site: null };
/** Входящие серверы регистрируют себя (inbound.js), чтобы не было циклических импортов. */
export function setReceivers(r) { receivers = { ...receivers, ...r }; }

// ——— DNS с точки сервера ———

/** DNS-клиент для проверок: запросы к ВлодDNS от имени сервера ip. */
export function dnsFrom(ip, { fresh = false } = {}) {
  const ask = (name, type) => resolve({ resolverIp: PUBLIC_DNS, clientIp: ip, clientProviderId: null, name, type, fresh });
  return {
    async txt(name) {
      const r = await ask(name, 'TXT').catch(() => ({ rcode: 'SERVFAIL', answer: [] }));
      return { rcode: r.rcode, records: r.answer.filter((x) => x.type === 'TXT').map((x) => x.data) };
    },
    async addrs(name, type = 'A') {
      const r = await ask(name, type).catch(() => ({ rcode: 'SERVFAIL', answer: [] }));
      return { rcode: r.rcode, ips: r.answer.filter((x) => x.type === type).map((x) => x.data) };
    },
    async mx(name) {
      const r = await ask(name, 'MX').catch(() => ({ rcode: 'SERVFAIL', answer: [] }));
      const list = r.answer.filter((x) => x.type === 'MX').map((x) => { const [p, h] = x.data.split(' '); return { pref: Number(p), host: disp(h) }; }).sort((a, b) => a.pref - b.pref);
      return { rcode: r.rcode, list, hosts: list.map((x) => x.host) };
    },
    async ptr(addr) {
      const name = `${addr.split('.').reverse().join('.')}.in-addr.arpa`;
      const r = await ask(name, 'PTR').catch(() => ({ rcode: 'SERVFAIL', answer: [] }));
      return r.answer.filter((x) => x.type === 'PTR').map((x) => disp(x.data));
    },
  };
}

let suffixCache = null;
/** Публичные суффиксы БалНета — зоны, в которых регистрируют домены (для DMARC). */
export async function suffixes() {
  if (suffixCache && Date.now() - suffixCache.at < 60000) return suffixCache.set;
  const rows = await q('SELECT name FROM tlds');
  suffixCache = { at: Date.now(), set: new Set(rows.map((r) => disp(r.name))) };
  return suffixCache.set;
}

/**
 * Проверки входящего сервера: SPF по MAIL FROM (или HELO), DKIM, DMARC по From, обратная запись PTR.
 * vantage — адрес принимающего сервера (откуда идут DNS-запросы).
 */
export async function authenticate({ vantage, ip, helo, mailFrom, raw }) {
  const dns = dnsFrom(vantage);
  const spfDomain = mailFrom ? domainOf(mailFrom) : disp(helo);
  const [spf, dkim, ptrs] = await Promise.all([
    checkSpf({ ip, domain: spfDomain, dns }),
    verifyDkim(raw, { txt: dns.txt }),
    dns.ptr(ip),
  ]);
  let ptrOk = false;
  for (const p of ptrs.slice(0, 3)) {
    if ((await dns.addrs(p, 'A')).ips.includes(ip)) { ptrOk = true; break; }
  }
  const msg = parseMessage(raw);
  const fromDomain = msg.from ? domainOf(msg.from.address) : null;
  const dmarc = await checkDmarc({ fromDomain, spf, spfDomain, dkim, dns, suffixes: await suffixes() });
  const best = dkim.find((x) => x.result === 'pass') || dkim[0];
  return {
    msg, spfDomain, fromDomain, ptr: ptrs[0] || null, ptrOk,
    spf, dkim, dmarc,
    summary: { spf: spf.result, dkim: best ? best.result : 'none', dkim_domain: best?.domain || null, dmarc: dmarc.result },
  };
}

/** Заголовок Authentication-Results (RFC 8601). */
export function authResultsHeader(server, a) {
  const parts = [`${server}`, `spf=${a.spf.result} smtp.mailfrom=${a.spfDomain || 'unknown'}`];
  if (a.dkim.length) for (const d of a.dkim) parts.push(`dkim=${d.result} header.d=${d.domain || '?'} header.s=${d.selector || '?'}`);
  else parts.push('dkim=none');
  parts.push(`dmarc=${a.dmarc.result}${a.dmarc.policy ? ` (p=${a.dmarc.policy} dis=${a.dmarc.disposition})` : ''} header.from=${a.fromDomain || 'unknown'}`);
  return parts.join('; ');
}

// ——— Подключение к почтовому серверу ———

/** Кто слушает порт 25 на ip для имени host: { ok, receiver, ms } или { ok:false, code, text }. */
async function smtpConnect(snap, fromIp, ip, host, rcptDomain) {
  const h = snap.hostByIp.get(ip);
  const ms = rtt(snap, fromIp, ip);
  if (ms === null) return { ok: false, code: 'timeout', text: `Соединение с ${ip}:25 не установлено: сервер не отвечает` };
  if (h.kind === 'mail' && ip === VLOD_MX_IP) return { ok: true, receiver: receivers.vlod, name: VLOD_MX, ms };
  // Сервер хостинга: почту принимает тот сайт, чьё имя — MX-хост или сам домен получателя.
  const vh = snap.vhostsByIp.get(ip);
  const target = vh?.get(disp(host)) || vh?.get(disp(rcptDomain));
  if (target?.startsWith('site:')) {
    const site = await siteByTarget(target);
    if (site && site.account_status === 'active' && site.kind === 'virtual') return { ok: true, receiver: receivers.site(site), name: site.host, ms, siteId: site.id };
  }
  return { ok: false, code: 'refused', text: `Соединение с ${ip}:25 отклонено: на сервере ${h.name ? disp(h.name) : ip} нет почтового сервера` };
}

/**
 * Доставить письмо. from: { ip, helo, mailFrom, siteId? }, rcpts — адреса, raw — письмо.
 * Возвращает [{ rcpt, ok, code, text, server, transcript }].
 */
export async function deliver({ fromIp, helo, mailFrom, rcpts, raw, depth = 0, chain = [] }) {
  if (depth > MAX_DEPTH) return rcpts.map((r) => ({ rcpt: r, ok: false, code: '554', text: '5.4.6 Слишком длинная цепочка пересылки между серверами' }));
  if (Buffer.byteLength(raw) > MAX_RAW) return rcpts.map((r) => ({ rcpt: r, ok: false, code: '552', text: '5.3.4 Письмо больше 1 МБ' }));
  const byDomain = new Map();
  for (const r of rcpts.slice(0, MAX_RCPTS)) {
    const d = domainOf(r);
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d).push(r);
  }
  const dns = dnsFrom(fromIp);
  const snap = await netSnapshot();
  const out = [];
  for (const [domain, list] of byDomain) {
    const tr = [];
    const fail = (code, text) => { for (const r of list) out.push({ rcpt: r, ok: false, code, text, transcript: tr }); };
    const mx = await dns.mx(domain);
    tr.push(`DNS: ${domain} MX → ${mx.list.length ? mx.list.map((m) => `${m.pref} ${m.host}`).join(', ') : mx.rcode}`);
    if (mx.rcode === 'NXDOMAIN') { fail('550', `5.1.2 Домена ${domain} нет в БалНете (NXDOMAIN)`); continue; }
    if (mx.rcode !== 'NOERROR') { fail('451', `4.4.3 Не удалось узнать почтовые серверы ${domain} (${mx.rcode})`); continue; }
    // «MX 0 .» — домен явно не принимает почту (RFC 7505).
    if (mx.list.length === 1 && mx.list[0].host === '') { fail('556', `5.1.10 Домен ${domain} не принимает почту (null MX)`); continue; }
    const hosts = mx.list.length ? mx.list.map((m) => m.host) : [domain]; // без MX — сам домен (неявный MX)
    if (!mx.list.length) tr.push(`MX нет — пробую адрес самого домена ${domain}`);
    let conn = null;
    let lastErr = null;
    for (const host of hosts.slice(0, 5)) {
      const a = await dns.addrs(host, 'A');
      if (!a.ips.length) { tr.push(`DNS: ${host} A → ${a.rcode === 'NOERROR' ? 'нет адреса' : a.rcode}`); lastErr = `У ${host} нет A-записи`; continue; }
      for (const ip of a.ips.slice(0, 3)) {
        tr.push(`Подключение к ${host} [${ip}]:25…`);
        const c = await smtpConnect(snap, fromIp, ip, host, domain);
        if (!c.ok) { tr.push(c.text); lastErr = c.text; continue; }
        conn = { ...c, ip, host };
        break;
      }
      if (conn) break;
    }
    if (!conn) { fail('451', `4.4.1 ${lastErr || 'Почтовые серверы домена недоступны'}`); continue; }
    const id = crypto.randomBytes(5).toString('hex').toUpperCase();
    tr.push(`S: 220 ${conn.name} ESMTP БалНет`, `C: EHLO ${disp(helo)}`, `S: 250-${conn.name} Привет, ${fromIp}`, `C: MAIL FROM:<${mailFrom || ''}>`, 'S: 250 2.1.0 OK');
    const accepted = [];
    for (const r of list) {
      tr.push(`C: RCPT TO:<${r}>`);
      const res = await conn.receiver.rcpt(r);
      tr.push(`S: ${res.code} ${res.text}`);
      if (res.code.startsWith('2')) accepted.push(r);
      else out.push({ rcpt: r, ok: false, code: res.code, text: res.text, server: conn.name, transcript: [...tr] });
    }
    if (!accepted.length) { tr.push('C: QUIT'); continue; }
    tr.push('C: DATA', 'S: 354 Жду письмо, в конце «.»', `C: (${Buffer.byteLength(raw)} байт)`);
    const stamped = prependHeader(raw, 'Received', `from ${disp(helo)} ([${fromIp}]) by ${conn.name} with ESMTP id ${id}; ${rfcDate()}`);
    const later = conn.siteId && chain.includes(conn.siteId);
    const ctx = { ip: fromIp, helo: disp(helo), mailFrom: mailFrom || '', rcpts: accepted, raw: stamped, depth, chain, server: conn.name, serverIp: conn.ip, id };
    let results;
    if (later) {
      // Получатель — сайт, который сейчас сам выполняет скрипт (письмо самому себе): ставим в очередь.
      setImmediate(() => { conn.receiver.data({ ...ctx, chain: [] }).catch(() => {}); });
      results = accepted.map((r) => ({ rcpt: r, code: '250', text: `2.0.0 Принято в очередь ${id}` }));
    } else {
      results = await conn.receiver.data(ctx).catch((e) => accepted.map((r) => ({ rcpt: r, code: '451', text: `4.3.0 Сбой сервера получателя: ${e.message}` })));
    }
    for (const res of results) {
      const t = [...tr, `S: ${res.code} ${res.text}`, 'C: QUIT', `S: 221 ${conn.name} До свидания`];
      out.push({ rcpt: res.rcpt, ok: res.code.startsWith('2'), code: res.code, text: res.text, server: conn.name, folder: res.folder, transcript: t });
    }
  }
  for (const r of rcpts.slice(MAX_RCPTS)) out.push({ rcpt: r, ok: false, code: '452', text: `4.5.3 Не больше ${MAX_RCPTS} получателей в письме` });
  return out;
}

/** Запись в журнал почтового сервера. */
export async function logMail(e) {
  await q('INSERT INTO mail_log (server, from_ip, helo, mail_from, header_from, rcpt, status, code, detail, spf, dkim, dmarc, spam_score, message_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)', [
    e.server, e.ip, e.helo || null, e.mailFrom || null, e.headerFrom || null, e.rcpt, e.status, e.code || null, (e.detail || '').slice(0, 500) || null,
    e.spf || null, e.dkim || null, e.dmarc || null, e.score ?? null, (e.messageId || '').slice(0, 250) || null,
  ]).catch(() => {});
}

export const now = gameSeconds;
