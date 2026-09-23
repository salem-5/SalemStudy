/**
 * Structural validation of generated data, on this side of the wire.
 *
 * Generation is a plain model call again, so the shape has to be checked
 * where the call is made. Deliberately small: it checks shape, required keys
 * and types, which is what actually goes wrong. Meaning is checked elsewhere
 * — a quiz answer by re-deriving it in Python, a card by reading it.
 *
 * It says *what* is wrong in words, because that sentence goes back to the
 * model as the retry instruction.
 */

export type Schema = {
  type?: string;
  required?: string[];
  properties?: Record<string, Schema>;
  items?: Schema;
  minItems?: number;
  enum?: unknown[];
};

const kindOf = (v: unknown): string =>
  v === null ? 'null' : Array.isArray(v) ? 'array' : typeof v;

/** The sentence goes back to the model, so it should read like one. */
const a = (word: string) => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);

/** The first JSON object or array in a reply, whatever else surrounds it. */
export function parseJson(text: string): { value: unknown } | { problem: string } {
  const trimmed = text.trim();
  let start = trimmed.indexOf('{');
  let end = trimmed.lastIndexOf('}');
  if (start < 0 || end <= start) {
    start = trimmed.indexOf('[');
    end = trimmed.lastIndexOf(']');
  }
  if (start < 0 || end <= start) return { problem: 'the answer was not JSON' };
  try {
    return { value: JSON.parse(trimmed.slice(start, end + 1)) };
  } catch (e) {
    return { problem: `the answer was not valid JSON (${e instanceof Error ? e.message : e})` };
  }
}

/** '' when the value fits, otherwise a sentence saying what does not. */
export function checkSchema(value: unknown, schema: Schema | undefined, path = '', optional = false): string {
  if (!schema || typeof schema !== 'object') return '';
  const where = path || 'the result';
  if (schema.type === 'object') {
    if (kindOf(value) !== 'object') return `${where} should be ${a('object')}, got ${kindOf(value)}`;
    const obj = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!(key in obj)) return `${where} is missing the required key "${key}"`;
    }
    for (const [key, sub] of Object.entries(schema.properties ?? {})) {
      if (key in obj) {
        const problem = checkSchema(obj[key], sub, path ? `${path}.${key}` : key, !(schema.required ?? []).includes(key));
        if (problem) return problem;
      }
    }
    return '';
  }
  if (schema.type === 'array') {
    if (!Array.isArray(value)) return `${where} should be ${a('array')}, got ${kindOf(value)}`;
    if (schema.minItems != null && value.length < schema.minItems) {
      return `${where} has ${value.length} items, fewer than the ${schema.minItems} required`;
    }
    for (const [i, entry] of value.slice(0, 200).entries()) {
      const problem = checkSchema(entry, schema.items, `${path}[${i}]`);
      if (problem) return problem;
    }
    return '';
  }
  if (schema.type === 'string' || schema.type === 'number' || schema.type === 'integer' || schema.type === 'boolean') {
    const actual = kindOf(value);
    // A number where text was asked for ("answer": 2 for an option index) or
    // a number written as text is the same answer; the caller reads both. A
    // whole pass thrown away over the quotes would be the real failure.
    const numeric = typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
    const ok = schema.type === 'integer'
      ? (typeof value === 'number' && Number.isInteger(value)) || (numeric && Number.isInteger(Number(value)))
      : schema.type === 'number'
        ? typeof value === 'number' || numeric
        : schema.type === 'string'
          ? actual === 'string' || actual === 'number' || actual === 'boolean'
          : actual === schema.type;
    if (!ok) return `${where} should be ${a(schema.type)}, got ${actual}`;
    // An optional field with a value outside its list ("importance":
    // "medium") is the reader's to drop, one item at a time; failing the
    // shape here threw away a whole pass of questions over it.
    if (!optional && schema.enum && !schema.enum.includes(value) && !schema.enum.includes(String(value))) {
      return `${where} is ${JSON.stringify(value)}, which is not one of ${JSON.stringify(schema.enum)}`;
    }
  }
  return '';
}

/** Parse and check in one go. */
export function fitsSchema(text: string, schema: Schema | undefined): { value: unknown } | { problem: string } {
  const parsed = parseJson(text);
  if ('problem' in parsed) return parsed;
  const problem = checkSchema(parsed.value, schema);
  return problem ? { problem } : { value: parsed.value };
}
