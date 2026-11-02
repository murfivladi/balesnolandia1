// Акции, промокоды и баллы лояльности магазина.
import { useState } from 'react';
import { get, post, patch } from '../shared/api.js';
import { t, fmtDate } from '../shared/i18n.js';
import { Spinner, useAsync, MoneyInput, Input, Select, Form, Modal, Empty, Button, ActionButton, Badge, ErrorBox, useToast, Seg, Field } from '../shared/ui.jsx';
import { formatMoney } from '@bln/shared/money.js';

const KIND = { percent: '% от чека', amount: 'Сумма от чека', qty: '% за количество' };

export function Promos({ session, onChange }) {
  const { data, loading, reload } = useAsync(() => get('/pos/promos'), []);
  const { data: members, reload: reloadMembers } = useAsync(() => get('/pos/loyalty'), []);
  const { data: products } = useAsync(() => get('/pos/products?all=1'), []);
  const [edit, setEdit] = useState(null);
  const toast = useToast();
  if (loading && !data) return <Spinner />;
  return (
    <div className="page">
      <div className="page-head">
        <h1>{t('Акции и баллы')}</h1>
        <Button onClick={() => setEdit({ kind: 'percent', value: 1000, min_qty: 0, min_total: 0, active: true })}>+ {t('Акция')}</Button>
      </div>
      <div className="card">
        <div className="card-head"><h2>{t('Акции и промокоды')}</h2><Badge>{data.promos.filter((p) => p.active).length} {t('активных')}</Badge></div>
        {!data.promos.length ? <Empty>{t('Акций пока нет')}</Empty> : (
          <div className="table-wrap">
            <table className="table">
              <thead><tr><th>{t('Название')}</th><th>{t('Вид')}</th><th>{t('Скидка')}</th><th>{t('Промокод')}</th><th>{t('Товар')}</th><th>{t('Условия')}</th><th>{t('Использований')}</th><th /></tr></thead>
              <tbody>{data.promos.map((p) => (
                <tr key={p.id} style={{ opacity: p.active ? 1 : .55 }}>
                  <td>{p.title} {p.active ? <Badge kind="ok">{t('активна')}</Badge> : <Badge>{t('выключена')}</Badge>}</td>
                  <td className="small">{t(KIND[p.kind])}</td>
                  <td className="num">{p.kind === 'amount' ? formatMoney(p.value) : `${p.value / 100}%`}</td>
                  <td className="mono small">{p.code || '—'}</td>
                  <td className="small">{p.product_id ? (products?.products.find((x) => x.id === p.product_id)?.name || `#${p.product_id}`) : t('весь чек')}</td>
                  <td className="small muted">
                    {p.min_qty ? `${t('от')} ${p.min_qty} ${t('шт')}` : ''}{p.min_total ? ` · ${t('от')} ${formatMoney(p.min_total)}` : ''}{!p.min_qty && !p.min_total ? '—' : ''}
                  </td>
                  <td className="num">{p.used}{p.max_uses ? ` / ${p.max_uses}` : ''}</td>
                  <td className="right nowrap">
                    <Button kind="secondary" size="sm" onClick={() => setEdit({ ...p, percent: p.kind === 'percent' || p.kind === 'qty' ? p.value / 100 : 10 })}>{t('Изменить')}</Button>
                    <ActionButton size="sm" kind="ghost" action={async () => { await patch(`/pos/promos/${p.id}`, { active: !p.active }); reload(); }}>{p.active ? t('Выключить') : t('Включить')}</ActionButton>
                  </td>
                </tr>
              ))}</tbody>
            </table>
          </div>
        )}
        <p className="small muted">{t('Акции без промокода применяются сами. Скидка за количество срабатывает, когда в чеке не меньше указанного числа штук.')}</p>
      </div>

      <LoyaltySettings session={session} onChange={onChange} />

      <div className="card">
        <div className="card-head"><h2>{t('Участники программы')}</h2><Badge>{members?.members.length || 0}</Badge><Button kind="ghost" size="sm" onClick={reloadMembers}>{t('Обновить')}</Button></div>
        {!members?.members.length ? <Empty>{t('Пока ни у кого нет баллов')}</Empty> : (
          <table className="table">
            <thead><tr><th>{t('Клиент')}</th><th>{t('Баллы')}</th><th>{t('Обновлено')}</th></tr></thead>
            <tbody>{members.members.map((m) => (
              <tr key={m.full_name}><td>{m.full_name}</td><td className="num">{m.points}</td><td className="small">{fmtDate(m.updated_at)}</td></tr>
            ))}</tbody>
          </table>
        )}
        <p className="small muted">{t('Баллы начисляются клиенту ВлодБанка за оплату картой или по QR. 1 балл = 1 влодинка скидки.')}</p>
      </div>
      {edit && <PromoModal promo={edit} products={products?.products || []} onClose={() => setEdit(null)} onSaved={() => { setEdit(null); reload(); toast(t('Сохранено'), 'ok'); }} />}
    </div>
  );
}

