# Approval Rules Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement one approval-rule system that makes workflows less tedious by letting users approve once, approve for the current session/run, approve remaining foreach rows, or create durable parameter-matched rules that work across sessions and workflows without bypassing admin deny policies.

**Architecture:** Add a shared `approval_rules` primitive and resolver in the worker, route existing session action approvals and workflow approval rows through it, then surface context-aware approval actions in session chat, workflow execution UI, workflow editor readiness, global approvals, and settings. Existing `action_policies` remain the admin/base policy layer; approval rules are user/runtime exceptions that can only quiet approval-required work after deny checks pass.

**Tech Stack:** Cloudflare Worker + D1 + Drizzle, Cloudflare Workflows, Durable Objects session agent, React + TanStack Query client, shared TypeScript workflow DAG types, Vitest.

---

## Reference Inputs

- Design spec: `docs/specs/2026-06-25-approval-rules-design.md`
- Current workflow approvals:
  - `packages/worker/src/lib/schema/workflow-approvals.ts`
  - `packages/worker/src/lib/db/workflow-approvals.ts`
  - `packages/worker/src/services/workflow-approvals.ts`
  - `packages/worker/src/workflows/approvals.ts`
- Current session approvals/action policy:
  - `packages/worker/src/lib/schema/actions.ts`
  - `packages/worker/src/lib/db/actions.ts`
  - `packages/worker/src/services/action-policy.ts`
  - `packages/worker/src/services/actions.ts`
  - `packages/worker/src/durable-objects/session-agent.ts`
  - `packages/worker/src/routes/action-invocations.ts`
- Current workflow runtime:
  - `packages/worker/src/workflows/nodes/tool.ts`
  - `packages/worker/src/workflows/nodes/approval.ts`
  - `packages/worker/src/workflows/nodes/foreach.ts`
  - `packages/worker/src/workflows/nodes/session.ts`
  - `packages/worker/src/workflows/nodes/orchestrator.ts`
  - `packages/worker/src/workflows/trace-writer.ts`
- Current client approval UI:
  - `packages/client/src/api/executions.ts`
  - `packages/client/src/components/workflows/execution-approval-panel.tsx`
  - `packages/client/src/components/workflows/workflow-execution-viewer.tsx`
  - `packages/client/src/components/workflows/workflow-editor-model.ts`
  - `packages/client/src/components/workflows/visual-workflow-editor.tsx`
  - `packages/client/src/components/settings/action-policy-overrides-section.tsx`
  - `packages/client/src/routes/settings/index.tsx`
  - `packages/client/src/routes/inbox.tsx`
  - `packages/client/src/lib/approval-prompts.ts`
  - `packages/client/src/components/chat/chat-container.tsx`

## Implementation Sequence

### 1. Add Approval Rule Schema And DB Access

- [ ] Add `packages/worker/src/lib/schema/approval-rules.ts`.
  - Table: `approval_rules`.
  - Columns:
    - `id text primary key`
    - `orgId text not null`
    - `environment text not null`
    - `ownerUserId text references users(id) on delete cascade`
    - `scope text not null`
    - `scopeId text not null`
    - `managedBy text not null default 'user'`
    - `approvalKind text not null`
    - `subject text not null`
    - `decision text not null default 'approved'`
    - `paramMatchers text not null default '[]'`
    - `label text`
    - `origin text not null`
    - `createdFromApprovalId text`
    - `createdBy text references users(id) on delete set null`
    - `lastMatchedAt text`
    - `expiresAt text`
    - `revokedAt text`
    - `createdAt text not null default datetime('now')`
    - `updatedAt text not null default datetime('now')`
  - Indexes:
    - `(orgId, environment, ownerUserId, scope, scopeId)`
    - `(orgId, environment, subject)`
    - `(expiresAt)`
    - `(revokedAt)`
- [ ] Export the schema from `packages/worker/src/lib/schema/index.ts`.
- [ ] Add migration `packages/worker/migrations/0022_approval_rules.sql`.
  - Include the table and indexes above.
  - Do not mutate `user_action_policy_overrides` in this migration; bridge it in code first so rollback is simpler.
