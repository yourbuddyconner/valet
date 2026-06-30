import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { NotFoundError, type WorkflowTriggerPayload } from '@valet/shared';
import type { D1Database } from '@cloudflare/workers-types';
import type { Env, Variables } from '../env.js';
import {
  listExecutions,
  getExecution,
  parseExecutionTriggerData,
  checkIdempotencyKey,
  listDescendantPendingApprovalsForExecution,
} from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';
import { asc, eq } from 'drizzle-orm';
import { workflowExecutions } from '../lib/schema/workflows.js';
import { actionInvocations } from '../lib/schema/actions.js';
import { isWorkflowDefinition } from '../lib/workflow-dag/schema.js';

export const executionsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();
type ExecutionsRouteContext = Context<{ Bindings: Env; Variables: Variables }>;

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
    const triggerData = parseExecutionTriggerData(row as { inputs?: string | null });
    return {
      id: row.id,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name,
      triggerId: row.trigger_id,
      status: row.status,
      triggerType: row.trigger_type,
      triggerMetadata: row.trigger_metadata ? JSON.parse(row.trigger_metadata as string) : null,
      triggerData,
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

  const spawnedSessionRows = await c.env.DB.prepare(
    `SELECT node_id, session_id
     FROM workflow_spawned_sessions
     WHERE execution_id = ?`,
  ).bind(id).all<Record<string, unknown>>();
  const spawnedSessionByNode = new Map<string, string>();
  for (const spawnedSession of spawnedSessionRows.results ?? []) {
    if (typeof spawnedSession.node_id !== 'string') continue;
    if (typeof spawnedSession.session_id !== 'string') continue;
    spawnedSessionByNode.set(spawnedSession.node_id, spawnedSession.session_id);
  }

  const db = getDb(c.env.DB);
  // Post-consolidation (migration 0022): workflow_approvals is retired.
  // Workflow-attributed approvals live in action_invocations.
  const approvalRows = await db.select().from(actionInvocations)
    .where(eq(actionInvocations.workflowExecutionId, id))
    .orderBy(asc(actionInvocations.createdAt))
    .all();

  const triggerData = parseExecutionTriggerData(row as { inputs?: string | null });
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
      triggerData,
      outputs: row.outputs ? JSON.parse(row.outputs as string) : null,
      error: row.error,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      mode: (row as Record<string, unknown>).mode ?? null,
      cancelledAt: (row as Record<string, unknown>).cancelled_at ?? null,
      cancelledBy: (row as Record<string, unknown>).cancelled_by ?? null,
      nodes: (nodes.results ?? []).map((n) => {
        const nodeId = String(n.node_id ?? '');
        const nodeType = String(n.node_type ?? '');
        return {
          id: n.id,
          nodeId,
          nodeType,
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
          sessionId: nodeType === 'session' ? spawnedSessionByNode.get(nodeId) ?? null : null,
          startedAt: n.started_at,
          completedAt: n.completed_at,
          durationMs: n.duration_ms,
          createdAt: n.created_at,
        };
      }),
      approvals: approvalRows.map(mapInvocationToApprovalView),
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

/**
 * Map an action_invocations row into the workflow-approvals view shape the
 * UI was built against. Explicit approvals (service='workflows',
 * actionId='request_approval') derive prompt/summary/details from params;
 * tool-policy approvals synthesize a prompt from service+actionId.
 */
function mapInvocationToApprovalView(a: typeof actionInvocations.$inferSelect) {
  const parsedParams = a.params ? safeJsonParse(a.params) : null;
  const explicit = a.service === 'workflows' && a.actionId === 'request_approval';
  const p = parsedParams && typeof parsedParams === 'object'
    ? (parsedParams as Record<string, unknown>)
    : {};
  return {
    id: a.id,
    nodeId: a.nodeId,
    kind: explicit ? 'explicit' : 'tool_policy',
    status: a.status,
    prompt: explicit ? (p.prompt ?? null) : `Approve ${a.service}.${a.actionId}?`,
    summary: explicit ? (p.summary ?? null) : null,
    details: explicit ? (p.details ?? null) : parsedParams,
    timeoutAt: a.expiresAt,
    resolvedBy: a.resolvedBy,
    resolvedAt: a.resolvedAt,
    cancelledAt: null,
    createdAt: a.createdAt,
  };
}

const retryExecutionSchema = z.object({
  clientRequestId: z.string().optional(),
});

/**
 * POST /api/executions/:id/retry
 *
 * Starts a new execution from the selected execution's stored
 * definition_snapshot and original trigger payload.
 * This is intentionally snapshot-based: retrying an old failed run should
 * reproduce that run, not silently execute whatever draft/published version
 * exists today.
 */
executionsRouter.post('/:id/retry', zValidator('json', retryExecutionSchema), async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');
  const body = c.req.valid('json');

  const row = await getExecution(c.env.DB, id, user.id);
  if (!row) throw new NotFoundError('Execution', id);

  const workflowId = String((row as Record<string, unknown>).workflow_id ?? '');
  if (!workflowId) throw new NotFoundError('Workflow', 'for execution retry');

  const definitionSnapshotRaw = (row as Record<string, unknown>).definition_snapshot;
  if (typeof definitionSnapshotRaw !== 'string' || !definitionSnapshotRaw.trim()) {
    return c.json({ error: 'execution has no workflow definition snapshot', code: 'missing_definition_snapshot' }, 400);
  }

  const clientRequestId = body.clientRequestId ?? crypto.randomUUID();
  const idempotencyKey = `retry:${id}:${user.id}:${clientRequestId}`;
  const existing = await checkIdempotencyKey(c.env.DB, workflowId, user.id, idempotencyKey);
  if (existing) {
    return c.json({
      executionId: existing.id as string,
      status: existing.status as string,
      workflowId,
      retriedFromExecutionId: id,
      deduplicated: true,
    });
  }

  const definitionSnapshot = safeJsonParse(definitionSnapshotRaw);
  if (!isWorkflowDefinition(definitionSnapshot)) {
    return c.json({ error: 'execution definition snapshot is malformed', code: 'invalid_definition_snapshot' }, 400);
  }

  const trigger = await readRetryTriggerPayload(c.env.DB, id, row as Record<string, unknown>, user.id, clientRequestId);
  const storedTriggerData = parseExecutionTriggerData(row as { inputs?: string | null }) ?? {};
  const retryTrigger = { ...trigger, data: storedTriggerData };

  const { createExecution, WorkflowExecutionStartError } = await import('../services/workflow-executions.js');
  try {
    const result = await createExecution(c.env, {
      workflowId,
      user,
      trigger: retryTrigger,
      mode: ((row as Record<string, unknown>).mode === 'test' ? 'test' : 'production'),
      definitionSource: 'snapshot',
      definitionSnapshot,
      idempotencyKey,
    });
    return c.json({ ...result, workflowId, retriedFromExecutionId: id });
  } catch (err) {
    if (err instanceof WorkflowExecutionStartError) {
      if (err.code === 'not_found') throw new NotFoundError('Workflow', workflowId);
      const statusCode = err.code === 'rate_limited' ? 429 : 400;
      return c.json({ error: err.message, code: err.code, details: err.details }, statusCode);
    }
    throw err;
  }
});

