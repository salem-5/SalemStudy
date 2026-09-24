export type Course = {
  id: string;
  courseId: string;
  sectionId: string;
  course: string;
  section: string;
  term: string;
  current: boolean;
};

export type AssignmentSummary = {
  id: number;
  assignmentId: number;
  name: string;
  category: string;
  due: string;
  past: boolean;
  score: number | null;
  total: number | null;
  percentage: number | null;
  submitted: boolean;
  extended: boolean;
  excused: boolean;
};

export type AssignmentList = { sectionId: string; current: AssignmentSummary[]; past: AssignmentSummary[] };

export type BoxKind = 'math' | 'text' | 'essay' | 'choice' | 'checkboxes' | 'multiselect' | 'unsupported';
export type BoxStatus = 'correct' | 'incorrect' | 'partial' | 'submitted' | 'unanswered';

export type Choice = { value: string; label: string; html?: string | null };

export type Box = {
  index: number;
  id: string;
  type: string;
  typeName: string;
  kind: BoxKind;
  display: 'dropdown' | 'radio' | 'checkbox' | null;
  value: string;
  text: string;
  choices: Choice[] | null;
  hint: string | null;
  status: BoxStatus;
  mark: { state: string; title: string | null } | null;
  part: {
    score: number | null;
    total: number | null;
    submissions: number | null;
    maxSubmissions: number | null;
    state: string | null;
  };
};

export type Question = {
  number: number;
  id: string;
  position: number;
  code: string | null;
  score: number | null;
  total: number | null;
  submissions: string | null;
  text: string;
  html?: string;
  boxes: Box[];
};

export type Assignment = { id: number; name: string; questions: Question[] };

export type PartResult = {
  index: number;
  status: BoxStatus;
  score: number | null;
  total: number | null;
  submissions: number | null;
  maxSubmissions: number | null;
  message: string | null;
};

export type SubmitResult = {
  submitted: true;
  allCorrect: boolean;
  results: PartResult[];
  before: { score: number | null; submissions: string | null };
  question: Question;
};

export type AnswerEcho = { index: number; kind: string; response: string; text: string; changed: boolean };
export type SaveResult = { saved: boolean; reason?: string; answers: AnswerEcho[] };
export type DryRun = { dryRun: true; url: string; data: unknown; answers: AnswerEcho[] };

export type Status = {
  connected: boolean;
  lastPollAgoMs: number | null;
  page: string | null;
  userscriptVersion?: string | null;
  queued: number;
  inFlight: number;
};

export type BridgeInfo = {
  port: number;
  managed: boolean;
  processAlive: boolean;
  error: string | null;
  log: string[];
};

export type ApiError = { status: number; error: string };

export type Draft = string | string[];
