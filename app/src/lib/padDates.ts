export type Dated = { pinned: boolean; updatedAt: number };

const startOfDay = (t: number) => { const d = new Date(t); d.setHours(0, 0, 0, 0); return d.getTime(); };
const DAY = 86_400_000;

export function groupLabel(t: number, now = Date.now()): string {
  const today = startOfDay(now);
  if (t >= today) return 'Today';
  if (t >= today - DAY) return 'Yesterday';
  if (t >= today - 7 * DAY) return 'Previous 7 Days';
  if (t >= today - 30 * DAY) return 'Previous 30 Days';
  const d = new Date(t);
  const month = d.toLocaleString(undefined, { month: 'long' });
  return d.getFullYear() === new Date(now).getFullYear() ? month : `${month} ${d.getFullYear()}`;
}

export function groupNotes<T extends Dated>(notes: T[], now = Date.now()): { label: string; notes: T[] }[] {
  const groups: { label: string; notes: T[] }[] = [];
  const add = (label: string, n: T) => {
    const g = groups.find((x) => x.label === label);
    if (g) g.notes.push(n); else groups.push({ label, notes: [n] });
  };
  const pinned = notes.filter((n) => n.pinned).sort((a, b) => b.updatedAt - a.updatedAt);
  const rest = notes.filter((n) => !n.pinned).sort((a, b) => b.updatedAt - a.updatedAt);
  for (const n of pinned) add('Pinned', n);
  for (const n of rest) add(groupLabel(n.updatedAt, now), n);
  return groups;
}

export function rowDate(t: number, now = Date.now()): string {
  const today = startOfDay(now);
  const d = new Date(t);
  if (t >= today) return d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  if (t >= today - DAY) return 'Yesterday';
  if (t >= today - 6 * DAY) return d.toLocaleDateString(undefined, { weekday: 'long' });
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'numeric', year: '2-digit' });
}

export const headerDate = (t: number) => {
  const d = new Date(t);
  return `${d.toLocaleDateString(undefined, { day: 'numeric', month: 'long', year: 'numeric' })} at ${d.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })}`;
};
