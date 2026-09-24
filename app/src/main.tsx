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
import { TabModeGate } from './components/TabMode';
import { startPrefSync } from './lib/prefSync';

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
  const isTab = inTabMode();
  const isDesktop = '__TAURI_INTERNALS__' in window && !isTab;
  if (isTab) {
    try {
      await installTabTransport(tabToken()!);
    } catch (e) {
      fatal(String(e instanceof Error ? e.message : e));
      return;
    }
  }
  if (isDesktop || isTab) {
    await startPrefSync(isTab ? 'tab' : 'window').catch(() => {});
  }
  document.addEventListener('contextmenu', (e) => {
    const t = e.target as HTMLElement | null;
    if (t?.closest('input, textarea, [contenteditable="true"]')) return;
    e.preventDefault();
  });

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
  if (isDesktop) {
    void installTabHost().catch(() => {});
  }
  if (import.meta.env.DEV && import.meta.env.VITE_SELFTEST === '1') {
    void import('./devSelfTest').then((m) => m.runSelfTest());
  }
  if (import.meta.env.DEV && import.meta.env.VITE_SELFTEST === 'walk') {
    void import('./devSelfTest').then((m) => m.runWalkBenchmark(import.meta.env.VITE_SELFTEST_SOURCE ?? 'MSK'));
  }
  createRoot(document.getElementById('root')!).render(
    <StrictMode>
      {isDesktop
        ? <TabModeGate><Shell /></TabModeGate>
        : <Shell />}
    </StrictMode>,
  );
}

boot();
