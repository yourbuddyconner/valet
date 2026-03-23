/**
 * PromptHandler — bridges OpenCode server and AgentClient.
 *
 * Uses the OpenCode HTTP API:
 * - POST /session         — create session
 * - POST /session/:id/prompt_async — send message (fire-and-forget, 204)
 * - GET  /event           — SSE stream for all events
 *
 * OpenCode SSE event types (from SDK types.gen.ts):
 * - message.part.updated  — { part: Part, delta?: string }
 *     Part.type: "text" | "tool" | "step-start" | "step-finish" | "reasoning" | ...
 *     For "tool" parts: { tool: string, state: { status, input, output } }
 * - message.updated       — { info: Message } where Message has role, etc.
 * - session.status         — { sessionID, status: { type: "idle"|"busy"|"retry" } }
 * - session.idle           — session became idle
 * - permission.updated     — permission request created/updated
 */

import { createTwoFilesPatch } from "diff";
import { AgentClient, type PromptAuthor } from "./agent-client.js";
import type { AvailableModels, DiffFile, PromptAttachment, ReviewFileSummary, ReviewResultData } from "./types.js";
import { compileWorkflowDefinition, type NormalizedWorkflowStep } from "./workflow-compiler.js";
import {
  executeWorkflowResume,
  executeWorkflowRun,
  type WorkflowRunPayload,
  type WorkflowStepExecutionContext,
  type WorkflowStepExecutionResult,
} from "./workflow-engine.js";

// OpenCode ToolState status values
type ToolStatus = "pending" | "running" | "completed" | "error";

interface ToolState {
  status: ToolStatus;
  input?: unknown;
  output?: string;
  title?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  time?: { start?: number; end?: number };
}

interface ToolPart {
  type: "tool";
  id: string;
  sessionID?: string;
  messageID?: string;
  callID?: string;
  tool: string;       // tool name
  state: ToolState;
}

interface TextPart {
  type: "text";
  text?: string;
  [key: string]: unknown;
}

type Part = ToolPart | TextPart | { type: string; [key: string]: unknown };

// SessionStatus is an object: { type: "idle" } | { type: "busy" } | { type: "retry", ... }
interface SessionStatus {
  type: "idle" | "busy" | "retry";
  [key: string]: unknown;
}

interface OpenCodeErrorLike {
  name?: string;
  data?: Record<string, unknown>;
  message?: string;
  [key: string]: unknown;
}

interface OpenCodeMessageInfo {
  id?: string;
  role?: string;
  sessionID?: string;
  parts?: unknown[];
  content?: string;
  error?: OpenCodeErrorLike | string;
  [key: string]: unknown;
}

interface OpenCodeQuestionOption {
  label?: string;
  description?: string;
}

interface OpenCodeQuestionInfo {
  question?: string;
  header?: string;
  options?: OpenCodeQuestionOption[];
  multiple?: boolean;
  custom?: boolean;
}

type OpenCodeEvent =
  | {
      type: "message.part.updated";
      properties: {
        part: Part;
        delta?: string;
      } & Record<string, unknown>;
    }
  | {
      type: "message.updated";
      properties: {
        info: OpenCodeMessageInfo;
      } & Record<string, unknown>;
    }
  | {
      type: "session.status";
      properties: {
        sessionID?: string;
        status: SessionStatus;
      } & Record<string, unknown>;
    }
  | {
      type: "session.idle";
      properties: {
        sessionID?: string;
      } & Record<string, unknown>;
    }
  | {
      type: "session.error";
      properties: {
        sessionID?: string;
        error?: OpenCodeErrorLike | string;
      } & Record<string, unknown>;
    }
  | {
      type: string;
      properties?: Record<string, unknown>;
    };

interface AssistantMessageRecovery {
  text: string | null;
  error: string | null;
  modelLabel?: string;
  finish?: string;
  outputTokens?: number | null;
}

interface WorkflowExecutionDispatchPayload {
  kind: "run" | "resume";
  executionId: string;
  workflowHash?: string;
  resumeToken?: string;
  decision?: "approve" | "deny";
  payload: Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function normalizeOpenCodeEvent(raw: unknown): OpenCodeEvent | null {
  if (!isRecord(raw)) return null;
  const maybePayload = isRecord(raw.payload) ? raw.payload : raw;
  const type = maybePayload.type;
  if (typeof type !== "string") return null;
  const properties = isRecord(maybePayload.properties)
    ? maybePayload.properties
    : Object.fromEntries(
        Object.entries(maybePayload).filter(([key]) =>
          key !== "type" &&
          key !== "payload" &&
          key !== "time"
        ),
      );
  return {
    type,
    properties,
  };
}

function openCodeErrorToMessage(raw: unknown): string | null {
  if (!raw) return null;
  if (typeof raw === "string") return raw;
  if (!isRecord(raw)) return null;

  const data = isRecord(raw.data) ? raw.data : undefined;
  const namedMessage =
    (data && typeof data.message === "string" ? data.message : undefined) ??
    (typeof raw.message === "string" ? raw.message : undefined);
  if (namedMessage && namedMessage.trim()) return namedMessage.trim();

  const fallback = JSON.stringify(raw);
  return fallback && fallback !== "{}" ? fallback : null;
}

// Emergency fallback timeout — only fires if no idle/completion event arrives
const EMERGENCY_TIMEOUT_MS = 60_000;

// Timeout for awaiting the first assistant message after sending a prompt.
// If the model/provider never responds, this prevents the session from hanging forever.
const FIRST_RESPONSE_TIMEOUT_MS = 90_000;

// Hard ceiling on a single sync prompt attempt. Prevents the sync fetch from blocking
// forever when OpenCode enters an internal provider retry loop (e.g. repeated 429/5xx).
const SYNC_PROMPT_TIMEOUT_MS = 300_000; // 5 minutes

// Review polling configuration
const REVIEW_POLL_INTERVAL_MS = 500;
const REVIEW_TIMEOUT_MS = 120_000;

// Pre-compaction memory flush configuration
const FLUSH_THRESHOLD_RATIO = 0.70;  // Trigger at 70% of context window
const FLUSH_TURN_INTERVAL = 20;      // Fallback: every 20 turns if no token data
const FLUSH_TIMEOUT_MS = 60_000;     // Max time for flush turn

const MEMORY_FLUSH_PROMPT = `[SYSTEM: Pre-compaction memory checkpoint]

Your context window is approaching capacity and will be compacted soon. Context from earlier in the conversation may be lost.

Review the conversation above and save any important information to memory using mem_write or mem_patch:

- Current task status and remaining work
- Key decisions and their reasoning
- Important discoveries (bugs, constraints, edge cases)
- User preferences and conventions
- Key file paths and their purposes

Use paths like "projects/<repo>/task-status.md", "projects/<repo>/decisions.md", etc.

If nothing is worth saving, reply "Nothing to save."

Do NOT mention this checkpoint to the user. This is an automatic system process.`;

const REVIEW_PROMPT = `You are a code reviewer. Analyze the following diff and produce a structured JSON review.

Return ONLY a fenced JSON block (\`\`\`json ... \`\`\`) with this exact structure:

{
  "overallSummary": "Brief summary of all changes",
  "files": [
    {
      "path": "file/path.ts",
      "summary": "What changed in this file",
      "reviewOrder": 1,
      "linesAdded": 10,
      "linesDeleted": 5,
      "findings": [
        {
          "id": "f1",
          "file": "file/path.ts",
          "lineStart": 10,
          "lineEnd": 15,
          "severity": "warning",
          "category": "logic",
          "title": "Short title",
          "description": "Detailed description of the issue",
          "suggestedFix": "Optional code or description of fix"
        }
      ]
    }
  ],
  "stats": { "critical": 0, "warning": 1, "suggestion": 0, "nitpick": 0 }
}

Severity levels:
- critical: Bugs, security issues, data loss risks
- warning: Logic errors, performance problems, missing error handling
- suggestion: Better approaches, readability improvements
- nitpick: Style, naming, minor preferences

Categories: logic, security, performance, error-handling, types, style, naming, documentation, testing, architecture

IMPORTANT: Do NOT create duplicate findings. If the same issue applies to a range of lines, create ONE finding with lineStart/lineEnd spanning the full range. Never create multiple findings with the same title for adjacent or nearby lines.

Review these changes:

`;

function parseReviewResponse(content: string): ReviewResultData | null {
  // Extract JSON from fenced code block
  const jsonMatch = content.match(/```json\s*([\s\S]*?)```/);
  if (!jsonMatch) return null;

  try {
    const parsed = JSON.parse(jsonMatch[1].trim());

    // Validate structure
    if (!parsed.files || !Array.isArray(parsed.files) || !parsed.overallSummary) {
      return null;
    }

    // Compute stats if missing
    if (!parsed.stats) {
      const stats = { critical: 0, warning: 0, suggestion: 0, nitpick: 0 };
      for (const file of parsed.files) {
        for (const finding of file.findings || []) {
          if (finding.severity in stats) {
            stats[finding.severity as keyof typeof stats]++;
          }
        }
      }
      parsed.stats = stats;
    }

    // Ensure all files have findings array, IDs on findings, and deduplicate
    let idCounter = 0;
    for (const file of parsed.files as ReviewFileSummary[]) {
      file.findings = file.findings || [];
      for (const finding of file.findings) {
        if (!finding.id) {
          finding.id = `rf-${++idCounter}`;
        }
        if (!finding.file) {
          finding.file = file.path;
        }
      }

      // Deduplicate: merge findings with the same title in the same file
      const merged: typeof file.findings = [];
      for (const finding of file.findings) {
        const existing = merged.find(
          (f) => f.title === finding.title && f.severity === finding.severity
        );
        if (existing) {
          // Expand the line range to cover both
          existing.lineStart = Math.min(existing.lineStart, finding.lineStart);
          existing.lineEnd = Math.max(existing.lineEnd, finding.lineEnd);
        } else {
          merged.push(finding);
        }
      }
      file.findings = merged;
    }

    // Recompute stats after deduplication
    const recomputedStats = { critical: 0, warning: 0, suggestion: 0, nitpick: 0 };
    for (const file of parsed.files) {
      for (const finding of file.findings || []) {
        if (finding.severity in recomputedStats) {
          recomputedStats[finding.severity as keyof typeof recomputedStats]++;
        }
      }
    }
    parsed.stats = recomputedStats;

    return parsed as ReviewResultData;
  } catch {
    return null;
  }
}

// ─── Retriable Error Detection ──────────────────────────────────────────

const RETRIABLE_ERROR_PATTERNS = [
  // Billing / credit errors
  /credit balance is too low/i,
  /insufficient_quota/i,
  /billing.*not.*active/i,
  /exceeded.*quota/i,
  /payment.*required/i,
  // Rate limit errors
  /rate_limit_exceeded/i,
  /rate limit/i,
  /too many requests/i,
  /429/,
  // Auth errors
  /invalid_api_key/i,
  /authentication_error/i,
  /invalid.*api.*key/i,
  /unauthorized/i,
  /api key.*invalid/i,
  /permission.*denied/i,
  // Model availability mismatches (fallback to next preferred model)
  /model.*not.*supported/i,
  /copilot settings/i,
  // Provider/model returned an empty completion with no tokens
  /returned an empty completion/i,
  /outputtokens=0/i,
  /model returned an empty response/i,
];

function isRetriableProviderError(errorMsg: string): boolean {
  return RETRIABLE_ERROR_PATTERNS.some((pattern) => pattern.test(errorMsg));
}

// ─── Per-Channel Session State ──────────────────────────────────────────
// Each channel (web, telegram, slack, etc.) gets its own OpenCode session
// so prompts from different channels don't interfere with each other.

export class ChannelSession {
  readonly channelKey: string;
  opencodeSessionId: string | null = null;
  // True when session id was injected from DO persistence rather than created
  // in this runner process. We re-sync it before first prompt dispatch.
  adoptedPersistedSession = false;

  // Orchestrator thread ID passed from DO (may differ from channel-derived threadId)
  promptThreadId: string | undefined = undefined;

  // Track current prompt so we can route events back to the DO
  activeMessageId: string | null = null;
  streamedContent = "";
  hasActivity = false;
  lastChunkTime = 0;

  // Track tool states to detect completion (pending/running → completed)
  toolStates = new Map<string, { status: ToolStatus; toolName: string }>();
  // Track last full text by part ID when SSE omits incremental `delta`
  textPartSnapshots = new Map<string, string>();
  // Track last full text by message ID to handle providers that rotate part IDs
  // while emitting full-text snapshots (no true deltas).
  messageTextSnapshots = new Map<string, string>();
  // Track message roles so we can ignore user parts in SSE updates
  messageRoles = new Map<string, string>();
  // Assistant message IDs seen for the active DO prompt
  activeAssistantMessageIds = new Set<string>();
  // Latest full assistant text snapshot observed via message.updated
  latestAssistantTextSnapshot = "";
  // Compact event trace for debugging empty-response classification
  recentEventTrace: string[] = [];
  lastError: string | null = null;
  hadToolSinceLastText = false;
  idleNotified = false;

  // Message ID mapping: DO message IDs ↔ OpenCode message IDs
  doToOcMessageId = new Map<string, string>();
  ocToDOMessageId = new Map<string, string>();

  // Model failover state for current prompt
  currentModelPreferences: string[] | undefined;
  currentModelIndex = 0;
  pendingRetryContent: string | null = null;
  pendingRetryAttachments: PromptAttachment[] = [];
  pendingRetryAuthor: PromptAuthor | undefined;
  waitForEventForced = false;
  failoverInProgress = false;
  syncPromptInFlight = false;
  retryPending = false;
  finalizeInFlight = false;
  awaitingAssistantForAttempt = false;
  turnCreated = false;
  turnId: string | null = null;

  // Per-message usage entries for the current turn (reset per prompt)
  usageEntries = new Map<string, { model: string; inputTokens: number; outputTokens: number }>();

  // Pre-compaction memory flush state (session-lifetime — NOT reset per prompt)
  cumulativeInputTokens = 0;
  cumulativeOutputTokens = 0;
  countedTokenMessageIds = new Set<string>();
  turnCount = 0;
  lastFlushTurnCount = 0;
  memoryFlushInProgress = false;
  lastUsedModel: string | null = null;

  constructor(channelKey: string) {
    this.channelKey = channelKey;
  }

  /** Reset per-prompt state (called at start of each new prompt). */
  resetPromptState(): void {
    this.streamedContent = "";
    this.hasActivity = false;
    this.hadToolSinceLastText = false;
    this.lastChunkTime = 0;
    this.lastError = null;
    this.toolStates.clear();
    this.textPartSnapshots.clear();
    this.messageTextSnapshots.clear();
    this.messageRoles.clear();
    this.activeAssistantMessageIds.clear();
    this.latestAssistantTextSnapshot = "";
    this.recentEventTrace = [];
    this.waitForEventForced = false;
    this.syncPromptInFlight = false;
    this.awaitingAssistantForAttempt = false;
    this.turnCreated = false;
    this.turnId = null;
    this.usageEntries.clear();
  }

  /** Reset state for model failover retry (keep activeMessageId). */
  resetForRetry(): void {
    this.streamedContent = "";
    this.hasActivity = false;
    this.hadToolSinceLastText = false;
    this.lastChunkTime = 0;
    this.lastError = null;
    this.toolStates.clear();
    this.textPartSnapshots.clear();
    this.messageTextSnapshots.clear();
    this.messageRoles.clear();
    this.activeAssistantMessageIds.clear();
    this.latestAssistantTextSnapshot = "";
    this.recentEventTrace = [];
    this.syncPromptInFlight = false;
    this.awaitingAssistantForAttempt = false;
    this.turnCreated = false;
    this.turnId = null;
    // Note: usageEntries NOT cleared on retry — entries from failed attempt
    // are still valid usage that was billed by the provider
  }

  /** Reset state on abort. */
  resetForAbort(): void {
    this.activeMessageId = null;
    this.streamedContent = "";
    this.hasActivity = false;
    this.hadToolSinceLastText = false;
    this.lastChunkTime = 0;
    this.lastError = null;
    this.toolStates.clear();
    this.textPartSnapshots.clear();
    this.messageTextSnapshots.clear();
    this.messageRoles.clear();
    this.activeAssistantMessageIds.clear();
    this.latestAssistantTextSnapshot = "";
    this.recentEventTrace = [];
    this.syncPromptInFlight = false;
    this.awaitingAssistantForAttempt = false;
    this.turnCreated = false;
    this.turnId = null;
    // Tokens consumed during aborted turns are still billed by the provider
    // but we drop them here since turnId is cleared and we can't attribute them.
    // This causes minor underreporting of actual provider cost on aborted turns.
    this.usageEntries.clear();
  }

  static channelKeyFrom(channelType?: string, channelId?: string): string {
    if (channelType && channelId) return `${channelType}:${channelId}`;
    return "web:default";
  }
}

export class PromptHandler {
  private opencodeUrl: string;
  private agentClient: AgentClient;
  private runnerSessionId: string | null;
  private eventStreamActive = false;
  private eventStreamAbort: AbortController | null = null;
  private responseTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private firstResponseTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private lastPromptSentAt: number = 0;

  // Per-channel OpenCode session state
  private channels = new Map<string, ChannelSession>();
  private ocSessionToChannel = new Map<string, ChannelSession>(); // reverse lookup for SSE routing

  // Active channel — set when a prompt arrives, used by methods that haven't been
  // updated to accept a channel parameter yet (backward compat bridge)
  private activeChannel: ChannelSession | null = null;

  // Legacy single-session compat — points to activeChannel's OC session ID
  // Used by ephemeral sessions, reviews, etc. that don't need per-channel routing
  private get sessionId(): string | null {
    return this.activeChannel?.opencodeSessionId ?? null;
  }
  private set sessionId(val: string | null) {
    if (this.activeChannel) {
      this.activeChannel.opencodeSessionId = val;
    }
  }

