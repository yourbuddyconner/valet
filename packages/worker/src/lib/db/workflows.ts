import type { D1Database } from '@cloudflare/workers-types';
import { ValidationError } from '@valet/shared';
import { eq, and, or, sql, desc } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { workflows, triggers, workflowMutationProposals, workflowVersionHistory } from '../schema/index.js';
import { sha256Hex } from '../workflow-runtime.js';

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_PROPOSAL_TTL_MS = 14 * 24 * 60 * 60 * 1000;

// ─── Pure Helpers ────────────────────────────────────────────────────────────

export function normalizeHash(value: string): string {
  const trimmed = value.trim();
  if (!trimmed) return 'sha256:';
  return trimmed.startsWith('sha256:') ? trimmed : `sha256:${trimmed}`;
}

export function parseJsonObject(raw: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

export function extractProposedWorkflow(proposal: Record<string, unknown>): Record<string, unknown> | null {
  const candidates: unknown[] = [
    proposal.proposedWorkflow,
    (proposal.proposal as Record<string, unknown> | undefined)?.proposedWorkflow,
    proposal.workflow,
  ];

  for (const candidate of candidates) {
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate)) {
      return candidate as Record<string, unknown>;
    }
  }

  if (Array.isArray((proposal as Record<string, unknown>).steps)) {
    return proposal;
  }

  return null;
}

export function bumpPatchVersion(version: string | null): string {
  const fallback = '1.0.0';
  const source = (version || fallback).trim();
  const parts = source.split('.');
  if (parts.length !== 3) return `${source}.1`;

  const major = Number.parseInt(parts[0], 10);
  const minor = Number.parseInt(parts[1], 10);
  const patch = Number.parseInt(parts[2], 10);
  if (!Number.isInteger(major) || !Number.isInteger(minor) || !Number.isInteger(patch)) {
    return `${source}.1`;
  }
  return `${major}.${minor}.${patch + 1}`;
}

export function workflowAllowsSelfModification(rawWorkflowData: string): boolean {
  const workflowData = parseJsonObject(rawWorkflowData);
  const constraints = workflowData.constraints;
  if (!constraints || typeof constraints !== 'object' || Array.isArray(constraints)) {
    return false;
  }

  return (constraints as Record<string, unknown>).allowSelfModification === true;
}

export function resolveProposalExpiry(expiresAt?: string): string {
  if (!expiresAt) {
    return new Date(Date.now() + DEFAULT_PROPOSAL_TTL_MS).toISOString();
  }

  const parsed = new Date(expiresAt);
  if (Number.isNaN(parsed.getTime())) {
    throw new ValidationError('Invalid expiresAt timestamp');
  }
  if (parsed.getTime() <= Date.now()) {
    throw new ValidationError('Proposal expiry must be in the future');
  }
  return parsed.toISOString();
}

// ─── Row Types ───────────────────────────────────────────────────────────────

export interface WorkflowRow {
  id: string;
  slug: string | null;
  name: string;
  description: string | null;
  version: string | null;
  data: string;
  enabled: number;
  tags: string | null;
  created_at: string;
  updated_at: string;
}

export interface ProposalRow {
  id: string;
  workflow_id: string;
  execution_id: string | null;
  proposed_by_session_id: string | null;
  base_workflow_hash: string;
  proposal_json: string;
  diff_text: string | null;
  status: string;
  review_notes: string | null;
  expires_at: string | null;
  created_at: string;
  updated_at: string;
}

// ─── Data Access ─────────────────────────────────────────────────────────────

export async function listWorkflows(db: AppDb, userId: string) {
  return { results: await db
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
      description: workflows.description,
      version: workflows.version,
      data: workflows.data,
      enabled: workflows.enabled,
      tags: workflows.tags,
      created_at: workflows.createdAt,
      updated_at: workflows.updatedAt,
    })
    .from(workflows)
    .where(eq(workflows.userId, userId))
    .orderBy(desc(workflows.updatedAt)),
  };
}

