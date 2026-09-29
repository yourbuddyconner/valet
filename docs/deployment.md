# Deployment Guide

Valet deploys as a single server process plus Postgres plus a sandbox
backend. There are three ways to run it.

## 1. Single binary

The `valet` CLI ships as a self-contained executable (Bun-compiled, embedding
the web client and migrations):

```bash
valet serve
```

That boots the API, serves the web UI on the same port, and uses embedded
PGlite under `~/.valet` — no external database needed. Point it at real
Postgres with `DATABASE_URL` (or `valet config set serve.databaseUrl ...`).
Sandboxes default to the Docker backend, so a Docker daemon must be
reachable. Set `BETTER_AUTH_SECRET` to enable real auth; see
[environment-variables.md](environment-variables.md) for the full list.

`serve` holds an exclusive `serve.lock` per data dir — two servers can never
share one PGlite. Client commands (`valet login`, `sessions`, `send`, `chat`,
`gates`) work against any instance via named profiles in
`~/.valet/config.json`. The full command reference is
[`docs/cli.md`](cli.md).

Prebuilt binaries (macOS arm64, Linux x64/arm64) are published on GitHub
Releases: versioned releases on `v*` tags, plus a rolling `dev-v2-latest`
prerelease refreshed on every merge to `dev-v2`. Or build from source:
`pnpm --filter @valet/api build:binary` (cross-compile with
`--target bun-<os>-<arch>`).

## 2. Local development

```bash
make dev-local   # API on :8788 (VALET_LOCAL_AUTH=1) + Vite web on :5173
```

Requires `ANTHROPIC_API_KEY` and Docker. Open http://localhost:5173. Setting
`BETTER_AUTH_SECRET` switches the dev API to real auth.

## 3. Kubernetes (Helm)

The chart at `deploy/chart/valet` deploys:

- **valet-api** — one replica (the engine is a stateful singleton), ClusterIP
  service behind a Traefik ingress. Secrets are chart-generated and retained
  when not supplied.
- **Postgres** — bundled `postgres:17` StatefulSet, or bring your own via
  `externalDatabase.url`.
- **Sandbox infrastructure** — sessions become `Sandbox` CRs + pods in a
  separate namespace (`valet-sandboxes`) with narrowly-scoped RBAC. The
  [agent-sandbox](https://agent-sandbox.sigs.k8s.io/) controller (vendored
  under `deploy/agent-sandbox/`) must be installed first.
- **Image prebuilds** — a bundled OCI registry (`registry:2`, nightly GC) fed
  by BuildKit jobs, so repos can get prebuilt sandbox images.

CI publishes the api and sandbox images to GHCR (public, multi-arch) on
every `dev-v2` merge — remote clusters should deploy those, pinned to the
immutable `sha-<shortsha>` tag (see
[`docs/kubernetes.md`](kubernetes.md#images-and-builds)).

The local reference environment is Rancher Desktop (moby mode):

```bash
make k8s-sandbox-install  # one-time: agent-sandbox CRD + controller
make k8s-build            # build valet-api:dev + valet-sandbox:dev
make k8s-up               # helm upgrade --install into namespace valet
make k8s-logs             # tail the api pod
make k8s-down             # helm uninstall (PVCs + Sandbox CRs survive)
```

**Context safety:** every `make k8s-*` target pins `--context
rancher-desktop`. Never run bare `kubectl`/`helm` against this workflow — an
ambient context may point at a production cluster.

The deployment architecture and its infra-level constraints (singleton API,
install ordering, secret retention, RBAC verbs, PVC/teardown semantics,
registry networking) are documented in
[`docs/kubernetes.md`](kubernetes.md). The full runbook — hosts-file setup
for `https://valet.localdev`, image rebuild flow, full-reset procedure — is
[`deploy/README.md`](../deploy/README.md); the design rationale is
[`docs/specs/2026-07-15-kubernetes-deployment-design.md`](specs/2026-07-15-kubernetes-deployment-design.md).

## Migrations

Schema migrations (engine: `packages/store-postgres/migrations/pg/`, app:
`packages/api/migrations/pg/`) run automatically at server boot. Pre-1.0 they
are edited in place as a single `0000` file — a schema change on the embedded
PGlite dev store requires wiping the data dir (`make dev-clean`; see CLAUDE.md).

## Legacy stack

The Cloudflare Worker + Modal deployment (`make deploy`, `packages/worker`,
`backend/`) is frozen and kept only for the legacy production environment; it
is not part of this deployment path.

## Railway

`railway.json` builds `docker/Dockerfile.api`, serves the API and web UI from
one replica, and checks `/api/ready` before routing traffic. Use a Railway
Postgres service through `DATABASE_URL` and mount a persistent volume at `/data`.
Set `VALET_DATA_DIR=/data`. Retain the existing auth and encryption secrets on
updates. Set the public and auth URLs to the working HTTPS domain before
configuring integration callbacks.

The server still requires a sandbox backend. This branch does not implement
Railway's sandbox API. `VALET_SANDBOX_BACKEND=local` runs commands inside the
API container and is not an isolation boundary. Use the supported Docker or
Kubernetes backend for isolated agent execution.

Deploy an exact committed source snapshot, preserve a database backup before
migration, and check both `/api/health` and `/api/ready` after rollout. The
repository root Dockerfile is not the API deployment image.
