// Этап Н7: ВлодХаб — настоящий git по HTTP (git clone/push системным git через API), git внутри БалНета
// из SSH хостинга (https://vlodhub.bln), деплой на сайт по push, приватные репозитории и соавторы,
// задачи, запросы на слияние со слиянием и деплоем, правка файла в браузере.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setup, client, pool } from './helpers.js';

let app;
let base;
let clock;
const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'bln-hub-'));
const hasGit = (() => { try { execFileSync('git', ['--version']); return true; } catch { return false; } })();

before(async () => {
  app = await setup();
  clock = await import('../src/lib/clock.js');
  clock.setGameTimeOverride(() => 200000);
  (await import('../src/lib/dns.js')).flushResolverCache();
  await app.listen({ port: 0, host: '127.0.0.1' });
  base = `http://127.0.0.1:${app.server.address().port}`;
});
after(async () => {
  await (await import('../src/lib/vhost/pool.js')).stopPools();
  clock.setGameTimeOverride(null);
  await fs.rm(tmp, { recursive: true, force: true });
  await fs.rm(process.env.BALNET_SITES_DIR, { recursive: true, force: true });
  await app.close();
  await pool.end();
});

async function player(email, name) {
  const gov = client(app);
  await gov.post('/api/auth/gov/register', { email, password: 'password123', display_name: name });
  await gov.post('/api/gov/passport', { full_name: name, birth_date: '1990-05-01', address: 'Влодоград' });
  const me = await gov.get('/api/gov/me');
  const bank = client(app);
  await bank.post('/api/auth/bank/register', { email, password: 'password123', full_name: name, birth_date: '1990-05-01', passport_no: me.passport.number });
  const links = await gov.get('/api/gov/links');
  await gov.post(`/api/gov/links/${links.links[0].id}/confirm`);
  const cur = (await bank.post('/api/bank/accounts', { type: 'current' })).account;
  return { gov, bank, cur };
}
const pay = (p, number) => p.bank.post(`/api/bank/invoices/${number}/pay`, { account_id: p.cur.id });
const DEV = 'device-hub-01';
// Асинхронно: сервер ВлодХаба работает в этом же процессе и должен отвечать git, пока тот ждёт.
const gitx = async (cwd, ...args) => {
  try {
    const r = await promisify(execFile)('git', ['-c', 'user.name=Борис', '-c', 'user.email=b@b.bf', '-c', 'init.defaultBranch=main', '-c', 'credential.helper=', ...args], { cwd, encoding: 'utf8', timeout: 30000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' } });
    return r.stdout;
  } catch (e) {
    throw new Error(`${e.message}\n${e.stderr || ''}`);
  }
};

let boris;
let anna;
let dev;
let token;
let site;
let acc;

test('setup: логины ВлодХаба, токен, сайт на хостинге', async () => {
  const admin = client(app);
  await admin.post('/api/auth/gov/register', { email: 'admin@test.bf', password: 'password123', display_name: 'Админ' });
  await admin.patch('/api/admin/settings', { fraud_threshold: 0, fraud_velocity: 0, fraud_multiplier: 0, start_balance: 200000, transfer_fee_bp: 0, transfer_fee_min: 0, vat_bp: 0 });
  boris = await player('boris@test.bf', 'Борис Гитов');
  anna = await player('anna@test.bf', 'Анна Ревьюер');
  dev = client(app);
  await dev.post('/api/net/lease', { client_id: DEV, provider: 'baltelecom' });
  assert.deepEqual((await boris.gov.get('/api/hub/me')).user, null);
  await assert.rejects(boris.gov.post('/api/hub/me', { login: 'Борис' }), /латинские/);
  await boris.gov.post('/api/hub/me', { login: 'boris' });
  await assert.rejects(anna.gov.post('/api/hub/me', { login: 'boris' }), /занят/);
  await anna.gov.post('/api/hub/me', { login: 'anna' });
  token = (await boris.gov.post('/api/hub/tokens', { name: 'ноутбук' })).token;
  assert.match(token, /^vh_/);
  // Сайт для деплоя.
  const r = await boris.gov.post('/api/gov/domains', { name: 'boris.bln' });
  await pay(boris, r.invoice);
  const plan = (await boris.gov.get('/api/gov/hosting')).offers.find((o) => o.name === 'Сервер');
  const h = await boris.gov.post('/api/gov/hosting', { plan_id: plan.id, months: 2 });
  await pay(boris, h.invoice);
  acc = h.account_id;
  site = await boris.gov.post(`/api/gov/hosting/${acc}/sites`, { host: 'boris.bln' });
  const d = (await boris.gov.get('/api/gov/domains')).domains[0];
  await boris.gov.post(`/api/gov/domains/${d.id}/records`, { name: '@', type: 'A', data: site.ip });
});

test('репозиторий с README, файлы и коммиты в API, правка в браузере', async () => {
  await boris.gov.post('/api/hub/repos', { name: 'site', description: 'Сайт пекарни', readme: true });
  await assert.rejects(boris.gov.post('/api/hub/repos', { name: 'site' }), /уже есть/);
  const r = await client(app).get('/api/hub/repos/boris/site');
  assert.equal(r.repo.default_branch, 'main');
  assert.equal(r.clone.balnet, 'https://vlodhub.bln/boris/site.git');
  const tree = await client(app).get('/api/hub/repos/boris/site/tree');
  assert.deepEqual(tree.entries.map((e) => e.name), ['README.md']);
  await boris.gov.put('/api/hub/repos/boris/site/file', { path: 'index.html', content: '<h1>v1</h1>', message: 'Главная' });
  const log = await client(app).get('/api/hub/repos/boris/site/commits');
  assert.deepEqual(log.commits.map((c) => c.message.trim()), ['Главная', 'Первый коммит']);
  const c = await client(app).get(`/api/hub/repos/boris/site/commit/${log.commits[0].oid}`);
  assert.deepEqual(c.files, [{ path: 'index.html', status: 'added' }]);
  await assert.rejects(anna.gov.put('/api/hub/repos/boris/site/file', { path: 'x', content: 'x' }), /права на запись/);
});

test('настоящий git по HTTP: clone, push с токеном, деплой на сайт хостинга', { skip: !hasGit }, async () => {
  await boris.gov.patch('/api/hub/repos/boris/site', { deploy_site_id: site.id });
  await assert.rejects(anna.gov.patch('/api/hub/repos/boris/site', { private: true }), /владелец/);
  const url = `${base}/api/hub/git/boris/site.git`;
  await gitx(tmp, 'clone', '-q', url, 'w');
  const w = path.join(tmp, 'w');
  assert.equal(await fs.readFile(path.join(w, 'index.html'), 'utf8'), '<h1>v1</h1>');
  await fs.writeFile(path.join(w, 'index.html'), '<h1>v2 из git</h1>');
  await fs.mkdir(path.join(w, 'css'));
  await fs.writeFile(path.join(w, 'css/s.css'), 'h1{color:red}');
  await gitx(w, 'add', '-A');
  await gitx(w, 'commit', '-qm', 'Вторая версия');
  await assert.rejects(gitx(w, 'push', '-q', 'origin', 'main'), /Authentication failed|could not read Username|401/);
  await gitx(w, 'push', '-q', `http://boris:${token}@127.0.0.1:${new URL(base).port}/api/hub/git/boris/site.git`, 'main');
  const info = await boris.gov.get('/api/hub/repos/boris/site');
  assert.equal(info.deploys[0].status, 'ok', JSON.stringify(info.deploys));
  // Сайт обновился.
  const o = await dev.post('/api/net/open', { client_id: DEV, url: 'http://boris.bln/' });
  const page = await app.inject({ method: 'GET', url: `/api/net/web/${o.ticket}/` });
  assert.match(page.body, /v2 из git/);
  assert.equal((await app.inject({ method: 'GET', url: `/api/net/web/${o.ticket}/css/s.css` })).body, 'h1{color:red}');
  assert.equal((await app.inject({ method: 'GET', url: `/api/net/web/${o.ticket}/README.md` })).statusCode, 200);
});

test('git внутри БалНета: SSH хостинга → https://vlodhub.bln, push с деплоем', { timeout: 60000 }, async () => {
  await boris.gov.post(`/api/gov/hosting/${acc}/ssh`, { password: 'ssh-secret-1' });
  const login = await dev.post('/api/net/ssh/login', { client_id: DEV, host: 'boris.bln', user: `u${acc}`, password: 'ssh-secret-1' });
  assert.ok(login.session, JSON.stringify(login));
  const sh = async (line) => {
    const r = await dev.post('/api/net/ssh/exec', { session: login.session, line });
    return r.out;
  };
  assert.match(await sh('git clone https://vlodhub.bln/boris/site.git src'), /Cloning into 'src'/);
  await sh('cd src');
  assert.match(await sh('git log --oneline'), /Вторая версия/);
  await sh('git config --global user.name "Борис с сервера"');
  await sh('echo "<h1>v3 с сервера</h1>" > index.html');
  assert.match(await sh('git status'), /modified:\s+index\.html/);
  await sh('git add .');
  assert.match(await sh('git commit -m "Правка по SSH"'), /\[main [0-9a-f]{7}\] Правка по SSH/);
  assert.match(await sh('git push'), /Authentication failed/);
  await sh(`git remote set-url origin https://boris:${token}@vlodhub.bln/boris/site.git`);
  assert.match(await sh('git remote -v'), /boris:\*\*\*@vlodhub\.bln/, 'токен не показывается');
  assert.match(await sh('git push'), /main -> main/);
  const commits = await client(app).get('/api/hub/repos/boris/site/commits');
  assert.equal(commits.commits[0].message.trim(), 'Правка по SSH');
  assert.equal(commits.commits[0].author, 'Борис с сервера');
  const o = await dev.post('/api/net/open', { client_id: DEV, url: 'http://boris.bln/' });
  assert.match((await app.inject({ method: 'GET', url: `/api/net/web/${o.ticket}/` })).body, /v3 с сервера/, 'деплой по push');
});

test('приватный репозиторий и соавторы', { skip: !hasGit }, async () => {
  await boris.gov.patch('/api/hub/repos/boris/site', { private: true });
  await assert.rejects(client(app).get('/api/hub/repos/boris/site'), /not_found/);
  await assert.rejects(gitx(tmp, 'clone', '-q', `${base}/api/hub/git/boris/site.git`, 'anon'), /Authentication failed|could not read|401/);
  const annaToken = (await anna.gov.post('/api/hub/tokens', {})).token;
  const port = new URL(base).port;
  await assert.rejects(gitx(tmp, 'clone', '-q', `http://anna:${annaToken}@127.0.0.1:${port}/api/hub/git/boris/site.git`, 'a1'), /not found|404/);
  await boris.gov.post('/api/hub/repos/boris/site/collaborators', { login: 'anna' });
  await gitx(tmp, 'clone', '-q', `http://anna:${annaToken}@127.0.0.1:${port}/api/hub/git/boris/site.git`, 'a2');
  assert.match(await fs.readFile(path.join(tmp, 'a2/index.html'), 'utf8'), /v3/);
});

test('задачи и запрос на слияние: ветка, PR, комментарий, слияние с деплоем', async () => {
  const i = await anna.gov.post('/api/hub/repos/boris/site/issues', { title: 'Нет страницы меню', body: 'Добавьте меню' });
  assert.equal(i.number, 1);
  await anna.gov.post('/api/hub/repos/boris/site/branches', { name: 'menu' });
  await anna.gov.put('/api/hub/repos/boris/site/file', { branch: 'menu', path: 'menu.html', content: '<h1>Меню</h1>', message: 'Меню (#1)' });
  const pr = await anna.gov.post('/api/hub/repos/boris/site/issues', { kind: 'pr', title: 'Страница меню', head: 'menu', base: 'main' });
  assert.equal(pr.number, 2);
  const v = await boris.gov.get('/api/hub/repos/boris/site/issues/2');
  assert.deepEqual(v.pr.files, [{ path: 'menu.html', status: 'added' }]);
  assert.equal(v.pr.commits.length, 1);
  assert.equal(v.pr.fast_forward, true);
  await boris.gov.post('/api/hub/repos/boris/site/issues/2/comments', { body: 'Отлично, сливаю' });
  const m = await boris.gov.post('/api/hub/repos/boris/site/issues/2/merge');
  assert.equal(m.ok, true);
  const after = await boris.gov.get('/api/hub/repos/boris/site/issues/2');
  assert.equal(after.issue.state, 'merged');
  assert.equal(after.comments[0].body, 'Отлично, сливаю');
  await anna.gov.patch('/api/hub/repos/boris/site/issues/1', { state: 'closed' });
  assert.equal((await boris.gov.get('/api/hub/repos/boris/site/issues?state=closed')).issues[0].number, 1);
  const o = await dev.post('/api/net/open', { client_id: DEV, url: 'http://boris.bln/menu.html' });
  assert.match((await app.inject({ method: 'GET', url: `/api/net/web/${o.ticket}/menu.html` })).body, /Меню/, 'слияние в основную ветку выкладывает сайт');
  // Разошедшиеся ветки — настоящий коммит слияния.
  await boris.gov.post('/api/hub/repos/boris/site/branches', { name: 'about' });
  await boris.gov.put('/api/hub/repos/boris/site/file', { branch: 'about', path: 'about.html', content: 'о нас', message: 'О нас' });
  await boris.gov.put('/api/hub/repos/boris/site/file', { branch: 'main', path: 'news.html', content: 'новости', message: 'Новости' });
  await boris.gov.post('/api/hub/repos/boris/site/issues', { kind: 'pr', title: 'О нас', head: 'about', base: 'main' });
  const m2 = await boris.gov.post('/api/hub/repos/boris/site/issues/3/merge');
  assert.equal(m2.fast_forward, false);
  const top = (await boris.gov.get('/api/hub/repos/boris/site/commits')).commits[0];
  assert.equal(top.parents.length, 2, 'коммит слияния с двумя родителями');
});
