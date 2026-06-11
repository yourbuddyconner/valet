export interface FlatModel {
  id: string;
  name: string;
  provider: string;
}

export function getCustomModelCandidate({
  query,
  selectedModelIds,
  knownModels,
}: {
  query: string;
  selectedModelIds: string[];
  knownModels: FlatModel[];
}): string | null {
  const trimmed = query.trim();
  if (!trimmed || !trimmed.includes('/')) return null;
  if (selectedModelIds.includes(trimmed)) return null;
  if (knownModels.some((model) => model.id === trimmed)) return null;
  return trimmed;
}
