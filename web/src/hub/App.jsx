// ВлодХаб (vlodhub.bln) — git-хостинг БалНета: репозитории, файлы и коммиты, задачи, запросы на слияние,
// деплой на сайт хостинга по push, токены доступа для git.
import { useEffect, useState } from 'react';
import { get, post, put, patch, del } from '../shared/api.js';
import { useLang } from '../shared/i18n.js';
import { useRoute, pick, navigate } from '../shared/router.js';
import { Topbar, NavLink, Spinner, useAsync, Empty, ErrorBox, Badge, Button, ActionButton, Input, Field, useToast, Select } from '../shared/ui.jsx';
import { HubLogo } from '../shared/brand.jsx';
import { SiteFooter, Hero, Section, Features, GovLogin } from '../shared/site.jsx';

const ago = (d) => {
  if (!d) return '';
  const s = Math.max(1, Math.floor((Date.now() - new Date(d).getTime()) / 1000));
  if (s < 60) return `${s} с назад`;
  if (s < 3600) return `${Math.floor(s / 60)} мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)} ч назад`;
  return new Date(d).toLocaleDateString('ru-RU');
};
const STATUS = { added: ['ok', 'добавлен'], modified: ['warn', 'изменён'], deleted: ['err', 'удалён'] };
const enc = encodeURIComponent;

export default function App() {
  useLang();
  const route = useRoute();
  const me = useAsync(() => get('/hub/me'), []);
  const user = me.data?.user;
  const nav = (
    <>
      <NavLink href="#/" path={route.path}>Обзор</NavLink>
      <NavLink href="#/explore" path={route.path}>Все репозитории</NavLink>
      {user && <NavLink href="#/new" path={route.path}>Новый</NavLink>}
      {user && <NavLink href="#/settings/tokens" path={route.path}>Токены</NavLink>}
    </>
  );
  const right = user ? <a className="tb-btn" href={`#/${user.login}`}>@{user.login}</a> : me.data?.gov ? null : <a className="tb-btn" href="#/login">Войти</a>;
  if (!me.data) return me.error ? <ErrorBox error={me.error} /> : <Spinner />;
  const needUser = (render) => {
    if (!me.data.gov) return <div className="page narrow"><GovLogin app="hub" siteName="vlodhub.bln" /></div>;
    if (!user) return <ChooseLogin onDone={me.reload} />;
    return render();
  };
  return (
    <>
      <Topbar variant="site" brand={<><HubLogo /> <span>ВлодХаб</span></>} nav={nav} right={right} />
      <main style={{ flex: 1 }}>
        {pick([
          ['/', () => (me.data.gov && !user ? <ChooseLogin onDone={me.reload} /> : user ? <Dashboard user={user} /> : <Landing />)],
          ['/login', () => <div className="page narrow"><GovLogin app="hub" siteName="vlodhub.bln" hash="#/" /></div>],
          ['/explore', () => <RepoList title="Все репозитории" />],
          ['/new', () => needUser(() => <NewRepo user={user} />)],
          ['/settings/tokens', () => needUser(() => <Tokens />)],
          ['/:owner', (p) => <RepoList owner={p.owner} title={`@${p.owner}`} />],
          ['/:owner/:name', (p) => <Repo p={p} tab="code" route={route} user={user} />],
          ['/:owner/:name/commits', (p) => <Repo p={p} tab="commits" route={route} user={user} />],
          ['/:owner/:name/commit/:oid', (p) => <Repo p={p} tab="commit" route={route} user={user} />],
          ['/:owner/:name/edit', (p) => <Repo p={p} tab="edit" route={route} user={user} />],
          ['/:owner/:name/issues', (p) => <Repo p={p} tab="issues" route={route} user={user} />],
          ['/:owner/:name/pulls', (p) => <Repo p={p} tab="pulls" route={route} user={user} />],
          ['/:owner/:name/issues/new', (p) => <Repo p={p} tab="newissue" route={route} user={user} />],
          ['/:owner/:name/pulls/new', (p) => <Repo p={p} tab="newpull" route={route} user={user} />],
          ['/:owner/:name/issues/:num', (p) => <Repo p={p} tab="issue" route={route} user={user} />],
          ['/:owner/:name/pulls/:num', (p) => <Repo p={p} tab="issue" route={route} user={user} />],
          ['/:owner/:name/settings', (p) => <Repo p={p} tab="settings" route={route} user={user} />],
          ['*', () => <Empty>Страница не найдена</Empty>],
        ], route.path)}
      </main>
      <SiteFooter
        brand="ВлодХаб"
        about="Git-хостинг БалНета: репозитории, задачи, запросы на слияние и выкладка сайтов на хостинг по git push."
        columns={[
          { title: 'ВлодХаб', links: [{ href: '#/explore', label: 'Все репозитории' }, { href: '#/new', label: 'Создать репозиторий' }, { href: '#/settings/tokens', label: 'Токены доступа' }] },
          { title: 'Сервисы БалНета', links: [{ href: '../hosting/#/', label: 'БалХост — хостинг' }, { href: '../reg/#/', label: 'БалРег — домены' }, { href: '../poisk/#/', label: 'ВлодПоиск' }] },
        ]}
      />
    </>
  );
}

