/**
 * Semantic patch operations for workflow definitions.
 *
 * The copilot uses these to make incremental edits without rewriting
 * the entire definition each turn. Each op is small (~tens of tokens)
 * and refers to nodes/edges by id rather than JSON Pointer paths — so
 * the LLM doesn't have to maintain mental array indices.
 *
 * Application is atomic: ops apply in order against a working copy
 * and the result replaces the draft only if every op succeeds. Any
 * thrown error from `applyOps` rolls back to the input definition.
 */
import type { WorkflowDefinition, WorkflowEdge } from '@valet/shared';
import type { WorkflowNode } from '@valet/shared';

// ────────────────────────────────────────────────────────────────────────
// Op types
// ────────────────────────────────────────────────────────────────────────

export type WorkflowOp =
  | { op: 'addNode'; node: Record<string, unknown> }
  | { op: 'updateNode'; id: string; patch: Record<string, unknown> }
  | { op: 'removeNode'; id: string }
  | { op: 'addEdge'; edge: Record<string, unknown> }
  | { op: 'removeEdge'; from: string; to: string; fromOutput?: 'true' | 'false' }
  | { op: 'setMeta'; patch: Record<string, unknown> };

// ────────────────────────────────────────────────────────────────────────
// Apply
// ────────────────────────────────────────────────────────────────────────

export function applyOps(def: WorkflowDefinition, ops: WorkflowOp[]): WorkflowDefinition {
  let working: WorkflowDefinition = structuredClone(def);
  for (const [i, op] of ops.entries()) {
    try {
      working = applyOp(working, op);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`op #${i} (${op.op}): ${msg}`);
    }
  }
  return working;
}

function applyOp(def: WorkflowDefinition, op: WorkflowOp): WorkflowDefinition {
  switch (op.op) {
    case 'addNode':       return addNode(def, op.node);
    case 'updateNode':    return updateNode(def, op.id, op.patch);
    case 'removeNode':    return removeNode(def, op.id);
    case 'addEdge':       return addEdge(def, op.edge);
    case 'removeEdge':    return removeEdge(def, op.from, op.to, op.fromOutput);
    case 'setMeta':       return setMeta(def, op.patch);
    default: {
      const _exhaustive: never = op;
      void _exhaustive;
      throw new Error(`unknown op`);
    }
  }
}

// ────────────────────────────────────────────────────────────────────────
// Individual ops
// ────────────────────────────────────────────────────────────────────────

function addNode(def: WorkflowDefinition, node: Record<string, unknown>): WorkflowDefinition {
  const id = node.id;
  if (typeof id !== 'string' || id.length === 0) {
    throw new Error('node.id is required and must be a non-empty string');
  }
  if (typeof node.type !== 'string' || node.type.length === 0) {
    throw new Error('node.type is required and must be a non-empty string');
  }
  if (def.nodes.some((n) => n.id === id)) {
    throw new Error(`node id "${id}" already exists`);
  }
  return { ...def, nodes: [...def.nodes, node as unknown as WorkflowNode] };
}

function updateNode(def: WorkflowDefinition, id: string, patch: Record<string, unknown>): WorkflowDefinition {
  const idx = def.nodes.findIndex((n) => n.id === id);
  if (idx === -1) throw new Error(`node "${id}" not found`);
  if (patch.id !== undefined && patch.id !== id) {
    throw new Error('updateNode cannot change a node id — use removeNode + addNode');
  }
  const merged = deepMerge(def.nodes[idx] as unknown as Record<string, unknown>, patch);
  return {
    ...def,
    nodes: def.nodes.map((n, i) => (i === idx ? (merged as unknown as WorkflowNode) : n)),
  };
}

function removeNode(def: WorkflowDefinition, id: string): WorkflowDefinition {
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

function addEdge(def: WorkflowDefinition, edge: Record<string, unknown>): WorkflowDefinition {
  if (typeof edge.from !== 'string' || typeof edge.to !== 'string') {
    throw new Error('edge.from and edge.to are required strings');
  }
  if (!def.nodes.some((n) => n.id === edge.from)) {
    throw new Error(`edge.from node "${edge.from}" does not exist`);
  }
  if (!def.nodes.some((n) => n.id === edge.to)) {
    throw new Error(`edge.to node "${edge.to}" does not exist`);
  }
  const exists = def.edges.some(
    (e) => e.from === edge.from && e.to === edge.to && e.fromOutput === edge.fromOutput,
  );
  if (exists) throw new Error(`edge ${edge.from} → ${edge.to} already exists`);
  return { ...def, edges: [...def.edges, edge as unknown as WorkflowEdge] };
}

function removeEdge(
  def: WorkflowDefinition,
  from: string,
  to: string,
  fromOutput?: 'true' | 'false',
): WorkflowDefinition {
  const before = def.edges.length;
  const filtered = def.edges.filter(
    (e) => !(e.from === from && e.to === to && (fromOutput === undefined || e.fromOutput === fromOutput)),
  );
  if (filtered.length === before) {
    throw new Error(`edge ${from} → ${to}${fromOutput ? ` (${fromOutput})` : ''} not found`);
  }
  return { ...def, edges: filtered };
}

function setMeta(def: WorkflowDefinition, patch: Record<string, unknown>): WorkflowDefinition {
  // Only the documented top-level fields are mergeable via setMeta.
  // Specifically NOT `nodes` or `edges` — use the structural ops for
  // those so the model doesn't accidentally clobber the graph.
  const allowed: Array<keyof WorkflowDefinition> = ['version', 'policy', 'ui'];
  const merged: Record<string, unknown> = { ...(def as unknown as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (!(allowed as string[]).includes(k)) {
      throw new Error(`setMeta cannot modify "${k}" — use addNode/addEdge/etc. for graph changes`);
    }
    if (v === null) delete merged[k];
    else merged[k] = v;
  }
  return merged as unknown as WorkflowDefinition;
}

// ────────────────────────────────────────────────────────────────────────
// Deep merge
// ────────────────────────────────────────────────────────────────────────

/**
 * Recursive merge:
 *   • objects merge key-by-key
 *   • arrays replace wholesale (not element-merge — too ambiguous)
 *   • `null` in the patch deletes the key from the target
 *   • everything else replaces
 *
 * This is JSON-Merge-Patch semantics (RFC 7396), chosen because LLMs
 * compose it intuitively for nested updates without needing to think
 * about JSON Pointer paths.
 */
function deepMerge(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...target };
  for (const [k, v] of Object.entries(patch)) {
    if (v === null) {
      delete out[k];
      continue;
    }
    if (
      v !== undefined &&
      typeof v === 'object' &&
      !Array.isArray(v) &&
      typeof out[k] === 'object' &&
      out[k] !== null &&
      !Array.isArray(out[k])
    ) {
      out[k] = deepMerge(out[k] as Record<string, unknown>, v as Record<string, unknown>);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}
