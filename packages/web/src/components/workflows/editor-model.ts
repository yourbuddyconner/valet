/**
 * Pure editor model for the visual workflow editor.
 *
 * Lifted from main's `packages/client/src/components/workflows/workflow-editor-model.ts`
 * (1503 lines) and trimmed hard per the node-completion-plan decision 9:
 *
 *   KEPT: definition<->flow conversion (with fromOutput-labeled source
 *   handles on if/approval sources), add/remove/duplicate/update node,
 *   connect rules (single trigger root, no self-edges, fromOutput only
 *   from if/approval), position persistence into `definition.ui`, viewport
 *   persistence, dirty tracking, unique id generation, BFS-depth layered
 *   auto-layout.
 *
 *   DROPPED (out of scope for the v2 node set / this task): NODE_DOCS
 *   (replaced by a small local `NODE_META` table — v2 has no docs
 *   package), the tool-catalog/data-flow-source machinery
 *   (`deriveWorkflowOutputSources`, `buildWorkflowEdgeInspection`,
 *   `applyDefaultDataFlowForConnection`, JSON-schema<->input-definition
 *   conversion, the node palette filter/search helpers) — none of that is
 *   part of decision 9's deliverable list, and main's edge/node CSS
 *   styling (colors, stroke widths, edge `type`) which belongs to the
 *   presentation layer (Tasks 9-10), not the pure model. Legacy node
 *   types and `session.workspace`/prompt-mode are gone because the v2
 *   `SessionNode` (see `@valet/workflow`'s `dag/nodes.ts`) trims to
 *   start-mode only.
 *
 * This module has no React dependency — Tasks 9-10 build the xyflow
 * presentation on top of it.
 */

import {
  validateWorkflowDefinition,
  type ApprovalNode,
  type DagNodeType,
  type ForeachNode,
  type IfNode,
  type LlmNode,
  type ThreadNode,
  type SessionNode,
  type SetNode,
  type StopNode,
  type ToolNode,
  type TriggerNode,
  type WaitNode,
  type WorkflowCallNode,
  type WorkflowDefinition,
  type WorkflowEditorState,
  type WorkflowEdge,
  type WorkflowNode,
} from '@valet/workflow';

export { validateWorkflowDefinition };
export type { WorkflowDefinition, WorkflowNode, WorkflowEdge, DagNodeType };

/**
 * Structural narrowing from the wire's `unknown` definition (both
 * `WorkflowDefinitionSummary.definition` and the editor's JSON-mode
 * "Apply" step) to `WorkflowDefinition`, without an `as` cast. Anything
 * failing this check stays a load/parse error, never a silent bad save —
 * shared by `editor.tsx`'s JSON toggle and `workflows.$workflowId.tsx`'s
 * initial-load guard. Lives here (the pure, React-free model module)
 * rather than a standalone form-helpers file since both consumers already
 * import from `editor-model`.
 */
export function isWorkflowDefinitionShape(value: unknown): value is WorkflowDefinition {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.version === 'string' &&
    Array.isArray(candidate.nodes) &&
    Array.isArray(candidate.edges)
  );
}

// ─── Flow types (xyflow-shaped, but xyflow-independent) ──────────────────────

export interface FlowPosition {
  x: number;
  y: number;
}

export interface FlowViewport {
  x: number;
  y: number;
  zoom: number;
}

export interface WorkflowFlowNodeData {
  [key: string]: unknown;
  node: WorkflowNode;
  nodeType: DagNodeType;
  label: string;
  description: string;
  summary: string;
  sourceOutputs?: Array<'true' | 'false'>;
}

export interface WorkflowFlowNode {
  id: string;
  type: 'workflow';
  position: FlowPosition;
  deletable?: boolean;
  data: WorkflowFlowNodeData;
}

export interface WorkflowFlowEdge {
  id: string;
  source: string;
  sourceHandle?: 'true' | 'false';
  target: string;
  data: {
    fromOutput?: 'true' | 'false';
    when?: string;
  };
}

export interface WorkflowFlowState {
  nodes: WorkflowFlowNode[];
  edges: WorkflowFlowEdge[];
  viewport?: FlowViewport;
}

// ─── Node metadata (replaces main's NODE_DOCS for the v2 node set) ───────────

export type AddableDagNodeType = Exclude<DagNodeType, 'trigger'>;

export interface NodeMeta {
  label: string;
  description: string;
  defaultNode: (id: string) => WorkflowNode;
}

