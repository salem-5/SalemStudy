// Dev-only stand-in for the Tauri commands the AI features call (DeepSeek,
// Python, settings), so chat, flashcards and quizzes can be exercised with
// `npm run dev` in a plain browser. Loaded from main.tsx only outside Tauri.

type Args = Record<string, unknown>;
type Msg = { role: string; content: unknown; tool_calls?: unknown };

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sineFigure(title: string): string {
  const c = document.createElement('canvas');
  c.width = 640;
  c.height = 400;
  const g = c.getContext('2d')!;
  g.fillStyle = '#fff';
  g.fillRect(0, 0, 640, 400);
  g.strokeStyle = '#ddd';
  for (let x = 60; x <= 600; x += 90) { g.beginPath(); g.moveTo(x, 40); g.lineTo(x, 360); g.stroke(); }
  g.strokeStyle = '#1f77b4';
  g.lineWidth = 2;
  g.beginPath();
  for (let i = 0; i <= 540; i++) {
    const x = 60 + i;
    const y = 200 - 120 * Math.sin((i / 540) * 4 * Math.PI);
    if (i) g.lineTo(x, y); else g.moveTo(x, y);
  }
  g.stroke();
  g.fillStyle = '#222';
  g.font = '16px sans-serif';
  g.fillText(title, 250, 28);
  return c.toDataURL('image/png');
}

const text = (m: Msg | undefined) =>
  typeof m?.content === 'string' ? m.content : Array.isArray(m?.content) ? (m!.content as { text?: string }[]).map((p) => p.text ?? '').join(' ') : '';

