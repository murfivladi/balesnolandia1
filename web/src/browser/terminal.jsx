// Терминал ВлодБраузера: сетевые утилиты БалНета с выводом как у настоящих.
import { useEffect, useRef, useState } from 'react';
import { formatRR } from '@bln/shared/balnet-dns.js';
import { isIP } from '@bln/shared/balnet-ip.js';
import { netCall, lease, resolverOf } from './net.js';
import { get, post } from '../shared/api.js';
import { gameDateLabel } from '@bln/shared/time.js';
import { checkTls, gameDate } from './certs.jsx';

const HELP = [
  'Команды:',
  '  ipconfig                   — адрес устройства, шлюз, DNS',
  '  nslookup <имя> [сервер]    — найти адрес',
  '  host <имя>                 — адреса и почтовые серверы имени',
  '  dig [@сервер] <имя> [тип] [+trace] [+short] [+norec] [+dnssec] [+cd]',
  '                             — DNS-запрос; типы: A AAAA CNAME MX TXT NS SOA SRV CAA PTR DS DNSKEY ANY',
  '                               +dnssec — с подписями RRSIG/NSEC, +cd — без проверки DNSSEC',
  '  openssl s_client -connect <хост>[:443]',
  '                             — сертификат сервера и его проверка',
  '  dig -x <ip>                — обратный запрос (PTR)',
  '  ping [-c N] <хост>         — проверить связь',
  '  traceroute <хост>          — маршрут до хоста',
  '  whois <домен|ip>           — кто владеет доменом или адресом',
  '  curl [-I] [-k] <адрес>     — запрос к сайту (-k — не проверять сертификат)',
  '  ssh u<номер>@<сервер>      — войти на сервер хостинга (пароль задаётся в панели БалХоста)',
  '  clear                      — очистить экран',
  '',
  'Подсказка: ↑ и ↓ — история команд.',
];

const strip = (n) => String(n || '').replace(/\.$/, '');
const pad = (s, n) => String(s).padEnd(n);

function header(r, flags) {
  return [
    `;; ->>HEADER<<- opcode: QUERY, status: ${r.rcode}`,
    `;; flags: ${flags}; QUERY: 1, ANSWER: ${r.answer.length}, AUTHORITY: ${r.authority?.length || 0}, ADDITIONAL: ${r.additional?.length || 0}`,
  ];
}

function sections(r) {
  const out = ['', ';; QUESTION SECTION:', `;${pad(r.qname, 23)}\tIN\t${r.qtype}`];
  if (r.answer.length) out.push('', ';; ANSWER SECTION:', ...r.answer.map(formatRR));
  if (r.authority?.length) out.push('', ';; AUTHORITY SECTION:', ...r.authority.map(formatRR));
  if (r.additional?.length) out.push('', ';; ADDITIONAL SECTION:', ...r.additional.map(formatRR));
  return out;
}

const reverseOf = (ip) => `${ip.split('.').reverse().join('.')}.in-addr.arpa`;

