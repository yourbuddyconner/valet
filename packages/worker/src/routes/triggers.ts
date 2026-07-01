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
  generateWebhookToken,
  getTriggerForUpdate,
  updateTrigger,
  deleteTrigger,
  enableTrigger,
  disableTrigger,
  getWebhookTriggerById,
  type TriggerConfig,
} from '../lib/db.js';
import * as triggerService from '../services/triggers.js';
import * as webhookService from '../services/webhooks.js';

export const triggersRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// Validation schemas
const webhookConfigSchema = z.object({
  type: z.literal('webhook'),
  path: z.string().min(1),
  method: z.enum(['GET', 'POST']).optional().default('POST'),
  secret: z.string().optional(),
  headers: z.record(z.string()).optional(),
  // Per-trigger rate limit override (requests per 60s window). Defaults
  // to 60 (WEBHOOK_RATE_LIMIT_DEFAULT) when unset.
  rateLimit: z.number().int().positive().max(10000).optional(),
});

const scheduleConfigSchema = z.object({
  type: z.literal('schedule'),
  cron: z.string().min(1),
  timezone: z.string().optional(),
  target: z.enum(['workflow', 'orchestrator']).optional().default('workflow'),
  prompt: z.string().min(1).max(100000).optional(),
  // Optional model override for orchestrator-target triggers. Ignored for workflow-target.
  model: z.string().min(1).optional(),
  // Static trigger payload used for each scheduled workflow run.
  triggerData: z.record(z.unknown()).optional(),
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

// Legacy launch-config field names from the pre-dag/v1 runtime. The
// dispatch path does not honor them, so accept them here would silently
// mislead callers. Rejected explicitly on both run schemas.
const LEGACY_RUN_FIELDS = ['repoUrl', 'branch', 'ref', 'sourceRepoFullName'] as const;

function rejectLegacyRunFields(body: Record<string, unknown>, ctx: z.RefinementCtx): void {
  for (const key of LEGACY_RUN_FIELDS) {
    if (key in body) {
      ctx.addIssue({
        code: z.ZodIssueCode.unrecognized_keys,
        keys: [key],
        message: `"${key}" is not a supported field; the workflow runtime does not consume repo launch config`,
      });
    }
  }
}

// Strict on top-level keys: manual-run has a closed shape, anything
// else (including the legacy repo fields) should fail loudly.
const manualRunSchema = z.object({
  workflowId: z.string().min(1),
  clientRequestId: z.string().min(8).optional(),
  variables: z.record(z.unknown()).optional(),
}).strict();

// triggerRunSchema is .passthrough() because the trigger's
// variableMapping can reference arbitrary top-level body fields
// (e.g. `$.user.email`). The legacy repo fields are explicitly
// refused so they don't sneak through as "harmless extras".
const triggerRunSchema = z.object({
  clientRequestId: z.string().min(8).optional(),
  variables: z.record(z.unknown()).optional(),
  triggerData: z.record(z.unknown()).optional(),
}).passthrough().superRefine((value, ctx) => rejectLegacyRunFields(value, ctx));

/**
 * POST /api/triggers/manual/run
 * Run a workflow directly without a trigger
 */
triggersRouter.post('/manual/run', zValidator('json', manualRunSchema), async (c) => {
  const user = c.get('user');
  const body = c.req.valid('json');

  const result = await triggerService.runWorkflowManually(c.env, {
    userId: user.id,
    ...body,
  });

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
      dispatched: result.dispatched,
      message: result.dispatched
        ? 'Workflow execution queued.'
        : 'Workflow execution queued; dispatch to the workflow runtime failed and will be retried.',
    }, 202);
  }

  return c.json({ error: 'Unknown error' }, 500);
});

/**
 * POST /api/triggers/:triggerId/webhook
 *
 * Server-issued-token webhook endpoint. Bypasses /api/* auth (see
 * authMiddleware); authenticates via the X-Valet-Trigger-Token header
 * against the trigger row's stored token (constant-time compare).
 *
 * Applies the per-trigger rate limit before dispatching. Schedule and
 * manual triggers are exempt — only the path-based /webhooks/:path
 * route shares the rate limit logic with this one.
 */
