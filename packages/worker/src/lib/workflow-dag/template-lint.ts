/**
 * Template-reference lint. Warns when a `{{...}}` expression reads a
 * path that the definition can't prove exists — e.g.
 * `{{trigger.data.todayStart}}` when the trigger has no `dataSchema`
 * declaring `todayStart`, or `{{nodes.foo.data.bar}}` when the `llm`
 * node `foo` declares an `outputSchema` that lacks `bar`.
 *
 * The client-side editor performs an equivalent check via
 * `deriveWorkflowOutputSources` + `validateTemplateTags`, but until now
 * those checks never made it to the server, so agents driving the
 * workflow tools (workflows.validate, workflows.save_draft) could not
 * see them and shipped workflows the human UI immediately flagged.
 *
 * Emitted as WARNINGS (`template_unknown_variable`), not errors: the
 * runtime tolerates undeclared paths (they render as `undefined` and
 * mixed templates stringify), so making these hard errors would break
 * real workflows that use dynamic trigger payloads. Warnings surface
 * the signal without blocking publish.
 *
 * Scope: only warns when the *root* of the referenced path is one we
 * can positively introspect — trigger (always), and `nodes.<id>` for
 * nodes whose output shape we know (set / llm+schema / session+schema /
 * orchestrator+schema / tool+context-schema). References into
 * opaque nodes (tool without schema in context) are silent — we can't
 * tell right from wrong there.
 */

import type {
  WorkflowDefinition,
  WorkflowNode,
  WorkflowValidationError,
  TriggerNode,
  LlmNode,
  SetNode,
  OrchestratorNode,
  SessionNode,
  StartSessionNode,
  PromptSessionNode,
  ForeachNode,
  ToolNode,
} from '@valet/shared';
import { parseExpression, parseTemplate } from './expression.js';

/**
 * Structural mirror of validator.ts's TemplateLintContext.
 * Kept local to avoid a circular import: validator.ts calls into this
 * module, so we can't import from validator.ts here.
 */
export interface TemplateLintContext {
  toolOutputSchemas?: Record<string, Record<string, unknown> | undefined>;
}

export const TEMPLATE_UNKNOWN_VARIABLE_CODE = 'template_unknown_variable';

interface KnownOutputs {
  /** Dotted paths that resolve to concrete values (leaves and typed branches). */
  paths: Set<string>;
  /**
   * Node ids whose output shape is opaque to us — references starting
   * with `nodes.<id>` should be tolerated even if we can't prove the
   * child path exists.
   */
  opaqueNodes: Set<string>;
  /**
   * Dotted-path prefixes past which we can't type-check further —
   * schemas with `additionalProperties: true` or an `object` type
   * without declared `properties`. Any ref starting with this prefix
   * (plus `.`) should stay silent.
   */
  opaquePathPrefixes: Set<string>;
  /**
   * True when the trigger has no dataSchema. Still emits a warning per
   * ref (matches the editor's strict UX) but with a targeted hint
   * pointing at the fix: declare a dataSchema on the trigger node.
   */
  triggerDataOpaque: boolean;
  /**
   * All identifiers usable as foreach iteration roots — default
   * `item` / `index` plus any per-foreach overrides via
   * `itemAlias` / `indexAlias`. Referenced anywhere in the workflow;
   * we don't currently scope by iteration body since the parser
   * doesn't tell us which template lives inside which foreach.
   */
  foreachAliases: Set<string>;
}

export function lintTemplateReferences(
  def: WorkflowDefinition,
  context: TemplateLintContext = {},
): WorkflowValidationError[] {
  const errors: WorkflowValidationError[] = [];
  const known = buildKnownOutputs(def, context);

  for (const node of def.nodes) {
    lintNode(node, known, errors);
    if (node.type === 'foreach') {
      lintNode(node.body, known, errors);
    }
  }

  return errors;
}

