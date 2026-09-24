import { useCallback, useEffect, useMemo, useState } from 'react';
import { Brain, Check, ChevronDown, Cpu, ExternalLink, Eye, KeyRound, Loader2, Power, RefreshCw, Search, Wrench } from 'lucide-react';
import { getAiConfig, setAiConfig, type AiConfig } from '../lib/ai';
import {
  contextLabel, infoOf, logoUrl, OLLAMA, ollamaProvider, ollamaStart, ollamaStatus, ollamaStop, orderedModels, orderedProviders,
  priceLabel, providersCatalog, type CatalogModel, type CatalogProvider, type OllamaStatus,
} from '../lib/providers';
import { studyApi } from '../study/api';
import { POPOVER_OPEN, Select } from './Select';

function useHoldsEscape(open: boolean) {
  useEffect(() => {
    if (!open) return;
    document.documentElement.setAttribute(POPOVER_OPEN, '');
    return () => document.documentElement.removeAttribute(POPOVER_OPEN);
  }, [open]);
}

const errText = (e: unknown) => String(e instanceof Error ? e.message : e);

export function ProviderSettings({ solverOn, onChanged }: { solverOn: boolean; onChanged?: (c: AiConfig) => void }) {
  const [cfg, setCfg] = useState<AiConfig | null>(null);
  const [catalog, setCatalog] = useState<Record<string, CatalogProvider> | null>(null);
  const [ollama, setOllama] = useState<OllamaStatus | null>(null);
  const [picking, setPicking] = useState(false);
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const apply = useCallback((c: AiConfig) => { setCfg(c); onChanged?.(c); }, [onChanged]);
  useEffect(() => { getAiConfig().then(setCfg).catch((e) => setErr(errText(e))); }, []);
  const loadCatalog = useCallback((refresh = false) => {
    setBusy(refresh ? 'refresh' : 'catalog');
    providersCatalog(refresh).then(setCatalog).catch((e) => setErr(errText(e))).finally(() => setBusy(null));
  }, []);
  useEffect(() => loadCatalog(), [loadCatalog]);
  const refreshOllama = useCallback(() => { ollamaStatus().then(setOllama).catch(() => {}); }, []);
  useEffect(refreshOllama, [refreshOllama]);

  const providers = useMemo(() => (catalog ? orderedProviders(catalog) : []), [catalog]);

  useEffect(() => {
    if (!cfg || cfg.provider !== OLLAMA || !ollama?.models.length) return;
    const ids = ollama.models.map((m) => m.id);
    if (ids.includes(cfg.flashModel)) return;
    const first = ids[0];
    void setAiConfig({ flashModel: first, proModel: ids.includes(cfg.proModel) ? cfg.proModel : first }).then(apply).catch(() => {});
  }, [cfg, ollama, apply]);
  const current = cfg?.provider ?? 'deepseek';
  const provider: CatalogProvider | null = current === OLLAMA ? ollamaProvider(ollama) : catalog?.[current] ?? null;
  const models = useMemo(() => (provider ? orderedModels(provider.models) : []), [provider]);

  const run = async (what: string, f: () => Promise<AiConfig | void>) => {
    setBusy(what);
    setErr(null);
    try { const c = await f(); if (c) apply(c); } catch (e) { setErr(errText(e)); } finally { setBusy(null); }
  };

  const pickProvider = (p: CatalogProvider) => run('provider', async () => {
    setPicking(false);
    setKey('');
    let list = p.models;
    if (p.id === OLLAMA) {
      const status = await ollamaStart().catch(() => null);
      if (status) setOllama(status);
      list = ollamaProvider(status).models;
    }
    const first = orderedModels(list)[0];
    return setAiConfig({
      provider: p.id,
      baseUrl: p.id === OLLAMA ? '' : p.base ?? '',
      ...(first
        ? { flashModel: first.id, proModel: first.id, modelsInfo: { [first.id]: infoOf(first) } }
        : { flashModel: '', proModel: '' }),
    });
  });

  const pickModel = (m: CatalogModel, which: 'flashModel' | 'proModel') =>
    run(which, () => setAiConfig({ [which]: m.id, modelsInfo: { [m.id]: infoOf(m) } }));

  const saveKey = () => run('key', async () => {
    const c = await setAiConfig({ apiKey: key.trim(), keyProvider: current });
    setKey('');
    return c;
  });
  const removeKey = () => run('key', () => setAiConfig({ apiKey: '', keyProvider: current }));

  if (!cfg) return <p className="muted">{err ?? 'Loading…'}</p>;

  return (
    <div className="provider-settings">
      <div className="provider-current">
        <ProviderLogo id={current} name={provider?.name ?? current} big />
        <div className="provider-current-text">
          <b>{provider?.name ?? current}</b>
          <span className="muted">
            {current === OLLAMA ? 'Local models on this computer' : provider?.base ?? ''}
          </span>
        </div>
        <button type="button" className="btn ghost" onClick={() => setPicking((v) => !v)} aria-expanded={picking}>
          Change provider<ChevronDown className={picking ? 'flip' : undefined} />
        </button>
      </div>

      {picking && (
        <ProviderPicker
          onClose={() => setPicking(false)}
          providers={providers}
          loading={!catalog}
          keyed={new Set(cfg.keyed ?? [])}
          current={current}
          onPick={pickProvider}
          onRefresh={() => loadCatalog(true)}
          refreshing={busy === 'refresh'}
        />
      )}

      {current === OLLAMA ? (
        <OllamaPanel status={ollama} onStatus={setOllama} onRefresh={refreshOllama}
          ctx={cfg.ollamaCtx} onCtx={(n) => void run('ctx', () => setAiConfig({ ollamaCtx: n }))} />
      ) : (
        <div className="provider-key">
          <label>
            <span><KeyRound />API key for {provider?.name ?? current}</span>
            <div className="account-row">
              <input
                type="password"
                value={key}
                spellCheck={false}
                placeholder={cfg.hasKey ? `saved: ${cfg.keyHint} - type a new key to replace` : provider?.env?.[0] ?? 'API key'}
                onChange={(e) => setKey(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter' && key.trim()) void saveKey(); }}
              />
              <button type="button" className="btn" disabled={!!busy || !key.trim()} onClick={() => void saveKey()}>Save key</button>
              <button type="button" className="btn ghost danger" disabled={!!busy || !cfg.hasKey} onClick={() => void removeKey()}>Remove</button>
            </div>
          </label>
          <p className="muted small">
            Stored on this computer only, one per provider. {provider?.doc && (
              <button type="button" className="link" onClick={() => void studyApi.openUrl(provider.doc)}>Where to get one<ExternalLink /></button>
            )}
          </p>
        </div>
      )}

      <ModelPicker
        label="Model"
        hint="Used for everything: chats, notes, decks and quizzes."
        models={models}
        value={cfg.flashModel}
        busy={busy === 'flashModel'}
        onPick={(m) => void pickModel(m, 'flashModel')}
        empty={current === OLLAMA
          ? (ollama?.running ? 'No models installed. Pull one in a terminal, e.g. `ollama pull llama3.1`, then refresh.' : 'Start Ollama to see the models installed on this computer.')
          : !catalog ? 'Loading the model list…' : 'This provider lists no models.'}
      />
      {solverOn && (
        <ModelPicker
          label="Solver retry model"
          hint="The assignment solver switches to this after a wrong answer."
          models={models}
          value={cfg.proModel}
          busy={busy === 'proModel'}
          onPick={(m) => void pickModel(m, 'proModel')}
        />
      )}
      {err && <div className="ai-settings-err">{err}</div>}
    </div>
  );
}

export function ProviderLogo({ id, name, big }: { id: string; name: string; big?: boolean }) {
  const [ok, setOk] = useState<boolean | null>(null);
  useEffect(() => {
    let alive = true;
    const img = new Image();
    img.onload = () => alive && setOk(true);
    img.onerror = () => alive && setOk(false);
    img.src = logoUrl(id);
    return () => { alive = false; };
  }, [id]);
  return (
    <span className={`prov-logo${big ? ' big' : ''}${ok ? ' has' : ''}`} aria-hidden
      style={ok ? ({ '--logo': `url("${logoUrl(id)}")` } as React.CSSProperties) : undefined}>
      {ok ? null : id === OLLAMA ? <Cpu /> : (name[0] ?? '?').toUpperCase()}
    </span>
  );
}

function ProviderPicker({ providers, loading, keyed, current, onPick, onRefresh, refreshing, onClose }: {
  onClose: () => void;
  providers: CatalogProvider[];
  loading: boolean;
  keyed: Set<string>;
  current: string;
  onPick: (p: CatalogProvider) => void;
  onRefresh: () => void;
  refreshing: boolean;
}) {
  const [q, setQ] = useState('');
  useHoldsEscape(true);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? providers.filter((p) => p.name.toLowerCase().includes(t) || p.id.includes(t)) : providers;
  }, [providers, q]);
  const local = ollamaProvider(null);
  const row = (p: CatalogProvider, local = false) => (
    <button key={p.id} type="button" className={`provider-row${p.id === current ? ' on' : ''}`} onClick={() => onPick(p)}>
      <ProviderLogo id={p.id} name={p.name} />
      <span className="provider-row-name">{p.name}</span>
      <span className="provider-row-meta muted">
        {local ? 'local' : `${p.models.length} model${p.models.length === 1 ? '' : 's'}`}
      </span>
      {(keyed.has(p.id) || local) && p.id !== current && <span className="provider-row-key" title={local ? 'No key needed' : 'Key saved'}><Check /></span>}
      {p.id === current && <span className="provider-row-key on">current</span>}
    </button>
  );
  return (
    <div className="provider-picker">
      <div className="provider-search">
        <Search />
        <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${providers.length} providers`} spellCheck={false}
          onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); onClose(); } }} />
        <button type="button" className="icon-btn ghost-icon" onClick={onRefresh} title="Fetch the latest list from models.dev" disabled={refreshing}>
          {refreshing ? <Loader2 className="spin" /> : <RefreshCw />}
        </button>
      </div>
      <div className="provider-list">
        {!q.trim() && <><div className="provider-group">On this computer</div>{row(local, true)}<div className="provider-group">Online</div></>}
        {loading ? <p className="muted small provider-empty"><Loader2 className="spin" /> Loading providers from models.dev…</p>
          : shown.length ? shown.map((p) => row(p))
            : <p className="muted small provider-empty">No provider matches “{q}”.</p>}
      </div>
    </div>
  );
}

function ModelPicker({ label, hint, models, value, busy, onPick, empty }: {
  label: string;
  hint: string;
  models: CatalogModel[];
  value: string;
  busy: boolean;
  onPick: (m: CatalogModel) => void;
  empty?: string;
}) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  useHoldsEscape(open);
  const chosen = models.find((m) => m.id === value);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return t ? models.filter((m) => m.name.toLowerCase().includes(t) || m.id.toLowerCase().includes(t)) : models;
  }, [models, q]);

  return (
    <div className="model-picker">
      <span className="model-picker-label">{label} <span className="muted">- {hint}</span></span>
      <button type="button" className={`model-current${open ? ' open' : ''}`} onClick={() => setOpen((o) => !o)} disabled={!models.length && !value}>
        {chosen ? <ModelLine m={chosen} /> : <span className={value ? 'mono' : 'muted'}>{value || empty || 'Choose a model'}</span>}
        {busy ? <Loader2 className="spin" /> : <ChevronDown className={`model-caret${open ? ' flip' : ''}`} />}
      </button>
      {!models.length && empty && <p className="muted small">{empty}</p>}
      {open && models.length > 0 && (
        <div className="model-list-wrap">
          <div className="provider-search">
            <Search />
            <input autoFocus value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Search ${models.length} models`} spellCheck={false}
              onKeyDown={(e) => { if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); } }} />
          </div>
          <div className="model-list">
            {shown.map((m) => (
              <button key={m.id} type="button" className={`model-row${m.id === value ? ' on' : ''}`} onClick={() => { onPick(m); setOpen(false); setQ(''); }}>
                <ModelLine m={m} />
                {m.id === value && <Check className="model-check" />}
              </button>
            ))}
            {!shown.length && <p className="muted small provider-empty">No model matches “{q}”.</p>}
          </div>
        </div>
      )}
    </div>
  );
}

