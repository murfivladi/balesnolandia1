import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR } from '../config.js';

// Файл VERSION кладёт деплой рядом с server.mjs (коммит сборки).
const FILE = path.join(APP_DIR, 'VERSION');

function read() {
  try { return fs.readFileSync(FILE, 'utf8').trim() || 'dev'; } catch { return 'dev'; }
}

export const VERSION = read();

/** Когда по FTP приходит новая версия — завершаем процесс; служба панели хостинга запускает свежий код. */
export function watchForNewVersion(onChange) {
  fs.watchFile(FILE, { interval: 5000 }, () => {
    const now = read();
    if (now !== VERSION && now !== 'dev') onChange(now);
  });
}
