import type { Env } from '../env.js';
import type { AppDb } from '../lib/drizzle.js';
import type { CredentialResult } from '../services/credentials.js';
import { integrationRegistry, type CredentialSourceInfo } from '../integrations/registry.js';
import { getUserIntegrations, getOrgIntegrations } from '../lib/db/integrations.js';
import { invokeAction, markExecuted, markFailed } from '../services/actions.js';
import { getDisabledActionsIndex, isActionDisabled } from '../lib/db/disabled-actions.js';
import { upsertMcpToolCache } from '../lib/db/mcp-tool-cache.js';
import { getAutoEnabledServices, getDisabledPluginServices } from '../lib/db/plugins.js';
import { getUserIdentityLinks, getOrchestratorIdentity } from '../lib/db.js';

// ─── Types ──────────────────────────────────────────────────────────────────

export interface ToolDescriptor {
  id: string;
  name: string;
  description: string;
  riskLevel: string;
  params: Record<string, { type: string; required: boolean; description?: string }> | unknown;
}

export interface ToolWarning {
  service: string;
  displayName: string;
  reason: string;
  message: string;
  integrationId: string;
}

export interface McpCacheEntry {
  service: string;
  actionId: string;
  name: string;
  description: string;
  riskLevel: string;
}

export interface ListToolsResult {
  tools: ToolDescriptor[];
  warnings: ToolWarning[];
  mcpCacheEntries: McpCacheEntry[];
  /** Map of compositeId → riskLevel for all discovered tools (before filtering) */
  discoveredRiskLevels: Map<string, string>;
  /** Set of disabled plugin services discovered during listing */
  disabledPluginServices: Set<string>;
}

export interface CredentialCache {
  get(ownerType: string, ownerId: string, service: string, credentialType?: string): CredentialResult | null;
  set(ownerType: string, ownerId: string, service: string, result: CredentialResult, credentialType?: string): void;
  invalidate(ownerType: string, ownerId: string, service: string, credentialType?: string): void;
}

export interface ListToolsOpts {
  service?: string;
  query?: string;
  credentialCache: CredentialCache;
}

export type InvokeOutcome = 'denied' | 'pending_approval' | 'allowed';

export interface PolicyResult {
  outcome: InvokeOutcome;
  invocationId: string;
  riskLevel: string;
}

export interface ExecuteActionResult {
  success: boolean;
  data?: unknown;
  error?: string;
  /** Analytics events emitted by the action plugin */
  analyticsEvents: Array<{ eventType: string; durationMs?: number; properties?: Record<string, unknown> }>;
  durationMs: number;
}

// ─── Zod Schema Helpers ─────────────────────────────────────────────────────

/** Map a Zod type to a human-readable type string. */
export function zodTypeToString(inner: any): string {
  const typeName = inner?._def?.typeName;
  if (typeName === 'ZodString') return 'string';
  if (typeName === 'ZodNumber') return 'number';
  if (typeName === 'ZodBoolean') return 'boolean';
  if (typeName === 'ZodEnum') {
    const values = inner._def.values;
    return Array.isArray(values) ? `enum(${values.join(',')})` : 'enum';
  }
  if (typeName === 'ZodArray') {
    const itemType = inner._def.type ? zodTypeToString(inner._def.type) : 'unknown';
    return `array<${itemType}>`;
  }
  if (typeName === 'ZodObject') return 'object';
  return 'unknown';
}

/** Convert a Zod schema to a plain JSON-serializable descriptor. */
export function serializeZodSchema(schema: unknown): Record<string, { type: string; required: boolean; description?: string }> {
  const result: Record<string, { type: string; required: boolean; description?: string }> = {};

  // Walk ZodObject .shape
  const shape = (schema as any)?._def?.shape?.();
  if (!shape || typeof shape !== 'object') return result;

  for (const [key, fieldSchema] of Object.entries(shape)) {
    let inner: any = fieldSchema;
    let required = true;

    // Unwrap ZodOptional / ZodDefault / ZodNullable
    while (inner?._def) {
      const tn = inner._def.typeName;
      if (tn === 'ZodOptional' || tn === 'ZodDefault' || tn === 'ZodNullable') {
        if (tn === 'ZodOptional' || tn === 'ZodDefault') required = false;
        inner = inner._def.innerType;
      } else {
        break;
      }
    }

    const type = zodTypeToString(inner);
    const description = inner?._def?.description || (fieldSchema as any)?._def?.description || undefined;
    result[key] = { type, required, description };
  }

  return result;
}