async function readRetryTriggerPayload(
  db: D1Database,
  executionId: string,
  executionRow: Record<string, unknown>,
  userId: string,
  clientRequestId: string,
): Promise<WorkflowTriggerPayload> {
  const trace = await db.prepare(
    `SELECT output
     FROM workflow_execution_nodes
     WHERE execution_id = ? AND node_type = 'trigger' AND status = 'completed'
     ORDER BY created_at DESC
     LIMIT 1`,
  ).bind(executionId).first<{ output?: string | null }>();

  const parsed = typeof trace?.output === 'string' ? safeJsonParse(trace.output) : null;
  const trigger = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
    ? parsed as Partial<WorkflowTriggerPayload>
    : null;
  const metadata = trigger?.metadata && typeof trigger.metadata === 'object' && !Array.isArray(trigger.metadata)
    ? { ...trigger.metadata }
    : safeJsonParse(String(executionRow.trigger_metadata ?? '{}'));
  const triggerType = trigger?.type ?? executionRow.trigger_type;

  return {
    type: isWorkflowTriggerType(triggerType) ? triggerType : 'manual',
    timestamp: new Date().toISOString(),
    data: trigger?.data ?? {},
    metadata: {
      ...(metadata && typeof metadata === 'object' && !Array.isArray(metadata) ? metadata : {}),
      retriedFromExecutionId: executionId,
      retryClientRequestId: clientRequestId,
      initiatedBy: userId,
    },
    ...(typeof trigger?.triggerId === 'string' ? { triggerId: trigger.triggerId } : {}),
  };
}

