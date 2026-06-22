import { NotFoundError, ValidationError, type WorkflowDefinition } from '@valet/shared';
import type { Env } from '../env.js';
import type { AppDb } from '../lib/drizzle.js';
import { getDb } from '../lib/drizzle.js';
import { workflows as workflowsTable } from '../lib/schema/workflows.js';
import { validateDefinition } from '../lib/workflow-dag/validator.js';
import {
  upsertWorkflow,
  getExistingWorkflowIds,
  deleteWorkflowById,
  getWorkflowByIdOrSlug,
  getWorkflowById,
  getWorkflowOwnerCheck,
  isWorkflowPublished,
  updateWorkflow as dbUpdateWorkflow,
  deleteWorkflowTriggers,
  deleteWorkflowByIdOrSlug,
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

function assertValidDefinition(label: string, data: Record<string, unknown>): void {
  const errors = validateDefinition(data);
  if (errors.length > 0) {
    const first = errors[0];
    throw new ValidationError(`Invalid workflow definition${label ? ` for "${label}"` : ''}: ${first.message}`);
  }
}

export async function syncWorkflow(
  database: AppDb,
  userId: string,
  params: SyncWorkflowParams,
): Promise<{ id: string }> {
  const now = new Date().toISOString();
  assertValidDefinition(params.name, params.data);

  // Cross-tenant guard: if a workflow with this id already exists and
  // belongs to someone else, refuse. The upsert's ON CONFLICT clause
  // only updates non-ownership columns, so without this check user B
  // could overwrite user A's workflow's data by calling /sync with the
  // same id.
  const existing = await getWorkflowById(database, params.id);
  if (existing && existing.id && (await (async () => {
    const owner = await getWorkflowOwnerCheck(database, userId, existing.id);
    return !owner;
  })())) {
    throw new ValidationError(`Workflow id "${params.id}" is owned by another user`);
  }

  // Definition consistency: once a workflow has a published version,
  // workflow_definition_versions.definition is the authoritative read
  // surface. /sync writing to workflows.data after publish would create
  // a silent drift between the plugin-sync write surface and what
  // triggers actually run. Force authors to use /draft + /publish instead.
  if (existing?.published_version_id) {
    throw new ValidationError(
      `Workflow "${params.id}" has a published version; use /draft + /publish to update it`,
    );
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

  // Pre-flight: validate every payload AND reject any incoming id whose
  // existing row already has a published version. Both checks happen
  // before any writes so a partial batch can't leave the DB
  // inconsistent. Cross-tenant collision is also rejected up front.
  for (const wf of workflows) {
    assertValidDefinition(wf.name, wf.data);
    const existing = await getWorkflowById(database, wf.id);
    if (existing) {
      const isOwner = await getWorkflowOwnerCheck(database, userId, existing.id);
      if (!isOwner) {
        throw new ValidationError(`Workflow id "${wf.id}" is owned by another user`);
      }
      if (existing.published_version_id) {
        throw new ValidationError(
          `Workflow "${wf.id}" has a published version; use /draft + /publish to update it`,
        );
      }
    }
  }

  const incomingIds = new Set<string>();
  for (const wf of workflows) {
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
  }

  // Remove workflows that no longer exist in the plugin. Skip any
  // workflow with published versions — the BEFORE DELETE trigger
  // (migration 0025) would abort the DELETE and leave sync in a
  // partially-applied state. The audit chain on
  // workflow_definition_versions is meant to outlive plugin churn,
  // so we preserve the workflow row rather than wiping its history.
  let skippedPublished = 0;
  for (const existingId of existingIds) {
    if (incomingIds.has(existingId as string)) continue;
    if (await isWorkflowPublished(database, existingId as string)) {
      skippedPublished++;
      continue;
    }
    await deleteWorkflowById(database, existingId as string, userId);
  }
  if (skippedPublished > 0) {
    console.log(
      `[syncAllWorkflows] preserved ${skippedPublished} workflow(s) with published versions (orphaned by plugin sync)`,
    );
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
  publishedVersionId: unknown;
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
    publishedVersionId: row.published_version_id ?? null,
  };
}

function createBlankDefinition(): WorkflowDefinition {
  return {
    version: 'dag/v1',
    nodes: [{ id: 'start', type: 'set', values: {} }],
    edges: [],
    ui: { nodes: { start: { position: { x: 0, y: 0 } } } },
  };
}

export interface CreateWorkflowParams {
  name: string;
  description?: string | null;
  slug?: string | null;
}

export async function createWorkflow(
  database: AppDb,
  userId: string,
  params: CreateWorkflowParams,
): Promise<{ workflow: WorkflowResponse }> {
  const now = new Date().toISOString();
  const id = crypto.randomUUID();
  const definition = createBlankDefinition();
  const serializedDefinition = JSON.stringify(definition);

  await database.insert(workflowsTable).values({
    id,
    userId,
    slug: params.slug || null,
    name: params.name,
    description: params.description || null,
    version: '1.0.0',
    data: serializedDefinition,
    draftDefinition: serializedDefinition,
    publishedVersionId: null,
    enabled: true,
    tags: JSON.stringify([]),
    createdAt: now,
    updatedAt: now,
  });

  return {
    workflow: {
      id,
      slug: params.slug || null,
      name: params.name,
      description: params.description || null,
      version: '1.0.0',
      data: definition,
      enabled: true,
      tags: [],
      createdAt: now,
      updatedAt: now,
      publishedVersionId: null,
    },
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

  // Definition consistency: reject body.data writes when the workflow
  // has a published version. Other field updates (name, slug, enabled,
  // tags) still flow through unblocked.
  if (body.data !== undefined && await isWorkflowPublished(database, existing.id as string)) {
    throw new ValidationError(
      `Workflow "${workflowIdOrSlug}" has a published version; use /draft + /publish to change its definition`,
    );
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

  await dbUpdateWorkflow(env.DB, existing.id as string, userId, updates, values);

  const updated = await getWorkflowById(database, existing.id as string);

  return { workflow: formatWorkflowRow(updated as unknown as Record<string, unknown>) };
}

// ─── Delete Workflow ────────────────────────────────────────────────────────

export async function deleteWorkflow(
  database: AppDb,
  userId: string,
  workflowIdOrSlug: string,
): Promise<void> {
  // DELETE cascades to workflow_definition_versions via the FK in
  // 0020_workflows_dag_v1. Execution history survives —
  // workflow_executions.workflow_id is ON DELETE SET NULL and each row
  // carries its own definition_snapshot.
  await deleteWorkflowTriggers(database, workflowIdOrSlug, userId);

  const result = await deleteWorkflowByIdOrSlug(database, workflowIdOrSlug, userId);

  // better-sqlite3 (tests) exposes `changes`; D1's drizzle adapter
  // exposes it under `meta.changes`. Treat either shape as the source
  // of truth.
  const changes = (result as { changes?: number; meta?: { changes?: number } }).changes
    ?? (result as { meta?: { changes?: number } }).meta?.changes
    ?? 0;
  if (changes === 0) {
    throw new NotFoundError('Workflow', workflowIdOrSlug);
  }
}
