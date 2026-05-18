import { describe, it, expect } from 'vitest';
import {
  inferScope,
  inferFullScope,
  resolveScopePath,
  type Scope,
} from './scope-inferencer';
import type { WorkflowData } from '@/api/workflows';

function wf(partial: Partial<WorkflowData>): WorkflowData {
  return {
    id: 'wf',
    name: 'test',
    steps: [],
    ...partial,
  };
}

describe('inferScope', () => {
  it('returns empty scope for empty workflow with no target match', () => {
    const scope = inferScope(wf({}), 'nope');
    expect(scope.variables).toEqual({});
    expect(scope.outputs).toEqual({});
    expect(scope.loop).toBeUndefined();
  });

  it('populates variables from workflow.variables', () => {
    const scope = inferScope(
      wf({
        variables: { name: { type: 'string', description: 'who' } },
        steps: [{ id: 'a', name: 'A', type: 'notify' }],
      }),
      'a'
    );
    expect(scope.variables.name).toEqual({ type: 'string', description: 'who' });
  });

  it('publishes preceding step outputVariable as unknown when no schema', () => {
    const scope = inferScope(
      wf({
        steps: [
          { id: 'a', name: 'A', type: 'agent_prompt', outputVariable: 'foo' },
          { id: 'b', name: 'B', type: 'notify' },
        ],
      }),
      'b'
    );
    expect(scope.outputs.foo).toEqual({ type: 'unknown' });
  });

  it('uses outputSchema to type the published output', () => {
    const scope = inferScope(
      wf({
        steps: [
          {
            id: 'a',
            name: 'A',
            type: 'agent_prompt',
            outputVariable: 'foo',
            outputSchema: {
              score: { type: 'number', description: 'the score' },
              label: { type: 'string' },
            },
          },
          { id: 'b', name: 'B', type: 'notify' },
        ],
      }),
      'b'
    );
    expect(scope.outputs.foo.type).toBe('object');
    expect(scope.outputs.foo.fields?.score).toEqual({
      type: 'number',
      description: 'the score',
    });
    expect(scope.outputs.foo.fields?.label).toEqual({ type: 'string' });
  });

  it('current step does not see its own outputVariable', () => {
    const scope = inferScope(
      wf({
        steps: [
          { id: 'a', name: 'A', type: 'agent_prompt', outputVariable: 'foo' },
        ],
      }),
      'a'
    );
    expect(scope.outputs.foo).toBeUndefined();
  });

  it('inside `then`, only prior `then` siblings are visible (not else)', () => {
    const scope = inferScope(
      wf({
        steps: [
          {
            id: 'cond',
            name: 'C',
            type: 'conditional',
            then: [
              { id: 't1', name: 'T1', type: 'agent_prompt', outputVariable: 'tv' },
              { id: 't2', name: 'T2', type: 'notify' },
            ],
            else: [
              { id: 'e1', name: 'E1', type: 'agent_prompt', outputVariable: 'ev' },
            ],
          },
        ],
      }),
      't2'
    );
    expect(scope.outputs.tv).toBeDefined();
    expect(scope.outputs.ev).toBeUndefined();
  });

  it('inside `else`, only `else` siblings are visible', () => {
    const scope = inferScope(
      wf({
        steps: [
          {
            id: 'cond',
            name: 'C',
            type: 'conditional',
            then: [
              { id: 't1', name: 'T1', type: 'agent_prompt', outputVariable: 'tv' },
            ],
            else: [
              { id: 'e1', name: 'E1', type: 'agent_prompt', outputVariable: 'ev' },
              { id: 'e2', name: 'E2', type: 'notify' },
            ],
          },
        ],
      }),
      'e2'
    );
    expect(scope.outputs.ev).toBeDefined();
    expect(scope.outputs.tv).toBeUndefined();
  });

  it('after a conditional, both branch outputs are visible', () => {
    const scope = inferScope(
      wf({
        steps: [
          {
            id: 'cond',
            name: 'C',
            type: 'conditional',
            then: [
              { id: 't1', name: 'T1', type: 'agent_prompt', outputVariable: 'tv' },
            ],
            else: [
              { id: 'e1', name: 'E1', type: 'agent_prompt', outputVariable: 'ev' },
            ],
          },
          { id: 'after', name: 'After', type: 'notify' },
        ],
      }),
      'after'
    );
    expect(scope.outputs.tv).toBeDefined();
    expect(scope.outputs.ev).toBeDefined();
  });

  it('parallel branches do not see each other; post-parallel merges all', () => {
    const inside = inferScope(
      wf({
        steps: [
          {
            id: 'p',
            name: 'P',
            type: 'parallel',
            steps: [
              { id: 'b1', name: 'B1', type: 'agent_prompt', outputVariable: 'av' },
              { id: 'b2', name: 'B2', type: 'notify' },
            ],
          },
        ],
      }),
      'b2'
    );
    // b2 is a parallel sibling of b1 — must NOT see av.
    expect(inside.outputs.av).toBeUndefined();

    const after = inferScope(
      wf({
        steps: [
          {
            id: 'p',
            name: 'P',
            type: 'parallel',
            steps: [
              { id: 'b1', name: 'B1', type: 'agent_prompt', outputVariable: 'av' },
              { id: 'b2', name: 'B2', type: 'agent_prompt', outputVariable: 'bv' },
            ],
          },
          { id: 'after', name: 'After', type: 'notify' },
        ],
      }),
      'after'
    );
    expect(after.outputs.av).toBeDefined();
    expect(after.outputs.bv).toBeDefined();
  });

  it('loop body publishes scope.loop with item typed from `over` array element', () => {
    const scope = inferScope(
      wf({
        variables: {
          xs: {
            type: 'array',
            description: 'array of things',
          },
        },
        steps: [
          {
            id: 'loop',
            name: 'L',
            type: 'loop',
            over: 'variables.xs',
            steps: [{ id: 'body', name: 'B', type: 'notify' }],
          },
        ],
      }),
      'body'
    );
    expect(scope.loop).toBeDefined();
    // xs has no item shape (VariableDefinition doesn't carry one), so item is unknown.
    expect(scope.loop?.item.type).toBe('unknown');
    expect(scope.loop?.index.type).toBe('number');
  });

  it('loop body item is typed when `over` resolves to a typed array', () => {
    // Build via outputSchema: a step that publishes an object with an array field
    // whose item is typed.
    // The current outputSchema shape doesn't express array-of-object item types,
    // so we test the resolver behavior with a synthetic array field by going
    // through a parent step's output.
    // For this test we rely on a typed scope path being resolvable as an array;
    // since we can't author array.item via outputSchema, we test the fallback
    // (unknown) here and rely on resolveScopePath tests for direct-shape coverage.
    const scope = inferScope(
      wf({
        steps: [
          {
            id: 'src',
            name: 'S',
            type: 'agent_prompt',
            outputVariable: 'data',
            outputSchema: { items: { type: 'array', description: 'list' } },
          },
          {
            id: 'loop',
            name: 'L',
            type: 'loop',
            over: 'outputs.data.items',
            steps: [{ id: 'body', name: 'B', type: 'notify' }],
          },
        ],
      }),
      'body'
    );
    // items is array with no item shape, so loop.item is unknown.
    expect(scope.loop?.item.type).toBe('unknown');
  });

  it('loop with custom itemVar/indexVar publishes them as scope.variables', () => {
    const scope = inferScope(
      wf({
        variables: { xs: { type: 'array' } },
        steps: [
          {
            id: 'loop',
            name: 'L',
            type: 'loop',
            over: 'variables.xs',
            itemVar: 'thing',
            indexVar: 'i',
            steps: [{ id: 'body', name: 'B', type: 'notify' }],
          },
        ],
      }),
      'body'
    );
    expect(scope.variables.thing).toBeDefined();
    expect(scope.variables.i).toEqual({ type: 'number' });
  });
});

