/**
 * Salem running in a browser tab.
 *
 * The page is the same build the desktop window runs; only the transport
 * underneath it changes. Rather than teaching every feature about tab mode,
 * this stands in for Tauri itself: `invoke` becomes a POST to the app's
 * loopback server, and `listen` becomes a poll of the same event feed the
 * window gets. Nothing above this file knows the difference.
 *
 * The token comes in the URL the app shows, is kept for the session only, and
 * is stripped from the address bar immediately — a token in browser history
 * is a token in the student's synced history.
 */

const TOKEN_KEY = 'wa.tab.token';

type Args = Record<string, unknown>;

export function tabToken(): string | null {
  try {
    const url = new URL(location.href);
    const fromUrl = url.searchParams.get('t');
    if (fromUrl) {
      sessionStorage.setItem(TOKEN_KEY, fromUrl);
      url.searchParams.delete('t');
      history.replaceState(null, '', url.pathname + url.search + url.hash);
      return fromUrl;
    }
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** Set once this page has put its HTTP stand-in for Tauri in place. */
const TAB_FLAG = '__SALEM_TAB__';

/**
 * Is this page being served by the app's own tab-mode server?
 *
 * Once the tab installs its stand-in, `__TAURI_INTERNALS__` exists here too,
 * so that alone cannot tell the tab from the desktop window — asked after
 * boot it said "desktop", and the tab put up the desktop's lock screen.
 */
export function inTabMode(): boolean {
  if ((window as unknown as Record<string, unknown>)[TAB_FLAG]) return true;
  if ('__TAURI_INTERNALS__' in window) return false;
  return !!tabToken();
}

type Listener = (event: { event: string; id: number; payload: unknown }) => void;

/**
 * Tab mode is over: say so, and close the tab.
 *
 * A browser only lets a page close a tab a script opened, and this one was
 * opened by the app from outside the browser, so the close may be refused.
 * Either way nothing in the tab works any more, so it is covered with a plain
 * page saying why — drawn without React, which may be what just lost its
 * connection.
 */
export function showTabClosed(reason: 'off' | 'gone') {
  if (typeof document === 'undefined' || document.getElementById('salem-tab-closed')) return;
  const cover = document.createElement('div');
  cover.id = 'salem-tab-closed';
  cover.className = 'tab-closed';
  cover.setAttribute('role', 'alert');
  const card = document.createElement('div');
  card.className = 'tab-closed-card';
  const title = document.createElement('h1');
  title.textContent = reason === 'off' ? 'Tab mode was turned off' : 'Salem is not running';
  const text = document.createElement('p');
  text.textContent = reason === 'off'
    ? 'Salem is back in its own window. You can close this tab.'
    : 'The Salem app was closed, so this tab has nothing to talk to. Open Salem and turn tab mode on again to use it here.';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'btn primary';
  close.textContent = 'Close this tab';
  close.onclick = () => window.close();
  card.append(title, text, close);
  cover.append(card);
  document.body.append(cover);
  // Try straight away; where the browser allows it, the tab just goes.
  window.setTimeout(() => window.close(), 400);
}

/**
 * Stand in for Tauri, so the rest of the app carries on unchanged.
 *
 * Returns a promise that resolves once the server has answered once, so the
 * app does not render against a connection that was never going to work.
 */
export async function installTabTransport(token: string): Promise<void> {
  const headers = { 'Content-Type': 'application/json', 'X-Salem-Token': token };

  const call = async (cmd: string, args: Args): Promise<unknown> => {
    const res = await fetch('/salem/rpc', { method: 'POST', headers, body: JSON.stringify({ cmd, args }) });
    if (res.status === 401) throw 'This tab is no longer signed in. Reopen it from the Salem window.';
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw String((body as { error?: string }).error ?? `${cmd} failed (HTTP ${res.status})`);
    }
    const body = (await res.json()) as { ok: boolean; data?: unknown; error?: string };
    if (!body.ok) throw String(body.error ?? `${cmd} failed`);
    return body.data;
  };

  // Tauri's event plugin registers listeners by name through `invoke`, so the
  // shim keeps its own table and feeds it from the server's event log.
  const listeners = new Map<number, { event: string; handler: Listener }>();
  const callbacks = new Map<number, (payload: unknown) => void>();
  let nextCallback = 1;
  let nextListener = 1;

  const deliver = (name: string, payload: unknown) => {
    for (const [id, entry] of listeners) {
      if (entry.event !== name) continue;
      entry.handler({ event: name, id, payload });
    }
  };

  let closed = false;
  const poll = async () => {
    let since = 0;
    let backoff = 500;
    let failures = 0;
    while (!closed) {
      try {
        const res = await fetch(`/salem/events?since=${since}`, { headers });
        if (res.status === 401) { closed = true; showTabClosed('off'); break; }
        if (!res.ok) throw new Error(String(res.status));
        const body = (await res.json()) as { events: { event: string; payload: unknown }[]; seq: number; missed?: boolean };
        since = body.seq;
        backoff = 500;
        failures = 0;
        for (const entry of body.events) {
          if (entry.event === 'tabmode://closed') { closed = true; showTabClosed('off'); }
          deliver(entry.event, entry.payload);
        }
      } catch {
        // The window may be restarting: back off rather than hammering it.
        // Still unreachable after a few tries, the app has gone.
        failures += 1;
        if (failures >= 4) { closed = true; showTabClosed('gone'); break; }
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 10_000);
      }
    }
  };

  const internals = {
    invoke: async (cmd: string, args: Args) => {
      // These belong to the tab, not to the app it is talking to.
      if (cmd === 'plugin:event|listen') {
        const id = nextListener++;
        const { event, handler } = args as unknown as { event: string; handler: number };
        const fn = callbacks.get(handler);
        if (fn) listeners.set(id, { event, handler: (e) => fn(e) });
        return id;
      }
      if (cmd === 'plugin:event|unlisten') {
        listeners.delete(Number((args as { eventId?: unknown }).eventId));
        return null;
      }
      return call(cmd, args ?? {});
    },
    transformCallback: (cb: (e: unknown) => void) => {
      const n = nextCallback++;
      callbacks.set(n, cb);
      return n;
    },
    unregisterCallback: (n: number) => { callbacks.delete(n); },
  };

  (window as unknown as Record<string, unknown>)[TAB_FLAG] = true;
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = internals;
  (window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = {
    unregisterListener: (_event: string, id: number) => { listeners.delete(id); },
  };

  // Fail loudly here rather than letting every screen fail on its own.
  const ping = await fetch('/salem/ping', { headers }).catch(() => null);
  if (!ping?.ok) {
    throw new Error('Salem is not answering. Make sure the app is still open, then reopen this tab from it.');
  }
  void poll();
  window.addEventListener('beforeunload', () => { closed = true; });
}
