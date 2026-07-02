# Trigger Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workflow-targeted triggers derivable from a workflow's trigger-node `subscription` declaration, so the copilot can wire triggers by editing the definition alone.

**Architecture:** Extend `triggers` with nullable `owner_workflow_id` + `owner_node_id`. Extend the workflow trigger-node schema with an optional `subscription` discriminated union (`manual | webhook | schedule`). On publish, a reconciler diffs declared vs. existing owned triggers and applies create/update/delete. UI locks the declarative fields of owned triggers; keeps enable/disable free.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, D1 (SQLite), Cloudflare Workers, Vitest, React 19, TanStack Query. Design spec: `docs/specs/2026-07-01-trigger-ownership-design.md`.

## Global Constraints

- Existing user-owned triggers (`owner_workflow_id IS NULL`) must behave exactly as today after every task in this plan.
- Subscription source types in v1: `manual | webhook | schedule | slack.message.channels | github.event`. Gmail/other integrations defer.
- **Publish ordering: resolve → commit resolved definition → reconcile.** Resolvers run BEFORE the version write commits. If a resolver throws, no version is committed and no triggers change. The version stores fully-resolved identifiers (teamId, channelId, installationId) so rollback + re-reconcile is deterministic.
- **Name ownership.** Reconciler generates `name` on CREATE only. UPDATE never touches `name`, `enabled`, `webhookToken`, or `lastFiredAt`. Users may rename an owned trigger row; the rename persists across republishes.
- **Uniqueness.** `UNIQUE(owner_workflow_id, owner_node_id)` partial index (where `owner_workflow_id IS NOT NULL`) is the guard against concurrent-publish duplication. The losing INSERT fails and the losing publish returns an error.
- **Identity for reconciler matching:** `stableId ?? owner_node_id`. Webhook subscriptions may set an optional `stableId` so trigger-node renames don't rotate the URL.
- Webhook tokens must remain stable across republishes and across trigger-node renames when `stableId` is set. Without `stableId`, node rename = delete + create = new token (UI must warn).
- Slack `message.channels` events already reach the worker (app manifest is subscribed). Dispatch to workflows forks off the existing DM/orchestrator router; DM routing untouched.
- GitHub App webhooks already reach `/api/webhooks/github` and are signature-verified. The existing `installation`/`pull_request`/`push` handlers continue to run unchanged — the workflow-trigger dispatch is additive.
- Channel names (`#incidents`) in Slack subscriptions are resolved to Slack IDs (`C012ABCD`) at publish time. For **private channels** the resolver additionally verifies the publishing user's linked Slack identity is a member — this closes a per-user leak where any org member could subscribe to sensitive channels the bot happens to be in.
- GitHub `installationId` in subscriptions is auto-resolved when the owner has exactly one installation; otherwise required. `repo` (`owner/name`) is validated against the installation's repo access at publish. The resolver verifies the installation belongs to the publishing user.
- GitHub reentrance: `filters.ignoreSelf` defaults to `true` and drops events where `sender.type === 'Bot'` and `sender.login.endsWith('[bot]')`. Only opt out with explicit user consent.
- Slack reentrance: `filters.ignoreBots` defaults to `true`.
- Reconciler + dispatch CRUD run via **system-context helpers** (`createTriggerAsOwner`, `updateOwnedTrigger`, `deleteOwnedTrigger`) that bypass the user-scoped WHERE clauses of the user-facing CRUD. User-facing helpers stay ownership-scoped.
- Dispatch stamps `lastFiredAt` on every enqueued execution. UI surfaces "not fired recently" for both owned and user-owned triggers.
- Delivery idempotency: Slack `event_id` and GitHub `X-GitHub-Delivery` are recorded before enqueue so a `waitUntil` failure can be recovered by a cron sweep (Task 10).
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

### Task 1: Schema migration for ownership + widened execution CHECK

**Files:**
- Create: `packages/worker/migrations/0024_trigger_ownership.sql`
- Modify: `packages/worker/src/lib/schema/workflows.ts` (triggers table)
- Modify: `packages/worker/src/lib/schema/workflows.ts` (workflow_executions if the CHECK is expressed in Drizzle; otherwise SQL-only)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `triggers` gains `owner_workflow_id`, `owner_node_id`, `health_status` (all nullable text).
  - `idx_triggers_owner_workflow` on `owner_workflow_id`.
  - `idx_triggers_owner_key` — **partial unique** on `(owner_workflow_id, owner_node_id) WHERE owner_workflow_id IS NOT NULL`.
  - `workflow_executions.trigger_type` CHECK widened to include `slack.message.channels` and `github.event`.

**Why the CHECK widening matters:** the current constraint (from migration `0020_workflows_dag_v1.sql`) restricts `trigger_type` to `manual|webhook|schedule`. If we don't widen it, every Slack/GitHub execution INSERT fails with a constraint violation. Dispatch runs inside `waitUntil` so the error is swallowed silently — dropped events with no diagnostic. **Do this in the same migration as the owner columns.**

- [ ] **Step 1.1: Read the current migration numbering and both schema pieces.**

Run: `ls packages/worker/migrations/ | tail -5` and open `packages/worker/src/lib/schema/workflows.ts` to confirm the current `triggers` shape. Confirm the last migration is `0023_workflow_copilot.sql` before naming the new one `0024`.

Also read `packages/worker/migrations/0020_workflows_dag_v1.sql` and search for `workflow_executions.*CHECK` — you need the exact original CHECK expression to reproduce it (SQLite requires a table rebuild to alter a CHECK).

- [ ] **Step 1.2: Write the SQL migration.**

Create `packages/worker/migrations/0024_trigger_ownership.sql`:

```sql
-- Ownership columns for workflow-declared triggers. NULL = user-owned
-- (behavior unchanged from prior migrations).
ALTER TABLE triggers ADD COLUMN owner_workflow_id TEXT
  REFERENCES workflows(id) ON DELETE CASCADE;
ALTER TABLE triggers ADD COLUMN owner_node_id TEXT;
-- Populated by the periodic sanity check + resolver failures.
ALTER TABLE triggers ADD COLUMN health_status TEXT;

CREATE INDEX idx_triggers_owner_workflow ON triggers(owner_workflow_id);

-- Partial unique: user-owned rows (both NULL) unconstrained; workflow-
-- owned rows are unique by (workflow, node). Prevents duplicate rows
-- from concurrent-publish races.
CREATE UNIQUE INDEX idx_triggers_owner_key
  ON triggers(owner_workflow_id, owner_node_id)
  WHERE owner_workflow_id IS NOT NULL;

-- Widen workflow_executions.trigger_type CHECK so Slack + GitHub
-- executions can insert. SQLite table rebuild pattern.
CREATE TABLE workflow_executions_new (
  -- COPY the existing column definitions verbatim from migration 0020
  -- and update ONLY the trigger_type CHECK to include the new values.
  -- (Fill this in exactly per 0020's shape.)
  ...
  trigger_type TEXT NOT NULL CHECK (
    trigger_type IN ('manual', 'webhook', 'schedule',
                     'slack.message.channels', 'github.event')
  ),
  ...
);

INSERT INTO workflow_executions_new SELECT * FROM workflow_executions;
DROP TABLE workflow_executions;
ALTER TABLE workflow_executions_new RENAME TO workflow_executions;

-- Re-create every index that lived on workflow_executions in 0020
-- (SQLite drops indexes with the table).
```

