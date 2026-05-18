/**
 * Workflow conditional expression parser and evaluator.
 *
 * Used by `conditional` step `condition` strings like `outputs.list_runs.failed > 0`.
 * We use a purpose-built recursive-descent parser instead of `new Function` / eval to
 * keep the attack surface tiny (paths, literals, comparisons, and boolean logic only).
 *
 * Equality is always JS-strict (no type coercion). Numeric comparisons require both
 * sides to be numbers; mixed-type comparisons return false rather than coerce. Missing
 * paths return `undefined` (falsy) without throwing.
 */

export type ConditionNode =
  | { kind: 'literal'; value: string | number | boolean | null }
  | { kind: 'path'; segments: string[] }
  | { kind: 'unary'; op: '!'; operand: ConditionNode }
  | { kind: 'binary'; op: BinaryOp; left: ConditionNode; right: ConditionNode }
  | { kind: 'group'; child: ConditionNode };

export type BinaryOp =
  | '||'
  | '&&'
  | '=='
  | '==='
  | '!='
  | '!=='
  | '>'
  | '<'
  | '>='
  | '<=';

export interface EvalContext {
  variables: Record<string, unknown>;
  outputs: Record<string, unknown>;
  // Present only inside a loop body; null/undefined elsewhere.
  loop?: Record<string, unknown>;
}

// --- Tokenizer ---------------------------------------------------------------

type Token =
  | { type: 'number'; value: number }
  | { type: 'string'; value: string }
  | { type: 'ident'; value: string }
  | { type: 'true' }
  | { type: 'false' }
  | { type: 'null' }
  | { type: 'op'; value: BinaryOp | '!' }
  | { type: 'lparen' }
  | { type: 'rparen' }
  | { type: 'dot' };

function tokenize(input: string): Token[] | null {
  const tokens: Token[] = [];
  let i = 0;
  const len = input.length;

  while (i < len) {
    const ch = input[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }

    if (ch === '(') { tokens.push({ type: 'lparen' }); i++; continue; }
    if (ch === ')') { tokens.push({ type: 'rparen' }); i++; continue; }
    if (ch === '.') { tokens.push({ type: 'dot' }); i++; continue; }

    // Multi-char operators first so `===` doesn't get split into `==` + `=`.
    if (input.startsWith('===', i)) { tokens.push({ type: 'op', value: '===' }); i += 3; continue; }
    if (input.startsWith('!==', i)) { tokens.push({ type: 'op', value: '!==' }); i += 3; continue; }
    if (input.startsWith('==', i)) { tokens.push({ type: 'op', value: '==' }); i += 2; continue; }
    if (input.startsWith('!=', i)) { tokens.push({ type: 'op', value: '!=' }); i += 2; continue; }
    if (input.startsWith('>=', i)) { tokens.push({ type: 'op', value: '>=' }); i += 2; continue; }
    if (input.startsWith('<=', i)) { tokens.push({ type: 'op', value: '<=' }); i += 2; continue; }
    if (input.startsWith('&&', i)) { tokens.push({ type: 'op', value: '&&' }); i += 2; continue; }
    if (input.startsWith('||', i)) { tokens.push({ type: 'op', value: '||' }); i += 2; continue; }
    if (ch === '>') { tokens.push({ type: 'op', value: '>' }); i++; continue; }
    if (ch === '<') { tokens.push({ type: 'op', value: '<' }); i++; continue; }
    if (ch === '!') { tokens.push({ type: 'op', value: '!' }); i++; continue; }

    // String literals: 'foo' or "foo". Backslash escapes for the same quote and backslash.
    if (ch === '"' || ch === "'") {
      const quote = ch;
      i++;
      let value = '';
      let closed = false;
      while (i < len) {
        const c = input[i];
        if (c === '\\' && i + 1 < len) {
          const next = input[i + 1];
          if (next === quote || next === '\\') {
            value += next;
            i += 2;
            continue;
          }
          if (next === 'n') { value += '\n'; i += 2; continue; }
          if (next === 't') { value += '\t'; i += 2; continue; }
          // Unknown escape — fail rather than guess.
          return null;
        }
        if (c === quote) {
          closed = true;
          i++;
          break;
        }
        value += c;
        i++;
      }
      if (!closed) return null;
      tokens.push({ type: 'string', value });
      continue;
    }

    // Numbers: integers and floats. No scientific notation, no leading `+`/`-`.
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < len && input[j] >= '0' && input[j] <= '9') j++;
      if (j < len && input[j] === '.') {
        j++;
        const digitStart = j;
        while (j < len && input[j] >= '0' && input[j] <= '9') j++;
        if (j === digitStart) return null; // trailing dot with no digits
      }
      const num = Number(input.slice(i, j));
      if (!Number.isFinite(num)) return null;
      tokens.push({ type: 'number', value: num });
      i = j;
      continue;
    }

    // Identifiers / keywords.
    if (isIdentStart(ch)) {
      let j = i + 1;
      while (j < len && isIdentPart(input[j])) j++;
      const word = input.slice(i, j);
      i = j;
      if (word === 'true') tokens.push({ type: 'true' });
      else if (word === 'false') tokens.push({ type: 'false' });
      else if (word === 'null') tokens.push({ type: 'null' });
      else tokens.push({ type: 'ident', value: word });
      continue;
    }

    // Unknown character.
    return null;
  }

  return tokens;
}

