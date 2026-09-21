import { studyApi, type ChatThread } from '../study/api';

/**
 * Empty chats (a new chat never sent, or one that was cleared) are dropped
 * once you are on another chat. A chat created a moment ago is still empty
 * while its first message is being saved, so fresh ones are left alone.
 */
const fresh = new Map<number, number>();
const FRESH_MS = 60_000;

/** Call when a chat is created for a message about to be sent. */
export function markFresh(id: number) { fresh.set(id, Date.now()); }

/** Delete empty chats other than `keep` (and fresh ones); returns the ones left. */
export function dropEmpty(threads: ChatThread[], keep: number | null): ChatThread[] {
  const now = Date.now();
  const empty = threads.filter((t) => t.messageCount === 0 && t.id !== keep && now - (fresh.get(t.id) ?? 0) > FRESH_MS);
  for (const t of empty) void studyApi.chatDelete(t.id).catch(() => {});
  return empty.length ? threads.filter((t) => !empty.includes(t)) : threads;
}
