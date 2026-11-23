// ВлодПочта: ящики (логин@mail.bln), почта для своих доменов (MX, SPF, DKIM, DMARC), приём писем сервером
// mx.mail.bln (проверки, спам-фильтр, папки), отправка с подписью DKIM, отказы (bounce), уведомления.
import { q, one } from '../../db.js';
import { bad, notFound, forbidden, need, conflict } from '../errors.js';
import { publish, userChannel } from '../hub.js';
import { sendMail } from '../mail.js';
import { gameSeconds } from '../clock.js';
import { canManage } from '../domains.js';
import { fqdn } from '@bln/shared/balnet-dns.js';
import { buildMessage, parseMessage, normAddress, domainOf, prependHeader, rfcDate, newMessageId } from './message.js';
import { signDkim, generateDkimKey, dkimRecord, txtJoin } from './dkim.js';
import { deliver, authenticate, authResultsHeader, logMail, setReceivers, dnsFrom, VLOD_MX, VLOD_MX_IP, MAX_RCPTS } from './mta.js';
import { scoreMessage } from './spam.js';

export const MAIL_DOMAIN = 'mail.bln';
const LOGIN_RE = /^[a-z0-9](?:[a-z0-9._-]{0,38}[a-z0-9])?$/;
const RESERVED = new Set(['admin', 'administrator', 'postmaster', 'abuse', 'hostmaster', 'webmaster', 'root', 'mailer-daemon', 'noreply', 'no-reply', 'support', 'security', 'welcome', 'info', 'mail', 'www', 'bank', 'gov', 'police']);
const DAILY_LIMIT = 200;
const NOTIFY_EVERY_MS = 15 * 60 * 1000;
const sent24 = new Map(); // account → [время отправки]

// ——— Ящики ———

export const accountOf = (govUserId) => one('SELECT * FROM mail_accounts WHERE gov_user_id = ?', [govUserId]);

export async function needAccount(govUserId) {
  const a = await accountOf(govUserId);
  if (!a) throw bad('no_mailbox', 'Сначала создайте ящик на ВлодПочте');
  if (a.status !== 'active') throw forbidden('Ящик заблокирован администрацией');
  return a;
}

async function mailDomain(name) {
  return one('SELECT * FROM mail_domains WHERE name = ?', [String(name).toLowerCase()]);
}

