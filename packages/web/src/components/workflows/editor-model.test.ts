import { describe, expect, it } from 'vitest';
import { validateWorkflowDefinition, type WorkflowDefinition } from '@valet/workflow';
import {
  ADDABLE_NODE_TYPES,
  LAYOUT_COLUMN_GAP,
  LAYOUT_ROW_GAP,
  NODE_META,
  addNode,
  autoLayout,
  connect,
  createEdgeId,
  createNodeId,
  duplicateNode,
  estimateEdgeLabelWidth,
  flowEdgeToWorkflowEdge,
  fromFlow,
  graphSignature,
  isWorkflowDefinitionShape,
  positionNewNodes,
  removeNode,
  setNodePosition,
  setViewport,
  toFlow,
  updateEdge,
  updateNode,
  workflowEdgeToFlowEdge,
} from './editor-model';

function baseDefinition(): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [
      { id: 'trigger', type: 'trigger' },
      { id: 'start', type: 'set', values: { ok: true } },
      {
        id: 'branch',
        type: 'if',
        // `left` is a bare expression, not a `{{…}}` template — the
        // runtime if-executor calls parseExpression on it directly.
        conditions: [{ left: 'nodes.start.result.ok', dataType: 'boolean', operation: 'equals', right: true }],
      },
      { id: 'done', type: 'stop', outcome: 'success', message: 'Finished' },
    ],
    edges: [
      { from: 'trigger', to: 'start' },
      { from: 'start', to: 'branch' },
      { from: 'branch', to: 'done', fromOutput: 'true' },
    ],
    ui: {
      nodes: {
        trigger: { position: { x: -260, y: 0 } },
        start: { position: { x: 0, y: 0 } },
        branch: { position: { x: 260, y: 0 } },
        done: { position: { x: 520, y: -120 } },
      },
      viewport: { x: 1, y: 2, zoom: 0.75 },
    },
  };
}

describe('createNodeId', () => {
  it('finds the first unused numeric suffix for a node type', () => {
    expect(createNodeId('llm', [])).toBe('llm-1');
    expect(createNodeId('llm', ['llm-1'])).toBe('llm-2');
    expect(createNodeId('llm', ['llm-1', 'llm-2', 'llm-4'])).toBe('llm-3');
  });
});

describe('NODE_META default nodes', () => {
  it('produces a defaultNode for every addable type plus trigger', () => {
    const types = Object.keys(NODE_META).sort();
    expect(types).toEqual(
      ['approval', 'foreach', 'if', 'llm', 'thread', 'session', 'set', 'stop', 'tool', 'trigger', 'wait', 'workflow'].sort(),
    );
  });

  it('trigger, set, wait, stop default nodes validate with zero errors', () => {
    const noErrorTypes = ['trigger', 'set', 'wait', 'stop'] as const;
    for (const type of noErrorTypes) {
      const node = type === 'trigger' ? NODE_META.trigger.defaultNode('trigger') : NODE_META[type].defaultNode('x');
      const definition: WorkflowDefinition = {
        version: 'dag/v1',
        nodes: type === 'trigger' ? [node] : [{ id: 'trigger', type: 'trigger' }, node],
        edges: type === 'trigger' ? [] : [{ from: 'trigger', to: 'x' }],
      };
      const result = validateWorkflowDefinition(definition);
      expect(result, `${type} should validate cleanly`).toEqual({ ok: true });
    }
  });

  it('if, approval, session default nodes each fail on exactly their one empty required field', () => {
    const cases = [
      { type: 'if', error: 'node "x": if.conditions must contain at least one condition' },
      { type: 'approval', error: 'node "x": approval.prompt must be a non-empty string (shown to the approver)' },
      { type: 'session', error: 'node "x": session.prompt must be a non-empty string' },
    ] as const;
    for (const { type, error } of cases) {
      const definition: WorkflowDefinition = {
        version: 'dag/v1',
        nodes: [{ id: 'trigger', type: 'trigger' }, NODE_META[type].defaultNode('x')],
        edges: [{ from: 'trigger', to: 'x' }],
      };
      expect(validateWorkflowDefinition(definition), type).toEqual({ ok: false, errors: [error] });
    }
  });

  it('llm default node fails validation on empty model and prompt only', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [{ id: 'trigger', type: 'trigger' }, NODE_META.llm.defaultNode('x')],
      edges: [{ from: 'trigger', to: 'x' }],
    };
    const result = validateWorkflowDefinition(definition);
    expect(result).toEqual({
      ok: false,
      errors: [
        'node "x": llm.model must be a non-empty string (e.g. "claude-haiku-4-5" or "anthropic/claude-haiku-4-5")',
        'node "x": llm.prompt must be a non-empty string',
      ],
    });
  });

  it('thread default node fails validation on empty prompt only', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [{ id: 'trigger', type: 'trigger' }, NODE_META.thread.defaultNode('x')],
      edges: [{ from: 'trigger', to: 'x' }],
    };
    expect(validateWorkflowDefinition(definition)).toEqual({
      ok: false,
      errors: ['node "x": thread.prompt must be a non-empty string'],
    });
  });

  it('tool default node fails validation on empty service and action only', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [{ id: 'trigger', type: 'trigger' }, NODE_META.tool.defaultNode('x')],
      edges: [{ from: 'trigger', to: 'x' }],
    };
    expect(validateWorkflowDefinition(definition)).toEqual({
      ok: false,
      errors: [
        'node "x": tool.service must be a non-empty string (the plugin service, e.g. "github")',
        'node "x": tool.action must be a non-empty string (the action name, e.g. "create_issue")',
      ],
    });
  });

  it('foreach default node fails validation on empty items only (body is a valid empty set node)', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [{ id: 'trigger', type: 'trigger' }, NODE_META.foreach.defaultNode('loop')],
      edges: [{ from: 'trigger', to: 'loop' }],
    };
    expect(validateWorkflowDefinition(definition)).toEqual({
      ok: false,
      errors: [
        'node "loop": foreach.items must be a non-empty template string resolving to an array (e.g. "{{nodes.fetch.result.runs}}")',
      ],
    });
  });
});

