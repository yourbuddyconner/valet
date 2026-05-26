# Workflow UI Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the execution detail page with a typed-step-cards timeline, and render workflow steps inline in the session chat — both surfaces consume `workflow_execution_steps` as the canonical workflow feed.

**Architecture:** Four phases. Phase A lands per-instance step identity (`iterationPath`) end-to-end through the runner engine, the live-event wire protocol, all three step-row upsert sites, the approval-wait/resume state, and retry replay. Phase B enriches per-step `outputJson` so typed renderers have stable data. Phase C builds the execution detail page UI behind `workflow_ui_execution_v2`. Phase D builds the session chat integration behind `workflow_ui_chat_cards`, including the small back-pointer columns on `messages` and the DO ownership validation. Backend (Phases A + B + part of D) ships un-flagged; UI ships flag-gated.

**Spec:** `docs/specs/2026-05-23-workflow-ui-design.md` at commit `be89175`.

**Tech Stack:** TypeScript, Cloudflare Workers + Hono, Drizzle ORM on D1 (SQLite), Bun runner, React 19, Vite 6, TanStack Router/Query, `@xyflow/react` (already in bundle).

**Two phases for UI behind feature flags:**
- `workflow_ui_execution_v2` — gates the execution detail page rewrite
- `workflow_ui_chat_cards` — gates the session chat workflow rendering

**Test conventions:**
- Runner / worker: `vitest`. Co-locate test files (`foo.ts` → `foo.test.ts`).
- DB-touching tests use the existing test harness with an ephemeral D1 instance.
- React components: visual + interaction verification in the browser (the project uses no React testing library); pure logic in hooks/helpers is unit-tested with vitest.
- Run all tests after each task with `pnpm test` from repo root.

**Commit conventions:**
- Project uses conventional commits (`feat(...)`, `fix(...)`, `refactor(...)`, `obs(...)`, `test(...)`, `docs(...)`).
- **Do NOT add `Co-Authored-By` trailers mentioning AI models** (per `CLAUDE.md`).
- Commit at the end of each task.

---

## File Structure

### New files (Phase A)
- `packages/worker/migrations/0017_workflow_step_iteration_path.sql`

### New files (Phase B)
- (none — Phase B is all in-place edits to handlers)

### New files (Phase C — execution page UI)
- `packages/client/src/lib/feature-flags.ts` — minimal flag system
- `packages/client/src/components/workflows/step-cards/icons.tsx`
- `packages/client/src/components/workflows/step-cards/fallback-card.tsx`
- `packages/client/src/components/workflows/step-cards/agent-prompt-card.tsx`
- `packages/client/src/components/workflows/step-cards/bash-card.tsx`
- `packages/client/src/components/workflows/step-cards/notify-card.tsx`
- `packages/client/src/components/workflows/step-cards/approval-card.tsx`
- `packages/client/src/components/workflows/step-cards/conditional-card.tsx`
- `packages/client/src/components/workflows/step-cards/loop-card.tsx`
- `packages/client/src/components/workflows/step-cards/parallel-card.tsx`
- `packages/client/src/components/workflows/step-cards/tool-card.tsx`
- `packages/client/src/components/workflows/step-cards/index.tsx`
- `packages/client/src/hooks/use-execution-timeline.ts`
- `packages/client/src/hooks/use-execution-timeline.test.ts`
- `packages/client/src/components/workflows/execution-timeline.tsx`
- `packages/client/src/components/workflows/execution-diagram-rail.tsx`
- `packages/client/src/lib/workflow-telemetry.ts`

### New files (Phase D — session chat)
- `packages/worker/migrations/0018_messages_workflow_backpointers.sql`
- `packages/client/src/components/workflows/workflow-context-bar.tsx`
- `packages/client/src/hooks/use-session-feed.ts`
- `packages/client/src/hooks/use-session-feed.test.ts`

### Modified files
- `packages/worker/src/lib/schema/workflows.ts` — add `iterationPath` (A)
- `packages/worker/src/lib/schema/messages.ts` (or wherever messages live) — add back-pointers (D)
- `packages/worker/src/lib/db/executions.ts` — `upsertExecutionStep` signature gains `iterationPath` (A)
- `packages/worker/src/services/executions.ts` — `upsertExecutionStepFromEvent` + admin path pass through (A); `outputJson` enrichment hooks (B)
- `packages/worker/src/services/session-workflows.ts` — finalize passes through (A)
- `packages/worker/src/durable-objects/workflow-executor.ts` — `waiting_approval` runtime state stores `{stepId, iterationPath, attempt}` (A)
- `packages/worker/src/durable-objects/session-agent.ts` — `workflow-chat-message` handler validates ownership + persists back-pointers (D)
- `packages/shared/src/types/runner-protocol.ts` — add `iterationPath` to step event (A); add back-pointer fields to `workflow-chat-message` (D)
- `packages/runner/src/workflow-engine.ts` — `ExecutionContext` gains `iterationPath`; loop/parallel/conditional executors push segments; `WorkflowStepResult` envelope; resume locates by (stepId, iterationPath, attempt) (A)
- `packages/runner/src/prompt.ts` — `agent_prompt` output enrichment (B); workflow-chat-message back-pointers (D)
- `packages/runner/src/agent-client.ts` — `sendWorkflowChatMessage` typed signature (D)
- `packages/client/src/api/executions.ts` — surface `iterationPath` on step row type (A)
- `packages/client/src/components/chat/tool-cards/tool-card-shell.tsx` — additive controlled-expansion + ARIA (C)
- `packages/client/src/routes/automation/executions/$executionId.tsx` — flag-gated swap (C)
- `packages/client/src/components/chat/chat-container.tsx` — flag-gated session-feed wiring + mount context bar (D)
- `packages/client/src/components/chat/message-list.tsx` — accept optional `workflowFeed` prop (D)
- `packages/client/src/durable-objects/message-store.ts` — DO-local SQLite schema + writeMessage + flush extension (D)

### Deleted files (after Phase C ships fully)
- `packages/client/src/components/workflows/execution-step-panel.tsx`
- `packages/client/src/components/workflows/execution-step-trace.tsx`
- `packages/client/src/components/workflows/execution-variables-panel.tsx`

---

# Phase A — Backend identity contract (iterationPath end-to-end)

**Goal:** Every step row, live step event, finalize envelope entry, approval-wait state, and retry replay carries a per-instance `iterationPath`. After Phase A, no Phase 1 UI work depends on missing data.

**Done when:** A workflow with a 3-iteration loop containing an `agent_prompt` step produces 3 distinct `workflow_execution_steps` rows (one per iteration) on both event-driven write and finalize. Retry-from-step targeting any iteration replays correctly.

---

### Task A1: Migration — add `iterationPath` to `workflow_execution_steps`

**Files:**
- Create: `packages/worker/migrations/0017_workflow_step_iteration_path.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- 0017_workflow_step_iteration_path.sql
-- Add per-instance step identity so loop iterations, parallel branches, and
-- conditional branches don't overwrite each other in workflow_execution_steps.

ALTER TABLE workflow_execution_steps
  ADD COLUMN iteration_path TEXT NOT NULL DEFAULT '';

-- Replace the existing unique index. The old key collapsed loop iterations.
DROP INDEX IF EXISTS idx_execution_steps_unique;

CREATE UNIQUE INDEX idx_execution_steps_unique
  ON workflow_execution_steps (execution_id, step_id, attempt, iteration_path);

-- Lookup index for the timeline read path (rows for one execution,
-- ordered by created time, optionally filtered by container prefix).
CREATE INDEX idx_workflow_execution_steps_iteration
  ON workflow_execution_steps (execution_id, iteration_path);
```

- [ ] **Step 2: Verify locally**

```bash
cd /Users/connerswann/code/valet
make db-reset
make db-migrate
```

Expected: no errors. `wrangler d1 execute` style output ending in `Successfully applied 17 migrations`.

- [ ] **Step 3: Commit**

```bash
git add packages/worker/migrations/0017_workflow_step_iteration_path.sql
git commit -m "feat(worker): migration 0017 — iteration_path on workflow_execution_steps"
```

---

### Task A2: Drizzle schema for `iterationPath`

**Files:**
- Modify: `packages/worker/src/lib/schema/workflows.ts`

- [ ] **Step 1: Update the table definition**

Find the `workflowExecutionSteps` definition and add `iterationPath`. Replace the unique index with the four-tuple, and add the new lookup index.

```typescript
export const workflowExecutionSteps = sqliteTable('workflow_execution_steps', {
  id: text().primaryKey(),
  executionId: text().notNull().references(() => workflowExecutions.id, { onDelete: 'cascade' }),
  stepId: text().notNull(),
  attempt: integer().notNull(),
  // Per-instance path identifier. Empty string for top-level steps.
  // See docs/specs/2026-05-23-workflow-ui-design.md.
  iterationPath: text().notNull().default(''),
  status: text().notNull(),
  inputJson: text(),
  outputJson: text(),
  error: text(),
  startedAt: text(),
  completedAt: text(),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_execution_steps_unique').on(
    table.executionId,
    table.stepId,
    table.attempt,
    table.iterationPath,
  ),
  index('idx_workflow_execution_steps_execution').on(table.executionId),
  index('idx_workflow_execution_steps_status').on(table.status),
  index('idx_workflow_execution_steps_iteration').on(table.executionId, table.iterationPath),
]);
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Expected: errors at `upsertExecutionStep` callsites that don't supply `iterationPath` — these get fixed in Tasks A7–A11. Type errors elsewhere should be zero.

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/lib/schema/workflows.ts
git commit -m "feat(worker): drizzle schema for workflow step iterationPath"
```

---

### Task A3: Helper to extend an `iterationPath`

**Files:**
- Create: `packages/runner/src/iteration-path.ts`
- Create: `packages/runner/src/iteration-path.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// packages/runner/src/iteration-path.test.ts
import { describe, it, expect } from 'vitest';
import { appendIterationSegment, parseIterationPath } from './iteration-path.js';

describe('appendIterationSegment', () => {
  it('returns the segment alone when the parent path is empty', () => {
    expect(appendIterationSegment('', 'loopA', 'i0')).toBe('loopA:i0');
  });

  it('joins segments with /', () => {
    expect(appendIterationSegment('parA:b1', 'loopA', 'i0')).toBe('parA:b1/loopA:i0');
  });

  it('rejects discriminators with slashes or colons', () => {
    expect(() => appendIterationSegment('', 'loopA', 'i:0')).toThrow();
    expect(() => appendIterationSegment('', 'loopA', 'i/0')).toThrow();
  });

  it('rejects step ids with slashes or colons', () => {
    expect(() => appendIterationSegment('', 'loop:A', 'i0')).toThrow();
  });
});

describe('parseIterationPath', () => {
  it('returns [] for empty', () => {
    expect(parseIterationPath('')).toEqual([]);
  });

  it('parses nested segments', () => {
    expect(parseIterationPath('parA:b1/loopA:i0')).toEqual([
      { containerStepId: 'parA', discriminator: 'b1' },
      { containerStepId: 'loopA', discriminator: 'i0' },
    ]);
  });
});
```

- [ ] **Step 2: Run tests, verify they fail**

```bash
cd /Users/connerswann/code/valet/packages/runner && pnpm test -- iteration-path
```

Expected: FAIL — `Cannot find module './iteration-path.js'`.

- [ ] **Step 3: Implement**

```typescript
// packages/runner/src/iteration-path.ts
/**
 * Per-instance step identity. See docs/specs/2026-05-23-workflow-ui-design.md.
 *
 * Path grammar: `/`-joined `<containerStepId>:<discriminator>` segments.
 * - Loop: `:i<index>`
 * - Parallel: `:b<branchIndex>`
 * - Conditional: `:then` or `:else`
 * Empty string for top-level steps.
 */

export interface IterationSegment {
  containerStepId: string;
  discriminator: string;
}

const ILLEGAL = /[/:]/;

export function appendIterationSegment(
  parent: string,
  containerStepId: string,
  discriminator: string,
): string {
  if (ILLEGAL.test(containerStepId)) {
    throw new Error(`iterationPath: containerStepId contains illegal char: ${containerStepId}`);
  }
  if (ILLEGAL.test(discriminator)) {
    throw new Error(`iterationPath: discriminator contains illegal char: ${discriminator}`);
  }
  const segment = `${containerStepId}:${discriminator}`;
  return parent ? `${parent}/${segment}` : segment;
}

export function parseIterationPath(path: string): IterationSegment[] {
  if (!path) return [];
  return path.split('/').map((seg) => {
    const idx = seg.indexOf(':');
    if (idx < 0) {
      throw new Error(`iterationPath: malformed segment: ${seg}`);
    }
    return { containerStepId: seg.slice(0, idx), discriminator: seg.slice(idx + 1) };
  });
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
cd /Users/connerswann/code/valet/packages/runner && pnpm test -- iteration-path
```

Expected: PASS, all four tests green.

- [ ] **Step 5: Commit**

```bash
git add packages/runner/src/iteration-path.ts packages/runner/src/iteration-path.test.ts
git commit -m "feat(runner): iterationPath helper for per-instance step identity"
```

---

### Task A4: Thread `iterationPath` through `ExecutionContext` and container executors

**Files:**
- Modify: `packages/runner/src/workflow-engine.ts`

- [ ] **Step 1: Extend the `ExecutionContext` type**

Find the type declaration around line 145 and add `iterationPath`:

```typescript
type ExecutionContext = {
  executionId: string;
  attempt: number;
  variables: Record<string, unknown>;
  outputs: Record<string, unknown>;
  steps: WorkflowStepResult[];
  maxSteps: number;
  visitedSteps: number;
  /** Per-instance path identity. Empty for top-level steps. */
  iterationPath: string;
  resume?: ResumeContext;
  hooks?: WorkflowExecutionHooks;
  replay?: ReplayContext;
  approvalNonce?: string;
};
```

- [ ] **Step 2: Initialize at the two top-level ctx-creation sites**

Around lines 934 and 1050 (`const context: ExecutionContext = {`), add `iterationPath: ''`.

- [ ] **Step 3: Push the loop segment**

Find the loop executor (around line 694, `if (step.type === 'loop') {`). In the per-iteration block where the loop sets `ctx.variables['loop'] = { item: items[i], index: i }`, build a child context that derives `iterationPath` from `ctx.iterationPath`:

```typescript
import { appendIterationSegment } from './iteration-path.js';
// ...

for (let i = 0; i < items.length; i++) {
  const savedLoop = ctx.variables['loop'];
  const savedPath = ctx.iterationPath;
  try {
    ctx.variables['loop'] = { item: items[i], index: i };
    ctx.iterationPath = appendIterationSegment(savedPath, step.id, `i${i}`);
    // ... existing per-iteration body
  } finally {
    ctx.variables['loop'] = savedLoop;
    ctx.iterationPath = savedPath;
  }
}
```

The existing loop body uses `ctx` directly — mutating + restoring is consistent with the surrounding code.

- [ ] **Step 4: Push the parallel branch segment**

Around line 796, the parallel executor creates a `branchCtx: ExecutionContext`. Extend the spread with `iterationPath`:

```typescript
const branchCtx: ExecutionContext = {
  ...ctx,
  variables: { ...ctx.variables },
  outputs: { ...ctx.outputs },
  steps: [],
  iterationPath: appendIterationSegment(ctx.iterationPath, step.id, `b${branchIndex}`),
};
```

- [ ] **Step 5: Push the conditional branch segment**

Around line 765 (`if (step.type === 'conditional') {`), the conditional executor walks into the `then` or `else` branch. Mirror the loop's mutate+restore pattern:

```typescript
const branchKey = condition ? 'then' : 'else';
const savedPath = ctx.iterationPath;
ctx.iterationPath = appendIterationSegment(savedPath, step.id, branchKey);
try {
  // ... existing branch execution
} finally {
  ctx.iterationPath = savedPath;
}
```

- [ ] **Step 6: Typecheck**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Expected: clean. New compile-time errors will appear at envelope construction (Task A6) and resume-match (Task A12), addressed there.

- [ ] **Step 7: Run existing workflow engine tests**

```bash
cd /Users/connerswann/code/valet/packages/runner && pnpm test -- workflow-engine
```

Expected: existing tests pass. (Engine semantics unchanged; we just added the field.)

- [ ] **Step 8: Commit**

```bash
git add packages/runner/src/workflow-engine.ts
git commit -m "feat(runner): ExecutionContext threads iterationPath through loop/parallel/conditional"
```

---

### Task A4.5: Thread `iterationPath` into `WorkflowStepExecutionContext`

**Files:**
- Modify: `packages/runner/src/workflow-engine.ts`

**Why:** The `onAgentStep` / `onToolStep` / `onNotifyStep` hooks receive a `WorkflowStepExecutionContext` (defined around line 101). The runner uses these hooks in `packages/runner/src/prompt.ts` to send workflow chat messages — Task D4 needs `iterationPath` in that context to attribute back-pointers correctly. Adding it here is a 4-line change; missing this is a hard-to-debug prerequisite for Phase D.

- [ ] **Step 1: Extend the hook context interface**

```typescript
export interface WorkflowStepExecutionContext {
  executionId: string;
  attempt: number;
  variables: Record<string, unknown>;
  outputs: Record<string, unknown>;
  /** Per-instance path identity. Empty for top-level steps. */
  iterationPath: string;
}
```

- [ ] **Step 2: Populate it at the one construction site**

