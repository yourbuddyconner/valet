/**
 * ModelCatalogService — resolves available models from D1 configs + external catalogs.
 *
 * This runs in the Worker (no sandbox required) so models are available
 * immediately after provider keys are configured.
 */

import type { AvailableModels, ProviderModels, CustomProviderModel } from '@valet/shared';
import type { AppDb } from '../lib/drizzle.js';
import type { Env } from '../env.js';
import { listOrgApiKeys, getAllCustomProvidersWithKeys, getCatalogCache, setCatalogCache } from '../lib/db/org.js';
import { decryptString } from '../lib/crypto.js';

const CACHE_TTL_SECONDS = 3600; // 1 hour
const MODELS_DEV_TIMEOUT = 15_000;
const PROBE_TIMEOUT = 10_000;

/** Display name mapping for built-in providers. */
const PROVIDER_DISPLAY_NAMES: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  google: 'Google',
  parallel: 'Parallel',
};

/** Built-in providers that can be configured via env vars (Worker secrets). */
const PROVIDER_ENV_KEYS: Array<{ provider: string; envKey: keyof Env }> = [
  { provider: 'anthropic', envKey: 'ANTHROPIC_API_KEY' },
  { provider: 'openai', envKey: 'OPENAI_API_KEY' },
  { provider: 'google', envKey: 'GOOGLE_API_KEY' },
  { provider: 'parallel', envKey: 'PARALLEL_API_KEY' },
];

/** Shape of a single model entry from models.dev/api.json */
interface CatalogModel {
  id: string;
  name: string;
  cost?: {
    input?: number;
    output?: number;
  };
  [key: string]: unknown;
}

/** Pricing info for a model, keyed by "provider/modelId" */
export interface ModelPricing {
  inputCostPerMillion: number;
  outputCostPerMillion: number;
}

/**
 * Get model pricing from cached catalog data.
 * Returns a Map keyed by "provider/modelId" with cost per million tokens.
 * Fetches from models.dev on cache miss to ensure pricing is available.
 */
export async function getModelPricing(
  db: AppDb,
  env: Env,
): Promise<Map<string, ModelPricing>> {
  const pricingMap = new Map<string, ModelPricing>();

  // Collect all provider IDs: built-in + custom
  const [orgKeys, customProviders] = await Promise.all([
    listOrgApiKeys(db),
    getAllCustomProvidersWithKeys(db),
  ]);
  const providerIds: string[] = [];

  for (const k of orgKeys) {
    providerIds.push(k.provider);
  }
  for (const { provider, envKey } of PROVIDER_ENV_KEYS) {
    if (!providerIds.includes(provider) && env[envKey]) {
      providerIds.push(provider);
    }
  }
  // Include custom providers (e.g. openrouter) for models.dev pricing lookup
  for (const cp of customProviders) {
    if (!providerIds.includes(cp.providerId)) {
      providerIds.push(cp.providerId);
    }
  }

  // Check per-provider caches in parallel
  const cacheResults = await Promise.all(
    providerIds.map(async (providerId) => {
      const models = await getCachedProviderModels(db, providerId);
      return [providerId, models] as const;
    }),
  );
  const cachedModels = new Map<string, CatalogModel[] | null>(cacheResults);

  // Determine which providers had cache misses and fetch from models.dev
  const cacheMisses = providerIds.filter((id) => !cachedModels.get(id));
  if (cacheMisses.length > 0) {
    const fetched = await fetchModelsDevProviders(db, cacheMisses);
    for (const providerId of cacheMisses) {
      cachedModels.set(providerId, fetched.get(providerId) ?? null);
    }
  }

  // Extract pricing from cached catalog data
  for (const providerId of providerIds) {
    const models = cachedModels.get(providerId);
    if (!models) continue;

    for (const model of models) {
      if (model.cost && (typeof model.cost.input === 'number' || typeof model.cost.output === 'number')) {
        const key = `${providerId}/${model.id}`;
        pricingMap.set(key, {
          inputCostPerMillion: model.cost.input ?? 0,
          outputCostPerMillion: model.cost.output ?? 0,
        });
      }
    }
  }

  return pricingMap;
}

