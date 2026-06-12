import { useState, useCallback, useEffect, useRef } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from './use-websocket';
import { sessionKeys, type ProviderModels } from '@/api/sessions';
import { threadKeys } from '@/api/threads';
import { api } from '@/api/client';
import { toast } from './use-toast';
import type { Message, SessionStatus } from '@/api/types';
import type { MessagePart } from '@valet/shared';
import { useAuthStore } from '@/stores/auth';
import { SLASH_COMMANDS, type QueueMode } from '@valet/shared';
import {
  buildApprovalResolutionSocketMessage,
  getWebSocketErrorPromptId,
  getWebSocketErrorText,
  markInteractivePromptError,
  markInteractivePromptTerminal,
  pruneTerminalInteractivePrompt,
  upsertInteractivePrompt,
} from '@/lib/approval-prompts';
export interface InteractivePromptState {
  id: string;
  sessionId: string;
  type: string;
  title: string;
  body?: string;
  actions: Array<{ id: string; label: string; style?: 'primary' | 'danger'; description?: string }>;
  expiresAt?: number;
  context?: Record<string, unknown>;
  channelType?: string;
  channelId?: string;
  threadId?: string;
  status: 'pending' | 'resolved' | 'expired';
  error?: string;
}

export interface LogEntry {
  id: string;
  timestamp: number;
  type: string;
  summary: string;
}

const MAX_LOG_ENTRIES = 500;

type AgentStatus = 'idle' | 'thinking' | 'tool_calling' | 'streaming' | 'error' | 'queued';

export type { ProviderModels };

export interface DiffFile {
  path: string;
  status: 'added' | 'modified' | 'deleted';
  diff?: string;
}

export interface PromptAttachment {
  type: 'file';
  mime: string;
  url: string;
  filename?: string;
}

export interface ChildSessionEvent {
  childSessionId: string;
  title?: string;
  timestamp: number;
  threadId?: string;
}

export interface ConnectedUser {
  id: string;
  name?: string;
  email?: string;
  avatarUrl?: string;
}

export interface ReviewResultData {
  files: Array<{
    path: string;
    summary: string;
    reviewOrder: number;
    findings: Array<{
      id: string;
      file: string;
      lineStart: number;
      lineEnd: number;
      severity: 'critical' | 'warning' | 'suggestion' | 'nitpick';
      category: string;
      title: string;
      description: string;
      suggestedFix?: string;
    }>;
    linesAdded: number;
    linesDeleted: number;
  }>;
  overallSummary: string;
  stats: { critical: number; warning: number; suggestion: number; nitpick: number };
}

export interface IntegrationAuthError {
  service: string;
  displayName: string;
  reason: string;
  message?: string;
}

interface ChatState {
  messages: Message[];
  historyReady: boolean;
  status: SessionStatus;
  interactivePrompts: InteractivePromptState[];
  connectedUsers: ConnectedUser[];
  logEntries: LogEntry[];
  isAgentThinking: boolean;
  agentStatus: AgentStatus;
  agentStatusDetail?: string;
  availableModels: ProviderModels[];
  diffData: DiffFile[] | null;
  diffLoading: boolean;
  runnerConnected: boolean;
  sessionTitle?: string;
  childSessionEvents: ChildSessionEvent[];
  reviewResult: ReviewResultData | null;
  reviewError: string | null;
  reviewLoading: boolean;
  reviewDiffFiles: DiffFile[] | null;
  agentStatusChannelType?: string;
  agentStatusChannelId?: string;
  agentStatusThreadId?: string;
  // Per-thread agent status. With cross-thread concurrent dispatch
  // (TKAI-65) the single agentStatus field above only reflects the most
  // recent runner message — switching to a thread whose latest event is
  // not the freshest would lose its busy indicator. This map tracks the
  // current status for every thread that has emitted an agentStatus event
  // during this session.
  threadStatuses: Record<string, { status: AgentStatus; detail?: string }>;
  integrationAuthErrors: IntegrationAuthError[];
  /** Most-recent pending followup (session-wide). Kept for back-compat with
   *  components that haven't switched to threadPendingFollowups yet. */
  pendingFollowup: { messageId: string; content: string; attachments?: unknown; threadId?: string } | null;
  /** Per-thread pending followups. With cross-thread concurrent dispatch
   *  (TKAI-65) the queue can hold one pending followup per thread; the
   *  single pendingFollowup slot above collapsed them into one. */
  threadPendingFollowups: Record<string, { messageId: string; content: string; attachments?: unknown; threadId?: string }>;
}

interface WebSocketInitMessage {
  type: 'init';
  session: {
    id: string;
    status: SessionStatus;
    workspace: string;
    title?: string;
    messages?: Array<{
      id: string;
      role: 'user' | 'assistant' | 'system' | 'tool';
      content: string;
      parts?: MessagePart[];
      authorId?: string;
      authorEmail?: string;
      authorName?: string;
      authorAvatarUrl?: string;
      channelType?: string;
      channelId?: string;
      threadId?: string;
      createdAt: number;
    }>;
  };
  data?: {
    connectedUsers?: Array<{ id: string; name?: string; email?: string; avatarUrl?: string }> | string[];
    runnerBusy?: boolean;
    promptsQueued?: number;
    runnerConnected?: boolean;
    auditLog?: Array<{
      eventType: string;
      summary: string;
      actorId?: string;
      metadata?: Record<string, unknown>;
      createdAt: string;
    }>;
    [key: string]: unknown;
  };
}

interface WebSocketMessageMessage {
  type: 'message';
  data: {
    id: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    parts?: MessagePart[];
    authorId?: string;
    authorEmail?: string;
    authorName?: string;
    authorAvatarUrl?: string;
    channelType?: string;
    channelId?: string;
    threadId?: string;
    createdAt: number;
  };
}

interface WebSocketStatusMessage {
  type: 'status';
  status?: SessionStatus;
  data?: Record<string, unknown>;
}

interface WebSocketChunkMessage {
  type: 'chunk';
  content: string;
  messageId?: string;
  channelType?: string;
  channelId?: string;
}

interface WebSocketInteractivePromptMessage {
  type: 'interactive_prompt';
  channelType?: string;
  channelId?: string;
  threadId?: string;
  prompt: {
    id: string;
    sessionId: string;
    type: string;
    title: string;
    body?: string;
    actions: Array<{ id: string; label: string; style?: 'primary' | 'danger'; description?: string }>;
    expiresAt?: number;
    context?: Record<string, unknown>;
  };
}

interface WebSocketInteractivePromptResolvedMessage {
  type: 'interactive_prompt_resolved';
  promptId: string;
}

interface WebSocketInteractivePromptExpiredMessage {
  type: 'interactive_prompt_expired';
  promptId: string;
}

interface WebSocketAgentStatusMessage {
  type: 'agentStatus';
  status: 'idle' | 'thinking' | 'tool_calling' | 'streaming' | 'error';
  detail?: string;
  channelType?: string;
  channelId?: string;
  threadId?: string;
}

interface WebSocketMessageUpdatedMessage {
  type: 'message.updated';
  data: {
    id: string;
    role: 'user' | 'assistant' | 'system' | 'tool';
    content: string;
    parts?: MessagePart[];
    channelType?: string;
    channelId?: string;
    createdAt: number;
  };
}

interface WebSocketErrorMessage {
  type: 'error';
  messageId: string;
  error?: string;
  content?: string;
  message?: string;
  promptId?: string;
  data?: {
    message?: string;
    promptId?: string;
  };
  channelType?: string;
  channelId?: string;
}

interface WebSocketMessagesRemovedMessage {
  type: 'messages.removed';
  messageIds: string[];
}

interface WebSocketDiffMessage {
  type: 'diff';
  requestId: string;
  data: { files: DiffFile[] };
}

interface WebSocketGitStateMessage {
  type: 'git-state';
  data: {
    branch?: string;
    baseBranch?: string;
    commitCount?: number;
    prState?: string;
    prTitle?: string;
    prUrl?: string;
    prMergedAt?: string | null;
  };
}

interface WebSocketPrCreatedMessage {
  type: 'pr-created';
  data: {
    number: number;
    title: string;
    url: string;
    state: string;
  };
}

interface WebSocketFilesChangedMessage {
  type: 'files-changed';
  files: Array<{ path: string; status: string; additions?: number; deletions?: number }>;
}

interface WebSocketChildSessionMessage {
  type: 'child-session';
  childSessionId: string;
  title?: string;
  threadId?: string;
}

