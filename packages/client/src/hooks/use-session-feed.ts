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
