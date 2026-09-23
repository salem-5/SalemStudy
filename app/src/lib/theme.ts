import { useSyncExternalStore } from 'react';

/**
 * Appearance: a colour theme (or whatever the OS is using), a shape, and an
 * accent colour.
 *
 * A theme is a palette over one of two bases. The base — dark or light — is
 * what `data-theme` says, so every rule written for the light theme still
 * applies to Sepia and Latte; the palette (`data-palette`) only repaints the
 * surfaces, lines, text and accent on top. The shape is separate, so any
 * palette can be sharp or rounded.
 */

export type Palette = {
  id: string;
  name: string;
  base: 'dark' | 'light';
  /** For the picker's preview: background, panel, text, accent. */
  swatch: [string, string, string, string];
};

/**
 * 'dark' and 'light' keep their old ids (Graphite and Paper), so a theme
 * chosen before there were more of them still loads.
 */
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

/** A palette's id, or 'system' for Graphite or Paper following the OS. */
export type ThemePref = string;

/** Sharp is the app as it has always been; rounded softens every box a little. */
export type ShapePref = 'sharp' | 'rounded';

const KEY = 'wa.theme';
const ACCENT_KEY = 'wa.accent';
const SHAPE_KEY = 'wa.shape';

/** Accent presets; '' is the palette's own accent. */
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
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { /* storage unavailable */ } };

export function themePref(): ThemePref {
  const v = read(KEY);
  return v === 'system' || PALETTES.some((p) => p.id === v) ? v! : 'dark';
}

/** The palette actually showing: the chosen one, or the OS's pick of Graphite or Paper. */
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
  // A custom accent is one variable; styles.css derives the rest from it for each base.
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

export function setAccentPref(color: string) { write(ACCENT_KEY, color); changed(); }
export function setThemePref(p: ThemePref) { write(KEY, p); changed(); }
export function setShapePref(s: ShapePref) { write(SHAPE_KEY, s); changed(); }

/** Call once at boot, before the first render. */
export function initTheme() {
  apply();
  media?.addEventListener('change', () => { if (themePref() === 'system') changed(); });
}

const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };
export const useThemePref = () => useSyncExternalStore(subscribe, themePref);
export const useAccentPref = () => useSyncExternalStore(subscribe, accentPref);
export const useShapePref = () => useSyncExternalStore(subscribe, shapePref);
