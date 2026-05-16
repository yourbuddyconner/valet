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
      'subworkflow',
      'approval',
    ]) {
      expect(sys).toContain(t);
    }
  });

  it('teaches outputSchema, the question-tool prohibition, template interpolation, and deprecates agent_message', () => {
    const sys = buildSystemPrompt();
    expect(sys).toContain('outputSchema');
    expect(sys.toLowerCase()).toContain('cannot ask');
    expect(sys.toLowerCase()).toContain('template interpolation');
    expect(sys).toMatch(/agent_message[\s\S]{0,60}DEPRECATED/i);
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
