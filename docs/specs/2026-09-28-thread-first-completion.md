# Thread-first completion

Status: implementation in progress. The user approved completion of the remaining refactor and its validation.

## Contract

Threads are the public conversation address. Session IDs remain internal execution and sandbox boundaries. Existing session API routes and CLI commands remain compatible; the new routes delegate to existing operations instead of duplicating execution logic.

Thread lookup must join its runtime and restrict by authenticated organization before applying existing visibility and action authorization. A URL thread cannot be overridden by a body or query field. A decision addressed through a thread must belong to that thread. Team keys must retain the same restrictions as the compatible session operation.

Workspace lists and creation use the existing personal/team runtime. Existing helper and workflow conversation lifetimes remain unchanged. New workflows get their own conversation; reopening a workflow resumes it.

## Implementation sequence

1. Add thread-rooted HTTP addressing and CLI commands. Preserve legacy entry points. Test ownership, org boundaries, conflicting addresses, and equivalent responses.
2. Switch primary web links and user-facing terminology. Keep redirects for existing links and preserve sandbox configuration semantics.
3. Implement a structured workflow trigger/result proposal with editable review. Reuse subscription and schedule controls. A Slack thread follow action supplies a starting configuration. Proposal review precedes enabling delivery or schedules.
4. Bind routing and authorization invariants to acceptance tests, including restart, duplicate delivery, membership changes, child isolation, and compatibility. Run targeted suites, typecheck, and the full e2e scorecard. Record failures without claiming coverage.

## Review boundaries

Configuration review is separate from a human approval checkpoint and reusable action permissions. Existing grants remain workflow-scoped. Proposed delivery must never expand authority. A rejected proposal creates no enabled routing. Repeated confirmation must not duplicate a subscription or schedule.

## Completion evidence

Each step must record the actual implementation and test results. A ticket moves to complete coverage only when its remaining acceptance criteria are met. Existing incomplete notification and child-approval behavior must remain explicit until validated.

## Checkpoint implementation

The HTTP adapter supports workspace thread creation/listing, durable thread lookup, history and prompt submission, archive updates, abort/resume, and thread-scoped decisions. It delegates mutations to existing session handlers. Workflow-agent threads retain decision-only access through existing workflow-run authorization.

The CLI adds `threads list|new|show` and resolves `send`, `chat`, and `gates` from `--thread`. Legacy session commands remain available. The web adds `/threads/:threadId` and reuses the existing detail view for both routes. Assistant links and parent breadcrumbs now use thread addresses.

Fresh-database testing found missing statement separators around the workflow grants table and index. The baseline migration now includes those separators. Typechecking also exposed two existing web prop/ref mismatches and an untyped notification query; these are corrected without changing execution semantics.

## Remaining acceptance work

| Area | Status at this checkpoint |
| --- | --- |
| Thread API and main CLI commands | Implemented; focused tests pass. |
| Primary thread web route | Implemented using the existing detail component; compatibility route retained. |
| All public entry points and terminology | Incomplete. Audit remaining session links, status/upload commands, and transport-facing interfaces. Preserve runtime-wide sandbox semantics. |
| Structured subscription proposal | Not implemented. Existing assistant instructions do not meet the review contract. |
| Follow a Slack thread preset | Not implemented. Reuse existing event filter and subscription controls. |
| Full routing/authorization matrix | Incomplete. Focused ownership tests do not establish all channel, child, key, and authority combinations. |
| Restart, reconnect, replay, rollback | Incomplete. Cache eviction verifies durable history retrieval, not process restart or rollback. |
| Child approvals to parent and Slack | Not established by this checkpoint. UI cards alone do not prove delivery. |
| Shared assistant panel | Implemented before this checkpoint; both hosts reuse the same transcript and composer. |

Do not move partially covered tickets to complete coverage based on this checkpoint. The remaining product work and validation must be tracked separately from passing typechecks.

## Validation evidence

- Six focused API/CLI files passed, 51 tests. Two additional send-selector tests passed afterward (24 tests in that file).
- The thread integration test passed again after adding removed-team-membership rejection and title persistence assertions.
- API and web typechecking passed. API typechecking also passed after the title persistence fix.
- Read-only review identified title persistence in the shared create handler. The fix validates and stores the title before returning it.
- The full `make e2e` scorecard is running. A clean scorecard is not yet established.
- Local browser verification is blocked: the existing PGlite database fails startup with an invalid checkpoint record. Reproduced on a copy at `/tmp/valet-refactor-pg-backup-1790654216`; the original database is preserved. Fresh test databases boot successfully. This does not establish recovery for the local data.
