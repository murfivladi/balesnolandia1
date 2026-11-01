// Оригинальные символы Балесноландской Федерации и логотипы сервисов (вымышленные).

/** Герб БФ: щит с башней и восьмиконечной звездой. */
export function CoatOfArms({ size = 40, mono = false }) {
  const blue = mono ? '#000' : '#1f4fbf';
  const gold = mono ? '#000' : '#d4a72c';
  const white = mono ? '#fff' : '#ffffff';
  return (
    <svg viewBox="0 0 64 72" width={size} height={size * 1.125} aria-label="Герб БФ" role="img">
      <path d="M32 2 L60 10 V36 C60 54 46 64 32 70 C18 64 4 54 4 36 V10 Z" fill={blue} stroke={gold} strokeWidth="3" />
      <g fill={white}>
        <rect x="22" y="30" width="20" height="24" />
        <rect x="20" y="24" width="5" height="7" />
        <rect x="29.5" y="24" width="5" height="7" />
        <rect x="39" y="24" width="5" height="7" />
      </g>
      <rect x="29" y="43" width="6" height="11" rx="3" fill={blue} />
      <path d="M32 7 l2.2 4.6 4.8-1.6-1.6 4.8 4.6 2.2-4.6 2.2 1.6 4.8-4.8-1.6L32 27l-2.2-4.6-4.8 1.6 1.6-4.8L22 17l4.6-2.2-1.6-4.8 4.8 1.6Z" fill={gold} transform="translate(0,-1) scale(1)" />
    </svg>
  );
}

/** Флаг БФ: диагональ синего и белого, золотой круг со звездой. */
export function Flag({ width = 48 }) {
  return (
    <svg viewBox="0 0 90 60" width={width} height={(width * 2) / 3} aria-label="Флаг БФ" role="img" style={{ borderRadius: 3, boxShadow: '0 0 0 1px rgba(0,0,0,.15)' }}>
      <rect width="90" height="60" fill="#ffffff" />
      <path d="M0 0 H90 L0 60 Z" fill="#1f4fbf" />
      <circle cx="45" cy="30" r="13" fill="#d4a72c" />
      <path d="M45 21 l2 5.2 5.6-.4-4.3 3.6 2 5.2-5.3-3-5.3 3 2-5.2-4.3-3.6 5.6.4Z" fill="#ffffff" />
    </svg>
  );
}

/** Логотип ВлодБанка: золотая «В» на тёмно-синем. */
export function BankLogo({ size = 34, src }) {
  if (src) return <img src={src} width={size} height={size} alt="ВлодБанк" />;
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} aria-label="ВлодБанк" role="img">
      <rect width="40" height="40" rx="9" fill="#0b1f44" stroke="#c9a227" strokeWidth="1.5" />
      <path d="M11 10 H22.5 C27 10 29.5 12.3 29.5 15.6 C29.5 18 28.1 19.6 26 20.2 C28.6 20.8 30.5 22.6 30.5 25.6 C30.5 29.4 27.6 31 23 31 H11 Z M16 14 V18.6 H21.8 C23.6 18.6 24.5 17.8 24.5 16.3 C24.5 14.8 23.6 14 21.8 14 Z M16 22.4 V27 H22.4 C24.4 27 25.4 26.2 25.4 24.7 C25.4 23.2 24.4 22.4 22.4 22.4 Z" fill="#e8c96a" />
    </svg>
  );
}

export function ServicesLogo({ size = 34, src }) {
  if (src) return <img src={src} width={size} height={size} alt="ВлодУслуги" />;
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} aria-label="ВлодУслуги" role="img">
      <rect width="40" height="40" rx="9" fill="#ffffff" />
      <g transform="translate(6 3) scale(.44)"><CoatOfArmsPath /></g>
    </svg>
  );
}

function CoatOfArmsPath() {
  return (
    <>
      <path d="M32 2 L60 10 V36 C60 54 46 64 32 70 C18 64 4 54 4 36 V10 Z" fill="#1f4fbf" stroke="#d4a72c" strokeWidth="4" />
      <rect x="22" y="30" width="20" height="24" fill="#fff" />
      <rect x="20" y="24" width="5" height="7" fill="#fff" />
      <rect x="29.5" y="24" width="5" height="7" fill="#fff" />
      <rect x="39" y="24" width="5" height="7" fill="#fff" />
      <path d="M32 7 l2.2 4.6 4.8-1.6-1.6 4.8 4.6 2.2-4.6 2.2 1.6 4.8-4.8-1.6L32 27l-2.2-4.6-4.8 1.6 1.6-4.8L22 17l4.6-2.2-1.6-4.8 4.8 1.6Z" fill="#d4a72c" />
    </>
  );
}

export function PosLogo({ size = 34, src, color = '#0f766e' }) {
  if (src) return <img src={src} width={size} height={size} alt="" style={{ background: '#fff' }} />;
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden="true">
      <rect width="40" height="40" rx="9" fill="#ffffff" />
      <rect x="9" y="8" width="22" height="12" rx="2" fill={color} />
      <rect x="12" y="11" width="16" height="4" rx="1" fill="#fff" opacity=".85" />
      <rect x="7" y="22" width="26" height="11" rx="2" fill={color} opacity=".85" />
      <g fill="#fff"><circle cx="13" cy="26" r="1.4" /><circle cx="18" cy="26" r="1.4" /><circle cx="23" cy="26" r="1.4" /><circle cx="13" cy="30" r="1.4" /><circle cx="18" cy="30" r="1.4" /><rect x="22" y="28.6" width="8" height="2.8" rx="1" /></g>
    </svg>
  );
}

export function AdminLogo({ size = 34 }) {
  return (
    <svg viewBox="0 0 40 40" width={size} height={size} aria-hidden="true">
      <rect width="40" height="40" rx="9" fill="#4f46e5" />
      <g transform="translate(8 6) scale(.38)"><CoatOfArmsPath /></g>
    </svg>
  );
}
