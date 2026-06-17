/**
 * Zod schemas for workflow `dag/v1` definitions.
 *
 * Parses untrusted JSON (draft API, publish API, definition snapshots
 * loaded into the interpreter) into the typed shapes in
 * @valet/shared (workflow-dag.ts). The schemas here are the source of
 * truth for structural validation; semantic validation (cycles, ID
 * references, body-type allowlists) lives in validator.ts.
 */

import { z } from 'zod';
import type { WorkflowDefinition } from '@valet/shared';

const jsonValueSchema: z.ZodType<unknown> = z.lazy(() => z.union([
  z.string(),
  z.number(),
  z.boolean(),
  z.null(),
  z.array(jsonValueSchema),
  z.record(jsonValueSchema),
]));

// ─── Inputs ─────────────────────────────────────────────────────────────────

export const workflowInputDefinitionSchema = z.object({
  type: z.enum(['string', 'number', 'boolean', 'object', 'array']),
  required: z.boolean().optional(),
  default: z.unknown().optional(),
  description: z.string().optional(),
  enum: z.array(z.unknown()).optional(),
});

// ─── Edges ──────────────────────────────────────────────────────────────────

export const workflowEdgeSchema = z.object({
  from: z.string().min(1),
  to: z.string().min(1),
  fromOutput: z.enum(['true', 'false']).optional(),
  when: z.string().optional(),
});

// ─── Per-node schemas ───────────────────────────────────────────────────────

// Bounded so the derived event-type string for approvals
// (`approval_${nodeId}:i:${idx}`) stays under CF Workflows' 100-char cap
// even for deeply-nested foreach iterations.
const idSchema = z.string().regex(/^[A-Za-z0-9_-]+$/, 'Node IDs must match [A-Za-z0-9_-]').max(80, 'Node IDs must be ≤80 chars');

export const llmNodeSchema = z.object({
  id: idSchema,
  type: z.literal('llm'),
  model: z.string().optional(),
  system: z.string().optional(),
  prompt: z.string().min(1),
  outputSchema: z.record(z.string(), z.unknown()).optional(),
  temperature: z.number().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});

export const triggerNodeSchema = z.object({
  id: idSchema,
  type: z.literal('trigger'),
});

const ifConditionSchema = z.object({
  left: z.string().min(1),
  dataType: z.enum(['string', 'number', 'date', 'boolean', 'array', 'object']),
  operation: z.string().min(1),
  right: z.unknown().optional(),
});

export const ifNodeSchema = z.object({
  id: idSchema,
  type: z.literal('if'),
  combinator: z.enum(['and', 'or']).optional(),
  conditions: z.array(ifConditionSchema).min(1),
});

export const approvalNodeSchema = z.object({
  id: idSchema,
  type: z.literal('approval'),
  prompt: z.string().min(1),
  summary: z.string().optional(),
  details: z.unknown().optional(),
  timeout: z.string().optional(),
  onDeny: z.enum(['fail', 'skip']).optional(),
});

// wait.mode is only 'duration' in MVP — 'until' is out per spec.
export const waitNodeSchema = z.object({
  id: idSchema,
  type: z.literal('wait'),
  mode: z.literal('duration'),
  duration: z.string().min(1),
});

export const setNodeSchema = z.object({
  id: idSchema,
  type: z.literal('set'),
  values: jsonValueSchema,
});

export const stopNodeSchema = z.object({
  id: idSchema,
  type: z.literal('stop'),
  outcome: z.enum(['success', 'failure']).optional(),
  output: z.unknown().optional(),
  message: z.string().optional(),
});

export const toolNodeSchema = z.object({
  id: idSchema,
  type: z.literal('tool'),
  service: z.string().min(1),
  action: z.string().min(1),
  params: z.record(z.string(), z.unknown()),
  summary: z.string().optional(),
  onPolicyDeny: z.enum(['fail', 'skip']).optional(),
  retries: z.number().int().min(0).max(10).optional(),
});

const waitConfigSchema = z.object({
  mode: z.enum(['none', 'until_idle']),
  timeout: z.string().optional(),
}).optional();

