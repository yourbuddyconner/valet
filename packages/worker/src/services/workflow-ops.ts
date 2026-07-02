/**
 * Semantic patch operations for workflow definitions.
 *
 * The copilot uses these to make incremental edits without rewriting
 * the entire definition each turn. Each op is small (~tens of tokens)
 * and refers to nodes/edges by id rather than JSON Pointer paths — so
 * the LLM doesn't have to maintain mental array indices.
 *
 * Application is atomic: ops apply in order against a working copy
 * and the result replaces the draft only if every op succeeds AND the
 * final shape passes `isWorkflowDefinition`. Any failure rolls back
 * to the caller's input.
 *
 * Implementation note: internally we work over plain
 * `Record<string, unknown>` shapes because the LLM emits arbitrary
 * JSON and node objects don't satisfy the discriminated union at
 * compile time. The narrow back to `WorkflowDefinition` happens once
 * at the end via the runtime type guard — no `as unknown as` casts.
 */
import type { WorkflowDefinition } from '@valet/shared';
import { isWorkflowDefinition } from '../lib/workflow-dag/schema.js';

export type WorkflowOp =
  | { op: 'addNode'; node: Record<string, unknown> }
  | { op: 'updateNode'; id: string; patch: Record<string, unknown> }
  | { op: 'removeNode'; id: string }
  | { op: 'addEdge'; edge: Record<string, unknown> }
  | { op: 'removeEdge'; from: string; to: string; fromOutput?: 'true' | 'false' }
  | { op: 'setMeta'; patch: Record<string, unknown> };

interface WorkingDef {
  version: unknown;
  nodes: Array<Record<string, unknown>>;
  edges: Array<Record<string, unknown>>;
  // policy, ui, etc. — carried opaquely.
  [key: string]: unknown;
}

export function applyOps(def: WorkflowDefinition, ops: readonly WorkflowOp[]): WorkflowDefinition {
  const next = applyOpsLenient(def, ops);
  // Runtime narrow back to a real WorkflowDefinition. If the LLM
  // produced a shape that violates the schema we throw before
  // persisting so the caller can surface the issue.
  if (!isWorkflowDefinition(next)) {
    throw new Error('patch result is not a valid dag/v1 workflow definition');
  }
  return next;
}

/**
 * Apply ops without the strict end-of-pipeline narrow. Returns the raw
 * intermediate shape as `unknown` so callers can choose their own
 * validation strategy — e.g. the copilot runs `validateDefinition` to
 * surface specific issues to the model, rather than failing with a
 * single opaque boolean.
 *
 * Also auto-lays out any newly-added nodes that don't have a `ui.nodes`
 * entry, so patches from the copilot don't stack every new node at the
 * origin. Positions are derived from neighbors (right-of-upstream,
 * left-of-downstream, or top-right-of-existing).
 *
 * Accepts `readonly unknown[]` at the boundary because the ops come
 * from an LLM tool call and are only shape-validated inside `applyOp`.
 * The typed `WorkflowOp[]` form (used by tests) is a subtype.
 */
export function applyOpsLenient(def: WorkflowDefinition, ops: readonly unknown[]): unknown {
  const previousNodeIds = new Set(def.nodes.map((n) => n.id));
  let working = toWorking(def);
  for (const [i, rawOp] of ops.entries()) {
    if (!isPlainObject(rawOp)) {
      throw new Error(`op #${i}: expected an object, got ${typeof rawOp}`);
    }
    try {
      working = applyOp(working, rawOp as WorkflowOp);
    } catch (err) {
      const opName = (rawOp as { op?: unknown }).op;
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`op #${i} (${String(opName ?? 'unknown')}): ${msg}`);
    }
  }
  return autoLayoutNewNodes(working, previousNodeIds);
}

// ────────────────────────────────────────────────────────────────────────
// Auto-layout
// ────────────────────────────────────────────────────────────────────────

// Match the editor's spacing so copilot-placed nodes align on the
// canvas grid with human-placed ones.
const COLUMN_GAP = 340;
const ROW_GAP = 180;

interface Position { x: number; y: number }

