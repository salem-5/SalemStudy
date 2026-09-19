import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import { api, useHttpTransport } from './api';
import './wa-base.css';
import './styles.css';

async function boot() {
  // No native WebView context menu in the app chrome; the app supplies its own
  // menus. Text fields keep theirs so paste still works.
  document.addEventListener('contextmenu', (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea, [contenteditable="true"]')) return;
    e.preventDefault();
  });

  // Outside Tauri (plain `npm run dev` in a browser): ?live talks to the real
  // bridge through the Vite proxy, otherwise fixture data.
  if (import.meta.env.DEV && !('__TAURI_INTERNALS__' in window)) {
    if (new URLSearchParams(location.search).has('live')) {
      useHttpTransport();
      const info = { port: 8787, managed: false, processAlive: false, error: null, log: ['live dev mode: bridge started separately'] };
      Object.assign(api, { bridgeInfo: async () => info, restartBridge: async () => info });
    } else {
      const { installMock } = await import('./mock');
      installMock(api);
    }
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}

boot();
