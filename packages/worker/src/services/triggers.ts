import { NotFoundError, ValidationError } from '@valet/shared';
import type { Env } from '../env.js';
import { checkWorkflowConcurrency } from './executions.js';
import { dispatchWorkflowExecution } from './workflow-dispatch.js';
import { dispatchOrchestratorPrompt } from './orchestrator.js';
import { getDb } from '../lib/drizzle.js';
import {
  scheduleTarget,
  getTriggerForRun,
  updateTriggerLastRunUnchecked,
  getWorkflowForManualRun,
  checkIdempotencyKey,
  type TriggerConfig,
} from '../lib/db.js';

// ─── Manual Run ─────────────────────────────────────────────────────────────

export interface ManualRunParams {
  userId: string;
  workflowId: string;
  clientRequestId?: string;
  variables?: Record<string, unknown>;
}

export type ManualRunResult =
  | {
      ok: true;
      executionId: string;
      workflowId: string;
      workflowName: string;
      status: string;
      variables: Record<string, unknown>;
      dispatched: boolean;
    }
  | { ok: false; reason: 'rate_limited'; error: string; activeUser: number; activeGlobal: number; concurrencyReason?: string }
  | { ok: false; reason: 'duplicate'; executionId: string; workflowId: string; workflowName: string; status: string; variables: Record<string, unknown> };

export async function runWorkflowManually(
  env: Env,
  params: ManualRunParams,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _workerOrigin?: string,
): Promise<ManualRunResult> {
  const appDb = getDb(env.DB);
  const { userId, workflowId, variables = {} } = params;

  const workflow = await getWorkflowForManualRun(env.DB, userId, workflowId);
  if (!workflow) {
    throw new NotFoundError('Workflow', workflowId);
  }

  const concurrency = await checkWorkflowConcurrency(appDb, userId);
  if (!concurrency.allowed) {
    return {
      ok: false,
      reason: 'rate_limited',
      error: 'Too many concurrent workflow executions',
      concurrencyReason: concurrency.reason,
      activeUser: concurrency.activeUser,
      activeGlobal: concurrency.activeGlobal,
    };
  }

  const clientRequestId = params.clientRequestId || crypto.randomUUID();
  const idempotencyKey = `manual:${workflow.id}:${userId}:${clientRequestId}`;
  const existing = await checkIdempotencyKey(env.DB, workflow.id, userId, idempotencyKey);
  if (existing) {
    return {
      ok: false,
      reason: 'duplicate',
      executionId: existing.id as string,
      workflowId: workflow.id,
      workflowName: workflow.name,
      status: existing.status as string,
      variables,
    };
  }

  const result = await dispatchWorkflowExecution(env, {
    workflowId: workflow.id,
    user: { id: userId },
    trigger: {
      type: 'manual',
      timestamp: new Date().toISOString(),
      // trigger.data is the manual-run envelope — exposed to templates
      // as {{trigger.data.X}}. For manual API runs there's no separate
      // envelope vs. inputs (unlike webhooks), so the same variables
      // populate BOTH the envelope and `inputOverrides`. Without the
      // overrides mirror, declared workflow inputs would fail
      // validation because createExecution no longer treats trigger.data
      // as an inputs source.
      data: variables,
      metadata: { triggeredBy: 'api', direct: true, clientRequestId },
    },
    ...(Object.keys(variables).length > 0 ? { inputOverrides: variables } : {}),
    idempotencyKey,
  });
  if (result.status === 'rejected') {
    // rate_limited surfaces back to the route as HTTP 429 via the
    // existing ManualRunResult discriminator.
    if (result.reason === 'rate_limited') {
      return {
        ok: false,
        reason: 'rate_limited',
        error: 'Too many concurrent workflow executions',
        activeUser: concurrency.activeUser,
        activeGlobal: concurrency.activeGlobal,
      };
    }
    throw new ValidationError(`workflow start failed: ${result.reason ?? 'unknown'}`);
  }
  return {
    ok: true,
    executionId: result.executionId,
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: 'pending',
    variables,
    dispatched: true,
  };
}

// ─── Run Trigger ────────────────────────────────────────────────────────────

export type TriggerRunResult =
  | {
      ok: true;
      type: 'workflow';
      executionId: string;
      workflowId: string;
      workflowName: string;
      status: string;
      variables: Record<string, unknown>;
      dispatched: boolean;
    }
  // Orchestrator-target variants carry the orchestrator's session id —
  // a real session running the dispatched prompt, populated by
  // dispatchOrchestratorPrompt.
  | { ok: true; type: 'orchestrator'; workflowId: string | null; workflowName: string | null; sessionId: string }
  | { ok: false; reason: 'rate_limited'; error: string; activeUser: number; activeGlobal: number; concurrencyReason?: string }
  | { ok: false; reason: 'duplicate'; executionId: string; workflowId: string; workflowName: string; status: string; variables: Record<string, unknown> }
  | { ok: false; reason: 'orchestrator_failed'; error: string; workflowId: string | null; workflowName: string | null; sessionId: string; dispatchReason?: string };

