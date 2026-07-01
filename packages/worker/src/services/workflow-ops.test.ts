import { describe, expect, it } from 'vitest';
import {
  createDefaultWorkflowNode,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@valet/shared';
import { applyOps, applyOpsLenient } from './workflow-ops.js';

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

  it('auto-lays out new nodes downstream of positioned upstream', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [createDefaultWorkflowNode('set', 'start')],
      edges: [],
      ui: { nodes: { start: { position: { x: 100, y: 0 } } } },
    };
    const out = applyOps(def, [
      { op: 'addNode', node: { id: 'a', type: 'set', values: {} } },
      { op: 'addEdge', edge: { from: 'start', to: 'a' } },
    ]);
    const posA = out.ui?.nodes?.a?.position;
    expect(posA).toEqual({ x: 100 + 340, y: 0 });
  });

  it('spreads sibling downstream nodes vertically', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        createDefaultWorkflowNode('set', 'start'),
        createDefaultWorkflowNode('set', 'existing'),
      ],
      edges: [{ from: 'start', to: 'existing' }],
      ui: {
        nodes: {
          start: { position: { x: 0, y: 0 } },
          existing: { position: { x: 340, y: 0 } },
        },
      },
    };
    const out = applyOps(def, [
      { op: 'addNode', node: { id: 'sibling', type: 'set', values: {} } },
      { op: 'addEdge', edge: { from: 'start', to: 'sibling' } },
    ]);
    const posSibling = out.ui?.nodes?.sibling?.position;
    // Same column as existing, next row down.
    expect(posSibling?.x).toBe(340);
    expect(posSibling?.y).toBeGreaterThanOrEqual(180);
  });

  it('cascades layout: node placed via its already-placed sibling', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [createDefaultWorkflowNode('set', 'start')],
      edges: [],
      ui: { nodes: { start: { position: { x: 0, y: 0 } } } },
    };
    // a → b → c chain, all new. Should place a, then b, then c across
    // multiple fixed-point passes.
    const out = applyOps(def, [
      { op: 'addNode', node: { id: 'a', type: 'set', values: {} } },
      { op: 'addNode', node: { id: 'b', type: 'set', values: {} } },
      { op: 'addNode', node: { id: 'c', type: 'set', values: {} } },
      { op: 'addEdge', edge: { from: 'start', to: 'a' } },
      { op: 'addEdge', edge: { from: 'a', to: 'b' } },
      { op: 'addEdge', edge: { from: 'b', to: 'c' } },
    ]);
    expect(out.ui?.nodes?.a?.position?.x).toBe(340);
    expect(out.ui?.nodes?.b?.position?.x).toBe(680);
    expect(out.ui?.nodes?.c?.position?.x).toBe(1020);
  });

  it('preserves existing positions on newly-added nodes when patch includes them', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [createDefaultWorkflowNode('set', 'start')],
      edges: [],
      ui: { nodes: { start: { position: { x: 0, y: 0 } } } },
    };
    // Manually placing a new node's ui.nodes entry via setMeta should
    // not get overwritten by auto-layout.
    const out = applyOps(def, [
      { op: 'addNode', node: { id: 'a', type: 'set', values: {} } },
      { op: 'setMeta', patch: { ui: { nodes: { a: { position: { x: 999, y: 999 } } } } } },
      { op: 'addEdge', edge: { from: 'start', to: 'a' } },
    ]);
    expect(out.ui?.nodes?.a?.position).toEqual({ x: 999, y: 999 });
  });

  it('setMeta deep-merges ui.nodes without wiping siblings', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        createDefaultWorkflowNode('set', 'start'),
        createDefaultWorkflowNode('set', 'existing'),
      ],
      edges: [],
      ui: {
        nodes: {
          start: { position: { x: 0, y: 0 } },
          existing: { position: { x: 340, y: 0 } },
        },
      },
    };
    const out = applyOps(def, [
      { op: 'setMeta', patch: { ui: { nodes: { start: { position: { x: 10, y: 20 } } } } } },
    ]);
    // `start` moved, `existing` untouched (would previously have been
    // wiped by the wholesale ui assignment).
    expect(out.ui?.nodes?.start?.position).toEqual({ x: 10, y: 20 });
    expect(out.ui?.nodes?.existing?.position).toEqual({ x: 340, y: 0 });
  });

  it('addNode rejects a top-level id that collides with a foreach body id', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        createDefaultWorkflowNode('set', 'start'),
        {
          id: 'loop',
          type: 'foreach',
          items: '{{ trigger.data.items }}',
          body: { id: 'step', type: 'set', values: {} },
        } as unknown as WorkflowDefinition['nodes'][number],
      ],
      edges: [],
    };
    expect(() =>
      applyOps(def, [{ op: 'addNode', node: { id: 'step', type: 'set', values: {} } }]),
    ).toThrow(/foreach body/);
  });

  it('addEdge from a non-if node rejects fromOutput', () => {
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        createDefaultWorkflowNode('set', 'a'),
        createDefaultWorkflowNode('set', 'b'),
      ],
      edges: [],
    };
    expect(() =>
      applyOps(def, [{ op: 'addEdge', edge: { from: 'a', to: 'b', fromOutput: 'true' } }]),
    ).toThrow(/fromOutput is only valid on edges leaving an "if" node/);
  });

  it('addEdge from an if node requires fromOutput', () => {
    // The default if node has empty conditions[] so a full validation
    // pass would fail — use applyOpsLenient to exercise the op-level
    // rejection in isolation.
    const def: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        createDefaultWorkflowNode('if', 'gate'),
        createDefaultWorkflowNode('set', 'b'),
      ],
      edges: [],
    };
    expect(() =>
      applyOpsLenient(def, [{ op: 'addEdge', edge: { from: 'gate', to: 'b' } }]),
    ).toThrow(/require fromOutput/);
    const out = applyOpsLenient(def, [
      { op: 'addEdge', edge: { from: 'gate', to: 'b', fromOutput: 'true' } },
    ]) as { edges: unknown[] };
    expect(out.edges).toHaveLength(1);
  });
});

function pickNode(def: WorkflowDefinition, id: string): WorkflowNode {
  const node = def.nodes.find((n) => n.id === id);
  if (!node) throw new Error(`node ${id} missing`);
  return node;
}
