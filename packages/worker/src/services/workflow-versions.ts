/**
 * Draft + published-version workflow authoring service.
 *
 * Three concerns:
 *   - Reading + writing the mutable draft on `workflows.draft_definition`.
 *   - Publishing the draft → an append-only workflow_definition_versions
 *     row + bumping workflows.published_version_id.
 *   - Restoring a previous version into the draft.
 *
 * Validation lives in lib/workflow-dag/validator. Publishing requires
 * a clean validateDefinition; saving a draft does not (drafts can be
 * incomplete).
 */

import { and, eq, desc, inArray } from 'drizzle-orm';
import type { AppDb } from '../lib/drizzle.js';
import { workflows } from '../lib/schema/workflows.js';
import { workflowDefinitionVersions } from '../lib/schema/workflow-definition-versions.js';
import type { AvailableModels, WorkflowDefinition, WorkflowValidationError } from '@valet/shared';
import { validateDefinition, validateAgainstEnvironment, validateAgainstAvailableModels } from '../lib/workflow-dag/validator.js';
import type { Env } from '../env.js';
import { sha256Hex } from '../lib/hash.js';

export class WorkflowVersionError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'invalid_definition'
      | 'invalid_draft'
      | 'publish_contention'
      | 'conflict',
    message: string,
    public readonly errors?: WorkflowValidationError[],
  ) {
    super(message);
    this.name = 'WorkflowVersionError';
  }
}

export interface PublishedVersion {
  id: string;
  version: number;
  definitionHash: string;
  publishNote?: string;
  createdAt: string;
}

export async function getDraft(db: AppDb, workflowId: string): Promise<{
  draft: WorkflowDefinition | null;
  ui: unknown;
  publishedVersionId: string | null;
  /**
   * The row's `updated_at` at read time. Callers that need optimistic-
   * lock semantics for a subsequent `saveDraft` should pass this
   * verbatim to `saveDraft(..., { expectedUpdatedAt })` — reading it
   * from the same query eliminates the TOCTOU window a separate
   * `getWorkflowUpdatedAt` call would open.
   */
  updatedAt: string;
}> {
  const row = await db.select({
    draftDefinition: workflows.draftDefinition,
    ui: workflows.ui,
    publishedVersionId: workflows.publishedVersionId,
    updatedAt: workflows.updatedAt,
  }).from(workflows).where(eq(workflows.id, workflowId)).get();
  if (!row) throw new WorkflowVersionError('not_found', `workflow ${workflowId} not found`);

  return {
    draft: row.draftDefinition ? safeParseJson<WorkflowDefinition>(row.draftDefinition) : null,
    ui: row.ui ? safeParseJson<unknown>(row.ui) : null,
    publishedVersionId: row.publishedVersionId,
    updatedAt: row.updatedAt,
  };
}

export async function saveDraft(
  db: AppDb,
  workflowId: string,
  draft: WorkflowDefinition,
  ui?: unknown,
  opts?: { expectedUpdatedAt?: string },
): Promise<{ updatedAt: string }> {
  // Drafts can be incomplete; saveDraft does NOT enforce validateDefinition.
  // The publish path enforces validation; the editor's validate endpoint
  // surfaces issues before publish.
  //
  // When opts.expectedUpdatedAt is provided we require the row's current
  // updated_at to match — an optimistic lock so two concurrent writers
  // (e.g. two copilot tool calls, or a copilot patch racing a canvas
  // save) can't silently trample each other. When the guard is omitted
  // we do a plain UPDATE for the callers that need last-write-wins.
  const existing = await db
    .select({ id: workflows.id, updatedAt: workflows.updatedAt })
    .from(workflows)
    .where(eq(workflows.id, workflowId))
    .get();
  if (!existing) throw new WorkflowVersionError('not_found', `workflow ${workflowId} not found`);
  if (opts?.expectedUpdatedAt !== undefined && existing.updatedAt !== opts.expectedUpdatedAt) {
    throw new WorkflowVersionError(
      'conflict',
      `draft was modified concurrently — expected updated_at ${opts.expectedUpdatedAt} but found ${existing.updatedAt}`,
    );
  }
  const nextUpdatedAt = new Date().toISOString();
  await db.update(workflows).set({
    draftDefinition: JSON.stringify(draft),
    ui: ui !== undefined ? JSON.stringify(ui) : undefined,
    updatedAt: nextUpdatedAt,
  }).where(eq(workflows.id, workflowId)).run();
  return { updatedAt: nextUpdatedAt };
}


