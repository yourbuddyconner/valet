# Trigger Ownership Model — Design Spec

**Date:** 2026-07-01
**Status:** Draft

## Problem

Valet has two overlapping "trigger" concepts:

1. **Trigger node** — the entry point of a workflow's DAG. Lives in `workflow_versions.definition`, declares the incoming payload's `dataSchema`. Purely definitional.
2. **Trigger (primitive)** — a row in the `triggers` table representing a live subscription (webhook URL, cron entry, manual button). Owns runtime concerns: enable/disable, credentials, dispatch. Targets a workflow (or the orchestrator).

Users think of "when X happens, do Y" as a single concept. The split forces them to keep the two sides in sync manually. The **workflow copilot** cannot bridge that gap — it edits definitions but cannot touch trigger rows, so it ships workflows that never fire.

Version history is also incomplete: rolling back a workflow does not roll back its trigger config. "What was this listening for on June 15?" is ambiguous.

## Non-goals

- **Collapsing all triggers into workflows.** Triggers that target the orchestrator or standalone actions stay first-class in the triggers UI. This spec only changes how *workflow-targeted* triggers are managed.
- **GitHub / Gmail / other integration event subscriptions.** Only Slack `message.channels` is in v1 scope — its Events API subscription is already active at the app level and events already reach the worker. GitHub and Gmail need per-integration dispatcher work and are follow-ups.
- **Automatic migration of existing user-owned triggers.** They stay user-owned. Users can adopt the workflow-declared model by deleting the old trigger and letting publish materialize a new one.

## Design: Ownership

Triggers stay a first-class primitive. Each row grows an optional owner:

- `owner_workflow_id` — the workflow that declared this trigger via a trigger-node subscription. NULL means user-owned (edit in `/automation/triggers` as today).
- `owner_node_id` — the specific trigger node inside that workflow's published definition that produced this row. Used by the reconciler to match declarations to rows.

Both nullable. When both are set, the trigger is **derived** from the workflow's published definition; the triggers UI locks its declarative fields (type/config) but leaves pause/resume enabled since those are runtime state.

When both are NULL, behavior is unchanged from today.

### Workflow trigger node schema

The trigger node in `workflow_definition.nodes[]` grows one optional field:

```ts
subscription?:
  | { type: 'manual' }
  | { type: 'webhook'; method?: 'GET' | 'POST' | 'PUT'; rateLimit?: number }
  | { type: 'schedule'; cron: string; timezone?: string; triggerData?: Record<string, unknown> }
  | { type: 'slack.message.channels'; channel: string /* name with #, or C-prefixed ID */; teamId?: string; filters?: { ignoreBots?: boolean; mentionOnly?: boolean } }
```

Absent or `{ type: 'manual' }` → no materialized trigger (manual test runs still work off `dataSchema`).

`webhook` → reconciler creates a webhook trigger and the system generates a URL and token on first publish. The URL is a *runtime output* surfaced in the workflow editor after publish; it is NOT set by the copilot or user.

`schedule` → reconciler creates a schedule trigger with the given cron. `triggerData` is the payload passed on each fire.

`slack.message.channels` → reconciler creates a Slack event trigger bound to a specific workspace and channel. If `teamId` is omitted and the owner has exactly one connected Slack workspace, that workspace is bound automatically. If they have multiple, publish fails with a "must select workspace" error and the editor surfaces a picker. `channel` accepts either a human name (`#incidents`) or a Slack channel ID (`C012ABCD`); the reconciler resolves names to IDs at publish time via the workspace's `conversations.list` and rejects unresolvable names. `filters.ignoreBots` (default `true`) skips messages authored by bot integrations. `filters.mentionOnly` (default `false`) fires only when the workflow's bot user is @-mentioned.

### Reconciler

Runs during `publishWorkflow` after the new version is committed. Input: the just-published definition.

Algorithm:

1. Query all triggers where `owner_workflow_id = <this workflow>`. Call this `existing`.
2. Extract trigger nodes from the definition with `subscription` set to a non-manual type. Call this `declared`.
3. Diff by `(owner_workflow_id, owner_node_id)`:
   - `declared` not in `existing` → CREATE trigger row.
   - `existing` not in `declared` → DELETE trigger row.
   - In both → UPDATE if `type` or `config` differs; noop otherwise.
4. Wrap in a D1 transaction.
5. Idempotent: republishing an unchanged version is a no-op.

