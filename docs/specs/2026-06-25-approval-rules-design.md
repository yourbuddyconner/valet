# Approval Rules and Parameter-Matched Overrides

## Goal

Valet needs one approval override system that works across sessions, workflow executions, workflow-created sessions, foreach loops, orchestrator runs, and direct tool calls.

The immediate workflow problem is noisy approvals inside `foreach`: when concurrency is `1`, only one approval is pending at a time, so a simple "approve all pending" action does not help. The user needs a way to approve the current request and automatically approve matching future requests in the same run.

The broader product goal is reusable approval policy: users should be able to permanently allow a specific action shape, such as "Google Sheets append rows only when `spreadsheetId` is this sheet and `range` starts with `Companies!`", regardless of whether the request comes from a manual session or a workflow.

## Non-Goals

- This does not replace organization-level deny rules. Admin deny must continue to win.
- This does not allow broad "always approve all Google Workspace writes" by default.
- This does not use raw templated workflow params for matching. Matching must use resolved runtime params.
- This does not require a rich rule editor in the first implementation. Persistent rules can be created from concrete approval prompts first.

## Concepts

### Approval Request

An approval request is a concrete runtime attempt to do something gated:

- A session tool call asking to run a risky action.
- A workflow `approval` node.
- A workflow `tool` node blocked by action policy.
- A tool call inside a workflow-created session.
- A tool call inside a `foreach` body node.

Every approval request should expose:

- requester context: session id, workflow execution id, workflow id, node id if any
- approval kind: `tool_policy`, `workflow_approval`, `session_tool`, etc.
- subject: stable thing being approved
- resolved runtime params
- prompt/summary/details for UI

### Approval Rule

An approval rule is the single persisted primitive for approval overrides. It can be short-lived or durable depending on its scope and expiry.

Examples:

- Approve matching requests for this session.
- Approve matching requests for this workflow execution.
- Approve matching requests for the remaining rows in a `foreach` loop.
- Always approve matching requests for this parameter shape across sessions and workflows.

Rules scoped to active runtime contexts expire automatically with that context. Rules scoped to `user`, `team`, or `environment` are persistent until revoked or expired.

### Product Labels

The backend should not have separate "grant" and "policy" concepts. The UI can still use those words for clarity:

- A **grant** is an approval rule with a runtime scope, such as `session` or `workflow_execution`.
- A **policy** is an approval rule with a durable scope, such as `user`, `team`, or `environment`.
- "Approve once" does not create a rule. It only resolves the current approval request.

## Data Model

### `approval_rules`

One table stores both runtime-scoped and durable approval rules.

| Column | Notes |
| --- | --- |
| `id` | UUID |
| `orgId` | Owning organization. Required for every rule. |
| `environment` | Environment the rule applies in, e.g. `dev` or `prod`. Required unless a rule is explicitly environment-global. |
| `ownerUserId` | User that owns the rule |
| `scope` | `session`, `workflow_execution`, `orchestrator_run`, `user`, `team`, `environment` |
| `scopeId` | Session id, workflow execution id, orchestrator run id, user id, team id, or environment id |
| `managedBy` | `user` or `admin`; admin-managed rules can only be changed by admins |
| `approvalKind` | `tool_policy`, `workflow_approval`, `session_tool` |
| `subject` | Stable target such as `tool:google_workspace.sheets.append_rows` or `workflowNode:write_companies` |
| `decision` | `approved` |
| `paramMatchers` | JSON array of parameter matchers |
| `label` | Optional user-facing name |
| `origin` | `approval_prompt`, `settings`, `admin` |
| `createdFromApprovalId` | Optional approval request that generated this rule |
| `createdBy` | User id |
| `lastMatchedAt` | Optional timestamp used for audit and cleanup UX |
| `expiresAt` | Optional |
| `revokedAt` | Nullable |
| `createdAt`, `updatedAt` | Audit timestamps |

Runtime scopes should have either an implicit lifecycle expiry or an explicit `expiresAt`. Durable scopes may omit `expiresAt`.

Every approval-rule lookup must include `orgId` and `environment`. User-scoped rules only apply to the same user in the same org/environment. Team- and environment-scoped rules require admin-managed ownership or an explicit team admin permission check. Rules must never cross organization boundaries.

### Parameter Matchers

Parameter matchers are evaluated against resolved runtime params.

```ts
type ParamMatcher =
  | { path: string; op: "equals"; value: unknown }
  | { path: string; op: "oneOf"; values: unknown[] }
  | { path: string; op: "startsWith"; value: string }
  | { path: string; op: "contains"; value: string }
  | { path: string; op: "matches"; value: string };
```

