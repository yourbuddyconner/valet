import { NotFoundError, ValidationError } from '@valet/shared';
import type { Env } from '../env.js';
import type { AppDb } from '../lib/drizzle.js';
import { getDb } from '../lib/drizzle.js';
import { sha256Hex } from '../lib/workflow-runtime.js';
import { validateWorkflowDefinition } from '../lib/workflow-definition.js';
import {
  normalizeHash,
  parseJsonObject,
  extractProposedWorkflow,
  bumpPatchVersion,
  workflowAllowsSelfModification,
  resolveProposalExpiry,
  saveWorkflowHistorySnapshot,
  upsertWorkflow,
  getExistingWorkflowIds,
  deleteWorkflowById,
  getWorkflowByIdOrSlug,
  getWorkflowByIdOrSlugTyped,
  getWorkflowById,
  updateWorkflow as dbUpdateWorkflow,
  deleteWorkflowTriggers,
  deleteWorkflowByIdOrSlug,
  getWorkflowForProposalCheck,
  getWorkflowForHistory,
  listWorkflowHistory,
  getWorkflowOwnerCheck,
  insertProposal,
  getProposalForReview,
  updateProposalStatus,
  getProposalForApply,
  applyWorkflowUpdate,
  markProposalApplied,
  getWorkflowForRollback,
  getHistoryByHash,
} from '../lib/db.js';

// ─── Sync Workflow ──────────────────────────────────────────────────────────

export interface SyncWorkflowParams {
  id: string;
  slug?: string;
  name: string;
  description?: string;
  version: string;
  data: Record<string, unknown>;
}

export async function syncWorkflow(
  database: AppDb,
  userId: string,
  params: SyncWorkflowParams,
): Promise<{ id: string }> {
  const now = new Date().toISOString();
  const validation = validateWorkflowDefinition(params.data);
  if (!validation.valid) {
    throw new ValidationError(`Invalid workflow definition: ${validation.errors[0]}`);
  }

  await upsertWorkflow(database, {
    id: params.id,
    userId,
    slug: params.slug || null,
    name: params.name,
    description: params.description || null,
    version: params.version,
    data: JSON.stringify(params.data),
    now,
  });

  await saveWorkflowHistorySnapshot(database, {
    workflowId: params.id,
    workflowVersion: params.version,
    workflowData: JSON.stringify(params.data),
    source: 'sync',
    createdBy: userId,
    createdAt: now,
  });

  return { id: params.id };
}

// ─── Sync All Workflows ─────────────────────────────────────────────────────

export async function syncAllWorkflows(
  database: AppDb,
  userId: string,
  workflows: SyncWorkflowParams[],
): Promise<{ synced: number }> {
  const now = new Date().toISOString();

  const existingIds = await getExistingWorkflowIds(database, userId);

  const incomingIds = new Set<string>();
  for (const wf of workflows) {
    const validation = validateWorkflowDefinition(wf.data);
    if (!validation.valid) {
      throw new ValidationError(`Invalid workflow definition for "${wf.name}": ${validation.errors[0]}`);
    }

    incomingIds.add(wf.id);
    await upsertWorkflow(database, {
      id: wf.id,
      userId,
      slug: wf.slug || null,
      name: wf.name,
      description: wf.description || null,
      version: wf.version,
      data: JSON.stringify(wf.data),
      now,
    });

    await saveWorkflowHistorySnapshot(database, {
      workflowId: wf.id,
      workflowVersion: wf.version,
      workflowData: JSON.stringify(wf.data),
      source: 'sync',
      createdBy: userId,
      createdAt: now,
    });
  }

  // Remove workflows that no longer exist in the plugin
  for (const existingId of existingIds) {
    if (!incomingIds.has(existingId as string)) {
      await deleteWorkflowById(database, existingId as string, userId);
    }
  }

  return { synced: workflows.length };
}

// ─── Update Workflow ────────────────────────────────────────────────────────

export interface UpdateWorkflowParams {
  name?: string;
  description?: string | null;
  slug?: string | null;
  version?: string;
  enabled?: boolean;
  tags?: string[];
  data?: Record<string, unknown>;
}

interface WorkflowResponse {
  id: string;
  slug: unknown;
  name: unknown;
  description: unknown;
  version: unknown;
  data: unknown;
  enabled: boolean;
  tags: unknown[];
  createdAt: unknown;
  updatedAt: unknown;
}

