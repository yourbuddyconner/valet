import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { NotFoundError, ValidationError } from '@valet/shared';
import type { Env, Variables } from '../env.js';
import {
  scheduleTarget,
  requiresWorkflow,
  listTriggers,
  getTrigger,
  getWorkflowForTrigger,
  checkWebhookPathUniqueness,
  createTrigger,
  getTriggerForUpdate,
  updateTrigger,
  deleteTrigger,
  enableTrigger,
  disableTrigger,
  type TriggerConfig,
} from '../lib/db.js';
import * as triggerService from '../services/triggers.js';

export const triggersRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// Validation schemas
const webhookConfigSchema = z.object({
  type: z.literal('webhook'),
  path: z.string().min(1),
  method: z.enum(['GET', 'POST']).optional().default('POST'),
  secret: z.string().optional(),
  headers: z.record(z.string()).optional(),
});

const scheduleConfigSchema = z.object({
  type: z.literal('schedule'),
  cron: z.string().min(1),
  timezone: z.string().optional(),
  target: z.enum(['workflow', 'orchestrator']).optional().default('workflow'),
  prompt: z.string().min(1).max(100000).optional(),
});

const manualConfigSchema = z.object({
  type: z.literal('manual'),
});

const triggerConfigSchema = z.discriminatedUnion('type', [
  webhookConfigSchema,
  scheduleConfigSchema,
  manualConfigSchema,
]);

const createTriggerSchema = z.object({
  workflowId: z.string().min(1).optional(),
  name: z.string().min(1),
  enabled: z.boolean().optional().default(true),
  config: triggerConfigSchema,
  variableMapping: z.record(z.string()).optional(),
}).superRefine((value, ctx) => {
  if (value.config.type === 'schedule' && scheduleTarget(value.config) === 'orchestrator' && !value.config.prompt?.trim()) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'Schedule triggers targeting orchestrator require a prompt',
      path: ['config', 'prompt'],
    });
  }
  if (requiresWorkflow(value.config) && !value.workflowId) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'workflowId is required for this trigger type',
      path: ['workflowId'],
    });
  }
});

const updateTriggerSchema = z.object({
  workflowId: z.string().min(1).nullable().optional(),
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  config: triggerConfigSchema.optional(),
  variableMapping: z.record(z.string()).optional(),
});

const manualRunSchema = z.object({
  workflowId: z.string().min(1),
  clientRequestId: z.string().min(8).optional(),
  variables: z.record(z.unknown()).optional(),
  repoUrl: z.string().min(1).optional(),
  branch: z.string().optional(),
  ref: z.string().optional(),
  sourceRepoFullName: z.string().optional(),
});

const triggerRunSchema = z.object({
  clientRequestId: z.string().min(8).optional(),
  variables: z.record(z.unknown()).optional(),
  repoUrl: z.string().min(1).optional(),
  branch: z.string().optional(),
  ref: z.string().optional(),
  sourceRepoFullName: z.string().optional(),
}).passthrough();

/**
 * POST /api/triggers/manual/run
 * Run a workflow directly without a trigger
 */
triggersRouter.post('/manual/run', zValidator('json', manualRunSchema), async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');
  const workerOrigin = new URL(c.req.url).origin;

  const result = await triggerService.runWorkflowManually(c.env, {
    userId: user.id,
    ...body,
  }, workerOrigin);

  if (!result.ok) {
    if (result.reason === 'rate_limited') {
      return c.json({
        error: result.error,
        reason: result.concurrencyReason,
        activeUser: result.activeUser,
        activeGlobal: result.activeGlobal,
      }, 429);
    }
    if (result.reason === 'duplicate') {
      return c.json({
        executionId: result.executionId,
        workflowId: result.workflowId,
        workflowName: result.workflowName,
        status: result.status,
        variables: result.variables,
        sessionId: result.sessionId,
        message: 'Workflow execution already exists for this request.',
      }, 200);
    }
  }

  if (result.ok) {
    return c.json({
      executionId: result.executionId,
      workflowId: result.workflowId,
      workflowName: result.workflowName,
      status: result.status,
      variables: result.variables,
      sessionId: result.sessionId,
      dispatched: result.dispatched,
      message: result.dispatched
        ? 'Workflow execution queued and dispatched to workflow executor.'
        : 'Workflow execution queued. Dispatch to workflow executor failed and will need retry.',
    }, 202);
  }

  return c.json({ error: 'Unknown error' }, 500);
});

