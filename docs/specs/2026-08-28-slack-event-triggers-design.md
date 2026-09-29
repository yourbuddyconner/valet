# Slack event sources for workflow triggers

**Status: implemented 2026-08-28.** Linear issue TKAI-247. Sister issue TKAI-246 (Linear event sources).

## Problem

Valet workflows can trigger on GitHub and Linear events, but not Slack. A user
wants a workflow to run when the Valet app is @-mentioned, when a message is
posted in a watched channel, or when a reaction is added. The generic event
rail already exists (webhook → normalized event → subscription match → run),
and the Slack plugin already declares trigger definitions for six event
families. This work is an audit of that rail plus the one change that makes it
fire end to end.

## Audit results

The task started as an audit of two open questions. Both resolve to
already-correct, so this spec records the evidence and the one real gap.

### 1. The signing secret is persisted at connect time

`PUT /api/credentials/slack?scope=org` (`packages/api/src/routes/credentials.ts:193`)
refuses to save the org Slack credential unless `metadata.webhookSecret` is set,
and returns a corrective error naming where to copy the Signing Secret from. The
same handler verifies the bot token against Slack and records `teamId`,
`teamName`, and `botUserId` on the credential. There is no second path that
creates the org Slack credential, so the secret can never be absent on a
connected org. No change needed.

The webhook route reads both fields it depends on and acks (200) with a
`unknown_org` drop-log entry when either is missing
(`packages/api/src/routes/slack-webhook.ts:229`), rather than 401-looping Slack
against a half-configured org.

### 2. The webhook route is mounted before auth, with the dispatcher threaded

`app.ts:173` mounts `slackWebhookRouter` at `SLACK_WEBHOOK_MOUNT`
(`/api/channels/slack`), before the more general `channelsRouter` and before
`buildAuthMiddleware` at `app.ts:272`. The route is public because the caller is
Slack, and the signing-secret HMAC is the whole authentication. The route calls
`eventDispatcher.nudge` after ingest (`slack-webhook.ts:285`), so a matched
delivery wakes the dispatcher without waiting for its 1-second poll. No change
needed.

### 3. The gap: the app manifest did not subscribe to the trigger events

Slack delivers only the event types an app subscribes to in its manifest. The
manifest (`SLACK_BOT_EVENTS`, `packages/api/src/services/slack-app.ts`) declared
three bot events for the agent DM surface: `app_home_opened`,
`app_context_changed`, `message.im`. The trigger definitions matched six event
families, but Slack was never told to deliver them. Every trigger except a DM
`slack.message` was a silent no-op: the catalog surfaced it, a user could
subscribe to it, and it could never fire.

This is the fix. `SLACK_BOT_EVENTS` now subscribes to every event type the
trigger defs match: `message.channels` / `message.groups` / `message.mpim` (DM
already rode `message.im`), `app_mention`, `reaction_added` /
`reaction_removed`, `member_joined_channel` / `member_left_channel`, the four
`channel_*` lifecycle events, `file_shared`, and `team_join`. The scopes these
events read with were already declared in `SLACK_OPTIONAL_BOT_SCOPES`, so an
operator who already installed the app must reinstall to widen event delivery,
but no scope grant changes.

A drift guard pins this: the plugin exports `slackTriggerEventTypes`
(`packages/plugin-slack/src/triggers.ts`), and `slack-app.test.ts` asserts every
entry is subscribed in `SLACK_BOT_EVENTS`. `message` is delivered as one bot
event per channel type, so the guard checks all four `message.*` variants are
present, not just one. A new trigger def that ships a catalog entry Slack never
delivers now fails a test instead of failing silently in production.

**Deployment note.** `SLACK_BOT_EVENTS` is the app manifest's event
subscription list. An already-installed workspace app keeps its old event set
until an operator re-pushes the updated manifest from Settings → Organization →
Slack (the paste-in flow). No user reinstall is needed, because the scopes were
already granted, but until the app's Event Subscriptions are updated in Slack,
the new triggers do not fire for that workspace.