  // Delegate per-prompt fields to activeChannel for backward compat
  private get activeMessageId(): string | null { return this.activeChannel?.activeMessageId ?? null; }
  private set activeMessageId(val: string | null) { if (this.activeChannel) this.activeChannel.activeMessageId = val; }
  private get streamedContent(): string { return this.activeChannel?.streamedContent ?? ""; }
  private set streamedContent(val: string) { if (this.activeChannel) this.activeChannel.streamedContent = val; }
  private get hasActivity(): boolean { return this.activeChannel?.hasActivity ?? false; }
  private set hasActivity(val: boolean) { if (this.activeChannel) this.activeChannel.hasActivity = val; }
  private get lastChunkTime(): number { return this.activeChannel?.lastChunkTime ?? 0; }
  private set lastChunkTime(val: number) { if (this.activeChannel) this.activeChannel.lastChunkTime = val; }
  private get toolStates(): Map<string, { status: ToolStatus; toolName: string }> { return this.activeChannel?.toolStates ?? new Map(); }
  private get textPartSnapshots(): Map<string, string> { return this.activeChannel?.textPartSnapshots ?? new Map(); }
  private get messageTextSnapshots(): Map<string, string> { return this.activeChannel?.messageTextSnapshots ?? new Map(); }
  private get messageRoles(): Map<string, string> { return this.activeChannel?.messageRoles ?? new Map(); }
  private get activeAssistantMessageIds(): Set<string> { return this.activeChannel?.activeAssistantMessageIds ?? new Set(); }
  private get latestAssistantTextSnapshot(): string { return this.activeChannel?.latestAssistantTextSnapshot ?? ""; }
  private set latestAssistantTextSnapshot(val: string) { if (this.activeChannel) this.activeChannel.latestAssistantTextSnapshot = val; }
  private get recentEventTrace(): string[] { return this.activeChannel?.recentEventTrace ?? []; }
  private set recentEventTrace(val: string[]) { if (this.activeChannel) this.activeChannel.recentEventTrace = val; }
  private get lastError(): string | null { return this.activeChannel?.lastError ?? null; }
  private set lastError(val: string | null) { if (this.activeChannel) this.activeChannel.lastError = val; }
  private get hadToolSinceLastText(): boolean { return this.activeChannel?.hadToolSinceLastText ?? false; }
  private set hadToolSinceLastText(val: boolean) { if (this.activeChannel) this.activeChannel.hadToolSinceLastText = val; }
  private get idleNotified(): boolean { return this.activeChannel?.idleNotified ?? false; }
  private set idleNotified(val: boolean) { if (this.activeChannel) this.activeChannel.idleNotified = val; }
  private get doToOcMessageId(): Map<string, string> { return this.activeChannel?.doToOcMessageId ?? new Map(); }
  private get ocToDOMessageId(): Map<string, string> { return this.activeChannel?.ocToDOMessageId ?? new Map(); }
  private get currentModelPreferences(): string[] | undefined { return this.activeChannel?.currentModelPreferences; }
  private set currentModelPreferences(val: string[] | undefined) { if (this.activeChannel) this.activeChannel.currentModelPreferences = val; }
  private get currentModelIndex(): number { return this.activeChannel?.currentModelIndex ?? 0; }
  private set currentModelIndex(val: number) { if (this.activeChannel) this.activeChannel.currentModelIndex = val; }
  private get pendingRetryContent(): string | null { return this.activeChannel?.pendingRetryContent ?? null; }
  private set pendingRetryContent(val: string | null) { if (this.activeChannel) this.activeChannel.pendingRetryContent = val; }
  private get pendingRetryAttachments(): PromptAttachment[] { return this.activeChannel?.pendingRetryAttachments ?? []; }
  private set pendingRetryAttachments(val: PromptAttachment[]) { if (this.activeChannel) this.activeChannel.pendingRetryAttachments = val; }
  private get pendingRetryAuthor(): PromptAuthor | undefined { return this.activeChannel?.pendingRetryAuthor; }
  private set pendingRetryAuthor(val: PromptAuthor | undefined) { if (this.activeChannel) this.activeChannel.pendingRetryAuthor = val; }
  private get waitForEventForced(): boolean { return this.activeChannel?.waitForEventForced ?? false; }
  private set waitForEventForced(val: boolean) { if (this.activeChannel) this.activeChannel.waitForEventForced = val; }
  private get failoverInProgress(): boolean { return this.activeChannel?.failoverInProgress ?? false; }
  private set failoverInProgress(val: boolean) { if (this.activeChannel) this.activeChannel.failoverInProgress = val; }
  private get retryPending(): boolean { return this.activeChannel?.retryPending ?? false; }
  private set retryPending(val: boolean) { if (this.activeChannel) this.activeChannel.retryPending = val; }
  private get finalizeInFlight(): boolean { return this.activeChannel?.finalizeInFlight ?? false; }
  private set finalizeInFlight(val: boolean) { if (this.activeChannel) this.activeChannel.finalizeInFlight = val; }
  private get awaitingAssistantForAttempt(): boolean { return this.activeChannel?.awaitingAssistantForAttempt ?? false; }
  private set awaitingAssistantForAttempt(val: boolean) { if (this.activeChannel) this.activeChannel.awaitingAssistantForAttempt = val; }
  private get turnCreated(): boolean { return this.activeChannel?.turnCreated ?? false; }
  private set turnCreated(val: boolean) { if (this.activeChannel) this.activeChannel.turnCreated = val; }
  private get turnId(): string | null { return this.activeChannel?.turnId ?? null; }
  private set turnId(val: string | null) { if (this.activeChannel) this.activeChannel.turnId = val; }

  // Ephemeral session tracking — resolved when the session becomes idle via SSE
  private idleWaiters = new Map<string, () => void>();
  private ephemeralContent = new Map<string, string>(); // accumulated text from SSE

  // Original channel info for [via ...] attribution when channelType is 'thread'
  private pendingReplyChannelType: string | undefined;
  private pendingReplyChannelId: string | undefined;

  // OpenCode question requests (question tool)
  private pendingQuestionRequests = new Map<string, { answers: (string[] | null)[] }>();
  private promptToQuestion = new Map<string, { requestID: string; index: number }>();
  private workflowExecutionModel: string | undefined;
  private workflowExecutionModelPreferences: string[] | undefined;
  private readonly verboseSseDebug = process.env.RUNNER_DEBUG_SSE_RAW === "1";
  private sseDebugLogCount = 0;
  private readonly sseDebugLogLimit = 80;
  private sseParseWarnCount = 0;
  private sseDroppedEventCount = 0;

  // Provider model filtering — maps providerId → { modelIds, showAll }
  // Works for both custom providers and built-in providers (anthropic, openai, google, etc.)
  private providerModelConfigs = new Map<string, { modelIds: Set<string>; showAll: boolean }>();

  // Model context limits — populated from provider discovery, used for pre-compaction flush
  private modelContextLimits = new Map<string, number>();

  // Last-resort default model — first model discovered from connected providers.
  // Used when no explicit model and no model preferences are configured, to avoid
  // falling through to OpenCode's internal default (which may be a wrong provider).
  private discoveredDefaultModel: string | undefined;

  constructor(opencodeUrl: string, agentClient: AgentClient, runnerSessionId?: string) {
    this.opencodeUrl = opencodeUrl;
    this.agentClient = agentClient;
    this.runnerSessionId = runnerSessionId?.trim() || null;
  }

  /** Populate the provider model config map for filtering in fetchAvailableModels(). */
  setProviderModelConfigs(
    customProviders?: Array<{ providerId: string; models: Array<{ id: string }>; showAllModels?: boolean }>,
    builtInConfigs?: Array<{ providerId: string; models: Array<{ id: string }>; showAllModels: boolean }>,
  ) {
    this.providerModelConfigs.clear();
    if (customProviders) {
      for (const cp of customProviders) {
        this.providerModelConfigs.set(cp.providerId, {
          modelIds: new Set(cp.models.map((m) => m.id)),
          showAll: !!cp.showAllModels,
        });
      }
    }
    if (builtInConfigs) {
      for (const bp of builtInConfigs) {
        this.providerModelConfigs.set(bp.providerId, {
          modelIds: new Set(bp.models.map((m) => m.id)),
          showAll: bp.showAllModels,
        });
      }
    }
  }

  /** Get or create a ChannelSession for the given channel. */
  getOrCreateChannel(channelType?: string, channelId?: string): ChannelSession {
    const key = ChannelSession.channelKeyFrom(channelType, channelId);
    let ch = this.channels.get(key);
    if (!ch) {
      ch = new ChannelSession(key);
      this.channels.set(key, ch);
    }
    return ch;
  }

  private applyPersistedOpenCodeSessionId(channel: ChannelSession, opencodeSessionId?: string): void {
    const persisted = typeof opencodeSessionId === "string" ? opencodeSessionId.trim() : "";
    if (!persisted) return;
    if (channel.opencodeSessionId === persisted) return;

    if (channel.opencodeSessionId) {
      this.ocSessionToChannel.delete(channel.opencodeSessionId);
    }
    channel.opencodeSessionId = persisted;
    this.ocSessionToChannel.set(persisted, channel);
    channel.adoptedPersistedSession = true;
  }

  private async resyncAdoptedSession(channel: ChannelSession, sessionId: string): Promise<string> {
    if (!channel.adoptedPersistedSession) return sessionId;
    channel.adoptedPersistedSession = false;

    try {
      // Verify the persisted session still exists and check its status.
      // Only abort if the session is actively busy — aborting an idle session
      // can cause OpenCode to enter a state where subsequent prompts are silently dropped.
      const statusRes = await fetch(`${this.opencodeUrl}/session/${sessionId}`);
      if (statusRes.status === 404 || statusRes.status === 410) {
        console.warn("[PromptHandler] Persisted OpenCode session missing; recreating");
        return this.recreateChannelOpenCodeSession(channel);
      }

      if (statusRes.ok) {
        const sessionData = await statusRes.json().catch(() => null) as Record<string, unknown> | null;
        const status = sessionData?.status as Record<string, unknown> | string | undefined;
        const statusType = typeof status === "string" ? status : (status as Record<string, unknown>)?.type;

        if (statusType === "busy" || statusType === "retry") {
          console.log(`[PromptHandler] Persisted session is ${statusType} — aborting before prompt`);
          await fetch(`${this.opencodeUrl}/session/${sessionId}/abort`, { method: "POST" });
        } else {
          console.log(`[PromptHandler] Persisted session is ${statusType ?? "idle"} — no abort needed`);
        }
      }
    } catch (err) {
      console.warn("[PromptHandler] Failed to resync adopted session:", err);
    }

    return channel.opencodeSessionId || sessionId;
  }

  private buildModelFailoverChain(primaryModel?: string, modelPreferences?: string[]): string[] {
    const chain: string[] = [];
    const pushModel = (candidate: string | undefined) => {
      const normalized = typeof candidate === "string" ? candidate.trim() : "";
      if (!normalized) return;
      if (!chain.includes(normalized)) chain.push(normalized);
    };
    pushModel(primaryModel);
    for (const candidate of modelPreferences ?? []) {
      pushModel(candidate);
    }
    return chain;
  }

  private async ensureChannelOpenCodeSession(channel: ChannelSession): Promise<string> {
    if (!channel.opencodeSessionId) {
      channel.opencodeSessionId = await this.createSession();
      this.ocSessionToChannel.set(channel.opencodeSessionId, channel);
      this.agentClient.sendChannelSessionCreated(channel.channelKey, channel.opencodeSessionId);
      // Notify DO when a new OpenCode session is created for a thread channel
      if (channel.channelKey.startsWith("thread:")) {
        const threadId = channel.channelKey.slice(7);
        this.agentClient.sendThreadCreated(threadId, channel.opencodeSessionId);
      }
    }
    if (!this.eventStreamActive) {
      await this.startEventStream();
    }
    return channel.opencodeSessionId;
  }

  private async recreateChannelOpenCodeSession(channel: ChannelSession): Promise<string> {
    const oldId = channel.opencodeSessionId;
    if (oldId) {
      this.ocSessionToChannel.delete(oldId);
    }
    channel.opencodeSessionId = await this.createSession();
    this.ocSessionToChannel.set(channel.opencodeSessionId, channel);
    this.agentClient.sendChannelSessionCreated(channel.channelKey, channel.opencodeSessionId);
    // Notify DO when a new OpenCode session is created for a thread channel
    if (channel.channelKey.startsWith("thread:")) {
      const threadId = channel.channelKey.slice(7);
      this.agentClient.sendThreadCreated(threadId, channel.opencodeSessionId);
    }
    if (!this.eventStreamActive) {
      await this.startEventStream();
    }
    return channel.opencodeSessionId;
  }

  private async sendPromptToChannelWithRecovery(
    channel: ChannelSession,
    content: string,
    options?: {
      model?: string;
      attachments?: PromptAttachment[];
      author?: PromptAuthor;
      channelType?: string;
      channelId?: string;
    },
  ): Promise<string> {
    let currentSessionId = await this.ensureChannelOpenCodeSession(channel);
    currentSessionId = await this.resyncAdoptedSession(channel, currentSessionId);
    try {
      await this.sendPromptAsync(
        currentSessionId,
        content,
        options?.model,
        options?.attachments,
        options?.author,
        options?.channelType,
        options?.channelId,
      );
      return currentSessionId;
    } catch (err) {
      if (!this.isSessionGone(err)) {
        throw err;
      }
      console.warn("[PromptHandler] OpenCode session missing; recreating session and retrying prompt");
      const recreatedSessionId = await this.recreateChannelOpenCodeSession(channel);
      await this.sendPromptAsync(
        recreatedSessionId,
        content,
        options?.model,
        options?.attachments,
        options?.author,
        options?.channelType,
        options?.channelId,
      );
      return recreatedSessionId;
    }
  }

  private extractChannelContext(channel: ChannelSession): { channelType?: string; channelId?: string; threadId?: string } {
    const idx = channel.channelKey.indexOf(":");
    if (idx <= 0 || idx >= channel.channelKey.length - 1) {
      return {};
    }
    const channelType = channel.channelKey.slice(0, idx);
    const channelId = channel.channelKey.slice(idx + 1);
    // For thread channels (key = "thread:<threadId>"), extract threadId.
    // Otherwise, use the orchestrator threadId passed from the DO prompt.
    const threadId = channelType === "thread" ? channelId : channel.promptThreadId;
    return { channelType, channelId, threadId };
  }


  private normalizeWorkflowHash(hash: string | undefined): string {
    const cleaned = (hash || "").trim();
    if (!cleaned) return "";
    return cleaned.startsWith("sha256:") ? cleaned : `sha256:${cleaned}`;
  }

  private async handleWorkflowExecutionPrompt(
    messageId: string,
    request: WorkflowExecutionDispatchPayload,
    options?: { emitChatError?: boolean; model?: string; modelPreferences?: string[] },
  ): Promise<void> {
    const executionId = request.executionId;
    const emitChatError = options?.emitChatError !== false;
    this.agentClient.sendAgentStatus("thinking");

    const fail = async (error: string) => {
      this.agentClient.sendWorkflowExecutionResult(executionId, {
        ok: false,
        status: "failed",
        executionId,
        output: {},
        steps: [],
        requiresApproval: null,
        error,
      });
      if (emitChatError) {
        this.agentClient.sendError(messageId, error);
      }
      this.agentClient.sendAgentStatus("idle");
      this.agentClient.sendComplete();
    };

    const previousWorkflowModel = this.workflowExecutionModel;
    const previousWorkflowModelPrefs = this.workflowExecutionModelPreferences;
    const normalizedDispatchModel = typeof options?.model === "string" && options.model.trim()
      ? options.model.trim()
      : undefined;
    const normalizedDispatchPrefs = Array.isArray(options?.modelPreferences)
      ? options.modelPreferences
          .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
          .filter((entry) => entry.length > 0)
      : [];
    this.workflowExecutionModel = normalizedDispatchModel;
    this.workflowExecutionModelPreferences = normalizedDispatchPrefs.length > 0 ? normalizedDispatchPrefs : undefined;

    try {
      const workflowValue = request.payload.workflow;
      if (!workflowValue || typeof workflowValue !== "object" || Array.isArray(workflowValue)) {
        await fail("Workflow execution payload missing workflow object");
        return;
      }

      const compiled = await compileWorkflowDefinition(workflowValue);
      if (!compiled.ok || !compiled.workflow || !compiled.workflowHash) {
        await fail(compiled.errors[0]?.message || "Workflow compilation failed");
        return;
      }

      const expectedHash = this.normalizeWorkflowHash(request.workflowHash);
      const compiledHash = this.normalizeWorkflowHash(compiled.workflowHash);
      if (expectedHash && expectedHash !== compiledHash) {
        await fail(`Workflow hash mismatch: expected ${expectedHash}, got ${compiledHash}`);
        return;
      }

      const payload = request.payload as WorkflowRunPayload & Record<string, unknown>;
      const runPayload: WorkflowRunPayload = {
        trigger: payload.trigger as Record<string, unknown> | undefined,
        variables: payload.variables as Record<string, unknown> | undefined,
        runtime: payload.runtime as WorkflowRunPayload["runtime"] | undefined,
      };
      const hooks = {
        onToolStep: (step: NormalizedWorkflowStep, context: WorkflowStepExecutionContext) =>
          this.executeWorkflowToolStep(step, context),
        onAgentStep: (step: NormalizedWorkflowStep, context: WorkflowStepExecutionContext) =>
          this.executeWorkflowAgentStep(step, context),
      };

      const envelope = request.kind === "run"
        ? await executeWorkflowRun(executionId, compiled.workflow, runPayload, hooks)
        : await executeWorkflowResume(
            executionId,
            compiled.workflow,
            runPayload,
            request.resumeToken || "",
            request.decision === "deny" ? "deny" : "approve",
            hooks,
          );

      this.agentClient.sendWorkflowExecutionResult(executionId, {
        ok: envelope.ok,
        status: envelope.status,
        executionId: envelope.executionId,
        output: envelope.output,
        steps: envelope.steps,
        requiresApproval: envelope.requiresApproval,
        error: envelope.error,
      });
      this.agentClient.sendAgentStatus("idle");
      this.agentClient.sendComplete();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await fail(message);
    } finally {
      this.workflowExecutionModel = previousWorkflowModel;
      this.workflowExecutionModelPreferences = previousWorkflowModelPrefs;
    }
  }

  async handleWorkflowExecutionDispatch(
    executionId: string,
    payload: WorkflowExecutionDispatchPayload,
    model?: string,
    modelPreferences?: string[],
  ): Promise<void> {
    const request: WorkflowExecutionDispatchPayload = {
      ...payload,
      executionId: payload.executionId || executionId,
    };
    await this.handleWorkflowExecutionPrompt(`workflow:${executionId}`, request, {
      emitChatError: false,
      model,
      modelPreferences,
    });
  }

