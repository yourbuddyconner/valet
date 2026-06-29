# Parameter-Matched Action Policies Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give Valet one approval resolver covering admin policy, user durable policy, and runtime-scoped approvals — without a parallel `approval_rules` table — so session and workflow approvals (especially `foreach(concurrency: 1)`) stop re-prompting on equivalent requests.

**Architecture:** One resolver over **two tables**. `action_policies` holds durable policy (admin/org + user durable grants with parameter matchers). A new `runtime_grants` table holds ephemeral session- and workflow-execution-scoped allow grants, FK-cascaded to their parent and cleaned up on terminal transition. (The orchestrator is itself a session, so orchestrator approvals are session-scoped — there is no separate orchestrator-run scope.) The existing `user_action_policy_overrides` table is migrated into both (persistent/timed → `action_policies`; session → `runtime_grants`) and retired from new writes. Workflow approval rows and action invocation rows remain audit/wait-state records pointing at the matched policy/grant.

**Delivery is phased.** Phase 1 (sequence steps 1–8) ships the approval-fatigue win using subject-scoped runtime grants — no per-action matcher metadata required — plus session-lineage grant inheritance and child-session approval propagation. Phase 2 (steps 9–14) adds durable parameter policies, per-action canonicalization, the native-tool interdictor (built-in tool restriction), workflow editor readiness, and proactive per-channel approval push.

**Tech Stack:** Cloudflare Worker + D1 + Drizzle, Cloudflare Workflows, Durable Objects session agent, React + TanStack Query client, shared TypeScript workflow DAG types, Vitest.

---

## Reference Inputs

- Design spec: `docs/specs/2026-06-25-approval-rules-design.md`
- Current action policy schema/resolution:
  - `packages/worker/src/lib/schema/actions.ts`
  - `packages/worker/src/lib/db/actions.ts`
  - `packages/worker/src/services/session-tools.ts`
  - `packages/worker/src/services/actions.ts`
  - `packages/worker/src/durable-objects/session-agent.ts`
- Current workflow approval runtime:
  - `packages/worker/src/lib/schema/workflow-approvals.ts`
  - `packages/worker/src/lib/db/workflow-approvals.ts`
  - `packages/worker/src/services/workflow-approvals.ts`
  - `packages/worker/src/workflows/approvals.ts`
  - `packages/worker/src/workflows/nodes/tool.ts`
  - `packages/worker/src/workflows/nodes/approval.ts`
  - `packages/worker/src/workflows/nodes/foreach.ts`
  - `packages/worker/src/workflows/nodes/session.ts`
  - `packages/worker/src/workflows/nodes/orchestrator.ts`
- Current client approval/policy UI:
  - `packages/client/src/components/settings/action-policy-overrides-section.tsx`
  - `packages/client/src/components/settings/action-policy-dialog.tsx`
  - `packages/client/src/components/workflows/execution-approval-panel.tsx`
  - `packages/client/src/components/workflows/workflow-execution-viewer.tsx`
  - `packages/client/src/components/workflows/visual-workflow-editor.tsx`
  - `packages/client/src/api/action-policy-overrides.ts`
  - `packages/client/src/api/executions.ts`

---

# Phase 1 — Runtime grants + unified resolver

## 1. Create `runtime_grants` And Extend `action_policies`

- [ ] Add a migration creating `runtime_grants`:
  - `id`, `org_id` (`DEFAULT 'default'`), `user_id` (FK `users` `ON DELETE CASCADE`)
  - `session_id` (FK `sessions` `ON DELETE CASCADE`, nullable)
  - `workflow_execution_id` (FK `workflow_executions` `ON DELETE CASCADE`, nullable)
  - `subject_type`, `service`, `action_id`, `risk_level`, `workflow_id`, `node_id`
  - `param_matchers` (`DEFAULT '[]'`), `policy_key`, `matcher_summary`, `created_at`, `revoked_at`
  - Enforce exactly one of `session_id` / `workflow_execution_id` is set (CHECK or documented invariant).
