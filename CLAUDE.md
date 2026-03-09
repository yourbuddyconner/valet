# CLAUDE.md — Valet Development Guide

NOTE: Do NOT add "Co-Authored-by" trailers mentioning AI models (e.g., Opus, Claude) in commit messages PRs, or comments.

## What This Project Is

Valet is a hosted background coding agent platform. Users interact with an AI coding agent through a web UI, Slack, or Telegram. Each session runs in an isolated Modal sandbox with a full dev environment (VS Code, browser via VNC, terminal, and an OpenCode agent with 73 custom tools). A per-user orchestrator ("Jarvis") manages sessions, routes messages across channels, and maintains long-term memory. The architecture is modeled after Ramp's Inspect system.

## Project Structure

```
valet/
├── packages/
│   ├── client/              # React SPA (Vite + TanStack Router + Query + Zustand)
│   ├── worker/              # Cloudflare Worker (Hono + D1 + R2 + Durable Objects)
│   ├── shared/              # Shared TypeScript types & errors
│   ├── runner/              # Bun/TS runner for inside sandboxes
│   ├── sdk/                 # Integration & channel SDK contracts, MCP client, UI components
│   ├── plugin-github/       # GitHub integration (actions: PRs, issues, webhooks)
│   ├── plugin-slack/        # Slack (actions + channel adapter)
│   ├── plugin-gmail/        # Gmail integration
│   ├── plugin-google-*/     # Google Calendar, Drive, Sheets integrations
│   ├── plugin-linear/       # Linear issue tracking
│   ├── plugin-notion/       # Notion integration
│   ├── plugin-stripe/       # Stripe integration
│   ├── plugin-cloudflare/   # Cloudflare API integration
│   ├── plugin-sentry/       # Sentry error tracking
│   ├── plugin-deepwiki/     # DeepWiki knowledge base
│   ├── plugin-telegram/     # Telegram (channel adapter)
│   ├── plugin-browser/      # Browser skill (content-only)
│   ├── plugin-workflows/    # Workflow skill (content-only)
│   ├── plugin-sandbox-tunnels/  # Tunnel skill (content-only)
│   └── plugin-memory-compaction/ # Memory compaction tool (content-only)
├── backend/                 # Modal Python backend
├── docker/
│   ├── Dockerfile.sandbox   # Sandbox container image
│   ├── start.sh             # Sandbox startup script
│   └── opencode/            # OpenCode config: tools/
├── docs/
│   └── specs/               # Subsystem specs (source of truth per domain)
├── V1.md                    # Original architecture spec (may be outdated)
├── V2.md                    # Orchestration layer spec (orchestrators, channels, personas)
├── Makefile                 # Dev, test, deploy commands
├── docker-compose.yml       # Local dev (OpenCode container)
└── .beans/                  # Task tracking (beans)
```

## Tech Stack Quick Reference

| Layer | Tech | Key Files |
|-------|------|-----------|
| Frontend | React 19, Vite 6, TanStack Router/Query, Zustand, Tailwind, Radix UI | `packages/client/src/` |
| Worker | Cloudflare Workers, Hono 4, D1 (SQLite via Drizzle ORM), R2, Durable Objects | `packages/worker/src/` |
| Shared | TypeScript types, error classes, scope keys | `packages/shared/src/` |
| SDK | Integration contracts, channel contracts, MCP client/OAuth, UI components | `packages/sdk/src/` |
| Runner | Bun, TypeScript, `@opencode-ai/sdk`, Hono gateway | `packages/runner/src/` |
| Backend | Python 3.12, Modal SDK | `backend/` |
| Sandbox | OpenCode serve (73 tools, 3 skills, 1 plugin), code-server, Xvfb+VNC, TTYD | `docker/` |

## Subsystem Specs

Detailed per-subsystem specifications live in `docs/specs/`. These are the source of truth for each domain's behavior, boundaries, data model, and contracts. When modifying a subsystem, update its spec in the same commit.

