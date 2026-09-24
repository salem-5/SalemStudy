import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

const memStorage = () => new (class MemStorage {
  map = new Map<string, string>();
  get length() { return this.map.size; }
  key(i: number) { return [...this.map.keys()][i] ?? null; }
  getItem(k: string) { return this.map.get(k) ?? null; }
  setItem(k: string, v: string) { this.map.set(k, String(v)); }
  removeItem(k: string) { this.map.delete(k); }
})();

type Call = { cmd: string; args: Record<string, unknown> };

async function setup(shared: Record<string, string>, local: Record<string, string>) {
  const g = globalThis as Record<string, unknown>;
  const storage = memStorage();
  for (const [k, v] of Object.entries(local)) storage.setItem(k, v);
  g.localStorage = storage;
  const calls: Call[] = [];
  const callbacks = new Map<number, (e: unknown) => void>();
  let n = 1;
  const win = Object.assign(new EventTarget(), {
    setTimeout, clearTimeout,
    __TAURI_INTERNALS__: {
      transformCallback: (cb: (e: unknown) => void) => { const id = n++; callbacks.set(id, cb); return id; },
      invoke: async (cmd: string, args: Record<string, unknown>) => {
        calls.push({ cmd, args });
        if (cmd === 'prefs_seed') return { ...(args.prefs as Record<string, string>), ...shared };
        if (cmd === 'prefs_all') return shared;
        if (cmd === 'plugin:event|listen') return 1;
        return null;
      },
    },
  });
  g.window = win;
  const mod = await import(`./prefSync.ts?${Math.random()}`);
  const emit = (payload: unknown) => {
    const listen = calls.find((c) => c.cmd === 'plugin:event|listen');
    callbacks.get(Number(listen?.args.handler))?.({ event: 'prefs://changed', id: 1, payload });
  };
  return { mod, storage, calls, emit, win };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('what is shared', () => {
  it('shares settings, not where a page is or what it has cached', async () => {
    const { mod } = await setup({}, {});
    for (const k of ['wa.theme', 'wa.shape', 'wa.accent', 'wa.chat.personal', 'wa.pomodoro.v1', 'wa.decks.shuffle', 'wa.nb.3.gen.quiz']) {
      assert.ok(mod.isShared(k), k);
    }
    for (const k of ['wa.tab.token', 'wa.route', 'wa.scroll.note-1', 'wa.q.99', 'wa.qcss.v1', 'other.thing']) {
      assert.ok(!mod.isShared(k), k);
    }
  });
});

describe('starting up', () => {
  it('seeds the shared copy from the window, and takes what the shared copy already has', async () => {
    const { mod, storage, calls } = await setup({ 'wa.theme': 'mocha' }, { 'wa.theme': 'dark', 'wa.shape': 'rounded', 'wa.route': 'x' });
    await mod.startPrefSync('window');
    const seed = calls.find((c) => c.cmd === 'prefs_seed')!;
    assert.deepEqual(Object.keys(seed.args.prefs as object).sort(), ['wa.shape', 'wa.theme'], 'the route stays with the window');
    assert.equal(storage.getItem('wa.theme'), 'mocha', 'the shared copy wins');
    assert.equal(storage.getItem('wa.shape'), 'rounded');
    assert.equal(storage.getItem('wa.route'), 'x');
  });

  it('makes a tab a mirror of the shared copy', async () => {
    const { mod, storage } = await setup({ 'wa.theme': 'sepia', 'wa.shape': 'rounded' }, { 'wa.theme': 'dark', 'wa.accent': '#ff0000' });
    await mod.startPrefSync('tab');
    assert.equal(storage.getItem('wa.theme'), 'sepia');
    assert.equal(storage.getItem('wa.shape'), 'rounded');
    assert.equal(storage.getItem('wa.accent'), null, 'a setting the shared copy does not have is not kept');
  });
});

describe('changes', () => {
  it('sends a change to a shared setting, once, and not a change to a local one', async () => {
    const { mod, storage, calls } = await setup({}, {});
    await mod.startPrefSync('tab');
    storage.setItem('wa.pomodoro.v1', '1');
    storage.setItem('wa.pomodoro.v1', '2');
    storage.setItem('wa.pomodoro.v1', '3');
    storage.setItem('wa.route', 'somewhere');
    await wait(400);
    const sets = calls.filter((c) => c.cmd === 'prefs_set');
    assert.equal(sets.length, 1, 'several saves in a row go as one');
    assert.equal(sets[0].args.key, 'wa.pomodoro.v1');
    assert.equal(sets[0].args.value, '3');
  });

  it('applies a change from the other side and says so, without sending it back', async () => {
    const { mod, storage, calls, emit, win } = await setup({}, {});
    await mod.startPrefSync('window');
    const heard: string[] = [];
    win.addEventListener('wa:prefs', (e) => heard.push((e as CustomEvent<{ key: string }>).detail.key));
    emit({ key: 'wa.shape', value: 'rounded', source: 'another-page' });
    assert.equal(storage.getItem('wa.shape'), 'rounded');
    assert.deepEqual(heard, ['wa.shape']);
    await wait(400);
    assert.equal(calls.filter((c) => c.cmd === 'prefs_set').length, 0, 'no echo');
  });

  it('removes a setting the other side removed', async () => {
    const { mod, storage, emit } = await setup({ 'wa.accent': '#00ff00' }, {});
    await mod.startPrefSync('tab');
    emit({ key: 'wa.accent', value: null, source: 'another-page' });
    assert.equal(storage.getItem('wa.accent'), null);
  });
});