Rules:

- `path` uses dot path syntax into resolved params, e.g. `spreadsheetId`, `range`, `repo.owner`.
- All matchers must pass.
- Missing paths fail closed.
- Equality is type-strict after canonicalization. `"123"` does not equal `123` unless the action schema canonicalizes the field to a string.
- Dot-path escaping must be supported for keys containing dots, brackets, or quotes. The UI should generate paths and should not require users to hand-write escaped paths.
- Arrays and objects can be matched only with `equals` against canonical JSON values or with path-specific matchers against nested fields. Regex and substring matching apply only to strings.
- Secrets and redacted values cannot be used as durable matchers. If a value is unavailable for audit display, it is also unavailable for matching.
- Regex matching is path-specific and treated as advanced UI.
- Regex values should be validated when saved and rejected if they exceed length or complexity limits.
- The UI should prefer `equals`, `oneOf`, and `startsWith` before exposing regex.

Canonicalization is action-specific metadata owned by the integration action definition. Examples:

- Google Sheets spreadsheet ids are trimmed strings.
- Google Sheets ranges are normalized to the same sheet/range notation the action sends to Google.
- GitHub owner and repo names are lowercased.
- URLs can expose derived matcher fields such as `url.host` and `url.origin`; durable rules should prefer those over matching a full raw URL.

Example persistent rule:

```json
{
  "subject": "tool:google_workspace.sheets.append_rows",
  "scope": "user",
  "paramMatchers": [
    { "path": "spreadsheetId", "op": "equals", "value": "1NTVgJuy..." },
    { "path": "range", "op": "startsWith", "value": "Companies!" }
  ]
}
```

## Matching Order

The approval system checks for an override before prompting.

1. Gather all applicable action policy decisions for the concrete request.
2. If any organization/admin policy denies the request, deny immediately.
3. If any action-level policy denies the request, deny immediately.
4. Check active approval rules scoped to the exact session.
5. Check active approval rules scoped to the parent workflow execution, if present.
6. Check active approval rules scoped to the current orchestrator run, if present.
7. Check active durable approval rules scoped to user/team/environment.
8. If no rule matches, apply the non-deny action policy result: allow, require approval, or deny-by-default.

All deny decisions win before approval rules are considered. User rules may only make allowed or approval-required work quieter; they must not bypass explicit organization, team, environment, or action-level denies.

Workflow-level durability should be modeled as a durable `approval_rule` with parameter matchers, not as a separate long-lived workflow-specific override concept. Runtime scopes are for active work only; durable user/team/environment scopes are the cross-session/cross-workflow mechanism.

## Subject Model

Subjects must be stable enough to match the same permission shape across contexts.

Recommended subjects:

| Subject | Meaning |
| --- | --- |
| `tool:<service>.<action>` | Tool/action approval, e.g. `tool:google_workspace.sheets.append_rows` |
| `workflowNode:<workflowId>:<nodeId>` | A specific workflow node, runtime-scoped only |
| `workflowNodeAction:<workflowId>:<nodeId>:<service>.<action>` | A specific workflow tool node and action, runtime-scoped only |
| `sessionTool:<toolName>` | Native/session-side tool approval |

For cross-session/workflow reusable rules, prefer tool subjects with parameter matchers. For workflow-run runtime rules, workflow-node subjects are useful because users are often approving the behavior of one node in one graph.

Durable rules must not use mutable workflow-node subjects unless the subject includes the published workflow version or revision id. Runtime-scoped rules may use `workflowId + nodeId` because they expire with the active execution. Durable workflow-node rules should use one of these forms:

- `workflowNode:<workflowId>:<versionId>:<nodeId>`
- `workflowNodeAction:<workflowId>:<versionId>:<nodeId>:<service>.<action>`

If the workflow is edited and republished, old durable workflow-node rules do not automatically apply to the new version. Cross-version durability should use a `tool:<service>.<action>` subject with explicit parameter matchers instead.

### Workflow Approval Contracts

Workflow `approval` nodes are not automatically eligible for durable parameter-matched approval rules. A generic approval node can represent arbitrary human judgment, such as "approve this incident escalation," and should not become a reusable policy accidentally.

Durable rules for workflow `approval` nodes are allowed only when the node declares an approval contract:

```ts
type WorkflowApprovalContract = {
  subject: string;
  params: Record<string, unknown>;
  matcherHints?: Array<{ path: string; stable: boolean; label?: string }>;
};
```