function Landing() {
  return (
    <>
      <Hero kicker="vlodhub.bln · git-хостинг" title="Код вашего сайта — в git" lead="Храните сайт в репозитории, работайте вместе через запросы на слияние и выкладывайте на хостинг одним git push." art="🌿">
        <a className="btn light" href="#/login">Начать</a>
        <a className="btn ghost light" href="#/explore">Смотреть репозитории</a>
      </Hero>
      <Section title="Как это работает">
        <Features items={[
          { icon: '🔀', title: 'Настоящий git', text: 'git clone, commit, push — из SSH хостинга по https://vlodhub.bln или с компьютера по адресу API.' },
          { icon: '🚀', title: 'Деплой по push', text: 'Привяжите репозиторий к сайту на БалХосте — каждый push в основную ветку выкладывает сайт.' },
          { icon: '🐞', title: 'Задачи', text: 'Сообщайте об ошибках и обсуждайте планы прямо в репозитории.' },
          { icon: '🤝', title: 'Запросы на слияние', text: 'Работайте в ветке, откройте запрос, обсудите изменения и слейте одной кнопкой.' },
        ]} />
      </Section>
    </>
  );
}

function ChooseLogin({ onDone }) {
  const [login, setLogin] = useState('');
  const [name, setName] = useState('');
  const toast = useToast();
  return (
    <div className="page narrow">
      <h1>Добро пожаловать на ВлодХаб</h1>
      <p className="muted">Выберите логин — он будет в адресах ваших репозиториев: vlodhub.bln/<b>логин</b>/проект.</p>
      <form className="card stack" onSubmit={async (e) => { e.preventDefault(); try { await post('/hub/me', { login, name }); onDone(); } catch (ex) { toast(ex.message, 'err'); } }}>
        <Input label="Логин" value={login} onChange={(e) => setLogin(e.target.value.toLowerCase())} placeholder="boris" required hint="Латиница, цифры и дефис" />
        <Input label="Имя (необязательно)" value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit">Сохранить</Button>
      </form>
    </div>
  );
}

function RepoCards({ repos }) {
  if (!repos.length) return <Empty>Репозиториев нет.</Empty>;
  return (
    <div className="vh-files">
      {repos.map((r) => (
        <div key={`${r.owner}/${r.name}`} className="vh-row" style={{ flexDirection: 'column', alignItems: 'flex-start' }}>
          <div className="row"><a href={`#/${r.owner}/${r.name}`}><b>{r.owner}/{r.name}</b></a>{r.private && <Badge>приватный</Badge>}</div>
          {r.description && <span className="small muted">{r.description}</span>}
          <span className="small muted">{r.pushed_at ? `обновлён ${ago(r.pushed_at)}` : 'пустой'}</span>
        </div>
      ))}
    </div>
  );
}

