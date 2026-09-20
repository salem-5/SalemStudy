import { useEffect, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { fetchImageData, toPngImage } from '../lib/ai';
import { api, errorText } from '../api';
import { Modal } from './Dialogs';

export type ExportData = { tex: string; images: { file: string; url: string }[]; ai: string };
export type ExportEntry = { id: number; name: string; data: ExportData };
type Result = { tex: string; pdf: string | null; ai: string };
type Status = 'ready' | 'running' | 'done' | 'error';

type Item = ExportEntry & { status: Status; result?: Result; error?: string; showSource: boolean };

export function ExportDialog({ entries, onClose }: { entries: ExportEntry[]; onClose: () => void }) {
  const [items, setItems] = useState<Item[]>(() => entries.map((e) => ({ ...e, status: 'ready', showSource: false })));
  const [running, setRunning] = useState(false);
  const [done, setDone] = useState(0);
  const [log, setLog] = useState<string[]>([]);
  const cancelRef = useRef(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let stop: (() => void) | undefined;
    listen<{ stage?: string; line?: string }>('export://progress', (e) => {
      const { stage, line } = e.payload;
      setLog((l) => [...l.slice(-400), line ?? `— ${stage ?? ''} —`]);
    }).then((un) => { stop = un; }).catch(() => { /* not in Tauri */ });
    return () => stop?.();
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  const prepare = async (d: ExportData) => {
    const figures = await Promise.all(d.images.map(async (im) => {
      try {
        const dataUrl = await fetchImageData(im.url);
        const png = await toPngImage(dataUrl);
        return png ? { file: im.file, data: png } : null;
      } catch {
        return null;
      }
    }));
    const ok = figures.filter((x): x is { file: string; data: string } => !!x);
    let tex = d.tex;
    for (const im of d.images) {
      if (ok.some((o) => o.file === im.file)) continue;
      tex = tex.replace(new RegExp(`\\\\includegraphics\\[[^\\]]*\\]\\{${im.file}\\}`, 'g'), '\\textit{[figure]}');
    }
    return { tex, figures: ok };
  };

  const run = async (compile: boolean) => {
    cancelRef.current = false;
    setRunning(true);
    setDone(0);
    for (let i = 0; i < items.length; i++) {
      if (cancelRef.current) break;
      const it = items[i];
      setLog([`# ${it.name}`]);
      setItems((s) => s.map((x, j) => (j === i ? { ...x, status: 'running', error: undefined, result: undefined } : x)));
      try {
        const { tex, figures } = await prepare(it.data);
        const res = await api.exportLatex(it.name, tex, compile, figures, it.data.ai);
        setItems((s) => s.map((x, j) => (j === i ? { ...x, status: 'done', result: res } : x)));
      } catch (e) {
        setItems((s) => s.map((x, j) => (j === i ? { ...x, status: 'error', error: errorText(e) } : x)));
      }
      setDone(i + 1);
    }
    setRunning(false);
  };

  const cancel = async () => {
    cancelRef.current = true;
    try { await api.exportCancel(); } catch { /* */ }
  };

  const reveal = async (path: string) => {
    try { await api.revealPath(path); } catch { /* */ }
  };

  const total = items.length;
  const finished = !running && items.every((x) => x.status === 'done' || x.status === 'error');

  return (
    <Modal title={total > 1 ? `EXPORT ${total} ASSIGNMENTS` : 'EXPORT'} onClose={running ? () => { /* keep open */ } : onClose} wide>
      <div className="export-dialog">
        <div className="export-bar">
          <span className="muted">
            {running ? `Working… ${done}/${total}` : total > 1 ? `${total} assignments selected` : items[0]?.name}
          </span>
          <span className="spacer" />
          {running
            ? <button type="button" className="btn ghost danger" onClick={() => void cancel()}>Cancel</button>
            : <>
              <button type="button" className="btn ghost" onClick={() => void run(false)}>Save .tex</button>
              <button type="button" className="btn primary" onClick={() => void run(true)}>Compile PDF{total > 1 ? 's' : ''}</button>
            </>}
        </div>

        <ul className="export-list">
          {items.map((it, i) => (
            <li key={it.id} className={`export-item ${it.status}`}>
              <div className="export-item-main">
                <span className={`export-dot ${it.status}`} />
                <span className="export-name">{it.name}</span>
                <span className="muted">
                  {it.data.images.length ? `${it.data.images.length} fig` : ''}
                </span>
                <span className="spacer" />
                <button type="button" className="link" onClick={() => setItems((s) => s.map((x, j) => (j === i ? { ...x, showSource: !x.showSource } : x)))}>
                  {it.showSource ? 'hide source' : 'source'}
                </button>
                {it.status === 'running' && <span className="export-status">compiling…</span>}
                {it.status === 'done' && it.result?.pdf && (
                  <button type="button" className="btn ghost" onClick={() => void reveal(it.result!.pdf!)}>Show in Explorer</button>
                )}
              </div>
              {it.error && <div className="ai-settings-err export-err">{it.error}</div>}
              {it.status === 'done' && it.result?.pdf && <div className="export-path"><code>{it.result.pdf}</code></div>}
              {it.showSource && <pre className="code-block export-preview">{it.data.tex}</pre>}
            </li>
          ))}
        </ul>

        {running && <pre ref={logRef} className="code-block export-log">{log.join('\n') || '…'}</pre>}

        <div className="export-bar">
          <span className="spacer" />
          {finished && <button type="button" className="btn primary" onClick={onClose}>Close</button>}
        </div>
      </div>
    </Modal>
  );
}
