// ВлодХаб: пользователи (вход через ВлодУслуги + свой логин), токены доступа для git, репозитории и права,
// git по HTTP (Basic-авторизация логин:токен), деплой ветки на сайт хостинга при push.
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { q, one } from '../../db.js';
import { config } from '../../config.js';
import { bad, notFound, forbidden, need, conflict } from '../errors.js';
import { getSettings } from '../settings.js';
import { siteDir, accountDir, writeFile, safeJoin } from '../sitefs.js';
import { canManageAccount, refreshUsage } from '../hosting.js';
import { closeDb } from '../vhost/store.js';
import { initBare, advertise, uploadPack, receivePack, listFiles, readPath, ZERO } from './git.js';

export const reposRoot = () => path.join(config.sitesDir, '_vlodhub');
export const gitdirOf = (repo) => path.join(reposRoot(), String(repo.owner_id), `${repo.id}.git`);
const LOGIN_RE = /^[a-z0-9](?:[a-z0-9-]{0,37}[a-z0-9])?$/;
const REPO_RE = /^[A-Za-z0-9._-]{1,100}$/;
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');

// ——— Пользователи и токены ———

export async function hubUser(govUserId) {
  return one('SELECT * FROM hub_users WHERE gov_user_id = ?', [govUserId]);
}

export async function needHubUser(govUserId) {
  const u = await hubUser(govUserId);
  if (!u) throw bad('no_login', 'Сначала выберите логин на ВлодХабе');
  return u;
}

