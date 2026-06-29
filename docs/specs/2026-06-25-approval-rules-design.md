# Parameter-Matched Action Policies

## Goal

Valet should have one approval framework — one resolver, one API surface, one mental model — covering:

- organization/admin allow, require-approval, and deny policy
- user-created "approve matching requests" durable policy
- runtime-scoped approvals for a session, workflow execution, or remaining `foreach` iterations
- parameter-sensitive rules such as "allow Google Sheets writes only for this spreadsheet and ranges beginning with `Companies!`"

The workflow problem this solves is approval fatigue. Background workflows should not repeatedly stop on equivalent approvals, especially inside `foreach(concurrency: 1)` where only one pending approval exists at a time. A user should be able to approve the current request and have future matching requests in the same run, session, or durable user scope auto-approve — without spawning a parallel approval-rules subsystem.

"One framework" means one resolver and one conceptual model. It does **not** mean one physical table. Durable policy and ephemeral runtime grants have different lifecycles, and the data model splits them accordingly (see Data Model).

## Non-Goals

- Do not add an `approval_rules` table.
- Do not preserve `user_action_policy_overrides` as a second long-term policy framework.
- Do not let user-created allow policies bypass organization/admin deny policy.
- Do not create durable policies from unresolved workflow templates.
- Do not create broad "always approve all writes" policies by default.
- Do not require a full custom policy builder in the first UI. The first durable-policy flow can start from concrete approval prompts.
- Do not introduce an `environment` dimension. dev and prod are separate Cloudflare deployments with separate D1 databases — the deployment is the environment. No other table in the schema carries `environment`, and this one should not either.
- Do not add `team`-scoped or multi-environment policy columns yet. They are deferred until multi-org / team membership actually lands; speculative enum values invite half-implemented resolver paths.
- Do not fold `disabled_actions` into this framework. It is a separate capability-availability layer, not a duplicate of the per-invocation policy decision (see "Relationship to `disabled_actions`"). Unifying the two is a deliberate later effort, not part of this work.

## Core Concepts

### Approval Request

An approval request is a concrete runtime attempt to do something gated:

- a session tool call asking to run a risky action
- a workflow `tool` node blocked by action policy
- a workflow `approval` node
- a tool call inside a workflow-created session
- a tool call inside a `foreach` body node

Every approval request should expose:

- requester context: session id, workflow execution id, workflow id, workflow version id, node id, iteration index if any
- subject: stable target being approved
- policy target: service/action/risk level or workflow-node subject
- resolved runtime params
- prompt, summary, and details for UI

### Two Storage Tables, One Resolver

The framework is **one resolver** over **two tables** differentiated by lifecycle:

- **`action_policies` — durable.** Admin/org rules and user durable "always approve matching" grants. Long-lived, edited in settings, survives sessions and executions. Carries parameter matchers.
- **`runtime_grants` — ephemeral.** Session- and workflow-execution-scoped allow grants (including "approve remaining `foreach` rows"). Always `mode = allow`. Bound to a parent context; deleted when that context becomes terminal. High-churn, never durable.

This keeps the durable hot-path table small and lets explicit cleanup on terminal transition (plus FK cascade on parent deletion) handle "context ended → grant gone," instead of forcing every resolution to liveness-join against session/execution state. Today's `user_action_policy_overrides` already plays the ephemeral role for sessions; `runtime_grants` generalizes it to workflow executions, and `action_policies` absorbs the durable user grants.

The orchestrator is not a separate scope. The user/org orchestrator is itself an agent session (well-known id `orchestrator:{userId}` / `orchestrator:org:{orgId}`), so its tool approvals resolve through the normal `session` scope on that session id — there is no `orchestrator_run` entity, table, or lifecycle to scope against.

The UI may still use friendly words:

- **Policy**: a durable rule in `action_policies`.
- **Grant**: a user-facing label for an allow rule created from an approval prompt — durable (in `action_policies`) or runtime-scoped (in `runtime_grants`).
- **Approve once**: resolves only the current approval request and creates no row.

Backend code should not introduce any third grant/rule model.

### Relationship to `disabled_actions`

`disabled_actions` is **not** part of this framework and is intentionally left untouched. It operates at a different layer:

- **`disabled_actions` — capability availability.** An admin-managed (`/api/admin/disabled-actions`) org-level kill-switch keyed by service/action. A disabled service/action is *filtered out of the tool catalog before the agent ever sees it* (`session-tools.ts` skips disabled services during tool listing; the workflow `tool` node throws at preflight, `tool.ts`). The agent never knows the capability exists.
- **`action_policies` / `runtime_grants` — per-invocation decision.** The tool *is* offered; an attempt resolves to allow / require approval / deny and is audited as an invocation.

These are complementary, not duplicate. The duplicate this spec retires (`user_action_policy_overrides`) was a second copy of the *per-invocation decision*; `disabled_actions` is a distinct availability control. The approval resolver never sees disabled actions because catalog filtering removes them upstream — so no resolution-order interaction is needed.

A future effort could collapse the two (e.g. an admin `deny` policy gaining an optional "hide from catalog" flag, with `disabled_actions` migrating into it), but that must first reconcile hide-vs-deny semantics and is out of scope here.

## Data Model

### `action_policies` (durable)

The existing table already represents durable action-level policy. Extend it; do not replace it.

Existing columns (`service`, `actionId`, `riskLevel`, `mode`, `createdBy`, `createdAt`, `updatedAt`) remain. Add ownership, target, parameter matching, and audit metadata:

