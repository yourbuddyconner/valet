/**
 * Semantic validation for workflow `dag/v1` definitions.
 *
 * Structural validation lives in schema.ts (Zod). This file runs ON TOP
 * of a structurally-valid definition and enforces semantic rules:
 *
 *   - graph: cycles, dangling edge endpoints, fromOutput requirements
 *   - per-node: foreach body allowlist, foreach alias shadowing,
 *     session.prompt threadId/forceNewThread XOR, llm maxOutputTokens
 *     warning, etc.
 *   - per-template: parse and reject malformed templates at publish
 *   - per-input: validate WorkflowInputDefinition shapes against
 *     supplied values
 */

import type {
  AvailableModels,
  WorkflowDefinition,
  WorkflowEdge,
  WorkflowNode,
  WorkflowValidationError,
  WorkflowInputDefinition,
  ForeachNode,
  PromptSessionNode,
  LlmNode,
} from '@valet/shared';
import { parseTemplate, parseExpression, TemplateParseError } from './expression.js';
import { allowedIfOperations, isIfOperationSupported, normalizeIfOperation } from './if-operations.js';
import { parseDurationMs } from './duration.js';
import { parseModelId, hasProviderKey } from '../llm/model-id.js';
import {
  FOREACH_BODY_NODE_TYPES,
  LEGACY_NODE_TYPE_ALIASES,
  LEGACY_NODE_TYPE_NOTES,
  WORKFLOW_NODE_TYPES,
  workflowDefinitionSchema,
} from './schema.js';
import type { Env } from '../../env.js';

// ─── Policy ceilings (defaults; may be overridden by definition.policy) ────

const DEFAULT_MAX_NODES = 200;
const DEFAULT_MAX_CONCURRENT_NODES = 20;
const DEFAULT_MAX_WAIT_DURATION_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MAX_FOREACH_ITEMS = 100;
const DEFAULT_MAX_FOREACH_CONCURRENCY = 5;
const RESERVED_CONTEXT_NAMES = new Set(['trigger', 'inputs', 'nodes']);

// Allowed foreach body types — narrower than top-level nodes.
const FOREACH_BODY_TYPES = new Set<string>(FOREACH_BODY_NODE_TYPES);
const WORKFLOW_NODE_TYPE_SET = new Set<string>(WORKFLOW_NODE_TYPES);

// ─── Shape guard (makes validateDefinition total) ──────────────────────────

/**
 * Run the full Zod schema. This catches unknown node `type`s, malformed
 * node fields, and structural issues that the lightweight prelude
 * doesn't see. Without this, a definition with e.g. {type: 'evil'}
 * would get past validateDefinition, get cast to WorkflowNode, hit
 * dispatchNode's switch with no matching arm, and return undefined —
 * effectively letting authors publish nonsense that "succeeds" at
 * runtime.
 */
function validateDefinitionShape(def: unknown): WorkflowValidationError[] {
  const nodeTypeErrors = validateRawNodeTypes(def);
  if (nodeTypeErrors.length > 0) return nodeTypeErrors;

  const parsed = workflowDefinitionSchema.safeParse(def);
  if (parsed.success) return [];
  return parsed.error.issues.flatMap((issue) => formatShapeIssue(issue, def)).map((issue) => ({
    scope: 'workflow' as const,
    code: 'malformed_definition' as const,
    message: issue.message,
  }));
}

function validateRawNodeTypes(input: unknown): WorkflowValidationError[] {
  if (!input || typeof input !== 'object') return [];
  const nodes = (input as { nodes?: unknown }).nodes;
  if (!Array.isArray(nodes)) return [];

  const errors: WorkflowValidationError[] = [];
  for (let index = 0; index < nodes.length; index++) {
    const node = nodes[index];
    if (!node || typeof node !== 'object') continue;
    const record = node as Record<string, unknown>;
    const type = record.type;
    if (typeof type === 'string' && !WORKFLOW_NODE_TYPE_SET.has(type)) {
      errors.push(unknownNodeTypeError(type, `nodes.${index}.type`, record.id));
      continue;
    }

    if (type === 'foreach') {
      const body = record.body;
      if (!body || typeof body !== 'object') continue;
      const bodyRecord = body as Record<string, unknown>;
      const bodyType = bodyRecord.type;
      if (typeof bodyType === 'string' && !FOREACH_BODY_TYPES.has(bodyType)) {
        errors.push(unknownForeachBodyTypeError(bodyType, `nodes.${index}.body.type`, bodyRecord.id));
      }
    }
  }
  return errors;
}