- [ ] Add a migration extending `action_policies` with: `org_id` (`DEFAULT 'default'`), `managed_by`, `principal_type` (`org`|`user` only), `principal_id`, `subject_type`, `subject_label`, `workflow_id`, `workflow_version_id`, `node_id`, `param_matchers` (`DEFAULT '[]'`), `matcher_summary`, `user_grant_behavior`, `origin`, `source_approval_id`, `last_matched_at`, `expires_at`, `revoked_at`. **No `environment` column. No `team` principal. No `lifetime` enum** (`expires_at` distinguishes persistent from timed).
- [ ] Document/enforce target-discriminator behavior on both tables:
  - `tool_action`: requires `service`, `action_id`.
  - `workflow_node_action`: requires `service`, `action_id`, `workflow_id`, `node_id`; durable rows also require `workflow_version_id`.
  - `workflow_node`: requires `workflow_id`, `node_id`; durable rows also require `workflow_version_id`; `service`/`action_id`/`risk_level` stay null.
  - `session_tool`: target fields carry the native tool name; integration service/action may stay null.
- [ ] Backfill existing `action_policies` rows as admin/org policies: `managed_by = 'admin'`, `principal_type = 'org'`, `principal_id = org_id`, `subject_type = 'tool_action'` when service/action present, `param_matchers = '[]'`, `user_grant_behavior = 'allowed'` for existing `require_approval` rows.
- [ ] Add a migration extending `workflow_spawned_sessions` with `workflow_id` and `workflow_version_id` (it has neither today) so a workflow-spawned session can recover its execution scope and match workflow-node subjects. Update `packages/worker/src/lib/schema/workflow-spawned-sessions.ts`.
- [ ] Extend `action_invocations` with `matched_policy_id` (FK `action_policies`, `ON DELETE SET NULL`) and `matched_grant_id` (FK `runtime_grants`, `ON DELETE SET NULL`). Keep `user_override_id`, `policy_id`, `org_policy_id`, `base_mode`, `base_source`, `policy_source`, `policy_lifetime`, `policy_scope` for historical reads but stop populating them from new code paths. For one release, alias `policy_id` / `org_policy_id` writes to `matched_policy_id` to keep existing audit queries working.
- [ ] Update `packages/worker/src/lib/schema/actions.ts` with the new `action_policies` columns and a new `runtimeGrants` table.
- [ ] Drop the partial unique indexes that only key on service/action/risk (`idx_ap_action`, `idx_ap_service`, `idx_ap_risk`).
- [ ] Add scope-aware unique indexes:
  - `action_policies`: `org_id`, `managed_by`, `principal_type`, `principal_id`, `subject_type`, target fields, matcher fingerprint.
  - `runtime_grants`: scope id (session/execution), `subject_type`, target fields, `policy_key`.
- [ ] Add lookup indexes (design "Uniqueness And Indexes").
- [ ] Add migration tests / D1 fixture checks that existing action policy rows still resolve identically after backfill.

Verification:

```bash
pnpm --filter @valet/worker typecheck
pnpm vitest packages/worker/src/lib/db/actions.test.ts
```

Expected: worker typecheck passes; existing action policy tests still pass; admin rows coexist with a scoped grant for the same `service/action_id`; invalid target-field combos rejected per `subject_type`; durable workflow-node rows without `workflow_version_id` rejected.

Commit point: `git commit -m "Add runtime_grants and extend action policies"`

## 2. Retire User Overrides Into The New Model

- [ ] Add a migration/startup-safe helper copying `user_action_policy_overrides`:
  - persistent → `action_policies` user durable (`managed_by='user'`, `principal_type='user'`, `principal_id=user_id`).
  - timed → `action_policies` user durable with `expires_at = old expires_at`.
  - session → `runtime_grants` with `session_id` set.
  - carry `mode`, `origin = old source`, `source_approval_id = old source_invocation_id`.
