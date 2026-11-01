// Маршрутизация по hash (#/path) — работает на любом хостинге без перенаправлений.
import { useEffect, useState } from 'react';

function current() {
  const h = location.hash.replace(/^#/, '') || '/';
  const [path, query = ''] = h.split('?');
  return { path: path || '/', query: Object.fromEntries(new URLSearchParams(query)) };
}

export function useRoute() {
  const [r, setR] = useState(current);
  useEffect(() => {
    const on = () => setR(current());
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return r;
}

export function navigate(path) {
  const target = path.startsWith('#') ? path : `#${path}`;
  if (location.hash === target) window.dispatchEvent(new HashChangeEvent('hashchange'));
  else location.hash = target;
}

/** match('/accounts/:id', '/accounts/5') → { id: '5' } | null */
export function match(pattern, path) {
  const p = pattern.split('/').filter(Boolean);
  const s = path.split('/').filter(Boolean);
  if (p.length !== s.length) return null;
  const out = {};
  for (let i = 0; i < p.length; i++) {
    if (p[i].startsWith(':')) out[p[i].slice(1)] = decodeURIComponent(s[i]);
    else if (p[i] !== s[i]) return null;
  }
  return out;
}

/** Выбор страницы по списку [pattern, render]. */
export function pick(routes, path) {
  for (const [pattern, render] of routes) {
    const params = pattern === '*' ? {} : match(pattern, path);
    if (params) return render(params);
  }
  return null;
}