export const NODE_META: Record<DagNodeType, NodeMeta> = {
  trigger: {
    label: 'Trigger',
    description: 'Where the workflow starts and what data it receives',
    defaultNode: (id): TriggerNode => ({ id, type: 'trigger' }),
  },
  set: {
    label: 'Set values',
    description: 'Create values for downstream nodes',
    defaultNode: (id): SetNode => ({ id, type: 'set', values: {} }),
  },
  if: {
    label: 'If',
    description: 'Branch based on conditions',
    defaultNode: (id): IfNode => ({ id, type: 'if', conditions: [] }),
  },
  wait: {
    label: 'Wait',
    description: 'Pause for a fixed duration',
    defaultNode: (id): WaitNode => ({ id, type: 'wait', mode: 'duration', duration: '5m' }),
  },
  approval: {
    label: 'Approval',
    description: 'Pause for human approval',
    defaultNode: (id): ApprovalNode => ({ id, type: 'approval', prompt: '' }),
  },
  session: {
    label: 'Runtime',
    description: 'Start a coding runtime',
    defaultNode: (id): SessionNode => ({ id, type: 'session', mode: 'start', prompt: '' }),
  },
  stop: {
    label: 'Stop',
    description: 'Finish the workflow',
    defaultNode: (id): StopNode => ({ id, type: 'stop', outcome: 'success' }),
  },
  foreach: {
    label: 'For each',
    description: 'Run one body node for every item',
    defaultNode: (id): ForeachNode => ({
      id,
      type: 'foreach',
      items: '',
      body: { id: `${id}-body`, type: 'set', values: {} },
    }),
  },
  llm: {
    label: 'LLM',
    description: 'Generate or transform text with a model',
    defaultNode: (id): LlmNode => ({ id, type: 'llm', model: '', prompt: '' }),
  },
  thread: {
    label: 'Thread',
    description: 'Ask the workspace assistant to work in this workflow’s thread',
    defaultNode: (id): ThreadNode => ({ id, type: 'thread', prompt: '' }),
  },
  tool: {
    label: 'Tool',
    description: 'Call an integration action',
    defaultNode: (id): ToolNode => ({ id, type: 'tool', service: '', action: '', params: {} }),
  },
  workflow: {
    label: 'Workflow',
    description: 'Run another workflow and wait for its result',
    defaultNode: (id): WorkflowCallNode => ({ id, type: 'workflow', workflowId: '' }),
  },
};

export const ADDABLE_NODE_TYPES: AddableDagNodeType[] = [
  'llm',
  'tool',
  'if',
  'foreach',
  'approval',
  'wait',
  'set',
  'thread',
  'session',
  'workflow',
  'stop',
];

// ─── id generation ────────────────────────────────────────────────────────────

export function createNodeId(type: DagNodeType, existingIds: Iterable<string>): string {
  const taken = new Set(existingIds);
  let index = 1;
  let candidate = `${type}-${index}`;
  while (taken.has(candidate)) {
    index += 1;
    candidate = `${type}-${index}`;
  }
  return candidate;
}

// ─── definition <-> flow conversion ───────────────────────────────────────────

export function toFlow(definition: WorkflowDefinition): WorkflowFlowState {
  // Initial loads and previews need the same reconciliation as live patches.
  const savedPositions = positionNewNodes(definition).ui?.nodes;
  const fallbackPositions = autoLayout(definition);

  return {
    nodes: definition.nodes.map((node) => ({
      id: node.id,
      type: 'workflow',
      position: savedPositions?.[node.id]?.position ?? fallbackPositions[node.id] ?? { x: 0, y: 0 },
      ...(node.type === 'trigger' ? { deletable: false } : {}),
      data: createFlowNodeData(node),
    })),
    edges: definition.edges.map(workflowEdgeToFlowEdge),
    viewport: definition.ui?.viewport,
  };
}

export function fromFlow(
  flow: WorkflowFlowState,
  previous?: Pick<WorkflowDefinition, 'policy' | 'ui'>,
): WorkflowDefinition {
  const ui: WorkflowEditorState = {
    nodes: Object.fromEntries(flow.nodes.map((node) => [node.id, { position: node.position }])),
    ...(flow.viewport ? { viewport: flow.viewport } : {}),
    ...(previous?.ui?.defaultModel ? { defaultModel: previous.ui.defaultModel } : {}),
  };

  return {
    version: 'dag/v1',
    nodes: flow.nodes.map((node) => node.data.node),
    edges: flow.edges.map(flowEdgeToWorkflowEdge),
    ...(previous?.policy ? { policy: previous.policy } : {}),
    ui,
  };
}

