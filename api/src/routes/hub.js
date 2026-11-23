// ВлодХаб: API сайта vlodhub.bln (репозитории, файлы, коммиты, задачи, запросы на слияние, деплой, токены)
// и git по HTTP из настоящего интернета: https://<api>/api/hub/git/<логин>/<репозиторий>.git
import zlib from 'node:zlib';
import { q, one } from '../db.js';
import { bad, notFound, need, int, str } from '../lib/errors.js';
import { needGov, session } from '../lib/auth.js';
import { audit } from '../lib/audit.js';
import { actorOf } from '../lib/auth.js';
import {
  hubUser, needHubUser, createUser, createToken, repoFor, createRepo, deleteRepo, gitdirOf, deployTargets, deploy, gitHttp,
} from '../lib/hub/hub.js';
import { refsOf, resolveCommit, readPath, commits, diffFiles, mergeBase, mergeBranches, commitFile } from '../lib/hub/git.js';
import git from 'isomorphic-git';
import fs from 'node:fs';

const BRANCH_RE = /^[\w./-]{1,100}$/;
const issueView = (i, users) => ({
  number: i.number, kind: i.kind, title: i.title, body: i.body, state: i.state, head: i.head, base: i.base, merged_oid: i.merged_oid,
  author: users.get(i.author_id) || '?', created_at: i.created_at, updated_at: i.updated_at,
});
async function loginsOf(ids) {
  const list = [...new Set(ids)].filter(Boolean);
  if (!list.length) return new Map();
  const rows = await q(`SELECT id, login FROM hub_users WHERE id IN (${list.map(() => '?').join(',')})`, list);
  return new Map(rows.map((r) => [r.id, r.login]));
}

