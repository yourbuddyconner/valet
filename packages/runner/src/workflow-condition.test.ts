import { describe, it, expect } from 'bun:test';
import {
  parseCondition,
  evaluateCondition,
  evalConditionString,
  type EvalContext,
} from './workflow-condition.js';

const emptyCtx: EvalContext = { variables: {}, outputs: {} };

function ctx(partial: Partial<EvalContext>): EvalContext {
  return {
    variables: partial.variables ?? {},
    outputs: partial.outputs ?? {},
    loop: partial.loop,
  };
}

describe('parseCondition', () => {
  it('parses boolean literals', () => {
    expect(parseCondition('true')).not.toBeNull();
    expect(parseCondition('false')).not.toBeNull();
  });

  it('parses simple number comparison', () => {
    const node = parseCondition('1 > 0');
    expect(node).not.toBeNull();
  });

  it('parses grouped expressions', () => {
    expect(parseCondition('(a > 0) && (b !== "x")')).not.toBeNull();
  });

  it('returns null on empty input', () => {
    expect(parseCondition('')).toBeNull();
    expect(parseCondition('   ')).toBeNull();
  });

  it('returns null on unclosed paren', () => {
    expect(parseCondition('(unclosed')).toBeNull();
  });

  it('returns null on `1 + + 2` (no addition + double unary)', () => {
    // We do not support arithmetic at all; `+` is not a token.
    expect(parseCondition('1 + + 2')).toBeNull();
  });

  it('returns null on unclosed string', () => {
    expect(parseCondition('"hello')).toBeNull();
  });

  it('returns null on trailing operator', () => {
    expect(parseCondition('1 >')).toBeNull();
  });

  it('returns null on dangling dot', () => {
    expect(parseCondition('outputs.')).toBeNull();
  });

  it('returns null on unknown character', () => {
    expect(parseCondition('a ^ b')).toBeNull();
  });
});

describe('evalConditionString — literals', () => {
  it('evaluates `true`', () => {
    expect(evalConditionString('true', emptyCtx)).toBe(true);
  });
  it('evaluates `false`', () => {
    expect(evalConditionString('false', emptyCtx)).toBe(false);
  });
  it('evaluates `null` as falsy', () => {
    expect(evalConditionString('null', emptyCtx)).toBe(false);
  });
  it('evaluates a bare number as its truthiness', () => {
    expect(evalConditionString('42', emptyCtx)).toBe(true);
    expect(evalConditionString('0', emptyCtx)).toBe(false);
  });
});

describe('evalConditionString — number comparisons', () => {
  it('`1 > 0` is true', () => {
    expect(evalConditionString('1 > 0', emptyCtx)).toBe(true);
  });
  it('`1 < 0` is false', () => {
    expect(evalConditionString('1 < 0', emptyCtx)).toBe(false);
  });
  it('`5 >= 5` is true', () => {
    expect(evalConditionString('5 >= 5', emptyCtx)).toBe(true);
  });
  it('`5 <= 4` is false', () => {
    expect(evalConditionString('5 <= 4', emptyCtx)).toBe(false);
  });
  it('handles floats', () => {
    expect(evalConditionString('3.14 > 3', emptyCtx)).toBe(true);
  });
});

describe('evalConditionString — string equality', () => {
  it('`"x" === "x"` is true', () => {
    expect(evalConditionString('"x" === "x"', emptyCtx)).toBe(true);
  });
  it('`"x" !== "y"` is true', () => {
    expect(evalConditionString('"x" !== "y"', emptyCtx)).toBe(true);
  });
  it('single-quoted strings work', () => {
    expect(evalConditionString("'hi' === 'hi'", emptyCtx)).toBe(true);
  });
  it('== behaves like ===', () => {
    expect(evalConditionString('"5" == 5', emptyCtx)).toBe(false);
  });
});

describe('evalConditionString — path resolution', () => {
  it('resolves variables.x', () => {
    expect(evalConditionString('variables.x === 1', ctx({ variables: { x: 1 } }))).toBe(true);
  });
  it('resolves outputs.foo.bar', () => {
    expect(
      evalConditionString('outputs.foo.bar === "baz"', ctx({ outputs: { foo: { bar: 'baz' } } })),
    ).toBe(true);
  });
  it('resolves loop.item', () => {
    expect(evalConditionString('loop.item === "a"', ctx({ loop: { item: 'a', index: 0 } }))).toBe(true);
  });
  it('resolves loop.index', () => {
    expect(evalConditionString('loop.index > 0', ctx({ loop: { item: 'a', index: 3 } }))).toBe(true);
  });
});

describe('evalConditionString — path comparisons', () => {
  it('outputs.failed > 0', () => {
    expect(evalConditionString('outputs.failed > 0', ctx({ outputs: { failed: 2 } }))).toBe(true);
    expect(evalConditionString('outputs.failed > 0', ctx({ outputs: { failed: 0 } }))).toBe(false);
  });
  it('variables.name === "alice"', () => {
    expect(
      evalConditionString('variables.name === "alice"', ctx({ variables: { name: 'alice' } })),
    ).toBe(true);
    expect(
      evalConditionString('variables.name === "alice"', ctx({ variables: { name: 'bob' } })),
    ).toBe(false);
  });
});

