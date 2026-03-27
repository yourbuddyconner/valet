import { ForbiddenError, NotFoundError, ValidationError, webManualScopeKey } from '@valet/shared';
import type { Env } from '../env.js';
import * as db from '../lib/db.js';
import type { AppDb } from '../lib/drizzle.js';
import { getDb } from '../lib/drizzle.js';
import { signJWT } from '../lib/jwt.js';
import { buildDoWebSocketUrl } from '../lib/do-ws-url.js';
import { generateRunnerToken, assembleProviderEnv, assembleCredentialEnv, assembleCustomProviders, assembleBuiltInProviderModelConfigs, assembleRepoEnv } from '../lib/env-assembly.js';
import { getCredential } from '../services/credentials.js';

// ─── Types ──────────────────────────────────────────────────────────────────

type ChildTunnelSummary = { name: string; url?: string; path?: string; port?: number; protocol?: string };
type ChildSummaryWithRuntime = Awaited<ReturnType<typeof db.getChildSessions>>['children'][number] & {
  prTitle?: string;
  gatewayUrl?: string;
  tunnels?: ChildTunnelSummary[];
};

// ─── Constants ──────────────────────────────────────────────────────────────

const NON_ACTIVE_TUNNEL_STATUSES = new Set(['terminated', 'error', 'hibernated', 'archived']);
const PR_REFRESH_INTERVAL_MS = 60_000;
const childPrRefreshCache = new Map<string, number>();

// ─── Helpers ────────────────────────────────────────────────────────────────

export function assertSessionShareable(session: Awaited<ReturnType<typeof db.assertSessionAccess>>) {
  if (session.isOrchestrator || session.purpose === 'workflow') {
    throw new ForbiddenError('This session type cannot be shared');
  }
}

export async function getGitHubTokenIfConnected(env: Env, userId: string): Promise<string | null> {
  try {
    const result = await getCredential(env, 'user', userId, 'github', { credentialType: 'oauth2' });
    if (!result.ok) return null;
    return result.credential.accessToken;
  } catch {
    return null;
  }
}

export function parseGitHubPullRequestUrl(prUrl: string): { owner: string; repo: string; pullNumber: number } | null {
  const match = prUrl.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/i);
  if (!match) return null;
  const pullNumber = Number.parseInt(match[3], 10);
  if (!Number.isFinite(pullNumber)) return null;
  return {
    owner: match[1],
    repo: match[2],
    pullNumber,
  };
}

export function mapGitHubPullRequestState(input: string | undefined, draft: boolean, merged: boolean): 'draft' | 'open' | 'closed' | 'merged' | null {
  if (merged) return 'merged';
  if (input === 'open') return draft ? 'draft' : 'open';
  if (input === 'closed') return 'closed';
  return null;
}

export async function enrichChildrenWithRuntimeStatus(
  env: Env,
  children: Awaited<ReturnType<typeof db.getChildSessions>>['children']
): Promise<ChildSummaryWithRuntime[]> {
  return Promise.all(
    children.map(async (child) => {
      if (NON_ACTIVE_TUNNEL_STATUSES.has(child.status)) {
        return child;
      }

      try {
        const childDoId = env.SESSIONS.idFromName(child.id);
        const childDO = env.SESSIONS.get(childDoId);
        const statusRes = await childDO.fetch(new Request('http://do/status'));
        if (!statusRes.ok) return child;

        const statusData = await statusRes.json() as {
          tunnelUrls?: Record<string, string> | null;
          tunnels?: Array<{ name: string; url?: string; path?: string; port?: number; protocol?: string }> | null;
        };

        const tunnels = Array.isArray(statusData.tunnels)
          ? statusData.tunnels.filter((t): t is ChildTunnelSummary => typeof t?.name === 'string')
          : [];

        return {
          ...child,
          gatewayUrl: statusData.tunnelUrls?.gateway ?? undefined,
          tunnels: tunnels.length > 0 ? tunnels : undefined,
        };
      } catch {
        return child;
      }
    })
  );
}

