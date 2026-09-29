# Unified e2e entrypoint (`make e2e`) — design

**Date:** 2026-07-25
**Status:** Implemented — `scripts/e2e.ts` + `scripts/e2e/` (see Deviations)

## Purpose

Valet's real end-to-end coverage exists but is scattered across three gating
regimes with no front door: the `packages/api/src/integration/` vitest project
(each suite behind its own env-var gate), the `dogfood.ts` real-Anthropic+Docker
script, the T9 CLI suite (`VALET_CLI_E2E=1`), and per-backend sandbox suites in
`packages/sandbox-{local,docker,kubernetes}`. `make test` runs none of the
armed-with-real-creds paths; `make test-e2e` still points at the frozen legacy
worker.

This design adds a single orchestrating entrypoint — `make e2e` — so an agent
(or human) validating a v2 change can run one command, provide credentials once,
and get a per-feature scorecard of what passed, failed, or was skipped and
exactly which credential would arm each skipped row.

v1 wraps existing suites; the only new test code is two small smoke scripts and
a shared full-stack scenario driver.

## The runner

`scripts/e2e.ts` at the repo root, run via `tsx`, invoked by `make e2e`.

- **Env loading:** sources `.env.e2e` from the repo root if present (ambient
  env always wins, so exported vars and CI work without the file). A committed
  `.env.e2e.example` documents every variable by tier. `.env.e2e` is
  gitignored. The runner never prints secret values — only variable names.
- **Prerequisite probes (once, up front):** Docker daemon reachable; kubectl
  context `rancher-desktop` exists; which credential vars are set. Probes are
  cheap and read-only.
- **Execution:** each step runs as a child process (pnpm/vitest/tsx/make),
  sequentially (several steps contend for Docker and ports; parallelism is a
  later optimization). Per-step timeout; a step's stdout/stderr is captured
  and replayed only on failure (or with `--verbose`).
- **Flags:** `--json` (machine-readable scorecard, mirrors the CLI
  convention), `--only <step>[,<step>…]` (run a subset), `--list` (print steps
  + armed state without running), `--doctor` (environment readiness checklist
  without running suites — see below), `--verbose`.
- **Exit code:** nonzero iff any *armed* step failed. Skipped steps never fail
  the run.

### `--doctor` — environment readiness

The initialization-phase check for a fresh machine or agent: prints a ✓/✗/⊘
checklist in seconds instead of failing suites 15 minutes in. *Required*
checks (✗ fails, exit 1) gate every run: Node ≥ 22, `pnpm install` done,
`@valet/shared` + `@valet/sdk` dists built (the only two workspace packages
consumed via built output). *Optional* checks (⊘, exit 0) widen coverage:
`.env.e2e` present, cred tiers, Docker/helm/kubectl. Every miss prints its
repair command. Pure rendering (`renderDoctor`/`doctorExitCode`) lives in
`lib.ts` and is unit-tested; the fs/probe wiring lives in `e2e.ts`.

### `make e2e-clean` — leaked-state sweep

Crashed runs can leak state the happy path cleans up: docker sandbox
containers (`valet-sandbox-*` — teardown is SIGKILL, so a crash between
session-create and session-delete orphans the container), the `valet-e2e`
helm release + `valet-e2e`/`valet-e2e-sandboxes` namespaces, the
`/tmp/valet-e2e-fullstack` scratch dir, and the warm keycloak container.
`make e2e-clean` sweeps all of them, idempotently, with kubectl/helm pinned
to the `rancher-desktop` context (skipped when that context is absent).
Caveat: the container sweep matches ALL `valet-sandbox-*` containers,
including dev-local session sandboxes — acceptable pre-1.0 (they are
recreated on demand) and stated in the target's help text.

### Node version enforcement (layered)

Three layers catch the Node-20 trap (`WebSocket is not defined`, 15 minutes
into a run): root `package.json` `engines.node >= 22` + `.npmrc
engine-strict=true` fail `pnpm install`/`pnpm run` immediately; the runner's
preflight exits 2 with the `nvm use 22` hint; `--doctor` reports the version.

## Steps (the scorecard rows)