export async function publishDraft(
  db: AppDb,
  workflowId: string,
  opts: { userId: string; publishNote?: string; ui?: string | null; env?: Env; availableModels?: AvailableModels },
): Promise<{ version: PublishedVersion }> {
  const row = await db.select({
    draftDefinition: workflows.draftDefinition,
    data: workflows.data,
    ui: workflows.ui,
  }).from(workflows).where(eq(workflows.id, workflowId)).get();
  if (!row) throw new WorkflowVersionError('not_found', `workflow ${workflowId} not found`);
  if (!row.draftDefinition) {
    throw new WorkflowVersionError('invalid_draft', 'no draft to publish');
  }

  let def: WorkflowDefinition;
  try {
    def = JSON.parse(row.draftDefinition) as WorkflowDefinition;
  } catch (err) {
    throw new WorkflowVersionError('invalid_draft', `draft is not valid JSON: ${err instanceof Error ? err.message : String(err)}`);
  }

  // validateDefinition is total (returns malformed_definition on bad
  // shapes); no try/catch wrapper needed.
  const errors = validateDefinition(def).filter((e) => e.code !== 'llm_maxoutput_warning');
  if (errors.length > 0) {
    throw new WorkflowVersionError('invalid_definition', 'draft failed validation', errors);
  }

  // Env-dependent validation (LLM provider keys, etc.) — same gate as
  // /validate and createExecution. Without this, /publish accepts a
  // workflow that referencing an unconfigured provider, and the
  // execution start path later rejects it with invalid_env.
  if (opts.env) {
    const envErrors = validateAgainstEnvironment(def, opts.env, { availableModels: opts.availableModels });
    if (envErrors.length > 0) {
      throw new WorkflowVersionError(
        'invalid_definition',
        'draft references resources not configured in this environment',
        envErrors,
      );
    }
  }
  if (!opts.env && opts.availableModels) {
    const modelErrors = validateAgainstAvailableModels(def, opts.availableModels);
    if (modelErrors.length > 0) {
      throw new WorkflowVersionError('invalid_definition', 'draft references unavailable LLM models', modelErrors);
    }
  }

  // Refuse to silently flip a workflow whose current `workflows.data` is
  // not a dag/v1 definition. Only dag/v1 is supported; an older shape
  // must be rewritten before it can be published.
  if (row.data) {
    const existing = tryParseExistingVersion(row.data);
    if (existing && existing !== 'dag/v1') {
      throw new WorkflowVersionError(
        'invalid_definition',
        `workflow has a non-dag/v1 definition (version="${existing}"); rewrite it as dag/v1 before publishing`,
      );
    }
  }

  // Strip the `ui` block from the runtime definition before computing
  // the hash so a pure layout edit doesn't change `definition_hash` —
  // version history should track logical-definition drift, not node
  // positions. The ui snapshot lives in its own column.
  const { ui: defUi, ...defWithoutUi } = def;
  const definitionJson = JSON.stringify(defWithoutUi);
  const definitionHash = await sha256Hex(definitionJson);
  const uiSnapshot = opts.ui ?? row.ui ?? (defUi !== undefined ? JSON.stringify(defUi) : null);

  // Re-derive next version under a small retry loop. D1 has no
  // SERIALIZABLE isolation, so two concurrent publishes can both
  // compute the same N+1; the unique (workflow_id, version) index
  // makes the second insert fail and we re-try.
  const MAX_ATTEMPTS = 5;
  let versionId = '';
  let nextVersion = 0;
  let lastErr: unknown;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const latest = await db.select({ version: workflowDefinitionVersions.version })
      .from(workflowDefinitionVersions)
      .where(eq(workflowDefinitionVersions.workflowId, workflowId))
      .orderBy(desc(workflowDefinitionVersions.version))
      .limit(1)
      .get();
    nextVersion = (latest?.version ?? 0) + 1;
    versionId = crypto.randomUUID();
    try {
      await db.insert(workflowDefinitionVersions).values({
        id: versionId,
        workflowId,
        version: nextVersion,
        definition: definitionJson,
        definitionHash,
        validationStatus: 'ok',
        publishNote: opts.publishNote,
        ui: uiSnapshot,
        createdBy: opts.userId,
      }).run();
      lastErr = undefined;
      break;
    } catch (err) {
      lastErr = err;
      const msg = err instanceof Error ? err.message : String(err);
      // SQLite unique-constraint message; retry to pick up the new MAX.
      if (!/UNIQUE/i.test(msg) && !/constraint/i.test(msg)) throw err;
    }
  }
  if (lastErr) {
    throw new WorkflowVersionError(
      'publish_contention',
      `failed to acquire a new version after ${MAX_ATTEMPTS} attempts (concurrent publishes); retry: ${lastErr instanceof Error ? lastErr.message : String(lastErr)}`,
    );
  }

  // Update the workflows row: point published_version_id at the new
  // version + bump updated_at. workflows.version (user-facing semver
  // string) is NOT touched — the publish-sequence number lives in
  // workflow_definition_versions.version, not on workflows itself.
  // workflows.data is also NOT mirrored: the runtime reads from
  // workflow_definition_versions.definition via published_version_id,
  // and mirroring to `data` would let a post-publish /sync call
  // silently change what triggers run.
  await db.update(workflows).set({
    publishedVersionId: versionId,
    updatedAt: new Date().toISOString(),
  }).where(eq(workflows.id, workflowId)).run();

  const createdAt = new Date().toISOString();
  return {
    version: {
      id: versionId,
      version: nextVersion,
      definitionHash,
      ...(opts.publishNote ? { publishNote: opts.publishNote } : {}),
      createdAt,
    },
  };
}

