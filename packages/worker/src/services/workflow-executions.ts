/**
 * Execution-start helper for dag/v1 workflows.
 *
 * Called by the three trigger paths (manual, schedule, webhook) after
 * they've resolved the workflow + built a normalized
 * WorkflowTriggerPayload. Handles:
 *   1. Access check (assertWorkflowAccess editor role).
 *   2. Trigger data validation (validateTriggerData against trigger.dataSchema).
 *   3. Env-dependent validation (validateAgainstEnvironment — LLM
 *      provider keys configured).
 *   4. Per-user concurrency cap.
 *   5. Insert workflow_executions row with definition snapshot.
 *   6. Create the Cloudflare Workflow instance.
 *
 * Returns the execution id. Throws on any validation failure or cap
 * breach so the trigger path can map to the right HTTP status.
 */

import type { Env } from '../env.js';
import { getDb } from '../lib/drizzle.js';
import { eq, inArray, and } from 'drizzle-orm';
import { workflowExecutions } from '../lib/schema/workflows.js';
import { workflows } from '../lib/schema/workflows.js';
import { workflowDefinitionVersions } from '../lib/schema/workflow-definition-versions.js';
import type {
  WorkflowDefinition,
  WorkflowTriggerPayload,
  WorkflowValidationError,
} from '@valet/shared';
import { validateDefinition, validateTriggerData, validateAgainstEnvironment } from '../lib/workflow-dag/validator.js';
import { assembleLlmProviderEnv } from '../lib/llm/provider-env.js';
import { resolveAvailableModels } from './model-catalog.js';

export class WorkflowExecutionStartError extends Error {
  constructor(
    public readonly code:
      | 'not_found'
      | 'access_denied'
      | 'invalid_inputs'
      | 'invalid_env'
      | 'invalid_definition'
      | 'invalid_runtime'
      | 'no_published_version'
      | 'rate_limited',
    message: string,
    public readonly details?: WorkflowValidationError[] | { active: number; limit: number },
  ) {
    super(message);
    this.name = 'WorkflowExecutionStartError';
  }
}

export interface CreateExecutionInput {
  workflowId: string;
  user: { id: string };
  trigger: WorkflowTriggerPayload;
  mode?: 'production' | 'test';
  /** Optional idempotency key stored on the execution row so a
   * subsequent call with the same key can be deduped. */
  idempotencyKey?: string;
  /**
   * Which definition to execute:
   *   - 'published' (default): load workflows.published_version_id →
   *     workflow_definition_versions.definition. Production triggers go
   *     through this path; the workflow must have an active published
   *     version (otherwise createExecution rejects with `no_published_version`).
   *   - 'draft': load workflows.draft_definition. Used by the test-run
   *     endpoint so authors can run the in-progress draft.
   *   - 'snapshot': run the caller-provided definition snapshot. Used by
   *     execution retry so reruns preserve the original workflow version
   *     even if the draft/published definition has since changed.
   */
  definitionSource?: 'published' | 'draft' | 'snapshot';
  definitionSnapshot?: WorkflowDefinition;
}

export interface CreateExecutionResult {
  executionId: string;
  status: 'pending';
}

import { ACTIVE_EXECUTION_STATUSES, GLOBAL_EXECUTION_CONCURRENCY_CAP, PER_USER_EXECUTION_CONCURRENCY_CAP } from '../lib/db/constants.js';

