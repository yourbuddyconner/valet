import { describe, expect, it } from 'vitest';
import { getIntegrationListDisplayState } from './integration-list-display';

describe('getIntegrationListDisplayState', () => {
  it('shows the add card grid when filters hide all configured integrations', () => {
    expect(getIntegrationListDisplayState({
      totalItems: 3,
      visibleItems: 0,
      canAddIntegration: true,
    })).toBe('grid');
  });

  it('shows the empty state when there are no integrations and no add action', () => {
    expect(getIntegrationListDisplayState({
      totalItems: 0,
      visibleItems: 0,
      canAddIntegration: false,
    })).toBe('empty');
  });

  it('shows no matches when filters hide all integrations and there is no add action', () => {
    expect(getIntegrationListDisplayState({
      totalItems: 2,
      visibleItems: 0,
      canAddIntegration: false,
    })).toBe('no-matches');
  });
});
