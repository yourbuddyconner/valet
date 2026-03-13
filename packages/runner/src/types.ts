// ─── Runner ↔ DO WebSocket Protocol ────────────────────────────────────────

/** Messages sent from DO to Runner */
export interface PromptAttachment {
  type: "file";
  mime: string;
  url: string;
  filename?: string;
}

export interface WorkflowRunResultStep {
  stepId: string;
  status: string;
  attempt?: number;
  startedAt?: string;
  completedAt?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
}

export interface WorkflowRunResultEnvelope {
  ok: boolean;
  status: "ok" | "needs_approval" | "cancelled" | "failed";
  executionId: string;
  output?: Record<string, unknown>;
  steps?: WorkflowRunResultStep[];
  requiresApproval?: null | {
    stepId: string;
    prompt: string;
    items: unknown[];
    resumeToken: string;
  };
  error?: string | null;
}

export type DOToRunnerMessage =
  | { type: "prompt"; messageId: string; content: string; model?: string;
      attachments?: PromptAttachment[];
      modelPreferences?: string[];
      channelType?: string; channelId?: string;
      threadId?: string;
      /** Original channel info before thread normalization (e.g., slack:D123:threadTs).
       *  Used by the Runner for the [via ...] attribution prefix so the agent knows
       *  which external channel to reply to even when channelType is 'thread'. */
      replyChannelType?: string; replyChannelId?: string;
      opencodeSessionId?: string;
      continuationContext?: string;
      authorId?: string; authorEmail?: string; authorName?: string;
      gitName?: string; gitEmail?: string }
  | { type: "answer"; questionId: string; answer: string | boolean }
  | { type: "stop" }
  | { type: "abort"; channelType?: string; channelId?: string }
  | { type: "revert"; messageId: string }
  | { type: "diff"; requestId: string }
  | { type: "review"; requestId: string }
  | { type: "pong" }
  | { type: "spawn-child-result"; requestId: string; childSessionId?: string; error?: string }
  | { type: "session-message-result"; requestId: string; success?: boolean; error?: string }
  | { type: "session-messages-result"; requestId: string; messages?: Array<{ role: string; content: string; createdAt: string }>; error?: string }
  | { type: "create-pr-result"; requestId: string; number?: number; url?: string; title?: string; state?: string; error?: string }
  | { type: "update-pr-result"; requestId: string; number?: number; url?: string; title?: string; state?: string; error?: string }
  | { type: "list-pull-requests-result"; requestId: string; pulls?: unknown[]; error?: string }
  | { type: "inspect-pull-request-result"; requestId: string; data?: unknown; error?: string }
  | { type: "terminate-child-result"; requestId: string; success?: boolean; error?: string }
  | { type: "mem-read-result"; requestId: string; file?: unknown; files?: unknown[]; error?: string }
  | { type: "mem-write-result"; requestId: string; file?: unknown; error?: string }
  | { type: "mem-patch-result"; requestId: string; result?: unknown; error?: string }
  | { type: "mem-rm-result"; requestId: string; deleted?: number; error?: string }
  | { type: "mem-search-result"; requestId: string; results?: unknown[]; error?: string }
  | { type: "list-repos-result"; requestId: string; repos?: unknown[]; error?: string }
  | { type: "list-personas-result"; requestId: string; personas?: unknown[]; error?: string }
  | { type: "list-channels-result"; requestId: string; channels?: unknown[]; error?: string }
  | { type: "get-session-status-result"; requestId: string; sessionStatus?: unknown; error?: string }
  | { type: "list-child-sessions-result"; requestId: string; children?: unknown[]; error?: string }
  | { type: "forward-messages-result"; requestId: string; count?: number; sourceSessionId?: string; error?: string }
  | { type: "read-repo-file-result"; requestId: string; content?: string; encoding?: string; truncated?: boolean; path?: string; repo?: string; ref?: string; error?: string }
  | { type: "workflow-list-result"; requestId: string; workflows?: unknown[]; error?: string }
  | { type: "workflow-sync-result"; requestId: string; success?: boolean; workflow?: unknown; error?: string }
  | { type: "workflow-run-result"; requestId: string; execution?: unknown; error?: string }
  | { type: "workflow-executions-result"; requestId: string; executions?: unknown[]; error?: string }
  | { type: "workflow-api-result"; requestId: string; data?: unknown; error?: string }
  | { type: "trigger-api-result"; requestId: string; data?: unknown; error?: string }
  | { type: "execution-api-result"; requestId: string; data?: unknown; error?: string }
  | { type: "mailbox-send-result"; requestId: string; messageId?: string; error?: string }
  | { type: "mailbox-check-result"; requestId: string; messages?: unknown[]; error?: string }
  | { type: "task-create-result"; requestId: string; task?: unknown; error?: string }
  | { type: "task-list-result"; requestId: string; tasks?: unknown[]; error?: string }
  | { type: "task-update-result"; requestId: string; task?: unknown; error?: string }
  | { type: "task-my-result"; requestId: string; tasks?: unknown[]; error?: string }
  | { type: "channel-reply-result"; requestId: string; success?: boolean; error?: string }
  | {
      type: "workflow-execute";
      executionId: string;
      model?: string;
      modelPreferences?: string[];
      payload: {
        kind: "run" | "resume";
        executionId: string;
        workflowHash?: string;
        resumeToken?: string;
        decision?: "approve" | "deny";
        payload: Record<string, unknown>;
      };
    }
  | { type: "list-tools-result"; requestId: string; tools?: unknown[]; error?: string; warnings?: Array<{ service: string; displayName: string; reason: string; message: string }> }
  | { type: "call-tool-result"; requestId: string; result?: unknown; error?: string }
  | { type: "skill-api-result"; requestId: string; data?: unknown; error?: string; statusCode?: number }
  | { type: "persona-api-result"; requestId: string; data?: unknown; error?: string; statusCode?: number }
  | { type: "call-tool-pending"; requestId: string; invocationId: string; message: string }
  | { type: "tunnel-delete"; name: string; actorId?: string; actorName?: string; actorEmail?: string }
  | { type: "opencode-command"; command: string; args?: string; requestId: string }
  | { type: "new-session"; channelType: string; channelId: string; requestId: string }
  | { type: "init" }
  | { type: "repo-config"; token: string; expiresAt?: string; gitConfig: Record<string, string>; repoUrl?: string; branch?: string; ref?: string }
  | { type: "repo-token-refreshed"; token: string; expiresAt?: string; requestId?: string }
  | {
      type: "opencode-config";
      config: {
        tools?: Record<string, boolean>;
        providerKeys?: Record<string, string>;
        instructions?: string[];
        isOrchestrator?: boolean;
      };
    }
  | {
      type: 'plugin-content';
      pluginContent: {
        personas: Array<{ filename: string; content: string; sortOrder: number }>;
        skills: Array<{ filename: string; content: string }>;
        tools: Array<{ filename: string; content: string }>;
        allowRepoContent: boolean;
        toolWhitelist?: {
          services: string[];
          excludedActions: Array<{ service: string; actionId: string }>;
        } | null;
      };
    };