Fill in the `...` blocks from `0020_workflows_dag_v1.sql` — exact columns, exact indexes. Skipping any index leaves execution queries slower on prod.

- [ ] **Step 1.3: Update the Drizzle schema in `packages/worker/src/lib/schema/workflows.ts`.**

Add to `triggers` table:

```ts
ownerWorkflowId: text('owner_workflow_id').references(() => workflows.id, { onDelete: 'cascade' }),
ownerNodeId: text('owner_node_id'),
healthStatus: text('health_status'),
```

And indexes:

```ts
index('idx_triggers_owner_workflow').on(table.ownerWorkflowId),
uniqueIndex('idx_triggers_owner_key').on(table.ownerWorkflowId, table.ownerNodeId)
  .where(sql`${table.ownerWorkflowId} IS NOT NULL`),
```

If `workflow_executions.triggerType` has a Drizzle CHECK, update the enum values there too. Otherwise Drizzle stays in sync via the DB.

- [ ] **Step 1.4: Typecheck the worker.**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS. Any consumer that destructures `TriggerRow` will surface breaks — leave them to be widened in the next task.

- [ ] **Step 1.5: Commit.**

```bash
git add packages/worker/migrations/0024_trigger_ownership.sql \
        packages/worker/src/lib/schema/workflows.ts
git commit -m "triggers: ownership columns + widen execution CHECK

- owner_workflow_id / owner_node_id / health_status.
- Partial unique(owner_workflow_id, owner_node_id) prevents
  concurrent-publish duplication.
- Widen workflow_executions.trigger_type CHECK to include
  slack.message.channels + github.event so dispatch INSERTs
  do not silently fail inside waitUntil."
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
  | { type: 'webhook'; method?: 'GET' | 'POST' | 'PUT'; rateLimit?: number; stableId?: string }
  | { type: 'schedule'; cron: string; timezone?: string; triggerData?: Record<string, unknown> }
  | { type: 'slack.message.channels'; channel: string; teamId?: string;
      filters?: { ignoreBots?: boolean; mentionOnly?: boolean } }
  | { type: 'github.event'; event: string; action?: string;
      installationId?: number; repo?: string;
      filters?: { branch?: string; author?: string; ignoreSelf?: boolean } };
```

`stableId` on webhook lets the user pin token stability across trigger-node renames — the reconciler keys identity by `stableId ?? nodeId`. `ignoreSelf` on github defaults to `true` in the resolver + dispatcher; it drops events where `sender.type === 'Bot'` and `sender.login.endsWith('[bot]')`, preventing reentrance loops.

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
    stableId: z.string().min(1).optional(),
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
      ignoreSelf: z.boolean().optional(),
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
  | { kind: 'create'; identityKey: string; nodeId: string;
      type: ReconcilerTriggerType; config: TriggerConfig; name: string }
  | { kind: 'update'; triggerId: string;
      type: ReconcilerTriggerType; config: TriggerConfig }
  | { kind: 'delete'; triggerId: string };

