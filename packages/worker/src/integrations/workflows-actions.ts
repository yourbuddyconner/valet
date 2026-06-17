import { z } from 'zod';
import type { ActionContext, ActionDefinition, ActionResult, ActionSource, IntegrationPackage, IntegrationProvider } from '@valet/sdk';
import type { Env } from '../env.js';
import type { AppDb } from '../lib/drizzle.js';
import {
  checkIdempotencyKey,
  getWorkflowByIdOrSlug,
  listWorkflows,
  parseExecutionInputs,
} from '../lib/db.js';
import { createWorkflow } from '../services/workflows.js';
import {
  getDraft,
  getPublishedDefinition,
  getPublishedDefinitions,
  publishDraft,
  saveDraft,
  WorkflowVersionError,
} from '../services/workflow-versions.js';
import { createExecution, WorkflowExecutionStartError } from '../services/workflow-executions.js';
import {
  groupWorkflowValidationResults,
  validateAgainstEnvironment,
  validateDefinition,
  type GroupedWorkflowValidation,
} from '../lib/workflow-dag/validator.js';
import { isWorkflowDefinition } from '../lib/workflow-dag/schema.js';
import { assertWorkflowAccess } from '../lib/workflow-access.js';
import type { WorkflowDefinition } from '@valet/shared';

interface WorkerActionContext extends ActionContext {
  appDb?: AppDb;
  env?: Env;
}

const workflowIdParam = z.object({
  workflowId: z.string().min(1).describe('Workflow ID or slug.'),
});

const workflowDefinitionInputSchema = {
  type: 'object',
  description: 'A dag/v1 workflow definition.',
  additionalProperties: true,
};

const actions: ActionDefinition[] = [
  {
    id: 'workflows.list',
    name: 'List workflows',
    description: 'List workflows owned by the current user, including published status and draft availability.',
    riskLevel: 'low',
    params: z.object({}),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    id: 'workflows.get',
    name: 'Get workflow',
    description: 'Get workflow metadata plus the published definition and current draft.',
    riskLevel: 'low',
    params: workflowIdParam,
    inputSchema: {
      type: 'object',
      required: ['workflowId'],
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID or slug.' },
      },
      additionalProperties: false,
    },
  },
  {
    id: 'workflows.create',
    name: 'Create workflow',
    description: 'Create a new workflow draft.',
    riskLevel: 'medium',
    params: z.object({
      name: z.string().min(1).max(120),
      description: z.string().max(500).nullable().optional(),
      slug: z.string().min(1).max(120).nullable().optional(),
    }),
    inputSchema: {
      type: 'object',
      required: ['name'],
      properties: {
        name: { type: 'string', description: 'Workflow name.' },
        description: { type: ['string', 'null'], description: 'Optional workflow description.' },
        slug: { type: ['string', 'null'], description: 'Optional URL slug.' },
      },
      additionalProperties: false,
    },
  },
  {
    id: 'workflows.save_draft',
    name: 'Save workflow draft',
    description: 'Save an editable dag/v1 draft. Drafts may be incomplete; publish validates them.',
    riskLevel: 'medium',
    params: z.object({
      workflowId: z.string().min(1),
      draft: z.record(z.unknown()),
      ui: z.unknown().optional(),
      validate: z.boolean().optional(),
    }),
    inputSchema: {
      type: 'object',
      required: ['workflowId', 'draft'],
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID or slug.' },
        draft: workflowDefinitionInputSchema,
        ui: { description: 'Optional editor layout state.' },
        validate: { type: 'boolean', description: 'When true, return grouped validation errors/warnings after saving.' },
      },
      additionalProperties: false,
    },
  },
  {
    id: 'workflows.validate',
    name: 'Validate workflow draft',
    description: 'Validate a workflow draft against structural and environment-specific rules.',
    riskLevel: 'low',
    params: z.object({
      workflowId: z.string().min(1).optional(),
      definition: z.record(z.unknown()).optional(),
    }),
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID or slug. Required when definition is omitted.' },
        definition: workflowDefinitionInputSchema,
      },
      additionalProperties: false,
    },
  },
  {
    id: 'workflows.publish',
    name: 'Publish workflow draft',
    description: 'Publish the current draft as the active workflow version used by triggers.',
    riskLevel: 'high',
    params: z.object({
      workflowId: z.string().min(1),
      publishNote: z.string().min(1).max(500).optional(),
    }),
    inputSchema: {
      type: 'object',
      required: ['workflowId'],
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID or slug.' },
        publishNote: { type: 'string', description: 'Optional publish note.' },
      },
      additionalProperties: false,
    },
  },
  {
    id: 'workflows.test_run',
    name: 'Test run workflow draft',
    description: 'Run the current draft with sample trigger data and optional workflow inputs.',
    riskLevel: 'medium',
    params: z.object({
      workflowId: z.string().min(1),
      triggerData: z.record(z.unknown()).optional(),
      inputs: z.record(z.unknown()).optional(),
      clientRequestId: z.string().min(8).max(64).optional(),
    }),
    inputSchema: {
      type: 'object',
      required: ['workflowId'],
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID or slug.' },
        triggerData: { type: 'object', description: 'Sample trigger payload exposed as {{trigger.data}}.' },
        inputs: { type: 'object', description: 'Declared workflow input overrides exposed as {{inputs}}.' },
        clientRequestId: { type: 'string', description: 'Optional idempotency key for retry/double-click protection.' },
      },
      additionalProperties: false,
    },
  },
];