### 4. New: the `app_mention` trigger

The issue named `app_mention` as a first target, but no trigger def matched it.
This work adds `slack.app_mention` to the trigger defs. The `app_mentions:read`
scope was already in the manifest (held for V1 parity), so the def needed no
scope change. `app_mention` carries `channel` and `user` directly, which the
shared `toEvent` normalizer already reads.

## The Slack trigger-match contract

For workflow authors and future maintainers, the exact contract a Slack event
travels:

- **Signature.** HMAC-SHA256 over `v0:{timestamp}:{rawBody}`, keyed by the org
  credential's signing secret, checked against `X-Slack-Signature`
  (`packages/plugin-slack/src/transport/verify.ts`). The trigger defs re-verify
  over the same raw bytes so their extraction stays authoritative
  (`triggers.ts:makeVerify`).
- **Replay window.** 5 minutes on `X-Slack-Request-Timestamp`. A stale timestamp
  is a 401.
- **Workspace scope.** A shared app's signing secret is valid for every
  workspace that installs the app, so a valid signature alone does not prove
  ownership. The route drops any update whose `team_id` is not the connected
  workspace's (`slack-webhook.ts:297`, `foreign_workspace`). Two orgs connected
  to Slack never cross-fire.
- **Dedup key.** The Events API `event_id`, carried as `deliveryId` and used as
  `dedupeKey`. Ingest holds `ON CONFLICT DO NOTHING` on `(service, dedupeKey)`,
  so a redelivery produces zero extra events and zero extra deliveries.
- **Match-gated persistence.** Ingest persists an event only when it matches an
  enabled subscription. See the privacy section below. This is also why the
  manifest can subscribe to `message.channels` without flooding the events
  table: an unsubscribed channel message is dropped at ingest.
- **Payload shape.** The normalized event's `payload` is the inner Events API
  `event` object, so a subscription filter dot-path addresses the raw event
  directly (for example `item.channel` for a reaction).
- **Self-trigger guard.** The `slack.message` and `slack.app_mention` defs both
  drop the app's own posts (`bot_id` present), so a workflow that posts to Slack
  cannot loop: its own channel post cannot re-fire `slack.message`, and a post
  whose text @-mentions the bot cannot re-fire `slack.app_mention`. `slack.message`
  additionally drops the noise subtypes the channel transport drops.
- **Double delivery of a channel mention.** An @-mention of the bot in a channel
  produces two Slack events with distinct `event_id`s: an `app_mention` and a
  `message`. An org subscribed to both `slack.app_mention` and `slack.message`
  therefore runs its workflow twice for one mention. Each event is a real,
  separately-subscribed delivery, so this is correct, not a duplicate. An author
  who wants one run subscribes to one key.

## Message events and the agent surface

Subscribing to `message.channels` means the agent DM consumer also sees channel
messages. It ignores them safely: `transport.parseUpdate` returns null for any
message whose `channel_type` is not `im` (`transport.ts:286`), so a channel
message reaches only the event pipeline, never a DM agent session.

## Privacy: events are stored only when a subscription matches

Ingest is match-gated for every event, not only high-volume ones
(`packages/api/src/events/ingest.ts`). Before any insert, ingest matches the
event against the org's enabled subscriptions. An event that matches nothing is
dropped and never touches the events table. The match is the full key-and-filter
test, so an event a subscription excludes by filter is dropped the same as one
no subscription names at all: the filter is a privacy boundary, not only a
delivery boundary.

This changed the prior behavior, where only the `ephemeral` `slack.message` key
was gated and every other event (GitHub, Linear, and the rest of Slack)
persisted on arrival. The rule now holds across all services. The `ephemeral`
catalog flag is removed, because universal gating makes it a no-op.

Two consequences a reader should know:

- **The event feed shows only subscribed events.** `GET /api/events` reads the
  events table, which now holds only matched events. An org that watches one
  repo no longer accumulates every other event its webhook delivers. The feed
  read logic is unchanged; there is simply less to read.