function autoLayoutNewNodes(def: WorkingDef, previousNodeIds: Set<string>): WorkingDef {
  const uiNodes = extractUiNodes(def);
  const positions = new Map<string, Position>();
  for (const [id, entry] of Object.entries(uiNodes)) {
    const pos = extractPosition(entry);
    if (pos) positions.set(id, pos);
  }

  const unplacedNewIds: string[] = [];
  for (const node of def.nodes) {
    const id = node.id;
    if (typeof id !== 'string') continue;
    if (previousNodeIds.has(id)) continue;
    if (positions.has(id)) continue;
    unplacedNewIds.push(id);
  }
  if (unplacedNewIds.length === 0) return def;

  // Fixed-point iteration: repeatedly try to place a new node from its
  // already-positioned neighbors. Nodes whose neighbors are themselves
  // new get placed once those neighbors settle in a later pass.
  const remaining = new Set(unplacedNewIds);
  let progress = true;
  while (progress && remaining.size > 0) {
    progress = false;
    for (const id of [...remaining]) {
      const placed = tryPlaceFromNeighbors(id, def.edges, positions);
      if (placed) {
        positions.set(id, placed);
        remaining.delete(id);
        progress = true;
      }
    }
  }
  // Fallback for any node whose neighbors are still unpositioned:
  // stack them to the right of the existing bounding box, one row
  // apart, in stable id order.
  if (remaining.size > 0) {
    const boundsRight = positions.size > 0
      ? Math.max(...[...positions.values()].map((p) => p.x))
      : 0;
    const startY = 0;
    const stackX = boundsRight + COLUMN_GAP;
    let row = 0;
    for (const id of [...remaining].sort()) {
      positions.set(id, { x: stackX, y: startY + row * ROW_GAP });
      row++;
    }
  }

  return applyPositions(def, positions);
}

function tryPlaceFromNeighbors(
  id: string,
  edges: Array<Record<string, unknown>>,
  positions: Map<string, Position>,
): Position | null {
  const upstreamIds = edges
    .filter((e) => e.to === id && typeof e.from === 'string')
    .map((e) => e.from as string);
  const upPositions = upstreamIds
    .map((upId) => positions.get(upId))
    .filter((p): p is Position => p !== undefined);
  if (upPositions.length > 0) {
    const anchor = upPositions.reduce((max, p) => (p.x > max.x ? p : max), upPositions[0]);
    return spreadFromSiblings({ x: anchor.x + COLUMN_GAP, y: averageY(upPositions) }, positions);
  }
  const downstreamIds = edges
    .filter((e) => e.from === id && typeof e.to === 'string')
    .map((e) => e.to as string);
  const downPositions = downstreamIds
    .map((downId) => positions.get(downId))
    .filter((p): p is Position => p !== undefined);
  if (downPositions.length > 0) {
    const anchor = downPositions.reduce((min, p) => (p.x < min.x ? p : min), downPositions[0]);
    return spreadFromSiblings({ x: anchor.x - COLUMN_GAP, y: averageY(downPositions) }, positions);
  }
  return null;
}

/**
 * If any already-placed node sits within a row-gap of `candidate`,
 * push down until we find a free slot. Prevents new siblings from
 * stacking directly on top of existing ones.
 */
function spreadFromSiblings(candidate: Position, positions: Map<string, Position>): Position {
  let y = candidate.y;
  const collides = () => {
    for (const p of positions.values()) {
      if (Math.abs(p.x - candidate.x) < 1 && Math.abs(p.y - y) < ROW_GAP) return true;
    }
    return false;
  };
  let guard = 0;
  while (collides() && guard < 64) {
    y += ROW_GAP;
    guard++;
  }
  return { x: candidate.x, y };
}

function averageY(positions: Position[]): number {
  if (positions.length === 0) return 0;
  return positions.reduce((sum, p) => sum + p.y, 0) / positions.length;
}

function extractUiNodes(def: WorkingDef): Record<string, unknown> {
  const ui = def.ui;
  if (!isPlainObject(ui)) return {};
  const nodes = (ui as Record<string, unknown>).nodes;
  return isPlainObject(nodes) ? nodes : {};
}

