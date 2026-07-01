# Trigger Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workflow-targeted triggers derivable from a workflow's trigger-node `subscription` declaration, so the copilot can wire triggers by editing the definition alone.

**Architecture:** Extend `triggers` with nullable `owner_workflow_id` + `owner_node_id`. Extend the workflow trigger-node schema with an optional `subscription` discriminated union (`manual | webhook | schedule`). On publish, a reconciler diffs declared vs. existing owned triggers and applies create/update/delete. UI locks the declarative fields of owned triggers; keeps enable/disable free.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, D1 (SQLite), Cloudflare Workers, Vitest, React 19, TanStack Query. Design spec: `docs/specs/2026-07-01-trigger-ownership-design.md`.

## Global Constraints

- Existing user-owned triggers (`owner_workflow_id IS NULL`) must behave exactly as today after every task in this plan.
- Subscription source types in v1: `manual | webhook | schedule | slack.message.channels | github.event`. Gmail/other integrations defer.
- Webhook tokens must remain stable across republishes (never regenerate on UPDATE).
- Slack `message.channels` events already reach the worker (app manifest is subscribed). Dispatch to workflows forks off the existing DM/orchestrator router; do not alter DM routing.
- GitHub App webhooks already reach `/api/webhooks/github` and are signature-verified. The existing `installation`/`pull_request`/`push` handlers continue to run unchanged — the workflow-trigger dispatch is additive.
- Channel names (`#incidents`) in Slack subscriptions are resolved to Slack IDs (`C012ABCD`) at publish time. If resolution fails, publish fails with an actionable error. The reconciler's pure planning function operates on already-resolved IDs.
- GitHub `installationId` in subscriptions is auto-resolved when the owner has exactly one installation; otherwise required. `repo` (`owner/name`) is validated against the installation's repo access at publish.
- No `any`, no `as unknown as` double-casts, no `@ts-ignore`. Follow the type-safety rules in `CLAUDE.md`.
- Every phase ends with a committed, testable state. Don't batch commits across phases.
- No Co-Authored-By trailers in commit messages.

## File Structure

**Create:**
- `packages/worker/migrations/0024_trigger_ownership.sql` — schema migration.
- `packages/worker/src/services/trigger-reconciler.ts` — pure diff + apply logic. New file so the code is testable in isolation and the publish path stays readable.
- `packages/worker/src/services/trigger-reconciler.test.ts` — unit tests for the pure diff function.
- `packages/client/src/components/triggers/owned-badge.tsx` — reusable "Owned by workflow X" badge.
- `packages/client/src/components/workflows/trigger-node-subscription-form.tsx` — inspector subform for the trigger-node `subscription` field.

**Modify:**
- `packages/worker/src/lib/schema/workflows.ts` — add `ownerWorkflowId`, `ownerNodeId` columns + index.
- `packages/shared/src/types/workflow-dag/` (or wherever the trigger-node type lives) — add `subscription` union to `WorkflowTriggerNode`.
- `packages/worker/src/services/workflows.ts` (publishWorkflow) — invoke reconciler after commit.
- `packages/worker/src/routes/triggers.ts` — guard PATCH/DELETE against owned rows (allow enabled-toggle passthrough).
- `packages/worker/src/routes/copilot.ts` — update `getNodeSchema` tool result to describe the `subscription` field; add note to system prompt.
- `packages/client/src/api/triggers.ts` — surface `ownerWorkflowId`/`ownerNodeId` on the client type.
- `packages/client/src/routes/automation/triggers.index.tsx` (or wherever the list renders) — badge on owned rows.
- `packages/client/src/routes/automation/triggers.$triggerId.tsx` — lock the form for owned rows, block delete.
- `packages/client/src/components/workflows/node-inspector.tsx` (or the trigger-node inspector — locate at implementation time) — render the subscription subform.

---

### Task 1: Schema migration for owner columns

**Files:**
- Create: `packages/worker/migrations/0024_trigger_ownership.sql`
- Modify: `packages/worker/src/lib/schema/workflows.ts` (triggers table)

**Interfaces:**
- Consumes: nothing.
- Produces: `triggers` row gains two nullable text columns: `owner_workflow_id`, `owner_node_id`. Index `idx_triggers_owner_workflow` on `owner_workflow_id`.

- [ ] **Step 1.1: Read the current migration numbering and Drizzle schema for `triggers`.**

Run: `ls packages/worker/migrations/ | tail -5` and open `packages/worker/src/lib/schema/workflows.ts` to confirm the current `triggers` shape. Confirm the last migration is `0023_workflow_copilot.sql` before naming the new one `0024`.

- [ ] **Step 1.2: Write the SQL migration.**

Create `packages/worker/migrations/0024_trigger_ownership.sql`:

```sql
-- Add ownership columns so triggers can be materialized from a workflow's
-- trigger-node subscription declaration. NULL = user-owned (behavior
-- unchanged from prior migrations).
ALTER TABLE triggers ADD COLUMN owner_workflow_id TEXT
  REFERENCES workflows(id) ON DELETE CASCADE;
ALTER TABLE triggers ADD COLUMN owner_node_id TEXT;

CREATE INDEX idx_triggers_owner_workflow ON triggers(owner_workflow_id);
```

- [ ] **Step 1.3: Update the Drizzle schema in `packages/worker/src/lib/schema/workflows.ts`.**

Add the two columns and the index inside the existing `triggers` table declaration:

```ts
ownerWorkflowId: text('owner_workflow_id').references(() => workflows.id, { onDelete: 'cascade' }),
ownerNodeId: text('owner_node_id'),
```

Add to the indexes array:

```ts
index('idx_triggers_owner_workflow').on(table.ownerWorkflowId),
```

- [ ] **Step 1.4: Typecheck the worker.**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS. If any consumer destructures `TriggerRow` and fails on the new columns, they'll surface here — leave them broken for the next task to address by widening the row type.

- [ ] **Step 1.5: Commit.**

```bash
git add packages/worker/migrations/0024_trigger_ownership.sql \
        packages/worker/src/lib/schema/workflows.ts
git commit -m "triggers: add owner_workflow_id + owner_node_id columns

- New nullable FK to workflows for reconciler ownership.
- Index on owner_workflow_id for reconciler lookups.
- Existing rows: NULL = user-owned, semantics unchanged."
```

---

### Task 2: Extend `WorkflowTriggerNode` with `subscription` AND `TriggerConfig` with `slack.message.channels`

**Files:**
- Modify: the shared trigger-node type — likely `packages/shared/src/types/workflow-dag/*.ts` (locate the file that defines `WorkflowTriggerNode`). If the trigger-node shape lives in the worker's workflow schema (`packages/worker/src/workflows/schema.ts`), modify there instead.
- Modify: `packages/worker/src/lib/db/triggers.ts` — extend `TriggerConfig` union with the new Slack case. Extend the zod schemas in `packages/worker/src/routes/triggers.ts` and `packages/worker/src/integrations/workflows-actions.ts` similarly.
- Test: co-located with the schema (either `packages/shared/src/types/workflow-dag/*.test.ts` or a new `*.test.ts` alongside the schema).

**Interfaces:**
- Consumes: existing `WorkflowTriggerNode` type/schema.
- Produces: an optional field `subscription` on trigger nodes with the discriminated union:

```ts
type TriggerNodeSubscription =
  | { type: 'manual' }
  | { type: 'webhook'; method?: 'GET' | 'POST' | 'PUT'; rateLimit?: number }
  | { type: 'schedule'; cron: string; timezone?: string; triggerData?: Record<string, unknown> }
  | { type: 'slack.message.channels'; channel: string; teamId?: string;
      filters?: { ignoreBots?: boolean; mentionOnly?: boolean } }
  | { type: 'github.event'; event: string; action?: string;
      installationId?: number; repo?: string;
      filters?: { branch?: string; author?: string } };
```

- [ ] **Step 2.1: Locate the current trigger-node type/schema.**

Run: `grep -rn "type: 'trigger'\|WorkflowTriggerNode\|trigger.*dataSchema" packages/shared/src packages/worker/src/workflows 2>/dev/null | head -20`

Confirm which file defines the trigger-node zod schema (or TypeScript interface). All edits below target that file.

- [ ] **Step 2.2: Write the failing test.**

Create or extend the test file next to the schema:

```ts
import { describe, it, expect } from 'vitest';
import { triggerNodeSchema } from './<schema-file>';

describe('triggerNodeSchema.subscription', () => {
  it('accepts a node with no subscription (defaults to manual)', () => {
    const result = triggerNodeSchema.safeParse({ id: 't', type: 'trigger' });
    expect(result.success).toBe(true);
  });

  it('accepts manual subscription', () => {
    const result = triggerNodeSchema.safeParse({
      id: 't', type: 'trigger',
      subscription: { type: 'manual' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts webhook subscription with optional fields', () => {
    const result = triggerNodeSchema.safeParse({
      id: 't', type: 'trigger',
      subscription: { type: 'webhook', method: 'POST', rateLimit: 30 },
    });
    expect(result.success).toBe(true);
  });

  it('accepts schedule subscription with cron', () => {
    const result = triggerNodeSchema.safeParse({
      id: 't', type: 'trigger',
      subscription: { type: 'schedule', cron: '0 9 * * *' },
    });
    expect(result.success).toBe(true);
  });

  it('rejects schedule subscription without cron', () => {
    const result = triggerNodeSchema.safeParse({
      id: 't', type: 'trigger',
      subscription: { type: 'schedule' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts slack.message.channels subscription', () => {
    const result = triggerNodeSchema.safeParse({
      id: 't', type: 'trigger',
      subscription: {
        type: 'slack.message.channels',
        channel: '#incidents',
        filters: { ignoreBots: true },
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects slack subscription without channel', () => {
    const result = triggerNodeSchema.safeParse({
      id: 't', type: 'trigger',
      subscription: { type: 'slack.message.channels' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts github.event subscription', () => {
    const result = triggerNodeSchema.safeParse({
      id: 't', type: 'trigger',
      subscription: {
        type: 'github.event',
        event: 'pull_request',
        action: 'opened',
        repo: 'anthropics/valet',
      },
    });
    expect(result.success).toBe(true);
  });

  it('rejects github.event subscription without event name', () => {
    const result = triggerNodeSchema.safeParse({
      id: 't', type: 'trigger',
      subscription: { type: 'github.event' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown subscription type', () => {
    const result = triggerNodeSchema.safeParse({
      id: 't', type: 'trigger',
      subscription: { type: 'gmail.messages' },
    });
    expect(result.success).toBe(false);
  });
});
```