- **Redelivery covers only stored events.** `POST /api/events/:id/redeliver`
  replays a stored event through the subscriptions that match now. An event that
  matched nothing at arrival was never stored, so it cannot be replayed to a
  subscription created later. This is the intended trade: Valet does not retain
  data no subscription asked for so that it can be delivered retroactively.

## Debuggability: the Problems tab

Match-gating means an unmatched event leaves the events table empty, so "I set
up a trigger and nothing happened" has to be answerable somewhere. The Events
page gains a **Problems** tab (`GET /api/events/drops`) that surfaces the
`event_drop_log` the webhook routes already write — bad signature, wrong
workspace, missing credential, slow-ack retry — plus a "last event received"
timestamp (the max of the newest events row and the newest drop-log row). That
timestamp answers "is anything arriving at all?" without exposing any payload.

Ingest also drop-logs one match-gated miss: an event whose key a subscription
**names** but whose filter excluded this occurrence (`filter_excluded`). That is
the high-signal "my trigger didn't fire" case, and it is bounded by user intent
(a subscription must exist). It is throttled per (org, event key) at one row a
minute. A diagnostic retains the normalized event key and only these fields
when the source supplies them: Slack channel ID, bot ID, raw event type and
subtype, and message text truncated to 1,000 characters. It retains no raw
payload object, refs, headers, signing secret, token, form values, dedupe key,
or user ID. The bounded text exists solely so an administrator can identify the
specific filter miss through `events.list_problems`; it is not copied into the
event feed or a workflow run. A team sender authorization denial is not a
filter miss. Valet writes only its metadata-free authorization diagnostic and
never writes `filter_excluded` metadata for that sender.

A key that **no** subscription names is deliberately NOT drop-logged. For a
high-volume key like `slack.message` that is every message in the workspace,
logging it would re-flood the drop-log the privacy design keeps small. The one
exception is the classifier near-miss: if an enabled subscription explicitly
names `slack.message` and a third-party bot form message normalizes to
`slack.bot_message`, Valet writes the same bounded, throttled diagnostic under
`slack.message` and tells the administrator to subscribe to `slack.bot_message`.
The near-miss uses a throttle key separate from ordinary `slack.message` filter
misses, so either diagnostic cannot suppress the other. Bot traffic does not use
the human team-sender authorization gate, even when Slack supplies a `user` ID.
For every subscription owner type, Valet retains metadata only when a named
subscription's filters match. Otherwise, it records the guidance without message
metadata.
These diagnostics do not change event delivery. Unrelated bot messages remain
silent. The "last event received" signal covers the ordinary no-subscription case
instead.

### Slack form diagnostics

The Problems tab continues to use `GET /api/events/drops`. It shows the existing
categories and the last-event-received signal to every organization member.
Matched Slack events continue to use the normal event feed, detail, and
redelivery rules. A member can inspect a Slack event that their subscription
received.

For an unmatched `block_actions` or `view_submission` interaction, Slack writes
one `slack_interaction_unmatched` drop row per organization and interaction type
per minute. Only organization admins receive these rows from the drops API. The
row contains the interaction type and a corrective action. It contains no raw
payload, form values, headers, token, signing secret, or dedupe material.

The diagnostic is not an event row. It cannot enter the activity feed, create a
delivery, or be redelivered. Slack retries can run the normal channel consumer,
but the one-minute diagnostic limit prevents retry traffic from growing the log.
No Slack event is retained only for diagnostics.

### Agent diagnostics

The agent can call `events.list_problems` to inspect the same
`event_drop_log` records as the Problems tab. It does not use a second event
store. For a filter-excluded event, the record includes the normalized event
key and small payload metadata: channel, text (limited to 1,000 characters),
bot ID, raw event type, and raw subtype when present. It never stores the
source payload.

