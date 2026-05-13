# Trigger Idempotent Upsert Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix trigger `createdAt` reset after sandbox restore by making trigger sync idempotent by name, enforced with a DB uniqueness constraint.

**Architecture:** Add `UNIQUE(user_id, name)` to the triggers table. Replace the fragile 80-line fallback upsert logic in `handleTriggerAction` with a single `upsertTriggerByName()` helper. The runner sends a new `"sync"` action instead of `"create"`. Tool descriptions are updated to reflect idempotent-by-name semantics.

**Tech Stack:** D1 (SQLite), Drizzle ORM, Cloudflare Workers, Bun (runner/tools)

**Spec:** `docs/specs/2026-05-12-trigger-idempotent-upsert-design.md`

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Create | `packages/worker/migrations/0011_trigger_name_uniqueness.sql` | Dedup + UNIQUE index migration |
| Modify | `packages/worker/src/lib/schema/workflows.ts:24-41` | Add uniqueIndex to Drizzle schema |
| Modify | `packages/worker/src/lib/db/triggers.ts` | Add `upsertTriggerByName()`, delete 3 fallback functions |
| Modify | `packages/worker/src/services/session-workflows.ts:6,508-669` | Add "sync" action, alias "create" to sync, simplify logic |
| Modify | `packages/runner/src/agent-client.ts:644` | Send `"sync"` instead of `"create"` |
| Modify | `docker/opencode/tools/sync_trigger.ts:53-57` | Update descriptions for idempotency |
| Modify | `docker/opencode/tools/delete_trigger.ts` | Add name-based delete |
| Modify | `docker/opencode/tools/list_triggers.ts:20-21` | Remove "list before creating" guidance |
| Modify | `packages/plugin-workflows/skills/workflows.md:68-86,234-237` | Cron timezone docs, idempotent trigger guidance |

---

### Task 1: D1 Migration — Dedup and UNIQUE Constraint

**Files:**
- Create: `packages/worker/migrations/0011_trigger_name_uniqueness.sql`

- [ ] **Step 1: Create the migration file**

```sql
-- Dedup: for each (user_id, name) group with duplicates, keep the row with
-- the oldest created_at. Before deleting duplicates, copy the most recent
-- last_run_at to the survivor so we don't lose scheduling state.

-- Step 1: Copy latest last_run_at from duplicates to survivors
UPDATE triggers
SET last_run_at = (
  SELECT MAX(t2.last_run_at)
  FROM triggers t2
  WHERE t2.user_id = triggers.user_id
    AND t2.name = triggers.name COLLATE NOCASE
    AND t2.last_run_at IS NOT NULL
)
WHERE id IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY user_id, name COLLATE NOCASE ORDER BY created_at ASC
    ) AS rn
    FROM triggers
  ) WHERE rn = 1
)
AND EXISTS (
  SELECT 1 FROM triggers t2
  WHERE t2.user_id = triggers.user_id
    AND t2.name = triggers.name COLLATE NOCASE
    AND t2.id != triggers.id
);

-- Step 2: Delete duplicate rows (keep oldest per user_id + name, case-insensitive)
DELETE FROM triggers WHERE id NOT IN (
  SELECT id FROM (
    SELECT id, ROW_NUMBER() OVER (
      PARTITION BY user_id, name COLLATE NOCASE ORDER BY created_at ASC
    ) AS rn
    FROM triggers
  ) WHERE rn = 1
);

-- Step 3: Add uniqueness constraint (NOCASE for case-insensitive name matching)
CREATE UNIQUE INDEX idx_triggers_user_name ON triggers(user_id, name COLLATE NOCASE);
```

- [ ] **Step 2: Verify migration SQL syntax**

Run: `cd packages/worker && npx wrangler d1 migrations list valet-db --local`
Expected: Migration `0011_trigger_name_uniqueness` appears in the list.

- [ ] **Step 3: Commit**

```bash
git add packages/worker/migrations/0011_trigger_name_uniqueness.sql
git commit -m "feat: migration to dedup triggers and add UNIQUE(user_id, name)"
```

