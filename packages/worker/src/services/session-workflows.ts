import type { D1Database, DurableObjectNamespace } from '@cloudflare/workers-types';
import type { AppDb } from '../lib/drizzle.js';
import type { Env } from '../env.js';
import type { RunnerMessageOf } from '@valet/shared';
import { listWorkflows, upsertWorkflow, getWorkflowByIdOrSlug, getWorkflowOwnerCheck, deleteWorkflowTriggers, deleteWorkflowById, updateWorkflow, getWorkflowById } from '../lib/db/workflows.js';
import { listTriggers, getTrigger, deleteTrigger, getTriggerForRun, updateTriggerLastRun, updateTriggerFull, upsertTriggerByName } from '../lib/db/triggers.js';
import { getExecution, getExecutionWithWorkflowName, getExecutionForAuth, getExecutionSteps, getExecutionOwnerAndStatus, checkIdempotencyKey, createExecution, completeExecutionFull, upsertExecutionStep, listExecutions, buildWorkflowStepOrderMap, rankStepOrderIndex } from '../lib/db/executions.js';
import { checkWorkflowConcurrency, createWorkflowSession, dispatchOrchestratorPrompt, enqueueWorkflowExecution, sha256Hex } from '../lib/workflow-runtime.js';
import { validateWorkflowDefinition } from '../lib/workflow-definition.js';
import { deriveRepoFullName as deriveRepoFullNameHelper } from '../lib/db/triggers.js';
import { enqueueWorkflowApprovalNotificationIfMissing, markWorkflowApprovalNotificationsRead, getSession } from '../lib/db.js';

// ─── Shared Result Types ─────────────────────────────────────────────────────

export type WorkflowServiceResult =
  | { data: Record<string, unknown>; error?: undefined }
  | { error: string; data?: undefined };

// ─── Pure Helpers ────────────────────────────────────────────────────────────

export function parseJsonOrNull(raw: unknown): unknown | null {
  if (raw === null || raw === undefined) return null;
  try {
    return JSON.parse(String(raw));
  } catch {
    return null;
  }
}

