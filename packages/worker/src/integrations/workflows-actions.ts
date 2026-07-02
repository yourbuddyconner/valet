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
  scheduleTarget,
  requiresWorkflow,
  listTriggers,
  getTrigger,
  getWorkflowForTrigger,
  checkWebhookPathUniqueness,
  createTrigger,
  generateWebhookToken,
  getTriggerForUpdate,
  updateTrigger,
  deleteTrigger,
  enableTrigger,
  disableTrigger,
  type TriggerConfig,
} from '../lib/db.js';
import { createWorkflow } from '../services/workflows.js';
// Note: services/triggers.ts (used by triggers.run) is imported lazily
// in runTriggerAction to break a load-time cycle:
//   workflows-actions → triggers → orchestrator → env-assembly →
//   credentials → integrations/registry → workflows-actions.
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
import { mapApprovalView } from '../lib/approval-view.js';
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

const workflowSummaryOutputSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    slug: { type: ['string', 'null'] },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    version: { type: 'string' },
    enabled: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    publishedVersionId: { type: ['string', 'null'] },
    hasPublishedVersion: { type: 'boolean' },
    hasPublishedDefinition: { type: 'boolean' },
  },
  additionalProperties: true,
} satisfies Record<string, unknown>;

const workflowDetailOutputSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    slug: { type: ['string', 'null'] },
    name: { type: 'string' },
    description: { type: ['string', 'null'] },
    version: { type: 'string' },
    data: workflowDefinitionInputSchema,
    draft: { type: ['object', 'null'], additionalProperties: true },
    draftUi: { type: ['object', 'null'], additionalProperties: true },
    enabled: { type: 'boolean' },
    tags: { type: 'array', items: { type: 'string' } },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
    publishedVersionId: { type: ['string', 'null'] },
  },
  additionalProperties: true,
} satisfies Record<string, unknown>;

const workflowValidationIssueSchema = {
  type: 'object',
  properties: {
    scope: { type: 'string' },
    nodeId: { type: 'string' },
    path: { type: 'string' },
    code: { type: 'string' },
    message: { type: 'string' },
  },
  additionalProperties: true,
} satisfies Record<string, unknown>;

const workflowValidationOutputSchema = {
  type: 'object',
  properties: {
    errors: { type: 'array', items: workflowValidationIssueSchema },
    warnings: { type: 'array', items: workflowValidationIssueSchema },
  },
} satisfies Record<string, unknown>;

const workflowDraftSaveOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    saved: { type: 'boolean' },
    workflowId: { type: 'string' },
    validation: workflowValidationOutputSchema,
  },
} satisfies Record<string, unknown>;

const workflowPublishedVersionSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    workflowId: { type: 'string' },
    version: { type: 'number' },
    definitionHash: { type: 'string' },
    publishNote: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
    createdBy: { type: ['string', 'null'] },
  },
  additionalProperties: true,
} satisfies Record<string, unknown>;

const workflowExecutionStartSchema = {
  type: 'object',
  properties: {
    executionId: { type: 'string' },
    status: { type: 'string', enum: ['pending'] },
    triggerData: { type: 'object', additionalProperties: true },
    deduplicated: { type: 'boolean' },
  },
} satisfies Record<string, unknown>;

const workflowExecutionNodeSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    nodeId: { type: 'string' },
    nodeType: { type: 'string' },
    status: { type: 'string' },
    inputPreview: { type: ['string', 'null'] },
    inputTruncated: { type: 'boolean' },
    output: { type: ['string', 'null'] },
    outputTruncated: { type: 'boolean' },
    error: { type: ['string', 'null'] },
    reason: { type: ['string', 'null'] },
    retryAttempts: { type: ['number', 'null'] },
    approvalId: { type: ['string', 'null'] },
    invocationId: { type: ['string', 'null'] },
    startedAt: { type: ['string', 'null'] },
    completedAt: { type: ['string', 'null'] },
    durationMs: { type: ['number', 'null'] },
    createdAt: { type: 'string' },
  },
} satisfies Record<string, unknown>;

const workflowApprovalSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    nodeId: { type: 'string' },
    kind: { type: 'string' },
    status: { type: 'string' },
    prompt: { type: 'string' },
    summary: { type: ['string', 'null'] },
    details: { type: ['object', 'string', 'null'], additionalProperties: true },
    timeoutAt: { type: ['string', 'null'] },
    resolvedBy: { type: ['string', 'null'] },
    resolvedAt: { type: ['string', 'null'] },
    cancelledAt: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
  },
} satisfies Record<string, unknown>;

const workflowExecutionOutputSchema = {
  type: 'object',
  properties: {
    execution: {
      type: 'object',
      properties: {
        id: { type: 'string' },
        workflowId: { type: 'string' },
        workflowName: { type: ['string', 'null'] },
        triggerId: { type: ['string', 'null'] },
        triggerName: { type: ['string', 'null'] },
        status: { type: 'string' },
        triggerType: { type: ['string', 'null'] },
        triggerMetadata: { type: ['object', 'null'], additionalProperties: true },
        triggerData: { type: ['object', 'null'], additionalProperties: true },
        outputs: { type: ['object', 'null'], additionalProperties: true },
        error: { type: ['string', 'null'] },
        startedAt: { type: ['string', 'null'] },
        completedAt: { type: ['string', 'null'] },
        mode: { type: ['string', 'null'] },
        cancelledAt: { type: ['string', 'null'] },
        cancelledBy: { type: ['string', 'null'] },
        nodes: { type: 'array', items: workflowExecutionNodeSchema },
        approvals: { type: 'array', items: workflowApprovalSchema },
      },
    },
  },
} satisfies Record<string, unknown>;

// ─── trigger zod params + JSON schemas ───────────────────────────────

const webhookConfigSchema = z.object({
  type: z.literal('webhook'),
  path: z.string().min(1),
  method: z.enum(['GET', 'POST']).optional().default('POST'),
  secret: z.string().optional(),
  headers: z.record(z.string()).optional(),
  rateLimit: z.number().int().positive().max(10000).optional(),
});

const scheduleConfigSchema = z.object({
  type: z.literal('schedule'),
  cron: z.string().min(1),
  timezone: z.string().optional(),
  target: z.enum(['workflow', 'orchestrator']).optional().default('workflow'),
  prompt: z.string().min(1).max(100000).optional(),
  model: z.string().min(1).optional(),
  triggerData: z.record(z.unknown()).optional(),
});

const manualConfigSchema = z.object({ type: z.literal('manual') });

const triggerConfigSchema = z.discriminatedUnion('type', [
  webhookConfigSchema,
  scheduleConfigSchema,
  manualConfigSchema,
]);

const triggerIdParam = z.object({
  triggerId: z.string().min(1).describe('Trigger ID.'),
});

const triggersListParams = z.object({
  workflowId: z.string().min(1).optional(),
});

const triggerCreateParams = z.object({
  workflowId: z.string().min(1).optional(),
  name: z.string().min(1),
  enabled: z.boolean().optional().default(true),
  config: triggerConfigSchema,
  variableMapping: z.record(z.string()).optional(),
}).superRefine((value, ctx) => {
  if (value.config.type === 'schedule' && scheduleTarget(value.config) === 'orchestrator' && !value.config.prompt?.trim()) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Schedule triggers targeting orchestrator require a prompt', path: ['config', 'prompt'] });
  }
  if (requiresWorkflow(value.config) && !value.workflowId) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'workflowId is required for this trigger type', path: ['workflowId'] });
  }
});

const triggerUpdateParams = z.object({
  triggerId: z.string().min(1),
  workflowId: z.string().min(1).nullable().optional(),
  name: z.string().min(1).optional(),
  enabled: z.boolean().optional(),
  config: triggerConfigSchema.optional(),
  variableMapping: z.record(z.string()).optional(),
});

