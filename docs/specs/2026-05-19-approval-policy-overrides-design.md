# Per-User Tool Approval Policy Overrides

**Status:** Draft
**Author:** Conner Swann
**Date:** 2026-05-19
**Linear:** TKAI-64

## Problem

Tool approval policies are currently org-level only. Users cannot customize which integration tools should auto-run, ask for confirmation, or be blocked in their own sessions.

This blocks unattended automations. A concrete example is a Gmail follow-up automation that creates draft replies overnight. Draft creation is medium risk, so it currently requires manual approval every time. That defeats the point of an overnight workflow.

## Goals

- Let users define personal approval overrides for integration tools.
- Keep organization deny policy as the hard safety ceiling.
- Support persistent user overrides from user settings.
- Support session-scoped allow shortcuts from the session approval UI.
- Make the approval UI match the Codex chooser pattern: allow once, allow for session, always allow, cancel.
- Preserve auditability of how each tool invocation was resolved.

## Non-Goals

- Arbitrary duration UI for timed overrides in the first pass. The schema should support explicit expiry, but the MVP only needs persistent and session-scoped overrides.
- Admin approval routing, delegated approvers, or policy-specific approver lists.
- Broad override creation from the approval card. Approval-card shortcuts are exact-tool only.
- Changing disabled action/plugin behavior. Disabled actions and disabled plugins still fail before policy resolution.
- Reworking workflow approval gates. This spec covers integration tool approvals through `call_tool`.

## Current State

The existing action policy model has two tables:

- `action_policies`: org-level policy rows with `service`, `actionId`, optional `riskLevel`, and `mode`.
- `action_invocations`: one row per attempted tool call, including pending approvals and executed auto-allowed calls.

Org policy resolution currently uses this cascade:

1. Exact action: `service + actionId`
2. Integration/service: `service`
3. Risk level: `riskLevel`
4. System defaults: low allow, medium/high require approval, critical deny

When the resolved mode is `require_approval`, `SessionAgentDO` stores an `interactive_prompts` row and broadcasts an approval prompt. The web UI currently renders a simple approval card with Approve and Deny actions.

## Decision Summary

- Organization/system `deny` is a hard ceiling. User overrides cannot loosen it.
- User settings can create persistent overrides at the same scopes as org policies: exact action, service, or risk level.
- Approval-card shortcuts create exact-tool overrides only.
- `Allow for Session` expires when the session reaches a terminal state: `terminated`, `archived`, or `error`.
- Hibernation/restore does not clear session overrides because the logical session is unchanged.
- The first implementation exposes persistent and session lifetimes. The data model includes `expiresAt` for future timed overrides.

## Data Model

