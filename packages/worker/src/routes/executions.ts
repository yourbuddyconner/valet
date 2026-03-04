import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { NotFoundError } from '@valet/shared';
import type { Env, Variables } from '../env.js';
import {
  listExecutions,
  getExecution,
} from '../lib/db.js';
import * as executionService from '../services/executions.js';

export const executionsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// Validation schemas
const executionStepSchema = z.object({
  stepId: z.string(),
  status: z.enum(['pending', 'running', 'waiting_approval', 'completed', 'failed', 'cancelled', 'skipped']),
  attempt: z.number().int().positive().optional(),
  input: z.unknown().optional(),
  output: z.unknown().optional(),
  error: z.string().optional(),
  startedAt: z.string().optional(),
  completedAt: z.string().optional(),
});

const completionSchema = z.object({
  status: z.enum(['completed', 'failed', 'cancelled']),
  outputs: z.record(z.unknown()).optional(),
  steps: z.array(executionStepSchema).optional(),
  error: z.string().optional(),
  completedAt: z.string().optional(),
});

const approvalSchema = z.object({
  approve: z.boolean(),
  resumeToken: z.string().min(1),
  reason: z.string().optional(),
});

const cancelSchema = z.object({
  reason: z.string().optional(),
});

/**
 * GET /api/executions
 * List recent workflow executions for the user
 */
executionsRouter.get('/', async (c) => {
  const user = c.get('user');
  const { limit, offset, status, workflowId } = c.req.query();

  const result = await listExecutions(c.env.DB, user.id, {
    limit: parseInt(limit || '50'),
    offset: parseInt(offset || '0'),
    status,
    workflowId,
  });

  const executions = result.results.map((row) => ({
    id: row.id,
    workflowId: row.workflow_id,
    workflowName: row.workflow_name,
    sessionId: row.session_id,
    triggerId: row.trigger_id,
    status: row.status,
    triggerType: row.trigger_type,
    triggerMetadata: row.trigger_metadata ? JSON.parse(row.trigger_metadata as string) : null,
    variables: row.variables ? JSON.parse(row.variables as string) : null,
    resumeToken: row.resume_token || null,
    outputs: row.outputs ? JSON.parse(row.outputs as string) : null,
    steps: row.steps ? JSON.parse(row.steps as string) : null,
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }));

  return c.json({ executions });
});

/**
 * GET /api/executions/:id
 * Get a single execution
 */
executionsRouter.get('/:id', async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');

  const row = await getExecution(c.env.DB, id, user.id);

  if (!row) {
    throw new NotFoundError('Execution', id);
  }

  return c.json({
    execution: {
      id: row.id,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name,
      sessionId: row.session_id,
      triggerId: row.trigger_id,
      triggerName: row.trigger_name,
      status: row.status,
      triggerType: row.trigger_type,
      triggerMetadata: row.trigger_metadata ? JSON.parse(row.trigger_metadata as string) : null,
      variables: row.variables ? JSON.parse(row.variables as string) : null,
      resumeToken: row.resume_token || null,
      outputs: row.outputs ? JSON.parse(row.outputs as string) : null,
      steps: row.steps ? JSON.parse(row.steps as string) : null,
      error: row.error,
      startedAt: row.started_at,
      completedAt: row.completed_at,
    },
  });
});

/**
 * GET /api/executions/:id/steps
 * Get normalized step-level trace for an execution.
 */
executionsRouter.get('/:id/steps', async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');

  const steps = await executionService.getExecutionStepsWithOrder(c.env, id, user.id);
  return c.json({ steps });
});

/**
 * POST /api/executions/:id/complete
 * Called by the plugin to report execution completion
 */
executionsRouter.post('/:id/complete', zValidator('json', completionSchema), async (c) => {
  const { id } = c.req.param();
  const body = c.req.valid('json');
  const user = c.get('user');

  const result = await executionService.completeExecution(c.env, id, user.id, body);
  return c.json({ success: true, status: result.status, completedAt: result.completedAt });
});

/**
 * POST /api/executions/:id/status
 * Update execution status (e.g., pending -> running)
 */
executionsRouter.post('/:id/status', async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');
  const body = await c.req.json();

  await executionService.updateExecutionStatusChecked(c.get('db'), id, user.id, body.status);
  return c.json({ success: true, status: body.status });
});

/**
 * POST /api/executions/:id/approve
 * Approve or deny a waiting approval checkpoint.
 */
executionsRouter.post('/:id/approve', zValidator('json', approvalSchema), async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');
  const body = c.req.valid('json');

  const result = await executionService.handleApproval(c.env, id, user.id, body);
  return c.json({ success: true, status: result.status });
});

/**
 * POST /api/executions/:id/cancel
 * Cancel an execution (best-effort for running executions).
 */
executionsRouter.post('/:id/cancel', zValidator('json', cancelSchema), async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');
  const body = c.req.valid('json');

  const result = await executionService.cancelExecution(c.env, id, user.id, body.reason);
  return c.json({ success: true, status: result.status });
});
