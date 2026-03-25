import { describe, expect, it } from 'vitest';
import { shouldShowToolCardSummary } from './index';

describe('shouldShowToolCardSummary', () => {
  it('keeps the detailed card open when an outer lazy boundary already consumed the first click', () => {
    expect(
      shouldShowToolCardSummary({
        engaged: false,
        initiallyEngaged: true,
      })
    ).toBe(false);
  });

  it('shows the summary card before any expansion intent exists', () => {
    expect(
      shouldShowToolCardSummary({
        engaged: false,
        initiallyEngaged: false,
      })
    ).toBe(true);
  });
});
