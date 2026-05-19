# Approval Policy Overrides Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add per-user and session-scoped tool approval policy overrides with org-deny precedence, Codex-style approval choices, user settings management, and audit fields.

**Architecture:** Add a separate `user_action_policy_overrides` persistence layer and resolve policy in one worker-side helper that combines explicit org policy, system defaults, and user overrides. SessionAgent creates exact-tool overrides from approval prompts, while user settings expose persistent overrides at action, service, and risk-level scopes. The web approval card renders a Codex-style chooser; Slack and Telegram get the same action IDs where practical.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, Cloudflare D1, Durable Objects, React 19, TanStack Query, Vitest, pnpm.

---

## Source Documents

- Spec: `docs/specs/2026-05-19-approval-policy-overrides-design.md`
- Existing org policy DB helpers: `packages/worker/src/lib/db/actions.ts`
- Existing action policy service: `packages/worker/src/services/action-policy.ts`
- Existing invocation service: `packages/worker/src/services/actions.ts`
- Tool policy entry point: `packages/worker/src/services/session-tools.ts`
- Approval prompt creation/resolution: `packages/worker/src/durable-objects/session-agent.ts`
- Web approval card: `packages/client/src/components/session/interactive-prompt-card.tsx`
- Admin policy UI: `packages/client/src/components/settings/action-policies-section.tsx`
- Admin policy dialog: `packages/client/src/components/settings/action-policy-dialog.tsx`

## File Map

### Worker Data and Policy

- Create `packages/worker/migrations/0013_user_action_policy_overrides.sql`
  - Creates `user_action_policy_overrides`.
  - Adds audit columns to `action_invocations`.
  - Adds partial unique indexes.
- Modify `packages/worker/src/lib/schema/actions.ts`
  - Add `userActionPolicyOverrides` Drizzle table.
  - Add new action invocation audit columns.
- Modify `packages/worker/src/lib/db/actions.ts`
  - Add user override CRUD helpers.
  - Add active override resolver.
  - Add effective policy resolver.
  - Add session override expiry helper.
  - Extend invocation create/update helpers with audit fields.
- Modify `packages/worker/src/services/action-policy.ts`
  - Export effective resolver API or delegate to DB helper.
- Modify `packages/worker/src/services/actions.ts`
  - Use effective policy result when creating invocation rows.
  - Support extra audit fields on invocation creation.
- Modify `packages/worker/src/services/session-tools.ts`
  - Thread `sessionId` and resolver result through action policy resolution.
- Modify `packages/worker/src/lib/db/sessions.ts`
  - Expire session-scoped overrides from `updateSessionStatus` when transitioning to terminal statuses.

### Worker Routes and Shared Types

- Modify `packages/shared/src/types/index.ts`
  - Add `ActionPolicyOverride`, `ActionPolicyLifetime`, `ActionPolicySource`, and new audit fields on `ActionInvocation`.
- Create `packages/worker/src/routes/action-policy-overrides.ts`
  - Non-admin current-user CRUD routes.
- Modify `packages/worker/src/index.ts`
  - Mount `/api/action-policy-overrides`.

### SessionAgent and Channels

- Modify `packages/sdk/src/channels/index.ts`
  - Add optional `description?: string` to `InteractiveAction`.
- Modify `packages/worker/src/durable-objects/session-agent.ts`
  - Create new four-option approval prompt actions.
  - Handle `allow_once`, `allow_session`, `allow_always`, `cancel`.
  - Preserve legacy `approve`/`deny`.
  - Change resolution to claim prompt before deleting.
  - Create exact-tool overrides from prompt choices.
- Modify `packages/plugin-slack/src/channels/transport.ts`
  - Render new button labels/action IDs.
  - Update resolution status text for new action IDs.
- Modify `packages/plugin-telegram/src/channels/transport.ts`
  - Render new inline keyboard choices.
  - Update resolution status text for new action IDs.
- Modify `packages/worker/src/routes/slack-events.ts`
  - Existing pass-through should continue to work; update tests if action labels/status assumptions change.
- Modify `packages/worker/src/routes/channel-webhooks.ts`
  - Existing Telegram pass-through should continue to work; update tests if needed.

### Client

- Create `packages/client/src/api/action-policy-overrides.ts`
  - TanStack Query hooks for current-user override CRUD.
- Create `packages/client/src/components/settings/action-policy-overrides-section.tsx`
  - User settings list and actions.
- Create `packages/client/src/components/settings/action-policy-override-dialog.tsx`
  - Persistent override editor mirroring admin policy dialog.