Around line 336 (`const context: WorkflowStepExecutionContext = { ... }`):

```typescript
const context: WorkflowStepExecutionContext = {
  executionId: ctx.executionId,
  attempt: ctx.attempt,
  variables: ctx.variables,
  outputs: ctx.outputs,
  iterationPath: ctx.iterationPath,
};
```

- [ ] **Step 3: Typecheck + tests**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
cd /Users/connerswann/code/valet/packages/runner && pnpm test
```

Expected: clean and green.

- [ ] **Step 4: Commit**

```bash
git add packages/runner/src/workflow-engine.ts
git commit -m "feat(runner): WorkflowStepExecutionContext exposes iterationPath to hooks"
```

---

### Task A5: Add `iterationPath` to `WorkflowStepResult` envelope

**Files:**
- Modify: `packages/runner/src/workflow-engine.ts`

- [ ] **Step 1: Extend the interface**

Around line 55:

```typescript
export interface WorkflowStepResult {
  stepId: string;
  status: string;
  attempt: number;
  /** Per-instance path identity. Empty for top-level steps. */
  iterationPath: string;
  startedAt: string;
  completedAt?: string;
  input?: unknown;
  output?: unknown;
  error?: string;
}
```

- [ ] **Step 2: Populate it where step results are pushed onto `ctx.steps`**

Search the file for `ctx.steps.push(` and for `steps.push(`. At every push site, include `iterationPath: ctx.iterationPath`. There are roughly six push sites. Example:

```typescript
ctx.steps.push({
  stepId: step.id,
  status: result.status,
  attempt: ctx.attempt,
  iterationPath: ctx.iterationPath,
  startedAt: stepTs,
  completedAt: nowIso(),
  input: result.input,
  output: result.output,
  error: result.error,
});
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Expected: clean.

- [ ] **Step 4: Run workflow-engine tests**

```bash
cd /Users/connerswann/code/valet/packages/runner && pnpm test -- workflow-engine
```

Expected: existing tests pass.

- [ ] **Step 5: Commit**

```bash
git add packages/runner/src/workflow-engine.ts
git commit -m "feat(runner): WorkflowStepResult envelope carries iterationPath"
```

---

### Task A6: Add a regression test — loop iterations produce distinct envelope entries

**Files:**
- Modify: `packages/runner/src/workflow-engine.test.ts`

- [ ] **Step 1: Add the test**

Append to the existing test file:

```typescript
it('emits a distinct envelope entry per loop iteration with iterationPath', async () => {
  const workflow = compileForTest({
    steps: [
      {
        id: 'L1',
        type: 'loop',
        over: '{{ items }}',
        steps: [
          { id: 'inner', type: 'bash', command: 'echo {{ loop.index }}' },
        ],
      },
    ],
  });

  const envelope = await runWorkflowForTest(workflow, {
    variables: { items: ['a', 'b', 'c'] },
  });

  const innerSteps = envelope.steps.filter((s) => s.stepId === 'inner');
  expect(innerSteps).toHaveLength(3);
  expect(innerSteps.map((s) => s.iterationPath)).toEqual([
    'L1:i0',
    'L1:i1',
    'L1:i2',
  ]);
});
```

If `compileForTest` / `runWorkflowForTest` helpers don't exist with those exact names, mirror the pattern of the closest existing test in the file (look around line 122 — there's a working loop test you can pattern-match against).

- [ ] **Step 2: Run, verify pass**

```bash
cd /Users/connerswann/code/valet/packages/runner && pnpm test -- workflow-engine
```

Expected: new test passes; existing tests still pass.

- [ ] **Step 3: Commit**

```bash
git add packages/runner/src/workflow-engine.test.ts
git commit -m "test(runner): loop iterations produce distinct envelope entries"
```

---

### Task A7: `upsertExecutionStep` requires `iterationPath`

**Files:**
- Modify: `packages/worker/src/lib/db/executions.ts`

**Why required, not optional:** an `iterationPath?: string` defaulting to `''` would let any missed caller silently collapse loop iterations again — exactly the bug we're fixing. Required-with-no-default makes the compiler enforce that every callsite is updated.

- [ ] **Step 1: Update the function signature and SQL**

Find `upsertExecutionStep` around line 198. Add `iterationPath: string` (required) to the input type, and include it in the `INSERT` + `ON CONFLICT` clauses:

```typescript
export async function upsertExecutionStep(
  db: D1Database,
  executionId: string,
  step: {
    stepId: string;
    attempt: number;
    iterationPath: string;
    status: string;
    input?: string | null;
    output?: string | null;
    error?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
  },
): Promise<void> {
  const id = crypto.randomUUID();
  await db
    .prepare(
      `INSERT INTO workflow_execution_steps
         (id, execution_id, step_id, attempt, iteration_path, status,
          input_json, output_json, error, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(execution_id, step_id, attempt, iteration_path) DO UPDATE SET
         status = excluded.status,
         input_json = COALESCE(excluded.input_json, workflow_execution_steps.input_json),
         output_json = COALESCE(excluded.output_json, workflow_execution_steps.output_json),
         error = COALESCE(excluded.error, workflow_execution_steps.error),
         started_at = COALESCE(excluded.started_at, workflow_execution_steps.started_at),
         completed_at = COALESCE(excluded.completed_at, workflow_execution_steps.completed_at)`
    )
    .bind(
      id,
      executionId,
      step.stepId,
      step.attempt,
      step.iterationPath,
      step.status,
      step.input ?? null,
      step.output ?? null,
      step.error ?? null,
      step.startedAt ?? null,
      step.completedAt ?? null,
    )
    .run();
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Expected: red — every caller (3 sites) needs to be updated in A8/A9/A10. This is intentional; that's how we enforce the contract.

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/lib/db/executions.ts
git commit -m "feat(worker): upsertExecutionStep accepts iterationPath"
```

---

### Task A8: Worker step-event ingest threads `iterationPath`

**Files:**
- Modify: `packages/shared/src/types/runner-protocol.ts`
- Modify: `packages/worker/src/services/executions.ts`

- [ ] **Step 1: Add `iterationPath` to the step event type**

Find the `workflow.execution.step` payload type (likely a `step` sub-object). Add `iterationPath: string` to the event shape.

```typescript
// in the step event payload type
{
  // ... existing fields
  stepId: string;
  attempt: number;
  iterationPath: string; // NEW
  status: string;
  input?: unknown;
  output?: unknown;
  error?: string | null;
  // ...
}
```

- [ ] **Step 2: Forward through `upsertExecutionStepFromEvent`**

In `packages/worker/src/services/executions.ts` around line 455 (`upsertExecutionStepFromEvent`), pass `iterationPath` into `upsertExecutionStep`. Note: status comes from `event.kind` (existing pattern, around line 471 — e.g. `event.kind === 'step.completed' ? 'completed' : ...`), not directly from `ev.status`:

```typescript
await upsertExecutionStep(db, executionId, {
  stepId: ev.stepId,
  attempt: ev.attempt,
  iterationPath: ev.iterationPath ?? '',
  status: deriveStatusFromKind(event.kind), // existing helper / pattern in the file
  // ...
});
```

- [ ] **Step 3: Update the admin/test path**

Around line 231 of the same file (`upsertExecutionStep(env.DB, executionId, { ... })`), pass `iterationPath: step.iterationPath ?? ''` from the inbound step. (The admin path's inbound `step` may not have the field yet — pass `''` as default since admin/test rows are typically top-level.)

- [ ] **Step 4: Typecheck**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Expected: clean. If the inbound `step` type in the admin path doesn't have `iterationPath`, add it (default `''`).

- [ ] **Step 5: Commit**

```bash
git add packages/shared/src/types/runner-protocol.ts packages/worker/src/services/executions.ts
git commit -m "feat(worker): step-event ingest threads iterationPath"
```

---

### Task A9: Runner emits `iterationPath` on the step event

**Files:**
- Modify: `packages/runner/src/agent-client.ts` (or wherever step events get sent)

- [ ] **Step 1: Find the send site**

```bash
grep -n "workflow.execution.step\|workflowExecutionStep\|sendStepEvent" /Users/connerswann/code/valet/packages/runner/src/*.ts
```

- [ ] **Step 2: Include `iterationPath: result.iterationPath ?? ''` in the payload**

Whichever helper assembles the event from a step result, add the field. The event's TS type was extended in Task A8, so a missing field will be a compile error.

- [ ] **Step 3: Typecheck**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Expected: clean.

- [ ] **Step 4: Run runner tests**

```bash
cd /Users/connerswann/code/valet/packages/runner && pnpm test
```

Expected: pass.

- [ ] **Step 5: Commit**

```bash
git add packages/runner/src/
git commit -m "feat(runner): step event carries iterationPath"
```

---

### Task A10: Finalize-from-envelope passes `iterationPath` through

**Files:**
- Modify: `packages/worker/src/services/session-workflows.ts`

- [ ] **Step 1: Locate the upsert call**

Around line 1337–1349, there's the finalize loop:

```typescript
for (const step of envelope.steps) {
  // ...
  await upsertExecutionStep(envDB, executionId, {
    stepId: step.stepId,
    attempt,
    status: step.status,
    // ...
  });
}
```

- [ ] **Step 2: Pass `iterationPath`**

```typescript
await upsertExecutionStep(envDB, executionId, {
  stepId: step.stepId,
  attempt,
  iterationPath: step.iterationPath ?? '',
  status: step.status,
  input: step.input !== undefined ? JSON.stringify(step.input) : null,
  output: step.output !== undefined ? JSON.stringify(step.output) : null,
  error: step.error || null,
  startedAt: step.startedAt || null,
  completedAt: step.completedAt || null,
});
```

- [ ] **Step 3: Typecheck**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Expected: clean.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/services/session-workflows.ts
git commit -m "feat(worker): finalize envelope passes iterationPath into step rows"
```

---

### Task A11: API response surfaces `iterationPath`

**Files:**
- Modify: `packages/worker/src/lib/db/executions.ts` (or the file that reads step rows)
- Modify: `packages/client/src/api/executions.ts`

- [ ] **Step 1: Find the step-row read**

```bash
grep -n "getExecutionSteps\|workflow_execution_steps" /Users/connerswann/code/valet/packages/worker/src/lib/db/executions.ts
```

- [ ] **Step 2: Include `iteration_path` in the SELECT and the mapped row type**

In the worker DB module:

```typescript
// SELECT iteration_path AS iterationPath, ...
```

The mapper that turns rows into the API response shape gets a new `iterationPath: string` field on every step.

- [ ] **Step 3: Update the client API type**

In `packages/client/src/api/executions.ts`, add `iterationPath: string` to the `ExecutionStepTrace` interface (or whatever it's called).

- [ ] **Step 4: Typecheck**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Expected: clean.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/lib/db/executions.ts packages/client/src/api/executions.ts
git commit -m "feat(api): step rows expose iterationPath end-to-end"
```

---

### Task A12: Approval wait/resume identifies by `(stepId, iterationPath, attempt)`

**Files:**
- Modify: `packages/worker/src/durable-objects/workflow-executor.ts`
- Modify: `packages/runner/src/workflow-engine.ts`

- [ ] **Step 1: Find the waiting_approval state write**

```bash
grep -n "waiting_approval\|approvalNonce\|resumeToken" /Users/connerswann/code/valet/packages/worker/src/durable-objects/workflow-executor.ts | head -20
```

- [ ] **Step 2: Add a NEW `awaitingApproval` field on `RuntimeState`**

Today, `RuntimeState` (in `packages/worker/src/durable-objects/workflow-executor.ts` around line 38) does not have an `awaitingApproval` field — approval state today lives only on the execution row (`status === 'waiting_approval'` plus `resumeToken`), which loses the step identity. Add the field:

```typescript
interface RuntimeState {
  // ... existing fields ...
  /** Set while status='waiting_approval' so resume can match the exact step instance. */
  awaitingApproval?: {
    stepId: string;
    iterationPath: string;
    attempt: number;
  };
}
```

When transitioning to `waiting_approval`, populate it. On resume, read it back and pass to the runner's resume payload.

- [ ] **Step 3: Runner resume matches on the triple**

In `packages/runner/src/workflow-engine.ts`, find the resume-handling code (`ResumeContext` is referenced around line 145). Where it matches a resumed step, match on `(stepId, iterationPath, attempt)`, not just `stepId`. The `ResumeContext` shape should include those fields.

- [ ] **Step 4: Add a runner-side test**

Append to `packages/runner/src/workflow-engine.test.ts`:

```typescript
it('resumes an approval step inside a loop iteration by (stepId, iterationPath, attempt)', async () => {
  const workflow = compileForTest({
    steps: [
      {
        id: 'L1',
        type: 'loop',
        over: '{{ items }}',
        steps: [
          { id: 'gate', type: 'approval', message: 'ok?' },
          { id: 'after', type: 'bash', command: 'echo done' },
        ],
      },
    ],
  });

  // First pass: pause at gate during iteration 1 (index 1).
  // Build the appropriate ResumeContext with iterationPath = 'L1:i1'
  // and verify the resumed run picks up iteration 1's gate and continues.
  // Use the existing pattern in the file for setting up resume.

  const envelope = await runWorkflowForTest(workflow, {
    variables: { items: ['a', 'b'] },
    resume: { stepId: 'gate', iterationPath: 'L1:i1', attempt: 1, approve: true },
  });

  // After resume, both iterations' `after` steps should be present.
  const afterSteps = envelope.steps.filter((s) => s.stepId === 'after');
  expect(afterSteps.map((s) => s.iterationPath).sort()).toEqual(['L1:i0', 'L1:i1']);
});
```

- [ ] **Step 5: Run runner + worker tests**

```bash
cd /Users/connerswann/code/valet && pnpm test
```

Expected: PASS, including the new resume test.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/durable-objects/workflow-executor.ts packages/runner/src/workflow-engine.ts packages/runner/src/workflow-engine.test.ts
git commit -m "feat(workflows): approval resume identifies by (stepId, iterationPath, attempt)"
```

---

### Task A13: Retry-from-step preserves `iterationPath` for top-level targets

**Files:**
- Modify: `packages/worker/src/services/session-workflows.ts`
- Modify: `packages/runner/src/workflow-engine.ts`

**Scope decision:** Nested retry (targeting a step inside a loop iteration or parallel branch) is **out of scope for this design**. The current service at `session-workflows.ts:388` already rejects non-top-level targets, and we leave that rejection in place. This task only ensures that top-level retries don't regress when the replay seeds outputs from prior step rows.

The execution-page-level "retry" affordance (in `ExecutionHeader`) and any in-card retry button (added in Phase C) **always re-run the workflow from the top** — no "from here" semantics. This is a deliberate simplification.

- [ ] **Step 1: Replay context carries `iterationPath` on every prior step row**

Around `session-workflows.ts:423` (`retryExecutionFromStep`), the `replayStepResults` map is built from the prior execution's `workflow_execution_steps` rows. Include `iterationPath` on every row in the map. Top-level rows have `iterationPath: ''`; nested rows are passed through but never targeted.

- [ ] **Step 2: Runner replay lookup includes `iterationPath`**

In `packages/runner/src/workflow-engine.ts`, the replay-seed logic that hydrates `ctx.outputs` from prior step rows currently matches on `stepId` alone. Update the lookup to match on `(stepId, iterationPath)` so loop iterations' prior outputs don't clobber each other:

```typescript
// pseudocode for the replay seed:
function findPriorRow(stepId: string, iterationPath: string) {
  return replayStepResults.find(
    (r) => r.stepId === stepId && (r.iterationPath ?? '') === iterationPath,
  );
}
```

- [ ] **Step 3: Confirm the existing rejection of non-top-level targets stays**

Verify `session-workflows.ts:388` still rejects requests where the target step's `iterationPath !== ''`. Add a comment pointing to this design decision so a future reader doesn't accidentally enable it without doing the request-DTO + runtime-state work.

- [ ] **Step 4: Typecheck + tests**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck && pnpm test
```

Expected: clean and green. Existing top-level retry tests still pass; no new test for nested retry (it remains unsupported).

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/services/session-workflows.ts packages/runner/src/workflow-engine.ts
git commit -m "feat(workflows): top-level retry preserves iterationPath in replay seed (nested retry stays unsupported)"
```

---

### Task A14: Phase A integration check

- [ ] **Step 1: Deploy backend to dev**

```bash
cd /Users/connerswann/code/valet && ENVIRONMENT=dev make deploy-worker && ENVIRONMENT=dev make deploy-modal
```

Expected: deployments succeed.

- [ ] **Step 2: Run a 3-iteration loop workflow end-to-end against dev**

Either via the UI (manual trigger) or via the test-fire API. Workflow definition:

```yaml
name: phase-a-check
steps:
  - id: greet
    type: loop
    over: ["one", "two", "three"]
    steps:
      - id: inner
        type: bash
        command: 'echo {{ loop.item }}'
```

- [ ] **Step 3: Verify in D1**

```bash
# Query the deployed dev D1 directly via wrangler
wrangler d1 execute valet-dev --remote --command \
  "SELECT step_id, iteration_path, status FROM workflow_execution_steps \
   WHERE execution_id = '<the-id>' ORDER BY created_at"
```

Expected: 3 rows for `step_id='inner'` with `iteration_path` values `L1:i0`, `L1:i1`, `L1:i2`. (Adjust loop step id to match the test workflow.)

If any iteration is missing, halt and investigate before continuing. Almost certainly an upsert site that wasn't updated.

- [ ] **Step 4: No commit** — this is a verification checkpoint.

---

# Phase B — Backend output enrichment

**Goal:** Each step type writes its `outputJson` in a stable shape so typed renderers in Phase C don't have to guess. All changes are additive; the fallback renderer continues to work on rows from before this phase.

---

### Task B1: `agent_prompt` output shape `{response, model, inputTokens, outputTokens, durationMs}`

**Files:**
- Modify: `packages/runner/src/prompt.ts`

- [ ] **Step 1: Find the agent_prompt output assembly**

```bash
grep -n "agent_prompt\|onAgentStep\|output:" /Users/connerswann/code/valet/packages/runner/src/prompt.ts | head -30
```

The `onAgentStep` hook returns a `WorkflowStepExecutionResult` with an `output` field. Find where the response is collected — around lines 1525–1538 in `prompt.ts` (`return { status: "completed", output: ... }`).

- [ ] **Step 2: Locate model + token metadata sources**

The `Channel` class (defined around line 481 in the same file) tracks usage per agent call:

- `channel.usageEntries: Map<string, { model: string; inputTokens: number; outputTokens: number }>` — keyed by OpenCode message id; entries are appended for each request.
- `channel.lastUsedModel: string | null` — the model id of the most recent call.

For a single `agent_prompt` step, snapshot these *before* the agent runs, then diff *after*:

```typescript
// Before the agent runs (just before this.runAgent(...) or equivalent):
const usageBefore = new Map(channel.usageEntries);
const stepStartMs = Date.now();

// ...agent runs...

// After the response is recovered, before returning the output:
let inputTokens = 0;
let outputTokens = 0;
for (const [msgId, entry] of channel.usageEntries) {
  if (!usageBefore.has(msgId)) {
    inputTokens += entry.inputTokens;
    outputTokens += entry.outputTokens;
  }
}
const model = channel.lastUsedModel ?? null;
const durationMs = Date.now() - stepStartMs;
```

- [ ] **Step 3: Shape the output at both return sites**

Around line 1525–1527 (`return { status: "completed", output: parseResult.value }`):

```typescript
return {
  status: "completed",
  output: {
    response: parseResult.value,
    model,
    inputTokens,
    outputTokens,
    durationMs,
  },
};
```

Around line 1534–1537 (`return { status: "completed", output: recoveredResponse }`):

```typescript
return {
  status: "completed",
  output: {
    response: recoveredResponse,
    model,
    inputTokens,
    outputTokens,
    durationMs,
  },
};
```

- [ ] **Step 4: Add an automated regression test against `prompt.ts` directly**

Engine-level passthrough tests (mocking `onAgentStep`) don't prove `prompt.ts` actually enriches the output. Required: create `packages/runner/src/prompt.test.ts` if it doesn't exist, and add a test that exercises the real `prompt.ts` `onAgentStep` path with a stubbed `agent.run` returning a known response and synthesized `usageEntries`. Assert the returned step output has all five fields populated.

If the agent-runner construction is hard to fake, extract the output-assembly into a small pure helper (e.g. `assembleAgentPromptOutput(channel, stepStartMs, usageBefore, response)`) and test that helper directly — `prompt.ts` then calls the helper. This keeps the verification under unit-test control. No manual-smoke-only fallback — the contract is exact and a wrong shape silently breaks the agent_prompt card.

- [ ] **Step 5: Run tests**

```bash
cd /Users/connerswann/code/valet/packages/runner && pnpm test
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/runner/src/prompt.ts
git commit -m "feat(runner): agent_prompt output is { response, model, tokens, durationMs }"
```

---

### Task B2: `notify` output adds `error` (orchestrator-only for v1)

**Files:**
- Modify: `packages/runner/src/prompt.ts` (notify handler, around line 1255) — and/or `packages/runner/src/workflow-engine.ts:374` if a stub still lives there

**Scope decision:** `notify` today only supports the `orchestrator` target. Channel routing (slack/telegram/etc.) is **out of scope** for this design and tracked separately. The renderer in Phase C only needs to surface success/failure for the orchestrator target — no `channelType`/`channelId` parsing. This keeps the renderer honest about what actually exists.

- [ ] **Step 1: Find the notify result construction**

Currently:
```typescript
{ type: 'notify', target: typeof step.target === 'string' ? step.target : 'orchestrator', delivered: false }
```

- [ ] **Step 2: Shape the output**

```typescript
{
  type: 'notify',
  target: typeof step.target === 'string' ? step.target : 'orchestrator',
  delivered, // true if the orchestrator notify succeeded
  error: deliveryError ?? null,
}
```

If `delivered` and `deliveryError` aren't already tracked at this site, the notify handler in `prompt.ts:1255` is where the actual dispatch happens — capture success/failure there and surface them.

- [ ] **Step 3: Run + commit**

```bash
cd /Users/connerswann/code/valet/packages/runner && pnpm test
git add packages/runner/src/
git commit -m "feat(runner): notify output exposes delivered + error (orchestrator-only)"
```

---

### Task B3: `approval` output adds `{ decision, decidedAt }`

**Files:**
- Modify: `packages/runner/src/workflow-engine.ts` (around line 628)

- [ ] **Step 1: Find the approval step's result**

When the approval step completes (after resume), it currently sets a status with no structured `output`. Add:

```typescript
output: {
  decision: approve ? 'approved' : 'denied',
  decidedAt: nowIso(),
}
```

For the timeout path (if it exists in code today), set:

```typescript
output: { decision: 'timed_out', decidedAt: nowIso() }
```

- [ ] **Step 2: Run tests**

```bash
cd /Users/connerswann/code/valet/packages/runner && pnpm test
```

Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/runner/src/workflow-engine.ts
git commit -m "feat(runner): approval output exposes { decision, decidedAt }"
```

---

### Task B4: `bash` output type-lock + regression test

**Files:**
- Modify: `packages/runner/src/workflow-engine.ts`

- [ ] **Step 1: Define a typed interface**

Near the top of the file (or in a `types.ts` if there is one):

```typescript
export interface BashStepOutput {
  stdout: string;
  stderr: string;
  exitCode: number;
}
```

Annotate the bash output construction to use it (TypeScript will catch any shape drift).

- [ ] **Step 2: Add a test**

```typescript
it('bash output shape is { stdout, stderr, exitCode }', async () => {
  const workflow = compileForTest({
    steps: [{ id: 'b', type: 'bash', command: 'echo hi' }],
  });
  const envelope = await runWorkflowForTest(workflow);
  const step = envelope.steps.find((s) => s.stepId === 'b');
  expect(step?.output).toMatchObject({
    stdout: expect.any(String),
    stderr: expect.any(String),
    exitCode: expect.any(Number),
  });
});
```

- [ ] **Step 3: Run + commit**

```bash
cd /Users/connerswann/code/valet/packages/runner && pnpm test
git add packages/runner/src/workflow-engine.ts packages/runner/src/workflow-engine.test.ts
git commit -m "test(runner): bash output shape regression"
```

---

# Phase C — Execution detail page UI

**Goal:** Replace `routes/automation/executions/$executionId.tsx` with the timeline-of-typed-cards + diagram-rail layout, behind feature flag `workflow_ui_execution_v2`. After Phase C is fully rolled out, the legacy components are deleted.

---

### Task C1: Minimal feature-flag system

**Files:**
- Create: `packages/client/src/lib/feature-flags.ts`
- Create: `packages/client/src/lib/feature-flags.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// packages/client/src/lib/feature-flags.test.ts
import { describe, it, expect, beforeEach } from 'vitest';
import { isFlagEnabled, FLAG_NAMES } from './feature-flags.js';

describe('isFlagEnabled', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it('returns false by default for unknown flags', () => {
    expect(isFlagEnabled('does_not_exist')).toBe(false);
  });

  it('returns true when localStorage override is "on"', () => {
    localStorage.setItem('flag:workflow_ui_execution_v2', 'on');
    expect(isFlagEnabled('workflow_ui_execution_v2')).toBe(true);
  });

  it('returns false when localStorage override is "off"', () => {
    localStorage.setItem('flag:workflow_ui_execution_v2', 'off');
    expect(isFlagEnabled('workflow_ui_execution_v2')).toBe(false);
  });

  it('exposes the canonical flag list', () => {
    expect(FLAG_NAMES).toContain('workflow_ui_execution_v2');
    expect(FLAG_NAMES).toContain('workflow_ui_chat_cards');
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// packages/client/src/lib/feature-flags.ts
/**
 * Tiny client-side feature flag system. Defaults from a baseline map; can be
 * overridden per-user via localStorage (`flag:<name> = on|off`) for dogfood.
 *
 * Replace with a real flag provider when one is available.
 */

export const FLAG_NAMES = [
  'workflow_ui_execution_v2',
  'workflow_ui_chat_cards',
] as const;

export type FlagName = (typeof FLAG_NAMES)[number] | string;

const DEFAULTS: Record<string, boolean> = {
  workflow_ui_execution_v2: false,
  workflow_ui_chat_cards: false,
};

export function isFlagEnabled(name: FlagName): boolean {
  if (typeof localStorage !== 'undefined') {
    const override = localStorage.getItem(`flag:${name}`);
    if (override === 'on') return true;
    if (override === 'off') return false;
  }
  return DEFAULTS[name] ?? false;
}

export function useFeatureFlag(name: FlagName): boolean {
  // localStorage reads are cheap; no re-subscription. Components that need
  // live toggling can call setFlag() and force a remount themselves.
  return isFlagEnabled(name);
}

export function setFlag(name: FlagName, value: boolean | null): void {
  if (typeof localStorage === 'undefined') return;
  if (value === null) {
    localStorage.removeItem(`flag:${name}`);
  } else {
    localStorage.setItem(`flag:${name}`, value ? 'on' : 'off');
  }
}
```

- [ ] **Step 3: Run tests**

```bash
cd /Users/connerswann/code/valet && pnpm vitest run packages/client/src/lib/feature-flags.test.ts
```

Expected: PASS, all four tests.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/lib/feature-flags.ts packages/client/src/lib/feature-flags.test.ts
git commit -m "feat(client): minimal feature flag system with localStorage overrides"
```

---

### Task C2: `ToolCardShell` additive controlled-expansion + ARIA

**Files:**
- Modify: `packages/client/src/components/chat/tool-cards/tool-card-shell.tsx`

- [ ] **Step 1: Extend props**

Add optional `open`, `onOpenChange`, `id`, and `headerRef` props. Always emit `aria-expanded`. Behavior:

- If `open` is provided, the card is controlled — internal state ignored; clicks call `onOpenChange(!open)`.
- If `id` is provided, header button has `aria-controls={id + "-body"}` and the body div has that id.
- If `headerRef` is provided, it's forwarded to the header button.
- `aria-expanded` reflects either the controlled `open` or the internal state.

```typescript
interface ToolCardShellProps {
  icon: ReactNode;
  label: string;
  status: ToolCallStatus;
  summary?: ReactNode;
  children?: ReactNode;
  defaultExpanded?: boolean;
  accentClass?: string;
  expandable?: boolean;
  onToggle?: () => void;
  // NEW:
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
  id?: string;
  headerRef?: Ref<HTMLButtonElement>;
}
```

In the component body, derive `effectiveOpen = open ?? internalExpanded`, and call `onOpenChange?.(!effectiveOpen)` from the click handler in addition to (or instead of) `setExpanded`.

Header button:

```typescript
<button
  ref={headerRef}
  type="button"
  aria-expanded={effectiveOpen}
  {...(id ? { 'aria-controls': `${id}-body` } : {})}
  onClick={() => {
    if (!isExpandable) return;
    if (open === undefined && hasContent) {
      setExpanded(!internalExpanded);
    }
    onOpenChange?.(!effectiveOpen);
    onToggle?.();
  }}
  // ... rest
>
```

Body div:

```typescript
{effectiveOpen && children && (
  <div {...(id ? { id: `${id}-body` } : {})} className="border-t border-neutral-100 dark:border-neutral-800">
    {children}
  </div>
)}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Expected: clean. Existing callers don't pass the new props; behavior is unchanged.

- [ ] **Step 3: Verify the existing tool cards in browser**

```bash
cd /Users/connerswann/code/valet && make dev-worker &
cd /Users/connerswann/code/valet/packages/client && pnpm dev &
```

Open a session with a recent tool call. Click a tool card. Expand/collapse should still work. Inspect the header `<button>` in devtools — `aria-expanded` should be present.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/chat/tool-cards/tool-card-shell.tsx
git commit -m "feat(client): ToolCardShell — additive controlled-expansion + aria-expanded"
```

---

### Task C3: `step-cards/icons.tsx`

**Files:**
- Create: `packages/client/src/components/workflows/step-cards/icons.tsx`

- [ ] **Step 1: Create the icon registry**

Use `lucide-react` (already in the project — see `chat/tool-cards/icons.tsx` for the pattern).

```typescript
// packages/client/src/components/workflows/step-cards/icons.tsx
import {
  Sparkles,    // agent_prompt
  Terminal,    // bash
  Bell,        // notify
  CheckSquare, // approval
  GitBranch,   // conditional
  RotateCw,    // loop
  Split,       // parallel
  Wrench,      // tool
  FileQuestion, // fallback
} from 'lucide-react';

export const STEP_ICONS = {
  agent_prompt: Sparkles,
  bash: Terminal,
  notify: Bell,
  approval: CheckSquare,
  conditional: GitBranch,
  loop: RotateCw,
  parallel: Split,
  tool: Wrench,
  fallback: FileQuestion,
} as const;

export type StepKindWithIcon = keyof typeof STEP_ICONS;

export function StepIcon({ kind }: { kind: string }) {
  const Icon = (STEP_ICONS as Record<string, typeof Sparkles>)[kind] ?? STEP_ICONS.fallback;
  return <Icon className="h-3.5 w-3.5" aria-hidden="true" />;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/components/workflows/step-cards/icons.tsx
git commit -m "feat(client): step-cards icon registry"
```

---

### Task C4: `step-cards/fallback-card.tsx`

**Files:**
- Create: `packages/client/src/components/workflows/step-cards/fallback-card.tsx`

**Reminder on data shape:** `ExecutionStepTrace` (in `packages/client/src/api/executions.ts:46`) exposes `input: unknown | null` and `output: unknown | null` — already parsed, not raw JSON strings. All cards read these directly; no `JSON.parse()` helpers.

- [ ] **Step 1: Implement**

```typescript
// packages/client/src/components/workflows/step-cards/fallback-card.tsx
import { ToolCardShell, ToolCardSection, ToolCodeBlock } from '@/components/chat/tool-cards/tool-card-shell';
import { StepIcon } from './icons';
import type { WorkflowStepCardProps } from './index';

export function FallbackCard({ step, open, onOpenChange, stepType }: WorkflowStepCardProps) {
  const summary = `${step.stepId} · ${stepType}`;
  const status = mapStatus(step.status);
  const output = step.output != null
    ? typeof step.output === 'string' ? step.output : JSON.stringify(step.output, null, 2)
    : null;

  return (
    <ToolCardShell
      icon={<StepIcon kind="fallback" />}
      label={stepType}
      status={status}
      summary={summary}
      open={open}
      onOpenChange={onOpenChange}
      id={`step-${step.stepId}-${step.iterationPath}`}
    >
      {output && (
        <ToolCardSection label="output">
          <ToolCodeBlock>{output}</ToolCodeBlock>
        </ToolCardSection>
      )}
      {step.error && (
        <ToolCardSection label="error">
          <ToolCodeBlock>{step.error}</ToolCodeBlock>
        </ToolCardSection>
      )}
    </ToolCardShell>
  );
}

function mapStatus(status: string): 'pending' | 'running' | 'completed' | 'error' {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'running' || status === 'waiting_approval') return 'running';
  return 'pending';
}
```

`WorkflowStepCardProps` is defined in Task C13 — define a stub in `index.tsx` first as part of this task. Note `stepType` is part of the props (the dispatcher resolves it once):

```typescript
// packages/client/src/components/workflows/step-cards/index.tsx (stub for now)
import type { ExecutionStepTrace } from '@/api/executions';

export interface WorkflowStepCardProps {
  step: ExecutionStepTrace;
  /** Resolved by the dispatcher from the workflow def + step.input.type. */
  stepType: string;
  /** Container child rows if this is a loop/parallel/conditional. */
  children?: ExecutionStepTrace[];
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
  workflowDef?: unknown; // tightened in C13
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/components/workflows/step-cards/
git commit -m "feat(client): step-cards fallback card + props stub"
```

---

### Task C5: `step-cards/agent-prompt-card.tsx`

**Files:**
- Create: `packages/client/src/components/workflows/step-cards/agent-prompt-card.tsx`

- [ ] **Step 1: Implement**

```typescript
// packages/client/src/components/workflows/step-cards/agent-prompt-card.tsx
import { useEffect, useState } from 'react';
import { ToolCardShell, ToolCardSection } from '@/components/chat/tool-cards/tool-card-shell';
import { DeferredMarkdownContent } from '@/components/chat/markdown/deferred-markdown-content';
import { StepIcon } from './icons';
import type { WorkflowStepCardProps } from './index';

interface AgentPromptOutput {
  response: unknown;
  model?: string;
  inputTokens?: number;
  outputTokens?: number;
  durationMs?: number;
}

export function AgentPromptCard({ step, open, onOpenChange }: WorkflowStepCardProps) {
  const input = step.input as Record<string, unknown> | null;
  const output = step.output as AgentPromptOutput | null;
  const persona = typeof input?.persona === 'string' ? input.persona : undefined;
  const promptText = pickString(input, ['prompt', 'content', 'message', 'goal']) ?? '';

  const status = mapStatus(step.status);
  const isRunning = status === 'running' || status === 'pending';

  const elapsed = useElapsed(step.startedAt, !isRunning);
  const meta = formatMeta(step, output, elapsed);

  return (
    <ToolCardShell
      icon={<StepIcon kind="agent_prompt" />}
      label="agent_prompt"
      status={status}
      summary={summaryLine(step, persona, output)}
      open={open}
      onOpenChange={onOpenChange}
      id={`step-${step.stepId}-${step.iterationPath}`}
      defaultExpanded={status === 'error'}
    >
      <ToolCardSection label={`prompt${persona ? ` · ${persona}` : ''}`}>
        <p className="font-mono text-[11px] italic text-neutral-500 dark:text-neutral-400 whitespace-pre-wrap">
          {promptText || <em>(no prompt)</em>}
        </p>
      </ToolCardSection>

      <ToolCardSection label={`response · ${meta}`}>
        {renderResponse(output, status, step.error)}
      </ToolCardSection>
    </ToolCardShell>
  );
}

function renderResponse(
  output: AgentPromptOutput | null,
  status: 'pending' | 'running' | 'completed' | 'error',
  error?: string,
) {
  if (status === 'pending' || status === 'running') {
    return <p className="font-mono text-[11px] text-neutral-500">…</p>;
  }
  if (status === 'error') {
    return (
      <p className="font-mono text-[11px] text-red-600 dark:text-red-400 whitespace-pre-wrap">
        {error || 'Step failed without an error message.'}
      </p>
    );
  }
  if (!output) return <p className="font-mono text-[11px] text-neutral-500">(no response)</p>;

  const r = output.response;
  if (r && typeof r === 'object' && !Array.isArray(r)) {
    // Structured response — render as kv table.
    return (
      <dl className="grid grid-cols-[max-content_1fr] gap-x-3 gap-y-1 font-mono text-[11px]">
        {Object.entries(r as Record<string, unknown>).map(([k, v]) => (
          <div key={k} className="contents">
            <dt className="text-neutral-500 dark:text-neutral-400">{k}</dt>
            <dd className="text-neutral-700 dark:text-neutral-300 break-words whitespace-pre-wrap">
              {typeof v === 'string' ? v : JSON.stringify(v)}
            </dd>
          </div>
        ))}
      </dl>
    );
  }
  if (typeof r === 'string') {
    return <DeferredMarkdownContent content={r} />;
  }
  return <p className="font-mono text-[11px]">{JSON.stringify(r)}</p>;
}

function summaryLine(
  step: { iterationPath: string },
  persona: string | undefined,
  output: AgentPromptOutput | null,
): string {
  const iter = parseIterFromPath(step.iterationPath);
  const parts: string[] = [];
  if (persona) parts.push(persona);
  if (iter) parts.push(iter);
  if (output?.response && typeof output.response === 'object') {
    const k = Object.keys(output.response as object);
    if (k.length) parts.push(`{${k.slice(0, 3).join(', ')}${k.length > 3 ? ', …' : ''}}`);
  } else if (typeof output?.response === 'string') {
    const preview = output.response.slice(0, 60).replace(/\s+/g, ' ');
    parts.push(`"${preview}${output.response.length > 60 ? '…' : ''}"`);
  }
  return parts.join(' · ');
}

function formatMeta(
  step: { startedAt: string | null; completedAt: string | null },
  output: AgentPromptOutput | null,
  elapsedMs: number,
): string {
  const dur = step.completedAt && step.startedAt
    ? new Date(step.completedAt).getTime() - new Date(step.startedAt).getTime()
    : elapsedMs;
  const tokenStr = output?.inputTokens != null && output?.outputTokens != null
    ? ` · ${output.inputTokens}↓ ${output.outputTokens}↑`
    : '';
  const modelStr = output?.model ? ` · ${output.model}` : '';
  return `${dur}ms${modelStr}${tokenStr}`;
}

function parseIterFromPath(path: string): string | null {
  if (!path) return null;
  const last = path.split('/').pop()!;
  const idx = last.indexOf(':');
  if (idx < 0) return null;
  const disc = last.slice(idx + 1);
  if (disc.startsWith('i')) return `iter ${Number(disc.slice(1)) + 1}`;
  if (disc.startsWith('b')) return `branch ${Number(disc.slice(1)) + 1}`;
  if (disc === 'then' || disc === 'else') return disc;
  return null;
}

function useElapsed(startedAt: string | null, paused: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (paused || !startedAt) return;
    const handle = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(handle);
  }, [paused, startedAt]);
  if (!startedAt) return 0;
  return Math.max(0, now - new Date(startedAt).getTime());
}

function pickString(obj: Record<string, unknown> | null, keys: string[]): string | undefined {
  if (!obj) return undefined;
  for (const k of keys) {
    if (typeof obj[k] === 'string') return obj[k] as string;
  }
  return undefined;
}

function mapStatus(status: string): 'pending' | 'running' | 'completed' | 'error' {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'running' || status === 'waiting_approval') return 'running';
  return 'pending';
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Expected: clean. (The component isn't wired up yet; visual check waits for Task C18.)

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/components/workflows/step-cards/agent-prompt-card.tsx
git commit -m "feat(client): step-cards agent_prompt renderer"
```

---

### Task C6: `step-cards/bash-card.tsx`

**Files:**
- Create: `packages/client/src/components/workflows/step-cards/bash-card.tsx`

- [ ] **Step 1: Implement**

```typescript
// packages/client/src/components/workflows/step-cards/bash-card.tsx
import { ToolCardShell, ToolCardSection, ToolCodeBlock } from '@/components/chat/tool-cards/tool-card-shell';
import { StepIcon } from './icons';
import type { WorkflowStepCardProps } from './index';

interface BashInput { command?: string; }
interface BashOutput { stdout?: string; stderr?: string; exitCode?: number; }

export function BashCard({ step, open, onOpenChange }: WorkflowStepCardProps) {
  const input = step.input as BashInput | null;
  const output = step.output as BashOutput | null;
  const exit = output?.exitCode ?? null;
  const status = mapStatus(step.status, exit);

  return (
    <ToolCardShell
      icon={<StepIcon kind="bash" />}
      label="bash"
      status={status}
      summary={`${step.stepId} · ${(input?.command ?? '').slice(0, 60)}${exit !== null ? ` → exit ${exit}` : ''}`}
      open={open}
      onOpenChange={onOpenChange}
      id={`step-${step.stepId}-${step.iterationPath}`}
      defaultExpanded={status === 'error'}
    >
      {input?.command && (
        <ToolCardSection label="command">
          <ToolCodeBlock>{input.command}</ToolCodeBlock>
        </ToolCardSection>
      )}
      {output?.stdout && (
        <ToolCardSection label="stdout">
          <ToolCodeBlock>{output.stdout}</ToolCodeBlock>
        </ToolCardSection>
      )}
      {output?.stderr && (
        <ToolCardSection label="stderr">
          <ToolCodeBlock>{output.stderr}</ToolCodeBlock>
        </ToolCardSection>
      )}
      {step.error && (
        <ToolCardSection label="error">
          <ToolCodeBlock>{step.error}</ToolCodeBlock>
        </ToolCardSection>
      )}
    </ToolCardShell>
  );
}

function mapStatus(status: string, exit: number | null): 'pending' | 'running' | 'completed' | 'error' {
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'completed') return exit !== null && exit !== 0 ? 'error' : 'completed';
  if (status === 'running') return 'running';
  return 'pending';
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
git add packages/client/src/components/workflows/step-cards/bash-card.tsx
git commit -m "feat(client): step-cards bash renderer"
```

---

### Task C7: `step-cards/notify-card.tsx`

**Files:**
- Create: `packages/client/src/components/workflows/step-cards/notify-card.tsx`

- [ ] **Step 1: Implement**

```typescript
// packages/client/src/components/workflows/step-cards/notify-card.tsx
import { ToolCardShell, ToolCardSection, ToolCodeBlock } from '@/components/chat/tool-cards/tool-card-shell';
import { StepIcon } from './icons';
import type { WorkflowStepCardProps } from './index';

// v1: notify only supports the orchestrator target. Channel routing is
// out of scope — see Phase B Task B2.
interface NotifyOutput {
  target?: string;
  delivered?: boolean;
  error?: string | null;
}

export function NotifyCard({ step, open, onOpenChange }: WorkflowStepCardProps) {
  const output = step.output as NotifyOutput | null;
  const status = mapStatus(step.status);
  const target = output?.target ?? 'orchestrator';
  const state = output?.delivered ? 'delivered' : output?.error ? 'failed' : 'pending';

  return (
    <ToolCardShell
      icon={<StepIcon kind="notify" />}
      label="notify"
      status={status}
      summary={`${step.stepId} · ${target} · ${state}`}
      open={open}
      onOpenChange={onOpenChange}
      id={`step-${step.stepId}-${step.iterationPath}`}
      defaultExpanded={status === 'error'}
    >
      <ToolCardSection label="target">
        <p className="font-mono text-[11px] text-neutral-700 dark:text-neutral-300">{target}</p>
      </ToolCardSection>
      {output?.error && (
        <ToolCardSection label="error">
          <ToolCodeBlock>{output.error}</ToolCodeBlock>
        </ToolCardSection>
      )}
      {step.error && (
        <ToolCardSection label="step error">
          <ToolCodeBlock>{step.error}</ToolCodeBlock>
        </ToolCardSection>
      )}
    </ToolCardShell>
  );
}

function mapStatus(status: string): 'pending' | 'running' | 'completed' | 'error' {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'running') return 'running';
  return 'pending';
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
git add packages/client/src/components/workflows/step-cards/notify-card.tsx
git commit -m "feat(client): step-cards notify renderer"
```

---

### Task C8: `step-cards/approval-card.tsx`

**Files:**
- Create: `packages/client/src/components/workflows/step-cards/approval-card.tsx`

- [ ] **Step 1: Implement**

```typescript
// packages/client/src/components/workflows/step-cards/approval-card.tsx
import { ToolCardShell, ToolCardSection } from '@/components/chat/tool-cards/tool-card-shell';
import { StepIcon } from './icons';
import type { WorkflowStepCardProps } from './index';

interface ApprovalOutput {
  decision?: 'approved' | 'denied' | 'timed_out';
  decidedAt?: string;
}

export function ApprovalCard({ step, open, onOpenChange }: WorkflowStepCardProps) {
  const output = step.output as ApprovalOutput | null;
  const decision = output?.decision;
  const status = mapStatus(step.status, decision);
  const summary = decision
    ? `${step.stepId} · ${decision}`
    : `${step.stepId} · awaiting approval`;

  return (
    <ToolCardShell
      icon={<StepIcon kind="approval" />}
      label="approval"
      status={status}
      summary={summary}
      open={open}
      onOpenChange={onOpenChange}
      id={`step-${step.stepId}-${step.iterationPath}`}
      defaultExpanded={status === 'error' || status === 'running'}
    >
      <ToolCardSection label="decision">
        <p className="font-mono text-[11px] text-neutral-700 dark:text-neutral-300">
          {decision ?? 'pending'}
          {output?.decidedAt && <span className="text-neutral-500"> · {output.decidedAt}</span>}
        </p>
      </ToolCardSection>
    </ToolCardShell>
  );
}

function mapStatus(
  status: string,
  decision: ApprovalOutput['decision'],
): 'pending' | 'running' | 'completed' | 'error' {
  if (status === 'waiting_approval') return 'running';
  if (decision === 'denied' || decision === 'timed_out') return 'error';
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'error';
  return 'pending';
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
git add packages/client/src/components/workflows/step-cards/approval-card.tsx
git commit -m "feat(client): step-cards approval renderer (v1: decision + decidedAt)"
```

---

### Task C9: `step-cards/tool-card.tsx` — delegate to the chat tool-card registry

**Files:**
- Create: `packages/client/src/components/workflows/step-cards/tool-card.tsx`

**What this does:** A workflow `tool` step is functionally a tool call. The existing `packages/client/src/components/chat/tool-cards/index.tsx` already has a `byToolName` dispatcher that picks the right renderer (read/write/grep/edit/bash/glob/list/lsp/webfetch/task/todo/etc.) for any tool by name. We pass the workflow step's tool call through that dispatcher so users see the same rendering they see in chat.

- [ ] **Step 1: Locate the chat tool-card dispatcher entry point**

```bash
grep -n "export\|byToolName\|getToolCard\|renderToolCard" /Users/connerswann/code/valet/packages/client/src/components/chat/tool-cards/index.tsx | head -10
```

Confirm the export name (likely `DeferredToolCard` or `ToolCard` — see `packages/client/src/components/chat/deferred-tool-card.tsx` for how it's typically rendered). The shape of `ToolCallData` is defined in `packages/client/src/components/chat/tool-cards/types.ts`.

- [ ] **Step 2: Implement — adapt the step shape to `ToolCallData`**

```typescript
// packages/client/src/components/workflows/step-cards/tool-card.tsx
import { DeferredToolCard } from '@/components/chat/deferred-tool-card';
import type { ToolCallData, ToolCallStatus } from '@/components/chat/tool-cards/types';
import type { WorkflowStepCardProps } from './index';

interface ToolInput { tool?: string; arguments?: unknown; }

export function ToolCard({ step }: WorkflowStepCardProps) {
  const input = step.input as ToolInput | null;
  const toolName = input?.tool ?? 'unknown';
  const status = mapStatus(step.status);

  // Adapt the workflow step row into the ToolCallData shape the chat
  // tool-card dispatcher expects. Field names follow the existing
  // ToolCallData interface — verify against types.ts before committing.
  const toolCallData: ToolCallData = {
    id: `${step.id}`,
    name: toolName,
    status,
    arguments: input?.arguments,
    result: step.output,
    error: step.error ?? undefined,
    startedAt: step.startedAt ?? undefined,
    completedAt: step.completedAt ?? undefined,
  };

  return <DeferredToolCard data={toolCallData} />;
}

function mapStatus(status: string): ToolCallStatus {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'running') return 'running';
  return 'pending';
}
```

If `ToolCallData` field names differ from what's shown above, conform to the existing interface — the principle is: workflow `tool` rendering goes through the same path as chat tool-card rendering, with whatever adapter shape the existing component expects.

- [ ] **Step 3: Verify the rendered output in browser**

After C13 wires the dispatcher and C18 wires the page, drag a workflow with a `tool` step (e.g., `read`) into a dev session. Confirm the tool step card looks the same as it would in chat.

- [ ] **Step 2: Typecheck + commit**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
git add packages/client/src/components/workflows/step-cards/tool-card.tsx
git commit -m "feat(client): step-cards generic tool renderer"
```

---

### Task C10: `step-cards/conditional-card.tsx`

**Files:**
- Create: `packages/client/src/components/workflows/step-cards/conditional-card.tsx`

- [ ] **Step 1: Implement**

```typescript
// packages/client/src/components/workflows/step-cards/conditional-card.tsx
import { ToolCardShell, ToolCardSection } from '@/components/chat/tool-cards/tool-card-shell';
import { StepIcon } from './icons';
import { WorkflowStepCard } from './index';
import type { WorkflowStepCardProps } from './index';

interface ConditionalInput { condition?: string; if?: string; }

export function ConditionalCard({ step, children = [], open, onOpenChange, workflowDef }: WorkflowStepCardProps) {
  const input = step.input as ConditionalInput | null;
  const condition = input?.condition ?? input?.if ?? '(no condition)';
  const branchTaken = inferBranch(step.stepId, children);
  const status = mapStatus(step.status);

  return (
    <ToolCardShell
      icon={<StepIcon kind="conditional" />}
      label="conditional"
      status={status}
      summary={`${step.stepId} · → ${branchTaken ?? 'skipped'}`}
      open={open}
      onOpenChange={onOpenChange}
      id={`step-${step.stepId}-${step.iterationPath}`}
      defaultExpanded={status === 'error'}
    >
      <ToolCardSection label="condition">
        <code className="font-mono text-[11px] text-neutral-700 dark:text-neutral-300">{condition}</code>
      </ToolCardSection>
      {branchTaken && (
        <ToolCardSection label={`taken branch · ${branchTaken}`}>
          <div className="space-y-1 pl-2 border-l border-neutral-200 dark:border-neutral-800">
            {children
              .filter((c) => c.iterationPath.endsWith(`${step.stepId}:${branchTaken}`)
                || c.iterationPath.includes(`${step.stepId}:${branchTaken}/`))
              .map((c) => (
                <WorkflowStepCard
                  key={`${c.stepId}#${c.iterationPath}`}
                  step={c}
                  workflowDef={workflowDef}
                />
              ))}
          </div>
        </ToolCardSection>
      )}
    </ToolCardShell>
  );
}

