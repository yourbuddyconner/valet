import { describe, it, expect } from 'vitest';
import { validateWorkflowDefinition } from './workflow-definition.js';

describe('validateWorkflowDefinition – agent_prompt.persona', () => {
  function baseStep(overrides: Record<string, unknown> = {}) {
    return {
      id: 's1',
      type: 'agent_prompt',
      prompt: 'Hello',
      ...overrides,
    };
  }

  function wrap(step: Record<string, unknown>) {
    return { steps: [step] };
  }

  it('rejects non-string persona', () => {
    const result = validateWorkflowDefinition(wrap(baseStep({ persona: 123 })));
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /persona must be a string/.test(e))).toBe(true);
  });

  it('accepts string persona on agent_prompt', () => {
    const result = validateWorkflowDefinition(
      wrap(baseStep({ persona: 'abc-123-uuid' })),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts agent_prompt without persona (field is optional)', () => {
    const result = validateWorkflowDefinition(wrap(baseStep()));
    expect(result.valid).toBe(true);
  });
});

describe('validateWorkflowDefinition – step type allowlist', () => {
  const wrap = (step: Record<string, unknown>) => ({ steps: [step] });

  it('accepts agent_prompt', () => {
    const result = validateWorkflowDefinition(
      wrap({ id: 's1', type: 'agent_prompt', prompt: 'hi' }),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts notify', () => {
    const result = validateWorkflowDefinition(
      wrap({ id: 's1', type: 'notify', content: 'done' }),
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('rejects an unknown step type with a "Valid types" hint', () => {
    const result = validateWorkflowDefinition(
      wrap({ id: 's1', type: 'agnet_prompt', prompt: 'hi' }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /Valid types:/.test(e))).toBe(true);
  });

  it('rejects deprecated `agent` with a migration hint (not the generic unknown-type error)', () => {
    const result = validateWorkflowDefinition(
      wrap({ id: 's1', type: 'agent', prompt: 'hi' }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /no longer supported/.test(e))).toBe(true);
    // deprecated types get the specific hint, not the generic "Valid types" list
    expect(result.errors.some((e) => /Valid types:/.test(e))).toBe(false);
  });

  it('rejects deprecated `agent_message`', () => {
    const result = validateWorkflowDefinition(
      wrap({ id: 's1', type: 'agent_message', content: 'hi' }),
    );
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => /no longer supported/.test(e))).toBe(true);
  });
});

describe('validateWorkflowDefinition – loop.over', () => {
  function loopStep(overrides: Record<string, unknown> = {}) {
    return {
      id: 'L',
      type: 'loop',
      steps: [{ id: 'inner', type: 'bash', command: 'echo hi' }],
      ...overrides,
    };
  }
  const wrap = (s: Record<string, unknown>) => ({ steps: [s] });

  it('accepts an inline array as `over`', () => {
    const result = validateWorkflowDefinition(wrap(loopStep({ over: ['a', 'b', 'c'] })));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it('accepts a non-empty string path as `over`', () => {
    const result = validateWorkflowDefinition(wrap(loopStep({ over: 'outputs.list' })));
    expect(result.valid).toBe(true);
  });

  it('rejects an empty string `over`', () => {
    const result = validateWorkflowDefinition(wrap(loopStep({ over: '   ' })));
    expect(result.valid).toBe(false);
  });

  it('rejects a missing `over`', () => {
    const result = validateWorkflowDefinition(wrap(loopStep()));
    expect(result.valid).toBe(false);
  });
});