- [ ] Stop creating new `user_action_policy_overrides` rows from `SessionAgentDO`.
- [ ] Replace `upsertUserActionPolicyOverride` call sites with `upsertActionPolicy` (durable) or a new `upsertRuntimeGrant` helper (ephemeral).
- [ ] Generalize `deleteSessionActionPolicyOverrides` into a runtime-grant cleanup hook keyed by scope id; call it on session and workflow-execution terminal transitions.
- [ ] Keep old override read APIs only as compatibility wrappers until the client settings UI moves.

Verification:

```bash
pnpm vitest packages/worker/src/lib/db/actions.test.ts packages/worker/src/durable-objects/session-agent.test.ts
```

Expected: existing session approval tests pass against `action_policies` + `runtime_grants`, not `user_action_policy_overrides`.

Commit point: `git commit -m "Migrate user approval overrides into action policies and runtime grants"`

## 3. Unify Action Policy Resolution

- [ ] Replace split `resolveOrgPolicyMatch` + `resolveUserActionPolicyOverride` with one resolver reading `action_policies` (admin/durable) + `runtime_grants` (ephemeral).
- [ ] Preserve admin specificity: exact action > service > risk level > system default; deny wins first.
- [ ] Implement decision semantics:
  - admin `deny` → deny immediately.
  - admin/system `allow` → allow immediately, no grant lookup.
  - admin `require_approval` + `user_grant_behavior='blocked'` → require approval immediately.
  - admin `require_approval` + `user_grant_behavior='allowed'` → consult grants.
- [ ] Expand `sessionId` to its **lineage** (self + `parentSessionId` ancestor chain) with a depth cap of 16 and a visited-set cycle guard. For **each** session in the lineage, look up `workflow_spawned_sessions` and add any recovered `executionId` to a candidate executions set — execution recovery is per-lineage-member, not only for the originating session. Grant lookup order: runtime grants whose `sessionId` is in the lineage **or** whose `workflowExecutionId` is in the candidate executions set, then durable user policies. Load grants only for these known-live context ids; keep a cheap defensive terminal-state check.
- [ ] Return matched metadata: `matchedPolicyId` / `matchedGrantId`, `policySource`, `policyScope`, `matcherSummary`.
- [ ] Update `action_invocations` writes to store matched policy/grant metadata. `user_override_id` stays for historical rows but stops being populated.

Verification:

```bash
pnpm vitest packages/worker/src/lib/db/actions.test.ts packages/worker/src/services/actions.test.ts packages/worker/src/services/session-tools.test.ts
```

Expected: admin denies still win; runtime/durable allow grants only quiet grantable approvals; `blocked` ignores grants; `allow` skips grant lookup; runtime grants stop matching after the parent context is terminal.

Additional checks:

- A parent-session grant auto-approves a matching call in a child session spawned beneath it; a sibling session outside the lineage does not match.
- A workflow-spawned session matches an execution-scoped grant via the `workflow_spawned_sessions` join.
- A child of a workflow-spawned session matches the execution via per-lineage-member recovery (the originating session has no `workflow_spawned_sessions` row, but its parent does).
- Lineage walk caps at depth 16 and survives a `parentSessionId` cycle without looping.

Commit point: `git commit -m "Unify action policy resolution over two tables"`

## 4. Retire `workflow_approvals`; Consolidate Onto `action_invocations`

Reframed from the previous draft. The previous step 4 ("route workflow approvals through the resolver") assumed `workflow_approvals` would stay as a separate table; tool-node policy approvals were going to be routed through the resolver but the audit row stayed in `workflow_approvals`. That kept a parallel approval primitive alive — the exact thing the spec's thesis argues against. This commit collapses both kinds of workflow approval (`tool_policy`, `explicit`) onto `action_invocations`, the existing universal approval primitive.

