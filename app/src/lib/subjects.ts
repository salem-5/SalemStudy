export type Flavour = 'stem' | 'life' | 'business' | 'general';

const PATTERNS: [Flavour, RegExp][] = [
  ['life', /\b(biolog|bio\b|anatom|physiolog|genetic|microbiolog|biochem|molecular|ecolog|zoolog|botan|neuroscience|immunolog|pharma|dental|dentist|veterin|medicine|medical|nursing|histolog|patholog|cell|organic chemistry|biotech)/i],
  ['business', /\b(business|accounting|finance|financial|econom|marketing|management|entrepreneur|commerce|investment|macro|micro|mba|supply chain|operations research|hr\b|human resources|strategy|taxation|audit)/i],
  ['stem', /\b(math|calculus|algebra|geometry|trigonometr|statistic|probability|physic|mechanic|thermodynam|electromag|circuit|engineer|computer science|programming|algorithm|data structure|chemistry|chem\b|dynamics|fluid|signal|control system|discrete|differential|linear algebra|numerical)/i],
];

export function flavourOf(text: string): Flavour {
  const haystack = text.toLowerCase();
  for (const [flavour, pattern] of PATTERNS) {
    if (pattern.test(haystack)) return flavour;
  }
  return 'general';
}

export const courseFlavour = (ctx: { subject: string; notebook: string; courseContext: string }): Flavour =>
  flavourOf(`${ctx.subject} ${ctx.subject} ${ctx.notebook} ${ctx.courseContext.slice(0, 2000)}`);

export const computational = (flavour: Flavour): boolean => flavour === 'stem' || flavour === 'business';

export const pageByPageFor = (flavour: Flavour): boolean => flavour === 'life';

export const WALK_SYSTEM = `You decide how flashcards and quizzes are written for a university course. There are two ways:
- page by page: the material is walked in order and every page is covered in its own pass. Right for memorisation-heavy subjects whose lectures are dense with facts to learn - biology, medicine, pharmacy and pharmacology, anatomy, physiology, pathology, histology, microbiology, nursing, dentistry, veterinary science, and similar.
- one pass: the whole material in one go, with questions chosen for understanding and problem solving. Right for STEM (mathematics, physics, engineering, computer science, statistics, chemistry problem solving), business, economics, accounting, finance, and similar.
Decide from the course, the notebook and the titles of its sources. When unsure, choose one pass.`;

export const WALK_SCHEMA = {
  type: 'object',
  required: ['page_by_page', 'reason'],
  properties: {
    page_by_page: { type: 'boolean' },
    reason: { type: 'string', description: 'A few words, e.g. "pharmacology is memorisation-heavy".' },
  },
};

export function guidance(flavour: Flavour): string {
  switch (flavour) {
    case 'stem':
      return `This is a STEM course, so the marks are in the working.
- Ask questions that require a derivation, a calculation or a correct application of a rule - not recall of a definition.
- Every question whose answer is a number or an expression must carry check_code that derives it independently. A question you cannot check is not worth asking.
- Distractors should be the answers a student actually gets when they go wrong: a dropped sign, the reciprocal, degrees instead of radians, the derivative of the wrong factor.
- State units, and be consistent about them. Say how many significant figures you want.
- Explanations show the steps, not just the result.`;
    case 'life':
      return `This is a life-science course, so precision about mechanism and terminology is what matters, not arithmetic.
- Ask about structure and function, cause and effect, sequence and order, and what distinguishes two things that students confuse.
- Do NOT invent calculations. Only write check_code when the question genuinely computes something (a dilution, a ratio, allele frequencies, a rate). Most questions here should have no check_code at all, and that is correct.
- Distractors must be real terms from the same system - an organelle that exists, a hormone from the same axis, a phase of the same process. Never a made-up word, and never something from a different topic entirely.
- Use the exact terminology the student's material uses; if it writes "mitochondrion", do not switch to "mitochondria" in the answer key.
- Explanations say why the wrong options are wrong, because in this subject that is usually where the learning is.`;
    case 'business':
      return `This is a business course, so it is part calculation and part judgement.
- For anything financial or quantitative - ratios, NPV, break-even, elasticity, depreciation, margins - the question must carry check_code that derives the number independently.
- For concepts, frameworks and policy, ask questions that need the idea applied to a situation rather than the definition repeated.
- Distractors should be the other plausible treatment: the wrong ratio for the question, the neighbouring framework, the right idea applied to the wrong stakeholder.
- Name the currency, the period and the convention. Say whether figures are in thousands.
- Explanations state the rule being applied, then the working or the reasoning.`;
    default:
      return `Ask questions that need the material understood rather than recognised.
- Write check_code only when the answer is genuinely computed; most questions in this subject will not need it.
- Distractors should be plausible and from the same topic - never obviously silly, never a different kind of thing.
- Explanations say why the right answer is right and why the near-misses are not.`;
  }
}

export function cardGuidance(flavour: Flavour): string {
  switch (flavour) {
    case 'stem':
      return 'Cards are for the things you must have to hand: a statement of a theorem, a formula and what each symbol is, the condition a rule needs, a standard derivative or integral. Not worked problems - those belong in a quiz.';
    case 'life':
      return 'Cards are for terms, structures, functions and the steps of a process. One structure or one step per card. Where two things are confused with each other, write a card that pins down the difference.';
    case 'business':
      return 'Cards are for definitions, formulas and what a framework is for. One term or one formula per card, with what it is used to decide.';
    default:
      return 'Cards are for single facts, definitions and relationships - one idea per card.';
  }
}
