---
# valet-pg9a
title: Policy-Gated Actions
status: todo
type: epic
priority: high
tags:
    - integrations
    - architecture
    - security
    - actions
created_at: 2026-02-24T00:00:00Z
updated_at: 2026-02-24T00:00:00Z
---

Add risk classification and approval gates for outbound actions (creating issues, sending emails, posting messages, etc.) so that every external side effect goes through a policy check before execution. The model: every action declares a risk level (`read` / `write` / `danger`), a policy cascade resolves whether to `allow`, `require_approval`, or `deny`, and every invocation is logged with full audit trail.

## Problem

Agent-ops currently has **no policy layer** between "agent decides to do something" and "side effect happens." When a session agent creates a GitHub issue via `pushEntity('issue', data)`, or when the orchestrator sends a Telegram message, the operation executes immediately with no:

- **Risk assessment** — Is creating an issue safe? Is sending an email risky? Is deleting a branch dangerous? All operations are treated equally.
- **Human approval** — No way for a user to say "let the agent read repos freely, but ask me before creating PRs."
- **Audit trail** — No record of what external operations the agent performed, when, or with what parameters. If an agent sends 50 emails, there's no log.
- **Org-level policy** — An org admin cannot restrict what integrations their agents can use or what operations they can perform.
- **Rate limiting** — No per-action or per-service rate limits. An agent could spam an external API.

### What this means for wholesale deployment

Deploying valet to organizations means agents act on behalf of employees. An agent that can silently create GitHub issues, send emails, post Slack messages, or modify calendar events without oversight is a liability. Organizations need:

1. Clear visibility into what agents are doing with external services
2. Ability to require approval for high-risk operations
3. Ability to deny dangerous operations entirely
4. Audit logs for compliance

### Current state of outbound operations

| Operation | Where It Happens | Policy Check | Audit |
|---|---|---|---|
| Create GitHub issue | `GitHubIntegration.pushEntity()` | None | None |
| Create GitHub comment | `GitHubIntegration.pushEntity()` | None | None |
| Create GitHub PR | `routes/repos.ts` POST `/api/repos/pull-request` | None (auth only) | None |
| Send email | `GmailIntegration.pushEntity()` | None | None |
| Create calendar event | `GoogleCalendarIntegration.pushEntity()` | None | None |
| Send Telegram message | `services/telegram.ts` | None | None |
| Notify session DO | `services/webhooks.ts` | None | None |

## Design

### Risk Levels

Every action definition (from bean cp7w) declares a risk level:

```typescript
export type RiskLevel = 'read' | 'write' | 'danger';
```

| Risk | Meaning | Examples |
|---|---|---|
| `read` | Retrieves data, no side effects | List repos, get issue, fetch calendar events |
| `write` | Creates or modifies external state | Create issue, send email, update event, post message |
| `danger` | Destructive or hard-to-reverse | Delete branch, close PR, remove team member, purge messages |

Risk is declared at the action definition level:

```typescript
// In actions/github/definitions.ts
{
  id: 'github.create_issue',
  risk: 'write',
  // ...
}

{
  id: 'github.delete_branch',
  risk: 'danger',
  // ...
}

{
  id: 'github.list_repos',
  risk: 'read',
  // ...
}
```

### Three-Mode Permission Cascade

For each action invocation, the system resolves an execution mode:

```typescript
export type ActionMode = 'allow' | 'require_approval' | 'deny';
```

Resolution order (first match wins):

1. **Per-action override** — The org or user has set a specific mode for this exact action ID (e.g., `github.create_issue` → `require_approval`).
2. **Per-service override** — The org or user has set a mode for all actions from this service (e.g., all `gmail.*` → `require_approval`).
3. **Per-automation override** — The workflow/session has a mode set for unattended execution (e.g., workflow runs → `allow` for `write`, `deny` for `danger`).
4. **Org default** — The org has a default mode per risk level.
5. **System default** — Inferred from risk level:
   - `read` → `allow`
   - `write` → `require_approval`
   - `danger` → `deny`