export async function getWorkflowByIdOrSlug(db: AppDb, userId: string, idOrSlug: string) {
  return db
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
      description: workflows.description,
      version: workflows.version,
      data: workflows.data,
      enabled: workflows.enabled,
      tags: workflows.tags,
      created_at: workflows.createdAt,
      updated_at: workflows.updatedAt,
    })
    .from(workflows)
    .where(and(or(eq(workflows.id, idOrSlug), eq(workflows.slug, idOrSlug)), eq(workflows.userId, userId)))
    .get();
}

export async function getWorkflowByIdOrSlugTyped<T>(db: AppDb, userId: string, idOrSlug: string) {
  return db
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
      description: workflows.description,
      version: workflows.version,
      data: workflows.data,
      enabled: workflows.enabled,
      tags: workflows.tags,
      created_at: workflows.createdAt,
      updated_at: workflows.updatedAt,
    })
    .from(workflows)
    .where(and(or(eq(workflows.id, idOrSlug), eq(workflows.slug, idOrSlug)), eq(workflows.userId, userId)))
    .get() as T | undefined;
}

export async function upsertWorkflow(
  db: AppDb,
  params: {
    id: string;
    userId: string;
    slug: string | null;
    name: string;
    description: string | null;
    version: string;
    data: string;
    now: string;
  }
) {
  await db.insert(workflows).values({
    id: params.id,
    userId: params.userId,
    slug: params.slug,
    name: params.name,
    description: params.description,
    version: params.version,
    data: sql`${params.data}`,
    enabled: true,
    updatedAt: params.now,
    createdAt: params.now,
  }).onConflictDoUpdate({
    target: workflows.id,
    set: {
      slug: sql`excluded.slug`,
      name: sql`excluded.name`,
      description: sql`excluded.description`,
      version: sql`excluded.version`,
      data: sql`excluded.data`,
      updatedAt: sql`excluded.updated_at`,
    },
  });
}

export async function getExistingWorkflowIds(db: AppDb, userId: string) {
  const rows = await db
    .select({ id: workflows.id })
    .from(workflows)
    .where(eq(workflows.userId, userId));
  return new Set(rows.map((r) => r.id));
}

export async function deleteWorkflowById(db: AppDb, workflowId: string, userId: string) {
  return db
    .delete(workflows)
    .where(and(eq(workflows.id, workflowId), eq(workflows.userId, userId)));
}

export async function updateWorkflow(db: D1Database, workflowId: string, setClauses: string[], values: unknown[]) {
  await db.prepare(`
    UPDATE workflows SET ${setClauses.join(', ')} WHERE id = ?
  `).bind(...values).run();
}

export async function getWorkflowById(db: AppDb, workflowId: string) {
  return db
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
      description: workflows.description,
      version: workflows.version,
      data: workflows.data,
      enabled: workflows.enabled,
      tags: workflows.tags,
      created_at: workflows.createdAt,
      updated_at: workflows.updatedAt,
    })
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .get();
}

export async function deleteWorkflowTriggers(db: AppDb, workflowId: string, userId: string) {
  await db
    .delete(triggers)
    .where(and(eq(triggers.workflowId, workflowId), eq(triggers.userId, userId)));
}

export async function deleteWorkflowByIdOrSlug(db: AppDb, idOrSlug: string, userId: string) {
  return db
    .delete(workflows)
    .where(and(or(eq(workflows.id, idOrSlug), eq(workflows.slug, idOrSlug)), eq(workflows.userId, userId)));
}

export async function getWorkflowOwnerCheck(db: AppDb, userId: string, idOrSlug: string) {
  return db
    .select({ id: workflows.id })
    .from(workflows)
    .where(and(or(eq(workflows.id, idOrSlug), eq(workflows.slug, idOrSlug)), eq(workflows.userId, userId)))
    .get();
}

// ─── Execution History ───────────────────────────────────────────────────────