function buildKnownOutputs(
  def: WorkflowDefinition,
  context: TemplateLintContext,
): KnownOutputs {
  const paths = new Set<string>();
  const opaqueNodes = new Set<string>();
  const opaquePathPrefixes = new Set<string>();
  const foreachAliases = new Set<string>(['item', 'index']);
  let triggerDataOpaque = false;

  // Static trigger shape — always available.
  paths.add('trigger');
  paths.add('trigger.type');
  paths.add('trigger.timestamp');
  paths.add('trigger.data');
  paths.add('trigger.metadata');

  const triggerNode = def.nodes.find((n): n is TriggerNode => n.type === 'trigger');
  const dataSchema = triggerNode?.dataSchema ?? {};
  if (Object.keys(dataSchema).length === 0) {
    triggerDataOpaque = true;
  } else {
    for (const field of Object.keys(dataSchema)) {
      paths.add(`trigger.data.${field}`);
    }
  }

  for (const node of def.nodes) {
    if (node.type === 'trigger') continue;
    if (node.type === 'if' || node.type === 'wait' || node.type === 'approval' || node.type === 'stop') {
      // Control-flow nodes don't produce readable outputs authors reference.
      continue;
    }
    // `nodes.<id>` and `nodes.<id>.data` are always readable.
    paths.add(`nodes.${node.id}`);
    paths.add(`nodes.${node.id}.data`);

    switch (node.type) {
      case 'set':
        for (const key of Object.keys(asRecord((node as SetNode).values))) {
          paths.add(`nodes.${node.id}.data.${key}`);
        }
        break;
      case 'llm': {
        const schema = (node as LlmNode).outputSchema as Record<string, unknown> | undefined;
        if (schema) {
          addSchemaPaths(paths, `nodes.${node.id}.data`, schema, opaquePathPrefixes);
        } else {
          paths.add(`nodes.${node.id}.data.response`);
        }
        break;
      }
      case 'orchestrator': {
        const orch = node as OrchestratorNode;
        paths.add(`nodes.${node.id}.data.status`);
        if (orch.wait?.mode === 'until_idle') {
          paths.add(`nodes.${node.id}.data.output`);
          if (orch.outputSchema) {
            addSchemaPaths(paths, `nodes.${node.id}.data.output`, orch.outputSchema as Record<string, unknown>, opaquePathPrefixes);
          }
          if (orch.resultMode === 'transcript') {
            paths.add(`nodes.${node.id}.data.transcript`);
          }
        }
        break;
      }
      case 'session': {
        const sess = node as SessionNode;
        paths.add(`nodes.${node.id}.data.status`);
        if (sess.mode === 'start') paths.add(`nodes.${node.id}.data.sessionId`);
        const withWait = sess as StartSessionNode | PromptSessionNode;
        if (withWait.wait?.mode === 'until_idle') {
          paths.add(`nodes.${node.id}.data.output`);
          if (withWait.outputSchema) {
            addSchemaPaths(paths, `nodes.${node.id}.data.output`, withWait.outputSchema as Record<string, unknown>, opaquePathPrefixes);
          }
          if (withWait.resultMode === 'transcript') {
            paths.add(`nodes.${node.id}.data.transcript`);
          }
        }
        break;
      }
      case 'foreach': {
        paths.add(`nodes.${node.id}.data.items`);
        // Individual iteration results aren't stable dotted paths.
        // Record any user-overridden loop-body aliases so refs like
        // `{{row.name}}` under `itemAlias: 'row'` don't false-positive.
        const foreachNode = node as ForeachNode;
        if (foreachNode.itemAlias) foreachAliases.add(foreachNode.itemAlias);
        if (foreachNode.indexAlias) foreachAliases.add(foreachNode.indexAlias);
        break;
      }
      case 'tool': {
        const tool = node as ToolNode;
        const schema = context.toolOutputSchemas?.[`${tool.service}:${tool.action}`];
        if (schema) {
          addSchemaPaths(paths, `nodes.${node.id}.data`, schema, opaquePathPrefixes);
        } else {
          // Server does not currently load the tool catalog for validate
          // calls; treat unknown tool outputs as opaque so we don't spam
          // warnings on real workflows referencing MCP-defined outputs.
          opaqueNodes.add(node.id);
        }
        break;
      }
    }
  }

  return { paths, opaqueNodes, opaquePathPrefixes, triggerDataOpaque, foreachAliases };
}

