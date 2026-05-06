import type { TSchema, Static } from "typebox";
import type { Model } from "@mariozechner/pi-ai";

// ── Identity / authoring ──────────────────────────────────────────

export interface PromptAuthor {
  id: string;
  email?: string;
  name?: string;
  avatarUrl?: string;
  externalId?: string;
}

export interface ChannelTarget {
  channelType: string;
  channelId: string;
  threadId?: string;
}

// ── Sessions / threads / queue ────────────────────────────────────

export type SessionPurpose = "interactive" | "orchestrator" | "workflow" | "child";
export type SessionStatus =
  | "initializing"
  | "running"
  | "paused"
  | "hibernated"
  | "terminated"
  | "error";

export interface SessionData {
  id: string;
  userId: string;
  orgId: string;
  workspace: string;
  purpose: SessionPurpose;
  status: SessionStatus;
  sandboxId?: string;
  snapshotId?: string;
  parentSessionId?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export type QueueMode = "followup" | "steer" | "collect";
export type ThreadStatus = "active" | "paused" | "archived";
export type QueueStatus = "idle" | "queued" | "running" | "blocked_on_decision_gate" | "paused";

export interface ThreadData {
  id: string;
  sessionId: string;
  key: string;
  status: ThreadStatus;
  activeLeafEntryId?: string;
  queueMode: QueueMode;
  model?: string;
  summary?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
}

export interface QueueState {
  threadId: string;
  mode: QueueMode;
  status: QueueStatus;
  activeItemId?: string;
  pending: QueueItem[];
  collectBuffer?: QueueItem[];
  blockedGateId?: string;
}

export interface QueueItem {
  id: string;
  threadId: string;
  content: PromptContent;
  author?: PromptAuthor;
  channel?: ChannelTarget;
  replyTarget?: ChannelTarget;
  model?: string;
  metadata?: Record<string, unknown>;
  createdAt: number;
}

// ── Prompts ────────────────────────────────────────────────────────

export type PromptContent =
  | string
  | {
      text?: string;
      attachments?: PromptAttachment[];
    };

export type PromptAttachment =
  | { type: "image"; url?: string; data?: Uint8Array; mimeType: string; name?: string }
  | { type: "file"; url?: string; data?: Uint8Array; mimeType: string; name: string }
  | { type: "audio"; url?: string; data?: Uint8Array; mimeType: string; name?: string };

export interface PromptOptions {
  author?: PromptAuthor;
  channel?: ChannelTarget;
  replyTarget?: ChannelTarget;
  queueMode?: QueueMode;
  model?: string;
  role?: string;
  resultSchema?: TSchema;
  metadata?: Record<string, unknown>;
}

export interface PromptReceipt {
  sessionId: string;
  threadId: string;
  queueItemId: string;
  status: "queued" | "running" | "blocked_on_decision_gate";
}

// ── Messages and DAG entries ──────────────────────────────────────

export interface BaseEntry {
  id: string;
  sessionId: string;
  threadId: string;
  parentId: string | null;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export type MessagePart =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | {
      type: "tool_call";
      callId: string;
      toolName: string;
      status: "running" | "completed" | "error";
      args?: unknown;
      result?: unknown;
      error?: string;
      /** Set by the pruner. When true, `result` has been replaced with a placeholder; the original output is no longer available. */
      elided?: boolean;
    }
  | { type: "attachment"; attachment: ToolAttachment }
  | { type: "error"; message: string; code?: string };

export interface MessageEntry extends BaseEntry {
  type: "message";
  role: "user" | "assistant" | "tool" | "system";
  content: string;
  parts?: MessagePart[];
  author?: PromptAuthor;
  channel?: ChannelTarget;
  model?: string;
}

export interface CompactionEntry extends BaseEntry {
  type: "compaction";
  summary: string;
  coveredEntryIds: string[];
  tokenCountBefore: number;
  tokenCountAfter: number;
  fileContext?: { read: string[]; modified: string[] };
}

export interface BranchSummaryEntry extends BaseEntry {
  type: "branch_summary";
  branchRootId: string;
  branchLeafId: string;
  summary: string;
}

export interface DecisionGateEntry extends BaseEntry {
  type: "decision_gate";
  gate: DecisionGate;
  resolvedAt?: string;
  resolution?: DecisionResolution;
  withdrawnReason?: DecisionWithdrawReason;
}

export type SessionEntry = MessageEntry | CompactionEntry | BranchSummaryEntry | DecisionGateEntry;

export interface MessageQuery {
  limit?: number;
  cursor?: string;
  afterEntryId?: string;
  beforeEntryId?: string;
  includeCompacted?: boolean;
  includeSystemEntries?: boolean;
}

// ── Tools ──────────────────────────────────────────────────────────

export type RiskLevel = "low" | "medium" | "high" | "critical";

export interface ToolDef<TParams extends TSchema = TSchema> {
  name: string;
  description: string;
  parameters: TParams;
  riskLevel?: RiskLevel;
  requiresApproval?: boolean | ((args: Static<TParams>, ctx: ToolContext) => Promise<boolean> | boolean);
  /** When true, this tool's outputs are exempt from pruning during compaction. */
  protectedFromPruning?: boolean;
  execute: (args: Static<TParams>, ctx: ToolContext) => Promise<ToolResult>;
}

export interface ToolResult {
  text: string;
  attachments?: ToolAttachment[];
}

export type ToolAttachment =
  | { type: "image"; data: Uint8Array; mimeType: string; name?: string }
  | { type: "file"; data: Uint8Array; mimeType: string; name: string }
  | { type: "text"; content: string; name?: string; language?: string };

export type ToolArtifact =
  | { type: "file"; path?: string; blobKey?: string; title?: string }
  | { type: "link"; url: string; title: string }
  | { type: "diff"; path?: string; content: string };

export interface ToolContext {
  userId: string;
  orgId: string;
  sessionId: string;
  threadId: string;
  sessionPurpose?: SessionPurpose;
  actor?: { id: string; name?: string; email?: string };
  channelType?: string;
  channelId?: string;
  decisionGateId?: string;
  replyChannelType?: string;
  replyChannelId?: string;
  cwd?: string;
  repo?: { url?: string; branch?: string; ref?: string; provider?: string };
  credentials: CredentialProvider;
  sandbox: Sandbox;
  requestDecision: (gate: DecisionGateRequest) => Promise<DecisionResolution>;
  emitArtifact?: (artifact: ToolArtifact) => Promise<void>;
  suspendedDecision?: { gateId: string; resolution?: DecisionResolution };
  signal: AbortSignal;
  threadRead: (key: string, opts?: MessageQuery) => Promise<SessionEntry[]>;
}

// ── Credentials ────────────────────────────────────────────────────

export interface Credential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

export interface CredentialProvider {
  get(service: string): Promise<Credential | null>;
  request(service: string, reason: string): Promise<Credential>;
}

export interface CredentialOwner {
  type: "user" | "org" | "session";
  id: string;
}

export interface StoredCredential {
  type: "oauth2" | "api_key" | "bot_token" | "service_account" | "app_install";
  accessToken?: string;
  refreshToken?: string;
  apiKey?: string;
  expiresAt?: number;
  scopes?: string[];
  metadata?: Record<string, unknown>;
}

export interface CredentialStore {
  get(owner: CredentialOwner, service: string): Promise<StoredCredential | null>;
  save(owner: CredentialOwner, service: string, credential: StoredCredential): Promise<void>;
  delete(owner: CredentialOwner, service: string): Promise<void>;
  list(owner: CredentialOwner): Promise<{ service: string; scopes?: string[]; connectedAt: string }[]>;
}

// ── Decision gates ─────────────────────────────────────────────────

export type DecisionGateType = "approval" | "question" | "credential_request";
export type DecisionGateStatus = "pending" | "resolved" | "expired" | "withdrawn";
export type DecisionWithdrawReason = "steer" | "abort" | "cancel";

export interface DecisionAction {
  id: string;
  label: string;
  style?: "primary" | "danger";
}

export interface DecisionGateRef {
  messageId: string;
  channelId: string;
  threadId?: string;
  [key: string]: unknown;
}

export interface DecisionGate {
  id: string;
  sessionId: string;
  threadId: string;
  type: DecisionGateType;
  title: string;
  body?: string;
  actions: DecisionAction[];
  expiresAt?: number;
  status: DecisionGateStatus;
  context?: Record<string, unknown>;
  origin?: { channelType?: string; channelId?: string; messageId?: string };
  refs?: Array<{ channelType: string; ref: DecisionGateRef }>;
  createdAt: number;
  updatedAt: number;
}

// what tools pass to ctx.requestDecision — minimal shape; engine fills in identity fields
export interface DecisionGateRequest {
  type: DecisionGateType;
  title: string;
  body?: string;
  actions?: DecisionAction[];
  expiresAt?: number;
  context?: Record<string, unknown>;
  origin?: DecisionGate["origin"];
  // stable ID for re-entrancy: tools must supply the same id when re-run with suspendedDecision
  resumeKey?: string;
}

export interface DecisionResolution {
  actionId?: string;
  value?: string;
  resolvedBy: string;
  resolvedAt: number;
  source?: { channelType?: string; channelId?: string; messageId?: string };
}

export interface SuspendedTurnState {
  sessionId: string;
  threadId: string;
  queueItemId: string;
  gateId: string;
  model: string;
  leafMessageId?: string;
  toolCallId: string;
  toolName: string;
  toolArgs: Record<string, unknown>;
  resumeKey: string;
  attempt: number;
  createdAt: number;
}

// ── Sandbox ────────────────────────────────────────────────────────

export interface ExecOpts {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
  signal?: AbortSignal;
  stdin?: string;
  maxOutputBytes?: number;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut?: boolean;
  truncated?: boolean;
}

export interface Sandbox {
  id: string;
  readFile(path: string): Promise<string>;
  readBinary(path: string): Promise<Uint8Array>;
  writeFile(path: string, content: string): Promise<void>;
  writeBinary(path: string, data: Uint8Array): Promise<void>;
  readdir(path: string): Promise<string[]>;
  stat(path: string): Promise<{ isFile: boolean; isDirectory: boolean; size: number }>;
  mkdir(path: string): Promise<void>;
  rm(path: string, opts?: { recursive?: boolean }): Promise<void>;
  exec(command: string, opts?: ExecOpts): Promise<ExecResult>;
  snapshot?(): Promise<string>;
  tunnels?(): Promise<Record<string, string>>;
  destroy?(): Promise<void>;
}

export interface SandboxCreateOpts {
  image?: string;
  workspace?: string;
  env?: Record<string, string>;
  timeout?: number;
  resources?: { cpu?: number; memory?: string };
  metadata?: Record<string, unknown>;
}

export interface SandboxStatus {
  id: string;
  state: "creating" | "running" | "stopped" | "error";
  startedAt?: number;
  error?: string;
}

export interface SandboxProvider {
  create(opts: SandboxCreateOpts): Promise<Sandbox>;
  restore(id: string): Promise<Sandbox>;
  destroy(id: string): Promise<void>;
  status(id: string): Promise<SandboxStatus>;
}

// ── Blob store ─────────────────────────────────────────────────────

export interface BlobStore {
  put(
    key: string,
    data: Uint8Array | ReadableStream,
    opts?: { contentType?: string },
  ): Promise<void>;
  get(key: string): Promise<{ data: ReadableStream; contentType?: string } | null>;
  delete(key: string): Promise<void>;
}

// ── Engine events ──────────────────────────────────────────────────

export type EngineEventStatus =
  | "idle"
  | "queued"
  | "thinking"
  | "tool_calling"
  | "streaming"
  | "blocked_on_decision_gate"
  | "error";

export type EngineEvent =
  | { type: "message_start"; threadId: string; messageId: string; role: "assistant" | "system" }
  | { type: "text_delta"; threadId: string; text: string }
  | {
      type: "message_update";
      threadId: string;
      messageId: string;
      parts: MessagePart[];
      content?: string;
    }
  | {
      type: "message_end";
      threadId: string;
      messageId: string;
      reason: "end_turn" | "error" | "abort";
    }
  | { type: "tool_start"; threadId: string; tool: string; args: Record<string, unknown> }
  | { type: "tool_end"; threadId: string; tool: string; result: string; isError: boolean }
  | { type: "turn_end"; threadId: string; reason: "end_turn" | "error" | "abort" }
  | { type: "thread_start"; threadId: string; parentThreadId?: string }
  | { type: "queue_state"; threadId: string; state: QueueState }
  | { type: "compaction_start" | "compaction_end"; threadId: string }
  | { type: "task_start" | "task_end"; childSessionId: string; threadId: string }
  | { type: "status"; threadId: string; status: EngineEventStatus }
  | { type: "error"; threadId?: string; code: string; error: string; recoverable: boolean }
  | { type: "decision_gate"; threadId: string; gate: DecisionGate }
  | { type: "decision_gate_resolved"; threadId: string; gateId: string; resolution: DecisionResolution }
  | { type: "decision_gate_expired"; threadId: string; gateId: string }
  | {
      type: "decision_gate_withdrawn";
      threadId: string;
      gateId: string;
      reason: DecisionWithdrawReason;
    }
  | { type: "model_switched"; threadId: string; fromModel: string; toModel: string; reason: string };

export interface BusEvent {
  sessionId: string;
  threadId?: string;
  userId?: string;
  event: EngineEvent;
  timestamp: number;
}

export type Unsubscribe = () => void;

export interface EventBus {
  publish(event: BusEvent): Promise<void>;
  subscribe(filter: EventFilter, callback: (event: BusEvent) => void): Unsubscribe;
}

export interface EventFilter {
  sessionId?: string;
  userId?: string;
  eventTypes?: string[];
}

// ── Session store ──────────────────────────────────────────────────

export interface ListOpts {
  limit?: number;
  cursor?: string;
  status?: string;
  createdAfter?: Date;
  createdBefore?: Date;
}

export interface SessionStore {
  saveSession(session: SessionData): Promise<void>;
  saveThread(sessionId: string, thread: ThreadData): Promise<void>;
  appendEntries(sessionId: string, threadId: string, entries: SessionEntry[]): Promise<void>;
  /**
   * Replace an existing entry in place. Required for pruning during
   * compaction to persist tool-result elision; also useful for any
   * other in-place mutation. Throws NotFoundError if no entry with the
   * given id exists in (sessionId, threadId).
   */
  updateEntry(sessionId: string, threadId: string, entry: SessionEntry): Promise<void>;
  saveQueueState(sessionId: string, threadId: string, queue: QueueState): Promise<void>;
  saveDecisionGate(sessionId: string, threadId: string, gate: DecisionGate): Promise<void>;
  saveDecisionGateRef(
    sessionId: string,
    threadId: string,
    gateId: string,
    ref: { channelType: string; ref: DecisionGateRef },
  ): Promise<void>;
  updateDecisionGateEntry(
    sessionId: string,
    threadId: string,
    gateId: string,
    patch: Partial<DecisionGateEntry>,
  ): Promise<void>;
  saveSuspendedTurn(
    sessionId: string,
    threadId: string,
    suspended: SuspendedTurnState,
  ): Promise<void>;
  clearSuspendedTurn(sessionId: string, threadId: string): Promise<void>;
  updateSessionStatus(
    id: string,
    status: SessionStatus,
    metadata?: Partial<SessionData>,
  ): Promise<void>;
  flush?(): Promise<void>;

