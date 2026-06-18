import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { NotFoundError } from '@valet/shared';
import type { Env, Variables } from '../env.js';
import {
  listWorkflows,
  getWorkflowByIdOrSlug,
  listWorkflowExecutions,
  parseExecutionInputs,
} from '../lib/db.js';
import * as workflowService from '../services/workflows.js';

export const workflowsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// Validation schemas
const syncWorkflowSchema = z.object({
  id: z.string().min(1),
  slug: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  version: z.string().default('1.0.0'),
  data: z.record(z.unknown()),
});

const syncAllWorkflowsSchema = z.object({
  workflows: z.array(syncWorkflowSchema),
});

const updateWorkflowSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().nullable().optional(),
  slug: z.string().nullable().optional(),
  version: z.string().optional(),
  enabled: z.boolean().optional(),
  tags: z.array(z.string()).optional(),
  data: z.record(z.unknown()).optional(),
});

const createWorkflowSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).nullable().optional(),
  slug: z.string().min(1).max(120).nullable().optional(),
});

/**
 * GET /api/workflows
 * List user's workflows
 */
workflowsRouter.get('/', async (c) => {
  const user = c.get('user');

  const result = await listWorkflows(c.get('db'), user.id);

  // Mirror the detail endpoint: prefer the published version's
  // definition over workflows.data so list and detail agree once a
  // workflow has been published. workflows.data is the /sync write
  // surface and goes stale after publish.
  const { getPublishedDefinitions } = await import('../services/workflow-versions.js');
  const publishedMap = await getPublishedDefinitions(
    c.get('db'),
    result.results.map((row) => row.id),
  );

  const workflows = result.results.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    version: row.version,
    data: publishedMap.get(row.id) ?? JSON.parse(row.data as string),
    enabled: Boolean(row.enabled),
    tags: row.tags ? JSON.parse(row.tags as string) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedVersionId: row.published_version_id,
  }));

  return c.json({ workflows });
});

/**
 * POST /api/workflows
 * Create a user-authored workflow with an initial dag/v1 draft.
 */
workflowsRouter.post('/', zValidator('json', createWorkflowSchema), async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  const result = await workflowService.createWorkflow(c.get('db'), user.id, body);
  return c.json(result, 201);
});

/**
 * GET /api/workflows/:id
 * Get a single workflow by ID or slug
 */
workflowsRouter.get('/:id', async (c) => {
  const { id: idOrSlug } = c.req.param();
  const user = c.get('user');

  // Route through assertWorkflowAccess so post-MVP role splits land
  // here without a follow-up. The helper resolves slug→id; we then
  // re-fetch the full row.
  const { assertWorkflowAccess } = await import('../lib/workflow-access.js');
  const { id } = await assertWorkflowAccess(c.get('db'), user, idOrSlug, 'viewer');

  const row = await getWorkflowByIdOrSlug(c.get('db'), user.id, id);
  if (!row) throw new NotFoundError('Workflow', idOrSlug);

  // Prefer the published version's definition over workflows.data —
  // workflows.data is the /sync write surface and publishDraft does
  // not mirror published versions back into it, so reading from
  // workflow_definition_versions keeps the response aligned with what
  // triggers run. Falls back to data for not-yet-published rows.
  const { getPublishedDefinition } = await import('../services/workflow-versions.js');
  const publishedDef = await getPublishedDefinition(c.get('db'), row.id);
  const data = publishedDef ?? JSON.parse(row.data as string);

  return c.json({
    workflow: {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      version: row.version,
      data,
      enabled: Boolean(row.enabled),
      tags: row.tags ? JSON.parse(row.tags as string) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      publishedVersionId: row.published_version_id,
    },
  });
});

/**
 * POST /api/workflows/sync
 * Sync a single workflow from the plugin to cloud storage
 */
workflowsRouter.post('/sync', zValidator('json', syncWorkflowSchema), async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  const result = await workflowService.syncWorkflow(c.get('db'), user.id, body);
  return c.json({ success: true, id: result.id });
});

