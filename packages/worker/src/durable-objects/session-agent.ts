import type { Env } from '../env.js';
import type { AppDb } from '../lib/drizzle.js';
import { getDb } from '../lib/drizzle.js';
import { updateSessionStatus, updateSessionMetrics, addActiveSeconds, updateSessionGitState, upsertSessionFileChanged, updateSessionTitle, getSession, getSessionGitState, getChildSessions, listUserChannelBindings, getUserById, getUsersByIds, createMailboxMessage, getOrgSettings, isNotificationWebEnabled, batchInsertAnalyticsEvents, batchUpsertMessages, updateUserDiscoveredModels, setCatalogCache, updateThread, incrementThreadMessageCount, getThreadOriginChannel, getOrchestratorIdentity, getUserSlackIdentityLink, getWorkflowNameByExecutionId } from '../lib/db.js';
import { getCredential, type CredentialResult } from '../services/credentials.js';
import { memRead, memWrite, memPatch, memRm, memSearch } from '../services/session-memory.js';
import { getSlackBotToken } from '../services/slack.js';
import { buildOrchestratorPersonaFiles } from '../lib/orchestrator-persona.js';
import { assembleCustomProviders, assembleBuiltInProviderModelConfigs, assembleRepoEnv } from '../lib/env-assembly.js';
import { resolveAvailableModels } from '../services/model-catalog.js';
import { integrationRegistry } from '../integrations/registry.js';
import { updateIntegrationStatus } from '../lib/db/integrations.js';
import { approveInvocation, denyInvocation, markFailed } from '../services/actions.js';
import { resolveOrgPolicyMatch, updateInvocationStatus, upsertUserActionPolicyOverride, deleteSessionActionPolicyOverrides } from '../lib/db/actions.js';
import { getActivePluginArtifacts, getPluginSettings } from '../lib/db/plugins.js';
import { getPersonaSkills, getOrgDefaultSkills, getPersonaToolWhitelist } from '../lib/db.js';
import type { ChannelTarget, ChannelContext, InteractivePrompt, InteractiveAction, InteractivePromptRef, InteractiveResolution } from '@valet/sdk';
import { MessageStore } from './message-store.js';
import { getChannelForMessage, dropEmission } from './channel-resolver.js';
import { ChannelRouter } from './channel-router.js';
import { PromptQueue, type QueueEntry } from './prompt-queue.js';
import { RunnerLink, type RunnerToDOMessage, type DOToRunnerMessage, type PromptAttachment, type RunnerMessageHandlers, type WorkflowExecutionDispatchPayload, type DOMessageOf } from './runner-link.js';
import { SessionState, type SessionStartParams } from './session-state.js';
import { SessionLifecycle, SandboxAlreadyExitedError, SandboxSnapshotFailedError } from './session-lifecycle.js';
import { SessionHealthMonitor, DISCONNECT_GRACE_MS, SANDBOX_WAKE_TIMEOUT_MS, type HealthSnapshot } from './session-health-monitor.js';
import { resolveOrchestratorPersona } from '../services/persona.js';
import { mailboxSend, mailboxCheck } from '../services/session-mailbox.js';
import { taskCreate, taskList, taskUpdate, taskMy } from '../services/session-tasks.js';
import { handleIdentityAction } from '../services/session-identity.js';
import { handleSkillAction } from '../services/session-skills.js';
import { handlePersonaAction, listPersonasForRunner } from '../services/session-personas.js';
import { spawnChild, sendSessionMessage, getSessionMessages, forwardMessages, terminateChild, listChildSessions, getSessionStatus, listChannels } from '../services/session-cross.js';
import { listTools as listToolsSvc, resolveActionPolicy, executeAction as executeActionSvc, type CredentialCache } from '../services/session-tools.js';
import { loadCustomMcpConnectorContext } from '../services/custom-mcp-connectors.js';
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
import {
  sanitizePromptAttachments,
  attachmentPartsForDisplay,
  attachmentsForClientState,
  parseQueuedPromptAttachments,
  parsePromptAttachmentBlobUrl,
  SUPPORTED_FILE_TYPES_DESCRIPTION,
} from '../lib/utils/prompt-validation.js';
import { parseQueuedWorkflowPayload, deriveRuntimeStates } from '../lib/utils/runtime.js';
import { ensureChannelBinding } from '../lib/db/channels.js';
import { getOrgSlackInstallAny } from '../lib/db/slack.js';
import { registerChannelThread } from '../lib/db/channel-threads.js';
import { channelScopeKey } from '@valet/shared';

// ─── WebSocket Message Types ───────────────────────────────────────────────

const MAX_CHANNEL_FOLLOWUP_REMINDERS = 3;
const PARENT_IDLE_DEBOUNCE_MS = 10_000;
const PROMPT_ATTACHMENT_R2_PREFIX = 'prompt-attachments';
export const ACTION_APPROVAL_EXPIRY_MS = 240 * 1000;

function promptAttachmentSummary(attachments: PromptAttachment[] | undefined): string {
  if (!attachments?.length) return 'none';
  return attachments.map((attachment, index) => {
    const filename = attachment.filename || 'unnamed';
    return `${index}:${attachment.mime || 'unknown'}:${filename}:urlChars=${attachment.url?.length ?? 0}`;
  }).join(', ');
}

export function buildActionApprovalPromptActions(): InteractiveAction[] {
  return [
    { id: 'allow_once', label: 'Allow', description: 'Run the tool once and continue.', style: 'primary' },
    { id: 'allow_session', label: 'Allow for Session', description: 'Run the tool and remember this choice for this session.' },
    { id: 'allow_always', label: 'Always Allow', description: 'Run the tool and remember this choice for future tool calls.' },
    { id: 'cancel', label: 'Cancel', description: 'Cancel this tool call.', style: 'danger' },
  ];
}

function normalizeApprovalAction(actionId?: string): 'allow_once' | 'allow_session' | 'allow_always' | 'cancel' | null {
  switch (actionId) {
    case 'approve':
    case 'allow_once':
      return 'allow_once';
    case 'allow_session':
      return 'allow_session';
    case 'allow_always':
      return 'allow_always';
    case 'deny':
    case 'cancel':
      return 'cancel';
    default:
      return null;
  }
}

function isApprovalTransportAction(actionId: string): boolean {
  const normalized = normalizeApprovalAction(actionId);
  return normalized !== null && normalized !== 'cancel';
}

function isCancelTransportAction(actionId: string): boolean {
  return normalizeApprovalAction(actionId) === 'cancel';
}

type PromptResolutionResult =
  | { ok: true }
  | { ok: false; status: number; error: string };

const PROMPT_QUEUE_POLICY_HEADER = 'X-Valet-Prompt-Queue-Policy';
const PROMPT_QUEUE_POLICY_APPEND = 'append';

interface PromptQueuePolicy {
  replaceExistingQueued?: boolean;
  priority?: number;
  replaceable?: boolean;
}

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

/**
 * Restore the composite Slack channelId (with thread_ts) when the agent
 * sends only a bare channel ID. Returns the original channelId unchanged
 * for non-Slack channels or when the stored context doesn't match.
 */
export function resolveSlackChannelId(
  channelType: string,
  channelId: string,
  storedReplyId: string | undefined,
): string {
  if (channelType !== 'slack' || channelId.includes(':')) return channelId;
  if (!storedReplyId || !storedReplyId.includes(':')) return channelId;
  const [baseChannel] = storedReplyId.split(':');
  if (baseChannel !== channelId) return channelId;
  return storedReplyId;
}

export function buildForwardedParts(
  originalParts: unknown,
  metadata: {
    forwarded: true;
    sourceSessionId: string;
    sourceSessionTitle: string;
    originalRole: string;
    originalCreatedAt: string;
    originalMessageId?: string;
    originalSessionId?: string;
  },
): unknown {
  if (Array.isArray(originalParts)) {
    return [...originalParts, metadata];
  }
  if (originalParts && typeof originalParts === 'object') {
    return { ...(originalParts as Record<string, unknown>), ...metadata };
  }
  return metadata;
}

/** Messages sent by browser clients to the DO */
interface ClientMessage {
  type: 'prompt' | 'answer' | 'ping' | 'abort' | 'revert' | 'diff' | 'review' | 'command' | 'approve-action' | 'deny-action' | 'queue.withdraw' | 'queue.promote' | 'queue.replace';
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
  actionId?: string;
  reason?: string;
}

/** Messages sent from DO to clients */
interface ClientOutbound {
  type: 'message' | 'message.updated' | 'messages.removed' | 'stream' | 'chunk' | 'interactive_prompt' | 'interactive_prompt_resolved' | 'interactive_prompt_expired' | 'status' | 'pong' | 'error' | 'user.joined' | 'user.left' | 'agentStatus' | 'models' | 'diff' | 'review-result' | 'command-result' | 'git-state' | 'pr-created' | 'files-changed' | 'child-session' | 'title' | 'audit_log' | 'model-switched' | 'toast' | 'integration-auth-required' | 'thread.created' | 'thread.updated' | 'queue.state' | 'queue.withdrawn';
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
    replaceable INTEGER NOT NULL DEFAULT 1,
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
   *  Keyed by "ownerType:ownerId:service", entries expire after CREDENTIAL_CACHE_TTL_MS. */
  private credentialCache = new Map<string, { result: CredentialResult; expiresAt: number }>();
  private static readonly CREDENTIAL_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

  /** In-memory cache of disabled plugin services to avoid D1 query on every tool invocation. */
  private disabledPluginServicesCache: { services: Set<string>; expiresAt: number } | null = null;
  private static readonly DISABLED_PLUGINS_CACHE_TTL_MS = 60 * 1000; // 1 minute

  private getCachedCredential(ownerType: string, ownerId: string, service: string): CredentialResult | null {
    const key = `${ownerType}:${ownerId}:${service}`;
    const entry = this.credentialCache.get(key);
    if (!entry || Date.now() > entry.expiresAt) {
      if (entry) this.credentialCache.delete(key);
      return null;
    }
    return entry.result;
  }

  private setCachedCredential(ownerType: string, ownerId: string, service: string, result: CredentialResult): void {
    const key = `${ownerType}:${ownerId}:${service}`;
    this.credentialCache.set(key, {
      result,
      expiresAt: Date.now() + SessionAgentDO.CREDENTIAL_CACHE_TTL_MS,
    });
  }

  private invalidateCachedCredential(ownerType: string, ownerId: string, service: string): void {
    this.credentialCache.delete(`${ownerType}:${ownerId}:${service}`);
  }

  private messageStore!: MessageStore;
  private promptQueue!: PromptQueue;
  private runnerLink!: RunnerLink;
  private sessionState!: SessionState;
  private lifecycle!: SessionLifecycle;

  /** Tracks the workflow execution ID for direct-dispatch workflow turns
   *  (where no queue row exists). Set when handleWorkflowExecuteDispatch
   *  sends directly to the runner; cleared on turn completion. */
  private _activeWorkflowExecutionId: string | undefined;

  private static readonly RUNNER_GRACE_PERIOD_MS = 60_000;
  private static readonly MODAL_SANDBOX_MAX_LIFETIME_MS = 24 * 60 * 60 * 1000;
  private static readonly MODAL_SANDBOX_TIMEOUT_EDGE_THRESHOLD_MS =
    SessionAgentDO.MODAL_SANDBOX_MAX_LIFETIME_MS - 5 * 60 * 1000;

  private readonly healthMonitor = new SessionHealthMonitor();

  /** Debounce timer for flushing messages to D1 during active turns. */
  private d1FlushTimer: ReturnType<typeof setTimeout> | null = null;

  private disconnectRevertTimer: ReturnType<typeof setTimeout> | null = null;

  private guardConfigCache: Record<string, unknown> | null = null;
  private guardConfigExpiresAt = 0;

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