export async function createExecution(env: Env, input: CreateExecutionInput): Promise<CreateExecutionResult> {
  const db = getDb(env.DB);

  // 1. Access check (uses the helper that landed in Phase 1.5).
  const { assertWorkflowAccess } = await import('../lib/workflow-access.js');
  await assertWorkflowAccess(db, input.user, input.workflowId, 'editor');

  // Load the workflow + definition. Priority:
  //   - definitionSource='snapshot' → caller-provided execution snapshot (retry)
  //   - definitionSource='draft' → workflows.draft_definition (test-run)
  //   - definitionSource='published' (default) → workflows.published_version_id
  //     → workflow_definition_versions.definition. Production triggers
  //     refuse to run a workflow that has never been published.
  // The version string we stamp on the execution row tracks whatever
  // we loaded so audit trails point at the right thing.
  const workflow = await db.select({
    id: workflows.id,
    data: workflows.data,
    version: workflows.version,
    enabled: workflows.enabled,
    draftDefinition: workflows.draftDefinition,
    publishedVersionId: workflows.publishedVersionId,
  }).from(workflows).where(eq(workflows.id, input.workflowId)).get();
  if (!workflow) {
    throw new WorkflowExecutionStartError('not_found', `workflow ${input.workflowId} not found`);
  }
  // Disabled workflows refuse all triggers (manual, schedule, webhook).
  // Schedule lookups filter on workflows.enabled already; manual and
  // webhook paths land here without that filter, so this is the gate
  // for them. Test-runs are gated separately by the test-run route.
  if (!workflow.enabled && input.definitionSource !== 'draft') {
    throw new WorkflowExecutionStartError(
      'not_found',
      `workflow ${input.workflowId} is disabled`,
    );
  }

  const definitionSource = input.definitionSource ?? 'published';
  let definitionJson: string;
  let definitionVersionId: string | null = null;
  let workflowVersion = workflow.version;

  if (definitionSource === 'snapshot') {
    if (!input.definitionSnapshot) {
      throw new WorkflowExecutionStartError('invalid_definition', 'snapshot execution source requires definitionSnapshot');
    }
    definitionJson = JSON.stringify(input.definitionSnapshot);
    workflowVersion = 'snapshot';
  } else if (definitionSource === 'draft') {
    if (!workflow.draftDefinition) {
      throw new WorkflowExecutionStartError('not_found', `workflow ${input.workflowId} has no draft to run`);
    }
    definitionJson = workflow.draftDefinition;
    // Audit rows for draft test-runs should not impersonate a real
    // published version number.
    workflowVersion = 'draft';
  } else if (workflow.publishedVersionId) {
    const ver = await db.select({
      definition: workflowDefinitionVersions.definition,
      version: workflowDefinitionVersions.version,
    }).from(workflowDefinitionVersions)
      .where(eq(workflowDefinitionVersions.id, workflow.publishedVersionId))
      .get();
    if (!ver) {
      throw new WorkflowExecutionStartError('not_found', `published version ${workflow.publishedVersionId} not found`);
    }
    definitionJson = ver.definition;
    definitionVersionId = workflow.publishedVersionId;
    workflowVersion = String(ver.version);
  } else {
    // No published version. Schedule and webhook triggers MUST NOT run
    // a workflow that hasn't been published — they'd execute whatever
    // happens to be in workflows.data (possibly a mid-edit dag/v1) and
    // make pre-publish edits silently visible to live triggers.
    throw new WorkflowExecutionStartError(
      'no_published_version',
      `workflow ${input.workflowId} has no published version`,
    );
  }
  let def: WorkflowDefinition;
  try {
    def = parseDefinition(definitionJson);
  } catch (err) {
    if (err instanceof WorkflowExecutionStartError) throw err;
    throw new WorkflowExecutionStartError(
      'invalid_definition',
      `definition is malformed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // 2. Structural validation. The publish path validates clean drafts,
  // but test-run executes drafts directly and we want the same gate.
  // Filter out non-blocking warnings (e.g. llm_maxoutput_warning).
  const structuralErrors = validateDefinition(def).filter((e) => e.code !== 'llm_maxoutput_warning');
  if (structuralErrors.length > 0) {
    throw new WorkflowExecutionStartError('invalid_definition', 'definition failed validation', structuralErrors);
  }

  // 3. Trigger data validation. The reserved trigger node's dataSchema
  // is the workflow invocation contract; all invocations populate
  // {{trigger.data.X}}.
  const triggerDataResult = validateTriggerData(def, input.trigger.data);
  if (!triggerDataResult.ok) {
    throw new WorkflowExecutionStartError('invalid_inputs', 'trigger data validation failed', triggerDataResult.errors);
  }
  const trigger: WorkflowTriggerPayload = {
    ...input.trigger,
    data: triggerDataResult.triggerData,
  };

  // 4. Env-dependent validation (LLM provider keys, etc.).
  const providerEnv = await assembleLlmProviderEnv(db, env);
  const validationEnv = { ...env, ...providerEnv } as Env;
  const availableModels = await resolveAvailableModels(db, validationEnv);
  const envErrors = validateAgainstEnvironment(def, validationEnv, { availableModels });
  if (envErrors.length > 0) {
    throw new WorkflowExecutionStartError('invalid_env', 'workflow references resources not configured in this environment', envErrors);
  }

  // 5. Concurrency caps. Per-user + global. Test-run uses the same
  // helper, so the draft path can't bypass the global cap. Race window:
  // a parallel request could also pass these checks and both inserts
  // succeed (D1 has no SERIALIZABLE isolation). At the MVP caps,
  // briefly going one over is acceptable; tighten later via an atomic
  // counter if it matters.
  //
  // ACTIVE_EXECUTION_STATUSES + the caps live in lib/db/constants.ts
  // as the single source of truth.
  const activeNow = (await db.select({ id: workflowExecutions.id })
    .from(workflowExecutions)
    .where(and(
      eq(workflowExecutions.userId, input.user.id),
      inArray(workflowExecutions.status, [...ACTIVE_EXECUTION_STATUSES]),
    ))
    .all()).length;
  if (activeNow >= PER_USER_EXECUTION_CONCURRENCY_CAP) {
    throw new WorkflowExecutionStartError(
      'rate_limited',
      `user has ${activeNow} active workflow executions; cap is ${PER_USER_EXECUTION_CONCURRENCY_CAP}`,
      { active: activeNow, limit: PER_USER_EXECUTION_CONCURRENCY_CAP },
    );
  }
  const globalActive = (await db.select({ id: workflowExecutions.id })
    .from(workflowExecutions)
    .where(inArray(workflowExecutions.status, [...ACTIVE_EXECUTION_STATUSES]))
    .all()).length;
  if (globalActive >= GLOBAL_EXECUTION_CONCURRENCY_CAP) {
    throw new WorkflowExecutionStartError(
      'rate_limited',
      `${globalActive} active workflow executions globally; cap is ${GLOBAL_EXECUTION_CONCURRENCY_CAP}`,
      { active: globalActive, limit: GLOBAL_EXECUTION_CONCURRENCY_CAP },
    );
  }

  // 5. Insert the execution row with the definition snapshot.
  const executionId = crypto.randomUUID();
  const mode = input.mode ?? 'production';
  const now = new Date().toISOString();
  try {
    await db.insert(workflowExecutions).values({
      id: executionId,
      workflowId: workflow.id,
      userId: input.user.id,
      status: 'pending',
      triggerType: trigger.type,
      triggerId: trigger.triggerId ?? null,
      triggerMetadata: JSON.stringify(trigger.metadata ?? {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
      startedAt: now,
      workflowVersion,
      definitionSnapshot: definitionJson,
      definitionVersionId,
      inputs: JSON.stringify(triggerDataResult.triggerData),
      mode,
    }).run();
  } catch (err) {
    // Idempotency-key race: another caller with the same key won the
    // insert between checkIdempotencyKey and this insert. Re-fetch the
    // existing row and return its id rather than 500ing.
    const msg = err instanceof Error ? err.message : String(err);
    if (input.idempotencyKey && (/UNIQUE/i.test(msg) || /constraint/i.test(msg))) {
      const existing = await db.select({ id: workflowExecutions.id })
        .from(workflowExecutions)
        .where(and(
          eq(workflowExecutions.workflowId, workflow.id),
          eq(workflowExecutions.idempotencyKey, input.idempotencyKey),
        ))
        .get();
      if (existing) {
        return { executionId: existing.id, status: 'pending' };
      }
    }
    throw err;
  }

  // 6. Create the Cloudflare Workflow instance. If create() throws,
  // delete the row we just inserted so we don't leak a pending
  // execution that no CF instance will ever advance.
  try {
    await env.WORKFLOW_INTERPRETER.create({
      id: executionId,
      params: {
        executionId,
        workflowId: workflow.id,
        userId: input.user.id,
        trigger,
        definition: def,
        mode,
      },
    });
  } catch (err) {
    await db.delete(workflowExecutions).where(eq(workflowExecutions.id, executionId)).run();
    throw err;
  }

  return { executionId, status: 'pending' };
}

function parseDefinition(data: string): WorkflowDefinition {
  let parsed: WorkflowDefinition;
  try {
    parsed = JSON.parse(data) as WorkflowDefinition;
  } catch (err) {
    throw new WorkflowExecutionStartError('invalid_runtime', `workflow definition is unparseable: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (parsed.version !== 'dag/v1') {
    throw new WorkflowExecutionStartError('invalid_runtime', `workflow definition has unsupported version "${parsed.version}"; only dag/v1 is supported`);
  }
  return parsed;
}
