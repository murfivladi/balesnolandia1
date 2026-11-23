// Git-сервер ВлодХаба: протокол smart HTTP (версия 0/1), как у настоящих git-хостингов.
// Голые репозитории на диске, объекты и пакеты — через isomorphic-git. Работает с настоящим `git clone`/`git push`
// и с git внутри БалНета (SSH-оболочка хостинга).
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import git from 'isomorphic-git';

export const ZERO = '0'.repeat(40);

// ——— pkt-line ———

export function pkt(line) {
  const buf = Buffer.isBuffer(line) ? line : Buffer.from(line, 'utf8');
  return Buffer.concat([Buffer.from((buf.length + 4).toString(16).padStart(4, '0')), buf]);
}
export const FLUSH = Buffer.from('0000');

/** Разобрать pkt-line до flush: { lines: [Buffer], rest: Buffer }. */
export function readPkts(buf) {
  const lines = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString(), 16);
    if (Number.isNaN(len)) throw new Error('bad pkt-line');
    if (len === 0) { i += 4; return { lines, rest: buf.subarray(i), flush: true }; }
    if (len < 4) { i += 4; continue; }
    lines.push(buf.subarray(i + 4, i + len));
    i += len;
  }
  return { lines, rest: buf.subarray(i), flush: false };
}

/** Данные в канал side-band-64k (1 — пакет, 2 — прогресс). */
function sideband(band, data) {
  const out = [];
  for (let i = 0; i < data.length; i += 65515) out.push(pkt(Buffer.concat([Buffer.from([band]), data.subarray(i, i + 65515)])));
  return Buffer.concat(out);
}

// ——— Репозиторий ———

export async function initBare(gitdir, defaultBranch = 'main') {
  await fsp.mkdir(gitdir, { recursive: true });
  await git.init({ fs, dir: gitdir, gitdir, bare: true, defaultBranch });
}

export async function refsOf(gitdir) {
  const out = [];
  for (const kind of ['heads', 'tags']) {
    for (const name of await git.listRefs({ fs, gitdir, filepath: `refs/${kind}` }).catch(() => [])) {
      out.push({ ref: `refs/${kind}/${name}`, oid: await git.resolveRef({ fs, gitdir, ref: `refs/${kind}/${name}` }) });
    }
  }
  return out;
}

async function headTarget(gitdir) {
  try { return (await git.resolveRef({ fs, gitdir, ref: 'HEAD', depth: 1 })).replace(/^ref: /, ''); } catch { return null; }
}

/** GET info/refs?service=… — объявление ссылок. */
export async function advertise(gitdir, service) {
  const refs = await refsOf(gitdir);
  const head = await headTarget(gitdir);
  const headOid = refs.find((r) => r.ref === head)?.oid;
  const caps = service === 'git-upload-pack'
    ? ['multi_ack_detailed', 'side-band-64k', 'thin-pack', 'ofs-delta', 'no-progress', 'shallow', `symref=HEAD:${head || 'refs/heads/main'}`, 'agent=vlodhub/1.0']
    : ['report-status', 'delete-refs', 'side-band-64k', 'ofs-delta', 'agent=vlodhub/1.0'];
  const lines = [pkt(`# service=${service}\n`), FLUSH];
  const list = [];
  if (service === 'git-upload-pack' && headOid) list.push({ ref: 'HEAD', oid: headOid });
  list.push(...refs);
  if (!list.length) lines.push(pkt(`${ZERO} capabilities^{}\0${caps.join(' ')}\n`));
  list.forEach((r, i) => lines.push(pkt(`${r.oid} ${r.ref}${i === 0 ? `\0${caps.join(' ')}` : ''}\n`)));
  lines.push(FLUSH);
  return Buffer.concat(lines);
}

/** Все объекты, достижимые из коммитов (коммиты, деревья, блобы). */
async function reachable(gitdir, tips, stop = new Set()) {
  const seen = new Set();
  const stack = [...tips];
  const walkTree = async (oid) => {
    if (seen.has(oid) || stop.has(oid)) return;
    seen.add(oid);
    const { tree } = await git.readTree({ fs, gitdir, oid });
    for (const e of tree) {
      if (e.type === 'tree') await walkTree(e.oid);
      else if (e.type === 'blob' && !stop.has(e.oid)) seen.add(e.oid);
    }
  };
  while (stack.length) {
    const oid = stack.pop();
    if (seen.has(oid) || stop.has(oid)) continue;
    let c;
    try { c = await git.readCommit({ fs, gitdir, oid }); } catch { continue; }
    seen.add(oid);
    await walkTree(c.commit.tree);
    stack.push(...c.commit.parent);
  }
  return seen;
}