| Spec | Covers |
|------|--------|
| [`docs/specs/sessions.md`](docs/specs/sessions.md) | Session lifecycle, state machine, sandbox orchestration, prompt queue, message streaming, hibernation/restore, access control, multiplayer |
| [`docs/specs/sandbox-runtime.md`](docs/specs/sandbox-runtime.md) | Sandbox boot sequence, service ports, auth gateway, Runner process, OpenCode lifecycle, Runner↔DO WebSocket protocol, Modal backend |
| [`docs/specs/real-time.md`](docs/specs/real-time.md) | SessionAgentDO WebSocket handling, EventBusDO, event types, V2 streaming protocol, client reconnection, message deduplication |
| [`docs/specs/workflows.md`](docs/specs/workflows.md) | Workflow definitions, trigger types (webhook/schedule/manual), execution lifecycle, WorkflowExecutorDO, step engine, approval gates, proposals, version history |
| [`docs/specs/auth-access.md`](docs/specs/auth-access.md) | OAuth flows (GitHub/Google), token auth, admin middleware, org model (settings/invites/LLM keys), session access control, JWT issuance |
| [`docs/specs/orchestrator.md`](docs/specs/orchestrator.md) | Orchestrator identity, auto-restart, child session spawning, memory system (FTS), mailbox, channel routing, task board |
| [`docs/specs/integrations.md`](docs/specs/integrations.md) | Integration framework, GitHub (OAuth/webhooks/API proxy), Telegram bot, Gmail, Google Calendar, channel bindings, custom LLM providers, credential storage |
| [`docs/specs/sandbox-images.md`](docs/specs/sandbox-images.md) | Base image definition (Modal SDK), layer order, version pinning, cache busting, env var assembly, snapshot/restore, workspace volumes, Dockerfile drift |

Boundary rules are enforced: each spec declares what it does NOT cover. Don't add content to the wrong spec — create or update the correct one.

## Key Architectural Decisions

These are decided and locked in. Do not revisit:

1. **WebSocket only** between Runner and SessionAgent DO. No HTTP callbacks.
2. **Single merged SessionAgent DO** for session orchestration. Three DOs total: `SessionAgentDO`, `EventBusDO`, `WorkflowExecutorDO`.
3. **Single Modal App** for the Python backend (structured for future split).
4. **Repo-specific images** from day one. Base image fallback for unconfigured repos.
5. **iframes** for VNC (websockify noVNC web UI) and Terminal (TTYD web UI). No embedded JS clients.
6. **Single auth gateway proxy** on port 9000 in sandbox. Routes `/vscode/*`, `/vnc/*`, `/ttyd/*` to internal services. JWT validation.
7. **Unified plugin system** — all extensions (actions, channels, skills, personas, tools) live in `packages/plugin-*/`. Code plugins (actions/channels) are compiled into the worker via generated registries (`make generate-registries`). Content plugins (skills/personas/tools) are synced to D1 at startup and delivered to sandboxes via the Runner WebSocket.
8. **User orchestrator is a full agent session** — SessionAgent DO + sandbox + Runner + OpenCode with orchestrator persona and tools. Uses well-known session ID `orchestrator:{userId}`.
9. **Org orchestrator is also a full agent session** — org's "chief of staff", admin-configured identity/handle, handles unattributed events + automation rules. Uses well-known session ID `orchestrator:org:{orgId}`.

## Development Commands

```bash
# Install dependencies
pnpm install

# Run locally (3 terminals or use Makefile)
make dev-worker         # Cloudflare Worker on :8787
make dev-opencode       # OpenCode container on :4096
cd packages/client && pnpm dev  # Frontend on :5173

# Or all at once:
make dev-all

# Database
make db-migrate         # Run D1 migrations locally
make db-seed            # Seed test data
make db-reset           # Reset database (drop and recreate)

# Typecheck
pnpm typecheck          # All packages
cd packages/worker && pnpm typecheck  # Single package

# Tests
pnpm test               # Run all vitest tests
make test               # Unit + integration tests
make test-workflow       # Test workflow CRUD
make test-triggers       # Test trigger CRUD
make test-webhooks       # Test webhook trigger execution

# Code generation
make generate-registries # Regenerate action/channel plugin registries

# Logs
make logs-cloudflare     # Tail deployed Cloudflare Worker logs

# Deploy
make deploy              # Deploy worker + modal + client (includes migrations)
make deploy-migrate      # Apply D1 migrations to production only
make release             # Full idempotent release: install, build, push image, deploy
```

### Applying D1 Migrations to Production

`make deploy` includes the migration step, but if you need to apply migrations separately:

```bash
make deploy-migrate
```

All deploy targets (`deploy-worker`, `deploy-migrate`, `deploy-modal`, `deploy-client`) are thin wrappers around `scripts/deploy.sh` which auto-discovers config (D1 ID, Modal workspace URL, worker URL) from CLI tools when values aren't set in `.env.deploy`.