function createFlowNodeData(node: WorkflowNode): WorkflowFlowNodeData {
  return {
    node,
    nodeType: node.type,
    label: NODE_META[node.type].label,
    description: NODE_META[node.type].description,
    summary: summarizeNode(node),
    ...(node.type === 'if' || node.type === 'approval'
      ? { sourceOutputs: ['true', 'false'] as Array<'true' | 'false'> }
      : {}),
  };
}

export function createEdgeId(from: string, to: string, fromOutput?: 'true' | 'false'): string {
  return `${from}${fromOutput ? `:${fromOutput}` : ''}->${to}`;
}

/**
 * The graph alone, as a string two definitions can be compared by.
 *
 * The editor uses it to tell an edit made somewhere else — the assistant
 * panel patches the stored workflow directly — from its own re-renders.
 * Two of those re-renders would otherwise read as a change. `ui` moves on
 * every frame of a pan or a node drag, so it is left out. And a definition
 * that has been through the `jsonb` column comes back with its keys in the
 * database's order rather than the order this client wrote them in, so key
 * order is removed as well: without that, a plain Save followed by more
 * typing raises the "somebody changed this workflow" bar with nobody on the
 * other end.
 */
export function graphSignature(definition: WorkflowDefinition): string {
  return stableJson({
    nodes: definition.nodes,
    edges: definition.edges,
    policy: definition.policy ?? null,
  });
}

/** `JSON.stringify` with object keys in sorted order. Array order is kept:
 * in a DAG the node and edge order is content, not formatting. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    const items: unknown[] = value;
    return `[${items.map(stableJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    // The same narrowing the shape guards below use: `typeof` proves the
    // object-ness, and the cast only names the index signature.
    const fields = Object.entries(value as Record<string, unknown>)
      .filter(([, field]) => field !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, field]) => `${JSON.stringify(key)}:${stableJson(field)}`);
    return `{${fields.join(',')}}`;
  }
  // `JSON.stringify` answers undefined for a bare undefined, which cannot
  // appear inside an object here but can be passed in directly.
  return JSON.stringify(value) ?? 'null';
}

export function workflowEdgeToFlowEdge(edge: WorkflowEdge): WorkflowFlowEdge {
  return {
    id: createEdgeId(edge.from, edge.to, edge.fromOutput),
    source: edge.from,
    ...(edge.fromOutput ? { sourceHandle: edge.fromOutput } : {}),
    target: edge.to,
    data: {
      ...(edge.fromOutput ? { fromOutput: edge.fromOutput } : {}),
      ...(edge.when ? { when: edge.when } : {}),
    },
  };
}

export function flowEdgeToWorkflowEdge(edge: WorkflowFlowEdge): WorkflowEdge {
  const fromOutput = edge.data.fromOutput ?? edge.sourceHandle;
  return {
    from: edge.source,
    to: edge.target,
    ...(fromOutput ? { fromOutput } : {}),
    ...(edge.data.when ? { when: edge.data.when } : {}),
  };
}

// ─── connect ──────────────────────────────────────────────────────────────────

export interface ConnectParams {
  source: string;
  target: string;
  sourceHandle?: 'true' | 'false';
}

export type ConnectResult =
  | { ok: true; definition: WorkflowDefinition }
  | { ok: false; error: string };

/**
 * Applies the connect rules: source/target must exist, no self-edges, the
 * trigger node (single root) cannot have incoming edges, and `fromOutput`
 * (true/false source handles) is only valid leaving an `if` or `approval`
 * node — mirrors `validateWorkflowDefinition`'s edge checks in
 * `@valet/workflow` so a connection the editor allows never fails
 * validation for these reasons.
 */
export function connect(definition: WorkflowDefinition, params: ConnectParams): ConnectResult {
  const { source, target, sourceHandle } = params;
  const sourceNode = definition.nodes.find((node) => node.id === source);
  const targetNode = definition.nodes.find((node) => node.id === target);

  if (!sourceNode) return { ok: false, error: `unknown source node "${source}"` };
  if (!targetNode) return { ok: false, error: `unknown target node "${target}"` };
  if (source === target) return { ok: false, error: 'cannot connect a node to itself' };
  if (targetNode.type === 'trigger') {
    return { ok: false, error: 'the trigger node cannot have incoming edges' };
  }
  if (sourceHandle !== undefined && sourceNode.type !== 'if' && sourceNode.type !== 'approval') {
    return {
      ok: false,
      error: `fromOutput handles are only valid on "if" or "approval" sources, not "${sourceNode.type}"`,
    };
  }

  const alreadyExists = definition.edges.some(
    (edge) => edge.from === source && edge.to === target && edge.fromOutput === sourceHandle,
  );
  if (alreadyExists) return { ok: true, definition };

  const edge: WorkflowEdge = { from: source, to: target, ...(sourceHandle ? { fromOutput: sourceHandle } : {}) };
  return { ok: true, definition: { ...definition, edges: [...definition.edges, edge] } };
}