- Modify `packages/client/src/routes/settings/index.tsx`
  - Add the user override settings section.
- Modify `packages/client/src/components/session/interactive-prompt-card.tsx`
  - Render Codex-style approval options with labels/descriptions.
  - Support `allow_once`, `allow_session`, `allow_always`, `cancel`.
- Modify `packages/client/src/hooks/use-chat.ts`
  - Add WebSocket helpers for arbitrary approval action ID or extend existing approve/deny helpers.

### Tests

- Create `packages/worker/src/lib/db/actions.test.ts`
  - Resolver, override CRUD, audit fields, expiry helper.
- Modify or add route tests under `packages/worker/src/routes/`
  - `action-policy-overrides` route coverage.
- Modify `packages/worker/src/durable-objects/session-agent.test.ts`
  - Approval prompt actions and resolution handling.
- Add or modify client tests if local patterns exist for components. If not, rely on typecheck and focused manual component review.
- Update Slack/Telegram transport tests:
  - `packages/plugin-slack/src/channels/transport.test.ts`
  - `packages/plugin-telegram/src/channels/transport.test.ts`

---

## Task 1: Database Schema and Types

**Files:**
- Create: `packages/worker/migrations/0013_user_action_policy_overrides.sql`
- Modify: `packages/worker/src/lib/schema/actions.ts`
- Modify: `packages/shared/src/types/index.ts`

- [ ] **Step 1: Write the migration**

Create `packages/worker/migrations/0013_user_action_policy_overrides.sql`:

```sql
CREATE TABLE user_action_policy_overrides (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  service TEXT,
  action_id TEXT,
  risk_level TEXT CHECK(risk_level IN ('low','medium','high','critical')),
  mode TEXT NOT NULL CHECK(mode IN ('allow','require_approval','deny')),
  lifetime TEXT NOT NULL DEFAULT 'persistent'
    CHECK(lifetime IN ('persistent','session','timed')),
  session_id TEXT REFERENCES sessions(id) ON DELETE CASCADE,
  expires_at TEXT,
  source TEXT NOT NULL DEFAULT 'settings'
    CHECK(source IN ('settings','approval_prompt')),
  source_invocation_id TEXT REFERENCES action_invocations(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  CHECK(action_id IS NULL OR service IS NOT NULL),
  CHECK(
    (service IS NOT NULL AND action_id IS NOT NULL AND risk_level IS NULL)
    OR (service IS NOT NULL AND action_id IS NULL AND risk_level IS NULL)
    OR (service IS NULL AND action_id IS NULL AND risk_level IS NOT NULL)
  ),
  CHECK(lifetime != 'session' OR session_id IS NOT NULL),
  CHECK(lifetime = 'session' OR session_id IS NULL),
  CHECK(lifetime != 'timed' OR expires_at IS NOT NULL)
);

CREATE INDEX idx_uapo_user ON user_action_policy_overrides(user_id);
CREATE INDEX idx_uapo_session ON user_action_policy_overrides(session_id);
CREATE INDEX idx_uapo_expires ON user_action_policy_overrides(expires_at);

CREATE UNIQUE INDEX idx_uapo_persistent_action
  ON user_action_policy_overrides(user_id, service, action_id)
  WHERE lifetime = 'persistent' AND action_id IS NOT NULL;

CREATE UNIQUE INDEX idx_uapo_persistent_service
  ON user_action_policy_overrides(user_id, service)
  WHERE lifetime = 'persistent' AND action_id IS NULL AND risk_level IS NULL AND service IS NOT NULL;

CREATE UNIQUE INDEX idx_uapo_persistent_risk
  ON user_action_policy_overrides(user_id, risk_level)
  WHERE lifetime = 'persistent' AND service IS NULL AND action_id IS NULL AND risk_level IS NOT NULL;

CREATE UNIQUE INDEX idx_uapo_session_action
  ON user_action_policy_overrides(user_id, session_id, service, action_id)
  WHERE lifetime = 'session' AND action_id IS NOT NULL;

ALTER TABLE action_invocations ADD COLUMN org_policy_id TEXT REFERENCES action_policies(id) ON DELETE SET NULL;
ALTER TABLE action_invocations ADD COLUMN base_mode TEXT;
ALTER TABLE action_invocations ADD COLUMN base_source TEXT;
ALTER TABLE action_invocations ADD COLUMN user_override_id TEXT REFERENCES user_action_policy_overrides(id) ON DELETE SET NULL;
ALTER TABLE action_invocations ADD COLUMN policy_source TEXT;
ALTER TABLE action_invocations ADD COLUMN policy_lifetime TEXT;
ALTER TABLE action_invocations ADD COLUMN policy_scope TEXT;
```