export async function createAccount(govUserId, login, name) {
  const l = String(login || '').trim().toLowerCase();
  need(LOGIN_RE.test(l) && !l.includes('..'), 'Логин: латинские буквы, цифры, точка, дефис и «_», от 1 до 40 символов');
  need(!RESERVED.has(l), 'Этот адрес зарезервирован');
  if (await accountOf(govUserId)) throw conflict('exists', 'Ящик уже создан');
  const gov = await one('SELECT display_name FROM gov_users WHERE id = ?', [govUserId]);
  const address = `${l}@${MAIL_DOMAIN}`;
  if (await one('SELECT id FROM mail_addresses WHERE address = ?', [address])) throw conflict('taken', 'Адрес уже занят');
  let r;
  try {
    r = await q('INSERT INTO mail_accounts (gov_user_id, login, name) VALUES (?, ?, ?)', [govUserId, l, String(name || gov?.display_name || '').slice(0, 80) || null]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw conflict('taken', 'Адрес уже занят');
    throw e;
  }
  const d = await mailDomain(MAIL_DOMAIN);
  await q('INSERT INTO mail_addresses (address, domain_id, account_id) VALUES (?, ?, ?)', [address, d.id, r.insertId]);
  const acc = await one('SELECT * FROM mail_accounts WHERE id = ?', [r.insertId]);
  // Приветствие идёт по настоящему пути: с сервера ВлодПочты, с подписью DKIM, через MX.
  await systemMail({
    from: { name: 'ВлодПочта', address: `welcome@${MAIL_DOMAIN}` }, to: address,
    subject: 'Добро пожаловать во ВлодПочту',
    text: `Здравствуйте${acc.name ? `, ${acc.name}` : ''}!\n\nВаш адрес: ${address}.\n\nЭто письмо прошло весь путь настоящей почты: сервер ВлодПочты нашёл MX домена mail.bln, подключился к mx.mail.bln и передал письмо по SMTP. Откройте «Показать оригинал», чтобы увидеть заголовки Received, DKIM-Signature и Authentication-Results.\n\nВ настройках можно подключить почту на своём домене и войти во ВлодБраузер, чтобы синхронизировать закладки, историю и пароли.`,
  }).catch(() => {});
  return acc;
}

export async function addressesOf(accountId) {
  return q('SELECT a.address, a.domain_id, d.name AS domain FROM mail_addresses a JOIN mail_domains d ON d.id = a.domain_id WHERE a.account_id = ? ORDER BY a.domain_id = (SELECT id FROM mail_domains WHERE name = ?) DESC, a.address', [accountId, MAIL_DOMAIN]);
}

// ——— Свои домены ———

/** Записи DNS, которые нужны домену для почты во ВлодПочте. */
export function requiredRecords(d) {
  return [
    { key: 'mx', name: d.name, type: 'MX', data: `10 ${VLOD_MX}.`, title: 'MX — куда доставлять почту' },
    { key: 'spf', name: d.name, type: 'TXT', data: `"v=spf1 include:_spf.${MAIL_DOMAIN} -all"`, title: 'SPF — кому разрешено отправлять' },
    { key: 'dkim', name: `${d.selector}._domainkey.${d.name}`, type: 'TXT', data: `"${dkimRecord(d.dkim_public)}"`, title: 'DKIM — ключ подписи писем' },
    { key: 'dmarc', name: `_dmarc.${d.name}`, type: 'TXT', data: `"v=DMARC1; p=quarantine; rua=mailto:postmaster@${d.name}"`, title: 'DMARC — что делать с подделками' },
  ];
}

/** Проверить записи домена через ВлодDNS (с сервера ВлодПочты). */
export async function checkDomain(d) {
  const dns = dnsFrom(VLOD_MX_IP, { fresh: true });
  const mx = await dns.mx(d.name);
  const spf = (await dns.txt(d.name)).records.map(txtJoin).find((s) => /^v=spf1/i.test(s)) || null;
  const dk = (await dns.txt(`${d.selector}._domainkey.${d.name}`)).records.map(txtJoin).find((s) => /p=/.test(s)) || null;
  const dm = (await dns.txt(`_dmarc.${d.name}`)).records.map(txtJoin).find((s) => /^v=DMARC1/i.test(s)) || null;
  const checks = {
    mx: { ok: mx.hosts.includes(VLOD_MX), found: mx.list.map((m) => `${m.pref} ${m.host}`).join(', ') || null },
    spf: { ok: !!spf && (spf.includes(`include:_spf.${MAIL_DOMAIN}`) || spf.includes(`ip4:${VLOD_MX_IP}`)), found: spf },
    dkim: { ok: !!dk && dk.replace(/\s/g, '').includes(`p=${d.dkim_public}`), found: dk },
    dmarc: { ok: !!dm, found: dm },
  };
  await q('UPDATE mail_domains SET checks = ?, checked_at = NOW(3) WHERE id = ?', [JSON.stringify(checks), d.id]);
  return checks;
}

export async function addDomain(govUserId, input) {
  const name = fqdn(String(input || ''));
  need(name && name !== '.', 'Неверное имя домена');
  const n = name.replace(/\.$/, '');
  const dom = await one("SELECT * FROM domains WHERE live_name = ? AND status IN ('active','expired')", [name]);
  if (!dom) throw notFound('Такого зарегистрированного домена нет. Купите его на БалРеге');
  if (!(await canManage(null, dom, govUserId))) throw forbidden('Подключить почту может только владелец домена');
  if (await mailDomain(n)) throw conflict('exists', 'Домен уже подключён к ВлодПочте');
  const k = generateDkimKey();
  await q('INSERT INTO mail_domains (name, owner_gov_user_id, selector, dkim_public, dkim_private) VALUES (?, ?, ?, ?, ?)', [n, govUserId, 'vlod1', k.publicKey, k.privateKey]);
  return mailDomain(n);
}

export async function ownMailDomain(govUserId, id) {
  const d = await one('SELECT * FROM mail_domains WHERE id = ?', [id]);
  if (!d || d.owner_gov_user_id !== govUserId) throw notFound('Домен не найден');
  return d;
}

/** Записать нужные записи в зону домена, если он на DNS-хостинге БалНета (ns1/ns2.dns.bln). */
export async function autoRecords(d) {
  const dom = await one('SELECT * FROM domains WHERE live_name = ?', [`${d.name}.`]);
  need(dom?.zone_id && dom.ns_mode === 'hosted', 'Домен обслуживают свои серверы имён — добавьте записи у себя вручную');
  const { bumpSerial } = await import('../zones.js');
  const { invalidateNet } = await import('../net.js');
  for (const r of requiredRecords(d)) {
    const owner = `${r.name}.`;
    if (r.type === 'MX') await q("DELETE FROM dns_records WHERE zone_id = ? AND name = ? AND type = 'MX'", [dom.zone_id, owner]);
    else {
      const prefix = r.key === 'spf' ? 'v=spf1' : r.key === 'dmarc' ? 'v=DMARC1' : 'v=DKIM1';
      const old = await q("SELECT id, data FROM dns_records WHERE zone_id = ? AND name = ? AND type = 'TXT'", [dom.zone_id, owner]);
      for (const o of old) if (txtJoin(o.data).startsWith(prefix)) await q('DELETE FROM dns_records WHERE id = ?', [o.id]);
    }
    await q('INSERT INTO dns_records (zone_id, name, type, ttl, data) VALUES (?, ?, ?, 3600, ?)', [dom.zone_id, owner, r.type, r.data]);
  }
  await bumpSerial(null, dom.zone_id);
  invalidateNet();
}

/** Новый адрес на своём домене: владельцу или другому ящику ВлодПочты (по его адресу на mail.bln). */
export async function addAddress(govUserId, domainId, local, forLogin = null) {
  const d = await ownMailDomain(govUserId, domainId);
  const address = normAddress(`${String(local || '').trim()}@${d.name}`);
  need(address, 'Неверный адрес');
  let acc;
  if (forLogin) {
    acc = await one('SELECT * FROM mail_accounts WHERE login = ?', [String(forLogin).trim().toLowerCase().replace(/@mail\.bln$/, '')]);
    if (!acc) throw notFound('Ящика с таким адресом на mail.bln нет');
  } else acc = await needAccount(govUserId);
  const n = await one('SELECT COUNT(*) AS n FROM mail_addresses WHERE domain_id = ?', [d.id]);
  need(Number(n.n) < 50, 'Не больше 50 адресов на домен');
  try {
    await q('INSERT INTO mail_addresses (address, domain_id, account_id) VALUES (?, ?, ?)', [address, d.id, acc.id]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw conflict('exists', 'Такой адрес уже есть');
    throw e;
  }
  return address;
}

// ——— Хранение ———

const snippetOf = (t) => String(t || '').replace(/\s+/g, ' ').trim().slice(0, 200);

async function store(accountId, folder, raw, msg, extra = {}) {
  const r = await q(`INSERT INTO mail_messages (account_id, folder, rcpt, message_id, in_reply_to, from_addr, from_name, to_addrs, cc_addrs, subject, snippet, body_text, body_html, raw, auth, spam_score, spam_reasons, seen, size, game_time)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`, [
    accountId, folder, extra.rcpt || null, msg.messageId, msg.inReplyTo, msg.from?.address || 'unknown', msg.from?.name || null,
    JSON.stringify(msg.to), JSON.stringify(msg.cc), msg.subject, snippetOf(msg.text), (msg.text || '').slice(0, 500000), msg.html ? msg.html.slice(0, 500000) : null,
    raw, extra.auth ? JSON.stringify(extra.auth) : null, extra.score || 0, extra.reasons ? JSON.stringify(extra.reasons) : null, extra.seen ? 1 : 0, Buffer.byteLength(raw), await gameSeconds(),
  ]);
  return r.insertId;
}

async function notifyNew(acc, msgId, msg, folder) {
  const gov = acc.gov_user_id;
  publish(userChannel('gov', gov), { type: 'mail', folder, message: { id: msgId, from: msg.from, subject: msg.subject } });
  if (folder !== 'inbox' || !acc.notify_email) return;
  if (acc.notified_at && Date.now() - new Date(acc.notified_at).getTime() < NOTIFY_EVERY_MS) return;
  await q('UPDATE mail_accounts SET notified_at = NOW(3) WHERE id = ?', [acc.id]);
  const u = await one('SELECT email FROM gov_users WHERE id = ?', [gov]);
  // На настоящий email — только уведомление, без текста письма.
  if (u) await sendMail({ to: u.email, brand: 'ВлодПочта', subject: 'Новое письмо в БалНете', text: `В ваш ящик ${acc.login}@${MAIL_DOMAIN} пришло новое письмо. Прочитать его можно во ВлодПочте (mail.bln) во ВлодБраузере.` }).catch(() => {});
}

async function knownSender(accountId, address) {
  return !!(await one('SELECT 1 AS x FROM mail_contacts WHERE account_id = ? AND address = ?', [accountId, address]));
}

// ——— Входящий сервер mx.mail.bln ———

async function lookupRcpt(addr) {
  const a = normAddress(addr);
  if (!a) return { code: '501', text: '5.1.3 Неверный адрес' };
  const d = await mailDomain(domainOf(a));
  if (!d) return { code: '550', text: `5.7.1 Пересылка запрещена: mx.mail.bln не принимает почту для ${domainOf(a)}` };
  let row = await one('SELECT m.*, x.address FROM mail_addresses x JOIN mail_accounts m ON m.id = x.account_id WHERE x.address = ?', [a]);
  if (!row && d.catch_all_account_id) row = await one('SELECT *, ? AS address FROM mail_accounts WHERE id = ?', [a, d.catch_all_account_id]);
  if (!row || row.status !== 'active') return { code: '550', text: `5.1.1 Ящика ${a} нет` };
  return { code: '250', text: '2.1.5 OK', account: row };
}

const vlodReceiver = {
  name: VLOD_MX,
  rcpt: async (addr) => { const r = await lookupRcpt(addr); return { code: r.code, text: r.text }; },
  async data(ctx) {
    const a = await authenticate({ vantage: VLOD_MX_IP, ip: ctx.ip, helo: ctx.helo, mailFrom: ctx.mailFrom, raw: ctx.raw });
    const auth = { spf: a.spf.result, spf_why: a.spf.why, dkim: a.summary.dkim, dkim_domain: a.summary.dkim_domain, dkim_why: a.dkim.map((x) => x.why).filter(Boolean)[0] || null, dmarc: a.dmarc.result, dmarc_why: a.dmarc.why, dmarc_policy: a.dmarc.policy || null, ptr: a.ptr, ptr_ok: a.ptrOk, ip: ctx.ip, helo: ctx.helo, mail_from: ctx.mailFrom };
    const raw = prependHeader(ctx.raw, 'Authentication-Results', authResultsHeader(VLOD_MX, a));
    const base = { server: VLOD_MX, ip: ctx.ip, helo: ctx.helo, mailFrom: ctx.mailFrom, headerFrom: a.msg.from?.address, spf: auth.spf, dkim: auth.dkim, dmarc: auth.dmarc, messageId: a.msg.messageId };
    if (a.dmarc.disposition === 'reject') {
      for (const r of ctx.rcpts) await logMail({ ...base, rcpt: r, status: 'rejected', code: '550', detail: a.dmarc.why });
      return ctx.rcpts.map((r) => ({ rcpt: r, code: '550', text: `5.7.1 Отклонено по DMARC: ${a.dmarc.why}` }));
    }
    const out = [];
    for (const r of ctx.rcpts) {
      const lk = await lookupRcpt(r);
      if (!lk.account) { out.push({ rcpt: r, code: lk.code, text: lk.text }); continue; }
      const acc = lk.account;
      const sc = await scoreMessage(a.msg, { accountId: acc.id, auth, ptrOk: a.ptrOk, knownSender: a.msg.from ? await knownSender(acc.id, a.msg.from.address) : false });
      const quarantine = a.dmarc.disposition === 'quarantine';
      const spam = quarantine || sc.score >= Number(acc.spam_threshold || 50);
      const reasons = quarantine ? [{ rule: 'DMARC_QUARANTINE', points: 0, text: 'Политика DMARC отправителя: карантин' }, ...sc.reasons] : sc.reasons;
      const stamped = prependHeader(raw, 'X-Spam-Status', `${spam ? 'Yes' : 'No'}, score=${(sc.score / 10).toFixed(1)} required=${(Number(acc.spam_threshold || 50) / 10).toFixed(1)} tests=${sc.reasons.map((x) => x.rule).join(',') || 'none'}`);
      const folder = spam ? 'spam' : 'inbox';
      const id = await store(acc.id, folder, stamped, a.msg, { rcpt: r, auth, score: sc.score, reasons });
      await logMail({ ...base, rcpt: r, status: spam ? 'spam' : 'delivered', code: '250', score: sc.score });
      await notifyNew(acc, id, a.msg, folder);
      out.push({ rcpt: r, code: '250', text: `2.0.0 Принято, ${ctx.id}`, folder });
    }
    return out;
  },
};

// ——— Скрипт игрока: onMail(message) в server.js ———

function siteReceiver(site) {
  return {
    name: site.host,
    rcpt: async () => ({ code: '250', text: '2.1.5 OK' }),
    async data(ctx) {
      const { runSite } = await import('../vhost/respond.js');
      const a = await authenticate({ vantage: site.server_ip, ip: ctx.ip, helo: ctx.helo, mailFrom: ctx.mailFrom, raw: ctx.raw });
      const arg = {
        from: a.msg.from, to: ctx.rcpts, mailFrom: ctx.mailFrom, ip: ctx.ip, helo: ctx.helo,
        subject: a.msg.subject, text: a.msg.text, html: a.msg.html, messageId: a.msg.messageId,
        headers: Object.fromEntries(a.msg.headers.slice(0, 60).map((h) => [h.name.toLowerCase(), h.value])),
        raw: ctx.raw.slice(0, 256 * 1024),
        auth: { spf: a.spf.result, dkim: a.summary.dkim, dkim_domain: a.summary.dkim_domain, dmarc: a.dmarc.result, dmarc_policy: a.dmarc.policy || null },
      };
      let v;
      try {
        const r = await runSite(site, 'onMail', arg, { depth: ctx.depth + 1, chain: [...(ctx.chain || []), site.id] });
        v = r?.value;
      } catch (e) {
        const code = e.kind === 'missing' ? '550' : '451';
        const text = e.kind === 'missing' ? '5.7.0 На сервере нет обработчика onMail в server.js' : `4.3.0 Ошибка скрипта: ${e.message}`;
        return ctx.rcpts.map((r) => ({ rcpt: r, code, text }));
      }
      const reject = v === false ? 'Письмо отклонено сервером' : v && typeof v === 'object' && v.reject ? String(v.reject).slice(0, 200) : null;
      return ctx.rcpts.map((r) => (reject ? { rcpt: r, code: '550', text: `5.7.1 ${reject}` } : { rcpt: r, code: '250', text: `2.0.0 Принято скриптом ${site.host}` }));
    },
  };
}

setReceivers({ vlod: vlodReceiver, site: siteReceiver });

// ——— Отправка ———

/** Отказ (bounce) отправителю от MAILER-DAEMON — как настоящий DSN с SMTP-диалогом. */
async function bounce(acc, msg, failed) {
  const lines = failed.map((f) => `${f.rcpt}\n  ${f.code} ${f.text}${f.server ? `\n  Сервер: ${f.server}` : ''}\n\n  Диалог:\n${(f.transcript || []).map((t) => `    ${t}`).join('\n')}`);
  const { raw } = buildMessage({
    from: { name: 'Служба доставки почты', address: `mailer-daemon@${VLOD_MX}` }, to: [`${acc.login}@${MAIL_DOMAIN}`],
    subject: `Не доставлено: ${msg.subject || '(без темы)'}`,
    text: `Это автоматическое сообщение сервера ${VLOD_MX}.\n\nПисьмо не удалось доставить этим получателям:\n\n${lines.join('\n\n')}\n\nИсходное письмо: «${msg.subject || '(без темы)'}», Message-ID <${msg.messageId}>.`,
    inReplyTo: msg.messageId,
  });
  const parsed = parseMessage(raw);
  const id = await store(acc.id, 'inbox', raw, parsed, { auth: { spf: 'pass', dkim: 'none', dmarc: 'none', local: true } });
  await notifyNew(acc, id, parsed, 'inbox');
}

function rateCheck(accId) {
  const t = Date.now();
  const list = (sent24.get(accId) || []).filter((x) => x > t - 86400000);
  need(list.length < DAILY_LIMIT, `Не больше ${DAILY_LIMIT} писем в сутки`, 'rate_limited');
  list.push(t);
  sent24.set(accId, list);
}

function recipients(list) {
  const out = [];
  for (const raw of (Array.isArray(list) ? list : String(list || '').split(/[,;\s]+/)).filter(Boolean)) {
    const v = typeof raw === 'object' ? raw.address : String(raw).replace(/^.*<([^>]+)>.*$/, '$1');
    const a = normAddress(v);
    need(a, `Неверный адрес: ${v}`);
    if (!out.includes(a)) out.push(a);
  }
  return out;
}

/** Отправить письмо из ящика. b: { from (адрес ящика), to, cc, bcc, subject, text, html, inReplyTo }. */
export async function sendFromAccount(acc, b) {
  const addrs = (await addressesOf(acc.id)).map((x) => x.address);
  const from = normAddress(b.from) || addrs[0];
  need(addrs.includes(from), 'Отправлять можно только со своих адресов');
  const to = recipients(b.to);
  const cc = recipients(b.cc);
  const bcc = recipients(b.bcc);
  const all = [...new Set([...to, ...cc, ...bcc])];
  need(all.length, 'Укажите получателя');
  need(all.length <= MAX_RCPTS, `Не больше ${MAX_RCPTS} получателей`);
  const subject = String(b.subject || '').slice(0, 300);
  let text = String(b.text || '').slice(0, 200000);
  if (acc.signature && !b.noSignature) text += `\n\n-- \n${acc.signature}`;
  rateCheck(acc.id);
  const d = await mailDomain(domainOf(from));
  const built = buildMessage({ from: { name: acc.name, address: from }, to, cc, subject, text, html: b.html ? String(b.html).slice(0, 200000) : null, inReplyTo: b.inReplyTo || null, extra: [['X-Mailer', 'ВлодПочта (mail.bln)']] });
  let raw = prependHeader(built.raw, 'Received', `from [вэб-интерфейс] by ${VLOD_MX} with HTTPSA (вход: ${acc.login}@${MAIL_DOMAIN}); ${rfcDate()}`);
  raw = signDkim(raw, { domain: d.name, selector: d.selector, privateKey: d.dkim_private });
  const msg = parseMessage(raw);
  const sentId = await store(acc.id, 'sent', raw, msg, { seen: true });
  for (const a of all) {
    await q('INSERT INTO mail_contacts (account_id, address, sent) VALUES (?, ?, 1) ON DUPLICATE KEY UPDATE sent = sent + 1, last_at = NOW(3)', [acc.id, a]);
  }
  const results = await deliver({ fromIp: VLOD_MX_IP, helo: VLOD_MX, mailFrom: from, rcpts: all, raw });
  const failed = results.filter((r) => !r.ok);
  if (failed.length) await bounce(acc, msg, failed);
  return { id: sentId, messageId: msg.messageId, results: results.map(({ rcpt, ok, code, text, server, folder }) => ({ rcpt, ok, code, text, server, folder })) };
}

/** Письмо от служебного адреса ВлодПочты (приветствие и т. п.) — тоже через MX и с подписью. */
export async function systemMail({ from, to, subject, text }) {
  const d = await mailDomain(MAIL_DOMAIN);
  const { raw } = buildMessage({ from, to: [to], subject, text, messageId: newMessageId(MAIL_DOMAIN) });
  const signed = signDkim(raw, { domain: d.name, selector: d.selector, privateKey: d.dkim_private });
  return deliver({ fromIp: VLOD_MX_IP, helo: VLOD_MX, mailFrom: from.address, rcpts: [to], raw: signed });
}

/** Отправка из серверного скрипта сайта: mail.send({ from, to, subject, text, html, dkim }). */
export async function sendFromSite(site, req, { depth = 0, chain = [] } = {}) {
  const fs = await import('node:fs/promises');
  const { safeJoin } = await import('../sitefs.js');
  const from = typeof req.from === 'object' && req.from ? { name: req.from.name || null, address: normAddress(req.from.address) } : { name: null, address: normAddress(req.from) };
  if (!from.address) return { error: 'mail.send: неверный адрес from' };
  let to;
  try { to = recipients(req.to); } catch (e) { return { error: `mail.send: ${e.message}` }; }
  if (!to.length) return { error: 'mail.send: нет получателей' };
  if (to.length > MAX_RCPTS) return { error: `mail.send: не больше ${MAX_RCPTS} получателей` };
  const key = `site:${site.id}`;
  const t = Date.now();
  const list = (sent24.get(key) || []).filter((x) => x > t - 3600000);
  if (list.length >= 30) return { error: 'mail.send: не больше 30 писем в час с одного сайта' };
  list.push(t);
  sent24.set(key, list);
  const extra = [];
  for (const [k, v] of Object.entries(req.headers || {}).slice(0, 10)) {
    if (/^x-[a-z0-9-]{1,40}$/i.test(k)) extra.push([k, String(v).replace(/[\r\n]/g, ' ').slice(0, 300)]);
  }
  let raw;
  try {
    raw = buildMessage({ from, to, subject: String(req.subject || '').slice(0, 300), text: String(req.text || '').slice(0, 100000), html: req.html ? String(req.html).slice(0, 100000) : null, replyTo: normAddress(req.replyTo) || null, inReplyTo: req.inReplyTo || null, extra }).raw;
  } catch (e) { return { error: `mail.send: ${e.message}` }; }
  if (req.dkim) {
    const sel = String(req.dkim);
    if (!/^[a-z0-9-]{1,63}$/i.test(sel)) return { error: 'mail.send: dkim — имя селектора' };
    let pk;
    try { pk = (await fs.readFile(safeJoin(site.dir, `.dkim/${sel}.key`).full, 'utf8')).trim(); } catch { return { error: `mail.send: нет ключа .dkim/${sel}.key — создайте его в панели БалХоста` }; }
    try { raw = signDkim(raw, { domain: domainOf(from.address), selector: sel, privateKey: pk }); } catch { return { error: 'mail.send: ключ DKIM повреждён' }; }
  }
  const mailFrom = normAddress(req.mailFrom) || from.address;
  const results = await deliver({ fromIp: site.server_ip, helo: site.host, mailFrom, rcpts: to, raw, depth, chain });
  for (const r of results) await logMail({ server: site.host, ip: site.server_ip, helo: site.host, mailFrom, headerFrom: from.address, rcpt: r.rcpt, status: 'script', code: r.code, detail: r.text });
  return { ok: results.every((r) => r.ok), results: results.map(({ rcpt, ok, code, text, server }) => ({ rcpt, ok, code, text, server })) };
}

// ——— Представление писем ———

const J = (v) => (typeof v === 'string' ? JSON.parse(v) : v);
export const listView = (m) => ({
  id: m.id, folder: m.folder, from: { address: m.from_addr, name: m.from_name }, to: J(m.to_addrs) || [], subject: m.subject, snippet: m.snippet,
  seen: !!m.seen, starred: !!m.starred, spam_score: m.spam_score, created_at: m.created_at, game_time: Number(m.game_time), auth: J(m.auth),
});
export const fullView = (m) => ({ ...listView(m), cc: J(m.cc_addrs) || [], rcpt: m.rcpt, message_id: m.message_id, in_reply_to: m.in_reply_to, text: m.body_text, html: m.body_html, spam_reasons: J(m.spam_reasons) || [], size: m.size });