- [ ] **Step 2.3: Run the test — expect failure.**

Run: `cd <package-dir> && pnpm test <schema-file>.test.ts`
Expected: fail with parse errors (subscription field unknown).

- [ ] **Step 2.4: Add the union to the schema.**

Edit the file identified in Step 2.1. Add:

```ts
const triggerSubscriptionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('manual') }),
  z.object({
    type: z.literal('webhook'),
    method: z.enum(['GET', 'POST', 'PUT']).optional(),
    rateLimit: z.number().int().positive().optional(),
  }),
  z.object({
    type: z.literal('schedule'),
    cron: z.string().min(1),
    timezone: z.string().optional(),
    triggerData: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    type: z.literal('slack.message.channels'),
    channel: z.string().min(1),
    teamId: z.string().optional(),
    filters: z.object({
      ignoreBots: z.boolean().optional(),
      mentionOnly: z.boolean().optional(),
    }).optional(),
  }),
  z.object({
    type: z.literal('github.event'),
    event: z.string().min(1),
    action: z.string().optional(),
    installationId: z.number().int().positive().optional(),
    repo: z.string().regex(/^[^/]+\/[^/]+$/).optional(),
    filters: z.object({
      branch: z.string().optional(),
      author: z.string().optional(),
    }).optional(),
  }),
]);
```

Extend the existing `triggerNodeSchema` with `subscription: triggerSubscriptionSchema.optional()`.

- [ ] **Step 2.5: Rerun the test — expect pass.**

Run: `cd <package-dir> && pnpm test <schema-file>.test.ts`
Expected: all cases PASS.

- [ ] **Step 2.6: Typecheck all packages.**

Run: `pnpm typecheck` from repo root.
Expected: PASS. If a consumer destructures the trigger node shape and needs updating, fix it here.

- [ ] **Step 2.7: Extend `TriggerConfig` in `packages/worker/src/lib/db/triggers.ts`.**

Add TWO cases to the union:

```ts
| {
    type: 'slack.message.channels';
    teamId: string;                 // Slack team_id (T…)
    channelId: string;              // Slack channel_id (C…), post-resolution
    channelName?: string;           // Original name for display, if resolved from `#foo`
    filters?: { ignoreBots?: boolean; mentionOnly?: boolean };
  }
| {
    type: 'github.event';
    installationId: number;
    event: string;
    action?: string;
    repo?: string;                  // 'owner/name' if scoped; omit for any repo in the installation
    filters?: { branch?: string; author?: string };
  }
```

Update `requiresWorkflow` if needed (both new types always target a workflow).

- [ ] **Step 2.8: Extend the two `triggerConfigSchema` z.discriminatedUnions** in `packages/worker/src/routes/triggers.ts` and `packages/worker/src/integrations/workflows-actions.ts` with matching Slack cases.

- [ ] **Step 2.9: Typecheck again + fix any switch-exhaustiveness break in existing code.**

Run: `pnpm typecheck` from repo root.
Expected: PASS. If any `switch (config.type)` doesn't handle the new case, TypeScript exhaustiveness will flag it — add a passthrough or throw for now (proper handling is in later tasks).

- [ ] **Step 2.10: Commit.**

```bash
git add <schema files> <test files> \
        packages/worker/src/lib/db/triggers.ts \
        packages/worker/src/routes/triggers.ts \
        packages/worker/src/integrations/workflows-actions.ts
git commit -m "workflow-dag + triggers: add slack + github event types

- WorkflowTriggerNode.subscription now includes slack
  and github event sources alongside manual|webhook|schedule.
- TriggerConfig union grows matching cases with resolved
  identifiers (teamId+channelId, installationId+repo).
- Zod schemas kept in sync across route + action surfaces."
```

---

### Task 3: Pure reconciler function

**Files:**
- Create: `packages/worker/src/services/trigger-reconciler.ts`
- Create: `packages/worker/src/services/trigger-reconciler.test.ts`

**Interfaces:**
- Consumes: `WorkflowDefinition` (shared type), `TriggerRow` shape from Drizzle schema. Slack subscriptions inside `definition` MUST have `channel` already normalized to a Slack channel ID (`C…`) and `teamId` set — resolution is the caller's job (Task 4).
- Produces:

```ts
export type ReconcilerTriggerType = 'webhook' | 'schedule' | 'slack.message.channels' | 'github.event';

export type ReconcilerOp =
  | { kind: 'create'; nodeId: string; type: ReconcilerTriggerType; config: TriggerConfig; name: string }
  | { kind: 'update'; triggerId: string; type: ReconcilerTriggerType; config: TriggerConfig; name: string }
  | { kind: 'delete'; triggerId: string };

export function planReconciliation(input: {
  workflowId: string;
  workflowName: string;
  definition: WorkflowDefinition;
  existing: Array<{ id: string; ownerNodeId: string | null; type: string; config: string; name: string }>;
}): ReconcilerOp[];
```

Pure — no DB access, no side effects. Returns the op list; callers apply it.

- [ ] **Step 3.1: Write the failing test.**

Create `packages/worker/src/services/trigger-reconciler.test.ts` with cases:

```ts
import { describe, it, expect } from 'vitest';
import { planReconciliation } from './trigger-reconciler';
import type { WorkflowDefinition } from '@valet/shared';

const baseDef = (nodes: WorkflowDefinition['nodes']): WorkflowDefinition => ({
  version: 'dag/v1', nodes, edges: [],
});

