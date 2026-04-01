import { describe, expect, it } from 'vitest';
import { getEffectiveActiveThreadId } from './thread-selection';

describe('getEffectiveActiveThreadId', () => {
  it('prefers the route thread id over the server active thread id', () => {
    expect(getEffectiveActiveThreadId('historic-thread', 'current-session-thread')).toBe(
      'historic-thread'
    );
  });

  it('falls back to the server active thread id when the route has none', () => {
    expect(getEffectiveActiveThreadId(undefined, 'current-session-thread')).toBe(
      'current-session-thread'
    );
  });

  it('returns null when neither source has a thread id', () => {
    expect(getEffectiveActiveThreadId(undefined, undefined)).toBeNull();
  });
});
