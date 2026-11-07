// SSH на хостинг БалНета: вход u<номер>@<адрес сервера> по паролю из панели, оболочка в «клетке» домашнего
// каталога аккаунта (/home/u<номер>, внутри — папки сайтов). Команды как у bash на shared-хостинге:
// ls cd pwd cat head tail less mkdir rm rmdir mv cp touch echo (с > и >>) wc grep find du df tree unzip
// nano/vi (редактор в терминале), php, python, node, sqlite3, crontab -l, logs, whoami, hostname, exit.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { q, one } from '../../db.js';
import { getSettings } from '../settings.js';
import { accountDir, siteDir, dirSize, writeFile, extractZip, safeJoin } from '../sitefs.js';
import { siteByTarget, refreshUsage } from '../hosting.js';
import { runSite, runExternal } from './respond.js';
import { withSite, siteDb, flush, sqlExec, closeDb } from './store.js';
import { getLogs } from './logs.js';

const SESSION_MS = 60 * 60 * 1000;
const sessions = new Map();
const MAX_OUT = 200_000;

export function newSession(account, server) {
  const id = crypto.randomBytes(18).toString('base64url');
  sessions.set(id, { accountId: account.id, user: `u${account.id}`, server, cwd: `/home/u${account.id}`, expires: Date.now() + SESSION_MS });
  return id;
}

export function getSession(id) {
  const s = sessions.get(String(id || ''));
  if (!s || s.expires < Date.now()) { sessions.delete(id); return null; }
  s.expires = Date.now() + SESSION_MS;
  return s;
}
export const endSession = (id) => sessions.delete(id);

// ——— Пути ———

const home = (s) => `/home/${s.user}`;

/** Путь в оболочке → { virt, full, rel } внутри дома; выход за дом — «Отказано в доступе». */
function resolvePath(s, p) {
  const raw = String(p ?? '').replace(/^~(?=\/|$)/, home(s));
  const virt = path.posix.normalize(raw.startsWith('/') ? raw : path.posix.join(s.cwd, raw || '.')).replace(/\/+$/, '') || '/';
  if (virt !== home(s) && !virt.startsWith(`${home(s)}/`)) throw new ShellError(`${p}: Отказано в доступе (вы в своём домашнем каталоге)`);
  const rel = virt.slice(home(s).length).replace(/^\/+/, '');
  const { full } = safeJoin(accountDir(s.accountId), rel);
  return { virt, full, rel };
}

class ShellError extends Error {}

/** Сайт аккаунта по пути (первая папка — имя сайта) и путь внутри него. */
async function siteOfPath(s, rel) {
  const [dirName, ...rest] = rel.split('/');
  const rows = await q('SELECT id, host FROM hosting_sites WHERE account_id = ?', [s.accountId]);
  const row = rows.find((r) => path.basename(siteDir(s.accountId, r.host)) === dirName);
  if (!row) throw new ShellError('Скрипт должен лежать в папке сайта (cd имя-сайта)');
  const site = await siteByTarget(`site:${row.id}`);
  return { site, inner: rest.join('/') };
}

// ——— Разбор строки ———

function tokenize(line) {
  const out = [];
  let cur = '';
  let quote = null;
  let has = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === '\\' && quote === '"' && i + 1 < line.length) cur += line[++i];
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; has = true; continue; }
    if (ch === '\\' && i + 1 < line.length) { cur += line[++i]; has = true; continue; }
    if (/\s/.test(ch)) { if (cur || has) out.push(cur); cur = ''; has = false; continue; }
    if (ch === '>' ) {
      if (cur || has) out.push(cur);
      cur = ''; has = false;
      if (line[i + 1] === '>') { out.push('>>'); i++; } else out.push('>');
      continue;
    }
    cur += ch;
  }
  if (quote) throw new ShellError('незакрытая кавычка');
  if (cur || has) out.push(cur);
  return out;
}

