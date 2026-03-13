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
export interface InteractivePromptState {
  id: string;
  sessionId: string;
  type: string;
  title: string;
  body?: string;
  actions: Array<{ id: string; label: string; style?: 'primary' | 'danger' }>;
  expiresAt?: number;
  context?: Record<string, unknown>;
  status: 'pending' | 'resolved' | 'expired';
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
}

interface ChatState {
  messages: Message[];
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
  integrationAuthErrors: IntegrationAuthError[];
}

interface WebSocketInitMessage {
  type: 'init';
  session: {
    id: string;
    status: SessionStatus;
    workspace: string;
    title?: string;
    messages: Array<{
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
  prompt: {
    id: string;
    sessionId: string;
    type: string;
    title: string;
    body?: string;
    actions: Array<{ id: string; label: string; style?: 'primary' | 'danger' }>;
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
  services: Array<{ service: string; displayName: string; reason: string }>;
}

type WebSocketChatMessage =
  | WebSocketInitMessage
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
  | { type: 'user.left'; userId: string };


function createInitialState(): ChatState {
  return {
    messages: [],
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
    integrationAuthErrors: [],
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
  useEffect(() => {
    if (prevSessionIdRef.current === sessionId) return;
    prevSessionIdRef.current = sessionId;
    setState(createInitialState());
    try {
      setSelectedModel(localStorage.getItem(`valet:model:${sessionId}`) || '');
    } catch {
      setSelectedModel('');
    }
  }, [sessionId]);

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
      if (cancelled || !res.messages?.length) return;
      d1LoadedRef.current = true;
      setState((prev) => {
        // Merge D1 messages with any already present (from WebSocket init that may have arrived first)
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
        // Sort by createdAt to maintain order
        const merged = Array.from(existing.values()).sort(
          (a, b) => a.createdAt.getTime() - b.createdAt.getTime()
        );
        return { ...prev, messages: merged };
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
        const initMessages = message.session.messages.map((m) => ({
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

          // Reconstruct child session events from merged messages (covers both D1 and init)
          const UUID_RE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
          const restoredChildEvents: ChildSessionEvent[] = [];
          for (const m of sortedMessages) {
            if (m.role === 'tool' && m.parts && typeof m.parts === 'object') {
              const p = m.parts as unknown as Record<string, unknown>;
              if (typeof p.toolName === 'string' && p.toolName === 'spawn_session' && typeof p.result === 'string') {
                const match = p.result.match(/Child session spawned:\s*(\S+)/) || p.result.match(UUID_RE);
                const childId = match ? (match[1] || match[0]) : null;
                if (childId) {
                  const args = (p.args ?? {}) as Record<string, unknown>;
                  restoredChildEvents.push({
                    childSessionId: childId,
                    title: (args.title as string) || (args.workspace as string) || undefined,
                    timestamp: m.createdAt.getTime(),
                  });
                }
              }
            }
          }

          return {
            ...prev,
            messages: sortedMessages,
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
          };
        });
        if (initModels.length > 0) {
          // Use the DO-provided default model, validated against the catalog
          const allIds = initModels.flatMap((p: ProviderModels) => p.models.map((m: { id: string }) => m.id));
          const raw = typeof message.data?.defaultModel === 'string' ? message.data.defaultModel : null;
          const doDefaultModel = raw && allIds.includes(raw) ? raw : null;

          if (message.session.messages.length === 0 && initMessages.length === 0 && !d1LoadedRef.current) {
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

          return {
            ...prev,
            messages: newMessages,
            // Stop thinking when assistant responds; reset status after tool results
            isAgentThinking: d.role === 'assistant' ? false : prev.isAgentThinking,
            ...(d.role === 'tool'
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

          // When a prompt is queued (runner not ready), show queued indicator
          let { isAgentThinking, agentStatus, agentStatusDetail } = prev;
          if (terminalSession) {
            isAgentThinking = false;
            agentStatus = effectiveStatus === 'error' ? 'error' : 'idle';
            agentStatusDetail = undefined;
          } else if (data.promptQueued) {
            isAgentThinking = true;
            agentStatus = 'queued';
            agentStatusDetail = data.queueReason === 'busy'
              ? 'Message queued — waiting for agent...'
              : 'Message queued — waking session...';
          }

          return {
            ...prev,
            status: effectiveStatus,
            connectedUsers: nextUsers,
            runnerConnected,
            isAgentThinking,
            agentStatus,
            agentStatusDetail,
          };
        });
        break;
      }

      case 'chunk': {
        const chunkMsg = message as WebSocketChunkMessage;
        // Update the message's text part in-place
        setState((prev) => {
          if (prev.agentStatus === 'idle') return prev;
          if (!chunkMsg.messageId) return prev;
          const idx = prev.messages.findIndex((m) => m.id === chunkMsg.messageId);
          if (idx === -1) return prev;
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
          interactivePrompts: [
            ...prev.interactivePrompts,
            {
              id: prompt.id,
              sessionId: prompt.sessionId,
              type: prompt.type,
              title: prompt.title,
              body: prompt.body,
              actions: prompt.actions,
              expiresAt: prompt.expiresAt,
              context: prompt.context,
              status: 'pending' as const,
            },
          ],
        }));
        break;
      }

      case 'agentStatus': {
        const statusMsg = message as WebSocketAgentStatusMessage;
        setState((prev) => {
          if (isTerminalSessionStatus(prev.status) && statusMsg.status !== 'error') {
            return prev;
          }
          return {
            ...prev,
            agentStatus: statusMsg.status,
            agentStatusDetail: statusMsg.detail,
            agentStatusChannelType: statusMsg.channelType,
            agentStatusChannelId: statusMsg.channelId,
            // Also update isAgentThinking for backward compatibility
            isAgentThinking: statusMsg.status !== 'idle' && !isTerminalSessionStatus(prev.status),
          };
        });
        break;
      }

      case 'error': {
        const errorMsg = message as WebSocketErrorMessage;
        const rawError = errorMsg.error || errorMsg.content || 'Unknown error';
        // Guard against object-type errors that slipped through serialization
        const errorText = typeof rawError === 'string' ? rawError
          : typeof rawError === 'object' ? (rawError as Record<string, unknown>).message as string || JSON.stringify(rawError)
          : String(rawError);
        const errorMessage: Message = {
          id: errorMsg.messageId || crypto.randomUUID(),
          sessionId: sessionIdRef.current,
          role: 'system',
          content: `Error: ${errorText}`,
          channelType: errorMsg.channelType,
          channelId: errorMsg.channelId,
          createdAt: new Date(),
        };
        setState((prev) => ({
          ...prev,
          messages: [...prev.messages, errorMessage],
          isAgentThinking: false,
          agentStatus: 'error',
          agentStatusDetail: errorText,
        }));
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
        setState((prev) => ({
          ...prev,
          interactivePrompts: prev.interactivePrompts.map((p) =>
            p.id === rMsg.promptId ? { ...p, status: 'resolved' as const } : p
          ),
        }));
        // Prune resolved prompt from state after a short delay
        setTimeout(() => {
          setState((prev) => ({
            ...prev,
            interactivePrompts: prev.interactivePrompts.filter(
              (p) => p.id !== rMsg.promptId || p.status === 'pending'
            ),
          }));
        }, 5000);
        break;
      }

      case 'interactive_prompt_expired': {
        const eMsg = message as WebSocketInteractivePromptExpiredMessage;
        setState((prev) => ({
          ...prev,
          interactivePrompts: prev.interactivePrompts.map((p) =>
            p.id === eMsg.promptId ? { ...p, status: 'expired' as const } : p
          ),
        }));
        // Prune expired prompt from state after a short delay
        setTimeout(() => {
          setState((prev) => ({
            ...prev,
            interactivePrompts: prev.interactivePrompts.filter(
              (p) => p.id !== eMsg.promptId || p.status === 'pending'
            ),
          }));
        }, 5000);
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

      send({
        type: 'prompt',
        content,
        ...(model ? { model } : {}),
        ...(attachments && attachments.length > 0 ? { attachments } : {}),
        queueMode: queueModeOverride || userQueueMode,
        ...(channelType ? { channelType } : {}),
        ...(channelId ? { channelId } : {}),
        ...(threadId ? { threadId } : {}),
        ...(continuationContext ? { continuationContext } : {}),
      });
      // Start thinking indicator when user sends a message
      setState((prev) => ({ ...prev, isAgentThinking: true }));
    },
    [isConnected, send, userQueueMode]
  );

  const abort = useCallback((channelType?: string, channelId?: string) => {
    if (!isConnected) return;
    send({
      type: 'abort',
      ...(channelType ? { channelType } : {}),
      ...(channelId ? { channelId } : {}),
    });
    // Optimistically clear streaming state
    setState((prev) => ({
      ...prev,
      isAgentThinking: false,
      agentStatus: 'idle' as const,
      agentStatusDetail: undefined,
    }));
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
      setState((prev) => ({
        ...prev,
        interactivePrompts: prev.interactivePrompts.map(
          (p) => p.id === promptId ? { ...p, status: 'resolved' as const } : p
        ),
      }));
      setTimeout(() => {
        setState((prev) => ({
          ...prev,
          interactivePrompts: prev.interactivePrompts.filter(
            (p) => p.id !== promptId || p.status === 'pending'
          ),
        }));
      }, 5000);
    },
    [isConnected, send]
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

  const addLocalSystemMessage = useCallback((content: string) => {
    const msg: Message = {
      id: `local-${crypto.randomUUID()}`,
      sessionId: sessionIdRef.current,
      role: 'system',
      content,
      createdAt: new Date(),
    };
    setState((prev) => ({
      ...prev,
      messages: [...prev.messages, msg],
    }));
  }, []);

  const executeCommand = useCallback(
    async (command: string, _args?: string, channelType?: string, channelId?: string) => {
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
              abort();
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

  return {
    messages: state.messages,
    sessionStatus: state.status,
    interactivePrompts: state.interactivePrompts,
    connectedUsers: state.connectedUsers,
    logEntries: state.logEntries,
    isAgentThinking: state.isAgentThinking,
    agentStatus: state.agentStatus,
    agentStatusDetail: state.agentStatusDetail,
    agentStatusChannelType: state.agentStatusChannelType,
    agentStatusChannelId: state.agentStatusChannelId,
    availableModels: state.availableModels,
    selectedModel,
    setSelectedModel: handleModelChange,
    connectionStatus: wsStatus,
    isConnected,
    sendMessage,
    answerQuestion,
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
    approveActionWs: useCallback((invocationId: string) => {
      if (isConnected) {
        send({ type: 'approve-action', invocationId } as any);
      }
    }, [isConnected, send]),
    denyActionWs: useCallback((invocationId: string) => {
      if (isConnected) {
        send({ type: 'deny-action', invocationId } as any);
      }
    }, [isConnected, send]),
  };
}
