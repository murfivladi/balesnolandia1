// Пример серверного кода для виртуального тарифа: гостевая книга на SQLite, счётчик в key-value, cron.
export const EXAMPLE = {
  'server.js': `// Гостевая книга: серверный JavaScript БалНета (QuickJS).
// db — SQLite сайта, kv — ключ-значение, fetch — запросы к другим сайтам, console.log — журнал в панели БалХоста.
db.exec('CREATE TABLE IF NOT EXISTS posts (id INTEGER PRIMARY KEY, name TEXT, text TEXT, at INTEGER)');

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

export async function onRequest(req) {
  if (req.method === 'POST' && req.path === '/sign') {
    const form = await req.form();
    const name = (form.get('name') || 'Аноним').slice(0, 40);
    const text = (form.get('text') || '').slice(0, 500);
    if (text) db.run('INSERT INTO posts (name, text, at) VALUES (?, ?, ?)', [name, text, gameTime()]);
    return Response.redirect('/');
  }
  if (req.path === '/api/posts') {
    return Response.json(db.query('SELECT name, text, at FROM posts ORDER BY id DESC LIMIT 50'));
  }
  if (req.path !== '/') return new Response('Не найдено', { status: 404 });
  const visits = (kv.get('visits') || 0) + 1;
  kv.set('visits', visits);
  const posts = db.query('SELECT name, text FROM posts ORDER BY id DESC LIMIT 20');
  return Response.html(\`<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Гостевая книга</title></head>
<body style="font-family:system-ui;max-width:640px;margin:24px auto;padding:0 16px">
<h1>Гостевая книга</h1><p>Посещений: \${visits}</p>
<form method="post" action="/sign"><input name="name" placeholder="Имя"> <input name="text" placeholder="Сообщение" required> <button>Написать</button></form>
<ul>\${posts.map((p) => \`<li><b>\${esc(p.name)}:</b> \${esc(p.text)}</li>\`).join('')}</ul>
</body></html>\`);
}

// Вызывается по расписанию из файла crontab (игровое время).
export function onCron(job) {
  const old = db.run('DELETE FROM posts WHERE at < ?', [job.time - 30 * 86400]);
  console.log('Уборка: удалено записей старше месяца —', old.changes);
}
`,
  crontab: `# минута час день месяц день_недели задача  (игровое время)
0 4 * * * уборка
`,
};