The action filters by normalized event key, channel, exact text, bot ID, and a
receipt time window. Metadata predicates run before the result limit, so a
matching older record is not hidden by newer unrelated rows. It returns newest
records first and caps one call at 100 records. Every organization member can
read ordinary Problems records, but their results expose only the allowlisted
channel, raw event type, and raw subtype metadata. An organization admin can
use text and bot ID filters and read those fields only from a private
user-owned turn with no channel origin. Team-owned and organization-owned
sessions have shared transcripts. A channel-originated turn also has a shared
transcript, even when its session is user-owned. A child spawned by such a turn
inherits the shared-transcript marker. Valet restores that marker from the
child's stored channel origin after a cache eviction. Valet treats these results
as member-visible, omits text and bot ID, and rejects those filters even when
the acting member is an admin. If the action context has no owner, Valet also
fails closed and applies the shared-transcript rules. The existing admin-only
`slack_interaction_unmatched` rule follows this private-session boundary. These
fields have no separate retention clock: they follow the existing
`event_drop_log` lifecycle; this feature adds neither a second store nor an
event-payload retention path.

## Mention scoping (TKAI-299, added 2026-09-01)

A `slack.app_mention` subscription started with unsafe defaults: no user
filter (anyone's mention fired it) and no channel filter (it listened across
the whole Slack workspace). Both defaults are now closed at write time
(`packages/api/src/events/mention-scope.ts`). A subscription whose event keys
select `slack.app_mention` — the exact key or a trailing wildcard — is a
**mention subscription**, and every write to one passes two gates:

1. **User scope.** The stored filters must carry a `user` filter equal to the
   creator's linked Slack user id (`user_identity_links`). The server injects
   the filter when it is absent, and refuses a filter that names anyone else.
   A creator with no linked Slack account cannot create one; the error names
   the corrective action (Settings → Connected accounts).
2. **Channel scope.** The stored filters must carry at least one `channel`
   filter with op `eq`, or op `in` with a non-empty list
   (`prefix`/`contains`/`regex` do not count — a prefix is still the whole
   Slack workspace; an empty `in` list is refused outright, because it
   matches nothing). The explicit `anyChannel: true` request flag waives the
   requirement. The flag is not persisted: a stored mention subscription with
   no channel filter IS the any-channel state, and the UI derives the display
   from that. On PATCH the server derives the row's stored any-channel state
   itself, so an edit that leaves channel scope alone needs no flag; only a
   patch that strips an existing channel filter must assert `anyChannel`.

Every subscription writer goes through ONE gate:
`validateSubscriptionWrite` (`events/subscription-write.ts`), which runs the
catalog validation and the mention rules together. The writers are the
subscriptions CRUD routes (`routes/events.ts`), the workflow trigger service
(`workflows/trigger-service.ts`), and the template installer
(`workflows/templates.ts`). A future writer that calls the gate gets the
scoping for free; there is no separate validate-only entry point to call by
mistake. On PATCH the mention rules re-run only when the patch changes
`filters` or `eventKeys`, and they key to the row's CREATOR (`created_by`),
not the caller — an enable/disable toggle still works after the creator
unlinks Slack, and a colleague's edit of an org-owned row cannot re-point the
scope at themselves.

The matcher carries one arm of the rule too: `subscriptionMatchesEvent`
(`events/match.ts`) fails closed on a mention subscription that has no `user`
filter. A row created before this gate therefore stops firing instead of
leaking other users' mentions; the miss is drop-logged as `filter_excluded`,
so its owner sees the stop in the Problems tab, edits the row, and the write
gate scopes it.

One consequence: because filters apply to every key a subscription selects, a
mention subscription cannot mix in ANY other key. The injected user filter
would silently narrow a sibling key like `slack.message` to the creator's own
events, or kill a key with no user field entirely. The gate refuses the mix
and tells the author to create a separate subscription. This also covers
`slack.*` wildcards.

The orchestrator's `workflows.create_trigger` and `workflows.update_trigger`
actions carry the flag as `any_channel`, so an agent can express the same
opt-out the UI can.