// ─── listTools ──────────────────────────────────────────────────────────────

/**
 * Fetch all available tools for a user, applying policy filters.
 * Returns tools, warnings, cache entries, and discovered risk levels.
 */
export async function listTools(
  appDb: AppDb,
  envDB: D1Database,
  env: Env,
  userId: string,
  opts?: ListToolsOpts,
): Promise<ListToolsResult> {
  const { service: filterService, query, credentialCache } = opts ?? {} as ListToolsOpts;

  const [userIntegrations, orgIntegrations, autoServices, { disabledActions: disabledActionSet, disabledServices: disabledServiceSet }, disabledPluginServices] =
    await Promise.all([
      getUserIntegrations(appDb, userId),
      getOrgIntegrations(appDb),
      getAutoEnabledServices(envDB),
      getDisabledActionsIndex(appDb),
      getDisabledPluginServices(envDB),
    ]);

  // Group all active integrations by service, deduplicate by ID
  const serviceSourceMap = new Map<string, Array<{ id: string; scope: 'user' | 'org'; userId: string }>>();
  const seenIds = new Set<string>();

  for (const i of [...userIntegrations, ...orgIntegrations]) {
    if (i.status !== 'active' || seenIds.has(i.id)) continue;
    seenIds.add(i.id);
    const scope = ('scope' in i ? i.scope : 'user') as 'user' | 'org';
    const sources = serviceSourceMap.get(i.service) || [];
    sources.push({ id: i.id, scope, userId: i.userId });
    serviceSourceMap.set(i.service, sources);
  }

  // Inject auto-enabled services
  for (const svc of autoServices) {
    if (!serviceSourceMap.has(svc)) {
      serviceSourceMap.set(svc, [{ id: `auto:${svc}`, scope: 'user' as const, userId }]);
    }
  }

  console.log(`[session-tools] list-tools: userId=${userId}, service=${filterService ?? 'all'}, services with sources: [${[...serviceSourceMap.keys()].join(', ')}]`);

  const tools: ToolDescriptor[] = [];
  const warnings: ToolWarning[] = [];
  const mcpCacheEntries: McpCacheEntry[] = [];
  const discoveredRiskLevels = new Map<string, string>();

  for (const [service, sources] of serviceSourceMap) {
    if (filterService && service !== filterService) continue;
    if (disabledServiceSet.has(service)) continue;
    if (disabledPluginServices.has(service)) continue;

    const actionSource = integrationRegistry.getActions(service);
    if (!actionSource) continue;

    const provider = integrationRegistry.getProvider(service);

    // MCP-backed sources need credentials for listing (they return different tools per user).
    // Static sources (no mcpServerUrl) skip credential resolution during listing.
    let credCtx: { credentials: { access_token: string } } | undefined;
    const isMcpSource = !!provider?.mcpServerUrl;
    if (isMcpSource && provider?.authType !== 'none') {
      const firstSource = sources[0];
      const credentialSources = sources.map((s) => ({ scope: s.scope, integrationId: s.id, userId: s.userId }));

      // Check credential cache first
      let credResult = credentialCache?.get('user', userId, service) ?? null;
      if (!credResult) {
        credResult = await integrationRegistry.resolveCredentials(service, env, userId, {
          credentialSources,
          forceRefresh: false,
        });
        if (credResult.ok) {
          credentialCache?.set('user', userId, service, credResult);
        }
      }

      if (!credResult.ok) {
        // Try force-refresh for expired/refreshable credentials
        if (credResult.error.reason === 'expired' || credResult.error.reason === 'refresh_failed') {
          credResult = await integrationRegistry.resolveCredentials(service, env, userId, {
            credentialSources,
            forceRefresh: true,
          });
          if (credResult.ok) {
            credentialCache?.set('user', userId, service, credResult);
          }
        }
      }

      if (!credResult.ok) {
        const displayName = provider?.displayName || service;
        warnings.push({
          service,
          displayName,
          reason: credResult.error.reason,
          message: credResult.error.message,
          integrationId: firstSource.id,
        });
        continue;
      }

      credCtx = { credentials: { access_token: credResult.credential.accessToken } };
    }

    let actions = await actionSource.listActions(credCtx);

    // MCP sources may return [] when tokens are silently expired — force-refresh and retry
    if (actions.length === 0 && isMcpSource && credCtx && provider?.authType !== 'none') {
      const credentialSources = sources.map((s) => ({ scope: s.scope, integrationId: s.id, userId: s.userId }));
      credentialCache?.invalidate('user', userId, service);
      const refreshed = await integrationRegistry.resolveCredentials(service, env, userId, {
        credentialSources,
        forceRefresh: true,
      });
      if (refreshed.ok && refreshed.credential.refreshed) {
        credentialCache?.set('user', userId, service, refreshed);
        credCtx = { credentials: { access_token: refreshed.credential.accessToken } };
        actions = await actionSource.listActions(credCtx);
      }
    }

    console.log(`[session-tools] list-tools: ${service} returned ${actions.length} actions`);

    // Cache ALL discovered tools for the catalog/policy UI, before any filtering
    for (const action of actions) {
      const compositeId = `${service}:${action.id}`;
      discoveredRiskLevels.set(compositeId, action.riskLevel);
      mcpCacheEntries.push({
        service,
        actionId: action.id,
        name: action.name,
        description: action.description,
        riskLevel: action.riskLevel,
      });
    }

    for (const action of actions) {
      if (query) {
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const haystack = `${action.name} ${action.description} ${service}`.toLowerCase();
        if (!words.every((w) => haystack.includes(w))) continue;
      }

      const compositeId = `${service}:${action.id}`;
      if (disabledActionSet.has(compositeId)) continue;

      tools.push({
        id: compositeId,
        name: action.name,
        description: action.description,
        riskLevel: action.riskLevel,
        params: action.inputSchema || serializeZodSchema(action.params),
      });
    }
  }

  if (mcpCacheEntries.length > 0) {
    upsertMcpToolCache(appDb, mcpCacheEntries).catch((err) => {
      console.warn('[session-tools] mcp tool cache upsert failed:', err instanceof Error ? err.message : String(err));
    });
  }

  return { tools, warnings, mcpCacheEntries, discoveredRiskLevels, disabledPluginServices };
}

