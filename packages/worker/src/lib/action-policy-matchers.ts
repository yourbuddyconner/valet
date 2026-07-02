/**
 * Param matcher engine for action_policies and runtime_grants.
 *
 * Each matcher is a single check: walk a dot-path through the
 * invocation's params, apply an op against a value, return boolean.
 * All matchers on a policy/grant must pass (AND); empty array matches
 * anything. The resolver discards a candidate whose matchers don't
 * match the invocation's actual params — so a rule like
 *
 *   { service: 'google_workspace', actionId: 'sheets.append_rows',
 *     paramMatchers: [{ path: 'spreadsheetId', op: 'eq', value: '1S2hM5…' }] }
 *
 * auto-approves appends to that one spreadsheet and lets every other
 * appendRows call fall through to the next candidate (or the system
 * default require_approval).
 */

export type ParamMatcherOp =
  | 'eq' | 'neq'
  | 'regex'
  | 'in' | 'not_in'
  | 'gt' | 'gte' | 'lt' | 'lte'
  | 'exists' | 'not_exists';

export interface ParamMatcher {
  /** Dot-path through the params object. Supports dotted keys and
   *  numeric index brackets, e.g. `"items[0].name"`. Empty string
   *  matches the params object itself. */
  path: string;
  op: ParamMatcherOp;
  /** Value to compare against. Not required for exists/not_exists. */
  value?: unknown;
}

const ALL_OPS = new Set<ParamMatcherOp>([
  'eq', 'neq', 'regex', 'in', 'not_in',
  'gt', 'gte', 'lt', 'lte', 'exists', 'not_exists',
]);

/**
 * Strict shape validation. Throws ValidationError-style messages so
 * route handlers can surface them; safe to call on user-supplied JSON.
 */
export function validateParamMatchers(value: unknown): ParamMatcher[] {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error('paramMatchers must be an array');
  }
  return value.map((entry, i) => {
    if (!entry || typeof entry !== 'object') {
      throw new Error(`paramMatchers[${i}] must be an object`);
    }
    const m = entry as Record<string, unknown>;
    const path = m.path;
    const op = m.op;
    if (typeof path !== 'string') {
      throw new Error(`paramMatchers[${i}].path must be a string`);
    }
    if (typeof op !== 'string' || !ALL_OPS.has(op as ParamMatcherOp)) {
      throw new Error(`paramMatchers[${i}].op must be one of: ${Array.from(ALL_OPS).join(', ')}`);
    }
    const needsValue = op !== 'exists' && op !== 'not_exists';
    if (needsValue && !('value' in m)) {
      throw new Error(`paramMatchers[${i}].value is required for op="${op}"`);
    }
    if (op === 'in' || op === 'not_in') {
      if (!Array.isArray(m.value)) {
        throw new Error(`paramMatchers[${i}].value must be an array for op="${op}"`);
      }
    }
    if (op === 'regex' && typeof m.value !== 'string') {
      throw new Error(`paramMatchers[${i}].value must be a string for op="regex"`);
    }
    return {
      path,
      op: op as ParamMatcherOp,
      ...(needsValue ? { value: m.value } : {}),
    };
  });
}

/**
 * Walk a dot-path through `params`. Supports `a.b.c` and `a[0].b`.
 * Returns `undefined` for any missing segment.
 */
export function readPath(params: unknown, path: string): unknown {
  if (path === '') return params;
  let cursor: unknown = params;
  const segments = parsePath(path);
  for (const segment of segments) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof segment === 'number') {
      if (!Array.isArray(cursor)) return undefined;
      cursor = cursor[segment];
    } else {
      if (typeof cursor !== 'object' || Array.isArray(cursor)) return undefined;
      cursor = (cursor as Record<string, unknown>)[segment];
    }
  }
  return cursor;
}

function parsePath(path: string): Array<string | number> {
  const out: Array<string | number> = [];
  let i = 0;
  while (i < path.length) {
    if (path[i] === '.') { i++; continue; }
    if (path[i] === '[') {
      const close = path.indexOf(']', i);
      if (close === -1) throw new Error(`unterminated [ in path "${path}"`);
      const idx = Number(path.slice(i + 1, close));
      if (!Number.isInteger(idx) || idx < 0) {
        throw new Error(`invalid array index in path "${path}"`);
      }
      out.push(idx);
      i = close + 1;
      continue;
    }
    let j = i;
    while (j < path.length && path[j] !== '.' && path[j] !== '[') j++;
    out.push(path.slice(i, j));
    i = j;
  }
  return out;
}

/** Single-matcher evaluation. */
export function evaluateMatcher(matcher: ParamMatcher, params: unknown): boolean {
  const actual = readPath(params, matcher.path);
  switch (matcher.op) {
    case 'exists': return actual !== undefined;
    case 'not_exists': return actual === undefined;
    case 'eq': return deepEqual(actual, matcher.value);
    case 'neq': return !deepEqual(actual, matcher.value);
    case 'regex': {
      if (typeof actual !== 'string' || typeof matcher.value !== 'string') return false;
      try {
        return new RegExp(matcher.value).test(actual);
      } catch {
        // Bad regex stored on disk — fail closed so the resolver doesn't
        // accidentally match anything. Logged at the call site if needed.
        return false;
      }
    }
    case 'in':
      return Array.isArray(matcher.value) && matcher.value.some((v) => deepEqual(actual, v));
    case 'not_in':
      return Array.isArray(matcher.value) && !matcher.value.some((v) => deepEqual(actual, v));
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      if (typeof actual !== 'number' || typeof matcher.value !== 'number') return false;
      if (matcher.op === 'gt') return actual > matcher.value;
      if (matcher.op === 'gte') return actual >= matcher.value;
      if (matcher.op === 'lt') return actual < matcher.value;
      return actual <= matcher.value;
    }
  }
}

/** All-or-nothing: every matcher must pass. Empty array → always true. */
export function evaluateMatchers(matchers: ParamMatcher[], params: unknown): boolean {
  for (const m of matchers) {
    if (!evaluateMatcher(m, params)) return false;
  }
  return true;
}

/**
 * Strict structural equality for the matcher engine. Handles primitives,
 * arrays, and plain objects. Used by eq/neq/in/not_in.
 */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a as Record<string, unknown>);
  const kb = Object.keys(b as Record<string, unknown>);
  if (ka.length !== kb.length) return false;
  return ka.every((k) => deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]));
}

/**
 * Parse a JSON-serialized matchers array from a DB row. Bad data fails
 * closed (no match) — never throws to the caller.
 */
export function parseStoredMatchers(json: string | null | undefined): ParamMatcher[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return validateParamMatchers(parsed);
  } catch {
    return [];
  }
}
