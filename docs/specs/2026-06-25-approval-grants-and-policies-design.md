# Approval Grants and Parameter-Matched Policies

## Goal

Valet needs one approval override system that works across sessions, workflow executions, workflow-created sessions, foreach loops, orchestrator runs, and direct tool calls.

The immediate workflow problem is noisy approvals inside `foreach`: when concurrency is `1`, only one approval is pending at a time, so a simple "approve all pending" action does not help. The user needs a way to approve the current request and automatically approve matching future requests in the same run.

The broader product goal is reusable approval policy: users should be able to permanently allow a specific action shape, such as "Google Sheets append rows only when `spreadsheetId` is this sheet and `range` starts with `Companies!`", regardless of whether the request comes from a manual session or a workflow.

## Non-Goals

- This does not replace organization-level deny rules. Admin deny must continue to win.
- This does not allow broad "always approve all Google Workspace writes" by default.
- This does not use raw templated workflow params for matching. Matching must use resolved runtime params.
- This does not require a rich policy editor in the first implementation. Policies can be created from concrete approval prompts first.

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

### Approval Grant

An approval grant is a short-lived runtime override created while work is in progress.

Examples:

- Approve once.
- Approve matching requests for this session.
- Approve matching requests for this workflow execution.
- Approve matching requests for the remaining rows in a `foreach` loop.

Grants expire automatically with their scope. They are operational convenience, not long-term configuration.

### Approval Policy

An approval policy is a persistent reusable rule.

Examples:

- Always allow `google_workspace.sheets.append_rows` when `spreadsheetId` equals a specific spreadsheet and `range` starts with `Companies!`.
- Always allow GitHub reads for `tkhq/valet`.
- Always allow browser navigation to `https://www.ycombinator.com/*`.

Policies are user/team/environment scoped and persist until revoked or expired.

## Data Model

### `approval_grants`

Runtime approvals that expire with a session, workflow execution, or timeout.

| Column | Notes |
| --- | --- |
| `id` | UUID |
| `ownerUserId` | User that owns the grant |
| `scope` | `session`, `workflow_execution`, `orchestrator_run` |
| `scopeId` | Session id, workflow execution id, or orchestrator run id |
| `approvalKind` | `tool_policy`, `workflow_approval`, `session_tool` |
| `subject` | Stable target such as `tool:google_workspace.sheets.append_rows` or `workflowNode:write_companies` |
| `decision` | `approved` |
| `paramMatchers` | JSON array of parameter matchers |
| `createdFromApprovalId` | Approval request that created this grant |
| `createdBy` | User id |
| `expiresAt` | Optional absolute expiry |
| `revokedAt` | Nullable |
| `createdAt`, `updatedAt` | Audit timestamps |

### `approval_policies`

Persistent rules that can match across sessions and workflows.

| Column | Notes |
| --- | --- |
| `id` | UUID |
| `ownerUserId` | User that owns the policy |
| `scope` | `user`, `team`, `environment` |
| `scopeId` | User id, team id, environment id |
| `approvalKind` | `tool_policy`, `workflow_approval`, `session_tool` |
| `subject` | Stable target such as `tool:google_workspace.sheets.append_rows` |
| `decision` | `approved` |
| `paramMatchers` | JSON array of parameter matchers |
| `createdFromApprovalId` | Optional approval request that generated this rule |
| `createdBy` | User id |
| `expiresAt` | Optional |
| `revokedAt` | Nullable |
| `createdAt`, `updatedAt` | Audit timestamps |

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
- Regex matching is path-specific and treated as advanced UI.
- Regex values should be validated when saved.
- The UI should prefer `equals`, `oneOf`, and `startsWith` before exposing regex.

Example policy:

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

1. Organization/admin deny policy.
2. Active runtime grant scoped to the exact session.
3. Active runtime grant scoped to the parent workflow execution, if present.
4. Persistent approval policy scoped to user/team/environment.
5. Existing action policy result: allow, require approval, or deny.

Admin deny always wins. User approvals and policies may only make allowed/approval-required work quieter; they must not bypass explicit organization denies.

Workflow-level durability should be modeled as an `approval_policy` with parameter matchers, not as a long-lived workflow grant. Runtime grants are for active work only; policies are the durable cross-session/cross-workflow mechanism.

## Subject Model

Subjects must be stable enough to match the same permission shape across contexts.

Recommended subjects:

| Subject | Meaning |
| --- | --- |
| `tool:<service>.<action>` | Tool/action approval, e.g. `tool:google_workspace.sheets.append_rows` |
| `workflowNode:<workflowId>:<nodeId>` | A specific workflow node |
| `workflowNodeAction:<workflowId>:<nodeId>:<service>.<action>` | A specific workflow tool node and action |
| `sessionTool:<toolName>` | Native/session-side tool approval |

For cross-session/workflow reusable policies, prefer tool subjects with parameter matchers. For workflow-run grants, workflow-node subjects are useful because users are often approving the behavior of one node in one graph.

## Runtime Behavior

### Sessions