- [ ] Register `workflows.request_approval` as a built-in action in `packages/worker/src/integrations/workflows-actions.ts`. Action takes params `{ prompt, summary, details, choices? }`. Hidden from `listActions()` so it doesn't appear in the agent tool catalog; routable via `execute(actionId, ...)` for the workflow runtime.
- [ ] Rewrite `packages/worker/src/workflows/nodes/approval.ts` to invoke `workflows.request_approval` via `invokeWorkflowAction`. Drop the `workflow_approvals` row creation entirely. The resulting `action_invocations` row IS the gate; `step.waitForEvent('approval_<nodeId>')` resumes when it transitions.
- [ ] Update `packages/worker/src/workflows/nodes/tool.ts` to stop creating `workflow_approvals` rows for `tool_policy` approvals. `invokeWorkflowAction` already creates the `action_invocations` row; that's the only gate needed.
- [ ] Add the workflow-resume hook to `approveInvocation` and `denyInvocation` (`packages/worker/src/services/actions.ts`): when the invocation has `workflowExecutionId`, call `env.WORKFLOW_INTERPRETER.get(workflowExecutionId)` directly (the CF instance is registered under the execution id) and fire `instance.sendEvent('approval_<nodeId>', { decision })`. The workflow-specific approve endpoint is no longer the only writer of the resume event.
- [ ] Add nodeId-aware matching to the resolver: when a runtime grant has `workflowId` / `nodeId` set, those participate in the match. Without this, a "Approve remaining rows in foreach body X" grant would silently auto-approve every other workflow approval node in the same execution (because all of them invoke the same `workflows.request_approval` service+actionId).
- [ ] Update `getExecutionAction` (in `integrations/workflows-actions.ts:line 837`-ish) to query `action_invocations` (filtered to `service='workflows' AND actionId='request_approval'` plus tool-policy invocations) instead of `workflow_approvals`. Update `workflowApprovalSchema` response shape accordingly — derive prompt/summary/details from `params`.
- [ ] Migration `0023_retire_workflow_approvals.sql`: copy `kind='explicit'` rows into `action_invocations` (service='workflows', actionId='request_approval', `params = JSON of {prompt, summary, details}`), preserve id/status/executionId/nodeId/userId/resolvedBy/resolvedAt/timeout. Drop the `workflow_approvals` table (rows of `kind='tool_policy'` are redundant duplicates; the matching `action_invocations` row already exists).
- [ ] Workflow-specific approve/deny endpoint (if separately exposed) is removed or aliased to `/api/action-invocations/:id/approve`. Client switches to that endpoint.
- [ ] Update `cancel-cleanup.ts` to transition workflow-attributed pending `action_invocations` to `failed` (with error="workflow execution cancelled") instead of touching `workflow_approvals`. No new status enum value needed.

Verification:

```bash
pnpm --filter @valet/worker typecheck
pnpm --filter @valet/worker exec vitest run
```

Expected: all worker tests pass. Workflow approval nodes execute as built-in tool actions; tool-policy approvals are gated through `action_invocations` alone; both resume the Workflow via the unified hook.

Additional checks:

- A workflow approval node executing produces exactly one `action_invocations` row (service='workflows', actionId='request_approval') and zero `workflow_approvals` rows.
- A workflow tool node hitting `require_approval` produces exactly one `action_invocations` row.
- Approving via `/api/action-invocations/:id/approve` on a workflow-attributed invocation fires `instance.sendEvent` and resumes the Workflow.
- A foreach body containing an `approval` node, with `concurrency: 1` and "Approve remaining rows" applied, prompts once then auto-approves subsequent iterations — and a SEPARATE approval node elsewhere in the same execution is NOT auto-approved (nodeId-aware matching).
- Migration of any existing `workflow_approvals` rows produces equivalent `action_invocations` rows; the `workflow_approvals` table is gone.

Commit point: `git commit -m "Retire workflow_approvals; workflow approvals consolidate onto action_invocations"`

## 5. Add Context-Aware Approval Scopes

- [ ] Extend approval resolve endpoints to accept `scope: 'once' | 'session' | 'workflow_execution' | 'remaining_foreach'`, `label`, `idempotencyKey`. (`durable_policy` + `paramMatchers` arrive in Phase 2.)
- [ ] Implement each scope:
  - `once`: resolve current approval only.
  - `session`: create/reuse a session-scoped `runtime_grants` row, resolve current approval.
  - `workflow_execution`: create/reuse an execution-scoped `runtime_grants` row, resolve current approval.
  - `remaining_foreach`: create/reuse an execution-scoped `runtime_grants` row for the body-node subject (no per-row matchers), resolve current approval, resolve matching pending sibling approvals.
