# Workflows

> Defines the workflow automation system — workflow definitions, trigger types, execution lifecycle, step execution engine, approval gates, self-modification proposals, and version history.

## Scope

This spec covers:

- Workflow definition schema and validation
- Trigger types (webhook, schedule, manual, github) and routing
- Execution lifecycle and concurrency control
- WorkflowExecutorDO behavior (enqueue, resume, cancel)
- Runner-side step execution engine (all step types)
- Approval gates with nonce-protected resume tokens
- Failure escalation to the user's orchestrator (`failureNotify`)
- Self-modification proposals (create, review, apply)
- Version history and rollback
- Cron schedule evaluation and deduplication
- Webhook handler with variable mapping
- Trigger delivery logging (`trigger_deliveries`)

### Boundary Rules

- This spec does NOT cover the OpenCode tools that invoke workflows (those use the gateway internal API documented in [sandbox-runtime.md](sandbox-runtime.md))
- This spec does NOT cover session lifecycle or sandbox management (see [sessions.md](sessions.md))
- This spec does NOT cover the orchestrator's relationship to workflows (see [orchestrator.md](orchestrator.md))
- This spec does NOT cover the WebSocket transport that carries `workflow-step-event` from the runner to the DO or the `workflow.execution.step` client broadcast — see [real-time.md](real-time.md). This spec only describes what those events mean semantically.

## Data Model

### `workflows` table

Core workflow definition.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | text PK | — | UUID |
| `userId` | text NOT NULL | — | FK to users, CASCADE DELETE |
| `slug` | text | — | Human-friendly identifier, unique per user |
| `name` | text NOT NULL | — | Display name |
| `description` | text | — | Optional description |
| `version` | text NOT NULL | `'1.0.0'` | Semver string |
| `data` | text NOT NULL | — | JSON blob: the full workflow definition (steps, constraints, variables, etc.) |
| `enabled` | boolean | `true` | Whether the workflow can be triggered |
| `tags` | text | — | JSON array stored as text |
| `createdAt` | text | `datetime('now')` | ISO datetime |
| `updatedAt` | text | `datetime('now')` | ISO datetime |

**Indexes:** unique on `(userId, slug)`.

### `triggers` table

How workflows get invoked.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | text PK | — | UUID |
| `userId` | text NOT NULL | — | FK to users, CASCADE DELETE |
| `workflowId` | text | — | FK to workflows, CASCADE DELETE. **Nullable** for orchestrator-target schedule triggers |
| `name` | text NOT NULL | — | Display name |
| `enabled` | boolean | `true` | Active flag |
| `type` | text NOT NULL | — | `'webhook'` / `'schedule'` / `'manual'` / `'github'` (see migration 0013) |
| `config` | text NOT NULL | — | JSON: discriminated union by type |
| `variableMapping` | text | — | JSON: `Record<string, string>` mapping incoming data to workflow vars |
| `lastRunAt` | text | — | ISO datetime |
| `createdAt` / `updatedAt` | text | `datetime('now')` | ISO datetime |

**Trigger config shapes:**

```typescript
type TriggerConfig =
  | { type: 'webhook'; path: string; method?: string; secret?: string; headers?: Record<string, string> }
  | { type: 'schedule'; cron: string; timezone?: string; target?: 'workflow' | 'orchestrator'; prompt?: string }
  | { type: 'manual' }
  | {
      type: 'github';
      repos: string[];                 // full names, e.g. ["owner/repo"]
      events: string[];                // 'pull_request' (any action) or 'pull_request.opened'
      filter?: {
        actions?: string[];            // payload.action allowlist
        branch?: string | string[];    // push: payload.ref; pull_request: base.ref
        labels?: string[];             // pull_request label overlap
      };
    };
```

Schedule triggers with `target: 'orchestrator'` dispatch a prompt to the user's orchestrator session instead of running a workflow. These have a nullable `workflowId`.

**GitHub triggers** subscribe to events from the user's GitHub App installation. They are scoped to the installation's `linkedUserId`; webhooks from an installation with no linked Valet user are ignored. Event matching supports two forms:

- bare event name (`pull_request`) matches any action on that event.
- `event.action` (`pull_request.opened`) matches only that action.

Filters are AND-ed when present. The `actions` filter is a per-event allowlist for `payload.action`. The `branch` filter applies to `push` (against `payload.ref`, with `refs/heads/` stripped) and `pull_request` (against `payload.pull_request.base.ref`). The `labels` filter requires at least one configured label to be present on the PR.

GitHub does not emit a distinct merge event; a merged PR arrives as `pull_request.closed` with `pull_request.merged === true`. The current dispatcher does **not** synthesize a `pull_request.merged` event — author workflows should subscribe to `pull_request.closed` and branch on `_payload.pull_request.merged` via a conditional step. (Synthesizing a virtual `pull_request.merged` action is a documented future improvement; if added, it will be produced before `eventMatches` runs and recorded in `trigger_deliveries` under that name.)

### `workflow_executions` table

