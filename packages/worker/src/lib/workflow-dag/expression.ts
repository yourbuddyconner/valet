/**
 * Workflow DAG expression and template language.
 *
 * AST-based parser + evaluator for the dag/v1 expression language.
 *
 * Supports:
 *   - Path reads against { trigger, nodes } (and aliases set by
 *     foreach iteration bodies).
 *   - Literals: string, number, boolean, null.
 *   - Comparisons: ==, !=, <, <=, >, >=.
 *   - Boolean operators: &&, ||, !.
 *   - Membership: `in`.
 *   - Existence: exists(path).
 *
 * Does NOT support: arithmetic, function calls beyond `exists`, regex,
 * `eval`, `Function`, or any general-purpose JavaScript.
 *
 * Templates: `{{path.to.value}}` interpolation. Single-template fields
 * preserve structured values; mixed-text templates stringify per spec
 * §"Undefined and error behavior".
 */

// ─── Public types ───────────────────────────────────────────────────────────

export interface TemplateContext {
  trigger?: unknown;
  nodes?: unknown;
  /** Aliases set by foreach iteration bodies (e.g. `item`, `index`). */
  [alias: string]: unknown;
}

export class TemplateParseError extends Error {
  constructor(message: string, public readonly source: string) {
    super(`template_parse_error: ${message} (in: ${truncate(source, 80)})`);
    this.name = 'TemplateParseError';
  }
}

export class TemplateEvalError extends Error {
  constructor(message: string, public readonly source: string) {
    super(`template_eval_error: ${message} (in: ${truncate(source, 80)})`);
    this.name = 'TemplateEvalError';
  }
}

// ─── Expression AST ─────────────────────────────────────────────────────────

type ExprNode =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'path'; segments: string[] }
  | { kind: 'unary'; op: '!'; operand: ExprNode }
  | { kind: 'binary'; op: ComparisonOp | LogicalOp | 'in'; left: ExprNode; right: ExprNode }
  | { kind: 'exists'; segments: string[] };

type ComparisonOp = '==' | '!=' | '<' | '<=' | '>' | '>=';
type LogicalOp = '&&' | '||';

// ─── Expression parser (recursive descent) ──────────────────────────────────

interface ParserState {
  source: string;
  pos: number;
}

function peek(s: ParserState): string {
  return s.source[s.pos] ?? '';
}

function skipWs(s: ParserState): void {
  while (s.pos < s.source.length && /\s/.test(s.source[s.pos]!)) s.pos++;
}

function consume(s: ParserState, lit: string): boolean {
  skipWs(s);
  if (s.source.startsWith(lit, s.pos)) {
    s.pos += lit.length;
    return true;
  }
  return false;
}

function expect(s: ParserState, lit: string): void {
  if (!consume(s, lit)) {
    throw new TemplateParseError(`expected ${JSON.stringify(lit)} at position ${s.pos}`, s.source);
  }
}

/** Parses a full expression and ensures the whole source is consumed. */
export function parseExpression(source: string): ExprNode {
  const s: ParserState = { source, pos: 0 };
  const ast = parseOr(s);
  skipWs(s);
  if (s.pos < source.length) {
    throw new TemplateParseError(`unexpected trailing content at position ${s.pos}`, source);
  }
  return ast;
}

function parseOr(s: ParserState): ExprNode {
  let left = parseAnd(s);
  while (consume(s, '||')) {
    const right = parseAnd(s);
    left = { kind: 'binary', op: '||', left, right };
  }
  return left;
}

function parseAnd(s: ParserState): ExprNode {
  let left = parseNot(s);
  while (consume(s, '&&')) {
    const right = parseNot(s);
    left = { kind: 'binary', op: '&&', left, right };
  }
  return left;
}

function parseNot(s: ParserState): ExprNode {
  skipWs(s);
  if (consume(s, '!')) {
    // Distinguish from `!=`. `!=` is a comparison parsed in parseComparison.
    if (peek(s) === '=') {
      // Restore the consumed `!` so parseComparison sees it.
      s.pos -= 1;
      return parseComparison(s);
    }
    const operand = parseNot(s);
    return { kind: 'unary', op: '!', operand };
  }
  return parseComparison(s);
}