- [ ] Add `packages/worker/src/lib/db/approval-rules.ts`.
  - Types:
    - `ApprovalRuleScope = 'session' | 'workflow_execution' | 'orchestrator_run' | 'user' | 'team' | 'environment'`
    - `ApprovalRuleDecision = 'approved'`
    - `ParamMatcher` matching the spec.
  - Functions:
    - `createApprovalRule(db, input)`
    - `getApprovalRule(db, id)`
    - `listApprovalRulesForUser(db, { orgId, environment, userId })`
    - `revokeApprovalRule(db, { id, orgId, userId })`
    - `listCandidateApprovalRules(db, input)`
    - `touchApprovalRuleMatch(db, id)`
- [ ] Add unit tests in `packages/worker/src/lib/db/approval-rules.test.ts`.
  - Insert/list/revoke user-scoped durable rules.
  - Expired and revoked rules do not appear as candidates.
  - Cross-org and cross-environment candidates are excluded.

Verification:

```bash
pnpm vitest packages/worker/src/lib/db/approval-rules.test.ts
```

Expected: approval-rule DB tests pass.

Commit point: `git commit -m "Add approval rules persistence"`

### 2. Implement Shared Approval Rule Resolver

- [ ] Add `packages/worker/src/services/approval-rules.ts`.
- [ ] Implement `resolveApprovalRuleDecision(db, input)`.
  - Inputs:
    - `orgId`, `environment`, `userId`
    - runtime context: `sessionId`, `workflowExecutionId`, `orchestratorRunId`
    - `approvalKind`
    - `subject`
    - `params`
    - already-resolved deny/base policy metadata
  - Order:
    1. return denied immediately when base/admin policy says deny
    2. session-scoped rules
    3. workflow-execution-scoped rules
    4. orchestrator-run-scoped rules
    5. durable user/team/environment rules
    6. no match
- [ ] Implement `matchParamMatchers(params, matchers)`.
  - Missing paths fail closed.
  - Type-strict equality after canonicalization.
  - `startsWith`, `contains`, and `matches` only apply to strings.
  - Invalid regex fails closed and should never throw from runtime match.
- [ ] Implement path parsing helpers in the same service or `packages/worker/src/lib/approval-rule-paths.ts`.
  - Dot paths work for normal keys.
  - Escaped/bracket paths are supported for keys with dots/brackets/quotes.
- [ ] Add matcher validation helpers:
  - reject durable rules with zero matchers unless the subject is explicitly read-only safe
  - reject secret/redacted matcher fields
  - reject regex patterns above the configured length or failing compilation
- [ ] Add `buildApprovalSubject(...)` helpers for:
  - `tool:<service>.<action>`
  - `workflowNode:<workflowId>:<nodeId>`
  - `workflowNodeAction:<workflowId>:<nodeId>:<service>.<action>`
  - `sessionTool:<toolName>`
- [ ] Add unit tests in `packages/worker/src/services/approval-rules.test.ts`.
  - Exact match, oneOf, startsWith, contains, regex.
  - Missing path fail closed.
  - Type mismatch fail closed.
  - Invalid regex fail closed.
  - Session rule beats durable rule.
  - Workflow execution rule applies after session misses.
  - Durable user rule applies across session and workflow contexts.
  - Deny policy beats every rule.

Verification:

```bash
pnpm vitest packages/worker/src/services/approval-rules.test.ts
```

Expected: resolver tests pass.

Commit point: `git commit -m "Add approval rule resolver"`

### 3. Enrich Approval Request Records

- [ ] Extend `workflow_approvals` in a migration, likely `0023_workflow_approval_rule_context.sql`.
  - Add nullable columns:
    - `org_id`
    - `environment`
    - `workflow_id`
    - `workflow_version_id`
    - `iteration_index`
    - `subject`
    - `resolved_params`
    - `approval_rule_id`
    - `auto_approved_at`
    - `auto_approved_by`
  - Backfill is not required for old dev rows; new runtime rows must populate these fields.
- [ ] Update `packages/worker/src/lib/schema/workflow-approvals.ts`.
- [ ] Update `packages/worker/src/lib/db/workflow-approvals.ts`.
  - Extend `CreateWorkflowApprovalInput`.
  - Add `markWorkflowApprovalAutoApproved(db, input)`.
  - Add `listMatchingPendingWorkflowApprovals(db, input)` for foreach sibling resolution.
  - Add `resolveMatchingPendingWorkflowApprovals(db, input)` that returns the rows it resolved.