export async function refreshOpenChildPullRequestStates(
  env: Env,
  userId: string,
  children: ChildSummaryWithRuntime[],
): Promise<ChildSummaryWithRuntime[]> {
  const githubToken = await getGitHubTokenIfConnected(env, userId);
  if (!githubToken) return children;

  const now = Date.now();

  return Promise.all(
    children.map(async (child) => {
      if (child.prState !== 'open' || typeof child.prNumber !== 'number' || !child.prUrl) {
        return child;
      }

      const parsed = parseGitHubPullRequestUrl(child.prUrl);
      if (!parsed) return child;

      const cacheKey = `${child.id}:${child.prNumber}`;
      const lastCheckedAt = childPrRefreshCache.get(cacheKey);
      if (lastCheckedAt && now - lastCheckedAt < PR_REFRESH_INTERVAL_MS) {
        return child;
      }
      childPrRefreshCache.set(cacheKey, now);

      try {
        const res = await fetch(
          `https://api.github.com/repos/${parsed.owner}/${parsed.repo}/pulls/${parsed.pullNumber}`,
          {
            headers: {
              Authorization: `Bearer ${githubToken}`,
              Accept: 'application/vnd.github+json',
              'User-Agent': 'Valet',
            },
          },
        );

        if (!res.ok) {
          return child;
        }

        const pr = await res.json() as {
          state?: string;
          draft?: boolean;
          merged?: boolean;
          html_url?: string;
          title?: string;
        };

        const refreshedState = mapGitHubPullRequestState(pr.state, Boolean(pr.draft), Boolean(pr.merged));
        if (!refreshedState) return child;

        const refreshedUrl = typeof pr.html_url === 'string' ? pr.html_url : child.prUrl;
        const refreshedTitle = typeof pr.title === 'string' ? pr.title : undefined;
        const nextTitle = refreshedTitle ?? child.prTitle;

        if (refreshedState !== child.prState || refreshedUrl !== child.prUrl || (nextTitle && nextTitle !== child.prTitle)) {
          const appDb = getDb(env.DB);
          await db.updateSessionGitState(appDb, child.id, {
            prState: refreshedState,
            prUrl: refreshedUrl,
            ...(nextTitle ? { prTitle: nextTitle } : {}),
          });
        }

        return {
          ...child,
          prState: refreshedState,
          prUrl: refreshedUrl,
          ...(nextTitle ? { prTitle: nextTitle } : {}),
        };
      } catch {
        return child;
      }
    })
  );
}

// ─── Create Session ─────────────────────────────────────────────────────────

export interface CreateSessionParams {
  userId: string;
  userEmail: string;
  workspace: string;
  repoUrl?: string;
  branch?: string;
  ref?: string;
  title?: string;
  parentSessionId?: string;
  config?: { memory?: string; timeout?: number };
  sourceType?: 'pr' | 'issue' | 'branch' | 'manual';
  sourcePrNumber?: number;
  sourceIssueNumber?: number;
  sourceRepoFullName?: string;
  initialPrompt?: string;
  initialModel?: string;
  personaId?: string;
}

export interface CreateSessionRequestContext {
  url: string;
  host?: string;
}

export type CreateSessionResult =
  | { ok: true; session: { id: string; status: string; [key: string]: unknown }; websocketUrl: string }
  | { ok: false; reason: 'rate_limited'; activeCount: number; limit: number; message: string };

