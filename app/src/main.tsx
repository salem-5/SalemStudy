import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import Shell from './Shell';
import { installStudyMock } from './study/mockApi';
import { api, useHttpTransport } from './api';
import './wa-base.css';
import './styles.css';
import { initTheme } from './lib/theme';
import { inTabMode, installTabTransport, tabToken } from './lib/tabClient';
import { installTabHost } from './lib/tabHost';

initTheme();

function fatal(message: string) {
  const root = document.getElementById('root');
  if (root) {
    root.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'boot-error';
    box.textContent = message;
    root.append(box);
  }
}

async function boot() {
  // Served by the app's own tab-mode server: talk to it over HTTP instead of
  // through Tauri. Everything above this line is the same app.
  if (inTabMode()) {
    try {
      await installTabTransport(tabToken()!);
    } catch (e) {
      fatal(String(e instanceof Error ? e.message : e));
      return;
    }
  }
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
      const { installDevAi } = await import('./devAi');
      installDevAi();
    }
    installStudyMock();
  }
  // In the desktop app, stand ready to answer for any browser tabs.
  if ('__TAURI_INTERNALS__' in window && !inTabMode()) {
    void installTabHost().catch(() => {});
  }
  // Dev-only: VITE_SELFTEST=1 runs the in-app AI smoke test (src/devSelfTest.ts).
  if (import.meta.env.DEV && import.meta.env.VITE_SELFTEST === '1') {
    void import('./devSelfTest').then((m) => m.runSelfTest());
  }
  // Dev-only: VITE_SELFTEST=walk runs the page-walk benchmark on one source.
  if (import.meta.env.DEV && import.meta.env.VITE_SELFTEST === 'walk') {
    void import('./devSelfTest').then((m) => m.runWalkBenchmark(import.meta.env.VITE_SELFTEST_SOURCE ?? 'MSK'));
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      <Shell />
    </StrictMode>,
  );
}

boot();