---

### Task 2: Drizzle Schema — Add uniqueIndex

**Files:**
- Modify: `packages/worker/src/lib/schema/workflows.ts:36-41`

- [ ] **Step 1: Add the unique index to the triggers table definition**

In `packages/worker/src/lib/schema/workflows.ts`, the triggers table definition (lines 36-41) currently has:

```ts
}, (table) => [
  index('idx_triggers_user').on(table.userId),
  index('idx_triggers_workflow').on(table.workflowId),
  index('idx_triggers_type').on(table.type),
  index('idx_triggers_enabled').on(table.enabled),
]);
```

Change to:

```ts
}, (table) => [
  index('idx_triggers_user').on(table.userId),
  index('idx_triggers_workflow').on(table.workflowId),
  index('idx_triggers_type').on(table.type),
  index('idx_triggers_enabled').on(table.enabled),
  uniqueIndex('idx_triggers_user_name').on(table.userId, table.name),
]);
```

Note: `uniqueIndex` is already imported on line 1 of this file.

- [ ] **Step 2: Typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS, no errors.

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/lib/schema/workflows.ts
git commit -m "feat: add uniqueIndex(user_id, name) to triggers Drizzle schema"
```

---

### Task 3: DB Helper — `upsertTriggerByName()` and Delete Fallback Functions

**Files:**
- Modify: `packages/worker/src/lib/db/triggers.ts`

- [ ] **Step 1: Add `findTriggerByName()` query helper**

Add this function after the existing `getTrigger()` function (after line 152):

```ts
export async function findTriggerByName(
  db: D1Database,
  userId: string,
  name: string,
): Promise<Record<string, unknown> | null> {
  return db.prepare(`
    SELECT t.*, w.name as workflow_name
    FROM triggers t
    LEFT JOIN workflows w ON t.workflow_id = w.id
    WHERE t.user_id = ? AND LOWER(t.name) = LOWER(?)
  `).bind(userId, name).first<Record<string, unknown>>();
}
```

- [ ] **Step 2: Add `upsertTriggerByName()` function**

Add this function after `findTriggerByName()`:

```ts
export async function upsertTriggerByName(
  db: AppDb,
  envDB: D1Database,
  userId: string,
  params: {
    name: string;
    type: string;
    config: string;
    enabled: boolean;
    workflowId: string | null;
    variableMapping: string | null;
    now: string;
  },
): Promise<{ triggerId: string; created: boolean }> {
  const existing = await findTriggerByName(envDB, userId, params.name);

  if (existing && typeof existing.id === 'string') {
    await updateTriggerFull(db, existing.id, userId, params);
    return { triggerId: existing.id, created: false };
  }

  const id = crypto.randomUUID();
  await createTrigger(db, {
    id,
    userId,
    workflowId: params.workflowId,
    name: params.name,
    enabled: params.enabled,
    type: params.type,
    config: params.config,
    variableMapping: params.variableMapping,
    now: params.now,
  });
  return { triggerId: id, created: true };
}
```

- [ ] **Step 3: Delete the three fallback matching functions**

Delete these three functions from the file (lines 228-278, the "DO Helpers (Raw SQL)" section):

- `findScheduleTriggerByNameAndWorkflow()` (lines 228-244)
- `findScheduleTriggersByWorkflow()` (lines 246-261)
- `findScheduleTriggersByName()` (lines 263-278)

Also delete the section comment `// ─── DO Helpers (Raw SQL) ───────────────────────────────────────────────────` (line 226-227).

