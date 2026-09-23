import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { BookOpen, CalendarDays, ChevronRight, Search, ClipboardCheck, Globe, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Settings as SettingsIcon, Timer } from 'lucide-react';
import App from './App';
import { AiSettingsDialog } from './components/AiPanel';
import { TabModeDialog } from './components/TabMode';
import { useChatRunCount } from './lib/chatRuns';
import { useTasks } from './lib/salem/tasks';
import { needsOnboarding, Onboarding } from './components/Onboarding';
import { inTabMode } from './lib/tabClient';
import { solverEnabled, useSolverEnabled } from './lib/features';
import { Logo } from './components/Logo';
import { ContextMenu, type MenuItem } from './components/ContextMenu';
import { Toasts, type Toast } from './components/Chrome';
import { studyApi, type NotebookSummary, type SubjectNode } from './study/api';
import { NotebookPage, StudyHome, SubjectPage, type Route, type StudyActions } from './study/pages';
import { ConfirmDialog, NameDialog } from './study/dialogs';
import { ChatPage } from './study/ChatPage';
import { SchedulePage } from './study/Schedule';
import { SearchPalette } from './components/SearchPalette';
import { SubjectIcon, subjectColor } from './components/subjectIcons';
import { FocusPage, PomodoroAlarm } from './components/Pomodoro';
import { OpenFocus, ViewBar } from './components/ViewBar';
import { fmtClock, remainingOf, usePomodoro } from './lib/pomodoro';

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { /* ignore */ } },
};

function loadRoute(): Route {
  try {
    const r = JSON.parse(store.get('wa.route') || '') as Route;
    if (r && ['solver', 'study', 'chat', 'focus', 'schedule', 'subject', 'notebook'].includes(r.kind)) return r;
  } catch { /* default */ }
  return { kind: 'study' };
}

type Dialog =
  | { kind: 'new-subject' }
  | { kind: 'rename-subject'; subject: SubjectNode }
  | { kind: 'delete-subject'; subject: SubjectNode }
  | { kind: 'new-notebook'; subjectId: number }
  | { kind: 'edit-notebook'; notebook: NotebookSummary }
  | { kind: 'delete-notebook'; notebook: NotebookSummary };

/**
 * Top level: a global sidebar with the two products. The solver stays mounted
 * while Study is open, so a running solve or unsaved draft survives switching.
 */