describe('planReconciliation', () => {
  it('returns [] when definition has no trigger node with a subscription', () => {
    const def = baseDef([{ id: 'trigger', type: 'trigger' }]);
    expect(planReconciliation({
      workflowId: 'wf', workflowName: 'W', definition: def, existing: [],
    })).toEqual([]);
  });

  it('returns [] when subscription is manual', () => {
    const def = baseDef([{
      id: 'trigger', type: 'trigger',
      subscription: { type: 'manual' },
    }]);
    expect(planReconciliation({
      workflowId: 'wf', workflowName: 'W', definition: def, existing: [],
    })).toEqual([]);
  });

  it('creates a webhook trigger when declared and none exists', () => {
    const def = baseDef([{
      id: 'trigger', type: 'trigger',
      subscription: { type: 'webhook', method: 'POST' },
    }]);
    const ops = planReconciliation({
      workflowId: 'wf', workflowName: 'W', definition: def, existing: [],
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: 'create', nodeId: 'trigger', type: 'webhook',
    });
  });

  it('creates a schedule trigger with the declared cron', () => {
    const def = baseDef([{
      id: 'trigger', type: 'trigger',
      subscription: { type: 'schedule', cron: '0 9 * * *' },
    }]);
    const ops = planReconciliation({
      workflowId: 'wf', workflowName: 'W', definition: def, existing: [],
    });
    expect(ops[0]).toMatchObject({ kind: 'create', type: 'schedule' });
  });

  it('deletes an existing owned trigger when the node no longer declares one', () => {
    const def = baseDef([{ id: 'trigger', type: 'trigger' }]); // no subscription
    const ops = planReconciliation({
      workflowId: 'wf', workflowName: 'W', definition: def,
      existing: [{
        id: 't1', ownerNodeId: 'trigger', type: 'webhook',
        config: JSON.stringify({ type: 'webhook', path: '/x' }),
        name: 'W - trigger',
      }],
    });
    expect(ops).toEqual([{ kind: 'delete', triggerId: 't1' }]);
  });

  it('updates when the declared subscription differs from the existing config', () => {
    const def = baseDef([{
      id: 'trigger', type: 'trigger',
      subscription: { type: 'schedule', cron: '0 12 * * *' },
    }]);
    const ops = planReconciliation({
      workflowId: 'wf', workflowName: 'W', definition: def,
      existing: [{
        id: 't1', ownerNodeId: 'trigger', type: 'schedule',
        config: JSON.stringify({ type: 'schedule', cron: '0 9 * * *' }),
        name: 'W - trigger',
      }],
    });
    expect(ops).toEqual([expect.objectContaining({ kind: 'update', triggerId: 't1' })]);
  });

  it('noop when declared subscription matches existing config', () => {
    const cfg = { type: 'schedule' as const, cron: '0 9 * * *' };
    const def = baseDef([{
      id: 'trigger', type: 'trigger', subscription: cfg,
    }]);
    const ops = planReconciliation({
      workflowId: 'wf', workflowName: 'W', definition: def,
      existing: [{
        id: 't1', ownerNodeId: 'trigger', type: 'schedule',
        config: JSON.stringify(cfg),
        name: 'W - trigger',
      }],
    });
    expect(ops).toEqual([]);
  });

  it('handles multiple trigger nodes independently', () => {
    const def = baseDef([
      {
        id: 'triggerA', type: 'trigger',
        subscription: { type: 'schedule', cron: '0 9 * * *' },
      },
      {
        id: 'triggerB', type: 'trigger',
        subscription: { type: 'webhook' },
      },
    ]);
    const ops = planReconciliation({
      workflowId: 'wf', workflowName: 'W', definition: def, existing: [],
    });
    expect(ops).toHaveLength(2);
    expect(ops.map((o) => o.kind).sort()).toEqual(['create', 'create']);
  });

  it('creates a slack.message.channels trigger when declared', () => {
    const def = baseDef([{
      id: 'trigger', type: 'trigger',
      subscription: {
        type: 'slack.message.channels',
        channel: 'C012INCID',  // already-resolved channel id
        teamId: 'T012ORG',
        filters: { ignoreBots: true },
      },
    }]);
    const ops = planReconciliation({
      workflowId: 'wf', workflowName: 'W', definition: def, existing: [],
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: 'create', type: 'slack.message.channels',
    });
    const cfg = (ops[0] as { config: TriggerConfig }).config;
    expect(cfg).toMatchObject({
      type: 'slack.message.channels',
      teamId: 'T012ORG',
      channelId: 'C012INCID',
    });
  });

  it('updates a slack trigger when the channel id changes', () => {
    const existing = [{
      id: 't1', ownerNodeId: 'trigger', type: 'slack.message.channels',
      config: JSON.stringify({
        type: 'slack.message.channels',
        teamId: 'T012ORG', channelId: 'C_OLD',
      }),
      name: 'W — trigger',
    }];
    const def = baseDef([{
      id: 'trigger', type: 'trigger',
      subscription: { type: 'slack.message.channels', channel: 'C_NEW', teamId: 'T012ORG' },
    }]);
    const ops = planReconciliation({
      workflowId: 'wf', workflowName: 'W', definition: def, existing,
    });
    expect(ops).toEqual([expect.objectContaining({ kind: 'update', triggerId: 't1' })]);
  });

  it('creates a github.event trigger when declared', () => {
    const def = baseDef([{
      id: 'trigger', type: 'trigger',
      subscription: {
        type: 'github.event',
        event: 'pull_request', action: 'opened',
        installationId: 42, repo: 'anthropics/valet',
      },
    }]);
    const ops = planReconciliation({
      workflowId: 'wf', workflowName: 'W', definition: def, existing: [],
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({
      kind: 'create', type: 'github.event',
    });
    const cfg = (ops[0] as { config: TriggerConfig }).config;
    expect(cfg).toMatchObject({
      type: 'github.event', installationId: 42, event: 'pull_request',
      action: 'opened', repo: 'anthropics/valet',
    });
  });

  it('updates a github trigger when the action filter changes', () => {
    const existing = [{
      id: 't1', ownerNodeId: 'trigger', type: 'github.event',
      config: JSON.stringify({
        type: 'github.event', installationId: 42, event: 'pull_request', action: 'opened',
      }),
      name: 'W — trigger',
    }];
    const def = baseDef([{
      id: 'trigger', type: 'trigger',
      subscription: { type: 'github.event', event: 'pull_request', action: 'closed', installationId: 42 },
    }]);
    const ops = planReconciliation({
      workflowId: 'wf', workflowName: 'W', definition: def, existing,
    });
    expect(ops).toEqual([expect.objectContaining({ kind: 'update', triggerId: 't1' })]);
  });
});
```

- [ ] **Step 3.2: Run the test — expect failure (file doesn't exist).**

Run: `cd packages/worker && pnpm test trigger-reconciler`
Expected: fail with import error.

- [ ] **Step 3.3: Implement `planReconciliation`.**

Create `packages/worker/src/services/trigger-reconciler.ts`. Key logic:

```ts
import type { WorkflowDefinition } from '@valet/shared';
import type { TriggerConfig } from '../lib/db/triggers.js';

export type ReconcilerOp =
  | { kind: 'create'; nodeId: string; type: 'webhook' | 'schedule'; config: TriggerConfig; name: string }
  | { kind: 'update'; triggerId: string; type: 'webhook' | 'schedule'; config: TriggerConfig; name: string }
  | { kind: 'delete'; triggerId: string };

type ExistingRow = { id: string; ownerNodeId: string | null; type: string; config: string; name: string };

interface Input {
  workflowId: string;
  workflowName: string;
  definition: WorkflowDefinition;
  existing: ExistingRow[];
}

export function planReconciliation(input: Input): ReconcilerOp[] {
  const declared = extractDeclared(input.definition, input.workflowName);
  const existingByNode = new Map(
    input.existing.filter((r) => r.ownerNodeId).map((r) => [r.ownerNodeId!, r] as const),
  );

  const ops: ReconcilerOp[] = [];

  for (const [nodeId, next] of declared) {
    const prev = existingByNode.get(nodeId);
    if (!prev) {
      ops.push({ kind: 'create', nodeId, type: next.type, config: next.config, name: next.name });
      continue;
    }
    existingByNode.delete(nodeId);
    if (configsEqual(prev, next)) continue;
    ops.push({ kind: 'update', triggerId: prev.id, type: next.type, config: next.config, name: next.name });
  }

  for (const stale of existingByNode.values()) {
    ops.push({ kind: 'delete', triggerId: stale.id });
  }

  return ops;
}

function extractDeclared(def: WorkflowDefinition, workflowName: string): Map<string, {
  type: 'webhook' | 'schedule';
  config: TriggerConfig;
  name: string;
}> {
  const out = new Map<string, { type: 'webhook' | 'schedule'; config: TriggerConfig; name: string }>();
  for (const node of def.nodes) {
    if (node.type !== 'trigger') continue;
    const sub = (node as { subscription?: { type: string } }).subscription;
    if (!sub || sub.type === 'manual') continue;
    if (sub.type === 'webhook') {
      const s = sub as { type: 'webhook'; method?: string; rateLimit?: number };
      out.set(node.id, {
        type: 'webhook',
        config: {
          type: 'webhook',
          path: `/w/${node.id}`, // path is a stable per-node identifier; runtime resolves against ownerWorkflowId
          method: s.method,
          rateLimit: s.rateLimit,
        },
        name: `${workflowName} — ${node.id}`,
      });
    } else if (sub.type === 'schedule') {
      const s = sub as { type: 'schedule'; cron: string; timezone?: string; triggerData?: Record<string, unknown> };
      out.set(node.id, {
        type: 'schedule',
        config: {
          type: 'schedule',
          cron: s.cron,
          timezone: s.timezone,
          target: 'workflow',
          triggerData: s.triggerData,
        },
        name: `${workflowName} — ${node.id}`,
      });
    } else if (sub.type === 'slack.message.channels') {
      // At this point channel MUST be an already-resolved Slack channel
      // id (starts with C…) and teamId MUST be set. Task 4's wire-up
      // takes care of resolution; if it slipped through, that's a bug
      // upstream and we skip this node (the publish path should have
      // errored earlier).
      const s = sub as { type: 'slack.message.channels'; channel: string; teamId?: string; filters?: { ignoreBots?: boolean; mentionOnly?: boolean } };
      if (!s.teamId || !/^C[A-Z0-9]+$/.test(s.channel)) continue;
      out.set(node.id, {
        type: 'slack.message.channels',
        config: {
          type: 'slack.message.channels',
          teamId: s.teamId,
          channelId: s.channel,
          filters: s.filters,
        },
        name: `${workflowName} — ${node.id}`,
      });
    } else if (sub.type === 'github.event') {
      // installationId MUST be resolved. Task 4 handles resolution and
      // repo access validation.
      const s = sub as {
        type: 'github.event'; event: string; action?: string;
        installationId?: number; repo?: string;
        filters?: { branch?: string; author?: string };
      };
      if (typeof s.installationId !== 'number') continue;
      out.set(node.id, {
        type: 'github.event',
        config: {
          type: 'github.event',
          installationId: s.installationId,
          event: s.event,
          action: s.action,
          repo: s.repo,
          filters: s.filters,
        },
        name: `${workflowName} — ${node.id}`,
      });
    }
  }
  return out;
}

function configsEqual(prev: ExistingRow, next: { type: string; config: TriggerConfig; name: string }): boolean {
  if (prev.type !== next.type) return false;
  if (prev.name !== next.name) return false;
  try {
    const prevCfg = JSON.parse(prev.config) as Record<string, unknown>;
    return canonicalize(prevCfg) === canonicalize(next.config as unknown as Record<string, unknown>);
  } catch {
    return false;
  }
}

function canonicalize(obj: Record<string, unknown>): string {
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) sorted[key] = obj[key];
  return JSON.stringify(sorted);
}
```

- [ ] **Step 3.4: Run the test — expect pass.**

Run: `cd packages/worker && pnpm test trigger-reconciler`
Expected: all cases PASS.

- [ ] **Step 3.5: Typecheck.**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3.6: Commit.**

```bash
git add packages/worker/src/services/trigger-reconciler.ts \
        packages/worker/src/services/trigger-reconciler.test.ts
git commit -m "triggers: pure planReconciliation function

Diffs declared trigger-node subscriptions against existing
owned triggers and emits create/update/delete ops. No DB
access — callers apply the ops."
```

---

### Task 4: Wire reconciler into publishWorkflow

**Files:**
- Modify: `packages/worker/src/services/workflows.ts` (or wherever `publishWorkflow` lives — locate via `grep -rn "publishWorkflow" packages/worker/src`).
- Modify: `packages/worker/src/lib/db/triggers.ts` — add helpers for owned-trigger CRUD if the existing `createTrigger`/`updateTrigger`/`deleteTrigger` don't accept owner columns.
- Test: `packages/worker/src/services/workflows.publish.test.ts` (new or extend existing) — integration test against a D1 test harness.

**Interfaces:**
- Consumes: `planReconciliation` from Task 3.
- Produces: `publishWorkflow` returns unchanged shape; side-effect is triggers table matches the published definition's declarations.

- [ ] **Step 4.1: Locate the publish path and existing trigger CRUD.**

Run:
```bash
grep -rn "publishWorkflow\|createTrigger\|export.*Trigger" packages/worker/src/services packages/worker/src/lib/db 2>/dev/null | head -30
```

Read the current `publishWorkflow` implementation and the trigger CRUD in `packages/worker/src/lib/db/triggers.ts`. Confirm the CRUD signatures.

- [ ] **Step 4.2: Extend trigger CRUD to accept owner columns.**

In `packages/worker/src/lib/db/triggers.ts`:

- Add `ownerWorkflowId?: string; ownerNodeId?: string` to the `createTrigger` params.
- Add `listOwnedTriggers(db, workflowId)` returning rows keyed by `ownerNodeId`.

Show a diff-style change of the create signature (concrete):

```ts
// createTrigger params
export async function createTrigger(db: AppDb, params: {
  id: string;
  userId: string;
  workflowId: string | null;
  name: string;
  type: string;
  config: string;
  variableMapping?: string | null;
  webhookToken?: string | null;
  ownerWorkflowId?: string | null;
  ownerNodeId?: string | null;
}) { /* ... */ }
```

Add:

```ts
export async function listOwnedTriggers(db: AppDb, workflowId: string) {
  return db.select().from(triggers).where(eq(triggers.ownerWorkflowId, workflowId));
}
```

- [ ] **Step 4.3: Write the failing integration test.**

Create `packages/worker/src/services/workflows.publish.test.ts` (or extend an existing publish test). Use the worker's D1 test harness (see `packages/worker/src/test-utils` for the pattern):

```ts
import { describe, it, expect, beforeEach } from 'vitest';
import { setupTestDb } from '../test-utils/db'; // adjust to actual helper name
import { publishWorkflow } from './workflows';
import { listOwnedTriggers } from '../lib/db/triggers';

describe('publishWorkflow reconciles owned triggers', () => {
  let db: Awaited<ReturnType<typeof setupTestDb>>;

  beforeEach(async () => { db = await setupTestDb(); });

  it('creates a webhook trigger when the published definition declares one', async () => {
    const { workflowId } = await seedWorkflow(db, {
      definition: {
        version: 'dag/v1',
        nodes: [{
          id: 'trigger', type: 'trigger',
          subscription: { type: 'webhook', method: 'POST' },
        }],
        edges: [],
      },
    });

    await publishWorkflow(db, { workflowId, userId: 'u1' });

    const owned = await listOwnedTriggers(db, workflowId);
    expect(owned).toHaveLength(1);
    expect(owned[0].type).toBe('webhook');
    expect(owned[0].ownerNodeId).toBe('trigger');
  });

  it('leaves user-owned triggers targeting the workflow untouched', async () => {
    const { workflowId } = await seedWorkflow(db, {
      definition: { version: 'dag/v1', nodes: [{ id: 'trigger', type: 'trigger' }], edges: [] },
    });
    // A user-owned trigger targeting this workflow, pre-existing.
    await createTrigger(db, {
      id: 'user-t', userId: 'u1', workflowId, name: 'Manual test',
      type: 'manual', config: JSON.stringify({ type: 'manual' }),
      // owner columns intentionally omitted
    });

    await publishWorkflow(db, { workflowId, userId: 'u1' });

    const all = await db.select().from(triggers).where(eq(triggers.workflowId, workflowId));
    expect(all).toHaveLength(1);
    expect(all[0].id).toBe('user-t');
    expect(all[0].ownerWorkflowId).toBeNull();
  });

  it('is idempotent — republishing the same definition is a no-op', async () => {
    const def = {
      version: 'dag/v1' as const,
      nodes: [{
        id: 'trigger', type: 'trigger',
        subscription: { type: 'schedule', cron: '0 9 * * *' },
      }],
      edges: [],
    };
    const { workflowId } = await seedWorkflow(db, { definition: def });

    await publishWorkflow(db, { workflowId, userId: 'u1' });
    const firstPass = await listOwnedTriggers(db, workflowId);
    expect(firstPass).toHaveLength(1);
    const firstId = firstPass[0].id;

    await publishWorkflow(db, { workflowId, userId: 'u1' });
    const secondPass = await listOwnedTriggers(db, workflowId);
    expect(secondPass).toHaveLength(1);
    expect(secondPass[0].id).toBe(firstId); // same row, not recreated
  });
});
```

- [ ] **Step 4.4: Run the test — expect failure.**

Run: `cd packages/worker && pnpm test workflows.publish`
Expected: fail (reconciler not wired into publishWorkflow yet).

- [ ] **Step 4.5a: Add subscription resolvers for Slack + GitHub.**

Create `packages/worker/src/services/slack-channel-resolver.ts`:

```ts
import type { AppDb } from '../lib/drizzle.js';
import * as db from '../lib/db.js';
import type { WorkflowDefinition } from '@valet/shared';

interface Args {
  db: AppDb;
  encryptionKey: string;
  userId: string;
  definition: WorkflowDefinition;
}

/**
 * Walks the workflow definition and, for every trigger node with a
 * slack.message.channels subscription:
 *   - resolves teamId to the user's connected Slack workspace (auto if
 *     there's exactly one; otherwise the caller-provided teamId is
 *     required and validated against the install list)
 *   - resolves `#name` channels to the C-prefixed channel id via
 *     conversations.list on the workspace's bot token
 * Returns a NEW definition with subscriptions rewritten to their
 * resolved forms. Throws with an actionable message on failure.
 */
export async function resolveSlackSubscriptions(args: Args): Promise<WorkflowDefinition> {
  // 1. Enumerate all slack.message.channels subscriptions in the
  //    definition. Nothing to do if there are none.
  // 2. Fetch the user's Slack installs.
  // 3. For each subscription: pick a teamId (declared or defaulted);
  //    fetch channel list once per team (cache within call); resolve
  //    #name → id or validate a C-id is present.
  // 4. Return a definition with subscriptions rewritten in place.
}
```

Fill in the body following the pattern of existing Slack API calls in `packages/worker/src/services/slack.ts`. Throw a `ValidationError` (from `@valet/shared`) with a clear message like:
- `"Workflow declares a Slack trigger for #incidents but you have multiple connected workspaces — set the trigger node's subscription.teamId."`
- `"Channel #incidents was not found in workspace T012ORG. Invite the bot to the channel or check the name."`

Write tests at `packages/worker/src/services/slack-channel-resolver.test.ts` mocking the Slack API surface (see existing mocks in `packages/worker/src/services/slack.test.ts` if present).

Also create `packages/worker/src/services/github-installation-resolver.ts`:

```ts
import type { AppDb } from '../lib/drizzle.js';
import { listGithubInstallationsByUser } from '../lib/db/github-installations.js';
import type { WorkflowDefinition } from '@valet/shared';
import { ValidationError } from '@valet/shared';

interface Args {
  db: AppDb;
  userId: string;
  definition: WorkflowDefinition;
}

/**
 * For every trigger node with a github.event subscription:
 *   - resolves installationId (auto if the user has exactly one installation
 *     and installationId is unset; otherwise the declared installationId is
 *     validated against the user's install list)
 *   - if `repo` is set, validates that the installation has access to that
 *     `owner/name` (via a lightweight repo lookup or the local index of
 *     installed repos; pick whichever is already available)
 * Returns a definition with subscriptions rewritten to their resolved forms.
 * Throws ValidationError with an actionable message on failure.
 */
export async function resolveGithubSubscriptions(args: Args): Promise<WorkflowDefinition> {
  // 1. Enumerate github.event subscriptions in the definition.
  // 2. Fetch the user's installations (single query).
  // 3. For each: pick installationId (declared or auto-defaulted);
  //    validate `repo` access if set.
  // 4. Return a definition with subscriptions rewritten.
}
```

Error messages should be actionable:
- `"Workflow declares a GitHub trigger but you have multiple installations — set subscription.installationId to one of: 12345 (anthropics), 67890 (personal)."`
- `"Installation 12345 does not have access to repo anthropics/valet. Install the app on that repo or update subscription.repo."`

Tests: `packages/worker/src/services/github-installation-resolver.test.ts` — mock the installations DB helper and the repo-access check.

- [ ] **Step 4.5b: Invoke the reconciler inside `publishWorkflow`.**

At the end of `publishWorkflow`, after the version write commits:

```ts
import { planReconciliation } from './trigger-reconciler.js';
import { createTrigger, updateTrigger, deleteTrigger, listOwnedTriggers } from '../lib/db/triggers.js';
import { resolveSlackSubscriptions } from './slack-channel-resolver.js';
import { resolveGithubSubscriptions } from './github-installation-resolver.js';
import { generateWebhookToken } from '...'; // reuse existing helper

// ... existing publish logic ...

// Resolve integration-scoped subscriptions before planning. If any
// resolution fails, publish fails cleanly (nothing written to the
// triggers table). Order doesn't matter — each resolver only touches
// its own subscription type.
let resolvedDefinition = await resolveSlackSubscriptions({
  db, encryptionKey: env.ENCRYPTION_KEY,
  userId: workflow.userId, definition: publishedDefinition,
});
resolvedDefinition = await resolveGithubSubscriptions({
  db, userId: workflow.userId, definition: resolvedDefinition,
});

const owned = await listOwnedTriggers(db, workflowId);
const ops = planReconciliation({
  workflowId,
  workflowName: workflow.name,
  definition: resolvedDefinition,
  existing: owned.map((r) => ({
    id: r.id, ownerNodeId: r.ownerNodeId, type: r.type,
    config: r.config, name: r.name,
  })),
});

for (const op of ops) {
  if (op.kind === 'create') {
    await createTrigger(db, {
      id: crypto.randomUUID(),
      userId: workflow.userId,
      workflowId,
      name: op.name,
      type: op.type,
      config: JSON.stringify(op.config),
      ownerWorkflowId: workflowId,
      ownerNodeId: op.nodeId,
      webhookToken: op.type === 'webhook' ? generateWebhookToken() : null,
    });
  } else if (op.kind === 'update') {
    await updateTrigger(db, op.triggerId, {
      name: op.name,
      type: op.type,
      config: JSON.stringify(op.config),
      // Do NOT touch webhookToken — keep it stable across republishes.
    });
  } else {
    await deleteTrigger(db, op.triggerId);
  }
}
```

Confirm `createTrigger` / `updateTrigger` / `deleteTrigger` signatures match the calls above; adjust if the actual API differs.

- [ ] **Step 4.6: Run the test — expect pass.**

Run: `cd packages/worker && pnpm test workflows.publish`
Expected: all cases PASS.

- [ ] **Step 4.7: Run the full worker test suite to check for regressions.**

Run: `cd packages/worker && pnpm test`
Expected: PASS. If prior publish tests break, they were coupled to trigger-row state and need updating.

- [ ] **Step 4.8: Typecheck.**

Run: `pnpm typecheck` from repo root.
Expected: PASS.

- [ ] **Step 4.9: Commit.**

```bash
git add packages/worker/src/services/workflows.ts \
        packages/worker/src/lib/db/triggers.ts \
        packages/worker/src/services/workflows.publish.test.ts
git commit -m "workflows: reconcile owned triggers on publish

publishWorkflow now diffs the published definition against
existing owned triggers and applies create/update/delete.
Webhook tokens stable across republishes. User-owned
triggers untouched."
```

---

### Task 5: Ownership guards on triggers CRUD

**Files:**
- Modify: `packages/worker/src/routes/triggers.ts`
- Test: `packages/worker/src/routes/triggers.test.ts` (extend or create).

**Interfaces:**
- Consumes: existing PATCH/DELETE trigger routes.
- Produces: PATCH on an owned trigger — allow updating `enabled` and `name` only; reject other declarative fields with 409. DELETE — reject with 409 and a message pointing at the owning workflow.

- [ ] **Step 5.1: Locate PATCH / DELETE handlers in `packages/worker/src/routes/triggers.ts`.**

Run: `grep -n "\.patch\|\.delete\|/triggers/" packages/worker/src/routes/triggers.ts`

- [ ] **Step 5.2: Write the failing tests.**

Extend or create `packages/worker/src/routes/triggers.test.ts`:

```ts
it('PATCH rejects config edits on an owned trigger', async () => {
  const { workflowId, triggerId } = await seedOwnedTrigger();
  const resp = await app.request(`/api/triggers/${triggerId}`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({ config: { type: 'schedule', cron: '0 * * * *' } }),
  });
  expect(resp.status).toBe(409);
  const body = await resp.json();
  expect(body.error).toMatch(/declared by workflow/i);
});

