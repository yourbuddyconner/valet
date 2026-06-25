import { beforeEach, describe, it, expect, vi } from 'vitest';

const generateObject = vi.fn();
const generateText = vi.fn();

vi.mock('ai', () => ({
  generateObject: (...args: unknown[]) => generateObject(...args),
  generateText: (...args: unknown[]) => generateText(...args),
  jsonSchema: (schema: unknown) => ({ kind: 'jsonSchema', schema }),
  NoObjectGeneratedError: class NoObjectGeneratedError extends Error {},
  JSONParseError: class JSONParseError extends Error {},
  TypeValidationError: class TypeValidationError extends Error {},
}));

vi.mock('@ai-sdk/anthropic', () => ({
  createAnthropic: () => (model: string) => ({ provider: 'anthropic', model }),
}));

vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: () => (model: string) => ({ provider: 'openai', model }),
}));

vi.mock('@ai-sdk/google', () => ({
  createGoogleGenerativeAI: () => (model: string) => ({ provider: 'google', model }),
}));

import { parseModelId, hasProviderKey, generateStructured, parseOrRepairStructuredJson } from './structured-output.js';
import type { Env } from '../../env.js';

beforeEach(() => {
  generateObject.mockReset();
  generateText.mockReset();
});

describe('parseModelId', () => {
  it('parses anthropic/openai/google prefixes', () => {
    expect(parseModelId('anthropic:claude-sonnet-4-5')).toEqual({ provider: 'anthropic', model: 'claude-sonnet-4-5' });
    expect(parseModelId('openai:gpt-4o')).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(parseModelId('google:gemini-2.0-flash')).toEqual({ provider: 'google', model: 'gemini-2.0-flash' });
  });

  it('preserves slashes and colons that appear AFTER the prefix', () => {
    // Models like openrouter-style or version pins.
    expect(parseModelId('anthropic:claude-sonnet-4-5:20240620')).toEqual({
      provider: 'anthropic',
      model: 'claude-sonnet-4-5:20240620',
    });
  });

  it('rejects unprefixed ids', () => {
    expect(() => parseModelId('claude-sonnet-4-5')).toThrow(/provider-prefixed/);
  });

  it('rejects unknown providers', () => {
    expect(() => parseModelId('cohere:command-r')).toThrow(/unsupported LLM provider/);
  });

  it('rejects empty model name', () => {
    expect(() => parseModelId('anthropic:')).toThrow(/missing model name/);
  });
});

describe('hasProviderKey', () => {
  it('returns true when the matching env var is set', () => {
    const env = { ANTHROPIC_API_KEY: 'sk-foo' } as Env;
    expect(hasProviderKey(env, 'anthropic')).toBe(true);
    expect(hasProviderKey(env, 'openai')).toBe(false);
    expect(hasProviderKey(env, 'google')).toBe(false);
  });

  it('returns false for empty strings', () => {
    const env = { OPENAI_API_KEY: '' } as Env;
    expect(hasProviderKey(env, 'openai')).toBe(false);
  });
});

describe('generateStructured', () => {
  it('returns schema-less llm output as a response string', async () => {
    generateText.mockResolvedValue({ text: 'Welcome to Acme.' });

    const result = await generateStructured({
      env: { ANTHROPIC_API_KEY: 'sk-ant' } as Env,
      modelId: 'anthropic:claude-sonnet-4-5',
      prompt: 'Write a welcome email.',
      maxOutputTokens: 100,
    });

    expect(result).toEqual({ value: { response: 'Welcome to Acme.' }, attempts: 1 });
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      prompt: 'Write a welcome email.',
      maxOutputTokens: 100,
    }));
    expect(generateObject).not.toHaveBeenCalled();
  });

  it('uses text generation plus schema validation when an output schema is provided', async () => {
    const outputSchema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
    generateText.mockResolvedValue({ text: '{"ok":true}' });

    const result = await generateStructured({
      env: { OPENAI_API_KEY: 'sk-openai' } as Env,
      modelId: 'openai:gpt-4o',
      prompt: 'Return JSON.',
      outputSchema,
    });

    expect(result).toEqual({ value: { ok: true }, attempts: 1 });
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      model: { provider: 'openai', model: 'gpt-4o' },
      prompt: expect.stringContaining('Return JSON.'),
    }));
    expect(generateObject).not.toHaveBeenCalled();
  });
});