interface WebSocketReviewResultMessage {
  type: 'review-result';
  requestId: string;
  data?: ReviewResultData;
  diffFiles?: DiffFile[];
  error?: string;
}

interface WebSocketTitleMessage {
  type: 'title';
  title: string;
}

interface WebSocketAuditLogMessage {
  type: 'audit_log';
  entry: {
    eventType: string;
    summary: string;
    actorId?: string;
    metadata?: Record<string, unknown>;
    createdAt: string;
  };
}

interface WebSocketCommandResultMessage {
  type: 'command-result';
  requestId?: string;
  command?: string;
  result?: unknown;
  error?: string;
}

interface WebSocketModelSwitchedMessage {
  type: 'model-switched';
  messageId: string;
  fromModel: string;
  toModel: string;
  reason: string;
}

interface WebSocketToastMessage {
  type: 'toast';
  title: string;
  description?: string;
  variant?: 'default' | 'success' | 'error' | 'warning';
  duration?: number;
}


interface WebSocketIntegrationAuthRequiredMessage {
  type: 'integration-auth-required';
  services: Array<{ service: string; displayName: string; reason: string; message?: string }>;
}

interface WebSocketModelsMessage {
  type: 'models';
  models: ProviderModels[];
  defaultModel?: string | null;
}

type WebSocketChatMessage =
  | WebSocketInitMessage
  | WebSocketModelsMessage
  | WebSocketMessageMessage
  | WebSocketMessageUpdatedMessage
  | WebSocketStatusMessage
  | WebSocketChunkMessage
  | WebSocketInteractivePromptMessage
  | WebSocketInteractivePromptResolvedMessage
  | WebSocketInteractivePromptExpiredMessage
  | WebSocketAgentStatusMessage
  | WebSocketErrorMessage
  | WebSocketMessagesRemovedMessage
  | WebSocketDiffMessage
  | WebSocketGitStateMessage
  | WebSocketPrCreatedMessage
  | WebSocketFilesChangedMessage
  | WebSocketChildSessionMessage
  | WebSocketReviewResultMessage
  | WebSocketTitleMessage
  | WebSocketAuditLogMessage
  | WebSocketCommandResultMessage
  | WebSocketToastMessage
  | WebSocketModelSwitchedMessage
  | WebSocketIntegrationAuthRequiredMessage
  | { type: 'thread.created'; threadId: string; sessionId: string }
  | { type: 'thread.updated'; threadId: string; sessionId: string }
  | { type: 'pong' }
  | { type: 'user.joined'; userId: string }
  | { type: 'user.left'; userId: string }
  | { type: 'queue.state'; data?: { pending?: { messageId: string; content: string; attachments?: unknown; threadId?: string } | null } }
  | { type: 'queue.withdrawn'; data?: { content?: string } };


function createInitialState(): ChatState {
  return {
    messages: [],
    historyReady: false,
    status: 'initializing',
    interactivePrompts: [],
    connectedUsers: [],
    logEntries: [],
    isAgentThinking: false,
    agentStatus: 'idle',
    agentStatusDetail: undefined,
    availableModels: [],
    diffData: null,
    diffLoading: false,
    runnerConnected: false,
    sessionTitle: undefined,
    childSessionEvents: [],
    reviewResult: null,
    reviewError: null,
    reviewLoading: false,
    reviewDiffFiles: null,
    threadStatuses: {},
    integrationAuthErrors: [],
    pendingFollowup: null,
    threadPendingFollowups: {},
  };
}

function isTerminalSessionStatus(status: SessionStatus | undefined) {
  return status === 'terminated' || status === 'archived' || status === 'error';
}