Execution instances.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | text PK | — | UUID |
| `workflowId` | text | — | FK to workflows, SET NULL on delete |
| `userId` | text NOT NULL | — | Owner |
| `triggerId` | text | — | FK to triggers, SET NULL on delete |
| `status` | text NOT NULL | — | See [State Machine](#state-machine) |
| `triggerType` | text NOT NULL | — | `'manual'` / `'webhook'` / `'schedule'` / `'github'` / `'retry'` / `'test'` (see migration 0013) |
| `triggerMetadata` | JSON text | — | Trigger-specific context |
| `variables` | JSON text | — | Input variables for this run |
| `outputs` | JSON text | — | Outputs after completion |
| `steps` | JSON text | — | Final step results (denormalized summary) |
| `error` | text | — | Error message if failed |
| `startedAt` | text NOT NULL | — | ISO datetime |
| `completedAt` | text | — | ISO datetime |
| `workflowVersion` | text | — | Snapshot of version at execution time |
| `workflowHash` | text | — | SHA-256 hash of workflow data at execution time |
| `workflowSnapshot` | text | — | Full workflow JSON snapshot |
| `idempotencyKey` | text | — | Prevents duplicate executions |
| `runtimeState` | text | — | JSON `RuntimeState` for WorkflowExecutorDO |
| `resumeToken` | text | — | Set when `status='waiting_approval'` |
| `attemptCount` | integer | `0` | Dispatch attempt count |
| `sessionId` | text | — | FK to sessions, SET NULL on delete |
| `initiatorType` | text | — | `'manual'` / `'schedule'` / `'webhook'` |
| `initiatorUserId` | text | — | Who triggered the execution |

**Indexes:** unique on `(workflowId, idempotencyKey)`.

### `workflow_execution_steps` table

Individual step traces.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `executionId` | text NOT NULL | FK to workflow_executions, CASCADE DELETE |
| `stepId` | text NOT NULL | Step identifier within the workflow |
| `attempt` | integer NOT NULL | Attempt number |
| `status` | text NOT NULL | `'pending'` / `'running'` / `'waiting_approval'` / `'completed'` / `'failed'` / `'cancelled'` / `'skipped'` |
| `inputJson` | JSON text | Step input |
| `outputJson` | JSON text | Step output |
| `error` | text | Error message |
| `startedAt` / `completedAt` | text | ISO datetime |

**Indexes:** unique on `(executionId, stepId, attempt)`. Upserts use `ON CONFLICT DO UPDATE` with COALESCE to preserve existing data.

### `workflow_mutation_proposals` table

Self-modification proposals.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `workflowId` | text NOT NULL | FK to workflows, CASCADE DELETE |
| `executionId` | text | FK to workflow_executions, SET NULL on delete |
| `proposedBySessionId` | text | Session that created the proposal |
| `baseWorkflowHash` | text NOT NULL | Hash of workflow at proposal time (stale detection) |
| `proposalJson` | text NOT NULL | The proposed new workflow definition |
| `diffText` | text | Human-readable diff |
| `status` | text NOT NULL | `'pending'` / `'approved'` / `'rejected'` / `'applied'` / `'failed'` |
| `reviewNotes` | text | Reviewer comments |
| `expiresAt` | text | Default 14 days from creation |

### `workflow_version_history` table

Immutable version snapshots.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `workflowId` | text NOT NULL | Reference (not FK — survives workflow deletion) |
| `workflowVersion` | text | Semver string |
| `workflowHash` | text NOT NULL | SHA-256 hash of workflow data |
| `workflowData` | text NOT NULL | Full workflow JSON snapshot |
| `source` | text NOT NULL | `'sync'` / `'update'` / `'proposal_apply'` / `'rollback'` / `'system'` |
| `sourceProposalId` | text | If source is `'proposal_apply'` |
| `notes` | text | Optional description |
| `createdBy` | text | User ID |

**Indexes:** unique on `(workflowId, workflowHash)` with `ON CONFLICT DO NOTHING` — identical snapshots are never duplicated.

### `workflow_schedule_ticks` table

Deduplication for cron runs.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `triggerId` | text NOT NULL | FK to triggers, CASCADE DELETE |
| `tickBucket` | text NOT NULL | ISO timestamp truncated to minute: `"2026-02-24T10:30"` |

**Indexes:** unique on `(triggerId, tickBucket)`.

### `pending_approvals` table

Approval gate tracking.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `executionId` | text NOT NULL | Reference |
| `stepId` | text NOT NULL | Step that requires approval |
| `message` | text NOT NULL | Approval prompt |
| `timeoutAt` | text | Optional deadline |
| `defaultAction` | text | Fallback if timeout |
| `status` | text | `'pending'` default |

**Note:** This table exists in the schema but is **not actively used**. The current approval mechanism uses `resumeToken` on the execution row directly. This table is scaffolding for a future more elaborate approval system.

### `trigger_deliveries` table

One row per dispatch attempt — every time a delivery is evaluated against a trigger we record the outcome. This is the audit/debug surface for "why did (or didn't) this webhook fire my workflow?"

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `triggerId` | text NOT NULL | FK to triggers, CASCADE DELETE |
| `userId` | text NOT NULL | Owner |
| `eventType` | text | Full event identifier, e.g. `pull_request.opened` |
| `deliveryId` | text | Provider-supplied delivery ID (e.g. GitHub's `X-GitHub-Delivery`) |
| `outcome` | text NOT NULL | One of: `matched`, `no_match`, `concurrency_cap`, `duplicate`, `workflow_deleted`, `error` |
| `executionId` | text | FK to workflow_executions, SET NULL on delete. Set when `outcome='matched'` |
| `reason` | text | Human-readable explanation (e.g. `"event \"push.tagged\" not in trigger.events"`) |
| `payloadPreview` | text | Size-capped JSON slice for debugging (larger for `matched`, smaller for hot-path `no_match`) |
| `receivedAt` | text NOT NULL | ISO datetime |

**Indexes:** `(triggerId)`, `(triggerId, receivedAt DESC)` (declared DESC on disk via migration 0014), `(userId)`.

The GitHub dispatcher batches `no_match` writes into a single bulk insert per delivery to avoid one round-trip per candidate trigger. Other outcomes (`matched`, `duplicate`, `concurrency_cap`, `workflow_deleted`, `error`) write synchronously since they are rare per delivery.

## State Machine

### Execution Statuses

```
PENDING ──────────────> RUNNING            (WorkflowExecutorDO dispatches to session)

RUNNING ──────────────> COMPLETED          (all steps succeed)
        ──────────────> FAILED             (step failure or engine error)
        ──────────────> CANCELLED          (user cancellation)
        ──────────────> WAITING_APPROVAL   (approval step reached)

WAITING_APPROVAL ─────> RUNNING            (approved — resumes execution)
                 ─────> CANCELLED          (denied)
```

Terminal states: `completed`, `failed`, `cancelled`.

### Proposal Statuses

```
PENDING ──────> APPROVED ──────> APPLIED
        ──────> REJECTED
                APPROVED ──────> FAILED    (apply failed, e.g. stale hash)
```

### Concurrency Limits

Active executions (`pending`, `running`, `waiting_approval`) are counted:
- **Per-user limit:** 5 (default)
- **Global limit:** 50 (default)

## API Contract

### Workflow Routes (`/api/workflows`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List user's workflows |
| GET | `/:id` | Get single (by ID or slug) |
| POST | `/sync` | Sync single workflow from plugin |
| POST | `/sync-all` | Full reconciliation sync (deletes workflows not in set) |
| PUT | `/:id` | Update workflow fields |
| DELETE | `/:id` | Delete workflow and its triggers |
| GET | `/:id/executions` | Execution history for workflow |
| GET | `/:id/history` | Version history snapshots |
| GET | `/:id/proposals` | List mutation proposals (filterable by status) |
| POST | `/:id/proposals` | Create self-modification proposal |
| POST | `/:id/proposals/:proposalId/review` | Approve or reject proposal |
| POST | `/:id/proposals/:proposalId/apply` | Apply approved proposal |
| POST | `/:id/rollback` | Roll back to historical hash |
| POST | `/draft` | LLM-backed workflow drafting (see [Drafting](#workflow-drafting)) |
| POST | `/draft/step` | LLM-backed per-step refinement |

### Execution Routes (`/api/executions`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List executions (filterable by status, workflowId) |
| GET | `/:id` | Single execution with workflow/trigger names |
| GET | `/:id/steps` | Normalized step trace with ordering |
| POST | `/:id/complete` | Report execution completion (from runner) |
| POST | `/:id/status` | Update execution status |
| POST | `/:id/approve` | Approve/deny an approval gate |
| POST | `/:id/cancel` | Cancel execution |

### Trigger Routes (`/api/triggers`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/manual/run` | Run a workflow directly (without trigger) |
| GET | `/` | List user's triggers |
| GET | `/:id` | Single trigger (includes webhookUrl for webhook type) |
| POST | `/` | Create trigger |
| PATCH | `/:id` | Update trigger |
| DELETE | `/:id` | Delete trigger |
| POST | `/:id/enable` | Enable trigger |
| POST | `/:id/disable` | Disable trigger |
| POST | `/:id/run` | Manually fire a trigger |

### WorkflowExecutorDO Internal Endpoints

Each execution gets its own DO instance (keyed by `executionId`).

| Path | Method | Description |
|------|--------|-------------|
| `/enqueue` | POST | Start execution — bootstrap session, dispatch to sandbox |
| `/resume` | POST | Resume after approval — validate token, dispatch or cancel |
| `/cancel` | POST | Cancel execution — stop session, update D1 |

## Flows

### Manual Workflow Run

1. Client calls `POST /api/triggers/manual/run` with `workflowId` (or slug) and optional variables.
2. Service resolves workflow, checks concurrency limits.
3. Checks idempotency key: `manual:{workflowId}:{userId}:{clientRequestId}`.
4. Creates a workflow session in D1 (purpose `'workflow'`, status `'hibernated'`).
5. Inserts execution row with status `pending`.
6. Calls `enqueueWorkflowExecution()` which POSTs to the WorkflowExecutorDO.
7. DO reads execution + workflow from D1.
8. DO bootstraps the workflow session: starts a Modal sandbox via the SessionAgent DO.
9. DO dispatches the workflow payload to the session via `POST http://do/workflow-execute`.
10. DO updates execution status to `running` and publishes `workflow.execution.enqueued` to EventBus.
11. Inside the sandbox, the Runner receives the workflow dispatch and invokes the workflow CLI.
12. The workflow engine executes steps sequentially.
13. On completion, the Runner calls `POST /api/executions/:id/complete` with status, outputs, and step results.

### Webhook Trigger

1. External system POSTs to `/webhooks/{path}`.
2. Worker looks up trigger by webhook path.
3. Verifies HTTP method matches.
4. Checks signature header presence if secret is configured (existence check only — **no cryptographic verification**).
5. Parses body, merges query params as `payload.query`.
6. Applies variable mapping (simple JSONPath: `$.key.nested.path`).
7. Checks idempotency via `webhook:{triggerId}:{deliveryId or bodyHash}`.
8. Checks concurrency limits.
9. Creates workflow session, execution, and enqueues to DO.

### Schedule Trigger (Cron)

1. Cloudflare Workers cron trigger fires the `scheduled()` handler.
2. `dispatchScheduledWorkflows()` queries all enabled schedule triggers with linked workflows.
3. For each trigger, parses the cron expression and checks if it matches current time (with timezone support).
4. Deduplication: inserts into `workflow_schedule_ticks` with unique `(triggerId, tickBucket)`. Duplicate inserts are silently ignored.
5. **Workflow targets:** checks concurrency, creates session, creates execution, enqueues to DO.
6. **Orchestrator targets:** dispatches prompt directly to the user's orchestrator session via `dispatchOrchestratorPrompt()`.
7. Updates `lastRunAt` on the trigger.

The cron matcher supports standard 5-field syntax: wildcards (`*`), exact values, ranges (`1-5`), steps (`*/5`), and comma-separated lists.

### GitHub Trigger

1. GitHub delivers a webhook to `/webhooks/github`. Signature verification is performed by the GitHub channel plugin (`packages/plugin-github/src/actions/triggers.ts`) via timing-safe HMAC SHA-256 against `x-hub-signature-256`.
2. The worker calls `dispatchGitHubTriggers(env, payload, eventType, deliveryId, workerOrigin)` for every event type — the dispatcher does its own event/repo/filter matching. Failures inside the dispatcher never 5xx the webhook; GitHub gets a 200 either way.
3. Dispatcher resolves the installation via `payload.installation.id` → `linkedUserId`; missing installations or org installs with no Valet user are silently skipped.
4. Candidate triggers are loaded with `WHERE type='github' AND enabled=1 AND user_id=?` (one round-trip per delivery).
5. For each candidate: parse `config`, apply repo allowlist, then `eventMatches(eventType, action, config.events)`, then `filterMatches(payload, eventType, config)` (branch / labels / actions). Any failed check logs a `no_match` (deferred to a single bulk insert) and moves on.
6. Matches that survive checks call `dispatchOne()`, which enforces concurrency, computes an idempotency key, creates the workflow session + execution row, and enqueues to the WorkflowExecutorDO. The outcome (`matched | duplicate | concurrency_cap | error`) is written to `trigger_deliveries` synchronously.
7. Matches that survive but have no linked workflow record an `outcome='workflow_deleted'` delivery.

### Trigger Deliveries (Audit Log)

Every dispatch attempt — whether it matched, was filtered out, was a duplicate, hit a concurrency cap, lost its workflow, or threw — writes one row to `trigger_deliveries` with the outcome and a payload preview. This is the canonical "did my webhook fire?" surface and is required for any post-hoc debugging of trigger behavior.

### Failure Notify (Orchestrator Escalation)

Workflow definitions support an optional top-level `failureNotify` field: `'orchestrator' | 'none'` (defaults to `'orchestrator'` when absent so legacy workflows opt in).

When an execution lands in `failed` or `cancelled` status **and** its `trigger_type` is not `'manual'`, the worker auto-notifies the user's orchestrator:

1. Reads `failureNotify` from `workflow_snapshot` (the snapshot at execution time, so a later workflow edit can't retroactively change escalation policy).
2. If the mode is `'orchestrator'`, formats a structured prompt that includes the workflow name, short execution ID, the first failed step's `stepId`, the error message, and the trigger type/name plus a deep link (`/automation/executions/{id}`).
3. Calls `sendSessionMessage(env, db, userId, orchestrator:{userId}, content, false, currentSessionId)` so the orchestrator agent receives it as a normal inbound message.

Manual triggers are excluded — the user already gets immediate UI feedback. Noisy workflows opt out with `failureNotify: 'none'`. Notification failures are logged and swallowed so they cannot break result-handling.

### Approval Gate

1. Workflow engine hits an `approval` step.
2. Engine derives a `resumeToken = "wrf_rt_" + sha256(executionId:stepId:attempt:approvalNonce).slice(0, 24)`. The `approvalNonce` is a server-generated random string the worker stores in `runtime_state.approvalNonce` on first dispatch and forwards on every subsequent run/resume payload via `payload.runtime.approvalNonce`. **Without the nonce the token would be derivable from public values (`executionId`, `stepId`, `attempt`) — any caller with read access to executions could forge an approval.** The nonce is never returned to clients. Legacy executions created before the nonce shipped fall back to the old deterministic derivation so in-flight workflows still complete.
3. Engine halts with `status: 'needs_approval'` and the resume token.
4. Runner reports completion to worker with the approval status and token.
5. Execution status set to `waiting_approval` in D1; resume token stored on the execution row.
6. User approves via `POST /api/executions/:id/approve` with `{ approve: true/false, resumeToken }`.
7. Worker forwards to WorkflowExecutorDO via `POST /resume`.
8. DO validates the resume token matches `row.resume_token`. Mismatch returns 400.
9. If approved: ensures session is ready, dispatches resume payload to session DO. Status -> `running`.
10. If denied: cancels the execution. Status -> `cancelled`.
11. On resume, the engine **replays from the beginning** — all approval steps before the target token are auto-approved (`replayed: true`). Execution continues after the matched gate.

The per-execution nonce also closes a race where a cancel and an approval arrive close together: the cancel transitions status away from `waiting_approval` and the approve-handler returns 409 (`Execution is not waiting approval`); even if a stale approval payload were re-submitted later after a re-enqueue, the nonce would have changed in `runtime_state` and the recomputed token would not match.

### Self-Modification Proposal

1. Agent (or user) creates a proposal via `POST /api/workflows/:id/proposals`.
2. Service validates the workflow allows self-modification (`constraints.allowSelfModification === true`).
3. Validates `baseWorkflowHash` matches the current workflow's SHA-256 hash (stale detection).
4. Creates proposal with status `pending`, 14-day expiry.
5. User reviews: `POST /api/workflows/:id/proposals/:proposalId/review` with `approve` or `reject`.
6. User applies: `POST /api/workflows/:id/proposals/:proposalId/apply`.
7. Apply flow:
   - Re-validates self-modification allowed and proposal is approved.
   - Checks proposal hasn't expired.
   - Re-validates `baseWorkflowHash` matches current (concurrent edit detection).
   - Creates pre-apply version history snapshot.
   - Updates workflow `data` and bumps patch version.
   - Marks proposal as `applied`.
   - Creates post-apply version history snapshot.

### Rollback

1. User calls `POST /api/workflows/:id/rollback` with `{ workflowHash }`.
2. Service saves current state as a version history snapshot.
3. Looks up the target version by hash in version history.
4. Validates the historical snapshot has a `steps` array.
5. If already at the target hash: returns `alreadyAtVersion: true`.
6. Updates workflow data, bumps version, creates rollback snapshot.

### Workflow Drafting

LLM-backed drafting endpoints generate or refine workflow definitions from natural language. Both endpoints use the `@anthropic-ai/sdk` server-side, validate the model's JSON output against `validateWorkflowDefinition`, and retry the LLM call up to 3 times on validation failure. Both return `{ workflow, attempts }`.

| Endpoint | Body | Behavior |
|----------|------|----------|
| `POST /api/workflows/draft` | `{ prompt: string, baseDraft?: WorkflowDefinition }` | Whole-workflow generation. If `baseDraft` is provided it is supplied to the model as the starting point; otherwise a workflow is drafted from scratch. |
| `POST /api/workflows/draft/step` | `{ workflow: WorkflowDefinition, stepId: string, instruction: string }` | Scoped refinement of a single step within an existing workflow. The model returns the full workflow with that step replaced. |

These endpoints do not persist anything — they return a draft for the client to review and subsequently `sync` or `PUT`.

### Step Event Reporting

While a workflow execution is running, the runner reports step lifecycle events live (rather than batching them until completion):

1. The workflow engine emits structured events to its sink: `step.started`, `step.completed`, `step.failed`, `step.skipped`, `step.cancelled`, `approval.required`, `approval.approved`, `approval.denied` (plus the lifecycle events listed in [Events](#events)).
2. The runner filters for `step.*` and `approval.*` and forwards each to the SessionAgentDO via a `workflow-step-event` WebSocket message (see [real-time.md → Workflow Step Events](real-time.md#workflow-step-events-runner--do)).
3. The DO verifies the execution belongs to its session, upserts a row into `workflow_execution_steps` keyed on `(execution_id, step_id, attempt)`, broadcasts a `workflow.execution.step` message to connected clients, and publishes the same event to the EventBus.
4. Clients listen via `useExecutionStepEvents` and patch the cached step trace returned by `GET /api/executions/:id/steps`.

The final `POST /api/executions/:id/complete` call still runs at the end and reconciles the denormalized summary on the execution row, but it is no longer the only source of step trace data — the table is populated incrementally as each step finishes.

## Step Execution Engine

The runner-side engine (`packages/runner/src/workflow-engine.ts`) executes workflow steps inside the Modal sandbox.

### Step Types

The compiler (`packages/runner/src/workflow-compiler.ts`) enforces a closed set of step types. The exact, shipped set is:

| Type | Behavior |
|------|----------|
| `agent_prompt` | Sends a prompt to the workflow's OpenCode session and captures the agent's final reply. Supports `interrupt`, `await_timeout_ms`, `thread`, and `outputSchema` (see [Structured Output for `agent_prompt`](#structured-output-for-agent_prompt)). |
| `notify` | Forwards `content` as a structured prompt to the user's orchestrator session. Only `target: 'orchestrator'` is supported. See [Notify step](#notify-step). |
| `tool` | Generic tool invocation; for `tool: 'bash'` it uses the same `{{path}}` → env-var rewrite as `bash` to avoid shell-metacharacter injection. |
| `bash` | Spawns `bash -lc <command>` via `Bun.spawn()`. Configurable timeout (default 120s, max 600s). Output truncated at 64K chars. `{{path}}` tokens in the command are routed through env vars rather than interpolated into the shell string. |
| `parallel` | Executes each entry in `steps` concurrently (`Promise.all`) with a snapshotted view of outputs/variables. Branch outputs are merged back into the parent context on success; on collision, last-writer-wins (authors should use distinct `outputVariable` per branch). Priority on non-clean child status: `failed > cancelled > approval`. |
| `conditional` | Evaluates `condition` against variables/outputs/loop, executes `then` or `else` branch. |
| `loop` | **foreach only**. Iterates `over` (a path like `outputs.list` or `variables.items`) and runs `steps` once per item. Each iteration publishes `{{loop.item}}` / `{{loop.index}}` (and user-named `itemVar` / `indexVar`). On any iteration failure, output mutations made during the loop are rolled back. There is no `while` / `until` variant. |
| `approval` | Halts execution with a `resumeToken` derived from a server-issued nonce; see [Approval gate](#approval-gate). |

Removed types (the validator rejects these with a guidance error):

- `agent` — replaced by `agent_prompt`.
- `agent_message` — replaced by `notify` (to push a message to the orchestrator) or `agent_prompt` (to capture an agent reply).
- `subworkflow` — inline the child steps instead.

There is no `delay` / `sleep` step at the workflow layer; long pauses are expressed via `approval` (human-in-the-loop) or by a `bash` step that sleeps.

### `agent_prompt` step

`agent_prompt` runs the workflow against an OpenCode session per `thread`:

- `thread` (string, optional): a stable name reuses the same channel + OpenCode session across calls within the execution. The literal value `@new` creates a fresh, single-use channel and tears it down on completion (preventing per-iteration channel leaks in loops). Absent/empty `thread` uses the shared default.
- `interrupt` (boolean, optional): aborts any in-flight OpenCode turn on that thread before sending.
- `await_timeout_ms` (number, optional, default `120_000`): clamped to `[1_000, 900_000]`.
- `outputSchema` — see below.

The runner builds a per-execution model-failover chain (`buildModelFailoverChain`) and retries non-fatal provider errors across candidates.

### Notify step

`notify` sends a structured prompt to the user's orchestrator session. The runner's `executeWorkflowNotifyStep` calls `agentClient.sendNotify({ executionId, stepId, target, content })`. On the worker side, the `SessionAgentDO` `notify` message handler delivers the content via `sendSessionMessage(...)` to `orchestrator:{userId}`, so the orchestrator agent picks it up as an inbound message.

`notify` replaces the removed `agent_message` step type for the "push a message somewhere" use case. Only `target: 'orchestrator'` is currently supported.

### Calling the `question` tool from `agent_prompt` is a HARD ERROR

Workflow channels run unattended — there is no human present to answer an interactive question. If the agent invokes the `question` tool while executing an `agent_prompt` step, the runner:

1. Records `channel.lastError = "agent_prompt_question_not_supported: agent attempted to ask \"…\""`.
2. Aborts the OpenCode session so `pollUntilIdle` resolves rather than blocking.
3. Returns the step result `{ status: 'failed', error: 'agent_prompt_question_not_supported: …' }`. Any partial text emitted before the abort is discarded — surfacing it as "completed" would mask the failure.

Workflow personas should be configured to never call `question`. If the agent needs human input, use an `approval` step or a `notify` step that asks the orchestrator to surface the question.

### Structured Output for `agent_prompt`

`agent_prompt.outputSchema` declares the shape of the agent's final reply:

```jsonc
{
  "type": "agent_prompt",
  "id": "extract",
  "prompt": "Pull the customer name and amount from the body.",
  "outputSchema": {
    "name":   { "type": "string", "description": "Full name" },
    "amount": { "type": "number" }
  },
  "outputVariable": "extracted"
}
```

Allowed field types are `string`, `number`, `boolean`, `array`, `object`. Field names must match `/^[a-zA-Z_][a-zA-Z0-9_]*$/`. Both the worker validator (`workflow-definition.ts`) and the runner compiler (`workflow-compiler.ts`) check schema shape; both also fail the step early if the schema is invalid rather than dropping it silently.

When `outputSchema` is present:

1. The runner appends a schema-instruction block to the user-provided prompt (`buildSchemaInstructions`) telling the agent to reply with ONLY a JSON object matching the shape.
2. After the agent goes idle, the reply is parsed (`parseStructuredOutput`) — fenced ```json blocks, raw `{…}` starts, and balanced-brace scans are all accepted.
3. **Extra keys are permitted; missing required keys, JSON parse failures, and type mismatches are errors.** `null` is allowed on any field as a way to express absence without dropping the key.
4. On failure, the runner sends a fixup follow-up to the **same** OpenCode session (`buildFixupPrompt`) with the parser error and a truncated copy of the bad reply, then re-polls. Up to `STRUCTURED_OUTPUT_MAX_ATTEMPTS = 3` total attempts (initial + 2 retries).
5. After all retries fail, the step returns `{ status: 'failed', error: 'agent_prompt_structured_output_invalid: …' }`.
6. When a schema is in use, the raw agent reply is **not** broadcast to the workflow channel — it's a machine payload, not user-facing text. The parsed object is the step's output (so `outputVariable` captures the object, and downstream steps can interpolate `{{outputs.extracted.name}}`).

### Execution Constraints

- **Max steps:** 50 (default), configurable via `runtime.policy.maxSteps`.
- **Output variables:** Steps with `outputVariable` store their output in the context's `outputs` map, accessible by subsequent steps.

### Events

The engine emits structured events to a sink: `execution.started`, `step.started`, `step.completed`, `step.failed`, `step.skipped`, `step.cancelled`, `approval.required`, `approval.approved`, `approval.denied`, `execution.finished`, `execution.resumed`. The runner forwards the `step.*` and `approval.*` events to the SessionAgentDO over the runner WebSocket; see [real-time.md → Workflow Step Events](real-time.md#workflow-step-events-runner--do) for transport details.

### Conditionals and Interpolation

Two related but distinct systems handle template values:

- **`{{path}}` interpolation** (`workflow-interpolation.ts`) — runs on string fields before each step executes. Supported root namespaces are `variables`, `outputs`, and `loop` (a convenience alias for `variables.loop`, populated by the engine inside a loop body). Other roots render as empty strings and the missing path is reported in logs. Examples: `{{variables.x}}`, `{{outputs.<stepId>.<path>}}`, `{{loop.item}}`, `{{loop.index}}`.
- **`conditional.condition` expressions** (`workflow-condition.ts`) — a purpose-built recursive-descent parser (no `eval` / `new Function`). Supports: numeric/string/boolean/null literals, `variables.*` / `outputs.*` / `loop.*` paths, parenthesized grouping, the unary `!`, and binary operators `||`, `&&`, `==`, `===`, `!=`, `!==`, `>`, `<`, `>=`, `<=`. Equality is JS-strict (no coercion); numeric comparisons require numbers on both sides (mixed types return false rather than coerce); missing paths read as `undefined` and never throw. Conditions are pre-resolved through `resolveInterpolation` so authors can mix `{{…}}` tokens with raw paths in the same expression. A legacy `{ variable, equals }` object shape is still accepted for backward compatibility. Syntactically invalid conditions are rejected at compile time — they do not silently evaluate to false at runtime.

### Workflow CLI

The runner uses a CLI wrapper (`packages/runner/src/workflow-cli.ts`) with these commands:

| Command | Description |
|---------|-------------|
| `run` | Execute workflow. Reads JSON from stdin. |
| `resume` | Resume after approval with `--decision approve\|deny`. |
| `validate` | Validate workflow definition from file or stdin. |
| `propose` | **Stub** — returns hardcoded mock proposal. |

Exit codes: 0 = success, 10 = input error, 20 = flag error, 40 = execution failure.

### Workflow Compiler

Normalizes and validates definitions before execution:
- Valid step types: `agent_prompt`, `notify`, `tool`, `bash`, `conditional`, `loop`, `parallel`, `approval`.
- Assigns IDs to steps lacking them (path-based: `step[0]`, `step[0].then[1]`, etc.).
- Validates `loop.over` (string path) + `loop.steps` (non-empty); `conditional.condition` syntax via the expression parser (rejects invalid syntax at compile time rather than letting it evaluate to false at runtime); `agent_prompt.outputSchema` shape; and the required content/fields per step type.
- Deep-sorts all objects for canonical hashing.
- Produces SHA-256 hash of the normalized workflow.

### Server-Side Validation

The worker-side validator (`packages/worker/src/lib/workflow-definition.ts`) checks:
- Workflow is an object with non-empty `steps` array.
- Top-level `failureNotify`, when present, is `'orchestrator'` or `'none'`.
- Each step has a `type` string.
- Explicitly **rejects** legacy step types with guidance: `agent` → use `agent_prompt`; `agent_message` → use `notify` or `agent_prompt`; `subworkflow` → inline the steps.
- `agent_prompt` requires content (`prompt` / `content` / `message` / `goal`); validates `interrupt` and `await_response` as boolean, `await_timeout_ms` as number ≥ 1000, `thread` as string, and `outputSchema` shape.
- `notify` requires `content`; `target`, when present, must be `'orchestrator'`.
- `loop` requires `over` (string) and a non-empty `steps` body; `itemVar` / `indexVar` must be valid identifiers.
- `conditional` requires a `condition` of type string / boolean / record. Full expression-syntax validation runs in the runner compiler.
- Nested `then`, `else`, `steps` arrays are recursively validated.

The runner-side compiler enforces the same step-type allowlist; both layers reject the removed types.

## WorkflowExecutorDO

Each execution gets its **own** DO instance, keyed by `executionId`. The DO manages three operations: enqueue, resume, and cancel.

### RuntimeState

Stored on the execution row in D1:

```typescript
interface RuntimeState {
  executor?: {
    dispatchCount: number;
    firstEnqueuedAt: string;
    lastEnqueuedAt: string;
    sessionId?: string;
    triggerType: 'manual' | 'webhook' | 'schedule' | 'github' | 'retry' | 'test';
    promptDispatchedAt?: string;
    sessionStartedAt?: string;
    workerOrigin?: string;
    lastError?: string;
  };
  /** Random per-pause nonce used to derive approval resume tokens.
   *  Forwarded to the runner on every dispatch via `payload.runtime.approvalNonce`.
   *  See [Approval Gate](#approval-gate). */
  approvalNonce?: string;
  /** Retry-from-step directive set by `POST /api/executions/:id/retry`. */
  retry?: {
    startFromStepId: string;
    replayOutputs: Record<string, unknown>;
    replayStepResults: Record<string, { output?: unknown; status?: string }>;
  };
}
```

### Session Bootstrapping

When the DO receives an enqueue request and the workflow session needs a sandbox:
1. Reads the existing session from D1.
2. If session needs bootstrapping: calls `bootstrapWorkflowSession()`.
3. Bootstrap starts a Modal sandbox via the SessionAgent DO (`SESSIONS` DO binding).
4. The sandbox receives environment variables including `IS_WORKFLOW_SESSION=true`, `WORKFLOW_ID`, `WORKFLOW_EXECUTION_ID`.
5. Once the session is running, dispatches the workflow payload via `POST http://do/workflow-execute`.

### Dispatch Retry

`enqueueWorkflowExecution()` retries up to 5 times with increasing delays (150ms * attempt) on transient errors (404, 408, 429, 500). Also handles 200 OK with `promptDispatched=false`.

### Workflow Hash Computation

The DO has its own canonical hash computation that normalizes the workflow definition by recursively deep-sorting all object keys, normalizing step IDs, and producing `sha256:XXXX` format hashes.

## Edge Cases & Failure Modes

### Idempotency

Duplicate executions are prevented by the `idempotencyKey` unique index on `(workflowId, idempotencyKey)`. Key formats:
- Manual: `manual:{workflowId}:{userId}:{clientRequestId}`
- Webhook: `webhook:{triggerId}:{deliveryId or bodyHash}`
- Schedule: deduplication via `workflow_schedule_ticks` table

### Stale Proposal Detection

Proposals store `baseWorkflowHash`. Both creation and application validate this matches the current workflow hash. If the workflow was modified between proposal creation and apply, the apply is rejected.

### Webhook Signature Verification Gap

The webhook handler checks for signature header presence when a trigger has a `secret` configured, but does **not cryptographically verify** the actual signature value. This is a known gap.

### Parallel Step Execution

The `parallel` step type executes its branches **concurrently** via `Promise.all` over snapshotted output/variable contexts. Branch outputs are merged back into the parent on success; on collision, last-writer-wins (use distinct `outputVariable` names per branch to avoid this). On a non-clean child status the parent surfaces failures in priority order: `failed > cancelled > approval`.

### Sync-All Reconciliation

`syncAllWorkflows()` performs a full reconciliation: it deletes any existing workflows NOT in the incoming set. This is a destructive operation intended for plugin startup.

## Implementation Status

### Fully Implemented
- Complete workflow CRUD with version history and rollback
- Workflow sync from plugin (single + batch reconciliation)
- Four trigger types: webhook, schedule, manual, github
- GitHub triggers wired to the GitHub App installation with HMAC signature verification, repo/event/filter matching, deferred bulk `no_match` logging, and full delivery audit
- `trigger_deliveries` table populated on every dispatch attempt (`matched | no_match | concurrency_cap | duplicate | workflow_deleted | error`)
- Cron schedule evaluation with timezone support and tick deduplication
- Generic webhook handler with variable mapping and idempotency
- Execution lifecycle: create, run, complete, cancel
- Concurrency limits (per-user: 5, global: 50)
- WorkflowExecutorDO with session bootstrapping and dispatch retry
- Runner-side workflow engine with step types: `agent_prompt`, `notify`, `tool`, `bash`, `conditional`, `loop` (foreach), `parallel` (concurrent), `approval`
- `agent_prompt` structured-output via `outputSchema` with LLM-driven fixup retries (up to 3 total attempts) and machine-payload channel suppression
- Hard-fail when an `agent_prompt` step's agent invokes the `question` tool (workflow channels are unattended)
- `notify` step that delivers content to the user's orchestrator via the `SessionAgentDO` `notify` handler
- Approval gates with **nonce-protected** resume tokens (`payload.runtime.approvalNonce`) and replay-based resumption
- `failureNotify` policy that auto-escalates failed/cancelled non-manual executions to the orchestrator, with a `'none'` opt-out
- Self-modification proposals: create, review, apply with hash-based stale detection
- Version history with immutable snapshots and rollback
- Live step event reporting from runner via SessionAgentDO (`workflow-step-event` WS message → `workflow_execution_steps` upsert → `workflow.execution.step` client broadcast); see [real-time.md](real-time.md)
- LLM-backed workflow drafting endpoints (`POST /api/workflows/draft`, `POST /api/workflows/draft/step`)
- Client-side React Query hooks for all operations

### Partially Implemented / Stubbed
- **`propose` CLI command**: returns hardcoded stub. Server-side proposal API works, but CLI-based proposal generation from natural language is not implemented.
- **`pending_approvals` table**: schema exists but not actively used. Approvals use `resumeToken` on execution row.
- **Generic webhook signature verification**: checks presence, not cryptographic validity. (GitHub triggers, by contrast, do full HMAC verification via the plugin.)
- **Synthesized `pull_request.merged` event**: not currently emitted. GitHub real semantics are `pull_request.closed` with `merged === true` — workflows branch on the payload via a conditional step.

### Not Implemented
- No shared TypeScript types for workflows in `packages/shared` — types exist only in client and service layers.
- No UI for configuring `allowSelfModification` constraint.
