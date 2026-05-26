import { describe, it, expect } from 'vitest';
import { appendIterationSegment, parseIterationPath } from './iteration-path.js';

describe('appendIterationSegment', () => {
  it('returns the segment alone when the parent path is empty', () => {
    expect(appendIterationSegment('', 'loopA', 'i0')).toBe('loopA:i0');
  });

  it('joins segments with /', () => {
    expect(appendIterationSegment('parA:b1', 'loopA', 'i0')).toBe('parA:b1/loopA:i0');
  });

  it('rejects discriminators with slashes or colons', () => {
    expect(() => appendIterationSegment('', 'loopA', 'i:0')).toThrow();
    expect(() => appendIterationSegment('', 'loopA', 'i/0')).toThrow();
  });

  it('rejects step ids with slashes or colons', () => {
    expect(() => appendIterationSegment('', 'loop:A', 'i0')).toThrow();
  });
});

describe('parseIterationPath', () => {
  it('returns [] for empty', () => {
    expect(parseIterationPath('')).toEqual([]);
  });

  it('parses nested segments', () => {
    expect(parseIterationPath('parA:b1/loopA:i0')).toEqual([
      { containerStepId: 'parA', discriminator: 'b1' },
      { containerStepId: 'loopA', discriminator: 'i0' },
    ]);
  });
});
