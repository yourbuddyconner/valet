import { z } from 'zod';
import type { ActionDefinition, ActionSource, ActionContext, ActionResult } from '@valet/sdk';
import type { AppDb } from '../../../lib/drizzle.js';
import type { Env } from '../../../env.js';
import {
  listWorkflows,
  getWorkflowByIdOrSlug,
  getWorkflowOwnerCheck,
  listWorkflowProposals,
  parseJsonObject as parseJsonObjectDb,
} from '../../../lib/db.js';
import * as workflowService from '../../../services/workflows.js';
import * as triggerService from '../../../services/triggers.js';
import * as executionService from '../../../services/executions.js';
import {
  workflowRun,
  handleTriggerAction,
  handleExecutionAction,
  workflowExecutions,
} from '../../../services/session-workflows.js';

// ─── Internal context narrowing ───────────────────────────────────────────────

/** Narrowed internal handle: cast once from ActionContext.internal. */
type Internal = { db: AppDb; env: Env };

function internalOf(ctx: ActionContext): Internal {
  if (!ctx.internal) {
    throw new Error('workflows actions require an internal context');
  }
  // Single cast: ActionContext.internal is { db: unknown; env: unknown }
  // and we know the worker populates it as { db: AppDb; env: Env }.
  return ctx.internal as Internal;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function normalizeWorkflow(row: Record<string, unknown>) {
  return {
    id: row.id,
    slug: row.slug,
    name: row.name,
    description: row.description,
    version: row.version,
    data: typeof row.data === 'string' ? JSON.parse(row.data) : row.data,
    enabled: Boolean(row.enabled),
    tags: row.tags ? (typeof row.tags === 'string' ? JSON.parse(row.tags) : row.tags) : [],
    createdAt: row.created_at ?? row.createdAt,
    updatedAt: row.updated_at ?? row.updatedAt,
  };
}

function normalizeProposal(row: Record<string, unknown>) {
  return {
    id: row.id,
    workflowId: row.workflow_id,
    executionId: row.execution_id,
    proposedBySessionId: row.proposed_by_session_id,
    baseWorkflowHash: row.base_workflow_hash,
    proposal: parseJsonObjectDb(row.proposal_json as string),
    diffText: row.diff_text,
    status: row.status,
    reviewNotes: row.review_notes,
    expiresAt: row.expires_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

// ─── Action Definitions ───────────────────────────────────────────────────────

const defs: ActionDefinition[] = [
  // ── Workflow CRUD ─────────────────────────────────────────────────────────
  {
    id: 'list_workflows',
    name: 'List Workflows',
    description: 'List workflows available to the current user in Valet. Use this before creating new workflows to avoid duplicates.',
    riskLevel: 'low',
    params: z.object({
      _placeholder: z.string().optional().describe('Unused'),
    }),
  },
  {
    id: 'get_workflow',
    name: 'Get Workflow',
    description: 'Get a workflow by ID or slug.',
    riskLevel: 'low',
    params: z.object({
      workflow_id: z.string().min(1).describe('Workflow ID or slug'),
    }),
  },
  {
    id: 'list_workflow_history',
    name: 'List Workflow History',
    description: 'List immutable workflow history snapshots for rollback and auditing.',
    riskLevel: 'low',
    params: z.object({
      workflow_id: z.string().min(1).describe('Workflow ID or slug'),
      limit: z.number().int().min(1).max(200).optional().describe('Max history entries to return (default 50)'),
      offset: z.number().int().min(0).optional().describe('Offset for pagination (default 0)'),
    }),
  },
  {
    id: 'sync_workflow',
    name: 'Sync Workflow',
    description:
      'Create or update a workflow in Valet. ' +
      'This immediately syncs the workflow to the backend so it appears on the Workflows page. ' +
      'Step types: agent_prompt (calls the agent, captures its reply), notify, bash (requires command field), tool, conditional, loop, parallel, approval. ' +
      'For shell commands use type: "bash" with a "command" field — NOT type: "tool" with tool: "bash".',
    riskLevel: 'low',
    params: z.object({
      id: z.string().optional().describe('Optional stable workflow ID'),
      slug: z.string().optional().describe('Optional workflow slug'),
      name: z.string().min(1).describe('Workflow name'),
      description: z.string().optional().describe('Workflow description'),
      version: z.string().optional().describe('Workflow version (default 1.0.0)'),
      data_json: z.string().optional().describe(
        'Workflow definition JSON string with a non-empty "steps" array. ' +
        'Each step needs id, name, type. Bash steps: {"id":"1","name":"Run tests","type":"bash","command":"npm test"}. ' +
        'Do NOT use type:"tool" with tool:"bash" — use type:"bash" with command field instead.'
      ),
      workflow_json: z.string().optional().describe('Alias for data_json'),
    }),
  },
  {
    id: 'update_workflow',
    name: 'Update Workflow',
    description: 'Update workflow metadata or definition by ID/slug. Supports name, description, slug, version, enabled, tags, and full data.',
    riskLevel: 'low',
    params: z.object({
      workflow_id: z.string().min(1).describe('Workflow ID or slug'),
      name: z.string().optional().describe('Updated workflow name'),
      description: z.string().optional().describe('Updated workflow description'),
      clear_description: z.boolean().optional().describe('Set description to null'),
      slug: z.string().optional().describe('Updated slug'),
      clear_slug: z.boolean().optional().describe('Set slug to null'),
      version: z.string().optional().describe('Updated version'),
      enabled: z.boolean().optional().describe('Enabled state'),
      tags_json: z.string().optional().describe('JSON array of string tags'),
      data_json: z.string().optional().describe('Full workflow data JSON object'),
    }),
  },
  {
    id: 'run_workflow',
    name: 'Run Workflow',
    description: 'Run a workflow immediately by workflow ID or slug. Returns execution details that can be checked in the Workflows UI.',
    riskLevel: 'low',
    params: z.object({
      workflow_id: z.string().min(1).describe('Workflow ID or slug'),
      variables_json: z.string().optional().describe('Optional JSON object string for runtime variables, e.g. {"env":"prod","dryRun":true}'),
      repo_url: z.string().optional().describe('Optional git repository URL to clone into the workflow session'),
      repo_branch: z.string().optional().describe('Optional branch to checkout when repo_url is provided'),
      repo_ref: z.string().optional().describe('Optional git ref to checkout when repo_url is provided'),
      source_repo_full_name: z.string().optional().describe('Optional owner/repo hint (derived from repo_url when omitted)'),
    }),
  },
  {
    id: 'delete_workflow',
    name: 'Delete Workflow',
    description: 'Delete a workflow by ID or slug.',
    riskLevel: 'medium',
    params: z.object({
      workflow_id: z.string().min(1).describe('Workflow ID or slug'),
    }),
  },
  {
    id: 'rollback_workflow',
    name: 'Rollback Workflow',
    description: 'Roll back a workflow definition to a historical hash from list_workflow_history. Optionally override version and add notes.',
    riskLevel: 'medium',
    params: z.object({
      workflow_id: z.string().min(1).describe('Workflow ID or slug'),
      target_workflow_hash: z.string().min(1).describe('Target workflow hash to restore'),
      version: z.string().optional().describe('Optional version override after rollback'),
      notes: z.string().optional().describe('Optional rollback note'),
    }),
  },

  // ── Workflow Proposals ────────────────────────────────────────────────────
  {
    id: 'create_workflow_proposal',
    name: 'Create Workflow Proposal',
    description: 'Create a workflow mutation proposal for self-modifying workflows. Requires the current base workflow hash and proposal JSON payload.',
    riskLevel: 'low',
    params: z.object({
      workflow_id: z.string().min(1).describe('Workflow ID or slug'),
      base_workflow_hash: z.string().min(1).describe('Current workflow hash'),
      proposal_json: z.string().describe('Proposal JSON object string'),
      execution_id: z.string().optional().describe('Optional source execution ID'),
      proposed_by_session_id: z.string().optional().describe('Optional source session ID'),
      diff_text: z.string().optional().describe('Optional human-readable diff text'),
      expires_at: z.string().optional().describe('Optional ISO-8601 expiry timestamp'),
    }),
  },
  {
    id: 'list_workflow_proposals',
    name: 'List Workflow Proposals',
    description: 'List workflow mutation proposals for a workflow.',
    riskLevel: 'low',
    params: z.object({
      workflow_id: z.string().min(1).describe('Workflow ID or slug'),
      status: z.enum(['pending', 'approved', 'rejected', 'applied', 'failed']).optional().describe('Optional status filter'),
      limit: z.number().int().min(1).max(200).optional().describe('Max proposals to return (default 50)'),
      offset: z.number().int().min(0).optional().describe('Offset for pagination (default 0)'),
    }),
  },
  {
    id: 'review_workflow_proposal',
    name: 'Review Workflow Proposal',
    description: 'Approve or reject a workflow proposal before apply.',
    riskLevel: 'low',
    params: z.object({
      workflow_id: z.string().min(1).describe('Workflow ID or slug'),
      proposal_id: z.string().min(1).describe('Workflow proposal ID'),
      approve: z.boolean().describe('Set true to approve, false to reject'),
      notes: z.string().optional().describe('Optional review notes'),
    }),
  },
  {
    id: 'apply_workflow_proposal',
    name: 'Apply Workflow Proposal',
    description: 'Apply an approved workflow proposal to update the workflow definition.',
    riskLevel: 'low',
    params: z.object({
      workflow_id: z.string().min(1).describe('Workflow ID or slug'),
      proposal_id: z.string().min(1).describe('Workflow proposal ID'),
      review_notes: z.string().optional().describe('Optional apply notes'),
      version: z.string().optional().describe('Optional explicit version after apply'),
    }),
  },

  // ── Executions ────────────────────────────────────────────────────────────
  {
    id: 'list_workflow_executions',
    name: 'List Workflow Executions',
    description: 'List recent workflow executions for the current user, optionally filtered by workflow.',
    riskLevel: 'low',
    params: z.object({
      workflow_id: z.string().optional().describe('Optional workflow ID or slug filter'),
      limit: z.number().int().min(1).max(200).optional().describe('Max executions to return (default 20)'),
    }),
  },
  {
    id: 'get_execution',
    name: 'Get Execution',
    description: 'Fetch a single workflow execution by ID. Use this to inspect status, error, resume token, trigger metadata, and outputs.',
    riskLevel: 'low',
    params: z.object({
      execution_id: z.string().min(1).describe('Workflow execution ID'),
    }),
  },
  {
    id: 'get_execution_steps',
    name: 'Get Execution Steps',
    description: 'Fetch normalized per-step trace entries for a workflow execution. Useful for debugging out-of-order display, approval gates, and step failures.',
    riskLevel: 'low',
    params: z.object({
      execution_id: z.string().min(1).describe('Workflow execution ID'),
      limit: z.number().int().min(1).max(500).optional().describe('Optional max number of steps to return (default 200)'),
    }),
  },
  {
    id: 'debug_execution',
    name: 'Debug Execution',
    description: 'Diagnose a workflow execution by combining execution metadata and normalized step traces. Returns likely root cause plus concrete next actions.',
    riskLevel: 'low',
    params: z.object({
      execution_id: z.string().min(1).describe('Workflow execution ID'),
      step_limit: z.number().int().min(1).max(500).optional().describe('Optional maximum step rows to include in output (default 200)'),
    }),
  },
  {
    id: 'approve_execution',
    name: 'Approve Execution',
    description: 'Approve or deny a waiting workflow approval checkpoint for an execution. Requires the current resume token from get_execution.',
    riskLevel: 'low',
    params: z.object({
      execution_id: z.string().min(1).describe('Workflow execution ID'),
      approve: z.boolean().describe('Set true to approve, false to deny'),
      resume_token: z.string().min(1).describe('Current resume token from execution.resumeToken'),
      reason: z.string().optional().describe('Optional reason when denying approval'),
    }),
  },
  {
    id: 'cancel_execution',
    name: 'Cancel Execution',
    description: 'Cancel a workflow execution. Useful for stopping stuck runs or resetting after a failed approval/resume path.',
    riskLevel: 'low',
    params: z.object({
      execution_id: z.string().min(1).describe('Workflow execution ID'),
      reason: z.string().optional().describe('Optional cancellation reason'),
    }),
  },

  // ── Triggers ──────────────────────────────────────────────────────────────
  {
    id: 'list_triggers',
    name: 'List Triggers',
    description: 'List workflow triggers for the current user.',
    riskLevel: 'low',
    params: z.object({
      workflow_id: z.string().optional().describe('Optional workflow ID/slug filter'),
      type: z.enum(['webhook', 'schedule', 'manual']).optional().describe('Optional trigger type filter'),
      enabled: z.boolean().optional().describe('Optional enabled state filter'),
    }),
  },
  {
    id: 'sync_trigger',
    name: 'Sync Trigger',
    description:
      'Create or update a trigger by name. Idempotent — calling with the same name updates the existing trigger ' +
      'rather than creating a duplicate. Supports manual, webhook, and schedule triggers ' +
      '(including schedule target=orchestrator with prompt).',
    riskLevel: 'low',
    params: z.object({
      trigger_id: z.string().optional().describe('Optional. Use only for renaming a trigger or explicit UUID-based update'),
      workflow_id: z.string().optional().describe('Workflow ID/slug. Required for webhook/manual and schedule target=workflow'),
      clear_workflow_link: z.boolean().optional().describe('For updates only, set workflowId to null'),
      name: z.string().min(1).describe('Trigger name'),
      enabled: z.boolean().optional().describe('Trigger enabled state'),
      type: z.enum(['webhook', 'schedule', 'manual']).describe('Trigger type'),
      webhook_path: z.string().optional().describe('Webhook path (required for webhook type)'),
      webhook_method: z.enum(['GET', 'POST']).optional().describe('Webhook method (default POST)'),
      webhook_secret: z.string().optional().describe('Optional webhook secret'),
      schedule_cron: z.string().optional().describe('Cron expression (required for schedule type)'),
      schedule_timezone: z.string().optional().describe('IANA timezone for schedule triggers'),
      schedule_target: z.enum(['workflow', 'orchestrator']).optional().describe('Schedule target (default workflow)'),
      schedule_prompt: z.string().optional().describe('Prompt required when schedule_target=orchestrator'),
      variable_mapping_json: z.string().optional().describe('Optional JSON object mapping variable names to extraction paths'),
    }),
  },
  {
    id: 'run_trigger',
    name: 'Run Trigger',
    description: 'Run a trigger immediately by trigger ID. For schedule target=orchestrator triggers, this dispatches the configured prompt to orchestrator.',
    riskLevel: 'low',
    params: z.object({
      trigger_id: z.string().min(1).describe('Trigger ID'),
      variables_json: z.string().optional().describe('Optional JSON object for manual runtime variables'),
      repo_url: z.string().optional().describe('Optional git repository URL for the workflow session'),
      repo_branch: z.string().optional().describe('Optional branch to checkout'),
      repo_ref: z.string().optional().describe('Optional git ref to checkout'),
      source_repo_full_name: z.string().optional().describe('Optional owner/repo hint'),
    }),
  },
  {
    id: 'delete_trigger',
    name: 'Delete Trigger',
    description: 'Delete a trigger by ID.',
    riskLevel: 'medium',
    params: z.object({
      trigger_id: z.string().min(1).describe('Trigger ID (UUID)'),
    }),
  },
];

// ─── Debug execution helper ───────────────────────────────────────────────────

interface ExecutionSummary {
  id: string;
  workflowId: string;
  status: string;
  triggerType: string;
  error: string | null | undefined;
  resumeToken: string | null | undefined;
  startedAt: string | undefined;
  completedAt: string | null | undefined;
}

interface StepTrace {
  stepId: string;
  attempt: number;
  status: string;
  error: string | null;
  sequence?: number;
}

function statusCounts(steps: StepTrace[]): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const step of steps) {
    counts[step.status] = (counts[step.status] ?? 0) + 1;
  }
  return counts;
}

function extractMismatchStepId(error: string | null | undefined): string | null {
  if (!error) return null;
  const prefix = 'resume_token_mismatch:';
  if (!error.startsWith(prefix)) return null;
  const stepId = error.slice(prefix.length).trim();
  return stepId || null;
}

function buildDebugDiagnosis(
  execution: ExecutionSummary,
  steps: StepTrace[],
): { diagnosis: string; actions: string[] } {
  const waitingSteps = steps.filter((s) => s.status === 'waiting_approval');
  const failedSteps = steps.filter((s) => s.status === 'failed');
  const runningSteps = steps.filter((s) => s.status === 'running');
  const mismatchStepId = extractMismatchStepId(execution.error);

  let diagnosis = 'No obvious issue detected from execution metadata.';
  const actions: string[] = [];

  if (execution.status === 'waiting_approval') {
    diagnosis = execution.resumeToken
      ? 'Execution is blocked on approval and has an active resume token.'
      : 'Execution is waiting for approval but has no resume token persisted.';
    if (execution.resumeToken) {
      actions.push(`Use approve_execution with execution_id=${execution.id}, approve=true, resume_token=<execution.resumeToken>.`);
    }
  } else if (execution.status === 'failed' && mismatchStepId) {
    const hasDifferentWaitingApproval = waitingSteps.some((s) => s.stepId !== mismatchStepId);
    diagnosis = hasDifferentWaitingApproval
      ? `Execution failed with ${execution.error}. This usually indicates a stale resume token was used for an earlier approval checkpoint.`
      : `Execution failed with ${execution.error}. Resume token likely did not match the currently paused checkpoint.`;
    actions.push('Re-run get_execution and use the latest execution.resumeToken.');
    actions.push('If state is inconsistent, cancel_execution and start a fresh run.');
  } else if (execution.status === 'running') {
    diagnosis = 'Execution is currently running.';
    actions.push('Use get_execution_steps again after a short delay to watch progress.');
  } else if (execution.status === 'pending') {
    diagnosis = 'Execution is queued/pending dispatch.';
    actions.push('Wait briefly, then run get_execution again.');
  } else if (execution.status === 'completed') {
    diagnosis = 'Execution completed successfully.';
  } else if (execution.status === 'cancelled') {
    diagnosis = `Execution is cancelled${execution.error ? ` (${execution.error})` : ''}.`;
  } else if (execution.status === 'failed') {
    diagnosis = execution.error
      ? `Execution failed: ${execution.error}`
      : 'Execution failed with no explicit error in execution metadata.';
    if (failedSteps.length > 0) {
      actions.push('Inspect failed step errors in stepSummary.failedSteps.');
    }
    actions.push('If retrying, prefer starting a new run.');
  }

  const blockingStep = waitingSteps[0] ?? runningSteps[0] ?? failedSteps[0] ?? null;

  return {
    diagnosis,
    actions: actions.concat([]), // keep as-is
  };

  // unused in the branch above — extracted to separate field by caller
  void blockingStep;
}

// ─── ActionSource ─────────────────────────────────────────────────────────────

export const workflowsActions: ActionSource = {
  listActions: () => defs,

  async execute(actionId: string, params: unknown, ctx: ActionContext): Promise<ActionResult> {
    const { db, env } = internalOf(ctx);
    const userId = ctx.userId;
    const p = params as Record<string, unknown>;

    try {
      switch (actionId) {

        // ── list_workflows ───────────────────────────────────────────────────
        case 'list_workflows': {
          const result = await listWorkflows(db, userId);
          const workflows = result.results.map((row) =>
            normalizeWorkflow(row as Record<string, unknown>),
          );
          return { success: true, data: { workflows } };
        }

        // ── get_workflow ─────────────────────────────────────────────────────
        case 'get_workflow': {
          const workflowId = String(p.workflow_id ?? '');
          const row = await getWorkflowByIdOrSlug(db, userId, workflowId);
          if (!row) return { success: false, error: `Workflow not found: ${workflowId}` };
          return { success: true, data: { workflow: normalizeWorkflow(row as Record<string, unknown>) } };
        }

        // ── list_workflow_history ────────────────────────────────────────────
        case 'list_workflow_history': {
          const workflowId = String(p.workflow_id ?? '');
          const limit = typeof p.limit === 'number' ? p.limit : undefined;
          const offset = typeof p.offset === 'number' ? p.offset : undefined;
          const result = await workflowService.getWorkflowHistoryWithSnapshot(db, userId, workflowId, { limit, offset });
          if (!result) return { success: false, error: `Workflow not found: ${workflowId}` };
          return { success: true, data: result };
        }

        // ── sync_workflow ────────────────────────────────────────────────────
        case 'sync_workflow': {
          const rawPayload = (p.data_json ?? p.workflow_json) as string | undefined;
          if (!rawPayload) {
            return { success: false, error: 'provide data_json/workflow_json with a non-empty steps array' };
          }
          let data: Record<string, unknown>;
          try {
            const parsed = JSON.parse(rawPayload);
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
              return { success: false, error: 'data_json must be a JSON object' };
            }
            data = parsed as Record<string, unknown>;
          } catch (e) {
            return { success: false, error: `Invalid JSON in data_json: ${e instanceof Error ? e.message : String(e)}` };
          }
          const syncId = typeof p.id === 'string' ? p.id : crypto.randomUUID();
          const syncBody = {
            id: syncId,
            slug: typeof p.slug === 'string' ? p.slug : undefined,
            name: String(p.name ?? ''),
            description: typeof p.description === 'string' ? p.description : undefined,
            version: typeof p.version === 'string' ? p.version : '1.0.0',
            data,
          };
          const result = await workflowService.syncWorkflow(db, userId, syncBody);
          return { success: true, data: { success: true, id: result.id } };
        }

        // ── update_workflow ──────────────────────────────────────────────────
        case 'update_workflow': {
          const workflowId = String(p.workflow_id ?? '');
          // Assemble the update body matching the route's updateWorkflowSchema shape
          const body: Record<string, unknown> = {};
          if (p.name !== undefined) body.name = p.name;
          if (p.clear_description === true) {
            body.description = null;
          } else if (p.description !== undefined) {
            body.description = p.description;
          }
          if (p.clear_slug === true) {
            body.slug = null;
          } else if (p.slug !== undefined) {
            body.slug = p.slug;
          }
          if (p.version !== undefined) body.version = p.version;
          if (p.enabled !== undefined) body.enabled = p.enabled;
          if (typeof p.tags_json === 'string' && p.tags_json.trim().length > 0) {
            body.tags = JSON.parse(p.tags_json);
          }
          if (typeof p.data_json === 'string' && p.data_json.trim().length > 0) {
            body.data = JSON.parse(p.data_json);
          }
          const result = await workflowService.updateWorkflow(env, userId, workflowId, body);
          return { success: true, data: result };
        }

        // ── run_workflow ─────────────────────────────────────────────────────
        case 'run_workflow': {
          const workflowId = String(p.workflow_id ?? '');
          let variables: Record<string, unknown> | undefined;
          if (typeof p.variables_json === 'string' && p.variables_json.trim().length > 0) {
            variables = JSON.parse(p.variables_json) as Record<string, unknown>;
          }
          const requestId = crypto.randomUUID();
          const result = await workflowRun(db, env.DB, env, userId, requestId, {
            workflowId,
            variables,
            repoContext: {
              repoUrl: typeof p.repo_url === 'string' ? p.repo_url : undefined,
              branch: typeof p.repo_branch === 'string' ? p.repo_branch : undefined,
              ref: typeof p.repo_ref === 'string' ? p.repo_ref : undefined,
              sourceRepoFullName: typeof p.source_repo_full_name === 'string' ? p.source_repo_full_name : undefined,
            },
          });
          if (result.error) return { success: false, error: result.error };
          return { success: true, data: result.data };
        }

        // ── delete_workflow ──────────────────────────────────────────────────
        case 'delete_workflow': {
          const workflowId = String(p.workflow_id ?? '');
          await workflowService.deleteWorkflow(db, userId, workflowId);
          return { success: true, data: { success: true } };
        }

        // ── rollback_workflow ────────────────────────────────────────────────
        case 'rollback_workflow': {
          const workflowId = String(p.workflow_id ?? '');
          const targetHash = String(p.target_workflow_hash ?? '');
          const result = await workflowService.rollbackWorkflow(db, userId, workflowId, targetHash, {
            version: typeof p.version === 'string' ? p.version : undefined,
            notes: typeof p.notes === 'string' ? p.notes : undefined,
          });
          return { success: true, data: result };
        }

        // ── create_workflow_proposal ─────────────────────────────────────────
        case 'create_workflow_proposal': {
          const workflowId = String(p.workflow_id ?? '');
          const proposalJson = typeof p.proposal_json === 'string' ? p.proposal_json : '';
          let proposal: Record<string, unknown>;
          try {
            proposal = JSON.parse(proposalJson) as Record<string, unknown>;
          } catch (e) {
            return { success: false, error: `Invalid JSON in proposal_json: ${e instanceof Error ? e.message : String(e)}` };
          }
          const body = {
            executionId: typeof p.execution_id === 'string' ? p.execution_id : undefined,
            proposedBySessionId: typeof p.proposed_by_session_id === 'string' ? p.proposed_by_session_id : undefined,
            baseWorkflowHash: String(p.base_workflow_hash ?? ''),
            proposal,
            diffText: typeof p.diff_text === 'string' ? p.diff_text : undefined,
            expiresAt: typeof p.expires_at === 'string' ? p.expires_at : undefined,
          };
          const result = await workflowService.createProposal(db, userId, workflowId, body);
          return { success: true, data: result };
        }

        // ── list_workflow_proposals ──────────────────────────────────────────
        case 'list_workflow_proposals': {
          const workflowId = String(p.workflow_id ?? '');
          const workflow = await getWorkflowOwnerCheck(db, userId, workflowId);
          if (!workflow) return { success: false, error: `Workflow not found: ${workflowId}` };
          const result = await listWorkflowProposals(env.DB, workflow.id, {
            limit: typeof p.limit === 'number' ? p.limit : 50,
            offset: typeof p.offset === 'number' ? p.offset : 0,
            status: typeof p.status === 'string' ? p.status : undefined,
          });
          const proposals = result.results.map((row) => normalizeProposal(row as Record<string, unknown>));
          return { success: true, data: { proposals } };
        }

        // ── review_workflow_proposal ─────────────────────────────────────────
        case 'review_workflow_proposal': {
          const workflowId = String(p.workflow_id ?? '');
          const proposalId = String(p.proposal_id ?? '');
          const approve = p.approve === true;
          const notes = typeof p.notes === 'string' ? p.notes : undefined;
          const result = await workflowService.reviewProposal(db, userId, workflowId, proposalId, approve, notes);
          return { success: true, data: { success: true, status: result.status, reviewedAt: result.reviewedAt } };
        }

        // ── apply_workflow_proposal ──────────────────────────────────────────
        case 'apply_workflow_proposal': {
          const workflowId = String(p.workflow_id ?? '');
          const proposalId = String(p.proposal_id ?? '');
          const body = {
            reviewNotes: typeof p.review_notes === 'string' ? p.review_notes : undefined,
            version: typeof p.version === 'string' ? p.version : undefined,
          };
          const result = await workflowService.applyProposal(db, userId, workflowId, proposalId, body);
          if (result.alreadyApplied) {
            return { success: true, data: { success: true, status: 'applied', message: 'Proposal already applied' } };
          }
          return { success: true, data: { success: true, proposalId: result.proposalId, workflow: result.workflow } };
        }

        // ── list_workflow_executions ─────────────────────────────────────────
        case 'list_workflow_executions': {
          const workflowId = typeof p.workflow_id === 'string' ? p.workflow_id : undefined;
          const limit = typeof p.limit === 'number' ? p.limit : undefined;
          const result = await workflowExecutions(db, env.DB, userId, workflowId, limit);
          if (result.error) return { success: false, error: result.error };
          return { success: true, data: result.data };
        }

        // ── get_execution ────────────────────────────────────────────────────
        case 'get_execution': {
          const executionId = String(p.execution_id ?? '');
          const result = await handleExecutionAction(db, env.DB, env, userId, 'get', { executionId });
          if (result.error) return { success: false, error: result.error };
          return { success: true, data: result.data };
        }

        // ── get_execution_steps ──────────────────────────────────────────────
        case 'get_execution_steps': {
          const executionId = String(p.execution_id ?? '');
          const stepLimit = typeof p.limit === 'number' ? p.limit : 200;
          const result = await handleExecutionAction(db, env.DB, env, userId, 'steps', { executionId });
          if (result.error) return { success: false, error: result.error };
          const steps = Array.isArray((result.data as Record<string, unknown>)?.steps)
            ? ((result.data as Record<string, unknown>).steps as StepTrace[]).slice(0, stepLimit)
            : [];
          return { success: true, data: { steps } };
        }

        // ── debug_execution ──────────────────────────────────────────────────
        case 'debug_execution': {
          const executionId = String(p.execution_id ?? '');
          const stepLimit = typeof p.step_limit === 'number' ? p.step_limit : 200;

          const execResult = await handleExecutionAction(db, env.DB, env, userId, 'get', { executionId });
          if (execResult.error) return { success: false, error: execResult.error };

          const stepsResult = await handleExecutionAction(db, env.DB, env, userId, 'steps', { executionId });
          if (stepsResult.error) return { success: false, error: stepsResult.error };

          const execution = (execResult.data as Record<string, unknown>).execution as ExecutionSummary;
          const allSteps = Array.isArray((stepsResult.data as Record<string, unknown>)?.steps)
            ? ((stepsResult.data as Record<string, unknown>).steps as StepTrace[])
            : [];
          const steps = allSteps.slice(0, stepLimit);

          const waitingSteps = steps.filter((s) => s.status === 'waiting_approval');
          const failedSteps = steps.filter((s) => s.status === 'failed');
          const runningSteps = steps.filter((s) => s.status === 'running');
          const blockingStep = waitingSteps[0] ?? runningSteps[0] ?? failedSteps[0] ?? null;

          const { diagnosis, actions } = buildDebugDiagnosis(execution, steps);

          return {
            success: true,
            data: {
              executionSummary: {
                id: execution.id,
                workflowId: execution.workflowId,
                status: execution.status,
                triggerType: execution.triggerType,
                error: execution.error ?? null,
                hasResumeToken: Boolean(execution.resumeToken),
                startedAt: execution.startedAt,
                completedAt: execution.completedAt ?? null,
              },
              stepSummary: {
                total: steps.length,
                statusCounts: statusCounts(steps),
                waitingApprovalSteps: waitingSteps.map((s) => s.stepId),
                failedSteps: failedSteps.map((s) => ({
                  stepId: s.stepId,
                  attempt: s.attempt,
                  error: s.error,
                })),
                blockingStep: blockingStep
                  ? {
                      stepId: blockingStep.stepId,
                      status: blockingStep.status,
                      attempt: blockingStep.attempt,
                      error: blockingStep.error,
                      sequence: typeof blockingStep.sequence === 'number' ? blockingStep.sequence : null,
                    }
                  : null,
              },
              diagnosis,
              recommendedActions: actions,
            },
          };
        }

        // ── approve_execution ────────────────────────────────────────────────
        case 'approve_execution': {
          const executionId = String(p.execution_id ?? '');
          const result = await handleExecutionAction(db, env.DB, env, userId, 'approve', {
            executionId,
            approve: p.approve === true,
            resumeToken: String(p.resume_token ?? ''),
            reason: typeof p.reason === 'string' ? p.reason : undefined,
          });
          if (result.error) return { success: false, error: result.error };
          return { success: true, data: result.data };
        }

        // ── cancel_execution ─────────────────────────────────────────────────
        case 'cancel_execution': {
          const executionId = String(p.execution_id ?? '');
          const result = await handleExecutionAction(db, env.DB, env, userId, 'cancel', {
            executionId,
            reason: typeof p.reason === 'string' ? p.reason : undefined,
          });
          if (result.error) return { success: false, error: result.error };
          return { success: true, data: result.data };
        }

        // ── list_triggers ────────────────────────────────────────────────────
        case 'list_triggers': {
          const result = await handleTriggerAction(db, env.DB, env, userId, '', 'list', {
            workflowId: typeof p.workflow_id === 'string' ? p.workflow_id : undefined,
            type: typeof p.type === 'string' ? p.type : undefined,
            enabled: typeof p.enabled === 'boolean' ? p.enabled : undefined,
          } as Record<string, unknown>);
          if (result.error) return { success: false, error: result.error };
          return { success: true, data: result.data };
        }

        // ── sync_trigger ─────────────────────────────────────────────────────
        case 'sync_trigger': {
          const triggerType = String(p.type ?? '');
          const scheduleTarget = typeof p.schedule_target === 'string' ? p.schedule_target : 'workflow';

          let config: Record<string, unknown>;
          if (triggerType === 'webhook') {
            config = {
              type: 'webhook',
              path: String(p.webhook_path ?? ''),
              method: p.webhook_method ?? 'POST',
              secret: p.webhook_secret,
            };
          } else if (triggerType === 'schedule') {
            config = {
              type: 'schedule',
              cron: String(p.schedule_cron ?? ''),
              timezone: p.schedule_timezone,
              target: scheduleTarget,
              prompt: p.schedule_prompt,
            };
          } else {
            config = { type: 'manual' };
          }

          let variableMapping: Record<string, unknown> | undefined;
          if (typeof p.variable_mapping_json === 'string' && p.variable_mapping_json.trim().length > 0) {
            variableMapping = JSON.parse(p.variable_mapping_json) as Record<string, unknown>;
          }

          // Determine if this is a create (sync) or update
          const isUpdate = typeof p.trigger_id === 'string' && p.trigger_id.trim().length > 0;

          if (isUpdate) {
            const result = await handleTriggerAction(db, env.DB, env, userId, '', 'update', {
              triggerId: p.trigger_id,
              name: p.name,
              enabled: p.enabled,
              config,
              workflowId: p.clear_workflow_link === true ? null : (p.workflow_id ?? undefined),
              variableMapping,
            });
            if (result.error) return { success: false, error: result.error };
            return { success: true, data: result.data };
          } else {
            const result = await handleTriggerAction(db, env.DB, env, userId, '', 'sync', {
              name: p.name,
              enabled: p.enabled,
              config,
              workflowId: p.workflow_id ?? null,
              variableMapping,
            });
            if (result.error) return { success: false, error: result.error };
            return { success: true, data: result.data };
          }
        }

        // ── run_trigger ──────────────────────────────────────────────────────
        case 'run_trigger': {
          const triggerId = String(p.trigger_id ?? '');
          let variables: Record<string, unknown> | undefined;
          if (typeof p.variables_json === 'string' && p.variables_json.trim().length > 0) {
            variables = JSON.parse(p.variables_json) as Record<string, unknown>;
          }
          const body = {
            variables,
            repoUrl: typeof p.repo_url === 'string' ? p.repo_url : undefined,
            branch: typeof p.repo_branch === 'string' ? p.repo_branch : undefined,
            ref: typeof p.repo_ref === 'string' ? p.repo_ref : undefined,
            sourceRepoFullName: typeof p.source_repo_full_name === 'string' ? p.source_repo_full_name : undefined,
          };
          // workerOrigin is only needed for rate-limit logging; pass empty string for internal calls
          const result = await triggerService.runTrigger(env, triggerId, userId, body, '');
          if (!result.ok && result.reason !== 'duplicate') {
            return { success: false, error: result.error };
          }
          return { success: true, data: result };
        }

        // ── delete_trigger ───────────────────────────────────────────────────
        case 'delete_trigger': {
          const triggerId = String(p.trigger_id ?? '');
          const result = await handleTriggerAction(db, env.DB, env, userId, '', 'delete', { triggerId });
          if (result.error) return { success: false, error: result.error };
          return { success: true, data: { success: true } };
        }

        default:
          return { success: false, error: `Unknown workflows action "${actionId}".` };
      }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