export function useChat(sessionId: string) {
  const queryClient = useQueryClient();
  const userQueueMode = useAuthStore((s) => s.user?.uiQueueMode || 'followup');

  // Keep a ref to sessionId so WebSocket message handlers always read the current value
  // without needing sessionId in their dependency arrays (which would cause reconnects).
  const sessionIdRef = useRef(sessionId);
  sessionIdRef.current = sessionId;

  const [state, setState] = useState<ChatState>(() => createInitialState());

  const markPromptTerminal = useCallback((promptId: string, status: 'resolved' | 'expired') => {
    setState((prev) => ({
      ...prev,
      interactivePrompts: markInteractivePromptTerminal(prev.interactivePrompts, promptId, status),
    }));
    setTimeout(() => {
      setState((prev) => ({
        ...prev,
        interactivePrompts: pruneTerminalInteractivePrompt(prev.interactivePrompts, promptId),
      }));
    }, 5000);
  }, []);

  const [selectedModel, setSelectedModel] = useState<string>(() => {
    try {
      return localStorage.getItem(`valet:model:${sessionId}`) || '';
    } catch {
      return '';
    }
  });

  const handleModelChange = useCallback((model: string) => {
    setSelectedModel(model);
    try {
      if (model) {
        localStorage.setItem(`valet:model:${sessionId}`, model);
      } else {
        localStorage.removeItem(`valet:model:${sessionId}`);
      }
    } catch {
      // ignore
    }
  }, [sessionId]);

  // Reset state when sessionId changes (e.g. navigating between parent/child sessions).
  // Without this, stale messages from the previous session remain visible until the
  // new WebSocket init message arrives.
  const prevSessionIdRef = useRef(sessionId);

  // Per-thread sentinel of "we just called abort and haven't seen the runner's
  // confirmation yet." While set, agentStatus events arriving for that thread
  // are ignored — otherwise an in-flight 'tool_calling' event that left the
  // runner before our abort frame got there would briefly flip the Stop button
  // back on, causing UI flicker and double-clicks. The sentinel is cleared
  // either when the runner sends 'idle' for that thread or after a 5s timeout.
  const abortingThreadsRef = useRef<Map<string, number>>(new Map());
  // Per-thread AbortController for in-flight HTTP sends, so an abort()
  // immediately cancels the matching POST and the DO never sees the orphaned
  // prompt landing after the abort.
  const pendingHttpSendsRef = useRef<Map<string, AbortController>>(new Map());
  // Tracks which threads have already been requested via lazy load so we
  // don't double-fetch when the user navigates between threads. Declared
  // here adjacent to the other refs because the session-switch effect below
  // needs to clear it on every session swap.
  const loadedThreadsRef = useRef(new Set<string>());
  useEffect(() => {
    if (prevSessionIdRef.current === sessionId) return;
    prevSessionIdRef.current = sessionId;
    setState(createInitialState());
    // Drop per-thread sentinels and abort any in-flight HTTP sends from
    // the prior session — their threadIds aren't meaningful here and the
    // pending POSTs would write into the new session's state. Also clear
    // the loaded-threads cache so a colliding thread id between sessions
    // doesn't suppress lazy loading on the new session.
    abortingThreadsRef.current.clear();
    for (const ac of pendingHttpSendsRef.current.values()) {
      try { ac.abort(); } catch { /* ignore */ }
    }
    pendingHttpSendsRef.current.clear();
    loadedThreadsRef.current.clear();
    try {
      setSelectedModel(localStorage.getItem(`valet:model:${sessionId}`) || '');
    } catch {
      setSelectedModel('');
    }
  }, [sessionId]);

  // Unmount cleanup: cancel any pending HTTP sends and clear sentinels so
  // late .finally() callbacks don't apply state to an unmounted hook.
  useEffect(() => {
    return () => {
      for (const ac of pendingHttpSendsRef.current.values()) {
        try { ac.abort(); } catch { /* ignore */ }
      }
      pendingHttpSendsRef.current.clear();
      abortingThreadsRef.current.clear();
    };
  }, []);

  // Load messages from D1 REST API on mount / session change.
  // This ensures message history survives page refresh even if the WebSocket
  // init payload is too large (>1MB) or arrives with stale data.
  const d1LoadedRef = useRef(false);
  useEffect(() => {
    d1LoadedRef.current = false;
    if (!sessionId) return;
    let cancelled = false;
    api.get<{ messages: Array<{
      id: string;
      sessionId: string;
      role: 'user' | 'assistant' | 'system' | 'tool';
      content: string;
      parts?: MessagePart[];
      authorId?: string;
      authorEmail?: string;
      authorName?: string;
      authorAvatarUrl?: string;
      channelType?: string;
      channelId?: string;
      threadId?: string;
      createdAt: string;
    }> }>(`/sessions/${sessionId}/messages`).then((res) => {
      if (cancelled) return;
      d1LoadedRef.current = true;
      setState((prev) => {
        // Merge D1 messages with any already present (from WebSocket init that may have arrived first)
        const existing = new Map(prev.messages.map((m) => [m.id, m]));
        for (const m of res.messages ?? []) {
          if (!existing.has(m.id)) {
            existing.set(m.id, {
              id: m.id,
              sessionId: m.sessionId,
              role: m.role,
              content: m.content,
              parts: m.parts,
              authorId: m.authorId,
              authorEmail: m.authorEmail,
              authorName: m.authorName,
              authorAvatarUrl: m.authorAvatarUrl,
              channelType: m.channelType,
              channelId: m.channelId,
              threadId: m.threadId,
              createdAt: new Date(m.createdAt),
            });
          }
        }
        // Sort by createdAt to maintain order
        const merged = Array.from(existing.values()).sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
        );
        return { ...prev, messages: merged, historyReady: true };
      });
    }).catch((err) => {
      console.warn('[useChat] Failed to load messages from D1:', err);
    });
    return () => { cancelled = true; };
  }, [sessionId]);

  const wsUrl = sessionId ? `/api/sessions/${sessionId}/ws?role=client` : null;

  const logIdRef = useRef(0);

  const handleMessage = useCallback((msg: { type: string; [key: string]: unknown }) => {
    const message = msg as WebSocketChatMessage;

    switch (message.type) {
      case 'init': {
        const initModels = Array.isArray(message.data?.availableModels) ? message.data.availableModels as ProviderModels[] : [];

        // Normalize connectedUsers — may be string[] (legacy) or ConnectedUser[]
        const rawUsers = message.data?.connectedUsers;
        const normalizedUsers: ConnectedUser[] = Array.isArray(rawUsers)
          ? rawUsers.map((u: string | ConnectedUser) =>
              typeof u === 'string' ? { id: u } : u
            )
          : [];

        // Determine if agent is actively working or has queued work
        const hasQueuedWork = (message.data?.promptsQueued ?? 0) > 0;
        const isRunnerBusy = !!message.data?.runnerBusy;
        const agentWorking = hasQueuedWork || isRunnerBusy;
        const terminalSession = isTerminalSessionStatus(message.session.status);
        const initialAgentStatus: AgentStatus = terminalSession
          ? (message.session.status === 'error' ? 'error' : 'idle')
          : hasQueuedWork ? 'queued' : isRunnerBusy ? 'thinking' : 'idle';

        // Seed log entries from server-side audit log
        const rawAuditLog = message.data?.auditLog ?? [];
        const seededLogEntries: LogEntry[] = rawAuditLog.map((entry, idx) => ({
          id: `audit-${idx}`,
          timestamp: new Date(entry.createdAt).getTime(),
          type: entry.eventType,
          summary: entry.summary,
        }));
        logIdRef.current = seededLogEntries.length;

        // Merge init messages with any already loaded from D1 REST API.
        // WebSocket init has the most up-to-date parts (from DO SQLite),
        // D1 may have older messages that weren't in the init (if init was truncated).
        const initMessages = (message.session.messages ?? []).map((m) => ({
          id: m.id,
          sessionId: sessionIdRef.current,
          role: m.role,
          content: m.content,
          parts: m.parts,
          authorId: m.authorId,
          authorEmail: m.authorEmail,
          authorName: m.authorName,
          authorAvatarUrl: m.authorAvatarUrl,
          channelType: m.channelType,
          channelId: m.channelId,
          threadId: m.threadId,
          createdAt: new Date(m.createdAt * 1000),
        }));

        setState((prev) => {
          // Build merged map: start with D1-loaded messages, overlay init messages
          // (init is fresher — has latest parts from DO SQLite)
          const merged = new Map(prev.messages.map((m) => [m.id, m]));
          for (const m of initMessages) {
            merged.set(m.id, m); // init wins — has latest tool-update state
          }
          const sortedMessages = Array.from(merged.values()).sort(
            (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
          );

          // Reconstruct child session events from merged messages (covers both D1 and init).
          // V1 (legacy): tool calls were stored as separate role='tool' messages with
          //   parts = { toolName, args, result, ... }.
          // V2 (current): tool calls are stored as 'tool-call' parts of role='assistant'
          //   turn messages with parts being an array of { type, callId, toolName, args, result, ... }.
          // Handle both shapes so child cards persist across refresh in either format.
          const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
          const restoredChildEvents: ChildSessionEvent[] = [];
          const recordSpawn = (
            toolName: unknown,
            args: unknown,
            result: unknown,
            timestamp: number,
            threadId?: string,
          ) => {
            if (toolName !== 'spawn_session' || typeof result !== 'string') return;
            const match = result.match(/Child session spawned:\s*(\S+)/) || result.match(UUID_RE);
            const childId = match ? (match[1] || match[0]) : null;
            if (!childId) return;
            const argsObj = (args && typeof args === 'object' ? args : {}) as Record<string, unknown>;
            restoredChildEvents.push({
              childSessionId: childId,
              title: (argsObj.title as string) || (argsObj.workspace as string) || undefined,
              timestamp,
              threadId,
            });
          };
          for (const m of sortedMessages) {
            const ts = m.createdAt.getTime();
            // V1 legacy format
            if (m.role === 'tool' && m.parts && typeof m.parts === 'object' && !Array.isArray(m.parts)) {
              const p = m.parts as unknown as Record<string, unknown>;
              recordSpawn(p.toolName, p.args, p.result, ts, m.threadId);
              continue;
            }
            // V2 turn format — scan assistant turn parts for tool-call parts
            if (m.role === 'assistant' && Array.isArray(m.parts)) {
              for (const part of m.parts as unknown as Record<string, unknown>[]) {
                if (!part || typeof part !== 'object') continue;
                if (part.type === 'tool-call') {
                  recordSpawn(part.toolName, part.args, part.result, ts, m.threadId);
                }
              }
            }
          }

          return {
            ...prev,
            messages: sortedMessages,
            historyReady: true,
            status: message.session.status,
            interactivePrompts: [],
            connectedUsers: normalizedUsers,
            logEntries: seededLogEntries,
            isAgentThinking: terminalSession ? false : agentWorking,
            agentStatus: initialAgentStatus,
            agentStatusDetail: initialAgentStatus === 'queued' ? 'Message queued — waking session...' : undefined,
            availableModels: initModels,
            diffData: null,
            diffLoading: false,
            runnerConnected: !!message.data?.runnerConnected,
            sessionTitle: message.session.title,
            childSessionEvents: restoredChildEvents,
            reviewResult: null,
            reviewError: null,
            reviewLoading: false,
            reviewDiffFiles: null,
            integrationAuthErrors: [],
            // The legacy single-slot `pendingFollowup` is reserved for
            // non-thread (unscoped) sessions. A thread-scoped pendingPrompt
            // belongs in `threadPendingFollowups` only — putting it in the
            // legacy slot too would leak across thread-scoped queue.state
            // events that reserve the legacy slot (see queue.state handler).
            pendingFollowup: (() => {
              const pp = message.data?.pendingPrompt as ChatState['pendingFollowup'];
              return (pp && !pp.threadId) ? pp : null;
            })(),
            // Reset per-thread state on init/reconnect. Stale entries from a
            // previous connection would leak across (e.g. a thread that
            // completed during the disconnect would still show 'streaming').
            // Reset session-wide agentStatus cursors too — otherwise stale
            // `agentStatusThreadId` from the prior connection gates the
            // chat-container's activeThreadStatus fallback wrong.
            agentStatusThreadId: undefined,
            agentStatusChannelType: undefined,
            agentStatusChannelId: undefined,
            threadStatuses: {},
            // Seed threadPendingFollowups from the init payload's
            // pendingPrompt when it carries a threadId so a thread-scoped
            // pending followup survives reconnect. Without this, a queued
            // followup on thread X becomes invisible after reconnect and
            // the user can accidentally double-dispatch.
            threadPendingFollowups: (() => {
              const pp = message.data?.pendingPrompt as ChatState['pendingFollowup'];
              return (pp && pp.threadId) ? { [pp.threadId]: pp } : {};
            })(),
          };
        });
        if (initModels.length > 0) {
          // Use the DO-provided default model, validated against the catalog
          const allIds = initModels.flatMap((p: ProviderModels) => p.models.map((m: { id: string }) => m.id));
          const raw = typeof message.data?.defaultModel === 'string' ? message.data.defaultModel : null;
          const doDefaultModel = raw && allIds.includes(raw) ? raw : null;

          if ((message.session.messages?.length ?? 0) === 0 && initMessages.length === 0 && !d1LoadedRef.current) {
            // Fresh session — clear stale localStorage and apply DO default
            try {
              localStorage.removeItem(`valet:model:${sessionIdRef.current}`);
            } catch { /* ignore */ }
            if (doDefaultModel) {
              handleModelChange(doDefaultModel);
            }
          } else {
            // Existing session — prefer persisted choice, fall back to DO default
            try {
              const persisted = localStorage.getItem(`valet:model:${sessionIdRef.current}`) || '';
              if (persisted && allIds.includes(persisted)) {
                handleModelChange(persisted);
              } else if (doDefaultModel) {
                handleModelChange(doDefaultModel);
              }
            } catch {
              if (doDefaultModel) handleModelChange(doDefaultModel);
            }
          }
        }
        break;
      }

      case 'models': {
        const modelsMsg = message as WebSocketModelsMessage;
        const nextModels = Array.isArray(modelsMsg.models) ? modelsMsg.models : [];
        if (nextModels.length === 0) break;

        setState((prev) => ({
          ...prev,
          availableModels: nextModels,
        }));

        const allIds = nextModels.flatMap((p: ProviderModels) => p.models.map((m: { id: string }) => m.id));
        const rawDefault = typeof modelsMsg.defaultModel === 'string' ? modelsMsg.defaultModel : null;
        const defaultModel = rawDefault && allIds.includes(rawDefault) ? rawDefault : null;

        try {
          const persisted = localStorage.getItem(`valet:model:${sessionIdRef.current}`) || '';
          if (persisted && allIds.includes(persisted)) {
            handleModelChange(persisted);
          } else if (defaultModel) {
            handleModelChange(defaultModel);
          }
        } catch {
          if (defaultModel) handleModelChange(defaultModel);
        }
        break;
      }

      case 'message': {
        const d = message.data;
        const msg: Message = {
          id: d.id,
          sessionId: sessionIdRef.current,
          role: d.role,
          content: d.content,
          parts: d.parts,
          authorId: d.authorId,
          authorEmail: d.authorEmail,
          authorName: d.authorName,
          authorAvatarUrl: d.authorAvatarUrl,
          channelType: d.channelType,
          channelId: d.channelId,
          threadId: d.threadId,
          createdAt: new Date(d.createdAt * 1000),
        };
        setState((prev) => {
          if (prev.messages.some((existing) => existing.id === msg.id)) {
            return prev;
          }
          const newMessages = [...prev.messages];
          newMessages.push(msg);

          // Tool result messages signal "agent is mid-turn, processing the
          // result." Write that into the OWNING thread's slot rather than
          // clobbering the session-wide agentStatus.
          const msgThreadId = msg.threadId;
          let nextThreadStatuses = prev.threadStatuses;
          if (d.role === 'tool' && msgThreadId) {
            nextThreadStatuses = {
              ...prev.threadStatuses,
              [msgThreadId]: { status: 'thinking', detail: undefined },
            };
          }
          return {
            ...prev,
            messages: newMessages,
            threadStatuses: nextThreadStatuses,
            // Stop thinking when assistant responds; reset status after tool results
            isAgentThinking: d.role === 'assistant' ? false : prev.isAgentThinking,
            // Only mutate the session-wide agentStatus when no thread scope
            // is available — per-thread state is the source of truth.
            ...(d.role === 'tool' && !msgThreadId
              ? { agentStatus: 'thinking' as const, agentStatusDetail: undefined }
              : {}),
          };
        });
        break;
      }

      case 'message.updated': {
        const u = (message as WebSocketMessageUpdatedMessage).data;
        setState((prev) => ({
          ...prev,
          messages: prev.messages.map((m) => {
            if (m.id !== u.id) return m;
            // Content-wins rule: keep the longer content during streaming to prevent
            // tool-update broadcasts from clobbering chunk-accumulated text
            const newContent = (u.content?.length ?? 0) >= (m.content?.length ?? 0)
              ? u.content
              : m.content;
            return {
              ...m,
              content: newContent,
              parts: u.parts ?? m.parts,
              channelType: u.channelType ?? m.channelType,
              channelId: u.channelId ?? m.channelId,
            };
          }),
        }));
        break;
      }

      case 'status': {
        const data = message.data ?? {};
        const newStatus = message.status
          ?? (typeof data.status === 'string' ? data.status as SessionStatus : undefined);
        setState((prev) => {
          let nextUsers = prev.connectedUsers;

          // Update connected users list if provided
          if (Array.isArray(data.connectedUsers)) {
            nextUsers = (data.connectedUsers as Array<string | ConnectedUser>).map(
              (u: string | ConnectedUser) => typeof u === 'string' ? { id: u } : u
            );
          }

          // Track runner connection state
          const runnerConnected = typeof data.runnerConnected === 'boolean'
            ? data.runnerConnected
            : prev.runnerConnected;
          const effectiveStatus = newStatus ?? prev.status;
          const terminalSession = isTerminalSessionStatus(effectiveStatus);

          // Server flags promptQueued, promptDequeued, runnerBusy: false can
          // arrive in the same envelope (rare but legitimate). Process each
          // independently so a chained else-if doesn't drop one of the
          // updates. Terminal-session flips override everything else.
          let { isAgentThinking, agentStatus, agentStatusDetail, threadStatuses } = prev;
          const statusThreadId = typeof data.threadId === 'string' ? data.threadId : undefined;

          if (terminalSession) {
            isAgentThinking = false;
            agentStatus = effectiveStatus === 'error' ? 'error' : 'idle';
            agentStatusDetail = undefined;
          } else {
            if (data.promptQueued) {
              const queueDetail = data.queueReason === 'busy'
                ? 'Message queued — waiting for agent...'
                : 'Message queued — waking session...';
              if (statusThreadId) {
                threadStatuses = {
                  ...threadStatuses,
                  [statusThreadId]: { status: 'queued', detail: queueDetail },
                };
              } else {
                isAgentThinking = true;
                agentStatus = 'queued';
                agentStatusDetail = queueDetail;
              }
            }
            if (data.promptDequeued && statusThreadId) {
              // Drop the optimistic 'queued' entry — the runner's next
              // agentStatus will drive the real state.
              const next = { ...threadStatuses };
              delete next[statusThreadId];
              threadStatuses = next;
            }
            if (data.runnerBusy === false) {
              if (statusThreadId) {
                // Preserve 'error' status against this unconditional
                // runnerBusy=false → 'idle' write (mirrors the wouldClobberError
                // guard in the agentStatus reducer). The DO emits a 'status'
                // frame with runnerBusy=false after handlePromptComplete fires
                // following an error; without this guard the per-thread error
                // chip is wiped within ms of being set.
                const prevStatus = threadStatuses[statusThreadId]?.status;
                if (prevStatus !== 'error') {
                  threadStatuses = {
                    ...threadStatuses,
                    [statusThreadId]: { status: 'idle', detail: undefined },
                  };
                }
                // If THIS thread was the last actively-working thread, clear
                // session-wide indicators so the chrome doesn't stay stuck on
                // 'thinking' from a prior event. 'error' threads do NOT count
                // as active: the errored thread's own chrome already shows
                // the error (per-thread state), and treating error as active
                // would leave the session chrome stuck on 'thinking' forever
                // — no subsequent agentStatus arrives once a thread has
                // errored to its terminal state.
                const anyOtherActive = Object.entries(threadStatuses).some(
                  ([id, entry]) => id !== statusThreadId && entry?.status
                    && entry.status !== 'idle' && entry.status !== 'error'
                );
                if (!anyOtherActive) {
                  isAgentThinking = false;
                  if (agentStatus !== 'error') agentStatus = 'idle';
                  agentStatusDetail = undefined;
                }
              } else {
                // Unscoped completion (legacy / non-thread channels).
                isAgentThinking = false;
                agentStatus = 'idle';
                agentStatusDetail = undefined;
              }
            }
          }

          return {
            ...prev,
            status: effectiveStatus,
            connectedUsers: nextUsers,
            runnerConnected,
            isAgentThinking,
            agentStatus,
            agentStatusDetail,
            threadStatuses,
          };
        });
        break;
      }

      case 'chunk': {
        const chunkMsg = message as WebSocketChunkMessage;
        // Update the message's text part in-place. Gate on the OWNING
        // thread's status, not the session-wide one — otherwise thread A
        // going idle would silently drop thread B's still-streaming chunks.
        setState((prev) => {
          if (!chunkMsg.messageId) return prev;
          const idx = prev.messages.findIndex((m) => m.id === chunkMsg.messageId);
          if (idx === -1) return prev;
          const chunkThreadId = prev.messages[idx]?.threadId;
          // When the owning thread has a per-thread status entry, use it.
          // When the thread is known but has no entry yet (chunk arrived
          // before the first agentStatus for that thread), accept the
          // chunk: its arrival is itself evidence the thread is active.
          // Only fall back to session-wide agentStatus for messages with
          // NO threadId (legacy non-thread sessions).
          const ownerStatus = chunkThreadId
            ? prev.threadStatuses[chunkThreadId]?.status
            : prev.agentStatus;
          if (ownerStatus === 'idle') return prev;
          const msg = prev.messages[idx];
          const parts = Array.isArray(msg.parts) ? [...msg.parts] : [];
          const lastPart = parts[parts.length - 1];
          if (lastPart && lastPart.type === 'text') {
            parts[parts.length - 1] = { ...lastPart, text: (lastPart.text || '') + chunkMsg.content };
          } else {
            parts.push({ type: 'text', text: chunkMsg.content, streaming: true });
          }
          const updated = [...prev.messages];
          updated[idx] = { ...msg, content: (msg.content || '') + chunkMsg.content, parts };
          return { ...prev, messages: updated, isAgentThinking: false };
        });
        break;
      }

      case 'interactive_prompt': {
        const ipMsg = message as WebSocketInteractivePromptMessage;
        const prompt = ipMsg.prompt;
        setState((prev) => ({
          ...prev,
          interactivePrompts: upsertInteractivePrompt(prev.interactivePrompts, {
            id: prompt.id,
            sessionId: prompt.sessionId,
            type: prompt.type,
            title: prompt.title,
            body: prompt.body,
            actions: prompt.actions,
            expiresAt: prompt.expiresAt,
            context: prompt.context,
            channelType: ipMsg.channelType ?? (typeof prompt.context?.channelType === 'string' ? prompt.context.channelType : undefined),
            channelId: ipMsg.channelId ?? (typeof prompt.context?.channelId === 'string' ? prompt.context.channelId : undefined),
            threadId: ipMsg.threadId ?? (typeof prompt.context?.threadId === 'string' ? prompt.context.threadId : undefined),
            status: 'pending' as const,
          }),
        }));
        break;
      }

      case 'agentStatus': {
        const statusMsg = message as WebSocketAgentStatusMessage;
        // Suppress late agentStatus events for a thread we just aborted —
        // they were emitted by the runner BEFORE our abort frame arrived,
        // and applying them would flip the Stop button back on between the
        // optimistic clear and the runner's 'aborted' confirmation. The
        // sentinel is auto-cleared by an 'idle' status from the runner
        // (its abort confirmation) or by a 5s timeout in abort().
        if (statusMsg.threadId) {
          const expiresAt = abortingThreadsRef.current.get(statusMsg.threadId);
          if (expiresAt && Date.now() < expiresAt) {
            if (statusMsg.status === 'idle' || statusMsg.status === 'error') {
              // Runner confirmed the abort, or hit an error during teardown.
              // Both clear the sentinel and apply normally so per-thread state
              // settles on 'idle' or surfaces the teardown error to the user.
              abortingThreadsRef.current.delete(statusMsg.threadId);
            } else {
              return; // suppress thinking/etc. for the aborting thread
            }
          }
        }
        setState((prev) => {
          if (isTerminalSessionStatus(prev.status) && statusMsg.status !== 'error') {
            return prev;
          }
          // Record per-thread state so the UI can render a stop button for
          // each in-flight thread independently. Without this map, cross-
          // thread concurrent turns get clobbered by whichever thread last
          // emitted an agentStatus event.
          let nextThreadStatuses = prev.threadStatuses;
          if (statusMsg.threadId) {
            // Preserve an 'error' status against a trailing 'idle' that the
            // runner emits as part of its normal end-of-turn cleanup
            // (prompt.ts sends sendError then sendAgentStatus('idle')). If
            // the latest per-thread state is 'error', the trailing idle is
            // the finalizer for that error, not a fresh transition — keep
            // the error chip visible. A new prompt for the thread sends
            // 'queued'/'thinking', which clears the chip naturally.
            const prevStatus = prev.threadStatuses[statusMsg.threadId]?.status;
            const wouldClobberError = prevStatus === 'error' && statusMsg.status === 'idle';
            if (!wouldClobberError) {
              nextThreadStatuses = {
                ...prev.threadStatuses,
                [statusMsg.threadId]: { status: statusMsg.status, detail: statusMsg.detail },
              };
            }
          }
          return {
            ...prev,
            agentStatus: statusMsg.status,
            agentStatusDetail: statusMsg.detail,
            agentStatusChannelType: statusMsg.channelType,
            agentStatusChannelId: statusMsg.channelId,
            agentStatusThreadId: statusMsg.threadId,
            threadStatuses: nextThreadStatuses,
            // Also update isAgentThinking for backward compatibility
            isAgentThinking: statusMsg.status !== 'idle' && !isTerminalSessionStatus(prev.status),
          };
        });
        break;
      }

      case 'error': {
        const errorMsg = message as WebSocketErrorMessage;
        const errorText = getWebSocketErrorText(errorMsg);
        const promptId = getWebSocketErrorPromptId(errorMsg);
        const errThreadId = (errorMsg as { threadId?: string }).threadId;
        const errorMessage: Message = {
          id: errorMsg.messageId || crypto.randomUUID(),
          sessionId: sessionIdRef.current,
          role: 'system',
          content: `Error: ${errorText}`,
          channelType: errorMsg.channelType,
          channelId: errorMsg.channelId,
          threadId: errThreadId,
          createdAt: new Date(),
        };
        setState((prev) => {
          // When the error is thread-scoped, record it in threadStatuses
          // instead of clobbering the session-wide agentStatus — concurrent
          // sibling threads keep their own state.
          let nextThreadStatuses = prev.threadStatuses;
          if (errThreadId) {
            nextThreadStatuses = {
              ...prev.threadStatuses,
              [errThreadId]: { status: 'error', detail: errorText },
            };
          }
          return {
            ...prev,
            messages: [...prev.messages, errorMessage],
            interactivePrompts: promptId
              ? markInteractivePromptError(prev.interactivePrompts, promptId, errorText)
              : prev.interactivePrompts,
            threadStatuses: nextThreadStatuses,
            // Only flip the session-wide indicator when the error has no
            // thread scope (covers session-level failures like spawn errors).
            isAgentThinking: errThreadId ? prev.isAgentThinking : false,
            agentStatus: errThreadId ? prev.agentStatus : 'error',
            agentStatusDetail: errThreadId ? prev.agentStatusDetail : errorText,
          };
        });
        break;
      }

      case 'messages.removed': {
        const removedMsg = message as WebSocketMessagesRemovedMessage;
        const removedSet = new Set(removedMsg.messageIds);
        setState((prev) => ({
          ...prev,
          messages: prev.messages.filter((m) => !removedSet.has(m.id)),
        }));
        break;
      }

      case 'diff': {
        const diffMsg = message as WebSocketDiffMessage;
        setState((prev) => ({
          ...prev,
          diffData: diffMsg.data.files,
          diffLoading: false,
        }));
        break;
      }

      case 'git-state': {
        const gitMsg = message as WebSocketGitStateMessage;
        // Update the git-state query cache with real-time data
        queryClient.setQueryData(
          sessionKeys.gitState(sessionIdRef.current),
          (old: { gitState: Record<string, unknown> | null } | undefined) => {
            const prev = old?.gitState ?? {};
            return {
              gitState: {
                ...prev,
                ...(gitMsg.data.branch !== undefined ? { branch: gitMsg.data.branch } : {}),
                ...(gitMsg.data.baseBranch !== undefined ? { baseBranch: gitMsg.data.baseBranch } : {}),
                ...(gitMsg.data.commitCount !== undefined ? { commitCount: gitMsg.data.commitCount } : {}),
                ...(gitMsg.data.prState !== undefined ? { prState: gitMsg.data.prState } : {}),
                ...(gitMsg.data.prTitle !== undefined ? { prTitle: gitMsg.data.prTitle } : {}),
                ...(gitMsg.data.prUrl !== undefined ? { prUrl: gitMsg.data.prUrl } : {}),
                ...(gitMsg.data.prMergedAt !== undefined ? { prMergedAt: gitMsg.data.prMergedAt } : {}),
              },
            };
          }
        );
        break;
      }

      case 'pr-created': {
        const prMsg = message as WebSocketPrCreatedMessage;
        queryClient.setQueryData(
          sessionKeys.gitState(sessionIdRef.current),
          (old: { gitState: Record<string, unknown> | null } | undefined) => {
            const prev = old?.gitState ?? {};
            return {
              gitState: {
                ...prev,
                prNumber: prMsg.data.number,
                prTitle: prMsg.data.title,
                prUrl: prMsg.data.url,
                prState: prMsg.data.state,
              },
            };
          }
        );
        break;
      }

      case 'files-changed': {
        queryClient.invalidateQueries({ queryKey: sessionKeys.filesChanged(sessionIdRef.current) });
        break;
      }

      case 'thread.created':
      case 'thread.updated': {
        queryClient.invalidateQueries({ queryKey: threadKeys.list(sessionIdRef.current) });
        break;
      }

      case 'child-session': {
        const childMsg = message as WebSocketChildSessionMessage;
        setState((prev) => ({
          ...prev,
          childSessionEvents: [
            ...prev.childSessionEvents,
            {
              childSessionId: childMsg.childSessionId,
              title: childMsg.title,
              timestamp: Date.now(),
              threadId: childMsg.threadId,
            },
          ],
        }));
        queryClient.invalidateQueries({ queryKey: sessionKeys.children(sessionIdRef.current) });
        break;
      }

      case 'title': {
        const titleMsg = message as WebSocketTitleMessage;
        setState((prev) => ({
          ...prev,
          sessionTitle: titleMsg.title,
        }));
        // Update session detail query cache with new title
        queryClient.setQueryData(
          sessionKeys.detail(sessionIdRef.current),
          (old: { session: Record<string, unknown>; doStatus: Record<string, unknown> } | undefined) => {
            if (!old) return old;
            return { ...old, session: { ...old.session, title: titleMsg.title } };
          }
        );
        break;
      }

      case 'review-result': {
        const reviewMsg = message as WebSocketReviewResultMessage;
        setState((prev) => ({
          ...prev,
          reviewResult: reviewMsg.data ?? null,
          reviewError: reviewMsg.error ?? null,
          reviewLoading: false,
          reviewDiffFiles: reviewMsg.diffFiles ?? null,
        }));
        break;
      }

      case 'command-result': {
        const cmdMsg = message as WebSocketCommandResultMessage;
        const text = cmdMsg.error
          ? `Command error: ${cmdMsg.error}`
          : typeof cmdMsg.result === 'string'
            ? cmdMsg.result
            : JSON.stringify(cmdMsg.result, null, 2);
        const sysMsg: Message = {
          id: `cmd-${cmdMsg.requestId || crypto.randomUUID()}`,
          sessionId: sessionIdRef.current,
          role: 'system',
          content: text,
          createdAt: new Date(),
        };
        setState((prev) => ({
          ...prev,
          messages: [...prev.messages, sysMsg],
        }));
        break;
      }

      case 'audit_log': {
        const auditMsg = message as WebSocketAuditLogMessage;
        const entry: LogEntry = {
          id: String(++logIdRef.current),
          timestamp: new Date(auditMsg.entry.createdAt).getTime(),
          type: auditMsg.entry.eventType,
          summary: auditMsg.entry.summary,
        };
        setState((prev) => ({
          ...prev,
          logEntries: [...prev.logEntries.slice(-MAX_LOG_ENTRIES + 1), entry],
        }));
        break;
      }

      case 'pong':
        break;

      case 'toast': {
        const toastMsg = message as WebSocketToastMessage;
        toast({
          title: toastMsg.title,
          description: toastMsg.description,
          variant: toastMsg.variant,
          duration: toastMsg.duration,
        });
        break;
      }

      case 'model-switched': {
        const switchMsg = message as WebSocketModelSwitchedMessage;
        const switchText = `Model switched from ${switchMsg.fromModel} to ${switchMsg.toModel}: ${switchMsg.reason}`;
        const switchMessage: Message = {
          id: switchMsg.messageId,
          sessionId: sessionIdRef.current,
          role: 'system',
          content: switchText,
          createdAt: new Date(),
        };
        setState((prev) => {
          if (prev.messages.some((m) => m.id === switchMessage.id)) return prev;
          return {
            ...prev,
            messages: [...prev.messages, switchMessage],
          };
        });
        break;
      }

      case 'interactive_prompt_resolved': {
        const rMsg = message as WebSocketInteractivePromptResolvedMessage;
        markPromptTerminal(rMsg.promptId, 'resolved');
        break;
      }

      case 'interactive_prompt_expired': {
        const eMsg = message as WebSocketInteractivePromptExpiredMessage;
        markPromptTerminal(eMsg.promptId, 'expired');
        break;
      }

      case 'integration-auth-required': {
        const authMsg = message as WebSocketIntegrationAuthRequiredMessage;
        setState((prev) => {
          const existingServices = new Set(prev.integrationAuthErrors.map((e) => e.service));
          const newErrors = authMsg.services.filter((s) => !existingServices.has(s.service));
          if (newErrors.length === 0) return prev;
          return {
            ...prev,
            integrationAuthErrors: [...prev.integrationAuthErrors, ...newErrors],
          };
        });
        break;
      }

      case 'queue.state': {
        const data = (message as any).data as { pending: { messageId: string; content: string; attachments?: unknown; threadId?: string } | null; threadId?: string | null };
        const pending = data?.pending ?? null;
        // Top-level threadId scopes the update. Treat empty string as
        // "no scope" — an empty string passing through `??` would otherwise
        // fall into the unscoped branch and wipe every thread's followup.
        const rawThreadId = data?.threadId ?? pending?.threadId ?? null;
        const scopeThreadId = (typeof rawThreadId === 'string' && rawThreadId.length > 0) ? rawThreadId : null;
        const isThreadScoped = !!(pending?.threadId || scopeThreadId);
        setState((prev) => {
          const nextThreadFollowups = { ...prev.threadPendingFollowups };
          if (pending) {
            if (pending.threadId) {
              nextThreadFollowups[pending.threadId] = pending;
            }
          } else if (scopeThreadId) {
            delete nextThreadFollowups[scopeThreadId];
          }
          // Update the legacy `pendingFollowup` slot ONLY for unscoped
          // events (non-thread sessions). Cross-thread leakage into the
          // legacy slot was confusing consumers that read it directly:
          // thread A's pending followed by thread B's would clobber A in
          // the legacy slot, even though A's threadPendingFollowups entry
          // was still intact. Thread-scoped state belongs in the map.
          const nextLegacy = isThreadScoped ? prev.pendingFollowup : pending;
          return {
            ...prev,
            pendingFollowup: nextLegacy,
            threadPendingFollowups: nextThreadFollowups,
          };
        });
        break;
      }

      case 'queue.withdrawn': {
        const data = (message as any).data as { messageId?: string; content?: string; threadId?: string };
        const rawWithdrawnThreadId = data?.threadId;
        const withdrawnThreadId = (typeof rawWithdrawnThreadId === 'string' && rawWithdrawnThreadId.length > 0) ? rawWithdrawnThreadId : null;
        setState((prev) => {
          const nextThreadFollowups = { ...prev.threadPendingFollowups };
          if (withdrawnThreadId) {
            delete nextThreadFollowups[withdrawnThreadId];
          }
          // Unscoped withdrawn no longer mass-clears (matches queue.state).
          // The legacy `pendingFollowup` only clears when this withdrawal
          // targets the same thread or is unscoped.
          const clearLegacy = !withdrawnThreadId || prev.pendingFollowup?.threadId === withdrawnThreadId;
          return {
            ...prev,
            pendingFollowup: clearLegacy ? null : prev.pendingFollowup,
            threadPendingFollowups: nextThreadFollowups,
          };
        });
        break;
      }

      case 'user.joined':
      case 'user.left': {
        const userMsg = msg as { connectedUsers?: Array<string | ConnectedUser> };

        if (Array.isArray(userMsg.connectedUsers)) {
          setState((prev) => ({
            ...prev,
            connectedUsers: userMsg.connectedUsers!.map((u: string | ConnectedUser) =>
              typeof u === 'string' ? { id: u } : u
            ),
          }));
        }
        break;
      }
    }
  }, []);

  const { status: wsStatus, send, isConnected } = useWebSocket(wsUrl, {
    onMessage: handleMessage,
  });

  const sendMessage = useCallback(
    (content: string, model?: string, attachments?: PromptAttachment[], channelType?: string, channelId?: string, queueModeOverride?: QueueMode, threadId?: string, continuationContext?: string) => {
      if (!isConnected) return;
      // Sending a new prompt on a thread implicitly cancels any in-progress
      // "aborting" sentinel for that thread — otherwise the new prompt's
      // first agentStatus events would be suppressed up to the 30s fallback.
      if (threadId) abortingThreadsRef.current.delete(threadId);

      const payload = {
        content,
        ...(model ? { model } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        queueMode: queueModeOverride || userQueueMode,
        ...(channelType ? { channelType } : {}),
        ...(channelId ? { channelId } : {}),
        ...(threadId ? { threadId } : {}),
        ...(continuationContext ? { continuationContext } : {}),
      };

      // Use HTTP for large payloads (e.g. PDF attachments) since CF Workers
      // has a 1MB WebSocket frame limit. HTTP supports up to 100MB.
      const payloadSize = attachments?.reduce((sum, a) => sum + (a.url?.length ?? 0), 0) ?? 0;
      if (payloadSize > 800_000) {
        console.log(`[chat] Using HTTP for large payload (${(payloadSize / 1_000_000).toFixed(1)}MB)`);
        // Track an AbortController so a subsequent abort() can cancel the
        // in-flight POST before it reaches the DO — without this the
        // user's /stop is racy against the HTTP prompt request.
        const ac = new AbortController();
        if (threadId) pendingHttpSendsRef.current.set(threadId, ac);
        api.post(`/sessions/${sessionIdRef.current}/prompt`, payload, { signal: ac.signal })
          .catch((err) => {
            if (err?.name === 'AbortError') return; // canceled by abort()
            console.error('[chat] HTTP prompt failed:', err);
          })
          .finally(() => {
            if (threadId && pendingHttpSendsRef.current.get(threadId) === ac) {
              pendingHttpSendsRef.current.delete(threadId);
            }
          });
      } else {
        send({ type: 'prompt', ...payload });
      }

      // Start thinking indicator when user sends a message. Mirror it into
      // the targeted thread's slot so per-thread UI flips immediately
      // (without waiting for the runner's first agentStatus event). Write
      // 'queued' when the thread is idle / unknown / errored — don't
      // downgrade an actively-running 'thinking'/'streaming' indicator.
      setState((prev) => {
        let nextThreadStatuses = prev.threadStatuses;
        if (threadId) {
          const existing = prev.threadStatuses[threadId]?.status;
          const downgrade = existing === 'thinking' || existing === 'tool_calling' || existing === 'streaming';
          if (!downgrade) {
            nextThreadStatuses = {
              ...prev.threadStatuses,
              [threadId]: { status: 'queued', detail: undefined },
            };
          }
        }
        return { ...prev, isAgentThinking: true, threadStatuses: nextThreadStatuses };
      });
    },
    [isConnected, send, userQueueMode]
  );

  const abort = useCallback((channelType?: string, channelId?: string) => {
    if (!isConnected) return;
    // Require a non-empty channelId to treat the abort as thread-scoped.
    // Without this guard, an empty-string channelId from a URL search param
    // would fall into the session-wide branch and wipe every thread's busy
    // indicator session-wide.
    const isThreadScopedInput = channelType === 'thread' && typeof channelId === 'string' && channelId.length > 0;

    // Cancel any in-flight HTTP send for this thread first so the DO
    // doesn't see an orphan prompt arrive after the abort frame.
    if (isThreadScopedInput) {
      const inflight = pendingHttpSendsRef.current.get(channelId!);
      if (inflight) {
        inflight.abort();
        pendingHttpSendsRef.current.delete(channelId!);
      }
      // Sentinel: ignore late agentStatus events for this thread until
      // the runner's confirming 'idle' arrives. The fallback timeout
      // protects against the runner crashing mid-abort; 30s covers slow
      // tool teardown (shell exec, network I/O, sandbox restore). The
      // sentinel is also cleared if the user kicks off a new prompt on
      // this thread before then — see sendMessage.
      const FALLBACK_MS = 30_000;
      const expiresAt = Date.now() + FALLBACK_MS;
      abortingThreadsRef.current.set(channelId!, expiresAt);
      setTimeout(() => {
        const stamp = abortingThreadsRef.current.get(channelId!);
        if (stamp === expiresAt) abortingThreadsRef.current.delete(channelId!);
      }, FALLBACK_MS);
    }

    send({
      type: 'abort',
      ...(isThreadScopedInput ? { channelType, channelId } : {}),
    });
    setState((prev) => {
      const isThreadScoped = isThreadScopedInput;
      const nextThreadStatuses = isThreadScoped
        ? { ...prev.threadStatuses, [channelId!]: { status: 'idle' as AgentStatus, detail: undefined } }
        : prev.threadStatuses;
      // Only clear the session-wide indicator when the abort wasn't thread
      // scoped — otherwise the runner's per-channel `agentStatus: idle`
      // (or the next status from a still-running thread) will drive it.
      if (isThreadScoped) {
        return { ...prev, threadStatuses: nextThreadStatuses };
      }
      return {
        ...prev,
        isAgentThinking: false,
        agentStatus: 'idle' as const,
        agentStatusDetail: undefined,
        threadStatuses: nextThreadStatuses,
      };
    });
  }, [isConnected, send]);

  const revertMessage = useCallback(
    (messageId: string) => {
      if (!isConnected) return;
      send({ type: 'revert', messageId });
    },
    [isConnected, send]
  );

  const requestDiff = useCallback(() => {
    if (!isConnected) return;
    setState((prev) => ({ ...prev, diffLoading: true, diffData: null }));
    send({ type: 'diff' });
  }, [isConnected, send]);

  const requestReview = useCallback(() => {
    if (!isConnected) return;
    setState((prev) => ({
      ...prev,
      reviewLoading: true,
      reviewResult: null,
      reviewError: null,
      reviewDiffFiles: null,
    }));
    send({ type: 'review' });
  }, [isConnected, send]);

  const answerQuestion = useCallback(
    (promptId: string, answer: string | boolean) => {
      if (!isConnected) return;

      send({ type: 'answer', questionId: promptId, answer });

      // Mark as resolved (matches approval behavior — removed after 5s delay)
      markPromptTerminal(promptId, 'resolved');
    },
    [isConnected, markPromptTerminal, send]
  );

  const dismissQuestion = useCallback(
    (promptId: string) => {
      if (!isConnected) return;

      // Send a real text answer so OpenCode continues its turn (empty answers cause errors)
      send({ type: 'answer', questionId: promptId, answer: 'Skipped — no answer provided. Proceed without this information or make a reasonable default choice.' });

      markPromptTerminal(promptId, 'expired');
    },
    [isConnected, markPromptTerminal, send]
  );

  // Sync WebSocket session status changes back to React Query cache
  // so that session detail/list views stay fresh without waiting for polling
  const prevStatusRef = useRef<SessionStatus | null>(null);
  useEffect(() => {
    if (state.status && state.status !== prevStatusRef.current) {
      prevStatusRef.current = state.status;
      // Update session detail cache with the new status
      queryClient.setQueryData(
        sessionKeys.detail(sessionId),
        (old: { session: Record<string, unknown>; doStatus: Record<string, unknown> } | undefined) => {
          if (!old) return old;
          return { ...old, session: { ...old.session, status: state.status } };
        }
      );
      // Invalidate session lists so they refetch with the latest status
      queryClient.invalidateQueries({ queryKey: sessionKeys.infinite() });
    }
  }, [state.status, sessionId, queryClient]);

  // ─── Slash Command Execution ──────────────────────────────────────────

  const addLocalSystemMessage = useCallback((content: string, threadId?: string) => {
    const msg: Message = {
      id: `local-${crypto.randomUUID()}`,
      sessionId: sessionIdRef.current,
      role: 'system',
      content,
      createdAt: new Date(),
      ...(threadId ? { threadId } : {}),
    };
    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, msg],
    }));
  }, []);

  const executeCommand = useCallback(
    async (command: string, _args?: string, channelType?: string, channelId?: string, threadId?: string) => {
      const def = SLASH_COMMANDS.find((c) => c.name === command);
      if (!def) return;

      switch (def.handler) {
        case 'local': {
          if (command === 'help') {
            const uiCommands = SLASH_COMMANDS.filter((c) => c.availableIn.includes('ui'));
            const lines = uiCommands.map((c) =>
              `**/${c.name}**${c.args ? ` ${c.args}` : ''} — ${c.description}`
            );
            addLocalSystemMessage(`Available commands:\n${lines.join('\n')}`);
          }
          // /model is handled by ChatInput's sub-overlay, not here
          break;
        }
        case 'websocket': {
          if (!isConnected) return;
          switch (command) {
            case 'diff':
              // Use existing requestDiff which sets loading state
              requestDiff();
              break;
            case 'review':
              requestReview();
              break;
            case 'stop':
              // Scope the abort to the active thread so /stop on one thread
              // doesn't kill concurrent turns on sibling threads.
              if (threadId) {
                abort('thread', threadId);
              } else {
                abort();
              }
              break;
            case 'new-session':
              send({
                type: 'command',
                command: 'new-session',
                channelType: channelType || 'web',
                channelId: channelId || 'default',
              });
              break;
          }
          break;
        }
        case 'api': {
          try {
            switch (command) {
              case 'clear': {
                await api.post(`/sessions/${sessionIdRef.current}/clear-queue`);
                addLocalSystemMessage('Prompt queue cleared.');
                break;
              }
              case 'status': {
                const [detail, children] = await Promise.all([
                  api.get<{ session: Record<string, unknown>; doStatus: Record<string, unknown> }>(`/sessions/${sessionIdRef.current}`),
                  api.get<{ children: Array<{ id: string; title?: string; status: string; workspace: string }> }>(`/sessions/${sessionIdRef.current}/children`).catch(() => ({ children: [] })),
                ]);
                const s = detail.session;
                const childList = children.children;
                let text = `**Session Status**\nID: \`${s.id}\`\nStatus: **${s.status}**\nWorkspace: ${s.workspace || 'n/a'}`;
                if (childList.length > 0) {
                  text += `\n\n**Child Sessions (${childList.length}):**`;
                  for (const child of childList) {
                    text += `\n- ${child.title || child.workspace || child.id.slice(0, 8)} — **${child.status}**`;
                  }
                }
                addLocalSystemMessage(text);
                break;
              }
              case 'refresh': {
                await api.post(`/sessions/${sessionIdRef.current}/stop`);
                await api.post(`/sessions/${sessionIdRef.current}/start`);
                addLocalSystemMessage('Orchestrator session refreshed.');
                break;
              }
              case 'sessions': {
                const data = await api.get<{ children: Array<{ id: string; title?: string; status: string; workspace: string }> }>(`/sessions/${sessionIdRef.current}/children`);
                const list = data.children;
                if (list.length === 0) {
                  addLocalSystemMessage('No child sessions.');
                } else {
                  const lines = list.map((c) =>
                    `- ${c.title || c.workspace || c.id.slice(0, 8)} — **${c.status}**`
                  );
                  addLocalSystemMessage(`**Child Sessions (${list.length}):**\n${lines.join('\n')}`);
                }
                break;
              }
            }
          } catch (err) {
            addLocalSystemMessage(`Command /${command} failed: ${err instanceof Error ? err.message : String(err)}`);
          }
          break;
        }
        case 'opencode': {
          if (!isConnected) return;
          send({ type: 'command', command });
          break;
        }
      }
    },
    [isConnected, send, addLocalSystemMessage, requestDiff, requestReview, abort]
  );

  // Ping to keep connection alive
  useEffect(() => {
    if (!isConnected) return;

    const interval = setInterval(() => {
      send({ type: 'ping' });
    }, 30000);

    return () => clearInterval(interval);
  }, [isConnected, send]);

  const dismissIntegrationAuth = useCallback((service: string) => {
    setState((prev) => ({
      ...prev,
      integrationAuthErrors: prev.integrationAuthErrors.filter((e) => e.service !== service),
    }));
  }, []);

  const queueWithdraw = useCallback(() => {
    if (!isConnected) return;
    send({ type: 'queue.withdraw' } as any);
  }, [isConnected, send]);

  const queuePromote = useCallback(() => {
    if (!isConnected) return;
    send({ type: 'queue.promote' } as any);
  }, [isConnected, send]);

  const queueReplace = useCallback((content: string, model?: string, attachments?: PromptAttachment[], threadId?: string) => {
    if (!isConnected) return;
    send({ type: 'queue.replace', content, ...(model ? { model } : {}), ...(attachments?.length ? { attachments } : {}), ...(threadId ? { threadId } : {}) } as any);
  }, [isConnected, send]);

  // Load messages for a specific thread (fetches from D1 fallback if DO has none).
  // Used when switching to a past thread whose messages were purged from the DO
  // after an orchestrator restart. (loadedThreadsRef is declared with the other
  // refs near the top of the hook so the session-switch effect can clear it.)
  const loadThreadMessages = useCallback((threadId: string) => {
    if (!threadId || loadedThreadsRef.current.has(threadId)) return;
    // Check if we already have messages for this thread
    const hasMessages = state.messages.some((m) => m.threadId === threadId);
    if (hasMessages) {
      loadedThreadsRef.current.add(threadId);
      return;
    }
    loadedThreadsRef.current.add(threadId);
    api.get<{ messages: Array<{
      id: string;
      sessionId: string;
      role: 'user' | 'assistant' | 'system' | 'tool';
      content: string;
      parts?: MessagePart[];
      authorId?: string;
      authorEmail?: string;
      authorName?: string;
      authorAvatarUrl?: string;
      channelType?: string;
      channelId?: string;
      threadId?: string;
      createdAt: string;
    }> }>(`/sessions/${sessionIdRef.current}/messages?threadId=${encodeURIComponent(threadId)}`).then((res) => {
      if (!res.messages?.length) return;
      setState((prev) => {
        const existing = new Map(prev.messages.map((m) => [m.id, m]));
        for (const m of res.messages) {
          if (!existing.has(m.id)) {
            existing.set(m.id, {
              id: m.id,
              sessionId: m.sessionId,
              role: m.role,
              content: m.content,
              parts: m.parts,
              authorId: m.authorId,
              authorEmail: m.authorEmail,
              authorName: m.authorName,
              authorAvatarUrl: m.authorAvatarUrl,
              channelType: m.channelType,
              channelId: m.channelId,
              threadId: m.threadId,
              createdAt: new Date(m.createdAt),
            });
          }
        }
        const merged = Array.from(existing.values()).sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
        );
        return { ...prev, messages: merged };
      });
    }).catch((err) => {
      console.warn('[useChat] Failed to load thread messages:', err);
    });
  }, [state.messages]);

  return {
    messages: state.messages,
    historyReady: state.historyReady,
    sessionStatus: state.status,
    interactivePrompts: state.interactivePrompts,
    connectedUsers: state.connectedUsers,
    logEntries: state.logEntries,
    isAgentThinking: state.isAgentThinking,
    agentStatus: state.agentStatus,
    agentStatusDetail: state.agentStatusDetail,
    agentStatusChannelType: state.agentStatusChannelType,
    agentStatusChannelId: state.agentStatusChannelId,
    agentStatusThreadId: state.agentStatusThreadId,
    threadStatuses: state.threadStatuses,
    availableModels: state.availableModels,
    selectedModel,
    setSelectedModel: handleModelChange,
    connectionStatus: wsStatus,
    isConnected,
    sendMessage,
    answerQuestion,
    dismissQuestion,
    abort,
    revertMessage,
    requestDiff,
    diffData: state.diffData,
    diffLoading: state.diffLoading,
    runnerConnected: state.runnerConnected,
    sessionTitle: state.sessionTitle,
    childSessionEvents: state.childSessionEvents,
    requestReview,
    reviewResult: state.reviewResult,
    reviewError: state.reviewError,
    reviewLoading: state.reviewLoading,
    reviewDiffFiles: state.reviewDiffFiles,
    executeCommand,
    integrationAuthErrors: state.integrationAuthErrors,
    dismissIntegrationAuth,
    resolveApprovalLocally: useCallback((promptId: string) => {
      markPromptTerminal(promptId, 'resolved');
    }, [markPromptTerminal]),
    expireApprovalLocally: useCallback((promptId: string) => {
      markPromptTerminal(promptId, 'expired');
    }, [markPromptTerminal]),
    resolveApprovalWs: useCallback((invocationId: string, actionId: string) => {
      if (!isConnected) return false;
      return send(buildApprovalResolutionSocketMessage(invocationId, actionId) as any);
    }, [isConnected, send]),
    approveActionWs: useCallback((invocationId: string, actionId = 'approve') => {
      if (!isConnected) return false;
      return send({ type: 'approve-action', invocationId, actionId } as any);
    }, [isConnected, send]),
    denyActionWs: useCallback((invocationId: string, actionId = 'deny') => {
      if (!isConnected) return false;
      return send({ type: 'deny-action', invocationId, actionId } as any);
    }, [isConnected, send]),
    loadThreadMessages,
    pendingFollowup: state.pendingFollowup,
    threadPendingFollowups: state.threadPendingFollowups,
    queueWithdraw,
    queuePromote,
    queueReplace,
  };
}
