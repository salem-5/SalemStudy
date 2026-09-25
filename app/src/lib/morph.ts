import { flushSync } from 'react-dom';

type Transitioning = Document & { startViewTransition?: (update: () => void) => { finished: Promise<void> } };

/**
 * Makes a change of view with a view transition: the page is pictured before and after, and the
 * pictures move between the two - the sidebar sliding away or back, the page growing or shrinking
 * as one piece - instead of the layout reflowing frame by frame. The look is in styles/morph.css.
 * Without view transitions, or with reduced motion, the change just happens.
 */
export function morph(update: () => void): void {
  const doc = document as Transitioning;
  if (!doc.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) {
    update();
    return;
  }
  const root = document.documentElement;
  // The pictures stand in for the real layout while they move, so its own transitions stay still.
  root.dataset.morphing = '';
  const done = () => { delete root.dataset.morphing; };
  try {
    doc.startViewTransition(() => flushSync(update)).finished.then(done, done);
  } catch {
    done();
    update();
  }
}