/**
 * POST /api/workflows/sync-all
 * Sync all workflows from the plugin (called on plugin startup)
 */
workflowsRouter.post('/sync-all', zValidator('json', syncAllWorkflowsSchema), async (c) => {
  const user = c.get('user');
  const { workflows } = c.req.valid('json');

  const result = await workflowService.syncAllWorkflows(c.get('db'), user.id, workflows);
  return c.json({ success: true, synced: result.synced });
});

/**
 * PUT /api/workflows/:id
 * Update a workflow
 */
workflowsRouter.put('/:id', zValidator('json', updateWorkflowSchema), async (c) => {
  const { id: idOrSlug } = c.req.param();
  const user = c.get('user');
  const body = c.req.valid('json');

  const { assertWorkflowAccess } = await import('../lib/workflow-access.js');
  const { id } = await assertWorkflowAccess(c.get('db'), user, idOrSlug, 'editor');

  const result = await workflowService.updateWorkflow(c.env, user.id, id, body);
  return c.json(result);
});

/**
 * DELETE /api/workflows/:id
 * Delete a workflow
 */
workflowsRouter.delete('/:id', async (c) => {
  const { id: idOrSlug } = c.req.param();
  const user = c.get('user');

  const { assertWorkflowAccess } = await import('../lib/workflow-access.js');
  const { id } = await assertWorkflowAccess(c.get('db'), user, idOrSlug, 'editor');

  await workflowService.deleteWorkflow(c.get('db'), user.id, id);
  return c.json({ success: true });
});

/**
 * GET /api/workflows/:id/executions
 * Get execution history for a workflow
 */
workflowsRouter.get('/:id/executions', async (c) => {
  const { id: idOrSlug } = c.req.param();
  const user = c.get('user');
  const { limit, offset } = c.req.query();

  const { assertWorkflowAccess } = await import('../lib/workflow-access.js');
  const { id: workflowId } = await assertWorkflowAccess(c.get('db'), user, idOrSlug, 'viewer');

  const result = await listWorkflowExecutions(c.env.DB, workflowId, user.id, {
    limit: parseInt(limit || '50'),
    offset: parseInt(offset || '0'),
  });

  const executions = result.results.map((row) => {
    const inputs = parseExecutionInputs(row as { inputs?: string | null });
    return {
      id: row.id,
      workflowId: row.workflow_id,
      triggerId: row.trigger_id,
      status: row.status,
      triggerType: row.trigger_type,
      triggerMetadata: row.trigger_metadata ? JSON.parse(row.trigger_metadata as string) : null,
      inputs,
      outputs: row.outputs ? JSON.parse(row.outputs as string) : null,
      error: row.error,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    };
  });

  return c.json({ executions });
});

// ─── Approve / deny a pending workflow approval ────────────────────────────

const approvalDecisionSchema = z.object({
  reason: z.string().optional(),
});

workflowsRouter.post(
  '/:id/executions/:executionId/approvals/:approvalId/approve',
  zValidator('json', approvalDecisionSchema),
  async (c) => {
    return runResolveApprovalRoute(c, 'approved');
  },
);

workflowsRouter.post(
  '/:id/executions/:executionId/approvals/:approvalId/deny',
  zValidator('json', approvalDecisionSchema),
  async (c) => {
    return runResolveApprovalRoute(c, 'denied');
  },
);

async function runResolveApprovalRoute(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  result: 'approved' | 'denied',
) {
  const { id: workflowIdOrSlug, executionId, approvalId } = c.req.param();
  const user = c.get('user');
  const body = c.req.valid('json') as { reason?: string };

  // Resolve slug→id so the shared helper can verify ownership against
  // the canonical workflow id from the execution row.
  const { assertWorkflowAccess } = await import('../lib/workflow-access.js');
  const { id: workflowId } = await assertWorkflowAccess(c.get('db'), user, workflowIdOrSlug, 'editor');

  const { resolveWorkflowApprovalRequest } = await import('../services/workflow-approvals.js');
  const outcome = await resolveWorkflowApprovalRequest({
    env: c.env,
    user,
    approvalId,
    executionId,
    expectedWorkflowId: workflowId,
    result,
    ...(body.reason !== undefined ? { reason: body.reason } : {}),
  });

  if (outcome.kind === 'expired') {
    return c.json({ status: 'expired', timedOut: true }, 409);
  }
  if (outcome.kind === 'already_resolved') {
    return c.json({ status: outcome.status, alreadyResolved: true });
  }
  return c.json({ status: outcome.status });
}