export async function listWorkflowExecutions(
  db: D1Database,
  workflowId: string,
  userId: string,
  opts: { limit?: number; offset?: number } = {}
) {
  return db.prepare(`
    SELECT id, workflow_id, session_id, trigger_id, status, trigger_type, trigger_metadata,
           resume_token,
           variables, outputs, steps, error, started_at, completed_at
    FROM workflow_executions
    WHERE workflow_id = ? AND user_id = ?
    ORDER BY started_at DESC
    LIMIT ? OFFSET ?
  `).bind(workflowId, userId, opts.limit ?? 50, opts.offset ?? 0).all();
}

// ─── Version History ─────────────────────────────────────────────────────────

export async function saveWorkflowHistorySnapshot(
  db: AppDb,
  params: {
    workflowId: string;
    workflowVersion: string | null;
    workflowData: string;
    source: 'sync' | 'update' | 'proposal_apply' | 'rollback' | 'system';
    sourceProposalId?: string | null;
    notes?: string | null;
    createdBy?: string | null;
    createdAt?: string;
  }
): Promise<string> {
  const workflowHash = normalizeHash(await sha256Hex(params.workflowData));
  const createdAt = params.createdAt || new Date().toISOString();

  await db.insert(workflowVersionHistory).values({
    id: crypto.randomUUID(),
    workflowId: params.workflowId,
    workflowVersion: params.workflowVersion,
    workflowHash,
    workflowData: sql`${params.workflowData}`,
    source: params.source,
    sourceProposalId: params.sourceProposalId || null,
    notes: params.notes || null,
    createdBy: params.createdBy || null,
    createdAt,
  }).onConflictDoNothing({
    target: [workflowVersionHistory.workflowId, workflowVersionHistory.workflowHash],
  });

  return workflowHash;
}

export async function getWorkflowForHistory(db: AppDb, userId: string, idOrSlug: string) {
  return db
    .select({
      id: workflows.id,
      version: workflows.version,
      data: workflows.data,
      updated_at: workflows.updatedAt,
    })
    .from(workflows)
    .where(and(or(eq(workflows.id, idOrSlug), eq(workflows.slug, idOrSlug)), eq(workflows.userId, userId)))
    .get();
}

export async function listWorkflowHistory(
  db: AppDb,
  workflowId: string,
  opts: { limit?: number; offset?: number } = {}
) {
  const rows = await db
    .select({
      id: workflowVersionHistory.id,
      workflow_id: workflowVersionHistory.workflowId,
      workflow_version: workflowVersionHistory.workflowVersion,
      workflow_hash: workflowVersionHistory.workflowHash,
      workflow_data: workflowVersionHistory.workflowData,
      source: workflowVersionHistory.source,
      source_proposal_id: workflowVersionHistory.sourceProposalId,
      notes: workflowVersionHistory.notes,
      created_by: workflowVersionHistory.createdBy,
      created_at: workflowVersionHistory.createdAt,
    })
    .from(workflowVersionHistory)
    .where(eq(workflowVersionHistory.workflowId, workflowId))
    .orderBy(desc(workflowVersionHistory.createdAt))
    .limit(opts.limit ?? 50)
    .offset(opts.offset ?? 0);

  return { results: rows };
}

// ─── Proposals ───────────────────────────────────────────────────────────────

export async function getWorkflowForProposalCheck(db: AppDb, userId: string, idOrSlug: string) {
  return db
    .select({ id: workflows.id, data: workflows.data })
    .from(workflows)
    .where(and(or(eq(workflows.id, idOrSlug), eq(workflows.slug, idOrSlug)), eq(workflows.userId, userId)))
    .get();
}

export async function listWorkflowProposals(
  db: D1Database,
  workflowId: string,
  opts: { limit?: number; offset?: number; status?: string } = {}
) {
  const params: unknown[] = [workflowId];
  let query = `
    SELECT id, workflow_id, execution_id, proposed_by_session_id, base_workflow_hash, proposal_json,
           diff_text, status, review_notes, expires_at, created_at, updated_at
    FROM workflow_mutation_proposals
    WHERE workflow_id = ?
  `;

  if (opts.status) {
    query += ' AND status = ?';
    params.push(opts.status);
  }

  query += ' ORDER BY created_at DESC LIMIT ? OFFSET ?';
  params.push(opts.limit ?? 50, opts.offset ?? 0);

  return db.prepare(query).bind(...params).all();
}

