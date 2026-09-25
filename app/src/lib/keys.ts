/** Whether this computer is a Mac, where shortcuts use ⌘ rather than Ctrl. */
export const isMac = typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

/** The key shortcuts are held with: ⌘ on a Mac, Ctrl everywhere else. */
export const MOD = isMac ? '⌘' : 'Ctrl';

/**
 * A shortcut as this computer writes it. Write it the Mac way ("⌘K", "⌘⇧P", "⌘↵") and elsewhere
 * it reads "Ctrl+K", "Ctrl+Shift+P", "Ctrl+Enter".
 */
export function keys(combo: string, mac = isMac): string {
  if (mac) return combo;
  return combo
    .replace(/⌘\s*/g, 'Ctrl+')
    .replace(/⌃\s*/g, 'Ctrl+')
    .replace(/⌥\s*/g, 'Alt+')
    .replace(/⇧\s*/g, 'Shift+')
    .replace(/↵/g, 'Enter');
}