function addSchemaPaths(
  out: Set<string>,
  basePath: string,
  schema: Record<string, unknown>,
  opaqueBases: Set<string>,
): void {
  const schemaType = getSchemaType(schema);
  out.add(basePath);
  if (schemaType !== 'object') return;
  // An object schema that either allows extra properties or declares
  // none is opaque: we can't tell if `basePath.anything` is valid, so
  // record the base as opaque and don't warn on child refs.
  const properties = schema.properties;
  const propertiesTyped = properties && typeof properties === 'object' && !Array.isArray(properties)
    ? (properties as Record<string, unknown>)
    : undefined;
  if (schema.additionalProperties === true || !propertiesTyped) {
    opaqueBases.add(basePath);
    return;
  }
  for (const [key, child] of Object.entries(propertiesTyped)) {
    const childPath = `${basePath}.${key}`;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
      addSchemaPaths(out, childPath, child as Record<string, unknown>, opaqueBases);
    } else {
      out.add(childPath);
    }
  }
}

function getSchemaType(schema: Record<string, unknown>): string | undefined {
  const raw = schema.type;
  if (Array.isArray(raw)) return raw.find((t): t is string => typeof t === 'string' && t !== 'null');
  return typeof raw === 'string' ? raw : undefined;
}

function lintNode(
  node: WorkflowNode | ForeachNode['body'],
  known: KnownOutputs,
  errors: WorkflowValidationError[],
): void {
  const emit = (field: string, path: string): void => {
    const hint = classifyPath(path, known);
    if (hint !== null) {
      errors.push({
        scope: 'field',
        nodeId: node.id,
        path: field,
        code: TEMPLATE_UNKNOWN_VARIABLE_CODE,
        message: `Unknown template variable: ${path}${hint}`,
      });
    }
  };

  for (const [field, source] of iterateTemplatedFields(node)) {
    for (const path of extractPathReferences(source)) emit(field, path);
  }

  // `if` conditions use raw expression syntax (no `{{}}` braces). The
  // existing validator's `tryParseExpression` checks that `left` parses
  // but not whether the referenced path resolves to a known output —
  // that's the gap this covers so authors don't ship conditions
  // pointing at typoed or non-upstream refs.
  if (node.type === 'if') {
    for (const [idx, cond] of node.conditions.entries()) {
      const source = typeof cond.left === 'string' ? cond.left : '';
      if (!source) continue;
      let ast;
      try {
        ast = parseExpression(source);
      } catch {
        continue; // Parse errors are surfaced by validator.ts's tryParseExpression.
      }
      const paths: string[] = [];
      collectPaths(ast, paths);
      for (const path of paths) emit(`conditions[${idx}].left`, path);
    }
  }
}

/**
 * Yield every template-bearing field on a node as `[fieldName, rawSource]`.
 * Mirrors the field list used by validator.ts's syntax checks so lint
 * coverage matches parse coverage.
 */
