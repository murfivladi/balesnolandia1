import { useState } from 'react';
import JsBarcode from 'jsbarcode';
import { formatCardNumber } from '@bln/shared/format.js';
import { mmYY } from '@bln/shared/time.js';
import { QR, Barcode, Button, useToast } from './ui.jsx';
import { t } from './i18n.js';
import { renderThermal, shareCanvas } from './thermal.js';

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

/** Штрихкод номера карты картинкой (для печати на термопринтере). */
function barcodePng(value) {
  const c = document.createElement('canvas');
  JsBarcode(c, String(value), { format: 'CODE128', height: 70, width: 2, fontSize: 18, margin: 4, background: '#ffffff', lineColor: '#000000' });
  return c.toDataURL('image/png');
}

/** Карта для термопринтера 58 мм: номер, срок, держатель, QR и штрихкод (PIN не печатается). */
export function cardBlocks(card, tr = (s) => s) {
  return [
    { t: 'text', text: 'ВлодБанк', align: 'center', size: 26, bold: true },
    { t: 'text', text: `${tr('Карта')}: ${tr(CARD_TYPES[card.type] || card.type)}`, align: 'center', size: 18 },
    { t: 'line', dash: false },
    { t: 'text', text: formatCardNumber(card.number), align: 'center', size: 28, bold: true },
    { t: 'row', left: tr('Действует до'), right: mmYY(card.exp_month), size: 20, bold: true },
    { t: 'text', text: tr('Держатель'), size: 16 },
    { t: 'wrap', text: card.holder_name, size: 22, bold: true },
    { t: 'space', h: 8 },
    { t: 'qr', data: `BLNCARD:${card.number}`, size: 180 },
    { t: 'space', h: 8 },
    { t: 'image', src: barcodePng(card.number), w: 340, align: 'center' },
    { t: 'line' },
    { t: 'wrap', text: tr('PIN никому не сообщайте. Касса принимает карту по QR, штрихкоду или номеру.'), align: 'center', size: 15 },
    { t: 'wrap', text: tr('Игровая карта. Не является платёжным средством'), align: 'center', size: 16, bold: true },
  ];
}

/** Кнопка «Распечатать карту»: PNG 58 мм — скачать или отправить в приложение принтера. */
export function PrintCardButton({ card, kind = 'secondary', size }) {
  const [busy, setBusy] = useState(false);
  const toast = useToast();
  async function print() {
    setBusy(true);
    try {
      const canvas = await renderThermal(cardBlocks(card, t));
      await shareCanvas(canvas, `card-${String(card.number).slice(-4)}.png`);
    } catch (e) {
      toast(e.message, 'err');
    } finally {
      setBusy(false);
    }
  }
  return <Button kind={kind} size={size} busy={busy} onClick={print}>🖨 {t('Распечатать карту (58 мм)')}</Button>;
}
