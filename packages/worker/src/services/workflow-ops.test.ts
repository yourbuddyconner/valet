import { describe, expect, it } from 'vitest';
import type { WorkflowDefinition } from '@valet/shared';
import { applyOps } from './workflow-ops.js';

function blankDef(): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [{ id: 'start', type: 'set', values: {} } as unknown as WorkflowDefinition['nodes'][number]],
    edges: [],
  };
}

describe('applyOps', () => {
  it('addNode appends and rejects dup ids', () => {
    const out = applyOps(blankDef(), [
      { op: 'addNode', node: { id: 'a', type: 'set', values: { hello: 'world' } } },
    ]);
    expect(out.nodes).toHaveLength(2);
    expect(out.nodes[1].id).toBe('a');

    expect(() =>
      applyOps(out, [{ op: 'addNode', node: { id: 'a', type: 'set', values: {} } }]),
    ).toThrow(/already exists/);
  });

  it('updateNode deep-merges and refuses id changes', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'a', type: 'tool_policy', service: 'workflows', action: 'list', params: { limit: 5 } } as unknown as WorkflowDefinition['nodes'][number],
      ],
      edges: [],
    };
    const out = applyOps(def, [
      { op: 'updateNode', id: 'a', patch: { params: { limit: 25, query: 'trigger' } } },
    ]);
    expect((out.nodes[0] as unknown as Record<string, unknown>).params).toEqual({ limit: 25, query: 'trigger' });

    expect(() =>
      applyOps(def, [{ op: 'updateNode', id: 'a', patch: { id: 'b' } }]),
    ).toThrow(/cannot change a node id/);
  });

  it('removeNode cascades edges', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'a', type: 'set' } as unknown as WorkflowDefinition['nodes'][number],
        { id: 'b', type: 'set' } as unknown as WorkflowDefinition['nodes'][number],
      ],
      edges: [{ from: 'a', to: 'b' }],
    };
    const out = applyOps(def, [{ op: 'removeNode', id: 'a' }]);
    expect(out.nodes.map((n) => n.id)).toEqual(['b']);
    expect(out.edges).toHaveLength(0);
  });

  it('addEdge validates endpoint existence and rejects dups', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'a', type: 'set' } as unknown as WorkflowDefinition['nodes'][number],
        { id: 'b', type: 'set' } as unknown as WorkflowDefinition['nodes'][number],
      ],
      edges: [],
    };
    expect(() =>
      applyOps(def, [{ op: 'addEdge', edge: { from: 'a', to: 'missing' } }]),
    ).toThrow(/does not exist/);

    const out = applyOps(def, [{ op: 'addEdge', edge: { from: 'a', to: 'b' } }]);
    expect(() =>
      applyOps(out, [{ op: 'addEdge', edge: { from: 'a', to: 'b' } }]),
    ).toThrow(/already exists/);
  });

  it('atomic rollback: failed op leaves input untouched', () => {
    const def = blankDef();
    const before = JSON.stringify(def);
    expect(() =>
      applyOps(def, [
        { op: 'addNode', node: { id: 'a', type: 'set' } },
        { op: 'addNode', node: { id: 'a', type: 'set' } }, // dup → throws
      ]),
    ).toThrow(/op #1.*already exists/);
    // applyOps clones internally, so caller's input is untouched
    expect(JSON.stringify(def)).toBe(before);
  });

  it('setMeta refuses to mutate graph fields', () => {
    expect(() =>
      applyOps(blankDef(), [{ op: 'setMeta', patch: { nodes: [] } }]),
    ).toThrow(/cannot modify "nodes"/);
  });
});
