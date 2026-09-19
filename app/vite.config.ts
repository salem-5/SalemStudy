import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Tauri expects a fixed dev port.
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
    // Dev-only (?live): reach the real bridge. It rejects browser Origins, so blank the header.
    proxy: {
      '/api': { target: 'http://127.0.0.1:8787', headers: { origin: '' } },
      // Same-origin copies of WebAssign images so lib/images.ts can inspect pixels.
      '/wa-img': { target: 'https://www.webassign.net', changeOrigin: true, rewrite: (p) => p.replace(/^\/wa-img/, '') },
    },
  },
  build: { target: 'es2022', outDir: 'dist', emptyOutDir: true },
});