function formatWorkflowRow(row: Record<string, unknown>): WorkflowResponse {
  return {
    id: row.id as string,
    slug: row.slug,
    name: row.name,
    description: row.description,
    version: row.version,
    data: JSON.parse(row.data as string),
    enabled: Boolean(row.enabled),
    tags: row.tags ? JSON.parse(row.tags as string) : [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

export async function updateWorkflow(
  env: Env,
  userId: string,
  workflowIdOrSlug: string,
  body: UpdateWorkflowParams,
): Promise<{ workflow: WorkflowResponse }> {
  const database = getDb(env.DB);
  const existing = await getWorkflowByIdOrSlug(database, userId, workflowIdOrSlug);

  if (!existing) {
    throw new NotFoundError('Workflow', workflowIdOrSlug);
  }

  const updates: string[] = [];
  const values: unknown[] = [];

  if (body.name !== undefined) {
    updates.push('name = ?');
    values.push(body.name);
  }
  if (body.description !== undefined) {
    updates.push('description = ?');
    values.push(body.description);
  }
  if (body.slug !== undefined) {
    updates.push('slug = ?');
    values.push(body.slug);
  }
  if (body.version !== undefined) {
    updates.push('version = ?');
    values.push(body.version);
  }
  if (body.enabled !== undefined) {
    updates.push('enabled = ?');
    values.push(body.enabled ? 1 : 0);
  }
  if (body.tags !== undefined) {
    updates.push('tags = ?');
    values.push(JSON.stringify(body.tags));
  }
  if (body.data !== undefined) {
    updates.push('data = ?');
    values.push(JSON.stringify(body.data));
  }

  if (updates.length === 0) {
    return { workflow: formatWorkflowRow(existing as unknown as Record<string, unknown>) };
  }

  updates.push('updated_at = ?');
  values.push(new Date().toISOString());
  values.push(existing.id); // For WHERE clause

  await dbUpdateWorkflow(env.DB, existing.id as string, updates, values);

  const updated = await getWorkflowById(database, existing.id as string);

  await saveWorkflowHistorySnapshot(database, {
    workflowId: updated!.id as string,
    workflowVersion: (updated!.version as string | null) || null,
    workflowData: String(updated!.data || '{}'),
    source: 'update',
    createdBy: userId,
    createdAt: String(updated!.updated_at || new Date().toISOString()),
  });

  return { workflow: formatWorkflowRow(updated as unknown as Record<string, unknown>) };
}

// ─── Delete Workflow ────────────────────────────────────────────────────────

export async function deleteWorkflow(
  database: AppDb,
  userId: string,
  workflowIdOrSlug: string,
): Promise<void> {
  await deleteWorkflowTriggers(database, workflowIdOrSlug, userId);

  const result = await deleteWorkflowByIdOrSlug(database, workflowIdOrSlug, userId);

  if (result.meta.changes === 0) {
    throw new NotFoundError('Workflow', workflowIdOrSlug);
  }
}

// ─── Create Proposal ────────────────────────────────────────────────────────

export interface CreateProposalParams {
  executionId?: string;
  proposedBySessionId?: string;
  baseWorkflowHash: string;
  proposal: Record<string, unknown>;
  diffText?: string;
  expiresAt?: string;
}

export async function createProposal(
  database: AppDb,
  userId: string,
  workflowIdOrSlug: string,
  params: CreateProposalParams,
): Promise<{ proposal: Record<string, unknown> }> {
  const workflow = await getWorkflowForProposalCheck(database, userId, workflowIdOrSlug);

  if (!workflow) {
    throw new NotFoundError('Workflow', workflowIdOrSlug);
  }
  if (!workflowAllowsSelfModification(workflow.data)) {
    throw new ValidationError('Self-modification is disabled for this workflow');
  }

  const currentHash = normalizeHash(await sha256Hex(String(workflow.data ?? '{}')));
  const baseHash = normalizeHash(params.baseWorkflowHash);
  if (currentHash !== baseHash) {
    throw new ValidationError('Base workflow hash mismatch; proposal is stale');
  }

  const proposalId = crypto.randomUUID();
  const now = new Date().toISOString();
  const expiresAt = resolveProposalExpiry(params.expiresAt);

  await insertProposal(database, {
    id: proposalId,
    workflowId: workflow.id,
    executionId: params.executionId || null,
    proposedBySessionId: params.proposedBySessionId || null,
    baseWorkflowHash: baseHash,
    proposalJson: JSON.stringify(params.proposal),
    diffText: params.diffText || null,
    expiresAt,
    now,
  });

  return {
    proposal: {
      id: proposalId,
      workflowId: workflow.id,
      executionId: params.executionId || null,
      proposedBySessionId: params.proposedBySessionId || null,
      baseWorkflowHash: baseHash,
      proposal: params.proposal,
      diffText: params.diffText || null,
      status: 'pending',
      reviewNotes: null,
      expiresAt,
      createdAt: now,
      updatedAt: now,
    },
  };
}

// ─── Review Proposal ────────────────────────────────────────────────────────

export async function reviewProposal(
  database: AppDb,
  userId: string,
  workflowIdOrSlug: string,
  proposalId: string,
  approve: boolean,
  notes?: string,
): Promise<{ status: string; reviewedAt: string }> {
  const workflow = await getWorkflowOwnerCheck(database, userId, workflowIdOrSlug);

  if (!workflow) {
    throw new NotFoundError('Workflow', workflowIdOrSlug);
  }

  const proposal = await getProposalForReview(database, proposalId, workflow.id);

  if (!proposal) {
    throw new NotFoundError('Workflow proposal', proposalId);
  }

  if (proposal.status !== 'pending') {
    throw new ValidationError(`Proposal is already ${proposal.status}`);
  }

  const nextStatus = approve ? 'approved' : 'rejected';
  const now = new Date().toISOString();

  await updateProposalStatus(database, proposalId, nextStatus, notes || null, now);

  return { status: nextStatus, reviewedAt: now };
}

// ─── Apply Proposal ─────────────────────────────────────────────────────────

export interface ApplyProposalOpts {
  reviewNotes?: string;
  version?: string;
}

export async function applyProposal(
  database: AppDb,
  userId: string,
  workflowIdOrSlug: string,
  proposalId: string,
  opts: ApplyProposalOpts = {},
): Promise<{ proposalId: string; workflow: WorkflowResponse; alreadyApplied?: boolean }> {
  const workflow = await getWorkflowByIdOrSlugTyped<{
    id: string;
    version: string | null;
    data: string;
    slug: string | null;
    name: string;
    description: string | null;
    enabled: number;
    tags: string | null;
    created_at: string;
    updated_at: string;
  }>(database, userId, workflowIdOrSlug);

  if (!workflow) {
    throw new NotFoundError('Workflow', workflowIdOrSlug);
  }
  if (!workflowAllowsSelfModification(workflow.data)) {
    throw new ValidationError('Self-modification is disabled for this workflow');
  }

  const proposal = await getProposalForApply(database, proposalId, workflow.id);

  if (!proposal) {
    throw new NotFoundError('Workflow proposal', proposalId);
  }

  if (proposal.status === 'applied') {
    return {
      proposalId: proposal.id,
      alreadyApplied: true,
      workflow: {
        id: workflow.id,
        slug: workflow.slug,
        name: workflow.name,
        description: workflow.description,
        version: workflow.version,
        data: JSON.parse(workflow.data),
        enabled: Boolean(workflow.enabled),
        tags: workflow.tags ? JSON.parse(workflow.tags) : [],
        createdAt: workflow.created_at,
        updatedAt: workflow.updated_at,
      },
    };
  }
  if (proposal.status !== 'approved') {
    throw new ValidationError(`Proposal must be approved before apply (current: ${proposal.status})`);
  }
  if (proposal.expires_at && new Date(proposal.expires_at).getTime() < Date.now()) {
    throw new ValidationError('Proposal has expired');
  }

  const currentHash = normalizeHash(await sha256Hex(String(workflow.data ?? '{}')));
  const baseHash = normalizeHash(proposal.base_workflow_hash);
  if (currentHash !== baseHash) {
    throw new ValidationError('Base workflow hash mismatch; proposal is stale');
  }

  const proposalJson = parseJsonObject(proposal.proposal_json);
  const proposedWorkflow = extractProposedWorkflow(proposalJson);
  if (!proposedWorkflow) {
    throw new ValidationError('Proposal missing proposed workflow payload');
  }
  if (!Array.isArray(proposedWorkflow.steps)) {
    throw new ValidationError('Proposed workflow is invalid: steps must be an array');
  }

  const now = new Date().toISOString();
  const nextVersion = opts.version || bumpPatchVersion(workflow.version);

  await saveWorkflowHistorySnapshot(database, {
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    workflowData: workflow.data,
    source: 'proposal_apply',
    sourceProposalId: proposal.id,
    notes: 'Pre-apply snapshot',
    createdBy: userId,
    createdAt: now,
  });

  await applyWorkflowUpdate(database, workflow.id, JSON.stringify(proposedWorkflow), nextVersion, now);

  await markProposalApplied(database, proposal.id, opts.reviewNotes || proposal.review_notes || null, now);

  await saveWorkflowHistorySnapshot(database, {
    workflowId: workflow.id,
    workflowVersion: nextVersion,
    workflowData: JSON.stringify(proposedWorkflow),
    source: 'proposal_apply',
    sourceProposalId: proposal.id,
    notes: opts.reviewNotes || proposal.review_notes || null,
    createdBy: userId,
    createdAt: now,
  });

  return {
    proposalId: proposal.id,
    workflow: {
      id: workflow.id,
      slug: workflow.slug,
      name: workflow.name,
      description: workflow.description,
      version: nextVersion,
      data: proposedWorkflow,
      enabled: Boolean(workflow.enabled),
      tags: workflow.tags ? JSON.parse(workflow.tags) : [],
      createdAt: workflow.created_at,
      updatedAt: now,
    },
  };
}

// ─── Rollback Workflow ──────────────────────────────────────────────────────

export interface RollbackWorkflowOpts {
  version?: string;
  notes?: string;
}

export async function rollbackWorkflow(
  database: AppDb,
  userId: string,
  workflowIdOrSlug: string,
  targetWorkflowHash: string,
  opts: RollbackWorkflowOpts = {},
): Promise<{ workflow: WorkflowResponse; alreadyAtVersion?: boolean }> {
  const workflow = await getWorkflowForRollback(database, userId, workflowIdOrSlug);

  if (!workflow) {
    throw new NotFoundError('Workflow', workflowIdOrSlug);
  }

  await saveWorkflowHistorySnapshot(database, {
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    workflowData: workflow.data,
    source: 'system',
    createdBy: userId,
  });

  const targetHash = normalizeHash(targetWorkflowHash);
  const target = await getHistoryByHash(database, workflow.id, targetHash);

  if (!target) {
    throw new NotFoundError('Workflow history entry', targetHash);
  }

  const parsedTarget = parseJsonObject(target.workflow_data);
  if (!Array.isArray(parsedTarget.steps)) {
    throw new ValidationError('Historical workflow snapshot is invalid');
  }

  const currentHash = normalizeHash(await sha256Hex(String(workflow.data ?? '{}')));
  if (currentHash === targetHash) {
    return {
      alreadyAtVersion: true,
      workflow: {
        id: workflow.id,
        slug: workflow.slug,
        name: workflow.name,
        description: workflow.description,
        version: workflow.version,
        data: parseJsonObject(workflow.data),
        enabled: Boolean(workflow.enabled),
        tags: workflow.tags ? JSON.parse(workflow.tags) : [],
        createdAt: workflow.created_at,
        updatedAt: new Date().toISOString(),
      },
    };
  }

  const now = new Date().toISOString();
  const nextVersion = opts.version || bumpPatchVersion(workflow.version);

  await applyWorkflowUpdate(database, workflow.id, target.workflow_data, nextVersion, now);

  await saveWorkflowHistorySnapshot(database, {
    workflowId: workflow.id,
    workflowVersion: nextVersion,
    workflowData: target.workflow_data,
    source: 'rollback',
    notes: opts.notes || `Rollback to ${target.workflow_hash}`,
    createdBy: userId,
    createdAt: now,
  });

  return {
    workflow: {
      id: workflow.id,
      slug: workflow.slug,
      name: workflow.name,
      description: workflow.description,
      version: nextVersion,
      data: parsedTarget,
      enabled: Boolean(workflow.enabled),
      tags: workflow.tags ? JSON.parse(workflow.tags) : [],
      createdAt: workflow.created_at,
      updatedAt: now,
    },
  };
}

// ─── Get Workflow History With Snapshot ──────────────────────────────────────

export async function getWorkflowHistoryWithSnapshot(
  database: AppDb,
  userId: string,
  idOrSlug: string,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ currentWorkflowHash: string; history: Array<Record<string, unknown>> } | null> {
  const workflow = await getWorkflowForHistory(database, userId, idOrSlug);
  if (!workflow) return null;

  const currentWorkflowHash = await saveWorkflowHistorySnapshot(database, {
    workflowId: workflow.id,
    workflowVersion: workflow.version,
    workflowData: workflow.data,
    source: 'system',
    createdBy: userId,
    createdAt: workflow.updated_at || new Date().toISOString(),
  });

  const list = await listWorkflowHistory(database, workflow.id, {
    limit: opts.limit ?? 50,
    offset: opts.offset ?? 0,
  });

  const history = list.results.map((row) => ({
    id: row.id,
    workflowId: row.workflow_id,
    version: row.workflow_version,
    workflowHash: row.workflow_hash,
    workflowData: parseJsonObject(String(row.workflow_data || '{}')),
    source: row.source,
    sourceProposalId: row.source_proposal_id,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
  }));

  return { currentWorkflowHash, history };
}
