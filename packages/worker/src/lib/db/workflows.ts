import type { D1Database } from '@cloudflare/workers-types';
import { eq, and, or, sql, desc } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { workflows, triggers, workflowExecutions } from '../schema/index.js';

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
  published_version_id: string | null;
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
      published_version_id: workflows.publishedVersionId,
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
      published_version_id: workflows.publishedVersionId,
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
    // WHERE clause restricts the update to the row's existing owner so
    // a /sync call from user B can't overwrite user A's workflow with
    // the same id. A cross-tenant id collision silently no-ops (the
    // caller already gates with getWorkflowOwnerCheck for a 4xx error).
    setWhere: sql`${workflows.userId} = ${params.userId}`,
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

export async function updateWorkflow(
  db: D1Database,
  workflowId: string,
  userId: string,
  setClauses: string[],
  values: unknown[],
) {
  // Defense in depth: the route already user-scopes the workflow lookup,
  // but appending `AND user_id = ?` here means a forgotten or mis-routed
  // call site still can't cross tenants — silent no-op instead of a
  // cross-tenant write.
  await db.prepare(`
    UPDATE workflows SET ${setClauses.join(', ')} WHERE id = ? AND user_id = ?
  `).bind(...values, userId).run();
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
      published_version_id: workflows.publishedVersionId,
      created_at: workflows.createdAt,
      updated_at: workflows.updatedAt,
    })
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .get();
}

export async function isWorkflowPublished(db: AppDb, workflowId: string): Promise<boolean> {
  const row = await db
    .select({ publishedVersionId: workflows.publishedVersionId })
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .get();
  return Boolean(row?.publishedVersionId);
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
    SELECT id, workflow_id, trigger_id, status, trigger_type, trigger_metadata,
           inputs, outputs, error, started_at, completed_at
    FROM workflow_executions
    WHERE workflow_id = ? AND user_id = ?
    ORDER BY started_at DESC
    LIMIT ? OFFSET ?
  `).bind(workflowId, userId, opts.limit ?? 50, opts.offset ?? 0).all();
}

export async function getWorkflowNameByExecutionId(
  db: AppDb,
  executionId: string,
): Promise<string | null> {
  const row = await db
    .select({ name: workflows.name })
    .from(workflowExecutions)
    .innerJoin(workflows, eq(workflowExecutions.workflowId, workflows.id))
    .where(eq(workflowExecutions.id, executionId))
    .get();
  return row?.name ?? null;
}
