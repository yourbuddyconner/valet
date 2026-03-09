/**
 * AgentClient — WebSocket connection from Runner to SessionAgent DO.
 *
 * Handles:
 * - Persistent WebSocket connection with auto-reconnect + exponential backoff
 * - Message buffering while disconnected
 * - Typed outbound/inbound message protocol
 */

import type {
  AgentStatus,
  AvailableModels,
  DiffFile,
  DOToRunnerMessage,
  PromptAttachment,
  ReviewResultData,
  RunnerToDOMessage,
  ToolCallStatus,
  WorkflowRunResultEnvelope,
} from "./types.js";

export interface PromptAuthor {
  authorId?: string;
  gitName?: string;
  gitEmail?: string;
  authorName?: string;
  authorEmail?: string;
}

const MAX_RECONNECT_DELAY_MS = 30_000;
const INITIAL_RECONNECT_DELAY_MS = 1_000;
const PING_INTERVAL_MS = 30_000;
const SPAWN_CHILD_TIMEOUT_MS = 60_000;
const TERMINATE_CHILD_TIMEOUT_MS = 30_000;
const MESSAGE_OP_TIMEOUT_MS = 15_000;
const PR_OP_TIMEOUT_MS = 30_000;
const TOOL_OP_TIMEOUT_MS = 30_000;
const APPROVAL_TIMEOUT_MS = 11 * 60 * 1000; // 11 min — slightly longer than DO's 10 min expiry
// If the server rejects the WebSocket upgrade N times in a row (e.g. 401 due to
// rotated token), stop retrying and exit — the sandbox has been replaced.
const MAX_CONSECUTIVE_UPGRADE_FAILURES = 5;

export class AgentClient {
  private ws: WebSocket | null = null;
  private buffer: string[] = [];
  private reconnectAttempts = 0;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private closing = false;
  private consecutiveUpgradeFailures = 0;
  private hasEverConnected = false;

  private promptHandler: ((messageId: string, content: string, model?: string, author?: PromptAuthor, modelPreferences?: string[], attachments?: PromptAttachment[], channelType?: string, channelId?: string, opencodeSessionId?: string) => void | Promise<void>) | null = null;
  private answerHandler: ((questionId: string, answer: string | boolean) => void | Promise<void>) | null = null;
  private stopHandler: (() => void) | null = null;
  private abortHandler: ((channelType?: string, channelId?: string) => void | Promise<void>) | null = null;
  private revertHandler: ((messageId: string) => void | Promise<void>) | null = null;
  private diffHandler: ((requestId: string) => void | Promise<void>) | null = null;
  private reviewHandler: ((requestId: string) => void | Promise<void>) | null = null;
  private tunnelDeleteHandler: ((name: string, actor?: { id?: string; name?: string; email?: string }) => void | Promise<void>) | null = null;
  private openCodeCommandHandler: ((command: string, args: string | undefined, requestId: string) => void | Promise<void>) | null = null;
  private workflowExecuteHandler: ((executionId: string, payload: {
    kind: "run" | "resume";
    executionId: string;
    workflowHash?: string;
    resumeToken?: string;
    decision?: "approve" | "deny";
    payload: Record<string, unknown>;
  }, model?: string, modelPreferences?: string[]) => void | Promise<void>) | null = null;
  private newSessionHandler: ((channelType: string, channelId: string, requestId: string) => void | Promise<void>) | null = null;
  private initHandler: (() => void | Promise<void>) | null = null;
  private openCodeConfigHandler: ((config: { tools?: Record<string, boolean>; providerKeys?: Record<string, string>; instructions?: string[]; isOrchestrator?: boolean; customProviders?: Array<{ providerId: string; displayName: string; baseUrl: string; apiKey?: string; models: Array<{ id: string; name?: string; contextLimit?: number; outputLimit?: number }> }> }) => void | Promise<void>) | null = null;
  private pluginContentHandler: ((content: {
    personas: Array<{ filename: string; content: string; sortOrder: number }>;
    skills: Array<{ filename: string; content: string }>;
    tools: Array<{ filename: string; content: string }>;
    allowRepoContent: boolean;
    toolWhitelist?: {
      services: string[];
      excludedActions: Array<{ service: string; actionId: string }>;
    } | null;
  }) => void | Promise<void>) | null = null;