function ModelLine({ m }: { m: CatalogModel }) {
  return (
    <span className="model-line">
      <span className="model-name">
        {m.name}{m.status === 'deprecated' && <span className="model-dep">deprecated</span>}
      </span>
      <span className="model-meta">
        <span className="mono muted">{m.id}</span>
        <span className="model-badges">
          {m.tools && <span title="Can use tools (needed for the chats' actions)"><Wrench /></span>}
          {m.vision && <span title="Reads images"><Eye /></span>}
          {m.reasoning && <span title="Reasons before answering"><Brain /></span>}
        </span>
        {m.context > 0 && <span className="muted" title="Context window">{contextLabel(m.context)}</span>}
        <span className="muted" title="USD per million tokens, in / out">{priceLabel(m)}</span>
      </span>
    </span>
  );
}

const CONTEXTS = [8_192, 16_384, 32_768, 65_536, 131_072];

function OllamaPanel({ status, onStatus, onRefresh, ctx, onCtx }: {
  status: OllamaStatus | null;
  onStatus: (s: OllamaStatus) => void;
  onRefresh: () => void;
  ctx: number;
  onCtx: (n: number) => void;
}) {
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const gb = (n: number | null) => (n ? `${(n / 1e9).toFixed(1)} GB` : '');

  const start = async () => {
    setBusy('start'); setErr(null);
    try { onStatus(await ollamaStart()); } catch (e) { setErr(errText(e)); } finally { setBusy(null); }
  };
  const stop = async () => {
    setBusy('stop'); setErr(null);
    try { await ollamaStop(); onRefresh(); } catch (e) { setErr(errText(e)); } finally { setBusy(null); }
  };

  return (
    <div className="ollama-panel">
      <div className="ollama-status">
        <span className={`ollama-dot${status?.running ? ' on' : ''}`} />
        {!status ? 'Checking Ollama…'
          : !status.installed && !status.running ? 'Ollama is not installed on this computer.'
            : status.running
              ? <>Running{status.version ? ` · v${status.version}` : ''} · {status.models.length} model{status.models.length === 1 ? '' : 's'} installed
                {status.loaded.length ? <> · in memory: {status.loaded.map((m) => `${m.id}${m.vram ? ` (${gb(m.vram)})` : ''}`).join(', ')}</> : ' · nothing loaded'}</>
              : 'Not running - it starts on its own when a local model is asked for.'}
      </div>
      <div className="account-row">
        {status && !status.installed && !status.running && (
          <button type="button" className="btn" onClick={() => void studyApi.openUrl('https://ollama.com/download')}><ExternalLink />Get Ollama</button>
        )}
        {status?.installed && !status.running && (
          <button type="button" className="btn" disabled={!!busy} onClick={() => void start()}>
            {busy === 'start' ? <Loader2 className="spin" /> : <Power />}Start Ollama
          </button>
        )}
        {status?.running && (
          <button type="button" className="btn" disabled={!!busy} onClick={() => void stop()}
            title="Free the memory now; it loads again the next time a local model is used">
            {busy === 'stop' ? <Loader2 className="spin" /> : <Power />}Unload model &amp; stop Ollama
          </button>
        )}
        <button type="button" className="icon-btn ghost-icon" onClick={onRefresh} title="Check again"><RefreshCw /></button>
      </div>
      <label className="ollama-ctx">
        <span>Context length</span>
        <Select className="field-input" value={String(ctx || 16_384)} onChange={(v) => onCtx(Number(v))}
          options={CONTEXTS.map((n) => ({ value: String(n), label: `${n / 1024}k tokens`, hint: n <= 8_192 ? 'short chats only' : n <= 16_384 ? 'decks, quizzes and chats' : n <= 32_768 ? 'long sources' : 'needs a lot of memory' }))} />
        <small className="muted">How much of your material the model can read at once. More needs more memory (VRAM); if replies fail or slow to a crawl, lower it.</small>
      </label>
      <p className="muted small">
        When Salem quits, whatever model Ollama has in memory is unloaded and Ollama is stopped. It starts again, and loads
        the model again, the next time a local model is asked for.
      </p>
      {err && <div className="ai-settings-err">{err}</div>}
    </div>
  );
}