| Column | Notes |
| --- | --- |
| `orgId` | Owning organization. `DEFAULT 'default'`, matching every peer table (`personas`, `skills`, `plugins`, …). Existing rows backfill to `'default'`. |
| `managedBy` | `admin`, `user`, or `system`. Admin rows can deny or require approval. User rows can only quiet approvals where admin policy permits. |
| `principalType` | `org` or `user`. Durable principals only — session/execution scopes live in `runtime_grants`; `team` is deferred. |
| `principalId` | Org id or user id. |
| `subjectType` | `tool_action`, `workflow_node`, `workflow_node_action`, or `session_tool`. |
| `workflowId` | Optional workflow id for workflow-node policies. |
| `workflowVersionId` | Required for durable workflow-node policies (a republish changes node shape; a durable row pinned to a version cannot silently apply to a different shape). |
| `nodeId` | Optional workflow node id. |
| `paramMatchers` | JSON array of parameter matchers. Defaults to `[]`. |
| `matcherSummary` | Cached human-readable summary for audit and UI. |
| `subjectLabel` | Optional derived display string (e.g. `tool:google_workspace.sheets.append_rows`). **Display only — never a match key.** Matching uses the typed columns below, not this string. |
| `userGrantBehavior` | `allowed` or `blocked`. Applies to admin `require_approval` rows. `allowed` lets user/runtime allow grants quiet matching approvals; `blocked` forces a prompt until admin policy changes. Defaults to `allowed`. |
| `origin` | `settings`, `approval_prompt`, `workflow_editor`, `admin`, `migration`. |
| `sourceApprovalId` | Approval request that produced this policy, if any. |
| `lastMatchedAt` | Timestamp for audit and cleanup UI. |
| `expiresAt` | Set for timed durable user grants; null means persistent. (No separate `lifetime` enum — `expiresAt` distinguishes persistent from timed.) |
| `revokedAt` | Soft delete timestamp. |

`mode` remains the policy decision:

- `allow`: allow or auto-approve matching work
- `require_approval`: require explicit approval
- `deny`: block matching work

User-managed rows in `action_policies` can be `allow` only. Admin-managed rows can be `allow`, `require_approval`, or `deny`.

### `runtime_grants` (ephemeral)

A new table for context-scoped allow grants. Every row is `mode = allow` implicitly; the table exists only to quiet approvals within a live context.

| Column | Notes |
| --- | --- |
| `id` | Primary key. |
| `orgId` | `DEFAULT 'default'`. |
| `userId` | Creator. FK to `users`, `ON DELETE CASCADE`. |
| `sessionId` | Nullable FK to `sessions`, `ON DELETE CASCADE`. |
| `workflowExecutionId` | Nullable FK to `workflow_executions`, `ON DELETE CASCADE`. |
| `subjectType` | Same enum as `action_policies`. |
| `service`, `actionId`, `riskLevel` | Target fields, nullable per `subjectType`. |
| `workflowId`, `nodeId` | For workflow-scoped grants. Runtime grants omit `workflowVersionId` — they expire with the execution and never outlive a republish. |
| `paramMatchers` | JSON array, defaults to `[]`. Usually empty for `foreach` ("approve remaining rows" ignores per-row params). |
| `policyKey` | Deterministic idempotency key derived from scope id, subject, node id, and matcher fingerprint. Makes equivalent later approvals reuse the same grant. |
| `matcherSummary` | Display string. |
| `createdAt` | Timestamp. |
| `revokedAt` | Soft delete. |

Exactly one of `sessionId` / `workflowExecutionId` is set, mirroring how `action_invocations` carries both. The FK cascades handle row deletion; explicit cleanup on **terminal-state transition** (not deletion) removes grants when a session or execution completes — reusing the existing `deleteSessionActionPolicyOverrides`-style lifecycle hook, generalized to workflow executions.

Because the resolver only loads runtime grants for the **current** context id (the session/execution you are already running inside), the rows it sees are active by construction — no liveness-join against unrelated contexts. A defensive terminal check remains cheap belt-and-suspenders.

### Policy Targets

Both tables must support tool actions and non-tool approval subjects without ambiguous nullable fields. Resolver candidate loading must include `subjectType` in every lookup so broad `NULL` service/action values cannot accidentally match unrelated work.

| `subjectType` | Required target fields | Nullable target fields | Notes |
| --- | --- | --- | --- |
| `tool_action` | `service`, `actionId` | `workflowId`, `workflowVersionId`, `nodeId` | Normal integration action approval, including session-side remote tools. |
| `workflow_node_action` | `service`, `actionId`, `workflowId`, `nodeId` | `workflowVersionId` for runtime grants only | Workflow `tool` node approval. Durable rows require `workflowVersionId`. |
| `workflow_node` | `workflowId`, `nodeId` | `workflowVersionId` for runtime grants only | Generic workflow `approval` node with an approval contract. Durable rows require `workflowVersionId`. `service`, `actionId`, `riskLevel` must be null — a generic approval node has no integration target or risk level. |
| `session_tool` | `subject` (native tool name, e.g. `bash`) | `service`, `actionId`, `riskLevel`, `workflowId`, `workflowVersionId`, `nodeId` | Built-in/native sandbox tool gating where no integration action id exists — e.g. restrict `bash` to commands matching a regex matcher. Match on the native tool name. Storage lands in Phase 1; the interdictor that routes native calls through the resolver ships in Phase 2 (see "Native Tool Gating"). |

Rows with `subjectType = workflow_node` must not match tool-action queries.