Surfaces: the AutomationWizard's reply step requires a multi-channel
selection (or the explicit "Any channel" checkbox, off by default) and states
that only the creator's own mentions fire the rule; the raw event picker,
the workflow TriggerDialog, and the subscription edit dialog show the same
checkbox when `slack.app_mention` is selected (the edit dialog seeds it from
the stored any-channel state); the subscriptions list labels each mention row "only #channel",
"N channels", or "any channel" (multi-channel `in` filters carry aligned
display `labels` on the wire, so the list shows names, not raw ids).
`slack.message` scoping is deliberately out of scope here — TKAI-302 tracks
that product decision.

**Team scope (TKAI-304/364, implemented 2026-09-10).** Team assistant
mention rules use the organization bot. They need no team Slack connection.
At match time, linked senders must be current members of the owning team.
The matcher ignores interim creator filters for these rules. Personal and workflow
mention rules remain creator-scoped. Redelivery uses the same membership gate.
The dispatcher uses the mentioner as actor and preserves that actor on the follow row.
The wizard offers the team's assistant and explains member-only routing.
See `2026-09-04-team-slack-mention-subscriptions-design.md` for the full contract.

## Custom slash commands that route to triggers or assistants

This was an investigation request alongside the issue. Two distinct systems
carry the "slash command" name in Valet; the request could mean either.

### System A: Valet in-app slash commands (`CommandDef`)

`ValetPlugin.commands` (`packages/engine/src/commands/types.ts`) declares typed
`/command`s that the web composer surfaces (`command-popup.tsx`). A `CommandDef`
maps its arguments to one plugin **action**. Sources today are `builtin`,
`skill`, and `plugin`. This system routes a command to an action, not to a
workflow trigger or an assistant/orchestrator start.

To route in-app commands to triggers or assistants, add a resolved-command
variant (for example `{ source: "workflow", workflowId }` or
`{ source: "assistant", assistantId }`) and a config surface that maps a command
name to that target. This is a self-contained follow-up on the in-app command
registry; it does not touch the Slack rail.

### System B: Slack slash commands (`/valet-deploy ...`)

A Slack slash command is a third body shape Slack posts to the same app request
URL: `application/x-www-form-urlencoded` with `command`, `text`, `user_id`,
`channel_id`, `team_id`, `response_url`, and `trigger_id`. The signing-secret
HMAC is identical to the Events API path, so verification reuses
`verifySlackSignature` unchanged.

What slash commands do **not** reuse:

- **A synchronous reply.** Slack wants a response inside 3 seconds and shows it
  to the user. The events path acks empty and works asynchronously; a slash
  command wants an immediate acknowledgement plus optional later posts to
  `response_url`.
- **Manifest declaration.** Each command is declared under `features.slash_commands`
  in the app manifest (name, request URL, description). The manifest builder
  (`buildSlackAppManifest`) would grow a `slash_commands` block, and adding one
  forces an app reinstall.
- **A command-to-target map.** New config: which `/command` fires which workflow
  or messages which assistant, per org, with a UI to manage it. This is the bulk
  of the work and has no analog in the event rail.
- **A new body branch.** The webhook route detects Events API JSON and
  interactivity `payload=` bodies today; a `command=` form body is a third
  branch with its own verification-then-dispatch path.

**Decision: fast-follow, not in this issue.** Slash-command routing is a feature
with its own config, UI, and manifest surface, not a trivially reusable
extension of the event rail. The issue's open question set the same bar ("land
in this issue if plumbing is trivially reusable, otherwise fast-follow"). The
signature and workspace-scope machinery are reusable; the target-mapping and
synchronous-response surfaces are new. File a follow-up issue for System B, and
a separate one for System A if in-app command routing is wanted.

## What changed

- `packages/api/src/events/ingest.ts` — match-gates persistence for every
  event, not only `ephemeral` keys (the privacy change above).