const COMPARISON_OPS: ComparisonOp[] = ['==', '!=', '<=', '>=', '<', '>'];

function parseComparison(s: ParserState): ExprNode {
  const left = parseInExpr(s);
  skipWs(s);
  for (const op of COMPARISON_OPS) {
    if (consume(s, op)) {
      const right = parseInExpr(s);
      return { kind: 'binary', op, left, right };
    }
  }
  return left;
}

function parseInExpr(s: ParserState): ExprNode {
  const left = parsePrimary(s);
  skipWs(s);
  // `in` must be followed by a delimiter (whitespace or paren).
  if (s.source.startsWith('in', s.pos) && /[\s({[]/.test(s.source[s.pos + 2] ?? '')) {
    s.pos += 2;
    const right = parsePrimary(s);
    return { kind: 'binary', op: 'in', left, right };
  }
  return left;
}

function parsePrimary(s: ParserState): ExprNode {
  skipWs(s);

  if (consume(s, '(')) {
    const inner = parseOr(s);
    expect(s, ')');
    return inner;
  }

  if (consume(s, 'exists(')) {
    const segments = parsePathSegments(s);
    expect(s, ')');
    return { kind: 'exists', segments };
  }

  // Literals
  const ch = peek(s);
  if (ch === '"' || ch === "'") {
    return { kind: 'literal', value: parseStringLiteral(s) };
  }
  if (ch === '-' || (ch >= '0' && ch <= '9')) {
    return { kind: 'literal', value: parseNumberLiteral(s) };
  }

  // Keywords / identifiers
  const ident = readIdentifier(s);
  if (ident === 'true') return { kind: 'literal', value: true };
  if (ident === 'false') return { kind: 'literal', value: false };
  if (ident === 'null') return { kind: 'literal', value: null };
  if (ident === '') {
    throw new TemplateParseError(`unexpected character ${JSON.stringify(ch)} at position ${s.pos}`, s.source);
  }
  // Path expression — read remaining dotted segments.
  const segments = [ident, ...readDottedTail(s)];
  return { kind: 'path', segments };
}

function parseStringLiteral(s: ParserState): string {
  const quote = s.source[s.pos];
  if (quote !== '"' && quote !== "'") {
    throw new TemplateParseError(`expected string literal at position ${s.pos}`, s.source);
  }
  s.pos++;
  let out = '';
  while (s.pos < s.source.length) {
    const c = s.source[s.pos]!;
    if (c === '\\') {
      const next = s.source[s.pos + 1];
      if (next === undefined) {
        throw new TemplateParseError(`unterminated escape sequence`, s.source);
      }
      out += next === 'n' ? '\n' : next === 't' ? '\t' : next;
      s.pos += 2;
      continue;
    }
    if (c === quote) {
      s.pos++;
      return out;
    }
    out += c;
    s.pos++;
  }
  throw new TemplateParseError(`unterminated string literal`, s.source);
}

function parseNumberLiteral(s: ParserState): number {
  const start = s.pos;
  if (s.source[s.pos] === '-') s.pos++;
  const digitsStart = s.pos;
  while (s.pos < s.source.length && /[0-9.]/.test(s.source[s.pos]!)) s.pos++;
  // Require at least one digit. Without this guard, an empty bracket
  // subscript `nodes.x[]` would silently parse as `nodes.x[0]` because
  // Number('') === 0.
  if (s.pos === digitsStart) {
    throw new TemplateParseError(`expected number literal at position ${start}`, s.source);
  }
  const text = s.source.slice(start, s.pos);
  const n = Number(text);
  if (Number.isNaN(n)) {
    throw new TemplateParseError(`invalid number literal ${JSON.stringify(text)}`, s.source);
  }
  return n;
}

function readIdentifier(s: ParserState): string {
  skipWs(s);
  const start = s.pos;
  while (s.pos < s.source.length && /[A-Za-z0-9_]/.test(s.source[s.pos]!)) s.pos++;
  return s.source.slice(start, s.pos);
}

function readDottedTail(s: ParserState): string[] {
  const out: string[] = [];
  while (s.source[s.pos] === '.') {
    s.pos++;
    const seg = readIdentifier(s);
    if (seg === '') {
      throw new TemplateParseError(`empty path segment after '.' at position ${s.pos}`, s.source);
    }
    out.push(seg);
  }
  // Bracket subscript support: nodes.x[0].y, nodes.x["weird-key"], nodes.x[name].
  while (s.source[s.pos] === '[') {
    s.pos++;
    const ch = s.source[s.pos];
    let idx: string;
    if (ch === '"' || ch === "'") {
      idx = parseStringLiteral(s);
    } else if (ch === '-' || (ch !== undefined && ch >= '0' && ch <= '9')) {
      idx = parseNumberLiteral(s).toString();
    } else {
      const ident = readIdentifier(s);
      if (ident === '') {
        throw new TemplateParseError(`empty bracket subscript at position ${s.pos}`, s.source);
      }
      idx = ident;
    }
    out.push(idx);
    expect(s, ']');
    while (s.source[s.pos] === '.') {
      s.pos++;
      const seg = readIdentifier(s);
      if (seg === '') {
        throw new TemplateParseError(`empty path segment after '.'`, s.source);
      }
      out.push(seg);
    }
  }
  return out;
}

function parsePathSegments(s: ParserState): string[] {
  const head = readIdentifier(s);
  if (head === '') {
    throw new TemplateParseError(`expected path identifier`, s.source);
  }
  return [head, ...readDottedTail(s)];
}

// ─── Expression evaluation ──────────────────────────────────────────────────

export function evaluateExpression(ast: ExprNode, ctx: TemplateContext): unknown {
  switch (ast.kind) {
    case 'literal':
      return ast.value;
    case 'path':
      return readPath(ctx, ast.segments);
    case 'exists':
      return readPathExists(ctx, ast.segments);
    case 'unary':
      return !truthy(evaluateExpression(ast.operand, ctx));
    case 'binary': {
      // Short-circuit boolean ops.
      if (ast.op === '&&') {
        const l = evaluateExpression(ast.left, ctx);
        if (!truthy(l)) return l;
        return evaluateExpression(ast.right, ctx);
      }
      if (ast.op === '||') {
        const l = evaluateExpression(ast.left, ctx);
        if (truthy(l)) return l;
        return evaluateExpression(ast.right, ctx);
      }
      const l = evaluateExpression(ast.left, ctx);
      const r = evaluateExpression(ast.right, ctx);
      switch (ast.op) {
        case '==': return strictEqual(l, r);
        case '!=': return !strictEqual(l, r);
        case '<':  return compare(l, r) < 0;
        case '<=': return compare(l, r) <= 0;
        case '>':  return compare(l, r) > 0;
        case '>=': return compare(l, r) >= 0;
        case 'in': return inMembership(l, r);
      }
    }
  }
}

function truthy(v: unknown): boolean {
  if (v === null || v === undefined || v === false || v === 0 || v === '') return false;
  return true;
}

function strictEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  // null-loose: treat null and undefined as equivalent for missing data.
  if ((a === null || a === undefined) && (b === null || b === undefined)) return true;
  return false;
}

function compare(a: unknown, b: unknown): number {
  if (typeof a === 'number' && typeof b === 'number') return a - b;
  if (typeof a === 'string' && typeof b === 'string') {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  // Date-like ISO strings compare lexicographically and that matches
  // chronological order for `YYYY-MM-DD...` format.
  throw new TemplateEvalError(`cannot compare values of mixed types`, JSON.stringify({ a, b }));
}

function inMembership(needle: unknown, haystack: unknown): boolean {
  if (Array.isArray(haystack)) return haystack.some((v) => strictEqual(v, needle));
  if (typeof haystack === 'string' && typeof needle === 'string') return haystack.includes(needle);
  if (haystack && typeof haystack === 'object' && typeof needle === 'string') {
    return Object.prototype.hasOwnProperty.call(haystack, needle);
  }
  return false;
}

// ─── Path resolution ────────────────────────────────────────────────────────

function readPath(ctx: TemplateContext, segments: string[]): unknown {
  let cur: unknown = ctx;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return undefined;
    if (typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

function readPathExists(ctx: TemplateContext, segments: string[]): boolean {
  let cur: unknown = ctx;
  for (const seg of segments) {
    if (cur === null || cur === undefined) return false;
    if (typeof cur !== 'object') return false;
    if (!Object.prototype.hasOwnProperty.call(cur, seg)) return false;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur !== undefined;
}

// ─── Template parsing + rendering ───────────────────────────────────────────

interface TemplateSegment {
  kind: 'literal' | 'expr';
  text: string;
  /** Parsed AST when kind === 'expr'. */
  ast?: ExprNode;
}

interface TemplateAst {
  segments: TemplateSegment[];
  /** True when the entire input is exactly one `{{...}}` with no surrounding text. */
  isSingle: boolean;
}

/** Parse a template string. Returns its segments + isSingle marker. */
export function parseTemplate(source: string): TemplateAst {
  const segments: TemplateSegment[] = [];
  let i = 0;
  let literal = '';
  while (i < source.length) {
    if (source.startsWith('{{', i)) {
      if (literal !== '') {
        segments.push({ kind: 'literal', text: literal });
        literal = '';
      }
      const end = findExpressionEnd(source, i + 2);
      if (end === -1) {
        throw new TemplateParseError(`unterminated {{ ... }} expression`, source);
      }
      const exprSrc = source.slice(i + 2, end).trim();
      const ast = parseExpression(exprSrc);
      segments.push({ kind: 'expr', text: exprSrc, ast });
      i = end + 2;
      continue;
    }
    literal += source[i];
    i++;
  }
  if (literal !== '') segments.push({ kind: 'literal', text: literal });

  // A template counts as "single" when, ignoring leading/trailing whitespace
  // outside the expression, the only thing in the source is one {{...}}.
  // This lets `  {{x}}  ` preserve structured values.
  const trimmed = source.trim();
  const isSingle =
    segments.filter((s) => s.kind === 'expr').length === 1 &&
    trimmed.startsWith('{{') && trimmed.endsWith('}}') &&
    !segments.some((s) => s.kind === 'literal' && s.text.trim() !== '');

  return { segments, isSingle };
}

/**
 * Scan for the closing `}}` of a template expression, respecting string
 * literals so a sequence like `{{"a }} b"}}` resolves to the correct end.
 * Returns the index of the opening `}` in the closing pair, or -1 if not
 * found.
 */
function findExpressionEnd(source: string, start: number): number {
  let i = start;
  while (i < source.length) {
    const c = source[i]!;
    if (c === '"' || c === "'") {
      // Skip over the string literal (including escapes).
      const quote = c;
      i++;
      while (i < source.length) {
        if (source[i] === '\\') { i += 2; continue; }
        if (source[i] === quote) { i++; break; }
        i++;
      }
      continue;
    }
    if (c === '}' && source[i + 1] === '}') return i;
    i++;
  }
  return -1;
}

/**
 * Render a template against a context.
 *
 * Single-template fields (`isSingle`) preserve the underlying value's
 * type. Mixed-text templates concatenate everything to a string per the
 * spec rules. Undefined paths follow spec §"Undefined and error
 * behavior".
 */
export function renderTemplate(source: string, ctx: TemplateContext): unknown {
  const ast = parseTemplate(source);

  if (ast.isSingle) {
    // Find the single expression segment (there may be whitespace-only
    // literal segments around it; isSingle ignores those).
    const exprSeg = ast.segments.find((s) => s.kind === 'expr');
    const value = evaluateExpression(exprSeg!.ast!, ctx);
    // Single-template undefined → null per spec.
    return value === undefined ? null : value;
  }

  // Mixed text: concatenate.
  let out = '';
  for (const seg of ast.segments) {
    if (seg.kind === 'literal') {
      out += seg.text;
      continue;
    }
    const v = evaluateExpression(seg.ast!, ctx);
    out += stringifyForMixedText(v);
  }
  return out;
}

function stringifyForMixedText(v: unknown): string {
  if (v === undefined || v === null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return JSON.stringify(v);
}

/**
 * Recursively render any string fields in a JSON value as templates.
 * Used by node executors to render their params / prompts / etc. Object
 * keys are NOT rendered; only values. Arrays are walked.
 */
export function renderJsonTemplates<T>(value: T, ctx: TemplateContext): T {
  if (typeof value === 'string') {
    return renderTemplate(value, ctx) as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => renderJsonTemplates(v, ctx)) as unknown as T;
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = renderJsonTemplates(v, ctx);
    }
    return out as T;
  }
  return value;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n) + '...';
}