### Policy Storage

#### `action_policies` D1 Table

```sql
CREATE TABLE action_policies (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  scope TEXT NOT NULL,            -- 'action' | 'service' | 'risk_level'
  scope_value TEXT NOT NULL,      -- action ID, service name, or risk level
  mode TEXT NOT NULL,             -- 'allow' | 'require_approval' | 'deny'
  created_by TEXT NOT NULL,       -- userId of admin who set this
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(org_id, scope, scope_value)
);

CREATE INDEX idx_action_policies_org ON action_policies(org_id);
```

Example rows:
```
| org_id | scope       | scope_value          | mode             |
|--------|-------------|----------------------|------------------|
| org1   | action      | github.create_issue  | allow            |
| org1   | service     | gmail                | require_approval |
| org1   | risk_level  | danger               | deny             |
```

### Action Invocations (Audit Trail)

#### `action_invocations` D1 Table

```sql
CREATE TABLE action_invocations (
  id TEXT PRIMARY KEY,
  action_id TEXT NOT NULL,             -- e.g., 'github.create_issue'
  service TEXT NOT NULL,               -- e.g., 'github'
  risk TEXT NOT NULL,                  -- 'read' | 'write' | 'danger'
  resolved_mode TEXT NOT NULL,         -- 'allow' | 'require_approval' | 'deny'
  status TEXT NOT NULL,                -- 'pending_approval' | 'approved' | 'denied' | 'executing' | 'completed' | 'failed'

  -- Context
  session_id TEXT,                     -- which session triggered this
  user_id TEXT NOT NULL,               -- on behalf of whom
  org_id TEXT,

  -- Parameters (redacted for sensitive fields)
  params TEXT,                         -- JSON of action parameters (may be truncated)

  -- Result
  result TEXT,                         -- JSON of action result (may be truncated)
  error TEXT,                          -- Error message if failed

  -- Approval
  approved_by TEXT,                    -- userId of approver (null if auto-allowed)
  approved_at TEXT,
  denied_by TEXT,
  denied_at TEXT,
  denial_reason TEXT,

  -- Timestamps
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  started_at TEXT,
  completed_at TEXT
);

CREATE INDEX idx_action_invocations_session ON action_invocations(session_id);
CREATE INDEX idx_action_invocations_user ON action_invocations(user_id, created_at);
CREATE INDEX idx_action_invocations_status ON action_invocations(status);
CREATE INDEX idx_action_invocations_org ON action_invocations(org_id, created_at);
```

### Action Service

```typescript
// packages/worker/src/services/actions.ts

export interface InvokeActionParams {
  actionId: string;            // e.g., 'github.create_issue'
  params: Record<string, unknown>;
  sessionId?: string;
  userId: string;
  orgId?: string;
}

export interface InvokeActionResult {
  invocationId: string;
  status: 'approved' | 'pending_approval' | 'denied';
  result?: unknown;            // Only present if status is 'approved' and execution completed
  error?: string;
}

/**
 * Entry point for all outbound actions.
 * 1. Look up action definition
 * 2. Resolve mode from policy cascade
 * 3. Create invocation row
 * 4. Execute, gate, or deny
 */
export async function invokeAction(
  env: Env,
  params: InvokeActionParams,
): Promise<InvokeActionResult>;

/**
 * Approve a pending action invocation.
 * Called by a user via the UI or API.
 */
export async function approveAction(
  env: Env,
  invocationId: string,
  approvedBy: string,
): Promise<InvokeActionResult>;

/**
 * Deny a pending action invocation.
 */
export async function denyAction(
  env: Env,
  invocationId: string,
  deniedBy: string,
  reason?: string,
): Promise<void>;
```

### Invocation Lifecycle

