/**
 * Single entry point for the three trigger paths (manual, schedule,
 * webhook) into the dag/v1 ValetWorkflowInterpreter runtime.
 *
 * Returns a normalized result so trigger callers don't reach into
 * createExecution's error class directly.
 */

import type { Env } from '../env.js';
import type { WorkflowTriggerPayload } from '@valet/shared';
import { createExecution, type CreateExecutionResult, WorkflowExecutionStartError } from './workflow-executions.js';

export interface DispatchWorkflowInput {
  workflowId: string;
  user: { id: string };
  trigger: WorkflowTriggerPayload;
  inputOverrides?: Record<string, unknown>;
  mode?: 'production' | 'test';
  /** Optional idempotency key stored on the resulting execution row so
   * retried deliveries (manual clientRequestId, webhook deliveryId,
   * schedule tick bucket) dedupe at the unique index. */
  idempotencyKey?: string;
}

export interface DispatchWorkflowResult {
  executionId: string;
  status: 'pending' | 'rejected';
  reason?: string;
}

export async function dispatchWorkflowExecution(
  env: Env,
  input: DispatchWorkflowInput,
): Promise<DispatchWorkflowResult> {
  try {
    const result: CreateExecutionResult = await createExecution(env, {
      workflowId: input.workflowId,
      user: input.user,
      trigger: input.trigger,
      ...(input.inputOverrides ? { inputOverrides: input.inputOverrides } : {}),
      ...(input.mode ? { mode: input.mode } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
    });
    return { executionId: result.executionId, status: 'pending' };
  } catch (err) {
    if (err instanceof WorkflowExecutionStartError) {
      return { executionId: '', status: 'rejected', reason: err.code };
    }
    throw err;
  }
}
