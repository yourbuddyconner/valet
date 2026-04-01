import { describe, expect, it } from 'vitest';
import { getThreadHistoryPages } from './-thread-history-pagination';

describe('getThreadHistoryPages', () => {
  it('returns a compact page window around the current page', () => {
    expect(getThreadHistoryPages(3, 10)).toEqual([1, 2, 3, 4, 5]);
    expect(getThreadHistoryPages(8, 10)).toEqual([6, 7, 8, 9, 10]);
  });

  it('caps the page window when total pages is smaller than the window size', () => {
    expect(getThreadHistoryPages(1, 3)).toEqual([1, 2, 3]);
  });
});