```
invokeAction()
  │
  ├─ Look up action definition from actionRegistry
  │  └─ Not found? → throw ValidationError
  │
  ├─ Resolve mode from policy cascade
  │  ├─ Per-action override?  → use it
  │  ├─ Per-service override? → use it
  │  ├─ Org default for risk? → use it
  │  └─ System default        → read=allow, write=require_approval, danger=deny
  │
  ├─ Create invocation row (status based on mode)
  │  ├─ allow           → status='approved'
  │  ├─ require_approval → status='pending_approval'
  │  └─ deny            → status='denied'
  │
  ├─ If denied:
  │  └─ Return { status: 'denied' }
  │
  ├─ If pending_approval:
  │  ├─ Notify user via session WebSocket (question-like UI)
  │  └─ Return { status: 'pending_approval', invocationId }
  │    (caller polls or waits for WebSocket notification)
  │
  └─ If approved (immediate or after approval):
     ├─ Resolve credential via getCredential() (bean tk3n)
     ├─ Update status → 'executing'
     ├─ Call action.execute(params, { token, ... })
     ├─ Update status → 'completed' or 'failed'
     └─ Return { status: 'approved', result }
```

### Approval UX

When an action requires approval, the session's UI needs to present it. This integrates with the existing question/prompt system:

1. **Action invocation with `pending_approval` status** → push event to session WebSocket
2. **Client renders approval card** in the chat stream (similar to question prompt)
3. **User clicks Approve/Deny** → calls `POST /api/actions/:id/approve` or `/deny`
4. **Action executes** → result pushed to chat stream

For Telegram/Slack channels, the approval prompt is sent as a message with inline buttons.

### API Routes

```
POST   /api/actions/invoke              — Invoke an action
POST   /api/actions/:id/approve         — Approve a pending action
POST   /api/actions/:id/deny            — Deny a pending action
GET    /api/actions/:id                  — Get invocation details
GET    /api/sessions/:id/actions         — List actions for a session
GET    /api/admin/actions                — List all actions (admin, with filters)
GET    /api/admin/action-policies        — List org action policies
PUT    /api/admin/action-policies        — Set/update an action policy
DELETE /api/admin/action-policies/:id    — Remove an action policy
```

### How the Agent Invokes Actions

The session agent (via Runner → OpenCode) needs a way to invoke actions. Two options:

**Option A: OpenCode custom tool.** Define a `run_action` tool in the OpenCode configuration that calls the worker API:

```json
{
  "name": "run_action",
  "description": "Execute an external action (create issue, send email, etc.)",
  "parameters": {
    "action_id": "string",
    "params": "object"
  }
}
```

The tool implementation in Runner calls `POST /api/actions/invoke` on the worker. If the action requires approval, the tool returns a "waiting for approval" message and the agent waits.

**Option B: Runner dispatches via DO.** Runner sends an `action_invoke` message over its WebSocket to SessionAgentDO, which calls the action service internally.

Option A is simpler and doesn't require DO changes. Option B has lower latency but couples the action system to the DO.

## Migration Plan

### Phase 1: Schema and service

1. Create D1 migrations for `action_policies` and `action_invocations` tables
2. Create `services/actions.ts` with `invokeAction()`, `approveAction()`, `denyAction()`
3. Create `services/action-policy.ts` with `resolveMode()` policy cascade
4. Add Drizzle schema definitions

### Phase 2: API routes

1. Create `routes/actions.ts` with invocation and approval endpoints
2. Add admin policy management to `routes/admin.ts`
3. Wire routes into `index.ts`

### Phase 3: Integrate with action definitions

Once action definitions exist (from bean cp7w), update `invokeAction()` to:
1. Look up the action definition from the registry
2. Validate params against the Zod schema
3. Use the declared risk level for policy resolution

### Phase 4: Agent integration

1. Add `run_action` OpenCode custom tool definition
2. Update Runner to handle action invocation responses (including pending approval)
3. Add approval prompt rendering in session chat UI

### Phase 5: Channel-specific approval UX

1. Telegram: send approval prompt as inline keyboard buttons
2. Slack (future): send approval prompt as Block Kit interactive message
3. Web: render approval card in chat stream (similar to question prompt)

## Files to Create