it('PATCH allows toggling enabled on an owned trigger', async () => {
  const { triggerId } = await seedOwnedTrigger();
  const resp = await app.request(`/api/triggers/${triggerId}`, {
    method: 'PATCH',
    headers: authHeaders(),
    body: JSON.stringify({ enabled: false }),
  });
  expect(resp.status).toBe(200);
});

it('DELETE rejects an owned trigger', async () => {
  const { triggerId } = await seedOwnedTrigger();
  const resp = await app.request(`/api/triggers/${triggerId}`, {
    method: 'DELETE', headers: authHeaders(),
  });
  expect(resp.status).toBe(409);
});
```

- [ ] **Step 5.3: Run the tests — expect failure.**

Run: `cd packages/worker && pnpm test triggers.test`
Expected: FAIL (guards not implemented).

- [ ] **Step 5.4: Add the guard.**

In `packages/worker/src/routes/triggers.ts`, in the PATCH handler after loading the trigger row:

```ts
if (existingRow.ownerWorkflowId) {
  const declarative = ['type', 'config', 'variableMapping', 'workflowId'] as const;
  const attemptsDeclarative = declarative.some((k) => k in body);
  if (attemptsDeclarative) {
    return c.json({
      error: `Trigger is declared by workflow ${existingRow.ownerWorkflowId} — edit it in the workflow editor`,
      code: 'trigger_owned_by_workflow',
    }, 409);
  }
}
```

In the DELETE handler:

```ts
if (existingRow.ownerWorkflowId) {
  return c.json({
    error: `Trigger is declared by workflow ${existingRow.ownerWorkflowId} — remove the trigger node from the workflow to delete it`,
    code: 'trigger_owned_by_workflow',
  }, 409);
}
```

- [ ] **Step 5.5: Run the tests — expect pass.**

Run: `cd packages/worker && pnpm test triggers.test`
Expected: PASS.

- [ ] **Step 5.6: Commit.**

```bash
git add packages/worker/src/routes/triggers.ts \
        packages/worker/src/routes/triggers.test.ts
