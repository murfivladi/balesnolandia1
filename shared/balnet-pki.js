// PKI БалНета: сертификаты, журнал прозрачности (CT), статус отзыва, DNSSEC — на настоящей криптографии.
// Подписи ECDSA P-256 + SHA-256 (WebCrypto, формат r||s). Одинаково работает в API (Node 20) и во ВлодБраузере.
//
// Сертификат: { tbs, sig } где tbs — подписываемая часть (поля ниже), sig — подпись канонического JSON tbs
// ключом издателя. Каноничный JSON — ключи объектов по алфавиту, без пробелов.
//   tbs = { v: 1, serial, issuer: { cn, o }, subject: { cn, o?, c? }, san: [имена], nb, na (игровые секунды),
//           spki (открытый ключ субъекта, base64 SPKI), ski, aki (идентификаторы ключей), ca, path_len?,
//           policy: 'root' | 'ca' | 'DV' | 'OV' | 'EV' | 'self' }

const subtle = () => globalThis.crypto.subtle;
export const ALG = { name: 'ECDSA', namedCurve: 'P-256' };
const SIGN = { name: 'ECDSA', hash: 'SHA-256' };

// ——— Кодирование ———

export function canonical(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  return `{${Object.keys(v).filter((k) => v[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonical(v[k])}`).join(',')}}`;
}

export function b64(bytes) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function unb64(str) {
  const s = atob(String(str));
  const u = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) u[i] = s.charCodeAt(i);
  return u;
}

const utf8 = (s) => new TextEncoder().encode(s);

export async function sha256Hex(data) {
  const buf = await subtle().digest('SHA-256', typeof data === 'string' ? utf8(data) : data);
  return [...new Uint8Array(buf)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/** Идентификатор ключа: первые 16 hex SHA-256 от SPKI. */
export const keyId = async (spki) => (await sha256Hex(unb64(spki))).slice(0, 16);

// ——— Ключи и подписи ———

const keyCache = new Map();
async function verifyKey(spki) {
  if (!keyCache.has(spki)) {
    if (keyCache.size > 500) keyCache.clear();
    keyCache.set(spki, subtle().importKey('spki', unb64(spki), ALG, false, ['verify']));
  }
  return keyCache.get(spki);
}

/** Новый ключ: { spki, pkcs8 } в base64. */
export async function generateKey() {
  const kp = await subtle().generateKey(ALG, true, ['sign', 'verify']);
  const [spki, pkcs8] = await Promise.all([subtle().exportKey('spki', kp.publicKey), subtle().exportKey('pkcs8', kp.privateKey)]);
  return { spki: b64(spki), pkcs8: b64(pkcs8) };
}

export async function signWith(pkcs8, data) {
  const key = await subtle().importKey('pkcs8', unb64(pkcs8), ALG, false, ['sign']);
  return b64(await subtle().sign(SIGN, key, utf8(typeof data === 'string' ? data : canonical(data))));
}

export async function verifySig(spki, data, sig) {
  try {
    return await subtle().verify(SIGN, await verifyKey(spki), unb64(sig), utf8(typeof data === 'string' ? data : canonical(data)));
  } catch {
    return false;
  }
}

// ——— Сертификаты ———

/** Имя сайта подходит под имя из сертификата (точно или «*.» на один уровень). */
export function nameMatches(pattern, host) {
  const p = String(pattern).toLowerCase().replace(/\.$/, '');
  const h = String(host).toLowerCase().replace(/\.$/, '');
  if (p === h) return true;
  if (p.startsWith('*.')) {
    const rest = p.slice(2);
    const i = h.indexOf('.');
    return i > 0 && h.slice(i + 1) === rest;
  }
  return false;
}

export const certHash = (cert) => sha256Hex(canonical(cert.tbs));

export const CERT_ERRORS = {
  ERR_CERT_COMMON_NAME_INVALID: 'Сертификат выдан для другого сайта',
  ERR_CERT_DATE_INVALID: 'Срок действия сертификата истёк или ещё не начался',
  ERR_CERT_AUTHORITY_INVALID: 'Сертификат выдан не доверенным центром сертификации',
  ERR_CERT_REVOKED: 'Сертификат отозван',
  ERR_CERT_INVALID: 'Подпись сертификата неверна',
  ERR_CERTIFICATE_TRANSPARENCY_REQUIRED: 'Сертификат не записан в журнал прозрачности',
};

/**
 * Проверка соединения как в Chrome. trust = { roots: [{ spki, name }], ct_logs: [{ log_id, spki, name }] }.
 * trust.revoked_cas — идентификаторы ключей отозванных УЦ. tls = { chain: [лист, промежуточные…], sct?, ocsp? }. now — игровые секунды.
 * Возвращает { ok, code?, leaf, issuer, ev, org, chain: [имена] }.
 */
export async function verifyTls({ tls, host, now, trust }) {
  const chain = tls?.chain || [];
  const leaf = chain[0];
  if (!leaf?.tbs) return { ok: false, code: 'ERR_CERT_INVALID' };
  const t = leaf.tbs;
  const info = { leaf: t, ev: t.policy === 'EV', org: t.policy === 'OV' || t.policy === 'EV' ? t.subject?.o || null : null, chain: chain.map((c) => c.tbs?.subject?.cn) };
  const fail = (code) => ({ ok: false, code, ...info });

  if (!(t.san || []).some((n) => nameMatches(n, host))) return fail('ERR_CERT_COMMON_NAME_INVALID');
  if (t.policy === 'self' || t.aki === t.ski) {
    const self = await verifySig(t.spki, t, leaf.sig);
    return fail(self ? 'ERR_CERT_AUTHORITY_INVALID' : 'ERR_CERT_INVALID');
  }

  // Цепочка: каждый подписан следующим; последний — корнем из хранилища доверия.
  const roots = new Map();
  for (const r of trust?.roots || []) roots.set(await keyId(r.spki), r);
  const revokedCas = new Set(trust?.revoked_cas || []); // как CRLSet в Chrome: отозванные промежуточные УЦ
  let cur = leaf;
  for (let i = 0; i < 6; i++) {
    const c = cur.tbs;
    if (i > 0 && revokedCas.has(c.ski)) return fail('ERR_CERT_REVOKED');
    if (now < c.nb || now > c.na) return fail('ERR_CERT_DATE_INVALID');
    const next = chain.find((x) => x.tbs?.ski === c.aki && x !== cur);
    if (next) {
      if (!next.tbs.ca) return fail('ERR_CERT_INVALID');
      if (!(await verifySig(next.tbs.spki, c, cur.sig))) return fail('ERR_CERT_INVALID');
      if (roots.has(next.tbs.ski)) {
        const root = roots.get(next.tbs.ski);
        if (root.spki !== next.tbs.spki) return fail('ERR_CERT_AUTHORITY_INVALID');
        if (now < next.tbs.nb || now > next.tbs.na) return fail('ERR_CERT_DATE_INVALID');
        info.issuer = chain[1]?.tbs?.subject?.cn || next.tbs.subject.cn;
        break;
      }
      cur = next;
      continue;
    }
    // Издатель — корень, которого нет в присланной цепочке, но он есть в хранилище.
    const root = roots.get(c.aki);
    if (!root) return fail('ERR_CERT_AUTHORITY_INVALID');
    if (!(await verifySig(root.spki, c, cur.sig))) return fail('ERR_CERT_INVALID');
    info.issuer = chain[1]?.tbs?.subject?.cn || root.name;
    break;
  }
  if (!info.issuer) return fail('ERR_CERT_AUTHORITY_INVALID');

  // Журнал прозрачности: подписанная отметка (SCT) от известного журнала.
  const sct = tls.sct;
  const log = sct && (trust?.ct_logs || []).find((l) => l.log_id === sct.log_id);
  const hash = await certHash(leaf);
  if (!log || sct.cert_hash !== hash || !(await verifySig(log.spki, { log_id: sct.log_id, index: sct.index, ts: sct.ts, cert_hash: sct.cert_hash }, sct.sig))) {
    return fail('ERR_CERTIFICATE_TRANSPARENCY_REQUIRED');
  }
  info.ct_index = sct.index;

  // Статус отзыва, «скреплённый» сервером и подписанный издателем. Нет ответа — мягкий отказ, как в Chrome.
  const o = tls.ocsp;
  const issuerCert = chain.find((x) => x.tbs?.ski === t.aki);
  const issuerSpki = issuerCert?.tbs.spki || roots.get(t.aki)?.spki;
  if (o && issuerSpki && o.serial === t.serial && (await verifySig(issuerSpki, { serial: o.serial, status: o.status, reason: o.reason || null, this_update: o.this_update }, o.sig))) {
    info.ocsp = o.status;
    if (o.status === 'revoked') return fail('ERR_CERT_REVOKED');
  }
  return { ok: true, ...info };
}

// ——— DNSSEC ———

/** Тег ключа DNSKEY (как в RFC 4034, но от наших данных): число 0..65535. */
export async function keyTag(spki) {
  return parseInt((await sha256Hex(unb64(spki))).slice(0, 4), 16);
}

/** Дайджест для DS: SHA-256 от «имя зоны + ключ». */
export const dsDigest = (zone, spki) => sha256Hex(`${zone.toLowerCase()}|${spki}`);

/** Что подписывает RRSIG: имя, тип, TTL исходный и отсортированные данные набора. */
export function rrsetData(name, type, ttl, datas, meta) {
  return canonical({ name, type, ttl, rdata: [...datas].sort(), ...meta });
}
