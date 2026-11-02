// Выбор варианта, добавок и количества перед добавлением товара в чек.
import { useMemo, useState } from 'react';
import { t } from '../shared/i18n.js';
import { Modal, Button, Input, Money } from '../shared/ui.jsx';
import { formatMoney } from '@bln/shared/money.js';
import { QTY, linePrice, lineSum, parseWeight } from './lib.js';

export function ItemOptionsModal({ product, onClose, onAdd }) {
  const variants = (product.variants || []).filter((v) => v.active !== false);
  const modifiers = (product.modifiers || []).filter((m) => m.active !== false);
  const [variantId, setVariantId] = useState(null);
  const [picked, setPicked] = useState([]);
  const [count, setCount] = useState(1);
  const [weight, setWeight] = useState('');
  const variant = variants.find((v) => v.id === variantId) || null;
  const mods = useMemo(() => modifiers.filter((m) => picked.includes(m.id)), [modifiers, picked]);
  const price = linePrice(product, variant, mods);
  const qty = product.unit === 'kg' ? parseWeight(weight) : count * QTY;
  const total = lineSum(price, qty);
  const kgPriceMissing = product.unit === 'kg' && qty <= 0;

  function toggle(id) {
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  }

  return (
    <Modal title={product.name} onClose={onClose} wide>
      <div className="stack">
        {variants.length > 0 && (
          <div className="field">
            <span>{t('Вариант')}</span>
            <div className="row">
              <button type="button" className={`btn sm ${variantId === null ? '' : 'secondary'}`} onClick={() => setVariantId(null)}>
                {t('Без варианта')} · {formatMoney(product.price)}
              </button>
              {variants.map((v) => (
                <button key={v.id} type="button" className={`btn sm ${variantId === v.id ? '' : 'secondary'}`} onClick={() => setVariantId(v.id)}>
                  {v.name} · {formatMoney(Number(product.price) + Number(v.price_delta))}
                </button>
              ))}
            </div>
          </div>
        )}
        {modifiers.length > 0 && (
          <div className="field">
            <span>{t('Добавки')}</span>
            <div className="stack-sm">
              {modifiers.map((m) => (
                <label key={m.id} className="check">
                  <input type="checkbox" checked={picked.includes(m.id)} onChange={() => toggle(m.id)} />
                  <span>{m.name}</span>
                  <span className="muted small">{m.price ? `+${formatMoney(m.price)}` : t('бесплатно')}</span>
                </label>
              ))}
            </div>
          </div>
        )}
        {product.unit === 'kg' ? (
          <Input
            label={t('Вес: граммы или килограммы через запятую')}
            inputMode="decimal"
            autoFocus
            value={weight}
            onChange={(e) => setWeight(e.target.value)}
            hint={`${formatMoney(price)} / ${t('кг')}`}
          />
        ) : (
          <div className="row" style={{ justifyContent: 'space-between' }}>
            <span>{t('Количество')}</span>
            <div className="row nowrap">
              <button type="button" className="qty-btn" onClick={() => setCount((c) => Math.max(1, c - 1))}>−</button>
              <b style={{ minWidth: 34, textAlign: 'center', fontSize: '1.15rem' }}>{count}</b>
              <button type="button" className="qty-btn" onClick={() => setCount((c) => Math.min(999, c + 1))}>+</button>
            </div>
          </div>
        )}
        <div className="row" style={{ justifyContent: 'space-between', borderTop: '1px solid var(--line)', paddingTop: 10 }}>
          <span>{qtyLabelText(product.unit, qty)}</span>
          <b style={{ fontSize: '1.3rem' }}><Money value={total} /></b>
        </div>
        <div className="row">
          <Button kind="ghost" onClick={onClose}>{t('Отмена')}</Button>
          <Button
            className="grow"
            disabled={kgPriceMissing || !qty}
            onClick={() => onAdd({ variant_id: variant?.id || null, modifier_ids: mods.map((m) => m.id), qty_milli: qty })}
          >
            {t('Добавить в чек')}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

function qtyLabelText(unit, qty) {
  if (unit === 'kg') return `${(qty / 1000).toFixed(3).replace('.', ',')} ${t('кг')}`;
  return `${qty / QTY} ${t('шт')}`;
}