describe('toFlow / fromFlow round trip', () => {
  it('converts a dag/v1 definition to flow nodes and edges with saved positions and viewport', () => {
    const definition = baseDefinition();
    const flow = toFlow(definition);

    expect(flow.viewport).toEqual({ x: 1, y: 2, zoom: 0.75 });
    expect(flow.nodes.find((n) => n.id === 'trigger')).toMatchObject({
      id: 'trigger',
      type: 'workflow',
      position: { x: -260, y: 0 },
      deletable: false,
      data: { nodeType: 'trigger', label: 'Trigger' },
    });
    expect(flow.nodes.find((n) => n.id === 'branch')).toMatchObject({
      id: 'branch',
      position: { x: 260, y: 0 },
      data: { nodeType: 'if', label: 'If', sourceOutputs: ['true', 'false'] },
    });
    expect(flow.nodes.find((n) => n.id === 'start')!.data.sourceOutputs).toBeUndefined();
  });

  it('labels fromOutput edges leaving if/approval nodes with the source handle', () => {
    const flow = toFlow(baseDefinition());
    const branchEdge = flow.edges.find((e) => e.source === 'branch');
    expect(branchEdge).toMatchObject({
      id: 'branch:true->done',
      source: 'branch',
      sourceHandle: 'true',
      target: 'done',
      data: { fromOutput: 'true' },
    });
    const plainEdge = flow.edges.find((e) => e.source === 'trigger');
    expect(plainEdge).toMatchObject({ id: 'trigger->start', data: {} });
  });

  it('keeps a newly inserted node clear of saved positions on first load', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [{ id: 'trigger', type: 'trigger' }, { id: 'review', type: 'thread', prompt: 'Review' }, { id: 'stop', type: 'stop', outcome: 'success' }],
      edges: [{ from: 'trigger', to: 'review' }, { from: 'review', to: 'stop' }],
      ui: { nodes: { trigger: { position: { x: 0, y: 0 } }, stop: { position: { x: LAYOUT_COLUMN_GAP, y: 0 } } } },
    };
    const original = structuredClone(definition);
    const flow = toFlow(definition);
    expect(flow.nodes.find((node) => node.id === 'stop')?.position).toEqual({ x: LAYOUT_COLUMN_GAP, y: 0 });
    expect(flow.nodes.find((node) => node.id === 'review')?.position).toEqual({ x: 2 * LAYOUT_COLUMN_GAP, y: 0 });
    expect(definition).toEqual(original);
    expect(toFlow(definition)).toEqual(flow);
  });

  it('fills in auto-layout positions for nodes with no saved ui position', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'start', type: 'set', values: {} },
      ],
      edges: [{ from: 'trigger', to: 'start' }],
    };
    const flow = toFlow(definition);
    expect(flow.nodes.find((n) => n.id === 'trigger')!.position).toEqual({ x: 0, y: 0 });
    expect(flow.nodes.find((n) => n.id === 'start')!.position).toEqual({ x: LAYOUT_COLUMN_GAP, y: 0 });
  });

  it('round-trips flow state back to a dag/v1 definition preserving node payloads and ui', () => {
    const definition = baseDefinition();
    const flow = toFlow(definition);
    const roundTripped = fromFlow(flow);

    expect(roundTripped.version).toBe('dag/v1');
    expect(roundTripped.nodes).toEqual(definition.nodes);
    expect(new Set(roundTripped.edges)).toEqual(new Set(definition.edges));
    expect(roundTripped.ui?.viewport).toEqual(definition.ui?.viewport);
    for (const node of definition.nodes) {
      expect(roundTripped.ui?.nodes[node.id]?.position).toEqual(definition.ui?.nodes[node.id]?.position);
    }
  });

  it('workflowEdgeToFlowEdge / flowEdgeToWorkflowEdge are inverses', () => {
    const edge = { from: 'a', to: 'b', fromOutput: 'false' as const, when: '{{true}}' };
    expect(flowEdgeToWorkflowEdge(workflowEdgeToFlowEdge(edge))).toEqual(edge);
  });

  it('createEdgeId includes the fromOutput branch when present', () => {
    expect(createEdgeId('a', 'b')).toBe('a->b');
    expect(createEdgeId('a', 'b', 'true')).toBe('a:true->b');
  });
});