export function TerminalPage({ ctx }) {
  const [lines, setLines] = useState(['ВлодБраузер — терминал БалНета. Введите help, чтобы увидеть команды.', '']);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [hist, setHist] = useState([]);
  const [hpos, setHpos] = useState(-1);
  const [ssh, setSsh] = useState(null); // { stage: 'password', user, host } | { session, prompt }
  const [editor, setEditor] = useState(null); // { path, content, saved }
  const end = useRef(null);
  const inputRef = useRef(null);
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }); }, [lines]);

  const print = (...ls) => setLines((l) => [...l, ...ls.flat()].slice(-2000));
  const net = ctx.net;
  const call = async (path, body) => {
    const r = await netCall(path, body, net);
    if (r.failed === 'maintenance') throw new Error('БалНет на обслуживании: игровое время на паузе');
    if (r.failed) throw new Error(r.message || 'Нет связи с сервером БалНета');
    return r.data;
  };
  const query = (server, name, type, recurse = true, extra = {}) => call('/net/query', { server, name, type, recurse, ...extra });

  async function dig(args) {
    let server = null;
    let name = null;
    let type = 'A';
    const flags = new Set();
    for (let i = 0; i < args.length; i++) {
      const a = args[i];
      if (a.startsWith('@')) server = a.slice(1);
      else if (a.startsWith('+')) flags.add(a.slice(1).toLowerCase());
      else if (a === '-x') { name = reverseOf(args[++i] || ''); type = 'PTR'; } else if (!name) name = a;
      else type = a.toUpperCase();
    }
    if (!name) return print('Использование: dig [@сервер] <имя> [тип] [+trace] [+short] [+norec]');
    if (server && !isIP(server)) {
      const r = await call('/net/resolve', { name: server, type: 'A' });
      const a = r.answer.find((x) => x.type === 'A');
      if (!a) return print(`dig: не удалось найти адрес сервера ${server}`);
      server = a.data;
    }
    if (flags.has('trace')) return digTrace(name, type);
    const dnssec = flags.has('dnssec') || flags.has('do');
    const r = await query(server || undefined, name, type, !flags.has('norec'), { dnssec, cd: flags.has('cd') });
    if (flags.has('short')) return print(r.answer.map((x) => x.data));
    const used = server || resolverOf(net) || (await lease(net.clientId, net.provider)).resolver_ip;
    if (r.rcode === 'TIMEOUT') return print(`;; connection timed out; no servers could be reached (${used})`);
    print(
      `; <<>> DiG (ВлодБраузер) <<>> ${server ? `@${server} ` : ''}${name} ${type}${[...flags].filter((f) => f !== 'short').map((f) => ` +${f}`).join('')}`,
      ...header(r, ['qr', r.aa && 'aa', !flags.has('norec') && 'rd', r.ra !== false && !r.aa && 'ra', r.ad && 'ad', flags.has('cd') && 'cd'].filter(Boolean).join(' ')),
      ...(dnssec ? ['', ';; OPT PSEUDOSECTION:', '; EDNS: version: 0, flags: do; udp: 1232'] : []),
      ...(r.ede ? [`; EDE: 6 (DNSSEC Bogus): (${r.ede.replace(/^DNSSEC Bogus: /, '')})`] : []),
      ...sections(r),
      '',
      `;; Query time: ${Math.round(r.ms)} msec`,
      `;; SERVER: ${used}#53(${strip(r.server?.name) || used})`,
      '',
    );
  }

  /** dig +trace: обход от корня, как настоящий dig — каждым запросом без рекурсии. */
  async function digTrace(name, type) {
    const roots = await query(undefined, '.', 'NS');
    print(`; <<>> DiG (ВлодБраузер) <<>> ${name} ${type} +trace`, ...roots.answer.map(formatRR), `;; Received from ${resolverOf(net) || 'DNS провайдера'}`, '');
    const addrOf = async (host) => {
      const r = await call('/net/resolve', { name: host, type: 'A' });
      return r.answer.find((x) => x.type === 'A')?.data || null;
    };
    let servers = [];
    for (const ns of roots.answer) {
      const ip = await addrOf(ns.data);
      if (ip) servers.push({ name: ns.data, ip });
    }
    for (let step = 0; step < 12 && servers.length; step++) {
      const s = servers[0];
      const r = await query(s.ip, name, type, false, { dnssec: true });
      const recs = r.answer.length ? r.answer : r.authority;
      print(...recs.map(formatRR), `;; Received from ${strip(s.name)} (${s.ip}) in ${Math.round(r.ms)} ms`, '');
      if (r.rcode !== 'NOERROR' || r.answer.length || r.aa) return;
      const next = [];
      for (const ns of r.authority.filter((x) => x.type === 'NS')) {
        const glue = r.additional.find((g) => g.name === ns.data && g.type === 'A');
        const ip = glue?.data || (await addrOf(ns.data));
        if (ip) next.push({ name: ns.data, ip });
      }
      servers = next;
    }
  }

  async function nslookup([name, server]) {
    if (!name) return print('Использование: nslookup <имя> [сервер]');
    const isRev = isIP(name);
    const r = await query(server || undefined, isRev ? reverseOf(name) : name, isRev ? 'PTR' : 'A');
    const used = server || resolverOf(net) || (await lease(net.clientId, net.provider)).resolver_ip;
    if (r.rcode === 'TIMEOUT') return print(';; connection timed out; no servers could be reached', '');
    print(`Server:\t\t${used}`, `Address:\t${used}#53`, '');
    if (r.rcode !== 'NOERROR') return print(`** server can't find ${name}: ${r.rcode}`, '');
    if (!r.answer.length) return print(`*** Can't find ${name}: No answer`, '');
    if (!r.aa) print('Non-authoritative answer:');
    for (const a of r.answer) {
      if (a.type === 'CNAME') print(`${strip(a.name)}\tcanonical name = ${strip(a.data)}.`);
      else if (a.type === 'PTR') print(`${strip(a.name)}\tname = ${a.data}`);
      else print(`Name:\t${strip(a.name)}`, `Address: ${a.data}`);
    }
    print('');
  }

  async function host([name]) {
    if (!name) return print('Использование: host <имя>');
    if (isIP(name)) {
      const r = await call('/net/resolve', { name: reverseOf(name), type: 'PTR' });
      return print(r.answer.length ? r.answer.map((a) => `${strip(a.name)} domain name pointer ${a.data}`) : `Host ${reverseOf(name)} not found: 3(NXDOMAIN)`);
    }
    const out = [];
    for (const type of ['A', 'AAAA', 'MX']) {
      const r = await call('/net/resolve', { name, type });
      if (r.rcode === 'NXDOMAIN') return print(`Host ${name} not found: 3(NXDOMAIN)`);
      if (r.rcode !== 'NOERROR') return print(`;; ${r.rcode}`);
      for (const a of r.answer) {
        if (a.type === 'CNAME' && type === 'A') out.push(`${strip(a.name)} is an alias for ${a.data}`);
        if (a.type === 'A') out.push(`${strip(a.name)} has address ${a.data}`);
        if (a.type === 'AAAA') out.push(`${strip(a.name)} has IPv6 address ${a.data}`);
        if (a.type === 'MX') out.push(`${strip(a.name)} mail is handled by ${a.data}`);
      }
    }
    print(out.length ? out : `${name} has no address records`);
  }

  async function ping(args) {
    let count = 4;
    const i = args.indexOf('-c');
    if (i >= 0) { count = Math.min(10, Math.max(1, Number(args[i + 1]) || 4)); args.splice(i, 2); }
    const target = args[0];
    if (!target) return print('Использование: ping [-c N] <хост>');
    const r = await call('/net/ping', { host: target, count });
    if (r.error) return print(`ping: ${target}: ${r.error === 'DNS_PROBE_FINISHED_NXDOMAIN' ? 'Name or service not known' : 'Temporary failure in name resolution'}`);
    print(`PING ${target} (${r.ip}) 56(84) bytes of data.`);
    for (const x of r.replies) {
      print(x.lost ? `Request timeout for icmp_seq ${x.seq}` : `64 bytes from ${r.name ? `${strip(r.name)} (${r.ip})` : r.ip}: icmp_seq=${x.seq} ttl=${x.ttl} time=${x.ms} ms`);
    }
    const ok = r.replies.filter((x) => !x.lost);
    print('', `--- ${target} ping statistics ---`, `${r.replies.length} packets transmitted, ${ok.length} received, ${Math.round(100 - (ok.length / r.replies.length) * 100)}% packet loss`);
    if (!r.reachable) print('Сеть назначения недоступна (Destination Net Unreachable)');
    if (ok.length) {
      const ms = ok.map((x) => x.ms);
      print(`rtt min/avg/max = ${Math.min(...ms)}/${(ms.reduce((a, b) => a + b, 0) / ms.length).toFixed(1)}/${Math.max(...ms)} ms`);
    }
    print('');
  }

  async function traceroute([target]) {
    if (!target) return print('Использование: traceroute <хост>');
    const r = await call('/net/traceroute', { host: target });
    if (r.error) return print(`traceroute: ${target}: Name or service not known`);
    print(`traceroute to ${target} (${r.ip}), 30 hops max, 60 byte packets`);
    for (const h of r.hops) {
      const n = String(h.n).padStart(2);
      if (h.unreachable) print(`${n}  * * *   (нет маршрута — !N)`);
      else if (!h.ms) print(`${n}  * * *`);
      else print(`${n}  ${h.name ? strip(h.name) : h.ip} (${h.ip})  ${h.ms.map((m) => `${m} ms`).join('  ')}`);
    }
    print('');
  }

  async function whois([q]) {
    if (!q) return print('Использование: whois <домен|ip>');
    let r;
    try {
      r = await get(`/net/whois?q=${encodeURIComponent(q)}`);
    } catch (e) {
      throw new Error(e.code === 'balnet_maintenance' ? 'БалНет на обслуживании' : e.message);
    }
    if (r.kind === 'ip') {
      print(`inetnum:   ${r.cidr}`, `netname:   ${r.holder}`, `purpose:   ${r.purpose}`, ...(r.provider ? [`provider:  ${r.provider}`] : []), `source:    BALNET`, '');
    } else if (r.kind === 'domain') {
      const when = (m) => (m == null ? null : gameDateLabel(m, 'ru'));
      print(
        `domain:    ${r.name.toUpperCase()}`,
        ...(r.status ? [`status:    ${r.status}`] : []),
        ...(r.owner ? [`registrant: ${r.owner}`] : []),
        ...r.ns.map((n) => `nserver:   ${strip(n)}`),
        `registrar: ${r.registrar}`,
        ...(r.created_month != null ? [`created:   ${when(r.created_month)}`, `paid-till: ${when(r.expires_month)}`] : r.created_at ? [`created:   ${String(r.created_at).slice(0, 10)}`] : []),
        'source:    BALNET',
        '',
      );
    } else {
      print(`No match for "${q}".`, 'Регистрация доменов игроками появится на этапе Н3.', '');
    }
  }

  async function curl(args) {
    const head = args.includes('-I') || args.includes('--head');
    const raw = args.find((a) => !a.startsWith('-'));
    if (!raw) return print('Использование: curl [-I] [-k] <адрес>');
    const url = /^[a-z]+:\/\//i.test(raw) ? raw : `https://${raw}`;
    const host = url.replace(/^[a-z]+:\/\//i, '').split(/[/?#]/)[0];
    const r = await call('/net/open', { url });
    if (!r.ip) return print(`curl: (6) Could not resolve host: ${host}`);
    if (r.code === 'ERR_CONNECTION_TIMED_OUT') return print(`curl: (28) Failed to connect to ${host} port 443 after 10000 ms: Timeout was reached`);
    if (r.code === 'ERR_CONNECTION_REFUSED') return print(`curl: (7) Failed to connect to ${host} port 443: Connection refused`);
    if (r.code === 'ERR_ADDRESS_UNREACHABLE') return print(`curl: (7) Failed to connect to ${host} port 443: No route to host`);
    if (r.ok && url.startsWith('https:')) {
      if (!r.tls) return print(`curl: (7) Failed to connect to ${host} port 443: Connection refused`);
      const v = await checkTls(r.tls, host);
      if (!v.ok && !(args.includes('-k') || args.includes('--insecure'))) {
        return print(`curl: (60) SSL certificate problem: ${v.code}`, 'More details here: https://ca.gov.bln/', '', 'curl failed to verify the legitimacy of the server. Use -k to skip (небезопасно).');
      }
    }
    const status = r.ok ? '200 OK' : '404 Not Found';
    const headers = [
      `HTTP/1.1 ${status}`,
      `server: ${strip(r.server)}`,
      'content-type: text/html; charset=utf-8',
      ...(r.gov ? ['strict-transport-security: max-age=31536000; preload', 'x-balnet-site: gov'] : []),
      '',
    ];
    print(headers);
    if (!head) print(r.ok ? `<!-- ${host}: содержимое сайта — откройте адрес во вкладке браузера -->` : '<h1>404 Not Found</h1>', '');
  }

  /** openssl s_client: подключение по TLS, цепочка сертификатов и итог проверки (как во ВлодБраузере). */
  async function openssl(args) {
    const i = args.indexOf('-connect');
    if (args[0] !== 's_client' || i < 0 || !args[i + 1]) return print('Использование: openssl s_client -connect <хост>[:443]');
    const [host, port = '443'] = args[i + 1].split(':');
    if (port !== '443') return print(`connect: ${host}:${port}: Connection refused`, 'connect:errno=111');
    const d = await call('/net/open', { url: `https://${host}/` });
    if (!d.ok) return print(`${d.code}: не удалось подключиться к ${host}:443`);
    if (!d.tls) return print(`connect: ${host}:443: Connection refused (на сервере ${d.ip} нет HTTPS)`, 'connect:errno=111');
    const v = await checkTls(d.tls, host);
    const out = [`CONNECTED(${d.ip}:443)`, '---', 'Certificate chain'];
    d.tls.chain.forEach((c, n) => {
      const t = c.tbs;
      out.push(` ${n} s:CN = ${t.subject.cn}${t.subject.o ? `, O = ${t.subject.o}` : ''}`, `   i:CN = ${t.issuer.cn}${t.issuer.o ? `, O = ${t.issuer.o}` : ''}`);
      out.push(`   a:ECDSA P-256, sigalg: ecdsa-with-SHA256`, `   v:NotBefore: ${gameDate(t.nb)}; NotAfter: ${gameDate(t.na)}`);
    });
    const leaf = d.tls.chain[0].tbs;
    out.push('---', 'Server certificate', `subject=CN = ${leaf.subject.cn}`, `issuer=CN = ${leaf.issuer.cn}`, `X509v3 Subject Alternative Name: ${leaf.san.map((n) => `DNS:${n}`).join(', ')}`);
    out.push(`Serial: ${leaf.serial}`, `Policy: ${leaf.policy}`);
    if (d.tls.sct) out.push(`SCT: log ${d.tls.sct.log_id}, index ${d.tls.sct.index}`);
    out.push(`OCSP response: ${d.tls.ocsp ? `${d.tls.ocsp.status}${d.tls.ocsp.reason ? ` (${d.tls.ocsp.reason})` : ''}` : 'no response sent'}`);
    out.push('---', 'New, TLSv1.3, Cipher is TLS_AES_128_GCM_SHA256', `Verify return code: ${v.ok ? '0 (ok)' : `${v.code}`}`, '---', '');
    return print(out);
  }

  async function ipconfig() {
    const l = await lease(net.clientId, net.provider);
    print(
      `Провайдер:        ${l.provider.name}`,
      `IPv4-адрес:       ${l.ip}`,
      `Сеть:             ${l.netmask}`,
      `Основной шлюз:    ${l.gateway}`,
      `DNS-сервер:       ${resolverOf(net) || l.resolver_ip}${resolverOf(net) ? ' (свой)' : ' (провайдера)'}`,
      '',
    );
  }

  async function sshStart(args) {
    const target = args.filter((a, i) => !a.startsWith('-') && args[i - 1] !== '-p' && args[i - 1] !== '-l')[0];
    const li = args.indexOf('-l');
    if (!target) return print('usage: ssh u<номер>@<сервер>');
    let [user, host] = target.includes('@') ? target.split('@') : [li >= 0 ? args[li + 1] : '', target];
    if (!user) user = '';
    setSsh({ stage: 'password', user, host });
    return print(`${user}@${host}'s password:`);
  }

  async function sshLogin(password) {
    const { user, host } = ssh;
    const r = await call('/net/ssh/login', { host, user, password });
    if (r.error) { setSsh(null); return print(r.error); }
    setSsh({ session: r.session, prompt: r.prompt });
    return print(r.motd, '');
  }

  async function sshExec(line) {
    const r = await post('/net/ssh/exec', { session: ssh.session, line });
    if (r.error) { setSsh(null); return print(r.error); }
    if (r.out) print(r.out);
    if (r.exit) { setSsh(null); return print(`Connection to ${ssh.prompt.split('@')[1].split(':')[0]} closed.`); }
    if (r.edit) setEditor({ ...r.edit, saved: r.edit.content });
    setSsh((x) => ({ ...x, prompt: r.prompt }));
    return null;
  }

  async function saveEditor() {
    const r = await post('/net/ssh/save', { session: ssh.session, path: editor.path, content: editor.content });
    if (r.error) throw new Error(r.error);
    setEditor((e) => ({ ...e, saved: e.content }));
    print(`[ Записано ${r.bytes} байт в ${editor.path} ]`);
  }

  async function run(line) {
    if (ssh?.session) return sshExec(line);
    const [cmd, ...args] = line.trim().split(/\s+/);
    switch ((cmd || '').toLowerCase()) {
      case '': return null;
      case 'help': return print(HELP);
      case 'clear': case 'cls': setLines([]); return null;
      case 'ipconfig': case 'ifconfig': case 'ip': return ipconfig();
      case 'dig': return dig(args);
      case 'nslookup': return nslookup(args);
      case 'host': return host(args);
      case 'ping': return ping(args);
      case 'traceroute': case 'tracert': return traceroute(args);
      case 'whois': return whois(args);
      case 'curl': return curl(args);
      case 'openssl': return openssl(args);
      case 'ssh': return sshStart(args);
      default: return print(`${cmd}: команда не найдена. Введите help.`);
    }
  }

  async function submit(e) {
    e.preventDefault();
    const line = input;
    setInput('');
    setHpos(-1);
    setBusy(true);
    try {
      if (ssh?.stage === 'password') {
        await sshLogin(line);
      } else {
        if (line.trim()) setHist((h) => [...h, line].slice(-100));
        print(`${ssh?.session ? ssh.prompt : '$'} ${line}`);
        await run(line);
      }
    } catch (err) { print(`Ошибка: ${err.message}`); }
    setBusy(false);
    setTimeout(() => inputRef.current?.focus(), 0);
  }

  if (editor) {
    const dirty = editor.content !== editor.saved;
    const close = () => { if (!dirty || window.confirm('Выйти без сохранения изменений?')) { setEditor(null); setTimeout(() => inputRef.current?.focus(), 0); } };
    return (
      <div className="bp-terminal bp-nano" role="dialog" aria-label={`Редактор ${editor.path}`}>
        <div className="bp-nano-head">GNU nano (БалНет) · {editor.path}{dirty ? ' · изменён' : ''}</div>
        <textarea
          className="bp-nano-text"
          value={editor.content}
          autoFocus
          spellCheck={false}
          onChange={(e) => setEditor((x) => ({ ...x, content: e.target.value }))}
          onKeyDown={(e) => {
            if (e.ctrlKey && (e.key === 's' || e.key === 'o')) { e.preventDefault(); saveEditor().catch((err) => print(`Ошибка: ${err.message}`)); }
            if (e.ctrlKey && e.key === 'x') { e.preventDefault(); close(); }
          }}
        />
        <div className="bp-nano-keys">
          <button className="bp-link" onClick={() => saveEditor().catch((err) => print(`Ошибка: ${err.message}`))}>^S Записать</button>
          <button className="bp-link" onClick={close}>^X Выход</button>
        </div>
      </div>
    );
  }

  return (
    <div className="bp-terminal" onClick={() => inputRef.current?.focus()} role="presentation">
      <pre className="bp-term-out" aria-live="polite">{lines.join('\n')}</pre>
      <form onSubmit={submit} className="bp-term-line">
        <span aria-hidden>{busy ? '…' : ssh?.session ? ssh.prompt : ssh?.stage === 'password' ? '' : '$'}</span>
        <input
          ref={inputRef}
          type={ssh?.stage === 'password' ? 'password' : 'text'}
          value={input}
          disabled={busy}
          autoFocus
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          aria-label="Команда"
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowUp' && hist.length) {
              e.preventDefault();
              const p = hpos < 0 ? hist.length - 1 : Math.max(0, hpos - 1);
              setHpos(p); setInput(hist[p]);
            } else if (e.key === 'ArrowDown' && hpos >= 0) {
              e.preventDefault();
              const p = hpos + 1;
              if (p >= hist.length) { setHpos(-1); setInput(''); } else { setHpos(p); setInput(hist[p]); }
            }
          }}
        />
      </form>
      <div ref={end} />
    </div>
  );
}
