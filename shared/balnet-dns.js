// DNS БалНета: имена, типы записей, проверка и нормализация данных записей (RDATA), вывод в стиле dig.
import { isIPv4, isIPv6, normalizeIP } from './balnet-ip.js';

export const RR_TYPES = ['A', 'AAAA', 'CNAME', 'MX', 'TXT', 'NS', 'SOA', 'SRV', 'CAA', 'PTR'];
/** Типы, которые нельзя ставить рядом с CNAME на одном имени. */
export const CNAME_EXCLUSIVE = true;

/** Секунд в игровом месяце: TTL и сроки считаются в игровом времени (30 игровых суток в месяце). */
export const GAME_MONTH_SECONDS = 30 * 86400;

const LABEL = /^(?!-)[a-z0-9-]{1,63}(?<!-)$/;
const SERVICE_LABEL = /^_[a-z0-9-]{1,62}$/;

export class DnsInputError extends Error {}
const fail = (m) => { throw new DnsInputError(m); };

/** Полное имя: нижний регистр, точка на конце. «Bank.BLN» → «bank.bln.», «.» → «.». null — если имя неверное. */
export function fqdn(name, { wildcard = false } = {}) {
  if (typeof name !== 'string') return null;
  let s = name.trim().toLowerCase();
  if (s === '.' || s === '@') return s === '.' ? '.' : null;
  if (!s.endsWith('.')) s += '.';
  if (s.length > 254) return null;
  const labels = s.slice(0, -1).split('.');
  for (let i = 0; i < labels.length; i++) {
    const l = labels[i];
    if (l === '*' && i === 0 && wildcard) continue;
    if (LABEL.test(l) || SERVICE_LABEL.test(l)) continue;
    return null;
  }
  return s;
}

/** name внутри зоны zone (или совпадает с ней). Корневая зона «.» содержит всё. */
export function inZone(name, zone) {
  if (zone === '.') return true;
  return name === zone || name.endsWith(`.${zone}`);
}

/** Родительское имя: «a.b.bln.» → «b.bln.», «bln.» → «.». */
export function parentName(name) {
  if (name === '.') return null;
  const i = name.indexOf('.');
  const rest = name.slice(i + 1);
  return rest === '' ? '.' : rest;
}

/** Цепочка от имени к корню: «a.bln.» → [«a.bln.», «bln.», «.»]. */
export function ancestry(name) {
  const out = [];
  for (let n = name; n; n = parentName(n)) out.push(n);
  return out;
}

/** Относительное имя для админки: «www.bank.bln.» в зоне «bank.bln.» → «www», вершина → «@». */
export function relativeName(name, zone) {
  if (name === zone) return '@';
  if (zone === '.') return name;
  return name.slice(0, -(zone.length + 1));
}

/** Из относительного («www», «@») или полного имени — полное имя внутри зоны. */
export function absoluteName(input, zone, { wildcard = true } = {}) {
  const s = String(input ?? '').trim().toLowerCase();
  if (s === '' || s === '@') return zone;
  if (s.endsWith('.')) {
    const n = fqdn(s, { wildcard });
    return n && inZone(n, zone) ? n : null;
  }
  return fqdn(zone === '.' ? s : `${s}.${zone.slice(0, -1)}`, { wildcard });
}

const u16 = (v, what) => {
  const n = Number(v);
  if (!/^\d+$/.test(String(v)) || n > 65535) fail(`${what}: число от 0 до 65535`);
  return n;
};
const u32 = (v, what) => {
  const n = Number(v);
  if (!/^\d+$/.test(String(v)) || n > 4294967295) fail(`${what}: целое неотрицательное число`);
  return n;
};
const host = (v, what) => fqdn(String(v ?? '')) || fail(`${what}: неверное имя хоста`);