  private async executeWorkflowToolStep(
    step: NormalizedWorkflowStep,
    _context: WorkflowStepExecutionContext,
  ): Promise<WorkflowStepExecutionResult | void> {
    if (typeof step.tool !== "string") {
      return;
    }

    const tool = step.tool;
    const args = isRecord(step.arguments) ? step.arguments : {};

    switch (tool) {
      case "spawn_session": {
        const task = typeof args.task === "string" ? args.task.trim() : "";
        const workspace = typeof args.workspace === "string" ? args.workspace.trim() : "";
        if (!task || !workspace) {
          return { status: "failed", error: "spawn_session requires task and workspace" };
        }
        const result = await this.agentClient.requestSpawnChild({
          task,
          workspace,
          repoUrl: typeof args.repoUrl === "string" ? args.repoUrl : undefined,
          branch: typeof args.branch === "string" ? args.branch : undefined,
          ref: typeof args.ref === "string" ? args.ref : undefined,
          title: typeof args.title === "string" ? args.title : undefined,
          model: typeof args.model === "string" ? args.model : undefined,
        });
        return {
          status: "completed",
          output: { tool, childSessionId: result.childSessionId },
        };
      }

      case "send_message": {
        const targetSessionId = typeof args.targetSessionId === "string" ? args.targetSessionId.trim() : "";
        const content = typeof args.content === "string" ? args.content : "";
        if (!targetSessionId || !content) {
          return { status: "failed", error: "send_message requires targetSessionId and content" };
        }
        const interrupt = args.interrupt === true;
        const result = await this.agentClient.requestSendMessage(targetSessionId, content, interrupt);
        return {
          status: "completed",
          output: { tool, targetSessionId, success: result.success },
        };
      }

      case "list_workflows": {
        const result = await this.agentClient.requestListWorkflows();
        return { status: "completed", output: { tool, workflows: result.workflows } };
      }

      case "run_workflow": {
        const workflowId = typeof args.workflowId === "string" ? args.workflowId.trim() : "";
        if (!workflowId) {
          return { status: "failed", error: "run_workflow requires workflowId" };
        }
        const variables = isRecord(args.variables) ? args.variables : undefined;
        const repoUrl = typeof args.repoUrl === "string" ? args.repoUrl.trim() : "";
        const branch = typeof args.branch === "string" ? args.branch.trim() : "";
        const ref = typeof args.ref === "string" ? args.ref.trim() : "";
        const sourceRepoFullName = typeof args.sourceRepoFullName === "string" ? args.sourceRepoFullName.trim() : "";
        const result = await this.agentClient.requestRunWorkflow(
          workflowId,
          variables,
          {
            repoUrl: repoUrl || undefined,
            branch: branch || undefined,
            ref: ref || undefined,
            sourceRepoFullName: sourceRepoFullName || undefined,
          },
        );
        return { status: "completed", output: { tool, execution: result.execution } };
      }

      case "list_workflow_executions": {
        const workflowId = typeof args.workflowId === "string" ? args.workflowId : undefined;
        const limit = typeof args.limit === "number" ? args.limit : undefined;
        const result = await this.agentClient.requestListWorkflowExecutions(workflowId, limit);
        return { status: "completed", output: { tool, executions: result.executions } };
      }
    }

    return;
  }

  private async executeWorkflowAgentStep(
    step: NormalizedWorkflowStep,
    context: WorkflowStepExecutionContext,
  ): Promise<WorkflowStepExecutionResult | void> {
    if (step.type !== "agent_message") {
      return;
    }

    const content = (
      typeof step.content === "string"
        ? step.content
        : typeof step.message === "string"
          ? step.message
          : typeof step.goal === "string"
            ? step.goal
            : ""
    ).trim();

    if (!content) {
      return { status: "failed", error: "agent_message requires content/message/goal" };
    }

    if (!this.runnerSessionId) {
      return { status: "failed", error: "agent_message unavailable: runner session id is missing" };
    }

    const interrupt = step.interrupt === true;
    const awaitResponse = step.await_response === true || step.awaitResponse === true;
    const awaitTimeoutRaw =
      typeof step.await_timeout_ms === "number"
        ? step.await_timeout_ms
        : typeof step.awaitTimeoutMs === "number"
          ? step.awaitTimeoutMs
          : 120_000;
    const awaitTimeoutMs = Math.max(1_000, Math.min(awaitTimeoutRaw, 900_000));
    const previousChannel = this.activeChannel;
    const modelChain = this.buildModelFailoverChain(
      this.workflowExecutionModel,
      this.workflowExecutionModelPreferences,
    );
    const preferredModel = modelChain[0];

    try {
      const workflowChannelType = "workflow";
      const workflowChannelId = context.executionId;
      const channel = this.getOrCreateChannel(workflowChannelType, workflowChannelId);
      this.activeChannel = channel;
      await this.ensureChannelOpenCodeSession(channel);

      this.agentClient.sendWorkflowChatMessage("user", content, {
        workflowExecutionId: context.executionId,
        workflowStepId: step.id,
        kind: "agent_message",
      }, {
        channelType: workflowChannelType,
        channelId: workflowChannelId,
        opencodeSessionId: channel.opencodeSessionId ?? undefined,
      });

      if (interrupt) {
        const sessionId = channel.opencodeSessionId;
        if (sessionId) {
          await fetch(`${this.opencodeUrl}/session/${sessionId}/abort`, { method: "POST" }).catch(() => undefined);
        }
      }

      if (!awaitResponse) {
        await this.sendPromptToChannelWithRecovery(channel, content, {
          model: preferredModel,
          channelType: workflowChannelType,
          channelId: workflowChannelId,
        });
        return {
          status: "completed",
          output: {
            type: "agent_message",
            targetSessionId: this.runnerSessionId,
            content,
            interrupt,
            awaitResponse: false,
            success: true,
          },
        };
      }

      const attemptSessionIds = new Set<string>();
      try {
        let lastFailure: string | null = null;
        const candidates = modelChain.length > 0 ? modelChain : [undefined];

        for (const modelCandidate of candidates) {
          channel.resetPromptState();
          channel.lastError = null;
          let sessionId = await this.ensureChannelOpenCodeSession(channel);
          this.ephemeralContent.set(sessionId, "");
          attemptSessionIds.add(sessionId);
          let idlePromise = this.pollUntilIdle(sessionId, awaitTimeoutMs);

          const sentSessionId = await this.sendPromptToChannelWithRecovery(channel, content, {
            model: modelCandidate,
            channelType: workflowChannelType,
            channelId: workflowChannelId,
          });
          if (sentSessionId !== sessionId) {
            this.ephemeralContent.delete(sessionId);
            this.idleWaiters.delete(sessionId);
            sessionId = sentSessionId;
            this.ephemeralContent.set(sessionId, "");
            attemptSessionIds.add(sessionId);
            idlePromise = this.pollUntilIdle(sessionId, awaitTimeoutMs);
          }

          await idlePromise;

          const responseText = (this.ephemeralContent.get(sessionId) || "").trim();
          const stepError = channel.lastError || null;

          let recoveredResponse = responseText;
          if (!recoveredResponse) {
            const recovered = await this.recoverAssistantTextOrError();
            if (recovered.text) {
              recoveredResponse = recovered.text;
            } else if (recovered.error) {
              lastFailure = recovered.error;
              channel.lastError = recovered.error;
              this.lastError = recovered.error;
              if (!isRetriableProviderError(recovered.error)) {
                break;
              }
              continue;
            }
          }

          if (recoveredResponse) {
            this.agentClient.sendWorkflowChatMessage("assistant", recoveredResponse, {
              workflowExecutionId: context.executionId,
              workflowStepId: step.id,
              kind: "agent_message_response",
            }, {
              channelType: workflowChannelType,
              channelId: workflowChannelId,
              opencodeSessionId: channel.opencodeSessionId ?? undefined,
            });

            return {
              status: "completed",
              output: {
                type: "agent_message",
                targetSessionId: this.runnerSessionId,
                content,
                interrupt,
                awaitResponse: true,
                awaitTimeoutMs,
                response: recoveredResponse,
                model: modelCandidate || null,
              },
            };
          }

          if (stepError) {
            lastFailure = stepError;
            if (!isRetriableProviderError(stepError)) {
              break;
            }
          } else {
            lastFailure = "agent_message_empty_response";
          }
        }

        return {
          status: "failed",
          error: lastFailure || "agent_message_empty_response",
          output: {
            type: "agent_message",
            targetSessionId: this.runnerSessionId,
            content,
            interrupt,
            awaitResponse: true,
            awaitTimeoutMs,
          },
        };
      } finally {
        for (const sessionId of attemptSessionIds) {
          this.ephemeralContent.delete(sessionId);
          this.idleWaiters.delete(sessionId);
        }
      }
    } catch (error) {
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        output: {
          type: "agent_message",
          targetSessionId: this.runnerSessionId,
          content,
          interrupt,
        },
      };
    } finally {
      this.activeChannel = previousChannel;
    }
  }

  /**
   * Start the global SSE event subscription. Call once at startup.
   */
  async startEventStream(): Promise<void> {
    if (this.eventStreamActive) return;

    // Abort any lingering previous stream reader
    if (this.eventStreamAbort) {
      this.eventStreamAbort.abort();
      this.eventStreamAbort = null;
    }

    this.eventStreamActive = true;
    const abort = new AbortController();
    this.eventStreamAbort = abort;

    console.log("[PromptHandler] Subscribing to OpenCode event stream");
    this.consumeEventStream(abort.signal).catch((err) => {
      if (abort.signal.aborted) return; // intentional teardown
      console.error("[PromptHandler] Event stream failed:", err);
      this.eventStreamActive = false;
      // Retry after delay
      setTimeout(() => this.startEventStream(), 3000);
    });
  }

  async handlePrompt(messageId: string, content: string, model?: string, author?: { authorId?: string; gitName?: string; gitEmail?: string; authorName?: string; authorEmail?: string }, modelPreferences?: string[], attachments?: PromptAttachment[], channelType?: string, channelId?: string, opencodeSessionId?: string, continuationContext?: string, threadId?: string, replyChannelType?: string, replyChannelId?: string): Promise<void> {
    console.log(`[PromptHandler] Handling prompt ${messageId}: "${content.slice(0, 80)}"${model ? ` (model: ${model})` : ''}${author?.authorName ? ` (by: ${author.authorName})` : ''}${modelPreferences?.length ? ` (prefs: ${modelPreferences.length})` : ''}${attachments?.length ? ` (attachments: ${attachments.length})` : ''}${channelType ? ` (channel: ${channelType})` : ''}${continuationContext ? ' (with continuation context)' : ''}`);

    // Resolve per-channel session
    const channel = this.getOrCreateChannel(channelType, channelId);
    this.activeChannel = channel;
    // Store the orchestrator threadId so it flows through to message.create
    channel.promptThreadId = threadId ?? undefined;
    // Store original channel info for [via ...] attribution prefix
    this.pendingReplyChannelType = replyChannelType;
    this.pendingReplyChannelId = replyChannelId;
    this.applyPersistedOpenCodeSessionId(channel, opencodeSessionId);

    try {
      // If continuation context is provided, inject it as a context-setting first message
      // before the actual user prompt. This happens when the user clicks "Continue" on an
      // old thread and the DO generates a summary of the previous conversation.
      if (continuationContext) {
        console.log(`[PromptHandler] Injecting continuation context (${continuationContext.length} chars) for thread resumption`);
        await this.ensureChannelOpenCodeSession(channel);
        const sessionId = channel.opencodeSessionId!;

        const contextPrompt = `You are continuing a conversation from a previous thread. Here is the context from that conversation:\n\n---\n\n${continuationContext}\n\n---\n\nThe user may reference topics from this previous conversation. Continue naturally.`;

        const idlePromise = this.pollUntilIdle(sessionId, 60_000);
        await this.sendPromptAsync(sessionId, contextPrompt);
        await idlePromise;
        console.log(`[PromptHandler] Continuation context injected successfully`);
      }

      // Set git config for author attribution before processing
      if (author?.gitName || author?.authorName) {
        const name = author.gitName || author.authorName;
        const email = author.gitEmail || author.authorEmail;
        try {
          const nameProc = Bun.spawn(['git', 'config', '--global', 'user.name', name!]);
          await nameProc.exited;
          if (email) {
            const emailProc = Bun.spawn(['git', 'config', '--global', 'user.email', email]);
            await emailProc.exited;
          }
        } catch (err) {
          console.warn('[PromptHandler] Failed to set git config:', err);
        }
      }

      // If there's a pending response from a previous prompt on this channel, finalize it first
      if (channel.activeMessageId && channel.hasActivity) {
        console.log(`[PromptHandler] Finalizing previous response before new prompt`);
        this.finalizeResponse();
      }

      // Clear any pending timeout from previous prompt
      this.clearResponseTimeout();
      this.clearFirstResponseTimeout();

      // Ensure this channel has an OpenCode session and active SSE stream.
      await this.ensureChannelOpenCodeSession(channel);

      channel.activeMessageId = messageId;
      channel.resetPromptState();

      // Build failover chain with explicit model first (if provided), then
      // user preferences. This keeps failover anchored to the actual selected model.
      const failoverChain = this.buildModelFailoverChain(model, modelPreferences);

      // Transcribe audio attachments before sending to OpenCode
      let effectiveContent = content;
      let effectiveAttachments = attachments ?? [];
      const hasAudio = effectiveAttachments.some(a => a.mime.startsWith('audio/'));
      if (hasAudio) {
        let transcribed = false;
        try {
          const { transcriptions, remaining } = await this.transcribeAudioAttachments(effectiveAttachments);
          if (transcriptions.length > 0) {
            transcribed = true;
            const transcriptText = transcriptions.join('\n\n');
            const transcriptBlock = transcriptions.map(t => `[Transcribed voice note]\n${t}`).join('\n\n');
            effectiveContent = effectiveContent
              ? `${transcriptBlock}\n\n${effectiveContent}`
              : transcriptBlock;
            // Send transcript back to DO so UI can display it alongside audio player
            this.agentClient.sendAudioTranscript(messageId, transcriptText);
          }
          effectiveAttachments = remaining;
        } catch (err) {
          console.error('[PromptHandler] Failed to transcribe audio:', err);
        }
        // Strip audio from what goes to OpenCode — it can't process audio files
        effectiveAttachments = effectiveAttachments.filter(a => !a.mime.startsWith('audio/'));
        // If transcription failed and content is empty, provide a fallback so the prompt isn't empty
        if (!transcribed && !effectiveContent?.trim()) {
          effectiveContent = '[The user sent a voice note but transcription is unavailable. Please ask them to type their message instead.]';
        }
      }

      // Extract text from PDF attachments before sending to OpenCode
      const hasPdf = effectiveAttachments.some(a => a.mime === 'application/pdf');
      if (hasPdf) {
        let pdfExtracted = false;
        try {
          const { extractions, remaining } = await this.extractPdfText(effectiveAttachments);
          effectiveAttachments = remaining; // remaining already excludes successfully processed PDFs
          if (extractions.length > 0) {
            pdfExtracted = true;
            const pdfBlock = extractions
              .map(e => `[Extracted text from ${e.filename || 'PDF'}]\n${e.text}`)
              .join('\n\n');
            effectiveContent = effectiveContent
              ? `${pdfBlock}\n\n${effectiveContent}`
              : pdfBlock;
          }
        } catch (err) {
          console.error('[PromptHandler] Failed to extract PDF text:', err);
        }
        // Strip any remaining PDFs — OpenCode can't process raw PDF files
        effectiveAttachments = effectiveAttachments.filter(a => a.mime !== 'application/pdf');
        if (!pdfExtracted && !effectiveContent?.trim()) {
          effectiveContent = '[The user sent a PDF but text extraction failed. Please ask them to share the content as text instead.]';
        }
      }

      // Store failover state (use post-transcription values so model failover doesn't re-transcribe)
      this.currentModelPreferences = failoverChain.length > 0 ? failoverChain : undefined;
      this.pendingRetryContent = effectiveContent;
      this.pendingRetryAttachments = effectiveAttachments;
      this.pendingRetryAuthor = author;

      // Determine which model to use: explicit model takes priority, then first preference
      this.currentModelIndex = 0;

      // Notify client that agent is thinking
      this.agentClient.sendAgentStatus("thinking");
      this.awaitingAssistantForAttempt = true;
      this.lastPromptSentAt = Date.now();

      // Mark sync prompt in flight so SSE-side finalizeResponse is suppressed
      channel.syncPromptInFlight = true;

      // Synchronous failover loop — try each model in the chain.
      // If the chain is empty (no explicit model, no user/org preferences), fall back
      // to the first model discovered from connected providers to avoid OpenCode
      // picking its own internal default (which may be a wrong/unexpected provider).
      let modelsToTry: (string | undefined)[];
      if (failoverChain.length > 0) {
        modelsToTry = failoverChain;
      } else if (this.discoveredDefaultModel) {
        console.log(`[PromptHandler] No model specified and no preferences — using discovered default: ${this.discoveredDefaultModel}`);
        modelsToTry = [this.discoveredDefaultModel];
      } else {
        modelsToTry = [undefined];
      }
      let lastModelError: string | null = null;

      for (let i = 0; i < modelsToTry.length; i++) {
        const currentModel = modelsToTry[i];
        this.currentModelIndex = i;

        if (i > 0) {
          // Not first attempt — notify DO, reset, send thinking
          const fromModel = modelsToTry[i - 1] || "default";
          const toModel = currentModel || "default";
          console.log(`[PromptHandler] Failing over from ${fromModel} to ${toModel} due to: ${lastModelError}`);
          if (this.activeMessageId) {
            this.agentClient.sendModelSwitched(this.activeMessageId, fromModel, toModel, lastModelError || "Model failed");
          }
          channel.resetForRetry();
          channel.syncPromptInFlight = true; // Re-set after resetForRetry clears it
          this.agentClient.sendAgentStatus("thinking");
          this.awaitingAssistantForAttempt = true;
        }

        // Create an AbortController with a hard timeout to prevent blocking forever
        // when OpenCode enters an internal provider retry loop (repeated 429/5xx).
        const syncAbort = new AbortController();
        const sessionId = channel.opencodeSessionId;
        const syncTimeoutId = setTimeout(() => {
          console.log(`[PromptHandler] Sync prompt timeout (${SYNC_PROMPT_TIMEOUT_MS}ms) — aborting fetch and OpenCode session`);
          syncAbort.abort();
          // Abort the OpenCode session to stop its internal retry loop
          if (sessionId) {
            fetch(`${this.opencodeUrl}/session/${sessionId}/abort`, { method: "POST" }).catch(() => undefined);
          }
        }, SYNC_PROMPT_TIMEOUT_MS);

        try {
          console.log(`[PromptHandler] Sending sync prompt ${messageId} (channel: ${channel.channelKey})${currentModel ? ` (model: ${currentModel})` : ''}`);
          const { result } = await this.sendPromptSyncWithRecovery(channel, effectiveContent, {
            model: currentModel,
            attachments: effectiveAttachments,
            author,
            channelType,
            channelId,
            signal: syncAbort.signal,
          });
          console.log(`[PromptHandler] Sync prompt ${messageId} returned (channel: ${channel.channelKey}) result=${result ? 'present' : 'null'}`);

          // Extract text and error from the sync response
          const info = result?.info as Record<string, unknown> | undefined;
          const responseText = info ? this.extractAssistantTextFromMessageInfo(info) : null;
          const responseError = info ? this.extractAssistantErrorFromMessageInfo(info) : null;
          const errorMsg = responseError || this.lastError;

          console.log(
            `[PromptHandler] Sync response analysis for ${messageId}: ` +
            `responseText=${responseText ? responseText.length + ' chars' : 'null'} ` +
            `responseError=${responseError ?? 'null'} ` +
            `lastError=${this.lastError ?? 'null'} ` +
            `hasActivity=${this.hasActivity} ` +
            `streamedContent=${this.streamedContent.length} chars ` +
            `toolStates=${this.toolStates.size} ` +
            `assistantMsgIds=${this.activeAssistantMessageIds.size}`
          );

          if (errorMsg && isRetriableProviderError(errorMsg)) {
            // Retriable error — continue to next model
            lastModelError = errorMsg;
            console.log(`[PromptHandler] Retriable error for ${messageId}: ${errorMsg} — trying next model`);
            continue;
          }

          if (!responseText && !errorMsg && !this.hasActivity) {
            // Empty response with no SSE activity — continue to next model
            lastModelError = "Model returned an empty response";
            console.log(`[PromptHandler] Empty response for ${messageId} with no activity — trying next model`);
            continue;
          }

          // Success (or non-retriable error) — finalize and return
          await this.finalizeSyncResponse(responseText, errorMsg || null);
          return;
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          // Treat sync timeout abort as a retriable error for failover
          if (syncAbort.signal.aborted) {
            lastModelError = "Model did not respond (sync prompt timed out)";
            console.log(`[PromptHandler] Sync prompt timed out for ${messageId} — trying next model`);
            continue;
          }
          if (isRetriableProviderError(errMsg)) {
            lastModelError = errMsg;
            console.log(`[PromptHandler] Retriable exception for ${messageId}: ${errMsg} — trying next model`);
            continue;
          }
          // Non-retriable exception — finalize with error
          await this.finalizeSyncResponse(null, errMsg);
          return;
        } finally {
          clearTimeout(syncTimeoutId);
        }
      }

      // All models exhausted
      const exhaustedError = this.buildFailoverExhaustedError(
        lastModelError || "The model did not respond."
      );
      console.log(`[PromptHandler] All models exhausted for ${messageId}: ${exhaustedError}`);
      await this.finalizeSyncResponse(null, exhaustedError);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[PromptHandler] Error processing prompt:", errorMsg);
      this.agentClient.sendError(messageId, errorMsg);
      this.agentClient.sendComplete();
      this.agentClient.sendAgentStatus("idle");
    }
  }

