import { z } from 'zod';
import type { ActionContext, ActionDefinition, ActionResult, ActionSource, IntegrationPackage, IntegrationProvider } from '@valet/sdk';
import type { Env } from '../env.js';
import type { AppDb } from '../lib/drizzle.js';
import {
  checkIdempotencyKey,
  getExecution,
  getWorkflowByIdOrSlug,
  listWorkflows,
  parseExecutionTriggerData,
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
import { assembleLlmProviderEnv } from '../lib/llm/provider-env.js';
import {
  groupWorkflowValidationResults,
  validateAgainstAvailableModels,
  validateAgainstEnvironment,
  validateDefinition,
  type GroupedWorkflowValidation,
} from '../lib/workflow-dag/validator.js';
import { resolveAvailableModels } from '../services/model-catalog.js';
import { allowedIfOperations } from '../lib/workflow-dag/if-operations.js';
import {
  FOREACH_BODY_NODE_TYPES,
  LEGACY_NODE_TYPE_ALIASES,
  LEGACY_NODE_TYPE_NOTES,
  WORKFLOW_NODE_TYPES,
  isWorkflowDefinition,
} from '../lib/workflow-dag/schema.js';
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
    description: 'Save an editable, structurally valid dag/v1 draft. Pass validate=true to return grouped semantic/environment validation after saving.',
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
    id: 'workflows.schema',
    name: 'Get workflow schema',
    description: 'Return dag/v1 node types, required fields, template syntax, aliases for old type names, and foreach constraints.',
    riskLevel: 'low',
    params: z.object({}),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
    description: 'Run the current draft with sample trigger data exposed as {{trigger.data}}.',
    riskLevel: 'medium',
    params: z.object({
      workflowId: z.string().min(1),
      triggerData: z.record(z.unknown()).optional(),
      clientRequestId: z.string().min(8).max(64).optional(),
    }),
    inputSchema: {
      type: 'object',
      required: ['workflowId'],
      properties: {
        workflowId: { type: 'string', description: 'Workflow ID or slug.' },
        triggerData: { type: 'object', description: 'Sample trigger payload exposed as {{trigger.data}}.' },
        clientRequestId: { type: 'string', description: 'Optional idempotency key for retry/double-click protection.' },
      },
      additionalProperties: false,
    },
  },
  {
    id: 'workflows.get_execution',
    name: 'Get workflow execution',
    description: 'Inspect a workflow execution, including status, trigger data, outputs, node traces, and approval history.',
    riskLevel: 'low',
    params: z.object({
      executionId: z.string().min(1),
    }),
    inputSchema: {
      type: 'object',
      required: ['executionId'],
      properties: {
        executionId: { type: 'string', description: 'Workflow execution ID.' },
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
        case 'workflows.schema':
          z.object({}).parse(params);
          return ok(getWorkflowSchemaAction());
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
            clientRequestId: z.string().min(8).max(64).optional(),
          }).parse(params)));
        case 'workflows.get_execution':
          return ok(await getExecutionAction(context.env, context.userId, z.object({
            executionId: z.string().min(1),
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

function getWorkflowSchemaAction() {
  return {
    version: 'dag/v1',
    validNodeTypes: WORKFLOW_NODE_TYPES,
    foreachBodyTypes: FOREACH_BODY_NODE_TYPES,
    legacyNodeTypeAliases: LEGACY_NODE_TYPE_ALIASES,
    removedNodeTypeNotes: LEGACY_NODE_TYPE_NOTES,
    idSyntax: {
      allowedPattern: '^[A-Za-z0-9_-]+$',
      maxLength: 80,
      note: 'Dot notation only works for identifier-safe node IDs. For IDs containing "-", use bracket notation such as {{nodes["tool-1"].data.result}}.',
    },
    templates: {
      delimiters: '{{ expression }}',
      runtimeContext: ['trigger', 'nodes', 'item', 'index'],
      examples: [
        '{{trigger.data}}',
        '{{trigger.data.name}}',
        '{{nodes.prepare.data.message}}',
        '{{nodes["tool-1"].data.issues}}',
        '{{item.title}}',
      ],
      note: 'Use nodes.*, not outputs.*.',
    },
    edges: {
      fields: ['from', 'to', 'fromOutput', 'when'],
      ifBranches: ['true', 'false'],
      note: 'Edges connect top-level node IDs only. Edges from if nodes must set fromOutput to "true" or "false".',
    },
    conditionOperations: {
      string: allowedIfOperations('string'),
      number: allowedIfOperations('number'),
      date: allowedIfOperations('date'),
      boolean: allowedIfOperations('boolean'),
      array: allowedIfOperations('array'),
      object: allowedIfOperations('object'),
      aliases: {
        is_not_empty: 'isNotEmpty',
        is_empty: 'isEmpty',
        not_equals: 'notEquals',
        does_not_exist: 'doesNotExist',
        does_not_contain: 'doesNotContain',
        starts_with: 'startsWith',
        ends_with: 'endsWith',
        matches_regex: 'matchesRegex',
        greater_than: 'greaterThan',
        less_than: 'lessThan',
        greater_than_or_equal: 'greaterThanOrEqual',
        less_than_or_equal: 'lessThanOrEqual',
        is_true: 'isTrue',
        is_false: 'isFalse',
      },
    },
    nodes: [
      {
        type: 'trigger',
        required: ['id', 'type'],
        optional: [],
        description: 'Represents the invocation source and exposes trigger.data, trigger.metadata, trigger.type, and trigger.timestamp.',
      },
      {
        type: 'llm',
        required: ['id', 'type', 'prompt'],
        optional: ['model', 'system', 'outputSchema', 'temperature', 'maxOutputTokens'],
        description: 'Generate text or structured output. Model IDs use provider:model.',
      },
      {
        type: 'tool',
        required: ['id', 'type', 'service', 'action', 'params'],
        optional: ['summary', 'onPolicyDeny', 'retries'],
        description: 'Call a remote integration action.',
      },
      {
        type: 'set',
        required: ['id', 'type', 'values'],
        optional: [],
        description: 'Write structured values to nodes.<id>.data.',
      },
      {
        type: 'if',
        required: ['id', 'type', 'conditions'],
        optional: ['combinator'],
        description: 'Branch on conditions. Conditions use left, dataType, operation, and optional right.',
      },
      {
        type: 'wait',
        required: ['id', 'type', 'mode', 'duration'],
        optional: [],
        description: 'Sleep for a duration. MVP mode is "duration".',
      },
      {
        type: 'approval',
        required: ['id', 'type', 'prompt'],
        optional: ['summary', 'details', 'timeout', 'onDeny'],
        description: 'Pause until a human approves or denies.',
      },
      {
        type: 'foreach',
        required: ['id', 'type', 'items', 'body'],
        optional: ['itemAlias', 'indexAlias', 'maxItems', 'concurrency', 'onItemError'],
        description: 'Iterate over an array expression and run one allowed body node per item. Optional maxItems truncates the input array before execution.',
        constraints: {
          bodyTypes: FOREACH_BODY_NODE_TYPES,
          bodyNote: 'Nested if, wait, approval, trigger, and foreach nodes are not supported in foreach body.',
        },
      },
      {
        type: 'orchestrator',
        required: ['id', 'type', 'prompt'],
        optional: ['forceNewThread', 'wait'],
        description: 'Prompt the user orchestrator.',
      },
      {
        type: 'session',
        required: ['id', 'type', 'mode', 'prompt'],
        optional: ['workspace', 'title', 'personaId', 'model', 'repo', 'sessionId', 'threadId', 'forceNewThread', 'wait'],
        description: 'Start a new session or prompt an existing session. mode is "start" or "prompt".',
      },
      {
        type: 'stop',
        required: ['id', 'type'],
        optional: ['outcome', 'output', 'message'],
        description: 'End a branch with optional output.',
      },
    ],
  };
}

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
      validation: await validateWorkflowDefinitionInput(db, params.draft, env),
    };
  }
  const modelErrors = await validateDraftModelCatalog(db, env, params.draft);
  if (modelErrors.length > 0) {
    return {
      ok: false,
      saved: false,
      workflowId: id,
      validation: groupWorkflowValidationResults(modelErrors),
    };
  }
  await saveDraft(db, id, params.draft, params.ui);
  const result: { ok: true; saved: true; workflowId: string; validation?: GroupedWorkflowValidation } = { ok: true, saved: true, workflowId: id };
  if (params.validate) {
    result.validation = await validateWorkflowDefinition(db, params.draft, env);
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
      return validateWorkflowDefinitionInput(db, params.definition, env);
    }
    return validateWorkflowDefinition(db, params.definition, env);
  }

  if (!params.workflowId) {
    throw new Error('workflowId is required when definition is omitted');
  }
  const { id } = await assertWorkflowAccess(db, { id: userId }, params.workflowId, 'viewer');
  const draft = await getDraft(db, id);
  if (!draft.draft) {
    return { errors: [{ scope: 'workflow', code: 'no_draft', path: '/', message: 'no draft to validate' }], warnings: [] };
  }
  return validateWorkflowDefinition(db, draft.draft, env);
}