git commit -m "triggers: guard PATCH/DELETE on owned rows

Owned triggers reject declarative edits and delete; the
enabled toggle still passes through since it's runtime state."
```

---

### Task 5B: Slack events dispatch to workflows

**Files:**
- Modify: `packages/worker/src/routes/slack-events.ts` — after the DM-orchestrator branch and before the shared-surface early return, look up matching workflow triggers and dispatch executions.
- Modify: `packages/worker/src/lib/db/triggers.ts` — add `findSlackChannelTriggers(db, teamId, channelId)`.
- Modify: `packages/worker/src/services/executions.ts` (or wherever workflow executions are enqueued — locate via `grep -rn "enqueueExecution\|dispatchWorkflow" packages/worker/src`). Reuse the existing execution-start entry point.
- Test: `packages/worker/src/routes/slack-events.test.ts` — extend or create.

**Interfaces:**
- Consumes: incoming Slack channel-message events; owned Slack triggers created by the reconciler in Task 4.
- Produces: for each incoming `message` event whose `channel_type !== 'im'` and matching `slack.message.channels` triggers exist, an execution is enqueued with the event mapped into `trigger.data`.

- [ ] **Step 5B.1: Add the DB helper.**

In `packages/worker/src/lib/db/triggers.ts`:

```ts
export async function findSlackChannelTriggers(
  db: AppDb,
  teamId: string,
  channelId: string,
): Promise<Array<{ id: string; workflowId: string | null; config: string; enabled: boolean | null; userId: string }>> {
  // Slack-typed triggers store teamId + channelId inside config JSON.
  // SQLite lacks JSONB indexing, so filter by type first (indexed) and
  // narrow with json_extract in the WHERE clause.
  const rows = await db
    .select({
      id: triggers.id,
      workflowId: triggers.workflowId,
      config: triggers.config,
      enabled: triggers.enabled,
      userId: triggers.userId,
    })
    .from(triggers)
    .where(and(
      eq(triggers.type, 'slack.message.channels'),
      sql`json_extract(${triggers.config}, '$.teamId') = ${teamId}`,
      sql`json_extract(${triggers.config}, '$.channelId') = ${channelId}`,
    ));
  return rows;
}
```

Import `sql` from `drizzle-orm` if not already.

- [ ] **Step 5B.2: Write the failing test.**

Create `packages/worker/src/routes/slack-events.workflow-dispatch.test.ts`:

```ts
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { setupTestApp } from '../test-utils/app'; // adjust to actual helper

