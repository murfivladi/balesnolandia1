// Табло очереди для покупателей: крупные номера заказов «готовится» и «готово».
// Работает и на кассе (по WebSocket), и на отдельном экране без входа (?shop=ID).
import { useEffect, useState } from 'react';
import { get } from '../shared/api.js';
import { t, locale } from '../shared/i18n.js';
import { Spinner, useChannel } from '../shared/ui.jsx';
import { PosLogo } from '../shared/brand.jsx';

export function QueueBoard({ session, shopId }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [now, setNow] = useState(new Date());
  const id = shopId || session?.shop?.id || null;

  useEffect(() => {
    const h = setInterval(() => setNow(new Date()), 1000);
    return () => clearInterval(h);
  }, []);

  useEffect(() => {
    if (!id) return undefined;
    let alive = true;
    async function load() {
      try {
        const r = session ? await get('/pos/queue') : await get(`/pos/public/queue/${id}`);
        if (alive) { setData(r); setError(null); }
      } catch (e) { if (alive) setError(e); }
    }
    load();
    const h = setInterval(load, session ? 30000 : 4000);
    return () => { alive = false; clearInterval(h); };
  }, [id, session]);

  useChannel(session ? `shop:${session.shop.id}` : null, (m) => {
    if (!['kitchen', 'sale_paid', 'tables'].includes(m.type)) return;
    get('/pos/queue').then(setData).catch(() => {});
  });

  if (!id) return <div className="page"><ErrorState text={t('Не указан магазин. Откройте ссылку с экрана кассы: Управление → Магазин → Табло очереди.')} /></div>;
  if (!data) return <div className="page">{error ? <ErrorState text={t('Нет связи с сервером')} /> : <Spinner />}</div>;

  const active = (data.cooking || []).filter((n) => !(data.ready || []).includes(n));
  const ready = data.ready || [];
  return (
    <>
      <div className="queue-board">
        <div className="qb-head">
          <PosLogo src={data.shop.logo} color={data.shop.color} size={44} />
          <div>
            <h1>{data.shop.name}</h1>
            <div className="small muted">{t('Номер заказа — в вашем чеке')}</div>
          </div>
          <div className="qb-clock">{now.toLocaleTimeString(locale(), { hour: '2-digit', minute: '2-digit' })}</div>
        </div>
        <div className="queue-sections">
          <div className="queue-section cooking">
            <h2>{t('Готовится')}</h2>
            <div className="queue-numbers">
              {!active.length ? <span className="queue-empty">{t('Сейчас ничего не готовится')}</span> : active.map((n) => <span key={n} className="queue-no">{n}</span>)}
            </div>
          </div>
          <div className="queue-section ready">
            <h2>{t('Готово — заберите заказ')}</h2>
            <div className="queue-numbers">
              {!ready.length ? <span className="queue-empty">{t('Готовых заказов нет')}</span> : ready.map((n) => <span key={n} className="queue-no">{n}</span>)}
            </div>
          </div>
        </div>
        {error && <div className="form-warn">{t('Связь с сервером потеряна, показаны последние данные')}</div>}
      </div>
    </>
  );
}

function ErrorState({ text }) {
  return <div className="card"><div className="form-error">{text}</div></div>;
}
