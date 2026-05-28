import { describe, it, expect } from 'vitest';
import { buildSystemPrompt, buildUserMessage, extractWorkflowFromResponse } from './workflow-draft';

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

describe('buildUserMessage', () => {
  it('returns the bare prompt for a fresh draft', () => {
    expect(buildUserMessage({ userPrompt: 'make a thing' })).toBe('make a thing');
  });

  it('embeds the base draft for a refinement', () => {
    const msg = buildUserMessage({
      userPrompt: 'add a notify step',
      baseDraft: { id: 'x', name: 'X', steps: [] },
    });
    expect(msg).toContain('Current draft:');
    expect(msg).toContain('"id": "x"');
    expect(msg).toContain('add a notify step');
  });

  it('feeds prior draft + validation errors back on retry', () => {
    const msg = buildUserMessage({
      userPrompt: 'loop over the items',
      previousAttempt: {
        workflow: { id: 'x', name: 'X', steps: [{ id: 'L', type: 'loop' }] },
        errors: ['steps[0].over is required', 'steps[0].steps must be non-empty'],
      },
    });
    expect(msg).toContain('failed validation');
    expect(msg).toContain('loop over the items'); // original instruction preserved
    expect(msg).toContain('Your previous draft:');
    expect(msg).toContain('"type": "loop"'); // the rejected draft is included
    expect(msg).toContain('1. steps[0].over is required');
    expect(msg).toContain('2. steps[0].steps must be non-empty');
    expect(msg).toContain('Fix the errors');
  });

  it('prefers previousAttempt over baseDraft when both present', () => {
    const msg = buildUserMessage({
      userPrompt: 'p',
      baseDraft: { id: 'base', name: 'B', steps: [] },
      previousAttempt: { workflow: { id: 'prev', name: 'P', steps: [] }, errors: ['e'] },
    });
    expect(msg).toContain('failed validation');
    expect(msg).toContain('"id": "prev"');
    expect(msg).not.toContain('"id": "base"');
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