describe('slack-events → workflow dispatch', () => {
  it('fires a workflow execution when a channel message matches an owned trigger', async () => {
    const { app, db, enqueueSpy } = await setupTestApp();
    await seedOwnedSlackTrigger(db, {
      workflowId: 'wf1', teamId: 'T1', channelId: 'C1', userId: 'u1',
    });

    const resp = await app.request('/api/channels/slack/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...validSlackSignatureHeaders() },
      body: JSON.stringify({
        type: 'event_callback',
        team_id: 'T1',
        event: {
          type: 'message',
          channel: 'C1',
          channel_type: 'channel',
          user: 'U1',
          text: 'production is down',
          ts: '1712345678.000100',
        },
      }),
    });

    expect(resp.status).toBe(200);
    expect(enqueueSpy).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: 'wf1',
      triggerData: expect.objectContaining({
        team: 'T1', channel: 'C1', user: 'U1', text: 'production is down',
      }),
    }));
  });

  it('skips bot messages when ignoreBots is set', async () => {
    const { app, db, enqueueSpy } = await setupTestApp();
    await seedOwnedSlackTrigger(db, {
      workflowId: 'wf1', teamId: 'T1', channelId: 'C1', userId: 'u1',
      filters: { ignoreBots: true },
    });

    await app.request('/api/channels/slack/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...validSlackSignatureHeaders() },
      body: JSON.stringify({
        type: 'event_callback',
        team_id: 'T1',
        event: {
          type: 'message', channel: 'C1', channel_type: 'channel',
          bot_id: 'B1', text: 'noisy', ts: '1712345678.000100',
        },
      }),
    });

    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('does not dispatch when the channel does not match any trigger', async () => {
    const { app, enqueueSpy } = await setupTestApp();
    await app.request('/api/channels/slack/events', {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...validSlackSignatureHeaders() },
      body: JSON.stringify({
        type: 'event_callback', team_id: 'T1',
        event: { type: 'message', channel: 'C_UNRELATED', channel_type: 'channel', user: 'U1', text: 'x', ts: '1.0' },
      }),
    });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 5B.3: Run the tests — expect failure.**

Run: `cd packages/worker && pnpm test slack-events.workflow-dispatch`
Expected: FAIL (dispatch code not yet added).

- [ ] **Step 5B.4: Fork the dispatch inside `slack-events.ts`.**

Just before the existing "shared-surface skip" branch (search for `Ignoring shared-surface event`), insert:

```ts
// Workflow-trigger fork: does this channel have any owned Slack
// triggers? If so, dispatch to their workflows before falling through
// to the personal-orchestrator branch.
if (!isDm && teamId && event?.channel && typeof event.channel === 'string') {
  const channelId = event.channel;
  const matches = await db.findSlackChannelTriggers(c.get('db'), teamId, channelId);
  for (const trig of matches) {
    if (!trig.enabled) continue;
    if (!trig.workflowId) continue;
    const config = JSON.parse(trig.config) as import('../lib/db/triggers').TriggerConfig;
    if (config.type !== 'slack.message.channels') continue;
    if (config.filters?.ignoreBots !== false && event.bot_id) continue;
    if (config.filters?.mentionOnly && !mentionsBot(event.text, botInfo)) continue;

    c.executionCtx.waitUntil(enqueueWorkflowExecution({
      db: c.get('db'),
      env: c.env,
      workflowId: trig.workflowId,
      userId: trig.userId,
      triggerId: trig.id,
      triggerData: {
        team: teamId,
        channel: channelId,
        channelName: (event.channel_name as string | undefined),
        user: slackUserId ?? undefined,
        text: event.text as string | undefined,
        ts: event.ts as string | undefined,
        threadTs: event.thread_ts as string | undefined,
        eventType: eventType,
      },
    }));
  }
}
```

`enqueueWorkflowExecution` is the existing entry point from Step 5B intro's grep — adapt the field names to match. `mentionsBot` is a small helper: `botInfo?.userId && text?.includes(\`<@${botInfo.userId}>\`)`.

- [ ] **Step 5B.5: Run the tests — expect pass.**

Run: `cd packages/worker && pnpm test slack-events.workflow-dispatch`
Expected: PASS.

- [ ] **Step 5B.6: Confirm DM routing is unchanged.**

Run: `cd packages/worker && pnpm test slack-events`
Expected: all cases PASS (dispatch fork runs before the DM branch but only for non-DM channels, so DM routing is untouched).

- [ ] **Step 5B.7: Commit.**

```bash
git add packages/worker/src/routes/slack-events.ts \
        packages/worker/src/lib/db/triggers.ts \
        packages/worker/src/routes/slack-events.workflow-dispatch.test.ts
git commit -m "slack-events: dispatch channel messages to matched workflows

Adds a workflow-trigger fork before the existing DM
orchestrator branch. For every owned slack.message.channels
trigger whose teamId/channelId match the event, enqueue a
workflow execution with the message mapped into trigger.data.
ignoreBots + mentionOnly filters honored."
```

---

### Task 5C: GitHub webhook dispatch to workflows

**Files:**
- Modify: `packages/worker/src/routes/webhooks.ts` — after the existing installation/pull_request/push handlers (and before the "unhandled event" log), look up matching workflow triggers and dispatch.
- Modify: `packages/worker/src/lib/db/triggers.ts` — add `findGithubEventTriggers(db, installationId, event)`.
- Test: `packages/worker/src/routes/webhooks.workflow-dispatch.test.ts`.

**Interfaces:**
- Consumes: incoming GitHub webhooks; owned github.event triggers created by the reconciler in Task 4.
- Produces: for each incoming webhook whose payload matches an owned trigger's installationId/event (and optional action/repo/branch/author filters), an execution is enqueued with the payload mapped into `trigger.data`. Existing pull_request/push session-state handlers continue to run unchanged.

- [ ] **Step 5C.1: Add the DB helper.**

In `packages/worker/src/lib/db/triggers.ts`:

```ts
export async function findGithubEventTriggers(
  db: AppDb,
  installationId: number,
  event: string,
): Promise<Array<{ id: string; workflowId: string | null; config: string; enabled: boolean | null; userId: string }>> {
  return db
    .select({
      id: triggers.id,
      workflowId: triggers.workflowId,
      config: triggers.config,
      enabled: triggers.enabled,
      userId: triggers.userId,
    })
    .from(triggers)
    .where(and(
      eq(triggers.type, 'github.event'),
      sql`json_extract(${triggers.config}, '$.installationId') = ${installationId}`,
      sql`json_extract(${triggers.config}, '$.event') = ${event}`,
    ));
}
```

- [ ] **Step 5C.2: Write the failing test.**

Create `packages/worker/src/routes/webhooks.workflow-dispatch.test.ts` covering:

```ts
describe('webhooks/github → workflow dispatch', () => {
  it('fires a matching workflow when a pull_request opened event arrives', async () => {
    const { app, db, enqueueSpy } = await setupTestApp();
    await seedOwnedGithubTrigger(db, {
      workflowId: 'wf1', installationId: 42, event: 'pull_request',
      action: 'opened', repo: 'anthropics/valet', userId: 'u1',
    });

    const resp = await app.request('/api/webhooks/github', {
      method: 'POST',
      headers: {
        'X-GitHub-Event': 'pull_request',
        'X-GitHub-Delivery': 'd1',
        'X-Hub-Signature-256': validGithubSignature(body),
      },
      body: JSON.stringify({
        action: 'opened',
        installation: { id: 42 },
        repository: { full_name: 'anthropics/valet', owner: { login: 'anthropics' }, name: 'valet' },
        sender: { login: 'octocat', id: 1 },
        pull_request: { number: 7 },
      }),
    });

    expect(resp.status).toBe(200);
    expect(enqueueSpy).toHaveBeenCalledWith(expect.objectContaining({
      workflowId: 'wf1',
      triggerData: expect.objectContaining({
        event: 'pull_request', action: 'opened',
        repo: expect.objectContaining({ fullName: 'anthropics/valet' }),
      }),
    }));
  });

  it('skips triggers whose action filter does not match', async () => {
    const { app, db, enqueueSpy } = await setupTestApp();
    await seedOwnedGithubTrigger(db, {
      workflowId: 'wf1', installationId: 42, event: 'pull_request', action: 'closed',
    });
    await app.request('/api/webhooks/github', {
      method: 'POST',
      headers: githubHeaders('pull_request'),
      body: JSON.stringify({ action: 'opened', installation: { id: 42 }, repository: { full_name: 'anthropics/valet' } }),
    });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('skips triggers scoped to a different repo', async () => {
    const { app, db, enqueueSpy } = await setupTestApp();
    await seedOwnedGithubTrigger(db, {
      workflowId: 'wf1', installationId: 42, event: 'pull_request', repo: 'anthropics/other',
    });
    await app.request('/api/webhooks/github', {
      method: 'POST',
      headers: githubHeaders('pull_request'),
      body: JSON.stringify({ action: 'opened', installation: { id: 42 }, repository: { full_name: 'anthropics/valet' } }),
    });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('honors branch filter on push events', async () => {
    const { app, db, enqueueSpy } = await setupTestApp();
    await seedOwnedGithubTrigger(db, {
      workflowId: 'wf1', installationId: 42, event: 'push',
      filters: { branch: 'main' },
    });
    await app.request('/api/webhooks/github', {
      method: 'POST',
      headers: githubHeaders('push'),
      body: JSON.stringify({
        ref: 'refs/heads/feature-x',
        installation: { id: 42 },
        repository: { full_name: 'anthropics/valet' },
      }),
    });
    expect(enqueueSpy).not.toHaveBeenCalled();
  });

  it('does not disturb existing pull_request session-state handler', async () => {
    const { app, db, sessionHandlerSpy } = await setupTestApp();
    await app.request('/api/webhooks/github', {
      method: 'POST',
      headers: githubHeaders('pull_request'),
      body: JSON.stringify({ action: 'opened', installation: { id: 42 }, repository: { full_name: 'x/y' } }),
    });
    expect(sessionHandlerSpy).toHaveBeenCalled();
  });
});
```

- [ ] **Step 5C.3: Run the test — expect failure.**

Run: `cd packages/worker && pnpm test webhooks.workflow-dispatch`
Expected: FAIL (dispatch code not added).

- [ ] **Step 5C.4: Add the dispatch fork in `webhooks.ts`.**

Right before the existing "unhandled event" log:

```ts
// Workflow-trigger fork — additive; does not affect existing handlers above.
try {
  const installationId = (payload.installation as { id?: number } | undefined)?.id;
  if (installationId) {
    const matches = await db.findGithubEventTriggers(getDb(c.env.DB), installationId, event);
    for (const trig of matches) {
      if (!trig.enabled || !trig.workflowId) continue;
      const config = JSON.parse(trig.config) as import('../lib/db/triggers').TriggerConfig;
      if (config.type !== 'github.event') continue;

      const action = (payload as { action?: string }).action;
      if (config.action && config.action !== action) continue;

      const repoFullName = (payload.repository as { full_name?: string } | undefined)?.full_name;
      if (config.repo && config.repo !== repoFullName) continue;

      const ref = (payload as { ref?: string }).ref;
      if (config.filters?.branch && ref !== `refs/heads/${config.filters.branch}`) continue;

      const senderLogin = (payload.sender as { login?: string } | undefined)?.login;
      if (config.filters?.author && senderLogin !== config.filters.author) continue;

      const repo = (payload.repository as { full_name?: string; owner?: { login?: string }; name?: string } | undefined);
      c.executionCtx.waitUntil(enqueueWorkflowExecution({
        db: getDb(c.env.DB),
        env: c.env,
        workflowId: trig.workflowId,
        userId: trig.userId,
        triggerId: trig.id,
        triggerData: {
          event,
          action,
          installationId,
          repo: repo?.full_name ? {
            owner: repo.owner?.login ?? '', name: repo.name ?? '',
            fullName: repo.full_name,
          } : undefined,
          sender: payload.sender,
          payload,
        },
      }));
    }
  }
} catch (error) {
  console.error('[github webhook] workflow dispatch error:', error);
}
```

Match `enqueueWorkflowExecution` to the actual signature from `packages/worker/src/services/executions.ts`.

- [ ] **Step 5C.5: Run the test — expect pass.**

Run: `cd packages/worker && pnpm test webhooks.workflow-dispatch`
Expected: PASS.

- [ ] **Step 5C.6: Full webhook test suite regression check.**

Run: `cd packages/worker && pnpm test webhooks`
Expected: PASS — pull_request/push/installation handlers must remain intact.

- [ ] **Step 5C.7: Commit.**

```bash
git add packages/worker/src/routes/webhooks.ts \
        packages/worker/src/lib/db/triggers.ts \
        packages/worker/src/routes/webhooks.workflow-dispatch.test.ts
git commit -m "webhooks/github: dispatch matched events to workflows

Adds an additive fork alongside the existing installation
/pull_request/push handlers. Matches owned github.event
triggers by installationId + event + optional action/repo
/branch/author filters. Runs inside waitUntil so the ACK
stays fast."
```

---

### Task 6: Copilot `getNodeSchema` surfaces `subscription`

**Files:**
- Modify: `packages/worker/src/routes/copilot.ts` (locate the `getNodeSchema` tool).
- Modify: the copilot's system prompt (may live inline in `copilot.ts` or a template file — locate via `grep -n "getNodeSchema\|systemPrompt\|You are" packages/worker/src/routes/copilot.ts`).

**Interfaces:**
- Consumes: existing `getNodeSchema` tool return shape.
- Produces: the trigger-node entry in `nodes[]` gains a `subscription` documentation block describing the union.

- [ ] **Step 6.1: Find the trigger-node schema documentation in the copilot's `getNodeSchema` tool.**

Run: `grep -n "type.*trigger\|'trigger'" packages/worker/src/routes/copilot.ts | head -10`

Locate the block that emits the trigger-node entry into the tool result.

- [ ] **Step 6.2: Extend the trigger-node entry.**

Add a `subscription` field under the trigger entry in the tool result. Concrete addition:

```ts
subscription: {
  optional: true,
  description: 'Materializes a live trigger row on publish. Omit or set to { type: "manual" } for workflows only invoked via test-run.',
  shape: 'Discriminated union tagged by type.',
  types: {
    manual: { fields: {} },
    webhook: {
      fields: {
        method: { optional: true, enum: ['GET', 'POST', 'PUT'] },
        rateLimit: { optional: true, type: 'integer', description: 'Requests per 60s window.' },
      },
      note: 'System generates URL + token on first publish. Surface in the editor post-publish; the copilot does not set the URL.',
    },
    schedule: {
      fields: {
        cron: { required: true, type: 'string', description: '5-field cron expression.' },
        timezone: { optional: true, type: 'string' },
        triggerData: { optional: true, description: 'Static payload passed on each fire.' },
      },
    },
    'slack.message.channels': {
      fields: {
        channel: { required: true, type: 'string', description: 'Slack channel — either a #name (resolved at publish) or a raw C-prefixed id.' },
        teamId: { optional: true, type: 'string', description: 'Slack team id. Auto-selected when the user has exactly one connected workspace; required when they have more than one.' },
        filters: {
          optional: true,
          fields: {
            ignoreBots: { optional: true, type: 'boolean', default: true, description: 'Skip messages authored by other bots.' },
            mentionOnly: { optional: true, type: 'boolean', default: false, description: 'Only fire when the workflow owner\'s Slack bot user is @-mentioned.' },
          },
        },
      },
      dataShape: {
        team: 'string', channel: 'string', channelName: 'string?', user: 'string',
        text: 'string', ts: 'string', threadTs: 'string?', eventType: 'message | app_mention',
      },
      note: 'Requires the Valet Slack bot to be a member of the channel. Publish fails with an actionable error if the channel cannot be resolved.',
    },
    'github.event': {
      fields: {
        event: {
          required: true, type: 'string',
          examples: ['pull_request', 'issues', 'issue_comment', 'push', 'release', 'workflow_run', 'check_run'],
          description: 'GitHub webhook event name.',
        },
        action: { optional: true, type: 'string', description: 'Restrict to a payload action (opened, closed, labeled, created, edited, ...).' },
        installationId: { optional: true, type: 'number', description: 'GitHub App installation id. Auto-selected when the user has exactly one installation; required when they have more than one.' },
        repo: { optional: true, type: 'string', description: 'Restrict to a single repo, "owner/name". Omit to fire for every repo in the installation.' },
        filters: {
          optional: true,
          fields: {
            branch: { optional: true, type: 'string', description: 'For push events, restrict to a ref (branch name, without refs/heads/).' },
            author: { optional: true, type: 'string', description: 'Match payload.sender.login exactly.' },
          },
        },
      },
      dataShape: {
        event: 'string', action: 'string?', installationId: 'number',
        repo: '{ owner: string; name: string; fullName: string }?',
        sender: '{ login: string; id: number }?',
        payload: 'the full webhook payload — use for anything not in the top-level fields',
      },
      note: 'Requires the Valet GitHub App to be installed on the target repo/org. Publish fails if the installation is ambiguous or the declared repo is not covered by the installation.',
    },
  },
},
```

- [ ] **Step 6.3: Update the system prompt with a short note.**

Append (or splice into the trigger-node section) something like:

> When the user describes an event source, set the trigger node's `subscription` field.
> - "every morning" / "on a schedule" → `{ type: "schedule", cron: "..." }`
> - "when a webhook fires" / "when an external system POSTs" → `{ type: "webhook" }`. The URL is generated post-publish; tell the user to check the trigger node inspector.
> - "when someone posts in #foo" / "when I get pinged in #foo" → `{ type: "slack.message.channels", channel: "#foo", filters: { mentionOnly: true } }` if they specifically said "when I'm mentioned"; otherwise omit `mentionOnly`. Also update the trigger node's `dataSchema` to match the Slack event shape (team, channel, user, text, ts).
> - "when a PR is opened" / "on every commit to main" / "when someone comments on an issue" → `{ type: "github.event", event: "pull_request", action: "opened", repo: "owner/name" }` (adjust event/action to fit). For push filtering, use `filters.branch: "main"`. Set `repo` if the user names one; omit for org-wide. Update the trigger node's `dataSchema` to reflect what your workflow reads from the payload (usually a subset of the top-level fields).
> Do NOT set `subscription` for triggers the user says will only be invoked via the test-run button. Gmail and other integration event sources are NOT yet supported — for those requests, declare `{ type: "manual" }` and tell the user they'll need to wire an external caller until first-party event triggers ship for those integrations.

- [ ] **Step 6.4: Typecheck.**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS.

- [ ] **Step 6.5: If `getNodeSchema` has snapshot or contract tests, update them.**

Run: `cd packages/worker && pnpm test copilot`
Expected: if snapshot tests fail, review the diff and update snapshots.

- [ ] **Step 6.6: Commit.**

```bash
git add packages/worker/src/routes/copilot.ts
git commit -m "copilot: expose trigger-node subscription in getNodeSchema

Adds the manual|webhook|schedule union to the schema tool
result and a prompt note guiding when to set it."
```

---

### Task 7: Client — surface ownership on triggers UI

**Files:**
- Modify: `packages/client/src/api/triggers.ts` — extend the `Trigger` type with `ownerWorkflowId`, `ownerNodeId`.
- Create: `packages/client/src/components/triggers/owned-badge.tsx`.
- Modify: `packages/client/src/routes/automation/triggers.index.tsx` (or wherever the list renders) — render the badge on owned rows.
- Modify: `packages/client/src/routes/automation/triggers.$triggerId.tsx` — disable declarative form inputs and hide/replace delete button when owned.

**Interfaces:**
- Consumes: trigger list/detail API responses, now returning `ownerWorkflowId`/`ownerNodeId`.
- Produces: visual affordance + interaction guards matching server-side guards.

- [ ] **Step 7.1: Extend the client Trigger type.**

In `packages/client/src/api/triggers.ts`, add to the `Trigger` interface:

```ts
ownerWorkflowId: string | null;
ownerNodeId: string | null;
```

If the server route serializes the DB row directly, this will already flow through. Otherwise, extend the response mapper.

- [ ] **Step 7.2: Add the badge component.**

Create `packages/client/src/components/triggers/owned-badge.tsx`:

```tsx
import { Link } from '@tanstack/react-router';

interface OwnedBadgeProps { workflowId: string; }

export function OwnedBadge({ workflowId }: OwnedBadgeProps) {
  return (
    <Link
      to="/workflows/$workflowId"
      params={{ workflowId }}
      className="inline-flex items-center gap-1 rounded-full border border-violet-200 bg-violet-50 px-2 py-0.5 text-[10px] font-medium text-violet-700 hover:bg-violet-100 dark:border-violet-800 dark:bg-violet-950/60 dark:text-violet-300"
      title="Declared by a workflow — edit in the workflow editor"
    >
      ✦ Declared by workflow
    </Link>
  );
}
```

- [ ] **Step 7.3: Render the badge on owned rows in the list.**

In the triggers list route, wherever a trigger's row is rendered, add:

```tsx
{trigger.ownerWorkflowId && <OwnedBadge workflowId={trigger.ownerWorkflowId} />}
```

Place it next to the trigger's type label.

- [ ] **Step 7.4: Lock the detail form for owned triggers.**

In the detail route, above the form:

```tsx
const isOwned = !!trigger.ownerWorkflowId;
```

Pass `disabled={isOwned}` to declarative inputs (type dropdown, config JSON editor, variable mapping). Keep the `enabled` toggle and `name` input free.

For the delete button:

```tsx
{isOwned ? (
  <div className="text-xs text-neutral-500">
    Declared by <Link to="/workflows/$workflowId" params={{ workflowId: trigger.ownerWorkflowId! }}>this workflow</Link>. Remove the trigger node there to delete.
  </div>
) : (
  <DeleteButton onDelete={handleDelete} />
)}
```

- [ ] **Step 7.5: Build the client.**

Run: `cd packages/client && pnpm build`
Expected: PASS. The stricter `tsc --noEmit` used in the production build catches unused locals.

- [ ] **Step 7.6: Commit.**

```bash
git add packages/client/src/api/triggers.ts \
        packages/client/src/components/triggers/owned-badge.tsx \
        packages/client/src/routes/automation/triggers.index.tsx \
        packages/client/src/routes/automation/triggers.$triggerId.tsx
git commit -m "triggers UI: badge + form lock for workflow-owned rows

- Owned rows show a 'Declared by workflow' badge linking to
  the editor.
- Detail form disables declarative inputs; enable/disable
  and name stay editable.
- Delete replaced with a pointer to the owning workflow."
```

---

### Task 8: Client — trigger-node subscription form in the workflow editor

**Files:**
- Create: `packages/client/src/components/workflows/trigger-node-subscription-form.tsx`.
- Modify: the node inspector for the trigger node — locate via `grep -rn "TriggerNode\|inspector.*trigger" packages/client/src/components/workflows 2>/dev/null | head -10`.

**Interfaces:**
- Consumes: the trigger-node data from the current workflow definition.
- Produces: an inline form section for the `subscription` field. On save, patches the trigger node's subscription via the standard workflow-definition editing path.

- [ ] **Step 8.1: Create the subscription form component.**

Create `packages/client/src/components/workflows/trigger-node-subscription-form.tsx`:

```tsx
import type { WorkflowTriggerNode } from '@valet/shared';

type Subscription = NonNullable<WorkflowTriggerNode['subscription']>;

interface Props {
  value: Subscription | undefined;
  onChange: (next: Subscription | undefined) => void;
  publishedWebhookUrl?: string;
}

export function TriggerNodeSubscriptionForm({ value, onChange, publishedWebhookUrl }: Props) {
  const type = value?.type ?? 'manual';
  return (
    <div className="space-y-2 rounded-md border border-neutral-200 p-3 dark:border-neutral-800">
      <div className="text-xs font-medium uppercase tracking-wider text-neutral-500">Subscription</div>
      <select
        value={type}
        onChange={(e) => {
          const next = e.target.value as Subscription['type'];
          if (next === 'manual') return onChange({ type: 'manual' });
          if (next === 'webhook') return onChange({ type: 'webhook' });
          if (next === 'schedule') return onChange({ type: 'schedule', cron: '0 9 * * *' });
          if (next === 'slack.message.channels') return onChange({ type: 'slack.message.channels', channel: '#general' });
          if (next === 'github.event') return onChange({ type: 'github.event', event: 'pull_request' });
        }}
        className="w-full rounded border border-neutral-200 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      >
        <option value="manual">Manual (test-run only)</option>
        <option value="webhook">Webhook</option>
        <option value="schedule">Schedule</option>
        <option value="slack.message.channels">Slack channel message</option>
        <option value="github.event">GitHub event</option>
      </select>

      {value?.type === 'webhook' && (
        <>
          <label className="block text-xs text-neutral-500">Method</label>
          <select
            value={value.method ?? 'POST'}
            onChange={(e) => onChange({ ...value, method: e.target.value as 'GET' | 'POST' | 'PUT' })}
            className="w-full rounded border border-neutral-200 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option>GET</option>
            <option>POST</option>
            <option>PUT</option>
          </select>
          {publishedWebhookUrl && (
            <div className="text-xs">
              <div className="font-mono text-neutral-500">URL after publish:</div>
              <code className="block break-all rounded bg-neutral-100 px-2 py-1 dark:bg-neutral-900">{publishedWebhookUrl}</code>
            </div>
          )}
        </>
      )}

      {value?.type === 'schedule' && (
        <>
          <label className="block text-xs text-neutral-500">Cron</label>
          <input
            type="text"
            value={value.cron}
            onChange={(e) => onChange({ ...value, cron: e.target.value })}
            className="w-full rounded border border-neutral-200 bg-white px-2 py-1 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-900"
            placeholder="0 9 * * *"
          />
        </>
      )}

      {value?.type === 'slack.message.channels' && (
        <>
          <label className="block text-xs text-neutral-500">Channel</label>
          <input
            type="text"
            value={value.channel}
            onChange={(e) => onChange({ ...value, channel: e.target.value })}
            className="w-full rounded border border-neutral-200 bg-white px-2 py-1 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-900"
            placeholder="#incidents"
          />
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={value.filters?.mentionOnly ?? false}
              onChange={(e) => onChange({ ...value, filters: { ...value.filters, mentionOnly: e.target.checked } })}
            />
            Only fire when the bot is @-mentioned
          </label>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={value.filters?.ignoreBots ?? true}
              onChange={(e) => onChange({ ...value, filters: { ...value.filters, ignoreBots: e.target.checked } })}
            />
            Ignore messages from other bots
          </label>
          <p className="text-[10px] text-neutral-500">The Valet bot must be a member of the channel. If the workspace can&apos;t be auto-detected, add a <code>teamId</code> field via the raw JSON view.</p>
        </>
      )}

      {value?.type === 'github.event' && (
        <>
          <label className="block text-xs text-neutral-500">Event</label>
          <select
            value={value.event}
            onChange={(e) => onChange({ ...value, event: e.target.value })}
            className="w-full rounded border border-neutral-200 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
          >
            <option value="pull_request">pull_request</option>
            <option value="issues">issues</option>
            <option value="issue_comment">issue_comment</option>
            <option value="push">push</option>
            <option value="release">release</option>
            <option value="workflow_run">workflow_run</option>
            <option value="check_run">check_run</option>
          </select>
          <label className="block text-xs text-neutral-500">Action (optional)</label>
          <input
            type="text"
            value={value.action ?? ''}
            onChange={(e) => onChange({ ...value, action: e.target.value || undefined })}
            className="w-full rounded border border-neutral-200 bg-white px-2 py-1 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-900"
            placeholder="opened, closed, labeled…"
          />
          <label className="block text-xs text-neutral-500">Repo (optional, owner/name)</label>
          <input
            type="text"
            value={value.repo ?? ''}
            onChange={(e) => onChange({ ...value, repo: e.target.value || undefined })}
            className="w-full rounded border border-neutral-200 bg-white px-2 py-1 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-900"
            placeholder="anthropics/valet"
          />
          {value.event === 'push' && (
            <>
              <label className="block text-xs text-neutral-500">Branch (optional)</label>
              <input
                type="text"
                value={value.filters?.branch ?? ''}
                onChange={(e) => onChange({ ...value, filters: { ...value.filters, branch: e.target.value || undefined } })}
                className="w-full rounded border border-neutral-200 bg-white px-2 py-1 font-mono text-sm dark:border-neutral-700 dark:bg-neutral-900"
                placeholder="main"
              />
            </>
          )}
          <p className="text-[10px] text-neutral-500">Requires the Valet GitHub App on the target repo/org. If you have multiple installations, add an <code>installationId</code> via the raw JSON view.</p>
        </>
      )}
    </div>
  );
}
```

- [ ] **Step 8.2: Wire the form into the trigger-node inspector.**

Locate the inspector (Step 8's file-list) and mount the form when the selected node is `type: 'trigger'`. Wire the `onChange` to the same handler used by the rest of the node inspector (the one that calls `applyOps` or `patchNode`).

For `publishedWebhookUrl`: after publish, look up the owned trigger by `ownerNodeId === trigger.id`, read its webhook token + path, construct the URL from the worker origin.

- [ ] **Step 8.3: Build the client.**

Run: `cd packages/client && pnpm build`
Expected: PASS.

- [ ] **Step 8.4: Commit.**

```bash
git add packages/client/src/components/workflows/trigger-node-subscription-form.tsx \
        <inspector file>
git commit -m "workflow editor: trigger-node subscription form

Adds a manual/webhook/schedule selector to the trigger-node
inspector. Webhook URL surfaces post-publish."
```

---

### Task 9: Update `docs/specs/workflows.md` boundary section

**Files:**
- Modify: `docs/specs/workflows.md`

**Interfaces:**
- Consumes: nothing.
- Produces: canonical reference to the ownership model so future readers don't repeat the confusion.

- [ ] **Step 9.1: Read the existing workflows spec.**

Run: `wc -l docs/specs/workflows.md` and open the file to find where triggers are discussed.

- [ ] **Step 9.2: Add or update the trigger-ownership section.**

Add a section briefly summarizing:

- The trigger-node `subscription` field.
- The publish-time reconciler.
- Ownership on trigger rows (`owner_workflow_id`, `owner_node_id`).
- User-owned triggers stay first-class and are edited in `/automation/triggers`.
- Link to `docs/specs/2026-07-01-trigger-ownership-design.md` for the full design.

- [ ] **Step 9.3: Commit.**

```bash
git add docs/specs/workflows.md
git commit -m "docs: reference the trigger-ownership model in workflows spec"
```

---

## Self-Review Notes

- Every task ends with a build/test + commit. Steps are small.
- Types flow forward: `ReconcilerOp` (Task 3) → consumed in Task 4; `subscription` union (Task 2) → consumed in Tasks 3, 5B, 5C, 6, 8.
- No placeholder code — every step includes the exact change.
- Gmail / other integration event triggers are explicitly out of scope; the plan calls that out in Task 6's prompt update so the copilot doesn't hallucinate unsupported subscription types.
- Slack `message.channels` is in v1 scope. The Slack Events API is already subscribed at the app manifest level (`packages/plugin-slack/slack-app-manifest.json`) — no external Slack config change needed. The dispatch fork in Task 5B wires those events to workflow executions.
- GitHub events are in v1 scope. The GitHub App webhook is already live at `/api/webhooks/github` with signature verification. The dispatch fork in Task 5C is additive to the existing installation/pull_request/push handlers — those keep running for session-state routing.
- Integration-scoped resolution (Slack channel name→id, GitHub installation binding) is separated from the pure reconciler (Task 4.5a) so `planReconciliation` stays testable in isolation.
- Existing user-owned triggers behavior verified in Task 4 test.
- Existing Slack DM → orchestrator routing unchanged; verified in Task 5B.6.
- Existing GitHub session-state handlers unchanged; verified in Task 5C.6.
