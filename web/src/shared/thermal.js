// PNG для термопринтера 58 мм: ширина 384 px (203 dpi), белый фон, чёрный текст, любая длина.
import QRCode from 'qrcode';
import { formatMoney } from '@bln/shared/money.js';
import { DISCLAIMER } from './ui.jsx';

export const PAPER_WIDTH = 384;
const PAD = 8;
const FONT = '"DejaVu Sans Mono", "Courier New", ui-monospace, monospace';

/**
 * Блоки: {t:'text', text, align, size, bold}, {t:'row', left, right, bold, size}, {t:'line', dash},
 * {t:'space', h}, {t:'qr', data, size}, {t:'image', src, w, h, align}, {t:'wrap', text, size, align}
 */
export async function renderThermal(blocks) {
  const canvas = document.createElement('canvas');
  canvas.width = PAPER_WIDTH;
  const measure = canvas.getContext('2d');
  // Готовим картинки и QR заранее, чтобы знать высоту.
  const prepared = [];
  for (const b of blocks) {
    if (!b) continue;
    if (b.t === 'qr') {
      const c = document.createElement('canvas');
      await QRCode.toCanvas(c, b.data, { width: b.size || 180, margin: 0, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } });
      prepared.push({ ...b, canvas: c });
    } else if (b.t === 'image' && b.src) {
      try {
        const img = new Image();
        img.src = b.src;
        await img.decode();
        prepared.push({ ...b, img });
      } catch { /* картинка не загрузилась — пропускаем */ }
    } else prepared.push(b);
  }

  const lines = [];
  const font = (size = 20, bold = false) => `${bold ? 'bold ' : ''}${size}px ${FONT}`;
  const wrap = (text, size, bold, width = PAPER_WIDTH - PAD * 2) => {
    measure.font = font(size, bold);
    const words = String(text ?? '').split(/(\s+)/);
    const out = [];
    let cur = '';
    for (const w of words) {
      const test = cur + w;
      if (measure.measureText(test).width > width && cur.trim()) {
        out.push(cur.trimEnd());
        cur = w.trimStart();
        // очень длинное слово — режем посимвольно
        while (measure.measureText(cur).width > width) {
          let i = cur.length;
          while (i > 1 && measure.measureText(cur.slice(0, i)).width > width) i--;
          out.push(cur.slice(0, i));
          cur = cur.slice(i);
        }
      } else cur = test;
    }
    if (cur.trim() || !out.length) out.push(cur.trimEnd());
    return out;
  };

  let h = PAD;
  for (const b of prepared) {
    const size = b.size || 20;
    if (b.t === 'text' || b.t === 'wrap') {
      for (const l of wrap(b.text, size, b.bold)) { lines.push({ ...b, text: l, y: h, size }); h += Math.round(size * 1.3); }
    } else if (b.t === 'row') {
      measure.font = font(size, b.bold);
      const rightW = measure.measureText(b.right ?? '').width;
      const leftLines = wrap(b.left, size, b.bold, PAPER_WIDTH - PAD * 2 - rightW - 12);
      leftLines.forEach((l, i) => {
        lines.push({ t: 'row', left: l, right: i === leftLines.length - 1 ? b.right : '', y: h, size, bold: b.bold });
        h += Math.round(size * 1.3);
      });
    } else if (b.t === 'line') {
      lines.push({ ...b, y: h + 6 });
      h += 14;
    } else if (b.t === 'space') {
      h += b.h || 10;
    } else if (b.t === 'qr') {
      lines.push({ ...b, y: h });
      h += b.canvas.height + 6;
    } else if (b.t === 'image') {
      const w = Math.min(b.w || 160, PAPER_WIDTH - PAD * 2);
      const ih = b.h || Math.round((b.img.naturalHeight / b.img.naturalWidth) * w);
      lines.push({ ...b, y: h, w, ih });
      h += ih + 6;
    }
  }
  h += PAD + 24; // запас на отрыв

  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, PAPER_WIDTH, h);
  ctx.fillStyle = '#000000';
  ctx.strokeStyle = '#000000';
  ctx.textBaseline = 'top';

  for (const l of lines) {
    if (l.t === 'text' || l.t === 'wrap') {
      ctx.font = font(l.size, l.bold);
      const w = ctx.measureText(l.text).width;
      const x = l.align === 'center' ? (PAPER_WIDTH - w) / 2 : l.align === 'right' ? PAPER_WIDTH - PAD - w : PAD;
      ctx.fillText(l.text, x, l.y);
    } else if (l.t === 'row') {
      ctx.font = font(l.size, l.bold);
      ctx.fillText(l.left, PAD, l.y);
      if (l.right) ctx.fillText(l.right, PAPER_WIDTH - PAD - ctx.measureText(l.right).width, l.y);
    } else if (l.t === 'line') {
      ctx.setLineDash(l.dash === false ? [] : [6, 4]);
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(PAD, l.y);
      ctx.lineTo(PAPER_WIDTH - PAD, l.y);
      ctx.stroke();
      ctx.setLineDash([]);
    } else if (l.t === 'qr') {
      ctx.drawImage(l.canvas, (PAPER_WIDTH - l.canvas.width) / 2, l.y);
    } else if (l.t === 'image') {
      const x = l.align === 'left' ? PAD : (PAPER_WIDTH - l.w) / 2;
      ctx.drawImage(l.img, x, l.y, l.w, l.ih);
    }
  }
  toMonochrome(ctx, PAPER_WIDTH, h);
  return canvas;
}

