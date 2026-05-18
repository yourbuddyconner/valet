import { useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from '@/hooks/use-websocket';
import { getWebSocketUrl } from '@/api/client';
import {
  executionKeys,
  type Execution,
  type GetExecutionStepsResponse,
} from '@/api/executions';

interface StepEventMessage {
  type: 'workflow.execution.step';
  executionId: string;
  event: {
    kind:
      | 'step.started'
      | 'step.completed'
      | 'step.failed'
      | 'step.skipped'
      | 'step.cancelled'
      | 'approval.required'
      | 'approval.approved'
      | 'approval.denied';
    stepId: string;
    attempt: number;
    timestamp: string;
    input?: unknown;
    output?: unknown;
    error?: string;
  };
}

/**
 * Subscribes to the session's client WebSocket and patches step state into the
 * React Query cache for executionKeys.steps(executionId) as events arrive.
 */
export function useExecutionStepEvents(
  sessionId: string | null | undefined,
  executionId: string | null | undefined,
  executionStatus?: Execution['status'],
): void {
  const qc = useQueryClient();
  // Terminal executions can't produce new step events, so don't bother opening
  // the WS. This also avoids late-arriving events clobbering the final state
  // shown on completed/failed/cancelled execution pages.
  const isTerminal =
    executionStatus === 'completed' ||
    executionStatus === 'failed' ||
    executionStatus === 'cancelled';
  const wsUrl =
    sessionId && executionId && !isTerminal
      ? getWebSocketUrl(`/api/sessions/${sessionId}/ws?role=client`)
      : null;

  useWebSocket(wsUrl, {
    onMessage: (msg) => {
      if (!executionId) return;
      const parsed = parseStepEventMessage(msg);
      if (!parsed) return;
      if (parsed.executionId !== executionId) return;
      qc.setQueryData<GetExecutionStepsResponse | undefined>(
        executionKeys.steps(executionId),
        (prev) => mergeStepEvent(prev, parsed.event),
      );
    },
  });
}

const STEP_EVENT_KINDS = new Set<StepEventMessage['event']['kind']>([
  'step.started',
  'step.completed',
  'step.failed',
  'step.skipped',
  'step.cancelled',
  'approval.required',
  'approval.approved',
  'approval.denied',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/**
 * Runtime-validates a WebSocketMessage as a StepEventMessage. Returns null if
 * the shape doesn't match. Avoids type assertions by constructing the typed
 * object after narrowing each field.
 */
function parseStepEventMessage(
  msg: Record<string, unknown>,
): StepEventMessage | null {
  if (msg.type !== 'workflow.execution.step') return null;
  if (typeof msg.executionId !== 'string') return null;
  if (!isRecord(msg.event)) return null;
  const ev = msg.event;
  if (typeof ev.kind !== 'string') return null;
  const kind = ev.kind as StepEventMessage['event']['kind'];
  if (!STEP_EVENT_KINDS.has(kind)) return null;
  if (typeof ev.stepId !== 'string') return null;
  if (typeof ev.attempt !== 'number') return null;
  if (typeof ev.timestamp !== 'string') return null;
  const error = typeof ev.error === 'string' ? ev.error : undefined;
  return {
    type: 'workflow.execution.step',
    executionId: msg.executionId,
    event: {
      kind,
      stepId: ev.stepId,
      attempt: ev.attempt,
      timestamp: ev.timestamp,
      input: ev.input,
      output: ev.output,
      error,
    },
  };
}

function mergeStepEvent(
  prev: GetExecutionStepsResponse | undefined,
  ev: StepEventMessage['event'],
): GetExecutionStepsResponse {
  const steps = prev?.steps ?? [];
  const idx = steps.findIndex(
    (s) => s.stepId === ev.stepId && s.attempt === ev.attempt,
  );
  if (idx < 0) {
    // The server doesn't have a row for this (stepId, attempt) yet. We could
    // fabricate an optimistic row, but the 2.5s useExecutionSteps poll would
    // overwrite our optimistic data anyway — and any events that arrive while
    // the poll is in flight would be silently dropped. Instead, wait for the
    // server to acknowledge the step. Trade-off: a step event arriving before
    // the server has persisted the row is delayed up to one poll cycle
    // (~2.5s). Acceptable for the simpler, more predictable state.
    return prev ?? { steps: [] };
  }

  const existing = steps[idx];
  const isTerminal =
    ev.kind === 'step.completed' ||
    ev.kind === 'step.failed' ||
    ev.kind === 'step.skipped' ||
    ev.kind === 'step.cancelled';

  const updated = {
    ...existing,
    status: mapKindToStatus(ev.kind),
    input: ev.input !== undefined ? ev.input : existing.input,
    output: ev.output !== undefined ? ev.output : existing.output,
    error: ev.error ?? existing.error,
    startedAt: ev.kind === 'step.started' ? ev.timestamp : existing.startedAt,
    completedAt: isTerminal ? ev.timestamp : existing.completedAt,
  };

  const next = [...steps];
  next[idx] = updated;
  return { steps: next };
}

function mapKindToStatus(kind: StepEventMessage['event']['kind']): string {
  switch (kind) {
    case 'step.started':
      return 'running';
    case 'step.completed':
      return 'completed';
    case 'step.failed':
      return 'failed';
    case 'step.skipped':
      return 'skipped';
    case 'step.cancelled':
      return 'cancelled';
    case 'approval.required':
      return 'waiting_approval';
    case 'approval.approved':
    case 'approval.denied':
      return 'completed';
  }
}