  private pendingRequests = new Map<string, {
    resolve: (value: any) => void;
    reject: (reason: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();

  constructor(
    private doUrl: string,
    private runnerToken: string,
  ) {}

  // ─── Lifecycle ───────────────────────────────────────────────────────

  async connect(): Promise<void> {
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }

    return new Promise((resolve, reject) => {
      const url = `${this.doUrl}?role=runner&token=${encodeURIComponent(this.runnerToken)}`;
      console.log(`[AgentClient] Connecting to DO: ${this.doUrl}`);

      let settled = false;

      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        reject(err);
        return;
      }

      const socket = this.ws;

      socket.addEventListener("open", () => {
        if (this.ws !== socket) return;
        settled = true;
        console.log("[AgentClient] Connected to SessionAgent DO");
        this.reconnectAttempts = 0;
        this.consecutiveUpgradeFailures = 0;
        this.hasEverConnected = true;
        this.flushBuffer();
        this.startPing();
        resolve();
      });

      socket.addEventListener("message", (event) => {
        if (this.ws !== socket) return;
        this.handleMessage(event.data as string);
      });

      socket.addEventListener("close", (event) => {
        if (this.ws === socket) {
          this.ws = null;
        }
        console.log(`[AgentClient] Connection closed: ${event.code} ${event.reason}`);
        this.stopPing();

        // SessionAgent closes previous runner sockets with a normal close when a
        // replacement runner takes over. This runner is now stale and should
        // terminate immediately rather than trying to reconnect with an invalid token.
        const replacedByNewRunner =
          event.code === 1000 &&
          typeof event.reason === "string" &&
          event.reason.includes("Replaced by new runner connection");
        if (replacedByNewRunner) {
          console.log("[AgentClient] Superseded by newer runner connection; exiting");
          this.closing = true;
          process.exit(0);
        }

        // Code 1002 = WebSocket upgrade rejected by server (HTTP 401/403/503 etc.)
        // Code 1006 = abnormal closure — Bun surfaces failed HTTP upgrades as 1006
        //   rather than 1002, so treat both as upgrade failures when the socket
        //   never opened (settled is still false from the initial promise).
        // Track consecutive upgrade failures — if the token was rotated (sandbox replaced),
        // exit the process so this stale sandbox stops consuming resources.
        if (event.code === 1002 || (event.code === 1006 && !settled)) {
          this.consecutiveUpgradeFailures++;
          if (this.consecutiveUpgradeFailures >= MAX_CONSECUTIVE_UPGRADE_FAILURES) {
            console.log(`[AgentClient] ${this.consecutiveUpgradeFailures} consecutive upgrade failures — token likely rotated, exiting`);
            this.closing = true;
            process.exit(1);
          }
        }

        if (!settled) {
          settled = true;
          reject(new Error(event.reason || `WebSocket closed with code ${event.code}`));
          return;
        }
        if (!this.closing) {
          this.scheduleReconnect();
        }
      });

      socket.addEventListener("error", (event) => {
        console.error("[AgentClient] WebSocket error:", event);
        if (!settled) {
          settled = true;
          reject(new Error("WebSocket connection failed"));
        }
        // Close event may follow and trigger reconnect
      });
    });
  }