Without a contract, the UI should offer `Approve once` and runtime-scoped approvals only. With a contract, the durable rule dialog can use the contract params and matcher hints in the same way it handles tool params.

## Runtime Behavior

### Sessions

Current session approval behavior should be implemented as session-scoped approval rules.

When a session approval appears:

- `Approve once` resolves only that request.
- `Approve for this session` creates `approval_rule(scope = session, scopeId = sessionId)`.
- `Approve matching requests` creates a durable approval rule, usually scoped to the user.

Future session tool calls check the approval-rule resolver before creating another prompt.

### Workflow Executions

Workflow execution approvals should use execution-scoped approval rules.

When a workflow approval appears:

- `Approve once` resolves only that approval row.
- `Approve for this run` creates `approval_rule(scope = workflow_execution, scopeId = executionId)`.
- `Approve matching requests` creates a durable approval rule, usually scoped to the user.

Future workflow nodes and workflow-created sessions check for execution-scoped rules using the parent execution id.

### Foreach

Foreach approval UX should not depend on multiple approvals being pending at once.

When an approval appears inside a `foreach` body:

- `Approve once` resolves the current iteration only.
- `Approve remaining rows` creates an execution-scoped approval rule for the same body approval shape and resolves the current approval.
- If other sibling approvals are already pending because `concurrency > 1`, the backend resolves those matching pending approvals immediately.
- Future iterations with `concurrency = 1` auto-approve as they reach the approval point.

The engine must keep per-iteration workflow event types. It should not make all iterations wait on the same event type.

The `Approve remaining rows` backend operation must be transactional and idempotent:

1. Validate the current approval request is still pending and belongs to the caller.
2. Create or reuse an equivalent execution-scoped rule using an idempotency key derived from `approvalId + scope`.
3. Resolve the current approval.
4. Resolve any already-pending matching sibling approvals in the same execution.
5. Commit before allowing new foreach iterations to create more approval requests.

Future iterations must check the resolver immediately before creating an approval prompt. This prevents duplicate prompts when concurrency is greater than `1` and prevents double-resolution when a user clicks twice.

### Workflow-Created Sessions

Sessions created by workflow `session` nodes should carry parent workflow context:

- `workflowExecutionId`
- `workflowId`
- `nodeId`

When a workflow-created session hits an approval:

1. Check session-scoped rules.
2. Check workflow-execution-scoped rules.
3. Check durable user/team/environment rules.
4. Prompt if nothing matches.

This lets the user approve a session action for only that spawned session or for the rest of the workflow run.

## UI Design

### Approval Prompt Actions

The UI should expose choices based on context:

| Context | Primary choices |
| --- | --- |
| Plain session | `Approve once`, `Approve for this session`, `Approve matching requests`, `Deny` |
| Workflow execution | `Approve once`, `Approve for this run`, `Approve matching requests`, `Deny` |
| Foreach body | `Approve once`, `Approve remaining rows`, `Approve matching requests`, `Deny` |

`Approve matching requests` should open a confirmation dialog before creating a durable approval rule.

### UI Surface Inventory

Approval rules should be surfaced anywhere a user is asked to make or understand an approval decision. Each surface should use the same backend approval-rule resolver and should show the same audit language when a rule auto-approves work.

#### Session Chat Approval Card

The session chat approval card is the primary UI for manual sessions and orchestrator sessions. It should show:

- `Approve once`
- `Approve for this session`
- `Approve matching requests`
- `Deny`

`Approve for this session` creates a session-scoped rule. `Approve matching requests` opens the durable rule dialog. If the action was auto-approved by a rule, the card or trace message should show the matched rule summary instead of rendering an approval choice.

#### Session Detail / Activity Timeline

Session activity history should show when an action was auto-approved. The entry should include:

- matched rule id or label
- subject
- matcher summary
- scope
- created-by user

This prevents silent automation from looking indistinguishable from normal tool execution.

#### Workflow Execution Canvas

Workflow execution mode should show approval-rule controls on selected approval-capable nodes:

- explicit `approval` nodes
- `tool` nodes blocked by policy
- `foreach` body nodes that contain an approval-capable action
- `session` nodes whose spawned session is waiting on an approval
- `orchestrator` nodes if they produce approval-gated actions

For a normal workflow approval, the selected-node pane should show `Approve once`, `Approve for this run`, `Approve matching requests`, and `Deny`.