// ─── resolveActionPolicy ────────────────────────────────────────────────────

/**
 * Resolve the action policy for a tool invocation.
 * Returns the outcome (deny / pending_approval / allowed), invocation ID, and risk level.
 */
export async function resolveActionPolicy(
  appDb: AppDb,
  envDB: D1Database,
  env: Env,
  userId: string,
  toolId: string,
  params: Record<string, unknown>,
  opts: {
    sessionId: string;
    discoveredToolRiskLevels: Map<string, string>;
    credentialCache: CredentialCache;
    disabledPluginServicesCache: { services: Set<string>; expiresAt: number } | null;
  },
): Promise<PolicyResult & {
  service: string;
  actionId: string;
  credentialSources: CredentialSourceInfo[];
  actionSource: ReturnType<typeof integrationRegistry.getActions>;
  disabledPluginServicesCache: { services: Set<string>; expiresAt: number } | null;
}> {
  // Parse toolId: "service:actionId"
  const colonIndex = toolId.indexOf(':');
  if (colonIndex === -1) {
    throw new Error(`Invalid tool ID format "${toolId}". Expected "service:actionId" (e.g. "gmail:gmail.send_email")`);
  }
  const service = toolId.slice(0, colonIndex);
  const actionId = toolId.slice(colonIndex + 1);

  // Safety net: reject disabled actions even if the tool ID was guessed
  if (await isActionDisabled(appDb, service, actionId)) {
    throw new Error(`Action "${toolId}" is disabled by your organization.`);
  }

  // Safety net: reject actions from disabled plugins (cached to avoid per-invocation D1 query)
  let disabledPluginServicesCache = opts.disabledPluginServicesCache;
  if (!disabledPluginServicesCache || Date.now() > disabledPluginServicesCache.expiresAt) {
    disabledPluginServicesCache = {
      services: await getDisabledPluginServices(envDB),
      expiresAt: Date.now() + 60 * 1000, // 1 minute TTL
    };
  }
  if (disabledPluginServicesCache.services.has(service)) {
    throw new Error(`Action "${toolId}" is disabled by your organization.`);
  }

  // Collect all active credential sources for this service
  const userIntegrations = await getUserIntegrations(appDb, userId);
  const orgIntegrations = await getOrgIntegrations(appDb);
  const credentialSources: CredentialSourceInfo[] = [];
  const seenIds = new Set<string>();

  for (const i of [...userIntegrations, ...orgIntegrations]) {
    if (i.service !== service || i.status !== 'active' || seenIds.has(i.id)) continue;
    seenIds.add(i.id);
    const scope = ('scope' in i ? i.scope : 'user') as 'user' | 'org';
    credentialSources.push({ scope, integrationId: i.id, userId: i.userId });
  }

  // Fall back to auto-enabled plugins (no auth required)
  if (credentialSources.length === 0) {
    const autoServices = await getAutoEnabledServices(envDB);
    if (autoServices.includes(service)) {
      credentialSources.push({ scope: 'user', integrationId: `auto:${service}`, userId });
    }
  }

  if (credentialSources.length === 0) {
    throw new Error(`Integration "${service}" is not active. Configure it in Settings > Integrations.`);
  }

  // Look up ActionSource
  const actionSource = integrationRegistry.getActions(service);
  if (!actionSource) {
    throw new Error(`No integration package found for service "${service}".`);
  }

  // ─── Policy Resolution ─────────────────────────────────────────────
  // Use cached risk level from handleListTools if available (avoids MCP round-trip).
  // Fall back to listActions only if the cache misses (e.g. tool was never listed).
  const cachedRisk = opts.discoveredToolRiskLevels.get(toolId);
  let riskLevel: string;
  if (cachedRisk) {
    riskLevel = cachedRisk;
  } else {
    // Resolve list context for policy fallback — skip credential lookup for no-auth services
    const fallbackProvider = integrationRegistry.getProvider(service);
    let listCtx: { credentials: { access_token: string } } | undefined;
    if (fallbackProvider?.authType !== 'none') {
      const listCredResult = await integrationRegistry.resolveCredentials(service, env, userId, {
        credentialSources,
        forceRefresh: false,
      });
      if (listCredResult.ok) {
        listCtx = { credentials: { access_token: listCredResult.credential.accessToken } };
      }
    }
    const actionDef = (await actionSource.listActions(listCtx)).find(a => a.id === actionId);
    riskLevel = actionDef?.riskLevel || 'medium';
  }

  // Resolve policy mode
  const invocationResult = await invokeAction(appDb, {
    sessionId: opts.sessionId,
    userId,
    service,
    actionId,
    riskLevel,
    params,
  });

  return {
    outcome: invocationResult.outcome as InvokeOutcome,
    invocationId: invocationResult.invocationId,
    riskLevel,
    service,
    actionId,
    credentialSources,
    actionSource,
    disabledPluginServicesCache,
  };
}

