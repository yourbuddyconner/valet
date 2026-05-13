import { type SessionThread, TERMINAL_SESSION_STATUSES } from '@valet/shared';
import type { Env } from '../env.js';
import * as db from '../lib/db.js';
import type { AppDb } from '../lib/drizzle.js';
import { getDb } from '../lib/drizzle.js';
import { buildDoWebSocketUrl } from '../lib/do-ws-url.js';
import { buildOrchestratorPersonaFiles } from '../lib/orchestrator-persona.js';
import { upsertPersonaByName, upsertPersonaFile } from '../lib/db/personas.js';
import { generateRunnerToken, assembleProviderEnv, assembleCredentialEnv } from '../lib/env-assembly.js';
import { ensureTodayJournal } from '../lib/db/memory-files.js';
import { loadMemorySnapshot, formatMemorySnapshot } from '../lib/memory-snapshot.js';
import { deriveSandboxJwtSecret } from '../lib/jwt.js';

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Stop an existing orchestrator session's DO and mark it terminated in D1.
 * Best-effort: if the DO is already dead or unreachable, we log and continue.
 * This prevents orphaned sandboxes from running in parallel with the new session.
 */
async function stopOldOrchestratorSession(
  env: Env,
  appDb: AppDb,
  oldSessionId: string,
): Promise<void> {
  // 1. Send /stop to the old DO so it tears down the sandbox + runner WebSocket
  try {
    const doId = env.SESSIONS.idFromName(oldSessionId);
    const oldDO = env.SESSIONS.get(doId);
    await oldDO.fetch(new Request('http://do/stop', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reason: 'orchestrator_restart' }),
    }));
    console.log(`[restartOrchestrator] Stopped old DO: ${oldSessionId}`);
  } catch (err) {
    console.warn(`[restartOrchestrator] Failed to stop old DO ${oldSessionId}, proceeding:`, err);
  }

  // 2. Explicitly mark terminated in D1 — the DO's handleStop flushes asynchronously,
  //    so D1 may still show 'running'. Without this, duplicate detection fails.
  try {
    await db.updateSessionStatus(appDb, oldSessionId, 'terminated');
  } catch (err) {
    console.warn(`[restartOrchestrator] Failed to mark old session ${oldSessionId} terminated in D1:`, err);
  }
}

// ─── Restart Orchestrator Session ───────────────────────────────────────────