- [ ] Make endpoint retries idempotent via request keys derived from approval id + scope.
- [ ] Persist runtime grants with `policy_key` derived from scope id, subject, node id, and matcher fingerprint — **not** `approval_id + scope`. Keep request idempotency keys separate from persisted `policy_key`.

Verification:

```bash
pnpm vitest packages/worker/src/services/workflow-approvals.test.ts packages/worker/src/routes/workflows.test.ts packages/worker/src/routes/action-invocations.test.ts
```

Expected: double-clicking approval actions creates no duplicate grants/events; equivalent `foreach` body approvals reuse one `policy_key`; distinct matcher fingerprints create distinct grants.

Commit point: `git commit -m "Add scoped approval actions"`

## 6. Update Worker APIs

- [ ] Expand `/api/action-policies` to list/manage admin policies (admins), user durable policies (users), and active runtime grants where useful for audit.
- [ ] Enforce route permissions:
  - admins create/update/revoke admin-managed policies in their org.
  - non-admins create only `managed_by='user'`, `mode='allow'`, `principal_type='user'` durable rows through validated flows.
  - non-admins list/revoke their own durable policies and active runtime grants.
  - non-admins cannot edit `managed_by`, `mode`, `principal_type`, `principal_id`, `org_id`, or target fields after creation.
- [ ] Convert `/api/action-policy-overrides` into a compatibility alias or remove it before release.
- [ ] Update execution APIs to include matched policy/grant metadata on approval rows and node traces.
- [ ] **Approval propagation (backend).** Surface a child session's single approval record up its provenance chain so the user doesn't have to watch child sessions:
  - Compute the provenance chain for an approval: the originating session's `parentSessionId` ancestors (incl. the orchestrator if present) and, if workflow-spawned, the execution via `workflow_spawned_sessions`. Apply the same depth-16 cap + cycle guard used by resolution.
  - Add a pending-approvals endpoint that, for a given context (session, orchestrator session, or workflow execution), returns its own pending approvals **plus** approvals raised in descendant sessions.
  - Keep a single approval record (the `action_invocation` / `workflow_approval` row). Resolving from any context resolves it once — reuse the step-5 idempotency keys; a second resolve from another surface is a no-op.
  - Publish approval lifecycle events (raised / resolved) to each ancestor context's stream via `EventBusDO` so all surfaces update live.
- [ ] **Resolution authorization.** Resolve endpoints check `editor`+ on the **origin** of the approval — the originating session (or workflow execution), not the surface the action was triggered from. Reuse `assertSessionAccess` (and the equivalent workflow check) inside the resolve handler. A user with read access to an ancestor surface but no edit access to the origin gets a 403; the UI relies on this to disable buttons. Test: viewer of orchestrator A → editor of orchestrator A but viewer of child C → editor of C, with only the last two able to resolve C's approval.
- [ ] **Multi-user session scope.** Grant create/revoke endpoints check `editor`+ on the session/execution, not creator equality. Listing returns grants whose scope context the caller has access to, regardless of `userId`. The grant's `userId` is creator/audit only; it is not part of the match.
- [ ] **Denial propagation.** When an `action_invocation` transitions to `denied` (or a workflow approval to `denied`/`expired`) in a descendant context, emit a denial event over the same provenance fan-out — display-only at ancestors, no durable copy. Reuse the same `EventBusDO` channel as pending approvals.

Verification:

```bash
pnpm vitest packages/worker/src/routes/action-policies.test.ts packages/worker/src/routes/action-policy-overrides.test.ts packages/worker/src/routes/workflows.test.ts
```

Expected: the old override-specific API is no longer the primary user-managed policy API; non-admins cannot create admin-managed, deny, or require-approval policies, nor mutate target fields on existing rows; a descendant session's pending approval appears in its ancestor/orchestrator/execution queries and resolves once from any of them.

Commit point: `git commit -m "Expose scoped policies through action policy APIs"`