export default function Shell() {
  const solverOn = useSolverEnabled();
  const [route, setRoute] = useState<Route>(() => { const r = loadRoute(); return r.kind === 'solver' && !solverEnabled() ? { kind: 'study' } : r; });
  // Turning the solver off while it is open goes back to Study.
  useEffect(() => { if (!solverOn && route.kind === 'solver') setRoute({ kind: 'study' }); }, [solverOn, route.kind]);
  // The switch lives in Settings, whose host changes with it: keep the dialog open across the swap.
  const lastSolver = useRef(solverOn);
  useEffect(() => {
    if (lastSolver.current === solverOn) return;
    lastSolver.current = solverOn;
    if (solverOn) { setSettingsOpen(false); setSettingsSignal((n) => n + 1); } else setSettingsOpen(true);
  }, [solverOn]);
  const [tree, setTree] = useState<SubjectNode[] | null>(null);
  const [folded, setFolded] = useState<number[]>(() => {
    try { return JSON.parse(store.get('wa.nav.folded') || '[]'); } catch { return []; }
  });
  const [navSmall, setNavSmall] = useState(() => store.get('wa.nav.small') === '1');
  // Work the student cannot see from where they are standing. The sidebar is
  // the one thing always on screen, so it is where "something is happening"
  // belongs.
  const chatsRunning = useChatRunCount();
  const studyRunning = useTasks().filter((t) => !['completed', 'failed', 'cancelled'].includes(t.state)).length;
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [settingsSignal, setSettingsSignal] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Tab mode is the window serving the app to a browser, so it is offered
  // only in the window — a tab cannot hand out its own address.
  const [tabModeOpen, setTabModeOpen] = useState(false);
  /** Shown once on startup when something Salem needs is not installed. */
  const [onboarding, setOnboarding] = useState(false);
  useEffect(() => {
    // A moment's grace so it does not race the window opening.
    const t = window.setTimeout(() => { void needsOnboarding().then(setOnboarding).catch(() => {}); }, 1200);
    return () => window.clearTimeout(t);
  }, []);
  const canServe = !inTabMode();
  const [searching, setSearching] = useState(false);
  // ⌘K / Ctrl+K opens search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); setSearching((v) => !v); }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  const [lastChat, setLastChat] = useState<number | null>(() => Number(store.get('wa.chat.last')) || null);

  const toast = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t.slice(-3), { id, kind, text }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === 'err' ? 8000 : 3500);
  }, []);

  /** Bumped on every reload of the study space, for views that cache from it. */
  const [treeVersion, setTreeVersion] = useState(0);
  const refresh = useCallback(async () => {
    try { setTree(await studyApi.tree()); } catch (e) { toast('err', `Study: ${String(e)}`); setTree([]); }
    setTreeVersion((n) => n + 1);
  }, [toast]);

  useEffect(() => { refresh(); }, [refresh]);
  const refreshTree = useCallback(async () => {
    const t = await studyApi.tree();
    setTree(t);
    return t;
  }, []);
  useEffect(() => {
    // A one-off target (a search hit) is not reopened on the next launch.
    store.set('wa.route', JSON.stringify(route.kind === 'notebook' ? { kind: 'notebook', id: route.id } : route));
    if (route.kind === 'chat') { setLastChat(route.id ?? null); store.set('wa.chat.last', String(route.id ?? '')); }
  }, [route]);
  useEffect(() => { store.set('wa.nav.folded', JSON.stringify(folded)); }, [folded]);
  useEffect(() => { store.set('wa.nav.small', navSmall ? '1' : '0'); }, [navSmall]);

  const subjectOf = (id: number) => tree?.find((s) => s.id === id);
  const notebookOf = (id: number) => {
    for (const s of tree ?? []) {
      const n = s.notebooks.find((x) => x.id === id);
      if (n) return { notebook: n, subject: s };
    }
    return null;
  };

  // A route to something that was deleted falls back to the Study overview.
  useEffect(() => {
    if (!tree) return;
    if ((route.kind === 'subject' && !subjectOf(route.id)) || (route.kind === 'notebook' && !notebookOf(route.id))) {
      setRoute({ kind: 'study' });
    }
  });

  const open = useCallback((r: Route) => {
    setRoute(r);
    if (r.kind === 'notebook') {
      const hit = tree?.find((s) => s.notebooks.some((n) => n.id === r.id));
      if (hit) setFolded((f) => f.filter((x) => x !== hit.id));
    }
  }, [tree]);

  const actions: StudyActions = useMemo(() => ({
    open,
    newSubject: () => setDialog({ kind: 'new-subject' }),
    newNotebook: (subjectId) => setDialog({ kind: 'new-notebook', subjectId }),
    renameSubject: (subject) => setDialog({ kind: 'rename-subject', subject }),
    deleteSubject: (subject) => setDialog({ kind: 'delete-subject', subject }),
    editNotebook: (notebook) => setDialog({ kind: 'edit-notebook', notebook }),
    deleteNotebook: (notebook) => setDialog({ kind: 'delete-notebook', notebook }),
    saveSubjectContext: async (id, context) => { await studyApi.updateSubject(id, { context }); await refresh(); },
    refresh: () => { void refresh(); },
  }), [open, refresh]);

  const subjectMenu = (s: SubjectNode): MenuItem[] => [
    { kind: 'item', label: 'Open', onClick: () => open({ kind: 'subject', id: s.id }) },
    { kind: 'item', label: 'New notebook…', onClick: () => actions.newNotebook(s.id) },
    { kind: 'item', label: 'Rename…', onClick: () => actions.renameSubject(s) },
    { kind: 'sep' },
    { kind: 'item', label: 'Delete subject…', danger: true, onClick: () => actions.deleteSubject(s) },
  ];
  const notebookMenu = (n: NotebookSummary): MenuItem[] => [
    { kind: 'item', label: 'Open', onClick: () => open({ kind: 'notebook', id: n.id }) },
    { kind: 'item', label: 'Edit…', onClick: () => actions.editNotebook(n) },
    { kind: 'sep' },
    { kind: 'item', label: 'Delete notebook…', danger: true, onClick: () => actions.deleteNotebook(n) },
  ];

  const inStudy = route.kind !== 'solver';
  // Views cross-fade when the route changes; chats switch inside the chat view.
  const viewKey = route.kind === 'chat' ? 'chat' : `${route.kind}:${'id' in route ? route.id : ''}`;
  const openFocus = useCallback(() => setRoute({ kind: 'focus' }), []);
  const activeSubject = route.kind === 'subject' ? route.id : route.kind === 'notebook' ? notebookOf(route.id)?.subject.id : undefined;

  let page: React.ReactNode = null;
  if (route.kind === 'study') page = tree && <StudyHome tree={tree} actions={actions} />;
  if (route.kind === 'chat') page = <ChatPage threadId={route.id ?? null} tree={tree ?? []} open={open} refreshTree={refreshTree} />;
  if (route.kind === 'schedule') page = <SchedulePage tree={tree ?? []} open={open} refreshTree={() => void refresh()} reload={treeVersion} />;
  if (route.kind === 'focus') page = <div className="view"><ViewBar><span className="viewbar-name">Focus</span></ViewBar><FocusPage /></div>;
  if (route.kind === 'subject') {
    const s = subjectOf(route.id);
    page = s && <SubjectPage subject={s} actions={actions} />;
  }
  if (route.kind === 'notebook') {
    const hit = notebookOf(route.id);
    page = hit && <NotebookPage key={`${hit.notebook.id}:${route.open ? JSON.stringify(route.open) : ''}`} notebook={hit.notebook} subject={hit.subject} actions={actions} target={route.open} />;
  }

  return (
    <div className={`shell${navSmall ? ' nav-small' : ''}`}>
      <nav className="nav">
        <div className="nav-brand">
          <Logo className="nav-logo" />
          {!navSmall && <span className="nav-name">SalemStudy</span>}
          <span className="spacer" />
          <button type="button" className="nav-fold" onClick={() => setNavSmall((v) => !v)} title={navSmall ? 'Expand sidebar' : 'Collapse sidebar'}>
            {navSmall ? <PanelLeftOpen /> : <PanelLeftClose />}
          </button>
        </div>

        <button type="button" className="nav-search" onClick={() => setSearching(true)} title="Search everything (⌘K)">
          <Search className="nav-glyph" />{!navSmall && <><span>Search</span><kbd>⌘K</kbd></>}
        </button>
        <div className="nav-scroll">
          <button type="button" className={`nav-item${route.kind === 'chat' ? ' on' : ''}`} onClick={() => open({ kind: 'chat', id: route.kind === 'chat' ? route.id : lastChat })} title={chatsRunning ? `${chatsRunning} answer${chatsRunning === 1 ? '' : 's'} being written` : 'Chat'}>
            <MessageSquare className="nav-glyph" />{!navSmall && <span>Chat</span>}
            {chatsRunning > 0 && <Busy what={`${chatsRunning} answer${chatsRunning === 1 ? '' : 's'} being written`} />}
          </button>
          <FocusNavItem on={route.kind === 'focus'} small={navSmall} onClick={() => open({ kind: 'focus' })} />
          <button type="button" className={`nav-item${route.kind === 'schedule' ? ' on' : ''}`} onClick={() => open({ kind: 'schedule' })} title="Schedule">
            <CalendarDays className="nav-glyph" />{!navSmall && <span>Schedule</span>}
          </button>
          <button type="button" className={`nav-item${route.kind === 'study' ? ' on' : ''}`} onClick={() => open({ kind: 'study' })} title={studyRunning ? `${studyRunning} thing${studyRunning === 1 ? '' : 's'} being made` : 'Study'}>
            <BookOpen className="nav-glyph" />{!navSmall && <span>Study</span>}
            {studyRunning > 0 && <Busy what={`${studyRunning} thing${studyRunning === 1 ? '' : 's'} being made`} />}
          </button>

          {!navSmall && (
            <div className="nav-tree">
              {tree?.map((s) => {
                const isFolded = folded.includes(s.id);
                return (
                  <div key={s.id} className="nav-subject">
                    <div
                      className={`nav-row subject${route.kind === 'subject' && route.id === s.id ? ' on' : ''}${activeSubject === s.id ? ' within' : ''}`}
                      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: subjectMenu(s) }); }}
                    >
                      <button
                        type="button"
                        className="nav-caret"
                        onClick={() => setFolded((f) => (isFolded ? f.filter((x) => x !== s.id) : [...f, s.id]))}
                        title={isFolded ? 'Expand' : 'Collapse'}
                      >
                        <ChevronRight className={isFolded ? '' : 'open'} />
                      </button>
                      <button type="button" className="nav-label" onClick={() => open({ kind: 'subject', id: s.id })} style={{ '--subject': subjectColor(s) } as React.CSSProperties}>
                        <SubjectIcon icon={s.icon} name={s.name} className="nav-subject-icon" />{s.name}
                      </button>
                    </div>
                    <div className={`collapse${isFolded ? '' : ' open'}`}><div>
                    {s.notebooks.map((n) => (
                      <button
                        type="button"
                        key={n.id}
                        className={`nav-row notebook${route.kind === 'notebook' && route.id === n.id ? ' on' : ''}`}
                        onClick={() => open({ kind: 'notebook', id: n.id })}
                        onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: notebookMenu(n) }); }}
                      >
                        <span className="nav-label">{n.name}</span>
                        {n.sourceCount > 0 && <span className="nav-count" title={`${n.sourceCount} sources`}>{n.sourceCount}</span>}
                      </button>
                    ))}
                    {s.notebooks.length === 0 && (
                      <button type="button" className="nav-row notebook ghost" onClick={() => actions.newNotebook(s.id)}><Plus />notebook</button>
                    )}
                    </div></div>
                  </div>
                );
              })}
              <button type="button" className="nav-row add" onClick={actions.newSubject}><Plus />New subject</button>
            </div>
          )}
        </div>

        <div className="nav-foot">
          {solverOn && (
            <button type="button" className={`nav-item${route.kind === 'solver' ? ' on' : ''}`} onClick={() => open({ kind: 'solver' })} title="Assignment Solver">
              <ClipboardCheck className="nav-glyph" />{!navSmall && <span>Assignment Solver</span>}
            </button>
          )}
          {canServe && (
            <button type="button" className="nav-item" onClick={() => setTabModeOpen(true)} title="Open Salem in a browser tab">
              <Globe className="nav-glyph" />{!navSmall && <span>Open in a tab</span>}
            </button>
          )}
          <button type="button" className="nav-item" onClick={() => (solverOn ? setSettingsSignal((n) => n + 1) : setSettingsOpen(true))} title="Settings">
            <SettingsIcon className="nav-glyph" />{!navSmall && <span>Settings</span>}
          </button>
        </div>
      </nav>

      <OpenFocus.Provider value={openFocus}>
        {/* The solver owns the settings dialog while it is mounted (saving reloads its config). */}
        {solverOn ? (
          <div className="shell-pane" hidden={inStudy}>
            <App active={!inStudy} settingsSignal={settingsSignal} />
          </div>
        ) : settingsOpen && (
          <AiSettingsDialog onClose={() => setSettingsOpen(false)} onSaved={() => {}} onClearCache={() => {}} onPythonChanged={() => {}} />
        )}
        {inStudy && <div className="shell-pane study" key={viewKey}>{page}</div>}
      </OpenFocus.Provider>
      {tabModeOpen && <TabModeDialog onClose={() => setTabModeOpen(false)} />}
      {onboarding && <Onboarding onClose={() => setOnboarding(false)} />}
      <PomodoroAlarm />
      {searching && <SearchPalette tree={tree ?? []} open={open} onClose={() => setSearching(false)} />}

      <Toasts items={toasts} onDismiss={(id) => setToasts((t) => t.filter((x) => x.id !== id))} />
      {menu && <ContextMenu x={menu.x} y={menu.y} items={menu.items} onClose={() => setMenu(null)} />}

      {dialog?.kind === 'new-subject' && (
        <NameDialog
          title="New subject" label="Name" submitLabel="Create" onClose={() => setDialog(null)}
          onSubmit={async (name) => { const id = await studyApi.createSubject(name); await refresh(); open({ kind: 'subject', id }); }}
        />
      )}
      {dialog?.kind === 'rename-subject' && (
        <NameDialog
          title="Rename subject" label="Name" initial={dialog.subject.name} submitLabel="Save" onClose={() => setDialog(null)}
          onSubmit={async (name) => { await studyApi.updateSubject(dialog.subject.id, { name }); await refresh(); }}
        />
      )}
      {dialog?.kind === 'new-notebook' && (
        <NameDialog
          title={`New notebook in ${subjectOf(dialog.subjectId)?.name ?? 'subject'}`} label="Name" withDescription submitLabel="Create"
          onClose={() => setDialog(null)}
          onSubmit={async (name, description) => {
            const id = await studyApi.createNotebook(dialog.subjectId, name, description);
            await refresh();
            open({ kind: 'notebook', id });
          }}
        />
      )}
      {dialog?.kind === 'edit-notebook' && (
        <NameDialog
          title="Edit notebook" label="Name" initial={dialog.notebook.name} withDescription initialDescription={dialog.notebook.description}
          submitLabel="Save" onClose={() => setDialog(null)}
          onSubmit={async (name, description) => { await studyApi.updateNotebook(dialog.notebook.id, { name, description }); await refresh(); }}
        />
      )}
      {dialog?.kind === 'delete-subject' && (
        <ConfirmDialog
          title="Delete subject" confirmLabel="Delete subject" onClose={() => setDialog(null)}
          onConfirm={async () => { await studyApi.deleteSubject(dialog.subject.id); await refresh(); }}
        >
          Delete <b>{dialog.subject.name}</b> and its {dialog.subject.notebooks.length} notebook(s), including every
          source, chat, flashcard and quiz in them, and everything it has in your schedule?
          This cannot be undone.
        </ConfirmDialog>
      )}
      {dialog?.kind === 'delete-notebook' && (
        <ConfirmDialog
          title="Delete notebook" confirmLabel="Delete notebook" onClose={() => setDialog(null)}
          onConfirm={async () => { await studyApi.deleteNotebook(dialog.notebook.id); await refresh(); }}
        >
          Delete <b>{dialog.notebook.name}</b> with its {dialog.notebook.sourceCount} source(s), chats, flashcards and
          quizzes? This cannot be undone.
        </ConfirmDialog>
      )}
    </div>
  );
}

/** Sidebar entry for the timer; shows the countdown while it runs. */
/** "Something is happening over here." A dot, not a number. */
function Busy({ what }: { what: string }) {
  return <span className="nav-busy" role="status" aria-label={what} title={what} />;
}

function FocusNavItem({ on, small, onClick }: { on: boolean; small: boolean; onClick: () => void }) {
  const p = usePomodoro();
  const live = p.status !== 'idle';
  return (
    <button type="button" className={`nav-item${on ? ' on' : ''}${live ? ` live ${p.phase}` : ''}`} onClick={onClick} title="Focus timer">
      <Timer className="nav-glyph" />
      {!small && <span>Focus</span>}
      {!small && live && <span className={`nav-timer${p.status === 'paused' ? ' paused' : ''}`}>{fmtClock(remainingOf(p))}</span>}
    </button>
  );
}
