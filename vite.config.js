import { defineConfig } from 'vite';

export default defineConfig({
  base: process.env.VITE_BASE || '/volcanoview/',
  server: { host: true, port: 5174 },
  build: { outDir: 'dist', assetsDir: 'assets' },
});