export function planReconciliation(input: {
  workflowId: string;
  workflowName: string;
  definition: WorkflowDefinition;   // MUST be resolved (Task 4.5a).
  existing: Array<{ id: string; ownerNodeId: string | null; type: string; config: string; name: string }>;
}): ReconcilerOp[];
```

Pure — no DB access, no side effects. Returns the op list; callers apply it. Throws if an integration-scoped subscription is unresolved (missing teamId/channelId for Slack, or installationId for GitHub). The resolver in Task 4 is what filters invalid input before planning.

Identity model:
- `identityKey = subscription.stableId ?? node.id` — webhook subs can pin `stableId` to keep the URL stable across node renames.
- The reconciler persists `owner_node_id = identityKey` on CREATE.
- `create` ops carry both `identityKey` (persisted) and `nodeId` (informational — used by callers building names, logs, etc.).
- `update` ops never carry `name` — name is user-editable after CREATE.

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
      kind: 'create', identityKey: 'trigger', nodeId: 'trigger', type: 'webhook',
    });
  });

  it('webhook stableId survives trigger-node rename', () => {
    // Existing owned trigger keyed by stableId=primary.
    const existing = [{
      id: 't1', ownerNodeId: 'primary', type: 'webhook',
      config: JSON.stringify({ type: 'webhook', path: '/w/primary' }),
      name: 'W — trigger',
    }];
    // Definition renames the node from 'trigger' to 'entry' but keeps stableId.
    const def = baseDef([{
      id: 'entry', type: 'trigger',
      subscription: { type: 'webhook', stableId: 'primary' },
    }]);
    const ops = planReconciliation({
      workflowId: 'wf', workflowName: 'W', definition: def, existing,
    });
    // NO create + delete cycle; noop.
    expect(ops).toEqual([]);
  });

  it('does not clobber user-renamed trigger row on update', () => {
    // Existing owned trigger with a user-set name.
    const existing = [{
      id: 't1', ownerNodeId: 'trigger', type: 'schedule',
      config: JSON.stringify({ type: 'schedule', cron: '0 9 * * *' }),
      name: 'My custom name',
    }];
    // Definition changed the cron.
    const def = baseDef([{
      id: 'trigger', type: 'trigger',
      subscription: { type: 'schedule', cron: '0 12 * * *' },
    }]);
    const ops = planReconciliation({
      workflowId: 'wf', workflowName: 'W', definition: def, existing,
    });
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ kind: 'update', triggerId: 't1' });
    // Critical: the update op MUST NOT contain a `name` field.
    expect(ops[0]).not.toHaveProperty('name');
  });

  it('nested filters do not produce false UPDATE ops', () => {
    // Same filters object with keys in different insertion order.
    const cfg = { type: 'schedule' as const, cron: '0 9 * * *' };
    const filtersA = { mentionOnly: false, ignoreBots: true };
    const filtersB = { ignoreBots: true, mentionOnly: false };
    const def = baseDef([{
      id: 'trigger', type: 'trigger',
      subscription: { type: 'slack.message.channels', channel: 'C1', teamId: 'T1', filters: filtersA },
    }]);
    const existing = [{
      id: 't1', ownerNodeId: 'trigger', type: 'slack.message.channels',
      config: JSON.stringify({
        type: 'slack.message.channels', teamId: 'T1', channelId: 'C1', filters: filtersB,
      }),
      name: 'W — trigger',
    }];
    const ops = planReconciliation({
      workflowId: 'wf', workflowName: 'W', definition: def, existing,
    });
    expect(ops).toEqual([]);
  });

  it('throws when a slack subscription is not resolved (missing teamId)', () => {
    const def = baseDef([{
      id: 'trigger', type: 'trigger',
      subscription: { type: 'slack.message.channels', channel: '#incidents' },  // unresolved
    }]);
    expect(() => planReconciliation({
      workflowId: 'wf', workflowName: 'W', definition: def, existing: [],
    })).toThrow(/unresolved/);
  });

  it('throws when a github subscription is not resolved (missing installationId)', () => {
    const def = baseDef([{
      id: 'trigger', type: 'trigger',
      subscription: { type: 'github.event', event: 'pull_request' },  // unresolved
    }]);
    expect(() => planReconciliation({
      workflowId: 'wf', workflowName: 'W', definition: def, existing: [],
    })).toThrow(/unresolved/);
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

// Reconciler op union. `create` carries the identityKey so the caller
// can persist owner_node_id; `update` NEVER carries `name` — the
// reconciler owns name only at CREATE time. This is a deliberate change
// from the initial draft to match the spec: users may rename an owned
// trigger row, and the rename persists across republishes.
export type ReconcilerOp =
  | { kind: 'create'; identityKey: string; nodeId: string;
      type: ReconcilerTriggerType; config: TriggerConfig; name: string }
  | { kind: 'update'; triggerId: string;
      type: ReconcilerTriggerType; config: TriggerConfig }
  | { kind: 'delete'; triggerId: string };

type ExistingRow = { id: string; ownerNodeId: string | null; type: string; config: string; name: string };

interface Input {
  workflowId: string;
  workflowName: string;
  definition: WorkflowDefinition;   // MUST be a resolved definition — see Task 4.5a.
  existing: ExistingRow[];
}

export function planReconciliation(input: Input): ReconcilerOp[] {
  const declared = extractDeclared(input.definition, input.workflowName);
  const existingByKey = new Map(
    input.existing.filter((r) => r.ownerNodeId).map((r) => [r.ownerNodeId!, r] as const),
  );

  const ops: ReconcilerOp[] = [];

  for (const [identityKey, next] of declared) {
    const prev = existingByKey.get(identityKey);
    if (!prev) {
      ops.push({ kind: 'create', identityKey, nodeId: next.nodeId,
                 type: next.type, config: next.config, name: next.name });
      continue;
    }
    existingByKey.delete(identityKey);
    if (configsEqual(prev, next)) continue;
    // NOTE: no `name` — reconciler doesn't clobber user-renamed rows.
    ops.push({ kind: 'update', triggerId: prev.id, type: next.type, config: next.config });
  }

  for (const stale of existingByKey.values()) {
    ops.push({ kind: 'delete', triggerId: stale.id });
  }

  return ops;
}

interface DeclaredEntry {
  nodeId: string;
  type: ReconcilerTriggerType;
  config: TriggerConfig;
  name: string;
}

function extractDeclared(def: WorkflowDefinition, workflowName: string): Map<string, DeclaredEntry> {
  const out = new Map<string, DeclaredEntry>();
  for (const node of def.nodes) {
    if (node.type !== 'trigger') continue;
    const sub = (node as { subscription?: { type: string } }).subscription;
    if (!sub || sub.type === 'manual') continue;

    // Identity: webhook subscriptions may pin a stableId across renames.
    // Everything else uses the node id.
    const identityKey =
      sub.type === 'webhook' && typeof (sub as { stableId?: string }).stableId === 'string'
        ? (sub as { stableId: string }).stableId
        : node.id;
    const name = `${workflowName} — ${node.id}`;

    if (sub.type === 'webhook') {
      const s = sub as { type: 'webhook'; method?: string; rateLimit?: number; stableId?: string };
      out.set(identityKey, {
        nodeId: node.id, type: 'webhook',
        config: {
          type: 'webhook',
          path: `/w/${identityKey}`,   // stable across node renames when stableId is set
          method: s.method,
          rateLimit: s.rateLimit,
        },
        name,
      });
    } else if (sub.type === 'schedule') {
      const s = sub as { type: 'schedule'; cron: string; timezone?: string; triggerData?: Record<string, unknown> };
      out.set(identityKey, {
        nodeId: node.id, type: 'schedule',
        config: {
          type: 'schedule', cron: s.cron, timezone: s.timezone,
          target: 'workflow', triggerData: s.triggerData,
        },
        name,
      });
    } else if (sub.type === 'slack.message.channels') {
      // Definition MUST be resolved — Task 4's resolver rewrote channel
      // to a C-prefixed id and set teamId. If either is missing here it
      // is a programmer error upstream; throw so the bug surfaces
      // instead of silently dropping the subscription.
      const s = sub as { type: 'slack.message.channels'; channel: string; teamId?: string; filters?: { ignoreBots?: boolean; mentionOnly?: boolean } };
      if (!s.teamId || !/^C[A-Z0-9]+$/.test(s.channel)) {
        throw new Error(`planReconciliation: slack subscription for node ${node.id} is unresolved (channel=${s.channel}, teamId=${s.teamId ?? 'undefined'}). Caller must resolve before planning.`);
      }
      out.set(identityKey, {
        nodeId: node.id, type: 'slack.message.channels',
        config: {
          type: 'slack.message.channels',
          teamId: s.teamId,
          channelId: s.channel,
          filters: s.filters,
        },
        name,
      });
    } else if (sub.type === 'github.event') {
      const s = sub as {
        type: 'github.event'; event: string; action?: string;
        installationId?: number; repo?: string;
        filters?: { branch?: string; author?: string; ignoreSelf?: boolean };
      };
      if (typeof s.installationId !== 'number') {
        throw new Error(`planReconciliation: github subscription for node ${node.id} is unresolved (installationId missing). Caller must resolve before planning.`);
      }
      out.set(identityKey, {
        nodeId: node.id, type: 'github.event',
        config: {
          type: 'github.event',
          installationId: s.installationId,
          event: s.event,
          action: s.action,
          repo: s.repo,
          filters: s.filters,
        },
        name,
      });
    }
  }
  return out;
}

function configsEqual(prev: ExistingRow, next: DeclaredEntry): boolean {
  if (prev.type !== next.type) return false;
  // Deliberately DOES NOT compare `name` — the reconciler owns name only
  // at create time; user renames must survive republish.
  try {
    const prevCfg = JSON.parse(prev.config);
    return canonicalJson(prevCfg) === canonicalJson(next.config);
  } catch {
    return false;
  }
}

// Recursive deep-sort: nested objects (like `filters`) also get their
// keys sorted so filter reorderings don't emit false UPDATE ops. Arrays
// are preserved as-is (order matters). Primitives are passed through.
function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(record).sort()) sorted[key] = sortDeep(record[key]);
    return sorted;
  }
  return value;
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

### Task 4: Wire resolve → commit resolved → reconcile into publishDraft

**Files:**
- Modify: `packages/worker/src/services/workflow-versions.ts` — this is where `publishDraft` lives (grep to verify; the summary/state earlier confirms this file). The reconciler + resolvers wire in HERE, not `workflows.ts`.
- Modify: `packages/worker/src/lib/db/triggers.ts` — add **system-context** CRUD helpers `createTriggerAsOwner`, `updateOwnedTrigger`, `deleteOwnedTrigger`, `listOwnedTriggers`. These bypass the user-scoped WHERE clauses of the existing user-facing CRUD; the user-facing helpers stay ownership-scoped.
- Test: `packages/worker/src/services/workflow-versions.publish.test.ts` (new or extend existing) — integration test against the D1 test harness.

**Interfaces:**
- Consumes: `planReconciliation` from Task 3; `resolveSlackSubscriptions` and `resolveGithubSubscriptions` from Step 4.5a.
- Produces: `publishDraft` runs **resolve → commit resolved definition → reconcile**. Return shape unchanged. Side effects: (a) the `workflow_versions` row stores the *resolved* definition (with concrete team/channel/installation ids), (b) triggers table matches the resolved definition's declarations.

**Why this ordering matters (from adversarial review):** the previous ordering ran the reconciler *after* the version commit. If the reconciler or resolver threw, the version was permanent but no triggers existed. The user's UI showed "published" while nothing routed to it. The fix is to run resolvers BEFORE the version write commits; the version stores the resolved definition so rollback + re-reconcile is deterministic.

- [ ] **Step 4.1: Locate the actual publish path and existing trigger CRUD.**

Run:
```bash
grep -rn "publishDraft\|publishWorkflow\|createTrigger\|export.*Trigger" packages/worker/src/services packages/worker/src/lib/db 2>/dev/null | head -30
```

Read the current `publishDraft` implementation and the trigger CRUD in `packages/worker/src/lib/db/triggers.ts`. Confirm the existing signatures — specifically `deleteTrigger(db, triggerId, userId)` and `updateTrigger(db, triggerId, userId, setClauses, values)` require a `userId` and raw SQL, and CANNOT be called directly from the reconciler.

- [ ] **Step 4.2: Add system-context CRUD helpers to `packages/worker/src/lib/db/triggers.ts`.**

Add alongside the existing user-facing helpers:

```ts
// System-context CRUD used by the publish reconciler. Bypasses the
// user-scoped WHERE clauses of the user-facing helpers. Never expose
// via HTTP handlers directly.
export async function createTriggerAsOwner(db: AppDb, params: {
  id: string;
  userId: string;
  workflowId: string;
  ownerWorkflowId: string;
  ownerNodeId: string;
  name: string;
  type: string;
  config: string;
  webhookToken?: string | null;
}): Promise<void> {
  await db.insert(triggers).values({
    id: params.id,
    userId: params.userId,
    workflowId: params.workflowId,
    ownerWorkflowId: params.ownerWorkflowId,
    ownerNodeId: params.ownerNodeId,
    name: params.name,
    type: params.type,
    config: params.config,
    enabled: true,
    webhookToken: params.webhookToken ?? null,
  }).run();
}