- [ ] **Step 4: Typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: FAIL — `session-workflows.ts` imports the deleted functions. This is expected; Task 4 fixes the consumer.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/lib/db/triggers.ts
git commit -m "feat: add upsertTriggerByName(), remove fallback matching functions"
```

---

### Task 4: Simplify `handleTriggerAction` — Add "sync" Action

**Files:**
- Modify: `packages/worker/src/services/session-workflows.ts:6,508-669`

- [ ] **Step 1: Update imports**

In `packages/worker/src/services/session-workflows.ts` line 6, change:

```ts
import { listTriggers, getTrigger, deleteTrigger, createTrigger, getTriggerForRun, updateTriggerLastRun, findScheduleTriggerByNameAndWorkflow, findScheduleTriggersByWorkflow, findScheduleTriggersByName, updateTriggerFull } from '../lib/db/triggers.js';
```

To:

```ts
import { listTriggers, getTrigger, deleteTrigger, createTrigger, getTriggerForRun, updateTriggerLastRun, updateTriggerFull, upsertTriggerByName } from '../lib/db/triggers.js';
```

- [ ] **Step 2: Add the "sync" / "create" handler block**

Replace the entire `if (action === 'create' || action === 'update')` block (lines 508-669) with:

```ts
  if (action === 'sync' || action === 'create') {
    // Idempotent upsert by (userId, name). "create" is an alias for "sync"
    // for backward compatibility with tool versions already in sandboxes.
    const rawConfig = payload?.config && typeof payload.config === 'object' && !Array.isArray(payload.config)
      ? payload.config as Record<string, unknown>
      : null;
    if (!rawConfig || typeof rawConfig.type !== 'string') {
      return { error: 'config with type is required' };
    }

    const nextName = (typeof payload?.name === 'string' ? payload.name : '').trim();
    if (!nextName) {
      return { error: 'name is required' };
    }

    let workflowId: string | null = null;
    if (typeof payload?.workflowId === 'string' && payload.workflowId.trim()) {
      workflowId = await resolveWorkflowIdForUser(db, userId, payload.workflowId);
      if (!workflowId) {
        return { error: `Workflow not found: ${payload.workflowId}` };
      }
    } else if (payload?.workflowId === null) {
      workflowId = null;
    }

    const target = scheduleTargetFromConfig(rawConfig);
    if (rawConfig.type === 'schedule' && target === 'orchestrator') {
      const prompt = typeof rawConfig.prompt === 'string' ? rawConfig.prompt.trim() : '';
      if (!prompt) {
        return { error: 'schedule prompt is required when target=orchestrator' };
      }
    }

    if (requiresWorkflowForTriggerConfig(rawConfig) && !workflowId) {
      return { error: 'workflowId is required for this trigger type' };
    }

    const nextEnabled = typeof payload?.enabled === 'boolean' ? payload.enabled : true;

    const variableMapping = payload?.variableMapping && typeof payload.variableMapping === 'object' && !Array.isArray(payload.variableMapping)
      ? payload.variableMapping as Record<string, unknown>
      : undefined;

    if (variableMapping) {
      for (const [key, value] of Object.entries(variableMapping)) {
        if (typeof value !== 'string') {
          return { error: `variableMapping.${key} must be a string` };
        }
      }
    }

    const now = new Date().toISOString();
    const { triggerId: targetTriggerId } = await upsertTriggerByName(db, envDB, userId, {
      name: nextName,
      type: String(rawConfig.type),
      config: JSON.stringify(rawConfig),
      enabled: nextEnabled,
      workflowId,
      variableMapping: variableMapping ? JSON.stringify(variableMapping) : null,
      now,
    });

    const row = await getTrigger(envDB, userId, targetTriggerId) as Record<string, unknown> | null;

    return {
      data: {
        trigger: row
          ? {
              id: row.id,
              workflowId: row.workflow_id,
              workflowName: row.workflow_name,
              name: row.name,
              enabled: Boolean(row.enabled),
              type: row.type,
              config: parseJsonOrNull(row.config) || {},
              variableMapping: parseJsonOrNull(row.variable_mapping) || null,
              lastRunAt: row.last_run_at,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            }
          : null,
        success: true,
      },
    };
  }

  if (action === 'update') {
    const triggerId = typeof payload?.triggerId === 'string' ? payload.triggerId.trim() : '';
    if (!triggerId) {
      return { error: 'triggerId is required for update' };
    }

    const existing = await getTrigger(envDB, userId, triggerId) as Record<string, unknown> | null;
    if (!existing) {
      return { error: `Trigger not found: ${triggerId}` };
    }

    const rawConfig = payload?.config && typeof payload.config === 'object' && !Array.isArray(payload.config)
      ? payload.config as Record<string, unknown>
      : (parseJsonOrNull(existing.config) as Record<string, unknown> | null);
    if (!rawConfig || typeof rawConfig.type !== 'string') {
      return { error: 'config with type is required' };
    }

    const nextName = (typeof payload?.name === 'string' ? payload.name : (typeof existing.name === 'string' ? existing.name : '')).trim();
    if (!nextName) {
      return { error: 'name is required' };
    }

    let workflowId: string | null = null;
    if (Object.prototype.hasOwnProperty.call(payload || {}, 'workflowId')) {
      if (typeof payload?.workflowId === 'string' && payload.workflowId.trim()) {
        workflowId = await resolveWorkflowIdForUser(db, userId, payload.workflowId);
        if (!workflowId) {
          return { error: `Workflow not found: ${payload.workflowId}` };
        }
      } else if (payload?.workflowId === null) {
        workflowId = null;
      }
    } else {
      workflowId = typeof existing.workflow_id === 'string' && existing.workflow_id.trim()
        ? existing.workflow_id
        : null;
    }

    const target = scheduleTargetFromConfig(rawConfig);
    if (rawConfig.type === 'schedule' && target === 'orchestrator') {
      const prompt = typeof rawConfig.prompt === 'string' ? rawConfig.prompt.trim() : '';
      if (!prompt) {
        return { error: 'schedule prompt is required when target=orchestrator' };
      }
    }

    if (requiresWorkflowForTriggerConfig(rawConfig) && !workflowId) {
      return { error: 'workflowId is required for this trigger type' };
    }

    const nextEnabled = typeof payload?.enabled === 'boolean'
      ? payload.enabled
      : Boolean(existing.enabled);

    const variableMapping = payload?.variableMapping && typeof payload.variableMapping === 'object' && !Array.isArray(payload.variableMapping)
      ? payload.variableMapping as Record<string, unknown>
      : existing.variable_mapping
        ? (parseJsonOrNull(existing.variable_mapping) as Record<string, unknown> | null)
        : undefined;

    if (variableMapping) {
      for (const [key, value] of Object.entries(variableMapping)) {
        if (typeof value !== 'string') {
          return { error: `variableMapping.${key} must be a string` };
        }
      }
    }

    const now = new Date().toISOString();
    await updateTriggerFull(db, triggerId, userId, {
      workflowId,
      name: nextName,
      enabled: nextEnabled,
      type: String(rawConfig.type),
      config: JSON.stringify(rawConfig),
      variableMapping: variableMapping ? JSON.stringify(variableMapping) : null,
      now,
    });

    const row = await getTrigger(envDB, userId, triggerId) as Record<string, unknown> | null;

    return {
      data: {
        trigger: row
          ? {
              id: row.id,
              workflowId: row.workflow_id,
              workflowName: row.workflow_name,
              name: row.name,
              enabled: Boolean(row.enabled),
              type: row.type,
              config: parseJsonOrNull(row.config) || {},
              variableMapping: parseJsonOrNull(row.variable_mapping) || null,
              lastRunAt: row.last_run_at,
              createdAt: row.created_at,
              updatedAt: row.updated_at,
            }
          : null,
        success: true,
      },
    };
  }
