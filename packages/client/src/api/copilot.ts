/**
 * Workflow Copilot API client.
 *
 * Streaming chat backed by the Vercel AI SDK on the worker side. We
 * intentionally don't use @ai-sdk/react's useChat because of a major
 * version mismatch with the worker's `ai` v6 — manual fetch + SSE
 * parsing keeps the boundary simple and lets the worker control the
 * message shape directly.
 */
import { useQuery } from '@tanstack/react-query';
import { useState, useCallback, useRef, useEffect } from 'react';
import { api } from './client';
import { useAuthStore } from '@/stores/auth';
import { router } from '@/app';

export const copilotKeys = {
  all: ['copilot'] as const,
  threads: (workflowId: string) => ['copilot', 'threads', workflowId] as const,
  messages: (threadId: string) => ['copilot', 'messages', threadId] as const,
};

export interface CopilotThreadSummary {
  id: string;
  workflowId: string;
  userId: string;
  model: string | null;
  title: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CopilotMessage {
  id: string;
  role: 'user' | 'assistant' | 'tool';
  content: string;
  parts: UiMessagePart[] | null;
  createdAt: string;
}

/**
 * Vercel AI SDK v6 UIMessage parts as they appear on the wire and in
 * responseMessage.parts. Tool invocations are ONE part per call whose
 * state advances (input-streaming → input-available → output-available).
 * We accept the SDK's canonical types verbatim so the SSE stream, the
 * persisted history, and the renderer all read the same shape.
 *
 * Tool parts come in two flavors:
 *   • Static: `type: "tool-<name>"` — for tools known at build time
 *   • Dynamic: `type: "dynamic-tool"` — for tools discovered at request
 *     time (which is all of ours, since the copilot registers tools
 *     dynamically per workflow)
 */
export type ToolPartState =
  | 'input-streaming'
  | 'input-available'
  | 'output-available'
  | 'output-error';

export interface TextPart {
  type: 'text';
  text: string;
}

export interface ToolPart {
  type: string; // 'tool-<name>' | 'dynamic-tool'
  toolCallId: string;
  toolName?: string; // required on dynamic-tool
  state: ToolPartState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}

export type UiMessagePart = TextPart | ToolPart | { type: string; [key: string]: unknown };

export function isToolPart(part: UiMessagePart): part is ToolPart {
  return typeof part.type === 'string' && (part.type === 'dynamic-tool' || part.type.startsWith('tool-'));
}

export function useCopilotThreads(workflowId: string | null | undefined) {
  return useQuery({
    queryKey: copilotKeys.threads(workflowId ?? ''),
    enabled: !!workflowId,
    queryFn: () =>
      api.get<{ threads: CopilotThreadSummary[] }>(`/copilot/threads?workflowId=${workflowId}`),
  });
}

export function useCopilotMessages(threadId: string | null) {
  return useQuery({
    queryKey: copilotKeys.messages(threadId ?? ''),
    enabled: !!threadId,
    queryFn: () =>
      api.get<{ thread: CopilotThreadSummary; messages: CopilotMessage[] }>(
        `/copilot/threads/${threadId}/messages`,
      ),
  });
}

// ────────────────────────────────────────────────────────────────────────
// Streaming hook
// ────────────────────────────────────────────────────────────────────────

export interface UiMessage {
  id: string;
  role: 'user' | 'assistant';
  parts: UiMessagePart[];
}

interface UseCopilotChatOptions {
  workflowId: string;
  initialThreadId?: string | null;
  initialMessages?: UiMessage[];
}

export function useCopilotChat(opts: UseCopilotChatOptions) {
  const [threadId, setThreadId] = useState<string | null>(opts.initialThreadId ?? null);
  const [messages, setMessages] = useState<UiMessage[]>(opts.initialMessages ?? []);
  const [status, setStatus] = useState<'idle' | 'streaming' | 'error'>('idle');
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  // Abort any in-flight stream when the hook unmounts. Without this
  // every thread switch / panel close / route change during an active
  // stream leaks the network request and keeps calling setState on a
  // dead instance.
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  // useState captures initialMessages once at mount, so if this hook's
  // parent renders us before the messages query resolved (typical on a
  // cache miss — first visit to a thread), the persisted history would
  // be silently dropped. Sync it in when it arrives.
  //
  // Arm the bootstrap guard at mount when there's NO initialThreadId:
  // a brand-new thread can't have server-side history to bootstrap, so
  // if the client already sent a first turn before the server-assigned
  // thread id came back (and its messages query fired), we must NOT
  // prepend the server's echo of that same turn — it would duplicate
  // every message in the conversation.
  const bootstrappedRef = useRef(!opts.initialThreadId);
  useEffect(() => {
    if (bootstrappedRef.current) return;
    if (!opts.initialMessages || opts.initialMessages.length === 0) return;
    bootstrappedRef.current = true;
    setMessages((current) => {
      // Merge by id so an initial message that has since been extended
      // (e.g., the persisted assistant turn now has more parts than
      // the seed we already have) doesn't get duplicated.
      const seen = new Set(current.map((m) => m.id));
      const prepend = opts.initialMessages!.filter((m) => !seen.has(m.id));
      return [...prepend, ...current];
    });
  }, [opts.initialMessages]);

  const send = useCallback(async (text: string) => {
    if (!text.trim() || status === 'streaming') return;

    const userMsg: UiMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      parts: [{ type: 'text', text }],
    };
    const assistantMsg: UiMessage = {
      id: crypto.randomUUID(),
      role: 'assistant',
      parts: [],
    };
    setMessages((prev) => [...prev, userMsg, assistantMsg]);
    setStatus('streaming');
    setError(null);

    const ac = new AbortController();
    abortRef.current = ac;

    try {
      const resp = await api.fetch('/copilot/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          workflowId: opts.workflowId,
          threadId,
          messages: [...messages, userMsg].map((m) => ({
            id: m.id,
            role: m.role,
            parts: m.parts,
          })),
        }),
        signal: ac.signal,
      });

