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
import { useState, useCallback, useRef } from 'react';
import { api } from './client';

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
 * Subset of the Vercel AI SDK UIMessage parts we care about. The server
 * is the source of truth for the full shape; this is just what the
 * panel renders.
 */
export type UiMessagePart =
  | { type: 'text'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args: unknown }
  | { type: 'tool-result'; toolCallId: string; toolName: string; result: unknown }
  | { type: string; [key: string]: unknown };

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

      await consumeUiStream(resp.body!, (partUpdate) => {
        setMessages((prev) => {
          const last = prev[prev.length - 1];
          if (!last || last.role !== 'assistant') return prev;
          const updated = applyPartUpdate(last, partUpdate);
          return [...prev.slice(0, -1), updated];
        });
      });
      setStatus('idle');
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

type PartUpdate =
  | { kind: 'text-delta'; id: string; delta: string }
  | { kind: 'tool-call'; toolCallId: string; toolName: string; args: unknown }
  | { kind: 'tool-result'; toolCallId: string; result: unknown };

async function consumeUiStream(
  body: ReadableStream<Uint8Array>,
  onUpdate: (u: PartUpdate) => void,
): Promise<void> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    // SSE events are separated by `\n\n`.
    let idx;
    while ((idx = buf.indexOf('\n\n')) !== -1) {
      const raw = buf.slice(0, idx);
      buf = buf.slice(idx + 2);
      handleSseEvent(raw, onUpdate);
    }
  }
  if (buf.trim()) handleSseEvent(buf, onUpdate);
}

function handleSseEvent(raw: string, onUpdate: (u: PartUpdate) => void) {
  // Each event is one or more `data: <json>` lines.
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
    routeChunk(parsed, onUpdate);
  }
}

function routeChunk(chunk: Record<string, unknown>, onUpdate: (u: PartUpdate) => void) {
  const type = chunk.type as string | undefined;
  // The Vercel AI SDK v6 UI stream encoding — keys vary by version, so
  // we look for the most common shapes and ignore unknown chunks.
  if (type === 'text-delta' || type === 'text') {
    const delta = (chunk.delta ?? chunk.text ?? '') as string;
    const id = (chunk.id ?? 'text-0') as string;
    if (delta) onUpdate({ kind: 'text-delta', id, delta });
  } else if (type === 'tool-call' || type === 'tool-input-available') {
    onUpdate({
      kind: 'tool-call',
      toolCallId: (chunk.toolCallId ?? chunk.id ?? '') as string,
      toolName: (chunk.toolName ?? '') as string,
      args: chunk.input ?? chunk.args ?? {},
    });
  } else if (type === 'tool-result' || type === 'tool-output-available') {
    onUpdate({
      kind: 'tool-result',
      toolCallId: (chunk.toolCallId ?? chunk.id ?? '') as string,
      result: chunk.output ?? chunk.result ?? null,
    });
  }
}

function applyPartUpdate(msg: UiMessage, update: PartUpdate): UiMessage {
  const parts = [...msg.parts];
  switch (update.kind) {
    case 'text-delta': {
      const last = parts[parts.length - 1];
      if (last && last.type === 'text') {
        parts[parts.length - 1] = { ...last, text: (last as { text: string }).text + update.delta };
      } else {
        parts.push({ type: 'text', text: update.delta });
      }
      break;
    }
    case 'tool-call':
      parts.push({
        type: 'tool-call',
        toolCallId: update.toolCallId,
        toolName: update.toolName,
        args: update.args,
      });
      break;
    case 'tool-result':
      parts.push({
        type: 'tool-result',
        toolCallId: update.toolCallId,
        toolName: '',
        result: update.result,
      });
      break;
  }
  return { ...msg, parts };
}