export async function createSession(
  env: Env,
  params: CreateSessionParams,
  requestContext: CreateSessionRequestContext,
): Promise<CreateSessionResult> {
  const appDb = getDb(env.DB);
  const sessionId = crypto.randomUUID();
  const runnerToken = generateRunnerToken();

  // Ensure user exists in DB
  await db.getOrCreateUser(appDb, { id: params.userId, email: params.userEmail });

  // Check concurrency limits (skip for orchestrator/workflow sessions)
  const isOrchestratorSession = params.parentSessionId?.startsWith('orchestrator:');
  if (!isOrchestratorSession) {
    const concurrency = await db.checkSessionConcurrency(appDb, params.userId);
    if (!concurrency.allowed) {
      return {
        ok: false,
        reason: 'rate_limited',
        activeCount: concurrency.activeCount,
        limit: concurrency.limit,
        message: concurrency.reason || 'Too many active sessions',
      };
    }
  }

  // If persona requested, fetch and validate access
  let personaFiles: { filename: string; content: string; sortOrder: number }[] | undefined;
  let personaDefaultModel: string | undefined;
  if (params.personaId) {
    const persona = await db.getPersonaWithFiles(env.DB, params.personaId);
    if (!persona) {
      throw new NotFoundError('Persona', params.personaId);
    }
    if (persona.visibility === 'private' && persona.createdBy !== params.userId) {
      throw new NotFoundError('Persona', params.personaId);
    }
    if (persona.files?.length) {
      personaFiles = persona.files.map((f) => ({
        filename: f.filename,
        content: f.content,
        sortOrder: f.sortOrder,
      }));
    }
    if (persona.defaultModel) {
      personaDefaultModel = persona.defaultModel;
    }
  }

  // Create session record
  const session = await db.createSession(appDb, {
    id: sessionId,
    userId: params.userId,
    workspace: params.workspace,
    title: params.title,
    parentSessionId: params.parentSessionId,
    metadata: params.config,
    personaId: params.personaId,
  });

  // Create git state record
  const sourceType = params.sourceType || (params.repoUrl ? 'branch' : 'manual');
  let sourceRepoFullName = params.sourceRepoFullName || null;
  if (!sourceRepoFullName && params.repoUrl) {
    const match = params.repoUrl.match(/github\.com[/:]([^/]+\/[^/.]+)/);
    if (match) sourceRepoFullName = match[1];
  }

  await db.createSessionGitState(appDb, {
    sessionId,
    sourceType,
    sourcePrNumber: params.sourcePrNumber,
    sourceIssueNumber: params.sourceIssueNumber,
    sourceRepoFullName: sourceRepoFullName || undefined,
    sourceRepoUrl: params.repoUrl,
    branch: params.branch,
    ref: params.ref,
  });

  // Construct WebSocket URL for the DO
  const doWsUrl = buildDoWebSocketUrl({
    env,
    sessionId,
    requestUrl: requestContext.url,
    requestHost: requestContext.host,
  });

  // Build environment variables for the sandbox
  const providerVars = await assembleProviderEnv(appDb, env);
  const credentialVars = await assembleCredentialEnv(appDb, env, params.userId);
  const envVars: Record<string, string> = { ...providerVars, ...credentialVars };

  // Custom LLM providers
  const customProviders = await assembleCustomProviders(appDb, env.ENCRYPTION_KEY);

  // Built-in provider model allowlists
  const builtInProviderModelConfigs = await assembleBuiltInProviderModelConfigs(appDb);

  // Resolve org ID for credential lookup
  const orgSettings = await db.getOrgSettings(appDb);
  const orgId = orgSettings?.id;

  // If repo URL provided, resolve repo provider and assemble env vars
  let repoGitConfig: Record<string, string> = {};
  if (params.repoUrl) {
    const repoEnv = await assembleRepoEnv(appDb, env, params.userId, orgId, {
      repoUrl: params.repoUrl,
      branch: params.branch,
      ref: params.ref,
    });
    if (repoEnv.error) {
      throw new ValidationError(repoEnv.error);
    }
    Object.assign(envVars, repoEnv.envVars);
    repoGitConfig = repoEnv.gitConfig;
  }

  // Fetch user's idle timeout preference
  const userRow = await db.getUserById(appDb, params.userId);
  const idleTimeoutSeconds = userRow?.idleTimeoutSeconds ?? 900;
  const uiQueueMode = userRow?.uiQueueMode ?? 'followup';
  const idleTimeoutMs = idleTimeoutSeconds * 1000;

  // Inject user timezone into sandbox env
  if (userRow?.timezone) {
    envVars['TZ'] = userRow.timezone;
  }

  // Initialize SessionAgentDO
  const doId = env.SESSIONS.idFromName(sessionId);
  const sessionDO = env.SESSIONS.get(doId);

  const initialModel = params.initialModel || personaDefaultModel;

  const spawnRequest = {
    sessionId,
    userId: params.userId,
    workspace: params.workspace,
    imageType: 'base',
    doWsUrl,
    runnerToken,
    jwtSecret: env.ENCRYPTION_KEY,
    idleTimeoutSeconds,
    envVars,
    gitConfig: Object.keys(repoGitConfig).length > 0 ? repoGitConfig : undefined,
    personaFiles,
    customProviders: customProviders.length > 0 ? customProviders : undefined,
    builtInProviderModelConfigs: builtInProviderModelConfigs.length > 0 ? builtInProviderModelConfigs : undefined,
    ...(userRow?.sandboxCpuCores != null ? { sandboxCpuCores: userRow.sandboxCpuCores } : {}),
    ...(userRow?.sandboxMemoryMib != null ? { sandboxMemoryMib: userRow.sandboxMemoryMib } : {}),
  };

  try {
    await sessionDO.fetch(new Request('http://do/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        userId: params.userId,
        workspace: params.workspace,
        runnerToken,
        backendUrl: env.MODAL_BACKEND_URL.replace('{label}', 'create-session'),
        terminateUrl: env.MODAL_BACKEND_URL.replace('{label}', 'terminate-session'),
        hibernateUrl: env.MODAL_BACKEND_URL.replace('{label}', 'hibernate-session'),
        restoreUrl: env.MODAL_BACKEND_URL.replace('{label}', 'restore-session'),
        idleTimeoutMs,
        queueMode: uiQueueMode,
        spawnRequest,
        initialPrompt: params.initialPrompt,
        initialModel,
      }),
    }));
  } catch (err) {
    console.error('Failed to initialize SessionAgentDO:', err);
    await db.updateSessionStatus(appDb, sessionId, 'error', undefined, `Failed to initialize session: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  // Auto-create web channel binding
  try {
    if (orgSettings) {
      await db.createChannelBinding(appDb, {
        id: crypto.randomUUID(),
        sessionId,
        channelType: 'web',
        channelId: sessionId,
        scopeKey: webManualScopeKey(params.userId, sessionId),
        userId: params.userId,
        orgId: orgSettings.id,
        queueMode: uiQueueMode,
      });
    }
  } catch (err) {
    console.warn('[sessions] Failed to create channel binding:', err);
  }

  // Build client WebSocket URL
  const requestUrl = new URL(requestContext.url);
  const clientWsProtocol = requestUrl.protocol === 'https:' ? 'wss' : 'ws';
  const clientWsHost = requestContext.host || requestUrl.host || 'localhost';
  const websocketUrl = `${clientWsProtocol}://${clientWsHost}/api/sessions/${sessionId}/ws?role=client&userId=${params.userId}`;

  return {
    ok: true,
    session: { ...session, status: 'initializing' as const },
    websocketUrl,
  };
}

// ─── Get Session Participants With Owner ─────────────────────────────────────

export async function getSessionParticipantsWithOwner(
  database: AppDb,
  sessionId: string,
  ownerUserId: string,
) {
  const participants = await db.getSessionParticipants(database, sessionId);
  const ownerUser = await db.getUserById(database, ownerUserId);

  const allParticipants = [
    {
      id: `owner:${ownerUserId}`,
      sessionId,
      userId: ownerUserId,
      role: 'owner' as const,
      createdAt: new Date(),
      userName: ownerUser?.name,
      userEmail: ownerUser?.email,
      userAvatarUrl: ownerUser?.avatarUrl,
    },
    ...participants.filter((p) => p.userId !== ownerUserId),
  ];

  return allParticipants;
}

// ─── Get Session With Status ────────────────────────────────────────────────

export async function getSessionWithStatus(
  env: Env,
  sessionId: string,
  userId: string,
) {
  const appDb = getDb(env.DB);
  const session = await db.assertSessionAccess(appDb, sessionId, userId, 'viewer');

  // Get live status from DO
  const doId = env.SESSIONS.idFromName(sessionId);
  const sessionDO = env.SESSIONS.get(doId);

  const statusRes = await sessionDO.fetch(new Request('http://do/status'));
  let doStatus = await statusRes.json() as {
    status?: string;
    lifecycleStatus?: string;
    sandboxId?: string | null;
    tunnelUrls?: Record<string, string> | null;
    tunnels?: Array<{ name: string; url?: string; path?: string; port?: number; protocol?: string }> | null;
    runnerConnected?: boolean;
    runnerBusy?: boolean;
    queuedPrompts?: number;
    agentState?: string;
    sandboxState?: string;
    jointState?: string;
    [key: string]: unknown;
  };

  // Session DB status is authoritative for terminal states.
  if (session.status === 'terminated' || session.status === 'archived' || session.status === 'error') {
    const terminalStatus = session.status;
    const terminalRuntimeState = terminalStatus === 'error' ? 'error' : 'stopped';
    doStatus = {
      ...doStatus,
      status: terminalStatus,
      lifecycleStatus: terminalStatus,
      sandboxId: null,
      tunnelUrls: null,
      tunnels: null,
      runnerConnected: false,
      runnerBusy: false,
      queuedPrompts: 0,
      agentState: terminalRuntimeState,
      sandboxState: terminalRuntimeState,
      jointState: terminalRuntimeState,
    };
  }

  const gatewayUrl = doStatus.tunnelUrls?.gateway;
  const tunnels = doStatus.tunnels ?? null;

  return {
    session: { ...session, gatewayUrl, tunnels },
    doStatus,
  };
}

// ─── Issue Sandbox Token ────────────────────────────────────────────────────

export async function issueSandboxToken(
  env: Env,
  sessionId: string,
  userId: string,
) {
  const appDb = getDb(env.DB);
  const session = await db.assertSessionAccess(appDb, sessionId, userId, 'viewer');

  if (session.status === 'terminated' || session.status === 'error' || session.status === 'archived') {
    return { error: 'Session is not running' as const, status: 503 as const };
  }

  if (session.status === 'hibernated' || session.status === 'hibernating' || session.status === 'restoring') {
    return { hibernatedStatus: session.status as string, status: 503 as const };
  }

  const doId = env.SESSIONS.idFromName(sessionId);
  const sessionDO = env.SESSIONS.get(doId);

  const statusRes = await sessionDO.fetch(new Request('http://do/status'));
  const statusData = await statusRes.json() as {
    tunnelUrls: Record<string, string> | null;
    sessionId: string;
  };

  if (!statusData.tunnelUrls) {
    return { error: 'Sandbox tunnel URLs not available' as const, status: 503 as const };
  }

  const now = Math.floor(Date.now() / 1000);
  const token = await signJWT(
    {
      sub: userId,
      sid: sessionId,
      iat: now,
      exp: now + 15 * 60,
    },
    env.ENCRYPTION_KEY,
  );

  return {
    token,
    tunnelUrls: statusData.tunnelUrls,
    expiresAt: new Date((now + 15 * 60) * 1000).toISOString(),
  };
}

// ─── Send Session Message ───────────────────────────────────────────────────

export async function sendSessionMessage(
  env: Env,
  sessionId: string,
  userId: string,
  userEmail: string,
  content: string,
): Promise<{ success: true }> {
  const appDb = getDb(env.DB);
  const session = await db.assertSessionAccess(appDb, sessionId, userId, 'collaborator');

  if (['terminated', 'archived', 'error'].includes(session.status)) {
    throw new ValidationError('Session is not active');
  }

  const doId = env.SESSIONS.idFromName(sessionId);
  const sessionDO = env.SESSIONS.get(doId);

  const doRes = await sessionDO.fetch(new Request('http://do/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ content }),
  }));

  if (!doRes.ok) {
    const err = await doRes.text();
    throw new Error(`Failed to deliver prompt: ${err}`);
  }

  return { success: true };
}

