// IP-адреса БалНета: проверка, нормализация IPv4/IPv6, подсети CIDR. Без зависимостей — работает в API и в браузере.

const V4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

export function isIPv4(s) {
  return typeof s === 'string' && V4.test(s);
}

/** IPv6 → 8 групп чисел или null. Поддерживает «::» и хвост IPv4 (::ffff:1.2.3.4). */
function v6Groups(s) {
  if (typeof s !== 'string' || !s.includes(':') || !/^[0-9a-fA-F:.]+$/.test(s)) return null;
  let str = s;
  let tail = [];
  const lastColon = str.lastIndexOf(':');
  const last = str.slice(lastColon + 1);
  if (last.includes('.')) {
    if (!isIPv4(last)) return null;
    const p = last.split('.').map(Number);
    tail = [(p[0] << 8) | p[1], (p[2] << 8) | p[3]];
    str = `${str.slice(0, lastColon + 1)}`;
    if (str.endsWith('::')) str += '';
    else str = str.slice(0, -1);
  }
  const dbl = str.split('::');
  if (dbl.length > 2) return null;
  const parse = (part) => (part === '' ? [] : part.split(':'));
  const head = parse(dbl[0]);
  const rest = dbl.length === 2 ? parse(dbl[1]) : [];
  for (const g of [...head, ...rest]) if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
  const known = head.length + rest.length + tail.length;
  if (dbl.length === 1 && known !== 8) return null;
  if (dbl.length === 2 && known > 7) return null;
  const zeros = new Array(8 - known).fill(0);
  return [...head.map((g) => parseInt(g, 16)), ...(dbl.length === 2 ? zeros : []), ...rest.map((g) => parseInt(g, 16)), ...tail];
}

export function isIPv6(s) {
  return v6Groups(s) !== null;
}

export function isIP(s) {
  return isIPv4(s) || isIPv6(s);
}

/** Каноническая запись: IPv4 как есть, IPv6 — сжатый вид в нижнем регистре (RFC 5952). */
export function normalizeIP(s) {
  if (isIPv4(s)) return s;
  const g = v6Groups(s);
  if (!g) return null;
  let best = [-1, 0];
  for (let i = 0; i < 8;) {
    if (g[i] !== 0) { i++; continue; }
    let j = i;
    while (j < 8 && g[j] === 0) j++;
    if (j - i > best[1] && j - i > 1) best = [i, j - i];
    i = j;
  }
  const hex = g.map((x) => x.toString(16));
  if (best[0] < 0) return hex.join(':');
  const left = hex.slice(0, best[0]).join(':');
  const right = hex.slice(best[0] + best[1]).join(':');
  return `${left}::${right}`;
}

/** Адрес → BigInt и длина в битах. */
export function ipToBig(s) {
  if (isIPv4(s)) return { bits: 32, value: s.split('.').reduce((a, x) => (a << 8n) | BigInt(Number(x)), 0n) };
  const g = v6Groups(s);
  if (!g) return null;
  return { bits: 128, value: g.reduce((a, x) => (a << 16n) | BigInt(x), 0n) };
}

export function bigToIp(value, bits) {
  if (bits === 32) return [24n, 16n, 8n, 0n].map((sh) => String((value >> sh) & 255n)).join('.');
  const groups = [];
  for (let i = 7; i >= 0; i--) groups.push(Number((value >> BigInt(i * 16)) & 0xffffn).toString(16));
  return normalizeIP(groups.join(':'));
}

/** «60.1.0.0/16» → { ip, prefix, bits, network, size } или null. Адрес обязан быть началом сети. */
export function parseCidr(cidr) {
  if (typeof cidr !== 'string') return null;
  const [ip, p] = cidr.split('/');
  const big = ipToBig(ip);
  if (!big || !/^\d{1,3}$/.test(p ?? '')) return null;
  const prefix = Number(p);
  if (prefix > big.bits) return null;
  const host = BigInt(big.bits - prefix);
  const mask = ((1n << BigInt(big.bits)) - 1n) ^ ((1n << host) - 1n);
  if ((big.value & mask) !== big.value) return null;
  return { ip: normalizeIP(ip), prefix, bits: big.bits, network: big.value, size: 1n << host };
}

export function inCidr(ip, cidr) {
  const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  const a = ipToBig(ip);
  if (!c || !a || a.bits !== c.bits) return false;
  return a.value >= c.network && a.value < c.network + c.size;
}

/** n-й адрес подсети (0 — адрес сети). */
export function nthIp(cidr, n) {
  const c = typeof cidr === 'string' ? parseCidr(cidr) : cidr;
  if (!c) return null;
  const k = BigInt(n);
  if (k < 0n || k >= c.size) return null;
  return bigToIp(c.network + k, c.bits);
}

/** Самая узкая подходящая подсеть из списка объектов с полем cidr. */
export function longestMatch(ip, blocks) {
  let best = null;
  let bestPrefix = -1;
  for (const b of blocks) {
    const c = parseCidr(b.cidr);
    if (c && c.prefix > bestPrefix && inCidr(ip, c)) { best = b; bestPrefix = c.prefix; }
  }
  return best;
}

/** Имя для обратной зоны: 50.1.0.10 → 10.0.1.50.in-addr.arpa. */
export function reverseName(ip) {
  if (isIPv4(ip)) return `${ip.split('.').reverse().join('.')}.in-addr.arpa.`;
  const g = v6Groups(ip);
  if (!g) return null;
  const nibbles = g.map((x) => x.toString(16).padStart(4, '0')).join('').split('');
  return `${nibbles.reverse().join('.')}.ip6.arpa.`;
}
