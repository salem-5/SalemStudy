import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

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
