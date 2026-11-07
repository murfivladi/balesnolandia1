// git в SSH-оболочке хостинга (isomorphic-git на файлах аккаунта). Сеть — БалНет: запросы идут с адреса
// сервера хостинга через DNS и TLS до ВлодХаба (или другого git-сервера в БалНете) по протоколу smart HTTP.
// Логин и токен — в адресе (https://логин:токен@vlodhub.bln/…) или в git config credential.username/password.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import git from 'isomorphic-git';
import { netRequest } from '../vhost/respond.js';

class GitError extends Error {}

function httpVia(fromIp) {
  return {
    async request({ url, method = 'GET', headers = {}, body }) {
      let buf = null;
      if (body) {
        const chunks = [];
        for await (const c of body) chunks.push(Buffer.from(c));
        buf = Buffer.concat(chunks);
      }
      const r = await netRequest({ fromIp, url, method, headers, body: buf, binary: true });
      if (r.error) throw new GitError(`unable to access '${url.replace(/\/\/[^@/]+@/, '//')}': ${r.error}`);
      return { url: r.url, method, statusCode: r.status, statusMessage: r.status === 401 ? 'Unauthorized' : String(r.status), headers: r.headers, body: [new Uint8Array(r.buf)] };
    },
  };
}

/** Адрес без логина и пароля + данные для onAuth. */
function splitCreds(url) {
  try {
    const u = new URL(url);
    const auth = u.username ? { username: decodeURIComponent(u.username), password: decodeURIComponent(u.password) } : null;
    u.username = '';
    u.password = '';
    return { url: u.href, auth };
  } catch {
    throw new GitError(`неверный адрес репозитория: ${url}`);
  }
}

async function findRoot(dir, stop) {
  let d = dir;
  for (;;) {
    if (fs.existsSync(path.join(d, '.git'))) return d;
    if (d === stop || d === path.dirname(d)) return null;
    d = path.dirname(d);
  }
}

async function author(dir, home, user) {
  const read = async (k) => git.getConfig({ fs, dir, path: k }).catch(() => undefined);
  let name = await read('user.name');
  let email = await read('user.email');
  if (!name || !email) {
    const g = await fsp.readFile(path.join(home, '.gitconfig'), 'utf8').catch(() => '');
    name ||= /^\s*name\s*=\s*(.+)$/m.exec(g)?.[1]?.trim();
    email ||= /^\s*email\s*=\s*(.+)$/m.exec(g)?.[1]?.trim();
  }
  return { name: name || user, email: email || `${user}@hosting.bln` };
}

async function remoteAuth(dir, remote) {
  const url = await git.getConfig({ fs, dir, path: `remote.${remote}.url` });
  if (!url) throw new GitError(`'${remote}' does not appear to be a git repository`);
  const { url: clean, auth } = splitCreds(url);
  const username = auth?.username || (await git.getConfig({ fs, dir, path: 'credential.username' }));
  const password = auth?.password || (await git.getConfig({ fs, dir, path: 'credential.password' }));
  return { url: clean, onAuth: username ? () => ({ username, password }) : undefined };
}

const short = (oid) => oid.slice(0, 7);

/**
 * Выполнить git. ctx: { cwd (полный путь), home (полный путь дома), user, serverIp, resolve(p) → полный путь }.
 */
