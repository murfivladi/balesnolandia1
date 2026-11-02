// Простые графики без библиотек: столбцы, линия с областью и горизонтальные полосы.
// Цвета берутся из темы (--accent, --brand), поэтому работают в светлой и тёмной теме.
import { useId } from 'react';
import { formatMoney } from '@bln/shared/money.js';

/** Столбцы по дням/часам. data: [{ label, value, hint }] */
export function BarChart({ data, height = 160, format = (v) => formatMoney(v), empty }) {
  const max = Math.max(1, ...data.map((d) => Number(d.value) || 0));
  if (!data.length) return <p className="muted small">{empty}</p>;
  return (
    <div className="chart">
      <div className="chart-bars" style={{ height }}>
        {data.map((d, i) => {
          const v = Number(d.value) || 0;
          return (
            <div key={`${d.label}-${i}`} className="bar-wrap" title={d.hint || `${d.label}: ${format(v)}`}>
              <div className="bar" style={{ height: `${Math.max(1, (v / max) * 100)}%` }} data-zero={v ? undefined : '1'} />
            </div>
          );
        })}
      </div>
      <div className="chart-labels">
        {data.map((d, i) => <span key={`${d.label}-l-${i}`}>{d.label}</span>)}
      </div>
    </div>
  );
}

/** Линия с заливкой (SVG). data: [{ label, value, hint }] */
export function LineChart({ data, height = 190, format = (v) => formatMoney(v), empty }) {
  const id = useId().replace(/:/g, '');
  if (!data.length) return <p className="muted small">{empty}</p>;
  const values = data.map((d) => Number(d.value) || 0);
  const max = Math.max(1, ...values);
  const step = data.length > 1 ? 100 / (data.length - 1) : 100;
  const pts = values.map((v, i) => [data.length > 1 ? i * step : 50, 100 - (v / max) * 92]);
  const line = pts.map(([x, y]) => `${x},${y}`).join(' ');
  const area = `0,100 ${line} 100,100`;
  const every = Math.max(1, Math.ceil(data.length / 8));
  return (
    <div className="chart">
      <div className="chart-line" style={{ height }}>
        <svg viewBox="0 0 100 100" preserveAspectRatio="none" role="img" aria-label="graph">
          <defs>
            <linearGradient id={`g${id}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
              <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
            </linearGradient>
          </defs>
          {[25, 50, 75].map((y) => <line key={y} x1="0" y1={y} x2="100" y2={y} className="grid-line" />)}
          <polygon points={area} fill={`url(#g${id})`} />
          <polyline points={line} fill="none" stroke="var(--accent)" strokeWidth="1.4" vectorEffect="non-scaling-stroke" />
          {pts.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="1.6" fill="var(--accent)" vectorEffect="non-scaling-stroke">
              <title>{`${data[i].hint || data[i].label}: ${format(values[i])}`}</title>
            </circle>
          ))}
        </svg>
      </div>
      <div className="chart-labels">
        {data.map((d, i) => <span key={i}>{i % every === 0 ? d.label : ''}</span>)}
      </div>
    </div>
  );
}

/** Горизонтальные полосы: категории, способы оплаты, источники. */
export function HBars({ data, format = (v) => formatMoney(v), empty }) {
  const max = Math.max(1, ...data.map((d) => Number(d.value) || 0));
  if (!data.length) return <p className="muted small">{empty}</p>;
  return (
    <div className="hbars">
      {data.map((d) => (
        <div key={d.label} className="hbar-row" title={`${d.label}: ${format(d.value)}`}>
          <span className="hbar-label">{d.label}</span>
          <span className="hbar-track"><span className="hbar-fill" style={{ width: `${Math.max(2, (Number(d.value) || 0) / max * 100)}%` }} /></span>
          <span className="hbar-value">{format(d.value)}</span>
        </div>
      ))}
    </div>
  );
}
