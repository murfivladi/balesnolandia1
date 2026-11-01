// Интерфейс на русском и итальянском. Ключ — русская строка, перевод — в it.js.
import { useSyncExternalStore } from 'react';
import { IT } from './it.js';

const KEY = 'bln_lang';
let lang = 'ru';
try {
  const saved = localStorage.getItem(KEY);
  if (saved === 'it' || saved === 'ru') lang = saved;
} catch { /* ignore */ }
const subs = new Set();

export function getLang() {
  return lang;
}

export function setLang(l) {
  lang = l === 'it' ? 'it' : 'ru';
  try { localStorage.setItem(KEY, lang); } catch { /* ignore */ }
  document.documentElement.lang = lang;
  subs.forEach((f) => f());
}

export function useLang() {
  return useSyncExternalStore((f) => { subs.add(f); return () => subs.delete(f); }, () => lang);
}

const missing = new Set();

/** t('Привет, {name}', { name }) */
export function t(ru, vars) {
  let s = ru;
  if (lang === 'it') {
    if (IT[ru]) s = IT[ru];
    else if (!vars && tServer(ru) !== ru) s = tServer(ru);
    else if (import.meta.env.DEV && ru && !missing.has(ru)) {
      missing.add(ru);
      console.debug('[i18n] нет перевода:', ru);
    }
  }
  if (vars) s = s.replace(/\{(\w+)\}/g, (_, k) => (vars[k] ?? ''));
  return s;
}

const MONEY_RE = /−?\d[\d\s\u00a0]*,\d\d\u00a0В/;

/** Сообщения сервера приходят на русском — переводим по словарю, в том числе по шаблонам
 *  с суммой {sum}, числом {n} или хвостом после двоеточия {x}. */
export function tServer(msg) {
  if (!msg || lang === 'ru') return msg;
  if (IT[msg]) return IT[msg];
  const money = MONEY_RE.exec(msg);
  if (money) {
    const k = msg.replace(money[0], '{sum}');
    if (IT[k]) return IT[k].replace('{sum}', money[0]);
  }
  const num = /(\d+)/.exec(msg);
  if (num) {
    const k = msg.replace(num[1], '{n}');
    if (IT[k]) return IT[k].replace('{n}', num[1]);
  }
  const colon = msg.indexOf(': ');
  if (colon > 0) {
    const k = msg.slice(0, colon) + ': {x}';
    if (IT[k]) return IT[k].replace('{x}', tServer(msg.slice(colon + 2)));
  }
  return msg;
}

export function locale() {
  return lang === 'it' ? 'it-IT' : 'ru-RU';
}

export function fmtDate(d, withTime = true) {
  if (!d) return '';
  const date = new Date(d);
  if (Number.isNaN(date.getTime())) return String(d);
  return date.toLocaleString(locale(), withTime ? { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' } : { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function fmtTime(d) {
  return new Date(d).toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' });
}

/** «1990-05-01» → «01.05.1990» */
export function fmtBirth(s) {
  if (!s) return '';
  const [y, m, d] = String(s).slice(0, 10).split('-');
  return `${d}.${m}.${y}`;
}