// ─── Cancel a running workflow execution ───────────────────────────────────

workflowsRouter.post('/:id/executions/:executionId/cancel', async (c) => {
  const { id: idOrSlug, executionId } = c.req.param();
  const user = c.get('user');

  // Resolve slug→id before passing to cancelExecution. The cross-tenant
  // guard inside cancelExecution compares execution.workflowId (always
  // canonical) against expectedWorkflowId — if we passed the URL param
  // (a slug for slug-routed callers), the comparison always misses and
  // returns 404 for any legitimate slug-addressed cancel.
  const { assertWorkflowAccess } = await import('../lib/workflow-access.js');
  const { id: workflowId } = await assertWorkflowAccess(c.get('db'), user, idOrSlug, 'editor');

  const { cancelExecution } = await import('../workflows/cancel-cleanup.js');
  const result = await cancelExecution(c.env, {
    executionId,
    cancelledBy: user.id,
    expectedWorkflowId: workflowId,
  });
  if (result.status === 'not_found') {
    throw new NotFoundError('WorkflowExecution', executionId);
  }
  return c.json({ status: result.status });
});

// ─── dag/v1 draft + published-version endpoints ────────────────────────────

const draftPutSchema = z.object({
  draft: z.record(z.unknown()),
  ui: z.unknown().optional(),
});

const publishSchema = z.object({
  publishNote: z.string().min(1).max(500).optional(),
});

const testRunSchema = z.object({
  /**
   * Per spec: a draft test-run takes both
   *   - a sample trigger payload (`triggerData`), available to the
   *     workflow as {{trigger.data.X}}
   *   - workflow input overrides (`inputs`), validated against
   *     def.inputs and surfaced as {{inputs.X}}
   *
   * `inputs` is also accepted as the trigger payload for
   * backward-compat with the pre-split clients (the previous schema
   * only took `inputs` and used it as trigger.data). When triggerData
   * is omitted, we fall back to inputs to keep that path working.
   */
  triggerData: z.record(z.unknown()).optional(),
  inputs: z.record(z.unknown()).optional(),
  // Optional clientRequestId for idempotency — double-clicks on the
  // editor's Test Run button should not spawn two executions.
  clientRequestId: z.string().min(8).max(64).optional(),
});

workflowsRouter.get('/:id/draft', async (c) => {
  const { id: idOrSlug } = c.req.param();
  const user = c.get('user');
  const { assertWorkflowAccess } = await import('../lib/workflow-access.js');
  const { id } = await assertWorkflowAccess(c.get('db'), user, idOrSlug, 'viewer');
  const { getDraft, WorkflowVersionError } = await import('../services/workflow-versions.js');
  try {
    const result = await getDraft(c.get('db'), id);
    return c.json(result);
  } catch (err) {
    if (err instanceof WorkflowVersionError && err.code === 'not_found') {
      throw new NotFoundError('Workflow', idOrSlug);
    }
    throw err;
  }
});

