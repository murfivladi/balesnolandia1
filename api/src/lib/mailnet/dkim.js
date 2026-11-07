// DKIM (RFC 6376) с ключами Ed25519 (RFC 8463, a=ed25519-sha256) и RSA (a=rsa-sha256, только проверка).
// Канонизация relaxed/relaxed, хеш тела bh=, подпись выбранных заголовков h=. Ключ ищется в DNS:
// <селектор>._domainkey.<домен> TXT "v=DKIM1; k=ed25519; p=<32 байта base64>".
import crypto from 'node:crypto';
import { splitMessage, prependHeader } from './message.js';

const ED_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
export const SIGNED_HEADERS = ['from', 'to', 'cc', 'reply-to', 'subject', 'date', 'message-id', 'in-reply-to', 'mime-version', 'content-type'];

/** Ключ Ed25519 для DKIM: { publicKey (base64, 32 байта — для p=), privateKey (PKCS8 base64) }. */
export function generateDkimKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  return {
    publicKey: publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64'),
    privateKey: privateKey.export({ format: 'der', type: 'pkcs8' }).toString('base64'),
  };
}

export const dkimRecord = (publicKey) => `v=DKIM1; k=ed25519; p=${publicKey}`;

/** Закрытый ключ Ed25519 → открытый (для проверки, что файл ключа соответствует записи в DNS). */
export function publicFromPrivate(privateKey) {
  const k = crypto.createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  return crypto.createPublicKey(k).export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
}

// ——— Канонизация ———

export function relaxedHeader(name, value) {
  return `${name.toLowerCase().trim()}:${String(value).replace(/\r?\n/g, '').replace(/[ \t]+/g, ' ').trim()}`;
}

export function relaxedBody(body) {
  let lines = String(body).replace(/\r?\n/g, '\n').split('\n').map((l) => l.replace(/[ \t]+/g, ' ').replace(/ $/, ''));
  while (lines.length && lines[lines.length - 1] === '') lines = lines.slice(0, -1);
  return lines.length ? `${lines.join('\r\n')}\r\n` : '';
}

const sha256 = (s) => crypto.createHash('sha256').update(s, 'utf8').digest();

/** Строка данных для подписи: выбранные заголовки (снизу вверх при повторах) + сам DKIM-Signature без b=. */
function signingInput(headers, names, sigHeader) {
  const used = new Map();
  const parts = [];
  for (const n of names) {
    const all = headers.filter((h) => h.name.toLowerCase() === n.toLowerCase());
    const k = n.toLowerCase();
    const idx = all.length - 1 - (used.get(k) || 0);
    used.set(k, (used.get(k) || 0) + 1);
    if (idx < 0) continue; // заголовка нет — подписывается пустое значение (здесь просто пропускаем)
    const h = all[idx];
    parts.push(`${relaxedHeader(h.name, h.value)}\r\n`);
  }
  const sig = relaxedHeader('DKIM-Signature', sigHeader.replace(/(\bb=)[^;]*/, '$1'));
  return parts.join('') + sig;
}

/**
 * Подписать письмо: вернуть письмо с заголовком DKIM-Signature наверху.
 * key: { domain, selector, privateKey (PKCS8 base64, Ed25519) }.
 */
export function signDkim(raw, { domain, selector, privateKey, time = Math.floor(Date.now() / 1000) }) {
  const { headers, body } = splitMessage(raw);
  const present = SIGNED_HEADERS.filter((n) => headers.some((h) => h.name.toLowerCase() === n));
  const bh = sha256(relaxedBody(body)).toString('base64');
  const tags = `v=1; a=ed25519-sha256; c=relaxed/relaxed; d=${domain}; s=${selector}; t=${time}; h=${present.join(':')}; bh=${bh}; b=`;
  const data = signingInput(headers, present, tags);
  const key = crypto.createPrivateKey({ key: Buffer.from(privateKey, 'base64'), format: 'der', type: 'pkcs8' });
  const b = crypto.sign(null, sha256(data), key).toString('base64');
  return prependHeader(raw, 'DKIM-Signature', `${tags}${b}`);
}

