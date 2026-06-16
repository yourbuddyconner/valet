import { describe, it, expect } from 'vitest';
import { parseModelId, hasProviderKey } from './structured-output.js';
import type { Env } from '../../env.js';

describe('parseModelId', () => {
  it('parses anthropic/openai/google prefixes', () => {
    expect(parseModelId('anthropic:claude-3-5-sonnet')).toEqual({ provider: 'anthropic', model: 'claude-3-5-sonnet' });
    expect(parseModelId('openai:gpt-4o')).toEqual({ provider: 'openai', model: 'gpt-4o' });
    expect(parseModelId('google:gemini-2.0-flash')).toEqual({ provider: 'google', model: 'gemini-2.0-flash' });
  });

  it('preserves slashes and colons that appear AFTER the prefix', () => {
    // Models like openrouter-style or version pins.
    expect(parseModelId('anthropic:claude-3-5-sonnet:20240620')).toEqual({
      provider: 'anthropic',
      model: 'claude-3-5-sonnet:20240620',
    });
  });

  it('rejects unprefixed ids', () => {
    expect(() => parseModelId('claude-3-5-sonnet')).toThrow(/provider-prefixed/);
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