triggersRouter.all('/:triggerId/webhook', async (c) => {
  const triggerId = c.req.param('triggerId');
  const row = await getWebhookTriggerById(c.env.DB, triggerId);

  if (!row) {
    return c.json({ error: 'Webhook not found' }, 404);
  }

  const config = JSON.parse(row.config) as {
    method?: string;
    secret?: string;
    rateLimit?: number;
  };

  // Verify HTTP method if configured (default POST).
  const method = c.req.method;
  if (config.method && config.method !== method) {
    return c.json({ error: `Method ${method} not allowed` }, 405);
  }

  // Constant-time token compare. We deliberately do NOT distinguish
  // "missing token" from "wrong token" in the error body to avoid
  // helping a probe enumerate triggers.
  const presented = c.req.header('X-Valet-Trigger-Token');
  if (!webhookService.verifyTriggerToken(row, presented)) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Per-trigger rate limit (default 60/min, configurable per trigger).
  const rate = await webhookService.checkWebhookRateLimit(c.env, row.id, config);
  if (!rate.allowed) {
    return c.json(
      {
        error: 'rate_limited',
        message: `Webhook rate limit exceeded (${rate.count}/${rate.limit} per 60s).`,
      },
      429,
      { 'Retry-After': String(rate.retryAfter) },
    );
  }

  const rawBody = method === 'GET' ? '' : await c.req.raw.clone().text().catch(() => '');
  // Forward the full request headers (lowercased keys) so workflows can
  // reference any inbound header via {{trigger.data.headers.X}}, not just
  // the five x-* signature/delivery headers used for auth/idempotency.
  const headers: Record<string, string | undefined> = {};
  c.req.raw.headers.forEach((value, key) => {
    headers[key.toLowerCase()] = value;
  });
  const url = new URL(c.req.url);
  const query: Record<string, string> = {};
  url.searchParams.forEach((value, key) => { query[key] = value; });
  // Strip the leading '?' so the service hashes only the pair list.
  const rawQuery = url.search.startsWith('?') ? url.search.slice(1) : url.search;

  // Use the trigger's configured path for metadata so existing
  // executions look the same regardless of which URL the webhook was
  // posted to.
  const webhookPath = (JSON.parse(row.config) as { path?: string }).path ?? row.id;

  const result = await webhookService.dispatchWebhookForTrigger(
    c.env,
    row,
    webhookPath,
    method,
    rawBody,
    headers,
    query,
    rawQuery,
  );
  return c.json(result.result, result.statusCode as 200 | 400 | 404 | 405 | 429);
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
 *
 * NB: never echoes triggers.webhook_token. The token is only returned
 * once at create time. To rotate, the user must create a new trigger.
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
    webhookUrl = `${protocol}://${host}/api/triggers/${row.id}/webhook`;
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
    const existing = await checkWebhookPathUniqueness(c.env.DB, body.config.path);

    if (existing) {
      throw new ValidationError('Webhook path already in use');
    }
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();

  // Webhook triggers get a server-issued 32-char token used to
  // authenticate incoming requests. Returned exactly once in this
  // response — never re-exposed via GET/PATCH.
  const webhookToken = body.config.type === 'webhook' ? generateWebhookToken() : null;

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
    webhookToken,
  });

  const host = c.req.header('host') || 'localhost:8787';
  const protocol = c.req.url.startsWith('https') ? 'https' : 'http';
  let webhookUrl: string | undefined;
  if (body.config.type === 'webhook') {
    webhookUrl = `${protocol}://${host}/api/triggers/${id}/webhook`;
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
      // Server-issued token. Shown to the caller exactly once at
      // create time; the GET/PATCH endpoints never echo it.
      webhookToken,
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
    const conflict = await checkWebhookPathUniqueness(c.env.DB, nextConfig.path, id);

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

  // Webhook token lifecycle on type transitions.
  //
  // The /api/triggers/:id/webhook handler rejects any request whose row
  // has a null webhook_token (constant-time compare against the header
  // would always fail). If a user edits a manual/schedule trigger into a
  // webhook via PATCH and we don't mint a token here, the new webhook
  // URL returns 401 forever. Mirror the POST semantics: mint once, show
  // the token in the response, and never re-expose it via GET/PATCH.
  //
  // The reverse transition (webhook → manual/schedule) clears the token
  // so a later flip back doesn't silently reuse a stale value.
  let mintedWebhookToken: string | null = null;
  if (body.config !== undefined) {
    const becameWebhook = nextConfig.type === 'webhook' && existing.type !== 'webhook';
    const leftWebhook = nextConfig.type !== 'webhook' && existing.type === 'webhook';
    if (becameWebhook) {
      mintedWebhookToken = generateWebhookToken();
      updates.push('webhook_token = ?');
      values.push(mintedWebhookToken);
    } else if (leftWebhook) {
      updates.push('webhook_token = ?');
      values.push(null);
    }
  }

  updates.push('updated_at = ?');
  values.push(now);
  values.push(id);

  await updateTrigger(c.env.DB, id, user.id, updates, values);

  // Response surface mirrors POST when a token was minted, so the caller
  // can capture the token + webhook URL without a second round trip.
  if (mintedWebhookToken && nextConfig.type === 'webhook') {
    const host = c.req.header('host') || 'localhost:8787';
    const protocol = c.req.url.startsWith('https') ? 'https' : 'http';
    return c.json({
      success: true,
      updatedAt: now,
      webhookToken: mintedWebhookToken,
      webhookUrl: `${protocol}://${host}/api/triggers/${id}/webhook`,
    });
  }

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

  const result = await triggerService.runTrigger(c.env, id, user.id, body);

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
      dispatched: result.dispatched,
      message: result.dispatched
        ? 'Workflow execution queued.'
        : 'Workflow execution queued; dispatch to the workflow runtime failed and will be retried.',
    }, 202);
  }

  return c.json({ error: 'Unknown error' }, 500);
});