/** POST git-upload-pack: клиент присылает want/have — отдаём пакет с недостающими объектами. */
export async function uploadPack(gitdir, body) {
  const wants = [];
  const haves = [];
  let caps = new Set();
  let buf = body;
  for (;;) {
    const r = readPkts(buf);
    for (const l of r.lines) {
      const s = l.toString('utf8').replace(/\n$/, '');
      const [cmd, oid, ...rest] = s.split(' ');
      if (cmd === 'want') {
        wants.push(oid.slice(0, 40));
        if (!caps.size) caps = new Set([...(oid.slice(40) ? [oid.slice(40)] : []), ...rest].join(' ').trim().split(/\s+/));
      } else if (cmd === 'have') haves.push(oid);
    }
    buf = r.rest;
    if (!r.flush || !buf.length) break;
  }
  if (!wants.length) return FLUSH;
  const have = new Set();
  const common = [];
  for (const h of haves) {
    try { await git.readObject({ fs, gitdir, oid: h }); common.push(h); } catch { /* у нас такого нет */ }
  }
  if (common.length) for (const o of await reachable(gitdir, common)) have.add(o);
  const oids = [...(await reachable(gitdir, wants, have))];
  const { packfile } = await git.packObjects({ fs, gitdir, oids, write: false });
  const pack = Buffer.from(packfile);
  const parts = [];
  if (common.length && caps.has('multi_ack_detailed')) {
    for (const c of common) parts.push(pkt(`ACK ${c} common\n`));
    parts.push(pkt(`ACK ${common[common.length - 1]}\n`));
  } else parts.push(pkt('NAK\n'));
  if (caps.has('side-band-64k') || caps.has('side-band')) parts.push(sideband(1, pack), FLUSH);
  else parts.push(pack);
  return Buffer.concat(parts);
}

/**
 * POST git-receive-pack: команды обновления ссылок и пакет. Возвращает { response, updates }.
 * check(update) может отклонить обновление (права, защита ветки) — вернуть строку с причиной.
 */
export async function receivePack(gitdir, body, { check = async () => null } = {}) {
  const r = readPkts(body);
  const caps = new Set((r.lines[0]?.toString('utf8').split('\0')[1] || '').trim().split(/\s+/));
  const cmds = r.lines.map((l) => {
    const s = l.toString('utf8').replace(/\n$/, '').split('\0')[0];
    const [oldOid, newOid, ref] = s.split(' ');
    return { oldOid, newOid, ref };
  });
  const pack = r.rest;
  let unpack = 'ok';
  if (pack.length > 32 && pack.subarray(0, 4).toString() === 'PACK') {
    const name = crypto.createHash('sha1').update(pack).digest('hex');
    const rel = `objects/pack/pack-${name}.pack`;
    await fsp.mkdir(path.join(gitdir, 'objects/pack'), { recursive: true });
    await fsp.writeFile(path.join(gitdir, rel), pack);
    try {
      await git.indexPack({ fs, dir: gitdir, gitdir, filepath: rel });
    } catch (e) {
      unpack = `index-pack failed: ${e.message}`;
      await fsp.rm(path.join(gitdir, rel), { force: true });
    }
  }
  const out = [pkt(`unpack ${unpack}\n`)];
  const updates = [];
  for (const c of cmds) {
    if (unpack !== 'ok') { out.push(pkt(`ng ${c.ref} unpacker error\n`)); continue; }
    if (!/^refs\/(heads|tags)\/[\w./-]+$/.test(c.ref) || c.ref.includes('..')) { out.push(pkt(`ng ${c.ref} invalid ref name\n`)); continue; }
    let cur = ZERO;
    try { cur = await git.resolveRef({ fs, gitdir, ref: c.ref }); } catch { /* новой ветки ещё нет */ }
    if (cur !== c.oldOid) { out.push(pkt(`ng ${c.ref} fetch first\n`)); continue; }
    const deny = await check(c);
    if (deny) { out.push(pkt(`ng ${c.ref} ${deny}\n`)); continue; }
    if (c.newOid === ZERO) await git.deleteRef({ fs, gitdir, ref: c.ref });
    else {
      try { await git.readCommit({ fs, gitdir, oid: c.newOid }); } catch { out.push(pkt(`ng ${c.ref} missing objects\n`)); continue; }
      await git.writeRef({ fs, gitdir, ref: c.ref, value: c.newOid, force: true });
    }
    // Первая ветка в пустом репозитории становится основной.
    updates.push(c);
    out.push(pkt(`ok ${c.ref}\n`));
  }
  out.push(FLUSH);
  const report = Buffer.concat(out);
  // Клиент попросил side-band-64k: отчёт идёт в канале 1, затем flush.
  return { response: caps.has('side-band-64k') ? Buffer.concat([sideband(1, report), FLUSH]) : report, updates };
}

// ——— Чтение для веб-интерфейса ———

export async function resolveCommit(gitdir, ref) {
  const r = String(ref || 'HEAD');
  if (/^[0-9a-f]{40}$/.test(r)) return r;
  return git.resolveRef({ fs, gitdir, ref: r.startsWith('refs/') || r === 'HEAD' ? r : `refs/heads/${r}` });
}

