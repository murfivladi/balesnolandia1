// Письма БалНета в настоящем формате RFC 5322 + MIME: заголовки, кодирование RFC 2047, multipart/alternative,
// base64. Сборка (для отправки) и разбор (для входящих и ящиков). Строки — CRLF, как в SMTP.
import crypto from 'node:crypto';

const CRLF = '\r\n';
export const MAX_RAW = 1024 * 1024;

const ADDR_RE = /^[a-z0-9!#$%&'*+/=?^_`{|}~.-]{1,64}@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/i;

/** Адрес нормализован: нижний регистр, без точки в конце домена. null — если адрес неверный. */
export function normAddress(a) {
  const s = String(a ?? '').trim().toLowerCase().replace(/\.$/, '');
  if (!ADDR_RE.test(s) || s.length > 254 || s.includes('..')) return null;
  return s;
}

export const domainOf = (addr) => String(addr).slice(String(addr).lastIndexOf('@') + 1).toLowerCase();

// ——— RFC 2047 ———

const ascii = (s) => /^[\x20-\x7e]*$/.test(s);
export function encodeWord(s) {
  const v = String(s ?? '');
  if (ascii(v)) return v;
  // Слова по 45 байт UTF-8 (≈60 символов base64), не разрывая символы.
  const out = [];
  let chunk = '';
  for (const ch of v) {
    if (Buffer.byteLength(chunk + ch) > 45) { out.push(chunk); chunk = ''; }
    chunk += ch;
  }
  if (chunk) out.push(chunk);
  return out.map((c) => `=?UTF-8?B?${Buffer.from(c).toString('base64')}?=`).join(' ');
}

function decodeQ(s) {
  return s.replace(/_/g, ' ').replace(/=([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

export function decodeWords(s) {
  return String(s ?? '').replace(/(=\?[^?]+\?[bq]\?[^?]*\?=)\s+(?==\?)/gi, '$1').replace(/=\?([^?]+)\?([bq])\?([^?]*)\?=/gi, (m, cs, enc, text) => {
    try {
      const bytes = enc.toLowerCase() === 'b' ? Buffer.from(text, 'base64') : Buffer.from(decodeQ(text), 'latin1');
      return new TextDecoder(/utf-?8/i.test(cs) ? 'utf-8' : cs).decode(bytes);
    } catch {
      return m;
    }
  });
}

/** «Имя <адрес>» с кодированием имени. */
export function formatAddress({ name, address }) {
  if (!name) return address;
  const n = ascii(name) ? (/[(),:;<>@[\]"]/.test(name) ? `"${name.replace(/["\\]/g, '\\$&')}"` : name) : encodeWord(name);
  return `${n} <${address}>`;
}

/** Список адресов из заголовка: [{ name, address }]. */
export function parseAddressList(value) {
  const s = decodeWords(String(value ?? ''));
  const out = [];
  let cur = '';
  let quoted = false;
  let angle = 0;
  const flush = () => {
    const part = cur.trim();
    cur = '';
    if (!part) return;
    const m = /^(.*?)<([^>]+)>\s*$/.exec(part);
    const address = normAddress(m ? m[2] : part.replace(/^.*\s/, ''));
    if (!address) return;
    const name = m ? m[1].trim().replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1') : '';
    out.push({ name: name || null, address });
  };
  for (const ch of s) {
    if (ch === '"') quoted = !quoted;
    if (!quoted && ch === '<') angle++;
    if (!quoted && ch === '>') angle = Math.max(0, angle - 1);
    if (ch === ',' && !quoted && !angle) flush();
    else cur += ch;
  }
  flush();
  return out;
}

// ——— Заголовки ———

/** Сложить длинный заголовок по пробелам (до 78 символов в строке). */
export function fold(line) {
  if (line.length <= 78) return line;
  const words = line.split(' ');
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (cur && (cur + ' ' + w).length > 76) { lines.push(cur); cur = w; } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) lines.push(cur);
  return lines.join(`${CRLF} `);
}

/** Текст → { headers: [{ name, value, raw }], body } (заголовки в исходном порядке, raw — с переносами). */
export function splitMessage(raw) {
  const s = String(raw ?? '');
  const i = s.search(/\r?\n\r?\n/);
  const head = i < 0 ? s : s.slice(0, i);
  const body = i < 0 ? '' : s.slice(i).replace(/^\r?\n\r?\n/, '');
  const headers = [];
  for (const line of head.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && headers.length) {
      const h = headers[headers.length - 1];
      h.raw += `${CRLF}${line}`;
      h.value = `${h.value} ${line.trim()}`.trim();
    } else {
      const c = line.indexOf(':');
      if (c <= 0) continue;
      headers.push({ name: line.slice(0, c).trim(), value: line.slice(c + 1).trim(), raw: line });
    }
  }
  return { headers, body };
}

export const header = (headers, name) => headers.find((h) => h.name.toLowerCase() === name.toLowerCase())?.value ?? null;

function params(value) {
  const out = {};
  const parts = String(value ?? '').split(';');
  out.value = parts.shift().trim().toLowerCase();
  for (const p of parts) {
    const i = p.indexOf('=');
    if (i < 0) continue;
    out[p.slice(0, i).trim().toLowerCase()] = p.slice(i + 1).trim().replace(/^"(.*)"$/, '$1');
  }
  return out;
}

function decodeBody(body, cte, charset) {
  const enc = String(cte || '7bit').toLowerCase();
  let buf;
  if (enc === 'base64') buf = Buffer.from(body.replace(/\s+/g, ''), 'base64');
  else if (enc === 'quoted-printable') buf = Buffer.from(body.replace(/=\r?\n/g, '').replace(/=([0-9a-f]{2})/gi, (_, h) => String.fromCharCode(parseInt(h, 16))), 'latin1');
  else buf = Buffer.from(body, 'utf8');
  try { return new TextDecoder(charset && !/utf-?8/i.test(charset) ? charset : 'utf-8').decode(buf); } catch { return buf.toString('utf8'); }
}

/** Разобрать часть MIME в { text, html }. */
function walk(headers, body, out, depth = 0) {
  const ct = params(header(headers, 'content-type') || 'text/plain; charset=utf-8');
  if (ct.value.startsWith('multipart/') && ct.boundary && depth < 5) {
    const b = `--${ct.boundary}`;
    for (const part of body.split(b).slice(1)) {
      if (part.startsWith('--')) break;
      const p = splitMessage(part.replace(/^\r?\n/, ''));
      walk(p.headers, p.body.replace(/\r?\n$/, ''), out, depth + 1);
    }
    return;
  }
  const disp = params(header(headers, 'content-disposition') || '');
  if (disp.value === 'attachment') return;
  const text = decodeBody(body, header(headers, 'content-transfer-encoding'), ct.charset);
  if (ct.value === 'text/html' && out.html === null) out.html = text;
  else if ((ct.value === 'text/plain' || !ct.value) && out.text === null) out.text = text;
}

const stripHtml = (h) => String(h).replace(/<style[\s\S]*?<\/style>|<script[\s\S]*?<\/script>/gi, '').replace(/<br\s*\/?>/gi, '\n').replace(/<\/p>/gi, '\n\n').replace(/<[^>]+>/g, '').replace(/&nbsp;/g, ' ').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');

/** Полный разбор письма. */
export function parseMessage(raw) {
  const { headers, body } = splitMessage(raw);
  const out = { text: null, html: null };
  walk(headers, body, out);
  const from = parseAddressList(header(headers, 'from'))[0] || null;
  const text = out.text ?? (out.html ? stripHtml(out.html).trim() : '');
  return {
    headers,
    from,
    to: parseAddressList(header(headers, 'to')),
    cc: parseAddressList(header(headers, 'cc')),
    replyTo: parseAddressList(header(headers, 'reply-to'))[0] || null,
    subject: decodeWords(header(headers, 'subject') || '').slice(0, 500),
    date: header(headers, 'date'),
    messageId: (header(headers, 'message-id') || '').replace(/[<>\s]/g, '').slice(0, 250) || null,
    inReplyTo: (header(headers, 'in-reply-to') || '').replace(/[<>\s]/g, '').slice(0, 250) || null,
    text,
    html: out.html,
  };
}

// ——— Сборка ———

const b64lines = (s) => Buffer.from(s, 'utf8').toString('base64').replace(/.{1,76}/g, (m) => `${m}${CRLF}`).trimEnd();

export const newMessageId = (domain) => `${Date.now().toString(36)}.${crypto.randomBytes(6).toString('hex')}@${domain}`;

/**
 * Собрать письмо. from/to/cc — { name, address } или строки-адреса. extra — дополнительные заголовки [имя, значение].
 * date — дата Date (по умолчанию сейчас). Возвращает { raw, messageId }.
 */
export function buildMessage({ from, to = [], cc = [], replyTo = null, subject = '', text = '', html = null, messageId = null, inReplyTo = null, date = new Date(), extra = [] }) {
  const addr = (a) => (typeof a === 'string' ? { address: a, name: null } : a);
  const f = addr(from);
  const id = messageId || newMessageId(domainOf(f.address));
  const lines = [
    ['From', formatAddress(f)],
    ...(to.length ? [['To', to.map((a) => formatAddress(addr(a))).join(', ')]] : []),
    ...(cc.length ? [['Cc', cc.map((a) => formatAddress(addr(a))).join(', ')]] : []),
    ...(replyTo ? [['Reply-To', formatAddress(addr(replyTo))]] : []),
    ['Subject', encodeWord(subject)],
    ['Date', date.toUTCString().replace('GMT', '+0000')],
    ['Message-ID', `<${id}>`],
    ...(inReplyTo ? [['In-Reply-To', `<${inReplyTo}>`], ['References', `<${inReplyTo}>`]] : []),
    ['MIME-Version', '1.0'],
    ...extra,
  ];
  let body;
  if (html) {
    const boundary = `=_bln_${crypto.randomBytes(8).toString('hex')}`;
    lines.push(['Content-Type', `multipart/alternative; boundary="${boundary}"`]);
    body = [
      `--${boundary}`, 'Content-Type: text/plain; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64lines(text || stripHtml(html)),
      `--${boundary}`, 'Content-Type: text/html; charset=utf-8', 'Content-Transfer-Encoding: base64', '', b64lines(html),
      `--${boundary}--`, '',
    ].join(CRLF);
  } else {
    lines.push(['Content-Type', 'text/plain; charset=utf-8'], ['Content-Transfer-Encoding', 'base64']);
    body = `${b64lines(text)}${CRLF}`;
  }
  const head = lines.map(([k, v]) => fold(`${k}: ${v}`)).join(CRLF);
  return { raw: `${head}${CRLF}${CRLF}${body}`, messageId: id };
}

/** Добавить заголовок в начало письма (Received, Authentication-Results, DKIM-Signature). */
export const prependHeader = (raw, name, value) => `${fold(`${name}: ${value}`)}${CRLF}${raw}`;

/** Дата для заголовков Received. */
export const rfcDate = (d = new Date()) => d.toUTCString().replace('GMT', '+0000');