describe('connect', () => {
  it('appends a plain edge between two existing nodes', () => {
    const definition = baseDefinition();
    const result = connect(definition, { source: 'start', target: 'done' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.edges).toContainEqual({ from: 'start', to: 'done' });
  });

  it('infers fromOutput from the source handle for if/approval sources', () => {
    const definition = baseDefinition();
    const result = connect(definition, { source: 'branch', target: 'start', sourceHandle: 'false' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.definition.edges).toContainEqual({ from: 'branch', to: 'start', fromOutput: 'false' });
  });

  it('rejects a sourceHandle from a non if/approval node', () => {
    const definition = baseDefinition();
    const result = connect(definition, { source: 'start', target: 'done', sourceHandle: 'true' });
    expect(result).toEqual({
      ok: false,
      error: 'fromOutput handles are only valid on "if" or "approval" sources, not "set"',
    });
  });

  it('rejects self-edges', () => {
    const definition = baseDefinition();
    expect(connect(definition, { source: 'start', target: 'start' })).toEqual({
      ok: false,
      error: 'cannot connect a node to itself',
    });
  });

  it('rejects edges into the trigger node (single root)', () => {
    const definition = baseDefinition();
    expect(connect(definition, { source: 'start', target: 'trigger' })).toEqual({
      ok: false,
      error: 'the trigger node cannot have incoming edges',
    });
  });

  it('rejects unknown source/target ids', () => {
    const definition = baseDefinition();
    expect(connect(definition, { source: 'nope', target: 'start' })).toEqual({
      ok: false,
      error: 'unknown source node "nope"',
    });
    expect(connect(definition, { source: 'start', target: 'nope' })).toEqual({
      ok: false,
      error: 'unknown target node "nope"',
    });
  });

  it('is idempotent for an already-existing edge', () => {
    const definition = baseDefinition();
    const result = connect(definition, { source: 'trigger', target: 'start' });
    expect(result).toEqual({ ok: true, definition });
  });
});

describe('addNode / removeNode / duplicateNode / updateNode', () => {
  it('adds a node with a unique id and default payload from NODE_META', () => {
    const definition = baseDefinition();
    const { definition: next, nodeId } = addNode(definition, 'llm');
    expect(nodeId).toBe('llm-1');
    expect(next.nodes.find((n) => n.id === nodeId)).toEqual({ id: 'llm-1', type: 'llm', model: '', prompt: '' });
    expect(next.ui?.nodes[nodeId]).toBeDefined();
  });

  it('uses the persisted creation model for new llm and session nodes', () => {
    const definition: WorkflowDefinition = {
      ...baseDefinition(),
      ui: { ...baseDefinition().ui!, defaultModel: 's' },
    };
    const llm = addNode(definition, 'llm').definition.nodes.at(-1);
    const session = addNode(definition, 'session').definition.nodes.at(-1);
    expect(llm).toEqual({ id: 'llm-1', type: 'llm', model: 's', prompt: '' });
    expect(session).toEqual({ id: 'session-1', type: 'session', mode: 'start', model: 's', prompt: '' });
  });

  it('does not offer trigger as an addable type', () => {
    expect(ADDABLE_NODE_TYPES).not.toContain('trigger');
    expect(ADDABLE_NODE_TYPES).toHaveLength(11);
  });

  it('removes a node and cascades its edges, leaving the trigger untouched', () => {
    const definition = baseDefinition();
    const next = removeNode(definition, 'branch');
    expect(next.nodes.map((n) => n.id)).toEqual(['trigger', 'start', 'done']);
    expect(next.edges).toEqual([{ from: 'trigger', to: 'start' }]);
    expect(next.ui?.nodes.branch).toBeUndefined();
  });

  it('refuses to remove the trigger node', () => {
    const definition = baseDefinition();
    expect(removeNode(definition, 'trigger')).toBe(definition);
  });

  it('duplicates a node with a new unique id and offset position, but not its edges', () => {
    const definition = baseDefinition();
    const result = duplicateNode(definition, 'start');
    expect(result).not.toBeNull();
    if (!result) return;
    expect(result.nodeId).toBe('set-1');
    expect(result.definition.nodes.find((n) => n.id === 'set-1')).toEqual({ id: 'set-1', type: 'set', values: { ok: true } });
    expect(result.definition.edges).toEqual(definition.edges);
    expect(result.definition.ui?.nodes['set-1']?.position).toEqual({ x: 40, y: 40 });
  });

  it('refuses to duplicate the trigger node', () => {
    expect(duplicateNode(baseDefinition(), 'trigger')).toBeNull();
  });

  it('duplicating a foreach re-keys the nested body id (cross-foreach uniqueness)', () => {
    const base = baseDefinition();
    const added = addNode(base, 'foreach');
    const result = duplicateNode(added.definition, added.nodeId);
    expect(result).not.toBeNull();
    if (!result) return;
    const dup = result.definition.nodes.find((n) => n.id === result.nodeId);
    expect(dup?.type).toBe('foreach');
    if (dup?.type !== 'foreach') return;
    expect(dup.body.id).toBe(`${result.nodeId}-body`);
    // The whole point: no cross-foreach body-id collision. Acceptable
    // complaints are the default factory's empty `items` (both copies) and
    // the duplicate being unreachable (duplicateNode copies no edges).
    const validation = validateWorkflowDefinition(result.definition);
    expect(validation.ok).toBe(false);
    if (validation.ok) return;
    expect(validation.errors.some((e) => e.includes('body id'))).toBe(false);
    expect(
      validation.errors.every(
        (e) => e.includes('foreach.items must be a non-empty template string') || e.includes('is unreachable'),
      ),
    ).toBe(true);
  });

  it('updates fields on an existing node while pinning id and type', () => {
    const definition = baseDefinition();
    const next = updateNode(definition, 'start', { values: { ok: false }, id: 'ignored', type: 'llm' });
    expect(next.nodes.find((n) => n.id === 'start')).toEqual({ id: 'start', type: 'set', values: { ok: false } });
  });
});

describe('updateEdge', () => {
  it('patches when/fromOutput on the matching edge only', () => {
    const definition = baseDefinition();
    const next = updateEdge(definition, { from: 'branch', to: 'done', fromOutput: 'true' }, { when: '{{x}}' });
    expect(next.edges.find((e) => e.from === 'branch' && e.to === 'done')).toEqual({
      from: 'branch',
      to: 'done',
      fromOutput: 'true',
      when: '{{x}}',
    });
    expect(next.edges.find((e) => e.from === 'trigger')).toEqual({ from: 'trigger', to: 'start' });
  });

  it('clears fromOutput when patched to undefined explicitly', () => {
    const definition = baseDefinition();
    const next = updateEdge(definition, { from: 'branch', to: 'done', fromOutput: 'true' }, { fromOutput: undefined });
    expect(next.edges.find((e) => e.from === 'branch' && e.to === 'done')).toEqual({ from: 'branch', to: 'done' });
  });
});

describe('position and viewport persistence', () => {
  it('writes a node position into definition.ui.nodes', () => {
    const definition = baseDefinition();
    const next = setNodePosition(definition, 'start', { x: 99, y: 5 });
    expect(next.ui?.nodes.start.position).toEqual({ x: 99, y: 5 });
    expect(next.ui?.nodes.branch.position).toEqual(definition.ui?.nodes.branch.position);
  });

  it('is a no-op for an unknown node id', () => {
    const definition = baseDefinition();
    expect(setNodePosition(definition, 'nope', { x: 1, y: 1 })).toBe(definition);
  });

  it('writes the viewport into definition.ui.viewport', () => {
    const definition = baseDefinition();
    const next = setViewport(definition, { x: 5, y: 6, zoom: 2 });
    expect(next.ui?.viewport).toEqual({ x: 5, y: 6, zoom: 2 });
    expect(next.ui?.nodes).toEqual(definition.ui?.nodes);
  });

  // A pan or a zoom writes the camera through this helper on every gesture,
  // and the editor re-applies the stored camera when it adopts a refetch. A
  // rebuilt `ui` would drop the editor default the server just wrote, and
  // the next save would persist the loss.
  it('keeps the rest of definition.ui when it writes the viewport', () => {
    const definition = baseDefinition();
    const withDefault: WorkflowDefinition = {
      ...definition,
      ui: { ...definition.ui, nodes: definition.ui?.nodes ?? {}, defaultModel: 'm' },
    };
    const next = setViewport(withDefault, { x: 5, y: 6, zoom: 2 });
    expect(next.ui?.defaultModel).toBe('m');
    expect(next.ui?.viewport).toEqual({ x: 5, y: 6, zoom: 2 });
    expect(next.ui?.nodes).toEqual(definition.ui?.nodes);
  });
});

describe('autoLayout (BFS depth layering)', () => {
  it('lays out a linear chain by depth, one column per hop', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'a', type: 'set', values: {} },
        { id: 'b', type: 'set', values: {} },
      ],
      edges: [
        { from: 'trigger', to: 'a' },
        { from: 'a', to: 'b' },
      ],
    };
    expect(autoLayout(definition)).toEqual({
      trigger: { x: 0, y: 0 },
      a: { x: LAYOUT_COLUMN_GAP, y: 0 },
      b: { x: LAYOUT_COLUMN_GAP * 2, y: 0 },
    });
  });

  it('stacks parallel branches within the same depth by row', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'branch', type: 'if', conditions: [] },
        { id: 'a', type: 'stop', outcome: 'success' },
        { id: 'b', type: 'stop', outcome: 'failure' },
      ],
      edges: [
        { from: 'trigger', to: 'branch' },
        { from: 'branch', to: 'a', fromOutput: 'true' },
        { from: 'branch', to: 'b', fromOutput: 'false' },
      ],
    };
    expect(autoLayout(definition)).toEqual({
      trigger: { x: 0, y: 0 },
      branch: { x: LAYOUT_COLUMN_GAP, y: 0 },
      a: { x: LAYOUT_COLUMN_GAP * 2, y: 0 },
      b: { x: LAYOUT_COLUMN_GAP * 2, y: LAYOUT_ROW_GAP },
    });
  });

  it('places disconnected nodes deterministically instead of colliding at the origin', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'a', type: 'set', values: {} },
        { id: 'orphan', type: 'set', values: {} },
      ],
      edges: [{ from: 'trigger', to: 'a' }],
    };
    const positions = autoLayout(definition);
    expect(positions.trigger).toEqual({ x: 0, y: 0 });
    expect(positions.orphan).toEqual({ x: 0, y: LAYOUT_ROW_GAP });
    expect(positions.orphan).not.toEqual(positions.a);
  });

  it('is deterministic: the same definition always produces the same positions', () => {
    const definition = baseDefinition();
    const first = autoLayout(definition);
    const second = autoLayout(structuredClone(definition));
    expect(first).toEqual(second);
  });

  it('widens a column boundary so a when-labeled edge has room for its badge', () => {
    const when = '!nodes.confirm_assignment.result.approved';
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'a', type: 'set', values: {} },
        { id: 'b', type: 'set', values: {} },
      ],
      edges: [
        { from: 'trigger', to: 'a', when },
        { from: 'a', to: 'b' },
      ],
    };
    const positions = autoLayout(definition);
    // The labeled boundary must leave at least the estimated badge width
    // of free space between the node borders (nodes render up to 240 wide).
    const free = positions.a!.x - positions.trigger!.x - 240;
    expect(free).toBeGreaterThanOrEqual(estimateEdgeLabelWidth(when));
    // The unlabeled boundary keeps the base pitch.
    expect(positions.b!.x - positions.a!.x).toBe(LAYOUT_COLUMN_GAP);
  });

  it('splits a multi-column label across the boundaries it spans', () => {
    const when = 'nodes.check.result.ok && nodes.other.result.ok';
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'a', type: 'set', values: {} },
        { id: 'b', type: 'set', values: {} },
      ],
      edges: [
        { from: 'trigger', to: 'a' },
        { from: 'a', to: 'b' },
        // Skip-level edge: trigger (depth 0) → b (depth 2).
        { from: 'trigger', to: 'b', when },
      ],
    };
    const positions = autoLayout(definition);
    // Combined free space across the span fits the badge estimate.
    const free = positions.b!.x - positions.trigger!.x - 2 * 240;
    expect(free).toBeGreaterThanOrEqual(estimateEdgeLabelWidth(when) - 240);
    // Both boundaries widen by the same amount — the split is even.
    expect(positions.a!.x - positions.trigger!.x).toBe(positions.b!.x - positions.a!.x);
  });

  it('returns an empty layout for a zero-node definition', () => {
    expect(autoLayout({ version: 'dag/v1', nodes: [], edges: [] })).toEqual({});
  });

  it('caps how far a single pathological label can stretch a column', () => {
    const definition: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'a', type: 'set', values: {} },
      ],
      edges: [{ from: 'trigger', to: 'a', when: 'x'.repeat(500) }],
    };
    const positions = autoLayout(definition);
    expect(positions.a!.x - positions.trigger!.x).toBeLessThanOrEqual(240 + 420 + LAYOUT_COLUMN_GAP);
  });

});