export async function updateOwnedTrigger(db: AppDb, triggerId: string, patch: {
  type: string;
  config: string;
}): Promise<void> {
  // Deliberately does NOT touch: name, enabled, webhookToken, lastFiredAt.
  await db.update(triggers).set({
    type: patch.type,
    config: patch.config,
    updatedAt: sql`(datetime('now'))`,
  }).where(eq(triggers.id, triggerId)).run();
}

export async function deleteOwnedTrigger(db: AppDb, triggerId: string): Promise<void> {
  await db.delete(triggers).where(eq(triggers.id, triggerId)).run();
}

export async function listOwnedTriggers(db: AppDb, workflowId: string) {
  return db.select().from(triggers)
    .where(eq(triggers.ownerWorkflowId, workflowId));
}
```

The user-facing `createTrigger`/`updateTrigger`/`deleteTrigger` stay ownership-scoped. If Task 5 (guards) hasn't landed yet, that's fine — they simply won't be called on owned rows.

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

**Private-channel user-membership check (from adversarial review — closes a leak).** Slack installs today are org-scoped; without this check, any user in an org where the bot is invited to `#exec-comp` could publish a workflow that pipes `#exec-comp` messages through `trigger.data.text`. For private channels (Slack returns `is_private: true` on `conversations.info`), the resolver MUST additionally call `conversations.members` with the workflow owner's linked Slack identity and verify membership:

```ts
// Inside resolveSlackSubscriptions, after resolving name -> channelId:
const info = await slack.conversations.info({ channel: channelId, token: install.botToken });
if (info.channel.is_private) {
  const slackUserId = await getUserSlackIdentity(db, userId, install.teamId);
  if (!slackUserId) {
    throw new ValidationError(`Cannot subscribe to private channel ${channelDisplay} — you must link your Slack account first.`);
  }
  const members = await slack.conversations.members({ channel: channelId, token: install.botToken });
  if (!members.includes(slackUserId)) {
    throw new ValidationError(`Cannot subscribe to private channel ${channelDisplay} — you are not a member.`);
  }
}
```

Write tests at `packages/worker/src/services/slack-channel-resolver.test.ts` mocking the Slack API surface (see existing mocks in `packages/worker/src/services/slack.test.ts` if present). Include a test for:
- name resolution to id,
- unresolvable channel throws,
- multi-workspace requires teamId,
- private channel with user membership: PASS,
- private channel WITHOUT user membership: throws,
- public channel: no membership check runs.

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
- `"Installation 99999 is not linked to your account."` (When the declared installationId belongs to another user — critical for cross-user isolation. `listGithubInstallationsByUser` is already user-scoped; the resolver must reject any declared installationId not in that list.)

Tests: `packages/worker/src/services/github-installation-resolver.test.ts` — mock the installations DB helper and the repo-access check. Include:
- auto-select when user has exactly one installation,
- multi-installation without declared id: throws,
- declared installationId belonging to another user: throws (critical),
- declared repo not in installation's covered repos: throws,
- happy path when installationId + repo both valid.

- [ ] **Step 4.5b: Reorder `publishDraft` to resolve → commit resolved → reconcile.**

The critical inversion: resolvers run BEFORE the version write commits. If a resolver throws (bot not in channel, wrong installationId, cross-user installation), the version is never written and no triggers change. The version stores the *resolved* definition so rollback + re-reconcile is deterministic.

Read the current `publishDraft` in `packages/worker/src/services/workflow-versions.ts` and identify:
- where the draft is loaded (raw definition),
- where the CAS on `expectedUpdatedAt` happens,
- where the new `workflow_versions` row is inserted,
- where `published_version_id` is updated.

Then restructure:

```ts
import { planReconciliation } from './trigger-reconciler.js';
import {
  createTriggerAsOwner, updateOwnedTrigger, deleteOwnedTrigger, listOwnedTriggers,
} from '../lib/db/triggers.js';
import { resolveSlackSubscriptions } from './slack-channel-resolver.js';
import { resolveGithubSubscriptions } from './github-installation-resolver.js';
import { generateWebhookToken } from '...';

export async function publishDraft(...) {
  // 1. Load draft definition.
  const draft = await loadDraft(db, workflowId);

  // 2. Resolve integration-scoped subscriptions. If any resolver
  //    throws, we exit before touching workflow_versions.
  let resolvedDefinition = await resolveSlackSubscriptions({
    db, encryptionKey: env.ENCRYPTION_KEY,
    userId: workflow.userId, definition: draft.definition,
  });
  resolvedDefinition = await resolveGithubSubscriptions({
    db, userId: workflow.userId, definition: resolvedDefinition,
  });

  // 3. Commit the RESOLVED definition as the new published version.
  //    Existing CAS + version-number retry loop stays as-is; the only
  //    change is the definition being written is `resolvedDefinition`,
  //    not the raw draft.
  const versionRow = await commitPublishedVersion(db, {
    workflowId,
    definition: resolvedDefinition,
    expectedUpdatedAt: opts.expectedUpdatedAt,
    // ... other existing args
  });

  // 4. Reconcile the triggers table.
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
      await createTriggerAsOwner(db, {
        id: crypto.randomUUID(),
        userId: workflow.userId,
        workflowId,
        ownerWorkflowId: workflowId,
        ownerNodeId: op.identityKey,       // NOTE: identityKey, not nodeId — stableId compatibility
        name: op.name,
        type: op.type,
        config: JSON.stringify(op.config),
        webhookToken: op.type === 'webhook' ? generateWebhookToken() : null,
      });
    } else if (op.kind === 'update') {
      // System-context update — no user scoping, and deliberately does
      // not touch name/enabled/webhookToken/lastFiredAt.
      await updateOwnedTrigger(db, op.triggerId, {
        type: op.type,
        config: JSON.stringify(op.config),
      });
    } else {
      await deleteOwnedTrigger(db, op.triggerId);
    }
  }

  return versionRow;
}
```