// ─── executeAction ──────────────────────────────────────────────────────────

export interface ExecuteActionOpts {
  credentialCache: CredentialCache;
  /** Spawn request env vars, used to detect orchestrator sessions */
  spawnEnvVars?: Record<string, string>;
}

/**
 * Execute an integration action and return the result.
 * Does NOT send results to the runner — the caller (DO) handles that.
 */
export async function executeAction(
  appDb: AppDb,
  env: Env,
  userId: string,
  toolId: string,
  service: string,
  actionId: string,
  params: Record<string, unknown>,
  isOrgScoped: boolean,
  actionSource: ReturnType<typeof integrationRegistry.getActions>,
  invocationId: string,
  opts: ExecuteActionOpts,
): Promise<ExecuteActionResult> {
  if (!actionSource) {
    await markFailed(appDb, invocationId, 'No integration package found');
    return { success: false, error: `No integration package found for service "${service}".`, analyticsEvents: [], durationMs: 0 };
  }

  // Resolve credentials based on integration scope
  const provider = integrationRegistry.getProvider(service);
  let credentials: Record<string, string>;
  if (provider?.authType === 'none') {
    // No-auth services (e.g. DeepWiki) don't need credentials
    credentials = {};
  } else {
    const scope = isOrgScoped ? 'org' as const : 'user' as const;
    let credResult = opts.credentialCache.get('user', userId, service)
      || await integrationRegistry.resolveCredentials(service, env, userId, scope);
    if (credResult.ok) {
      opts.credentialCache.set('user', userId, service, credResult);
    }
    if (!credResult.ok) {
      const scopeLabel = isOrgScoped ? `org-scoped "${service}"` : `"${service}"`;
      await markFailed(appDb, invocationId, `No credentials: ${credResult.error.message}`);
      return { success: false, error: `No credentials found for ${scopeLabel}: ${credResult.error.message}. Connect it in Settings > Integrations.`, analyticsEvents: [], durationMs: 0 };
    }
    // Map resolved credential to the format actions expect
    const token = credResult.credential.accessToken;
    credentials = credResult.credential.credentialType === 'bot_token'
      ? { bot_token: token } as Record<string, string>
      : { access_token: token };
    // Pass credential type so actions can branch on app_install vs oauth2
    if (credResult.credential.credentialType) {
      credentials._credential_type = credResult.credential.credentialType;
    }

    // For Slack: inject the session owner's Slack user ID so dm_owner works
    if (service === 'slack') {
      const identityLinks = await getUserIdentityLinks(appDb, userId);
      const slackLink = identityLinks.find((l) => l.provider === 'slack');
      if (slackLink) credentials.owner_slack_user_id = slackLink.externalId;
    }
  }

  // Resolve caller identity for orchestrator sessions (used by Slack for username/avatar override)
  let callerIdentity: { name: string; avatar?: string } | undefined;
  try {
    if (opts.spawnEnvVars?.IS_ORCHESTRATOR === 'true') {
      const identity = await getOrchestratorIdentity(appDb, userId);
      if (identity) {
        callerIdentity = { name: identity.name, avatar: identity.avatar };
      }
    }
  } catch {
    // Non-critical — proceed without identity
  }

  // Create analytics collector for this action execution
  const collectedEvents: Array<{ eventType: string; durationMs?: number; properties?: Record<string, unknown> }> = [];
  const actionAnalytics = {
    emit: (eventType: string, data?: { durationMs?: number; properties?: Record<string, unknown> }) => {
      collectedEvents.push({ eventType, ...data });
    },
  };

  // Execute the action with timing for tool_exec event
  const toolExecStart = Date.now();
  let actionResult = await actionSource.execute(actionId, params, { credentials, userId, callerIdentity, analytics: actionAnalytics });

  // If auth error, retry once with force-refreshed credentials (skip no-auth and bot_token services which have nothing to refresh)
  if (provider?.authType !== 'none' && provider?.authType !== 'bot_token' && !actionResult.success && actionResult.error && /\b(401|403|unauthorized|invalid.credentials|token.*expired|token.*revoked)\b/i.test(actionResult.error)) {
    const scope = isOrgScoped ? 'org' as const : 'user' as const;
    console.log(`[session-tools] Tool "${toolId}" returned auth error, retrying with refreshed credentials`);
    opts.credentialCache.invalidate('user', userId, service);
    const refreshedCred = await integrationRegistry.resolveCredentials(service, env, userId, scope, { forceRefresh: true });
    if (refreshedCred.ok) {
      opts.credentialCache.set('user', userId, service, refreshedCred);
      const refreshedToken = refreshedCred.credential.accessToken;
      const refreshedCredentials: Record<string, string> = refreshedCred.credential.credentialType === 'bot_token'
        ? { bot_token: refreshedToken }
        : { access_token: refreshedToken };
      // Re-inject service-specific credential extras (e.g. owner_slack_user_id)
      if (service === 'slack' && credentials.owner_slack_user_id) {
        refreshedCredentials.owner_slack_user_id = credentials.owner_slack_user_id;
      }
      actionResult = await actionSource.execute(actionId, params, {
        credentials: refreshedCredentials,
        userId,
        callerIdentity,
        analytics: actionAnalytics,
      });
    }
  }

  const durationMs = Date.now() - toolExecStart;

  // Record result in D1
  if (!actionResult.success) {
    await markFailed(appDb, invocationId, actionResult.error || 'Action failed');
  } else {
    await markExecuted(appDb, invocationId, actionResult.data);
  }

  return {
    success: actionResult.success,
    data: actionResult.success ? actionResult.data : undefined,
    error: actionResult.success ? undefined : (actionResult.error || 'Action failed'),
    analyticsEvents: collectedEvents,
    durationMs,
  };
}