describe('isWorkflowDefinitionShape', () => {
  it('accepts a value with version/nodes/edges', () => {
    expect(isWorkflowDefinitionShape({ version: 'dag/v1', nodes: [], edges: [] })).toBe(true);
  });

  it('rejects non-objects, nulls, and missing fields', () => {
    expect(isWorkflowDefinitionShape(null)).toBe(false);
    expect(isWorkflowDefinitionShape('dag/v1')).toBe(false);
    expect(isWorkflowDefinitionShape({ version: 'dag/v1', nodes: [] })).toBe(false);
    expect(isWorkflowDefinitionShape({ nodes: [], edges: [] })).toBe(false);
  });
});

describe('graphSignature', () => {
  function definition(node: WorkflowDefinition['nodes'][number]): WorkflowDefinition {
    return {
      version: 'dag/v1',
      nodes: [{ id: 'trigger', type: 'trigger' }, node],
      edges: [{ from: 'trigger', to: 'draft' }],
    };
  }

  it('ignores key order, which a jsonb round trip does not preserve', () => {
    // Same node, written by the editor and read back from the database.
    const written = definition({ id: 'draft', type: 'llm', system: 'be terse', prompt: 'hi', model: 'claude-haiku' });
    const readBack = definition({ id: 'draft', type: 'llm', model: 'claude-haiku', prompt: 'hi', system: 'be terse' });
    expect(graphSignature(written)).toBe(graphSignature(readBack));
  });

  it('ignores the camera and the hand-placed positions', () => {
    const base = definition({ id: 'draft', type: 'llm', model: 'claude-haiku', prompt: 'hi' });
    const dragged: WorkflowDefinition = {
      ...base,
      ui: { nodes: { draft: { position: { x: 900, y: 40 } } }, viewport: { x: 12, y: 12, zoom: 2 } },
    };
    expect(graphSignature(dragged)).toBe(graphSignature(base));
  });

  it('sees a step the assistant added', () => {
    const base = definition({ id: 'draft', type: 'llm', model: 'claude-haiku', prompt: 'hi' });
    const patched: WorkflowDefinition = {
      ...base,
      nodes: [...base.nodes, { id: 'hold', type: 'wait', mode: 'duration', duration: '5s' }],
    };
    expect(graphSignature(patched)).not.toBe(graphSignature(base));
  });

  it('sees a changed field, not only a changed node count', () => {
    const before = definition({ id: 'draft', type: 'llm', model: 'claude-haiku', prompt: 'hi' });
    const after = definition({ id: 'draft', type: 'llm', model: 'claude-haiku', prompt: 'hi again' });
    expect(graphSignature(after)).not.toBe(graphSignature(before));
  });
});

