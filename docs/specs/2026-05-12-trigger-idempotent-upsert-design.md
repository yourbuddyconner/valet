# Trigger Idempotent Upsert Design

**Date**: 2026-05-12
**Status**: Approved
**Issue**: [TKAI-71](https://linear.app/turnkey/issue/TKAI-71/trigger-createdat-timestamp-resets-after-sandbox-restore)

## Problem

Trigger `createdAt` timestamps reset to the current time after a sandbox restore. The root cause: when the orchestrator agent re-syncs triggers after a restore, it calls `sync_trigger` without a `trigger_id` (it doesn't know the UUID). The server receives this as a "create" action and attempts fallback name-matching to find the existing trigger. This fallback is fragile — it only works for schedule triggers, fails when multiple triggers share a name, and silently creates duplicates for webhook/manual types. When the fallback misses, a new trigger row is inserted with a fresh `createdAt`.

Secondary issue: cron timezone semantics are undocumented. The cron expression is evaluated in the specified timezone (standard behavior), but neither the tool description nor the workflow skill clarifies this, leading users to misconfigure schedules.

## Design

### Core principle

Triggers are identified by name, not UUID. The name is the stable identifier that survives sandbox restores, conversation resets, and agent memory loss. UUIDs remain as internal primary keys for foreign key references but are not required for agent-facing operations.

### Database

Add a migration that:

1. Deduplicates existing triggers: for each `(user_id, name)` group with duplicates, keep the row with the oldest `created_at`. If a discarded duplicate has a more recent `last_run_at`, copy that value to the survivor before deleting.
2. Adds `CREATE UNIQUE INDEX idx_triggers_user_name ON triggers(user_id, name)` to enforce uniqueness at the storage layer.

Update the Drizzle schema in `packages/worker/src/lib/schema/workflows.ts` to include `uniqueIndex('idx_triggers_user_name').on(table.userId, table.name)`.

### New DB helper: `upsertTriggerByName()`

Location: `packages/worker/src/lib/db/triggers.ts`

Parameters: `(db: AppDb, envDB: D1Database, userId, name, type, config, enabled, workflowId, variableMapping, now)`

Both DB handles are needed: `AppDb` (Drizzle) for insert/update operations, `D1Database` (raw) for the SELECT that joins with workflows to return the full trigger row.

Behavior:
1. `SELECT * FROM triggers WHERE user_id = ? AND lower(name) = lower(?)`
2. If found: call `updateTriggerFull()` with the existing row's `id`. `createdAt` is preserved; only `updatedAt` advances.
3. If not found: call `createTrigger()` with a new UUID and `createdAt = now`.
4. Return the upserted trigger row.

Case-insensitive name matching prevents "Daily Digest" and "daily digest" from being treated as separate triggers.

### Server-side: `handleTriggerAction` simplification

Location: `packages/worker/src/services/session-workflows.ts`

Replace the current three-path create/fallback-upsert/update logic (lines 508-645) with:

- **`action === "sync"` (new, primary agent path)**: Call `upsertTriggerByName()`. One function call replaces the 80-line fallback matching block.
- **`action === "update"` (preserved)**: UUID-based update for the HTTP API and UI. No change.
- **`action === "create"` (alias for sync)**: For backward compatibility with tool versions already deployed in sandboxes, "create" behaves identically to "sync".

Delete these functions from `packages/worker/src/lib/db/triggers.ts` — they exist solely for the fallback matching and are no longer needed:
- `findScheduleTriggerByNameAndWorkflow()`
- `findScheduleTriggersByWorkflow()`
- `findScheduleTriggersByName()`

### Runner

Location: `packages/runner/src/agent-client.ts` (line 644)

Change:
```ts
action: params.triggerId ? "update" : "create"
```
To:
```ts
action: params.triggerId ? "update" : "sync"
```

No changes to the gateway (`packages/runner/src/gateway.ts`). The `POST /api/triggers` and `PATCH /api/triggers/:id` routes already map correctly to the no-triggerId and with-triggerId paths.

### Tool changes

**`docker/opencode/tools/sync_trigger.ts`**:
- Update description to: *"Create or update a trigger by name. Idempotent — calling with the same name updates the existing trigger rather than creating a duplicate."*
- Update `trigger_id` parameter description to: *"Optional. Use only for renaming a trigger or explicit UUID-based update."*
- No structural code changes.

**`docker/opencode/tools/delete_trigger.ts`**:
- Add optional `name` parameter as alternative to `trigger_id`.
- When `name` is provided without `trigger_id`: list triggers, find by name, delete by resolved UUID.

**`docker/opencode/tools/list_triggers.ts`**:
- Remove "Use this before creating or updating triggers to avoid duplicates" from description. The server handles dedup.

### Documentation: cron timezone semantics

**`packages/plugin-workflows/skills/workflows.md`**:

1. Clarify cron timezone (around line 78): `schedule_cron` is a 5-field cron expression evaluated in `schedule_timezone` (default: UTC). Example: `0 8 * * *` with timezone `America/Denver` fires at 8:00 AM Mountain Time daily.
2. Replace list-before-create guidance (line 236) with: *"Triggers are idempotent by name — `sync_trigger` with the same name updates the existing trigger."*
3. Add note to trigger section: *"Triggers are identified by name. Calling `sync_trigger` with an existing name updates that trigger, preserving its creation time and history."*

## What this does NOT cover

- Trigger versioning or config change history — out of scope.
- Changes to the HTTP API routes (`packages/worker/src/routes/triggers.ts`) — the REST API already has proper create/update separation via `POST`/`PATCH` with Zod validation. The fix targets the WebSocket-based sync path used by the sandbox agent.
- Cron scheduler code changes — the scheduler in `packages/worker/src/index.ts` is working correctly. The timezone issue is a documentation gap, not a code bug.

## Migration path

1. Migration: dedup existing triggers, add UNIQUE index
2. New `upsertTriggerByName()` DB helper
3. `handleTriggerAction`: add "sync" action, alias "create" to it
4. Runner: send `"sync"` action instead of `"create"`
5. Tools: update descriptions, add name-based delete
6. Delete `findScheduleTrigger*` functions and fallback block
7. Workflow skill: clarify cron timezone, update trigger guidance
