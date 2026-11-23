// Админка → БалНет → Хостинг: серверы (Госхостинг и арендованные), тарифы, аккаунты игроков.
import { useState } from 'react';
import { get, post, patch, del } from '../shared/api.js';
import { Spinner, useAsync, Input, Select, Form, Money, MoneyInput, Badge, ActionButton, ErrorBox } from '../shared/ui.jsx';
import { gameDateLabel } from '@bln/shared/time.js';
import { useLang } from '../shared/i18n.js';

const ACC = { active: ['ok', 'работает'], suspended: ['err', 'приостановлен'], reserved: ['warn', 'ждёт оплаты'] };

export function HostingAdmin() {
  const lang = useLang();
  const { data, error, reload } = useAsync(() => get('/admin/net/hosting'), []);
  const [f, setF] = useState({ server_id: '', name: '', disk_mb: 50, max_sites: 5, price_month: 1000 });
  if (!data) return error ? <ErrorBox error={error} /> : <Spinner />;
  const govServers = data.servers.filter((s) => !s.org_id);
  return (
    <div className="stack">
      <div className="grid grid-2">
        <div className="card">
          <h2>Серверы хостинга</h2>
          <div className="list">
            {data.servers.map((s) => (
              <div key={s.id} className="list-item">
                <div className="li-main"><div className="li-title mono">{s.name} · {s.ip}</div><div className="li-sub">{s.hoster} · {s.disk_mb} МБ · клиентов {s.accounts}{s.org_id ? <> · аренда <Money value={s.rent_price} /></> : null}</div></div>
                <Badge kind={s.status === 'active' ? 'ok' : 'err'}>{s.status === 'active' ? 'работает' : 'выключен'}</Badge>
              </div>
            ))}
          </div>
          <ActionButton kind="ghost" size="sm" okMessage="Аренда и сроки хостинга обработаны" action={async () => { await post('/admin/net/hosting/tick'); reload(); }}>Обработать сроки сейчас</ActionButton>
        </div>
        <div className="card">
          <h2>Тарифы</h2>
          <div className="list">
            {data.plans.map((p) => (
              <div key={p.id} className="list-item">
                <div className="li-main"><div className="li-title">{p.hoster} · «{p.name}»</div><div className="li-sub">{p.disk_mb} МБ · до {p.max_sites} сайтов</div></div>
                <Money value={p.price_month} />
                {!p.org_id && <ActionButton size="sm" kind="ghost" action={async () => { await patch(`/admin/net/hosting/plans/${p.id}`, { active: !p.active }); reload(); }}>{p.active ? 'Снять' : 'Вернуть'}</ActionButton>}
              </div>
            ))}
          </div>
          {govServers.length > 0 && (
            <Form submitLabel="Добавить тариф Госхостинга" onSubmit={async () => { await post('/admin/net/hosting/plans', { ...f, server_id: Number(f.server_id || govServers[0].id) }); reload(); }}>
              <div className="grid grid-2">
                <Input label="Название" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} placeholder="Магазин" />
                <Select label="Сервер" value={f.server_id} onChange={(e) => setF({ ...f, server_id: e.target.value })} options={govServers.map((s) => ({ value: String(s.id), label: s.ip }))} />
                <Input label="Место, МБ" type="number" min="1" value={f.disk_mb} onChange={(e) => setF({ ...f, disk_mb: Number(e.target.value) })} />
                <Input label="Сайтов" type="number" min="1" value={f.max_sites} onChange={(e) => setF({ ...f, max_sites: Number(e.target.value) })} />
              </div>
              <MoneyInput label="Цена в игровой месяц" value={f.price_month} onChange={(v) => setF({ ...f, price_month: v })} />
            </Form>
          )}
        </div>
      </div>
      <div className="card">
        <h2>Аккаунты игроков ({data.accounts.length})</h2>
        <div className="list">
          {data.accounts.map((a) => (
            <div key={a.id} className="list-item">
              <div className="li-main">
                <div className="li-title">{a.owner || '—'} · «{a.plan}»</div>
                <div className="li-sub mono">{a.sites.join(', ') || 'сайтов нет'} · {(a.used_bytes / 1048576).toFixed(2)} МБ · до {gameDateLabel(a.paid_until_month, lang)}</div>
              </div>
              <Badge kind={ACC[a.status]?.[0]}>{ACC[a.status]?.[1] || a.status}</Badge>
              <ActionButton size="sm" kind="ghost" confirm="Удалить хостинг вместе с файлами сайтов? Это нельзя отменить." action={async () => { await del(`/admin/net/hosting/accounts/${a.id}`); reload(); }}>Удалить</ActionButton>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
