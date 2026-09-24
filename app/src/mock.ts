import type { api as realApi } from './api';
import type { Assignment, Box, Question } from './types';
import { toMathML, toText } from './lib/mathpad.js';
import { FIXTURE_CSS, FIXTURE_HTML } from './fixtures';

const math = (expr: string) => (expr ? toMathML(expr) : '<math xmlns="http://www.w3.org/1998/Math/MathML"/>');

function box(index: number, kind: Box['kind'], extra: Partial<Box> = {}): Box {
  const value = extra.value ?? '';
  return {
    index,
    id: `R_${index}`,
    type: kind === 'math' ? 'Q' : kind === 'choice' ? 'C' : 'N',
    typeName: kind === 'math' ? 'answer' : kind === 'choice' ? 'choice' : 'number',
    kind,
    display: kind === 'choice' ? 'radio' : null,
    value,
    text: kind === 'math' ? toText(value) : value,
    choices: null,
    hint: null,
    status: 'unanswered',
    mark: null,
    part: { score: null, total: 1, submissions: 0, maxSubmissions: 5, state: null },
    ...extra,
  };
}

const meaning = [{ value: '0', label: 'meaning' }, { value: '1', label: 'no meaning' }];
const kinds = [{ value: '0', label: 'a scalar and a vector' }, { value: '1', label: 'two vectors' }, { value: '2', label: 'two scalars' }];
const orient = [{ value: '0', label: 'orthogonal' }, { value: '1', label: 'parallel' }, { value: '2', label: 'neither' }];

const correct = (b: Box): Box => ({
  ...b, status: 'correct', mark: { state: 'correct', title: 'Your answer is correct.' },
  part: { ...b.part, score: 1, submissions: 1, state: 'full_credit' },
});

const questions: Question[] = [
  {
    number: 1, id: '4784620', position: 0, code: 'SCalcET9M 12.3.001.', score: 4, total: 4, submissions: '1/5',
    text: 'Which of the following expressions are meaningful? Which are meaningless? Explain.\n(a)\n(a · b) · c\nThe expression (a · b) · c has [1] because it is the dot product of [2] .\n(b)\n(a · b)c\nThe expression (a · b)c has [3] because it is a scalar multiple of [4] .',
    boxes: [
      correct(box(1, 'choice', { choices: meaning, value: '1', display: 'dropdown' })),
      correct(box(2, 'choice', { choices: kinds, value: '0', display: 'dropdown' })),
      box(3, 'choice', { choices: meaning, value: '', display: 'dropdown' }),
      box(4, 'choice', { choices: kinds, value: '', display: 'dropdown' }),
    ],
  },
  {
    number: 2, id: '4784756', position: 1, code: 'SCalcET9M 12.3.006.', score: null, total: 1, submissions: '0/5',
    text: 'Find a · b.\na = ⟨p, −p, 5p⟩, b = ⟨2q, q, −q⟩\n[1]',
    boxes: [box(1, 'math', { value: math('') })],
  },
  {
    number: 3, id: '4784395', position: 2, code: 'SCalcET9M 12.3.009.', score: 0, total: 1, submissions: '2/5',
    text: 'Find a · b.\n|a| = 9, |b| = 8, the angle between a and b is 30°.\n[1]',
    boxes: [box(1, 'math', {
      value: math('36'), status: 'incorrect', mark: { state: 'incorrect', title: 'Your answer is incorrect.' },
      part: { score: 0, total: 1, submissions: 2, maxSubmissions: 5, state: 'no_credit' },
    })],
  },
  {
    number: 4, id: '4783618', position: 3, code: 'SCalcET9M 12.3.011.', score: null, total: 2, submissions: '0/5',
    text: 'If u is a unit vector, find u · v and u · w. (Assume v and w are also unit vectors.)\nu · v = [1] u · w = [2]',
    boxes: [
      box(1, 'text', { value: '-1/2', hint: 'Write your answer in the form of a fraction, integer, or exact decimal. Do not approximate.' }),
      box(2, 'text', { value: '1/2', hint: 'Write your answer in the form of a fraction, integer, or exact decimal. Do not approximate.' }),
    ],
  },
  {
    number: 5, id: '5093822', position: 4, code: 'SCalcET9M 12.3.024.', score: null, total: 3, submissions: '0/5',
    text: 'Determine whether the given vectors are orthogonal, parallel, or neither.\n(a)\nu = ⟨−7, 4, −4⟩, v = ⟨5, 4, −1⟩\n[1] ○ orthogonal ○ parallel ○ neither\n(b)\nu = 15i − 12j + 9k, v = −10i + 8j − 6k\n[2] ○ orthogonal ○ parallel ○ neither\n(c)\nu = ⟨c, c, c⟩, v = ⟨c, 0, −c⟩\n[3] ○ orthogonal ○ parallel ○ neither',
    boxes: [
      box(1, 'choice', { choices: orient, value: '2' }),
      box(2, 'choice', { choices: orient, value: '' }),
      box(3, 'choice', { choices: orient, value: '' }),
    ],
  },
];

questions.push({
  number: 6, id: '9000001', position: 5, code: 'SYNTHETIC', score: null, total: 1, submissions: '0/5',
  text: 'Which figure shows u, v and w as unit vectors? [1]',
  boxes: [box(1, 'choice', {
    choices: [0, 1, 2].map((i) => ({ value: String(i), label: `figure ${i + 1}`, html: `<img src="https://www.webassign.net/scalcet7/12-3-011.gif" alt="figure ${i + 1}" style="height: 110px">` })),
  })],
});
questions.forEach((q) => { q.html = FIXTURE_HTML[q.number]; });