A coverage audit (2026-07-25) found that root `pnpm test` runs only four vitest
projects (`shared`, `sdk`, `api`, `web`); `engine`, `workflow`,
`store-postgres`, `sandbox-gateway`, `runner`, and all `plugin-*` packages are
reachable only via `pnpm --filter <pkg> test`, and several Docker/cluster-gated
suites live outside `src/integration`. The scorecard therefore includes them
explicitly — the goal is that anything that could break during a v2 change has
a row, so `make e2e` is sufficient validation on its own (it does not assume
`pnpm test` was run separately).

**Static + unit (always armed, no external deps):**

| Step | Wraps |
|---|---|
| `typecheck` | root `pnpm typecheck` (all packages except frozen `worker`) |
| `conventions` | `scripts/check-conventions.ts` — recurring review rules as executable checks: `@ts-ignore`/`@ts-expect-error` banned, `as unknown as` ratcheted via allowlist (`scripts/e2e/conventions.ts`), every `ws`-consuming package declares both `@types/ws` and `@types/node`. Legacy packages (worker, client, runner) excluded. |
| `unit` | root `pnpm test` (`shared`, `sdk`, `api`, `web` projects) |
| `engine-unit` | `pnpm --filter @valet/engine test` — store contract, compaction, gates, signals, kill-mid-turn, model switching |
| `workflow-unit` | `pnpm --filter @valet/workflow test` — DAG interpreter, node executors, expression eval, checkpoints |
| `gateway-unit` | `pnpm --filter @valet/sandbox-gateway test` — sandbox JWT mint/verify, WS proxy |
| `plugins-unit` | `pnpm --filter './packages/plugin-*' test` — telegram/slack/github/google-* action + transport tests |
| `sandbox-local` | `packages/sandbox-local` test suite |
| `sandbox-k8s-unit` | `packages/sandbox-kubernetes` non-cluster tests (manifest, lifecycle, provider, framing) |
| `store-postgres-unit` | `packages/store-postgres` PGlite-backed tests (migration runners; real-pg suites self-skip) |
| `web-build` | `pnpm --filter @valet/web build` — the vite production build |
| `api-bundle` | `pnpm --filter @valet/api build` + `bundle-guard` suite (which self-skips when `dist/` is absent) |
| `helm-golden` | `deploy/chart/valet/test/golden.sh` — helm lint + template goldens (needs `helm`, no cluster) |
| `sandbox-docker-unit` | `packages/sandbox-docker` `run-args.test.ts` (pure unit, no daemon) |
| `registry-drift` | regenerate `registry.gen.ts`, fail on diff vs committed (tree restored on failure) |

**Integration + smoke:**

| Step | Wraps | Armed when |
|---|---|---|
| `integration-core` | keyless tests in `packages/api/src/integration` (auth, memory routes, session filters, GitHub-fixture loop, events webhook) | always |
| `orchestrator-smoke` | **new** `packages/api/scripts/smoke-orchestrator.ts` | `ANTHROPIC_API_KEY` |
| `session-smoke` | `packages/api/scripts/smoke-session.ts` (renamed from `dogfood.ts`) | key + Docker |
| `integration-agent` | key-gated integration suites (orchestrator lifecycle/loop, cross-thread, plugins, workflow-run) | key (+ Docker for workflow-run) |
| `cli` | T9 `cli.e2e.test.ts` with `VALET_CLI_E2E=1` | always; real-turn subtests need key |

**Docker / cluster-gated suites:**

| Step | Wraps | Armed when |
|---|---|---|
| `sandbox-docker` | `packages/sandbox-docker` test suite | Docker |
| `sandbox-k8s` | `packages/sandbox-kubernetes` `*.cluster.test.ts` (conformance, provider, exec) | `rancher-desktop` context |
| `store-postgres` | `make test-pg` — real `postgres:17` conformance + api `pg-store`/`credential-store` suites | Docker |
| `workspace-prep-docker` | `packages/api/src/engine/workspace-prep*.docker.test.ts` — git checkout, credential helper, prebuilt-image fetch against a real sandbox | Docker |
| `prebuilds-docker` | `packages/api/src/integration/prebuilds.e2e.test.ts` — real `docker build` → fetch-on-start | Docker |
| `k8s-builder-cluster` | `packages/api/src/prebuilds/k8s-builder.cluster.test.ts` — in-cluster image build via bundled registry | context + registry present |
| `keycloak-oidc` | **new** `packages/api/src/integration/oidc-keycloak.e2e.test.ts` — real authorization-code flow against dockerized Keycloak | Docker |

