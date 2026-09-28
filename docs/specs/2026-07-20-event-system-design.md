# Event System Design — GitHub & Linear Webhooks → Generic Events

**Date:** 2026-07-20
**Branch:** dev-v2
**Status:** Implemented on dev-v2 (branch docs/event-system-design)

## Goal

A generic event system for v2: GitHub and Linear webhooks flow in as normalized,
durable events, pre-configured by app installation (no per-event setup). Users
subscribe to events via triggers that can start workflows, prompt orchestrators,
signal waiting workflow runs, or be browsed in an API/UI feed.

## What existed before this work (dev-v2)

- **`TriggerDef` contract** (`packages/engine/src/valet-plugin.ts:37`):
  `verify()` over raw request bytes + `toSignal()`. Defined but not consumed by
  `packages/api`.
- **`plugin-github` implements it** (`packages/plugin-github/src/triggers.ts`):
  HMAC verification + webhook parsing ported from v1.
- **GitHub App webhook** (`packages/api/src/routes/github-app.ts`): public
  endpoint, HMAC-verified, but only handles `installation` /
  `installation_repositories` (syncs `github_installations`). All other event
  types are dropped.
- **Workflows** have `WorkflowTriggerPayload { type: 'manual' | 'schedule' | 'webhook' }`
  (`packages/workflow/src/dag/shape.ts:58`); nothing wires external webhooks in.
- **`plugin-linear`** is a stub (MCP actions only; no triggers, no webhooks).
- **ChannelHost** (`packages/api/src/channels/host.ts`) routes chat events to
  orchestrators — precedent for orchestrator delivery, but chat-message-shaped.

The core of this project is building the **host side** of the existing
`TriggerDef` contract, plus a Linear implementation.

## Architecture

```
GitHub App webhook ─┐
Linear webhook ─────┤→ Ingest (verify sig → resolve org → normalize) → events table
future plugins ─────┘                                                       │
                                            Dispatcher (1s poll + in-process ingest nudge)
                                                                            │
                                              match against event_subscriptions
                                                                            │
                                    ┌──────────────┬────────────────┬───────┴────────┐
                              start workflow   prompt orchestrator  workflow_signals  API/UI feed
```

Decisions (locked in during brainstorming):

- **Consumers:** all four — workflow triggers, orchestrator prompts,
  running-run signals, API/UI feed.
- **Linear setup:** Linear OAuth app; webhook created automatically via
  Linear's API on connect.
- **Filter model:** namespaced event key + structured declarative filters on
  catalog-declared fields.
- **Source contract:** plugin-level (`TriggerDef` evolution) — GitHub and
  Linear are the first two implementations; future sources plug in without
  touching core.
- **Delivery semantics:** persist first, return 204 fast, dispatch async with
  retries and per-delivery status.

## Plugin contract evolution

Extend `TriggerDef` (in `packages/engine/src/valet-plugin.ts`) rather than
adding a parallel interface:

```ts
interface TriggerDef {
  id: string;                    // "github.pull_request"
  service: string;
  description: string;
  verify(req: { headers: Record<string, string>; rawBody: Uint8Array },
         secrets: Record<string, string>): VerifiedEvent | null | Promise<VerifiedEvent | null>;
  toEvent(event: VerifiedEvent): NormalizedEvent;    // replaces toSignal
  catalog: EventCatalogEntry[];                      // subscribable keys + filter fields
}

interface NormalizedEvent {
  key: string;              // "github.pull_request.opened", "linear.issue.updated"
  dedupeKey: string;        // provider delivery id — unique per service
  occurredAt: string;
  actor?: { externalId: string; login?: string };   // enables identity_links attribution
  refs: Record<string, string>;   // scope refs: repo, installation_id, team_id, project_id
  summary: string;          // one-line human text (SignalContent body for orchestrator delivery)
  payload: unknown;         // raw provider payload
}

interface EventCatalogEntry {
  key: string;
  description: string;
  filters: { field: string; path: string; description: string }[];
  // e.g. field "repo" → path "repository.full_name"
}
```

