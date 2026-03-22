/**
 * RunnerLink — manages the runner WebSocket connection, send path,
 * and incoming message dispatch.
 *
 * Owns:
 * - Runner send path (`send()`)
 * - Runner connection state: `isConnected`, `isReady`, `token`
 * - Message dispatch: routes incoming runner messages to typed handlers
 *
 * Does NOT own:
 * - WebSocket primitives (ctx.acceptWebSocket, webSocketMessage) — DO APIs
 * - Handler bodies — those stay in the DO (they need DO dependencies)
 * - `runnerBusy` — owned by PromptQueue
 * - `errorSafetyNetAt` — owned by PromptQueue
 */

// ─── Runner Protocol Types ────────────────────────────────────────────────────

/** Agent status values for activity indication */
export type AgentStatus = 'idle' | 'thinking' | 'tool_calling' | 'streaming' | 'error';
export type ToolCallStatus = 'pending' | 'running' | 'completed' | 'error';

export interface PromptAttachment {
  type: 'file';
  mime: string;
  url: string;
  filename?: string;
}

export interface WorkflowExecutionDispatchPayload {
  kind: 'run' | 'resume';
  executionId: string;
  workflowHash?: string;
  resumeToken?: string;
  decision?: 'approve' | 'deny';
  payload: Record<string, unknown>;
}

/** Messages received from runner */
export interface RunnerMessage {
  type: 'stream' | 'result' | 'tool' | 'question' | 'screenshot' | 'error' | 'complete' | 'agentStatus' | 'create-pr' | 'update-pr' | 'list-pull-requests' | 'inspect-pull-request' | 'models' | 'aborted' | 'reverted' | 'diff' | 'review-result' | 'command-result' | 'ping' | 'git-state' | 'pr-created' | 'files-changed' | 'child-session' | 'title' | 'spawn-child' | 'session-message' | 'session-messages' | 'terminate-child' | 'self-terminate' | 'mem-read' | 'mem-write' | 'mem-patch' | 'mem-rm' | 'mem-search' | 'list-repos' | 'list-personas' | 'list-channels' | 'get-session-status' | 'list-child-sessions' | 'forward-messages' | 'read-repo-file' | 'workflow-list' | 'workflow-sync' | 'workflow-run' | 'workflow-executions' | 'workflow-api' | 'trigger-api' | 'execution-api' | 'skill-api' | 'persona-api' | 'identity-api' | 'workflow-execution-result' | 'workflow-chat-message' | 'model-switched' | 'tunnels' | 'mailbox-send' | 'mailbox-check' | 'task-create' | 'task-list' | 'task-update' | 'task-my' | 'channel-reply' | 'audio-transcript' | 'channel-session-created' | 'session-reset' | 'opencode-config-applied' | 'list-tools' | 'call-tool' | 'message.create' | 'message.part.text-delta' | 'message.part.tool-update' | 'message.finalize' | 'usage-report' | 'thread.created' | 'thread.updated' | 'repo:refresh-token' | 'repo:clone-complete' | 'analytics:emit';
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
  data?: string | { files?: { path: string; status: string; diff?: string }[] } | Record<string, unknown>;
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
  query?: string;
  operations?: unknown[];
  category?: string;
  memoryId?: string;
  relevance?: number;
  source?: string;
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
  channelType?: string;
  channelId?: string;
  message?: string;
  imageBase64?: string;
  imageMimeType?: string;
  followUp?: boolean;
  fileBase64?: string;
  fileMimeType?: string;
  fileName?: string;
  toolId?: string;
  params?: Record<string, unknown>;
  summary?: string;
  service?: string;
  channelKey?: string;
  opencodeSessionId?: string;
  threadId?: string;
  role?: 'user' | 'assistant' | 'system';
  parts?: Record<string, unknown>;
  entries?: Array<{ ocMessageId: string; model: string; inputTokens: number; outputTokens: number }>;
  summaryAdditions?: number;
  summaryDeletions?: number;
  summaryFiles?: number;
  success?: boolean;
}

/** Messages sent from DO to runner */
export interface RunnerOutbound {
  type: 'prompt' | 'answer' | 'stop' | 'abort' | 'revert' | 'diff' | 'review' | 'opencode-command' | 'pong' | 'init' | 'opencode-config' | 'plugin-content' | 'repo-config' | 'repo-token-refreshed' | 'spawn-child-result' | 'session-message-result' | 'session-messages-result' | 'create-pr-result' | 'update-pr-result' | 'list-pull-requests-result' | 'inspect-pull-request-result' | 'terminate-child-result' | 'mem-read-result' | 'mem-write-result' | 'mem-patch-result' | 'mem-rm-result' | 'mem-search-result' | 'list-repos-result' | 'list-personas-result' | 'list-channels-result' | 'get-session-status-result' | 'list-child-sessions-result' | 'forward-messages-result' | 'read-repo-file-result' | 'workflow-list-result' | 'workflow-sync-result' | 'workflow-run-result' | 'workflow-executions-result' | 'workflow-api-result' | 'trigger-api-result' | 'execution-api-result' | 'skill-api-result' | 'persona-api-result' | 'identity-api-result' | 'workflow-execute' | 'tunnel-delete' | 'channel-reply-result' | 'list-tools-result' | 'call-tool-result' | 'call-tool-pending';
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
  authorId?: string;
  authorEmail?: string;
  authorName?: string;
  gitName?: string;
  gitEmail?: string;
  channelType?: string;
  channelId?: string;
  opencodeSessionId?: string;
  replyChannelType?: string;
  replyChannelId?: string;
  threadId?: string;
  continuationContext?: string;
  memories?: unknown[];
  memory?: unknown;
  repos?: unknown[];
  personas?: unknown[];
  channels?: unknown[];
  sessionStatus?: unknown;
  pulls?: unknown[];
  data?: unknown;
  count?: number;
  sourceSessionId?: string;
  workflows?: unknown[];
  workflow?: unknown;
  execution?: unknown;
  executions?: unknown[];
  steps?: unknown[];
  executionId?: string;
  payload?: WorkflowExecutionDispatchPayload;
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
  token?: string;
  expiresAt?: string;
  gitConfig?: Record<string, string>;
  repoUrl?: string;
  branch?: string;
  [key: string]: unknown;
}

