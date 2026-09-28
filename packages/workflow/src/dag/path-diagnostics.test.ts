/**
 * A path that does not resolve renders as empty and the run reports
 * success. These tests pin what the author is told instead: which segment
 * failed, what was in scope there, and the path that works.
 *
 * Every suggestion assertion is also a contract assertion. The shapes
 * below are the real ones: a trigger payload's fields under `data`, an llm
 * node's `text` (`llm.ts` `LlmResult`), a session or thread node's
 * `response` (`session.ts` `buildSettledResult`), and a structured result
 * under `output`.
 */
import { describe, expect, it } from 'vitest';

import { renderTemplate, withMissRecorder, type TemplateContext } from './expression.js';
import { createMissRecorder, diagnosePath, type DiagnosticSite } from './path-diagnostics.js';

const ctx: TemplateContext = {
  trigger: {
    type: 'webhook',
    timestamp: '2026-01-01T00:00:00Z',
    data: { email: 'a@b.com', count: 3 },
    metadata: {},
  },
  nodes: {
    // llm node, no outputSchema.
    draft: { result: { text: 'hello', usage: { inputTokens: 10 } } },
    // llm node with an outputSchema.
    classify: { result: { text: '{"label":"billing"}', output: { label: 'billing' }, usage: {} } },
    // session / thread node.
    plan: { result: { sessionId: 's-1', response: 'done', output: { summary: 'do the thing' } } },
  },
};

function site(field = 'prompt'): DiagnosticSite {
  return { nodeId: 'notify', field, origin: 'field' };
}

