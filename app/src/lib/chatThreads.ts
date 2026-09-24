import { studyApi, type ChatThread } from '../study/api';

const fresh = new Map<number, number>();
const FRESH_MS = 60_000;

export function markFresh(id: number) { fresh.set(id, Date.now()); }

export function dropEmpty(threads: ChatThread[], keep: number | null): ChatThread[] {
  const now = Date.now();
  const empty = threads.filter((t) => t.messageCount === 0 && t.id !== keep && now - (fresh.get(t.id) ?? 0) > FRESH_MS);
  for (const t of empty) void studyApi.chatDelete(t.id).catch(() => {});
  return empty.length ? threads.filter((t) => !empty.includes(t)) : threads;
}
