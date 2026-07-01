# Trigger Ownership Model — Design Spec

**Date:** 2026-07-01
**Status:** Draft — v2 (hardened after adversarial review)

## Problem

Valet has two overlapping "trigger" concepts:

1. **Trigger node** — the entry point of a workflow's DAG. Lives in `workflow_versions.definition`, declares the incoming payload's `dataSchema`. Purely definitional.
2. **Trigger (primitive)** — a row in the `triggers` table representing a live subscription (webhook URL, cron entry, manual button). Owns runtime concerns: enable/disable, credentials, dispatch. Targets a workflow (or the orchestrator).

Users think of "when X happens, do Y" as a single concept. The split forces them to keep the two sides in sync manually. The **workflow copilot** cannot bridge that gap — it edits definitions but cannot touch trigger rows, so it ships workflows that never fire.

Version history is also incomplete: rolling back a workflow does not roll back its trigger config. "What was this listening for on June 15?" is ambiguous.

## Non-goals

- **Collapsing all triggers into workflows.** Triggers that target the orchestrator or standalone actions stay first-class in the triggers UI. This spec only changes how *workflow-targeted* triggers are managed.
- **Gmail / other integration event subscriptions.** In v1: Slack `message.channels` and GitHub App webhook events — both already reach the worker (Slack via app manifest, GitHub via the App's webhook URL) and just need dispatch forks. Gmail and other integrations need per-integration dispatcher work and are follow-ups.
- **Automatic migration of existing user-owned triggers.** They stay user-owned. Users can adopt the workflow-declared model by deleting the old trigger and letting publish materialize a new one.

## Design: Ownership

Triggers stay a first-class primitive. Each row grows two nullable columns:

- `owner_workflow_id` — the workflow that declared this trigger via a trigger-node subscription. NULL means user-owned (edit in `/automation/triggers` as today).
- `owner_node_id` — the specific trigger-node id inside that workflow's published definition that produced this row. Used by the reconciler to match declarations to rows.

Both nullable. When both are set, the trigger is **derived** from the workflow's published definition; the triggers UI locks its declarative fields (type/config) but leaves pause/resume enabled since those are runtime state.

When both are NULL, behavior is unchanged from today.

**Uniqueness:** `UNIQUE(owner_workflow_id, owner_node_id)` — the reconciler treats owner keys as identity. This also blocks the race where two concurrent publishes both attempt to CREATE the same (workflow, node) row: the losing INSERT fails, the losing publish call returns an error, and the user retries. Without the unique constraint the race yields silent duplication.

**Name ownership.** The trigger row's `name` column is *derived* on `CREATE` (`"${workflowName} — ${nodeId}"`) and never touched by the reconciler on UPDATE. Users may rename the row via `/automation/triggers`; the rename persists across republishes. This is a change from the initial draft — previously the reconciler included `name` in its diff and would clobber user renames.

### Workflow trigger node schema

The trigger node in `workflow_definition.nodes[]` grows one optional field:

```ts
subscription?:
  | { type: 'manual' }
  | { type: 'webhook'; method?: 'GET' | 'POST' | 'PUT'; rateLimit?: number; stableId?: string }
  | { type: 'schedule'; cron: string; timezone?: string; triggerData?: Record<string, unknown> }
  | { type: 'slack.message.channels'; channel: string /* name with #, or C-prefixed ID */; teamId?: string; filters?: { ignoreBots?: boolean; mentionOnly?: boolean } }
  | { type: 'github.event'; event: string; action?: string; installationId?: number; repo?: string; filters?: { branch?: string; author?: string; ignoreSelf?: boolean } }
```

Absent or `{ type: 'manual' }` → no materialized trigger (manual test runs still work off `dataSchema`).

`webhook` → reconciler creates a webhook trigger and the system generates a URL and secret token on first publish. The URL is a *runtime output* surfaced in the workflow editor after publish; it is NOT set by the copilot or user. `stableId` (optional) lets the user pin token stability across trigger-node renames: if set, the reconciler keys the identity by `(owner_workflow_id, stableId)` instead of `owner_node_id`, so renaming a trigger node from `trigger` to `entry` while keeping `stableId: 'primary'` preserves the URL. Absent `stableId`, renaming a trigger node with a webhook subscription rotates the URL — the workflow editor MUST warn about this before commit.

`schedule` → reconciler creates a schedule trigger with the given cron. `triggerData` is the payload passed on each fire.

`slack.message.channels` → reconciler creates a Slack event trigger bound to a specific workspace and channel. If `teamId` is omitted and the owner has exactly one connected Slack workspace, that workspace is bound automatically. If they have multiple, publish fails with a "must select workspace" error and the editor surfaces a picker. `channel` accepts either a human name (`#incidents`) or a Slack channel ID (`C012ABCD`); the reconciler resolves names to IDs at publish time via the workspace's `conversations.list` and rejects unresolvable names. For **private channels** the resolver additionally calls `conversations.members` and verifies the publishing user's linked Slack identity is a member — this closes a leak where any user in a shared org could subscribe to `#exec-comp` just because the bot was invited. `filters.ignoreBots` (default `true`) skips messages whose `bot_id` is present. `filters.mentionOnly` (default `false`) fires only when the workflow owner's bot user is @-mentioned.

`github.event` → reconciler creates a GitHub event trigger bound to a GitHub App installation. `event` is the webhook event name (`pull_request`, `issues`, `push`, `issue_comment`, `release`, `workflow_run`, etc.). Optional `action` restricts to a payload action (`opened`, `closed`, `labeled`, …). `installationId` is auto-selected when the owner has exactly one installation; otherwise required. `repo` (`owner/name`) restricts to a single repository; omitted means "any repo the installation has access to". `filters.branch` restricts push events to a ref. `filters.author` matches `sender.login`. `filters.ignoreSelf` (default `true`) drops events where `sender.type === 'Bot'` and `sender.login` ends in `[bot]` — this prevents reentrance loops when the workflow itself calls back into GitHub (e.g. commenting on the PR that just fired the trigger). The reconciler validates that the installation exists, belongs to the publishing user, and — when `repo` is set — that the installation has access to it.

### Reconciler and publish ordering

The publish pipeline is **resolve → commit → reconcile**. If any resolve step throws, no version is committed and no triggers change.

```
publishDraft(userId, workflowId)
├─ read current draft definition
├─ RESOLVE integration-scoped subscriptions:
│    ├─ resolveSlackSubscriptions(userId, definition)     — may throw
│    └─ resolveGithubSubscriptions(userId, definition)    — may throw
│    → produces `resolvedDefinition` with concrete teamId/channelId/installationId
├─ COMMIT the resolved definition as the new published version   (D1 batch)
└─ RECONCILE the triggers table against `resolvedDefinition`      (D1 batch)
     ├─ listOwnedTriggers(workflowId)
     ├─ planReconciliation(pure)  → [create | update | delete] ops
     └─ apply ops in one batch
```

Why store the *resolved* definition and not the raw one:
1. **Rollback semantics.** Restoring an older version re-runs reconcile against exactly what it produced originally — no re-resolution against a Slack workspace that may have changed since.
2. **Audit.** `versions.definition` shows the exact channel/installation identifiers that were live at publish.
3. **Determinism.** Two runs of the reconciler against the same version produce the same ops.

The pure `planReconciliation` function operates on resolved identifiers only. If a subscription is missing a required resolved field, the reconciler treats it as a programmer error and **throws** (not `continue`); the resolver step is what filters invalid input.

Diff algorithm inside `planReconciliation`:
1. Query all triggers where `owner_workflow_id = <this workflow>`. Call this `existing`.
2. Extract trigger nodes from the definition with `subscription` set to a non-manual type. Call this `declared`.
3. Match by `stableId ?? ownerNodeId`:
   - `declared` not in `existing` → CREATE trigger row.
   - `existing` not in `declared` → DELETE trigger row.
   - In both → UPDATE if `type` or the normalized config JSON differs; noop otherwise.

Config normalization uses a recursive canonical serialization (deep-sort keys) so nested `filters` objects don't produce false UPDATE ops on republish. Comparison excludes `name` (see "Name ownership" above), `webhookToken`, and `lastFiredAt`.

Reconciler CRUD uses **system-context** DB helpers (`createTriggerAsOwner`, `updateOwnedTrigger`, `deleteOwnedTrigger`) that bypass the user-scoped WHERE clauses of the standard user-facing CRUD. This keeps the user-facing helpers safe (they still enforce ownership) while letting the publish pipeline speak for the system.

### Publish semantics

- **Draft edits change nothing** about live subscriptions. Users iterate freely.
- **Publish** runs resolve → commit → reconcile.
- **Version restore** re-publishes the restored (already-resolved) definition — reconciler re-materializes exactly what was live at that version's original publish.
- **Rollback of a bad publish** is symmetric.
- **Concurrent publishes** — the `UNIQUE(owner_workflow_id, owner_node_id)` constraint and the version's own uniqueness guard let the loser fail cleanly; nothing corrupt persists.

### Delete cascade

- **Workflow deleted** → all triggers with `owner_workflow_id = <this>` cascade via the FK. The existing `triggers.workflowId` FK also cascades to the same rows; both firing is a no-op (rows deleted once).
- **Trigger row deleted directly (admin/DB)** → next publish will re-materialize it. Drift-recovery, not a supported user operation.
- **Slack workspace disconnected** — Slack triggers scoped to a disconnected workspace stop receiving events. The disconnect handler MUST delete matching `owner_workflow_id != NULL` triggers and mark the owning workflow's health status "trigger source disconnected" (see Health signals).
- **GitHub installation uninstalled** — `handleInstallationWebhook` (existing) MUST additionally delete matching `type = 'github.event'` triggers whose `config.installationId` equals the uninstalled installation, and mark the owning workflows' health status accordingly.

### Health signals

Silent trigger death is the single biggest UX hazard. Mitigations:

- `triggers.lastFiredAt` (already exists) is stamped on every successful dispatch (Slack, GitHub, webhook, schedule). Owned triggers are no exception.
- The workflow editor's trigger-node inspector reads the materialized trigger row and shows:
  - the current `enabled` state (with re-enable button if disabled),
  - `lastFiredAt` (or "never fired") next to the subscription form,
  - a health banner when the reconciler-detected binding is invalid (bot no longer in channel, installation revoked, etc. — populated by a periodic sanity check, see below).
- `/automation/triggers` list shows a "not fired in N days" affordance for anything with a recent `createdAt` but a null/stale `lastFiredAt`.
- Periodic sanity check (cron, hourly): for each owned Slack trigger, re-check bot membership via `conversations.info`; for each owned GitHub trigger, re-check installation validity via `github_installations.status`. Mark unhealthy rows via a new nullable `health_status` column so the UI can surface them.

### Copilot integration

Three copilot changes:

1. **New tool: `listConnectedIntegrations`** — returns the caller's connected Slack workspaces (teamId, name) and GitHub installations (id, account name, list of repo full names). The copilot MUST call this before writing a `slack.message.channels` or `github.event` subscription with an explicit `teamId` / `installationId` / `repo`. Prevents fabrication.
2. **Extended `getNodeSchema`** — describes the `subscription` field including all types, their fields, resolved trigger.data shapes, and the `ignoreSelf` / `ignoreBots` defaults.
3. **System-prompt additions** —
   - Enumerate connected integrations before subscribing.
   - Renaming a trigger node with a webhook subscription rotates its URL — warn the user first.
   - Subscription changes are high-consequence; when applyWorkflowPatch touches a `subscription` field, note the change explicitly in the assistant's response.
   - GitHub reentrance: `ignoreSelf` default `true` protects against loops. Only override with explicit user consent.

No changes to `applyWorkflowPatch`.

### UI

- `/automation/triggers` list: workflow-owned rows get a small "from workflow X" badge linking to the workflow editor. Also a "not fired recently" affordance when applicable.
- `/automation/triggers/:id` detail: for workflow-owned rows, disable the type/config form. The `enabled` toggle stays free. Delete is blocked with a link back to the workflow editor. The `name` field stays free — the reconciler doesn't touch names post-create.
- Workflow editor trigger-node inspector: adds a "Subscription" section (Manual / Webhook / Schedule / Slack / GitHub) with a small form per type. For a saved+published node, the inspector ALSO surfaces:
  - the materialized trigger's `enabled` state (with re-enable),
  - `lastFiredAt`,
  - the webhook URL (webhook subs only),
  - a health warning banner if the reconciler previously flagged the binding as invalid.
  - a rename-danger warning when the user edits the trigger-node `id` field with a webhook subscription and no `stableId`.
- Copilot chat panel: when `applyWorkflowPatch` includes a subscription change, the diff card visually highlights the subscription block (not just a JSON diff) and the assistant's summary explicitly notes the subscription change.

### Slack event dispatch

Slack channel messages already reach `/api/channels/slack/events` — the app manifest subscribes to `message.channels`, but the current router ignores non-DM events. Adding a workflow-trigger fork:

1. On an incoming `message` event where `channel_type !== 'im'`, look up owned triggers with `type = 'slack.message.channels'` whose `config.teamId = <event.team_id>` and `config.channelId = <event.channel>`.
2. Filter out bot-authored messages (`event.bot_id` present) when the trigger config has `filters.ignoreBots !== false` (default true).
3. If `filters.mentionOnly`, require the workflow owner's bot user id to appear in the message text (`<@Uxxx>`).
4. For each matching trigger, enqueue a workflow execution with the Slack event as `trigger.data`, and update the trigger's `lastFiredAt`.

The trigger's `trigger.data` shape (mirrored in the workflow's `dataSchema`):