      if (!resp.ok) {
        // Auth expiry: replicate the apiClient behaviour — clear auth
        // state and bounce to /login. Otherwise the user gets stuck on
        // the editor with a "session expired" toast and no recovery.
        if (resp.status === 401) {
          useAuthStore.getState().clearAuth();
          void router.navigate({ to: '/login' });
          return;
        }
        const body = await resp.text().catch(() => '');
        let friendly = body || `HTTP ${resp.status}`;
        try {
          const parsed = JSON.parse(body) as { error?: string | { issues?: Array<{ message?: string; path?: unknown[] }> } };
          if (typeof parsed.error === 'string') {
            friendly = parsed.error;
          } else if (parsed.error && Array.isArray(parsed.error.issues)) {
            friendly = parsed.error.issues
              .map((i) => `${i.message ?? ''}${i.path ? ` (${i.path.join('.')})` : ''}`)
              .join('; ');
          }
        } catch {
          /* leave friendly as raw body */
        }
        throw new Error(friendly);
      }

      const newThreadId = resp.headers.get('X-Copilot-Thread-Id');
      if (newThreadId && newThreadId !== threadId) setThreadId(newThreadId);

      let streamError: string | null = null;
      await consumeUiStream(resp.body!, (chunk) => {
        // Stream-level errors (rate limit, refusal, context overflow)
        // arrive as their own chunk. Surface them to the hook state
        // instead of silently dropping — otherwise the assistant
        // bubble just goes quiet.
        if (chunk.kind === 'stream-error') {
          streamError = chunk.errorText || 'stream ended with an error';
          return;
        }
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (!last || last.role !== 'assistant') return prev;
          const updated = applyStreamChunk(last, chunk);
          return [...prev.slice(0, -1), updated];
        });
      });
      if (streamError) {
        setStatus('error');
        setError(streamError);
      } else {
        setStatus('idle');
      }
    } catch (err) {
      if (ac.signal.aborted) {
        setStatus('idle');
        return;
      }
      // Drop the empty assistant placeholder we optimistically added so
      // the user message isn't followed by a blank bubble + an error.
      setMessages((prev) => {
        const last = prev[prev.length - 1];
        if (last && last.role === 'assistant' && last.parts.length === 0) {
          return prev.slice(0, -1);
        }
        return prev;
      });
      setStatus('error');
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      abortRef.current = null;
    }
  }, [messages, opts.workflowId, status, threadId]);

  const stop = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return { messages, threadId, status, error, send, stop, setMessages };
}

