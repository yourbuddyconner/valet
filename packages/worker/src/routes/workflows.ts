import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { NotFoundError } from '@valet/shared';
import type { Env, Variables } from '../env.js';
import {
  parseJsonObject,
  listWorkflows,
  getWorkflowByIdOrSlug,
  getWorkflowOwnerCheck,
  listWorkflowExecutions,
  listWorkflowProposals,
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

const createProposalSchema = z.object({
  executionId: z.string().optional(),
  proposedBySessionId: z.string().optional(),
  baseWorkflowHash: z.string().min(1),
  proposal: z.record(z.unknown()),
  diffText: z.string().optional(),
  expiresAt: z.string().optional(),
});

const reviewProposalSchema = z.object({
  approve: z.boolean(),
  notes: z.string().optional(),
});

const applyProposalSchema = z.object({
  reviewNotes: z.string().optional(),
  version: z.string().optional(),
});

const rollbackWorkflowSchema = z.object({
  targetWorkflowHash: z.string().min(1),
  version: z.string().optional(),
  notes: z.string().optional(),
});

/**
 * GET /api/workflows
 * List user's workflows
 */
workflowsRouter.get('/', async (c) => {
  const user = c.get('user');

  const result = await listWorkflows(c.get('db'), user.id);

  const workflows = result.results.map((row) => ({
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    version: row.version,
    data: JSON.parse(row.data as string),
    enabled: Boolean(row.enabled),
    tags: row.tags ? JSON.parse(row.tags as string) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  return c.json({ workflows });
});

/**
 * GET /api/workflows/:id
 * Get a single workflow by ID or slug
 */
workflowsRouter.get('/:id', async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');

  const row = await getWorkflowByIdOrSlug(c.get('db'), user.id, id);

  if (!row) {
    throw new NotFoundError('Workflow', id);
  }

  return c.json({
    workflow: {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      version: row.version,
      data: JSON.parse(row.data as string),
      enabled: Boolean(row.enabled),
      tags: row.tags ? JSON.parse(row.tags as string) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
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
  const { id } = c.req.param();
  const user = c.get('user');
  const body = c.req.valid('json');

  const result = await workflowService.updateWorkflow(c.env, user.id, id, body);
  return c.json(result);
});

/**
 * DELETE /api/workflows/:id
 * Delete a workflow
 */
workflowsRouter.delete('/:id', async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');

  await workflowService.deleteWorkflow(c.get('db'), user.id, id);
  return c.json({ success: true });
});

/**
 * GET /api/workflows/:id/executions
 * Get execution history for a workflow
 */
workflowsRouter.get('/:id/executions', async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');
  const { limit, offset } = c.req.query();

  const workflow = await getWorkflowOwnerCheck(c.get('db'), user.id, id);

  if (!workflow) {
    throw new NotFoundError('Workflow', id);
  }

  const result = await listWorkflowExecutions(c.env.DB, workflow.id, user.id, {
    limit: parseInt(limit || '50'),
    offset: parseInt(offset || '0'),
  });

  const executions = result.results.map((row) => ({
    id: row.id,
    workflowId: row.workflow_id,
    sessionId: row.session_id,
    triggerId: row.trigger_id,
    status: row.status,
    triggerType: row.trigger_type,
    triggerMetadata: row.trigger_metadata ? JSON.parse(row.trigger_metadata as string) : null,
    resumeToken: row.resume_token || null,
    variables: row.variables ? JSON.parse(row.variables as string) : null,
    outputs: row.outputs ? JSON.parse(row.outputs as string) : null,
    steps: row.steps ? JSON.parse(row.steps as string) : null,
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }));

  return c.json({ executions });
});

/**
 * GET /api/workflows/:id/history
 * List immutable workflow definition snapshots.
 */
workflowsRouter.get('/:id/history', async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');
  const { limit, offset } = c.req.query();

  const result = await workflowService.getWorkflowHistoryWithSnapshot(c.get('db'), user.id, id, {
    limit: limit ? parseInt(limit, 10) : undefined,
    offset: offset ? parseInt(offset, 10) : undefined,
  });

  if (!result) {
    throw new NotFoundError('Workflow', id);
  }

  return c.json(result);
});

/**
 * GET /api/workflows/:id/proposals
 * List self-modification proposals for a workflow.
 */
workflowsRouter.get('/:id/proposals', async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');
  const { limit, offset, status } = c.req.query();

  const workflow = await getWorkflowOwnerCheck(c.get('db'), user.id, id);

  if (!workflow) {
    throw new NotFoundError('Workflow', id);
  }

  const result = await listWorkflowProposals(c.env.DB, workflow.id, {
    limit: parseInt(limit || '50', 10),
    offset: parseInt(offset || '0', 10),
    status,
  });

  const proposals = result.results.map((row) => ({
    id: row.id,
    workflowId: row.workflow_id,
    executionId: row.execution_id,
    proposedBySessionId: row.proposed_by_session_id,
    baseWorkflowHash: row.base_workflow_hash,
    proposal: parseJsonObject(row.proposal_json as string),
    diffText: row.diff_text,
    status: row.status,
    reviewNotes: row.review_notes,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }));

  return c.json({ proposals });
});

/**
 * POST /api/workflows/:id/proposals
 * Create a self-modification proposal.
 */
workflowsRouter.post('/:id/proposals', zValidator('json', createProposalSchema), async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');
  const body = c.req.valid('json');

  const result = await workflowService.createProposal(c.get('db'), user.id, id, body);
  return c.json(result, 201);
});

/**
 * POST /api/workflows/:id/proposals/:proposalId/review
 * Approve or reject a proposal before apply.
 */
workflowsRouter.post('/:id/proposals/:proposalId/review', zValidator('json', reviewProposalSchema), async (c) => {
  const { id, proposalId } = c.req.param();
  const user = c.get('user');
  const body = c.req.valid('json');

  const result = await workflowService.reviewProposal(c.get('db'), user.id, id, proposalId, body.approve, body.notes);
  return c.json({ success: true, status: result.status, reviewedAt: result.reviewedAt });
});

/**
 * POST /api/workflows/:id/proposals/:proposalId/apply
 * Apply an approved proposal to the workflow definition.
 */
workflowsRouter.post('/:id/proposals/:proposalId/apply', zValidator('json', applyProposalSchema), async (c) => {
  const { id, proposalId } = c.req.param();
  const user = c.get('user');
  const body = c.req.valid('json');

  const result = await workflowService.applyProposal(c.get('db'), user.id, id, proposalId, body);

  if (result.alreadyApplied) {
    return c.json({ success: true, status: 'applied', message: 'Proposal already applied' });
  }

  return c.json({
    success: true,
    proposalId: result.proposalId,
    workflow: result.workflow,
  });
});

/**
 * POST /api/workflows/:id/rollback
 * Roll back workflow definition to a historical snapshot hash.
 */
workflowsRouter.post('/:id/rollback', zValidator('json', rollbackWorkflowSchema), async (c) => {
  const { id } = c.req.param();
  const user = c.get('user');
  const body = c.req.valid('json');

  const result = await workflowService.rollbackWorkflow(c.get('db'), user.id, id, body.targetWorkflowHash, {
    version: body.version,
    notes: body.notes,
  });

  if (result.alreadyAtVersion) {
    return c.json({
      success: true,
      message: 'Workflow already at requested version',
      workflow: result.workflow,
    });
  }

  return c.json({
    success: true,
    workflow: result.workflow,
  });
});
