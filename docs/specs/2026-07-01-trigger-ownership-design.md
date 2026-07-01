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
- **New subscription source types.** Slack/GitHub/Gmail event ingestion requires separate dispatcher infrastructure. This spec covers only the three source types that already work: `manual`, `webhook`, `schedule`.
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
```

Absent or `{ type: 'manual' }` → no materialized trigger (manual test runs still work off `dataSchema`).

`webhook` → reconciler creates a webhook trigger and the system generates a URL and token on first publish. The URL is a *runtime output* surfaced in the workflow editor after publish; it is NOT set by the copilot or user.

`schedule` → reconciler creates a schedule trigger with the given cron. `triggerData` is the payload passed on each fire.

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

### Explicit boundaries with future work

- **Slack/GitHub/Gmail event subscriptions**: require new dispatcher infrastructure. When those land, the reconciler grows new subscription-type cases; the ownership model itself doesn't change.
- **Cross-workflow subscriptions** (one Slack channel → multiple workflows): out of scope. Handle by having each workflow declare its own subscription; a future dispatcher layer can dedupe the plumbing.
- **Copilot-generated webhook URLs**: NOT in this spec. Webhook URLs are runtime outputs, not inputs. If a user asks the copilot for "an endpoint that does X", the copilot declares `{ subscription: { type: 'webhook' } }`; the URL surfaces post-publish.

## Assumptions

- The workflow copilot already can call `applyWorkflowPatch` with arbitrary node/edge structure. (Confirmed — no tool changes needed.)
- `publishWorkflow` runs inside a Cloudflare Worker; D1 transactions across the version write + reconciler are supported. (D1 supports transactions via `.batch()`; the reconciler is small enough to include.)
- Existing triggers won't break: they all have `owner_workflow_id = NULL` after the migration, which means "user-owned, treat as today". No behavior change.

## Open questions (answer during implementation)

None material — the defaults above should be safe.
