import { describe, expect, it } from 'vitest';
import {
  evaluateMatcher,
  evaluateMatchers,
  parseStoredMatchers,
  readPath,
  validateParamMatchers,
} from './action-policy-matchers.js';

describe('readPath', () => {
  it('returns the params object for empty path', () => {
    expect(readPath({ a: 1 }, '')).toEqual({ a: 1 });
  });

  it('walks dotted segments', () => {
    expect(readPath({ a: { b: { c: 42 } } }, 'a.b.c')).toBe(42);
  });

  it('returns undefined for missing segments', () => {
    expect(readPath({ a: 1 }, 'a.b.c')).toBeUndefined();
    expect(readPath({}, 'a')).toBeUndefined();
  });

  it('walks numeric array indices', () => {
    expect(readPath({ items: [{ name: 'x' }, { name: 'y' }] }, 'items[1].name')).toBe('y');
  });

  it('handles null cursors gracefully', () => {
    expect(readPath({ a: null }, 'a.b')).toBeUndefined();
  });
});

describe('evaluateMatcher', () => {
  const params = {
    spreadsheetId: '1S2hM5Y1jB14posgQY4hJgflhJfucOLyEla8cJQWS7TY',
    range: 'Log!A1',
    count: 5,
    flag: true,
    nested: { tags: ['a', 'b'] },
  };

  it('eq / neq on primitives', () => {
    expect(evaluateMatcher({ path: 'spreadsheetId', op: 'eq', value: '1S2hM5Y1jB14posgQY4hJgflhJfucOLyEla8cJQWS7TY' }, params)).toBe(true);
    expect(evaluateMatcher({ path: 'spreadsheetId', op: 'eq', value: 'other' }, params)).toBe(false);
    expect(evaluateMatcher({ path: 'count', op: 'neq', value: 6 }, params)).toBe(true);
  });

  it('regex matches strings only', () => {
    expect(evaluateMatcher({ path: 'spreadsheetId', op: 'regex', value: '^1S2hM5' }, params)).toBe(true);
    expect(evaluateMatcher({ path: 'spreadsheetId', op: 'regex', value: 'nope$' }, params)).toBe(false);
    expect(evaluateMatcher({ path: 'count', op: 'regex', value: '^5$' }, params)).toBe(false);
  });

  it('regex fails closed on invalid regex', () => {
    expect(evaluateMatcher({ path: 'spreadsheetId', op: 'regex', value: '[' }, params)).toBe(false);
  });

  it('in / not_in', () => {
    expect(evaluateMatcher({ path: 'count', op: 'in', value: [1, 5, 10] }, params)).toBe(true);
    expect(evaluateMatcher({ path: 'count', op: 'not_in', value: [1, 2, 3] }, params)).toBe(true);
    expect(evaluateMatcher({ path: 'count', op: 'not_in', value: [5] }, params)).toBe(false);
  });

  it('numeric comparisons require both sides numeric', () => {
    expect(evaluateMatcher({ path: 'count', op: 'gt', value: 4 }, params)).toBe(true);
    expect(evaluateMatcher({ path: 'count', op: 'gte', value: 5 }, params)).toBe(true);
    expect(evaluateMatcher({ path: 'count', op: 'lt', value: 5 }, params)).toBe(false);
    expect(evaluateMatcher({ path: 'count', op: 'lte', value: 5 }, params)).toBe(true);
    expect(evaluateMatcher({ path: 'spreadsheetId', op: 'gt', value: 4 }, params)).toBe(false);
  });

  it('exists / not_exists', () => {
    expect(evaluateMatcher({ path: 'spreadsheetId', op: 'exists' }, params)).toBe(true);
    expect(evaluateMatcher({ path: 'missing', op: 'exists' }, params)).toBe(false);
    expect(evaluateMatcher({ path: 'missing', op: 'not_exists' }, params)).toBe(true);
  });

  it('walks nested paths', () => {
    expect(evaluateMatcher({ path: 'nested.tags[0]', op: 'eq', value: 'a' }, params)).toBe(true);
  });
});

describe('evaluateMatchers (AND semantics)', () => {
  const params = { spreadsheetId: '1S2hM5', range: 'Log!A1' };

  it('returns true on empty array', () => {
    expect(evaluateMatchers([], params)).toBe(true);
  });

  it('returns true when all pass', () => {
    expect(evaluateMatchers([
      { path: 'spreadsheetId', op: 'eq', value: '1S2hM5' },
      { path: 'range', op: 'regex', value: '^Log!' },
    ], params)).toBe(true);
  });

  it('returns false when any fails', () => {
    expect(evaluateMatchers([
      { path: 'spreadsheetId', op: 'eq', value: '1S2hM5' },
      { path: 'range', op: 'eq', value: 'wrong' },
    ], params)).toBe(false);
  });
});

describe('validateParamMatchers', () => {
  it('accepts well-formed input', () => {
    expect(validateParamMatchers([{ path: 'a', op: 'eq', value: 1 }])).toEqual([
      { path: 'a', op: 'eq', value: 1 },
    ]);
  });

  it('treats null/undefined as empty', () => {
    expect(validateParamMatchers(null)).toEqual([]);
    expect(validateParamMatchers(undefined)).toEqual([]);
  });

  it('rejects non-array input', () => {
    expect(() => validateParamMatchers({ path: 'a', op: 'eq', value: 1 })).toThrow(/array/);
  });

  it('rejects unknown ops', () => {
    expect(() => validateParamMatchers([{ path: 'a', op: 'magic' }])).toThrow(/op must be one of/);
  });

  it('requires value for value-bearing ops', () => {
    expect(() => validateParamMatchers([{ path: 'a', op: 'eq' }])).toThrow(/value is required/);
    expect(validateParamMatchers([{ path: 'a', op: 'exists' }])).toEqual([{ path: 'a', op: 'exists' }]);
  });

  it('requires array value for in/not_in', () => {
    expect(() => validateParamMatchers([{ path: 'a', op: 'in', value: 'x' }])).toThrow(/array/);
  });

  it('requires string value for regex', () => {
    expect(() => validateParamMatchers([{ path: 'a', op: 'regex', value: 123 }])).toThrow(/string/);
  });
});

describe('parseStoredMatchers', () => {
  it('returns empty array on missing / null / invalid JSON', () => {
    expect(parseStoredMatchers(null)).toEqual([]);
    expect(parseStoredMatchers('not json')).toEqual([]);
    expect(parseStoredMatchers('[{"bad": true}]')).toEqual([]);
  });

  it('roundtrips valid input', () => {
    const matchers = [{ path: 'x', op: 'eq' as const, value: 1 }];
    expect(parseStoredMatchers(JSON.stringify(matchers))).toEqual(matchers);
  });
});
