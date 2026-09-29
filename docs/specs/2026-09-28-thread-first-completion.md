# Thread-first completion

Status, 2026-09-29: remaining product work implemented and reviewed. Functional checks pass after repairs; the full scorecard is not clean because of the infrastructure failures below.

## Contract

Threads are the public conversation address. Runtime IDs remain execution and sandbox boundaries. Existing session API routes and CLI commands stay compatible. Thread routes delegate to existing operations instead of duplicating execution logic.

Thread lookup joins its runtime and restricts by authenticated organization before applying visibility and action authorization. A URL thread cannot be overridden by a body or query field. A decision addressed through a thread must belong to that thread. Team keys retain the restrictions of the compatible session operation.

Workspace lists and creation use the existing personal or team runtime. New workflows get their own conversation; reopening a workflow resumes it. Ask Valet and workflow editing share the assistant panel, transcript, and composer.

## Implemented scope

| Area | Implementation and evidence |
| --- | --- |
| Thread API and CLI | Workspace thread creation/listing, lookup, history, submission, archive, abort/resume, and decisions reuse existing handlers. CLI thread commands and `send`, `chat`, `gates`, `status`, `upload`, and `handoff` accept thread addresses. Legacy runtime commands remain supported. |
| Entry points and terminology | Conversation links use `/threads/:id`, including workflow checkpoints and parent breadcrumbs. User-facing conversation labels say thread. Sandbox, grants, and other runtime-wide operations retain their real scope. Wire identifiers remain compatible. |
| Structured trigger/result review | Assistant proposal tools save paused records. Shared review shows When, Scope, Result, Destination, Permissions, and applicable delivery/audience settings. Existing edit endpoints apply changes and explicit activation together. |
| Subscribe to thread | The existing automation form accepts a Slack thread link and sets exact channel and parent timestamp filters. It does not create an extra follow binding. |
| Routing and authorization | Tests cover fanout, event deduplication, membership changes, org isolation, team keys, sibling decisions, workflow ownership, and personal delivery precedence. |
| Restart and compatibility | On-disk database reopen preserves identity, history, follow bindings, and gate addresses. Engine child-process SIGKILL tests cover pending decisions and queues. Legacy and thread addresses expose compatible history and authority. |
| Child approvals | Connected tests route a child gate through its parent audience to a Slack-shaped transport, restore the callback after host restart, deny an outsider, and resolve only the child gate. |

Configuration review is separate from human approval checkpoints and reusable action permissions. Workflow grants remain workflow-scoped. Proposals never grant access or enable routing. Repeated proposal keys return the existing record without changing it or creating duplicates.

The acceptance work corrected missing runtime creation for new teams, approval buttons lost after channel-host restart, and duplicate message/follow delivery. It reuses the existing subscription, schedule, and decision-reference storage; no additional schema or execution path was introduced.

## Design and acceptance records

- [Proposal interaction contract](2026-09-29-automation-proposals-design.md)
- [Thread entry points and terminology](2026-09-29-thread-entrypoints.md)
- [Routing acceptance matrix](2026-09-29-routing-acceptance.md)

## Validation

The full command was `mise x node@22 -- make e2e E2E_ARGS="--verbose"`.
The recorded run ended with **22 stages passed, 6 failed, and 9 skipped**.
It exposed stale test contracts in earlier UI refactor changes. Those tests now
exercise the current controls and scope boundaries; a checkpoint link was also
changed to use its Thread address.

| Check | Final evidence |
| --- | --- |
| Root test sweep after repairs | 816 files passed, 17 skipped, 1 failed. 11,117 tests passed, 65 skipped; the only failure was the live Kubernetes build remaining in `building`. The attempted CLI exclude did not remove that project test, so it ran again. |
| CLI with a real local server | 9 passed, 3 credential-dependent cases skipped. Verifies legacy handoff, canonical receipt URL, `status --thread`, and continuing `handoff --thread` in the same conversation. |
| API integration | 202 passed, 4 skipped in the full scorecard. |
| Real PostgreSQL | Initial stage could not bind occupied port 5433. Repeated its store and API commands against a fresh temporary database on a free loopback port: 282 store and 180 API tests passed. The temporary container was stopped. |
| Static/build | Root typecheck, web production build, API bundle, conventions, and docs checks passed. Typecheck and docs checks passed again after the final repairs. |
| Other scorecard stages | Engine, workflow, browser runtime, gateway, plugins, local sandbox, PGlite, Helm, Docker workspace preparation/prebuild, and Keycloak stages passed. A passing stage can contain internally skipped tests. |
| Docker browser | Reproduced failure in the nested Docker check: `busybox:stable echo` exits 255 with `exec /bin/echo: invalid argument`. The scenario without nested Docker passed. This script and sandbox implementation have no changes in this PR. The failure remains unresolved. |
| Kubernetes | Lifecycle readiness failed and the image build could not schedule on the disk-pressure node. After recording evidence, the blocked sandbox stage and repeated build stage were interrupted and remain failed. No cluster data cleanup was attempted. |
| Credential-dependent stages | Nine stages skipped for missing provider credentials or opt-in. They are not passing evidence. |

Logs:

- Full scorecard: `/tmp/valet-final-refactor-e2e.log`
- Root follow-up: `/tmp/valet-final-unit-rerun.log`
- CLI follow-up: `/tmp/valet-final-cli-rerun.log`
- PostgreSQL follow-up: `/tmp/valet-final-postgres-rerun.log`
- Docker browser follow-up: `/tmp/valet-final-browser-rerun.log`
- Node scheduling evidence: `/tmp/valet-scorecard-k8s-blocker.txt`

## Evidence boundaries

Live Slack delivery and a real Slack button interaction were not exercised. Local signed-request and transport fixtures establish routing and authorization, not installation permissions or provider availability. Older-binary rollback was not exercised.

Local browser verification remains blocked by an invalid checkpoint record in the existing PGlite database, reproduced on a preserved copy at `/tmp/valet-refactor-pg-backup-1790654216`. Fresh test databases boot. The original database remains untouched; recovery is not verified.

The local Kubernetes node reports `node.kubernetes.io/disk-pressure`, preventing pods from scheduling. Infrastructure outcomes must remain distinct from the refactor's deterministic acceptance results. A build test that accepts a terminal failure does not prove a successful image build.

Ticket coverage must follow these boundaries. Passing typechecks or transport fixtures alone must not be reported as full live-provider or rollback acceptance.