export async function gitCommand(ctx, args) {
  const [sub, ...rest] = args;
  const http = httpVia(ctx.serverIp);
  const onAuthFailure = () => { throw new GitError("Authentication failed: нужен логин ВлодХаба и токен (https://логин:токен@vlodhub.bln/…)"); };
  try {
    if (!sub || sub === 'help' || sub === '--help') return 'git clone|init|status|add|rm|commit -m|log|diff|push|pull|fetch|branch|checkout|remote|config';
    if (sub === 'clone') {
      const [src, target] = rest.filter((a) => !a.startsWith('-'));
      if (!src) throw new GitError('нужен адрес: git clone https://vlodhub.bln/логин/репозиторий.git');
      const { url, auth } = splitCreds(src);
      const name = target || path.basename(new URL(url).pathname).replace(/\.git$/, '');
      const dir = ctx.resolve(name);
      if (fs.existsSync(dir) && (await fsp.readdir(dir)).length) throw new GitError(`destination path '${name}' already exists and is not an empty directory.`);
      await git.clone({ fs, http, dir, url, singleBranch: false, ...(auth ? { onAuth: () => auth } : {}), onAuthFailure });
      if (auth) await git.setConfig({ fs, dir, path: 'remote.origin.url', value: src });
      return `Cloning into '${name}'...\ndone.`;
    }
    if (sub === 'init') {
      const dir = rest[0] ? ctx.resolve(rest[0]) : ctx.cwd;
      await git.init({ fs, dir, defaultBranch: 'main' });
      return `Initialized empty Git repository in ${dir.replace(ctx.home, ctx.homeVirt)}/.git/`;
    }
    const dir = await findRoot(ctx.cwd, ctx.home);
    if (!dir) throw new GitError('not a git repository (or any of the parent directories): .git');
    const rel = (p) => path.relative(dir, ctx.resolve(p)).split(path.sep).join('/') || '.';
    switch (sub) {
      case 'status': {
        const branch = await git.currentBranch({ fs, dir }) || '(нет ветки)';
        const m = await git.statusMatrix({ fs, dir });
        const staged = [];
        const unstaged = [];
        const untracked = [];
        for (const [f, h, w, s] of m) {
          if (h === 0 && w === 2 && s === 0) untracked.push(f);
          else {
            if (s !== h || (s === 3)) staged.push(`${h === 0 ? 'new file' : s === 0 ? 'deleted' : 'modified'}:   ${f}`);
            if (w !== s && !(h === 0 && s === 0)) unstaged.push(`${w === 0 ? 'deleted' : 'modified'}:   ${f}`);
          }
        }
        const out = [`On branch ${branch}`];
        if (staged.length) out.push('Changes to be committed:', ...staged.map((x) => `\t${x}`));
        if (unstaged.length) out.push('Changes not staged for commit:', ...unstaged.map((x) => `\t${x}`));
        if (untracked.length) out.push('Untracked files:', ...untracked.map((x) => `\t${x}`));
        if (!staged.length && !unstaged.length && !untracked.length) out.push('nothing to commit, working tree clean');
        return out;
      }
      case 'add': {
        const paths = rest.filter((a) => !a.startsWith('-'));
        if (rest.includes('-A') || rest.includes('--all') || paths.includes('.')) {
          for (const [f, h, w] of await git.statusMatrix({ fs, dir })) {
            if (w === 0 && h === 1) await git.remove({ fs, dir, filepath: f });
            else if (w !== 0) await git.add({ fs, dir, filepath: f });
          }
          return '';
        }
        if (!paths.length) throw new GitError('Nothing specified, nothing added.');
        for (const p of paths) await git.add({ fs, dir, filepath: rel(p) });
        return '';
      }
      case 'rm': {
        for (const p of rest.filter((a) => !a.startsWith('-'))) {
          await git.remove({ fs, dir, filepath: rel(p) });
          if (!rest.includes('--cached')) await fsp.rm(ctx.resolve(p), { force: true, recursive: true });
        }
        return '';
      }
      case 'commit': {
        const mi = rest.indexOf('-m');
        const message = mi >= 0 ? rest[mi + 1] : null;
        if (!message) throw new GitError('нужно сообщение: git commit -m "что сделано"');
        if (rest.includes('-a') || rest.includes('-am')) {
          for (const [f, h, w] of await git.statusMatrix({ fs, dir })) if (h === 1 && w === 0) await git.remove({ fs, dir, filepath: f }); else if (h === 1 && w === 2) await git.add({ fs, dir, filepath: f });
        }
        const changed = (await git.statusMatrix({ fs, dir })).some(([, h, , s]) => s !== h || s === 3);
        if (!changed) return 'nothing to commit, working tree clean';
        const oid = await git.commit({ fs, dir, message, author: await author(dir, ctx.home, ctx.user) });
        const branch = await git.currentBranch({ fs, dir });
        return `[${branch} ${short(oid)}] ${message}`;
      }
      case 'log': {
        const n = Number(rest[rest.indexOf('-n') + 1]) || 20;
        let entries;
        try { entries = await git.log({ fs, dir, depth: n }); } catch { return "fatal: your current branch does not have any commits yet"; }
        if (rest.includes('--oneline')) return entries.map((e) => `${short(e.oid)} ${e.commit.message.split('\n')[0]}`);
        return entries.flatMap((e) => [`commit ${e.oid}`, `Author: ${e.commit.author.name} <${e.commit.author.email}>`, `Date:   ${new Date(e.commit.author.timestamp * 1000).toString()}`, '', `    ${e.commit.message.trim()}`, '']);
      }
      case 'diff': {
        const out = [];
        for (const [f, h, w, s] of await git.statusMatrix({ fs, dir })) if (w !== s || (h !== s && rest.includes('--cached'))) out.push(`${w === 0 ? 'D' : h === 0 ? 'A' : 'M'}\t${f}`);
        return out.length ? out : '';
      }
      case 'branch': {
        const names = rest.filter((a) => !a.startsWith('-'));
        if (rest.includes('-d') || rest.includes('-D')) { await git.deleteBranch({ fs, dir, ref: names[0] }); return `Deleted branch ${names[0]}.`; }
        if (names[0]) { await git.branch({ fs, dir, ref: names[0] }); return ''; }
        const cur = await git.currentBranch({ fs, dir });
        const list = (await git.listBranches({ fs, dir })).map((b) => `${b === cur ? '* ' : '  '}${b}`);
        if (rest.includes('-a')) for (const b of await git.listBranches({ fs, dir, remote: 'origin' })) list.push(`  remotes/origin/${b}`);
        return list;
      }
      case 'checkout': case 'switch': {
        const create = rest.includes('-b') || rest.includes('-c');
        const name = rest.filter((a) => !a.startsWith('-'))[0];
        if (!name) throw new GitError('укажите ветку');
        if (create) await git.branch({ fs, dir, ref: name, checkout: true });
        else await git.checkout({ fs, dir, ref: name });
        return `Switched to ${create ? 'a new ' : ''}branch '${name}'`;
      }
      case 'remote': {
        if (rest[0] === 'add') { await git.addRemote({ fs, dir, remote: rest[1], url: rest[2] }); return ''; }
        if (rest[0] === 'remove' || rest[0] === 'rm') { await git.deleteRemote({ fs, dir, remote: rest[1] }); return ''; }
        if (rest[0] === 'set-url') { await git.setConfig({ fs, dir, path: `remote.${rest[1]}.url`, value: rest[2] }); return ''; }
        const remotes = await git.listRemotes({ fs, dir });
        const hide = (u) => u.replace(/\/\/([^:@/]+):[^@/]+@/, '//$1:***@');
        return rest.includes('-v') ? remotes.flatMap((r) => [`${r.remote}\t${hide(r.url)} (fetch)`, `${r.remote}\t${hide(r.url)} (push)`]) : remotes.map((r) => r.remote);
      }
      case 'config': {
        const global = rest.includes('--global');
        const kv = rest.filter((a) => !a.startsWith('--'));
        if (global) {
          const file = path.join(ctx.home, '.gitconfig');
          const [k, ...v] = kv;
          const [, key] = k.split('.');
          let text = await fsp.readFile(file, 'utf8').catch(() => '[user]\n');
          if (!v.length) return /^\s*(\w+)\s*=\s*(.+)$/m.exec(text.split('\n').find((l) => l.trim().startsWith(key)) || '')?.[2] || '';
          text = text.replace(new RegExp(`^\\s*${key}\\s*=.*\\n?`, 'm'), '');
          text = text.replace('[user]\n', `[user]\n\t${key} = ${v.join(' ')}\n`);
          await fsp.writeFile(file, text);
          return '';
        }
        if (kv.length === 1) return (await git.getConfig({ fs, dir, path: kv[0] })) ?? '';
        await git.setConfig({ fs, dir, path: kv[0], value: kv.slice(1).join(' ') });
        return '';
      }
      case 'fetch': {
        const remote = rest[0] || 'origin';
        const a = await remoteAuth(dir, remote);
        const r = await git.fetch({ fs, http, dir, remote, url: a.url, onAuth: a.onAuth, onAuthFailure });
        return r.fetchHead ? `From ${a.url}\n   -> ${remote}/${r.defaultBranch?.replace('refs/heads/', '') || ''} ${short(r.fetchHead)}` : '';
      }
      case 'pull': {
        const remote = rest[0] || 'origin';
        const branch = rest[1] || (await git.currentBranch({ fs, dir }));
        const a = await remoteAuth(dir, remote);
        const before = await git.resolveRef({ fs, dir, ref: 'HEAD' }).catch(() => null);
        await git.pull({ fs, http, dir, remote, url: a.url, ref: branch, singleBranch: true, onAuth: a.onAuth, onAuthFailure, author: await author(dir, ctx.home, ctx.user), fastForward: true });
        const after = await git.resolveRef({ fs, dir, ref: 'HEAD' });
        return before === after ? 'Already up to date.' : `Updating ${short(before || '0000000')}..${short(after)}\nFast-forward`;
      }
      case 'push': {
        const pos = rest.filter((a) => !a.startsWith('-'));
        const remote = pos[0] || 'origin';
        const branch = pos[1] || (await git.currentBranch({ fs, dir }));
        const a = await remoteAuth(dir, remote);
        const r = await git.push({ fs, http, dir, remote, url: a.url, ref: branch, force: rest.includes('-f') || rest.includes('--force'), onAuth: a.onAuth, onAuthFailure });
        if (!r.ok) throw new GitError(`failed to push some refs: ${Object.values(r.refs || {}).map((x) => x.error).filter(Boolean).join(', ')}`);
        return `To ${a.url}\n   ${branch} -> ${branch}`;
      }
      default:
        throw new GitError(`'${sub}' is not a git command. See 'git help'.`);
    }
  } catch (e) {
    if (e instanceof GitError) throw e;
    const msg = e.code === 'HttpError' && e.data?.statusCode === 401 ? "Authentication failed: нужен логин ВлодХаба и токен (https://логин:токен@vlodhub.bln/…)"
      : e.code === 'HttpError' && e.data?.statusCode === 404 ? 'repository not found'
      : e.code === 'PushRejectedError' ? 'Updates were rejected because the remote contains work that you do not have locally. Сначала git pull.'
        : e.code === 'MergeNotSupportedError' || e.code === 'MergeConflictError' || e.code === 'FastForwardError' ? 'Не удалось слить без конфликтов: ветки разошлись. Поправьте конфликт и сделайте коммит слияния.'
          : e.message;
    throw new GitError(`fatal: ${msg}`);
  }
}