describe('parseOrRepairStructuredJson', () => {
  it('parses and validates raw JSON without calling the repair model', async () => {
    const outputSchema = {
      type: 'object',
      properties: { totalCount: { type: 'number' } },
      required: ['totalCount'],
    };

    const result = await parseOrRepairStructuredJson({
      env: { ANTHROPIC_API_KEY: 'sk-ant' } as Env,
      modelId: 'anthropic:claude-sonnet-4-5',
      text: '{"totalCount":167}',
      outputSchema,
      contextLabel: 'session node "scrape"',
    });

    expect(result).toEqual({ value: { totalCount: 167 }, attempts: 1, repaired: false });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('accepts JSON Schema nullable type arrays without repair', async () => {
    const outputSchema = {
      type: 'object',
      properties: {
        title: { type: ['string', 'null'] },
      },
      required: ['title'],
    };

    const result = await parseOrRepairStructuredJson({
      env: { ANTHROPIC_API_KEY: 'sk-ant' } as Env,
      modelId: 'anthropic:claude-sonnet-4-5',
      text: '{"title":null}',
      outputSchema,
      contextLabel: 'session node "scrape"',
    });

    expect(result).toEqual({ value: { title: null }, attempts: 1, repaired: false });
    expect(generateText).not.toHaveBeenCalled();
  });

  it('repairs invalid JSON using the configured model and validates the repaired object', async () => {
    const outputSchema = {
      type: 'object',
      properties: { totalCount: { type: 'number' } },
      required: ['totalCount'],
    };
    generateText.mockResolvedValue({ text: '{"totalCount":167}' });

    const result = await parseOrRepairStructuredJson({
      env: { ANTHROPIC_API_KEY: 'sk-ant' } as Env,
      modelId: 'anthropic:claude-sonnet-4-5',
      text: '{"totalCount":"167"',
      outputSchema,
      contextLabel: 'session node "scrape"',
      retryBackoffMs: [0, 0, 0],
    });

    expect(result).toEqual({ value: { totalCount: 167 }, attempts: 2, repaired: true });
    expect(generateText).toHaveBeenCalledWith(expect.objectContaining({
      model: { provider: 'anthropic', model: 'claude-sonnet-4-5' },
      prompt: expect.stringContaining('session node "scrape"'),
    }));
    expect(generateText.mock.calls[0]?.[0]?.prompt).toContain('Failed JSON');
    expect(generateText.mock.calls[0]?.[0]?.prompt).toContain('JSON Schema');
  });

  it('repairs schema-invalid JSON and includes the validation error in the prompt', async () => {
    const outputSchema = {
      type: 'object',
      properties: { totalCount: { type: 'number' } },
      required: ['totalCount'],
    };
    generateText.mockResolvedValue({ text: '{"totalCount":167}' });

    await parseOrRepairStructuredJson({
      env: { ANTHROPIC_API_KEY: 'sk-ant' } as Env,
      modelId: 'anthropic:claude-sonnet-4-5',
      text: '{"totalCount":"167"}',
      outputSchema,
      contextLabel: 'session node "scrape"',
      retryBackoffMs: [0, 0, 0],
    });

    expect(generateText.mock.calls[0]?.[0]?.prompt).toContain('$.totalCount: expected number, received string');
  });

  it('throws a clear error after the repair attempts are exhausted', async () => {
    const outputSchema = {
      type: 'object',
      properties: { totalCount: { type: 'number' } },
      required: ['totalCount'],
    };
    generateText.mockResolvedValue({ text: '{"totalCount":"still wrong"}' });

    await expect(parseOrRepairStructuredJson({
      env: { ANTHROPIC_API_KEY: 'sk-ant' } as Env,
      modelId: 'anthropic:claude-sonnet-4-5',
      text: '{"totalCount":"167"}',
      outputSchema,
      contextLabel: 'session node "scrape"',
      retries: 2,
      retryBackoffMs: [0, 0],
    })).rejects.toThrow(/session node "scrape".*does not match outputSchema.*totalCount/s);
  });
});
