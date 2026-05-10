# @valet/api

Node-first API for the Valet agent loop. Greenfield. **Not** the Cloudflare worker — that lives at `packages/worker` and is unchanged by this package.

Scope is intentionally tight: chat with an agent, watch it run `bash` inside a Docker sandbox, stream events back. Workflows, integrations, OAuth, dashboards, etc. are out of scope. Anything not listed below 501s.

## Run it

Required:
- Docker daemon running (the agent's tools execute inside a Docker sandbox)
- `ANTHROPIC_API_KEY` in your environment (real key, `sk-ant-…`)

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @valet/api dev
# or, paired with the web client:
make dev-local
```

The server listens on `:8788` by default.

## Routes

| Method | Path | Notes |
|---|---|---|
| GET | `/api/health` | unauthenticated; liveness probe |
| GET | `/api/auth/me` | returns the local stub user |
| GET | `/api/sessions` | list user's sessions |
| POST | `/api/sessions` | create a session (body: `{ workspace, title? }`) |
| GET | `/api/sessions/:id` | session detail |
| DELETE | `/api/sessions/:id` | tear down engine + sandbox; soft-delete row |
| GET | `/api/sessions/:id/threads` | list threads (v1 = single default thread) |
| GET | `/api/sessions/:id/messages` | paginated message history |
| POST | `/api/sessions/:id/messages` | send a prompt (body: `{ text }`) |
| GET | `/api/sessions/:id/ws` | WebSocket — engine event stream |

Wire shapes are defined in `src/wire/types.ts` and re-exported as `@valet/api/wire` for the web client.

## Auth

Stub-only. Set `VALET_LOCAL_AUTH=1` for `/api/*` access; otherwise routes 401. There is no JWT, no OAuth, no real user store. The "user" is a hardcoded local-dev identity seeded into sqlite at boot.

## Storage

Single sqlite file under `~/.valet/app.db` (override with `VALET_DATA_DIR` or `VALET_DB_PATH`). Two coexisting schema sets:

- App schema (`packages/api/migrations/`): orgs, users, org_members, agent_sessions, session_threads, messages.
- Engine schema (`@valet/store-sqlite/migrations/sqlite/`): engine_sessions, engine_threads, engine_entries, queue, decision gates.

Table names don't collide. `buildNodeProviders` runs both migration sets at boot.

## Sandbox

`@valet/sandbox-docker` by default. Each session creates a long-running container bind-mounted at `/workspace`. The container persists across prompts within a session and is destroyed when the session is deleted (or when the server shuts down via SIGINT/SIGTERM).

To use the host filesystem instead of Docker (no isolation, just for quick experiments), wire `@valet/sandbox-local` in `providers/node.ts`. Not yet exposed via env var.

## Wire protocol

REST is straightforward JSON. WebSocket events are a discriminated union with a per-session monotonic `seq`:

```ts
type WireEvent =
  | { type: "init"; session, messages }
  | { type: "message_start"; messageId, role, threadId }
  | { type: "text_delta"; messageId, threadId, delta }
  | { type: "message_update"; messageId, threadId, parts, content? }
  | { type: "message_end"; messageId, threadId, reason }
  | { type: "tool_start"; toolName, threadId, callId?, args? }
  | { type: "tool_end"; toolName, threadId, callId?, result, isError }
  | { type: "status"; threadId, status }
  | { type: "turn_end"; threadId, reason }
  | { type: "error"; code, message, recoverable, threadId? }
  | { type: "ping" };
```

The bridge in `src/engine/bridge.ts` maps engine `BusEvent`s onto these. Decision-gate, compaction, and child-task engine events are dropped — they're out of agent-loop v1 scope.

## Dogfood

```bash
ANTHROPIC_API_KEY=sk-ant-... pnpm --filter @valet/api dogfood
# or
make dogfood-api
```

Boots the server in-process, creates a session, opens the WS, posts a prompt, and asserts the agent ran `bash`, wrote `hello.txt` on the host via the Docker bind mount, and streamed all expected wire events.

## Env

| Var | Default | Purpose |
|---|---|---|
| `ANTHROPIC_API_KEY` | — (required) | Engine LLM calls |
| `VALET_LOCAL_AUTH` | unset | Set to `1` to enable the stub auth (otherwise 401) |
| `PORT` | `8788` | HTTP listen port |
| `VALET_DATA_DIR` | `~/.valet` | Where the sqlite db + blobs live |
| `VALET_DB_PATH` | `$VALET_DATA_DIR/app.db` | sqlite file (overrides `VALET_DATA_DIR`) |
| `VALET_BLOBS_DIR` | `$VALET_DATA_DIR/blobs` | filesystem blob root |
| `VALET_ENCRYPTION_KEY` | `dev-key-not-secure` | reserved for future encrypted-at-rest fields |

## What it doesn't do (yet)

- Real OAuth (GitHub/Google/Slack)
- Workflows, triggers, executions
- Integrations beyond the engine's built-in tools
- Multi-thread sessions in the wire (engine supports it; we ship one thread)
- Decision gates surfacing in the wire
- Compaction events surfacing in the wire
- Multi-process scaling — the `EngineHost` cache is per-process

## Out of scope but adjacent

- Cloudflare deploy of `@valet/api`. The legacy `packages/worker` keeps serving prod CF until a future cutover plan.
- Migrating any data from the legacy worker's D1 schema into this sqlite file.