#### Native Tool Gating (`session_tool`)

`session_tool` is the storage shape for restricting built-in tools (`bash`, file edits, etc.), a capability the platform wants but does not yet have. **Today nothing routes native tool calls through the resolver** — only integration/MCP actions (those with `service` + `actionId` + `riskLevel`) reach `invokeAction`. Enabling `session_tool` policies requires an **interdictor**: an interception hook in the session tool path that catches built-in tool calls and resolves them against `action_policies` before execution.

The interdictor ships in **Phase 2**, alongside the matcher engine it depends on. The Phase 2 `matches` (regex) matcher is what makes built-in restriction useful — e.g. a `session_tool` policy on `bash` with `{ path: "command", op: "matches", value: "rm -rf /|curl .*\\| ?sh" }` to deny destructive commands. The data model carries `session_tool` from Phase 1 so the interdictor lands in Phase 2 without a later migration.

### Uniqueness And Indexes

The migration must drop the existing partial unique indexes that only key on service/action/risk (`idx_ap_action`, `idx_ap_service`, `idx_ap_risk` per the migration SQL). The expanded table needs multiple rows for the same action — e.g. one admin policy plus one user durable grant for the same Google Sheets action.

`action_policies` uniqueness:

- Admin/base rows unique by `orgId`, `managedBy`, `principalType`, `principalId`, `subjectType`, target fields, and `paramMatchers` fingerprint.
- User durable rows unique by `orgId`, `managedBy`, `principalType`, `principalId`, `subjectType`, target fields, and `paramMatchers` fingerprint.

`runtime_grants` uniqueness:

- Unique by scope id (`sessionId`/`workflowExecutionId`), `subjectType`, target fields, and `policyKey`. `policyKey` must be deterministic and safe to reuse on retry — derived from scope id, subject, node id, and matcher fingerprint, not the approval id.

`action_policies` lookup indexes:

- `orgId`, `subjectType`, `service`, `actionId`, `riskLevel`, `revokedAt`
- `orgId`, `managedBy`, `principalType`, `principalId`, `revokedAt`
- `expiresAt` for timed-policy cleanup
- `workflowId`, `workflowVersionId`, `nodeId` for workflow readiness and audit UI

`runtime_grants` lookup indexes:

- `sessionId`, `revokedAt`
- `workflowExecutionId`, `revokedAt`

### `action_invocations` changes

Audit rows must carry the matched policy and/or grant for the new model. Add two nullable columns:

- `matchedPolicyId` — FK to `action_policies(id)`, `ON DELETE SET NULL`.
- `matchedGrantId` — FK to `runtime_grants(id)`, `ON DELETE SET NULL`.

`ON DELETE SET NULL` matters: revoking a policy or hard-deleting a runtime grant on terminal transition must not lose the audit row.

Existing columns — `policyId`, `orgPolicyId`, `userOverrideId`, `baseMode`, `baseSource`, `policySource`, `policyLifetime`, `policyScope` — stay in the schema for historical reads but stop being populated by new invocations. For one release, new rows alias `policyId` / `orgPolicyId` to `matchedPolicyId` so existing audit queries keep working; remove the alias and `userOverrideId` writes in a follow-up.

### Retire `user_action_policy_overrides`

`user_action_policy_overrides` is the existing duplicate policy layer. Treat it as legacy compatibility:

1. Stop creating new rows in `user_action_policy_overrides`.
2. Migrate existing rows:
   - `lifetime = persistent` → `action_policies` user durable grant (`principalType = user`).
   - `lifetime = timed` → `action_policies` user durable grant with `expiresAt`.
   - `lifetime = session` → `runtime_grants` with `sessionId` set.
3. Update runtime resolution to read `action_policies` + `runtime_grants`.
4. Remove or alias `/api/action-policy-overrides` after the settings UI is converted.
5. Replace `action_invocations.userOverrideId` with `matchedPolicyId` / `matchedGrantId` semantics. Existing audit rows keep old columns for history.

### Parameter Matchers

> **Phase 2.** The matcher engine and per-action canonicalization are not required for the runtime-grant approval-fatigue win (Phase 1 matches on subject/node, not per-row params). They land in Phase 2 for durable user policies. See Phased Delivery.

Parameter matchers are evaluated against resolved runtime params after action-specific canonicalization.

```ts
type ParamMatcher =
  | { path: string; op: "equals"; value: unknown }
  | { path: string; op: "oneOf"; values: unknown[] }
  | { path: string; op: "startsWith"; value: string }
  | { path: string; op: "contains"; value: string }
  | { path: string; op: "matches"; value: string };
```

Rules:

- All matchers must pass.
- Missing paths fail closed.
- Equality is type-strict after canonicalization.
- Dot paths work for normal keys; escaped or bracket paths are required for keys containing dots, brackets, or quotes.
- Regex and substring matching apply only to strings.
- Secrets and redacted values cannot be used as durable matchers.
- Durable user-managed write policies require at least one matcher unless the action is read-only and explicitly marked safe.
- The UI should prefer `equals`, `oneOf`, and `startsWith`; regex is advanced.

Canonicalization belongs to the integration action definition. Examples:

- Google Sheets `spreadsheetId` is trimmed.
- Google Sheets `range` is normalized to the notation sent to Google.
- GitHub owner/repo names are lowercased.
- URLs can expose derived matcher fields such as `url.host` and `url.origin`.

Example durable user policy (`action_policies`):