function unknownNodeTypeError(type: string, path: string, rawId: unknown): WorkflowValidationError {
  const suggestion = Object.prototype.hasOwnProperty.call(LEGACY_NODE_TYPE_ALIASES, type)
    ? LEGACY_NODE_TYPE_ALIASES[type as keyof typeof LEGACY_NODE_TYPE_ALIASES]
    : undefined;
  const note = Object.prototype.hasOwnProperty.call(LEGACY_NODE_TYPE_NOTES, type)
    ? LEGACY_NODE_TYPE_NOTES[type as keyof typeof LEGACY_NODE_TYPE_NOTES]
    : undefined;
  const suffix = suggestion
    ? ` Did you mean "${suggestion}"?`
    : note ? ` ${note}` : '';
  return {
    scope: 'workflow',
    ...(typeof rawId === 'string' ? { nodeId: rawId } : {}),
    path,
    code: 'unknown_node_type',
    message: `Unknown node type "${type}". Valid types are: ${WORKFLOW_NODE_TYPES.join(', ')}.${suffix}`,
  };
}

function unknownForeachBodyTypeError(type: string, path: string, rawId: unknown): WorkflowValidationError {
  const suggestion = Object.prototype.hasOwnProperty.call(LEGACY_NODE_TYPE_ALIASES, type)
    ? LEGACY_NODE_TYPE_ALIASES[type as keyof typeof LEGACY_NODE_TYPE_ALIASES]
    : undefined;
  const suffix = suggestion && FOREACH_BODY_TYPES.has(suggestion)
    ? ` Did you mean "${suggestion}"?`
    : ' Top-level-only node types cannot be nested in foreach body.';
  return {
    scope: 'workflow',
    ...(typeof rawId === 'string' ? { nodeId: rawId } : {}),
    path,
    code: 'unknown_foreach_body_type',
    message: `foreach body type "${type}" is not allowed. Allowed foreach body types are: ${FOREACH_BODY_NODE_TYPES.join(', ')}.${suffix}`,
  };
}

type ZodLikeIssue = {
  path: Array<string | number>;
  message: string;
  code?: string;
  unionErrors?: Array<{ issues: ZodLikeIssue[] }>;
  expected?: unknown;
  received?: unknown;
};

function formatShapeIssue(issue: ZodLikeIssue, input: unknown): Array<{ message: string }> {
  if (issue.code === 'invalid_union' && issue.path.length === 2 && issue.path[0] === 'nodes' && typeof issue.path[1] === 'number') {
    const nodeIndex = issue.path[1];
    const node = getInputNode(input, nodeIndex);
    const context = formatNodeContext(nodeIndex, node);
    const branchIssues = selectNodeUnionBranchIssues(issue, node);
    if (branchIssues.length > 0) {
      return branchIssues.map((branchIssue) => {
        const relativePath = branchIssue.path.slice(issue.path.length).join('.');
        return {
          message: relativePath
            ? `${context}: ${relativePath}: ${branchIssue.message}`
            : `${context}: ${branchIssue.message}`,
        };
      });
    }
    return [{ message: `${context}: ${issue.message}` }];
  }

  const path = issue.path.length > 0 ? `${issue.path.join('.')}: ` : '';
  return [{ message: `${path}${issue.message}` }];
}

function getInputNode(input: unknown, index: number): unknown {
  if (!input || typeof input !== 'object') return undefined;
  const nodes = (input as { nodes?: unknown }).nodes;
  return Array.isArray(nodes) ? nodes[index] : undefined;
}

function formatNodeContext(index: number, node: unknown): string {
  if (!node || typeof node !== 'object') return `nodes.${index}`;
  const record = node as Record<string, unknown>;
  const id = typeof record.id === 'string' ? record.id : undefined;
  const type = typeof record.type === 'string' ? record.type : undefined;
  if (id && type) return `nodes.${index} (id: "${id}", type: "${type}")`;
  if (id) return `nodes.${index} (id: "${id}")`;
  if (type) return `nodes.${index} (type: "${type}")`;
  return `nodes.${index}`;
}

function selectNodeUnionBranchIssues(issue: ZodLikeIssue, node: unknown): ZodLikeIssue[] {
  const unionErrors = issue.unionErrors ?? [];
  const nodeType = node && typeof node === 'object' && typeof (node as Record<string, unknown>).type === 'string'
    ? (node as Record<string, unknown>).type
    : undefined;

  if (nodeType) {
    const matching = unionErrors.find((err) => !err.issues.some((branchIssue) => (
      branchIssue.path.at(-1) === 'type'
      && branchIssue.code === 'invalid_literal'
      && branchIssue.received === nodeType
    )));
    if (matching) return flattenUnionIssues(matching.issues);
  }

  const best = unionErrors
    .map((err) => flattenUnionIssues(err.issues))
    .sort((a, b) => a.length - b.length)[0];
  return best ?? [];
}