// ─── add / remove / duplicate / update node ──────────────────────────────────

export interface AddNodeResult {
  definition: WorkflowDefinition;
  nodeId: string;
}

export function addNode(
  definition: WorkflowDefinition,
  type: AddableDagNodeType,
  options: { position?: FlowPosition } = {},
): AddNodeResult {
  const id = createNodeId(type, definition.nodes.map((node) => node.id));
  const defaultNode = NODE_META[type].defaultNode(id);
  const node =
    definition.ui?.defaultModel && (defaultNode.type === 'llm' || defaultNode.type === 'session')
      ? { ...defaultNode, model: definition.ui.defaultModel }
      : defaultNode;
  const position = options.position ?? nextFreePosition(definition);

  return {
    nodeId: id,
    definition: {
      ...definition,
      nodes: [...definition.nodes, node],
      ui: {
        ...definition.ui,
        nodes: { ...(definition.ui?.nodes ?? {}), [id]: { position } },
      },
    },
  };
}

function nextFreePosition(definition: WorkflowDefinition): FlowPosition {
  const positions = definition.ui?.nodes;
  const xs = positions ? Object.values(positions).map((entry) => entry.position.x) : [];
  if (xs.length === 0) return { x: 0, y: 0 };
  return { x: Math.max(...xs) + LAYOUT_COLUMN_GAP, y: 0 };
}

/** Removing the trigger node is a no-op — it's the single required root. */
export function removeNode(definition: WorkflowDefinition, nodeId: string): WorkflowDefinition {
  const node = definition.nodes.find((n) => n.id === nodeId);
  if (!node || node.type === 'trigger') return definition;

  const uiNodes = { ...(definition.ui?.nodes ?? {}) };
  delete uiNodes[nodeId];

  return {
    ...definition,
    nodes: definition.nodes.filter((n) => n.id !== nodeId),
    edges: definition.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId),
    ui: { ...definition.ui, nodes: uiNodes },
  };
}

/** Duplicating the trigger node is disallowed — it returns null. */
export function duplicateNode(definition: WorkflowDefinition, nodeId: string): AddNodeResult | null {
  const node = definition.nodes.find((n) => n.id === nodeId);
  if (!node || node.type === 'trigger') return null;

  const id = createNodeId(node.type, definition.nodes.map((n) => n.id));
  // A foreach's nested body carries its own id, which must stay unique
  // across ALL foreach bodies (validator rule) — a shallow clone would
  // alias the original's body id. Re-key it off the new foreach id, the
  // same `{id}-body` convention NODE_META's default factory uses.
  const clone =
    node.type === 'foreach' ? { ...node, id, body: { ...node.body, id: `${id}-body` } } : { ...node, id };
  const sourcePosition = definition.ui?.nodes?.[nodeId]?.position ?? { x: 0, y: 0 };
  const position = { x: sourcePosition.x + 40, y: sourcePosition.y + 40 };

  return {
    nodeId: id,
    definition: {
      ...definition,
      nodes: [...definition.nodes, clone],
      ui: {
        ...definition.ui,
        nodes: { ...(definition.ui?.nodes ?? {}), [id]: { position } },
      },
    },
  };
}

/**
 * `patch` is untyped (`Record<string, unknown>`) rather than
 * `Partial<WorkflowNode>` on purpose: `Partial` of a discriminated union
 * collapses to the fields common to every member (`id`/`type`), which
 * would make this unusable for e.g. patching an llm node's `prompt`.
 * Callers (the Task 10 inspector forms) already know which node type
 * they're editing; `id` and `type` are pinned from the existing node so a
 * patch can never smuggle a type change through.
 */
export function updateNode(
  definition: WorkflowDefinition,
  nodeId: string,
  patch: Record<string, unknown>,
): WorkflowDefinition {
  return {
    ...definition,
    nodes: definition.nodes.map((node) => (node.id === nodeId ? mergeNodePatch(node, patch) : node)),
  };
}

function mergeNodePatch(node: WorkflowNode, patch: Record<string, unknown>): WorkflowNode {
  // See the `updateNode` doc comment for why this cast is the sanctioned
  // exception: `id`/`type` are pinned from `node` immediately before the
  // cast, so the discriminant can't drift from what `node.type` already
  // guarantees.
  return { ...node, ...patch, id: node.id, type: node.type } as WorkflowNode;
}

// ─── edges ────────────────────────────────────────────────────────────────────

export interface EdgeMatch {
  from: string;
  to: string;
  fromOutput?: 'true' | 'false';
}