function inferBranch(stepId: string, children: WorkflowStepCardProps['children']): 'then' | 'else' | null {
  for (const c of children ?? []) {
    if (c.iterationPath.includes(`${stepId}:then`)) return 'then';
    if (c.iterationPath.includes(`${stepId}:else`)) return 'else';
  }
  return null;
}

function mapStatus(status: string): 'pending' | 'running' | 'completed' | 'error' {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'running') return 'running';
  return 'pending';
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
git add packages/client/src/components/workflows/step-cards/conditional-card.tsx
git commit -m "feat(client): step-cards conditional renderer with branch-taken inference"
```

---

### Task C11: `step-cards/loop-card.tsx`

**Files:**
- Create: `packages/client/src/components/workflows/step-cards/loop-card.tsx`

- [ ] **Step 1: Implement**

```typescript
// packages/client/src/components/workflows/step-cards/loop-card.tsx
import { useState, useMemo } from 'react';
import { ToolCardShell, ToolCardSection } from '@/components/chat/tool-cards/tool-card-shell';
import { StepIcon } from './icons';
import { WorkflowStepCard } from './index';
import type { WorkflowStepCardProps } from './index';

export function LoopCard({ step, children = [], open, onOpenChange, workflowDef }: WorkflowStepCardProps) {
  const iterations = useMemo(() => groupByIteration(step.stepId, children), [step.stepId, children]);
  const iterNumbers = Object.keys(iterations).map(Number).sort((a, b) => a - b);
  const [activeIter, setActiveIter] = useState<number | 'all'>(iterNumbers[0] ?? 0);
  const status = mapStatus(step.status);

  return (
    <ToolCardShell
      icon={<StepIcon kind="loop" />}
      label="loop"
      status={status}
      summary={`${step.stepId} · ${iterNumbers.length} iteration${iterNumbers.length === 1 ? '' : 's'}`}
      open={open}
      onOpenChange={onOpenChange}
      id={`step-${step.stepId}-${step.iterationPath}`}
      defaultExpanded={status === 'error'}
    >
      <div role="tablist" className="flex flex-wrap gap-1 px-2.5 py-2 border-b border-neutral-100 dark:border-neutral-800">
        {iterNumbers.map((n) => (
          <button
            key={n}
            role="tab"
            type="button"
            aria-selected={activeIter === n}
            onClick={() => setActiveIter(n)}
            className={`font-mono text-[10px] rounded px-1.5 py-0.5 ${
              activeIter === n
                ? 'bg-accent text-accent-foreground'
                : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900'
            }`}
          >
            iter {n + 1}
          </button>
        ))}
        {iterNumbers.length > 1 && (
          <button
            role="tab"
            type="button"
            aria-selected={activeIter === 'all'}
            onClick={() => setActiveIter('all')}
            className={`font-mono text-[10px] rounded px-1.5 py-0.5 ${
              activeIter === 'all'
                ? 'bg-accent text-accent-foreground'
                : 'text-neutral-500 hover:bg-neutral-100 dark:hover:bg-neutral-900'
            }`}
          >
            all
          </button>
        )}
      </div>
      <ToolCardSection>
        <div className="space-y-1 pl-2 border-l border-neutral-200 dark:border-neutral-800">
          {(activeIter === 'all'
            ? iterNumbers.flatMap((n) => iterations[n])
            : (iterations[activeIter as number] ?? [])
          ).map((c) => (
            <WorkflowStepCard
              key={`${c.stepId}#${c.iterationPath}`}
              step={c}
              workflowDef={workflowDef}
            />
          ))}
        </div>
      </ToolCardSection>
    </ToolCardShell>
  );
}