function flattenUnionIssues(issues: ZodLikeIssue[]): ZodLikeIssue[] {
  const flattened: ZodLikeIssue[] = [];
  for (const issue of issues) {
    if (issue.code === 'invalid_union' && issue.unionErrors) {
      const best = issue.unionErrors.map((err) => flattenUnionIssues(err.issues)).sort((a, b) => a.length - b.length)[0];
      flattened.push(...(best ?? [issue]));
    } else {
      flattened.push(issue);
    }
  }
  return flattened;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Validate a structurally-parsed workflow definition. Returns an array of
 * errors; an empty array means the definition can be published / executed.
 *
 * Drafts can be saved even when this returns errors; only publish and
 * execution paths must require an empty result.
 */
export function validateDefinition(input: unknown): WorkflowValidationError[] {
  // Total: never throws on malformed input. Callers do not need try/catch.
  const malformed = validateDefinitionShape(input);
  if (malformed.length > 0) return malformed;
  const def = input as WorkflowDefinition;

  const errors: WorkflowValidationError[] = [];
  const policy = def.policy ?? {};
  const foreachMaxItems = policy.maxForeachItems ?? DEFAULT_MAX_FOREACH_ITEMS;
  const foreachMaxConcurrency = policy.maxForeachConcurrency ?? DEFAULT_MAX_FOREACH_CONCURRENCY;

  // ── Per-node uniqueness and type-specific rules ─────────────────────────
  // Two distinct namespaces:
  //   - allIds: every author-declared id (top-level + foreach bodies).
  //     Used to detect duplicates because the runtime keys step.do
  //     cache, action_invocations, approval IDs, and trace rows on
  //     `${nodeId}:i:${iteration}` with no parent scoping. Two foreach
  //     nodes that both use body id `send` would replay iteration N's
  //     side effect from the first loop in the second loop.
  //   - edgeTargetIds: ONLY top-level node ids. The wave loop's compile()
  //     (workflows/runtime.ts) builds incoming/outgoing maps from
  //     def.nodes only — edges to/from a foreach body id are silently
  //     ignored, leaving downstream nodes orphaned. Reject at publish.
  const allIds = new Set<string>();
  const edgeTargetIds = new Set<string>();
  for (const node of def.nodes) {
    if (allIds.has(node.id)) {
      errors.push({ scope: 'node', nodeId: node.id, code: 'duplicate_id', message: `Duplicate node ID: ${node.id}` });
      continue;
    }
    allIds.add(node.id);
    edgeTargetIds.add(node.id);
    if (node.type === 'foreach') {
      if (allIds.has(node.body.id)) {
        errors.push({
          scope: 'node',
          nodeId: node.body.id,
          code: 'duplicate_id',
          message: `Duplicate node ID: ${node.body.id} (foreach "${node.id}" body conflicts with another node)`,
        });
      } else {
        allIds.add(node.body.id);
        // Deliberately NOT added to edgeTargetIds — body nodes are only
        // executable inside the foreach iteration loop.
      }
    }

    validateNode(node, errors, { foreachMaxItems, foreachMaxConcurrency });
  }

  // ── Edge structure ──────────────────────────────────────────────────────
  for (const edge of def.edges) {
    validateEdge(edge, def, edgeTargetIds, errors);
  }

  // ── Cycles ──────────────────────────────────────────────────────────────
  if (hasCycle(def.nodes, def.edges)) {
    errors.push({ scope: 'workflow', code: 'cycle', message: 'Workflow graph contains a cycle' });
  }

  // ── Policy ceilings ─────────────────────────────────────────────────────
  const maxNodes = policy.maxNodes ?? DEFAULT_MAX_NODES;
  if (def.nodes.length > maxNodes) {
    errors.push({
      scope: 'workflow',
      code: 'max_nodes_exceeded',
      message: `Workflow has ${def.nodes.length} nodes; policy allows ${maxNodes}`,
    });
  }

  // ── Worst-case instance lifetime ────────────────────────────────────────
  // Naive sum of wait timeouts. Conservative — assumes worst case all waits
  // execute sequentially. Cloudflare's max instance lifetime is not exposed
  // here as a constant; gated by the policy max-wait-duration.
  const maxWaitMs = policy.maxWaitDurationMs ?? DEFAULT_MAX_WAIT_DURATION_MS;
  for (const node of def.nodes) {
    if (node.type === 'wait') {
      const ms = parseDurationMs(node.duration);
      if (ms === null) {
        errors.push({ scope: 'node', nodeId: node.id, code: 'wait_duration_unparseable', message: `Cannot parse duration "${node.duration}"` });
      } else if (ms > maxWaitMs) {
        errors.push({
          scope: 'node',
          nodeId: node.id,
          code: 'wait_duration_exceeds_policy',
          message: `Wait of ${ms}ms exceeds policy ceiling ${maxWaitMs}ms`,
        });
      }
    }
  }

  return errors;
}

export interface GroupedWorkflowValidation {
  errors: WorkflowValidationError[];
  warnings: WorkflowValidationError[];
}

export function groupWorkflowValidationResults(results: WorkflowValidationError[]): GroupedWorkflowValidation {
  const warnings = results.filter((result) => isValidationWarning(result));
  const errors = results.filter((result) => !isValidationWarning(result));
  return { errors, warnings };
}

function isValidationWarning(result: WorkflowValidationError): boolean {
  return result.code === 'llm_maxoutput_warning';
}

/**
 * Validate provided trigger payload + override inputs against the
 * workflow's `inputs` declarations. Returns the validated input map
 * (with defaults applied) on success, or an array of errors.
 */
export function validateInputs(
  def: WorkflowDefinition,
  provided: Record<string, unknown>,
): { ok: true; inputs: Record<string, unknown> } | { ok: false; errors: WorkflowValidationError[] } {
  const errors: WorkflowValidationError[] = [];
  const out: Record<string, unknown> = {};

  const declared = def.inputs ?? {};

  // No `inputs` declared → return an empty inputs map. Authors who
  // didn't opt into typed inputs can still read the trigger payload
  // via `{{trigger.data.x}}`; we deliberately do NOT mirror the whole
  // provided blob into `state.inputs` (and thus into the audit row),
  // because webhook payloads can carry PII / large data that wasn't
  // explicitly declared as a workflow input.
  if (Object.keys(declared).length === 0) {
    return { ok: true, inputs: {} };
  }

  // Check declared inputs against provided values.
  for (const [name, spec] of Object.entries(declared)) {
    const value = provided[name];
    if (value === undefined || value === null) {
      if (spec.required) {
        errors.push({
          scope: 'input',
          inputName: name,
          code: 'input_required_missing',
          message: `Required input "${name}" is missing`,
        });
        continue;
      }
      if (spec.default !== undefined) {
        out[name] = spec.default;
      }
      continue;
    }

    const typeErr = validateInputType(name, value, spec);
    if (typeErr) {
      errors.push(typeErr);
      continue;
    }

    if (spec.enum && !spec.enum.some((allowed) => deepEqual(allowed, value))) {
      errors.push({
        scope: 'input',
        inputName: name,
        code: 'input_not_in_enum',
        message: `Input "${name}" value not in declared enum`,
      });
      continue;
    }

    out[name] = value;
  }

  // Reject inputs not declared in the workflow's `inputs` schema. A typo
  // ('prioirty' vs declared 'priority') should fail loudly rather than be
  // silently dropped or silently passed through with a missing default.
  // Trigger payloads themselves are NOT validated here — only when a
  // workflow explicitly declares inputs.
  for (const name of Object.keys(provided)) {
    if (!(name in declared)) {
      errors.push({
        scope: 'input',
        inputName: name,
        code: 'input_unknown',
        message: `Input "${name}" is not declared in the workflow's inputs schema`,
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, inputs: out };
}

// ─── Internal helpers ───────────────────────────────────────────────────────

interface ForeachLimits {
  foreachMaxItems: number;
  foreachMaxConcurrency: number;
}

function validateNode(
  node: WorkflowNode,
  errors: WorkflowValidationError[],
  limits: ForeachLimits = { foreachMaxItems: DEFAULT_MAX_FOREACH_ITEMS, foreachMaxConcurrency: DEFAULT_MAX_FOREACH_CONCURRENCY },
): void {
  switch (node.type) {
    case 'llm':
      validateLlm(node, errors);
      validateNodeTemplates(node, ['system', 'prompt'], errors);
      break;
    case 'if':
      // Conditions are pure values; no templates here. left fields use
      // path syntax which we validate as expressions.
      for (const cond of node.conditions) {
        tryParseExpression(node.id, 'left', cond.left, errors);
        const operation = normalizeIfOperation(cond.operation);
        if (!isIfOperationSupported(cond.dataType, cond.operation)) {
          errors.push({
            scope: 'field',
            nodeId: node.id,
            path: 'conditions.operation',
            code: 'if_operation_unsupported',
            message: `Unsupported ${cond.dataType} operation "${cond.operation}". Allowed operations: ${allowedIfOperations(cond.dataType).join(', ')}`,
          });
        }
        if (operation === 'matchesRegex' && typeof cond.right === 'string') {
          try {
            new RegExp(cond.right);
          } catch (err) {
            errors.push({
              scope: 'field',
              nodeId: node.id,
              path: 'conditions.right',
              code: 'invalid_regex',
              message: `matchesRegex pattern is not a valid regular expression: ${err instanceof Error ? err.message : String(err)}`,
            });
          }
        }
      }
      break;
    case 'foreach':
      validateForeach(node, errors, limits);
      break;
    case 'approval':
      validateNodeTemplates(node, ['prompt', 'summary'], errors);
      break;
    case 'wait':
      // wait.mode is locked to 'duration' by the schema; nothing more here
      // except duration parse (handled in validateDefinition for the
      // policy ceiling check).
      break;
    case 'set':
      // values is arbitrary JSON; templates within it are validated
      // lazily at execution time. Static template parse here catches
      // obvious malformations.
      validateJsonTemplates(node.id, node.values, errors);
      break;
    case 'stop':
      if (node.message !== undefined) {
        tryParseTemplate(node.id, 'message', node.message, errors);
      }
      validateJsonTemplates(node.id, node.output, errors);
      break;
    case 'tool':
      validateNodeTemplates(node, ['summary'], errors);
      validateJsonTemplates(node.id, node.params, errors);
      break;
    case 'orchestrator':
      validateNodeTemplates(node, ['prompt'], errors);
      break;
    case 'session':
      if (node.mode === 'start') {
        validateNodeTemplates(node, ['prompt', 'workspace', 'title'], errors);
      } else {
        validateSessionPrompt(node, errors);
      }
      break;
  }
}

function validateLlm(node: LlmNode, errors: WorkflowValidationError[]): void {
  if (node.maxOutputTokens === undefined) {
    // Spec: validator should warn (not error) at publish time. We surface
    // as a warning-coded error so the editor can flag it without blocking
    // publish; the publish API treats `llm_maxoutput_warning` as
    // non-blocking.
    errors.push({
      scope: 'node',
      nodeId: node.id,
      code: 'llm_maxoutput_warning',
      message: `llm node "${node.id}" has no maxOutputTokens; oversize outputs will fail at runtime`,
    });
  }
}

function validateForeach(node: ForeachNode, errors: WorkflowValidationError[], limits: ForeachLimits): void {
  // items must be a single-expression template, i.e. exactly one
  // {{ expr }} with no surrounding text. Mixed text always renders to a
  // string and a bare path without {{ }} renders as the literal string —
  // both fail the runtime's "must be an array" check, so reject at
  // publish instead of letting the workflow blow up at execution time.
  const itemsAst = (() => {
    try {
      return parseTemplate(node.items);
    } catch (err) {
      errors.push({
        scope: 'field',
        nodeId: node.id,
        path: 'items',
        code: 'template_parse_error',
        message: err instanceof TemplateParseError ? err.message : 'parse failure',
      });
      return null;
    }
  })();
  if (itemsAst && !itemsAst.isSingle) {
    const hasExpr = itemsAst.segments.some((s) => s.kind === 'expr');
    errors.push({
      scope: 'field',
      nodeId: node.id,
      path: 'items',
      code: 'foreach_items_not_expression',
      message: hasExpr
        ? `foreach "${node.id}" items must be a single {{ expression }} (no surrounding text); mixed templates render to a string`
        : `foreach "${node.id}" items must be a {{ expression }} that resolves to an array (got a bare string)`,
    });
  }

  // Body type allowlist.
  if (!FOREACH_BODY_TYPES.has(node.body.type)) {
    errors.push({
      scope: 'node',
      nodeId: node.id,
      code: 'foreach_body_type_disallowed',
      message: `foreach body type "${node.body.type}" is not allowed; permitted: ${[...FOREACH_BODY_TYPES].join(', ')}`,
    });
  }

  // Recursively validate the body node. ForeachBodyNode is a subset of
  // WorkflowNode so this typechecks without a cast.
  validateNode(node.body, errors, limits);

  // Alias shadowing check.
  const itemAlias = node.itemAlias ?? 'item';
  const indexAlias = node.indexAlias ?? 'index';
  if (RESERVED_CONTEXT_NAMES.has(itemAlias)) {
    errors.push({
      scope: 'node',
      nodeId: node.id,
      code: 'foreach_alias_shadows_reserved',
      message: `foreach itemAlias "${itemAlias}" shadows a reserved context name`,
    });
  }
  if (RESERVED_CONTEXT_NAMES.has(indexAlias)) {
    errors.push({
      scope: 'node',
      nodeId: node.id,
      code: 'foreach_alias_shadows_reserved',
      message: `foreach indexAlias "${indexAlias}" shadows a reserved context name`,
    });
  }
  if (itemAlias === indexAlias) {
    errors.push({
      scope: 'node',
      nodeId: node.id,
      code: 'foreach_aliases_collide',
      message: `foreach itemAlias and indexAlias must differ`,
    });
  }

  // maxItems and concurrency ceilings — honour the workflow's policy
  // overrides if provided, falling back to the global defaults.
  const cap = node.maxItems ?? limits.foreachMaxItems;
  if (cap > limits.foreachMaxItems) {
    errors.push({
      scope: 'node',
      nodeId: node.id,
      code: 'foreach_max_items_exceeds_policy',
      message: `foreach maxItems ${cap} exceeds policy ceiling ${limits.foreachMaxItems}`,
    });
  }
  const conc = node.concurrency ?? 1;
  if (conc > limits.foreachMaxConcurrency) {
    errors.push({
      scope: 'node',
      nodeId: node.id,
      code: 'foreach_concurrency_exceeds_policy',
      message: `foreach concurrency ${conc} exceeds policy ceiling ${limits.foreachMaxConcurrency}`,
    });
  }
}

function validateSessionPrompt(node: PromptSessionNode, errors: WorkflowValidationError[]): void {
  if (node.threadId !== undefined && node.forceNewThread === true) {
    errors.push({
      scope: 'node',
      nodeId: node.id,
      code: 'session_thread_targeting_xor',
      message: `session.prompt cannot set both threadId and forceNewThread`,
    });
  }
  validateNodeTemplates(node, ['prompt', 'sessionId', 'threadId'], errors);
}

function validateEdge(
  edge: WorkflowEdge,
  def: WorkflowDefinition,
  ids: Set<string>,
  errors: WorkflowValidationError[],
): void {
  if (!ids.has(edge.from)) {
    errors.push({
      scope: 'edge',
      code: 'edge_from_unknown',
      message: `Edge from unknown node "${edge.from}"`,
    });
    return;
  }
  if (!ids.has(edge.to)) {
    errors.push({
      scope: 'edge',
      code: 'edge_to_unknown',
      message: `Edge to unknown node "${edge.to}"`,
    });
    return;
  }
  if (edge.from === edge.to) {
    errors.push({
      scope: 'edge',
      code: 'edge_self_loop',
      message: `Edge cannot connect a node to itself (${edge.from})`,
    });
  }

  const fromNode = def.nodes.find((n) => n.id === edge.from);
  if (!fromNode) return;

  if (fromNode.type === 'if') {
    if (edge.fromOutput !== 'true' && edge.fromOutput !== 'false') {
      errors.push({
        scope: 'edge',
        code: 'if_edge_missing_fromOutput',
        message: `Edge leaving if node "${edge.from}" must declare fromOutput "true" or "false"`,
      });
    }
  } else if (edge.fromOutput !== undefined) {
    errors.push({
      scope: 'edge',
      code: 'fromOutput_on_non_if',
      message: `fromOutput is only valid for edges leaving an if node`,
    });
  }

  if (fromNode.type === 'stop') {
    errors.push({
      scope: 'edge',
      code: 'edge_from_stop',
      message: `stop node "${edge.from}" cannot have outgoing edges`,
    });
  }

  if (edge.when !== undefined) {
    try {
      parseExpression(edge.when);
    } catch (err) {
      const msg = err instanceof TemplateParseError ? err.message : 'parse failure';
      errors.push({
        scope: 'edge',
        code: 'edge_when_unparseable',
        message: `Edge "when" predicate is invalid: ${msg}`,
      });
    }
  }
}

function hasCycle(nodes: WorkflowNode[], edges: WorkflowEdge[]): boolean {
  const adj = new Map<string, string[]>();
  for (const node of nodes) adj.set(node.id, []);
  for (const edge of edges) {
    if (adj.has(edge.from)) adj.get(edge.from)!.push(edge.to);
  }

  const WHITE = 0, GRAY = 1, BLACK = 2;
  const color = new Map<string, number>();
  for (const node of nodes) color.set(node.id, WHITE);

  function dfs(id: string): boolean {
    const c = color.get(id);
    if (c === GRAY) return true;
    if (c === BLACK) return false;
    color.set(id, GRAY);
    for (const next of adj.get(id) ?? []) {
      if (dfs(next)) return true;
    }
    color.set(id, BLACK);
    return false;
  }

  for (const node of nodes) {
    if (color.get(node.id) === WHITE && dfs(node.id)) return true;
  }
  return false;
}

// ─── Template parsing helpers ───────────────────────────────────────────────

function validateNodeTemplates<N extends WorkflowNode>(
  node: N,
  fields: ReadonlyArray<keyof N & string>,
  errors: WorkflowValidationError[],
): void {
  for (const field of fields) {
    const raw: unknown = node[field];
    if (typeof raw === 'string') {
      tryParseTemplate(node.id, field, raw, errors);
    }
  }
}

function tryParseTemplate(
  nodeId: string,
  field: string,
  source: string,
  errors: WorkflowValidationError[],
): void {
  try {
    parseTemplate(source);
  } catch (err) {
    const msg = formatTemplateParseError(source, err);
    errors.push({
      scope: 'field',
      nodeId,
      path: field,
      code: 'template_parse_error',
      message: msg,
    });
  }
}

function tryParseExpression(
  nodeId: string,
  field: string,
  source: string,
  errors: WorkflowValidationError[],
): void {
  try {
    parseExpression(source);
  } catch (err) {
    const msg = formatExpressionParseError(source, err);
    errors.push({
      scope: 'field',
      nodeId,
      path: field,
      code: 'expression_parse_error',
      message: msg,
    });
  }
}

function formatTemplateParseError(source: string, err: unknown): string {
  return appendHyphenatedNodeIdHint(source, err instanceof TemplateParseError ? err.message : 'parse failure');
}

function formatExpressionParseError(source: string, err: unknown): string {
  return appendHyphenatedNodeIdHint(source, err instanceof TemplateParseError ? err.message : 'parse failure');
}

function appendHyphenatedNodeIdHint(source: string, message: string): string {
  const match = source.match(/\bnodes\.([A-Za-z_][A-Za-z0-9_]*-[A-Za-z0-9_-]*)/);
  if (!match) return message;
  const nodeId = match[1];
  return `${message}. Node IDs containing "-" must use bracket notation in expressions, e.g. nodes["${nodeId}"].data.field`;
}

function validateJsonTemplates(nodeId: string, value: unknown, errors: WorkflowValidationError[]): void {
  if (typeof value === 'string') {
    tryParseTemplate(nodeId, 'value', value, errors);
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) validateJsonTemplates(nodeId, v, errors);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) validateJsonTemplates(nodeId, v, errors);
  }
}

function validateInputType(
  name: string,
  value: unknown,
  spec: WorkflowInputDefinition,
): WorkflowValidationError | null {
  const actual = typeof value;
  const ok = (() => {
    switch (spec.type) {
      case 'string': return actual === 'string';
      case 'number': return actual === 'number';
      case 'boolean': return actual === 'boolean';
      case 'object': return value !== null && actual === 'object' && !Array.isArray(value);
      case 'array': return Array.isArray(value);
    }
  })();
  if (!ok) {
    return {
      scope: 'input',
      inputName: name,
      code: 'input_type_mismatch',
      message: `Input "${name}" expected ${spec.type}, got ${Array.isArray(value) ? 'array' : actual}`,
    };
  }
  return null;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a === 'object') {
    if (Array.isArray(a) || Array.isArray(b)) {
      if (!Array.isArray(a) || !Array.isArray(b)) return false;
      if (a.length !== b.length) return false;
      return a.every((v, i) => deepEqual(v, b[i]));
    }
    const ao = a as Record<string, unknown>;
    const bo = b as Record<string, unknown>;
    const ak = Object.keys(ao);
    const bk = Object.keys(bo);
    if (ak.length !== bk.length) return false;
    return ak.every((k) => deepEqual(ao[k], bo[k]));
  }
  return false;
}

// parseDurationMs lives in ./duration.ts so both the validator and the
// wait executor (which converts to ms for step.sleep) share one parser.

// ─── Environment-dependent validation ───────────────────────────────────────

/**
 * Env-dependent checks: invoked by publish + execution-create paths
 * AFTER validateDefinition succeeds. Catches mistakes that depend on
 * runtime configuration (e.g. an llm node referencing a provider whose
 * API key isn't set on this worker).
 *
 * Kept separate from validateDefinition so the structural validator
 * stays pure and unit-testable without env stubbing.
 */
export function validateAgainstEnvironment(
  input: unknown,
  env: Env,
  options: { availableModels?: AvailableModels | null } = {},
): WorkflowValidationError[] {
  // Total — no-op when the shape is malformed (callers use
  // validateDefinition for the structural complaint).
  const shape = validateDefinitionShape(input);
  if (shape.length > 0) return [];
  const def = input as WorkflowDefinition;
  const errors: WorkflowValidationError[] = [];
  const modelLookup = options.availableModels ? buildAvailableModelLookup(options.availableModels) : null;
  for (const node of def.nodes) {
    collectEnvErrors(node, env, errors, modelLookup);
  }
  return errors;
}

export function validateAgainstAvailableModels(
  input: unknown,
  availableModels: AvailableModels,
): WorkflowValidationError[] {
  const shape = validateDefinitionShape(input);
  if (shape.length > 0) return [];
  const lookup = buildAvailableModelLookup(availableModels);
  const def = input as WorkflowDefinition;
  const errors: WorkflowValidationError[] = [];
  for (const node of def.nodes) {
    collectModelAvailabilityErrors(node, errors, lookup);
  }
  return errors;
}

interface AvailableModelLookup {
  ids: Set<string>;
  byProvider: Map<string, string[]>;
}

function buildAvailableModelLookup(availableModels: AvailableModels): AvailableModelLookup {
  const ids = new Set<string>();
  const byProvider = new Map<string, string[]>();

  for (const provider of availableModels) {
    for (const model of provider.models) {
      ids.add(model.id);
      const slash = model.id.indexOf('/');
      if (slash <= 0) continue;
      const providerId = model.id.slice(0, slash);
      const existing = byProvider.get(providerId) ?? [];
      existing.push(model.id);
      byProvider.set(providerId, existing);
    }
  }

  return { ids, byProvider };
}

function workflowModelToCatalogId(modelId: string): { provider: string; catalogId: string } {
  const { provider, model } = parseModelId(modelId);
  return { provider, catalogId: `${provider}/${model}` };
}

function catalogIdToWorkflowId(catalogId: string): string {
  const slash = catalogId.indexOf('/');
  if (slash <= 0) return catalogId;
  return `${catalogId.slice(0, slash)}:${catalogId.slice(slash + 1)}`;
}

function collectEnvErrors(
  node: WorkflowNode,
  env: Env,
  errors: WorkflowValidationError[],
  modelLookup: AvailableModelLookup | null,
): void {
  if (node.type === 'llm') {
    if (!node.model) {
      errors.push({
        scope: 'node',
        nodeId: node.id,
        code: 'llm_model_missing',
        message: `llm node "${node.id}" has no model configured`,
      });
      return;
    }
    try {
      const { provider } = parseModelId(node.model);
      if (!hasProviderKey(env, provider)) {
        errors.push({
          scope: 'node',
          nodeId: node.id,
          code: 'llm_provider_key_missing',
          message: `llm node "${node.id}" uses provider "${provider}" but its API key is not configured`,
        });
      }
      if (modelLookup) {
        collectModelAvailabilityErrors(node, errors, modelLookup);
      }
    } catch (err) {
      errors.push({
        scope: 'node',
        nodeId: node.id,
        code: 'llm_model_id_invalid',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // tool nodes are NOT validated at publish time. Built-in integrations
  // can be checked via integrationRegistry.getPackage, but custom MCP
  // connectors are user-scoped and only resolvable with a context this
  // validator doesn't have. To avoid blocking legitimate custom-MCP
  // workflows with a false positive, the runtime now handles the
  // "unknown service" case loudly at execution time. Re-enable a
  // publish-time check once the validator accepts a CustomMcpConnectorContext.
  if (node.type === 'foreach') {
    collectEnvErrors(node.body as WorkflowNode, env, errors, modelLookup);
  }
}

function collectModelAvailabilityErrors(
  node: WorkflowNode,
  errors: WorkflowValidationError[],
  modelLookup: AvailableModelLookup,
): void {
  if (node.type === 'llm') {
    if (!node.model) return;
    try {
      const { provider, catalogId } = workflowModelToCatalogId(node.model);
      const providerModels = modelLookup.byProvider.get(provider);
      if (!providerModels || providerModels.length === 0) return;
      if (modelLookup.ids.has(catalogId)) return;

      const suggestions = providerModels
        .slice(0, 8)
        .map(catalogIdToWorkflowId)
        .join(', ');
      errors.push({
        scope: 'node',
        nodeId: node.id,
        path: 'model',
        code: 'llm_model_unavailable',
        message: `llm node "${node.id}" uses model "${node.model}", but it is not in the configured model catalog for provider "${provider}".${suggestions ? ` Available models include: ${suggestions}` : ''}`,
      });
    } catch (err) {
      errors.push({
        scope: 'node',
        nodeId: node.id,
        path: 'model',
        code: 'llm_model_id_invalid',
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (node.type === 'foreach') {
    collectModelAvailabilityErrors(node.body as WorkflowNode, errors, modelLookup);
  }
}
