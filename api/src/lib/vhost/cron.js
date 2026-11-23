// Cron сайтов по игровому времени. Файл crontab в корне сайта, синтаксис настоящего cron:
//   «минута час день месяц день_недели задача», например «0 9 * * * утро» или «*/30 * * * * опрос».
// Время — игровое: в игровом месяце 30 суток, в году 12 месяцев, неделя — 7 суток подряд от основания.
// Задача вызывает onCron({ name, time }) из server.js. Тариф задаёт минимальный шаг (игровые минуты).
import fs from 'node:fs/promises';
import { q } from '../../db.js';
import { gameSeconds, isPaused } from '../clock.js';
import { siteByTarget } from '../hosting.js';
import { runSite, runExternal } from './respond.js';
import { addLog } from './logs.js';

const RANGES = [[0, 59], [0, 23], [1, 30], [1, 12], [0, 6]];
const NAMES = ['минута', 'час', 'день', 'месяц', 'день недели'];

function parseField(src, [lo, hi], name) {
  const out = new Set();
  for (const part of src.split(',')) {
    const m = /^(\*|\d+(?:-\d+)?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new Error(`${name}: не понимаю «${part}»`);
    let [a, b] = m[1] === '*' ? [lo, hi] : m[1].split('-').map(Number);
    if (b === undefined) b = m[2] ? hi : a;
    const step = m[2] ? Number(m[2]) : 1;
    if (a < lo || b > hi || a > b || step < 1) throw new Error(`${name}: допустимо ${lo}–${hi}`);
    for (let v = a; v <= b; v += step) out.add(v);
  }
  return out;
}

/** crontab → { jobs: [{ name, fields, line }], errors: [] } */
export function parseCrontab(text) {
  const jobs = [];
  const errors = [];
  String(text || '').split(/\r?\n/).slice(0, 50).forEach((raw, i) => {
    const line = raw.replace(/#.*/, '').trim();
    if (!line) return;
    const parts = line.split(/\s+/);
    if (parts.length < 6) { errors.push(`строка ${i + 1}: нужно 5 полей времени и имя задачи`); return; }
    try {
      const fields = parts.slice(0, 5).map((f, k) => parseField(f, RANGES[k], NAMES[k]));
      jobs.push({ name: parts.slice(5).join(' ').slice(0, 60), fields, line: i + 1 });
    } catch (e) {
      errors.push(`строка ${i + 1}: ${e.message}`);
    }
  });
  return { jobs, errors };
}

/** Игровые секунды → [минута, час, день, месяц, день недели]. */
export function calendar(sec) {
  const days = Math.floor(sec / 86400);
  return [Math.floor(sec / 60) % 60, Math.floor(sec / 3600) % 24, (days % 30) + 1, (Math.floor(days / 30) % 12) + 1, days % 7];
}

export const matches = (job, sec) => calendar(sec).every((v, k) => job.fields[k].has(v));

/** Сколько раз задача сработает за игровые сутки — для проверки минимального шага тарифа. */
function firesPerDay(job) {
  let n = 0;
  for (let m = 0; m < 1440; m++) if (job.fields[0].has(m % 60) && job.fields[1].has(Math.floor(m / 60))) n++;
  return n;
}

/** Проверить и запустить задачи всех виртуальных сайтов. Возвращает число запусков. */
export async function cronTick({ now: forced = null } = {}) {
  if (!forced && (await isPaused())) return 0;
  const now = forced ?? (await gameSeconds());
  const rows = await q("SELECT s.id, s.cron_at FROM hosting_sites s JOIN hosting_accounts a ON a.id = s.account_id JOIN hosting_plans p ON p.id = a.plan_id WHERE a.status = 'active' AND p.kind = 'virtual'");
  let runs = 0;
  for (const row of rows) {
    const site = await siteByTarget(`site:${row.id}`);
    if (!site) continue;
    let text;
    try { text = await fs.readFile(`${site.dir}/crontab`, 'utf8'); } catch { continue; }
    const since = row.cron_at === null ? now : Math.max(Number(row.cron_at), now - 86400);
    await q('UPDATE hosting_sites SET cron_at = ? WHERE id = ?', [now, row.id]);
    if (row.cron_at === null) continue; // первый запуск только отмечает время
    const { jobs, errors } = parseCrontab(text);
    if (errors.length) addLog(site.id, 'error', `crontab: ${errors.join('; ')}`);
    const minStep = Number(site.cron_min) || 60;
    for (const job of jobs) {
      if (firesPerDay(job) > 1440 / minStep) {
        addLog(site.id, 'error', `crontab, строка ${job.line}: «${job.name}» срабатывает чаще, чем раз в ${minStep} игр. мин — так нельзя по тарифу`);
        continue;
      }
      // Ищем ближайшее срабатывание после прошлой проверки (не больше одного запуска за проверку).
      let at = null;
      for (let t = (Math.floor(since / 60) + 1) * 60; t <= now; t += 60) if (matches(job, t)) { at = t; break; }
      if (at === null) continue;
      runs++;
      try {
        const [cmd, ...argv] = job.name.split(/\s+/);
        if (/\.php$/i.test(cmd)) await runExternal(site, 'php', { mode: 'script', entry: cmd, argv: [cmd, ...argv], req: { method: 'GET', path: `/${cmd}` } });
        else if (/\.py$/i.test(cmd)) await runExternal(site, 'python', { mode: 'script', entry: cmd, argv });
        else if (await fs.stat(`${site.dir}/server.js`).then(() => true, () => false)) await runSite(site, 'onCron', { name: job.name, time: at });
        else await runExternal(site, 'python', { mode: 'handler', entry: 'server.py', handler: 'on_cron', arg: { name: job.name, time: at } });
        addLog(site.id, 'info', `cron «${job.name}» выполнен`);
      } catch (e) {
        if (!e.kind) addLog(site.id, 'error', `cron «${job.name}»: ${e.message}`);
      }
    }
  }
  return runs;
}

let timer = null;
export function startCron() {
  if (timer) return;
  timer = setInterval(() => { cronTick().catch((e) => console.error('cron', e)); }, 5000);
  timer.unref?.();
}