// ─── Terminate Session ──────────────────────────────────────────────────────

export async function terminateSession(
  env: Env,
  sessionId: string,
  userId: string,
): Promise<void> {
  const appDb = getDb(env.DB);
  await db.assertSessionAccess(appDb, sessionId, userId, 'owner');

  const doId = env.SESSIONS.idFromName(sessionId);
  const sessionDO = env.SESSIONS.get(doId);

  await sessionDO.fetch(new Request('http://do/stop', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: 'user_stopped' }),
  }));

  await db.updateSessionStatus(appDb, sessionId, 'terminated');
}

// ─── Bulk Delete Sessions ───────────────────────────────────────────────────

export async function bulkDeleteSessions(
  env: Env,
  userId: string,
  sessionIds: string[],
): Promise<{ deleted: number; errors: { sessionId: string; error: string }[] }> {
  const appDb = getDb(env.DB);
  const ownedIds = await db.filterOwnedSessionIds(appDb, sessionIds, userId);
  const validIds = sessionIds.filter((id) => ownedIds.includes(id));

  if (validIds.length === 0) {
    return { deleted: 0, errors: [] };
  }

  const errors: { sessionId: string; error: string }[] = [];

  await Promise.allSettled(
    validIds.map(async (sessionId) => {
      const doId = env.SESSIONS.idFromName(sessionId);
      const sessionDO = env.SESSIONS.get(doId);

      try {
        await sessionDO.fetch(new Request('http://do/stop', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reason: 'bulk_delete' }),
        }));
      } catch (err) {
        // Stopping may fail if already terminated — continue to GC
      }

      try {
        await sessionDO.fetch(new Request('http://do/gc', { method: 'POST' }));
      } catch (err) {
        errors.push({
          sessionId,
          error: `GC failed: ${err instanceof Error ? err.message : String(err)}`,
        });
      }
    })
  );

  await db.bulkDeleteSessionRecords(appDb, validIds, userId);
  await db.bulkDeleteSessionMessages(appDb, validIds);

  return { deleted: validIds.length, errors };
}