function isWorkflowTriggerType(input: unknown): input is WorkflowTriggerPayload['type'] {
  return input === 'manual' || input === 'schedule' || input === 'webhook';
}

// ─── List + resolve approvals via flat URL (no workflowId required) ────────

executionsRouter.get('/:id/approvals', async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');

  const row = await getExecution(c.env.DB, id, user.id);
  if (!row) throw new NotFoundError('Execution', id);

  const db = getDb(c.env.DB);
  const approvals = await db.select().from(actionInvocations)
    .where(eq(actionInvocations.workflowExecutionId, id))
    .orderBy(asc(actionInvocations.createdAt))
    .all();
  return c.json({
    approvals: approvals.map(mapInvocationToApprovalView),
  });
});

/**
 * GET /api/executions/:id/pending-approvals
 * Lists pending approvals rooted at this workflow execution — the
 * execution's own (tool-policy holds + explicit approval gates) plus
 * every pending invocation in any session this execution spawned and
 * their descendants. The execution view uses this to surface every
 * approval gate stalling the workflow without the user opening each
 * spawned session.
 */
executionsRouter.get('/:id/pending-approvals', async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');
  const row = await getExecution(c.env.DB, id, user.id);
  if (!row) throw new NotFoundError('Execution', id);
  const approvals = await listDescendantPendingApprovalsForExecution(getDb(c.env.DB), id);
  return c.json({ approvals });
});

// `scope` is `once` for plain approvals, `workflow_execution` when the user
// wants a runtime grant for the rest of the execution. `nodeId` narrows a
// `workflow_execution` grant to the specific foreach body (or other
// repeating node), so "Approve remaining rows" doesn't bleed across other
// approval nodes that share the same service+actionId.
const approvalDecisionSchema = z.object({
  reason: z.string().optional(),
  scope: z.enum(['once', 'workflow_execution']).optional(),
  nodeId: z.string().optional(),
});

executionsRouter.post(
  '/:id/approvals/:approvalId/approve',
  zValidator('json', approvalDecisionSchema),
  async (c) => runResolveApproval(c, 'approved', c.req.valid('json')),
);

executionsRouter.post(
  '/:id/approvals/:approvalId/deny',
  zValidator('json', approvalDecisionSchema),
  async (c) => runResolveApproval(c, 'denied', c.req.valid('json')),
);

async function runResolveApproval(
  c: ExecutionsRouteContext,
  result: 'approved' | 'denied',
  body: { reason?: string; scope?: 'once' | 'workflow_execution'; nodeId?: string },
) {
  const { id: executionId, approvalId } = c.req.param();
  const user = c.get('user');

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
    ...(body.scope !== undefined ? { scope: body.scope } : {}),
    ...(body.nodeId !== undefined ? { nodeId: body.nodeId } : {}),
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