  getSession(id: string): Promise<SessionData | null>;
  listSessions(userId: string, opts?: ListOpts): Promise<SessionData[]>;
  getThread(sessionId: string, threadId: string): Promise<ThreadData | null>;
  listThreads(sessionId: string): Promise<ThreadData[]>;
  getEntries(
    sessionId: string,
    threadId: string,
    opts?: MessageQuery,
  ): Promise<SessionEntry[]>;
  getQueueState(sessionId: string, threadId: string): Promise<QueueState | null>;
  listDecisionGates(sessionId: string, threadId?: string): Promise<DecisionGate[]>;
  getDecisionGate(sessionId: string, gateId: string): Promise<DecisionGate | null>;
  getSuspendedTurn(sessionId: string, threadId: string): Promise<SuspendedTurnState | null>;
  deleteSession(id: string): Promise<void>;
}

// ── Engine API ─────────────────────────────────────────────────────

export interface RoleSpec {
  name: string;
  description?: string;
  model?: string;
  content: string;
  source?: "session" | "thread" | "prompt" | "plugin" | "sandbox";
}

export interface SkillSource {
  name: string;
  description?: string;
  content: string;
  argsSchema?: TSchema;
  source?: "plugin" | "sandbox" | "repo" | "user";
}

export interface SkillInvokeOptions {
  args?: Record<string, unknown>;
  model?: string;
  author?: PromptAuthor;
  channel?: ChannelTarget;
  resultSchema?: TSchema;
}

export interface CreateSessionOptions {
  id?: string;
  userId: string;
  orgId: string;
  workspace: string;
  purpose?: SessionPurpose;
  parentSessionId?: string;
  parentThreadId?: string;
  sandbox: Sandbox | SandboxCreateOpts;
  tools?: ToolDef[];
  roles?: RoleSpec[];
  skills?: SkillSource[];
  model: Model<any>;
  modelFailover?: Model<any>[];
  queueMode?: QueueMode;
  /** Collect-mode buffering window in ms (default 5000). */
  collectWindowMs?: number;
  systemPrompt?: string;
  /** Compaction tuning. See CompactionConfig defaults. */
  compaction?: CompactionConfig;
  metadata?: Record<string, unknown>;
}

export interface CompactionConfig {
  /** Master switch. Default: true. */
  enabled?: boolean;
  /** Subtract from contextWindow when computing usable space. Default: min(20_000, model.maxOutputTokens). */
  reserveTokens?: number;
  /** Last N turns are never compacted. Default: 2. */
  tailTurns?: number;
  /** Floor for tail token budget. Default: 2_000. */
  minPreserveRecentTokens?: number;
  /** Ceiling for tail token budget. Default: 8_000. */
  maxPreserveRecentTokens?: number;
  /** Recent tool-output bytes never pruned. Default: 40_000 (estimated tokens). */
  pruneProtectTokens?: number;
  /** Pruning only commits if it'd save at least this many tokens. Default: 20_000. */
  pruneMinimumTokens?: number;
  /** Tool outputs longer than this get truncated when fed to the summarizer. Default: 2_000 chars. */
  toolOutputMaxChars?: number;
  /** Optional separate model for the summarization call. Default: session model. */
  summarizerModel?: Model<any>;
  /** Tool names whose outputs are exempt from pruning. Merged with ToolDef.protectedFromPruning. Defaults: ['skill', 'thread_read']. */
  protectedTools?: string[];
  /**
   * After a proactive compaction, inject a synthetic user message
   * ("Continue if you have next steps...") so the agent resumes the task.
   * Tagged with metadata.compaction_continue so client UIs can hide it.
   * Default: true. Reactive (overflow) compactions never auto-continue —
   * they retry the original turn that triggered the overflow.
   */
  autoContinue?: boolean;
}

/**
 * Options accepted by Engine.restoreSession. The host re-supplies tools,
 * sandbox, model, etc. — the engine does not maintain a registry of session
 * creation options across restarts.
 */
export interface RestoreSessionOptions {
  sessionId: string;
  options: Omit<CreateSessionOptions, "id">;
}

export interface ProviderBundle {
  store: SessionStore;
  bus: EventBus;
  blobs?: BlobStore;
  credentials?: CredentialStore;
  sandboxProvider?: SandboxProvider;
}

export interface EngineOptions {
  providers: ProviderBundle;
  defaultUserId?: string;
  defaultOrgId?: string;
}
