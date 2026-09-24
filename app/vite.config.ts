import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', headers: { origin: '' } },
      '/wa-img': { target: 'https://www.webassign.net', changeOrigin: true, rewrite: (p) => p.replace(/^\/wa-img/, '') },
    },
  },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
});
