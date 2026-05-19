import { describe, expect, it } from 'vitest';
import { filterChildSessionEventsForThread, getEffectiveActiveThreadId } from './thread-selection';

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

describe('filterChildSessionEventsForThread', () => {
  it('keeps only child session events for the active thread', () => {
    const events = [
      { childSessionId: 'child-a', timestamp: 1, threadId: 'thread-a' },
      { childSessionId: 'child-b', timestamp: 2, threadId: 'thread-b' },
    ];

    expect(filterChildSessionEventsForThread(events, 'thread-a')).toEqual([
      { childSessionId: 'child-a', timestamp: 1, threadId: 'thread-a' },
    ]);
  });

  it('hides legacy unscoped child session events while a thread is active', () => {
    const events = [
      { childSessionId: 'legacy-child', timestamp: 1 },
      { childSessionId: 'thread-child', timestamp: 2, threadId: 'thread-a' },
    ];

    expect(filterChildSessionEventsForThread(events, 'thread-a')).toEqual([
      { childSessionId: 'thread-child', timestamp: 2, threadId: 'thread-a' },
    ]);
  });

  it('keeps all child session events when no thread is active', () => {
    const events = [
      { childSessionId: 'legacy-child', timestamp: 1 },
      { childSessionId: 'thread-child', timestamp: 2, threadId: 'thread-a' },
    ];

    expect(filterChildSessionEventsForThread(events, null)).toEqual(events);
  });
});