`toSignal` was removed from the contract (it was never consumed by
`packages/api`): orchestrator delivery synthesizes `SignalContent` generically
from `key` + `summary` + `refs`. The catalog powers the subscription-builder
UI and filter validation.

## Data model

Three new tables plus a Linear installation mapping (Drizzle schema in
`packages/api/src/schema/`, migration in `packages/api/migrations/pg/`):

### `events` — durable log

| Column | Notes |
|---|---|
| `id` | pk |
| `org_id` | fk, indexed |
| `service` | `github`, `linear`, … |
| `event_key` | `github.pull_request.opened` |
| `dedupe_key` | unique per `(service, dedupe_key)` — idempotent redelivery |
| `actor` | jsonb |
| `refs` | jsonb |
| `summary` | text |
| `payload` | jsonb (raw provider payload) |
| `occurred_at`, `received_at` | timestamps |

A retention job (default 30 days) is a deferred follow-up; nothing prunes
`events` yet.

### `event_subscriptions`

| Column | Notes |
|---|---|
| `id` | pk |
| `org_id`, `owner_type`, `owner_id` | scoping |
| `name` | display name |
| `event_keys` | `text[]`; supports trailing-wildcard patterns (`github.pull_request.*`) |
| `filters` | jsonb: `{ field, op: eq\|in\|prefix\|contains, value }[]` over catalog fields; a filter's `field` must be declared by a catalog entry actually selected by `event_keys` (not merely by any service's catalog — a cross-service field would validate and then never match at ingest) |
| `target` | jsonb: `{ kind: "workflow" \| "orchestrator", ...ref }`. `signal` is designed (dispatcher supports it) but REJECTED by the CRUD validator until a workflow node exists that parks on the `event:{key}` signal shape; accepting it earlier would create silently-inert subscriptions. An orchestrator target may also carry `systemPrompt` and `userPromptTemplate` (see "Orchestrator prompt templates") |
| `enabled` | bool |
| `created_by`, timestamps | |

Workflow event-triggers are rows here too — a subscription with a
`{ kind: "workflow" }` target starts that workflow, so one matching engine
serves everything. (Auto-syncing subscription rows from workflow-definition
trigger nodes is deferred — see Out of scope.)

### `event_deliveries`

| Column | Notes |
|---|---|
| `id` | pk |
| `event_id`, `subscription_id` | fks |
| `status` | `pending` → `delivered` \| `failed` → `dead` |
| `attempts`, `next_attempt_at`, `last_error`, `delivered_at` | retry bookkeeping |

### `linear_installations`

`org_id, workspace_id, workspace_name, webhook_id, connected_by, timestamps` —
mirrors `github_installations`. The webhook signing secret is NOT a column
here: it lives in the org `linear` credential's `metadata.webhookSecret`,
the same way GitHub's `webhookSecret` lives in the `github_app` credential.

## Ingest

Public route `POST /webhooks/events/:service`, mounted pre-auth (like
`/webhooks/github-app`):

1. Read raw bytes, 1 MiB cap.
2. Resolve owning org before verification (secrets are per-org): Linear — peek
   `organizationId` from body → `linear_installations`; GitHub —
   `installation.id` → `github_installations`. Then run the plugin's
   `verify()` with that org's secret over the raw bytes.
3. `toEvent()` → insert into `events`. Duplicate `dedupe_key` → 204 no-op.
4. In the same transaction, match active subscriptions (indexed `org_id` +
   event-key match, filters evaluated in memory) and insert `event_deliveries`
   rows. Nudge the in-process dispatcher (`dispatcher.nudge()`); return 204.

Matching inside the ingest transaction means an accepted event either has its
delivery rows or doesn't exist — no persisted-but-never-matched window. Actual
delivery stays async.