async function validateWorkflowDefinition(db: AppDb, definition: WorkflowDefinition, env: Env): Promise<GroupedWorkflowValidation> {
  const providerEnv = await assembleLlmProviderEnv(db, env);
  const validationEnv = { ...env, ...providerEnv } as Env;
  const availableModels = await resolveAvailableModels(db, validationEnv);
  return groupWorkflowValidationResults([
    ...validateDefinition(definition),
    ...validateAgainstEnvironment(definition, validationEnv, { availableModels }),
  ]);
}

async function validateWorkflowDefinitionInput(db: AppDb, definition: unknown, env: Env): Promise<GroupedWorkflowValidation> {
  if (!isWorkflowDefinition(definition)) {
    return groupWorkflowValidationResults(validateDefinition(definition));
  }
  return validateWorkflowDefinition(db, definition, env);
}

async function validateDraftModelCatalog(
  db: AppDb,
  env: Env,
  definition: WorkflowDefinition,
): Promise<ReturnType<typeof validateAgainstAvailableModels>> {
  const providerEnv = await assembleLlmProviderEnv(db, env);
  const validationEnv = { ...env, ...providerEnv } as Env;
  const availableModels = await resolveAvailableModels(db, validationEnv);
  return validateAgainstAvailableModels(definition, availableModels);
}

