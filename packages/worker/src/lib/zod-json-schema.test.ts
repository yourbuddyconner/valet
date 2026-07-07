import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { zodToJsonSchema } from './zod-json-schema.js';

describe('zodToJsonSchema', () => {
  it('returns {} for missing schema', () => {
    expect(zodToJsonSchema(undefined)).toEqual({});
  });

  it('converts a flat object with mixed primitives', () => {
    const schema = z.object({
      owner: z.string().describe('Repository owner'),
      stars: z.number().int(),
      archived: z.boolean(),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'Repository owner' },
        stars: { type: 'integer' },
        archived: { type: 'boolean' },
      },
      required: ['owner', 'stars', 'archived'],
    });
  });

  it('marks optional / default fields as not required', () => {
    const schema = z.object({
      name: z.string(),
      page: z.number().int().optional(),
      sort: z.enum(['asc', 'desc']).default('asc'),
    });
    const result = zodToJsonSchema(schema) as {
      required: string[];
      properties: Record<string, { type?: string; enum?: string[] }>;
    };
    expect(result.required).toEqual(['name']);
    expect(result.properties.page).toEqual({ type: 'integer' });
    expect(result.properties.sort).toEqual({ type: 'string', enum: ['asc', 'desc'] });
  });

  it('emits arrays with items', () => {
    const schema = z.object({
      labels: z.array(z.string()),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        labels: { type: 'array', items: { type: 'string' } },
      },
      required: ['labels'],
    });
  });

  it('emits nested objects', () => {
    const schema = z.object({
      repo: z.object({ owner: z.string(), name: z.string() }),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        repo: {
          type: 'object',
          properties: {
            owner: { type: 'string' },
            name: { type: 'string' },
          },
          required: ['owner', 'name'],
        },
      },
      required: ['repo'],
    });
  });

  it('handles ZodLiteral as a single-value enum', () => {
    const schema = z.object({
      kind: z.literal('issue'),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: { kind: { type: 'string', enum: ['issue'] } },
      required: ['kind'],
    });
  });

  it('emits anyOf for unions', () => {
    const schema = z.object({
      ref: z.union([z.string(), z.number()]),
    });
    const result = zodToJsonSchema(schema) as {
      properties: Record<string, { anyOf?: Array<Record<string, unknown>> }>;
    };
    expect(result.properties.ref.anyOf).toEqual([{ type: 'string' }, { type: 'number' }]);
  });

  it('emits additionalProperties for records', () => {
    const schema = z.object({
      headers: z.record(z.string()),
    });
    expect(zodToJsonSchema(schema)).toEqual({
      type: 'object',
      properties: {
        headers: { type: 'object', additionalProperties: { type: 'string' } },
      },
      required: ['headers'],
    });
  });

  it('preserves nullable inner type and marks not required', () => {
    const schema = z.object({
      cursor: z.string().nullable(),
    });
    // nullable does not flip required, but optional+nullable does.
    expect((zodToJsonSchema(schema) as { required: string[] }).required).toEqual(['cursor']);
  });

  it('falls through to {} on unknown constructs without throwing', () => {
    const exotic = z.lazy(() => z.string());
    expect(zodToJsonSchema(z.object({ x: exotic }))).toEqual({
      type: 'object',
      properties: { x: {} },
      required: ['x'],
    });
  });
});
