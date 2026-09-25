import { useEffect, useRef, useState } from 'react';
import { Copy, Minus, Square, X } from 'lucide-react';
import type { Window as TauriWindow } from '@tauri-apps/api/window';

/** How near the top of the window the pointer has to come to bring the controls out. */
const REVEAL_AT = 14;
/** How far the page moves down to make room for them (styles/shell.css, [data-titlebar]). */
const STRIP = 40;
const HIDE_AFTER = 350;

const win = () => import('@tauri-apps/api/window').then(({ getCurrentWindow }) => getCurrentWindow());
const act = (fn: (w: TauriWindow) => Promise<void>) => { void win().then(fn).catch(() => {}); };

/**
 * The window's own controls on Windows, where it has no title bar (tauri.windows.conf.json). They
 * stay out of sight until the pointer reaches the top of the window, then the page slides down
 * and they appear in the strip it uncovers, which also drags the window. Moving away tucks them
 * back in.
 */
export function WindowBar() {
  const [shown, setShown] = useState(false);
  const [maximised, setMaximised] = useState(false);
  const hide = useRef(0);

  useEffect(() => {
    const root = document.documentElement;
    if (shown) root.dataset.titlebar = '';
    else delete root.dataset.titlebar;
    return () => { delete root.dataset.titlebar; };
  }, [shown]);

  useEffect(() => {
    const later = () => { window.clearTimeout(hide.current); hide.current = window.setTimeout(() => setShown(false), HIDE_AFTER); };
    const onMove = (e: MouseEvent) => {
      if (e.clientY <= REVEAL_AT) { window.clearTimeout(hide.current); setShown(true); }
      else if (e.clientY <= STRIP + 8) window.clearTimeout(hide.current);
      else later();
    };
    const root = document.documentElement;
    window.addEventListener('mousemove', onMove);
    root.addEventListener('mouseleave', later);
    return () => {
      window.clearTimeout(hide.current);
      window.removeEventListener('mousemove', onMove);
      root.removeEventListener('mouseleave', later);
    };
  }, []);

  useEffect(() => {
    let off: (() => void) | undefined;
    let alive = true;
    void win().then(async (w) => {
      const sync = () => { void w.isMaximized().then((m) => { if (alive) setMaximised(m); }).catch(() => {}); };
      sync();
      off = await w.onResized(sync);
      if (!alive) off();
    }).catch(() => {});
    return () => { alive = false; off?.(); };
  }, []);

  return (
    <div className={`winbar${shown ? ' shown' : ''}`} role="toolbar" aria-label="Window">
      <button type="button" className="winbar-btn" onClick={() => act((w) => w.minimize())} title="Minimise" aria-label="Minimise"><Minus /></button>
      <button type="button" className="winbar-btn" onClick={() => act((w) => w.toggleMaximize())}
        title={maximised ? 'Restore' : 'Maximise'} aria-label={maximised ? 'Restore' : 'Maximise'}>
        {maximised ? <Copy className="winbar-restore" /> : <Square />}
      </button>
      <button type="button" className="winbar-btn close" onClick={() => act((w) => w.close())} title="Close" aria-label="Close"><X /></button>
    </div>
  );
}