function PromoModal({ promo, products, onClose, onSaved }) {
  const [f, setF] = useState({
    title: promo.title || '', kind: promo.kind || 'percent', code: promo.code || '',
    percent: promo.percent ?? (promo.kind === 'amount' ? 10 : promo.value / 100), amount: promo.kind === 'amount' ? promo.value : null,
    product_id: promo.product_id || '', min_qty: promo.min_qty || 2, min_total: promo.min_total || null, max_uses: promo.max_uses || '', active: promo.active !== false,
  });
  const [error, setError] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e?.target ? (e.target.type === 'checkbox' ? e.target.checked : e.target.value) : e });
  const isPct = f.kind === 'percent' || f.kind === 'qty';
  return (
    <Modal title={promo.id ? t('Акция') : t('Новая акция')} onClose={onClose} wide>
      <Form onSubmit={async () => {
        setError(null);
        const body = {
          title: f.title, kind: f.kind, code: f.code || null,
          value: isPct ? Math.round(Number(f.percent) * 100) : f.amount,
          product_id: f.product_id ? Number(f.product_id) : null,
          min_qty: f.kind === 'qty' ? Number(f.min_qty) : 0,
          min_total: f.min_total || 0,
          max_uses: f.max_uses ? Number(f.max_uses) : null,
          active: f.active,
        };
        try {
          if (promo.id) await patch(`/pos/promos/${promo.id}`, body);
          else await post('/pos/promos', body);
          onSaved();
        } catch (e) { setError(e); }
      }}>
        <Input label={t('Название')} required value={f.title} onChange={set('title')} maxLength={80} />
        <Field label={t('Вид скидки')}>
          <Seg value={f.kind} onChange={(v) => setF({ ...f, kind: v })} options={[{ value: 'percent', label: t('% от чека') }, { value: 'amount', label: t('Сумма') }, { value: 'qty', label: t('% за количество') }]} />
        </Field>
        <div className="grid grid-2">
          {isPct ? <Input label={t('Процент, %')} type="number" min={1} max={100} value={f.percent} onChange={set('percent')} /> : <MoneyInput label={t('Сумма скидки')} value={f.amount} onChange={(v) => setF({ ...f, amount: v })} />}
          <Input label={t('Промокод (пусто — акция сама)')} value={f.code} onChange={set('code')} placeholder="SALE10" />
        </div>
        {f.kind === 'qty' && (
          <div className="grid grid-2">
            <Select label={t('Товар')} value={f.product_id} onChange={set('product_id')} options={[{ value: '', label: '—' }, ...products.map((p) => ({ value: p.id, label: p.name }))]} />
            <Input label={t('От количества, шт')} type="number" min={2} value={f.min_qty} onChange={set('min_qty')} />
          </div>
        )}
        {f.kind !== 'qty' && (
          <Select label={t('Только на товар (необязательно)')} value={f.product_id} onChange={set('product_id')} options={[{ value: '', label: t('Весь чек') }, ...products.map((p) => ({ value: p.id, label: p.name }))]} />
        )}
        <div className="grid grid-2">
          <MoneyInput label={t('Минимальная сумма чека')} value={f.min_total} onChange={(v) => setF({ ...f, min_total: v })} />
          <Input label={t('Лимит использований')} type="number" min={1} value={f.max_uses} onChange={set('max_uses')} hint={t('Пусто — без лимита')} />
        </div>
        <label className="check"><input type="checkbox" checked={f.active} onChange={set('active')} /> {t('Активна')}</label>
        <ErrorBox error={error} />
      </Form>
    </Modal>
  );
}

/** Настройки начисления и списания баллов + витрина для гостей. */
function LoyaltySettings({ session, onChange }) {
  const [earn, setEarn] = useState(session.shop.loyalty_bp / 100);
  const [cap, setCap] = useState(session.shop.loyalty_max_bp / 100);
  const toast = useToast();
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <div className="card-head"><h2>{t('Баллы лояльности')}</h2></div>
      <Form onSubmit={async () => {
        await patch('/pos/shop', { loyalty_bp: Math.round(Number(earn) * 100), loyalty_max_bp: Math.round(Number(cap) * 100) });
        toast(t('Сохранено'), 'ok');
        onChange();
      }}>
        <div className="grid grid-3">
          <Input label={t('Начислять, % от чека')} type="number" min={0} max={50} step="0.1" value={earn} onChange={(e) => setEarn(e.target.value)} />
          <Input label={t('Можно списать, % от чека')} type="number" min={0} max={100} step="1" value={cap} onChange={(e) => setCap(e.target.value)} />
          <div className="field"><span>&nbsp;</span><div className="small muted">{t('1 балл = 1 влодинка. Списание не больше указанной доли чека.')}</div></div>
        </div>
      </Form>
    </div>
  );
}