**Full stack:**

| Step | Wraps | Armed when |
|---|---|---|
| `fullstack-docker` | **new** full-stack scenario against a spawned `valet serve` (docker backend) | key + Docker |
| `fullstack-k8s` | **new** full-stack scenario against the helm deployment on rancher-desktop | key + context + `VALET_E2E_K8S=1` |

**Live external integrations:**

| Step | Wraps | Armed when |
|---|---|---|
| `telegram` | live outbound `telegram.e2e.test.ts` | `TELEGRAM_TEST_BOT_TOKEN` + `TELEGRAM_TEST_CHAT_ID` |
| `github-live` | live GitHub App block in `github-repo.e2e.test.ts` | `VALET_GITHUB_LIVE_TEST=1` + app id + private key PEM |
| `openai` | `llm-providers.e2e.test.ts` | `OPENAI_API_KEY` |
| `onepassword` | live 1Password SDK in `onepassword.live.test.ts` | `OP_SERVICE_ACCOUNT_TOKEN` |

Step names are stable identifiers (used by `--only` and the JSON output).
Note: several docker-gated suites self-skip when `CI` is set
(`workspace-prep.docker`, `prebuilds.e2e`) — the runner is local-first, so this
is fine, but it must not set `CI` itself.

## New test code

### `smoke-orchestrator.ts` (packages/api/scripts/)

Fastest "is the agent loop alive" check. Modeled on the existing smoke script:
boot the app in-process (fresh PGlite, virtual/no sandbox — the orchestrator is
a sandbox-less wake), ensure the orchestrator session, send one prompt, follow
the WS until the turn settles, assert a non-empty assistant reply. Exit 0/2/3
like `smoke-session`. Requires only `ANTHROPIC_API_KEY`.

### `smoke-session.ts` (rename of `dogfood.ts`)

Content unchanged in v1 beyond the rename: real API in-process + real Docker
sandbox, create session, "write hello.txt then read it back", assert the file
landed on the bind mount. Renames ripple to: package script `dogfood` →
`smoke:session`, Makefile `dogfood-api` → `smoke-session` (old target removed,
no alias — pre-1.0), and every doc that mentions `dogfood` (CLAUDE.md,
deploy/README.md, Makefile comments).

### `oidc-keycloak.e2e.test.ts` (packages/api/src/integration/)

Automates the SSO path that today is manual-only via `make dev-keycloak`. The
compose `keycloak` profile already boots Keycloak 26.2 with an auto-imported
`valet` realm — fixed client `valet`/`valet-dev-secret`, seeded user
`alice@valet.test`/`password` — so the flow is deterministic. The test boots
the API via `bootTestApi({ auth: true })` with `AUTH_OIDC_*` pointed at
`http://localhost:8081/realms/valet`, then drives the real authorization-code
flow headlessly with `fetch` + a cookie jar (Keycloak's login page is a plain
HTML form — no browser):

1. better-auth sign-in endpoint → Keycloak authorize redirect
2. GET authorize URL, parse the form `action`, POST the seeded credentials
3. follow the 302 back to the API callback with the code
4. assert a valid API session and that domain-based org provisioning ran

