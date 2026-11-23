// Спам-фильтр ВлодПочты: правила (как SpamAssassin) + байесовский фильтр ящика (обучается кнопками «Спам/Не спам»).
// Оценка в десятых долях балла: 50 = 5.0 — порог по умолчанию.
import { q, one } from '../../db.js';
import { checkUrl } from '../search/safe.js';

const WORDS = ['выигр', 'бесплатн', 'срочно', 'лотере', 'казино', 'приз', 'миллион', 'наследств', 'кредит без', 'пин-код', 'pin', 'пароль', 'подтвердите', 'заблокирован', 'переведите', 'перевод', 'акция', 'скидка 90', 'только сегодня', 'гарантир'];
const GOV_BRANDS = ['влодбанк', 'влодуслуг', 'налогов', 'госуслуг', 'bank.bln', 'gosuslugi'];

/** Слова письма для байесовского фильтра. */
export function tokens(text) {
  const out = new Set();
  for (const w of String(text).toLowerCase().match(/[a-zа-яё0-9][a-zа-яё0-9.-]{2,30}/giu) || []) {
    out.add(w.slice(0, 64));
    if (out.size >= 300) break;
  }
  return [...out];
}

const linksOf = (msg) => {
  const s = `${msg.text || ''} ${msg.html || ''}`;
  return [...new Set((s.match(/https?:\/\/[^\s"'<>)]+/gi) || []).slice(0, 30))];
};

/** Ссылки, у которых видимый текст — один адрес, а href — другой (классика фишинга). */
function mismatchedLinks(html) {
  let n = 0;
  for (const m of String(html || '').matchAll(/<a\b[^>]*href=["']?(https?:\/\/[^"'\s>]+)[^>]*>([\s\S]*?)<\/a>/gi)) {
    const shown = /([a-z0-9-]+\.)+[a-z]{2,}/i.exec(m[2].replace(/<[^>]+>/g, ''))?.[0]?.toLowerCase();
    if (!shown) continue;
    let real;
    try { real = new URL(m[1]).hostname.toLowerCase(); } catch { continue; }
    if (real !== shown && !real.endsWith(`.${shown}`)) n++;
  }
  return n;
}

async function bayes(accountId, toks) {
  const tot = await one('SELECT spam, ham FROM mail_bayes_totals WHERE account_id = ?', [accountId]);
  if (!tot || tot.spam < 3 || tot.ham < 3 || !toks.length) return null;
  const rows = await q(`SELECT token, spam, ham FROM mail_bayes WHERE account_id = ? AND token IN (${toks.map(() => '?').join(',')})`, [accountId, ...toks]);
  if (!rows.length) return null;
  // Робинсон: p(слово) по частотам, вклад самых «уверенных» 15 слов, геометрическое среднее.
  const probs = rows.map((r) => {
    const s = r.spam / tot.spam;
    const h = r.ham / tot.ham;
    const p = s / (s + h || 1);
    const n = r.spam + r.ham;
    return (0.5 + n * p) / (1 + n);
  }).sort((a, b) => Math.abs(b - 0.5) - Math.abs(a - 0.5)).slice(0, 15);
  const ln = (x) => Math.log(Math.max(1e-9, x));
  const S = 1 - Math.exp(probs.reduce((a, p) => a + ln(1 - p), 0) / probs.length);
  const H = 1 - Math.exp(probs.reduce((a, p) => a + ln(p), 0) / probs.length);
  return (1 + (S - H) / (S + H || 1)) / 2;
}

/**
 * Оценка письма для ящика. ctx: { accountId, auth: { spf, dkim, dmarc }, ptrOk, knownSender }.
 * Возвращает { score (десятые), reasons: [{ rule, points, text }] }.
 */
export async function scoreMessage(msg, ctx) {
  const reasons = [];
  const add = (rule, points, text) => { if (points) reasons.push({ rule, points, text }); };
  const { spf, dkim, dmarc } = ctx.auth;
  if (spf === 'fail') add('SPF_FAIL', 30, 'SPF: сервер отправителя не разрешён');
  else if (spf === 'softfail') add('SPF_SOFTFAIL', 15, 'SPF: мягкий отказ (~all)');
  else if (spf === 'none') add('SPF_NONE', 5, 'У домена отправителя нет SPF');
  if (dkim === 'fail' || dkim === 'permerror') add('DKIM_INVALID', 25, 'Подпись DKIM неверна');
  else if (dkim === 'none') add('DKIM_NONE', 8, 'Письмо без подписи DKIM');
  if (dmarc === 'fail') add('DMARC_FAIL', 25, 'DMARC не пройден');
  if (!ctx.ptrOk) add('RDNS_MISMATCH', 8, 'Обратная запись (PTR) сервера не совпадает с его именем');
  if (ctx.knownSender) add('KNOWN_SENDER', -25, 'Вы уже писали этому отправителю');

  const subject = String(msg.subject || '');
  const body = `${subject}\n${msg.text || ''}`.toLowerCase();
  const hits = WORDS.filter((w) => body.includes(w));
  add('SPAM_WORDS', Math.min(30, hits.length * 7), hits.length ? `Слова, частые в спаме: ${hits.slice(0, 5).join(', ')}` : '');
  const letters = subject.replace(/[^a-zа-яё]/gi, '');
  if (letters.length >= 8 && letters === letters.toUpperCase()) add('SUBJ_CAPS', 10, 'Тема написана КАПСОМ');
  if ((subject.match(/!/g) || []).length >= 3) add('SUBJ_EXCLAIM', 8, 'Много «!» в теме');
  if (!subject.trim()) add('NO_SUBJECT', 4, 'Нет темы');
  const mism = mismatchedLinks(msg.html);
  if (mism) add('LINK_MISMATCH', Math.min(30, mism * 15), 'Текст ссылки показывает один сайт, а ведёт на другой');
  const fromDomain = String(msg.from?.address || '').split('@')[1] || '';
  if (GOV_BRANDS.some((b) => body.includes(b)) && !/(^|\.)(bank|gov|kassa|mail|poisk)\.bln$/.test(fromDomain) && /(пароль|pin|пин|карт|код)/.test(body)) {
    add('GOV_IMPERSONATION', 25, 'Письмо от имени госсервиса с чужого домена просит пароль или данные карты');
  }
  for (const url of linksOf(msg)) {
    const bad = await checkUrl(url).catch(() => null);
    if (bad) { add('SAFE_BROWSING', 60, `Ссылка на опасный сайт из списка ВлодПоиска: ${url}`); break; }
  }
  const p = await bayes(ctx.accountId, tokens(body));
  if (p !== null) {
    if (p > 0.9) add('BAYES_SPAM', 35, `Байесовский фильтр ящика: похоже на спам (${Math.round(p * 100)} %)`);
    else if (p > 0.7) add('BAYES_MAYBE', 15, `Байесовский фильтр ящика: возможно спам (${Math.round(p * 100)} %)`);
    else if (p < 0.1) add('BAYES_HAM', -20, `Байесовский фильтр ящика: похоже на нужное письмо (${Math.round(p * 100)} %)`);
  }
  return { score: reasons.reduce((a, r) => a + r.points, 0), reasons };
}

/** Обучить фильтр ящика: письмо — спам (true) или нет (false). */
export async function train(accountId, msg, isSpam) {
  const toks = tokens(`${msg.subject || ''}\n${msg.body_text || ''}`);
  const col = isSpam ? 'spam' : 'ham';
  await q(`INSERT INTO mail_bayes_totals (account_id, ${col}) VALUES (?, 1) ON DUPLICATE KEY UPDATE ${col} = ${col} + 1`, [accountId]);
  for (let i = 0; i < toks.length; i += 100) {
    const part = toks.slice(i, i + 100);
    await q(`INSERT INTO mail_bayes (account_id, token, ${col}) VALUES ${part.map(() => '(?, ?, 1)').join(',')} ON DUPLICATE KEY UPDATE ${col} = ${col} + 1`, part.flatMap((t) => [accountId, t]));
  }
}