// ─── Get Enriched Child Sessions ────────────────────────────────────────────

export async function getEnrichedChildSessions(
  env: Env,
  parentSessionId: string,
  userId: string,
  opts: { limit?: number; cursor?: string; status?: string; hideTerminated?: boolean },
) {
  const appDb = getDb(env.DB);
  const session = await db.assertSessionAccess(appDb, parentSessionId, userId, 'viewer');

  const excludeStatuses = opts.hideTerminated ? ['terminated', 'archived', 'error'] : undefined;

  // For orchestrator sessions, widen the query to span all orchestrator
  // sessions for this user (session IDs rotate on hibernation/restore).
  const isOrchestrator = session.isOrchestrator || session.purpose === 'orchestrator';

  const result = await db.getChildSessions(env.DB, parentSessionId, {
    limit: opts.limit,
    cursor: opts.cursor,
    status: opts.status,
    excludeStatuses,
    userId: isOrchestrator ? userId : undefined,
  });

  const enrichedChildren = await enrichChildrenWithRuntimeStatus(env, result.children);
  const refreshedChildren = await refreshOpenChildPullRequestStates(env, userId, enrichedChildren);

  return {
    children: refreshedChildren,
    cursor: result.cursor,
    hasMore: result.hasMore,
    totalCount: result.totalCount,
  };
}