- [ ] Extend `RequestApprovalArgs` in `packages/worker/src/workflows/approvals.ts`.
  - Add `orgId`, `environment`, `workflowId`, `workflowVersionId`, `subject`, `resolvedParams`, optional `approvalKind`.
- [ ] Update `packages/worker/src/routes/workflows.ts` and flat execution routes to return the new fields in `ExecutionApproval`.
- [ ] Update `packages/client/src/api/executions.ts` `ExecutionApproval` with:
  - `iterationIndex`
  - `subject`
  - `resolvedParams`
  - `approvalRuleId`
  - `autoApprovedAt`
  - `autoApprovedBy`

Verification:

```bash
pnpm vitest packages/worker/src/lib/db/workflow-approvals.test.ts packages/worker/src/routes/workflows.test.ts
pnpm --filter @valet/client typecheck
```

Expected: existing workflow approval API tests pass and client types compile.

Commit point: `git commit -m "Record approval rule context on workflow approvals"`

### 4. Route Workflow Approval And Tool Nodes Through Rules

- [ ] Update `packages/worker/src/workflows/approvals.ts`.
  - Before inserting `workflow_approvals`, call `resolveApprovalRuleDecision`.
  - If matched:
    - write an approval audit row with `status = 'approved'`
    - set `approvalRuleId`, `autoApprovedAt`, `autoApprovedBy`
    - return an approved `ApprovalOutcome` without `waitForEvent`
  - If no match, continue current row + `waitForEvent` behavior.
- [ ] Update `packages/worker/src/workflows/nodes/approval.ts`.
  - Pass `subject = workflowNode:<workflowId>:<nodeId>` for runtime rules.
  - Only allow durable rule creation when the approval node declares an approval contract. Add the shared type in a later step; runtime subject can ship first.
- [ ] Update `packages/worker/src/workflows/nodes/tool.ts`.
  - Continue using `resolveEffectiveMode`/`invokeWorkflowAction` for base policy and audit.
  - Pass `subject = tool:<service>.<action>` and `resolvedParams = renderedParams` into `requestApproval`.
  - If `requestApproval` returns auto-approved, mark invocation `approved` with `resolvedBy` from the rule creator or system marker before executing.
- [ ] Update `packages/worker/src/workflows/nodes/foreach.ts`.
  - Preserve per-iteration `iterationIndex`.
  - Ensure future iterations check rules immediately before prompting.
- [ ] Add worker tests:
  - `packages/worker/src/workflows/approvals.test.ts`: auto-approved explicit approval node.
  - `packages/worker/src/workflows/nodes/tool.test.ts`: matching rule auto-approves a workflow tool node and still writes action invocation audit.
  - `packages/worker/src/workflows/nodes/foreach.test.ts`: workflow-execution rule auto-approves future iterations with `concurrency = 1`.

Verification:

```bash
pnpm vitest packages/worker/src/workflows/approvals.test.ts packages/worker/src/workflows/nodes/tool.test.ts packages/worker/src/workflows/nodes/foreach.test.ts
```

Expected: workflow approval auto-approval tests pass.

Commit point: `git commit -m "Use approval rules in workflow approvals"`

### 5. Add Context-Aware Approval Resolution Scopes

- [ ] Extend approval resolve request schemas in `packages/worker/src/routes/workflows.ts` and flat execution approval routes.
  - Accept:
    - `scope?: 'once' | 'workflow_execution' | 'remaining_foreach' | 'durable_rule'`
    - `paramMatchers?: ParamMatcher[]`
    - `label?: string`
    - `idempotencyKey?: string`
  - Default `scope = 'once'`.
- [ ] Update `packages/worker/src/services/workflow-approvals.ts`.
  - `once`: current behavior.
  - `workflow_execution`: create/reuse execution-scoped approval rule and resolve current approval.
  - `remaining_foreach`: create/reuse execution-scoped approval rule, resolve current approval, then resolve matching pending sibling approvals in the same execution.
  - `durable_rule`: validate durable eligibility and matchers, create user-scoped durable rule, resolve current approval, then resolve any matching pending approvals for the same execution.