const flagsOf = (args) => {
  const flags = new Set();
  const rest = [];
  for (const a of args) {
    if (/^-[a-zA-Z]+$/.test(a)) for (const c of a.slice(1)) flags.add(c);
    else rest.push(a);
  }
  return { flags, rest };
};

const human = (b) => (b < 1024 ? `${b}` : b < 1048576 ? `${(b / 1024).toFixed(1)}K` : `${(b / 1048576).toFixed(1)}M`);
const mode = (st) => (st.isDirectory() ? 'drwxr-xr-x' : '-rw-r--r--');
const date = (d) => d.toLocaleString('ru-RU', { month: 'short', day: '2-digit', hour: '2-digit', minute: '2-digit' });

async function limitsOf(accountId) {
  const set = await getSettings();
  const plan = await one('SELECT p.disk_mb FROM hosting_accounts a JOIN hosting_plans p ON p.id = a.plan_id WHERE a.id = ?', [accountId]);
  return { quotaBytes: plan.disk_mb * 1048576, maxFileBytes: Number(set.hosting_max_file_kb || 5120) * 1024, diskMb: plan.disk_mb };
}

async function readText(full, name) {
  const st = await fs.stat(full).catch(() => null);
  if (!st) throw new ShellError(`${name}: Нет такого файла или каталога`);
  if (st.isDirectory()) throw new ShellError(`${name}: Это каталог`);
  if (st.size > 1024 * 1024) throw new ShellError(`${name}: файл больше 1 МБ`);
  return fs.readFile(full, 'utf8');
}

async function walk(full, base = '', out = [], depth = 0) {
  if (depth > 16 || out.length > 5000) return out;
  for (const e of await fs.readdir(full, { withFileTypes: true }).catch(() => [])) {
    const rel = base ? `${base}/${e.name}` : e.name;
    out.push({ rel, dir: e.isDirectory(), full: path.join(full, e.name) });
    if (e.isDirectory()) await walk(path.join(full, e.name), rel, out, depth + 1);
  }
  return out;
}

const glob = (pat) => new RegExp(`^${pat.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.')}$`);

// ——— Команды ———

const HELP = `Команды оболочки хостинга:
  ls [-la] [путь]   cd [путь]   pwd   tree [путь]
  cat файл   head [-n N] файл   tail [-n N] файл   wc файл   grep [-rin] слово путь   find [путь] -name '*.php'
  mkdir [-p] папка   rmdir папка   rm [-rf] путь   mv откуда куда   cp [-r] откуда куда   touch файл
  echo текст > файл (>> — дописать)   unzip архив.zip [-d папка]   nano|vi файл — редактор
  du -sh [путь]   df -h   whoami   hostname   date
  node script.js   php script.php [аргументы]   python script.py [аргументы]
  sqlite3 "SQL"   — база сайта, в папке которого вы находитесь
  crontab -l   logs [-n N]   — задачи и журнал сайта
  exit`;

