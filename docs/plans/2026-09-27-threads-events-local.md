# Threads and Events local implementation plan

Goal: deliver a locally reviewable workspace routing foundation using the existing
engine, thread store, workflow interpreter, and event dispatcher.

Design: ../specs/2026-09-27-threads-events-local-design.md

## Completed

- Branch `codex/threads-events-refactor` from `tkhq/dev-v2` at `7bd87a638`.
- Recover the Linear scope and apply the newer Slack and user clarifications.
- Enforce one default assistant per owner using the existing atomic resolver.
- Remove assistant customization pages, selection controls, and mutation tools.
- Reject assistant overrides in workflows, subscriptions, and schedules.
- Route automation, followed conversations, and notifications by workspace.
- Remove Sessions and Artifacts from primary navigation; retain runtime detail routes.
- Show recorded diagnostic explanations inline on Problems.
- Seed personal/team threads, diagnostic examples, and a runnable team workflow.
- Verify a real team workflow response: `team-workflow-check-ok`.
- Verify deep links adopt the team's scope and unavailable teams never open personal history.
- Review changes independently and address the review findings.

## Validation record

- Focused canonical scorecard: typecheck, web build, API bundle, conventions,
  docs lint, and core integration passed (6 rows).
  Log: `/tmp/valet-workspace-final-checks.log`.
- Full web sweep: 278 files, 3,058 tests passed. Subsequent workflow-scope and
  attention changes passed their focused suites (32 and 24 tests).
- API routing sweep: 60 tests passed. Prior focused API sweep: 272 passed.
- Root CI-mode sweep: 11,037 passed, 64 skipped, one CSV export timeout.
  The isolated usage suite then passed all 29 tests, including that export.
  Logs: `/tmp/valet-workspace-ci-unit-final2.log` and
  `/tmp/valet-workspace-usage-retry.log`.
- Full `make e2e` attempted with output captured in
  `/tmp/valet-workspace-full-e2e.log`. It exposed obsolete assertions and a missing
  integration-test registration, both corrected. The local image builder timed
  out, and browser Docker failed with `/bin/echo: invalid argument`.
- The Kubernetes sandbox row was interrupted after nine minutes: the local
  `rancher-desktop` sandbox controller had no ready pod, with Pending/Evicted pods.
  This is an incomplete infrastructure check, not a passing result.
- Remaining Docker rows: workspace prep, prebuilds, and Keycloak passed.
  Real Postgres was blocked by port 5433 already being allocated.
  The isolated browser retry failed on its stale-approval assertion; this remains
  unresolved, so no clean full scorecard is claimed.
  Log: `/tmp/valet-workspace-infra-remainder.log`.

## Local review

The app runs at http://localhost:5173 using worktree-local PGlite.
Current IDs and links come from `.valet-dev/threads-demo.json`.
The guide at `../guides/threads-events-local.md` describes reproducible seeding.

A prior local PGlite database failed to reopen after development restarts. It and
its seed manifest were preserved in `.valet-dev/recovery-20260927-194527/`.
A second restart exposed a lingering API watcher; that database was also
preserved in `.valet-dev/recovery-20260927-2002/`. The final local API runs without
a watcher to avoid overlapping database owners. A fresh disposable database was
seeded and the team workflow verified against it.
Final API verification completed workflow `wfrun_mukm271mdt8g12` with response
`team-workflow-check-ok`. The fresh team is
`team_7573d02f-0085-448f-90f2-9fd0fe135502`. The final browser reconnection was
blocked by the browser tool URL policy; prior browser checks passed before
reseed, but no final browser pass is claimed.
No production integration was reconnected, and no Slack messages were sent.

## Next review checkpoint

- Discuss a Thread workflow node built from the durable orchestrator node.
- Decide thread sharing across workflow steps and visibility after completion.
- Store workflow-to-thread associations server-side rather than per browser.
- Surface standalone/child work and artifacts through Threads.
- Extend event diagnostics across receipt, classification, matching, and delivery.
- Add home-channel routing and personal DM preferences with explicit semantics.
- Remove unused internal assistant-routing fields. No backward compatibility needed.
