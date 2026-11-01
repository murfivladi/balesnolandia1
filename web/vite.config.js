import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';

// Четыре приложения — multi-page сборка под /balesnolandia/*.
// Маршрутизация внутри приложений по hash (#/...), поэтому shared hosting не нужен .htaccess.
export default defineConfig({
  base: '/balesnolandia/',
  plugins: [react()],
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    rollupOptions: {
      input: {
        index: resolve(import.meta.dirname, 'index.html'),
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
