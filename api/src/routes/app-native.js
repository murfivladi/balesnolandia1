// Нативные приложения (ВлодБраузер для iOS): последняя версия для баннера обновления и отчёты о сбоях.
import { q } from '../db.js';
import { webUrl } from '../lib/settings.js';
import { bad } from '../lib/errors.js';
import { IOS_APP } from '@bln/shared/app-versions.js';

const clip = (v, n) => (v === undefined || v === null ? null : String(v).slice(0, n));

export async function appRoutes(app) {
  app.get('/ios', async () => ({ ...IOS_APP, url: `${await webUrl()}/ios/` }));

  // Отчёт о сбое приходит при следующем запуске приложения. Без входа, с ограничением частоты.
  app.post('/crash', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (req) => {
    const b = req.body || {};
    const platform = String(b.platform || '');
    if (!['ios'].includes(platform)) throw bad('invalid', 'platform: ios');
    if (!b.version || !b.kind || !b.message) throw bad('invalid', 'Нужны version, kind и message');
    const at = Number.isFinite(Number(b.at)) && Number(b.at) > 0 ? new Date(Number(b.at)) : null;
    await q(
      'INSERT INTO app_crash_reports (platform, version, build, device, os, kind, message, stack, happened_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [platform, clip(b.version, 20), Number.parseInt(b.build, 10) || 0, clip(b.device, 80), clip(b.os, 40), clip(b.kind, 40), clip(b.message, 1000), clip(b.stack, 20000), at],
    );
    await q('DELETE FROM app_crash_reports WHERE created_at < NOW() - INTERVAL 90 DAY');
    return { ok: true };
  });
}