function groupByIteration(
  containerStepId: string,
  children: WorkflowStepCardProps['children'],
): Record<number, NonNullable<WorkflowStepCardProps['children']>> {
  const out: Record<number, NonNullable<WorkflowStepCardProps['children']>> = {};
  for (const c of children ?? []) {
    const match = c.iterationPath.match(new RegExp(`${escapeRegex(containerStepId)}:i(\\d+)`));
    if (!match) continue;
    const i = Number(match[1]);
    (out[i] ??= []).push(c);
  }
  return out;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mapStatus(status: string): 'pending' | 'running' | 'completed' | 'error' {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'running') return 'running';
  return 'pending';
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
git add packages/client/src/components/workflows/step-cards/loop-card.tsx
git commit -m "feat(client): step-cards loop renderer with iteration tabs"
```

---

### Task C12: `step-cards/parallel-card.tsx`

**Files:**
- Create: `packages/client/src/components/workflows/step-cards/parallel-card.tsx`

- [ ] **Step 1: Implement**

```typescript
// packages/client/src/components/workflows/step-cards/parallel-card.tsx
import { useMemo } from 'react';
import { ToolCardShell, ToolCardSection } from '@/components/chat/tool-cards/tool-card-shell';
import { StepIcon } from './icons';
import { WorkflowStepCard } from './index';
import type { WorkflowStepCardProps } from './index';

export function ParallelCard({ step, children = [], open, onOpenChange, workflowDef }: WorkflowStepCardProps) {
  const branches = useMemo(() => groupByBranch(step.stepId, children), [step.stepId, children]);
  const branchNumbers = Object.keys(branches).map(Number).sort((a, b) => a - b);
  const status = mapStatus(step.status);

  return (
    <ToolCardShell
      icon={<StepIcon kind="parallel" />}
      label="parallel"
      status={status}
      summary={`${step.stepId} · ${branchNumbers.length} branches`}
      open={open}
      onOpenChange={onOpenChange}
      id={`step-${step.stepId}-${step.iterationPath}`}
      defaultExpanded={status === 'error'}
    >
      {branchNumbers.map((b) => {
        const dur = computeBranchDuration(branches[b]);
        return (
          <ToolCardSection key={b} label={`branch ${b + 1}${dur != null ? ` · ${dur}ms` : ''}`}>
            <div className="space-y-1 pl-2 border-l border-neutral-200 dark:border-neutral-800">
              {branches[b].map((c) => (
                <WorkflowStepCard
                  key={`${c.stepId}#${c.iterationPath}`}
                  step={c}
                  workflowDef={workflowDef}
                />
              ))}
            </div>
          </ToolCardSection>
        );
      })}
    </ToolCardShell>
  );
}

function groupByBranch(
  containerStepId: string,
  children: WorkflowStepCardProps['children'],
): Record<number, NonNullable<WorkflowStepCardProps['children']>> {
  const out: Record<number, NonNullable<WorkflowStepCardProps['children']>> = {};
  for (const c of children ?? []) {
    const m = c.iterationPath.match(new RegExp(`${escapeRegex(containerStepId)}:b(\\d+)`));
    if (!m) continue;
    const b = Number(m[1]);
    (out[b] ??= []).push(c);
  }
  return out;
}

function computeBranchDuration(
  rows: NonNullable<WorkflowStepCardProps['children']>,
): number | null {
  let start = Infinity;
  let end = 0;
  for (const r of rows) {
    if (r.startedAt) start = Math.min(start, new Date(r.startedAt).getTime());
    if (r.completedAt) end = Math.max(end, new Date(r.completedAt).getTime());
  }
  if (!isFinite(start) || end === 0) return null;
  return end - start;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function mapStatus(status: string): 'pending' | 'running' | 'completed' | 'error' {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'running') return 'running';
  return 'pending';
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
git add packages/client/src/components/workflows/step-cards/parallel-card.tsx
git commit -m "feat(client): step-cards parallel renderer with branch durations"
```

---

### Task C13: `step-cards/index.tsx` — dispatcher

**Files:**
- Modify: `packages/client/src/components/workflows/step-cards/index.tsx`

- [ ] **Step 1: Replace the stub with the real dispatcher**

```typescript
// packages/client/src/components/workflows/step-cards/index.tsx
import { useMemo } from 'react';
import type { ExecutionStepTrace } from '@/api/executions';
import type { WorkflowData } from '@/api/workflows';
import { AgentPromptCard } from './agent-prompt-card';
import { BashCard } from './bash-card';
import { NotifyCard } from './notify-card';
import { ApprovalCard } from './approval-card';
import { ConditionalCard } from './conditional-card';
import { LoopCard } from './loop-card';
import { ParallelCard } from './parallel-card';
import { ToolCard } from './tool-card';
import { FallbackCard } from './fallback-card';
import { bump, WORKFLOW_TELEMETRY } from '@/lib/workflow-telemetry';

export interface WorkflowStepCardProps {
  step: ExecutionStepTrace;
  /** Resolved by the dispatcher; renderers receive it pre-computed. */
  stepType: string;
  children?: ExecutionStepTrace[];
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
  workflowDef?: WorkflowData | null;
}

interface WorkflowStepCardEntryProps {
  step: ExecutionStepTrace;
  children?: ExecutionStepTrace[];
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
  workflowDef?: WorkflowData | null;
}

export function WorkflowStepCard(props: WorkflowStepCardEntryProps) {
  const stepType = useMemo(
    () => resolveType(props.step, props.workflowDef),
    [props.step, props.workflowDef],
  );
  const enriched: WorkflowStepCardProps = { ...props, stepType };
  switch (stepType) {
    case 'agent_prompt': return <AgentPromptCard {...enriched} />;
    case 'bash':         return <BashCard {...enriched} />;
    case 'notify':       return <NotifyCard {...enriched} />;
    case 'approval':     return <ApprovalCard {...enriched} />;
    case 'conditional':  return <ConditionalCard {...enriched} />;
    case 'loop':         return <LoopCard {...enriched} />;
    case 'parallel':     return <ParallelCard {...enriched} />;
    case 'tool':         return <ToolCard {...enriched} />;
    default:
      bump(WORKFLOW_TELEMETRY.FALLBACK_RENDERER_USED, { type: stepType });
      return <FallbackCard {...enriched} />;
  }
}

function resolveType(step: ExecutionStepTrace, workflowDef?: WorkflowData | null): string {
  // Prefer the static workflow definition; fall back to step.input.type
  // (already parsed unknown — no JSON.parse needed).
  const fromDef = workflowDef ? findStepType(workflowDef.steps, step.stepId) : null;
  if (fromDef) return fromDef;
  if (step.input && typeof step.input === 'object' && !Array.isArray(step.input)) {
    const t = (step.input as { type?: unknown }).type;
    if (typeof t === 'string') return t;
  }
  return 'fallback';
}

function findStepType(steps: Array<{ id: string; type: string; then?: unknown[]; else?: unknown[]; steps?: unknown[] }>, id: string): string | null {
  for (const s of steps) {
    if (s.id === id) return s.type;
    for (const subList of [s.then, s.else, s.steps]) {
      if (Array.isArray(subList)) {
        const t = findStepType(subList as Parameters<typeof findStepType>[0], id);
        if (t) return t;
      }
    }
  }
  return null;
}
```

- [ ] **Step 2: Typecheck**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Expected: clean.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/components/workflows/step-cards/index.tsx
git commit -m "feat(client): step-cards byStepType dispatcher"
```

---

### Task C14: `useExecutionTimeline` — memoized view-model with full nested tree

**Files:**
- Create: `packages/client/src/hooks/use-execution-timeline.ts`
- Create: `packages/client/src/hooks/use-execution-timeline.test.ts`

**Why recursive:** A loop inside a parallel inside a loop is a real shape. A shallow flat-children model would not group iterations correctly past the outermost container, and would not surface pending children that exist in the static def but have no row yet. The container cards (`loop-card.tsx`, `parallel-card.tsx`, `conditional-card.tsx`) call `WorkflowStepCard` on each child — those calls expect a real `TimelineNode` whose grandchildren are already nested.

- [ ] **Step 1: Write tests**

```typescript
// packages/client/src/hooks/use-execution-timeline.test.ts
import { describe, it, expect } from 'vitest';
import { buildTimelineViewModel } from './use-execution-timeline';

function mkRow(over: Partial<{
  stepId: string; iterationPath: string; status: string; attempt: number;
  startedAt: string | null; completedAt: string | null; input: unknown; output: unknown;
  error: string | null; id: string; createdAt: string;
}>): never {
  return {
    id: over.id ?? `r-${Math.random()}`,
    executionId: 'ex',
    stepId: over.stepId ?? 's',
    attempt: over.attempt ?? 1,
    iterationPath: over.iterationPath ?? '',
    status: over.status ?? 'completed',
    input: over.input ?? null,
    output: over.output ?? null,
    error: over.error ?? null,
    startedAt: over.startedAt ?? '',
    completedAt: over.completedAt ?? '',
    createdAt: over.createdAt ?? '',
    workflowStepIndex: null,
    sequence: 0,
  } as never;
}

const def = {
  steps: [
    { id: 'A', type: 'bash' },
    {
      id: 'L', type: 'loop',
      steps: [
        { id: 'inner', type: 'bash' },
        {
          id: 'P', type: 'parallel',
          steps: [
            { id: 'leaf1', type: 'bash' },
            { id: 'leaf2', type: 'bash' },
          ],
        },
      ],
    },
  ],
};

describe('buildTimelineViewModel', () => {
  it('places top-level steps in static-definition order', () => {
    const vm = buildTimelineViewModel(def as never, [
      mkRow({ stepId: 'A', iterationPath: '' }),
      mkRow({ stepId: 'L', iterationPath: '' }),
    ]);
    expect(vm.map((n) => n.step.stepId)).toEqual(['A', 'L']);
  });

  it('nests recursively: loop -> iter -> inner parallel -> branch -> leaf', () => {
    const vm = buildTimelineViewModel(def as never, [
      mkRow({ stepId: 'L', iterationPath: '' }),
      mkRow({ stepId: 'inner', iterationPath: 'L:i0' }),
      mkRow({ stepId: 'P', iterationPath: 'L:i0' }),
      mkRow({ stepId: 'leaf1', iterationPath: 'L:i0/P:b0' }),
      mkRow({ stepId: 'leaf2', iterationPath: 'L:i0/P:b1' }),
    ]);
    const loop = vm.find((n) => n.step.stepId === 'L')!;
    expect(loop.children?.map((c) => c.step.stepId)).toContain('P');
    const parallelNode = loop.children?.find((c) => c.step.stepId === 'P')!;
    expect(parallelNode.children?.map((c) => c.step.stepId).sort()).toEqual(['leaf1', 'leaf2']);
  });

  it('emits a placeholder node for a static step with no row yet', () => {
    const vm = buildTimelineViewModel(def as never, [
      // Only 'A' has run; 'L' has not yet.
      mkRow({ stepId: 'A', iterationPath: '' }),
    ]);
    const loop = vm.find((n) => n.step.stepId === 'L');
    expect(loop).toBeTruthy();
    expect(loop?.step.status).toBe('pending');
    expect(loop?.placeholder).toBe(true);
  });

  it('falls back to flat createdAt order when workflowDef is null', () => {
    const vm = buildTimelineViewModel(null, [
      mkRow({ stepId: 'b', iterationPath: '', createdAt: '2026-01-02' }),
      mkRow({ stepId: 'a', iterationPath: '', createdAt: '2026-01-01' }),
    ]);
    expect(vm.map((n) => n.step.stepId)).toEqual(['a', 'b']);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
cd /Users/connerswann/code/valet && pnpm vitest run packages/client/src/hooks/use-execution-timeline.test.ts
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// packages/client/src/hooks/use-execution-timeline.ts
import { useMemo } from 'react';
import type { ExecutionStepTrace } from '@/api/executions';
import type { WorkflowData, WorkflowStep } from '@/api/workflows';
import { bump, WORKFLOW_TELEMETRY } from '@/lib/workflow-telemetry';

export interface TimelineNode {
  step: ExecutionStepTrace;
  children?: TimelineNode[];
  /** True when the static def has this step but no row exists yet. */
  placeholder?: boolean;
}

export function useExecutionTimeline(
  workflowDef: WorkflowData | null | undefined,
  stepRows: ExecutionStepTrace[] | undefined,
): TimelineNode[] {
  return useMemo(
    () => buildTimelineViewModel(workflowDef ?? null, stepRows ?? []),
    [workflowDef, stepRows],
  );
}

export function buildTimelineViewModel(
  workflowDef: WorkflowData | null,
  stepRows: ExecutionStepTrace[],
): TimelineNode[] {
  if (!workflowDef) {
    return [...stepRows]
      .sort((a, b) => (a.createdAt ?? '').localeCompare(b.createdAt ?? ''))
      .map((s) => ({ step: s }));
  }

  const placedKeys = new Set<string>();
  const nodes = buildLevel(workflowDef.steps, '', stepRows, placedKeys);

  // Surface orphan rows via telemetry (events arrived for steps the static def doesn't know).
  for (const r of stepRows) {
    if (!placedKeys.has(`${r.stepId}#${r.iterationPath}`)) {
      bump(WORKFLOW_TELEMETRY.ORPHAN_STEP_ROW, {
        stepId: r.stepId,
        iterationPath: r.iterationPath,
      });
    }
  }

  return nodes;
}

