# Consolidated notifications and child approvals

Status: partial local implementation for visual review.

The Bell now renders workflow and session decisions inline. Pending decisions
remain separate from notification read state. The workflow approval tab is
removed, and Valet Security appears under Plugins. Full validation is deferred
at the user's request. Parent signals and Slack reliability work below remain
proposed. The findings describe the baseline before this local implementation.

## Outcome

The Bell is the common inbox for approvals and notifications across personal and team workspaces.
A child that needs approval must identify its blocker in the parent thread and notify the originating Slack thread.
One decision resolves the same request everywhere.

The reported incident involved an unsigned push, a hidden child approval, and two requests for status.
The supplied conversation does not establish that Justin submitted two approvals.
We need production gate IDs and resolution records to investigate that separate possibility.

## Findings in the current refactor

Inspected branch: `xbalbinus/threads-events-refactor`, commit `835ae998a`.
Existing uncommitted dashboard and discovery changes were left intact.

| Finding | Evidence | Consequence |
| --- | --- | --- |
| Child gates already notify the parent's owner | `packages/api/src/orchestrator/attention-wiring.ts`, `handleDecisionGate` | Replacing audience routing alone will not fix the incident |
| Parent reporting covers settlement | `packages/api/src/orchestrator/children.ts`, `ChildWatcher` | A pending gate does not produce the equivalent parent signal |
| Status collapses unsettled work into running | `packages/engine/src/builtin-tools/index.ts`, `childStatusTool`; `packages/api/src/routes/child-work.ts` | Even a status lookup can describe an approval-blocked child as running |
| Slack prompts use the gate's own thread key | `packages/api/src/channels/host.ts`, `deliverGatePrompt` | A child's default web thread has no Slack route |
| Spawn origin is already durable | `packages/api/src/orchestrator/children.ts`, `childWatches.originJson` | Approval delivery can reuse the route used for child settlement |
| Bell items are navigation links | `packages/web/src/components/layout/notifications-bell.tsx` | Inline decisions are not implemented in this checkout |
| Workflow approval list still exists | `packages/web/src/routes/workflows.index.tsx` | The Bell consolidation is incomplete in this checkout |
| Read state controls actionability | `packages/web/src/lib/use-attention-ping.ts`, `isActionable` | Reading a notification can remove its attention state without answering the gate |
| Notifications return only the newest 50 rows | `packages/api/src/routes/notifications.ts` | Enough new updates can push an unresolved approval out of the response |
| Slack callback references are memory maps | `packages/api/src/channels/host.ts`, `recordGatePrompt`, `gateForRef` | A restart loses the mapping for an existing Slack button |
| Channel delivery is best effort | `packages/api/src/orchestrator/attention.ts`, `routeAttention` | Database row deduplication does not provide channel delivery retries or deduplication |

These are code findings, not proof of the exact deployed failure sequence.

## Recommended approach

Extend the existing attention router into the single owner of notification delivery.
Keep engine gates and workflow gates authoritative for decisions.
Give every notification an explicit source reference instead of reconstructing identity from its row ID or URL.

| Approach | Tradeoff |
| --- | --- |
| Patch child Slack routing and status only | Fast containment, but read-state, restart, and duplicate-delivery gaps remain |
| Extend the attention router and consolidate the Bell | Recommended. Reuses gates, routes, authorization, and notification preferences |
| Build a separate notification service | Adds deployment and consistency work without a need established by this incident |

## What the user sees

The Bell opens an inbox with Needs action and Updates sections.
Pending decisions remain in Needs action after they are read.
The Bell badge counts pending decisions. A separate dot indicates unread updates.
Mark all read changes only read state.

Example, with illustrative labels:

```text
Notifications                         1 needs action

NEEDS ACTION
Approval needed · Valet workspace
Push code without signing
Child: Fix approval delivery
Requested from: Threads / Refactor follow-up
Waiting for you · 12 minutes

[Review request] [Approve once] [Deny]
[Open parent thread] [Open child work]

UPDATES
Workflow completed · Dependency check
```

Expanded approval details show the existing gate context, parameters, and allowed actions.
Do not invent Approve/Deny buttons for gates with different action sets or required inputs.
Reuse existing approval components and confirmation rules in an accessible panel that supports nested controls.

Remove the separate workflow approval inbox after all workflow gate types work in the Bell.
Keep contextual cards in child transcripts and workflow run details as views of the same request.
Home and Briefing link to the Bell's Needs action view.
Workspace labels and filters keep personal and team requests distinguishable.

The parent thread shows a stable status card:

```text
Fix approval delivery is waiting for approval
Push code without signing
[Review in Bell] [Open child work]
```

The card updates to Approved, Denied, Expired, or Withdrawn when that gate settles.
Approval means the resolver accepted the decision. Show Resuming until durable execution state confirms further progress.
An approved gate alone does not mean the command ran or the child completed.

## One request, several views

An engine request references `{ sessionId, threadId, gateId }`.
A workflow request references `{ runId, nodeId, iteration, gateKind }` using the existing workflow identity rules.
Recipient rows reference this request and retain their own `readAt` values.
They do not own gate status or approval authority.

Resolve current source state and access on inbox reads and decision attempts.
List pending requests independently of recent updates, with pagination and a total pending count.
Live events invalidate this state; reconnect and page load read the authoritative API.
An open child socket is not required to see its approval.

Notification preferences govern alerts and delivery copies.
They must not hide unresolved requests from the authorized Needs action inbox.
Settings must explain this distinction because users can currently disable web notifications by kind.

