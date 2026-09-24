import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

type Stubs = { href: string; replaced: string | null; session: Map<string, string>; tauri: boolean };

let stubs: Stubs;

function install(href: string, { tauri = false, session = new Map<string, string>() } = {}) {
  stubs = { href, replaced: null, session, tauri };
  const g = globalThis as Record<string, unknown>;
  g.location = { get href() { return stubs.href; } };
  g.history = { replaceState: (_s: unknown, _t: unknown, url: string) => { stubs.replaced = url; } };
  g.sessionStorage = {
    getItem: (k: string) => stubs.session.get(k) ?? null,
    setItem: (k: string, v: string) => void stubs.session.set(k, v),
    removeItem: (k: string) => void stubs.session.delete(k),
  };
  g.window = tauri ? { __TAURI_INTERNALS__: {} } : {};
}

async function load() {
  return import(`./tabClient.ts?${Math.random()}`);
}

beforeEach(() => install('http://127.0.0.1:8790/'));

describe('picking up the key from the address', () => {
  it('takes it from the URL and keeps it for the session', async () => {
    install('http://127.0.0.1:8790/?t=abc123');
    const { tabToken } = await load();
    assert.equal(tabToken(), 'abc123');
    assert.equal(stubs.session.get('wa.tab.token'), 'abc123');
  });

  it('strips it from the address bar, so it is not in browser history', async () => {
    install('http://127.0.0.1:8790/?t=abc123&view=study');
    const { tabToken } = await load();
    tabToken();
    assert.equal(stubs.replaced, '/?view=study', 'the key must not survive in the URL');
    assert.ok(!String(stubs.replaced).includes('abc123'));
  });

  it('remembers it across a reload of the same tab', async () => {
    install('http://127.0.0.1:8790/', { session: new Map([['wa.tab.token', 'kept']]) });
    const { tabToken } = await load();
    assert.equal(tabToken(), 'kept');
  });

  it('has none when the tab was opened without one', async () => {
    const { tabToken } = await load();
    assert.equal(tabToken(), null);
  });
});

describe('deciding whether this is a tab', () => {
  it('is a tab when there is a key and no Tauri', async () => {
    install('http://127.0.0.1:8790/?t=abc123');
    const { inTabMode } = await load();
    assert.equal(inTabMode(), true);
  });

  it('is never a tab inside the desktop window, key or not', async () => {
    install('http://127.0.0.1:8790/?t=abc123', { tauri: true });
    const { inTabMode } = await load();
    assert.equal(inTabMode(), false, 'the window must keep talking to Tauri directly');
  });

  it('is not a tab without a key', async () => {
    const { inTabMode } = await load();
    assert.equal(inTabMode(), false);
  });

  it('is still a tab once it has put its own stand-in for Tauri in place', async () => {
    install('http://127.0.0.1:8790/?t=abc123');
    const g = globalThis as Record<string, unknown>;
    let ping = 0;
    g.fetch = async (url: string) => {
      if (String(url).includes('/salem/ping')) { ping++; return { ok: true, status: 200, json: async () => ({}) }; }
      return new Promise(() => {});
    };
    (g.window as Record<string, unknown>).addEventListener = () => {};
    const { inTabMode, installTabTransport } = await load();
    await installTabTransport('abc123');
    assert.equal(ping, 1);
    assert.ok('__TAURI_INTERNALS__' in (g.window as object));
    assert.equal(inTabMode(), true);
  });
});