export async function runTrigger(
  env: Env,
  triggerId: string,
  userId: string,
  body: Record<string, unknown> & {
    clientRequestId?: string;
    variables?: Record<string, unknown>;
  },
  // workerOrigin survives from the runner-driven dispatch path so the
  // existing trigger-run callers and tests stay aligned. Workflow
  // dispatch now goes through env.WORKFLOW_INTERPRETER.create and
  // doesn't need the worker URL; we accept the param without using it.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _workerOrigin?: string,
): Promise<TriggerRunResult> {
  const appDb = getDb(env.DB);
  const row = await getTriggerForRun(env.DB, userId, triggerId);
  if (!row) {
    throw new NotFoundError('Trigger', triggerId);
  }

  const config = JSON.parse(row.config) as TriggerConfig;
  const isOrchestratorSchedule = config.type === 'schedule' && scheduleTarget(config) === 'orchestrator';

  if (isOrchestratorSchedule) {
    const prompt = config.prompt?.trim();
    if (!prompt) {
      throw new ValidationError('Schedule triggers targeting orchestrator require a prompt');
    }

    const now = new Date();
    const timezone = config.timezone || 'UTC';
    let scheduledDate: string;
    try {
      scheduledDate = new Intl.DateTimeFormat('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: timezone,
      }).format(now);
    } catch {
      scheduledDate = new Intl.DateTimeFormat('en-US', {
        weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC',
      }).format(now);
    }
    const dispatch = await dispatchOrchestratorPrompt(env, {
      userId,
      content: `[Today is ${scheduledDate}]\n\n${prompt}`,
      forceNewThread: true,
      threadOrigin: {
        originType: 'automation',
        originTriggerId: triggerId,
        originTriggerType: config.type,
      },
    });

    if (dispatch.dispatched) {
      await updateTriggerLastRunUnchecked(appDb, triggerId, now.toISOString());
    }

    if (!dispatch.dispatched) {
      return {
        ok: false,
        reason: 'orchestrator_failed',
        error: `Failed to dispatch orchestrator prompt: ${dispatch.reason || 'unknown_error'}`,
        workflowId: row.wf_id,
        workflowName: row.workflow_name,
        sessionId: dispatch.sessionId,
        dispatchReason: dispatch.reason || 'unknown_error',
      };
    }

    return {
      ok: true,
      type: 'orchestrator',
      workflowId: row.wf_id,
      workflowName: row.workflow_name,
      sessionId: dispatch.sessionId,
    };
  }

  if (!row.wf_id || !row.workflow_data) {
    throw new ValidationError('Trigger is not linked to a workflow');
  }

  const concurrency = await checkWorkflowConcurrency(appDb, userId);
  if (!concurrency.allowed) {
    return {
      ok: false,
      reason: 'rate_limited',
      error: 'Too many concurrent workflow executions',
      concurrencyReason: concurrency.reason,
      activeUser: concurrency.activeUser,
      activeGlobal: concurrency.activeGlobal,
    };
  }

  // Extract variables from body using the trigger's variable mapping.
  const variableMapping = row.variable_mapping
    ? JSON.parse(row.variable_mapping as string)
    : {};

  const extractedVariables: Record<string, unknown> = {};
  for (const [varName, path] of Object.entries(variableMapping)) {
    const pathStr = path as string;
    if (pathStr.startsWith('$.')) {
      const key = pathStr.slice(2).split('.')[0];
      if (body[key] !== undefined) {
        extractedVariables[varName] = body[key];
      }
    }
  }

  // Variables map only carries trigger-provided + extracted-mapped
  // values; framework provenance (triggerId, type, dedupe key) belongs
  // in WorkflowTriggerPayload.metadata, not in user-visible data.
  const variables = {
    ...extractedVariables,
    ...(body.variables || {}),
  };

  const clientRequestId = body.clientRequestId || crypto.randomUUID();
  const idempotencyKey = `manual-trigger:${triggerId}:${userId}:${clientRequestId}`;
  const existing = await checkIdempotencyKey(env.DB, row.wf_id, userId, idempotencyKey);

  if (existing) {
    return {
      ok: false,
      reason: 'duplicate',
      executionId: existing.id as string,
      workflowId: row.wf_id as string,
      workflowName: row.workflow_name as string,
      status: existing.status as string,
      variables,
    };
  }

  const result = await dispatchWorkflowExecution(env, {
    workflowId: row.wf_id as string,
    user: { id: userId },
    trigger: {
      type: 'manual',
      triggerId,
      timestamp: new Date().toISOString(),
      // See runWorkflowManually above for the trigger.data vs.
      // inputOverrides reasoning. Manual trigger API calls reuse the
      // same shape: variables populate both the envelope and the
      // declared inputs.
      data: variables,
      metadata: { triggeredBy: 'api', clientRequestId },
    },
    ...(Object.keys(variables).length > 0 ? { inputOverrides: variables } : {}),
    idempotencyKey,
  });
  if (result.status === 'rejected') {
    if (result.reason === 'rate_limited') {
      return {
        ok: false,
        reason: 'rate_limited',
        error: 'Too many concurrent workflow executions',
        activeUser: concurrency.activeUser,
        activeGlobal: concurrency.activeGlobal,
      };
    }
    throw new ValidationError(`workflow start failed: ${result.reason ?? 'unknown'}`);
  }
  await updateTriggerLastRunUnchecked(appDb, triggerId, new Date().toISOString());
  return {
    ok: true,
    type: 'workflow',
    executionId: result.executionId,
    workflowId: row.wf_id as string,
    workflowName: row.workflow_name as string,
    status: 'pending',
    variables,
    dispatched: true,
  };
}
