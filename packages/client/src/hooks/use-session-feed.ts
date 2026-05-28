import { useMemo } from 'react';
import type { Message } from '@valet/shared';
import type { ExecutionStepTrace } from '@/api/executions';
import { bump, WORKFLOW_TELEMETRY } from '@/lib/workflow-telemetry';

export type FeedItem =
  | { kind: 'message'; timestamp: number; message: Message }
  | { kind: 'step'; timestamp: number; step: ExecutionStepTrace };

/**
 * Merge chat messages and workflow step rows for a session into one timestamp-
 * ordered feed. Memoized on the two input arrays' identity — both come from
 * react-query and are stable between unrelated re-renders.
 *
 * Step rows use `startedAt` (workflow event time) when present, falling back
 * to `createdAt` (DB insertion time). createdAt can lag startedAt by enough to
 * mis-order rendering during burst writes.
 */
export function useSessionFeed(
  messages: Message[] | undefined,
  steps: ExecutionStepTrace[] | undefined,
): FeedItem[] {
  return useMemo(() => mergeFeed(messages ?? [], steps ?? []), [messages, steps]);
}

export function mergeFeed(messages: Message[], steps: ExecutionStepTrace[]): FeedItem[] {
  const items: FeedItem[] = [];
  for (const m of messages) {
    items.push({ kind: 'message', timestamp: toMs(m.createdAt), message: m });
  }
  for (const s of steps) {
    const ts = s.startedAt ?? s.createdAt;
    items.push({ kind: 'step', timestamp: toMs(ts), step: s });
  }
  items.sort((a, b) => a.timestamp - b.timestamp);

  // Telemetry: a workflow message that points at a step we don't have means
  // the events arrived out of order (or the step row was reaped). Don't error;
  // just count.
  const stepKeys = new Set(steps.map((s) => `${s.stepId}#${s.iterationPath}`));
  for (const m of messages) {
    if (m.workflowExecutionId && m.workflowStepId != null) {
      const key = `${m.workflowStepId}#${m.workflowIterationPath ?? ''}`;
      if (!stepKeys.has(key)) {
        bump(WORKFLOW_TELEMETRY.WORKFLOW_MESSAGE_NO_STEP, { messageId: m.id });
      }
    }
  }

  return items;
}

function toMs(t: number | string | Date | null | undefined): number {
  if (t == null) return 0;
  if (t instanceof Date) return t.getTime();
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  return new Date(t).getTime();
}

// ─── Chat render plan ────────────────────────────────────────────────────────

/**
 * One renderable unit in the session chat. The plan interleaves, in timestamp
 * order:
 * - `messages`: a run of plain (non-workflow) chat messages, grouped into turns
 *   by the renderer.
 * - `step`: a non-agent_prompt workflow step (bash/notify/loop/etc.) rendered
 *   as a step card.
 * - `step-container`: an agent_prompt step — the streamed prompt + assistant
 *   turn(s) wrapped in a per-step container, with the step row for header
 *   metadata. Distinguished from `step` by having ≥1 attributed message.
 */
export type ChatRenderItem =
  | { kind: 'messages'; messages: Message[] }
  | { kind: 'step'; step: ExecutionStepTrace }
  | { kind: 'step-container'; stepKey: string; step: ExecutionStepTrace | null; messages: Message[] };

function stepKeyOf(stepId: string, iterationPath: string): string {
  return `${stepId}#${iterationPath}`;
}

function messageStepKey(m: Message): string | null {
  if (!m.workflowExecutionId || m.workflowStepId == null) return null;
  return stepKeyOf(m.workflowStepId, m.workflowIterationPath ?? '');
}

/**
 * Build the ordered chat render plan from the merged feed.
 *
 * Workflow-attributed messages (the prompt + streamed assistant turn) are
 * grouped with their step row into one `step-container`, emitted at the
 * position of the earliest feed item bearing that step key. A step that has
 * attributed messages is an agent_prompt → container; a step without messages
 * (bash/notify/loop/…) renders as a `step` card. Plain messages accumulate
 * into `messages` runs.
 *
 * Pure + order-preserving so it can be unit-tested without React.
 */
export function buildChatRenderPlan(feed: FeedItem[]): ChatRenderItem[] {
  // Index messages and step rows by step key.
  const messagesByKey = new Map<string, Message[]>();
  const stepByKey = new Map<string, ExecutionStepTrace>();
  for (const item of feed) {
    if (item.kind === 'message') {
      const key = messageStepKey(item.message);
      if (key) {
        const list = messagesByKey.get(key);
        if (list) list.push(item.message);
        else messagesByKey.set(key, [item.message]);
      }
    } else {
      stepByKey.set(stepKeyOf(item.step.stepId, item.step.iterationPath), item.step);
    }
  }

  const out: ChatRenderItem[] = [];
  const emittedContainers = new Set<string>();
  let run: Message[] = [];
  const flushRun = () => {
    if (run.length === 0) return;
    out.push({ kind: 'messages', messages: run });
    run = [];
  };

  for (const item of feed) {
    if (item.kind === 'message') {
      const key = messageStepKey(item.message);
      if (key && messagesByKey.has(key)) {
        // Workflow-attributed message → belongs to a step container.
        flushRun();
        if (!emittedContainers.has(key)) {
          emittedContainers.add(key);
          out.push({
            kind: 'step-container',
            stepKey: key,
            step: stepByKey.get(key) ?? null,
            messages: messagesByKey.get(key)!,
          });
        }
        // else: already represented by the container emitted earlier.
      } else {
        run.push(item.message);
      }
    } else {
      const key = stepKeyOf(item.step.stepId, item.step.iterationPath);
      if (messagesByKey.has(key)) {
        // agent_prompt step — represented by its container.
        flushRun();
        if (!emittedContainers.has(key)) {
          emittedContainers.add(key);
          out.push({
            kind: 'step-container',
            stepKey: key,
            step: item.step,
            messages: messagesByKey.get(key)!,
          });
        }
      } else {
        // Non-agent step (bash/notify/loop/…) → standalone card.
        flushRun();
        out.push({ kind: 'step', step: item.step });
      }
    }
  }
  flushRun();
  return out;
}
