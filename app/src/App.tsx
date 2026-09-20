import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, errorText } from './api';
import type {
  Assignment, AssignmentList, Box, BridgeInfo, Course, Draft, DryRun, Question, Status, SubmitResult,
} from './types';
import { draftKey, matchesServer, pushHistory, serverDraft, useDrafts } from './lib/drafts';
import { coerceDraft } from './lib/ai';
import {
  cacheAssignment, cacheAge, cachedAssignment, canRefetch, CACHE_TTL_MS, clearCache, isAssignmentComplete, recordRefetch, updateCachedQuestion,
} from './lib/cache';
import { useUsage, fmtInt, fmtCost, pairTotal, pairCost } from './lib/usage';
import type { ExportMeta } from './lib/latex';
import { useSolver } from './lib/solver';
import { fmtDue, parseDue, questionStatus, relTime } from './lib/format';
import { QuestionView } from './components/QuestionView';
import { focusBox } from './components/BoxCard';
import { DryRunDialog, ShortcutsDialog, SubmitDialog } from './components/Dialogs';
import { AiPanel, AiSettingsDialog } from './components/AiPanel';
import { ContextMenu, type MenuItem } from './components/ContextMenu';
import { QuestionSkeleton } from './components/Skeleton';
import { ExportDialog, type ExportEntry } from './components/ExportDialog';
import { ConnectPanel, MIN_USERSCRIPT, Sidebar, StatusBar, Toasts, scriptCurrent, type Toast } from './components/Chrome';
import { Logo } from './components/Logo';

type Busy = 'save' | 'submit' | 'dry' | null;

function injectQuestionCss(css: string | null) {
  if (!css) return;
  let el = document.getElementById('wa-question-css') as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = 'wa-question-css';
    // Before our stylesheet so app overrides win.
    document.head.prepend(el);
  }
  el.textContent = css;
}

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