export async function hubRoutes(app) {
  const auth = { preHandler: needGov() };
  // Читатель может быть анонимным (публичные репозитории).
  const viewer = async (req) => {
    const s = await session(req, 'gov').catch(() => null);
    return s ? hubUser(s.id) : null;
  };
  const me = async (req) => needHubUser(req.gov.id);

  // ——— git по HTTP (настоящий git из интернета) ———
  await app.register(async (sub) => {
    sub.removeAllContentTypeParsers();
    sub.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: 50 * 1024 * 1024 }, (req, body, done) => done(null, body));
    const handler = async (req, reply) => {
      let body = req.body || Buffer.alloc(0);
      if (/gzip/i.test(req.headers['content-encoding'] || '') && body.length) body = zlib.gunzipSync(body);
      const rest = req.url.slice(req.url.indexOf('/git/') + 4);
      const r = await gitHttp({ method: req.method, path: rest, headers: req.headers, body });
      reply.code(r.status);
      for (const [k, v] of Object.entries(r.headers)) reply.header(k, v);
      return reply.send(r.body);
    };
    sub.get('/git/*', handler);
    sub.post('/git/*', handler);
  });

  // ——— Пользователь и токены ———
  app.get('/me', async (req) => {
    const s = await session(req, 'gov').catch(() => null);
    if (!s) return { gov: null, user: null };
    return { gov: { id: s.id }, user: await hubUser(s.id) };
  });
  app.post('/me', auth, async (req) => ({ user: await createUser(req.gov.id, req.body?.login, req.body?.name) }));
  app.get('/tokens', auth, async (req) => {
    const u = await me(req);
    return { tokens: await q('SELECT id, name, prefix, last_used, created_at FROM hub_tokens WHERE user_id = ? ORDER BY id DESC', [u.id]) };
  });
  app.post('/tokens', auth, async (req) => {
    const u = await me(req);
    const token = await createToken(u, req.body?.name);
    await audit(null, actorOf(req.gov), 'hub.token', 'hub_user', u.id);
    return { token, login: u.login };
  });
  app.delete('/tokens/:id', auth, async (req) => {
    const u = await me(req);
    await q('DELETE FROM hub_tokens WHERE id = ? AND user_id = ?', [int(req.params.id, 'id'), u.id]);
    return { ok: true };
  });

  // ——— Репозитории ———
  app.get('/repos', async (req) => {
    const u = await viewer(req);
    const owner = req.query.owner ? String(req.query.owner).toLowerCase() : null;
    const rows = await q(
      `SELECT r.*, u.login AS owner_login FROM hub_repos r JOIN hub_users u ON u.id = r.owner_id
       LEFT JOIN hub_collaborators c ON c.repo_id = r.id AND c.user_id = ?
       WHERE (r.private = 0 OR r.owner_id = ? OR c.user_id IS NOT NULL) ${owner ? 'AND u.login = ?' : ''}
       ORDER BY COALESCE(r.pushed_at, r.created_at) DESC LIMIT 100`, [u?.id || 0, u?.id || 0, ...(owner ? [owner] : [])],
    );
    return { repos: rows.map((r) => ({ owner: r.owner_login, name: r.name, description: r.description, private: !!r.private, pushed_at: r.pushed_at, mine: r.owner_id === u?.id })) };
  });

  app.post('/repos', auth, async (req) => {
    const u = await me(req);
    const r = await createRepo(u, req.body || {});
    return { owner: u.login, name: r.name };
  });

  const ctx = async (req, level = 'read') => {
    const u = await viewer(req);
    const r = await repoFor(req.params.owner, req.params.name, u, level);
    return { ...r, user: u, gitdir: gitdirOf(r.repo) };
  };

  app.get('/repos/:owner/:name', async (req) => {
    const { repo, access, gitdir } = await ctx(req);
    const refs = await refsOf(gitdir);
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    const deploys = await q('SELECT d.*, s.host FROM hub_deploys d LEFT JOIN hosting_sites s ON s.id = d.site_id WHERE d.repo_id = ? ORDER BY d.id DESC LIMIT 10', [repo.id]);
    const site = repo.deploy_site_id ? await one('SELECT id, host FROM hosting_sites WHERE id = ?', [repo.deploy_site_id]) : null;
    const counts = await one("SELECT SUM(kind = 'issue' AND state = 'open') AS issues, SUM(kind = 'pr' AND state = 'open') AS prs FROM hub_issues WHERE repo_id = ?", [repo.id]);
    const collabs = access.admin ? await q('SELECT u.login FROM hub_collaborators c JOIN hub_users u ON u.id = c.user_id WHERE c.repo_id = ?', [repo.id]) : [];
    return {
      repo: {
        owner: repo.owner_login, name: repo.name, description: repo.description, private: !!repo.private, default_branch: repo.default_branch,
        deploy: site ? { site_id: site.id, host: site.host, branch: repo.deploy_branch || repo.default_branch } : null, empty: !refs.length,
      },
      access,
      branches: refs.filter((r) => r.ref.startsWith('refs/heads/')).map((r) => ({ name: r.ref.slice(11), oid: r.oid })),
      tags: refs.filter((r) => r.ref.startsWith('refs/tags/')).map((r) => ({ name: r.ref.slice(10), oid: r.oid })),
      clone: { balnet: `https://vlodhub.bln/${repo.owner_login}/${repo.name}.git`, internet: `${req.protocol}://${host}/api/hub/git/${repo.owner_login}/${repo.name}.git` },
      open: { issues: Number(counts.issues || 0), prs: Number(counts.prs || 0) },
      deploys: deploys.map((d) => ({ id: d.id, host: d.host, commit: d.commit_oid, status: d.status, message: d.message, at: d.created_at })),
      collaborators: collabs.map((c) => c.login),
    };
  });

  app.patch('/repos/:owner/:name', auth, async (req) => {
    const { repo, gitdir } = await ctx(req, 'admin');
    const b = req.body || {};
    const set = {};
    if (b.description !== undefined) set.description = String(b.description).slice(0, 300) || null;
    if (b.private !== undefined) set.private = b.private ? 1 : 0;
    if (b.default_branch !== undefined) {
      need(BRANCH_RE.test(b.default_branch), 'Неверное имя ветки');
      await resolveCommit(gitdir, b.default_branch).catch(() => { throw bad('no_branch', 'Такой ветки нет'); });
      set.default_branch = b.default_branch;
      await fs.promises.writeFile(`${gitdir}/HEAD`, `ref: refs/heads/${b.default_branch}\n`);
    }
    if (b.deploy_site_id !== undefined) {
      if (b.deploy_site_id) {
        const targets = await deployTargets(req.gov.id);
        need(targets.some((t) => t.id === Number(b.deploy_site_id)), 'Выкладывать можно только на свои сайты хостинга');
        set.deploy_site_id = Number(b.deploy_site_id);
      } else set.deploy_site_id = null;
    }
    if (b.deploy_branch !== undefined) { need(!b.deploy_branch || BRANCH_RE.test(b.deploy_branch), 'Неверное имя ветки'); set.deploy_branch = b.deploy_branch || null; }
    const keys = Object.keys(set);
    if (keys.length) await q(`UPDATE hub_repos SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...keys.map((k) => set[k]), repo.id]);
    return { ok: true };
  });

  app.delete('/repos/:owner/:name', auth, async (req) => {
    const { repo } = await ctx(req, 'admin');
    await deleteRepo(repo);
    return { ok: true };
  });

  app.get('/deploy-targets', auth, async (req) => ({ sites: await deployTargets(req.gov.id) }));

  app.post('/repos/:owner/:name/deploy', auth, async (req) => {
    const { repo, gitdir } = await ctx(req, 'admin');
    need(repo.deploy_site_id, 'Не выбран сайт для деплоя');
    return deploy(repo, await resolveCommit(gitdir, repo.deploy_branch || repo.default_branch));
  });

  app.post('/repos/:owner/:name/collaborators', auth, async (req) => {
    const { repo } = await ctx(req, 'admin');
    const u = await one('SELECT id FROM hub_users WHERE login = ?', [String(req.body?.login || '').toLowerCase()]);
    if (!u) throw notFound('Пользователь ВлодХаба не найден');
    need(u.id !== repo.owner_id, 'Это владелец');
    await q('INSERT IGNORE INTO hub_collaborators (repo_id, user_id) VALUES (?, ?)', [repo.id, u.id]);
    return { ok: true };
  });
  app.delete('/repos/:owner/:name/collaborators/:login', auth, async (req) => {
    const { repo } = await ctx(req, 'admin');
    await q('DELETE c FROM hub_collaborators c JOIN hub_users u ON u.id = c.user_id WHERE c.repo_id = ? AND u.login = ?', [repo.id, req.params.login]);
    return { ok: true };
  });

  // ——— Файлы и коммиты ———
  app.get('/repos/:owner/:name/tree', async (req) => {
    const { repo, gitdir } = await ctx(req);
    let oid;
    try { oid = await resolveCommit(gitdir, req.query.ref || repo.default_branch); } catch { return { empty: true }; }
    const r = await readPath(gitdir, oid, String(req.query.path || ''));
    if (!r) throw notFound('Нет такого пути');
    const rest = { ...r };
    delete rest.buf;
    const last = (await commits(gitdir, oid, 1))[0];
    return { commit: oid, last, ...rest, content: rest.content && rest.content.length > 500_000 ? null : rest.content };
  });

  app.get('/repos/:owner/:name/commits', async (req) => {
    const { repo, gitdir } = await ctx(req);
    try { return { commits: await commits(gitdir, req.query.ref || repo.default_branch, Math.min(200, Number(req.query.limit) || 50)) }; } catch { return { commits: [] }; }
  });

  app.get('/repos/:owner/:name/commit/:oid', async (req) => {
    const { gitdir } = await ctx(req);
    const oid = String(req.params.oid);
    need(/^[0-9a-f]{40}$/.test(oid), 'Неверный коммит');
    const c = await git.readCommit({ fs, gitdir, oid }).catch(() => null);
    if (!c) throw notFound('Коммит не найден');
    const files = await diffFiles(gitdir, c.commit.parent[0] || null, oid);
    return { oid, message: c.commit.message, author: c.commit.author.name, at: c.commit.author.timestamp * 1000, parents: c.commit.parent, files };
  });

  /** Правка файла в браузере — коммит в ветку. */
  app.put('/repos/:owner/:name/file', auth, async (req) => {
    const { repo, gitdir, user } = await ctx(req, 'write');
    const b = req.body || {};
    const branch = String(b.branch || repo.default_branch);
    need(BRANCH_RE.test(branch), 'Неверное имя ветки');
    const filepath = String(b.path || '').replace(/^\/+/, '');
    need(filepath && !filepath.split('/').some((p) => !p || p === '.' || p === '..' || p === '.git'), 'Неверный путь файла');
    need(String(b.content ?? '').length <= 1024 * 1024, 'Файл больше 1 МБ — загрузите его через git push');
    const oid = await commitFile(gitdir, { branch, filepath, content: b.content ?? '', message: str(b.message || `Обновить ${filepath}`, 'сообщение', { max: 500 }), author: { name: user.name || user.login, email: `${user.login}@vlodhub.bln` } });
    await q('UPDATE hub_repos SET pushed_at = NOW(3) WHERE id = ?', [repo.id]);
    if (repo.deploy_site_id && branch === (repo.deploy_branch || repo.default_branch)) await deploy(repo, oid);
    return { commit: oid };
  });

  app.post('/repos/:owner/:name/branches', auth, async (req) => {
    const { repo, gitdir } = await ctx(req, 'write');
    const name = String(req.body?.name || '');
    need(BRANCH_RE.test(name) && !name.includes('..'), 'Имя ветки: латиница, цифры, «/», «-», «_»');
    const from = await resolveCommit(gitdir, req.body?.from || repo.default_branch);
    await git.writeRef({ fs, gitdir, ref: `refs/heads/${name}`, value: from, force: false }).catch(() => { throw bad('exists', 'Такая ветка уже есть'); });
    return { ok: true };
  });

  // ——— Задачи и запросы на слияние ———
  app.get('/repos/:owner/:name/issues', async (req) => {
    const { repo } = await ctx(req);
    const kind = req.query.kind === 'pr' ? 'pr' : 'issue';
    const state = ['open', 'closed', 'merged', 'all'].includes(req.query.state) ? req.query.state : 'open';
    const rows = await q(`SELECT * FROM hub_issues WHERE repo_id = ? AND kind = ? ${state === 'all' ? '' : state === 'closed' ? "AND state IN ('closed','merged')" : 'AND state = ?'} ORDER BY number DESC LIMIT 200`, [repo.id, kind, ...(state === 'open' || state === 'merged' ? [state] : [])]);
    const users = await loginsOf(rows.map((r) => r.author_id));
    return { issues: rows.map((r) => issueView(r, users)) };
  });

  app.post('/repos/:owner/:name/issues', auth, async (req) => {
    const u = await me(req);
    const { repo, gitdir, access } = await ctx(req, 'read');
    const b = req.body || {};
    const kind = b.kind === 'pr' ? 'pr' : 'issue';
    const title = str(b.title, 'заголовок', { max: 200 });
    let head = null;
    let base = null;
    if (kind === 'pr') {
      need(access.write, 'Запрос на слияние создают участники репозитория (ветки — в этом репозитории)');
      head = String(b.head || '');
      base = String(b.base || repo.default_branch);
      need(head !== base, 'Выберите разные ветки');
      await resolveCommit(gitdir, head).catch(() => { throw bad('no_branch', `Нет ветки ${head}`); });
      await resolveCommit(gitdir, base).catch(() => { throw bad('no_branch', `Нет ветки ${base}`); });
    }
    const n = await one('SELECT COALESCE(MAX(number), 0) + 1 AS n FROM hub_issues WHERE repo_id = ?', [repo.id]);
    await q('INSERT INTO hub_issues (repo_id, number, kind, title, body, author_id, head, base) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', [repo.id, n.n, kind, title, String(b.body || '').slice(0, 20000) || null, u.id, head, base]);
    return { number: Number(n.n) };
  });

  const issueOf = async (repo, num) => {
    const i = await one('SELECT * FROM hub_issues WHERE repo_id = ? AND number = ?', [repo.id, int(num, 'номер')]);
    if (!i) throw notFound('Не найдено');
    return i;
  };

  app.get('/repos/:owner/:name/issues/:num', async (req) => {
    const { repo, gitdir, access } = await ctx(req);
    const i = await issueOf(repo, req.params.num);
    const comments = await q('SELECT * FROM hub_comments WHERE issue_id = ? ORDER BY id', [i.id]);
    const users = await loginsOf([i.author_id, ...comments.map((c) => c.author_id)]);
    const out = { issue: issueView(i, users), comments: comments.map((c) => ({ id: c.id, author: users.get(c.author_id), body: c.body, at: c.created_at })), access };
    if (i.kind === 'pr' && i.state === 'open') {
      try {
        const h = await resolveCommit(gitdir, i.head);
        const b = await resolveCommit(gitdir, i.base);
        const mb = await mergeBase(gitdir, h, b);
        const list = await commits(gitdir, h, 100);
        const cut = mb ? list.findIndex((c) => c.oid === mb) : -1;
        out.pr = { files: await diffFiles(gitdir, mb, h), commits: (cut >= 0 ? list.slice(0, cut) : list).slice(0, 50), up_to_date: mb === h, fast_forward: mb === b };
      } catch { out.pr = { error: 'Ветка удалена' }; }
    }
    return out;
  });

  app.post('/repos/:owner/:name/issues/:num/comments', auth, async (req) => {
    const u = await me(req);
    const { repo } = await ctx(req);
    const i = await issueOf(repo, req.params.num);
    await q('INSERT INTO hub_comments (issue_id, author_id, body) VALUES (?, ?, ?)', [i.id, u.id, str(req.body?.body, 'комментарий', { max: 20000 })]);
    await q('UPDATE hub_issues SET updated_at = NOW(3) WHERE id = ?', [i.id]);
    return { ok: true };
  });

  app.patch('/repos/:owner/:name/issues/:num', auth, async (req) => {
    const u = await me(req);
    const { repo, access } = await ctx(req);
    const i = await issueOf(repo, req.params.num);
    need(access.write || i.author_id === u.id, 'Закрыть может автор или участник репозитория');
    need(i.state !== 'merged', 'Уже слито');
    const state = req.body?.state === 'open' ? 'open' : 'closed';
    await q('UPDATE hub_issues SET state = ?, updated_at = NOW(3) WHERE id = ?', [state, i.id]);
    return { ok: true };
  });

  app.post('/repos/:owner/:name/issues/:num/merge', auth, async (req) => {
    const { repo, gitdir, user } = await ctx(req, 'write');
    const i = await issueOf(repo, req.params.num);
    need(i.kind === 'pr' && i.state === 'open', 'Сливать можно только открытый запрос на слияние');
    let r;
    try {
      r = await mergeBranches(gitdir, { base: i.base, head: i.head, author: { name: user.name || user.login, email: `${user.login}@vlodhub.bln`, timestamp: Math.floor(Date.now() / 1000), timezoneOffset: 0 }, message: `Слияние запроса #${i.number} из ${i.head}\n\n${i.title}` });
    } catch (e) {
      throw bad('conflict', e.code === 'MergeConflictError' || /conflict/i.test(e.message) ? `Конфликт слияния в файлах: ${(e.data?.filepaths || []).join(', ') || 'см. ветки'}. Слейте ${i.base} в ${i.head} локально и отправьте push.` : `Не удалось слить: ${e.message}`);
    }
    const oid = r.oid || (await resolveCommit(gitdir, i.base));
    await q("UPDATE hub_issues SET state = 'merged', merged_oid = ?, updated_at = NOW(3) WHERE id = ?", [oid, i.id]);
    await q('UPDATE hub_repos SET pushed_at = NOW(3) WHERE id = ?', [repo.id]);
    if (repo.deploy_site_id && i.base === (repo.deploy_branch || repo.default_branch)) await deploy(repo, oid);
    return { ok: true, commit: oid, fast_forward: !!r.fastForward };
  });
}