function buildLevel(
  defSteps: WorkflowStep[],
  parentIterationPath: string,
  allRows: ExecutionStepTrace[],
  placedKeys: Set<string>,
): TimelineNode[] {
  const out: TimelineNode[] = [];

  for (const defStep of defSteps) {
    // Find the row for THIS def step at THIS iteration path.
    const row = allRows.find(
      (r) => r.stepId === defStep.id && r.iterationPath === parentIterationPath,
    );

    if (!row) {
      // No row yet — emit a placeholder.
      out.push({ step: makePlaceholderRow(defStep, parentIterationPath), placeholder: true });
      continue;
    }
    placedKeys.add(`${row.stepId}#${row.iterationPath}`);

    if (defStep.type === 'loop') {
      // Discover iteration indexes from child rows under this loop instance.
      const prefix = parentIterationPath
        ? `${parentIterationPath}/${defStep.id}:i`
        : `${defStep.id}:i`;
      const iterIndexes = collectIndexes(allRows, prefix);
      const children: TimelineNode[] = [];
      for (const i of iterIndexes) {
        const childParent = parentIterationPath
          ? `${parentIterationPath}/${defStep.id}:i${i}`
          : `${defStep.id}:i${i}`;
        children.push(...buildLevel(defStep.steps ?? [], childParent, allRows, placedKeys));
      }
      out.push({ step: row, children });
    } else if (defStep.type === 'parallel') {
      const prefix = parentIterationPath
        ? `${parentIterationPath}/${defStep.id}:b`
        : `${defStep.id}:b`;
      const branchIndexes = collectIndexes(allRows, prefix);
      const children: TimelineNode[] = [];
      for (const b of branchIndexes) {
        const childParent = parentIterationPath
          ? `${parentIterationPath}/${defStep.id}:b${b}`
          : `${defStep.id}:b${b}`;
        children.push(...buildLevel(defStep.steps ?? [], childParent, allRows, placedKeys));
      }
      out.push({ step: row, children });
    } else if (defStep.type === 'conditional') {
      const thenPrefix = parentIterationPath
        ? `${parentIterationPath}/${defStep.id}:then`
        : `${defStep.id}:then`;
      const elsePrefix = parentIterationPath
        ? `${parentIterationPath}/${defStep.id}:else`
        : `${defStep.id}:else`;
      const children: TimelineNode[] = [];
      if (allRows.some((r) => r.iterationPath === thenPrefix || r.iterationPath.startsWith(`${thenPrefix}/`))) {
        children.push(...buildLevel((defStep.then ?? []) as WorkflowStep[], thenPrefix, allRows, placedKeys));
      } else if (allRows.some((r) => r.iterationPath === elsePrefix || r.iterationPath.startsWith(`${elsePrefix}/`))) {
        children.push(...buildLevel((defStep.else ?? []) as WorkflowStep[], elsePrefix, allRows, placedKeys));
      }
      out.push({ step: row, children });
    } else {
      out.push({ step: row });
    }
  }

  return out;
}

