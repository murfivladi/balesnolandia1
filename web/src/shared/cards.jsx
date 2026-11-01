import { formatCardNumber } from '@bln/shared/format.js';
import { mmYY } from '@bln/shared/time.js';
import { QR, Barcode } from './ui.jsx';
import { t } from './i18n.js';

export const CARD_TYPES = { debit: 'Дебетовая', credit: 'Кредитная', child: 'Детская', gift: 'Подарочная' };
export const BACKGROUNDS = ['classic', 'waves', 'grid', 'sunset', 'forest', 'night', 'gold', 'mint'];

/** Карта ВлодБанка. Формат намеренно не совпадает с настоящими картами (12 цифр, PIN 3 цифры). */
export function BankCard({ card, small = false, showCodes = false, hideNumber = false }) {
  const number = hideNumber ? `•••• •••• ${card.last4 || String(card.number).slice(-4)}` : formatCardNumber(card.number);
  return (
    <div className={`bank-card bg-${card.background || 'classic'}${small ? ' small' : ''}${card.status === 'frozen' ? ' frozen' : ''}`}>
      <div className="bc-top">
        <div>
          <div className="bc-bank">ВлодБанк</div>
          <div className={`bc-type bc-type-${card.type || 'debit'}`}>{t(CARD_TYPES[card.type] || card.type)}</div>
        </div>
        {showCodes && !small ? <div className="bc-qr"><QR value={`BLNCARD:${card.number}`} size={56} margin={0} /></div> : <div className="bc-chip" />}
      </div>
      <div className="bc-number">{number}</div>
      <div className="bc-bottom">
        <div>
          <div className="bc-label">{t('Держатель')}</div>
          <div>{card.holder_name}</div>
        </div>
        <div className="right">
          <div className="bc-label">{t('Действует до')}</div>
          <div className="mono">{mmYY(card.exp_month)}</div>
        </div>
      </div>
      {!small && <div className="bc-disc">{t('Игровая карта. Не является платёжным средством')}</div>}
    </div>
  );
}

export function CardBarcode({ number }) {
  return (
    <div style={{ background: '#fff', padding: 8, borderRadius: 8, display: 'inline-block', color: '#000' }}>
      <Barcode value={String(number)} height={44} />
    </div>
  );
}

/** Разбор содержимого QR/штрихкода карты: BLNCARD:770012345678 или просто 12 цифр. */
export function parseCardScan(text) {
  const d = String(text || '').replace(/^BLNCARD:/, '').replace(/\D/g, '');
  return d.length === 12 ? d : null;
}