/** Строка TXT → «"…" "…"»: без кавычек — одна строка, длинная режется по 255 символов. */
function normalizeTxt(data) {
  const s = String(data ?? '').trim();
  if (!s) fail('TXT: пустая запись');
  if (s.startsWith('"')) {
    const parts = [];
    const re = /"((?:[^"\\]|\\.)*)"\s*/gy;
    let m;
    let pos = 0;
    while ((m = re.exec(s))) { parts.push(m[1]); pos = re.lastIndex; }
    if (pos !== s.length || !parts.length) fail('TXT: строки в кавычках, например "v=spf1 -all"');
    for (const p of parts) if (p.length > 255) fail('TXT: строка длиннее 255 символов');
    return parts.map((p) => `"${p}"`).join(' ');
  }
  const chunks = [];
  for (let i = 0; i < s.length; i += 255) chunks.push(s.slice(i, i + 255));
  return chunks.map((c) => `"${c.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`).join(' ');
}

/** Проверка и нормализация данных записи. Бросает DnsInputError с понятным текстом. */
export function normalizeRdata(type, data) {
  const t = String(type || '').toUpperCase();
  const s = String(data ?? '').trim();
  const parts = s.split(/\s+/);
  switch (t) {
    case 'A':
      if (!isIPv4(s)) fail('A: нужен IPv4-адрес, например 50.1.0.10');
      return s;
    case 'AAAA':
      if (!isIPv6(s)) fail('AAAA: нужен IPv6-адрес, например ba1:1::10');
      return normalizeIP(s);
    case 'CNAME': case 'NS': case 'PTR':
      return host(s, t);
    case 'MX':
      if (parts.length !== 2) fail('MX: «приоритет хост», например 10 mx.bank.bln.');
      return `${u16(parts[0], 'MX приоритет')} ${host(parts[1], 'MX')}`;
    case 'SRV':
      if (parts.length !== 4) fail('SRV: «приоритет вес порт хост», например 10 5 443 web.bank.bln.');
      return `${u16(parts[0], 'SRV приоритет')} ${u16(parts[1], 'SRV вес')} ${u16(parts[2], 'SRV порт')} ${parts[3] === '.' ? '.' : host(parts[3], 'SRV')}`;
    case 'CAA': {
      const m = /^(\d{1,3})\s+(issue|issuewild|iodef)\s+"([^"]*)"$/i.exec(s);
      if (!m || Number(m[1]) > 255) fail('CAA: «флаги тег "значение"», например 0 issue "ca.gov.bln"');
      return `${Number(m[1])} ${m[2].toLowerCase()} "${m[3]}"`;
    }
    case 'TXT':
      return normalizeTxt(s);
    case 'SOA': {
      if (parts.length !== 7) fail('SOA: «первичный_NS почта_админа serial refresh retry expire minimum»');
      return [host(parts[0], 'SOA mname'), host(parts[1], 'SOA rname'), ...parts.slice(2).map((p, i) => u32(p, `SOA поле ${i + 3}`))].join(' ');
    }
    default:
      return fail(`Неизвестный тип записи: ${type}`);
  }
}

/** minimum из SOA — TTL отрицательных ответов. */
export function soaMinimum(data) {
  const p = String(data).split(/\s+/);
  return Number(p[6]) || 300;
}

export function soaSerial(data) {
  return Number(String(data).split(/\s+/)[2]) || 0;
}

/** Цель записи, по которой резолвер идёт дальше (CNAME, NS, MX, SRV). */
export function rdataTarget(rr) {
  if (rr.type === 'CNAME' || rr.type === 'NS' || rr.type === 'PTR') return rr.data;
  if (rr.type === 'MX') return rr.data.split(' ')[1];
  if (rr.type === 'SRV') return rr.data.split(' ')[3];
  return null;
}

/** Строка как в выводе dig. */
export function formatRR(rr) {
  const name = rr.name.padEnd(24);
  return `${name} ${String(rr.ttl).padStart(6)}\tIN\t${rr.type.padEnd(5)}\t${rr.data}`;
}

/** Игровые секунды → «1ч 30м» для подписи TTL. */
export function humanTtl(sec) {
  const s = Number(sec) || 0;
  if (s < 60) return `${s} с`;
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  return [d && `${d} д`, h && `${h} ч`, m && `${m} мин`].filter(Boolean).join(' ') || `${s} с`;
}