```

Note: The "sync" block is intentionally simpler than the old "create" block — no fallback matching, no `hasWorkflowIdPayload` tracking, no `fallbackToUpdate` flag. For "sync", the `enabled` default is `true` (new trigger behavior). For "update", the `enabled` default is preserved from the existing row.

- [ ] **Step 3: Typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS. All imports resolved, old functions removed.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/services/session-workflows.ts
git commit -m "feat: replace fallback trigger matching with idempotent upsert-by-name"
```

---

### Task 5: Runner — Send "sync" Action

**Files:**
- Modify: `packages/runner/src/agent-client.ts:644`

- [ ] **Step 1: Change the action from "create" to "sync"**

In `packages/runner/src/agent-client.ts` line 644, change:

```ts
        action: params.triggerId ? "update" : "create",
```

To:

```ts
        action: params.triggerId ? "update" : "sync",
```

- [ ] **Step 2: Typecheck**

Run: `cd packages/runner && pnpm typecheck`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add packages/runner/src/agent-client.ts
git commit -m "feat: runner sends 'sync' action for trigger upsert"
```

---

### Task 6: Tool Updates — Descriptions and Name-Based Delete

**Files:**
- Modify: `docker/opencode/tools/sync_trigger.ts:53-57`
- Modify: `docker/opencode/tools/delete_trigger.ts`
- Modify: `docker/opencode/tools/list_triggers.ts:20-21`

- [ ] **Step 1: Update sync_trigger tool description**

In `docker/opencode/tools/sync_trigger.ts`, change lines 53-57:

```ts
export default tool({
  description:
    "Create or update a trigger in Valet. " +
    "Supports manual, webhook, and schedule triggers (including schedule target=orchestrator with prompt).",
  args: {
    trigger_id: z.string().optional().describe("If provided, update this trigger ID instead of creating a new one"),
```

To:

```ts
export default tool({
  description:
    "Create or update a trigger by name. Idempotent — calling with the same name updates the existing trigger " +
    "rather than creating a duplicate. Supports manual, webhook, and schedule triggers " +
    "(including schedule target=orchestrator with prompt).",
  args: {
    trigger_id: z.string().optional().describe("Optional. Use only for renaming a trigger or explicit UUID-based update"),
```

- [ ] **Step 2: Update list_triggers description**

In `docker/opencode/tools/list_triggers.ts`, change lines 19-21:

```ts
  description:
    "List workflow triggers for the current user. " +
    "Use this before creating or updating triggers to avoid duplicates.",
```

To:

```ts
  description:
    "List workflow triggers for the current user.",
```

- [ ] **Step 3: Add name-based delete to delete_trigger**

In `docker/opencode/tools/delete_trigger.ts`, replace the entire file content with:

```ts
import { tool } from "@opencode-ai/plugin"
import { z } from "zod"

export default tool({
  description: "Delete a trigger by ID or name.",
  args: {
    trigger_id: z.string().optional().describe("Trigger ID (UUID)"),
    name: z.string().optional().describe("Trigger name (alternative to trigger_id)"),
  },
  async execute(args) {
    let triggerId = args.trigger_id

    if (!triggerId && !args.name) {
      return "Failed to delete trigger: provide either trigger_id or name."
    }

    // Resolve name to ID if needed
    if (!triggerId && args.name) {
      try {
        const listRes = await fetch("http://localhost:9000/api/triggers")
        if (!listRes.ok) {
          return `Failed to delete trigger: could not list triggers to resolve name.`
        }
        const listData = (await listRes.json()) as { triggers?: { id: string; name: string }[] }
        const match = (listData.triggers || []).find(
          (t) => t.name.toLowerCase() === args.name!.toLowerCase()
        )
        if (!match) {
          return `Failed to delete trigger: no trigger found with name "${args.name}".`
        }
        triggerId = match.id
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e)
        return `Failed to delete trigger: ${msg}`
      }
    }

    const endpoint = `http://localhost:9000/api/triggers/${encodeURIComponent(triggerId!)}`

    // Use curl subprocess to avoid Bun fetch() connection reuse bugs
    // that cause "socket connection was closed unexpectedly" errors.
    const proc = Bun.spawn(["curl", "-sf", "-X", "DELETE", "-H", "Content-Type: application/json", endpoint], {
      stdout: "pipe",
      stderr: "pipe",
    })

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited

    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || `curl exit code ${exitCode}`
      return `Failed to delete trigger: ${detail}`
    }

    try {
      const data = JSON.parse(stdout)
      if (data.error) {
        return `Failed to delete trigger: ${data.error}`
      }
    } catch {
      // Non-JSON response is fine — success with no body
    }

    return `Trigger deleted: ${args.name || triggerId}`
  },
})
```

- [ ] **Step 4: Commit**

```bash
git add docker/opencode/tools/sync_trigger.ts docker/opencode/tools/delete_trigger.ts docker/opencode/tools/list_triggers.ts
git commit -m "feat: update trigger tools for idempotent-by-name semantics"
```

---

### Task 7: Workflow Skill — Cron Timezone Docs and Trigger Guidance

**Files:**
- Modify: `packages/plugin-workflows/skills/workflows.md:68-86,234-237`

- [ ] **Step 1: Update trigger and scheduling section**

In `packages/plugin-workflows/skills/workflows.md`, replace lines 68-86:

```markdown
## Configure triggers and scheduling

Use `sync_trigger` for create/update:

- `type=manual`
- `type=webhook` requires `webhook_path` (optional method/secret)
- `type=schedule` requires `schedule_cron`

Schedule specifics:

- `schedule_cron` must be a 5-field cron expression.
- `schedule_timezone` uses IANA TZ names.
- `schedule_target=workflow` (default): dispatches workflow execution.
- `schedule_target=orchestrator`: dispatches `schedule_prompt` to orchestrator session.
- `schedule_prompt` is required when `schedule_target=orchestrator`.

Use `run_trigger` to test behavior immediately.

Use `delete_trigger` to remove stale triggers.
```

With:

```markdown
## Configure triggers and scheduling

Triggers are identified by name. `sync_trigger` is idempotent — calling with the same name updates the existing trigger, preserving its creation time and history. No need to look up trigger IDs first.

Use `sync_trigger` for create/update:

- `type=manual`
- `type=webhook` requires `webhook_path` (optional method/secret)
- `type=schedule` requires `schedule_cron`

Schedule specifics:

- `schedule_cron` is a 5-field cron expression evaluated in `schedule_timezone` (default: UTC). Example: `0 8 * * *` with timezone `America/Denver` fires at 8:00 AM Mountain Time daily.
- `schedule_target=workflow` (default): dispatches workflow execution.
- `schedule_target=orchestrator`: dispatches `schedule_prompt` to orchestrator session.
- `schedule_prompt` is required when `schedule_target=orchestrator`.

Use `run_trigger` to test behavior immediately.

Use `delete_trigger` to remove stale triggers (by ID or name).
```

- [ ] **Step 2: Update reliable operating playbook**

In `packages/plugin-workflows/skills/workflows.md`, replace lines 234-237:

```markdown
## Reliable operating playbook

1. Use `list_workflows` and `list_triggers` before creating/updating to avoid duplicates.
2. Use `get_workflow` before patching critical definitions.
```

With:

```markdown
## Reliable operating playbook

1. Use `list_workflows` before creating/updating to avoid duplicates. Triggers are idempotent by name — no need to list first.
2. Use `get_workflow` before patching critical definitions.
```

- [ ] **Step 3: Regenerate content registry**

Run: `make generate-registries`
Expected: `packages/worker/src/plugins/content-registry.ts` is regenerated with the updated skill content.

- [ ] **Step 4: Typecheck all packages**

Run: `pnpm typecheck`
Expected: PASS across all packages.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-workflows/skills/workflows.md packages/worker/src/plugins/content-registry.ts
git commit -m "docs: clarify cron timezone semantics, update trigger idempotency guidance"
```

---

### Task 8: Final Verification

- [ ] **Step 1: Run full typecheck**

Run: `pnpm typecheck`
Expected: PASS across all packages.

- [ ] **Step 2: Build frontend**

Run: `cd packages/client && pnpm build`
Expected: PASS (frontend doesn't import trigger internals, but verify no regressions).

- [ ] **Step 3: Run tests**

Run: `pnpm test`
Expected: All existing tests pass. No trigger-specific tests exist to break.

- [ ] **Step 4: Verify migration SQL is valid**

Run: `cd packages/worker && npx wrangler d1 migrations list valet-db --local`
Expected: Migration 0011 listed and ready to apply.

- [ ] **Step 5: Final commit (if any fixups needed)**

Only if previous steps revealed issues that required fixes.
