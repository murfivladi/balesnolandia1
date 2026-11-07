import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Multi-page сборка: / (ВлодБраузер), /apps/ (выбор приложения), /bank/, /pos/, /services/, /admin/.
// Cloudflare Pages: сайт в корне bln.vladislavb.qzz.io; другой путь — через BASE_PATH.
// Маршрутизация внутри приложений по hash (#/...), поэтому перенаправления не нужны.
export default defineConfig({
  base: process.env.BASE_PATH || '/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
        apps: resolve(import.meta.dirname, 'apps/index.html'),
        reg: resolve(import.meta.dirname, 'reg/index.html'),
        hosting: resolve(import.meta.dirname, 'hosting/index.html'),
        ca: resolve(import.meta.dirname, 'ca/index.html'),
        nalog: resolve(import.meta.dirname, 'nalog/index.html'),
        bank: resolve(import.meta.dirname, 'bank/index.html'),
        pos: resolve(import.meta.dirname, 'pos/index.html'),
        services: resolve(import.meta.dirname, 'services/index.html'),
        admin: resolve(import.meta.dirname, 'admin/index.html'),
      },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': 'http://127.0.0.1:3100',
      '/ws': { target: 'ws://127.0.0.1:3100', ws: true },
    },
  },
});