/** Tool call status values */
export type ToolCallStatus = "pending" | "running" | "completed" | "error";

/** Agent status values */
export type AgentStatus = "idle" | "thinking" | "tool_calling" | "streaming" | "error";

/** Messages sent from Runner to DO */
export type RunnerToDOMessage =
  | {
      type: "workflow-chat-message";
      role: "user" | "assistant" | "system";
      content: string;
      parts?: Record<string, unknown>;
      channelType?: string;
      channelId?: string;
      opencodeSessionId?: string;
    }
  | { type: "question"; questionId: string; text: string; options?: string[] }
  | { type: "screenshot"; data: string; description: string }
  | { type: "error"; messageId: string; error: string }
  | { type: "complete" }
  | { type: "agentStatus"; status: AgentStatus; detail?: string }
  | { type: "create-pr"; requestId: string; branch: string; title: string; body?: string; base?: string }
  | { type: "update-pr"; requestId: string; prNumber: number; title?: string; body?: string; state?: string; labels?: string[] }
  | { type: "list-pull-requests"; requestId: string; owner?: string; repo?: string; state?: string; limit?: number }
  | { type: "inspect-pull-request"; requestId: string; prNumber: number; owner?: string; repo?: string; filesLimit?: number; commentsLimit?: number }
  | { type: "git-state"; branch?: string; baseBranch?: string; commitCount?: number }
  | { type: "models"; models: AvailableModels }
  | { type: "aborted" }
  | { type: "reverted"; messageIds: string[] }
  | { type: "diff"; requestId: string; data: { files: DiffFile[] } }
  | { type: "files-changed"; files: Array<{ path: string; status: string; additions?: number; deletions?: number }> }
  | { type: "spawn-child"; requestId: string; task: string; workspace: string; repoUrl?: string; branch?: string; ref?: string; title?: string; sourceType?: string; sourcePrNumber?: number; sourceIssueNumber?: number; sourceRepoFullName?: string; model?: string }
  | { type: "session-message"; requestId: string; targetSessionId: string; content: string; interrupt?: boolean }
  | { type: "session-messages"; requestId: string; targetSessionId: string; limit?: number; after?: string }
  | { type: "terminate-child"; requestId: string; childSessionId: string }
  | { type: "self-terminate" }
  | { type: "review-result"; requestId: string; data?: ReviewResultData; diffFiles?: DiffFile[]; error?: string }
  | { type: "ping" }
  | { type: "mem-read"; requestId: string; path?: string }
  | { type: "mem-write"; requestId: string; path: string; content: string }
  | { type: "mem-patch"; requestId: string; path: string; operations: unknown[] }
  | { type: "mem-rm"; requestId: string; path: string }
  | { type: "mem-search"; requestId: string; query: string; path?: string; limit?: number }
  | { type: "list-repos"; requestId: string; source?: string }
  | { type: "list-personas"; requestId: string }
  | { type: "list-channels"; requestId: string }
  | { type: "get-session-status"; requestId: string; targetSessionId: string }
  | { type: "list-child-sessions"; requestId: string }
  | { type: "forward-messages"; requestId: string; targetSessionId: string; limit?: number; after?: string }
  | { type: "read-repo-file"; requestId: string; owner?: string; repo?: string; repoUrl?: string; path: string; ref?: string }
  | { type: "workflow-list"; requestId: string }
  | { type: "workflow-sync"; requestId: string; id?: string; slug?: string; name: string; description?: string; version?: string; data: Record<string, unknown> }
  | {
      type: "workflow-run";
      requestId: string;
      workflowId: string;
      variables?: Record<string, unknown>;
      repoUrl?: string;
      branch?: string;
      ref?: string;
      sourceRepoFullName?: string;
    }
  | { type: "workflow-executions"; requestId: string; workflowId?: string; limit?: number }
  | { type: "workflow-api"; requestId: string; action: string; payload?: Record<string, unknown> }
  | { type: "trigger-api"; requestId: string; action: string; payload?: Record<string, unknown> }
  | { type: "execution-api"; requestId: string; action: string; payload?: Record<string, unknown> }
  | { type: "workflow-execution-result"; executionId: string; envelope: WorkflowRunResultEnvelope }
  | { type: "model-switched"; messageId: string; fromModel: string; toModel: string; reason: string }
  | { type: "tunnels"; tunnels: Array<{ name: string; port: number; protocol?: string; path: string; url?: string }> }
  | { type: "mailbox-send"; requestId: string; toSessionId?: string; toUserId?: string; toHandle?: string; messageType?: string; content: string; contextSessionId?: string; contextTaskId?: string; replyToId?: string }
  | { type: "mailbox-check"; requestId: string; limit?: number; after?: string }
  | { type: "task-create"; requestId: string; title: string; description?: string; sessionId?: string; parentTaskId?: string; blockedBy?: string[] }
  | { type: "task-list"; requestId: string; status?: string; limit?: number }
  | { type: "task-update"; requestId: string; taskId: string; status?: string; result?: string; description?: string; sessionId?: string; title?: string }
  | { type: "task-my"; requestId: string; status?: string }
  | { type: "channel-reply"; requestId: string; channelType: string; channelId: string; message: string; imageBase64?: string; imageMimeType?: string; followUp?: boolean }
  | { type: "list-tools"; requestId: string; service?: string; query?: string }
  | { type: "call-tool"; requestId: string; toolId: string; params: Record<string, unknown> }
  | { type: "skill-api"; requestId: string; action: string; payload?: Record<string, unknown> }
  | { type: "persona-api"; requestId: string; action: string; payload?: Record<string, unknown> }
  | { type: "audio-transcript"; messageId: string; transcript: string }
  | { type: "command-result"; requestId: string; command: string; result?: unknown; error?: string }
  | { type: "channel-session-created"; channelKey: string; opencodeSessionId: string }
  | { type: "session-reset"; channelType: string; channelId: string; requestId: string }
  | { type: "repo:refresh-token"; requestId?: string }
  | { type: "repo:clone-complete"; success: boolean; error?: string }
  | { type: "thread.created"; threadId: string; opencodeSessionId: string }
  | { type: "thread.updated"; threadId: string; title?: string; summaryAdditions?: number; summaryDeletions?: number; summaryFiles?: number }
  // ─── V2 parts-based message protocol ───
  | { type: "message.create"; turnId: string; channelType?: string; channelId?: string; opencodeSessionId?: string }
  | { type: "message.part.text-delta"; turnId: string; delta: string }
  | { type: "message.part.tool-update"; turnId: string; callId: string; toolName: string; status: ToolCallStatus; args?: unknown; result?: unknown; error?: string }
  | { type: "message.finalize"; turnId: string; reason: "end_turn" | "error" | "canceled"; finalText?: string; error?: string }
  | { type: "opencode-config-applied"; success: boolean; restarted: boolean; error?: string }
  | {
      type: "usage-report";
      turnId: string;
      entries: Array<{
        ocMessageId: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
      }>;
    };

/** Structured review result data */
export interface ReviewFinding {
  id: string;
  file: string;
  lineStart: number;
  lineEnd: number;
  severity: "critical" | "warning" | "suggestion" | "nitpick";
  category: string;
  title: string;
  description: string;
  suggestedFix?: string;
}

export interface ReviewFileSummary {
  path: string;
  summary: string;
  reviewOrder: number;
  findings: ReviewFinding[];
  linesAdded: number;
  linesDeleted: number;
}

export interface ReviewResultData {
  files: ReviewFileSummary[];
  overallSummary: string;
  stats: { critical: number; warning: number; suggestion: number; nitpick: number };
}

/** Model discovery types — re-exported from shared */
export type { ProviderModelEntry, ProviderModels, AvailableModels } from '@valet/shared';

/** Diff file entry returned by OpenCode diff API */
export interface DiffFile {
  path: string;
  status: "added" | "modified" | "deleted";
  diff?: string;
}

// ─── CLI Config ────────────────────────────────────────────────────────────

export interface RunnerConfig {
  opencodeUrl: string;
  doUrl: string;
  runnerToken: string;
  sessionId: string;
}
