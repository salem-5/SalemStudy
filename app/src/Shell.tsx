import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { ArrowUpRight, CalendarDays, ChevronRight, Pencil, Search, Trash, ClipboardCheck, Globe, House, MessageSquare, PanelLeftClose, PanelLeftOpen, Plus, Settings as SettingsIcon, StickyNote, Timer } from 'lucide-react';
import { NotesApp } from './study/NotesApp';
import App from './App';
import { AiSettingsDialog } from './components/AiPanel';
import { TabModeDialog } from './components/TabMode';
import { UpdateCenter } from './components/Updates';
import { useChatRunCount } from './lib/chatRuns';
import { useTasks } from './lib/salem/tasks';
import { needsOnboarding, Onboarding, OPEN_SETUP } from './components/Onboarding';
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
import { WindowBar } from './components/WindowBar';
import { fmtClock, remainingOf, usePomodoro } from './lib/pomodoro';
import { keys } from './lib/keys';
import { morph } from './lib/morph';

/** The window's traffic lights as traffic.rs reports them, in points. */
type Lights = { button: number; naturalStep: number; tightStep: number; width: number };
/** As long as the sidebar's own fold (--dur-3), with the same strong ease-out. */
const LIGHTS_MS = 260;
const placeLights = (compact: number) => import('@tauri-apps/api/core')
  .then(({ invoke }) => invoke<Lights | null>('traffic_lights', { compact }))
  .catch(() => null);

const store = {
  get: (k: string) => { try { return localStorage.getItem(k); } catch { return null; } },
  set: (k: string, v: string) => { try { localStorage.setItem(k, v); } catch { } },
};

function loadRoute(): Route {
  try {
    const r = JSON.parse(store.get('wa.route') || '') as Route;
    if (r && ['solver', 'study', 'chat', 'focus', 'schedule', 'subject', 'notebook'].includes(r.kind)) return r;
  } catch { }
  return { kind: 'study' };
}

type Dialog =
  | { kind: 'new-subject' }
  | { kind: 'rename-subject'; subject: SubjectNode }
  | { kind: 'delete-subject'; subject: SubjectNode }
  | { kind: 'new-notebook'; subjectId: number }
  | { kind: 'edit-notebook'; notebook: NotebookSummary }
  | { kind: 'delete-notebook'; notebook: NotebookSummary };