- [ ] Make the resolver operation idempotent.
  - Use deterministic idempotency keys for runtime rules:
    - `approval_rule:${approvalId}:${scope}`
  - For durable rules, use request `idempotencyKey` plus `createdFromApprovalId`.
  - Double-clicking an approval button must not create duplicate rules or dispatch duplicate events.
- [ ] Ensure each resolved sibling approval sends its own Cloudflare event type.
- [ ] Add tests in `packages/worker/src/services/workflow-approvals.test.ts`.
  - `Approve once` unchanged.
  - `Approve for this run` creates a workflow-execution rule.
  - `Approve remaining rows` resolves current plus already-pending matching foreach siblings.
  - Repeating the same request is idempotent.
  - Durable creation is rejected for generic approval nodes without contracts.
  - Durable creation is rejected with zero matchers for non-read-only subjects.

Verification:

```bash
pnpm vitest packages/worker/src/services/workflow-approvals.test.ts packages/worker/src/routes/workflows.test.ts
```

Expected: scoped approval route tests pass.

Commit point: `git commit -m "Add scoped workflow approval resolution"`

### 6. Route Session Approval Behavior Through Approval Rules

- [ ] Update `packages/worker/src/services/actions.ts`.
  - In `invokeAction`, check approval rules after admin/base deny but before creating a pending approval prompt.
  - For matched rules, create `action_invocations` with:
    - `resolvedMode = 'allow'` or an explicit auto-approved marker if adding one
    - `userOverrideId` replaced or supplemented by `approvalRuleId` after schema extension
    - `policySource = 'approval_rule'`
    - `status = 'executed'` only after execution, preserving current audit semantics.
- [ ] Extend `action_invocations` with nullable `approval_rule_id` via the same migration as workflow approval context or a separate migration.
- [ ] Update `packages/worker/src/durable-objects/session-agent.ts`.
  - Replace `allow_session` persistence through `user_action_policy_overrides` with session-scoped `approval_rules`.
  - Replace `allow_always` persistence with durable user-scoped `approval_rules`.
  - Keep backward-compatible transport action ids:
    - `allow_once`
    - `allow_session`
    - `allow_always`
    - `cancel`
  - Internally translate labels to the new product language:
    - Approve once
    - Approve for this session
    - Approve matching requests
    - Deny
- [ ] Update `packages/worker/src/routes/action-invocations.ts`.
  - Accept optional matcher payloads for durable creation when approving a session prompt.
  - Keep current `/approve` and `/deny` endpoints compatible.
- [ ] Ensure workflow-created sessions carry parent workflow context.
  - Inspect/update:
    - `packages/worker/src/workflows/nodes/session.ts`
    - session creation helpers under `packages/worker/src/lib/db/session*.ts`
  - Persist or pass:
    - `workflowExecutionId`
    - `workflowId`
    - `nodeId`
  - Session action approval resolver checks session rules first, then workflow-execution rules, then durable rules.
- [ ] Update cleanup.
  - Replace `deleteSessionActionPolicyOverrides` calls in `session-agent.ts` with deletion/revocation of runtime session-scoped approval rules.
  - Durable rules must survive session termination.
- [ ] Add tests in `packages/worker/src/durable-objects/session-agent.test.ts` and `packages/worker/src/services/actions.test.ts`.
  - Approve for this session creates a session rule.
  - Future matching session action auto-approves.
  - Durable rule created from a session approval applies to a workflow tool node.
  - Workflow-created session uses parent workflow-execution rule.
  - Deny policy still wins.

Verification:

```bash
pnpm vitest packages/worker/src/services/actions.test.ts packages/worker/src/durable-objects/session-agent.test.ts
```

Expected: session approval tests pass with new approval rules.

Commit point: `git commit -m "Unify session approvals with approval rules"`

### 7. Add Approval Rules API And Pending Queue

- [ ] Add `packages/worker/src/routes/approval-rules.ts`.
  - `GET /api/approval-rules`: list current user's durable rules.
  - `POST /api/approval-rules`: create a durable user-scoped rule from server-validated subject and matchers.
  - `PATCH /api/approval-rules/:id`: update label/expiry only in MVP.
  - `DELETE /api/approval-rules/:id`: revoke current user's durable rule.
