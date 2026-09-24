import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/**
 * One set of preferences for the window and every browser tab.
 *
 * Preferences live in the page's storage, and a tab is a different page on a
 * different origin — so a tab opened with its own theme, its own shape, its
 * own focus-timer settings. Now the app keeps one copy (`prefs.rs`), and this
 * mirrors it: at start-up the page takes the shared copy, every change to a
 * shared key is written back to it, and a change made on the other side is
 * applied here the moment it happens (`wa:prefs` tells the stores that hold
 * one in memory to read it again).
 *
 * Nothing above this file changes how it saves: storage writes are caught
 * where they happen.
 */

/** What stays with one page: where it is, its scroll, its caches, its key. */
const LOCAL = [
  /^wa\.tab\./, /^wa\.route$/, /^wa\.scroll\./, /^wa\.study\.mock/, /^wa\.preview\./,
  /^wa\.qcss\./, /^wa\.assignments\./, /^wa\.q\./, /^wa\.ai\.open$/, /^wa\.pad\.view$/,
];

export const isShared = (key: string) => key.startsWith('wa.') && !LOCAL.some((re) => re.test(key));

/** Which page made a change, so it can ignore its own echo. */
const SOURCE = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random());

let originalSet: ((k: string, v: string) => void) | null = null;
let originalRemove: ((k: string) => void) | null = null;
const pending = new Map<string, number>();

/** Write to storage without it being sent anywhere (a change that came from elsewhere). */
function quietly(key: string, value: string | null) {
  if (value === null) originalRemove?.call(localStorage, key);
  else originalSet?.call(localStorage, key, value);
}

/** Tell the stores that keep a copy in memory to read it again. */
function announce(key: string) {
  window.dispatchEvent(new CustomEvent('wa:prefs', { detail: { key } }));
}

/**
 * Send a change to the shared copy. Debounced per key: the focus timer, for
 * one, saves several times a second while it runs.
 */
function push(key: string) {
  const at = pending.get(key);
  if (at) window.clearTimeout(at);
  pending.set(key, window.setTimeout(() => {
    pending.delete(key);
    const value = localStorage.getItem(key);
    void invoke('prefs_set', { key, value, source: SOURCE }).catch(() => {});
  }, 300));
}

/**
 * Start mirroring. The window seeds the shared copy with what it already has
 * (the first run after this existed); a tab takes the shared copy as it is.
 * Either way the shared copy wins, so both sides start the same.
 */
export async function startPrefSync(role: 'window' | 'tab'): Promise<void> {
  if (originalSet) return;
  let shared: Record<string, string>;
  try {
    if (role === 'window') {
      const mine: Record<string, string> = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i)!;
        if (isShared(k)) mine[k] = localStorage.getItem(k) ?? '';
      }
      shared = await invoke<Record<string, string>>('prefs_seed', { prefs: mine });
    } else {
      shared = await invoke<Record<string, string>>('prefs_all');
    }
  } catch {
    return; // no shared copy to be had: carry on with this page's own
  }

  const proto = Object.getPrototypeOf(localStorage) as Storage;
  originalSet = proto.setItem;
  originalRemove = proto.removeItem;

  // Mirror: take every shared key, and drop shared keys the copy does not have.
  const here: string[] = [];
  for (let i = 0; i < localStorage.length; i++) here.push(localStorage.key(i)!);
  for (const k of here) if (isShared(k) && !(k in shared)) quietly(k, null);
  for (const [k, v] of Object.entries(shared)) if (localStorage.getItem(k) !== v) quietly(k, v);

  // From now on, a change to a shared key goes to the shared copy too.
  proto.setItem = function setItem(this: Storage, key: string, value: string) {
    originalSet!.call(this, key, value);
    if (this === localStorage && isShared(key)) push(key);
  };
  proto.removeItem = function removeItem(this: Storage, key: string) {
    originalRemove!.call(this, key);
    if (this === localStorage && isShared(key)) push(key);
  };

  await listen<{ key: string; value: string | null; source: string }>('prefs://changed', (e) => {
    const { key, value, source } = e.payload;
    if (source === SOURCE || !isShared(key)) return;
    if (localStorage.getItem(key) === value) return;
    quietly(key, value);
    announce(key);
  });

  // Anything that changed while this page was starting.
  for (const k of Object.keys(shared)) announce(k);
}

/** Subscribe a store to changes of its key made on the other side. */
export function onPrefChanged(match: (key: string) => boolean, fn: () => void): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('wa:prefs', (e) => {
    const key = (e as CustomEvent<{ key: string }>).detail?.key;
    if (key && match(key)) fn();
  });
}
