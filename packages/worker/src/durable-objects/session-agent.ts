import type { Env } from '../env.js';
import type { AppDb } from '../lib/drizzle.js';
import { getDb } from '../lib/drizzle.js';
import { updateSessionStatus, updateSessionMetrics, addActiveSeconds, updateSessionGitState, upsertSessionFileChanged, updateSessionTitle, getSession, getSessionGitState, getChildSessions, listUserChannelBindings, listOrgRepositories, getUserById, getUsersByIds, createMailboxMessage, getOrgSettings, isNotificationWebEnabled, batchInsertAnalyticsEvents, batchUpsertMessages, updateUserDiscoveredModels, setCatalogCache, updateThread, incrementThreadMessageCount, getThreadOriginChannel } from '../lib/db.js';
import { getCredential, type CredentialResult } from '../services/credentials.js';
import { memRead, memWrite, memPatch, memRm, memSearch } from '../services/session-memory.js';
import { getSlackBotToken } from '../services/slack.js';
import { buildOrchestratorPersonaFiles } from '../lib/orchestrator-persona.js';
import { assembleCustomProviders, assembleBuiltInProviderModelConfigs, assembleRepoEnv } from '../lib/env-assembly.js';
import { resolveAvailableModels } from '../services/model-catalog.js';
import { integrationRegistry } from '../integrations/registry.js';
import { updateIntegrationStatus } from '../lib/db/integrations.js';
import { approveInvocation, denyInvocation } from '../services/actions.js';
import { updateInvocationStatus } from '../lib/db/actions.js';
import { getActivePluginArtifacts, getPluginSettings } from '../lib/db/plugins.js';
import { getPersonaSkills, getOrgDefaultSkills, getPersonaToolWhitelist } from '../lib/db.js';
import type { ChannelTarget, ChannelContext, InteractivePrompt, InteractiveAction, InteractivePromptRef, InteractiveResolution } from '@valet/sdk';
import { MessageStore } from './message-store.js';
import { ChannelRouter } from './channel-router.js';
import { PromptQueue } from './prompt-queue.js';
import { RunnerLink, type RunnerToDOMessage, type DOToRunnerMessage, type PromptAttachment, type RunnerMessageHandlers, type WorkflowExecutionDispatchPayload, type DOMessageOf } from './runner-link.js';
import { SessionState, type SessionStartParams } from './session-state.js';
import { SessionLifecycle, SandboxAlreadyExitedError, SandboxSnapshotFailedError } from './session-lifecycle.js';
import { SessionHealthMonitor, type HealthSnapshot } from './session-health-monitor.js';
import { resolveOrchestratorPersona } from '../services/persona.js';
import { mailboxSend, mailboxCheck } from '../services/session-mailbox.js';
import { taskCreate, taskList, taskUpdate, taskMy } from '../services/session-tasks.js';
import { handleIdentityAction } from '../services/session-identity.js';
import { handleSkillAction } from '../services/session-skills.js';
import { handlePersonaAction, listPersonasForRunner } from '../services/session-personas.js';
import { spawnChild, sendSessionMessage, getSessionMessages, forwardMessages, terminateChild, listChildSessions, getSessionStatus, listChannels } from '../services/session-cross.js';
import { listTools as listToolsSvc, resolveActionPolicy, executeAction as executeActionSvc, type CredentialCache } from '../services/session-tools.js';
import {
  workflowList as workflowListSvc,
  workflowSync as workflowSyncSvc,
  workflowRun as workflowRunSvc,
  workflowExecutions as workflowExecutionsSvc,
  handleWorkflowAction as handleWorkflowActionSvc,
  handleTriggerAction as handleTriggerActionSvc,
  handleExecutionAction as handleExecutionActionSvc,
  processWorkflowExecutionResult as processWorkflowExecutionResultSvc,
  buildWorkflowDispatch,
} from '../services/session-workflows.js';
import { sanitizePromptAttachments, attachmentPartsForMessage, parseQueuedPromptAttachments, SUPPORTED_FILE_TYPES_DESCRIPTION } from '../lib/utils/prompt-validation.js';
import { parseQueuedWorkflowPayload, deriveRuntimeStates } from '../lib/utils/runtime.js';

// ─── WebSocket Message Types ───────────────────────────────────────────────

const MAX_CHANNEL_FOLLOWUP_REMINDERS = 3;
const PARENT_IDLE_DEBOUNCE_MS = 10_000;
const ACTION_APPROVAL_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

function buildThreadContinuationContext(rows: Array<{ role?: unknown; content?: unknown }>): string {
  return rows
    .map((row) => {
      const role = typeof row.role === 'string' ? row.role : 'assistant';
      const content = typeof row.content === 'string' ? row.content : '';
      const truncated = content.length > 500 ? `${content.slice(0, 500)}...` : content;
      return `[${role}]: ${truncated}`;
    })
    .join('\n');
}

/** Messages sent by browser clients to the DO */
interface ClientMessage {
  type: 'prompt' | 'answer' | 'ping' | 'abort' | 'revert' | 'diff' | 'review' | 'command' | 'approve-action' | 'deny-action';
  content?: string;
  model?: string;
  queueMode?: 'followup' | 'collect' | 'steer';
  attachments?: PromptAttachment[];
  questionId?: string;
  answer?: string | boolean;
  messageId?: string;
  requestId?: string;
  command?: string;
  args?: string;
  channelType?: string;
  channelId?: string;
  threadId?: string;
  continuationContext?: string;
  invocationId?: string;
  reason?: string;
}

/** Messages sent from DO to clients */
interface ClientOutbound {
  type: 'message' | 'message.updated' | 'messages.removed' | 'stream' | 'chunk' | 'interactive_prompt' | 'interactive_prompt_resolved' | 'interactive_prompt_expired' | 'status' | 'pong' | 'error' | 'user.joined' | 'user.left' | 'agentStatus' | 'models' | 'diff' | 'review-result' | 'command-result' | 'git-state' | 'pr-created' | 'files-changed' | 'child-session' | 'title' | 'audit_log' | 'model-switched' | 'toast' | 'integration-auth-required' | 'thread.created' | 'thread.updated';
  [key: string]: unknown;
}

