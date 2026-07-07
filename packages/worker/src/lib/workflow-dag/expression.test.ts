import { describe, it, expect } from 'vitest';
import {
  parseExpression,
  evaluateExpression,
  parseTemplate,
  renderTemplate,
  renderJsonTemplates,
  TemplateParseError,
  TemplateEvalError,
} from './expression.js';

const ctx = {
  trigger: { data: { email: 'a@b.com', priority: 'high', count: 3, region: 'us-east' } },
  nodes: {
    extract: { data: { customerEmail: 'c@d.com', tags: ['urgent', 'billing'] } },
    decide: { data: { result: true } },
  },
  item: { name: 'foo' },
  index: 2,
};

describe('parseExpression + evaluateExpression', () => {
  it('reads dotted paths from trigger and nodes', () => {
    expect(evaluateExpression(parseExpression('trigger.data.email'), ctx)).toBe('a@b.com');
    expect(evaluateExpression(parseExpression('nodes.extract.data.customerEmail'), ctx)).toBe('c@d.com');
  });

  it('does not expose a legacy inputs context', () => {
    expect(evaluateExpression(parseExpression('inputs.region'), ctx)).toBeUndefined();
  });

  it('supports foreach aliases', () => {
    expect(evaluateExpression(parseExpression('item.name'), ctx)).toBe('foo');
    expect(evaluateExpression(parseExpression('index'), ctx)).toBe(2);
  });

  it('returns undefined for missing paths', () => {
    expect(evaluateExpression(parseExpression('trigger.data.missing'), ctx)).toBeUndefined();
    expect(evaluateExpression(parseExpression('nodes.gone.data.x'), ctx)).toBeUndefined();
  });

  it('parses literals', () => {
    expect(evaluateExpression(parseExpression('"hello"'), ctx)).toBe('hello');
    expect(evaluateExpression(parseExpression("'world'"), ctx)).toBe('world');
    expect(evaluateExpression(parseExpression('42'), ctx)).toBe(42);
    expect(evaluateExpression(parseExpression('-5'), ctx)).toBe(-5);
    expect(evaluateExpression(parseExpression('true'), ctx)).toBe(true);
    expect(evaluateExpression(parseExpression('false'), ctx)).toBe(false);
    expect(evaluateExpression(parseExpression('null'), ctx)).toBeNull();
  });

  it('evaluates equality and comparison', () => {
    expect(evaluateExpression(parseExpression('trigger.data.priority == "high"'), ctx)).toBe(true);
    expect(evaluateExpression(parseExpression('trigger.data.priority != "low"'), ctx)).toBe(true);
    expect(evaluateExpression(parseExpression('trigger.data.count > 1'), ctx)).toBe(true);
    expect(evaluateExpression(parseExpression('trigger.data.count <= 3'), ctx)).toBe(true);
    expect(evaluateExpression(parseExpression('trigger.data.count < 3'), ctx)).toBe(false);
  });

  it('treats null and undefined as equal in ==', () => {
    expect(evaluateExpression(parseExpression('trigger.data.missing == null'), ctx)).toBe(true);
  });

  it('short-circuits && and ||', () => {
    expect(evaluateExpression(parseExpression('true && trigger.data.count'), ctx)).toBe(3);
    expect(evaluateExpression(parseExpression('false && bogus.path'), ctx)).toBe(false);
    expect(evaluateExpression(parseExpression('null || "fallback"'), ctx)).toBe('fallback');
  });

  it('supports unary not', () => {
    expect(evaluateExpression(parseExpression('!false'), ctx)).toBe(true);
    expect(evaluateExpression(parseExpression('!trigger.data.missing'), ctx)).toBe(true);
  });

  it('supports `in` membership for arrays, strings, objects', () => {
    expect(evaluateExpression(parseExpression('"urgent" in nodes.extract.data.tags'), ctx)).toBe(true);
    expect(evaluateExpression(parseExpression('"missing" in nodes.extract.data.tags'), ctx)).toBe(false);
    expect(evaluateExpression(parseExpression('"data" in nodes.extract'), ctx)).toBe(true);
    expect(evaluateExpression(parseExpression('"email" in "a@b.com"'), ctx)).toBe(false);
  });

  it('supports exists(path)', () => {
    expect(evaluateExpression(parseExpression('exists(trigger.data.email)'), ctx)).toBe(true);
    expect(evaluateExpression(parseExpression('exists(trigger.data.missing)'), ctx)).toBe(false);
    expect(evaluateExpression(parseExpression('exists(nodes.gone.x)'), ctx)).toBe(false);
  });

  it('handles parentheses for precedence', () => {
    expect(evaluateExpression(parseExpression('(1 < 2) && (3 > 2)'), ctx)).toBe(true);
    expect(evaluateExpression(parseExpression('!(1 == 2)'), ctx)).toBe(true);
  });

  it('rejects malformed expressions at parse time', () => {
    expect(() => parseExpression('trigger.data.')).toThrow(TemplateParseError);
    expect(() => parseExpression('trigger.data ==')).toThrow();
    expect(() => parseExpression('"unterminated')).toThrow();
  });
});

