import { CoatOfArms, Flag } from './brand.jsx';
import { QR } from './ui.jsx';
import { t, fmtBirth } from './i18n.js';
import { appUrl } from './api.js';
import { mmYY } from '@bln/shared/time.js';

export const MARITAL = { single: 'Не состоит в браке', married: 'В браке', divorced: 'Разведён(а)', widowed: 'Вдовец / вдова' };
export const DOC_DISCLAIMER = 'Игровой документ. Не является удостоверением личности.';

export function passportVerifyUrl(code) {
  return appUrl('services', `/verify/passport/${code}`);
}

/** Паспорт БФ — пластиковая ID-карта. */
export function IdCard({ p }) {
  return (
    <div className="id-card">
      <div className="id-head">
        <CoatOfArms size={28} />
        <div className="grow">
          <b>{t('БАЛЕСНОЛАНДСКАЯ ФЕДЕРАЦИЯ')}</b>
          <small>{t('ПАСПОРТ ГРАЖДАНИНА')} · PASSAPORTO</small>
        </div>
        <Flag width={34} />
      </div>
      <div className="id-photo">{p.photo ? <img src={p.photo} alt="" /> : <span>{t('фото')}</span>}</div>
      <div className="id-fields">
        <div style={{ gridColumn: '1 / -1' }}>
          <div className="k">{t('Фамилия, имя')}</div>
          <div className="v">{p.full_name}</div>
        </div>
        <div>
          <div className="k">{t('Дата рождения')}</div>
          <div className="v">{fmtBirth(p.birth_date)}</div>
          <div className="k" style={{ marginTop: 4 }}>{t('Номер')}</div>
          <div className="v mono">{p.number}</div>
          {p.expires_month !== null && p.expires_month !== undefined && (
            <>
              <div className="k" style={{ marginTop: 4 }}>{t('Действует до')}</div>
              <div className="v mono">{mmYY(p.expires_month)}</div>
            </>
          )}
        </div>
        {p.verify_code && <div className="id-qr" style={{ alignSelf: 'end' }}><QR value={passportVerifyUrl(p.verify_code)} size={78} margin={0} /></div>}
      </div>
      <div className="id-foot">{t(DOC_DISCLAIMER)}</div>
      <div className="id-watermark"><CoatOfArms size={180} /></div>
    </div>
  );
}

/** Паспорт для печати на термопринтере 58 мм. */
export function passportBlocks(p, tr = (s) => s) {
  return [
    { t: 'text', text: tr('БАЛЕСНОЛАНДСКАЯ ФЕДЕРАЦИЯ'), align: 'center', size: 22, bold: true },
    { t: 'text', text: tr('ПАСПОРТ ГРАЖДАНИНА'), align: 'center', size: 20 },
    { t: 'line', dash: false },
    p.photo ? { t: 'image', src: p.photo, w: 180 } : null,
    { t: 'text', text: tr('Фамилия, имя'), size: 16 },
    { t: 'wrap', text: p.full_name, size: 24, bold: true },
    { t: 'row', left: tr('Дата рождения'), right: fmtBirth(p.birth_date), size: 19 },
    { t: 'row', left: tr('Номер'), right: p.number, size: 19, bold: true },
    p.expires_month !== null && p.expires_month !== undefined ? { t: 'row', left: tr('Действует до'), right: mmYY(p.expires_month), size: 18 } : null,
    p.address ? { t: 'wrap', text: `${tr('Прописка')}: ${p.address}`, size: 17 } : null,
    { t: 'wrap', text: `${tr('Семейное положение')}: ${tr(MARITAL[p.marital_status] || '')}${p.spouse_name ? `, ${p.spouse_name}` : ''}`, size: 17 },
    p.children?.length ? { t: 'wrap', text: `${tr('Дети')}: ${p.children.map((c) => c.name).join(', ')}`, size: 17 } : null,
    { t: 'line' },
    { t: 'text', text: tr('Проверка паспорта'), align: 'center', size: 16 },
    p.verify_code ? { t: 'qr', data: passportVerifyUrl(p.verify_code), size: 170 } : null,
    { t: 'wrap', text: tr(DOC_DISCLAIMER), align: 'center', size: 16, bold: true },
  ];
}