workflowsRouter.put('/:id/draft', zValidator('json', draftPutSchema), async (c) => {
  const { id: idOrSlug } = c.req.param();
  const user = c.get('user');
  const body = c.req.valid('json');
  const { assertWorkflowAccess } = await import('../lib/workflow-access.js');
  const { id } = await assertWorkflowAccess(c.get('db'), user, idOrSlug, 'editor');
  const { saveDraft, WorkflowVersionError } = await import('../services/workflow-versions.js');
  const { isWorkflowDefinition } = await import('../lib/workflow-dag/schema.js');
  const { validateDefinition, validateAgainstAvailableModels, groupWorkflowValidationResults } = await import('../lib/workflow-dag/validator.js');
  if (!isWorkflowDefinition(body.draft)) {
    return c.json({ error: 'invalid_draft', errors: validateDefinition(body.draft) }, 400);
  }
  const { assembleLlmProviderEnv } = await import('../lib/llm/provider-env.js');
  const { resolveAvailableModels } = await import('../services/model-catalog.js');
  const providerEnv = await assembleLlmProviderEnv(c.get('db'), c.env);
  const validationEnv = { ...c.env, ...providerEnv } as Env;
  const modelErrors = validateAgainstAvailableModels(body.draft, await resolveAvailableModels(c.get('db'), validationEnv));
  if (modelErrors.length > 0) {
    return c.json({ error: 'invalid_draft', ...groupWorkflowValidationResults(modelErrors) }, 400);
  }
  try {
    await saveDraft(c.get('db'), id, body.draft, body.ui);
    return c.json({ ok: true });
  } catch (err) {
    if (err instanceof WorkflowVersionError && err.code === 'not_found') {
      throw new NotFoundError('Workflow', idOrSlug);
    }
    throw err;
  }
});

workflowsRouter.post('/:id/validate', async (c) => {
  const { id: idOrSlug } = c.req.param();
  const user = c.get('user');
  const { assertWorkflowAccess } = await import('../lib/workflow-access.js');
  const { id } = await assertWorkflowAccess(c.get('db'), user, idOrSlug, 'viewer');
  const { getDraft, WorkflowVersionError } = await import('../services/workflow-versions.js');
  const { validateDefinition, validateAgainstEnvironment, groupWorkflowValidationResults } = await import('../lib/workflow-dag/validator.js');
  let result;
  try {
    result = await getDraft(c.get('db'), id);
  } catch (err) {
    if (err instanceof WorkflowVersionError && err.code === 'not_found') {
      throw new NotFoundError('Workflow', idOrSlug);
    }
    throw err;
  }
  if (!result.draft) {
    return c.json({ errors: [{ scope: 'workflow', code: 'no_draft', path: '/', message: 'no draft to validate' }], warnings: [] });
  }
  // Both validators are total — no try/catch needed.
  const structuralErrors = validateDefinition(result.draft);
  const { assembleLlmProviderEnv } = await import('../lib/llm/provider-env.js');
  const { resolveAvailableModels } = await import('../services/model-catalog.js');
  const providerEnv = await assembleLlmProviderEnv(c.get('db'), c.env);
  const validationEnv = { ...c.env, ...providerEnv } as Env;
  const availableModels = await resolveAvailableModels(c.get('db'), validationEnv);
  const envErrors = validateAgainstEnvironment(result.draft, validationEnv, { availableModels });
  return c.json(groupWorkflowValidationResults([...structuralErrors, ...envErrors]));
});

