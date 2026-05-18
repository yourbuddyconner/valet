import { NotFoundError, ValidationError } from '@valet/shared';
import type { Env } from '../env.js';
import { checkWorkflowConcurrency, enqueueWorkflowExecution } from './executions.js';
import { dispatchOrchestratorPrompt } from './orchestrator.js';
import { sha256Hex, createWorkflowSession } from '../lib/workflow-runtime.js';
import { getDb } from '../lib/drizzle.js';
import {
  recordTriggerDelivery,
  findDeliveryByDeliveryId,
  type TriggerDeliveryOutcome,
} from '../lib/db/trigger-deliveries.js';
import { dispatchGitHubTriggers } from './github-triggers.js';
import { handleGenericWebhook } from './webhooks.js';
import { getGithubInstallationByLogin } from '../lib/db/github-installations.js';
import {
  scheduleTarget,
  deriveRepoFullName,
  getTriggerForRun,
  updateTriggerLastRun,
  getWorkflowForManualRun,
  checkIdempotencyKey,
  createExecution,
  isUniqueConstraintError,
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
    });

    if (dispatch.dispatched) {
      await updateTriggerLastRun(appDb, triggerId, now.toISOString());
    }

    if (!dispatch.dispatched) {
      await safeTriggerDelivery(appDb, {
        triggerId,
        userId,
        eventType: 'manual',
        outcome: 'error',
        reason: `Failed to dispatch orchestrator prompt: ${dispatch.reason || 'unknown_error'}`,
      });
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

    await safeTriggerDelivery(appDb, {
      triggerId,
      userId,
      eventType: 'manual',
      outcome: 'matched',
      reason: 'Orchestrator prompt dispatched via manual run',
    });

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
    await safeTriggerDelivery(appDb, {
      triggerId,
      userId,
      eventType: 'manual',
      outcome: 'concurrency_cap',
      reason: `${concurrency.reason ?? 'concurrency limit'} (activeUser=${concurrency.activeUser}, activeGlobal=${concurrency.activeGlobal})`,
    });
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
    const existingId = typeof existing.id === 'string' ? existing.id : null;
    await safeTriggerDelivery(appDb, {
      triggerId,
      userId,
      eventType: 'manual',
      outcome: 'duplicate',
      executionId: existingId,
      reason: `Idempotency key already exists: ${idempotencyKey}`,
    });
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

  await safeTriggerDelivery(appDb, {
    triggerId,
    userId,
    eventType: 'manual',
    outcome: 'matched',
    executionId,
    reason: dispatched ? null : 'Execution created but dispatch enqueue failed',
  });

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

// ─── Test Fire ──────────────────────────────────────────────────────────────

export type TestFireResult =
  | {
      ok: true;
      outcome: TriggerDeliveryOutcome;
      executionId: string | null;
      reason: string | null;
    }
  | { ok: false; reason: 'unsupported_type'; error: string }
  | { ok: false; reason: 'github_no_installation'; error: string };

/**
 * Send a synthetic payload through the same dispatcher path as a real
 * delivery. Used by the "Test fire" button on the trigger detail page so
 * users can validate trigger config without provoking a real upstream event.
 *
 * The result is also persisted to `trigger_deliveries` by the underlying
 * dispatcher, so the existing deliveries panel surfaces it automatically.
 */
export async function testFireTrigger(
  env: Env,
  triggerId: string,
  userId: string,
  customPayload: Record<string, unknown> | undefined,
  workerOrigin: string,
): Promise<TestFireResult> {
  const appDb = getDb(env.DB);
  const row = await getTriggerForRun(env.DB, userId, triggerId);
  if (!row) {
    throw new NotFoundError('Trigger', triggerId);
  }

  const config = JSON.parse(row.config) as TriggerConfig;

  if (config.type === 'manual') {
    return {
      ok: false,
      reason: 'unsupported_type',
      error: 'Manual triggers do not support test-fire; use the Run button.',
    };
  }

  // Synthetic delivery id namespaced so it's easy to spot in the deliveries log.
  const deliveryId = `test-${crypto.randomUUID()}`;

  if (config.type === 'github') {
    if (!Array.isArray(config.repos) || config.repos.length === 0) {
      throw new ValidationError('GitHub trigger has no repos configured');
    }

    // Pick the first configured event. Default to pull_request.opened so the
    // synthetic payload exercises both event + action matching paths.
    const firstEvent = (config.events && config.events[0]) || 'pull_request.opened';
    const [eventType, action] = firstEvent.includes('.')
      ? firstEvent.split('.', 2)
      : [firstEvent, 'opened'];

    const repoFullName = config.repos[0];
    const [owner] = repoFullName.split('/');

    // dispatchGitHubTriggers scopes candidate triggers by the installation's
    // linkedUserId. We need a real install for the trigger's first repo's
    // owner — otherwise the dispatcher silently no-ops.
    const installation = await getGithubInstallationByLogin(appDb, owner);
    if (!installation || installation.linkedUserId !== userId) {
      return {
        ok: false,
        reason: 'github_no_installation',
        error: `No GitHub App installation linked to your account for "${owner}". Install the GitHub App first.`,
      };
    }

    const payload: Record<string, unknown> = customPayload ?? {
      action: action ?? 'opened',
      repository: { full_name: repoFullName },
      pull_request: {
        number: 1,
        title: 'Test PR',
        state: 'open',
        base: { ref: 'main' },
        head: { ref: 'test-fire' },
        labels: [],
      },
      installation: { id: Number(installation.githubInstallationId) },
      sender: { login: 'valet-test-fire' },
    };

    // The dispatcher iterates over all the user's github triggers and only the
    // one matching repo+events+filters will fire. The others log "no_match" —
    // valid behavior for a real delivery too. Less invasive than refactoring
    // the dispatcher to take a single trigger. Pass testFire so the matched
    // execution records as trigger_type='test'.
    await dispatchGitHubTriggers(env, payload, eventType, deliveryId, workerOrigin, { testFire: true });

    const recorded = await findDeliveryByDeliveryId(appDb, triggerId, deliveryId);
    if (!recorded) {
      // This means dispatchGitHubTriggers short-circuited before evaluating
      // OUR trigger — probably because the installation's linkedUserId
      // doesn't actually match (we verified above, but be defensive).
      return {
        ok: true,
        outcome: 'no_match',
        executionId: null,
        reason: 'Trigger was not evaluated (no installation match for synthetic payload)',
      };
    }
    return { ok: true, outcome: recorded.outcome, executionId: recorded.executionId, reason: recorded.reason };
  }

  if (config.type === 'webhook') {
    const rawBody = JSON.stringify(customPayload ?? {});
    const method = config.method ?? 'POST';
    const result = await handleGenericWebhook(
      env,
      config.path,
      method,
      rawBody,
      // Test-fire passes `skipSecretCheck: true` (below) so handleGenericWebhook
      // doesn't reject the synthetic request when a secret is configured. The
      // dummy x-webhook-signature header is retained for parity with the real
      // webhook path's logging fields.
      { 'content-type': 'application/json', 'x-webhook-id': deliveryId, 'x-webhook-signature': 'test-fire' },
      {},
      workerOrigin,
      // testFire so the resulting execution records as trigger_type='test'.
      { skipSecretCheck: true, testFire: true },
    );
    if (!result) {
      throw new NotFoundError('Trigger', triggerId);
    }
    // The webhook dispatcher records its own delivery row. Read it back so
    // we surface the same outcome the user will see in the deliveries panel.
    const recorded = await findDeliveryByDeliveryId(appDb, triggerId, deliveryId);
    if (recorded) {
      return { ok: true, outcome: recorded.outcome, executionId: recorded.executionId, reason: recorded.reason };
    }
    // Fallback: derive from the handler's structured return.
    if (result.result.executionId) {
      return { ok: true, outcome: 'matched', executionId: result.result.executionId, reason: null };
    }
    return {
      ok: true,
      outcome: 'error',
      executionId: null,
      reason: result.result.error ?? result.result.message ?? 'Webhook handler returned no execution',
    };
  }

  // Schedule trigger: bypass cron matching and tick-bucket dedup (which exist
  // to prevent multiple isolates from double-firing a real cron tick) and
  // fire the same downstream dispatch the cron handler would.
  if (config.type === 'schedule') {
    const target = scheduleTarget(config);

    if (target === 'orchestrator') {
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
        content: `[Test fire — today is ${scheduledDate}]\n\n${prompt}`,
        forceNewThread: true,
      });

      const outcome: TriggerDeliveryOutcome = dispatch.dispatched ? 'matched' : 'error';
      const reason = dispatch.dispatched
        ? 'Orchestrator prompt dispatched via test-fire'
        : `Failed to dispatch orchestrator prompt: ${dispatch.reason ?? 'unknown_error'}`;
      try {
        await recordTriggerDelivery(appDb, {
          triggerId,
          userId,
          eventType: 'test-fire',
          deliveryId,
          outcome,
          executionId: null,
          reason,
          payloadPreview: null,
        });
      } catch (err) {
        console.error('[test-fire schedule] failed to record delivery:', err);
      }
      if (dispatch.dispatched) {
        await updateTriggerLastRun(appDb, triggerId, now.toISOString());
      }
      return { ok: true, outcome, executionId: null, reason };
    }

    // workflow-target schedule
    if (!row.wf_id || !row.workflow_data) {
      const reason = 'Linked workflow is missing or disabled';
      try {
        await recordTriggerDelivery(appDb, {
          triggerId, userId, eventType: 'test-fire', deliveryId,
          outcome: 'workflow_deleted', executionId: null, reason, payloadPreview: null,
        });
      } catch (err) {
        console.error('[test-fire schedule] failed to record delivery:', err);
      }
      return { ok: true, outcome: 'workflow_deleted', executionId: null, reason };
    }

    const concurrency = await checkWorkflowConcurrency(appDb, userId);
    if (!concurrency.allowed) {
      const reason = `${concurrency.reason ?? 'concurrency limit'} (activeUser=${concurrency.activeUser}, activeGlobal=${concurrency.activeGlobal})`;
      try {
        await recordTriggerDelivery(appDb, {
          triggerId, userId, eventType: 'test-fire', deliveryId,
          outcome: 'concurrency_cap', executionId: null, reason, payloadPreview: null,
        });
      } catch (err) {
        console.error('[test-fire schedule] failed to record delivery:', err);
      }
      return { ok: true, outcome: 'concurrency_cap', executionId: null, reason };
    }

    const executionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const workflowHash = await sha256Hex(String(row.workflow_data ?? '{}'));
    const sessionId = await createWorkflowSession(appDb, {
      userId,
      workflowId: row.wf_id,
      executionId,
    });
    const variables = {
      ...(config.variables ?? {}),
      _trigger: {
        type: 'schedule',
        triggerId,
        cron: config.cron,
        timezone: config.timezone || 'UTC',
        testFire: true,
        timestamp: now,
      },
    };
    // Synthetic idempotency key — unique per test-fire so it never collides
    // with real cron ticks. `test:` prefix matches the github/webhook test-fire
    // convention.
    const idempotencyKey = `test:${triggerId}:${deliveryId}`;
    try {
      await createExecution(env.DB, {
        id: executionId,
        workflowId: row.wf_id,
        userId,
        triggerId,
        // Test-fires record as 'test' so they don't count against concurrency
        // or appear in the default executions list.
        triggerType: 'test',
        triggerMetadata: JSON.stringify({
          cron: config.cron,
          timezone: config.timezone || 'UTC',
          testFire: true,
          originalTriggerType: 'schedule',
        }),
        variables: JSON.stringify(variables),
        now,
        workflowVersion: row.workflow_version || null,
        workflowHash,
        workflowSnapshot: row.workflow_data,
        idempotencyKey,
        sessionId,
        initiatorType: 'schedule',
        initiatorUserId: userId,
      });
    } catch (err) {
      // Race window: two test-fires with the same trigger+deliveryId could
      // collide. UUID-based deliveryId makes this near-impossible, but we
      // handle it for symmetry with the github/webhook paths.
      if (isUniqueConstraintError(err)) {
        const reason = 'concurrent duplicate';
        try {
          await recordTriggerDelivery(appDb, {
            triggerId, userId, eventType: 'test-fire', deliveryId,
            outcome: 'duplicate', executionId: null, reason, payloadPreview: null,
          });
        } catch (recordErr) {
          console.error('[test-fire schedule] failed to record delivery:', recordErr);
        }
        return { ok: true, outcome: 'duplicate', executionId: null, reason };
      }
      throw err;
    }
    const enqueued = await enqueueWorkflowExecution(env, {
      executionId,
      workflowId: row.wf_id,
      userId,
      sessionId,
      triggerType: 'test',
      workerOrigin,
    });
    await updateTriggerLastRun(appDb, triggerId, now);
    const reason = enqueued ? null : 'Execution created but dispatch enqueue failed';
    try {
      await recordTriggerDelivery(appDb, {
        triggerId, userId, eventType: 'test-fire', deliveryId,
        outcome: 'matched', executionId, reason, payloadPreview: null,
      });
    } catch (err) {
      console.error('[test-fire schedule] failed to record delivery:', err);
    }
    return { ok: true, outcome: 'matched', executionId, reason };
  }

  return {
    ok: false,
    reason: 'unsupported_type',
    error: `Unsupported trigger type for test-fire: ${(config as { type: string }).type}`,
  };
}

// Best-effort logging; never let a delivery-log write break manual runs.
async function safeTriggerDelivery(
  appDb: ReturnType<typeof getDb>,
  params: {
    triggerId: string;
    userId: string;
    eventType: string;
    outcome: 'matched' | 'no_match' | 'concurrency_cap' | 'workflow_deleted' | 'duplicate' | 'error';
    executionId?: string | null;
    reason?: string | null;
  },
): Promise<void> {
  try {
    await recordTriggerDelivery(appDb, {
      triggerId: params.triggerId,
      userId: params.userId,
      eventType: params.eventType,
      deliveryId: null,
      outcome: params.outcome,
      executionId: params.executionId ?? null,
      reason: params.reason ?? null,
      payloadPreview: null,
    });
  } catch (err) {
    console.error('[trigger run] failed to record delivery:', err);
  }
}