Notes:
- `manual` subscriptions never produce a trigger row (that's the point — manual = no subscription).
- Webhook token stays stable across republishes (do not regenerate on UPDATE).
- Deleting a trigger via the reconciler cascades through existing FK behavior (`trigger_webhook_rate` etc.).

### Publish semantics

- **Draft edits change nothing** about live subscriptions. Users iterate freely.
- **Publish** is the switch. Reconciler runs against the newly-published definition.
- **Version restore** publishes the restored version, which runs the reconciler against it. Restoring an older version restores its declared subscriptions too.
- **Rollback of a bad publish** is symmetric: republish the prior version, reconciler restores its declaration.

### Delete cascade

- Workflow deleted → all triggers with `owner_workflow_id = <this>` are deleted via existing `ON DELETE CASCADE` from `workflowId`. Owner columns don't need their own cascade; the target FK already handles it because a workflow-owned trigger always targets the same workflow it's owned by.
- Trigger row deleted directly via admin/DB → next publish will re-materialize it. This is drift-recovery, not a supported user operation.

### Copilot integration

`getNodeSchema` currently returns the trigger-node contract (id, type, dataSchema). Extend it to include the new `subscription` field with its discriminated union. The copilot's system prompt gets a note describing when to include `subscription` and its shape.

No new copilot tools. `applyWorkflowPatch` already handles arbitrary node edits.

### UI

- `/automation/triggers` list: workflow-owned rows get a small "from workflow X" badge linking to the workflow editor.
- `/automation/triggers/:id` detail: for workflow-owned rows, disable the type/config form; keep name and enabled toggle editable; block delete with a message "declared by workflow X — edit in the workflow editor".
- Workflow editor trigger-node inspector: add a "Subscription" section (Manual / Webhook / Schedule) with a small form per type. For webhook, after publish, show the generated URL and a copy button.

### Slack event dispatch

Slack channel messages already reach `/api/channels/slack/events` — the app manifest subscribes to `message.channels`, but the current router ignores non-DM events. Adding a workflow-trigger fork:

1. On an incoming `message` event where `channel_type !== 'im'`, look up owned triggers with `type = 'slack.message.channels'` whose `config.teamId = <event.team_id>` and `config.channel = <event.channel>` (both normalized to Slack IDs).
2. Filter out bot-authored messages when the trigger config has `ignoreBots` set (default true).
3. If `mentionOnly` is set, require the workflow owner's bot user id to appear in the message text (`<@Uxxx>`).
4. For each matching trigger, enqueue a workflow execution with the Slack event as `trigger.data`.

The trigger's `trigger.data` shape (used by the workflow's `dataSchema`):

```
{
  team: string;      // team_id
  channel: string;   // channel_id
  channelName?: string;
  user: string;      // user_id of the poster
  text: string;
  ts: string;        // event ts
  threadTs?: string;
  eventType: 'message' | 'app_mention';
}
```

Retries: Slack retries events on non-200 responses within 3 seconds. The existing route already returns 200 immediately for retries; the workflow dispatch is async (fire-and-forget with `waitUntil`).

### Explicit boundaries with future work

- **GitHub / Gmail event subscriptions**: require per-integration dispatcher work. Follow-ups; the ownership model here doesn't change.
- **Cross-workflow subscriptions** (one Slack channel → multiple workflows): both workflows declare the subscription independently; the dispatcher fires each match. No sharing at the plumbing layer — Slack still delivers each event once, and the dispatcher fans out.
- **Copilot-generated webhook URLs**: NOT in this spec. Webhook URLs are runtime outputs, not inputs. If a user asks the copilot for "an endpoint that does X", the copilot declares `{ subscription: { type: 'webhook' } }`; the URL surfaces post-publish.
- **Copilot-authored channel picks**: the copilot can put `channel: '#incidents'` into the trigger node subscription based on user description, but the reconciler is what actually validates the channel exists in the bound workspace at publish time. If the bot isn't in the channel, publish fails with an actionable error and the user invites the bot.

## Assumptions

- The workflow copilot already can call `applyWorkflowPatch` with arbitrary node/edge structure. (Confirmed — no tool changes needed.)
- `publishWorkflow` runs inside a Cloudflare Worker; D1 transactions across the version write + reconciler are supported. (D1 supports transactions via `.batch()`; the reconciler is small enough to include.)
- Existing triggers won't break: they all have `owner_workflow_id = NULL` after the migration, which means "user-owned, treat as today". No behavior change.

## Open questions (answer during implementation)

None material — the defaults above should be safe.
