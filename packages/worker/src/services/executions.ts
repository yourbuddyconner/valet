import { NotFoundError, UnauthorizedError, ValidationError } from '@valet/shared';
import type { Env } from '../env.js';
import { countActiveExecutions, countActiveExecutionsGlobal } from '../lib/db/executions.js';
import type { AppDb } from '../lib/drizzle.js';
import { getDb } from '../lib/drizzle.js';
import {
  markWorkflowApprovalNotificationsRead,
  getExecutionOwnerAndStatus,
  getExecutionForAuth,
  getExecutionSteps,
  buildWorkflowStepOrderMap,
  rankStepOrderIndex,
  parseNullableJson,
  completeExecution as dbCompleteExecution,
  upsertExecutionStep,
  updateExecutionStatus as dbUpdateExecutionStatus,
} from '../lib/db.js';

// ─── Constants ──────────────────────────────────────────────────────────────

const ENQUEUE_MAX_ATTEMPTS = 5;
const ENQUEUE_BASE_DELAY_MS = 150;

function shouldRetryEnqueueStatus(status: number): boolean {
  return (
    status === 404 || // D1 read-after-write race across colo
    status === 408 ||
    status === 409 ||
    status === 425 ||
    status === 429 ||
    status === 500 ||
    status === 502 ||
    status === 503 ||
    status === 504
  );
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

type EnqueueResponseBody = {
  ok?: boolean;
  promptDispatched?: boolean;
  status?: string;
  ignored?: boolean;
  reason?: string;
  error?: string;
};

// ─── Workflow Concurrency ───────────────────────────────────────────────────

export async function checkWorkflowConcurrency(
  database: AppDb,
  userId: string,
  limits: { perUser?: number; global?: number } = {},
): Promise<{ allowed: boolean; reason?: string; activeUser: number; activeGlobal: number }> {
  const perUserLimit = limits.perUser ?? 5;
  const globalLimit = limits.global ?? 50;

  const activeUser = await countActiveExecutions(database, userId);
  const activeGlobal = await countActiveExecutionsGlobal(database);

  if (activeUser >= perUserLimit) {
    return {
      allowed: false,
      reason: `per_user_limit_exceeded:${perUserLimit}`,
      activeUser,
      activeGlobal,
    };
  }

  if (activeGlobal >= globalLimit) {
    return {
      allowed: false,
      reason: `global_limit_exceeded:${globalLimit}`,
      activeUser,
      activeGlobal,
    };
  }

  return { allowed: true, activeUser, activeGlobal };
}

// ─── Enqueue Workflow Execution ─────────────────────────────────────────────

export async function enqueueWorkflowExecution(
  env: Env,
  params: {
    executionId: string;
    workflowId: string;
    userId: string;
    sessionId?: string;
    triggerType: 'manual' | 'webhook' | 'schedule';
    workerOrigin?: string;
  }
): Promise<boolean> {
  const doId = env.WORKFLOW_EXECUTOR.idFromName(params.executionId);
  const stub = env.WORKFLOW_EXECUTOR.get(doId);

  for (let attempt = 1; attempt <= ENQUEUE_MAX_ATTEMPTS; attempt += 1) {
    try {
      const response = await stub.fetch(new Request('https://workflow-executor/enqueue', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(params),
      }));

      if (response.ok) {
        let body: EnqueueResponseBody | null = null;
        try {
          body = await response.clone().json<EnqueueResponseBody>();
        } catch {
          body = null;
        }

        // Defensive: explicit non-dispatch should not be treated as success for fresh runs.
        if (body?.promptDispatched === false && !body.ignored) {
          const shouldRetry = attempt < ENQUEUE_MAX_ATTEMPTS;
          if (!shouldRetry) {
            console.error(
              `[WorkflowRuntime] Enqueue returned promptDispatched=false for ${params.executionId} ` +
              `after ${attempt} attempt(s): ${body.error || '<no error>'}`
            );
            return false;
          }
          const waitMs = ENQUEUE_BASE_DELAY_MS * attempt;
          console.warn(
            `[WorkflowRuntime] Enqueue response not dispatched for ${params.executionId} ` +
            `(attempt ${attempt}/${ENQUEUE_MAX_ATTEMPTS}, status=${body.status || 'unknown'}). ` +
            `Retrying in ${waitMs}ms`
          );
          await delay(waitMs);
          continue;
        }

        return true;
      }

      const errText = (await response.text().catch(() => '')).slice(0, 500);
      const shouldRetry = attempt < ENQUEUE_MAX_ATTEMPTS && shouldRetryEnqueueStatus(response.status);
      if (!shouldRetry) {
        console.error(
          `[WorkflowRuntime] Failed to enqueue execution ${params.executionId} ` +
          `after ${attempt} attempt(s): status=${response.status} body=${errText || '<empty>'}`
        );
        return false;
      }

      const waitMs = ENQUEUE_BASE_DELAY_MS * attempt;
      console.warn(
        `[WorkflowRuntime] Enqueue attempt ${attempt}/${ENQUEUE_MAX_ATTEMPTS} failed for ${params.executionId} ` +
        `(status=${response.status}). Retrying in ${waitMs}ms`
      );
      await delay(waitMs);
    } catch (error) {
      if (attempt >= ENQUEUE_MAX_ATTEMPTS) {
        console.error(`[WorkflowRuntime] Failed to enqueue execution ${params.executionId}`, error);
        return false;
      }
      const waitMs = ENQUEUE_BASE_DELAY_MS * attempt;
      console.warn(
        `[WorkflowRuntime] Enqueue attempt ${attempt}/${ENQUEUE_MAX_ATTEMPTS} errored for ${params.executionId}. ` +
        `Retrying in ${waitMs}ms`,
        error
      );
      await delay(waitMs);
    }
  }

  return false;
}

