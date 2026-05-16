# Workflows

> Defines the workflow automation system — workflow definitions, trigger types, execution lifecycle, step execution engine, approval gates, self-modification proposals, and version history.

## Scope

This spec covers:

- Workflow definition schema and validation
- Trigger types (webhook, schedule, manual) and routing
- Execution lifecycle and concurrency control
- WorkflowExecutorDO behavior (enqueue, resume, cancel)
- Runner-side step execution engine (all step types)
- Approval gates and resume mechanism
- Self-modification proposals (create, review, apply)
- Version history and rollback
- Cron schedule evaluation and deduplication
- Webhook handler with variable mapping

### Boundary Rules

- This spec does NOT cover the OpenCode tools that invoke workflows (those use the gateway internal API documented in [sandbox-runtime.md](sandbox-runtime.md))
- This spec does NOT cover session lifecycle or sandbox management (see [sessions.md](sessions.md))
- This spec does NOT cover the orchestrator's relationship to workflows (see [orchestrator.md](orchestrator.md))

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
| `type` | text NOT NULL | — | `'webhook'` / `'schedule'` / `'manual'` |
| `config` | text NOT NULL | — | JSON: discriminated union by type |
| `variableMapping` | text | — | JSON: `Record<string, string>` mapping incoming data to workflow vars |
| `lastRunAt` | text | — | ISO datetime |
| `createdAt` / `updatedAt` | text | `datetime('now')` | ISO datetime |

**Trigger config shapes:**

```typescript
type TriggerConfig =
  | { type: 'webhook'; path: string; method?: string; secret?: string; headers?: Record<string, string> }
  | { type: 'schedule'; cron: string; timezone?: string; target?: 'workflow' | 'orchestrator'; prompt?: string }
  | { type: 'manual' };
```

Schedule triggers with `target: 'orchestrator'` dispatch a prompt to the user's orchestrator session instead of running a workflow. These have a nullable `workflowId`.

### `workflow_executions` table

Execution instances.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | text PK | — | UUID |
| `workflowId` | text | — | FK to workflows, SET NULL on delete |
| `userId` | text NOT NULL | — | Owner |
| `triggerId` | text | — | FK to triggers, SET NULL on delete |
| `status` | text NOT NULL | — | See [State Machine](#state-machine) |
| `triggerType` | text NOT NULL | — | `'manual'` / `'webhook'` / `'schedule'` |
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

### Approval Gate

1. Workflow engine hits an `approval` step.
2. Engine generates a deterministic `resumeToken` via `sha256(executionId:stepId:attempt)`.
3. Engine halts with `status: 'needs_approval'` and the resume token.
4. Runner reports completion to worker with the approval status and token.
5. Execution status set to `waiting_approval` in D1.
6. User approves via `POST /api/executions/:id/approve` with `{ approve: true/false, resumeToken }`.
7. Worker forwards to WorkflowExecutorDO via `POST /resume`.
8. DO validates the resume token matches.
9. If approved: ensures session is ready, dispatches resume payload to session DO. Status -> `running`.
10. If denied: cancels the execution. Status -> `cancelled`.
11. On resume, the engine **replays from the beginning** — all approval steps before the target token are auto-approved (`replayed: true`). Execution continues after the matched gate.

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

| Type | Behavior |
|------|----------|
| `bash` | Spawns `bash -lc <command>` via `Bun.spawn()`. Configurable timeout (default 120s, max 600s). Output truncated at 64K chars. |
| `tool` | Delegates to hooks. Falls through to bash for `tool=bash`. |
| `agent` / `agent_message` | Delegates to hooks provided by the runner integration. Content from `content`, `message`, or `goal` fields. |
| `conditional` | Evaluates `condition` against variables/outputs, executes `then` or `else` branch. |
| `parallel` | Executes `steps` array. **Note: actually runs sequentially despite the name.** |
| `approval` | Generates deterministic resume token, halts execution. |
| `loop` | Valid in compiler but **no specific execution logic** — falls through to default handler. |
| `subworkflow` | Valid in compiler but **no specific execution logic** — falls through to default handler. |

### Execution Constraints

- **Max steps:** 50 (default), configurable via `runtime.policy.maxSteps`.
- **Output variables:** Steps with `outputVariable` store their output in the context's `outputs` map, accessible by subsequent steps.

### Events

The engine emits structured events to a sink: `execution.started`, `step.started`, `step.completed`, `step.failed`, `step.cancelled`, `approval.required`, `approval.approved`, `approval.denied`, `execution.finished`, `execution.resumed`.

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
- Valid step types: `agent`, `agent_message`, `tool`, `bash`, `conditional`, `loop`, `parallel`, `subworkflow`, `approval`.
- Assigns IDs to steps lacking them (path-based: `step[0]`, `step[0].then[1]`, etc.).
- Deep-sorts all objects for canonical hashing.
- Produces SHA-256 hash of the normalized workflow.

### Server-Side Validation

The worker-side validator (`packages/worker/src/lib/workflow-definition.ts`) checks:
- Workflow is an object with non-empty `steps` array.
- Each step has a `type` string.
- `agent_message` steps require content.
- `interrupt` and `await_response` must be boolean, `await_timeout_ms` must be >= 1000.
- Nested `then`, `else`, `steps` arrays are recursively validated.

Does **not** check for valid step types — that's only done in the runner-side compiler.

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
    triggerType: 'manual' | 'webhook' | 'schedule';
    promptDispatchedAt?: string;
    sessionStartedAt?: string;
    workerOrigin?: string;
    lastError?: string;
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

The `parallel` step type exists in the compiler and engine, but executes sub-steps **sequentially**. No actual parallelism is implemented.

### Sync-All Reconciliation

`syncAllWorkflows()` performs a full reconciliation: it deletes any existing workflows NOT in the incoming set. This is a destructive operation intended for plugin startup.

## Implementation Status

### Fully Implemented
- Complete workflow CRUD with version history and rollback
- Workflow sync from plugin (single + batch reconciliation)
- Three trigger types: webhook, schedule, manual
- Cron schedule evaluation with timezone support and tick deduplication
- Webhook handler with variable mapping and idempotency
- Execution lifecycle: create, run, complete, cancel
- Concurrency limits (per-user: 5, global: 50)
- WorkflowExecutorDO with session bootstrapping and dispatch retry
- Runner-side workflow engine with step types: bash, tool, agent, agent_message, conditional, parallel, approval
- Approval gates with deterministic resume tokens and replay-based resumption
- Self-modification proposals: create, review, apply with hash-based stale detection
- Version history with immutable snapshots and rollback
- Live step event reporting from runner via SessionAgentDO (`workflow-step-event` WS message → `workflow_execution_steps` upsert → `workflow.execution.step` client broadcast)
- LLM-backed workflow drafting endpoints (`POST /api/workflows/draft`, `POST /api/workflows/draft/step`)
- Client-side React Query hooks for all operations

### Partially Implemented / Stubbed
- **`propose` CLI command**: returns hardcoded stub. Server-side proposal API works, but CLI-based proposal generation from natural language is not implemented.
- **`pending_approvals` table**: schema exists but not actively used. Approvals use `resumeToken` on execution row.
- **Webhook signature verification**: checks presence, not cryptographic validity.
- **`parallel` step type**: runs sub-steps sequentially.
- **`loop` and `subworkflow` step types**: valid in compiler but fall through to a no-op default handler.

### Not Implemented
- No shared TypeScript types for workflows in `packages/shared` — types exist only in client and service layers.
- No UI for configuring `allowSelfModification` constraint.