export function normalizeWorkflowRow(row: Record<string, unknown>) {
  let data: Record<string, unknown> = {};
  let tags: string[] = [];
  try { data = JSON.parse(String(row.data || '{}')); } catch { /* ignore */ }
  try { tags = row.tags ? JSON.parse(String(row.tags)) : []; } catch { /* ignore */ }
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    version: row.version,
    data,
    enabled: Boolean(row.enabled),
    tags,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export function deriveRepoFullName(repoUrl?: string, sourceRepoFullName?: string): string | undefined {
  return deriveRepoFullNameHelper(repoUrl, sourceRepoFullName);
}

export function deriveWorkerOriginFromSpawnRequest(
  spawnRequest?: { doWsUrl?: string } | null,
): string | undefined {
  if (!spawnRequest) return undefined;
  try {
    const doWsUrl = typeof spawnRequest.doWsUrl === 'string' ? spawnRequest.doWsUrl.trim() : '';
    if (!doWsUrl) return undefined;
    return new URL(doWsUrl).origin;
  } catch {
    return undefined;
  }
}

export async function resolveWorkflowIdForUser(
  db: AppDb,
  userId: string,
  workflowIdOrSlug?: string | null,
): Promise<string | null> {
  const lookup = (workflowIdOrSlug || '').trim();
  if (!lookup) return null;
  const row = await getWorkflowOwnerCheck(db, userId, lookup);
  return row?.id || null;
}

function scheduleTargetFromConfig(config: Record<string, unknown>): 'workflow' | 'orchestrator' {
  if (config.type !== 'schedule') return 'workflow';
  return config.target === 'orchestrator' ? 'orchestrator' : 'workflow';
}

function requiresWorkflowForTriggerConfig(config: Record<string, unknown>): boolean {
  return config.type !== 'schedule' || scheduleTargetFromConfig(config) === 'workflow';
}

// ─── workflowList ────────────────────────────────────────────────────────────

export async function workflowList(
  db: AppDb,
  userId: string,
): Promise<WorkflowServiceResult> {
  const result = await listWorkflows(db, userId);

  const workflows = (result.results || []).map((row) => {
    let data: Record<string, unknown> = {};
    let tags: string[] = [];
    try { data = JSON.parse(String(row.data || '{}')); } catch { /* ignore */ }
    try { tags = row.tags ? JSON.parse(String(row.tags)) : []; } catch { /* ignore */ }
    return {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      version: row.version,
      data,
      enabled: Boolean(row.enabled),
      tags,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });

  return { data: { workflows } };
}

// ─── workflowSync ────────────────────────────────────────────────────────────

export async function workflowSync(
  db: AppDb,
  envDB: D1Database,
  userId: string,
  params: {
    id?: string;
    slug?: string;
    name?: string;
    description?: string;
    version?: string;
    data?: Record<string, unknown>;
  },
): Promise<WorkflowServiceResult> {
  const name = (params.name || '').trim();
  if (!name) {
    return { error: 'Workflow name is required' };
  }
  const validation = validateWorkflowDefinition(params.data);
  if (!validation.valid) {
    return { error: `Invalid workflow definition: ${validation.errors[0]}` };
  }

  const workflowId = (params.id || '').trim() || `wf_${crypto.randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const slug = (params.slug || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || null;
  const version = (params.version || '1.0.0').trim() || '1.0.0';
  const now = new Date().toISOString();

  await upsertWorkflow(db, {
    id: workflowId,
    userId,
    slug,
    name,
    description: params.description || null,
    version,
    data: JSON.stringify(params.data),
    now,
  });

  const workflow = {
    id: workflowId,
    slug,
    name,
    description: params.description || null,
    version,
    data: params.data,
    enabled: true,
    tags: [],
    createdAt: now,
    updatedAt: now,
  };

  return { data: { success: true, workflow } };
}

// ─── workflowRun ─────────────────────────────────────────────────────────────

export async function workflowRun(
  db: AppDb,
  envDB: D1Database,
  env: Env,
  userId: string,
  requestId: string,
  params: {
    workflowId: string;
    variables?: Record<string, unknown>;
    repoContext?: { repoUrl?: string; branch?: string; ref?: string; sourceRepoFullName?: string };
    spawnRequest?: { doWsUrl?: string } | null;
  },
): Promise<WorkflowServiceResult> {
  const workflowLookupId = (params.workflowId || '').trim();
  if (!workflowLookupId) {
    return { error: 'workflowId is required' };
  }

  const workflow = await getWorkflowByIdOrSlug(db, userId, workflowLookupId) as {
    id: string;
    name: string;
    version: string | null;
    data: string;
  } | null;

  if (!workflow) {
    return { error: `Workflow not found: ${workflowLookupId}` };
  }

  const concurrency = await checkWorkflowConcurrency(db, userId);
  if (!concurrency.allowed) {
    return { error: `Too many concurrent executions (${concurrency.reason})` };
  }

  const idempotencyKey = `agent:${workflow.id}:${userId}:${requestId}`;
  const existing = await checkIdempotencyKey(envDB, workflow.id, idempotencyKey) as {
    id: string;
    status: string;
    session_id: string | null;
  } | null;

  if (existing) {
    return {
      data: {
        execution: {
          executionId: existing.id,
          workflowId: workflow.id,
          workflowName: workflow.name,
          status: existing.status,
          sessionId: existing.session_id,
          deduplicated: true,
        },
      },
    };
  }

  const executionId = crypto.randomUUID();
  const now = new Date().toISOString();
  const workflowHash = await sha256Hex(String(workflow.data || '{}'));
  const repoUrl = params.repoContext?.repoUrl?.trim() || undefined;
  const branch = params.repoContext?.branch?.trim() || undefined;
  const ref = params.repoContext?.ref?.trim() || undefined;
  const workerOrigin = deriveWorkerOriginFromSpawnRequest(params.spawnRequest);
  const sourceRepoFullName = deriveRepoFullName(repoUrl, params.repoContext?.sourceRepoFullName);
  const sessionId = await createWorkflowSession(db, {
    userId,
    workflowId: workflow.id,
    executionId,
    sourceRepoUrl: repoUrl,
    sourceRepoFullName,
    branch,
    ref,
  });

  await createExecution(envDB, {
    id: executionId,
    workflowId: workflow.id,
    userId,
    triggerId: null,
    triggerType: 'manual',
    triggerMetadata: JSON.stringify({ triggeredBy: 'agent_tool', direct: true }),
    variables: JSON.stringify(params.variables || {}),
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
    data: {
      execution: {
        executionId,
        workflowId: workflow.id,
        workflowName: workflow.name,
        status: 'pending',
        sessionId,
        dispatched,
      },
    },
  };
}

// ─── workflowExecutions ──────────────────────────────────────────────────────

export async function workflowExecutions(
  db: AppDb,
  envDB: D1Database,
  userId: string,
  workflowId?: string,
  limit?: number,
): Promise<WorkflowServiceResult> {
  const max = Math.min(Math.max(limit || 20, 1), 200);

  let workflowFilterId: string | null = null;
  if (workflowId) {
    const workflow = await getWorkflowOwnerCheck(db, userId, workflowId);
    if (!workflow) {
      return { data: { executions: [] } };
    }
    workflowFilterId = workflow.id;
  }

  const result = await listExecutions(envDB, userId, {
    workflowId: workflowFilterId || undefined,
    limit: max,
  });

  const executions = (result.results || []).map((row) => ({
    id: row.id,
    workflowId: row.workflow_id,
    triggerId: row.trigger_id,
    status: row.status,
    triggerType: row.trigger_type,
    triggerMetadata: parseJsonOrNull(row.trigger_metadata),
    variables: parseJsonOrNull(row.variables),
    outputs: parseJsonOrNull(row.outputs),
    steps: parseJsonOrNull(row.steps),
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
    sessionId: row.session_id,
  }));

  return { data: { executions } };
}

// ─── handleWorkflowAction ────────────────────────────────────────────────────

export async function handleWorkflowAction(
  db: AppDb,
  envDB: D1Database,
  userId: string,
  action: string,
  payload?: Record<string, unknown>,
): Promise<WorkflowServiceResult> {
  const workflowIdOrSlug = typeof payload?.workflowId === 'string' ? payload.workflowId.trim() : '';
  if (!workflowIdOrSlug) {
    return { error: 'workflowId is required' };
  }

  const existing = await getWorkflowByIdOrSlug(db, userId, workflowIdOrSlug) as Record<string, unknown> | null;

  if (!existing) {
    return { error: `Workflow not found: ${workflowIdOrSlug}` };
  }

  if (action === 'get') {
    return { data: { workflow: normalizeWorkflowRow(existing) } };
  }

  if (action === 'delete') {
    await deleteWorkflowTriggers(db, existing.id as string, userId);
    await deleteWorkflowById(db, existing.id as string, userId);
    return { data: { success: true } };
  }

  if (action !== 'update') {
    return { error: `Unsupported workflow action: ${action}` };
  }

  const updates: string[] = [];
  const values: unknown[] = [];

  if (payload && Object.prototype.hasOwnProperty.call(payload, 'name')) {
    const nextName = typeof payload.name === 'string' ? payload.name : '';
    if (!nextName.trim()) {
      return { error: 'name must be a non-empty string' };
    }
    updates.push('name = ?');
    values.push(nextName.trim());
  }
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'description')) {
    const nextDescription = payload.description;
    if (nextDescription !== null && typeof nextDescription !== 'string') {
      return { error: 'description must be a string or null' };
    }
    updates.push('description = ?');
    values.push(nextDescription === null ? null : nextDescription);
  }
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'slug')) {
    const nextSlug = payload.slug;
    if (nextSlug !== null && typeof nextSlug !== 'string') {
      return { error: 'slug must be a string or null' };
    }
    updates.push('slug = ?');
    values.push(nextSlug === null ? null : nextSlug);
  }
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'version')) {
    const nextVersion = payload.version;
    if (typeof nextVersion !== 'string' || !nextVersion.trim()) {
      return { error: 'version must be a non-empty string' };
    }
    updates.push('version = ?');
    values.push(nextVersion.trim());
  }
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'enabled')) {
    const nextEnabled = payload.enabled;
    if (typeof nextEnabled !== 'boolean') {
      return { error: 'enabled must be a boolean' };
    }
    updates.push('enabled = ?');
    values.push(nextEnabled ? 1 : 0);
  }
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'tags')) {
    const nextTags = payload.tags;
    if (!Array.isArray(nextTags) || nextTags.some((tag) => typeof tag !== 'string')) {
      return { error: 'tags must be an array of strings' };
    }
    updates.push('tags = ?');
    values.push(JSON.stringify(nextTags));
  }
  if (payload && Object.prototype.hasOwnProperty.call(payload, 'data')) {
    const nextData = payload.data;
    if (!nextData || typeof nextData !== 'object' || Array.isArray(nextData)) {
      return { error: 'data must be an object' };
    }
    const validation = validateWorkflowDefinition(nextData);
    if (!validation.valid) {
      return { error: `Invalid workflow definition: ${validation.errors[0]}` };
    }
    updates.push('data = ?');
    values.push(JSON.stringify(nextData));
  }

  if (updates.length === 0) {
    return { data: { workflow: normalizeWorkflowRow(existing) } };
  }

  const updatedAt = new Date().toISOString();
  updates.push('updated_at = ?');
  values.push(updatedAt);
  values.push(existing.id);

  await updateWorkflow(envDB, existing.id as string, updates, values);
  const updated = await getWorkflowById(db, existing.id as string) as Record<string, unknown> | null;

  return { data: { workflow: normalizeWorkflowRow(updated || existing) } };
}

// ─── handleTriggerAction ─────────────────────────────────────────────────────

export async function handleTriggerAction(
  db: AppDb,
  envDB: D1Database,
  env: Env,
  userId: string,
  sessionId: string,
  action: string,
  payload?: Record<string, unknown>,
): Promise<WorkflowServiceResult> {
  if (action === 'list') {
    const result = await listTriggers(envDB, userId);

    const workflowFilter = typeof payload?.workflowId === 'string' ? payload.workflowId : undefined;
    const typeFilter = typeof payload?.type === 'string' ? payload.type : undefined;
    const enabledFilter = typeof payload?.enabled === 'boolean' ? payload.enabled : undefined;

    let triggers = (result.results || []).map((row) => ({
      id: row.id,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name,
      name: row.name,
      enabled: Boolean(row.enabled),
      type: row.type,
      config: parseJsonOrNull(row.config) || {},
      variableMapping: parseJsonOrNull(row.variable_mapping) || null,
      lastRunAt: row.last_run_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }));

    if (workflowFilter) {
      triggers = triggers.filter((trigger) => trigger.workflowId === workflowFilter || trigger.workflowName === workflowFilter);
    }
    if (typeFilter) {
      triggers = triggers.filter((trigger) => trigger.type === typeFilter);
    }
    if (enabledFilter !== undefined) {
      triggers = triggers.filter((trigger) => trigger.enabled === enabledFilter);
    }

    return { data: { triggers } };
  }

  if (action === 'delete') {
    const triggerId = typeof payload?.triggerId === 'string' ? payload.triggerId.trim() : '';
    if (!triggerId) {
      return { error: 'triggerId is required' };
    }
    const result = await deleteTrigger(db, triggerId, userId);
    if ((result.meta?.changes || 0) === 0) {
      return { error: `Trigger not found: ${triggerId}` };
    }
    return { data: { success: true } };
  }

  if (action === 'sync' || action === 'create') {
    // Idempotent upsert by (userId, name). "create" is an alias for "sync"
    // for backward compatibility with tool versions already in sandboxes.
    // Sync is full-state: the agent always sends all fields. workflowId defaults
    // to null if not provided (no inheritance from existing row).
    const rawConfig = payload?.config && typeof payload.config === 'object' && !Array.isArray(payload.config)
      ? payload.config as Record<string, unknown>
      : null;
    if (!rawConfig || typeof rawConfig.type !== 'string') {
      return { error: 'config with type is required' };
    }

    const nextName = (typeof payload?.name === 'string' ? payload.name : '').trim();
    if (!nextName) {
      return { error: 'name is required' };
    }

    let workflowId: string | null = null;
    if (typeof payload?.workflowId === 'string' && payload.workflowId.trim()) {
      workflowId = await resolveWorkflowIdForUser(db, userId, payload.workflowId);
      if (!workflowId) {
        return { error: `Workflow not found: ${payload.workflowId}` };
      }
    } else if (payload?.workflowId === null) {
      workflowId = null;
    }

    const target = scheduleTargetFromConfig(rawConfig);
    if (rawConfig.type === 'schedule' && target === 'orchestrator') {
      const prompt = typeof rawConfig.prompt === 'string' ? rawConfig.prompt.trim() : '';
      if (!prompt) {
        return { error: 'schedule prompt is required when target=orchestrator' };
      }
    }

    if (requiresWorkflowForTriggerConfig(rawConfig) && !workflowId) {
      return { error: 'workflowId is required for this trigger type' };
    }

    const nextEnabled = typeof payload?.enabled === 'boolean' ? payload.enabled : true;

    const variableMapping = payload?.variableMapping && typeof payload.variableMapping === 'object' && !Array.isArray(payload.variableMapping)
      ? payload.variableMapping as Record<string, unknown>
      : undefined;

    if (variableMapping) {
      for (const [key, value] of Object.entries(variableMapping)) {
        if (typeof value !== 'string') {
          return { error: `variableMapping.${key} must be a string` };
        }
      }
    }

    const now = new Date().toISOString();
    const { triggerId: targetTriggerId } = await upsertTriggerByName(db, envDB, userId, {
      name: nextName,
      type: String(rawConfig.type),
      config: JSON.stringify(rawConfig),
      enabled: nextEnabled,
      workflowId,
      variableMapping: variableMapping ? JSON.stringify(variableMapping) : null,
      now,
    });

    const row = await getTrigger(envDB, userId, targetTriggerId) as Record<string, unknown> | null;

    return {
      data: {
        trigger: row
          ? {
              id: row.id,
              workflowId: row.workflow_id,
              workflowName: row.workflow_name,
              name: row.name,
              enabled: Boolean(row.enabled),
              type: row.type,
              config: parseJsonOrNull(row.config) || {},
              variableMapping: parseJsonOrNull(row.variable_mapping) || null,
              lastRunAt: row.last_run_at,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            }
          : null,
        success: true,
      },
    };
  }

  if (action === 'update') {
    const triggerId = typeof payload?.triggerId === 'string' ? payload.triggerId.trim() : '';
    if (!triggerId) {
      return { error: 'triggerId is required for update' };
    }

    const existing = await getTrigger(envDB, userId, triggerId) as Record<string, unknown> | null;
    if (!existing) {
      return { error: `Trigger not found: ${triggerId}` };
    }

    const rawConfig = payload?.config && typeof payload.config === 'object' && !Array.isArray(payload.config)
      ? payload.config as Record<string, unknown>
      : (parseJsonOrNull(existing.config) as Record<string, unknown> | null);
    if (!rawConfig || typeof rawConfig.type !== 'string') {
      return { error: 'config with type is required' };
    }

    const nextName = (typeof payload?.name === 'string' ? payload.name : (typeof existing.name === 'string' ? existing.name : '')).trim();
    if (!nextName) {
      return { error: 'name is required' };
    }

    let workflowId: string | null = null;
    if (Object.prototype.hasOwnProperty.call(payload || {}, 'workflowId')) {
      if (typeof payload?.workflowId === 'string' && payload.workflowId.trim()) {
        workflowId = await resolveWorkflowIdForUser(db, userId, payload.workflowId);
        if (!workflowId) {
          return { error: `Workflow not found: ${payload.workflowId}` };
        }
      } else if (payload?.workflowId === null) {
        workflowId = null;
      }
    } else {
      workflowId = typeof existing.workflow_id === 'string' && existing.workflow_id.trim()
        ? existing.workflow_id
        : null;
    }

    const target = scheduleTargetFromConfig(rawConfig);
    if (rawConfig.type === 'schedule' && target === 'orchestrator') {
      const prompt = typeof rawConfig.prompt === 'string' ? rawConfig.prompt.trim() : '';
      if (!prompt) {
        return { error: 'schedule prompt is required when target=orchestrator' };
      }
    }

    if (requiresWorkflowForTriggerConfig(rawConfig) && !workflowId) {
      return { error: 'workflowId is required for this trigger type' };
    }

    const nextEnabled = typeof payload?.enabled === 'boolean'
      ? payload.enabled
      : Boolean(existing.enabled);

    const variableMapping = payload?.variableMapping && typeof payload.variableMapping === 'object' && !Array.isArray(payload.variableMapping)
      ? payload.variableMapping as Record<string, unknown>
      : existing.variable_mapping
        ? (parseJsonOrNull(existing.variable_mapping) as Record<string, unknown> | null)
        : undefined;

    if (variableMapping) {
      for (const [key, value] of Object.entries(variableMapping)) {
        if (typeof value !== 'string') {
          return { error: `variableMapping.${key} must be a string` };
        }
      }
    }

    const now = new Date().toISOString();
    await updateTriggerFull(db, triggerId, userId, {
      workflowId,
      name: nextName,
      enabled: nextEnabled,
      type: String(rawConfig.type),
      config: JSON.stringify(rawConfig),
      variableMapping: variableMapping ? JSON.stringify(variableMapping) : null,
      now,
    });

    const row = await getTrigger(envDB, userId, triggerId) as Record<string, unknown> | null;

    return {
      data: {
        trigger: row
          ? {
              id: row.id,
              workflowId: row.workflow_id,
              workflowName: row.workflow_name,
              name: row.name,
              enabled: Boolean(row.enabled),
              type: row.type,
              config: parseJsonOrNull(row.config) || {},
              variableMapping: parseJsonOrNull(row.variable_mapping) || null,
              lastRunAt: row.last_run_at,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            }
          : null,
        success: true,
      },
    };
  }

  if (action === 'run') {
    const triggerId = typeof payload?.triggerId === 'string' ? payload.triggerId.trim() : '';
    if (!triggerId) {
      return { error: 'triggerId is required' };
    }

    const row = await getTriggerForRun(envDB, userId, triggerId);

    if (!row) {
      return { error: `Trigger not found: ${triggerId}` };
    }

    const config = parseJsonOrNull(row.config) as Record<string, unknown> | null;
    if (!config) {
      return { error: 'Invalid trigger config' };
    }
    const target = scheduleTargetFromConfig(config);

    if (config.type === 'schedule' && target === 'orchestrator') {
      const prompt = typeof config.prompt === 'string' ? config.prompt.trim() : '';
      if (!prompt) {
        return { error: 'Schedule orchestrator trigger requires prompt' };
      }

      const dispatch = await dispatchOrchestratorPrompt(env, {
        userId,
        content: prompt,
        forceNewThread: true,
        threadOrigin: {
          originType: 'automation',
          originTriggerId: triggerId,
          originTriggerType: config.type,
        },
      });
      const now = new Date().toISOString();
      if (dispatch.dispatched) {
        await updateTriggerLastRun(db, triggerId, now);
      }
      return {
        data: dispatch.dispatched
          ? {
              status: 'queued',
              workflowId: row.wf_id,
              workflowName: row.workflow_name,
              sessionId: dispatch.sessionId,
              message: 'Orchestrator prompt dispatched.',
            }
          : {
              status: 'failed',
              workflowId: row.wf_id,
              workflowName: row.workflow_name,
              sessionId: dispatch.sessionId,
              reason: dispatch.reason || 'unknown_error',
            },
      };
    }

    if (!row.wf_id || !row.workflow_data) {
      return { error: 'Trigger is not linked to a workflow' };
    }

    const concurrency = await checkWorkflowConcurrency(db, userId);
    if (!concurrency.allowed) {
      return { error: `Too many concurrent workflow executions (${concurrency.reason})` };
    }

    const variableMapping = row.variable_mapping ? (parseJsonOrNull(row.variable_mapping) as Record<string, string> | null) : null;
    const extractedVariables: Record<string, unknown> = {};
    for (const [varName, path] of Object.entries(variableMapping || {})) {
      if (!path.startsWith('$.')) continue;
      const key = path.slice(2).split('.')[0];
      if (payload && Object.prototype.hasOwnProperty.call(payload, key)) {
        extractedVariables[varName] = payload[key];
      }
    }

    const runtimeVariables = (payload?.variables && typeof payload.variables === 'object' && !Array.isArray(payload.variables))
      ? payload.variables as Record<string, unknown>
      : {};
    const variables = {
      ...extractedVariables,
      ...runtimeVariables,
      _trigger: { type: 'manual', triggerId },
    };

    const requestId = typeof payload?.requestId === 'string' ? payload.requestId : crypto.randomUUID();
    const idempotencyKey = `manual-trigger:${triggerId}:${userId}:${requestId}`;
    const existingExecution = await checkIdempotencyKey(envDB, row.wf_id!, idempotencyKey) as {
      id: string;
      status: string;
      session_id: string | null;
    } | null;

    if (existingExecution) {
      return {
        data: {
          executionId: existingExecution.id,
          workflowId: row.wf_id,
          workflowName: row.workflow_name,
          status: existingExecution.status,
          variables,
          sessionId: existingExecution.session_id,
          message: 'Workflow execution already exists for this request.',
        },
      };
    }

    const executionId = crypto.randomUUID();
    const now = new Date().toISOString();
    const workflowHash = await sha256Hex(String(row.workflow_data ?? '{}'));
    const repoUrl = typeof payload?.repoUrl === 'string' ? payload.repoUrl.trim() || undefined : undefined;
    const branch = typeof payload?.branch === 'string' ? payload.branch.trim() || undefined : undefined;
    const ref = typeof payload?.ref === 'string' ? payload.ref.trim() || undefined : undefined;
    const spawnRequest = typeof payload?._spawnRequest === 'object' ? payload._spawnRequest as { doWsUrl?: string } | null : null;
    const workerOrigin = deriveWorkerOriginFromSpawnRequest(spawnRequest);
    const sourceRepoFullName = deriveRepoFullName(
      repoUrl,
      typeof payload?.sourceRepoFullName === 'string' ? payload.sourceRepoFullName : undefined,
    );
    const newSessionId = await createWorkflowSession(db, {
      userId,
      workflowId: row.wf_id,
      executionId,
      sourceRepoUrl: repoUrl,
      sourceRepoFullName,
      branch,
      ref,
    });

    await createExecution(envDB, {
      id: executionId,
      workflowId: row.wf_id!,
      userId,
      triggerId,
      triggerType: 'manual',
      triggerMetadata: JSON.stringify({ triggeredBy: 'api' }),
      variables: JSON.stringify(variables),
      now,
      workflowVersion: row.workflow_version || null,
      workflowHash,
      workflowSnapshot: row.workflow_data!,
      idempotencyKey,
      sessionId: newSessionId,
      initiatorType: 'manual',
      initiatorUserId: userId,
    });

    await updateTriggerLastRun(db, triggerId, now);

    const dispatched = await enqueueWorkflowExecution(env, {
      executionId,
      workflowId: row.wf_id,
      userId,
      sessionId: newSessionId,
      triggerType: 'manual',
      workerOrigin,
    });

    return {
      data: {
        executionId,
        workflowId: row.wf_id,
        workflowName: row.workflow_name,
        status: 'pending',
        variables,
        sessionId: newSessionId,
        dispatched,
        message: dispatched
          ? 'Trigger run accepted and dispatched.'
          : 'Trigger run accepted but dispatch failed.',
      },
    };
  }

  return { error: `Unsupported trigger action: ${action}` };
}

// ─── handleExecutionAction ───────────────────────────────────────────────────

export async function handleExecutionAction(
  db: AppDb,
  envDB: D1Database,
  env: Env,
  userId: string,
  action: string,
  payload?: Record<string, unknown>,
): Promise<WorkflowServiceResult> {
  const executionId = typeof payload?.executionId === 'string' ? payload.executionId.trim() : '';
  if (!executionId) {
    return { error: 'executionId is required' };
  }

  if (action === 'get') {
    const row = await getExecution(envDB, executionId, userId);

    if (!row) {
      return { error: `Execution not found: ${executionId}` };
    }

    return {
      data: {
        execution: {
          id: row.id,
          workflowId: row.workflow_id,
          workflowName: row.workflow_name,
          sessionId: row.session_id,
          triggerId: row.trigger_id,
          triggerName: row.trigger_name,
          status: row.status,
          triggerType: row.trigger_type,
          triggerMetadata: parseJsonOrNull(row.trigger_metadata),
          variables: parseJsonOrNull(row.variables),
          resumeToken: row.resume_token || null,
          outputs: parseJsonOrNull(row.outputs),
          steps: parseJsonOrNull(row.steps),
          error: row.error,
          startedAt: row.started_at,
          completedAt: row.completed_at,
        },
      },
    };
  }

  if (action === 'steps') {
    const execution = await getExecutionForAuth(db, executionId);

    if (!execution || execution.user_id !== userId) {
      return { error: `Execution not found: ${executionId}` };
    }

    const workflowStepOrder = buildWorkflowStepOrderMap(execution.workflow_snapshot);

    const result = await getExecutionSteps(envDB, executionId);

    const steps = (result.results || [])
      .map((row) => ({
        id: row.id,
        executionId: row.execution_id,
        stepId: String(row.step_id),
        attempt: Number(row.attempt || 1),
        status: String(row.status),
        input: parseJsonOrNull((row.input_json as string | null) || null),
        output: parseJsonOrNull((row.output_json as string | null) || null),
        error: (row.error as string | null) || null,
        startedAt: (row.started_at as string | null) || null,
        completedAt: (row.completed_at as string | null) || null,
        createdAt: String(row.created_at),
        workflowStepIndex: workflowStepOrder.get(String(row.step_id)) ?? null,
        insertionOrder: Number(row.insertion_order || 0),
      }))
      .sort((left, right) => {
        if (left.attempt !== right.attempt) return left.attempt - right.attempt;
        const leftIndex = rankStepOrderIndex(left.workflowStepIndex);
        const rightIndex = rankStepOrderIndex(right.workflowStepIndex);
        if (leftIndex !== rightIndex) return leftIndex - rightIndex;
        if (left.insertionOrder !== right.insertionOrder) return left.insertionOrder - right.insertionOrder;
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

    return { data: { steps } };
  }

  if (action === 'approve') {
    const approve = payload?.approve === true;
    const resumeToken = typeof payload?.resumeToken === 'string' ? payload.resumeToken : '';
    const reason = typeof payload?.reason === 'string' ? payload.reason : undefined;
    if (!resumeToken) {
      return { error: 'resumeToken is required' };
    }

    const execution = await getExecutionOwnerAndStatus(db, executionId) as { user_id: string; status: string } | null;
    if (!execution || execution.user_id !== userId) {
      return { error: `Execution not found: ${executionId}` };
    }

    const doId = env.WORKFLOW_EXECUTOR.idFromName(executionId);
    const stub = env.WORKFLOW_EXECUTOR.get(doId);
    const response = await stub.fetch(new Request('https://workflow-executor/resume', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        executionId,
        resumeToken,
        approve,
        reason,
      }),
    }));

    if (!response.ok) {
      const errorBody = await response.json<{ error?: string }>().catch((): { error?: string } => ({ error: undefined }));
      return { error: errorBody.error || `Failed to apply approval decision (${response.status})` };
    }

    const result = await response.json<{ ok: boolean; status: string }>();
    return { data: { success: true, status: result.status } };
  }

  if (action === 'cancel') {
    const reason = typeof payload?.reason === 'string' ? payload.reason : undefined;
    const execution = await getExecutionOwnerAndStatus(db, executionId) as { user_id: string; status: string } | null;
    if (!execution || execution.user_id !== userId) {
      return { error: `Execution not found: ${executionId}` };
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
      const errorBody = await response.json<{ error?: string }>().catch((): { error?: string } => ({ error: undefined }));
      return { error: errorBody.error || `Failed to cancel execution (${response.status})` };
    }

    const result = await response.json<{ ok: boolean; status: string }>();
    return { data: { success: true, status: result.status } };
  }

  return { error: `Unsupported execution action: ${action}` };
}

// ─── processWorkflowExecutionResult ──────────────────────────────────────────

export interface WorkflowExecutionResultData {
  executionId: string;
  nextStatus: 'completed' | 'failed' | 'cancelled' | 'waiting_approval';
  execution: { user_id: string; session_id: string | null; workflow_name: string | null };
  approvalPrompt?: string;
  shouldStopSession: boolean;
}

export async function processWorkflowExecutionResult(
  db: AppDb,
  envDB: D1Database,
  msg: RunnerMessageOf<'workflow-execution-result'>,
  currentSessionId: string | null,
): Promise<WorkflowExecutionResultData | null> {
  const { executionId, envelope } = msg;
  if (!executionId || !envelope) {
    console.error('[session-workflows] Invalid workflow execution result payload');
    return null;
  }

  const execution = await getExecutionWithWorkflowName(envDB, executionId);

  if (!execution) {
    console.warn(`[session-workflows] Received workflow result for unknown execution ${executionId}`);
    return null;
  }

  if (execution.session_id && currentSessionId && execution.session_id !== currentSessionId) {
    console.warn(
      `[session-workflows] Ignoring workflow result for ${executionId}: execution bound to ${execution.session_id}, this DO is ${currentSessionId}`,
    );
    return null;
  }

  const outputsJson = envelope.output ? JSON.stringify(envelope.output) : null;
  const stepsJson = envelope.steps ? JSON.stringify(envelope.steps) : null;

  let nextStatus: 'completed' | 'failed' | 'cancelled' | 'waiting_approval' = 'failed';
  let error: string | null = envelope.error || null;
  let resumeToken: string | null = null;
  let completedAt: string | null = new Date().toISOString();

  if (envelope.status === 'ok') {
    nextStatus = 'completed';
    error = null;
  } else if (envelope.status === 'failed') {
    nextStatus = 'failed';
    error = envelope.error || 'workflow_failed';
  } else if (envelope.status === 'cancelled') {
    nextStatus = 'cancelled';
    error = envelope.error || 'workflow_cancelled';
  } else if (envelope.status === 'needs_approval') {
    resumeToken = envelope.requiresApproval?.resumeToken || null;
    if (!resumeToken) {
      nextStatus = 'failed';
      error = 'approval_resume_token_missing';
    } else {
      nextStatus = 'waiting_approval';
      error = null;
      completedAt = null;
    }
  }

  await completeExecutionFull(db, executionId, {
    status: nextStatus,
    outputs: outputsJson,
    steps: stepsJson,
    error,
    resumeToken,
    completedAt,
  });

  if (Array.isArray(envelope.steps) && envelope.steps.length > 0) {
    for (const step of envelope.steps) {
      const attempt = step.attempt && step.attempt > 0 ? step.attempt : 1;
      await upsertExecutionStep(envDB, executionId, {
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

  if (nextStatus === 'waiting_approval') {
    try {
      const requiresApproval = envelope.requiresApproval as Record<string, unknown> | undefined;
      await enqueueWorkflowApprovalNotificationIfMissing(envDB, {
        toUserId: execution.user_id,
        executionId,
        fromSessionId: execution.session_id || currentSessionId || undefined,
        contextSessionId: execution.session_id || currentSessionId || undefined,
        workflowName: execution.workflow_name,
        approvalPrompt: requiresApproval?.prompt as string | undefined,
      });
    } catch (notifyError) {
      console.error('[session-workflows] Failed to enqueue workflow approval notification:', notifyError);
    }
  } else {
    try {
      await markWorkflowApprovalNotificationsRead(db, execution.user_id, executionId);
    } catch (notifyError) {
      console.error('[session-workflows] Failed to clear workflow approval notifications:', notifyError);
    }
  }

  let shouldStopSession = false;
  if (nextStatus !== 'waiting_approval' && currentSessionId) {
    const sessionRow = await getSession(db, currentSessionId);
    if (sessionRow?.purpose === 'workflow') {
      shouldStopSession = true;
    }
  }

  return {
    executionId,
    nextStatus,
    execution: {
      user_id: execution.user_id,
      session_id: execution.session_id,
      workflow_name: execution.workflow_name,
    },
    approvalPrompt: (envelope.requiresApproval as Record<string, unknown> | undefined)?.prompt as string | undefined,
    shouldStopSession,
  };
}

// ─── buildWorkflowDispatch ───────────────────────────────────────────────────

export interface WorkflowDispatchValidation {
  error: string;
  status: number;
}

export interface WorkflowDispatchReady {
  executionId: string;
  payload: import('../durable-objects/runner-link.js').WorkflowExecutionDispatchPayload;
}

export type WorkflowDispatchResult =
  | { ready: WorkflowDispatchReady; error?: undefined }
  | { error: WorkflowDispatchValidation; ready?: undefined };

export function buildWorkflowDispatch(
  executionIdRaw?: string,
  payload?: import('../durable-objects/runner-link.js').WorkflowExecutionDispatchPayload,
): WorkflowDispatchResult {
  const executionId = (executionIdRaw || '').trim();
  if (!executionId) {
    return { error: { error: 'executionId is required', status: 400 } };
  }
  if (!payload || typeof payload !== 'object') {
    return { error: { error: 'payload is required', status: 400 } };
  }
  if (payload.kind !== 'run' && payload.kind !== 'resume') {
    return { error: { error: 'payload.kind must be run or resume', status: 400 } };
  }
  if (typeof payload.executionId !== 'string' || payload.executionId !== executionId) {
    return { error: { error: 'payload.executionId must match executionId', status: 400 } };
  }
  if (!payload.payload || typeof payload.payload !== 'object' || Array.isArray(payload.payload)) {
    return { error: { error: 'payload.payload must be an object', status: 400 } };
  }

  return { ready: { executionId, payload } };
}
