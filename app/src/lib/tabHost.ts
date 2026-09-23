import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

/**
 * The desktop window answering for the browser tabs.
 *
 * Tab mode does not give the tab its own backend — it relays every command
 * through the window that is already running, so both are looking at exactly
 * the same database, the same AI runtime and the same settings. This is the
 * relay: one listener, running each command the server forwards and handing
 * the result back.
 *
 * It only ever runs inside the desktop app.
 */

/** Commands a tab may not ask for: the relay's own plumbing. */
const INTERNAL = new Set(['tab_mode_reply']);

export async function installTabHost(): Promise<() => void> {
  return listen<{ id: number; cmd: string; args: Record<string, unknown> }>('tabmode://rpc', async (e) => {
    const { id, cmd, args } = e.payload;
    const reply = (ok: boolean, data: unknown, error?: string) =>
      invoke('tab_mode_reply', { id, ok, data: data ?? null, error: error ?? null }).catch(() => {});
    if (INTERNAL.has(cmd)) {
      void reply(false, null, `${cmd} cannot be called from a tab.`);
      return;
    }
    try {
      void reply(true, await invoke(cmd, args));
    } catch (err) {
      void reply(false, null, String(err instanceof Error ? err.message : err));
    }
  });
}
