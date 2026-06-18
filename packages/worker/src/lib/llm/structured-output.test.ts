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

import { parseModelId, hasProviderKey, generateStructured } from './structured-output.js';
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

  it('uses structured object generation when an output schema is provided', async () => {
    const outputSchema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'] };
    generateObject.mockResolvedValue({ object: { ok: true } });

    const result = await generateStructured({
      env: { OPENAI_API_KEY: 'sk-openai' } as Env,
      modelId: 'openai:gpt-4o',
      prompt: 'Return JSON.',
      outputSchema,
    });

    expect(result).toEqual({ value: { ok: true }, attempts: 1 });
    expect(generateObject).toHaveBeenCalledWith(expect.objectContaining({
      model: { provider: 'openai', model: 'gpt-4o' },
      schema: { kind: 'jsonSchema', schema: outputSchema },
      prompt: 'Return JSON.',
    }));
    expect(generateText).not.toHaveBeenCalled();
  });
});
