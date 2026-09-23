/**
 * The AI smoke test that runs *inside the desktop app*.
 *
 *     npm run test:ai:app
 *
 * `test:ai` scripts the model's replies and `test:ai:live` drives the real
 * runtime from outside; neither goes through the webview, which is where the
 * study space, the tool registry and every real tool declaration actually
 * live. A tool the app declared in a way the runtime could not turn into a
 * Python function killed every agentic feature while both of those suites
 * stayed green — this is the one that catches that.
 *
 * It runs the same modules the UI calls, over the student's own data, and
 * reports to a collector on 127.0.0.1:9911 because the webview's console is
 * not visible from outside. Loaded from main.tsx only when VITE_SELFTEST=1.
 */
import { runtimeStatus } from './lib/salem/runtime';
import { runChatTurn } from './lib/chatTurn';
import { generate, generateText } from './lib/salem/generate';
import { getAiConfig } from './lib/ai';
import { makeSet } from './lib/makeSet';
import { createMeter } from './lib/meter';
import { studyApi } from './study/api';
import { describeReferences, makeReference } from './lib/reference';
import { resolve } from './lib/referenceContent';
import { generateCards, generateQuiz } from './lib/studyGen';
import { wholeSources } from './lib/material';
import { applyOrder } from './lib/deckPlan';
import type { ToolEnv } from './lib/salem/tools';

const REPORT = 'http://127.0.0.1:9911/report';