export function parseTags(s) {
  const out = {};
  for (const part of String(s).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    out[part.slice(0, i).trim().toLowerCase()] = part.slice(i + 1).replace(/\s+/g, '');
  }
  return out;
}

/** Строки TXT («"a" "b"») → одна строка. */
export const txtJoin = (data) => {
  const parts = [...String(data).matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\(.)/g, '$1'));
  return parts.length ? parts.join('') : String(data);
};

/**
 * Проверить все подписи DKIM. txt(name) → { rcode, records: [строки] }.
 * Возвращает [{ result: pass|fail|neutral|temperror|permerror, domain, selector, why }] (пусто — подписи нет).
 */
export async function verifyDkim(raw, { txt, now = Math.floor(Date.now() / 1000) }) {
  const { headers, body } = splitMessage(raw);
  const sigs = headers.filter((h) => h.name.toLowerCase() === 'dkim-signature').slice(0, 5);
  const out = [];
  for (const sh of sigs) {
    const t = parseTags(sh.value);
    const r = { domain: t.d || null, selector: t.s || null };
    const done = (result, why) => out.push({ ...r, result, why });
    if (t.v !== '1' || !t.d || !t.s || !t.h || !t.bh || !t.b) { done('permerror', 'В подписи не хватает тегов v, d, s, h, bh или b'); continue; }
    if (!t.h.split(':').map((x) => x.toLowerCase()).includes('from')) { done('permerror', 'Заголовок From не подписан'); continue; }
    if (t.x && Number(t.x) < now) { done('fail', 'Срок подписи истёк (x=)'); continue; }
    const [hc = 'simple', bc = 'simple'] = String(t.c || 'simple/simple').split('/');
    if (hc !== 'relaxed' || bc !== 'relaxed') { done('neutral', 'Поддерживается только канонизация relaxed/relaxed'); continue; }
    let canon = relaxedBody(body);
    if (t.l) canon = canon.slice(0, Number(t.l));
    if (sha256(canon).toString('base64') !== t.bh) { done('fail', 'Хеш тела не совпадает: письмо изменили после подписи (bh)'); continue; }
    const dns = await txt(`${t.s}._domainkey.${t.d}`);
    if (dns.rcode === 'SERVFAIL' || dns.rcode === 'TIMEOUT') { done('temperror', `Не удалось получить ключ ${t.s}._domainkey.${t.d}`); continue; }
    const rec = dns.records.map(txtJoin).find((x) => /^v=DKIM1/i.test(x.trim())) || dns.records.map(txtJoin).find((x) => /\bp=/.test(x));
    if (!rec) { done('permerror', `Нет ключа DKIM в DNS: ${t.s}._domainkey.${t.d}`); continue; }
    const k = parseTags(rec);
    if (!k.p) { done('permerror', 'Ключ отозван (пустой p=)'); continue; }
    const data = Buffer.from(sha256(signingInput(headers, t.h.split(':').map((x) => x.trim()), sh.value)));
    let ok = false;
    try {
      if (t.a === 'ed25519-sha256') {
        if ((k.k || 'rsa') !== 'ed25519') { done('permerror', 'Тип ключа в DNS не ed25519'); continue; }
        const pub = crypto.createPublicKey({ key: Buffer.concat([ED_SPKI_PREFIX, Buffer.from(k.p, 'base64')]), format: 'der', type: 'spki' });
        ok = crypto.verify(null, data, pub, Buffer.from(t.b, 'base64'));
      } else if (t.a === 'rsa-sha256') {
        const pub = crypto.createPublicKey({ key: Buffer.from(k.p, 'base64'), format: 'der', type: 'spki' });
        ok = crypto.verify('sha256', Buffer.from(signingInput(headers, t.h.split(':').map((x) => x.trim()), sh.value)), pub, Buffer.from(t.b, 'base64'));
      } else { done('permerror', `Неизвестный алгоритм ${t.a}`); continue; }
    } catch {
      done('permerror', 'Ключ в DNS повреждён');
      continue;
    }
    if (ok) done('pass', null); else done('fail', 'Подпись не сходится: заголовки изменены или ключ другой');
  }
  return out;
}
