/**
 * Structured-output helpers for `agent_prompt` steps.
 *
 * The runner asks the agent for JSON matching a caller-declared schema, then
 * parses + validates the reply. Helpers here are pure and unit-tested in
 * isolation from the OpenCode-integrated runner code in prompt.ts.
 *
 * Extra-keys policy: ALLOWED. Missing required keys are an error. Type
 * mismatches are an error. Allowing extras keeps the agent forgiving when it
 * adds explanatory fields, while strict-on-missing prevents callers from
 * silently consuming an undefined downstream variable.
 */

export type StructuredOutputType = 'string' | 'number' | 'boolean' | 'array' | 'object';

export interface StructuredOutputField {
  type: StructuredOutputType;
  description?: string;
}

export type StructuredOutputSchema = Record<string, StructuredOutputField>;

export type StructuredOutputParseResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; error: string };

const VALID_TYPES: ReadonlySet<StructuredOutputType> = new Set<StructuredOutputType>([
  'string',
  'number',
  'boolean',
  'array',
  'object',
]);

const FIELD_NAME_RE = /^[a-zA-Z_][a-zA-Z0-9_]*$/;

export interface SchemaValidationError {
  message: string;
  path?: string;
}

/**
 * Validate the user-declared schema shape itself (not the agent's reply).
 * Returns errors[] empty when the schema is well-formed.
 */
export function validateOutputSchemaShape(value: unknown, path = 'outputSchema'): SchemaValidationError[] {
  const errors: SchemaValidationError[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    errors.push({ message: 'outputSchema must be an object mapping field names to { type, description? }', path });
    return errors;
  }
  const record = value as Record<string, unknown>;
  for (const [key, field] of Object.entries(record)) {
    if (!FIELD_NAME_RE.test(key)) {
      errors.push({ message: `Field name "${key}" must match /^[a-zA-Z_][a-zA-Z0-9_]*$/`, path: `${path}.${key}` });
      continue;
    }
    if (field === null || typeof field !== 'object' || Array.isArray(field)) {
      errors.push({ message: `Field "${key}" must be an object with { type, description? }`, path: `${path}.${key}` });
      continue;
    }
    const fieldRecord = field as Record<string, unknown>;
    const fieldType = fieldRecord.type;
    if (typeof fieldType !== 'string' || !VALID_TYPES.has(fieldType as StructuredOutputType)) {
      errors.push({
        message: `Field "${key}".type must be one of ${[...VALID_TYPES].join(', ')}`,
        path: `${path}.${key}.type`,
      });
    }
    if (fieldRecord.description !== undefined && typeof fieldRecord.description !== 'string') {
      errors.push({ message: `Field "${key}".description must be a string`, path: `${path}.${key}.description` });
    }
    for (const extraKey of Object.keys(fieldRecord)) {
      if (extraKey !== 'type' && extraKey !== 'description') {
        errors.push({ message: `Field "${key}" has unknown property "${extraKey}"`, path: `${path}.${key}.${extraKey}` });
      }
    }
  }
  return errors;
}

/** Render the schema as a JSON-ish hint, e.g. { "x": "string — desc" }. */
function renderSchemaHint(schema: StructuredOutputSchema): string {
  const entries = Object.entries(schema).map(([key, field]) => {
    const desc = field.description ? ` — ${field.description}` : '';
    return `  ${JSON.stringify(key)}: "${field.type}${desc}"`;
  });
  return `{\n${entries.join(',\n')}\n}`;
}

export function buildSchemaInstructions(prompt: string, schema: StructuredOutputSchema): string {
  const required = Object.keys(schema);
  const hint = renderSchemaHint(schema);
  return [
    prompt,
    '',
    'When you have your final answer, respond with ONLY a JSON object matching this exact shape (no prose before or after, no markdown fences):',
    '',
    hint,
    '',
    `Every key listed above is REQUIRED (${required.join(', ')}). Do not omit any required key. Use null only if the type is allowed.`,
  ].join('\n');
}

export function buildFixupPrompt(error: string, previous: string, schema: StructuredOutputSchema): string {
  const required = Object.keys(schema);
  // Cap the echoed response — agents sometimes spew long replies and we don't
  // want to balloon the retry prompt or hit context limits.
  const truncated = previous.length > 800 ? `${previous.slice(0, 800)}…` : previous;
  return [
    'Your previous response did not match the required schema.',
    `Error: ${error}`,
    '',
    'Your response was:',
    truncated,
    '',
    `Respond again with ONLY a JSON object matching the schema (no prose, no fences). Required fields: ${required.join(', ')}.`,
  ].join('\n');
}

/**
 * Extract a JSON object from a free-form agent reply. Tries, in order:
 *  1. Fenced ```json ... ``` block.
 *  2. The whole trimmed text if it starts with '{'.
 *  3. The first balanced {...} substring.
 */
function extractJsonCandidate(text: string): string | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch && fenceMatch[1]) {
    const inner = fenceMatch[1].trim();
    if (inner.startsWith('{')) return inner;
  }

  if (trimmed.startsWith('{')) return trimmed;

  // Last-resort: scan for the first balanced object. Naive but adequate for
  // the well-formed JSON the agent should be returning.
  const start = trimmed.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\' && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) return trimmed.slice(start, i + 1);
    }
  }
  return null;
}

function typeMatches(value: unknown, expected: StructuredOutputType): boolean {
  switch (expected) {
    case 'string': return typeof value === 'string';
    case 'number': return typeof value === 'number' && Number.isFinite(value);
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'object': return typeof value === 'object' && value !== null && !Array.isArray(value);
  }
}

export function parseStructuredOutput(text: string, schema: StructuredOutputSchema): StructuredOutputParseResult {
  const candidate = extractJsonCandidate(text);
  if (!candidate) {
    return { ok: false, error: 'no JSON object found in response' };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(candidate);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: `JSON parse failed: ${msg}` };
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { ok: false, error: 'parsed value is not a JSON object' };
  }

  const obj = parsed as Record<string, unknown>;
  for (const [key, field] of Object.entries(schema)) {
    if (!(key in obj)) {
      return { ok: false, error: `missing required field "${key}" (expected ${field.type})` };
    }
    const value = obj[key];
    // null is permitted on any field — callers can express "absence" without
    // dropping the key. Type checks pass through for nulls.
    if (value === null) continue;
    if (!typeMatches(value, field.type)) {
      return { ok: false, error: `field "${key}" has wrong type (expected ${field.type}, got ${describeRuntimeType(value)})` };
    }
  }

  return { ok: true, value: obj };
}

function describeRuntimeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** Total attempts allowed for structured-output (initial + retries). */
export const STRUCTURED_OUTPUT_MAX_ATTEMPTS = 3;