async function publishWorkflowAction(
  db: AppDb,
  env: Env,
  userId: string,
  params: { workflowId: string; publishNote?: string },
) {
  const { id } = await assertWorkflowAccess(db, { id: userId }, params.workflowId, 'editor');
  const providerEnv = await assembleLlmProviderEnv(db, env);
  const validationEnv = { ...env, ...providerEnv } as Env;
  const availableModels = await resolveAvailableModels(db, validationEnv);
  return publishDraft(db, id, {
    userId,
    env: validationEnv,
    availableModels,
    ...(params.publishNote ? { publishNote: params.publishNote } : {}),
  });
}

async function testRunWorkflowAction(
  db: AppDb,
  env: Env,
  userId: string,
  params: { workflowId: string; triggerData?: Record<string, unknown>; clientRequestId?: string },
) {
  const { id } = await assertWorkflowAccess(db, { id: userId }, params.workflowId, 'editor');
  const clientRequestId = params.clientRequestId ?? crypto.randomUUID();
  const idempotencyKey = `agent-test-run:${id}:${userId}:${clientRequestId}`;
  const existing = await checkIdempotencyKey(env.DB, id, userId, idempotencyKey);
  if (existing) {
    return {
      executionId: existing.id as string,
      status: existing.status as string,
      triggerData: parseExecutionTriggerData(existing as { inputs?: string | null }),
      deduplicated: true,
    };
  }

  return createExecution(env, {
    workflowId: id,
    user: { id: userId },
    trigger: {
      type: 'manual',
      timestamp: new Date().toISOString(),
      data: params.triggerData ?? {},
      metadata: { mode: 'test', initiatedBy: userId, clientRequestId, source: 'agent_tool' },
    },
    mode: 'test',
    definitionSource: 'draft',
    idempotencyKey,
  });
}

async function getExecutionAction(
  env: Env,
  userId: string,
  params: { executionId: string },
) {
  const row = await getExecution(env.DB, params.executionId, userId);
  if (!row) throw new Error(`execution ${params.executionId} not found`);

  const nodes = await env.DB.prepare(
    `SELECT id, node_id, node_type, status, input_preview, input_truncated,
            output, output_truncated, error, reason, retry_attempts, approval_id,
            invocation_id, started_at, completed_at, duration_ms, created_at
     FROM workflow_execution_nodes
     WHERE execution_id = ?
     ORDER BY created_at ASC`,
  ).bind(params.executionId).all<Record<string, unknown>>();

  const approvals = await env.DB.prepare(
    `SELECT id, node_id, kind, status, prompt, summary, details, timeout_at,
            resolved_by, resolved_at, cancelled_at, created_at
     FROM workflow_approvals
     WHERE execution_id = ?
     ORDER BY created_at ASC`,
  ).bind(params.executionId).all<Record<string, unknown>>();
  const rowRecord = row as Record<string, unknown>;

  return {
    execution: {
      id: row.id,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name,
      triggerId: row.trigger_id,
      triggerName: row.trigger_name,
      status: row.status,
      triggerType: row.trigger_type,
      triggerMetadata: row.trigger_metadata ? JSON.parse(row.trigger_metadata as string) : null,
      triggerData: parseExecutionTriggerData(row as { inputs?: string | null }),
      outputs: row.outputs ? JSON.parse(row.outputs as string) : null,
      error: row.error,
      startedAt: row.started_at,
      completedAt: row.completed_at,
      mode: rowRecord.mode ?? null,
      cancelledAt: rowRecord.cancelled_at ?? null,
      cancelledBy: rowRecord.cancelled_by ?? null,
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
      approvals: (approvals.results ?? []).map((a) => ({
        id: a.id,
        nodeId: a.node_id,
        kind: a.kind,
        status: a.status,
        prompt: a.prompt,
        summary: a.summary,
        details: typeof a.details === 'string' ? safeJsonParse(a.details) : null,
        timeoutAt: a.timeout_at,
        resolvedBy: a.resolved_by,
        resolvedAt: a.resolved_at,
        cancelledAt: a.cancelled_at,
        createdAt: a.created_at,
      })),
    },
  };
}

function safeJsonParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
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