// ─── Execution Completion ───────────────────────────────────────────────────

export interface CompleteExecutionParams {
  status: 'completed' | 'failed' | 'cancelled';
  outputs?: Record<string, unknown>;
  steps?: Array<{
    stepId: string;
    status: string;
    attempt?: number;
    input?: unknown;
    output?: unknown;
    error?: string;
    startedAt?: string;
    completedAt?: string;
  }>;
  error?: string;
  completedAt?: string;
}

export async function completeExecution(
  env: Env,
  executionId: string,
  userId: string,
  params: CompleteExecutionParams,
): Promise<{ status: string; completedAt: string }> {
  const database = getDb(env.DB);
  const execution = await getExecutionOwnerAndStatus(database, executionId);

  if (!execution) {
    throw new NotFoundError('Execution', executionId);
  }

  if (execution.user_id !== userId) {
    throw new UnauthorizedError('Unauthorized to update this execution');
  }

  if (execution.status === 'completed' || execution.status === 'failed' || execution.status === 'cancelled') {
    throw new ValidationError('Execution already finalized');
  }

  const completedAt = params.completedAt || new Date().toISOString();

  await dbCompleteExecution(database, executionId, {
    status: params.status,
    outputs: params.outputs ? JSON.stringify(params.outputs) : null,
    steps: params.steps ? JSON.stringify(params.steps) : null,
    error: params.error || null,
    completedAt,
  });

  if (params.steps?.length) {
    for (const step of params.steps) {
      const attempt = step.attempt ?? 1;
      await upsertExecutionStep(env.DB, executionId, {
        stepId: step.stepId,
        attempt,
        status: step.status,
        input: step.input !== undefined ? JSON.stringify(step.input) : null,
        output: step.output !== undefined ? JSON.stringify(step.output) : null,
        error: step.error || null,
        startedAt: step.startedAt || null,
        completedAt: step.completedAt || null,
      });
    }
  }

  return { status: params.status, completedAt };
}

// ─── Approval Handling ──────────────────────────────────────────────────────

export interface HandleApprovalParams {
  approve: boolean;
  resumeToken: string;
  reason?: string;
}

export async function handleApproval(
  env: Env,
  executionId: string,
  userId: string,
  params: HandleApprovalParams,
): Promise<{ status: string }> {
  const db = getDb(env.DB);
  const execution = await getExecutionOwnerAndStatus(db, executionId) as { user_id: string; status: string } | null;

  if (!execution) {
    throw new NotFoundError('Execution', executionId);
  }
  if (execution.user_id !== userId) {
    throw new UnauthorizedError('Unauthorized to update this execution');
  }

  const doId = env.WORKFLOW_EXECUTOR.idFromName(executionId);
  const stub = env.WORKFLOW_EXECUTOR.get(doId);
  const response = await stub.fetch(new Request('https://workflow-executor/resume', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      executionId,
      resumeToken: params.resumeToken,
      approve: params.approve,
      reason: params.reason,
    }),
  }));

  if (!response.ok) {
    const errorBody = await response
      .json<{ error?: string }>()
      .catch((): { error?: string } => ({ error: undefined }));
    throw new ValidationError(errorBody.error || 'Failed to apply approval decision');
  }

  const result = await response.json<{ ok: boolean; status: string }>();
  await markWorkflowApprovalNotificationsRead(db, userId, executionId);
  return { status: result.status };
}