function Dashboard({ user }) {
  const mine = useAsync(() => get(`/hub/repos?owner=${enc(user.login)}`), [user.login]);
  const all = useAsync(() => get('/hub/repos'), []);
  return (
    <div className="page">
      <div className="grid grid-2">
        <div className="stack">
          <div className="card-head"><h2>Мои репозитории</h2><a className="btn sm" href="#/new">+ Новый</a></div>
          {!mine.data ? <Spinner /> : <RepoCards repos={mine.data.repos} />}
        </div>
        <div className="stack">
          <h2>Недавно обновлённые в БалНете</h2>
          {!all.data ? <Spinner /> : <RepoCards repos={all.data.repos.filter((r) => !r.mine).slice(0, 10)} />}
          <div className="card small">
            <b>Как отправить код</b>
            <p>1. Создайте токен в <a href="#/settings/tokens">Токенах</a>. 2. В SSH хостинга: <span className="mono">git clone https://{user.login}:ТОКЕН@vlodhub.bln/{user.login}/проект.git</span>. 3. <span className="mono">git add . && git commit -m "…" && git push</span>.</p>
          </div>
        </div>
      </div>
    </div>
  );
}

function RepoList({ owner, title }) {
  const r = useAsync(() => get(`/hub/repos${owner ? `?owner=${enc(owner)}` : ''}`), [owner]);
  return <div className="page"><h1>{title}</h1>{!r.data ? <Spinner /> : <RepoCards repos={r.data.repos} />}</div>;
}

function NewRepo({ user }) {
  const [f, setF] = useState({ name: '', description: '', private: false, readme: true });
  const toast = useToast();
  return (
    <div className="page narrow">
      <h1>Новый репозиторий</h1>
      <form className="card stack" onSubmit={async (e) => { e.preventDefault(); try { const r = await post('/hub/repos', f); navigate(`/${r.owner}/${r.name}`); } catch (ex) { toast(ex.message, 'err'); } }}>
        <Input label={`Имя (vlodhub.bln/${user.login}/…)`} value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="my-site" required />
        <Input label="Описание" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
        <label className="row"><input type="checkbox" checked={f.private} onChange={(e) => setF({ ...f, private: e.target.checked })} /> Приватный — видят только вы и соавторы</label>
        <label className="row"><input type="checkbox" checked={f.readme} onChange={(e) => setF({ ...f, readme: e.target.checked })} /> Создать README.md</label>
        <Button type="submit">Создать</Button>
      </form>
    </div>
  );
}