Add a new D1 table for user-owned overrides instead of extending `action_policies`. Keeping the table separate makes precedence, ownership, and admin/user UI boundaries explicit.

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
```

Partial unique indexes should mirror the existing org policy uniqueness pattern, scoped by `user_id`, `lifetime`, and `session_id` where applicable:

```sql
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
```

Session-scoped overrides created from approval prompts are exact-action only. A future settings UI can add session or timed rows at broader scopes, but the MVP does not expose that.

### Invocation Audit Fields

Extend `action_invocations` so each invocation records both the org/system result and any user override that affected it.

```sql
ALTER TABLE action_invocations ADD COLUMN org_policy_id TEXT REFERENCES action_policies(id) ON DELETE SET NULL;
ALTER TABLE action_invocations ADD COLUMN user_override_id TEXT REFERENCES user_action_policy_overrides(id) ON DELETE SET NULL;
ALTER TABLE action_invocations ADD COLUMN policy_source TEXT;
ALTER TABLE action_invocations ADD COLUMN policy_lifetime TEXT;
ALTER TABLE action_invocations ADD COLUMN policy_scope TEXT;
```

`policy_source` values:

- `system_default`
- `org_policy`
- `user_override`
- `session_override`

`policy_scope` values:

- `action`
- `service`
- `risk_level`
- `none`

The existing `policy_id` column can be retained for compatibility and treated as the org policy ID. New code should prefer `org_policy_id` for clarity; if both exist during the transition, write both to the same org policy value.

## Effective Policy Resolution

Policy resolution should happen in one helper with a clear return type, not as scattered conditionals across `services/actions.ts` and `services/session-tools.ts`.

```ts
type EffectivePolicy = {
  mode: ActionMode;
  outcome: 'allowed' | 'pending_approval' | 'denied';
  riskLevel: string;
  orgMode: ActionMode;
  orgPolicyId: string | null;
  userOverrideId: string | null;
  source: 'system_default' | 'org_policy' | 'user_override' | 'session_override';
  lifetime: 'persistent' | 'session' | 'timed' | null;
  scope: 'action' | 'service' | 'risk_level' | 'none';
};
```

Resolution order:

1. Validate the tool exists and is not disabled by org disabled action/plugin controls.
2. Resolve the tool risk level.
3. Resolve the org/system mode using the existing org cascade.
4. If the org/system mode is `deny`, return denied immediately. User overrides are ignored.
5. Resolve active user overrides for the current `userId`, `sessionId`, `service`, `actionId`, and `riskLevel`.
6. If a user override matches, use it as the effective mode.
7. If no user override matches, use the org/system mode.

Active override filtering:

- `persistent`: no expiry required.
- `session`: `sessionId` must match the current session and the session must not be terminal.
- `timed`: `expiresAt > now`.
- Any override with `expiresAt <= now` is inactive.

User override cascade:

1. Exact action: `service + actionId`
2. Integration/service: `service`
3. Risk level: `riskLevel`

If two active rows have the same specificity, prefer session/timed rows over persistent rows, then the most recently updated row. Unique indexes should make this rare, but the resolver should still be deterministic.

### Examples

| Org/system result | User override | Effective result |
|---|---|---|
| `deny` exact action | `allow` exact action | `deny` |
| `require_approval` exact action | `allow` service | `allow` |
| `allow` service | `deny` exact action | `deny` |
| `allow` risk level | `require_approval` service | `require_approval` |
| critical system default `deny` | `allow` exact action | `deny` |
| medium system default `require_approval` | `allow` risk level | `allow` |

## User Settings

Add a user-facing section in normal Settings, not Admin Settings. It should feel parallel to the admin Action Policies UI, but it is scoped to the current user.

The settings UI supports three scopes:

- Tool/action: `service + actionId`
- Integration/service: `service`
- Risk level: `low`, `medium`, `high`, `critical`

It supports three modes:

- Allow
- Ask
- Deny

MVP settings overrides are persistent. Session-scoped rows created from approval prompts should be visible enough that users can understand why a tool is auto-running in a session, but persistent settings management is the primary UI. At minimum, the UI should list session overrides in the table with a `Session` lifetime label and allow deleting them.

The UI should communicate that organization deny policies still apply. A broad user allow, such as "Allow all Gmail tools", does not bypass exact org-denied Gmail tools.

### API

Add non-admin routes for the current user:

| Method | Path | Purpose |
|---|---|---|
| `GET` | `/api/action-policy-overrides` | List current user's overrides |
| `PUT` | `/api/action-policy-overrides/:id` | Upsert a persistent settings override |
| `DELETE` | `/api/action-policy-overrides/:id` | Delete current user's override |

Validation mirrors admin action policy validation:

- Mode must be `allow`, `require_approval`, or `deny`.
- Risk level must be valid when present.
- Target must be exactly one of action, service, or risk level.
- `actionId` requires `service`.
- A user can only read, update, or delete their own overrides.

For exact-action `allow` overrides, if the service/action/risk can be resolved and org/system policy is already `deny`, the API should reject the save with a clear validation error. For broad service or risk-level overrides, saving is allowed with the understanding that org-denied matching actions remain denied at execution time.

## Approval UI

The session approval UI should follow the Codex chooser model rather than a flat Approve/Deny-only pair.

For a pending tool call, show:

- The tool ID, risk level, and expiration countdown.
- The model-provided summary.
- Expandable parameters, as today.
- A compact list of mutually exclusive choices, each with a short description.

Choices:

| Action ID | Label | Description | Effect |
|---|---|---|---|
| `allow_once` | Allow | Run the tool once and continue. | Approve and execute this invocation only. |
| `allow_session` | Allow for Session | Run the tool and remember this choice for this session. | Create session-scoped exact-action allow override, then execute. |
| `allow_always` | Always Allow | Run the tool and remember this choice for future tool calls. | Create persistent exact-action allow override, then execute. |
| `cancel` | Cancel | Cancel this tool call. | Deny/cancel this invocation without creating an override. |

Keyboard behavior:

- Default focus on `Allow`.
- Arrow keys or equivalent navigation between options where practical.
- Enter submits the selected option.
- Escape cancels.

Backend/internal names can keep approve/deny terminology where that avoids churn. User-facing labels should use Allow and Cancel.

### Interactive Prompt Type

Extend the SDK `InteractiveAction` type with an optional description so the web UI can render Codex-style explanatory copy.

```ts
export interface InteractiveAction {
  id: string;
  label: string;
  description?: string;
  style?: 'primary' | 'danger';
}
```

Channel transports can ignore `description` if the channel's native interactive surface only supports button labels.

## Approval Resolution Flow

`SessionAgentDO.handlePromptResolved` should handle both old and new action IDs during deploy rollout.

New action handling:

- `allow_once`: approve and execute the current invocation.
- `allow_session`: create a session-scoped exact-action allow override, then approve and execute.
- `allow_always`: create or update a persistent exact-action allow override, then approve and execute.
- `cancel`: mark the invocation as denied/cancelled and send a cancellation error to the runner.

Legacy action handling:

- `approve`: same as `allow_once`.
- `deny`: same as `cancel`.

Override creation must be ownership-checked and idempotent:

- The pending prompt must belong to the session owner.
- The invocation must still be pending.
- The org/system effective result must not be `deny` at the time the override is created.
- If creating the override fails, do not execute the tool.
- If the prompt was already resolved, the second resolution is ignored.

For `allow_session`, insert or update:

- `userId`: session owner
- `service`: prompt context service
- `actionId`: prompt context action ID
- `mode`: `allow`
- `lifetime`: `session`
- `sessionId`: current session ID
- `source`: `approval_prompt`
- `sourceInvocationId`: current invocation ID

For `allow_always`, insert or update:

- `userId`: session owner
- `service`: prompt context service
- `actionId`: prompt context action ID
- `mode`: `allow`
- `lifetime`: `persistent`
- `source`: `approval_prompt`
- `sourceInvocationId`: current invocation ID

## Session Lifetime

Session-scoped overrides expire when the session reaches a terminal state:

- `terminated`
- `archived`
- `error`

On terminal transition, the session lifecycle path should set `expiresAt = now` for active session overrides tied to that session. This is not required for runtime safety, because terminal sessions do not run new tool calls, but it keeps user settings and audit displays accurate.

Hibernation and restore do not expire session overrides. The logical session ID is unchanged, so the override remains active.

## Channel Behavior

Slack and Telegram should preserve the same four semantic choices where practical:

- Allow
- Allow for Session
- Always Allow
- Cancel

Slack can render four buttons in the actions block. Telegram inline keyboards can render the four choices as separate buttons, subject to callback data length limits. Both routes already pass arbitrary action IDs through to `prompt-resolved`, so the main requirement is updating prompt construction and message update display.

If a channel cannot support the complete chooser cleanly, the web session UI is the complete management surface. Channel update messages should display the selected label, such as "Allow for Session selected by Conner".

## Security and Privacy

- User overrides are per-user only. They never affect other users in the org.
- User overrides never bypass org/system `deny`.
- All override management routes require authentication.
- The DO prompt resolution path must continue to enforce session ownership.
- Broad user allows may be saved without exposing the full org policy graph; blocked actions still fail at execution time due to the hard ceiling.
- Audit fields should make it possible to explain why a tool ran without prompting.

## Backward Compatibility

Pending prompts created before deploy may still contain `approve` and `deny` actions. The resolver should support those legacy IDs until all in-flight prompts have expired.

Existing `action_policies` behavior remains unchanged for org settings. Existing `action_invocations.policyId` can continue to be populated while new audit fields are introduced.

Existing channel transports can ignore `InteractiveAction.description` because it is optional.

## Testing

### Policy Resolver Unit Tests

- Org exact `deny` blocks user exact `allow`.
- Org service `deny` blocks user exact `allow`.
- Org risk `deny` blocks user service `allow`.
- Critical system default `deny` blocks user exact `allow`.
- User exact override beats user service and risk overrides.
- User service override beats user risk override.
- Session override is active only for matching session ID.
- Expired timed override is ignored.
- Persistent user `deny` tightens org/system `allow`.
- User `allow` loosens org/system `require_approval`.

### Route Tests

- Current user can list only their own overrides.
- Current user can create action, service, and risk-level overrides.
- Invalid scope combinations are rejected.
- `actionId` without `service` is rejected.
- User cannot update or delete another user's override.
- Exact-action allow rejected when resolved org/system policy is deny.

### SessionAgent Tests

- New approval prompt contains `allow_once`, `allow_session`, `allow_always`, and `cancel`.
- `allow_once` executes once and creates no override.
- `allow_session` creates a session exact-action override and executes.
- `allow_always` creates a persistent exact-action override and executes.
- `cancel` does not execute and creates no override.
- Legacy `approve` and `deny` still work for old pending prompts.
- Failed override creation does not execute the tool.

### UI Tests

- Approval card renders Codex-style options with labels and descriptions.
- Default selection/focus is `Allow`.
- Escape cancels.
- User settings table renders persistent and session overrides.
- User settings dialog supports action, service, and risk-level scopes.

## Rollout

1. Add migration and Drizzle/shared types.
2. Add DB helpers and resolver tests.
3. Update action invocation creation to record org/system and user override audit fields.
4. Add user override API routes.
5. Update SessionAgent approval prompt creation and resolution.
6. Update web approval UI to Codex-style chooser.
7. Update Slack/Telegram prompt rendering for the new action IDs.
8. Add user settings management UI.
9. Run worker/client typechecks and targeted tests.