// ─── Cancel Execution ───────────────────────────────────────────────────────

export async function cancelExecution(
  env: Env,
  executionId: string,
  userId: string,
  reason?: string,
): Promise<{ status: string }> {
  const db = getDb(env.DB);
  const execution = await getExecutionOwnerAndStatus(db, executionId) as { user_id: string; status: string } | null;

  if (!execution) {
    throw new NotFoundError('Execution', executionId);
  }
  if (execution.user_id !== userId) {
    throw new UnauthorizedError('Unauthorized to update this execution');
  }

  const doId = env.WORKFLOW_EXECUTOR.idFromName(executionId);
  const stub = env.WORKFLOW_EXECUTOR.get(doId);
  const response = await stub.fetch(new Request('https://workflow-executor/cancel', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      executionId,
      reason,
    }),
  }));

  if (!response.ok) {
    const errorBody = await response
      .json<{ error?: string }>()
      .catch((): { error?: string } => ({ error: undefined }));
    throw new ValidationError(errorBody.error || 'Failed to cancel execution');
  }

  const result = await response.json<{ ok: boolean; status: string }>();
  return { status: result.status };
}

// ─── Get Execution Steps With Order ─────────────────────────────────────────

export interface ExecutionStepView {
  id: string;
  executionId: string;
  stepId: string;
  attempt: number;
  status: string;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
  workflowStepIndex: number | null;
  sequence: number;
}

export async function getExecutionStepsWithOrder(
  env: Env,
  executionId: string,
  userId: string,
): Promise<ExecutionStepView[]> {
  const database = getDb(env.DB);
  const execution = await getExecutionForAuth(database, executionId);

  if (!execution) {
    throw new NotFoundError('Execution', executionId);
  }
  if (execution.user_id !== userId) {
    throw new UnauthorizedError('Unauthorized to access this execution');
  }

  const workflowStepOrder = buildWorkflowStepOrderMap(execution.workflow_snapshot);
  const result = await getExecutionSteps(env.DB, executionId);

  return result.results
    .map((row) => ({
      id: row.id as string,
      executionId: row.execution_id as string,
      stepId: String(row.step_id),
      attempt: Number(row.attempt || 1),
      status: String(row.status),
      input: parseNullableJson((row.input_json as string | null) || null),
      output: parseNullableJson((row.output_json as string | null) || null),
      error: (row.error as string | null) || null,
      startedAt: (row.started_at as string | null) || null,
      completedAt: (row.completed_at as string | null) || null,
      createdAt: String(row.created_at),
      workflowStepIndex: workflowStepOrder.get(String(row.step_id)) ?? null,
      insertionOrder: Number(row.insertion_order || 0),
    }))
    .sort((left, right) => {
      if (left.attempt !== right.attempt) {
        return left.attempt - right.attempt;
      }
      const leftIndex = rankStepOrderIndex(left.workflowStepIndex);
      const rightIndex = rankStepOrderIndex(right.workflowStepIndex);
      if (leftIndex !== rightIndex) {
        return leftIndex - rightIndex;
      }
      if (left.insertionOrder !== right.insertionOrder) {
        return left.insertionOrder - right.insertionOrder;
      }
      return left.stepId.localeCompare(right.stepId);
    })
    .map((step, sequence) => ({
      id: step.id,
      executionId: step.executionId,
      stepId: step.stepId,
      attempt: step.attempt,
      status: step.status,
      input: step.input,
      output: step.output,
      error: step.error,
      startedAt: step.startedAt,
      completedAt: step.completedAt,
      createdAt: step.createdAt,
      workflowStepIndex: step.workflowStepIndex,
      sequence,
    }));
}

// ─── Update Execution Status (with validation) ─────────────────────────────

export async function updateExecutionStatusChecked(
  database: AppDb,
  executionId: string,
  userId: string,
  status: string,
): Promise<void> {
  if (!['pending', 'running', 'waiting_approval'].includes(status)) {
    throw new ValidationError('Invalid status');
  }

  const execution = await getExecutionOwnerAndStatus(database, executionId);
  if (!execution) {
    throw new NotFoundError('Execution', executionId);
  }
  if (execution.user_id !== userId) {
    throw new UnauthorizedError('Unauthorized to update this execution');
  }
  if (execution.status === 'completed' || execution.status === 'failed' || execution.status === 'cancelled') {
    throw new ValidationError('Execution already finalized');
  }

  await dbUpdateExecutionStatus(database, executionId, status);
}