function isCacheStale(cachedAt: number): boolean {
  const now = Math.floor(Date.now() / 1000);
  return now - cachedAt > CACHE_TTL_SECONDS;
}

/**
 * Fetch a single provider's model list from models.dev, with per-provider D1 caching.
 *
 * We fetch the full catalog but only parse + cache the provider we need.
 * To avoid re-fetching the full catalog for each provider, callers should
 * use fetchModelsDevProviders() which batches the fetch.
 */
async function getCachedProviderModels(
  db: AppDb,
  providerId: string,
): Promise<CatalogModel[] | null> {
  const cacheKey = `catalog:${providerId}`;
  const cached = await getCatalogCache(db, cacheKey);

  if (cached && !isCacheStale(cached.cachedAt)) {
    try {
      return JSON.parse(cached.data) as CatalogModel[];
    } catch {
      // Corrupted cache — return null to trigger re-fetch
      return null;
    }
  }

  // Return null to signal the caller should fetch from models.dev
  // Also return the stale data so the caller can use it as fallback
  return null;
}

/**
 * Fetch models.dev catalog and extract models for the requested providers.
 * Results are cached per-provider in D1 (small rows, ~10-20KB each).
 */
async function fetchModelsDevProviders(
  db: AppDb,
  providerIds: string[],
): Promise<Map<string, CatalogModel[]>> {
  const result = new Map<string, CatalogModel[]>();
  if (providerIds.length === 0) return result;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), MODELS_DEV_TIMEOUT);

    const res = await fetch('https://models.dev/api.json', { signal: controller.signal });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`models.dev returned ${res.status}`);
    }

    const catalog = await res.json() as Record<string, {
      id: string;
      name: string;
      models?: Record<string, CatalogModel>;
    }>;

    // Extract and cache each requested provider
    for (const providerId of providerIds) {
      const entry = catalog[providerId];
      if (entry?.models && typeof entry.models === 'object') {
        const models = Object.values(entry.models);
        result.set(providerId, models);

        // Cache per-provider (fire-and-forget)
        const cacheKey = `catalog:${providerId}`;
        setCatalogCache(db, cacheKey, JSON.stringify(models)).catch((err) => {
          console.error(`[model-catalog] cache write failed for ${providerId}:`, err);
        });
      }
    }

    return result;
  } catch (err) {
    console.error('[model-catalog] models.dev fetch failed:', err);
    return result;
  }
}

/**
 * Probe a custom provider's /v1/models endpoint with D1-backed caching.
 */
async function probeCustomProviderModels(
  db: AppDb,
  providerId: string,
  baseUrl: string,
  apiKey: string,
): Promise<Array<{ id: string; name: string }> | null> {
  const cacheKey = `probe:${providerId}`;
  const cached = await getCatalogCache(db, cacheKey);

  if (cached && !isCacheStale(cached.cachedAt)) {
    try {
      return JSON.parse(cached.data) as Array<{ id: string; name: string }>;
    } catch {
      // Corrupted — fall through
    }
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT);

    // Standard OpenAI-compatible /v1/models endpoint
    const url = baseUrl.replace(/\/+$/, '') + '/v1/models';
    const res = await fetch(url, {
      signal: controller.signal,
      headers: {
        'Authorization': `Bearer ${apiKey}`,
        'Accept': 'application/json',
      },
    });
    clearTimeout(timeout);

    if (!res.ok) {
      throw new Error(`Provider probe returned ${res.status}`);
    }

    const data = await res.json() as { data?: Array<{ id: string; [key: string]: unknown }> };
    const models = (data.data || []).map((m) => ({
      id: m.id,
      name: m.id,
    }));

    const text = JSON.stringify(models);
    setCatalogCache(db, cacheKey, text).catch((err) => {
      console.error(`[model-catalog] probe cache write failed for ${providerId}:`, err);
    });

    return models;
  } catch {
    // Probe failed — fall back to stale cache
    if (cached) {
      try {
        return JSON.parse(cached.data) as Array<{ id: string; name: string }>;
      } catch {
        return null;
      }
    }
    return null;
  }
}

