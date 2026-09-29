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

The latest full command was `mise x node@22 -- make e2e E2E_ARGS="--verbose"`.
The run ended with **27 stages passed, 1 failed, and 9 skipped**.
The full log is `/tmp/valet-wrapup-e2e.log`.

| Check | Evidence |
| --- | --- |
| Root test sweep | 817 files passed, 17 skipped; 11,118 tests passed, 65 skipped. |
| Static/build | Typecheck, web build, API bundle, conventions, and docs checks passed. |
| Docker | Browser, sandbox, workspace preparation, and prebuild stages passed. Nested execution now probes filesystem execution before selecting fuse-overlayfs. |
| Kubernetes | Lifecycle, execution, provider, conformance, and real image build stages passed after local disk repair and expansion. The image test requires a successful push. |
| PostgreSQL | Store and API stages passed using an isolated temporary database and a free loopback port. |
| Gateway | One WebSocket handshake failed with `socket hang up`. A targeted rerun and 20 subsequent complete gateway runs passed. The intermittent failure remains unexplained. |
| Credential-dependent stages | Nine stages skipped for missing credentials or opt-in. A passing stage can also contain skipped tests; the nested-Docker-specific suite skipped its tests. |
| Bounded rollback | Four processes exercised old code, current code, old code again, and current verification against one isolated database. See the rollback record. |

## Deployment

Railway builds the committed snapshot with the shared API Dockerfile and a service-specific cache ID.
A clean production build found an undeclared `zod` import in the web package.
The web package now declares this dependency directly; existing local dependencies had concealed the missing declaration.

## Evidence boundaries

Live Slack delivery and a real Slack button interaction remain unverified pending installation of the XORS app.
Local signed-request and transport fixtures prove routing and authorization, not live provider availability.

The rollback harness exercises actual prior service and storage code in separate processes.
It does not exercise a complete prior API and web deployment.
See [bounded rollback validation](2026-09-29-thread-rollback.md).

Local browser verification remains blocked by an invalid checkpoint record in the existing PGlite database.
Fresh test databases boot. The original database remains untouched; recovery is not verified.

The local Kubernetes disk now has free space and reports `DiskPressure=False`.
The repaired disk has a retained backup. No user containers or volumes were deleted.

Ticket coverage must follow these boundaries. Do not report skipped checks or local fixtures as live-provider acceptance.
