import { describe, expect, it } from 'bun:test';
import {
  buildFixupPrompt,
  buildSchemaInstructions,
  parseStructuredOutput,
  validateOutputSchemaShape,
  type StructuredOutputSchema,
} from './workflow-structured-output.js';

const SCHEMA: StructuredOutputSchema = {
  summary: { type: 'string', description: 'one-line summary' },
  count: { type: 'number' },
  tags: { type: 'array', description: 'list of tags' },
};

describe('validateOutputSchemaShape', () => {
  it('accepts a well-formed schema', () => {
    expect(validateOutputSchemaShape(SCHEMA)).toEqual([]);
  });

  it('rejects unknown type', () => {
    const errs = validateOutputSchemaShape({ x: { type: 'date' } });
    expect(errs.length).toBeGreaterThan(0);
    expect(errs[0]?.message).toMatch(/type must be one of/);
  });

  it('rejects bad field names', () => {
    const errs = validateOutputSchemaShape({ '1bad': { type: 'string' } });
    expect(errs[0]?.message).toMatch(/Field name/);
  });

  it('rejects extra properties on field descriptor', () => {
    const errs = validateOutputSchemaShape({ x: { type: 'string', required: true } });
    expect(errs.some((e) => /unknown property/.test(e.message))).toBe(true);
  });

  it('rejects non-string description', () => {
    const errs = validateOutputSchemaShape({ x: { type: 'string', description: 123 } });
    expect(errs.some((e) => /description must be a string/.test(e.message))).toBe(true);
  });
});

describe('buildSchemaInstructions', () => {
  it('includes prompt, types, and required-field list', () => {
    const out = buildSchemaInstructions('Pick a fruit.', SCHEMA);
    expect(out).toContain('Pick a fruit.');
    expect(out).toContain('"summary": "string — one-line summary"');
    expect(out).toContain('"count": "number"');
    expect(out).toContain('"tags": "array — list of tags"');
    expect(out).toContain('summary, count, tags');
    expect(out).toContain('no markdown fences');
  });
});

describe('buildFixupPrompt', () => {
  it('echoes the error and lists required fields', () => {
    const out = buildFixupPrompt('missing field "summary"', '{"count": 1}', SCHEMA);
    expect(out).toContain('missing field "summary"');
    expect(out).toContain('{"count": 1}');
    expect(out).toContain('summary, count, tags');
  });

  it('truncates very long previous replies', () => {
    const long = 'x'.repeat(2_000);
    const out = buildFixupPrompt('bad', long, SCHEMA);
    // 800 chars of x plus ellipsis
    expect(out).toContain('x'.repeat(800));
    expect(out).not.toContain('x'.repeat(801));
    expect(out).toContain('…');
  });
});

describe('parseStructuredOutput', () => {
  it('parses bare JSON object', () => {
    const result = parseStructuredOutput('{"summary":"hi","count":2,"tags":["a"]}', SCHEMA);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.summary).toBe('hi');
  });

  it('parses JSON wrapped in markdown fence', () => {
    const text = '```json\n{"summary":"hi","count":2,"tags":[]}\n```';
    const result = parseStructuredOutput(text, SCHEMA);
    expect(result.ok).toBe(true);
  });

  it('parses JSON wrapped in unlabeled fence', () => {
    const text = '```\n{"summary":"hi","count":2,"tags":[]}\n```';
    const result = parseStructuredOutput(text, SCHEMA);
    expect(result.ok).toBe(true);
  });

  it('extracts embedded JSON object from prose', () => {
    const text = 'Sure! Here is the result: {"summary":"hi","count":2,"tags":[]} done.';
    const result = parseStructuredOutput(text, SCHEMA);
    expect(result.ok).toBe(true);
  });

  it('fails on missing required key', () => {
    const result = parseStructuredOutput('{"summary":"hi","count":2}', SCHEMA);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/missing required field "tags"/);
  });

  it('fails on wrong type', () => {
    const result = parseStructuredOutput('{"summary":"hi","count":"two","tags":[]}', SCHEMA);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/wrong type/);
  });

  it('allows extra keys (extras policy: ALLOWED)', () => {
    const result = parseStructuredOutput(
      '{"summary":"hi","count":1,"tags":[],"explanation":"extra detail"}',
      SCHEMA,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.value.explanation).toBe('extra detail');
  });

  it('permits null on any field', () => {
    const result = parseStructuredOutput('{"summary":null,"count":null,"tags":null}', SCHEMA);
    expect(result.ok).toBe(true);
  });

  it('rejects non-object JSON', () => {
    const result = parseStructuredOutput('[1,2,3]', SCHEMA);
    expect(result.ok).toBe(false);
  });

  it('rejects when no JSON present', () => {
    const result = parseStructuredOutput('I do not know.', SCHEMA);
    expect(result.ok).toBe(false);
  });

  it('rejects invalid JSON', () => {
    const result = parseStructuredOutput('{summary: "hi"}', SCHEMA);
    expect(result.ok).toBe(false);
  });
});
