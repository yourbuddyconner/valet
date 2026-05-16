import { useQueryClient } from '@tanstack/react-query';
import { useWebSocket } from '@/hooks/use-websocket';
import { getWebSocketUrl } from '@/api/client';
import {
  executionKeys,
  type ExecutionStepTrace,
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
): void {
  const qc = useQueryClient();
  const wsUrl = sessionId
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
        (prev) => mergeStepEvent(prev, parsed.event, executionId),
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
  executionId: string,
): GetExecutionStepsResponse {
  const steps = prev?.steps ?? [];
  const idx = steps.findIndex(
    (s) => s.stepId === ev.stepId && s.attempt === ev.attempt,
  );
  const existing = idx >= 0 ? steps[idx] : undefined;
  const isTerminal =
    ev.kind === 'step.completed' ||
    ev.kind === 'step.failed' ||
    ev.kind === 'step.skipped' ||
    ev.kind === 'step.cancelled';

  const updated: ExecutionStepTrace = {
    id: existing?.id ?? crypto.randomUUID(),
    executionId: existing?.executionId ?? executionId,
    stepId: ev.stepId,
    attempt: ev.attempt,
    status: mapKindToStatus(ev.kind),
    input: ev.input !== undefined ? ev.input : (existing?.input ?? null),
    output: ev.output !== undefined ? ev.output : (existing?.output ?? null),
    error: ev.error ?? existing?.error ?? null,
    startedAt:
      ev.kind === 'step.started' ? ev.timestamp : (existing?.startedAt ?? null),
    completedAt: isTerminal ? ev.timestamp : (existing?.completedAt ?? null),
    createdAt: existing?.createdAt ?? ev.timestamp,
    workflowStepIndex: existing?.workflowStepIndex ?? null,
    sequence: existing?.sequence ?? steps.length,
  };

  const next = [...steps];
  if (idx >= 0) next[idx] = updated;
  else next.push(updated);
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