- [ ] Mount the route in `packages/worker/src/index.ts`.
- [ ] Add `packages/worker/src/routes/approvals.ts` or extend existing routes with a global pending approvals endpoint.
  - Return pending:
    - session/action invocations
    - workflow approval rows
    - workflow-created session approvals
  - Include deep-link metadata for source UI.
- [ ] Add route tests:
  - `packages/worker/src/routes/approval-rules.test.ts`
  - `packages/worker/src/routes/approvals.test.ts`
- [ ] Keep admin policy routes separate.
  - Do not remove `action_policies`.
  - Do not expose team/environment-scoped rule creation in MVP unless admin permission checks are implemented.

Verification:

```bash
pnpm vitest packages/worker/src/routes/approval-rules.test.ts packages/worker/src/routes/approvals.test.ts
pnpm --filter @valet/worker typecheck
```

Expected: API tests and worker typecheck pass.

Commit point: `git commit -m "Add approval rules API"`

### 8. Update Client API Hooks And Shared Approval Dialog

- [ ] Add `packages/client/src/api/approval-rules.ts`.
  - Hooks:
    - `useApprovalRules`
    - `useCreateApprovalRule`
    - `useUpdateApprovalRule`
    - `useDeleteApprovalRule`
    - `usePendingApprovals`
- [ ] Extend `packages/client/src/api/executions.ts`.
  - `ResolveApprovalRequest` includes `scope`, `paramMatchers`, `label`, `idempotencyKey`.
  - Add helper mutations:
    - `useApproveExecutionApprovalOnce`
    - `useApproveExecutionApprovalForRun`
    - `useApproveExecutionApprovalForRemainingForeach`
    - `useCreateDurableApprovalRuleFromExecutionApproval`
  - Existing `useApproveExecutionApproval` can call the once variant for compatibility.
- [ ] Add `packages/client/src/components/approvals/approval-rule-dialog.tsx`.
  - Shows subject.
  - Shows resolved params.
  - Preselects stable identifiers.
  - Requires at least one matcher unless read-only safe.
  - Calls route/mutation with only matcher choices, never server context.
- [ ] Add matcher display utilities in `packages/client/src/components/approvals/approval-rule-utils.ts`.
  - Human-readable matcher summaries.
  - Stable matcher preselection.
  - Payload/content fields default unselected.
- [ ] Add tests:
  - `packages/client/src/components/approvals/approval-rule-utils.test.ts`
  - `packages/client/src/api/approval-rules.test.ts` if API hook tests already exist; otherwise cover via component tests.

Verification:

```bash
pnpm vitest packages/client/src/components/approvals/approval-rule-utils.test.ts
pnpm --filter @valet/client typecheck
```

Expected: client approval API and dialog types compile.

Commit point: `git commit -m "Add approval rule client primitives"`

### 9. Update Workflow Execution Approval UI

- [ ] Update `packages/client/src/components/workflows/execution-approval-panel.tsx`.
  - For explicit workflow approval:
    - Approve once
    - Approve for this run
    - Approve matching requests only when durable eligible
    - Deny
  - For workflow tool-policy approval:
    - Approve once
    - Approve for this run
    - Approve matching requests
    - Deny
  - For foreach approval:
    - Approve once
    - Approve remaining rows
    - Approve matching requests
    - Deny
  - Open `ApprovalRuleDialog` for durable creation.
- [ ] Update `packages/client/src/components/workflows/workflow-execution-viewer.tsx`.
  - Selected node pane shows the same pending approval actions as `ExecutionApprovalPanel`.
  - Completed auto-approved nodes display:
    - matched rule label/id
    - matcher summary
    - created-by user when available.
- [ ] Update `packages/client/src/components/workflows/workflow-execution-viewer-model.ts`.
  - Map approval rows to selected-node traces.
  - Detect foreach body approval rows via `iterationIndex`.
- [ ] Add tests:
  - `packages/client/src/components/workflows/workflow-execution-viewer-model.test.ts`
  - Existing `execution-approval-panel` test file if present, otherwise add one.

Verification:

```bash
pnpm vitest packages/client/src/components/workflows/workflow-execution-viewer-model.test.ts
pnpm --filter @valet/client typecheck
```

Expected: workflow execution UI model tests pass.

Commit point: `git commit -m "Surface scoped approvals in workflow executions"`

### 10. Update Session Chat Approval UI