- `packages/engine/src/valet-plugin.ts` — removed the now-unused `ephemeral`
  flag from `EventCatalogEntry`.
- `packages/plugin-slack/src/triggers.ts` — added the `slack.app_mention`
  trigger def and its summary case; refactored the defs to a spec table;
  exported `slackTriggerEventTypes`; dropped the `ephemeral` marker.
- `packages/plugin-slack/src/plugin.ts` — re-exported `slackTriggerEventTypes`.
- `packages/api/src/services/slack-app.ts` — `SLACK_BOT_EVENTS` subscribes to
  every trigger event type.
- Tests: `packages/plugin-slack/src/triggers.test.ts`,
  `packages/api/src/services/slack-app.test.ts`,
  `packages/api/src/routes/slack-webhook.test.ts`,
  `packages/api/src/routes/events.e2e.test.ts` — coverage for `app_mention`, the
  manifest drift guard, end-to-end `reaction_added` / `app_mention` ingest and
  delivery, and the drop-not-store behavior for filter-excluded GitHub and
  Linear events.

## Out of scope

- Outbound Slack actions from workflows (existing plugin actions).
- Retro-triggering on historical events.
- Slash-command routing (System A and System B above).
- Multi-org workspace resolution (the deployment resolves one org, per
  `lib/org.ts`; the webhook route notes the single lookup a multi-org deployment
  would add).

## Third-party bot messages

Valet keeps `slack.message` for human messages. It adds `slack.bot_message` for signed Slack `message` events with subtype `bot_message` or no subtype. Slack uses the latter shape for modern bot posts. The trigger requires a nonempty canonical bot ID. It uses `bot_id`, or `bot_profile.id` when Slack omits `bot_id`. It does not use a display name.

The connect check stores the installed bot ID as credential metadata. The bot trigger rejects that ID and the installed bot user ID. This rule is independent of subscription filters. For a legacy credential without the bot ID, the webhook resolves identity through Slack `auth.test` with the saved token. This lookup runs only for eligible bot messages, after signature and workspace verification and outside the acknowledgement path. A valid response must match the stored workspace and any stored bot user ID. The existing subscription then works without a reconnect. Human messages do not require this lookup.

The resolver shares concurrent lookups and caches successful results for ten minutes. Failed lookups have a one-minute retry delay. The cache belongs to the credential-store instance and includes the org, token, workspace, and stored bot user ID in its fingerprint. A credential change invalidates the cached identity. The resolver does not rewrite stored credentials, so it cannot overwrite a concurrent reconnect. If identity remains unknown, bot messages still fail closed. Subscription filters alone do not prove that the sender is a different bot.

For an enabled bot-message subscription, the webhook records `slack_bot_identity_missing` when the installed bot ID is missing and automatic resolution fails. It retains bounded metadata and applies the existing throttle. Team-owned bot subscriptions do not require a linked human sender for this diagnostic, matching bot-event delivery. For all owner types, an event excluded by every named subscription produces a diagnostic without message metadata. When a filter matches, the Problems record includes the channel and bot ID so channel-scoped queries can find it.

Before the catalog exposes this key, startup expands existing `slack.*` subscription rows to the prior explicit Slack keys. Those rows do not begin to match bot messages. The Slack manifest stays unchanged because both classifiers use the existing raw `message` subscription.


Accepting subtype-less posts intentionally expands the events delivered to existing `slack.bot_message` subscriptions. An unfiltered subscription receives every eligible third-party bot post. Before rollout, inspect enabled bot subscriptions and add channel or bot ID filters where that broader behavior is unwanted. No subtype compatibility guard is applied: both Slack payload forms represent bot posts. Production subscription rows have not been inspected as part of this change.

### Receipt diagnostics and legacy bot identity

Resolve the saved bot identity before classifying a bot message. Keep classification stages in the event receipt. If identity resolution fails, emit only the subscription-scoped identity diagnostic. Do not add a duplicate generic rejection to the drop log.