All web and Slack actions call the existing authorized resolver for the source gate.
Concurrent clicks return the recorded outcome after the first accepted decision.
No delivery copy creates a second gate or broadens an approval into a reusable grant.
Changed arguments, a new invocation, or a new workflow iteration can legitimately require a new decision.

## Parent awareness and accurate status

Project child status from durable submissions and pending gates, not from `childWatches.settled` alone.
Expose queued, running, waiting for approval, other waiting, and settled states where the engine can distinguish them.
Return unknown when the read fails. Do not report running as a fallback.
Use the same projection in `child_status`, the child-work API, and parent status cards.
Include gate summaries, waiting-since timestamps, and links for pending decisions.
Status reads must not wake, steer, or restart the child.

Persist a deduplicated `child.attention_required` signal on the originating parent thread.
Include the child identity and the original gate reference; never copy the gate.
Render the status card directly so notification delivery does not depend on another model turn.
Make the signal available to the parent agent, with instructions to read current status before reporting progress.
If a parent is itself delegated, propagate through verified ancestry with cycle protection.
Keep the same request identity and deduplicate destinations along that path.

Do not use `child_send` for a status check.
Its default behavior supersedes the current submission and withdraws a pending approval.
That behavior can produce a replacement request, but it is not a confirmed cause of this incident.

## Slack delivery

Resolve destinations once in the attention router:

1. Use the source submission's verified channel origin when it has one.
2. For delegated work, use the persisted spawn origin associated with that work.
3. If no origin exists, apply the existing team home-channel and personal delivery rules.

Do not infer a Slack origin from the latest message in a parent thread.
Preserve the web-origin rule: a web submission does not inherit an unrelated Slack conversation.
Validate current ownership, organization, ancestry, and destination scope before sending.
If origin validation fails, keep the web request visible and record the delivery failure.

Send one approval card to the originating Slack thread.
Use the same original gate ID and existing callback authorization.
Team home-channel fallback keeps its generic web link; it does not expose sensitive request details or decision controls.
Personal team DM copies remain opt-in. The router deduplicates identical destinations.
The parent agent must not send a second approval prompt for the same signal.

## Delivery and restart recovery

Keep durable delivery records per request, destination, and message purpose.
Store attempts, outcome, provider message reference, and the next retry time.
Persist Slack message-to-gate references so callbacks survive API restarts.
Keep terminal outcomes long enough to answer stale buttons and update every delivered card.

The existing event stream persists events, but its subscribe callback alone does not replay them.
Use a durable consumer checkpoint or transactional delivery intent to close the persistence-to-notification crash window.
Establish this guarantee before claiming reliable delivery.
Retry delivery work through that owner, with visible failures and bounded backoff.
Do not add a timer that silently changes gate or submission state.

Before a send, check current gate state.
After recording the provider reference, check again and update the card if the gate became terminal during the send.
Handle resolved, expired, and withdrawn outcomes through the same path.

An external send can succeed before the delivery worker records its acknowledgement.
Use provider idempotency or reconciliation where supported; do not promise exactly-once Slack delivery without verifying that contract.
Duplicate cards must still resolve the same gate at most once.

## Delivery slices

1. Correct child status and add parent attention signals with verified spawn-origin routing.
2. Add explicit request references and persistent Needs action queries; put existing decision controls in the Bell.
3. Persist channel delivery and callback references; test restart, retry, and terminal-state races.
4. Remove redundant approval inboxes and align Home, Briefing, badges, and notification settings.

The first slice addresses the immediate incident. The full reliability claim requires all slices.
Use fake channel transports for local verification. Do not send Slack messages during this review.

## Acceptance scenarios

| Scenario | Required result |
| --- | --- |
| Slack parent spawns child; child requests approval | One Bell request, parent status card and signal, one origin-thread delivery |
| User asks for status while the child is blocked | `child_status` reports waiting for approval, with the blocker and link |
| User reads or marks all notifications read | Pending approval stays in Needs action |
| More than 50 new updates arrive | Older unresolved approvals remain reachable and counted |
| Child is unopened or browser reconnects | Pending decisions load through the API |
| Bell and Slack resolve concurrently | One decision wins; both surfaces show the recorded result |
| API restarts after Slack delivery | Existing button resolves the original pending gate |
| Process stops after gate persistence | Durable delivery processing recovers the missed notification |
| Slack send fails | Bell remains actionable; delivery failure is visible and retried |
| Gate expires or is withdrawn during Slack send | Posted card becomes terminal and cannot decide a replacement gate |
| Team membership or child ownership changes | Old recipients cannot inspect or resolve through stale links |
| A later tool call needs approval | New request explains its own invocation; previous approval remains resolved |
| Child completes after approval | Parent receives the existing settlement signal and accurate final state |

## Evidence and limits

The existing API attention suites passed: 24 tests across `attention.test.ts` and `attention-wiring.test.ts`.
The existing web Bell and attention-ping suites also passed: 31 tests, for 55 passing tests in total.
These establish existing audience and notification behavior, not the proposed end-to-end behavior.
We have not verified live Slack delivery or Justin's specific execution.
Implementation must pass the full application scorecard. This draft makes no completion claim for product changes.

For the incident investigation, correlate source gate ID, submission ID, tool-call identity, resolution time, and delivery references.
That distinguishes duplicate display, a failed callback, and a legitimate second request without changing approval policy on a guess.