Notes:
- If step 4 partially fails (one CREATE errors because of the partial unique index — concurrent-publish race), the winning publisher has already committed a valid version + triggers, and the loser gets a well-defined error. Report as `409 conflict` back to the client.
- If step 4 fully fails after step 3 committed, the workflow is published but triggers are inconsistent. Next publish self-heals. In practice this only happens on a DB outage between the two batches; log at ERROR level and surface a `503` so the client retries. This edge is documented in the spec — do NOT try to roll back the version write, which would race worse.
- The identity persisted on CREATE is `op.identityKey`, which equals `subscription.stableId ?? node.id`. This is what makes webhook renames with `stableId` stable.

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

    c.executionCtx.waitUntil((async () => {
      try {
        await enqueueWorkflowExecution({
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
        });
        // Stamp lastFiredAt so the UI can surface "recently fired" and
        // detect silent trigger death (spec: Health signals).
        await stampTriggerLastFired(c.get('db'), trig.id);
      } catch (err) {
        // waitUntil failures are otherwise invisible. Log at ERROR so
        // Cloudflare observability picks it up.
        console.error('[slack-events] workflow dispatch failed', err);
      }
    })());
  }
}
```

Where `stampTriggerLastFired` is a new helper in `packages/worker/src/lib/db/triggers.ts`:

```ts
export async function stampTriggerLastFired(db: AppDb, triggerId: string): Promise<void> {
  await db.update(triggers)
    .set({ lastRunAt: sql`(datetime('now'))` })
    .where(eq(triggers.id, triggerId))
    .run();
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

      const sender = payload.sender as { login?: string; type?: string } | undefined;
      const senderLogin = sender?.login;
      const senderType = sender?.type;
      if (config.filters?.author && senderLogin !== config.filters.author) continue;

      // Reentrance guard (default ON per spec). Drop events authored
      // by any GitHub App bot — includes the Valet app's own commits/
      // comments that would otherwise loop the workflow indefinitely.
      const ignoreSelf = config.filters?.ignoreSelf !== false;
      if (ignoreSelf && senderType === 'Bot' && senderLogin?.endsWith('[bot]')) continue;

      const repo = (payload.repository as { full_name?: string; owner?: { login?: string }; name?: string } | undefined);
      c.executionCtx.waitUntil((async () => {
        try {
          await enqueueWorkflowExecution({
            db: getDb(c.env.DB),
            env: c.env,
            workflowId: trig.workflowId!,
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
          });
          await stampTriggerLastFired(getDb(c.env.DB), trig.id);
        } catch (err) {
          console.error('[github webhook] workflow dispatch failed', err);
        }
      })());
    }
  }
} catch (error) {
  console.error('[github webhook] workflow dispatch error:', error);
}
```

Reentrance-loop test to add to Step 5C.2:

```ts
it('drops events authored by another bot when ignoreSelf is on (default)', async () => {
  const { app, db, enqueueSpy } = await setupTestApp();
  await seedOwnedGithubTrigger(db, {
    workflowId: 'wf1', installationId: 42, event: 'issue_comment',
    // no filters — ignoreSelf defaults true
  });
  await app.request('/api/webhooks/github', {
    method: 'POST',
    headers: githubHeaders('issue_comment'),
    body: JSON.stringify({
      action: 'created',
      installation: { id: 42 },
      repository: { full_name: 'anthropics/valet' },
      sender: { login: 'valet-app[bot]', type: 'Bot' },
      comment: { body: 'looks good' },
    }),
  });
  expect(enqueueSpy).not.toHaveBeenCalled();
});

it('honors explicit ignoreSelf: false override', async () => {
  const { app, db, enqueueSpy } = await setupTestApp();
  await seedOwnedGithubTrigger(db, {
    workflowId: 'wf1', installationId: 42, event: 'issue_comment',
    filters: { ignoreSelf: false },
  });
  await app.request('/api/webhooks/github', {
    method: 'POST',
    headers: githubHeaders('issue_comment'),
    body: JSON.stringify({
      action: 'created',
      installation: { id: 42 },
      repository: { full_name: 'anthropics/valet' },
      sender: { login: 'valet-app[bot]', type: 'Bot' },
    }),
  });
  expect(enqueueSpy).toHaveBeenCalled();
});
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

### Task 5D: Cascade owned-trigger cleanup on integration disconnect

**Files:**
- Modify: `packages/worker/src/services/github-installations.ts` (or wherever `handleInstallationWebhook` lives — locate via `grep -rn "handleInstallationWebhook" packages/worker/src`).
- Modify: whatever code handles Slack workspace disconnect (grep for `deleteOrgSlackInstall`, `disconnectSlack`, or similar in `packages/worker/src/`).
- Test: extend the corresponding installation/disconnect test files.

**Interfaces:**
- Consumes: existing installation lifecycle hooks.
- Produces: when a GitHub installation is uninstalled (or a Slack workspace disconnected), all owned triggers scoped to it are DELETEd and the owning workflows are marked with a `health_status` reason. Prevents dispatch continuing to fire against an installation/workspace the user no longer controls.

- [ ] **Step 5D.1: Locate the installation lifecycle handlers.**

Run: `grep -n "handleInstallationWebhook\|updateGithubInstallationStatus\|installation.*delete" packages/worker/src/**/*.ts | head -15`

Read the handler and confirm where the `deleted`/`suspend` branches live.

- [ ] **Step 5D.2: Write the failing test.**

Extend `packages/worker/src/services/github-installations.test.ts` (or create one if none exists):

```ts
it('deletes owned github.event triggers when the installation is uninstalled', async () => {
  const db = await setupTestDb();
  await seedInstallation(db, { installationId: 42, userId: 'u1' });
  await seedOwnedGithubTrigger(db, {
    triggerId: 't1', workflowId: 'wf1', userId: 'u1',
    installationId: 42, event: 'pull_request',
  });

  await handleInstallationWebhook(db, {
    action: 'deleted',
    installation: { id: 42 },
  });

  const trig = await db.select().from(triggers).where(eq(triggers.id, 't1')).get();
  expect(trig).toBeUndefined();
});

it('marks the owning workflow with health_status when triggers were cascaded', async () => {
  const db = await setupTestDb();
  await seedInstallation(db, { installationId: 42, userId: 'u1' });
  await seedOwnedGithubTrigger(db, {
    triggerId: 't1', workflowId: 'wf1', userId: 'u1',
    installationId: 42, event: 'pull_request',
  });

  await handleInstallationWebhook(db, {
    action: 'deleted',
    installation: { id: 42 },
  });

  // A separate row on the workflow itself, or a health flag readable by
  // the UI. Adjust to whatever surface Task 8's inspector reads.
  const workflow = await db.select().from(workflows).where(eq(workflows.id, 'wf1')).get();
  expect(workflow?.healthStatus).toBe('trigger_installation_uninstalled');
});
```

- [ ] **Step 5D.3: Implement the cascade in `handleInstallationWebhook`.**

For `deleted` action:

```ts
if (payload.action === 'deleted') {
  const installationId = payload.installation.id;
  // Delete owned github.event triggers scoped to this installation.
  const deleted = await db.delete(triggers)
    .where(and(
      eq(triggers.type, 'github.event'),
      sql`json_extract(${triggers.config}, '$.installationId') = ${installationId}`,
      // Only owned rows — user-owned triggers targeting this installation
      // are the user's responsibility to clean up.
      isNotNull(triggers.ownerWorkflowId),
    ))
    .returning({ workflowId: triggers.ownerWorkflowId }).all();

  // Mark the owning workflows so the editor UI can surface "trigger
  // source disconnected" without polling.
  const workflowIds = new Set(deleted.map((r) => r.workflowId).filter(Boolean));
  for (const workflowId of workflowIds) {
    await db.update(workflows).set({
      healthStatus: 'trigger_installation_uninstalled',
    }).where(eq(workflows.id, workflowId as string)).run();
  }
}
```

For `suspend` — same idea but set `enabled = false` on the triggers rather than deleting; on `unsuspend` re-enable. Include tests for suspend/unsuspend too.

- [ ] **Step 5D.4: Slack workspace disconnect.**

Find the Slack workspace disconnect handler (grep `deleteOrgSlackInstall`, `disconnectSlack`, or the `/api/channels/slack/disconnect` route). Add a parallel cascade:

```ts
// Before deleting the org install row:
await db.delete(triggers)
  .where(and(
    eq(triggers.type, 'slack.message.channels'),
    sql`json_extract(${triggers.config}, '$.teamId') = ${teamId}`,
    isNotNull(triggers.ownerWorkflowId),
  )).run();

// Mark workflows: 'trigger_workspace_disconnected'
```

If no explicit disconnect route exists today, add a TODO in the code with a link to this plan step and skip this substep — the GitHub cascade covers the more urgent case.

- [ ] **Step 5D.5: Run the tests — expect pass.**

Run: `cd packages/worker && pnpm test github-installations && pnpm test slack.disconnect`
Expected: PASS.

- [ ] **Step 5D.6: Add `healthStatus` column to workflows if it doesn't exist.**

If the `workflows` table doesn't already carry a `health_status`, this is where it goes — add a nullable text column in migration 0024 (extend the Task 1 migration if not merged yet, or add a follow-up 0025 if already merged). Update the Drizzle schema similarly.

- [ ] **Step 5D.7: Commit.**

```bash
git add packages/worker/src/services/github-installations.ts \
        packages/worker/src/routes/... \
        packages/worker/src/services/github-installations.test.ts \
        packages/worker/src/lib/schema/workflows.ts \
        packages/worker/migrations/0024_trigger_ownership.sql  # if extended
git commit -m "triggers: cascade on installation uninstall / workspace disconnect

- handleInstallationWebhook 'deleted' now cleans up owned
  github.event triggers scoped to the installation, and marks
  the owning workflows with health_status.
- 'suspend' disables the triggers (unsuspend re-enables).
- Slack workspace disconnect gets a parallel cascade for
  owned slack.message.channels triggers.
- Prevents dispatch continuing against installations/workspaces
  the user no longer controls."
```

---

### Task 6: Copilot integration awareness — new tool + `getNodeSchema` + prompt

**Files:**
- Modify: `packages/worker/src/routes/copilot.ts` — extend the `getNodeSchema` tool, add a new `listConnectedIntegrations` tool, and update the system prompt.

**Interfaces:**
- Consumes: existing `getNodeSchema` tool return shape, `listGithubInstallationsByUser`, and the Slack install lookup.
- Produces:
  - `getNodeSchema` — trigger-node entry documents the `subscription` union with all types, resolved trigger.data shapes, and default filter values.
  - New tool `listConnectedIntegrations` — returns the caller's connected Slack workspaces (teamId, name) and GitHub installations (id, account name, list of repo full names). Copilot MUST call this before writing a subscription that references specific identifiers.
  - System prompt additions: enumerate integrations first; warn on trigger-node rename with webhook subscriptions; ignoreSelf default true for GitHub; note subscription changes explicitly in assistant responses.

**Why this exists (from adversarial review):** without a tool to enumerate integrations, the copilot fabricates `installationId`/`teamId`/`repo` values from context clues. Publish then fails at the resolver, error propagates back through the chat, user tells copilot, copilot retries. That loop is expensive and unreliable. Enumerating up-front means the copilot writes correct identifiers on the first try.

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

- [ ] **Step 6.2b: Add a `listConnectedIntegrations` tool.**

In `packages/worker/src/routes/copilot.ts`, add alongside the existing tool definitions:

```ts
tools.listConnectedIntegrations = {
  description: 'List the current user\'s connected Slack workspaces and GitHub installations. Call this BEFORE writing a subscription that names a specific teamId, installationId, or repo — the identifiers must match what the user actually has.',
  parameters: z.object({}),
  execute: async (): Promise<{
    slack: Array<{ teamId: string; teamName: string | null }>;
    github: Array<{ installationId: number; accountLogin: string; accountType: 'User' | 'Organization'; repos: string[] }>;
  }> => {
    const slack = await listUserSlackWorkspaces(db, userId);
    const github = await listGithubInstallationsByUser(db, userId);
    return {
      slack: slack.map((w) => ({ teamId: w.teamId, teamName: w.teamName ?? null })),
      github: await Promise.all(github.map(async (inst) => ({
        installationId: inst.installationId,
        accountLogin: inst.accountLogin,
        accountType: inst.accountType,
        repos: await listInstallationRepos(db, inst.installationId),  // helper — cached repo index or on-demand fetch
      }))),
    };
  },
};
```

`listUserSlackWorkspaces` and `listInstallationRepos` may need light wrappers around existing lookups. The GitHub repo list should come from the existing `github_installations`-scoped index if one exists (grep for it); if not, use the Octokit `apps.listReposAccessibleToInstallation` call, memoized per installation for the request lifetime.

- [ ] **Step 6.3: Update the system prompt with the integration guidance.**

Append (or splice into the trigger-node section) something like:

> **Setting the trigger node's `subscription` field:**
>
> When the user describes an event source, set the trigger node's `subscription`.
> - "every morning" / "on a schedule" → `{ type: "schedule", cron: "..." }`
> - "when a webhook fires" / "when an external system POSTs" → `{ type: "webhook" }`. The URL is generated post-publish; tell the user to check the trigger node inspector.
> - "when someone posts in #foo" / "when I get pinged in #foo" → `{ type: "slack.message.channels", channel: "#foo", filters: { mentionOnly: true } }` if they specifically said "when I'm mentioned"; otherwise omit `mentionOnly`. Also update the trigger node's `dataSchema` to match the Slack event shape (team, channel, user, text, ts).
> - "when a PR is opened" / "on every commit to main" / "when someone comments on an issue" → `{ type: "github.event", event: "pull_request", action: "opened", repo: "owner/name" }` (adjust event/action to fit). For push filtering, use `filters.branch: "main"`. Set `repo` if the user names one; omit for org-wide. Update the trigger node's `dataSchema` to reflect what your workflow reads from the payload (usually a subset of the top-level fields).
>
> **Before writing an integration-scoped subscription, call `listConnectedIntegrations`** to get the user's actual `teamId`s (Slack), `installationId`s (GitHub), and covered repos. Never fabricate these identifiers — publish will reject them at the resolver with an actionable error, wasting a round-trip.
>
> **Multi-workspace / multi-installation defaults:** if the user has exactly one, omit the identifier and let the resolver auto-select. If they have more than one, ask which one they mean rather than guessing.
>
> **Trigger-node rename hazard:** renaming a trigger node with `subscription.type === 'webhook'` and no `stableId` rotates the webhook URL, breaking external callers. Warn the user before making this change, or set `subscription.stableId` on the webhook to pin the URL.
>
> **GitHub reentrance:** `filters.ignoreSelf` defaults to `true` and drops events authored by any GitHub App bot. This is what prevents workflows that comment on PRs from firing themselves. Do not override to `false` without explicit user consent — infinite loops are the failure mode.
>
> **When applyWorkflowPatch touches a `subscription` field, note it explicitly** in your response summary. "I updated node X's subscription from schedule to slack.message.channels" — do not bury the change inside a generic patch description. These are high-consequence edits (they change what triggers the workflow).
>
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