const triggerRunParams = z.object({
  triggerId: z.string().min(1),
  triggerData: z.record(z.unknown()).optional(),
  variables: z.record(z.unknown()).optional(),
  clientRequestId: z.string().min(8).max(64).optional(),
});

const triggerConfigJsonSchema = { type: 'object', additionalProperties: true } as const;

const triggerSummaryOutputSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    workflowId: { type: ['string', 'null'] },
    workflowName: { type: ['string', 'null'] },
    name: { type: 'string' },
    enabled: { type: 'boolean' },
    type: { type: 'string', enum: ['webhook', 'schedule', 'manual'] },
    config: triggerConfigJsonSchema,
    variableMapping: { type: ['object', 'null'], additionalProperties: { type: 'string' } },
    lastRunAt: { type: ['string', 'null'] },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
  additionalProperties: true,
} satisfies Record<string, unknown>;

const triggerDetailOutputSchema = {
  type: 'object',
  properties: {
    trigger: {
      type: 'object',
      properties: {
        ...triggerSummaryOutputSchema.properties,
        webhookUrl: { type: ['string', 'null'], description: 'Set only for webhook triggers.' },
      },
      additionalProperties: true,
    },
  },
} satisfies Record<string, unknown>;

const triggersListOutputSchema = {
  type: 'object',
  properties: { triggers: { type: 'array', items: triggerSummaryOutputSchema } },
} satisfies Record<string, unknown>;

const triggerCreateInputSchema = {
  type: 'object',
  required: ['name', 'config'],
  properties: {
    name: { type: 'string', description: 'Human-readable trigger name.' },
    workflowId: { type: 'string', description: 'Workflow to fire. Required for webhook and workflow-target schedule triggers.' },
    enabled: { type: 'boolean', description: 'Defaults to true.' },
    config: {
      type: 'object',
      description: 'Discriminated union: { type: "webhook", path, method?, secret?, headers?, rateLimit? } | { type: "schedule", cron, timezone?, target?, prompt?, triggerData? } | { type: "manual" }',
      additionalProperties: true,
    },
    variableMapping: { type: 'object', additionalProperties: { type: 'string' }, description: 'Optional mapping from incoming payload fields to workflow variables.' },
  },
  additionalProperties: false,
} as const;

const triggerCreateOutputSchema = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    workflowId: { type: ['string', 'null'] },
    name: { type: 'string' },
    enabled: { type: 'boolean' },
    type: { type: 'string' },
    config: triggerConfigJsonSchema,
    variableMapping: { type: ['object', 'null'], additionalProperties: { type: 'string' } },
    webhookUrl: { type: ['string', 'null'] },
    webhookToken: { type: ['string', 'null'], description: 'One-time webhook auth token. Persist this now — it is never echoed again.' },
    createdAt: { type: 'string' },
    updatedAt: { type: 'string' },
  },
} satisfies Record<string, unknown>;

const triggerUpdateInputSchema = {
  type: 'object',
  required: ['triggerId'],
  properties: {
    triggerId: { type: 'string', description: 'Trigger ID.' },
    name: { type: 'string' },
    enabled: { type: 'boolean' },
    workflowId: { type: ['string', 'null'], description: 'Pass null to detach from a workflow (only valid when the resulting trigger config does not require one).' },
    config: { type: 'object', description: 'Replacement config. Same discriminated-union shape as triggers.create.', additionalProperties: true },
    variableMapping: { type: 'object', additionalProperties: { type: 'string' } },
  },
  additionalProperties: false,
} as const;

const triggerUpdateOutputSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    updatedAt: { type: 'string' },
    webhookToken: { type: ['string', 'null'], description: 'Set only when an update transitioned the trigger into a webhook type.' },
    webhookUrl: { type: ['string', 'null'] },
  },
} satisfies Record<string, unknown>;

