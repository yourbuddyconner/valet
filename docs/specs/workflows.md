# Workflows

> Defines the workflow automation system — workflow definitions (`dag/v1`), trigger types, execution lifecycle on the Cloudflare Workflow interpreter, approval gates, and version history.

## Scope

This spec covers:

- Workflow definition schema (`dag/v1`) and validation
- Trigger types (webhook, schedule, manual) and routing
- Draft + published-version lifecycle
- Execution lifecycle on Cloudflare Workflows (the `ValetWorkflowInterpreter` entrypoint)
- Approval gates via `workflow_approvals` + `step.waitForEvent` + `instance.sendEvent`
- Cancellation pipeline and recovery sweeps
- Cron schedule evaluation and deduplication
- Webhook handler with one-time-token auth

### Boundary Rules

- Does NOT cover the runner gateway. Workflow management is a worker concern (`/api/workflows/*`, `/api/triggers/*`, `/api/executions/*`) and the web UI.
- Does NOT cover session lifecycle or sandbox management (see [sessions.md](sessions.md)).
- Does NOT cover the orchestrator's relationship to workflows (see [orchestrator.md](orchestrator.md)).

## Data Model

### `workflows` table

Core workflow definition. Schema in `packages/worker/src/lib/schema/workflows.ts`.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | text PK | — | UUID |
| `userId` | text NOT NULL | — | FK to users, CASCADE DELETE |
| `slug` | text | — | Human-friendly identifier, unique per user |
| `name` | text NOT NULL | — | Display name |
| `description` | text | — | Optional description |
| `version` | text NOT NULL | `'1.0.0'` | Semver string |
| `data` | text NOT NULL | — | JSON blob written via `/sync`. After publish, `workflow_definition_versions.definition` is the source of truth for execution. |
| `enabled` | boolean | `true` | Whether the workflow can be triggered |
| `tags` | text | — | JSON array stored as text |
| `draftDefinition` | text | — | Current draft (`dag/v1`) being edited |
| `publishedVersionId` | text | — | Points at the active row in `workflow_definition_versions`. Null until first publish. |
| `ui` | text | — | Editor layout JSON (node positions etc.) |
| `createdAt`, `updatedAt` | text | `datetime('now')` | ISO datetime |

**Indexes:** unique on `(userId, slug)`.

### `triggers` table

Schema in `packages/worker/src/lib/schema/workflows.ts`.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | text PK | — | UUID |
| `userId` | text NOT NULL | — | FK to users, CASCADE DELETE |
| `workflowId` | text | — | FK to workflows, CASCADE DELETE. **Nullable** for orchestrator-target schedule triggers |
| `name` | text NOT NULL | — | Display name |
| `enabled` | boolean | `true` | Active flag |
| `type` | text NOT NULL | — | `'webhook'` / `'schedule'` / `'manual'` |
| `config` | text NOT NULL | — | JSON: discriminated union by type |
| `variableMapping` | text | — | JSON: `Record<string, string>` mapping incoming data to workflow vars |
| `webhookToken` | text | — | Server-issued one-time token. Set on create / type-transition-to-webhook. Never re-exposed via GET/PATCH. |
| `lastRunAt`, `createdAt`, `updatedAt` | text | — | Audit fields |

Trigger config shapes:

```typescript
type TriggerConfig =
  | { type: 'webhook'; path: string; method?: 'GET' | 'POST'; secret?: string; headers?: Record<string, string>; rateLimit?: number }
  | { type: 'schedule'; cron: string; timezone?: string; target?: 'workflow' | 'orchestrator'; prompt?: string; inputs?: Record<string, unknown> }
  | { type: 'manual' };
```

Schedule triggers with `target: 'orchestrator'` dispatch a prompt to the user's orchestrator session instead of running a workflow — these have a nullable `workflowId`.

### `workflow_definition_versions` table

