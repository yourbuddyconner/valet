import { describe, expect, it } from 'vitest';
import { groupModelsByUser, formatModelLabel, type UserModelRow } from './user-breakdown';

function row(userId: string, model: string, cost: number | null = null): UserModelRow {
  return { userId, model, inputTokens: 0, outputTokens: 0, cost, callCount: 1 };
}

describe('groupModelsByUser', () => {
  it('returns an empty map for no rows', () => {
    expect(groupModelsByUser([]).size).toBe(0);
  });

  it('groups rows by userId and preserves input order per user', () => {
    const grouped = groupModelsByUser([
      row('alice', 'anthropic/claude-opus-4-8'),
      row('bob', 'openai/gpt-4o'),
      row('alice', 'google/gemini-2.5-pro'),
    ]);
    expect(grouped.size).toBe(2);
    expect(grouped.get('alice')?.map((r) => r.model)).toEqual([
      'anthropic/claude-opus-4-8',
      'google/gemini-2.5-pro',
    ]);
    expect(grouped.get('bob')?.map((r) => r.model)).toEqual(['openai/gpt-4o']);
  });
});

describe('formatModelLabel', () => {
  it('strips a single provider prefix', () => {
    expect(formatModelLabel('anthropic/claude-opus-4-8')).toBe('claude-opus-4-8');
  });

  it('keeps ids that have no provider prefix', () => {
    expect(formatModelLabel('gpt-4o')).toBe('gpt-4o');
  });

  it('only strips the first segment for nested ids', () => {
    expect(formatModelLabel('openrouter/anthropic/claude')).toBe('anthropic/claude');
  });

  it('falls back to "unknown" for empty or missing ids', () => {
    expect(formatModelLabel('')).toBe('unknown');
    expect(formatModelLabel('   ')).toBe('unknown');
    expect(formatModelLabel(null)).toBe('unknown');
    expect(formatModelLabel(undefined)).toBe('unknown');
  });
});