/**
 * Get Runner-discovered model IDs from the org-level cache.
 * Returns a Set of full model IDs (e.g. "openai/gpt-5.1-chat-latest") or null if no cache exists.
 */
interface DiscoveredModels {
  ids: Set<string>;
  providerIds: Set<string>;
}

async function getRunnerDiscoveredModels(db: AppDb): Promise<DiscoveredModels | null> {
  const cached = await getCatalogCache(db, 'runner:discovered');
  if (!cached) return null;

  try {
    const models = JSON.parse(cached.data) as AvailableModels;
    const ids = new Set<string>();
    const providerIds = new Set<string>();
    for (const provider of models) {
      for (const model of provider.models) {
        ids.add(model.id);
        // Extract provider prefix from model ID (e.g. "anthropic" from "anthropic/claude-3-opus")
        const slash = model.id.indexOf('/');
        if (slash > 0) {
          providerIds.add(model.id.slice(0, slash));
        }
      }
    }
    return ids.size > 0 ? { ids, providerIds } : null;
  } catch {
    return null;
  }
}

/**
 * Resolve all available models from D1 configs and external catalogs.
 * This is the primary entry point — called from the route handler.
 *
 * When Runner-discovered models are cached at org level, the models.dev
 * catalog is filtered to only include models that actually exist in OpenCode's
 * provider registry. This prevents invalid model IDs from reaching clients.
 */
