import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, extractWorkflowFromResponse } from './workflow-draft';

describe('buildSystemPrompt', () => {
  it('mentions every step type by name', () => {
    const sys = buildSystemPrompt();
    for (const t of [
      'agent_message',
      'tool',
      'bash',
      'conditional',
      'parallel',
      'loop',
      'subworkflow',
      'approval',
    ]) {
      expect(sys).toContain(t);
    }
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
