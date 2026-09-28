/**
 * Diagnostics for template paths that do not resolve.
 *
 * The dag/v1 template language has no undefined: `{{nodes.draft.result.text}}`
 * renders as `null` in a single-expression field and as `""` inside mixed
 * text (`expression.ts` §"Template parsing + rendering"). A typo therefore
 * produces a run that SUCCEEDS with wrong output, and the author has
 * nothing to read. This module turns each miss into a sentence that names
 * the path, the segment that failed, the keys that were in scope, and —
 * where one exists — the path to write instead.
 *
 * The suggestion is derived from the run's real data, never from a table of
 * known shapes: every candidate is resolved against the same context before
 * it is offered. That covers the contract mistakes we see most often
 * without hard-coding any of them.
 *
 *   - `trigger.email` for `trigger.data.email`. A run's input is a
 *     `WorkflowTriggerPayload`, and its own fields live under `data`.
 *   - `nodes.x.result.response` for an llm node's `nodes.x.result.text`,
 *     and `nodes.x.result.text` for a session or thread node's
 *     `nodes.x.result.response`. The two node families name the produced
 *     text differently (`llm.ts` `LlmResult`; `session.ts` and
 *     `thread.ts` `buildSettledResult`).
 *   - `nodes.x.result.field` for a node with an `outputSchema`, whose
 *     structured result is `nodes.x.result.output.field`.
 */

import {
  resolvePath,
  type TemplateContext,
  type TemplateMissRecorder,
} from './expression.js';
import { nearestMatch } from './near-match.js';

/** How many keys a message names before it counts the rest. */
const MAX_NAMED_KEYS = 12;

/**
 * Container keys tried first when looking for a missing field one level
 * deeper. Ordering only decides which of several working suggestions is
 * offered — every candidate is still resolved against the real context.
 */
const WRAPPER_KEYS: readonly string[] = ['data', 'output', 'result', 'response'];

/**
 * Keys that hold the text a node produced. The node families disagree on
 * the name: an `llm` node returns `text`, a `session` or `orchestrator`
 * node returns `response`. Writing one where the other belongs resolves to
 * nothing, so a miss on any of these tries the others.
 */
const TEXT_KEYS: readonly string[] = ['text', 'response', 'content', 'message', 'completion', 'answer'];

/** Where a diagnostic came from. */
export type DiagnosticOrigin =
  /** A template field on the node, audited before the node ran. */
  | 'field'
  /** A render inside the running node — a `foreach` body's own templates. */
  | 'runtime';

export interface TemplatePathDiagnostic {
  /** The path exactly as written, e.g. `nodes.draft.result.text`. */
  path: string;
  /** The node the path was written on. */
  nodeId: string;
  /**
   * The node field holding the template, e.g. `prompt` or `params.title`.
   * Absent for a `runtime` diagnostic — a miss reported from inside a
   * running node knows the context, not the field.
   */
  field?: string;
  origin: DiagnosticOrigin;
  /** The segment that failed. */
  failedSegment: string;
  /** 0-based index of `failedSegment` within the path. */
  failedIndex: number;
  /** The part of the path that DID resolve. Empty at the root. */
  resolvedPrefix: string;
  reason: 'missing_key' | 'not_an_object' | 'no_value';
  /** Keys present at `resolvedPrefix`, capped at {@link MAX_NAMED_KEYS}. */
  availableKeys: string[];
  /** A path that resolves against the same data. Absent when none was found. */
  suggestion?: string;
  /** The whole finding in one line, ready to show. */
  message: string;
  /**
   * False for a surface where a missing value is a legitimate question
   * rather than a mistake — an `if` condition, an edge predicate. Strict
   * mode (`policy.onUnresolvedPath: "fail"`) ignores these.
   */
  enforceable: boolean;
}

export interface DiagnosticSite {
  nodeId: string;
  field?: string;
  origin: DiagnosticOrigin;
  /** Defaults to true. See `TemplatePathDiagnostic.enforceable`. */
  enforceable?: boolean;
}

/**
 * Diagnose one path against one context. Returns null when the path
 * resolves — callers can run this over every path and keep what comes
 * back.
 */
export function diagnosePath(
  ctx: TemplateContext,
  segments: string[],
  site: DiagnosticSite,
): TemplatePathDiagnostic | null {
  const resolved = resolvePath(ctx, segments);
  if (resolved.ok) return null;

  const path = segments.join('.');
  const failedIndex = resolved.failedIndex;
  const failedSegment = segments[failedIndex] ?? '';
  const resolvedPrefix = segments.slice(0, failedIndex).join('.');
  const container = resolved.container;
  const keys = container ? Object.keys(container) : [];
  const suggestion = suggestPath(ctx, segments, failedIndex, container, resolved.reason);

  const found: Omit<TemplatePathDiagnostic, 'message'> = {
    path,
    nodeId: site.nodeId,
    ...(site.field !== undefined ? { field: site.field } : {}),
    origin: site.origin,
    failedSegment,
    failedIndex,
    resolvedPrefix,
    reason: resolved.reason,
    availableKeys: keys.slice(0, MAX_NAMED_KEYS),
    ...(suggestion !== undefined ? { suggestion } : {}),
    enforceable: site.enforceable ?? true,
  };
  return { ...found, message: formatDiagnostic(found, keys.length, typeName(ctx, segments, failedIndex)) };
}

/**
 * Collects misses reported by the running node. Deduplicates by path: a
 * `foreach` over 100 items renders the same bad path 100 times, and one
 * finding is the whole story.
 */
