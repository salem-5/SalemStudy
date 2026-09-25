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
  } catch { }
  const messages = a.messages as Msg[];
  const forced = (a.choice as { function?: { name?: string } } | null)?.function?.name;
  if (forced === 'save_flashcards') {
    return call('save_flashcards', { title: 'Convergence tests', cards: [
      { front: 'State the **ratio test**.', back: 'If $L = \\lim_{n\\to\\infty} \\left|\\frac{a_{n+1}}{a_n}\\right|$, the series converges absolutely when $L<1$ and diverges when $L>1$.', topic: 'Ratio test' },
      { front: 'When is the ratio test inconclusive?', back: 'When $L = 1$ - e.g. both $\\sum \\frac1n$ and $\\sum \\frac1{n^2}$ give $L=1$.', topic: 'Ratio test' },
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
  if (sys.startsWith('Name ') && sys.includes('"title"')) {
    return reply(JSON.stringify({ title: sys.includes('course material') ? 'Ratio test' : 'Convergence tests' }));
  }
  const last = messages.at(-1);
  if (sys.startsWith('You write excellent study notes')) {
    return reply('# Lines in 3D space\n\n## Vector equation\nA **line** through $P_0$ with direction $\\mathbf v$:\n\n$$\\mathbf r(t) = \\mathbf r_0 + t\\,\\mathbf v$$\n\n- $\\mathbf r_0$ - position of a point on the line\n- $\\mathbf v$ - direction vector\n\n## Symmetric equations\nSolve each component for $t$:\n\n$$\\frac{x-x_0}{a} = \\frac{y-y_0}{b} = \\frac{z-z_0}{c}$$\n\n| Form | Needs |\n|---|---|\n| Vector | point + direction |\n| Symmetric | $a,b,c \\ne 0$ |\n\n## Key points\n- Direction is a **difference** of points, $Q - P$.\n- (Lecture 12, Page 1)');
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
    return reply("Nice - good luck with Physics 1 this term. Want me to set up a notebook for it?");
  }
  if (toolNames.includes('save_memory') && last?.role === 'user' && /\b(i'm|i am|remember)\b/i.test(text(last))) {
    return call('save_memory', { fact: text(last).replace(/^(please )?remember( that)?\s*/i, '').replace(/^i'm|^i am/i, 'Is').trim() });
  }
  if (last?.role === 'tool' && toolNames.includes('timer')) {
    return reply('Done: I started a 25-minute focus session and made the deck in **Series** - open it from the Cards tab there.');
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

const model = (id: string, name: string, o: Partial<Record<string, unknown>> = {}) => ({
  id, name, reasoning: false, effort: false, tools: true, vision: false, input: 0.5, output: 1.5, cacheRead: 0.05,
  context: 128_000, maxOutput: 16_384, status: '', released: '2026-01-01', ...o,
});
const MOCK_CATALOG = {
  deepseek: { id: 'deepseek', name: 'DeepSeek', base: 'https://api.deepseek.com', doc: 'https://platform.deepseek.com', env: ['DEEPSEEK_API_KEY'], models: [
    model('deepseek-flash', 'DeepSeek Flash', { reasoning: true, effort: true, input: 0.15, output: 0.6, cacheRead: 0.003, context: 1_000_000, released: '2026-08-01', vision: true }),
    model('deepseek-v4-pro', 'DeepSeek V4 Pro', { reasoning: true, effort: true, input: 0.66, output: 1.98, released: '2026-07-01' }),
  ] },
  openai: { id: 'openai', name: 'OpenAI', base: 'https://api.openai.com/v1', doc: 'https://platform.openai.com/api-keys', env: ['OPENAI_API_KEY'], models: [
    model('gpt-5.2', 'GPT-5.2', { reasoning: true, effort: true, vision: true, input: 1.25, output: 10, context: 400_000, released: '2026-06-01' }),
    model('gpt-5.2-mini', 'GPT-5.2 mini', { reasoning: true, effort: true, vision: true, input: 0.25, output: 2, context: 400_000, released: '2026-06-01' }),
    model('gpt-4o', 'GPT-4o', { vision: true, input: 2.5, output: 10, status: 'deprecated', released: '2024-05-13' }),
  ] },
  anthropic: { id: 'anthropic', name: 'Anthropic', base: 'https://api.anthropic.com/v1', doc: 'https://console.anthropic.com', env: ['ANTHROPIC_API_KEY'], models: [
    model('claude-sonnet-5', 'Claude Sonnet 5', { reasoning: true, vision: true, input: 3, output: 15, context: 1_000_000, released: '2026-05-01' }),
  ] },
  google: { id: 'google', name: 'Google', base: 'https://generativelanguage.googleapis.com/v1beta/openai', doc: 'https://aistudio.google.com', env: ['GEMINI_API_KEY'], models: [
    model('gemini-3-flash', 'Gemini 3 Flash', { reasoning: true, vision: true, input: 0.3, output: 2.5, context: 1_000_000, released: '2026-04-01' }),
  ] },
  openrouter: { id: 'openrouter', name: 'OpenRouter', base: 'https://openrouter.ai/api/v1', doc: 'https://openrouter.ai/keys', env: ['OPENROUTER_API_KEY'], models: [
    model('qwen/qwen3-235b', 'Qwen3 235B'), model('meta-llama/llama-4-maverick', 'Llama 4 Maverick'),
  ] },
  groq: { id: 'groq', name: 'Groq', base: 'https://api.groq.com/openai/v1', doc: 'https://console.groq.com', env: ['GROQ_API_KEY'], models: [model('llama-3.3-70b', 'Llama 3.3 70B', { maxOutput: 8192 })] },
};
const mockCfg = { provider: 'deepseek', flashModel: 'deepseek-flash', proModel: 'deepseek-v4-pro', keyed: ['deepseek'] as string[] };

export function installDevAi() {
  const handlers: Record<string, (a: Args) => unknown> = {
    get_config: () => ({
      hasKey: mockCfg.provider === 'ollama' || mockCfg.keyed.includes(mockCfg.provider), keyHint: 'sk-moc…k123',
      flashModel: mockCfg.flashModel, proModel: mockCfg.proModel, baseUrl: 'mock', maxAttempts: 4, pauseAfter: 2, effort: 'low',
      pythonEnabled: true, pythonAuto: true, pythonPath: '', pythonTimeout: 25, pythonMemoryMb: 4096, pythonMaxCalls: 6,
      closeToTray: true, provider: mockCfg.provider, keyed: mockCfg.keyed,
    }),
    set_config: (a) => {
      const patch = (a.patch ?? {}) as Record<string, unknown>;
      if (typeof patch.provider === 'string') mockCfg.provider = patch.provider;
      if (typeof patch.flashModel === 'string') mockCfg.flashModel = patch.flashModel;
      if (typeof patch.proModel === 'string') mockCfg.proModel = patch.proModel;
      if (typeof patch.apiKey === 'string') {
        const who = (patch.keyProvider as string) || mockCfg.provider;
        mockCfg.keyed = patch.apiKey ? [...new Set([...mockCfg.keyed, who])] : mockCfg.keyed.filter((k) => k !== who);
      }
      return handlers.get_config({});
    },
    providers_catalog: async () => { await wait(300); return MOCK_CATALOG; },
    ollama_status: () => ({ installed: true, running: true, version: '0.12.3', models: [
      { id: 'llama3.1:8b', size: 4.9e9, family: 'llama', parameters: '8B' },
      { id: 'qwen3:14b', size: 9.3e9, family: 'qwen3', parameters: '14B' },
    ], loaded: [{ id: 'llama3.1:8b', vram: 5.6e9 }] }),
    ollama_start: () => handlers.ollama_status({}),
    ollama_stop: () => ({ unloaded: ['llama3.1:8b'] }),
    python_status: () => ({
      ready: !localStorage.getItem('wa.preview.noPython'), source: 'venv', interpreter: '/mock/python', version: '3.13', missing: [], error: null, help: '', canInstall: true,
      packages: ['sympy', 'numpy', 'mpmath', 'scipy', 'matplotlib', 'pint', 'pymupdf'].map((name) => ({ name, version: 'mock' })),
    }),
    deepseek_balance: () => ({ is_available: true, balance_infos: [{ currency: 'USD', total_balance: '9.99', granted_balance: '0', topped_up_balance: '9.99' }] }),
    deepseek_chat: chat,
    run_python: async (a) => { await wait(400); return python(a); },
    python_setup: () => handlers.python_status({}),
    salem_status: () => ({
      ready: !localStorage.getItem('wa.preview.noPython'),
      error: null,
      hello: { ok: true, version: 'mock', smolagents: 'mock', python: '3.13', executable: '/mock/python' },
      nativeTools: ['web_search', 'web_fetch', 'run_python'],
    }),
    salem_restart: () => null,
    salem_telemetry: () => ({
      total: {
        runs: 34, completed: 31, failed: 2, cancelled: 1, avgDurationMs: 4200,
        toolCalls: 58, toolFailures: 3, pythonCalls: 19, pythonFailures: 1,
        retrievalFailures: 0, retries: 4, subagents: 6, tokens: 412_000,
      },
      byFeature: [
        { feature: 'chat', runs: 18, failed: 1, avgDurationMs: 2600 },
        { feature: 'notebook', runs: 9, failed: 0, avgDurationMs: 5200 },
        { feature: 'quiz', runs: 5, failed: 1, avgDurationMs: 11_800 },
        { feature: 'solver', runs: 2, failed: 0, avgDurationMs: 7400 },
      ],
      since: 0,
    }),
    salem_task_clear: () => null,
    tex_status: () => ({ ready: false, engine: null, path: null, help: 'Install Tectonic.', installer: 'Homebrew', command: 'brew install tectonic' }),
    tex_install: () => ({ ready: true, engine: 'tectonic', path: '/opt/homebrew/bin/tectonic', help: '', installer: 'Homebrew', command: 'brew install tectonic' }),
    tab_mode_status: () => tabMode,
    tab_mode_start: () => {
      Object.assign(tabMode, { running: true, port: 8790, url: 'http://127.0.0.1:8790/?t=preview-token', origin: 'http://127.0.0.1:8790' });
      return tabMode;
    },
    tab_mode_stop: () => {
      Object.assign(tabMode, { running: false, port: null, url: null, origin: null });
      return tabMode;
    },
    tab_mode_reply: () => null,
    open_url: (a) => { window.open(String(a.url), '_blank'); return null; },
    salem_run: (a) => salemRun(a),
    salem_cancel: (a) => { cancelled.add(String(a.run)); return null; },
    salem_tool_result: (a) => {
      const waiting = toolWaiters.get(Number(a.call));
      if (waiting) { toolWaiters.delete(Number(a.call)); waiting(a); }
      return null;
    },
  };
  const callbacks = new Map<number, (e: unknown) => void>();
  const listeners = new Map<string, Set<number>>();
  let nextCb = 1;
  const emit = (event: string, payload: unknown) => {
    for (const cb of listeners.get(event) ?? []) callbacks.get(cb)?.({ event, id: 0, payload });
  };
  const cancelled = new Set<string>();
  const tabMode = { running: false, port: null as number | null, url: null as string | null, origin: null as string | null };

  let nextToolCall = 1;
  const toolWaiters = new Map<number, (a: Args) => void>();

  const callTool = (run: string, name: string, args: Args) =>
    new Promise<Args>((resolve) => {
      const call = nextToolCall++;
      toolWaiters.set(call, resolve);
      emit('salem://tool', { call, run, name, args });
      window.setTimeout(() => {
        if (toolWaiters.delete(call)) resolve({ ok: false, error: 'the mock tool timed out' });
      }, 20_000);
    });

  const MOCK_QUIZ = {
    title: 'Convergence tests (preview)',
    questions: [
      {
        type: 'mcq', prompt: 'Which test is best for $\\sum n!/n^n$?',
        choices: ['Ratio test', 'Integral test', 'Alternating series test', 'Direct comparison'],
        answer: '0', hint: 'Factorials cancel neatly when you divide consecutive terms.',
        explanation: 'The ratio test: $a_{n+1}/a_n$ collapses the factorial.', topic: 'Ratio test', difficulty: 'medium',
      },
      {
        type: 'blank', prompt: 'A $p$-series $\\sum 1/n^p$ converges when $p$ is greater than ______.',
        answer: '1', accept: ['one'], hint: 'The harmonic series is the boundary case.',
        explanation: 'It converges for $p > 1$ and diverges for $p \\le 1$.', topic: 'p-series', difficulty: 'easy',
      },
      {
        type: 'tf', prompt: 'Every absolutely convergent series converges.',
        answer: 'true', hint: 'Think about what the partial sums of $|a_n|$ bound.',
        explanation: 'Absolute convergence implies convergence.', topic: 'Absolute convergence', difficulty: 'medium',
      },
    ],
  };

  const MOCK_CARDS = {
    title: 'Convergence tests (preview)',
    cards: [
      { front: 'State the **ratio test**.', back: 'Converges absolutely when $L<1$, diverges when $L>1$.', topic: 'Ratio test' },
      { front: 'When is the ratio test inconclusive?', back: 'When $L = 1$.', topic: 'Ratio test' },
    ],
  };

  const MOCK_ANSWER = `The **ratio test** looks at $L = \\lim_{n\\to\\infty}\\left|\\frac{a_{n+1}}{a_n}\\right|$.\n\n` +
    `- $L < 1$ - the series converges absolutely.\n- $L > 1$ - it diverges.\n- $L = 1$ - inconclusive; try another test.\n\n` +
    `This is the browser preview, so the answer is canned - the states, streaming and tool calls above are real.`;

  async function salemRun(a: Args): Promise<unknown> {
    const run = String(a.run);
    const input = (a.input ?? {}) as Args;
    const started = Date.now();
    const state = (s: string, detail = '') => emit('salem://event', { run, event: { kind: 'state', state: s, detail } });
    const stop = () => cancelled.delete(run) || cancelled.has(run);

    state('planning', 'Working out how to do this');
    await wait(300);

    const asked = String(input.objective ?? '').toLowerCase();
    if (/notebook|calendar|schedule|deck|quiz|note/.test(asked)) {
      const name = /calendar|schedule|due|exam/.test(asked) ? 'list_events' : 'list_study';
      const args: Args = name === 'list_events'
        ? { from: new Date().toISOString().slice(0, 10), to: new Date(Date.now() + 30 * 864e5).toISOString().slice(0, 10) }
        : {};
      const id = `${name}-1`;
      state('waiting_tool', name === 'list_events' ? 'Checking the calendar' : 'Looking through your study space');
      emit('salem://event', { run, event: { kind: 'tool', id, name, status: 'running', label: name === 'list_events' ? 'Checking the calendar' : 'Looking through your study space' } });
      const answer = await callTool(run, name, args);
      emit('salem://event', {
        run,
        event: {
          kind: 'tool', id, name,
          status: answer.ok === false ? 'error' : 'ok',
          label: name === 'list_events' ? 'Checked the calendar' : 'Looked through your study space',
          detail: answer.ok === false ? String(answer.error ?? '') : '',
        },
      });
    }

    const schema = input.schema as { properties?: Record<string, unknown> } | null;
    if (schema) {
      state('validating', 'Checking the result against the schema');
      await wait(400);
      const props = Object.keys(schema.properties ?? {});
      const structured = props.includes('questions') ? MOCK_QUIZ
        : props.includes('cards') ? MOCK_CARDS
        : props.includes('correct') ? { correct: true, feedback: 'That is the idea - well put.' }
        : props.includes('title') ? { title: 'Mock title' }
        : props.includes('summary') ? { summary: '### Course\nA preview stand-in.', events: [] }
        : {};
      state('completed', 'Done');
      const done = {
        text: '', structured, state: 'completed', path: 'agentic',
        telemetry: {
          run, feature: String(input.feature ?? 'other'), durationMs: Date.now() - started, state: 'completed',
          steps: 2, tool_calls: 0, tool_failures: 0, python_calls: 0, python_failures: 0,
          retrieval_failures: 0, subagents: 0, retries: 0, input_tokens: 2400, output_tokens: 900,
        },
      };
      emit('salem://done', { run, ok: true, result: done, error: '' });
      return done;
    }

    state('executing', 'Answering');
    let sent = '';
    for (const word of MOCK_ANSWER.split(/(?<=\s)/)) {
      if (cancelled.has(run)) {
        cancelled.delete(run);
        state('cancelled', 'Stopped');
        throw 'stopped';
      }
      emit('salem://event', { run, event: { kind: 'text', text: word } });
      sent += word;
      await wait(12);
    }
    void stop;
    state('completed', 'Done');
    const result = {
      text: sent,
      state: 'completed',
      path: 'direct',
      memory: { objective: String(input.objective ?? '') },
      telemetry: {
        run, feature: String(input.feature ?? 'chat'), durationMs: Date.now() - started, state: 'completed',
        steps: 1, tool_calls: 0, tool_failures: 0, python_calls: 0, python_failures: 0,
        retrieval_failures: 0, subagents: 0, retries: 0, input_tokens: 1200, output_tokens: 300,
      },
    };
    emit('salem://done', { run, ok: true, result, error: '' });
    return result;
  }
  handlers['plugin:event|listen'] = (a) => {
    const set = listeners.get(String(a.event)) ?? new Set();
    set.add(Number(a.handler));
    listeners.set(String(a.event), set);
    return Number(a.handler);
  };
  handlers['plugin:event|unlisten'] = (a) => { for (const set of listeners.values()) set.delete(Number(a.eventId)); };
  handlers.ai_cancel = (a) => { cancelled.add(String(a.id)); };
  handlers['plugin:dialog|save'] = () => '/Users/you/Documents/SalemStudy 2026-09-21.salemstudy';
  handlers['plugin:dialog|open'] = () => '/Users/you/Documents/SalemStudy 2026-09-01.salemstudy';
  handlers.data_export = async (a) => { await wait(600); return { path: String(a.path), bytes: 48_213_504 }; };
  handlers.data_inspect = () => ({ exportedAt: Date.now() - 20 * 864e5, hasSettings: true, subjects: 3, notebooks: 8, sources: 21, notes: 6, chats: 14, events: 19, bytes: 48_213_504 });
  handlers.data_import = async () => { await wait(600); throw 'Import is not available in the browser preview.'; };
  handlers.data_reset = async () => { await wait(300); throw 'Reset is not available in the browser preview.'; };
  handlers.deepseek_stream = async (a) => {
    const r = (await chat(a)) as { content: string; reasoning: string; tool_calls: unknown };
    const id = String(a.id);
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
