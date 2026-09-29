# Thread routing acceptance evidence

Date: 2026-09-29. This document records deterministic acceptance tests for the Threads refactor. It does not replace the full e2e scorecard.

## Acceptance matrix

Paths below are relative to `packages/api`, unless they name another package.

| Contract | Executed evidence | Result and boundary |
| --- | --- | --- |
| One provider thread has one conversation identity | `src/channels/host.test.ts`: concurrent channel and event admission; duplicate dispatch. `src/events/channel-origin.test.ts`: provider key and message timestamp. | Pass. Transport contract tests use local doubles. |
| Conversation identity survives reopening storage | `src/events/thread-reopen.test.ts`: close on-disk PGlite, rebuild all providers, reopen the same Slack key. | Pass. Session ID, thread ID, history text, pending gate, follow binding, and gate prompt address survive. This is a clean database reopen, not a killed API process. |
| Matching events fan out independently | `src/events/ingest-receipts.test.ts`: assistant plus two workflow destinations; disabled rule excluded; duplicate provider event adds no deliveries. `src/events/collisions.test.ts`: workflow fanout rules. | Pass. Workflow execution is separately covered by dispatcher tests. |
| Message subscriptions do not create duplicate follow delivery | `src/events/dispatcher.test.ts`: a stored `slack.message` target with `follow: true` still creates no follow binding. | Pass. Only `slack.app_mention` deliveries may establish a follow binding. |
| WebSocket reconnect preserves durable event order | `test/ws-resume.test.ts`, `src/routes/ws.seed.test.ts`, `src/routes/ws.lifecycle.test.ts`. | Pass. Tests cover replay, initial state, and lifecycle contracts. |
| Personal delivery precedence uses current team coverage | `src/events/dispatcher.test.ts`: always, own-team, any-team policies; disabled and foreign-org coverage; retry after rule changes. | Pass. Overlap skips one delivery without pausing its subscription. |
| A revoked member cannot retain event authority | `src/events/team-slack-gate.test.ts`: team removal, org removal with stale team row, queued dispatch, replay matching, unlinked sender. | Pass. Denied payloads do not become diagnostics. |
| Provider installation and organization stay isolated | `src/routes/slack-webhook.test.ts`: signed foreign/missing workspace, invalid signature, provider retry. `src/events/ingest-receipts.test.ts`: cross-org dedupe collision. | Pass. Signed request fixtures exercise HTTP ingress; no live Slack installation was used. |
| Thread addresses cannot escape workspace ownership | `src/routes/threads.test.ts`: foreign user, removed team membership, foreign org, missing ID, body/query address conflicts. | Pass. Existing session authorization remains authoritative. |
| Team keys keep their own scope and cannot grant org policy | `src/routes/threads.test.ts`: real sign-up, team key, team thread creation, personal thread denial, always-allow denial. | Pass. Both legacy and thread decision routes deny the policy grant. An ordinary approval succeeds. |
| Decisions remain inside their URL conversation | `src/routes/threads.test.ts`: two sibling threads; another thread's gate is absent from listing and cannot resolve. | Pass. The denied attempts leave the gate pending. |
| A child approval reaches its parent's audience and remains a child decision | `src/channels/host-outbound.test.ts`: actual child tool gate, attention router, Slack-shaped transport, host restart, outsider denial, authorized callback. `src/orchestrator/attention-wiring.test.ts`: parent audience and notification routing. | Pass. Only the child gate resolves; the parent has no gate. This proves transport integration, not live Slack delivery. |
| Existing channel buttons survive host restart | `src/channels/host-outbound.test.ts`: new ChannelHost restores the saved prompt address before callback; no new card. `src/events/thread-reopen.test.ts`: prompt address survives disk reopen and excludes another org. | Pass. Callback authorization still reads current ownership. |
| Offline gate settlement clears old buttons | `src/channels/host-outbound.test.ts`: resolved, expired, and withdrawn gates while channel host is stopped. | Pass. Boot edits the card and removes its saved address. |
| Provider message IDs are scoped to conversations | `packages/store-postgres/test/gate-ref-address.test.ts`: equal message IDs in two conversations. | Pass. Both references persist. |
| Queue, pending decisions, and tool effects recover after a process crash | `packages/engine/test/kill-mid-gate.test.ts`, `kill-mid-turn.test.ts`, `queue-modes.test.ts`. | Pass, 23 tests. Real child processes receive SIGKILL and reopen on-disk storage. Models and sandboxes are deterministic doubles. |
| Workflow ownership and origin rules remain compatible | `src/workflows/assistant-routing.test.ts`, `service.checkpoint-thread.test.ts`, workflow callbacks in `host-outbound.test.ts`. | Pass. Covers team principals, departed members, origin thread preservation, archived origins, cross-org callbacks, and concurrent callback resolution. |
| Legacy history and decisions remain compatible | `src/routes/threads.test.ts`: identical history through session and thread addresses; legacy policy denial. | Pass. No destructive migration or legacy data rewrite was required. |

