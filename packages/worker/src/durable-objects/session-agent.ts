import type { Env } from '../env.js';
import type { AppDb } from '../lib/drizzle.js';
import { getDb } from '../lib/drizzle.js';
import { updateSessionStatus, updateSessionMetrics, addActiveSeconds, updateSessionGitState, upsertSessionFileChanged, updateSessionTitle, createSession, createSessionGitState, getSession, getSessionGitState, getChildSessions, getSessionChannelBindings, listUserChannelBindings, readMemoryFile, listMemoryFiles, writeMemoryFile, patchMemoryFile, deleteMemoryFile, deleteMemoryFilesUnderPath, searchMemoryFiles, boostMemoryFileRelevance, listOrgRepositories, listPersonas, getUserById, getUsersByIds, createMailboxMessage, getSessionMailbox, markSessionMailboxRead, getOrchestratorIdentity, getOrchestratorIdentityByHandle, createSessionTask, getSessionTasks, getMyTasks, updateSessionTask, getUserTelegramConfig, getOrgSettings, enqueueWorkflowApprovalNotificationIfMissing, markWorkflowApprovalNotificationsRead, isNotificationWebEnabled, batchInsertAuditLog, batchUpsertMessages, updateUserDiscoveredModels, batchInsertUsageEvents, setCatalogCache, updateThread, incrementThreadMessageCount, getUserIdentityLinks } from '../lib/db.js';
import { getCredential, type CredentialResult } from '../services/credentials.js';
import { getSlackBotToken } from '../services/slack.js';
import { listWorkflows, upsertWorkflow, getWorkflowByIdOrSlug, getWorkflowOwnerCheck, deleteWorkflowTriggers, deleteWorkflowById, updateWorkflow, getWorkflowById } from '../lib/db/workflows.js';
import { listTriggers, getTrigger, deleteTrigger, createTrigger, getTriggerForRun, updateTriggerLastRun, findScheduleTriggerByNameAndWorkflow, findScheduleTriggersByWorkflow, findScheduleTriggersByName, updateTriggerFull } from '../lib/db/triggers.js';
import { getExecution, getExecutionWithWorkflowName, getExecutionForAuth, getExecutionSteps, getExecutionOwnerAndStatus, checkIdempotencyKey, createExecution, completeExecutionFull, upsertExecutionStep, listExecutions } from '../lib/db/executions.js';
import { checkWorkflowConcurrency, createWorkflowSession, dispatchOrchestratorPrompt, enqueueWorkflowExecution, sha256Hex } from '../lib/workflow-runtime.js';
import { assembleCustomProviders, assembleBuiltInProviderModelConfigs, assembleRepoEnv } from '../lib/env-assembly.js';
import { resolveAvailableModels } from '../services/model-catalog.js';
import { channelRegistry } from '../channels/registry.js';
import { integrationRegistry } from '../integrations/registry.js';
import { getUserIntegrations, getOrgIntegrations, updateIntegrationStatus } from '../lib/db/integrations.js';
import { resolveMode } from '../services/action-policy.js';
import { invokeAction, markExecuted, markFailed, approveInvocation, denyInvocation } from '../services/actions.js';
import { updateInvocationStatus } from '../lib/db/actions.js';
import { getDisabledActionsIndex, isActionDisabled } from '../lib/db/disabled-actions.js';
import { upsertMcpToolCache } from '../lib/db/mcp-tool-cache.js';
import { getActivePluginArtifacts, getPluginSettings, getAutoEnabledServices } from '../lib/db/plugins.js';
import { getPersonaSkills, getOrgDefaultSkills, searchSkills, listSkills, getSkill, getSkillBySlug, createSkill, updateSkill, deleteSkill, getPersonaToolWhitelist, createPersona, updatePersona, deletePersona, getPersonaWithFiles, upsertPersonaFile, attachSkillToPersona, detachSkillFromPersona, getPersonaSkillsForApi } from '../lib/db.js';
import type { ChannelTarget, ChannelContext, InteractivePrompt, InteractiveAction, InteractivePromptRef, InteractiveResolution } from '@valet/sdk';
import { validateWorkflowDefinition } from '../lib/workflow-definition.js';

// ─── WebSocket Message Types ───────────────────────────────────────────────

interface PromptAttachment {
  type: 'file';
  mime: string;
  url: string;
  filename?: string;
}

interface WorkflowExecutionDispatchPayload {
  kind: 'run' | 'resume';
  executionId: string;
  workflowHash?: string;
  resumeToken?: string;
  decision?: 'approve' | 'deny';
  payload: Record<string, unknown>;
}

const MAX_PROMPT_ATTACHMENTS = 8;
const MAX_PROMPT_ATTACHMENT_URL_LENGTH = 12_000_000;
/** Total base64 across all attachments — safety cap below 32 MiB WS limit. */
const MAX_TOTAL_ATTACHMENT_BYTES = 25_000_000;
const MAX_CHANNEL_FOLLOWUP_REMINDERS = 3;
const PARENT_IDLE_DEBOUNCE_MS = 10_000;
const ACTION_APPROVAL_EXPIRY_MS = 10 * 60 * 1000; // 10 minutes

function parseBase64DataUrl(url: string): string | null {
  const commaIndex = url.indexOf(',');
  if (commaIndex === -1) return null;
  const data = url.slice(commaIndex + 1).replace(/\s+/g, '');
  return data.length > 0 ? data : null;
}

function sanitizePromptAttachments(input: unknown): PromptAttachment[] {
  if (!Array.isArray(input)) return [];
  const result: PromptAttachment[] = [];

  for (const item of input) {
    if (!item || typeof item !== 'object') continue;
    const record = item as Record<string, unknown>;
    if (record.type !== 'file') continue;
    if (typeof record.mime !== 'string' || typeof record.url !== 'string') continue;

    const mime = record.mime.trim().toLowerCase();
    const url = record.url.trim();
    if (!mime.startsWith('image/') && !mime.startsWith('audio/')) continue;
    if (!url.startsWith('data:') || !url.includes(';base64,')) continue;
    if (url.length > MAX_PROMPT_ATTACHMENT_URL_LENGTH) continue;

    const filename = typeof record.filename === 'string' ? record.filename.slice(0, 255) : undefined;
    result.push({ type: 'file', mime, url, filename });
    if (result.length >= MAX_PROMPT_ATTACHMENTS) break;
  }

  // Cap total attachment size to stay safely under the 32 MiB WS limit
  let totalLen = 0;
  const capped: PromptAttachment[] = [];
  for (const att of result) {
    totalLen += att.url.length;
    if (totalLen > MAX_TOTAL_ATTACHMENT_BYTES) break;
    capped.push(att);
  }
  return capped;
}

function attachmentPartsForMessage(attachments: PromptAttachment[]): Array<Record<string, unknown>> {
  const parts: Array<Record<string, unknown>> = [];
  for (const attachment of attachments) {
    const data = parseBase64DataUrl(attachment.url);
    if (!data) continue;

    if (attachment.mime.startsWith('image/')) {
      parts.push({
        type: 'image',
        data,
        mimeType: attachment.mime,
        ...(attachment.filename ? { filename: attachment.filename } : {}),
      });
    } else if (attachment.mime.startsWith('audio/')) {
      parts.push({
        type: 'audio',
        data,
        mimeType: attachment.mime,
        ...(attachment.filename ? { filename: attachment.filename } : {}),
      });
    }
  }
  return parts;
}

function parseQueuedPromptAttachments(raw: unknown): PromptAttachment[] {
  if (typeof raw !== 'string' || !raw) return [];
  try {
    return sanitizePromptAttachments(JSON.parse(raw));
  } catch {
    return [];
  }
}

function parseQueuedWorkflowPayload(raw: unknown): WorkflowExecutionDispatchPayload | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const parsed = JSON.parse(raw) as WorkflowExecutionDispatchPayload;
    if (!parsed || typeof parsed !== 'object') return null;
    if (parsed.kind !== 'run' && parsed.kind !== 'resume') return null;
    if (typeof parsed.executionId !== 'string' || !parsed.executionId) return null;
    if (!parsed.payload || typeof parsed.payload !== 'object' || Array.isArray(parsed.payload)) return null;
    return parsed;
  } catch {
    return null;
  }
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

/** Agent status values for activity indication */
type AgentStatus = 'idle' | 'thinking' | 'tool_calling' | 'streaming' | 'error';
type SessionLifecycleStatus = 'initializing' | 'running' | 'idle' | 'hibernating' | 'hibernated' | 'restoring' | 'terminated' | 'archived' | 'error';
type SandboxRuntimeState = 'starting' | 'running' | 'hibernating' | 'hibernated' | 'restoring' | 'stopped' | 'error';
type AgentRuntimeState = 'starting' | 'busy' | 'idle' | 'queued' | 'sleeping' | 'standby' | 'stopped' | 'error';
type JointRuntimeState = 'starting' | 'running_busy' | 'running_idle' | 'queued' | 'waking' | 'sleeping' | 'standby' | 'stopped' | 'error';

function deriveRuntimeStates(args: {
  lifecycleStatus: string;
  sandboxId?: string | null;
  runnerConnected: boolean;
  runnerBusy: boolean;
  queuedPrompts: number;
}): {
  sandboxState: SandboxRuntimeState;
  agentState: AgentRuntimeState;
  jointState: JointRuntimeState;
} {
  const lifecycle = args.lifecycleStatus as SessionLifecycleStatus;
  const hasSandbox = !!args.sandboxId;
  const hasQueue = args.queuedPrompts > 0;

  const sandboxState: SandboxRuntimeState = (() => {
    if (lifecycle === 'error') return 'error';
    if (lifecycle === 'terminated' || lifecycle === 'archived') return 'stopped';
    if (lifecycle === 'hibernating') return 'hibernating';
    if (lifecycle === 'hibernated') return 'hibernated';
    if (lifecycle === 'restoring') return 'restoring';
    if (lifecycle === 'initializing') return 'starting';
    if (hasSandbox) return 'running';
    if (hasQueue) return 'restoring';
    return 'stopped';
  })();

  const agentState: AgentRuntimeState = (() => {
    if (lifecycle === 'error') return 'error';
    if (lifecycle === 'terminated' || lifecycle === 'archived') return 'stopped';
    if (lifecycle === 'hibernating' || lifecycle === 'hibernated') return 'sleeping';
    if (lifecycle === 'initializing' || lifecycle === 'restoring') {
      return hasQueue ? 'queued' : 'starting';
    }
    if (hasQueue && !args.runnerConnected) return 'queued';
    if (args.runnerConnected && args.runnerBusy) return 'busy';
    if (hasQueue) return 'queued';
    if (hasSandbox && args.runnerConnected) return 'idle';
    if (hasSandbox && !args.runnerConnected) return 'standby';
    return 'standby';
  })();

  const jointState: JointRuntimeState = (() => {
    if (agentState === 'error') return 'error';
    if (agentState === 'stopped') return 'stopped';
    if (agentState === 'sleeping') return 'sleeping';
    if (sandboxState === 'starting') return 'starting';
    if (sandboxState === 'restoring') return hasQueue ? 'waking' : 'starting';
    if (agentState === 'busy') return 'running_busy';
    if (agentState === 'idle') return 'running_idle';
    if (agentState === 'queued') return hasSandbox ? 'queued' : 'waking';
    if (agentState === 'standby') return 'standby';
    return 'starting';
  })();

  return { sandboxState, agentState, jointState };
}

/** Messages sent by the runner to the DO */
/** Tool call status values */
type ToolCallStatus = 'pending' | 'running' | 'completed' | 'error';

interface RunnerMessage {
  type: 'stream' | 'result' | 'tool' | 'question' | 'screenshot' | 'error' | 'complete' | 'agentStatus' | 'create-pr' | 'update-pr' | 'list-pull-requests' | 'inspect-pull-request' | 'models' | 'aborted' | 'reverted' | 'diff' | 'review-result' | 'command-result' | 'ping' | 'git-state' | 'pr-created' | 'files-changed' | 'child-session' | 'title' | 'spawn-child' | 'session-message' | 'session-messages' | 'terminate-child' | 'self-terminate' | 'mem-read' | 'mem-write' | 'mem-patch' | 'mem-rm' | 'mem-search' | 'list-repos' | 'list-personas' | 'list-channels' | 'get-session-status' | 'list-child-sessions' | 'forward-messages' | 'read-repo-file' | 'workflow-list' | 'workflow-sync' | 'workflow-run' | 'workflow-executions' | 'workflow-api' | 'trigger-api' | 'execution-api' | 'skill-api' | 'persona-api' | 'workflow-execution-result' | 'workflow-chat-message' | 'model-switched' | 'tunnels' | 'mailbox-send' | 'mailbox-check' | 'task-create' | 'task-list' | 'task-update' | 'task-my' | 'channel-reply' | 'audio-transcript' | 'channel-session-created' | 'session-reset' | 'opencode-config-applied' | 'list-tools' | 'call-tool' | 'message.create' | 'message.part.text-delta' | 'message.part.tool-update' | 'message.finalize' | 'usage-report' | 'thread.created' | 'thread.updated' | 'repo:refresh-token' | 'repo:clone-complete';
  restarted?: boolean;
  turnId?: string;
  delta?: string;
  callId?: string;
  finalText?: string;
  transcript?: string;
  prNumber?: number;
  targetSessionId?: string;
  interrupt?: boolean;
  limit?: number;
  after?: string;
  task?: string;
  workspace?: string;
  repoUrl?: string;
  messageId?: string;
  content?: string;
  questionId?: string;
  text?: string;
  options?: string[];
  callID?: string;
  toolName?: string;
  args?: unknown;
  result?: unknown;
  data?: string | { files?: { path: string; status: string; diff?: string }[] } | Record<string, unknown>; // base64 screenshot, diff payload, or review result
  description?: string;
  error?: string;
  status?: AgentStatus | ToolCallStatus;
  detail?: string;
  branch?: string;
  name?: string;
  title?: string;
  body?: string;
  base?: string;
  models?: { provider: string; models: { id: string; name: string }[] }[];
  requestId?: string;
  id?: string;
  messageIds?: string[];
  files?: { path: string; status: string; diff?: string }[];
  number?: number;
  url?: string;
  baseBranch?: string;
  commitCount?: number;
  sourceType?: string;
  sourcePrNumber?: number;
  sourceIssueNumber?: number;
  sourceRepoFullName?: string;
  labels?: string[];
  state?: string;
  owner?: string;
  repo?: string;
  filesLimit?: number;
  commentsLimit?: number;
  childSessionId?: string;
  diffFiles?: unknown;
  // Memory file system fields
  query?: string;
  operations?: unknown[];
  // Legacy fields
  category?: string;
  memoryId?: string;
  relevance?: number;
  source?: string;
  // Model failover fields
  fromModel?: string;
  toModel?: string;
  reason?: string;
  model?: string;
  personaId?: string;
  path?: string;
  ref?: string;
  executionId?: string;
  workflowId?: string;
  slug?: string;
  version?: string;
  dataJson?: Record<string, unknown>;
  variables?: Record<string, unknown>;
  action?: string;
  payload?: Record<string, unknown>;
  envelope?: {
    ok?: boolean;
    status?: 'ok' | 'needs_approval' | 'cancelled' | 'failed';
    executionId?: string;
    output?: Record<string, unknown>;
    steps?: Array<{
      stepId: string;
      status: string;
      attempt?: number;
      input?: unknown;
      output?: unknown;
      error?: string;
      startedAt?: string;
      completedAt?: string;
    }>;
    requiresApproval?: {
      stepId: string;
      prompt: string;
      items: unknown[];
      resumeToken: string;
    } | null;
    error?: string | null;
  };
  tunnels?: Array<{ name: string; port: number; protocol?: string; path: string; url?: string }>;
  // Phase C: Mailbox + Task Board fields
  toSessionId?: string;
  toUserId?: string;
  toHandle?: string;
  messageType?: string;
  contextSessionId?: string;
  contextTaskId?: string;
  replyToId?: string;
  taskId?: string;
  sessionId?: string;
  parentTaskId?: string;
  blockedBy?: string[];
  // Phase D: Channel Reply fields
  channelType?: string;
  channelId?: string;
  message?: string;
  imageBase64?: string;
  imageMimeType?: string;
  followUp?: boolean;
  // Tool Discovery & Invocation fields
  toolId?: string;
  params?: Record<string, unknown>;
  service?: string;
  // Per-channel session tracking
  channelKey?: string;
  opencodeSessionId?: string;
  // Thread routing
  threadId?: string;
  role?: 'user' | 'assistant' | 'system';
  parts?: Record<string, unknown>;
  // Usage tracking
  entries?: Array<{ ocMessageId: string; model: string; inputTokens: number; outputTokens: number }>;
  // Thread fields
  summaryAdditions?: number;
  summaryDeletions?: number;
  summaryFiles?: number;
  // Repo clone result
  success?: boolean;
}

/** Messages sent from DO to clients */
interface ClientOutbound {
  type: 'message' | 'message.updated' | 'messages.removed' | 'stream' | 'chunk' | 'interactive_prompt' | 'interactive_prompt_resolved' | 'interactive_prompt_expired' | 'status' | 'pong' | 'error' | 'user.joined' | 'user.left' | 'agentStatus' | 'models' | 'diff' | 'review-result' | 'command-result' | 'git-state' | 'pr-created' | 'files-changed' | 'child-session' | 'title' | 'audit_log' | 'model-switched' | 'toast' | 'integration-auth-required' | 'thread.created' | 'thread.updated';
  [key: string]: unknown;
}

/** Messages sent from DO to runner */
interface RunnerOutbound {
  type: 'prompt' | 'answer' | 'stop' | 'abort' | 'revert' | 'diff' | 'review' | 'opencode-command' | 'pong' | 'init' | 'opencode-config' | 'plugin-content' | 'repo-config' | 'repo-token-refreshed' | 'spawn-child-result' | 'session-message-result' | 'session-messages-result' | 'create-pr-result' | 'update-pr-result' | 'list-pull-requests-result' | 'inspect-pull-request-result' | 'terminate-child-result' | 'mem-read-result' | 'mem-write-result' | 'mem-patch-result' | 'mem-rm-result' | 'mem-search-result' | 'list-repos-result' | 'list-personas-result' | 'list-channels-result' | 'get-session-status-result' | 'list-child-sessions-result' | 'forward-messages-result' | 'read-repo-file-result' | 'workflow-list-result' | 'workflow-sync-result' | 'workflow-run-result' | 'workflow-executions-result' | 'workflow-api-result' | 'trigger-api-result' | 'execution-api-result' | 'skill-api-result' | 'persona-api-result' | 'workflow-execute' | 'tunnel-delete' | 'channel-reply-result' | 'list-tools-result' | 'call-tool-result' | 'call-tool-pending';
  config?: {
    tools?: Record<string, boolean>;
    providerKeys?: Record<string, string>;
    instructions?: string[];
    isOrchestrator?: boolean;
    customProviders?: Array<{
      providerId: string;
      displayName: string;
      baseUrl: string;
      apiKey?: string;
      models: Array<{ id: string; name?: string; contextLimit?: number; outputLimit?: number }>;
    }>;
    builtInProviderModelConfigs?: Array<{
      providerId: string;
      models: Array<{ id: string; name?: string }>;
      showAllModels: boolean;
    }>;
  };
  command?: string;
  messageId?: string;
  content?: string;
  model?: string;
  attachments?: PromptAttachment[];
  questionId?: string;
  answer?: string | boolean;
  requestId?: string;
  childSessionId?: string;
  success?: boolean;
  error?: string;
  statusCode?: number;
  messages?: Array<{ role: string; content: string; createdAt: string }>;
  number?: number;
  url?: string;
  title?: string;
  state?: string;
  // Author attribution (multiplayer)
  authorId?: string;
  authorEmail?: string;
  authorName?: string;
  gitName?: string;
  gitEmail?: string;
  // Channel metadata
  channelType?: string;
  channelId?: string;
  opencodeSessionId?: string;
  // Original channel info before thread normalization (for [via ...] prefix in Runner)
  replyChannelType?: string;
  replyChannelId?: string;
  // Thread routing
  threadId?: string;
  continuationContext?: string;
  // Orchestrator result fields
  memories?: unknown[];
  memory?: unknown;
  repos?: unknown[];
  personas?: unknown[];
  channels?: unknown[];
  sessionStatus?: unknown;
  pulls?: unknown[];
  data?: unknown;
  // Forward messages result
  count?: number;
  sourceSessionId?: string;
  workflows?: unknown[];
  workflow?: unknown;
  execution?: unknown;
  executions?: unknown[];
  steps?: unknown[];
  executionId?: string;
  payload?: WorkflowExecutionDispatchPayload;
  // Model failover
  modelPreferences?: string[];
  encoding?: string;
  truncated?: boolean;
  path?: string;
  repo?: string;
  ref?: string;
  name?: string;
  actorId?: string;
  actorName?: string;
  actorEmail?: string;
  pluginContent?: {
    personas: Array<{ filename: string; content: string; sortOrder: number }>;
    skills: Array<{ filename: string; content: string }>;
    tools: Array<{ filename: string; content: string }>;
    allowRepoContent: boolean;
  };
  // Repo config fields (repo-config / repo-token-refreshed)
  token?: string;
  expiresAt?: string;
  gitConfig?: Record<string, string>;
  repoUrl?: string;
  branch?: string;
}

// ─── Durable SQLite Table Schemas ──────────────────────────────────────────

const SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
    content TEXT NOT NULL,
    parts TEXT, -- JSON array of structured parts (tool calls, etc.)
    author_id TEXT,
    author_email TEXT,
    author_name TEXT,
    author_avatar_url TEXT,
    channel_type TEXT,
    channel_id TEXT,
    opencode_session_id TEXT,
    created_at INTEGER NOT NULL DEFAULT (unixepoch())
  );

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

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    actor_id TEXT,
    metadata TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
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

  CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    turn_id TEXT NOT NULL,
    oc_message_id TEXT NOT NULL UNIQUE,
    model TEXT NOT NULL,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL DEFAULT (unixepoch()),
    flushed INTEGER NOT NULL DEFAULT 0
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

  // ─── Auto Channel Reply Tracking ─────────────────────────────────────
  // When a prompt arrives from an external channel (e.g. Telegram), we track
  // the channel context so we can auto-send the agent's response back to it.
  // If the agent explicitly calls channel_reply for that channel, we mark it
  // handled so we don't double-send.
  // V2 active turns being assembled — keyed by turnId (DO messageId)
  private activeTurns = new Map<string, {
    text: string;
    parts: Array<{ type: string; [key: string]: unknown }>;
    channelType?: string;
    channelId?: string;
    opencodeSessionId?: string;
    threadId?: string;
  }>();

  /** Debounce timer for flushing messages to D1 during active turns. */
  private d1FlushTimer: ReturnType<typeof setTimeout> | null = null;

  private pendingChannelReply: {
    channelType: string;
    channelId: string;
    resultContent: string | null;
    resultMessageId: string | null;
    handled: boolean;
  } | null = null;

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
    if (this.pendingChannelReply) {
      return { channelType: this.pendingChannelReply.channelType, channelId: this.pendingChannelReply.channelId };
    }
    // Hibernation recovery: check prompt_queue for processing row with channel metadata
    const recovered = this.recoverPendingChannelReply();
    return recovered ? { channelType: recovered.channelType, channelId: recovered.channelId } : null;
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

      // Migrate existing DOs: add author_avatar_url columns if missing
      try { this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN author_avatar_url TEXT'); } catch { /* already exists */ }
      try { this.ctx.storage.sql.exec('ALTER TABLE prompt_queue ADD COLUMN author_avatar_url TEXT'); } catch { /* already exists */ }
      try { this.ctx.storage.sql.exec('ALTER TABLE prompt_queue ADD COLUMN attachments TEXT'); } catch { /* already exists */ }

      // Migrate existing DOs: add channel metadata columns
      try { this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN channel_type TEXT'); } catch { /* already exists */ }
      try { this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN channel_id TEXT'); } catch { /* already exists */ }
      try { this.ctx.storage.sql.exec('ALTER TABLE prompt_queue ADD COLUMN channel_type TEXT'); } catch { /* already exists */ }
      try { this.ctx.storage.sql.exec('ALTER TABLE prompt_queue ADD COLUMN channel_id TEXT'); } catch { /* already exists */ }

      // Migrate existing DOs: add per-channel session tracking columns
      try { this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN opencode_session_id TEXT'); } catch { /* already exists */ }
      try { this.ctx.storage.sql.exec('ALTER TABLE prompt_queue ADD COLUMN channel_key TEXT'); } catch { /* already exists */ }

      // Migrate existing DOs: add model column to prompt_queue
      try { this.ctx.storage.sql.exec('ALTER TABLE prompt_queue ADD COLUMN model TEXT'); } catch { /* already exists */ }
      try { this.ctx.storage.sql.exec("ALTER TABLE prompt_queue ADD COLUMN queue_type TEXT NOT NULL DEFAULT 'prompt'"); } catch { /* already exists */ }
      try { this.ctx.storage.sql.exec('ALTER TABLE prompt_queue ADD COLUMN workflow_execution_id TEXT'); } catch { /* already exists */ }
      try { this.ctx.storage.sql.exec('ALTER TABLE prompt_queue ADD COLUMN workflow_payload TEXT'); } catch { /* already exists */ }
      this.ctx.storage.sql.exec("UPDATE prompt_queue SET queue_type = 'prompt' WHERE queue_type IS NULL OR queue_type = ''");

      // Migrate: add message_format column for v2 parts-based messages
      try { this.ctx.storage.sql.exec("ALTER TABLE messages ADD COLUMN message_format TEXT NOT NULL DEFAULT 'v2'"); } catch { /* already exists */ }

      // Migrate: add thread_id column for thread-aware messaging
      try { this.ctx.storage.sql.exec('ALTER TABLE messages ADD COLUMN thread_id TEXT'); } catch { /* already exists */ }
      try { this.ctx.storage.sql.exec('ALTER TABLE prompt_queue ADD COLUMN thread_id TEXT'); } catch { /* already exists */ }

      // Migrate: add continuation_context column for queued thread continuations
      try { this.ctx.storage.sql.exec('ALTER TABLE prompt_queue ADD COLUMN continuation_context TEXT'); } catch { /* already exists */ }

      // Migrate: add context_prefix + reply channel columns for thread context routing
      try { this.ctx.storage.sql.exec('ALTER TABLE prompt_queue ADD COLUMN context_prefix TEXT'); } catch { /* already exists */ }
      try { this.ctx.storage.sql.exec('ALTER TABLE prompt_queue ADD COLUMN reply_channel_type TEXT'); } catch { /* already exists */ }
      try { this.ctx.storage.sql.exec('ALTER TABLE prompt_queue ADD COLUMN reply_channel_id TEXT'); } catch { /* already exists */ }

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
        const raw = this.getStateValue('availableModels');
        const models = raw ? JSON.parse(raw) : [];
        return Response.json({ models });
      }
      case '/queue-mode': {
        const body = await request.json() as { queueMode: string; collectDebounceMs?: number };
        this.setStateValue('queueMode', body.queueMode);
        if (body.collectDebounceMs !== undefined) {
          this.setStateValue('collectDebounceMs', String(body.collectDebounceMs));
        }
        return Response.json({ success: true });
      }
      case '/prompt': {
        // HTTP-based prompt submission (alternative to WebSocket)
        const body = await request.json() as { content?: string; contextPrefix?: string; model?: string; attachments?: PromptAttachment[]; interrupt?: boolean; queueMode?: string; channelType?: string; channelId?: string; threadId?: string; authorName?: string; authorEmail?: string; authorId?: string };
        const content = body.content ?? '';
        const attachments = sanitizePromptAttachments(body.attachments);
        console.log(`[SessionAgentDO] /prompt HTTP: content="${content.slice(0, 60)}" channelType=${body.channelType || 'none'} channelId=${body.channelId || 'none'} queueMode=${body.queueMode || 'default'} authorName=${body.authorName || 'none'} authorId=${body.authorId || 'none'}`);
        if (!content && attachments.length === 0) {
          return new Response(JSON.stringify({ error: 'Missing content or attachments' }), { status: 400 });
        }
        // Route prompts through the selected queue mode. If none is provided,
        // fall back to the DO's configured default.
        const effectiveMode = body.interrupt ? 'steer' : (body.queueMode || this.getStateValue('queueMode') || 'followup');
        console.log(`[SessionAgentDO] /prompt HTTP: effectiveMode=${effectiveMode} runnerBusy=${this.getStateValue('runnerBusy')} runnerSockets=${this.ctx.getWebSockets('runner').length}`);

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
            await this.handlePrompt(content, body.model, author, attachments, body.channelType, body.channelId, body.threadId, undefined, body.contextPrefix);
            break;
        }
        console.log(`[SessionAgentDO] /prompt HTTP: completed, runnerBusy=${this.getStateValue('runnerBusy')}`);
        return Response.json({ success: true });
      }
      case '/system-message': {
        const body = await request.json() as { content: string; parts?: Record<string, unknown>; wake?: boolean };
        if (!body.content) {
          return new Response(JSON.stringify({ error: 'Missing content' }), { status: 400 });
        }
        await this.handleSystemMessage(body.content, body.parts, body.wake);
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
        const ownerUserId = this.getStateValue('userId');
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

    // Cache user details for author attribution (only fetch if not already cached)
    if (!this.userDetailsCache.has(userId)) {
      try {
        const user = await getUserById(this.appDb, userId);
        if (user) {
          this.userDetailsCache.set(userId, {
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
        console.error('Failed to fetch user details for cache:', err);
      }
    }

    // Send full session state as a single init message (prevents duplicates on reconnect)
    const messages = this.ctx.storage.sql
      .exec('SELECT id, role, content, parts, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, thread_id, message_format, created_at FROM messages ORDER BY created_at ASC')
      .toArray();

    const status = this.getStateValue('status') || 'idle';
    const sandboxId = this.getStateValue('sandboxId');
    const connectedUsers = await this.getConnectedUsersWithDetails();
    const sessionId = this.getStateValue('sessionId');
    const workspace = this.getStateValue('workspace') || '';
    const title = this.getStateValue('title');

    // Resolve authoritative model catalog from D1 (not from Runner discovery)
    let availableModels: import('@valet/shared').AvailableModels | undefined;
    try {
      availableModels = await resolveAvailableModels(this.appDb, this.env);
    } catch (err) {
      console.error('[SessionAgentDO] Failed to resolve available models for init:', err);
      // Fall back to Runner-discovered models if catalog resolution fails
      const availableModelsRaw = this.getStateValue('availableModels');
      availableModels = availableModelsRaw ? JSON.parse(availableModelsRaw) : undefined;
    }

    // Resolve default model: user prefs → org prefs, validated against catalog
    const initOwnerId = this.getStateValue('userId');
    const initOwnerDetails = initOwnerId ? await this.getUserDetails(initOwnerId) : undefined;
    const initModelPrefs = await this.resolveModelPreferences(initOwnerDetails);
    const candidateDefault = initModelPrefs?.[0] ?? null;
    // Validate that the default model actually exists in the resolved catalog
    const defaultModel = candidateDefault && availableModels
      ? (availableModels.some((p) => p.models.some((m) => m.id === candidateDefault)) ? candidateDefault : null)
      : candidateDefault;

    // Load audit log for late joiners
    const auditLogRows = this.ctx.storage.sql
      .exec('SELECT event_type, summary, actor_id, metadata, created_at FROM audit_log ORDER BY id ASC')
      .toArray();

    // Build init payload — messages included for clients that haven't loaded from D1 yet
    const initPayload = JSON.stringify({
      type: 'init',
      session: {
        id: sessionId,
        status,
        workspace,
        title,
        messages: messages.map((msg) => ({
          id: msg.id,
          role: msg.role,
          content: msg.content,
          parts: msg.parts ? JSON.parse(msg.parts as string) : undefined,
          authorId: msg.author_id || undefined,
          authorEmail: msg.author_email || undefined,
          authorName: msg.author_name || undefined,
          authorAvatarUrl: msg.author_avatar_url || undefined,
          channelType: msg.channel_type || undefined,
          channelId: msg.channel_id || undefined,
          threadId: msg.thread_id || undefined,
          createdAt: msg.created_at,
        })),
      },
      data: {
        sandboxRunning: !!sandboxId,
        runnerConnected: this.ctx.getWebSockets('runner').length > 0,
        runnerBusy: this.getStateValue('runnerBusy') === 'true',
        promptsQueued: this.getQueueLength(),
        connectedClients: this.getClientSockets().length + 1,
        connectedUsers,
        availableModels,
        defaultModel,
        auditLog: auditLogRows.map((row) => ({
          eventType: row.event_type,
          summary: row.summary,
          actorId: row.actor_id || undefined,
          metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
          createdAt: row.created_at,
        })),
      },
    });

    try {
      server.send(initPayload);
    } catch (err) {
      // Init payload too large for WebSocket frame (1MB limit).
      // Send a lightweight init without messages — the client will load from D1 REST API.
      console.error(`[SessionAgentDO] Init payload too large (${(initPayload.length / 1024).toFixed(0)}KB), sending without messages:`, err);
      server.send(JSON.stringify({
        type: 'init',
        session: { id: sessionId, status, workspace, title, messages: [] },
        data: {
          sandboxRunning: !!sandboxId,
          runnerConnected: this.ctx.getWebSockets('runner').length > 0,
          runnerBusy: this.getStateValue('runnerBusy') === 'true',
          promptsQueued: this.getQueueLength(),
          connectedClients: this.getClientSockets().length + 1,
          connectedUsers,
          availableModels,
          defaultModel,
          auditLog: auditLogRows.map((row) => ({
            eventType: row.event_type,
            summary: row.summary,
            actorId: row.actor_id || undefined,
            metadata: row.metadata ? JSON.parse(row.metadata as string) : undefined,
            createdAt: row.created_at,
          })),
        },
      }));
      // Trigger a flush so D1 has the latest data for the REST API fallback
      this.ctx.waitUntil(this.flushMessagesToD1());
    }

    // Send any pending interactive prompts
    const pendingPrompts = this.ctx.storage.sql
      .exec("SELECT * FROM interactive_prompts WHERE status = 'pending'")
      .toArray();

    for (const p of pendingPrompts) {
      const sessionId = this.getStateValue('sessionId') || '';
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
    const userDetails = this.userDetailsCache.get(userId);
    this.broadcastToClients({
      type: 'user.joined',
      userId,
      userDetails: userDetails ? { name: userDetails.name, email: userDetails.email, avatarUrl: userDetails.avatarUrl } : undefined,
      connectedUsers,
    });

    this.appendAuditLog('user.joined', `${userDetails?.name || userDetails?.email || userId} joined`, userId);

    // Notify EventBus
    this.notifyEventBus({
      type: 'session.update',
      sessionId: this.getStateValue('sessionId'),
      userId,
      data: { event: 'user.joined', connectedUsers },
      timestamp: new Date().toISOString(),
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: { 'Sec-WebSocket-Protocol': 'valet' },
    });
  }

  private async upgradeRunner(_request: Request, url: URL): Promise<Response> {
    const token = url.searchParams.get('token');
    const expectedToken = this.getStateValue('runnerToken');

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

    // Mark runner as not-yet-ready. The runner needs to start OpenCode,
    // discover models, etc. before it can accept prompts. Prompts arriving
    // before the runner signals agentStatus: idle will be queued.
    this.setStateValue('runnerReady', 'false');

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
    const queuedCount = this.getQueueLength();
    const hasInitialPrompt = !!this.getStateValue('initialPrompt');
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
    let parsed: ClientMessage | RunnerMessage;

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
      await this.handleRunnerMessage(parsed as RunnerMessage);
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
      this.ctx.storage.sql.exec(
        "UPDATE prompt_queue SET status = 'queued' WHERE status = 'processing'"
      );
      this.setStateValue('runnerBusy', 'false');
      this.setStateValue('runnerReady', 'false');

      const queueLength = this.getQueueLength();
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

          this.appendAuditLog('user.left', `${departingUserDetails?.name || departingUserDetails?.email || userId} left`, userId);

          // Clean up user details cache if no longer connected
          this.userDetailsCache.delete(userId);

          this.notifyEventBus({
            type: 'session.update',
            sessionId: this.getStateValue('sessionId'),
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

  // ─── Alarm Handler ────────────────────────────────────────────────────

  async alarm() {
    const now = Date.now();
    const nowSecs = Math.floor(now / 1000);

    // ─── Collect Mode Flush Check (Phase D) ──────────────────────────
    // Check both per-channel keys (collectFlushAt:{channelKey}) and legacy key (collectFlushAt)
    const perChannelFlushRows = this.ctx.storage.sql
      .exec("SELECT value FROM state WHERE key LIKE 'collectFlushAt:%' AND value != '' LIMIT 1")
      .toArray();
    const hasPerChannelFlush = perChannelFlushRows.length > 0 && parseInt(perChannelFlushRows[0].value as string) <= now;
    const legacyCollectFlushAt = this.getStateValue('collectFlushAt');
    const hasLegacyFlush = !!legacyCollectFlushAt && now >= parseInt(legacyCollectFlushAt);
    if (hasPerChannelFlush || hasLegacyFlush) {
      await this.flushCollectBuffer();
    }

    // ─── Idle Hibernate Check ─────────────────────────────────────────
    const status = this.getStateValue('status');
    const idleTimeoutMsStr = this.getStateValue('idleTimeoutMs');
    const lastActivityStr = this.getStateValue('lastUserActivityAt');

    if (status === 'running' && idleTimeoutMsStr && lastActivityStr) {
      const idleTimeoutMs = parseInt(idleTimeoutMsStr);
      const lastActivity = parseInt(lastActivityStr);

      if (now - lastActivity >= idleTimeoutMs) {
        // Trigger hibernate
        this.ctx.waitUntil(this.performHibernate());
        // Don't return — still process question expiry below
      }
    }

    // ─── Stuck-Processing Watchdog ─────────────────────────────────────
    const WATCHDOG_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes
    const lastDispatchStr = this.getStateValue('lastPromptDispatchedAt');
    if (lastDispatchStr) {
      const lastDispatch = parseInt(lastDispatchStr);
      if (!isNaN(lastDispatch) && (now - lastDispatch) >= WATCHDOG_TIMEOUT_MS) {
        const runnerBusyFlag = this.getStateValue('runnerBusy') === 'true';
        const runnerSockets = this.ctx.getWebSockets('runner');
        if (runnerBusyFlag && runnerSockets.length === 0) {
          console.warn(`[SessionAgentDO] Watchdog: prompt stuck in processing for ${Math.round((now - lastDispatch) / 1000)}s with no runner — recovering`);
          this.ctx.storage.sql.exec("UPDATE prompt_queue SET status = 'queued' WHERE status = 'processing'");
          this.setStateValue('runnerBusy', 'false');
          this.setStateValue('lastPromptDispatchedAt', '');
          await this.flushPendingChannelReply();
          this.broadcastToClients({
            type: 'status',
            data: { runnerBusy: false, watchdogRecovery: true },
          });
          this.appendAuditLog('watchdog.recovery', `Reverted stuck processing prompt after ${Math.round((now - lastDispatch) / 1000)}s`);
        }
      }
    }

    // ─── Stuck Queue Watchdog ────────────────────────────────────────
    // Handles the case where runnerBusy=true but there are no processing
    // entries — e.g. an abort acknowledgment was lost. If queued items exist
    // and nothing is processing, force-drain the queue.
    {
      const queuedCount = this.getQueueLength();
      if (queuedCount > 0 && this.getStateValue('runnerBusy') === 'true') {
        const processingCount = Number(
          this.ctx.storage.sql.exec("SELECT COUNT(*) AS c FROM prompt_queue WHERE status = 'processing'").one().c
        );
        if (processingCount === 0) {
          const runnerSockets = this.ctx.getWebSockets('runner');
          console.warn(`[SessionAgentDO] Watchdog: ${queuedCount} queued items with runnerBusy=true but 0 processing — recovering (runner=${runnerSockets.length > 0 ? 'connected' : 'disconnected'})`);
          this.setStateValue('runnerBusy', 'false');
          this.setStateValue('lastPromptDispatchedAt', '');
          if (runnerSockets.length > 0) {
            await this.sendNextQueuedPrompt();
          }
          this.broadcastToClients({
            type: 'status',
            data: { runnerBusy: this.getStateValue('runnerBusy') === 'true', watchdogRecovery: true },
          });
          this.appendAuditLog('watchdog.queue_recovery', `Recovered ${queuedCount} stuck queued items (0 processing)`);
        }
      }
    }

    // ─── Error Safety-Net ────────────────────────────────────────────
    const errorSafetyNetStr = this.getStateValue('errorSafetyNetAt');
    if (errorSafetyNetStr) {
      const errorSafetyNet = parseInt(errorSafetyNetStr);
      if (!isNaN(errorSafetyNet) && now >= errorSafetyNet) {
        const runnerBusyFlag2 = this.getStateValue('runnerBusy') === 'true';
        if (runnerBusyFlag2) {
          console.warn('[SessionAgentDO] Error safety-net: forcing prompt complete after error timeout');
          this.setStateValue('errorSafetyNetAt', '');
          await this.flushPendingChannelReply();
          await this.handlePromptComplete();
          this.appendAuditLog('error.safety_net', 'Forced prompt complete after error safety-net timeout');
        } else {
          this.setStateValue('errorSafetyNetAt', '');
        }
      }
    }

    // ─── Parent Idle Debounce Flush ─────────────────────────────────
    const parentIdleNotifyAtStr = this.getStateValue('parentIdleNotifyAt');
    if (parentIdleNotifyAtStr) {
      const parentIdleNotifyAt = parseInt(parentIdleNotifyAtStr);
      if (!isNaN(parentIdleNotifyAt) && now >= parentIdleNotifyAt) {
        // Re-verify idle conditions before sending
        const idleStatus = this.getStateValue('status');
        const idleRunnerBusy = this.getStateValue('runnerBusy') === 'true';
        const idleQueued = this.getQueueLength();
        const idleLast = this.getStateValue('lastParentIdleNotice');
        const idleSessionId = this.getStateValue('sessionId');

        this.setStateValue('parentIdleNotifyAt', '');

        if (idleSessionId && idleStatus === 'running' && !idleRunnerBusy && idleQueued === 0 && idleLast !== 'true') {
          this.setStateValue('lastParentIdleNotice', 'true');
          this.ctx.waitUntil(this.notifyParentEvent(`Child session event: ${idleSessionId} is idle.`, { wake: true }));
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
          this.sendToRunner({ type: 'call-tool-result', requestId: epRequestId, error: `Action "${toolId}" approval expired after 10 minutes` } as any);
        } else {
          console.warn(`[SessionAgentDO] Approval prompt ${epId} expired with no request_id — runner may be stuck`);
        }

        this.appendAuditLog('agent.tool_call', `Action ${toolId} approval expired`, undefined, { invocationId: epId });
      } else if (epType === 'question') {
        this.sendToRunner({
          type: 'answer',
          questionId: epId,
          answer: '__expired__',
        });

        this.appendAuditLog('agent.question', `Question ${epId} expired`, undefined, { questionId: epId });
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

    // ─── Periodic Metrics Flush ──────────────────────────────────────
    this.ctx.waitUntil(this.flushMetrics());

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
      const intervalMs = parseInt(this.getStateValue('channelFollowupIntervalMs') || '300000');
      const lifecycleStatus = this.getStateValue('status');

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
      if (!this.requiresExplicitChannelReply(channelType)) {
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
        this.appendAuditLog(
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

    // If there are still pending interactive prompts with future expiry, or pending followups, schedule next alarm
    let nextAlarmMs: number | null = null;

    const nextExpiry = this.ctx.storage.sql
      .exec(
        "SELECT MIN(expires_at) as next FROM interactive_prompts WHERE status = 'pending' AND expires_at IS NOT NULL"
      )
      .toArray();

    if (nextExpiry.length > 0 && nextExpiry[0].next) {
      const promptMs = (nextExpiry[0].next as number) * 1000;
      if (promptMs > now) {
        nextAlarmMs = promptMs;
      }
    }

    const nextFollowup = this.ctx.storage.sql
      .exec("SELECT MIN(next_reminder_at) as next FROM channel_followups WHERE status = 'pending'")
      .toArray();
    if (nextFollowup.length > 0 && nextFollowup[0].next) {
      const followupMs = nextFollowup[0].next as number;
      if (followupMs > now && (nextAlarmMs === null || followupMs < nextAlarmMs)) {
        nextAlarmMs = followupMs;
      }
    }

    // Also consider idle timeout for next alarm
    const alarmStatus = this.getStateValue('status');
    const alarmIdleTimeoutMsStr = this.getStateValue('idleTimeoutMs');
    const alarmLastActivityStr = this.getStateValue('lastUserActivityAt');
    if (alarmStatus === 'running' && alarmIdleTimeoutMsStr && alarmLastActivityStr) {
      const idleTimeoutMs = parseInt(alarmIdleTimeoutMsStr);
      const lastActivity = parseInt(alarmLastActivityStr);
      const idleAlarmMs = lastActivity + idleTimeoutMs;
      if (idleAlarmMs > now && (nextAlarmMs === null || idleAlarmMs < nextAlarmMs)) {
        nextAlarmMs = idleAlarmMs;
      }
    }

    // Also consider parent idle debounce deadline
    const alarmParentIdleStr = this.getStateValue('parentIdleNotifyAt');
    if (alarmParentIdleStr) {
      const parentIdleMs = parseInt(alarmParentIdleStr);
      if (!isNaN(parentIdleMs) && parentIdleMs > now && (nextAlarmMs === null || parentIdleMs < nextAlarmMs)) {
        nextAlarmMs = parentIdleMs;
      }
    }

    if (nextAlarmMs !== null) {
      this.ctx.storage.setAlarm(nextAlarmMs);
    }
  }

  // ─── Client Message Handling ───────────────────────────────────────────

  private async handleClientMessage(ws: WebSocket, msg: ClientMessage) {
    switch (msg.type) {
      case 'prompt': {
        const attachments = sanitizePromptAttachments(msg.attachments);
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
        const wsQueueMode = (msg as any).queueMode || this.getStateValue('queueMode') || 'followup';
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
        this.sendToRunner({ type: 'review', requestId: reviewRequestId });
        break;
      }

      case 'approve-action': {
        if (!msg.invocationId) {
          ws.send(JSON.stringify({ type: 'error', message: 'Missing invocationId' }));
          return;
        }
        await this.handlePromptResolved(msg.invocationId, {
          actionId: 'approve',
          resolvedBy: this.getStateValue('userId') || 'user',
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
          resolvedBy: this.getStateValue('userId') || 'user',
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
            this.sendToRunner({
              type: 'opencode-command',
              command: cmd,
              args: cmdArgs,
              requestId: crypto.randomUUID(),
            } as any);
            break;
          case 'new-session': {
            const channelType = msg.channelType || 'web';
            const channelId = msg.channelId || 'default';
            this.sendToRunner({
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
  ) {
    // ─── Thread-reply capture for free-text questions ──────────────────
    // If there's a pending question with no actions (free-text) and this message
    // came from a channel (not web UI) by the session owner, treat it as the answer.
    const sessionOwnerId = this.getStateValue('userId');
    if (channelType && channelType !== 'web' && author?.id && author.id === sessionOwnerId) {
      const freeTextPrompts = this.ctx.storage.sql
        .exec("SELECT id, context FROM interactive_prompts WHERE type = 'question' AND status = 'pending' AND (actions IS NULL OR actions = '[]')")
        .toArray();

      const matchingPrompt = freeTextPrompts.find((row) => {
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

      if (matchingPrompt) {
        const promptId = matchingPrompt.id as string;
        const answerText = content || '';
        await this.handlePromptResolved(promptId, {
          value: answerText,
          resolvedBy: author.id,
        });
        return;
      }
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

    // Update idle tracking
    this.setStateValue('lastUserActivityAt', String(Date.now()));
    this.rescheduleIdleAlarm();

    // Track the current prompt author for PR attribution (Part 6)
    if (author?.id) {
      this.setStateValue('currentPromptAuthorId', author.id);
    }

    // If hibernated, auto-trigger wake before processing
    const currentStatus = this.getStateValue('status');
    if (currentStatus === 'hibernated') {
      // Fire wake in background — prompt will be queued since runner won't be connected yet
      this.ctx.waitUntil(this.performWake());
    }
    // Note: if status is 'hibernating', the prompt will be queued below (runner
    // is disconnecting). performHibernate() checks the queue after completing
    // and auto-wakes if needed.

    const normalizedAttachments = sanitizePromptAttachments(attachments);
    const attachmentParts = attachmentPartsForMessage(normalizedAttachments);
    const serializedAttachmentParts = attachmentParts.length > 0 ? JSON.stringify(attachmentParts) : null;
    const serializedQueuedAttachments = normalizedAttachments.length > 0 ? JSON.stringify(normalizedAttachments) : null;

    // Store user message with author info and channel metadata
    const messageId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      'INSERT INTO messages (id, role, content, parts, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      messageId, 'user', content, serializedAttachmentParts,
      author?.id || null, author?.email || null, author?.name || null, author?.avatarUrl || null,
      channelType || null, channelId || null, threadId || null
    );

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

    this.appendAuditLog(
      'user.prompt',
      content
        ? content.slice(0, 120)
        : `[${normalizedAttachments.length} image attachment(s)]`,
      author?.id
    );

    // Check if runner is busy / ready
    const channelKey = this.channelKeyFrom(channelType, channelId);
    const runnerBusy = this.getStateValue('runnerBusy') === 'true';
    const runnerSockets = this.ctx.getWebSockets('runner');
    const runnerConnected = runnerSockets.length > 0;
    const runnerReady = this.getStateValue('runnerReady') !== 'false';
    const status = this.getStateValue('status');
    const sandboxId = this.getStateValue('sandboxId');
    const queuedCount = this.getQueueLength();

    console.log(
      `[SessionAgentDO] handlePrompt: channel=${channelKey} runnerConnected=${runnerConnected} runnerReady=${runnerReady} runnerBusy=${runnerBusy} status=${status} sandboxId=${sandboxId || 'none'} queued=${queuedCount}`
    );

    if (!runnerConnected || !runnerReady) {
      // No runner connected or runner still initializing (OpenCode not healthy yet)
      // — queue the prompt with author info + channel metadata
      const reason = !runnerConnected ? 'no runner connected' : 'runner not ready';
      this.ctx.storage.sql.exec(
        "INSERT INTO prompt_queue (id, content, attachments, model, status, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, channel_key, thread_id, continuation_context, context_prefix, reply_channel_type, reply_channel_id) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        messageId, content, serializedQueuedAttachments, model || null,
        author?.id || null, author?.email || null, author?.name || null, author?.avatarUrl || null,
        channelType || null, channelId || null, channelKey, threadId || null, continuationContext || null,
        contextPrefix || null, replyChannelType || null, replyChannelId || null
      );
      this.appendAuditLog(
        'prompt.queued',
        `Queued: ${reason} (status=${status || 'unknown'}, sandbox=${sandboxId ? 'yes' : 'no'}, queued=${this.getQueueLength()})`,
        author?.id
      );
      this.broadcastToClients({
        type: 'status',
        data: { promptQueued: true, queuePosition: this.getQueueLength(), queueReason: 'waking' },
      });
      return;
    }

    if (runnerBusy) {
      // Runner is processing another prompt — queue with author info + channel metadata
      console.log(`[SessionAgentDO] handlePrompt: QUEUING (runnerBusy=true) channel=${channelKey} messageId=${messageId}`);
      this.ctx.storage.sql.exec(
        "INSERT INTO prompt_queue (id, content, attachments, model, status, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, channel_key, thread_id, continuation_context, context_prefix, reply_channel_type, reply_channel_id) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        messageId, content, serializedQueuedAttachments, model || null,
        author?.id || null, author?.email || null, author?.name || null, author?.avatarUrl || null,
        channelType || null, channelId || null, channelKey, threadId || null, continuationContext || null,
        contextPrefix || null, replyChannelType || null, replyChannelId || null
      );
      this.appendAuditLog(
        'prompt.queued',
        `Queued: runner busy (status=${status || 'unknown'}, sandbox=${sandboxId ? 'yes' : 'no'}, queued=${this.getQueueLength()})`,
        author?.id
      );
      this.broadcastToClients({
        type: 'status',
        data: { promptQueued: true, queuePosition: this.getQueueLength(), queueReason: 'busy' },
      });
      return;
    }

    console.log(`[SessionAgentDO] handlePrompt: DISPATCHING DIRECTLY channel=${channelKey} messageId=${messageId}`);
    // Insert into prompt_queue as 'processing' so it can be recovered if the runner disconnects
    this.ctx.storage.sql.exec(
      "INSERT INTO prompt_queue (id, content, attachments, model, status, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, channel_key, thread_id, continuation_context, context_prefix, reply_channel_type, reply_channel_id) VALUES (?, ?, ?, ?, 'processing', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      messageId, content, serializedQueuedAttachments, model || null,
      author?.id || null, author?.email || null, author?.name || null, author?.avatarUrl || null,
      channelType || null, channelId || null, channelKey, threadId || null, continuationContext || null,
      contextPrefix || null, replyChannelType || null, replyChannelId || null
    );

    // Forward directly to runner with author info + channel metadata
    this.setStateValue('runnerBusy', 'true');
    this.setStateValue('lastPromptDispatchedAt', String(Date.now()));
    this.setStateValue('lastParentIdleNotice', '');
    this.setStateValue('parentIdleNotifyAt', '');
    this.rescheduleIdleAlarm();
    console.log('[SessionAgentDO] handlePrompt: dispatching to runner (DO_CODE_VERSION=v2-pipeline-2)');

    // Track channel context for auto-reply on completion using the ORIGINAL channel
    // (e.g., slack:C123:thread_ts), not the normalized thread routing key.
    // This ensures the agent is prompted to reply via the originating channel.
    if (replyChannelType && replyChannelId && this.requiresExplicitChannelReply(replyChannelType)) {
      this.pendingChannelReply = { channelType: replyChannelType, channelId: replyChannelId, resultContent: null, resultMessageId: null, handled: false };

      // Record a follow-up reminder so the agent gets nudged if it doesn't send a substantive reply
      this.insertChannelFollowup(replyChannelType, replyChannelId, content);
    } else {
      this.pendingChannelReply = null;
    }

    // Resolve model preferences: user prefs > org prefs fallback
    const ownerId = this.getStateValue('userId');
    const ownerDetails = ownerId ? await this.getUserDetails(ownerId) : undefined;
    const resolvedModelPrefs = await this.resolveModelPreferences(ownerDetails);
    // Agent sees contextPrefix + content; stored messages/queue only have the user's actual message
    const agentContent = contextPrefix
      ? `${contextPrefix}\n\n${content}`
      : content;

    const channelOcSessionId = this.getChannelOcSessionId(channelKey);
    const dispatched = this.sendToRunner({
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
      this.ctx.storage.sql.exec("UPDATE prompt_queue SET status = 'queued' WHERE id = ?", messageId);
      this.setStateValue('runnerBusy', 'false');
      this.pendingChannelReply = null;
      this.appendAuditLog('prompt.dispatch_failed', `Dispatch failed, reverted to queue: ${messageId}`);
    }
  }

  private async handleAnswer(questionId: string, answer: string | boolean) {
    await this.handlePromptResolved(questionId, {
      value: String(answer),
      resolvedBy: this.getStateValue('userId') || 'user',
    });
  }

  private async handleAbort(channelType?: string, channelId?: string) {
    if (channelType && channelId) {
      // Channel-scoped abort — only clear this channel's queued prompts
      const channelKey = this.channelKeyFrom(channelType, channelId);
      this.ctx.storage.sql.exec(
        "DELETE FROM prompt_queue WHERE status = 'queued' AND channel_key = ?",
        channelKey
      );
      this.sendToRunner({ type: 'abort', channelType, channelId });
    } else {
      // Global abort — clear all queued prompts
      this.ctx.storage.sql.exec("DELETE FROM prompt_queue WHERE status = 'queued'");
      this.sendToRunner({ type: 'abort' });
    }

    // Broadcast status immediately (runner will confirm with 'aborted')
    this.broadcastToClients({
      type: 'agentStatus',
      status: 'idle',
    });

    this.appendAuditLog('user.abort', `User aborted agent${channelType ? ` (channel: ${channelType}:${channelId})` : ''}`);
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
    // Normalize threadId to channel routing for abort targeting
    const abortChannelType = threadId ? 'thread' : channelType;
    const abortChannelId = threadId ? threadId : channelId;

    const runnerBusy = this.getStateValue('runnerBusy') === 'true';
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
    // Update idle tracking
    this.setStateValue('lastUserActivityAt', String(Date.now()));
    this.rescheduleIdleAlarm();

    const normalizedAttachments = sanitizePromptAttachments(attachments);
    const attachmentParts = attachmentPartsForMessage(normalizedAttachments);
    const serializedAttachmentParts = attachmentParts.length > 0 ? JSON.stringify(attachmentParts) : null;

    // Store user message immediately for display (including channel metadata)
    const messageId = crypto.randomUUID();
    this.ctx.storage.sql.exec(
      'INSERT INTO messages (id, role, content, parts, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, thread_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      messageId, 'user', content, serializedAttachmentParts,
      author?.id || null, author?.email || null, author?.name || null, author?.avatarUrl || null,
      channelType || null, channelId || null, threadId || null,
    );

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
    const bufferStateKey = `collectBuffer:${collectChannelKey}`;
    const bufferRaw = this.getStateValue(bufferStateKey);
    const buffer: Array<{ content: string; model?: string; author?: typeof author; attachments?: PromptAttachment[]; channelType?: string; channelId?: string; threadId?: string; contextPrefix?: string }> =
      bufferRaw ? JSON.parse(bufferRaw) : [];
    buffer.push({ content, model, author, attachments: normalizedAttachments.length > 0 ? normalizedAttachments : undefined, channelType, channelId, threadId, contextPrefix });
    this.setStateValue(bufferStateKey, JSON.stringify(buffer));

    // Set flush time (per-channel)
    const debounceMs = parseInt(this.getStateValue('collectDebounceMs') || '3000');
    const flushAt = Date.now() + debounceMs;
    this.setStateValue(`collectFlushAt:${collectChannelKey}`, String(flushAt));

    // Schedule alarm for collect flush (uses min of flush and existing idle alarm)
    this.rescheduleCollectAlarm(flushAt);

    // Broadcast collect status
    this.broadcastToClients({
      type: 'status',
      data: { collectPending: true, collectCount: buffer.length },
    });
  }

  private rescheduleCollectAlarm(flushAt: number): void {
    // Use the earliest of: collect flush, idle timeout, question expiry, channel followups
    let earliestAlarm = flushAt;

    const idleTimeoutMsStr = this.getStateValue('idleTimeoutMs');
    const lastActivityStr = this.getStateValue('lastUserActivityAt');
    if (idleTimeoutMsStr && lastActivityStr) {
      const idleAlarm = parseInt(lastActivityStr) + parseInt(idleTimeoutMsStr);
      if (idleAlarm < earliestAlarm) earliestAlarm = idleAlarm;
    }

    const nextExpiry = this.ctx.storage.sql
      .exec("SELECT MIN(expires_at) as next FROM interactive_prompts WHERE status = 'pending' AND expires_at IS NOT NULL")
      .toArray();
    if (nextExpiry.length > 0 && nextExpiry[0].next) {
      const promptMs = (nextExpiry[0].next as number) * 1000;
      if (promptMs < earliestAlarm) earliestAlarm = promptMs;
    }

    const nextFollowup = this.ctx.storage.sql
      .exec("SELECT MIN(next_reminder_at) as next FROM channel_followups WHERE status = 'pending'")
      .toArray();
    if (nextFollowup.length > 0 && nextFollowup[0].next) {
      const followupMs = nextFollowup[0].next as number;
      if (followupMs < earliestAlarm) earliestAlarm = followupMs;
    }

    const parentIdleStr = this.getStateValue('parentIdleNotifyAt');
    if (parentIdleStr) {
      const parentIdleMs = parseInt(parentIdleStr);
      if (!isNaN(parentIdleMs) && parentIdleMs < earliestAlarm) earliestAlarm = parentIdleMs;
    }

    this.ctx.storage.setAlarm(earliestAlarm);
  }

  private async flushCollectBuffer(): Promise<void> {
    // Flush all per-channel collect buffers that are ready
    const stateRows = this.ctx.storage.sql
      .exec("SELECT key, value FROM state WHERE key LIKE 'collectFlushAt:%'")
      .toArray();

    const now = Date.now();
    let flushed = false;

    for (const row of stateRows) {
      const key = row.key as string;
      const flushAt = parseInt(row.value as string);
      if (!flushAt || now < flushAt) continue;

      const channelKey = key.replace('collectFlushAt:', '');
      const bufferStateKey = `collectBuffer:${channelKey}`;
      const bufferRaw = this.getStateValue(bufferStateKey);
      if (!bufferRaw) {
        this.setStateValue(key, '');
        continue;
      }

      const buffer: Array<{ content: string; model?: string; author?: any; attachments?: PromptAttachment[]; channelType?: string; channelId?: string; threadId?: string; contextPrefix?: string }> = JSON.parse(bufferRaw);
      if (buffer.length === 0) {
        this.setStateValue(bufferStateKey, '');
        this.setStateValue(key, '');
        continue;
      }

      // Clear buffer and flush state for this channel
      this.setStateValue(bufferStateKey, '');
      this.setStateValue(key, '');

      // Merge messages
      const mergedContent = buffer.map((b) => b.content).join('\n\n---\n\n');
      const lastEntry = buffer[buffer.length - 1];
      const allAttachments = buffer.flatMap((b) => b.attachments || []);
      const channelType = lastEntry.channelType;
      const channelId = lastEntry.channelId;
      // Preserve threadId so the merged prompt maintains thread association
      const threadId = lastEntry.threadId;
      // Use the first entry's contextPrefix (thread history from initial invocation)
      const mergedContextPrefix = buffer.find((b) => b.contextPrefix)?.contextPrefix;

      // Send merged prompt through normal flow with channel and thread info
      await this.handlePrompt(mergedContent, lastEntry.model, lastEntry.author, allAttachments, channelType, channelId, threadId, undefined, mergedContextPrefix);
      flushed = true;
    }

    // Also check legacy non-keyed buffer for backward compatibility
    const legacyBufferRaw = this.getStateValue('collectBuffer');
    if (legacyBufferRaw) {
      const legacyFlushAt = this.getStateValue('collectFlushAt');
      if (legacyFlushAt && now >= parseInt(legacyFlushAt)) {
        const buffer: Array<{ content: string; model?: string; author?: any; attachments?: PromptAttachment[] }> = JSON.parse(legacyBufferRaw);
        if (buffer.length > 0) {
          this.setStateValue('collectBuffer', '');
          this.setStateValue('collectFlushAt', '');
          const mergedContent = buffer.map((b) => b.content).join('\n\n---\n\n');
          const lastEntry = buffer[buffer.length - 1];
          const allAttachments = buffer.flatMap((b) => b.attachments || []);
          await this.handlePrompt(mergedContent, lastEntry.model, lastEntry.author, allAttachments);
          flushed = true;
        }
      }
    }

    if (flushed) {
      // Broadcast collect complete
      this.broadcastToClients({
        type: 'status',
        data: { collectPending: false, collectCount: 0 },
      });
    }

    // Reschedule idle alarm (since we consumed the collect alarm slot)
    this.rescheduleIdleAlarm();
  }

  private async handleRevert(messageId: string) {
    // Find the message and all messages created at or after it
    const targetMsg = this.ctx.storage.sql
      .exec('SELECT created_at FROM messages WHERE id = ?', messageId)
      .toArray();

    if (targetMsg.length === 0) {
      return; // Message not found
    }

    const createdAt = targetMsg[0].created_at as number;
    const affectedMessages = this.ctx.storage.sql
      .exec('SELECT id FROM messages WHERE created_at >= ? ORDER BY created_at ASC', createdAt)
      .toArray();

    const removedIds = affectedMessages.map((m) => m.id as string);

    // Delete the messages from SQLite
    if (removedIds.length > 0) {
      const placeholders = removedIds.map(() => '?').join(',');
      this.ctx.storage.sql.exec(
        `DELETE FROM messages WHERE id IN (${placeholders})`,
        ...removedIds
      );
    }

    // Forward to runner so OpenCode can revert too
    this.sendToRunner({ type: 'revert', messageId });

    // Broadcast removal to all clients
    this.broadcastToClients({
      type: 'messages.removed',
      messageIds: removedIds,
    });
  }

  private async handleDiff() {
    const requestId = crypto.randomUUID();
    this.sendToRunner({ type: 'diff', requestId });
  }

  // ─── Runner Message Handling ───────────────────────────────────────────

  private async handleRunnerMessage(msg: RunnerMessage) {
    console.log(`[SessionAgentDO] Runner message: type=${msg.type}`);

    // Reset idle timer on any runner activity — agent work counts as session activity
    if (msg.type === 'agentStatus' || msg.type === 'message.create' || msg.type === 'message.part.text-delta' || msg.type === 'message.part.tool-update' || msg.type === 'message.finalize') {
      this.setStateValue('lastUserActivityAt', String(Date.now()));
      this.rescheduleIdleAlarm();
    }

    switch (msg.type) {
      case 'usage-report': {
        const entries = msg.entries;
        if (Array.isArray(entries)) {
          for (const entry of entries) {
            try {
              this.ctx.storage.sql.exec(
                'INSERT OR IGNORE INTO usage_events (turn_id, oc_message_id, model, input_tokens, output_tokens) VALUES (?, ?, ?, ?, ?)',
                msg.turnId ?? '',
                entry.ocMessageId ?? '',
                entry.model ?? 'unknown',
                entry.inputTokens ?? 0,
                entry.outputTokens ?? 0,
              );
            } catch (err) {
              console.error('[SessionAgentDO] Failed to insert usage event:', err);
            }
          }
        }
        break;
      }

      case 'tunnels': {
        if (Array.isArray(msg.tunnels)) {
          this.setStateValue('tunnels', JSON.stringify(msg.tunnels));
        } else {
          this.setStateValue('tunnels', '');
        }
        break;
      }

      case 'workflow-chat-message': {
        const role = msg.role === 'assistant' || msg.role === 'system' ? msg.role : 'user';
        const content = (msg.content || '').trim();
        if (!content) break;

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
        this.ctx.storage.sql.exec(
          'INSERT INTO messages (id, role, content, parts, channel_type, channel_id, opencode_session_id) VALUES (?, ?, ?, ?, ?, ?, ?)',
          workflowMsgId,
          role,
          content,
          partsJson,
          workflowChannelType,
          workflowChannelId,
          workflowOcSessionId,
        );
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
        break;
      }

      case 'question': {
        // Store question as interactive prompt and broadcast to all clients
        const qId = msg.questionId || crypto.randomUUID();
        const questionCh = this.activeChannel;
        const QUESTION_TIMEOUT_SECS = 5 * 60; // 5 minutes
        const expiresAt = Math.floor(Date.now() / 1000) + QUESTION_TIMEOUT_SECS;
        const sessionId = this.getStateValue('sessionId') || '';

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
          msg.requestId || null,
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
        const ownerUserId = this.getStateValue('userId') || undefined;
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
        break;
      }

      case 'screenshot': {
        // Store screenshot reference and broadcast
        const ssId = crypto.randomUUID();
        const ssCh = this.activeChannel;
        this.ctx.storage.sql.exec(
          'INSERT INTO messages (id, role, content, parts, channel_type, channel_id) VALUES (?, ?, ?, ?, ?, ?)',
          ssId, 'system', msg.description || 'Screenshot',
          JSON.stringify({ type: 'screenshot', data: msg.data }),
          ssCh?.channelType ?? null, ssCh?.channelId ?? null
        );
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
        break;
      }

      case 'audio-transcript': {
        // Runner transcribed audio attachments — update the original user message parts with transcript
        if (msg.messageId && msg.transcript) {
          const existing = this.ctx.storage.sql.exec(
            'SELECT parts FROM messages WHERE id = ?', msg.messageId,
          ).toArray();
          if (existing.length > 0) {
            const rawParts = existing[0].parts as string | null;
            let parts: Array<Record<string, unknown>> = [];
            if (rawParts) {
              try {
                const parsed = JSON.parse(rawParts);
                parts = Array.isArray(parsed) ? parsed : [parsed];
              } catch { /* ignore */ }
            }
            // Add transcript to each audio part
            for (const part of parts) {
              if (part.type === 'audio') {
                part.transcript = msg.transcript;
              }
            }
            this.ctx.storage.sql.exec(
              'UPDATE messages SET parts = ? WHERE id = ?',
              JSON.stringify(parts), msg.messageId,
            );
            // Broadcast updated message to all clients
            this.broadcastToClients({
              type: 'message.updated',
              data: { id: msg.messageId, parts },
            });
          }
        }
        break;
      }

      case 'error': {
        // Store error and broadcast
        // Always generate a new ID — msg.messageId is the prompt's user message ID,
        // which already exists in the messages table (PRIMARY KEY conflict).
        const errId = crypto.randomUUID();
        const errCh = this.activeChannel;
        const errorText = msg.error || msg.content || 'Unknown error';
        this.ctx.storage.sql.exec(
          'INSERT INTO messages (id, role, content, channel_type, channel_id) VALUES (?, ?, ?, ?, ?)',
          errId, 'system', `Error: ${errorText}`, errCh?.channelType ?? null, errCh?.channelId ?? null
        );
        this.broadcastToClients({
          type: 'error',
          messageId: errId,
          error: msg.error || msg.content,
          ...(errCh ? { channelType: errCh.channelType, channelId: errCh.channelId } : {}),
        });
        this.appendAuditLog('agent.error', errorText.slice(0, 120));

        // Safety-net: if runner doesn't send 'complete' within 60s, force flush
        const ERROR_SAFETY_NET_MS = 60_000;
        this.setStateValue('errorSafetyNetAt', String(Date.now() + ERROR_SAFETY_NET_MS));
        this.rescheduleIdleAlarm();

        // Publish session.errored to EventBus
        this.notifyEventBus({
          type: 'session.errored',
          sessionId: this.getStateValue('sessionId') || undefined,
          userId: this.getStateValue('userId') || undefined,
          data: { error: errorText, messageId: errId },
          timestamp: new Date().toISOString(),
        });
        await this.enqueueOwnerNotification({
          messageType: 'escalation',
          content: `Session error: ${errorText}`,
          contextSessionId: this.getStateValue('sessionId') || undefined,
        });
        break;
      }

      // ─── V2 Parts-Based Message Protocol ──────────────────────────────
      case 'message.create': {
        const turnId = msg.turnId!;
        // Resolve threadId: prefer Runner-provided value, fall back to the currently-processing prompt's threadId
        let resolvedThreadId = msg.threadId || undefined;
        if (!resolvedThreadId) {
          const processingRow = this.ctx.storage.sql
            .exec("SELECT thread_id FROM prompt_queue WHERE status = 'processing' ORDER BY created_at DESC LIMIT 1")
            .toArray();
          if (processingRow.length > 0 && processingRow[0].thread_id) {
            resolvedThreadId = processingRow[0].thread_id as string;
          }
        }
        console.log(`[SessionAgentDO] V2 message.create: turnId=${turnId} threadId=${resolvedThreadId || 'none'}`);
        this.activeTurns.set(turnId, {
          text: '',
          parts: [],
          channelType: msg.channelType || undefined,
          channelId: msg.channelId || undefined,
          opencodeSessionId: msg.opencodeSessionId || undefined,
          threadId: resolvedThreadId,
        });
        // Insert a placeholder row in DO SQLite (will be UPSERTed on finalize)
        this.ctx.storage.sql.exec(
          "INSERT OR IGNORE INTO messages (id, role, content, parts, message_format, channel_type, channel_id, opencode_session_id, thread_id) VALUES (?, 'assistant', '', '[]', 'v2', ?, ?, ?, ?)",
          turnId, msg.channelType || null, msg.channelId || null, msg.opencodeSessionId || null, resolvedThreadId || null
        );
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
        break;
      }

      case 'message.part.text-delta': {
        let turn = this.activeTurns.get(msg.turnId!);
        if (!turn) {
          // Hibernation recovery: reconstruct from SQLite placeholder
          turn = this.recoverTurnFromSQLite(msg.turnId!);
          if (!turn) {
            console.warn(`[SessionAgentDO] text-delta for unknown turn ${msg.turnId}`);
            break;
          }
        }
        const delta = msg.delta || '';
        turn.text += delta;
        // Update or create the current streaming text part.
        // If the last part is a non-text part (e.g. tool-call), start a new text part
        // with only the new delta — not the full accumulated turn.text.
        const lastTextPart = turn.parts[turn.parts.length - 1];
        if (lastTextPart && lastTextPart.type === 'text' && lastTextPart.streaming) {
          lastTextPart.text += delta;
        } else {
          turn.parts.push({ type: 'text', text: delta, streaming: true });
        }
        // Broadcast chunk with messageId so client knows which v2 message to update
        this.broadcastToClients({
          type: 'chunk',
          content: msg.delta || '',
          messageId: msg.turnId,
          ...(turn.channelType ? { channelType: turn.channelType, channelId: turn.channelId } : {}),
        });
        break;
      }

      case 'message.part.tool-update': {
        let turn = this.activeTurns.get(msg.turnId!);
        if (!turn) {
          // Hibernation recovery: reconstruct from SQLite placeholder
          turn = this.recoverTurnFromSQLite(msg.turnId!);
          if (!turn) {
            console.warn(`[SessionAgentDO] tool-update for unknown turn ${msg.turnId}`);
            break;
          }
        }
        // Find existing tool part or create new one
        let toolPart = turn.parts.find(
          (p) => p.type === 'tool-call' && p.callId === msg.callId
        );
        if (toolPart) {
          toolPart.status = msg.status;
          if (msg.args !== undefined) toolPart.args = msg.args;
          if (msg.result !== undefined) toolPart.result = msg.result;
          if (msg.error !== undefined) toolPart.error = msg.error;
        } else {
          // Mark any streaming text part as not streaming before adding tool
          const lastPart = turn.parts[turn.parts.length - 1];
          if (lastPart && lastPart.type === 'text' && lastPart.streaming) {
            lastPart.streaming = false;
          }
          toolPart = {
            type: 'tool-call',
            callId: msg.callId,
            toolName: msg.toolName,
            status: msg.status,
            ...(msg.args !== undefined ? { args: msg.args } : {}),
            ...(msg.result !== undefined ? { result: msg.result } : {}),
            ...(msg.error !== undefined ? { error: msg.error } : {}),
          };
          turn.parts.push(toolPart);
        }
        // Persist parts to SQLite so they survive DO hibernation
        this.ctx.storage.sql.exec(
          "UPDATE messages SET parts = ?, content = ? WHERE id = ?",
          JSON.stringify(turn.parts), turn.text, msg.turnId
        );
        // Schedule debounced D1 flush so tool updates survive page refresh
        this.scheduleDebouncedFlush();
        // Broadcast the full updated message to clients
        this.broadcastToClients({
          type: 'message.updated',
          data: {
            id: msg.turnId,
            role: 'assistant',
            content: turn.text,
            parts: turn.parts,
            ...(turn.channelType ? { channelType: turn.channelType, channelId: turn.channelId } : {}),
            ...(turn.threadId ? { threadId: turn.threadId } : {}),
          },
        });
        break;
      }

      case 'message.finalize': {
        const turnId = msg.turnId!;
        let turn = this.activeTurns.get(turnId);
        if (!turn) {
          // Hibernation recovery: reconstruct from SQLite placeholder
          turn = this.recoverTurnFromSQLite(turnId);
          if (!turn) {
            console.warn(`[SessionAgentDO] finalize for unknown turn ${turnId}`);
            break;
          }
        }
        // Use finalText if provided (may be more complete than streamed chunks)
        const finalContent = msg.finalText || turn.text;
        // If turn was recovered from hibernation with empty parts, populate from finalContent
        if (turn.parts.length === 0 && finalContent) {
          turn.parts.push({ type: 'text', text: finalContent });
        }
        // Mark all text parts as not streaming.
        // If there's only one text part and finalText was provided, use it (more complete).
        // Otherwise preserve the per-part text that was built up during streaming.
        const textParts = turn.parts.filter(p => p.type === 'text');
        if (textParts.length === 1 && msg.finalText) {
          textParts[0].text = finalContent;
        }
        for (const part of textParts) {
          part.streaming = false;
        }
        // Add finish part
        turn.parts.push({ type: 'finish', reason: msg.reason || 'end_turn' });
        // If there was an error, add error part with the last known error
        if (msg.reason === 'error' && msg.error) {
          turn.parts.push({ type: 'error', message: msg.error });
        }
        // UPSERT to DO SQLite
        this.ctx.storage.sql.exec(
          "INSERT OR REPLACE INTO messages (id, role, content, parts, message_format, channel_type, channel_id, opencode_session_id, thread_id) VALUES (?, 'assistant', ?, ?, 'v2', ?, ?, ?, ?)",
          turnId, finalContent, JSON.stringify(turn.parts),
          turn.channelType || null, turn.channelId || null, turn.opencodeSessionId || null, turn.threadId || null
        );
        // Broadcast final message state
        this.broadcastToClients({
          type: 'message.updated',
          data: {
            id: turnId,
            role: 'assistant',
            content: finalContent,
            parts: turn.parts,
            ...(turn.channelType ? { channelType: turn.channelType, channelId: turn.channelId } : {}),
            ...(turn.threadId ? { threadId: turn.threadId } : {}),
          },
        });
        // Track result content for auto channel reply
        if (this.pendingChannelReply && !this.pendingChannelReply.handled && finalContent) {
          this.pendingChannelReply.resultContent = finalContent;
          this.pendingChannelReply.resultMessageId = turnId;
        }
        // Increment thread message count for assistant message
        if (turn.threadId) {
          this.ctx.waitUntil(incrementThreadMessageCount(this.env.DB, turn.threadId));
        }
        // Clean up active turn
        this.activeTurns.delete(turnId);
        console.log(`[SessionAgentDO] V2 turn finalized: ${turnId} (${finalContent.length} chars, ${turn.parts.length} parts)`);
        break;
      }

      case 'complete': {
        // Prompt finished — auto-reply to originating channel if needed
        const pendingReply = this.pendingChannelReply;
        console.log(`[SessionAgentDO] Complete received: pendingChannelReply=${pendingReply ? `${pendingReply.channelType}:${pendingReply.channelId} handled=${pendingReply.handled} resultContent=${pendingReply.resultContent?.length ?? 0}chars` : 'null'} queueLength=${this.getQueueLength()} runnerBusy=${this.getStateValue('runnerBusy')}`);
        await this.flushPendingChannelReply();
        // Check queue for next
        console.log(`[SessionAgentDO] Complete: flushed channel reply, now draining queue`);
        await this.handlePromptComplete();
        // Flush metrics after each agent turn
        this.ctx.waitUntil(this.flushMetrics());
        break;
      }

      case 'agentStatus': {
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
          const wasInitializing = this.getStateValue('runnerReady') === 'false';
          if (wasInitializing) {
            this.setStateValue('runnerReady', 'true');
            console.log('[SessionAgentDO] Runner is now ready (first idle after connect)');
          }

          const currentRunnerBusy = this.getStateValue('runnerBusy') === 'true';
          const currentQueueLen = this.getQueueLength();
          console.log(`[SessionAgentDO] agentStatus: idle (runnerBusy=${currentRunnerBusy}, runnerConnected=${this.ctx.getWebSockets('runner').length > 0}, queued=${currentQueueLen})`);

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
              this.ctx.storage.sql.exec("UPDATE prompt_queue SET status = 'queued' WHERE status = 'processing'");
              this.setStateValue('runnerBusy', 'false');
            }
          } else if (!currentRunnerBusy) {
            // Check for initial prompt (from create-from-PR/Issue) — only if no queued work
            const initialPrompt = this.getStateValue('initialPrompt');
            if (initialPrompt) {
              this.setStateValue('initialPrompt', '');
              const messageId = crypto.randomUUID();
              this.ctx.storage.sql.exec(
                'INSERT INTO messages (id, role, content) VALUES (?, ?, ?)',
                messageId, 'user', initialPrompt
              );
              this.broadcastToClients({
                type: 'message',
                data: {
                  id: messageId,
                  role: 'user',
                  content: initialPrompt,
                  createdAt: Math.floor(Date.now() / 1000),
                },
              });
              this.ctx.storage.sql.exec(
                "INSERT INTO prompt_queue (id, content, status) VALUES (?, ?, 'processing')",
                messageId, initialPrompt
              );
              const ipOwnerId = this.getStateValue('userId');
              const ipOwnerDetails = ipOwnerId ? await this.getUserDetails(ipOwnerId) : undefined;
              const ipModelPrefs = await this.resolveModelPreferences(ipOwnerDetails);
              const initialModel = this.getStateValue('initialModel');
              if (initialModel) {
                this.setStateValue('initialModel', '');
              }
              this.sendToRunner({
                type: 'prompt',
                messageId,
                content: initialPrompt,
                model: initialModel || undefined,
                opencodeSessionId: this.getChannelOcSessionId(this.channelKeyFrom(undefined, undefined)),
                modelPreferences: ipModelPrefs,
              });
              this.setStateValue('runnerBusy', 'true');
              this.setStateValue('lastPromptDispatchedAt', String(Date.now()));
              console.log(`[SessionAgentDO] agentStatus idle: dispatched initial prompt ${messageId}`);
            }
          }

          // Don't set runnerBusy=false here — wait for the authoritative `complete`
          // message. Setting it here creates a window where a new prompt can bypass
          // the queue and be dispatched directly, resulting in two concurrent prompts.
          // The `complete` handler (handlePromptComplete) is the single source of truth.
          this.notifyParentIfIdle();
        } else if (msg.status === 'thinking' || msg.status === 'tool_calling' || msg.status === 'streaming') {
          this.setStateValue('runnerBusy', 'true');
          this.setStateValue('lastParentIdleNotice', '');
          this.setStateValue('parentIdleNotifyAt', '');
        }
        break;
      }

      case 'create-pr': {
        // Runner requests PR creation — call GitHub API directly
        await this.handleCreatePR({
          requestId: msg.requestId,
          branch: msg.branch!,
          title: msg.title!,
          body: msg.body,
          base: msg.base,
        });
        break;
      }

      case 'update-pr': {
        // Runner requests PR update — call GitHub API directly
        await this.handleUpdatePR({
          requestId: msg.requestId,
          prNumber: msg.prNumber!,
          title: msg.title,
          body: msg.body,
          state: msg.state,
          labels: msg.labels,
        });
        break;
      }

      case 'models':
        // Runner discovered available models — store for internal use (failover, context limits)
        // but do NOT broadcast to clients. The UI uses the Worker-resolved catalog from init.
        if (msg.models) {
          this.setStateValue('availableModels', JSON.stringify(msg.models));
          const modelsJson = JSON.stringify(msg.models);
          // Persist to D1 so the settings typeahead works without a running session
          const userId = this.getStateValue('userId');
          if (userId) {
            updateUserDiscoveredModels(this.appDb, userId, modelsJson)
              .catch((err: unknown) => console.error('[SessionAgentDO] Failed to cache models to D1:', err));
          }
          // Cache at org level so resolveAvailableModels() can filter models.dev against real models
          setCatalogCache(this.appDb, 'runner:discovered', modelsJson)
            .catch((err: unknown) => console.error('[SessionAgentDO] Failed to cache org-level discovered models:', err));
        }
        break;

      case 'model-switched': {
        // Runner switched models due to provider error — store notice and broadcast
        const switchId = crypto.randomUUID();
        const switchText = `Model switched from ${msg.fromModel} to ${msg.toModel}: ${msg.reason}`;
        this.ctx.storage.sql.exec(
          'INSERT INTO messages (id, role, content) VALUES (?, ?, ?)',
          switchId, 'system', switchText
        );
        this.broadcastToClients({
          type: 'model-switched',
          messageId: switchId,
          fromModel: msg.fromModel,
          toModel: msg.toModel,
          reason: msg.reason,
        });
        this.appendAuditLog('agent.error', switchText.slice(0, 120));
        break;
      }

      case 'aborted':
        // Runner confirmed abort — mark idle, broadcast
        this.setStateValue('runnerBusy', 'false');
        this.broadcastToClients({
          type: 'agentStatus',
          status: 'idle',
        });
        this.broadcastToClients({
          type: 'status',
          data: { runnerBusy: false, aborted: true },
        });
        // Drain the queue — if prompts were queued after abort, process them now
        await this.handlePromptComplete();
        break;

      case 'reverted':
        // Runner confirmed revert — log for now
        console.log(`[SessionAgentDO] Revert confirmed for messages: ${msg.messageIds?.join(', ')}`);
        break;

      case 'diff':
        // Runner returned diff data — broadcast to clients
        // Runner sends { type, requestId, data: { files } } or { type, requestId, files }
        const diffPayload = typeof msg.data === 'object' && msg.data !== null ? msg.data as Record<string, unknown> : null;
        const diffFiles = diffPayload?.files ?? msg.files ?? [];
        this.broadcastToClients({
          type: 'diff',
          requestId: msg.requestId,
          data: { files: diffFiles },
        });
        break;

      case 'review-result':
        // Runner returned structured review result — broadcast to clients (not stored in DB)
        this.broadcastToClients({
          type: 'review-result',
          requestId: msg.requestId,
          data: msg.data,
          diffFiles: msg.diffFiles,
          error: msg.error,
        });
        break;

      case 'command-result':
        // Runner returned OpenCode command result — broadcast to clients
        this.broadcastToClients({
          type: 'command-result',
          requestId: msg.requestId,
          command: (msg as any).command,
          result: (msg as any).result ?? msg.data,
          error: msg.error,
        });
        break;

      case 'git-state': {
        // Runner reports current git branch/commit state
        const sessionId = this.getStateValue('sessionId');
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
        break;
      }

      case 'pr-created': {
        // Runner reports a PR was created
        const sessionIdPr = this.getStateValue('sessionId');
        if (sessionIdPr && msg.number) {
          updateSessionGitState(this.appDb, sessionIdPr, {
            prNumber: msg.number,
            prTitle: msg.title,
            prUrl: msg.url,
            prState: (msg.status as any) || 'open',
            prCreatedAt: new Date().toISOString(),
          }).catch((err) =>
            console.error('[SessionAgentDO] Failed to update PR state in D1:', err),
          );
        }
        this.broadcastToClients({
          type: 'pr-created',
          data: {
            number: msg.number,
            title: msg.title,
            url: msg.url,
            state: msg.status || 'open',
          },
        } as any);
        this.appendAuditLog('git.pr_created', `PR #${msg.number}: ${msg.title || ''}`, undefined, { prNumber: msg.number, prUrl: msg.url });
        break;
      }

      case 'files-changed': {
        // Runner reports files changed — upsert in D1, broadcast to clients
        const sessionIdFc = this.getStateValue('sessionId');
        const filesChanged = (msg as any).files as Array<{ path: string; status: string; additions?: number; deletions?: number }> | undefined;
        if (sessionIdFc && Array.isArray(filesChanged)) {
          for (const file of filesChanged) {
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
          files: filesChanged ?? [],
        } as any);
        break;
      }

      case 'child-session': {
        // Runner reports a child/sub-agent session was spawned
        this.broadcastToClients({
          type: 'child-session',
          childSessionId: (msg as any).childSessionId,
          title: msg.title,
        } as any);
        break;
      }

      case 'title': {
        // Runner reports session title update
        const sessionIdTitle = this.getStateValue('sessionId');
        const newTitle = msg.title || msg.content;
        if (sessionIdTitle && newTitle) {
          this.setStateValue('title', newTitle);
          updateSessionTitle(this.appDb, sessionIdTitle, newTitle).catch((err) =>
            console.error('[SessionAgentDO] Failed to update session title:', err),
          );
        }
        this.broadcastToClients({
          type: 'title',
          title: newTitle,
        } as any);
        break;
      }

      case 'spawn-child':
        await this.handleSpawnChild(msg.requestId!, {
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
        });
        break;

      case 'session-message':
        await this.handleSessionMessage(msg.requestId!, msg.targetSessionId!, msg.content!, msg.interrupt);
        break;

      case 'session-messages':
        await this.handleSessionMessages(msg.requestId!, msg.targetSessionId!, msg.limit, msg.after);
        break;

      case 'terminate-child':
        await this.handleTerminateChild(msg.requestId!, msg.childSessionId!);
        break;

      case 'channel-session-created': {
        // Runner reports a new per-channel OpenCode session — store in channel_state
        const csChannelKey = msg.channelKey as string | undefined;
        const csOcSessionId = msg.opencodeSessionId as string | undefined;
        if (csChannelKey && csOcSessionId) {
          this.setChannelOcSessionId(csChannelKey, csOcSessionId);
          console.log(`[SessionAgentDO] Channel session created: ${csChannelKey} -> ${csOcSessionId}`);
        }
        break;
      }

      case 'thread.created': {
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
        break;
      }

      case 'thread.updated': {
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
        break;
      }

      case 'session-reset': {
        // Runner confirmed session rotation — insert visual break marker
        const breakId = crypto.randomUUID();
        const srChannelType = (msg as any).channelType as string | undefined;
        const srChannelId = (msg as any).channelId as string | undefined;
        this.ctx.storage.sql.exec(
          'INSERT INTO messages (id, role, content, parts, channel_type, channel_id) VALUES (?, ?, ?, ?, ?, ?)',
          breakId, 'system', 'New session started',
          JSON.stringify({ type: 'session-break' }),
          srChannelType ?? null, srChannelId ?? null
        );
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
        break;
      }

      case 'self-terminate':
        await this.handleSelfTerminate();
        break;

      case 'opencode-config-applied': {
        if (msg.error) {
          console.error(`[SessionAgentDO] OpenCode config apply failed: ${msg.error}`);
          this.appendAuditLog('opencode.config_error', `Config apply failed: ${msg.error}`);
        } else {
          console.log(`[SessionAgentDO] OpenCode config applied (restarted=${msg.restarted ?? false})`);
          if (msg.restarted) {
            this.appendAuditLog('opencode.config_applied', 'OpenCode restarted with new config');
          }
        }
        break;
      }

      // ─── Memory File Operations ────────────────────────────────────────
      case 'mem-read':
        await this.handleMemRead(msg.requestId!, msg.path);
        break;

      case 'mem-write':
        await this.handleMemWrite(msg.requestId!, msg.path!, msg.content!);
        break;

      case 'mem-patch':
        await this.handleMemPatch(msg.requestId!, msg.path!, msg.operations);
        break;

      case 'mem-rm':
        await this.handleMemRm(msg.requestId!, msg.path!);
        break;

      case 'mem-search':
        await this.handleMemSearch(msg.requestId!, msg.query!, msg.path, msg.limit);
        break;

      case 'list-repos':
        await this.handleListRepos(msg.requestId!, msg.source);
        break;

      case 'list-pull-requests':
        await this.handleListPullRequests(msg.requestId!, {
          owner: msg.owner,
          repo: msg.repo,
          state: msg.state,
          limit: msg.limit,
        });
        break;

      case 'inspect-pull-request':
        await this.handleInspectPullRequest(msg.requestId!, {
          prNumber: msg.prNumber!,
          owner: msg.owner,
          repo: msg.repo,
          filesLimit: msg.filesLimit,
          commentsLimit: msg.commentsLimit,
        });
        break;

      case 'list-personas':
        await this.handleListPersonas(msg.requestId!);
        break;

      case 'list-channels':
        await this.handleListChannels(msg.requestId!);
        break;

      case 'get-session-status':
        await this.handleGetSessionStatus(msg.requestId!, msg.targetSessionId!);
        break;

      case 'list-child-sessions':
        await this.handleListChildSessions(msg.requestId!);
        break;
      case 'read-repo-file':
        await this.handleReadRepoFile(msg.requestId!, {
          owner: msg.owner,
          repo: msg.repo,
          repoUrl: msg.repoUrl,
          path: msg.path,
          ref: msg.ref,
        });
        break;

      case 'forward-messages':
        await this.handleForwardMessages(msg.requestId!, msg.targetSessionId!, msg.limit, msg.after);
        break;

      case 'workflow-list':
        await this.handleWorkflowList(msg.requestId!);
        break;

      case 'workflow-sync':
        await this.handleWorkflowSync(msg.requestId!, {
          id: msg.id || msg.workflowId,
          slug: msg.slug,
          name: msg.name || msg.title,
          description: msg.description,
          version: msg.version,
          data: (typeof msg.data === 'object' && msg.data !== null && !Array.isArray(msg.data))
            ? (msg.data as Record<string, unknown>)
            : msg.dataJson,
        });
        break;

      case 'workflow-run':
        await this.handleWorkflowRun(msg.requestId!, msg.workflowId!, msg.variables, {
          repoUrl: msg.repoUrl,
          branch: msg.branch,
          ref: msg.ref,
          sourceRepoFullName: msg.sourceRepoFullName,
        });
        break;

      case 'workflow-executions':
        await this.handleWorkflowExecutions(msg.requestId!, msg.workflowId, msg.limit);
        break;

      case 'workflow-api':
        await this.handleWorkflowApi(msg.requestId!, msg.action || '', msg.payload);
        break;

      case 'trigger-api':
        await this.handleTriggerApi(msg.requestId!, msg.action || '', msg.payload);
        break;

      case 'skill-api':
        await this.handleSkillApi(msg.requestId!, msg.action || '', msg.payload);
        break;

      case 'persona-api':
        await this.handlePersonaApi(msg.requestId!, msg.action || '', msg.payload);
        break;

      case 'execution-api':
        await this.handleExecutionApi(msg.requestId!, msg.action || '', msg.payload);
        break;

      case 'workflow-execution-result':
        await this.handleWorkflowExecutionResult(msg);
        break;

      // ─── Phase C: Mailbox + Task Board ──────────────────────────────
      case 'mailbox-send':
        await this.handleMailboxSend(msg.requestId!, msg);
        break;

      case 'mailbox-check':
        await this.handleMailboxCheck(msg.requestId!, msg.limit, msg.after);
        break;

      case 'task-create':
        await this.handleTaskCreate(msg.requestId!, msg);
        break;

      case 'task-list':
        await this.handleTaskList(msg.requestId!, msg.status, msg.limit);
        break;

      case 'task-update':
        await this.handleTaskUpdate(msg.requestId!, msg.taskId!, msg);
        break;

      case 'task-my':
        await this.handleTaskMy(msg.requestId!, msg.status);
        break;

      // ─── Phase D: Channel Reply ──────────────────────────────────────
      case 'channel-reply':
        await this.handleChannelReply(msg.requestId!, msg.channelType!, msg.channelId!, msg.message || '', msg.imageBase64, msg.imageMimeType, msg.followUp);
        break;

      // ─── Tool Discovery & Invocation ──────────────────────────────────
      case 'list-tools':
        await this.handleListTools(msg.requestId!, msg.service, msg.query);
        break;

      case 'call-tool':
        await this.handleCallTool(msg.requestId!, msg.toolId!, msg.params ?? {});
        break;

      case 'repo:refresh-token': {
        await this.handleRepoTokenRefresh(msg.requestId);
        break;
      }

      case 'repo:clone-complete': {
        if (msg.success !== false) {
          console.log('[SessionAgentDO] Repo clone completed successfully');
        } else {
          console.error('[SessionAgentDO] Repo clone failed:', msg.error);
        }
        break;
      }

      case 'ping':
        // Keepalive from runner — respond with pong
        this.sendToRunner({ type: 'pong' });
        break;
    }
  }

  // ─── Cross-Session Operations ─────────────────────────────────────────

  private async handleSpawnChild(
    requestId: string,
    params: {
      task: string; workspace: string; repoUrl?: string; branch?: string; ref?: string; title?: string;
      sourceType?: string; sourcePrNumber?: number; sourceIssueNumber?: number; sourceRepoFullName?: string;
      model?: string; personaId?: string;
    },
  ) {
    try {
      const parentSessionId = this.getStateValue('sessionId')!;
      const userId = this.getStateValue('userId')!;
      const spawnRequestStr = this.getStateValue('spawnRequest');
      const backendUrl = this.getStateValue('backendUrl');
      const terminateUrl = this.getStateValue('terminateUrl');
      const hibernateUrl = this.getStateValue('hibernateUrl');
      const restoreUrl = this.getStateValue('restoreUrl');

      if (!spawnRequestStr || !backendUrl) {
        this.sendToRunner({ type: 'spawn-child-result', requestId, error: 'Session not configured for spawning children (missing spawnRequest or backendUrl)' });
        return;
      }

      const parentSpawnRequest = JSON.parse(spawnRequestStr);

      // Query parent's git state to use as defaults for the child
      const parentGitState = await getSessionGitState(this.appDb, parentSessionId);

      // Merge: explicit params override parent defaults
      const mergedRepoUrl = params.repoUrl || parentGitState?.sourceRepoUrl || undefined;
      const mergedBranch = params.branch || parentGitState?.branch || undefined;
      const mergedRef = params.ref || parentGitState?.ref || undefined;
      const mergedSourceType = params.sourceType || parentGitState?.sourceType || undefined;
      const mergedSourcePrNumber = params.sourcePrNumber ?? parentGitState?.sourcePrNumber ?? undefined;
      const mergedSourceIssueNumber = params.sourceIssueNumber ?? parentGitState?.sourceIssueNumber ?? undefined;
      const mergedSourceRepoFullName = params.sourceRepoFullName || parentGitState?.sourceRepoFullName || undefined;

      // Generate child session identifiers
      const childSessionId = crypto.randomUUID();
      const childRunnerToken = Array.from(crypto.getRandomValues(new Uint8Array(32)))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');

      // Create child session in D1
      await createSession(this.appDb, {
        id: childSessionId,
        userId,
        workspace: params.workspace,
        title: params.title || params.workspace,
        parentSessionId,
        personaId: params.personaId,
      });

      // Create git state for child (always create if we have any git context)
      if (mergedRepoUrl || mergedSourceType) {
        // Derive sourceRepoFullName from URL if not explicitly set
        let derivedRepoFullName = mergedSourceRepoFullName;
        if (!derivedRepoFullName && mergedRepoUrl) {
          const match = mergedRepoUrl.match(/github\.com[/:]([^/]+\/[^/.]+)/);
          if (match) derivedRepoFullName = match[1];
        }

        await createSessionGitState(this.appDb, {
          sessionId: childSessionId,
          sourceType: (mergedSourceType as any) || 'branch',
          sourceRepoUrl: mergedRepoUrl,
          sourceRepoFullName: derivedRepoFullName,
          branch: mergedBranch,
          ref: mergedRef,
          sourcePrNumber: mergedSourcePrNumber,
          sourceIssueNumber: mergedSourceIssueNumber,
        });
      }

      // Build child DO WebSocket URL
      // Extract host from backendUrl or use the parent's DO WebSocket pattern
      const parentDoWsUrl = parentSpawnRequest.doWsUrl as string;
      // Replace parent sessionId with child sessionId in the URL
      const childDoWsUrl = parentDoWsUrl.replace(parentSessionId, childSessionId);

      // Build child spawn request, inheriting parent env vars
      const childSpawnRequest = {
        ...parentSpawnRequest,
        sessionId: childSessionId,
        doWsUrl: childDoWsUrl,
        runnerToken: childRunnerToken,
        workspace: params.workspace,
        envVars: {
          ...parentSpawnRequest.envVars,
          PARENT_SESSION_ID: parentSessionId,
        },
      };

      // Override repo-specific env vars if we have repo info (explicit or inherited)
      if (mergedRepoUrl) {
        childSpawnRequest.envVars = {
          ...childSpawnRequest.envVars,
          REPO_URL: mergedRepoUrl,
        };
        if (mergedBranch) {
          childSpawnRequest.envVars.REPO_BRANCH = mergedBranch;
        }
        if (mergedRef) {
          childSpawnRequest.envVars.REPO_REF = mergedRef;
        }

        // Inject git credentials if the parent doesn't have them (e.g. orchestrator)
        if (!childSpawnRequest.envVars.GITHUB_TOKEN) {
          try {
            const ghResult = await getCredential(this.env, 'user', userId, 'github', { credentialType: 'oauth2' });
            if (ghResult.ok) {
              childSpawnRequest.envVars.GITHUB_TOKEN = ghResult.credential.accessToken;
            }
          } catch (err) {
            console.warn('[SessionAgentDO] Failed to fetch GitHub token for child:', err);
          }
        }

        // Inject git user identity if missing
        if (!childSpawnRequest.envVars.GIT_USER_NAME || !childSpawnRequest.envVars.GIT_USER_EMAIL) {
          try {
            const userRow = await getUserById(this.appDb, userId);
            if (userRow) {
              if (!childSpawnRequest.envVars.GIT_USER_NAME) {
                childSpawnRequest.envVars.GIT_USER_NAME = userRow.gitName || userRow.name || userRow.githubUsername || 'Valet User';
              }
              if (!childSpawnRequest.envVars.GIT_USER_EMAIL) {
                childSpawnRequest.envVars.GIT_USER_EMAIL = userRow.gitEmail || userRow.email;
              }
            }
          } catch (err) {
            console.warn('[SessionAgentDO] Failed to fetch user info for child git config:', err);
          }
        }
      }

      // Initialize child SessionAgentDO
      const childDoId = this.env.SESSIONS.idFromName(childSessionId);
      const childDO = this.env.SESSIONS.get(childDoId);

      const idleTimeoutMsStr = this.getStateValue('idleTimeoutMs');
      const idleTimeoutMs = idleTimeoutMsStr ? parseInt(idleTimeoutMsStr) : 900_000;

      await childDO.fetch(new Request('http://do/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sessionId: childSessionId,
          userId,
          workspace: params.workspace,
          runnerToken: childRunnerToken,
          backendUrl,
          terminateUrl: terminateUrl || undefined,
          hibernateUrl: hibernateUrl || undefined,
          restoreUrl: restoreUrl || undefined,
          idleTimeoutMs,
          spawnRequest: childSpawnRequest,
          initialPrompt: params.task,
          initialModel: params.model,
        }),
      }));

      this.sendToRunner({ type: 'spawn-child-result', requestId, childSessionId });
    } catch (err) {
      console.error('[SessionAgentDO] Failed to spawn child:', err);
      this.sendToRunner({
        type: 'spawn-child-result',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleSessionMessage(requestId: string, targetSessionId: string, content: string, interrupt?: boolean) {
    try {
      const userId = this.getStateValue('userId')!;

      // Verify target session belongs to the same user
      const targetSession = await getSession(this.appDb, targetSessionId);
      if (!targetSession || targetSession.userId !== userId) {
        this.sendToRunner({ type: 'session-message-result', requestId, error: 'Session not found or access denied' });
        return;
      }

      // Forward prompt to target DO
      const targetDoId = this.env.SESSIONS.idFromName(targetSessionId);
      const targetDO = this.env.SESSIONS.get(targetDoId);

      const resp = await targetDO.fetch(new Request('http://do/prompt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content, interrupt: interrupt ?? false }),
      }));

      if (!resp.ok) {
        const errText = await resp.text();
        this.sendToRunner({ type: 'session-message-result', requestId, error: `Target DO returned ${resp.status}: ${errText}` });
        return;
      }

      this.sendToRunner({ type: 'session-message-result', requestId, success: true });
    } catch (err) {
      console.error('[SessionAgentDO] Failed to send message:', err);
      this.sendToRunner({
        type: 'session-message-result',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleSessionMessages(requestId: string, targetSessionId: string, limit?: number, after?: string) {
    try {
      const userId = this.getStateValue('userId')!;

      // Verify target session belongs to the same user
      const targetSession = await getSession(this.appDb, targetSessionId);
      if (!targetSession || targetSession.userId !== userId) {
        this.sendToRunner({ type: 'session-messages-result', requestId, error: 'Session not found or access denied' });
        return;
      }

      // Fetch messages from the target DO's local SQLite (not D1)
      const messages = await this.fetchMessagesFromDO(targetSessionId, limit || 20, after);

      this.sendToRunner({
        type: 'session-messages-result',
        requestId,
        messages: messages.map((m: { role: string; content: string; createdAt: string }) => ({
          role: m.role,
          content: m.content,
          createdAt: m.createdAt,
        })),
      });
    } catch (err) {
      console.error('[SessionAgentDO] Failed to read messages:', err);
      this.sendToRunner({
        type: 'session-messages-result',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleForwardMessages(requestId: string, targetSessionId: string, limit?: number, after?: string) {
    try {
      const userId = this.getStateValue('userId')!;

      // Verify target session belongs to the same user
      const targetSession = await getSession(this.appDb, targetSessionId);
      if (!targetSession || targetSession.userId !== userId) {
        this.sendToRunner({ type: 'forward-messages-result', requestId, error: 'Session not found or access denied' });
        return;
      }

      // Fetch messages from target DO
      const messages = await this.fetchMessagesFromDO(targetSessionId, limit || 20, after);

      if (messages.length === 0) {
        this.sendToRunner({ type: 'forward-messages-result', requestId, count: 0, sourceSessionId: targetSessionId });
        return;
      }

      // Insert each message into our own messages table with forwarded metadata
      const sessionTitle = targetSession.title || targetSession.workspace || targetSessionId.slice(0, 8);
      for (const msg of messages) {
        const newId = crypto.randomUUID();
        const parts = JSON.stringify({
          forwarded: true,
          sourceSessionId: targetSessionId,
          sourceSessionTitle: sessionTitle,
          originalRole: msg.role,
          originalCreatedAt: msg.createdAt,
        });

        // Store all forwarded messages as 'assistant' role for consistent left-aligned rendering
        this.ctx.storage.sql.exec(
          'INSERT INTO messages (id, role, content, parts) VALUES (?, ?, ?, ?)',
          newId, 'assistant', msg.content, parts
        );

        this.broadcastToClients({
          type: 'message',
          data: {
            id: newId,
            role: 'assistant',
            content: msg.content,
            parts: {
              forwarded: true,
              sourceSessionId: targetSessionId,
              sourceSessionTitle: sessionTitle,
              originalRole: msg.role,
              originalCreatedAt: msg.createdAt,
            },
            createdAt: Math.floor(Date.now() / 1000),
          },
        });
      }

      this.sendToRunner({
        type: 'forward-messages-result',
        requestId,
        count: messages.length,
        sourceSessionId: targetSessionId,
      });
    } catch (err) {
      console.error('[SessionAgentDO] Failed to forward messages:', err);
      this.sendToRunner({
        type: 'forward-messages-result',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  /** Fetch messages from another session's DO via internal HTTP endpoint. */
  private async fetchMessagesFromDO(
    targetSessionId: string,
    limit: number,
    after?: string,
  ): Promise<Array<{ role: string; content: string; createdAt: string }>> {
    const doId = this.env.SESSIONS.idFromName(targetSessionId);
    const targetDO = this.env.SESSIONS.get(doId);

    const params = new URLSearchParams({ limit: String(limit) });
    if (after) params.set('after', after);

    const res = await targetDO.fetch(new Request(`http://do/messages?${params}`));
    if (!res.ok) {
      throw new Error(`Target DO returned ${res.status}: ${await res.text()}`);
    }

    const data = await res.json() as { messages: Array<{ role: string; content: string; createdAt: string }> };
    return data.messages;
  }

  private async handleTerminateChild(requestId: string, childSessionId: string) {
    try {
      const sessionId = this.getStateValue('sessionId')!;
      const userId = this.getStateValue('userId')!;

      // Verify the child belongs to this parent session
      const childSession = await getSession(this.appDb, childSessionId);
      if (!childSession || childSession.userId !== userId) {
        this.sendToRunner({ type: 'terminate-child-result', requestId, error: 'Child session not found or access denied' });
        return;
      }
      if (childSession.parentSessionId !== sessionId) {
        this.sendToRunner({ type: 'terminate-child-result', requestId, error: 'Session is not a child of this session' });
        return;
      }

      // Stop the child via its DO
      const childDoId = this.env.SESSIONS.idFromName(childSessionId);
      const childDO = this.env.SESSIONS.get(childDoId);
      const resp = await childDO.fetch(new Request('http://do/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: 'parent_stopped' }),
      }));

      if (!resp.ok) {
        const errText = await resp.text();
        this.sendToRunner({ type: 'terminate-child-result', requestId, error: `Child DO returned ${resp.status}: ${errText}` });
        return;
      }

      this.sendToRunner({ type: 'terminate-child-result', requestId, success: true });
    } catch (err) {
      console.error('[SessionAgentDO] Failed to terminate child:', err);
      this.sendToRunner({
        type: 'terminate-child-result',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private async handleSelfTerminate() {
    const sessionId = this.getStateValue('sessionId');
    console.log(`[SessionAgentDO] Session ${sessionId} self-terminating (task complete)`);

    // Reuse handleStop which handles sandbox teardown, cascade, etc.
    return await this.handleStop('completed');
  }

  // ─── Orchestrator Operations ────────────────────────────────────────────

  private async handleMemRead(requestId: string, path?: string) {
    try {
      const userId = this.getStateValue('userId')!;
      const p = path || '';

      if (!p || p.endsWith('/')) {
        const files = await listMemoryFiles(this.appDb, userId, p);
        this.sendToRunner({ type: 'mem-read-result', requestId, files } as any);
      } else {
        const file = await readMemoryFile(this.appDb, userId, p);
        if (file) {
          boostMemoryFileRelevance(this.appDb, userId, p).catch(() => {});
        }
        this.sendToRunner({ type: 'mem-read-result', requestId, file } as any);
      }
    } catch (err) {
      console.error('[SessionAgentDO] Failed to read memory file:', err);
      this.sendToRunner({ type: 'mem-read-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private async handleMemWrite(requestId: string, path: string, content: string) {
    try {
      const userId = this.getStateValue('userId')!;
      const file = await writeMemoryFile(this.env.DB, userId, path, content);
      this.sendToRunner({ type: 'mem-write-result', requestId, file } as any);
    } catch (err) {
      console.error('[SessionAgentDO] Failed to write memory file:', err);
      this.sendToRunner({ type: 'mem-write-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private async handleMemPatch(requestId: string, path: string, operations: any) {
    try {
      const userId = this.getStateValue('userId')!;
      const result = await patchMemoryFile(this.env.DB, userId, path, operations);
      this.sendToRunner({ type: 'mem-patch-result', requestId, result } as any);
    } catch (err) {
      console.error('[SessionAgentDO] Failed to patch memory file:', err);
      this.sendToRunner({ type: 'mem-patch-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private async handleMemRm(requestId: string, path: string) {
    try {
      const userId = this.getStateValue('userId')!;
      let deleted: number;
      if (path.endsWith('/')) {
        deleted = await deleteMemoryFilesUnderPath(this.env.DB, userId, path);
      } else {
        deleted = await deleteMemoryFile(this.env.DB, userId, path);
      }
      this.sendToRunner({ type: 'mem-rm-result', requestId, deleted } as any);
    } catch (err) {
      console.error('[SessionAgentDO] Failed to delete memory file:', err);
      this.sendToRunner({ type: 'mem-rm-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private async handleMemSearch(requestId: string, query: string, path?: string, limit?: number) {
    try {
      const userId = this.getStateValue('userId')!;
      const results = await searchMemoryFiles(this.env.DB, userId, query, path, limit ?? 20);
      this.sendToRunner({ type: 'mem-search-result', requestId, results } as any);
    } catch (err) {
      console.error('[SessionAgentDO] Failed to search memory files:', err);
      this.sendToRunner({ type: 'mem-search-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private async handleListRepos(requestId: string, source?: string) {
    try {
      if (source === 'github') {
        const githubToken = await this.getGitHubToken();
        if (!githubToken) {
          this.sendToRunner({ type: 'list-repos-result', requestId, error: 'No GitHub token found — user must connect GitHub in settings' } as any);
          return;
        }
        // Fetch user's repos from GitHub API (up to 100, sorted by last push)
        const res = await fetch('https://api.github.com/user/repos?per_page=100&sort=pushed&affiliation=owner,collaborator,organization_member', {
          headers: {
            'Authorization': `Bearer ${githubToken}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'valet',
          },
        });
        if (!res.ok) {
          const errText = await res.text();
          this.sendToRunner({ type: 'list-repos-result', requestId, error: `GitHub API error (${res.status}): ${errText}` } as any);
          return;
        }
        const ghRepos = await res.json() as { full_name: string; html_url: string; clone_url: string; description: string | null; language: string | null; default_branch: string; private: boolean; pushed_at: string }[];
        const repos = ghRepos.map(r => ({
          fullName: r.full_name,
          url: r.clone_url,
          htmlUrl: r.html_url,
          description: r.description,
          language: r.language,
          defaultBranch: r.default_branch,
          visibility: r.private ? 'private' : 'public',
          lastPushed: r.pushed_at,
        }));
        this.sendToRunner({ type: 'list-repos-result', requestId, repos } as any);
      } else {
        const repos = await listOrgRepositories(this.env.DB);
        this.sendToRunner({ type: 'list-repos-result', requestId, repos } as any);
      }
    } catch (err) {
      console.error('[SessionAgentDO] Failed to list repos:', err);
      this.sendToRunner({ type: 'list-repos-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private async handleWorkflowList(requestId: string) {
    try {
      const userId = this.getStateValue('userId')!;
      const result = await listWorkflows(this.appDb, userId);

      const workflows = (result.results || []).map((row) => {
        let data: Record<string, unknown> = {};
        let tags: string[] = [];
        try { data = JSON.parse(String(row.data || '{}')); } catch {}
        try { tags = row.tags ? JSON.parse(String(row.tags)) : []; } catch {}
        return {
          id: row.id,
          slug: row.slug,
          name: row.name,
          description: row.description,
          version: row.version,
          data,
          enabled: Boolean(row.enabled),
          tags,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        };
      });

      this.sendToRunner({ type: 'workflow-list-result', requestId, workflows } as any);
    } catch (err) {
      console.error('[SessionAgentDO] Failed to list workflows:', err);
      this.sendToRunner({ type: 'workflow-list-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private async handleWorkflowSync(
    requestId: string,
    params: {
      id?: string;
      slug?: string;
      name?: string;
      description?: string;
      version?: string;
      data?: Record<string, unknown>;
    },
  ) {
    try {
      const userId = this.getStateValue('userId')!;
      const name = (params.name || '').trim();
      if (!name) {
        this.sendToRunner({ type: 'workflow-sync-result', requestId, error: 'Workflow name is required' } as any);
        return;
      }
      const validation = validateWorkflowDefinition(params.data);
      if (!validation.valid) {
        this.sendToRunner({ type: 'workflow-sync-result', requestId, error: `Invalid workflow definition: ${validation.errors[0]}` } as any);
        return;
      }

      const workflowId = (params.id || '').trim() || `wf_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
      const slug = (params.slug || '')
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || null;
      const version = (params.version || '1.0.0').trim() || '1.0.0';
      const now = new Date().toISOString();

      await upsertWorkflow(this.appDb, {
        id: workflowId,
        userId,
        slug,
        name,
        description: params.description || null,
        version,
        data: JSON.stringify(params.data),
        now,
      });

      const workflow = {
        id: workflowId,
        slug,
        name,
        description: params.description || null,
        version,
        data: params.data,
        enabled: true,
        tags: [],
        createdAt: now,
        updatedAt: now,
      };

      this.sendToRunner({ type: 'workflow-sync-result', requestId, success: true, workflow } as any);
    } catch (err) {
      console.error('[SessionAgentDO] Failed to sync workflow:', err);
      this.sendToRunner({ type: 'workflow-sync-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private deriveRepoFullName(repoUrl?: string, sourceRepoFullName?: string): string | undefined {
    const explicit = sourceRepoFullName?.trim();
    if (explicit) return explicit;

    const rawUrl = repoUrl?.trim();
    if (!rawUrl) return undefined;

    const match = rawUrl.match(/github\.com[/:]([^/]+\/[^/.]+)/i);
    return match?.[1] || undefined;
  }

  private deriveWorkerOriginFromSpawnRequest(): string | undefined {
    const spawnRequestRaw = this.getStateValue('spawnRequest');
    if (!spawnRequestRaw) return undefined;

    try {
      const parsed = JSON.parse(spawnRequestRaw) as { doWsUrl?: unknown };
      const doWsUrl = typeof parsed?.doWsUrl === 'string' ? parsed.doWsUrl.trim() : '';
      if (!doWsUrl) return undefined;
      return new URL(doWsUrl).origin;
    } catch {
      return undefined;
    }
  }

  private async handleWorkflowRun(
    requestId: string,
    workflowId: string,
    variables?: Record<string, unknown>,
    repoContext?: { repoUrl?: string; branch?: string; ref?: string; sourceRepoFullName?: string },
  ) {
    try {
      const userId = this.getStateValue('userId')!;
      const workflowLookupId = (workflowId || '').trim();
      if (!workflowLookupId) {
        this.sendToRunner({ type: 'workflow-run-result', requestId, error: 'workflowId is required' } as any);
        return;
      }

      const workflow = await getWorkflowByIdOrSlug(this.appDb, userId, workflowLookupId) as {
        id: string;
        name: string;
        version: string | null;
        data: string;
      } | null;

      if (!workflow) {
        this.sendToRunner({ type: 'workflow-run-result', requestId, error: `Workflow not found: ${workflowLookupId}` } as any);
        return;
      }

      const concurrency = await checkWorkflowConcurrency(this.appDb, userId);
      if (!concurrency.allowed) {
        this.sendToRunner({
          type: 'workflow-run-result',
          requestId,
          error: `Too many concurrent executions (${concurrency.reason})`,
        } as any);
        return;
      }

      const idempotencyKey = `agent:${workflow.id}:${userId}:${requestId}`;
      const existing = await checkIdempotencyKey(this.env.DB, workflow.id, idempotencyKey) as {
        id: string;
        status: string;
        session_id: string | null;
      } | null;

      if (existing) {
        this.sendToRunner({
          type: 'workflow-run-result',
          requestId,
          execution: {
            executionId: existing.id,
            workflowId: workflow.id,
            workflowName: workflow.name,
            status: existing.status,
            sessionId: existing.session_id,
            deduplicated: true,
          },
        } as any);
        return;
      }

      const executionId = crypto.randomUUID();
      const now = new Date().toISOString();
      const workflowHash = await sha256Hex(String(workflow.data || '{}'));
      const repoUrl = repoContext?.repoUrl?.trim() || undefined;
      const branch = repoContext?.branch?.trim() || undefined;
      const ref = repoContext?.ref?.trim() || undefined;
      const workerOrigin = this.deriveWorkerOriginFromSpawnRequest();
      const sourceRepoFullName = this.deriveRepoFullName(repoUrl, repoContext?.sourceRepoFullName);
      const sessionId = await createWorkflowSession(this.appDb, {
        userId,
        workflowId: workflow.id,
        executionId,
        sourceRepoUrl: repoUrl,
        sourceRepoFullName,
        branch,
        ref,
      });

      await createExecution(this.env.DB, {
        id: executionId,
        workflowId: workflow.id,
        userId,
        triggerId: null,
        triggerType: 'manual',
        triggerMetadata: JSON.stringify({ triggeredBy: 'agent_tool', direct: true }),
        variables: JSON.stringify(variables || {}),
        now,
        workflowVersion: workflow.version || null,
        workflowHash,
        workflowSnapshot: workflow.data,
        idempotencyKey,
        sessionId,
        initiatorType: 'manual',
        initiatorUserId: userId,
      });

      const dispatched = await enqueueWorkflowExecution(this.env, {
        executionId,
        workflowId: workflow.id,
        userId,
        sessionId,
        triggerType: 'manual',
        workerOrigin,
      });

      this.sendToRunner({
        type: 'workflow-run-result',
        requestId,
        execution: {
          executionId,
          workflowId: workflow.id,
          workflowName: workflow.name,
          status: 'pending',
          sessionId,
          dispatched,
        },
      } as any);
    } catch (err) {
      console.error('[SessionAgentDO] Failed to run workflow:', err);
      this.sendToRunner({ type: 'workflow-run-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private async handleWorkflowExecutions(requestId: string, workflowId?: string, limit?: number) {
    try {
      const userId = this.getStateValue('userId')!;
      const max = Math.min(Math.max(limit || 20, 1), 200);
      const parseMaybeJson = (raw: unknown) => {
        if (raw === null || raw === undefined) return null;
        try {
          return JSON.parse(String(raw));
        } catch {
          return null;
        }
      };

      let workflowFilterId: string | null = null;
      if (workflowId) {
        const workflow = await getWorkflowOwnerCheck(this.appDb, userId, workflowId);
        if (!workflow) {
          this.sendToRunner({ type: 'workflow-executions-result', requestId, executions: [] } as any);
          return;
        }
        workflowFilterId = workflow.id;
      }

      const result = await listExecutions(this.env.DB, userId, {
        workflowId: workflowFilterId || undefined,
        limit: max,
      });

      const executions = (result.results || []).map((row) => ({
        id: row.id,
        workflowId: row.workflow_id,
        triggerId: row.trigger_id,
        status: row.status,
        triggerType: row.trigger_type,
        triggerMetadata: parseMaybeJson(row.trigger_metadata),
        variables: parseMaybeJson(row.variables),
        outputs: parseMaybeJson(row.outputs),
        steps: parseMaybeJson(row.steps),
        error: row.error,
        startedAt: row.started_at,
        completedAt: row.completed_at,
        sessionId: row.session_id,
      }));

      this.sendToRunner({ type: 'workflow-executions-result', requestId, executions } as any);
    } catch (err) {
      console.error('[SessionAgentDO] Failed to list workflow executions:', err);
      this.sendToRunner({ type: 'workflow-executions-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private parseJsonOrNull(raw: unknown): unknown | null {
    if (raw === null || raw === undefined) return null;
    try {
      return JSON.parse(String(raw));
    } catch {
      return null;
    }
  }

  private normalizeWorkflowRow(row: Record<string, unknown>) {
    let data: Record<string, unknown> = {};
    let tags: string[] = [];
    try { data = JSON.parse(String(row.data || '{}')); } catch {}
    try { tags = row.tags ? JSON.parse(String(row.tags)) : []; } catch {}
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      version: row.version,
      data,
      enabled: Boolean(row.enabled),
      tags,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  }

  private async resolveWorkflowIdForUser(userId: string, workflowIdOrSlug?: string | null): Promise<string | null> {
    const lookup = (workflowIdOrSlug || '').trim();
    if (!lookup) return null;
    const row = await getWorkflowOwnerCheck(this.appDb, userId, lookup);
    return row?.id || null;
  }

  private async handleWorkflowApi(requestId: string, action: string, payload?: Record<string, unknown>) {
    try {
      const userId = this.getStateValue('userId')!;
      const workflowIdOrSlug = typeof payload?.workflowId === 'string' ? payload.workflowId.trim() : '';
      if (!workflowIdOrSlug) {
        this.sendToRunner({ type: 'workflow-api-result', requestId, error: 'workflowId is required' } as any);
        return;
      }

      const existing = await getWorkflowByIdOrSlug(this.appDb, userId, workflowIdOrSlug) as Record<string, unknown> | null;

      if (!existing) {
        this.sendToRunner({ type: 'workflow-api-result', requestId, error: `Workflow not found: ${workflowIdOrSlug}` } as any);
        return;
      }

      if (action === 'get') {
        this.sendToRunner({ type: 'workflow-api-result', requestId, data: { workflow: this.normalizeWorkflowRow(existing) } } as any);
        return;
      }

      if (action === 'delete') {
        await deleteWorkflowTriggers(this.appDb, existing.id as string, userId);
        await deleteWorkflowById(this.appDb, existing.id as string, userId);
        this.sendToRunner({ type: 'workflow-api-result', requestId, data: { success: true } } as any);
        return;
      }

      if (action !== 'update') {
        this.sendToRunner({ type: 'workflow-api-result', requestId, error: `Unsupported workflow action: ${action}` } as any);
        return;
      }

      const updates: string[] = [];
      const values: unknown[] = [];

      if (payload && Object.prototype.hasOwnProperty.call(payload, 'name')) {
        const nextName = typeof payload.name === 'string' ? payload.name : '';
        if (!nextName.trim()) {
          this.sendToRunner({ type: 'workflow-api-result', requestId, error: 'name must be a non-empty string' } as any);
          return;
        }
        updates.push('name = ?');
        values.push(nextName.trim());
      }
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'description')) {
        const nextDescription = payload.description;
        if (nextDescription !== null && typeof nextDescription !== 'string') {
          this.sendToRunner({ type: 'workflow-api-result', requestId, error: 'description must be a string or null' } as any);
          return;
        }
        updates.push('description = ?');
        values.push(nextDescription === null ? null : nextDescription);
      }
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'slug')) {
        const nextSlug = payload.slug;
        if (nextSlug !== null && typeof nextSlug !== 'string') {
          this.sendToRunner({ type: 'workflow-api-result', requestId, error: 'slug must be a string or null' } as any);
          return;
        }
        updates.push('slug = ?');
        values.push(nextSlug === null ? null : nextSlug);
      }
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'version')) {
        const nextVersion = payload.version;
        if (typeof nextVersion !== 'string' || !nextVersion.trim()) {
          this.sendToRunner({ type: 'workflow-api-result', requestId, error: 'version must be a non-empty string' } as any);
          return;
        }
        updates.push('version = ?');
        values.push(nextVersion.trim());
      }
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'enabled')) {
        const nextEnabled = payload.enabled;
        if (typeof nextEnabled !== 'boolean') {
          this.sendToRunner({ type: 'workflow-api-result', requestId, error: 'enabled must be a boolean' } as any);
          return;
        }
        updates.push('enabled = ?');
        values.push(nextEnabled ? 1 : 0);
      }
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'tags')) {
        const nextTags = payload.tags;
        if (!Array.isArray(nextTags) || nextTags.some((tag) => typeof tag !== 'string')) {
          this.sendToRunner({ type: 'workflow-api-result', requestId, error: 'tags must be an array of strings' } as any);
          return;
        }
        updates.push('tags = ?');
        values.push(JSON.stringify(nextTags));
      }
      if (payload && Object.prototype.hasOwnProperty.call(payload, 'data')) {
        const nextData = payload.data;
        if (!nextData || typeof nextData !== 'object' || Array.isArray(nextData)) {
          this.sendToRunner({ type: 'workflow-api-result', requestId, error: 'data must be an object' } as any);
          return;
        }
        const validation = validateWorkflowDefinition(nextData);
        if (!validation.valid) {
          this.sendToRunner({ type: 'workflow-api-result', requestId, error: `Invalid workflow definition: ${validation.errors[0]}` } as any);
          return;
        }
        updates.push('data = ?');
        values.push(JSON.stringify(nextData));
      }

      if (updates.length === 0) {
        this.sendToRunner({ type: 'workflow-api-result', requestId, data: { workflow: this.normalizeWorkflowRow(existing) } } as any);
        return;
      }

      const updatedAt = new Date().toISOString();
      updates.push('updated_at = ?');
      values.push(updatedAt);
      values.push(existing.id);

      await updateWorkflow(this.env.DB, existing.id as string, updates, values);
      const updated = await getWorkflowById(this.appDb, existing.id as string) as Record<string, unknown> | null;

      this.sendToRunner({
        type: 'workflow-api-result',
        requestId,
        data: { workflow: this.normalizeWorkflowRow(updated || existing) },
      } as any);
    } catch (err) {
      console.error('[SessionAgentDO] Workflow API error:', err);
      this.sendToRunner({ type: 'workflow-api-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private scheduleTargetFromConfig(config: Record<string, unknown>): 'workflow' | 'orchestrator' {
    if (config.type !== 'schedule') return 'workflow';
    return config.target === 'orchestrator' ? 'orchestrator' : 'workflow';
  }

  private requiresWorkflowForTriggerConfig(config: Record<string, unknown>): boolean {
    return config.type !== 'schedule' || this.scheduleTargetFromConfig(config) === 'workflow';
  }

  private async handleTriggerApi(requestId: string, action: string, payload?: Record<string, unknown>) {
    try {
      const userId = this.getStateValue('userId')!;

      if (action === 'list') {
        const result = await listTriggers(this.env.DB, userId);

        const workflowFilter = typeof payload?.workflowId === 'string' ? payload.workflowId : undefined;
        const typeFilter = typeof payload?.type === 'string' ? payload.type : undefined;
        const enabledFilter = typeof payload?.enabled === 'boolean' ? payload.enabled : undefined;

        let triggers = (result.results || []).map((row) => ({
          id: row.id,
          workflowId: row.workflow_id,
          workflowName: row.workflow_name,
          name: row.name,
          enabled: Boolean(row.enabled),
          type: row.type,
          config: this.parseJsonOrNull(row.config) || {},
          variableMapping: this.parseJsonOrNull(row.variable_mapping) || null,
          lastRunAt: row.last_run_at,
          createdAt: row.created_at,
          updatedAt: row.updated_at,
        }));

        if (workflowFilter) {
          triggers = triggers.filter((trigger) => trigger.workflowId === workflowFilter || trigger.workflowName === workflowFilter);
        }
        if (typeFilter) {
          triggers = triggers.filter((trigger) => trigger.type === typeFilter);
        }
        if (enabledFilter !== undefined) {
          triggers = triggers.filter((trigger) => trigger.enabled === enabledFilter);
        }

        this.sendToRunner({ type: 'trigger-api-result', requestId, data: { triggers } } as any);
        return;
      }

      if (action === 'delete') {
        const triggerId = typeof payload?.triggerId === 'string' ? payload.triggerId.trim() : '';
        if (!triggerId) {
          this.sendToRunner({ type: 'trigger-api-result', requestId, error: 'triggerId is required' } as any);
          return;
        }
        const result = await deleteTrigger(this.appDb, triggerId, userId);
        if ((result.meta?.changes || 0) === 0) {
          this.sendToRunner({ type: 'trigger-api-result', requestId, error: `Trigger not found: ${triggerId}` } as any);
          return;
        }
        this.sendToRunner({ type: 'trigger-api-result', requestId, data: { success: true } } as any);
        return;
      }

      if (action === 'create' || action === 'update') {
        const triggerId = typeof payload?.triggerId === 'string' ? payload.triggerId.trim() : '';
        const isUpdate = action === 'update';
        const hasWorkflowIdPayload = Object.prototype.hasOwnProperty.call(payload || {}, 'workflowId');
        let fallbackToUpdate = false;

        let existing = isUpdate
          ? await getTrigger(this.env.DB, userId, triggerId) as Record<string, unknown> | null
          : null;

        if (isUpdate && !existing) {
          this.sendToRunner({ type: 'trigger-api-result', requestId, error: `Trigger not found: ${triggerId}` } as any);
          return;
        }

        const rawConfig = payload?.config && typeof payload.config === 'object' && !Array.isArray(payload.config)
          ? payload.config as Record<string, unknown>
          : existing?.config
            ? (this.parseJsonOrNull(existing.config) as Record<string, unknown> | null)
            : null;
        if (!rawConfig || typeof rawConfig.type !== 'string') {
          this.sendToRunner({ type: 'trigger-api-result', requestId, error: 'config with type is required' } as any);
          return;
        }

        const nextNameRaw = typeof payload?.name === 'string' ? payload.name : (typeof existing?.name === 'string' ? existing.name : '');
        const nextName = (nextNameRaw || '').trim();
        if (!nextName) {
          this.sendToRunner({ type: 'trigger-api-result', requestId, error: 'name is required' } as any);
          return;
        }

        const workflowIdPayload = Object.prototype.hasOwnProperty.call(payload || {}, 'workflowId')
          ? payload?.workflowId
          : existing?.workflow_id;
        let workflowId: string | null = null;
        if (typeof workflowIdPayload === 'string' && workflowIdPayload.trim()) {
          workflowId = await this.resolveWorkflowIdForUser(userId, workflowIdPayload);
          if (!workflowId) {
            this.sendToRunner({ type: 'trigger-api-result', requestId, error: `Workflow not found: ${workflowIdPayload}` } as any);
            return;
          }
        } else if (workflowIdPayload === null) {
          workflowId = null;
        }

        const target = this.scheduleTargetFromConfig(rawConfig);
        if (rawConfig.type === 'schedule' && target === 'orchestrator') {
          const prompt = typeof rawConfig.prompt === 'string' ? rawConfig.prompt.trim() : '';
          if (!prompt) {
            this.sendToRunner({ type: 'trigger-api-result', requestId, error: 'schedule prompt is required when target=orchestrator' } as any);
            return;
          }
        }

        // Fallback upsert path for schedule triggers when a create call omits triggerId.
        // This prevents accidental duplicate schedules from repeated "update" attempts.
        if (!isUpdate && rawConfig.type === 'schedule') {
          if (hasWorkflowIdPayload) {
            const sameName = await findScheduleTriggerByNameAndWorkflow(this.env.DB, userId, workflowId, nextName);

            if (sameName) {
              existing = sameName;
              fallbackToUpdate = true;
            } else {
              const workflowMatches = await findScheduleTriggersByWorkflow(this.env.DB, userId, workflowId, 2);
              const candidates = workflowMatches.results || [];
              if (candidates.length === 1) {
                existing = candidates[0];
                fallbackToUpdate = true;
              }
            }
          } else {
            const sameName = await findScheduleTriggersByName(this.env.DB, userId, nextName, 2);
            const candidates = sameName.results || [];
            if (candidates.length === 1) {
              existing = candidates[0];
              fallbackToUpdate = true;
              workflowId = typeof existing.workflow_id === 'string' && existing.workflow_id.trim()
                ? existing.workflow_id
                : null;
            }
          }
        }

        if (fallbackToUpdate && !hasWorkflowIdPayload) {
          workflowId = typeof existing?.workflow_id === 'string' && existing.workflow_id.trim()
            ? existing.workflow_id
            : null;
        }

        if (this.requiresWorkflowForTriggerConfig(rawConfig) && !workflowId) {
          this.sendToRunner({ type: 'trigger-api-result', requestId, error: 'workflowId is required for this trigger type' } as any);
          return;
        }

        const nextEnabled = typeof payload?.enabled === 'boolean'
          ? payload.enabled
          : existing
            ? Boolean(existing.enabled)
            : true;

        const variableMapping = payload?.variableMapping && typeof payload.variableMapping === 'object' && !Array.isArray(payload.variableMapping)
          ? payload.variableMapping as Record<string, unknown>
          : existing?.variable_mapping
            ? (this.parseJsonOrNull(existing.variable_mapping) as Record<string, unknown> | null)
            : undefined;

        if (variableMapping) {
          for (const [key, value] of Object.entries(variableMapping)) {
            if (typeof value !== 'string') {
              this.sendToRunner({ type: 'trigger-api-result', requestId, error: `variableMapping.${key} must be a string` } as any);
              return;
            }
          }
        }

        const now = new Date().toISOString();
        const shouldUpdate = isUpdate || fallbackToUpdate;
        const targetTriggerId = shouldUpdate
          ? (typeof existing?.id === 'string' ? existing.id : triggerId)
          : crypto.randomUUID();
        if (shouldUpdate) {
          await updateTriggerFull(this.appDb, targetTriggerId, userId, {
            workflowId,
            name: nextName,
            enabled: nextEnabled,
            type: String(rawConfig.type),
            config: JSON.stringify(rawConfig),
            variableMapping: variableMapping ? JSON.stringify(variableMapping) : null,
            now,
          });
        } else {
          await createTrigger(this.appDb, {
            id: targetTriggerId,
            userId,
            workflowId,
            name: nextName,
            enabled: nextEnabled,
            type: String(rawConfig.type),
            config: JSON.stringify(rawConfig),
            variableMapping: variableMapping ? JSON.stringify(variableMapping) : null,
            now,
          });
        }

        const row = await getTrigger(this.env.DB, userId, targetTriggerId) as Record<string, unknown> | null;

        this.sendToRunner({
          type: 'trigger-api-result',
          requestId,
          data: {
            trigger: row
              ? {
                  id: row.id,
                  workflowId: row.workflow_id,
                  workflowName: row.workflow_name,
                  name: row.name,
                  enabled: Boolean(row.enabled),
                  type: row.type,
                  config: this.parseJsonOrNull(row.config) || {},
                  variableMapping: this.parseJsonOrNull(row.variable_mapping) || null,
                  lastRunAt: row.last_run_at,
                  createdAt: row.created_at,
                  updatedAt: row.updated_at,
                }
              : null,
            success: true,
          },
        } as any);
        return;
      }

      if (action === 'run') {
        const triggerId = typeof payload?.triggerId === 'string' ? payload.triggerId.trim() : '';
        if (!triggerId) {
          this.sendToRunner({ type: 'trigger-api-result', requestId, error: 'triggerId is required' } as any);
          return;
        }

        const row = await getTriggerForRun(this.env.DB, userId, triggerId);

        if (!row) {
          this.sendToRunner({ type: 'trigger-api-result', requestId, error: `Trigger not found: ${triggerId}` } as any);
          return;
        }

        const config = this.parseJsonOrNull(row.config) as Record<string, unknown> | null;
        if (!config) {
          this.sendToRunner({ type: 'trigger-api-result', requestId, error: 'Invalid trigger config' } as any);
          return;
        }
        const target = this.scheduleTargetFromConfig(config);

        if (config.type === 'schedule' && target === 'orchestrator') {
          const prompt = typeof config.prompt === 'string' ? config.prompt.trim() : '';
          if (!prompt) {
            this.sendToRunner({ type: 'trigger-api-result', requestId, error: 'Schedule orchestrator trigger requires prompt' } as any);
            return;
          }

          const dispatch = await dispatchOrchestratorPrompt(this.env, {
            userId,
            content: prompt,
          });
          const now = new Date().toISOString();
          if (dispatch.dispatched) {
            await updateTriggerLastRun(this.appDb, triggerId, now);
          }
          this.sendToRunner({
            type: 'trigger-api-result',
            requestId,
            data: dispatch.dispatched
              ? {
                  status: 'queued',
                  workflowId: row.wf_id,
                  workflowName: row.workflow_name,
                  sessionId: dispatch.sessionId,
                  message: 'Orchestrator prompt dispatched.',
                }
              : {
                  status: 'failed',
                  workflowId: row.wf_id,
                  workflowName: row.workflow_name,
                  sessionId: dispatch.sessionId,
                  reason: dispatch.reason || 'unknown_error',
                },
          } as any);
          return;
        }

        if (!row.wf_id || !row.workflow_data) {
          this.sendToRunner({ type: 'trigger-api-result', requestId, error: 'Trigger is not linked to a workflow' } as any);
          return;
        }

        const concurrency = await checkWorkflowConcurrency(this.appDb, userId);
        if (!concurrency.allowed) {
          this.sendToRunner({
            type: 'trigger-api-result',
            requestId,
            error: `Too many concurrent workflow executions (${concurrency.reason})`,
          } as any);
          return;
        }

        const variableMapping = row.variable_mapping ? (this.parseJsonOrNull(row.variable_mapping) as Record<string, string> | null) : null;
        const extractedVariables: Record<string, unknown> = {};
        for (const [varName, path] of Object.entries(variableMapping || {})) {
          if (!path.startsWith('$.')) continue;
          const key = path.slice(2).split('.')[0];
          if (payload && Object.prototype.hasOwnProperty.call(payload, key)) {
            extractedVariables[varName] = payload[key];
          }
        }

        const runtimeVariables = (payload?.variables && typeof payload.variables === 'object' && !Array.isArray(payload.variables))
          ? payload.variables as Record<string, unknown>
          : {};
        const variables = {
          ...extractedVariables,
          ...runtimeVariables,
          _trigger: { type: 'manual', triggerId },
        };

        const idempotencyKey = `manual-trigger:${triggerId}:${userId}:${requestId}`;
        const existingExecution = await checkIdempotencyKey(this.env.DB, row.wf_id!, idempotencyKey) as {
          id: string;
          status: string;
          session_id: string | null;
        } | null;

        if (existingExecution) {
          this.sendToRunner({
            type: 'trigger-api-result',
            requestId,
            data: {
              executionId: existingExecution.id,
              workflowId: row.wf_id,
              workflowName: row.workflow_name,
              status: existingExecution.status,
              variables,
              sessionId: existingExecution.session_id,
              message: 'Workflow execution already exists for this request.',
            },
          } as any);
          return;
        }

        const executionId = crypto.randomUUID();
        const now = new Date().toISOString();
        const workflowHash = await sha256Hex(String(row.workflow_data ?? '{}'));
        const repoUrl = typeof payload?.repoUrl === 'string' ? payload.repoUrl.trim() || undefined : undefined;
        const branch = typeof payload?.branch === 'string' ? payload.branch.trim() || undefined : undefined;
        const ref = typeof payload?.ref === 'string' ? payload.ref.trim() || undefined : undefined;
        const workerOrigin = this.deriveWorkerOriginFromSpawnRequest();
        const sourceRepoFullName = this.deriveRepoFullName(
          repoUrl,
          typeof payload?.sourceRepoFullName === 'string' ? payload.sourceRepoFullName : undefined,
        );
        const sessionId = await createWorkflowSession(this.appDb, {
          userId,
          workflowId: row.wf_id,
          executionId,
          sourceRepoUrl: repoUrl,
          sourceRepoFullName,
          branch,
          ref,
        });

        await createExecution(this.env.DB, {
          id: executionId,
          workflowId: row.wf_id!,
          userId,
          triggerId,
          triggerType: 'manual',
          triggerMetadata: JSON.stringify({ triggeredBy: 'api' }),
          variables: JSON.stringify(variables),
          now,
          workflowVersion: row.workflow_version || null,
          workflowHash,
          workflowSnapshot: row.workflow_data!,
          idempotencyKey,
          sessionId,
          initiatorType: 'manual',
          initiatorUserId: userId,
        });

        await updateTriggerLastRun(this.appDb, triggerId, now);

        const dispatched = await enqueueWorkflowExecution(this.env, {
          executionId,
          workflowId: row.wf_id,
          userId,
          sessionId,
          triggerType: 'manual',
          workerOrigin,
        });

        this.sendToRunner({
          type: 'trigger-api-result',
          requestId,
          data: {
            executionId,
            workflowId: row.wf_id,
            workflowName: row.workflow_name,
            status: 'pending',
            variables,
            sessionId,
            dispatched,
            message: dispatched
              ? 'Trigger run accepted and dispatched.'
              : 'Trigger run accepted but dispatch failed.',
          },
        } as any);
        return;
      }

      this.sendToRunner({ type: 'trigger-api-result', requestId, error: `Unsupported trigger action: ${action}` } as any);
    } catch (err) {
      console.error('[SessionAgentDO] Trigger API error:', err);
      this.sendToRunner({ type: 'trigger-api-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private async handleSkillApi(requestId: string, action: string, payload?: Record<string, unknown>) {
    try {
      const userId = this.getStateValue('userId')!;
      const orgId = await this.resolveOrgId() ?? 'default';

      if (action === 'search') {
        const q = typeof payload?.q === 'string' ? payload.q : '';
        const source = typeof payload?.source === 'string' ? payload.source as any : undefined;
        const skills = await searchSkills(this.appDb, orgId, userId, q, { source });
        this.sendToRunner({ type: 'skill-api-result', requestId, data: { skills } });
        return;
      }

      if (action === 'list') {
        const source = typeof payload?.source === 'string' ? payload.source as any : undefined;
        const visibility = typeof payload?.visibility === 'string' ? payload.visibility as any : undefined;
        const skills = await listSkills(this.appDb, orgId, userId, { source, visibility });
        this.sendToRunner({ type: 'skill-api-result', requestId, data: { skills } });
        return;
      }

      if (action === 'get') {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        if (!id) {
          this.sendToRunner({ type: 'skill-api-result', requestId, error: 'id is required', statusCode: 400 });
          return;
        }
        // Try by ID first, then fall back to slug lookup
        let skill = await getSkill(this.appDb, id);
        if (!skill) {
          skill = await getSkillBySlug(this.appDb, orgId, id, userId);
        }
        if (!skill) {
          this.sendToRunner({ type: 'skill-api-result', requestId, error: 'Skill not found', statusCode: 404 });
          return;
        }
        if (skill.visibility === 'private' && skill.ownerId !== userId) {
          this.sendToRunner({ type: 'skill-api-result', requestId, error: 'Skill not found', statusCode: 404 });
          return;
        }
        this.sendToRunner({ type: 'skill-api-result', requestId, data: { skill } });
        return;
      }

      if (action === 'create') {
        const name = typeof payload?.name === 'string' ? payload.name.trim() : '';
        const content = typeof payload?.content === 'string' ? payload.content : '';
        if (!name || !content) {
          this.sendToRunner({ type: 'skill-api-result', requestId, error: 'name and content are required', statusCode: 400 });
          return;
        }
        const slug = typeof payload?.slug === 'string' && payload.slug.trim()
          ? payload.slug.trim()
          : name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 100);
        const description = typeof payload?.description === 'string' ? payload.description : undefined;
        const visibility = payload?.visibility === 'shared' ? 'shared' as const : 'private' as const;
        const skill = await createSkill(this.appDb, {
          id: crypto.randomUUID(),
          orgId,
          ownerId: userId,
          source: 'managed',
          name,
          slug,
          description,
          content,
          visibility,
        });
        this.sendToRunner({ type: 'skill-api-result', requestId, data: { skill } });
        return;
      }

      if (action === 'update') {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        if (!id) {
          this.sendToRunner({ type: 'skill-api-result', requestId, error: 'id is required', statusCode: 400 });
          return;
        }
        const skill = await getSkill(this.appDb, id);
        if (!skill) {
          this.sendToRunner({ type: 'skill-api-result', requestId, error: 'Skill not found', statusCode: 404 });
          return;
        }
        if (skill.source !== 'managed') {
          this.sendToRunner({ type: 'skill-api-result', requestId, error: 'Only managed skills can be updated', statusCode: 403 });
          return;
        }
        if (skill.ownerId !== userId) {
          this.sendToRunner({ type: 'skill-api-result', requestId, error: 'Only the owner can update this skill', statusCode: 403 });
          return;
        }
        const updates: Record<string, string> = {};
        if (typeof payload?.name === 'string') updates.name = payload.name;
        if (typeof payload?.slug === 'string') updates.slug = payload.slug;
        if (typeof payload?.description === 'string') updates.description = payload.description;
        if (typeof payload?.content === 'string') updates.content = payload.content;
        if (typeof payload?.visibility === 'string') updates.visibility = payload.visibility;
        await updateSkill(this.appDb, id, updates);
        this.sendToRunner({ type: 'skill-api-result', requestId, data: { skill: { ...skill, ...updates } } });
        return;
      }

      if (action === 'delete') {
        const id = typeof payload?.id === 'string' ? payload.id : '';
        if (!id) {
          this.sendToRunner({ type: 'skill-api-result', requestId, error: 'id is required', statusCode: 400 });
          return;
        }
        const skill = await getSkill(this.appDb, id);
        if (!skill) {
          this.sendToRunner({ type: 'skill-api-result', requestId, error: 'Skill not found', statusCode: 404 });
          return;
        }
        if (skill.source !== 'managed') {
          this.sendToRunner({ type: 'skill-api-result', requestId, error: 'Only managed skills can be deleted', statusCode: 403 });
          return;
        }
        if (skill.ownerId !== userId) {
          this.sendToRunner({ type: 'skill-api-result', requestId, error: 'Only the owner can delete this skill', statusCode: 403 });
          return;
        }
        await deleteSkill(this.appDb, id);
        this.sendToRunner({ type: 'skill-api-result', requestId, data: { deleted: true } });
        return;
      }

      this.sendToRunner({ type: 'skill-api-result', requestId, error: `Unsupported skill action: ${action}`, statusCode: 400 });
    } catch (err) {
      console.error('[SessionAgentDO] Skill API error:', err);
      this.sendToRunner({ type: 'skill-api-result', requestId, error: err instanceof Error ? err.message : String(err), statusCode: 500 });
    }
  }

  private async handlePersonaApi(requestId: string, action: string, payload?: Record<string, unknown>) {
    try {
      const userId = this.getStateValue('userId')!;

      if (action === 'get') {
        const id = payload?.id as string;
        if (!id) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'id is required', statusCode: 400 });
          return;
        }
        const persona = await getPersonaWithFiles(this.env.DB, id);
        if (!persona) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'Persona not found', statusCode: 404 });
          return;
        }
        if (persona.visibility === 'private' && persona.createdBy !== userId) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'Persona not found', statusCode: 404 });
          return;
        }
        this.sendToRunner({ type: 'persona-api-result', requestId, data: { persona } });
        return;
      }

      if (action === 'create') {
        const name = payload?.name as string;
        const slug = payload?.slug as string;
        if (!name || !slug) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'name and slug are required', statusCode: 400 });
          return;
        }
        const personaId = crypto.randomUUID();
        const persona = await createPersona(this.appDb, {
          id: personaId,
          name,
          slug,
          description: payload?.description as string | undefined,
          icon: payload?.icon as string | undefined,
          defaultModel: payload?.defaultModel as string | undefined,
          visibility: (payload?.visibility as 'private' | 'shared') || 'shared',
          createdBy: userId,
        });
        // Create inline files if provided
        const files = payload?.files as Array<{ filename: string; content: string; sortOrder?: number }> | undefined;
        if (files?.length) {
          for (const file of files) {
            await upsertPersonaFile(this.appDb, {
              id: crypto.randomUUID(),
              personaId,
              filename: file.filename,
              content: file.content,
              sortOrder: file.sortOrder ?? 0,
            });
          }
        }
        this.sendToRunner({ type: 'persona-api-result', requestId, data: { persona } });
        return;
      }

      if (action === 'update') {
        const id = payload?.id as string;
        if (!id) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'id is required', statusCode: 400 });
          return;
        }
        const persona = await getPersonaWithFiles(this.env.DB, id);
        if (!persona) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'Persona not found', statusCode: 404 });
          return;
        }
        if (persona.createdBy !== userId) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'Only the creator can update this persona', statusCode: 403 });
          return;
        }
        const updates: Record<string, unknown> = {};
        if (payload?.name) updates.name = payload.name;
        if (payload?.slug) updates.slug = payload.slug;
        if (payload?.description !== undefined) updates.description = payload.description;
        if (payload?.icon !== undefined) updates.icon = payload.icon;
        if (payload?.defaultModel !== undefined) updates.defaultModel = payload.defaultModel;
        if (payload?.visibility) updates.visibility = payload.visibility;
        await updatePersona(this.appDb, id, updates);
        this.sendToRunner({ type: 'persona-api-result', requestId, data: { ok: true } });
        return;
      }

      if (action === 'delete') {
        const id = payload?.id as string;
        if (!id) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'id is required', statusCode: 400 });
          return;
        }
        const persona = await getPersonaWithFiles(this.env.DB, id);
        if (!persona) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'Persona not found', statusCode: 404 });
          return;
        }
        if (persona.createdBy !== userId) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'Only the creator can delete this persona', statusCode: 403 });
          return;
        }
        await deletePersona(this.appDb, id);
        this.sendToRunner({ type: 'persona-api-result', requestId, data: { deleted: true } });
        return;
      }

      if (action === 'upsert-file') {
        const personaId = payload?.personaId as string;
        const filename = payload?.filename as string;
        const content = payload?.content as string;
        if (!personaId || !filename || !content) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'personaId, filename, and content are required', statusCode: 400 });
          return;
        }
        const persona = await getPersonaWithFiles(this.env.DB, personaId);
        if (!persona) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'Persona not found', statusCode: 404 });
          return;
        }
        if (persona.createdBy !== userId) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'Only the creator can edit this persona', statusCode: 403 });
          return;
        }
        await upsertPersonaFile(this.appDb, {
          id: crypto.randomUUID(),
          personaId,
          filename,
          content,
          sortOrder: (payload?.sortOrder as number) ?? 0,
        });
        this.sendToRunner({ type: 'persona-api-result', requestId, data: { ok: true } });
        return;
      }

      if (action === 'list-skills') {
        const personaId = payload?.personaId as string;
        if (!personaId) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'personaId is required', statusCode: 400 });
          return;
        }
        const persona = await getPersonaWithFiles(this.env.DB, personaId);
        if (!persona) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'Persona not found', statusCode: 404 });
          return;
        }
        if (persona.visibility === 'private' && persona.createdBy !== userId) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'Persona not found', statusCode: 404 });
          return;
        }
        const skills = await getPersonaSkillsForApi(this.appDb, personaId);
        this.sendToRunner({ type: 'persona-api-result', requestId, data: { skills } });
        return;
      }

      if (action === 'attach-skill') {
        const personaId = payload?.personaId as string;
        const skillId = payload?.skillId as string;
        const sortOrder = (payload?.sortOrder as number) ?? 0;
        if (!personaId || !skillId) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'personaId and skillId are required', statusCode: 400 });
          return;
        }
        const persona = await getPersonaWithFiles(this.env.DB, personaId);
        if (!persona) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'Persona not found', statusCode: 404 });
          return;
        }
        if (persona.createdBy !== userId) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'Only the creator can modify this persona', statusCode: 403 });
          return;
        }
        const skill = await getSkill(this.appDb, skillId);
        if (!skill) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'Skill not found', statusCode: 404 });
          return;
        }
        await attachSkillToPersona(this.appDb, crypto.randomUUID(), personaId, skillId, sortOrder);
        this.sendToRunner({ type: 'persona-api-result', requestId, data: { attached: true } });
        return;
      }

      if (action === 'detach-skill') {
        const personaId = payload?.personaId as string;
        const skillId = payload?.skillId as string;
        if (!personaId || !skillId) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'personaId and skillId are required', statusCode: 400 });
          return;
        }
        const persona = await getPersonaWithFiles(this.env.DB, personaId);
        if (!persona) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'Persona not found', statusCode: 404 });
          return;
        }
        if (persona.createdBy !== userId) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'Only the creator can modify this persona', statusCode: 403 });
          return;
        }
        const changes = await detachSkillFromPersona(this.appDb, personaId, skillId);
        if (changes === 0) {
          this.sendToRunner({ type: 'persona-api-result', requestId, error: 'Skill was not attached to this persona', statusCode: 404 });
          return;
        }
        this.sendToRunner({ type: 'persona-api-result', requestId, data: { detached: true } });
        return;
      }

      this.sendToRunner({ type: 'persona-api-result', requestId, error: `Unsupported persona action: ${action}`, statusCode: 400 });
    } catch (err) {
      console.error('[SessionAgentDO] Persona API error:', err);
      this.sendToRunner({ type: 'persona-api-result', requestId, error: err instanceof Error ? err.message : String(err), statusCode: 500 });
    }
  }

  private async handleExecutionApi(requestId: string, action: string, payload?: Record<string, unknown>) {
    try {
      const userId = this.getStateValue('userId')!;
      const executionId = typeof payload?.executionId === 'string' ? payload.executionId.trim() : '';
      if (!executionId) {
        this.sendToRunner({ type: 'execution-api-result', requestId, error: 'executionId is required' } as any);
        return;
      }

      if (action === 'get') {
        const row = await getExecution(this.env.DB, executionId, userId);

        if (!row) {
          this.sendToRunner({ type: 'execution-api-result', requestId, error: `Execution not found: ${executionId}` } as any);
          return;
        }

        this.sendToRunner({
          type: 'execution-api-result',
          requestId,
          data: {
            execution: {
              id: row.id,
              workflowId: row.workflow_id,
              workflowName: row.workflow_name,
              sessionId: row.session_id,
              triggerId: row.trigger_id,
              triggerName: row.trigger_name,
              status: row.status,
              triggerType: row.trigger_type,
              triggerMetadata: this.parseJsonOrNull(row.trigger_metadata),
              variables: this.parseJsonOrNull(row.variables),
              resumeToken: row.resume_token || null,
              outputs: this.parseJsonOrNull(row.outputs),
              steps: this.parseJsonOrNull(row.steps),
              error: row.error,
              startedAt: row.started_at,
              completedAt: row.completed_at,
            },
          },
        } as any);
        return;
      }

      if (action === 'steps') {
        const execution = await getExecutionForAuth(this.appDb, executionId);

        if (!execution || execution.user_id !== userId) {
          this.sendToRunner({ type: 'execution-api-result', requestId, error: `Execution not found: ${executionId}` } as any);
          return;
        }

        const buildWorkflowStepOrderMap = (workflowSnapshotRaw: string | null): Map<string, number> => {
          if (!workflowSnapshotRaw) return new Map();
          let parsed: unknown;
          try {
            parsed = JSON.parse(workflowSnapshotRaw);
          } catch {
            return new Map();
          }
          const order = new Map<string, number>();
          let index = 0;
          const visitStepList = (rawSteps: unknown): void => {
            if (!Array.isArray(rawSteps)) return;
            for (const entry of rawSteps) {
              if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
              const stepRecord = entry as Record<string, unknown>;
              const stepId = typeof stepRecord.id === 'string' ? stepRecord.id : '';
              if (stepId && !order.has(stepId)) {
                order.set(stepId, index);
                index += 1;
              }
              visitStepList(stepRecord.then);
              visitStepList(stepRecord.else);
              visitStepList(stepRecord.steps);
            }
          };
          if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
            visitStepList((parsed as Record<string, unknown>).steps);
          } else if (Array.isArray(parsed)) {
            visitStepList(parsed);
          }
          return order;
        };

        const workflowStepOrder = buildWorkflowStepOrderMap(execution.workflow_snapshot);
        const rankStepOrderIndex = (value: number | null): number => value ?? Number.MAX_SAFE_INTEGER;

        const result = await getExecutionSteps(this.env.DB, executionId);

        const steps = (result.results || [])
          .map((row) => ({
            id: row.id,
            executionId: row.execution_id,
            stepId: String(row.step_id),
            attempt: Number(row.attempt || 1),
            status: String(row.status),
            input: this.parseJsonOrNull((row.input_json as string | null) || null),
            output: this.parseJsonOrNull((row.output_json as string | null) || null),
            error: (row.error as string | null) || null,
            startedAt: (row.started_at as string | null) || null,
            completedAt: (row.completed_at as string | null) || null,
            createdAt: String(row.created_at),
            workflowStepIndex: workflowStepOrder.get(String(row.step_id)) ?? null,
            insertionOrder: Number(row.insertion_order || 0),
          }))
          .sort((left, right) => {
            if (left.attempt !== right.attempt) return left.attempt - right.attempt;
            const leftIndex = rankStepOrderIndex(left.workflowStepIndex);
            const rightIndex = rankStepOrderIndex(right.workflowStepIndex);
            if (leftIndex !== rightIndex) return leftIndex - rightIndex;
            if (left.insertionOrder !== right.insertionOrder) return left.insertionOrder - right.insertionOrder;
            return left.stepId.localeCompare(right.stepId);
          })
          .map((step, sequence) => ({
            id: step.id,
            executionId: step.executionId,
            stepId: step.stepId,
            attempt: step.attempt,
            status: step.status,
            input: step.input,
            output: step.output,
            error: step.error,
            startedAt: step.startedAt,
            completedAt: step.completedAt,
            createdAt: step.createdAt,
            workflowStepIndex: step.workflowStepIndex,
            sequence,
          }));

        this.sendToRunner({ type: 'execution-api-result', requestId, data: { steps } } as any);
        return;
      }

      if (action === 'approve') {
        const approve = payload?.approve === true;
        const resumeToken = typeof payload?.resumeToken === 'string' ? payload.resumeToken : '';
        const reason = typeof payload?.reason === 'string' ? payload.reason : undefined;
        if (!resumeToken) {
          this.sendToRunner({ type: 'execution-api-result', requestId, error: 'resumeToken is required' } as any);
          return;
        }

        const execution = await getExecutionOwnerAndStatus(this.appDb, executionId) as { user_id: string; status: string } | null;
        if (!execution || execution.user_id !== userId) {
          this.sendToRunner({ type: 'execution-api-result', requestId, error: `Execution not found: ${executionId}` } as any);
          return;
        }

        const doId = this.env.WORKFLOW_EXECUTOR.idFromName(executionId);
        const stub = this.env.WORKFLOW_EXECUTOR.get(doId);
        const response = await stub.fetch(new Request('https://workflow-executor/resume', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            executionId,
            resumeToken,
            approve,
            reason,
          }),
        }));

        if (!response.ok) {
          const errorBody = await response.json<{ error?: string }>().catch((): { error?: string } => ({ error: undefined }));
          this.sendToRunner({
            type: 'execution-api-result',
            requestId,
            error: errorBody.error || `Failed to apply approval decision (${response.status})`,
          } as any);
          return;
        }

        const result = await response.json<{ ok: boolean; status: string }>();
        this.sendToRunner({ type: 'execution-api-result', requestId, data: { success: true, status: result.status } } as any);
        return;
      }

      if (action === 'cancel') {
        const reason = typeof payload?.reason === 'string' ? payload.reason : undefined;
        const execution = await getExecutionOwnerAndStatus(this.appDb, executionId) as { user_id: string; status: string } | null;
        if (!execution || execution.user_id !== userId) {
          this.sendToRunner({ type: 'execution-api-result', requestId, error: `Execution not found: ${executionId}` } as any);
          return;
        }

        const doId = this.env.WORKFLOW_EXECUTOR.idFromName(executionId);
        const stub = this.env.WORKFLOW_EXECUTOR.get(doId);
        const response = await stub.fetch(new Request('https://workflow-executor/cancel', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            executionId,
            reason,
          }),
        }));

        if (!response.ok) {
          const errorBody = await response.json<{ error?: string }>().catch((): { error?: string } => ({ error: undefined }));
          this.sendToRunner({
            type: 'execution-api-result',
            requestId,
            error: errorBody.error || `Failed to cancel execution (${response.status})`,
          } as any);
          return;
        }

        const result = await response.json<{ ok: boolean; status: string }>();
        this.sendToRunner({ type: 'execution-api-result', requestId, data: { success: true, status: result.status } } as any);
        return;
      }

      this.sendToRunner({ type: 'execution-api-result', requestId, error: `Unsupported execution action: ${action}` } as any);
    } catch (err) {
      console.error('[SessionAgentDO] Execution API error:', err);
      this.sendToRunner({ type: 'execution-api-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private async handleWorkflowExecutionResult(msg: RunnerMessage) {
    const executionId = msg.executionId || msg.envelope?.executionId;
    const envelope = msg.envelope;
    if (!executionId || !envelope) {
      console.error('[SessionAgentDO] Invalid workflow execution result payload');
      return;
    }

    const execution = await getExecutionWithWorkflowName(this.env.DB, executionId);

    if (!execution) {
      console.warn(`[SessionAgentDO] Received workflow result for unknown execution ${executionId}`);
      return;
    }

    const currentSessionId = this.getStateValue('sessionId');
    if (execution.session_id && currentSessionId && execution.session_id !== currentSessionId) {
      console.warn(
        `[SessionAgentDO] Ignoring workflow result for ${executionId}: execution bound to ${execution.session_id}, this DO is ${currentSessionId}`,
      );
      return;
    }

    const outputsJson = envelope.output ? JSON.stringify(envelope.output) : null;
    const stepsJson = envelope.steps ? JSON.stringify(envelope.steps) : null;

    let nextStatus: 'completed' | 'failed' | 'cancelled' | 'waiting_approval' = 'failed';
    let error: string | null = envelope.error || null;
    let resumeToken: string | null = null;
    let completedAt: string | null = new Date().toISOString();

    if (envelope.status === 'ok') {
      nextStatus = 'completed';
      error = null;
    } else if (envelope.status === 'failed') {
      nextStatus = 'failed';
      error = envelope.error || 'workflow_failed';
    } else if (envelope.status === 'cancelled') {
      nextStatus = 'cancelled';
      error = envelope.error || 'workflow_cancelled';
    } else if (envelope.status === 'needs_approval') {
      resumeToken = envelope.requiresApproval?.resumeToken || null;
      if (!resumeToken) {
        nextStatus = 'failed';
        error = 'approval_resume_token_missing';
      } else {
        nextStatus = 'waiting_approval';
        error = null;
        completedAt = null;
      }
    }

    await completeExecutionFull(this.appDb, executionId, {
      status: nextStatus,
      outputs: outputsJson,
      steps: stepsJson,
      error,
      resumeToken,
      completedAt,
    });

    if (Array.isArray(envelope.steps) && envelope.steps.length > 0) {
      for (const step of envelope.steps) {
        const attempt = step.attempt && step.attempt > 0 ? step.attempt : 1;
        await upsertExecutionStep(this.env.DB, executionId, {
          stepId: step.stepId,
          attempt,
          status: step.status,
          input: step.input !== undefined ? JSON.stringify(step.input) : null,
          output: step.output !== undefined ? JSON.stringify(step.output) : null,
          error: step.error || null,
          startedAt: step.startedAt || null,
          completedAt: step.completedAt || null,
        });
      }
    }

    if (nextStatus === 'waiting_approval') {
      try {
        await enqueueWorkflowApprovalNotificationIfMissing(this.env.DB, {
          toUserId: execution.user_id,
          executionId,
          fromSessionId: execution.session_id || currentSessionId || undefined,
          contextSessionId: execution.session_id || currentSessionId || undefined,
          workflowName: execution.workflow_name,
          approvalPrompt: envelope.requiresApproval?.prompt,
        });
      } catch (notifyError) {
        console.error('[SessionAgentDO] Failed to enqueue workflow approval notification:', notifyError);
      }
    } else {
      try {
        await markWorkflowApprovalNotificationsRead(this.appDb, execution.user_id, executionId);
      } catch (notifyError) {
        console.error('[SessionAgentDO] Failed to clear workflow approval notifications:', notifyError);
      }
    }

    if (nextStatus !== 'waiting_approval' && currentSessionId) {
      const sessionRow = await getSession(this.appDb, currentSessionId);

      if (sessionRow?.purpose === 'workflow') {
        this.ctx.waitUntil(this.handleStop(`workflow_execution_${nextStatus}`));
      }
    }
  }

  private async handleListPullRequests(
    requestId: string,
    params: { owner?: string; repo?: string; state?: string; limit?: number },
  ) {
    try {
      const githubToken = await this.getGitHubToken();
      if (!githubToken) {
        this.sendToRunner({ type: 'list-pull-requests-result', requestId, error: 'No GitHub token found — user must connect GitHub in settings' } as any);
        return;
      }

      const { owner, repo } = await this.resolveOwnerRepo(params.owner, params.repo);
      const state = params.state || 'open';
      const limit = Math.min(Math.max(params.limit ?? 30, 1), 100);

      const res = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls?state=${encodeURIComponent(state)}&sort=updated&direction=desc&per_page=${limit}`,
        {
          headers: {
            'Authorization': `Bearer ${githubToken}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'valet',
          },
        },
      );

      if (!res.ok) {
        const errText = await res.text();
        this.sendToRunner({ type: 'list-pull-requests-result', requestId, error: `GitHub API error (${res.status}): ${errText}` } as any);
        return;
      }

      const pulls = await res.json() as Array<{
        number: number;
        title: string;
        state: string;
        draft: boolean;
        body: string | null;
        html_url: string;
        created_at: string;
        updated_at: string;
        user: { login: string; avatar_url: string };
        head: { ref: string; sha: string };
        base: { ref: string; sha: string };
        labels: Array<{ name: string }>;
      }>;

      this.sendToRunner({
        type: 'list-pull-requests-result',
        requestId,
        pulls: pulls.map((pr) => ({
          number: pr.number,
          title: pr.title,
          state: pr.state,
          draft: pr.draft,
          body: pr.body,
          url: pr.html_url,
          createdAt: pr.created_at,
          updatedAt: pr.updated_at,
          author: { login: pr.user.login, avatarUrl: pr.user.avatar_url },
          headRef: pr.head.ref,
          headSha: pr.head.sha,
          baseRef: pr.base.ref,
          baseSha: pr.base.sha,
          labels: pr.labels?.map((label) => label.name) ?? [],
        })),
      } as any);
    } catch (err) {
      console.error('[SessionAgentDO] Failed to list pull requests:', err);
      this.sendToRunner({ type: 'list-pull-requests-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private async handleInspectPullRequest(
    requestId: string,
    params: { prNumber: number; owner?: string; repo?: string; filesLimit?: number; commentsLimit?: number },
  ) {
    try {
      const githubToken = await this.getGitHubToken();
      if (!githubToken) {
        this.sendToRunner({ type: 'inspect-pull-request-result', requestId, error: 'No GitHub token found — user must connect GitHub in settings' } as any);
        return;
      }

      const { owner, repo } = await this.resolveOwnerRepo(params.owner, params.repo);
      const filesLimit = Math.min(Math.max(params.filesLimit ?? 200, 1), 300);
      const commentsLimit = Math.min(Math.max(params.commentsLimit ?? 100, 1), 300);

      const prResp = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${params.prNumber}`, {
        headers: {
          'Authorization': `Bearer ${githubToken}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'valet',
        },
      });

      if (!prResp.ok) {
        const errText = await prResp.text();
        this.sendToRunner({ type: 'inspect-pull-request-result', requestId, error: `GitHub API error (${prResp.status}): ${errText}` } as any);
        return;
      }

      const pr = await prResp.json() as {
        number: number;
        title: string;
        state: string;
        draft: boolean;
        body: string | null;
        html_url: string;
        created_at: string;
        updated_at: string;
        closed_at: string | null;
        merged_at: string | null;
        user: { login: string; avatar_url: string };
        base: { ref: string; sha: string };
        head: { ref: string; sha: string };
        labels: Array<{ name: string }>;
        assignees: Array<{ login: string }>;
        requested_reviewers: Array<{ login: string }>;
        requested_teams: Array<{ name: string }>;
        mergeable: boolean | null;
        mergeable_state: string;
        commits: number;
        additions: number;
        deletions: number;
        changed_files: number;
      };

      const perPage = 100;
      let page = 1;
      const files: Array<{ filename: string; status: string; additions: number; deletions: number; changes: number }> = [];
      let filesTruncated = false;
      while (files.length < filesLimit) {
        const remaining = filesLimit - files.length;
        const pageSize = Math.min(perPage, remaining);
        const filesResp = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/pulls/${params.prNumber}/files?per_page=${pageSize}&page=${page}`,
          {
            headers: {
              'Authorization': `Bearer ${githubToken}`,
              'Accept': 'application/vnd.github+json',
              'User-Agent': 'valet',
            },
          },
        );
        if (!filesResp.ok) {
          const errText = await filesResp.text();
          throw new Error(`GitHub API error (${filesResp.status}) while fetching files: ${errText}`);
        }
        const pageFiles = await filesResp.json() as Array<{
          filename: string;
          status: string;
          additions: number;
          deletions: number;
          changes: number;
        }>;
        files.push(...pageFiles.map((f) => ({
          filename: f.filename,
          status: f.status,
          additions: f.additions,
          deletions: f.deletions,
          changes: f.changes,
        })));
        if (pageFiles.length < pageSize) break;
        page += 1;
      }
      if (files.length >= filesLimit && pr.changed_files > filesLimit) filesTruncated = true;

      const reviewsResp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/pulls/${params.prNumber}/reviews?per_page=100`,
        {
          headers: {
            'Authorization': `Bearer ${githubToken}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'valet',
          },
        },
      );

      const reviews = reviewsResp.ok
        ? await reviewsResp.json() as Array<{ id: number; user: { login: string }; state: string; submitted_at: string | null }>
        : [];
      const dismissedReviewIds = new Set(reviews.filter(r => r.state === 'DISMISSED').map(r => r.id));

      const reviewCounts = reviews.reduce<Record<string, number>>((acc, review) => {
        acc[review.state] = (acc[review.state] || 0) + 1;
        return acc;
      }, {});

      const reviewComments: Array<{
        id: number;
        user: { login: string };
        body: string;
        path: string;
        line: number | null;
        created_at: string;
        updated_at: string;
      }> = [];
      let commentsPage = 1;
      while (reviewComments.length < commentsLimit) {
        const remaining = commentsLimit - reviewComments.length;
        const pageSize = Math.min(perPage, remaining);
        const commentsResp = await fetch(
          `https://api.github.com/repos/${owner}/${repo}/pulls/${params.prNumber}/comments?per_page=${pageSize}&page=${commentsPage}`,
          {
            headers: {
              'Authorization': `Bearer ${githubToken}`,
              'Accept': 'application/vnd.github+json',
              'User-Agent': 'valet',
            },
          },
        );
        if (!commentsResp.ok) {
          const errText = await commentsResp.text();
          throw new Error(`GitHub API error (${commentsResp.status}) while fetching review comments: ${errText}`);
        }
        const pageComments = await commentsResp.json() as Array<{
          id: number;
          user: { login: string };
          body: string;
          path: string;
          line: number | null;
          created_at: string;
          updated_at: string;
          pull_request_review_id?: number;
        }>;
        const filtered = pageComments.filter((comment) => {
          if (!comment.pull_request_review_id) return true;
          return !dismissedReviewIds.has(comment.pull_request_review_id);
        });
        reviewComments.push(...filtered.map((comment) => ({
          id: comment.id,
          user: { login: comment.user.login },
          body: comment.body,
          path: comment.path,
          line: comment.line,
          created_at: comment.created_at,
          updated_at: comment.updated_at,
        })));
        if (pageComments.length < pageSize) break;
        commentsPage += 1;
      }
      const commentsTruncated = reviewComments.length >= commentsLimit;

      const statusResp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/commits/${pr.head.sha}/status`,
        {
          headers: {
            'Authorization': `Bearer ${githubToken}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'valet',
          },
        },
      );
      const statusData = statusResp.ok ? await statusResp.json() as {
        state: string;
        statuses: Array<{ state: string; context: string; description: string | null; target_url: string | null; updated_at: string }>;
      } : null;

      const checksResp = await fetch(
        `https://api.github.com/repos/${owner}/${repo}/commits/${pr.head.sha}/check-runs?per_page=100`,
        {
          headers: {
            'Authorization': `Bearer ${githubToken}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'valet',
          },
        },
      );
      const checksData = checksResp.ok ? await checksResp.json() as {
        total_count: number;
        check_runs: Array<{ name: string; status: string; conclusion: string | null; html_url: string | null; app: { name: string } }>;
      } : null;

      const checkSummary = checksData?.check_runs.reduce<Record<string, number>>((acc, run) => {
        const key = run.conclusion || run.status || 'unknown';
        acc[key] = (acc[key] || 0) + 1;
        return acc;
      }, {}) ?? {};

      this.sendToRunner({
        type: 'inspect-pull-request-result',
        requestId,
        data: {
          repo: { owner, repo },
          pr: {
            number: pr.number,
            title: pr.title,
            state: pr.state,
            draft: pr.draft,
            url: pr.html_url,
            body: pr.body,
            createdAt: pr.created_at,
            updatedAt: pr.updated_at,
            closedAt: pr.closed_at,
            mergedAt: pr.merged_at,
            author: { login: pr.user.login, avatarUrl: pr.user.avatar_url },
            baseRef: pr.base.ref,
            baseSha: pr.base.sha,
            headRef: pr.head.ref,
            headSha: pr.head.sha,
            labels: pr.labels?.map((label) => label.name) ?? [],
            assignees: pr.assignees?.map((assignee) => assignee.login) ?? [],
            requestedReviewers: pr.requested_reviewers?.map((reviewer) => reviewer.login) ?? [],
            requestedTeams: pr.requested_teams?.map((team) => team.name) ?? [],
            mergeable: pr.mergeable,
            mergeableState: pr.mergeable_state,
            commits: pr.commits,
            additions: pr.additions,
            deletions: pr.deletions,
            changedFiles: pr.changed_files,
          },
          files: {
            totalChangedFiles: pr.changed_files,
            returned: files.length,
            truncated: filesTruncated,
            items: files,
          },
          reviews: {
            counts: reviewCounts,
            items: reviews.map((review) => ({
              id: review.id,
              user: { login: review.user.login },
              state: review.state,
              submittedAt: review.submitted_at,
            })),
          },
          reviewComments: {
            returned: reviewComments.length,
            truncated: commentsTruncated,
            items: reviewComments,
          },
          checks: {
            status: statusData
              ? {
                state: statusData.state,
                items: statusData.statuses.map((s) => ({
                  state: s.state,
                  context: s.context,
                  description: s.description,
                  targetUrl: s.target_url,
                  updatedAt: s.updated_at,
                })),
              }
              : null,
            checkRuns: checksData
              ? {
                total: checksData.total_count,
                summary: checkSummary,
                items: checksData.check_runs.map((run) => ({
                  name: run.name,
                  status: run.status,
                  conclusion: run.conclusion,
                  url: run.html_url,
                  app: run.app?.name,
                })),
              }
              : null,
          },
        },
      } as any);
    } catch (err) {
      console.error('[SessionAgentDO] Failed to inspect pull request:', err);
      this.sendToRunner({ type: 'inspect-pull-request-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private async handleListPersonas(requestId: string) {
    try {
      const userId = this.getStateValue('userId')!;
      const personas = await listPersonas(this.env.DB, userId);
      this.sendToRunner({ type: 'list-personas-result', requestId, personas } as any);
    } catch (err) {
      console.error('[SessionAgentDO] Failed to list personas:', err);
      this.sendToRunner({ type: 'list-personas-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private async handleListChannels(requestId: string) {
    try {
      const userId = this.getStateValue('userId');
      const sessionId = this.getStateValue('sessionId')!;

      let bindings = userId
        ? await listUserChannelBindings(this.appDb, userId)
        : [];

      // Fallback to session-scoped bindings if user-level bindings are unavailable.
      if (bindings.length === 0) {
        bindings = await getSessionChannelBindings(this.appDb, sessionId);
      }

      // Deduplicate by destination while preserving recency ordering.
      const unique: typeof bindings = [];
      const seen = new Set<string>();
      for (const binding of bindings) {
        const key = `${binding.channelType}:${binding.channelId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        unique.push(binding);
      }

      this.sendToRunner({ type: 'list-channels-result', requestId, channels: unique } as any);
    } catch (err) {
      console.error('[SessionAgentDO] Failed to list channels:', err);
      this.sendToRunner({ type: 'list-channels-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private async handleListChildSessions(requestId: string) {
    try {
      const sessionId = this.getStateValue('sessionId')!;
      const { children } = await getChildSessions(this.env.DB, sessionId);
      this.sendToRunner({ type: 'list-child-sessions-result', requestId, children } as any);
    } catch (err) {
      console.error('[SessionAgentDO] Failed to list child sessions:', err);
      this.sendToRunner({ type: 'list-child-sessions-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private async handleReadRepoFile(
    requestId: string,
    params: { owner?: string; repo?: string; repoUrl?: string; path?: string; ref?: string },
  ) {
    try {
      const githubToken = await this.getGitHubToken();
      if (!githubToken) {
        this.sendToRunner({ type: 'read-repo-file-result', requestId, error: 'No GitHub token found — user must connect GitHub in settings' } as any);
        return;
      }

      if (!params.path) {
        this.sendToRunner({ type: 'read-repo-file-result', requestId, error: 'Missing file path' } as any);
        return;
      }

      let owner = params.owner;
      let repo = params.repo;
      if (params.repoUrl) {
        const ownerRepo = this.extractOwnerRepo(params.repoUrl);
        if (ownerRepo) {
          owner = ownerRepo.owner;
          repo = ownerRepo.repo;
        }
      }
      if (!owner || !repo) {
        // Allow repo in "owner/repo" format if passed in repo
        if (repo && repo.includes('/')) {
          const [o, r] = repo.split('/');
          owner = owner || o;
          repo = r;
        }
      }

      if (!owner || !repo) {
        const resolved = await this.resolveOwnerRepo(owner, repo);
        owner = resolved.owner;
        repo = resolved.repo;
      }

      const encodedPath = params.path.split('/').map(encodeURIComponent).join('/');
      const url = new URL(`https://api.github.com/repos/${owner}/${repo}/contents/${encodedPath}`);
      if (params.ref) url.searchParams.set('ref', params.ref);

      const res = await fetch(url.toString(), {
        headers: {
          'Authorization': `Bearer ${githubToken}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'valet',
        },
      });

      if (!res.ok) {
        const errText = await res.text();
        this.sendToRunner({ type: 'read-repo-file-result', requestId, error: `GitHub API error (${res.status}): ${errText}` } as any);
        return;
      }

      const data = await res.json() as {
        type: 'file' | 'dir';
        encoding?: string;
        content?: string;
        path?: string;
        size?: number;
      };

      if (data.type === 'dir') {
        this.sendToRunner({ type: 'read-repo-file-result', requestId, error: `Path is a directory: ${params.path}` } as any);
        return;
      }

      const encoding = data.encoding || 'base64';
      let content = data.content || '';
      if (encoding === 'base64' && content) {
        content = atob(content.replace(/\n/g, ''));
      }

      const MAX_CHARS = 200_000;
      let truncated = false;
      if (content.length > MAX_CHARS) {
        content = content.slice(0, MAX_CHARS);
        truncated = true;
      }

      this.sendToRunner({
        type: 'read-repo-file-result',
        requestId,
        content,
        encoding,
        truncated,
        path: data.path || params.path,
        repo: `${owner}/${repo}`,
        ref: params.ref,
      } as any);
    } catch (err) {
      console.error('[SessionAgentDO] Failed to read repo file:', err);
      this.sendToRunner({ type: 'read-repo-file-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private async handleGetSessionStatus(requestId: string, targetSessionId: string) {
    try {
      const userId = this.getStateValue('userId')!;
      const session = await getSession(this.appDb, targetSessionId);
      if (!session || session.userId !== userId) {
        this.sendToRunner({ type: 'get-session-status-result', requestId, error: 'Session not found or access denied' } as any);
        return;
      }

      // Fetch recent messages from the target DO's local SQLite (not D1)
      const recentMessages = await this.fetchMessagesFromDO(targetSessionId, 10);

      // Fetch live runner/sandbox status from target DO
      let liveStatus: {
        runnerConnected?: boolean;
        runnerBusy?: boolean;
        queuedPrompts?: number;
        sandboxId?: string | null;
        status?: string;
        tunnelUrls?: Record<string, string> | null;
        tunnels?: Array<{ name: string; url?: string; path?: string; port?: number; protocol?: string }> | null;
      } | null = null;
      try {
        const doId = this.env.SESSIONS.idFromName(targetSessionId);
        const targetDO = this.env.SESSIONS.get(doId);
        const statusRes = await targetDO.fetch(new Request('http://do/status'));
        if (statusRes.ok) {
          liveStatus = await statusRes.json() as any;
        }
      } catch (err) {
        console.warn('[SessionAgentDO] Failed to fetch live status for session:', targetSessionId, err);
      }

      const runnerBusy = liveStatus?.runnerBusy ?? false;
      const queuedPrompts = liveStatus?.queuedPrompts ?? 0;
      const runnerConnected = liveStatus?.runnerConnected ?? false;
      const agentStatus = runnerBusy || queuedPrompts > 0 ? 'working' : 'idle';

      this.sendToRunner({
        type: 'get-session-status-result',
        requestId,
        sessionStatus: {
          id: session.id,
          status: session.status,
          workspace: session.workspace,
          title: session.title,
          createdAt: session.createdAt instanceof Date ? session.createdAt.toISOString() : String(session.createdAt),
          lastActiveAt: session.lastActiveAt instanceof Date ? session.lastActiveAt.toISOString() : String(session.lastActiveAt),
          runnerConnected,
          runnerBusy,
          queuedPrompts,
          agentStatus,
          recentMessages,
          tunnelUrls: liveStatus?.tunnelUrls ?? null,
          tunnels: liveStatus?.tunnels ?? null,
        },
      } as any);
    } catch (err) {
      console.error('[SessionAgentDO] Failed to get session status:', err);
      this.sendToRunner({ type: 'get-session-status-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
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
    const sessionId = this.getStateValue('sessionId');
    if (!sessionId) return;

    const lastFlushStr = this.getStateValue('lastD1FlushAt');
    const lastFlushAt = lastFlushStr ? parseInt(lastFlushStr) : 0;

    // Query DO's internal messages for rows created after last flush.
    // Include active turns — INSERT OR REPLACE will update partial data in D1
    // so clients loading from D1 on page refresh see the latest state.
    const rows = this.ctx.storage.sql
      .exec(
        'SELECT id, role, content, parts, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, opencode_session_id, message_format, thread_id, created_at FROM messages WHERE created_at > ? ORDER BY created_at ASC LIMIT 200',
        lastFlushAt
      )
      .toArray();

    if (rows.length === 0) return;

    // Batch write to D1 — use INSERT OR REPLACE (content updates on finalize)
    try {
      await batchUpsertMessages(this.env.DB, sessionId, rows.map((row) => ({
        id: row.id as string,
        role: row.role as string,
        content: row.content as string,
        parts: row.parts as string | null,
        authorId: row.author_id as string | null,
        authorEmail: row.author_email as string | null,
        authorName: row.author_name as string | null,
        authorAvatarUrl: row.author_avatar_url as string | null,
        channelType: row.channel_type as string | null,
        channelId: row.channel_id as string | null,
        opencodeSessionId: row.opencode_session_id as string | null,
        messageFormat: (row.message_format as string) || 'v2',
        threadId: row.thread_id as string | null,
      })));
      // Advance watermark — active turns will be re-flushed with updated parts
      // on subsequent flushes since INSERT OR REPLACE handles the upsert.
      // Don't advance past active turns so they get picked up again.
      const activeTurnIds = new Set(this.activeTurns.keys());
      const activeTs = rows
        .filter((row) => activeTurnIds.has(row.id as string))
        .map((row) => row.created_at as number);
      const minActiveTs = activeTs.length > 0 ? Math.min(...activeTs) : null;
      const latestFlushed = rows[rows.length - 1].created_at as number;
      const safeWatermark = minActiveTs !== null ? Math.min(latestFlushed, minActiveTs - 1) : latestFlushed;
      this.setStateValue('lastD1FlushAt', String(safeWatermark));
      console.log(`[SessionAgentDO] Flushed ${rows.length} messages to D1 (watermark=${safeWatermark}${minActiveTs !== null ? `, active turns will re-flush` : ''})`);
    } catch (err) {
      console.error('[SessionAgentDO] Failed to flush messages to D1:', err);
    }
  }

  // ─── Per-Channel Busy State ──────────────────────────────────────────

  private channelKeyFrom(channelType?: string, channelId?: string): string {
    if (channelType && channelId) return `${channelType}:${channelId}`;
    return 'web:default';
  }

  private isChannelBusy(channelKey: string): boolean {
    const row = this.ctx.storage.sql
      .exec('SELECT busy FROM channel_state WHERE channel_key = ?', channelKey)
      .toArray();
    return row.length > 0 && (row[0].busy as number) === 1;
  }

  private setChannelBusy(channelKey: string, busy: boolean): void {
    this.ctx.storage.sql.exec(
      'INSERT INTO channel_state (channel_key, busy) VALUES (?, ?) ON CONFLICT(channel_key) DO UPDATE SET busy = excluded.busy',
      channelKey, busy ? 1 : 0
    );
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


  private async handlePromptComplete() {
    this.setStateValue('lastPromptDispatchedAt', '');
    this.setStateValue('errorSafetyNetAt', '');
    this.appendAuditLog('agent.turn_complete', 'Agent turn completed');

    // Mark any processing prompt_queue entries as completed
    const processingCount = this.ctx.storage.sql
      .exec("SELECT COUNT(*) AS count FROM prompt_queue WHERE status = 'processing'")
      .toArray()[0]?.count ?? 0;
    this.ctx.storage.sql.exec(
      "UPDATE prompt_queue SET status = 'completed' WHERE status = 'processing'"
    );

    // Prune old completed entries to prevent unbounded storage growth
    this.ctx.storage.sql.exec(
      "DELETE FROM prompt_queue WHERE status = 'completed'"
    );

    const queuedAfterPrune = this.getQueueLength();
    console.log(`[SessionAgentDO] handlePromptComplete: marked ${processingCount} processing→completed, queuedRemaining=${queuedAfterPrune}`);

    if (await this.sendNextQueuedPrompt()) {
      console.log(`[SessionAgentDO] handlePromptComplete: dispatched next queued prompt, keeping runnerBusy=true`);
      // More work in the queue — flush messages synchronously so they survive hibernation
      await this.flushMessagesToD1();
      return;
    }

    // Runner is now idle — flush messages synchronously so they survive hibernation
    await this.flushMessagesToD1();

    // Runner is now idle
    console.log(`[SessionAgentDO] handlePromptComplete: queue empty, setting runnerBusy=false`);
    this.setStateValue('runnerBusy', 'false');
    this.broadcastToClients({
      type: 'status',
      data: { runnerBusy: false },
    });
    this.notifyParentIfIdle();
  }

  // ─── Internal Endpoints ────────────────────────────────────────────────

  private async handleStart(request: Request): Promise<Response> {
    const body = await request.json() as {
      sessionId: string;
      userId: string;
      workspace: string;
      runnerToken: string;
      sandboxId?: string;
      tunnelUrls?: {
        opencode: string;
        gateway: string;
        vscode?: string;
        vnc?: string;
        ttyd?: string;
      };
      // For async sandbox spawning (DO calls Modal in the background)
      backendUrl?: string;
      terminateUrl?: string;
      hibernateUrl?: string;
      restoreUrl?: string;
      spawnRequest?: Record<string, unknown>;
      idleTimeoutMs?: number;
      initialPrompt?: string;
      initialModel?: string;
    };

    // Clear old session data (messages, queue, audit log, followups) for a fresh start.
    // This is important for well-known DOs (orchestrators) that get reused.
    this.ctx.storage.sql.exec('DELETE FROM messages');
    this.ctx.storage.sql.exec('DELETE FROM prompt_queue');
    this.ctx.storage.sql.exec('DELETE FROM audit_log');
    this.ctx.storage.sql.exec('DELETE FROM channel_followups');

    // Store session state in durable SQLite
    this.setStateValue('sessionId', body.sessionId);
    this.setStateValue('userId', body.userId);
    this.setStateValue('workspace', body.workspace);
    this.setStateValue('runnerToken', body.runnerToken);
    this.setStateValue('status', 'initializing');
    this.setStateValue('runnerBusy', 'false');

    // Clear stale state from previous lifecycle
    this.setStateValue('sandboxId', '');
    this.setStateValue('tunnelUrls', '');
    this.setStateValue('tunnels', '');
    this.setStateValue('runningStartedAt', '');
    this.setStateValue('initialModel', '');
    this.setStateValue('initialPrompt', '');

    if (body.sandboxId) {
      this.setStateValue('sandboxId', body.sandboxId);
    }
    if (body.tunnelUrls) {
      this.setStateValue('tunnelUrls', JSON.stringify(body.tunnelUrls));
    }
    if (body.terminateUrl) {
      this.setStateValue('terminateUrl', body.terminateUrl);
    }
    if (body.hibernateUrl) {
      this.setStateValue('hibernateUrl', body.hibernateUrl);
    }
    if (body.restoreUrl) {
      this.setStateValue('restoreUrl', body.restoreUrl);
    }
    if (body.idleTimeoutMs) {
      this.setStateValue('idleTimeoutMs', String(body.idleTimeoutMs));
    }
    if (body.backendUrl) {
      this.setStateValue('backendUrl', body.backendUrl);
    }
    if (body.spawnRequest) {
      this.setStateValue('spawnRequest', JSON.stringify(body.spawnRequest));
    }
    if (body.initialPrompt) {
      this.setStateValue('initialPrompt', body.initialPrompt);
    }
    if (body.initialModel) {
      this.setStateValue('initialModel', body.initialModel);
    }

    // Initialize queue mode (Phase D)
    this.setStateValue('queueMode', (body as any).queueMode || 'followup');
    this.setStateValue('collectDebounceMs', String((body as any).collectDebounceMs || 3000));

    // Channel follow-up reminder interval (default: 5 minutes)
    if ((body as any).channelFollowupIntervalMs) {
      this.setStateValue('channelFollowupIntervalMs', String((body as any).channelFollowupIntervalMs));
    }

    // Initialize idle tracking
    this.setStateValue('lastUserActivityAt', String(Date.now()));

    // If sandbox info was provided directly, we're already running
    if (body.sandboxId && body.tunnelUrls) {
      this.setStateValue('status', 'running');
      this.markRunningStarted();
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
      this.ctx.waitUntil(this.spawnSandbox(body.backendUrl, body.terminateUrl!, body.spawnRequest));
    }

    // Publish session.started to EventBus
    this.notifyEventBus({
      type: 'session.started',
      sessionId: body.sessionId,
      userId: body.userId,
      data: { workspace: body.workspace, sandboxId: body.sandboxId },
      timestamp: new Date().toISOString(),
    });

    this.appendAuditLog('session.started', `Session started for ${body.workspace}`, body.userId);
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
    terminateUrl: string,
    spawnRequest: Record<string, unknown>,
  ): Promise<void> {
    const sessionId = this.getStateValue('sessionId');
    try {
      const response = await fetch(backendUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(spawnRequest),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Backend returned ${response.status}: ${err}`);
      }

      const result = await response.json() as {
        sandboxId: string;
        tunnelUrls: Record<string, string>;
      };

      // Store sandbox info
      this.setStateValue('sandboxId', result.sandboxId);
      this.setStateValue('tunnelUrls', JSON.stringify(result.tunnelUrls));
      this.setStateValue('status', 'running');
      this.markRunningStarted();

      // Sync status to D1 so sessions list shows correct status
      updateSessionStatus(this.appDb, sessionId!, 'running', result.sandboxId).catch((err) =>
        console.error('[SessionAgentDO] Failed to sync status to D1:', err),
      );

      // Notify connected clients that sandbox is ready
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
      this.setStateValue('status', 'error');
      if (sessionId) {
        updateSessionStatus(this.appDb, sessionId, 'error', undefined, errorText).catch((e) =>
          console.error('[SessionAgentDO] Failed to sync error status to D1:', e),
        );
      }
      // Persist error as a system message so it's visible on reconnect
      const errId = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        'INSERT INTO messages (id, role, content) VALUES (?, ?, ?)',
        errId, 'system', `Error: ${errorText}`
      );
      this.broadcastToClients({
        type: 'status',
        data: { status: 'error' },
      });
      this.broadcastToClients({
        type: 'error',
        messageId: errId,
        error: errorText,
      });

      // Publish session.errored to EventBus
      this.notifyEventBus({
        type: 'session.errored',
        sessionId: sessionId || undefined,
        userId: this.getStateValue('userId') || undefined,
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
    const sandboxId = this.getStateValue('sandboxId');
    const sessionId = this.getStateValue('sessionId');
    const terminateUrl = this.getStateValue('terminateUrl');
    const currentStatus = this.getStateValue('status');

    // Idempotency: if already terminated, skip all side-effects
    if (currentStatus === 'terminated') {
      console.log(`[SessionAgentDO] handleStop(${reason}) skipped — already terminated`);
      return Response.json({ success: true, status: 'terminated', alreadyTerminated: true });
    }

    // Flush active time, metrics, and messages to D1 before termination
    if (currentStatus === 'running') {
      await this.flushActiveSeconds();
      this.clearRunningStarted();
    }
    await this.flushMetrics();
    await this.flushMessagesToD1();

    // Tell runner to stop
    this.sendToRunner({ type: 'stop' });

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
      if (sandboxId && terminateUrl) {
        try {
          await fetch(terminateUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ sandboxId }),
          });
        } catch (err) {
          console.error('Failed to terminate sandbox:', err);
        }
      }
    }

    // Clear idle alarm
    this.ctx.storage.deleteAlarm();

    // Update state
    this.setStateValue('status', 'terminated');
    this.setStateValue('sandboxId', '');
    this.setStateValue('tunnelUrls', '');
    this.setStateValue('tunnels', '');
    this.setStateValue('snapshotImageId', '');
    this.setStateValue('runnerBusy', 'false');
    this.ctx.storage.sql.exec('DELETE FROM prompt_queue');

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

    this.appendAuditLog('session.terminated', 'Session terminated');

    // Publish session.completed to EventBus
    this.notifyEventBus({
      type: 'session.completed',
      sessionId: sessionId || undefined,
      userId: this.getStateValue('userId') || undefined,
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

    await this.notifyParentEvent(`Child session event: ${sessionId} completed (reason: ${reason}).`, { wake: true });

    return Response.json({
      success: true,
      status: 'terminated',
      sandboxId,
      sessionId,
    });
  }

  private async handleStatus(): Promise<Response> {
    const status = this.getStateValue('status') || 'idle';
    const sandboxId = this.getStateValue('sandboxId');
    const sessionId = this.getStateValue('sessionId');
    const userId = this.getStateValue('userId');
    const workspace = this.getStateValue('workspace');
    const tunnelUrls = this.getStateValue('tunnelUrls');
    const tunnelsRaw = this.getStateValue('tunnels');
    const runnerBusy = this.getStateValue('runnerBusy') === 'true';

    const messageCount = this.ctx.storage.sql
      .exec('SELECT COUNT(*) as count FROM messages')
      .toArray()[0]?.count ?? 0;

    const queueLength = this.getQueueLength();
    const clientCount = this.getClientSockets().length;
    const runnerConnected = this.ctx.getWebSockets('runner').length > 0;
    const connectedUsers = this.getConnectedUserIds();
    const runningStartedAt = this.getStateValue('runningStartedAt');

    let tunnelUrlsParsed: Record<string, string> | null = null;
    if (tunnelUrls) {
      try {
        tunnelUrlsParsed = JSON.parse(tunnelUrls);
      } catch {
        tunnelUrlsParsed = null;
      }
    }

    let tunnelsParsed: Array<{ name: string; port: number; protocol?: string; path: string; url?: string }> | null = null;
    if (tunnelsRaw) {
      try {
        tunnelsParsed = JSON.parse(tunnelsRaw);
      } catch {
        tunnelsParsed = null;
      }
    }
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
      runningStartedAt: runningStartedAt ? parseInt(runningStartedAt) : null,
    });
  }

  private notifyParentIfIdle() {
    const sessionId = this.getStateValue('sessionId');
    if (!sessionId) return;
    const status = this.getStateValue('status');
    if (status !== 'running') return;
    const runnerBusy = this.getStateValue('runnerBusy') === 'true';
    const queued = this.getQueueLength();
    if (runnerBusy || queued > 0) return;

    const last = this.getStateValue('lastParentIdleNotice');
    if (last === 'true') return;
    const existing = this.getStateValue('parentIdleNotifyAt');
    if (existing) return; // debounce already pending
    this.setStateValue('parentIdleNotifyAt', String(Date.now() + PARENT_IDLE_DEBOUNCE_MS));
    this.rescheduleIdleAlarm();
  }

  private async notifyParentEvent(content: string, options?: { wake?: boolean }) {
    try {
      const sessionId = this.getStateValue('sessionId');
      if (!sessionId) return;
      const session = await getSession(this.appDb, sessionId);
      const parentSessionId = session?.parentSessionId;
      if (!parentSessionId) return;
      const childTitle = session?.title || session?.workspace || `Child ${sessionId.slice(0, 8)}`;
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
          },
          wake: options?.wake ?? true,
        }),
      }));
    } catch (err) {
      console.error('[SessionAgentDO] Failed to notify parent session:', err);
    }
  }

  private async handleSystemMessage(content: string, parts?: Record<string, unknown>, wake?: boolean) {
    const messageId = crypto.randomUUID();
    const serializedParts = parts ? JSON.stringify(parts) : null;

    if (serializedParts) {
      this.ctx.storage.sql.exec(
        'INSERT INTO messages (id, role, content, parts) VALUES (?, ?, ?, ?)',
        messageId, 'system', content, serializedParts
      );
    } else {
      this.ctx.storage.sql.exec(
        'INSERT INTO messages (id, role, content) VALUES (?, ?, ?)',
        messageId, 'system', content
      );
    }

    this.broadcastToClients({
      type: 'message',
      data: {
        id: messageId,
        role: 'system',
        content,
        parts: parts || undefined,
        createdAt: Math.floor(Date.now() / 1000),
      },
    });

    if (wake) {
      const status = this.getStateValue('status');
      if (status === 'hibernated') {
        // Queue the prompt so the runner picks it up after connecting.
        // performWake() does NOT dequeue — upgradeRunner() does when the runner connects.
        this.ctx.storage.sql.exec(
          "INSERT INTO prompt_queue (id, content, status) VALUES (?, ?, 'queued')",
          messageId, content
        );
        this.ctx.waitUntil(this.performWake());
      } else if (status === 'restoring') {
        // Wake already in progress — just queue the prompt for when the runner connects.
        this.ctx.storage.sql.exec(
          "INSERT INTO prompt_queue (id, content, status) VALUES (?, ?, 'queued')",
          messageId, content
        );
      } else if (status === 'running') {
        // Dispatch the system event as a prompt so the runner wakes up and can
        // decide whether to act on it (e.g. child session idle/completed events).
        const runnerBusy = this.getStateValue('runnerBusy') === 'true';
        const runnerSockets = this.ctx.getWebSockets('runner');
        if (runnerSockets.length > 0 && !runnerBusy) {
          // Runner is connected and idle — insert as 'processing' for recoverability, then dispatch
          this.ctx.storage.sql.exec(
            "INSERT INTO prompt_queue (id, content, status) VALUES (?, ?, 'processing')",
            messageId, content
          );
          this.setStateValue('runnerBusy', 'true');
          this.setStateValue('lastPromptDispatchedAt', String(Date.now()));
          this.setStateValue('lastParentIdleNotice', '');
          this.setStateValue('parentIdleNotifyAt', '');
          const ownerId = this.getStateValue('userId');
          const ownerDetails = ownerId ? await this.getUserDetails(ownerId) : undefined;
          const sysModelPrefs = await this.resolveModelPreferences(ownerDetails);
          const sysChannelKey = this.channelKeyFrom(undefined, undefined);
          const sysOcSessionId = this.getChannelOcSessionId(sysChannelKey);
          const sysDispatched = this.sendToRunner({
            type: 'prompt',
            messageId,
            content,
            opencodeSessionId: sysOcSessionId,
            modelPreferences: sysModelPrefs,
          });
          if (!sysDispatched) {
            this.ctx.storage.sql.exec("UPDATE prompt_queue SET status = 'queued' WHERE id = ?", messageId);
            this.setStateValue('runnerBusy', 'false');
            this.setStateValue('lastPromptDispatchedAt', '');
            this.appendAuditLog('prompt.dispatch_failed', `System prompt dispatch failed, reverted: ${messageId.slice(0, 8)}`);
          }
          this.rescheduleIdleAlarm();
        } else {
          // Runner busy or not connected — queue the prompt
          this.ctx.storage.sql.exec(
            "INSERT INTO prompt_queue (id, content, status) VALUES (?, ?, 'queued')",
            messageId, content
          );
        }
      }
    }
  }

  private async handleWorkflowExecuteDispatch(
    executionIdRaw?: string,
    payload?: WorkflowExecutionDispatchPayload,
  ): Promise<Response> {
    const executionId = (executionIdRaw || '').trim();
    if (!executionId) {
      return Response.json({ error: 'executionId is required' }, { status: 400 });
    }
    if (!payload || typeof payload !== 'object') {
      return Response.json({ error: 'payload is required' }, { status: 400 });
    }
    if (payload.kind !== 'run' && payload.kind !== 'resume') {
      return Response.json({ error: 'payload.kind must be run or resume' }, { status: 400 });
    }
    if (typeof payload.executionId !== 'string' || payload.executionId !== executionId) {
      return Response.json({ error: 'payload.executionId must match executionId' }, { status: 400 });
    }
    if (!payload.payload || typeof payload.payload !== 'object' || Array.isArray(payload.payload)) {
      return Response.json({ error: 'payload.payload must be an object' }, { status: 400 });
    }

    const status = this.getStateValue('status');
    const queueWorkflowDispatch = (reason: string) => {
      const queueId = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        "INSERT INTO prompt_queue (id, content, queue_type, workflow_execution_id, workflow_payload, status) VALUES (?, '', 'workflow_execute', ?, ?, 'queued')",
        queueId,
        executionId,
        JSON.stringify(payload),
      );
      this.appendAuditLog(
        'workflow.dispatch_queued',
        `Workflow execution queued (${executionId.slice(0, 8)}): ${reason}`,
        undefined,
        { executionId, kind: payload.kind, reason },
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

    const runnerSockets = this.ctx.getWebSockets('runner');
    if (runnerSockets.length === 0) {
      return queueWorkflowDispatch('runner_not_connected');
    }

    const runnerBusy = this.getStateValue('runnerBusy') === 'true';
    if (runnerBusy) {
      return queueWorkflowDispatch('runner_busy');
    }

    this.setStateValue('lastUserActivityAt', String(Date.now()));
    this.setStateValue('runnerBusy', 'true');
    this.setStateValue('lastPromptDispatchedAt', String(Date.now()));
    this.rescheduleIdleAlarm();
    this.setStateValue('lastParentIdleNotice', '');
    this.setStateValue('parentIdleNotifyAt', '');
    const dispatchOwnerId = this.getStateValue('userId');
    const dispatchOwnerDetails = dispatchOwnerId ? await this.getUserDetails(dispatchOwnerId) : undefined;
    const dispatchModelPrefs = await this.resolveModelPreferences(dispatchOwnerDetails);

    const directWfDispatched = this.sendToRunner({
      type: 'workflow-execute',
      executionId,
      payload,
      modelPreferences: dispatchModelPrefs,
    });
    if (!directWfDispatched) {
      this.setStateValue('runnerBusy', 'false');
      return queueWorkflowDispatch('runner_send_failed');
    }

    this.appendAuditLog(
      'workflow.dispatch',
      `Workflow execution dispatched (${executionId.slice(0, 8)})`,
      undefined,
      { executionId, kind: payload.kind },
    );

    return Response.json({ success: true });
  }

  private async sendNextQueuedPrompt(): Promise<boolean> {
    const runnerSockets = this.ctx.getWebSockets('runner');
    if (runnerSockets.length === 0) {
      console.log(`[SessionAgentDO] sendNextQueuedPrompt: no runner sockets, skipping`);
      return false;
    }

    const next = this.ctx.storage.sql
      .exec("SELECT id, content, attachments, model, author_id, author_email, author_name, channel_type, channel_id, queue_type, workflow_execution_id, workflow_payload, thread_id, continuation_context, context_prefix, reply_channel_type, reply_channel_id FROM prompt_queue WHERE status = 'queued' ORDER BY created_at ASC LIMIT 1")
      .toArray();

    if (next.length === 0) {
      console.log(`[SessionAgentDO] sendNextQueuedPrompt: no queued items`);
      return false;
    }
    console.log(`[SessionAgentDO] sendNextQueuedPrompt: found queued item id=${next[0].id} channelType=${next[0].channel_type || 'none'} channelId=${next[0].channel_id || 'none'} queueType=${next[0].queue_type || 'prompt'}`);

    const prompt = next[0];
    this.ctx.storage.sql.exec(
      "UPDATE prompt_queue SET status = 'processing' WHERE id = ?",
      prompt.id as string
    );

    const queueType = ((prompt.queue_type as string) || 'prompt').trim() || 'prompt';
    if (queueType === 'workflow_execute') {
      const queuedExecutionId = ((prompt.workflow_execution_id as string) || '').trim();
      const queuedPayload = parseQueuedWorkflowPayload(prompt.workflow_payload);
      if (!queuedExecutionId || !queuedPayload) {
        this.ctx.storage.sql.exec(
          "UPDATE prompt_queue SET status = 'completed' WHERE id = ?",
          prompt.id as string
        );
        console.warn(`[SessionAgentDO] Dropping malformed queued workflow dispatch id=${String(prompt.id)}`);
        return this.sendNextQueuedPrompt();
      }

      this.pendingChannelReply = null;
      this.setStateValue('runnerBusy', 'true');
      this.setStateValue('lastPromptDispatchedAt', String(Date.now()));
      this.setStateValue('lastParentIdleNotice', '');
      this.setStateValue('parentIdleNotifyAt', '');
      const queueOwnerId = this.getStateValue('userId');
      const queueOwnerDetails = queueOwnerId ? await this.getUserDetails(queueOwnerId) : undefined;
      const queueModelPrefs = await this.resolveModelPreferences(queueOwnerDetails);
      const wfDispatched = this.sendToRunner({
        type: 'workflow-execute',
        executionId: queuedExecutionId,
        payload: queuedPayload,
        modelPreferences: queueModelPrefs,
      });
      if (!wfDispatched) {
        this.ctx.storage.sql.exec("UPDATE prompt_queue SET status = 'queued' WHERE id = ?", prompt.id as string);
        this.setStateValue('runnerBusy', 'false');
        this.appendAuditLog('workflow.dispatch_failed', `Workflow dispatch failed, reverted to queue: ${queuedExecutionId.slice(0, 8)}`);
        return false;
      }
      this.broadcastToClients({
        type: 'status',
        data: { promptDequeued: true, remaining: this.getQueueLength() },
      });
      this.appendAuditLog(
        'workflow.dispatch',
        `Workflow execution dispatched (${queuedExecutionId.slice(0, 8)})`,
        undefined,
        { executionId: queuedExecutionId, kind: queuedPayload.kind, queued: true },
      );
      return true;
    }

    // Look up git details from cache for the prompt author
    const authorId = prompt.author_id as string | null;
    const authorDetails = authorId ? this.userDetailsCache.get(authorId) : undefined;
    const attachments = parseQueuedPromptAttachments(prompt.attachments);

    // Track current prompt author for PR attribution
    if (authorId) {
      this.setStateValue('currentPromptAuthorId', authorId);
    }

    // Track channel context for auto-reply on completion using the ORIGINAL channel
    // (e.g., slack:C123:thread_ts), not the normalized thread routing key.
    const queueChannelType = (prompt.channel_type as string) || undefined;
    const queueChannelId = (prompt.channel_id as string) || undefined;
    // Only use reply_channel columns if they exist — do NOT fall back to the
    // normalized channel_type ('thread') which always fails requiresExplicitChannelReply.
    const queueReplyChannelType = (prompt.reply_channel_type as string) || undefined;
    const queueReplyChannelId = (prompt.reply_channel_id as string) || undefined;
    if (queueReplyChannelType && queueReplyChannelId && this.requiresExplicitChannelReply(queueReplyChannelType)) {
      this.pendingChannelReply = { channelType: queueReplyChannelType, channelId: queueReplyChannelId, resultContent: null, resultMessageId: null, handled: false };

      // Record a follow-up reminder so the agent gets nudged if it doesn't send a substantive reply
      this.insertChannelFollowup(queueReplyChannelType, queueReplyChannelId, prompt.content as string);
    } else {
      this.pendingChannelReply = null;
    }

    // Resolve model preferences from session owner (with org fallback)
    const queueOwnerId = this.getStateValue('userId');
    const queueOwnerDetails = queueOwnerId ? await this.getUserDetails(queueOwnerId) : undefined;
    const queueModelPrefs = await this.resolveModelPreferences(queueOwnerDetails);
    const queueChannelKey = this.channelKeyFrom(queueChannelType, queueChannelId);
    const queueOcSessionId = this.getChannelOcSessionId(queueChannelKey);
    const queueThreadId = (prompt.thread_id as string) || undefined;
    const queueContinuationContext = (prompt.continuation_context as string) || undefined;
    const queueContextPrefix = (prompt.context_prefix as string) || undefined;

    // Agent sees contextPrefix + content; stored messages only have the user's actual message
    const queueAgentContent = queueContextPrefix
      ? `${queueContextPrefix}\n\n${prompt.content as string}`
      : prompt.content as string;

    const queueDispatched = this.sendToRunner({
      type: 'prompt',
      messageId: prompt.id as string,
      content: queueAgentContent,
      model: (prompt.model as string) || undefined,
      attachments: attachments.length > 0 ? attachments : undefined,
      channelType: queueChannelType,
      channelId: queueChannelId,
      threadId: queueThreadId,
      // Pass original channel info so the Runner can build the [via ...] prefix
      replyChannelType: queueReplyChannelType !== queueChannelType ? queueReplyChannelType : undefined,
      replyChannelId: queueReplyChannelId !== queueChannelId ? queueReplyChannelId : undefined,
      authorId: authorId || undefined,
      authorEmail: (prompt.author_email as string) || undefined,
      authorName: (prompt.author_name as string) || undefined,
      gitName: authorDetails?.gitName,
      gitEmail: authorDetails?.gitEmail,
      opencodeSessionId: queueOcSessionId,
      modelPreferences: queueModelPrefs,
      continuationContext: queueContinuationContext,
    });
    if (!queueDispatched) {
      this.ctx.storage.sql.exec("UPDATE prompt_queue SET status = 'queued' WHERE id = ?", prompt.id as string);
      this.pendingChannelReply = null;
      this.appendAuditLog('prompt.dispatch_failed', `Queue dispatch failed, reverted: ${(prompt.id as string).slice(0, 8)}`);
      return false;
    }
    this.setStateValue('runnerBusy', 'true');
    this.setStateValue('lastPromptDispatchedAt', String(Date.now()));
    this.setStateValue('lastParentIdleNotice', '');
    this.setStateValue('parentIdleNotifyAt', '');
    this.rescheduleIdleAlarm();
    this.broadcastToClients({
      type: 'status',
      data: { promptDequeued: true, remaining: this.getQueueLength() },
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
    const sessionId = this.getStateValue('sessionId') || '';

    const columns = 'id, role, content, parts, author_id, author_email, author_name, author_avatar_url, channel_type, channel_id, thread_id, message_format, created_at';

    let query: string;
    const params: (string | number)[] = [];

    if (after) {
      // Pagination: get messages after a cursor, oldest-first
      query = `SELECT ${columns} FROM messages WHERE created_at > ? ORDER BY created_at ASC LIMIT ?`;
      params.push(after, limit);
    } else {
      // All messages in chronological order (default limit high enough for full history)
      query = `SELECT ${columns} FROM messages ORDER BY created_at ASC LIMIT ?`;
      params.push(limit);
    }

    const rows = this.ctx.storage.sql
      .exec(query, ...params)
      .toArray();

    const messages = rows.map((r) => ({
      id: r.id as string,
      sessionId,
      role: r.role as string,
      content: r.content as string,
      parts: r.parts ? JSON.parse(r.parts as string) : undefined,
      authorId: r.author_id || undefined,
      authorEmail: r.author_email || undefined,
      authorName: r.author_name || undefined,
      authorAvatarUrl: r.author_avatar_url || undefined,
      channelType: r.channel_type || undefined,
      channelId: r.channel_id || undefined,
      threadId: r.thread_id || undefined,
      createdAt: new Date((r.created_at as number) * 1000).toISOString(),
    }));

    return Response.json({ messages });
  }


  private async handleClearQueue(): Promise<Response> {
    const cleared = this.getQueueLength();
    this.ctx.storage.sql.exec("DELETE FROM prompt_queue WHERE status = 'queued'");

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
    const tunnelUrlsRaw = this.getStateValue('tunnelUrls');
    if (!tunnelUrlsRaw) {
      return Response.json({ error: 'Sandbox not running' }, { status: 503 });
    }

    const tunnelUrls = JSON.parse(tunnelUrlsRaw);
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

  // ─── GitHub API Helpers ──────────────────────────────────────────────

  /**
   * Get a decrypted GitHub access token for the session.
   * Fallback chain:
   *   1. Active prompt author's GitHub token (if they have one connected)
   *   2. Session creator's GitHub token
   *   3. null (no token available)
   */
  private async getGitHubToken(): Promise<string | null> {
    // Try the current prompt author first (for multiplayer attribution)
    const promptAuthorId = this.getStateValue('currentPromptAuthorId');
    if (promptAuthorId) {
      const authorResult = await getCredential(this.env, 'user', promptAuthorId, 'github', { credentialType: 'oauth2' });
      if (authorResult.ok) {
        return authorResult.credential.accessToken;
      }
    }

    // Fall back to session creator
    const userId = this.getStateValue('userId');
    if (!userId) return null;

    const result = await getCredential(this.env, 'user', userId, 'github', { credentialType: 'oauth2' });
    if (!result.ok) return null;

    return result.credential.accessToken;
  }

  /**
   * Extract owner/repo from a GitHub URL (https or git@ format).
   * Returns null if not a GitHub URL.
   */
  private extractOwnerRepo(repoUrl: string): { owner: string; repo: string } | null {
    const match = repoUrl.match(/github\.com[/:]([^/]+)\/([^/.]+)/);
    if (!match) return null;
    return { owner: match[1], repo: match[2] };
  }

  private async resolveOwnerRepo(owner?: string, repo?: string): Promise<{ owner: string; repo: string }> {
    if (owner && repo) {
      return { owner, repo };
    }

    const sessionId = this.getStateValue('sessionId');
    const gitState = sessionId ? await getSessionGitState(this.appDb, sessionId) : null;
    const repoUrl = gitState?.sourceRepoUrl;
    if (!repoUrl) {
      throw new Error('No repository URL found for this session');
    }

    const ownerRepo = this.extractOwnerRepo(repoUrl);
    if (!ownerRepo) {
      throw new Error(`Cannot extract owner/repo from URL: ${repoUrl}`);
    }

    return ownerRepo;
  }

  // ─── PR Creation ──────────────────────────────────────────────────────

  private async handleCreatePR(msg: { requestId?: string; branch: string; title: string; body?: string; base?: string }) {
    const sessionId = this.getStateValue('sessionId');
    const requestId = msg.requestId;

    // Notify clients that PR creation is in progress
    this.broadcastToClients({
      type: 'status',
      data: { prCreating: true, branch: msg.branch },
    });

    try {
      const githubToken = await this.getGitHubToken();
      if (!githubToken) {
        throw new Error('No GitHub token found — user must connect GitHub in settings');
      }

      // Get repo URL from git state
      const gitState = sessionId ? await getSessionGitState(this.appDb, sessionId) : null;
      const repoUrl = gitState?.sourceRepoUrl;
      if (!repoUrl) {
        throw new Error('No repository URL found for this session');
      }

      const ownerRepo = this.extractOwnerRepo(repoUrl);
      if (!ownerRepo) {
        throw new Error(`Cannot extract owner/repo from URL: ${repoUrl}`);
      }

      // Determine base branch
      let baseBranch = msg.base;
      if (!baseBranch) {
        // Fetch default branch from GitHub API
        const repoResp = await fetch(`https://api.github.com/repos/${ownerRepo.owner}/${ownerRepo.repo}`, {
          headers: {
            'Authorization': `Bearer ${githubToken}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'valet',
          },
        });
        if (repoResp.ok) {
          const repoData = await repoResp.json() as { default_branch: string };
          baseBranch = repoData.default_branch;
        } else {
          baseBranch = 'main'; // fallback
        }
      }

      // Create PR via GitHub API
      const createResp = await fetch(`https://api.github.com/repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${githubToken}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'valet',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          title: msg.title,
          body: msg.body || '',
          head: msg.branch,
          base: baseBranch,
        }),
      });

      if (!createResp.ok) {
        const errBody = await createResp.text();
        throw new Error(`GitHub API returned ${createResp.status}: ${errBody}`);
      }

      const prData = await createResp.json() as { number: number; html_url: string; title: string; state: string };

      // Update D1 git state with PR info
      if (sessionId) {
        updateSessionGitState(this.appDb, sessionId, {
          branch: msg.branch,
          baseBranch,
          prNumber: prData.number,
          prTitle: prData.title,
          prUrl: prData.html_url,
          prState: prData.state as any,
          prCreatedAt: new Date().toISOString(),
        }).catch((err) =>
          console.error('[SessionAgentDO] Failed to update git state after PR creation:', err),
        );
      }

      // Broadcast PR created to clients
      this.broadcastToClients({
        type: 'pr-created',
        data: {
          number: prData.number,
          title: prData.title,
          url: prData.html_url,
          state: prData.state,
        },
      } as any);

      // Send result back to runner
      if (requestId) {
        this.sendToRunner({
          type: 'create-pr-result',
          requestId,
          number: prData.number,
          url: prData.html_url,
          title: prData.title,
          state: prData.state,
        });
      }

      console.log(`[SessionAgentDO] PR #${prData.number} created: ${prData.html_url}`);
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      console.error('[SessionAgentDO] Failed to create PR:', errorText);

      // Send error result back to runner
      if (requestId) {
        this.sendToRunner({
          type: 'create-pr-result',
          requestId,
          error: errorText,
        });
      }

      // Broadcast failure to clients
      this.broadcastToClients({
        type: 'status',
        data: { prCreating: false, prError: errorText },
      });
    }
  }

  // ─── PR Update ────────────────────────────────────────────────────────

  private async handleUpdatePR(msg: { requestId?: string; prNumber: number; title?: string; body?: string; state?: string; labels?: string[] }) {
    const sessionId = this.getStateValue('sessionId');
    const requestId = msg.requestId;

    try {
      const githubToken = await this.getGitHubToken();
      if (!githubToken) {
        throw new Error('No GitHub token found — user must connect GitHub in settings');
      }

      // Get repo URL from git state
      const gitState = sessionId ? await getSessionGitState(this.appDb, sessionId) : null;
      const repoUrl = gitState?.sourceRepoUrl;
      if (!repoUrl) {
        throw new Error('No repository URL found for this session');
      }

      const ownerRepo = this.extractOwnerRepo(repoUrl);
      if (!ownerRepo) {
        throw new Error(`Cannot extract owner/repo from URL: ${repoUrl}`);
      }

      // Update PR via GitHub API
      const updateBody: Record<string, unknown> = {};
      if (msg.title !== undefined) updateBody.title = msg.title;
      if (msg.body !== undefined) updateBody.body = msg.body;
      if (msg.state !== undefined) updateBody.state = msg.state;

      const patchResp = await fetch(`https://api.github.com/repos/${ownerRepo.owner}/${ownerRepo.repo}/pulls/${msg.prNumber}`, {
        method: 'PATCH',
        headers: {
          'Authorization': `Bearer ${githubToken}`,
          'Accept': 'application/vnd.github+json',
          'User-Agent': 'valet',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(updateBody),
      });

      if (!patchResp.ok) {
        const errBody = await patchResp.text();
        throw new Error(`GitHub API returned ${patchResp.status}: ${errBody}`);
      }

      const prData = await patchResp.json() as { number: number; html_url: string; title: string; state: string };

      // If labels were provided, set them via issues API
      if (msg.labels && msg.labels.length > 0) {
        await fetch(`https://api.github.com/repos/${ownerRepo.owner}/${ownerRepo.repo}/issues/${msg.prNumber}/labels`, {
          method: 'PUT',
          headers: {
            'Authorization': `Bearer ${githubToken}`,
            'Accept': 'application/vnd.github+json',
            'User-Agent': 'valet',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ labels: msg.labels }),
        }).catch((err) =>
          console.error('[SessionAgentDO] Failed to set labels:', err),
        );
      }

      // Update D1 git state
      if (sessionId) {
        const gitUpdates: Record<string, unknown> = {
          prTitle: prData.title,
          prState: prData.state,
        };
        updateSessionGitState(this.appDb, sessionId, gitUpdates as any).catch((err) =>
          console.error('[SessionAgentDO] Failed to update git state after PR update:', err),
        );
      }

      // Broadcast update to clients
      this.broadcastToClients({
        type: 'pr-created',
        data: {
          number: prData.number,
          title: prData.title,
          url: prData.html_url,
          state: prData.state,
        },
      } as any);

      // Send result back to runner
      if (requestId) {
        this.sendToRunner({
          type: 'update-pr-result',
          requestId,
          number: prData.number,
          url: prData.html_url,
          title: prData.title,
          state: prData.state,
        });
      }

      console.log(`[SessionAgentDO] PR #${prData.number} updated: ${prData.html_url}`);
    } catch (err) {
      const errorText = err instanceof Error ? err.message : String(err);
      console.error('[SessionAgentDO] Failed to update PR:', errorText);

      if (requestId) {
        this.sendToRunner({
          type: 'update-pr-result',
          requestId,
          error: errorText,
        });
      }
    }
  }

  // ─── Hibernate / Wake ──────────────────────────────────────────────────

  private async handleHibernate(): Promise<Response> {
    const status = this.getStateValue('status');

    if (status === 'hibernated' || status === 'hibernating') {
      return Response.json({ status, message: 'Already hibernated or hibernating' });
    }

    if (status !== 'running') {
      return Response.json({ status, message: 'Can only hibernate a running session' });
    }

    this.ctx.waitUntil(this.performHibernate());
    return Response.json({ status: 'hibernating', message: 'Hibernate initiated' });
  }

  private async handleWake(): Promise<Response> {
    const status = this.getStateValue('status');

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
    const sessionId = this.getStateValue('sessionId');
    const sandboxId = this.getStateValue('sandboxId');
    const hibernateUrl = this.getStateValue('hibernateUrl');

    if (!sandboxId || !hibernateUrl) {
      console.error('[SessionAgentDO] Cannot hibernate: missing sandboxId or hibernateUrl');
      return;
    }

    try {
      // Flush active time and metrics to D1 before hibernate
      await this.flushActiveSeconds();
      this.clearRunningStarted();
      await this.flushMetrics();

      // Set status to hibernating
      this.setStateValue('status', 'hibernating');
      this.broadcastToClients({
        type: 'status',
        data: { status: 'hibernating' },
      });
      if (sessionId) {
        updateSessionStatus(this.appDb, sessionId, 'hibernating').catch((e) =>
          console.error('[SessionAgentDO] Failed to sync hibernating status to D1:', e),
        );
      }

      // Call Modal backend to snapshot filesystem FIRST (while sandbox is still alive),
      // then terminate. We must NOT stop the runner before snapshotting — stopping the
      // runner causes the sandbox process to exit, making snapshot_filesystem fail with
      // "Sandbox has already finished".
      const response = await fetch(hibernateUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sandboxId }),
      });

      if (response.status === 409) {
        // Sandbox already exited (idle timeout) — can't snapshot, treat as stopped.
        // TODO: Setting status to 'terminated' here bypasses handleStop(), so parent
        // notification, child cascade, and audit logging are all skipped. Consider
        // calling handleStop() instead, or using an 'error' status to distinguish
        // infrastructure-caused termination from intentional stops.
        console.log(`[SessionAgentDO] Session ${sessionId} sandbox already finished, marking as terminated`);
        this.sendToRunner({ type: 'stop' });
        const runnerSockets409 = this.ctx.getWebSockets('runner');
        for (const ws of runnerSockets409) {
          try { ws.close(1000, 'Sandbox already exited'); } catch { /* ignore */ }
        }
        this.setStateValue('sandboxId', '');
        this.setStateValue('tunnelUrls', '');
        this.setStateValue('tunnels', '');
        this.setStateValue('runnerBusy', 'false');
        this.setStateValue('status', 'terminated');
        this.broadcastToClients({
          type: 'status',
          data: { status: 'terminated', sandboxRunning: false },
        });
        if (sessionId) {
          updateSessionStatus(this.appDb, sessionId, 'terminated').catch((e) =>
            console.error('[SessionAgentDO] Failed to sync terminated status to D1:', e),
          );
        }
        return;
      }

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Backend returned ${response.status}: ${err}`);
      }

      const result = await response.json() as { snapshotImageId: string };

      // Now that snapshot is taken and sandbox terminated, stop runner and close connections
      this.sendToRunner({ type: 'stop' });
      const runnerSockets = this.ctx.getWebSockets('runner');
      for (const ws of runnerSockets) {
        try { ws.close(1000, 'Session hibernating'); } catch { /* ignore */ }
      }

      // Store snapshot info and clear sandbox info
      this.setStateValue('snapshotImageId', result.snapshotImageId);
      this.setStateValue('sandboxId', '');
      this.setStateValue('tunnelUrls', '');
      this.setStateValue('tunnels', '');
      this.setStateValue('runnerBusy', 'false');
      this.setStateValue('status', 'hibernated');

      this.broadcastToClients({
        type: 'status',
        data: { status: 'hibernated', sandboxRunning: false },
      });

      if (sessionId) {
        updateSessionStatus(this.appDb, sessionId, 'hibernated').catch((e) =>
          console.error('[SessionAgentDO] Failed to sync hibernated status to D1:', e),
        );
      }

      this.appendAuditLog('session.hibernated', 'Session hibernated');
      console.log(`[SessionAgentDO] Session ${sessionId} hibernated, snapshot: ${result.snapshotImageId}`);

      // Revert any in-flight prompts (don't rely on webSocketClose timing)
      this.ctx.storage.sql.exec(
        "UPDATE prompt_queue SET status = 'queued' WHERE status = 'processing'"
      );

      // If prompts were queued during the hibernation transition (e.g. scheduled
      // tasks arriving while we were snapshotting), auto-wake to process them.
      const queuedDuringHibernate = this.getQueueLength();
      if (queuedDuringHibernate > 0) {
        console.log(
          `[SessionAgentDO] ${queuedDuringHibernate} prompt(s) queued during hibernation — auto-waking`
        );
        this.ctx.waitUntil(this.performWake());
      }
    } catch (err) {
      console.error(`[SessionAgentDO] Failed to hibernate session ${sessionId}:`, err);
      const errorText = `Failed to hibernate: ${err instanceof Error ? err.message : String(err)}`;
      this.setStateValue('status', 'error');
      if (sessionId) {
        updateSessionStatus(this.appDb, sessionId, 'error', undefined, errorText).catch((e) =>
          console.error('[SessionAgentDO] Failed to sync error status to D1:', e),
        );
      }
      // Persist error as a system message
      const errId = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        'INSERT INTO messages (id, role, content) VALUES (?, ?, ?)',
        errId, 'system', `Error: ${errorText}`
      );
      this.broadcastToClients({
        type: 'status',
        data: { status: 'error' },
      });
      this.broadcastToClients({
        type: 'error',
        messageId: errId,
        error: errorText,
      });
    }
  }

  private async performWake(): Promise<void> {
    // Guard against concurrent wake calls (e.g. two prompts arriving while hibernated)
    const currentStatus = this.getStateValue('status');
    if (currentStatus === 'restoring' || currentStatus === 'running') {
      console.log(`[SessionAgentDO] performWake skipped — already ${currentStatus}`);
      return;
    }

    const sessionId = this.getStateValue('sessionId');
    const snapshotImageId = this.getStateValue('snapshotImageId');
    const restoreUrl = this.getStateValue('restoreUrl');
    const spawnRequestStr = this.getStateValue('spawnRequest');

    if (!snapshotImageId || !restoreUrl || !spawnRequestStr) {
      const errorText = 'Cannot wake: missing snapshotImageId, restoreUrl, or spawnRequest';
      console.error(`[SessionAgentDO] ${errorText}`);
      this.setStateValue('status', 'error');
      if (sessionId) {
        updateSessionStatus(this.appDb, sessionId, 'error', undefined, errorText).catch((e) =>
          console.error('[SessionAgentDO] Failed to sync error status to D1:', e),
        );
      }
      this.broadcastToClients({ type: 'status', data: { status: 'error' } });
      this.broadcastToClients({ type: 'error', error: errorText });
      return;
    }

    try {
      this.setStateValue('status', 'restoring');
      this.broadcastToClients({
        type: 'status',
        data: { status: 'restoring' },
      });
      if (sessionId) {
        updateSessionStatus(this.appDb, sessionId, 'restoring').catch((e) =>
          console.error('[SessionAgentDO] Failed to sync restoring status to D1:', e),
        );
      }

      const spawnRequest = JSON.parse(spawnRequestStr);

      const response = await fetch(restoreUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...spawnRequest,
          snapshotImageId,
        }),
      });

      if (!response.ok) {
        const err = await response.text();
        throw new Error(`Backend returned ${response.status}: ${err}`);
      }

      const result = await response.json() as {
        sandboxId: string;
        tunnelUrls: Record<string, string>;
      };

      // Update state with new sandbox info
      this.setStateValue('sandboxId', result.sandboxId);
      this.setStateValue('tunnelUrls', JSON.stringify(result.tunnelUrls));
      this.setStateValue('snapshotImageId', '');
      this.setStateValue('status', 'running');
      this.markRunningStarted();
      this.setStateValue('lastUserActivityAt', String(Date.now()));

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

      this.appendAuditLog('session.restored', 'Session restored from hibernation');
      console.log(`[SessionAgentDO] Session ${sessionId} restored, new sandbox: ${result.sandboxId}`);
    } catch (err) {
      console.error(`[SessionAgentDO] Failed to restore session ${sessionId}:`, err);
      const errorText = `Failed to restore session: ${err instanceof Error ? err.message : String(err)}`;
      this.setStateValue('status', 'error');
      if (sessionId) {
        updateSessionStatus(this.appDb, sessionId, 'error', undefined, errorText).catch((e) =>
          console.error('[SessionAgentDO] Failed to sync error status to D1:', e),
        );
      }
      // Persist error as a system message
      const errId = crypto.randomUUID();
      this.ctx.storage.sql.exec(
        'INSERT INTO messages (id, role, content) VALUES (?, ?, ?)',
        errId, 'system', `Error: ${errorText}`
      );
      this.broadcastToClients({
        type: 'status',
        data: { status: 'error' },
      });
      this.broadcastToClients({
        type: 'error',
        messageId: errId,
        error: errorText,
      });
    }
  }

  /**
   * Schedule the idle alarm based on the configured idle timeout.
   * Called after any user activity and after sandbox transitions to running.
   */
  private rescheduleIdleAlarm(): void {
    // Start with a far-future default; idle timeout narrows it if configured
    let earliestAlarm = Infinity;

    const idleTimeoutMsStr = this.getStateValue('idleTimeoutMs');
    if (idleTimeoutMsStr) {
      const idleTimeoutMs = parseInt(idleTimeoutMsStr);
      if (!isNaN(idleTimeoutMs) && idleTimeoutMs > 0) {
        earliestAlarm = Date.now() + idleTimeoutMs;
      }
    }

    // Consider pending interactive prompt expiry — use the earliest time
    const nextExpiry = this.ctx.storage.sql
      .exec(
        "SELECT MIN(expires_at) as next FROM interactive_prompts WHERE status = 'pending' AND expires_at IS NOT NULL"
      )
      .toArray();
    if (nextExpiry.length > 0 && nextExpiry[0].next) {
      const promptExpiryMs = (nextExpiry[0].next as number) * 1000;
      if (promptExpiryMs < earliestAlarm) {
        earliestAlarm = promptExpiryMs;
      }
    }

    // Also consider pending channel followup reminders
    const nextFollowup = this.ctx.storage.sql
      .exec("SELECT MIN(next_reminder_at) as next FROM channel_followups WHERE status = 'pending'")
      .toArray();
    if (nextFollowup.length > 0 && nextFollowup[0].next) {
      const followupMs = nextFollowup[0].next as number;
      if (followupMs < earliestAlarm) {
        earliestAlarm = followupMs;
      }
    }

    // Also consider stuck-processing watchdog deadline
    const dispatchStr = this.getStateValue('lastPromptDispatchedAt');
    if (dispatchStr) {
      const dispatchMs = parseInt(dispatchStr);
      if (!isNaN(dispatchMs)) {
        const watchdogMs = dispatchMs + 5 * 60 * 1000; // 5 min timeout
        if (watchdogMs < earliestAlarm) {
          earliestAlarm = watchdogMs;
        }
      }
    }

    // Also consider error safety-net deadline
    const safetyNetStr = this.getStateValue('errorSafetyNetAt');
    if (safetyNetStr) {
      const safetyNetMs = parseInt(safetyNetStr);
      if (!isNaN(safetyNetMs) && safetyNetMs < earliestAlarm) {
        earliestAlarm = safetyNetMs;
      }
    }

    // Also consider parent idle debounce deadline
    const parentIdleStr = this.getStateValue('parentIdleNotifyAt');
    if (parentIdleStr) {
      const parentIdleMs = parseInt(parentIdleStr);
      if (!isNaN(parentIdleMs) && parentIdleMs < earliestAlarm) {
        earliestAlarm = parentIdleMs;
      }
    }

    // Only set alarm if we have at least one deadline
    if (earliestAlarm < Infinity) {
      this.ctx.storage.setAlarm(earliestAlarm);
    }
  }

  // ─── Hibernation Recovery Helpers ──────────────────────────────────────

  /**
   * Recover an active turn from the SQLite placeholder row inserted by message.create.
   * Returns the recovered turn (also re-added to activeTurns), or undefined if not found.
   */
  private recoverTurnFromSQLite(turnId: string): { text: string; parts: Array<{ type: string; [key: string]: unknown }>; channelType?: string; channelId?: string; opencodeSessionId?: string } | undefined {
    const rows = this.ctx.storage.sql
      .exec(
        "SELECT content, parts, channel_type, channel_id, opencode_session_id FROM messages WHERE id = ? AND role = 'assistant' AND message_format = 'v2'",
        turnId
      )
      .toArray();
    if (rows.length === 0) return undefined;

    const row = rows[0];
    let recoveredParts: Array<{ type: string; [key: string]: unknown }> = [];
    try {
      if (row.parts && typeof row.parts === 'string') {
        recoveredParts = JSON.parse(row.parts);
      }
    } catch { /* corrupted parts — start fresh */ }
    const turn = {
      text: (row.content as string) || '',
      parts: recoveredParts,
      channelType: (row.channel_type as string) || undefined,
      channelId: (row.channel_id as string) || undefined,
      opencodeSessionId: (row.opencode_session_id as string) || undefined,
    };
    this.activeTurns.set(turnId, turn);
    console.log(`[SessionAgentDO] Recovering turn ${turnId} from SQLite after hibernation (${recoveredParts.length} parts, ${turn.text.length} chars)`);
    return turn;
  }

  /**
   * Recover pendingChannelReply from the processing prompt_queue row.
   * Used when in-memory pendingChannelReply is lost due to DO hibernation.
   */
  private recoverPendingChannelReply(): { channelType: string; channelId: string; resultContent: string | null; resultMessageId: string | null; handled: boolean } | null {
    const rows = this.ctx.storage.sql
      .exec("SELECT channel_type, channel_id, reply_channel_type, reply_channel_id FROM prompt_queue WHERE status = 'processing' LIMIT 1")
      .toArray();
    if (rows.length === 0) return null;

    // Prefer reply channel (original Slack channel) over normalized thread channel
    const channelType = (rows[0].reply_channel_type as string) || (rows[0].channel_type as string) || null;
    const channelId = (rows[0].reply_channel_id as string) || (rows[0].channel_id as string) || null;
    if (!channelType || !channelId) return null;

    const recovered = {
      channelType,
      channelId,
      resultContent: null as string | null,
      resultMessageId: null as string | null,
      handled: false,
    };
    this.pendingChannelReply = recovered;
    console.log(`[SessionAgentDO] Recovered pendingChannelReply from prompt_queue: ${recovered.channelType}:${recovered.channelId}`);
    return recovered;
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private getStateValue(key: string): string | undefined {
    const rows = this.ctx.storage.sql
      .exec('SELECT value FROM state WHERE key = ?', key)
      .toArray();
    return rows.length > 0 ? (rows[0].value as string) : undefined;
  }

  private setStateValue(key: string, value: string): void {
    this.ctx.storage.sql.exec(
      'INSERT OR REPLACE INTO state (key, value) VALUES (?, ?)',
      key, value
    );
  }

  private getQueueLength(): number {
    const result = this.ctx.storage.sql
      .exec("SELECT COUNT(*) as count FROM prompt_queue WHERE status = 'queued'")
      .toArray();
    return (result[0]?.count as number) ?? 0;
  }

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
    const toUserId = this.getStateValue('userId');
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
        fromSessionId: this.getStateValue('sessionId') || undefined,
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
   * Record that the sandbox just entered the 'running' state.
   * Stores a timestamp so we can later compute elapsed active seconds.
   */
  private markRunningStarted(): void {
    this.setStateValue('runningStartedAt', String(Date.now()));
  }

  /**
   * Flush accumulated active seconds to D1.
   * Called when leaving the 'running' state (hibernate, terminate, error).
   * Also called periodically from flushMetrics to avoid losing time if the DO restarts.
   */
  private async flushActiveSeconds(): Promise<void> {
    const sessionId = this.getStateValue('sessionId');
    const startStr = this.getStateValue('runningStartedAt');
    if (!sessionId || !startStr) return;

    const startMs = parseInt(startStr);
    if (isNaN(startMs)) return;

    const elapsedSeconds = Math.floor((Date.now() - startMs) / 1000);
    if (elapsedSeconds > 0) {
      try {
        await addActiveSeconds(this.appDb, sessionId, elapsedSeconds);
      } catch (err) {
        console.error('[SessionAgentDO] Failed to flush active seconds:', err);
      }
    }
    // Reset the start marker to now so we don't double-count on next flush
    this.setStateValue('runningStartedAt', String(Date.now()));
  }

  /**
   * Clear the running start marker (when leaving running state permanently).
   */
  private clearRunningStarted(): void {
    this.setStateValue('runningStartedAt', '');
  }

  /**
   * Flush message/tool-call counts from local SQLite to D1.
   * Called at lifecycle boundaries (stop, hibernate, alarm) and after each agent turn.
   */
  private async flushMetrics(): Promise<void> {
    const sessionId = this.getStateValue('sessionId');
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

      // Also flush active seconds if currently running
      const status = this.getStateValue('status');
      if (status === 'running') {
        await this.flushActiveSeconds();
      }

      // Flush unflushed audit log entries to D1
      const unflushed = this.ctx.storage.sql
        .exec('SELECT id, event_type, summary, actor_id, metadata, created_at FROM audit_log WHERE flushed = 0 ORDER BY id ASC LIMIT 50')
        .toArray();

      if (unflushed.length > 0) {
        try {
          await batchInsertAuditLog(this.env.DB, sessionId, unflushed.map((row) => ({
            localId: row.id as number,
            eventType: row.event_type as string,
            summary: row.summary as string,
            actorId: (row.actor_id as string) || null,
            metadata: (row.metadata as string) || null,
            createdAt: row.created_at as string,
          })));
          // Mark as flushed
          const flushedIds = unflushed.map((r) => r.id as number);
          const placeholders = flushedIds.map(() => '?').join(',');
          this.ctx.storage.sql.exec(
            `UPDATE audit_log SET flushed = 1 WHERE id IN (${placeholders})`,
            ...flushedIds,
          );
        } catch (flushErr) {
          console.error('[SessionAgentDO] Failed to flush audit log to D1:', flushErr);
        }
      }

      // Flush unflushed usage events to D1
      const unflushedUsage = this.ctx.storage.sql
        .exec('SELECT id, turn_id, oc_message_id, model, input_tokens, output_tokens, created_at FROM usage_events WHERE flushed = 0 ORDER BY id ASC LIMIT 100')
        .toArray();

      if (unflushedUsage.length > 0) {
        try {
          await batchInsertUsageEvents(this.env.DB, sessionId, unflushedUsage.map((row) => ({
            localId: row.id as number,
            turnId: row.turn_id as string,
            ocMessageId: row.oc_message_id as string,
            model: row.model as string,
            inputTokens: row.input_tokens as number,
            outputTokens: row.output_tokens as number,
            createdAt: row.created_at as number,
          })));
          const flushedUsageIds = unflushedUsage.map((r) => r.id as number);
          const usagePlaceholders = flushedUsageIds.map(() => '?').join(',');
          this.ctx.storage.sql.exec(
            `UPDATE usage_events SET flushed = 1 WHERE id IN (${usagePlaceholders})`,
            ...flushedUsageIds,
          );
        } catch (flushErr) {
          console.error('[SessionAgentDO] Failed to flush usage events to D1:', flushErr);
        }
      }
    } catch (err) {
      console.error('[SessionAgentDO] Failed to flush metrics:', err);
    }
  }

  private appendAuditLog(
    eventType: string,
    summary: string,
    actorId?: string,
    metadata?: Record<string, unknown>,
  ): void {
    const metadataJson = metadata ? JSON.stringify(metadata) : null;
    this.ctx.storage.sql.exec(
      'INSERT INTO audit_log (event_type, summary, actor_id, metadata) VALUES (?, ?, ?, ?)',
      eventType, summary, actorId || null, metadataJson,
    );
    // Broadcast to connected clients in real-time
    this.broadcastToClients({
      type: 'audit_log',
      entry: {
        eventType,
        summary,
        actorId: actorId || undefined,
        metadata: metadata || undefined,
        createdAt: new Date().toISOString(),
      },
    });
  }

  private async handleTunnelDelete(
    name: string,
    actor?: { actorId?: string; actorName?: string; actorEmail?: string },
  ) {
    if (!name) return;

    this.sendToRunner({
      type: 'tunnel-delete',
      name,
      actorId: actor?.actorId,
      actorName: actor?.actorName,
      actorEmail: actor?.actorEmail,
    });

    const who = actor?.actorName || actor?.actorEmail || actor?.actorId || 'User';
    const summary = `${who} disabled tunnel "${name}"`;
    this.appendAuditLog('tunnel.disabled', summary, actor?.actorId, { name });
    await this.handleSystemMessage(summary, { type: 'tunnel.disabled', name });
  }

  // ─── Phase C: Mailbox + Task Board Handlers ─────────────────────────

  private async handleMailboxSend(requestId: string, msg: RunnerMessage) {
    try {
      const sessionId = this.getStateValue('sessionId');
      const userId = this.getStateValue('userId');

      // Resolve @handle to userId if provided
      let toUserId = msg.toUserId;
      if (msg.toHandle && !toUserId && !msg.toSessionId) {
        const identity = await getOrchestratorIdentityByHandle(this.appDb, msg.toHandle);
        if (!identity) {
          this.sendToRunner({ type: 'mailbox-send-result', requestId, error: `Handle @${msg.toHandle} not found` } as any);
          return;
        }
        toUserId = identity.userId;
      }

      const message = await createMailboxMessage(this.appDb, {
        fromSessionId: sessionId || undefined,
        fromUserId: userId || undefined,
        toSessionId: msg.toSessionId,
        toUserId,
        messageType: msg.messageType,
        content: msg.content!,
        contextSessionId: msg.contextSessionId,
        contextTaskId: msg.contextTaskId,
        replyToId: msg.replyToId,
      });

      this.sendToRunner({ type: 'mailbox-send-result', requestId, messageId: message.id } as any);
    } catch (err) {
      this.sendToRunner({ type: 'mailbox-send-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private async handleMailboxCheck(requestId: string, limit?: number, after?: string) {
    try {
      const sessionId = this.getStateValue('sessionId');
      if (!sessionId) {
        this.sendToRunner({ type: 'mailbox-check-result', requestId, error: 'No session ID' } as any);
        return;
      }

      const messages = await getSessionMailbox(this.env.DB, sessionId, {
        unreadOnly: true,
        limit,
        after,
      });

      // Auto-mark as read
      if (messages.length > 0) {
        await markSessionMailboxRead(this.appDb, sessionId);
      }

      this.sendToRunner({ type: 'mailbox-check-result', requestId, messages } as any);
    } catch (err) {
      this.sendToRunner({ type: 'mailbox-check-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private async handleTaskCreate(requestId: string, msg: RunnerMessage) {
    try {
      const sessionId = this.getStateValue('sessionId');
      if (!sessionId) {
        this.sendToRunner({ type: 'task-create-result', requestId, error: 'No session ID' } as any);
        return;
      }

      // Determine orchestrator session ID: own session for orchestrators,
      // or look up parent for child sessions
      let orchestratorSessionId = sessionId;
      const session = await getSession(this.appDb, sessionId);
      if (session?.parentSessionId) {
        orchestratorSessionId = session.parentSessionId;
      }

      const task = await createSessionTask(this.appDb, {
        orchestratorSessionId,
        sessionId: msg.sessionId,
        title: msg.title!,
        description: msg.description,
        parentTaskId: msg.parentTaskId,
        blockedBy: msg.blockedBy,
      });

      this.sendToRunner({ type: 'task-create-result', requestId, task } as any);
    } catch (err) {
      this.sendToRunner({ type: 'task-create-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private async handleTaskList(requestId: string, status?: string, limit?: number) {
    try {
      const sessionId = this.getStateValue('sessionId');
      if (!sessionId) {
        this.sendToRunner({ type: 'task-list-result', requestId, error: 'No session ID' } as any);
        return;
      }

      let orchestratorSessionId = sessionId;
      const session = await getSession(this.appDb, sessionId);
      if (session?.parentSessionId) {
        orchestratorSessionId = session.parentSessionId;
      }

      const tasks = await getSessionTasks(this.env.DB, orchestratorSessionId, { status, limit });
      this.sendToRunner({ type: 'task-list-result', requestId, tasks } as any);
    } catch (err) {
      this.sendToRunner({ type: 'task-list-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private async handleTaskUpdate(requestId: string, taskId: string, msg: RunnerMessage) {
    try {
      const task = await updateSessionTask(this.env.DB, taskId, {
        status: msg.status as string | undefined,
        result: msg.result as string | undefined,
        description: msg.description,
        sessionId: msg.sessionId,
        title: msg.title,
      });

      if (!task) {
        this.sendToRunner({ type: 'task-update-result', requestId, error: 'Task not found' } as any);
        return;
      }

      this.sendToRunner({ type: 'task-update-result', requestId, task } as any);
    } catch (err) {
      this.sendToRunner({ type: 'task-update-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  private async handleTaskMy(requestId: string, status?: string) {
    try {
      const sessionId = this.getStateValue('sessionId');
      if (!sessionId) {
        this.sendToRunner({ type: 'task-my-result', requestId, error: 'No session ID' } as any);
        return;
      }

      const tasks = await getMyTasks(this.env.DB, sessionId, { status });
      this.sendToRunner({ type: 'task-my-result', requestId, tasks } as any);
    } catch (err) {
      this.sendToRunner({ type: 'task-my-result', requestId, error: err instanceof Error ? err.message : String(err) } as any);
    }
  }

  // ─── Phase D: Channel Reply Handler ──────────────────────────────────

  /**
   * Parse composite Slack channelId that may encode thread_ts after a colon.
   * e.g. "C123ABC:1234567890.123456" → { channelId: "C123ABC", threadId: "1234567890.123456" }
   */
  private parseSlackChannelId(channelType: string, channelId: string): { channelId: string; threadId?: string } {
    if (channelType === 'slack' && channelId.includes(':')) {
      const idx = channelId.indexOf(':');
      return { channelId: channelId.slice(0, idx), threadId: channelId.slice(idx + 1) };
    }
    return { channelId };
  }

  private async handleChannelReply(requestId: string, channelType: string, channelId: string, message: string, imageBase64?: string, imageMimeType?: string, followUp?: boolean) {
    try {
      const userId = this.getStateValue('userId');
      if (!userId) {
        this.sendToRunner({ type: 'channel-reply-result', requestId, error: 'No userId on session' } as any);
        return;
      }

      const transport = channelRegistry.getTransport(channelType);
      if (!transport) {
        this.sendToRunner({ type: 'channel-reply-result', requestId, error: `Unsupported channel type: ${channelType}` } as any);
        return;
      }

      // Resolve token: Slack uses org-level bot token, other channels use per-user credentials
      let token: string | undefined;
      if (channelType === 'slack') {
        token = await getSlackBotToken(this.env) ?? undefined;
      } else {
        const credResult = await getCredential(this.env, 'user', userId, channelType);
        if (credResult.ok) token = credResult.credential.accessToken;
      }
      if (!token) {
        this.sendToRunner({ type: 'channel-reply-result', requestId, error: `No ${channelType} config for user` } as any);
        return;
      }

      // Parse composite channelId (Slack encodes threadId after colon)
      const parsed = this.parseSlackChannelId(channelType, channelId);
      const target: ChannelTarget = { channelType, channelId: parsed.channelId, threadId: parsed.threadId };
      const ctx: ChannelContext = { token, userId };

      // Build outbound message
      const outbound: import('@valet/sdk').OutboundMessage = imageBase64
        ? {
            markdown: message || undefined,
            attachments: [{
              type: 'image' as const,
              url: `data:${imageMimeType || 'image/jpeg'};base64,${imageBase64}`,
              mimeType: imageMimeType || 'image/jpeg',
              caption: message || undefined,
            }],
          }
        : { markdown: message };

      // Add persona identity for Slack messages
      if (channelType === 'slack' && userId) {
        outbound.platformOptions = { ...outbound.platformOptions, ...(await this.getSlackPersonaOptions(userId)) };
      }

      const result = await transport.sendMessage(target, outbound, ctx);
      if (!result.success) {
        this.sendToRunner({ type: 'channel-reply-result', requestId, error: result.error || `${channelType} API error` } as any);
        return;
      }

      // Mark auto-reply as handled so we don't double-send on complete
      if (this.pendingChannelReply
        && this.pendingChannelReply.channelType === channelType
        && this.pendingChannelReply.channelId === channelId) {
        this.pendingChannelReply.handled = true;
      }

      // Resolve follow-up reminder if this is a substantive reply (followUp !== false)
      if (followUp !== false) {
        this.resolveChannelFollowups(channelType, channelId);
      }

      this.sendToRunner({ type: 'channel-reply-result', requestId, success: true } as any);

      // Explicitly clear the shimmer "thinking" indicator for Slack
      if (channelType === 'slack') {
        const slackTransport = transport as import('@valet/plugin-slack/channels').SlackTransport;
        if (slackTransport.setThreadStatus) {
          const parsed = this.parseSlackChannelId(channelType, channelId);
          if (parsed.threadId) {
            slackTransport.setThreadStatus(
              { channelType: 'slack', channelId: parsed.channelId, threadId: parsed.threadId },
              '',
              ctx,
            ).catch(err => console.warn('[SessionAgentDO] Failed to clear shimmer:', err));
          }
        }
      }

      // Store image as a system message for web UI visibility
      if (imageBase64) {
        const msgId = crypto.randomUUID();
        const channelLabel = `Sent image to ${channelType}`;
        this.ctx.storage.sql.exec(
          'INSERT INTO messages (id, role, content, parts, channel_type, channel_id) VALUES (?, ?, ?, ?, ?, ?)',
          msgId, 'system', message || channelLabel,
          JSON.stringify({ type: 'image', data: imageBase64, mimeType: imageMimeType || 'image/jpeg' }),
          channelType, channelId,
        );
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
      this.sendToRunner({
        type: 'channel-reply-result',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      } as any);
    }
  }

  // ─── Tool Discovery & Invocation ──────────────────────────────────────

  private async handleListTools(requestId: string, service?: string, query?: string) {
    try {
      const userId = this.getStateValue('userId');
      if (!userId) {
        this.sendToRunner({ type: 'list-tools-result', requestId, error: 'No userId on session' } as any);
        return;
      }

      // Fetch integrations, auto-enabled services, and disabled-actions index in parallel
      const [userIntegrations, orgIntegrations, autoServices, { disabledActions: disabledActionSet, disabledServices: disabledServiceSet }] =
        await Promise.all([
          getUserIntegrations(this.appDb, userId),
          getOrgIntegrations(this.appDb),
          getAutoEnabledServices(this.env.DB),
          getDisabledActionsIndex(this.appDb),
        ]);

      const allIntegrations = [
        ...userIntegrations.filter((i) => i.status === 'active'),
        ...orgIntegrations.filter((i) => i.status === 'active'),
      ];

      console.log(`[SessionAgentDO] list-tools: userId=${userId}, service=${service ?? 'all'}, active integrations: [${allIntegrations.map((i) => `${i.service}(${i.status})`).join(', ')}]`);

      // Deduplicate by service (user-scoped takes precedence)
      const seen = new Set<string>();
      const dedupedIntegrations = allIntegrations.filter((i) => {
        if (seen.has(i.service)) return false;
        seen.add(i.service);
        return true;
      });

      // Inject synthetic integrations for plugins that don't require auth
      for (const svc of autoServices) {
        if (!seen.has(svc)) {
          dedupedIntegrations.push({ id: `auto:${svc}`, service: svc, status: 'active' } as any);
          seen.add(svc);
        }
      }

      const tools: unknown[] = [];
      const warnings: Array<{ service: string; displayName: string; reason: string; message: string; integrationId: string }> = [];
      const mcpCacheEntries: Array<{ service: string; actionId: string; name: string; description: string; riskLevel: string }> = [];

      for (const integration of dedupedIntegrations) {
        // If filtering by service, skip non-matching integrations
        if (service && integration.service !== service) continue;

        // Skip entirely disabled services
        if (disabledServiceSet.has(integration.service)) continue;

        const actionSource = integrationRegistry.getActions(integration.service);
        if (!actionSource) {
          console.warn(`[SessionAgentDO] list-tools: no action source for ${integration.service}`);
          continue;
        }

        // Resolve credentials for this integration to pass to listActions (needed by MCP-backed sources)
        // No-auth services (e.g. DeepWiki) skip credential lookup entirely.
        const provider = integrationRegistry.getProvider(integration.service);
        let credCtx: { credentials: { access_token: string } } | undefined;
        const isOrgScopedIntegration = 'scope' in integration && integration.scope === 'org';
        if (provider?.authType === 'none') {
          // No credentials needed — pass undefined context
          console.log(`[SessionAgentDO] list-tools: ${integration.service} is no-auth, skipping credential lookup`);
        } else {
          const credentialUserId = (isOrgScopedIntegration && 'userId' in integration)
            ? (integration as { userId: string }).userId
            : userId;
          const scope = isOrgScopedIntegration ? 'org' as const : 'user' as const;

          // Check credential cache first
          let credResult = this.getCachedCredential('user', credentialUserId, integration.service);
          if (!credResult) {
            credResult = await integrationRegistry.resolveCredentials(integration.service, this.env, credentialUserId, scope);
            // If the initial credential fetch fails with a refreshable reason, try force-refresh
            if (!credResult.ok && (credResult.error.reason === 'expired' || credResult.error.reason === 'refresh_failed')) {
              console.log(`[SessionAgentDO] list-tools: ${integration.service} credential ${credResult.error.reason}, attempting force-refresh`);
              credResult = await integrationRegistry.resolveCredentials(integration.service, this.env, credentialUserId, scope, { forceRefresh: true });
            }
            // Only cache successful results — failure states (not_found, revoked) are
            // transient and should be re-checked so newly connected integrations work immediately.
            if (credResult.ok) {
              this.setCachedCredential('user', credentialUserId, integration.service, credResult);
            }
          }

          if (!credResult.ok) {
            const displayName = provider?.displayName || integration.service;
            console.warn(`[SessionAgentDO] list-tools: credential failure for ${integration.service}: ${credResult.error.reason} — ${credResult.error.message}`);
            warnings.push({
              service: integration.service,
              displayName,
              reason: credResult.error.reason,
              message: credResult.error.message,
              integrationId: integration.id,
            });
            continue;
          } else {
            console.log(`[SessionAgentDO] list-tools: credentials OK for ${integration.service} (type=${credResult.credential.credentialType}, refreshed=${credResult.credential.refreshed}, hasToken=${!!credResult.credential.accessToken})`);
            credCtx = { credentials: { access_token: credResult.credential.accessToken } };
          }
        }

        let actions = await actionSource.listActions(credCtx);

        // If no actions returned and we have credentials, the token may be silently expired
        // (MCP listTools returns [] on auth failure). Try force-refreshing the credential.
        if (actions.length === 0 && credCtx && provider?.authType !== 'none') {
          const credentialUserId = ('scope' in integration && integration.scope === 'org' && 'userId' in integration)
            ? (integration as { userId: string }).userId
            : userId;
          this.invalidateCachedCredential('user', credentialUserId, integration.service);
          const refreshed = await integrationRegistry.resolveCredentials(integration.service, this.env, credentialUserId, isOrgScopedIntegration ? 'org' : 'user', { forceRefresh: true });
          if (refreshed.ok && refreshed.credential.refreshed) {
            console.log(`[SessionAgentDO] list-tools: ${integration.service} returned 0 actions, retrying with force-refreshed token`);
            this.setCachedCredential('user', credentialUserId, integration.service, refreshed);
            credCtx = { credentials: { access_token: refreshed.credential.accessToken } };
            actions = await actionSource.listActions(credCtx);
          }
        }

        console.log(`[SessionAgentDO] list-tools: ${integration.service} returned ${actions.length} actions`);

        // Cache ALL discovered tools for the catalog/policy UI, before any filtering
        for (const action of actions) {
          const compositeId = `${integration.service}:${action.id}`;
          this.discoveredToolRiskLevels.set(compositeId, action.riskLevel);
          mcpCacheEntries.push({
            service: integration.service,
            actionId: action.id,
            name: action.name,
            description: action.description,
            riskLevel: action.riskLevel,
          });
        }

        for (const action of actions) {
          // If query provided, filter by case-insensitive substring match on name/description/service
          if (query) {
            const lowerQuery = query.toLowerCase();
            const matchesName = action.name.toLowerCase().includes(lowerQuery);
            const matchesDesc = action.description.toLowerCase().includes(lowerQuery);
            const matchesService = integration.service.toLowerCase().includes(lowerQuery);
            if (!matchesName && !matchesDesc && !matchesService) continue;
          }

          const compositeId = `${integration.service}:${action.id}`;

          // Skip individually disabled actions
          if (disabledActionSet.has(compositeId)) continue;

          tools.push({
            id: compositeId,
            name: action.name,
            description: action.description,
            riskLevel: action.riskLevel,
            params: action.inputSchema || this.serializeZodSchema(action.params),
          });
        }
      }

      // Fire-and-forget: persist discovered tools to D1 cache for the catalog endpoint.
      // This allows MCP tools to appear in the policy editor UI even without live credentials.
      if (mcpCacheEntries.length > 0) {
        upsertMcpToolCache(this.appDb, mcpCacheEntries).catch((err) => {
          console.warn('[SessionAgentDO] mcp tool cache upsert failed:', err instanceof Error ? err.message : String(err));
        });
      }

      this.sendToRunner({
        type: 'list-tools-result',
        requestId,
        tools,
        ...(warnings.length > 0 ? {
          warnings: warnings.map(({ integrationId: _, ...rest }) => rest),
        } : {}),
      } as any);

      // Broadcast reauth-required event to connected frontend clients
      if (warnings.length > 0) {
        this.broadcastToClients({
          type: 'integration-auth-required',
          services: warnings.map((w) => ({
            service: w.service,
            displayName: w.displayName,
            reason: w.reason,
          })),
        });

        // Fire-and-forget: mark integrations as 'error' in D1 only for definitive failures
        // (not transient ones like refresh_failed which may succeed on retry)
        const definitiveFailures = warnings.filter((w) => w.reason === 'revoked' || w.reason === 'not_found');
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
      this.sendToRunner({
        type: 'list-tools-result',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      } as any);
    }
  }

  private async handleCallTool(requestId: string, toolId: string, params: Record<string, unknown>) {
    try {
      const userId = this.getStateValue('userId');
      const sessionId = this.getStateValue('sessionId');
      if (!userId) {
        this.sendToRunner({ type: 'call-tool-result', requestId, error: 'No userId on session' } as any);
        return;
      }

      // Parse toolId: "service:actionId"
      const colonIndex = toolId.indexOf(':');
      if (colonIndex === -1) {
        this.sendToRunner({ type: 'call-tool-result', requestId, error: `Invalid tool ID format "${toolId}". Expected "service:actionId" (e.g. "gmail:gmail.send_email")` } as any);
        return;
      }
      const service = toolId.slice(0, colonIndex);
      const actionId = toolId.slice(colonIndex + 1);

      // Safety net: reject disabled actions even if the tool ID was guessed
      if (await isActionDisabled(this.appDb, service, actionId)) {
        this.sendToRunner({ type: 'call-tool-result', requestId, error: `Action "${toolId}" is disabled by your organization.` } as any);
        return;
      }

      // Verify user or org has this integration active
      const userIntegrations = await getUserIntegrations(this.appDb, userId);
      let activeIntegration = userIntegrations.find(
        (i) => i.service === service && i.status === 'active',
      );

      // Fall back to org-scoped integrations
      let isOrgScoped = false;
      if (!activeIntegration) {
        const orgIntegrations = await getOrgIntegrations(this.appDb);
        const orgMatch = orgIntegrations.find(
          (i) => i.service === service && i.status === 'active',
        );
        if (orgMatch) {
          activeIntegration = { ...orgMatch, userId: '', scope: 'org' as const, updatedAt: orgMatch.createdAt } as any;
          isOrgScoped = true;
        }
      }

      // Fall back to auto-enabled plugins (no auth required)
      if (!activeIntegration) {
        const autoServices = await getAutoEnabledServices(this.env.DB);
        if (autoServices.includes(service)) {
          activeIntegration = { id: `auto:${service}`, service, status: 'active' } as any;
        }
      }

      if (!activeIntegration) {
        this.sendToRunner({ type: 'call-tool-result', requestId, error: `Integration "${service}" is not active. Configure it in Settings > Integrations.` } as any);
        return;
      }

      // Look up ActionSource
      const actionSource = integrationRegistry.getActions(service);
      if (!actionSource) {
        this.sendToRunner({ type: 'call-tool-result', requestId, error: `No integration package found for service "${service}".` } as any);
        return;
      }

      // ─── Policy Resolution ─────────────────────────────────────────────
      // Use cached risk level from handleListTools if available (avoids MCP round-trip).
      // Fall back to listActions only if the cache misses (e.g. tool was never listed).
      const cachedRisk = this.discoveredToolRiskLevels.get(toolId);
      let riskLevel: string;
      if (cachedRisk) {
        riskLevel = cachedRisk;
      } else {
        // Resolve list context for policy fallback — skip credential lookup for no-auth services
        const fallbackProvider = integrationRegistry.getProvider(service);
        let listCtx: { credentials: { access_token: string } } | undefined;
        if (fallbackProvider?.authType !== 'none') {
          let listCredResult = this.getCachedCredential('user', userId, service)
            || await integrationRegistry.resolveCredentials(service, this.env, userId, isOrgScoped ? 'org' : 'user');
          if (listCredResult.ok) {
            this.setCachedCredential('user', userId, service, listCredResult);
          }
          listCtx = listCredResult.ok
            ? { credentials: { access_token: listCredResult.credential.accessToken } }
            : undefined;
        }
        const actionDef = (await actionSource.listActions(listCtx)).find(a => a.id === actionId);
        riskLevel = actionDef?.riskLevel || 'medium';
      }

      // Resolve policy mode
      const invocationResult = await invokeAction(this.appDb, {
        sessionId: sessionId || '',
        userId,
        service,
        actionId,
        riskLevel,
        params,
      });

      // ─── Deny ──────────────────────────────────────────────────────────
      if (invocationResult.outcome === 'denied') {
        this.sendToRunner({ type: 'call-tool-result', requestId, error: `Action "${toolId}" denied by policy (risk level: ${riskLevel})` } as any);
        this.appendAuditLog('agent.tool_call', `Action ${toolId} denied by policy`, undefined, { invocationId: invocationResult.invocationId, riskLevel });
        return;
      }

      // ─── Require Approval ──────────────────────────────────────────────
      if (invocationResult.outcome === 'pending_approval') {
        const expiresAt = Math.floor(Date.now() / 1000) + Math.floor(ACTION_APPROVAL_EXPIRY_MS / 1000);

        const approvalContext: Record<string, unknown> = {
          toolId,
          service,
          actionId,
          params,
          riskLevel,
          isOrgScoped,
          invocationId: invocationResult.invocationId,
        };
        const approvalCh = this.activeChannel;
        if (approvalCh) {
          approvalContext.channelType = approvalCh.channelType;
          approvalContext.channelId = approvalCh.channelId;
        }

        // Build body with params preview
        let approvalBody = `\`${toolId}\` (risk: **${riskLevel}**)`;
        if (params && Object.keys(params).length > 0) {
          let paramsJson = JSON.stringify(params, null, 2);
          if (paramsJson.length > 500) paramsJson = paramsJson.slice(0, 497) + '...';
          approvalBody += `\n\`\`\`\n${paramsJson}\n\`\`\``;
        }

        // Store in interactive_prompts for alarm-based expiry and later execution
        this.ctx.storage.sql.exec(
          `INSERT OR REPLACE INTO interactive_prompts
            (id, type, request_id, title, body, actions, context, status, expires_at)
           VALUES (?, 'approval', ?, ?, ?, ?, ?, 'pending', ?)`,
          invocationResult.invocationId,
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
        this.sendToRunner({
          type: 'call-tool-pending',
          requestId,
          invocationId: invocationResult.invocationId,
          message: `Action "${toolId}" requires approval (risk level: ${riskLevel}). Waiting for human review.`,
        } as any);

        const prompt: InteractivePrompt = {
          id: invocationResult.invocationId,
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
            invocationId: invocationResult.invocationId,
            toolId,
            service,
            actionId,
            riskLevel,
          },
          timestamp: new Date().toISOString(),
        });

        this.appendAuditLog('agent.tool_call', `Action ${toolId} requires approval (${riskLevel})`, undefined, { invocationId: invocationResult.invocationId, riskLevel });

        // Fire-and-forget: send interactive prompts to all bound channels
        this.ctx.waitUntil(
          this.sendChannelInteractivePrompts(invocationResult.invocationId, prompt)
        );

        // Schedule alarm for expiry
        await this.ensureActionExpiryAlarm(expiresAt * 1000);

        return; // Don't send call-tool-result — the runner will wait
      }

      // ─── Allow — execute immediately ───────────────────────────────────
      await this.executeAction(requestId, toolId, service, actionId, params, isOrgScoped, userId, actionSource, invocationResult.invocationId);
    } catch (err) {
      this.sendToRunner({
        type: 'call-tool-result',
        requestId,
        error: err instanceof Error ? err.message : String(err),
      } as any);
    }
  }

  /**
   * Execute an integration action and send the result to the runner.
   * Shared between immediate execution and post-approval execution.
   */
  private async executeAction(
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
    if (!actionSource) {
      this.sendToRunner({ type: 'call-tool-result', requestId, error: `No integration package found for service "${service}".` } as any);
      await markFailed(this.appDb, invocationId, 'No integration package found');
      return;
    }

    // Resolve credentials based on integration scope
    const provider = integrationRegistry.getProvider(service);
    let credentials: Record<string, string>;
    if (provider?.authType === 'none') {
      // No-auth services (e.g. DeepWiki) don't need credentials
      credentials = {};
    } else {
      const scope = isOrgScoped ? 'org' as const : 'user' as const;
      let credResult = this.getCachedCredential('user', userId, service)
        || await integrationRegistry.resolveCredentials(service, this.env, userId, scope);
      if (credResult.ok) {
        this.setCachedCredential('user', userId, service, credResult);
      }
      if (!credResult.ok) {
        const scopeLabel = isOrgScoped ? `org-scoped "${service}"` : `"${service}"`;
        this.sendToRunner({ type: 'call-tool-result', requestId, error: `No credentials found for ${scopeLabel}: ${credResult.error.message}. Connect it in Settings > Integrations.` } as any);
        await markFailed(this.appDb, invocationId, `No credentials: ${credResult.error.message}`);
        return;
      }
      // Map resolved credential to the format actions expect
      const token = credResult.credential.accessToken;
      credentials = credResult.credential.credentialType === 'bot_token'
        ? { bot_token: token } as Record<string, string>
        : { access_token: token };

      // For Slack: inject the session owner's Slack user ID so dm_owner works
      if (service === 'slack') {
        const identityLinks = await getUserIdentityLinks(this.appDb, userId);
        const slackLink = identityLinks.find((l) => l.provider === 'slack');
        if (slackLink) credentials.owner_slack_user_id = slackLink.externalId;
      }
    }

    // Resolve caller identity for orchestrator sessions (used by Slack for username/avatar override)
    let callerIdentity: { name: string; avatar?: string } | undefined;
    try {
      const spawnRequestStr = this.getStateValue('spawnRequest');
      if (spawnRequestStr) {
        const spawnReq = JSON.parse(spawnRequestStr);
        if (spawnReq.envVars?.IS_ORCHESTRATOR === 'true') {
          const identity = await getOrchestratorIdentity(this.appDb, userId);
          if (identity) {
            callerIdentity = { name: identity.name, avatar: identity.avatar };
          }
        }
      }
    } catch {
      // Non-critical — proceed without identity
    }

    // Execute the action
    let actionResult = await actionSource.execute(actionId, params, { credentials, userId, callerIdentity });

    // If auth error, retry once with force-refreshed credentials (skip no-auth and bot_token services which have nothing to refresh)
    if (provider?.authType !== 'none' && provider?.authType !== 'bot_token' && !actionResult.success && actionResult.error && /\b(401|403|unauthorized|invalid.credentials|token.*expired|token.*revoked)\b/i.test(actionResult.error)) {
      const scope = isOrgScoped ? 'org' as const : 'user' as const;
      console.log(`[SessionAgentDO] Tool "${toolId}" returned auth error, retrying with refreshed credentials`);
      this.invalidateCachedCredential('user', userId, service);
      const refreshedCred = await integrationRegistry.resolveCredentials(service, this.env, userId, scope, { forceRefresh: true });
      if (refreshedCred.ok) {
        this.setCachedCredential('user', userId, service, refreshedCred);
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
        });
      }
    }

    // Record result and send to runner
    if (!actionResult.success) {
      await markFailed(this.appDb, invocationId, actionResult.error || 'Action failed');
      this.sendToRunner({ type: 'call-tool-result', requestId, error: actionResult.error || 'Action failed' } as any);
    } else {
      await markExecuted(this.appDb, invocationId, actionResult.data);
      this.sendToRunner({ type: 'call-tool-result', requestId, result: actionResult.data } as any);
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

    const userId = this.getStateValue('userId');
    const sessionId = this.getStateValue('sessionId');

    if (promptType === 'approval') {
      const toolId = context.toolId || '';
      const service = context.service || '';
      const actionId = context.actionId || '';
      const params = context.params || {};
      const isOrgScoped = !!context.isOrgScoped;

      if (resolution.actionId === 'approve') {
        if (!userId) {
          if (requestId) {
            this.sendToRunner({ type: 'call-tool-result', requestId, error: 'No userId on session' } as any);
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
          await this.executeAction(requestId, toolId, service, actionId, params, isOrgScoped, userId, actionSource, promptId);
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

        this.appendAuditLog('agent.tool_call', `Action ${toolId} approved and executed`, undefined, { invocationId: promptId });
      } else {
        // Deny
        const reason = resolution.value;
        await denyInvocation(this.appDb, promptId, userId || 'system', reason);

        // Send error to runner
        const errorMsg = reason
          ? `Action "${toolId}" was denied: ${reason}`
          : `Action "${toolId}" was denied by a reviewer`;
        if (requestId) {
          this.sendToRunner({ type: 'call-tool-result', requestId, error: errorMsg } as any);
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

        this.appendAuditLog('agent.tool_call', `Action ${toolId} denied${reason ? `: ${reason}` : ''}`, undefined, { invocationId: promptId });
      }
    } else if (promptType === 'question') {
      // Send answer to runner — use the human-readable label when available
      const answer = actionLabel || resolution.value || resolution.actionId || '';
      this.sendToRunner({
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

      this.appendAuditLog('user.answer', `Answered question: ${String(answer).slice(0, 80)}`, undefined, { questionId: promptId });

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
      const sessionId = this.getStateValue('sessionId');
      const userId = this.getStateValue('userId');
      if (!sessionId || !userId) return;

      const targets: Array<{ channelType: string; channelId: string }> = [];

      const originTarget = this.getPromptOriginTarget(prompt.context);
      if (originTarget && originTarget.channelType !== 'web') {
        targets.push(originTarget);
      } else {
        // Collect channel targets to dispatch the prompt to.
        // Start with D1 bindings (user-level first, then session-scoped fallback).
        let bindings = await listUserChannelBindings(this.appDb, userId);
        if (bindings.length === 0) {
          bindings = await getSessionChannelBindings(this.appDb, sessionId);
        }

        // Build deduplicated set of non-web channel targets
        const seen = new Set<string>();
        for (const b of bindings) {
          if (b.channelType === 'web') continue;
          const key = `${b.channelType}:${b.channelId}`;
          if (seen.has(key)) continue;
          seen.add(key);
          targets.push({ channelType: b.channelType, channelId: b.channelId });
        }

        // Also include the active channel (the channel that triggered this prompt).
        // Orchestrator sessions often lack D1 bindings for Slack because messages are
        // dispatched directly to the DO — the active channel fills that gap.
        const active = this.activeChannel;
        if (active && active.channelType !== 'web') {
          const key = `${active.channelType}:${active.channelId}`;
          if (!seen.has(key)) {
            seen.add(key);
            targets.push({ channelType: active.channelType, channelId: active.channelId });
          }
        }
      }

      if (targets.length === 0) return;

      const refs: Array<{ channelType: string; ref: InteractivePromptRef }> = [];

      for (const target of targets) {
        const transport = channelRegistry.getTransport(target.channelType);
        if (!transport?.sendInteractivePrompt) continue;

        // Resolve token (same pattern as handleChannelReply)
        let token: string | undefined;
        if (target.channelType === 'slack') {
          token = await getSlackBotToken(this.env) ?? undefined;
        } else {
          const credResult = await getCredential(this.env, 'user', userId, target.channelType);
          if (credResult.ok) token = credResult.credential.accessToken;
        }
        if (!token) continue;

        // Build target from binding
        const parsed = this.parseSlackChannelId(target.channelType, target.channelId);
        const channelTarget: ChannelTarget = {
          channelType: target.channelType,
          channelId: parsed.channelId,
          threadId: parsed.threadId,
        };
        const ctx: ChannelContext = { token, userId };

        const ref = await transport.sendInteractivePrompt(channelTarget, prompt, ctx);
        if (ref) {
          refs.push({ channelType: target.channelType, ref });
        }
      }

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

    const userId = this.getStateValue('userId');
    let refs: Array<{ channelType: string; ref: InteractivePromptRef }>;
    try {
      refs = JSON.parse(channelRefsJson);
    } catch {
      return;
    }

    for (const { channelType, ref } of refs) {
      const transport = channelRegistry.getTransport(channelType);
      if (!transport?.updateInteractivePrompt) continue;

      let token: string | undefined;
      if (channelType === 'slack') {
        token = await getSlackBotToken(this.env) ?? undefined;
      } else if (userId) {
        const credResult = await getCredential(this.env, 'user', userId, channelType);
        if (credResult.ok) token = credResult.credential.accessToken;
      }
      if (!token) continue;

      const parsed = this.parseSlackChannelId(channelType, ref.channelId);
      const target: ChannelTarget = {
        channelType,
        channelId: parsed.channelId,
        threadId: parsed.threadId,
      };
      const ctx: ChannelContext = { token, userId: userId || '' };

      try {
        await transport.updateInteractivePrompt(target, ref, resolution, ctx);
      } catch (err) {
        console.error(`[SessionAgentDO] updateInteractivePrompt failed for ${channelType}:`, err instanceof Error ? err.message : String(err));
      }
    }
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

  /** Serialize a Zod schema into a simple param descriptor object for tool discovery. */
  private serializeZodSchema(schema: unknown): Record<string, { type: string; required: boolean; description?: string }> {
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

      const type = this.zodTypeToString(inner);
      const description = inner?._def?.description || (fieldSchema as any)?._def?.description || undefined;
      result[key] = { type, required, description };
    }

    return result;
  }

  /** Map a Zod type to a human-readable type string. */
  private zodTypeToString(inner: any): string {
    const typeName = inner?._def?.typeName;
    if (typeName === 'ZodString') return 'string';
    if (typeName === 'ZodNumber') return 'number';
    if (typeName === 'ZodBoolean') return 'boolean';
    if (typeName === 'ZodEnum') {
      const values = inner._def.values;
      return Array.isArray(values) ? `enum(${values.join(',')})` : 'enum';
    }
    if (typeName === 'ZodArray') {
      const itemType = inner._def.type ? this.zodTypeToString(inner._def.type) : 'unknown';
      return `array<${itemType}>`;
    }
    if (typeName === 'ZodObject') return 'object';
    return 'unknown';
  }

  /**
   * Auto-send the agent's result text to the originating channel if the agent
   * didn't explicitly call channel_reply during this prompt cycle.
   * On success, stamps the assistant message with channel metadata so the
   * web UI can show a "sent to <channel>" badge.
   */
  private async flushPendingChannelReply() {
    let pending = this.pendingChannelReply;
    console.log(`[SessionAgentDO] flushPendingChannelReply: pending=${pending ? `${pending.channelType}:${pending.channelId} handled=${pending.handled} resultContent=${pending.resultContent?.length ?? 0}chars` : 'null'}`);
    if (!pending) {
      // Hibernation recovery: reconstruct from prompt_queue processing row
      pending = this.recoverPendingChannelReply();
      if (pending) {
        console.log(`[SessionAgentDO] flushPendingChannelReply: recovered from SQLite: ${pending.channelType}:${pending.channelId}`);
        // Look up the most recent assistant message for resultContent
        const recentMsg = this.ctx.storage.sql
          .exec(
            "SELECT id, content FROM messages WHERE role = 'assistant' AND channel_type = ? AND channel_id = ? ORDER BY created_at DESC LIMIT 1",
            pending.channelType, pending.channelId
          )
          .toArray();
        if (recentMsg.length > 0 && recentMsg[0].content) {
          pending.resultContent = recentMsg[0].content as string;
          pending.resultMessageId = recentMsg[0].id as string;
        }
      }
    }
    if (!pending || pending.handled || !pending.resultContent) {
      console.log(`[SessionAgentDO] flushPendingChannelReply: skipping (pending=${!!pending} handled=${pending?.handled} resultContent=${pending?.resultContent?.length ?? 0}chars)`);
      this.pendingChannelReply = null;
      return;
    }
    this.pendingChannelReply = null;

    const userId = this.getStateValue('userId');
    if (!userId) return;

    let sent = false;
    try {
      const transport = channelRegistry.getTransport(pending.channelType);
      if (!transport) {
        console.log(`[SessionAgentDO] Auto channel reply: unsupported channel type ${pending.channelType}`);
      } else {
        // Resolve token: Slack uses org-level bot token, other channels use per-user credentials
        let token: string | undefined;
        if (pending.channelType === 'slack') {
          token = await getSlackBotToken(this.env) ?? undefined;
        } else {
          const credResult = await getCredential(this.env, 'user', userId, pending.channelType);
          if (credResult.ok) token = credResult.credential.accessToken;
        }
        if (!token) {
          console.log(`[SessionAgentDO] Auto channel reply: no ${pending.channelType} config, skipping`);
          return;
        }
        // Parse composite channelId (Slack encodes threadId after colon)
        const parsed = this.parseSlackChannelId(pending.channelType, pending.channelId);
        const target: ChannelTarget = { channelType: pending.channelType, channelId: parsed.channelId, threadId: parsed.threadId };
        const ctx: ChannelContext = { token, userId };
        // Add persona identity for Slack messages
        const outbound: import('@valet/sdk').OutboundMessage = { markdown: pending.resultContent };
        if (pending.channelType === 'slack') {
          outbound.platformOptions = await this.getSlackPersonaOptions(userId);
        }
        const result = await transport.sendMessage(target, outbound, ctx);
        if (result.success) {
          console.log(`[SessionAgentDO] Auto channel reply sent to ${pending.channelType}:${pending.channelId}`);
          sent = true;
        } else {
          console.error(`[SessionAgentDO] Auto channel reply failed for ${pending.channelType}:${pending.channelId}: ${result.error}`);
        }
      }
    } catch (err) {
      console.error('[SessionAgentDO] Auto channel reply error:', err);
    }

    // Auto-reply counts as a substantive reply — resolve any pending followup reminders
    if (sent) {
      this.resolveChannelFollowups(pending.channelType, pending.channelId);
    }

    // Stamp the assistant message with channel metadata so the UI shows a badge
    if (sent && pending.resultMessageId) {
      this.ctx.storage.sql.exec(
        'UPDATE messages SET channel_type = ?, channel_id = ? WHERE id = ?',
        pending.channelType, pending.channelId, pending.resultMessageId,
      );
      this.broadcastToClients({
        type: 'message.updated',
        data: {
          id: pending.resultMessageId,
          role: 'assistant',
          content: pending.resultContent,
          channelType: pending.channelType,
          channelId: pending.channelId,
          createdAt: Math.floor(Date.now() / 1000),
        },
      });
    }
  }

  /**
   * Look up orchestrator persona identity for Slack message customization.
   * Returns platformOptions with username/icon_url, or empty object on failure.
   */
  private async getSlackPersonaOptions(userId: string): Promise<Record<string, unknown>> {
    try {
      const identity = await getOrchestratorIdentity(this.appDb, userId);
      if (identity) {
        return {
          ...(identity.name ? { username: identity.name } : {}),
          ...(identity.avatar ? { icon_url: identity.avatar } : {}),
        };
      }
    } catch (err) {
      console.warn('[SessionAgentDO] Failed to resolve Slack persona identity:', err);
    }
    return {};
  }

  // ─── Channel Follow-up Helpers ─────────────────────────────────────

  private requiresExplicitChannelReply(channelType?: string): boolean {
    return !!channelType && channelType !== 'web' && channelType !== 'thread';
  }

  private insertChannelFollowup(channelType: string, channelId: string, content: string): void {
    if (!this.requiresExplicitChannelReply(channelType)) {
      return;
    }

    const id = crypto.randomUUID();
    const now = Date.now();
    const intervalMs = parseInt(this.getStateValue('channelFollowupIntervalMs') || '300000');
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
    const spawnRequestStr = this.getStateValue('spawnRequest');
    if (!spawnRequestStr) {
      console.warn('[SessionAgentDO] sendOpenCodeConfig: no spawnRequest in state, skipping');
      return;
    }

    let spawnRequest: { envVars?: Record<string, string>; customProviders?: Array<{ providerId: string; displayName: string; baseUrl: string; apiKey?: string; models: Array<{ id: string; name?: string; contextLimit?: number; outputLimit?: number }> }> };
    try {
      spawnRequest = JSON.parse(spawnRequestStr);
    } catch {
      console.warn('[SessionAgentDO] sendOpenCodeConfig: failed to parse spawnRequest');
      return;
    }

    const envVars = spawnRequest.envVars || {};
    const config: NonNullable<RunnerOutbound['config']> = {
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
    this.sendToRunner({ type: 'opencode-config', config });
  }

  private async sendRepoConfig(): Promise<void> {
    const sessionId = this.getStateValue('sessionId');
    if (!sessionId) return;

    const gitState = await getSessionGitState(this.appDb, sessionId);
    const repoUrl = gitState?.sourceRepoUrl;
    if (!repoUrl) return;

    const userId = this.getStateValue('userId');
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
        this.sendToRunner({
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
    const sessionId = this.getStateValue('sessionId');
    if (!sessionId) return;

    const gitState = await getSessionGitState(this.appDb, sessionId);
    const repoUrl = gitState?.sourceRepoUrl;
    if (!repoUrl) return;

    const userId = this.getStateValue('userId');
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

      this.sendToRunner({
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
    const spawnRequestStr = this.getStateValue('spawnRequest');
    if (spawnRequestStr) {
      try {
        const spawnRequest = JSON.parse(spawnRequestStr);
        if (spawnRequest.personaFiles && Array.isArray(spawnRequest.personaFiles)) {
          sessionPersonas = spawnRequest.personaFiles;
        }
      } catch {
        // ignore
      }
    }

    // Resolve skills and tool whitelist from persona attachments or org defaults
    const appDb = getDb(this.env.DB);
    let resolvedSkills: Array<{ filename: string; content: string }> = [];
    let toolWhitelist: { services: string[]; excludedActions: Array<{ service: string; actionId: string }> } | null = null;
    try {
      // Check if this session has a personaId by looking up the session record
      const sessionId = this.getStateValue('sessionId');
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
    this.sendToRunner({ type: 'plugin-content', pluginContent: content });
  }

  private sendToRunner(message: RunnerOutbound): boolean {
    if (message.type === 'prompt') {
      console.log(`[SessionAgentDO] sendToRunner prompt: messageId=${message.messageId}`);
    }
    const runners = this.ctx.getWebSockets('runner');
    if (runners.length === 0) {
      console.warn(`[SessionAgentDO] sendToRunner: no runner sockets available for type=${message.type}`);
      return false;
    }
    const payload = JSON.stringify(message);
    let sent = false;
    for (const ws of runners) {
      try {
        ws.send(payload);
        sent = true;
      } catch {
        // Runner may have disconnected
      }
    }
    if (!sent) {
      console.warn(`[SessionAgentDO] sendToRunner: all sends failed for type=${message.type}`);
    }
    return sent;
  }
}