function extractPosition(entry: unknown): Position | null {
  if (!isPlainObject(entry)) return null;
  const pos = entry.position;
  if (!isPlainObject(pos)) return null;
  if (typeof pos.x === 'number' && typeof pos.y === 'number') {
    return { x: pos.x, y: pos.y };
  }
  return null;
}

function applyPositions(def: WorkingDef, positions: Map<string, Position>): WorkingDef {
  const ui = isPlainObject(def.ui) ? { ...def.ui } : { nodes: {} };
  const uiNodes = isPlainObject(ui.nodes) ? { ...ui.nodes } : {};
  for (const [id, position] of positions) {
    const existing = isPlainObject(uiNodes[id]) ? uiNodes[id] : {};
    uiNodes[id] = { ...existing, position };
  }
  return { ...def, ui: { ...ui, nodes: uiNodes } };
}

function toWorking(def: WorkflowDefinition): WorkingDef {
  // Workflow definitions are pure JSON (no Dates, Maps, or functions),
  // so a serialize/parse round-trip detaches us from the discriminated
  // union typing in one step. JSON.parse returns `unknown` here; we
  // narrow with `isPlainObject` and the array filter has a typed
  // predicate, so no `as` cast is needed.
  const cloned: unknown = JSON.parse(JSON.stringify(def));
  if (!isPlainObject(cloned)) {
    throw new Error('definition must be an object');
  }
  const nodes = Array.isArray(cloned.nodes) ? cloned.nodes.filter(isPlainObject) : [];
  const edges = Array.isArray(cloned.edges) ? cloned.edges.filter(isPlainObject) : [];
  return {
    ...cloned,
    nodes,
    edges,
    version: cloned.version,
  };
}

function applyOp(def: WorkingDef, op: WorkflowOp): WorkingDef {
  switch (op.op) {
    case 'addNode':       return addNode(def, op.node);
    case 'updateNode':    return updateNode(def, op.id, op.patch);
    case 'removeNode':    return removeNode(def, op.id);
    case 'addEdge':       return addEdge(def, op.edge);
    case 'removeEdge':    return removeEdge(def, op.from, op.to, op.fromOutput);
    case 'setMeta':       return setMeta(def, op.patch);
  }
}

function addNode(def: WorkingDef, node: Record<string, unknown>): WorkingDef {
  const id = node.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('node.id is required and must be a non-empty string');
  }
  if (typeof node.type !== 'string' || node.type.length === 0) {
    throw new Error('node.type is required and must be a non-empty string');
  }
  // Dag/v1 node ids share ONE namespace with foreach body ids — check
  // both so we surface the collision here (with a hint about which
  // scope) instead of downstream in the validator.
  const collision = findExistingId(def, id);
  if (collision) throw new Error(`node id "${id}" already exists${collision === 'body' ? ' as a foreach body id' : ''}`);
  return { ...def, nodes: [...def.nodes, node] };
}

function findExistingId(def: WorkingDef, id: string): 'top' | 'body' | null {
  for (const n of def.nodes) {
    if (n.id === id) return 'top';
    if (n.type === 'foreach') {
      const body = (n as Record<string, unknown>).body;
      if (isPlainObject(body) && body.id === id) return 'body';
    }
  }
  return null;
}

function updateNode(def: WorkingDef, id: string, patch: Record<string, unknown>): WorkingDef {
  const idx = def.nodes.findIndex((n) => n.id === id);
  if (idx === -1) throw new Error(`node "${id}" not found`);
  if (patch.id !== undefined && patch.id !== id) {
    throw new Error('updateNode cannot change a node id — use removeNode + addNode');
  }
  const merged = deepMerge(def.nodes[idx], patch);
  return {
    ...def,
    nodes: def.nodes.map((n, i) => (i === idx ? merged : n)),
  };
}

function removeNode(def: WorkingDef, id: string): WorkingDef {
  if (!def.nodes.some((n) => n.id === id)) {
    throw new Error(`node "${id}" not found`);
  }
  return {
    ...def,
    nodes: def.nodes.filter((n) => n.id !== id),
    // Cascade: drop any edges incident on the removed node so the
    // resulting graph stays well-formed.
    edges: def.edges.filter((e) => e.from !== id && e.to !== id),
  };
}