function collectIndexes(rows: ExecutionStepTrace[], prefix: string): number[] {
  const seen = new Set<number>();
  for (const r of rows) {
    if (!r.iterationPath.startsWith(prefix)) continue;
    const tail = r.iterationPath.slice(prefix.length);
    const end = tail.indexOf('/');
    const numStr = end >= 0 ? tail.slice(0, end) : tail;
    const n = Number(numStr);
    if (Number.isInteger(n) && n >= 0) seen.add(n);
  }
  return [...seen].sort((a, b) => a - b);
}

function makePlaceholderRow(
  defStep: WorkflowStep,
  iterationPath: string,
): ExecutionStepTrace {
  return {
    id: `placeholder-${defStep.id}-${iterationPath}`,
    executionId: '',
    stepId: defStep.id,
    attempt: 0,
    iterationPath,
    status: 'pending',
    input: { type: defStep.type, ...(defStep as unknown as object) },
    output: null,
    error: null,
    startedAt: null,
    completedAt: null,
    createdAt: '',
    workflowStepIndex: null,
    sequence: 0,
  } as unknown as ExecutionStepTrace;
}
```

The `TimelineNode.children` is now `TimelineNode[]` (recursive), not `ExecutionStepTrace[]`. **Container cards consume `TimelineNode[]` and pass each child's `node.step` + `node.children` to `WorkflowStepCard`** — update C10/C11/C12 to receive `children: TimelineNode[]` and forward `c.step` + `c.children` into the recursive call.

- [ ] **Step 4: Update C10/C11/C12 prop usage**

In each container card, change the `children` prop type and the `.map(c => <WorkflowStepCard step={c} />)` pattern to:

```typescript
children?: TimelineNode[];
// ...
children.map((c) => (
  <WorkflowStepCard
    key={`${c.step.stepId}#${c.step.iterationPath}`}
    step={c.step}
    children={c.children}
    workflowDef={workflowDef}
  />
))
```

(The `WorkflowStepCard` entry props gain `children?: TimelineNode[]` — propagate.)

- [ ] **Step 5: Run, verify pass**

```bash
cd /Users/connerswann/code/valet && pnpm vitest run packages/client/src/hooks/use-execution-timeline.test.ts
```

Expected: PASS, all four tests.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/hooks/use-execution-timeline.ts packages/client/src/hooks/use-execution-timeline.test.ts packages/client/src/components/workflows/step-cards/
git commit -m "feat(client): useExecutionTimeline with full nested tree + placeholders"
```

---

### Task C15: `execution-timeline.tsx`

**Files:**
- Create: `packages/client/src/components/workflows/execution-timeline.tsx`

- [ ] **Step 1: Implement**

```typescript
// packages/client/src/components/workflows/execution-timeline.tsx
import { useCallback, useState, useRef, useEffect } from 'react';
import type { ExecutionStepTrace } from '@/api/executions';
import type { WorkflowData } from '@/api/workflows';
import { useExecutionTimeline } from '@/hooks/use-execution-timeline';
import { WorkflowStepCard } from './step-cards';

interface Props {
  workflowDef: WorkflowData | null;
  stepRows: ExecutionStepTrace[];
  onHighlightedStepChange?: (key: string | null) => void;
}

export function ExecutionTimeline({ workflowDef, stepRows, onHighlightedStepChange }: Props) {
  const timeline = useExecutionTimeline(workflowDef, stepRows);
  const [openMap, setOpenMap] = useState<Map<string, boolean>>(new Map());
  const lastFailureKeyRef = useRef<string | null>(null);

  // Auto-expand on failure transitions.
  useEffect(() => {
    for (const row of stepRows) {
      const key = cardKey(row);
      if (row.status === 'failed' && !openMap.has(key)) {
        setOpenMap((prev) => new Map(prev).set(key, true));
        lastFailureKeyRef.current = key;
      }
    }
  }, [stepRows, openMap]);

  const setOpen = useCallback((key: string, next: boolean) => {
    setOpenMap((prev) => {
      const out = new Map(prev);
      out.set(key, next);
      return out;
    });
  }, []);

  return (
    <div className="flex flex-col gap-2 p-3 overflow-y-auto" data-component="execution-timeline">
      {timeline.length === 0 && (
        <p className="font-mono text-[11px] text-neutral-500">No steps yet.</p>
      )}
      {timeline.map((node) => {
        const key = cardKey(node.step);
        return (
          <div
            key={key}
            data-step-key={key}
            ref={makeIntersectionRef(key, onHighlightedStepChange)}
          >
            <WorkflowStepCard
              step={node.step}
              children={node.children}
              open={openMap.get(key) ?? false}
              onOpenChange={(next) => setOpen(key, next)}
              workflowDef={workflowDef}
            />
          </div>
        );
      })}
    </div>
  );
}

export function cardKey(row: { stepId: string; iterationPath: string }): string {
  return `${row.stepId}#${row.iterationPath}`;
}

// A single shared IntersectionObserver across all cards. The callback-ref pattern
// re-uses one observer instance per mount of ExecutionTimeline.
function makeIntersectionRef(
  key: string,
  onChange: ((key: string | null) => void) | undefined,
): (el: HTMLDivElement | null) => void {
  // Defer observer creation to first attach. Multiple refs share the observer
  // via a closure-scoped registry that disconnects on the last detach.
  // (For brevity, store the observer on a module-scoped WeakMap keyed by
  //  the parent scroll container. Implementer note: see ExecutionDiagramRail
  //  for the corresponding click->scrollIntoView side of this contract.)
  return (el) => {
    if (!el || !onChange) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            onChange(key);
          }
        }
      },
      { threshold: 0.6 },
    );
    observer.observe(el);
    // The ref is detached → re-created on next render; rely on observer.disconnect
    // on unmount via React's cleanup. (Simplification — a real shared observer
    // would live higher up; revisit in C16 if perf shows up as an issue.)
  };
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
git add packages/client/src/components/workflows/execution-timeline.tsx
git commit -m "feat(client): ExecutionTimeline component with controlled-open map"
```

---

### Task C16: `execution-diagram-rail.tsx`

**Files:**
- Create: `packages/client/src/components/workflows/execution-diagram-rail.tsx`

- [ ] **Step 1: Implement**

```typescript
// packages/client/src/components/workflows/execution-diagram-rail.tsx
import { useCallback } from 'react';
import type { WorkflowData } from '@/api/workflows';
import type { StepRuntimeStatus } from './workflow-diagram/types';
import { WorkflowDiagram } from './workflow-diagram';

interface Props {
  workflow: WorkflowData;
  runtimeStatus: Record<string, StepRuntimeStatus>;
  currentStepId?: string;
  stepErrors: Record<string, string>;
  highlightedStepId: string | null;
  /** Called when the user clicks a node — scroll the timeline + open the card. */
  onNodeClick?: (stepId: string) => void;
}

export function ExecutionDiagramRail({
  workflow,
  runtimeStatus,
  currentStepId,
  stepErrors,
  highlightedStepId,
  onNodeClick,
}: Props) {
  const handleClick = useCallback((stepId: string) => {
    onNodeClick?.(stepId);
    const el = document.querySelector(`[data-step-key^="${stepId}#"]`);
    if (el instanceof HTMLElement) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
    }
  }, [onNodeClick]);

  return (
    <div className="w-[360px] shrink-0 border-l border-border bg-surface-1">
      <WorkflowDiagram
        workflow={workflow}
        mode="runtime"
        runtimeStatus={runtimeStatus}
        currentStepId={highlightedStepId ?? currentStepId}
        stepErrors={stepErrors}
        onNodeClick={handleClick}
      />
    </div>
  );
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
git add packages/client/src/components/workflows/execution-diagram-rail.tsx
git commit -m "feat(client): ExecutionDiagramRail with click-to-scroll-timeline"
```

---

### Task C17: Telemetry counters for Phase 1

**Files:**
- Create: `packages/client/src/lib/workflow-telemetry.ts`

- [ ] **Step 1: Implement a minimal counter**

```typescript
// packages/client/src/lib/workflow-telemetry.ts
/**
 * Lightweight counter wrapper. In production, swap the implementation for a
 * real metrics sink. For now: log + count in memory + ship to a debug endpoint
 * if one ever exists.
 */

const counters: Record<string, number> = {};

export const WORKFLOW_TELEMETRY = {
  STEP_INSTANCE_COLLISION: 'workflow_ui.step_instance_collision',
  ORPHAN_STEP_ROW: 'workflow_ui.orphan_step_row',
  WORKFLOW_MESSAGE_NO_STEP: 'workflow_ui.workflow_message_no_step',
  AGENT_PROMPT_RESPONSE_MISSING: 'workflow_ui.agent_prompt_response_missing',
  FALLBACK_RENDERER_USED: 'workflow_ui.fallback_renderer_used',
  MIGRATION_IRREGULARITY: 'workflow_ui.migration_irregularity',
} as const;

export type WorkflowTelemetryCounter = (typeof WORKFLOW_TELEMETRY)[keyof typeof WORKFLOW_TELEMETRY];

export function bump(counter: WorkflowTelemetryCounter, ctx?: Record<string, unknown>): void {
  counters[counter] = (counters[counter] ?? 0) + 1;
  if (typeof console !== 'undefined') {
    // eslint-disable-next-line no-console
    console.debug(`[workflow-telemetry] ${counter}`, counters[counter], ctx);
  }
}

export function snapshot(): Record<string, number> {
  return { ...counters };
}
```

- [ ] **Step 2: Orphan-row detection is wired in C14's view-model already**

`buildTimelineViewModel` in C14 already calls `bump(WORKFLOW_TELEMETRY.ORPHAN_STEP_ROW, ...)` for any step row that the static def doesn't recognize. Confirm this is in place; nothing additional to do.

- [ ] **Step 3: `FALLBACK_RENDERER_USED` is wired in C13's dispatcher already**

If C13 was executed before C17, the dispatcher already calls `bump(WORKFLOW_TELEMETRY.FALLBACK_RENDERER_USED, ...)` in the `default:` arm. Confirm. If C13 hadn't been done yet, do it now per the C13 step.

- [ ] **Step 4: Typecheck + commit**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
git add packages/client/src/lib/workflow-telemetry.ts packages/client/src/hooks/use-execution-timeline.ts packages/client/src/components/workflows/step-cards/index.tsx
git commit -m "obs(client): workflow UI telemetry counters"
```

---

### Task C17.5: Retry-workflow footer on failed step cards

**Files:**
- Modify: `packages/client/src/components/workflows/step-cards/index.tsx`

**Why this lives in the dispatcher:** every renderer already wraps `ToolCardShell`; adding the retry button at the dispatcher level means it appears uniformly under every failed card without each renderer having to thread the action. The button **re-runs the entire workflow** (no "from here" semantics — see Task A13 for the scope decision).

- [ ] **Step 1: Look up the "run workflow" mutation**

```bash
grep -n "useRunWorkflow\|useTestFireWorkflow\|runWorkflow\b" /Users/connerswann/code/valet/packages/client/src/api/workflows.ts | head -5
```

There's an existing mutation that dispatches a workflow (used by the manual-trigger UI). Reuse it.

- [ ] **Step 2: Wrap the dispatched card with a footer when status is failed**

In `index.tsx`, change `WorkflowStepCard` to render a wrapper:

```typescript
import { useRunWorkflow } from '@/api/workflows';
import { useNavigate } from '@tanstack/react-router';
import { RotateCcw } from 'lucide-react';

export function WorkflowStepCard(props: WorkflowStepCardEntryProps) {
  const stepType = useMemo(() => resolveType(props.step, props.workflowDef), [props.step, props.workflowDef]);
  const enriched: WorkflowStepCardProps = { ...props, stepType };
  const card = dispatchCard(stepType, enriched);

  if (props.step.status !== 'failed') return card;

  return (
    <div className="flex flex-col gap-1">
      {card}
      <RetryFooter workflowId={props.workflowDef?.id} />
    </div>
  );
}

function dispatchCard(stepType: string, props: WorkflowStepCardProps) {
  switch (stepType) {
    case 'agent_prompt': return <AgentPromptCard {...props} />;
    // ... etc, identical to existing switch in C13
  }
}

function RetryFooter({ workflowId }: { workflowId?: string }) {
  const run = useRunWorkflow();
  const navigate = useNavigate();
  if (!workflowId) return null;
  return (
    <button
      type="button"
      onClick={async () => {
        const res = await run.mutateAsync({ workflowId, variables: {} });
        if (res?.execution?.executionId) {
          navigate({
            to: '/automation/executions/$executionId',
            params: { executionId: res.execution.executionId },
          });
        }
      }}
      disabled={run.isPending}
      className="self-start font-mono text-[10px] px-2 py-1 rounded border border-neutral-200 dark:border-neutral-800 hover:bg-neutral-50 dark:hover:bg-white/[0.02] inline-flex items-center gap-1"
    >
      <RotateCcw className="w-3 h-3" />
      retry workflow
    </button>
  );
}
```