**GitHub routing:** the existing `/webhooks/github-app` route keeps handling
`installation*` events (installations sync); all other event types it receives
are forwarded into the event pipeline. One GitHub webhook URL, two concerns.
The forwarder builds the `VerifiedEvent` directly (signature + org already
verified by the App route) instead of re-running `TriggerDef.verify` — a
known invariant split between the two ingest paths; folding the App route
into the generic ingress (e.g. a `resolveInstall` hook on `TriggerDef`) is a
recorded follow-up. Events GitHub sends that the deployment can't ingest (no
registered TriggerDef, missing delivery id) are drop-logged
(`event_not_ingestable`), never silently 204'd.
`occurredAt` is extracted from the payload's own per-family timestamps
(`pull_request.updated_at`, `head_commit.timestamp`, …), falling back to
wall clock — so redeliveries keep their original causality in the feed's
sort order.
The App manifest declares `default_events` for every ingestable trigger
family (derived from the registered github TriggerDefs, excluding `ping`)
plus a `statuses: read` permission, so new installations deliver everything
the catalog advertises. Apps created before this change need a one-time
event-subscription update in GitHub's App settings.

## Dispatcher

In-process loop in the API server (matches how v2 runs background work),
implemented in `packages/api/src/events/dispatcher.ts`:

- 1s poll as a staleness floor; the ingest path nudges the dispatcher
  in-process (`nudge()`) so fresh deliveries dispatch immediately. The
  original sketch used `LISTEN/NOTIFY`, but the API is single-process — a
  direct in-process nudge is simpler and just as fast, and the poll sweeps
  retries and anything a crash left behind.
- Claim due deliveries with a single-statement CAS lease (the codebase's
  established row-claim pattern, cf. `pg-store.ts` `claimRun`), not
  `FOR UPDATE SKIP LOCKED` (a bare `FOR UPDATE` outside a transaction
  releases its locks at statement end): one atomic `UPDATE ... RETURNING`
  pushes `next_attempt_at` forward by a 60s lease, with the due conditions
  repeated on the OUTER `WHERE` as the cross-process fence — a raced
  loser's EvalPlanQual recheck sees the winner's bumped `next_attempt_at`
  and skips the row. A crash mid-delivery leaves the row pending; it
  becomes due again when the lease lapses.
- Per target kind:
  - **workflow** — `workflowRunHost.start()` with
    `WorkflowTriggerPayload { type: 'event', triggerId: subscription.id, data: normalizedEvent }`.
    Add `'event'` to the trigger union in `packages/workflow/src/dag/shape.ts`.
    The runId is DERIVED from the delivery row (`wfrun_evt_{deliveryId}`), not
    freshly minted, and an already-existing run short-circuits — so a retried
    claim after a partial failure (run started, delivered-UPDATE lost) resolves
    to the same run instead of starting a duplicate.
  - **orchestrator** — prompt the owner's orchestrator with `SignalContent`
    (`signalType: event.key`, `body`: summary + payload excerpt,
    `attributes`: refs) — same delivery path ChannelHost uses. `admitSignal`
    doesn't apply (its edge ACL authorizes session→session edges and an event
    has no sender session); its second-layer defense is replicated in
    `orchestrator-target.ts` instead — the resolved session's durable org is
    asserted against the event's org, mismatches drop-log
    (`event_target_mismatch`) and throw. A rule that carries prompt templates
    renders the body first (see "Orchestrator prompt templates" below); one
    that carries none delivers the body described here unchanged.
  - **signal** — insert into `workflow_signals` for runs waiting on
    `event:{key}` conditions. Dispatcher support exists but the CRUD validator
    rejects the target kind until a `waitForEvent`-style node parks on that
    shape (see `event_subscriptions` table notes).
- Retries: backoff 30s → 2m → 10m → 30m, then `dead`. `last_error` recorded;
  dead deliveries visible in the UI feed.

## Linear installation flow

New `linear-connect` routes (mirroring `github-connect` / `github-app`):

1. Admin OAuth authorize → callback stores an org-level `linear` credential
   (workspace access token) in `credentials`. One workspace per org: the org
   credential holds exactly one token, so connecting a second, different
   workspace is rejected (409) until the first is disconnected — otherwise
   the first workspace's webhook could never be deleted again.
2. On callback: persist the credential (with the generated signing secret in
   `metadata.webhookSecret`) and the `linear_installations` row FIRST, then
   call Linear GraphQL `webhookCreate` (resource types: Issue, Comment,
   Project, Cycle, IssueLabel, Reaction) pointing at
   `{API_PUBLIC_URL}/webhooks/events/linear`, then patch `webhook_id` onto
   the install row. Order matters: Linear can deliver the moment the webhook
   exists, and a delivery the ingress can't resolve is 204'd and never
   retried. A failed `webhookCreate` leaves a repairable half-connected
   state (`webhookConfigured: false`), not a delivery gap.
