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
- `packages/client/src/components/chat/message-list.tsx` — flag-gated session-feed integration (D)
- `packages/client/src/routes/sessions/$sessionId.tsx` — mount context bar (D)

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

### Task A7: `upsertExecutionStep` accepts `iterationPath`

**Files:**
- Modify: `packages/worker/src/lib/db/executions.ts`

- [ ] **Step 1: Update the function signature and SQL**

Find `upsertExecutionStep` around line 198. Add `iterationPath: string` to the input type, default to `''` if absent, and include it in the `INSERT` + `ON CONFLICT` clauses:

```typescript
export async function upsertExecutionStep(
  db: D1Database,
  executionId: string,
  step: {
    stepId: string;
    attempt: number;
    iterationPath?: string;
    status: string;
    input?: string | null;
    output?: string | null;
    error?: string | null;
    startedAt?: string | null;
    completedAt?: string | null;
  },
): Promise<void> {
  const id = crypto.randomUUID();
  const iterationPath = step.iterationPath ?? '';
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
      iterationPath,
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

Expected: clean. Callers still work because `iterationPath` is optional with a default.

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

In `packages/worker/src/services/executions.ts` around line 455 (`upsertExecutionStepFromEvent`), pass `iterationPath` into `upsertExecutionStep`:

```typescript
await upsertExecutionStep(db, executionId, {
  stepId: ev.stepId,
  attempt: ev.attempt,
  iterationPath: ev.iterationPath ?? '',
  status: ev.status,
  // ...
});
```

- [ ] **Step 3: Update the admin/test path**

Around line 231 of the same file (`upsertExecutionStep(env.DB, executionId, { ... })`), pass `iterationPath: step.iterationPath ?? ''` from the inbound step.

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

- [ ] **Step 2: Include `iterationPath` and `attempt` in the persisted runtime state**

Wherever the executor stashes the awaiting step (e.g., `runtime_state.awaitingApproval = { stepId, ... }`), extend to `{ stepId, iterationPath, attempt }`. Read it back on resume.

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

### Task A13: Retry-from-step preserves and matches `iterationPath`

**Files:**
- Modify: `packages/worker/src/services/session-workflows.ts`
- Modify: `packages/runner/src/workflow-engine.ts`

- [ ] **Step 1: Replay context carries `iterationPath` on every step**

Around `session-workflows.ts:423` (`retryExecutionFromStep`), the `replayStepResults` object is built from the prior execution's step rows. Make sure each row in that object has `iterationPath` populated from the source row.

- [ ] **Step 2: The retry directive identifies the target step by `(stepId, iterationPath)`**

Around the same area, the `runtimeState.retry` object stores `{ startFromStepId, ... }`. Add `startFromIterationPath: targetStepIterationPath` (read from the source row when `targetStepId` was originally executed; if the source row's `iterationPath` is non-empty, the retry targets that specific instance).

- [ ] **Step 3: Runner resume locates the start step by the path-pair**

In `packages/runner/src/workflow-engine.ts`, the resume/replay logic uses `replayStepResults`. When seeding outputs from prior results, match on `(stepId, iterationPath)` — not just `stepId`. Update the lookup helper accordingly.

- [ ] **Step 4: Typecheck + tests**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck && pnpm test
```

Expected: clean and green.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/services/session-workflows.ts packages/runner/src/workflow-engine.ts
git commit -m "feat(workflows): retry-from-step preserves iterationPath end-to-end"
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

The `onAgentStep` hook returns a `WorkflowStepExecutionResult` with an `output` field. Find where the response is collected — around lines 1500–1550 in `prompt.ts`.

- [ ] **Step 2: Shape the output**

Where the current code sets `output: parseResult.data` or `output: recoveredResponse`, replace with:

```typescript
output: {
  response: parseResult.data, // or recoveredResponse, or the parsed string
  model: ctx.modelId,         // pulled from the OpenCode response
  inputTokens: ctx.usage?.inputTokens ?? 0,
  outputTokens: ctx.usage?.outputTokens ?? 0,
  durationMs: Date.now() - stepStartMs,
}
```

