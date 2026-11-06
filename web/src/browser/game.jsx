// «Курьер БалНета» — мини-игра для офлайн-страницы и страницы обслуживания.
// Курьер ловит падающие влодики и пакеты данных и уворачивается от битых пакетов «404».
import { useEffect, useRef, useState } from 'react';

const W = 360;
const H = 220;
const BEST_KEY = 'bln_courier_best';

function readBest() {
  try { return Number(localStorage.getItem(BEST_KEY)) || 0; } catch { return 0; }
}
function writeBest(v) {
  try { localStorage.setItem(BEST_KEY, String(v)); } catch { /* приватный режим */ }
}

export function CourierGame() {
  const canvas = useRef(null);
  const [state, setState] = useState({ phase: 'ready', score: 0, best: readBest() });
  const input = useRef({ left: false, right: false, pointerX: null });
  const phaseRef = useRef('ready');

  useEffect(() => {
    const onKey = (down) => (e) => {
      // Клавиши перехватываем только во время игры или когда фокус на поле — иначе не мешаем вводу.
      if (phaseRef.current !== 'play' && document.activeElement !== canvas.current) return;
      if (e.key === 'ArrowLeft' || e.key === 'a') { input.current.left = down; e.preventDefault(); }
      if (e.key === 'ArrowRight' || e.key === 'd') { input.current.right = down; e.preventDefault(); }
      if (down && (e.key === ' ' || e.key === 'Enter') && phaseRef.current !== 'play' && document.activeElement === canvas.current) {
        e.preventDefault();
        start();
      }
    };
    const kd = onKey(true); const ku = onKey(false);
    window.addEventListener('keydown', kd);
    window.addEventListener('keyup', ku);
    return () => { window.removeEventListener('keydown', kd); window.removeEventListener('keyup', ku); };
  });

  const loop = useRef(null);
  useEffect(() => () => cancelAnimationFrame(loop.current), []);

  function start() {
    cancelAnimationFrame(loop.current);
    phaseRef.current = 'play';
    const ctx = canvas.current.getContext('2d');
    const dark = document.documentElement.dataset.theme === 'dark';
    const g = { x: W / 2, items: [], score: 0, lives: 3, t: 0, spawn: 0, speed: 1.4, hit: 0 };
    setState((s) => ({ ...s, phase: 'play', score: 0 }));
    let last = performance.now();

    const frame = (now) => {
      const dt = Math.min(48, now - last) / 16.67;
      last = now;
      g.t += dt;
      const inp = input.current;
      if (inp.pointerX != null) g.x += Math.max(-7 * dt, Math.min(7 * dt, inp.pointerX - g.x));
      if (inp.left) g.x -= 6 * dt;
      if (inp.right) g.x += 6 * dt;
      g.x = Math.max(18, Math.min(W - 18, g.x));
      g.speed = 1.4 + g.score / 400;

      g.spawn -= dt;
      if (g.spawn <= 0) {
        const r = Math.random();
        const kind = r < 0.22 + Math.min(0.2, g.score / 2000) ? 'bad' : r < 0.85 ? 'coin' : 'packet';
        g.items.push({ x: 14 + Math.random() * (W - 28), y: -12, kind, v: g.speed * (0.8 + Math.random() * 0.6) });
        g.spawn = Math.max(14, 40 - g.score / 25);
      }

      for (const it of g.items) it.y += it.v * dt;
      const caught = [];
      for (const it of g.items) {
        if (it.y > H - 40 && it.y < H - 14 && Math.abs(it.x - g.x) < 24) caught.push(it);
      }
      for (const it of caught) {
        it.done = true;
        if (it.kind === 'coin') g.score += 10;
        else if (it.kind === 'packet') g.score += 25;
        else { g.lives -= 1; g.hit = 20; }
      }
      g.items = g.items.filter((it) => !it.done && it.y < H + 20);
      if (g.hit > 0) g.hit -= dt;

      // Рисование
      ctx.fillStyle = dark ? '#171b24' : '#f4f6fa';
      ctx.fillRect(0, 0, W, H);
      ctx.fillStyle = dark ? '#2c3342' : '#dfe3eb';
      ctx.fillRect(0, H - 12, W, 12);
      ctx.font = 'bold 12px system-ui, sans-serif';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      for (const it of g.items) {
        if (it.kind === 'coin') {
          ctx.fillStyle = '#d9b44a'; ctx.beginPath(); ctx.arc(it.x, it.y, 9, 0, Math.PI * 2); ctx.fill();
          ctx.fillStyle = '#5c4507'; ctx.fillText('В', it.x, it.y + 1);
        } else if (it.kind === 'packet') {
          ctx.fillStyle = '#1f4fbf'; ctx.fillRect(it.x - 10, it.y - 8, 20, 16);
          ctx.fillStyle = '#fff'; ctx.fillText('✉', it.x, it.y + 1);
        } else {
          ctx.fillStyle = '#c62828'; ctx.fillRect(it.x - 13, it.y - 8, 26, 16);
          ctx.fillStyle = '#fff'; ctx.font = 'bold 10px system-ui, sans-serif'; ctx.fillText('404', it.x, it.y + 1);
          ctx.font = 'bold 12px system-ui, sans-serif';
        }
      }
      // Курьер: корзина на самокате
      const blink = g.hit > 0 && Math.floor(g.hit / 3) % 2 === 0;
      if (!blink) {
        ctx.fillStyle = '#0f766e'; ctx.fillRect(g.x - 20, H - 34, 40, 14);
        ctx.fillStyle = dark ? '#e8ebf2' : '#121826';
        ctx.beginPath(); ctx.arc(g.x - 13, H - 16, 4, 0, Math.PI * 2); ctx.arc(g.x + 13, H - 16, 4, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = '#b8901f'; ctx.fillRect(g.x - 3, H - 46, 6, 12);
      }
      ctx.textAlign = 'left';
      ctx.fillStyle = dark ? '#e8ebf2' : '#121826';
      ctx.fillText(`Очки: ${g.score}`, 8, 12);
      ctx.textAlign = 'right';
      ctx.fillStyle = '#c62828';
      ctx.fillText('♥'.repeat(Math.max(0, g.lives)), W - 8, 12);

      if (g.lives <= 0) {
        phaseRef.current = 'over';
        const best = Math.max(readBest(), g.score);
        writeBest(best);
        setState({ phase: 'over', score: g.score, best });
        return;
      }
      loop.current = requestAnimationFrame(frame);
    };
    loop.current = requestAnimationFrame(frame);
  }

  const setPointer = (e) => {
    const rect = canvas.current.getBoundingClientRect();
    input.current.pointerX = ((e.clientX - rect.left) / rect.width) * W;
  };

  return (
    <div className="bp-game">
      <canvas
        ref={canvas}
        width={W}
        height={H}
        tabIndex={0}
        aria-label="Игра «Курьер БалНета»: ловите влодики и пакеты, избегайте блоков 404. Стрелки или палец — движение."
        onPointerMove={(e) => phaseRef.current === 'play' && setPointer(e)}
        onPointerDown={(e) => { if (phaseRef.current !== 'play') start(); else setPointer(e); }}
        onPointerLeave={() => { input.current.pointerX = null; }}
      />
      {state.phase !== 'play' && (
        <div className="bp-game-overlay">
          {state.phase === 'over' && <b>Доставка сорвана! Очки: {state.score}</b>}
          <span>Ловите <b style={{ color: '#b8901f' }}>влодики</b> и <b style={{ color: '#1f4fbf' }}>пакеты</b>, избегайте <b style={{ color: '#c62828' }}>404</b>.</span>
          <button className="bp-btn bp-btn-primary" onClick={() => { canvas.current.focus(); start(); }}>{state.phase === 'over' ? 'Ещё раз' : 'Играть'}</button>
          <span className="bp-muted">Рекорд: {state.best}</span>
        </div>
      )}
    </div>
  );
}