- [ ] **Step 2: Update Drizzle schema**

In `packages/worker/src/lib/schema/actions.ts`:

- Import `integer` only if needed; otherwise keep `text`/`index`.
- Add `userActionPolicyOverrides`.
- Add the new nullable columns to `actionInvocations`.
- Keep `policyId` for compatibility.
- Add comments that partial unique indexes live in SQL migration.

- [ ] **Step 3: Update shared types**

In `packages/shared/src/types/index.ts`, add:

```ts
export type ActionPolicyLifetime = 'persistent' | 'session' | 'timed';
export type ActionPolicySource = 'settings' | 'approval_prompt';
export type EffectivePolicySource = 'system_default' | 'org_policy' | 'user_override' | 'session_override';
export type ActionPolicyScope = 'action' | 'service' | 'risk_level' | 'none';

export interface ActionPolicyOverride {
  id: string;
  userId: string;
  service?: string | null;
  actionId?: string | null;
  riskLevel?: string | null;
  mode: ActionMode;
  lifetime: ActionPolicyLifetime;
  sessionId?: string | null;
  expiresAt?: string | null;
  source: ActionPolicySource;
  sourceInvocationId?: string | null;
  createdAt: string;
  updatedAt: string;
}
```

Extend `ActionInvocation` with optional audit fields:

```ts
orgPolicyId?: string | null;
baseMode?: ActionMode | null;
baseSource?: 'org_policy' | 'system_default' | null;
userOverrideId?: string | null;
policySource?: EffectivePolicySource | null;
policyLifetime?: ActionPolicyLifetime | null;
policyScope?: ActionPolicyScope | null;
```

- [ ] **Step 4: Verify types compile**

Run: `pnpm --filter @valet/worker typecheck`

Expected: Type errors are acceptable only if they point to not-yet-updated DB helpers. Do not proceed if schema/type syntax itself is invalid.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/migrations/0013_user_action_policy_overrides.sql packages/worker/src/lib/schema/actions.ts packages/shared/src/types/index.ts
git commit -m "feat(worker): add action policy override schema"
```

---

## Task 2: DB Helpers and Effective Resolver

**Files:**
- Modify: `packages/worker/src/lib/db/actions.ts`
- Modify: `packages/worker/src/services/action-policy.ts`
- Create/Modify: `packages/worker/src/lib/db/actions.test.ts`

- [ ] **Step 1: Write failing resolver tests**

Create `packages/worker/src/lib/db/actions.test.ts` if no focused file exists. Use the existing Vitest style from worker tests. Tests must cover:

- Org exact deny blocks user exact allow.
- Org service deny blocks user exact allow.
- Org risk deny blocks user service allow.
- Critical system default deny is loosened by user exact allow.
- User exact override beats user service/risk.
- User service override beats user risk.
- Session override only applies to matching session.
- Expired timed override is ignored.
- Persistent user deny tightens org/system allow.
- Base mode/source is returned separately from final mode.

- [ ] **Step 2: Run resolver tests to verify they fail**

Run: `pnpm --filter @valet/worker test -- src/lib/db/actions.test.ts`

Expected: FAIL because override helpers/effective resolver are not implemented.

- [ ] **Step 3: Add DB helper types**

In `packages/worker/src/lib/db/actions.ts`, define:

```ts
export type PolicyScope = 'action' | 'service' | 'risk_level' | 'none';
export type EffectivePolicySource = 'system_default' | 'org_policy' | 'user_override' | 'session_override';