workflowsRouter.post('/:id/publish', zValidator('json', publishSchema), async (c) => {
  const { id: idOrSlug } = c.req.param();
  const user = c.get('user');
  const body = c.req.valid('json');
  const { assertWorkflowAccess } = await import('../lib/workflow-access.js');
  const { id } = await assertWorkflowAccess(c.get('db'), user, idOrSlug, 'editor');
  const { publishDraft, WorkflowVersionError } = await import('../services/workflow-versions.js');
  const { assembleLlmProviderEnv } = await import('../lib/llm/provider-env.js');
  const { resolveAvailableModels } = await import('../services/model-catalog.js');
  const providerEnv = await assembleLlmProviderEnv(c.get('db'), c.env);
  const validationEnv = { ...c.env, ...providerEnv } as Env;
  const availableModels = await resolveAvailableModels(c.get('db'), validationEnv);
  try {
    const result = await publishDraft(c.get('db'), id, {
      userId: user.id,
      env: validationEnv,
      availableModels,
      ...(body.publishNote ? { publishNote: body.publishNote } : {}),
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof WorkflowVersionError) {
      if (err.code === 'not_found') throw new NotFoundError('Workflow', idOrSlug);
      if (err.code === 'publish_contention') {
        // Concurrent publishes raced through the version retry loop;
        // signal "service-side contention" + ask the client to retry.
        return c.json({ error: err.message, code: err.code }, 503, { 'Retry-After': '1' });
      }
      return c.json({ error: err.message, code: err.code, errors: err.errors }, 400);
    }
    throw err;
  }
});

workflowsRouter.post('/:id/test-run', zValidator('json', testRunSchema), async (c) => {
  const { id: idOrSlug } = c.req.param();
  const user = c.get('user');
  const body = c.req.valid('json');
  const { assertWorkflowAccess } = await import('../lib/workflow-access.js');
  const { id } = await assertWorkflowAccess(c.get('db'), user, idOrSlug, 'editor');
  const { createExecution, WorkflowExecutionStartError } = await import('../services/workflow-executions.js');
  const clientRequestId = body.clientRequestId ?? crypto.randomUUID();
  // Test-run dedupe: if the same client (editor) double-clicks, return
  // the existing execution rather than spawning a second one. Scoped
  // to test-run by including 'test' in the key.
  const idempotencyKey = `test-run:${id}:${user.id}:${clientRequestId}`;
  const { checkIdempotencyKey } = await import('../lib/db.js');
  const existing = await checkIdempotencyKey(c.env.DB, id, user.id, idempotencyKey);
  if (existing) {
    return c.json({ executionId: existing.id as string, status: existing.status as string, deduplicated: true });
  }
  try {
    // Backward-compat for clients that still send only `inputs`: when
    // no triggerData is provided, the inputs object also doubles as the
    // sample trigger payload. New clients should send both — the
    // payload populates {{trigger.data.X}} and the inputs populate
    // {{inputs.X}}.
    const triggerData = body.triggerData ?? body.inputs ?? {};
    const result = await createExecution(c.env, {
      workflowId: id,
      user,
      trigger: {
        type: 'manual',
        timestamp: new Date().toISOString(),
        data: triggerData,
        metadata: { mode: 'test', initiatedBy: user.id, clientRequestId },
      },
      ...(body.inputs ? { inputOverrides: body.inputs } : {}),
      mode: 'test',
      definitionSource: 'draft',
      idempotencyKey,
    });
    return c.json(result);
  } catch (err) {
    if (err instanceof WorkflowExecutionStartError) {
      if (err.code === 'not_found') throw new NotFoundError('Workflow', idOrSlug);
      const statusCode = err.code === 'rate_limited' ? 429 : 400;
      return c.json({ error: err.message, code: err.code, details: err.details }, statusCode);
    }
    throw err;
  }
});

workflowsRouter.get('/:id/versions', async (c) => {
  const { id: idOrSlug } = c.req.param();
  const user = c.get('user');
  const { assertWorkflowAccess } = await import('../lib/workflow-access.js');
  const { id } = await assertWorkflowAccess(c.get('db'), user, idOrSlug, 'viewer');
  const { listVersions } = await import('../services/workflow-versions.js');
  const versions = await listVersions(c.get('db'), id);
  return c.json({ versions });
});

workflowsRouter.post('/:id/versions/:versionId/restore', async (c) => {
  const { id: idOrSlug, versionId } = c.req.param();
  const user = c.get('user');
  const { assertWorkflowAccess } = await import('../lib/workflow-access.js');
  const { id } = await assertWorkflowAccess(c.get('db'), user, idOrSlug, 'editor');
  const { restoreVersion, WorkflowVersionError } = await import('../services/workflow-versions.js');
  try {
    const result = await restoreVersion(c.get('db'), id, versionId);
    return c.json(result);
  } catch (err) {
    if (err instanceof WorkflowVersionError && err.code === 'not_found') {
      throw new NotFoundError('WorkflowVersion', versionId);
    }
    throw err;
  }
});