export async function insertProposal(
  db: AppDb,
  params: {
    id: string;
    workflowId: string;
    executionId: string | null;
    proposedBySessionId: string | null;
    baseWorkflowHash: string;
    proposalJson: string;
    diffText: string | null;
    expiresAt: string;
    now: string;
  }
) {
  await db.insert(workflowMutationProposals).values({
    id: params.id,
    workflowId: params.workflowId,
    executionId: params.executionId,
    proposedBySessionId: params.proposedBySessionId,
    baseWorkflowHash: params.baseWorkflowHash,
    proposalJson: params.proposalJson,
    diffText: params.diffText,
    status: 'pending',
    expiresAt: params.expiresAt,
    createdAt: params.now,
    updatedAt: params.now,
  });
}

export async function getProposalForReview(db: AppDb, proposalId: string, workflowId: string) {
  return db
    .select({ id: workflowMutationProposals.id, status: workflowMutationProposals.status })
    .from(workflowMutationProposals)
    .where(and(eq(workflowMutationProposals.id, proposalId), eq(workflowMutationProposals.workflowId, workflowId)))
    .get();
}

export async function updateProposalStatus(
  db: AppDb,
  proposalId: string,
  status: string,
  reviewNotes: string | null,
  now: string
) {
  await db
    .update(workflowMutationProposals)
    .set({ status, reviewNotes, updatedAt: now })
    .where(eq(workflowMutationProposals.id, proposalId));
}

export async function getProposalForApply(db: AppDb, proposalId: string, workflowId: string) {
  return db
    .select({
      id: workflowMutationProposals.id,
      workflow_id: workflowMutationProposals.workflowId,
      base_workflow_hash: workflowMutationProposals.baseWorkflowHash,
      proposal_json: workflowMutationProposals.proposalJson,
      status: workflowMutationProposals.status,
      expires_at: workflowMutationProposals.expiresAt,
      review_notes: workflowMutationProposals.reviewNotes,
    })
    .from(workflowMutationProposals)
    .where(and(eq(workflowMutationProposals.id, proposalId), eq(workflowMutationProposals.workflowId, workflowId)))
    .get();
}

export async function applyWorkflowUpdate(
  db: AppDb,
  workflowId: string,
  data: string,
  version: string,
  now: string
) {
  await db
    .update(workflows)
    .set({ data, version, updatedAt: now })
    .where(eq(workflows.id, workflowId));
}

export async function markProposalApplied(
  db: AppDb,
  proposalId: string,
  reviewNotes: string | null,
  now: string
) {
  await db
    .update(workflowMutationProposals)
    .set({ status: 'applied', reviewNotes, updatedAt: now })
    .where(eq(workflowMutationProposals.id, proposalId));
}

// ─── Rollback ────────────────────────────────────────────────────────────────

export async function getWorkflowForRollback(db: AppDb, userId: string, idOrSlug: string) {
  return db
    .select({
      id: workflows.id,
      slug: workflows.slug,
      name: workflows.name,
      description: workflows.description,
      version: workflows.version,
      data: workflows.data,
      enabled: workflows.enabled,
      tags: workflows.tags,
      created_at: workflows.createdAt,
    })
    .from(workflows)
    .where(and(or(eq(workflows.id, idOrSlug), eq(workflows.slug, idOrSlug)), eq(workflows.userId, userId)))
    .get();
}

export async function getHistoryByHash(db: AppDb, workflowId: string, hash: string) {
  return db
    .select({
      workflow_version: workflowVersionHistory.workflowVersion,
      workflow_hash: workflowVersionHistory.workflowHash,
      workflow_data: workflowVersionHistory.workflowData,
    })
    .from(workflowVersionHistory)
    .where(and(eq(workflowVersionHistory.workflowId, workflowId), eq(workflowVersionHistory.workflowHash, hash)))
    .limit(1)
    .get();
}