### Modal Backend Deployment

Modal deployment uses `uv` to manage the Python environment and must be run from the project root:

```bash
# Deploy Modal backend (from project root)
make deploy-modal
# Or directly: uv run --project backend modal deploy backend/app.py
```

**Path resolution gotchas:**

1. **`backend/app.py`** — Paths here are relative to the **current working directory** (project root), not the backend folder:
   ```python
   # Correct (relative to project root):
   .add_local_dir("docker", remote_path="/root/docker")
   .add_local_dir("packages/runner", remote_path="/root/packages/runner")

   # Wrong (would look for ../docker from project root):
   .add_local_dir("../docker", remote_path="/root/docker")
   ```

2. **`backend/images/base.py`** — Paths here are **remote paths** inside the Modal function container (where files were mounted by app.py):
   ```python
   # These reference /root/... which is where app.py mounted the local files
   .add_local_dir("/root/packages/runner", "/runner", copy=True)
   .add_local_file("/root/docker/start.sh", "/start.sh", copy=True)
   ```

**Forcing image rebuilds:**

The sandbox image is cached. To force a rebuild after changing `docker/start.sh` or `packages/runner/`:

1. Bump the version in `backend/images/base.py`:
   ```python
   "IMAGE_BUILD_VERSION": "2026-01-28-v7",  # increment this
   ```
