import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { NotFoundError } from '@valet/shared';
import type { Env, Variables } from '../env.js';
import {
  listExecutions,
  getExecution,
  parseExecutionInputs,
} from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';
import { eq } from 'drizzle-orm';
import { workflowExecutions } from '../lib/schema/workflows.js';
import { listWorkflowApprovalsForExecution } from '../lib/db/workflow-approvals.js';

export const executionsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

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

  const executions = result.results.map((row) => {
    const inputs = parseExecutionInputs(row as { inputs?: string | null });
    return {
      id: row.id,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name,
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

  // Per-node trace rows from workflow_execution_nodes.
  const nodes = await c.env.DB.prepare(
    `SELECT id, node_id, node_type, status, input_preview, input_truncated,
            output, output_truncated, error, reason, retry_attempts, approval_id,
            invocation_id, started_at, completed_at, duration_ms, created_at
     FROM workflow_execution_nodes
     WHERE execution_id = ?
     ORDER BY created_at ASC`,
  ).bind(id).all<Record<string, unknown>>();

  const db = getDb(c.env.DB);
  const approvalRows = await listWorkflowApprovalsForExecution(db, id);

  const inputs = parseExecutionInputs(row as { inputs?: string | null });
  return c.json({
    execution: {
      id: row.id,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name,
      triggerId: row.trigger_id,
      triggerName: row.trigger_name,
      status: row.status,
      triggerType: row.trigger_type,
      triggerMetadata: row.trigger_metadata ? JSON.parse(row.trigger_metadata as string) : null,
      inputs,
      outputs: row.outputs ? JSON.parse(row.outputs as string) : null,
      error: row.error,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      mode: (row as Record<string, unknown>).mode ?? null,
      cancelledAt: (row as Record<string, unknown>).cancelled_at ?? null,
      cancelledBy: (row as Record<string, unknown>).cancelled_by ?? null,
      nodes: (nodes.results ?? []).map((n) => ({
        id: n.id,
        nodeId: n.node_id,
        nodeType: n.node_type,
        status: n.status,
        inputPreview: n.input_preview,
        inputTruncated: Boolean(n.input_truncated),
        output: n.output,
        outputTruncated: Boolean(n.output_truncated),
        error: n.error,
        reason: n.reason,
        retryAttempts: n.retry_attempts,
        approvalId: n.approval_id,
        invocationId: n.invocation_id,
        startedAt: n.started_at,
        completedAt: n.completed_at,
        durationMs: n.duration_ms,
        createdAt: n.created_at,
      })),
      approvals: approvalRows.map((a) => ({
        id: a.id,
        nodeId: a.nodeId,
        kind: a.kind,
        status: a.status,
        prompt: a.prompt,
        summary: a.summary,
        // Parsed once for the UI — the details column is author-supplied
        // JSON that the validator already parsed at publish time, so a
        // parse failure here would mean the row was hand-edited.
        details: a.details ? safeJsonParse(a.details) : null,
        timeoutAt: a.timeoutAt,
        resolvedBy: a.resolvedBy,
        resolvedAt: a.resolvedAt,
        cancelledAt: a.cancelledAt,
        createdAt: a.createdAt,
      })),
    },
  });
});

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

// ─── List + resolve approvals via flat URL (no workflowId required) ────────

executionsRouter.get('/:id/approvals', async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');

  const row = await getExecution(c.env.DB, id, user.id);
  if (!row) throw new NotFoundError('Execution', id);

  const db = getDb(c.env.DB);
  const approvals = await listWorkflowApprovalsForExecution(db, id);
  return c.json({
    approvals: approvals.map((a) => ({
      id: a.id,
      nodeId: a.nodeId,
      kind: a.kind,
      status: a.status,
      prompt: a.prompt,
      summary: a.summary,
      details: a.details ? safeJsonParse(a.details) : null,
      timeoutAt: a.timeoutAt,
      resolvedBy: a.resolvedBy,
      resolvedAt: a.resolvedAt,
      cancelledAt: a.cancelledAt,
      createdAt: a.createdAt,
    })),
  });
});

const approvalDecisionSchema = z.object({ reason: z.string().optional() });

executionsRouter.post(
  '/:id/approvals/:approvalId/approve',
  zValidator('json', approvalDecisionSchema),
  async (c) => runResolveApproval(c, 'approved'),
);

executionsRouter.post(
  '/:id/approvals/:approvalId/deny',
  zValidator('json', approvalDecisionSchema),
  async (c) => runResolveApproval(c, 'denied'),
);

async function runResolveApproval(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  c: any,
  result: 'approved' | 'denied',
) {
  const { id: executionId, approvalId } = c.req.param();
  const user = c.get('user');
  const body = c.req.valid('json') as { reason?: string };

  // User-scoped read first: refuses cross-tenant probing by id before
  // we hit the approval helper.
  const row = await getExecution(c.env.DB, executionId, user.id);
  if (!row) throw new NotFoundError('Execution', executionId);

  const { resolveWorkflowApprovalRequest } = await import('../services/workflow-approvals.js');
  const outcome = await resolveWorkflowApprovalRequest({
    env: c.env,
    user,
    approvalId,
    executionId,
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

/**
 * POST /api/executions/:id/cancel
 *
 * Flat-URL cancel route. Resolves the execution row (user-scoped via
 * getExecution → 404 if cross-tenant), pulls its workflowId, then
 * delegates to the same cancelExecution helper the nested route uses.
 * The expectedWorkflowId guard is defense-in-depth — getExecution
 * already user-scopes, but the inner check makes a future regression
 * (e.g. someone refactoring getExecution to drop the user filter)
 * fail safely rather than silently leaking.
 */
executionsRouter.post('/:id/cancel', async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');

  const row = await getExecution(c.env.DB, id, user.id);
  if (!row) throw new NotFoundError('Execution', id);

  const db = getDb(c.env.DB);
  const exec = await db.select({ workflowId: workflowExecutions.workflowId })
    .from(workflowExecutions)
    .where(eq(workflowExecutions.id, id))
    .get();
  if (!exec?.workflowId) throw new NotFoundError('Execution', id);

  const { cancelExecution } = await import('../workflows/cancel-cleanup.js');
  const result = await cancelExecution(c.env, {
    executionId: id,
    cancelledBy: user.id,
    expectedWorkflowId: exec.workflowId,
  });
  if (result.status === 'not_found') throw new NotFoundError('Execution', id);
  return c.json({ status: result.status });
});