Append-only history of published definitions. Schema in `packages/worker/src/lib/schema/workflow-definition-versions.ts`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `workflowId` | text NOT NULL | FK to workflows, CASCADE DELETE |
| `version` | integer NOT NULL | Monotonic per workflow |
| `definition` | text NOT NULL | Full `dag/v1` JSON snapshot |
| `definitionHash` | text NOT NULL | SHA-256 of the canonical definition |
| `validationStatus` | text NOT NULL | `'ok'` or `'warning'` (e.g. llm node with no maxOutputTokens) |
| `publishNote` | text | Optional release note |
| `ui` | text | Editor layout snapshot at publish time |
| `createdBy` | text | User id (set null on user delete) |
| `createdAt` | text | ISO datetime |

`workflows.published_version_id` references the active row; restoring an old version copies its `definition` back into `workflows.draft_definition`.

### `workflow_executions` table

Execution instances. Schema in `packages/worker/src/lib/schema/workflows.ts`.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | text PK | — | UUID — also the Cloudflare Workflow instance id |
| `workflowId` | text | — | FK to workflows, SET NULL on delete |
| `userId` | text NOT NULL | — | Owner |
| `triggerId` | text | — | FK to triggers, SET NULL on delete |
| `status` | text NOT NULL | — | See [State Machine](#state-machine) |
| `triggerType` | text NOT NULL | — | `'manual'` / `'webhook'` / `'schedule'` |
| `triggerMetadata` | JSON text | — | Trigger-specific context |
| `inputs` | JSON text | — | Validated workflow input map (typed inputs only) |
| `outputs` | JSON text | — | Stop-node outputs by node id (`{ [nodeId]: { outcome, output?, message? } }`) |
| `error` | text | — | First failure message |
| `startedAt`, `completedAt` | text | — | ISO datetimes |
| `definitionSnapshot` | text | — | `dag/v1` JSON at execution-create time — the runtime never re-reads `workflows.data` |
| `definitionVersionId` | text | — | FK to workflow_definition_versions for production runs |
| `mode` | text | `'production'` | `'production'` or `'test'` (test-runs come from the draft editor) |
| `idempotencyKey` | text | — | Unique index on `(workflowId, idempotencyKey)` |
| `cloudflareInstanceId` | text | — | Mirror of `id` for legibility; the Cloudflare Workflow instance is named after the execution id |
| `cancelledAt`, `cancelledBy`, `cleanupCompletedAt` | text | — | Cancel audit + cleanup-pipeline completion marker |

**Indexes:** unique on `(workflowId, idempotencyKey)`; indexed on `status`, `startedAt`.

Sessions spawned by `session` / `orchestrator` nodes are linked through the `workflow_spawned_sessions` table, not a denormalized column on the execution row.

### `workflow_execution_nodes` table

Per-node trace rows. One row per `(executionId, nodeId[:i:iter])`. Schema in `packages/worker/src/lib/schema/workflow-execution-nodes.ts`.

Statuses: `running` / `waiting_approval` / `waiting_time` / `completed` / `failed` / `skipped`. Trace rows carry `input_preview`, `output`, `error`, `reason`, `retry_attempts`, `approval_id`, `invocation_id`, durations, and TTL `expires_at` (30d production, 7d test).

### `workflow_spawned_sessions` table

Authoritative link from an execution to the sessions it spawned (via `session` or `orchestrator` nodes). The cancellation pipeline reads this to terminate sandboxes; it is the only source of truth for spawned sessions — no trace-parsing.

### `workflow_approvals` table

One row per approval gate hit during a workflow execution. Schema in `packages/worker/src/lib/schema/workflow-approvals.ts`.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | Deterministic: `approval:<executionId>:<nodeId>[:i:<iter>]` |
| `executionId` | text | FK to workflow_executions (set null on delete) |
| `nodeId` | text NOT NULL | Workflow node id |
| `kind` | text NOT NULL | `'explicit'` (approval node) or `'tool_policy'` (tool require_approval) |
| `workflowInstanceId` | text NOT NULL | Cloudflare Workflow instance id — used by the approve/deny endpoint's `instance.sendEvent` |
| `eventType` | text NOT NULL | `'approval_<nodeId>[_i_<iter>]'` — matches the executor's `step.waitForEvent` type |
| `prompt` | text NOT NULL | Rendered approval prompt |
| `summary`, `details` | text | Optional human-readable summary + JSON details |
| `status` | text NOT NULL | `'pending'` / `'approved'` / `'denied'` / `'expired'` / `'cancelled'` |
| `timeoutAt` | text | Per-row deadline; default 24 h |
| `resolvedBy`, `resolvedAt`, `cancelledAt` | text | Audit fields |
| `createdAt`, `updatedAt` | text | Lifecycle timestamps |

### `workflow_schedule_ticks` table

Per-trigger cron tick dedupe. Unique index on `(triggerId, tickBucket)` where `tickBucket` is the current minute truncation.

## State Machine

### Execution Statuses

```
PENDING ──────────────> RUNNING            (interpreter enters the wave loop)

RUNNING ──────────────> COMPLETED          (all nodes succeed)
        ──────────────> FAILED             (node failure)
        ──────────────> CANCELLED          (user cancellation)
        ──────────────> WAITING_APPROVAL   (approval / tool-policy node parked on step.waitForEvent)
        ──────────────> WAITING_TIME       (wait node parked on step.sleep)

WAITING_APPROVAL ─────> RUNNING            (approve/deny → sendEvent → executor try/finally exits to RUNNING)
WAITING_TIME     ─────> RUNNING            (step.sleep elapsed)
RUNNING          ─────> CANCELLING ──────> CANCELLED   (cancel API → instance.terminate → cleanup)
```

Terminal states: `completed`, `failed`, `cancelled`. The `cleanupCompletedAt` column on the execution row marks the cancel pipeline as fully done — see [Cancellation](#cancellation).

**Parallel-sibling note:** when multiple waiting nodes (e.g. several approval gates) run concurrently under one execution, the row's `status` only reflects the most-recent transition. Per-node status is the source of truth (see `workflow_execution_nodes` trace rows and the `workflow_approvals` table). The stuck-approval sweep filters on `executions.status IN active_statuses` so a parallel race can't hide a missing `sendEvent`.

### Concurrency Limits

Active executions (`pending`, `running`, `waiting_approval`, `waiting_time`) are counted:

- **Per-user limit:** 10 (`PER_USER_EXECUTION_CONCURRENCY_CAP`)
- **Global limit:** 50 (`GLOBAL_EXECUTION_CONCURRENCY_CAP`)

`cancelling` is intentionally excluded from the active set so a user who just cancelled can immediately start new work — the cron sweep finalizes asynchronously.

## API Contract

### Workflow Routes (`/api/workflows`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List user's workflows (includes `publishedVersionId`) |
| GET | `/:id` | Get single (by id or slug) |
| POST | `/sync` | Sync a single workflow from a plugin |
| POST | `/sync-all` | Full reconciliation sync (deletes workflows not in the incoming set) |
| PUT | `/:id` | Update workflow fields |
| DELETE | `/:id` | Delete workflow and its triggers |
| GET | `/:id/draft` | Fetch the current draft definition + UI layout |
| PUT | `/:id/draft` | Save a draft (not validated until publish) |
| POST | `/:id/validate` | Run the validator against the current draft |
| POST | `/:id/publish` | Publish the draft as a new `workflow_definition_versions` row |
| POST | `/:id/test-run` | Execute the draft against a sample trigger payload + input overrides |
| GET | `/:id/versions` | List published versions |
| POST | `/:id/versions/:versionId/restore` | Copy an old version back into the draft |
| GET | `/:id/executions` | Execution history for the workflow |
| POST | `/:id/executions/:executionId/cancel` | Cancel an execution (nested form) |
| POST | `/:id/executions/:executionId/approvals/:approvalId/{approve,deny}` | Resolve an approval (nested form) |

### Execution Routes (`/api/executions`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List recent executions (filterable by status, workflowId) |
| GET | `/:id` | Single execution with nodes + approvals + parsed inputs |
| GET | `/:id/approvals` | All approvals for an execution (pending + resolved) |
| POST | `/:id/approvals/:approvalId/approve` | Approve a pending approval (`{ reason? }` body) |
| POST | `/:id/approvals/:approvalId/deny` | Deny a pending approval (`{ reason? }` body) |
| POST | `/:id/cancel` | Cancel an execution |

### Trigger Routes (`/api/triggers`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/manual/run` | Run a workflow directly (without a persistent trigger) |
| GET | `/` | List user's triggers |
| GET | `/:id` | Single trigger (returns `webhookUrl` for webhook type; never echoes the token) |
| POST | `/` | Create trigger (returns `webhookToken` exactly once when type is webhook) |
| PATCH | `/:id` | Update trigger (mints + returns a fresh token when transitioning to webhook) |
| DELETE | `/:id` | Delete trigger |
| POST | `/:id/enable`, `/:id/disable` | Toggle enabled state |
| POST | `/:id/run` | Manually fire a trigger |
| ALL | `/:triggerId/webhook` | Forward-facing webhook endpoint — authenticates via `X-Valet-Trigger-Token` (constant-time compare) |

A path-based fallback at `/webhooks/:path` resolves with a constant-time `config.secret` compare for deployments that wired up webhooks before the per-trigger token model. The trigger API and UI surface only the per-trigger token URL.

## Flows

### Manual Workflow Run

1. Client calls `POST /api/triggers/manual/run` with `workflowId` (or slug) and optional input variables.
2. Service resolves the workflow, validates concurrency, and checks idempotency (`manual:{workflowId}:{userId}:{clientRequestId}`).
3. Service inserts an execution row in `pending` with `definitionSnapshot` set to the published definition.
4. `env.WORKFLOW_INTERPRETER.create({ id: executionId, params })` spawns the Cloudflare Workflow instance.
5. The interpreter's `run()` enters the wave loop: `setExecutionStatus('running')` → repeat `pickRunnable` → execute → settle → write trace rows.
6. Terminal status (`completed` / `failed` / `cancelled`) is written by the runtime with an `allowedPrior` CAS so a concurrent cancel doesn't get overwritten.

### Webhook Trigger (forward-facing path)

1. External system POSTs to `/api/triggers/:triggerId/webhook` with `X-Valet-Trigger-Token: <token>`.
2. Handler validates HTTP method (per `config.method`) and constant-time-compares the token against `triggers.webhook_token`.
3. Per-trigger rate limit check (`config.rateLimit`, default 60/min) via the `trigger_webhook_rate` table.
4. Builds a trigger envelope (`body`, lowercased `headers`, `query`, `rawQuery`) and applies `variableMapping` to derive input overrides.
5. Idempotency key: `webhook:{triggerId}:{deliveryId or bodyHash}`.
6. Concurrency check, then create execution + Cloudflare Workflow instance.

### Schedule Trigger (cron)

1. The worker's `scheduled()` handler fires every minute.
2. `dispatchScheduledWorkflows()` queries all enabled schedule triggers and matches them against the current minute (timezone-aware).
3. Per-tick dedupe via `workflow_schedule_ticks` (unique on `(triggerId, tickBucket)`).
4. **Workflow targets:** checks concurrency, creates an execution, spawns the Cloudflare Workflow instance.
5. **Orchestrator targets:** dispatches the configured prompt directly to the user's orchestrator session via `dispatchOrchestratorPrompt()`.
6. The handler also runs a catch-up pass over the last few minutes — transient dispatch failures release the tick claim so the catch-up can retry.

The cron matcher supports standard 5-field syntax: wildcards (`*`), exact values, ranges (`1-5`), steps (`*/5`), and comma-separated lists.

### Approval Gate

1. Interpreter hits an `approval` node (or a `tool` node whose policy resolved to `require_approval`).
2. Executor calls `setExecutionStatus('waiting_approval')` and the shared `requestApproval` helper, which inserts a `workflow_approvals` row and `step.waitForEvent`s on `approval_<nodeId>[_i_<iter>]`.
3. UI fetches pending approvals via `GET /api/executions/:id/approvals` (or sees them nested under the execution detail) and renders approve/deny actions.
4. User calls `POST /api/executions/:id/approvals/:approvalId/approve` (or `/deny`, optionally with `{ reason }`).
5. Worker updates the approval row (CAS on `pending` + `timeoutAt`) and `instance.sendEvent`s to resume the Cloudflare Workflow.
6. Executor's `try/finally` sets the execution row back to `running` regardless of outcome. The approval node returns approved / throws (deny / cancel / timeout) per `onDeny` policy.
7. Recovery: if `sendEvent` fails, the cron `sweepStuckApprovals` retries the event for any approval whose execution is still active.

### Cancellation

`POST /api/executions/:id/cancel` (or the nested workflow form):

1. Pre-check the execution row; reject already-terminal rows.
2. CAS-update status to `cancelling` (`allowedPrior` = active statuses).
3. For every still-pending approval row, dispatch a `result: 'cancelled'` event so the executor's `try/finally` exits and tags the trace row as `skipped:cancelled` (instead of running `onDeny`).
4. Call `instance.terminate()` to abort the Cloudflare Workflow.
5. Run `runCancellationCleanup` synchronously:
   1. CAS pending approvals → `cancelled`.
   2. Terminate spawned sessions (via `workflow_spawned_sessions`).
   3. Drive non-terminal `action_invocations` rows to `failed` with `error='workflow_cancelled'`.
   4. Write `skipped` trace rows for every node that wasn't already terminal.
   5. CAS the execution row to `cancelled` + set `cleanup_completed_at`. The CAS allows transitioning from either `cancelling` OR `cancelled`-without-`cleanup_completed_at`, so the cancel API still runs cleanup even when the runtime's terminal write raced ahead.

Failure anywhere in the pipeline leaves `cleanup_completed_at` null; the cron `sweepStuckCancellations` re-runs the pipeline for any row in `cancelling` OR in `cancelled` without `cleanup_completed_at`. The cancel API itself re-reads the row after `runCancellationCleanup` and reports the actual outcome (`cancelled` only when cleanup finished, `cancelling` otherwise).

## Workflow Definition (`dag/v1`)

Definitions are objects with `version: 'dag/v1'`, optional `inputs` (typed input declarations), a `nodes` array, an `edges` array, and an optional `policy` block. See the `WorkflowDefinition` types in `@valet/shared`.

### Node Types

| Type | Behavior |
|------|----------|
| `trigger` | Reserved source node for the invocation envelope. It returns `WorkflowTriggerPayload` as its node data and lets downstream nodes reference `{{nodes.trigger.data...}}`, `{{trigger...}}`, and declared `{{inputs...}}` values. |
| `llm` | LLM completion via the configured provider. NO_RETRY at the runtime level — author-driven retries via `step.do` config. |
| `tool` | Worker-side integration action through the same pipeline agent tool calls use. Honors action policy (`allow` / `deny` / `require_approval`). |
| `set` | Computes JSON values from templates and surfaces them to downstream nodes via `state.nodes`. |
| `if` | Branches on a `conditions` array; downstream edges carry `fromOutput: 'true' \| 'false'`. |
| `wait` | Durable pause via `step.sleep` for a compact duration string (`'5s'`, `'1h'`). |
| `approval` | Human approval gate via `workflow_approvals` + `step.waitForEvent`. |
| `foreach` | Iterates over an array. Body is a single node of a permitted subtype (`llm`, `tool`, `set`, `stop`, `orchestrator`, `session`). |
| `orchestrator` | Dispatch a prompt to the user's orchestrator. |
| `session` | Start or resume a session and run a prompt. |
| `stop` | Terminate the workflow with an outcome envelope. |

### Validator

`packages/worker/src/lib/workflow-dag/validator.ts` runs structural (Zod) + semantic checks at publish and execution-create time:

- Per-node duplicate id detection (top-level ids share namespace with foreach body ids — the runtime keys `step.do` cache, action invocations, approval ids, and trace rows on `${nodeId}:i:${iter}` with no parent scoping). `trigger` is a reserved source-node id in visual-editor-authored workflows.
- Edge endpoints MUST reference top-level node ids — edges into/out of foreach body ids are rejected because the runtime's wave loop only registers top-level nodes.
- foreach body type allowlist + alias shadowing + concurrency ceilings.
- Template parse for every author-supplied template field.
- Per-node env checks for llm model availability (provider key configured).

`validateInputs` separately validates the trigger payload + input overrides against the workflow's declared `inputs` shape (type / enum / required / default).

## Runtime

The runtime entrypoint is `ValetWorkflowInterpreter` in `packages/worker/src/workflows/interpreter.ts` — a Cloudflare Workflow class. Each execution becomes a Cloudflare Workflow instance named after the execution id.

`runDag()` in `packages/worker/src/workflows/runtime.ts` is the wave loop:

1. Compile the definition into incoming/outgoing edge maps and a node id map.
2. `setExecutionStatus('running')` (CAS from `pending`).
3. Repeat until no more runnable nodes:
   - `pickRunnable` — every unsettled node whose every incoming edge is satisfied by a settled parent.
   - Run up to `policy.maxConcurrentNodes` nodes via `Promise.allSettled`.
   - For step-driven types (`wait`, `approval`, `tool`, `foreach`, `session`, `orchestrator`) the executor owns its own `step.do` / `step.sleep` / `step.waitForEvent` primitives. For pure/source types (`trigger`, `llm`, `set`, `if`, `stop`) the runtime wraps the executor in a single outer `step.do`.
   - Each node writes `running` / `waiting_*` / terminal trace rows via `traceWriter.recordTransition`, cached behind `step.do`.
4. When no nodes remain, mark unreachable children as `skipped` (with the parent's edge-error reason when available), then write the terminal status.

Replay determinism comes from `step.do` caching every side effect: D1 writes, clock reads, action invocations, approval row inserts. Hibernate/wake replays the cached outputs without re-issuing side effects.

## Edge Cases & Failure Modes

### Idempotency

Duplicate executions are prevented by the unique index on `(workflowId, idempotencyKey)`:

- Manual: `manual:{workflowId}:{userId}:{clientRequestId}`
- Webhook: `webhook:{triggerId}:{deliveryId or bodyHash}`
- Schedule: per-tick dedupe via `workflow_schedule_ticks`
- Test-run: `test-run:{workflowId}:{userId}:{clientRequestId}` (editor double-click protection)

### Webhook Signature Verification Gap

The path-based `/webhooks/:path` endpoint constant-time-compares against `config.secret` when one is set. It does NOT verify provider-specific HMAC signatures (e.g. GitHub's `X-Hub-Signature-256`). Use the per-trigger URL + `X-Valet-Trigger-Token` for stronger auth.

### Sync-All Reconciliation

`syncAllWorkflows()` is a full reconciliation: it deletes any existing workflows NOT in the incoming set. Intended for plugin startup; destructive by design.

## Implementation Status

### Fully Implemented

- Draft + published-version workflow lifecycle with restore
- Three trigger types (webhook, schedule, manual) with one-time-token webhook auth
- Cron schedule dispatch with timezone support, tick dedupe, and a catch-up pass
- dag/v1 runtime on Cloudflare Workflows with the full node-type set (llm / tool / set / if / wait / approval / foreach / orchestrator / session / stop)
- Approval gates via `workflow_approvals` + `step.waitForEvent`; flat and nested approve/deny endpoints
- Cancellation pipeline with `cleanup_completed_at` gate, cron sweeps for stuck `cancelling` rows and stuck approvals
- Per-execution trace rows in `workflow_execution_nodes` with retention TTL
- Client UI: workflow detail with executions + pending approvals, executions list with inline approval action, trigger CRUD with one-shot token reveal

### Partially Implemented

- **Provider-specific webhook signatures:** the `/webhooks/:path` route checks only secret presence/equality, not HMAC. The per-trigger URL with `X-Valet-Trigger-Token` is the preferred auth surface.