2. Redeploy: `make deploy-modal`
3. Create a new session (existing sandboxes won't update)

## Developing Inside a Sandbox

When working on the valet codebase from inside a Modal sandbox (e.g. via an Valet session), the environment has specific constraints. The sandbox is a Debian container (Trixie/13, GLIBC 2.40) — not a full VM — so some tools are unavailable.

### What's available

The sandbox comes with a full dev environment already running:

| Service | Port | Purpose |
|---------|------|---------|
| **OpenCode server** | 4096 | AI coding agent (HTTP + SSE) with 73 custom tools, 3 skills, 1 plugin |
| **VS Code (code-server)** | 8080 | Web IDE |
| **noVNC** | 6080 | Virtual display GUI (Xvfb on :99) |
| **TTYD** | 7681 | Web terminal |
| **Auth gateway** | 9000 | JWT proxy that routes to all services above |
| **Runner** | — | Bridges OpenCode ↔ SessionAgent DO via WebSocket |

```bash
pnpm install                          # Install all dependencies
cd packages/client && pnpm dev        # React frontend on http://localhost:5173
pnpm typecheck                        # TypeScript checking across all packages
cd packages/worker && pnpm typecheck  # Single-package typecheck
git clone / commit / push / pull      # Git credentials are pre-configured
```

Node.js, Bun, and all standard build tools (build-essential, ripgrep, jq, etc.) are available.

### Running OpenCode

OpenCode (`opencode-ai`) is installed globally in the sandbox. The system instance runs on port 4096 (managed by `start.sh`), but you can run your own instance on a different port for testing:

```bash
opencode serve --port 4097
```

This is useful when testing changes to OpenCode configuration, custom tools, or debugging agent behavior independently of the managed session.

The system OpenCode instance is configured via `docker/opencode/opencode.json` and `docker/opencode/tools/`. Provider API keys (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, `GOOGLE_API_KEY`) are available in the environment.

### What does NOT work

- **`wrangler d1 migrations apply --local`** — Write and review migration SQL directly; it gets applied during deployment.
- **Docker** — Not available. Modal sandboxes are already containers; nested Docker (DinD) is not supported.
- **`modal deploy`** — The Modal Python backend must be deployed from outside the sandbox (requires `uv` on the host).

### Recommended workflow

1. **Frontend**: Run `cd packages/client && pnpm dev`, open `http://localhost:5173` in the VNC browser (port 6080) to preview changes live.
2. **Worker**: Run `cd packages/worker && pnpm dev` to start the worker locally with `wrangler dev` on `:8787`. You can also point the frontend at it: `VITE_API_URL=http://localhost:8787/api pnpm dev`. Use `pnpm typecheck` to catch type errors.
3. **Shared types**: Edit `packages/shared/src/`, then `pnpm typecheck` from root to verify all consumers compile.
4. **SDK**: Edit `packages/sdk/src/`, then `pnpm typecheck` from root. SDK exports are consumed by plugin packages and the worker.
5. **Plugin packages**: Edit `packages/plugin-*/`. Run `make generate-registries` if adding a new plugin with actions or channels. Run `pnpm typecheck` to verify.
6. **Runner**: Edit `packages/runner/src/`, run `cd packages/runner && pnpm typecheck`. The live runner instance is managed by `start.sh` — don't restart it manually.
7. **Migrations**: Write SQL in `packages/worker/migrations/NNNN_name.sql` and add the corresponding Drizzle schema in `packages/worker/src/lib/schema/`. Migrations are applied via `wrangler d1 migrations apply` from outside the sandbox or during `make deploy`.

### Testing against the deployed worker

The production worker URL is configured in `.env.deploy` as `WORKER_PROD_URL`. To run the frontend against it:

```bash
cd packages/client
VITE_API_URL=<your-worker-url>/api pnpm dev
```

You can also `curl` the deployed API directly for testing routes.

## Code Conventions

### Worker (Hono)

- Routes go in `packages/worker/src/routes/<name>.ts`
- Each route file exports a Hono router: `export const fooRouter = new Hono<{ Bindings: Env; Variables: Variables }>()`
- Route is mounted in `index.ts`: `app.route('/api/foo', fooRouter)`
- Database uses **Drizzle ORM**: schema in `src/lib/schema/`, query helpers in `src/lib/db/`, Drizzle instance via `src/lib/drizzle.ts`. Barrel re-export at `src/lib/db.ts`.
- Three Durable Objects in `src/durable-objects/`: `SessionAgentDO` (session-agent.ts), `EventBusDO` (event-bus.ts), `WorkflowExecutorDO` (workflow-executor.ts). All re-exported from `index.ts`.
- Services go in `packages/worker/src/services/<name>.ts`
- Middleware: `auth.ts` (OAuth + API keys), `db.ts` (Drizzle setup), `admin.ts` (role-based access), `error-handler.ts` (global error handling). Auth sets `c.get('user')` with `{ id, email, role }`.
- Plugin registries: `src/integrations/packages.ts` (actions), `src/channels/packages.ts` (channels), `src/plugins/content-registry.ts` (skills/personas/tools). All auto-generated by `make generate-registries` from `packages/plugin-*/`.
- Env types in `packages/worker/src/env.ts` — `Env` interface (bindings) and `Variables` interface (request context)
- Errors use classes from `@valet/shared`: `UnauthorizedError`, `NotFoundError`, `ValidationError`
- All API responses are JSON. Error format: `{ error, code, requestId }`
- Wrangler config in `packages/worker/wrangler.toml` — DO bindings, D1, R2, cron triggers
- Migrations in `packages/worker/migrations/` — numbered `0001_name.sql` through `0055_name.sql` (and growing)

### Frontend (React)

- File-based routing via TanStack Router: `packages/client/src/routes/`
- API layer in `packages/client/src/api/` — one file per resource with query key factories
- API client at `packages/client/src/api/client.ts` — centralized fetch with auth header injection
- Components at `packages/client/src/components/<feature>/`
- Hooks at `packages/client/src/hooks/`
- Stores (Zustand) at `packages/client/src/stores/`
- UI primitives at `packages/client/src/components/ui/` — Radix-based
- Pattern: query key factories per resource (`sessionKeys.all`, `sessionKeys.detail(id)`, etc.)
- Pattern: `PageContainer` + `PageHeader` for page layout
- Pattern: Skeleton loaders for every list component

### Shared Types

- All shared types in `packages/shared/src/types/index.ts`
- Message part types in `packages/shared/src/types/message-parts.ts`
- Scope key utilities in `packages/shared/src/scope-key.ts`
- Errors in `packages/shared/src/errors.ts`
- When adding a new entity, add types here first, then use in both worker and client

### SDK

- Integration contracts in `packages/sdk/src/integrations/` — defines the shape action packages must implement (actions, triggers, provider)
- Channel contracts in `packages/sdk/src/channels/` — defines `ChannelTransport` interface for channel packages
- MCP client and OAuth helpers in `packages/sdk/src/mcp/` — `client.ts`, `oauth.ts`, `action-source.ts`
- UI components in `packages/sdk/src/ui/` — shared channel badges, icons
- Metadata helpers in `packages/sdk/src/meta.ts`
- Exports: `@valet/sdk` (main), `@valet/sdk/channels`, `@valet/sdk/integrations`, `@valet/sdk/meta`, `@valet/sdk/ui`

### Plugin Packages (`packages/plugin-*`)

Each plugin lives in `packages/plugin-<name>/` with a `plugin.yaml` manifest. Plugins can provide any combination of:

**Code capabilities** (compiled into worker):
- `src/actions/` — tool definitions the agent can invoke (provider, actions, triggers)
- `src/channels/` — channel transport implementation (send/receive messages)

**Content capabilities** (delivered to sandbox via Runner WebSocket):
- `skills/*.md` — OpenCode skill files
- `personas/*.md` — persona files
- `tools/*.ts` — OpenCode plugin/tool files

Code plugins have `package.json`, `tsconfig.json`, and export via `@valet/plugin-<name>/actions` and/or `@valet/plugin-<name>/channels`. Content-only plugins need just `plugin.yaml` and content files.

Auto-discovered by `make generate-registries` which scans `packages/plugin-*/` and generates:
- `src/integrations/packages.ts` — action plugin registry
- `src/channels/packages.ts` — channel plugin registry
- `src/plugins/content-registry.ts` — inlined content artifacts for D1 sync

### Runner

- Runtime: Bun
- Entry: `packages/runner/src/bin.ts`
- WebSocket to DO: `packages/runner/src/agent-client.ts`
- OpenCode interaction: `packages/runner/src/prompt.ts`
- OpenCode lifecycle: `packages/runner/src/opencode-manager.ts`
- Auth gateway: `packages/runner/src/gateway.ts` (Hono on port 9000)
- Workflow engine: `packages/runner/src/workflow-engine.ts`, `workflow-compiler.ts`, `workflow-cli.ts`
- Secrets: `packages/runner/src/secrets.ts`, `onepassword-provider.ts`

### Backend

- Python 3.12, Modal SDK
- Entry: `backend/app.py` (Modal App with web endpoints)
- Configuration: `backend/config.py`
- Session management: `backend/session.py`
- Sandbox lifecycle: `backend/sandboxes.py`
- Image definition: `backend/images/base.py`

### Git Conventions

- Commit code upon completion of each bean.

## Common Patterns

### Adding a new D1 table

1. Create migration: `packages/worker/migrations/NNNN_name.sql`
2. Add Drizzle schema: `packages/worker/src/lib/schema/<name>.ts` and re-export from `schema/index.ts`
3. Add types to `packages/shared/src/types/index.ts`
4. Add DB query helpers to `packages/worker/src/lib/db/<name>.ts` and re-export from `lib/db.ts`
5. Add API routes to `packages/worker/src/routes/<name>.ts`
6. Mount in `packages/worker/src/index.ts`
7. Add React Query hooks in `packages/client/src/api/<name>.ts`
8. Run `make db-migrate` (local) or apply to production via the deploy migration workflow above

### Adding a new plugin

1. Create directory: `packages/plugin-<name>/`
2. Add `plugin.yaml` with name, version, description, icon
3. For **code plugins** (actions/channels):
   - Add `package.json` with `@valet/sdk` dependency and exports (`./actions`, `./channels`)
   - Add `tsconfig.json` extending root config
   - Implement `src/actions/` (provider, actions, triggers) and/or `src/channels/` (transport)
   - Add reference to root `tsconfig.json` and `packages/worker/tsconfig.json`
   - Add dependency in `packages/worker/package.json`: `"@valet/plugin-<name>": "workspace:*"`
4. For **content plugins** (skills/personas/tools):
   - Add content files in `skills/*.md`, `personas/*.md`, or `tools/*.ts`
5. Run `make generate-registries` to regenerate all registries
6. Run `pnpm typecheck` to verify

### Adding a new Durable Object

1. Create class in `packages/worker/src/durable-objects/<name>.ts`
2. Re-export from `packages/worker/src/index.ts`
3. Add binding to `packages/worker/wrangler.toml` (durable_objects.bindings + migrations)
4. Add type to `packages/worker/src/env.ts` Env interface
5. Use in routes via `c.env.BINDING_NAME.idFromName(...)`

### Adding a frontend route

1. Create route file at `packages/client/src/routes/<path>.tsx`
2. TanStack Router auto-generates route tree on dev server restart
3. Add navigation link to sidebar at `packages/client/src/components/layout/sidebar.tsx`