describe('positionNewNodes', () => {
  function placed(): WorkflowDefinition {
    return {
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'draft', type: 'llm', model: 'claude-haiku', prompt: 'hi' },
      ],
      edges: [{ from: 'trigger', to: 'draft' }],
      ui: {
        nodes: {
          trigger: { position: { x: 40, y: 300 } },
          draft: { position: { x: 900, y: 300 } },
        },
      },
    };
  }

  it('leaves a fully placed definition untouched, so adopting one mints no version', () => {
    const definition = placed();
    expect(positionNewNodes(definition)).toBe(definition);
  });

  it('places a node the assistant added clear of the hand-placed ones', () => {
    const patched: WorkflowDefinition = {
      ...placed(),
      nodes: [...placed().nodes, { id: 'notify', type: 'wait', mode: 'duration', duration: '5s' }],
    };
    const result = positionNewNodes(patched);
    const positions = result.ui?.nodes ?? {};
    expect(positions.notify?.position).toEqual({ x: 900 + LAYOUT_COLUMN_GAP, y: 0 });
    // The hand-placed ones keep their coordinates.
    expect(positions.draft?.position).toEqual({ x: 900, y: 300 });
  });

  it('stacks several added nodes instead of piling them on one point', () => {
    const patched: WorkflowDefinition = {
      ...placed(),
      nodes: [
        ...placed().nodes,
        { id: 'one', type: 'wait', mode: 'duration', duration: '1s' },
        { id: 'two', type: 'wait', mode: 'duration', duration: '2s' },
      ],
    };
    const positions = positionNewNodes(patched).ui?.nodes ?? {};
    expect(positions.one?.position).not.toEqual(positions.two?.position);
    expect(positions.two?.position.y).toBe(LAYOUT_ROW_GAP);
  });

  it('leaves a definition with no saved positions to auto-layout', () => {
    // The shape of every workflow the agent wrote or a template installed.
    // Placing these here would put the whole graph in one column at x=0 and
    // throw away the depth layering `toFlow`/`autoLayout` gives it.
    const fresh: WorkflowDefinition = {
      version: 'dag/v1',
      nodes: [
        { id: 'trigger', type: 'trigger' },
        { id: 'draft', type: 'llm', model: 'claude-haiku', prompt: 'hi' },
        { id: 'done', type: 'stop', outcome: 'success' },
      ],
      edges: [
        { from: 'trigger', to: 'draft' },
        { from: 'draft', to: 'done' },
      ],
    };
    expect(positionNewNodes(fresh)).toBe(fresh);
    // Auto-layout puts them in three columns, which is what the canvas keeps.
    const layout = autoLayout(fresh);
    expect(layout.draft?.x).toBe(LAYOUT_COLUMN_GAP);
    expect(layout.done?.x).toBe(LAYOUT_COLUMN_GAP * 2);
  });
});

it('does not propagate obsolete assistant routing through canvas saves', () => {
  const definition = { ...baseDefinition(), assistantId: 'chosen' };
  expect(fromFlow(toFlow(definition), definition)).not.toHaveProperty('assistantId');
});