export function createMissRecorder(nodeId: string): {
  recorder: TemplateMissRecorder;
  diagnostics: TemplatePathDiagnostic[];
} {
  const diagnostics: TemplatePathDiagnostic[] = [];
  const seen = new Set<string>();
  const recorder: TemplateMissRecorder = {
    record(segments, ctx) {
      const path = segments.join('.');
      if (seen.has(path)) return;
      seen.add(path);
      const diagnostic = diagnosePath(ctx, segments, { nodeId, origin: 'runtime' });
      if (diagnostic) diagnostics.push(diagnostic);
    },
  };
  return { recorder, diagnostics };
}

// ─── Suggestion ──────────────────────────────────────────────────────────────

/**
 * The best path that RESOLVES against `ctx`, or undefined.
 *
 * Candidates are generated cheaply and then verified, so a suggestion is
 * never a guess: if it is offered, writing it produces a value.
 */
function suggestPath(
  ctx: TemplateContext,
  segments: string[],
  failedIndex: number,
  container: Record<string, unknown> | undefined,
  reason: 'missing_key' | 'not_an_object' | 'no_value',
): string | undefined {
  for (const candidate of candidatePaths(segments, failedIndex, container, reason)) {
    if (candidate.length === 0) continue;
    if (candidate.join('.') === segments.join('.')) continue;
    if (resolvePath(ctx, candidate).ok) return candidate.join('.');
  }
  return undefined;
}

function* candidatePaths(
  segments: string[],
  failedIndex: number,
  container: Record<string, unknown> | undefined,
  reason: 'missing_key' | 'not_an_object' | 'no_value',
): Generator<string[]> {
  const head = segments.slice(0, failedIndex);
  const tail = segments.slice(failedIndex);
  const failedSegment = segments[failedIndex] ?? '';

  // The walk hit a leaf. The value the author wants is probably the leaf
  // itself: `nodes.x.result.text.value` on a string `text`.
  if (reason === 'not_an_object') {
    yield head;
    return;
  }
  if (!container) return;

  const keys = Object.keys(container);

  // One level deeper, under a wrapper the author did not know about. This
  // is `trigger.email` → `trigger.data.email` and `nodes.x.result.field` →
  // `nodes.x.result.output.field`, found from the data rather than assumed.
  for (const key of orderedByPreference(keys)) {
    const nested = container[key];
    if (nested === null || typeof nested !== 'object') continue;
    if (!(failedSegment in nested)) continue;
    yield [...head, key, ...tail];
  }

  // A near miss on the key itself: a typo, or a foreach alias written wrong.
  const nearest = nearestMatch(failedSegment, keys);
  if (nearest !== null) yield [...head, nearest, ...tail.slice(1)];

  // The produced text under the name this node family gives it.
  if (TEXT_KEYS.includes(failedSegment)) {
    for (const key of TEXT_KEYS) {
      if (key !== failedSegment && keys.includes(key)) yield [...head, key];
    }
  }
}

/** `WRAPPER_KEYS` order first, then the container's own key order. */
function orderedByPreference(keys: string[]): string[] {
  const preferred = WRAPPER_KEYS.filter((k) => keys.includes(k));
  return [...preferred, ...keys.filter((k) => !preferred.includes(k))];
}

// ─── Message ─────────────────────────────────────────────────────────────────

function formatDiagnostic(
  diagnostic: Omit<TemplatePathDiagnostic, 'message'>,
  totalKeys: number,
  leafType: string | undefined,
): string {
  const where = diagnostic.field !== undefined
    ? `node ${JSON.stringify(diagnostic.nodeId)} field ${JSON.stringify(diagnostic.field)}`
    : `node ${JSON.stringify(diagnostic.nodeId)}`;
  const at = diagnostic.resolvedPrefix === '' ? 'the template context' : JSON.stringify(diagnostic.resolvedPrefix);

  const parts = [`${where}: template path ${JSON.stringify(diagnostic.path)} did not resolve.`];

  if (diagnostic.reason === 'not_an_object') {
    // No type name means the prefix itself resolved to nothing — the miss
    // is further up the path than the segment that stopped the walk.
    parts.push(
      leafType === undefined
        ? `${at} has no value, so ${JSON.stringify(diagnostic.failedSegment)} cannot be read from it.`
        : `${at} holds ${leafType}, so ${JSON.stringify(diagnostic.failedSegment)} cannot be read from it.`,
    );
  } else if (diagnostic.reason === 'no_value') {
    parts.push(`Key ${JSON.stringify(diagnostic.failedSegment)} is present at ${at} but holds no value.`);
  } else {
    parts.push(`Key ${JSON.stringify(diagnostic.failedSegment)} is not present at ${at}.`);
    parts.push(availableClause(diagnostic.availableKeys, totalKeys));
  }

  if (diagnostic.resolvedPrefix === 'nodes' && diagnostic.reason === 'missing_key') {
    parts.push('A node appears here only after it completes.');
  }

  if (diagnostic.suggestion !== undefined) {
    parts.push(`Write ${JSON.stringify(diagnostic.suggestion)} instead.`);
  } else if (diagnostic.reason === 'no_value') {
    parts.push('Check that the node upstream produced this value.');
  } else {
    parts.push('Correct the path, or read it through exists(...) if the value is optional.');
  }

  return parts.join(' ');
}

function availableClause(named: string[], total: number): string {
  if (total === 0) return 'It has no keys.';
  const more = total > named.length ? `, and ${total - named.length} more` : '';
  return `Available keys: ${named.join(', ')}${more}.`;
}

/** The type of the value the walk stopped on, for a `not_an_object` message. */
function typeName(ctx: TemplateContext, segments: string[], failedIndex: number): string | undefined {
  const resolved = resolvePath(ctx, segments.slice(0, failedIndex));
  if (!resolved.ok) return undefined;
  const value = resolved.value;
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'a list';
  if (typeof value === 'object') return 'an object';
  return `a ${typeof value}`;
}