function tryParseExistingVersion(data: string): string | null {
  try {
    const parsed = JSON.parse(data) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : null;
  } catch {
    return null;
  }
}

export async function listVersions(db: AppDb, workflowId: string): Promise<PublishedVersion[]> {
  const rows: Array<{
    id: string;
    version: number;
    definitionHash: string;
    publishNote: string | null;
    createdAt: string;
  }> = await db.select({
    id: workflowDefinitionVersions.id,
    version: workflowDefinitionVersions.version,
    definitionHash: workflowDefinitionVersions.definitionHash,
    publishNote: workflowDefinitionVersions.publishNote,
    createdAt: workflowDefinitionVersions.createdAt,
  }).from(workflowDefinitionVersions)
    .where(eq(workflowDefinitionVersions.workflowId, workflowId))
    .orderBy(desc(workflowDefinitionVersions.version))
    .all();
  return rows.map((r) => ({
    id: r.id,
    version: r.version,
    definitionHash: r.definitionHash,
    ...(r.publishNote ? { publishNote: r.publishNote } : {}),
    createdAt: r.createdAt,
  }));
}

export async function restoreVersion(db: AppDb, workflowId: string, versionId: string): Promise<{ draft: WorkflowDefinition; ui: unknown }> {
  const row = await db.select({
    definition: workflowDefinitionVersions.definition,
    ui: workflowDefinitionVersions.ui,
  })
    .from(workflowDefinitionVersions)
    .where(and(
      eq(workflowDefinitionVersions.workflowId, workflowId),
      eq(workflowDefinitionVersions.id, versionId),
    ))
    .get();
  if (!row) throw new WorkflowVersionError('not_found', `version ${versionId} not found for workflow ${workflowId}`);

  // Compose the returned draft with the saved ui block rehydrated.
  // publishDraft strips def.ui before storing the canonical definition,
  // so the version's `definition` JSON has no ui. Clients reading
  // `draft.ui` directly (JSON-export, diffs) need it back. We also
  // write the composed JSON to workflows.draft_definition so a
  // subsequent saveDraft round-trip keeps ui intact.
  const parsedDef = safeParseJson<WorkflowDefinition>(row.definition);
  const parsedUi = row.ui ? safeParseJson<unknown>(row.ui) : null;
  const composedDraft: WorkflowDefinition = parsedUi !== null
    ? { ...parsedDef, ui: parsedUi as WorkflowDefinition['ui'] }
    : parsedDef;

  await db.update(workflows).set({
    draftDefinition: JSON.stringify(composedDraft),
    ...(row.ui ? { ui: row.ui } : {}),
    updatedAt: new Date().toISOString(),
  }).where(eq(workflows.id, workflowId)).run();

  return { draft: composedDraft, ui: parsedUi };
}

export async function getPublishedDefinition(db: AppDb, workflowId: string): Promise<WorkflowDefinition | null> {
  const row = await db.select({
    publishedVersionId: workflows.publishedVersionId,
  }).from(workflows).where(eq(workflows.id, workflowId)).get();
  if (!row?.publishedVersionId) return null;
  const ver = await db.select({ definition: workflowDefinitionVersions.definition })
    .from(workflowDefinitionVersions)
    .where(eq(workflowDefinitionVersions.id, row.publishedVersionId))
    .get();
  return ver ? (JSON.parse(ver.definition) as WorkflowDefinition) : null;
}

/**
 * Batched read for the list endpoint: one IN-query joins workflows →
 * workflow_definition_versions so the list can show the published
 * definition without N+1 trips. Workflows without a published version
 * (or whose version row was deleted) get null in the returned map.
 */
export async function getPublishedDefinitions(
  db: AppDb,
  workflowIds: string[],
): Promise<Map<string, WorkflowDefinition | null>> {
  const result = new Map<string, WorkflowDefinition | null>();
  if (workflowIds.length === 0) return result;
  const rows = await db.select({
    id: workflows.id,
    publishedVersionId: workflows.publishedVersionId,
    definition: workflowDefinitionVersions.definition,
  })
    .from(workflows)
    .leftJoin(
      workflowDefinitionVersions,
      eq(workflowDefinitionVersions.id, workflows.publishedVersionId),
    )
    .where(inArray(workflows.id, workflowIds))
    .all();
  for (const r of rows) {
    if (r.publishedVersionId && r.definition) {
      try {
        result.set(r.id, JSON.parse(r.definition) as WorkflowDefinition);
      } catch {
        result.set(r.id, null);
      }
    } else {
      result.set(r.id, null);
    }
  }
  return result;
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Tolerate corrupted JSON in workflows.draft_definition / workflows.ui
 * by throwing a structured `invalid_draft` rather than a raw SyntaxError.
 * Should never happen on rows we wrote, but a manual DB edit or a
 * partial write shouldn't 500 the editor.
 */
function safeParseJson<T>(s: string): T {
  try {
    return JSON.parse(s) as T;
  } catch (err) {
    throw new WorkflowVersionError('invalid_draft', `stored JSON is not parseable: ${err instanceof Error ? err.message : String(err)}`);
  }
}