// ─── Durable SQLite Table Schemas ──────────────────────────────────────────

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS interactive_prompts (
    id TEXT PRIMARY KEY,
    type TEXT NOT NULL,
    request_id TEXT,
    title TEXT NOT NULL,
    body TEXT,
    actions TEXT,
    context TEXT,
    channel_refs TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    expires_at INTEGER
  );

  CREATE TABLE IF NOT EXISTS prompt_queue (
    id TEXT PRIMARY KEY,
    content TEXT NOT NULL,
    attachments TEXT, -- JSON array of prompt attachments
    model TEXT, -- user-selected model override
    queue_type TEXT NOT NULL DEFAULT 'prompt' CHECK(queue_type IN ('prompt', 'workflow_execute')),
    workflow_execution_id TEXT,
    workflow_payload TEXT,
    status TEXT NOT NULL DEFAULT 'queued' CHECK(status IN ('queued', 'processing', 'completed')),
    author_id TEXT,
    author_email TEXT,
    author_name TEXT,
    author_avatar_url TEXT,
    channel_type TEXT,
    channel_id TEXT,
    channel_key TEXT, -- computed key for per-channel queuing (e.g. "web:default", "telegram:12345")
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS state (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS connected_users (
    user_id TEXT PRIMARY KEY,
    connected_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

  CREATE TABLE IF NOT EXISTS analytics_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    turn_id TEXT,
    duration_ms INTEGER,
    channel TEXT,
    model TEXT,
    queue_mode TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    tool_name TEXT,
    error_code TEXT,
    summary TEXT,
    actor_id TEXT,
    properties TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    flushed INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS channel_followups (
    id TEXT PRIMARY KEY,
    channel_type TEXT NOT NULL,
    channel_id TEXT NOT NULL,
    original_content TEXT,
    created_at INTEGER NOT NULL,
    next_reminder_at INTEGER NOT NULL,
    reminder_count INTEGER DEFAULT 0,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'resolved'))
  );

  CREATE TABLE IF NOT EXISTS channel_state (
    channel_key TEXT PRIMARY KEY,
    busy INTEGER NOT NULL DEFAULT 0,
    opencode_session_id TEXT
  );

`;

// ─── SessionAgentDO ────────────────────────────────────────────────────────

interface CachedUserDetails {
  id: string;
  email: string;
  name?: string;
  avatarUrl?: string;
  gitName?: string;
  gitEmail?: string;
  modelPreferences?: string[];
}

export class SessionAgentDO {
  private ctx: DurableObjectState;
  private env: Env;
  private initialized = false;
  private userDetailsCache = new Map<string, CachedUserDetails>();

  /** In-memory cache of discovered tool risk levels. Populated by handleListTools,
   *  used by handleCallTool to avoid re-fetching listActions on every invocation. */
  private discoveredToolRiskLevels = new Map<string, string>();

  /** In-memory credential cache to avoid repeated D1 lookups + PBKDF2 decryption.
   *  Keyed by "ownerType:ownerId:service:credentialType", entries expire after CREDENTIAL_CACHE_TTL_MS. */
  private credentialCache = new Map<string, { result: CredentialResult; expiresAt: number }>();
  private static readonly CREDENTIAL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  /** In-memory cache of disabled plugin services to avoid D1 query on every tool invocation. */
  private disabledPluginServicesCache: { services: Set<string>; expiresAt: number } | null = null;
  private static readonly DISABLED_PLUGINS_CACHE_TTL_MS = 60 * 1000; // 1 minute

  private getCachedCredential(ownerType: string, ownerId: string, service: string, credentialType?: string): CredentialResult | null {
    const key = `${ownerType}:${ownerId}:${service}:${credentialType || '*'}`;
    const entry = this.credentialCache.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      if (entry) this.credentialCache.delete(key);
      return null;
    }
    return entry.result;
  }

  private setCachedCredential(ownerType: string, ownerId: string, service: string, result: CredentialResult, credentialType?: string): void {
    const key = `${ownerType}:${ownerId}:${service}:${credentialType || '*'}`;
    this.credentialCache.set(key, {
      result,
      expiresAt: Date.now() + SessionAgentDO.CREDENTIAL_CACHE_TTL_MS,
    });
  }

  private invalidateCachedCredential(ownerType: string, ownerId: string, service: string, credentialType?: string): void {
    this.credentialCache.delete(`${ownerType}:${ownerId}:${service}:${credentialType || '*'}`);
  }

  private messageStore!: MessageStore;
  private promptQueue!: PromptQueue;
  private runnerLink!: RunnerLink;
  private sessionState!: SessionState;
  private lifecycle!: SessionLifecycle;

  /** Timestamp when the runner disconnected. Null if connected or never connected.
   *  After 60s without reconnection, the session is terminated. */
  private runnerDisconnectedAt: number | null = null;
  private static readonly RUNNER_GRACE_PERIOD_MS = 60_000;

  private readonly healthMonitor = new SessionHealthMonitor();

  /** Debounce timer for flushing messages to D1 during active turns. */
  private d1FlushTimer: ReturnType<typeof setTimeout> | null = null;

  private channelRouter = new ChannelRouter({
    resolveToken: async (channelType, userId) => {
      if (channelType === 'slack') {
        return await getSlackBotToken(this.env) ?? undefined;
      }
      const credResult = await getCredential(this.env, 'user', userId, channelType);
      return credResult.ok ? credResult.credential.accessToken : undefined;
    },
    resolvePersona: (userId) =>
      resolveOrchestratorPersona(this.appDb, userId).catch(() => undefined),
    onReplySent: async (channelType, channelId) => {
      this.resolveChannelFollowups(channelType, channelId);
    },
  });

  /** Drizzle AppDb instance wrapping the D1 binding. */
  private get appDb(): AppDb { return getDb(this.env.DB); }

  /** Resolve the org ID from org settings. Returns undefined if unavailable. */
  private async resolveOrgId(): Promise<string | undefined> {
    try {
      const orgSettings = await getOrgSettings(this.appDb);
      return orgSettings?.id;
    } catch {
      return undefined;
    }
  }

  /** Returns the channel metadata for the currently active prompt, if any. */
  private get activeChannel(): { channelType: string; channelId: string } | null {
    const current = this.channelRouter.activeChannel;
    if (current) return current;
    // Hibernation recovery: check prompt_queue for processing row with channel metadata.
    // Keep this orchestration logic inside the DO rather than extracting extra
    // production seams just for tests; cover the lifecycle with a black-box DO
    // harness instead of widening the runtime surface area.
    const recovered = this.promptQueue.getProcessingChannelContext();
    if (recovered) {
      console.log(`[SessionAgentDO] Recovered activeChannel from prompt_queue: ${recovered.channelType}:${recovered.channelId}`);
      this.channelRouter.recoverActiveChannel(recovered.channelType, recovered.channelId);
    }
    return recovered;
  }

  private sameChannelTarget(
    a: { channelType?: string | null; channelId?: string | null } | null | undefined,
    b: { channelType?: string | null; channelId?: string | null } | null | undefined,
  ): boolean {
    if (!a?.channelType || !a?.channelId || !b?.channelType || !b?.channelId) return false;
    return a.channelType === b.channelType && a.channelId === b.channelId;
  }

  private getPromptOriginTarget(context: Record<string, unknown> | null | undefined): { channelType: string; channelId: string } | null {
    if (!context || typeof context !== 'object') return null;
    const channelType = typeof context.channelType === 'string' ? context.channelType : null;
    const channelId = typeof context.channelId === 'string' ? context.channelId : null;
    if (!channelType || !channelId) return null;
    return { channelType, channelId };
  }

  constructor(ctx: DurableObjectState, env: Env) {
    this.ctx = ctx;
    this.env = env;

    // Run schema migration on construction (blockConcurrencyWhile ensures it completes before any request)
    this.ctx.blockConcurrencyWhile(async () => {
      this.ctx.storage.sql.exec(SCHEMA_SQL);
      this.sessionState = new SessionState(this.ctx.storage.sql);
      this.messageStore = new MessageStore(this.ctx.storage.sql);
      const stateDeps = {
        getState: (key: string) => this.sessionState.get(key),
        setState: (key: string, value: string) => this.sessionState.set(key, value),
      };
      this.promptQueue = new PromptQueue(this.ctx.storage.sql, stateDeps);
      this.promptQueue.runMigrations();
      this.runnerLink = new RunnerLink({
        getRunnerSockets: () => this.ctx.getWebSockets('runner'),
        ...stateDeps,
      });
      this.lifecycle = new SessionLifecycle(this.sessionState, this.ctx);

      this.initialized = true;
    });
  }

  private async getUserDetails(userId: string): Promise<CachedUserDetails | undefined> {
    const cached = this.userDetailsCache.get(userId);
    if (cached) return cached;

    try {
      const userRow = await getUserById(this.appDb, userId);
      if (!userRow) return undefined;
      const details: CachedUserDetails = {
        id: userRow.id,
        email: userRow.email,
        name: userRow.name,
        avatarUrl: userRow.avatarUrl,
        gitName: userRow.gitName,
        gitEmail: userRow.gitEmail,
        modelPreferences: userRow.modelPreferences,
      };
      this.userDetailsCache.set(userId, details);
      return details;
    } catch (err) {
      console.error('[SessionAgentDO] Failed to fetch user details:', err);
      return undefined;
    }
  }

  /**
   * Resolve model preferences: user prefs if set, otherwise org prefs as fallback.
   */
  private async resolveModelPreferences(ownerDetails?: CachedUserDetails): Promise<string[] | undefined> {
    if (ownerDetails?.modelPreferences && ownerDetails.modelPreferences.length > 0) {
      return ownerDetails.modelPreferences;
    }
    try {
      const orgSettings = await getOrgSettings(this.appDb);
      return orgSettings.modelPreferences;
    } catch (err) {
      console.error('[SessionAgentDO] Failed to fetch org settings for model preferences:', err);
      return undefined;
    }
  }

  // ─── Entry Point ───────────────────────────────────────────────────────

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    // WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocketUpgrade(request, url);
    }

    // Internal control endpoints
    switch (url.pathname) {
      case '/start':
        return this.handleStart(request);
      case '/stop': {
        let reason: string | undefined;
        if (request.method === 'POST') {
          try {
            const body = await request.json() as { reason?: string };
            if (body?.reason) reason = body.reason;
          } catch {
            // ignore missing/invalid body
          }
        }
        return this.handleStop(reason);
      }
      case '/status':
        return this.handleStatus();
      case '/wake':
        return this.handleWake();
      case '/hibernate':
        return this.handleHibernate();
      case '/clear-queue':
        return this.handleClearQueue();
      case '/flush-metrics':
        return this.handleFlushMetrics();
      case '/messages':
        return this.handleMessagesEndpoint(url);
      case '/gc':
        return this.handleGarbageCollect();
      case '/webhook-update':
        return this.handleWebhookUpdate(request);
      case '/models': {
        const models = this.sessionState.availableModels || [];
        return Response.json({ models });
      }
      case '/queue-mode': {
        const body = await request.json() as { queueMode: string; collectDebounceMs?: number };
        this.promptQueue.queueMode = body.queueMode;
        if (body.collectDebounceMs !== undefined) {
          this.promptQueue.collectDebounceMs = body.collectDebounceMs;
        }
        return Response.json({ success: true });
      }
      case '/prompt': {
        // Reject prompts if the session is in a terminal state — no runner will ever
        // connect to process queued prompts, so accepting them would silently drop messages.
        const promptStatus = this.sessionState.status;
        if (promptStatus === 'terminated' || promptStatus === 'archived' || promptStatus === 'error') {
          return new Response(JSON.stringify({ error: `Session is ${promptStatus}` }), { status: 409 });
        }

        // HTTP-based prompt submission (alternative to WebSocket)
        const body = await request.json() as { content?: string; contextPrefix?: string; model?: string; attachments?: PromptAttachment[]; interrupt?: boolean; queueMode?: string; channelType?: string; channelId?: string; threadId?: string; authorName?: string; authorEmail?: string; authorId?: string; replyTo?: { channelType: string; channelId: string } };
        const content = body.content ?? '';
        const { attachments, rejectedTypes } = sanitizePromptAttachments(body.attachments);
        if (rejectedTypes.length > 0) {
          console.warn(`[SessionAgentDO] /prompt HTTP: rejected file types: ${rejectedTypes.join(', ')}`);
        }
        console.log(`[SessionAgentDO] /prompt HTTP: content="${content.slice(0, 60)}" channelType=${body.channelType || 'none'} channelId=${body.channelId || 'none'} queueMode=${body.queueMode || 'default'} authorName=${body.authorName || 'none'} authorId=${body.authorId || 'none'}`);
        if (!content && attachments.length === 0) {
          return new Response(JSON.stringify({ error: 'Missing content or attachments' }), { status: 400 });
        }
        // Route prompts through the selected queue mode. If none is provided,
        // fall back to the DO's configured default.
        const effectiveMode = body.interrupt ? 'steer' : (body.queueMode || this.promptQueue.queueMode || 'followup');
        console.log(`[SessionAgentDO] /prompt HTTP: effectiveMode=${effectiveMode} runnerBusy=${this.promptQueue.runnerBusy} runnerConnected=${this.runnerLink.isConnected}`);

        const author = (body.authorId || body.authorEmail) ? {
          id: body.authorId || '',
          email: body.authorEmail || '',
          name: body.authorName,
        } : undefined;

        switch (effectiveMode) {
          case 'steer':
            await this.handleInterruptPrompt(content, body.model, author, attachments, body.channelType, body.channelId, body.threadId, body.contextPrefix);
            break;
          case 'collect':
            await this.handleCollectPrompt(content, body.model, author, attachments, body.channelType, body.channelId, body.threadId, body.contextPrefix);
            break;
          default:
            await this.handlePrompt(content, body.model, author, attachments, body.channelType, body.channelId, body.threadId, undefined, body.contextPrefix, body.replyTo);
            break;
        }
        console.log(`[SessionAgentDO] /prompt HTTP: completed, runnerBusy=${this.promptQueue.runnerBusy}`);
        return Response.json({ success: true });
      }
      case '/system-message': {
        const body = await request.json() as { content: string; parts?: Record<string, unknown>; wake?: boolean; threadId?: string };
        if (!body.content) {
          return new Response(JSON.stringify({ error: 'Missing content' }), { status: 400 });
        }
        await this.handleSystemMessage(body.content, body.parts, body.wake, body.threadId);
        return Response.json({ success: true });
      }
      case '/workflow-execute': {
        if (request.method !== 'POST') {
          return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
        }
        const body = await request.json() as {
          executionId?: string;
          payload?: WorkflowExecutionDispatchPayload;
        };
        return this.handleWorkflowExecuteDispatch(body.executionId, body.payload);
      }
      case '/tunnels': {
        if (request.method !== 'POST') {
          return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
        }
        const body = await request.json() as { action?: 'delete'; name?: string; actorId?: string; actorName?: string; actorEmail?: string };
        if (body.action !== 'delete' || !body.name) {
          return new Response(JSON.stringify({ error: 'Invalid action or missing name' }), { status: 400 });
        }
        await this.handleTunnelDelete(body.name, {
          actorId: body.actorId,
          actorName: body.actorName,
          actorEmail: body.actorEmail,
        });
        return Response.json({ success: true });
      }
      case '/prompt-resolved': {
        if (request.method !== 'POST') {
          return new Response(JSON.stringify({ error: 'Method not allowed' }), { status: 405 });
        }
        const body = await request.json() as { promptId: string; actionId?: string; value?: string; resolvedBy?: string };
        if (!body.promptId) {
          return new Response(JSON.stringify({ error: 'Missing promptId' }), { status: 400 });
        }
        const ownerUserId = this.sessionState.userId;
        if (!body.resolvedBy || !ownerUserId || body.resolvedBy !== ownerUserId) {
          return new Response(JSON.stringify({ error: 'Only the session owner can resolve this prompt' }), { status: 403 });
        }
        await this.handlePromptResolved(body.promptId, {
          actionId: body.actionId,
          value: body.value,
          resolvedBy: body.resolvedBy,
        });
        return Response.json({ success: true });
      }
    }

    // Proxy to sandbox
    if (url.pathname.startsWith('/proxy/')) {
      return this.handleProxy(request, url);
    }

    return new Response('Not found', { status: 404 });
  }

  // ─── WebSocket Upgrade ─────────────────────────────────────────────────

  private async handleWebSocketUpgrade(request: Request, url: URL): Promise<Response> {
    const role = url.searchParams.get('role');

    if (role === 'runner') {
      return this.upgradeRunner(request, url);
    }
    if (role === 'client') {
      return this.upgradeClient(request, url);
    }

    return new Response('Missing or invalid role parameter', { status: 400 });
  }

  private async upgradeClient(_request: Request, url: URL): Promise<Response> {
    const userId = url.searchParams.get('userId');
    if (!userId) {
      return new Response('Missing userId parameter', { status: 400 });
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    // Tag with client:{userId} for hibernation identification
    this.ctx.acceptWebSocket(server, [`client:${userId}`]);

    // Track connected user
    this.ctx.storage.sql.exec(
      'INSERT OR IGNORE INTO connected_users (user_id) VALUES (?)',
      userId
    );

    const status = this.sessionState.status;
    const sandboxId = this.sessionState.sandboxId;
    const connectedUsers = this.getConnectedUserIds();
    const sessionId = this.sessionState.sessionId;
    const workspace = this.sessionState.workspace;
    const title = this.sessionState.title;

    // Keep the websocket handshake lightweight. The transcript comes from the
    // REST history endpoint; richer session metadata is streamed after open.
    const initPayload = JSON.stringify({
      type: 'init',
      session: {
        id: sessionId,
        status,
        workspace,
        title,
      },
      data: {
        sandboxRunning: !!sandboxId,
        runnerConnected: this.runnerLink.isConnected,
        runnerBusy: this.promptQueue.runnerBusy,
        promptsQueued: this.promptQueue.length,
        connectedClients: this.getClientSockets().length + 1,
        connectedUsers,
      },
    });

    server.send(initPayload);

    this.ctx.waitUntil(this.sendDeferredClientInit(server, userId));

    // Send any pending interactive prompts
    const pendingPrompts = this.ctx.storage.sql
      .exec("SELECT * FROM interactive_prompts WHERE status = 'pending'")
      .toArray();

    for (const p of pendingPrompts) {
      const sessionId = this.sessionState.sessionId;
      const prompt: InteractivePrompt = {
        id: p.id as string,
        sessionId,
        type: p.type as string,
        title: p.title as string,
        body: (p.body as string) || undefined,
        actions: p.actions ? JSON.parse(p.actions as string) : [],
        expiresAt: p.expires_at ? (p.expires_at as number) * 1000 : undefined,
        context: p.context ? JSON.parse(p.context as string) : undefined,
      };
      server.send(JSON.stringify({
        type: 'interactive_prompt',
        prompt,
      }));
    }

    // Notify other clients that a user joined (with enriched user details)
    // Guard against status race: if status changed during init assembly
    // (e.g. spawnSandbox completed via waitUntil while we were building the
    // init payload), send a corrective status message so the client doesn't
    // stay stuck on the stale status from the init message.
    const currentStatus = this.sessionState.status;
    if (currentStatus !== status) {
      const currentSandboxId = this.sessionState.sandboxId;
      try {
        server.send(JSON.stringify({
          type: 'status',
          data: {
            status: currentStatus,
            sandboxRunning: !!currentSandboxId,
            runnerConnected: this.runnerLink.isConnected,
            runnerBusy: this.promptQueue.runnerBusy,
            tunnelUrls: this.sessionState.tunnelUrls,
          },
        }));
      } catch { /* socket may have closed */ }
    }

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': 'valet' },
    });
  }

  private async sendDeferredClientInit(server: WebSocket, userId: string): Promise<void> {
    let userDetails = this.userDetailsCache.get(userId);
    if (!userDetails) {
      try {
        const user = await getUserById(this.appDb, userId);
        if (user) {
          userDetails = {
            id: user.id,
            email: user.email,
            name: user.name || undefined,
            avatarUrl: user.avatarUrl || undefined,
            gitName: user.gitName || undefined,
            gitEmail: user.gitEmail || undefined,
            modelPreferences: user.modelPreferences,
          };
          this.userDetailsCache.set(userId, userDetails);
        }
      } catch (err) {
        console.error('Failed to fetch user details for cache:', err);
      }
    }

    try {
      const availableModels = await resolveAvailableModels(this.appDb, this.env);
      const initOwnerId = this.sessionState.userId;
      const initOwnerDetails = initOwnerId ? await this.getUserDetails(initOwnerId) : undefined;
      const initModelPrefs = await this.resolveModelPreferences(initOwnerDetails);
      const candidateDefault = initModelPrefs?.[0] ?? null;
      const defaultModel = candidateDefault && availableModels
        ? (availableModels.some((p) => p.models.some((m) => m.id === candidateDefault)) ? candidateDefault : null)
        : candidateDefault;
      server.send(JSON.stringify({
        type: 'models',
        models: availableModels,
        defaultModel,
      }));
    } catch (err) {
      console.error('[SessionAgentDO] Failed to resolve deferred models for client init:', err);
    }

    const auditLogRows = this.ctx.storage.sql
      .exec("SELECT event_type, summary, actor_id, properties as metadata, created_at FROM analytics_events WHERE summary IS NOT NULL ORDER BY id ASC")
      .toArray();
    for (const row of auditLogRows) {
      try {
        server.send(JSON.stringify({
          type: 'audit_log',
          entry: {
            eventType: row.event_type,
            summary: row.summary,
            actorId: row.actor_id || undefined,
            metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
            createdAt: row.created_at,
          },
        }));
      } catch {
        break;
      }
    }

    const connectedUsers = await this.getConnectedUsersWithDetails();
    this.broadcastToClients({
      type: 'user.joined',
      userId,
      userDetails: userDetails ? { name: userDetails.name, email: userDetails.email, avatarUrl: userDetails.avatarUrl } : undefined,
      connectedUsers,
    });

    this.emitAuditEvent('user.joined', `${userDetails?.name || userDetails?.email || userId} joined`, userId);

    this.notifyEventBus({
      type: 'session.update',
      sessionId: this.sessionState.sessionId,
      userId,
      data: { event: 'user.joined', connectedUsers },
      timestamp: new Date().toISOString(),
    });
  }

  private async upgradeRunner(_request: Request, url: URL): Promise<Response> {
    const token = url.searchParams.get('token');
    const expectedToken = this.runnerLink.token;

    // DO not yet initialized — runner connected before /start was called (race condition)
    if (!expectedToken) {
      return new Response('Session not initialized yet', { status: 503 });
    }

    if (!token || token !== expectedToken) {
      return new Response('Unauthorized', { status: 401 });
    }

    // Only one runner connection at a time — close existing
    const existingRunners = this.ctx.getWebSockets('runner');
    for (const ws of existingRunners) {
      try {
        ws.close(1000, 'Replaced by new runner connection');
      } catch {
        // ignore
      }
    }

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server, ['runner']);
    console.log('[SessionAgentDO] Runner connected');

    // Clear grace period — runner reconnected in time
    this.runnerDisconnectedAt = null;

    // Emit runner_connect timing — measure time from sandbox start to runner WebSocket
    const runningStart = this.sessionState.runningStartedAt;
    if (runningStart > 0) {
      this.emitEvent('runner_connect', { durationMs: Date.now() - runningStart });
    }

    // Mark runner as not-yet-ready via RunnerLink
    this.runnerLink.onConnect();
    this.runnerLink.connectedAt = Date.now();
    this.rescheduleIdleAlarm(); // arm ready-timeout watchdog

    // Send init message to runner
    server.send(JSON.stringify({ type: 'init' }));

    // Push latest OpenCode config — after hibernation/wake the runner may need
    // updated keys (e.g. admin rotated a provider key while sandbox was hibernated).
    this.sendOpenCodeConfig();
    this.sendPluginContent();
    this.sendRepoConfig();

    // Don't dispatch queued work immediately — the runner isn't ready yet.
    // It needs to start its event stream, discover models, and create OpenCode sessions.
    // The queue will be drained when the runner signals readiness via `agentStatus: idle`.
    const queuedCount = this.promptQueue.length;
    const hasInitialPrompt = !!this.sessionState.initialPrompt;
    console.log(`[SessionAgentDO] Runner connected: deferring dispatch until runner ready (queued=${queuedCount}, hasInitialPrompt=${hasInitialPrompt})`);

    this.broadcastToClients({
      type: 'status',
      data: { runnerConnected: true },
    });

    return new Response(null, { status: 101, webSocket: client });
  }

  // ─── Hibernation Handlers ──────────────────────────────────────────────

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const data = typeof message === 'string' ? message : new TextDecoder().decode(message);
    let parsed: ClientMessage | RunnerToDOMessage;

    try {
      parsed = JSON.parse(data);
    } catch {
      ws.send(JSON.stringify({ type: 'error', message: 'Invalid JSON' }));
      return;
    }

    // Determine if this is a runner or client socket
    const tags = this.ctx.getTags(ws);
    const isRunner = tags.includes('runner');

    console.log(`[SessionAgentDO] WebSocket message: isRunner=${isRunner}, type=${parsed.type}, data=${data.slice(0, 200)}`);

    if (isRunner) {
      await this.runnerLink.handleMessage(
        parsed as RunnerToDOMessage,
        this.runnerHandlers,
        () => {
          this.lifecycle.touchActivity();
          this.rescheduleIdleAlarm();
        },
      );
    } else {
      await this.handleClientMessage(ws, parsed as ClientMessage);
    }
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string, _wasClean: boolean) {
    const tags = this.ctx.getTags(ws);
    const isRunner = tags.includes('runner');

    if (isRunner) {
      console.log(`[SessionAgentDO] Runner disconnected: code=${code} reason="${reason || 'unknown'}"`);
      // Revert any processing prompt back to queued so it can be retried
      this.promptQueue.revertProcessingToQueued();
      this.promptQueue.runnerBusy = false;
      // Track idle-queued timing if items remain after revert
      if (this.promptQueue.length > 0 && !this.promptQueue.idleQueuedSince) {
        this.promptQueue.idleQueuedSince = Date.now();
        this.rescheduleIdleAlarm();
      }
      this.runnerLink.onDisconnect();

      // Start grace period — if runner doesn't reconnect within 60s, terminate
      this.runnerDisconnectedAt = Date.now();
      this.lifecycle.scheduleAlarm(this.collectAlarmDeadlines());

      const queueLength = this.promptQueue.length;
      this.broadcastToClients({
        type: 'status',
        data: {
          runnerConnected: false,
          queuedPrompts: queueLength,
          runnerDisconnected: true,
        },
      });
    } else {
      // Extract userId from tag like "client:abc123"
      const clientTag = tags.find((t) => t.startsWith('client:'));
      if (clientTag) {
        const userId = clientTag.replace('client:', '');

        // Check if user has other connections still open
        const remaining = this.ctx.getWebSockets(`client:${userId}`).filter((s) => s !== ws);
        if (remaining.length === 0) {
          // Last connection for this user — remove from connected_users
          this.ctx.storage.sql.exec('DELETE FROM connected_users WHERE user_id = ?', userId);

          // Grab user details before cleaning up the cache
          const departingUserDetails = this.userDetailsCache.get(userId);
          const connectedUsers = await this.getConnectedUsersWithDetails();
          this.broadcastToClients({
            type: 'user.left',
            userId,
            userDetails: departingUserDetails
              ? { name: departingUserDetails.name, email: departingUserDetails.email, avatarUrl: departingUserDetails.avatarUrl }
              : undefined,
            connectedUsers,
          });

          this.emitAuditEvent('user.left', `${departingUserDetails?.name || departingUserDetails?.email || userId} left`, userId);

          // Clean up user details cache if no longer connected
          this.userDetailsCache.delete(userId);

          this.notifyEventBus({
            type: 'session.update',
            sessionId: this.sessionState.sessionId,
            userId,
            data: { event: 'user.left', connectedUsers: this.getConnectedUserIds() },
            timestamp: new Date().toISOString(),
          });
        }
      }
    }

    // The socket is already closed when webSocketClose fires in hibernation mode.
    // Only attempt close with valid codes (1000-4999, excluding reserved 1005/1006/1015).
    try {
      ws.close(code || 1000, reason || 'Connection closed');
    } catch {
      // Socket already closed or invalid close code — ignore
    }
  }

  async webSocketError(ws: WebSocket, error: unknown) {
    console.error('WebSocket error:', error);
    ws.close(1011, 'Internal error');
  }

  private buildHealthSnapshot(): HealthSnapshot {
    return {
      now: Date.now(),
      runnerConnected: this.runnerLink.isConnected,
      runnerReady: this.runnerLink.isReady,
      runnerBusy: this.promptQueue.runnerBusy,
      queuedCount: this.promptQueue.length,
      processingCount: this.promptQueue.processingCount,
      lastDispatchedAt: this.promptQueue.lastPromptDispatchedAt,
      idleQueuedSince: this.promptQueue.idleQueuedSince,
      errorSafetyNetAt: this.promptQueue.errorSafetyNetAt,
      sessionStatus: this.sessionState.status,
      runnerDisconnectedAt: this.runnerDisconnectedAt,
      runnerConnectedAt: this.runnerLink.connectedAt,
    };
  }

  // ─── Alarm Handler ────────────────────────────────────────────────────

  async alarm() {
    // ─── Early Exit: terminal states don't need alarms ──────────────
    const status = this.sessionState.status;
    if (['terminated', 'archived', 'error', 'hibernated'].includes(status)) {
      return; // don't re-arm
    }

    const now = Date.now();
    const nowSecs = Math.floor(now / 1000);

    // ─── Runner Grace Period Check ──────────────────────────────────
    if (this.runnerDisconnectedAt && now - this.runnerDisconnectedAt >= SessionAgentDO.RUNNER_GRACE_PERIOD_MS) {
      console.log(`[SessionAgentDO] Runner did not reconnect within ${SessionAgentDO.RUNNER_GRACE_PERIOD_MS / 1000}s — terminating session`);
      this.runnerDisconnectedAt = null;
      await this.handleStop('sandbox_lost');
      return; // handleStop transitions to terminal, no re-arm needed
    }

    // ─── Collect Mode Flush Check (Phase D) ──────────────────────────
    if (this.promptQueue.hasCollectFlushDue() || this.promptQueue.hasLegacyCollectFlushDue()) {
      await this.flushCollectBuffer();
    }

    // ─── Idle Hibernate Check ─────────────────────────────────────────
    if (this.lifecycle.checkIdleTimeout()) {
      // Set status immediately to prevent re-entrant hibernation from subsequent alarms.
      // performHibernate() checks this guard and skips if already in progress.
      this.sessionState.status = 'hibernating';
      this.ctx.waitUntil(this.performHibernate());
      // Don't return — still process question expiry below
    }

    // ─── Health Monitor ──────────────────────────────────────────────────
    // Skip if we just transitioned to hibernating — recovery actions would
    // race with performHibernate() tearing down the runner.
    if (this.sessionState.status !== 'hibernating') {
      const snapshot = this.buildHealthSnapshot();
      const result = this.healthMonitor.check(snapshot);

      for (const event of result.events) {
        this.emitEvent(event.eventType, {
          summary: event.cause,
          properties: event.properties,
        });
      }

      for (const action of result.actions) {
        switch (action.type) {
          case 'revert_and_drain':
            this.promptQueue.revertProcessingToQueued();
            this.promptQueue.runnerBusy = false;
            this.promptQueue.clearDispatchTimers();
            this.promptQueue.idleQueuedSince = 0;
            if (this.runnerLink.isConnected) {
              await this.sendNextQueuedPrompt();
            }
            break;
          case 'drain_queue':
            if (await this.sendNextQueuedPrompt()) {
              this.promptQueue.idleQueuedSince = 0;
            }
            break;
          case 'force_complete':
            this.promptQueue.errorSafetyNetAt = 0;
            await this.handlePromptComplete();
            break;
          case 'mark_not_busy':
            this.promptQueue.runnerBusy = false;
            this.promptQueue.clearDispatchTimers();
            if (this.promptQueue.length > 0 && !this.promptQueue.idleQueuedSince) {
              this.promptQueue.idleQueuedSince = Date.now();
            }
            break;
          case 'clear_safety_net':
            this.promptQueue.errorSafetyNetAt = 0;
            break;
        }
        this.broadcastToClients({
          type: 'status',
          data: { runnerBusy: this.promptQueue.runnerBusy, watchdogRecovery: true },
        });
        this.emitAuditEvent(`watchdog.${action.type}`, action.reason);
      }
    }

    // ─── Parent Idle Debounce Flush ─────────────────────────────────
    const parentIdleNotifyAt = this.sessionState.parentIdleNotifyAt;
    if (parentIdleNotifyAt) {
      if (now >= parentIdleNotifyAt) {
        // Re-verify idle conditions before sending
        const idleStatus = this.sessionState.status;
        const idleRunnerBusy = this.promptQueue.runnerBusy;
        const idleQueued = this.promptQueue.length;
        const idleLast = this.sessionState.lastParentIdleNotice;
        const idleSessionId = this.sessionState.sessionId;

        this.sessionState.parentIdleNotifyAt = 0;

        if (idleSessionId && idleStatus === 'running' && !idleRunnerBusy && idleQueued === 0 && idleLast !== 'true') {
          this.sessionState.lastParentIdleNotice = 'true';
          this.ctx.waitUntil(this.notifyParentEvent(`Child session event: ${idleSessionId} is idle.`, { wake: true, childStatus: 'idle' }));
        }
      }
    }

    // ─── Interactive Prompt Expiry ──────────────────────────────────
    const expiredPrompts = this.ctx.storage.sql
      .exec(
        'SELECT id, type, request_id, context, channel_refs FROM interactive_prompts WHERE expires_at IS NOT NULL AND expires_at <= ?',
        nowSecs
      )
      .toArray();

    for (const ep of expiredPrompts) {
      const epId = ep.id as string;
      const epType = ep.type as string;
      const epRequestId = ep.request_id as string | null;
      const epContext = ep.context ? JSON.parse(ep.context as string) : {};
      const epChannelRefs = (ep.channel_refs as string) || null;

      // Delete from local SQLite
      this.ctx.storage.sql.exec('DELETE FROM interactive_prompts WHERE id = ?', epId);

      if (epType === 'approval') {
        const toolId = epContext.toolId || '';

        // Update D1 status to expired (use invocationId from context, falls back to prompt ID)
        const invocationId = epContext.invocationId || epId;
        this.ctx.waitUntil(
          updateInvocationStatus(this.appDb, invocationId, {
            status: 'expired',
          }).catch((err) => console.error('[SessionAgentDO] Failed to mark invocation expired:', err))
        );

        // Send error to runner to unblock the pending request
        if (epRequestId) {
          this.runnerLink.send({ type: 'call-tool-result', requestId: epRequestId, error: `Action "${toolId}" approval expired after 10 minutes` } as any);
        } else {
          console.warn(`[SessionAgentDO] Approval prompt ${epId} expired with no request_id — runner may be stuck`);
        }

        this.emitAuditEvent('agent.tool_call', `Action ${toolId} approval expired`, undefined, { invocationId: epId });
      } else if (epType === 'question') {
        this.runnerLink.send({
          type: 'answer',
          questionId: epId,
          answer: '__expired__',
        });

        this.emitAuditEvent('agent.question', `Question ${epId} expired`, undefined, { questionId: epId });
      }

      // Broadcast expiry to clients
      this.broadcastToClients({
        type: 'interactive_prompt_expired',
        promptId: epId,
        promptType: epType,
        context: epContext,
      });

      // Update channel messages with expired status
      if (epChannelRefs) {
        this.ctx.waitUntil(
          this.updateChannelInteractivePrompts(epChannelRefs, { actionId: '__expired__', resolvedBy: 'system' })
        );
      }
    }

    // Metrics flush removed from alarm handler — flushed at lifecycle
    // boundaries only (stop, hibernate, prompt complete).

    // ─── Channel Follow-up Reminders ────────────────────────────────
    const dueFollowups = this.ctx.storage.sql
      .exec(
        "SELECT id, channel_type, channel_id, original_content, created_at, reminder_count FROM channel_followups WHERE status = 'pending' AND next_reminder_at <= ?",
        now
      )
      .toArray();

    for (const fu of dueFollowups) {
      const channelType = fu.channel_type as string;
      const channelId = fu.channel_id as string;
      const intervalMs = this.sessionState.channelFollowupIntervalMs;
      const lifecycleStatus = this.sessionState.status;

      // Avoid waking/restoring churn: only inject follow-up prompts while fully running.
      if (lifecycleStatus !== 'running') {
        this.ctx.storage.sql.exec(
          'UPDATE channel_followups SET next_reminder_at = ? WHERE id = ?',
          now + intervalMs,
          fu.id as string
        );
        continue;
      }

      // Web chat does not require channel_reply follow-ups.
      if (!channelType || channelType === 'web' || channelType === 'thread') {
        this.resolveChannelFollowups(channelType, channelId);
        continue;
      }

      const createdMs = fu.created_at as number;
      const elapsed = now - createdMs;
      const minutes = Math.floor(elapsed / 60_000);
      const timeAgo = minutes < 60 ? `${minutes}m` : `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
      const count = ((fu.reminder_count as number) || 0) + 1;

      if (count > MAX_CHANNEL_FOLLOWUP_REMINDERS) {
        this.ctx.storage.sql.exec(
          "UPDATE channel_followups SET status = 'resolved' WHERE id = ?",
          fu.id as string
        );
        this.emitAuditEvent(
          'channel.followup_resolved',
          `Stopped follow-up reminders for ${channelType}:${channelId} after ${MAX_CHANNEL_FOLLOWUP_REMINDERS} attempts`
        );
        continue;
      }

      const truncatedContent = ((fu.original_content as string) || '').slice(0, 200);

      const reminderContent = [
        `\u23F0 Reminder: You received a message via ${channelType} (chatId: ${channelId}) ${timeAgo} ago:`,
        `"${truncatedContent}"`,
        `You acknowledged it but haven't sent a substantive follow-up yet. If the work is done or has meaningful progress, use channel_reply to update the requester. If you need more time, that's fine \u2014 this reminder will repeat.`,
        `(Reminder #${count}, use channel_reply with follow_up=true to clear)`,
      ].join('\n');

      // Inject as a wake-able system message
      await this.handleSystemMessage(reminderContent, undefined, true);

      // Bump reminder count and schedule next reminder
      this.ctx.storage.sql.exec(
        'UPDATE channel_followups SET reminder_count = ?, next_reminder_at = ? WHERE id = ?',
        count, now + intervalMs, fu.id as string
      );
    }

    // ─── Conditional Re-arm ────────────────────────────────────────────
    const deadlines = this.collectAlarmDeadlines();
    const hasWork = deadlines.some(d => d !== null);
    const hasIdleDeadline =
      this.sessionState.status === 'running'
      && this.sessionState.idleTimeoutMs > 0
      && this.sessionState.lastUserActivityAt > 0;
    const hasConnections = this.runnerLink.isConnected || this.getClientSockets().length > 0;
    const hasPendingGrace = this.runnerDisconnectedAt !== null;

    if (hasWork || hasIdleDeadline || hasConnections || hasPendingGrace) {
      this.lifecycle.scheduleAlarm(deadlines);
    }
    // else: nothing to do — let Cloudflare evict this DO from memory
  }

  // ─── Client Message Handling ───────────────────────────────────────────

  private async handleClientMessage(ws: WebSocket, msg: ClientMessage) {
    switch (msg.type) {
      case 'prompt': {
        const { attachments, rejectedTypes } = sanitizePromptAttachments(msg.attachments);
        if (rejectedTypes.length > 0) {
          console.warn(`[SessionAgentDO] Client prompt: rejected file types: ${rejectedTypes.join(', ')}`);
          ws.send(JSON.stringify({
            type: 'error',
            message: `Unsupported file type: ${rejectedTypes.join(', ')}. I can handle ${SUPPORTED_FILE_TYPES_DESCRIPTION}.`,
          }));
        }
        if (!msg.content && attachments.length === 0) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing content or attachments' }));
          return;
        }
        // Extract userId from WebSocket tag for authorship tracking
        const clientTag = this.ctx.getTags(ws).find((t: string) => t.startsWith('client:'));
        const userId = clientTag?.replace('client:', '');
        const userDetails = userId ? this.userDetailsCache.get(userId) : undefined;
        const author = userDetails ? {
          id: userDetails.id,
          email: userDetails.email,
          name: userDetails.name,
          avatarUrl: userDetails.avatarUrl,
          gitName: userDetails.gitName,
          gitEmail: userDetails.gitEmail,
        } : userId ? { id: userId, email: '', name: undefined, avatarUrl: undefined, gitName: undefined, gitEmail: undefined } : undefined;
        // Route through queue mode (Phase D)
        const wsChannelType = (msg as any).channelType as string | undefined;
        const wsChannelId = (msg as any).channelId as string | undefined;
        const wsThreadId = msg.threadId;
        const wsContinuationContext = msg.continuationContext;
        const wsQueueMode = (msg as any).queueMode || this.promptQueue.queueMode || 'followup';
        switch (wsQueueMode) {
          case 'steer':
            await this.handleInterruptPrompt(msg.content || '', msg.model, author, attachments, wsChannelType, wsChannelId, wsThreadId);
            break;
          case 'collect':
            await this.handleCollectPrompt(msg.content || '', msg.model, author, attachments, wsChannelType, wsChannelId, wsThreadId);
            break;
          default:
            await this.handlePrompt(msg.content || '', msg.model, author, attachments, wsChannelType, wsChannelId, wsThreadId, wsContinuationContext);
            break;
        }
        break;
      }

      case 'answer':
        if (!msg.questionId || msg.answer === undefined) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing questionId or answer' }));
          return;
        }
        await this.handleAnswer(msg.questionId, msg.answer);
        break;

      case 'ping':
        ws.send(JSON.stringify({ type: 'pong' }));
        break;

      case 'abort':
        await this.handleAbort();
        break;

      case 'revert':
        if (!msg.messageId) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing messageId' }));
          return;
        }
        await this.handleRevert(msg.messageId);
        break;

      case 'diff':
        await this.handleDiff();
        break;

      case 'review': {
        const reviewRequestId = crypto.randomUUID();
        this.runnerLink.send({ type: 'review', requestId: reviewRequestId });
        break;
      }

      case 'approve-action': {
        if (!msg.invocationId) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing invocationId' }));
          return;
        }
        await this.handlePromptResolved(msg.invocationId, {
          actionId: 'approve',
          resolvedBy: this.sessionState.userId || 'user',
        });
        break;
      }

      case 'deny-action': {
        if (!msg.invocationId) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing invocationId' }));
          return;
        }
        await this.handlePromptResolved(msg.invocationId, {
          actionId: 'deny',
          value: msg.reason,
          resolvedBy: this.sessionState.userId || 'user',
        });
        break;
      }

      case 'command': {
        const { command: cmd, args: cmdArgs } = msg;
        if (!cmd) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing command name' }));
          return;
        }
        switch (cmd) {
          // OpenCode passthrough commands
          case 'undo':
          case 'redo':
          case 'compact':
            this.runnerLink.send({
              type: 'opencode-command',
              command: cmd,
              args: cmdArgs,
              requestId: crypto.randomUUID(),
            } as any);
            break;
          case 'new-session': {
            const channelType = msg.channelType || 'web';
            const channelId = msg.channelId || 'default';
            this.runnerLink.send({
              type: 'new-session',
              channelType,
              channelId,
              requestId: crypto.randomUUID(),
            } as any);
            break;
          }
          default:
            ws.send(JSON.stringify({ type: 'error', message: `Unknown command: ${cmd}` }));
        }
        break;
      }
    }
  }

  /**
   * Check if an inbound channel message should resolve a pending question
   * instead of being treated as a new prompt. Matches pending questions by
   * channel origin so only replies in the same channel/thread resolve the
   * question. Returns true if a question was resolved (caller should return
   * early and NOT process the message as a regular prompt).
   */
  private async tryResolveChannelQuestion(
    content: string,
    author: { id: string; email: string; name?: string; avatarUrl?: string; gitName?: string; gitEmail?: string } | undefined,
    channelType: string | undefined,
    channelId: string | undefined,
  ): Promise<boolean> {
    const sessionOwnerId = this.sessionState.userId;
    if (!channelType || channelType === 'web' || !author?.id || author.id !== sessionOwnerId) {
      return false;
    }

    const pendingQuestions = this.ctx.storage.sql
      .exec("SELECT id, context FROM interactive_prompts WHERE type = 'question' AND status = 'pending'")
      .toArray();

    const matchingPrompt = pendingQuestions.find((row) => {
      let context: Record<string, unknown> | null = null;
      if (typeof row.context === 'string' && row.context) {
        try {
          context = JSON.parse(row.context as string) as Record<string, unknown>;
        } catch {
          context = null;
        }
      }
      const originTarget = this.getPromptOriginTarget(context);
      return this.sameChannelTarget(originTarget, { channelType, channelId });
    });

    if (!matchingPrompt) return false;

    const promptId = matchingPrompt.id as string;
    await this.handlePromptResolved(promptId, {
      value: content || '',
      resolvedBy: author.id,
    });
    return true;
  }

  private async handlePrompt(
    content: string,
    model?: string,
    author?: { id: string; email: string; name?: string; avatarUrl?: string; gitName?: string; gitEmail?: string },
    attachments?: PromptAttachment[],
    channelType?: string,
    channelId?: string,
    threadId?: string,
    continuationContext?: string,
    contextPrefix?: string,
    replyTo?: { channelType: string; channelId: string },
  ) {
    // ─── Thread-reply capture for pending questions ─────────────────────
    // If there's a pending question and this message came from a channel
    // (not web UI) by the session owner, treat it as the answer.
    if (await this.tryResolveChannelQuestion(content, author, channelType, channelId)) {
      return;
    }

    // Preserve original channel info for reply tracking (e.g., slack:C123:thread_ts)
    // before normalizing to thread-based routing.
    const replyChannelType = channelType;
    const replyChannelId = channelId;

    // When a threadId is present, always route via the thread — regardless of
    // whether the message originated from Slack, the web UI, or any other channel.
    // This ensures all messages targeting the same orchestrator thread converge on
    // a single OpenCode session so the agent sees the full conversation.
    if (threadId) {
      this.sessionState.currentThreadId = threadId;
      channelType = 'thread';
      channelId = threadId;
    }
    const channelKey = this.channelKeyFrom(channelType, channelId);

    if (threadId) {
      const inMemoryThreadSessionId = this.getChannelOcSessionId(channelKey);
      if (!inMemoryThreadSessionId || !continuationContext) {
        const hydrated = await this.hydrateThreadResumeContext(threadId);
        if (!inMemoryThreadSessionId && hydrated.opencodeSessionId) {
          this.setChannelOcSessionId(channelKey, hydrated.opencodeSessionId);
        }
        if (!continuationContext && hydrated.continuationContext) {
          continuationContext = hydrated.continuationContext;
        }
      }
    }

    // Update idle tracking
    this.lifecycle.touchActivity();
    this.rescheduleIdleAlarm();

    // Track the current prompt author for PR attribution (Part 6)
    if (author?.id) {
      this.promptQueue.currentPromptAuthorId = author.id;
    }

    // If hibernated, auto-trigger wake before processing
    const currentStatus = this.sessionState.status;
    if (currentStatus === 'hibernated') {
      // Fire wake in background — prompt will be queued since runner won't be connected yet
      this.ctx.waitUntil(this.performWake());
    }
    // Note: if status is 'hibernating', the prompt will be queued below (runner
    // is disconnecting). performHibernate() checks the queue after completing
    // and auto-wakes if needed.

    const { attachments: normalizedAttachments } = sanitizePromptAttachments(attachments);
    const attachmentParts = attachmentPartsForMessage(normalizedAttachments);
    const serializedAttachmentParts = attachmentParts.length > 0 ? JSON.stringify(attachmentParts) : null;
    const serializedQueuedAttachments = normalizedAttachments.length > 0 ? JSON.stringify(normalizedAttachments) : null;

    // Store user message with author info and channel metadata
    const messageId = crypto.randomUUID();
    this.messageStore.writeMessage({
      id: messageId,
      role: 'user',
      content,
      parts: serializedAttachmentParts,
      author: author ? { id: author.id, email: author.email, name: author.name, avatarUrl: author.avatarUrl } : undefined,
      channelType,
      channelId,
      threadId,
    });

    // Increment thread message count for user message and notify UI of new thread
    if (threadId) {
      this.ctx.waitUntil(incrementThreadMessageCount(this.env.DB, threadId));
      // Broadcast thread.created so the UI updates the thread list in real-time.
      // Harmless if the thread already exists — the frontend just invalidates its cache.
      this.broadcastToClients({ type: 'thread.created', threadId });
    }

    // Broadcast user message to all clients (includes author info + channel metadata)
    this.broadcastToClients({
      type: 'message',
      data: {
        id: messageId,
        role: 'user',
        content,
        parts: attachmentParts.length > 0 ? attachmentParts : undefined,
        authorId: author?.id,
        authorEmail: author?.email,
        authorName: author?.name,
        authorAvatarUrl: author?.avatarUrl,
        channelType,
        channelId,
        threadId,
        createdAt: Math.floor(Date.now() / 1000),
      },
    });

    this.emitAuditEvent(
      'user.prompt',
      content
        ? content.slice(0, 120)
        : `[${normalizedAttachments.length} image attachment(s)]`,
      author?.id
    );

    // Check if runner is busy / ready
    const runnerBusy = this.promptQueue.runnerBusy;
    const runnerConnected = this.runnerLink.isConnected;
    const runnerReady = this.runnerLink.isReady;
    const status = this.sessionState.status;
    const sandboxId = this.sessionState.sandboxId;
    const queuedCount = this.promptQueue.length;

    // Resolve the effective reply target early so it can be persisted in prompt_queue.
    // Prefer explicit replyTo from the prompt envelope (set by plugin routes).
    // Fall back to the original channel before thread normalization (legacy path).
    // Thread origin recovery (web UI steering) happens at dispatch time, not here.
    const effectiveReplyTo = replyTo
      ?? (replyChannelType && replyChannelId && replyChannelType !== 'web' && replyChannelType !== 'thread'
        ? { channelType: replyChannelType, channelId: replyChannelId }
        : null);

    console.log(
      `[SessionAgentDO] handlePrompt: channel=${channelKey} runnerConnected=${runnerConnected} runnerReady=${runnerReady} runnerBusy=${runnerBusy} status=${status} sandboxId=${sandboxId || 'none'} queued=${queuedCount}`
    );

    if (!runnerConnected || !runnerReady) {
      // No runner connected or runner still initializing (OpenCode not healthy yet)
      // — queue the prompt with author info + channel metadata
      const reason = !runnerConnected ? 'no runner connected' : 'runner not ready';
      this.promptQueue.enqueue({
        id: messageId, content, attachments: serializedQueuedAttachments, model,
        authorId: author?.id, authorEmail: author?.email, authorName: author?.name, authorAvatarUrl: author?.avatarUrl,
        channelType, channelId, channelKey, threadId, continuationContext, contextPrefix,
        replyChannelType: effectiveReplyTo?.channelType, replyChannelId: effectiveReplyTo?.channelId,
      });
      this.promptQueue.stampPromptReceived();
      this.emitAuditEvent(
        'prompt.queued',
        `Queued: ${reason} (status=${status || 'unknown'}, sandbox=${sandboxId ? 'yes' : 'no'}, queued=${this.promptQueue.length})`,
        author?.id
      );
      // Runner not busy — arm idle-queue watchdog
      if (!runnerBusy && !this.promptQueue.idleQueuedSince) {
        this.promptQueue.idleQueuedSince = Date.now();
        this.rescheduleIdleAlarm();
      }
      this.broadcastToClients({
        type: 'status',
        data: { promptQueued: true, queuePosition: this.promptQueue.length, queueReason: 'waking' },
      });
      return;
    }

    if (runnerBusy) {
      // Runner is processing another prompt — queue with author info + channel metadata
      console.log(`[SessionAgentDO] handlePrompt: QUEUING (runnerBusy=true) channel=${channelKey} messageId=${messageId}`);
      this.promptQueue.enqueue({
        id: messageId, content, attachments: serializedQueuedAttachments, model,
        authorId: author?.id, authorEmail: author?.email, authorName: author?.name, authorAvatarUrl: author?.avatarUrl,
        channelType, channelId, channelKey, threadId, continuationContext, contextPrefix,
        replyChannelType: effectiveReplyTo?.channelType, replyChannelId: effectiveReplyTo?.channelId,
      });
      this.promptQueue.stampPromptReceived();
      this.emitAuditEvent(
        'prompt.queued',
        `Queued: runner busy (status=${status || 'unknown'}, sandbox=${sandboxId ? 'yes' : 'no'}, queued=${this.promptQueue.length})`,
        author?.id
      );
      this.broadcastToClients({
        type: 'status',
        data: { promptQueued: true, queuePosition: this.promptQueue.length, queueReason: 'busy' },
      });
      return;
    }

    console.log(`[SessionAgentDO] handlePrompt: DISPATCHING DIRECTLY channel=${channelKey} messageId=${messageId}`);
    this.promptQueue.stampPromptReceived();
    // Insert into prompt_queue as 'processing' so it can be recovered if the runner disconnects
    this.promptQueue.enqueue({
      id: messageId, content, attachments: serializedQueuedAttachments, model, status: 'processing',
      authorId: author?.id, authorEmail: author?.email, authorName: author?.name, authorAvatarUrl: author?.avatarUrl,
      channelType, channelId, channelKey, threadId, continuationContext, contextPrefix,
      replyChannelType: effectiveReplyTo?.channelType, replyChannelId: effectiveReplyTo?.channelId,
    });

    // Forward directly to runner with author info + channel metadata
    this.promptQueue.stampDispatched();
    this.promptQueue.idleQueuedSince = 0;
    this.sessionState.lastParentIdleNotice = undefined;
    this.sessionState.parentIdleNotifyAt = 0;
    this.sessionState.waitSubscription = null;
    this.rescheduleIdleAlarm();
    console.log('[SessionAgentDO] handlePrompt: dispatching to runner (DO_CODE_VERSION=v2-pipeline-2)');

    // Active channel is scoped to the current prompt cycle only.
    this.channelRouter.clearActiveChannel();
    if (effectiveReplyTo) {
      this.channelRouter.setActiveChannel(effectiveReplyTo);
      this.insertChannelFollowup(effectiveReplyTo.channelType, effectiveReplyTo.channelId, content);
    } else if (threadId) {
      // Web UI steering of a thread — recover the thread's origin channel so
      // downstream code knows where to route follow-up channel actions.
      const origin = await getThreadOriginChannel(this.env.DB, threadId);
      if (origin && origin.channelType !== 'web' && origin.channelType !== 'thread') {
        this.channelRouter.setActiveChannel({ channelType: origin.channelType, channelId: origin.channelId });
        this.insertChannelFollowup(origin.channelType, origin.channelId, content);
      }
    }

    // Resolve model preferences: user prefs > org prefs fallback
    const ownerId = this.sessionState.userId;
    const ownerDetails = ownerId ? await this.getUserDetails(ownerId) : undefined;
    const resolvedModelPrefs = await this.resolveModelPreferences(ownerDetails);
    // Agent sees contextPrefix + content; stored messages/queue only have the user's actual message
    const agentContent = contextPrefix
      ? `${contextPrefix}\n\n${content}`
      : content;

    const channelOcSessionId = this.getChannelOcSessionId(channelKey);
    const dispatched = this.runnerLink.send({
      type: 'prompt',
      messageId,
      content: agentContent,
      model,
      attachments: normalizedAttachments.length > 0 ? normalizedAttachments : undefined,
      channelType,
      channelId,
      threadId,
      // Pass original channel info so the Runner can build the [via ...] prefix
      // even when channelType has been rewritten to 'thread'.
      replyChannelType: replyChannelType !== channelType ? replyChannelType : undefined,
      replyChannelId: replyChannelId !== channelId ? replyChannelId : undefined,
      authorId: author?.id,
      authorEmail: author?.email,
      authorName: author?.name,
      gitName: author?.gitName,
      gitEmail: author?.gitEmail,
      opencodeSessionId: channelOcSessionId,
      modelPreferences: resolvedModelPrefs,
      continuationContext,
    });
    if (!dispatched) {
      // Runner disappeared between the check and send — revert to queued for recovery
      this.promptQueue.revertProcessingToQueued(messageId);
      this.promptQueue.runnerBusy = false;
      if (!this.promptQueue.idleQueuedSince) {
        this.promptQueue.idleQueuedSince = Date.now();
        this.rescheduleIdleAlarm();
      }
      this.channelRouter.clearActiveChannel();
      this.emitAuditEvent('prompt.dispatch_failed', `Dispatch failed, reverted to queue: ${messageId}`);
    }
  }

  private async handleAnswer(questionId: string, answer: string | boolean) {
    await this.handlePromptResolved(questionId, {
      value: String(answer),
      resolvedBy: this.sessionState.userId || 'user',
    });
  }

  private async handleAbort(channelType?: string, channelId?: string) {
    if (channelType && channelId) {
      // Channel-scoped abort — only clear this channel's queued prompts
      const channelKey = this.channelKeyFrom(channelType, channelId);
      this.promptQueue.clearQueued(channelKey);
      this.runnerLink.send({ type: 'abort', channelType, channelId });
    } else {
      // Global abort — clear all queued prompts
      this.promptQueue.clearQueued();
      this.runnerLink.send({ type: 'abort' });
    }

    // Broadcast status immediately (runner will confirm with 'aborted')
    this.broadcastToClients({
      type: 'agentStatus',
      status: 'idle',
    });

    // Clear promptReceivedAt so stale timestamps don't inflate turn_complete durations
    this.promptQueue.clearPromptReceived();

    this.emitAuditEvent('user.abort', `User aborted agent${channelType ? ` (channel: ${channelType}:${channelId})` : ''}`);
  }

  private async handleInterruptPrompt(
    content: string,
    model?: string,
    author?: { id: string; email: string; name?: string; avatarUrl?: string; gitName?: string; gitEmail?: string },
    attachments?: PromptAttachment[],
    channelType?: string,
    channelId?: string,
    threadId?: string,
    contextPrefix?: string,
  ) {
    // ─── Pending question check (before abort) ─────────────────────────
    // If the agent is waiting on a question and the user replies in the same
    // channel, resolve the question instead of aborting. Without this, the
    // abort kills the OpenCode session before the answer can reach it.
    if (await this.tryResolveChannelQuestion(content, author, channelType, channelId)) {
      return;
    }

    // Normalize threadId to channel routing for abort targeting
    const abortChannelType = threadId ? 'thread' : channelType;
    const abortChannelId = threadId ? threadId : channelId;

    const runnerBusy = this.promptQueue.runnerBusy;
    if (runnerBusy) {
      // Abort current work (channel-scoped if channel info provided)
      await this.handleAbort(abortChannelType, abortChannelId);
    }
    // Queue the new prompt — when the runner confirms abort, handlePromptComplete
    // will drain the queue and send this prompt to the runner
    await this.handlePrompt(content, model, author, attachments, channelType, channelId, threadId, undefined, contextPrefix);
  }

  // ─── Collect Mode (Phase D) ──────────────────────────────────────────

  private async handleCollectPrompt(
    content: string,
    model?: string,
    author?: { id: string; email: string; name?: string; avatarUrl?: string; gitName?: string; gitEmail?: string },
    attachments?: PromptAttachment[],
    channelType?: string,
    channelId?: string,
    threadId?: string,
    contextPrefix?: string,
  ) {
    // ─── Pending question check (before buffering) ─────────────────────
    // If the agent is waiting on a question and the user replies in the same
    // channel, resolve the question instead of buffering. Without this, the
    // reply gets collected and the question times out after 5 minutes.
    if (await this.tryResolveChannelQuestion(content, author, channelType, channelId)) {
      return;
    }

    // Update idle tracking
    this.lifecycle.touchActivity();
    this.rescheduleIdleAlarm();

    const { attachments: normalizedAttachments, rejectedTypes } = sanitizePromptAttachments(attachments);
    if (rejectedTypes.length > 0) {
      console.warn(`[SessionAgentDO] Channel prompt: rejected file types: ${rejectedTypes.join(', ')}`);
    }
    const attachmentParts = attachmentPartsForMessage(normalizedAttachments);
    const serializedAttachmentParts = attachmentParts.length > 0 ? JSON.stringify(attachmentParts) : null;

    // Store user message immediately for display (including channel metadata)
    const messageId = crypto.randomUUID();
    this.messageStore.writeMessage({
      id: messageId,
      role: 'user',
      content,
      parts: serializedAttachmentParts,
      author: author ? { id: author.id, email: author.email, name: author.name, avatarUrl: author.avatarUrl } : undefined,
      channelType,
      channelId,
      threadId,
    });

    // Broadcast user message to clients (including channel metadata)
    this.broadcastToClients({
      type: 'message',
      data: {
        id: messageId,
        role: 'user',
        content,
        parts: attachmentParts.length > 0 ? attachmentParts : undefined,
        authorId: author?.id,
        authorEmail: author?.email,
        authorName: author?.name,
        authorAvatarUrl: author?.avatarUrl,
        channelType,
        channelId,
        threadId,
        createdAt: Math.floor(Date.now() / 1000),
      },
    });

    // Append to collect buffer (stored as JSON in state table, keyed by channel)
    const collectChannelKey = this.channelKeyFrom(channelType, channelId);
    const bufferLength = this.promptQueue.appendToCollectBuffer(collectChannelKey, {
      content, model, author,
      attachments: normalizedAttachments.length > 0 ? normalizedAttachments : undefined,
      channelType, channelId, threadId, contextPrefix,
    });

    // Schedule alarm for collect flush (uses min of flush and existing idle alarm)
    const flushAt = Date.now() + this.promptQueue.collectDebounceMs;
    this.rescheduleCollectAlarm(flushAt);

    // Broadcast collect status
    this.broadcastToClients({
      type: 'status',
      data: { collectPending: true, collectCount: bufferLength },
    });
  }

  private rescheduleCollectAlarm(flushAt: number): void {
    this.lifecycle.scheduleAlarm([...this.collectAlarmDeadlines(), flushAt]);
  }

  private async flushCollectBuffer(): Promise<void> {
    const flushes = this.promptQueue.getReadyCollectFlushes();

    for (const { buffer } of flushes) {
      // Merge messages
      const mergedContent = buffer.map((b) => b.content).join('\n\n---\n\n');
      const lastEntry = buffer[buffer.length - 1];
      const allAttachments = buffer.flatMap((b) => b.attachments || []);
      const mergedContextPrefix = buffer.find((b) => b.contextPrefix)?.contextPrefix;

      await this.handlePrompt(
        mergedContent, lastEntry.model, lastEntry.author as any, allAttachments as PromptAttachment[],
        lastEntry.channelType, lastEntry.channelId, lastEntry.threadId,
        undefined, mergedContextPrefix,
      );
    }

    if (flushes.length > 0) {
      this.broadcastToClients({
        type: 'status',
        data: { collectPending: false, collectCount: 0 },
      });
    }

    // Reschedule idle alarm (since we consumed the collect alarm slot)
    this.rescheduleIdleAlarm();
  }

  private async handleRevert(messageId: string) {
    const removedIds = this.messageStore.deleteMessagesFrom(messageId);
    if (removedIds.length === 0) return;

    // Forward to runner so OpenCode can revert too
    this.runnerLink.send({ type: 'revert', messageId });

    // Broadcast removal to all clients
    this.broadcastToClients({
      type: 'messages.removed',
      messageIds: removedIds,
    });
  }

  private async handleDiff() {
    const requestId = crypto.randomUUID();
    this.runnerLink.send({ type: 'diff', requestId });
  }

  // ─── Runner Message Handlers ──────────────────────────────────────────
  // Handler map for incoming runner messages. Each key corresponds to a
  // RunnerToDOMessage.type, each value is an (async) handler function.
  // RunnerLink dispatches to these via runnerLink.handleMessage().

  private _runnerHandlers?: RunnerMessageHandlers;
  private get runnerHandlers(): RunnerMessageHandlers {
    if (!this._runnerHandlers) {
      this._runnerHandlers = this.buildRunnerHandlers();
    }
    return this._runnerHandlers;
  }

  private buildRunnerHandlers(): RunnerMessageHandlers {
    return {
      'usage-report': (msg) => {
        const entries = msg.entries;
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            this.emitEvent('llm_call', {
              turnId: msg.turnId,
              model: entry.model ?? 'unknown',
              inputTokens: entry.inputTokens ?? 0,
              outputTokens: entry.outputTokens ?? 0,
              properties: { oc_message_id: entry.ocMessageId },
            });
          }
        }
      },

      'tunnels': (msg) => {
        if (Array.isArray(msg.tunnels)) {
          this.sessionState.tunnels = msg.tunnels;
        } else {
          this.sessionState.tunnels = [];
        }
      },

      'workflow-chat-message': (msg) => {
        const ALLOWED_ROLES = new Set(['user', 'assistant', 'system']);
        const rawRole = typeof msg.role === 'string' ? msg.role : 'user';
        const role = (ALLOWED_ROLES.has(rawRole) ? rawRole : 'user') as 'user' | 'assistant' | 'system';
        const content = (msg.content || '').trim();
        if (!content) return;

        const workflowMsgId = crypto.randomUUID();
        const partsObj = msg.parts && typeof msg.parts === 'object' ? msg.parts as Record<string, unknown> : null;
        const partsJson = partsObj ? JSON.stringify(partsObj) : null;
        const workflowChannelType = typeof msg.channelType === 'string'
          ? msg.channelType
          : (partsObj && typeof partsObj.channelType === 'string' ? partsObj.channelType : null);
        const workflowChannelId = typeof msg.channelId === 'string'
          ? msg.channelId
          : (partsObj && typeof partsObj.channelId === 'string' ? partsObj.channelId : null);
        const workflowOcSessionId = typeof msg.opencodeSessionId === 'string'
          ? msg.opencodeSessionId
          : (partsObj && typeof partsObj.opencodeSessionId === 'string' ? partsObj.opencodeSessionId : null);
        this.messageStore.writeMessage({
          id: workflowMsgId,
          role,
          content,
          parts: partsJson,
          channelType: workflowChannelType,
          channelId: workflowChannelId,
          opencodeSessionId: workflowOcSessionId,
        });
        this.broadcastToClients({
          type: 'message',
          data: {
            id: workflowMsgId,
            role,
            content,
            ...(partsJson ? { parts: JSON.parse(partsJson) } : {}),
            ...(workflowChannelType && workflowChannelId ? { channelType: workflowChannelType, channelId: workflowChannelId } : {}),
            createdAt: Math.floor(Date.now() / 1000),
          },
        });
      },

      'question': async (msg) => {
        // Store question as interactive prompt and broadcast to all clients
        const qId = msg.questionId || crypto.randomUUID();
        const questionCh = this.activeChannel;
        const QUESTION_TIMEOUT_SECS = 5 * 60; // 5 minutes
        const expiresAt = Math.floor(Date.now() / 1000) + QUESTION_TIMEOUT_SECS;
        const sessionId = this.sessionState.sessionId;

        const actions: InteractiveAction[] = msg.options
          ? msg.options.map((opt, i) => ({ id: `option_${i}`, label: opt }))
          : [];

        const context: Record<string, unknown> = msg.options ? { options: msg.options } : {};
        if (questionCh) {
          context.channelType = questionCh.channelType;
          context.channelId = questionCh.channelId;
        }

        this.ctx.storage.sql.exec(
          `INSERT INTO interactive_prompts (id, type, request_id, title, actions, context, status, expires_at)
           VALUES (?, 'question', ?, ?, ?, ?, 'pending', ?)`,
          qId,
          null,
          msg.text || '',
          JSON.stringify(actions),
          JSON.stringify(context),
          expiresAt,
        );

        const prompt: InteractivePrompt = {
          id: qId,
          sessionId,
          type: 'question',
          title: msg.text || '',
          actions,
          expiresAt: expiresAt * 1000,
          context,
        };

        this.broadcastToClients({
          type: 'interactive_prompt',
          prompt,
          ...(questionCh ? { channelType: questionCh.channelType, channelId: questionCh.channelId } : {}),
        });

        // Schedule an alarm to expire the question if unanswered
        this.ctx.storage.setAlarm(Date.now() + QUESTION_TIMEOUT_SECS * 1000);

        // Send channel interactive prompts
        this.ctx.waitUntil(
          this.sendChannelInteractivePrompts(qId, prompt)
        );

        // Notify EventBus
        this.notifyEventBus({
          type: 'question.asked',
          sessionId,
          data: { questionId: qId, text: msg.text || '' },
          timestamp: new Date().toISOString(),
        });
        const ownerUserId = this.sessionState.userId || undefined;
        const questionSummary = msg.text?.trim()
          ? `Agent question: ${msg.text.trim()}`
          : 'Agent requested a decision.';
        if (ownerUserId && this.isUserConnected(ownerUserId)) {
          this.sendToastToUser(ownerUserId, {
            title: 'Agent question',
            description: questionSummary.slice(0, 240),
            variant: 'warning',
          });
        } else {
          await this.enqueueOwnerNotification({
            messageType: 'question',
            content: questionSummary,
            contextSessionId: sessionId || undefined,
          });
        }
      },

      'screenshot': (msg) => {
        // Store screenshot reference and broadcast
        const ssId = crypto.randomUUID();
        const ssCh = this.activeChannel;
        this.messageStore.writeMessage({
          id: ssId,
          role: 'system',
          content: msg.description || 'Screenshot',
          parts: JSON.stringify({ type: 'screenshot', data: msg.data }),
          channelType: ssCh?.channelType,
          channelId: ssCh?.channelId,
        });
        this.broadcastToClients({
          type: 'message',
          data: {
            id: ssId,
            role: 'system',
            content: msg.description || 'Screenshot',
            parts: { type: 'screenshot', data: msg.data },
            createdAt: Math.floor(Date.now() / 1000),
            ...(ssCh ? { channelType: ssCh.channelType, channelId: ssCh.channelId } : {}),
          },
        });
      },

      'audio-transcript': (msg) => {
        // Runner transcribed audio attachments — update the original user message parts with transcript
        if (msg.messageId && msg.transcript) {
          const existing = this.messageStore.getMessage(msg.messageId);
          if (existing && existing.parts) {
            let parts: Array<Record<string, unknown>> = [];
            try {
              const parsed = JSON.parse(existing.parts);
              parts = Array.isArray(parsed) ? parsed : [parsed];
            } catch { /* ignore */ }
            // Add transcript to each audio part
            for (const part of parts) {
              if (part.type === 'audio') {
                part.transcript = msg.transcript;
              }
            }
            this.messageStore.updateMessageParts(msg.messageId, JSON.stringify(parts));
            // Broadcast updated message to all clients
            this.broadcastToClients({
              type: 'message.updated',
              data: { id: msg.messageId, parts },
            });
          }
        }
      },

      'error': async (msg) => {
        // Store error and broadcast
        // Always generate a new ID — msg.messageId is the prompt's user message ID,
        // which already exists in the messages table (PRIMARY KEY conflict).
        const errId = crypto.randomUUID();
        const errCh = this.activeChannel;
        const errorText = msg.error || 'Unknown error';
        this.messageStore.writeMessage({
          id: errId,
          role: 'system',
          content: `Error: ${errorText}`,
          channelType: errCh?.channelType,
          channelId: errCh?.channelId,
        });
        this.broadcastToClients({
          type: 'error',
          messageId: errId,
          error: msg.error,
          ...(errCh ? { channelType: errCh.channelType, channelId: errCh.channelId } : {}),
        });
        this.emitEvent('turn_error', {
          errorCode: 'agent_error',
          properties: { message: errorText.slice(0, 200) },
        });
        this.emitAuditEvent('agent.error', errorText.slice(0, 120));

        // Safety-net: if runner doesn't send 'complete' within 60s, force flush
        const ERROR_SAFETY_NET_MS = 60_000;
        this.promptQueue.errorSafetyNetAt = Date.now() + ERROR_SAFETY_NET_MS;
        this.rescheduleIdleAlarm();

        // Publish session.errored to EventBus
        this.notifyEventBus({
          type: 'session.errored',
          sessionId: this.sessionState.sessionId || undefined,
          userId: this.sessionState.userId || undefined,
          data: { error: errorText, messageId: errId },
          timestamp: new Date().toISOString(),
        });
        await this.enqueueOwnerNotification({
          messageType: 'escalation',
          content: `Session error: ${errorText}`,
          contextSessionId: this.sessionState.sessionId || undefined,
        });
      },

      // ─── V2 Parts-Based Message Protocol ──────────────────────────────
      'message.create': (msg) => {
        const turnId = msg.turnId!;
        // Resolve threadId: prefer Runner-provided value, fall back to the currently-processing prompt's threadId
        let resolvedThreadId = msg.threadId || undefined;
        if (!resolvedThreadId) {
          resolvedThreadId = this.promptQueue.getProcessingThreadId() || undefined;
        }
        if (!resolvedThreadId) {
          resolvedThreadId = this.sessionState.currentThreadId;
        }
        console.log(`[SessionAgentDO] V2 message.create: turnId=${turnId} threadId=${resolvedThreadId || 'none'}`);
        this.messageStore.createTurn(turnId, {
          channelType: msg.channelType || undefined,
          channelId: msg.channelId || undefined,
          opencodeSessionId: msg.opencodeSessionId || undefined,
          threadId: resolvedThreadId,
        });
        // Broadcast message creation to clients
        this.broadcastToClients({
          type: 'message',
          data: {
            id: turnId,
            role: 'assistant',
            content: '',
            parts: [],
            createdAt: Math.floor(Date.now() / 1000),
            ...(msg.channelType ? { channelType: msg.channelType } : {}),
            ...(msg.channelId ? { channelId: msg.channelId } : {}),
            ...(resolvedThreadId ? { threadId: resolvedThreadId } : {}),
          },
        });
      },

      'message.part.text-delta': (msg) => {
        if (!this.messageStore.getTurnSnapshot(msg.turnId!)) {
          if (!this.messageStore.recoverTurn(msg.turnId!)) {
            console.warn(`[SessionAgentDO] text-delta for unknown turn ${msg.turnId}`);
            return;
          }
        }
        this.messageStore.appendTextDelta(msg.turnId!, msg.delta || '');
        const turn = this.messageStore.getTurnSnapshot(msg.turnId!)!;
        // Broadcast chunk with messageId so client knows which v2 message to update
        this.broadcastToClients({
          type: 'chunk',
          content: msg.delta || '',
          messageId: msg.turnId,
          ...(turn.metadata.channelType ? { channelType: turn.metadata.channelType, channelId: turn.metadata.channelId } : {}),
        });
      },

      'message.part.tool-update': (msg) => {
        if (!this.messageStore.getTurnSnapshot(msg.turnId!)) {
          if (!this.messageStore.recoverTurn(msg.turnId!)) {
            console.warn(`[SessionAgentDO] tool-update for unknown turn ${msg.turnId}`);
            return;
          }
        }
        this.messageStore.updateToolCall(msg.turnId!, msg.callId!, msg.toolName!, msg.status!, msg.args, msg.result, msg.error);
        this.scheduleDebouncedFlush();
        const snapshot = this.messageStore.getTurnSnapshot(msg.turnId!)!;
        // Broadcast the full updated message to clients
        this.broadcastToClients({
          type: 'message.updated',
          data: {
            id: msg.turnId,
            role: 'assistant',
            content: snapshot.content,
            parts: snapshot.parts,
            ...(snapshot.metadata.channelType ? { channelType: snapshot.metadata.channelType, channelId: snapshot.metadata.channelId } : {}),
            ...(snapshot.metadata.threadId ? { threadId: snapshot.metadata.threadId } : {}),
          },
        });
      },

      'message.finalize': (msg) => {
        const turnId = msg.turnId!;
        if (!this.messageStore.getTurnSnapshot(turnId)) {
          if (!this.messageStore.recoverTurn(turnId)) {
            console.warn(`[SessionAgentDO] finalize for unknown turn ${turnId}`);
            return;
          }
        }
        const final = this.messageStore.finalizeTurn(turnId, msg.finalText, msg.reason, msg.error);
        if (!final) return;
        // Broadcast final message state
        this.broadcastToClients({
          type: 'message.updated',
          data: {
            id: turnId,
            role: 'assistant',
            content: final.content,
            parts: final.parts,
            ...(final.metadata.channelType ? { channelType: final.metadata.channelType, channelId: final.metadata.channelId } : {}),
            ...(final.metadata.threadId ? { threadId: final.metadata.threadId } : {}),
          },
        });
        // Increment thread message count for assistant message
        if (final.metadata.threadId) {
          this.ctx.waitUntil(incrementThreadMessageCount(this.env.DB, final.metadata.threadId));
        }
        console.log(`[SessionAgentDO] V2 turn finalized: ${turnId} (${final.content.length} chars, ${final.parts.length} parts)`);
      },

      'complete': async (msg) => {
        console.log(`[SessionAgentDO] Complete received: queueLength=${this.promptQueue.length} runnerBusy=${this.promptQueue.runnerBusy}`);
        await this.handlePromptComplete();
        this.ctx.waitUntil(this.flushMetrics());
      },

      'agentStatus': async (msg) => {
        // Forward agent status to all clients for real-time activity indication
        const statusCh = this.activeChannel;
        this.broadcastToClients({
          type: 'agentStatus',
          status: msg.status,
          detail: msg.detail,
          ...(statusCh ? { channelType: statusCh.channelType, channelId: statusCh.channelId } : {}),
        });
        if (msg.status === 'idle') {
          // If runner was initializing (not yet ready), mark it ready now.
          // This is the signal that OpenCode is healthy and models are discovered.
          const wasInitializing = !this.runnerLink.isReady;
          if (wasInitializing) {
            this.runnerLink.ready = true;
            console.log('[SessionAgentDO] Runner is now ready (first idle after connect)');

            // Emit runner_idle — full time from sandbox spawn/restore to agent ready
            const wakeStart = this.sessionState.sandboxWakeStartedAt;
            if (wakeStart > 0) {
              this.emitEvent('runner_idle', { durationMs: Date.now() - wakeStart });
              this.sessionState.sandboxWakeStartedAt = 0;
            }
          }

          const currentRunnerBusy = this.promptQueue.runnerBusy;
          const currentQueueLen = this.promptQueue.length;
          console.log(`[SessionAgentDO] agentStatus: idle (runnerBusy=${currentRunnerBusy}, runnerConnected=${this.runnerLink.isConnected}, queued=${currentQueueLen})`);

          // When runner is truly idle (not processing a prompt), check for deferred work.
          // This handles the post-restore case: runner connects, initializes, then signals
          // idle — at which point we drain queued prompts or fire the initial prompt.
          if (!currentRunnerBusy && currentQueueLen > 0) {
            console.log(`[SessionAgentDO] agentStatus idle: draining deferred queue (${currentQueueLen} items)`);
            try {
              if (await this.sendNextQueuedPrompt()) {
                console.log('[SessionAgentDO] agentStatus idle: dispatched queued work item');
              }
            } catch (drainErr) {
              // Revert stuck processing items so the watchdog or next idle signal can retry
              console.error('[SessionAgentDO] agentStatus idle: queue drain failed, reverting processing→queued:', drainErr);
              this.promptQueue.revertProcessingToQueued();
              this.promptQueue.runnerBusy = false;
            }
          } else if (!currentRunnerBusy) {
            // Check for initial prompt (from create-from-PR/Issue) — only if no queued work
            const initialPrompt = this.sessionState.initialPrompt;
            if (initialPrompt) {
              this.sessionState.initialPrompt = undefined;
              const messageId = crypto.randomUUID();
              this.messageStore.writeMessage({
                id: messageId,
                role: 'user',
                content: initialPrompt,
              });
              this.broadcastToClients({
                type: 'message',
                data: {
                  id: messageId,
                  role: 'user',
                  content: initialPrompt,
                  createdAt: Math.floor(Date.now() / 1000),
                },
              });
              this.promptQueue.enqueue({ id: messageId, content: initialPrompt, status: 'processing' });
              const ipOwnerId = this.sessionState.userId;
              const ipOwnerDetails = ipOwnerId ? await this.getUserDetails(ipOwnerId) : undefined;
              const ipModelPrefs = await this.resolveModelPreferences(ipOwnerDetails);
              const initialModel = this.sessionState.initialModel;
              if (initialModel) {
                this.sessionState.initialModel = undefined;
              }
              this.runnerLink.send({
                type: 'prompt',
                messageId,
                content: initialPrompt,
                model: initialModel || undefined,
                opencodeSessionId: this.getChannelOcSessionId(this.channelKeyFrom(undefined, undefined)),
                modelPreferences: ipModelPrefs,
              });
              this.promptQueue.stampDispatched();
              console.log(`[SessionAgentDO] agentStatus idle: dispatched initial prompt ${messageId}`);
            }
          }

          // Don't set runnerBusy=false here — wait for the authoritative `complete`
          // message. Setting it here creates a window where a new prompt can bypass
          // the queue and be dispatched directly, resulting in two concurrent prompts.
          // The `complete` handler (handlePromptComplete) is the single source of truth.
          this.notifyParentIfIdle();
        } else if (msg.status === 'thinking' || msg.status === 'tool_calling' || msg.status === 'streaming') {
          this.promptQueue.runnerBusy = true;
          this.sessionState.lastParentIdleNotice = undefined;
          this.sessionState.parentIdleNotifyAt = 0;
        }
      },

      'models': (msg) => {
        // Runner discovered available models — store for internal use (failover, context limits)
        // but do NOT broadcast to clients. The UI uses the Worker-resolved catalog from init.
        if (msg.models) {
          this.sessionState.availableModels = msg.models;
          const modelsJson = JSON.stringify(msg.models);
          // Persist to D1 so the settings typeahead works without a running session
          const userId = this.sessionState.userId;
          if (userId) {
            updateUserDiscoveredModels(this.appDb, userId, modelsJson)
              .catch((err: unknown) => console.error('[SessionAgentDO] Failed to cache models to D1:', err));
          }
          // Cache at org level so resolveAvailableModels() can filter models.dev against real models
          setCatalogCache(this.appDb, 'runner:discovered', modelsJson)
            .catch((err: unknown) => console.error('[SessionAgentDO] Failed to cache org-level discovered models:', err));
        }
      },

      'model-switched': (msg) => {
        // Runner switched models due to provider error — store notice and broadcast
        const switchId = crypto.randomUUID();
        const switchText = `Model switched from ${msg.fromModel} to ${msg.toModel}: ${msg.reason}`;
        this.messageStore.writeMessage({
          id: switchId,
          role: 'system',
          content: switchText,
        });
        this.broadcastToClients({
          type: 'model-switched',
          messageId: switchId,
          fromModel: msg.fromModel,
          toModel: msg.toModel,
          reason: msg.reason,
        });
        this.emitAuditEvent('agent.error', switchText.slice(0, 120));
      },

      'wait-subscription': async (msg) => {
        // Agent called wait_for_event — record what events should wake it.
        // Cleared when the next prompt is dispatched.
        this.sessionState.waitSubscription = {
          reason: msg.reason || undefined,
          sessionIds: msg.sessionIds || undefined,
          notifyOn: msg.notifyOn || undefined,
          statuses: msg.statuses || undefined,
        };
        console.log(`[SessionAgentDO] Wait subscription registered: notifyOn=${msg.notifyOn || 'terminal'}, sessions=${msg.sessionIds?.join(',') || 'all'}`);
      },

      'aborted': async (_msg) => {
        // Runner confirmed abort — let handlePromptComplete clear runnerBusy
        // and broadcast status. Don't clear runnerBusy early — that creates a
        // race where a rapid new prompt can be dispatched then immediately
        // completed by markCompleted().
        this.broadcastToClients({
          type: 'agentStatus',
          status: 'idle',
        });
        await this.handlePromptComplete();
      },

      'reverted': (msg) => {
        // Runner confirmed revert — log for now
        console.log(`[SessionAgentDO] Revert confirmed for messages: ${msg.messageIds?.join(', ')}`);
      },

      'diff': (msg) => {
        // Runner returned diff data — broadcast to clients
        this.broadcastToClients({
          type: 'diff',
          requestId: msg.requestId,
          data: msg.data,
        });
      },

      'review-result': (msg) => {
        // Runner returned structured review result — broadcast to clients (not stored in DB)
        this.broadcastToClients({
          type: 'review-result',
          requestId: msg.requestId,
          data: msg.data,
          diffFiles: msg.diffFiles,
          error: msg.error,
        });
      },

      'command-result': (msg) => {
        // Runner returned OpenCode command result — broadcast to clients
        this.broadcastToClients({
          type: 'command-result',
          requestId: msg.requestId,
          command: msg.command,
          result: msg.result,
          error: msg.error,
        });
      },

      'git-state': (msg) => {
        // Runner reports current git branch/commit state
        const sessionId = this.sessionState.sessionId;
        if (sessionId) {
          const gitUpdates: Record<string, string | number> = {};
          if (msg.branch !== undefined) gitUpdates.branch = msg.branch;
          if (msg.baseBranch !== undefined) gitUpdates.baseBranch = msg.baseBranch;
          if (msg.commitCount !== undefined) gitUpdates.commitCount = msg.commitCount;

          if (Object.keys(gitUpdates).length > 0) {
            updateSessionGitState(this.appDb, sessionId, gitUpdates as any).catch((err) =>
              console.error('[SessionAgentDO] Failed to update git state in D1:', err),
            );
          }
        }
        this.broadcastToClients({
          type: 'git-state',
          data: {
            branch: msg.branch,
            baseBranch: msg.baseBranch,
            commitCount: msg.commitCount,
          },
        } as any);
      },

      'files-changed': (msg) => {
        // Runner reports files changed — upsert in D1, broadcast to clients
        const sessionIdFc = this.sessionState.sessionId;
        if (sessionIdFc && Array.isArray(msg.files)) {
          for (const file of msg.files) {
            upsertSessionFileChanged(this.appDb, sessionIdFc, {
              filePath: file.path,
              status: file.status,
              additions: file.additions,
              deletions: file.deletions,
            }).catch((err) =>
              console.error('[SessionAgentDO] Failed to upsert file changed:', err),
            );
          }
        }
        this.broadcastToClients({
          type: 'files-changed',
          files: msg.files,
        } as any);
      },

      'child-session': (msg) => {
        // Runner reports a child/sub-agent session was spawned
        this.broadcastToClients({
          type: 'child-session',
          childSessionId: (msg as any).childSessionId,
          title: msg.title,
        } as any);
      },

      'title': (msg) => {
        // Runner reports session title update
        const sessionIdTitle = this.sessionState.sessionId;
        const newTitle = msg.title;
        if (sessionIdTitle && newTitle) {
          this.sessionState.title = newTitle;
          updateSessionTitle(this.appDb, sessionIdTitle, newTitle).catch((err) =>
            console.error('[SessionAgentDO] Failed to update session title:', err),
          );
        }
        this.broadcastToClients({
          type: 'title',
          title: newTitle,
        } as any);
      },

      'spawn-child': async (msg) => {
        const requestId = msg.requestId!;
        const spawnRequest = this.sessionState.spawnRequest;
        const backendUrl = this.sessionState.backendUrl;

        if (!spawnRequest || !backendUrl) {
          this.runnerLink.send({ type: 'spawn-child-result', requestId, error: 'Session not configured for spawning children (missing spawnRequest or backendUrl)' });
          return;
        }

        try {
          const result = await spawnChild(
            this.appDb,
            this.env,
            {
              parentSessionId: this.sessionState.sessionId,
              userId: this.sessionState.userId,
              parentThreadId: this.promptQueue.getProcessingThreadId() || undefined,
              spawnRequest: spawnRequest as Record<string, unknown> & { doWsUrl: string; envVars: Record<string, string> },
              backendUrl,
              terminateUrl: this.sessionState.terminateUrl,
              hibernateUrl: this.sessionState.hibernateUrl,
              restoreUrl: this.sessionState.restoreUrl,
              idleTimeoutMs: this.sessionState.idleTimeoutMs,
            },
            {
              task: msg.task!,
              workspace: msg.workspace!,
              repoUrl: msg.repoUrl,
              branch: msg.branch,
              ref: msg.ref,
              title: msg.title,
              sourceType: msg.sourceType,
              sourcePrNumber: msg.sourcePrNumber,
              sourceIssueNumber: msg.sourceIssueNumber,
              sourceRepoFullName: msg.sourceRepoFullName,
              model: msg.model,
              personaId: msg.personaId,
            },
          );
          if (result.error) {
            this.runnerLink.send({ type: 'spawn-child-result', requestId, error: result.error });
          } else {
            this.runnerLink.send({ type: 'spawn-child-result', requestId, childSessionId: result.childSessionId });
          }
        } catch (err) {
          console.error('[SessionAgentDO] Failed to spawn child:', err);
          this.runnerLink.send({
            type: 'spawn-child-result',
            requestId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },

      'session-message': async (msg) => {
        const requestId = msg.requestId!;
        try {
          const result = await sendSessionMessage(
            this.env,
            this.appDb,
            this.sessionState.userId,
            msg.targetSessionId!,
            msg.content!,
            msg.interrupt,
          );
          if (result.error) {
            this.runnerLink.send({ type: 'session-message-result', requestId, error: result.error });
          } else {
            this.runnerLink.send({ type: 'session-message-result', requestId, success: true });
          }
        } catch (err) {
          console.error('[SessionAgentDO] Failed to send message:', err);
          this.runnerLink.send({
            type: 'session-message-result',
            requestId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },

      'session-messages': async (msg) => {
        const requestId = msg.requestId!;
        try {
          const result = await getSessionMessages(
            this.env,
            this.appDb,
            this.sessionState.userId,
            msg.targetSessionId!,
            msg.limit,
            msg.after,
          );
          if (result.error) {
            this.runnerLink.send({ type: 'session-messages-result', requestId, error: result.error });
          } else {
            this.runnerLink.send({
              type: 'session-messages-result',
              requestId,
              messages: result.messages!.map((m) => ({
                role: m.role,
                content: m.content,
                createdAt: m.createdAt,
              })),
            });
          }
        } catch (err) {
          console.error('[SessionAgentDO] Failed to read messages:', err);
          this.runnerLink.send({
            type: 'session-messages-result',
            requestId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },

      'terminate-child': async (msg) => {
        const requestId = msg.requestId!;
        try {
          const result = await terminateChild(
            this.appDb,
            this.env,
            this.sessionState.sessionId,
            this.sessionState.userId,
            msg.childSessionId!,
          );
          if (result.error) {
            this.runnerLink.send({ type: 'terminate-child-result', requestId, error: result.error });
          } else {
            this.runnerLink.send({ type: 'terminate-child-result', requestId, success: true });
          }
        } catch (err) {
          console.error('[SessionAgentDO] Failed to terminate child:', err);
          this.runnerLink.send({
            type: 'terminate-child-result',
            requestId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },

      'channel-session-created': (msg) => {
        // Runner reports a new per-channel OpenCode session — store in channel_state
        const csChannelKey = msg.channelKey as string | undefined;
        const csOcSessionId = msg.opencodeSessionId as string | undefined;
        if (csChannelKey && csOcSessionId) {
          this.setChannelOcSessionId(csChannelKey, csOcSessionId);
          console.log(`[SessionAgentDO] Channel session created: ${csChannelKey} -> ${csOcSessionId}`);
        }
      },

      'thread.created': (msg) => {
        const threadId = msg.threadId;
        const threadOcSessionId = msg.opencodeSessionId;
        if (threadId && threadOcSessionId) {
          this.ctx.waitUntil(
            updateThread(this.env.DB, threadId, { opencodeSessionId: threadOcSessionId })
          );
          console.log(`[SessionAgentDO] Thread created: ${threadId} -> ${threadOcSessionId}`);
          this.broadcastToClients({
            type: 'thread.created',
            threadId,
            opencodeSessionId: threadOcSessionId,
          });
        }
      },

      'thread.updated': (msg) => {
        const threadId = msg.threadId;
        if (threadId) {
          const threadUpdates: Record<string, unknown> = {};
          if (msg.title !== undefined) threadUpdates.title = msg.title;
          if (msg.summaryAdditions !== undefined) threadUpdates.summaryAdditions = msg.summaryAdditions;
          if (msg.summaryDeletions !== undefined) threadUpdates.summaryDeletions = msg.summaryDeletions;
          if (msg.summaryFiles !== undefined) threadUpdates.summaryFiles = msg.summaryFiles;
          if (Object.keys(threadUpdates).length > 0) {
            this.ctx.waitUntil(
              updateThread(this.env.DB, threadId, threadUpdates as any)
            );
          }
          console.log(`[SessionAgentDO] Thread updated: ${threadId} title=${msg.title || '(unchanged)'}`);
        }
        this.broadcastToClients({
          type: 'thread.updated',
          threadId,
          ...(msg.title !== undefined ? { title: msg.title } : {}),
          ...(msg.summaryAdditions !== undefined ? { summaryAdditions: msg.summaryAdditions } : {}),
          ...(msg.summaryDeletions !== undefined ? { summaryDeletions: msg.summaryDeletions } : {}),
          ...(msg.summaryFiles !== undefined ? { summaryFiles: msg.summaryFiles } : {}),
        });
      },

      'session-reset': (msg) => {
        // Runner confirmed session rotation — insert visual break marker
        const breakId = crypto.randomUUID();
        const srChannelType = (msg as any).channelType as string | undefined;
        const srChannelId = (msg as any).channelId as string | undefined;
        this.messageStore.writeMessage({
          id: breakId,
          role: 'system',
          content: 'New session started',
          parts: JSON.stringify({ type: 'session-break' }),
          channelType: srChannelType,
          channelId: srChannelId,
        });
        this.broadcastToClients({
          type: 'message',
          data: {
            id: breakId,
            role: 'system',
            content: 'New session started',
            parts: { type: 'session-break' },
            createdAt: Math.floor(Date.now() / 1000),
            channelType: srChannelType,
            channelId: srChannelId,
          },
        });
      },

      'self-terminate': async (msg) => {
        await this.handleSelfTerminate();
      },

      'opencode-config-applied': (msg) => {
        if (msg.error) {
          console.error(`[SessionAgentDO] OpenCode config apply failed: ${msg.error}`);
          this.emitAuditEvent('opencode.config_error', `Config apply failed: ${msg.error}`);
        } else {
          console.log(`[SessionAgentDO] OpenCode config applied (restarted=${msg.restarted ?? false})`);
          if (msg.restarted) {
            this.emitAuditEvent('opencode.config_applied', 'OpenCode restarted with new config');
          }
        }
      },

      // ─── Memory File Operations ────────────────────────────────────────
      'mem-read': async (msg) => {
        const userId = this.sessionState.userId;
        try {
          const result = await memRead(this.appDb, userId, msg.path);
          this.runnerLink.send({ type: 'mem-read-result', requestId: msg.requestId!, ...result } as any);
        } catch (err) {
          this.runnerLink.send({ type: 'mem-read-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      'mem-write': async (msg) => {
        const userId = this.sessionState.userId;
        try {
          const result = await memWrite(this.env.DB, userId, msg.path!, msg.content!);
          this.runnerLink.send({ type: 'mem-write-result', requestId: msg.requestId!, ...result } as any);
        } catch (err) {
          this.runnerLink.send({ type: 'mem-write-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      'mem-patch': async (msg) => {
        const userId = this.sessionState.userId;
        try {
          const result = await memPatch(this.env.DB, userId, msg.path!, msg.operations);
          this.runnerLink.send({ type: 'mem-patch-result', requestId: msg.requestId!, ...result } as any);
        } catch (err) {
          this.runnerLink.send({ type: 'mem-patch-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      'mem-rm': async (msg) => {
        const userId = this.sessionState.userId;
        try {
          const result = await memRm(this.env.DB, userId, msg.path!);
          this.runnerLink.send({ type: 'mem-rm-result', requestId: msg.requestId!, ...result } as any);
        } catch (err) {
          this.runnerLink.send({ type: 'mem-rm-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      'mem-search': async (msg) => {
        const userId = this.sessionState.userId;
        try {
          const result = await memSearch(this.env.DB, userId, msg.query!, msg.path, msg.limit);
          this.runnerLink.send({ type: 'mem-search-result', requestId: msg.requestId!, ...result } as any);
        } catch (err) {
          this.runnerLink.send({ type: 'mem-search-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      'list-repos': async (msg) => {
        try {
          const repos = await listOrgRepositories(this.env.DB);
          this.runnerLink.send({ type: 'list-repos-result', requestId: msg.requestId!, repos } as any);
        } catch (err) {
          console.error('[SessionAgentDO] Failed to list repos:', err);
          this.runnerLink.send({ type: 'list-repos-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      'list-personas': async (msg) => {
        try {
          const personas = await listPersonasForRunner(this.env.DB, this.sessionState.userId);
          this.runnerLink.send({ type: 'list-personas-result', requestId: msg.requestId!, personas } as any);
        } catch (err) {
          console.error('[SessionAgentDO] Failed to list personas:', err);
          this.runnerLink.send({ type: 'list-personas-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      'list-channels': async (msg) => {
        const requestId = msg.requestId!;
        try {
          const result = await listChannels(this.appDb, this.sessionState.sessionId, this.sessionState.userId);
          if (result.error) {
            this.runnerLink.send({ type: 'list-channels-result', requestId, error: result.error } as any);
          } else {
            this.runnerLink.send({ type: 'list-channels-result', requestId, channels: result.channels } as any);
          }
        } catch (err) {
          console.error('[SessionAgentDO] Failed to list channels:', err);
          this.runnerLink.send({ type: 'list-channels-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      'get-session-status': async (msg) => {
        const requestId = msg.requestId!;
        try {
          const result = await getSessionStatus(this.appDb, this.env, this.sessionState.userId, msg.targetSessionId!);
          if (result.error) {
            this.runnerLink.send({ type: 'get-session-status-result', requestId, error: result.error } as any);
          } else {
            this.runnerLink.send({ type: 'get-session-status-result', requestId, sessionStatus: result.sessionStatus } as any);
          }
        } catch (err) {
          console.error('[SessionAgentDO] Failed to get session status:', err);
          this.runnerLink.send({ type: 'get-session-status-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      'list-child-sessions': async (msg) => {
        const requestId = msg.requestId!;
        try {
          const { children } = await listChildSessions(this.env, this.sessionState.sessionId);
          this.runnerLink.send({ type: 'list-child-sessions-result', requestId, children } as any);
        } catch (err) {
          console.error('[SessionAgentDO] Failed to list child sessions:', err);
          this.runnerLink.send({ type: 'list-child-sessions-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      'forward-messages': async (msg) => {
        const requestId = msg.requestId!;
        try {
          const result = await forwardMessages(
            this.env,
            this.appDb,
            this.sessionState.userId,
            msg.targetSessionId!,
            msg.limit,
            msg.after,
          );
          if (result.error) {
            this.runnerLink.send({ type: 'forward-messages-result', requestId, error: result.error });
            return;
          }

          const messages = result.messages!;
          const { sessionTitle, sourceSessionId } = result;

          if (messages.length === 0) {
            this.runnerLink.send({ type: 'forward-messages-result', requestId, count: 0, sourceSessionId });
            return;
          }

          // Insert each message into our own messages table with forwarded metadata
          for (const msg of messages) {
            const newId = crypto.randomUUID();
            const parts = JSON.stringify({
              forwarded: true,
              sourceSessionId,
              sourceSessionTitle: sessionTitle,
              originalRole: msg.role,
              originalCreatedAt: msg.createdAt,
            });

            // Store all forwarded messages as 'assistant' role for consistent left-aligned rendering
            this.messageStore.writeMessage({
              id: newId,
              role: 'assistant',
              content: msg.content,
              parts,
            });

            this.broadcastToClients({
              type: 'message',
              data: {
                id: newId,
                role: 'assistant',
                content: msg.content,
                parts: {
                  forwarded: true,
                  sourceSessionId,
                  sourceSessionTitle: sessionTitle,
                  originalRole: msg.role,
                  originalCreatedAt: msg.createdAt,
                },
                createdAt: Math.floor(Date.now() / 1000),
              },
            });
          }

          this.runnerLink.send({
            type: 'forward-messages-result',
            requestId,
            count: messages.length,
            sourceSessionId,
          });
        } catch (err) {
          console.error('[SessionAgentDO] Failed to forward messages:', err);
          this.runnerLink.send({
            type: 'forward-messages-result',
            requestId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      },

      'workflow-list': async (msg) => {
        try {
          const result = await workflowListSvc(this.appDb, this.sessionState.userId);
          if (result.error) {
            this.runnerLink.send({ type: 'workflow-list-result', requestId: msg.requestId!, error: result.error } as any);
          } else {
            this.runnerLink.send({ type: 'workflow-list-result', requestId: msg.requestId!, workflows: result.data!.workflows } as any);
          }
        } catch (err) {
          console.error('[SessionAgentDO] Failed to list workflows:', err);
          this.runnerLink.send({ type: 'workflow-list-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      'workflow-sync': async (msg) => {
        try {
          const result = await workflowSyncSvc(this.appDb, this.env.DB, this.sessionState.userId, {
            id: msg.id,
            slug: msg.slug,
            name: msg.name,
            description: msg.description,
            version: msg.version,
            data: msg.data,
          });
          if (result.error) {
            this.runnerLink.send({ type: 'workflow-sync-result', requestId: msg.requestId!, error: result.error } as any);
          } else {
            this.runnerLink.send({ type: 'workflow-sync-result', requestId: msg.requestId!, success: true, workflow: result.data!.workflow } as any);
          }
        } catch (err) {
          console.error('[SessionAgentDO] Failed to sync workflow:', err);
          this.runnerLink.send({ type: 'workflow-sync-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      'workflow-run': async (msg) => {
        try {
          const result = await workflowRunSvc(this.appDb, this.env.DB, this.env, this.sessionState.userId, msg.requestId!, {
            workflowId: msg.workflowId!,
            variables: msg.variables,
            repoContext: {
              repoUrl: msg.repoUrl,
              branch: msg.branch,
              ref: msg.ref,
              sourceRepoFullName: msg.sourceRepoFullName,
            },
            spawnRequest: this.sessionState.spawnRequest,
          });
          if (result.error) {
            this.runnerLink.send({ type: 'workflow-run-result', requestId: msg.requestId!, error: result.error } as any);
          } else {
            this.runnerLink.send({ type: 'workflow-run-result', requestId: msg.requestId!, execution: result.data!.execution } as any);
          }
        } catch (err) {
          console.error('[SessionAgentDO] Failed to run workflow:', err);
          this.runnerLink.send({ type: 'workflow-run-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      'workflow-executions': async (msg) => {
        try {
          const result = await workflowExecutionsSvc(this.appDb, this.env.DB, this.sessionState.userId, msg.workflowId, msg.limit);
          if (result.error) {
            this.runnerLink.send({ type: 'workflow-executions-result', requestId: msg.requestId!, error: result.error } as any);
          } else {
            this.runnerLink.send({ type: 'workflow-executions-result', requestId: msg.requestId!, executions: result.data!.executions } as any);
          }
        } catch (err) {
          console.error('[SessionAgentDO] Failed to list workflow executions:', err);
          this.runnerLink.send({ type: 'workflow-executions-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      'workflow-api': async (msg) => {
        try {
          const result = await handleWorkflowActionSvc(this.appDb, this.env.DB, this.sessionState.userId, msg.action || '', msg.payload);
          if (result.error) {
            this.runnerLink.send({ type: 'workflow-api-result', requestId: msg.requestId!, error: result.error } as any);
          } else {
            this.runnerLink.send({ type: 'workflow-api-result', requestId: msg.requestId!, data: result.data } as any);
          }
        } catch (err) {
          console.error('[SessionAgentDO] Workflow API error:', err);
          this.runnerLink.send({ type: 'workflow-api-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      'trigger-api': async (msg) => {
        try {
          const augmentedPayload = msg.payload ? { ...msg.payload, requestId: msg.requestId, _spawnRequest: this.sessionState.spawnRequest } : { requestId: msg.requestId, _spawnRequest: this.sessionState.spawnRequest };
          const result = await handleTriggerActionSvc(this.appDb, this.env.DB, this.env, this.sessionState.userId, this.sessionState.sessionId, msg.action || '', augmentedPayload);
          if (result.error) {
            this.runnerLink.send({ type: 'trigger-api-result', requestId: msg.requestId!, error: result.error } as any);
          } else {
            this.runnerLink.send({ type: 'trigger-api-result', requestId: msg.requestId!, data: result.data } as any);
          }
        } catch (err) {
          console.error('[SessionAgentDO] Trigger API error:', err);
          this.runnerLink.send({ type: 'trigger-api-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      'skill-api': async (msg) => {
        try {
          const orgId = await this.resolveOrgId() ?? 'default';
          const result = await handleSkillAction(
            this.appDb,
            orgId,
            this.sessionState.userId,
            msg.action || '',
            msg.payload,
          );
          if (result.error) {
            this.runnerLink.send({ type: 'skill-api-result', requestId: msg.requestId!, error: result.error, statusCode: result.statusCode });
            return;
          }
          this.runnerLink.send({ type: 'skill-api-result', requestId: msg.requestId!, data: result.data });
        } catch (err) {
          console.error('[SessionAgentDO] Skill API error:', err);
          this.runnerLink.send({ type: 'skill-api-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err), statusCode: 500 });
        }
      },

      'persona-api': async (msg) => {
        try {
          const result = await handlePersonaAction(
            this.appDb,
            this.env.DB,
            this.sessionState.userId,
            msg.action || '',
            msg.payload,
          );
          if (result.error) {
            this.runnerLink.send({ type: 'persona-api-result', requestId: msg.requestId!, error: result.error, statusCode: result.statusCode });
            return;
          }
          this.runnerLink.send({ type: 'persona-api-result', requestId: msg.requestId!, data: result.data });
        } catch (err) {
          console.error('[SessionAgentDO] Persona API error:', err);
          this.runnerLink.send({ type: 'persona-api-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err), statusCode: 500 });
        }
      },

      'identity-api': async (msg) => {
        try {
          const result = await handleIdentityAction(
            this.appDb,
            this.sessionState.userId,
            msg.action || '',
            msg.payload,
          );
          if (result.error) {
            this.runnerLink.send({ type: 'identity-api-result', requestId: msg.requestId!, error: result.error, statusCode: result.statusCode } as any);
            return;
          }
          this.runnerLink.send({ type: 'identity-api-result', requestId: msg.requestId!, data: result.data } as any);
          // Hot-reload persona files if update-instructions returned updated files
          const personaFiles = result.data?._personaFiles as ReturnType<typeof buildOrchestratorPersonaFiles> | null | undefined;
          if (personaFiles) {
            try {
              const spawnRequest = this.sessionState.spawnRequest;
              if (spawnRequest) {
                spawnRequest.personaFiles = personaFiles;
                this.sessionState.spawnRequest = spawnRequest;
              }
              await this.sendPluginContent();
            } catch (err) {
              console.warn('[SessionAgentDO] Failed to hot-reload persona files:', err);
            }
          }
        } catch (err) {
          console.error('[SessionAgentDO] Identity API error:', err);
          this.runnerLink.send({ type: 'identity-api-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err), statusCode: 500 } as any);
        }
      },

      'execution-api': async (msg) => {
        try {
          const result = await handleExecutionActionSvc(this.appDb, this.env.DB, this.env, this.sessionState.userId, msg.action || '', msg.payload);
          if (result.error) {
            this.runnerLink.send({ type: 'execution-api-result', requestId: msg.requestId!, error: result.error } as any);
          } else {
            this.runnerLink.send({ type: 'execution-api-result', requestId: msg.requestId!, data: result.data } as any);
          }
        } catch (err) {
          console.error('[SessionAgentDO] Execution API error:', err);
          this.runnerLink.send({ type: 'execution-api-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      'workflow-execution-result': async (msg) => {
        const resultData = await processWorkflowExecutionResultSvc(
          this.appDb,
          this.env.DB,
          msg,
          this.sessionState.sessionId,
        );
        if (resultData?.shouldStopSession) {
          this.ctx.waitUntil(this.handleStop(`workflow_execution_${resultData.nextStatus}`));
        }
      },

      // ─── Phase C: Mailbox + Task Board ──────────────────────────────
      'mailbox-send': async (msg) => {
        try {
          const result = await mailboxSend(
            this.appDb,
            this.env.DB,
            this.sessionState.sessionId,
            this.sessionState.userId,
            {
              toSessionId: msg.toSessionId,
              toUserId: msg.toUserId,
              toHandle: msg.toHandle,
              messageType: msg.messageType,
              content: msg.content!,
              contextSessionId: msg.contextSessionId,
              contextTaskId: msg.contextTaskId,
              replyToId: msg.replyToId,
            },
          );
          this.runnerLink.send({ type: 'mailbox-send-result', requestId: msg.requestId!, ...result } as any);
        } catch (err) {
          this.runnerLink.send({ type: 'mailbox-send-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      'mailbox-check': async (msg) => {
        try {
          const result = await mailboxCheck(
            this.appDb,
            this.env.DB,
            this.sessionState.sessionId,
            this.sessionState.userId,
            msg.limit,
            msg.after,
          );
          this.runnerLink.send({ type: 'mailbox-check-result', requestId: msg.requestId!, ...result } as any);
        } catch (err) {
          this.runnerLink.send({ type: 'mailbox-check-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      'task-create': async (msg) => {
        try {
          const result = await taskCreate(
            this.appDb,
            this.env.DB,
            this.sessionState.sessionId,
            this.sessionState.userId,
            {
              sessionId: msg.sessionId,
              title: msg.title!,
              description: msg.description,
              parentTaskId: msg.parentTaskId,
              blockedBy: msg.blockedBy,
            },
          );
          this.runnerLink.send({ type: 'task-create-result', requestId: msg.requestId!, ...result } as any);
        } catch (err) {
          this.runnerLink.send({ type: 'task-create-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      'task-list': async (msg) => {
        try {
          const result = await taskList(
            this.appDb,
            this.env.DB,
            this.sessionState.sessionId,
            msg.status,
            msg.limit,
          );
          this.runnerLink.send({ type: 'task-list-result', requestId: msg.requestId!, ...result } as any);
        } catch (err) {
          this.runnerLink.send({ type: 'task-list-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      'task-update': async (msg) => {
        try {
          const result = await taskUpdate(
            this.appDb,
            this.env.DB,
            this.sessionState.sessionId,
            msg.taskId!,
            {
              status: msg.status as string | undefined,
              result: msg.result as string | undefined,
              description: msg.description,
              sessionId: msg.sessionId,
              title: msg.title,
            },
          );
          this.runnerLink.send({ type: 'task-update-result', requestId: msg.requestId!, ...result } as any);
        } catch (err) {
          this.runnerLink.send({ type: 'task-update-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      'task-my': async (msg) => {
        try {
          const result = await taskMy(
            this.appDb,
            this.env.DB,
            this.sessionState.sessionId,
            msg.status,
          );
          this.runnerLink.send({ type: 'task-my-result', requestId: msg.requestId!, ...result } as any);
        } catch (err) {
          this.runnerLink.send({ type: 'task-my-result', requestId: msg.requestId!, error: err instanceof Error ? err.message : String(err) } as any);
        }
      },

      // ─── Phase D: Channel Reply ──────────────────────────────────────
      'channel-reply': async (msg) => {
        await this.handleChannelReply(
          msg.requestId!, msg.channelType!, msg.channelId!, msg.message || '',
          msg.imageBase64, msg.imageMimeType, msg.followUp,
          msg.fileBase64, msg.fileMimeType, msg.fileName,
        );
      },

      // ─── Tool Discovery & Invocation ──────────────────────────────────
      'list-tools': async (msg) => {
        await this.handleListTools(msg.requestId!, msg.service, msg.query);
      },

      'call-tool': async (msg) => {
        await this.handleCallTool(msg.requestId!, msg.toolId!, msg.params ?? {}, msg.summary);
      },

      'repo:refresh-token': async (msg) => {
        await this.handleRepoTokenRefresh(msg.requestId);
      },

      'repo:clone-complete': (msg) => {
        if (msg.success !== false) {
          console.log('[SessionAgentDO] Repo clone completed successfully');
        } else {
          console.error('[SessionAgentDO] Repo clone failed:', msg.error);
        }
      },

      'analytics:emit': (msg) => {
        const events = (msg as any).events;
        if (Array.isArray(events)) {
          const capped = events.slice(0, 100);
          for (const event of capped) {
            if (event.eventType && typeof event.eventType === 'string') {
              let properties: Record<string, unknown> | undefined;
              const propsRaw = event.properties;
              if (propsRaw && typeof propsRaw === 'object' && !Array.isArray(propsRaw)) {
                const serialized = JSON.stringify(propsRaw);
                if (serialized.length <= 4096) {
                  properties = propsRaw;
                }
              }
              this.emitEvent(event.eventType, {
                durationMs: typeof event.durationMs === 'number' ? event.durationMs : undefined,
                properties,
              });
            }
          }
        }
      },

      'runner-health': (msg) => {
        const kind = msg.kind;
        const detail = [
          kind,
          msg.exitCode != null ? `exit=${msg.exitCode}` : '',
          msg.crashCount != null ? `crashes=${msg.crashCount}` : '',
          msg.message || '',
        ].filter(Boolean).join(', ');

        console.warn(`[SessionAgentDO] Runner health event: ${detail}`);

        this.emitEvent('session.recovery', {
          summary: `runner_health: ${kind}`,
          properties: {
            kind,
            exitCode: msg.exitCode,
            crashCount: msg.crashCount,
            message: msg.message,
          },
        });
        // Flush eagerly — recovery events are high-priority and the session
        // may die before the next lifecycle boundary triggers a flush.
        this.ctx.waitUntil(this.flushMetrics());
      },

      'ping': () => {
        // Keepalive from runner — respond with pong
        this.runnerLink.send({ type: 'pong' });
      },
    };
  }


  private async handleSelfTerminate() {
    const sessionId = this.sessionState.sessionId;
    console.log(`[SessionAgentDO] Session ${sessionId} self-terminating (task complete)`);

    // Reuse handleStop which handles sandbox teardown, cascade, etc.
    return await this.handleStop('completed');
  }

  // ─── D1 Message Archival ───────────────────────────────────────────
  // Flush messages from DO's internal SQLite to D1 for permanent archival.
  // Uses INSERT OR REPLACE so active turns with partial tool data get updated.

  /**
   * Schedule a debounced flush to D1. Called during active tool work so that
   * in-progress turns are persisted within a few seconds, surviving page refresh.
   */
  private scheduleDebouncedFlush(): void {
    if (this.d1FlushTimer) return; // already scheduled
    this.d1FlushTimer = setTimeout(() => {
      this.d1FlushTimer = null;
      this.ctx.waitUntil(this.flushMessagesToD1());
    }, 3_000);
  }

  private async flushMessagesToD1(): Promise<void> {
    const sessionId = this.sessionState.sessionId;
    if (!sessionId) return;
    try {
      const count = await this.messageStore.flushToD1(this.env.DB, sessionId, batchUpsertMessages);
      if (count > 0) {
        console.log(`[SessionAgentDO] Flushed ${count} messages to D1`);
      }
    } catch (err) {
      console.error('[SessionAgentDO] Failed to flush messages to D1:', err);
    }
  }

  // ─── Per-Channel Busy State ──────────────────────────────────────────

  private channelKeyFrom(channelType?: string, channelId?: string): string {
    if (channelType && channelId) return `${channelType}:${channelId}`;
    return 'web:default';
  }


  private setChannelOcSessionId(channelKey: string, ocSessionId: string): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO channel_state (channel_key, busy, opencode_session_id) VALUES (?, 0, ?) ON CONFLICT(channel_key) DO UPDATE SET opencode_session_id = excluded.opencode_session_id',
      channelKey, ocSessionId
    );
  }

  private getChannelOcSessionId(channelKey: string): string | undefined {
    const row = this.ctx.storage.sql
      .exec('SELECT opencode_session_id FROM channel_state WHERE channel_key = ?', channelKey)
      .toArray();
    const value = row[0]?.opencode_session_id as string | null | undefined;
    return value || undefined;
  }

  private async hydrateThreadResumeContext(threadId: string): Promise<{ opencodeSessionId?: string; continuationContext?: string }> {
    const threadRow = await this.env.DB
      .prepare('SELECT session_id, opencode_session_id FROM session_threads WHERE id = ?')
      .bind(threadId)
      .first<{ session_id?: string | null; opencode_session_id?: string | null }>();

    const persistedSessionId = threadRow?.opencode_session_id || undefined;
    const owningSessionId = threadRow?.session_id;
    if (!owningSessionId) {
      return persistedSessionId ? { opencodeSessionId: persistedSessionId } : {};
    }

    const msgResult = await this.env.DB
      .prepare(
        'SELECT role, content FROM messages WHERE session_id = ? AND thread_id = ? ORDER BY created_at DESC LIMIT 20'
      )
      .bind(owningSessionId, threadId)
      .all<{ role?: string; content?: string }>();

    const rows = (msgResult.results || []).reverse();
    const continuationContext = buildThreadContinuationContext(rows);
    return {
      ...(persistedSessionId ? { opencodeSessionId: persistedSessionId } : {}),
      ...(continuationContext ? { continuationContext } : {}),
    };
  }


  private async handlePromptComplete() {
    try {
      this.promptQueue.clearDispatchTimers();

      // Emit turn_complete timing — measure total time from prompt received to completion
      const promptStart = this.promptQueue.promptReceivedAt;
      if (promptStart > 0) {
        // Read model from the processing prompt_queue entry before it's marked completed
        const turnModel = this.promptQueue.getProcessingModel() || undefined;
        this.emitEvent('turn_complete', {
          durationMs: Date.now() - promptStart,
          channel: this.activeChannel?.channelType || undefined,
          model: turnModel,
          queueMode: this.promptQueue.queueMode || undefined,
        });
        this.promptQueue.clearPromptReceived();
      }

      this.emitAuditEvent('agent.turn_complete', 'Agent turn completed');

      // Mark processing → completed, then prune
      const processingCount = this.promptQueue.markCompleted();

      const queuedAfterPrune = this.promptQueue.length;
      console.log(`[SessionAgentDO] handlePromptComplete: marked ${processingCount} processing→completed, queuedRemaining=${queuedAfterPrune}`);

      if (await this.sendNextQueuedPrompt()) {
        console.log(`[SessionAgentDO] handlePromptComplete: dispatched next queued prompt, keeping runnerBusy=true`);
        // More work in the queue — flush messages synchronously so they survive hibernation
        await this.flushMessagesToD1();
        return;
      }

      this.channelRouter.clearActiveChannel();

      // Runner is now idle — flush messages synchronously so they survive hibernation
      await this.flushMessagesToD1();

      // Track idle-queued timing for watchdog
      if (this.promptQueue.length > 0) {
        if (!this.promptQueue.idleQueuedSince) {
          this.promptQueue.idleQueuedSince = Date.now();
          this.rescheduleIdleAlarm();
        }
      } else {
        this.promptQueue.idleQueuedSince = 0;
      }

      // Runner is now idle
      console.log(`[SessionAgentDO] handlePromptComplete: queue empty, setting runnerBusy=false`);
      this.promptQueue.runnerBusy = false;
      this.broadcastToClients({
        type: 'status',
        data: { runnerBusy: false },
      });
      this.notifyParentIfIdle();
    } catch (err) {
      // Ensure runnerBusy is cleared even on error to prevent permanent stuck state
      console.error('[SessionAgentDO] handlePromptComplete error, forcing runnerBusy=false:', err);
      this.promptQueue.runnerBusy = false;
      this.broadcastToClients({
        type: 'status',
        data: { runnerBusy: false },
      });
    }
  }

  // ─── Internal Endpoints ────────────────────────────────────────────────

  private async handleStart(request: Request): Promise<Response> {
    const body = await request.json() as SessionStartParams & {
      runnerToken: string;
      tunnelUrls?: Record<string, string>;
      queueMode?: string;
      collectDebounceMs?: number;
    };

    // Clear old session data (messages, queue, audit log, followups) for a fresh start.
    // This is important for well-known DOs (orchestrators) that get reused.
    this.messageStore.reset();
    this.promptQueue.clearAll();
    this.promptQueue.idleQueuedSince = 0;
    this.ctx.storage.sql.exec('DELETE FROM analytics_events');
    this.ctx.storage.sql.exec('DELETE FROM channel_followups');

    // Initialize all session state (clears stale values, sets identity + optional fields)
    this.sessionState.initialize(body);
    this.runnerLink.token = body.runnerToken;
    this.promptQueue.runnerBusy = false;
    this.promptQueue.queueMode = body.queueMode || 'followup';
    this.promptQueue.collectDebounceMs = body.collectDebounceMs || 3000;

    // If sandbox info was provided directly, we're already running
    if (body.sandboxId && body.tunnelUrls) {
      this.sessionState.status = 'running';
      this.lifecycle.markRunningStarted();
      updateSessionStatus(this.appDb, body.sessionId, 'running', body.sandboxId).catch((err) =>
        console.error('[SessionAgentDO] Failed to sync status to D1:', err),
      );
      this.broadcastToClients({
        type: 'status',
        data: {
          status: 'running',
          sandboxRunning: true,
          tunnelUrls: body.tunnelUrls,
        },
      });
      this.rescheduleIdleAlarm();
    } else if (body.backendUrl && body.spawnRequest) {
      // Spawn sandbox asynchronously — return immediately, DO continues in background
      this.broadcastToClients({
        type: 'status',
        data: { status: 'initializing' },
      });
      this.ctx.waitUntil(this.spawnSandbox(body.backendUrl, body.spawnRequest));
    }

    // Publish session.started to EventBus
    this.notifyEventBus({
      type: 'session.started',
      sessionId: body.sessionId,
      userId: body.userId,
      data: { workspace: body.workspace, sandboxId: body.sandboxId },
      timestamp: new Date().toISOString(),
    });

    this.emitAuditEvent('session.started', `Session started for ${body.workspace}`, body.userId);
    // Skip lifecycle notifications for orchestrator sessions — they restart
    // frequently and the noise isn't useful since the user explicitly triggers refreshes.
    if (!body.sessionId?.startsWith('orchestrator:')) {
      await this.enqueueOwnerNotification({
        messageType: 'notification',
        eventType: 'session.lifecycle',
        content: `Session started: ${body.workspace}`,
        contextSessionId: body.sessionId,
      });
    }

    return Response.json({
      success: true,
      status: 'initializing',
    });
  }

  /**
   * Spawn a sandbox via the Modal backend. Runs in the background via waitUntil()
   * so the Worker request can return immediately.
   */
  private async spawnSandbox(
    backendUrl: string,
    spawnRequest: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = this.sessionState.sessionId;
    try {
      this.sessionState.sandboxWakeStartedAt = Date.now();

      const result = await this.lifecycle.spawnSandbox(backendUrl, spawnRequest);

      this.emitEvent('sandbox_wake', { durationMs: result.durationMs });

      // Store sandbox info
      this.sessionState.sandboxId = result.sandboxId;
      this.sessionState.tunnelUrls = result.tunnelUrls;
      this.sessionState.status = 'running';
      this.lifecycle.markRunningStarted();

      updateSessionStatus(this.appDb, sessionId!, 'running', result.sandboxId).catch((err) =>
        console.error('[SessionAgentDO] Failed to sync status to D1:', err),
      );

      this.broadcastToClients({
        type: 'status',
        data: {
          status: 'running',
          sandboxRunning: true,
          tunnelUrls: result.tunnelUrls,
        },
      });

      this.rescheduleIdleAlarm();
      console.log(`[SessionAgentDO] Sandbox spawned: ${result.sandboxId} for session ${sessionId}`);
    } catch (err) {
      console.error(`[SessionAgentDO] Failed to spawn sandbox for session ${sessionId}:`, err);
      const errorText = `Failed to create sandbox: ${err instanceof Error ? err.message : String(err)}`;
      this.sessionState.status = 'error';
      if (sessionId) {
        updateSessionStatus(this.appDb, sessionId, 'error', undefined, errorText).catch((e) =>
          console.error('[SessionAgentDO] Failed to sync error status to D1:', e),
        );
      }
      const errId = crypto.randomUUID();
      this.messageStore.writeMessage({
        id: errId,
        role: 'system',
        content: `Error: ${errorText}`,
      });
      this.broadcastToClients({
        type: 'status',
        data: { status: 'error' },
      });
      this.broadcastToClients({
        type: 'error',
        messageId: errId,
        error: errorText,
      });

      this.notifyEventBus({
        type: 'session.errored',
        sessionId: sessionId || undefined,
        userId: this.sessionState.userId || undefined,
        data: { error: err instanceof Error ? err.message : String(err) },
        timestamp: new Date().toISOString(),
      });
      await this.enqueueOwnerNotification({
        messageType: 'escalation',
        content: `Session failed to start: ${errorText}`,
        contextSessionId: sessionId || undefined,
      });
    }
  }

  private async handleStop(reason: string = 'user_stopped'): Promise<Response> {
    const sandboxId = this.sessionState.sandboxId;
    const sessionId = this.sessionState.sessionId;
    const currentStatus = this.sessionState.status;

    // Idempotency: if already terminated, skip all side-effects
    if (currentStatus === 'terminated') {
      console.log(`[SessionAgentDO] handleStop(${reason}) skipped — already terminated`);
      return Response.json({ success: true, status: 'terminated', alreadyTerminated: true });
    }

    // Flush active time, metrics, and messages to D1 before termination
    if (currentStatus === 'running') {
      await this.flushActiveSeconds();
      this.lifecycle.clearRunningStarted();
    }
    await this.flushMetrics();
    await this.flushMessagesToD1();

    // Tell runner to stop
    this.runnerLink.send({ type: 'stop' });

    // Close all runner connections
    const runnerSockets = this.ctx.getWebSockets('runner');
    for (const ws of runnerSockets) {
      try {
        ws.close(1000, 'Session terminated');
      } catch {
        // ignore
      }
    }

    // Cascade: terminate all active child sessions (best-effort)
    if (sessionId) {
      try {
        const { children } = await getChildSessions(this.env.DB, sessionId);
        const activeChildren = children.filter(
          (c) => c.status !== 'terminated' && c.status !== 'archived',
        );
        await Promise.allSettled(
          activeChildren.map(async (child) => {
            try {
              const childDoId = this.env.SESSIONS.idFromName(child.id);
              const childDO = this.env.SESSIONS.get(childDoId);
              await childDO.fetch(new Request('http://do/stop', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ reason: 'parent_stopped' }),
              }));
              console.log(`[SessionAgentDO] Cascade-terminated child ${child.id}`);
            } catch (err) {
              console.error(`[SessionAgentDO] Failed to cascade-terminate child ${child.id}:`, err);
            }
          }),
        );
      } catch (err) {
        console.error('[SessionAgentDO] Failed to fetch child sessions for cascade:', err);
      }
    }

    // Only terminate sandbox if it's actually running (not hibernated/hibernating)
    if (currentStatus !== 'hibernated' && currentStatus !== 'hibernating') {
      await this.lifecycle.terminateSandbox();
    }

    // Clear idle alarm
    this.ctx.storage.deleteAlarm();

    // Update state
    this.sessionState.status = 'terminated';
    this.sessionState.sandboxId = undefined;
    this.sessionState.tunnelUrls = null;
    this.sessionState.tunnels = [];
    this.sessionState.snapshotImageId = undefined;
    this.promptQueue.runnerBusy = false;
    this.promptQueue.clearAll();

    // Sync status to D1
    if (sessionId) {
      updateSessionStatus(this.appDb, sessionId, 'terminated').catch((e) =>
        console.error('[SessionAgentDO] Failed to sync terminated status to D1:', e),
      );
    }

    // Notify clients
    this.broadcastToClients({
      type: 'status',
      data: { status: 'terminated', sandboxRunning: false },
    });

    this.emitAuditEvent('session.terminated', 'Session terminated');

    // Publish session.completed to EventBus
    this.notifyEventBus({
      type: 'session.completed',
      sessionId: sessionId || undefined,
      userId: this.sessionState.userId || undefined,
      data: { sandboxId: sandboxId || null, reason },
      timestamp: new Date().toISOString(),
    });
    if (!sessionId?.startsWith('orchestrator:')) {
      await this.enqueueOwnerNotification({
        messageType: 'notification',
        eventType: 'session.lifecycle',
        content: `Session completed (${reason}).`,
        contextSessionId: sessionId || undefined,
      });
    }

    await this.notifyParentEvent(`Child session event: ${sessionId} completed (reason: ${reason}).`, { wake: true, childStatus: reason === 'error' ? 'error' : 'terminated' });

    return Response.json({
      success: true,
      status: 'terminated',
      sandboxId,
      sessionId,
    });
  }

  private async handleStatus(): Promise<Response> {
    const status = this.sessionState.status;
    const sandboxId = this.sessionState.sandboxId;
    const sessionId = this.sessionState.sessionId;
    const userId = this.sessionState.userId;
    const workspace = this.sessionState.workspace;
    const tunnelUrlsParsed = this.sessionState.tunnelUrls;
    const tunnelsParsed = this.sessionState.tunnels;
    const runnerBusy = this.promptQueue.runnerBusy;

    const messageCount = this.ctx.storage.sql
      .exec('SELECT COUNT(*) as count FROM messages')
      .toArray()[0]?.count ?? 0;

    const queueLength = this.promptQueue.length;
    const clientCount = this.getClientSockets().length;
    const runnerConnected = this.runnerLink.isConnected;
    const connectedUsers = this.getConnectedUserIds();
    const runningStartedAt = this.sessionState.runningStartedAt;

    const gatewayUrl = tunnelUrlsParsed?.gateway;
    const tunnels = Array.isArray(tunnelsParsed)
      ? tunnelsParsed.map((t) => ({
        ...t,
        // Prefer cloudflared URL (clean hostname, no path prefix), fall back to gateway path
        url: t.url || (gatewayUrl ? `${gatewayUrl}${t.path}` : undefined),
      }))
      : null;
    const runtimeStates = deriveRuntimeStates({
      lifecycleStatus: status,
      sandboxId: sandboxId || null,
      runnerConnected,
      runnerBusy,
      queuedPrompts: queueLength,
    });

    return Response.json({
      sessionId,
      userId,
      workspace,
      status,
      lifecycleStatus: status,
      sandboxId: sandboxId || null,
      tunnelUrls: tunnelUrlsParsed,
      tunnels,
      runnerConnected,
      runnerBusy,
      agentState: runtimeStates.agentState,
      sandboxState: runtimeStates.sandboxState,
      jointState: runtimeStates.jointState,
      messageCount,
      queuedPrompts: queueLength,
      connectedClients: clientCount,
      connectedUsers,
      runningStartedAt: runningStartedAt || null,
    });
  }

  private notifyParentIfIdle() {
    const sessionId = this.sessionState.sessionId;
    if (!sessionId) return;
    const status = this.sessionState.status;
    if (status !== 'running') return;
    const runnerBusy = this.promptQueue.runnerBusy;
    const queued = this.promptQueue.length;
    if (runnerBusy || queued > 0) return;

    const last = this.sessionState.lastParentIdleNotice;
    if (last === 'true') return;
    const existing = this.sessionState.parentIdleNotifyAt;
    if (existing) return; // debounce already pending
    this.sessionState.parentIdleNotifyAt = Date.now() + PARENT_IDLE_DEBOUNCE_MS;
    this.rescheduleIdleAlarm();
  }

  private async notifyParentEvent(content: string, options?: { wake?: boolean; childStatus?: string }) {
    try {
      const sessionId = this.sessionState.sessionId;
      if (!sessionId) return;
      const session = await getSession(this.appDb, sessionId);
      const parentSessionId = session?.parentSessionId;
      if (!parentSessionId) return;
      const childTitle = session?.title || session?.workspace || `Child ${sessionId.slice(0, 8)}`;
      const parentThreadId = this.sessionState.parentThreadId;
      const parentDoId = this.env.SESSIONS.idFromName(parentSessionId);
      const parentDO = this.env.SESSIONS.get(parentDoId);
      await parentDO.fetch(new Request('http://do/system-message', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          content,
          parts: {
            systemTitle: childTitle,
            systemAvatarKey: 'child-session',
            childSessionId: sessionId,
            childStatus: options?.childStatus,
          },
          wake: options?.wake ?? true,
          threadId: parentThreadId,
        }),
      }));
    } catch (err) {
      console.error('[SessionAgentDO] Failed to notify parent session:', err);
    }
  }

  private async handleSystemMessage(content: string, parts?: Record<string, unknown>, wake?: boolean, threadId?: string) {
    const messageId = crypto.randomUUID();
    const serializedParts = parts ? JSON.stringify(parts) : null;

    this.messageStore.writeMessage({
      id: messageId,
      role: 'system',
      content,
      parts: serializedParts,
      threadId,
    });

    this.broadcastToClients({
      type: 'message',
      data: {
        id: messageId,
        role: 'system',
        content,
        parts: parts || undefined,
        ...(threadId ? { threadId } : {}),
        createdAt: Math.floor(Date.now() / 1000),
      },
    });

    if (wake) {
      // Check wait subscription filter — if the agent registered a subscription
      // via wait_for_event, only wake for matching child events.
      const sub = this.sessionState.waitSubscription;
      if (sub && parts?.childSessionId) {
        const childId = parts.childSessionId as string;
        const childStatus = parts.childStatus as string | undefined;
        const terminalStatuses = new Set(['terminated', 'error', 'hibernated']);
        const notifyOn = sub.notifyOn || 'terminal';

        // Session ID filter
        if (sub.sessionIds?.length && !sub.sessionIds.includes(childId)) {
          console.log(`[SessionAgentDO] Wait subscription: ignoring event from ${childId} (not in watched list)`);
          return;
        }

        // Status filter (explicit statuses override notifyOn)
        if (sub.statuses?.length) {
          if (!childStatus || !sub.statuses.includes(childStatus)) {
            console.log(`[SessionAgentDO] Wait subscription: ignoring ${childStatus} (not in ${sub.statuses.join(',')})`);
            return;
          }
        } else if (notifyOn === 'terminal') {
          if (!childStatus || !terminalStatuses.has(childStatus)) {
            console.log(`[SessionAgentDO] Wait subscription: ignoring non-terminal status ${childStatus}`);
            return;
          }
        }
        // notifyOn === 'status_change' — wake on any child event
      }

      // Normalize threadId → channel routing so system messages land in the
      // same OpenCode session as the thread that spawned the child. Without
      // this, child notifications resolve to 'web:default' instead of the
      // correct 'thread:<id>' session.
      let sysChannelType: string | undefined;
      let sysChannelId: string | undefined;
      if (threadId) {
        sysChannelType = 'thread';
        sysChannelId = threadId;
      }

      // Extract child metadata for queue-level filtering
      const queueChildSessionId = (parts?.childSessionId as string) || undefined;
      const queueChildStatus = (parts?.childStatus as string) || undefined;

      const status = this.sessionState.status;
      if (status === 'hibernated') {
        // Queue the prompt so the runner picks it up after connecting.
        this.promptQueue.enqueue({ id: messageId, content, threadId, channelType: sysChannelType, channelId: sysChannelId, childSessionId: queueChildSessionId, childStatus: queueChildStatus });
        this.ctx.waitUntil(this.performWake());
      } else if (status === 'restoring') {
        // Wake already in progress — just queue the prompt for when the runner connects.
        this.promptQueue.enqueue({ id: messageId, content, threadId, channelType: sysChannelType, channelId: sysChannelId, childSessionId: queueChildSessionId, childStatus: queueChildStatus });
      } else if (status === 'running') {
        // Dispatch the system event as a prompt so the runner wakes up and can
        // decide whether to act on it (e.g. child session idle/completed events).
        const runnerBusy = this.promptQueue.runnerBusy;
        if (this.runnerLink.isConnected && !runnerBusy) {
          // Runner is connected and idle — insert as 'processing' for recoverability, then dispatch
          this.promptQueue.enqueue({ id: messageId, content, threadId, channelType: sysChannelType, channelId: sysChannelId, status: 'processing', childSessionId: queueChildSessionId, childStatus: queueChildStatus });
          this.promptQueue.stampDispatched();
          this.sessionState.lastParentIdleNotice = undefined;
          this.sessionState.parentIdleNotifyAt = 0;
          this.sessionState.waitSubscription = null;
          const ownerId = this.sessionState.userId;
          const ownerDetails = ownerId ? await this.getUserDetails(ownerId) : undefined;
          const sysModelPrefs = await this.resolveModelPreferences(ownerDetails);
          const sysChannelKey = this.channelKeyFrom(sysChannelType, sysChannelId);
          const sysOcSessionId = this.getChannelOcSessionId(sysChannelKey);
          const sysDispatched = this.runnerLink.send({
            type: 'prompt',
            messageId,
            content,
            channelType: sysChannelType,
            channelId: sysChannelId,
            threadId: threadId || undefined,
            opencodeSessionId: sysOcSessionId,
            modelPreferences: sysModelPrefs,
          });
          if (!sysDispatched) {
            this.promptQueue.revertProcessingToQueued(messageId);
            this.promptQueue.runnerBusy = false;
            this.promptQueue.clearDispatchTimers();
            if (!this.promptQueue.idleQueuedSince) {
              this.promptQueue.idleQueuedSince = Date.now();
              this.rescheduleIdleAlarm();
            }
            this.emitAuditEvent('prompt.dispatch_failed', `System prompt dispatch failed, reverted: ${messageId.slice(0, 8)}`);
          }
          this.rescheduleIdleAlarm();
        } else {
          // Runner busy or not connected — queue the prompt
          this.promptQueue.enqueue({ id: messageId, content, threadId, channelType: sysChannelType, channelId: sysChannelId, childSessionId: queueChildSessionId, childStatus: queueChildStatus });
        }
      }
    }
  }

  private async handleWorkflowExecuteDispatch(
    executionIdRaw?: string,
    payload?: WorkflowExecutionDispatchPayload,
  ): Promise<Response> {
    const dispatchResult = buildWorkflowDispatch(executionIdRaw, payload);
    if (dispatchResult.error) {
      return Response.json({ error: dispatchResult.error.error }, { status: dispatchResult.error.status });
    }

    const { executionId, payload: validPayload } = dispatchResult.ready!;

    const status = this.sessionState.status;
    const queueWorkflowDispatch = (reason: string) => {
      const queueId = crypto.randomUUID();
      this.promptQueue.enqueue({
        id: queueId, content: '', queueType: 'workflow_execute',
        workflowExecutionId: executionId, workflowPayload: JSON.stringify(validPayload),
      });
      this.emitAuditEvent(
        'workflow.dispatch_queued',
        `Workflow execution queued (${executionId.slice(0, 8)}): ${reason}`,
        undefined,
        { executionId, kind: validPayload.kind, reason },
      );
      return Response.json({ success: true, queued: true, reason }, { status: 202 });
    };

    if (status === 'hibernated') {
      this.ctx.waitUntil(this.performWake());
      return queueWorkflowDispatch('session_hibernated_waking');
    }
    if (status === 'restoring' || status === 'initializing' || status === 'hibernating') {
      return queueWorkflowDispatch(`session_not_ready:${status}`);
    }

    if (!this.runnerLink.isConnected) {
      return queueWorkflowDispatch('runner_not_connected');
    }

    if (this.promptQueue.runnerBusy) {
      return queueWorkflowDispatch('runner_busy');
    }

    this.lifecycle.touchActivity();
    this.promptQueue.stampDispatched();
    this.rescheduleIdleAlarm();
    this.sessionState.lastParentIdleNotice = undefined;
    this.sessionState.parentIdleNotifyAt = 0;
    this.sessionState.waitSubscription = null;
    const dispatchOwnerId = this.sessionState.userId;
    const dispatchOwnerDetails = dispatchOwnerId ? await this.getUserDetails(dispatchOwnerId) : undefined;
    const dispatchModelPrefs = await this.resolveModelPreferences(dispatchOwnerDetails);

    const directWfDispatched = this.runnerLink.send({
      type: 'workflow-execute',
      executionId,
      payload: validPayload,
      modelPreferences: dispatchModelPrefs,
    });
    if (!directWfDispatched) {
      this.promptQueue.runnerBusy = false;
      return queueWorkflowDispatch('runner_send_failed');
    }

    this.emitAuditEvent(
      'workflow.dispatch',
      `Workflow execution dispatched (${executionId.slice(0, 8)})`,
      undefined,
      { executionId, kind: validPayload.kind },
    );

    return Response.json({ success: true });
  }

  private async sendNextQueuedPrompt(): Promise<boolean> {
    if (!this.runnerLink.isConnected) {
      console.log(`[SessionAgentDO] sendNextQueuedPrompt: no runner sockets, skipping`);
      return false;
    }

    // Dequeue loop: skip filtered child events and malformed entries without recursion.
    let prompt = this.promptQueue.dequeueNext();
    while (prompt) {
      console.log(`[SessionAgentDO] sendNextQueuedPrompt: found queued item id=${prompt.id} channelType=${prompt.channelType || 'none'} channelId=${prompt.channelId || 'none'} queueType=${prompt.queueType || 'prompt'}`);

      // Apply wait subscription filter to queued child events.
      // Events queued while the agent was busy may not match the subscription
      // the agent registered via wait_for_event — drop them and try the next entry.
      let shouldSkip = false;
      if (prompt.childSessionId) {
        const queueSub = this.sessionState.waitSubscription;
        if (queueSub) {
          const terminalStatuses = new Set(['terminated', 'error', 'hibernated']);
          const notifyOn = queueSub.notifyOn || 'terminal';

          if (queueSub.sessionIds?.length && !queueSub.sessionIds.includes(prompt.childSessionId)) {
            console.log(`[SessionAgentDO] sendNextQueuedPrompt: dropping child event from ${prompt.childSessionId} (not in watched list)`);
            shouldSkip = true;
          } else if (queueSub.statuses?.length) {
            if (!prompt.childStatus || !queueSub.statuses.includes(prompt.childStatus)) {
              console.log(`[SessionAgentDO] sendNextQueuedPrompt: dropping child event ${prompt.childStatus} (not in ${queueSub.statuses.join(',')})`);
              shouldSkip = true;
            }
          } else if (notifyOn === 'terminal') {
            if (!prompt.childStatus || !terminalStatuses.has(prompt.childStatus)) {
              console.log(`[SessionAgentDO] sendNextQueuedPrompt: dropping non-terminal child event ${prompt.childStatus}`);
              shouldSkip = true;
            }
          }
        }
      }

      // Drop malformed workflow entries
      if (!shouldSkip && prompt.queueType === 'workflow_execute') {
        const queuedExecutionId = (prompt.workflowExecutionId || '').trim();
        const queuedPayload = parseQueuedWorkflowPayload(prompt.workflowPayload);
        if (!queuedExecutionId || !queuedPayload) {
          console.warn(`[SessionAgentDO] Dropping malformed queued workflow dispatch id=${prompt.id}`);
          shouldSkip = true;
        }
      }

      if (shouldSkip) {
        this.promptQueue.dropEntry(prompt.id);
        prompt = this.promptQueue.dequeueNext();
        continue;
      }

      break;
    }

    if (!prompt) {
      console.log(`[SessionAgentDO] sendNextQueuedPrompt: no queued items`);
      return false;
    }

    if (prompt.queueType === 'workflow_execute') {
      const queuedExecutionId = (prompt.workflowExecutionId || '').trim();
      const queuedPayload = parseQueuedWorkflowPayload(prompt.workflowPayload)!;

      this.channelRouter.clearActiveChannel();
      this.promptQueue.stampDispatched();
      this.promptQueue.idleQueuedSince = 0;
      this.sessionState.lastParentIdleNotice = undefined;
      this.sessionState.parentIdleNotifyAt = 0;
      this.sessionState.waitSubscription = null;
      const queueOwnerId = this.sessionState.userId;
      const queueOwnerDetails = queueOwnerId ? await this.getUserDetails(queueOwnerId) : undefined;
      const queueModelPrefs = await this.resolveModelPreferences(queueOwnerDetails);
      const wfDispatched = this.runnerLink.send({
        type: 'workflow-execute',
        executionId: queuedExecutionId,
        payload: queuedPayload,
        modelPreferences: queueModelPrefs,
      });
      if (!wfDispatched) {
        this.promptQueue.revertProcessingToQueued(prompt.id);
        this.promptQueue.runnerBusy = false;
        if (!this.promptQueue.idleQueuedSince) {
          this.promptQueue.idleQueuedSince = Date.now();
        }
        this.emitAuditEvent('workflow.dispatch_failed', `Workflow dispatch failed, reverted to queue: ${queuedExecutionId.slice(0, 8)}`);
        return false;
      }
      this.broadcastToClients({
        type: 'status',
        data: { promptDequeued: true, remaining: this.promptQueue.length },
      });
      this.emitAuditEvent(
        'workflow.dispatch',
        `Workflow execution dispatched (${queuedExecutionId.slice(0, 8)})`,
        undefined,
        { executionId: queuedExecutionId, kind: queuedPayload.kind, queued: true },
      );
      return true;
    }

    // Look up git details from cache for the prompt author
    const authorId = prompt.authorId;
    const authorDetails = authorId ? this.userDetailsCache.get(authorId) : undefined;
    const { attachments } = parseQueuedPromptAttachments(prompt.attachments);

    // Track current prompt author for PR attribution
    if (authorId) {
      this.promptQueue.currentPromptAuthorId = authorId;
    }

    // Active channel is scoped to the current prompt cycle only.
    const queueChannelType = prompt.channelType || undefined;
    const queueChannelId = prompt.channelId || undefined;
    const queueThreadId = prompt.threadId || undefined;
    const queueReplyChannelType = prompt.replyChannelType || undefined;
    const queueReplyChannelId = prompt.replyChannelId || undefined;
    if (queueThreadId) {
      this.sessionState.currentThreadId = queueThreadId;
    }
    this.channelRouter.clearActiveChannel();
    if (queueReplyChannelType && queueReplyChannelId) {
      this.channelRouter.setActiveChannel({ channelType: queueReplyChannelType, channelId: queueReplyChannelId });
      this.insertChannelFollowup(queueReplyChannelType, queueReplyChannelId, prompt.content);
    } else if (queueThreadId) {
      const origin = await getThreadOriginChannel(this.env.DB, queueThreadId);
      if (origin && origin.channelType !== 'web' && origin.channelType !== 'thread') {
        this.channelRouter.setActiveChannel({ channelType: origin.channelType, channelId: origin.channelId });
        this.insertChannelFollowup(origin.channelType, origin.channelId, prompt.content);
      }
    }

    // Resolve model preferences from session owner (with org fallback)
    const queueOwnerId = this.sessionState.userId;
    const queueOwnerDetails = queueOwnerId ? await this.getUserDetails(queueOwnerId) : undefined;
    const queueModelPrefs = await this.resolveModelPreferences(queueOwnerDetails);
    const queueChannelKey = this.channelKeyFrom(queueChannelType, queueChannelId);
    const queueOcSessionId = this.getChannelOcSessionId(queueChannelKey);

    // Agent sees contextPrefix + content; stored messages only have the user's actual message
    const queueAgentContent = prompt.contextPrefix
      ? `${prompt.contextPrefix}\n\n${prompt.content}`
      : prompt.content;

    const queueDispatched = this.runnerLink.send({
      type: 'prompt',
      messageId: prompt.id,
      content: queueAgentContent,
      model: prompt.model || undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
      channelType: queueChannelType,
      channelId: queueChannelId,
      threadId: queueThreadId,
      replyChannelType: queueReplyChannelType !== queueChannelType ? queueReplyChannelType : undefined,
      replyChannelId: queueReplyChannelId !== queueChannelId ? queueReplyChannelId : undefined,
      authorId: authorId || undefined,
      authorEmail: prompt.authorEmail || undefined,
      authorName: prompt.authorName || undefined,
      gitName: authorDetails?.gitName,
      gitEmail: authorDetails?.gitEmail,
      opencodeSessionId: queueOcSessionId,
      modelPreferences: queueModelPrefs,
      continuationContext: prompt.continuationContext || undefined,
    });
    if (!queueDispatched) {
      this.promptQueue.revertProcessingToQueued(prompt.id);
      this.channelRouter.clearActiveChannel();
      this.emitAuditEvent('prompt.dispatch_failed', `Queue dispatch failed, reverted: ${prompt.id.slice(0, 8)}`);
      return false;
    }
    this.promptQueue.stampDispatched();
    this.promptQueue.idleQueuedSince = 0;
    this.sessionState.lastParentIdleNotice = undefined;
    this.sessionState.parentIdleNotifyAt = 0;
    this.sessionState.waitSubscription = null;
    this.rescheduleIdleAlarm();

    // Emit queue_wait timing — measure how long the prompt waited before dispatch
    const queuedAt = this.promptQueue.promptReceivedAt;
    if (queuedAt > 0) {
      this.emitEvent('queue_wait', {
        durationMs: Date.now() - queuedAt,
        channel: queueChannelType || undefined,
      });
    }

    this.broadcastToClients({
      type: 'status',
      data: { promptDequeued: true, remaining: this.promptQueue.length },
    });
    return true;
  }

  /**
   * HTTP endpoint: returns messages from this DO's local SQLite.
   * Used by other DOs for cross-session message reads.
   * Query params: limit (default 20), after (ISO timestamp cursor)
   */
  private handleMessagesEndpoint(url: URL): Response {
    const limit = parseInt(url.searchParams.get('limit') || '5000', 10);
    const after = url.searchParams.get('after');
    const threadId = url.searchParams.get('threadId');
    const sessionId = this.sessionState.sessionId;

    const afterCreatedAt = after != null ? parseInt(after, 10) : undefined;
    const rows = this.messageStore.getMessages({
      limit,
      ...(afterCreatedAt !== undefined ? { afterCreatedAt } : {}),
      ...(threadId ? { threadId } : {}),
    });

    const messages = rows.map((r) => ({
      id: r.id,
      sessionId,
      role: r.role,
      content: r.content,
      parts: r.parts ? JSON.parse(r.parts) : undefined,
      authorId: r.authorId || undefined,
      authorEmail: r.authorEmail || undefined,
      authorName: r.authorName || undefined,
      authorAvatarUrl: r.authorAvatarUrl || undefined,
      channelType: r.channelType || undefined,
      channelId: r.channelId || undefined,
      threadId: r.threadId || undefined,
      createdAt: new Date(r.createdAt * 1000).toISOString(),
    }));

    return Response.json({ messages });
  }


  private async handleClearQueue(): Promise<Response> {
    const cleared = this.promptQueue.clearQueued();

    this.broadcastToClients({
      type: 'status',
      data: { queueCleared: true, cleared },
    });

    return Response.json({ success: true, cleared });
  }

  private async handleFlushMetrics(): Promise<Response> {
    await this.flushMetrics();
    return Response.json({ success: true });
  }

  private async handleGarbageCollect(): Promise<Response> {
    try {
      await this.flushMetrics();
    } catch (err) {
      console.error('[SessionAgentDO] Failed to flush metrics during GC:', err);
    }
    await this.ctx.storage.deleteAll();
    return Response.json({ success: true });
  }

  private async handleProxy(request: Request, url: URL): Promise<Response> {
    const tunnelUrls = this.sessionState.tunnelUrls;
    if (!tunnelUrls) {
      return Response.json({ error: 'Sandbox not running' }, { status: 503 });
    }
    // Route through gateway's /opencode proxy to avoid Modal encrypted tunnel issues
    // on the direct OpenCode port. Fall back to direct opencode URL if gateway not available.
    const gatewayUrl = tunnelUrls.gateway;
    const opencodeUrl = tunnelUrls.opencode;
    const baseUrl = gatewayUrl ? `${gatewayUrl}/opencode` : opencodeUrl;
    if (!baseUrl) {
      return Response.json({ error: 'OpenCode URL not available' }, { status: 503 });
    }

    // Strip /proxy prefix
    const proxyPath = url.pathname.replace(/^\/proxy/, '') + url.search;
    const proxyUrl = baseUrl + proxyPath;

    try {
      const resp = await fetch(proxyUrl, {
        method: request.method,
        body: request.body,
      });
      return resp;
    } catch (error) {
      console.error('[SessionAgentDO] Proxy error:', proxyUrl, error);
      return Response.json({ error: 'Failed to reach sandbox' }, { status: 502 });
    }
  }

  // ─── Webhook Update Handler ────────────────────────────────────────────

  private async handleWebhookUpdate(request: Request): Promise<Response> {
    try {
      const body = await request.json() as {
        type: string;
        prState?: string;
        prTitle?: string;
        prUrl?: string;
        prMergedAt?: string | null;
        commitCount?: number;
        branch?: string;
      };

      // Broadcast git-state update to all connected clients
      this.broadcastToClients({
        type: 'git-state',
        data: {
          ...(body.prState !== undefined && { prState: body.prState }),
          ...(body.prTitle !== undefined && { prTitle: body.prTitle }),
          ...(body.prUrl !== undefined && { prUrl: body.prUrl }),
          ...(body.prMergedAt !== undefined && { prMergedAt: body.prMergedAt }),
          ...(body.commitCount !== undefined && { commitCount: body.commitCount }),
          ...(body.branch !== undefined && { branch: body.branch }),
        },
      });

      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    } catch (err) {
      return new Response(JSON.stringify({ error: 'Invalid request' }), { status: 400 });
    }
  }

  // ─── Hibernate / Wake ──────────────────────────────────────────────────

  private async handleHibernate(): Promise<Response> {
    const status = this.sessionState.status;

    if (status === 'hibernated' || status === 'hibernating') {
      return Response.json({ status, message: 'Already hibernated or hibernating' });
    }

    if (status !== 'running') {
      return Response.json({ status, message: 'Can only hibernate a running session' });
    }

    this.sessionState.status = 'hibernating';
    this.ctx.waitUntil(this.performHibernate());
    return Response.json({ status: 'hibernating', message: 'Hibernate initiated' });
  }

  private async handleWake(): Promise<Response> {
    const status = this.sessionState.status;

    if (status === 'running' || status === 'restoring') {
      return Response.json({ status, message: 'Already running or restoring' });
    }

    if (status === 'hibernated') {
      this.ctx.waitUntil(this.performWake());
      return Response.json({ status: 'restoring', message: 'Restore initiated' });
    }

    return Response.json({ status, message: 'Cannot wake from current status' });
  }

  private async performHibernate(): Promise<void> {
    const sessionId = this.sessionState.sessionId;

    // Concurrency guard — prevents duplicate hibernate calls from overlapping alarms.
    // The alarm handler sets status to 'hibernating' before ctx.waitUntil(performHibernate()),
    // so subsequent alarm ticks will see a non-running status and skip.
    const currentStatus = this.sessionState.status;
    if (currentStatus !== 'hibernating') {
      console.log(`[SessionAgentDO] performHibernate skipped — status is ${currentStatus}`);
      return;
    }

    if (!this.sessionState.sandboxId || !this.sessionState.hibernateUrl) {
      console.error('[SessionAgentDO] Cannot hibernate: missing sandboxId or hibernateUrl');
      this.sessionState.status = 'running';
      return;
    }

    try {
      // Flush active time and metrics to D1 before snapshot kills the sandbox
      await this.flushActiveSeconds();
      this.lifecycle.clearRunningStarted();
      await this.flushMetrics();

      // Status already set to 'hibernating' by alarm handler — broadcast to clients
      this.broadcastToClients({ type: 'status', data: { status: 'hibernating' } });
      if (sessionId) {
        updateSessionStatus(this.appDb, sessionId, 'hibernating').catch((e) =>
          console.error('[SessionAgentDO] Failed to sync hibernating status to D1:', e),
        );
      }

      // Snapshot via lifecycle (pure HTTP)
      const result = await this.lifecycle.snapshotSandbox();

      // Stop runner AFTER snapshot — ordering enforced by call sequence
      this.runnerLink.send({ type: 'stop' });
      const runnerSockets = this.ctx.getWebSockets('runner');
      for (const ws of runnerSockets) {
        try { ws.close(1000, 'Session hibernating'); } catch { /* ignore */ }
      }

      // State writes from result
      this.sessionState.snapshotImageId = result.snapshotImageId;
      this.sessionState.sandboxId = undefined;
      this.sessionState.tunnelUrls = null;
      this.sessionState.tunnels = [];
      this.promptQueue.runnerBusy = false;
      this.sessionState.status = 'hibernated';

      this.broadcastToClients({
        type: 'status',
        data: { status: 'hibernated', sandboxRunning: false },
      });
      if (sessionId) {
        updateSessionStatus(this.appDb, sessionId, 'hibernated').catch((e) =>
          console.error('[SessionAgentDO] Failed to sync hibernated status to D1:', e),
        );
      }

      this.emitAuditEvent('session.hibernated', 'Session hibernated');
      console.log(`[SessionAgentDO] Session ${sessionId} hibernated, snapshot: ${result.snapshotImageId}`);

      this.promptQueue.revertProcessingToQueued();

      // Auto-wake if prompts arrived during snapshot window
      const queuedDuringHibernate = this.promptQueue.length;
      if (queuedDuringHibernate > 0) {
        console.log(`[SessionAgentDO] ${queuedDuringHibernate} prompt(s) queued during hibernation — auto-waking`);
        this.ctx.waitUntil(this.performWake());
      }
    } catch (err) {
      // 409: sandbox already exited — route through proper termination
      if (err instanceof SandboxAlreadyExitedError) {
        console.log(`[SessionAgentDO] Session ${sessionId} sandbox already finished — routing to handleStop`);
        await this.handleStop('sandbox_exited');
        return;
      }

      if (err instanceof SandboxSnapshotFailedError) {
        console.warn(`[SessionAgentDO] Session ${sessionId} snapshot failed — terminating instead: ${err.message}`);
        // The sandbox is still alive (snapshot_and_terminate only calls terminate on
        // success). Terminate it explicitly before routing through handleStop.
        // Don't reset status to 'running' — active time was already flushed at the top
        // of performHibernate(), and faking 'running' would double-flush active seconds.
        await this.lifecycle.terminateSandbox();
        await this.handleStop('snapshot_failed');
        return;
      }

      console.error(`[SessionAgentDO] Failed to hibernate session ${sessionId}:`, err);
      const errorText = `Failed to hibernate: ${err instanceof Error ? err.message : String(err)}`;
      this.sessionState.status = 'error';
      if (sessionId) {
        updateSessionStatus(this.appDb, sessionId, 'error', undefined, errorText).catch((e) =>
          console.error('[SessionAgentDO] Failed to sync error status to D1:', e),
        );
      }
      const errId = crypto.randomUUID();
      this.messageStore.writeMessage({
        id: errId,
        role: 'system',
        content: `Error: ${errorText}`,
      });
      this.broadcastToClients({ type: 'status', data: { status: 'error' } });
      this.broadcastToClients({ type: 'error', messageId: errId, error: errorText });
    }
  }

  private async performWake(): Promise<void> {
    // Concurrency guard — prevents duplicate wake calls
    const currentStatus = this.sessionState.status;
    if (currentStatus === 'restoring' || currentStatus === 'running') {
      console.log(`[SessionAgentDO] performWake skipped — already ${currentStatus}`);
      return;
    }

    const sessionId = this.sessionState.sessionId;

    if (!this.sessionState.snapshotImageId || !this.sessionState.restoreUrl || !this.sessionState.spawnRequest) {
      const errorText = 'Cannot wake: missing snapshotImageId, restoreUrl, or spawnRequest';
      console.error(`[SessionAgentDO] ${errorText}`);
      this.sessionState.status = 'error';
      if (sessionId) {
        updateSessionStatus(this.appDb, sessionId, 'error', undefined, errorText).catch((e) =>
          console.error('[SessionAgentDO] Failed to sync error status to D1:', e),
        );
      }
      this.broadcastToClients({ type: 'status', data: { status: 'error' } });
      this.broadcastToClients({ type: 'error', error: errorText });
      return;
    }

    const snapshotId = this.sessionState.snapshotImageId;

    try {
      // Intermediate status — also acts as concurrency guard
      this.sessionState.status = 'restoring';
      this.broadcastToClients({ type: 'status', data: { status: 'restoring' } });
      if (sessionId) {
        updateSessionStatus(this.appDb, sessionId, 'restoring').catch((e) =>
          console.error('[SessionAgentDO] Failed to sync restoring status to D1:', e),
        );
      }

      this.sessionState.sandboxWakeStartedAt = Date.now();

      // Restore via lifecycle (pure HTTP)
      const result = await this.lifecycle.restoreSandbox();

      this.emitEvent('sandbox_restore', {
        durationMs: result.durationMs,
        properties: { snapshot_id: snapshotId },
      });

      // State writes from result
      this.sessionState.sandboxId = result.sandboxId;
      this.sessionState.tunnelUrls = result.tunnelUrls;
      this.sessionState.snapshotImageId = undefined;
      this.sessionState.status = 'running';
      this.lifecycle.markRunningStarted();
      this.lifecycle.touchActivity();

      this.rescheduleIdleAlarm();

      if (sessionId) {
        updateSessionStatus(this.appDb, sessionId, 'running', result.sandboxId).catch((e) =>
          console.error('[SessionAgentDO] Failed to sync running status to D1:', e),
        );
      }

      this.broadcastToClients({
        type: 'status',
        data: {
          status: 'running',
          sandboxRunning: true,
          tunnelUrls: result.tunnelUrls,
        },
      });

      this.emitAuditEvent('session.restored', 'Session restored from hibernation');
      console.log(`[SessionAgentDO] Session ${sessionId} restored, new sandbox: ${result.sandboxId}`);
    } catch (err) {
      console.error(`[SessionAgentDO] Failed to restore session ${sessionId}:`, err);
      const errorText = `Failed to restore session: ${err instanceof Error ? err.message : String(err)}`;
      this.sessionState.status = 'error';
      if (sessionId) {
        updateSessionStatus(this.appDb, sessionId, 'error', undefined, errorText).catch((e) =>
          console.error('[SessionAgentDO] Failed to sync error status to D1:', e),
        );
      }
      const errId = crypto.randomUUID();
      this.messageStore.writeMessage({
        id: errId,
        role: 'system',
        content: `Error: ${errorText}`,
      });
      this.broadcastToClients({ type: 'status', data: { status: 'error' } });
      this.broadcastToClients({ type: 'error', messageId: errId, error: errorText });
    }
  }

  /**
   * Collect all subsystem-specific alarm deadlines. The lifecycle class
   * combines these with its own idle deadline in scheduleAlarm().
   */
  private collectAlarmDeadlines(): (number | null)[] {
    // Interactive prompt expiry
    const nextExpiry = this.ctx.storage.sql
      .exec(
        "SELECT MIN(expires_at) as next FROM interactive_prompts WHERE status = 'pending' AND expires_at IS NOT NULL"
      )
      .toArray();
    const promptExpiry = nextExpiry[0]?.next ? (nextExpiry[0].next as number) * 1000 : null;

    // Channel followup reminders
    const nextFollowup = this.ctx.storage.sql
      .exec("SELECT MIN(next_reminder_at) as next FROM channel_followups WHERE status = 'pending'")
      .toArray();
    const followupMs = (nextFollowup[0]?.next as number) || null;

    // Stuck-processing watchdog
    const dispatchMs = this.promptQueue.lastPromptDispatchedAt;
    const watchdog = dispatchMs > 0 ? dispatchMs + 5 * 60 * 1000 : null;

    // Error safety-net
    const safetyNet = this.promptQueue.errorSafetyNetAt || null;

    // Parent idle debounce
    const parentIdle = this.sessionState.parentIdleNotifyAt || null;

    // Runner disconnect grace period
    const gracePeriod = this.runnerDisconnectedAt
      ? this.runnerDisconnectedAt + SessionAgentDO.RUNNER_GRACE_PERIOD_MS
      : null;

    // Idle-queue-stuck watchdog (items queued with runnerBusy=false)
    const idleQueued = this.promptQueue.idleQueuedSince;
    const idleQueueDeadline = idleQueued > 0 ? idleQueued + 60 * 1000 : null;

    // Ready timeout (runner connected but never became ready).
    // Only schedule if the deadline is still in the future — once past,
    // the monitor emits the event and we don't need to re-arm.
    const connectedAt = this.runnerLink.connectedAt;
    const readyRaw = connectedAt && this.runnerLink.isConnected && !this.runnerLink.isReady
      ? connectedAt + 2 * 60 * 1000
      : null;
    const readyDeadline = readyRaw && readyRaw > Date.now() ? readyRaw : null;

    return [promptExpiry, followupMs, watchdog, safetyNet, parentIdle, gracePeriod, idleQueueDeadline, readyDeadline];
  }

  private rescheduleIdleAlarm(): void {
    this.lifecycle.scheduleAlarm(this.collectAlarmDeadlines());
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private getClientSockets(): WebSocket[] {
    // Get all websockets, then filter to client-tagged ones
    const all = this.ctx.getWebSockets();
    return all.filter((ws) => {
      const tags = this.ctx.getTags(ws);
      return tags.some((t) => t.startsWith('client:'));
    });
  }

  private broadcastToClients(message: ClientOutbound): void {
    const payload = JSON.stringify(message);
    for (const ws of this.getClientSockets()) {
      try {
        ws.send(payload);
      } catch {
        // Socket may be closed
      }
    }
  }

  private getConnectedUserIds(): string[] {
    return this.ctx.storage.sql
      .exec('SELECT user_id FROM connected_users ORDER BY connected_at ASC')
      .toArray()
      .map((row) => row.user_id as string);
  }

  private isUserConnected(userId: string): boolean {
    return this.getConnectedUserIds().includes(userId);
  }

  private sendToastToUser(userId: string, toast: {
    title: string;
    description?: string;
    variant?: 'default' | 'success' | 'error' | 'warning';
    duration?: number;
  }): void {
    const sockets = this.ctx.getWebSockets(`client:${userId}`);
    if (sockets.length === 0) return;

    const payload = JSON.stringify({
      type: 'toast',
      title: toast.title,
      description: toast.description,
      variant: toast.variant,
      duration: toast.duration,
    });
    for (const ws of sockets) {
      try {
        ws.send(payload);
      } catch {
        // Socket may be closed
      }
    }
  }

  private async getConnectedUsersWithDetails(): Promise<Array<{ id: string; name?: string; email?: string; avatarUrl?: string }>> {
    const userIds = this.getConnectedUserIds();

    // Backfill cache for any users missing after hibernation
    const uncachedIds = userIds.filter((id) => !this.userDetailsCache.has(id));
    if (uncachedIds.length > 0) {
      try {
        const users = await getUsersByIds(this.appDb, uncachedIds);
        for (const user of users) {
          this.userDetailsCache.set(user.id, {
            id: user.id,
            email: user.email,
            name: user.name || undefined,
            avatarUrl: user.avatarUrl || undefined,
            gitName: user.gitName || undefined,
            gitEmail: user.gitEmail || undefined,
            modelPreferences: user.modelPreferences,
          });
        }
      } catch (err) {
        console.error('Failed to backfill user details cache:', err);
      }
    }

    return userIds.map((id) => {
      const details = this.userDetailsCache.get(id);
      return {
        id,
        name: details?.name,
        email: details?.email,
        avatarUrl: details?.avatarUrl,
      };
    });
  }

  private notifyEventBus(event: {
    type: string;
    sessionId?: string;
    userId?: string;
    data: Record<string, unknown>;
    timestamp: string;
  }): void {
    // Fire-and-forget notification to EventBusDO
    try {
      const id = this.env.EVENT_BUS.idFromName('global');
      const stub = this.env.EVENT_BUS.get(id);
      stub.fetch(new Request('https://event-bus/publish', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: event.userId,
          event,
        }),
      })).catch(() => {
        // Ignore EventBus errors — non-critical
      });
    } catch {
      // EventBus not available
    }
  }

  private async enqueueOwnerNotification(params: {
    messageType?: 'notification' | 'question' | 'escalation' | 'approval';
    eventType?: string;
    content: string;
    contextSessionId?: string;
    contextTaskId?: string;
    replyToId?: string;
  }): Promise<void> {
    const toUserId = this.sessionState.userId;
    if (!toUserId) return;

    const normalizedContent = params.content.trim();
    if (!normalizedContent) return;

    try {
      const messageType = params.messageType || 'notification';
      const webEnabled = await isNotificationWebEnabled(
        this.env.DB,
        toUserId,
        messageType,
        params.eventType,
      );
      if (!webEnabled) return;

      await createMailboxMessage(this.appDb, {
        fromSessionId: this.sessionState.sessionId || undefined,
        toUserId,
        messageType,
        content: normalizedContent.slice(0, 10_000),
        contextSessionId: params.contextSessionId,
        contextTaskId: params.contextTaskId,
        replyToId: params.replyToId,
      });
    } catch (err) {
      console.error('[SessionAgentDO] Failed to enqueue owner notification:', err);
    }
  }

  /**
   * Flush accumulated active seconds to D1.
   * Delegates elapsed-time computation to lifecycle, handles D1 write here.
   */
  private async flushActiveSeconds(): Promise<void> {
    const seconds = this.lifecycle.flushActiveSeconds();
    if (seconds > 0) {
      const sessionId = this.sessionState.sessionId;
      if (sessionId) {
        try {
          await addActiveSeconds(this.appDb, sessionId, seconds);
        } catch (err) {
          console.error('[SessionAgentDO] Failed to flush active seconds:', err);
        }
      }
    }
  }

  /**
   * Flush message/tool-call counts from local SQLite to D1.
   * Called at lifecycle boundaries (stop, hibernate, alarm) and after each agent turn.
   */
  private async flushMetrics(): Promise<void> {
    const sessionId = this.sessionState.sessionId;
    if (!sessionId) return;

    try {
      const msgRow = this.ctx.storage.sql
        .exec('SELECT COUNT(*) as count FROM messages')
        .toArray()[0];
      const toolRow = this.ctx.storage.sql
        .exec("SELECT COUNT(*) as count FROM messages WHERE role = 'tool'")
        .toArray()[0];

      const messageCount = (msgRow?.count as number) ?? 0;
      const toolCallCount = (toolRow?.count as number) ?? 0;

      await updateSessionMetrics(this.appDb, sessionId, { messageCount, toolCallCount });

      // Flush active seconds if currently running
      const status = this.sessionState.status;
      if (status === 'running') {
        await this.flushActiveSeconds();
      }

      // Flush unflushed analytics events to D1 (single path replacing audit_log + usage_events)
      const unflushed = this.ctx.storage.sql
        .exec('SELECT id, event_type, turn_id, duration_ms, channel, model, queue_mode, input_tokens, output_tokens, tool_name, error_code, summary, actor_id, properties, created_at FROM analytics_events WHERE flushed = 0 ORDER BY id ASC LIMIT 100')
        .toArray();

      if (unflushed.length > 0) {
        const userId = this.sessionState.userId || null;
        try {
          await batchInsertAnalyticsEvents(this.env.DB, sessionId, userId, unflushed.map((row) => ({
            id: `${sessionId}:${row.id as number}`,
            eventType: row.event_type as string,
            turnId: row.turn_id != null ? (row.turn_id as string) : undefined,
            durationMs: row.duration_ms != null ? (row.duration_ms as number) : undefined,
            channel: row.channel != null ? (row.channel as string) : undefined,
            model: row.model != null ? (row.model as string) : undefined,
            queueMode: row.queue_mode != null ? (row.queue_mode as string) : undefined,
            inputTokens: row.input_tokens != null ? (row.input_tokens as number) : undefined,
            outputTokens: row.output_tokens != null ? (row.output_tokens as number) : undefined,
            toolName: row.tool_name != null ? (row.tool_name as string) : undefined,
            errorCode: row.error_code != null ? (row.error_code as string) : undefined,
            summary: row.summary != null ? (row.summary as string) : undefined,
            actorId: row.actor_id != null ? (row.actor_id as string) : undefined,
            properties: row.properties != null ? (row.properties as string) : undefined,
            createdAt: new Date((row.created_at as number) * 1000).toISOString(),
          })));
          const flushedIds = unflushed.map((r) => r.id as number);
          const placeholders = flushedIds.map(() => '?').join(',');
          this.ctx.storage.sql.exec(
            `UPDATE analytics_events SET flushed = 1 WHERE id IN (${placeholders})`,
            ...flushedIds,
          );
        } catch (flushErr) {
          console.error('[SessionAgentDO] Failed to flush analytics events to D1:', flushErr);
        }
      }
    } catch (err) {
      console.error('[SessionAgentDO] flushMetrics failed:', err);
    }
  }

  /**
   * Emit a core analytics event to local SQLite. Fire-and-forget, never throws.
   */
  private emitEvent(
    eventType: string,
    fields?: {
      turnId?: string;
      durationMs?: number;
      channel?: string;
      model?: string;
      queueMode?: string;
      inputTokens?: number;
      outputTokens?: number;
      toolName?: string;
      errorCode?: string;
      summary?: string;
      actorId?: string;
      properties?: Record<string, unknown>;
    },
  ): void {
    try {
      this.ctx.storage.sql.exec(
        `INSERT INTO analytics_events
          (event_type, turn_id, duration_ms, channel, model, queue_mode,
           input_tokens, output_tokens, tool_name, error_code, summary, actor_id, properties)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        eventType,
        fields?.turnId ?? null,
        fields?.durationMs ?? null,
        fields?.channel ?? null,
        fields?.model ?? null,
        fields?.queueMode ?? null,
        fields?.inputTokens ?? null,
        fields?.outputTokens ?? null,
        fields?.toolName ?? null,
        fields?.errorCode ?? null,
        fields?.summary ?? null,
        fields?.actorId ?? null,
        fields?.properties ? JSON.stringify(fields.properties) : null,
      );
    } catch (err) {
      console.error('[SessionAgentDO] Failed to emit analytics event:', err);
    }
  }

  /**
   * Emit an audit event — writes to local SQLite AND broadcasts to connected clients.
   * Drop-in replacement for the old appendAuditLog method.
   */
  private emitAuditEvent(
    eventType: string,
    summary: string,
    actorId?: string,
    metadata?: Record<string, unknown>,
  ): void {
    this.emitEvent(eventType, {
      summary,
      actorId,
      properties: metadata,
    });
    // Broadcast to connected clients in real-time
    this.broadcastToClients({
      type: 'audit_log',
      entry: {
        eventType,
        summary,
        actorId: actorId || null,
        metadata: metadata || null,
        createdAt: new Date().toISOString(),
      },
    });
  }

  private async handleTunnelDelete(
    name: string,
    actor?: { actorId?: string; actorName?: string; actorEmail?: string },
  ) {
    if (!name) return;

    this.runnerLink.send({
      type: 'tunnel-delete',
      name,
      actorId: actor?.actorId,
      actorName: actor?.actorName,
      actorEmail: actor?.actorEmail,
    });

    const who = actor?.actorName || actor?.actorEmail || actor?.actorId || 'User';
    const summary = `${who} disabled tunnel "${name}"`;
    this.emitAuditEvent('tunnel.disabled', summary, actor?.actorId, { name });
    await this.handleSystemMessage(summary, { type: 'tunnel.disabled', name });
  }

  // ─── Phase D: Channel Reply Handler ──────────────────────────────────

  private async handleChannelReply(
    requestId: string,
    channelType: string,
    channelId: string,
    message: string,
    imageBase64?: string,       // kept for backward compat
    imageMimeType?: string,     // kept for backward compat
    followUp?: boolean,
    fileBase64?: string,        // new generic param
    fileMimeType?: string,      // new generic param
    fileName?: string,          // new generic param
  ) {
    try {
      const userId = this.sessionState.userId;
      if (!userId) {
        this.runnerLink.send({ type: 'channel-reply-result', requestId, error: 'No userId on session' } as any);
        return;
      }

      const result = await this.channelRouter.sendReply({
        userId,
        channelType,
        channelId,
        message,
        fileBase64,
        fileMimeType,
        fileName,
        imageBase64,
        imageMimeType,
        followUp,
      });

      if (!result.success) {
        this.runnerLink.send({ type: 'channel-reply-result', requestId, error: result.error } as any);
        return;
      }

      this.runnerLink.send({ type: 'channel-reply-result', requestId, success: true } as any);

      // Store image as a system message for web UI visibility.
      // TODO: Treat web UI as a channel. This is the primary remaining coupling
      // between channel dispatch and the DO's message/broadcast layer.
      if (imageBase64) {
        const msgId = crypto.randomUUID();
        const channelLabel = `Sent image to ${channelType}`;
        this.messageStore.writeMessage({
          id: msgId,
          role: 'system',
          content: message || channelLabel,
          parts: JSON.stringify({ type: 'image', data: imageBase64, mimeType: imageMimeType || 'image/jpeg' }),
          channelType,
          channelId,
        });
        this.broadcastToClients({
          type: 'message',
          data: {
            id: msgId,
            role: 'system',
            content: message || channelLabel,
            parts: { type: 'image', data: imageBase64, mimeType: imageMimeType || 'image/jpeg' },
            createdAt: Math.floor(Date.now() / 1000),
            channelType,
            channelId,
          },
        });
      }
    } catch (err) {
      this.runnerLink.send({
        type: 'channel-reply-result',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      } as any);
    }
  }

  // ─── Tool Discovery & Invocation ──────────────────────────────────────

  /** Adapter exposing the DO's credential cache as a CredentialCache interface. */
  private get credentialCacheAdapter(): CredentialCache {
    return {
      get: (ownerType, ownerId, service) => this.getCachedCredential(ownerType, ownerId, service),
      set: (ownerType, ownerId, service, result) => this.setCachedCredential(ownerType, ownerId, service, result),
      invalidate: (ownerType, ownerId, service) => this.invalidateCachedCredential(ownerType, ownerId, service),
    };
  }

  private async handleListTools(requestId: string, service?: string, query?: string) {
    try {
      const userId = this.sessionState.userId;
      if (!userId) {
        this.runnerLink.send({ type: 'list-tools-result', requestId, error: 'No userId on session' } as any);
        return;
      }

      const result = await listToolsSvc(this.appDb, this.env.DB, this.env, userId, {
        service,
        query,
        credentialCache: this.credentialCacheAdapter,
      });

      // Update DO-level caches from service result
      for (const [key, value] of result.discoveredRiskLevels) {
        this.discoveredToolRiskLevels.set(key, value);
      }
      this.disabledPluginServicesCache = {
        services: result.disabledPluginServices,
        expiresAt: Date.now() + SessionAgentDO.DISABLED_PLUGINS_CACHE_TTL_MS,
      };

      this.runnerLink.send({
        type: 'list-tools-result',
        requestId,
        tools: result.tools,
        ...(result.warnings.length > 0 ? {
          warnings: result.warnings.map(({ integrationId: _, ...rest }) => rest),
        } : {}),
      } as any);

      // Broadcast reauth-required event to connected frontend clients
      if (result.warnings.length > 0) {
        this.broadcastToClients({
          type: 'integration-auth-required',
          services: result.warnings.map((w) => ({
            service: w.service,
            displayName: w.displayName,
            reason: w.reason,
          })),
        });

        // Fire-and-forget: mark integrations as 'error' in D1 only for definitive failures
        // (not transient ones like refresh_failed which may succeed on retry)
        const definitiveFailures = result.warnings.filter((w) => w.reason === 'revoked' || w.reason === 'not_found');
        if (definitiveFailures.length > 0) {
          this.ctx.waitUntil(
            (async () => {
              try {
                for (const w of definitiveFailures) {
                  await updateIntegrationStatus(this.appDb, w.integrationId, 'error', w.message);
                }
              } catch (err) {
                console.warn('[SessionAgentDO] list-tools: failed to update integration status in D1:', err);
              }
            })(),
          );
        }
      }
    } catch (err) {
      this.runnerLink.send({
        type: 'list-tools-result',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      } as any);
    }
  }

  private async handleCallTool(requestId: string, toolId: string, params: Record<string, unknown>, summary?: string) {
    try {
      const userId = this.sessionState.userId;
      const sessionId = this.sessionState.sessionId;
      if (!userId) {
        this.runnerLink.send({ type: 'call-tool-result', requestId, error: 'No userId on session' } as any);
        return;
      }

      // Resolve policy (validates toolId, checks disabled status, resolves risk level)
      const policyResult = await resolveActionPolicy(this.appDb, this.env.DB, this.env, userId, toolId, params, {
        sessionId: sessionId || '',
        discoveredToolRiskLevels: this.discoveredToolRiskLevels,
        credentialCache: this.credentialCacheAdapter,
        disabledPluginServicesCache: this.disabledPluginServicesCache,
      });

      // Update the disabled plugin services cache from the policy resolution
      this.disabledPluginServicesCache = policyResult.disabledPluginServicesCache;

      const { outcome, invocationId, riskLevel, service, actionId, isOrgScoped, actionSource } = policyResult;

      // ─── Deny ──────────────────────────────────────────────────────────
      if (outcome === 'denied') {
        this.runnerLink.send({ type: 'call-tool-result', requestId, error: `Action "${toolId}" denied by policy (risk level: ${riskLevel})` } as any);
        this.emitAuditEvent('agent.tool_call', `Action ${toolId} denied by policy`, undefined, { invocationId, riskLevel });
        return;
      }

      // ─── Require Approval ──────────────────────────────────────────────
      if (outcome === 'pending_approval') {
        if (!summary) {
          this.runnerLink.send({
            type: 'call-tool-result',
            requestId,
            error: `Action "${toolId}" requires approval but no summary was provided. The call_tool summary parameter is required.`,
          } as any);
          return;
        }

        const expiresAt = Math.floor(Date.now() / 1000) + Math.floor(ACTION_APPROVAL_EXPIRY_MS / 1000);

        const approvalContext: Record<string, unknown> = {
          toolId,
          service,
          actionId,
          params,
          riskLevel,
          isOrgScoped,
          invocationId: invocationId,
          summary,
        };
        const approvalCh = this.activeChannel;
        if (approvalCh) {
          approvalContext.channelType = approvalCh.channelType;
          approvalContext.channelId = approvalCh.channelId;
        }

        // Use model-provided summary as the approval body
        const approvalBody = summary;

        // Store in interactive_prompts for alarm-based expiry and later execution
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO interactive_prompts
            (id, type, request_id, title, body, actions, context, status, expires_at)
           VALUES (?, 'approval', ?, ?, ?, ?, ?, 'pending', ?)`,
          invocationId,
          requestId,
          'Action requires approval',
          approvalBody,
          JSON.stringify([
            { id: 'approve', label: 'Approve', style: 'primary' },
            { id: 'deny', label: 'Deny', style: 'danger' },
          ]),
          JSON.stringify(approvalContext),
          expiresAt,
        );

        // Notify runner to extend its timeout
        this.runnerLink.send({
          type: 'call-tool-pending',
          requestId,
          invocationId: invocationId,
          message: `Action "${toolId}" requires approval (risk level: ${riskLevel}). Waiting for human review.`,
        } as any);

        const prompt: InteractivePrompt = {
          id: invocationId,
          sessionId: sessionId || '',
          type: 'approval',
          title: 'Action requires approval',
          body: approvalBody,
          actions: [
            { id: 'approve', label: 'Approve', style: 'primary' },
            { id: 'deny', label: 'Deny', style: 'danger' },
          ],
          expiresAt: expiresAt * 1000,
          context: approvalContext,
        };

        // Broadcast to connected clients
        this.broadcastToClients({
          type: 'interactive_prompt',
          prompt,
        });

        // Publish to EventBus
        this.notifyEventBus({
          type: 'action.approval_required',
          sessionId,
          userId,
          data: {
            invocationId: invocationId,
            toolId,
            service,
            actionId,
            riskLevel,
          },
          timestamp: new Date().toISOString(),
        });

        this.emitAuditEvent('agent.tool_call', `Action ${toolId} requires approval (${riskLevel})`, undefined, { invocationId: invocationId, riskLevel });

        // Fire-and-forget: send interactive prompts to all bound channels
        this.ctx.waitUntil(
          this.sendChannelInteractivePrompts(invocationId, prompt)
        );

        // Schedule alarm for expiry
        await this.ensureActionExpiryAlarm(expiresAt * 1000);

        return; // Don't send call-tool-result — the runner will wait
      }

      // ─── Allow — execute immediately ───────────────────────────────────
      await this.executeActionAndSend(requestId, toolId, service, actionId, params, isOrgScoped, userId, actionSource, invocationId);
    } catch (err) {
      this.runnerLink.send({
        type: 'call-tool-result',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      } as any);
    }
  }

  /**
   * Execute an integration action via the service and send the result to the runner.
   * Shared between immediate execution and post-approval execution.
   */
  private async executeActionAndSend(
    requestId: string,
    toolId: string,
    service: string,
    actionId: string,
    params: Record<string, unknown>,
    isOrgScoped: boolean,
    userId: string,
    actionSource: ReturnType<typeof integrationRegistry.getActions>,
    invocationId: string,
  ) {
    const spawnRequest = this.sessionState.spawnRequest;
    const spawnEnvVars = spawnRequest?.envVars as Record<string, string> | undefined;

    const result = await executeActionSvc(
      this.appDb, this.env, userId, toolId, service, actionId, params,
      isOrgScoped, actionSource, invocationId,
      { credentialCache: this.credentialCacheAdapter, spawnEnvVars },
    );

    // Emit tool_exec timing event
    this.emitEvent('tool_exec', {
      toolName: toolId,
      durationMs: result.durationMs,
      errorCode: result.success ? undefined : 'action_failed',
    });

    // Flush plugin analytics events
    for (const event of result.analyticsEvents) {
      this.emitEvent(event.eventType, {
        durationMs: event.durationMs,
        properties: event.properties,
      });
    }

    // Send result to runner
    if (!result.success) {
      this.runnerLink.send({ type: 'call-tool-result', requestId, error: result.error || 'Action failed' } as any);
    } else {
      this.runnerLink.send({ type: 'call-tool-result', requestId, result: result.data } as any);
    }
  }

  /**
   * Unified handler for resolving any interactive prompt (approval or question).
   */
  private async handlePromptResolved(promptId: string, resolution: InteractiveResolution) {
    // Read from interactive_prompts
    const rows = this.ctx.storage.sql
      .exec("SELECT * FROM interactive_prompts WHERE id = ? AND status = 'pending'", promptId)
      .toArray();

    if (rows.length === 0) {
      console.warn(`[SessionAgentDO] handlePromptResolved: no pending prompt found for ${promptId}`);
      return;
    }

    const row = rows[0];
    const promptType = row.type as string;
    const promptTitle = (row.title as string) || '';
    const requestId = row.request_id as string | null;
    const context = row.context ? JSON.parse(row.context as string) : {};
    const channelRefsJson = (row.channel_refs as string) || null;

    // Resolve actionId → human-readable label from the stored actions list
    let actionLabel: string | undefined;
    if (resolution.actionId && row.actions) {
      try {
        const actions = JSON.parse(row.actions as string) as Array<{ id: string; label: string }>;
        const match = actions.find(a => a.id === resolution.actionId);
        if (match) actionLabel = match.label;
      } catch { /* best-effort */ }
    }

    // Delete the row
    this.ctx.storage.sql.exec('DELETE FROM interactive_prompts WHERE id = ?', promptId);

    const userId = this.sessionState.userId;
    const sessionId = this.sessionState.sessionId;

    if (promptType === 'approval') {
      const toolId = context.toolId || '';
      const service = context.service || '';
      const actionId = context.actionId || '';
      const params = context.params || {};
      const isOrgScoped = !!context.isOrgScoped;

      if (resolution.actionId === 'approve') {
        if (!userId) {
          if (requestId) {
            this.runnerLink.send({ type: 'call-tool-result', requestId, error: 'No userId on session' } as any);
          }
          // Still update channel messages before returning
          if (channelRefsJson) {
            this.ctx.waitUntil(
              this.updateChannelInteractivePrompts(channelRefsJson, { ...resolution, resolvedBy: 'system' })
            );
          }
          return;
        }

        // Update D1 status to approved
        await approveInvocation(this.appDb, promptId, userId);

        const actionSource = integrationRegistry.getActions(service);
        if (requestId) {
          await this.executeActionAndSend(requestId, toolId, service, actionId, params, isOrgScoped, userId, actionSource, promptId);
        }

        // Broadcast approval to clients
        this.broadcastToClients({
          type: 'interactive_prompt_resolved',
          promptId,
          promptType,
          resolution,
          context,
        });

        // Publish to EventBus
        this.notifyEventBus({
          type: 'action.approved',
          sessionId,
          userId,
          data: { invocationId: promptId, toolId, service, actionId },
          timestamp: new Date().toISOString(),
        });

        this.emitAuditEvent('agent.tool_call', `Action ${toolId} approved and executed`, undefined, { invocationId: promptId });
      } else {
        // Deny
        const reason = resolution.value;
        await denyInvocation(this.appDb, promptId, userId || 'system', reason);

        // Send error to runner
        const errorMsg = reason
          ? `Action "${toolId}" was denied: ${reason}`
          : `Action "${toolId}" was denied by a reviewer`;
        if (requestId) {
          this.runnerLink.send({ type: 'call-tool-result', requestId, error: errorMsg } as any);
        }

        // Broadcast denial to clients
        this.broadcastToClients({
          type: 'interactive_prompt_resolved',
          promptId,
          promptType,
          resolution,
          context,
        });

        // Publish to EventBus
        this.notifyEventBus({
          type: 'action.denied',
          sessionId,
          userId,
          data: { invocationId: promptId, toolId, service, actionId, reason },
          timestamp: new Date().toISOString(),
        });

        this.emitAuditEvent('agent.tool_call', `Action ${toolId} denied${reason ? `: ${reason}` : ''}`, undefined, { invocationId: promptId });
      }
    } else if (promptType === 'question') {
      // Send answer to runner — use the human-readable label when available
      const answer = actionLabel || resolution.value || resolution.actionId || '';
      this.runnerLink.send({
        type: 'answer',
        questionId: promptId,
        answer,
      });

      // Broadcast resolution to clients
      this.broadcastToClients({
        type: 'interactive_prompt_resolved',
        promptId,
        promptType,
        resolution,
      });

      this.emitAuditEvent('user.answer', `Answered question: ${String(answer).slice(0, 80)}`, undefined, { questionId: promptId });

      // Notify EventBus
      this.notifyEventBus({
        type: 'question.answered',
        sessionId,
        data: { questionId: promptId, answer: String(answer) },
        timestamp: new Date().toISOString(),
      });
    }

    // Resolve display name and update channel messages
    if (channelRefsJson) {
      // Enrich resolution with label, title, and display name
      let displayResolution: InteractiveResolution = {
        ...resolution,
        ...(actionLabel ? { actionLabel } : {}),
        ...(promptTitle ? { promptTitle } : {}),
      };
      if (resolution.resolvedBy && userId) {
        try {
          const user = await getUserById(this.appDb, resolution.resolvedBy);
          if (user?.name) {
            displayResolution = { ...displayResolution, resolvedBy: user.name };
          } else if (user?.email) {
            displayResolution = { ...displayResolution, resolvedBy: user.email };
          }
        } catch { /* best-effort */ }
      }

      this.ctx.waitUntil(
        this.updateChannelInteractivePrompts(channelRefsJson, displayResolution)
      );
    }
  }

  private async sendChannelInteractivePrompts(promptId: string, prompt: InteractivePrompt) {
    try {
      const sessionId = this.sessionState.sessionId;
      const userId = this.sessionState.userId;
      if (!sessionId || !userId) return;

      const targets: Array<{ channelType: string; channelId: string }> = [];
      const seen = new Set<string>();

      // 1. Origin target: the channel stored in the approval context at creation time
      //    (set from activeChannel when the approval was created)
      const originTarget = this.getPromptOriginTarget(prompt.context);
      if (originTarget && originTarget.channelType !== 'web') {
        const key = `${originTarget.channelType}:${originTarget.channelId}`;
        seen.add(key);
        targets.push(originTarget);
      }

      // 2. Caller target: the currently active channel (may differ from origin
      //    if a different Slack thread is subscribed to the same orchestrator thread)
      const callerTarget = this.activeChannel;
      if (callerTarget && callerTarget.channelType !== 'web') {
        const key = `${callerTarget.channelType}:${callerTarget.channelId}`;
        if (!seen.has(key)) {
          seen.add(key);
          targets.push(callerTarget);
        }
      }

      // Fail closed: if we have no non-web channel targets, check whether this
      // session even has external channel bindings. If it does, something went
      // wrong with channel context propagation — log loudly and surface an error
      // to the web UI. If it doesn't (pure web-only session), this is expected
      // and we return silently — the approval is already visible in the web UI
      // via broadcastToClients (called before this method).
      if (targets.length === 0) {
        const hasExternalBindings = (await listUserChannelBindings(this.appDb, userId))
          .some(b => b.channelType !== 'web');
        if (hasExternalBindings) {
          console.error(
            `[SessionAgentDO] sendChannelInteractivePrompts: No origin or caller channel for prompt ${promptId} — refusing to broadcast. ` +
            `Session has external channel bindings but no channel context was propagated. ` +
            `Approval is visible in web UI only. sessionId=${sessionId} userId=${userId}`
          );
          this.broadcastToClients({
            type: 'error',
            data: {
              message: 'Approval could not be delivered to Slack: no origin channel context. Please approve via the web dashboard.',
              promptId,
            },
          });
        }
        return;
      }

      const refs = await this.channelRouter.sendInteractivePrompt({ userId, targets, prompt });

      // Store refs in local SQLite for later status updates.
      // Note: There is a race window here — if the prompt is resolved before this
      // UPDATE runs, the row will already be deleted and channel refs are lost.
      // In that case the Slack message won't be updated with resolution status.
      // This is acceptable since the user already saw the resolution in the UI.
      if (refs.length > 0) {
        this.ctx.storage.sql.exec(
          'UPDATE interactive_prompts SET channel_refs = ? WHERE id = ?',
          JSON.stringify(refs),
          promptId,
        );
      }
    } catch (err) {
      console.error('[SessionAgentDO] sendChannelInteractivePrompts failed:', err instanceof Error ? err.message : String(err));
    }
  }

  private async updateChannelInteractivePrompts(
    channelRefsJson: string | null,
    resolution: InteractiveResolution,
  ) {
    if (!channelRefsJson) return;

    let refs: Array<{ channelType: string; ref: InteractivePromptRef }>;
    try {
      refs = JSON.parse(channelRefsJson);
    } catch {
      return;
    }

    await this.channelRouter.updateInteractivePrompt({
      userId: this.sessionState.userId,
      refs,
      resolution,
    });
  }

  /**
   * Ensure an alarm is scheduled for the earliest pending action expiry.
   */
  private async ensureActionExpiryAlarm(expiryMs: number) {
    const currentAlarm = await this.ctx.storage.getAlarm();
    // setAlarm if no alarm exists or the new expiry is earlier
    if (!currentAlarm || expiryMs < currentAlarm) {
      await this.ctx.storage.setAlarm(expiryMs);
    }
    // Otherwise the existing alarm() handler will check interactive_prompts
  }

  // Persona resolution extracted to services/persona.ts — resolveOrchestratorPersona()

  // ─── Channel Follow-up Helpers ─────────────────────────────────────

  private insertChannelFollowup(channelType: string, channelId: string, content: string): void {
    if (!channelType || channelType === 'web' || channelType === 'thread') {
      return;
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const intervalMs = this.sessionState.channelFollowupIntervalMs;
    const truncated = (content || '').slice(0, 200);

    this.ctx.storage.sql.exec(
      'INSERT INTO channel_followups (id, channel_type, channel_id, original_content, created_at, next_reminder_at, reminder_count, status) VALUES (?, ?, ?, ?, ?, ?, 0, ?)',
      id, channelType, channelId, truncated, now, now + intervalMs, 'pending'
    );

    // Ensure the alarm is scheduled to cover this new followup
    this.rescheduleIdleAlarm();
  }

  private resolveChannelFollowups(channelType: string, channelId: string): void {
    this.ctx.storage.sql.exec(
      "UPDATE channel_followups SET status = 'resolved' WHERE status = 'pending' AND channel_type = ? AND channel_id = ?",
      channelType, channelId
    );
  }

  /**
   * Send current OpenCode config to the runner so it can apply it.
   * Reads provider keys from spawnRequest envVars and re-fetches custom
   * providers from D1 so admin changes take effect without session restart.
   */
  private async sendOpenCodeConfig(): Promise<void> {
    const spawnRequest = this.sessionState.spawnRequest as { envVars?: Record<string, string>; customProviders?: Array<{ providerId: string; displayName: string; baseUrl: string; apiKey?: string; models: Array<{ id: string; name?: string; contextLimit?: number; outputLimit?: number }> }> } | undefined;
    if (!spawnRequest) {
      console.warn('[SessionAgentDO] sendOpenCodeConfig: no spawnRequest in state, skipping');
      return;
    }

    const envVars = spawnRequest.envVars || {};
    const config: DOMessageOf<'opencode-config'>['config'] = {
      providerKeys: {},
      tools: {},
      instructions: [],
      isOrchestrator: envVars.IS_ORCHESTRATOR === 'true',
    };

    // Map provider keys
    if (envVars.ANTHROPIC_API_KEY) config.providerKeys!.anthropic = envVars.ANTHROPIC_API_KEY;
    if (envVars.OPENAI_API_KEY) config.providerKeys!.openai = envVars.OPENAI_API_KEY;
    if (envVars.GOOGLE_API_KEY) config.providerKeys!.google = envVars.GOOGLE_API_KEY;

    // Disable parallel tools if no key
    if (!envVars.PARALLEL_API_KEY) {
      config.tools!.parallel_web_search = false;
      config.tools!.parallel_web_extract = false;
      config.tools!.parallel_deep_research = false;
      config.tools!.parallel_data_enrichment = false;
    }

    // Re-fetch custom providers from D1 so admin changes take effect immediately
    try {
      const freshProviders = await assembleCustomProviders(this.appDb, this.env.ENCRYPTION_KEY);
      if (freshProviders.length > 0) {
        config.customProviders = freshProviders;
      }
    } catch (err) {
      console.warn('[SessionAgentDO] sendOpenCodeConfig: failed to fetch custom providers from D1, falling back to spawnRequest', err);
      // Fallback to stale spawnRequest data
      if (spawnRequest.customProviders && spawnRequest.customProviders.length > 0) {
        config.customProviders = spawnRequest.customProviders;
      }
    }

    // Fetch built-in provider model allowlists from D1
    try {
      const builtInConfigs = await assembleBuiltInProviderModelConfigs(this.appDb);
      if (builtInConfigs.length > 0) {
        config.builtInProviderModelConfigs = builtInConfigs;
      }
    } catch (err) {
      console.warn('[SessionAgentDO] sendOpenCodeConfig: failed to fetch built-in provider model configs', err);
    }

    console.log(`[SessionAgentDO] Sending opencode-config to runner (providers=${Object.keys(config.providerKeys!).length}, customProviders=${config.customProviders?.length ?? 0}, builtInModelConfigs=${config.builtInProviderModelConfigs?.length ?? 0}, isOrchestrator=${config.isOrchestrator})`);
    this.runnerLink.send({ type: 'opencode-config', config });
  }

  private async sendRepoConfig(): Promise<void> {
    const sessionId = this.sessionState.sessionId;
    if (!sessionId) return;

    const gitState = await getSessionGitState(this.appDb, sessionId);
    const repoUrl = gitState?.sourceRepoUrl;
    if (!repoUrl) return;

    const userId = this.sessionState.userId;
    if (!userId) return;

    const orgId = await this.resolveOrgId();

    try {
      const repoEnv = await assembleRepoEnv(this.appDb, this.env, userId, orgId, {
        repoUrl,
        branch: gitState.branch ?? undefined,
        ref: gitState.ref ?? undefined,
      });

      if (repoEnv.error) {
        console.warn(`[SessionAgentDO] sendRepoConfig: ${repoEnv.error}`);
        return;
      }

      if (repoEnv.token) {
        this.runnerLink.send({
          type: 'repo-config',
          token: repoEnv.token,
          expiresAt: repoEnv.expiresAt,
          gitConfig: repoEnv.gitConfig,
          repoUrl,
          branch: gitState.branch ?? undefined,
          ref: gitState.ref ?? undefined,
        });
        console.log(`[SessionAgentDO] Sent repo-config to runner for ${repoUrl}`);
      }
    } catch (err) {
      console.error('[SessionAgentDO] Failed to assemble repo config for runner:', err);
    }
  }

  private async handleRepoTokenRefresh(requestId?: string): Promise<void> {
    const sessionId = this.sessionState.sessionId;
    if (!sessionId) return;

    const gitState = await getSessionGitState(this.appDb, sessionId);
    const repoUrl = gitState?.sourceRepoUrl;
    if (!repoUrl) return;

    const userId = this.sessionState.userId;
    if (!userId) return;

    const orgId = await this.resolveOrgId();

    try {
      const repoEnv = await assembleRepoEnv(this.appDb, this.env, userId, orgId, {
        repoUrl,
        branch: gitState.branch ?? undefined,
      });

      if (repoEnv.error || !repoEnv.token) {
        console.error('[SessionAgentDO] Failed to refresh repo token:', repoEnv.error);
        return;
      }

      this.runnerLink.send({
        type: 'repo-token-refreshed',
        token: repoEnv.token,
        expiresAt: repoEnv.expiresAt,
        requestId,
      });
      console.log('[SessionAgentDO] Sent refreshed repo token to runner');
    } catch (err) {
      console.error('[SessionAgentDO] Failed to refresh repo token:', err);
    }
  }

  private async sendPluginContent(): Promise<void> {
    const orgId = await this.resolveOrgId() ?? 'default';

    let artifacts: Awaited<ReturnType<typeof getActivePluginArtifacts>>;
    let settings: Awaited<ReturnType<typeof getPluginSettings>>;
    try {
      artifacts = await getActivePluginArtifacts(this.env.DB, orgId);
      settings = await getPluginSettings(this.env.DB, orgId);
    } catch (err) {
      console.warn('[SessionAgentDO] sendPluginContent: failed to fetch plugin data from D1', err);
      return;
    }

    // Get persona files from spawnRequest (session-specific personas from identity)
    let sessionPersonas: Array<{ filename: string; content: string; sortOrder: number }> = [];
    const spawnRequest = this.sessionState.spawnRequest;
    if (spawnRequest) {
      const personaFiles = spawnRequest.personaFiles;
      if (personaFiles && Array.isArray(personaFiles)) {
        sessionPersonas = personaFiles;
      }
    }

    // Resolve skills and tool whitelist from persona attachments or org defaults
    const appDb = getDb(this.env.DB);
    let resolvedSkills: Array<{ filename: string; content: string }> = [];
    let toolWhitelist: { services: string[]; excludedActions: Array<{ service: string; actionId: string }> } | null = null;
    try {
      // Check if this session has a personaId by looking up the session record
      const sessionId = this.sessionState.sessionId;
      if (sessionId) {
        const session = await getSession(appDb, sessionId);
        if (session?.personaId) {
          resolvedSkills = await getPersonaSkills(appDb, session.personaId);
          // Resolve tool whitelist for this persona
          const whitelist = await getPersonaToolWhitelist(appDb, session.personaId);
          if (whitelist.services.length > 0) {
            toolWhitelist = whitelist;
          }
        } else {
          resolvedSkills = await getOrgDefaultSkills(appDb, orgId);
        }
      } else {
        resolvedSkills = await getOrgDefaultSkills(appDb, orgId);
      }
    } catch (err) {
      console.warn('[SessionAgentDO] sendPluginContent: failed to resolve skills from DB', err);
      // Fall back to empty skills
    }

    const content = {
      personas: [
        ...artifacts.filter(a => a.type === 'persona').map(a => ({
          filename: a.filename,
          content: a.content,
          sortOrder: a.sortOrder,
        })),
        ...sessionPersonas,
      ],
      skills: resolvedSkills,
      tools: artifacts.filter(a => a.type === 'tool').map(a => ({
        filename: a.filename,
        content: a.content,
      })),
      allowRepoContent: settings.allowRepoContent,
      toolWhitelist,
    };

    console.log(`[SessionAgentDO] Sending plugin-content: ${content.personas.length} persona(s), ${content.skills.length} skill(s), ${content.tools.length} tool(s), allowRepoContent=${content.allowRepoContent}, toolWhitelist=${toolWhitelist ? `${toolWhitelist.services.length} service(s)` : 'none'}`);
    this.runnerLink.send({ type: 'plugin-content', pluginContent: content });
  }

}