```
{
  team: string;          // team_id
  channel: string;       // channel_id
  channelName?: string;
  user: string;          // user_id of the poster
  text: string;
  ts: string;            // event ts
  threadTs?: string;
  eventType: 'message' | 'app_mention';
}
```

Retries: Slack retries events on non-200 responses within 3 seconds. The existing route ignores retries (dedup by header). Workflow dispatch runs inside `waitUntil` so the ACK stays fast. **Delivery idempotency**: a `channel_event_deliveries` table (short TTL, keyed by `event_id`) records enqueued events so a `waitUntil` failure can be replayed by a cron sweep. This is a v1 hardening, not a v0 feature — flagged as future work below.

### GitHub event dispatch

GitHub App webhook events already reach `/api/webhooks/github` — signature verified via Octokit, delivery id tracked, and three event types (`installation`, `pull_request`, `push`) are dispatched to session-state handlers. Everything else is logged as "unhandled event". A workflow-trigger fork adds a second consumer without touching the existing handlers:

1. After the existing handled-events block, look up owned triggers where `type = 'github.event'`, `config.installationId = <payload.installation.id>`, `config.event = <event header>`. Filter by `config.action` if set, and by `config.repo` (match `payload.repository.full_name`) if set, then by `config.filters` (branch on `payload.ref`, author on `payload.sender.login`, ignoreSelf on `payload.sender.type === 'Bot' && payload.sender.login.endsWith('[bot]')`).
2. For each match, enqueue a workflow execution with the payload mapped into `trigger.data`, and update the trigger's `lastFiredAt`.
3. The `pull_request` and `push` session-state handlers continue to run unchanged — trigger dispatch is additive, not exclusive.