function addEdge(def: WorkingDef, edge: Record<string, unknown>): WorkingDef {
  if (typeof edge.from !== 'string' || typeof edge.to !== 'string') {
    throw new Error('edge.from and edge.to are required strings');
  }
  const fromNode = def.nodes.find((n) => n.id === edge.from);
  if (!fromNode) {
    throw new Error(`edge.from node "${edge.from}" does not exist`);
  }
  if (!def.nodes.some((n) => n.id === edge.to)) {
    throw new Error(`edge.to node "${edge.to}" does not exist`);
  }
  // fromOutput belongs only on edges leaving `if` nodes, and every
  // outbound `if` edge must set it — the validator would catch this
  // later, but we prefer to fail the op so the tool's atomic-rollback
  // promise holds.
  const fromOutput = edge.fromOutput;
  const isIfSource = fromNode.type === 'if';
  if (fromOutput !== undefined && fromOutput !== 'true' && fromOutput !== 'false') {
    throw new Error(`edge.fromOutput must be "true" or "false" when set (got ${JSON.stringify(fromOutput)})`);
  }
  if (isIfSource && fromOutput === undefined) {
    throw new Error(`edges from "if" node "${edge.from}" require fromOutput ("true" or "false")`);
  }
  if (!isIfSource && fromOutput !== undefined) {
    throw new Error(`edge.fromOutput is only valid on edges leaving an "if" node; "${edge.from}" is type "${fromNode.type ?? 'unknown'}"`);
  }
  const exists = def.edges.some(
    (e) => e.from === edge.from && e.to === edge.to && e.fromOutput === edge.fromOutput,
  );
  if (exists) throw new Error(`edge ${edge.from} → ${edge.to} already exists`);
  return { ...def, edges: [...def.edges, edge] };
}

function removeEdge(
  def: WorkingDef,
  from: string,
  to: string,
  fromOutput?: 'true' | 'false',
): WorkingDef {
  const before = def.edges.length;
  const filtered = def.edges.filter(
    (e) => !(e.from === from && e.to === to && (fromOutput === undefined || e.fromOutput === fromOutput)),
  );
  if (filtered.length === before) {
    throw new Error(`edge ${from} → ${to}${fromOutput ? ` (${fromOutput})` : ''} not found`);
  }
  return { ...def, edges: filtered };
}

function setMeta(def: WorkingDef, patch: Record<string, unknown>): WorkingDef {
  // Only the documented top-level fields are mergeable via setMeta.
  // Specifically NOT `nodes` or `edges` — use the structural ops for
  // those so the model doesn't accidentally clobber the graph.
  //
  // For object-valued fields (`ui`, `policy`) we DEEP-MERGE so the
  // model can e.g. add one node's position via `{ui:{nodes:{new:...}}}`
  // without wiping every other node's position. `version` is scalar
  // and gets replaced wholesale.
  const allowed = new Set(['version', 'policy', 'ui']);
  const merged: WorkingDef = { ...def };
  for (const [k, v] of Object.entries(patch)) {
    if (!allowed.has(k)) {
      throw new Error(`setMeta cannot modify "${k}" — use addNode/addEdge/etc. for graph changes`);
    }
    if (v === null) {
      delete merged[k];
      continue;
    }
    if (k === 'version') {
      merged[k] = v;
      continue;
    }
    // ui / policy — deep merge onto whatever's there.
    const current = merged[k];
    if (isPlainObject(current) && isPlainObject(v)) {
      merged[k] = deepMerge(current, v);
    } else {
      merged[k] = v;
    }
  }
  return merged;
}

/**
 * Recursive merge:
 *   • objects merge key-by-key
 *   • arrays replace wholesale (not element-merge — too ambiguous)
 *   • `null` in the patch deletes the key from the target
 *   • everything else replaces
 *
 * JSON-Merge-Patch semantics (RFC 7396) — chosen because LLMs compose
 * it intuitively for nested updates without needing JSON Pointer.
 */
function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k];
      continue;
    }
    if (v === undefined) continue;
    const targetVal = out[k];
    if (
      isPlainObject(v) &&
      isPlainObject(targetVal)
    ) {
      out[k] = deepMerge(targetVal, v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