export default function App() {
  const [status, setStatus] = useState<Status | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [bridge, setBridge] = useState<BridgeInfo | null>(null);
  const [courses, setCourses] = useState<Course[]>([]);
  const [section, setSection] = useState<string | undefined>(() => store.get('wa.section') || undefined);
  const [list, setList] = useState<AssignmentList | null>(null);
  const [listLoading, setListLoading] = useState(false);
  const [selected, setSelected] = useState<number | null>(() => Number(store.get('wa.selected')) || null);
  const [multi, setMulti] = useState<number[]>([]);
  const [assignment, setAssignment] = useState<Assignment | null>(null);
  const [asgLoading, setAsgLoading] = useState(false);
  const [qnum, setQnum] = useState(1);
  const [busy, setBusy] = useState<Busy>(null);
  const [results, setResults] = useState<Record<string, SubmitResult>>({});
  const [confirm, setConfirm] = useState(false);
  const [dry, setDry] = useState<DryRun | null>(null);
  const [help, setHelp] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [aiOpen, setAiOpen] = useState(() => store.get('wa.ai.open') === '1');
  const [aiSettings, setAiSettings] = useState(false);
  const [exportEntries, setExportEntries] = useState<{ entries: ExportEntry[]; meta: ExportMeta } | null>(null);
  const [exportLoading, setExportLoading] = useState<{ done: number; total: number; label: string } | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const drafts = useDrafts();
  const usage = useUsage();
  const assignmentRef = useRef<Assignment | null>(null);

  const toast = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 8000 : 3500);
  }, []);

  // ---- bridge status -------------------------------------------------------
  useEffect(() => {
    let alive = true;
    const tick = async () => {
      try {
        const s = await api.status();
        if (alive) { setStatus(s); setStatusError(null); }
      } catch (e) {
        if (alive) { setStatus(null); setStatusError(errorText(e)); }
      }
      try {
        const b = await api.bridgeInfo();
        if (alive) setBridge(b);
      } catch { /* not in Tauri */ }
    };
    tick();
    const t = setInterval(tick, 2500);
    return () => { alive = false; clearInterval(t); };
  }, []);

  const connected = !!status?.connected;

  // ---- data loading --------------------------------------------------------
  const loadList = useCallback(async (sec?: string, quiet = false) => {
    if (!quiet) setListLoading(true);
    try {
      const l = await api.assignments(sec);
      setList(l);
      setSection(l.sectionId);
      store.set('wa.section', l.sectionId);
    } catch (e) {
      toast('err', errorText(e));
    } finally {
      setListLoading(false);
    }
  }, [toast]);

  // Assignments are cached in memory (lib/cache.ts). Switching back reuses the
  // cache; a completed assignment is never refetched; the rest refresh at most
  // once per TTL and within a per-session refetch budget. `force` (Ctrl+R) asks
  // for fresh data but still respects the budget.
  const loadAssignment = useCallback(async (id: number, force = false): Promise<Assignment | null> => {
    const cached = cachedAssignment(id);
    const complete = !!cached && isAssignmentComplete(cached);
    const stale = !!cached && (cacheAge(id) ?? 0) > CACHE_TTL_MS;
    const needFetch = !cached || force || (!complete && stale);

    const serve = (a: Assignment) => {
      assignmentRef.current = a;
      setAssignment(a);
      const saved = Number(store.get(`wa.q.${id}`));
      setQnum(a.questions.some((q) => q.number === saved) ? saved : a.questions[0]?.number ?? 1);
    };

    if (cached && !needFetch) { serve(cached); return cached; }
    if (cached && !canRefetch()) {
      toast('info', 'Refetch limit reached this session — using cached questions.');
      serve(cached);
      return cached;
    }

    setAsgLoading(true);
    try {
      const a = await api.assignment(id);
      if (cached) recordRefetch();
      cacheAssignment(a);
      serve(a);
      return a;
    } catch (e) {
      toast('err', errorText(e));
      if (cached) { serve(cached); return cached; }
      return null;
    } finally {
      setAsgLoading(false);
    }
  }, [toast]);

  // WebAssign's question-layout CSS, fetched once per session and cached for the next launch.
  const stylesLoaded = useRef(false);
  useEffect(() => {
    injectQuestionCss(store.get('wa.qcss.v1'));
  }, []);
  useEffect(() => {
    if (!connected || !assignment || stylesLoaded.current) return;
    stylesLoaded.current = true;
    api.styles(assignment.id)
      .then((r) => { injectQuestionCss(r.css); store.set('wa.qcss.v1', r.css); })
      .catch(() => { stylesLoaded.current = false; });
  }, [connected, assignment]);

  const wasConnected = useRef(false);
  useEffect(() => {
    if (connected && !wasConnected.current) {
      api.courses().then(setCourses).catch((e) => toast('err', errorText(e)));
      loadList(section);
      if (selected) loadAssignment(selected);
    }
    wasConnected.current = connected;
    // Only react to the link coming up.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connected]);

  const selectAssignment = (id: number, additive = false) => {
    if (additive) {
      setMulti((m) => (m.includes(id) ? m.filter((x) => x !== id) : [...m, id]));
      return;
    }
    setMulti([]);
    setSelected(id);
    store.set('wa.selected', String(id));
    if (assignment?.id !== id) {
      setAssignment(null);
      loadAssignment(id);
    }
  };

  const gotoQuestion = useCallback((n: number, focus = false) => {
    setQnum(n);
    if (assignment) store.set(`wa.q.${assignment.id}`, String(n));
    if (focus) requestAnimationFrame(() => focusBox(1));
  }, [assignment]);

  // ---- drafts --------------------------------------------------------------
  const question: Question | undefined = assignment?.questions.find((q) => q.number === qnum) ?? assignment?.questions[0];
  const dep = assignment?.id ?? 0;

  const draftOf = useCallback((q: Question, box: Box): Draft =>
    drafts.map[draftKey(dep, q.number, box.index)] ?? serverDraft(box), [drafts.map, dep]);

  const setDraft = useCallback((q: Question, box: Box, d: Draft) => {
    const key = draftKey(dep, q.number, box.index);
    if (matchesServer(box, d)) drafts.clear([key]);
    else drafts.set(key, d);
  }, [dep, drafts]);

  const unsavedIn = useCallback((q: Question) => q.boxes.filter((b) => !matchesServer(b, draftOf(q, b))), [draftOf]);

  const answersFor = (q: Question) =>
    Object.fromEntries(unsavedIn(q).map((b) => [String(b.index), draftOf(q, b)]));

  const replaceQuestion = (fresh: Question) => {
    const cur = assignmentRef.current;
    if (!cur) return;
    const next: Assignment = {
      ...cur,
      // Keep the previous markup if a response came back without it.
      questions: cur.questions.map((x) => (x.number === fresh.number ? { ...fresh, html: fresh.html ?? x.html } : x)),
    };
    assignmentRef.current = next;
    setAssignment(next);
    // Keep the cached copy and the sidebar summary in step, with no refetch.
    updateCachedQuestion(cur.id, fresh);
    const score = next.questions.reduce((s, q) => s + (q.score ?? 0), 0);
    const total = next.questions.reduce((s, q) => s + (q.total ?? 0), 0);
    setList((l) => {
      if (!l) return l;
      const patch = (arr: AssignmentList['current']) =>
        arr.map((x) => (x.id === next.id ? { ...x, score, total, percentage: total ? Math.round((score / total) * 100) : 0 } : x));
      return { ...l, current: patch(l.current), past: patch(l.past) };
    });
    // Drop drafts the server now agrees with.
    drafts.clear(fresh.boxes
      .filter((b) => {
        const d = drafts.map[draftKey(cur.id, fresh.number, b.index)];
        return d === undefined || matchesServer(b, d);
      })
      .map((b) => draftKey(cur.id, fresh.number, b.index)));
  };

  const rememberMath = (q: Question) =>
    pushHistory(unsavedIn(q).filter((b) => b.kind === 'math').map((b) => String(draftOf(q, b))));

  // ---- AI solver -----------------------------------------------------------
  const solver = useSolver({
    questionOf: (n) => assignmentRef.current?.questions.find((q) => q.number === n),
    applyAnswers: (q, answers) => {
      for (const [k, v] of Object.entries(answers)) {
        const box = q.boxes[Number(k) - 1];
        if (!box) continue;
        const d = coerceDraft(box, v);
        if (d !== null) setDraft(q, box, d);
      }
    },
    submit: async (q, answers) => {
      const id = assignmentRef.current?.id ?? 0;
      const r = await api.submit(id, q.number, answers as Record<string, Draft>);
      replaceQuestion(r.question);
      setResults((m) => ({ ...m, [`${id}:${q.number}`]: r }));
      return r;
    },
    afterGraded: () => { /* submit() already applied the regraded question */ },
    toast,
    recordUsage: (n, model, u) => {
      const a = assignmentRef.current;
      if (a) usage.record(a.id, a.name, n, model, u);
    },
    onQueueDone: (u) => toast('ok', `Assignment finished — ${fmtInt(pairTotal(u))} tokens · ~${fmtCost(pairCost(u))}`),
  });

  useEffect(() => { store.set('wa.ai.open', aiOpen ? '1' : '0'); }, [aiOpen]);
  // Keep the AI panel pointed at the question the user is looking at.
  useEffect(() => {
    if (qnum) solver.focus(qnum);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [qnum, assignment?.id]);
  // Follow the solver as it moves through the assignment.
  useEffect(() => {
    if (solver.qnum != null && solver.status !== 'idle' && solver.qnum !== qnum) {
      setQnum(solver.qnum);
      if (assignmentRef.current) store.set(`wa.q.${assignmentRef.current.id}`, String(solver.qnum));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [solver.qnum, solver.status]);

  const solveAssignment = async (id: number) => {
    setAiOpen(true);
    let a = assignmentRef.current;
    if (!a || a.id !== id) {
      a = await loadAssignment(id);
      if (!a) return;
    }
    setSelected(id);
    store.set('wa.selected', String(id));
    const nums = a.questions.map((q) => q.number);
    if (nums.length) void solver.start(nums);
  };

  const exportAssignment = async () => {
    const ids = [...new Set((multi.length ? [selected, ...multi] : [selected]).filter((x): x is number => x != null))];
    if (!ids.length) return;
    setExportLoading({ done: 0, total: ids.length, label: 'Loading assignments…' });
    await new Promise((r) => setTimeout(r, 30));
    try {
      const course = courses.find((c) => c.sectionId === section);
      const meta = { course: course?.course, section: course?.section, term: course?.term };
      const entries: ExportEntry[] = [];
      for (let i = 0; i < ids.length; i++) {
        const id = ids[i];
        setExportLoading({ done: i, total: ids.length, label: `Loading assignment ${i + 1} of ${ids.length}…` });
        await new Promise((r) => setTimeout(r, 0));
        let a: Assignment | null = assignmentRef.current?.id === id ? assignmentRef.current : cachedAssignment(id);
        if (!a) {
          try { a = await api.assignment(id); cacheAssignment(a); } catch { a = null; }
        }
        if (a) entries.push({ id: a.id, name: a.name || `Assignment ${a.id}`, assignment: a });
        setExportLoading({ done: i + 1, total: ids.length, label: 'Preparing…' });
      }
      // The dialog builds the LaTeX itself, so its options can change it.
      if (entries.length) setExportEntries({ entries, meta });
    } finally {
      setExportLoading(null);
    }
  };

  const assignmentMenu = (id: number): MenuItem[] => [
    { kind: 'item', label: 'Solve with AI', hint: 'all', onClick: () => void solveAssignment(id) },
    { kind: 'item', label: 'Open AI chat', onClick: () => setAiOpen(true) },
    { kind: 'sep' },
    { kind: 'item', label: 'Export LaTeX / PDF…', onClick: () => exportAssignment() },
    { kind: 'sep' },
    { kind: 'item', label: 'AI settings…', onClick: () => { setAiOpen(true); setAiSettings(true); } },
  ];

  const questionMenu = (n: number): MenuItem[] => {
    const all = assignmentRef.current?.questions.map((q) => q.number) ?? [];
    return [
      { kind: 'item', label: `Solve Q${n} with AI`, onClick: () => { setAiOpen(true); void solver.start([n]); } },
      { kind: 'item', label: `Solve Q${n} → end`, disabled: all.filter((x) => x >= n).length < 2, onClick: () => { setAiOpen(true); void solver.start(all.filter((x) => x >= n)); } },
      { kind: 'sep' },
      { kind: 'item', label: 'Open AI chat', onClick: () => setAiOpen(true) },
      { kind: 'item', label: 'AI settings…', onClick: () => { setAiOpen(true); setAiSettings(true); } },
    ];
  };

  // ---- actions -------------------------------------------------------------
  const save = async () => {
    if (!question || busy) return;
    const answers = answersFor(question);
    if (!Object.keys(answers).length) { toast('info', 'Nothing to save — everything matches WebAssign.'); return; }
    setBusy('save');
    try {
      rememberMath(question);
      const r = await api.save(dep, question.number, answers);
      const fresh = await api.question(dep, question.number);
      replaceQuestion(fresh);
      toast(r.saved ? 'ok' : 'info', r.saved ? `Q${question.number} saved to WebAssign` : r.reason ?? 'Not saved');
    } catch (e) {
      toast('err', `Save failed: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    setConfirm(false);
    if (!question || busy) return;
    setBusy('submit');
    try {
      rememberMath(question);
      const r = await api.submit(dep, question.number, answersFor(question));
      replaceQuestion(r.question);
      setResults((m) => ({ ...m, [`${dep}:${question.number}`]: r }));
      const wrong = r.results.filter((x) => x.status === 'incorrect').length;
      toast(r.allCorrect ? 'ok' : 'err', r.allCorrect ? `Q${question.number}: all correct` : `Q${question.number}: ${wrong} wrong`);
    } catch (e) {
      toast('err', `Submit failed: ${errorText(e)}`);
    } finally {
      setBusy(null);
    }
  };

  const dryRun = async () => {
    if (!question || busy) return;
    setBusy('dry');
    try {
      setDry(await api.dryRun(dep, question.number, answersFor(question)));
    } catch (e) {
      toast('err', errorText(e));
    } finally {
      setBusy(null);
    }
  };

  const reload = () => {
    if (selected) loadAssignment(selected, true);
    loadList(section, true);
  };

  const clearQuestionCache = () => {
    clearCache();
    const id = assignmentRef.current?.id;
    if (id) {
      assignmentRef.current = null;
      setAssignment(null);
      loadAssignment(id, true);
    }
    toast('info', 'Question cache cleared — questions will be refetched.');
  };

  // ---- keyboard ------------------------------------------------------------
  const keyState = useRef({ save, submit: () => setConfirm(true), reload, gotoQuestion, question, assignment });
  keyState.current = { save, submit: () => setConfirm(true), reload, gotoQuestion, question, assignment };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'F1') { e.preventDefault(); setHelp((h) => !h); return; }
      if (document.querySelector('.modal')) return;
      const k = keyState.current;
      const qs = k.assignment?.questions ?? [];
      const idx = qs.findIndex((q) => q.number === k.question?.number);
      if (e.ctrlKey && e.key.toLowerCase() === 's') { e.preventDefault(); k.save(); }
      else if (e.ctrlKey && e.key === 'Enter') { e.preventDefault(); if (k.question) k.submit(); }
      else if (e.ctrlKey && e.key.toLowerCase() === 'r') { e.preventDefault(); k.reload(); }
      else if (e.altKey && (e.key === 'ArrowRight' || e.key === 'ArrowLeft') && qs.length) {
        e.preventDefault();
        const next = qs[(idx + (e.key === 'ArrowRight' ? 1 : -1) + qs.length) % qs.length];
        k.gotoQuestion(next.number, true);
      } else if (e.altKey && (e.key === 'ArrowDown' || e.key === 'ArrowUp') && k.question?.boxes.length) {
        e.preventDefault();
        const cur = (document.activeElement as HTMLElement | null)?.closest('section.box');
        const n = k.question.boxes.length;
        const at = cur ? Number(cur.id.replace('box-', '')) : 0;
        let next = at + (e.key === 'ArrowDown' ? 1 : -1);
        if (next < 1) next = n;
        if (next > n) next = 1;
        focusBox(next);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // ---- render --------------------------------------------------------------
  const summary = useMemo(
    () => [...(list?.current ?? []), ...(list?.past ?? [])].find((a) => a.id === selected),
    [list, selected],
  );
  const due = summary ? parseDue(summary.due) : null;
  const aiQuestion = (solver.qnum != null ? assignment?.questions.find((q) => q.number === solver.qnum) : undefined) ?? question;
  const busyText = busy === 'save' ? 'saving' : busy === 'submit' ? 'submitting' : busy === 'dry' ? 'building request'
    : asgLoading ? 'loading assignment' : listLoading ? 'loading assignments' : null;

  return (
    <div className={`app${aiOpen ? ' ai-open' : ''}`}>
      <header className="topbar">
        <div className="logo"><Logo className="logo-mark" /><span>WA DESK</span></div>
        <div className="crumb">
          {assignment ? (
            <>
              <span className="crumb-name">{assignment.name}</span>
              {due && <span className="muted" title={fmtDue(due)}>due {relTime(due)}</span>}
            </>
          ) : <span className="muted">no assignment selected</span>}
        </div>
        <span className="spacer" />
        {summary?.total != null && (
          <div className="total">
            <span className="total-num">{summary.score ?? 0}</span>
            <span className="muted">/{summary.total}</span>
          </div>
        )}
        <button type="button" className="icon-btn" onClick={reload} title="Reload from WebAssign (Ctrl+R)" disabled={!connected}>⟳</button>
        <button
          type="button"
          className="icon-btn"
          disabled={!connected || !assignment}
          title="Export assignment (LaTeX / PDF)"
          onClick={() => exportAssignment()}
        >
          ⤓
        </button>
      </header>

      <Sidebar
        list={list}
        loading={listLoading}
        selected={selected}
        multi={multi}
        onSelect={selectAssignment}
        courses={courses}
        section={section}
        onSection={(s) => loadList(s)}
        onRefresh={() => loadList(section)}
        onContext={(a, e) => setMenu({ x: e.clientX, y: e.clientY, items: assignmentMenu(a.id) })}
        onAiSettings={() => setAiSettings(true)}
      />

      <main className="main">
        {!connected ? (
          <ConnectPanel
            status={status}
            statusError={statusError}
            bridge={bridge}
            onRestart={async () => {
              try { setBridge(await api.restartBridge()); } catch (e) { toast('err', errorText(e)); }
            }}
          />
        ) : !selected ? (
          <div className="empty big">← pick an assignment</div>
        ) : !assignment ? (
          <QuestionSkeleton />
        ) : (
          <>
            {!scriptCurrent(status?.userscriptVersion) && (
              <div className="notice">
                <b>Userscript outdated</b> ({status?.userscriptVersion ?? 'before 0.3.0'}). Reinstall{' '}
                <code>webassign-mathpad.user.js</code> ({MIN_USERSCRIPT}+) in Tampermonkey and reload the WebAssign tab.
                Until then, questions show as plain text and grading marks may be missing.
              </div>
            )}
            <nav className="qstrip">
              {assignment.questions.map((q) => {
                const st = questionStatus(q);
                const dirty = unsavedIn(q).length > 0;
                return (
                  <button
                    type="button"
                    key={q.number}
                    className={`qcell status-${st}${q.number === question?.number ? ' on' : ''}`}
                    onClick={() => gotoQuestion(q.number)}
                    onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: questionMenu(q.number) }); }}
                    title={`Q${q.number} · ${q.score ?? '–'}/${q.total ?? '?'} · ${q.submissions ?? ''}${dirty ? ' · unsaved edits' : ''} (right-click to solve with AI)`}
                  >
                    {q.number}
                    {dirty && <i className="dirty" />}
                  </button>
                );
              })}
            </nav>
            {question && (
              <QuestionView
                key={`${dep}:${question.number}`}
                question={question}
                draftOf={(b) => draftOf(question, b)}
                setDraft={(b, d) => setDraft(question, b, d)}
                unsavedCount={unsavedIn(question).length}
                busy={busy}
                result={results[`${dep}:${question.number}`]}
                onSave={save}
                onSubmit={() => setConfirm(true)}
                onDryRun={dryRun}
                onRevert={() => drafts.clear(question.boxes.map((b) => draftKey(dep, question.number, b.index)))}
              />
            )}
          </>
        )}
      </main>

      <AiPanel
        solver={solver}
        question={aiQuestion}
        questions={assignment?.questions.map((q) => q.number) ?? []}
        open={aiOpen}
        onOpenSettings={() => setAiSettings(true)}
        onClose={() => setAiOpen(false)}
      />

      <StatusBar status={status} bridge={bridge} busyText={busyText} onHelp={() => setHelp(true)} />
      <Toasts items={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />

      {confirm && question && (
        <SubmitDialog question={question} draftOf={(b) => draftOf(question, b)} onConfirm={submit} onClose={() => setConfirm(false)} />
      )}
      {dry && <DryRunDialog dry={dry} onClose={() => setDry(null)} />}
      {help && <ShortcutsDialog onClose={() => setHelp(false)} />}
      {aiSettings && (
        <AiSettingsDialog
          usageMap={usage.map}
          onClose={() => setAiSettings(false)}
          onClearCache={clearQuestionCache}
          onSaved={(c) => {
            solver.reloadConfig();
            solver.reloadPython();
            toast('ok', `AI settings saved (${c.hasKey ? 'key set' : 'no key'}).`);
          }}
          onPythonChanged={() => solver.reloadPython()}
        />
      )}
      {exportLoading && (
        <div className="export-loading">
          <div className="export-loading-box">
            <div className="export-loading-label">{exportLoading.label}</div>
            <div className="export-progress">
              <i style={{ width: `${exportLoading.total ? Math.round((exportLoading.done / exportLoading.total) * 100) : 0}%` }} />
            </div>
            <div className="muted">{exportLoading.done} / {exportLoading.total}</div>
          </div>
        </div>
      )}
      {exportEntries && (
        <ExportDialog entries={exportEntries.entries} meta={exportEntries.meta} onClose={() => setExportEntries(null)} />
      )}
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}
    </div>
  );
}
