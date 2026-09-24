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

const a = (word: string) => (/^[aeiou]/i.test(word) ? `an ${word}` : `a ${word}`);

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
    const numeric = typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
    const ok = schema.type === 'integer'
      ? (typeof value === 'number' && Number.isInteger(value)) || (numeric && Number.isInteger(Number(value)))
      : schema.type === 'number'
        ? typeof value === 'number' || numeric
        : schema.type === 'string'
          ? actual === 'string' || actual === 'number' || actual === 'boolean'
          : actual === schema.type;
    if (!ok) return `${where} should be ${a(schema.type)}, got ${actual}`;
    if (!optional && schema.enum && !schema.enum.includes(value) && !schema.enum.includes(String(value))) {
      return `${where} is ${JSON.stringify(value)}, which is not one of ${JSON.stringify(schema.enum)}`;
    }
  }
  return '';
}

export function fitsSchema(text: string, schema: Schema | undefined): { value: unknown } | { problem: string } {
  const parsed = parseJson(text);
  if ('problem' in parsed) return parsed;
  const problem = checkSchema(parsed.value, schema);
  return problem ? { problem } : { value: parsed.value };
}
