export type IntegrationListDisplayState = 'empty' | 'no-matches' | 'grid';

interface IntegrationListDisplayInput {
  totalItems: number;
  visibleItems: number;
  canAddIntegration: boolean;
}

export function getIntegrationListDisplayState({
  totalItems,
  visibleItems,
  canAddIntegration,
}: IntegrationListDisplayInput): IntegrationListDisplayState {
  if (visibleItems > 0 || canAddIntegration) {
    return 'grid';
  }

  return totalItems === 0 ? 'empty' : 'no-matches';
}
