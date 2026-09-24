import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

const LOCAL = [
  /^wa\.tab\./, /^wa\.route$/, /^wa\.scroll\./, /^wa\.study\.mock/, /^wa\.preview\./,
  /^wa\.qcss\./, /^wa\.assignments\./, /^wa\.q\./, /^wa\.ai\.open$/, /^wa\.pad\.view$/,
];

export const isShared = (key: string) => key.startsWith('wa.') && !LOCAL.some((re) => re.test(key));

const SOURCE = typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : String(Math.random());

let originalSet: ((k: string, v: string) => void) | null = null;
let originalRemove: ((k: string) => void) | null = null;
const pending = new Map<string, number>();

function quietly(key: string, value: string | null) {
  if (value === null) originalRemove?.call(localStorage, key);
  else originalSet?.call(localStorage, key, value);
}

function announce(key: string) {
  window.dispatchEvent(new CustomEvent('wa:prefs', { detail: { key } }));
}

function push(key: string) {
  const at = pending.get(key);
  if (at) window.clearTimeout(at);
  pending.set(key, window.setTimeout(() => {
    pending.delete(key);
    const value = localStorage.getItem(key);
    void invoke('prefs_set', { key, value, source: SOURCE }).catch(() => {});
  }, 300));
}

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
    return;
  }

  const proto = Object.getPrototypeOf(localStorage) as Storage;
  originalSet = proto.setItem;
  originalRemove = proto.removeItem;

  const here: string[] = [];
  for (let i = 0; i < localStorage.length; i++) here.push(localStorage.key(i)!);
  for (const k of here) if (isShared(k) && !(k in shared)) quietly(k, null);
  for (const [k, v] of Object.entries(shared)) if (localStorage.getItem(k) !== v) quietly(k, v);

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

  for (const k of Object.keys(shared)) announce(k);
}

export function onPrefChanged(match: (key: string) => boolean, fn: () => void): void {
  if (typeof window === 'undefined') return;
  window.addEventListener('wa:prefs', (e) => {
    const key = (e as CustomEvent<{ key: string }>).detail?.key;
    if (key && match(key)) fn();
  });
}
