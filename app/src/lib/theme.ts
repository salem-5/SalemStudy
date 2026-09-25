import { useSyncExternalStore } from 'react';

export type Palette = {
  id: 'light' | 'dark';
  name: string;
  base: 'dark' | 'light';
  swatch: [string, string, string, string];
};

// Appearance is light, dark, or whatever the system is set to. The colours themselves live in
// styles/tokens.css; these swatches only draw the little previews in Settings.
export const PALETTES: Palette[] = [
  { id: 'light', name: 'Light', base: 'light', swatch: ['#EFEFED', '#FFFFFF', '#1D1D1F', '#1D1D1F'] },
  { id: 'dark', name: 'Dark', base: 'dark', swatch: ['#161618', '#232327', '#ECECEF', '#F2F2F4'] },
];

export type ThemePref = 'system' | Palette['id'];

const KEY = 'wa.theme';
const ACCENT_KEY = 'wa.accent';

// Themes from earlier versions, folded into light or dark so nobody is left on a theme that no longer exists.
const LEGACY_LIGHT = ['paper', 'mist', 'latte', 'sepia'];
const LEGACY_DARK = ['graphite', 'midnight', 'nord', 'mocha', 'forest', 'rose'];

export const ACCENTS: { name: string; color: string }[] = [
  { name: 'Ink', color: '' },
  { name: 'Clay', color: '#D97757' },
  { name: 'Blue', color: '#0A84FF' },
  { name: 'Indigo', color: '#5E5CE6' },
  { name: 'Teal', color: '#12A594' },
  { name: 'Green', color: '#30A46C' },
  { name: 'Pink', color: '#E54D9E' },
  { name: 'Purple', color: '#8E4EC6' },
];

const media = typeof matchMedia === 'function' ? matchMedia('(prefers-color-scheme: light)') : null;
const listeners = new Set<() => void>();

const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
const write = (key: string, value: string) => { try { localStorage.setItem(key, value); } catch { } };

export function themePref(): ThemePref {
  const v = read(KEY);
  if (v === 'system' || v === 'light' || v === 'dark') return v;
  if (v && LEGACY_LIGHT.includes(v)) return 'light';
  if (v && LEGACY_DARK.includes(v)) return 'dark';
  return 'system';
}

export const paletteOf = (p: ThemePref): Palette =>
  PALETTES.find((x) => x.id === (p === 'system' ? (media?.matches ? 'light' : 'dark') : p)) ?? PALETTES[1];

export function accentPref(): string {
  const v = read(ACCENT_KEY) ?? '';
  return /^#[0-9a-f]{6}$/i.test(v) ? v : '';
}

type Rgb = [number, number, number];
const rgbOf = (hex: string): Rgb => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)) as Rgb;
const hexOf = (c: Rgb) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a: Rgb, b: Rgb, t: number): Rgb => [0, 1, 2].map((i) => a[i] + (b[i] - a[i]) * t) as Rgb;
const luminance = ([r, g, b]: Rgb) => {
  const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
};
const contrast = (a: Rgb, b: Rgb) => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

const WHITE: Rgb = [255, 255, 255];
const INK: Rgb = [17, 17, 20];
const BG: Record<Palette['base'], Rgb> = { light: [251, 251, 250], dark: [28, 28, 31] };

/**
 * A picked accent has two jobs that want different shades: as text and icons it must stay
 * readable on the page, and as a button it must carry its label. So the text shade is pushed
 * towards black (or white, in dark) until it reads, and the button keeps the colour as picked
 * with whichever of white or ink stands out on it.
 */
export function accentTones(hex: string, base: Palette['base']) {
  const picked = rgbOf(hex);
  const bg = BG[base];
  const toward = base === 'light' ? INK : WHITE;
  let text = picked;
  for (let t = 0; t <= 1 && contrast(text, bg) < 4.6; t += 0.04) text = mix(picked, toward, t);
  const on = contrast(WHITE, picked) >= contrast(INK, picked) ? WHITE : INK;
  const alpha = (a: number) => `rgba(${picked.map(Math.round).join(', ')}, ${a})`;
  return {
    '--accent': hexOf(text),
    '--accent-2': hexOf(mix(text, toward, 0.18)),
    '--accent-fill': hex,
    '--accent-fill-2': hexOf(mix(picked, on === WHITE ? INK : WHITE, 0.1)),
    '--on-accent': hexOf(on),
    '--accent-wash': alpha(base === 'light' ? 0.08 : 0.1),
    '--accent-soft': alpha(base === 'light' ? 0.13 : 0.18),
    '--accent-dim': alpha(0.45),
    '--accent-ring': alpha(0.35),
  };
}

const ACCENT_VARS = Object.keys(accentTones('#000000', 'light'));

async function syncWindow(base: Palette['base']) {
  if (typeof window === 'undefined' || !('__TAURI_INTERNALS__' in window)) return;
  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    const win = getCurrentWindow();
    await win.setTheme(base);
    await win.setBackgroundColor(base === 'dark' ? '#161618' : '#EFEFED');
  } catch {
    // An older shell without the permission keeps its own title bar colour; nothing else depends on it.
  }
}

function apply() {
  const root = document.documentElement;
  const palette = paletteOf(themePref());
  root.dataset.theme = palette.base;
  root.style.colorScheme = palette.base;
  delete root.dataset.palette;
  delete root.dataset.shape;
  const accent = accentPref();
  if (accent) {
    root.dataset.accent = '';
    for (const [k, v] of Object.entries(accentTones(accent, palette.base))) root.style.setProperty(k, v);
  } else {
    delete root.dataset.accent;
    for (const k of ACCENT_VARS) root.style.removeProperty(k);
  }
  void syncWindow(palette.base);
}

function changed() {
  const root = document.documentElement;
  root.classList.add('theme-switching');
  apply();
  window.setTimeout(() => root.classList.remove('theme-switching'), 350);
  listeners.forEach((l) => l());
}

export function setAccentPref(color: string) { write(ACCENT_KEY, color); changed(); }

const LOOK_KEY = 'wa.look';
const LOOK = '2';

/**
 * The first run of the redesigned look puts everyone back on the first accent: the old accents
 * were picked against colours that no longer exist. Call it once prefs have synced, so the reset
 * reaches the shared store instead of being overwritten by it.
 */
export function resetAccentForNewLook() {
  if (read(LOOK_KEY) === LOOK) return;
  write(LOOK_KEY, LOOK);
  if (read(ACCENT_KEY)) { write(ACCENT_KEY, ''); changed(); }
}
export function setThemePref(p: ThemePref) { write(KEY, p); changed(); }

const onShared = (keys: string[], fn: () => void) => {
  if (typeof window === 'undefined') return;
  window.addEventListener('wa:prefs', (e) => {
    if (keys.includes((e as CustomEvent<{ key: string }>).detail?.key)) fn();
  });
};

export function initTheme() {
  apply();
  onShared([KEY, ACCENT_KEY], changed);
  media?.addEventListener('change', () => { if (themePref() === 'system') changed(); });
}

const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };
export const useThemePref = () => useSyncExternalStore(subscribe, themePref);
export const useAccentPref = () => useSyncExternalStore(subscribe, accentPref);
