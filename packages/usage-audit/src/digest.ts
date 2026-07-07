import type { Category, MessageRow, ThreadRow, ThreadTotals } from './types.js';

export interface DigestInput {
  thread: ThreadRow;
  totals: ThreadTotals;
  category: Category;
  messages: MessageRow[];
  parentSessionTitle?: string | null;
}

// Char budgets per section. Roughly maps to ~3-4k chars overall → ~750-1k
// input tokens, well under the 2-3k cap from the spec.
const FIRST_USER_BUDGET = 800;
const ASSISTANT_TURN_BUDGET = 600;
const ASSISTANT_TURN_COUNT = 2;

export function buildThreadDigest(input: DigestInput): string {
  const { thread, totals, category, messages, parentSessionTitle } = input;

  const durationMin = computeDurationMinutes(totals.firstCallAt, totals.lastCallAt);
  const topTools = totals.toolHistogram
    .slice()
    .sort((a, b) => b.calls - a.calls)
    .slice(0, 6)
    .map((t) => `${t.toolName} (${t.calls})`)
    .join(', ');

  const firstUserMsg = messages.find((m) => m.role === 'user');
  const assistantMsgs = messages.filter((m) => m.role === 'assistant');
  const lastAssistant = assistantMsgs.slice(-ASSISTANT_TURN_COUNT);

  const lines: string[] = [];
  lines.push('Thread metadata:');
  lines.push(`- category: ${category}`);
  lines.push(`- channel: ${thread.originChannelType ?? '(none)'}`);
  lines.push(
    `- duration: ${durationMin}m, ${totals.llmCalls} LLM calls, ` +
      `${formatTokens(totals.inputTokens)} input / ${formatTokens(totals.outputTokens)} output tokens`,
  );
  lines.push(`- top tools: ${topTools || '(none)'}`);
  if (thread.originTriggerId) {
    lines.push(
      `- trigger: ${thread.originTriggerType ?? 'unknown'} (id ${thread.originTriggerId})`,
    );
  }
  if (category === 'orchestrator-internal' && parentSessionTitle) {
    lines.push(`- parent session title: ${truncate(parentSessionTitle, 140)}`);
  }
  if (thread.threadTitle) {
    lines.push(`- thread title: ${truncate(thread.threadTitle, 140)}`);
  }

  lines.push('');
  lines.push('First user message:');
  lines.push(quote(firstUserMsg ? firstUserMsg.content : '(none)', FIRST_USER_BUDGET));

  if (lastAssistant.length > 0) {
    lines.push('');
    lines.push(`Last ${lastAssistant.length} assistant turn(s):`);
    for (const m of lastAssistant) {
      lines.push(quote(m.content, ASSISTANT_TURN_BUDGET));
    }
  }

  return lines.join('\n');
}

function computeDurationMinutes(firstAt: string, lastAt: string): number {
  const a = Date.parse(firstAt);
  const b = Date.parse(lastAt);
  if (Number.isNaN(a) || Number.isNaN(b)) return 0;
  return Math.max(0, Math.round((b - a) / 60_000));
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return `${s.slice(0, max - 1)}…`;
}

function quote(s: string, budget: number): string {
  const t = truncate(s.trim(), budget);
  return t
    .split('\n')
    .map((line) => `> ${line}`)
    .join('\n');
}
