// Проверки отправителя на входящем сервере: SPF (RFC 7208) и DMARC (RFC 7489).
// DNS — через резолвер БалНета с точки сервера-получателя (lookup ниже), лимит 10 DNS-механизмов SPF.
import { inCidr, isIPv4, isIPv6 } from '@bln/shared/balnet-ip.js';
import { txtJoin, parseTags } from './dkim.js';

const MAX_LOOKUPS = 10;

/**
 * dns: { txt(name) → { rcode, records }, addrs(name, type) → { rcode, ips }, mx(name) → { rcode, hosts } }.
 * Возвращает { result: pass|fail|softfail|neutral|none|permerror|temperror, record, why, mechanism }.
 */
export async function checkSpf({ ip, domain, dns }) {
  const ctx = { lookups: 0, dns, ip };
  try {
    return await evaluate(ctx, String(domain || '').toLowerCase().replace(/\.$/, ''), 0);
  } catch (e) {
    if (e.spf) return e.spf;
    throw e;
  }
}

const QUAL = { '+': 'pass', '-': 'fail', '~': 'softfail', '?': 'neutral' };
const perm = (why) => { const e = new Error(why); e.spf = { result: 'permerror', why }; return e; };

async function spfRecord(ctx, domain) {
  const r = await ctx.dns.txt(domain);
  if (r.rcode === 'SERVFAIL' || r.rcode === 'TIMEOUT') return { temp: true };
  const recs = r.records.map(txtJoin).filter((s) => /^v=spf1(\s|$)/i.test(s.trim()));
  if (recs.length > 1) throw perm(`У ${domain} несколько записей SPF`);
  return { record: recs[0] || null, nx: r.rcode === 'NXDOMAIN' };
}

function ipMatches(ip, net, cidrDefault) {
  if (!net) return false;
  const [addr, len] = net.split('/');
  if (isIPv4(ip) !== isIPv4(addr)) return false;
  const bits = len !== undefined ? Number(len) : cidrDefault;
  try { return inCidr(ip, `${addr}/${bits}`); } catch { return false; }
}

async function evaluate(ctx, domain, depth) {
  if (depth > 10) throw perm('Слишком глубокие include/redirect');
  const got = await spfRecord(ctx, domain);
  if (got.temp) return { result: 'temperror', why: `DNS не ответил для ${domain}` };
  if (!got.record) return depth === 0 ? { result: 'none', why: `У ${domain} нет записи SPF` } : { result: 'permerror', why: `include:${domain} — нет записи SPF` };
  const terms = got.record.trim().split(/\s+/).slice(1);
  let redirect = null;
  const count = () => { if (++ctx.lookups > MAX_LOOKUPS) throw perm('Больше 10 DNS-запросов в SPF'); };
  for (const term of terms) {
    const mm = /^([a-z]+)=(.*)$/i.exec(term);
    if (mm) { if (mm[1].toLowerCase() === 'redirect') redirect = mm[2]; continue; }
    const q = QUAL[term[0]] ? term[0] : '+';
    const body = QUAL[term[0]] ? term.slice(1) : term;
    const [mech, ...rest] = body.split(':');
    const arg = rest.join(':');
    const m = mech.toLowerCase();
    let hit = false;
    if (m === 'all') hit = true;
    else if (m === 'ip4') hit = isIPv4(arg.split('/')[0]) ? ipMatches(ctx.ip, arg, 32) : (() => { throw perm(`Неверный ip4:${arg}`); })();
    else if (m === 'ip6') hit = isIPv6(arg.split('/')[0]) && ipMatches(ctx.ip, arg, 128);
    else if (m === 'a' || m.startsWith('a/')) {
      count();
      const [host, len] = (arg || domain).split('/');
      const r = await ctx.dns.addrs(host || domain, isIPv4(ctx.ip) ? 'A' : 'AAAA');
      hit = r.ips.some((x) => ipMatches(ctx.ip, len ? `${x}/${len}` : x, isIPv4(x) ? 32 : 128));
    } else if (m === 'mx') {
      count();
      const r = await ctx.dns.mx(arg || domain);
      for (const h of r.hosts.slice(0, 10)) {
        const a = await ctx.dns.addrs(h, isIPv4(ctx.ip) ? 'A' : 'AAAA');
        if (a.ips.some((x) => ipMatches(ctx.ip, x, isIPv4(x) ? 32 : 128))) { hit = true; break; }
      }
    } else if (m === 'include') {
      count();
      if (!arg) throw perm('include без домена');
      const r = await evaluate(ctx, arg.toLowerCase(), depth + 1);
      if (r.result === 'temperror' || r.result === 'permerror') return r;
      hit = r.result === 'pass';
    } else if (m === 'exists') {
      count();
      const r = await ctx.dns.addrs(arg, 'A');
      hit = r.ips.length > 0;
    } else if (m === 'ptr') {
      count(); // устаревший механизм: не совпадает
    } else throw perm(`Неизвестный механизм SPF «${term}»`);
    if (hit) return { result: QUAL[q], record: got.record, mechanism: term, domain, why: q === '+' ? `Адрес ${ctx.ip} разрешён записью SPF домена ${domain} (${term})` : `Адрес ${ctx.ip} запрещён SPF домена ${domain} (${term})` };
  }
  if (redirect) {
    count();
    return evaluate(ctx, redirect.toLowerCase(), depth + 1);
  }
  return { result: 'neutral', record: got.record, domain, why: `SPF домена ${domain} ничего не говорит про ${ctx.ip}` };
}

