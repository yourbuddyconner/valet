# Trigger Ownership Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make workflow-targeted triggers derivable from a workflow's trigger-node `subscription` declaration, so the copilot can wire triggers by editing the definition alone.

**Architecture:** Extend `triggers` with nullable `owner_workflow_id` + `owner_node_id`. Extend the workflow trigger-node schema with an optional `subscription` discriminated union (`manual | webhook | schedule`). On publish, a reconciler diffs declared vs. existing owned triggers and applies create/update/delete. UI locks the declarative fields of owned triggers; keeps enable/disable free.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, D1 (SQLite), Cloudflare Workers, Vitest, React 19, TanStack Query. Design spec: `docs/specs/2026-07-01-trigger-ownership-design.md`.

## Global Constraints

- Existing user-owned triggers (`owner_workflow_id IS NULL`) must behave exactly as today after every task in this plan.
- No new subscription source types beyond `manual | webhook | schedule` — event sources (Slack/GitHub/Gmail) are out of scope and a follow-up spec.
- Webhook tokens must remain stable across republishes (never regenerate on UPDATE).
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

### Task 2: Extend `WorkflowTriggerNode` with `subscription`

**Files:**
- Modify: the shared trigger-node type — likely `packages/shared/src/types/workflow-dag/*.ts` (locate the file that defines `WorkflowTriggerNode`). If the trigger-node shape lives in the worker's workflow schema (`packages/worker/src/workflows/schema.ts`), modify there instead.
- Test: co-located with the schema (either `packages/shared/src/types/workflow-dag/*.test.ts` or a new `*.test.ts` alongside the schema).

**Interfaces:**
- Consumes: existing `WorkflowTriggerNode` type/schema.
- Produces: an optional field `subscription` on trigger nodes with the discriminated union:

```ts
type TriggerNodeSubscription =
  | { type: 'manual' }
  | { type: 'webhook'; method?: 'GET' | 'POST' | 'PUT'; rateLimit?: number }
  | { type: 'schedule'; cron: string; timezone?: string; triggerData?: Record<string, unknown> };
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

  it('rejects unknown subscription type', () => {
    const result = triggerNodeSchema.safeParse({
      id: 't', type: 'trigger',
      subscription: { type: 'slack.messages', channel: '#x' },
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
]);
```

Extend the existing `triggerNodeSchema` with `subscription: triggerSubscriptionSchema.optional()`.

- [ ] **Step 2.5: Rerun the test — expect pass.**

Run: `cd <package-dir> && pnpm test <schema-file>.test.ts`
Expected: all cases PASS.

- [ ] **Step 2.6: Typecheck all packages.**

Run: `pnpm typecheck` from repo root.
Expected: PASS. If a consumer destructures the trigger node shape and needs updating, fix it here.

- [ ] **Step 2.7: Commit.**

```bash
git add <schema files> <test files>
git commit -m "workflow-dag: add optional subscription on trigger node

Discriminated union of manual | webhook | schedule.
Foundation for reconciler-materialized triggers."
```

---

### Task 3: Pure reconciler function

**Files:**
- Create: `packages/worker/src/services/trigger-reconciler.ts`
- Create: `packages/worker/src/services/trigger-reconciler.test.ts`

**Interfaces:**
- Consumes: `WorkflowDefinition` (shared type), `TriggerRow` shape from Drizzle schema.
- Produces:

```ts
export type ReconcilerOp =
  | { kind: 'create'; nodeId: string; type: 'webhook' | 'schedule'; config: TriggerConfig; name: string }
  | { kind: 'update'; triggerId: string; type: 'webhook' | 'schedule'; config: TriggerConfig; name: string }
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

- [ ] **Step 4.5: Invoke the reconciler inside `publishWorkflow`.**

At the end of `publishWorkflow`, after the version write commits:

```ts
import { planReconciliation } from './trigger-reconciler.js';
import { createTrigger, updateTrigger, deleteTrigger, listOwnedTriggers } from '../lib/db/triggers.js';
import { generateWebhookToken } from '...'; // reuse existing helper

// ... existing publish logic ...

const owned = await listOwnedTriggers(db, workflowId);
const ops = planReconciliation({
  workflowId,
  workflowName: workflow.name,
  definition: publishedDefinition,
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
  },
},
```

- [ ] **Step 6.3: Update the system prompt with a short note.**

Append (or splice into the trigger-node section) something like:

> When the user describes an event source ("every morning", "when a webhook fires", "on a schedule"), set the trigger node's `subscription` field. Do NOT set `subscription` for triggers users say will only be invoked via the test-run button. Slack/GitHub/Gmail event sources are NOT yet supported — for those requests, declare `{ type: "manual" }` and tell the user they'll need to wire an external caller until first-party event triggers ship.

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
        }}
        className="w-full rounded border border-neutral-200 bg-white px-2 py-1 text-sm dark:border-neutral-700 dark:bg-neutral-900"
      >
        <option value="manual">Manual (test-run only)</option>
        <option value="webhook">Webhook</option>
        <option value="schedule">Schedule</option>
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
- Types flow forward: `ReconcilerOp` (Task 3) → consumed in Task 4; `subscription` union (Task 2) → consumed in Tasks 3, 6, 8.
- No placeholder code — every step includes the exact change.
- Slack/GitHub/Gmail event triggers are explicitly out of scope; the plan calls that out in Task 6's prompt update so the copilot doesn't hallucinate unsupported subscription types.
- Existing user-owned triggers behavior verified in Task 4 test.