This covers issuer discovery, token exchange, claim mapping, and user
provisioning — the exact wiring with zero automated coverage today. Gated on
the Keycloak container being reachable; the runner starts it via the compose
profile (health-gated on the realm's `.well-known`, same as the Make target)
and leaves it running between runs since cold boot is ~30–60s. Known
fragility: a Keycloak major upgrade could change the login-form markup, but
the image is version-pinned in compose, so that's a controlled event.

### `fullstack-scenario.ts` (scripts/e2e/)

A client-side scenario driver shared by both full-stack steps so they cannot
drift: given `{ baseUrl, apiKey }`, it (1) health-checks, (2) creates a
session, (3) sends a prompt instructing the agent to write a marker file and
report back, (4) follows the WS to settle, (5) asserts the assistant's reply
via `GET /messages`. It talks only the public HTTP/WS surface — the same wire
contract the web client and CLI use.

- **`fullstack-docker`:** the runner spawns a real `valet serve` child
  (docker sandbox backend, fresh data dir, random port, stub local auth),
  waits for `/api/health`, runs the scenario, kills the child. Unlike
  `session-smoke` (in-process app), this exercises the real server boot path,
  config/env handling, and the wire surface end to end.
- **`fullstack-k8s`:** ensures the vendored sandbox controller
  (`make k8s-sandbox-install`), ensures images (`make k8s-build` only when the
  `valet-api:dev`/`valet-sandbox:dev` images are absent — a cold build is
  15–20 min, which is why this step additionally gates on
  `VALET_E2E_K8S=1`), deploys via `make k8s-up`, port-forwards
  `svc/valet-api` on a random local port, runs the same scenario (sessions
  become Sandbox CRs + pods), then tears down the port-forward. It leaves the
  helm release installed (matching `make k8s-down` semantics being a separate,
  deliberate step). **Every kubectl/helm invocation pins
  `--context rancher-desktop`** — the ambient context on this machine can be a
  production cluster and must never be touched.

## Secrets file

`.env.e2e.example` (committed):

```
# ── Tier: agent (arms orchestrator-smoke, session-smoke, integration-agent,
#            cli real-turn tests, fullstack-*) ────────────────────────────
ANTHROPIC_API_KEY=

# ── Tier: optional providers ──────────────────────────────────────────────
OPENAI_API_KEY=

# ── Tier: telegram (live outbound delivery) ───────────────────────────────
TELEGRAM_TEST_BOT_TOKEN=
TELEGRAM_TEST_CHAT_ID=

# ── Tier: github-live (real GitHub App) ───────────────────────────────────
VALET_GITHUB_LIVE_TEST=
VALET_GITHUB_LIVE_APP_ID=
VALET_GITHUB_LIVE_APP_PRIVATE_KEY_PEM=

# ── Tier: k8s full stack (also needs rancher-desktop kubectl context) ─────
VALET_E2E_K8S=
```

## Scorecard

Human output: one line per step — `✓ passed (12.3s)`, `✗ failed`, or
`⊘ skipped — set ANTHROPIC_API_KEY` — followed by totals and the exit code
rationale. Failed steps replay their captured output above the scorecard.

`--json` output: `{ steps: [{ name, status: "passed"|"failed"|"skipped",
durationMs, skipReason? }], passed, failed, skipped, exitCode }`.

## Error handling

- A step timing out counts as failed (timeout noted in the scorecard).
- Probe failures downgrade steps to skipped with the probe named (e.g.
  `⊘ skipped — Docker daemon not reachable`), never crash the runner.
- Ctrl-C kills the current child process group and prints the partial
  scorecard.
- The runner refuses to start if `.env.e2e` exists but is unreadable/harbors
  parse errors, rather than silently running a weaker tier.

## Deviations (as implemented)

- Test-file filters are passed to vitest WITHOUT a `--` separator. vitest
  drops every argument after a bare `--` and runs the full suite;
  `lib.test.ts` rejects any step command that contains one.
- Execution runs in three waves, not one sequential list. Wave 1 (serial):
  static steps that write files other steps read — `typecheck` (tsc --build
  re-emits shared/sdk dist) and `registry-drift` (temporarily rewrites a
  tracked file). Wave 2 (pooled): `parallelSafe` static steps run
  concurrently, at most `VALET_E2E_JOBS` at a time (default:
  min(4, max(2, cores/4))). Wave 3 (serial, table order): every non-static
  step — daemons, fixed ports, API keys, and clusters do not interleave.
  `--verbose` forces one job (inherited stdio cannot interleave). The
  scorecard always prints in table order, whatever the completion order.
- `integration-core` / `integration-agent` run explicit file lists (held in
  `scripts/e2e/lib.ts`), not whole-directory globs — keeps the two rows
  disjoint from the dedicated rows (cli, telegram, github-live, openai,
  onepassword, prebuilds, keycloak). A new integration test file must be added to one of
  those lists to be covered.
- The Keycloak test needs `AUTH_TRUSTED_ORIGINS=http://localhost:8081` —
  better-auth rejects OIDC discovery against origins outside `trustedOrigins`
  (`discovery_untrusted_origin`). The `make dev-keycloak` hint now includes
  it.
- `fullstack-k8s` deploys a dedicated `valet-e2e` release/namespace instead
  of reusing the dev `valet` release: the dev release's retained DB requires
  invites for signups, and it owns cluster-scoped resources (the
  `valet-sandboxes` namespace, the registry NodePort 30500). The e2e release
  sets `sandbox.namespace=valet-e2e-sandboxes` and `registry.bundled=false`
  via a new `HELM_EXTRA_ARGS` passthrough on `make k8s-up`, and
  authenticates by signing up a deterministic first-admin user (sign-in
  fallback on re-runs). Remove it with
  `make k8s-down HELM_RELEASE=valet-e2e K8S_NAMESPACE=valet-e2e`.
- The fullstack scenario uses the `ws` package (root devDependency, with
  `@types/ws` + `@types/node` per the CLAUDE.md rule) so the session cookie
  can ride the WS upgrade headers against real-auth deployments.
- The runner library is unit-tested via a new `scripts` project in the root
  vitest config.
- Baseline failure surfaced during implementation (pre-existing on `dev-v2`,
  verified on an untouched checkout): `cli.e2e.test.ts` "send --json drives a
  turn to completed" fails — the CLI exits 0 via the `turn_end` fallback but
  no `submission.settled` frame reaches the stream (the send-then-attach race
  documented in `send.ts`). The `cli` row stays red until that's fixed.
- `sandbox-local`'s "inherits PATH" test was env-sensitive (pnpm exports
  `FORCE_COLOR=1`, ANSI-wrapping child output); fixed by pinning
  `FORCE_COLOR=0` in the exec call.
