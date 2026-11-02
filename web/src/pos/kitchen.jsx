// Экран кухни и сборки: «новый → готовится → готов → выдан». Обновляется по WebSocket,
// новый заказ подаёт звуковой сигнал. Ставится на отдельный планшет или монитор.
import { useEffect, useRef, useState } from 'react';
import { get, post } from '../shared/api.js';
import { t } from '../shared/i18n.js';
import { Spinner, useAsync, useChannel, Empty, Button, ActionButton, Badge, useToast } from '../shared/ui.jsx';
import { sound } from '../shared/sounds.js';
import { qtyLabel } from './lib.js';

const COLUMNS = [
  { status: 'new', title: 'Новые', next: ['cooking', 'Начать готовить'] },
  { status: 'cooking', title: 'Готовится', next: ['ready', 'Готово'] },
  { status: 'ready', title: 'Готово к выдаче', next: ['done', 'Выдан'] },
];

function elapsed(from, now) {
  const s = Math.max(0, Math.floor((now - new Date(from).getTime()) / 1000));
  return `${String(Math.floor(s / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function Kitchen({ session }) {
  const { data, loading, reload } = useAsync(() => get('/pos/kitchen'), []);
  const [now, setNow] = useState(Date.now());
  const known = useRef(null);
  const toast = useToast();

  useEffect(() => {
    const h = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(h);
  }, []);

  useChannel(`shop:${session.shop.id}`, (m) => {
    if (m.type === 'kitchen') {
      if (m.status === 'new') sound.beep();
      reload();
    }
    if (m.type === 'sale_paid' || m.type === 'tables' || m.type === 'refund') reload();
  });

  // Звук на любой новый заказ, даже если WebSocket-событие пришло с задержкой.
  useEffect(() => {
    if (!data) return;
    const ids = new Set(data.orders.filter((o) => ['new', 'cooking', 'ready'].includes(o.status)).map((o) => o.id));
    if (known.current) {
      for (const id of ids) if (!known.current.has(id)) { sound.approve(); break; }
    }
    known.current = ids;
  }, [data]);

  async function move(order, status) {
    await post(`/pos/kitchen/${order.id}/status`, { status });
    reload();
  }

  async function fullscreen() {
    try {
      if (document.fullscreenElement) await document.exitFullscreen();
      else await document.documentElement.requestFullscreen();
    } catch { toast(t('Браузер не разрешил полноэкранный режим'), 'err'); }
  }

  if (loading && !data) return <div className="page"><Spinner /></div>;
  const orders = data.orders.filter((o) => ['new', 'cooking', 'ready'].includes(o.status));
  return (
    <div className="page fullbleed">
      <div className="page-head">
        <h1>{t('Кухня')}</h1>
        <Badge kind="brand">{t('заказов')}: {orders.length}</Badge>
        <div className="row" style={{ marginLeft: 'auto' }}>
          <a className="btn secondary sm" href={`#/queue?shop=${session.shop.id}`}>{t('Табло очереди')}</a>
          <a className="btn secondary sm" href="#/tables">{t('Столы')}</a>
          <Button kind="secondary" size="sm" onClick={fullscreen}>⛶ {t('Во весь экран')}</Button>
        </div>
      </div>
      {!orders.length ? <Empty>{t('Новых заказов нет')}</Empty> : (
        <div className="kds">
          {COLUMNS.map((col) => {
            const list = data.orders.filter((o) => o.status === col.status);
            return (
              <div key={col.status} className={`kds-col ${col.status}`}>
                <h3>{t(col.title)} <span className="count">{list.length}</span></h3>
                {!list.length && <p className="muted small" style={{ padding: '0 6px' }}>{t('Пусто')}</p>}
                {list.map((o) => {
                  const late = Date.now() - new Date(o.created_at).getTime() > 15 * 60000;
                  return (
                    <div key={o.id} className={`kds-card${late ? ' overdue' : ''}`}>
                      <div className="kc-head">
                        <span className="kc-no">№{o.queue_no}</span>
                        <span className="kc-label">{o.label || (o.sale_number ? `${t('Чек')} №${o.sale_number}` : '')}</span>
                        <span className="kc-time" title={t('Время с заказа')}>{elapsed(o.created_at, now)}</span>
                      </div>
                      <ul>
                        {o.items.map((i, k) => <li key={k}>{i.name} — <b>{qtyLabel(i.unit, i.qty_milli)}</b></li>)}
                      </ul>
                      <div className="kc-actions">
                        <ActionButton
                          size="sm"
                          kind={col.status === 'ready' ? 'ok-btn' : ''}
                          action={async () => { await move(o, col.next[0]); sound.click(); }}
                        >{t(col.next[1])}</ActionButton>
                        {col.status !== 'ready' && (
                          <ActionButton
                            size="sm"
                            kind="ghost"
                            confirm={t('Отменить заказ №{n}?', { n: o.queue_no })}
                            action={async () => { await move(o, 'cancelled'); }}
                          >{t('Отменить')}</ActionButton>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