export interface EdgePatch {
  when?: string;
  fromOutput?: 'true' | 'false';
}

export function updateEdge(
  definition: WorkflowDefinition,
  match: EdgeMatch,
  patch: EdgePatch,
): WorkflowDefinition {
  return {
    ...definition,
    edges: definition.edges.map((edge) => (edgeMatches(edge, match) ? applyEdgePatch(edge, patch) : edge)),
  };
}

function edgeMatches(edge: WorkflowEdge, match: EdgeMatch): boolean {
  return edge.from === match.from && edge.to === match.to && edge.fromOutput === match.fromOutput;
}

function applyEdgePatch(edge: WorkflowEdge, patch: EdgePatch): WorkflowEdge {
  const nextFromOutput = 'fromOutput' in patch ? patch.fromOutput : edge.fromOutput;
  const nextWhen = 'when' in patch ? patch.when : edge.when;
  return {
    from: edge.from,
    to: edge.to,
    ...(nextFromOutput ? { fromOutput: nextFromOutput } : {}),
    ...(nextWhen ? { when: nextWhen } : {}),
  };
}

// ─── position / viewport persistence ─────────────────────────────────────────

export function setNodePosition(
  definition: WorkflowDefinition,
  nodeId: string,
  position: FlowPosition,
): WorkflowDefinition {
  if (!definition.nodes.some((node) => node.id === nodeId)) return definition;
  return {
    ...definition,
    ui: {
      ...definition.ui,
      nodes: {
        ...(definition.ui?.nodes ?? {}),
        [nodeId]: { ...(definition.ui?.nodes?.[nodeId] ?? {}), position },
      },
    },
  };
}

/** Writes the camera and keeps every other editor field, `defaultModel`
 * included. The editor calls this on each pan and zoom, and again when it
 * adopts a refetch, so a rebuilt `ui` here loses a field the server wrote
 * and the next save persists the loss. */
export function setViewport(definition: WorkflowDefinition, viewport: FlowViewport): WorkflowDefinition {
  return { ...definition, ui: { ...definition.ui, nodes: definition.ui?.nodes ?? {}, viewport } };
}

// ─── auto-layout (BFS depth layering, no dagre/elk) ──────────────────────────

export const LAYOUT_COLUMN_GAP = 260;
export const LAYOUT_ROW_GAP = 120;

/** The widest a node card renders (flow-node's `max-w-[240px]`). */
const LAYOUT_NODE_WIDTH = 240;
/** Average glyph width of the 11px edge-label font. */
const LABEL_CHAR_WIDTH = 6.5;
/** Label background padding plus breathing room on both sides. */
const LABEL_MARGIN = 32;
/** Ceiling on how far one label can push a column — a pathological
 * expression must not stretch the canvas without bound. */
const LABEL_MAX_WIDTH = 420;

/** Estimated rendered width of an edge's `when` badge, in canvas px. */
export function estimateEdgeLabelWidth(when: string): number {
  return Math.min(LABEL_MAX_WIDTH, when.length * LABEL_CHAR_WIDTH + LABEL_MARGIN);
}

/**
 * Column = BFS depth from the roots (nodes with no incoming edges — in
 * practice just the trigger); row = index within that depth, in
 * `definition.nodes` order. Deterministic: the same definition always
 * produces the same positions. Nodes unreachable from any root (dangling
 * edges, or genuinely disconnected) fall back to their index in
 * `definition.nodes` as their depth, so they still get a placed, distinct
 * position instead of colliding at the origin.
 *
 * Columns are not a fixed pitch: xyflow draws an edge's `when` badge at the
 * midpoint of the path, so a labeled edge between columns needs the gap
 * between them to fit the badge or the neighboring nodes cover it. Each
 * column boundary widens to the largest label estimate that crosses it; an
 * edge that spans several columns splits its width evenly across them,
 * since its midpoint gets the combined space.
 */
