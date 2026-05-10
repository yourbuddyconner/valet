/**
 * Catalog of models the UI exposes in the model picker.
 *
 * This is intentionally small + curated — every entry must:
 *   - resolve via the engine's `resolveModelId` (i.e. exist in pi-ai's
 *     static registry, or be reachable via a faux registration in tests),
 *   - have a credible price/speed tradeoff worth picking between.
 *
 * When new Claude tiers ship, add them here. The wire is just a string id
 * so the engine stays decoupled from this list — it just resolves whatever
 * the user types.
 */
export interface ModelOption {
  id: string;
  label: string;
  description: string;
  /** Rough indicator for sorting / grouping. Lower = faster/cheaper. */
  tier: "fast" | "balanced" | "powerful";
}

export const MODEL_CATALOG: readonly ModelOption[] = [
  {
    id: "claude-haiku-4-5",
    label: "Haiku 4.5",
    description: "Fastest. Cheap. Good for everyday tasks and tool loops.",
    tier: "fast",
  },
  {
    id: "claude-sonnet-4-5",
    label: "Sonnet 4.5",
    description: "Balanced quality and speed. Good default for most work.",
    tier: "balanced",
  },
  {
    id: "claude-sonnet-4-6",
    label: "Sonnet 4.6",
    description: "Higher quality than 4.5; same shape, slightly slower.",
    tier: "balanced",
  },
  {
    id: "claude-opus-4-7",
    label: "Opus 4.7",
    description: "Strongest reasoning. Slower and pricier; pick for hard work.",
    tier: "powerful",
  },
];

export function findModel(id: string | undefined | null): ModelOption | undefined {
  if (!id) return undefined;
  return MODEL_CATALOG.find((m) => m.id === id);
}

export function modelLabel(id: string | undefined | null): string {
  const m = findModel(id);
  return m?.label ?? id ?? "Unknown";
}