- [ ] Update `packages/client/src/lib/approval-prompts.ts`.
  - Rename action labels/descriptions:
    - `allow_once`: Approve once
    - `allow_session`: Approve for this session
    - `allow_always`: Approve matching requests
    - `cancel`: Deny
  - Preserve transport ids so existing DO messages still resolve.
- [ ] Update session approval card rendering in:
  - `packages/client/src/components/chat/chat-container.tsx`
  - `packages/client/src/components/chat/deferred-tool-card.tsx` if this is where approval buttons render.
- [ ] Add durable approval dialog launch for session approvals.
  - If a chat/channel prompt cannot show matcher details, deep-link to the web confirmation dialog instead of creating durable rules inline.
- [ ] Update session activity display to show auto-approved-by-rule messages when backend returns rule metadata.
- [ ] Add tests around approval prompt labels and visible actions.

Verification:

```bash
pnpm vitest packages/client/src/lib/approval-prompts.test.ts
pnpm --filter @valet/client typecheck
```

Expected: session approval UI compiles and labels match product language.

Commit point: `git commit -m "Update session approval prompts for approval rules"`

### 11. Add Settings Approval Rules List

- [ ] Replace or supplement `packages/client/src/components/settings/action-policy-overrides-section.tsx`.
  - Rename user-facing section from "Tool Approval Overrides" to "Approval Rules".
  - Show durable `approval_rules`, not only `user_action_policy_overrides`.
  - Columns:
    - Subject
    - Matchers
    - Scope
    - Origin
    - Last matched
    - Actions
  - Required action: revoke.
  - Optional MVP action: edit label/expiry.
- [ ] Update `packages/client/src/routes/settings/index.tsx` to render the new section.
- [ ] Keep admin action policy UI in `packages/client/src/components/settings/action-policies-section.tsx`.
  - Add copy explaining admin deny wins over user approval rules.
- [ ] Add tests:
  - `packages/client/src/components/settings/approval-rules-section.test.tsx`
  - Update `action-policy-overrides-utils.test.ts` if old utilities are removed or renamed.

Verification:

```bash
pnpm vitest packages/client/src/components/settings/approval-rules-section.test.tsx
pnpm --filter @valet/client typecheck
```

Expected: settings UI tests pass and old override labels are gone or intentionally scoped to legacy internals.

Commit point: `git commit -m "Add approval rules settings UI"`

### 12. Add Workflow Editor Approval Readiness And Badges

- [ ] Update shared workflow DAG types.
  - `packages/shared/src/types/workflow-dag/nodes/approval.ts`
    - Add optional `approvalContract`.
  - `packages/shared/src/types/workflow-dag/nodes/tool.ts`
    - No schema change required unless matcher hints need node-level overrides.
  - Update docs in `docs/specs/workflows.md`.
- [ ] Update `packages/client/src/components/workflows/workflow-editor-model.ts`.
  - Add readiness classification:
    - `covered`
    - `intentional_human_gate`
    - `will_prompt`
    - `blocked`
    - `unknown`
  - Approval-capable node detection:
    - `approval`
    - risky `tool`
    - `foreach` containing risky body tool/session/orchestrator
    - `session`
    - `orchestrator`
  - Use concrete trigger defaults, manual test sample data, tool matcher hints, and approval contracts only.
- [ ] Update `packages/client/src/components/workflows/visual-workflow-editor.tsx`.
  - Badges on nodes:
    - Approval required
    - Covered
    - Blocked
    - Needs sample data
  - Publish/Test/enabling trigger warning flow.
  - Setup actions:
    - Pre-approve matching requests
    - Approve matching iterations in each run
    - Keep human approval
    - Run test with sample data
- [ ] Update workflow save/validate agent tool result formatting if needed so agents see:
  - pending approval ids
  - auto-approved approval ids
  - matched rule summaries
  - blocked-by-admin-policy messages
- [ ] Add tests in `packages/client/src/components/workflows/workflow-editor-model.test.ts`.
  - Risky tool gets badge.
  - Covered rule gets covered badge.
  - Admin deny gets blocked badge.
  - Templated unresolved params get needs-sample-data.
  - Generic approval node only offers runtime approval unless `approvalContract` exists.

Verification:

```bash
pnpm vitest packages/client/src/components/workflows/workflow-editor-model.test.ts
pnpm --filter @valet/shared typecheck
pnpm --filter @valet/client typecheck
```

Expected: workflow editor readiness model is covered and types compile.

Commit point: `git commit -m "Add workflow approval readiness badges"`

### 13. Add Global Pending Approvals Surface

- [ ] Update `packages/client/src/routes/inbox.tsx` or add an Automation approvals route depending on product fit.
  - MVP path: use existing Inbox approval filter and feed it from `usePendingApprovals`.
  - Rows include context:
    - session
    - workflow execution
    - workflow-created session
    - foreach iteration
  - Rows deep-link to the right canvas/details/session.
- [ ] Reuse `ApprovalRuleDialog` and approval mutations from the source context.
- [ ] Add tests for route model utilities if the UI has local selectors.

Verification:

```bash
pnpm --filter @valet/client typecheck
```

Expected: global approval queue compiles and links have typed route params.

Commit point: `git commit -m "Add global pending approvals surface"`

### 14. Channel Approval Tokens

- [ ] Inspect existing channel approval routing in:
  - `packages/worker/src/durable-objects/channel-router.ts`
  - `packages/worker/src/durable-objects/channel-resolver.ts`
  - `packages/worker/src/durable-objects/session-agent.ts`
- [ ] Add signed single-use action tokens for Slack/Telegram approval buttons.
  - Token binds:
    - approval id
    - user id
    - channel identity
    - decision
    - scope
    - idempotency key
    - expiry
- [ ] Channel buttons expose:
  - Approve once
  - Approve for this session/run
  - Deny
  - Durable matching approval should deep-link to the web dialog only.
- [ ] Add tests:
  - replay rejected
  - expiry rejected
  - channel/user mismatch rejected
  - durable rule cannot be created from channel-only button

Verification:

```bash
pnpm vitest packages/worker/src/durable-objects/channel-router.test.ts
```

Expected: channel approval tests pass.

Commit point: `git commit -m "Secure channel approval actions"`

### 15. Documentation, Migration Notes, And Full Verification

- [ ] Update `docs/specs/workflows.md`.
  - Document approval rule scopes.
  - Document foreach approval behavior.
  - Document approval contracts for explicit approval nodes.
  - Document that action policy denies beat approval rules.
- [ ] Update `docs/specs/2026-06-25-approval-rules-design.md` only if implementation intentionally diverges from the spec.
- [ ] Run focused tests from each phase.
- [ ] Run package typechecks:

```bash
pnpm --filter @valet/shared typecheck
pnpm --filter @valet/worker typecheck
pnpm --filter @valet/client typecheck
```

- [ ] Run broader worker/client tests likely to catch regressions:

```bash
pnpm vitest packages/worker/src/workflows packages/worker/src/routes packages/worker/src/durable-objects/session-agent.test.ts
pnpm vitest packages/client/src/components/workflows packages/client/src/components/settings packages/client/src/lib/approval-prompts.test.ts
```

- [ ] Deploy to dev:

```bash
ENVIRONMENT=dev make deploy
```

Expected:

- Typechecks pass.
- Workflow/session approval tests pass.
- Dev deploy completes.

Final commit point: `git commit -m "Implement approval rules"`

## Risk Controls

- Keep all deny behavior in `action_policies` authoritative.
- Do not let clients send requester context or subject overrides when resolving an approval.
- Require matcher validation for durable rules; use runtime-scoped rules for broad foreach/session/run approvals.
- Runtime-scoped rules can be broad because they expire with the run/session; durable rules must be parameter-shaped.
- Preserve existing approval transport ids during session migration to avoid breaking runner/session messages.
- Keep every approval resolution idempotent before wiring UI buttons that users may double-click.
- Surface auto-approval audit metadata in traces so silent approvals are explainable.

## MVP Boundary

Ship these in the first implementation:

- Runtime-scoped rules for sessions and workflow executions.
- `Approve remaining rows` for foreach.
- User-scoped durable parameter-matched rules from concrete approval prompts.
- Settings list/revoke for durable rules.
- Workflow editor badges and readiness warnings.

Defer unless easy while implementing:

- Team/environment durable rule creation UI.
- Editing matchers after rule creation.
- Rich admin approval-rule management.
- Durable creation from Slack/Telegram buttons.