export default function Shell() {
  const solverOn = useSolverEnabled();
  const [route, setRoute] = useState<Route>(() => { const r = loadRoute(); return r.kind === 'solver' && !solverEnabled() ? { kind: 'study' } : r; });
  useEffect(() => { if (!solverOn && route.kind === 'solver') setRoute({ kind: 'study' }); }, [solverOn, route.kind]);
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
  const chatsRunning = useChatRunCount();
  const studyRunning = useTasks().filter((t) => !['completed', 'failed', 'cancelled'].includes(t.state)).length;
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [settingsSignal, setSettingsSignal] = useState(0);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [tabModeOpen, setTabModeOpen] = useState(false);
  const [onboarding, setOnboarding] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => { void needsOnboarding().then(setOnboarding).catch(() => {}); }, 1200);
    const show = () => setOnboarding(true);
    window.addEventListener(OPEN_SETUP, show);
    return () => { window.clearTimeout(t); window.removeEventListener(OPEN_SETUP, show); };
  }, []);
  const canServe = !inTabMode();
  const [searching, setSearching] = useState(false);
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
    store.set('wa.route', JSON.stringify(route.kind === 'notebook' ? { kind: 'notebook', id: route.id } : route));
    if (route.kind === 'chat') { setLastChat(route.id ?? null); store.set('wa.chat.last', String(route.id ?? '')); }
  }, [route]);
  useEffect(() => { store.set('wa.nav.folded', JSON.stringify(folded)); }, [folded]);
  useEffect(() => { store.set('wa.nav.small', navSmall ? '1' : '0'); }, [navSmall]);
  // On a Mac the window's own lights sit in the sidebar. As it folds they close up, frame by frame
  // with the sidebar's own animation, and the folded sidebar is sized from their width so they sit
  // in its middle. AppKit can lay them out again when the window changes size, so they are put
  // back then too.
  const lights = useRef<{ metrics: Lights | null; compact: number | null }>({ metrics: null, compact: null });
  useLayoutEffect(() => {
    if (document.documentElement.dataset.chrome !== 'mac') return;
    const target = navSmall ? 1 : 0;
    const from = lights.current.compact ?? target;
    let alive = true;
    let raf = 0;
    const widthAt = (m: Lights, c: number) => 2 * (m.naturalStep + (m.tightStep - m.naturalStep) * c) + m.button;
    const setWidth = (m: Lights) => document.documentElement.style.setProperty('--lights-w', `${widthAt(m, target)}px`);
    // Known from before: set the width now, in the same frame the sidebar starts to move.
    if (lights.current.metrics) setWidth(lights.current.metrics);
    void placeLights(from).then((m) => {
      if (!m || !alive) return;
      lights.current.metrics = m;
      setWidth(m);
      if (from === target) { lights.current.compact = target; return; }
      const start = performance.now();
      const tick = (now: number) => {
        const t = Math.min(1, (now - start) / LIGHTS_MS);
        const c = from + (target - from) * (1 - (1 - t) ** 5);
        lights.current.compact = c;
        void placeLights(c);
        if (t < 1 && alive) raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    });
    return () => { alive = false; cancelAnimationFrame(raf); };
  }, [navSmall]);
  useEffect(() => {
    if (document.documentElement.dataset.chrome !== 'mac') return;
    let t = 0;
    const onResize = () => { window.clearTimeout(t); t = window.setTimeout(() => void placeLights(lights.current.compact ?? 0), 120); };
    window.addEventListener('resize', onResize);
    return () => { window.clearTimeout(t); window.removeEventListener('resize', onResize); };
  }, []);

  const subjectOf = (id: number) => tree?.find((s) => s.id === id);
  const notebookOf = (id: number) => {
    for (const s of tree ?? []) {
      const n = s.notebooks.find((x) => x.id === id);
      if (n) return { notebook: n, subject: s };
    }
    return null;
  };

  useEffect(() => {
    if (!tree) return;
    if ((route.kind === 'subject' && !subjectOf(route.id)) || (route.kind === 'notebook' && !notebookOf(route.id))) {
      setRoute({ kind: 'study' });
    }
  });

  const open = useCallback((r: Route) => {
    // Straight into a quiz (Continue on Home) takes over the window: animate that too. A deck gets
    // there a moment later, once its cards are loaded, and the notebook animates that itself.
    const takeover = r.kind === 'notebook' && r.open?.type === 'quiz' && !!r.open.run;
    if (takeover) morph(() => setRoute(r));
    else setRoute(r);
  }, []);

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
    { kind: 'item', label: 'Open', icon: <ArrowUpRight />, onClick: () => open({ kind: 'subject', id: s.id }) },
    { kind: 'item', label: 'New notebook…', icon: <Plus />, onClick: () => actions.newNotebook(s.id) },
    { kind: 'item', label: 'Rename…', icon: <Pencil />, onClick: () => actions.renameSubject(s) },
    { kind: 'sep' },
    { kind: 'item', label: 'Delete subject…', icon: <Trash />, danger: true, onClick: () => actions.deleteSubject(s) },
  ];
  const notebookMenu = (n: NotebookSummary): MenuItem[] => [
    { kind: 'item', label: 'Open', icon: <ArrowUpRight />, onClick: () => open({ kind: 'notebook', id: n.id }) },
    { kind: 'item', label: 'Edit…', icon: <Pencil />, onClick: () => actions.editNotebook(n) },
    { kind: 'sep' },
    { kind: 'item', label: 'Delete notebook…', icon: <Trash />, danger: true, onClick: () => actions.deleteNotebook(n) },
  ];

  const inStudy = route.kind !== 'solver';
  const isOpenNotebook = (id: number) => route.kind === 'notebook' && route.id === id;
  const viewKey = route.kind === 'chat' ? 'chat' : `${route.kind}:${'id' in route ? route.id : ''}`;
  const openFocus = useCallback(() => setRoute({ kind: 'focus' }), []);
  const activeSubject = route.kind === 'subject' ? route.id : route.kind === 'notebook' ? notebookOf(route.id)?.subject.id : undefined;

  let page: React.ReactNode = null;
  if (route.kind === 'study') page = tree && <StudyHome tree={tree} actions={actions} />;
  if (route.kind === 'chat') page = <ChatPage threadId={route.id ?? null} tree={tree ?? []} open={open} refreshTree={refreshTree} />;
  if (route.kind === 'schedule') page = <SchedulePage tree={tree ?? []} open={open} refreshTree={() => void refresh()} reload={treeVersion} />;
  if (route.kind === 'notes') page = <div className="view"><ViewBar><span className="viewbar-name">Notes</span></ViewBar><NotesApp initialNote={route.id ?? null} /></div>;
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
    <div className={`shell${navSmall ? ' nav-small' : ''}`} data-tauri-drag-region>
      <nav className="nav" aria-label="Main">
        <div className="nav-brand" data-tauri-drag-region="deep">
          <Logo className="nav-logo" />
          {!navSmall && <span className="nav-name">SalemStudy</span>}
          <span className="spacer" />
          <button type="button" className="icon-btn small nav-fold" onClick={() => setNavSmall((v) => !v)} title={navSmall ? 'Show the sidebar' : 'Hide the sidebar'}>
            {navSmall ? <PanelLeftOpen /> : <PanelLeftClose />}
          </button>
        </div>

        <button type="button" className="nav-search" onClick={() => setSearching(true)} title={`Search everything (${keys('⌘K')})`}>
          <Search className="nav-glyph" />{!navSmall && <><span>Search</span><kbd>{keys('⌘K')}</kbd></>}
        </button>

        <div className="nav-scroll">
          <div className="nav-group">
            <NavItem icon={<House />} label="Home" small={navSmall} on={route.kind === 'study'} onClick={() => open({ kind: 'study' })}
              busy={studyRunning ? `${studyRunning} thing${studyRunning === 1 ? '' : 's'} being made` : undefined} />
            <NavItem icon={<MessageSquare />} label="Chat" small={navSmall} on={route.kind === 'chat'} onClick={() => open({ kind: 'chat', id: route.kind === 'chat' ? route.id : lastChat })}
              busy={chatsRunning ? `${chatsRunning} answer${chatsRunning === 1 ? '' : 's'} being written` : undefined} />
            <NavItem icon={<CalendarDays />} label="Schedule" small={navSmall} on={route.kind === 'schedule'} onClick={() => open({ kind: 'schedule' })} />
            <NavItem icon={<StickyNote />} label="Notes" small={navSmall} on={route.kind === 'notes'} onClick={() => open({ kind: 'notes' })} />
            <FocusNavItem on={route.kind === 'focus'} small={navSmall} onClick={() => open({ kind: 'focus' })} />
          </div>

          {!navSmall && (
            <div className="nav-section">
              <div className="nav-section-head">
                <span>Subjects</span>
                <button type="button" className="icon-btn small" onClick={actions.newSubject} title="New subject"><Plus /></button>
              </div>
              {tree && tree.length === 0 && (
                <button type="button" className="nav-empty" onClick={actions.newSubject}>
                  <Plus />Add your first subject
                </button>
              )}
              {tree?.map((s) => {
                const isFolded = folded.includes(s.id);
                return (
                  <div key={s.id} className="nav-subject" style={{ '--subject': subjectColor(s) } as React.CSSProperties}>
                    <div
                      className={`nav-row subject${route.kind === 'subject' && route.id === s.id ? ' on' : ''}${activeSubject === s.id ? ' within' : ''}`}
                      onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: subjectMenu(s) }); }}
                    >
                      <button type="button" className="nav-label" onClick={() => open({ kind: 'subject', id: s.id })}>
                        <span className="nav-subject-badge"><SubjectIcon icon={s.icon} name={s.name} /></span>
                        <span className="nav-text">{s.name}</span>
                      </button>
                      <button type="button" className="nav-add" onClick={() => actions.newNotebook(s.id)} title={`New notebook in ${s.name}`}><Plus /></button>
                      <button
                        type="button"
                        className="nav-caret"
                        onClick={() => setFolded((f) => (isFolded ? f.filter((x) => x !== s.id) : [...f, s.id]))}
                        title={isFolded ? `Show ${s.name}'s notebooks` : `Hide ${s.name}'s notebooks`}
                        aria-expanded={!isFolded}
                      >
                        <ChevronRight className={isFolded ? '' : 'open'} />
                      </button>
                    </div>
                    {/* Folded, a subject still shows the notebook that is open, until you leave it. Each
                        row folds on its own, so the others tuck away around the one that stays. */}
                    <div className={`nav-notebooks${!isFolded || s.notebooks.some((n) => isOpenNotebook(n.id)) ? ' open' : ''}`}>
                      {s.notebooks.map((n) => (
                        <div key={n.id} className={`collapse${!isFolded || isOpenNotebook(n.id) ? ' open' : ''}`}><div><div className="nav-slot">
                          <button
                            type="button"
                            className={`nav-row notebook${isOpenNotebook(n.id) ? ' on' : ''}`}
                            onClick={() => open({ kind: 'notebook', id: n.id })}
                            onContextMenu={(e) => { e.preventDefault(); setMenu({ x: e.clientX, y: e.clientY, items: notebookMenu(n) }); }}
                            tabIndex={!isFolded || isOpenNotebook(n.id) ? undefined : -1}
                          >
                            <span className="nav-text">{n.name}</span>
                          </button>
                        </div></div></div>
                      ))}
                      {s.notebooks.length === 0 && (
                        <div className={`collapse${isFolded ? '' : ' open'}`}><div><div className="nav-slot">
                          <button type="button" className="nav-row notebook ghost" onClick={() => actions.newNotebook(s.id)} tabIndex={isFolded ? -1 : undefined}><Plus />New notebook</button>
                        </div></div></div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>

        <div className="nav-foot">
          {solverOn && (
            <NavItem icon={<ClipboardCheck />} label="Assignment Solver" small={navSmall} on={route.kind === 'solver'} onClick={() => open({ kind: 'solver' })} />
          )}
          {canServe && (
            <NavItem icon={<Globe />} label="Open in a tab" small={navSmall} onClick={() => setTabModeOpen(true)} title="Open Salem in a browser tab" />
          )}
          <NavItem icon={<SettingsIcon />} label="Settings" small={navSmall} onClick={() => (solverOn ? setSettingsSignal((n) => n + 1) : setSettingsOpen(true))} />
        </div>
      </nav>

      <OpenFocus.Provider value={openFocus}>
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
      <UpdateCenter />
      {document.documentElement.dataset.chrome === 'win' && <WindowBar />}
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

function Busy({ what }: { what: string }) {
  return <span className="nav-busy" role="status" aria-label={what} title={what} />;
}

function NavItem({ icon, label, small, on = false, busy, title, onClick }: {
  icon: React.ReactNode;
  label: string;
  small: boolean;
  on?: boolean;
  busy?: string;
  title?: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className={`nav-item${on ? ' on' : ''}`} onClick={onClick} title={busy ?? title ?? (small ? label : undefined)} aria-current={on ? 'page' : undefined}>
      <span className="nav-glyph">{icon}</span>
      {!small && <span className="nav-text">{label}</span>}
      {busy && <Busy what={busy} />}
    </button>
  );
}

function FocusNavItem({ on, small, onClick }: { on: boolean; small: boolean; onClick: () => void }) {
  const p = usePomodoro();
  const live = p.status !== 'idle';
  return (
    <button type="button" className={`nav-item${on ? ' on' : ''}${live ? ` live ${p.phase}` : ''}`} onClick={onClick} title={small ? 'Focus' : 'Focus timer'} aria-current={on ? 'page' : undefined}>
      <span className="nav-glyph"><Timer /></span>
      {!small && <span className="nav-text">Focus</span>}
      {!small && live && <span className={`nav-timer${p.status === 'paused' ? ' paused' : ''}`}>{fmtClock(remainingOf(p))}</span>}
    </button>
  );
}