## Defects corrected

A new team reserves its assistant identity before its runtime exists. The thread adapter previously forwarded creation to that missing runtime and returned 404. Creation now ensures the runtime. Listing an unused workspace returns an empty list without materializing it.

ChannelHost previously kept gate prompt addresses only in memory. Existing channel buttons expired after restart. It now writes the existing `engine_decision_gate_refs` table and restores organization-scoped addresses before ingress starts. Each callback still checks current authorization. Startup clears cards whose gates settled while delivery was offline.

The durable reference ID now includes its conversation address. Provider message IDs alone do not identify a message across conversations. No schema change or database wipe is required.

Only Slack mention deliveries can establish a follow binding. A message subscription already delivers later replies. Creating a binding from it would duplicate delivery.

## Recorded runs

- Final API reconnect, outbound delivery, reopen, ingest, and thread routes: 7 files, 100 tests passed. Log: `/tmp/routing-final-tests.log`.
- API routing baseline: 13 files, 243 tests passed. Log: `/tmp/routing-acceptance-tests.log`.
- Database reopen and workflow ownership: 2 files, 10 tests passed. Log: `/tmp/routing-reopen-tests.log`.
- Channel delivery after persistence changes and database reopen: 2 files, 73 tests passed. Log: `/tmp/routing-gate-final-tests.log`.
- Child restart and offline terminal gate cases: 4 tests passed. Other cases were excluded by the name filter. Log: `/tmp/routing-offline-tests.log`.
- Engine SIGKILL and queue cases: 3 files, 23 tests passed.
- Store reference identity and gate restore: 2 tests passed. The external Postgres variant skipped because `TEST_DATABASE_URL` was absent. Log: `/tmp/routing-store-tests.log`.
- API TypeScript check passed with `pnpm exec tsc -p packages/api/tsconfig.json --noEmit`.

These runs overlap. Their counts must not be added as unique acceptance cases.

## Remaining external evidence

Live Slack delivery and real Slack button interaction require a configured installation and channel. Local transport tests do not establish provider availability or installation permissions.

The on-disk reopen and SIGKILL tests use fresh test databases. They do not establish recovery of the existing corrupt local database. That database remains preserved.

Rollback to an earlier application binary was not exercised. Compatibility here means retained API behavior and reusable existing storage contracts.

An external message send and its local reference write cannot share a transaction. A crash between those operations can leave an unrecorded card. Its callback fails closed and asks the user to resolve the gate in Valet.


## Scorecard follow-up: workflow surfaces

The focused scorecard follow-up passed under Node 22: four web files with 70 tests, plus nine workspace briefing tests.

The workflow editor test now checks the addressed conversation draft and verifies that another thread receives no prefill. Workflow list tests exercise Manual setup through its menu and the default creation composer. The approval test checks its collapsed state instead of counting hidden DOM text. The standalone dialog suite now declares its browser test environment.

The briefing fixture uses separate workflows for independent approval, failed-result, and timer evidence. An additional assertion verifies that a newer successful run replaces the previous failed run as current evidence.

Workflow checkpoints with a thread ID now link directly to `/threads/:threadId`. A checkpoint without a thread ID keeps its runtime fallback. The run-detail suite passed all 19 tests after this correction.