function Tokens() {
  const t = useAsync(() => get('/hub/tokens'), []);
  const [name, setName] = useState('');
  const [made, setMade] = useState(null);
  return (
    <div className="page narrow stack">
      <h1>Токены доступа</h1>
      <p className="muted">Токен заменяет пароль в git: <span className="mono">https://логин:токен@vlodhub.bln/…</span>. Храните его как пароль.</p>
      <form className="card row" onSubmit={async (e) => { e.preventDefault(); setMade(await post('/hub/tokens', { name })); setName(''); t.reload(); }}>
        <input className="input" style={{ flex: 1, minWidth: 160 }} placeholder="Для чего (например, сервер хостинга)" value={name} onChange={(e) => setName(e.target.value)} />
        <Button type="submit">Создать токен</Button>
      </form>
      {made && <div className="form-ok stack-sm"><b>Скопируйте токен — больше он не покажется:</b><span className="mono" style={{ overflowWrap: 'anywhere' }}>{made.token}</span><span className="small mono">git clone https://{made.login}:{made.token}@vlodhub.bln/{made.login}/проект.git</span></div>}
      {!t.data ? <Spinner /> : !t.data.tokens.length ? <Empty>Токенов нет.</Empty> : (
        <div className="vh-files">
          {t.data.tokens.map((x) => (
            <div key={x.id} className="vh-row"><b style={{ flex: 1 }}>{x.name}</b><span className="mono small">{x.prefix}…</span><span className="small muted">{x.last_used ? `использован ${ago(x.last_used)}` : 'не использовался'}</span>
              <ActionButton size="sm" kind="ghost" confirm="Отозвать токен?" action={async () => { await del(`/hub/tokens/${x.id}`); t.reload(); }}>Отозвать</ActionButton>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

// ——— Репозиторий ———

function Repo({ p, tab, route, user }) {
  const base = `/hub/repos/${enc(p.owner)}/${enc(p.name)}`;
  const info = useAsync(() => get(base), [base]);
  if (!info.data) return <div className="page">{info.error ? <ErrorBox error={info.error} /> : <Spinner />}</div>;
  const d = info.data;
  const r = d.repo;
  const href = (s) => `#/${r.owner}/${r.name}${s}`;
  const T = [['code', 'Код', ''], ['commits', 'Коммиты', '/commits'], ['issues', `Задачи${d.open.issues ? ` ${d.open.issues}` : ''}`, '/issues'], ['pulls', `Запросы на слияние${d.open.prs ? ` ${d.open.prs}` : ''}`, '/pulls']];
  if (d.access.admin) T.push(['settings', 'Настройки', '/settings']);
  const cur = tab === 'commit' ? 'commits' : tab === 'newissue' || (tab === 'issue' && route.path.includes('/issues/')) ? 'issues' : tab === 'newpull' || (tab === 'issue' && route.path.includes('/pulls/')) ? 'pulls' : tab === 'edit' ? 'code' : tab;
  const ctx = { base, d, r, href, route, user, reload: info.reload };
  return (
    <div className="page">
      <h1 style={{ margin: 0 }}><a href={`#/${r.owner}`}>{r.owner}</a> / <a href={href('')}>{r.name}</a> {r.private && <Badge>приватный</Badge>}</h1>
      {r.description && <p className="muted" style={{ margin: '4px 0 0' }}>{r.description}</p>}
      <nav className="vh-tabs">{T.map(([k, l, s]) => <a key={k} href={href(s)} className={cur === k ? 'is-on' : ''}>{l}</a>)}</nav>
      {tab === 'code' && <Code ctx={ctx} />}
      {tab === 'edit' && <EditFile ctx={ctx} />}
      {tab === 'commits' && <Commits ctx={ctx} />}
      {tab === 'commit' && <Commit ctx={ctx} oid={p.oid} />}
      {(tab === 'issues' || tab === 'pulls') && <Issues ctx={ctx} kind={tab === 'pulls' ? 'pr' : 'issue'} />}
      {(tab === 'newissue' || tab === 'newpull') && <NewIssue ctx={ctx} kind={tab === 'newpull' ? 'pr' : 'issue'} />}
      {tab === 'issue' && <Issue ctx={ctx} num={p.num} />}
      {tab === 'settings' && <Settings ctx={ctx} />}
    </div>
  );
}

function CloneBox({ d }) {
  return (
    <div className="card small stack-sm">
      <b>Клонировать</b>
      <span>В БалНете (SSH хостинга): <span className="mono">git clone {d.clone.balnet}</span></span>
      <span>С компьютера: <span className="mono" style={{ overflowWrap: 'anywhere' }}>git clone {d.clone.internet}</span></span>
      <span className="muted">Для push нужен <a href="#/settings/tokens">токен</a>: логин — ваш логин ВлодХаба, пароль — токен.</span>
    </div>
  );
}

function Code({ ctx }) {
  const { base, d, r, href, route } = ctx;
  const ref = route.query.ref || r.default_branch;
  const fpath = route.query.path || '';
  const t = useAsync(() => (d.repo.empty ? Promise.resolve({ empty: true }) : get(`${base}/tree?ref=${enc(ref)}&path=${enc(fpath)}`)), [base, ref, fpath]);
  const readme = useAsync(() => (t.data?.type === 'tree' && t.data.entries.some((e) => /^readme(\.md)?$/i.test(e.name)) ? get(`${base}/tree?ref=${enc(ref)}&path=${enc(`${fpath ? `${fpath}/` : ''}${t.data.entries.find((e) => /^readme(\.md)?$/i.test(e.name)).name}`)}`) : Promise.resolve(null)), [t.data]);
  const go = (p, rf = ref) => navigate(`/${r.owner}/${r.name}?ref=${enc(rf)}&path=${enc(p)}`);
  if (d.repo.empty) {
    return (
      <div className="stack">
        <div className="card"><h3>Репозиторий пуст</h3><p>Отправьте в него код:</p><pre className="vh-code">{`git init\ngit add .\ngit commit -m "Первый коммит"\ngit remote add origin ${d.clone.balnet}\ngit push origin main`}</pre></div>
        <CloneBox d={d} />
      </div>
    );
  }
  const crumbs = fpath ? fpath.split('/') : [];
  return (
    <div className="stack">
      <div className="row">
        <select className="input" style={{ width: 'auto' }} value={ref} onChange={(e) => go('', e.target.value)} aria-label="Ветка">
          {d.branches.map((b) => <option key={b.name} value={b.name}>⎇ {b.name}</option>)}
        </select>
        <span className="small"><a href={href('')}>{r.name}</a>{crumbs.map((c, i) => <span key={i}> / <button className="link-btn" onClick={() => go(crumbs.slice(0, i + 1).join('/'))}>{c}</button></span>)}</span>
        <span style={{ flex: 1 }} />
        {d.access.write && <a className="btn sm secondary" href={`${href('/edit')}?ref=${enc(ref)}&path=${enc(t.data?.type === 'blob' ? fpath : `${fpath ? `${fpath}/` : ''}новый-файл.html`)}`}>{t.data?.type === 'blob' ? '✎ Изменить' : '+ Файл'}</a>}
      </div>
      {!t.data ? (t.error ? <ErrorBox error={t.error} /> : <Spinner />) : (
        <>
          {t.data.last && <div className="small muted"><a href={href(`/commit/${t.data.last.oid}`)}>{t.data.last.message.split('\n')[0]}</a> · {t.data.last.author} · {ago(t.data.last.at)} · <a href={`${href('/commits')}?ref=${enc(ref)}`}>коммиты</a></div>}
          {t.data.type === 'tree' ? (
            <div className="vh-files">
              {fpath && <div className="vh-row"><button className="link-btn" onClick={() => go(crumbs.slice(0, -1).join('/'))}>..</button></div>}
              {t.data.entries.map((e) => (
                <div key={e.name} className="vh-row">
                  <span aria-hidden>{e.type === 'tree' ? '📁' : '📄'}</span>
                  <button className="link-btn" onClick={() => go(`${fpath ? `${fpath}/` : ''}${e.name}`)}>{e.name}</button>
                </div>
              ))}
            </div>
          ) : t.data.binary ? <p className="muted">Двоичный файл, {t.data.size} байт.</p> : t.data.content === null ? <p className="muted">Файл слишком большой для просмотра.</p> : <pre className="vh-code">{t.data.content}</pre>}
          {readme.data?.content && <div className="card"><div className="small muted">README</div><pre style={{ whiteSpace: 'pre-wrap', margin: 0, fontFamily: 'inherit' }}>{readme.data.content}</pre></div>}
        </>
      )}
      <CloneBox d={d} />
    </div>
  );
}

function EditFile({ ctx }) {
  const { base, r, route, href } = ctx;
  const ref = route.query.ref || r.default_branch;
  const [fpath, setPath] = useState(route.query.path || '');
  const [content, setContent] = useState(null);
  const [msg, setMsg] = useState('');
  const toast = useToast();
  useEffect(() => {
    get(`${base}/tree?ref=${enc(ref)}&path=${enc(route.query.path || '')}`).then((t) => setContent(t.type === 'blob' ? t.content ?? '' : ''), () => setContent(''));
  }, [base, ref, route.query.path]);
  if (content === null) return <Spinner />;
  return (
    <form className="stack" onSubmit={async (e) => { e.preventDefault(); try { await put(`${base}/file`, { branch: ref, path: fpath, content, message: msg || `Обновить ${fpath}` }); toast('Коммит создан', 'ok'); navigate(`/${r.owner}/${r.name}?ref=${enc(ref)}&path=${enc(fpath)}`); } catch (ex) { toast(ex.message, 'err'); } }}>
      <div className="row"><span className="small">Ветка <b>{ref}</b>, файл:</span><input className="input mono" style={{ flex: 1, minWidth: 200 }} value={fpath} onChange={(e) => setPath(e.target.value)} aria-label="Путь файла" /></div>
      <textarea className="input mono" rows={22} value={content} onChange={(e) => setContent(e.target.value)} spellCheck={false} aria-label="Содержимое" />
      <Input label="Сообщение коммита" value={msg} onChange={(e) => setMsg(e.target.value)} placeholder={`Обновить ${fpath}`} />
      <div className="row"><Button type="submit">Закоммитить в {ref}</Button><a className="btn ghost" href={href('')}>Отмена</a></div>
    </form>
  );
}

function Commits({ ctx }) {
  const { base, r, route, href, d } = ctx;
  const ref = route.query.ref || r.default_branch;
  const c = useAsync(() => get(`${base}/commits?ref=${enc(ref)}`), [base, ref]);
  return (
    <div className="stack">
      <select className="input" style={{ width: 'auto' }} value={ref} onChange={(e) => navigate(`/${r.owner}/${r.name}/commits?ref=${enc(e.target.value)}`)} aria-label="Ветка">
        {d.branches.map((b) => <option key={b.name} value={b.name}>⎇ {b.name}</option>)}
      </select>
      {!c.data ? <Spinner /> : !c.data.commits.length ? <Empty>Коммитов нет.</Empty> : (
        <div className="vh-files">
          {c.data.commits.map((x) => (
            <div key={x.oid} className="vh-row">
              <div style={{ flex: 1, minWidth: 0 }}><a href={href(`/commit/${x.oid}`)}><b>{x.message.split('\n')[0]}</b></a><div className="small muted">{x.author} · {ago(x.at)}{x.parents.length > 1 ? ' · слияние' : ''}</div></div>
              <span className="mono small">{x.oid.slice(0, 7)}</span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function FileList({ files }) {
  return (
    <div className="vh-files">
      {files.map((f) => <div key={f.path} className="vh-row"><Badge kind={STATUS[f.status][0]}>{STATUS[f.status][1]}</Badge><span className="mono">{f.path}</span></div>)}
      {!files.length && <div className="vh-row muted">Изменений нет</div>}
    </div>
  );
}

function Commit({ ctx, oid }) {
  const c = useAsync(() => get(`${ctx.base}/commit/${oid}`), [oid]);
  if (!c.data) return c.error ? <ErrorBox error={c.error} /> : <Spinner />;
  return (
    <div className="stack">
      <div className="card"><h3 style={{ margin: 0 }}>{c.data.message}</h3><p className="small muted">{c.data.author} · {new Date(c.data.at).toLocaleString('ru-RU')} · <span className="mono">{c.data.oid}</span></p></div>
      <FileList files={c.data.files} />
    </div>
  );
}

function Issues({ ctx, kind }) {
  const { base, href } = ctx;
  const [state, setState] = useState('open');
  const l = useAsync(() => get(`${base}/issues?kind=${kind}&state=${state}`), [base, kind, state]);
  return (
    <div className="stack">
      <div className="row">
        <button className={`btn sm ${state === 'open' ? '' : 'ghost'}`} onClick={() => setState('open')}>Открытые</button>
        <button className={`btn sm ${state === 'closed' ? '' : 'ghost'}`} onClick={() => setState('closed')}>Закрытые</button>
        <span style={{ flex: 1 }} />
        {ctx.user && <a className="btn sm" href={href(kind === 'pr' ? '/pulls/new' : '/issues/new')}>{kind === 'pr' ? 'Новый запрос на слияние' : 'Новая задача'}</a>}
      </div>
      {!l.data ? <Spinner /> : !l.data.issues.length ? <Empty>{kind === 'pr' ? 'Запросов на слияние нет.' : 'Задач нет.'}</Empty> : (
        <div className="vh-files">
          {l.data.issues.map((i) => (
            <div key={i.number} className="vh-row">
              <span aria-hidden>{kind === 'pr' ? (i.state === 'merged' ? '🟣' : i.state === 'open' ? '🟢' : '🔴') : i.state === 'open' ? '🟢' : '✔'}</span>
              <div style={{ flex: 1 }}><a href={href(`/${kind === 'pr' ? 'pulls' : 'issues'}/${i.number}`)}><b>{i.title}</b></a><div className="small muted">#{i.number} · {i.author} · {ago(i.created_at)}{kind === 'pr' ? ` · ${i.head} → ${i.base}` : ''}</div></div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NewIssue({ ctx, kind }) {
  const { base, d, r } = ctx;
  const [f, setF] = useState({ title: '', body: '', head: d.branches.find((b) => b.name !== r.default_branch)?.name || '', base: r.default_branch });
  const toast = useToast();
  if (!ctx.user) return <Empty>Войдите, чтобы создавать задачи.</Empty>;
  return (
    <form className="card stack" onSubmit={async (e) => { e.preventDefault(); try { const x = await post(`${base}/issues`, { ...f, kind }); navigate(`/${r.owner}/${r.name}/${kind === 'pr' ? 'pulls' : 'issues'}/${x.number}`); } catch (ex) { toast(ex.message, 'err'); } }}>
      {kind === 'pr' && (
        <div className="grid grid-2">
          <Select label="Влить ветку" value={f.head} onChange={(e) => setF({ ...f, head: e.target.value })} options={d.branches.map((b) => ({ value: b.name, label: b.name }))} />
          <Select label="в ветку" value={f.base} onChange={(e) => setF({ ...f, base: e.target.value })} options={d.branches.map((b) => ({ value: b.name, label: b.name }))} />
        </div>
      )}
      <Input label="Заголовок" value={f.title} onChange={(e) => setF({ ...f, title: e.target.value })} required />
      <Field label="Описание"><textarea className="input" rows={6} value={f.body} onChange={(e) => setF({ ...f, body: e.target.value })} /></Field>
      <Button type="submit">{kind === 'pr' ? 'Создать запрос на слияние' : 'Создать задачу'}</Button>
    </form>
  );
}

function Issue({ ctx, num }) {
  const { base } = ctx;
  const v = useAsync(() => get(`${base}/issues/${num}`), [base, num]);
  const [text, setText] = useState('');
  const toast = useToast();
  if (!v.data) return v.error ? <ErrorBox error={v.error} /> : <Spinner />;
  const i = v.data.issue;
  const pr = v.data.pr;
  const stateCls = i.kind === 'issue' && i.state === 'closed' ? 'closed' : i.state;
  return (
    <div className="stack">
      <h2 style={{ margin: 0 }}>{i.title} <span className="muted">#{i.number}</span></h2>
      <div className="row"><span className={`vh-state ${stateCls}`}>{{ open: 'Открыт', closed: 'Закрыт', merged: 'Слит' }[i.state]}</span><span className="small muted">{i.author} · {ago(i.created_at)}{i.kind === 'pr' ? ` · ${i.head} → ${i.base}` : ''}</span></div>
      {i.body && <div className="vh-comment"><header><b>{i.author}</b></header><div>{i.body}</div></div>}
      {pr && !pr.error && (
        <div className="card stack-sm">
          <b>Коммиты ({pr.commits.length})</b>
          {pr.commits.map((c) => <span key={c.oid} className="small"><span className="mono">{c.oid.slice(0, 7)}</span> {c.message.split('\n')[0]} — {c.author}</span>)}
          <b>Файлы</b>
          <FileList files={pr.files} />
          {v.data.access.write && (
            <div className="row" style={{ marginTop: 8 }}>
              <ActionButton action={async () => { const r = await post(`${base}/issues/${num}/merge`); toast(r.fast_forward ? 'Слито (fast-forward)' : 'Создан коммит слияния', 'ok'); v.reload(); ctx.reload(); }} disabled={pr.up_to_date}>Слить запрос</ActionButton>
              <span className="small muted">{pr.up_to_date ? 'Нечего сливать: ветки одинаковы.' : pr.fast_forward ? 'Слияние перемоткой (fast-forward).' : 'Будет создан коммит слияния.'}</span>
            </div>
          )}
        </div>
      )}
      {v.data.comments.map((c) => <div key={c.id} className="vh-comment"><header><b>{c.author}</b> · {ago(c.at)}</header><div>{c.body}</div></div>)}
      {ctx.user && (
        <form className="stack-sm" onSubmit={async (e) => { e.preventDefault(); try { await post(`${base}/issues/${num}/comments`, { body: text }); setText(''); v.reload(); } catch (ex) { toast(ex.message, 'err'); } }}>
          <textarea className="input" rows={4} value={text} onChange={(e) => setText(e.target.value)} placeholder="Комментарий" aria-label="Комментарий" />
          <div className="row">
            <Button type="submit" disabled={!text.trim()}>Комментировать</Button>
            {i.state !== 'merged' && <ActionButton kind="secondary" action={async () => { await patch(`${base}/issues/${num}`, { state: i.state === 'open' ? 'closed' : 'open' }); v.reload(); ctx.reload(); }}>{i.state === 'open' ? 'Закрыть' : 'Открыть снова'}</ActionButton>}
          </div>
        </form>
      )}
    </div>
  );
}

function Settings({ ctx }) {
  const { base, d, r, reload } = ctx;
  const targets = useAsync(() => get('/hub/deploy-targets'), []);
  const [desc, setDesc] = useState(r.description || '');
  const [collab, setCollab] = useState('');
  const toast = useToast();
  const save = async (body) => { try { await patch(base, body); toast('Сохранено', 'ok'); reload(); } catch (e) { toast(e.message, 'err'); } };
  return (
    <div className="stack">
      <div className="card stack-sm">
        <h3>Деплой на хостинг</h3>
        <p className="small muted">Каждый push (и слияние) в выбранную ветку выкладывает файлы репозитория на сайт БалХоста. Файлы, удалённые из репозитория, удаляются с сайта; база .data не трогается.</p>
        {!targets.data ? <Spinner /> : (
          <div className="grid grid-2">
            <Select label="Сайт" value={String(d.repo.deploy?.site_id || '')} onChange={(e) => save({ deploy_site_id: e.target.value ? Number(e.target.value) : null })} options={[{ value: '', label: 'не выкладывать' }, ...targets.data.sites.map((s) => ({ value: String(s.id), label: s.host }))]} />
            <Select label="Ветка" value={d.repo.deploy?.branch || r.default_branch} onChange={(e) => save({ deploy_branch: e.target.value })} options={d.branches.map((b) => ({ value: b.name, label: b.name }))} />
          </div>
        )}
        {d.repo.deploy && <div><ActionButton size="sm" kind="secondary" okMessage="Выложено" action={async () => { await post(`${base}/deploy`); reload(); }}>Выложить сейчас</ActionButton></div>}
        {!!d.deploys.length && (
          <div className="vh-files">
            {d.deploys.map((x) => <div key={x.id} className="vh-row"><Badge kind={x.status === 'ok' ? 'ok' : 'err'}>{x.status === 'ok' ? 'выложено' : 'ошибка'}</Badge><span className="mono small">{x.commit.slice(0, 7)}</span><span className="small">{x.host}: {x.message}</span><span className="small muted">{ago(x.at)}</span></div>)}
          </div>
        )}
      </div>
      <div className="card stack-sm">
        <h3>Основное</h3>
        <Input label="Описание" value={desc} onChange={(e) => setDesc(e.target.value)} />
        <div className="row"><Button size="sm" onClick={() => save({ description: desc })}>Сохранить</Button></div>
        <label className="row"><input type="checkbox" checked={r.private} onChange={(e) => save({ private: e.target.checked })} /> Приватный репозиторий</label>
        <Select label="Основная ветка" value={r.default_branch} onChange={(e) => save({ default_branch: e.target.value })} options={d.branches.map((b) => ({ value: b.name, label: b.name }))} />
      </div>
      <div className="card stack-sm">
        <h3>Соавторы</h3>
        <p className="small muted">Соавторы могут отправлять push, создавать ветки и сливать запросы.</p>
        {d.collaborators.map((c) => <div key={c} className="row"><span>@{c}</span><ActionButton size="sm" kind="ghost" action={async () => { await del(`${base}/collaborators/${enc(c)}`); reload(); }}>Убрать</ActionButton></div>)}
        <form className="row" onSubmit={async (e) => { e.preventDefault(); try { await post(`${base}/collaborators`, { login: collab }); setCollab(''); reload(); } catch (ex) { toast(ex.message, 'err'); } }}>
          <input className="input" placeholder="логин" value={collab} onChange={(e) => setCollab(e.target.value)} aria-label="Логин соавтора" />
          <Button type="submit" size="sm">Добавить</Button>
        </form>
      </div>
      <div className="card"><ActionButton kind="danger" confirm={`Удалить ${r.owner}/${r.name} навсегда вместе с задачами?`} action={async () => { await del(base); navigate('/'); }}>Удалить репозиторий</ActionButton></div>
    </div>
  );
}
