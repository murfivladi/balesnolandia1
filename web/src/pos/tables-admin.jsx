// Настройка столов кафе: название, число мест, включение. Здесь же ссылка на табло
// очереди и QR для экрана в зале.
import { useState } from 'react';
import { get, post, patch } from '../shared/api.js';
import { t } from '../shared/i18n.js';
import { Spinner, useAsync, Input, Form, Modal, Empty, Button, Badge, QR, Money } from '../shared/ui.jsx';
import { appUrl } from '../shared/api.js';
import { sound } from '../shared/sounds.js';

export function TablesAdmin({ session }) {
  const { data, loading, reload } = useAsync(() => get('/pos/tables?all=1'), []);
  const [edit, setEdit] = useState(null);
  if (loading && !data) return <Spinner />;
  const queueUrl = appUrl('pos', `/queue?shop=${session.shop.id}`);
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Столы')}</h1>
        <Button onClick={() => setEdit({ name: '', seats: 4, active: true })}>+ {t('Стол')}</Button>
      </div>
      <div className="grid grid-2">
        <div className="card">
          <div className="card-head"><h2>{t('Карта зала')}</h2><Badge>{data.tables.filter((x) => x.active).length}</Badge></div>
          {!data.tables.length ? <Empty>{t('Столов пока нет')}</Empty> : (
            <div className="list">
              {data.tables.map((x) => (
                <div key={x.id} className="list-item">
                  <div className="li-main">
                    <div className="li-title">{x.name} {!x.active && <Badge kind="err">{t('выключен')}</Badge>}</div>
                    <div className="li-sub">{x.seats} {t('мест')}{x.tab ? ` · ${t('открыт счёт')}: ${x.tab.items_count}` : ''}</div>
                  </div>
                  {x.tab ? <Badge kind="warn"><Money value={x.tab.total} /></Badge> : <Badge kind="ok">{t('Свободен')}</Badge>}
                  <Button kind="secondary" size="sm" onClick={() => setEdit(x)}>{t('Изменить')}</Button>
                </div>
              ))}
            </div>
          )}
          <p className="small muted">{t('Столы включают открытые счёта: гость садится, заказ добавляется в счёт, кухня получает позиции, оплата закрывает стол.')}</p>
        </div>
        <div className="card">
          <h2>{t('Экраны зала')}</h2>
          <div className="stack">
            <p className="small muted">{t('Откройте табло очереди на телевизоре или планшете — вход не нужен.')}</p>
            <a className="btn secondary" href={`#/queue?shop=${session.shop.id}`}>{t('Открыть табло очереди')}</a>
            <div style={{ background: '#fff', padding: 8, borderRadius: 10, width: 'fit-content' }}><QR value={queueUrl} size={160} /></div>
            <div className="mono small" style={{ wordBreak: 'break-all' }}>{queueUrl}</div>
            <hr className="sep" />
            <a className="btn secondary" href="#/tables">{t('Рабочий экран столов')}</a>
            <a className="btn ghost" href="#/kitchen">{t('Экран кухни')}</a>
            <a className="btn ghost" href="#/kiosk">{t('Запустить киоск')}</a>
            <p className="small muted">{t('Киоск выходит по PIN сотрудника. Табло и кухня обновляются сами.')}</p>
          </div>
        </div>
      </div>
      {edit && <TableModal table={edit} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); sound.click(); }} />}
    </div>
  );
}

function TableModal({ table, onClose, onSaved }) {
  const [f, setF] = useState({ name: table.name || '', seats: table.seats || 4, active: table.active !== false });
  return (
    <Modal title={table.id ? t('Стол') : t('Новый стол')} onClose={onClose}>
      <Form onSubmit={async () => {
        const body = { name: f.name, seats: Number(f.seats), active: f.active };
        if (table.id) await patch(`/pos/tables/${table.id}`, body);
        else await post('/pos/tables', body);
        onSaved();
      }}>
        <Input label={t('Название')} required value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder={t('Стол 1, Терраса 2…')} maxLength={40} />
        <Input label={t('Мест')} type="number" min={1} max={100} value={f.seats} onChange={(e) => setF({ ...f, seats: e.target.value })} />
        <label className="check"><input type="checkbox" checked={f.active} onChange={(e) => setF({ ...f, active: e.target.checked })} /> {t('Включён')}</label>
        {table.tab && <div className="form-warn">{t('У стола открыт счёт. Изменения не закроют его.')}</div>}
      </Form>
    </Modal>
  );
}