const call = (name: string, args: unknown) => ({
  content: '', reasoning: '', model: 'mock-flash', usage: { prompt_tokens: 100, completion_tokens: 50 },
  tool_calls: [{ id: `call_${Math.random().toString(36).slice(2, 8)}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
});
const reply = (content: string) => ({ content, reasoning: '', model: 'mock-flash', usage: { prompt_tokens: 100, completion_tokens: 80 }, tool_calls: null });

async function chat(a: Args) {
  await wait(700);
  try {
    const KEY = 'wa.study.mock.v3';
    const db = JSON.parse(localStorage.getItem(KEY) || '{}');
    db.usage = [...(db.usage ?? []), { at: Date.now(), model: 'deepseek-flash', feature: String(a.feature ?? 'other'), tokens: 1800, cost: 0.0004 }];
    localStorage.setItem(KEY, JSON.stringify(db));
  } catch { /* ignore */ }
  const messages = a.messages as Msg[];
  const forced = (a.choice as { function?: { name?: string } } | null)?.function?.name;
  if (forced === 'save_flashcards') {
    return call('save_flashcards', { title: 'Convergence tests', cards: [
      { front: 'State the **ratio test**.', back: 'If $L = \\lim_{n\\to\\infty} \\left|\\frac{a_{n+1}}{a_n}\\right|$, the series converges absolutely when $L<1$ and diverges when $L>1$.', topic: 'Ratio test' },
      { front: 'When is the ratio test inconclusive?', back: 'When $L = 1$ — e.g. both $\\sum \\frac1n$ and $\\sum \\frac1{n^2}$ give $L=1$.', topic: 'Ratio test' },
      { front: 'Sum of the geometric series $\\sum_{n=0}^\\infty r^n$ for $|r|<1$', back: '$$\\frac{1}{1-r}$$', topic: 'Geometric series' },
      { front: 'The $p$-series $\\sum \\frac{1}{n^p}$ converges when…', back: '$p > 1$', topic: 'p-series' },
    ] });
  }
  if (forced === 'save_quiz') {
    return call('save_quiz', { title: 'Convergence tests', questions: [
      { type: 'numeric', prompt: 'Find $\\sum_{n=0}^{\\infty} \\left(\\tfrac12\\right)^n$.', answer: '2', explanation: 'Geometric with $r=\\tfrac12$: $\\frac{1}{1-1/2} = 2$.', topic: 'Geometric series', check_code: 'print(1/(1-0.5))' },
      { type: 'mcq', prompt: 'Which test is best for $\\sum \\frac{n!}{3^n}$?', choices: ['Integral test', 'Ratio test', 'p-series test', 'Alternating series test'], answer: '1', explanation: 'Factorials and powers: the **ratio test** simplifies neatly.', topic: 'Ratio test', check_code: 'print(1)' },
      { type: 'tf', prompt: 'If $a_n \\to 0$ then $\\sum a_n$ converges.', answer: 'false', explanation: 'The harmonic series $\\sum \\frac1n$ is the counterexample.', topic: 'Divergence test', check_code: 'print(False)' },
      { type: 'numeric', prompt: 'A wrong one: $1+1$?', answer: '3', explanation: 'This check disagrees and must be dropped.', topic: 'Arithmetic', check_code: 'print(2)' },
      { type: 'short', prompt: 'Why does $\\sum \\frac1{n^2}$ converge?', answer: 'It is a p-series with p = 2 > 1 (or compare with the integral of 1/x^2).', explanation: 'p-series with $p=2>1$.', topic: 'p-series', figure_code: 'import numpy as np\nx=np.linspace(1,10)\nplt.plot(x,1/x**2)\nplt.title("1/x^2")' },
    ] });
  }
  if (forced === 'grade') {
    const answer = text(messages.at(-1)).split('Student answer:').pop() ?? '';
    const ok = answer.trim().length > 12;
    return call('grade', { correct: ok, feedback: ok ? 'Right: p = 2 > 1.' : 'Say which test applies and why.' });
  }
  const sys = text(messages[0]);
  if (sys.startsWith('Name this conversation')) return reply('Vector equation of a line');
  const last = messages.at(-1);
  if (sys.startsWith('You write excellent study notes')) {
    return reply('# Lines in 3D space\n\n## Vector equation\nA **line** through $P_0$ with direction $\\mathbf v$:\n\n$$\\mathbf r(t) = \\mathbf r_0 + t\\,\\mathbf v$$\n\n- $\\mathbf r_0$ — position of a point on the line\n- $\\mathbf v$ — direction vector\n\n## Symmetric equations\nSolve each component for $t$:\n\n$$\\frac{x-x_0}{a} = \\frac{y-y_0}{b} = \\frac{z-z_0}{c}$$\n\n| Form | Needs |\n|---|---|\n| Vector | point + direction |\n| Symmetric | $a,b,c \\ne 0$ |\n\n## Key points\n- Direction is a **difference** of points, $Q - P$.\n- (Lecture 12, Page 1)');
  }
  if (sys.startsWith('You read university course syllabuses')) {
    const y = new Date().getFullYear();
    return reply(JSON.stringify({
      summary: '### Course\nMATH 2210 Calculus II, Fall term. Textbook: Stewart, *Calculus* 9e.\n\n### Grading\n- Homework (WebAssign) 15%\n- Quizzes 15%\n- Midterms 2 × 20%\n- Final 30%\n\n### Exams\nClosed book, one handwritten formula sheet, no calculators.\n\n### Topics\n1. Integration techniques\n2. Applications of integration\n3. Sequences and series\n4. Power and Taylor series',
      events: [
        { title: 'Midterm 1', kind: 'exam', date: `${y}-10-08`, start: '18:30', end: '20:00', notes: 'Integration techniques' },
        { title: 'Project proposal due', kind: 'deadline', date: `${y}-10-20`, start: null, end: null, notes: '' },
        { title: 'Midterm 2', kind: 'exam', date: `${y}-11-12`, start: '18:30', end: '20:00', notes: 'Sequences and series' },
        { title: 'No class (reading week)', kind: 'class', date: `${y}-11-03`, start: null, end: null, notes: '' },
        { title: 'Final exam', kind: 'exam', date: `${y}-12-14`, start: '09:00', end: '12:00', notes: 'Cumulative' },
        // A long tail of weekly homework, to exercise long review lists.
        ...Array.from({ length: 14 }, (_, i) => ({ title: `Homework ${i + 1} due`, kind: 'deadline', date: new Date(y, 8, 26 + i * 7).toLocaleDateString('en-CA'), start: '23:59', end: null, notes: '' })),
      ],
    }));
  }
  if (sys.startsWith('You edit a student')) {
    const current = text(last).split('The current notes:')[1]?.trim() ?? '';
    return reply(`${current}\n\n## Worked example\nThrough $(1,2,3)$ with $\\mathbf v = \\langle 2,0,1\\rangle$: $\\mathbf r(t) = \\langle 1+2t, 2, 3+t\\rangle$.`);
  }
  const toolNames = ((a.tools as { function: { name: string } }[] | null) ?? []).map((t) => t.function.name);
  if (last?.role === 'tool' && (last as { name?: string }).name === 'save_memory') {
    return reply("Nice — good luck with Physics 1 this term. Want me to set up a notebook for it?");
  }
  if (toolNames.includes('save_memory') && last?.role === 'user' && /\b(i'm|i am|remember)\b/i.test(text(last))) {
    return call('save_memory', { fact: text(last).replace(/^(please )?remember( that)?\s*/i, '').replace(/^i'm|^i am/i, 'Is').trim() });
  }
  if (last?.role === 'tool' && toolNames.includes('timer')) {
    return reply('Done: I started a 25-minute focus session and made the deck in **Series** — open it from the Cards tab there.');
  }
  if (toolNames.includes('timer') && last?.role === 'user') {
    const q0 = text(last).toLowerCase();
    if (/flashcard/.test(q0) && /timer|focus/.test(q0)) {
      return { ...call('timer', { action: 'start', phase: 'focus', minutes: 25 }), tool_calls: [
        call('timer', { action: 'start', phase: 'focus', minutes: 25 }).tool_calls[0],
        call('make_flashcards', { notebook: 'Series', topic: 'ratio test', count: 4 }).tool_calls[0],
      ] };
    }
  }
  if (sys.includes('Excerpts retrieved for this question')) {
    return reply('From your notes, a line through $P_0$ with direction $\\mathbf v$ is $$\\mathbf r = \\mathbf r_0 + t\\mathbf v$$ [1]. Solving each component for $t$ gives the symmetric equations [2].');
  }
  if (last?.role === 'tool') {
    return reply('Here is the graph of $\\sin(x)$ on $[0, 4\\pi]$. It oscillates between $-1$ and $1$ with period $2\\pi$:\n\n$$\\sin(x + 2\\pi) = \\sin(x)$$');
  }
  const q = text(last);
  if (/table/i.test(q)) {
    return reply('Here is how the common convergence tests compare:\n\n| Test | When to use it | What you compute | Converges if | Diverges if | Inconclusive when | Typical example |\n|---|---|---|---|---|---|---|\n| Ratio | Factorials, powers $c^n$ | $L=\\lim\\left|\\frac{a_{n+1}}{a_n}\\right|$ | $L<1$ | $L>1$ | $L=1$ | $\\sum \\frac{n!}{3^n}$ |\n| Root | $n$-th powers | $L=\\lim \\sqrt[n]{|a_n|}$ | $L<1$ | $L>1$ | $L=1$ | $\\sum \\left(\\frac{n}{2n+1}\\right)^n$ |\n| Integral | $a_n=f(n)$ with $f$ positive, decreasing | $\\int_1^\\infty f(x)\\,dx$ | integral finite | integral infinite | never | $\\sum \\frac1{n^p}$ |\n| Comparison | Looks like a known series | a bound $a_n \\le b_n$ | $\\sum b_n$ converges | $a_n \\ge b_n$, $\\sum b_n$ diverges | bound goes the wrong way | $\\sum \\frac{1}{n^2+1}$ |');
  }
  if (a.tools && /plot|graph|draw/i.test(q)) {
    return call('run_python', { code: 'import numpy as np\nx = np.linspace(0, 4*np.pi, 400)\nplt.plot(x, np.sin(x))\nplt.title("sin(x)")\nplt.show()\nprint("period", 2*np.pi)' });
  }
  return reply(`**Mock answer.** You asked: _${q.slice(0, 120)}_\n\nThe ratio test uses\n\n$$L = \\lim_{n\\to\\infty}\\left|\\frac{a_{n+1}}{a_n}\\right|$$\n\n- $L < 1$: converges absolutely\n- $L > 1$: diverges\n- $L = 1$: inconclusive\n\n\`\`\`python\nprint("code stays code: $x$")\n\`\`\``);
}

function python(a: Args) {
  const code = String(a.code ?? '');
  if (code.includes('pymupdf.open') && code.includes('json.dumps(out)')) {
    const pages = [
      { text: 'Lecture 12: Lines in space. The vector equation of a line through r0 with direction v is r = r0 + t v.', scan: false },
      { text: 'Symmetric equations: solving each component for t gives (x - x0)/a = (y - y0)/b = (z - z0)/c.', scan: false },
      { text: '', scan: true },
    ];
    return { ok: true, stdout: `${JSON.stringify(pages)}\n`, stderr: '', result: null, error: null, figures: [], duration_ms: 50 };
  }
  if (code.includes('get_pixmap')) {
    return { ok: true, stdout: '', stderr: '', result: null, error: null, figures: [{ name: 'page-0002.png', dataUrl: sineFigure('scanned page') }], duration_ms: 50 };
  }
  const figures = /plt/.test(code) ? [{ name: 'figure-1.png', dataUrl: sineFigure((code.match(/title\("([^"]+)"/) ?? [])[1] ?? 'figure') }] : [];
  const prints = [...code.matchAll(/print\(([^)]*)\)/g)].map((m) => m[1]);
  const last = prints.at(-1) ?? '';
  let out = '';
  if (/^[\d.]+\/\(1-[\d.]+\)$/.test(last)) { const [n, r] = last.match(/[\d.]+/g)!.map(Number); out = String(n / (1 - r)); }
  else if (last) out = last.replace(/^"|"$/g, '').replace(/", np.pi\*2|, 2\*np.pi/, ' 6.283185307179586');
  return { ok: true, stdout: out ? `${out}\n` : '', stderr: '', result: null, error: null, figures, duration_ms: 42 };
}

export function installDevAi() {
  const handlers: Record<string, (a: Args) => unknown> = {
    get_config: () => ({
      hasKey: true, keyHint: 'mock', flashModel: 'mock-flash', proModel: 'mock-pro', baseUrl: 'mock', maxAttempts: 4, pauseAfter: 2,
      pythonEnabled: true, pythonAuto: true, pythonPath: '', pythonTimeout: 25, pythonMemoryMb: 4096, pythonMaxCalls: 6,
    }),
    set_config: () => handlers.get_config({}),
    python_status: () => ({
      ready: true, source: 'venv', interpreter: '/mock/python', version: '3.13', missing: [], error: null, help: '', canInstall: true,
      packages: ['sympy', 'numpy', 'mpmath', 'scipy', 'matplotlib', 'pint', 'pymupdf'].map((name) => ({ name, version: 'mock' })),
    }),
    deepseek_balance: () => ({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '9.99', granted_balance: '0', topped_up_balance: '9.99' }] }),
    deepseek_chat: chat,
    run_python: async (a) => { await wait(400); return python(a); },
  };
  // Minimal event plumbing so `listen('ai://stream')` works, and a streamed
  // reply that arrives word by word.
  const callbacks = new Map<number, (e: unknown) => void>();
  const listeners = new Map<string, Set<number>>();
  let nextCb = 1;
  const emit = (event: string, payload: unknown) => {
    for (const cb of listeners.get(event) ?? []) callbacks.get(cb)?.({ event, id: 0, payload });
  };
  const cancelled = new Set<string>();
  handlers['plugin:event|listen'] = (a) => {
    const set = listeners.get(String(a.event)) ?? new Set();
    set.add(Number(a.handler));
    listeners.set(String(a.event), set);
    return Number(a.handler);
  };
  handlers['plugin:event|unlisten'] = (a) => { for (const set of listeners.values()) set.delete(Number(a.eventId)); };
  handlers.ai_cancel = (a) => { cancelled.add(String(a.id)); };
  // Native file dialogs and the data commands, faked for the browser preview.
  handlers['plugin:dialog|save'] = () => '/Users/you/Documents/SalemStudy 2026-09-21.salemstudy';
  handlers['plugin:dialog|open'] = () => '/Users/you/Documents/SalemStudy 2026-09-01.salemstudy';
  handlers.data_export = async (a) => { await wait(600); return { path: String(a.path), bytes: 48_213_504 }; };
  handlers.data_inspect = () => ({ exportedAt: Date.now() - 20 * 864e5, hasSettings: true, subjects: 3, notebooks: 8, sources: 21, notes: 6, chats: 14, events: 19, bytes: 48_213_504 });
  handlers.data_import = async () => { await wait(600); throw 'Import is not available in the browser preview.'; };
  handlers.data_reset = async () => { await wait(300); throw 'Reset is not available in the browser preview.'; };
  handlers.deepseek_stream = async (a) => {
    const r = (await chat(a)) as { content: string; reasoning: string; tool_calls: unknown };
    const id = String(a.id);
    // Thinking mode: stream some reasoning first.
    if (a.thinking) {
      const thought = 'The student is asking about convergence. I should state the ratio test precisely, say what each case means, and mention the inconclusive case L = 1 with an example. Keep it tight.';
      for (const w of thought.split(/(?<=\s)/)) {
        if (cancelled.has(id)) break;
        emit('ai://stream', { id, content: '', reasoning: w });
        await wait(30);
      }
      r.reasoning = thought;
    }
    const words = r.content.split(/(?<=\s)/);
    let sent = '';
    for (const w of words) {
      if (cancelled.has(id)) return { ...r, content: sent, tool_calls: null, cancelled: true };
      emit('ai://stream', { id, content: w, reasoning: '' });
      sent += w;
      await wait(25);
    }
    return r;
  };
  // listen()'s unlisten calls into the event plugin's internals.
  (window as unknown as { __TAURI_EVENT_PLUGIN_INTERNALS__: unknown }).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  (window as unknown as { __TAURI_INTERNALS__: unknown }).__TAURI_INTERNALS__ = {
    invoke: async (cmd: string, args: Args) => {
      const h = handlers[cmd];
      if (!h) throw `${cmd} is not available in the browser preview`;
      return h(args ?? {});
    },
    transformCallback: (cb: (e: unknown) => void) => { const n = nextCb++; callbacks.set(n, cb); return n; },
    unregisterCallback: (n: number) => { callbacks.delete(n); },
  };
}