You'll need access to the OpenCode response metadata. If `modelId` / `usage` aren't already plumbed where output is assembled, lift the `agent.run` return into a local variable and pull from it.

- [ ] **Step 3: Write a vitest test**

If there's a `prompt.test.ts` or similar, add a test that mocks `agent.run` and asserts the output shape. If not, append to `packages/runner/src/workflow-engine.test.ts` a test that uses the test harness with a mock `onAgentStep` hook and asserts the envelope's step output matches the shape.

```typescript
it('agent_prompt output is shaped as { response, model, inputTokens, outputTokens, durationMs }', async () => {
  const workflow = compileForTest({
    steps: [{ id: 'ask', type: 'agent_prompt', prompt: 'hi' }],
  });
  const envelope = await runWorkflowForTest(workflow, {
    hooks: {
      onAgentStep: async () => ({
        status: 'completed',
        output: {
          response: 'world',
          model: 'claude-opus-4-6',
          inputTokens: 12,
          outputTokens: 5,
          durationMs: 42,
        },
      }),
    },
  });
  const step = envelope.steps.find((s) => s.stepId === 'ask');
  expect(step?.output).toMatchObject({
    response: 'world',
    model: 'claude-opus-4-6',
    inputTokens: 12,
    outputTokens: 5,
  });
});
```

- [ ] **Step 4: Run tests**

```bash
cd /Users/connerswann/code/valet/packages/runner && pnpm test
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/runner/src/prompt.ts packages/runner/src/workflow-engine.test.ts
git commit -m "feat(runner): agent_prompt output is { response, model, tokens, durationMs }"
```

---

### Task B2: `notify` output adds `channelType`, `channelId`, `error`

**Files:**
- Modify: `packages/runner/src/workflow-engine.ts` (look around line 374) or wherever the `notify` handler actually lives

- [ ] **Step 1: Find the notify result construction**

Currently `notify` returns:
```typescript
{ type: 'notify', target: typeof step.target === 'string' ? step.target : 'orchestrator', delivered: false }
```

- [ ] **Step 2: Shape the output**

```typescript
{
  type: 'notify',
  target: resolvedTarget,
  channelType: resolvedChannelType,  // parsed from target, e.g. 'slack' from 'slack:#channel'
  channelId: resolvedChannelId,      // parsed from target, e.g. '#channel'
  delivered,                          // false until a real notify handler lands
  error: deliveryError ?? null,
}
```

The target-string parser belongs in this same file as a small helper:

```typescript
function parseNotifyTarget(target: string): { channelType: string; channelId: string } {
  const idx = target.indexOf(':');
  if (idx < 0) return { channelType: 'orchestrator', channelId: target };
  return { channelType: target.slice(0, idx), channelId: target.slice(idx + 1) };
}
```

- [ ] **Step 3: Write a vitest test for `parseNotifyTarget`**

```typescript
import { describe, it, expect } from 'vitest';
import { parseNotifyTarget } from './workflow-engine.js';

describe('parseNotifyTarget', () => {
  it('splits on the first colon', () => {
    expect(parseNotifyTarget('slack:#general')).toEqual({ channelType: 'slack', channelId: '#general' });
  });
  it('defaults to orchestrator for un-colon-delimited targets', () => {
    expect(parseNotifyTarget('me')).toEqual({ channelType: 'orchestrator', channelId: 'me' });
  });
});
```

If `parseNotifyTarget` isn't exported, export it.

- [ ] **Step 4: Run + commit**

```bash
cd /Users/connerswann/code/valet/packages/runner && pnpm test
git add packages/runner/src/workflow-engine.ts packages/runner/src/workflow-engine.test.ts
git commit -m "feat(runner): notify output exposes channelType, channelId, error"
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
cd /Users/connerswann/code/valet/packages/client && pnpm test -- feature-flags
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

- [ ] **Step 1: Implement**

```typescript
// packages/client/src/components/workflows/step-cards/fallback-card.tsx
import { ToolCardShell, ToolCardSection, ToolCodeBlock } from '@/components/chat/tool-cards/tool-card-shell';
import { StepIcon } from './icons';
import type { WorkflowStepCardProps } from './index';

