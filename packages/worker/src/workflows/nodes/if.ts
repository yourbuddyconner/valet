/**
 * `if` node executor.
 *
 * Deterministically routes branches based on typed comparison conditions
 * combined with `and` (default) or `or`. Output is consumed by the
 * runtime's edge router: edges leaving an `if` node use `fromOutput:
 * 'true' | 'false'` matched against `data.result`.
 */

import type { IfNode, IfCondition } from '@valet/shared';
import {
  parseExpression,
  evaluateExpression,
  TemplateParseError,
  TemplateEvalError,
} from '../../lib/workflow-dag/expression.js';
import { normalizeIfOperation } from '../../lib/workflow-dag/if-operations.js';
import { buildTemplateContext, type TemplateContext } from '../context.js';
import type { NodeExecutorArgs } from '../types.js';

export interface IfResult {
  result: boolean;
  matched: number[];
  combinator: 'and' | 'or';
}

export async function executeIf(args: NodeExecutorArgs<IfNode>): Promise<IfResult> {
  const combinator = args.node.combinator ?? 'and';
  const ctx = buildTemplateContext(args.state, args.aliases);

  const matched: number[] = [];
  for (let i = 0; i < args.node.conditions.length; i++) {
    if (evaluateCondition(args.node.conditions[i]!, ctx)) {
      matched.push(i);
    }
  }

  const result = combinator === 'and'
    ? matched.length === args.node.conditions.length
    : matched.length > 0;

  return { result, matched, combinator };
}

function evaluateCondition(cond: IfCondition, ctx: TemplateContext): boolean {
  let left: unknown;
  try {
    left = evaluateExpression(parseExpression(cond.left), ctx);
  } catch (err) {
    if (err instanceof TemplateParseError || err instanceof TemplateEvalError) {
      throw new Error(`if condition left side failed to evaluate: ${err.message}`);
    }
    throw err;
  }
  const right = cond.right;
  const operation = normalizeIfOperation(cond.operation);

  switch (cond.dataType) {
    case 'string':  return evalString(operation, left, right);
    case 'number':  return evalNumber(operation, left, right);
    case 'date':    return evalDate(operation, left, right);
    case 'boolean': return evalBoolean(operation, left, right);
    case 'array':   return evalArray(operation, left, right);
    case 'object':  return evalObject(operation, left, right);
  }
}

// ─── Per-type comparison tables ──────────────────────────────────────────────

function evalString(op: string, left: unknown, right: unknown): boolean {
  switch (op) {
    case 'exists':            return left !== undefined && left !== null;
    case 'doesNotExist':      return left === undefined || left === null;
    case 'isEmpty':           return left === '' || left === undefined || left === null;
    case 'isNotEmpty':        return typeof left === 'string' && left.length > 0;
    case 'equals':            return left === right;
    case 'notEquals':         return left !== right;
    case 'contains':          return asString(left).includes(asString(right));
    case 'doesNotContain':    return !asString(left).includes(asString(right));
    case 'startsWith':        return asString(left).startsWith(asString(right));
    case 'endsWith':          return asString(left).endsWith(asString(right));
    case 'matchesRegex':      return safeRegex(asString(right)).test(asString(left));
  }
  throw new Error(`unsupported string operation: ${op}`);
}

function evalNumber(op: string, left: unknown, right: unknown): boolean {
  switch (op) {
    case 'exists':            return typeof left === 'number' && !Number.isNaN(left);
    case 'doesNotExist':      return !(typeof left === 'number' && !Number.isNaN(left));
    case 'isEmpty':           return left === undefined || left === null || (typeof left === 'number' && Number.isNaN(left));
    case 'isNotEmpty':        return typeof left === 'number' && !Number.isNaN(left);
    case 'equals':            return asNumber(left) === asNumber(right);
    case 'notEquals':         return asNumber(left) !== asNumber(right);
    case 'greaterThan':       return asNumber(left) > asNumber(right);
    case 'lessThan':          return asNumber(left) < asNumber(right);
    case 'greaterThanOrEqual': return asNumber(left) >= asNumber(right);
    case 'lessThanOrEqual':   return asNumber(left) <= asNumber(right);
  }
  throw new Error(`unsupported number operation: ${op}`);
}

