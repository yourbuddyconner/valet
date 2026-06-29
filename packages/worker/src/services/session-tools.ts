import type { Env } from '../env.js';
import type { AppDb } from '../lib/drizzle.js';
import type { CredentialResult } from '../services/credentials.js';
import { integrationRegistry } from '../integrations/registry.js';
import { getUserIntegrations, getOrgIntegrations } from '../lib/db/integrations.js';
import { invokeAction, markExecuted, markFailed } from '../services/actions.js';
import { getDisabledActionsIndex, isActionDisabled } from '../lib/db/disabled-actions.js';
import { listMcpToolCache, upsertMcpToolCache } from '../lib/db/mcp-tool-cache.js';
import { getAutoEnabledServices, getDisabledPluginServices } from '../lib/db/plugins.js';
import { getUserIdentityLinks, getOrchestratorIdentity } from '../lib/db.js';
import { loadCustomMcpConnectorContext } from './custom-mcp-connectors.js';
import { log } from '../lib/log.js';

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
  get(ownerType: string, ownerId: string, service: string): CredentialResult | null;
  set(ownerType: string, ownerId: string, service: string, result: CredentialResult): void;
  invalidate(ownerType: string, ownerId: string, service: string): void;
}

export interface ListToolsOpts {
  service?: string;
  query?: string;
  credentialCache: CredentialCache;
  orgId?: string;
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
  /** Images to inject into the agent's vision context */
  images?: Array<{ data: string; mimeType: string; description: string }>;
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
  const { service: filterService, query, credentialCache, orgId = 'default' } = opts ?? {} as ListToolsOpts;