export function FallbackCard({ step, open, onOpenChange }: WorkflowStepCardProps) {
  const summary = `${step.stepId} · ${step.type}`;
  const status = mapStatus(step.status);
  const output = step.outputJson
    ? safeStringify(step.outputJson)
    : null;

  return (
    <ToolCardShell
      icon={<StepIcon kind="fallback" />}
      label={step.type}
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

function safeStringify(s: string): string {
  try {
    return JSON.stringify(JSON.parse(s), null, 2);
  } catch {
    return s;
  }
}

function mapStatus(status: string): 'pending' | 'running' | 'completed' | 'error' {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'running' || status === 'waiting_approval') return 'running';
  return 'pending';
}
```

`WorkflowStepCardProps` is defined in Task C12 — the type already needs to exist by the time C4 compiles. For ordering convenience: define a stub in `index.tsx` first as part of this task (move the dispatcher implementation to C12):

```typescript
// packages/client/src/components/workflows/step-cards/index.tsx (stub for now)
import type { ExecutionStepTrace } from '@/api/executions';

export interface WorkflowStepCardProps {
  step: ExecutionStepTrace;
  /** Container child rows if this is a loop/parallel/conditional. */
  children?: ExecutionStepTrace[];
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
  workflowDef?: unknown; // tightened in C12
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
  const input = parse(step.inputJson);
  const output = parse(step.outputJson) as AgentPromptOutput | null;
  const persona = (input as { persona?: string } | null)?.persona;
  const prompt = (input as { prompt?: string; content?: string; message?: string; goal?: string } | null);
  const promptText = prompt?.prompt ?? prompt?.content ?? prompt?.message ?? prompt?.goal ?? '';

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

function parse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function mapStatus(status: string): 'pending' | 'running' | 'completed' | 'error' {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'running' || status === 'waiting_approval') return 'running';
  return 'pending';
}
```

- [ ] **Step 2: Typecheck + browser smoke**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Expected: clean. (The component isn't wired up yet; visual check waits for Task C13.)

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
  const input = parse(step.inputJson) as BashInput | null;
  const output = parse(step.outputJson) as BashOutput | null;
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

function parse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
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

interface NotifyOutput {
  target?: string;
  channelType?: string;
  channelId?: string;
  delivered?: boolean;
  error?: string | null;
}

export function NotifyCard({ step, open, onOpenChange }: WorkflowStepCardProps) {
  const output = parse(step.outputJson) as NotifyOutput | null;
  const status = mapStatus(step.status);
  const target = output?.channelType && output?.channelId
    ? `${output.channelType}:${output.channelId}`
    : output?.target ?? '(unknown)';
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

function parse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
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
  const output = parse(step.outputJson) as ApprovalOutput | null;
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

function parse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
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

### Task C9: `step-cards/tool-card.tsx`

**Files:**
- Create: `packages/client/src/components/workflows/step-cards/tool-card.tsx`

- [ ] **Step 1: Implement — delegate to the existing chat tool-card registry**

```typescript
// packages/client/src/components/workflows/step-cards/tool-card.tsx
import { ToolCardShell, ToolCardSection, ToolCodeBlock } from '@/components/chat/tool-cards/tool-card-shell';
import { StepIcon } from './icons';
import type { WorkflowStepCardProps } from './index';

interface ToolInput { tool?: string; arguments?: unknown; }

export function ToolCard({ step, open, onOpenChange }: WorkflowStepCardProps) {
  const input = parse(step.inputJson) as ToolInput | null;
  const output = parse(step.outputJson);
  const status = mapStatus(step.status);

  return (
    <ToolCardShell
      icon={<StepIcon kind="tool" />}
      label="tool"
      status={status}
      summary={`${step.stepId} · ${input?.tool ?? '(unknown)'}`}
      open={open}
      onOpenChange={onOpenChange}
      id={`step-${step.stepId}-${step.iterationPath}`}
      defaultExpanded={status === 'error'}
    >
      {input?.tool && (
        <ToolCardSection label="tool">
          <p className="font-mono text-[11px] text-neutral-700 dark:text-neutral-300">{input.tool}</p>
        </ToolCardSection>
      )}
      {input?.arguments != null && (
        <ToolCardSection label="arguments">
          <ToolCodeBlock>{JSON.stringify(input.arguments, null, 2)}</ToolCodeBlock>
        </ToolCardSection>
      )}
      {output != null && (
        <ToolCardSection label="output">
          <ToolCodeBlock>{typeof output === 'string' ? output : JSON.stringify(output, null, 2)}</ToolCodeBlock>
        </ToolCardSection>
      )}
    </ToolCardShell>
  );
}

function parse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
}