export async function restartOrchestratorSession(
  env: Env,
  userId: string,
  userEmail: string,
  identity: { id: string; name: string; handle: string; customInstructions?: string | null; personaId?: string | null },
  requestUrl?: string
): Promise<{ sessionId: string }> {
  const appDb = getDb(env.DB);

  // ── Stop ALL non-terminal orchestrator sessions for this user ──
  // Uses getNonTerminalOrchestratorSessions to find legacy UUID-based rows
  // (from before the stable `orchestrator:{userId}` ID scheme) in addition
  // to the current stable-ID row. Without this, old sessions linger as
  // duplicates in D1 and the admin panel.
  const staleSessions = await db.getNonTerminalOrchestratorSessions(env.DB, userId);
  for (const old of staleSessions) {
    console.log(`[restartOrchestrator] Stopping old session ${old.id} (status=${old.status}) before restart`);
    await stopOldOrchestratorSession(env, appDb, old.id);
  }

  // Backfill: create persona for orchestrators that predate persona support
  if (!identity.personaId) {
    const personaName = `${identity.name} (Orchestrator)`;
    const { personaId } = await upsertPersonaByName(appDb, env.DB, 'default', {
      name: personaName,
      description: 'Auto-managed orchestrator persona',
      visibility: 'private',
      createdBy: userId,
    });
    if (identity.customInstructions) {
      await upsertPersonaFile(appDb, {
        id: crypto.randomUUID(),
        personaId,
        filename: 'custom-instructions.md',
        content: identity.customInstructions,
        sortOrder: 10,
      });
    }
    await db.updateOrchestratorIdentity(appDb, identity.id, { personaId });
    identity = { ...identity, personaId };
  }

  const personaFiles = buildOrchestratorPersonaFiles(identity as any);

  // Ensure today's journal exists and load memory snapshot
  await ensureTodayJournal(env.DB, userId);
  const snapshot = await loadMemorySnapshot(env.DB, userId);
  if (snapshot.files.length > 0) {
    personaFiles.push({
      filename: '02-MEMORY-SNAPSHOT.md',
      content: formatMemorySnapshot(snapshot),
      sortOrder: 2,
    });
  }

  const sessionId = `orchestrator:${userId}`;
  const runnerToken = generateRunnerToken();

  await db.upsertOrchestratorSession(appDb, {
    id: sessionId,
    userId,
    workspace: 'orchestrator',
    title: `${identity.name} (Orchestrator)`,
    isOrchestrator: true,
    purpose: 'orchestrator',
    personaId: identity.personaId ?? undefined,
  });

  // Build env vars (LLM keys + orchestrator flag)
  const providerVars = await assembleProviderEnv(appDb, env);
  const credentialVars = await assembleCredentialEnv(appDb, env, userId);
  const envVars: Record<string, string> = {
    IS_ORCHESTRATOR: 'true',
    ...providerVars,
    ...credentialVars,
  };

  const doWsUrl = buildDoWebSocketUrl({
    env,
    sessionId,
    requestUrl,
  });

  // Fetch user preferences (idle timeout, queue mode, model preferences)
  const userRow = await db.getUserById(appDb, userId);
  const idleTimeoutSeconds = userRow?.idleTimeoutSeconds ?? 900;
  const uiQueueMode = userRow?.uiQueueMode ?? 'followup';
  const idleTimeoutMs = idleTimeoutSeconds * 1000;

  // Inject user timezone into sandbox env
  if (userRow?.timezone) {
    envVars['TZ'] = userRow.timezone;
  }

  // Resolve default model: user prefs first, then org prefs as fallback.
  let initialModel: string | undefined;
  if (userRow?.modelPreferences && userRow.modelPreferences.length > 0) {
    initialModel = userRow.modelPreferences[0];
  } else {
    try {
      const orgSettings = await db.getOrgSettings(appDb);
      if (orgSettings.modelPreferences && orgSettings.modelPreferences.length > 0) {
        initialModel = orgSettings.modelPreferences[0];
      }
    } catch {
      // org settings unavailable — no default model
    }
  }

  const spawnRequest = {
    sessionId,
    userId,
    workspace: 'orchestrator',
    imageType: 'base',
    doWsUrl,
    runnerToken,
    jwtSecret: await deriveSandboxJwtSecret(env.ENCRYPTION_KEY, sessionId),
    idleTimeoutSeconds,
    envVars,
    personaFiles,
  };

  // Initialize SessionAgent DO
  const doId = env.SESSIONS.idFromName(sessionId);
  const sessionDO = env.SESSIONS.get(doId);

  try {
    await sessionDO.fetch(new Request('http://do/start', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sessionId,
        userId,
        workspace: 'orchestrator',
        runnerToken,
        backendUrl: env.MODAL_BACKEND_URL.replace('{label}', 'create-session'),
        terminateUrl: env.MODAL_BACKEND_URL.replace('{label}', 'terminate-session'),
        hibernateUrl: env.MODAL_BACKEND_URL.replace('{label}', 'hibernate-session'),
        restoreUrl: env.MODAL_BACKEND_URL.replace('{label}', 'restore-session'),
        idleTimeoutMs,
        queueMode: uiQueueMode,
        spawnRequest,
        initialModel,
      }),
    }));
  } catch (err) {
    console.error('Failed to initialize orchestrator DO:', err);
    await db.updateSessionStatus(appDb, sessionId, 'error', undefined,
      `Failed to initialize orchestrator: ${err instanceof Error ? err.message : String(err)}`);
    throw err;
  }

  return { sessionId };
}

// ─── Onboard Orchestrator ───────────────────────────────────────────────────

export interface OnboardOrchestratorParams {
  name: string;
  handle: string;
  avatar?: string;
  customInstructions?: string;
}

export type OnboardOrchestratorResult =
  | { ok: true; sessionId: string; identity: any; session: any }
  | { ok: false; reason: 'already_exists' }
  | { ok: false; reason: 'handle_taken' }
  | { ok: false; reason: 'name_taken' };

