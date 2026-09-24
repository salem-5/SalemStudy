import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const src = readFileSync(here('../../webassign-mathpad.user.js'), 'utf8');
const start = src.indexOf('\n    const TRIG = [');
const end = src.indexOf('\n    let current = null;');
if (start < 0 || end < 0) throw new Error('Parser section not found in webassign-mathpad.user.js');
const body = src.slice(start + 1, end + 1).replace(/\n+$/, '\n');

const out = `// @ts-nocheck
const NS = 'http://www.w3.org/1998/Math/MathML';
const EMPTY = \`<math xmlns="\${NS}"/>\`;
${body}
export const toMathML = (expr) => \`<math xmlns="\${NS}">\${parse(expr)}</math>\`;
export { parse, toText, NS, EMPTY, TRIG, TRIG_ALIAS, LOGS, SPECIAL_FUNCS, GREEK_LOWER, GREEK_UPPER, CONST_WORDS, HASH };
`;
writeFileSync(here('../src/lib/mathpad.js'), out);
console.log('src/lib/mathpad.js written');