export const orchestratorNodeSchema = z.object({
  id: idSchema,
  type: z.literal('orchestrator'),
  prompt: z.string().min(1),
  forceNewThread: z.boolean().optional(),
  wait: waitConfigSchema,
});

// session — discriminated on `mode`.
export const startSessionNodeSchema = z.object({
  id: idSchema,
  type: z.literal('session'),
  mode: z.literal('start'),
  prompt: z.string().min(1),
  workspace: z.string().min(1),
  title: z.string().optional(),
  personaId: z.string().optional(),
  model: z.string().optional(),
  repo: z.object({
    url: z.string().optional(),
    branch: z.string().optional(),
    ref: z.string().optional(),
    sourceRepoFullName: z.string().optional(),
  }).optional(),
  wait: waitConfigSchema,
});

export const promptSessionNodeSchema = z.object({
  id: idSchema,
  type: z.literal('session'),
  mode: z.literal('prompt'),
  sessionId: z.string().min(1),
  prompt: z.string().min(1),
  threadId: z.string().optional(),
  forceNewThread: z.boolean().optional(),
  wait: waitConfigSchema,
});

export const sessionNodeSchema = z.discriminatedUnion('mode', [
  startSessionNodeSchema,
  promptSessionNodeSchema,
]);

// foreach — body is a restricted node subset.
// Note: foreach body is NOT itself in this union; we model it separately
// because the body allowlist is narrower than top-level nodes (no if, no
// approval, no nested foreach, no wait). Uses z.union (not
// discriminatedUnion) because sessionNodeSchema is itself a DU on `mode`
// and Zod can't nest DUs.
export const foreachBodySchema = z.union([
  llmNodeSchema,
  toolNodeSchema,
  setNodeSchema,
  stopNodeSchema,
  orchestratorNodeSchema,
  sessionNodeSchema,
]);

export const foreachNodeSchema = z.object({
  id: idSchema,
  type: z.literal('foreach'),
  items: z.string().min(1),
  body: foreachBodySchema,
  maxItems: z.number().int().positive().optional(),
  concurrency: z.number().int().min(1).max(20).optional(),
  itemAlias: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  indexAlias: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).optional(),
  onItemError: z.enum(['fail', 'skip', 'collect']).optional(),
});

// Top-level node union. z.union (not discriminatedUnion) because
// sessionNodeSchema is itself a DU on `mode`; nested DUs aren't allowed.
export const workflowNodeSchema = z.union([
  triggerNodeSchema,
  llmNodeSchema,
  ifNodeSchema,
  foreachNodeSchema,
  approvalNodeSchema,
  waitNodeSchema,
  setNodeSchema,
  stopNodeSchema,
  toolNodeSchema,
  orchestratorNodeSchema,
  sessionNodeSchema,
]);

// ─── Policy + editor metadata ───────────────────────────────────────────────

export const workflowPolicySchema = z.object({
  maxNodes: z.number().int().positive().optional(),
  maxConcurrentNodes: z.number().int().positive().optional(),
  maxWaitDurationMs: z.number().int().positive().optional(),
  maxForeachItems: z.number().int().positive().optional(),
  maxForeachConcurrency: z.number().int().positive().optional(),
});

export const workflowEditorStateSchema = z.object({
  nodes: z.record(z.string(), z.object({
    position: z.object({ x: z.number(), y: z.number() }),
    collapsed: z.boolean().optional(),
  })),
  viewport: z.object({
    x: z.number(),
    y: z.number(),
    zoom: z.number(),
  }).optional(),
});

// ─── Top-level definition ───────────────────────────────────────────────────

export const workflowDefinitionSchema = z.object({
  version: z.literal('dag/v1'),
  inputs: z.record(z.string(), workflowInputDefinitionSchema).optional(),
  nodes: z.array(workflowNodeSchema).min(1),
  edges: z.array(workflowEdgeSchema),
  policy: workflowPolicySchema.optional(),
  ui: workflowEditorStateSchema.optional(),
});

export function isWorkflowDefinition(input: unknown): input is WorkflowDefinition {
  return workflowDefinitionSchema.safeParse(input).success;
}
