import type { Env } from '../env.js';
import * as db from '../lib/db.js';
import type { AppDb } from '../lib/drizzle.js';
import { getDb } from '../lib/drizzle.js';
import { buildDoWebSocketUrl } from '../lib/do-ws-url.js';
import { buildOrchestratorPersonaFiles } from '../lib/orchestrator-persona.js';
import { createPersona, upsertPersonaFile } from '../lib/db/personas.js';
import { generateRunnerToken, assembleProviderEnv, assembleCredentialEnv } from '../lib/env-assembly.js';
import { ensureTodayJournal } from '../lib/db/memory-files.js';
import { loadMemorySnapshot, formatMemorySnapshot } from '../lib/memory-snapshot.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const TERMINAL_STATUSES = new Set(['terminated', 'archived', 'error']);
const ORCHESTRATOR_UNAVAILABLE_STATUSES = new Set(['terminated', 'archived', 'error']);

// ─── Restart Orchestrator Session ───────────────────────────────────────────

export async function restartOrchestratorSession(
  env: Env,
  userId: string,
  userEmail: string,
  identity: { id: string; name: string; handle: string; customInstructions?: string | null; personaId?: string | null },
  requestUrl?: string
): Promise<{ sessionId: string }> {
  const appDb = getDb(env.DB);

  // Backfill: create persona for orchestrators that predate persona support
  if (!identity.personaId) {
    const personaId = crypto.randomUUID();
    const slug = `orchestrator-${identity.handle}-${personaId.slice(0, 8)}`;
    try {
      await createPersona(appDb, {
        id: personaId,
        name: `${identity.name} (Orchestrator)`,
        slug,
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
    } catch (err) {
      console.warn('[Orchestrator] Failed to backfill persona, continuing without:', err);
    }
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

  const sessionId = `orchestrator:${userId}:${crypto.randomUUID()}`;
  const runnerToken = generateRunnerToken();

  await db.createSession(appDb, {
    id: sessionId,
    userId,
    workspace: 'orchestrator',
    title: `${identity.name} (Orchestrator)`,
    isOrchestrator: true,
    purpose: 'orchestrator',
    personaId: identity.personaId ?? undefined,
  });

  // Migrate channel bindings from ALL previous orchestrator sessions to the new one.
  // This covers both terminal sessions and sessions whose D1 status hasn't caught up
  // with the DO's actual state (status flush lag). Must run AFTER createSession so
  // the FK constraint on session_id is satisfied.
  try {
    await env.DB.prepare(
      `UPDATE channel_bindings SET session_id = ?
       WHERE user_id = ? AND session_id != ? AND session_id IN (
         SELECT id FROM sessions WHERE user_id = ? AND is_orchestrator = 1
       )`
    ).bind(sessionId, userId, sessionId, userId).run();
  } catch (err) {
    console.warn('[restartOrchestrator] Failed to migrate bindings:', err);
  }

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
    jwtSecret: env.ENCRYPTION_KEY,
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
  | { ok: false; reason: 'handle_taken' };

export async function onboardOrchestrator(
  env: Env,
  userId: string,
  userEmail: string,
  params: OnboardOrchestratorParams,
  requestUrl: string,
): Promise<OnboardOrchestratorResult> {
  const appDb = getDb(env.DB);
  let identity = await db.getOrchestratorIdentity(appDb, userId);
  const existingSession = await db.getOrchestratorSession(env.DB, userId);

  if (identity && existingSession && !TERMINAL_STATUSES.has(existingSession.status)) {
    return { ok: false, reason: 'already_exists' };
  }

  // Ensure user exists in DB
  await db.getOrCreateUser(appDb, { id: userId, email: userEmail });

  if (!identity) {
    const handleTaken = await db.getOrchestratorIdentityByHandle(appDb, params.handle);
    if (handleTaken) {
      return { ok: false, reason: 'handle_taken' };
    }

    const identityId = crypto.randomUUID();
    const personaId = crypto.randomUUID();

    // Create a real persona for the orchestrator (enables skill attachments)
    await createPersona(appDb, {
      id: personaId,
      name: `${params.name} (Orchestrator)`,
      slug: `orchestrator-${params.handle}-${personaId.slice(0, 8)}`,
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
  const session = await db.getOrchestratorSession(env.DB, userId);
  const sessionId = session?.id ?? `orchestrator:${userId}`;
  const needsRestart = !!identity && (!session || TERMINAL_STATUSES.has(session.status));

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
  | { ok: false; error: 'handle_taken' };

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

  await db.updateOrchestratorIdentity(database, identity.id, updates);
  const updated = await db.getOrchestratorIdentity(database, userId);
  return { ok: true, identity: updated };
}

// ─── Dispatch Orchestrator Prompt ───────────────────────────────────────────

type OrchestratorPromptDispatchResult = {
  dispatched: boolean;
  sessionId: string;
  reason?: string;
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
    attachments?: Array<{ type: string; mime: string; url: string; filename?: string }>;
  }
): Promise<OrchestratorPromptDispatchResult> {
  const content = params.content.trim();
  if (!content && (!params.attachments || params.attachments.length === 0)) {
    return { dispatched: false, sessionId: `orchestrator:${params.userId}`, reason: 'empty_prompt' };
  }

  // Resolve the current orchestrator session (supports rotated IDs)
  console.log(`[OrchestratorDispatch] Looking up orchestrator for userId=${params.userId} channelType=${params.channelType} channelId=${params.channelId}`);
  const session = await db.getOrchestratorSession(env.DB, params.userId);
  if (!session || session.purpose !== 'orchestrator') {
    console.log(`[OrchestratorDispatch] No orchestrator found for userId=${params.userId} session=${session?.id || 'null'} purpose=${session?.purpose || 'null'}`);
    return { dispatched: false, sessionId: `orchestrator:${params.userId}`, reason: 'orchestrator_not_configured' };
  }
  const sessionId = session.id;
  if (ORCHESTRATOR_UNAVAILABLE_STATUSES.has(session.status)) {
    console.log(`[OrchestratorDispatch] Orchestrator unavailable: session=${sessionId} status=${session.status}`);
    return { dispatched: false, sessionId, reason: `orchestrator_unavailable:${session.status}` };
  }

  console.log(`[OrchestratorDispatch] Dispatching to session=${sessionId} status=${session.status}`);

  // Ensure a threadId is set for orchestrator sessions. The frontend filters
  // messages by active thread, so messages without a threadId are invisible.
  if (!params.threadId) {
    try {
      let thread = await db.getActiveThread(env.DB, sessionId);
      if (!thread) {
        const id = crypto.randomUUID();
        thread = await db.createThread(env.DB, { id, sessionId });
      }
      params.threadId = thread.id;
      console.log(`[OrchestratorDispatch] Auto-resolved threadId=${thread.id} for session=${sessionId}`);
    } catch (err) {
      console.warn(`[OrchestratorDispatch] Failed to resolve thread:`, err);
    }
  }

  // Ensure a D1 channel binding exists for non-web channels so that downstream code
  // (interactive prompts, list-channels, auto-replies) can discover the channel.
  // Uses the dispatch-format channelId (e.g. "D123:thread_ts") and ON CONFLICT IGNORE.
  if (params.channelType && params.channelId && params.channelType !== 'web') {
    try {
      const appDb = getDb(env.DB);
      await db.ensureChannelBinding(appDb, {
        sessionId,
        channelType: params.channelType as any,
        channelId: params.channelId,
        userId: params.userId,
        orgId: 'default',
      });
    } catch (err) {
      // Best-effort — don't block message dispatch
      console.warn(`[OrchestratorDispatch] Failed to ensure channel binding:`, err);
    }
  }

  // Normalize channel metadata to match what the DO stores: when a threadId is
  // present, the DO routes via thread:threadId. D1 must store the same values
  // so both stores are consistent for the same message.
  const normalizedChannelType = params.threadId ? 'thread' : params.channelType;
  const normalizedChannelId = params.threadId ? params.threadId : params.channelId;

  const doId = env.SESSIONS.idFromName(sessionId);
  const sessionDO = env.SESSIONS.get(doId);
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

  // Save message to D1 only after the DO has accepted it.
  // This prevents orphaned messages in history that were never processed.
  const messageId = crypto.randomUUID();
  await db.saveMessage(env.DB, {
    id: messageId,
    sessionId,
    role: 'user',
    content,
    authorId: params.userId,
    authorName: params.authorName,
    authorEmail: params.authorEmail,
    channelType: normalizedChannelType,
    channelId: normalizedChannelId,
    threadId: params.threadId,
  });

  console.log(`[OrchestratorDispatch] Success: session=${sessionId} messageId=${messageId}`);
  return { dispatched: true, sessionId };
}