export interface EffectivePolicyResult {
  mode: ActionMode;
  outcome: 'allowed' | 'pending_approval' | 'denied';
  riskLevel: string;
  baseMode: ActionMode;
  baseSource: 'org_policy' | 'system_default';
  orgPolicyId: string | null;
  userOverrideId: string | null;
  source: EffectivePolicySource;
  lifetime: ActionPolicyLifetime | null;
  scope: PolicyScope;
}
```

- [ ] **Step 4: Split explicit org resolution from system default**

Keep current org cascade behavior for admin policies, but expose a helper that distinguishes explicit org matches from system defaults:

```ts
export async function resolveOrgPolicyMatch(
  db: AppDb,
  service: string,
  actionId: string,
  riskLevel: string,
): Promise<{ mode: ActionMode; policyId: string; scope: PolicyScope } | null>
```

Then keep `resolvePolicy()` as compatibility wrapper returning explicit org result or system default.

- [ ] **Step 5: Add user override CRUD helpers**

Add helpers:

```ts
export async function listUserActionPolicyOverrides(db: AppDb, userId: string)
export async function getUserActionPolicyOverride(db: AppDb, id: string)
export async function upsertUserActionPolicyOverride(db: AppDb, data: ...)
export async function deleteUserActionPolicyOverride(db: AppDb, id: string, userId: string)
export async function expireSessionActionPolicyOverrides(db: AppDb, sessionId: string, now?: string)
```

`upsertUserActionPolicyOverride` should reuse an existing row for the same scope/lifetime/session to avoid partial index conflicts, matching `upsertActionPolicy`.

- [ ] **Step 6: Add active user override resolver**

Implement:

```ts
export async function resolveUserActionPolicyOverride(
  db: AppDb,
  input: { userId: string; sessionId?: string; service: string; actionId: string; riskLevel: string },
): Promise<{ override: ActionPolicyOverrideRow; scope: PolicyScope } | null>
```

Query only rows for the user where:

- persistent rows are active,
- session rows match `sessionId`,
- timed rows have `expiresAt > now`.

Prefer exact action, then service, then risk level. For same specificity, prefer session/timed over persistent, then newest `updatedAt`.

- [ ] **Step 7: Add effective resolver**

Implement:

```ts
export async function resolveEffectiveActionPolicy(
  db: AppDb,
  input: { userId: string; sessionId: string; service: string; actionId: string; riskLevel: string },
): Promise<EffectivePolicyResult>
```

Rules:

- explicit org `deny` returns denied and ignores user override.
- explicit org `allow`/`require_approval` becomes base mode.
- no explicit org match uses system default as base mode.
- active user override replaces base mode.
- `outcome` maps `allow` to `allowed`, `require_approval` to `pending_approval`, `deny` to `denied`.

- [ ] **Step 8: Extend invocation creation**

Update `createInvocation` input to accept:

```ts
orgPolicyId?: string | null;
baseMode?: ActionMode | null;
baseSource?: 'org_policy' | 'system_default' | null;
userOverrideId?: string | null;
policySource?: EffectivePolicySource | null;
policyLifetime?: ActionPolicyLifetime | null;
policyScope?: PolicyScope | null;
```

Write the new columns when present. Keep writing `policyId` as the org policy ID for compatibility.

- [ ] **Step 9: Run resolver tests**

Run: `pnpm --filter @valet/worker test -- src/lib/db/actions.test.ts`

Expected: PASS.

- [ ] **Step 10: Run worker typecheck**

Run: `pnpm --filter @valet/worker typecheck`

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/worker/src/lib/db/actions.ts packages/worker/src/services/action-policy.ts packages/worker/src/lib/db/actions.test.ts
git commit -m "feat(worker): resolve user action policy overrides"
```

---

## Task 3: Invocation Service and Session Tool Policy Integration

**Files:**
- Modify: `packages/worker/src/services/actions.ts`
- Modify: `packages/worker/src/services/session-tools.ts`
- Modify tests from Task 2 if needed.

- [ ] **Step 1: Write failing integration tests**

Add tests that exercise `invokeAction` or the policy path around it:

- auto-allowed call from user override creates invocation with `resolvedMode='allow'`, `baseMode='require_approval'`, `policySource='user_override'`.
- org explicit deny creates denied invocation even when user allow exists.
- session override records `policySource='session_override'` and `policyLifetime='session'`.

- [ ] **Step 2: Run tests to verify failure**

Run: `pnpm --filter @valet/worker test -- src/lib/db/actions.test.ts`

Expected: FAIL on missing integration behavior.

- [ ] **Step 3: Update `invokeAction`**

In `packages/worker/src/services/actions.ts`:

- Replace `resolveMode()` call with `resolveEffectiveActionPolicy()`.
- Include `sessionId` and `userId`.
- Store `baseMode`, `baseSource`, `orgPolicyId`, `userOverrideId`, `policySource`, `policyLifetime`, `policyScope`.
- Set `resolvedMode` to final effective mode.
- Keep approval expiry only when final mode is `require_approval`.

- [ ] **Step 4: Update `PolicyResult` shape**

In `packages/worker/src/services/session-tools.ts`:

- Include effective policy audit fields only if caller needs them.
- Ensure `resolveActionPolicy()` still returns `outcome`, `invocationId`, `riskLevel`, `service`, `actionId`, `actionSource`.

