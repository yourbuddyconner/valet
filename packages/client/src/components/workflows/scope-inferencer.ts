import type {
  VariableDefinition,
  WorkflowData,
  WorkflowStep,
} from '@/api/workflows';

export type ScopeFieldType =
  | 'string'
  | 'number'
  | 'boolean'
  | 'array'
  | 'object'
  | 'unknown';

export interface ScopeField {
  type: ScopeFieldType;
  description?: string;
  /** For type=object — the field's nested shape, walked from outputSchema. */
  fields?: Record<string, ScopeField>;
  /** For type=array — element shape, if known. */
  item?: ScopeField;
}

export interface Scope {
  variables: Record<string, ScopeField>;
  outputs: Record<string, ScopeField>;
  /** Present when the target step is inside a loop body. */
  loop?: { item: ScopeField; index: ScopeField };
}

// The OutputSchemaField shape mirrors WorkflowStep['outputSchema'] entries —
// duplicated locally so we don't depend on a non-exported indexed access.
interface OutputSchemaField {
  type: 'string' | 'number' | 'boolean' | 'array' | 'object';
  description?: string;
}

function variableToField(v: VariableDefinition): ScopeField {
  return v.description !== undefined
    ? { type: v.type, description: v.description }
    : { type: v.type };
}

function outputSchemaToField(schema: Record<string, OutputSchemaField>): ScopeField {
  const fields: Record<string, ScopeField> = {};
  for (const [k, v] of Object.entries(schema)) {
    fields[k] = v.description !== undefined
      ? { type: v.type, description: v.description }
      : { type: v.type };
  }
  return { type: 'object', fields };
}

function stepOutputField(step: WorkflowStep): ScopeField {
  if (step.outputSchema) return outputSchemaToField(step.outputSchema);
  return { type: 'unknown' };
}

/**
 * Walks `path` (dot notation) into `field`. Returns the resolved field or null.
 * Only walks through `.fields` (object) — array indexing is intentionally not
 * supported in v1 because template authors write `outputs.foo.bar`, not
 * `outputs.foo[0]`.
 */
/** Map a literal JS value to a ScopeFieldType. Used for inline-array loop items. */
function scopeTypeOf(value: unknown): ScopeFieldType {
  if (value === null || value === undefined) return 'unknown';
  if (Array.isArray(value)) return 'array';
  switch (typeof value) {
    case 'string': return 'string';
    case 'number': return 'number';
    case 'boolean': return 'boolean';
    case 'object': return 'object';
    default: return 'unknown';
  }
}

function walkField(field: ScopeField, segments: string[]): ScopeField | null {
  let current: ScopeField = field;
  for (const seg of segments) {
    if (current.type === 'object' && current.fields && seg in current.fields) {
      current = current.fields[seg];
      continue;
    }
    return null;
  }
  return current;
}

export function resolveScopePath(scope: Scope, path: string): ScopeField | null {
  const parts = path.split('.').filter(Boolean);
  if (parts.length === 0) return null;
  const [root, ...rest] = parts;

  if (root === 'variables') {
    if (rest.length === 0) return null;
    const [name, ...tail] = rest;
    const field = scope.variables[name];
    if (!field) return null;
    return walkField(field, tail);
  }
  if (root === 'outputs') {
    if (rest.length === 0) return null;
    const [name, ...tail] = rest;
    const field = scope.outputs[name];
    if (!field) return null;
    return walkField(field, tail);
  }
  if (root === 'loop') {
    if (!scope.loop) return null;
    if (rest.length === 0) return null;
    const [name, ...tail] = rest;
    if (name === 'item') return walkField(scope.loop.item, tail);
    if (name === 'index') return walkField(scope.loop.index, tail);
    return null;
  }
  return null;
}

interface WalkResult {
  /** Outputs visible AFTER this step (and all descendants) complete. */
  outputs: Record<string, ScopeField>;
  /** If we found the target inside this subtree, the fully-built scope. */
  found?: Scope;
}

interface WalkContext {
  targetStepId: string;
  variables: Record<string, ScopeField>;
  /** Tracks loop context if we descend into a loop body. */
  loop?: { item: ScopeField; index: ScopeField };
}

/**
 * Walk a list of sibling steps in order. Each step sees outputs from all
 * preceding siblings (and their descendants). Returns merged outputs after
 * the block, or a `found` scope if the target was hit.
 */
function walkSteps(
  steps: WorkflowStep[],
  outputsBefore: Record<string, ScopeField>,
  ctx: WalkContext
): WalkResult {
  let outputs = { ...outputsBefore };

  for (const step of steps) {
    // Target check happens BEFORE the step runs — the step itself sees only
    // outputs from prior siblings.
    if (step.id === ctx.targetStepId) {
      const scope: Scope = {
        variables: ctx.variables,
        outputs,
      };
      if (ctx.loop) scope.loop = ctx.loop;
      return { outputs, found: scope };
    }

    const result = walkStep(step, outputs, ctx);
    if (result.found) return result;
    outputs = result.outputs;
  }

  return { outputs };
}