export async function resolveAvailableModels(db: AppDb, env: Env): Promise<AvailableModels> {
  // Parallel reads
  const [orgKeys, customProviderRows, discoveredModels] = await Promise.all([
    listOrgApiKeys(db),
    getAllCustomProvidersWithKeys(db),
    getRunnerDiscoveredModels(db),
  ]);

  const result: ProviderModels[] = [];

  // ─── Built-in providers ───────────────────────────────────────────────

  // Merge D1 org_api_keys with env var fallbacks.
  // Providers may have keys set as Worker secrets without a D1 row.
  const dbProviderSet = new Set(orgKeys.map((k) => k.provider));
  interface BuiltInProvider {
    provider: string;
    showAllModels: boolean;
    models?: Array<{ id: string; name?: string }>;
  }
  const builtInProviders: BuiltInProvider[] = orgKeys.map((k) => ({
    provider: k.provider,
    showAllModels: k.showAllModels ?? true,
    models: k.models as Array<{ id: string; name?: string }> | undefined,
  }));

  // Add env-var-only providers (not in D1) with showAllModels: true
  for (const { provider, envKey } of PROVIDER_ENV_KEYS) {
    if (!dbProviderSet.has(provider) && env[envKey]) {
      builtInProviders.push({ provider, showAllModels: true });
    }
  }

  // Determine which providers need catalog data (showAllModels + no DB model list)
  const needsCatalog: string[] = [];
  for (const key of builtInProviders) {
    if (key.showAllModels) {
      needsCatalog.push(key.provider);
    }
  }

  // Check per-provider caches in parallel
  const cacheResults = await Promise.all(
    needsCatalog.map(async (providerId) => {
      const models = await getCachedProviderModels(db, providerId);
      return [providerId, models] as const;
    }),
  );
  const cachedModels = new Map<string, CatalogModel[] | null>(cacheResults);

  // Determine which providers had cache misses
  const cacheMisses = needsCatalog.filter((id) => !cachedModels.get(id));

  // Fetch models.dev only if we have cache misses
  if (cacheMisses.length > 0) {
    // Also check stale cache entries to use as fallback
    const staleFallbacks = new Map<string, CatalogModel[]>();
    for (const providerId of cacheMisses) {
      const cached = await getCatalogCache(db, `catalog:${providerId}`);
      if (cached) {
        try {
          staleFallbacks.set(providerId, JSON.parse(cached.data) as CatalogModel[]);
        } catch { /* ignore corrupted */ }
      }
    }

    const fetched = await fetchModelsDevProviders(db, cacheMisses);

    // Merge fetched results into cachedModels, with stale fallback
    for (const providerId of cacheMisses) {
      const models = fetched.get(providerId) ?? staleFallbacks.get(providerId) ?? null;
      cachedModels.set(providerId, models);
    }
  }

  // Build result for built-in providers
  for (const key of builtInProviders) {
    const providerId = key.provider;
    const displayName = PROVIDER_DISPLAY_NAMES[providerId] || providerId;

    let models: Array<{ id: string; name: string }>;

    if (key.showAllModels) {
      const catalogModels = cachedModels.get(providerId);
      if (catalogModels && catalogModels.length > 0) {
        models = catalogModels.map((m) => ({
          id: `${providerId}/${m.id}`,
          name: m.name || m.id,
        }));
        // Filter against Runner-discovered models to remove IDs that don't exist in OpenCode.
        // Only filter if the runner actually discovered models from this provider —
        // otherwise we'd incorrectly filter out all models for providers the runner doesn't know about.
        if (discoveredModels && discoveredModels.providerIds.has(providerId)) {
          models = models.filter((m) => discoveredModels.ids.has(m.id));
        }
      } else if (key.models && key.models.length > 0) {
        // Catalog unavailable — fall back to DB model list
        models = key.models.map((m) => ({
          id: `${providerId}/${m.id}`,
          name: m.name || m.id,
        }));
      } else {
        models = [];
      }
    } else {
      // Use only the admin-curated model list from D1
      if (key.models && key.models.length > 0) {
        models = key.models.map((m) => ({
          id: `${providerId}/${m.id}`,
          name: m.name || m.id,
        }));
      } else {
        models = [];
      }
    }

    if (models.length > 0) {
      result.push({ provider: displayName, models });
    }
  }

  // ─── Custom providers (probed in parallel) ─────────────────────────────

  const customResults = await Promise.all(
    customProviderRows.map(async (cp): Promise<ProviderModels | null> => {
      const providerId = cp.providerId;
      const displayName = cp.displayName || providerId;

      let models: Array<{ id: string; name: string }>;

      if (cp.showAllModels && cp.encryptedKey) {
        // Probe the provider's /v1/models endpoint
        let apiKey: string;
        try {
          apiKey = await decryptString(cp.encryptedKey, env.ENCRYPTION_KEY);
        } catch {
          // Decryption failed — fall back to DB model list
          models = dbModelsToFormatted(cp.models, providerId);
          return models.length > 0 ? { provider: displayName, models } : null;
        }

        const probed = await probeCustomProviderModels(db, providerId, cp.baseUrl, apiKey);
        if (probed && probed.length > 0) {
          models = probed.map((m) => ({
            id: `${providerId}/${m.id}`,
            name: m.name || m.id,
          }));
        } else {
          // Probe failed — fall back to DB model list
          models = dbModelsToFormatted(cp.models, providerId);
        }
      } else {
        // Use DB model list directly
        models = dbModelsToFormatted(cp.models, providerId);
      }

      return models.length > 0 ? { provider: displayName, models } : null;
    }),
  );

  for (const entry of customResults) {
    if (entry) result.push(entry);
  }

  // ─── Runner-discovered models (fallback) ────────────────────────────
  // If no built-in or custom providers produced models, include the
  // Runner-discovered models directly so the picker is never empty
  // when the runner is connected.
  if (result.length === 0 && discoveredModels) {
    const cached = await getCatalogCache(db, 'runner:discovered');
    if (cached) {
      try {
        const raw = JSON.parse(cached.data) as AvailableModels;
        for (const provider of raw) {
          if (provider.models.length > 0) {
            result.push(provider);
          }
        }
      } catch { /* ignore corrupted cache */ }
    }
  }

  return result;
}

/** Convert DB custom provider model entries to the formatted shape. */
function dbModelsToFormatted(
  models: CustomProviderModel[],
  providerId: string,
): Array<{ id: string; name: string }> {
  if (!models || models.length === 0) return [];
  return models.map((m) => ({
    id: `${providerId}/${m.id}`,
    name: m.name || m.id,
  }));
}