export async function createUser(govUserId, login, name) {
  const l = String(login || '').trim().toLowerCase();
  need(LOGIN_RE.test(l), 'Логин: латинские буквы, цифры и дефис, до 39 символов');
  need(!['api', 'git', 'new', 'settings', 'explore', 'login'].includes(l), 'Этот логин занят');
  if (await hubUser(govUserId)) throw conflict('exists', 'Логин уже выбран');
  try {
    await q('INSERT INTO hub_users (gov_user_id, login, name) VALUES (?, ?, ?)', [govUserId, l, String(name || '').slice(0, 80) || null]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw conflict('login_taken', 'Этот логин уже занят');
    throw e;
  }
  return hubUser(govUserId);
}

export async function createToken(user, name) {
  const token = `vh_${crypto.randomBytes(24).toString('base64url')}`;
  await q('INSERT INTO hub_tokens (user_id, name, token_hash, prefix) VALUES (?, ?, ?, ?)', [user.id, String(name || 'git').slice(0, 80), sha(token), token.slice(0, 10)]);
  return token;
}

/** Basic-авторизация git: логин:токен. Возвращает пользователя или null. */
export async function userFromBasic(header) {
  const m = /^Basic\s+(.+)$/i.exec(String(header || ''));
  if (!m) return null;
  const [login, token] = Buffer.from(m[1], 'base64').toString('utf8').split(/:(.*)/s);
  if (!login || !token) return null;
  const u = await one('SELECT u.* FROM hub_tokens t JOIN hub_users u ON u.id = t.user_id WHERE t.token_hash = ?', [sha(token)]);
  if (!u || u.login !== login.toLowerCase()) return null;
  await q('UPDATE hub_tokens SET last_used = NOW(3) WHERE token_hash = ?', [sha(token)]);
  return u;
}

// ——— Репозитории и права ———

export async function repoBy(owner, name) {
  return one('SELECT r.*, u.login AS owner_login FROM hub_repos r JOIN hub_users u ON u.id = r.owner_id WHERE u.login = ? AND r.name = ?', [String(owner).toLowerCase(), String(name).replace(/\.git$/, '')]);
}

/** Права: { read, write, admin }. */
export async function access(repo, user) {
  const admin = !!user && user.id === repo.owner_id;
  const collab = !!user && !admin && !!(await one('SELECT 1 AS x FROM hub_collaborators WHERE repo_id = ? AND user_id = ?', [repo.id, user.id]));
  return { read: !repo.private || admin || collab, write: admin || collab, admin };
}

export async function repoFor(owner, name, user, need_ = 'read') {
  const repo = await repoBy(owner, name);
  if (!repo) throw notFound('Репозиторий не найден');
  const a = await access(repo, user);
  if (!a.read) throw notFound('Репозиторий не найден');
  if (need_ === 'write' && !a.write) throw forbidden('Нужны права на запись');
  if (need_ === 'admin' && !a.admin) throw forbidden('Это может только владелец репозитория');
  return { repo, access: a };
}

export async function createRepo(user, { name, description, private: priv, readme }) {
  const n = String(name || '').trim();
  need(REPO_RE.test(n) && !n.endsWith('.git') && n !== '.' && n !== '..', 'Имя репозитория: латиница, цифры, «.», «-», «_»');
  const count = await one('SELECT COUNT(*) AS n FROM hub_repos WHERE owner_id = ?', [user.id]);
  need(Number(count.n) < 50, 'Не больше 50 репозиториев на пользователя');
  let r;
  try {
    r = await q('INSERT INTO hub_repos (owner_id, name, description, private) VALUES (?, ?, ?, ?)', [user.id, n, String(description || '').slice(0, 300) || null, priv ? 1 : 0]);
  } catch (e) {
    if (e.code === 'ER_DUP_ENTRY') throw conflict('exists', 'У вас уже есть репозиторий с таким именем');
    throw e;
  }
  const repo = await one('SELECT * FROM hub_repos WHERE id = ?', [r.insertId]);
  await initBare(gitdirOf(repo));
  if (readme) {
    const { commitFile } = await import('./git.js');
    await commitFile(gitdirOf(repo), { branch: 'main', filepath: 'README.md', content: `# ${n}\n\n${description || ''}\n`, message: 'Первый коммит', author: { name: user.name || user.login, email: `${user.login}@vlodhub.bln` } });
  }
  return repo;
}

export async function deleteRepo(repo) {
  await q('DELETE FROM hub_comments WHERE issue_id IN (SELECT id FROM hub_issues WHERE repo_id = ?)', [repo.id]);
  await q('DELETE FROM hub_issues WHERE repo_id = ?', [repo.id]);
  await q('DELETE FROM hub_collaborators WHERE repo_id = ?', [repo.id]);
  await q('DELETE FROM hub_deploys WHERE repo_id = ?', [repo.id]);
  await q('DELETE FROM hub_repos WHERE id = ?', [repo.id]);
  await fs.rm(gitdirOf(repo), { recursive: true, force: true });
}

// ——— Деплой на хостинг ———

/** Сайты хостинга, которыми может управлять пользователь (для выбора цели деплоя). */
export async function deployTargets(govUserId) {
  const rows = await q("SELECT s.id, s.host, a.id AS account_id, a.owner_gov_user_id, a.owner_org_id, a.status FROM hosting_sites s JOIN hosting_accounts a ON a.id = s.account_id WHERE a.status IN ('active','suspended')");
  const out = [];
  for (const r of rows) if (await canManageAccount(null, r, govUserId)) out.push({ id: r.id, host: r.host });
  return out;
}

const SKIP = (p) => p.split('/').some((x) => x === '.git' || x === '.data');

/** Выложить коммит на сайт: записать файлы, удалить то, что было в прошлом деплое и пропало из репозитория. */
export async function deploy(repo, oid) {
  const site = await one("SELECT s.*, a.status AS account_status FROM hosting_sites s JOIN hosting_accounts a ON a.id = s.account_id WHERE s.id = ?", [repo.deploy_site_id]);
  if (!site) return { status: 'failed', message: 'Сайт для деплоя не найден' };
  if (site.account_status !== 'active') return save(repo, site, oid, 'failed', 'Хостинг не оплачен', null);
  const gitdir = gitdirOf(repo);
  const dir = siteDir(site.account_id, site.host);
  const set = await getSettings();
  const plan = await one('SELECT p.disk_mb FROM hosting_accounts a JOIN hosting_plans p ON p.id = a.plan_id WHERE a.id = ?', [site.account_id]);
  const lim = { quotaBytes: plan.disk_mb * 1048576, maxFileBytes: Number(set.hosting_max_file_kb || 5120) * 1024 };
  const files = (await listFiles(gitdir, oid)).filter((f) => !SKIP(f.path) && f.mode !== '120000' && f.mode !== '160000');
  const prev = await one("SELECT files FROM hub_deploys WHERE repo_id = ? AND site_id = ? AND status = 'ok' ORDER BY id DESC LIMIT 1", [repo.id, site.id]);
  const prevFiles = new Set(prev ? (typeof prev.files === 'string' ? JSON.parse(prev.files) : prev.files) || [] : []);
  try {
    for (const f of files) {
      const blob = await readPath(gitdir, oid, f.path);
      await writeFile(dir, accountDir(site.account_id), f.path, blob.buf.toString('base64'), { ...lim, binary: true });
      prevFiles.delete(f.path);
    }
    for (const old of prevFiles) {
      try { await fs.rm(safeJoin(dir, old).full, { force: true }); } catch { /* неверный путь — пропускаем */ }
    }
  } catch (e) {
    await refreshUsage(site.account_id);
    return save(repo, site, oid, 'failed', e.message, null);
  }
  closeDb(site.id);
  await refreshUsage(site.account_id);
  return save(repo, site, oid, 'ok', `Выложено файлов: ${files.length}`, files.map((f) => f.path));
}

async function save(repo, site, oid, status, message, files) {
  await q('INSERT INTO hub_deploys (repo_id, site_id, commit_oid, status, message, files) VALUES (?, ?, ?, ?, ?, ?)', [repo.id, site.id, oid, status, message, files ? JSON.stringify(files) : null]);
  return { status, message, host: site.host };
}

// ——— git по HTTP ———

const GIT_PATH = /^\/([a-z0-9-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/(info\/refs|git-upload-pack|git-receive-pack)$/;
export const isGitPath = (p) => GIT_PATH.test(String(p).split('?')[0]);

const unauthorized = () => ({ status: 401, headers: { 'www-authenticate': 'Basic realm="VlodHub"', 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from('Нужен логин ВлодХаба и токен доступа (Настройки → Токены)\n') });
const textRes = (status, text) => ({ status, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: Buffer.from(`${text}\n`) });

/**
 * Запрос git-клиента: { method, path (с ?query), headers, body } → { status, headers, body }.
 * Один обработчик и для настоящего интернета (/api/hub/git/...), и для БалНета (https://vlodhub.bln/...).
 */
export async function gitHttp({ method, path: urlPath, headers = {}, body }) {
  const [pathOnly, query = ''] = String(urlPath).split('?');
  const m = GIT_PATH.exec(pathOnly);
  if (!m) return textRes(404, 'Не найдено');
  const [, owner, name, action] = m;
  const service = action === 'info/refs' ? new URLSearchParams(query).get('service') : action;
  if (service !== 'git-upload-pack' && service !== 'git-receive-pack') return textRes(403, 'Поддерживается только smart HTTP');
  const repo = await repoBy(owner, name);
  const user = await userFromBasic(headers.authorization || headers.Authorization);
  if (!repo) return user ? textRes(404, 'Репозиторий не найден') : unauthorized();
  const a = await access(repo, user);
  if (!a.read) return user ? textRes(404, 'Репозиторий не найден') : unauthorized();
  if (service === 'git-receive-pack' && !a.write) return user ? textRes(403, `Нет прав на запись в ${owner}/${name}`) : unauthorized();
  const gitdir = gitdirOf(repo);
  const noCache = { 'cache-control': 'no-cache' };
  if (action === 'info/refs') {
    return { status: 200, headers: { 'content-type': `application/x-${service}-advertisement`, ...noCache }, body: await advertise(gitdir, service) };
  }
  if (method !== 'POST') return textRes(405, 'Нужен POST');
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(body || '');
  if (service === 'git-upload-pack') {
    return { status: 200, headers: { 'content-type': 'application/x-git-upload-pack-result', ...noCache }, body: await uploadPack(gitdir, buf) };
  }
  const r = await receivePack(gitdir, buf);
  if (r.updates.length) {
    await q('UPDATE hub_repos SET pushed_at = NOW(3) WHERE id = ?', [repo.id]);
    // Первая ветка в пустом репозитории — основная; HEAD указывает на неё.
    const fresh = await one('SELECT * FROM hub_repos WHERE id = ?', [repo.id]);
    const heads = r.updates.filter((u) => u.ref.startsWith('refs/heads/') && u.newOid !== ZERO);
    const { refsOf } = await import('./git.js');
    const all = await refsOf(gitdir);
    if (heads.length && !all.some((x) => x.ref === `refs/heads/${fresh.default_branch}`)) {
      const b = heads[0].ref.slice(11);
      await q('UPDATE hub_repos SET default_branch = ? WHERE id = ?', [b, repo.id]);
      await fs.writeFile(path.join(gitdir, 'HEAD'), `ref: refs/heads/${b}\n`);
      fresh.default_branch = b;
    }
    const target = fresh.deploy_site_id ? heads.find((u) => u.ref === `refs/heads/${fresh.deploy_branch || fresh.default_branch}`) : null;
    if (target) await deploy(fresh, target.newOid);
  }
  return { status: 200, headers: { 'content-type': 'application/x-git-receive-pack-result', ...noCache }, body: r.response };
}