  disconnect(): void {
    this.closing = true;
    this.stopPing();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.close(1000, "Runner shutting down");
      this.ws = null;
    }
  }

  // ─── Outbound (Runner → DO) ─────────────────────────────────────────

  sendWorkflowChatMessage(
    role: "user" | "assistant" | "system",
    content: string,
    parts?: Record<string, unknown>,
    context?: { channelType?: string; channelId?: string; opencodeSessionId?: string },
  ): void {
    this.send({
      type: "workflow-chat-message",
      role,
      content,
      ...(parts ? { parts } : {}),
      ...(context?.channelType ? { channelType: context.channelType } : {}),
      ...(context?.channelId ? { channelId: context.channelId } : {}),
      ...(context?.opencodeSessionId ? { opencodeSessionId: context.opencodeSessionId } : {}),
    });
  }

  sendQuestion(questionId: string, text: string, options?: string[]): void {
    this.send({ type: "question", questionId, text, options });
  }

  sendScreenshot(data: string, description: string): void {
    this.send({ type: "screenshot", data, description });
  }

  sendError(messageId: string, error: string): void {
    this.send({ type: "error", messageId, error });
  }

  sendComplete(): void {
    this.send({ type: "complete" });
  }

  sendAgentStatus(status: AgentStatus, detail?: string): void {
    this.send({ type: "agentStatus", status, detail });
  }

  requestCreatePullRequest(params: { branch: string; title: string; body?: string; base?: string }): Promise<{ number: number; url: string; title: string; state: string }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, PR_OP_TIMEOUT_MS, () => {
      this.send({ type: "create-pr", requestId, ...params });
    });
  }

  requestUpdatePullRequest(params: { prNumber: number; title?: string; body?: string; state?: string; labels?: string[] }): Promise<{ number: number; url: string; title: string; state: string }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, PR_OP_TIMEOUT_MS, () => {
      this.send({ type: "update-pr", requestId, ...params });
    });
  }

  sendGitState(params: { branch?: string; baseBranch?: string; commitCount?: number }): void {
    this.send({ type: "git-state", ...params });
  }

  sendModels(models: AvailableModels): void {
    this.send({ type: "models", models });
  }

  sendModelSwitched(messageId: string, fromModel: string, toModel: string, reason: string): void {
    this.send({ type: "model-switched", messageId, fromModel, toModel, reason });
  }

  sendTunnels(tunnels: Array<{ name: string; port: number; protocol?: string; path: string }>): void {
    this.send({ type: "tunnels", tunnels });
  }

  sendWorkflowExecutionResult(executionId: string, envelope: WorkflowRunResultEnvelope): void {
    this.send({ type: "workflow-execution-result", executionId, envelope });
  }

  sendAborted(): void {
    this.send({ type: "aborted" });
  }

  sendChannelSessionCreated(channelKey: string, opencodeSessionId: string): void {
    this.send({ type: "channel-session-created", channelKey, opencodeSessionId });
  }

  sendSessionReset(channelType: string, channelId: string, requestId: string): void {
    this.send({ type: "session-reset", channelType, channelId, requestId });
  }

  // ─── V2 Parts-Based Message Protocol ──────────────────────────────

  sendTurnCreate(turnId: string, context?: { channelType?: string; channelId?: string; opencodeSessionId?: string }): void {
    this.send({
      type: "message.create",
      turnId,
      ...(context?.channelType ? { channelType: context.channelType } : {}),
      ...(context?.channelId ? { channelId: context.channelId } : {}),
      ...(context?.opencodeSessionId ? { opencodeSessionId: context.opencodeSessionId } : {}),
    });
  }

  sendTextDelta(turnId: string, delta: string): void {
    this.send({ type: "message.part.text-delta", turnId, delta });
  }

  sendToolUpdate(turnId: string, callId: string, toolName: string, status: ToolCallStatus, args?: unknown, result?: unknown, error?: string): void {
    this.send({ type: "message.part.tool-update", turnId, callId, toolName, status, args, result, error });
  }

  sendTurnFinalize(turnId: string, reason: "end_turn" | "error" | "canceled", finalText?: string, error?: string): void {
    this.send({ type: "message.finalize", turnId, reason, finalText, error });
  }

  sendReverted(messageIds: string[]): void {
    this.send({ type: "reverted", messageIds });
  }

  sendDiff(requestId: string, files: DiffFile[]): void {
    this.send({ type: "diff", requestId, data: { files } });
  }

  sendFilesChanged(files: Array<{ path: string; status: string; additions?: number; deletions?: number }>): void {
    this.send({ type: "files-changed", files });
  }

  sendReviewResult(requestId: string, data?: ReviewResultData, diffFiles?: DiffFile[], error?: string): void {
    this.send({ type: "review-result", requestId, data, diffFiles, error });
  }

  sendChildSession(childSessionId: string, title?: string): void {
    this.send({ type: "child-session", childSessionId, title } as any);
  }

  sendAudioTranscript(messageId: string, transcript: string): void {
    this.send({ type: "audio-transcript", messageId, transcript } as any);
  }

  sendCommandResult(requestId: string, command: string, result?: unknown, error?: string): void {
    this.send({ type: "command-result", requestId, command, result, error });
  }

  sendOpenCodeConfigApplied(success: boolean, restarted: boolean, error?: string): void {
    this.send({ type: "opencode-config-applied", success, restarted, error });
  }

  sendUsageReport(turnId: string, entries: Array<{ ocMessageId: string; model: string; inputTokens: number; outputTokens: number }>): void {
    if (entries.length === 0) return;
    this.send({ type: "usage-report", turnId, entries });
  }

  // ─── Request/Response (Runner → DO → Runner) ─────────────────────────

  requestSpawnChild(params: {
    task: string;
    workspace: string;
    repoUrl?: string;
    branch?: string;
    ref?: string;
    title?: string;
    sourceType?: string;
    sourcePrNumber?: number;
    sourceIssueNumber?: number;
    sourceRepoFullName?: string;
    model?: string;
  }): Promise<{ childSessionId: string }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, SPAWN_CHILD_TIMEOUT_MS, () => {
      this.send({ type: "spawn-child", requestId, ...params });
    });
  }

  requestSendMessage(targetSessionId: string, content: string, interrupt: boolean = false): Promise<{ success: boolean }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "session-message", requestId, targetSessionId, content, interrupt });
    });
  }

  requestReadMessages(
    targetSessionId: string,
    limit?: number,
    after?: string,
  ): Promise<{ messages: Array<{ role: string; content: string; createdAt: string }> }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "session-messages", requestId, targetSessionId, limit, after });
    });
  }

  requestTerminateChild(childSessionId: string): Promise<{ success: boolean }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, TERMINATE_CHILD_TIMEOUT_MS, () => {
      this.send({ type: "terminate-child", requestId, childSessionId });
    });
  }

  requestMemRead(path: string): Promise<{ file?: unknown; files?: unknown[]; content?: string }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "mem-read", requestId, path });
    });
  }

  requestMemWrite(path: string, content: string): Promise<{ file: unknown }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "mem-write", requestId, path, content });
    });
  }

  requestMemPatch(path: string, operations: unknown[]): Promise<{ result: unknown }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "mem-patch", requestId, path, operations });
    });
  }

  requestMemRm(path: string): Promise<{ deleted: number }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "mem-rm", requestId, path });
    });
  }

  requestMemSearch(query: string, path?: string, limit?: number): Promise<{ results: unknown[] }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "mem-search", requestId, query, path, limit });
    });
  }

  requestListRepos(source?: string): Promise<{ repos: unknown[] }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "list-repos", requestId, source });
    });
  }

  requestListPullRequests(params: { owner?: string; repo?: string; state?: string; limit?: number }): Promise<{ pulls: unknown[] }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "list-pull-requests", requestId, ...params });
    });
  }

  requestInspectPullRequest(params: { prNumber: number; owner?: string; repo?: string; filesLimit?: number; commentsLimit?: number }): Promise<unknown> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "inspect-pull-request", requestId, ...params });
    });
  }

  requestListPersonas(): Promise<{ personas: unknown[] }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "list-personas", requestId });
    });
  }

  requestListChannels(): Promise<{ channels: unknown[] }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "list-channels", requestId });
    });
  }

  requestListChildSessions(): Promise<{ children: unknown[] }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "list-child-sessions", requestId });
    });
  }

  requestGetSessionStatus(targetSessionId: string): Promise<{ sessionStatus: unknown }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "get-session-status", requestId, targetSessionId });
    });
  }

  requestForwardMessages(targetSessionId: string, limit?: number, after?: string): Promise<{ count: number; sourceSessionId: string }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "forward-messages", requestId, targetSessionId, limit, after });
    });
  }

  requestReadRepoFile(params: { owner?: string; repo?: string; repoUrl?: string; path: string; ref?: string }): Promise<{ content: string; encoding?: string; truncated?: boolean; path?: string; repo?: string; ref?: string }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "read-repo-file", requestId, ...params });
    });
  }

  requestListWorkflows(): Promise<{ workflows: unknown[] }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "workflow-list", requestId });
    });
  }

  requestSyncWorkflow(params: {
    id?: string;
    slug?: string;
    name: string;
    description?: string;
    version?: string;
    data: Record<string, unknown>;
  }): Promise<{ success: boolean; workflow?: unknown }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "workflow-sync", requestId, ...params });
    });
  }

  requestRunWorkflow(
    workflowId: string,
    variables?: Record<string, unknown>,
    options?: { repoUrl?: string; branch?: string; ref?: string; sourceRepoFullName?: string },
  ): Promise<{ execution: unknown }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({
        type: "workflow-run",
        requestId,
        workflowId,
        variables,
        repoUrl: options?.repoUrl,
        branch: options?.branch,
        ref: options?.ref,
        sourceRepoFullName: options?.sourceRepoFullName,
      });
    });
  }

  requestListWorkflowExecutions(workflowId?: string, limit?: number): Promise<{ executions: unknown[] }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "workflow-executions", requestId, workflowId, limit });
    });
  }

  requestGetWorkflow(workflowId: string): Promise<{ workflow: unknown }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "workflow-api", requestId, action: "get", payload: { workflowId } });
    });
  }

  requestUpdateWorkflow(workflowId: string, payload: Record<string, unknown>): Promise<{ workflow: unknown }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "workflow-api", requestId, action: "update", payload: { workflowId, ...payload } });
    });
  }

  requestDeleteWorkflow(workflowId: string): Promise<{ success: boolean }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "workflow-api", requestId, action: "delete", payload: { workflowId } });
    });
  }

  requestListTriggers(filters?: { workflowId?: string; type?: string; enabled?: boolean }): Promise<{ triggers: unknown[] }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "trigger-api", requestId, action: "list", payload: filters || {} });
    });
  }

  requestSyncTrigger(params: {
    triggerId?: string;
    workflowId?: string | null;
    name?: string;
    enabled?: boolean;
    config?: Record<string, unknown>;
    variableMapping?: Record<string, string>;
  }): Promise<{ trigger?: unknown; success?: boolean }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({
        type: "trigger-api",
        requestId,
        action: params.triggerId ? "update" : "create",
        payload: params as Record<string, unknown>,
      });
    });
  }

  requestRunTrigger(
    triggerId: string,
    params?: { variables?: Record<string, unknown>; repoUrl?: string; branch?: string; ref?: string; sourceRepoFullName?: string },
  ): Promise<Record<string, unknown>> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({
        type: "trigger-api",
        requestId,
        action: "run",
        payload: {
          triggerId,
          variables: params?.variables,
          repoUrl: params?.repoUrl,
          branch: params?.branch,
          ref: params?.ref,
          sourceRepoFullName: params?.sourceRepoFullName,
        },
      });
    });
  }

  requestDeleteTrigger(triggerId: string): Promise<{ success: boolean }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "trigger-api", requestId, action: "delete", payload: { triggerId } });
    });
  }

  requestGetExecution(executionId: string): Promise<{ execution: unknown }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "execution-api", requestId, action: "get", payload: { executionId } });
    });
  }

  requestGetExecutionSteps(executionId: string): Promise<{ steps: unknown[] }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "execution-api", requestId, action: "steps", payload: { executionId } });
    });
  }

  requestApproveExecution(
    executionId: string,
    params: { approve: boolean; resumeToken: string; reason?: string },
  ): Promise<{ success: boolean; status?: string }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({
        type: "execution-api",
        requestId,
        action: "approve",
        payload: { executionId, approve: params.approve, resumeToken: params.resumeToken, reason: params.reason },
      });
    });
  }

  requestCancelExecution(
    executionId: string,
    params?: { reason?: string },
  ): Promise<{ success: boolean; status?: string }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({
        type: "execution-api",
        requestId,
        action: "cancel",
        payload: { executionId, reason: params?.reason },
      });
    });
  }

  // ─── Phase C: Mailbox + Task Board ────────────────────────────────

  requestMailboxSend(params: {
    toSessionId?: string;
    toUserId?: string;
    toHandle?: string;
    messageType?: string;
    content: string;
    contextSessionId?: string;
    contextTaskId?: string;
    replyToId?: string;
  }): Promise<{ messageId: string }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "mailbox-send", requestId, ...params });
    });
  }

  requestMailboxCheck(limit?: number, after?: string): Promise<{ messages: unknown[] }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "mailbox-check", requestId, limit, after });
    });
  }

  requestTaskCreate(params: {
    title: string;
    description?: string;
    sessionId?: string;
    parentTaskId?: string;
    blockedBy?: string[];
  }): Promise<{ task: unknown }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "task-create", requestId, ...params });
    });
  }

  requestTaskList(params?: { status?: string; limit?: number }): Promise<{ tasks: unknown[] }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "task-list", requestId, ...params });
    });
  }

  requestTaskUpdate(taskId: string, updates: {
    status?: string;
    result?: string;
    description?: string;
    sessionId?: string;
    title?: string;
  }): Promise<{ task: unknown }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "task-update", requestId, taskId, ...updates });
    });
  }

  requestMyTasks(status?: string): Promise<{ tasks: unknown[] }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "task-my", requestId, status });
    });
  }

  // ─── Phase D: Channel Reply ──────────────────────────────────────

  requestChannelReply(channelType: string, channelId: string, message: string, imageBase64?: string, imageMimeType?: string, followUp?: boolean): Promise<{ success: boolean }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "channel-reply", requestId, channelType, channelId, message, imageBase64, imageMimeType, followUp });
    });
  }

  // ─── Tool Discovery & Invocation ──────────────────────────────

  requestListTools(service?: string, query?: string): Promise<{ tools: unknown[]; warnings?: Array<{ service: string; displayName: string; reason: string; message: string }> }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, TOOL_OP_TIMEOUT_MS, () => {
      this.send({ type: "list-tools", requestId, service, query });
    });
  }

  requestCallTool(toolId: string, params: Record<string, unknown>): Promise<{ result: unknown }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, TOOL_OP_TIMEOUT_MS, () => {
      this.send({ type: "call-tool", requestId, toolId, params });
    });
  }

  // ─── Skill API ──────────────────────────────────────────────────

  requestSkillApi(action: string, payload?: Record<string, unknown>): Promise<{ data?: unknown; error?: string; statusCode?: number }> {
    const requestId = crypto.randomUUID();
    return this.createPendingRequest(requestId, MESSAGE_OP_TIMEOUT_MS, () => {
      this.send({ type: "skill-api", requestId, action, payload });
    });
  }

  requestSelfTerminate(): void {
    this.send({ type: "self-terminate" });
    // Disconnect and exit — the DO will handle sandbox termination
    setTimeout(() => {
      this.disconnect();
      process.exit(0);
    }, 500);
  }

  private createPendingRequest<T>(requestId: string, timeoutMs: number, sendFn: () => void): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        reject(new Error(`Request ${requestId} timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      this.pendingRequests.set(requestId, { resolve, reject, timer });
      sendFn();
    });
  }

  private resolvePendingRequest(requestId: string, value: any): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(requestId);
      pending.resolve(value);
    }
  }

  private rejectPendingRequest(requestId: string, error: string): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingRequests.delete(requestId);
      pending.reject(new Error(error));
    }
  }

  /**
   * Extend the timeout on a pending request (e.g. when waiting for human approval).
   * Clears the old timer and sets a new one with the given timeout.
   */
  private extendPendingRequestTimeout(requestId: string, newTimeoutMs: number): void {
    const pending = this.pendingRequests.get(requestId);
    if (pending) {
      clearTimeout(pending.timer);
      pending.timer = setTimeout(() => {
        this.pendingRequests.delete(requestId);
        pending.reject(new Error('Action approval timed out'));
      }, newTimeoutMs);
    }
  }

  // ─── Inbound Handlers (DO → Runner) ─────────────────────────────────

  onPrompt(handler: (messageId: string, content: string, model?: string, author?: PromptAuthor, modelPreferences?: string[], attachments?: PromptAttachment[], channelType?: string, channelId?: string, opencodeSessionId?: string) => void | Promise<void>): void {
    this.promptHandler = handler;
  }

  onAnswer(handler: (questionId: string, answer: string | boolean) => void | Promise<void>): void {
    this.answerHandler = handler;
  }

  onStop(handler: () => void): void {
    this.stopHandler = handler;
  }

  onAbort(handler: (channelType?: string, channelId?: string) => void | Promise<void>): void {
    this.abortHandler = handler;
  }

  onRevert(handler: (messageId: string) => void | Promise<void>): void {
    this.revertHandler = handler;
  }

  onDiff(handler: (requestId: string) => void | Promise<void>): void {
    this.diffHandler = handler;
  }

  onReview(handler: (requestId: string) => void | Promise<void>): void {
    this.reviewHandler = handler;
  }

  onOpenCodeCommand(handler: (command: string, args: string | undefined, requestId: string) => void | Promise<void>): void {
    this.openCodeCommandHandler = handler;
  }

  onTunnelDelete(handler: (name: string, actor?: { id?: string; name?: string; email?: string }) => void | Promise<void>): void {
    this.tunnelDeleteHandler = handler;
  }

  onWorkflowExecute(handler: (executionId: string, payload: {
    kind: "run" | "resume";
    executionId: string;
    workflowHash?: string;
    resumeToken?: string;
    decision?: "approve" | "deny";
    payload: Record<string, unknown>;
  }, model?: string, modelPreferences?: string[]) => void | Promise<void>): void {
    this.workflowExecuteHandler = handler;
  }

  onNewSession(handler: (channelType: string, channelId: string, requestId: string) => void | Promise<void>): void {
    this.newSessionHandler = handler;
  }

  onInit(handler: () => void | Promise<void>): void {
    this.initHandler = handler;
  }

  onOpenCodeConfig(handler: (config: { tools?: Record<string, boolean>; providerKeys?: Record<string, string>; instructions?: string[]; isOrchestrator?: boolean; customProviders?: Array<{ providerId: string; displayName: string; baseUrl: string; apiKey?: string; models: Array<{ id: string; name?: string; contextLimit?: number; outputLimit?: number }> }>; builtInProviderModelConfigs?: Array<{ providerId: string; models: Array<{ id: string; name?: string }>; showAllModels: boolean }> }) => void | Promise<void>): void {
    this.openCodeConfigHandler = handler;
  }

  onPluginContent(handler: typeof this.pluginContentHandler): void {
    this.pluginContentHandler = handler;
  }

  // ─── Keepalive ──────────────────────────────────────────────────────

  private startPing(): void {
    this.stopPing();
    this.pingTimer = setInterval(() => {
      this.send({ type: "ping" });
    }, PING_INTERVAL_MS);
  }

  private stopPing(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  // ─── Internal ────────────────────────────────────────────────────────

  private send(message: RunnerToDOMessage): void {
    const payload = JSON.stringify(message);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(payload);
    } else {
      // Buffer while disconnected
      this.buffer.push(payload);
    }
  }

  private flushBuffer(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    while (this.buffer.length > 0) {
      const msg = this.buffer.shift()!;
      this.ws.send(msg);
    }
  }

  private async handleMessage(raw: string): Promise<void> {
    let msg: DOToRunnerMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.error("[AgentClient] Invalid JSON from DO:", raw);
      return;
    }

    try {
      switch (msg.type) {
        case "prompt": {
          const author: PromptAuthor | undefined = (msg.authorId || msg.gitName || msg.gitEmail || msg.authorName || msg.authorEmail)
            ? { authorId: msg.authorId, gitName: msg.gitName, gitEmail: msg.gitEmail, authorName: msg.authorName, authorEmail: msg.authorEmail }
            : undefined;
          await this.promptHandler?.(msg.messageId, msg.content, msg.model, author, msg.modelPreferences, msg.attachments, msg.channelType, msg.channelId, msg.opencodeSessionId);
          break;
        }
        case "answer":
          await this.answerHandler?.(msg.questionId, msg.answer);
          break;
        case "stop":
          this.stopHandler?.();
          break;
        case "abort":
          await this.abortHandler?.(msg.channelType, msg.channelId);
          break;
        case "revert":
          await this.revertHandler?.(msg.messageId);
          break;
        case "diff":
          await this.diffHandler?.(msg.requestId);
          break;
        case "review":
          await this.reviewHandler?.(msg.requestId);
          break;
        case "opencode-command":
          await this.openCodeCommandHandler?.(msg.command, msg.args, msg.requestId);
          break;

        case "new-session":
          await this.newSessionHandler?.(msg.channelType, msg.channelId, msg.requestId);
          break;

        case "pong":
          // Keepalive response — no action needed
          break;

        case "init":
          await this.initHandler?.();
          break;

        case "opencode-config":
          await this.openCodeConfigHandler?.(msg.config);
          break;

        case "plugin-content":
          await this.pluginContentHandler?.(msg.pluginContent);
          break;

        case "spawn-child-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { childSessionId: msg.childSessionId });
          }
          break;

        case "session-message-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { success: true });
          }
          break;

        case "session-messages-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { messages: msg.messages ?? [] });
          }
          break;

        case "create-pr-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { number: msg.number, url: msg.url, title: msg.title, state: msg.state });
          }
          break;

        case "update-pr-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { number: msg.number, url: msg.url, title: msg.title, state: msg.state });
          }
          break;

        case "list-pull-requests-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { pulls: msg.pulls ?? [] });
          }
          break;

        case "inspect-pull-request-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, msg.data ?? null);
          }
          break;

        case "terminate-child-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { success: true });
          }
          break;

        case "mem-read-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { file: msg.file, files: msg.files });
          }
          break;

        case "mem-write-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { file: msg.file });
          }
          break;

        case "mem-patch-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { result: msg.result });
          }
          break;

        case "mem-rm-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { deleted: msg.deleted ?? 0 });
          }
          break;

        case "mem-search-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { results: msg.results ?? [] });
          }
          break;

        case "list-repos-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { repos: msg.repos ?? [] });
          }
          break;

        case "list-personas-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { personas: msg.personas ?? [] });
          }
          break;

        case "list-channels-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { channels: msg.channels ?? [] });
          }
          break;

        case "get-session-status-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { sessionStatus: msg.sessionStatus });
          }
          break;

        case "list-child-sessions-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { children: msg.children ?? [] });
          }
          break;

        case "forward-messages-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { count: msg.count, sourceSessionId: msg.sourceSessionId });
          }
          break;
        case "read-repo-file-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, {
              content: msg.content ?? "",
              encoding: msg.encoding,
              truncated: msg.truncated,
              path: msg.path,
              repo: msg.repo,
              ref: msg.ref,
            });
          }
          break;
        case "workflow-list-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { workflows: msg.workflows ?? [] });
          }
          break;
        case "workflow-sync-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, {
              success: msg.success ?? true,
              workflow: msg.workflow,
            });
          }
          break;
        case "workflow-run-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { execution: msg.execution ?? null });
          }
          break;
        case "workflow-executions-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { executions: msg.executions ?? [] });
          }
          break;
        case "workflow-api-result":
        case "trigger-api-result":
        case "execution-api-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, msg.data ?? {});
          }
          break;
        case "skill-api-result":
          if (msg.error) {
            this.resolvePendingRequest(msg.requestId, { error: msg.error, statusCode: msg.statusCode });
          } else {
            this.resolvePendingRequest(msg.requestId, { data: msg.data ?? {} });
          }
          break;
        // ─── Phase C: Mailbox + Task Board Results ──────────────────
        case "mailbox-send-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { messageId: msg.messageId });
          }
          break;

        case "mailbox-check-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { messages: msg.messages ?? [] });
          }
          break;

        case "task-create-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { task: msg.task });
          }
          break;

        case "task-list-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { tasks: msg.tasks ?? [] });
          }
          break;

        case "task-update-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { task: msg.task });
          }
          break;

        case "task-my-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { tasks: msg.tasks ?? [] });
          }
          break;

        case "channel-reply-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { success: msg.success ?? true });
          }
          break;

        case "list-tools-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, {
              tools: msg.tools ?? [],
              ...(msg.warnings?.length ? { warnings: msg.warnings } : {}),
            });
          }
          break;

        case "call-tool-result":
          if (msg.error) {
            this.rejectPendingRequest(msg.requestId, msg.error);
          } else {
            this.resolvePendingRequest(msg.requestId, { result: msg.result });
          }
          break;

        case "call-tool-pending":
          // Action is awaiting human approval — extend the timeout so the
          // pending request doesn't time out while waiting.
          this.extendPendingRequestTimeout(msg.requestId, APPROVAL_TIMEOUT_MS);
          break;

        case "tunnel-delete":
          await this.tunnelDeleteHandler?.(msg.name, {
            id: msg.actorId,
            name: msg.actorName,
            email: msg.actorEmail,
          });
          break;
        case "workflow-execute":
          await this.workflowExecuteHandler?.(
            msg.executionId,
            msg.payload,
            typeof msg.model === "string" ? msg.model : undefined,
            Array.isArray(msg.modelPreferences)
              ? msg.modelPreferences.filter((entry): entry is string => typeof entry === "string" && !!entry.trim())
              : undefined,
          );
          break;
        default:
          console.warn(
            `[AgentClient] Unhandled DO message type: ${(msg as { type?: unknown }).type ?? "unknown"} keys=[${Object.keys(msg as Record<string, unknown>).join(",")}]`
          );
          break;
      }
    } catch (err) {
      console.error(`[AgentClient] Error handling ${msg.type} message:`, err);
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.closing) {
      return;
    }
    if (this.ws && (this.ws.readyState === WebSocket.OPEN || this.ws.readyState === WebSocket.CONNECTING)) {
      return;
    }

    const delay = Math.min(
      INITIAL_RECONNECT_DELAY_MS * 2 ** this.reconnectAttempts,
      MAX_RECONNECT_DELAY_MS,
    );
    this.reconnectAttempts++;
    console.log(`[AgentClient] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts})`);

    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch (err) {
        console.error("[AgentClient] Reconnect failed:", err);
        if (!this.closing) {
          this.scheduleReconnect();
        }
      }
    }, delay);
  }
}