/**
 * GET /api/triggers
 */
triggersRouter.get('/', async (c) => {
  const user = c.get('user');

  const result = await listTriggers(c.env.DB, user.id);

  const triggers = result.results.map((row) => ({
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    name: row.name,
    enabled: Boolean(row.enabled),
    type: row.type,
    config: JSON.parse(row.config as string),
    variableMapping: row.variable_mapping ? JSON.parse(row.variable_mapping as string) : null,
    lastRunAt: row.last_run_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  return c.json({ triggers });
});

/**
 * GET /api/triggers/:id
 */
triggersRouter.get('/:id', async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');

  const row = await getTrigger(c.env.DB, user.id, id);

  if (!row) {
    throw new NotFoundError('Trigger', id);
  }

  const config = JSON.parse(row.config as string);
  const host = c.req.header('host') || 'localhost:8787';
  const protocol = c.req.url.startsWith('https') ? 'https' : 'http';
  let webhookUrl: string | undefined;
  if (row.type === 'webhook') {
    webhookUrl = `${protocol}://${host}/webhooks/${config.path}`;
  }

  return c.json({
    trigger: {
      id: row.id,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name,
      name: row.name,
      enabled: Boolean(row.enabled),
      type: row.type,
      config,
      variableMapping: row.variable_mapping ? JSON.parse(row.variable_mapping as string) : null,
      webhookUrl,
      lastRunAt: row.last_run_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  });
});

/**
 * POST /api/triggers
 */
triggersRouter.post('/', zValidator('json', createTriggerSchema), async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  const requiresLinkedWorkflow = requiresWorkflow(body.config);
  let workflowId: string | null = null;
  if (requiresLinkedWorkflow || body.workflowId) {
    const workflow = await getWorkflowForTrigger(c.get('db'), user.id, body.workflowId || '');

    if (!workflow) {
      if (requiresLinkedWorkflow) {
        throw new NotFoundError('Workflow', body.workflowId || '<missing>');
      }
      throw new NotFoundError('Workflow', body.workflowId || '<invalid>');
    }
    workflowId = workflow.id;
  }

  if (body.config.type === 'webhook') {
    const existing = await checkWebhookPathUniqueness(c.env.DB, user.id, body.config.path);

    if (existing) {
      throw new ValidationError('Webhook path already in use');
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  await createTrigger(c.get('db'), {
    id,
    userId: user.id,
    workflowId,
    name: body.name,
    enabled: body.enabled,
    type: body.config.type,
    config: JSON.stringify(body.config),
    variableMapping: body.variableMapping ? JSON.stringify(body.variableMapping) : null,
    now,
  });

  const host = c.req.header('host') || 'localhost:8787';
  const protocol = c.req.url.startsWith('https') ? 'https' : 'http';
  let webhookUrl: string | undefined;
  if (body.config.type === 'webhook') {
    webhookUrl = `${protocol}://${host}/webhooks/${body.config.path}`;
  }

  return c.json(
    {
      id,
      workflowId,
      name: body.name,
      enabled: body.enabled,
      type: body.config.type,
      config: body.config,
      variableMapping: body.variableMapping,
      webhookUrl,
      createdAt: now,
      updatedAt: now,
    },
    201
  );
});

/**
 * PATCH /api/triggers/:id
 */
triggersRouter.patch('/:id', zValidator('json', updateTriggerSchema), async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');
  const body = c.req.valid('json');

  const existing = await getTriggerForUpdate(c.get('db'), user.id, id);

  if (!existing) {
    throw new NotFoundError('Trigger', id);
  }

  const currentConfig = JSON.parse(existing.config) as TriggerConfig;
  const nextConfig = body.config ?? currentConfig;
  let nextWorkflowId = body.workflowId !== undefined ? body.workflowId : existing.workflow_id;

  if (nextConfig.type === 'schedule' && scheduleTarget(nextConfig) === 'orchestrator' && !nextConfig.prompt?.trim()) {
    throw new ValidationError('Schedule triggers targeting orchestrator require a prompt');
  }

  if (requiresWorkflow(nextConfig) && !nextWorkflowId) {
    throw new ValidationError('workflowId is required for this trigger type');
  }

  if (nextWorkflowId) {
    const workflow = await getWorkflowForTrigger(c.get('db'), user.id, nextWorkflowId);

    if (!workflow) {
      throw new NotFoundError('Workflow', nextWorkflowId);
    }

    nextWorkflowId = workflow.id;
  }

  if (nextConfig.type === 'webhook') {
    const conflict = await checkWebhookPathUniqueness(c.env.DB, user.id, nextConfig.path, id);

    if (conflict) {
      throw new ValidationError('Webhook path already in use');
    }
  }

  const now = new Date().toISOString();
  const updates: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined) {
    updates.push('name = ?');
    values.push(body.name);
  }
  if (body.enabled !== undefined) {
    updates.push('enabled = ?');
    values.push(body.enabled ? 1 : 0);
  }
  if (body.workflowId !== undefined || (body.config && !requiresWorkflow(body.config))) {
    updates.push('workflow_id = ?');
    values.push(nextWorkflowId);
  }
  if (body.config !== undefined) {
    updates.push('type = ?');
    updates.push('config = ?');
    values.push(body.config.type);
    values.push(JSON.stringify(body.config));
  }
  if (body.variableMapping !== undefined) {
    updates.push('variable_mapping = ?');
    values.push(JSON.stringify(body.variableMapping));
  }

  updates.push('updated_at = ?');
  values.push(now);
  values.push(id);

  await updateTrigger(c.env.DB, id, updates, values);

  return c.json({ success: true, updatedAt: now });
});

/**
 * DELETE /api/triggers/:id
 */
triggersRouter.delete('/:id', async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');

  const result = await deleteTrigger(c.get('db'), id, user.id);

  if (result.meta.changes === 0) {
    throw new NotFoundError('Trigger', id);
  }

  return c.json({ success: true });
});

/**
 * POST /api/triggers/:id/enable
 */
triggersRouter.post('/:id/enable', async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');

  const result = await enableTrigger(c.get('db'), id, user.id, new Date().toISOString());

  if (result.meta.changes === 0) {
    throw new NotFoundError('Trigger', id);
  }

  return c.json({ success: true });
});