const assignment: Assignment = { id: 40885121, name: '12.3 (ET9)', questions };
const KEY: Record<string, string> = { '1:3': '1', '1:4': '0', '6:1': '1', '2:1': '2pq', '3:1': '36sqrt(3)', '5:1': '0', '5:2': '1', '5:3': '0', '4:1': '-1/2', '4:2': '0' };

const wait = <T,>(v: T, ms = 250) => new Promise<T>((r) => setTimeout(() => r(structuredClone(v)), ms));
const find = (n: number) => assignment.questions.find((q) => q.number === n)!;

function apply(q: Question, answers: Record<string, unknown>) {
  Object.entries(answers).forEach(([k, v]) => {
    const b = q.boxes[Number(k) - 1];
    if (!b) return;
    if (b.kind === 'math') { b.value = math(String(v)); b.text = toText(b.value); } else { b.value = String(v); b.text = b.value; }
  });
}

export function installMock(api: typeof realApi) {
  Object.assign(api, {
    status: () => wait({ connected: true, lastPollAgoMs: 120, page: '/web/Student/Assignment-Responses/last (mock)', userscriptVersion: '0.3.1', queued: 0, inFlight: 0 }, 20),
    bridgeInfo: () => wait({ port: 8787, managed: true, processAlive: true, error: null, log: ['mock bridge'] }, 5),
    restartBridge: () => wait({ port: 8787, managed: true, processAlive: true, error: null, log: ['mock bridge restarted'] }),
    courses: () => wait([{ id: '1321585,1717387', courseId: '1321585', sectionId: '1717387', course: 'MACT 1122', section: '3,4', term: 'Fall 2026', current: true }]),
    assignments: () => wait({
      sectionId: '1717387',
      current: [
        { id: 40885121, assignmentId: 1, name: '12.3 (ET9)', category: 'Homework', due: '2026-09-19T23:59+0300', past: false, score: 4, total: 30, percentage: 13, submitted: true, extended: false, excused: false },
        { id: 40885122, assignmentId: 2, name: '12.4 (ET9)', category: 'Homework', due: '2026-09-19T23:59+0300', past: false, score: null, total: 26, percentage: 0, submitted: false, extended: false, excused: false },
        { id: 40885123, assignmentId: 3, name: '12.5 (ET9)', category: 'Homework', due: '2026-09-26T23:59+0300', past: false, score: null, total: 46, percentage: 0, submitted: false, extended: false, excused: false },
        { id: 40885127, assignmentId: 4, name: 'Review 1 (Part 1) on Chapter 12 (ET9)', category: 'Homework', due: '2026-10-13T23:59+0300', past: false, score: null, total: 45, percentage: 0, submitted: false, extended: false, excused: false },
      ],
      past: [
        { id: 40885119, assignmentId: 5, name: '12.1 (ET9)', category: 'Homework', due: '2026-09-15T23:59+0300', past: true, score: 43, total: 43, percentage: 100, submitted: true, extended: false, excused: false },
        { id: 40885120, assignmentId: 6, name: '12.2 (ET9)', category: 'Homework', due: '2026-09-15T23:59+0300', past: true, score: 16, total: 16, percentage: 100, submitted: true, extended: false, excused: false },
      ],
    }),
    assignment: () => wait(assignment, 400),
    styles: () => wait({ css: FIXTURE_CSS, sources: [] }),
    question: (_d: number, n: number) => wait(find(n)),
    save: (_d: number, n: number, answers: Record<string, unknown>) => {
      apply(find(n), answers);
      return wait({ saved: true, answers: [] }, 350);
    },
    dryRun: (_d: number, n: number) => wait({ dryRun: true, url: `/web/Student/Assignment-Responses/submit?dep=40885121&pos=${n - 1}`, data: { responses: find(n).boxes.map((b) => ({ box: String(b.index - 1), response: b.value })) }, answers: [] }),
    submit: (_d: number, n: number, answers: Record<string, unknown>) => {
      const q = find(n);
      apply(q, answers);
      q.boxes.forEach((b) => {
        const want = KEY[`${n}:${b.index}`];
        const got = b.kind === 'math' ? toText(b.value).replace(/\s+/g, '') : b.value;
        const ok = want !== undefined && got === (b.kind === 'math' ? toText(math(want)).replace(/\s+/g, '') : want);
        const subs = (b.part.submissions ?? 0) + 1;
        Object.assign(b, {
          status: ok ? 'correct' : 'incorrect',
          mark: { state: ok ? 'correct' : 'incorrect', title: ok ? 'Your answer is correct.' : 'Your answer is incorrect.' },
          part: { ...b.part, submissions: subs, score: ok ? 1 : 0, state: ok ? 'full_credit' : 'no_credit' },
        });
      });
      q.score = q.boxes.filter((b) => b.status === 'correct').length;
      q.submissions = `${Math.max(...q.boxes.map((b) => b.part.submissions ?? 0))}/5`;
      const results = q.boxes.map((b) => ({ index: b.index, status: b.status, score: b.part.score, total: b.part.total, submissions: b.part.submissions, maxSubmissions: b.part.maxSubmissions, message: b.mark?.title ?? null }));
      return wait({ submitted: true, allCorrect: results.every((r) => r.status === 'correct'), results, before: { score: null, submissions: null }, question: q }, 700);
    },
  });
}