- [ ] **Step 5: Run tests**

Run: `pnpm --filter @valet/worker test -- src/lib/db/actions.test.ts`

Expected: PASS.

- [ ] **Step 6: Run worker typecheck**

Run: `pnpm --filter @valet/worker typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/services/actions.ts packages/worker/src/services/session-tools.ts packages/worker/src/lib/db/actions.test.ts
git commit -m "feat(worker): apply effective action policy resolution"
```

---

## Task 4: User Override API Routes

**Files:**
- Create: `packages/worker/src/routes/action-policy-overrides.ts`
- Modify: `packages/worker/src/index.ts`
- Test: route test file under `packages/worker/src/routes/`

- [ ] **Step 1: Write failing route tests**

Create or extend a route test to cover:

- `GET /api/action-policy-overrides` returns only current user's rows.
- `PUT /api/action-policy-overrides/:id` creates action, service, and risk-level persistent rows.
- Invalid target combinations return 400.
- `actionId` without `service` returns 400.
- Deleting another user's override returns 404 or 403.
- Exact-action allow rejected when explicit org policy denies it.
- Exact-action allow accepted when only system default denies it.

- [ ] **Step 2: Run route tests to verify failure**

Run: `pnpm --filter @valet/worker test -- src/routes/action-policy-overrides.test.ts`

Expected: FAIL because route does not exist.

- [ ] **Step 3: Implement router**

Create `packages/worker/src/routes/action-policy-overrides.ts`.

Validation:

- Accept `service?: string | null`, `actionId?: string | null`, `riskLevel?: string | null`, `mode`.
- Force `lifetime='persistent'` for this settings route.
- `mode` in `allow | require_approval | deny`.
- target exactly one of action/service/risk.

For exact-action allow validation:

- If risk can be resolved from action catalog/cache cheaply, use it.
- If risk cannot be resolved, allow save and rely on execution-time hard ceiling.
- If explicit org policy match is deny, reject with `ValidationError`.

- [ ] **Step 4: Mount route**

In `packages/worker/src/index.ts`:

```ts
import { actionPolicyOverridesRouter } from './routes/action-policy-overrides.js';
app.route('/api/action-policy-overrides', actionPolicyOverridesRouter);
```

- [ ] **Step 5: Run route tests**

Run: `pnpm --filter @valet/worker test -- src/routes/action-policy-overrides.test.ts`

Expected: PASS.

- [ ] **Step 6: Run worker typecheck**

Run: `pnpm --filter @valet/worker typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/routes/action-policy-overrides.ts packages/worker/src/index.ts packages/worker/src/routes/action-policy-overrides.test.ts
git commit -m "feat(worker): add user action policy override routes"
```

---

## Task 5: Session Override Expiry on Terminal Status

**Files:**
- Modify: `packages/worker/src/lib/db/sessions.ts`
- Modify: `packages/worker/src/lib/db/actions.ts`
- Test: `packages/worker/src/lib/db/actions.test.ts` or session DB tests.

- [ ] **Step 1: Write failing expiry test**

Test that when `updateSessionStatus(db, sessionId, 'terminated')` runs:

- active session override for that session gets `expiresAt <= now`.
- persistent override is unchanged.
- session override for a different session is unchanged.
- `hibernated` does not expire overrides.

- [ ] **Step 2: Run test to verify failure**

Run: `pnpm --filter @valet/worker test -- src/lib/db/actions.test.ts`

Expected: FAIL because `updateSessionStatus` does not expire overrides.

- [ ] **Step 3: Implement expiry helper**

In `packages/worker/src/lib/db/actions.ts`:

```ts
export async function expireSessionActionPolicyOverrides(db: AppDb, sessionId: string, now = new Date().toISOString()): Promise<void>
```

Update active session rows for `sessionId` where `expiresAt IS NULL OR expiresAt > now`.

- [ ] **Step 4: Wire into `updateSessionStatus`**

In `packages/worker/src/lib/db/sessions.ts`:

- Import `TERMINAL_SESSION_STATUSES` from `@valet/shared`.
- Import or call `expireSessionActionPolicyOverrides`.
- After updating session status, if new status is terminal, expire session overrides.

Avoid circular imports. If importing from `db/actions.ts` causes a cycle, move the helper to a small local SQL helper or call `db.update(userActionPolicyOverrides)` directly in `sessions.ts`.

- [ ] **Step 5: Run expiry test**