export function autoLayout(definition: WorkflowDefinition): Record<string, FlowPosition> {
  const nodeIds = new Set(definition.nodes.map((node) => node.id));
  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();

  for (const edge of definition.edges) {
    if (!nodeIds.has(edge.from) || !nodeIds.has(edge.to)) continue;
    incoming.set(edge.to, [...(incoming.get(edge.to) ?? []), edge.from]);
    outgoing.set(edge.from, [...(outgoing.get(edge.from) ?? []), edge.to]);
  }

  const { depths } = computeBfsDepths(definition.nodes, incoming, outgoing);

  const nodesByDepth = new Map<number, string[]>();
  for (const node of definition.nodes) {
    const depth = depths.get(node.id) ?? 0;
    nodesByDepth.set(depth, [...(nodesByDepth.get(depth) ?? []), node.id]);
  }

  // Free space between node borders under the base pitch; a labeled edge
  // crossing boundary d (between column d and d+1) widens it when the
  // label estimate does not fit.
  const baseFree = LAYOUT_COLUMN_GAP - LAYOUT_NODE_WIDTH;
  const extraByBoundary = new Map<number, number>();
  for (const edge of definition.edges) {
    if (!edge.when) continue;
    const fromDepth = depths.get(edge.from);
    const toDepth = depths.get(edge.to);
    if (fromDepth === undefined || toDepth === undefined) continue;
    const lo = Math.min(fromDepth, toDepth);
    const hi = Math.max(fromDepth, toDepth);
    if (hi === lo) continue; // same column — the badge sits in row space
    const span = hi - lo;
    const perBoundary = Math.max(0, estimateEdgeLabelWidth(edge.when) / span - baseFree);
    if (perBoundary === 0) continue;
    for (let boundary = lo; boundary < hi; boundary += 1) {
      extraByBoundary.set(boundary, Math.max(extraByBoundary.get(boundary) ?? 0, perBoundary));
    }
  }

  const maxDepth = Math.max(0, ...nodesByDepth.keys());
  const columnX: number[] = [0];
  for (let depth = 0; depth < maxDepth; depth += 1) {
    columnX.push(columnX[depth]! + LAYOUT_COLUMN_GAP + (extraByBoundary.get(depth) ?? 0));
  }

  const positions: Record<string, FlowPosition> = {};
  for (const [depth, ids] of nodesByDepth) {
    ids.forEach((id, row) => {
      positions[id] = { x: columnX[depth] ?? depth * LAYOUT_COLUMN_GAP, y: row * LAYOUT_ROW_GAP };
    });
  }
  return positions;
}

/**
 * Give a saved position to every node that has none, in a free column to
 * the right of the placed ones.
 *
 * The assistant edits a definition through `workflows.patch_workflow`,
 * whose patch shape carries no `ui` field, so a node it adds arrives with
 * no entry in `ui.nodes`. `toFlow` then falls back to `autoLayout` for that
 * one id, and auto-layout coordinates have no relation to hand-dragged
 * ones — the new node can land on top of a node the user placed. The
 * client closes the gap when it adopts a patched definition.
 *
 * Returns the definition unchanged when every node already has a position,
 * and also when NO node has one. A definition with no `ui.nodes` at all is
 * the normal shape for a workflow the agent wrote or a template installed,
 * and `toFlow` lays that out with `autoLayout`, which reads the edges.
 * Nothing is hand-placed there, so nothing can be covered — writing
 * coordinates would only replace a graph-shaped layout with one flat
 * column.
 */
export function positionNewNodes(definition: WorkflowDefinition): WorkflowDefinition {
  const saved = definition.ui?.nodes ?? {};
  const xs = Object.values(saved).map((entry) => entry.position.x);
  if (xs.length === 0) return definition;
  const unplaced = definition.nodes.filter((node) => saved[node.id] === undefined);
  if (unplaced.length === 0) return definition;

  const column = Math.max(...xs) + LAYOUT_COLUMN_GAP;
  const placed: Record<string, { position: FlowPosition }> = { ...saved };
  unplaced.forEach((node, row) => {
    placed[node.id] = { position: { x: column, y: row * LAYOUT_ROW_GAP } };
  });

  return { ...definition, ui: { ...definition.ui, nodes: placed } };
}

interface BfsDepths {
  /** Longest path from a root to each node, in edges. */
  depths: Map<string, number>;
  /**
   * The reached nodes in topological order. A node in a cycle, or one whose
   * every predecessor is in a cycle, is absent — it never entered the queue.
   */
  order: string[];
}

/**
 * `nodes` is widened to "anything with an id" because the concurrency
 * analysis below runs over flow nodes, and the layout above runs over
 * definition nodes. Only the id and the array order are read.
 */
function computeBfsDepths(
  nodes: ReadonlyArray<{ id: string }>,
  incoming: Map<string, string[]>,
  outgoing: Map<string, string[]>,
): BfsDepths {
  const depths = new Map<string, number>();
  const remainingIncoming = new Map(nodes.map((node) => [node.id, incoming.get(node.id)?.length ?? 0]));
  const queue: string[] = nodes.filter((node) => (remainingIncoming.get(node.id) ?? 0) === 0).map((node) => node.id);
  for (const id of queue) depths.set(id, 0);

  for (let index = 0; index < queue.length; index += 1) {
    const id = queue[index]!;
    const nextDepth = (depths.get(id) ?? 0) + 1;
    for (const target of outgoing.get(id) ?? []) {
      depths.set(target, Math.max(depths.get(target) ?? 0, nextDepth));
      const remaining = (remainingIncoming.get(target) ?? 0) - 1;
      remainingIncoming.set(target, remaining);
      if (remaining === 0) queue.push(target);
    }
  }

  // Nodes never reached (cycles, or every predecessor is itself
  // unreached) still need a deterministic depth: fall back to their
  // position in `definition.nodes`.
  for (const [index, node] of nodes.entries()) {
    if (!depths.has(node.id)) depths.set(node.id, index);
  }

  return { depths, order: queue };
}