/**
 * POST /api/triggers/:id/disable
 */
triggersRouter.post('/:id/disable', async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');

  const result = await disableTrigger(c.get('db'), id, user.id, new Date().toISOString());

  if (result.meta.changes === 0) {
    throw new NotFoundError('Trigger', id);
  }

  return c.json({ success: true });
});

/**
 * POST /api/triggers/:id/run
 * Manually run a trigger
 */
triggersRouter.post('/:id/run', zValidator('json', triggerRunSchema), async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');
  const body = c.req.valid('json');
  const workerOrigin = new URL(c.req.url).origin;

  const result = await triggerService.runTrigger(c.env, id, user.id, body, workerOrigin);

  if (!result.ok) {
    if (result.reason === 'rate_limited') {
      return c.json({
        error: result.error,
        reason: result.concurrencyReason,
        activeUser: result.activeUser,
        activeGlobal: result.activeGlobal,
      }, 429);
    }
    if (result.reason === 'duplicate') {
      return c.json({
        executionId: result.executionId,
        workflowId: result.workflowId,
        workflowName: result.workflowName,
        status: result.status,
        variables: result.variables,
        sessionId: result.sessionId,
        message: 'Workflow execution already exists for this request.',
      }, 200);
    }
    if (result.reason === 'orchestrator_failed') {
      return c.json({
        error: result.error,
        status: 'failed',
        workflowId: result.workflowId,
        workflowName: result.workflowName,
        sessionId: result.sessionId,
        reason: result.dispatchReason,
      }, 409);
    }
  }

  if (result.ok && result.type === 'orchestrator') {
    return c.json({
      status: 'queued',
      workflowId: result.workflowId,
      workflowName: result.workflowName,
      sessionId: result.sessionId,
      message: 'Orchestrator prompt dispatched.',
    }, 202);
  }

  if (result.ok && result.type === 'workflow') {
    return c.json({
      executionId: result.executionId,
      workflowId: result.workflowId,
      workflowName: result.workflowName,
      status: result.status,
      variables: result.variables,
      sessionId: result.sessionId,
      dispatched: result.dispatched,
      message: result.dispatched
        ? 'Workflow execution queued and dispatched to workflow executor.'
        : 'Workflow execution queued. Dispatch to workflow executor failed and will need retry.',
    }, 202);
  }

  return c.json({ error: 'Unknown error' }, 500);
});