// ——— DMARC ———

/** Организационный домен: имя + публичный суффикс (зона регистрации). suffixes — множество «bln», «gov.bln», … */
export function orgDomain(domain, suffixes) {
  const d = String(domain).toLowerCase().replace(/\.$/, '');
  const labels = d.split('.');
  for (let i = 1; i < labels.length; i++) {
    const suffix = labels.slice(i).join('.');
    if (suffixes.has(suffix)) return labels.slice(i - 1).join('.');
  }
  return labels.slice(-2).join('.');
}

const aligned = (a, b, mode, suffixes) => {
  if (!a || !b) return false;
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  return mode === 's' ? x === y : orgDomain(x, suffixes) === orgDomain(y, suffixes);
};

/**
 * DMARC для домена из From. spf — результат SPF по MAIL FROM (spfDomain), dkim — список подписей.
 * Возвращает { result: pass|fail|none|temperror|permerror, policy, disposition: none|quarantine|reject, record, why }.
 */
export async function checkDmarc({ fromDomain, spf, spfDomain, dkim, dns, suffixes }) {
  const d = String(fromDomain || '').toLowerCase();
  if (!d) return { result: 'permerror', disposition: 'reject', why: 'Нет домена в заголовке From' };
  const org = orgDomain(d, suffixes);
  const lookup = async (name) => {
    const r = await dns.txt(`_dmarc.${name}`);
    if (r.rcode === 'SERVFAIL' || r.rcode === 'TIMEOUT') return { temp: true };
    const recs = r.records.map(txtJoin).filter((s) => /^v=DMARC1\s*(;|$)/i.test(s.trim()));
    return { record: recs.length === 1 ? recs[0] : null };
  };
  let found = await lookup(d);
  let sub = false;
  if (!found.temp && !found.record && org !== d) { found = await lookup(org); sub = true; }
  if (found.temp) return { result: 'temperror', disposition: 'none', why: 'DNS не ответил на запрос DMARC' };
  if (!found.record) return { result: 'none', disposition: 'none', why: `У ${d} нет записи DMARC` };
  const t = parseTags(found.record.replace(/^v=DMARC1\s*;?/i, ''));
  const p = ['none', 'quarantine', 'reject'].includes(t.p) ? t.p : null;
  if (!p) return { result: 'permerror', disposition: 'none', record: found.record, why: 'В записи DMARC нет политики p=' };
  const policy = sub && ['none', 'quarantine', 'reject'].includes(t.sp) ? t.sp : p;
  const spfOk = spf?.result === 'pass' && aligned(spfDomain, d, t.aspf === 's' ? 's' : 'r', suffixes);
  const dkimOk = (dkim || []).some((x) => x.result === 'pass' && aligned(x.domain, d, t.adkim === 's' ? 's' : 'r', suffixes));
  const base = { policy, record: found.record, spf_aligned: spfOk, dkim_aligned: dkimOk, rua: t.rua || null };
  if (spfOk || dkimOk) return { ...base, result: 'pass', disposition: 'none', why: dkimOk ? `Подпись DKIM домена ${d} верна` : `SPF пройден для домена ${spfDomain}, он совпадает с From` };
  // pct= — доля писем, к которым применяется политика (остальные — на ступень мягче).
  const pct = t.pct !== undefined ? Math.max(0, Math.min(100, Number(t.pct) || 0)) : 100;
  const applied = Math.random() * 100 < pct ? policy : policy === 'reject' ? 'quarantine' : 'none';
  return { ...base, result: 'fail', disposition: applied, why: `Ни SPF, ни DKIM не подтверждают домен ${d} из поля From — политика DMARC «${policy}»` };
}
