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

// ——— Логотипы сервисов БалНета (оригинальные знаки) ———

/** БалРег — регистратор доменов: «глобус-точка». */
export function RegLogo({ size = 34 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="10" fill="#0b7a5e" />
      <circle cx="20" cy="20" r="11" fill="none" stroke="#fff" strokeWidth="2.4" />
      <ellipse cx="20" cy="20" rx="5" ry="11" fill="none" stroke="#fff" strokeWidth="2" />
      <path d="M9.5 16h21M9.5 24h21" stroke="#fff" strokeWidth="2" />
      <circle cx="30" cy="30" r="5" fill="#ffd166" stroke="#0b7a5e" strokeWidth="2" />
    </svg>
  );
}

/** БалХост — хостинг: три сервера. */
export function HostLogo({ size = 34 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="10" fill="#6326d1" />
      {[9, 17.5, 26].map((y) => (
        <g key={y}>
          <rect x="8" y={y} width="24" height="6" rx="2" fill="#fff" />
          <circle cx="12" cy={y + 3} r="1.4" fill="#22c55e" />
          <rect x="20" y={y + 2.2} width="9" height="1.6" rx=".8" fill="#c4b5fd" />
        </g>
      ))}
    </svg>
  );
}

/** Налоговая служба БФ: герб на зелёном щите. */
export function NalogLogo({ size = 34 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <path d="M20 2 35 8v11c0 9.5-6.4 16.4-15 19-8.6-2.6-15-9.5-15-19V8Z" fill="#155e3b" stroke="#d4a72c" strokeWidth="2" />
      <path d="M13 26h14M14 26V17m4 9v-9m4 9v-9m4 9v-9M12 17h16l-8-5Z" stroke="#fff" strokeWidth="2" fill="none" strokeLinejoin="round" />
    </svg>
  );
}

/** БалСерт (ca.gov.bln): замок со щитом. */
export function CaLogo({ size = 34 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="10" fill="#0f766e" />
      <path d="M14 18v-3.5a6 6 0 0 1 12 0V18" fill="none" stroke="#fff" strokeWidth="2.6" strokeLinecap="round" />
      <rect x="10.5" y="17.5" width="19" height="14" rx="3" fill="#fff" />
      <path d="M16 24.5l3 3 5.5-6" fill="none" stroke="#0f766e" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/** ВлодПоиск (poisk.bln): лупа. */
export function PoiskLogo({ size = 34 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="10" fill="#1f4fbf" />
      <circle cx="17.5" cy="17.5" r="7.5" fill="none" stroke="#fff" strokeWidth="3" />
      <path d="M23 23l7 7" stroke="#e8c15a" strokeWidth="3.6" strokeLinecap="round" />
    </svg>
  );
}

/** ВлодХаб (vlodhub.bln): ветки git. */
export function HubLogo({ size = 34 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="10" fill="#24292f" />
      <circle cx="13" cy="11" r="3.4" fill="none" stroke="#fff" strokeWidth="2.4" />
      <circle cx="13" cy="29" r="3.4" fill="none" stroke="#fff" strokeWidth="2.4" />
      <circle cx="27" cy="15" r="3.4" fill="none" stroke="#f0b429" strokeWidth="2.4" />
      <path d="M13 14.5v11M27 18.5c0 5-6 5-12.5 8" fill="none" stroke="#fff" strokeWidth="2.4" strokeLinecap="round" />
    </svg>
  );
}

/** ВлодПочта (mail.bln): конверт с печатью. */
export function MailLogo({ size = 34 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="10" fill="#c2410c" />
      <rect x="8" y="12" width="24" height="17" rx="2.5" fill="#fff" />
      <path d="M9 13.5l11 8.5 11-8.5" fill="none" stroke="#c2410c" strokeWidth="2.2" strokeLinejoin="round" />
      <circle cx="29" cy="27" r="5" fill="#f0b429" stroke="#c2410c" strokeWidth="1.6" />
    </svg>
  );
}

/** БалПуш (push.bln): колокольчик с волнами. */
export function PushLogo({ size = 34 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="10" fill="#7c3aed" />
      <path d="M13 26h14l-1.6-2.4V18a5.4 5.4 0 0 0-10.8 0v5.6z" fill="#fff" />
      <path d="M17.6 28.4a2.6 2.6 0 0 0 4.8 0" fill="none" stroke="#fff" strokeWidth="2" strokeLinecap="round" />
      <path d="M28.5 12.5a8 8 0 0 1 2 5M11.5 12.5a8 8 0 0 0-2 5" fill="none" stroke="#f0b429" strokeWidth="2.2" strokeLinecap="round" />
/** БалНовости (novosti.bln): газетная полоса. */
export function NewsLogo({ size = 34 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 40 40" aria-hidden="true">
      <rect width="40" height="40" rx="10" fill="#b42318" />
      <rect x="9" y="10" width="22" height="20" rx="2" fill="#fff" />
      <rect x="12" y="13" width="16" height="4" fill="#b42318" />
      <path d="M12 21h7M12 24h7M12 27h7M22 21h6M22 24h6M22 27h6" stroke="#475467" strokeWidth="1.4" />
    </svg>
  );
}