Trigger data shape:

```
{
  event: string;                // 'pull_request'
  action?: string;              // 'opened'
  installationId: number;
  repo?: { owner: string; name: string; fullName: string };
  sender?: { login: string; id: number; type: 'User' | 'Bot' };
  payload: Record<string, unknown>;  // full payload for template access
}
```

GitHub retries webhook deliveries on non-2xx responses. Dispatch runs inside `waitUntil` so the ACK stays fast. Delivery idempotency (same table as Slack, keyed by `X-GitHub-Delivery`) recovers events lost to `waitUntil` failures. Also flagged as v1 hardening below.

### Concurrency

Two publishes racing on the same workflow:

- The version-write path already uses a CAS on `expectedUpdatedAt` and a retry loop on unique-constraint failure for `workflow_versions.version_number`. One publish wins the commit; the other retries or errors.
- The reconciler runs against the winner's committed definition. The loser either retried and re-runs its own reconciler (which will now see the winner's state and diff cleanly), or errored out with the CAS conflict returned to the user.
- The `UNIQUE(owner_workflow_id, owner_node_id)` constraint is a belt-and-braces guard for the pathological case where two reconcilers still overlap: the losing INSERT throws, the losing publish returns an error, and the state stays consistent.

Two events firing while a publish reconciles:

- Events arrive at `slack-events.ts` / `webhooks.ts`, look up matching triggers, and dispatch. If the publish is *deleting* a trigger mid-dispatch, one of two outcomes: the SELECT ran before the DELETE (dispatch proceeds; execution starts against the pre-publish workflow version — acceptable), or the SELECT ran after (no dispatch; also acceptable). No corruption either way.

### Schema migration

Migration `0024_trigger_ownership.sql` performs:

1. `ALTER TABLE triggers ADD COLUMN owner_workflow_id TEXT REFERENCES workflows(id) ON DELETE CASCADE;`
2. `ALTER TABLE triggers ADD COLUMN owner_node_id TEXT;`
3. `ALTER TABLE triggers ADD COLUMN health_status TEXT;` — nullable; populated by sanity checks.
4. `CREATE INDEX idx_triggers_owner_workflow ON triggers(owner_workflow_id);`
5. `CREATE UNIQUE INDEX idx_triggers_owner_key ON triggers(owner_workflow_id, owner_node_id) WHERE owner_workflow_id IS NOT NULL;` — partial unique so user-owned rows (both NULL) are unconstrained.
6. **Widen `workflow_executions.trigger_type` CHECK constraint** to include `slack.message.channels` and `github.event`. SQLite requires a table rebuild for CHECK changes; migration re-creates the table via the standard rename-old + create-new + copy + drop-old pattern. Without this migration, every Slack/GitHub execution fails silently inside `waitUntil`.