(Conform `useRunWorkflow`'s actual mutation signature to whatever the api file exports — the hook name might be `useTestFireWorkflow` or `useDispatchWorkflow`. The point is: re-dispatch from the top, then navigate to the new execution.)

- [ ] **Step 3: Typecheck + browser smoke**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Open an execution detail page where a step has failed. Verify the retry button shows under the failed card and dispatches a new execution on click.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/workflows/step-cards/index.tsx
git commit -m "feat(client): retry-workflow footer on failed step cards"
```

---

### Task C18: Wire the new page behind `workflow_ui_execution_v2`

**Files:**
- Modify: `packages/client/src/routes/automation/executions/$executionId.tsx`

- [ ] **Step 1: Branch on the flag**

Replace the body of `ExecutionDetailPage` with a flag branch. Keep the legacy branch as-is so we can roll back without code surgery.

```typescript
import { useFeatureFlag } from '@/lib/feature-flags';
import { ExecutionTimeline } from '@/components/workflows/execution-timeline';
import { ExecutionDiagramRail } from '@/components/workflows/execution-diagram-rail';

function ExecutionDetailPage() {
  const useV2 = useFeatureFlag('workflow_ui_execution_v2');
  if (useV2) return <ExecutionDetailPageV2 />;
  return <ExecutionDetailPageLegacy />;
}

function ExecutionDetailPageV2() {
  // ...load data exactly as the existing page does:
  // useExecution, useExecutionSteps, useWorkflow, useExecutionStepEvents.
  // Then render:
  return (
    <div className="flex flex-col h-full bg-surface-0">
      <ExecutionHeader execution={execution} onCancel={...} onApprove={...} onDeny={...} />
      <div className="flex flex-1 min-h-0">
        <div className="flex-1 min-w-0 overflow-hidden">
          <ExecutionTimeline
            workflowDef={workflow}
            stepRows={stepsData?.steps ?? []}
            onHighlightedStepChange={setHighlightedStepId}
          />
        </div>
        {workflow && (
          <ExecutionDiagramRail
            workflow={workflow}
            runtimeStatus={runtimeStatus}
            currentStepId={currentStepId}
            stepErrors={stepErrors}
            highlightedStepId={highlightedStepId}
            onNodeClick={(id) => setHighlightedStepId(id)}
          />
        )}
      </div>
    </div>
  );
}

function ExecutionDetailPageLegacy() {
  // Move the existing implementation here verbatim.
}
```

The existing page's data loading (useExecution, useExecutionSteps, useWorkflow, useExecutionStepEvents, runtimeStatus / currentStepId / stepErrors derivation, retryFromStep handlers) is unchanged — just hoist it into `ExecutionDetailPageV2` and feed the new components.

- [ ] **Step 2: Typecheck**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Expected: clean.

- [ ] **Step 3: Browser smoke test**

```bash
cd /Users/connerswann/code/valet/packages/client && pnpm dev
```

- Open a recent execution detail page. Default state (flag off): legacy page.
- In browser console: `localStorage.setItem('flag:workflow_ui_execution_v2', 'on')`. Refresh. Expected: new layout. Click around: cards expand/collapse, failed steps auto-expand, diagram node clicks scroll the timeline.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/routes/automation/executions/\$executionId.tsx
git commit -m "feat(client): execution detail page v2 behind workflow_ui_execution_v2"
```

---

### Task C19: Dogfood gate — Phase 1

Execute each scenario from the spec's dogfood section against the dev environment with the flag on. Each scenario must visibly work in the browser. If any fails, halt and fix before continuing.

- [ ] **Scenario 1:** Workflow with a loop of ≥3 iterations, each containing an `agent_prompt` with a persona. Verify: 3 separate `agent_prompt` cards under the loop, persona pill present, model/tokens shown in header.
- [ ] **Scenario 2:** Workflow with a `parallel` of ≥2 branches, each containing a `bash` step. Verify: branches rendered as stacked groups, durations shown.
- [ ] **Scenario 3:** Conditional with both `then` and `else` paths in the static tree; run both branches across two executions. Verify: branch-taken indicator correct in each.
- [ ] **Scenario 4:** Approval step — approve, deny, time-out (three separate runs). Verify: card reflects each decision.
- [ ] **Scenario 5:** Retry-from-step targeting a step inside a loop iteration. Verify: new execution's iterationPath matches the source iteration.
- [ ] **Scenario 6:** Notify step that fails (interpolation error). Verify: card shows error, channel chip rendered.
- [ ] **Scenario 7:** Stuck-execution sweep — synthetically mark an execution stuck via D1 and verify cards render the terminal state.

- [ ] **Sign-off:** Comment in `docs/plans/2026-05-25-workflow-ui-redesign.md` indicating all seven scenarios passed. Commit.

```bash
git commit --allow-empty -m "ops(workflows): phase 1 dogfood passed — 7/7 scenarios"
```

---

### Task C20: Delete legacy components

**Files:**
- Delete: `packages/client/src/components/workflows/execution-step-panel.tsx`
- Delete: `packages/client/src/components/workflows/execution-step-trace.tsx`
- Delete: `packages/client/src/components/workflows/execution-variables-panel.tsx`
- Modify: `packages/client/src/routes/automation/executions/$executionId.tsx` — delete `ExecutionDetailPageLegacy` and the flag branch

**Only execute this task after `workflow_ui_execution_v2` has been on for all users for at least one week with no critical issues.**

- [ ] **Step 1: Delete legacy files**

```bash
cd /Users/connerswann/code/valet
rm packages/client/src/components/workflows/execution-step-panel.tsx
rm packages/client/src/components/workflows/execution-step-trace.tsx
rm packages/client/src/components/workflows/execution-variables-panel.tsx
```

- [ ] **Step 2: Remove the legacy branch from the route**

Delete `ExecutionDetailPageLegacy`; replace `ExecutionDetailPage` with a thin shim that calls `ExecutionDetailPageV2` directly (or rename).

- [ ] **Step 3: Remove the flag from `DEFAULTS`**

In `packages/client/src/lib/feature-flags.ts`, remove `workflow_ui_execution_v2` from `DEFAULTS` and `FLAG_NAMES`.

- [ ] **Step 4: Typecheck + browser smoke**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

- [ ] **Step 5: Commit**

```bash
git add packages/client/
git commit -m "refactor(client): delete legacy execution detail components and flag"
```

---

# Phase D — Session chat integration

**Goal:** Show a workflow context bar on workflow sessions and interleave step rows into the chat feed as cards. Behind `workflow_ui_chat_cards`.

---

### Task D1: Migration — message back-pointer columns

**Files:**
- Create: `packages/worker/migrations/0018_messages_workflow_backpointers.sql`

- [ ] **Step 1: Write the migration**

```sql
-- 0018_messages_workflow_backpointers.sql
-- Add back-pointer columns to messages for workflow-originated rows.
-- All nullable; only populated for workflow-chat-message-derived rows.

ALTER TABLE messages ADD COLUMN workflow_execution_id TEXT;
ALTER TABLE messages ADD COLUMN workflow_step_id TEXT;
ALTER TABLE messages ADD COLUMN workflow_iteration_path TEXT;

CREATE INDEX idx_messages_workflow_execution
  ON messages (workflow_execution_id);
```

- [ ] **Step 2: Apply locally**

```bash
cd /Users/connerswann/code/valet && make db-migrate
```

- [ ] **Step 3: Commit**

```bash
git add packages/worker/migrations/0018_messages_workflow_backpointers.sql
git commit -m "feat(worker): migration 0018 — workflow back-pointers on messages"
```

---

### Task D2: Drizzle schema update for messages (D1 replication)

**Files:**
- Modify: the messages schema file (locate with: `grep -rn "messages.*sqliteTable\|export const messages" packages/worker/src/lib/schema/`)

- [ ] **Step 1: Find and update**

Add to the messages table definition:

```typescript
workflowExecutionId: text(),
workflowStepId: text(),
workflowIterationPath: text(),
// ... and to the index list:
index('idx_messages_workflow_execution').on(table.workflowExecutionId),
```

(Drizzle column names use camelCase even though the SQL column is snake_case; Drizzle handles the mapping.)

- [ ] **Step 2: Typecheck + commit**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
git add packages/worker/src/lib/schema/
git commit -m "feat(worker): drizzle schema for message workflow back-pointers (D1)"
```

---

### Task D2.5: `MessageStore` (DO-local SQLite) gets the same columns

**Files:**
- Modify: `packages/worker/src/durable-objects/message-store.ts`

**Why this exists:** Workflow chat messages are written to DO-local SQLite first by `MessageStore.writeMessage` (around line 111), then flushed/replicated to D1 (around line 541). The D1 migration in D1 and the Drizzle schema in D2 do not cover the DO-local storage path; without this task, back-pointers would persist nowhere or only in D1, breaking immediate-read scenarios.

- [ ] **Step 1: Find the DO-local table definition**

```bash
grep -n "CREATE TABLE\|writeMessage\|flush" /Users/connerswann/code/valet/packages/worker/src/durable-objects/message-store.ts | head -10
```

The class manages its own SQLite schema via `ctx.storage.sql.exec`. Find the schema definition and the `writeMessage` insert.

- [ ] **Step 2: Add columns to the DO-local schema**

The schema is created lazily in `MessageStore`. Add an idempotent migration:

```typescript
private ensureSchema() {
  this.sql.exec(`CREATE TABLE IF NOT EXISTS messages (...)`);  // existing
  // Additive: tolerate older deployments that already have the table.
  try { this.sql.exec(`ALTER TABLE messages ADD COLUMN workflow_execution_id TEXT`); } catch {}
  try { this.sql.exec(`ALTER TABLE messages ADD COLUMN workflow_step_id TEXT`); } catch {}
  try { this.sql.exec(`ALTER TABLE messages ADD COLUMN workflow_iteration_path TEXT`); } catch {}
}
```

- [ ] **Step 3: Extend `writeMessage` signature + insert**

Accept the three new fields (all optional/nullable) on the `writeMessage` input. Add them to the `INSERT` column list and bound values.

- [ ] **Step 4: Extend the flush-to-D1 path**

Around line 541, the flush copies rows from DO-local SQLite to D1 via a prepared INSERT. Add the three new columns to both the `SELECT` and `INSERT` clauses so back-pointers survive replication.

- [ ] **Step 5: Typecheck + worker tests**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
cd /Users/connerswann/code/valet/packages/worker && pnpm test
```

Expected: clean and green.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/durable-objects/message-store.ts
git commit -m "feat(worker): MessageStore persists + replicates workflow back-pointers"
```

---

### Task D3: Extend `workflow-chat-message` wire protocol

**Files:**
- Modify: `packages/shared/src/types/runner-protocol.ts`
- Modify: `packages/runner/src/agent-client.ts`

- [ ] **Step 1: Add typed fields to the wire type**

In `runner-protocol.ts`, find the `workflow-chat-message` payload type (around line 323). Add three optional typed fields:

```typescript
{
  type: 'workflow-chat-message';
  role: 'user' | 'assistant' | 'system';
  content: string;
  parts?: MessagePart[];
  channelType?: string;
  channelId?: string;
  opencodeSessionId?: string;
  // NEW — back-pointers for workflow attribution + telemetry.
  workflowExecutionId?: string;
  workflowStepId?: string;
  workflowIterationPath?: string;
  // ... drop the freeform metadata bag once consumers migrate
  metadata?: Record<string, unknown>;
}
```

- [ ] **Step 2: Update the runner sender signature**

In `packages/runner/src/agent-client.ts:267`:

```typescript
interface WorkflowChatMessageContext {
  channelType?: string;
  channelId?: string;
  opencodeSessionId?: string;
  workflowExecutionId?: string;
  workflowStepId?: string;
  workflowIterationPath?: string;
}

sendWorkflowChatMessage(
  role: "user" | "assistant" | "system",
  content: string,
  context: WorkflowChatMessageContext,
): void {
  this.send({
    type: "workflow-chat-message",
    role,
    content,
    parts: [{ type: "text", text: content }],
    ...(context.channelType ? { channelType: context.channelType } : {}),
    ...(context.channelId ? { channelId: context.channelId } : {}),
    ...(context.opencodeSessionId ? { opencodeSessionId: context.opencodeSessionId } : {}),
    ...(context.workflowExecutionId ? { workflowExecutionId: context.workflowExecutionId } : {}),
    ...(context.workflowStepId ? { workflowStepId: context.workflowStepId } : {}),
    ...(context.workflowIterationPath != null ? { workflowIterationPath: context.workflowIterationPath } : {}),
  });
}
```

(The opaque `metadata` argument is replaced with typed fields.)

- [ ] **Step 3: Typecheck**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Expected: errors at call sites in `packages/runner/src/prompt.ts:1375` and `:1463` that still pass `metadata` — fixed in Task D4.

- [ ] **Step 4: Commit**

```bash
git add packages/shared/src/types/runner-protocol.ts packages/runner/src/agent-client.ts
git commit -m "feat(runner): workflow-chat-message gains typed back-pointer fields"
```

---

### Task D4: Runner populates back-pointers when emitting

**Files:**
- Modify: `packages/runner/src/prompt.ts`

**Prerequisite check:** This task reads `context.iterationPath` from `WorkflowStepExecutionContext`. That field is added in **Task A4.5**. If A4.5 hasn't been done, do it first.

- [ ] **Step 1: Locate the two emit sites**

Search:

```bash
grep -n "sendWorkflowChatMessage" /Users/connerswann/code/valet/packages/runner/src/prompt.ts
```

Two hits: 1375 (prompt) and 1463 (assistant recovery response).

- [ ] **Step 2: Update both calls to use the new context shape**

The `onAgentStep` hook receives a `WorkflowStepExecutionContext` named `context` (post-A4.5, this has `executionId`, `iterationPath`). Wire them through:

```typescript
this.agentClient.sendWorkflowChatMessage("user", content, {
  channelType: ...,
  channelId: ...,
  opencodeSessionId: ...,
  workflowExecutionId: context.executionId,
  workflowStepId: step.id,
  workflowIterationPath: context.iterationPath,
});
```

And the recovery-response call (find the closest enclosing scope where `context` is in scope — if it isn't at the inner callsite, lift it from the hook entry point):

```typescript
this.agentClient.sendWorkflowChatMessage("assistant", recoveredResponse, {
  channelType: ...,
  channelId: ...,
  opencodeSessionId: ...,
  workflowExecutionId: context.executionId,
  workflowStepId: step.id,
  workflowIterationPath: context.iterationPath,
});
```

- [ ] **Step 3: Typecheck + runner tests**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
cd /Users/connerswann/code/valet/packages/runner && pnpm test
```

Expected: clean and green.

- [ ] **Step 4: Commit**

```bash
git add packages/runner/src/prompt.ts
git commit -m "feat(runner): emit workflow back-pointers on workflow-chat-message"
```

---

### Task D5: DO handler validates ownership and persists back-pointers

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts`

- [ ] **Step 1: Locate the handler**

Around line 2246 (`'workflow-chat-message': (msg) => {`).

- [ ] **Step 2: Add ownership validation**

Before persisting, if `msg.workflowExecutionId` is set, validate that the execution belongs to this session's user. Pattern: mirror the step-event ingest at `session-agent.ts:3530` / `executions.ts:455` (`assertExecutionOwnedByUser` or similar). If validation fails, drop the message and bump a counter; do not throw.

```typescript
'workflow-chat-message': async (msg) => {
  // ... existing role/content validation ...

  let workflowExecutionId: string | null = null;
  let workflowStepId: string | null = null;
  let workflowIterationPath: string | null = null;

  if (typeof msg.workflowExecutionId === 'string') {
    const owned = await isExecutionOwnedByUser(this.env.DB, msg.workflowExecutionId, this.sessionState.userId);
    if (!owned) {
      console.warn('[session-agent] dropped workflow-chat-message: execution not owned by user', {
        sessionId: this.sessionState.sessionId,
        executionId: msg.workflowExecutionId,
      });
      // Counter: workflow_message_ownership_drop
      return;
    }
    workflowExecutionId = msg.workflowExecutionId;
    workflowStepId = typeof msg.workflowStepId === 'string' ? msg.workflowStepId : null;
    workflowIterationPath = typeof msg.workflowIterationPath === 'string' ? msg.workflowIterationPath : null;
  }

  // ... existing writeMessage call, but extend with back-pointers:
  this.messageStore.writeMessage({
    id: workflowMsgId,
    role,
    content,
    parts: partsJson,
    channelType: workflowChannelType,
    channelId: workflowChannelId,
    opencodeSessionId: workflowOcSessionId,
    workflowExecutionId,
    workflowStepId,
    workflowIterationPath,
  });

  // ... existing broadcast, also include the new fields in `data`.
};
```

`isExecutionOwnedByUser` likely already exists — search for it; if not, add a tiny helper:

```typescript
async function isExecutionOwnedByUser(db: D1Database, executionId: string, userId: string): Promise<boolean> {
  const row = await db
    .prepare('SELECT user_id FROM workflow_executions WHERE id = ? LIMIT 1')
    .bind(executionId)
    .first<{ user_id: string }>();
  return !!row && row.user_id === userId;
}
```

- [ ] **Step 3: Update `MessageStore.writeMessage` if needed**

If the `writeMessage` signature doesn't already accept the new fields, extend it. The INSERT statement adds the three new columns.

- [ ] **Step 4: Typecheck + worker tests**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
cd /Users/connerswann/code/valet/packages/worker && pnpm test
```

Expected: clean and green.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts packages/worker/src/durable-objects/message-store.ts
git commit -m "feat(worker): workflow-chat-message validates ownership and persists back-pointers"
```

---

### Task D6: `workflow-context-bar.tsx`

**Files:**
- Create: `packages/client/src/components/workflows/workflow-context-bar.tsx`

- [ ] **Step 1: Implement**

```typescript
// packages/client/src/components/workflows/workflow-context-bar.tsx
import { Link } from '@tanstack/react-router';
import { useExecution, useExecutionSteps } from '@/api/executions';

interface Props {
  executionId: string;
}

export function WorkflowContextBar({ executionId }: Props) {
  const { data: execData } = useExecution(executionId);
  const execution = execData?.execution;
  const isTerminal = execution
    ? ['completed', 'failed', 'cancelled'].includes(execution.status)
    : false;
  const { data: stepsData } = useExecutionSteps(executionId, { isTerminal });
  if (!execution) return null;

  const topLevelSteps = (stepsData?.steps ?? []).filter((s) => s.iterationPath === '');
  const done = topLevelSteps.filter((s) => ['completed', 'failed', 'skipped'].includes(s.status)).length;
  const total = topLevelSteps.length;

  return (
    <div
      role="status"
      className="flex items-center gap-3 px-3 py-1.5 border-b border-border bg-surface-1 text-xs font-mono"
    >
      <span className="font-semibold text-foreground">{execution.workflowName ?? 'workflow'}</span>
      <span className="text-neutral-500">{executionId.slice(0, 8)}</span>
      <span className="text-neutral-500">step {done} / {total}</span>
      <div className="flex gap-0.5">
        {topLevelSteps.map((s) => (
          <span
            key={`${s.stepId}#${s.iterationPath}`}
            className={`h-1.5 w-3 rounded ${dotColor(s.status)}`}
            title={`${s.stepId} · ${s.status}`}
          />
        ))}
      </div>
      <Link
        to="/automation/executions/$executionId"
        params={{ executionId }}
        className="ml-auto text-accent hover:underline"
      >
        execution ↗
      </Link>
    </div>
  );
}

function dotColor(status: string): string {
  switch (status) {
    case 'completed': return 'bg-emerald-500';
    case 'failed':    return 'bg-red-500';
    case 'running':   return 'bg-amber-500';
    case 'cancelled': return 'bg-neutral-500';
    case 'skipped':   return 'bg-neutral-400';
    default:          return 'bg-neutral-300 dark:bg-neutral-700';
  }
}
```

- [ ] **Step 2: Typecheck + commit**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
git add packages/client/src/components/workflows/workflow-context-bar.tsx
git commit -m "feat(client): WorkflowContextBar"
```

---

### Task D7: `useSessionFeed` — merged messages + step rows

**Files:**
- Create: `packages/client/src/hooks/use-session-feed.ts`
- Create: `packages/client/src/hooks/use-session-feed.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// packages/client/src/hooks/use-session-feed.test.ts
import { describe, it, expect } from 'vitest';
import { mergeFeed } from './use-session-feed';

describe('mergeFeed', () => {
  it('interleaves messages and step rows by timestamp', () => {
    const messages = [
      { id: 'm1', role: 'user', content: 'hi', createdAt: 100, parts: null } as never,
      { id: 'm2', role: 'assistant', content: 'hello', createdAt: 300, parts: null } as never,
    ];
    const steps = [
      { stepId: 'A', iterationPath: '', createdAt: '1970-01-01T00:00:00.200Z' } as never,
    ];
    const feed = mergeFeed(messages, steps);
    expect(feed.map((x) => x.kind)).toEqual(['message', 'step', 'message']);
  });

  it('returns only messages when steps is empty', () => {
    const messages = [{ id: 'm1', createdAt: 1 } as never];
    expect(mergeFeed(messages, [])).toHaveLength(1);
  });

  it('returns only steps when messages is empty', () => {
    const steps = [{ stepId: 's', iterationPath: '', createdAt: '1970-01-01T00:00:01Z' } as never];
    expect(mergeFeed([], steps)).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Implement**

```typescript
// packages/client/src/hooks/use-session-feed.ts
import { useMemo } from 'react';
import type { Message } from '@/api/types';
import type { ExecutionStepTrace } from '@/api/executions';

export type FeedItem =
  | { kind: 'message'; timestamp: number; message: Message }
  | { kind: 'step'; timestamp: number; step: ExecutionStepTrace };

export function useSessionFeed(
  messages: Message[] | undefined,
  steps: ExecutionStepTrace[] | undefined,
): FeedItem[] {
  return useMemo(() => mergeFeed(messages ?? [], steps ?? []), [messages, steps]);
}

export function mergeFeed(messages: Message[], steps: ExecutionStepTrace[]): FeedItem[] {
  const items: FeedItem[] = [];
  for (const m of messages) {
    items.push({ kind: 'message', timestamp: toMs(m.createdAt), message: m });
  }
  for (const s of steps) {
    // Prefer startedAt (workflow event time) over createdAt (DB insertion time).
    // createdAt can lag startedAt during burst writes.
    const ts = s.startedAt ?? s.createdAt;
    items.push({ kind: 'step', timestamp: toMs(ts), step: s });
  }
  items.sort((a, b) => a.timestamp - b.timestamp);
  return items;
}

function toMs(t: number | string): number {
  if (typeof t === 'number') return t < 1e12 ? t * 1000 : t;
  return new Date(t).getTime();
}
```

- [ ] **Step 3: Run tests, verify pass**

```bash
cd /Users/connerswann/code/valet && pnpm vitest run packages/client/src/hooks/use-session-feed.test.ts
```

Expected: PASS, all three tests.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/hooks/use-session-feed.ts packages/client/src/hooks/use-session-feed.test.ts
git commit -m "feat(client): useSessionFeed merges messages + step rows by timestamp"
```

---

### Task D8: Workflow feed in chat behind `workflow_ui_chat_cards`

**Files:**
- Modify: `packages/client/src/components/chat/chat-container.tsx` (pull step rows here; ~line 475 is where `MessageList` mounts)
- Modify: `packages/client/src/components/chat/message-list.tsx` (interleave step cards inside the existing turn-rendering loop)

**Non-negotiable: preserve all existing `MessageList` behavior.** The current `MessageList` (around `message-list.tsx:55`) groups messages into turns via `groupIntoTurns`, renders `AssistantTurn`s with `onRevert`/`connectedUsers`, handles `childSessionEvents`/`childSessions`/child-session cards, shows the thinking indicator and agent status, manages scroll position/auto-scroll, and renders an empty state. **All of that must continue to work.** We are inserting workflow step cards into the existing render, not replacing the renderer.

`useExecutionSteps` does NOT have an `enabled` option (`packages/client/src/api/executions.ts:155`). It already short-circuits on a falsy `executionId` — pass `''` when we don't want it to run.

**Use `filteredMessages` (not `messages`)** as the source for the feed merge — the existing chat already drops messages outside the active thread for orchestrator sessions (`chat-container.tsx:205`). Step rows are not thread-scoped today and pass through as-is.

- [ ] **Step 1: In `chat-container.tsx`, fetch step rows when the flag is on**

```typescript
import { useFeatureFlag } from '@/lib/feature-flags';
import { useExecutionSteps } from '@/api/executions';

// ... inside ChatContainer, near the existing data hooks:
const useChatCards = useFeatureFlag('workflow_ui_chat_cards');
const executionId =
  useChatCards && session?.metadata?.executionId
    ? session.metadata.executionId
    : '';
const { data: stepsData } = useExecutionSteps(executionId, { isTerminal: false });
const workflowSteps = executionId ? stepsData?.steps : undefined;
```

(`session` is already in scope in `chat-container.tsx` — see the `session={{ id: sessionId, workspace: session.workspace, status: sessionStatus }}` line around 379.)

- [ ] **Step 2: Pass `workflowSteps` to `MessageList`**

In the `<MessageList ... />` mount around line 475, add the prop alongside the existing ones — do **not** replace existing props:

```tsx
<MessageList
  messages={filteredMessages}
  workflowSteps={workflowSteps}
  isAgentThinking={...}
  agentStatus={...}
  agentStatusDetail={...}
  onRevert={...}
  childSessionEvents={...}
  childSessions={...}
  connectedUsers={...}
/>
```

- [ ] **Step 3: `MessageList` interleaves step cards inside its existing render**

The existing render path: `messages -> groupIntoTurns -> turns.map(turn => render turn)`. Extend it to: `(messages, workflowSteps) -> mergeFeed -> renderedItems`, where each item is either a turn or a step row. Reuse `useSessionFeed` from D7 to produce a timestamp-ordered list, then build a per-render plan that maps each feed item to either a turn (run `groupIntoTurns` over runs of consecutive messages) or a step card.

Concretely:

```typescript
// packages/client/src/components/chat/message-list.tsx
import { WorkflowStepCard } from '@/components/workflows/step-cards';
import { useSessionFeed, type FeedItem } from '@/hooks/use-session-feed';
import type { ExecutionStepTrace } from '@/api/executions';

interface MessageListProps {
  messages: Message[];
  workflowSteps?: ExecutionStepTrace[]; // NEW
  // ... all existing props unchanged
}

export function MessageList({
  messages,
  workflowSteps,
  isAgentThinking,
  agentStatus,
  agentStatusDetail,
  onRevert,
  childSessionEvents,
  childSessions,
  connectedUsers,
}: MessageListProps) {
  // ... existing scrollRef, isAtBottom, drawer hooks, etc. unchanged.

  const feed = useSessionFeed(messages, workflowSteps);

  // Build a render plan: split the feed into runs of contiguous messages
  // (which get grouped into turns the existing way) and step items
  // (which render as WorkflowStepCard inline).
  const renderPlan = useMemo(() => buildRenderPlan(feed), [feed]);

  // Scroll/auto-scroll and empty-state must be FEED-aware, not messages-only.
  // Today the initial-scroll effect (~line 81) and any auto-scroll effects
  // depend on `messages.length`/`messages` identity. With workflow step rows
  // also driving render output, those effects need to fire on feed changes
  // too — otherwise a workflow-only update (no new chat message) won't scroll
  // and a workflow session with no chat messages would show the empty state.
  //
  // Concretely:
  // - Initial-scroll effect: change the dependency from `messages` to
  //   `[messages, workflowSteps]`, and change the `if (messages.length > 0...)`
  //   guard to `if (renderPlan.length > 0...)`.
  // - Any auto-scroll-on-new-content effect: same — react to feed length / last
  //   item identity, not just messages length.
  // - Empty state: check `messages.length === 0 && (workflowSteps?.length ?? 0) === 0`.

  return (
    <div ref={scrollRef} className="...">
      {messages.length === 0 && (workflowSteps?.length ?? 0) === 0 && !isAgentThinking && <EmptyState />}
      {renderPlan.map((item, i) =>
        item.kind === 'turns'
          ? item.turns.map((turn, j) => (
              <RenderTurn
                key={`turn-${i}-${j}`}
                turn={turn}
                onRevert={onRevert}
                connectedUsers={connectedUsers}
                /* ...same as the existing turn render call site */
              />
            ))
          : <WorkflowStepCard
              key={`step-${item.step.stepId}#${item.step.iterationPath}`}
              step={item.step}
            />
      )}
      {isAgentThinking && <ThinkingIndicator status={agentStatus} detail={agentStatusDetail} />}
      {childSessionEvents?.length ? <ChildSessionCards events={childSessionEvents} sessions={childSessions} /> : null}
    </div>
  );
}