  /**
   * Resolve channel for a specific prompt by messageId. Reads from prompt_queue
   * via channel-resolver — the explicit, deterministic source. Returns a
   * discriminated result so callers can distinguish "row missing" from "row
   * exists but lacks channel context".
   */
  private getChannelForMessage(messageId: string) {
    return getChannelForMessage(this.promptQueue, messageId);
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

  /** Fetch org-level guard config with a 60-second in-memory TTL. */
  private async getGuardConfig(): Promise<Record<string, unknown>> {
    const now = Date.now();
    if (this.guardConfigCache && now < this.guardConfigExpiresAt) {
      return this.guardConfigCache;
    }
    const settings = await getOrgSettings(this.appDb);
    this.guardConfigCache = {
      driveLabelsGuardEnabled: settings.driveLabelsGuardEnabled,
      driveRequiredLabelIds: settings.driveRequiredLabelIds,
      driveLabelsFailMode: settings.driveLabelsFailMode,
      driveCorpora: settings.driveCorpora,
    };
    this.guardConfigExpiresAt = now + 60_000;
    return this.guardConfigCache;
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
      case '/prompt-attachment':
        return this.handlePromptAttachmentEndpoint(url);
      case '/gc':
        return this.handleGarbageCollect();
      case '/webhook-update':
        return this.handleWebhookUpdate(request);
      case '/ensure-running':
        return this.handleEnsureRunning();
      case '/refresh':
        return this.handleRefresh();
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
        const body = await request.json() as { content?: string; contextPrefix?: string; model?: string; attachments?: PromptAttachment[]; interrupt?: boolean; queueMode?: string; channelType?: string; channelId?: string; threadId?: string; authorName?: string; authorEmail?: string; authorId?: string; authorAvatarUrl?: string; replyTo?: { channelType: string; channelId: string } };
        const content = body.content ?? '';
        const { attachments, rejectedTypes } = sanitizePromptAttachments(body.attachments);
        if (rejectedTypes.length > 0) {
          console.warn(`[SessionAgentDO] /prompt HTTP: rejected file types: ${rejectedTypes.join(', ')}`);
        }
        console.log(
          `[SessionAgentDO] /prompt HTTP: content="${content.slice(0, 60)}" ` +
          `channelType=${body.channelType || 'none'} channelId=${body.channelId || 'none'} ` +
          `queueMode=${body.queueMode || 'default'} authorName=${body.authorName || 'none'} ` +
          `authorId=${body.authorId || 'none'} attachments=${attachments.length} ` +
          `[${promptAttachmentSummary(attachments)}]`,
        );

        // Handle interrupt-only (no content) — e.g., /stop command
        if (body.interrupt && !content && attachments.length === 0) {
          if (this.promptQueue.runnerBusy) {
            await this.handleAbort();
          }
          return Response.json({ success: true, aborted: true });
        }

        if (!content && attachments.length === 0) {
          return new Response(JSON.stringify({ error: 'Missing content or attachments' }), { status: 400 });
        }
        // Route prompts through the selected queue mode. If none is provided,
        // fall back to the DO's configured default.
        // Orchestrator sessions steer when the *same* thread/channel is busy —
        // user messages should interrupt that thread's running subtask, not queue
        // silently (TKAI-106). Cross-thread messages queue normally so they don't
        // abort unrelated work (e.g. an in-progress poem on another thread).
        const isOrchestrator = this.sessionState.sessionId?.startsWith('orchestrator:') ?? false;
        const promptChannelType = body.threadId ? 'thread' : body.channelType;
        const promptChannelId = body.threadId ? body.threadId : body.channelId;
        const promptChannelKey = this.channelKeyFrom(promptChannelType, promptChannelId);
        const sameChannelBusy = isOrchestrator && this.promptQueue.isChannelBusy(promptChannelKey);
        const requestedMode = body.queueMode || this.promptQueue.queueMode || 'followup';
        const effectiveMode = body.interrupt ? 'steer'
          : sameChannelBusy ? 'steer'
          : isOrchestrator && requestedMode === 'steer' ? 'followup'
          : requestedMode;
        console.log(`[SessionAgentDO] /prompt HTTP: effectiveMode=${effectiveMode} runnerBusy=${this.promptQueue.runnerBusy} channelBusy=${sameChannelBusy} channel=${promptChannelKey}`);

        const author = (body.authorId || body.authorEmail || body.authorName) ? {
          id: body.authorId || '',
          email: body.authorEmail || '',
          name: body.authorName,
          avatarUrl: body.authorAvatarUrl,
        } : undefined;
        const queuePolicy: PromptQueuePolicy | undefined =
          request.headers.get(PROMPT_QUEUE_POLICY_HEADER) === PROMPT_QUEUE_POLICY_APPEND
            ? { replaceExistingQueued: false, priority: 0, replaceable: false }
            : undefined;

        switch (effectiveMode) {
          case 'steer':
            await this.handleInterruptPrompt(content, body.model, author, attachments, body.channelType, body.channelId, body.threadId, body.contextPrefix);
            break;
          case 'collect':
            await this.handleCollectPrompt(content, body.model, author, attachments, body.channelType, body.channelId, body.threadId, body.contextPrefix);
            break;
          default:
            await this.handlePrompt(content, body.model, author, attachments, body.channelType, body.channelId, body.threadId, undefined, body.contextPrefix, body.replyTo, queuePolicy);
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
        const result = await this.handlePromptResolved(body.promptId, {
          actionId: body.actionId,
          value: body.value,
          resolvedBy: body.resolvedBy,
        });
        if (!result.ok) {
          return new Response(JSON.stringify({ error: result.error }), { status: result.status });
        }
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
    const pendingEntry = this.promptQueue.peekQueued();
    const pendingPrompt = pendingEntry ? {
      messageId: pendingEntry.id,
      content: pendingEntry.content,
      attachments: pendingEntry.attachments ? attachmentsForClientState(JSON.parse(pendingEntry.attachments)) : undefined,
      threadId: pendingEntry.threadId || undefined,
    } : null;

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
        pendingPrompt,
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
    this.sessionState.runnerDisconnectedAt = null;

    // Emit runner_connect timing — measure time from sandbox start to runner WebSocket
    const runningStart = this.sessionState.runningStartedAt;
    if (runningStart > 0) {
      this.emitEvent('runner_connect', { durationMs: Date.now() - runningStart });
    }

    // Cancel disconnect grace timer — runner reconnected in time
    if (this.disconnectRevertTimer) {
      clearTimeout(this.disconnectRevertTimer);
      this.disconnectRevertTimer = null;
      console.log(`[SessionAgentDO] Runner reconnected within grace period — processing entry preserved`);
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
      // Defer revert — if runner reconnects within grace period, processing entry stays intact
      if (this.disconnectRevertTimer) clearTimeout(this.disconnectRevertTimer);
      this.disconnectRevertTimer = setTimeout(() => {
        this.disconnectRevertTimer = null;
        // Only revert if runner is still disconnected
        if (!this.runnerLink.isConnected) {
          console.log(`[SessionAgentDO] Disconnect grace expired — reverting processing→queued`);
          this.promptQueue.revertProcessingToQueued();
          this.promptQueue.runnerBusy = false;
          this._activeWorkflowExecutionId = undefined;
          if (this.promptQueue.length > 0 && !this.promptQueue.idleQueuedSince) {
            this.promptQueue.idleQueuedSince = Date.now();
            this.rescheduleIdleAlarm();
          }
        }
      }, DISCONNECT_GRACE_MS);

      this.runnerLink.onDisconnect();

      // Start grace period — if runner doesn't reconnect within 60s, terminate
      this.sessionState.runnerDisconnectedAt = Date.now();
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
      runnerDisconnectedAt: this.sessionState.runnerDisconnectedAt,
      runnerConnectedAt: this.runnerLink.connectedAt,
      sandboxWakeStartedAt: this.sessionState.sandboxWakeStartedAt,
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

    // ─── Backoff Timer Check ────────────────────────────────────────
    // If we're in backoff and the timer has expired, attempt recovery again.
    if (status === 'backoff') {
      const backoffUntil = this.sessionState.backoffUntil;
      if (backoffUntil > 0 && now >= backoffUntil) {
        console.log('[SessionAgentDO] Backoff cooldown elapsed — retrying recovery');
        this.sessionState.resetRecoveryState();
        await this.performRecovery('backoff_retry');
      }
      // Whether we retried or the timer hasn't expired yet, re-arm and return.
      // performRecovery transitions to initializing (success) or backoff/terminated (failure).
      this.rescheduleIdleAlarm();
      return;
    }

    // ─── Runner Grace Period Check ──────────────────────────────────
    if (this.sessionState.runnerDisconnectedAt && now - this.sessionState.runnerDisconnectedAt >= SessionAgentDO.RUNNER_GRACE_PERIOD_MS) {
      console.log(`[SessionAgentDO] Runner did not reconnect within ${SessionAgentDO.RUNNER_GRACE_PERIOD_MS / 1000}s — attempting recovery`);
      this.sessionState.runnerDisconnectedAt = null;
      await this.performRecovery('sandbox_lost');
      // performRecovery transitions to initializing (spawning new sandbox) or
      // terminal state (circuit breaker tripped). Re-arm if still alive.
      if (!['terminated', 'error'].includes(this.sessionState.status)) {
        this.rescheduleIdleAlarm();
      }
      return;
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
            this._activeWorkflowExecutionId = undefined;
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
            this._activeWorkflowExecutionId = undefined;
            this.promptQueue.clearDispatchTimers();
            if (this.promptQueue.length > 0 && !this.promptQueue.idleQueuedSince) {
              this.promptQueue.idleQueuedSince = Date.now();
            }
            break;
          case 'clear_safety_net':
            this.promptQueue.errorSafetyNetAt = 0;
            break;
          case 'perform_recovery':
            this.sessionState.sandboxWakeStartedAt = 0;
            await this.performRecovery(action.reason);
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
        "SELECT id, type, request_id, context, channel_refs FROM interactive_prompts WHERE status = 'pending' AND expires_at IS NOT NULL AND expires_at <= ?",
        nowSecs
      )
      .toArray();

    for (const ep of expiredPrompts) {
      await this.expireInteractivePromptRow(ep as Record<string, unknown>);
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
    const hasPendingGrace = this.sessionState.runnerDisconnectedAt !== null;

    if (hasWork || hasIdleDeadline || hasConnections || hasPendingGrace) {
      this.lifecycle.scheduleAlarm(deadlines);
    }
    // else: nothing to do — let Cloudflare evict this DO from memory
  }

  // ─── Slash Commands (from web UI) ─────────────────────────────────────

  /**
   * Handle slash commands sent as regular messages from the web UI.
   * Returns true if the command was handled, false to fall through to normal prompt dispatch.
   */
  private async handleSlashCommand(ws: WebSocket, command: string, threadId?: string): Promise<boolean> {
    const sessionId = this.sessionState.sessionId;

    const reply = (content: string) => {
      const msgId = crypto.randomUUID();
      const createdAt = Math.floor(Date.now() / 1000);
      this.messageStore.writeMessage({ id: msgId, role: 'system', content, threadId });
      this.broadcastToClients({ type: 'message', data: { id: msgId, role: 'system', content, threadId, createdAt } });
    };

    switch (command) {
      case 'status': {
        const status = this.sessionState.status;
        const runnerConnected = this.runnerLink.isConnected;
        const queuedPrompts = this.promptQueue.length;
        const sandboxId = this.sessionState.sandboxId;
        let text = `**Session Status**\nStatus: **${status}**`;
        if (runnerConnected) text += '\nRunner: connected';
        if (queuedPrompts) text += `\nQueued prompts: ${queuedPrompts}`;
        if (sandboxId) text += `\nSandbox: \`${sandboxId}\``;

        // Include child sessions
        try {
          const result = await getChildSessions(this.env.DB, sessionId!);
          if (result.children.length > 0) {
            text += `\n\n**Child Sessions (${result.children.length}):**`;
            for (const child of result.children) {
              text += `\n- ${child.title || child.workspace || child.id.slice(0, 8)} — **${child.status}**`;
            }
          }
        } catch { /* best effort */ }

        reply(text);
        return true;
      }

      case 'sessions': {
        try {
          const result = await getChildSessions(this.env.DB, sessionId!);
          const list = result.children;
          if (list.length === 0) {
            reply('No child sessions.');
          } else {
            const lines = list.map((c) =>
              `- ${c.title || c.workspace || c.id.slice(0, 8)} — **${c.status}**`
            );
            reply(`**Child Sessions (${list.length}):**\n${lines.join('\n')}`);
          }
        } catch {
          reply('Could not list child sessions.');
        }
        return true;
      }

      case 'clear': {
        this.promptQueue.clearAll();
        reply('Prompt queue cleared.');
        return true;
      }

      case 'stop': {
        // Interrupt current agent turn + clear queue
        this.runnerLink.send({ type: 'abort' });
        this.promptQueue.clearAll();
        reply('Stopped current work and cleared queue.');
        return true;
      }

      case 'refresh': {
        reply('Restarting sandbox...');
        await this.handleRefresh();
        return true;
      }

      case 'help': {
        const commands = [
          '**/status** — Show session status, sandbox ID, and child sessions',
          '**/sessions** — List child sessions with status',
          '**/stop** — Stop current work and clear queue',
          '**/clear** — Clear the prompt queue',
          '**/refresh** — Restart the sandbox',
          '**/model** — Change the model',
          '**/diff** — Show git diff',
          '**/review** — Request code review',
        ];
        reply(`**Available Commands**\n${commands.join('\n')}`);
        return true;
      }

      default:
        return false; // Not a recognized command — fall through to normal prompt
    }
  }

  // ─── Client Message Handling ───────────────────────────────────────────

  private getClientUserId(ws: WebSocket): string | undefined {
    const clientTag = this.ctx.getTags(ws).find((tag: string) => tag.startsWith('client:'));
    return clientTag?.replace('client:', '') || undefined;
  }

  private async handleClientMessage(ws: WebSocket, msg: ClientMessage) {
    switch (msg.type) {
      case 'prompt': {
        // ─── Slash command interception ───
        // Handle /command messages locally instead of dispatching to the agent.
        const slashMatch = msg.content?.match(/^\/(\w+)$/);
        if (slashMatch && !msg.attachments?.length) {
          const handled = await this.handleSlashCommand(ws, slashMatch[1], msg.threadId);
          if (handled) return;
        }

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
        // Orchestrator sessions steer only when the same thread/channel is busy (TKAI-106).
        const wsChannelType = (msg as any).channelType as string | undefined;
        const wsChannelId = (msg as any).channelId as string | undefined;
        const wsThreadId = msg.threadId;
        const wsContinuationContext = msg.continuationContext;
        const wsIsOrchestrator = this.sessionState.sessionId?.startsWith('orchestrator:') ?? false;
        const wsPromptChType = wsThreadId ? 'thread' : wsChannelType;
        const wsPromptChId = wsThreadId ? wsThreadId : wsChannelId;
        const wsSameChannelBusy = wsIsOrchestrator && this.promptQueue.isChannelBusy(this.channelKeyFrom(wsPromptChType, wsPromptChId));
        const wsQueueMode = wsSameChannelBusy ? 'steer'
          : ((msg as any).queueMode || this.promptQueue.queueMode || 'followup');
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
        const actionId = msg.actionId || 'approve';
        if (!isApprovalTransportAction(actionId)) {
          ws.send(JSON.stringify({
            type: 'error',
            error: `approve-action transport does not accept cancel action: ${actionId}`,
            promptId: msg.invocationId,
          }));
          return;
        }
        const resolvedBy = this.getClientUserId(ws);
        if (!resolvedBy) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing authenticated client user' }));
          return;
        }
        const result = await this.handlePromptResolved(msg.invocationId, {
          actionId,
          resolvedBy,
        });
        if (!result.ok) {
          ws.send(JSON.stringify({ type: 'error', error: result.error, promptId: msg.invocationId }));
        }
        break;
      }

      case 'deny-action': {
        if (!msg.invocationId) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing invocationId' }));
          return;
        }
        const actionId = msg.actionId || 'deny';
        if (!isCancelTransportAction(actionId)) {
          ws.send(JSON.stringify({
            type: 'error',
            error: `deny-action transport does not accept approval action: ${actionId}`,
            promptId: msg.invocationId,
          }));
          return;
        }
        const resolvedBy = this.getClientUserId(ws);
        if (!resolvedBy) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing authenticated client user' }));
          return;
        }
        const result = await this.handlePromptResolved(msg.invocationId, {
          actionId,
          value: msg.reason,
          resolvedBy,
        });
        if (!result.ok) {
          ws.send(JSON.stringify({ type: 'error', error: result.error, promptId: msg.invocationId }));
        }
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

      case 'queue.withdraw': {
        const withdrawn = this.promptQueue.withdrawQueued();
        if (withdrawn) {
          this.broadcastToClients({
            type: 'queue.withdrawn',
            data: {
              messageId: withdrawn.id,
              content: withdrawn.content,
              attachments: withdrawn.attachments ? attachmentsForClientState(JSON.parse(withdrawn.attachments)) : undefined,
              threadId: withdrawn.threadId,
            },
          });
          this.broadcastToClients({
            type: 'queue.state',
            data: { pending: null },
          });
          this.emitAuditEvent('user.queue_withdraw', `Withdrew pending prompt ${withdrawn.id}`);
        }
        break;
      }

      case 'queue.promote': {
        const entry = this.promptQueue.withdrawQueued();
        if (!entry) break; // no-op if nothing queued

        // Broadcast withdrawal so the pending card clears immediately
        this.broadcastToClients({
          type: 'queue.state',
          data: { pending: null },
        });

        // If there are pending questions, the promoted message IS the user's
        // answer. Resolve the question and let the agent continue its turn —
        // don't abort or dispatch a new prompt.  An abort races with the answer
        // on the runner (concurrent WS handlers → concurrent HTTP calls to
        // OpenCode) and can kill the session before the answer arrives.
        const pendingQuestions = this.ctx.storage.sql
          .exec("SELECT id FROM interactive_prompts WHERE type = 'question' AND status = 'pending'")
          .toArray();
        if (pendingQuestions.length > 0) {
          // Record the user's message so it appears in chat
          const messageId = crypto.randomUUID();
          this.messageStore.writeMessage({
            id: messageId,
            role: 'user',
            content: entry.content,
            author: entry.authorId
              ? { id: entry.authorId, email: entry.authorEmail || '', name: entry.authorName || undefined, avatarUrl: entry.authorAvatarUrl || undefined }
              : undefined,
          });
          this.broadcastToClients({
            type: 'message',
            data: {
              id: messageId,
              role: 'user',
              content: entry.content,
              authorId: entry.authorId || undefined,
              authorEmail: entry.authorEmail || undefined,
              authorName: entry.authorName || undefined,
              authorAvatarUrl: entry.authorAvatarUrl || undefined,
              createdAt: Math.floor(Date.now() / 1000),
            },
          });

          // Answer only the first pending question — the agent will continue
          // its turn and re-present subsequent questions naturally.
          await this.handleAnswer(pendingQuestions[0].id as string, entry.content);
          this.emitAuditEvent('user.queue_promote', `Promoted prompt ${entry.id} as question answer`);
          break;
        }

        if (this.promptQueue.runnerBusy) {
          await this.handleAbort();
        }

        // Dispatch the withdrawn entry via handlePrompt
        await this.handlePrompt(
          entry.content,
          entry.model || undefined,
          entry.authorId ? { id: entry.authorId, email: entry.authorEmail || '', name: entry.authorName || undefined, avatarUrl: entry.authorAvatarUrl || undefined } : undefined,
          entry.attachments ? JSON.parse(entry.attachments) : undefined,
          entry.channelType || undefined,
          entry.channelId || undefined,
          entry.threadId || undefined,
          entry.continuationContext || undefined,
          entry.contextPrefix || undefined,
          entry.replyChannelType && entry.replyChannelId
            ? { channelType: entry.replyChannelType, channelId: entry.replyChannelId }
            : undefined,
        );
        this.emitAuditEvent('user.queue_promote', `Promoted pending prompt ${entry.id}`);
        break;
      }

      case 'queue.replace': {
        // Withdraw existing pending (if any)
        const existing = this.promptQueue.withdrawQueued();
        if (existing) {
          this.broadcastToClients({
            type: 'queue.withdrawn',
            data: {
              messageId: existing.id,
              content: existing.content,
              attachments: existing.attachments ? attachmentsForClientState(JSON.parse(existing.attachments)) : undefined,
              threadId: existing.threadId,
            },
          });
          this.emitAuditEvent('user.queue_withdraw', `Replaced pending prompt ${existing.id}`);
        }

        // Extract author from WebSocket tag (same as prompt case)
        const clientTag = this.ctx.getTags(ws).find((t: string) => t.startsWith('client:'));
        const userId = clientTag?.replace('client:', '');
        const userDetails = userId ? this.userDetailsCache.get(userId) : undefined;
        const replaceAuthor = userDetails ? {
          id: userDetails.id,
          email: userDetails.email,
          name: userDetails.name,
          avatarUrl: userDetails.avatarUrl,
          gitName: userDetails.gitName,
          gitEmail: userDetails.gitEmail,
        } : userId ? { id: userId, email: '', name: undefined, avatarUrl: undefined, gitName: undefined, gitEmail: undefined } : undefined;

        const { attachments: replaceAttachments } = sanitizePromptAttachments(msg.attachments);

        // Abort + dispatch new content as steer
        await this.handleInterruptPrompt(
          msg.content || '',
          msg.model,
          replaceAuthor,
          replaceAttachments,
          (msg as any).channelType,
          (msg as any).channelId,
          (msg as any).threadId,
        );
        this.emitAuditEvent('user.queue_replace', 'Replaced with new content');
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
    if (!channelType || !author?.id || author.id !== sessionOwnerId) {
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
    queuePolicy?: PromptQueuePolicy,
  ) {
    // ─── Thread-reply capture for pending questions ─────────────────────
    // If there's a pending question and this message came from the same
    // channel by the session owner, treat it as the answer.
    const replyQuestionChannelType = replyTo?.channelType ?? channelType;
    const replyQuestionChannelId = replyTo?.channelId ?? channelId;
    const incomingAttachmentCount = attachments?.length ?? 0;
    if (await this.tryResolveChannelQuestion(content, author, replyQuestionChannelType, replyQuestionChannelId)) {
      if (incomingAttachmentCount > 0) {
        console.warn(
          `[SessionAgentDO] handlePrompt: attachment-bearing prompt resolved pending question ` +
          `without runner dispatch; channelType=${replyQuestionChannelType || 'none'} ` +
          `channelId=${replyQuestionChannelId || 'none'} attachments=${incomingAttachmentCount}`,
        );
      }
      return;
    }
    if (threadId && await this.tryResolveChannelQuestion(content, author, 'thread', threadId)) {
      if (incomingAttachmentCount > 0) {
        console.warn(
          `[SessionAgentDO] handlePrompt: attachment-bearing thread prompt resolved pending question ` +
          `without runner dispatch; threadId=${threadId} attachments=${incomingAttachmentCount}`,
        );
      }
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
      channelType = 'thread';
      channelId = threadId;
    }
    const channelKey = this.channelKeyFrom(channelType, channelId);

    if (threadId) {
      const inMemoryThreadSessionId = this.getChannelOcSessionId(channelKey);
      // handlePrompt needs both OC session hydration AND continuation context,
      // so we call hydrateThreadResumeContext directly (single D1 query) rather
      // than using ensureThreadOcSessionHydrated which only handles OC sessions.
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
    const attachmentParts = attachmentPartsForDisplay(normalizedAttachments);
    const serializedAttachmentParts = attachmentParts.length > 0 ? JSON.stringify(attachmentParts) : null;
    const serializedQueuedAttachments = normalizedAttachments.length > 0 ? JSON.stringify(normalizedAttachments) : null;

    const messageId = crypto.randomUUID();
    console.log(
      `[SessionAgentDO] handlePrompt attachments: messageId=${messageId} ` +
      `incoming=${incomingAttachmentCount} accepted=${normalizedAttachments.length} ` +
      `displayParts=${attachmentParts.length} [${promptAttachmentSummary(normalizedAttachments)}]`,
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

    // Queue when runner isn't ready or the TARGET channel is busy. Cross-thread
    // messages dispatch directly even when another channel is in-flight — the
    // runner handles concurrent prompts on different OpenCode sessions (TKAI-65).
    // When runnerBusy is set but no per-channel tracking exists (e.g. workflow
    // dispatch, reconnect recovery), fall back to the global flag to be safe.
    // User messages are NOT blocked by an active wait_for_event subscription —
    // the direct dispatch path clears waitSubscription, and child events arriving
    // later are dispatched normally via handleSystemMessage.
    const channelBusy = this.promptQueue.isChannelBusy(channelKey);
    const anyChannelTracked = this.promptQueue.getBusyChannelKey() !== null;
    const shouldQueue = !runnerConnected || !runnerReady || channelBusy || (runnerBusy && !anyChannelTracked);
    const replaceExistingQueued = queuePolicy?.replaceExistingQueued ?? true;
    const queuePriority = queuePolicy?.priority ?? 0;
    const queueReplaceable = queuePolicy?.replaceable ?? true;
    if (shouldQueue) {
      // ─── Enqueue path: defer message write to dispatch time ──────────
      const reason = channelBusy ? 'channel busy'
        : (runnerBusy && !anyChannelTracked) ? 'runner busy'
        : !runnerConnected ? 'no runner connected'
        : 'runner not ready';
      console.log(
        `[SessionAgentDO] handlePrompt: QUEUING (${reason}) channel=${channelKey} ` +
        `messageId=${messageId} attachments=${normalizedAttachments.length}`,
      );

      // Single-slot enforcement: normal user followups replace the pending prompt.
      // Internal append/steer paths preserve existing queued work.
      if (replaceExistingQueued) {
        const existingPending = this.promptQueue.withdrawQueued({ replaceableOnly: true });
        if (existingPending) {
          this.broadcastToClients({
            type: 'queue.withdrawn',
            data: {
              messageId: existingPending.id,
              content: existingPending.content,
              attachments: existingPending.attachments ? attachmentsForClientState(JSON.parse(existingPending.attachments)) : undefined,
              threadId: existingPending.threadId,
            },
          });
          this.emitAuditEvent('user.queue_withdraw', `Replaced pending prompt ${existingPending.id}`);
        }
      }

      // Enqueue WITHOUT writing to message store — write happens at dispatch time
      this.promptQueue.enqueue({
        id: messageId, content, attachments: serializedQueuedAttachments, model,
        authorId: author?.id, authorEmail: author?.email, authorName: author?.name, authorAvatarUrl: author?.avatarUrl,
        channelType, channelId, channelKey, threadId, continuationContext, contextPrefix,
        replyChannelType: effectiveReplyTo?.channelType, replyChannelId: effectiveReplyTo?.channelId,
        priority: queuePriority,
        replaceable: queueReplaceable,
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

      // Broadcast queue.state instead of user message
      this.broadcastToClients({
        type: 'queue.state',
        data: {
          pending: {
            messageId,
            content,
            attachments: normalizedAttachments.length > 0 ? attachmentsForClientState(normalizedAttachments) : undefined,
            threadId,
          },
        },
      });
      this.broadcastToClients({
        type: 'status',
        data: { promptQueued: true, queuePosition: this.promptQueue.length, queueReason: runnerBusy ? 'busy' : 'waking' },
      });
      return;
    }

    // ─── Direct dispatch path: write message immediately ─────────────
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

    console.log(
      `[SessionAgentDO] handlePrompt: DISPATCHING DIRECTLY channel=${channelKey} ` +
      `messageId=${messageId} attachments=${normalizedAttachments.length}`,
    );
    this.promptQueue.stampPromptReceived();
    // Insert into prompt_queue as 'processing' so it can be recovered if the runner disconnects
    this.promptQueue.enqueue({
      id: messageId, content, attachments: serializedQueuedAttachments, model, status: 'processing',
      authorId: author?.id, authorEmail: author?.email, authorName: author?.name, authorAvatarUrl: author?.avatarUrl,
      channelType, channelId, channelKey, threadId, continuationContext, contextPrefix,
      replyChannelType: effectiveReplyTo?.channelType, replyChannelId: effectiveReplyTo?.channelId,
      priority: queuePriority,
      replaceable: queueReplaceable,
    });

    // Forward directly to runner with author info + channel metadata
    this.promptQueue.stampDispatched(channelKey);
    this.promptQueue.idleQueuedSince = 0;
    this.sessionState.lastParentIdleNotice = undefined;
    this.sessionState.parentIdleNotifyAt = 0;
    this.sessionState.waitSubscription = null;
    this.rescheduleIdleAlarm();
    console.log('[SessionAgentDO] handlePrompt: dispatching to runner (DO_CODE_VERSION=v2-pipeline-2)');

    if (effectiveReplyTo) {
      this.insertChannelFollowup(effectiveReplyTo.channelType, effectiveReplyTo.channelId, content);
    } else if (threadId) {
      // Web UI steering of a thread — recover the thread's origin channel so
      // downstream code knows where to route follow-up channel actions.
      const origin = await getThreadOriginChannel(this.env.DB, threadId);
      if (origin && origin.channelType !== 'web' && origin.channelType !== 'thread') {
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
      this.emitAuditEvent('prompt.dispatch_failed', `Dispatch failed, reverted to queue: ${messageId}`);
    }
  }

  private async handleAnswer(questionId: string, answer: string | boolean) {
    await this.handlePromptResolved(questionId, {
      value: String(answer),
      resolvedBy: this.sessionState.userId || 'user',
    });
  }

  private async handlePromptAttachmentEndpoint(url: URL): Promise<Response> {
    const token = url.searchParams.get('token');
    if (!token || token !== this.runnerLink.token) {
      console.warn(
        `[SessionAgentDO] prompt-attachment unauthorized: tokenPresent=${token ? 'yes' : 'no'} ` +
        `expectedPresent=${this.runnerLink.token ? 'yes' : 'no'}`,
      );
      return new Response(JSON.stringify({ error: 'Unauthorized' }), { status: 401 });
    }

    const blobSessionId = url.searchParams.get('blobSessionId');
    const blobId = url.searchParams.get('blobId');
    if (blobSessionId || blobId) {
      const expectedSessionId = this.sessionState.sessionId;
      const blobUrl = blobSessionId && blobId
        ? `valet-prompt-blob://attachment/${encodeURIComponent(blobSessionId)}/${encodeURIComponent(blobId)}`
        : '';
      const parsedBlob = blobUrl ? parsePromptAttachmentBlobUrl(blobUrl) : null;
      if (!parsedBlob) {
        console.warn(
          `[SessionAgentDO] prompt-attachment invalid blob reference: ` +
          `blobSessionId=${blobSessionId || 'none'} blobId=${blobId || 'none'}`,
        );
        return new Response(JSON.stringify({ error: 'Missing or invalid attachment blob reference' }), { status: 400 });
      }
      if (parsedBlob.sessionId !== expectedSessionId) {
        console.warn(
          `[SessionAgentDO] prompt-attachment blob session mismatch: ` +
          `requested=${parsedBlob.sessionId} expected=${expectedSessionId || 'none'}`,
        );
        return new Response(JSON.stringify({ error: 'Attachment not found' }), { status: 404 });
      }

      const key = `${PROMPT_ATTACHMENT_R2_PREFIX}/${parsedBlob.sessionId}/${parsedBlob.blobId}`;
      const object = await this.env.STORAGE.get(key);
      if (!object) {
        console.warn(`[SessionAgentDO] prompt-attachment blob not found: key=${key}`);
        return new Response(JSON.stringify({ error: 'Attachment not found' }), { status: 404 });
      }

      const headers = new Headers();
      object.writeHttpMetadata(headers);
      if (!headers.has('content-type')) {
        headers.set('content-type', object.customMetadata?.mime || 'application/octet-stream');
      }
      console.log(
        `[SessionAgentDO] prompt-attachment returning blob: session=${parsedBlob.sessionId} ` +
        `blobId=${parsedBlob.blobId} size=${object.size ?? 'unknown'}`,
      );
      return new Response(object.body, { headers });
    }

    const messageId = url.searchParams.get('messageId');
    const indexText = url.searchParams.get('index');
    const index = indexText ? Number.parseInt(indexText, 10) : -1;
    if (!messageId || !Number.isInteger(index) || index < 0) {
      console.warn(
        `[SessionAgentDO] prompt-attachment invalid reference: ` +
        `messageId=${messageId || 'none'} index=${indexText || 'none'}`,
      );
      return new Response(JSON.stringify({ error: 'Missing or invalid attachment reference' }), { status: 400 });
    }

    const attachments = this.promptQueue.getAttachmentsById(messageId);
    const attachment = attachments?.[index];
    if (!attachment || typeof attachment !== 'object') {
      console.warn(
        `[SessionAgentDO] prompt-attachment not found: messageId=${messageId} index=${index} ` +
        `storedAttachments=${attachments?.length ?? 0}`,
      );
      return new Response(JSON.stringify({ error: 'Attachment not found' }), { status: 404 });
    }

    const record = attachment as Record<string, unknown>;
    console.log(
      `[SessionAgentDO] prompt-attachment returning: messageId=${messageId} index=${index} ` +
      `mime=${typeof record.mime === 'string' ? record.mime : 'unknown'} ` +
      `filename=${typeof record.filename === 'string' ? record.filename : 'unnamed'} ` +
      `urlChars=${typeof record.url === 'string' ? record.url.length : 0}`,
    );

    return Response.json(attachment);
  }

  private async handleAbort(channelType?: string, channelId?: string) {
    if (channelType && channelId) {
      this.runnerLink.send({ type: 'abort', channelType, channelId });
    } else {
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
    // Normalize threadId to channel routing for abort targeting
    const abortChannelType = threadId ? 'thread' : channelType;
    const abortChannelId = threadId ? threadId : channelId;
    const incomingAttachmentCount = attachments?.length ?? 0;
    if (await this.tryResolveChannelQuestion(content, author, channelType, channelId)) {
      if (incomingAttachmentCount > 0) {
        console.warn(
          `[SessionAgentDO] handleInterruptPrompt: attachment-bearing prompt resolved pending question ` +
          `without runner dispatch; channelType=${channelType || 'none'} channelId=${channelId || 'none'} ` +
          `attachments=${incomingAttachmentCount}`,
        );
      }
      return;
    }
    if (threadId && await this.tryResolveChannelQuestion(content, author, 'thread', threadId)) {
      if (incomingAttachmentCount > 0) {
        console.warn(
          `[SessionAgentDO] handleInterruptPrompt: attachment-bearing thread prompt resolved pending question ` +
          `without runner dispatch; threadId=${threadId} attachments=${incomingAttachmentCount}`,
        );
      }
      return;
    }

    const runnerBusy = this.promptQueue.runnerBusy;
    if (runnerBusy) {
      // Abort current work (channel-scoped if channel info provided)
      await this.handleAbort(abortChannelType, abortChannelId);
    }
    // Queue the new prompt — when the runner confirms abort, handlePromptComplete
    // will drain the queue and send this prompt to the runner
    await this.handlePrompt(content, model, author, attachments, channelType, channelId, threadId, undefined, contextPrefix, undefined, {
      replaceExistingQueued: false,
      priority: 1,
      replaceable: false,
    });
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
    const incomingAttachmentCount = attachments?.length ?? 0;
    if (await this.tryResolveChannelQuestion(content, author, channelType, channelId)) {
      if (incomingAttachmentCount > 0) {
        console.warn(
          `[SessionAgentDO] handleCollectPrompt: attachment-bearing prompt resolved pending question ` +
          `without runner dispatch; channelType=${channelType || 'none'} channelId=${channelId || 'none'} ` +
          `attachments=${incomingAttachmentCount}`,
        );
      }
      return;
    }
    if (threadId && await this.tryResolveChannelQuestion(content, author, 'thread', threadId)) {
      if (incomingAttachmentCount > 0) {
        console.warn(
          `[SessionAgentDO] handleCollectPrompt: attachment-bearing thread prompt resolved pending question ` +
          `without runner dispatch; threadId=${threadId} attachments=${incomingAttachmentCount}`,
        );
      }
      return;
    }

    // Update idle tracking
    this.lifecycle.touchActivity();
    this.rescheduleIdleAlarm();

    const { attachments: normalizedAttachments, rejectedTypes } = sanitizePromptAttachments(attachments);
    if (rejectedTypes.length > 0) {
      console.warn(`[SessionAgentDO] Channel prompt: rejected file types: ${rejectedTypes.join(', ')}`);
    }
    const attachmentParts = attachmentPartsForDisplay(normalizedAttachments);
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
    const handlers: RunnerMessageHandlers = {
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
        // Resolve channel explicitly from the originating prompt — never fall back
        // to a mutable "active" cursor. If the prompt_queue row is missing or lacks
        // channel context, drop the emission with a structured warning.
        if (!msg.messageId) {
          dropEmission('no_message_id', { eventType: 'question', questionId: msg.questionId });
          return;
        }
        const questionLookup = this.getChannelForMessage(msg.messageId);
        if (!questionLookup.found) {
          dropEmission(questionLookup.reason, { eventType: 'question', messageId: msg.messageId, questionId: msg.questionId });
          return;
        }
        const questionCh = questionLookup.target;
        // Store question as interactive prompt and broadcast to all clients
        const qId = msg.questionId || crypto.randomUUID();
        const QUESTION_TIMEOUT_SECS = 5 * 60; // 5 minutes
        const expiresAt = Math.floor(Date.now() / 1000) + QUESTION_TIMEOUT_SECS;
        const sessionId = this.sessionState.sessionId;

        const actions: InteractiveAction[] = msg.options
          ? msg.options.map((opt, i) => ({ id: `option_${i}`, label: opt }))
          : [];

        const context: Record<string, unknown> = msg.options ? { options: msg.options } : {};
        context.channelType = questionCh.channelType;
        context.channelId = questionCh.channelId;
        if (questionCh.threadId) {
          context.threadId = questionCh.threadId;
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
          channelType: questionCh.channelType,
          channelId: questionCh.channelId,
          threadId: questionCh.threadId || undefined,
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
          // User is connected and will see the interactive prompt card — no toast needed.
        } else {
          await this.enqueueOwnerNotification({
            messageType: 'question',
            content: questionSummary,
            contextSessionId: sessionId || undefined,
          });
        }
      },

      'image': (msg) => {
        // Resolve channel explicitly from the originating prompt — never fall back
        // to a mutable "active" cursor. If the prompt_queue row is missing or lacks
        // channel context, drop the emission with a structured warning.
        if (!msg.messageId) {
          dropEmission('no_message_id', { eventType: 'image' });
          return;
        }
        const imgLookup = this.getChannelForMessage(msg.messageId);
        if (!imgLookup.found) {
          dropEmission(imgLookup.reason, { eventType: 'image', messageId: msg.messageId });
          return;
        }
        const imgCh = imgLookup.target;
        // Store image reference and broadcast
        const imgId = crypto.randomUUID();
        const mimeType = ('mimeType' in msg && msg.mimeType) ? msg.mimeType : 'image/png';
        this.messageStore.writeMessage({
          id: imgId,
          role: 'system',
          content: msg.description || 'Image',
          parts: JSON.stringify({ type: 'image', data: msg.data, mimeType }),
          channelType: imgCh.channelType,
          channelId: imgCh.channelId,
        });
        this.broadcastToClients({
          type: 'message',
          data: {
            id: imgId,
            role: 'system',
            content: msg.description || 'Image',
            parts: { type: 'image', data: msg.data, mimeType },
            createdAt: Math.floor(Date.now() / 1000),
            channelType: imgCh.channelType,
            channelId: imgCh.channelId,
          },
        });
      },

      'screenshot': (msg) => {
        // Backward-compat shim: delegate to 'image' handler
        handlers['image']!({ ...msg, type: 'image' as const, mimeType: 'image/png' });
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
        // Resolve channel explicitly from the originating prompt — never fall back
        // to a mutable "active" cursor. If the prompt_queue row is missing or lacks
        // channel context, drop the emission with a structured warning.
        if (!msg.messageId) {
          dropEmission('no_message_id', { eventType: 'error', error: msg.error });
          return;
        }
        const errLookup = this.getChannelForMessage(msg.messageId);
        if (!errLookup.found) {
          dropEmission(errLookup.reason, { eventType: 'error', messageId: msg.messageId, error: msg.error });
          return;
        }
        const errCh = errLookup.target;
        // Always generate a new ID — msg.messageId is the prompt's user message ID,
        // which already exists in the messages table (PRIMARY KEY conflict).
        const errId = crypto.randomUUID();
        const errorText = msg.error || 'Unknown error';
        this.messageStore.writeMessage({
          id: errId,
          role: 'system',
          content: `Error: ${errorText}`,
          channelType: errCh.channelType,
          channelId: errCh.channelId,
        });
        this.broadcastToClients({
          type: 'error',
          messageId: errId,
          error: msg.error,
          channelType: errCh.channelType,
          channelId: errCh.channelId,
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
        // threadId comes directly from the Runner via the message.create envelope —
        // no fallback. The Runner derives it from extractChannelContext(channel).threadId
        // for thread-channel prompts; non-thread channels (web/slack/telegram) don't
        // have a threadId, which is correct.
        const resolvedThreadId = msg.threadId || undefined;
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
        const completedMessageId = (msg as { messageId?: string }).messageId;
        console.log(`[SessionAgentDO] Complete received: messageId=${completedMessageId || 'unscoped'} queueLength=${this.promptQueue.length} runnerBusy=${this.promptQueue.runnerBusy}`);
        await this.handlePromptComplete(completedMessageId);
        this.ctx.waitUntil(this.flushMetrics());
      },

      'agentStatus': async (msg) => {
        // Forward agent status to all clients for real-time activity indication.
        // If messageId is present, resolve the prompt's channel for per-thread filtering.
        // If messageId is absent (startup/reconnect idle signals), broadcast without
        // channel attribution — this is legitimate session-wide status, not a drop.
        let statusCh: { channelType: string; channelId: string } | null = null;
        let statusThreadId: string | null = null;
        if (msg.messageId) {
          const row = this.promptQueue.getChannelTargetById(msg.messageId);
          if (!row) {
            dropEmission('no_prompt_row', { eventType: 'agentStatus', messageId: msg.messageId, status: msg.status });
            return;
          }
          if (row.channelType && row.channelId) {
            statusCh = { channelType: row.channelType, channelId: row.channelId };
          }
          statusThreadId = row.threadId;
        }
        this.broadcastToClients({
          type: 'agentStatus',
          status: msg.status,
          detail: msg.detail,
          ...(statusCh ? { channelType: statusCh.channelType, channelId: statusCh.channelId } : {}),
          ...(statusThreadId ? { threadId: statusThreadId } : {}),
        });
        if (msg.status === 'idle') {
          // If runner was initializing (not yet ready), mark it ready now.
          // This is the signal that OpenCode is healthy and models are discovered.
          const wasInitializing = !this.runnerLink.isReady;
          if (wasInitializing) {
            this.runnerLink.ready = true;
            console.log('[SessionAgentDO] Runner is now ready (first idle after connect)');

            // Transition waiting_runner → running now that the Runner is connected and healthy
            if (this.sessionState.status === 'waiting_runner') {
              this.sessionState.status = 'running';
              const sid = this.sessionState.sessionId;
              updateSessionStatus(this.appDb, sid, 'running', this.sessionState.sandboxId).catch((e) =>
                console.error('[SessionAgentDO] Failed to sync running status to D1:', e),
              );
              this.broadcastToClients({ type: 'status', data: { status: 'running', sandboxRunning: true } });
            }

            // Runner is healthy — reset recovery counters so the circuit breaker
            // starts fresh for any future sandbox loss.
            this.sessionState.resetRecoveryState();

            // Revert any processing entries that survived DO eviction.
            // The disconnectRevertTimer is an in-memory setTimeout that is lost
            // when the Cloudflare isolate is hibernated/evicted. If it didn't fire,
            // processing entries and runnerBusy are stale from the previous lifecycle.
            const stuckProcessing = this.promptQueue.processingCount;
            if (stuckProcessing > 0) {
              console.log(`[SessionAgentDO] Runner ready: reverting ${stuckProcessing} stuck processing entries from previous lifecycle`);
              this.promptQueue.revertProcessingToQueued();
              this.promptQueue.runnerBusy = false;
            }
            // Reset per-channel busy state from previous lifecycle
            this.promptQueue.clearAllChannelBusy();

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
              const ipChannelKey = this.channelKeyFrom(undefined, undefined);
              this.promptQueue.enqueue({ id: messageId, content: initialPrompt, status: 'processing', channelKey: ipChannelKey });
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
              this.promptQueue.stampDispatched(ipChannelKey);
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

      'aborted': async (msg) => {
        // Runner confirmed abort — let handlePromptComplete clear runnerBusy
        // and broadcast status. Don't clear runnerBusy early — that creates a
        // race where a rapid new prompt can be dispatched then immediately
        // completed by markCompleted().
        const abortedMessageId = (msg as { messageId?: string }).messageId;
        this.broadcastToClients({
          type: 'agentStatus',
          status: 'idle',
        });
        await this.handlePromptComplete(abortedMessageId);
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
          threadId: (msg as any).threadId,
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
          const resolvedParentThreadId = this.promptQueue.getProcessingThreadId() || undefined;
          console.log(`[SessionAgentDO] spawn-child: parentSession=${this.sessionState.sessionId} parentThreadId=${resolvedParentThreadId || 'NONE'} task="${msg.task?.slice(0, 60)}"`);
          const result = await spawnChild(
            this.appDb,
            this.env,
            {
              parentSessionId: this.sessionState.sessionId,
              userId: this.sessionState.userId,
              parentThreadId: resolvedParentThreadId,
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
            this.runnerLink.send({ type: 'spawn-child-result', requestId, childSessionId: result.childSessionId, parentThreadId: resolvedParentThreadId });
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
            this.sessionState.sessionId,
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
              messages: result.messages!,
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
                .catch((err) => console.error(`[SessionAgentDO] Failed to update thread ${threadId}:`, err))
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
          const sessionTitle = result.sessionTitle!;
          const sourceSessionId = result.sourceSessionId!;

          if (messages.length === 0) {
            this.runnerLink.send({ type: 'forward-messages-result', requestId, count: 0, sourceSessionId });
            return;
          }

          // Insert each message into our own messages table with forwarded metadata
          for (const msg of messages) {
            const newId = crypto.randomUUID();
            const forwardedMetadata = {
              forwarded: true,
              sourceSessionId,
              sourceSessionTitle: sessionTitle,
              originalRole: msg.role,
              originalCreatedAt: msg.createdAt,
              originalMessageId: msg.id,
              originalSessionId: msg.sessionId,
            } as const;
            const forwardedParts = buildForwardedParts(msg.parts, forwardedMetadata);
            const parts = JSON.stringify(forwardedParts);

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
                parts: forwardedParts,
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
    return handlers;
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
        `SELECT m.role, m.content FROM messages m
         JOIN sessions s ON m.session_id = s.id
         WHERE m.thread_id = ? AND s.parent_session_id IS NULL
         ORDER BY m.created_at DESC LIMIT 20`
      )
      .bind(threadId)
      .all<{ role?: string; content?: string }>();

    const rows = (msgResult.results || []).reverse();
    const continuationContext = buildThreadContinuationContext(rows);
    return {
      ...(persistedSessionId ? { opencodeSessionId: persistedSessionId } : {}),
      ...(continuationContext ? { continuationContext } : {}),
    };
  }

  /**
   * Ensure the channel_state table has the OpenCode session ID for a thread channel.
   * Checks the in-memory cache first; if missing, hydrates from D1's session_threads table.
   * Called from handleSystemMessage and sendNextQueuedPrompt. (handlePrompt calls
   * hydrateThreadResumeContext directly since it also needs continuation context.)
   */
  private async ensureThreadOcSessionHydrated(threadId: string, channelKey: string): Promise<void> {
    const existing = this.getChannelOcSessionId(channelKey);
    if (existing) return;
    const hydrated = await this.hydrateThreadResumeContext(threadId);
    if (hydrated.opencodeSessionId) {
      this.setChannelOcSessionId(channelKey, hydrated.opencodeSessionId);
    }
  }

  private async handlePromptComplete(messageId?: string) {
    // Read channel target BEFORE markCompletedById deletes the row — needed
    // to resolve channel followups so stale reminders don't fire after the
    // prompt has already been handled. Hoisted above try so the catch block
    // can still resolve followups if an error occurs mid-completion.
    const followupChannel = messageId
      ? this.promptQueue.getChannelTargetById(messageId)
      : this.promptQueue.getProcessingChannelContext();

    // Resolve per-channel busy key BEFORE the row is deleted.
    const completedChannelKey = messageId
      ? this.promptQueue.getChannelKeyById(messageId)
      : this.promptQueue.getProcessingChannelKey();

    try {
      this.promptQueue.clearDispatchTimers();

      // Emit turn_complete timing — measure total time from prompt received to completion
      const promptStart = this.promptQueue.promptReceivedAt;
      if (promptStart > 0) {
        // Read model from the processing prompt_queue entry before it's marked completed
        const turnModel = this.promptQueue.getProcessingModel() || undefined;
        // Resolve channel from the specific prompt's messageId; no fallback to
        // mutable state. If messageId is absent or the row is gone (e.g. queue
        // was already pruned), emit without channel attribution rather than
        // attributing to an arbitrary channel.
        const completedLookup = messageId ? this.getChannelForMessage(messageId) : null;
        const completedCh = completedLookup?.found ? completedLookup.target : null;
        this.emitEvent('turn_complete', {
          durationMs: Date.now() - promptStart,
          channel: completedCh?.channelType || undefined,
          model: turnModel,
          queueMode: this.promptQueue.queueMode || undefined,
        });
        this.promptQueue.clearPromptReceived();
      }

      this.emitAuditEvent('agent.turn_complete', 'Agent turn completed');

      // Mark processing → completed, then prune
      const processingCount = this.promptQueue.markCompletedById(messageId);

      // Clear per-channel busy state for the completed channel.
      if (completedChannelKey) {
        this.promptQueue.setChannelBusy(completedChannelKey, false);
      }

      // If scoped messageId was already completed (e.g. dedup path sent a second
      // complete for the same prompt), skip the queue drain and idle transition —
      // the first complete already handled it.
      if (messageId && processingCount === 0) {
        console.log(`[SessionAgentDO] handlePromptComplete: messageId=${messageId} already completed, skipping`);
        return;
      }

      // Resolve channel followups so the alarm doesn't inject stale reminders.
      await this.resolveFollowupsForCompletedPrompt(followupChannel);

      const queuedAfterPrune = this.promptQueue.length;
      console.log(`[SessionAgentDO] handlePromptComplete: marked ${processingCount} processing→completed, queuedRemaining=${queuedAfterPrune}`);

      if (await this.sendNextQueuedPrompt()) {
        console.log(`[SessionAgentDO] handlePromptComplete: dispatched next queued prompt, keeping runnerBusy=true`);
        // More work in the queue — flush messages synchronously so they survive hibernation
        await this.flushMessagesToD1();
        return;
      }

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

      // Only mark runner idle if no other channels are still processing.
      // With concurrent per-thread dispatch, channel A completing doesn't
      // mean channel B is done.
      const stillBusyChannel = this.promptQueue.getBusyChannelKey();
      if (stillBusyChannel) {
        console.log(`[SessionAgentDO] handlePromptComplete: queue empty but channel ${stillBusyChannel} still busy`);
      } else {
        console.log(`[SessionAgentDO] handlePromptComplete: queue empty, setting runnerBusy=false`);
        this.promptQueue.runnerBusy = false;
        this._activeWorkflowExecutionId = undefined;
        this.broadcastToClients({
          type: 'status',
          data: { runnerBusy: false },
        });
        this.notifyParentIfIdle();
      }
    } catch (err) {
      // Ensure runnerBusy is cleared even on error to prevent permanent stuck state
      console.error('[SessionAgentDO] handlePromptComplete error, forcing runnerBusy=false:', err);
      this.promptQueue.runnerBusy = false;
      this._activeWorkflowExecutionId = undefined;
      if (completedChannelKey) {
        this.promptQueue.setChannelBusy(completedChannelKey, false);
      }
      this.broadcastToClients({
        type: 'status',
        data: { runnerBusy: false },
      });

      // Best-effort: resolve followups even on error so stale reminders don't
      // compound the problem.
      try { await this.resolveFollowupsForCompletedPrompt(followupChannel); } catch { /* ignore */ }
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
    this.runnerLink.ready = false; // clear stale ready state from previous lifecycle
    this.promptQueue.runnerBusy = false;
    this.promptQueue.clearAllChannelBusy();
    this.promptQueue.queueMode = body.queueMode || 'followup';
    this.promptQueue.collectDebounceMs = body.collectDebounceMs || 3000;

    // If sandbox info was provided directly, we're already running
    if (body.sandboxId && body.tunnelUrls) {
      this.sessionState.status = 'running';
      this.sessionState.sandboxStartedAt = Date.now();
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

      // Capture generation before the (potentially slow) spawn call so we can
      // detect if a newer recovery/refresh started while we were waiting.
      const expectedGeneration = this.sessionState.sandboxGeneration;

      const result = await this.lifecycle.spawnSandbox(backendUrl, spawnRequest);

      // Guard against stale spawn — a newer recovery/refresh may have started
      // while this spawn was in flight. Discard the result to avoid overwriting
      // the newer state. The orphaned sandbox will idle-terminate on its own.
      if (this.sessionState.sandboxGeneration !== expectedGeneration) {
        console.warn(
          `[SessionAgentDO] Stale spawn result discarded — generation ${expectedGeneration} vs current ${this.sessionState.sandboxGeneration}; sandbox ${result.sandboxId} will idle-terminate`,
        );
        return;
      }

      this.emitEvent('sandbox_wake', { durationMs: result.durationMs });

      // Store sandbox info — transition to waiting_runner until Runner connects
      // and signals readiness via agentStatus: idle.
      this.sessionState.sandboxId = result.sandboxId;
      this.sessionState.sandboxStartedAt = Date.now();
      this.sessionState.tunnelUrls = result.tunnelUrls;
      this.sessionState.status = 'waiting_runner';
      this.lifecycle.markRunningStarted();

      updateSessionStatus(this.appDb, sessionId!, 'waiting_runner', result.sandboxId).catch((err) =>
        console.error('[SessionAgentDO] Failed to sync status to D1:', err),
      );

      this.broadcastToClients({
        type: 'status',
        data: {
          status: 'waiting_runner',
          sandboxRunning: true,
          tunnelUrls: result.tunnelUrls,
        },
      });

      this.rescheduleIdleAlarm();
      console.log(`[SessionAgentDO] Sandbox spawned: ${result.sandboxId} for session ${sessionId}`);
    } catch (err) {
      console.error(`[SessionAgentDO] Failed to spawn sandbox for session ${sessionId}:`, err);
      const errorText = `Failed to create sandbox: ${err instanceof Error ? err.message : String(err)}`;

      // If this spawn was triggered by recovery, let the circuit breaker decide
      if (this.sessionState.status === 'initializing' && this.sessionState.recoveryAttemptCount > 0) {
        console.log(`[SessionAgentDO] Recovery spawn failed for ${sessionId}: ${errorText}`);
        await this.performRecovery(`spawn_failed: ${errorText}`);
        return;
      }

      // First-time spawn failure (from handleStart) — hard error
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
      await this.notifyParentEvent(`Child session event: ${sessionId} errored (${errorText}).`, { wake: true, childStatus: 'error' });
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

    // Expire session-scoped action policy overrides before stopping the runner
    // so no in-flight tool call can sneak through with a stale auto-allow.
    if (sessionId) {
      await deleteSessionActionPolicyOverrides(this.appDb, sessionId);
    }

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
    this.sessionState.sandboxStartedAt = 0;
    this.sessionState.tunnelUrls = null;
    this.sessionState.tunnels = [];
    this.sessionState.snapshotImageId = undefined;
    this.promptQueue.runnerBusy = false;
    this.promptQueue.clearAll();
    this.ctx.storage.sql.exec('DELETE FROM channel_followups');

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

    // Parent-initiated stops (cascade or explicit terminate_session tool) don't need to wake
    // the parent — it already knows. Only wake for autonomous completions, errors, etc.
    const parentInitiated = reason === 'parent_stopped' || reason === 'terminated_by_parent';
    await this.notifyParentEvent(`Child session event: ${sessionId} completed (reason: ${reason}).`, { wake: !parentInitiated, childStatus: reason === 'error' ? 'error' : 'terminated' });

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
      recoveryAttemptCount: this.sessionState.recoveryAttemptCount,
      backoffUntil: this.sessionState.backoffUntil > 0 ? this.sessionState.backoffUntil : null,
      lastFailureReason: this.sessionState.lastFailureReason || null,
      sandboxGeneration: this.sessionState.sandboxGeneration,
      sandboxWakeStartedAt: this.sessionState.sandboxWakeStartedAt || null,
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
      // Prefer DO state, fall back to D1 — the DO value can be lost if the
      // child session is re-initialized (e.g., orchestrator restart clears
      // the prompt queue before the spawn-child message arrives).
      const doThreadId = this.sessionState.parentThreadId;
      const d1ThreadId = session?.parentThreadId;
      const parentThreadId = doThreadId || d1ThreadId;
      if (!doThreadId && d1ThreadId) {
        console.warn(`[SessionAgentDO] notifyParentEvent: DO state missing parentThreadId, falling back to D1 — child=${sessionId} parent=${parentSessionId} threadId=${d1ThreadId} status=${options?.childStatus}`);
      } else {
        console.log(`[SessionAgentDO] notifyParentEvent: child=${sessionId} parent=${parentSessionId} parentThreadId=${parentThreadId || 'NONE'} status=${options?.childStatus}`);
      }
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
    if (parts?.childSessionId) {
      console.log(`[SessionAgentDO] handleSystemMessage: childEvent childSession=${parts.childSessionId} childStatus=${parts.childStatus} threadId=${threadId || 'NONE'} wake=${wake}`);
    }
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
        const notifyOn = sub.notifyOn || 'status_change';

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
      const sysQueueChannelKey = this.channelKeyFrom(sysChannelType, sysChannelId);

      const status = this.sessionState.status;
      if (status === 'hibernated') {
        // Queue the prompt so the runner picks it up after connecting.
        this.promptQueue.enqueue({ id: messageId, content, threadId, channelType: sysChannelType, channelId: sysChannelId, channelKey: sysQueueChannelKey, childSessionId: queueChildSessionId, childStatus: queueChildStatus });
        this.ctx.waitUntil(this.performWake());
      } else if (status === 'restoring') {
        // Wake already in progress — just queue the prompt for when the runner connects.
        this.promptQueue.enqueue({ id: messageId, content, threadId, channelType: sysChannelType, channelId: sysChannelId, channelKey: sysQueueChannelKey, childSessionId: queueChildSessionId, childStatus: queueChildStatus });
      } else if (status === 'running') {
        // Dispatch the system event as a prompt so the runner wakes up and can
        // decide whether to act on it (e.g. child session idle/completed events).
        const runnerBusy = this.promptQueue.runnerBusy;
        if (this.runnerLink.isConnected && this.runnerLink.isReady && !runnerBusy) {
          // Runner is connected and idle — insert as 'processing' for recoverability, then dispatch
          const sysChannelKey = this.channelKeyFrom(sysChannelType, sysChannelId);
          this.promptQueue.enqueue({ id: messageId, content, threadId, channelType: sysChannelType, channelId: sysChannelId, channelKey: sysChannelKey, status: 'processing', childSessionId: queueChildSessionId, childStatus: queueChildStatus });
          this.promptQueue.stampDispatched(sysChannelKey);
          this.sessionState.lastParentIdleNotice = undefined;
          this.sessionState.parentIdleNotifyAt = 0;
          this.sessionState.waitSubscription = null;
          const ownerId = this.sessionState.userId;
          const ownerDetails = ownerId ? await this.getUserDetails(ownerId) : undefined;
          const sysModelPrefs = await this.resolveModelPreferences(ownerDetails);
          if (threadId) {
            await this.ensureThreadOcSessionHydrated(threadId, sysChannelKey);
          }
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
          this.promptQueue.enqueue({ id: messageId, content, threadId, channelType: sysChannelType, channelId: sysChannelId, channelKey: sysQueueChannelKey, childSessionId: queueChildSessionId, childStatus: queueChildStatus });
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

    if (!this.runnerLink.isReady) {
      return queueWorkflowDispatch('runner_not_ready');
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

    // Track execution ID so isUnattended checks during this turn know it's a
    // workflow execution (no queue row exists on the direct-dispatch path).
    this._activeWorkflowExecutionId = executionId;

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
    if (!this.runnerLink.isReady) {
      console.log(`[SessionAgentDO] sendNextQueuedPrompt: runner connected but not ready, skipping`);
      return false;
    }

    // Drain as many queued prompts as we can dispatch in one pass. Items on
    // different channels can run concurrently (TKAI-65), so when the runner
    // wakes up to a queue of N cross-channel prompts we fire them all instead
    // of dispatching one and waiting for it to finish before sending the next.
    // `skippedBusyIds` prevents the dequeue/revert pair from cycling forever
    // on rows whose channels are still busy after we already passed them.
    // We snapshot `waitSubscription` because `dispatchQueuedPromptEntry`
    // clears it on every successful dispatch — without the snapshot, the
    // first dispatch's clear would silently disable child-event filtering for
    // items 2..N in the same pass.
    let dispatchedAny = false;
    const skippedBusyIds = new Set<string>();
    const waitSubscriptionSnapshot = this.sessionState.waitSubscription;

    while (true) {
      const next = this.pickNextDispatchableQueuedPrompt(skippedBusyIds, waitSubscriptionSnapshot);
      if (!next) {
        if (!dispatchedAny) {
          console.log(`[SessionAgentDO] sendNextQueuedPrompt: no queued items`);
        }
        break;
      }

      const ok = await this.dispatchQueuedPromptEntry(next);
      if (!ok) {
        // Dispatch failed — revert + audit already happened inside the helper.
        // Don't keep trying; the runner is likely unhealthy.
        break;
      }
      dispatchedAny = true;
    }

    return dispatchedAny;
  }

  /**
   * Select the next queue row that can be dispatched right now: drops
   * malformed/filtered entries, reverts rows whose channels are busy, and
   * returns the first row marked 'processing' that's ready to send.
   *
   * `skippedBusyIds` is mutated to remember rows already reverted as busy in
   * this drain pass. We pass that set into `dequeueNext` so each subsequent
   * pick advances past those rows instead of cycling on the oldest one.
   *
   * `waitSubscription` is a snapshot taken at drain entry so child-event
   * filtering uses the subscription that was in effect when the drain
   * started, not whatever a mid-drain dispatch left behind.
   */
  private pickNextDispatchableQueuedPrompt(
    skippedBusyIds: Set<string>,
    waitSubscription: { reason?: string; sessionIds?: string[]; notifyOn?: string; statuses?: string[] } | null,
  ): QueueEntry | null {
    // When a wait subscription is active, prefer child events that match the
    // subscription (dispatched directly by handleSystemMessage's wake path,
    // not via the queue — but legacy queued events may exist). If the next
    // child event in the queue matches, dispatch it; otherwise fall through
    // to general dispatch and let the user prompt wake the agent — per the
    // orchestrator persona, user messages always wake an agent that yielded
    // via wait_for_event. The subscription is cleared at dispatch time below.
    let prompt = this.promptQueue.dequeueNext(skippedBusyIds);
    while (prompt) {
      console.log(`[SessionAgentDO] sendNextQueuedPrompt: found queued item id=${prompt.id} channelType=${prompt.channelType || 'none'} channelId=${prompt.channelId || 'none'} queueType=${prompt.queueType || 'prompt'}`);

      // Apply wait subscription filter to queued child events.
      // Events queued while the agent was busy may not match the subscription
      // the agent registered via wait_for_event — drop them and try the next entry.
      let shouldSkip = false;
      if (prompt.childSessionId) {
        const queueSub = waitSubscription;
        if (queueSub) {
          const terminalStatuses = new Set(['terminated', 'error', 'hibernated']);
          const notifyOn = queueSub.notifyOn || 'status_change';

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
        prompt = this.promptQueue.dequeueNext(skippedBusyIds);
        continue;
      }

      // Runner-exclusivity check, mirroring the live handlePrompt path:
      //   - workflow_execute holds the runner exclusively (its stampDispatched
      //     sets runnerBusy without a channel marker). Don't dispatch one if
      //     anything is in flight, and don't dispatch anything else while one
      //     is in flight.
      //   - For regular prompts, refuse to dispatch when runnerBusy is set but
      //     no channel is tracked — that signals an untracked turn (workflow
      //     or recovery) owns the runner.
      const isWorkflow = prompt.queueType === 'workflow_execute';
      const anyChannelBusy = this.promptQueue.getBusyChannelKey() !== null;
      const blockedByExclusivity = isWorkflow
        ? (this.promptQueue.runnerBusy || anyChannelBusy)
        : (this.promptQueue.runnerBusy && !anyChannelBusy);
      if (blockedByExclusivity) {
        console.log(`[SessionAgentDO] sendNextQueuedPrompt: skipping item ${prompt.id} — runner exclusively busy (isWorkflow=${isWorkflow} runnerBusy=${this.promptQueue.runnerBusy} anyChannelBusy=${anyChannelBusy})`);
        skippedBusyIds.add(prompt.id);
        this.promptQueue.revertProcessingToQueued(prompt.id);
        prompt = this.promptQueue.dequeueNext(skippedBusyIds);
        continue;
      }

      // Skip items whose target channel is already busy (concurrent dispatch).
      // Don't drop — revert to queued so they dispatch when the channel completes.
      const queuedChannelKey = prompt.channelKey || this.channelKeyFrom(prompt.channelType || undefined, prompt.channelId || undefined);
      if (this.promptQueue.isChannelBusy(queuedChannelKey)) {
        console.log(`[SessionAgentDO] sendNextQueuedPrompt: skipping item ${prompt.id} — channel ${queuedChannelKey} is busy`);
        skippedBusyIds.add(prompt.id);
        this.promptQueue.revertProcessingToQueued(prompt.id);
        prompt = this.promptQueue.dequeueNext(skippedBusyIds);
        continue;
      }

      return prompt;
    }

    return null;
  }

  /**
   * Dispatch a single queue entry that has already been marked 'processing'
   * by {@link pickNextDispatchableQueuedPrompt}. Returns true on a successful
   * runner send; on failure (send refused or any other thrown error during
   * the dispatch body) the row is reverted to 'queued' and false is returned.
   *
   * Channel-busy/wait-subscription filtering is the caller's job. The body
   * is wrapped in try/catch so a mid-drain exception only reverts THIS row;
   * earlier successfully-dispatched rows stay 'processing' so they aren't
   * silently re-sent to the runner on the next drain pass.
   */
  private async dispatchQueuedPromptEntry(prompt: QueueEntry): Promise<boolean> {
    try {
      return await this.dispatchQueuedPromptEntryUnsafe(prompt);
    } catch (err) {
      console.error(
        `[SessionAgentDO] dispatchQueuedPromptEntry: error dispatching ${prompt.id}, reverting to queued:`,
        err,
      );
      this.promptQueue.revertProcessingToQueued(prompt.id);
      this.emitAuditEvent(
        'prompt.dispatch_failed',
        `Queue dispatch threw: ${prompt.id.slice(0, 8)}`,
      );
      return false;
    }
  }

  private async dispatchQueuedPromptEntryUnsafe(prompt: QueueEntry): Promise<boolean> {
    // ─── Deferred user message write ───────────────────────────────────
    // User messages are not written to the message store at enqueue time.
    // Write + broadcast now at dispatch time. Uses INSERT OR IGNORE for
    // idempotency in case of crash recovery (revertProcessingToQueued).
    if (prompt.queueType === 'prompt' && !prompt.childSessionId) {
      // Check if message was already written (e.g., direct dispatch then revert-to-queued)
      const alreadyWritten = this.messageStore.hasMessage(prompt.id);

      if (!alreadyWritten) {
        const queuedAttachments = prompt.attachments ? JSON.parse(prompt.attachments) : [];
        const attachmentParts = attachmentPartsForDisplay(queuedAttachments);

        this.messageStore.writeMessage({
          id: prompt.id,
          role: 'user',
          content: prompt.content,
          parts: attachmentParts.length > 0 ? JSON.stringify(attachmentParts) : null,
          author: prompt.authorId ? {
            id: prompt.authorId,
            email: prompt.authorEmail || undefined,
            name: prompt.authorName || undefined,
            avatarUrl: prompt.authorAvatarUrl || undefined,
          } : undefined,
          channelType: prompt.channelType || undefined,
          channelId: prompt.channelId || undefined,
          threadId: prompt.threadId || undefined,
        });

        // Thread bookkeeping (deferred from enqueue time)
        if (prompt.threadId) {
          this.ctx.waitUntil(incrementThreadMessageCount(this.env.DB, prompt.threadId));
          this.broadcastToClients({ type: 'thread.created', threadId: prompt.threadId });
        }

        // Broadcast user message to clients (message enters the chat at this point)
        this.broadcastToClients({
          type: 'message',
          data: {
            id: prompt.id,
            role: 'user',
            content: prompt.content,
            parts: attachmentParts.length > 0 ? attachmentParts : undefined,
            authorId: prompt.authorId,
            authorEmail: prompt.authorEmail,
            authorName: prompt.authorName,
            authorAvatarUrl: prompt.authorAvatarUrl,
            channelType: prompt.channelType,
            channelId: prompt.channelId,
            threadId: prompt.threadId,
            createdAt: Math.floor(Date.now() / 1000),
          },
        });

        this.emitAuditEvent('user.prompt', prompt.content?.slice(0, 120) || '[empty]', prompt.authorId || undefined);
      }

      // Always broadcast queue.state to clear the pending card
      this.broadcastToClients({
        type: 'queue.state',
        data: { pending: null },
      });
    }

    if (prompt.queueType === 'workflow_execute') {
      const queuedExecutionId = (prompt.workflowExecutionId || '').trim();
      const queuedPayload = parseQueuedWorkflowPayload(prompt.workflowPayload)!;

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

    const queueChannelType = prompt.channelType || undefined;
    const queueChannelId = prompt.channelId || undefined;
    const queueThreadId = prompt.threadId || undefined;
    const queueReplyChannelType = prompt.replyChannelType || undefined;
    const queueReplyChannelId = prompt.replyChannelId || undefined;
    if (queueReplyChannelType && queueReplyChannelId) {
      this.insertChannelFollowup(queueReplyChannelType, queueReplyChannelId, prompt.content);
    } else if (queueThreadId) {
      const origin = await getThreadOriginChannel(this.env.DB, queueThreadId);
      if (origin && origin.channelType !== 'web' && origin.channelType !== 'thread') {
        this.insertChannelFollowup(origin.channelType, origin.channelId, prompt.content);
      }
    }

    // Resolve model preferences from session owner (with org fallback)
    const queueOwnerId = this.sessionState.userId;
    const queueOwnerDetails = queueOwnerId ? await this.getUserDetails(queueOwnerId) : undefined;
    const queueModelPrefs = await this.resolveModelPreferences(queueOwnerDetails);
    const queueChannelKey = this.channelKeyFrom(queueChannelType, queueChannelId);

    if (queueThreadId) {
      await this.ensureThreadOcSessionHydrated(queueThreadId, queueChannelKey);
    }

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
      this.emitAuditEvent('prompt.dispatch_failed', `Queue dispatch failed, reverted: ${prompt.id.slice(0, 8)}`);
      return false;
    }
    this.promptQueue.stampDispatched(prompt.channelKey || undefined);
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

    let afterCreatedAt: number | undefined;
    if (after != null) {
      const numericAfter = Number(after);
      if (Number.isFinite(numericAfter)) {
        afterCreatedAt = numericAfter;
      } else {
        const parsedMs = Date.parse(after);
        if (Number.isFinite(parsedMs)) {
          afterCreatedAt = Math.floor(parsedMs / 1000);
        }
      }
    }
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
    // Withdraw pending user prompt and broadcast
    const pending = this.promptQueue.withdrawQueued();
    if (pending) {
      this.broadcastToClients({
        type: 'queue.withdrawn',
        data: {
          messageId: pending.id,
          content: pending.content,
          attachments: pending.attachments ? attachmentsForClientState(JSON.parse(pending.attachments)) : undefined,
          threadId: pending.threadId,
        },
      });
    }

    // Clear remaining queued entries (workflow events, child events)
    const cleared = this.promptQueue.clearQueued();

    this.broadcastToClients({
      type: 'queue.state',
      data: { pending: null },
    });

    // Keep legacy broadcast for backwards compatibility
    this.broadcastToClients({
      type: 'status',
      data: { queueCleared: true, cleared: cleared + (pending ? 1 : 0) },
    });

    return Response.json({ success: true, cleared: cleared + (pending ? 1 : 0) });
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

  private async handleEnsureRunning(): Promise<Response> {
    const status = this.sessionState.status;

    switch (status) {
      case 'running':
        return Response.json({ status: 'running' }, { status: 200 });

      case 'initializing': {
        // Distinguish: actively spawning vs brand-new DO with no config
        if (!this.sessionState.spawnRequest || !this.sessionState.backendUrl) {
          return Response.json(
            { status: 'error', error: 'Missing spawn configuration — session needs re-initialization via /start' },
            { status: 500 },
          );
        }
        return Response.json({ status }, { status: 202 });
      }

      case 'waiting_runner':
      case 'restoring':
      case 'recovering':
        return Response.json({ status }, { status: 202 });

      case 'backoff': {
        const now = Date.now();
        const backoffUntil = this.sessionState.backoffUntil;
        if (backoffUntil > 0 && now >= backoffUntil) {
          // Cooldown elapsed — reset circuit breaker before retrying
          this.sessionState.resetRecoveryState();
          await this.performRecovery('ensure_running_after_backoff');
          return Response.json({ status: 'recovering' }, { status: 202 });
        }
        const retryAfterMs = Math.max(0, backoffUntil - now);
        return Response.json({ status: 'backoff', retryAfterMs }, { status: 503 });
      }

      case 'hibernating':
        return Response.json({ status: 'hibernating' }, { status: 202 });

      case 'hibernated':
        this.ctx.waitUntil(this.performWake());
        return Response.json({ status: 'restoring' }, { status: 202 });

      case 'terminated':
      case 'error': {
        // Dead state — attempt recovery/spawn
        if (!this.sessionState.spawnRequest || !this.sessionState.backendUrl) {
          return Response.json(
            { status: 'error', error: 'Missing spawn configuration — session needs re-initialization via /start' },
            { status: 500 },
          );
        }
        await this.performRecovery('ensure_running');
        return Response.json({ status: 'recovering' }, { status: 202 });
      }

      default:
        return Response.json({ status }, { status: 200 });
    }
  }

  private async handleRefresh(): Promise<Response> {
    const sessionId = this.sessionState.sessionId;
    console.log(`[SessionAgentDO] Refresh requested for ${sessionId}`);

    // Terminate existing sandbox (if any)
    const currentStatus = this.sessionState.status;
    if (currentStatus === 'running' || currentStatus === 'waiting_runner' || currentStatus === 'initializing') {
      this.runnerLink.send({ type: 'stop' });
      const runnerSockets = this.ctx.getWebSockets('runner');
      for (const ws of runnerSockets) {
        try { ws.close(1000, 'Session refreshing'); } catch { /* ignore */ }
      }
      await this.lifecycle.terminateSandbox();
    }

    // Clear state for fresh start
    this.sessionState.sandboxId = undefined;
    this.sessionState.sandboxStartedAt = 0;
    this.sessionState.tunnelUrls = null;
    this.sessionState.tunnels = [];
    this.sessionState.snapshotImageId = undefined;
    this.promptQueue.runnerBusy = false;
    this.runnerLink.ready = false;

    // Check we have spawn config
    if (!this.sessionState.spawnRequest || !this.sessionState.backendUrl) {
      return Response.json(
        { status: 'error', error: 'Missing spawn configuration — session needs re-initialization via /start' },
        { status: 500 },
      );
    }

    // Expire session-scoped action policy overrides — the sandbox is being
    // replaced, so ephemeral "allow for this session" approvals should not
    // carry over to the fresh OpenCode instance.
    if (sessionId) {
      await deleteSessionActionPolicyOverrides(this.appDb, sessionId);
    }

    // Explicit refresh — reset circuit breaker so the user can force a restart
    this.sessionState.resetRecoveryState();

    // Spawn fresh via recovery path (handles token rotation, generation increment)
    await this.performRecovery('refresh');

    return Response.json({ status: 'recovering' }, { status: 202 });
  }

  private logModalHardTimeoutEdgeIfNeeded(reason: string, now: number): void {
    if (reason !== 'sandbox_lost') return;

    const sandboxStartedAt = this.sessionState.sandboxStartedAt;
    if (!sandboxStartedAt) return;

    const sandboxAgeMs = now - sandboxStartedAt;
    if (sandboxAgeMs < SessionAgentDO.MODAL_SANDBOX_TIMEOUT_EDGE_THRESHOLD_MS) return;

    const sandboxId = this.sessionState.sandboxId;
    const sessionId = this.sessionState.sessionId;
    const modalTimeoutMs = SessionAgentDO.MODAL_SANDBOX_MAX_LIFETIME_MS;

    console.error(
      `[SessionAgentDO] Modal sandbox hard timeout edge: sandbox_lost after ${Math.round(sandboxAgeMs / 60_000)}m (session=${sessionId || 'unknown'}, sandbox=${sandboxId || 'unknown'})`,
    );

    this.emitEvent('session.recovery', {
      summary: 'modal_sandbox_hard_timeout_edge',
      properties: {
        reason,
        sandboxId,
        sandboxStartedAt,
        sandboxAgeMs,
        modalTimeoutMs,
        sessionId,
      },
    });
  }

  /**
   * Attempt to recover from a sandbox loss by respawning the sandbox.
   * Called when the runner grace period expires instead of immediately terminating.
   *
   * Flow:
   * 1. Transition to 'recovering' → broadcast + D1 sync
   * 2. Revert any in-flight prompt back to queued
   * 3. Rotate the runner token and increment sandbox generation
   * 4. Circuit breaker: if >3 attempts in 10 minutes, backoff (orchestrators) or terminate (regular)
   * 5. Otherwise: transition to 'initializing' and respawn the sandbox
   */
  private async performRecovery(reason: string): Promise<void> {
    const sessionId = this.sessionState.sessionId;
    const now = Date.now();

    console.log(`[SessionAgentDO] performRecovery(${reason}) for session ${sessionId}`);
    this.logModalHardTimeoutEdgeIfNeeded(reason, now);

    // ─── 1. Transition to recovering ────────────────────────────────
    this.sessionState.status = 'recovering';
    this.broadcastToClients({
      type: 'status',
      data: { status: 'recovering' },
    });
    if (sessionId) {
      updateSessionStatus(this.appDb, sessionId, 'recovering').catch((e) =>
        console.error('[SessionAgentDO] Failed to sync recovering status to D1:', e),
      );
    }

    // ─── 2. Revert in-flight prompts back to queued ─────────────────
    const stuckProcessing = this.promptQueue.processingCount;
    if (stuckProcessing > 0) {
      console.log(`[SessionAgentDO] Recovery: reverting ${stuckProcessing} processing entries to queued`);
      this.promptQueue.revertProcessingToQueued();
    }
    this.promptQueue.runnerBusy = false;
    this.promptQueue.clearDispatchTimers();

    // ─── 3. Rotate runner token and increment generation ────────────
    this.runnerLink.token = crypto.randomUUID();
    this.sessionState.sandboxGeneration = this.sessionState.sandboxGeneration + 1;
    this.runnerLink.ready = false;

    // ─── 4. Update recovery counters ────────────────────────────────
    this.sessionState.recoveryAttemptCount = this.sessionState.recoveryAttemptCount + 1;
    this.sessionState.lastRecoveryAt = now;
    this.sessionState.lastFailureReason = reason;

    const attemptCount = this.sessionState.recoveryAttemptCount;
    console.log(`[SessionAgentDO] Recovery attempt #${attemptCount} for session ${sessionId} (reason: ${reason})`);

    this.emitEvent('sandbox_recovery', {
      summary: `Recovery attempt #${attemptCount}: ${reason}`,
      properties: { attempt: attemptCount, reason },
    });

    // ─── 5. Circuit breaker check ───────────────────────────────────
    // Trip if more than 3 consecutive recovery attempts without success.
    // The counter is reset to 0 when the runner signals readiness (resetRecoveryState),
    // so reaching >3 means repeated rapid failures without any healthy interval.
    const CIRCUIT_BREAKER_MAX_ATTEMPTS = 3;

    if (attemptCount > CIRCUIT_BREAKER_MAX_ATTEMPTS) {
      const isOrchestrator = sessionId?.startsWith('orchestrator:') ?? false;

      if (isOrchestrator) {
        // Orchestrators get exponential backoff: 1min, 5min, 15min cap
        const backoffTiers = [60_000, 300_000, 900_000]; // 1m, 5m, 15m
        const tierIndex = Math.min(attemptCount - CIRCUIT_BREAKER_MAX_ATTEMPTS - 1, backoffTiers.length - 1);
        const backoffMs = backoffTiers[tierIndex];
        const backoffUntil = now + backoffMs;

        console.log(`[SessionAgentDO] Circuit breaker tripped for orchestrator ${sessionId} — backoff ${backoffMs / 1000}s (attempt #${attemptCount})`);

        this.sessionState.status = 'backoff';
        this.sessionState.backoffUntil = backoffUntil;

        if (sessionId) {
          updateSessionStatus(this.appDb, sessionId, 'backoff').catch((e) =>
            console.error('[SessionAgentDO] Failed to sync backoff status to D1:', e),
          );
        }

        const msgId = crypto.randomUUID();
        this.messageStore.writeMessage({
          id: msgId,
          role: 'system',
          content: `Sandbox recovery failed after ${attemptCount} attempts. Backing off for ${Math.round(backoffMs / 1000)}s before retrying.`,
        });
        this.broadcastToClients({
          type: 'status',
          data: { status: 'backoff' },
        });
        this.broadcastToClients({
          type: 'message',
          data: {
            id: msgId,
            role: 'system',
            content: `Sandbox recovery failed after ${attemptCount} attempts. Backing off for ${Math.round(backoffMs / 1000)}s before retrying.`,
            createdAt: Math.floor(now / 1000),
          },
        });

        this.emitAuditEvent('session.backoff', `Circuit breaker tripped — backoff ${backoffMs / 1000}s`);
        // Alarm will be rescheduled by the caller with backoffDeadline from collectAlarmDeadlines
        return;
      } else {
        // Regular sessions terminate after exhausting recovery attempts
        console.log(`[SessionAgentDO] Circuit breaker tripped for session ${sessionId} — terminating (recovery exhausted)`);
        this.emitAuditEvent('session.recovery_exhausted', `Recovery exhausted after ${attemptCount} attempts`);
        await this.handleStop('recovery_exhausted');
        return;
      }
    }

    // ─── 6. Respawn sandbox ─────────────────────────────────────────
    const backendUrl = this.sessionState.backendUrl;
    const spawnRequest = this.sessionState.spawnRequest;

    if (!backendUrl || !spawnRequest) {
      console.error(`[SessionAgentDO] Cannot recover session ${sessionId}: missing backendUrl or spawnRequest`);
      this.sessionState.status = 'error';
      if (sessionId) {
        updateSessionStatus(this.appDb, sessionId, 'error', undefined, 'Cannot recover: missing spawn configuration').catch((e) =>
          console.error('[SessionAgentDO] Failed to sync error status to D1:', e),
        );
      }
      this.broadcastToClients({ type: 'status', data: { status: 'error' } });
      this.broadcastToClients({ type: 'error', error: 'Cannot recover: missing spawn configuration' });
      return;
    }

    // Update the stored spawnRequest with the new runner token so the respawned
    // sandbox connects with the rotated credentials.
    const updatedSpawnRequest = { ...spawnRequest, runnerToken: this.runnerLink.token };
    this.sessionState.spawnRequest = updatedSpawnRequest;

    this.sessionState.status = 'initializing';
    this.broadcastToClients({
      type: 'status',
      data: { status: 'initializing' },
    });
    if (sessionId) {
      updateSessionStatus(this.appDb, sessionId, 'initializing').catch((e) =>
        console.error('[SessionAgentDO] Failed to sync initializing status to D1:', e),
      );
    }

    this.emitAuditEvent('session.recovering', `Respawning sandbox (attempt #${attemptCount})`);

    // Spawn in background — same pattern as handleStart
    this.ctx.waitUntil(this.spawnSandbox(backendUrl, updatedSpawnRequest));
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

    console.log(`[SessionAgentDO] performHibernate starting for session ${sessionId}`);

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

      // Expire session-scoped action policy overrides before snapshot/stop
      // so no in-flight tool call can sneak through with a stale auto-allow.
      if (sessionId) {
        await deleteSessionActionPolicyOverrides(this.appDb, sessionId);
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
      this.sessionState.sandboxStartedAt = 0;
      this.sessionState.tunnelUrls = null;
      this.sessionState.tunnels = [];
      this.promptQueue.runnerBusy = false;
      this.runnerLink.ready = false; // runner is gone — clear ready state for next wake
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
      await this.notifyParentEvent(`Child session event: ${sessionId} hibernated.`, { wake: true, childStatus: 'hibernated' });

      this.promptQueue.revertProcessingToQueued();

      // Resolve all pending followups — sandbox is gone so reminders can't be
      // acted on until the session wakes, and by then the context is stale.
      this.ctx.storage.sql.exec("UPDATE channel_followups SET status = 'resolved' WHERE status = 'pending'");

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
      await this.notifyParentEvent(`Child session event: ${sessionId} errored (${errorText}).`, { wake: true, childStatus: 'error' });
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
    console.log(`[SessionAgentDO] performWake starting for session ${sessionId} (snapshotId=${this.sessionState.snapshotImageId ?? 'none'})`);

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
      await this.notifyParentEvent(`Child session event: ${sessionId} errored (${errorText}).`, { wake: true, childStatus: 'error' });
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

      // State writes from result — transition to waiting_runner until Runner reconnects
      // and signals readiness via agentStatus: idle.
      this.sessionState.sandboxId = result.sandboxId;
      this.sessionState.sandboxStartedAt = Date.now();
      this.sessionState.tunnelUrls = result.tunnelUrls;
      this.sessionState.snapshotImageId = undefined;
      this.sessionState.status = 'waiting_runner';
      this.lifecycle.markRunningStarted();
      this.lifecycle.touchActivity();

      this.rescheduleIdleAlarm();

      if (sessionId) {
        updateSessionStatus(this.appDb, sessionId, 'waiting_runner', result.sandboxId).catch((e) =>
          console.error('[SessionAgentDO] Failed to sync waiting_runner status to D1:', e),
        );
      }

      this.broadcastToClients({
        type: 'status',
        data: {
          status: 'waiting_runner',
          sandboxRunning: true,
          tunnelUrls: result.tunnelUrls,
        },
      });

      this.emitAuditEvent('session.restored', 'Session restored from hibernation');
      console.log(`[SessionAgentDO] Session ${sessionId} restored, new sandbox: ${result.sandboxId}`);
    } catch (err) {
      console.error(`[SessionAgentDO] Failed to restore session ${sessionId}:`, err);
      const errorText = `Failed to restore session: ${err instanceof Error ? err.message : String(err)}`;
      this.sessionState.sandboxWakeStartedAt = 0;
      await this.performRecovery(`restore_failed: ${errorText}`);
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

    // Stuck-processing watchdog — wake up 5 min after dispatch to check.
    // Skip past deadlines when the runner is connected: the prompt is actively
    // being processed and the health monitor would skip anyway.
    const dispatchMs = this.promptQueue.lastPromptDispatchedAt;
    const watchdogRaw = dispatchMs > 0 ? dispatchMs + 5 * 60 * 1000 : null;
    const now = Date.now();
    const watchdog = watchdogRaw && !(watchdogRaw <= now && this.runnerLink.isConnected)
      ? watchdogRaw
      : null;

    // Error safety-net
    const safetyNet = this.promptQueue.errorSafetyNetAt || null;

    // Parent idle debounce
    const parentIdle = this.sessionState.parentIdleNotifyAt || null;

    // Runner disconnect grace period
    const gracePeriod = this.sessionState.runnerDisconnectedAt
      ? this.sessionState.runnerDisconnectedAt + SessionAgentDO.RUNNER_GRACE_PERIOD_MS
      : null;

    // Idle-queue-stuck watchdog (items queued with runnerBusy=false).
    // Skip when runner is disconnected — can't drain, and runner reconnection
    // will reschedule alarms with fresh deadlines.
    const idleQueued = this.promptQueue.idleQueuedSince;
    const idleQueueDeadline = idleQueued > 0 && this.runnerLink.isConnected
      ? idleQueued + 60 * 1000
      : null;

    // Ready timeout (runner connected but never became ready).
    // Only schedule if the deadline is still in the future — once past,
    // the monitor emits the event and we don't need to re-arm.
    const connectedAt = this.runnerLink.connectedAt;
    const readyRaw = connectedAt && this.runnerLink.isConnected && !this.runnerLink.isReady
      ? connectedAt + 2 * 60 * 1000
      : null;
    const readyDeadline = readyRaw && readyRaw > Date.now() ? readyRaw : null;

    // Backoff timer — wake when the backoff period expires to retry recovery
    const backoffUntil = this.sessionState.backoffUntil;
    const backoffDeadline = backoffUntil > 0 && this.sessionState.status === 'backoff'
      ? backoffUntil
      : null;

    // Sandbox wake timeout — wake after sandbox wake started to check for stuck restores/spawns
    const wakeStarted = this.sessionState.sandboxWakeStartedAt;
    const wakeStatus = this.sessionState.status;
    const wakeDeadline = wakeStarted > 0 && (wakeStatus === 'restoring' || wakeStatus === 'waiting_runner')
      ? wakeStarted + SANDBOX_WAKE_TIMEOUT_MS
      : null;

    return [promptExpiry, followupMs, watchdog, safetyNet, parentIdle, gracePeriod, idleQueueDeadline, readyDeadline, backoffDeadline, wakeDeadline];
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

      // Restore thread_ts when the agent drops it from a Slack reply.
      const processingChannelContext = this.promptQueue.getProcessingChannelContext();
      const storedReplyId = processingChannelContext?.channelId;
      const effectiveChannelId = resolveSlackChannelId(channelType, channelId, storedReplyId);
      if (effectiveChannelId !== channelId) {
        console.log(`[SessionAgentDO] handleChannelReply: restored thread_ts from prompt context (${channelId} -> ${effectiveChannelId})`);
      }

      const result = await this.channelRouter.sendReply({
        userId,
        channelType,
        channelId: effectiveChannelId,
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

      // When Valet sends a new top-level Slack message (2-part channelId = teamId:slackChannelId),
      // bind the resulting thread back to this session so replies route here instead of creating
      // a new session via the orchestrator. Fire-and-forget: binding failure is non-fatal.
      if (channelType === 'slack' && result.messageId) {
        const parts = effectiveChannelId.split(':');
        if (parts.length === 2) {
          const threadChannelId = `${effectiveChannelId}:${result.messageId}`;
          const slackChannelId = parts[1];
          const sessionId = this.sessionState.sessionId;
          this.resolveOrgId().then((orgId) =>
            ensureChannelBinding(this.appDb, {
              sessionId,
              channelType: 'slack',
              channelId: threadChannelId,
              userId,
              orgId: orgId ?? 'default',
              scopeKey: channelScopeKey(userId, 'slack', threadChannelId),
              queueMode: 'followup',
              slackChannelId,
              slackThreadTs: result.messageId,
            }),
          ).catch((err) => {
            console.warn('[SessionAgentDO] Failed to create Slack thread binding:', err instanceof Error ? err.message : String(err));
          });
        }
      }

      this.runnerLink.send({ type: 'channel-reply-result', requestId, success: true } as any);
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

      const orgId = await this.resolveOrgId() ?? 'default';
      const result = await listToolsSvc(this.appDb, this.env.DB, this.env, userId, {
        service,
        query,
        credentialCache: this.credentialCacheAdapter,
        orgId,
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
            message: w.message,
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
    let invocationIdForCleanup: string | null = null;
    let promptInsertedForCleanup = false;
    let shouldFailInvocationOnCatch = false;
    try {
      const userId = this.sessionState.userId;
      const sessionId = this.sessionState.sessionId;
      if (!userId) {
        this.runnerLink.send({ type: 'call-tool-result', requestId, error: 'No userId on session' } as any);
        return;
      }

      const orgId = await this.resolveOrgId() ?? 'default';
      // Resolve policy (validates toolId, checks disabled status, resolves risk level)
      const policyResult = await resolveActionPolicy(this.appDb, this.env.DB, this.env, userId, toolId, params, {
        sessionId: sessionId || '',
        discoveredToolRiskLevels: this.discoveredToolRiskLevels,
        credentialCache: this.credentialCacheAdapter,
        disabledPluginServicesCache: this.disabledPluginServicesCache,
        orgId,
      });

      // Update the disabled plugin services cache from the policy resolution
      this.disabledPluginServicesCache = policyResult.disabledPluginServicesCache;

      const { outcome, invocationId, riskLevel, service, actionId, actionSource } = policyResult;
      invocationIdForCleanup = invocationId;

      // ─── Deny ──────────────────────────────────────────────────────────
      if (outcome === 'denied') {
        this.runnerLink.send({ type: 'call-tool-result', requestId, error: `Action "${toolId}" denied by policy (risk level: ${riskLevel})` } as any);
        this.emitAuditEvent('agent.tool_call', `Action ${toolId} denied by policy`, undefined, { invocationId, riskLevel });
        return;
      }

      // ─── Require Approval ──────────────────────────────────────────────
      if (outcome === 'pending_approval') {
        shouldFailInvocationOnCatch = true;
        if (!summary) {
          const error = `Action "${toolId}" requires approval but no summary was provided. The call_tool summary parameter is required.`;
          await markFailed(this.appDb, invocationId, error).catch((err) => {
            console.error('[SessionAgentDO] Failed to mark invocation failed after missing approval summary:', err);
          });
          this.runnerLink.send({
            type: 'call-tool-result',
            requestId,
            error,
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
          invocationId: invocationId,
          summary,
        };
        // Resolve channel from the processing prompt — deterministic queue state,
        // not a mutable cursor. If no prompt is processing (shouldn't happen inside
        // handleCallTool, which is triggered by agent tool invocations during a turn),
        // leave channel context unset; the approval will still be visible in the web
        // UI via broadcastToClients.
        const approvalCh = this.promptQueue.getProcessingChannelTarget();
        if (approvalCh?.channelType && approvalCh?.channelId) {
          approvalContext.channelType = approvalCh.channelType;
          approvalContext.channelId = approvalCh.channelId;
        }

        // Use model-provided summary as the approval body
        const approvalBody = summary;
        const approvalActions = buildActionApprovalPromptActions();

        // Store in interactive_prompts for alarm-based expiry and later execution
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO interactive_prompts
            (id, type, request_id, title, body, actions, context, status, expires_at)
           VALUES (?, 'approval', ?, ?, ?, ?, ?, 'pending', ?)`,
          invocationId,
          requestId,
          'Action requires approval',
          approvalBody,
          JSON.stringify(approvalActions),
          JSON.stringify(approvalContext),
          expiresAt,
        );
        promptInsertedForCleanup = true;

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
          actions: approvalActions,
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

        await this.sendChannelInteractivePrompts(invocationId, prompt);

        // Schedule alarm for expiry
        await this.ensureActionExpiryAlarm(expiresAt * 1000);

        shouldFailInvocationOnCatch = false;
        return; // Don't send call-tool-result — the runner will wait
      }

      // ─── Allow — execute immediately ───────────────────────────────────
      await this.executeActionAndSend(requestId, toolId, service, actionId, params, userId, actionSource, invocationId, orgId);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (shouldFailInvocationOnCatch && invocationIdForCleanup) {
        await markFailed(this.appDb, invocationIdForCleanup, error).catch((markErr) => {
          console.error('[SessionAgentDO] Failed to mark invocation failed after approval setup error:', markErr);
        });
      }
      if (promptInsertedForCleanup && invocationIdForCleanup) {
        this.ctx.storage.sql.exec('DELETE FROM interactive_prompts WHERE id = ?', invocationIdForCleanup);
      }
      this.runnerLink.send({
        type: 'call-tool-result',
        requestId,
        error,
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
    userId: string,
    actionSource: ReturnType<typeof integrationRegistry.getActions>,
    invocationId: string,
    orgId?: string,
  ): Promise<{ success: boolean; error?: string }> {
    const spawnRequest = this.sessionState.spawnRequest;
    const spawnEnvVars = spawnRequest?.envVars as Record<string, string> | undefined;
    const guardConfig = await this.getGuardConfig();

    let result;
    try {
      result = await executeActionSvc(
        this.appDb, this.env, userId, toolId, service, actionId, params,
        actionSource, invocationId,
        { credentialCache: this.credentialCacheAdapter, spawnEnvVars, guardConfig, orgId: orgId ?? 'default' },
      );
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      await markFailed(this.appDb, invocationId, error).catch((markErr) => {
        console.error('[SessionAgentDO] Failed to mark invocation failed after action execution throw:', markErr);
      });
      this.runnerLink.send({ type: 'call-tool-result', requestId, error } as any);
      this.emitEvent('tool_exec', {
        toolName: toolId,
        errorCode: 'action_failed',
      });
      return { success: false, error };
    }

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

    // Broadcast action images directly to connected clients (in-memory, no
    // SQLite persistence — base64 payloads can exceed D1 row limits). The
    // message store gets a lightweight placeholder so history shows something.
    if (result.success && Array.isArray(result.images) && result.images.length > 0) {
      const imgCh = this.promptQueue.getProcessingChannelTarget();
      for (const img of result.images) {
        if (!img.data || !img.mimeType) continue;
        const imgId = crypto.randomUUID();
        const description = img.description || 'Image';
        const channelFields = {
          ...(imgCh?.channelType ? { channelType: imgCh.channelType } : {}),
          ...(imgCh?.channelId ? { channelId: imgCh.channelId } : {}),
        };

        // Persist a lightweight placeholder (no base64) so chat history
        // records that an image was shown, without bloating D1.
        this.messageStore.writeMessage({
          id: imgId,
          role: 'system',
          content: description,
          parts: JSON.stringify({ type: 'image_ref', mimeType: img.mimeType, description }),
          ...channelFields,
        });

        // Broadcast the full image data in-memory to connected clients
        this.broadcastToClients({
          type: 'message',
          data: {
            id: imgId,
            role: 'system',
            content: description,
            parts: { type: 'image', data: img.data, mimeType: img.mimeType },
            createdAt: Math.floor(Date.now() / 1000),
            ...channelFields,
          },
        });
      }
    }

    // When a DM action succeeds, bind the DM channel back to this session so replies route
    // here instead of falling through to the orchestrator. Fire-and-forget: binding failure
    // is non-fatal.
    //
    // Two bindings are created to cover both reply styles:
    // - 2-part (teamId:channelId): for regular DM replies — Slack sends no thread_ts, so the
    //   event handler computes a 2-part scope key.
    // - 3-part (teamId:channelId:ts): for explicit "Reply in thread" — Slack sets thread_ts to
    //   the bot message's ts, producing a 3-part scope key.
    //
    // send_message to non-DM channels is skipped: slack-events.ts ignores non-DM events, so
    // those bindings would never be looked up.
    if (result.success) {
      const isDmAction = actionId === 'slack.dm_owner' || actionId === 'slack.dm_user';
      const isSendToDm = actionId === 'slack.send_message' &&
        !(typeof params.thread_ts === 'string' && params.thread_ts.length > 0);
      if (isDmAction || isSendToDm) {
        const slackData = result.data as { ts?: string; channel?: string } | undefined;
        const slackChannel = slackData?.channel;
        const slackTs = slackData?.ts;
        if (slackChannel && (isDmAction || slackChannel.startsWith('D'))) {
          const sessionId = this.sessionState.sessionId;
          // Capture the current processing thread ID so we can pre-register the
          // channel→thread mapping. This routes Slack replies back to the same
          // orchestrator thread that triggered the send, instead of spawning a new one.
          const currentThreadId = this.promptQueue.getProcessingThreadId();
          getOrgSlackInstallAny(this.appDb, this.env.ENCRYPTION_KEY)
            .then((install) => {
              if (!install?.teamId) return;
              const { teamId } = install;
              const dmChannelId = `${teamId}:${slackChannel}`;
              const threadChannelId = slackTs ? `${teamId}:${slackChannel}:${slackTs}` : null;
              return this.resolveOrgId().then(async (orgId) => {
                const base = {
                  sessionId,
                  channelType: 'slack' as const,
                  userId,
                  orgId: orgId ?? 'default',
                  queueMode: 'followup' as const,
                  slackChannelId: slackChannel,
                };
                // 2-part: catches regular DM replies (no thread_ts)
                await ensureChannelBinding(this.appDb, {
                  ...base,
                  channelId: dmChannelId,
                  scopeKey: channelScopeKey(userId, 'slack', dmChannelId),
                });
                // 3-part: catches explicit "Reply in thread" (thread_ts = this message's ts)
                if (threadChannelId) {
                  await ensureChannelBinding(this.appDb, {
                    ...base,
                    channelId: threadChannelId,
                    scopeKey: channelScopeKey(userId, 'slack', threadChannelId),
                    slackThreadTs: slackTs,
                  });
                }
                // Pre-register the channel→thread mapping so Slack replies route
                // to the existing orchestrator thread rather than spawning a new one.
                if (currentThreadId && slackTs) {
                  await registerChannelThread(this.env.DB, {
                    channelType: 'slack',
                    channelId: slackChannel,
                    externalThreadId: slackTs,
                    userId,
                    sessionId,
                    threadId: currentThreadId,
                  });
                }
              });
            })
            .catch((err) => {
              console.warn('[SessionAgentDO] Failed to create Slack DM binding:', err instanceof Error ? err.message : String(err));
            });
        }
      }
    }

    // Send result to runner — include images so the agent can post them
    // out-of-band via /api/image for vision context.
    if (!result.success) {
      this.runnerLink.send({ type: 'call-tool-result', requestId, error: result.error || 'Action failed' } as any);
    } else {
      const msg: Record<string, unknown> = { type: 'call-tool-result', requestId, result: result.data };
      if (Array.isArray(result.images) && result.images.length > 0) {
        msg.images = result.images;
      }
      this.runnerLink.send(msg as any);
    }

    return { success: result.success, error: result.error };
  }

  private async expireInteractivePromptRow(row: Record<string, unknown>) {
    const promptId = String(row.id);
    const promptType = String(row.type);
    const requestId = (row.request_id as string | null) ?? null;
    const context = row.context ? JSON.parse(String(row.context)) : {};
    const channelRefs = (row.channel_refs as string) || null;

    this.ctx.storage.sql.exec('DELETE FROM interactive_prompts WHERE id = ?', promptId);

    if (promptType === 'approval') {
      const toolId = String(context.toolId || '');
      const invocationId = String(context.invocationId || promptId);

      try {
        await updateInvocationStatus(this.appDb, invocationId, {
          status: 'expired',
          expectedStatus: 'pending',
        });
      } catch (err) {
        console.error('[SessionAgentDO] Failed to mark invocation expired:', err);
      }

      if (requestId) {
        const wfCtx = this.promptQueue.getProcessingWorkflowContext();
        const isUnattended =
          wfCtx?.queueType === 'workflow_execute' ||
          !!this._activeWorkflowExecutionId ||
          this.promptQueue.getProcessingAuthorEmail() === 'scheduled-task@valet.local';
        const expiryError = isUnattended
          ? `Action "${toolId}" approval request expired without a response. ` +
            `This likely means the session was running unattended (scheduled task or automation) and no one saw the approval prompt. ` +
            `Do not retry this action automatically — instead, let the user know that approval is needed and ask them to re-run or approve it manually.`
          : `Action "${toolId}" approval request expired without a response.`;
        this.runnerLink.send({ type: 'call-tool-result', requestId, error: expiryError } as any);
      } else {
        console.warn(`[SessionAgentDO] Approval prompt ${promptId} expired with no request_id — runner may be stuck`);
      }

      this.emitAuditEvent('agent.tool_call', `Action ${toolId} approval expired`, undefined, { invocationId });
    } else if (promptType === 'question') {
      this.runnerLink.send({
        type: 'answer',
        questionId: promptId,
        answer: '__expired__',
      });

      this.emitAuditEvent('agent.question', `Question ${promptId} expired`, undefined, { questionId: promptId });
    }

    this.broadcastToClients({
      type: 'interactive_prompt_expired',
      promptId,
      promptType,
      context,
    });

    if (channelRefs) {
      this.ctx.waitUntil(
        this.updateChannelInteractivePrompts(channelRefs, { actionId: '__expired__', resolvedBy: 'system' })
      );
    }
  }

  /**
   * Unified handler for resolving any interactive prompt (approval or question).
   */
  private async handlePromptResolved(promptId: string, resolution: InteractiveResolution): Promise<PromptResolutionResult> {
    // Read from interactive_prompts
    const rows = this.ctx.storage.sql
      .exec("SELECT * FROM interactive_prompts WHERE id = ? AND status = 'pending'", promptId)
      .toArray();

    if (rows.length === 0) {
      console.warn(`[SessionAgentDO] handlePromptResolved: no pending prompt found for ${promptId}`);
      return { ok: false, status: 404, error: 'No pending prompt found' };
    }

    const row = rows[0];
    const rawExpiresAt = row.expires_at;
    const rowExpiresAt = typeof rawExpiresAt === 'number'
      ? rawExpiresAt
      : typeof rawExpiresAt === 'string'
        ? Number(rawExpiresAt)
        : Number.NaN;
    if (Number.isFinite(rowExpiresAt) && rowExpiresAt <= Math.floor(Date.now() / 1000)) {
      await this.expireInteractivePromptRow(row as Record<string, unknown>);
      return { ok: false, status: 410, error: 'This prompt has expired.' };
    }

    const promptType = row.type as string;
    const promptTitle = (row.title as string) || '';
    const requestId = row.request_id as string | null;
    const context = row.context ? JSON.parse(row.context as string) : {};
    const channelRefsJson = (row.channel_refs as string) || null;
    const claimedRows = this.ctx.storage.sql.exec(
      "UPDATE interactive_prompts SET status = 'resolving' WHERE id = ? AND status = 'pending' RETURNING id",
      promptId,
    ).toArray();
    if (claimedRows.length === 0) {
      return { ok: false, status: 409, error: 'This prompt is no longer pending.' };
    }
    const restorePrompt = () => {
      this.ctx.storage.sql.exec(
        "UPDATE interactive_prompts SET status = 'pending' WHERE id = ? AND status = 'resolving'",
        promptId,
      );
    };
    const deletePrompt = () => {
      this.ctx.storage.sql.exec('DELETE FROM interactive_prompts WHERE id = ?', promptId);
    };
    const broadcastPromptExpired = () => {
      this.broadcastToClients({
        type: 'interactive_prompt_expired',
        promptId,
        promptType,
        context,
      });
      if (channelRefsJson) {
        this.ctx.waitUntil(
          this.updateChannelInteractivePrompts(channelRefsJson, { actionId: '__expired__', resolvedBy: 'system' })
        );
      }
    };
    const broadcastPromptFailed = (error: string) => {
      const failedResolution: InteractiveResolution = {
        actionId: '__failed__',
        value: error,
        resolvedBy: 'system',
        ...(promptTitle ? { promptTitle } : {}),
      };
      this.broadcastToClients({
        type: 'interactive_prompt_resolved',
        promptId,
        promptType,
        resolution: failedResolution,
        context,
      });
      if (channelRefsJson) {
        this.ctx.waitUntil(
          this.updateChannelInteractivePrompts(channelRefsJson, failedResolution)
        );
      }
    };
    const failAndDeletePrompt = async (error: string, status: number): Promise<PromptResolutionResult> => {
      await markFailed(this.appDb, promptId, error).catch((markErr) => {
        console.error('[session-agent] Failed to mark invocation failed while terminalizing prompt:', markErr);
      });
      if (requestId) {
        this.runnerLink.send({ type: 'call-tool-result', requestId, error } as any);
      }
      broadcastPromptFailed(error);
      deletePrompt();
      return { ok: false, status, error };
    };
    const deleteNoLongerPendingPrompt = (message = 'This action approval is no longer pending.') => {
      deletePrompt();
      if (requestId) {
        this.runnerLink.send({ type: 'call-tool-result', requestId, error: message } as any);
      }
      broadcastPromptExpired();
    };
    let effectiveResolution = resolution;

    // Resolve actionId → human-readable label from the stored actions list
    let actionLabel: string | undefined;
    if (resolution.actionId && row.actions) {
      try {
        const actions = JSON.parse(row.actions as string) as Array<{ id: string; label: string }>;
        const match = actions.find(a => a.id === resolution.actionId);
        if (match) actionLabel = match.label;
      } catch { /* best-effort */ }
    }

    const userId = this.sessionState.userId;
    const sessionId = this.sessionState.sessionId;

    if (promptType === 'approval') {
      const toolId = context.toolId || '';
      const service = context.service || '';
      const actionId = context.actionId || '';
      const params = context.params || {};
      const resolutionAction = normalizeApprovalAction(resolution.actionId);
      if (!resolutionAction) {
        restorePrompt();
        const error = `Unknown approval action: ${resolution.actionId || 'missing'}`;
        return { ok: false, status: 400, error };
      }
      effectiveResolution = { ...resolution, actionId: resolutionAction };

      if (row.actions) {
        try {
          const actions = JSON.parse(row.actions as string) as Array<{ id: string; label: string }>;
          const match = actions.find(a => a.id === resolutionAction);
          if (match) actionLabel = match.label;
        } catch { /* best-effort */ }
      }

      if (!userId) {
        const error = 'No userId on session';
        return failAndDeletePrompt(error, 409);
      }

      if (!resolution.resolvedBy || resolution.resolvedBy !== userId) {
        const error = 'Only the session owner can resolve this prompt';
        restorePrompt();
        return { ok: false, status: 403, error };
      }

      if ('credentialSources' in context || 'isOrgScoped' in context) {
        // Approval was created before the unified-auth migration; context is stale.
        // Credentials are now resolved fresh at execution time.
        const error = 'This action approval expired during a system update. Please retry the action.';
        console.warn(`[session-agent] Stale approval context (pre-unified-auth), skipping`);
        await markFailed(this.appDb, promptId, error).catch((markErr) => {
          console.error('[session-agent] Failed to mark invocation failed after stale approval context:', markErr);
        });
        if (requestId) {
          this.runnerLink.send({ type: 'call-tool-result', requestId, error } as any);
        }
        broadcastPromptExpired();
        deletePrompt();
        return { ok: false, status: 409, error };
      }

      if (resolutionAction !== 'cancel') {
        try {
          const orgPolicy = await resolveOrgPolicyMatch(this.appDb, String(service), String(actionId), String(context.riskLevel || 'medium'));
          if (orgPolicy?.mode === 'deny') {
            const error = `Action "${toolId}" is denied by organization policy and cannot be allowed.`;
            return failAndDeletePrompt(error, 403);
          }
        } catch (err) {
          const error = `Failed to check organization policy: ${err instanceof Error ? err.message : String(err)}`;
          restorePrompt();
          return { ok: false, status: 500, error };
        }

        let approval;
        try {
          approval = await approveInvocation(this.appDb, promptId, userId);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          restorePrompt();
          return { ok: false, status: 500, error };
        }
        if (!approval.ok) {
          const error = 'This action approval is no longer pending.';
          deleteNoLongerPendingPrompt(error);
          return { ok: false, status: 409, error };
        }

        if (resolutionAction === 'allow_session' || resolutionAction === 'allow_always') {
          try {
            const lifetime = resolutionAction === 'allow_session' ? 'session' : 'persistent';
            await upsertUserActionPolicyOverride(this.appDb, {
              id: `${promptId}:${lifetime}`,
              userId,
              service: String(service),
              actionId: String(actionId),
              mode: 'allow',
              lifetime,
              sessionId: lifetime === 'session' ? sessionId : null,
              source: 'approval_prompt',
              sourceInvocationId: promptId,
            });
          } catch (err) {
            const error = `Failed to save approval override: ${err instanceof Error ? err.message : String(err)}`;
            await markFailed(this.appDb, promptId, error).catch((markErr) => {
              console.error('[session-agent] Failed to mark invocation failed after override save error:', markErr);
            });
            if (requestId) {
              this.runnerLink.send({ type: 'call-tool-result', requestId, error } as any);
            }
            broadcastPromptExpired();
            deletePrompt();
            return { ok: false, status: 500, error };
          }
        }

        const orgId = await this.resolveOrgId() ?? 'default';
        const customContext = await loadCustomMcpConnectorContext(this.env, this.appDb, orgId);
        const actionSource = integrationRegistry.getActions(service, customContext);
        let executionResult: { success: boolean; error?: string } = { success: true };
        if (requestId) {
          try {
            executionResult = await this.executeActionAndSend(requestId, toolId, service, actionId, params, userId, actionSource, promptId, orgId);
          } catch (err) {
            const error = err instanceof Error ? err.message : String(err);
            await markFailed(this.appDb, promptId, error).catch((markErr) => {
              console.error('[session-agent] Failed to mark invocation failed after action execution throw:', markErr);
            });
            this.runnerLink.send({ type: 'call-tool-result', requestId, error } as any);
            executionResult = { success: false, error };
          }
        }

        // Broadcast approval to clients
        this.broadcastToClients({
          type: 'interactive_prompt_resolved',
          promptId,
          promptType,
          resolution: effectiveResolution,
          context,
        });

        // Publish to EventBus
        this.notifyEventBus({
          type: 'action.approved',
          sessionId,
          userId,
          data: {
            invocationId: promptId,
            toolId,
            service,
            actionId,
            executionStatus: executionResult.success ? 'executed' : 'failed',
            ...(executionResult.error ? { error: executionResult.error } : {}),
          },
          timestamp: new Date().toISOString(),
        });

        this.emitAuditEvent(
          'agent.tool_call',
          executionResult.success
            ? `Action ${toolId} approved and executed`
            : `Action ${toolId} approved but execution failed: ${executionResult.error || 'Action failed'}`,
          undefined,
          { invocationId: promptId },
        );
        deletePrompt();
      } else {
        // Cancel
        const reason = resolution.value;
        let denial;
        try {
          denial = await denyInvocation(this.appDb, promptId, userId, reason);
        } catch (err) {
          const error = err instanceof Error ? err.message : String(err);
          restorePrompt();
          return { ok: false, status: 500, error };
        }
        if (!denial.ok) {
          const error = 'This action approval is no longer pending.';
          deleteNoLongerPendingPrompt(error);
          return { ok: false, status: 409, error };
        }

        // Send error to runner
        const errorMsg = reason
          ? `Action "${toolId}" was cancelled: ${reason}`
          : `Action "${toolId}" was cancelled`;
        if (requestId) {
          this.runnerLink.send({ type: 'call-tool-result', requestId, error: errorMsg } as any);
        }

        // Broadcast denial to clients
        this.broadcastToClients({
          type: 'interactive_prompt_resolved',
          promptId,
          promptType,
          resolution: effectiveResolution,
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

        this.emitAuditEvent('agent.tool_call', `Action ${toolId} cancelled${reason ? `: ${reason}` : ''}`, undefined, { invocationId: promptId });
        deletePrompt();
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
      deletePrompt();
    }

    // Resolve display name and update channel messages
    if (channelRefsJson) {
      // Enrich resolution with label, title, and display name
      let displayResolution: InteractiveResolution = {
        ...effectiveResolution,
        ...(actionLabel ? { actionLabel } : {}),
        ...(promptTitle ? { promptTitle } : {}),
      };
      if (effectiveResolution.resolvedBy && userId) {
        try {
          const user = await getUserById(this.appDb, effectiveResolution.resolvedBy);
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
    return { ok: true };
  }

  private async sendChannelInteractivePrompts(promptId: string, prompt: InteractivePrompt) {
    try {
      const sessionId = this.sessionState.sessionId;
      const userId = this.sessionState.userId;
      if (!sessionId || !userId) return;

      const targets: Array<{ channelType: string; channelId: string }> = [];
      const seen = new Set<string>();

      // 1. Origin target: the channel stored in the approval context at creation time
      //    (captured from the originating prompt when the approval was created)
      const originTarget = this.getPromptOriginTarget(prompt.context);
      if (originTarget && originTarget.channelType !== 'web' && originTarget.channelType !== 'thread') {
        const key = `${originTarget.channelType}:${originTarget.channelId}`;
        seen.add(key);
        targets.push(originTarget);
      }

      // 2. Caller target: the currently-processing prompt's channel (may differ from
      //    origin if a different Slack thread is subscribed to the same orchestrator
      //    thread). Read from the processing queue row, not a mutable cursor.
      const callerCh = this.promptQueue.getProcessingChannelTarget();
      if (callerCh?.channelType && callerCh?.channelId
          && callerCh.channelType !== 'web'
          && callerCh.channelType !== 'thread') {
        const key = `${callerCh.channelType}:${callerCh.channelId}`;
        if (!seen.has(key)) {
          seen.add(key);
          targets.push({ channelType: callerCh.channelType, channelId: callerCh.channelId });
        }
      }

      // Fail closed: if we have no non-web channel targets, attempt a Slack DM
      // fallback for unattended runs (scheduled tasks, workflow executions).
      // If the user has a Slack identity, we open a DM and send the prompt there.
      // If no Slack identity or DM resolution fails, fall back to web UI error.
      if (targets.length === 0) {
        const wfCtx = this.promptQueue.getProcessingWorkflowContext();
        const isUnattended =
          wfCtx?.queueType === 'workflow_execute' ||
          !!this._activeWorkflowExecutionId ||
          this.promptQueue.getProcessingAuthorEmail() === 'scheduled-task@valet.local';
        if (!isUnattended) {
          // Attended web-only session: approval is already visible in the web UI.
          return;
        }

        // Attempt Slack DM fallback for unattended runs (scheduled tasks, workflow executions).
        const slackLink = await getUserSlackIdentityLink(this.appDb, userId).catch((err) => {
          console.warn('[SessionAgentDO] getUserSlackIdentityLink failed for DM fallback:', err instanceof Error ? err.message : String(err));
          return null;
        });
        if (slackLink?.externalId) {
          const dmTarget = await this.channelRouter
            .resolveUserDmTarget('slack', userId, slackLink.externalId)
            .catch(() => null);
          if (dmTarget) {
            const provenanceLabel = await this.buildApprovalProvenanceLabel(userId);
            const dmPrompt: InteractivePrompt = {
              ...prompt,
              context: { ...(prompt.context ?? {}), provenanceLabel },
            };
            const refs = await this.channelRouter.sendInteractivePrompt({ userId, targets: [dmTarget], prompt: dmPrompt });
            if (refs.length > 0) {
              this.ctx.storage.sql.exec(
                'UPDATE interactive_prompts SET channel_refs = ? WHERE id = ?',
                JSON.stringify(refs),
                promptId,
              );

              // Bind the DM channel so any Slack replies (not just button clicks) route
              // back to this session instead of spawning a new one via the orchestrator.
              // Mirrors the binding logic in executeActionAndSend for dm_owner/dm_user.
              const dmRef = refs[0].ref;
              if (dmRef.channelId && dmRef.messageId) {
                const slackDmChannel = dmRef.channelId;
                const slackDmTs = dmRef.messageId;
                const sessionId = this.sessionState.sessionId;
                const currentThreadId = this.promptQueue.getProcessingThreadId();
                getOrgSlackInstallAny(this.appDb, this.env.ENCRYPTION_KEY)
                  .then((install) => {
                    if (!install?.teamId) return;
                    const { teamId } = install;
                    const dmChannelId = `${teamId}:${slackDmChannel}`;
                    const threadChannelId = `${teamId}:${slackDmChannel}:${slackDmTs}`;
                    return this.resolveOrgId().then(async (orgId) => {
                      const base = {
                        sessionId,
                        channelType: 'slack' as const,
                        userId,
                        orgId: orgId ?? 'default',
                        queueMode: 'followup' as const,
                        slackChannelId: slackDmChannel,
                      };
                      // 2-part: regular DM replies (no thread_ts)
                      await ensureChannelBinding(this.appDb, {
                        ...base,
                        channelId: dmChannelId,
                        scopeKey: channelScopeKey(userId, 'slack', dmChannelId),
                      });
                      // 3-part: explicit "Reply in thread" on the approval message
                      await ensureChannelBinding(this.appDb, {
                        ...base,
                        channelId: threadChannelId,
                        scopeKey: channelScopeKey(userId, 'slack', threadChannelId),
                        slackThreadTs: slackDmTs,
                      });
                      // Pre-register channel→thread so replies land in this
                      // orchestrator thread, not a fresh one.
                      if (currentThreadId) {
                        await registerChannelThread(this.env.DB, {
                          channelType: 'slack',
                          channelId: slackDmChannel,
                          externalThreadId: slackDmTs,
                          userId,
                          sessionId,
                          threadId: currentThreadId,
                        });
                      }
                    });
                  })
                  .catch((err) => {
                    console.warn('[SessionAgentDO] Failed to create Slack DM binding after approval fallback:', err instanceof Error ? err.message : String(err));
                  });
              }

              return;  // delivery succeeded — done
            }
            console.warn(`[SessionAgentDO] DM fallback delivery failed for prompt ${promptId} — falling through to web-UI error path`);
            // fall through to hasExternalBindings error path below
          }
        }

        // No Slack identity or DM resolution failed — fall back to web UI error
        const hasExternalBindings = (await listUserChannelBindings(this.appDb, userId))
          .some((b) => b.channelType !== 'web');
        if (hasExternalBindings) {
          console.error(
            `[SessionAgentDO] sendChannelInteractivePrompts: No origin or caller channel for prompt ${promptId} — refusing to broadcast. ` +
            `Session has external channel bindings but no channel context was propagated. ` +
            `Approval is visible in web UI only. sessionId=${sessionId} userId=${userId}`,
          );
          this.broadcastToClients({
            type: 'error',
            error: 'Approval could not be delivered to Slack: no origin channel context. Please approve via the web dashboard.',
            promptId,
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

  private async buildApprovalProvenanceLabel(userId: string): Promise<string> {
    const wfCtx = this.promptQueue.getProcessingWorkflowContext();
    const executionId = wfCtx?.workflowExecutionId ?? this._activeWorkflowExecutionId ?? null;
    if ((wfCtx?.queueType === 'workflow_execute' || !!this._activeWorkflowExecutionId) && executionId) {
      const workflowName = await getWorkflowNameByExecutionId(this.appDb, executionId).catch(() => null);
      const agentName = await this.resolveAgentDisplayName(userId);
      return workflowName
        ? `${agentName} requested this while running workflow *${workflowName}*`
        : `${agentName} requested this while running a workflow`;
    }
    const agentName = await this.resolveAgentDisplayName(userId);
    return `${agentName} requested this while running a scheduled task (no active session was connected)`;
  }

  private async resolveAgentDisplayName(userId: string): Promise<string> {
    try {
      const identity = await getOrchestratorIdentity(this.appDb, userId);
      return identity?.name ?? 'Your Valet assistant';
    } catch {
      return 'Your Valet assistant';
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
   * Resolve channel followups for a completed prompt. Handles the thread-origin
   * case where a web UI message targets a Slack-originated thread — the followup
   * was inserted keyed to the origin channel, not the thread itself.
   */
  private async resolveFollowupsForCompletedPrompt(
    channel: { channelType: string | null; channelId: string | null; threadId?: string | null } | null | undefined,
  ): Promise<void> {
    if (!channel) return;
    let { channelType: chType, channelId: chId } = channel;
    if (chType === 'thread' && channel.threadId) {
      const origin = await getThreadOriginChannel(this.env.DB, channel.threadId);
      if (origin && origin.channelType !== 'web' && origin.channelType !== 'thread') {
        chType = origin.channelType;
        chId = origin.channelId;
      }
    }
    if (chType && chId && chType !== 'web' && chType !== 'thread') {
      this.resolveChannelFollowups(chType, chId);
    }
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
    // Always send a repo-config message so the Runner can resolve its repoReady
    // promise promptly. If we bail early or credentials fail, send with no repoUrl
    // so the Runner knows no clone is coming and doesn't burn the full timeout.
    const sessionId = this.sessionState.sessionId;
    if (!sessionId) {
      this.runnerLink.send({ type: 'repo-config', token: null, gitConfig: {} });
      return;
    }

    const gitState = await getSessionGitState(this.appDb, sessionId);
    const repoUrl = gitState?.sourceRepoUrl;
    if (!repoUrl) {
      this.runnerLink.send({ type: 'repo-config', token: null, gitConfig: {} });
      return;
    }

    const userId = this.sessionState.userId;
    if (!userId) {
      this.runnerLink.send({ type: 'repo-config', token: null, gitConfig: {} });
      return;
    }

    const orgId = await this.resolveOrgId();

    try {
      const repoEnv = await assembleRepoEnv(this.appDb, this.env, userId, orgId, {
        repoUrl,
        branch: gitState.branch ?? undefined,
        ref: gitState.ref ?? undefined,
      });

      if (repoEnv.error) {
        console.warn(`[SessionAgentDO] sendRepoConfig: ${repoEnv.error}`);
        this.runnerLink.send({ type: 'repo-config', token: null, gitConfig: {} });
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
      } else {
        this.runnerLink.send({ type: 'repo-config', token: null, gitConfig: {} });
      }
    } catch (err) {
      console.error('[SessionAgentDO] Failed to assemble repo config for runner:', err);
      this.runnerLink.send({ type: 'repo-config', token: null, gitConfig: {} });
    }
  }

  // Refresh the repo token when the runner's GitCredentialManager detects expiry.
  // Delegates to assembleRepoEnv(), which uses getCredential() to auto-refresh
  // the user's GitHub App OAuth token before returning it (TKAI-56).
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
      // Always send so the Runner can resolve its pluginContentReady promise
      this.runnerLink.send({ type: 'plugin-content', pluginContent: { personas: [], skills: [], tools: [], allowRepoContent: false, toolWhitelist: null } });
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
