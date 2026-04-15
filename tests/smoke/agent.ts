/**
 * Dispatch a prompt to the orchestrator agent and poll for its response.
 *
 * Workflow:
 *   1. Resolve the orchestrator session ID
 *   2. Snapshot existing message IDs
 *   3. Send the prompt via POST /api/sessions/:id/messages
 *   4. Poll GET /api/sessions/:id/messages until a new assistant message appears
 *   5. Extract and parse JSON from the response
 */

import { SmokeClient, type Message } from './client.js';

export interface AgentResponse {
  /** The raw text of the assistant's final message */
  raw: string;
  /** Parsed JSON if the response contained a JSON block, else null */
  json: Record<string, unknown> | null;
  /** All new messages received since the prompt was sent */
  messages: Message[];
  /** How long the agent took to respond (ms) */
  durationMs: number;
}

export interface DispatchOptions {
  /** Max time to wait for a response (ms). Default: 90_000 */
  timeoutMs?: number;
  /** Poll interval (ms). Default: 3_000 */
  pollIntervalMs?: number;
  /** Thread ID to scope the conversation. If omitted, uses the active thread. */
  threadId?: string;
}

/**
 * Send a prompt to the orchestrator and wait for the agent's response.
 *
 * Resolves with the parsed response once the agent produces a new assistant
 * message. Rejects if the timeout is exceeded.
 */
export async function dispatchAndWait(
  client: SmokeClient,
  prompt: string,
  opts?: DispatchOptions,
): Promise<AgentResponse> {
  const timeoutMs = opts?.timeoutMs ?? 90_000;
  const pollIntervalMs = opts?.pollIntervalMs ?? 3_000;

  // 1. Resolve orchestrator session
  const orch = await client.getOrchestrator();
  if (!orch.exists || !orch.sessionId) {
    throw new Error('No orchestrator session found — is the orchestrator configured and running?');
  }
  const sessionId = orch.sessionId;

  // 2. Create a fresh thread so the prompt doesn't land in an existing
  //    conversation. Without this, the message queues behind whatever the
  //    orchestrator is currently doing and may never get dispatched.
  const threadId = opts?.threadId ?? (await client.createThread(sessionId)).id;

  // 3. Send prompt scoped to the new thread
  const start = Date.now();
  await client.sendPrompt(sessionId, { content: prompt, threadId });

  // 4. Poll for new assistant messages containing JSON
  //
  // The agent may produce multiple assistant messages as it works (narration,
  // tool calls, progress updates). We keep polling until we find one that
  // contains a parseable JSON object matching our expected smoke test shape,
  // or until the timeout is reached.
  const deadline = start + timeoutMs;
  let lastRaw = '';

  while (Date.now() < deadline) {
    await sleep(pollIntervalMs);

    const result = await client.getMessages(sessionId, {
      limit: 50,
      threadId,
    });

    const newMessages = result.messages ?? [];
    const assistantMessages = newMessages.filter((m) => m.role === 'assistant');

    // Check each assistant message (newest first) for JSON
    for (let i = assistantMessages.length - 1; i >= 0; i--) {
      const raw = extractTextContent(assistantMessages[i]);
      lastRaw = raw || lastRaw;
      const json = extractJson(raw);
      if (json && 'smoke_test' in json) {
        return {
          raw,
          json,
          messages: newMessages,
          durationMs: Date.now() - start,
        };
      }
    }
  }

  throw new Error(
    `Agent did not produce a JSON smoke test result within ${timeoutMs}ms.\n` +
    `Thread: ${threadId}\n` +
    `Last assistant message: ${lastRaw.slice(0, 500)}`
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Extract text content from a message, handling both string and parts formats. */
function extractTextContent(msg: Message): string {
  if (typeof msg.content === 'string' && msg.content.length > 0) {
    return msg.content;
  }
  // Try parts array (some messages store content as structured parts)
  if (Array.isArray(msg.parts)) {
    return msg.parts
      .filter((p: any) => p.type === 'text')
      .map((p: any) => p.text || p.content || '')
      .join('\n');
  }
  return '';
}

/**
 * Extract a JSON object from the agent's response text.
 *
 * Handles:
 *   - Pure JSON responses
 *   - JSON inside ```json code fences
 *   - JSON embedded in surrounding text
 */
function extractJson(text: string): Record<string, unknown> | null {
  // Try the whole string first
  try {
    const parsed = JSON.parse(text.trim());
    if (typeof parsed === 'object' && parsed !== null) return parsed;
  } catch { /* not pure JSON */ }

  // Try inside code fences
  const fenceMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/);
  if (fenceMatch) {
    try {
      const parsed = JSON.parse(fenceMatch[1].trim());
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch { /* not valid JSON in fence */ }
  }

  // Try to find a JSON object anywhere in the text
  const objectMatch = text.match(/\{[\s\S]*\}/);
  if (objectMatch) {
    try {
      const parsed = JSON.parse(objectMatch[0]);
      if (typeof parsed === 'object' && parsed !== null) return parsed;
    } catch { /* not valid JSON */ }
  }

  return null;
}

// ─── Smoke Test Result Types ──────────────────────────────────────────────

/** Standard shape for a single check in an agent smoke test result. */
export interface SmokeCheck {
  pass: boolean;
  detail: string;
}

/** Standard shape for an agent smoke test JSON response. */
export interface SmokeTestResult {
  smoke_test: string;
  timestamp: string;
  checks: Record<string, SmokeCheck>;
  summary: {
    total: number;
    passed: number;
    failed: number;
  };
}

/** Type guard for SmokeTestResult. */
export function isSmokeTestResult(obj: unknown): obj is SmokeTestResult {
  if (!obj || typeof obj !== 'object') return false;
  const r = obj as Record<string, unknown>;
  return (
    typeof r.smoke_test === 'string' &&
    typeof r.checks === 'object' &&
    r.checks !== null &&
    typeof r.summary === 'object' &&
    r.summary !== null &&
    typeof (r.summary as Record<string, unknown>).total === 'number'
  );
}

/** Assertion form — throws if the shape doesn't match, narrows the type if it does. */
export function assertSmokeTestResult(obj: unknown): asserts obj is SmokeTestResult {
  if (!isSmokeTestResult(obj)) {
    throw new Error(`Expected SmokeTestResult, got: ${JSON.stringify(obj).slice(0, 300)}`);
  }
}
