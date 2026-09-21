import { useSyncExternalStore } from 'react';

/** Appearance: dark, light, or whatever the OS is using, plus an accent colour. */
export type ThemePref = 'system' | 'dark' | 'light';

const KEY = 'wa.theme';
const ACCENT_KEY = 'wa.accent';

/** Accent presets; '' is the default steel blue. */
export const ACCENTS: { name: string; color: string }[] = [
  { name: 'Steel', color: '' },
  { name: 'Blue', color: '#6aa6ff' },
  { name: 'Teal', color: '#5cc2b8' },
  { name: 'Green', color: '#98c379' },
  { name: 'Amber', color: '#d7a266' },
  { name: 'Orange', color: '#e5895a' },
  { name: 'Rose', color: '#e38aa0' },
  { name: 'Violet', color: '#b59ad8' },
];
const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
const listeners = new Set<() => void>();

export function themePref(): ThemePref {
  try {
    const v = localStorage.getItem(KEY);
    if (v === 'dark' || v === 'light' || v === 'system') return v;
  } catch { /* storage unavailable */ }
  return 'dark';
}

const resolved = (p: ThemePref) => (p === 'system' ? (media?.matches ? 'light' : 'dark') : p);

export function accentPref(): string {
  try {
    const v = localStorage.getItem(ACCENT_KEY) ?? '';
    return /^#[0-9a-f]{6}$/i.test(v) ? v : '';
  } catch { return ''; }
}

function apply() {
  const root = document.documentElement;
  const t = resolved(themePref());
  root.dataset.theme = t;
  root.style.colorScheme = t;
  // A custom accent is one variable; styles.css derives the rest from it for each theme.
  const accent = accentPref();
  if (accent) { root.dataset.accent = ''; root.style.setProperty('--accent-user', accent); }
  else { delete root.dataset.accent; root.style.removeProperty('--accent-user'); }
}

function changed() {
  const root = document.documentElement;
  // Fade colours across the switch instead of snapping.
  root.classList.add('theme-switching');
  apply();
  window.setTimeout(() => root.classList.remove('theme-switching'), 350);
  listeners.forEach((l) => l());
}

export function setAccentPref(color: string) {
  try { localStorage.setItem(ACCENT_KEY, color); } catch { /* storage unavailable */ }
  changed();
}

export function setThemePref(p: ThemePref) {
  try { localStorage.setItem(KEY, p); } catch { /* storage unavailable */ }
  changed();
}

/** Call once at boot, before the first render. */
export function initTheme() {
  apply();
  media?.addEventListener('change', () => { if (themePref() === 'system') apply(); });
}

export const useThemePref = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, themePref);

export const useAccentPref = () => useSyncExternalStore((l) => { listeners.add(l); return () => listeners.delete(l); }, accentPref);