function isIdentStart(c: string): boolean {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_' || c === '$';
}

function isIdentPart(c: string): boolean {
  return isIdentStart(c) || (c >= '0' && c <= '9');
}

// --- Parser ------------------------------------------------------------------

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  peek(): Token | undefined {
    return this.tokens[this.pos];
  }

  consume(): Token | undefined {
    return this.tokens[this.pos++];
  }

  expect(type: Token['type']): Token | null {
    const tok = this.peek();
    if (!tok || tok.type !== type) return null;
    this.pos++;
    return tok;
  }

  eof(): boolean {
    return this.pos >= this.tokens.length;
  }

  // Precedence (low to high): || , && , equality , comparison , unary ! , primary
  parseOr(): ConditionNode | null {
    let left = this.parseAnd();
    if (!left) return null;
    while (this.matchOp('||')) {
      const right = this.parseAnd();
      if (!right) return null;
      left = { kind: 'binary', op: '||', left, right };
    }
    return left;
  }

  parseAnd(): ConditionNode | null {
    let left = this.parseEquality();
    if (!left) return null;
    while (this.matchOp('&&')) {
      const right = this.parseEquality();
      if (!right) return null;
      left = { kind: 'binary', op: '&&', left, right };
    }
    return left;
  }

  parseEquality(): ConditionNode | null {
    let left = this.parseComparison();
    if (!left) return null;
    while (true) {
      const op = this.matchOneOp(['===', '!==', '==', '!=']);
      if (!op) break;
      const right = this.parseComparison();
      if (!right) return null;
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  parseComparison(): ConditionNode | null {
    let left = this.parseUnary();
    if (!left) return null;
    while (true) {
      const op = this.matchOneOp(['>=', '<=', '>', '<']);
      if (!op) break;
      const right = this.parseUnary();
      if (!right) return null;
      left = { kind: 'binary', op, left, right };
    }
    return left;
  }

  parseUnary(): ConditionNode | null {
    if (this.matchOp('!')) {
      const operand = this.parseUnary();
      if (!operand) return null;
      return { kind: 'unary', op: '!', operand };
    }
    return this.parsePrimary();
  }

  parsePrimary(): ConditionNode | null {
    const tok = this.peek();
    if (!tok) return null;
    if (tok.type === 'lparen') {
      this.consume();
      const child = this.parseOr();
      if (!child) return null;
      if (!this.expect('rparen')) return null;
      return { kind: 'group', child };
    }
    if (tok.type === 'number') { this.consume(); return { kind: 'literal', value: tok.value }; }
    if (tok.type === 'string') { this.consume(); return { kind: 'literal', value: tok.value }; }
    if (tok.type === 'true') { this.consume(); return { kind: 'literal', value: true }; }
    if (tok.type === 'false') { this.consume(); return { kind: 'literal', value: false }; }
    if (tok.type === 'null') { this.consume(); return { kind: 'literal', value: null }; }
    if (tok.type === 'ident') {
      this.consume();
      const segments = [tok.value];
      while (this.peek()?.type === 'dot') {
        this.consume();
        const next = this.peek();
        if (!next || next.type !== 'ident') return null;
        this.consume();
        segments.push(next.value);
      }
      return { kind: 'path', segments };
    }
    return null;
  }

  private matchOp(op: BinaryOp | '!'): boolean {
    const tok = this.peek();
    if (tok && tok.type === 'op' && tok.value === op) {
      this.consume();
      return true;
    }
    return false;
  }

  private matchOneOp<T extends BinaryOp>(ops: readonly T[]): T | null {
    const tok = this.peek();
    if (!tok || tok.type !== 'op') return null;
    for (const op of ops) {
      if (tok.value === op) {
        this.consume();
        return op;
      }
    }
    return null;
  }
}

export function parseCondition(input: string): ConditionNode | null {
  if (typeof input !== 'string') return null;
  const trimmed = input.trim();
  if (!trimmed) return null;
  const tokens = tokenize(trimmed);
  if (!tokens || tokens.length === 0) return null;
  const parser = new Parser(tokens);
  const node = parser.parseOr();
  if (!node) return null;
  if (!parser.eof()) return null;
  return node;
}

// --- Evaluator ---------------------------------------------------------------

/**
 * Resolve a dotted path against the eval context.
 *
 * Precedence:
 *   1. `variables.*` — explicit namespace, reads from `ctx.variables`.
 *   2. `outputs.*`   — explicit namespace, reads from `ctx.outputs` (prior step outputs).
 *   3. `loop.*`      — explicit namespace, populated only inside a loop body.
 *   4. Bare identifier (no namespace) — falls back to `ctx.variables` ONLY.
 *
 * FOOTGUN: bare identifiers do NOT consult `ctx.outputs`. A condition like
 *   `digest === "ok"`
 * looks at `variables.digest`, NOT at any step output named `digest`. If you
 * want to read a prior step's output, always use the explicit namespace:
 *   `outputs.digest === "ok"`.
 *
 * The bare-name fallback exists for backwards compatibility with the legacy
 * `{ variable: 'flag', equals: true }` condition shape, which only ever read
 * from the trigger/variables bag.
 */
function resolvePath(segments: string[], ctx: EvalContext): unknown {
  if (segments.length === 0) return undefined;
  const [root, ...rest] = segments;
  let cursor: unknown;
  if (root === 'variables') cursor = ctx.variables;
  else if (root === 'outputs') cursor = ctx.outputs;
  else if (root === 'loop') cursor = ctx.loop;
  else {
    // Bare identifiers (no namespace) fall back to variables — convenient for the
    // legacy `{ variable: 'x' }` mental model written inline as `x === "y"`.
    // NOTE: this intentionally does NOT consult `ctx.outputs`; see doc comment above.
    cursor = ctx.variables[root];
    for (const seg of rest) {
      if (cursor === null || cursor === undefined) return undefined;
      if (typeof cursor !== 'object') return undefined;
      cursor = (cursor as Record<string, unknown>)[seg];
    }
    return cursor;
  }
  for (const seg of rest) {
    if (cursor === null || cursor === undefined) return undefined;
    if (typeof cursor !== 'object') return undefined;
    cursor = (cursor as Record<string, unknown>)[seg];
  }
  return cursor;
}

export function evaluateCondition(node: ConditionNode, ctx: EvalContext): unknown {
  switch (node.kind) {
    case 'literal':
      return node.value;
    case 'path':
      return resolvePath(node.segments, ctx);
    case 'group':
      return evaluateCondition(node.child, ctx);
    case 'unary':
      return !evaluateCondition(node.operand, ctx);
    case 'binary': {
      // Short-circuit logical ops match JS semantics so `a || b` returns whichever side wins.
      if (node.op === '||') {
        const l = evaluateCondition(node.left, ctx);
        return l ? l : evaluateCondition(node.right, ctx);
      }
      if (node.op === '&&') {
        const l = evaluateCondition(node.left, ctx);
        return l ? evaluateCondition(node.right, ctx) : l;
      }
      const l = evaluateCondition(node.left, ctx);
      const r = evaluateCondition(node.right, ctx);
      if (node.op === '===' || node.op === '==') return l === r;
      if (node.op === '!==' || node.op === '!=') return l !== r;
      // Numeric comparators require both operands to be finite numbers — refuse to coerce
      // so `"5" > 3` is false rather than silently true.
      if (typeof l !== 'number' || typeof r !== 'number') return false;
      if (!Number.isFinite(l) || !Number.isFinite(r)) return false;
      if (node.op === '>') return l > r;
      if (node.op === '<') return l < r;
      if (node.op === '>=') return l >= r;
      if (node.op === '<=') return l <= r;
      return false;
    }
  }
}

export function evalConditionString(input: string, ctx: EvalContext): boolean {
  const node = parseCondition(input);
  if (!node) return false;
  return Boolean(evaluateCondition(node, ctx));
}
