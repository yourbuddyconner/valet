/**
 * Which fields of a node hold templates, and what the paths in them
 * resolve to right now.
 *
 * The interpreter audits a node with this immediately before the node
 * runs, against the same context the node's executor will render with. Two
 * things come out of that timing. The finding names the FIELD, which a
 * miss reported from inside an executor cannot. And a strict-mode
 * definition can fail the node before it sends a prompt or calls an
 * action, rather than after.
 *
 * The field list mirrors `validate.ts`'s per-type checks. Both walk the
 * same fields for the same reason, one at save time and one at run time.
 */

import {
  collectExpressionValuePaths,
  collectTemplateValuePaths,
  type TemplateContext,
} from './expression.js';
import type { WorkflowNode } from './nodes.js';
import { diagnosePath, type TemplatePathDiagnostic } from './path-diagnostics.js';

export interface NodeTemplateSource {
  /** Dotted field path inside the node, e.g. `prompt` or `params.title`. */
  field: string;
  source: string;
  /** `expression` = a bare expression (an `if` condition); `template` = `{{ ... }}` interpolation. */
  syntax: 'template' | 'expression';
  /**
   * False for a surface that asks a question about the data instead of
   * reading a value out of it. An `if` condition legitimately tests a path
   * that is absent, so strict mode must not fail the run for it.
   */
  enforceable: boolean;
}

/**
 * Every templated field on `node`.
 *
 * A `foreach` node contributes only `items`. Its body renders against
 * per-iteration aliases (`item`, `index`) that do not exist yet at audit
 * time, so auditing the body here would report misses that are not real.
 * Body misses are caught while the body runs, through the miss recorder.
 */
export function collectNodeTemplateSources(node: WorkflowNode): NodeTemplateSource[] {
  const out: NodeTemplateSource[] = [];
  switch (node.type) {
    case 'trigger':
    case 'wait':
      break;
    case 'set':
      addJson(out, 'values', node.values);
      break;
    case 'if':
      if (Array.isArray(node.conditions)) {
        for (const [i, cond] of node.conditions.entries()) {
          // A condition's `left` is a bare expression, not `{{ ... }}`.
          const left = isRecord(cond) ? cond.left : undefined;
          addSource(out, `conditions[${i}].left`, left, 'expression', false);
        }
      }
      break;
    case 'approval':
      addSource(out, 'prompt', node.prompt);
      addSource(out, 'summary', node.summary);
      addJson(out, 'details', node.details);
      break;
    case 'session':
      addSource(out, 'prompt', node.prompt);
      addSource(out, 'title', node.title);
      break;
    case 'stop':
      addSource(out, 'message', node.message);
      addJson(out, 'output', node.output);
      break;
    case 'llm':
      addSource(out, 'prompt', node.prompt);
      addSource(out, 'system', node.system);
      break;
    case 'thread':
      addSource(out, 'prompt', node.prompt);
      break;
    case 'tool':
      addJson(out, 'params', node.params);
      addSource(out, 'summary', node.summary);
      break;
    case 'workflow':
      addJson(out, 'input', node.input);
      break;
    case 'foreach':
      addSource(out, 'items', node.items);
      break;
  }
  return out;
}

/**
 * Findings for every unresolved path in `node`'s templates, against `ctx`.
 *
 * Empty is the normal result. A non-empty result means the node is about
 * to run with at least one value the author expected and did not get.
 */
export function auditNodeTemplates(node: WorkflowNode, ctx: TemplateContext): TemplatePathDiagnostic[] {
  const out: TemplatePathDiagnostic[] = [];
  const seen = new Set<string>();
  for (const source of collectNodeTemplateSources(node)) {
    const paths =
      source.syntax === 'expression'
        ? collectExpressionValuePaths(source.source)
        : collectTemplateValuePaths(source.source);
    for (const segments of paths) {
      // One finding per (field, path): the same path written twice in one
      // prompt is one mistake to fix.
      const key = `${source.field}|${segments.join('.')}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const diagnostic = diagnosePath(ctx, segments, {
        nodeId: node.id,
        field: source.field,
        origin: 'field',
        enforceable: source.enforceable,
      });
      if (diagnostic) out.push(diagnostic);
    }
  }
  return out;
}

// ─── Field collection helpers ────────────────────────────────────────────────

/**
 * The node union types these fields as strings, but the runtime input is
 * author- or LLM-written JSON. A non-string field is the validator's to
 * reject; here it simply holds no template.
 */
function addSource(
  out: NodeTemplateSource[],
  field: string,
  value: unknown,
  syntax: 'template' | 'expression' = 'template',
  enforceable = true,
): void {
  if (typeof value !== 'string' || value === '') return;
  // A `template` string is only a source when it actually holds a template.
  // A plain literal — `"bug"` in a list of labels — resolves to itself, so
  // reporting it as a source would make the diagnostics answer about strings
  // that can never fail.
  //
  // An `expression` is exempt: an `if` node's `left` is a bare expression
  // with no delimiters, so the whole string is the source.
  if (syntax === 'template' && !value.includes('{{')) return;
  out.push({ field, source: value, syntax, enforceable });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Walk arbitrary JSON. Every string leaf is offered to `addSource`, which
 * keeps only the ones that actually hold a template. */
function addJson(out: NodeTemplateSource[], field: string, value: unknown): void {
  if (typeof value === 'string') {
    addSource(out, field, value);
    return;
  }
  if (Array.isArray(value)) {
    for (const [i, entry] of value.entries()) addJson(out, `${field}[${i}]`, entry);
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) addJson(out, `${field}.${key}`, entry);
  }
}
