import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, extractWorkflowFromResponse } from './workflow-draft';

describe('buildSystemPrompt', () => {
  it('mentions every step type by name', () => {
    const sys = buildSystemPrompt();
    for (const t of [
      'agent_prompt',
      'notify',
      'tool',
      'bash',
      'conditional',
      'parallel',
      'loop',
      'approval',
    ]) {
      expect(sys).toContain(t);
    }
  });

  it('teaches outputSchema, the question-tool prohibition, template interpolation, and omits agent_message', () => {
    const sys = buildSystemPrompt();
    expect(sys).toContain('outputSchema');
    expect(sys.toLowerCase()).toContain('cannot ask');
    expect(sys.toLowerCase()).toContain('template interpolation');
    expect(sys).not.toContain('agent_message');
    expect(sys).toContain('over');
    expect(sys).toContain('loop.item');
  });

  it('documents failureNotify for orchestrator escalation', () => {
    const sys = buildSystemPrompt();
    expect(sys).toContain('failureNotify');
  });

  it('documents the conditional expression syntax', () => {
    const sys = buildSystemPrompt();
    expect(sys).toContain('Comparators:');
    expect(sys).toContain('===');
    expect(sys).toContain('!==');
    expect(sys).toContain('&&');
    expect(sys).toContain('||');
    expect(sys).toContain('Path lookups');
    expect(sys.toLowerCase()).toContain('no type coercion');
    expect(sys.toLowerCase()).toContain('missing paths');
  });
});

describe('extractWorkflowFromResponse', () => {
  it('parses bare JSON', () => {
    const wf = extractWorkflowFromResponse('{"id":"x","name":"X","steps":[]}');
    expect(wf).toEqual({ id: 'x', name: 'X', steps: [] });
  });

  it('parses fenced ```json blocks', () => {
    const wf = extractWorkflowFromResponse(
      'Here is your workflow:\n```json\n{"id":"x","name":"X","steps":[]}\n```',
    );
    expect(wf).toEqual({ id: 'x', name: 'X', steps: [] });
  });

  it('returns null when no JSON is present', () => {
    expect(extractWorkflowFromResponse('I cannot help with that.')).toBeNull();
  });
});