## 7. Update Client Approval UI

- [ ] Session approval cards: `Approve once`, `Approve for this session`, `Deny` (durable `Approve matching requests` is Phase 2, hidden/disabled for now).
- [ ] Workflow execution approval panes: `Approve once`, `Approve for this run`, `Approve remaining rows` (inside `foreach`), `Deny`.
- [ ] Show matched policy/grant metadata on auto-approved traces.
- [ ] **Approval propagation (client).** Render a propagated child-session approval at each ancestor surface — the parent session, the orchestrator thread, and the workflow execution view — not only in the child. Resolving from any surface clears it from the others live (driven by the EventBus events from step 6). Surface descendant approvals in the global pending-approvals queue.
- [ ] **Resolution authz UI.** A propagated approval card disables its action buttons (with a "approve from [origin]" deep link) when the viewer lacks `editor`+ on the origin. The backend returns 403 if a client bypasses the disabled state.
- [ ] **Denial display.** Render denial events at ancestor surfaces as read-only "Tool blocked by policy" trace entries, linking back to the origin's audit row. No action buttons.
- [ ] Replace the "Action Policy Overrides" settings UI with an action policy + active runtime grant list (revoke supported).

Verification:

```bash
pnpm --filter @valet/client typecheck
pnpm vitest packages/client/src/components/settings/action-policy-overrides-utils.test.ts packages/client/src/components/workflows/workflow-execution-viewer.test.tsx
```

Expected: client compiles and approval actions call the scoped endpoints.

Commit point: `git commit -m "Update approval UI for scoped grants"`

## 8. Phase 1 Cleanup

- [ ] Stop all new writes to `user_action_policy_overrides`.
- [ ] Remove stale route/client names presenting overrides as a separate concept.
- [ ] Verify no `approval_rules` table/schema/route exists.
- [ ] Verify no runtime code path reads `user_action_policy_overrides` for new resolution.

Verification:

```bash
rg -n "approval_rules|approval-rules|upsertUserActionPolicyOverride|resolveUserActionPolicyOverride|user_action_policy_overrides" packages docs
pnpm --filter @valet/worker typecheck
pnpm --filter @valet/client typecheck
```

Expected: only migration/back-compat references to `user_action_policy_overrides` remain; no `approval_rules` implementation exists.

Commit point: `git commit -m "Phase 1 cleanup: single resolver, no overrides"`

---

# Phase 2 — Durable parameter policies

## 9. Implement Parameter Matcher Resolution

- [ ] Add matcher types: `equals`, `oneOf`, `startsWith`, `contains`, `matches`.
- [ ] Path lookup helpers for dot paths and escaped/bracket paths.
- [ ] Validation: missing paths fail closed; type mismatches fail closed; invalid regex rejected on save and fails closed at runtime; secret/redacted values cannot be durable matchers; durable write policies require ≥1 matcher unless action metadata marks read-only safe.
- [ ] Unit tests for each operation and failure mode (must never throw during runtime resolution).

Verification:

```bash
pnpm vitest packages/worker/src/lib/db/actions.test.ts packages/worker/src/services/action-policy.test.ts
```

Commit point: `git commit -m "Add parameter matching engine"`

## 10. Per-Action Canonicalization Metadata

- [ ] Extend action definitions with matcher/canonicalization metadata (which params are stable identifiers, how they canonicalize), starting with Google Workspace and GitHub.
- [ ] Wire canonicalization into resolution before matcher evaluation.
- [ ] Tests: Sheets `spreadsheetId`/`range`, GitHub owner/repo lowercasing, URL `host`/`origin` derivations.

Verification:

```bash
pnpm vitest packages/worker/src/services/actions.test.ts
```

Commit point: `git commit -m "Add per-action matcher canonicalization"`

## 11. Durable Approval Scope + Confirmation Dialog