// ─── concurrency (which steps run at the same time) ──────────────────────────

/**
 * What the graph shape says about one node's concurrency.
 *
 * The interpreter runs a node when every incoming edge has resolved, so all
 * nodes at one depth become runnable in the same pass — see `driveLoop` and
 * `computeRunnable` in `@valet/workflow`'s `interpreter.ts`. That depth is
 * the `wave`.
 */
export interface NodeConcurrency {
  /** 0-based wave index. */
  wave: number;
  /** Steps that leave this node on ONE output and become ready together. */
  parallelOut: number;
  /** Outputs that leave this node, of which a run takes exactly one. */
  exclusiveOut: number;
  /** Edges that arrive here. The node waits for every one of them. */
  fanIn: number;
}

/** Two or more nodes that the graph allows to be in flight at once. */
export interface ConcurrencyGroup {
  /** Stable across renders of the same graph, so it can key a React list. */
  id: string;
  /** 0-based wave index the group belongs to. */
  wave: number;
  nodeIds: string[];
}

export interface ConcurrencyModel {
  byNode: Record<string, NodeConcurrency>;
  groups: ConcurrencyGroup[];
}

/**
 * Which output an edge leaves its source on. An empty string is the single
 * unlabeled output that every node except `if` and `approval` has. The
 * precedence matches `flowEdgeToWorkflowEdge`.
 */
function edgeOutput(edge: WorkflowFlowEdge): string {
  return edge.data.fromOutput ?? edge.sourceHandle ?? '';
}

/**
 * Group the nodes that the graph allows to run at the same time, and count
 * each node's fan-in and fan-out.
 *
 * Sharing a wave is not enough to be concurrent. The two sides of an `if`
 * can land at the same depth, and only one of them ever runs — the other is
 * skipped. So each node also carries the branch decisions every path to it
 * must take (`requiredBranches`), and two nodes that need opposite outputs
 * of the same branch node never share a group.
 *
 * Grouping is a greedy pass in node order rather than an exact partition.
 * It can therefore split a set that could have been one group, but it never
 * puts two exclusive nodes together. Under-reporting is the safe direction:
 * a group that is drawn is always true.
 */
export function analyzeConcurrency(
  flow: Pick<WorkflowFlowState, 'nodes' | 'edges'>,
): ConcurrencyModel {
  const nodeIds = new Set(flow.nodes.map((node) => node.id));
  const edges = flow.edges.filter((edge) => nodeIds.has(edge.source) && nodeIds.has(edge.target));

  const incoming = new Map<string, string[]>();
  const outgoing = new Map<string, string[]>();
  const incomingEdges = new Map<string, WorkflowFlowEdge[]>();
  // source node -> output name -> how many targets leave on that output.
  const outputs = new Map<string, Map<string, number>>();

  for (const edge of edges) {
    incoming.set(edge.target, [...(incoming.get(edge.target) ?? []), edge.source]);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
    incomingEdges.set(edge.target, [...(incomingEdges.get(edge.target) ?? []), edge]);
    const byOutput = outputs.get(edge.source) ?? new Map<string, number>();
    const output = edgeOutput(edge);
    byOutput.set(output, (byOutput.get(output) ?? 0) + 1);
    outputs.set(edge.source, byOutput);
  }

  const { depths, order } = computeBfsDepths(flow.nodes, incoming, outgoing);
  const required = requiredBranches(order, incomingEdges, outputs);

  const byNode: Record<string, NodeConcurrency> = {};
  for (const node of flow.nodes) {
    const byOutput = outputs.get(node.id);
    byNode[node.id] = {
      wave: depths.get(node.id) ?? 0,
      parallelOut: byOutput ? Math.max(...byOutput.values()) : 0,
      exclusiveOut: byOutput ? byOutput.size : 0,
      fanIn: incoming.get(node.id)?.length ?? 0,
    };
  }

  const byWave = new Map<number, string[]>();
  for (const node of flow.nodes) {
    const wave = byNode[node.id]?.wave ?? 0;
    byWave.set(wave, [...(byWave.get(wave) ?? []), node.id]);
  }

  const groups: ConcurrencyGroup[] = [];
  for (const wave of [...byWave.keys()].sort((a, b) => a - b)) {
    const cliques: string[][] = [];
    for (const id of byWave.get(wave) ?? []) {
      const clique = cliques.find((members) =>
        members.every((member) => !isExclusive(required.get(id), required.get(member))),
      );
      if (clique) clique.push(id);
      else cliques.push([id]);
    }
    cliques.forEach((ids, index) => {
      if (ids.length > 1) groups.push({ id: `wave-${wave}-${index}`, wave, nodeIds: ids });
    });
  }

  return { byNode, groups };
}