describe('diagnosePath', () => {
  it('returns null for a path that resolves', () => {
    expect(diagnosePath(ctx, ['trigger', 'data', 'email'], site())).toBeNull();
    expect(diagnosePath(ctx, ['nodes', 'draft', 'result', 'text'], site())).toBeNull();
  });

  it('returns null for a path whose value is null or false', () => {
    const withFalsy: TemplateContext = { nodes: { gate: { result: { approved: false, note: null } } } };
    expect(diagnosePath(withFalsy, ['nodes', 'gate', 'result', 'approved'], site())).toBeNull();
    expect(diagnosePath(withFalsy, ['nodes', 'gate', 'result', 'note'], site())).toBeNull();
  });

  it('names the path, the node, the failed segment and the keys in scope', () => {
    const found = diagnosePath(ctx, ['nodes', 'draft', 'result', 'response'], site('prompt'));
    expect(found).not.toBeNull();
    expect(found?.path).toBe('nodes.draft.result.response');
    expect(found?.nodeId).toBe('notify');
    expect(found?.field).toBe('prompt');
    expect(found?.failedSegment).toBe('response');
    expect(found?.failedIndex).toBe(3);
    expect(found?.resolvedPrefix).toBe('nodes.draft.result');
    expect(found?.reason).toBe('missing_key');
    expect(found?.availableKeys).toEqual(['text', 'usage']);
  });

  it('suggests trigger.data.<field> for a trigger field written at the root', () => {
    const found = diagnosePath(ctx, ['trigger', 'email'], site());
    expect(found?.suggestion).toBe('trigger.data.email');
    expect(found?.message).toContain('"trigger.data.email"');
  });

  it('crosses between the two names for produced text', () => {
    // An llm node answers at `text`; a session or thread node
    // answers at `response`. Each suggests the other's name.
    expect(diagnosePath(ctx, ['nodes', 'draft', 'result', 'response'], site())?.suggestion).toBe(
      'nodes.draft.result.text',
    );
    expect(diagnosePath(ctx, ['nodes', 'plan', 'result', 'text'], site())?.suggestion).toBe(
      'nodes.plan.result.response',
    );
    expect(diagnosePath(ctx, ['nodes', 'draft', 'result', 'content'], site())?.suggestion).toBe(
      'nodes.draft.result.text',
    );
  });

  it('suggests the missing .output hop for a structured result', () => {
    expect(diagnosePath(ctx, ['nodes', 'classify', 'result', 'label'], site())?.suggestion).toBe(
      'nodes.classify.result.output.label',
    );
    expect(diagnosePath(ctx, ['nodes', 'plan', 'result', 'summary'], site())?.suggestion).toBe(
      'nodes.plan.result.output.summary',
    );
  });

  it('suggests the nearest key for a typo', () => {
    expect(diagnosePath(ctx, ['trigger', 'data', 'emial'], site())?.suggestion).toBe('trigger.data.email');
  });

  it('keeps the rest of the path when it corrects one segment', () => {
    const deep: TemplateContext = { nodes: { fetch: { result: { data: { user: { name: 'x' } } } } } };
    expect(diagnosePath(deep, ['nodes', 'fetch', 'result', 'user', 'name'], site())?.suggestion).toBe(
      'nodes.fetch.result.data.user.name',
    );
  });

  it('offers no suggestion when nothing resolves, and names the next action', () => {
    const found = diagnosePath(ctx, ['nodes', 'draft', 'result', 'nowhere'], site());
    expect(found?.suggestion).toBeUndefined();
    expect(found?.message).toContain('exists(...)');
  });

  it('reports a node that has no entry, and says why', () => {
    const found = diagnosePath(ctx, ['nodes', 'later', 'result'], site());
    expect(found?.failedSegment).toBe('later');
    expect(found?.resolvedPrefix).toBe('nodes');
    expect(found?.availableKeys).toEqual(['draft', 'classify', 'plan']);
    expect(found?.message).toContain('A node appears here only after it completes.');
  });

  it('reports reading a key off a leaf value, and suggests the leaf', () => {
    const found = diagnosePath(ctx, ['nodes', 'draft', 'result', 'text', 'value'], site());
    expect(found?.reason).toBe('not_an_object');
    expect(found?.message).toContain('a string');
    expect(found?.suggestion).toBe('nodes.draft.result.text');
  });

  it('separates a key that is present but holds no value', () => {
    const empty: TemplateContext = { trigger: { data: { email: undefined } } };
    const found = diagnosePath(empty, ['trigger', 'data', 'email'], site());
    expect(found?.reason).toBe('no_value');
    expect(found?.message).toContain('holds no value');
    expect(found?.message).toContain('Check that the node upstream produced this value.');
  });

  it('reports an unknown root against the keys the context has', () => {
    const found = diagnosePath({ ...ctx, item: { name: 'a' } }, ['itm', 'name'], site());
    expect(found?.failedIndex).toBe(0);
    expect(found?.resolvedPrefix).toBe('');
    expect(found?.message).toContain('the template context');
    expect(found?.suggestion).toBe('item.name');
  });

  it('marks a predicate surface as not enforceable', () => {
    const found = diagnosePath(ctx, ['trigger', 'data', 'nope'], {
      nodeId: 'gate',
      field: 'conditions[0].left',
      origin: 'field',
      enforceable: false,
    });
    expect(found?.enforceable).toBe(false);
  });
});

describe('createMissRecorder', () => {
  it('records the paths a render did not resolve, without changing the render', () => {
    const { recorder, diagnostics } = createMissRecorder('notify');
    const recording = withMissRecorder(ctx, recorder);

    expect(renderTemplate('{{nodes.draft.result.response}}', recording)).toBeNull();
    expect(renderTemplate('Hi {{trigger.email}}!', recording)).toBe('Hi !');
    expect(renderTemplate('{{trigger.data.email}}', recording)).toBe('a@b.com');

    expect(diagnostics.map((d) => d.path)).toEqual(['nodes.draft.result.response', 'trigger.email']);
    expect(diagnostics.every((d) => d.origin === 'runtime')).toBe(true);
    expect(diagnostics[1]?.suggestion).toBe('trigger.data.email');
  });

  it('records one finding per path, however many times it is rendered', () => {
    const { recorder, diagnostics } = createMissRecorder('loop');
    const recording = withMissRecorder(ctx, recorder);
    for (let i = 0; i < 50; i++) renderTemplate('{{item.nmae}}', { ...recording, item: { name: 'x' } });
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.suggestion).toBe('item.name');
  });

  it('does not record an exists() probe', () => {
    const { recorder, diagnostics } = createMissRecorder('gate');
    const recording = withMissRecorder(ctx, recorder);
    expect(renderTemplate('{{exists(trigger.data.optional)}}', recording)).toBe(false);
    expect(diagnostics).toEqual([]);
  });
});