function mapStatus(status: string): 'pending' | 'running' | 'completed' | 'error' {
  if (status === 'completed') return 'completed';
  if (status === 'failed' || status === 'cancelled') return 'error';
  if (status === 'running') return 'running';
  return 'pending';
}
```

A deeper tool-name dispatch into `chat/tool-cards/*` can come later — for v1 this generic shape is sufficient.

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
  const input = parse(step.inputJson) as ConditionalInput | null;
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

function parse(s: string | null): unknown {
  if (!s) return null;
  try { return JSON.parse(s); } catch { return null; }
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

export interface WorkflowStepCardProps {
  step: ExecutionStepTrace;
  children?: ExecutionStepTrace[];
  open?: boolean;
  onOpenChange?: (next: boolean) => void;
  workflowDef?: WorkflowData | null;
}

export function WorkflowStepCard(props: WorkflowStepCardProps) {
  const stepType = useMemo(() => resolveType(props.step, props.workflowDef), [props.step, props.workflowDef]);
  switch (stepType) {
    case 'agent_prompt': return <AgentPromptCard {...props} />;
    case 'bash':         return <BashCard {...props} />;
    case 'notify':       return <NotifyCard {...props} />;
    case 'approval':     return <ApprovalCard {...props} />;
    case 'conditional':  return <ConditionalCard {...props} />;
    case 'loop':         return <LoopCard {...props} />;
    case 'parallel':     return <ParallelCard {...props} />;
    case 'tool':         return <ToolCard {...props} />;
    default:             return <FallbackCard {...props} />;
  }
}

function resolveType(step: ExecutionStepTrace, workflowDef?: WorkflowData | null): string {
  // Prefer the static workflow definition; fall back to inputJson.type.
  const fromDef = workflowDef ? findStepType(workflowDef.steps, step.stepId) : null;
  if (fromDef) return fromDef;
  try {
    const input = step.inputJson ? JSON.parse(step.inputJson) : null;
    if (input && typeof input === 'object' && typeof (input as { type?: unknown }).type === 'string') {
      return (input as { type: string }).type;
    }
  } catch {}
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

### Task C14: `useExecutionTimeline` — memoized view-model

**Files:**
- Create: `packages/client/src/hooks/use-execution-timeline.ts`
- Create: `packages/client/src/hooks/use-execution-timeline.test.ts`

- [ ] **Step 1: Write tests**

```typescript
// packages/client/src/hooks/use-execution-timeline.test.ts
import { describe, it, expect } from 'vitest';
import { buildTimelineViewModel } from './use-execution-timeline';

const def = {
  steps: [
    { id: 'A', type: 'bash', command: 'echo a' },
    {
      id: 'L', type: 'loop', over: '{{ items }}',
      steps: [{ id: 'inner', type: 'bash', command: 'echo {{ loop.item }}' }],
    },
  ],
};

describe('buildTimelineViewModel', () => {
  it('places top-level steps in the order of the static definition', () => {
    const vm = buildTimelineViewModel(def as never, [
      { stepId: 'A', iterationPath: '', status: 'completed', attempt: 1, startedAt: '', completedAt: '', inputJson: null, outputJson: null, error: null, id: 'r1', createdAt: '' },
      { stepId: 'L', iterationPath: '', status: 'completed', attempt: 1, startedAt: '', completedAt: '', inputJson: null, outputJson: null, error: null, id: 'r2', createdAt: '' },
    ]);
    expect(vm.map((x) => x.step.stepId)).toEqual(['A', 'L']);
  });

  it('attaches loop child rows to their parent under children', () => {
    const vm = buildTimelineViewModel(def as never, [
      { stepId: 'L', iterationPath: '', status: 'completed', attempt: 1, startedAt: '', completedAt: '', inputJson: null, outputJson: null, error: null, id: 'r2', createdAt: '' },
      { stepId: 'inner', iterationPath: 'L:i0', status: 'completed', attempt: 1, startedAt: '', completedAt: '', inputJson: null, outputJson: null, error: null, id: 'r3', createdAt: '' },
      { stepId: 'inner', iterationPath: 'L:i1', status: 'completed', attempt: 1, startedAt: '', completedAt: '', inputJson: null, outputJson: null, error: null, id: 'r4', createdAt: '' },
    ]);
    const loop = vm.find((x) => x.step.stepId === 'L');
    expect(loop?.children?.map((c) => c.iterationPath)).toEqual(['L:i0', 'L:i1']);
  });
});
```

- [ ] **Step 2: Run, verify fail**

```bash
cd /Users/connerswann/code/valet/packages/client && pnpm test -- use-execution-timeline
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement**

```typescript
// packages/client/src/hooks/use-execution-timeline.ts
import { useMemo } from 'react';
import type { ExecutionStepTrace } from '@/api/executions';
import type { WorkflowData, WorkflowStep } from '@/api/workflows';

export interface TimelineNode {
  step: ExecutionStepTrace;
  children?: ExecutionStepTrace[];
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
    // Source workflow deleted with no snapshot — render flat in createdAt order.
    return [...stepRows]
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((s) => ({ step: s }));
  }

  const rowsByStepId = new Map<string, ExecutionStepTrace[]>();
  for (const r of stepRows) {
    const list = rowsByStepId.get(r.stepId);
    if (list) list.push(r); else rowsByStepId.set(r.stepId, [r]);
  }

  const allContainerStepIds = collectContainerStepIds(workflowDef.steps);

  // Top-level: for each top-level step in the static def, find its top-level row
  // (iterationPath === ''). For container steps, attach all rows whose iterationPath
  // begins with that step's id.
  const out: TimelineNode[] = [];
  for (const defStep of workflowDef.steps) {
    const topRows = (rowsByStepId.get(defStep.id) ?? []).filter((r) => r.iterationPath === '');
    const topRow = topRows[0];
    if (!topRow) continue;

    if (allContainerStepIds.has(defStep.id)) {
      const children = stepRows.filter((r) =>
        r.iterationPath.startsWith(`${defStep.id}:`) ||
        r.iterationPath.startsWith(`${defStep.id}/`)
      );
      out.push({ step: topRow, children });
    } else {
      out.push({ step: topRow });
    }
  }
  return out;
}

function collectContainerStepIds(steps: WorkflowStep[]): Set<string> {
  const out = new Set<string>();
  walk(steps, out);
  return out;
}

function walk(steps: WorkflowStep[], acc: Set<string>): void {
  for (const s of steps) {
    if (s.type === 'loop' || s.type === 'parallel' || s.type === 'conditional') {
      acc.add(s.id);
    }
    for (const sub of [s.then, s.else, s.steps]) {
      if (Array.isArray(sub)) walk(sub as WorkflowStep[], acc);
    }
  }
}
```

- [ ] **Step 4: Run, verify pass**

```bash
cd /Users/connerswann/code/valet/packages/client && pnpm test -- use-execution-timeline
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/hooks/use-execution-timeline.ts packages/client/src/hooks/use-execution-timeline.test.ts
git commit -m "feat(client): useExecutionTimeline view-model"
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

- [ ] **Step 2: Wire orphan-row detection into the timeline view-model**

In `packages/client/src/hooks/use-execution-timeline.ts`, after `buildTimelineViewModel` runs in the hook, count rows that didn't land in any node:

```typescript
import { bump, WORKFLOW_TELEMETRY } from '@/lib/workflow-telemetry';

// inside useExecutionTimeline, after building the view-model:
useMemo(() => {
  const placedKeys = new Set<string>();
  for (const node of vm) {
    placedKeys.add(`${node.step.stepId}#${node.step.iterationPath}`);
    for (const c of node.children ?? []) {
      placedKeys.add(`${c.stepId}#${c.iterationPath}`);
    }
  }
  for (const r of stepRows ?? []) {
    if (!placedKeys.has(`${r.stepId}#${r.iterationPath}`)) {
      bump(WORKFLOW_TELEMETRY.ORPHAN_STEP_ROW, { stepId: r.stepId, iterationPath: r.iterationPath });
    }
  }
}, [vm, stepRows]);
```

- [ ] **Step 3: Wire fallback-renderer-used into the dispatcher**

In `packages/client/src/components/workflows/step-cards/index.tsx`, in the `default:` arm of the switch:

```typescript
import { bump, WORKFLOW_TELEMETRY } from '@/lib/workflow-telemetry';
// ...
default:
  bump(WORKFLOW_TELEMETRY.FALLBACK_RENDERER_USED, { type: stepType });
  return <FallbackCard {...props} />;
```

- [ ] **Step 4: Typecheck + commit**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
git add packages/client/src/lib/workflow-telemetry.ts packages/client/src/hooks/use-execution-timeline.ts packages/client/src/components/workflows/step-cards/index.tsx
git commit -m "obs(client): workflow UI telemetry counters"
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

### Task D2: Drizzle schema update for messages

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
git commit -m "feat(worker): drizzle schema for message workflow back-pointers"
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

- [ ] **Step 1: Locate the two emit sites**

Search:

```bash
grep -n "sendWorkflowChatMessage" /Users/connerswann/code/valet/packages/runner/src/prompt.ts
```

Two hits: 1375 (prompt) and 1463 (assistant recovery response).

- [ ] **Step 2: Update both calls to use the new context shape**

The runner's prompt-execution path has access to `executionId`, the current step's `id`, and the engine's `iterationPath` via `ctx`. Wire them through:

```typescript
this.agentClient.sendWorkflowChatMessage("user", content, {
  channelType: ...,
  channelId: ...,
  opencodeSessionId: ...,
  workflowExecutionId: ctx.executionId,
  workflowStepId: step.id,
  workflowIterationPath: ctx.iterationPath,
});
```

And the recovery-response call:

```typescript
this.agentClient.sendWorkflowChatMessage("assistant", recoveredResponse, {
  channelType: ...,
  channelId: ...,
  opencodeSessionId: ...,
  workflowExecutionId: ctx.executionId,
  workflowStepId: step.id,
  workflowIterationPath: ctx.iterationPath,
});
```

If `ctx` isn't in scope at the response-recovery callsite, plumb it through; this is a small lift and unblocks all the chat UI.

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
    items.push({ kind: 'step', timestamp: toMs(s.createdAt), step: s });
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
cd /Users/connerswann/code/valet/packages/client && pnpm test -- use-session-feed
```

Expected: PASS, all three tests.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/hooks/use-session-feed.ts packages/client/src/hooks/use-session-feed.test.ts
git commit -m "feat(client): useSessionFeed merges messages + step rows by timestamp"
```

---

### Task D8: `MessageList` flag-gated workflow feed

**Files:**
- Modify: `packages/client/src/components/chat/message-list.tsx`

- [ ] **Step 1: Branch on the flag**

```typescript
import { useFeatureFlag } from '@/lib/feature-flags';
import { useSessionFeed } from '@/hooks/use-session-feed';
import { useExecutionSteps } from '@/api/executions';
import { WorkflowStepCard } from '@/components/workflows/step-cards';

export function MessageList({ messages, ...rest }: Props) {
  const useChatCards = useFeatureFlag('workflow_ui_chat_cards');
  const session = rest.session; // surface session from props if not already
  const executionId = useChatCards ? session?.metadata?.executionId : undefined;
  const { data: stepsData } = useExecutionSteps(executionId ?? '', { enabled: !!executionId });
  const feed = useSessionFeed(messages, stepsData?.steps);

  if (!useChatCards || !executionId) {
    return <LegacyMessageList messages={messages} {...rest} />;
  }

  // Render the merged feed; for kind === 'message', use the same per-message
  // path as LegacyMessageList; for kind === 'step', render a WorkflowStepCard.
  return (
    <div className="flex flex-col gap-2">
      {feed.map((item, i) =>
        item.kind === 'message'
          ? <MessageItem key={item.message.id} message={item.message} />
          : <WorkflowStepCard key={`${item.step.stepId}#${item.step.iterationPath}`} step={item.step} />
      )}
    </div>
  );
}
```

The legacy path stays so we can flip the flag off without code surgery.

- [ ] **Step 2: Typecheck**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Expected: clean.

- [ ] **Step 3: Browser smoke**

```bash
cd /Users/connerswann/code/valet/packages/client && pnpm dev
```

In console: `localStorage.setItem('flag:workflow_ui_chat_cards', 'on')`. Refresh a workflow session chat. Expected: workflow step cards interleave with chat messages by timestamp.

- [ ] **Step 4: Commit**

```bash
git add packages/client/src/components/chat/message-list.tsx
git commit -m "feat(client): chat workflow feed behind workflow_ui_chat_cards"
```

---

### Task D9: Mount `WorkflowContextBar` on session route

**Files:**
- Modify: `packages/client/src/routes/sessions/$sessionId.tsx`

- [ ] **Step 1: Read the session's executionId and mount the bar**

```typescript
import { WorkflowContextBar } from '@/components/workflows/workflow-context-bar';
import { useFeatureFlag } from '@/lib/feature-flags';
// ...
const useChatCards = useFeatureFlag('workflow_ui_chat_cards');
const executionId = useChatCards ? session?.metadata?.executionId : undefined;
// ...
{executionId && <WorkflowContextBar executionId={executionId} />}
// ... above the chat
```

- [ ] **Step 2: Typecheck + browser smoke**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Open a workflow session in dev with the flag on. Expected: bar visible, progress dots reflect execution state.

- [ ] **Step 3: Commit**

```bash
git add packages/client/src/routes/sessions/\$sessionId.tsx
git commit -m "feat(client): mount WorkflowContextBar on workflow sessions"
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
| Retry & recovery affordances | (inherits from existing ExecutionHeader; inline buttons on failed cards left as a v1.1 follow-up — confirm w/ user) |
| Workflow context bar | D6, D9 |
| Workflow steps as interleaved cards | D7, D8 |
| ToolCardShell extension | C2 |
| Accessibility | C2 (aria-expanded), C11 (tablist), D6 (role=status) |
| Phasing & feature flags | C1, C18, C20, D8, D9 |
| Dogfood plan | C19, D11 |
| Telemetry | C17, D10 |
| Performance: memoization | C14, D7 |

**Note on inline retry buttons:** The spec calls for inline `↻ retry from here` and `↗ open in builder` on failed step cards. Adding these to each step-card renderer in v1 would require threading `useRetryExecutionFromStep` and route navigation into 9 components. Two choices for the implementer:

1. Add them in a thin overlay rendered by `ExecutionTimeline` next to expanded failed cards (one component, one wiring point).
2. Add them as a uniform footer in `WorkflowStepCard` (the dispatcher) when `step.status === 'failed'`.

Option 2 is simpler. Add it as a new task here when implementing if the user prefers; otherwise the page-level `ExecutionHeader` retry remains the only path.

---

## Plan complete

Plan saved to `docs/plans/2026-05-25-workflow-ui-redesign.md`.

**Two execution options:**

1. **Subagent-Driven (recommended)** — I dispatch a fresh subagent per task, review between tasks, fast iteration.

2. **Inline Execution** — execute tasks in this session using executing-plans, batch execution with checkpoints.

Which approach?
