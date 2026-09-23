/**
 * Remembering where the student had got to.
 *
 * A raw scroll offset is not enough on its own: a chat grows a reply at the
 * bottom, a note gets rewritten above the fold, and the same number of pixels
 * then points somewhere else entirely. So each position is stored as an
 * anchor — the id of the block that was at the top of the viewport and how far
 * into it the fold sat — with the offset kept only as a fallback for content
 * that has no anchors.
 *
 * Positions live in localStorage, so they survive navigation, a reload and a
 * restart, and each chat and each note keeps its own.
 */

export type ScrollPosition = {
  /** Raw pixels, the fallback. */
  offset: number;
  /** `data-anchor` of the block at the top of the viewport. */
  anchor?: string;
  /** How far into that block the fold was, in pixels. */
  within?: number;
  /** For sanity-checking a stale entry against resized content. */
  height?: number;
  at: number;
};

const PREFIX = 'wa.scroll.';
/** Positions older than this are not worth restoring; the content has moved on. */
const MAX_AGE = 90 * 24 * 60 * 60 * 1000;
/** Nothing is remembered for a position that is essentially the top. */
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
    // A full or blocked localStorage loses the position, nothing else.
  }
}

export function forgetPosition(key: string): void {
  try {
    localStorage.removeItem(PREFIX + key);
  } catch {
    // ignore
  }
}

/** Read the current position out of a scroller, anchored where it can be. */
export function measure(scroller: HTMLElement): Omit<ScrollPosition, 'at'> {
  const offset = scroller.scrollTop;
  const top = scroller.getBoundingClientRect().top;
  const blocks = scroller.querySelectorAll<HTMLElement>('[data-anchor]');
  let anchor: string | undefined;
  let within: number | undefined;
  for (const block of blocks) {
    const box = block.getBoundingClientRect();
    // The block the fold is inside, or the first one below it.
    if (box.bottom > top) {
      anchor = block.dataset.anchor;
      within = Math.max(0, Math.round(top - box.top));
      break;
    }
  }
  return { offset, anchor, within, height: scroller.scrollHeight };
}

/** Put a scroller back where it was. Returns whether it found its place. */
export function restore(scroller: HTMLElement, position: ScrollPosition): boolean {
  if (position.anchor) {
    const block = scroller.querySelector<HTMLElement>(`[data-anchor="${CSS.escape(position.anchor)}"]`);
    if (block) {
      const delta = block.getBoundingClientRect().top - scroller.getBoundingClientRect().top;
      scroller.scrollTop += delta + (position.within ?? 0);
      return true;
    }
  }
  // No anchor survived — the content changed shape. The raw offset is a worse
  // guess but a better one than jumping to the top.
  const max = Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  scroller.scrollTop = Math.min(position.offset, max);
  return false;
}

/**
 * Keep `key`'s position in step with a scroller.
 *
 * Saving is throttled and done on a rested scroll, so dragging through a long
 * note does not write to storage on every frame.
 */
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
      // Leaving the view is exactly when the position matters most.
      savePosition(key, measure(scroller));
    }
  };
}

/**
 * Restore once the content has actually been laid out.
 *
 * Markdown, KaTeX and images all change the height after the first paint, so
 * restoring on mount alone lands in the wrong place. This retries while the
 * height is still moving, and gives up quickly rather than fighting the user
 * if they start scrolling themselves.
 */
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
    // Settled: two frames at the same height means the layout has stopped.
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

/**
 * Give every top-level block in a container a stable anchor.
 *
 * Rendered Markdown has no ids of its own, so the anchor is a short hash of
 * the block's own text. Editing further up the note does not change a
 * paragraph's own words, which is exactly the property the anchor needs.
 */
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

/** A short, stable, non-cryptographic hash (FNV-1a). */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(36);
}
