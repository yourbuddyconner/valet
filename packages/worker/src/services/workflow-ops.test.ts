import { describe, expect, it } from 'vitest';
import {
  createDefaultWorkflowNode,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@valet/shared';
import { applyOps } from './workflow-ops.js';

/**
 * Build a fresh definition pre-populated with a `set` node so we don't
 * have to fight the discriminated union in the fixtures. Tests below
 * either use this helper or pass inline plain objects to addNode —
 * which is what the copilot will be doing in practice.
 */
function blankDef(): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [createDefaultWorkflowNode('set', 'start')],
    edges: [],
  };
}

describe('applyOps', () => {
  it('addNode appends and rejects dup ids', () => {
    const out = applyOps(blankDef(), [
      { op: 'addNode', node: { id: 'a', type: 'set', values: {} } },
    ]);
    expect(out.nodes).toHaveLength(2);
    expect(out.nodes[1].id).toBe('a');

    expect(() =>
      applyOps(out, [{ op: 'addNode', node: { id: 'a', type: 'set', values: {} } }]),
    ).toThrow(/already exists/);
  });

  it('updateNode deep-merges and refuses id changes', () => {
    const tool = createDefaultWorkflowNode('tool', 'a');
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [{ ...tool, service: 'workflows', action: 'list', params: { limit: 5 } }],
      edges: [],
    };
    const out = applyOps(def, [
      { op: 'updateNode', id: 'a', patch: { params: { limit: 25, query: 'trigger' } } },
    ]);
    const updated = pickNode(out, 'a');
    if (updated.type !== 'tool') throw new Error('expected tool node');
    expect(updated.params).toEqual({ limit: 25, query: 'trigger' });

    expect(() =>
      applyOps(def, [{ op: 'updateNode', id: 'a', patch: { id: 'b' } }]),
    ).toThrow(/cannot change a node id/);
  });

  it('removeNode cascades edges', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        createDefaultWorkflowNode('set', 'a'),
        createDefaultWorkflowNode('set', 'b'),
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
        createDefaultWorkflowNode('set', 'a'),
        createDefaultWorkflowNode('set', 'b'),
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
        { op: 'addNode', node: { id: 'a', type: 'set', values: {} } },
        { op: 'addNode', node: { id: 'a', type: 'set', values: {} } }, // dup → throws
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

function pickNode(def: WorkflowDefinition, id: string): WorkflowNode {
  const node = def.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`node ${id} missing`);
  return node;
}
