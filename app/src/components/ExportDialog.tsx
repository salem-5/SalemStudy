import { useEffect, useMemo, useRef, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import type { Assignment } from '../types';
import { fetchImageData, toPngImage } from '../lib/ai';
import type { ExportMeta } from '../lib/latex';
import { assignmentToWorksheet, worksheetSubtitle, type WorksheetExport } from '../lib/worksheet';
import { api, errorText } from '../api';
import { Modal } from './Dialogs';

export type ExportEntry = { id: number; name: string; assignment: Assignment };
type Result = { tex: string | null; pdf: string | null };
type Status = 'ready' | 'running' | 'done' | 'error';

const lanes = (count: number) => Math.max(1, Math.min(count, navigator.hardwareConcurrency || 4, 6));

type Item = {
  title: string;
  file: string;
  status: Status;
  result?: Result;
  error?: string;
  showSource: boolean;
};

export function ExportDialog({ entries, meta, onClose }: { entries: ExportEntry[]; meta: ExportMeta; onClose: () => void }) {
  const [items, setItems] = useState<Item[]>(
    () => entries.map((e) => ({ title: e.name, file: e.name, status: 'ready', showSource: false })),
  );
  const [workings, setWorkings] = useState(false);
  const [nameFields, setNameFields] = useState(true);
  const [transcript, setTranscript] = useState(true);
  const [running, setRunning] = useState(false);
  const [folder, setFolder] = useState<string | null>(null);
  const [done, setDone] = useState(0);
  const [width, setWidth] = useState(1);
  const [log, setLog] = useState<string[]>([]);
  const cancelRef = useRef(false);
  const logRef = useRef<HTMLPreElement>(null);

  useEffect(() => {
    let stop: (() => void) | undefined;
    listen<{ job?: string; stage?: string; line?: string }>('export://progress', (e) => {
      const { job, stage, line } = e.payload;
      const text = line ?? `— ${stage ?? ''} —`;
      setLog((l) => [...l.slice(-400), entries.length > 1 && job ? `${job} │ ${text}` : text]);
    }).then((un) => { stop = un; }).catch(() => { });
    return () => stop?.();
  }, []);

  useEffect(() => {
    const el = logRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [log]);

  useEffect(() => {
    void (async () => {
      try { setFolder(await api.exportDir()); } catch { setFolder(null); }
    })();
  }, []);

  const titles = items.map((it) => it.title);
  const docs = useMemo(
    () => entries.map((e, i) => assignmentToWorksheet(e.assignment, {
      ...meta, workings, nameFields, transcript, title: titles[i],
    })),
    [entries, meta, workings, nameFields, transcript, titles.join('\n')],
  );

  const patch = (i: number, p: Partial<Item>) => setItems((s) => s.map((x, j) => (j === i ? { ...x, ...p } : x)));

  const prepare = async (d: WorksheetExport) => {
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
    let html = d.html;
    for (const im of d.images) {
      if (ok.some((o) => o.file === im.file)) continue;
      html = html.replace(new RegExp(`<img [^>]*src="${im.file}"[^>]*/?>`, 'g'), '<i>[figure]</i>');
    }
    return { html, figures: ok };
  };

  const exportOne = async (i: number) => {
    const name = items[i].file.trim() || entries[i].name;
    patch(i, { status: 'running', error: undefined, result: undefined });
    try {
      const { html, figures } = await prepare(docs[i]);
      const res = await api.exportPdf(name, html, figures, worksheetSubtitle(meta), name);
      patch(i, { status: 'done', result: res });
    } catch (e) {
      patch(i, { status: 'error', error: errorText(e) });
    }
    setDone((d) => d + 1);
  };

  const run = async () => {
    cancelRef.current = false;
    setRunning(true);
    setDone(0);
    setLog([]);
    const todo = entries.map((_, i) => i);
    const width = lanes(todo.length);
    setWidth(width);
    await Promise.all(
      Array.from({ length: width }, async () => {
        while (todo.length && !cancelRef.current) {
          await exportOne(todo.shift()!);
        }
      }),
    );
    setWidth(1);
    setRunning(false);
  };

  const cancel = async () => {
    cancelRef.current = true;
    try { await api.exportCancel(); } catch { }
  };

  const open = async (path: string) => {
    try { await api.openPath(path); } catch (e) { setLog((l) => [...l, errorText(e)]); }
  };

  const openFolder = async () => {
    try {
      const done = items.find((x) => x.result)?.result;
      await api.revealPath(done?.pdf ?? done?.tex ?? folder ?? '');
    } catch { }
  };

  const total = entries.length;
  const finished = !running && items.every((x) => x.status === 'done' || x.status === 'error');

  return (
    <Modal title={total > 1 ? `EXPORT ${total} ASSIGNMENTS` : 'EXPORT'} onClose={running ? () => { } : onClose} wide>
      <div className="export-dialog">
        <div className="export-bar">
          <span className="muted">
            {running
              ? `Working… ${done}/${total}${width > 1 ? ` · ${width} at a time` : ''}`
              : total > 1 ? `${total} assignments selected` : entries[0]?.name}
          </span>
          <span className="spacer" />
          {running
            ? <button type="button" className="btn ghost danger" onClick={() => void cancel()}>Cancel</button>
            : <button type="button" className="btn primary" onClick={() => void run()}>
              Make PDF{total > 1 ? 's' : ''}
            </button>}
        </div>

        <div className="export-opts">
          <label className="export-opt" title="Leave a blank area under each question to work the answer out in">
            <input type="checkbox" checked={workings} disabled={running} onChange={(e) => setWorkings(e.target.checked)} />
            Space for working
          </label>
          <label className="export-opt" title="Print the Name / Class / Date line under the title">
            <input type="checkbox" checked={nameFields} disabled={running} onChange={(e) => setNameFields(e.target.checked)} />
            Name &amp; date fields
          </label>
          <label className="export-opt" title="Embed an invisible plain-text copy of every question, so screen readers and AI tools can read the maths and the figures">
            <input type="checkbox" checked={transcript} disabled={running} onChange={(e) => setTranscript(e.target.checked)} />
            Readable text layer
          </label>
        </div>

        <div className="export-cols">
          <span className="export-col">Title on the sheet</span>
          <span className="export-col file">File name</span>
        </div>

        <ul className="export-list">
          {items.map((it, i) => (
            <li key={entries[i].id} className={`export-item ${it.status}`}>
              <div className="export-item-main">
                <span className={`export-dot ${it.status}`} />
                <input
                  className="export-field"
                  value={it.title}
                  disabled={running}
                  aria-label={`Title for ${entries[i].name}`}
                  placeholder="title on the sheet"
                  onChange={(e) => patch(i, { title: e.target.value })}
                />
                <input
                  className="export-field file"
                  value={it.file}
                  disabled={running}
                  aria-label={`File name for ${entries[i].name}`}
                  placeholder="file name"
                  onChange={(e) => patch(i, { file: e.target.value })}
                />
                <span className="muted">{docs[i].images.length ? `${docs[i].images.length} fig` : ''}</span>
                <span className="spacer" />
                <button type="button" className="link" onClick={() => patch(i, { showSource: !it.showSource })}>
                  {it.showSource ? 'hide source' : 'source'}
                </button>
                {it.status === 'running' && <span className="export-status">compiling…</span>}
                {it.status === 'done' && (it.result?.pdf ?? it.result?.tex) && (
                  <button type="button" className="btn ghost" onClick={() => void open((it.result?.pdf ?? it.result?.tex)!)}>
                    Open PDF
                  </button>
                )}
              </div>
              {it.error && <div className="ai-settings-err export-err">{it.error}</div>}
              {it.status === 'done' && <div className="export-path"><code>{it.result?.pdf ?? it.result?.tex}</code></div>}
              {it.showSource && <pre className="code-block export-preview">{docs[i].html}</pre>}
            </li>
          ))}
        </ul>

        {running && <pre ref={logRef} className="code-block export-log">{log.join('\n') || '…'}</pre>}

        <div className="export-bar">
          <button type="button" className="btn ghost" onClick={() => void openFolder()} title={folder ?? 'the export folder'}>
            Open folder
          </button>
          {folder && <span className="muted export-folder">{folder}</span>}
          <span className="spacer" />
          {finished && <button type="button" className="btn primary" onClick={onClose}>Close</button>}
        </div>
      </div>
    </Modal>
  );
}