describe('evalConditionString — logical operators', () => {
  it('a > 0 && b < 10', () => {
    expect(
      evalConditionString('variables.a > 0 && variables.b < 10', ctx({ variables: { a: 1, b: 5 } })),
    ).toBe(true);
    expect(
      evalConditionString('variables.a > 0 && variables.b < 10', ctx({ variables: { a: 0, b: 5 } })),
    ).toBe(false);
  });
  it('a || b', () => {
    expect(evalConditionString('variables.a || variables.b', ctx({ variables: { a: 0, b: 1 } }))).toBe(true);
    expect(evalConditionString('variables.a || variables.b', ctx({ variables: { a: 0, b: 0 } }))).toBe(false);
  });
  it('!ready negates truthy', () => {
    expect(evalConditionString('!variables.ready', ctx({ variables: { ready: true } }))).toBe(false);
    expect(evalConditionString('!variables.ready', ctx({ variables: { ready: false } }))).toBe(true);
  });
  it('!! double-negation', () => {
    expect(evalConditionString('!!variables.x', ctx({ variables: { x: 'truthy' } }))).toBe(true);
  });
});

describe('evalConditionString — grouping', () => {
  it('(a > 0) && (b !== "x")', () => {
    expect(
      evalConditionString(
        '(variables.a > 0) && (variables.b !== "x")',
        ctx({ variables: { a: 1, b: 'y' } }),
      ),
    ).toBe(true);
  });
  it('precedence: a || b && c — && binds tighter', () => {
    // false || (true && false) === false; without grouping this confirms precedence.
    expect(
      evalConditionString(
        'variables.a || variables.b && variables.c',
        ctx({ variables: { a: false, b: true, c: false } }),
      ),
    ).toBe(false);
  });
});

describe('evalConditionString — truthy fallback', () => {
  it('bare path returns truthiness of value', () => {
    expect(evalConditionString('outputs.list', ctx({ outputs: { list: [1, 2] } }))).toBe(true);
    expect(evalConditionString('outputs.list', ctx({ outputs: { list: null } }))).toBe(false);
  });
  it('missing path is falsy without throwing', () => {
    expect(evalConditionString('outputs.does.not.exist', emptyCtx)).toBe(false);
  });
  it('missing path in comparison returns false (no coercion)', () => {
    expect(evalConditionString('outputs.missing > 0', emptyCtx)).toBe(false);
  });
});

describe('evalConditionString — error handling', () => {
  it('parse error returns false', () => {
    expect(evalConditionString('(unclosed', emptyCtx)).toBe(false);
  });
  it('empty string returns false', () => {
    expect(evalConditionString('', emptyCtx)).toBe(false);
  });
  it('whitespace-only returns false', () => {
    expect(evalConditionString('   ', emptyCtx)).toBe(false);
  });
});

describe('evalConditionString — real LLM-drafted examples', () => {
  it('outputs.list_runs.failed > 0', () => {
    expect(
      evalConditionString('outputs.list_runs.failed > 0', ctx({ outputs: { list_runs: { failed: 3 } } })),
    ).toBe(true);
    expect(
      evalConditionString('outputs.list_runs.failed > 0', ctx({ outputs: { list_runs: { failed: 0 } } })),
    ).toBe(false);
  });
  it('variables.priority === "high" && outputs.review.approved', () => {
    expect(
      evalConditionString(
        'variables.priority === "high" && outputs.review.approved',
        ctx({ variables: { priority: 'high' }, outputs: { review: { approved: true } } }),
      ),
    ).toBe(true);
    expect(
      evalConditionString(
        'variables.priority === "high" && outputs.review.approved',
        ctx({ variables: { priority: 'low' }, outputs: { review: { approved: true } } }),
      ),
    ).toBe(false);
  });
  it('!outputs.list || outputs.list.length === 0', () => {
    expect(
      evalConditionString(
        '!outputs.list || outputs.list.length === 0',
        ctx({ outputs: {} }),
      ),
    ).toBe(true);
    expect(
      evalConditionString(
        '!outputs.list || outputs.list.length === 0',
        ctx({ outputs: { list: { length: 0 } } }),
      ),
    ).toBe(true);
    expect(
      evalConditionString(
        '!outputs.list || outputs.list.length === 0',
        ctx({ outputs: { list: { length: 3 } } }),
      ),
    ).toBe(false);
  });
});

describe('evalConditionString — semantics docs', () => {
  it('refuses to coerce string > number (returns false)', () => {
    expect(
      evalConditionString('variables.s > 3', ctx({ variables: { s: '5' } })),
    ).toBe(false);
  });
  it('null === null', () => {
    expect(evalConditionString('null === null', emptyCtx)).toBe(true);
  });
  it('bare identifier resolves against variables', () => {
    expect(evalConditionString('x === 1', ctx({ variables: { x: 1 } }))).toBe(true);
  });
});

describe('evaluateCondition — direct AST eval', () => {
  it('returns short-circuited left operand for `||`', () => {
    const node = parseCondition('variables.x || variables.y');
    expect(node).not.toBeNull();
    if (!node) return;
    const result = evaluateCondition(node, ctx({ variables: { x: 'kept', y: 'fallback' } }));
    expect(result).toBe('kept');
  });
});