export async function onboardOrchestrator(
  env: Env,
  userId: string,
  userEmail: string,
  params: OnboardOrchestratorParams,
  requestUrl: string,
): Promise<OnboardOrchestratorResult> {
  const appDb = getDb(env.DB);
  let identity = await db.getOrchestratorIdentity(appDb, userId);
  const existingSession = await db.getCurrentOrchestratorSession(env.DB, userId);

  // getCurrentOrchestratorSession already excludes terminal statuses
  if (identity && existingSession) {
    return { ok: false, reason: 'already_exists' };
  }

  // Ensure user exists in DB
  await db.getOrCreateUser(appDb, { id: userId, email: userEmail });

  if (!identity) {
    const handleTaken = await db.getOrchestratorIdentityByHandle(appDb, params.handle);
    if (handleTaken) {
      return { ok: false, reason: 'handle_taken' };
    }
    const nameTaken = await db.getOrchestratorIdentityByName(appDb, params.name);
    if (nameTaken) {
      return { ok: false, reason: 'name_taken' };
    }

    const identityId = crypto.randomUUID();
    const personaName = `${params.name} (Orchestrator)`;

    // Create a real persona for the orchestrator (enables skill attachments)
    const { personaId } = await upsertPersonaByName(appDb, env.DB, 'default', {
      name: personaName,
      description: 'Auto-managed orchestrator persona',
      visibility: 'private',
      createdBy: userId,
    });

    if (params.customInstructions) {
      await upsertPersonaFile(appDb, {
        id: crypto.randomUUID(),
        personaId,
        filename: 'custom-instructions.md',
        content: params.customInstructions,
        sortOrder: 10,
      });
    }

    identity = await db.createOrchestratorIdentity(appDb, {
      id: identityId,
      userId,
      name: params.name,
      handle: params.handle,
      avatar: params.avatar,
      customInstructions: params.customInstructions,
      personaId,
    });
  } else {
    await db.updateOrchestratorIdentity(appDb, identity.id, {
      name: params.name,
      handle: params.handle,
      customInstructions: params.customInstructions,
    });
    identity = (await db.getOrchestratorIdentity(appDb, userId))!;
  }

  const result = await restartOrchestratorSession(env, userId, userEmail, identity, requestUrl);
  const session = await db.getSession(appDb, result.sessionId);
  return { ok: true, sessionId: result.sessionId, identity, session };
}

// ─── Get Orchestrator Info ──────────────────────────────────────────────────

export interface OrchestratorInfo {
  sessionId: string;
  identity: any;
  session: any;
  exists: boolean;
  needsRestart: boolean;
}

export async function getOrchestratorInfo(env: Env, userId: string): Promise<OrchestratorInfo> {
  const database = getDb(env.DB);
  const identity = await db.getOrchestratorIdentity(database, userId);
  const session = await db.getCurrentOrchestratorSession(env.DB, userId);
  const sessionId = session?.id ?? `orchestrator:${userId}`;
  const needsRestart = !!identity && (!session || TERMINAL_SESSION_STATUSES.has(session.status));

  return {
    sessionId,
    identity,
    session,
    exists: !!identity && !!session,
    needsRestart,
  };
}

// ─── Update Orchestrator Identity ───────────────────────────────────────────

export type UpdateIdentityResult =
  | { ok: true; identity: any }
  | { ok: false; error: 'not_found' }
  | { ok: false; error: 'handle_taken' }
  | { ok: false; error: 'name_taken' };

export async function updateOrchestratorIdentity(
  database: AppDb,
  userId: string,
  updates: { name?: string; handle?: string; avatar?: string; customInstructions?: string },
): Promise<UpdateIdentityResult> {
  const identity = await db.getOrchestratorIdentity(database, userId);
  if (!identity) {
    return { ok: false, error: 'not_found' };
  }

  if (updates.handle && updates.handle !== identity.handle) {
    const handleTaken = await db.getOrchestratorIdentityByHandle(database, updates.handle);
    if (handleTaken) {
      return { ok: false, error: 'handle_taken' };
    }
  }

  if (updates.name && updates.name !== identity.name) {
    const nameTaken = await db.getOrchestratorIdentityByName(database, updates.name);
    if (nameTaken) {
      return { ok: false, error: 'name_taken' };
    }
  }

  await db.updateOrchestratorIdentity(database, identity.id, updates);
  const updated = await db.getOrchestratorIdentity(database, userId);
  return { ok: true, identity: updated };
}

// ─── Dispatch Orchestrator Prompt ───────────────────────────────────────────

type OrchestratorPromptDispatchResult = {
  dispatched: boolean;
  sessionId: string;
  reason?: string;
  retryAfterMs?: number;
};

