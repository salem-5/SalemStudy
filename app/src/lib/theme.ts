import { useSyncExternalStore } from 'react';

export type Palette = {
  id: string;
  name: string;
  base: 'dark' | 'light';
  swatch: [string, string, string, string];
};

export const PALETTES: Palette[] = [
  { id: 'dark', name: 'Graphite', base: 'dark', swatch: ['#0e1012', '#1a1d21', '#d7dce0', '#8fb3d1'] },
  { id: 'midnight', name: 'Midnight', base: 'dark', swatch: ['#0b1020', '#18203a', '#d5dbf0', '#7aa2f7'] },
  { id: 'nord', name: 'Nord', base: 'dark', swatch: ['#242933', '#343b48', '#e5e9f0', '#88c0d0'] },
  { id: 'mocha', name: 'Mocha', base: 'dark', swatch: ['#11111b', '#232336', '#cdd6f4', '#cba6f7'] },
  { id: 'forest', name: 'Forest', base: 'dark', swatch: ['#0d1411', '#1a2721', '#d6e2da', '#7fc8a0'] },
  { id: 'rose', name: 'Rosé', base: 'dark', swatch: ['#15131f', '#26233a', '#e0def4', '#ebbcba'] },
  { id: 'light', name: 'Paper', base: 'light', swatch: ['#f6f6f3', '#ffffff', '#1c2025', '#2c69a3'] },
  { id: 'mist', name: 'Mist', base: 'light', swatch: ['#f1f4f8', '#ffffff', '#17222d', '#0f7c80'] },
  { id: 'latte', name: 'Latte', base: 'light', swatch: ['#eff1f5', '#f7f8fb', '#4c4f69', '#8839ef'] },
  { id: 'sepia', name: 'Sepia', base: 'light', swatch: ['#f4ecd8', '#fbf6ea', '#3b2f22', '#8a5a2b'] },
];

export type ThemePref = string;

export type ShapePref = 'sharp' | 'rounded';

const KEY = 'wa.theme';
const ACCENT_KEY = 'wa.accent';
const SHAPE_KEY = 'wa.shape';

export const ACCENTS: { name: string; color: string }[] = [
  { name: 'Theme', color: '' },
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

const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { } };

export function themePref(): ThemePref {
  const v = read(KEY);
  return v === 'system' || PALETTES.some((p) => p.id === v) ? v! : 'dark';
}

export const paletteOf = (p: ThemePref): Palette =>
  PALETTES.find((x) => x.id === (p === 'system' ? (media?.matches ? 'light' : 'dark') : p)) ?? PALETTES[0];

export function accentPref(): string {
  const v = read(ACCENT_KEY) ?? '';
  return /^#[0-9a-f]{6}$/i.test(v) ? v : '';
}

export function shapePref(): ShapePref {
  return read(SHAPE_KEY) === 'rounded' ? 'rounded' : 'sharp';
}

function apply() {
  const root = document.documentElement;
  const palette = paletteOf(themePref());
  root.dataset.theme = palette.base;
  root.dataset.palette = palette.id;
  root.style.colorScheme = palette.base;
  root.dataset.shape = shapePref();
  const accent = accentPref();
  if (accent) { root.dataset.accent = ''; root.style.setProperty('--accent-user', accent); }
  else { delete root.dataset.accent; root.style.removeProperty('--accent-user'); }
}

function changed() {
  const root = document.documentElement;
  root.classList.add('theme-switching');
  apply();
  window.setTimeout(() => root.classList.remove('theme-switching'), 350);
  listeners.forEach((l) => l());
}

export function setAccentPref(color: string) { write(ACCENT_KEY, color); changed(); }
export function setThemePref(p: ThemePref) { write(KEY, p); changed(); }
export function setShapePref(s: ShapePref) { write(SHAPE_KEY, s); changed(); }


const onShared = (keys: string[], fn: () => void) => {
  if (typeof window === 'undefined') return;
  window.addEventListener('wa:prefs', (e) => {
    if (keys.includes((e as CustomEvent<{ key: string }>).detail?.key)) fn();
  });
};

export function initTheme() {
  apply();
  onShared([KEY, ACCENT_KEY, SHAPE_KEY], changed);
  media?.addEventListener('change', () => { if (themePref() === 'system') changed(); });
}

const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };
export const useThemePref = () => useSyncExternalStore(subscribe, themePref);
export const useAccentPref = () => useSyncExternalStore(subscribe, accentPref);
export const useShapePref = () => useSyncExternalStore(subscribe, shapePref);