/** Порог в чёрно-белое: термопринтер печатает только чёрные точки. */
function toMonochrome(ctx, w, h) {
  const data = ctx.getImageData(0, 0, w, h);
  const d = data.data;
  for (let i = 0; i < d.length; i += 4) {
    const v = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2] < 150 ? 0 : 255;
    d[i] = d[i + 1] = d[i + 2] = v;
    d[i + 3] = 255;
  }
  ctx.putImageData(data, 0, 0);
}

/** Сохранить или поделиться PNG (на телефоне — меню «Поделиться» → приложение принтера). */
export async function shareCanvas(canvas, filename) {
  const blob = await new Promise((r) => canvas.toBlob(r, 'image/png'));
  const file = new File([blob], filename, { type: 'image/png' });
  if (navigator.canShare?.({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: filename });
      return 'shared';
    } catch (err) {
      if (err.name === 'AbortError') return 'cancelled';
    }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return 'downloaded';
}

const qtyText = (i) => (i.unit === 'kg' ? `${(i.qty_milli / 1000).toFixed(3).replace('.', ',')} кг` : `${i.qty_milli / 1000} шт`);
const m = (v) => formatMoney(v).replace(/\u00a0/g, ' ');
const METHOD = { cash: 'Наличные', card: 'Карта', qr: 'QR-оплата', debt: 'В долг' };

/** Блоки кассового чека. tr — функция перевода. */
export function receiptBlocks(r, tr = (s) => s) {
  const s = r.sale;
  return [
    r.shop.logo ? { t: 'image', src: r.shop.logo, w: 120 } : null,
    { t: 'text', text: r.shop.name, align: 'center', size: 26, bold: true },
    r.shop.address ? { t: 'wrap', text: r.shop.address, align: 'center', size: 18 } : null,
    { t: 'text', text: `${tr('ИНН')} ${r.shop.inn || '—'}`, align: 'center', size: 18 },
    { t: 'text', text: `${tr('ИП')} ${r.shop.ip_number}`, align: 'center', size: 18 },
    { t: 'line' },
    { t: 'text', text: `${tr('КАССОВЫЙ ЧЕК')} №${s.number}`, align: 'center', size: 22, bold: true },
    { t: 'text', text: new Date(s.paid_at).toLocaleString('ru-RU'), align: 'center', size: 18 },
    { t: 'text', text: `${tr('Кассир')}: ${r.cashier}`, size: 18 },
    r.shift ? { t: 'text', text: `${tr('Смена')} №${r.shift}`, size: 18 } : null,
    { t: 'line' },
    ...s.items.flatMap((i) => [
      { t: 'wrap', text: i.name, size: 20, bold: true },
      { t: 'row', left: `  ${qtyText(i)} × ${m(i.price)}`, right: m(i.total), size: 19 },
      i.discount ? { t: 'row', left: `  ${tr('скидка')}`, right: `−${m(i.discount)}`, size: 17 } : null,
    ]),
    { t: 'line' },
    s.discount ? { t: 'row', left: tr('Скидка'), right: `−${m(s.discount)}`, size: 20 } : null,
    { t: 'row', left: tr('ИТОГО'), right: m(s.total), size: 28, bold: true },
    { t: 'row', left: `${tr('в т.ч. НДС')} ${s.vat_bp / 100}%`, right: m(s.vat), size: 18 },
    s.tip ? { t: 'row', left: `${tr('Чаевые кассиру')} ${s.tip_pct}%`, right: m(s.tip), size: 19 } : null,
    s.points_used ? { t: 'row', left: tr('Оплачено баллами'), right: `−${m(s.points_used)}`, size: 17 } : null,
    s.points_earned ? { t: 'row', left: tr('Начислено баллов'), right: String(s.points_earned), size: 17 } : null,
    { t: 'space', h: 4 },
    ...s.payments.flatMap((p) => [
      { t: 'row', left: tr(METHOD[p.method]), right: m(p.amount), size: 20 },
      p.method === 'cash' && p.cash_given ? { t: 'row', left: `  ${tr('Получено')}`, right: m(p.cash_given), size: 18 } : null,
      p.method === 'cash' && p.change_given ? { t: 'row', left: `  ${tr('Сдача')}`, right: m(p.change_given), size: 18 } : null,
    ]),
    s.refunded ? { t: 'row', left: tr('Возвращено'), right: m(s.refunded), size: 19 } : null,
    { t: 'line' },
    { t: 'text', text: tr('Проверка чека во ВлодУслугах'), align: 'center', size: 17 },
    { t: 'qr', data: r.verify_url, size: 170 },
    r.shop.footer ? { t: 'wrap', text: r.shop.footer, align: 'center', size: 18 } : null,
    { t: 'space', h: 6 },
    { t: 'wrap', text: tr(DISCLAIMER), align: 'center', size: 15 },
  ];
}