describe('parseTemplate + renderTemplate', () => {
  it('preserves structured values for single-template fields', () => {
    expect(renderTemplate('{{trigger.data}}', ctx)).toEqual({
      email: 'a@b.com',
      priority: 'high',
      count: 3,
      region: 'us-east',
    });
    expect(renderTemplate('{{nodes.extract.data.tags}}', ctx)).toEqual(['urgent', 'billing']);
    expect(renderTemplate('{{trigger.data.count}}', ctx)).toBe(3);
    expect(renderTemplate('{{trigger.data.priority}}', ctx)).toBe('high');
  });

  it('returns null for a single-template undefined field', () => {
    expect(renderTemplate('{{trigger.data.missing}}', ctx)).toBeNull();
    expect(renderTemplate('{{nodes.gone.x}}', ctx)).toBeNull();
  });

  it('stringifies undefined to empty string in mixed-text templates', () => {
    expect(renderTemplate('Hello {{trigger.data.missing}}!', ctx)).toBe('Hello !');
  });

  it('JSON-stringifies objects and arrays in mixed-text templates', () => {
    expect(renderTemplate('tags: {{nodes.extract.data.tags}}', ctx)).toBe('tags: ["urgent","billing"]');
    expect(renderTemplate('payload: {{trigger.data}}', ctx)).toBe(
      'payload: {"email":"a@b.com","priority":"high","count":3,"region":"us-east"}',
    );
  });

  it('converts primitives in mixed-text templates', () => {
    expect(renderTemplate('count={{trigger.data.count}}', ctx)).toBe('count=3');
    expect(renderTemplate('flag={{nodes.decide.data.result}}', ctx)).toBe('flag=true');
  });

  it('handles multiple interpolations in a mixed-text template', () => {
    expect(renderTemplate('{{trigger.data.priority}}:{{trigger.data.count}}', ctx)).toBe('high:3');
  });

  it('rejects malformed template at parse time', () => {
    expect(() => parseTemplate('Hello {{trigger.data')).toThrow(TemplateParseError);
    expect(() => renderTemplate('{{trigger.data.', ctx)).toThrow(TemplateParseError);
  });

  it('returns the source unchanged when no templates are present', () => {
    expect(renderTemplate('plain string', ctx)).toBe('plain string');
  });
});

describe('renderJsonTemplates', () => {
  it('recursively renders string fields in objects and arrays', () => {
    const out = renderJsonTemplates(
      {
        to: '{{trigger.data.email}}',
        meta: { region: '{{trigger.data.region}}' },
        tags: ['{{trigger.data.priority}}', 'fixed'],
        count: 99,
      },
      ctx,
    );
    expect(out).toEqual({
      to: 'a@b.com',
      meta: { region: 'us-east' },
      tags: ['high', 'fixed'],
      count: 99,
    });
  });

  it('preserves structured single-template values inside nested fields', () => {
    const out = renderJsonTemplates({ tags: '{{nodes.extract.data.tags}}' }, ctx);
    expect(out).toEqual({ tags: ['urgent', 'billing'] });
  });
});

describe('runtime evaluation errors', () => {
  it('throws TemplateEvalError when comparing mixed types', () => {
    expect(() => evaluateExpression(parseExpression('trigger.data.priority < 5'), ctx)).toThrow(
      TemplateEvalError,
    );
  });
});

describe('exists() edge cases', () => {
  it('returns true when the key exists but the value is falsy', () => {
    const c = { trigger: { data: { flag: false, n: 0, s: '' } } };
    expect(evaluateExpression(parseExpression('exists(trigger.data.flag)'), c)).toBe(true);
    expect(evaluateExpression(parseExpression('exists(trigger.data.n)'), c)).toBe(true);
    expect(evaluateExpression(parseExpression('exists(trigger.data.s)'), c)).toBe(true);
  });

  it('returns false when the value is explicitly undefined', () => {
    const c = { trigger: { data: { x: undefined } } };
    expect(evaluateExpression(parseExpression('exists(trigger.data.x)'), c)).toBe(false);
  });
});

describe('bracket subscripts', () => {
  const c = {
    nodes: {
      x: {
        'weird-key': 'hi',
        items: [{ name: 'first' }, { name: 'second' }],
      },
    },
  };

  it('supports numeric bracket subscripts', () => {
    expect(evaluateExpression(parseExpression('nodes.x.items[0].name'), c)).toBe('first');
    expect(evaluateExpression(parseExpression('nodes.x.items[1].name'), c)).toBe('second');
  });

  it('supports string-literal bracket subscripts for keys identifiers cannot express', () => {
    expect(evaluateExpression(parseExpression('nodes.x["weird-key"]'), c)).toBe('hi');
    expect(evaluateExpression(parseExpression("nodes.x['weird-key']"), c)).toBe('hi');
  });

  it('rejects empty bracket subscripts at parse time', () => {
    expect(() => parseExpression('nodes.x[]')).toThrow(TemplateParseError);
  });
});

describe('parseTemplate handles closing brace inside string literals', () => {
  it('does not stop at }} inside a quoted string in the expression', () => {
    // {{"a }} b"}} → a single template whose expression is the string "a }} b"
    const out = renderTemplate('{{"a }} b"}}', {});
    expect(out).toBe('a }} b');
  });

  it('handles single-quoted strings with }} inside', () => {
    expect(renderTemplate("{{'x}}y'}}", {})).toBe('x}}y');
  });

  it('handles escaped quotes inside strings', () => {
    expect(renderTemplate('{{"a\\"b}}c"}}', {})).toBe('a"b}}c');
  });
});

describe('parseTemplate isSingle with whitespace', () => {
  it('treats `  {{x}}  ` as a single-template field for structured-value preservation', () => {
    const c = { trigger: { data: { obj: { a: 1 } } } };
    expect(renderTemplate('  {{trigger.data.obj}}  ', c)).toEqual({ a: 1 });
  });

  it('does NOT treat mixed text as single even when one template is present', () => {
    const c = { trigger: { data: { obj: { a: 1 } } } };
    expect(renderTemplate('prefix {{trigger.data.obj}}', c)).toBe('prefix {"a":1}');
  });
});
