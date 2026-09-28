# Threads and Events local iteration

Status: workspace singleton, shared threads, discovery, and notification routing implemented locally.

## Confirmed direction

Each personal or team workspace has one assistant. The assistant is an internal
runtime identity. Users work with workspace-owned threads, workflows, subscriptions,
and memory. Assistant selection and profile customization are not product features.

This is a development environment. Backward compatibility and production migration
are not required. Keep session internals where they enforce execution, sandbox,
credential, or authorization boundaries. Do not replace those boundaries with labels.

Sources:

- TKAI-559: https://linear.app/turnkey/issue/TKAI-559
- TKAI-557: https://linear.app/turnkey/issue/TKAI-557
- TKAI-558: https://linear.app/turnkey/issue/TKAI-558
- TKAI-535: https://linear.app/turnkey/issue/TKAI-535
- TKAI-363: https://linear.app/turnkey/issue/TKAI-363
- September 25 proposal: https://turnkeycrypto.slack.com/archives/D0BA9F58SRM/p1790389511254639
- Xiangan's September 27 clarification: singleton workspace assistants, no customization,
  no backward compatibility, and local verification before further iteration.

## Implemented behavior

- Threads replaces Chat in navigation. Sessions and Artifacts leave primary navigation.
- Work and artifacts in Threads opens isolated execution details through existing routes.
- Problems shows recorded explanations, references, and accurate coverage limitations.
- Personal and team initialization uses the existing atomic default resolver.
- Custom profile creation, editing, deletion, avatar, and direct-open routes are removed.
- Agent tools cannot create or modify assistant profiles.
- Chat URLs use workspace and thread identity. Both rail and page share an owner-addressed ensure.
- The workflow editor resolves its owning workspace and adopts that scope in navigation.
- Event, follow, and scheduled-prompt delivery uses the workspace singleton.
- Workflow definitions and subscription writes reject assistant overrides.
- Notification links and attention sounds identify the destination workspace and thread.
- Seeded examples use the actual REST history, workflow, and diagnostics surfaces.

## Reuse map

| Concern | Existing implementation | Decision |
| --- | --- | --- |
| Transcript, composer, thread tree | Web session components | Reuse |
| Durable history, submissions, thread creation | Engine Thread and SessionStore | Reuse |
| Workspace scope and resource adoption | Web workspace-scope | Reuse |
| Singleton runtime | API atomic default-assistant resolver | Reuse |
| Child execution and sandboxes | Engine sessions and providers | Preserve isolation |
| Workflow execution | DAG interpreter and run checkpoints | Reuse |
| Event delivery | Matcher, dispatcher, retries, deduplication | Reuse |
| Problem records | event_drop_log and Events UI | Improve coverage and presentation |

## Invariants

- Personal and team authorization comes from the server, never from the URL alone.
- A failed team lookup must not open personal history.
- Session credentials, sandbox ownership, transcript ancestry, and gate authority remain intact.
- A notification preference changes delivery, not authorization.
- Local fixtures do not establish whether Slack delivered a production message.
- Do not connect local Slack or send external notifications during this review.

## Events and notifications

The existing automation wizard and advanced subscription editor remain the event
configuration surfaces. They use validated workspace ownership and cannot select
an assistant. No second matcher or delivery engine was introduced.

Problems shows recorded receipt, classification, matching, and delivery stages.
Slack classifier rejections now record bounded metadata without raw message bodies
or credentials. A missing record does not prove that Slack delivered an event.

Team administrators can choose a Slack home channel. New team attention uses that
channel, with generic links that keep content and approval controls behind web
access checks. Replies stay in the originating Slack thread. Choosing a home
channel does not subscribe to every message in it.

Personal team DM copies are opt-in by notification kind. Delivery verifies current
team and organization membership. Preferences do not change team access or approval
authority. Team deletion reviews remain web-only under their existing policy.

## Verification

Verify singleton initialization under concurrency, cross-owner denial, workspace
switching, deep links, workflow origins, retries, and persistence after restart.
Run the canonical scorecard and identify each environmental failure separately.
Exercise the local APIs and a workflow with a real model response.
Browser automation was unavailable in this session; browser review remains manual.
Live Slack ingress remains unverified in this local environment.