For a `foreach` body approval, the selected-node pane should show `Approve once`, `Approve remaining rows`, `Approve matching requests`, and `Deny`. `Approve remaining rows` creates a workflow-execution-scoped rule and should explain that future matching iterations in this run will auto-approve.

#### Workflow Execution List / Details Page

Execution detail pages outside the canvas should expose the same approval controls as the canvas for pending approvals. They should also show auto-approval audit fields on completed node traces so users can diagnose why a node did not pause.

#### Global Pending Approvals Queue

The app should have a cross-context pending approvals surface so users can find blocked work without opening every session or workflow. This can live under Automation or Notifications, but it should list:

- pending session approvals
- pending workflow approval nodes
- pending workflow tool-policy approvals
- pending approvals inside workflow-created sessions
- pending foreach body approvals

Each row should deep-link to the originating session, workflow execution canvas, or execution detail page. It should expose the same context-aware actions as the source surface. Durable rule creation still deep-links to the shared confirmation dialog.

#### Workflow Editor Validation / Data Flow Panels

The editor should not create approval rules, but it should surface rule eligibility where useful:

- tool nodes should identify parameters that can become matchers, such as document ids, spreadsheet ids, repo names, issue ids, or URL hosts
- data-flow and edge inspection panels should show resolved parameter contracts when available
- validation messages should avoid implying that a persistent rule exists when the user only approved a runtime-scoped rule

This is informational only; durable rules should still be created from concrete runtime approvals, where resolved params are known.

#### Approval Rule Confirmation Dialog

The durable rule dialog is shared by sessions and workflows. It should:

- show the subject being approved
- list resolved params with checkbox-controlled matchers
- preselect stable identifiers
- leave payload/content fields unselected
- require at least one matcher unless the action is read-only and explicitly safe
- preview the exact human-readable rule before saving

The dialog should make scope explicit: user, team, or environment. The first implementation can default to user scope.

#### Settings: Approval Rules

User settings should include a durable approval-rules list. Users need to:

- list active rules
- inspect subject, scope, matcher summary, origin, creator, and last matched time if available
- revoke a rule
- optionally edit label and expiry

Editing matchers can be deferred if the creation dialog is strong enough; revocation is required.

#### Admin / Team Policy UI

Admin policy UI should remain the place for organization-level deny and required-approval rules. It should also show how admin policy interacts with user approval rules:

- admin deny overrides user rules
- admin require-approval may prevent creating durable user rules if configured that way
- user rules can quiet approvals only where admin policy allows it

Team/environment-scoped approval rules can be added here once the base user-scoped flow is working.

#### Slack and Telegram Approval Messages

Slack and Telegram should support safe approval choices that do not require complex matcher editing:

- `Approve once`
- `Approve for this session` or `Approve for this run`, depending on context
- `Deny`

`Approve matching requests` should be omitted or deep-link to the web confirmation dialog until the channel UI can clearly show parameter matchers. Durable rule creation should not happen from a chat button that cannot display the full rule.

Channel approval actions must use signed, single-use action tokens with short expiry. The token must bind:

- approval id
- user id
- channel identity
- decision
- scope
- idempotency key

The backend must reject replayed, expired, or mismatched channel actions. Channel users may approve only approvals they could approve in the web UI.

#### Workflow Agent Tool Results

Remote worker tools that validate, save, or run workflows should expose approval-rule outcomes in their returned execution data:

- pending approval ids
- auto-approved approval ids
- matched rule summaries
- blocked-by-admin-policy messages

This lets agents explain why a workflow did or did not pause without scraping the web UI.

### Durable Rule Creation Dialog

The durable rule dialog starts from a concrete approval request and shows the resolved params.

Example:

```text
Always approve:
google_workspace.sheets.append_rows

Only when:
[x] spreadsheetId equals 1NTVgJuy...
[x] range starts with Companies!
[ ] values any
```

Defaults:

- Select stable target identifiers by default, such as `spreadsheetId`, `documentId`, `repo`, `owner`, or `url host`.
- Do not select payload fields like row values, message body, generated text, or arbitrary content by default.
- Block saving when no parameter matcher is selected unless the action is read-only and explicitly marked safe.

### Audit Display

Auto-approved actions should show why they did not prompt:

```text
Auto-approved by approval rule
google_workspace.sheets.append_rows
spreadsheetId equals 1NTVgJuy...
created by Conner on Jun 25, 2026
```

Workflow execution traces should include:

- approval rule id
- matched subject
- matched params summary
- created-by user

## API Design

### Approval Resolution