```json
{
  "managedBy": "user",
  "principalType": "user",
  "principalId": "user_123",
  "subjectType": "tool_action",
  "service": "google_workspace",
  "actionId": "sheets.append_rows",
  "mode": "allow",
  "paramMatchers": [
    { "path": "spreadsheetId", "op": "equals", "value": "1NTVgJuy..." },
    { "path": "range", "op": "startsWith", "value": "Companies!" }
  ]
}
```

Example runtime grant for remaining `foreach` rows (`runtime_grants`):

```json
{
  "workflowExecutionId": "exec_123",
  "subjectType": "workflow_node_action",
  "service": "google_workspace",
  "actionId": "sheets.append_rows",
  "workflowId": "wf_123",
  "nodeId": "node_write_companies",
  "policyKey": "exec_123:node_write_companies:google_workspace.sheets.append_rows:sha256([])",
  "paramMatchers": []
}
```

The `foreach` grant carries no param matchers: "approve remaining rows" deliberately matches the node subject regardless of per-row params.

## Policy Resolution

One resolver replaces the current split between `resolveOrgPolicyMatch` and `resolveUserActionPolicyOverride`.

Input:

- `orgId`
- `userId`
- optional `sessionId` (the resolver expands this to its lineage: self + `parentSessionId` ancestor chain, capped at a depth of 16 with a visited-set cycle guard)
- optional `workflowExecutionId` — recovered per lineage member, not only for the originating session. For **each** session in the expanded lineage, look up `workflow_spawned_sessions` and add any recovered `executionId` to the candidate executions set. A runtime grant matches if its `sessionId` is in the lineage **or** its `workflowExecutionId` is in the candidate executions set. This handles the case where a workflow-spawned session further spawns a child via `spawn_session`: the child's lineage is `[child, workflow_session]`, and the execution is recovered from `workflow_session`'s row.
- service, action id, risk level, subjectType, target fields
- resolved runtime params

Resolution order:

1. Load candidate `action_policies` rows for the same org and matching subjectType/target.
2. Evaluate admin `deny` first. Any matching deny → deny immediately.
3. Determine the base admin/system decision from admin `allow` / `require_approval` rows by specificity, then system risk defaults if none match.
4. Base decision `allow` → allow immediately. No grant lookup needed.
5. Base decision `require_approval` with `userGrantBehavior = blocked` → require approval immediately.
6. Base decision `require_approval` with `userGrantBehavior = allowed` → check grants in order:
   1. `runtime_grants` over the session lineage and workflow execution, most specific first: own session, then ancestor sessions up the `parentSessionId` chain, then workflow execution.
   2. durable user `allow` policies in `action_policies`.
7. If a grant matches → allow (auto-approved). Otherwise require approval.

Deny always wins. Allow grants quiet only grantable `require_approval` decisions; they never turn admin `deny` into `allow`, and they are not consulted when admin/system policy already allows.

Specificity ranking within a group:

1. exact action + parameter match
2. exact action without parameter match
3. service + parameter match
4. service without parameter match
5. risk level
6. system default

Runtime grants beat durable user policies (more contextual). Admin deny beats both.

Because runtime grants are loaded only for the current context id, the resolver never sees grants from terminal contexts — they were deleted on terminal transition (and cascade on deletion). A defensive terminal-state check is still cheap to keep.

## Subject Model

Subjects are a **derived display/audit label**, not a match key. Matching is on typed columns (`subjectType`, `service`, `actionId`, `workflowId`, `workflowVersionId`, `nodeId`) plus `paramMatchers`. Storing the same identifiers twice (typed columns *and* an encoded string used for matching) invites drift; the typed columns are canonical.

| Display subject | Meaning |
| --- | --- |
| `tool:<service>.<action>` | Tool/action approval |
| `workflowNode:<workflowId>:<versionId>:<nodeId>` | Durable workflow approval node |
| `workflowNodeAction:<workflowId>:<versionId>:<nodeId>:<service>.<action>` | Durable workflow tool node + action |
| `sessionTool:<toolName>` | Native/session-side tool approval |

Runtime grants render the same labels minus `versionId` (they pin to an execution, not a version). Durable workflow-node policies must carry `workflowVersionId` in their typed columns.

For reusable cross-session/cross-workflow policy, prefer `tool_action` + parameter matchers over workflow-node subjects.

## Workflow Approval Contracts

Generic workflow `approval` nodes are not automatically eligible for durable user-managed policy. A generic approval can represent human judgment (incident escalation) and should not become a reusable action policy by accident.

Durable policies for workflow `approval` nodes are allowed only when the node declares an approval contract:

```ts
type WorkflowApprovalContract = {
  subject: string;
  params: Record<string, unknown>;
  matcherHints?: Array<{ path: string; stable: boolean; label?: string }>;
};
```

Without a contract, the UI offers `Approve once` and runtime-scoped approvals only. With a contract, the durable policy dialog uses the contract params and matcher hints the same way it handles tool params.

## Runtime Behavior

### Sessions

Session approvals resolve against the unified resolver before prompting:

- `Approve once`: resolve only the current invocation; create no row.
- `Approve for this session`: create a `runtime_grants` row with `sessionId` set.
- `Approve matching requests`: create a user durable `allow` policy in `action_policies` with parameter matchers (Phase 2).

The orchestrator is a session, so orchestrator tool approvals use this same path with the well-known orchestrator session id (`orchestrator:{userId}` / `orchestrator:org:{orgId}`). "Approve for this session" on the orchestrator is the durable-feeling grant for orchestrator actions, since that session is long-lived.

### Workflow Executions