Local review fixtures are created with `node scripts/seed-threads-demo.mjs review`
after bootstrap and workflow seeding. The command creates standalone work, an
artifact with a thread origin, and the shared workflow editor conversation. It
sends no model prompt and makes no Slack connection. The separate workflow run
check uses the real Thread node and model response.

## Structure review and next decisions

The current structures already separate ownership, execution, and conversation:

| Structure | Current responsibility | Recommended role |
| --- | --- | --- |
| Personal or team owner | Authorization, credentials, resource visibility | Own threads, workflows, subscriptions, and memory |
| Assistant row | Runtime identity and default resolution | One internal identity per workspace; no selectable profiles |
| Session | Runtime resources, sandbox, credentials, gates, child execution | Keep as an execution boundary below the Threads UI |
| Thread | Transcript, queued submissions, activity, cancellation | Primary conversation visible to the user |
| Workflow definition | DAG configuration and owner | Reusable workspace-owned automation |
| Workflow run | Immutable definition snapshot, checkpoints, outcomes | One execution with links to its working threads |
| Event subscription | Matching, authorized owner, delivery target | Route by workspace; keep delivery diagnostics separate from conversation history |

### Workflow Thread node

The Thread node now replaces the orchestrator workflow node. It reuses
durable submissions, dispatch deduplication, checkpointing, waiting, and
output-schema repair. The API already chooses an attended origin thread or
a thread associated with the workflow run.

Keep the LLM node for a single model completion. It does not have a transcript
or the durable submission lifecycle. Converting it to a conversational node
would change cost, context, retries, and tool behavior.

Current behavior and future decisions:

- Use one shared thread per workflow run by default, or isolate each node.
  The current implementation shares a run thread, including loop iterations.
- Keep completed workflow threads visible, or archive them automatically.
  The current implementation archives run-created threads after settlement.
- Node results expose `threadId` in both dispatch-only and settled modes.
  Later steps can reference it as `nodes.<id>.result.threadId`. Explicitly
  selecting arbitrary existing threads is outside this iteration.
- Keep output delivery separate from execution context. A team home channel
  should not silently move an existing Slack conversation or broaden access.

The workflow editor opens `POST /api/workflows/:id/conversation`. The server
checks workflow access and resolves the owner’s singleton runtime. The durable
thread key is `workflow:<id>`. Team members share this thread across browsers.
Concurrent opens converge through engine creation coalescing and the store’s
unique session/key constraint. Opening the editor sends no automatic prompt.
The server adds workflow context to each editor thread’s system prompt.
Workflow tools still enforce access for every read and write. The client
revalidates access on mount and offers Retry after a failed request.

### Cutover implemented in this iteration

Workspace URLs now govern chat and workflow-editor routing. Assistant editor
and list pages, identity forms, and assistant-selection hooks were removed.
Event and scheduled-prompt routing resolves the owner's default runtime.
Writes reject assistant overrides on subscriptions, schedules, and workflows.
Notification links address the workspace and thread. Attention sounds compare
both so an approval in another conversation is not silently suppressed.

The database enforces one assistant identity per workspace, including retired rows.
The old default flag and assistant selectors on schedules and followed threads are
removed. Profile creation, editing, avatar, deletion, and direct-open routes are
removed. Session deletion cannot retire a workspace runtime. Team deletion remains
the explicit lifecycle operation. Internal runtime IDs still address execution;
they do not select ownership or expose customizable assistant profiles.

This is a development cutover without backward compatibility. Existing databases
with duplicate workspace profiles require a reset or explicit data repair. The
cutover never silently deletes their conversation history.

### Work and artifact discovery

Threads includes a Work and artifacts view. It lists standalone work and child
executions in the selected workspace. Each row opens the existing runtime detail
view, with its original sandbox and credentials. Archived executions remain visible.

