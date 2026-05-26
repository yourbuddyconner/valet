import { describe, it, expect } from 'vitest';
import { assembleAgentPromptOutput } from './agent-prompt-output.js';

describe('assembleAgentPromptOutput', () => {
  it('sums tokens across all new usage entries', () => {
    const out = assembleAgentPromptOutput({
      response: 'hi',
      newUsageEntries: [
        { inputTokens: 10, outputTokens: 5 },
        { inputTokens: 20, outputTokens: 7 },
      ],
      model: 'claude-opus-4-7',
      durationMs: 42,
    });
    expect(out).toEqual({
      response: 'hi',
      model: 'claude-opus-4-7',
      inputTokens: 30,
      outputTokens: 12,
      durationMs: 42,
    });
  });

  it('returns zero tokens when there are no new entries', () => {
    const out = assembleAgentPromptOutput({
      response: { key: 'value' },
      newUsageEntries: [],
      model: null,
      durationMs: 0,
    });
    expect(out.inputTokens).toBe(0);
    expect(out.outputTokens).toBe(0);
    expect(out.response).toEqual({ key: 'value' });
    expect(out.model).toBeNull();
  });

  it('preserves structured (object) responses as-is', () => {
    const structured = { greeting: 'hi', capability: 'reads' };
    const out = assembleAgentPromptOutput({
      response: structured,
      newUsageEntries: [{ inputTokens: 1, outputTokens: 1 }],
      model: 'm',
      durationMs: 1,
    });
    expect(out.response).toBe(structured);
  });
});
