import { NotFoundError, ValidationError } from '@valet/shared';
import type { Env } from '../env.js';
import { checkWorkflowConcurrency, enqueueWorkflowExecution } from './executions.js';
import { dispatchOrchestratorPrompt } from './orchestrator.js';
import { sha256Hex, createWorkflowSession } from '../lib/workflow-runtime.js';
import { getDb } from '../lib/drizzle.js';
import {
  scheduleTarget,
  deriveRepoFullName,
  getTriggerForRun,
  updateTriggerLastRun,
  getWorkflowForManualRun,
  checkIdempotencyKey,
  createExecution,
  type TriggerConfig,
} from '../lib/db.js';

// ─── Manual Run ─────────────────────────────────────────────────────────────

export interface ManualRunParams {
  userId: string;
  workflowId: string;
  clientRequestId?: string;
  variables?: Record<string, unknown>;
  repoUrl?: string;
  branch?: string;
  ref?: string;
  sourceRepoFullName?: string;
}

export type ManualRunResult =
  | {
      ok: true;
      executionId: string;
      workflowId: string;
      workflowName: string;
      status: string;
      variables: Record<string, unknown>;
      sessionId: string;
      dispatched: boolean;
    }
  | { ok: false; reason: 'rate_limited'; error: string; activeUser: number; activeGlobal: number; concurrencyReason?: string }
  | { ok: false; reason: 'duplicate'; executionId: string; workflowId: string; workflowName: string; status: string; variables: Record<string, unknown>; sessionId: string };

export async function runWorkflowManually(
  env: Env,
  params: ManualRunParams,
  workerOrigin: string,
): Promise<ManualRunResult> {
  const appDb = getDb(env.DB);
  const { userId, workflowId, variables = {} } = params;
  const repoUrl = params.repoUrl?.trim() || undefined;
  const branch = params.branch?.trim() || undefined;
  const ref = params.ref?.trim() || undefined;
  const sourceRepoFullName = deriveRepoFullName(repoUrl, params.sourceRepoFullName);

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
  const existing = await checkIdempotencyKey(env.DB, workflow.id, idempotencyKey);

  if (existing) {
    return {
      ok: false,
      reason: 'duplicate',
      executionId: existing.id as string,
      workflowId: workflow.id,
      workflowName: workflow.name,
      status: existing.status as string,
      variables,
      sessionId: existing.session_id as string,
    };
  }

  const executionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const workflowHash = await sha256Hex(String(workflow.data ?? '{}'));
  const sessionId = await createWorkflowSession(appDb, {
    userId,
    workflowId: workflow.id,
    executionId,
    sourceRepoUrl: repoUrl,
    sourceRepoFullName,
    branch,
    ref,
  });

  await createExecution(env.DB, {
    id: executionId,
    workflowId: workflow.id,
    userId,
    triggerId: null,
    triggerType: 'manual',
    triggerMetadata: JSON.stringify({ triggeredBy: 'api', direct: true }),
    variables: JSON.stringify(variables),
    now,
    workflowVersion: workflow.version || null,
    workflowHash,
    workflowSnapshot: workflow.data,
    idempotencyKey,
    sessionId,
    initiatorType: 'manual',
    initiatorUserId: userId,
  });

  const dispatched = await enqueueWorkflowExecution(env, {
    executionId,
    workflowId: workflow.id,
    userId,
    sessionId,
    triggerType: 'manual',
    workerOrigin,
  });

  return {
    ok: true,
    executionId,
    workflowId: workflow.id,
    workflowName: workflow.name,
    status: 'pending',
    variables,
    sessionId,
    dispatched,
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
      sessionId: string;
      dispatched: boolean;
    }
  | { ok: true; type: 'orchestrator'; workflowId: string | null; workflowName: string | null; sessionId: string }
  | { ok: false; reason: 'rate_limited'; error: string; activeUser: number; activeGlobal: number; concurrencyReason?: string }
  | { ok: false; reason: 'duplicate'; executionId: string; workflowId: string; workflowName: string; status: string; variables: Record<string, unknown>; sessionId: string }
  | { ok: false; reason: 'orchestrator_failed'; error: string; workflowId: string | null; workflowName: string | null; sessionId: string; dispatchReason?: string };

export async function runTrigger(
  env: Env,
  triggerId: string,
  userId: string,
  body: Record<string, unknown> & {
    clientRequestId?: string;
    variables?: Record<string, unknown>;
    repoUrl?: string;
    branch?: string;
    ref?: string;
    sourceRepoFullName?: string;
  },
  workerOrigin: string,
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

    const dispatch = await dispatchOrchestratorPrompt(env, {
      userId,
      content: prompt,
    });

    const now = new Date().toISOString();
    if (dispatch.dispatched) {
      await updateTriggerLastRun(appDb, triggerId, now);
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

  // Extract variables from body using the trigger's variable mapping
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

  const variables = {
    ...extractedVariables,
    ...(body.variables || {}),
    _trigger: { type: 'manual', triggerId },
  };

  const clientRequestId = body.clientRequestId || crypto.randomUUID();
  const idempotencyKey = `manual-trigger:${triggerId}:${userId}:${clientRequestId}`;
  const existing = await checkIdempotencyKey(env.DB, row.wf_id, idempotencyKey);

  if (existing) {
    return {
      ok: false,
      reason: 'duplicate',
      executionId: existing.id as string,
      workflowId: row.wf_id as string,
      workflowName: row.workflow_name as string,
      status: existing.status as string,
      variables,
      sessionId: existing.session_id as string,
    };
  }

  const executionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const workflowHash = await sha256Hex(String(row.workflow_data ?? '{}'));
  const repoUrl = body.repoUrl?.trim() || undefined;
  const branch = body.branch?.trim() || undefined;
  const ref = body.ref?.trim() || undefined;
  const sourceRepoFullName = deriveRepoFullName(repoUrl as string | undefined, body.sourceRepoFullName as string | undefined);
  const sessionId = await createWorkflowSession(appDb, {
    userId,
    workflowId: row.wf_id,
    executionId,
    sourceRepoUrl: repoUrl as string | undefined,
    sourceRepoFullName,
    branch: branch as string | undefined,
    ref: ref as string | undefined,
  });

  await createExecution(env.DB, {
    id: executionId,
    workflowId: row.wf_id,
    userId,
    triggerId,
    triggerType: 'manual',
    triggerMetadata: JSON.stringify({ triggeredBy: 'api' }),
    variables: JSON.stringify(variables),
    now,
    workflowVersion: row.workflow_version || null,
    workflowHash,
    workflowSnapshot: row.workflow_data,
    idempotencyKey,
    sessionId,
    initiatorType: 'manual',
    initiatorUserId: userId,
  });

  const dispatched = await enqueueWorkflowExecution(env, {
    executionId,
    workflowId: row.wf_id,
    userId,
    sessionId,
    triggerType: 'manual',
    workerOrigin,
  });

  await updateTriggerLastRun(appDb, triggerId, now);

  return {
    ok: true,
    type: 'workflow',
    executionId,
    workflowId: row.wf_id,
    workflowName: row.workflow_name || '',
    status: 'pending',
    variables,
    sessionId,
    dispatched,
  };
}
