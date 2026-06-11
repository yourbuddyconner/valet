export interface ProviderModel {
  id: string;
  name: string;
}

export interface ProviderModelGroup {
  provider: string;
  models: ProviderModel[];
}

export interface FlatModel extends ProviderModel {
  provider: string;
}

export interface PreferredModelGroup {
  heading: string;
  source: 'user' | 'org';
  models: FlatModel[];
}

export function buildModelSelectorGroups({
  availableModels,
  userModelPreferences,
  orgModelPreferences,
}: {
  availableModels: ProviderModelGroup[];
  userModelPreferences?: string[];
  orgModelPreferences?: string[];
}): {
  preferredGroup: PreferredModelGroup | null;
  providerGroups: ProviderModelGroup[];
} {
  const flatModels = new Map<string, FlatModel>();
  for (const provider of availableModels) {
    for (const model of provider.models) {
      flatModels.set(model.id, { ...model, provider: provider.provider });
    }
  }

  const userPrefs = userModelPreferences ?? [];
  const orgPrefs = orgModelPreferences ?? [];
  const source: 'user' | 'org' | null =
    userPrefs.length > 0 ? 'user' : orgPrefs.length > 0 ? 'org' : null;
  const preferenceIds = source === 'user' ? userPrefs : source === 'org' ? orgPrefs : [];
  const seen = new Set<string>();
  const preferredModels: FlatModel[] = [];

  for (const id of preferenceIds) {
    if (seen.has(id)) continue;
    seen.add(id);
    const model = flatModels.get(id);
    if (model) preferredModels.push(model);
  }

  const pinnedIds = new Set(preferredModels.map((model) => model.id));
  const providerGroups = availableModels
    .map((provider) => ({
      provider: provider.provider,
      models: provider.models.filter((model) => !pinnedIds.has(model.id)),
    }))
    .filter((provider) => provider.models.length > 0);

  return {
    preferredGroup:
      source && preferredModels.length > 0
        ? {
            heading: source === 'user' ? 'Preferred models' : 'Org default models',
            source,
            models: preferredModels,
          }
        : null,
    providerGroups,
  };
}