### Explicit boundaries with future work

- **Gmail / other integration event subscriptions**: require per-integration dispatcher work. Follow-ups; the ownership model here doesn't change.
- **Cross-workflow subscriptions** (one Slack channel → multiple workflows): both workflows declare the subscription independently; the dispatcher fires each match. No sharing at the plumbing layer.
- **Duplicate-fanout warnings**: when a user publishes a workflow whose subscription overlaps an existing user-owned trigger, both fire on every event. Detect at publish time and warn in the response; do not block. v1 hardening — flag on the publish response, wire the UI later.
- **Copilot-generated webhook URLs**: URLs are runtime outputs, not inputs. Copilot declares `{ type: 'webhook' }`; URL surfaces post-publish.
- **Copilot-authored channel picks**: `listConnectedIntegrations` gives the copilot the raw material; the reconciler is what validates at publish.
- **Delivery-id idempotency**: Slack `event_id` and `X-GitHub-Delivery` short-TTL dedup table + recovery cron. Prevents silent event loss when `waitUntil` fails after ACK. **In-scope for v1** as part of the dispatch tasks — flagged separately in the plan.
- **Per-trigger execution rate cap**: high-volume push events on a busy monorepo or `message.channels` on a chatty channel can fan out unbounded executions. Reuse the `trigger_webhook_rate` mechanism. **In-scope for v1.**

## Assumptions

- The workflow copilot already can call `applyWorkflowPatch` with arbitrary node/edge structure. Confirmed.
- `publishWorkflow` runs inside a Cloudflare Worker; D1 batch supports atomic multi-write. Confirmed for the version-commit step and the reconciler-apply step (each own batch; the resolve step is async network + validation and runs before either batch).
- Existing triggers won't break: they all have `owner_workflow_id = NULL` after the migration → user-owned, semantics unchanged.
- Slack installs are org-scoped in the current codebase (`getOrgSlackInstall`). The resolver's user-scope check is bounded by the D1 tenant boundary; in a multi-workspace future, this needs revisiting. Documented in the resolver's source.

## Open questions (answer during implementation)

- **Sanity-check cron frequency**: hourly is the initial guess; may tune based on how noisy the "unhealthy" flag ends up.
- **Bot user id for `ignoreSelf`**: GitHub sender.type + `[bot]` suffix is a proxy for "our app". A tighter check would compare `sender.id` against `installations.app_id` — worth doing if the proxy misfires.
- **Where the dispatched-event dedup table lives**: a new `channel_event_deliveries` table, or piggyback on `trigger_webhook_rate`? Leaning new table since the semantics differ (dedup, not rate).