/** Содержимое пути в коммите: { type: 'tree', entries } | { type: 'blob', content, size, binary } */
export async function readPath(gitdir, oid, filepath = '') {
  const parts = String(filepath).split('/').filter(Boolean);
  const c = await git.readCommit({ fs, gitdir, oid });
  let cur = { type: 'tree', oid: c.commit.tree };
  for (const p of parts) {
    if (cur.type !== 'tree') return null;
    const { tree } = await git.readTree({ fs, gitdir, oid: cur.oid });
    const e = tree.find((x) => x.path === p);
    if (!e) return null;
    cur = { type: e.type, oid: e.oid };
  }
  if (cur.type === 'tree') {
    const { tree } = await git.readTree({ fs, gitdir, oid: cur.oid });
    return { type: 'tree', entries: tree.map((e) => ({ name: e.path, type: e.type, oid: e.oid })).sort((a, b) => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === 'tree' ? -1 : 1)) };
  }
  const { blob } = await git.readBlob({ fs, gitdir, oid: cur.oid });
  const buf = Buffer.from(blob);
  const binary = buf.subarray(0, 8000).includes(0);
  return { type: 'blob', oid: cur.oid, size: buf.length, binary, content: binary ? null : buf.toString('utf8'), buf };
}

/** Все файлы коммита: [{ path, oid, mode }]. */
export async function listFiles(gitdir, oid) {
  const out = [];
  const c = await git.readCommit({ fs, gitdir, oid });
  const walk = async (treeOid, base) => {
    const { tree } = await git.readTree({ fs, gitdir, oid: treeOid });
    for (const e of tree) {
      const p = base ? `${base}/${e.path}` : e.path;
      if (e.type === 'tree') await walk(e.oid, p);
      else if (e.type === 'blob') out.push({ path: p, oid: e.oid, mode: e.mode });
    }
  };
  await walk(c.commit.tree, '');
  return out;
}

export async function commits(gitdir, ref, depth = 50) {
  const oid = await resolveCommit(gitdir, ref);
  return (await git.log({ fs, gitdir, ref: oid, depth })).map((l) => ({
    oid: l.oid, message: l.commit.message, author: l.commit.author.name, email: l.commit.author.email, at: l.commit.author.timestamp * 1000, parents: l.commit.parent,
  }));
}

/** Изменённые файлы между двумя коммитами: [{ path, status: added|modified|deleted }]. */
export async function diffFiles(gitdir, fromOid, toOid) {
  const a = new Map((fromOid ? await listFiles(gitdir, fromOid) : []).map((f) => [f.path, f.oid]));
  const b = new Map((await listFiles(gitdir, toOid)).map((f) => [f.path, f.oid]));
  const out = [];
  for (const [p, o] of b) if (!a.has(p)) out.push({ path: p, status: 'added' }); else if (a.get(p) !== o) out.push({ path: p, status: 'modified' });
  for (const p of a.keys()) if (!b.has(p)) out.push({ path: p, status: 'deleted' });
  return out.sort((x, y) => x.path.localeCompare(y.path));
}

export async function mergeBase(gitdir, a, b) {
  const [base] = await git.findMergeBase({ fs, gitdir, oids: [a, b] });
  return base || null;
}

/** Слить ветку head в base (как кнопка Merge в PR): fast-forward или коммит слияния. */
export async function mergeBranches(gitdir, { base, head, author, message }) {
  const r = await git.merge({ fs, gitdir, ours: `refs/heads/${base}`, theirs: `refs/heads/${head}`, author, message, fastForward: true, abortOnConflict: true });
  return r;
}

/** Коммит из веб-редактора: заменить/добавить один файл в ветке. */
export async function commitFile(gitdir, { branch, filepath, content, message, author }) {
  const ref = `refs/heads/${branch}`;
  let parent = null;
  try { parent = await git.resolveRef({ fs, gitdir, ref }); } catch { /* пустой репозиторий */ }
  const blob = await git.writeBlob({ fs, gitdir, blob: Buffer.from(String(content), 'utf8') });
  const parts = filepath.split('/').filter(Boolean);
  const write = async (treeOid, depth) => {
    const entries = treeOid ? (await git.readTree({ fs, gitdir, oid: treeOid })).tree : [];
    const name = parts[depth];
    const rest = entries.filter((e) => e.path !== name);
    if (depth === parts.length - 1) rest.push({ mode: '100644', path: name, oid: blob, type: 'blob' });
    else {
      const sub = entries.find((e) => e.path === name && e.type === 'tree');
      rest.push({ mode: '040000', path: name, oid: await write(sub?.oid || null, depth + 1), type: 'tree' });
    }
    return git.writeTree({ fs, gitdir, tree: rest });
  };
  const baseTree = parent ? (await git.readCommit({ fs, gitdir, oid: parent })).commit.tree : null;
  const tree = await write(baseTree, 0);
  const now = Math.floor(Date.now() / 1000);
  const sig = { ...author, timestamp: now, timezoneOffset: 0 };
  const oid = await git.writeCommit({ fs, gitdir, commit: { message: message.endsWith('\n') ? message : `${message}\n`, tree, parent: parent ? [parent] : [], author: sig, committer: sig } });
  await git.writeRef({ fs, gitdir, ref, value: oid, force: true });
  return oid;
}