/** Выполнить строку. Возвращает { out, cwd, edit?, exit? }. */
export async function shell(s, line) {
  const tokens = tokenize(String(line || '').trim());
  if (!tokens.length) return { out: '', cwd: s.cwd };
  if (tokens.includes('|') || /[|;&]/.test(line.replace(/(["']).*?\1/g, ''))) {
    if (!/^\s*echo\b/.test(line)) return { out: 'Конвейеры (|, ;, &&) в этой оболочке не поддерживаются — по одной команде', cwd: s.cwd };
  }
  let redirect = null;
  const ri = tokens.findIndex((t) => t === '>' || t === '>>');
  if (ri >= 0) {
    if (!tokens[ri + 1]) throw new ShellError('нужно имя файла после >');
    redirect = { append: tokens[ri] === '>>', file: tokens[ri + 1] };
    tokens.splice(ri, 2);
  }
  const [cmd, ...args] = tokens;
  let out;
  try {
    out = await command(s, cmd, args);
  } catch (e) {
    if (e instanceof ShellError) return { out: `${cmd}: ${e.message}`, cwd: s.cwd, error: true };
    if (e.code === 'quota' || e.code === 'too_big' || e.code === 'bad_path' || e.code === 'exists' || e.code === 'bad_zip') return { out: `${cmd}: ${e.message}`, cwd: s.cwd, error: true };
    throw e;
  }
  if (out && typeof out === 'object' && !Array.isArray(out)) return { ...out, cwd: s.cwd };
  let text = Array.isArray(out) ? out.join('\n') : String(out ?? '');
  if (redirect) {
    const p = resolvePath(s, redirect.file);
    const prev = redirect.append ? await fs.readFile(p.full, 'utf8').catch(() => '') : '';
    await writeFile(accountDir(s.accountId), accountDir(s.accountId), p.rel, prev + text + (text.endsWith('\n') || !text ? '' : '\n'), await limitsOf(s.accountId));
    text = '';
  }
  return { out: text.slice(0, MAX_OUT), cwd: s.cwd };
}

async function command(s, cmd, args) {
  const { flags, rest } = flagsOf(args);
  switch (cmd) {
    case 'help': return HELP;
    case 'pwd': return s.cwd;
    case 'whoami': return s.user;
    case 'hostname': return s.server;
    case 'date': return new Date().toString();
    case 'exit': case 'logout': return { out: 'Соединение закрыто.', exit: true };
    case 'cd': {
      const p = resolvePath(s, rest[0] ?? '~');
      const st = await fs.stat(p.full).catch(() => null);
      if (!st?.isDirectory()) throw new ShellError(`${rest[0]}: Нет такого каталога`);
      s.cwd = p.virt;
      return '';
    }
    case 'ls': case 'dir': case 'll': {
      const long = flags.has('l') || cmd === 'll';
      const all = flags.has('a');
      const targets = rest.length ? rest : ['.'];
      const out = [];
      for (const t of targets) {
        const p = resolvePath(s, t);
        const st = await fs.stat(p.full).catch(() => null);
        if (!st) throw new ShellError(`невозможно получить доступ к '${t}': Нет такого файла или каталога`);
        const entries = st.isDirectory()
          ? (await fs.readdir(p.full, { withFileTypes: true })).filter((e) => all || !e.name.startsWith('.')).sort((a, b) => a.name.localeCompare(b.name))
          : [{ name: path.basename(p.full), isDirectory: () => false, file: true }];
        if (targets.length > 1) out.push(`${t}:`);
        if (!long) { out.push(entries.map((e) => (e.isDirectory() ? `${e.name}/` : e.name)).join('  ')); continue; }
        let total = 0;
        const rows = [];
        for (const e of entries) {
          const f = st.isDirectory() ? path.join(p.full, e.name) : p.full;
          const est = await fs.stat(f);
          total += est.size;
          rows.push(`${mode(est)} 1 ${s.user} ${s.user} ${String(est.isDirectory() ? 4096 : est.size).padStart(8)} ${date(est.mtime)} ${e.name}${est.isDirectory() ? '/' : ''}`);
        }
        out.push(`итого ${Math.ceil(total / 1024)}`, ...rows);
      }
      return out;
    }
    case 'tree': {
      const p = resolvePath(s, rest[0] || '.');
      const items = await walk(p.full);
      return [rest[0] || '.', ...items.filter((i) => !i.rel.split('/').some((x) => x.startsWith('.'))).map((i) => `${'│   '.repeat(i.rel.split('/').length - 1)}├── ${i.rel.split('/').pop()}${i.dir ? '/' : ''}`)];
    }
    case 'cat': case 'less': case 'more': {
      if (!rest.length) throw new ShellError('укажите файл');
      const out = [];
      for (const f of rest) out.push(await readText(resolvePath(s, f).full, f));
      return out.join('');
    }
    case 'head': case 'tail': {
      let n = 10;
      const files = [];
      for (let i = 0; i < args.length; i++) {
        if (args[i] === '-n') n = Number(args[++i]) || 10;
        else if (/^-\d+$/.test(args[i])) n = Number(args[i].slice(1));
        else files.push(args[i]);
      }
      const file = files[0];
      if (!file) throw new ShellError('укажите файл');
      const lines = (await readText(resolvePath(s, file).full, file)).replace(/\n$/, '').split('\n');
      return (cmd === 'head' ? lines.slice(0, n) : lines.slice(-n)).join('\n');
    }
    case 'wc': {
      const f = rest[0];
      if (!f) throw new ShellError('укажите файл');
      const t = await readText(resolvePath(s, f).full, f);
      return `${String(t.split('\n').length - 1).padStart(6)} ${String(t.split(/\s+/).filter(Boolean).length).padStart(6)} ${String(Buffer.byteLength(t)).padStart(6)} ${f}`;
    }
    case 'grep': {
      const [pat, ...paths] = rest;
      if (!pat) throw new ShellError('укажите, что искать');
      const re = new RegExp(pat.replace(/[.+^${}()|[\]\\]/g, '\\$&'), flags.has('i') ? 'i' : '');
      const out = [];
      for (const t of paths.length ? paths : ['.']) {
        const p = resolvePath(s, t);
        const st = await fs.stat(p.full).catch(() => null);
        if (!st) continue;
        const files = st.isDirectory() ? (flags.has('r') ? (await walk(p.full)).filter((i) => !i.dir).map((i) => ({ name: path.posix.join(t, i.rel), full: i.full })) : []) : [{ name: t, full: p.full }];
        for (const f of files) {
          const fst = await fs.stat(f.full);
          if (fst.size > 1024 * 1024) continue;
          const text = await fs.readFile(f.full, 'utf8');
          text.split('\n').forEach((l, i) => { if (re.test(l)) out.push(`${files.length > 1 || flags.has('r') ? `${f.name}:` : ''}${flags.has('n') ? `${i + 1}:` : ''}${l}`); });
          if (out.length > 2000) break;
        }
      }
      return out;
    }
    case 'find': {
      const ni = args.indexOf('-name');
      const pat = ni >= 0 ? args[ni + 1] : null;
      const start = args.find((a, i) => !a.startsWith('-') && (ni < 0 || i !== ni + 1)) || '.';
      const p = resolvePath(s, start);
      const items = await walk(p.full);
      const re = pat ? glob(pat) : null;
      return items.filter((i) => !re || re.test(i.rel.split('/').pop())).map((i) => (start === '.' ? `./${i.rel}` : path.posix.join(start, i.rel)));
    }
    case 'mkdir': {
      if (!rest.length) throw new ShellError('укажите имя каталога');
      for (const d of rest) {
        const p = resolvePath(s, d);
        if (!flags.has('p') && await fs.stat(p.full).catch(() => null)) throw new ShellError(`невозможно создать каталог «${d}»: Файл существует`);
        if (!flags.has('p') && !(await fs.stat(path.dirname(p.full)).catch(() => null))) throw new ShellError(`невозможно создать каталог «${d}»: Нет такого файла или каталога`);
        await fs.mkdir(p.full, { recursive: true });
      }
      return '';
    }
    case 'rmdir': case 'rm': {
      if (!rest.length) throw new ShellError('укажите, что удалить');
      for (const f of rest) {
        const p = resolvePath(s, f);
        if (p.virt === home(s) || p.rel.split('/').length === 1) {
          const st = await fs.stat(p.full).catch(() => null);
          if (st?.isDirectory()) throw new ShellError(`${f}: папку сайта целиком удаляют в панели БалХоста`);
        }
        const st = await fs.stat(p.full).catch(() => null);
        if (!st) { if (flags.has('f')) continue; throw new ShellError(`невозможно удалить '${f}': Нет такого файла или каталога`); }
        if (st.isDirectory()) {
          if (cmd === 'rmdir') {
            if ((await fs.readdir(p.full)).length) throw new ShellError(`не удалось удалить '${f}': Каталог не пуст`);
            await fs.rmdir(p.full);
          } else if (!flags.has('r')) throw new ShellError(`невозможно удалить '${f}': Это каталог (нужен -r)`);
          else await fs.rm(p.full, { recursive: true, force: true });
        } else if (cmd === 'rmdir') throw new ShellError(`${f}: Это не каталог`);
        else await fs.rm(p.full);
        if (p.rel.includes('.data')) await closeDbFor(s, p.rel);
      }
      await refreshUsage(s.accountId);
      return '';
    }
    case 'mv': case 'cp': {
      if (rest.length !== 2) throw new ShellError('нужно: откуда куда');
      const a = resolvePath(s, rest[0]);
      let b = resolvePath(s, rest[1]);
      const ast = await fs.stat(a.full).catch(() => null);
      if (!ast) throw new ShellError(`'${rest[0]}': Нет такого файла или каталога`);
      const bst = await fs.stat(b.full).catch(() => null);
      if (bst?.isDirectory()) b = resolvePath(s, `${b.virt}/${path.basename(a.full)}`);
      if (cmd === 'mv') await fs.rename(a.full, b.full);
      else {
        if (ast.isDirectory() && !flags.has('r')) throw new ShellError(`не указан -r; пропускается каталог '${rest[0]}'`);
        const lim = await limitsOf(s.accountId);
        const size = ast.isDirectory() ? await dirSize(a.full) : ast.size;
        if ((await dirSize(accountDir(s.accountId))) + size > lim.quotaBytes) throw new ShellError('Превышена дисковая квота тарифа');
        await fs.cp(a.full, b.full, { recursive: true });
      }
      await refreshUsage(s.accountId);
      return '';
    }
    case 'touch': {
      for (const f of rest) {
        const p = resolvePath(s, f);
        if (await fs.stat(p.full).catch(() => null)) await fs.utimes(p.full, new Date(), new Date());
        else await writeFile(accountDir(s.accountId), accountDir(s.accountId), p.rel, '', await limitsOf(s.accountId));
      }
      return '';
    }
    case 'echo': return args.join(' ');
    case 'nano': case 'vi': case 'vim': case 'edit': {
      const f = rest[0];
      if (!f) throw new ShellError('укажите файл');
      const p = resolvePath(s, f);
      const st = await fs.stat(p.full).catch(() => null);
      if (st?.isDirectory()) throw new ShellError(`${f}: Это каталог`);
      return { out: '', edit: { path: p.virt, content: st ? await readText(p.full, f) : '' } };
    }
    case 'unzip': {
      const f = rest[0];
      const di = args.indexOf('-d');
      const into = di >= 0 ? resolvePath(s, args[di + 1]) : resolvePath(s, '.');
      const p = resolvePath(s, f);
      const buf = await fs.readFile(p.full).catch(() => { throw new ShellError(`${f}: файл не найден`); });
      const lim = await limitsOf(s.accountId);
      const files = await extractZip(accountDir(s.accountId), accountDir(s.accountId), buf, { ...lim, into: into.rel });
      await refreshUsage(s.accountId);
      return [`Archive:  ${f}`, ...files.map((x) => `  inflating: ${x}`)];
    }
    case 'du': {
      const p = resolvePath(s, rest[0] || '.');
      return `${human(await dirSize(p.full))}\t${rest[0] || '.'}`;
    }
    case 'df': {
      const lim = await limitsOf(s.accountId);
      const used = await dirSize(accountDir(s.accountId));
      return ['Файловая система  Размер  Использовано  Доступно  Использовано%  Смонтировано в', `/dev/balnet       ${lim.diskMb}M    ${human(used).padStart(8)}  ${human(Math.max(0, lim.quotaBytes - used)).padStart(8)}  ${Math.round((used / lim.quotaBytes) * 100)}%            ${home(s)}`];
    }
    case 'node': case 'php': case 'python': case 'python3': {
      const [file, ...argv] = rest;
      if (!file) throw new ShellError(`интерактивный режим не поддерживается: ${cmd} файл`);
      const p = resolvePath(s, file);
      if (!(await fs.stat(p.full).catch(() => null))?.isFile()) throw new ShellError(`${file}: файл не найден`);
      const { site, inner } = await siteOfPath(s, p.rel);
      if (site.kind !== 'virtual') throw new ShellError('скрипты выполняются только на виртуальном тарифе');
      try {
        if (cmd === 'node') {
          const lines = [];
          const r = await runSite(site, '__script__', { argv }, { script: inner, onLog: (lv, t) => lines.push(lv === 'error' ? `Ошибка: ${t}` : t) });
          if (r?.value !== null && r?.value !== undefined) lines.push(typeof r.value === 'string' ? r.value : JSON.stringify(r.value));
          return lines;
        }
        if (cmd === 'php') {
          const r = await runExternal(site, 'php', { mode: 'script', entry: inner, argv: [inner, ...argv], req: { method: 'GET', path: `/${inner}` } });
          return Buffer.from(r.body, 'base64').toString('utf8') + (r.errors ? `\n${r.errors}` : '');
        }
        const r = await runExternal(site, 'python', { mode: 'script', entry: inner, argv });
        return (r.log || '').replace(/\n$/, '');
      } catch (e) {
        if (e.kind) return `${cmd}: ${e.message}`;
        throw e;
      }
    }
    case 'sqlite3': {
      const { site } = await siteOfPath(s, resolvePath(s, '.').rel || '?');
      if (site.kind !== 'virtual') throw new ShellError('база есть только на виртуальном тарифе');
      const sql = rest.filter((a) => !/\.sqlite$|\.db$/.test(a)).join(' ');
      if (!sql) throw new ShellError('нужен запрос: sqlite3 "SELECT ..."');
      return withSite(site.id, async () => {
        const e = await siteDb(site);
        let res;
        try { res = sqlExec(e, sql); } catch (err) { throw new ShellError(`Error: ${err.message}`); }
        const lim = await limitsOf(s.accountId);
        await flush(site.id, { quotaLeft: lim.quotaBytes - (await dirSize(accountDir(s.accountId))) });
        const out = [];
        for (const r of res) {
          out.push(r.columns.join('|'));
          for (const row of r.rows) out.push(row.map((v) => (v === null ? '' : String(v))).join('|'));
        }
        return out;
      });
    }
    case 'crontab': {
      if (!flags.has('l')) throw new ShellError('используйте crontab -l; правьте файл crontab в папке сайта (nano crontab)');
      const { site } = await siteOfPath(s, resolvePath(s, '.').rel || '?');
      return fs.readFile(`${site.dir}/crontab`, 'utf8').catch(() => `no crontab for ${s.user} (${site.host})`);
    }
    case 'logs': {
      const { site } = await siteOfPath(s, resolvePath(s, '.').rel || '?');
      const ni = args.indexOf('-n');
      const n = ni >= 0 ? Number(args[ni + 1]) || 50 : 50;
      return getLogs(site.id).slice(-n).map((l) => `${l.t.slice(11, 19)} [${l.level}] ${l.text}`);
    }
    default:
      throw new ShellError('команда не найдена (help — список команд)');
  }
}

async function closeDbFor(s, rel) {
  try {
    const { site } = await siteOfPath(s, rel);
    closeDb(site.id);
  } catch { /* не в папке сайта */ }
}

/** Сохранить файл из редактора. */
export async function saveFile(s, virt, content) {
  const p = resolvePath(s, virt);
  if (p.rel.includes('.data')) await closeDbFor(s, p.rel);
  const r = await writeFile(accountDir(s.accountId), accountDir(s.accountId), p.rel, String(content ?? ''), await limitsOf(s.accountId));
  await refreshUsage(s.accountId);
  return { bytes: r.size };
}

/** Приглашение как у bash: u15@hosting1:~/boris.bln$ */
export const prompt = (s) => `${s.user}@${s.server}:${s.cwd.replace(home(s), '~')}$`;
