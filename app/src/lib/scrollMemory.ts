export type ScrollPosition = {
  offset: number;
  anchor?: string;
  within?: number;
  height?: number;
  at: number;
};

const PREFIX = 'wa.scroll.';
const MAX_AGE = 90 * 24 * 60 * 60 * 1000;
const MIN_OFFSET = 24;

export function loadPosition(key: string): ScrollPosition | null {
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (!raw) return null;
    const value = JSON.parse(raw) as ScrollPosition;
    if (!value || typeof value.offset !== 'number') return null;
    if (Date.now() - (value.at ?? 0) > MAX_AGE) {
      localStorage.removeItem(PREFIX + key);
      return null;
    }
    return value;
  } catch {
    return null;
  }
}

export function savePosition(key: string, position: Omit<ScrollPosition, 'at'>): void {
  try {
    if (position.offset < MIN_OFFSET && !position.anchor) {
      localStorage.removeItem(PREFIX + key);
      return;
    }
    localStorage.setItem(PREFIX + key, JSON.stringify({ ...position, at: Date.now() }));
  } catch {
  }
}

export function forgetPosition(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
  }
}

export function measure(scroller: HTMLElement): Omit<ScrollPosition, 'at'> {
  const offset = scroller.scrollTop;
  const top = scroller.getBoundingClientRect().top;
  const blocks = scroller.querySelectorAll<HTMLElement>('[data-anchor]');
  let anchor: string | undefined;
  let within: number | undefined;
  for (const block of blocks) {
    const box = block.getBoundingClientRect();
    if (box.bottom > top) {
      anchor = block.dataset.anchor;
      within = Math.max(0, Math.round(top - box.top));
      break;
    }
  }
  return { offset, anchor, within, height: scroller.scrollHeight };
}

export function restore(scroller: HTMLElement, position: ScrollPosition): boolean {
  if (position.anchor) {
    const block = scroller.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(position.anchor)}"]`);
    if (block) {
      const delta = block.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop += delta + (position.within ?? 0);
      return true;
    }
  }
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  scroller.scrollTop = Math.min(position.offset, max);
  return false;
}

export function watch(scroller: HTMLElement, key: string, idleMs = 250): () => void {
  let timer: number | null = null;
  const onScroll = () => {
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => {
      timer = null;
      savePosition(key, measure(scroller));
    }, idleMs);
  };
  scroller.addEventListener('scroll', onScroll, { passive: true });
  return () => {
    scroller.removeEventListener('scroll', onScroll);
    if (timer !== null) {
      window.clearTimeout(timer);
      savePosition(key, measure(scroller));
    }
  };
}

export function restoreWhenReady(scroller: HTMLElement, position: ScrollPosition, tries = 12): () => void {
  let cancelled = false;
  let lastHeight = -1;
  let attempt = 0;
  let raf = 0;
  const onUserScroll = () => { cancelled = true; };
  scroller.addEventListener('wheel', onUserScroll, { passive: true, once: true });
  scroller.addEventListener('touchstart', onUserScroll, { passive: true, once: true });

  const step = () => {
    if (cancelled || attempt >= tries) return;
    attempt += 1;
    const height = scroller.scrollHeight;
    restore(scroller, position);
    if (height === lastHeight && attempt > 1) return;
    lastHeight = height;
    raf = window.requestAnimationFrame(() => window.setTimeout(step, 40));
  };
  raf = window.requestAnimationFrame(step);

  return () => {
    cancelled = true;
    window.cancelAnimationFrame(raf);
    scroller.removeEventListener('wheel', onUserScroll);
    scroller.removeEventListener('touchstart', onUserScroll);
  };
}

export function tagAnchors(container: HTMLElement): void {
  const seen = new Map<string, number>();
  for (const block of Array.from(container.children) as HTMLElement[]) {
    const text = (block.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 80);
    if (!text) {
      delete block.dataset.anchor;
      continue;
    }
    const base = hash(text);
    const n = (seen.get(base) ?? 0) + 1;
    seen.set(base, n);
    block.dataset.anchor = n === 1 ? base : `${base}-${n}`;
  }
}

function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