Discovery requires an explicit owner. The server verifies access and returns at
most 100 rows per request. The UI requests 25 rows and loads more on demand.
Creation time and ID provide stable pagination. Cursors are bound to the owner.

Each work row can expand its published artifacts. Thread views show artifacts
from that transcript. Publish and memory-share tools store their session and thread
identifiers. The server verifies the source owner, organization, and thread membership
before it records attribution, including internal tool requests. Artifact queries
filter by owner, session, and optional thread before
pagination. Their cursors bind all three identifiers. The workspace gallery links
back to originating work and its thread. Reader comments target that stored thread.
Artifacts without source metadata remain available through the workspace gallery.
Runtime links resolve the owner before redirecting to personal or team Threads.


### Consolidated web routes

Threads owns work discovery and the workspace artifact gallery. Its Work and
artifacts view switches between executions and all workspace artifacts. The gallery
keeps copy, revoke, and pagination controls. A workspace change resets both views.

The standalone `/sessions` and `/artifacts` pages and `/orchestrator` redirect are
removed. Execution detail remains at `/sessions/$sessionId`. Published artifacts
remain at `/a/$token`. Personal thread defaults use `/settings/threads`. Home remains
available as the workspace overview. Removed pages have no compatibility redirects.

### Workspace runtime cutover

Personal and team views use `/api/workspaces/:workspace/runtime`. The personal
workspace uses `user`; teams use their team ID. GET probes, POST ensures the
singleton runtime, and GET `/info` returns presence and active child counts.
Runtime access follows workspace membership. Team API keys can access only their
own team. Explicit team views never query personal runtime presence.

The assistant list API and client caches are removed. Runtime rows retain only
identity, ownership, lifecycle timestamps, and their session address. The migration
drops profile name, avatar, personality, behavior, model, and reasoning columns.
It preserves runtime IDs and conversation history.

Execution uses personal or team model and reasoning defaults. Organization model
tiers, reasoning caps, credentials, and action policy still apply. Owner memory
`assistant/personality.md` supplies optional context with a 500-character cap.
Team and organization outbound messages use the workspace name. Personal messages
use the integration's default bot identity. No per-assistant capability filter or
profile override remains.

### Parent-scoped child work

Home and Threads share `/api/sessions/:sessionId/children`. The parent is always
explicit. The old personal orchestrator and team children routes are removed.
Authorization checks the parent's workspace and organization. Moved child sessions
are excluded from the old parent's list, counts, and dismissal operations.

Child work uses cursor pagination: running first, then creation time and ID in
descending order. Pages default to 25 rows and never exceed 100. The cursor binds
the parent and ordering. Running counts cover the full visible result set.
Threads offers Load more work and deduplicates rows during live status changes.
Dashboard summaries must not infer total running counts from a partial page.

Dismissal requires the explicit parent, a settled child, and current ownership.
It preserves the execution and transcript. Session details provide the parent
session and thread directly, including dismissed work. A workspace move removes
that link unless both sides still have the same owner and organization.

The local child-work seed creates 27 empty execution fixtures. Offline seeding
attaches settled watch records so pagination can be reviewed without running tasks.

### Durable event receipts

Events includes an organization-admin Delivery log. Receipt records retain bounded
metadata for up to seven days, with a 10,000-record organization cap. Search accepts
provider IDs, channel IDs, event keys, and processing outcomes. Pagination binds the
organization and search. Members and team API keys cannot read these organization
wide records, including through a copied cursor.

A Slack receipt is written after signature verification and before acknowledgement.
Each retry gets its own receipt and retains its provider event ID and retry metadata.
Workspace checks, direct-channel processing, classification, subscription decisions,
persistence, dispatch, and followed-thread checks append timestamped stages. A receipt
with no later stage can identify an interruption after acknowledgement. Diagnostic
write failure is logged without exception payloads and does not stop normal processing.

Normalized ingestion also records unmatched keys, disabled named subscriptions,
filter exclusions, sender authorization failures, and deduplication. Failed filters
show field and operator names, never configured or observed values. Matched records
link to Activity for delivery attempts and workflow outcomes. Queued deliveries and
completed routing checks do not imply a completed workflow. Duplicate events link
to the existing event in the same organization.