Current session approval behavior should be implemented as session-scoped grants.

When a session approval appears:

- `Approve once` resolves only that request.
- `Approve for this session` creates an `approval_grant` with `scope = session`.
- `Approve matching requests` creates an `approval_policy`.

Future session tool calls check the grant/policy resolver before creating another prompt.

### Workflow Executions

Workflow execution approvals should use execution-scoped grants.

When a workflow approval appears:

- `Approve once` resolves only that approval row.
- `Approve for this run` creates `approval_grant(scope = workflow_execution, scopeId = executionId)`.
- `Approve matching requests` creates a persistent `approval_policy`.

Future workflow nodes and workflow-created sessions check for execution-scoped grants using the parent execution id.

### Foreach

Foreach approval UX should not depend on multiple approvals being pending at once.

When an approval appears inside a `foreach` body:

- `Approve once` resolves the current iteration only.
- `Approve remaining rows` creates an execution-scoped grant for the same body approval shape and resolves the current approval.
- If other sibling approvals are already pending because `concurrency > 1`, the backend resolves those matching pending approvals immediately.
- Future iterations with `concurrency = 1` auto-approve as they reach the approval point.

The engine must keep per-iteration workflow event types. It should not make all iterations wait on the same event type.

### Workflow-Created Sessions

Sessions created by workflow `session` nodes should carry parent workflow context:

- `workflowExecutionId`
- `workflowId`
- `nodeId`

When a workflow-created session hits an approval:

1. Check session-scoped grants.
2. Check workflow-execution-scoped grants.
3. Check persistent policies.
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

`Approve matching requests` should open a confirmation dialog before creating a persistent policy.

### Policy Creation Dialog

The policy dialog starts from a concrete approval request and shows the resolved params.

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
- Show a warning when no parameter matcher is selected.

### Audit Display

Auto-approved actions should show why they did not prompt:

```text
Auto-approved by policy
google_workspace.sheets.append_rows
spreadsheetId equals 1NTVgJuy...
created by Conner on Jun 25, 2026
```

Workflow execution traces should include:

- approval grant/policy id
- matched subject
- matched params summary
- created-by user

## API Design

### Approval Resolution

Existing approve endpoints should accept an approval scope:

```json
{
  "decision": "approved",
  "scope": "once" | "session" | "workflow_execution" | "remaining_foreach" | "policy",
  "paramMatchers": []
}
```

For compatibility, a bare approve request is treated as `scope = once`.

`scope = policy` requires explicit `paramMatchers`.

### Policy Management

Add CRUD routes for persistent policies:

```text
GET    /api/approval-policies
POST   /api/approval-policies
PATCH  /api/approval-policies/:id
DELETE /api/approval-policies/:id
```

Users can list and revoke their own policies. Admin/team policy management can be added separately.

## Safety Rules

- Admin deny wins over grants and policies.
- Matching uses resolved runtime params only.
- Missing parameter paths fail closed.
- Persistent policies must require at least one matcher unless the action is read-only and explicitly marked safe.
- Regex matchers are advanced and should be displayed verbatim before saving.
- Persistent approvals should prefer tool/action parameter policies over node-only policies.
- Deny-all/bulk-deny should not ship in the MVP.

## Migration Path

1. Add the grant/policy tables and resolver.
2. Route existing session "approve for session" behavior through `approval_grants`.
3. Route workflow approval resolution through the same resolver.
4. Add foreach `Approve remaining rows` using workflow-execution-scoped grants.
5. Add policy creation from approval prompts.
6. Add settings UI for reviewing and revoking persistent policies.

## Testing Strategy

Worker tests:

- Exact session grant auto-approves a matching session approval.
- Workflow execution grant auto-approves future foreach iterations when concurrency is `1`.
- Workflow execution grant resolves already-pending sibling approvals when concurrency is greater than `1`.
- Persistent policy matches across manual session and workflow tool node.
- Parameter matcher rejects missing paths.
- Regex matcher validates and fails closed on invalid patterns.
- Admin deny overrides grant and policy.
- Resolved runtime params are used instead of raw template params.

Client tests:

- Approval card renders the right scope actions for session, workflow execution, and foreach.
- Policy dialog pre-selects stable identifiers and leaves payload fields unselected.
- Foreach "Approve remaining rows" calls the approval endpoint with the correct scope.
- Auto-approved trace rows display matched policy/grant metadata.

Integration tests:

- A workflow with `foreach(concurrency: 1)` and a gated Google Sheets write prompts once, then auto-approves remaining rows.
- A workflow-created session uses a workflow-execution grant.
- A persistent Google Sheets policy applies to both a manual session and a workflow tool node.

## Open Questions

1. Should persistent policies start at user scope only, or should we include team/environment scope in the first schema?
2. Should explicit deny policies ship in the first version, or remain admin-only for now?
3. Which params are considered stable identifiers per integration action? This may need per-action metadata.
4. Should "Approve matching requests" be available in Slack/Telegram immediately, or only in the web UI until the confirmation dialog is mature?