- `Approve once`: resolve only the current approval.
- `Approve for this run`: create a `runtime_grants` row with `workflowExecutionId` set.
- `Approve matching requests`: create a durable user policy when eligible (Phase 2). Team/environment scopes are out of scope.

A workflow-created session's tool calls match the execution's runtime grants by recovering the execution from `workflow_spawned_sessions` — see "Session Provenance, Grant Scope, And Approval Propagation" for the linkage and the approval surfacing that comes with it.

### Foreach

`foreach` approval UX must not depend on multiple approvals being pending.

When an approval appears inside a `foreach` body:

- `Approve once` resolves the current iteration.
- `Approve remaining rows` creates a workflow-execution-scoped `runtime_grants` row for the body node subject (no per-row matchers), resolves the current approval, and resolves any already-pending sibling approvals in the same execution.
- Future iterations check the resolver immediately before creating an approval prompt, so `concurrency = 1` prompts once and then auto-approves matching future rows.

The backend operation must be transactional and idempotent:

1. Validate the current approval is pending and belongs to the caller.
2. Create or reuse an equivalent execution-scoped `runtime_grants` row using a deterministic `policyKey` derived from execution id, subject, body node id, and matcher fingerprint.
3. Resolve the current approval.
4. Resolve matching already-pending sibling approvals in the same execution.
5. Commit before allowing future iterations to prompt.

The client idempotency key can include `approvalId + scope` to make button retries safe, but persisted grant uniqueness must use the stable `policyKey`. Otherwise retrying one approval is safe while future equivalent loop approvals cannot reliably reuse the same runtime grant.

### Session Provenance, Grant Scope, And Approval Propagation

A session can be spawned several ways, and approval behavior must follow its provenance — not assume "workflow" is the only origin:

| Origin | Link to context (today) |
| --- | --- |
| Interactive (root) | none, or `parentSessionId` if opened as a child |
| Child of another session (orchestrator sub-agent, agent `spawn_session` tool) | `parentSessionId` (set by `spawnChild`) |
| Workflow `session` node | `workflow_spawned_sessions(executionId, nodeId, sessionId)` — has **no** `parentSessionId`, and currently lacks `workflowId`/`workflowVersionId` |
| Orchestrator | well-known id (`orchestrator:{userId}` / `orchestrator:org:{orgId}`), `isOrchestrator` |

There are two distinct linkage mechanisms — `parentSessionId` (session→session) and `workflow_spawned_sessions` (execution→session) — and they don't overlap. Resolution and surfacing both walk this provenance, in opposite directions.

**Grants flow down the lineage.** A session-scoped runtime grant matches the session it was created on **and any session spawned beneath it**. Resolution expands the current `sessionId` to its lineage — self plus the `parentSessionId` ancestor chain — and matches `runtime_grants` whose `sessionId` is any member:

```
resolve(session S):
  runtime grants WHERE session_id IN (S, S.parent, S.parent.parent, …)
  + workflow-execution grants (if S is workflow-spawned; via workflow_spawned_sessions)
  + durable user policies
```

This is what makes "Approve for this session" on the orchestrator (or any parent) cover the headless children it spawns — without inheritance, a background child hits the same gate with no human to answer it and stalls, which is the exact failure this spec exists to prevent. `Approve for this session` therefore means "this session and the subtree it spawns"; revoking it removes the grant for the whole subtree.

**Approval requests surface up the lineage.** Symmetrically, an approval raised in a child session must become visible — and resolvable — at every ancestor context, so the user does not have to watch child sessions. There is **one approval record** (the `action_invocation` / `workflow_approval` row); it is surfaced, not duplicated, at:

1. the originating session (unchanged),
2. each ancestor session — notably the **orchestrator**, as an approval card in its thread,
3. the **workflow execution** view, if the session is workflow-spawned,
4. the **global pending-approvals queue**.