3. Verification: `Linear-Signature` header (HMAC-SHA256 over raw body) +
   `webhookTimestamp` replay check, implemented in `plugin-linear`'s new
   `triggers.ts` (`verify` + `toEvent` + catalog: `linear.issue.create`,
   `linear.issue.update`, `linear.comment.create`, `linear.project.update`, …
   — keys use Linear's own action verbs, `create`/`update`/`remove`).
4. Disconnect: `webhookDelete` via API; remove installation + credential rows.

## API surface

- `GET /api/events` — org event feed (filter by service/key/time);
  `GET /api/events/:id` includes its deliveries (debugging "why didn't my
  trigger fire").
- `GET /api/events/catalog` — merged catalog from loaded plugins; drives the
  subscription-builder UI.
- `POST/GET/PATCH/DELETE /api/event-subscriptions` — CRUD; validates event
  keys and filter fields against the catalog.
- Collision gate (TKAI-294, `events/collisions.ts`): a create, a match edit,
  or an enable is compared against the org's enabled subscriptions. The
  comparison is symbolic — "filter A implies filter B" over `eq`, `in`,
  `prefix`, `contains`; `regex` proves nothing and can only warn. A write
  that covers an existing rule on a shared event key (equal or superset)
  answers 409 with the colliding rules in the payload; `allowCollision: true`
  commits it anyway and logs the override. A partial overlap or subset
  commits and returns the collision list as a warning on the response. Two
  workflow targets on different workflows never collide (intentional
  fan-out); a workflow↔orchestrator pair warns but never blocks. Disabled
  rows are skipped — they cannot fire — and enabling one re-runs the gate.
- Workflow editor: an "event" trigger node type whose save/update syncs an
  `event_subscriptions` row.

## Web UI

`/events` (packages/web: `routes/events.tsx`, `components/events/`) is the
first UI over this system. Two tabs:

- **Activity** — the org feed with service/key filters drawn from the
  catalog. A row expands into the event payload and its delivery attempts,
  so "why didn't my trigger fire" is answerable from the page.
- **Subscriptions** — list, create, edit, enable/disable, and delete over
  the CRUD routes. The create dialog offers only catalog keys. Targets: the
  caller's assistant, the active team's assistant (offered only while a
  team workspace is selected in the nav switcher — see
  2026-08-17-team-workspace-ui-design.md), the org assistant, or an owned
  workflow. The UI says "assistant"; the wire keeps `orchestrator`. Rows
  badge team owners with the team's name and a colleague's personal
  subscription with "Personal"; an unbadged row is the caller's own.

Each mutable row's menu opens an edit dialog
(`components/events/edit-subscription-dialog.tsx`): name, event keys, and
filters, through the same match step the wizard's advanced outcome uses. A
save PATCHes only the changed fields (`subscription-patch.ts`), so a rename
does not re-run the collision gate on an unchanged match. The target is
shown read-only — the PATCH route pins the target's kind and owner (only a
same-owner `assistantId` re-point is accepted, which the dialog does not
offer yet), so a different target is a new subscription, and the dialog
says so.

The creation wizard and the edit dialog render the collision gate's answer
inline (`components/events/collision-notice.tsx`): a blocked write lists the
rules it would cover, each with name, owner, target kind, and filter
summary, and offers an explicit "Create anyway" / "Save anyway"; a committed
overlap shows the same list as a warning before the dialog closes.

## Error handling

- Rejected/unverifiable webhooks → `event_drop_log` with reason
  (`bad_signature`, `unknown_org`, `oversized`), throttled logging (existing
  GitHub-route pattern).
- Delivery failures never lose events: the event row persists; the delivery
  row records attempts and last error and lands in `dead` after backoff is
  exhausted.

## Testing

- Unit: `verify()` with signed fixtures (pattern in `github-app.test.ts`),
  `toEvent()` normalization, filter-matching engine as a pure function.
- Route: ingest → event + delivery rows in one transaction; duplicate delivery
  id is a no-op; bad signature → drop log.
- Dispatcher: retry/backoff, `SKIP LOCKED` claiming, each target kind against
  fakes.
- E2e: create subscription → POST signed webhook → workflow run started with
  the event payload.
- Local, against a live dev stack: `packages/api/scripts/dev-seed-linear.ts`
  seeds a fake Linear installation + webhook secret (run with the api
  stopped), then `packages/api/scripts/dev-events-smoke.ts` drives the whole
  pipeline — signed webhook → feed → subscription → delivered → settled run,
  plus the direct workflow webhook trigger. Each file's header has the exact
  commands.

## Out of scope

Deferred follow-up (designed above, not yet built): the `events` retention
job.

- Workflow event-trigger node auto-sync of `event_subscriptions` — users
  create subscriptions (with workflow targets) via the API for now; the
  workflow editor does not create/sync subscription rows yet.
- SSE/WebSocket streaming of the event feed (poll the API for now).
- Sources beyond GitHub and Linear (the contract supports them; none built).
- Per-event user-level webhook config — installation-level only.
- Outbound webhooks (Valet emitting events to external URLs).


## Team Slack mention routing (2026-09-10)

Team assistant subscriptions use the organization Slack bot and authorize the linked sender against current team membership.
Ingress and redelivery share this check before creating deliveries. The dispatcher checks again and attributes delivery to the mentioner.
Personal and workflow mention rules remain creator-scoped. See `2026-09-04-team-slack-mention-subscriptions-design.md`.


## Orchestrator prompt templates (2026-09-16)

A workflow states what its nodes send to a model. A subscription that routes
to an assistant had no such control: every matching event arrived as the
generic `SignalContent` body above. A team could not give one rule its own
standing instruction, or shape the message the assistant reads.

An orchestrator target now carries two optional strings:

| Field | Meaning |
|---|---|
| `systemPrompt` | A standing instruction for this rule. It renders above the event in every delivery the rule makes. |
| `userPromptTemplate` | The event message, in place of the default body. |

Both are optional and both are absent by default. A rule that sets neither
delivers the same body it delivered before this feature, byte for byte: the
dispatcher only calls the renderer when the target carries a field
(`events/dispatcher.ts`). Workflow targets refuse both fields, because a
workflow keeps its prompt configuration on its own llm and session nodes.

### The variable set

Both fields are templates over one closed set of variables, drawn from the
normalized event:

| Variable | Value | `systemPrompt` | `userPromptTemplate` |
|---|---|---|---|
| `{{event.key}}` | the normalized event key | yes | yes |
| `{{event.summary}}` | the one-line summary the source plugin wrote | no | yes |
| `{{event.body}}` | the body the rule delivers with no user template | no | yes |
| `{{refs.<name>}}` | one scope ref (`repo`, `installation_id`, `channel`, …) | yes | yes |
| `{{payload.<field>}}` | one catalog-declared filter field of the raw payload | no | yes |

`{{event.body}}` keeps a channel rule usable: a Slack mention's default body
is the sender's cleaned message text, so a template can add instructions
around the message instead of replacing it.

`{{payload.<field>}}` reaches the payload only through the catalog entry for
the event's own key, over the same `field` → `path` map the filters match on.
An undeclared field is not addressable, so no template reads an unreviewed
corner of a provider payload. No variable reaches a session, a thread, or
another subscription.

`{{payload.<field>}}` is declared per event key. A rule that selects several
events, and names a field only some of them declare, renders an empty value
on the others. The write gate accepts it, because one selected event does
declare the field.

A `{{refs.<name>}}` name is not checked at write time. Refs arrive on the
normalized event at runtime and no catalog entry declares them, so a
misspelled ref is stored and renders as an empty string. The form says so.

### Rendering and safety

The language is substitution and nothing else (`events/prompt-template.ts`).
There is no expression syntax, no path walk, no function call, and no
recursion: one pass of `{{ name }}` replacement, so a rendered value that
itself contains `{{ ... }}` stays literal and payload text cannot smuggle in
a variable. Rendering is deterministic, and it happens at delivery time,
inside the dispatcher, before the existing assistant delivery path
(`events/assistant-delivery.ts`) takes the signal.

The write gate (`events/subscription-write.ts`) is what keeps the renderer
total. It refuses an empty field, a field over 4000 characters, a malformed
placeholder, a name outside the set above, a `payload.<field>` that no event
selected by `eventKeys` declares, and, in `systemPrompt`, a name outside that
field's narrower column. A patch re-validates the stored templates against
the patched `eventKeys`, so narrowing a rule to events that declare fewer
fields fails the write instead of rendering empty values later. At delivery
an absent value renders as an empty string, and the rendered body is capped
at 8000 characters.

The placeholder check reads the template left to right: `{{` opens a
placeholder and the next `}}` closes it. The scan makes two refusals: an
unclosed `{{`, and a `{{` inside another `{{ }}`. A `}}` with no open
placeholder in front of it is literal text, so a template may show the
assistant a JSON shape such as `{"a": {"b": 1}}`.

A `userPromptTemplate` that renders to nothing delivers the default body
instead, and the dispatcher logs the substitution. An empty signal body costs
the assistant a turn and tells it nothing, and the usual cause is the
per-event declaration above.

A rendered `systemPrompt` is delivered as the first block of the signal body,
under the heading `Instructions for this subscription:`, with the event under
it. The assistant session is shared by every rule that names it, so a per
delivery change of the session system prompt would leak one rule's
instruction into another rule's turn. The block is per delivery and holds
only this rule's text.

The heading is why `systemPrompt` takes the narrower variable set. The
summary, the default body, and every payload field carry text that the sender
of the event wrote. A rule such as `Follow the direction: {{payload.text}}`
would put that sender's words under a heading that presents them as the
rule's own instruction. The write gate refuses those names in that field, and
the renderer builds the instruction over `event.key` alone,
so a row that reaches the renderer another way keeps the same property. The
sender's text still reaches the assistant, below the separator, where it
reads as the event.

Prompt configuration does not change what a rule matches, so a write that
only changes a template runs no collision gate.

### Surfaces

- `POST /api/event-subscriptions` takes both fields inside `target`.
- `PATCH /api/event-subscriptions/:id` takes `systemPrompt` and
  `userPromptTemplate` at the top level, like `assistantId`. `null` clears a
  field and returns the rule to the default body. They are the only other
  part of `target` a patch may rewrite.
- The creation wizard collects both on the config step of every outcome that
  notifies an assistant: the Then step for the event and notify outcomes, and
  the Reply step for the Slack reply outcome. The edit dialog shows them for
  every assistant-target rule.

### Limits

A followed thread is not a match of the rule that bound it. Later messages in
that thread reach the assistant through the follow router
(`channels/follow-router.ts`), which carries the message itself, so they keep
the default body. Only the deliveries the subscription matches render its
templates. The form states this where a rule follows a thread, so a reader
does not expect an instruction to hold for the whole conversation.

### Linear event connection readiness

Personal Linear OAuth enables MCP tools, including `linear.save_issue`. It does
not install a webhook. Events such as `linear.issue.update` require the separate
organization connection. Organization settings expose the existing Linear OAuth
setup, which registers that webhook. The callback returns to this settings page.

Trigger catalogs show incoming event labels and organization readiness. Readiness
requires an installation, an organization credential with a signing secret, and a
registered webhook ID. It does not prove that Linear delivered a particular event.
Creation and activation report missing setup instead of accepting an event source
that cannot receive events. Template installation uses the same check. Repository
imports keep workflow definitions but leave missing-ingress triggers unarmed with
a setup warning. Existing rules can still be disabled. Non-admins get
an instruction to ask an organization admin; credentials remain admin-only.

Linear's Integrations entry presents native organization events first. The
native status says “Connected by your organization” when ready, including for
members. Optional MCP tools are collapsed in personal and team views; expanding
them reveals the separate Connect via MCP button. MCP connection state and disconnect controls name MCP explicitly.
Removing MCP credentials does not disconnect the organization's native webhook.
Native event authorization does not currently replace MCP-backed action tools.