Run: `pnpm --filter @valet/worker test -- src/lib/db/actions.test.ts`

Expected: PASS.

- [ ] **Step 6: Run worker typecheck**

Run: `pnpm --filter @valet/worker typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/lib/db/actions.ts packages/worker/src/lib/db/sessions.ts packages/worker/src/lib/db/actions.test.ts
git commit -m "feat(worker): expire session action policy overrides"
```

---

## Task 6: SessionAgent Approval Prompt Actions and Resolution

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts`
- Modify: `packages/worker/src/durable-objects/session-agent.test.ts`

- [ ] **Step 1: Write failing prompt construction test**

In `session-agent.test.ts`, add or adapt a test that asserts approval prompts contain:

- `allow_once`, label `Allow`, description present.
- `allow_session`, label `Allow for Session`, description present.
- `allow_always`, label `Always Allow`, description present.
- `cancel`, label `Cancel`, description present, danger style optional.

- [ ] **Step 2: Write failing resolution tests**

Cover:

- `allow_once` approves and executes without creating override.
- `allow_session` creates session exact-action override then executes.
- `allow_always` creates persistent exact-action override then executes.
- `cancel` stores invocation as `denied`, sends cancellation error, does not execute.
- legacy `approve` and `deny` still work.
- failed override write restores prompt to pending and does not execute.

- [ ] **Step 3: Run tests to verify failure**

Run: `pnpm --filter @valet/worker test -- src/durable-objects/session-agent.test.ts`

Expected: FAIL on missing new action IDs/resolution behavior.

- [ ] **Step 4: Update prompt construction**

In `handleCallTool` pending approval branch:

- Replace current actions with:

```ts
[
  { id: 'allow_once', label: 'Allow', description: 'Run the tool once and continue.', style: 'primary' },
  { id: 'allow_session', label: 'Allow for Session', description: 'Run the tool and remember this choice for this session.' },
  { id: 'allow_always', label: 'Always Allow', description: 'Run the tool and remember this choice for future tool calls.' },
  { id: 'cancel', label: 'Cancel', description: 'Cancel this tool call.', style: 'danger' },
]
```

Ensure both local `interactive_prompts.actions` JSON and broadcast `prompt.actions` use the same list.

- [ ] **Step 5: Implement claim-before-delete resolution**

In `handlePromptResolved`:

- Read row where `status='pending'`.
- Update to `status='resolving'` guarded by `WHERE id=? AND status='pending'`.
- If update affects no row, return.
- Do not delete until D1 writes and execution decision succeed.
- On recoverable override-write failure, set status back to `pending` and broadcast a user-visible error.

If Durable Object SQL result API does not expose row count, re-read row after update or use a status token in context to detect ownership.

- [ ] **Step 6: Add action ID mapping**

Normalize:

```ts
const resolutionAction = {
  approve: 'allow_once',
  deny: 'cancel',
  allow_once: 'allow_once',
  allow_session: 'allow_session',
  allow_always: 'allow_always',
  cancel: 'cancel',
}[resolution.actionId ?? ''];
```

Reject unknown action IDs by restoring pending status and sending an error.

- [ ] **Step 7: Create overrides from prompt choices**

For `allow_session` and `allow_always`:

- Re-resolve explicit org policy for prompt tool.
- If explicit org deny, restore pending or cancel with clear error; do not execute.
- Upsert user override with exact `service + actionId`.
- Use `source='approval_prompt'` and `sourceInvocationId=invocationId`. Today the approval prompt ID is the invocation ID; keep that invariant explicit in the code.

- [ ] **Step 8: Execute or cancel**

- `allow_once`, `allow_session`, `allow_always`: approve invocation and call `executeActionAndSend`.
- `cancel`: call `denyInvocation`, send cancellation error.
- Delete local prompt only after successful D1 status update.
- Broadcast `interactive_prompt_resolved`.
- Update channel prompts with selected action label.

- [ ] **Step 9: Run SessionAgent tests**

Run: `pnpm --filter @valet/worker test -- src/durable-objects/session-agent.test.ts`

Expected: PASS.

- [ ] **Step 10: Run worker typecheck**

Run: `pnpm --filter @valet/worker typecheck`

Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts packages/worker/src/durable-objects/session-agent.test.ts
git commit -m "feat(worker): add approval override prompt actions"
```

---

## Task 7: SDK and Channel Transport Updates