// ────────────────────────────────────────────────────────────────────────
// SSE stream parsing for the Vercel AI SDK UI message stream
// ────────────────────────────────────────────────────────────────────────

/**
 * Chunks emitted by the SDK's UI-message stream that we care about.
 * See `UIMessageChunk` in ai@6 for the full list.
 */
type StreamChunk =
  | { kind: 'text-start'; id: string }
  | { kind: 'text-delta'; id: string; delta: string }
  | { kind: 'tool-input-start'; toolCallId: string; toolName: string; dynamic?: boolean }
  | { kind: 'tool-input-delta'; toolCallId: string; delta: string }
  | { kind: 'tool-input-available'; toolCallId: string; toolName: string; input: unknown; dynamic?: boolean }
  | { kind: 'tool-output-available'; toolCallId: string; output: unknown }
  | { kind: 'tool-output-error'; toolCallId: string; errorText: string }
  // The SDK also emits `tool-input-error` (malformed / rejected input)
  // and a stream-level `error` chunk (rate limit, refusal, context
  // overflow). If we don't consume these the tool card stays stuck in
  // input-streaming state and mid-stream failures produce no user
  // feedback.
  | { kind: 'tool-input-error'; toolCallId: string; toolName: string; errorText: string }
  | { kind: 'stream-error'; errorText: string };

async function consumeUiStream(
  body: ReadableStream<Uint8Array>,
  onChunk: (c: StreamChunk) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      handleSseEvent(raw, onChunk);
    }
  }
  if (buf.trim()) handleSseEvent(buf, onChunk);
}

function handleSseEvent(raw: string, onChunk: (c: StreamChunk) => void) {
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    let parsed: Record<string, unknown>;
    try {
      parsed = JSON.parse(payload);
    } catch {
      continue;
    }
    const chunk = decodeChunk(parsed);
    if (chunk) onChunk(chunk);
  }
}

function decodeChunk(chunk: Record<string, unknown>): StreamChunk | null {
  const type = chunk.type as string | undefined;
  switch (type) {
    case 'text-start':
      return { kind: 'text-start', id: (chunk.id ?? 'text-0') as string };
    case 'text-delta':
      return {
        kind: 'text-delta',
        id: (chunk.id ?? 'text-0') as string,
        delta: (chunk.delta ?? '') as string,
      };
    case 'tool-input-start':
      return {
        kind: 'tool-input-start',
        toolCallId: (chunk.toolCallId ?? '') as string,
        toolName: (chunk.toolName ?? '') as string,
        dynamic: chunk.dynamic as boolean | undefined,
      };
    case 'tool-input-delta':
      return {
        kind: 'tool-input-delta',
        toolCallId: (chunk.toolCallId ?? '') as string,
        delta: (chunk.inputTextDelta ?? chunk.delta ?? '') as string,
      };
    case 'tool-input-available':
      return {
        kind: 'tool-input-available',
        toolCallId: (chunk.toolCallId ?? '') as string,
        toolName: (chunk.toolName ?? '') as string,
        input: chunk.input,
        dynamic: chunk.dynamic as boolean | undefined,
      };
    case 'tool-output-available':
      return {
        kind: 'tool-output-available',
        toolCallId: (chunk.toolCallId ?? '') as string,
        output: chunk.output,
      };
    case 'tool-output-error':
      return {
        kind: 'tool-output-error',
        toolCallId: (chunk.toolCallId ?? '') as string,
        errorText: (chunk.errorText ?? '') as string,
      };
    case 'tool-input-error':
      return {
        kind: 'tool-input-error',
        toolCallId: (chunk.toolCallId ?? '') as string,
        // The SDK's tool-input-error chunk carries the tool name (it's
        // guaranteed by the type). Preserve it so the "input-error"
        // fallback card renders "applyWorkflowPatch" instead of "tool".
        toolName: (chunk.toolName ?? '') as string,
        errorText: (chunk.errorText ?? '') as string,
      };
    case 'error':
      return {
        kind: 'stream-error',
        errorText: (chunk.errorText ?? chunk.error ?? '') as string,
      };
    default:
      return null;
  }
}