function* iterateTemplatedFields(node: WorkflowNode | ForeachNode['body']): Iterable<[string, string]> {
  const emit = (field: string, value: unknown): Iterable<[string, string]> => {
    if (typeof value === 'string') return [[field, value]];
    return [];
  };

  switch (node.type) {
    case 'trigger':
    case 'wait':
      return;
    case 'llm':
      yield* emit('system', node.system);
      yield* emit('prompt', node.prompt);
      return;
    case 'approval':
      yield* emit('prompt', node.prompt);
      yield* emit('summary', node.summary);
      return;
    case 'set':
      yield* iterateJsonTemplates('values', node.values);
      return;
    case 'stop':
      if (node.message !== undefined) yield* emit('message', node.message);
      yield* iterateJsonTemplates('output', node.output);
      return;
    case 'tool':
      yield* emit('summary', node.summary);
      yield* iterateJsonTemplates('params', node.params);
      return;
    case 'orchestrator':
      yield* emit('prompt', node.prompt);
      return;
    case 'session':
      yield* emit('prompt', node.prompt);
      if (node.mode === 'start') {
        yield* emit('workspace', node.workspace);
        yield* emit('title', node.title);
      }
      return;
    case 'foreach':
      yield* emit('items', node.items);
      return;
    case 'if':
      // if.left uses expression syntax (not template syntax) so it's
      // linted by the existing tryParseExpression path; skip here.
      return;
  }
}

function* iterateJsonTemplates(field: string, value: unknown): Iterable<[string, string]> {
  if (typeof value === 'string') {
    yield [field, value];
    return;
  }
  if (Array.isArray(value)) {
    for (const v of value) yield* iterateJsonTemplates(field, v);
    return;
  }
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) yield* iterateJsonTemplates(field, v);
  }
}

/**
 * Extract every dotted path referenced by a template string. Returns
 * canonicalized dot-notation (bracket notation collapsed to dots).
 * Templates that don't parse are silently skipped — the syntax check
 * elsewhere already emits `template_parse_error` for those.
 */
function extractPathReferences(source: string): string[] {
  let parsed;
  try {
    parsed = parseTemplate(source);
  } catch {
    return [];
  }
  const out: string[] = [];
  for (const seg of parsed.segments) {
    if (seg.kind !== 'expr' || !seg.ast) continue;
    collectPaths(seg.ast, out);
  }
  return out;
}

// Local view of the expression AST — the concrete type is not exported.
type ExprLike =
  | { kind: 'literal' }
  | { kind: 'path'; segments: string[] }
  | { kind: 'exists'; segments: string[] }
  | { kind: 'unary'; operand: ExprLike }
  | { kind: 'binary'; left: ExprLike; right: ExprLike };

function collectPaths(ast: unknown, out: string[]): void {
  if (!ast || typeof ast !== 'object') return;
  const node = ast as ExprLike;
  switch (node.kind) {
    case 'path':
    case 'exists':
      out.push(node.segments.join('.'));
      return;
    case 'unary':
      collectPaths(node.operand, out);
      return;
    case 'binary':
      collectPaths(node.left, out);
      collectPaths(node.right, out);
      return;
    default:
      return;
  }
}

/**
 * Return a hint string when the path is provably unknown, or null when
 * the path is either known or opaque enough to tolerate silently.
 */
function classifyPath(path: string, known: KnownOutputs): string | null {
  if (known.paths.has(path)) return null;
  if (hasOpaquePrefix(path, known.opaquePathPrefixes)) return null;

  const root = path.split('.')[0];
  if (!root) return null;
  if (known.foreachAliases.has(root)) return null;

  if (root === 'trigger') {
    if (known.triggerDataOpaque && (path === 'trigger.data' || path.startsWith('trigger.data.'))) {
      // No dataSchema declared — payload shape is caller-driven, so we
      // can't tell if `trigger.data.foo` is bogus. Still warn (matches
      // the editor's strict UX) with a targeted hint pointing at the
      // fix: declare a trigger dataSchema.
      return ' — trigger has no dataSchema; declare one on the trigger node so referenced fields are validated';
    }
    return '';
  }

  if (root === 'nodes') {
    const nodeId = path.split('.')[1];
    if (nodeId && known.opaqueNodes.has(nodeId)) return null;
    return '';
  }

  // Unknown root (not trigger, nodes, item, index) — real bug.
  return ` — root "${root}" is not one of trigger / nodes / item / index`;
}

function hasOpaquePrefix(path: string, prefixes: Set<string>): boolean {
  for (const prefix of prefixes) {
    if (path === prefix || path.startsWith(`${prefix}.`)) return true;
  }
  return false;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