Pass `disabled={isOwned}` to declarative inputs (**type dropdown, config JSON editor, variable mapping only**). The `enabled` toggle stays free (runtime state), and the `name` field stays free too — the reconciler doesn't touch names post-create, so user renames persist. Do not disable the name input.

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

- [ ] **Step 8.2b: Query the materialized owned trigger and surface runtime state.**

Above the subscription form, when the node id resolves to a materialized owned trigger (look up via `ownerNodeId === node.subscription.stableId ?? node.id`), display:

```tsx
{materialized && (
  <div className="mb-3 space-y-2 rounded-md border border-neutral-200 p-3 text-xs">
    <div className="flex items-center gap-2">
      <span className={materialized.enabled ? 'text-emerald-600' : 'text-neutral-500'}>
        {materialized.enabled ? '● Active' : '○ Disabled'}
      </span>
      {!materialized.enabled && (
        <button onClick={() => enableTrigger(materialized.id)} className="text-violet-600 hover:underline">
          Re-enable
        </button>
      )}
    </div>
    <div className="text-neutral-500">
      Last fired: {materialized.lastRunAt ? formatRelative(materialized.lastRunAt) : 'never'}
    </div>
    {materialized.type === 'webhook' && (
      <div>
        <div className="text-neutral-500">URL:</div>
        <code className="block break-all rounded bg-neutral-100 px-2 py-1">{buildWebhookUrl(materialized)}</code>
      </div>
    )}
    {materialized.healthStatus && (
      <div className="rounded bg-amber-50 px-2 py-1 text-amber-800">
        ⚠ {formatHealthStatus(materialized.healthStatus)}
      </div>
    )}
  </div>
)}
```

`healthStatus` reasons include: `trigger_installation_uninstalled`, `trigger_workspace_disconnected`, `slack_bot_removed_from_channel`, etc. Format them into human-readable copy in `formatHealthStatus`.

- [ ] **Step 8.2c: Warn when renaming a trigger node with a webhook subscription and no `stableId`.**

The inspector's node-id input handler needs a pre-commit guard:

```tsx
const isWebhookWithoutStableId =
  node.type === 'trigger'
  && node.subscription?.type === 'webhook'
  && !node.subscription.stableId;

const handleIdChange = (nextId: string) => {
  if (isWebhookWithoutStableId && nextId !== node.id) {
    const confirmed = window.confirm(
      'Renaming this trigger node will rotate the webhook URL. Any external system using the current URL will get 401 errors.\n\n' +
      'To pin the URL across renames, set subscription.stableId first.\n\n' +
      'Rename anyway?'
    );
    if (!confirmed) return;
  }
  onIdChange(nextId);
};
```

`window.confirm` is fine for v1 — replace with a modal later. The important part is the guard exists.

- [ ] **Step 8.2d: For `publishedWebhookUrl`:**

After publish, look up the owned trigger by `ownerNodeId === subscription.stableId ?? node.id`, read its webhook token + path, construct the URL from the worker origin. This is the `materialized` object referenced in Step 8.2b.

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

### Task 10: Delivery-id dedup + per-trigger execution rate cap

**Files:**
- Modify: `packages/worker/migrations/0024_trigger_ownership.sql` (or a follow-up 0025) — add `channel_event_deliveries` table.
- Modify: `packages/worker/src/lib/schema/workflows.ts` — Drizzle schema for the new table.
- Modify: `packages/worker/src/routes/slack-events.ts` + `packages/worker/src/routes/webhooks.ts` — write the delivery id before enqueue; skip if already recorded.
- Modify: `packages/worker/src/services/executions.ts` (or wherever executions enqueue) — check per-trigger execution rate before enqueue, similar to the existing `trigger_webhook_rate` mechanism.
- Test: extend the dispatch tests to cover dedup + rate cap.

**Interfaces:**
- Consumes: existing `trigger_webhook_rate` pattern.
- Produces:
  - New table `channel_event_deliveries (delivery_id TEXT PRIMARY KEY, trigger_id TEXT, seen_at INTEGER)` — TTL sweep via cron.
  - New DB helper `recordDelivery(db, deliveryId, triggerId) → boolean` (true if newly inserted, false if already present).
  - Per-trigger execution rate cap enforced in the dispatch fork; on exceed, log at WARN and drop.

**Why v1 hardening:** `waitUntil` swallows enqueue failures. Without a delivery-id record, a transient D1 error means the event is permanently lost. And without a per-trigger execution rate cap, a chatty channel or a busy monorepo could fan out unbounded workflow executions before a human notices.

- [ ] **Step 10.1: Add the delivery-dedup table.**

Migration:

```sql
CREATE TABLE channel_event_deliveries (
  delivery_id TEXT NOT NULL,        -- X-GitHub-Delivery or Slack event_id
  source TEXT NOT NULL,             -- 'slack' | 'github'
  trigger_id TEXT NOT NULL REFERENCES triggers(id) ON DELETE CASCADE,
  seen_at INTEGER NOT NULL,
  PRIMARY KEY (delivery_id, source, trigger_id)
);
CREATE INDEX idx_channel_event_deliveries_seen_at ON channel_event_deliveries(seen_at);
```

TTL sweep runs via existing cron.

- [ ] **Step 10.2: Add the DB helper.**

```ts
export async function recordDelivery(
  db: AppDb, deliveryId: string, source: 'slack' | 'github', triggerId: string,
): Promise<boolean> {
  try {
    await db.insert(channelEventDeliveries).values({
      deliveryId, source, triggerId, seenAt: Math.floor(Date.now() / 1000),
    }).run();
    return true;
  } catch {
    return false;  // PK conflict → already recorded
  }
}
```

- [ ] **Step 10.3: Wire dedup into both dispatch forks.**

In each dispatch fork (Task 5B, 5C), BEFORE the `enqueueWorkflowExecution` call:

```ts
const isNew = await recordDelivery(db, deliveryId, 'github', trig.id);
if (!isNew) continue;  // already dispatched
```

For Slack, `deliveryId` = the event's `event_id`. For GitHub, `deliveryId` = the `X-GitHub-Delivery` header value.

- [ ] **Step 10.4: Per-trigger execution rate cap.**

Reuse the `trigger_webhook_rate` pattern — a sliding-minute counter keyed by `trigger_id`. Default cap: 60/minute for event-triggered workflows (same as webhook default). Override via the subscription's `rateLimit` field (already exists on the webhook subscription; add it as an optional field on `slack.message.channels` and `github.event` too).

Before dispatch:

```ts
const allowed = await checkTriggerExecutionRate(db, trig.id, config.rateLimit ?? 60);
if (!allowed) {
  console.warn(`[dispatch] rate limit exceeded for trigger ${trig.id}; dropping event`);
  continue;
}
```

- [ ] **Step 10.5: Tests + commit.**

Extend the dispatch tests with: duplicate delivery id is deduped; rate cap exhausted → drop; rate cap resets after the minute window.

```bash
git commit -m "triggers: delivery-id dedup + per-trigger execution rate cap

- channel_event_deliveries table dedupes Slack event_id + GitHub
  delivery id so waitUntil failures do not silently drop events.
- Per-trigger execution rate cap (default 60/minute) prevents
  chatty channels or busy monorepos from fanning out unbounded
  executions."
```

---

### Task 11: Periodic sanity check for trigger health

**Files:**
- Modify: `packages/worker/src/index.ts` or wherever the cron entrypoint lives (`grep -n "scheduled\|handleCron" packages/worker/src/index.ts`).
- Create: `packages/worker/src/services/trigger-health-check.ts` + test.

**Interfaces:**
- Consumes: existing cron scheduler.
- Produces: hourly job that walks owned triggers, verifies bot channel membership (Slack) and installation validity (GitHub), and stamps `triggers.health_status` on rows whose bindings are broken. UI reads this in the workflow-editor inspector (Task 8.2b).

- [ ] **Step 11.1: Implement the health check.**

```ts
export async function runTriggerHealthCheck(db: AppDb, env: Env): Promise<void> {
  const rows = await db.select().from(triggers)
    .where(and(isNotNull(triggers.ownerWorkflowId), eq(triggers.enabled, true)))
    .all();

  for (const trig of rows) {
    let health: string | null = null;
    if (trig.type === 'slack.message.channels') {
      const cfg = JSON.parse(trig.config) as { teamId: string; channelId: string };
      const stillMember = await isBotMemberOfChannel(db, env, cfg.teamId, cfg.channelId);
      if (!stillMember) health = 'slack_bot_removed_from_channel';
    } else if (trig.type === 'github.event') {
      const cfg = JSON.parse(trig.config) as { installationId: number };
      const install = await getGithubInstallation(db, cfg.installationId);
      if (!install || install.status !== 'active') health = 'github_installation_inactive';
    }
    if (health !== (trig.healthStatus ?? null)) {
      await db.update(triggers).set({ healthStatus: health }).where(eq(triggers.id, trig.id)).run();
    }
  }
}
```

- [ ] **Step 11.2: Schedule it hourly.**

In the cron config (`wrangler.toml` `[triggers.crons]`), add `"0 * * * *"` and route to `runTriggerHealthCheck` in the `scheduled` handler.

- [ ] **Step 11.3: Test + commit.**

Mock the Slack/GitHub API calls and verify `health_status` transitions.

```bash
git commit -m "triggers: hourly sanity check for owned trigger health

Detects bot removed from channel / installation revoked and
stamps triggers.health_status so the workflow editor can
surface broken bindings without waiting for a user report."
```

---

## Self-Review Notes

**Adversarial review findings integrated (v2, 2026-07-01):**

- Publish now runs **resolve → commit resolved definition → reconcile** (Task 4). Resolvers throw BEFORE the version write, so a failed resolution never leaves the workflow published without triggers.
- The workflow_executions.trigger_type CHECK constraint is widened in Task 1 to include `slack.message.channels` and `github.event`. Without this, every event execution INSERT would fail silently inside `waitUntil`.
- Task 1 also adds a partial unique index on `(owner_workflow_id, owner_node_id)` that guards the concurrent-publish race — the losing INSERT fails and the losing publish returns a 409.
- Name ownership is inverted from the initial draft: reconciler defaults on CREATE, never touches on UPDATE. User renames persist. `configsEqual` no longer compares name; the `update` op no longer carries name (Task 3).
- `configsEqual` now uses a **recursive** deep-sort canonicalization so nested `filters` objects don't emit false UPDATE ops on republish (Task 3).
- Reconciler + dispatch use **system-context CRUD helpers** (`createTriggerAsOwner`, `updateOwnedTrigger`, `deleteOwnedTrigger`) that bypass user scoping. User-facing CRUD stays scoped (Task 4.2 + Task 5's guards).
- Reconciler THROWS when a subscription is unresolved instead of silently `continue`ing — the previous silent skip masked resolver failures (Task 3).
- Webhook token stability across trigger-node renames: new optional `subscription.stableId` field; identity keyed by `stableId ?? nodeId` (Tasks 2, 3). Workflow editor warns before commit when a webhook subscription is being renamed without `stableId` (Task 8.2c).
- GitHub reentrance loop closed: `filters.ignoreSelf` defaults `true` and drops `sender.type === 'Bot' && sender.login.endsWith('[bot]')` events (Task 5C). Slack already had `ignoreBots`.
- Slack private-channel leak closed: resolver additionally checks the publishing user's linked Slack identity is a member of the channel (Task 4.5a). Public channels skip the check.
- GitHub cross-user installation binding rejected at resolve: `listGithubInstallationsByUser` is user-scoped; the resolver rejects any declared installationId not in that list (Task 4.5a).
- Slack DM → orchestrator routing untouched; verified in Task 5B.6.
- Existing GitHub session-state handlers (installation / pull_request / push) untouched; verified in Task 5C.6.
- Existing user-owned triggers untouched: verified in Task 4 test with a manual trigger seeded on the same workflowId.

**New tasks:**
- **Task 5D — cascade cleanup on integration disconnect.** GitHub uninstall + Slack workspace disconnect delete owned triggers and mark owning workflows with `health_status`, preventing dispatch continuing against resources the user no longer controls.
- **Task 6 — `listConnectedIntegrations` tool.** Copilot can enumerate the user's Slack workspaces and GitHub installations before writing a subscription, avoiding fabrication + publish-time round-trips.
- **Task 10 — delivery-id dedup + per-trigger execution rate cap.** Prevents silent event loss on waitUntil failure and unbounded fanout on chatty channels or busy monorepos.
- **Task 11 — hourly sanity check for trigger health.** Detects bot-removed-from-channel and installation-revoked out-of-band and marks `triggers.health_status`. Workflow editor's trigger-node inspector reads this (Task 8.2b).

**Copilot UX hardening (Task 6 prompt):**
- Enumerate integrations before subscribing.
- Warn users before renaming trigger nodes with webhook subscriptions and no `stableId`.
- Note subscription changes explicitly in assistant responses (they're high-consequence).
- `ignoreSelf` default `true` for GitHub; only override with explicit user consent.

**Explicit deferrals (documented as follow-ups):**
- Gmail and other integration event triggers.
- Cross-workflow subscription deduping at the plumbing layer (currently each workflow declares independently; dispatcher fires each match).
- Duplicate-fanout warnings on publish (workflow-owned trigger overlaps a pre-existing user-owned trigger for the same event).

**Types flow forward:**
- `subscription` union (Task 2) → consumed in Tasks 3, 5B, 5C, 6, 8.
- `ReconcilerOp` (Task 3) → consumed in Task 4.
- `stampTriggerLastFired` + `recordDelivery` + `checkTriggerExecutionRate` → consumed in Tasks 5B, 5C.
- `health_status` column (Tasks 1, 5D) → consumed in Task 8.2b + Task 11.
- No placeholder code — every step includes the exact change.