describe('resolveScopePath', () => {
  const scope: Scope = {
    variables: {
      x: { type: 'string', description: 'an x' },
    },
    outputs: {
      foo: {
        type: 'object',
        fields: {
          score: { type: 'number' },
          nested: {
            type: 'object',
            fields: { deep: { type: 'boolean' } },
          },
        },
      },
      bare: { type: 'unknown' },
    },
    loop: {
      item: { type: 'object', fields: { name: { type: 'string' } } },
      index: { type: 'number' },
    },
  };

  it('resolves variables.x', () => {
    expect(resolveScopePath(scope, 'variables.x')).toEqual({
      type: 'string',
      description: 'an x',
    });
  });

  it('resolves outputs.foo.score', () => {
    expect(resolveScopePath(scope, 'outputs.foo.score')).toEqual({
      type: 'number',
    });
  });

  it('walks nested object fields', () => {
    expect(resolveScopePath(scope, 'outputs.foo.nested.deep')).toEqual({
      type: 'boolean',
    });
  });

  it('returns null for missing top-level name', () => {
    expect(resolveScopePath(scope, 'outputs.missing')).toBeNull();
  });

  it('returns null for missing nested field', () => {
    expect(resolveScopePath(scope, 'outputs.foo.nope')).toBeNull();
  });

  it('returns null for path into unknown-typed field', () => {
    expect(resolveScopePath(scope, 'outputs.bare.anything')).toBeNull();
  });

  it('resolves loop.item.name and loop.index', () => {
    expect(resolveScopePath(scope, 'loop.item.name')).toEqual({ type: 'string' });
    expect(resolveScopePath(scope, 'loop.index')).toEqual({ type: 'number' });
  });

  it('returns null when path root is unknown', () => {
    expect(resolveScopePath(scope, 'nonsense.x')).toBeNull();
  });

  it('returns null for empty path', () => {
    expect(resolveScopePath(scope, '')).toBeNull();
  });
});

describe('inferFullScope', () => {
  it('merges post-conditional outputs from both branches', () => {
    const scope = inferFullScope(
      wf({
        steps: [
          {
            id: 'c',
            name: 'C',
            type: 'conditional',
            then: [
              { id: 't', name: 'T', type: 'agent_prompt', outputVariable: 'tv' },
            ],
            else: [
              { id: 'e', name: 'E', type: 'agent_prompt', outputVariable: 'ev' },
            ],
          },
        ],
      })
    );
    expect(scope.outputs.tv).toBeDefined();
    expect(scope.outputs.ev).toBeDefined();
  });

  it('merges post-parallel outputs from all branches', () => {
    const scope = inferFullScope(
      wf({
        steps: [
          {
            id: 'p',
            name: 'P',
            type: 'parallel',
            steps: [
              { id: 'a', name: 'A', type: 'agent_prompt', outputVariable: 'av' },
              { id: 'b', name: 'B', type: 'agent_prompt', outputVariable: 'bv' },
            ],
          },
          { id: 'tail', name: 'Tail', type: 'agent_prompt', outputVariable: 'tv' },
        ],
      })
    );
    expect(scope.outputs.av).toBeDefined();
    expect(scope.outputs.bv).toBeDefined();
    expect(scope.outputs.tv).toBeDefined();
  });

  it('includes workflow variables', () => {
    const scope = inferFullScope(
      wf({
        variables: { name: { type: 'string' } },
        steps: [],
      })
    );
    expect(scope.variables.name).toEqual({ type: 'string' });
  });
});