export const workflowProvider: IntegrationProvider = {
  service: 'workflows',
  displayName: 'Workflows',
  authType: 'none',
  supportedEntities: ['workflow'],
  validateCredentials: () => true,
  testConnection: async () => true,
};

export const workflowActions: ActionSource = {
  listActions() {
    return actions;
  },

  async execute(actionId: string, params: unknown, ctx: ActionContext): Promise<ActionResult> {
    const context = ctx as WorkerActionContext;
    if (!context.appDb || !context.env) {
      return { success: false, error: 'Workflow actions require worker context.' };
    }

    try {
      switch (actionId) {
        case 'workflows.list':
          return ok(await listWorkflowAction(context.appDb, context.userId));
        case 'workflows.get':
          return ok(await getWorkflowAction(context.appDb, context.userId, workflowIdParam.parse(params)));
        case 'workflows.create':
          return ok(await createWorkflowAction(context.appDb, context.userId, actions[2]!.params.parse(params)));
        case 'workflows.save_draft':
          return ok(await saveDraftAction(context.appDb, context.env, context.userId, z.object({
            workflowId: z.string().min(1),
            draft: z.record(z.unknown()),
            ui: z.unknown().optional(),
            validate: z.boolean().optional(),
          }).parse(params)));
        case 'workflows.validate':
          return ok(await validateWorkflowAction(context.appDb, context.env, context.userId, z.object({
            workflowId: z.string().min(1).optional(),
            definition: z.record(z.unknown()).optional(),
          }).parse(params)));
        case 'workflows.publish':
          return ok(await publishWorkflowAction(context.appDb, context.env, context.userId, z.object({
            workflowId: z.string().min(1),
            publishNote: z.string().min(1).max(500).optional(),
          }).parse(params)));
        case 'workflows.test_run':
          return ok(await testRunWorkflowAction(context.appDb, context.env, context.userId, z.object({
            workflowId: z.string().min(1),
            triggerData: z.record(z.unknown()).optional(),
            inputs: z.record(z.unknown()).optional(),
            clientRequestId: z.string().min(8).max(64).optional(),
          }).parse(params)));
        default:
          return { success: false, error: `Unknown workflow action "${actionId}".` };
      }
    } catch (err) {
      return { success: false, error: formatWorkflowActionError(err) };
    }
  },
};

export const workflowIntegrationPackage: IntegrationPackage = {
  name: '@valet/plugin-workflows',
  version: '0.0.1',
  service: 'workflows',
  provider: workflowProvider,
  actions: workflowActions,
};

async function listWorkflowAction(db: AppDb, userId: string) {
  const result = await listWorkflows(db, userId);
  const publishedMap = await getPublishedDefinitions(db, result.results.map((row) => row.id));

  return {
    workflows: result.results.map((row) => ({
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      version: row.version,
      enabled: Boolean(row.enabled),
      tags: row.tags ? JSON.parse(row.tags as string) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      publishedVersionId: row.published_version_id,
      hasPublishedVersion: Boolean(row.published_version_id),
      hasPublishedDefinition: publishedMap.has(row.id),
    })),
  };
}