- ALL static-group rows scrub credential vars from the child env, not just
  `integration-core` — with ambient keys present, the root `unit` sweep
  otherwise runs a LIVE OpenAI turn (`llm-providers.e2e`) and fails the
  "no key anywhere" model-resolution tests.
- `plugins-unit` enumerates the plugin packages that have tests
  (`TESTED_PLUGINS` in `lib.ts`, guarded by a lib test that diffs the list
  against the filesystem) — content-only plugins ship a bare `vitest run`
  script that explodes resolving the root workspace config from the wrong
  cwd.
- Fixed while verifying: `plugin-google-workspace`'s `docs.find_text_index`
  was never classified in `labels-guard.ts` (fail-closed guard denied it at
  runtime; completeness test red on `dev-v2` baseline) — added to
  `READ_GET_ACTIONS`.
- Adversarial-review round (2026-07-26): interrupted runs (Ctrl-C) now record
  the in-flight step as failed and exit nonzero (130) — previously a partial
  run could exit 0; both fullstack variants DELETE their session after the
  scenario so sandbox containers / Sandbox CRs no longer leak one per run;
  the smoke scripts bind ephemeral ports and await listen before any request
  (previously :8788 could collide with — and write into — a running
  `make dev-local`); `parseEnvFile` accepts `export KEY=V` and CRLF, strips
  unquoted inline comments, and throws on whitespace-containing keys;
  empty-string ambient env vars no longer shadow `.env.e2e` values;
  `CRED_VARS` gained `GEMINI_API_KEY` + `ANTHROPIC_OAUTH_TOKEN` (the api's
  own vitest.setup scrub is not applied by the flattened root run); the wire
  `error` event fails the fullstack scenario fast instead of burning the
  turn timeout; five rows added (`sandbox-k8s-unit`, `store-postgres-unit`,
  `web-build`, `api-bundle`, `helm-golden` — 30 rows total) and a lib test
  now asserts core+agent+dedicated cover the whole integration dir.
