// Журнал серверного кода сайта (console.log, ошибки, cron): последние записи в памяти сервера, как `tail` у хостера.
const MAX = 300;
const logs = new Map();

export function addLog(siteId, level, text) {
  if (!logs.has(siteId)) logs.set(siteId, []);
  const l = logs.get(siteId);
  l.push({ t: new Date().toISOString(), level, text: String(text).slice(0, 4000) });
  if (l.length > MAX) l.splice(0, l.length - MAX);
}

export const getLogs = (siteId) => logs.get(siteId) || [];
export const clearLogs = (siteId) => logs.delete(siteId);