type RenderPlanItem =
  | { kind: 'turns'; turns: MessageTurn[] }
  | { kind: 'step'; step: ExecutionStepTrace };

function buildRenderPlan(feed: FeedItem[]): RenderPlanItem[] {
  const out: RenderPlanItem[] = [];
  let runOfMessages: Message[] = [];
  const flushMessages = () => {
    if (runOfMessages.length === 0) return;
    out.push({ kind: 'turns', turns: groupIntoTurns(runOfMessages) });
    runOfMessages = [];
  };
  for (const item of feed) {
    if (item.kind === 'message') {
      runOfMessages.push(item.message);
    } else {
      flushMessages();
      out.push({ kind: 'step', step: item.step });
    }
  }
  flushMessages();
  return out;
}
```

`RenderTurn` here means the existing in-line code that renders an `assistant-turn` / `standalone` turn — pull it into a small inline component or keep the JSX inline. The key: every existing behavior continues to work; `WorkflowStepCard` items are simply additional render outputs interleaved at the right timestamps.

When `workflowSteps` is undefined (non-workflow session, or flag off), `useSessionFeed` returns the messages-only feed, `buildRenderPlan` produces a single `{ kind: 'turns', turns }` item, and rendering is identical to today.

- [ ] **Step 4: Typecheck**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Expected: clean.

- [ ] **Step 5: Browser smoke — both paths**

```bash
cd /Users/connerswann/code/valet/packages/client && pnpm dev
```

Smoke test 1 (regression): open a **non-workflow** session. Verify the chat looks and behaves identically — turns group, revert works, thinking indicator shows, child-session cards render, scroll-to-bottom works.

Smoke test 2 (new path): `localStorage.setItem('flag:workflow_ui_chat_cards', 'on')`. Refresh a **workflow** session chat. Verify the same chat behaviors plus workflow step cards interleaved at the right timestamps.

Smoke test 3 (step-only updates auto-scroll): in a workflow session with the user scrolled to the bottom, trigger a step that emits only step rows (no chat messages — e.g. a `bash` step). Verify the timeline scrolls to keep the new card in view.

Smoke test 4 (empty state suppressed during workflow-only): open a new workflow session that has emitted step rows but no chat messages yet. Verify the empty state does NOT appear.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/components/chat/chat-container.tsx packages/client/src/components/chat/message-list.tsx
git commit -m "feat(client): interleave workflow step cards in chat behind workflow_ui_chat_cards"
```

---

### Task D9: Mount `WorkflowContextBar` in `ChatContainer`

**Files:**
- Modify: `packages/client/src/components/chat/chat-container.tsx`

**Why here:** The context bar belongs immediately above the chat scroll region. `ChatContainer` already owns that layout. The session routes (`routes/sessions/$sessionId.tsx` and `routes/sessions/$sessionId/index.tsx`) mount `ChatContainer`; threading the bar through them would be a longer path.

- [ ] **Step 1: Mount the bar conditionally**

`ChatContainer` already has `executionId` in scope from D8 (or compute it here independently, same expression). Render the bar above the chat content:

```tsx
import { WorkflowContextBar } from '@/components/workflows/workflow-context-bar';

// ... in the JSX, immediately above the chat header / message list:
{executionId && <WorkflowContextBar executionId={executionId} />}
```

The exact insertion point: find the `<MessageList ... />` mount near line 475 and place the bar above the chat's outer scroll container or above the header section that contains the message list.

- [ ] **Step 2: Typecheck + browser smoke**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Open a workflow session in dev with the flag on. Expected: bar visible above the chat, progress dots reflect execution state.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/components/chat/chat-container.tsx
git commit -m "feat(client): mount WorkflowContextBar in ChatContainer for workflow sessions"
```

---

### Task D10: Phase D telemetry counters

**Files:**
- Modify: `packages/client/src/hooks/use-session-feed.ts`
- Modify: `packages/client/src/components/workflows/step-cards/agent-prompt-card.tsx`

- [ ] **Step 1: Count `WORKFLOW_MESSAGE_NO_STEP` in the feed merge**

After merging, scan for messages with `workflowExecutionId` set but no matching step row:

```typescript
const stepKeys = new Set(steps.map((s) => `${s.stepId}#${s.iterationPath}`));
for (const m of messages) {
  if (m.workflowExecutionId && m.workflowStepId != null) {
    const key = `${m.workflowStepId}#${m.workflowIterationPath ?? ''}`;
    if (!stepKeys.has(key)) {
      bump(WORKFLOW_TELEMETRY.WORKFLOW_MESSAGE_NO_STEP, { messageId: m.id });
    }
  }
}
```

- [ ] **Step 2: Count `AGENT_PROMPT_RESPONSE_MISSING`**

In `agent-prompt-card.tsx`, in the `renderResponse` branch where `status === 'completed'` but `output` is null:

```typescript
if (!output) {
  bump(WORKFLOW_TELEMETRY.AGENT_PROMPT_RESPONSE_MISSING, { stepId: step.stepId, iterationPath: step.iterationPath });
  return <p className="font-mono text-[11px] text-neutral-500">(no response)</p>;
}
```

- [ ] **Step 3: Typecheck + commit**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
git add packages/client/src/hooks/use-session-feed.ts packages/client/src/components/workflows/step-cards/agent-prompt-card.tsx
git commit -m "obs(client): phase 2 workflow telemetry"
```

---

### Task D11: Dogfood gate — Phase 2

With `workflow_ui_chat_cards` on for dev users:

- [ ] **Scenario A:** Open a workflow session with an in-flight run. Verify: context bar visible, `agent_prompt` step cards interleave with chat bubbles in chronological order.
- [ ] **Scenario B:** Workflow with a loop that emits 3 `agent_prompt` prompts. Verify: 3 prompt bubbles + 3 response bubbles in chat, AND 3 separate step cards (one per iteration) interleaved at the right timestamps.
- [ ] **Scenario C:** Send a user chat message between two workflow steps. Verify: it appears in the right chronological position; workflow continues normally.
- [ ] **Scenario D:** Notify step that fails. Verify: step card shows error inline in chat; user can ask "why?" and continue normally.

- [ ] **Sign-off:**

```bash
git commit --allow-empty -m "ops(workflows): phase 2 dogfood passed — 4/4 scenarios"
```

---

## Spec-coverage self-check

Cross-referencing this plan against `docs/specs/2026-05-23-workflow-ui-design.md`:

| Spec section | Tasks |
|--|--|
| §1 iterationPath end-to-end | A1–A6, A8–A11 |
| §1 approval wait/resume | A12 |
| §1 retry-from-step | A13 |
| §2 agent_prompt output shape | B1 |
| §2 notify output shape | B2 |
| §2 approval output shape | B3 |
| §2 bash output type-lock | B4 |
| §3 message back-pointers | D1, D2 |
| §3 workflow-chat-message extension | D3, D4 |
| §3 DO ownership validation | D5 |
| §4 explicit non-changes | (no task — verified by absence) |
| Execution page split layout | C18 |
| Step card behavior (auto-expand, elapsed time) | C5 (elapsed), C15 (auto-expand) |
| Per-type rendering table | C4–C12 |
| Approval limitations note | C8 |
| Loops/parallel/conditional reconstruction | C14, C10–C12 |
| Diagram rail | C16 |
| Retry & recovery affordances | C17.5 (retry-workflow footer on failed cards; nested retry remains unsupported per A13) |
| Workflow context bar | D6, D9 |
| Workflow steps as interleaved cards | D7, D8 |
| ToolCardShell extension | C2 |
| Accessibility | C2 (aria-expanded), C11 (tablist), D6 (role=status) |
| Phasing & feature flags | C1, C18, C20, D8, D9 |
| Dogfood plan | C19, D11 |
| Telemetry | C17, D10 |
| Performance: memoization | C14, D7 |

**On inline retry:** Resolved via Task A13 (nested retry-from-step stays unsupported) + Task C17.5 (failed-card footer dispatches the whole workflow from the top). The "↗ open in builder" deep-link is dropped — adding it requires a query-param-aware builder route that doesn't yet exist; can be added in v1.1.

---

## Plan complete

Plan saved to `docs/plans/2026-05-25-workflow-ui-redesign.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