async function getWorkflowAction(db: AppDb, userId: string, params: { workflowId: string }) {
  const { id } = await assertWorkflowAccess(db, { id: userId }, params.workflowId, 'viewer');
  const row = await getWorkflowByIdOrSlug(db, userId, id);
  if (!row) throw new Error(`workflow ${params.workflowId} not found`);

  const [publishedDefinition, draft] = await Promise.all([
    getPublishedDefinition(db, row.id),
    getDraft(db, row.id),
  ]);

  return {
    workflow: {
      id: row.id,
      slug: row.slug,
      name: row.name,
      description: row.description,
      version: row.version,
      data: publishedDefinition ?? JSON.parse(row.data as string),
      draft: draft.draft,
      draftUi: draft.ui,
      enabled: Boolean(row.enabled),
      tags: row.tags ? JSON.parse(row.tags as string) : [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      publishedVersionId: row.published_version_id,
    },
  };
}

async function createWorkflowAction(
  db: AppDb,
  userId: string,
  params: { name: string; description?: string | null; slug?: string | null },
) {
  return createWorkflow(db, userId, params);
}

async function saveDraftAction(
  db: AppDb,
  env: Env,
  userId: string,
  params: { workflowId: string; draft: Record<string, unknown>; ui?: unknown; validate?: boolean },
) {
  const { id } = await assertWorkflowAccess(db, { id: userId }, params.workflowId, 'editor');
  if (!isWorkflowDefinition(params.draft)) {
    return {
      ok: false,
      saved: false,
      workflowId: id,
      validation: validateWorkflowDefinitionInput(params.draft, env),
    };
  }
  await saveDraft(db, id, params.draft, params.ui);
  const result: { ok: true; saved: true; workflowId: string; validation?: GroupedWorkflowValidation } = { ok: true, saved: true, workflowId: id };
  if (params.validate) {
    result.validation = validateWorkflowDefinition(params.draft, env);
  }
  return result;
}

async function validateWorkflowAction(
  db: AppDb,
  env: Env,
  userId: string,
  params: { workflowId?: string; definition?: Record<string, unknown> },
) {
  if (params.definition) {
    if (!isWorkflowDefinition(params.definition)) {
      return validateWorkflowDefinitionInput(params.definition, env);
    }
    return validateWorkflowDefinition(params.definition, env);
  }

  if (!params.workflowId) {
    throw new Error('workflowId is required when definition is omitted');
  }
  const { id } = await assertWorkflowAccess(db, { id: userId }, params.workflowId, 'viewer');
  const draft = await getDraft(db, id);
  if (!draft.draft) {
    return { errors: [{ scope: 'workflow', code: 'no_draft', path: '/', message: 'no draft to validate' }], warnings: [] };
  }
  return validateWorkflowDefinition(draft.draft, env);
}

function validateWorkflowDefinition(definition: WorkflowDefinition, env: Env): GroupedWorkflowValidation {
  return groupWorkflowValidationResults([
    ...validateDefinition(definition),
    ...validateAgainstEnvironment(definition, env),
  ]);
}

function validateWorkflowDefinitionInput(definition: unknown, env: Env): GroupedWorkflowValidation {
  if (!isWorkflowDefinition(definition)) {
    return groupWorkflowValidationResults(validateDefinition(definition));
  }
  return validateWorkflowDefinition(definition, env);
}

async function publishWorkflowAction(
  db: AppDb,
  env: Env,
  userId: string,
  params: { workflowId: string; publishNote?: string },
) {
  const { id } = await assertWorkflowAccess(db, { id: userId }, params.workflowId, 'editor');
  return publishDraft(db, id, {
    userId,
    env,
    ...(params.publishNote ? { publishNote: params.publishNote } : {}),
  });
}

async function testRunWorkflowAction(
  db: AppDb,
  env: Env,
  userId: string,
  params: { workflowId: string; triggerData?: Record<string, unknown>; inputs?: Record<string, unknown>; clientRequestId?: string },
) {
  const { id } = await assertWorkflowAccess(db, { id: userId }, params.workflowId, 'editor');
  const clientRequestId = params.clientRequestId ?? crypto.randomUUID();
  const idempotencyKey = `agent-test-run:${id}:${userId}:${clientRequestId}`;
  const existing = await checkIdempotencyKey(env.DB, id, userId, idempotencyKey);
  if (existing) {
    return {
      executionId: existing.id as string,
      status: existing.status as string,
      inputs: parseExecutionInputs(existing as { inputs?: string | null }),
      deduplicated: true,
    };
  }

  return createExecution(env, {
    workflowId: id,
    user: { id: userId },
    trigger: {
      type: 'manual',
      timestamp: new Date().toISOString(),
      data: params.triggerData ?? params.inputs ?? {},
      metadata: { mode: 'test', initiatedBy: userId, clientRequestId, source: 'agent_tool' },
    },
    ...(params.inputs ? { inputOverrides: params.inputs } : {}),
    mode: 'test',
    definitionSource: 'draft',
    idempotencyKey,
  });
}

function ok(data: unknown): ActionResult {
  return { success: true, data };
}

function formatWorkflowActionError(err: unknown): string {
  if (err instanceof WorkflowVersionError) {
    const suffix = err.errors?.length ? `: ${JSON.stringify(err.errors)}` : '';
    return `${err.code}: ${err.message}${suffix}`;
  }
  if (err instanceof WorkflowExecutionStartError) {
    const suffix = err.details ? `: ${JSON.stringify(err.details)}` : '';
    return `${err.code}: ${err.message}${suffix}`;
  }
  if (err instanceof z.ZodError) {
    return `invalid_params: ${err.issues.map((issue) => `${issue.path.join('.') || '/'} ${issue.message}`).join('; ')}`;
  }
  return err instanceof Error ? err.message : String(err);
}