/**
 * For each node, the branch decisions that EVERY path to it takes, as
 * `branch node id -> output`.
 *
 * A path picks up a decision when it leaves a node that has more than one
 * output wired. A node with a single wired output makes no choice, so it
 * contributes nothing. Where a node is reachable by several paths, the
 * intersection of those paths is kept: a decision that only some paths take
 * is not required.
 */
function requiredBranches(
  order: string[],
  incomingEdges: Map<string, WorkflowFlowEdge[]>,
  outputs: Map<string, Map<string, number>>,
): Map<string, Map<string, string>> {
  const required = new Map<string, Map<string, string>>();
  // `order` is topological, so every source below already has its answer.
  for (const id of order) {
    const arriving = incomingEdges.get(id) ?? [];
    let merged: Map<string, string> | null = null;
    for (const edge of arriving) {
      const path = new Map(required.get(edge.source) ?? []);
      if ((outputs.get(edge.source)?.size ?? 0) > 1) path.set(edge.source, edgeOutput(edge));
      merged = merged === null ? path : intersectBranches(merged, path);
    }
    required.set(id, merged ?? new Map());
  }
  return required;
}

function intersectBranches(
  left: Map<string, string>,
  right: Map<string, string>,
): Map<string, string> {
  const shared = new Map<string, string>();
  for (const [branchNode, output] of left) {
    if (right.get(branchNode) === output) shared.set(branchNode, output);
  }
  return shared;
}

/** True when the two nodes need opposite outputs of the same branch node,
 * which means one of them is always skipped. */
function isExclusive(
  left: Map<string, string> | undefined,
  right: Map<string, string> | undefined,
): boolean {
  if (!left || !right) return false;
  for (const [branchNode, output] of left) {
    const other = right.get(branchNode);
    if (other !== undefined && other !== output) return true;
  }
  return false;
}

// ─── node summaries ────────────────────────────────────────────────────────────

function summarizeNode(node: WorkflowNode): string {
  switch (node.type) {
    case 'trigger':
      return 'Where the workflow starts and what data it receives';
    case 'set': {
      const count = Object.keys(asRecord(node.values)).length;
      return `${count} value${count === 1 ? '' : 's'}`;
    }
    case 'if': {
      // Defensive `?? 0`: definitions saved before the validator required
      // `conditions` may carry an `if` node without the array — a summary
      // must degrade, not crash the whole canvas.
      const count = node.conditions?.length ?? 0;
      return `${count} condition${count === 1 ? '' : 's'}`;
    }
    case 'wait':
      return node.duration || 'No duration configured';
    case 'approval':
      return trimSummary(node.summary || node.prompt || 'No prompt configured');
    case 'session':
      return trimSummary(node.prompt || 'No prompt configured');
    case 'stop':
      return trimSummary(node.message || node.outcome || 'success');
    case 'workflow':
      return node.workflowId ? `Runs ${node.workflowId}` : 'No workflow selected';
    case 'foreach':
      return trimSummary(node.items || 'No item expression configured');
    case 'llm':
      return trimSummary(node.prompt || node.model || 'No prompt configured');
    case 'thread':
      return trimSummary(node.prompt || 'No prompt configured');
    case 'tool':
      return trimSummary(node.service && node.action ? `${node.service}.${node.action}` : 'No action configured');
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function trimSummary(value: string): string {
  return value.length > 80 ? `${value.slice(0, 77)}...` : value;
}

// ─── minimal starter definition ───────────────────────────────────────────────

export function createDefaultWorkflowDefinition(): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [{ id: 'trigger', type: 'trigger' }, { id: 'stop', type: 'stop', outcome: 'success' }],
    edges: [{ from: 'trigger', to: 'stop' }],
    ui: {
      nodes: {
        trigger: { position: { x: 0, y: 0 } },
        stop: { position: { x: LAYOUT_COLUMN_GAP, y: 0 } },
      },
    },
  };
}