function applyStreamChunk(msg: UiMessage, chunk: StreamChunk): UiMessage {
  const parts = [...msg.parts];
  switch (chunk.kind) {
    case 'text-start': {
      // Some providers emit text-start before any deltas; guarantee a
      // text slot exists so subsequent deltas have something to grow.
      const last = parts[parts.length - 1];
      if (!last || last.type !== 'text') {
        parts.push({ type: 'text', text: '' });
      }
      break;
    }
    case 'text-delta': {
      const last = parts[parts.length - 1];
      if (last && last.type === 'text') {
        parts[parts.length - 1] = { ...last, text: (last as TextPart).text + chunk.delta };
      } else {
        parts.push({ type: 'text', text: chunk.delta });
      }
      break;
    }
    case 'tool-input-start': {
      // Append a new tool part in `input-streaming` state — the SDK
      // will send tool-input-delta or tool-input-available next.
      parts.push(buildDynamicToolPart({
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        state: 'input-streaming',
        input: '',
      }));
      break;
    }
    case 'tool-input-delta': {
      const idx = findToolPart(parts, chunk.toolCallId);
      if (idx === -1) break;
      const existing = parts[idx] as ToolPart;
      const currentInput = typeof existing.input === 'string' ? existing.input : '';
      parts[idx] = { ...existing, input: currentInput + chunk.delta };
      break;
    }
    case 'tool-input-available': {
      const idx = findToolPart(parts, chunk.toolCallId);
      const built = buildDynamicToolPart({
        toolCallId: chunk.toolCallId,
        toolName: chunk.toolName,
        state: 'input-available',
        input: chunk.input,
      });
      if (idx === -1) parts.push(built);
      else parts[idx] = { ...parts[idx], ...built };
      break;
    }
    case 'tool-output-available': {
      const idx = findToolPart(parts, chunk.toolCallId);
      if (idx === -1) break;
      const existing = parts[idx] as ToolPart;
      parts[idx] = { ...existing, state: 'output-available', output: chunk.output };
      break;
    }
    case 'tool-output-error': {
      const idx = findToolPart(parts, chunk.toolCallId);
      if (idx === -1) break;
      const existing = parts[idx] as ToolPart;
      parts[idx] = { ...existing, state: 'output-error', errorText: chunk.errorText };
      break;
    }
    case 'tool-input-error': {
      // Malformed / rejected input — treat as a terminal error state
      // so the tool card stops streaming its pulse and renders the
      // reason. Reuses the same `output-error` render slot.
      const idx = findToolPart(parts, chunk.toolCallId);
      if (idx === -1) {
        parts.push(buildDynamicToolPart({
          toolCallId: chunk.toolCallId,
          toolName: chunk.toolName,
          state: 'output-error',
          errorText: chunk.errorText,
        }));
      } else {
        const existing = parts[idx] as ToolPart;
        parts[idx] = {
          ...existing,
          // Only override toolName if we didn't already have one — the
          // input-start / input-available events are the primary source.
          toolName: existing.toolName || chunk.toolName,
          state: 'output-error',
          errorText: chunk.errorText,
        };
      }
      break;
    }
    case 'stream-error':
      // Surface to hook state via the switch above the applyStreamChunk
      // call; nothing to do at the part level.
      break;
  }
  return { ...msg, parts };
}

function findToolPart(parts: UiMessagePart[], toolCallId: string): number {
  return parts.findIndex(
    (p) => isToolPart(p) && p.toolCallId === toolCallId,
  );
}

function buildDynamicToolPart(fields: {
  toolCallId: string;
  toolName: string;
  state: ToolPartState;
  input?: unknown;
  output?: unknown;
  errorText?: string;
}): ToolPart {
  // We always use the dynamic-tool shape because our tools are
  // registered per-request; the model doesn't know static tool names
  // at build time and neither does the renderer.
  return {
    type: 'dynamic-tool',
    toolCallId: fields.toolCallId,
    toolName: fields.toolName,
    state: fields.state,
    input: fields.input,
    output: fields.output,
    errorText: fields.errorText,
  };
}