export async function dispatchOrchestratorPrompt(
  env: Env,
  params: {
    userId: string;
    content: string;
    /** Context prepended to content for the agent but NOT saved to the message DB (e.g., thread history) */
    contextPrefix?: string;
    authorName?: string;
    authorEmail?: string;
    channelType?: string;
    channelId?: string;
    threadId?: string;
    /** Always create a new thread instead of reusing the active one (e.g. for scheduled triggers). */
    forceNewThread?: boolean;
    attachments?: Array<{ type: string; mime: string; url: string; filename?: string }>;
    /** Explicit reply target. If present, the DO auto-replies to this channel on turn complete. */
    replyTo?: { channelType: string; channelId: string };
    /** Pre-computed scope key from the channel transport. Passed through to ensureChannelBinding
     *  so the binding's scope key matches the lookup path in the inbound event handler. */
    scopeKey?: string;
  }
): Promise<OrchestratorPromptDispatchResult> {
  // When forcing a new thread, prepend a memory instruction so the agent knows
  // it has no prior conversation context and should lean on its memory system.
  let content = params.content.trim();
  if (params.forceNewThread && content) {
    content = `[This is a scheduled task running in a fresh thread — you have no prior conversation context. Use mem_search and mem_read to recall any relevant context before proceeding, and mem_write to persist important findings or decisions.]\n\n${content}`;
  }
  if (!content && (!params.attachments || params.attachments.length === 0)) {
    return { dispatched: false, sessionId: `orchestrator:${params.userId}`, reason: 'empty_prompt' };
  }

  // Check if orchestrator identity exists
  const appDb = getDb(env.DB);
  const identity = await db.getOrchestratorIdentity(appDb, params.userId);
  if (!identity) {
    console.log(`[OrchestratorDispatch] No orchestrator identity for userId=${params.userId}`);
    return { dispatched: false, sessionId: `orchestrator:${params.userId}`, reason: 'orchestrator_not_configured' };
  }

  const sessionId = `orchestrator:${params.userId}`;

  // Ensure the DO is running (wakes from hibernation, triggers recovery, etc.)
  const doId = env.SESSIONS.idFromName(sessionId);
  const sessionDO = env.SESSIONS.get(doId);

  const ensureRes = await sessionDO.fetch(new Request('http://do/ensure-running', { method: 'POST' }));
  if (ensureRes.status === 503) {
    const body = await ensureRes.json() as { status: string; retryAfterMs?: number };
    console.log(`[OrchestratorDispatch] DO in backoff: session=${sessionId} retryAfterMs=${body.retryAfterMs}`);
    return { dispatched: false, sessionId, reason: 'backoff', retryAfterMs: body.retryAfterMs };
  }
  if (ensureRes.status === 500) {
    // DO has no spawn config (fresh/evicted). Initialize via restartOrchestratorSession.
    // This path is not fully serialized — concurrent messages may both trigger initialization.
    // The DO's /start handler and runner token rotation ensure only one sandbox wins;
    // the losing spawn will idle-terminate. Acceptable during the migration window.
    try {
      await restartOrchestratorSession(env, params.userId, '', identity);
    } catch (err) {
      console.error(`[OrchestratorDispatch] Failed to initialize DO:`, err);
      return { dispatched: false, sessionId, reason: 'initialization_failed' };
    }
  }

  console.log(`[OrchestratorDispatch] Dispatching to session=${sessionId}`);

  // Ensure a threadId is set for orchestrator sessions. The frontend filters
  // messages by active thread, so messages without a threadId are invisible.
  if (!params.threadId) {
    try {
      let thread: SessionThread | null = null;
      if (!params.forceNewThread) {
        thread = await db.getActiveThread(env.DB, sessionId);
      }
      if (!thread) {
        const id = crypto.randomUUID();
        thread = await db.createThread(env.DB, { id, sessionId });
      }
      params.threadId = thread.id;
      console.log(`[OrchestratorDispatch] Auto-resolved threadId=${thread.id} for session=${sessionId} forceNew=${!!params.forceNewThread}`);
    } catch (err) {
      console.warn(`[OrchestratorDispatch] Failed to resolve thread:`, err);
    }
  }

  // Ensure a D1 channel binding exists for non-web channels so that downstream code
  // (interactive prompts, list-channels, auto-replies) can discover the channel.
  // Requires a pre-computed scopeKey from the caller (via transport.scopeKeyParts +
  // channelScopeKey) to guarantee the binding matches the inbound lookup path.
  if (params.channelType && params.channelId && params.channelType !== 'web' && params.scopeKey) {
    try {
      await db.ensureChannelBinding(appDb, {
        sessionId,
        channelType: params.channelType as any,
        channelId: params.channelId,
        userId: params.userId,
        orgId: 'default',
        scopeKey: params.scopeKey,
      });
    } catch (err) {
      // Best-effort — don't block message dispatch
      console.warn(`[OrchestratorDispatch] Failed to ensure channel binding:`, err);
    }
  }

  const doRes = await sessionDO.fetch(new Request('http://do/prompt', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content,
      contextPrefix: params.contextPrefix,
      channelType: params.channelType,
      channelId: params.channelId,
      threadId: params.threadId,
      attachments: params.attachments,
      authorName: params.authorName,
      authorEmail: params.authorEmail,
      authorId: params.userId,
      replyTo: params.replyTo,
      queueMode: 'steer',
    }),
  }));

  if (!doRes.ok) {
    const errText = (await doRes.text().catch(() => '')).slice(0, 200);
    console.log(`[OrchestratorDispatch] DO dispatch failed: status=${doRes.status} body=${errText}`);
    return {
      dispatched: false,
      sessionId,
      reason: `orchestrator_dispatch_failed:${doRes.status}${errText ? `:${errText}` : ''}`,
    };
  }

  console.log(`[OrchestratorDispatch] Success: session=${sessionId}`);
  return { dispatched: true, sessionId };
}