function walkStep(
  step: WorkflowStep,
  outputsBefore: Record<string, ScopeField>,
  ctx: WalkContext
): WalkResult {
  // Conditional: then/else branches each see outputsBefore independently,
  // and their child outputs merge into the post-step scope.
  if (step.type === 'conditional') {
    let merged = { ...outputsBefore };
    if (step.then) {
      const r = walkSteps(step.then, outputsBefore, ctx);
      if (r.found) return r;
      merged = { ...merged, ...r.outputs };
    }
    if (step.else) {
      const r = walkSteps(step.else, outputsBefore, ctx);
      if (r.found) return r;
      merged = { ...merged, ...r.outputs };
    }
    if (step.outputVariable) {
      merged[step.outputVariable] = stepOutputField(step);
    }
    return { outputs: merged };
  }

  // Parallel: each child branch sees outputsBefore (no cross-branch visibility),
  // their outputs merge after the block.
  if (step.type === 'parallel') {
    let merged = { ...outputsBefore };
    if (step.steps) {
      for (const child of step.steps) {
        const r = walkStep(child, outputsBefore, ctx);
        if (r.found) return r;
        // Each branch publishes its own outputs into the post-parallel scope.
        merged = { ...merged, ...r.outputs };
      }
    }
    if (step.outputVariable) {
      merged[step.outputVariable] = stepOutputField(step);
    }
    return { outputs: merged };
  }

  // Loop: body sees outputsBefore + loop context.
  if (step.type === 'loop') {
    // Resolve `over` against the scope at the loop's position to type the item.
    const scopeAtLoop: Scope = {
      variables: ctx.variables,
      outputs: outputsBefore,
    };
    if (ctx.loop) scopeAtLoop.loop = ctx.loop;

    let itemField: ScopeField = { type: 'unknown' };
    if (typeof step.over === 'string' && step.over) {
      // Path form: resolve against scope and read the array's element type.
      const resolved = resolveScopePath(scopeAtLoop, step.over);
      if (resolved && resolved.type === 'array' && resolved.item) {
        itemField = resolved.item;
      }
    } else if (Array.isArray(step.over) && step.over.length > 0) {
      // Inline-array form: infer the item type from the literal's first element.
      itemField = { type: scopeTypeOf(step.over[0]) };
    }
    const indexField: ScopeField = { type: 'number' };

    // Body context: variables include itemVar/indexVar if set.
    const bodyVariables = { ...ctx.variables };
    if (step.itemVar) bodyVariables[step.itemVar] = itemField;
    if (step.indexVar) bodyVariables[step.indexVar] = indexField;

    const bodyCtx: WalkContext = {
      targetStepId: ctx.targetStepId,
      variables: bodyVariables,
      loop: { item: itemField, index: indexField },
    };

    let merged = { ...outputsBefore };
    if (step.steps) {
      const r = walkSteps(step.steps, outputsBefore, bodyCtx);
      if (r.found) return r;
      merged = { ...merged, ...r.outputs };
    }
    if (step.outputVariable) {
      merged[step.outputVariable] = stepOutputField(step);
    }
    return { outputs: merged };
  }

  // Leaf step: publish outputVariable (if any).
  const outputs = { ...outputsBefore };
  if (step.outputVariable) {
    outputs[step.outputVariable] = stepOutputField(step);
  }
  return { outputs };
}

function buildVariables(workflow: WorkflowData): Record<string, ScopeField> {
  const vars: Record<string, ScopeField> = {};
  if (workflow.variables) {
    for (const [k, v] of Object.entries(workflow.variables)) {
      vars[k] = variableToField(v);
    }
  }
  return vars;
}

export function inferScope(workflow: WorkflowData, targetStepId: string): Scope {
  const variables = buildVariables(workflow);
  const ctx: WalkContext = { targetStepId, variables };
  const result = walkSteps(workflow.steps ?? [], {}, ctx);
  if (result.found) return result.found;
  // Target not found: return a scope with the workflow variables and no outputs.
  // Callers can treat this as "step doesn't exist in this workflow."
  return { variables, outputs: {} };
}

export function inferFullScope(workflow: WorkflowData): Scope {
  const variables = buildVariables(workflow);
  // Sentinel id that won't match any real step — we want the full post-walk outputs.
  const ctx: WalkContext = {
    targetStepId: '__valet_scope_inferencer_no_target__',
    variables,
  };
  const result = walkSteps(workflow.steps ?? [], {}, ctx);
  return { variables, outputs: result.outputs };
}