  const [userIntegrations, orgIntegrations, autoServices, { disabledActions: disabledActionSet, disabledServices: disabledServiceSet }, disabledPluginServices, customContext] =
    await Promise.all([
      getUserIntegrations(appDb, userId),
      getOrgIntegrations(appDb),
      getAutoEnabledServices(envDB, orgId),
      getDisabledActionsIndex(appDb),
      getDisabledPluginServices(envDB, orgId),
      loadCustomMcpConnectorContext(env, appDb, orgId),
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

  for (const connector of customContext.connectors.values()) {
    if (!serviceSourceMap.has(connector.serviceSlug)) {
      serviceSourceMap.set(connector.serviceSlug, [{ id: `custom:${connector.serviceSlug}`, scope: 'org' as const, userId }]);
    }
  }

  console.log(`[session-tools] list-tools: userId=${userId}, service=${filterService ?? 'all'}, services with sources: [${[...serviceSourceMap.keys()].join(', ')}]`);

  const tools: ToolDescriptor[] = [];
  const warnings: ToolWarning[] = [];
  const mcpCacheEntries: McpCacheEntry[] = [];
  const discoveredRiskLevels = new Map<string, string>();

  for (const [service, sources] of serviceSourceMap) {
    const provider = integrationRegistry.getProvider(service, customContext);
    if (filterService && !matchesServiceFilter(service, filterService, provider)) continue;
    if (disabledServiceSet.has(service)) continue;
    if (disabledPluginServices.has(service)) continue;

    const actionSource = integrationRegistry.getActions(service, customContext);
    if (!actionSource) continue;

    // MCP-backed sources need credentials for listing (they return different tools per user).
    // Static sources (no mcpServerUrl) skip credential resolution during listing.
    let credCtx: { credentials: { access_token: string } } | undefined;
    const isMcpSource = !!provider?.mcpServerUrl;
    if (isMcpSource && requiresUserCredential(provider)) {
      const firstSource = sources[0];

      // Check credential cache first
      let credResult = credentialCache?.get('user', userId, service) ?? null;
      if (!credResult) {
        credResult = await integrationRegistry.resolveCredentials(service, env, userId, {
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
            forceRefresh: true,
          });
          if (credResult.ok) {
            credentialCache?.set('user', userId, service, credResult);
          }
        }
      }

      if (!credResult.ok) {
        const displayName = provider?.displayName || service;
        // A genuinely-broken integration — token expired/revoked, refresh failed, or undecryptable —
        // still failed here even after the force-refresh retry above, so its tools get skipped.
        // Surface that on the trace-correlated logger so a silently-broken integration is caught,
        // not just dropped. 'not_found' is only "not connected" (not a breakage), so it's excluded.
        if (credResult.error.reason !== 'not_found') {
          log.warn('integration auth/refresh failed', {
            service,
            userId,
            reason: credResult.error.reason,
            detail: credResult.error.message,
          });
        }
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
    let listError = getActionSourceListError(actionSource);

    // MCP sources may return [] when tokens are silently expired — force-refresh and retry
    if (actions.length === 0 && isMcpSource && credCtx && requiresUserCredential(provider)) {
      credentialCache?.invalidate('user', userId, service);
      const refreshed = await integrationRegistry.resolveCredentials(service, env, userId, {
        forceRefresh: true,
      });
      if (refreshed.ok && refreshed.credential.refreshed) {
        credentialCache?.set('user', userId, service, refreshed);
        credCtx = { credentials: { access_token: refreshed.credential.accessToken } };
        actions = await actionSource.listActions(credCtx);
        listError = getActionSourceListError(actionSource);
      }
    }

    if (actions.length === 0 && listError) {
      warnings.push(buildToolDiscoveryWarning(service, provider, sources[0]?.id, listError));
      continue;
    }

    console.log(`[session-tools] list-tools: ${service} returned ${actions.length} actions`);

    // Cache ALL discovered tools for the catalog/policy UI, before any filtering
    for (const action of actions) {
      const compositeId = `${service}:${action.id}`;
      discoveredRiskLevels.set(compositeId, action.riskLevel);
      if (isMcpSource) {
        mcpCacheEntries.push({
          service,
          actionId: action.id,
          name: action.name,
          description: action.description,
          riskLevel: action.riskLevel,
        });
      }
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
    orgId?: string;
  },
): Promise<PolicyResult & {
  service: string;
  actionId: string;
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
  const orgId = opts.orgId ?? 'default';
  const customContext = await loadCustomMcpConnectorContext(env, appDb, orgId);
  const customConnector = customContext.connectors.get(service);

  // Safety net: reject disabled actions even if the tool ID was guessed
  if (await isActionDisabled(appDb, service, actionId)) {
    throw new Error(`Action "${toolId}" is disabled by your organization.`);
  }

  // Safety net: reject actions from disabled plugins (cached to avoid per-invocation D1 query)
  let disabledPluginServicesCache = opts.disabledPluginServicesCache;
  if (!disabledPluginServicesCache || Date.now() > disabledPluginServicesCache.expiresAt) {
    disabledPluginServicesCache = {
      services: await getDisabledPluginServices(envDB, orgId),
      expiresAt: Date.now() + 60 * 1000, // 1 minute TTL
    };
  }
  if (disabledPluginServicesCache.services.has(service)) {
    throw new Error(`Action "${toolId}" is disabled by your organization.`);
  }

  // Verify at least one active integration (or auto-enabled service) exists for this service
  const userIntegrations = await getUserIntegrations(appDb, userId);
  const orgIntegrations = await getOrgIntegrations(appDb);
  const hasActiveIntegration = [...userIntegrations, ...orgIntegrations].some(
    (i) => i.service === service && i.status === 'active',
  );
  const customConnectorDoesNotNeedIntegration = !!customConnector && !customConnectorRequiresUserCredential(customConnector);

  if (!hasActiveIntegration && !customConnectorDoesNotNeedIntegration) {
    const autoServices = await getAutoEnabledServices(envDB, orgId);
    if (!autoServices.includes(service)) {
      throw new Error(`Integration "${service}" is not active. Configure it in Settings > Integrations.`);
    }
  }

  // Look up ActionSource
  const actionSource = integrationRegistry.getActions(service, customContext);
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
    const fallbackProvider = integrationRegistry.getProvider(service, customContext);
    let listCtx: { credentials: { access_token: string } } | undefined;
    if (requiresUserCredential(fallbackProvider)) {
      const listCredResult = await integrationRegistry.resolveCredentials(service, env, userId, {
        forceRefresh: false,
      });
      if (listCredResult.ok) {
        listCtx = { credentials: { access_token: listCredResult.credential.accessToken } };
      }
    }
    const actionDef = (await actionSource.listActions(listCtx)).find(a => a.id === actionId);
    if (actionDef?.riskLevel) {
      riskLevel = actionDef.riskLevel;
    } else {
      const cachedTool = (await listMcpToolCache(appDb, service))
        .find((entry) => entry.actionId === actionId);
      riskLevel = cachedTool?.riskLevel || 'medium';
    }
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
    actionSource,
    disabledPluginServicesCache,
  };
}

// ─── executeAction ──────────────────────────────────────────────────────────

export interface ExecuteActionOpts {
  credentialCache: CredentialCache;
  orgId?: string;
  /** Spawn request env vars, used to detect orchestrator sessions */
  spawnEnvVars?: Record<string, string>;
  /** Org-level guard configuration, threaded from the DO to action plugins. */
  guardConfig?: Record<string, unknown>;
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
  actionSource: ReturnType<typeof integrationRegistry.getActions>,
  invocationId: string,
  opts: ExecuteActionOpts,
): Promise<ExecuteActionResult> {
  if (!actionSource) {
    await markFailed(appDb, invocationId, 'No integration package found');
    return { success: false, error: `No integration package found for service "${service}".`, analyticsEvents: [], durationMs: 0 };
  }

  const orgId = opts.orgId ?? 'default';
  const customContext = await loadCustomMcpConnectorContext(env, appDb, orgId);
  const provider = integrationRegistry.getProvider(service, customContext);
  let credentials: Record<string, string>;
  let attribution: { name: string; email: string } | undefined;

  if (!requiresUserCredential(provider)) {
    credentials = {};
  } else {
    const credResult = await integrationRegistry.resolveCredentials(service, env, userId, {
      params,
      forceRefresh: false,
    });

    if (!credResult.ok) {
      await markFailed(appDb, invocationId, `No credentials: ${credResult.error.message}`);
      return { success: false, error: `No credentials found for "${service}": ${credResult.error.message}. Connect it in Settings > Integrations.`, analyticsEvents: [], durationMs: 0 };
    }

    credentials = buildCredentials(credResult);
    attribution = credResult.credential.attribution;

    // Inject service-specific extras
    if (service === 'slack') {
      const identityLinks = await getUserIdentityLinks(appDb, userId);
      const slackLink = identityLinks.find((l) => l.provider === 'slack');
      if (slackLink) credentials.owner_slack_user_id = slackLink.externalId;
    }
  }

  let callerIdentity: { name: string; avatar?: string } | undefined;
  try {
    if (opts.spawnEnvVars?.IS_ORCHESTRATOR === 'true') {
      const identity = await getOrchestratorIdentity(appDb, userId);
      if (identity) callerIdentity = { name: identity.name, avatar: identity.avatar };
    }
  } catch { /* non-critical */ }

  const collectedEvents: Array<{ eventType: string; durationMs?: number; properties?: Record<string, unknown> }> = [];
  const actionAnalytics = {
    emit: (eventType: string, data?: { durationMs?: number; properties?: Record<string, unknown> }) => {
      collectedEvents.push({ eventType, ...data });
    },
  };

  const toolExecStart = Date.now();
  let actionResult;
  try {
    actionResult = await actionSource.execute(actionId, params, { credentials, userId, orgId, attribution, callerIdentity, analytics: actionAnalytics, guardConfig: opts.guardConfig });

    // Auth failure retry — force-refresh on 401 and retry once (simple token-expired retry)
    // Note: 403 is excluded — GitHub 403s are permission problems (missing App permissions),
    // not credential problems. Retrying with a different token won't help.
    const isAuthError = !actionResult.success && actionResult.error &&
      /\b(401|unauthorized|invalid.credentials|token.*expired|token.*revoked)\b/i.test(actionResult.error);

    if (requiresUserCredential(provider) && provider?.authType !== 'bot_token' && isAuthError) {
      console.log(`[session-tools] Tool "${toolId}" auth error, force-refreshing credential`);
      const refreshed = await integrationRegistry.resolveCredentials(service, env, userId, {
        params,
        forceRefresh: true,
      });
      if (refreshed.ok) {
        const refreshedCredentials = buildCredentials(refreshed);
        attribution = refreshed.credential.attribution;
        if (service === 'slack' && credentials.owner_slack_user_id) {
          refreshedCredentials.owner_slack_user_id = credentials.owner_slack_user_id;
        }
        actionResult = await actionSource.execute(actionId, params, {
          credentials: refreshedCredentials, userId, attribution, callerIdentity, analytics: actionAnalytics, guardConfig: opts.guardConfig,
          orgId,
        });
      }
    }
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    await markFailed(appDb, invocationId, error);
    return {
      success: false,
      error,
      analyticsEvents: collectedEvents,
      durationMs: Date.now() - toolExecStart,
    };
  }

  const durationMs = Date.now() - toolExecStart;

  if (!actionResult.success) {
    await markFailed(appDb, invocationId, actionResult.error || 'Action failed');
  } else {
    await markExecuted(appDb, invocationId, actionResult.data);
  }

  return {
    success: actionResult.success,
    data: actionResult.success ? actionResult.data : undefined,
    error: actionResult.success ? undefined : (actionResult.error || 'Action failed'),
    images: actionResult.images,
    analyticsEvents: collectedEvents,
    durationMs,
  };
}

/** Build the credentials object from a successful CredentialResult. */
function buildCredentials(credResult: CredentialResult & { ok: true }): Record<string, string> {
  const token = credResult.credential.accessToken;
  const credentials: Record<string, string> = credResult.credential.credentialType === 'bot_token'
    ? { bot_token: token }
    : { access_token: token };
  if (credResult.credential.credentialType) {
    credentials._credential_type = credResult.credential.credentialType;
  }
  return credentials;
}

function requiresUserCredential(provider?: { authType?: string; isCustomConnector?: boolean; credentialScope?: 'org' | 'user' }): boolean {
  if (!provider) return false;
  if (provider.authType === 'none') return false;
  if (provider.isCustomConnector && provider.authType === 'api_key') return provider.credentialScope === 'user';
  return true;
}

function customConnectorRequiresUserCredential(connector: { authType: string; credentialScope?: 'org' | 'user' }): boolean {
  if (connector.authType === 'none') return false;
  if (connector.authType === 'oauth') return true;
  return connector.credentialScope === 'user';
}

function matchesServiceFilter(
  service: string,
  filter: string,
  provider?: { displayName?: string; isCustomConnector?: boolean },
): boolean {
  const normalizedFilter = filter.trim().toLowerCase();
  if (!normalizedFilter) return true;
  if (service.toLowerCase() === normalizedFilter) return true;

  if (!provider?.isCustomConnector) return false;

  return service.toLowerCase().includes(normalizedFilter)
    || (provider.displayName ?? '').toLowerCase().includes(normalizedFilter);
}

function getActionSourceListError(actionSource: unknown): string | null {
  const source = actionSource as { getLastListError?: () => string | null | undefined };
  if (typeof source.getLastListError !== 'function') return null;
  return source.getLastListError() ?? null;
}

function buildToolDiscoveryWarning(
  service: string,
  provider: { displayName?: string } | undefined,
  integrationId: string | undefined,
  message: string,
): ToolWarning {
  return {
    service,
    displayName: provider?.displayName || service,
    reason: classifyToolDiscoveryFailure(message),
    message,
    integrationId: integrationId ?? `unknown:${service}`,
  };
}

function classifyToolDiscoveryFailure(message: string): string {
  return /\b(401|403|unauthorized|forbidden|invalid[_ -]?token|jwt token is required|token.*expired|token.*revoked)\b/i.test(message)
    ? 'auth_failed'
    : 'request_failed';
}