function evalDate(op: string, left: unknown, right: unknown): boolean {
  // Reject unparseable dates loudly rather than relying on IEEE NaN
  // semantics (NaN === NaN is false, so two unparseable values would
  // silently compare as notEquals).
  const lt = asDate(left);
  switch (op) {
    case 'exists':       return left !== undefined && left !== null && !Number.isNaN(lt);
    case 'doesNotExist': return left === undefined || left === null || Number.isNaN(lt);
  }
  const rt = asDate(right);
  if (Number.isNaN(lt) || Number.isNaN(rt)) {
    throw new Error(`date condition received an unparseable value (left=${String(left)}, right=${String(right)})`);
  }
  switch (op) {
    case 'equals':        return lt === rt;
    case 'notEquals':     return lt !== rt;
    case 'after':         return lt > rt;
    case 'before':        return lt < rt;
    case 'afterOrEqual':  return lt >= rt;
    case 'beforeOrEqual': return lt <= rt;
  }
  throw new Error(`unsupported date operation: ${op}`);
}

function evalBoolean(op: string, left: unknown, right: unknown): boolean {
  switch (op) {
    case 'exists':       return typeof left === 'boolean';
    case 'doesNotExist': return typeof left !== 'boolean';
    case 'isTrue':       return left === true;
    case 'isFalse':      return left === false;
    case 'equals':       return Boolean(left) === Boolean(right);
    case 'notEquals':    return Boolean(left) !== Boolean(right);
  }
  throw new Error(`unsupported boolean operation: ${op}`);
}

function evalArray(op: string, left: unknown, right: unknown): boolean {
  const arr = Array.isArray(left) ? left : null;
  switch (op) {
    case 'exists':            return arr !== null;
    case 'doesNotExist':      return arr === null;
    case 'isEmpty':           return arr === null || arr.length === 0;
    case 'isNotEmpty':        return arr !== null && arr.length > 0;
    case 'contains':          return arr !== null && arr.some((v) => deepEqual(v, right));
    case 'doesNotContain':    return arr === null || !arr.some((v) => deepEqual(v, right));
    case 'lengthEquals':      return arr !== null && arr.length === asNumber(right);
    case 'lengthGreaterThan': return arr !== null && arr.length > asNumber(right);
    case 'lengthLessThan':    return arr !== null && arr.length < asNumber(right);
  }
  throw new Error(`unsupported array operation: ${op}`);
}

function evalObject(op: string, left: unknown, _right: unknown): boolean {
  const isObj = left !== null && typeof left === 'object' && !Array.isArray(left);
  switch (op) {
    case 'exists':       return isObj;
    case 'doesNotExist': return !isObj;
    case 'isEmpty':      return isObj && Object.keys(left as object).length === 0;
    case 'isNotEmpty':   return isObj && Object.keys(left as object).length > 0;
  }
  throw new Error(`unsupported object operation: ${op}`);
}

// ─── Coercion helpers ──────────────────────────────────────────────────────

function asString(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'string') return v;
  return String(v);
}

function asNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v);
    if (!Number.isNaN(n)) return n;
  }
  return NaN;
}

function asDate(v: unknown): number {
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string') {
    const t = Date.parse(v);
    if (!Number.isNaN(t)) return t;
  }
  if (typeof v === 'number') return v;
  return NaN;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return a === b;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) return false;
    if (a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const ak = Object.keys(ao);
  if (ak.length !== Object.keys(bo).length) return false;
  return ak.every((k) => deepEqual(ao[k], bo[k]));
}

function safeRegex(pattern: string): RegExp {
  try {
    return new RegExp(pattern);
  } catch {
    // Treat unparseable regex as a never-match rather than crashing the
    // workflow. Authoring layer should validate via try { new RegExp(p) }
    // at publish time.
    return /^(?!)/;
  }
}