| File | Purpose |
|---|---|
| `packages/worker/migrations/NNNN_action_policies.sql` | D1 migration for policies table |
| `packages/worker/migrations/NNNN_action_invocations.sql` | D1 migration for invocations table |
| `packages/worker/src/services/actions.ts` | Action invocation service |
| `packages/worker/src/services/action-policy.ts` | Policy resolution cascade |
| `packages/worker/src/routes/actions.ts` | Action API routes |
| `packages/worker/src/lib/db/actions.ts` | DB helpers for invocations and policies |
| `packages/worker/src/lib/schema/actions.ts` | Drizzle schema for new tables |

## Files to Modify

| File | Change |
|---|---|
| `packages/worker/src/index.ts` | Mount action routes |
| `packages/worker/src/routes/admin.ts` | Add policy management endpoints |
| `packages/shared/src/types/index.ts` | Add `RiskLevel`, `ActionMode`, `ActionInvocation` types |
| `packages/client/src/api/` | Add action query hooks |
| `packages/client/src/components/` | Add approval prompt component |

## Relationship to Other Beans

- **valet-tk3n (Unified Credential Boundary)** — Prerequisite. `invokeAction()` calls `getCredential()` to resolve credentials before executing an approved action.
- **valet-cp7w (Control Plane / Execution Plane Split)** — Prerequisite (partially). Action definitions with typed params and risk levels come from the action plane defined in that bean. The policy service consumes the risk level from action definitions.
- **valet-pa5m (Polymorphic Action Sources)** — The action service defined here becomes the execution engine that polymorphic action sources feed into. Whether the action comes from a static provider adapter or a dynamic MCP connector, it goes through the same policy gate.
- **valet-wh8d (Durable Webhook Inbox)** — Webhook-triggered actions (e.g., "on PR opened, create Linear ticket") flow from the inbox processor through the action service, respecting policies.
- **valet-ch4t (Pluggable Channel Transports)** — Explicit agent actions from channel packages (e.g., `telegram.pin_message`) go through the policy gate like any other action. The bidirectional messaging path (system-routed replies) does NOT go through the policy gate — it's a system operation, not an agent-initiated action. Approval prompts need per-channel rendering (inline keyboard for Telegram, Block Kit for Slack).

## Open Questions

1. **Approval timeout.** How long does a `pending_approval` action wait? If the user doesn't respond in 30 minutes, should it auto-deny? Auto-expire? The agent is blocked waiting.

2. **Batch approval.** If an agent wants to create 10 GitHub issues, does each one require individual approval? Or can the user approve "create issues in repo X" as a blanket grant for the session?

3. **Read action logging.** Should `read` actions (which default to `allow`) be logged in `action_invocations`? Full logging provides audit trail but could be noisy (every repo list, every issue fetch). Options: log all, log only write+danger, configurable per org.

4. **Offline approval.** If the user is not connected to the session when an action requires approval, how is we notify them? Push notification? Email? Or just wait until they reconnect?

5. **Policy inheritance.** If an org sets `gmail.*` → `deny`, can a specific user override this to `allow`? Or are org policies absolute? Recommendation: start with org-only policies (no per-user overrides) for simplicity. Per-user overrides add a combinatorial explosion to policy resolution.

## Acceptance Criteria

- [ ] `action_policies` and `action_invocations` D1 tables exist with migrations
- [ ] `services/actions.ts` implements `invokeAction()` with full policy cascade
- [ ] Policy resolution: per-action → per-service → org default → system default
- [ ] `allow` mode: action executes immediately, invocation logged
- [ ] `require_approval` mode: invocation created as `pending_approval`, user notified
- [ ] `deny` mode: invocation created as `denied`, action not executed
- [ ] `approveAction()` transitions pending → approved → executing → completed/failed
- [ ] `denyAction()` transitions pending → denied
- [ ] API routes for invoke, approve, deny, list
- [ ] Admin routes for policy CRUD
- [ ] Invocations include params, result, timestamps, and approval metadata
- [ ] `pnpm typecheck` passes
- [ ] Shared types for `RiskLevel`, `ActionMode`, `ActionInvocation` in `@valet/shared`