// ─── Handler Types ────────────────────────────────────────────────────────────

export type RunnerMessageHandler = (msg: RunnerMessage) => Promise<void> | void;

/**
 * Map of runner message types to their handler functions.
 * The DO populates this with handler methods/lambdas.
 * Unhandled types log a warning.
 */
export type RunnerMessageHandlers = Partial<Record<RunnerMessage['type'], RunnerMessageHandler>>;

// ─── Activity Detection ───────────────────────────────────────────────────────

/**
 * Message types that indicate active agent work.
 * These reset the idle timer when received.
 */
const ACTIVITY_TYPES: ReadonlySet<string> = new Set([
  'agentStatus',
  'message.create',
  'message.part.text-delta',
  'message.part.tool-update',
  'message.finalize',
]);

// ─── RunnerLink Class ─────────────────────────────────────────────────────────

export interface RunnerLinkDeps {
  /** Returns all WebSockets tagged as 'runner'. */
  getRunnerSockets: () => WebSocket[];
  /** Read a value from the DO state table. */
  getState: (key: string) => string | undefined;
  /** Write a value to the DO state table. */
  setState: (key: string, value: string) => void;
}

export class RunnerLink {
  private deps: RunnerLinkDeps;

  constructor(deps: RunnerLinkDeps) {
    this.deps = deps;
  }

  // ─── Connection State ───────────────────────────────────────────────

  /** Whether any runner WebSocket is currently connected. */
  get isConnected(): boolean {
    return this.deps.getRunnerSockets().length > 0;
  }

  /**
   * Whether the runner is ready to accept prompts.
   * Set to false on connect, true when runner signals first `agentStatus: idle`.
   */
  get isReady(): boolean {
    return this.deps.getState('runnerReady') !== 'false' && this.isConnected;
  }

  set ready(val: boolean) {
    this.deps.setState('runnerReady', String(val));
  }

  /** The authentication token for runner WebSocket connections. */
  get token(): string | undefined {
    return this.deps.getState('runnerToken') || undefined;
  }

  set token(val: string) {
    this.deps.setState('runnerToken', val);
  }

  // ─── Send ───────────────────────────────────────────────────────────

  /**
   * Send a message to the runner. Returns false if no runner is connected
   * or all sends fail.
   */
  send(message: RunnerOutbound): boolean {
    if (message.type === 'prompt') {
      console.log(`[RunnerLink] sendToRunner prompt: messageId=${message.messageId}`);
    }
    const runners = this.deps.getRunnerSockets();
    if (runners.length === 0) {
      console.warn(`[RunnerLink] sendToRunner: no runner sockets available for type=${message.type}`);
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
      console.warn(`[RunnerLink] sendToRunner: all sends failed for type=${message.type}`);
    }
    return sent;
  }

  // ─── Message Dispatch ───────────────────────────────────────────────

  /**
   * Dispatch an incoming runner message to the appropriate handler.
   *
   * @param msg - The parsed runner message
   * @param handlers - Map of message types to handler functions (provided by DO)
   * @param onActivity - Optional callback invoked when the message indicates agent activity
   */
  async handleMessage(
    msg: RunnerMessage,
    handlers: RunnerMessageHandlers,
    onActivity?: () => void,
  ): Promise<void> {
    console.log(`[RunnerLink] Runner message: type=${msg.type}`);

    // Reset idle timer on agent activity messages
    if (ACTIVITY_TYPES.has(msg.type) && onActivity) {
      onActivity();
    }

    const handler = handlers[msg.type];
    if (handler) {
      await handler(msg);
    } else {
      console.warn(`[RunnerLink] Unhandled runner message type: ${msg.type}`);
    }
  }

  // ─── Connection Lifecycle ───────────────────────────────────────────

  /**
   * Called when a runner WebSocket connects.
   * Marks the runner as not-yet-ready (it needs to initialize before accepting prompts).
   */
  onConnect(): void {
    this.ready = false;
    console.log('[RunnerLink] Runner connected — waiting for ready signal');
  }

  /**
   * Called when the runner WebSocket disconnects.
   * Marks the runner as not ready.
   */
  onDisconnect(): void {
    this.ready = false;
    console.log('[RunnerLink] Runner disconnected');
  }
}