// ─── Join Session Via Share Link ────────────────────────────────────────────

export async function joinSessionViaShareLink(
  database: AppDb,
  token: string,
  userId: string,
): Promise<{ sessionId: string; role: string } | null> {
  const link = await db.getShareLink(database, token);
  if (!link) {
    return null;
  }

  const targetSession = await db.getSession(database, link.sessionId);
  if (!targetSession) {
    return null;
  }
  if (targetSession.isOrchestrator || targetSession.purpose === 'workflow') {
    throw new ForbiddenError('This session type cannot be shared');
  }

  const result = await db.redeemShareLink(database, token, userId);
  if (!result) {
    return null;
  }

  return { sessionId: result.sessionId, role: result.role };
}

// ─── Add Session Participant ────────────────────────────────────────────────

export async function addSessionParticipant(
  database: AppDb,
  sessionId: string,
  ownerUserId: string,
  target: { userId?: string; email?: string },
  role: string,
): Promise<void> {
  const session = await db.assertSessionAccess(database, sessionId, ownerUserId, 'owner');
  assertSessionShareable(session);

  let targetUserId = target.userId;
  if (!targetUserId && target.email) {
    const targetUser = await db.findUserByEmail(database, target.email);
    if (!targetUser) {
      throw new NotFoundError('User', target.email);
    }
    targetUserId = targetUser.id;
  }

  await db.addSessionParticipant(database, sessionId, targetUserId!, role as any, ownerUserId);
}
