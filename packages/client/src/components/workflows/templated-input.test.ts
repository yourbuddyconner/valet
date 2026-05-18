import { describe, it, expect } from 'vitest';
import { tokenizeTemplate, findOpenToken } from './templated-input';

describe('tokenizeTemplate', () => {
  it('returns a single literal for plain text', () => {
    const out = tokenizeTemplate('hello world');
    expect(out).toEqual([
      { type: 'literal', text: 'hello world', start: 0, end: 11 },
    ]);
  });

  it('returns empty array for empty string', () => {
    expect(tokenizeTemplate('')).toEqual([]);
  });

  it('splits literal/token/literal', () => {
    const out = tokenizeTemplate('hi {{x}} bye');
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ type: 'literal', text: 'hi ' });
    expect(out[1]).toMatchObject({ type: 'token', path: 'x', text: '{{x}}' });
    expect(out[2]).toMatchObject({ type: 'literal', text: ' bye' });
  });

  it('trims whitespace inside token path', () => {
    const out = tokenizeTemplate('{{ outputs.foo }}');
    expect(out[0]).toMatchObject({ type: 'token', path: 'outputs.foo' });
  });

  it('treats unclosed {{ as part of trailing literal', () => {
    const out = tokenizeTemplate('foo {{x');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'literal', text: 'foo {{x' });
  });

  it('handles multiple tokens', () => {
    const out = tokenizeTemplate('{{a}}+{{b.c}}');
    expect(out).toHaveLength(3);
    expect(out[0]).toMatchObject({ type: 'token', path: 'a' });
    expect(out[1]).toMatchObject({ type: 'literal', text: '+' });
    expect(out[2]).toMatchObject({ type: 'token', path: 'b.c' });
  });

  it('represents empty token with path=""', () => {
    const out = tokenizeTemplate('{{}}');
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: 'token', path: '', text: '{{}}' });
  });

  it('records correct start/end offsets', () => {
    const src = 'a {{x}} b';
    const out = tokenizeTemplate(src);
    expect(src.slice(out[0].start, out[0].end)).toBe('a ');
    expect(src.slice(out[1].start, out[1].end)).toBe('{{x}}');
    expect(src.slice(out[2].start, out[2].end)).toBe(' b');
  });
});

describe('findOpenToken', () => {
  it('returns null when cursor is in plain text', () => {
    expect(findOpenToken('hello', 3)).toBeNull();
  });

  it('returns null when no {{ precedes cursor', () => {
    expect(findOpenToken('foo bar', 5)).toBeNull();
  });

  it('detects open token right after {{', () => {
    const r = findOpenToken('{{', 2);
    expect(r).toEqual({ start: 0, prefix: '' });
  });

  it('detects open token with prefix', () => {
    const r = findOpenToken('hi {{out', 8);
    expect(r).toEqual({ start: 3, prefix: 'out' });
  });

  it('returns null when token is already closed before cursor', () => {
    expect(findOpenToken('{{x}} more', 8)).toBeNull();
  });

  it('returns null when cursor is past a closing }}', () => {
    expect(findOpenToken('{{x}}', 5)).toBeNull();
  });

  it('rejects prefix containing }', () => {
    expect(findOpenToken('{{x}', 4)).toBeNull();
  });

  it('finds the latest open {{ when multiple exist', () => {
    // First token is closed; second is open.
    const r = findOpenToken('{{a}} {{b', 9);
    expect(r).toEqual({ start: 6, prefix: 'b' });
  });
});