**Files:**
- Modify: `packages/sdk/src/channels/index.ts`
- Modify: `packages/plugin-slack/src/channels/transport.ts`
- Modify: `packages/plugin-slack/src/channels/transport.test.ts`
- Modify: `packages/plugin-telegram/src/channels/transport.ts`
- Modify: `packages/plugin-telegram/src/channels/transport.test.ts`

- [ ] **Step 1: Write failing transport tests**

Update existing Slack/Telegram interactive prompt tests to assert:

- Four actions render for approval prompts.
- New action IDs are passed through unchanged.
- Resolution display handles `allow_once`, `allow_session`, `allow_always`, and `cancel`.

- [ ] **Step 2: Run transport tests to verify failure**

Run:

```bash
pnpm test -- packages/plugin-slack/src/channels/transport.test.ts packages/plugin-telegram/src/channels/transport.test.ts
```

Expected: FAIL on old labels/status handling.

- [ ] **Step 3: Add SDK field**

In `packages/sdk/src/channels/index.ts`, add optional `description?: string` to `InteractiveAction`.

- [ ] **Step 4: Update Slack rendering**

In `packages/plugin-slack/src/channels/transport.ts`:

- Buttons can stay label-only.
- Preserve action IDs from prompt.
- For `updateInteractivePrompt`, map:
  - `allow_once` -> `Allowed once by ...`
  - `allow_session` -> `Allowed for session by ...`
  - `allow_always` -> `Always allowed by ...`
  - `cancel` -> `Cancelled by ...`
  - legacy `approve`/`deny` unchanged.

- [ ] **Step 5: Update Telegram rendering**

In `packages/plugin-telegram/src/channels/transport.ts`:

- Preserve action IDs in callback data.
- Map statuses similarly to Slack.
- Keep callback data under Telegram limits. Approval prompt IDs are UUIDs, so `allow_session|uuid` is within 64 bytes.

- [ ] **Step 6: Run transport tests**

Run:

```bash
pnpm test -- packages/plugin-slack/src/channels/transport.test.ts packages/plugin-telegram/src/channels/transport.test.ts
```

Expected: PASS.

- [ ] **Step 7: Run SDK and plugin typechecks**

Run:

```bash
pnpm --filter @valet/sdk typecheck
pnpm --filter @valet/plugin-slack typecheck
pnpm --filter @valet/plugin-telegram typecheck
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add packages/sdk/src/channels/index.ts packages/plugin-slack/src/channels/transport.ts packages/plugin-slack/src/channels/transport.test.ts packages/plugin-telegram/src/channels/transport.ts packages/plugin-telegram/src/channels/transport.test.ts
git commit -m "feat(channels): support approval override choices"
```

---

## Task 8: Web Approval Chooser

**Files:**
- Modify: `packages/client/src/components/session/interactive-prompt-card.tsx`
- Modify: `packages/client/src/hooks/use-chat.ts`
- Modify: `packages/client/src/components/chat/chat-container.tsx` if prop names change.

- [ ] **Step 1: Write or update component test if feasible**

If a local component test pattern exists, add a test that renders an approval prompt and verifies:

- labels and descriptions render.
- default focus/selection is `Allow`.
- Escape triggers `cancel`.

If there is no suitable test harness, record this as manual UI verification and rely on typecheck.

- [ ] **Step 2: Update WebSocket helper**

In `use-chat.ts`, replace or extend `approveActionWs`/`denyActionWs` with:

```ts
resolveApprovalWs: (invocationId: string, actionId: string) => {
  send({ type: actionId === 'cancel' ? 'deny-action' : 'approve-action', invocationId, actionId } as any);
}
```

Better: add a new client message type in SessionAgent handling for generic approval resolution, e.g. `resolve-action`, and keep legacy helpers intact.

- [ ] **Step 3: Update SessionAgent WebSocket message handling**

If using a generic message type, update `ClientInbound` and message switch in `session-agent.ts` to call `handlePromptResolved(invocationId, { actionId, resolvedBy })`.

Keep `approve-action`/`deny-action` for backward compatibility.

- [ ] **Step 4: Update approval card rendering**

In `interactive-prompt-card.tsx`:

- For approval prompts, render actions as a vertical or compact list with label + description.
- Use stable dimensions and text wrapping.
- Default focus/select `allow_once`.
- Enter submits selected action.
- Escape submits `cancel`.
- Continue to render non-approval questions as today.

- [ ] **Step 5: Run client typecheck**

Run: `pnpm --filter @valet/client typecheck`

Expected: PASS.

- [ ] **Step 6: Run worker typecheck if SessionAgent message types changed**