- [ ] Add `scope='durable_policy'` (requires explicit `paramMatchers`) to approval endpoints; create a user-scoped durable `action_policies` row after matcher validation.
- [ ] Add `Approve matching requests` to session and workflow approval UIs, opening a confirmation dialog from concrete resolved params.
- [ ] Preselect stable identifiers; leave payload/content fields unchecked; block save with no matcher selected unless read-only safe.
- [ ] Disable durable creation for generic workflow approval nodes lacking an approval contract.
- [ ] Tests: durable user policy matches across a manual session and a workflow tool node; durable workflow-node policy rejected without version id; contract-less approval node cannot create durable policy.

Verification:

```bash
pnpm --filter @valet/client typecheck
pnpm vitest packages/worker/src/services/workflow-approvals.test.ts packages/client/src/components/settings/action-policy-overrides-utils.test.ts
```

Commit point: `git commit -m "Add durable parameter policy creation"`

## 12. Native-Tool Interdictor (`session_tool`)

- [ ] Add an interception hook in the session tool path (`services/session-tools.ts`) that catches built-in/native tool calls (`bash`, file edits, etc.) — those with no integration `service`/`actionId` — before execution.
- [ ] Resolve intercepted calls against `action_policies` with `subjectType = 'session_tool'`, subject = native tool name, using the Phase 2 matcher engine on tool args (e.g. regex on `bash` `command`).
- [ ] Apply the resolver outcome: allow → execute; require_approval → raise a session approval; deny → block with a clear tool-result error.
- [ ] Surface `session_tool` policies in the settings/admin policy UI so admins can author built-in restrictions.
- [ ] Tests: a `bash` `session_tool` deny policy with a `matches` matcher blocks matching commands and allows non-matching ones; missing-arg paths fail closed; native calls with no matching policy execute unchanged.

Verification:

```bash
pnpm vitest packages/worker/src/services/session-tools.test.ts packages/worker/src/services/action-policy.test.ts
```

Expected: built-in tool calls resolve through the unified resolver; only matching `session_tool` policies gate them.

Commit point: `git commit -m "Add native-tool interdictor for session_tool policies"`

## 13. Workflow Editor Readiness

- [ ] Approval badges on `approval`, risky `tool`, `foreach` body, `session`, `orchestrator` nodes.
- [ ] Readiness classifications: Covered, Intentional human gate, Will prompt at runtime, Blocked, Unknown.
- [ ] Setup actions: `Pre-approve matching requests`, `Approve matching iterations in each run`, `Keep human approval`, `Run test with sample data`.
- [ ] Warn before enabling scheduled/background triggers when a workflow may stall unattended.
- [ ] Durable policies created only from concrete trigger defaults, manual test payloads, action matcher hints, resolved static params, or workflow approval contracts.

Verification:

```bash
pnpm --filter @valet/client typecheck
pnpm vitest packages/client/src/components/workflows/visual-workflow-editor.test.tsx
```

Commit point: `git commit -m "Add workflow approval readiness"`

## 14. Final Verification

```bash
pnpm typecheck
pnpm test
```

Expected: all typechecks and tests pass.

Final commit point: `git commit -m "Implement parameter-matched action policies"`

---

## Rollout Notes

- Runtime grants are excluded from matching once their session or workflow execution is terminal, and cleaned up on terminal transition (FK cascade on parent deletion is a backstop, not the primary mechanism).
- Audit records retain matched policy/grant ids even after runtime grants expire or are revoked.
- If production contains meaningful `user_action_policy_overrides`, migrate before removing the compatibility route.
- Because workflows are pre-release, workflow-specific old data can fail validation rather than carrying a legacy compatibility layer.
- The orchestrator is an agent session (`orchestrator:{userId}` / `orchestrator:org:{orgId}`), so orchestrator tool approvals resolve through the `session` scope on that well-known id — no separate orchestrator-run scope, table, or terminal hook is needed.
- Approval propagation ships in two parts: Phase 1 delivers in-app surfacing (ancestor sessions, orchestrator thread, execution view, global queue) live via the EventBus and resolve-from-any. Phase 2 adds proactive per-channel push — DM the user on the orchestrator's channel, ping workflow owners — building on the same EventBus events and honoring notification preferences. It reuses existing interactive-prompt/channel-router infrastructure rather than a new delivery path.