  /**
   * Build a user-facing error message when all failover models are exhausted.
   * References the originally selected model (index 0) and mentions how many
   * fallback models were also tried, so the user doesn't see a model name they
   * never selected.
   */
  private buildFailoverExhaustedError(lastModelError: string): string {
    const chain = this.currentModelPreferences;
    if (!chain || chain.length === 0) return lastModelError;

    const primaryModel = chain[0];
    const triedCount = Math.min((this.currentModelIndex ?? 0) + 1, chain.length);

    if (triedCount <= 1) {
      // No failover happened — just show the primary model error
      return lastModelError;
    }

    const fallbackCount = triedCount - 1;
    return (
      `Model ${primaryModel} did not respond. ` +
      `Tried ${fallbackCount} fallback model${fallbackCount > 1 ? "s" : ""} — none responded. ` +
      `Try again or switch to a different model.`
    );
  }

  /**
   * Finalize a sync prompt response. Handles turn creation, turn finalization,
   * stuck tool flushing, completion/idle signals, usage reporting, memory flush,
   * and state cleanup.
   */
  private async finalizeSyncResponse(content: string | null, error: string | null): Promise<void> {
    // Clear any pending timeouts
    this.clearResponseTimeout();
    this.clearFirstResponseTimeout();

    const messageId = this.activeMessageId;
    // Also consider streamed content from SSE events that arrived during the sync call
    const effectiveContent = content || this.streamedContent || this.latestAssistantTextSnapshot;

    if (effectiveContent) {
      console.log(`[PromptHandler] Sync finalize: success for ${messageId} (${effectiveContent.length} chars)`);
      this.ensureTurnCreated();
      this.agentClient.sendTurnFinalize(this.turnId!, "end_turn", effectiveContent);
    } else if (error) {
      console.log(`[PromptHandler] Sync finalize: error for ${messageId}: ${error}`);
      this.ensureTurnCreated();
      this.agentClient.sendTurnFinalize(this.turnId!, "error", undefined, error);
    } else if (this.toolStates.size > 0) {
      // Tools ran but no text was produced — this is normal for tool-only turns
      console.log(`[PromptHandler] Sync finalize: tools-only for ${messageId} (${this.toolStates.size} tools ran)`);
      this.ensureTurnCreated();
      this.agentClient.sendTurnFinalize(this.turnId!, "end_turn");
    } else {
      // Truly empty response
      console.log(`[PromptHandler] Sync finalize: empty response for ${messageId}`);
      this.ensureTurnCreated();
      this.agentClient.sendTurnFinalize(this.turnId!, "error", undefined, "The model did not respond.");
    }

    // Flush any tools still in non-terminal state as "completed"
    for (const [callID, { status, toolName }] of this.toolStates) {
      if (status === "pending" || status === "running") {
        console.log(`[PromptHandler] Flushing stuck tool "${toolName}" [${callID}] as completed (was: ${status})`);
        this.agentClient.sendToolUpdate(this.turnId!, callID, toolName, "completed");
      }
    }

    console.log(`[PromptHandler] Sending complete`);

    // Emit llm_response timing with token counts for throughput analysis
    if (this.lastPromptSentAt > 0) {
      const durationMs = Date.now() - this.lastPromptSentAt;
      const usageChannel = this.activeChannel;
      let inputTokens = 0;
      let outputTokens = 0;
      if (usageChannel) {
        for (const entry of usageChannel.usageEntries.values()) {
          inputTokens += entry.inputTokens;
          outputTokens += entry.outputTokens;
        }
      }
      this.agentClient.sendAnalyticsEvents([{
        eventType: 'llm_response',
        durationMs,
        properties: {
          input_tokens: inputTokens,
          output_tokens: outputTokens,
          tokens_per_sec: durationMs > 0 ? Math.round((outputTokens / durationMs) * 1000) : 0,
        },
      }]);
      this.lastPromptSentAt = 0;
    }

    this.agentClient.sendComplete();
    this.agentClient.sendAgentStatus("idle");

    // Emit usage report for this turn
    const usageChannel = this.activeChannel;
    if (usageChannel && usageChannel.usageEntries.size > 0 && usageChannel.turnId) {
      const entries = Array.from(usageChannel.usageEntries.entries()).map(
        ([ocMessageId, data]) => ({
          ocMessageId,
          model: data.model,
          inputTokens: data.inputTokens,
          outputTokens: data.outputTokens,
        })
      );
      this.agentClient.sendUsageReport(usageChannel.turnId, entries);
      usageChannel.usageEntries.clear();
    }

    // Check for pre-compaction memory flush after each turn
    const flushChannel = this.activeChannel;
    if (flushChannel && !flushChannel.memoryFlushInProgress) {
      flushChannel.turnCount++;
      this.checkAndTriggerMemoryFlush(flushChannel).catch(err =>
        console.warn("[PromptHandler] Memory flush check failed:", err)
      );
    }

    // Report files changed after each turn
    this.reportFilesChanged().catch((err) =>
      console.error("[PromptHandler] Error reporting files changed:", err)
    );

    this.cleanupAfterFinalize();
  }

  /**
   * Reset all per-prompt state after finalization. Shared by both
   * finalizeSyncResponse and finalizeResponse.
   */
  private cleanupAfterFinalize(): void {
    this.streamedContent = "";
    this.hasActivity = false;
    this.hadToolSinceLastText = false;
    this.activeMessageId = null;
    this.lastChunkTime = 0;
    this.lastError = null;
    this.toolStates.clear();
    this.textPartSnapshots.clear();
    this.messageTextSnapshots.clear();
    this.messageRoles.clear();
    this.activeAssistantMessageIds.clear();
    this.latestAssistantTextSnapshot = "";
    this.recentEventTrace = [];
    this.awaitingAssistantForAttempt = false;
    this.turnCreated = false;
    this.turnId = null;
    // Clear failover state
    this.currentModelPreferences = undefined;
    this.currentModelIndex = 0;
    this.pendingRetryContent = null;
    this.pendingRetryAttachments = [];
    this.pendingRetryAuthor = undefined;
    this.retryPending = false;
    this.finalizeInFlight = false;
    if (this.activeChannel) this.activeChannel.syncPromptInFlight = false;
    console.log(`[PromptHandler] Response finalized`);
  }

  /**
   * Attempt to failover to the next model in preferences.
   * Returns true if failover was initiated, false if no more models.
   */
  private async attemptModelFailover(errorMsg: string): Promise<boolean> {
    if (!this.currentModelPreferences || this.currentModelPreferences.length === 0) {
      return false;
    }

    const nextIndex = this.currentModelIndex + 1;
    if (nextIndex >= this.currentModelPreferences.length) {
      console.log(`[PromptHandler] No more models to failover to (tried ${this.currentModelPreferences.length})`);
      return false;
    }

    const fromModel = this.currentModelPreferences[this.currentModelIndex] || "default";
    const toModel = this.currentModelPreferences[nextIndex];
    this.currentModelIndex = nextIndex;

    console.log(`[PromptHandler] Failing over from ${fromModel} to ${toModel} due to: ${errorMsg}`);

    // Notify DO about the switch
    if (this.activeMessageId) {
      this.agentClient.sendModelSwitched(this.activeMessageId, fromModel, toModel, errorMsg);
    }

    // Reset stream state for retry (keep activeMessageId)
    if (this.activeChannel) this.activeChannel.resetForRetry();

    // Retry with next model
    try {
      this.agentClient.sendAgentStatus("thinking");
      this.awaitingAssistantForAttempt = true;
      const activeChannel = this.activeChannel;
      if (!activeChannel) throw new Error("No active channel for failover retry");
      const channelContext = this.extractChannelContext(activeChannel);
      await this.sendPromptToChannelWithRecovery(activeChannel, this.pendingRetryContent!, {
        model: toModel,
        attachments: this.pendingRetryAttachments,
        author: this.pendingRetryAuthor,
        channelType: channelContext.channelType,
        channelId: channelContext.channelId,
      });
      console.log(`[PromptHandler] Retry sent with model ${toModel}`);
      this.startFirstResponseTimeout();
      return true;
    } catch (err) {
      console.error(`[PromptHandler] Failed to retry with model ${toModel}:`, err);
      return false;
    }
  }

  async handleAnswer(questionId: string, answer: string | boolean): Promise<void> {
    if (!this.sessionId) return;
    if (await this.handleQuestionReply(questionId, answer)) return;

    const response =
      answer === false || answer === "__expired__"
        ? "reject"
        : "always";
    await this.respondToPermission(questionId, response);
  }

  private async approvePermission(permissionId: string): Promise<void> {
    await this.respondToPermission(permissionId, "always");
  }

  private async respondToPermission(permissionId: string, response: "once" | "always" | "reject"): Promise<void> {
    if (!this.sessionId) return;
    await this.respondToPermissionOnSession(this.sessionId, permissionId, response);
  }

