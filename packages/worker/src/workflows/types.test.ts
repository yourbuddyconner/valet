import { describe, it, expect } from 'vitest';
import { iterationSuffix, NO_RETRY, CancelledError } from './types.js';

describe('iterationSuffix', () => {
  it('returns empty string when aliases is undefined (top-level node)', () => {
    expect(iterationSuffix(undefined)).toBe('');
  });

  it('returns empty string when aliases lacks __iterationIndex', () => {
    expect(iterationSuffix({ item: 'a', index: 0 })).toBe('');
  });

  it('returns :i:N when __iterationIndex is present', () => {
    expect(iterationSuffix({ __iterationIndex: 0 })).toBe(':i:0');
    expect(iterationSuffix({ __iterationIndex: 7 })).toBe(':i:7');
  });

  it('ignores non-number __iterationIndex values (defensive)', () => {
    expect(iterationSuffix({ __iterationIndex: '3' })).toBe('');
    expect(iterationSuffix({ __iterationIndex: null })).toBe('');
  });
});

describe('NO_RETRY', () => {
  it('has limit:1 + delay:1 second to floor CF Workflows minimum-retry policy', () => {
    expect(NO_RETRY.limit).toBe(1);
    expect(NO_RETRY.delay).toBe('1 second');
  });
});

describe('CancelledError', () => {
  it('extends Error with name=CancelledError so runtime instanceof checks work', () => {
    const err = new CancelledError('cancelled by user');
    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(CancelledError);
    expect(err.name).toBe('CancelledError');
    expect(err.message).toBe('cancelled by user');
  });
});