Existing approve endpoints should accept an approval scope:

```json
{
  "decision": "approved",
  "scope": "once" | "session" | "workflow_execution" | "remaining_foreach" | "durable_rule",
  "paramMatchers": [],
  "idempotencyKey": "optional-client-generated-key"
}
```

For compatibility, a bare approve request is treated as `scope = once`.

`scope = durable_rule` requires explicit `paramMatchers`.

The approve endpoint must derive the subject, resolved params, requester context, org, environment, and durable-rule eligibility from the approval request stored on the server. Clients may choose scope and matcher paths/ops/values, but they must not provide or override requester context.

### Rule Management

Add CRUD routes for durable approval rules:

```text
GET    /api/approval-rules
POST   /api/approval-rules
PATCH  /api/approval-rules/:id
DELETE /api/approval-rules/:id
```

Users can list and revoke their own durable rules. Admin/team rule management can be added separately.

## Safety Rules

- Admin, team, environment, and action-level deny decisions win over approval rules.
- Matching uses resolved runtime params only.
- Missing parameter paths fail closed.
- Durable rules must require at least one matcher unless the action is read-only and explicitly marked safe.
- Regex matchers are advanced and should be displayed verbatim before saving.
- Persistent approvals should prefer tool/action parameter rules over node-only rules.
- Durable workflow-node rules must include workflow version/revision id or be rejected.
- Generic workflow approval nodes cannot create durable rules unless they declare an approval contract.
- Approval actions must be idempotent and safe to retry.
- Slack/Telegram approvals require signed, expiring, single-use action tokens.
- Deny-all/bulk-deny should not ship in the MVP.

## Migration Path

1. Add the `approval_rules` table and resolver.
2. Route existing session "approve for session" behavior through session-scoped approval rules.
3. Route workflow approval resolution through the same resolver.
4. Add foreach `Approve remaining rows` using workflow-execution-scoped rules.
5. Add durable rule creation from approval prompts.
6. Add settings UI for reviewing and revoking durable rules.

## Testing Strategy

Worker tests:

- Exact session-scoped rule auto-approves a matching session approval.
- Workflow execution-scoped rule auto-approves future foreach iterations when concurrency is `1`.
- Workflow execution-scoped rule resolves already-pending sibling approvals when concurrency is greater than `1`.
- Durable user-scoped rule matches across manual session and workflow tool node.
- Parameter matcher rejects missing paths.
- Parameter matcher rejects type-mismatched values after canonicalization.
- Parameter matcher rejects redacted/secret values for durable rules.
- Regex matcher validates and fails closed on invalid patterns.
- Admin deny and action-level deny override every approval rule.
- Durable workflow-node rule is rejected without workflow version/revision id.
- Durable workflow approval rule is rejected when the node does not declare an approval contract.
- Cross-org and cross-environment rules do not match.
- Duplicate approve requests are idempotent and do not create duplicate rules.
- Foreach approval with concurrency greater than `1` does not create duplicate prompts after `Approve remaining rows`.
- Slack/Telegram signed approval actions reject replay, expiry, and channel/user mismatch.
- Resolved runtime params are used instead of raw template params.

Client tests:

- Approval card renders the right scope actions for session, workflow execution, and foreach.
- Workflow execution canvas and details page render the same approval actions for the same pending approval.
- Global pending approvals queue shows session, workflow, workflow-created session, and foreach approvals.
- Durable rule dialog pre-selects stable identifiers and leaves payload fields unselected.
- Durable rule dialog hides or disables durable creation for generic workflow approval nodes without contracts.
- Foreach "Approve remaining rows" calls the approval endpoint with the correct scope.
- Auto-approved trace rows display matched approval-rule metadata.
- Settings approval-rules list supports inspecting and revoking durable rules.
- Slack/Telegram approval payloads do not create durable rules without a web confirmation URL.

Integration tests:

- A workflow with `foreach(concurrency: 1)` and a gated Google Sheets write prompts once, then auto-approves remaining rows.
- A workflow-created session uses a workflow-execution-scoped rule.
- A durable Google Sheets rule applies to both a manual session and a workflow tool node.

## Open Questions

1. Which params are considered stable identifiers per integration action? This needs per-action metadata before durable rule creation feels trustworthy.
2. Should durable team/environment-scoped approval-rule creation ship in the first UI, or should the first UI expose only user-scoped durable rules while the schema supports all scopes?
3. Should admin-managed approval rules be created in the same settings surface as admin deny/require-approval policies, or in a separate "approval automation" surface?