/** Блоки X/Z-отчёта. */
export function reportBlocks(rep, { shop, cashier, z }, tr = (s) => s) {
  return [
    { t: 'text', text: shop.name, align: 'center', size: 24, bold: true },
    { t: 'text', text: `${tr('ИНН')} ${shop.inn || '—'}`, align: 'center', size: 18 },
    { t: 'line' },
    { t: 'text', text: `${z ? tr('Z-ОТЧЁТ (закрытие смены)') : tr('X-ОТЧЁТ')}`, align: 'center', size: 22, bold: true },
    { t: 'text', text: `${tr('Смена')} №${rep.shift.number}`, align: 'center', size: 20 },
    { t: 'text', text: `${tr('Открыта')}: ${new Date(rep.shift.opened_at).toLocaleString('ru-RU')}`, size: 17 },
    z ? { t: 'text', text: `${tr('Закрыта')}: ${new Date(rep.shift.closed_at || Date.now()).toLocaleString('ru-RU')}`, size: 17 } : null,
    { t: 'text', text: `${tr('Кассир')}: ${cashier}`, size: 17 },
    { t: 'line' },
    { t: 'row', left: tr('Чеков'), right: String(rep.sales_count), size: 20 },
    { t: 'row', left: tr('Выручка'), right: m(rep.revenue), size: 22, bold: true },
    { t: 'row', left: tr('в т.ч. НДС'), right: m(rep.vat), size: 18 },
    { t: 'row', left: tr('Скидки'), right: m(rep.discounts), size: 18 },
    { t: 'row', left: tr('Чаевые'), right: m(rep.tips), size: 18 },
    { t: 'line' },
    { t: 'row', left: tr('Наличные'), right: m(rep.by_method.cash), size: 19 },
    { t: 'row', left: tr('Карта'), right: m(rep.by_method.card), size: 19 },
    { t: 'row', left: tr('QR-оплата'), right: m(rep.by_method.qr), size: 19 },
    rep.by_method.debt ? { t: 'row', left: tr('В долг'), right: m(rep.by_method.debt), size: 19 } : null,
    { t: 'row', left: tr('Возвраты'), right: m(rep.refunds_total), size: 19 },
    { t: 'row', left: tr('Квитанции наличными'), right: m(rep.invoices_cash.amount), size: 18 },
    rep.debts_cash?.amount ? { t: 'row', left: tr('Погашено долгов наличными'), right: m(rep.debts_cash.amount), size: 18 } : null,
    { t: 'line' },
    { t: 'row', left: tr('Разменный фонд'), right: m(rep.opening_float), size: 18 },
    { t: 'row', left: tr('Инкассация'), right: m(rep.collected), size: 18 },
    { t: 'row', left: tr('Ожидается в ящике'), right: m(rep.expected_cash), size: 20, bold: true },
    rep.closing_cash !== undefined && rep.closing_cash !== null ? { t: 'row', left: tr('Фактически'), right: m(rep.closing_cash), size: 19 } : null,
    rep.difference ? { t: 'row', left: tr('Расхождение'), right: m(rep.difference), size: 19, bold: true } : null,
    { t: 'row', left: tr('Открытий ящика'), right: String(rep.drawer_opens), size: 17 },
    { t: 'space', h: 6 },
    { t: 'wrap', text: tr(DISCLAIMER), align: 'center', size: 15 },
  ];
}