Any surface can resolve the single record; resolution is idempotent (same approval id), so approving from the orchestrator thread, the execution canvas, or the child session all resolve the same gate exactly once. Surfaces update live via the event bus. Proactive per-channel push (DM the user on the orchestrator's channel, ping the workflow owner) reuses existing interactive-prompt infrastructure where present and is polished in Phase 2.

**Required linkage work (Phase 1).** Extend `workflow_spawned_sessions` with `workflowId` and `workflowVersionId` (it has neither today) so workflow-spawned sessions can match execution-scoped grants and workflow-node subjects, joined while the row is live (it exists for the session's lifetime, deleted on termination). Provenance fan-out for approval surfacing reuses the same `parentSessionId` chain and spawned-session link.

**Grant scope vs creator (multi-user sessions).** A session can have multiple `session_participants`. Runtime grants are **session-scoped, not creator-scoped**: the match key is `sessionId`, and the grant's `userId` column is creator/audit only — it is not part of matching. Any participant's agent actions in that session benefit equally from a grant created by any other participant. Permission to **create or revoke** a session-scoped grant follows session access — `editor`+ on the session (the same check used by `spawnChild` and other session-write APIs). Viewers see active grants in the session UI but cannot modify them. The same rule applies to workflow-execution-scoped grants against workflow execution access.

### Resolution Authorization

Surfacing is broad; resolution authority is checked against the **origin**, not the surface. A propagated approval that appears in the orchestrator thread, an ancestor session, or the workflow execution view is still resolved against the originating session's or execution's access control:

- A session approval resolves on `editor`+ access to the originating session.
- A workflow approval resolves on `editor`+ access to the workflow execution.
- A user with read access to an ancestor surface but no edit access to the origin sees the approval card with disabled action buttons and a deep link back to the origin where they (or another user) can act.

This prevents privilege escalation through surfacing — being able to see a shared orchestrator thread does not grant the ability to approve actions in someone else's child session.

### Denial Propagation

Symmetric to pending-approval propagation. When an `action_invocation` transitions to `denied` (or a workflow approval to `denied`/`expired`) in a descendant context, publish a denial event to each ancestor context's stream over the same provenance fan-out. UI surfaces show a read-only "Tool blocked by policy" trace entry in the parent session, the orchestrator thread, and the workflow execution view, linking back to the origin.

The durable audit record stays in the originating session — ancestors only display the signal. No new permission model is needed because denials are read-only signals, not actions. Without this, a headless or background child session that hits an admin `deny` fails invisibly to the user, which is the same babysit-the-child failure mode the propagation work exists to eliminate.

## Phased Delivery

The hardest, least-grounded part of this design — per-action canonicalization and "which params are stable identifiers" metadata — blocks *durable* param policies but is **not** needed for the approval-fatigue win. Sequence accordingly.

### Phase 1 — Runtime grants + unified resolver (ships the win)

- `runtime_grants` table; ownership/target columns on `action_policies` (no matcher engine yet).
- Migrate `user_action_policy_overrides` (persistent/timed → durable `action_policies`; session → `runtime_grants`).
- Unified resolver: deny → admin base → runtime grants (session lineage + execution) → durable user grants → require approval.
- Session provenance: extend `workflow_spawned_sessions` with `workflowId`/`workflowVersionId`; lineage-aware grant resolution (self + `parentSessionId` chain).
- Scoped approval endpoints: `once`, `session`, `workflow_execution`, `remaining_foreach`.
- Foreach: execution-scoped grant by `policyKey`, resolve current + pending siblings.
- Route workflow approvals through the resolver.
- Approval propagation: surface a child session's single approval record at ancestor sessions, the orchestrator thread, the workflow execution view, and the global queue; resolvable from any surface (idempotent); live via the event bus.
- Client: session + execution approval cards with `once` / `session` / `run` / `remaining`.

Phase 1 is fully testable end-to-end and delivers prompt-once `foreach(concurrency: 1)` plus child-session approvals that surface to the parent — without any per-action matcher metadata.

### Phase 2 — Durable parameter policies

- Param matcher engine (`equals`/`oneOf`/`startsWith`/`contains`/`matches`), fail-closed, type-strict.
- Per-action canonicalization + matcher-hint metadata, starting with Google Workspace and GitHub.
- `durable_policy` approval scope + confirmation dialog with stable-identifier preselection.
- Native-tool interdictor: intercept built-in session tool calls (`bash`, file edits, etc.), resolve them against `session_tool` policies before execution, with regex matchers on tool args (e.g. `bash` `command`).
- Workflow editor readiness pass and "pre-approve matching requests."
- Proactive per-channel approval push: DM the user on the orchestrator's channel and ping workflow owners when a propagated approval is pending, honoring notification preferences.
- Settings UI convergence onto action policies.

## UI Design

### Approval Prompt Actions

| Context | Primary choices |
| --- | --- |
| Plain session | `Approve once`, `Approve for this session`, `Approve matching requests`*, `Deny` |
| Workflow execution | `Approve once`, `Approve for this run`, `Approve matching requests`*, `Deny` |
| Foreach body | `Approve once`, `Approve remaining rows`, `Approve matching requests`*, `Deny` |

\* `Approve matching requests` (durable) is Phase 2; it opens a confirmation dialog before creating a durable user-managed action policy.

### Session Chat Approval Card

Shows `Approve once`, `Approve for this session`, `Approve matching requests` (Phase 2), `Deny`. If an action is auto-approved by policy, the trace shows the matched policy/grant label instead of approval choices.

### Workflow Execution Canvas

Workflow execution mode exposes approval controls on selected approval-capable nodes: `approval` nodes, `tool` nodes blocked by policy, `foreach` body nodes with approval-capable work, and `session` nodes whose spawned session is waiting. An `orchestrator` node dispatches to the persistent orchestrator session; approvals raised there surface against that session (and in the global queue), not the workflow node — the node may link to them but does not own the approval. For a `foreach` body approval, the selected-node pane shows `Approve remaining rows` and explains that future matching iterations in this run will auto-approve.

### Workflow Editor Readiness (Phase 2)

Before `Publish`, `Test`, or enabling a trigger, run an approval readiness pass classifying approval-capable nodes as **Covered**, **Intentional human gate**, **Will prompt at runtime**, **Blocked**, or **Unknown** (params depend on trigger data or upstream outputs not resolvable yet). Badge approval-capable nodes. Readiness setup actions: `Pre-approve matching requests`, `Approve matching iterations in each run`, `Keep human approval`, `Run test with sample data`. Durable policies must be created only from concrete trigger defaults, manual test payloads, action matcher hints, resolved static params, or workflow approval contracts.

### Durable Policy Confirmation Dialog (Phase 2)

Starts from a concrete approval request and shows resolved params.

```text
Always approve:
google_workspace.sheets.append_rows

Only when:
[x] spreadsheetId equals 1NTVgJuy...
[x] range starts with Companies!
[ ] values any
```

Defaults: preselect stable identifiers (`spreadsheetId`, `documentId`, `owner`, `repo`, `url.host`); leave payload fields (row values, message bodies, generated text) unselected; block saving when no matcher is selected unless the action is read-only and explicitly safe.

### Settings And Admin Policy UI

- User settings show user durable policies and active runtime grants.
- Admin settings show admin allow / require-approval / deny policies.
- The old "Action Policy Overrides" UI is renamed/replaced, not left as a separate concept.

Users can list active policies/grants; inspect subject, scope, matcher summary, origin, creator, last matched; revoke; optionally edit label and expiry. Admins see that admin deny overrides user allow, and that user grants can quiet approvals only where admin policy permits.

### Global Pending Approvals Queue

A cross-context surface listing pending session approvals, workflow approval nodes, workflow tool-policy approvals, workflow-created-session approvals, and `foreach` body approvals. Each row deep-links to its origin and exposes the same context-aware actions.

Because approvals propagate up the provenance chain (see "Session Provenance, Grant Scope, And Approval Propagation"), the same approval also appears at each ancestor context — an approval raised in a workflow-spawned or orchestrator-spawned child shows up in the orchestrator thread and the workflow execution view, and in the parent session, not only in the child. All surfaces act on the one underlying record: resolving from any surface resolves it once and clears it from the others live via the event bus.

### Slack And Telegram Approval Messages

Support `Approve once`, `Approve for this session`/`Approve for this run`, and `Deny`. `Approve matching requests` deep-links to the web confirmation dialog until channel UI can display matcher details — durable policy creation must not happen from a chat button that cannot show the full policy. Channel actions require signed, single-use tokens with short expiry binding approval id, user id, channel identity, decision, scope, and idempotency key.

### Audit Display

Auto-approved actions show why they did not prompt:

```text
Auto-approved by action policy
google_workspace.sheets.append_rows
spreadsheetId equals 1NTVgJuy...
created by Conner on Jun 25, 2026
```

Workflow execution traces and action invocation rows include matched policy/grant id, matched subject, matched param summary, created-by, and runtime scope if any.

## API Design

### Approval Resolution

Approve endpoints accept a scope:

```json
{
  "decision": "approved",
  "scope": "once" | "session" | "workflow_execution" | "remaining_foreach" | "durable_policy",
  "paramMatchers": [],
  "idempotencyKey": "optional-client-generated-key"
}
```

A bare approve request is `scope = once`. `scope = durable_policy` (Phase 2) requires explicit `paramMatchers`. The endpoint derives subject, resolved params, requester context, org, and durable-policy eligibility from the stored approval request. Clients choose scope and matcher paths/ops/values but must not provide requester context.

### Policy Management

```text
GET    /api/action-policies
POST   /api/action-policies
PATCH  /api/action-policies/:id
DELETE /api/action-policies/:id
```

`/api/action-policy-overrides` becomes a compatibility alias during migration or is removed before release.

Permissions:

- Admins create/edit/revoke/list admin-managed policies for their org.
- Non-admin users create only `managedBy = user`, `mode = allow` rows for themselves through approval-derived or matcher-validated settings flows.
- Non-admin users list their own durable policies and active runtime grants tied to sessions/executions they can access.
- Non-admin users revoke their own user-managed rows but cannot edit `managedBy`, `mode`, `principalType`, `principalId`, `orgId`, or target fields after creation.
- Clients never provide requester context, org, subject, service/action, or resolved params for approval-derived creation. The server derives those from the stored approval request.

## Safety Rules

- Admin-managed deny policies always win.
- User-managed policies and runtime grants may only create `allow` decisions.
- Matching uses resolved runtime params only.
- Missing parameter paths fail closed.
- Durable write policies require at least one matcher unless the action is read-only and explicitly safe.
- Regex matchers are advanced and displayed verbatim before saving.
- Durable workflow-node policies require workflow version id; runtime grants omit it.
- Generic workflow approval nodes cannot create durable policies without an approval contract.
- Approval actions are idempotent and safe to retry; persisted grant uniqueness uses `policyKey`.
- An approval is a single record surfaced at multiple contexts; resolving from any surface resolves it exactly once and clears the others.
- Resolution authorization is checked against the **origin** of the approval, not the surface it was acted on from. Surfacing carries no implicit permission to act.
- Session-scoped grants inherit down the spawned-session subtree; revoking one removes it for the whole subtree.
- Runtime grants are session-scoped, not creator-scoped: any session participant benefits, and create/revoke requires `editor`+ access to the session, not ownership of the grant.
- Denials propagate up the provenance chain as read-only display signals; ancestors see the failure without inheriting permission to retry.
- Slack/Telegram approval actions require signed, expiring, single-use action tokens.

## Migration Path

The previous draft of this section sequenced schema changes, backfill, and code switchovers as separate phases, leaving a window where new `user_action_policy_overrides` rows would be written after migration but before the resolver switched — silently dropped. Collapse the rollout into three atomic steps instead:

**1. One D1 migration (atomic per file).** In a single migration:
   - Extend `action_policies` with ownership/target/audit/matcher columns; default `orgId` to `'default'`, default `paramMatchers` to `'[]'`, default `userGrantBehavior` to `'allowed'`.
   - Create `runtime_grants` with FK cascades to `users`, `sessions`, `workflow_executions`.
   - Extend `workflow_spawned_sessions` with `workflow_id` and `workflow_version_id`.
   - Extend `action_invocations` with `matched_policy_id` and `matched_grant_id`.
   - Drop the existing partial unique indexes that only key on service/action/risk (`idx_ap_action`, `idx_ap_service`, `idx_ap_risk`).
   - Backfill existing `action_policies` rows as admin/org policies (`managedBy = 'admin'`, `principalType = 'org'`, `principalId = orgId`, `subjectType = 'tool_action'` when service/action present).
   - Migrate `user_action_policy_overrides` rows: persistent/timed → durable `action_policies` user grants; session → `runtime_grants`.
   - Add scope-aware unique and lookup indexes on both tables.

At the end of this migration, the new tables hold every row that ever lived in the old model. The old table still exists but is now stale and unread.

**2. One Worker deploy (atomic per instance).** In a single deploy:
   - Switch reads + writes for action policy resolution to the unified resolver over `action_policies` + `runtime_grants`.
   - Stop writing `user_action_policy_overrides` entirely.
   - Route workflow approvals, workflow tool nodes, workflow-created sessions, and `foreach` through the unified resolver.
   - Update settings and approval UIs to read/write the new model; convert `/api/action-policy-overrides` to a compatibility alias.

**3. Cleanup deploy (later, optional).** Drop the `/api/action-policy-overrides` alias, the `userActionPolicyOverrides` schema, and the unused legacy columns on `action_invocations` (`userOverrideId`, `policyLifetime`, etc.) once nothing references them.

The only write-race window is between step 1 finishing and step 2 deploying — seconds in practice for sequenced migration-then-deploy. For this pre-release feature on workflows, any grants written in that window are session-scoped ephemerals at worst; users would re-approve once. Acceptable. If a production environment ever needs zero-loss cutover, insert a dual-write deploy between steps 1 and 2 that writes both old and new during the window, then collapse afterward.

## Testing Strategy

Worker tests:

- Existing admin action policies resolve exactly as before after backfill.
- Admin and user/runtime policies for the same service/action coexist (old uniqueness no longer blocks).
- Admin deny overrides every user-managed allow and runtime grant.
- Admin `require_approval` + `userGrantBehavior = blocked` ignores user/runtime allow grants.
- Admin `require_approval` + `userGrantBehavior = allowed` is quieted by a matching runtime grant or durable user policy.
- Admin/system `allow` returns allow without consulting grants.
- Session-scoped runtime grant auto-approves matching session tool calls and stops after the session is terminal.
- Workflow-execution-scoped runtime grant auto-approves future `foreach` iterations at `concurrency = 1` and stops after the execution is terminal.
- Execution-scoped grant resolves already-pending sibling approvals at `concurrency > 1`.
- `remaining_foreach` uses a stable `policyKey` so equivalent later approvals reuse the same runtime grant; distinct matcher fingerprints create distinct grants.
- Durable user policy matches across manual sessions and workflow tool nodes (Phase 2).
- Parameter matcher rejects missing paths, type mismatches, and redacted/secret fields; regex validates on save and fails closed at runtime (Phase 2).
- Durable workflow-node policy rejected without workflow version id; durable workflow approval policy rejected without an approval contract.
- Cross-org policies do not match.
- Non-admin users cannot create admin-managed, deny, or require-approval policies.
- Duplicate approval requests are idempotent and do not create duplicate grants.
- Migrated `user_action_policy_overrides` rows produce equivalent resolution decisions.
- A session-scoped grant on a parent session auto-approves a matching call in a child session spawned beneath it (lineage inheritance).
- A grant does not match a sibling session outside the lineage.
- A workflow-spawned session recovers its execution scope via `workflow_spawned_sessions` and matches an execution-scoped grant.
- A child spawned by a workflow-spawned session recovers the execution via lineage walk (per-member join), not only via the originating session.
- Lineage walk caps at depth 16 and survives a `parentSessionId` cycle without looping.
- Resolving a propagated approval from an ancestor context resolves the single record once; the child's pending state clears and a second resolve is a no-op.
- A grant created by user A on a session co-occupied by users A and B auto-approves a matching call regardless of which participant's interaction triggered it; revoke by either editor participant works.
- A user with read-only access to an ancestor surface cannot resolve a propagated approval whose origin they lack `editor`+ access to (403 / disabled UI).
- A `denied` invocation in a descendant session emits a denial event to ancestor contexts; the durable audit row lives only on the origin.

Client tests:

- Approval card renders correct scope actions for session, workflow execution, and `foreach`.
- Workflow execution canvas and details page render the same approval actions for a pending approval.
- A child session's pending approval surfaces in the parent session, the orchestrator thread, and the workflow execution view, and resolving from one clears the others live.
- `Approve remaining rows` calls the approval endpoint with the correct scope.
- Auto-approved traces display matched policy/grant metadata.
- Settings can inspect and revoke user-managed policies and active runtime grants.
- (Phase 2) Workflow editor badges approval-capable nodes; durable policy dialog preselects stable identifiers and disables durable creation for contract-less approval nodes.

Integration tests:

- A workflow with `foreach(concurrency: 1)` and a gated Google Sheets write prompts once, then auto-approves remaining rows.
- A workflow-created session uses a workflow-execution-scoped runtime grant.
- An orchestrator-spawned headless child hits a gated action; the approval surfaces in the orchestrator thread and is resolved there without the user opening the child session.
- (Phase 2) A durable Google Sheets policy applies to both a manual session and a workflow tool node.

## Follow-Up Questions

1. **Per-action stable-identifier metadata.** Phase 2 durable policies need each integration action to declare which params are stable identifiers and how they canonicalize. Which actions get this first beyond Google Workspace and GitHub?
2. **Runtime grant audit retention.** Matching excludes terminal contexts, but how long should completed-context grants stay visible in audit UI before cleanup hard-deletes them?
