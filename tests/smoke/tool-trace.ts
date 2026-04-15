/**
 * ToolCallTrace — extract and assert against tool calls in a session's
 * persisted message history.
 *
 * Bypasses the agent's self-report by reading the raw tool-call parts from
 * assistant turn messages (V2 protocol). Lets tests assert the LITERAL tool
 * results (catches "tool succeeded but reported failure" bugs like mem_rm)
 * and the actual sequence of tool invocations (catches hallucinated calls,
 * order violations, orphaned 'running' tools).
 *
 * Source of truth: GET /api/sessions/:id/messages — clean and retrospective.
 *
 * Design philosophy: keep the prompt simple, lean on the model for things
 * it's good at (semantic interpretation, JSON output composition), and
 * use this helper for things the model can rationalize away (tool names,
 * tool result strings, completion status).
 */
import type { Message } from './client.js';

export interface ToolCall {
  /** Tool name as the agent saw it (e.g. 'spawn_session', 'mem_rm'). */
  toolName: string;
  /** Stable per-call id from OpenCode. */
  callId: string;
  /** Final status: 'pending' | 'running' | 'completed' | 'error'. */
  status: string;
  /** Parsed tool arguments (object) or undefined if the agent didn't supply any. */
  args?: unknown;
  /** Raw tool result. For most valet tools this is a string; for some it's an object. */
  result?: unknown;
  /** Error message if status='error'. */
  error?: unknown;
  /** Containing assistant message id (for debugging). */
  messageId: string;
  /** Order index across the entire trace (0-based). */
  index: number;
}

/** Pattern for matching a tool name — exact string or regex. */
export type NameMatcher = string | RegExp;

function nameMatches(name: string, matcher: NameMatcher): boolean {
  return typeof matcher === 'string' ? name === matcher : matcher.test(name);
}

/** Render a tool call to a short string for failure messages. */
function renderCall(call: ToolCall): string {
  const result = typeof call.result === 'string'
    ? call.result.slice(0, 80).replace(/\s+/g, ' ')
    : call.result !== undefined
      ? JSON.stringify(call.result).slice(0, 80)
      : '';
  return `${call.toolName} [${call.status}]${result ? ` → "${result}"` : ''}`;
}

export class ToolCallTrace {
  readonly calls: ToolCall[];

  constructor(messages: Message[]) {
    this.calls = extractToolCalls(messages);
  }

  /** All tool calls whose name matches the matcher. */
  filter(matcher: NameMatcher): ToolCall[] {
    return this.calls.filter((c) => nameMatches(c.toolName, matcher));
  }

  /** First tool call matching, or undefined. */
  first(matcher: NameMatcher): ToolCall | undefined {
    return this.calls.find((c) => nameMatches(c.toolName, matcher));
  }

  /**
   * Assert a tool was called the expected number of times.
   * `count` defaults to "at least once". Pass an exact number to require exactness.
   */
  expectCalled(matcher: NameMatcher, opts?: { count?: number; atLeast?: number }): this {
    const matches = this.filter(matcher);
    if (opts?.count !== undefined) {
      if (matches.length !== opts.count) {
        throw new Error(
          `expected ${describeMatcher(matcher)} to be called exactly ${opts.count} time(s), got ${matches.length}.\n` +
          `All calls: ${this.calls.map(renderCall).join(' | ') || '(none)'}`,
        );
      }
    } else {
      const min = opts?.atLeast ?? 1;
      if (matches.length < min) {
        throw new Error(
          `expected ${describeMatcher(matcher)} to be called at least ${min} time(s), got ${matches.length}.\n` +
          `All calls: ${this.calls.map(renderCall).join(' | ') || '(none)'}`,
        );
      }
    }
    return this;
  }

  /** Assert a tool was NOT called. */
  expectNotCalled(matcher: NameMatcher): this {
    const matches = this.filter(matcher);
    if (matches.length > 0) {
      throw new Error(
        `expected ${describeMatcher(matcher)} not to be called, but it was called ${matches.length} time(s).\n` +
        `Matching calls: ${matches.map(renderCall).join(' | ')}`,
      );
    }
    return this;
  }

  /**
   * Assert these tool names appear in this relative order somewhere in the
   * trace. Other tools may be interleaved — this is subsequence matching,
   * not contiguous matching.
   */
  expectOrder(...matchers: NameMatcher[]): this {
    let idx = 0;
    for (const matcher of matchers) {
      const found = this.calls.findIndex((c, i) => i >= idx && nameMatches(c.toolName, matcher));
      if (found === -1) {
        throw new Error(
          `expected order ${matchers.map(describeMatcher).join(' → ')} not satisfied: ` +
          `could not find ${describeMatcher(matcher)} after position ${idx}.\n` +
          `All calls in order: ${this.calls.map((c) => c.toolName).join(', ') || '(none)'}`,
        );
      }
      idx = found + 1;
    }
    return this;
  }