Receipts retain provider and routing identifiers, classification metadata, bot-identity
availability, byte size, and subscription decisions. They do not retain message text,
blocks, credential headers, signing secrets, or exception payloads. Legacy filtered
Problems also stop retaining message text. Invalid signatures and unconfigured
connections remain in Problems; unverified bodies never enter the receipt log.
An absent receipt does not prove that Slack failed to deliver the event.

The Delivery log shows a one-line summary. Its collapsed About section explains
retention, metadata limits, and missing receipts. It reuses shared search, query,
access, pagination, and UI primitives.

### Workspace catch-up

Home and Briefing share a workspace-scoped catch-up view. Briefing replaces the
Work and artifacts execution list. Activity details remain collapsed below the
briefs. Source pages retain creation and artifact-management controls.

Needs attention uses recorded approvals and failures. A separate paged read of
unsettled submissions includes workspace runtime threads and older child work.
Newer idle sessions cannot hide them. In progress includes active work and waiting workflows. A timer wait does not imply that a person must act.
Idle sessions do not imply completed tasks. Recent results group confirmed PRs,
reviews, messages, and published artifacts with their originating work when known.
Workflow completion remains separate from evidence of an external change.

The outcome API reuses usage facts to locate confirmed action invocations and
terminal outcome markers. It returns bounded labels, source identities, dates,
and safe web links. It adds no event pipeline or persistence table. Existing
workspace authorization and cursor helpers apply to every page. Artifact,
workflow, and session discovery use their existing APIs.

Ticket references appear where the source records them. The view does not infer
that a ticket is resolved from its mention, a successful run, or a created PR.
External PR state and unrecorded follow-up work are outside this first pass.

Run `node scripts/seed-threads-demo.mjs catch-up` against the local API after the
review seed. It creates an approval, a timer wait, a completed workflow, and a
checklist. Stop the API before running `offline` to add labeled outcome fixtures.
These fixtures make no GitHub or Slack changes. Example outcome links use
`example.com`; source and artifact links open real local records.

### Contextual briefings

The primary view groups recent evidence by the underlying goal across conversations and workflow runs.
Each brief has a goal title and one short paragraph with the result and remaining
action. It has no separate context or next-step sections. PRs, artifacts, and runs support that explanation rather than form the page.

The server gathers bounded, authorized conversation and run context, then requests
a short synthesis through the existing model client. A durable workspace cache
stores the evidence hash, generation version, and response. Requests check sources
at most once per minute per workspace. Unchanged evidence reuses the saved brief
across server restarts. An atomic lease coalesces checks across API replicas.
Failed generation backs off before retrying; changed evidence invalidates old links.
Every read checks source ownership and revocation using bounded IDs. It does not
load transcript bodies on cache hits. Workflow heartbeat timestamps alone do not
trigger generation. A short polling interval applies only during shared generation.
The context budget reserves space for workflows, artifacts, and confirmed effects
so conversations cannot exclude all outputs. Model calls have a timeout. Failed generation shows an unavailable state with Retry.
It does not replace a briefing with an invented summary based on titles.

The model references source IDs. The server validates those references and selects
the latest conversation from their recorded timestamps. Every brief with a known
conversation links directly to that thread. A run without a linked conversation
shows that limitation; it never links to an unrelated or newest workspace thread.

Coverage is recent workspace evidence, not complete ticket history. Narrative
claims remain grounded in source records. Local fixtures retain their demo label.
The seed spans two Threads rollout conversations, an NDA request and legal follow-up,
and an intake investigation with two workflow runs.

PR links come from confirmed action results and terminal outcome markers. Explicit
thread, run, and source URL relationships retain outputs omitted by synthesis.
PR links appear before other sources. These records prove creation, not current
open, merged, or review state. Live PR status synchronization remains separate.

Freshness is checked on demand while the page is open. This is a workspace cache,
not a background scheduler or a persistent per-goal index. Changed evidence still
regenerates the bounded workspace synthesis; unchanged page reads do not call a model.
