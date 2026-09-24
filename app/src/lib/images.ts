import { invoke } from '@tauri-apps/api/core';

export type ImageMode = 'invert' | 'keep';
type Loaded = { src: string; mode: ImageMode };

const cache = new Map<string, Promise<Loaded>>();
const inTauri = '__TAURI_INTERNALS__' in window;

async function sameOrigin(url: string): Promise<string> {
  if (inTauri) return invoke<string>('fetch_image', { url });
  const u = new URL(url);
  if (/(^|\.)webassign\.net$/.test(u.hostname)) return `/wa-img${u.pathname}${u.search}`;
  return url;
}

function decode(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error('image failed to load'));
    img.src = src;
  });
}

const lum = (r: number, g: number, b: number) => (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;

export function classify(img: HTMLImageElement): ImageMode {
  const scale = Math.min(1, 240 / Math.max(img.naturalWidth, img.naturalHeight, 1));
  const w = Math.max(1, Math.round(img.naturalWidth * scale));
  const h = Math.max(1, Math.round(img.naturalHeight * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return 'keep';
  ctx.drawImage(img, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);

  let edge = 0; let edgeLum = 0; let edgeClear = 0;
  const sample = (x: number, y: number) => {
    const i = (y * w + x) * 4;
    edge++;
    if (data[i + 3] < 40) { edgeClear++; return; }
    edgeLum += lum(data[i], data[i + 1], data[i + 2]);
  };
  for (let x = 0; x < w; x++) { sample(x, 0); sample(x, h - 1); }
  for (let y = 1; y < h - 1; y++) { sample(0, y); sample(w - 1, y); }

  const colors = new Set<number>();
  let inkLum = 0; let ink = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3] < 40) continue;
    colors.add(((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4));
    inkLum += lum(data[i], data[i + 1], data[i + 2]);
    ink++;
  }
  if (colors.size > 900) return 'keep';

  if (edgeClear / edge > 0.6) {
    return ink && inkLum / ink < 0.5 ? 'invert' : 'keep';
  }
  const opaque = edge - edgeClear;
  return opaque && edgeLum / opaque > 0.7 ? 'invert' : 'keep';
}

function load(url: string): Promise<Loaded> {
  let p = cache.get(url);
  if (!p) {
    p = sameOrigin(url)
      .then(async (src) => ({ src, mode: classify(await decode(src)) }))
      .catch(() => ({ src: url, mode: 'keep' as const }));
    cache.set(url, p);
  }
  return p;
}

export function adaptImage(img: HTMLImageElement) {
  const url = img.getAttribute('src');
  if (!url || img.dataset.adapted || /\/watex\/img\//.test(url) || url.startsWith('data:')) return;
  img.dataset.adapted = '1';
  img.classList.add('img-pending');
  load(url).then(({ src, mode }) => {
    img.src = src;
    img.classList.remove('img-pending');
    img.classList.add(mode === 'invert' ? 'img-invert' : 'img-keep');
    img.closest('.qfig')?.classList.add(mode === 'invert' ? 'qfig-invert' : 'qfig-keep');
  });
}

export function adaptImagesIn(root: ParentNode | null) {
  root?.querySelectorAll<HTMLImageElement>('img').forEach(adaptImage);
}

const KEEP_AS_IS = 700 * 1024;

const readAsDataUrl = (file: Blob) => new Promise<string>((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(String(r.result));
  r.onerror = () => reject(r.error);
  r.readAsDataURL(file);
});

export async function compactImage(file: File, max = 1600): Promise<string> {
  const original = await readAsDataUrl(file);
  const img = new Image();
  img.src = original;
  await img.decode();
  const big = Math.max(img.naturalWidth, img.naturalHeight);
  if (file.type === 'image/gif' || (big <= max && file.size <= KEEP_AS_IS)) return original;
  const scale = Math.min(1, max / big);
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(img.naturalWidth * scale);
  canvas.height = Math.round(img.naturalHeight * scale);
  canvas.getContext('2d')?.drawImage(img, 0, 0, canvas.width, canvas.height);
  const webp = canvas.toDataURL('image/webp', 0.86);
  const out = webp.startsWith('data:image/webp') ? webp
    : file.type === 'image/jpeg' ? canvas.toDataURL('image/jpeg', 0.86) : canvas.toDataURL('image/png');
  return out.length < original.length ? out : original;
}