const triggerSuccessOutputSchema = {
  type: 'object',
  properties: { success: { type: 'boolean' } },
} satisfies Record<string, unknown>;

const triggerRunInputSchema = {
  type: 'object',
  required: ['triggerId'],
  properties: {
    triggerId: { type: 'string' },
    triggerData: { type: 'object', description: 'Payload exposed as {{trigger.data}} during the run.', additionalProperties: true },
    variables: { type: 'object', description: 'Variable overrides for this run.', additionalProperties: true },
    clientRequestId: { type: 'string', description: 'Optional idempotency key.' },
  },
  additionalProperties: false,
} as const;

const triggerRunOutputSchema = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    executionId: { type: ['string', 'null'] },
    workflowId: { type: ['string', 'null'] },
    workflowName: { type: ['string', 'null'] },
    status: { type: ['string', 'null'] },
    sessionId: { type: ['string', 'null'], description: 'Set when the trigger fired the orchestrator.' },
    reason: { type: ['string', 'null'], description: 'When ok=false, one of: rate_limited, duplicate, orchestrator_failed.' },
    error: { type: ['string', 'null'] },
    variables: { type: ['object', 'null'], additionalProperties: true },
  },
  additionalProperties: true,
} satisfies Record<string, unknown>;

const actions: ActionDefinition[] = [
  {
    id: 'workflows.list',
    name: 'List workflows',
    description: 'List workflows owned by the current user, including published status and draft availability.',
    riskLevel: 'low',
    params: z.object({}),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: {
        workflows: { type: 'array', items: workflowSummaryOutputSchema },
      },
    },
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
    outputSchema: {
      type: 'object',
      properties: {
        workflow: workflowDetailOutputSchema,
      },
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
    outputSchema: {
      type: 'object',
      properties: {
        workflow: workflowDetailOutputSchema,
      },
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
    outputSchema: workflowDraftSaveOutputSchema,
  },
  {
    id: 'workflows.schema',
    name: 'Get workflow schema',
    description: 'Return dag/v1 node types, required fields, template syntax, aliases for old type names, and foreach constraints.',
    riskLevel: 'low',
    params: z.object({}),
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: {
        version: { type: 'string' },
        validNodeTypes: { type: 'array', items: { type: 'string' } },
        foreachBodyTypes: { type: 'array', items: { type: 'string' } },
        legacyNodeTypeAliases: { type: 'object', additionalProperties: true },
        removedNodeTypeNotes: { type: 'object', additionalProperties: true },
        idSyntax: { type: 'object', additionalProperties: true },
        templates: { type: 'object', additionalProperties: true },
        edges: { type: 'object', additionalProperties: true },
        conditionOperations: { type: 'object', additionalProperties: true },
        nodes: {
          type: 'array',
          items: { type: 'object', additionalProperties: true },
        },
      },
      additionalProperties: true,
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
    outputSchema: workflowValidationOutputSchema,
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
    outputSchema: {
      type: 'object',
      properties: {
        version: workflowPublishedVersionSchema,
      },
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
    outputSchema: workflowExecutionStartSchema,
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
    outputSchema: workflowExecutionOutputSchema,
  },
  // ─── triggers ────────────────────────────────────────────────────
  {
    id: 'triggers.list',
    name: 'List triggers',
    description: 'List automation triggers owned by the current user. Returns id, name, type (webhook/schedule/manual), enabled state, config, and last-run timestamp for each.',
    riskLevel: 'low',
    params: triggersListParams,
    inputSchema: {
      type: 'object',
      properties: {
        workflowId: { type: 'string', description: 'Optional: only return triggers attached to this workflow.' },
      },
      additionalProperties: false,
    },
    outputSchema: triggersListOutputSchema,
  },
  {
    id: 'triggers.get',
    name: 'Get trigger',
    description: 'Get a single trigger by ID. Returns full config and (for webhook triggers) the publicly-callable webhook URL. Never returns the webhook auth token; that is only shown once at create-time.',
    riskLevel: 'low',
    params: triggerIdParam,
    inputSchema: {
      type: 'object',
      required: ['triggerId'],
      properties: { triggerId: { type: 'string', description: 'Trigger ID.' } },
      additionalProperties: false,
    },
    outputSchema: triggerDetailOutputSchema,
  },
  {
    id: 'triggers.create',
    name: 'Create trigger',
    description: 'Create a new trigger. Webhook triggers return a one-time webhookToken — store it; the GET/PATCH endpoints never echo it again. Schedule triggers run on a cron expression and may target either a workflow or the orchestrator (with a prompt). Manual triggers fire only via triggers.run.',
    riskLevel: 'medium',
    params: triggerCreateParams,
    inputSchema: triggerCreateInputSchema,
    outputSchema: triggerCreateOutputSchema,
  },
  {
    id: 'triggers.update',
    name: 'Update trigger',
    description: 'Update name, enabled state, config, workflow binding, or variable mapping. Transitioning to webhook type mints a new token (returned once); transitioning away clears the token. Other fields can be PATCHed independently.',
    riskLevel: 'medium',
    params: triggerUpdateParams,
    inputSchema: triggerUpdateInputSchema,
    outputSchema: triggerUpdateOutputSchema,
  },
  {
    id: 'triggers.delete',
    name: 'Delete trigger',
    description: 'Permanently delete a trigger. Webhook URLs and schedule cron entries stop firing immediately. Existing executions are not affected.',
    riskLevel: 'high',
    params: triggerIdParam,
    inputSchema: {
      type: 'object',
      required: ['triggerId'],
      properties: { triggerId: { type: 'string', description: 'Trigger ID.' } },
      additionalProperties: false,
    },
    outputSchema: triggerSuccessOutputSchema,
  },
  {
    id: 'triggers.enable',
    name: 'Enable trigger',
    description: 'Re-enable a paused trigger. The trigger will fire on its next webhook/schedule event.',
    riskLevel: 'low',
    params: triggerIdParam,
    inputSchema: {
      type: 'object',
      required: ['triggerId'],
      properties: { triggerId: { type: 'string', description: 'Trigger ID.' } },
      additionalProperties: false,
    },
    outputSchema: triggerSuccessOutputSchema,
  },
  {
    id: 'triggers.disable',
    name: 'Disable trigger',
    description: 'Pause a trigger without deleting it. Webhook calls will return an error and schedule firings will be skipped until re-enabled.',
    riskLevel: 'medium',
    params: triggerIdParam,
    inputSchema: {
      type: 'object',
      required: ['triggerId'],
      properties: { triggerId: { type: 'string', description: 'Trigger ID.' } },
      additionalProperties: false,
    },
    outputSchema: triggerSuccessOutputSchema,
  },
  {
    id: 'triggers.run',
    name: 'Run trigger',
    description: 'Fire a trigger immediately, bypassing the schedule or webhook entry-point. Pass triggerData to override the static payload (schedule triggers) or supply a fresh payload (manual triggers). Returns the started execution; use workflows.get_execution to inspect progress.',
    riskLevel: 'medium',
    params: triggerRunParams,
    inputSchema: triggerRunInputSchema,
    outputSchema: triggerRunOutputSchema,
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
          return ok(await createWorkflowAction(context.appDb, context.env, context.userId, actions[2]!.params.parse(params)));
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
        case 'triggers.list':
          return ok(await listTriggersAction(context.env, context.userId, triggersListParams.parse(params)));
        case 'triggers.get':
          return ok(await getTriggerAction(context.env, context.userId, triggerIdParam.parse(params)));
        case 'triggers.create':
          return ok(await createTriggerAction(context.env, context.userId, triggerCreateParams.parse(params)));
        case 'triggers.update':
          return ok(await updateTriggerAction(context.env, context.userId, triggerUpdateParams.parse(params)));
        case 'triggers.delete':
          return ok(await deleteTriggerAction(context.env, context.userId, triggerIdParam.parse(params)));
        case 'triggers.enable':
          return ok(await enableTriggerAction(context.env, context.userId, triggerIdParam.parse(params)));
        case 'triggers.disable':
          return ok(await disableTriggerAction(context.env, context.userId, triggerIdParam.parse(params)));
        case 'triggers.run':
          return ok(await runTriggerAction(context.env, context.userId, triggerRunParams.parse(params)));
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
  env: Env,
  userId: string,
  params: { name: string; description?: string | null; slug?: string | null },
) {
  const result = await createWorkflow(db, userId, params);
  return {
    ...result,
    // Surfacing the editor URL lets the orchestrator's tool-result card
    // linkify a direct jump into the canvas instead of forcing the user
    // to navigate the nav tree after a creation.
    editorUrl: workflowEditorUrlFor(env, result.workflow.id),
  };
}

function workflowEditorUrlFor(env: Env, workflowId: string): string {
  const base = (env.FRONTEND_URL ?? '').replace(/\/$/, '');
  return `${base}/workflows/${workflowId}`;
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
  const structuralErrors = validateDefinition(params.draft).filter((issue) => issue.code !== 'llm_maxoutput_warning');
  if (structuralErrors.length > 0) {
    return {
      ok: false,
      saved: false,
      workflowId: id,
      validation: groupWorkflowValidationResults(structuralErrors),
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

  // Post-consolidation (migration 0023): workflow_approvals is retired.
  // Workflow-attributed approvals — both tool-policy holds and explicit
  // workflows.request_approval invocations — live in action_invocations.
  const approvals = await env.DB.prepare(
    `SELECT id, node_id, status, params, expires_at,
            resolved_by, resolved_at, created_at, service, action_id,
            iteration_index
     FROM action_invocations
     WHERE workflow_execution_id = ?
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
      approvals: (approvals.results ?? []).map((a) => mapApprovalView({
        id: a.id as string,
        nodeId: (a.node_id as string | null) ?? null,
        service: a.service as string,
        actionId: a.action_id as string,
        status: a.status as string,
        params: (a.params as string | null) ?? null,
        expiresAt: (a.expires_at as string | null) ?? null,
        resolvedBy: (a.resolved_by as string | null) ?? null,
        resolvedAt: (a.resolved_at as string | null) ?? null,
        createdAt: a.created_at as string,
        iterationIndex: (a.iteration_index as number | null) ?? null,
      })),
    },
  };
}

function ok(data: unknown): ActionResult {
  return { success: true, data };
}

// ─── trigger handlers ────────────────────────────────────────────────

/**
 * Build a public webhook URL. Falls back to the worker's own origin
 * via env.API_PUBLIC_URL; the route handler does the same when
 * c.req.header('host') is unavailable.
 */
function webhookUrlFor(env: Env, triggerId: string): string | null {
  const base = env.API_PUBLIC_URL?.replace(/\/$/, '');
  if (!base) return null;
  return `${base}/api/triggers/${triggerId}/webhook`;
}

async function listTriggersAction(env: Env, userId: string, params: { workflowId?: string }) {
  const result = await listTriggers(env.DB, userId);
  let rows = result.results;
  if (params.workflowId) rows = rows.filter((r) => r.workflow_id === params.workflowId);
  return {
    triggers: rows.map((row) => ({
      id: row.id,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name,
      name: row.name,
      enabled: Boolean(row.enabled),
      type: row.type,
      config: JSON.parse(row.config as string),
      variableMapping: row.variable_mapping ? JSON.parse(row.variable_mapping as string) : null,
      lastRunAt: row.last_run_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}

async function getTriggerAction(env: Env, userId: string, params: { triggerId: string }) {
  const row = await getTrigger(env.DB, userId, params.triggerId);
  if (!row) throw new Error(`trigger ${params.triggerId} not found`);
  return {
    trigger: {
      id: row.id,
      workflowId: row.workflow_id,
      workflowName: row.workflow_name,
      name: row.name,
      enabled: Boolean(row.enabled),
      type: row.type,
      config: JSON.parse(row.config as string),
      variableMapping: row.variable_mapping ? JSON.parse(row.variable_mapping as string) : null,
      webhookUrl: row.type === 'webhook' ? webhookUrlFor(env, row.id as string) : null,
      lastRunAt: row.last_run_at,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    },
  };
}

async function createTriggerAction(
  env: Env,
  userId: string,
  params: z.infer<typeof triggerCreateParams>,
) {
  const db = (await import('../lib/drizzle.js')).getDb(env.DB);

  let workflowId: string | null = null;
  const needsWorkflow = requiresWorkflow(params.config);
  if (needsWorkflow || params.workflowId) {
    const workflow = await getWorkflowForTrigger(db, userId, params.workflowId ?? '');
    if (!workflow) throw new Error(`workflow ${params.workflowId ?? '<missing>'} not found`);
    workflowId = workflow.id;
  }

  if (params.config.type === 'webhook') {
    const conflict = await checkWebhookPathUniqueness(env.DB, params.config.path);
    if (conflict) throw new Error(`webhook path "${params.config.path}" already in use`);
  }

  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const webhookToken = params.config.type === 'webhook' ? generateWebhookToken() : null;

  await createTrigger(db, {
    id,
    userId,
    workflowId,
    name: params.name,
    enabled: params.enabled,
    type: params.config.type,
    config: JSON.stringify(params.config),
    variableMapping: params.variableMapping ? JSON.stringify(params.variableMapping) : null,
    now,
    webhookToken,
  });

  return {
    id,
    workflowId,
    name: params.name,
    enabled: params.enabled,
    type: params.config.type,
    config: params.config,
    variableMapping: params.variableMapping ?? null,
    webhookUrl: params.config.type === 'webhook' ? webhookUrlFor(env, id) : null,
    webhookToken,
    createdAt: now,
    updatedAt: now,
  };
}

async function updateTriggerAction(
  env: Env,
  userId: string,
  params: z.infer<typeof triggerUpdateParams>,
) {
  const db = (await import('../lib/drizzle.js')).getDb(env.DB);
  const existing = await getTriggerForUpdate(db, userId, params.triggerId);
  if (!existing) throw new Error(`trigger ${params.triggerId} not found`);

  const currentConfig = JSON.parse(existing.config) as TriggerConfig;
  const nextConfig = params.config ?? currentConfig;
  let nextWorkflowId = params.workflowId !== undefined ? params.workflowId : existing.workflow_id;

  if (nextConfig.type === 'schedule' && scheduleTarget(nextConfig) === 'orchestrator' && !nextConfig.prompt?.trim()) {
    throw new Error('Schedule triggers targeting orchestrator require a prompt');
  }
  if (requiresWorkflow(nextConfig) && !nextWorkflowId) {
    throw new Error('workflowId is required for this trigger type');
  }
  if (nextWorkflowId) {
    const workflow = await getWorkflowForTrigger(db, userId, nextWorkflowId);
    if (!workflow) throw new Error(`workflow ${nextWorkflowId} not found`);
    nextWorkflowId = workflow.id;
  }
  if (nextConfig.type === 'webhook') {
    const conflict = await checkWebhookPathUniqueness(env.DB, nextConfig.path, params.triggerId);
    if (conflict) throw new Error(`webhook path "${nextConfig.path}" already in use`);
  }

  const now = new Date().toISOString();
  const updates: string[] = [];
  const values: unknown[] = [];

  if (params.name !== undefined) { updates.push('name = ?'); values.push(params.name); }
  if (params.enabled !== undefined) { updates.push('enabled = ?'); values.push(params.enabled ? 1 : 0); }
  if (params.workflowId !== undefined || (params.config && !requiresWorkflow(params.config))) {
    updates.push('workflow_id = ?');
    values.push(nextWorkflowId);
  }
  if (params.config !== undefined) {
    updates.push('type = ?'); updates.push('config = ?');
    values.push(params.config.type); values.push(JSON.stringify(params.config));
  }
  if (params.variableMapping !== undefined) {
    updates.push('variable_mapping = ?');
    values.push(JSON.stringify(params.variableMapping));
  }

  let mintedWebhookToken: string | null = null;
  if (params.config !== undefined) {
    const becameWebhook = nextConfig.type === 'webhook' && existing.type !== 'webhook';
    const leftWebhook = nextConfig.type !== 'webhook' && existing.type === 'webhook';
    if (becameWebhook) {
      mintedWebhookToken = generateWebhookToken();
      updates.push('webhook_token = ?'); values.push(mintedWebhookToken);
    } else if (leftWebhook) {
      updates.push('webhook_token = ?'); values.push(null);
    }
  }

  updates.push('updated_at = ?'); values.push(now); values.push(params.triggerId);

  await updateTrigger(env.DB, params.triggerId, userId, updates, values);

  return {
    success: true,
    updatedAt: now,
    webhookToken: mintedWebhookToken,
    webhookUrl: mintedWebhookToken ? webhookUrlFor(env, params.triggerId) : null,
  };
}

async function deleteTriggerAction(env: Env, userId: string, params: { triggerId: string }) {
  const db = (await import('../lib/drizzle.js')).getDb(env.DB);
  const result = await deleteTrigger(db, params.triggerId, userId);
  if (result.meta.changes === 0) throw new Error(`trigger ${params.triggerId} not found`);
  return { success: true };
}

async function enableTriggerAction(env: Env, userId: string, params: { triggerId: string }) {
  const db = (await import('../lib/drizzle.js')).getDb(env.DB);
  const result = await enableTrigger(db, params.triggerId, userId, new Date().toISOString());
  if (result.meta.changes === 0) throw new Error(`trigger ${params.triggerId} not found`);
  return { success: true };
}

async function disableTriggerAction(env: Env, userId: string, params: { triggerId: string }) {
  const db = (await import('../lib/drizzle.js')).getDb(env.DB);
  const result = await disableTrigger(db, params.triggerId, userId, new Date().toISOString());
  if (result.meta.changes === 0) throw new Error(`trigger ${params.triggerId} not found`);
  return { success: true };
}

async function runTriggerAction(
  env: Env,
  userId: string,
  params: z.infer<typeof triggerRunParams>,
) {
  const body: Record<string, unknown> & {
    clientRequestId?: string;
    variables?: Record<string, unknown>;
    triggerData?: Record<string, unknown>;
  } = {};
  if (params.clientRequestId) body.clientRequestId = params.clientRequestId;
  if (params.variables) body.variables = params.variables;
  if (params.triggerData) body.triggerData = params.triggerData;

  const { runTrigger } = await import('../services/triggers.js');
  const result = await runTrigger(env, params.triggerId, userId, body);
  if (result.ok) {
    if (result.type === 'workflow') {
      return {
        ok: true,
        executionId: result.executionId,
        workflowId: result.workflowId,
        workflowName: result.workflowName,
        status: 'queued',
        variables: result.variables,
      };
    }
    return {
      ok: true,
      workflowId: result.workflowId,
      workflowName: result.workflowName,
      sessionId: result.sessionId,
      status: 'dispatched',
    };
  }
  return {
    ok: false,
    reason: result.reason,
    error: 'error' in result ? result.error : null,
    workflowId: 'workflowId' in result ? result.workflowId : null,
    workflowName: 'workflowName' in result ? result.workflowName : null,
    sessionId: 'sessionId' in result ? result.sessionId : null,
    executionId: 'executionId' in result ? result.executionId : null,
    status: 'status' in result ? result.status : null,
    variables: 'variables' in result ? result.variables : null,
  };
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