Run: `pnpm --filter @valet/worker typecheck`

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/components/session/interactive-prompt-card.tsx packages/client/src/hooks/use-chat.ts packages/client/src/components/chat/chat-container.tsx packages/worker/src/durable-objects/session-agent.ts
git commit -m "feat(client): render approval override chooser"
```

---

## Task 9: User Settings Management UI

**Files:**
- Create: `packages/client/src/api/action-policy-overrides.ts`
- Create: `packages/client/src/components/settings/action-policy-overrides-section.tsx`
- Create: `packages/client/src/components/settings/action-policy-override-dialog.tsx`
- Modify: `packages/client/src/routes/settings/index.tsx`
- Reuse: `packages/client/src/api/action-catalog.ts`

- [ ] **Step 1: Add API hooks**

Create hooks:

```ts
export const actionPolicyOverrideKeys = {
  all: ['action-policy-overrides'] as const,
  list: () => [...actionPolicyOverrideKeys.all, 'list'] as const,
};

export function useActionPolicyOverrides()
export function useUpsertActionPolicyOverride()
export function useDeleteActionPolicyOverride()
```

Use `/action-policy-overrides` API paths.

- [ ] **Step 2: Build dialog by adapting admin policy dialog**

Create `action-policy-override-dialog.tsx` from `action-policy-dialog.tsx` patterns:

- Scope selector: Action, Integration, Risk Level.
- Mode selector: Allow, Ask, Deny.
- Use `useActionCatalog()` for action/service options.
- Persistent lifetime only in the form.
- On save, send `{ id, service, actionId, riskLevel, mode }`.

Avoid nesting cards inside cards. Keep it consistent with existing settings UI.

- [ ] **Step 3: Build section**

Create `action-policy-overrides-section.tsx`:

- List current user's overrides.
- Columns: Scope, Target, Mode, Lifetime, Actions.
- Show session overrides with a `Session` badge and allow delete.
- `Add Override` button opens dialog.
- Edit only persistent overrides. Session overrides can be removed but not edited in MVP.
- Add concise copy: org deny policies still apply.

- [ ] **Step 4: Mount in settings**

In `packages/client/src/routes/settings/index.tsx`, add the section near Session/Model Preferences or after Integrations-related account settings.

- [ ] **Step 5: Run client typecheck**

Run: `pnpm --filter @valet/client typecheck`

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/client/src/api/action-policy-overrides.ts packages/client/src/components/settings/action-policy-overrides-section.tsx packages/client/src/components/settings/action-policy-override-dialog.tsx packages/client/src/routes/settings/index.tsx
git commit -m "feat(client): add user action policy override settings"
```

---

## Task 10: Final Verification and Spec Update

**Files:**
- Modify if needed: `docs/specs/2026-05-19-approval-policy-overrides-design.md`
- Modify if needed: `docs/specs/sessions.md` or `docs/specs/integrations.md` only if implementation changes subsystem contracts beyond the design spec.

- [ ] **Step 1: Run targeted worker tests**

Run:

```bash
pnpm --filter @valet/worker test -- src/lib/db/actions.test.ts src/routes/action-policy-overrides.test.ts src/durable-objects/session-agent.test.ts
```

Expected: PASS.

- [ ] **Step 2: Run channel tests**

Run:

```bash
pnpm test -- packages/plugin-slack/src/channels/transport.test.ts packages/plugin-telegram/src/channels/transport.test.ts
```

Expected: PASS.

- [ ] **Step 3: Run typechecks**

Run:

```bash
pnpm --filter @valet/sdk typecheck
pnpm --filter @valet/worker typecheck
pnpm --filter @valet/client typecheck
pnpm typecheck
```

Expected: PASS.

- [ ] **Step 4: Run full test suite if targeted checks are clean**

Run: `pnpm test`

Expected: PASS.

- [ ] **Step 5: Review final diff**

Run:

```bash
git status --short
git diff --check
git log --oneline -n 12
```

Expected:

- No whitespace errors.
- Only intended files changed.
- Commits are task-sized.

- [ ] **Step 6: Update Linear**

Add a Linear comment to `TKAI-64` summarizing:

- user override settings scopes,
- approval chooser behavior,
- org-deny hard ceiling,
- verification commands run.

- [ ] **Step 7: Final commit if docs changed**

```bash
git add docs/specs/2026-05-19-approval-policy-overrides-design.md docs/specs/sessions.md docs/specs/integrations.md
git commit -m "docs: update approval override implementation notes"
```