async function say(step: string, ok: boolean, detail: unknown) {
  const body = JSON.stringify({ step, ok, detail }, (_k, v) => (v instanceof Error ? `${v.name}: ${v.message}` : v));
  try {
    await fetch(REPORT, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  } catch {
    /* the collector is optional */
  }
  // eslint-disable-next-line no-console
  console.log(`[selftest] ${ok ? 'ok ' : 'FAIL'} ${step}`, detail);
}

const emptyEnv: ToolEnv = { tree: () => [], refresh: async () => [], open: () => {} };

async function attempt(step: string, work: () => Promise<unknown>) {
  const started = Date.now();
  try {
    const value = await work();
    await say(step, true, { ms: Date.now() - started, value });
    return value;
  } catch (e) {
    await say(step, false, { ms: Date.now() - started, error: String(e instanceof Error ? `${e.name}: ${e.message}` : e) });
    return null;
  }
}

export async function runSelfTest() {
  window.addEventListener('unhandledrejection', (e) => void say('unhandled rejection', false, String(e.reason)));
  window.addEventListener('error', (e) => void say('window error', false, String(e.message)));

  await attempt('config', async () => await getAiConfig());
  await attempt('runtime status', async () => await runtimeStatus());
  await attempt('study tree', async () => {
    const tree = await studyApi.tree();
    return { subjects: tree.length, notebooks: tree.flatMap((s) => s.notebooks ?? []).length };
  });

  await attempt('generateText (direct)', async () =>
    await generateText({
      feature: 'selftest',
      system: 'You are terse.',
      instruction: 'Reply with exactly: PONG',
    }));

  await attempt('generate (schema)', async () =>
    await generate({
      feature: 'selftest',
      system: 'You are terse.',
      instruction: 'Give two colours.',
      schema: {
        type: 'object',
        required: ['colours'],
        properties: { colours: { type: 'array', items: { type: 'string' } } },
      },
    }));

  await attempt('chat turn (agentic, real tools)', async () => {
    const config = await getAiConfig();
    const tree = await studyApi.tree().catch(() => []);
    const r = await runChatTurn({
      agent: 'chat',
      system: 'You are a study assistant.',
      messages: [{ role: 'user', content: 'What subjects and notebooks do I have? Use your tools to look.' }],
      model: config.flashModel,
      feature: 'chat',
      env: { ...emptyEnv, tree: () => tree, refresh: async () => tree },
      cancelled: () => false,
      onRun: () => {},
      onProgress: () => {},
    });
    if (!(r.cost > 0)) throw new Error('the reply came back without a price');
    return { state: r.state, cost: r.cost, degraded: r.degraded, reason: r.reason, actions: r.actions.map((a) => a.name), text: r.text.slice(0, 400) };
  });

  await attempt('a demanding turn hands over to the agent', async () => {
    const config = await getAiConfig();
    const tree = await studyApi.tree().catch(() => []);
    const r = await runChatTurn({
      agent: 'chat',
      system: 'You are a study assistant. Use your tools; do not answer from memory.',
      messages: [{
        role: 'user',
        content: 'Go through my study space properly: list my subjects, then for every notebook '
          + 'list its sources, read the first source, list the quizzes and decks in it, and read '
          + 'one quiz. Then summarise what I have and what is missing.',
      }],
      model: config.flashModel,
      feature: 'chat',
      env: { ...emptyEnv, tree: () => tree, refresh: async () => tree },
      cancelled: () => false,
      onRun: () => {},
      onProgress: () => {},
    });
    return {
      state: r.state,
      cost: r.cost,
      actions: r.actions.map((a) => a.name),
      handedOver: r.steps.some((s) => s.type === 'text' && /needs a proper look/.test((s as { text: string }).text)),
      text: r.text.slice(0, 200),
    };
  });

  await attempt('a reference arrives with its material', async () => {
    const tree = await studyApi.tree();
    const notebook = tree.flatMap((sub) => (sub.notebooks ?? []).map((nb) => nb))[0];
    if (!notebook) throw new Error('no notebook');
    const quizzes = await studyApi.quizzes(notebook.id);
    if (!quizzes.length) throw new Error('no quiz to point at');
    const quiz = await studyApi.quiz(quizzes[0].id);
    const ref = makeReference('quiz', 'Question 1', quiz.questions[0].prompt.slice(0, 80),
      { quizId: quiz.id, questionIndex: 0, notebookId: notebook.id }, quiz.title);
    const full = await resolve(ref);
    const briefing = describeReferences([full]);
    return {
      fetched: !!full.content,
      title: full.content?.title,
      bodyChars: full.content?.body.length ?? 0,
      // It must not be telling the model to go and look it up.
      tellsItToFetch: /read_quiz\(/.test(briefing),
      briefing: briefing.slice(0, 260),
    };
  });

  // The real generators, over the student's own notebook and sources.
  const material = await attempt('sample the notebook sources', async () => {
    const tree = await studyApi.tree();
    const notebook = tree.flatMap((sub) => (sub.notebooks ?? []).map((nb) => ({ sub, nb })))[0];
    if (!notebook) throw new Error('no notebook to generate from');
    const ready = (await studyApi.sources(notebook.nb.id)).filter((x) => x.status === 'ready');
    if (!ready.length) throw new Error('that notebook has no ready sources');
    const hits = await studyApi.sampleSources(ready.map((x) => x.id), 20_000);
    return { notebookId: notebook.nb.id, subject: notebook.sub.name, notebook: notebook.nb.name, hits };
  }) as { notebookId: number; subject: string; notebook: string; hits: unknown[] } | null;

  if (material) {
    const ctx = { subject: material.subject, notebook: material.notebook, courseContext: '' };
    const src = { kind: 'sources' as const, hits: material.hits as never, focus: '' };
    // The path the generate dialog and the assistant both take: write it,
    // save it, and it is there to open — no preview, no save click.
    await attempt('makeSet quiz (saved)', async () => {
      const meter = createMeter();
      const made = await makeSet('quiz', ctx, material.notebookId, src, () => {}, { size: 'fewer', limit: 6, meter });
      if (!(meter.total > 0)) throw new Error('the quiz came back without a price');
      const saved = await studyApi.quiz(made.id);
      await studyApi.deleteQuiz(made.id);
      if (saved.questions.length !== made.count) throw new Error(`saved ${saved.questions.length}, made ${made.count}`);
      return { title: saved.title, questions: saved.questions.length, cost: meter.total, note: made.note, first: saved.questions[0]?.prompt?.slice(0, 160) };
    });
    await attempt('makeSet deck (saved)', async () => {
      const made = await makeSet('cards', ctx, material.notebookId, src, () => {}, { size: 'fewer', limit: 8 });
      const cards = await studyApi.deckCards(made.id);
      await studyApi.deleteDeck(made.id);
      if (cards.length !== made.count) throw new Error(`saved ${cards.length}, made ${made.count}`);
      return { title: made.title, cards: cards.length, note: made.note, first: cards[0]?.front?.slice(0, 160) };
    });
  }

  await say('done', true, {});
}

/**
 * The page-walk benchmark: a real lecture, every size, compared by hand with
 * a deck the student made and liked. `VITE_SELFTEST=walk`.
 *
 * It reports every card with the page it came from, so coverage — which
 * pages got cards, in what order, and which got none — can be read off.
 */
export async function runWalkBenchmark(sourceTitle: string) {
  const tree = await studyApi.tree();
  const notebooks = tree.flatMap((sub) => (sub.notebooks ?? []).map((nb) => ({ sub, nb })));
  let found: { sub: (typeof notebooks)[number]['sub']; nb: (typeof notebooks)[number]['nb']; source: Awaited<ReturnType<typeof studyApi.sources>>[number] } | null = null;
  for (const { sub, nb } of notebooks) {
    const source = (await studyApi.sources(nb.id)).find((x) => x.title.includes(sourceTitle));
    if (source) { found = { sub, nb, source }; break; }
  }
  if (!found) { await say('walk: find the source', false, `no source titled like ${sourceTitle}`); return; }
  const { sub, nb, source } = found;
  const hits = await wholeSources([source]);
  const ctx = { subject: sub.name, notebook: nb.name, courseContext: '' };
  const src = { kind: 'sources' as const, hits, focus: '' };
  await say('walk: material', true, { source: source.title, pages: hits.length, chars: hits.reduce((n, h) => n + h.text.length, 0) });

  // The order check, on the notebook whose lectures went in newest first.
  for (const { nb: other } of notebooks) {
    const list = (await studyApi.sources(other.id)).filter((x) => x.status === 'ready');
    if (list.length > 1) {
      await say(`walk: reading order in ${other.name}`, true, { uploaded: list.map((x) => x.title), read: applyOrder(list, undefined).map((x) => x.title) });
    }
  }

  // Fast (the default) and thorough, side by side, with what each cost.
  const decks: { size: 'standard' | 'fewer' | 'more'; fast: boolean }[] = [
    { size: 'fewer', fast: true }, { size: 'standard', fast: true }, { size: 'more', fast: true },
  ];
  for (const { size, fast } of decks) {
    await attempt(`walk: deck, ${size}, ${fast ? 'fast' : 'thorough'}`, async () => {
      const steps: string[] = [];
      const started = Date.now();
      const meter = createMeter();
      const d = await generateCards(ctx, src, { size, fast, meter }, (t) => steps.push(t));
      const byPage: Record<string, number> = {};
      for (const c of d.cards) {
        const label = (c.sourceRefs as { label?: string }[] | undefined)?.[0]?.label ?? '?';
        byPage[label] = (byPage[label] ?? 0) + 1;
      }
      return {
        size, fast, title: d.title, cards: d.cards.length, seconds: Math.round((Date.now() - started) / 1000),
        cost: meter.total, skipped: d.skipped, steps, byPage,
        all: d.cards.map((c) => ({ page: (c.sourceRefs as { label?: string }[] | undefined)?.[0]?.label, front: c.front, back: c.back })),
      };
    });
  }

  for (const [size, fast] of [['fewer', true], ['standard', true], ['more', true]] as const) {
    await attempt(`walk: quiz, ${size}, ${fast ? 'fast' : 'thorough'}`, async () => {
      const steps: string[] = [];
      const started = Date.now();
      const meter = createMeter();
      const q = await generateQuiz(ctx, src, nb.id, (t) => steps.push(t), { size, fast, meter });
      const types: Record<string, number> = {};
      for (const x of q.questions) types[x.type] = (types[x.type] ?? 0) + 1;
      return {
        size, fast, title: q.title, questions: q.questions.length, dropped: q.dropped, skipped: q.skipped,
        seconds: Math.round((Date.now() - started) / 1000), cost: meter.total, types, steps,
        all: q.questions.map((x) => ({ page: x.sources?.[0]?.label, type: x.type, prompt: x.prompt, answer: x.answer, choices: x.choices })),
      };
    });
  }

  await say('done', true, {});
}