  private async respondToPermissionOnSession(sessionId: string, permissionId: string, response: "once" | "always" | "reject"): Promise<void> {
    try {
      const url = `${this.opencodeUrl}/session/${sessionId}/permissions/${permissionId}`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ response }),
      });
      console.log(`[PromptHandler] Permission ${permissionId} → ${response}: ${res.status}`);
    } catch (err) {
      console.error("[PromptHandler] Error responding to permission:", err);
    }
  }

  private async handleQuestionReply(promptId: string, answer: string | boolean): Promise<boolean> {
    const mapping = this.promptToQuestion.get(promptId);
    if (!mapping) return false;

    this.promptToQuestion.delete(promptId);
    const request = this.pendingQuestionRequests.get(mapping.requestID);
    if (!request) return true;

    if (answer === "__expired__") {
      await this.rejectQuestionRequest(mapping.requestID, "expired");
      return true;
    }

    const normalized = this.normalizeQuestionAnswer(answer);
    request.answers[mapping.index] = normalized;

    const complete = request.answers.every((item) => item !== null);
    if (!complete) return true;

    const answers = request.answers.map((item) => item ?? []);
    await this.replyQuestionRequest(mapping.requestID, answers);
    return true;
  }

  private normalizeQuestionAnswer(answer: string | boolean): string[] {
    if (answer === true) return ["true"];
    if (answer === false) return ["false"];
    const trimmed = String(answer).trim();
    if (!trimmed || trimmed === "__expired__") return [];
    return [trimmed];
  }

  private async replyQuestionRequest(requestID: string, answers: string[][]): Promise<void> {
    try {
      const url = `${this.opencodeUrl}/question/${requestID}/reply`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ answers }),
      });
      console.log(`[PromptHandler] Question ${requestID} replied: ${res.status}`);
      if (!res.ok) {
        const body = await res.text().catch(() => "");
        console.warn(`[PromptHandler] Question reply failed: ${res.status} ${body}`);
      }
    } catch (err) {
      console.error("[PromptHandler] Error replying to question:", err);
    } finally {
      this.clearQuestionRequest(requestID);
    }
  }

  private async rejectQuestionRequest(requestID: string, reason: "expired" | "rejected"): Promise<void> {
    try {
      const url = `${this.opencodeUrl}/question/${requestID}/reject`;
      const res = await fetch(url, { method: "POST" });
      console.log(`[PromptHandler] Question ${requestID} rejected (${reason}): ${res.status}`);
    } catch (err) {
      console.error("[PromptHandler] Error rejecting question:", err);
    } finally {
      this.clearQuestionRequest(requestID);
    }
  }

  private clearQuestionRequest(requestID: string): void {
    this.pendingQuestionRequests.delete(requestID);
    for (const [promptID, mapping] of this.promptToQuestion.entries()) {
      if (mapping.requestID === requestID) {
        this.promptToQuestion.delete(promptID);
      }
    }
  }

  private handleQuestionAsked(properties: Record<string, unknown>): void {
    const requestID = typeof properties.id === "string" ? properties.id : "";
    const questionsRaw = Array.isArray(properties.questions) ? properties.questions : [];
    const parsedQuestions = questionsRaw
      .map((entry) => this.parseQuestionInfo(entry))
      .filter((entry): entry is { text: string; options?: string[] } => !!entry);

    if (!requestID || parsedQuestions.length === 0) {
      console.warn("[PromptHandler] question.asked missing request id or questions");
      return;
    }

    this.clearQuestionRequest(requestID);
    this.pendingQuestionRequests.set(requestID, {
      answers: Array.from({ length: parsedQuestions.length }, () => null),
    });

    parsedQuestions.forEach((question, index) => {
      const promptID = parsedQuestions.length === 1 ? requestID : `${requestID}:${index}`;
      this.promptToQuestion.set(promptID, { requestID, index });
      this.agentClient.sendQuestion(promptID, question.text, question.options);
    });
  }

  private parseQuestionInfo(input: unknown): { text: string; options?: string[] } | null {
    if (!isRecord(input)) return null;
    const question = input as OpenCodeQuestionInfo;

    const questionText = typeof question.question === "string" ? question.question.trim() : "";
    const header = typeof question.header === "string" ? question.header.trim() : "";
    if (!questionText && !header) return null;

    const text = header && questionText ? `${header}: ${questionText}` : (questionText || header);

    const optionLabels = Array.isArray(question.options)
      ? question.options
          .map((opt) => (isRecord(opt) && typeof opt.label === "string" ? opt.label.trim() : ""))
          .filter(Boolean)
      : [];

    if (question.multiple) {
      const hint = optionLabels.length
        ? `\nOptions: ${optionLabels.join(", ")}\nSelect one or more values (comma-separated if needed).`
        : "\nSelect one or more values (comma-separated if needed).";
      return { text: `${text}${hint}` };
    }

    return { text, options: optionLabels.length > 0 ? optionLabels : undefined };
  }

  async handleAbort(channelType?: string, channelId?: string): Promise<void> {
    // If channel is specified, abort only that channel; otherwise abort all
    const targetChannels: ChannelSession[] = [];
    if (channelType && channelId) {
      const key = ChannelSession.channelKeyFrom(channelType, channelId);
      const ch = this.channels.get(key);
      if (ch) targetChannels.push(ch);
    } else {
      // Abort all active channels
      for (const ch of this.channels.values()) {
        if (ch.opencodeSessionId) targetChannels.push(ch);
      }
    }

    if (targetChannels.length === 0) {
      // Always acknowledge the abort so the DO can drain its prompt queue.
      // Without this, queued messages would be stuck forever waiting for the
      // 'aborted' signal that triggers handlePromptComplete().
      console.log(`[PromptHandler] Abort: no active channels to abort, sending aborted ack`);
      this.agentClient.sendAborted();
      this.agentClient.sendAgentStatus("idle");
      return;
    }

    console.log(`[PromptHandler] Aborting ${targetChannels.length} channel(s): ${targetChannels.map(c => c.channelKey).join(', ')}`);

    // Clear prompt state BEFORE the fetch so the SSE handler stops
    // forwarding events immediately (handlePartUpdated checks activeMessageId)
    this.clearResponseTimeout();
    for (const ch of targetChannels) {
      ch.resetForAbort();
      ch.idleNotified = true;
    }

    // Tell DO first so clients get immediate feedback
    this.agentClient.sendAborted();
    this.agentClient.sendAgentStatus("idle");

    // Then tell OpenCode to stop generating for each channel (may be slow)
    for (const ch of targetChannels) {
      if (!ch.opencodeSessionId) continue;
      try {
        const res = await fetch(`${this.opencodeUrl}/session/${ch.opencodeSessionId}/abort`, {
          method: "POST",
        });
        console.log(`[PromptHandler] Abort response for channel ${ch.channelKey}: ${res.status}`);
      } catch (err) {
        console.error(`[PromptHandler] Error calling abort for channel ${ch.channelKey}:`, err);
      }
    }
  }

  async handleNewSession(channelType: string, channelId: string, requestId: string): Promise<void> {
    const channel = this.getOrCreateChannel(channelType, channelId);

    // Delete old OpenCode session if it exists
    if (channel.opencodeSessionId) {
      const oldId = channel.opencodeSessionId;
      this.ocSessionToChannel.delete(oldId);
      try {
        await this.deleteSession(oldId);
      } catch (err) {
        console.warn(`[PromptHandler] Failed to delete old session ${oldId}:`, err);
      }
    }

    // Create fresh session
    channel.opencodeSessionId = await this.createSession();
    this.ocSessionToChannel.set(channel.opencodeSessionId, channel);
    channel.resetPromptState();

    // Notify DO
    this.agentClient.sendChannelSessionCreated(channel.channelKey, channel.opencodeSessionId);
    this.agentClient.sendSessionReset(channelType, channelId, requestId);

    console.log(`[PromptHandler] Session rotated for ${channel.channelKey} -> ${channel.opencodeSessionId}`);
  }

  async handleRevert(doMessageId: string): Promise<void> {
    if (!this.sessionId) return;

    console.log(`[PromptHandler] Reverting from DO message ${doMessageId}`);
    const ocMessageId = this.doToOcMessageId.get(doMessageId);
    if (ocMessageId) {
      try {
        const res = await fetch(`${this.opencodeUrl}/session/${this.sessionId}/revert`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ messageID: ocMessageId }),
        });
        console.log(`[PromptHandler] Revert response: ${res.status}`);
      } catch (err) {
        console.error("[PromptHandler] Error calling revert:", err);
      }

      // Clean up mappings for the reverted message
      this.doToOcMessageId.delete(doMessageId);
      this.ocToDOMessageId.delete(ocMessageId);
    } else {
      console.warn(`[PromptHandler] No OpenCode message ID found for DO message ${doMessageId}`);
    }

    this.agentClient.sendReverted([doMessageId]);
  }

  async handleDiff(requestId: string): Promise<void> {
    if (!this.sessionId) {
      this.agentClient.sendDiff(requestId, []);
      return;
    }

    console.log(`[PromptHandler] Fetching diff for request ${requestId}`);
    try {
      const files = await this.fetchDiffFiles();
      console.log(`[PromptHandler] Diff: ${files.length} files`);
      this.agentClient.sendDiff(requestId, files);
    } catch (err) {
      console.error("[PromptHandler] Error fetching diff:", err);
      this.agentClient.sendDiff(requestId, []);
    }
  }

  async executeOpenCodeCommand(command: string, args: string | undefined, requestId: string): Promise<void> {
    if (!this.sessionId) {
      this.agentClient.sendCommandResult(requestId, command, undefined, 'No active session');
      return;
    }

    console.log(`[PromptHandler] Executing OpenCode command: /${command}${args ? ' ' + args : ''}`);
    try {
      const body: Record<string, unknown> = { command: `/${command}` };
      if (args) body.args = args;
      const res = await fetch(
        `${this.opencodeUrl}/session/${this.sessionId}/command`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        },
      );
      if (!res.ok) {
        const errText = await res.text().catch(() => res.statusText);
        this.agentClient.sendCommandResult(requestId, command, undefined, `OpenCode returned ${res.status}: ${errText}`);
        return;
      }
      const result = await res.json().catch(() => ({ ok: true }));
      this.agentClient.sendCommandResult(requestId, command, result);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[PromptHandler] OpenCode command error:`, errMsg);
      this.agentClient.sendCommandResult(requestId, command, undefined, errMsg);
    }
  }

  async handleReview(requestId: string): Promise<void> {
    console.log(`[PromptHandler] Starting review for request ${requestId}`);
    try {
      // 1. Fetch diff
      const diffFiles = await this.fetchDiffFiles();
      if (diffFiles.length === 0) {
        this.agentClient.sendReviewResult(requestId, undefined, [], "No file changes to review.");
        return;
      }

      // 2. Build review prompt
      const diffText = diffFiles
        .map((f) => `--- ${f.status.toUpperCase()}: ${f.path} ---\n${f.diff || "(no diff)"}`)
        .join("\n\n");
      const prompt = REVIEW_PROMPT + diffText;

      // 3. Create ephemeral session and register for SSE content capture
      const ephemeralId = await this.createEphemeralSession();
      this.ephemeralContent.set(ephemeralId, "");
      console.log(`[PromptHandler] Created ephemeral session ${ephemeralId} for review`);

      try {
        // 4. Register idle waiter BEFORE sending prompt (avoid race)
        const idlePromise = this.pollUntilIdle(ephemeralId, REVIEW_TIMEOUT_MS);

        // 5. Send review prompt
        await this.sendPromptAsync(ephemeralId, prompt);

        // 6. Wait until idle
        await idlePromise;

        // 7. Get accumulated content from SSE events
        const content = this.ephemeralContent.get(ephemeralId) || "";
        console.log(`[PromptHandler] Ephemeral session response: ${content.length} chars`);

        if (!content) {
          this.agentClient.sendReviewResult(requestId, undefined, diffFiles, "No response received from review session");
          return;
        }

        const parsed = parseReviewResponse(content);
        if (!parsed) {
          console.log(`[PromptHandler] Failed to parse review response, first 500 chars: ${content.slice(0, 500)}`);
          this.agentClient.sendReviewResult(requestId, undefined, diffFiles, "Failed to parse review response");
          return;
        }

        console.log(`[PromptHandler] Review complete: ${parsed.files.length} files, ${parsed.stats.critical}C/${parsed.stats.warning}W/${parsed.stats.suggestion}S`);
        this.agentClient.sendReviewResult(requestId, parsed, diffFiles);
      } finally {
        // 8. Always clean up
        this.ephemeralContent.delete(ephemeralId);
        this.idleWaiters.delete(ephemeralId);
        await this.deleteSession(ephemeralId).catch((err) =>
          console.warn(`[PromptHandler] Failed to delete ephemeral session ${ephemeralId}:`, err)
        );
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      console.error("[PromptHandler] Review error:", errorMsg);
      this.agentClient.sendReviewResult(requestId, undefined, undefined, errorMsg);
    }
  }

  private async fetchDiffFiles(): Promise<DiffFile[]> {
    if (!this.sessionId) return [];

    const res = await fetch(`${this.opencodeUrl}/session/${this.sessionId}/diff`);
    if (!res.ok) {
      console.warn(`[PromptHandler] Diff response: ${res.status}`);
      return [];
    }

    const data = await res.json() as Array<{
      file: string;
      before: string;
      after: string;
      additions: number;
      deletions: number;
    }>;

    return data.map((entry) => {
      const status: DiffFile["status"] =
        !entry.before || entry.before === "" ? "added"
        : !entry.after || entry.after === "" ? "deleted"
        : "modified";

      const patch = createTwoFilesPatch(
        `a/${entry.file}`,
        `b/${entry.file}`,
        entry.before || "",
        entry.after || "",
        undefined,
        undefined,
        { context: 3 },
      );

      return { path: entry.file, status, diff: patch };
    });
  }

  private async createEphemeralSession(): Promise<string> {
    const res = await fetch(`${this.opencodeUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Failed to create ephemeral session: ${res.status} ${body}`);
    }
    const data = (await res.json()) as { id: string };
    return data.id;
  }

  private async pollUntilIdle(sessionId: string, timeoutMs: number): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.idleWaiters.delete(sessionId);
        reject(new Error(`Idle wait timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.idleWaiters.set(sessionId, () => {
        clearTimeout(timer);
        resolve();
      });
    });
  }

  private extractStatusType(props: Record<string, unknown>): string | undefined {
    const rawStatus = props.status;
    if (typeof rawStatus === "string") return rawStatus;
    if (rawStatus && typeof rawStatus === "object") return (rawStatus as SessionStatus).type;
    return undefined;
  }

  private appendEventTrace(entry: string): void {
    this.recentEventTrace.push(entry);
    if (this.recentEventTrace.length > 40) {
      this.recentEventTrace.shift();
    }
  }

  private computeNonOverlappingSuffix(base: string, incoming: string): string {
    if (!incoming) return "";
    if (!base) return incoming;
    if (incoming.startsWith(base)) return incoming.slice(base.length);
    if (base.endsWith(incoming)) return "";

    const maxOverlap = Math.min(base.length, incoming.length);
    for (let overlap = maxOverlap; overlap > 0; overlap--) {
      if (base.slice(-overlap) === incoming.slice(0, overlap)) {
        return incoming.slice(overlap);
      }
    }
    return incoming;
  }

  /** Lazily emit message.create for turns on first content. */
  private ensureTurnCreated(): void {
    if (this.turnCreated || !this.activeMessageId) return;
    this.turnCreated = true;
    // Generate a NEW turn ID for the assistant message so it doesn't collide
    // with the user/prompt message ID (activeMessageId).
    const turnId = crypto.randomUUID();
    this.turnId = turnId;
    const channel = this.activeChannel;
    const channelContext = channel ? this.extractChannelContext(channel) : {};
    this.agentClient.sendTurnCreate(turnId, {
      channelType: channelContext.channelType,
      channelId: channelContext.channelId,
      opencodeSessionId: channel?.opencodeSessionId ?? undefined,
      threadId: channelContext.threadId,
    });
  }

  private extractAssistantTextFromMessageInfo(info: Record<string, unknown>): string | null {
    const parts = info.parts;
    if (Array.isArray(parts)) {
      let merged = "";
      for (const rawPart of parts) {
        if (!rawPart || typeof rawPart !== "object") continue;
        const part = rawPart as Record<string, unknown>;
        if (part.type !== "text") continue;
        const textSegment = typeof part.text === "string"
          ? part.text
          : typeof part.content === "string"
            ? part.content
            : "";
        if (textSegment) merged += textSegment;
      }
      if (merged.trim()) return merged;
    }

    if (typeof info.content === "string" && info.content.trim()) {
      return info.content;
    }

    return null;
  }

  private extractAssistantErrorFromMessageInfo(info: Record<string, unknown>): string | null {
    return openCodeErrorToMessage(info.error);
  }

  private extractTextFromParts(parts: unknown[]): string {
    let merged = "";
    for (const rawPart of parts) {
      if (!rawPart || typeof rawPart !== "object") continue;
      const part = rawPart as Record<string, unknown>;
      if (part.type !== "text") continue;
      const textSegment = typeof part.text === "string"
        ? part.text
        : typeof part.content === "string"
          ? part.content
          : "";
      if (textSegment) merged += textSegment;
    }
    return merged;
  }

  private async fetchAssistantMessageDetail(messageId: string): Promise<AssistantMessageRecovery> {
    if (!this.sessionId) return { text: null, error: null };
    try {
      const res = await fetch(`${this.opencodeUrl}/session/${this.sessionId}/message/${messageId}`);
      if (!res.ok) {
        console.warn(`[PromptHandler] Message detail fetch failed for ${messageId}: ${res.status}`);
        return { text: null, error: null };
      }

      const payload = await res.json() as {
        info?: OpenCodeMessageInfo;
        parts?: unknown[];
        content?: string;
      };
      const infoObj = (payload.info && typeof payload.info === "object")
        ? payload.info as Record<string, unknown>
        : payload as Record<string, unknown>;
      const role = typeof infoObj.role === "string" ? infoObj.role : undefined;
      const providerID = typeof infoObj.providerID === "string" ? infoObj.providerID : undefined;
      const modelID = typeof infoObj.modelID === "string" ? infoObj.modelID : undefined;
      const modelLabel = providerID && modelID ? `${providerID}/${modelID}` : undefined;
      const finish = typeof infoObj.finish === "string" ? infoObj.finish : undefined;
      const parts =
        Array.isArray(payload.parts) ? payload.parts
        : Array.isArray(infoObj.parts) ? infoObj.parts as unknown[]
        : [];
      const partTypes = parts
        .map((part) => (part && typeof part === "object" && "type" in part ? String((part as Record<string, unknown>).type) : "?"))
        .join(",");
      const partsText = this.extractTextFromParts(parts);
      const infoContent = typeof infoObj.content === "string"
        ? infoObj.content
        : typeof payload.content === "string"
          ? payload.content
          : "";
      const text = (partsText || infoContent || "").trim();
      const assistantError = this.extractAssistantErrorFromMessageInfo(infoObj);
      const errorName = isRecord(infoObj.error) && typeof infoObj.error.name === "string"
        ? infoObj.error.name
        : undefined;
      const tokenObj = isRecord(infoObj.tokens) ? infoObj.tokens : undefined;
      const outputTokens =
        tokenObj && typeof tokenObj.output === "number" && Number.isFinite(tokenObj.output)
          ? tokenObj.output
          : null;
      const derivedEmptyError =
        !assistantError && !text && role === "assistant"
          ? `Model ${modelLabel ?? "unknown"} returned an empty completion (finish=${finish ?? "none"}, outputTokens=${outputTokens ?? "unknown"}).`
          : null;

      console.log(
        `[PromptHandler] Message detail ${messageId}: role=${role || "unknown"} ` +
        `parts=[${partTypes}] partsText=${partsText.length} infoContent=${infoContent.length} text=${text.length} ` +
        `error=${assistantError ? "yes" : "no"}${errorName ? `(${errorName})` : ""} ` +
        `model=${modelLabel ?? "unknown"} finish=${finish ?? "none"} outputTokens=${outputTokens ?? "unknown"} ` +
        `infoKeys=[${Object.keys(infoObj).join(",")}]`
      );

      if (role !== "assistant") return { text: null, error: null };
      return {
        text: text ? text : null,
        error: assistantError ?? derivedEmptyError,
        modelLabel,
        finish,
        outputTokens,
      };
    } catch (err) {
      console.warn(`[PromptHandler] Message detail fetch error for ${messageId}:`, err);
      return { text: null, error: null };
    }
  }

  private async recoverAssistantOutcomeFromApi(): Promise<AssistantMessageRecovery | null> {
    if (!this.sessionId || this.activeAssistantMessageIds.size === 0) return null;
    const assistantIds = Array.from(this.activeAssistantMessageIds).reverse();

    for (const ocMessageId of assistantIds) {
      const result = await this.fetchAssistantMessageDetail(ocMessageId);
      if (result.text || result.error) return result;
    }
    return null;
  }

  private async recoverAssistantTextOrError(): Promise<{ text: string | null; error: string | null }> {
    const recovered = await this.recoverAssistantOutcomeFromApi();
    if (!recovered) {
      return { text: null, error: null };
    }
    return {
      text: recovered.text ? recovered.text.trim() : null,
      error: recovered.error || null,
    };
  }

  private async deleteSession(sessionId: string): Promise<void> {
    const res = await fetch(`${this.opencodeUrl}/session/${sessionId}`, {
      method: "DELETE",
    });
    console.log(`[PromptHandler] Delete ephemeral session ${sessionId}: ${res.status}`);
  }

  // ─── Pre-Compaction Memory Flush ──────────────────────────────────────

  private getModelContextLimit(channel: ChannelSession): number {
    if (channel.lastUsedModel) {
      const limit = this.modelContextLimits.get(channel.lastUsedModel);
      if (limit) return limit;
    }
    return 200_000; // Conservative default
  }

  private async checkAndTriggerMemoryFlush(channel: ChannelSession): Promise<void> {
    if (channel.memoryFlushInProgress) return;

    const totalTokens = channel.cumulativeInputTokens + channel.cumulativeOutputTokens;
    const contextLimit = this.getModelContextLimit(channel);
    const threshold = contextLimit * FLUSH_THRESHOLD_RATIO;

    const tokenTriggered = totalTokens > 0 && totalTokens >= threshold;
    const turnsSinceFlush = channel.turnCount - channel.lastFlushTurnCount;
    const turnTriggered = totalTokens === 0 && turnsSinceFlush >= FLUSH_TURN_INTERVAL;

    if (!tokenTriggered && !turnTriggered) return;

    console.log(
      `[PromptHandler] Pre-compaction flush triggered for ${channel.channelKey}: ` +
      `tokens=${totalTokens}/${contextLimit} turns=${turnsSinceFlush}`
    );
    await this.executeMemoryFlush(channel);
  }

  private async executeMemoryFlush(channel: ChannelSession): Promise<void> {
    const sessionId = channel.opencodeSessionId;
    if (!sessionId) return;

    channel.memoryFlushInProgress = true;

    let forkedSessionId: string | null = null;
    try {
      // 1. Fork the current session — clone gets full conversation history
      const forkRes = await fetch(`${this.opencodeUrl}/session/${sessionId}/fork`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
      });
      if (!forkRes.ok) {
        console.warn(`[PromptHandler] Failed to fork session for memory flush: ${forkRes.status}`);
        return;
      }
      const forkData = await forkRes.json() as { id: string };
      forkedSessionId = forkData.id;
      console.log(`[PromptHandler] Forked session ${sessionId} → ${forkedSessionId} for memory flush`);

      // 2. Register for ephemeral capture (reuses existing pattern from reviews)
      this.ephemeralContent.set(forkedSessionId, "");
      const idlePromise = this.pollUntilIdle(forkedSessionId, FLUSH_TIMEOUT_MS);

      // 3. Send flush prompt to the FORKED session
      await this.sendPromptAsync(forkedSessionId, MEMORY_FLUSH_PROMPT);

      // 4. Wait for completion
      await idlePromise;

      const response = (this.ephemeralContent.get(forkedSessionId) || "").trim();
      console.log(`[PromptHandler] Memory flush complete (${response.length} chars response)`);
    } catch (err) {
      console.warn(`[PromptHandler] Memory flush failed:`, err);
    } finally {
      // 5. Clean up: delete the forked session
      if (forkedSessionId) {
        this.ephemeralContent.delete(forkedSessionId);
        this.idleWaiters.delete(forkedSessionId);
        this.deleteSession(forkedSessionId).catch(() => {});
      }
      channel.memoryFlushInProgress = false;
      channel.lastFlushTurnCount = channel.turnCount;
    }
  }

  // ─── OpenCode HTTP API ───────────────────────────────────────────────

  private async createSession(): Promise<string> {
    const res = await fetch(`${this.opencodeUrl}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });

    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Failed to create OpenCode session: ${res.status} ${body}`);
    }

    const data = (await res.json()) as { id: string };
    console.log(`[PromptHandler] Created OpenCode session: ${data.id}`);
    return data.id;
  }

  /**
   * Called BEFORE OpenCode is stopped for a config-driven restart.
   * Cancels all in-flight prompts and tears down SSE state.
   */
  async handleOpenCodeRestart(): Promise<void> {
    console.log("[PromptHandler] Preparing for OpenCode restart");

    // Clear all response timeouts
    this.clearResponseTimeout();
    this.clearFirstResponseTimeout();

    // Finalize in-flight turns on all active channels with reason: canceled
    for (const [, channel] of this.channels) {
      if (channel.activeMessageId) {
        const turnId = channel.turnId;
        if (turnId) {
          this.agentClient.sendTurnFinalize(turnId, "canceled", undefined, "OpenCode restarting for config update");
        }
        channel.activeMessageId = null;
        channel.streamedContent = "";
        channel.hasActivity = false;
        channel.toolStates.clear();
        channel.textPartSnapshots.clear();
        channel.messageTextSnapshots.clear();
        channel.messageRoles.clear();
        channel.activeAssistantMessageIds.clear();
        channel.latestAssistantTextSnapshot = "";
        channel.recentEventTrace = [];
        channel.turnCreated = false;
        channel.turnId = null;
        channel.idleNotified = false;
      }
      // Null out session IDs — they won't survive the restart
      channel.opencodeSessionId = null;
      channel.adoptedPersistedSession = false;
    }

    // Clear reverse-lookup map
    this.ocSessionToChannel.clear();

    // Stop SSE stream — abort the reader so it doesn't linger
    this.eventStreamActive = false;
    if (this.eventStreamAbort) {
      this.eventStreamAbort.abort();
      this.eventStreamAbort = null;
    }
  }

  /**
   * Called AFTER OpenCode has restarted and is healthy again.
   * Re-subscribes to SSE and re-discovers models.
   */
  async handleOpenCodeRestarted(): Promise<void> {
    console.log("[PromptHandler] OpenCode restarted, re-initializing");

    // Re-subscribe to SSE event stream
    await this.startEventStream();

    // Re-discover available models and send to DO
    const models = await this.fetchAvailableModels();
    if (models.length > 0) {
      this.agentClient.sendModels(models);
      console.log(`[PromptHandler] Sent ${models.length} provider(s) to DO after restart`);
    }
  }

  async fetchAvailableModels(): Promise<AvailableModels> {
    try {
      const res = await fetch(`${this.opencodeUrl}/provider`);
      if (!res.ok) {
        console.warn(`[PromptHandler] Failed to fetch providers: ${res.status}`);
        return [];
      }

      // Response shape: { all: Provider[], default: {...}, connected: string[] }
      // Provider: { id, name, models: { [key]: { id, name, ... } }, ... }
      const data = await res.json() as {
        all: Array<{
          id: string;
          name: string;
          models: Record<string, { id: string; name: string; limit?: { context?: number } }>;
        }>;
        connected: string[];
      };

      if (!Array.isArray(data.all)) {
        console.warn("[PromptHandler] Unexpected /provider response shape:", JSON.stringify(data).slice(0, 200));
        return [];
      }

      // Only show providers listed in "connected" — providers must have their
      // API keys stored in ~/.local/share/opencode/auth.json (via start.sh)
      const connectedSet = new Set(data.connected || []);
      const result: AvailableModels = [];

      for (const provider of data.all) {
        if (!connectedSet.has(provider.id)) continue;
        if (!provider.models || typeof provider.models !== "object") continue;

        let models = Object.values(provider.models).map((m) => {
          // Populate context limits for pre-compaction flush detection
          if (m.limit?.context && m.limit.context > 0) {
            this.modelContextLimits.set(`${provider.id}/${m.id}`, m.limit.context);
          }
          return {
            id: `${provider.id}/${m.id}`,
            name: m.name || m.id,
          };
        });

        // Filter to admin-configured models unless showAll is enabled (works for both custom and built-in providers)
        const cpConfig = this.providerModelConfigs.get(provider.id);
        if (cpConfig && !cpConfig.showAll) {
          models = models.filter((m) => {
            // m.id is "providerId/modelId", extract the modelId portion
            const slashIdx = m.id.indexOf("/");
            const modelId = slashIdx >= 0 ? m.id.slice(slashIdx + 1) : m.id;
            return cpConfig.modelIds.has(modelId);
          });
        }

        if (models.length > 0) {
          result.push({ provider: provider.name || provider.id, models });
        }
      }

      console.log(`[PromptHandler] Discovered ${result.reduce((n, p) => n + p.models.length, 0)} models from ${result.length} providers`);

      // Cache the first discovered model as a last-resort default.
      // Prefer Anthropic models, then fall back to the first available model.
      if (!this.discoveredDefaultModel && result.length > 0) {
        const anthropicProvider = result.find((p) => p.provider.toLowerCase().includes("anthropic"));
        const firstModel = anthropicProvider?.models[0]?.id ?? result[0].models[0]?.id;
        if (firstModel) {
          this.discoveredDefaultModel = firstModel;
          console.log(`[PromptHandler] Set discovered default model: ${firstModel}`);
        }
      }

      return result;
    } catch (err) {
      console.warn("[PromptHandler] Error fetching available models:", err);
      return [];
    }
  }

  // ─── Audio Transcription ─────────────────────────────────────────────

  private static AUDIO_EXTENSIONS: Record<string, string> = {
    'audio/ogg': 'ogg',
    'audio/mpeg': 'mp3',
    'audio/mp3': 'mp3',
    'audio/wav': 'wav',
    'audio/x-wav': 'wav',
    'audio/webm': 'webm',
    'audio/mp4': 'mp4',
    'audio/m4a': 'm4a',
    'audio/flac': 'flac',
  };

  private async transcribeAudioAttachments(
    attachments: PromptAttachment[],
  ): Promise<{ transcriptions: string[]; remaining: PromptAttachment[] }> {
    const fs = await import('fs/promises');
    const transcriptions: string[] = [];
    const remaining: PromptAttachment[] = [];

    for (const attachment of attachments) {
      if (!attachment.mime.startsWith('audio/')) {
        remaining.push(attachment);
        continue;
      }

      const uid = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      const ext = PromptHandler.AUDIO_EXTENSIONS[attachment.mime] || 'ogg';
      const srcPath = `/tmp/voice-${uid}.${ext}`;
      const wavPath = `/tmp/voice-${uid}.wav`;
      const outBase = `/tmp/voice-${uid}-out`;
      const txtPath = `${outBase}.txt`;

      try {
        // Decode base64 data URL → write to temp file
        const commaIdx = attachment.url.indexOf(',');
        if (commaIdx === -1) {
          console.warn('[PromptHandler] Invalid audio data URL, skipping');
          remaining.push(attachment);
          continue;
        }
        const b64 = attachment.url.slice(commaIdx + 1);
        const bytes = Buffer.from(b64, 'base64');
        await Bun.write(srcPath, bytes);
        console.log(`[PromptHandler] Wrote audio file: ${srcPath} (${bytes.length} bytes, ${attachment.mime})`);

        // Convert to WAV (16kHz mono) via ffmpeg — whisper-cli needs WAV input
        const needsConvert = ext !== 'wav';
        const whisperInput = needsConvert ? wavPath : srcPath;

        if (needsConvert) {
          const ffmpegProc = Bun.spawn([
            'ffmpeg', '-i', srcPath,
            '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le',
            '-y', wavPath,
          ], { stdout: 'pipe', stderr: 'pipe' });
          const ffmpegExit = await ffmpegProc.exited;
          if (ffmpegExit !== 0) {
            const stderr = await new Response(ffmpegProc.stderr).text();
            console.error(`[PromptHandler] ffmpeg conversion failed (exit ${ffmpegExit}): ${stderr.slice(-500)}`);
            remaining.push(attachment);
            continue;
          }
          console.log(`[PromptHandler] Converted ${ext} → WAV: ${wavPath}`);
        }

        // Run whisper-cli
        const whisperProc = Bun.spawn([
          'whisper-cli',
          '--model', '/models/whisper/ggml-base.en.bin',
          '--file', whisperInput,
          '--output-txt',
          '--output-file', outBase,
          '--no-timestamps',
        ], { stdout: 'pipe', stderr: 'pipe' });

        const exitCode = await whisperProc.exited;
        const stderr = await new Response(whisperProc.stderr).text();
        if (exitCode !== 0) {
          console.error(`[PromptHandler] whisper-cli failed (exit ${exitCode}): ${stderr.slice(-500)}`);
          remaining.push(attachment);
          continue;
        }

        // Read transcript
        if (!await Bun.file(txtPath).exists()) {
          console.error(`[PromptHandler] whisper-cli produced no output file at ${txtPath}. stderr: ${stderr.slice(-500)}`);
          remaining.push(attachment);
          continue;
        }

        const transcript = (await Bun.file(txtPath).text()).trim();
        if (transcript) {
          transcriptions.push(transcript);
          console.log(`[PromptHandler] Transcribed audio (${attachment.filename || 'voice'}): "${transcript.slice(0, 100)}..."`);
        } else {
          console.warn(`[PromptHandler] whisper-cli produced empty transcript`);
          remaining.push(attachment);
        }
      } catch (err) {
        console.error('[PromptHandler] Audio transcription error:', err);
        remaining.push(attachment);
      } finally {
        // Clean up all temp files
        for (const p of [srcPath, wavPath, txtPath]) {
          try { await fs.unlink(p); } catch {}
        }
      }
    }

    return { transcriptions, remaining };
  }

  /**
   * Extract text from PDF attachments using LiteParse.
   * Returns extracted text and remaining non-PDF attachments.
   */
  private async extractPdfText(
    attachments: PromptAttachment[],
  ): Promise<{ extractions: Array<{ text: string; filename?: string }>; remaining: PromptAttachment[] }> {
    const { LiteParse } = await import('@llamaindex/liteparse');
    const parser = new LiteParse({ ocrEnabled: false, outputFormat: 'text', maxPages: 100 });
    const extractions: Array<{ text: string; filename?: string }> = [];
    const remaining: PromptAttachment[] = [];

    for (const attachment of attachments) {
      if (attachment.mime !== 'application/pdf') {
        remaining.push(attachment);
        continue;
      }

      try {
        // Decode base64 data URL to buffer
        const commaIdx = attachment.url.indexOf(',');
        if (commaIdx === -1) {
          console.error('[PromptHandler] PDF attachment has invalid data URL');
          remaining.push(attachment);
          continue;
        }
        const base64Data = attachment.url.slice(commaIdx + 1);
        const buffer = Buffer.from(base64Data, 'base64');

        // Parse with timeout to guard against malicious PDFs
        const parsePromise = parser.parse(buffer);
        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('PDF parse timeout after 30s')), 30_000),
        );
        const result = await Promise.race([parsePromise, timeoutPromise]);
        const text = result.text?.trim();

        if (text) {
          extractions.push({ text, filename: attachment.filename });
          console.log(`[PromptHandler] Extracted PDF text (${attachment.filename || 'document.pdf'}): ${text.length} chars`);
        } else {
          console.warn(`[PromptHandler] PDF extraction returned empty text for ${attachment.filename || 'document.pdf'}`);
          remaining.push(attachment);
        }
      } catch (err) {
        console.error('[PromptHandler] PDF text extraction error:', err);
        remaining.push(attachment);
      }
    }

    return { extractions, remaining };
  }

  private buildPromptBody(
    content: string,
    model?: string,
    attachments?: PromptAttachment[],
    author?: PromptAuthor,
    channelType?: string,
    channelId?: string,
  ): Record<string, unknown> {
    const promptParts: Array<Record<string, unknown>> = [];
    for (const attachment of attachments ?? []) {
      promptParts.push({
        type: "file",
        mime: attachment.mime,
        url: attachment.url,
        ...(attachment.filename ? { filename: attachment.filename } : {}),
      });
    }
    // Prefix content with channel context and user identity (agent sees this, users don't).
    // When the DO rewrites channelType to 'thread' for unified routing, the original
    // channel info is passed via replyChannelType/replyChannelId so the agent still
    // knows which external channel to reply to.
    let attributedContent = content;
    const attrChannelType = this.pendingReplyChannelType || channelType;
    const attrChannelId = this.pendingReplyChannelId || channelId;
    if (attrChannelType && attrChannelId && attrChannelType !== "thread") {
      attributedContent = `[via ${attrChannelType} | chatId: ${attrChannelId}] ${attributedContent}`;
    }
    if (author?.authorName || author?.authorEmail) {
      const name = author.authorName || 'Unknown';
      const email = author.authorEmail ? ` <${author.authorEmail}>` : '';
      const userId = author.authorId ? ` (userId: ${author.authorId})` : '';
      attributedContent = `[User: ${name}${email}${userId}] ${attributedContent}`;
    }
    if (attributedContent) {
      promptParts.push({ type: "text", text: attributedContent });
    }
    if (promptParts.length === 0) {
      throw new Error("Cannot send empty prompt: no text or attachments");
    }
    const body: Record<string, unknown> = {
      parts: promptParts,
    };
    if (model) {
      // OpenCode expects model as { providerID, modelID }
      // Our model IDs come from the provider list as raw model IDs (e.g. "claude-3-5-sonnet-20241022")
      // with the provider known separately, but we store them with a provider prefix
      // like "providerID/modelID" or just "modelID" if provider is implicit.
      const slashIdx = model.indexOf("/");
      if (slashIdx !== -1) {
        body.model = { providerID: model.slice(0, slashIdx), modelID: model.slice(slashIdx + 1) };
      } else {
        // No provider prefix — need to find which provider owns this model
        // For now, pass just the modelID and let OpenCode figure it out
        body.model = { providerID: "", modelID: model };
      }
    }
    console.log(`[PromptHandler] buildPromptBody: model=${model ?? 'none'} → ${body.model ? JSON.stringify(body.model) : 'no model'} parts=${promptParts.length}`);
    return body;
  }

  private async sendPromptAsync(sessionId: string, content: string, model?: string, attachments?: PromptAttachment[], author?: PromptAuthor, channelType?: string, channelId?: string): Promise<void> {
    const url = `${this.opencodeUrl}/session/${sessionId}/prompt_async`;
    console.log(`[PromptHandler] POST ${url}${model ? ` (model: ${model})` : ''}${attachments?.length ? ` (attachments: ${attachments.length})` : ''}`);

    const body = this.buildPromptBody(content, model, attachments, author, channelType, channelId);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      // @ts-expect-error Bun-specific option — disable default fetch timeout
      timeout: false,
    });

    console.log(`[PromptHandler] prompt_async response: ${res.status} ${res.statusText}`);

    if (!res.ok && res.status !== 204) {
      const body = await res.text().catch(() => "");
      const error = new Error(`OpenCode prompt_async failed: ${res.status} — ${body}`);
      (error as { status?: number }).status = res.status;
      throw error;
    }
  }

  private async sendPromptSync(
    sessionId: string,
    content: string,
    model?: string,
    attachments?: PromptAttachment[],
    author?: PromptAuthor,
    channelType?: string,
    channelId?: string,
    signal?: AbortSignal,
  ): Promise<{ info: OpenCodeMessageInfo; parts: unknown[] } | null> {
    const url = `${this.opencodeUrl}/session/${sessionId}/message`;
    console.log(`[PromptHandler] POST ${url}${model ? ` (model: ${model})` : ''}${attachments?.length ? ` (attachments: ${attachments.length})` : ''}`);

    const body = this.buildPromptBody(content, model, attachments, author, channelType, channelId);

    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal,
      // @ts-expect-error Bun-specific option — disable default fetch timeout
      timeout: false,
    });

    console.log(`[PromptHandler] prompt sync response: ${res.status} ${res.statusText} (content-type: ${res.headers.get("content-type")})`);

    if (!res.ok) {
      const errorBody = await res.text().catch(() => "");
      console.error(`[PromptHandler] prompt sync error body: ${errorBody.slice(0, 500)}`);
      const error = new Error(`OpenCode prompt sync failed: ${res.status} — ${errorBody}`);
      (error as { status?: number }).status = res.status;
      throw error;
    }

    const rawText = await res.text().catch(() => "");
    console.log(`[PromptHandler] prompt sync raw response (${rawText.length} chars): ${rawText.slice(0, 500)}`);
    if (!rawText) {
      console.warn(`[PromptHandler] prompt sync returned empty body`);
      return null;
    }
    try {
      const json = JSON.parse(rawText);
      const info = json?.info;
      console.log(`[PromptHandler] prompt sync parsed: role=${info?.role} finish=${info?.finish} parts=${Array.isArray(json?.parts) ? json.parts.length : 'none'} error=${info?.error ? JSON.stringify(info.error).slice(0, 200) : 'none'} infoKeys=${info ? Object.keys(info).join(",") : 'null'}`);
      return json as { info: OpenCodeMessageInfo; parts: unknown[] } | null;
    } catch (parseErr) {
      console.error(`[PromptHandler] prompt sync JSON parse failed: ${parseErr}. Raw: ${rawText.slice(0, 300)}`);
      return null;
    }
  }

  private async sendPromptSyncWithRecovery(
    channel: ChannelSession,
    content: string,
    options?: {
      model?: string;
      attachments?: PromptAttachment[];
      author?: PromptAuthor;
      channelType?: string;
      channelId?: string;
      signal?: AbortSignal;
    },
  ): Promise<{ sessionId: string; result: { info: OpenCodeMessageInfo; parts: unknown[] } | null }> {
    let currentSessionId = await this.ensureChannelOpenCodeSession(channel);
    currentSessionId = await this.resyncAdoptedSession(channel, currentSessionId);
    try {
      const result = await this.sendPromptSync(
        currentSessionId,
        content,
        options?.model,
        options?.attachments,
        options?.author,
        options?.channelType,
        options?.channelId,
        options?.signal,
      );
      return { sessionId: currentSessionId, result };
    } catch (err) {
      if (!this.isSessionGone(err)) {
        throw err;
      }
      console.warn("[PromptHandler] OpenCode session missing; recreating session and retrying prompt");
      const recreatedSessionId = await this.recreateChannelOpenCodeSession(channel);
      const result = await this.sendPromptSync(
        recreatedSessionId,
        content,
        options?.model,
        options?.attachments,
        options?.author,
        options?.channelType,
        options?.channelId,
        options?.signal,
      );
      return { sessionId: recreatedSessionId, result };
    }
  }

  private isSessionGone(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const maybeStatus = (err as { status?: number }).status;
    if (maybeStatus === 404 || maybeStatus === 410) return true;
    const msg = err instanceof Error ? err.message : String(err);
    return /session.*(not found|missing|gone)/i.test(msg) || /404/.test(msg);
  }

  // ─── SSE Event Stream ─────────────────────────────────────────────────

  private async consumeEventStream(signal: AbortSignal): Promise<void> {
    const streamCandidates = ["/global/event", "/event"];
    let res: Response | null = null;
    let selectedPath: string | null = null;
    let lastError: Error | null = null;

    for (const path of streamCandidates) {
      if (signal.aborted) return;
      const url = `${this.opencodeUrl}${path}`;
      console.log(`[PromptHandler] GET ${url} (SSE)`);
      try {
        const candidateRes = await fetch(url, {
          headers: { Accept: "text/event-stream" },
          signal,
          // @ts-expect-error Bun-specific option — disable default fetch timeout
          timeout: false,
        });
        console.log(
          `[PromptHandler] Event stream response (${path}): ${candidateRes.status} (type: ${candidateRes.headers.get("content-type")})`
        );
        if (candidateRes.ok && candidateRes.body) {
          res = candidateRes;
          selectedPath = path;
          break;
        }
        lastError = new Error(`Failed to connect to ${path}: ${candidateRes.status}`);
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        console.warn(`[PromptHandler] Event stream connect error (${path}):`, err);
      }
    }

    if (!res || !res.body || !selectedPath) {
      throw lastError ?? new Error("Failed to connect to event stream");
    }

    console.log(`[PromptHandler] Subscribed to ${selectedPath}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventCount = 0;

    while (true) {
      if (signal.aborted) {
        reader.cancel().catch(() => {});
        return;
      }
      const { done, value } = await reader.read();
      if (done || signal.aborted) {
        if (!signal.aborted) {
          console.log(`[PromptHandler] Event stream ended after ${eventCount} events`);
        }
        break;
      }

      buffer += decoder.decode(value, { stream: true });

      // SSE frame delimiter is a blank line (supports both LF and CRLF).
      const messages = buffer.split(/\r?\n\r?\n/);
      buffer = messages.pop() || "";

      for (const message of messages) {
        const lines = message.split(/\r?\n/);
        const dataLines: string[] = [];

        for (const line of lines) {
          if (line.startsWith("data: ")) {
            dataLines.push(line.slice(6));
          } else if (line.startsWith("data:")) {
            dataLines.push(line.slice(5));
          }
        }

        const eventData = dataLines.join("\n").trim();
        if (!eventData) continue;
        if (eventData === "[DONE]") continue;

        try {
          const raw = JSON.parse(eventData) as unknown;
          const event = normalizeOpenCodeEvent(raw);
          if (!event) {
            if (eventCount < 10) {
              console.warn(`[PromptHandler] Ignoring malformed SSE event: ${eventData.slice(0, 150)}`);
            }
            continue;
          }
          eventCount++;

          if (eventCount <= 10 || eventCount % 50 === 0) {
            console.log(`[PromptHandler] SSE event #${eventCount}: type=${event.type}`);
          }
          this.logSseEventDebug(event, eventData);

          this.handleEvent(event);
        } catch (err) {
          // Log first few parse failures for debugging
          this.sseParseWarnCount++;
          if (this.sseParseWarnCount <= 20 || this.verboseSseDebug) {
            console.warn(`[PromptHandler] Failed to parse SSE: ${eventData.slice(0, 150)}`, err);
          }
        }
      }
    }

    // Stream ended — restart unless we were intentionally aborted
    if (!signal.aborted) {
      this.eventStreamActive = false;
      setTimeout(() => this.startEventStream(), 1000);
    }
  }

  private handleEvent(event: OpenCodeEvent): void {
    const props = event.properties;
    if (!props) return;

    // Check for ephemeral session events before filtering
    // Session ID can be at top level or nested inside part/info objects
    const part = props.part as Record<string, unknown> | undefined;
    const info = props.info as Record<string, unknown> | undefined;
    const eventSessionId = (
      props.sessionID ?? props.sessionId ?? props.session_id ??
      part?.sessionID ?? part?.sessionId ??
      info?.sessionID ?? info?.sessionId
    ) as string | undefined;
    if (eventSessionId && this.ephemeralContent.has(eventSessionId)) {
      const mappedChannel = this.ocSessionToChannel.get(eventSessionId);
      // Capture text deltas from ephemeral session SSE events
      if (event.type === "message.part.updated") {
        if (part?.type === "text") {
          const partMessageId = typeof part.messageID === "string" ? part.messageID : undefined;
          const partRole = partMessageId && mappedChannel ? mappedChannel.messageRoles.get(partMessageId) : undefined;
          const allowTextDeltaCapture = !mappedChannel || partRole === "assistant";
          if (!allowTextDeltaCapture) {
            // For normal workflow session prompts, ignore non-assistant deltas.
            // Assistant text is captured from message.updated snapshots below.
          } else {
          const delta = props.delta as string | undefined;
          if (delta) {
            const prev = this.ephemeralContent.get(eventSessionId) || "";
            this.ephemeralContent.set(eventSessionId, prev + delta);
          } else if (typeof part.text === "string" && part.text) {
            const prev = this.ephemeralContent.get(eventSessionId) || "";
            const suffix = this.computeNonOverlappingSuffix(prev, part.text);
            if (suffix) {
              this.ephemeralContent.set(eventSessionId, prev + suffix);
            }
          }
          }
        }
      }
      if (event.type === "message.updated") {
        if (mappedChannel) {
          const role = typeof info?.role === "string" ? info.role : undefined;
          const id = typeof info?.id === "string" ? info.id : undefined;
          if (id && role) {
            mappedChannel.messageRoles.set(id, role);
          }
        }
        if (info?.role === "assistant") {
          const snapshot = this.extractAssistantTextFromMessageInfo(info);
          if (snapshot) {
            this.ephemeralContent.set(eventSessionId, snapshot);
          }
        }
      }

      const isIdle =
        event.type === "session.idle" ||
        (event.type === "session.status" && this.extractStatusType(props) === "idle");
      if (isIdle) {
        const content = this.ephemeralContent.get(eventSessionId) || "";
        console.log(`[PromptHandler] Ephemeral session ${eventSessionId} became idle (captured ${content.length} chars)`);
        const resolve = this.idleWaiters.get(eventSessionId);
        if (resolve) {
          this.idleWaiters.delete(eventSessionId);
          resolve();
        }
      }

      // Auto-approve permissions for ephemeral sessions too
      if ((event.type === "permission.asked" || event.type === "permission.updated") && eventSessionId !== this.sessionId) {
        const permId = String(props.id ?? "");
        if (permId) {
          console.log(`[PromptHandler] Auto-approving permission for ephemeral session: ${permId}`);
          this.respondToPermissionOnSession(eventSessionId, permId, "always");
        }
      }

      // Don't process ephemeral session events through main handler
      if (eventSessionId !== this.sessionId) return;
    }

    // Route to the correct channel session via OC session ID
    let eventChannel: ChannelSession | undefined;
    if (eventSessionId) {
      eventChannel = this.ocSessionToChannel.get(eventSessionId);
      if (!eventChannel) {
        // Not one of our channel sessions — skip unless it's the legacy single session
        // (backward compat for channels created before per-channel routing)
        if (this.activeChannel?.opencodeSessionId === eventSessionId) {
          eventChannel = this.activeChannel;
        } else {
          this.sseDroppedEventCount++;
          if (this.sseDroppedEventCount <= 20 || this.verboseSseDebug) {
            console.warn(
              `[PromptHandler] Dropping SSE event (unmapped session): type=${event.type} session=${eventSessionId} knownSessions=${this.ocSessionToChannel.size}`
            );
          }
          return;
        }
      }
    } else {
      // No session ID in event — use the active channel
      eventChannel = this.activeChannel ?? undefined;
      if (!eventChannel) {
        this.sseDroppedEventCount++;
        if (this.sseDroppedEventCount <= 20 || this.verboseSseDebug) {
          console.warn(
            `[PromptHandler] Dropping SSE event (no active channel): type=${event.type}`
          );
        }
      }
    }

    // Set activeChannel for the duration of event processing so delegate accessors work
    const prevChannel = this.activeChannel;
    if (eventChannel) this.activeChannel = eventChannel;

    const tracePart = props.part as Record<string, unknown> | undefined;
    const traceInfo = (props.info ?? props) as Record<string, unknown>;
    const traceMsgId =
      (tracePart?.messageID as string | undefined) ??
      (tracePart?.messageId as string | undefined) ??
      (traceInfo?.id as string | undefined);
    const traceRole = traceInfo?.role as string | undefined;
    const traceDelta = typeof props.delta === "string" ? props.delta.length : 0;
    const traceType = tracePart?.type ? String(tracePart.type) : undefined;
    this.appendEventTrace(`${event.type}${traceType ? `:${traceType}` : ""}${traceRole ? ` role=${traceRole}` : ""}${traceMsgId ? ` msg=${traceMsgId}` : ""}${traceDelta ? ` d=${traceDelta}` : ""}`);

    try {
    switch (event.type) {
      case "message.part.updated": {
        this.handlePartUpdated(props);
        break;
      }

      case "message.updated": {
        this.handleMessageUpdated(props);
        break;
      }

      case "session.status": {
        this.handleSessionStatus(props);
        break;
      }

      case "session.idle": {
        console.log(`[PromptHandler] session.idle (channel: ${eventChannel?.channelKey ?? 'unknown'}, activeMessageId: ${this.activeMessageId ? 'yes' : 'no'})`);
        // With sync prompts, finalization happens via HTTP response.
        // session.idle is still used for idle status notification and ephemeral sessions.

        // Ephemeral session waiters
        if (eventSessionId && this.idleWaiters.has(eventSessionId)) {
          const resolve = this.idleWaiters.get(eventSessionId);
          resolve?.();
          this.idleWaiters.delete(eventSessionId);
        }

        if (!this.idleNotified) {
          this.agentClient.sendAgentStatus("idle");
          this.idleNotified = true;
        }
        break;
      }

      case "permission.asked":
      case "permission.updated": {
        // Permission request — auto-approve since this is a headless agent
        const permId = String(props.id ?? "");
        const title = String(
          (props as Record<string, unknown>).title ??
          (props as Record<string, unknown>).message ??
          (props as Record<string, unknown>).description ??
          "Permission requested"
        );
        if (permId) {
          console.log(`[PromptHandler] Permission request: ${permId} — "${title}" (auto-approving)`);
          this.approvePermission(permId);
        }
        break;
      }

      case "question.asked": {
        this.handleQuestionAsked(props);
        break;
      }

      case "question.replied":
      case "question.rejected": {
        const requestID = typeof props.requestID === "string" ? props.requestID : "";
        if (requestID) {
          this.clearQuestionRequest(requestID);
        }
        break;
      }

      case "session.error": {
        const rawError = props.error ?? props.message ?? props.description;
        const errorMsg = openCodeErrorToMessage(rawError) ?? "Unknown agent error";
        console.error(`[PromptHandler] session.error: ${errorMsg}`);
        console.error(`[PromptHandler] session.error raw:`, JSON.stringify(props));
        // Record error — sync prompt response is authoritative for handling it
        this.lastError = errorMsg;
        this.hasActivity = true;
        break;
      }

      case "session.compacted": {
        if (eventChannel) {
          console.log(`[PromptHandler] Session compacted for ${eventChannel.channelKey}`);
          eventChannel.cumulativeInputTokens = 0;
          eventChannel.cumulativeOutputTokens = 0;
          eventChannel.countedTokenMessageIds.clear();
          eventChannel.lastFlushTurnCount = eventChannel.turnCount;
        }
        break;
      }

      case "session.updated": {
        // Forward title/summary updates for thread channels to the DO
        const updatedSessionId = (props.id ?? props.sessionID ?? props.sessionId) as string | undefined;
        if (updatedSessionId) {
          const updatedChannel = this.ocSessionToChannel.get(updatedSessionId);
          if (updatedChannel && updatedChannel.channelKey.startsWith("thread:")) {
            const threadId = updatedChannel.channelKey.slice(7);
            const summary = props.summary as Record<string, unknown> | undefined;
            this.agentClient.sendThreadUpdated(threadId, {
              title: typeof props.title === "string" ? props.title : undefined,
              summaryAdditions: typeof summary?.additions === "number" ? summary.additions : undefined,
              summaryDeletions: typeof summary?.deletions === "number" ? summary.deletions : undefined,
              summaryFiles: typeof summary?.files === "number" ? summary.files : undefined,
            });
          }
        }
        break;
      }

      case "server.connected":
      case "server.heartbeat":
      case "session.created":
      case "session.deleted":
      case "session.diff":
      case "message.removed":
      case "message.part.removed":
      case "permission.replied":
      case "file.edited":
      case "file.watcher.updated":
      case "vcs.branch.updated":
      case "todo.updated":
      case "command.executed":
      case "lsp.updated":
      case "lsp.client.diagnostics":
        // Known events we don't need to handle
        break;

      default:
        console.log(`[PromptHandler] Unhandled event: ${event.type}`);
        break;
    }
    } finally {
      // Restore the previous active channel
      this.activeChannel = prevChannel;
    }
  }

  private handlePartUpdated(props: Record<string, unknown>): void {
    if (!this.activeMessageId) return;

    // After wait_for_event force-complete + abort, suppress stale SSE events
    // (the abort causes OpenCode to emit "The operation was aborted." text).
    if (this.waitForEventForced) return;

    // The part can be a tool part or a text part
    const part = props.part as Record<string, unknown> | undefined;
    if (!part) return;

    const messageIdRaw =
      part.messageID ??
      part.messageId ??
      props.messageID ??
      props.messageId;
    const partMessageId = messageIdRaw ? String(messageIdRaw) : undefined;
    const partRole = partMessageId ? this.messageRoles.get(partMessageId) : undefined;
    const partType = String(part.type ?? "");

    // Guard rail: ignore non-assistant parts once role is known.
    if (partRole && partRole !== "assistant") {
      return;
    }

    // If this text part belongs to a known assistant message from a prior turn, ignore it.
    if (partType === "text" && partMessageId && this.activeAssistantMessageIds.size > 0) {
      if (!this.activeAssistantMessageIds.has(partMessageId) && partRole !== undefined) {
        return;
      }
    }

    const delta = props.delta as string | undefined;

    if (partType === "text") {
      const partIdRaw = part.id ?? part.messageID ?? "text";
      const partId = String(partIdRaw);
      const messageSnapshotKey = partMessageId ?? this.activeMessageId ?? "active";
      const partText = typeof part.text === "string"
        ? part.text
        : typeof part.content === "string"
          ? String(part.content)
        : typeof props.text === "string"
          ? String(props.text)
          : undefined;

      // Treat full part snapshots as canonical when available.
      // Some providers/reconnect paths may replay events with a repeated delta.
      // Using snapshots first keeps us aligned with OpenCode's replace-by-part-id model.
      let chunk = "";
      if (typeof partText === "string") {
        const prevByPart = this.textPartSnapshots.get(partId) ?? "";
        const prevByMessage = this.messageTextSnapshots.get(messageSnapshotKey) ?? "";
        const prevGlobal = this.streamedContent;
        const candidates = [prevByPart, prevByMessage, prevGlobal].filter(Boolean);
        const prefixMatch = candidates
          .filter((candidate) => partText.startsWith(candidate))
          .sort((a, b) => b.length - a.length)[0];
        const prev = prefixMatch ?? "";
        if (partText.startsWith(prev)) {
          chunk = partText.slice(prev.length);
        } else if (
          partText === prev ||
          prev.startsWith(partText)
        ) {
          // Duplicate or out-of-order stale snapshot.
          chunk = "";
        } else if (this.streamedContent.endsWith(partText)) {
          // Exact replay of the same full snapshot.
          chunk = "";
        } else {
          // Snapshot changed without sharing a clean prefix (rewrite/out-of-order).
          // Emit only the non-overlapping suffix so replayed snapshots don't duplicate text.
          chunk = this.computeNonOverlappingSuffix(prevGlobal, partText);
        }
        this.textPartSnapshots.set(partId, partText);
        this.messageTextSnapshots.set(messageSnapshotKey, partText);
      } else if (delta) {
        // Snapshot missing: fall back to delta mode.
        chunk = delta;
      }

      if (chunk) {
        if (this.streamedContent === "") {
          this.agentClient.sendAgentStatus("streaming");
        }
        this.hasActivity = true;
        // Text resuming after tool calls — streamedContent was already committed
        // before the tool started, so just reset the flag and keep accumulating.
        if (this.hadToolSinceLastText) {
          this.hadToolSinceLastText = false;
        }
        this.streamedContent += chunk;
        this.lastChunkTime = Date.now();
        this.ensureTurnCreated();
        console.log(`[PromptHandler] text-delta: ${chunk.length} chars (total: ${this.streamedContent.length})`);
        this.agentClient.sendTextDelta(this.turnId!, chunk);
        this.resetResponseTimeout();
      }
    } else if (partType === "tool") {
      this.handleToolPart(part as unknown as ToolPart);
    } else if (partType === "step-start") {
      // Agent starting a new step (e.g., tool execution phase)
      this.hasActivity = true;
      this.lastChunkTime = Date.now();
      this.resetResponseTimeout();
    } else if (partType === "step-finish") {
      // Agent finished a step
      this.hasActivity = true;
      this.lastChunkTime = Date.now();
      this.resetResponseTimeout();
    } else if (partType === "reasoning") {
      // Reasoning/thinking — track activity but don't send to client
      this.hasActivity = true;
      this.lastChunkTime = Date.now();
      this.resetResponseTimeout();
    } else if (partType) {
      // Unknown part type — log and track
      console.log(`[PromptHandler] Unknown part type: "${partType}" keys=${Object.keys(part).join(",")}`);
      this.hasActivity = true;
      this.lastChunkTime = Date.now();
      this.resetResponseTimeout();
    }
  }

  private handleToolPart(part: ToolPart): void {
    const toolName = part.tool || "unknown";
    const state = part.state;
    if (!state) {
      console.log(`[PromptHandler] Tool part without state: ${toolName}`);
      return;
    }

    const callID = part.id || part.callID || toolName;
    const prev = this.toolStates.get(callID);
    const prevStatus = prev?.status;
    const currentStatus = state.status;

    // Only act on state transitions
    if (currentStatus === prevStatus) return;

    // wait_for_event: treat as an immediate yield — force completion + idle
    if (toolName === "wait_for_event" && (currentStatus === "pending" || currentStatus === "running") && !this.waitForEventForced) {
      this.waitForEventForced = true;
      console.log(`[PromptHandler] wait_for_event observed (${currentStatus}) — forcing completion + idle`);
      this.toolStates.set(callID, { status: "completed", toolName });
      this.ensureTurnCreated();
      this.agentClient.sendToolUpdate(this.turnId!, callID, toolName, "completed", state.input ?? undefined);
      this.finalizeResponse(true);
      this.agentClient.sendComplete();
      this.agentClient.sendAgentStatus("idle");
      this.idleNotified = true;
      if (this.sessionId) {
        fetch(`${this.opencodeUrl}/session/${this.sessionId}/abort`, { method: "POST" })
          .catch((err) => console.error("[PromptHandler] Error aborting after wait_for_event:", err));
      }
      return;
    }

    console.log(`[PromptHandler] Tool "${toolName}" [${callID}] ${prevStatus ?? "new"} → ${currentStatus}`);
    this.toolStates.set(callID, { status: currentStatus, toolName });

    this.hasActivity = true;
    this.hadToolSinceLastText = true;
    this.lastChunkTime = Date.now();
    this.resetResponseTimeout();

    // When a NEW tool appears and we have accumulated text, commit the text
    // as a stored assistant message so it persists across page reloads.
    // The client merges consecutive assistant text messages back together.
    if (!prevStatus && this.streamedContent.trim() && this.activeMessageId) {
      this.streamedContent = "";
    }

    // Send tool call on every state transition with callID + status
    if (currentStatus === "pending" || currentStatus === "running") {
      if (toolName === "question") {
        // Question tools wait on user input; keep UI interactive instead of "thinking".
        this.agentClient.sendAgentStatus("idle");
        this.idleNotified = true;
      } else {
        this.agentClient.sendAgentStatus("tool_calling", toolName);
      }
      this.ensureTurnCreated();
      this.agentClient.sendToolUpdate(this.turnId!, callID, toolName, currentStatus, state.input ?? undefined);
    } else if (currentStatus === "completed") {
      const toolResult = state.output ?? null;
      console.log(`[PromptHandler] Tool "${toolName}" completed (output: ${typeof toolResult === "string" ? toolResult.length + " chars" : "null"})`);

      this.agentClient.sendToolUpdate(this.turnId!, callID, toolName, "completed", state.input ?? undefined, toolResult ?? undefined);

      // wait_for_event: forcibly end the turn so the agent actually stops
      if (toolName === "wait_for_event") {
        console.log(`[PromptHandler] wait_for_event completed — aborting OpenCode and finalizing turn`);
        this.waitForEventForced = true;
        this.finalizeResponse(true);
        // Send complete so the DO clears runnerBusy and drains the prompt queue.
        // Without this, child session notifications get queued but never processed.
        this.agentClient.sendComplete();
        this.agentClient.sendAgentStatus("idle");
        this.idleNotified = true;
        // Abort OpenCode generation so it fully yields
        if (this.sessionId) {
          fetch(`${this.opencodeUrl}/session/${this.sessionId}/abort`, { method: "POST" })
            .catch((err) => console.error("[PromptHandler] Error aborting after wait_for_event:", err));
        }
      }

    } else if (currentStatus === "error") {
      // Suppress abort errors from wait_for_event — the Runner already force-completed
      // it and sent idle status; the abort error is a stale artifact of killing OpenCode.
      if (toolName === "wait_for_event" && this.waitForEventForced) {
        console.log(`[PromptHandler] Suppressing post-abort error for wait_for_event`);
        return;
      }
      console.log(`[PromptHandler] Tool "${toolName}" error: ${state.error}`);
      this.agentClient.sendToolUpdate(this.turnId!, callID, toolName, "error", state.input ?? undefined, undefined, state.error ?? undefined);
    }
  }

  private handleMessageUpdated(props: Record<string, unknown>): void {
    // After wait_for_event force-complete + abort, suppress stale SSE events.
    if (this.waitForEventForced) return;

    // OpenCode wraps the message in an "info" property: { info: { role, ... } }
    const info = (props.info ?? props) as Record<string, unknown>;
    const role = info.role as string | undefined;
    const assistantError = role === "assistant" ? this.extractAssistantErrorFromMessageInfo(info) : null;

    console.log(`[PromptHandler] message.updated: role=${role} (active: ${this.activeMessageId ? 'yes' : 'no'}, content: ${this.streamedContent.length} chars, activity: ${this.hasActivity})`);

    // Capture OpenCode message ID mapping for revert support
    const ocMessageId = info.id as string | undefined;
    if (ocMessageId && role) {
      this.messageRoles.set(ocMessageId, role);
    }
    if (ocMessageId && role === "assistant") {
      this.activeAssistantMessageIds.add(ocMessageId);
      this.awaitingAssistantForAttempt = false;
      this.clearFirstResponseTimeout();
    }
    if (ocMessageId && this.activeMessageId && role === "assistant") {
      if (!this.doToOcMessageId.has(this.activeMessageId)) {
        this.doToOcMessageId.set(this.activeMessageId, ocMessageId);
        this.ocToDOMessageId.set(ocMessageId, this.activeMessageId);
        console.log(`[PromptHandler] Mapped DO message ${this.activeMessageId} → OC message ${ocMessageId}`);
      }
    }

    // Do NOT finalize on message.updated — even if time.completed is set.
    // OpenCode may create multiple assistant messages per prompt (e.g., one before
    // a tool call and one after). Finalizing on the first message's completion
    // drops all subsequent tool events (like browser_screenshot).
    // Instead, rely solely on session.idle / session.status: idle to finalize.
    if (role === "assistant" && this.activeMessageId) {
      const snapshotText = this.extractAssistantTextFromMessageInfo(info);
      if (snapshotText) {
        this.latestAssistantTextSnapshot = snapshotText;
      }
      if (assistantError) {
        this.lastError = assistantError;
        this.appendEventTrace(`assistant.error:${assistantError.slice(0, 120)}`);
      }
      this.hasActivity = true;
      this.lastChunkTime = Date.now();
      this.resetResponseTimeout();
    }

    // Track last-used model for context limit lookups (before currentModelPreferences is cleared)
    if (role === "assistant" && this.activeChannel) {
      // Try model info from message.updated properties first
      const modelId = info.modelID as string | undefined;
      const providerId = info.providerID as string | undefined;
      if (modelId && providerId) {
        this.activeChannel.lastUsedModel = `${providerId}/${modelId}`;
      } else if (this.activeChannel.currentModelPreferences?.[this.activeChannel.currentModelIndex]) {
        this.activeChannel.lastUsedModel = this.activeChannel.currentModelPreferences[this.activeChannel.currentModelIndex];
      }
    }

    // Accumulate token counts for pre-compaction detection (dedup by message ID)
    if (role === "assistant" && this.activeChannel && ocMessageId) {
      if (!this.activeChannel.countedTokenMessageIds.has(ocMessageId)) {
        const tokenObj = info.tokens as Record<string, unknown> | undefined;
        if (tokenObj) {
          const input = typeof tokenObj.input === "number" ? tokenObj.input : 0;
          const output = typeof tokenObj.output === "number" ? tokenObj.output : 0;
          if (input > 0 || output > 0) {
            this.activeChannel.countedTokenMessageIds.add(ocMessageId);
            this.activeChannel.cumulativeInputTokens += input;
            this.activeChannel.cumulativeOutputTokens += output;

            // Track per-message usage for cost reporting
            const modelId = info.modelID as string | undefined;
            const providerId = info.providerID as string | undefined;
            const usageModel = modelId && providerId
              ? `${providerId}/${modelId}`
              : this.activeChannel.lastUsedModel ?? "unknown";
            this.activeChannel.usageEntries.set(ocMessageId, {
              model: usageModel,
              inputTokens: input,
              outputTokens: output,
            });
          }
        }
      }
    }
  }

  private handleSessionStatus(props: Record<string, unknown>): void {
    // After wait_for_event force-complete + abort, suppress stale SSE events.
    if (this.waitForEventForced) return;

    // SessionStatus is an object: { type: "idle" | "busy" | "retry" }
    const rawStatus = props.status;
    let statusType: string | undefined;

    if (typeof rawStatus === "string") {
      statusType = rawStatus;
    } else if (rawStatus && typeof rawStatus === "object") {
      statusType = (rawStatus as SessionStatus).type;
    }

    console.log(`[PromptHandler] session.status: "${statusType}" (active: ${this.activeMessageId ? 'yes' : 'no'}, content: ${this.streamedContent.length} chars, activity: ${this.hasActivity})`);

    if (statusType === "idle") {
      if (this.activeMessageId && !this.retryPending && this.awaitingAssistantForAttempt) {
        // Model silently failed — OpenCode idle without assistant message.
        // Clear flag and finalize to trigger model failover.
        console.log(`[PromptHandler] session.status=idle: model produced no assistant message — clearing awaitingAssistant, finalizing for failover`);
        this.awaitingAssistantForAttempt = false;
        this.clearFirstResponseTimeout();
        this.finalizeResponse();
      } else if (this.activeMessageId && !this.retryPending) {
        console.log(`[PromptHandler] Session idle, finalizing response`);
        this.finalizeResponse();
      } else if (this.retryPending) {
        console.log(
          `[PromptHandler] session.status=idle ignored (retryPending=${this.retryPending})`
        );
      }
      if (!this.idleNotified) {
        this.agentClient.sendAgentStatus("idle");
        this.idleNotified = true;
      }
    } else if (statusType === "busy") {
      if (this.retryPending) {
        this.retryPending = false;
      }
      this.idleNotified = false;
    }
  }

  private logSseEventDebug(event: OpenCodeEvent, rawData: string): void {
    if (event.type === "server.heartbeat" || event.type === "server.connected") return;
    if (!this.verboseSseDebug && this.sseDebugLogCount >= this.sseDebugLogLimit) return;

    const props = event.properties ?? {};
    const part = isRecord(props.part) ? props.part : undefined;
    const info = isRecord(props.info) ? props.info : undefined;
    const role = typeof info?.role === "string" ? info.role : undefined;
    const partType = typeof part?.type === "string" ? part.type : undefined;
    const msgId =
      (typeof part?.messageID === "string" ? part.messageID : undefined) ??
      (typeof part?.messageId === "string" ? part.messageId : undefined) ??
      (typeof info?.id === "string" ? info.id : undefined);
    const sessionId =
      (typeof props.sessionID === "string" ? props.sessionID : undefined) ??
      (typeof props.sessionId === "string" ? props.sessionId : undefined) ??
      (typeof props.session_id === "string" ? props.session_id : undefined) ??
      (typeof part?.sessionID === "string" ? part.sessionID : undefined) ??
      (typeof part?.sessionId === "string" ? part.sessionId : undefined) ??
      (typeof info?.sessionID === "string" ? info.sessionID : undefined) ??
      (typeof info?.sessionId === "string" ? info.sessionId : undefined);
    const deltaLen = typeof props.delta === "string" ? props.delta.length : 0;
    const keys = Object.keys(props).join(",");
    const summary = `[PromptHandler][SSE dbg] type=${event.type}` +
      `${sessionId ? ` session=${sessionId}` : ""}` +
      `${role ? ` role=${role}` : ""}` +
      `${partType ? ` part=${partType}` : ""}` +
      `${msgId ? ` msg=${msgId}` : ""}` +
      `${deltaLen ? ` delta=${deltaLen}` : ""}` +
      ` keys=[${keys}]`;

    if (this.verboseSseDebug) {
      const compactRaw = rawData.replace(/\s+/g, " ").slice(0, 600);
      console.log(`${summary} raw=${compactRaw}`);
    } else {
      console.log(summary);
    }
    this.sseDebugLogCount++;
  }

  private async finalizeResponse(force = false): Promise<void> {
    if (!this.activeMessageId || this.failoverInProgress) {
      return;
    }
    // Don't finalize from SSE events while a sync prompt is in flight
    if (this.activeChannel?.syncPromptInFlight) {
      console.log(`[PromptHandler] Skipping SSE-side finalization — sync prompt in flight`);
      return;
    }
    if (this.finalizeInFlight) {
      return;
    }
    this.finalizeInFlight = true;

    try {

      // Clear any pending timeouts
      this.clearResponseTimeout();
      this.clearFirstResponseTimeout();

      const messageId = this.activeMessageId;
      let content = this.streamedContent || this.latestAssistantTextSnapshot;

      // Send result, error, or fallback depending on what happened
      if (content) {
        console.log(`[PromptHandler] Sending result for ${messageId} (${content.length} chars): "${content.slice(0, 100)}..."`);
        this.ensureTurnCreated();
        this.agentClient.sendTurnFinalize(this.turnId!, "end_turn", content);
      } else if (this.lastError) {
        if (isRetriableProviderError(this.lastError)) {
          console.log(`[PromptHandler] Retriable assistant error for ${messageId} — attempting model failover`);
          this.failoverInProgress = true;
          this.retryPending = true;
          let didFailover = false;
          try {
            didFailover = await this.attemptModelFailover(this.lastError);
            if (didFailover) {
              console.log(`[PromptHandler] Failover initiated for ${messageId} after assistant error — waiting for retry`);
              return;
            }
          } finally {
            this.failoverInProgress = false;
            if (!didFailover) {
              this.retryPending = false;
            }
          }
        }
        console.log(`[PromptHandler] Sending error for ${messageId}: ${this.lastError}`);
        this.ensureTurnCreated();
        this.agentClient.sendTurnFinalize(this.turnId!, "error", undefined, this.lastError || undefined);
      } else if (this.toolStates.size > 0) {
        // Tools ran but no text was produced — this is normal for tool-only turns
        console.log(`[PromptHandler] Tools-only response for ${messageId} (${this.toolStates.size} tools ran)`);
        this.ensureTurnCreated();
        this.agentClient.sendTurnFinalize(this.turnId!, "end_turn");
      } else {
        const recovered = await this.recoverAssistantTextOrError();
        if (recovered.error) {
          this.lastError = recovered.error;
        }
        if (recovered.text) {
          content = recovered.text;
          console.log(
            `[PromptHandler] Recovered assistant text for ${messageId} from message API (${recovered.text.length} chars)`
          );
          this.ensureTurnCreated();
          this.agentClient.sendTurnFinalize(this.turnId!, "end_turn", recovered.text);
        } else if (this.lastError) {
          if (isRetriableProviderError(this.lastError)) {
            console.log(`[PromptHandler] Retriable recovered error for ${messageId} — attempting model failover`);
            this.failoverInProgress = true;
            this.retryPending = true;
            let didFailover = false;
            try {
              didFailover = await this.attemptModelFailover(this.lastError);
              if (didFailover) {
                console.log(`[PromptHandler] Failover initiated for ${messageId} after recovery error — waiting for retry`);
                return;
              }
            } finally {
              this.failoverInProgress = false;
              if (!didFailover) {
                this.retryPending = false;
              }
            }
          }
          const userError = this.buildFailoverExhaustedError(this.lastError);
          console.log(`[PromptHandler] Sending recovered error for ${messageId}: ${userError}`);
          this.ensureTurnCreated();
          this.agentClient.sendTurnFinalize(this.turnId!, "error", undefined, userError || undefined);
        } else {
          // Model produced nothing — try failover to next model before giving up
          console.warn(
            `[PromptHandler] Empty-response diagnostics for ${messageId}: ` +
            `snapshot=${this.latestAssistantTextSnapshot.length} ` +
            `assistantMsgs=${this.activeAssistantMessageIds.size} ` +
            `roles=${this.messageRoles.size} ` +
            `trace=${this.recentEventTrace.join(" | ")}`
          );
          console.log(`[PromptHandler] Empty response for ${messageId} — attempting model failover`);
          this.failoverInProgress = true;
          this.retryPending = true;
          let didFailover = false;
          try {
            didFailover = await this.attemptModelFailover("Model returned an empty response");
            if (didFailover) {
              console.log(`[PromptHandler] Failover initiated for ${messageId} — waiting for retry`);
              return; // Don't complete — retry in progress with next model
            }
          } finally {
            this.failoverInProgress = false;
            if (!didFailover) {
              this.retryPending = false;
            }
          }
          // No more models to try — send error
          const emptyError = this.buildFailoverExhaustedError(
            this.lastError || "The model did not respond."
          );
          console.log(`[PromptHandler] No failover available for ${messageId} — sending empty response error: ${emptyError}`);
          this.ensureTurnCreated();
          this.agentClient.sendTurnFinalize(this.turnId!, "error", undefined, emptyError);
        }
      }

      // Flush any tools still in non-terminal state as "completed".
      // This handles cases where the completed event was missed or arrived out-of-order.
      for (const [callID, { status, toolName }] of this.toolStates) {
        if (status === "pending" || status === "running") {
          console.log(`[PromptHandler] Flushing stuck tool "${toolName}" [${callID}] as completed (was: ${status})`);
          this.agentClient.sendToolUpdate(this.turnId!, callID, toolName, "completed");
        }
      }

      console.log(`[PromptHandler] Sending complete`);
      this.agentClient.sendComplete();

      // Notify client that agent is idle
      this.agentClient.sendAgentStatus("idle");

      // Emit usage report for this turn
      const usageChannel = this.activeChannel;
      if (usageChannel && usageChannel.usageEntries.size > 0 && usageChannel.turnId) {
        const entries = Array.from(usageChannel.usageEntries.entries()).map(
          ([ocMessageId, data]) => ({
            ocMessageId,
            model: data.model,
            inputTokens: data.inputTokens,
            outputTokens: data.outputTokens,
          })
        );
        this.agentClient.sendUsageReport(usageChannel.turnId, entries);
        usageChannel.usageEntries.clear();
      }

      // Check for pre-compaction memory flush after each turn
      const flushChannel = this.activeChannel;
      if (flushChannel && !flushChannel.memoryFlushInProgress) {
        flushChannel.turnCount++;
        // Schedule async — don't block finalization
        this.checkAndTriggerMemoryFlush(flushChannel).catch(err =>
          console.warn("[PromptHandler] Memory flush check failed:", err)
        );
      }

      // Report files changed after each turn
      this.reportFilesChanged().catch((err) =>
        console.error("[PromptHandler] Error reporting files changed:", err)
      );

      this.cleanupAfterFinalize();
    } finally {
      this.finalizeInFlight = false;
    }
  }

  private resetResponseTimeout(): void {
    this.clearResponseTimeout();
    // Set a timeout to finalize the response if no completion event is received
    this.responseTimeoutId = setTimeout(() => {
      if (this.activeMessageId && this.hasActivity) {
        const timeSinceLastChunk = Date.now() - this.lastChunkTime;
        console.log(`[PromptHandler] Response timeout triggered (${timeSinceLastChunk}ms since last chunk)`);
        this.finalizeResponse();
      }
    }, EMERGENCY_TIMEOUT_MS);
  }

  private clearResponseTimeout(): void {
    if (this.responseTimeoutId) {
      clearTimeout(this.responseTimeoutId);
      this.responseTimeoutId = null;
    }
  }

  /**
   * Start a timeout for receiving the first assistant message after sending a prompt.
   * If the model/provider never responds (hangs, free-tier timeout, etc.), this
   * prevents the session from being stuck in "Thinking" forever by attempting
   * model failover or erroring out.
   */
  private startFirstResponseTimeout(): void {
    this.clearFirstResponseTimeout();
    this.firstResponseTimeoutId = setTimeout(async () => {
      this.firstResponseTimeoutId = null;
      if (!this.awaitingAssistantForAttempt || !this.activeMessageId) return;

      console.log(`[PromptHandler] First response timeout fired — no assistant message received within ${FIRST_RESPONSE_TIMEOUT_MS}ms`);

      // Try model failover
      this.failoverInProgress = true;
      this.retryPending = true;
      let didFailover = false;
      try {
        didFailover = await this.attemptModelFailover("Model did not respond (timeout waiting for first response)");
        if (didFailover) {
          console.log(`[PromptHandler] Failover initiated after first-response timeout`);
          return;
        }
      } finally {
        this.failoverInProgress = false;
        if (!didFailover) {
          this.retryPending = false;
        }
      }

      // No more models — error out
      console.log(`[PromptHandler] No failover available — sending timeout error`);
      this.awaitingAssistantForAttempt = false;
      const messageId = this.activeMessageId;
      if (messageId) {
        this.agentClient.sendError(messageId, "The model did not respond. Try again or switch to a different model.");
        this.agentClient.sendComplete();
        this.agentClient.sendAgentStatus("idle");
        // Reset prompt state
        this.activeMessageId = null;
        this.streamedContent = "";
        this.hasActivity = false;
        this.lastError = null;
        this.currentModelPreferences = undefined;
        this.currentModelIndex = 0;
        this.pendingRetryContent = null;
        this.pendingRetryAttachments = [];
        this.pendingRetryAuthor = undefined;
      }
    }, FIRST_RESPONSE_TIMEOUT_MS);
  }

  private clearFirstResponseTimeout(): void {
    if (this.firstResponseTimeoutId) {
      clearTimeout(this.firstResponseTimeoutId);
      this.firstResponseTimeoutId = null;
    }
  }

  private async reportFilesChanged(): Promise<void> {
    if (!this.sessionId) return;
    try {
      const res = await fetch(`${this.opencodeUrl}/session/${this.sessionId}/diff`);
      if (!res.ok) return;

      const data = await res.json() as Array<{
        file: string;
        before: string;
        after: string;
        additions: number;
        deletions: number;
      }>;

      if (data.length === 0) return;

      const files = data.map((entry) => ({
        path: entry.file,
        status: !entry.before || entry.before === "" ? "added"
          : !entry.after || entry.after === "" ? "deleted"
          : "modified",
        additions: entry.additions,
        deletions: entry.deletions,
      }));

      console.log(`[PromptHandler] Files changed: ${files.length} files`);
      this.agentClient.sendFilesChanged(files);
    } catch (err) {
      console.error("[PromptHandler] Error fetching files changed:", err);
    }
  }
}
