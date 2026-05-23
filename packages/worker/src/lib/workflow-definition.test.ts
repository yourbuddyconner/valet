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