  /**
   * Assert that at least one call to this tool produced a result matching the pattern.
   * Use for catching "tool returned wrong shape" — e.g. expectResultMatches('mem_rm', /^Deleted:/)
   * would have caught the bug where mem_rm always returned "Not found".
   */
  expectResultMatches(matcher: NameMatcher, pattern: RegExp): this {
    const matches = this.filter(matcher);
    if (matches.length === 0) {
      throw new Error(
        `expected at least one ${describeMatcher(matcher)} call to match ${pattern}, but the tool was never called.`,
      );
    }
    const matched = matches.some((c) => typeof c.result === 'string' && pattern.test(c.result));
    if (!matched) {
      throw new Error(
        `expected at least one ${describeMatcher(matcher)} call result to match ${pattern}.\n` +
        `Actual results:\n  ${matches.map(renderCall).join('\n  ')}`,
      );
    }
    return this;
  }

  /** Assert no result matching this tool matches the pattern (negative form). */
  expectResultDoesNotMatch(matcher: NameMatcher, pattern: RegExp): this {
    const matches = this.filter(matcher);
    const offenders = matches.filter((c) => typeof c.result === 'string' && pattern.test(c.result));
    if (offenders.length > 0) {
      throw new Error(
        `expected no ${describeMatcher(matcher)} call result to match ${pattern}, but ${offenders.length} did:\n  ${offenders.map(renderCall).join('\n  ')}`,
      );
    }
    return this;
  }

  /** Assert no tool call ended in 'error' status. */
  expectNoErrors(): this {
    const errored = this.calls.filter((c) => c.status === 'error');
    if (errored.length > 0) {
      throw new Error(
        `expected no tool calls to end in 'error', but ${errored.length} did:\n  ${errored.map(renderCall).join('\n  ')}`,
      );
    }
    return this;
  }

  /**
   * Assert every tool call reached a terminal status (completed or error).
   * Catches orphaned 'running' / 'pending' tools from suppressed SSE events
   * (the wait_for_event force-finalize bug).
   */
  expectAllTerminal(): this {
    const orphaned = this.calls.filter((c) => c.status !== 'completed' && c.status !== 'error');
    if (orphaned.length > 0) {
      throw new Error(
        `expected all tool calls to be terminal (completed/error), but ${orphaned.length} are not:\n  ${orphaned.map(renderCall).join('\n  ')}`,
      );
    }
    return this;
  }
}

function describeMatcher(m: NameMatcher): string {
  return typeof m === 'string' ? `\`${m}\`` : `pattern ${m}`;
}

/**
 * Walk persisted messages and pull out tool calls.
 *
 * Handles two storage shapes:
 *   - V2 (current): assistant messages with parts: Array<{type:'tool-call', callId, toolName, status, args, result, error}>
 *   - V1 (legacy): standalone role='tool' messages with parts: {toolName, args, result, ...}
 */
function extractToolCalls(messages: Message[]): ToolCall[] {
  const out: ToolCall[] = [];
  let index = 0;
  // Sort by creation time so order is deterministic
  const sorted = [...messages].sort((a, b) => {
    const ta = typeof a.createdAt === 'number' ? a.createdAt : new Date(a.createdAt).getTime();
    const tb = typeof b.createdAt === 'number' ? b.createdAt : new Date(b.createdAt).getTime();
    return ta - tb;
  });

  for (const msg of sorted) {
    // V2: assistant turn with parts array
    if (msg.role === 'assistant' && Array.isArray(msg.parts)) {
      for (const part of msg.parts as Record<string, unknown>[]) {
        if (!part || typeof part !== 'object') continue;
        if (part.type !== 'tool-call') continue;
        const toolName = typeof part.toolName === 'string' ? part.toolName : '';
        if (!toolName) continue;
        out.push({
          toolName,
          callId: typeof part.callId === 'string' ? part.callId : '',
          status: typeof part.status === 'string' ? part.status : 'unknown',
          args: part.args,
          result: part.result,
          error: part.error,
          messageId: msg.id,
          index: index++,
        });
      }
      continue;
    }
    // V1 legacy: standalone tool message (the Message type only enums user/assistant/system,
    // but historical data may include 'tool' — cast for the comparison).
    if ((msg.role as string) === 'tool' && msg.parts && typeof msg.parts === 'object' && !Array.isArray(msg.parts)) {
      const p = msg.parts as Record<string, unknown>;
      const toolName = typeof p.toolName === 'string' ? p.toolName : '';
      if (!toolName) continue;
      out.push({
        toolName,
        callId: typeof p.callId === 'string' ? p.callId : '',
        status: typeof p.status === 'string' ? p.status : 'completed',
        args: p.args,
        result: p.result,
        error: p.error,
        messageId: msg.id,
        index: index++,
      });
    }
  }
  return out;
}