- Follow-up round: `registry-drift` and `sandbox-docker-unit` rows added
  (32 rows total; the drift row was negative-tested by flipping a
  `plugin.yaml` to `enabled: false`), and `VALET_E2E_K8S_REBUILD=1` forces
  the k8s image build so Dockerfile drift can't hide behind stale `:dev`
  images. Legacy packages (`client`, `worker`) are intentionally uncovered —
  they are slated for deletion.
- Known flakes observed (not runner bugs): `unit` can hit a `getFreePort`
  EADDRINUSE race in `bootTestApi` under full parallelism; `store-postgres`'s
  "stopHost gates out late wakes" is timing-sensitive when other suites
  saturate Docker (the runner's sequential execution avoids this; it failed
  only when two batches were run concurrently during verification).

## Known blind spots (no tests exist to wrap)

Subsystems with zero automated coverage today — candidates for new test code in
later iterations, recorded here so the scorecard's green doesn't overstate:

- Sandbox tunnels (`plugin-sandbox-tunnels`) and personas
  (`plugin-personas`) — no test files.
- The `valet mcp` server actually serving tools to an MCP client — only unit
  tests around the pieces.
- Web Browser panel interaction has component coverage and manual browser verification. The automated managed-browser fixture exercises the API, engine, runtime, and Chromium.
- Most content-only / thin plugin packages (`plugin-notion`,
  `plugin-sentry`, `plugin-stripe`, …) — no test files.

## Out of scope (v1)

Recorded so they don't get lost:

- Automated full web-client journeys remain outside the runner. Managed Chromium coverage is described below.
- A `valet handoff` e2e scenario in the T9 suite.
- The T9 suite's self-documented gaps: real-auth login/logout, `gates resolve`
  round-trip, human-mode `send`.
- Inbound Telegram (manual-only today).
- Parallel step execution.
- CI wiring — this is a local-first tool; CI keeps its existing per-suite
  gating.

### Fixture lifecycle limits

The sandbox timeout contract uses the provider suite timeout for provisioning and cleanup. Its separate two-second assertion still bounds the exec operation. Kubernetes provisioning can exceed ten seconds.

The short-lived GitHub HTTP fixture closes each response connection. This prevents connection pooling from outliving an ephemeral test server. The fixture still uses real HTTP requests and responses.

The web build and API bundle run sequentially before the static pool. The API bundle copies web assets, so it must wait for the web build.

## Managed browser coverage (2026-09-23)

The `browser-runtime` row runs the runtime unit and page fixture suites.
The `browser-docker` row runs the packaged browser in a real Docker sandbox.
It checks approvals, screenshot exports, invocation deduplication, private human control, API restart adoption, and retained profile cookies.
It also runs the browser HTTP integration through the API, engine, and plugin.
The serial row sets `VALET_BROWSER_INTEGRATION=1` for that fixture.
The root unit sweep leaves it disabled to avoid concurrent browser provisioning.
The workflow Docker fixture uses Rancher's macOS host address when that context is active.
Its provider inventory is separate from other test APIs and running development instances.
The row uses `VALET_BROWSER_TEST_IMAGE` when set.
Otherwise, it builds `valet-browser-e2e:local` from the sandbox Dockerfile if that local image is absent.
The row needs Docker but no external model credentials.
These two rows bring the scorecard to 37 rows.

### Isolated PostgreSQL test instances (2026-09-29)

`make test-pg` creates its own temporary container on an ephemeral loopback port.
It waits for readiness, shares that instance between the store and API suites,
and stops only that container on exit. Concurrent development servers and test
runs no longer collide on port 5433 or a shared container name.

The live Kubernetes image-build smoke test uses a Git-capable base image and a
unique resource ID for each run. It requires the image to reach `pushed`; a
terminal failure no longer counts as success. This catches broken build execution
instead of only checking that polling terminates.

Railway server deployment uses the same API image, one replica, and an HTTP
readiness gate through `railway.json`. It does not replace local test backends
or add a new sandbox provider.

The Railway deployment helper exports a committed Git snapshot and scopes its
pnpm cache mount to the selected Railway service. Application sources remain
identical to the selected revision; local builds keep their existing cache ID.
