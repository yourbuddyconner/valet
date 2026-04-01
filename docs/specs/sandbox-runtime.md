# Sandbox Runtime

> Defines the sandbox execution environment — boot sequence, service topology, auth gateway, Runner process, OpenCode lifecycle, and the Runner-to-DO WebSocket protocol.

## Scope

This spec covers:

- Sandbox boot sequence (`start.sh`)
- Sandbox image composition (Dockerfile and Modal image)
- Service ports and topology
- Auth gateway (JWT validation, service proxying, internal API, tunnel system)
- Runner process initialization and lifecycle
- OpenCode process management and config hot-reload
- Runner-to-DO WebSocket protocol (all message types)
- Prompt handling and SSE event consumption
- Tunnel URL management
- Modal backend sandbox operations (create, terminate, hibernate, restore)

### Boundary Rules

- This spec does NOT cover session lifecycle state machine or access control (see [sessions.md](sessions.md))
- This spec does NOT cover EventBusDO or client-side real-time (see [real-time.md](real-time.md))
- This spec does NOT cover sandbox image building pipelines or warm pools (see future `sandbox-images.md`)
- This spec does NOT cover OpenCode custom tool implementations (they use the gateway internal API documented here)

## Data Model

The sandbox runtime does not own any D1 tables. Its state is transient and lives in:

- **Modal sandbox** — the running container with its filesystem and processes
- **Modal volume** — persistent workspace storage (`workspace-{sessionId}`)
- **Modal snapshot** — filesystem snapshot for hibernation/restore
- **Runner in-memory state** — WebSocket connection, prompt handler, OpenCode manager, gateway tunnel registry

### Modal Resources

| Resource | Naming | Purpose |
|----------|--------|---------|
| Sandbox | Modal-assigned ID | Running container |
| Workspace volume | `workspace-{sessionId}` | Persistent `/workspace` mount |
| Whisper volume | `whisper-models` | Shared whisper.cpp models at `/models/whisper` |
| Snapshot image | Modal-assigned `object_id` | Filesystem snapshot for hibernation |

Orchestrator workspace volumes use a stable name across session ID rotations: `workspace-orchestrator-{userId}` (strips rotation suffix).

### Configuration Constants

```python
DEFAULT_IDLE_TIMEOUT_SECONDS = 15 * 60   # 15 minutes
MODAL_IDLE_TIMEOUT_BUFFER_SECONDS = 30 * 60  # 30-minute safety buffer
MAX_TIMEOUT_SECONDS = 24 * 60 * 60  # 24 hours
OPENCODE_PORT = 4096
GATEWAY_PORT = 9000
NODE_VERSION = "22"
OPENCODE_VERSION = "1.1.52"
```

## Service Topology

### Port Map

| Port | Service | Binding | Access |
|------|---------|---------|--------|
| 4096 | OpenCode server | 0.0.0.0 | Modal encrypted tunnel |
| 9000 | Auth gateway (Hono/Bun) | 0.0.0.0 | Modal encrypted tunnel |
| 8765 | code-server (VS Code) | 127.0.0.1 | Gateway only |
| 6080 | noVNC (websockify) | 0.0.0.0 | Gateway only |
| 7681 | TTYD (web terminal) | 0.0.0.0 | Gateway only |
| 5900 | x11vnc (raw VNC) | localhost | Internal only |

Modal creates encrypted tunnels for ports 4096 and 9000. All other services are accessed through the gateway on port 9000.

### Architecture Layers

```
Frontend (Browser)
     |
     | (HTTP/WS via Cloudflare Worker)
     v
SessionAgent Durable Object
     |
     | (WebSocket: Runner <-> DO protocol)
     v
Runner Process (packages/runner/src/bin.ts)
     |
     +---> OpenCodeManager (process lifecycle)
     |         |
     |         +---> OpenCode Server (port 4096)
     |                    |
     |                    +---> SSE event stream -> PromptHandler
     |                    +---> HTTP API (sessions, prompts)
     |
     +---> Auth Gateway (port 9000)
     |         |
     |         +---> VS Code (port 8765)
     |         +---> VNC (port 6080)
     |         +---> TTYD (port 7681)
     |         +---> Custom tunnels (/t/*)
     |         +---> Internal API (/api/*)
     |
     +---> AgentClient (WebSocket to DO)
```

Data flows bidirectionally: user prompts go DO -> Runner -> OpenCode. Agent responses stream back via OpenCode SSE -> Runner -> DO WebSocket -> Frontend.

## Boot Sequence

`start.sh` runs as PID 1 (`exec /bin/bash /start.sh`) with `set -e`.

### Step 1 — Environment Setup

```bash
export DISPLAY=:99
export HOME=/root
export OPENCODE_DB=/workspace/.opencode/state/opencode.db
```

Sets display for VNC and establishes port constants.
`start.sh` also ensures `/workspace/.opencode/state` exists before the runner starts so OpenCode's SQLite database lives on the workspace volume instead of ephemeral home-directory storage.

### Step 2 — VNC Stack

1. Clean stale lock files (critical after snapshot restore).
2. `Xvfb :99 -screen 0 1920x1080x24 &` — virtual framebuffer.
3. `sleep 1` — wait for X server.
4. `fluxbox &` — window manager.
5. `x11vnc -display :99 -forever -shared -rfbport 5900 -nopw -quiet &` — VNC server (no password; auth handled by gateway).
6. `websockify --web /usr/share/novnc 6080 localhost:5900 &` — WebSocket bridge for noVNC.

### Step 3 — Git Configuration

- Configures `user.name` and `user.email` from env vars.
- Sets up HTTPS credential helper using `GITHUB_TOKEN`.
- Creates global gitignore excluding `.valet/` and `.opencode/`.

### Step 4 — Repository Clone

If `REPO_URL` is set:
1. Clone into `/workspace/<repo-name>`.
2. Checkout `REPO_BRANCH` if set.
3. Checkout `REPO_REF` (specific commit/tag) if set.
4. Skip if directory already exists (idempotent for snapshot restores).

### Step 5 — Persona/Context Injection

Creates `.valet/persona/` inside the workspace:
- `00-repo-context.md` — auto-generated from `REPO_URL`, `REPO_BRANCH`, `REPO_REF`.
- Persona files from `PERSONA_FILES_JSON` env var (JSON array parsed by `jq`), each with a sort-order prefix.

### Step 6 — code-server (VS Code)

```bash
code-server --bind-addr "127.0.0.1:8765" --auth none \
  --disable-telemetry --disable-update-check \
  --welcome-text "Valet Workspace" "${WORK_DIR}" &
```

Binds only to localhost; external access through gateway.

### Step 7 — TTYD

```bash
ttyd -W -p 7681 bash -c "cd ${WORK_DIR} && exec bash -l" &
```

Writable web terminal in workspace directory. Health check verifies PID and port.

### Step 8 — Runner (replaces PID 1)

```bash
exec bun run src/bin.ts \
  --opencode-url "http://localhost:4096" \
  --do-url "${DO_WS_URL}" \
  --runner-token "${RUNNER_TOKEN}" \
  --session-id "${SESSION_ID}" \
  --gateway-port "9000"
```

### Required Environment Variables

| Variable | Required | Source | Purpose |
|----------|----------|--------|---------|
| `SESSION_ID` | Yes | Modal secrets | Session identifier |
| `DO_WS_URL` | Yes | Modal secrets | WebSocket URL to SessionAgent DO |
| `RUNNER_TOKEN` | Yes | Modal secrets | Auth token for DO connection |
| `JWT_SECRET` | Yes | Modal secrets | HMAC key for gateway JWT validation |
| `OPENCODE_SERVER_PASSWORD` | Yes | Modal secrets | OpenCode server auth |
| `REPO_URL` | No | Modal secrets | Git repo to clone |
| `REPO_BRANCH` | No | Modal secrets | Branch to check out |
| `REPO_REF` | No | Modal secrets | Specific commit/tag |
| `GIT_USER_NAME` | No | Modal secrets | Git identity |
| `GIT_USER_EMAIL` | No | Modal secrets | Git identity |
| `GITHUB_TOKEN` | No | Modal secrets | HTTPS git credential |
| `PERSONA_FILES_JSON` | No | Modal secrets | JSON array of persona files |
| `IS_ORCHESTRATOR` | No | Modal secrets | Orchestrator mode flag |
| `ANTHROPIC_API_KEY` | No | Modal secrets | Anthropic provider |
| `OPENAI_API_KEY` | No | Modal secrets | OpenAI provider |
| `GOOGLE_API_KEY` | No | Modal secrets | Google provider |
| `PARALLEL_API_KEY` | No | Modal secrets | Parallel AI tools |

## Auth Gateway

The gateway is a Hono HTTP server on Bun (port 9000) providing JWT-authenticated proxying and an internal API for OpenCode tools.

### Authentication Flow

1. **First request**: client provides JWT via `?token=` query param or `Authorization: Bearer` header.
2. **JWT verification**: HMAC-SHA256 using `JWT_SECRET`. Payload must contain `sub` (user ID), `sid` (session ID), `exp` (expiry).
3. **Session cookie**: on success, a 15-minute `gateway_session` cookie is set.
4. **Subsequent requests**: cookie validated from in-memory session store (no JWT needed).

### Authenticated Proxy Routes

| Route Pattern | Backend | Port |
|---------------|---------|------|
| `/vscode/*` | code-server | 8765 |
| `/vnc/*` | noVNC/websockify | 6080 |
| `/ttyd/*` | TTYD | 7681 |
| `/t/:name/*` | Dynamic tunnel | Registry |

WebSocket connections are also proxied (detected via `upgrade: websocket` header). TTYD WebSocket requires `"tty"` subprotocol. Messages are buffered until backend connection opens.

### Unauthenticated Routes

| Route | Purpose |
|-------|---------|
| `/health` | Health check |
| `/opencode/*` | Proxy to OpenCode (server-to-server) |
| `/api/*` | Internal API (called by OpenCode tools) |

### Internal API Endpoints

These are called by OpenCode custom tools at `http://localhost:9000/api/*`. Each endpoint routes through `GatewayCallbacks` which delegates to `AgentClient` WebSocket messages to the DO.

**Cross-Session:**
- `POST /api/spawn-child` — Spawn child session
- `POST /api/terminate-child` — Terminate child session
- `POST /api/complete-session` — Self-terminate
- `POST /api/session-message` — Send message to another session
- `GET /api/session-messages` — Read messages from another session
- `POST /api/forward-messages` — Forward messages between sessions
- `GET /api/child-sessions` — List child sessions
- `GET /api/session-status` — Get another session's status

**GitHub:**
- `POST /api/create-pull-request` — Create PR
- `POST /api/update-pull-request` — Update PR
- `GET /api/pull-requests` — List PRs
- `GET /api/pull-request` — Get specific PR
- `POST /api/git-state` — Report git state

**Memory:**
- `GET /api/memories` — Read memories
- `POST /api/memories` — Write memory
- `DELETE /api/memories/:id` — Delete memory

**Workflows, Triggers, Executions:**
- Full CRUD for workflows, triggers, and execution management.

**Notifications/Mailbox:**
- `POST /api/notifications/emit` — Emit notification
- `GET /api/notifications` — Check notifications

**Tasks:**
- `GET/POST /api/tasks` — List/create tasks
- `PUT /api/tasks/:id` — Update task
- `GET /api/my-tasks` — Current session's tasks

**Secrets (1Password):**
- `POST /api/secrets/list`, `/api/secrets/inject`, `/api/secrets/run`, `/api/secrets/fill`

**Other:**
- `POST /api/channel-reply` — Reply to a channel
- `POST /api/image` — Upload image

### Tunnel System

Dynamic tunnels allow tools inside the sandbox to expose arbitrary ports:

1. `POST /api/tunnels` — Register tunnel (`name`, `port`, `protocol`).
2. `DELETE /api/tunnels/:name` — Unregister.
3. `GET /api/tunnels` — List registered tunnels.
4. Accessible at `/t/:name/*` with auth.
5. On change: `callbacks.onTunnelsUpdated()` notifies DO via WebSocket, making tunnels visible in frontend UI.

## Runner Process

### Initialization Sequence (`bin.ts`)

1. Parse CLI args: `--opencode-url`, `--do-url`, `--runner-token`, `--session-id`, `--gateway-port`.
2. Build initial OpenCode config from env vars (provider keys, orchestrator mode, Parallel AI toggle).
3. `OpenCodeManager.start(initialConfig)` — write config, copy tools/skills, spawn process, health check.
4. Create `AgentClient` — WebSocket client to SessionAgent DO.
5. Start gateway with comprehensive callback map wiring all internal API endpoints through `AgentClient`.
6. Create `PromptHandler` — bridge between OpenCode and AgentClient.
7. Register event handlers for all DO-to-Runner message types.
8. Install SIGTERM/SIGINT handlers for graceful shutdown.
9. Wait 3 seconds (race condition mitigation — let DO store runner token).
10. Connect to DO with exponential backoff retry (up to 30s, indefinite retries).
11. Post-connect: discover models from OpenCode, send model list to DO, send `agentStatus: idle` to signal readiness.

### OpenCode Manager

Manages the OpenCode server process lifecycle.

**`start()` sequence:**
1. **writeConfigFiles()**: Write `auth.json` (provider keys, mode 0o600), merge base `opencode.json` with tool toggles, custom instructions, and custom providers, write to `{workspace}/.opencode/opencode.json`.
2. **copyToolsAndSkills()**: Copy tools from `/opencode-config/tools/` to workspace `.opencode/tools/`. For orchestrators: remove `complete_session.ts` and `notify_parent.ts`. Copy skills directories recursively.
3. **spawnProcess()**: `Bun.spawn(["opencode", "serve", "--port", "4096"], { cwd: workspaceDir, env: { ...process.env, OPENCODE_DB: "/workspace/.opencode/state/opencode.db" } })`. Monitors for unexpected exit.
4. **waitForHealth()**: Poll `http://localhost:4096/health` every 1s, up to 60 retries.

**Config hot-reload (`applyConfig()`):** Serialized via promise chain. Compares new config via JSON stringify — only restarts if something changed. Restart: SIGTERM, 5s grace, SIGKILL, then fresh `start()`.

### Prompt Handler

The prompt handler (`prompt.ts`, ~2700 lines) bridges OpenCode's SSE event stream to the DO's WebSocket protocol.

**Per-channel session architecture:** Each communication channel (web, Telegram, Slack) gets its own `ChannelSession` with its own OpenCode session ID, tracking state, and message mappings. Channel keys: `"web:default"`, `"telegram:12345"`, etc.
Thread channels (`"thread:<threadId>"`) additionally reuse the persisted `session_threads.opencode_session_id` binding from D1. On the first resumed prompt after runner startup, the prompt handler verifies `GET /session/:id`; only a verified missing session triggers recreation and fallback continuation injection.

**Prompt flow:**
1. Receive prompt from DO (messageId, content, model, author, attachments, channel context).
2. Finalize any pending response on the channel.
3. Ensure channel has an OpenCode session (create via `POST /session` if needed).
4. Build model failover chain from `modelPreferences`.
5. Transcribe audio attachments via whisper.cpp if present.
6. Send `agentStatus: thinking` to DO.
7. POST `prompt_async` to OpenCode with attributed content and model selection.
8. Return immediately — response arrives via SSE.

**SSE event consumption (`consumeEventStream()`):**
- Connects to `/global/event` (fallback: `/event`).
- Reads raw SSE frames, parses JSON, normalizes events.
- Key event handling:
  - `message.part.updated` (text): streams deltas via V2 protocol (`message.part.text-delta`).
  - `message.part.updated` (tool): sends `message.part.tool-update` with status changes.
  - `session.idle`: finalizes the response turn.
  - `session.error`: detects retriable provider errors, attempts model failover.
  - `permission.asked`: auto-approves all permissions (headless agent).

**Model failover:** When a provider error is detected (rate limit, auth, billing), `attemptModelFailover()` tries the next model in the preferences chain. Resets channel state, sends `model-switched` notification, re-dispatches prompt.

## WebSocket Protocol (Runner ↔ DO)

### Connection

- URL: `wss://<worker>/ws?role=runner&token=<RUNNER_TOKEN>`
- Keepalive: `ping` every 30 seconds, expects `pong`.
- Message buffering: messages sent while disconnected are queued and flushed on reconnect.
- Reconnection: exponential backoff 1s-30s. Exit on close code 1000 with "Replaced by new runner connection". Exit after 5 consecutive upgrade failures (1002).

### DO-to-Runner Messages

| Type | Purpose | Key Fields |
|------|---------|-----------|
| `prompt` | New user prompt | `messageId`, `content`, `model?`, `attachments?`, `modelPreferences?`, `channelType?`, `channelId?`, `opencodeSessionId?`, `threadId?`, `continuationContext?`, author fields |
| `answer` | Answer to question | `questionId`, `answer` |
| `stop` | Shutdown signal | — |
| `abort` | Cancel current operation | `channelType?`, `channelId?` |
| `revert` | Undo message | `messageId` |
| `diff` | Request git diff | `requestId` |
| `review` | Request code review | `requestId` |
| `opencode-command` | Execute slash command | `command`, `args?`, `requestId` |
| `new-session` | Create new channel session | `channelType`, `channelId`, `requestId` |
| `init` | DO initialized | — |
| `opencode-config` | Apply new config | `config` (tools, providerKeys, instructions, isOrchestrator, customProviders) |
| `pong` | Keepalive response | — |
| `tunnel-delete` | Remove tunnel | `name`, actor fields |
| `workflow-execute` | Dispatch workflow | `executionId`, `payload`, `model?`, `modelPreferences?` |
| Various `*-result` | Responses to Runner requests | `requestId`, data, `error?` |

### Runner-to-DO Messages

| Type | Purpose |
|------|---------|
| `message.create` | Start assistant turn (V2) |
| `message.part.text-delta` | Stream text chunk (V2) |
| `message.part.tool-update` | Tool call status change (V2) |
| `message.finalize` | End turn (V2) |
| `workflow-chat-message` | Chat message (any role) |
| `question` | Ask user a question |
| `screenshot` | Upload screenshot |
| `error` | Report error |
| `complete` | Signal prompt completion |
| `agentStatus` | Agent status change (`idle`/`thinking`/`tool_calling`/`streaming`/`error`) |
| `models` | Available LLM model list |
| `tunnels` | Tunnel state update |
| `git-state` | Branch/commit info |
| `ping` | Keepalive |
| `spawn-child` | Request child session spawn |
| `session-message` | Send message to another session |
| `terminate-child` | Terminate child session |
| `self-terminate` | Self-terminate session |
| `memory-read/write/delete` | Memory operations |
| `create-pr` / `update-pr` | GitHub PR operations |
| `pr-created` / `files-changed` / `child-session` / `title` | State update broadcasts |
| `workflow-list/run/sync/update/delete` | Workflow operations |
| `channel-reply` | Reply to external channel |
| `task-create/list/update` | Task operations |
| Various other request types | Routed through DO to worker services |

### Request-Response Pattern

For operations requiring a response (spawn-child, PR operations, memory, etc.):
1. Generate `requestId` (UUID).
2. Store `{resolve, reject, timer}` promise in `pendingRequests` map.
3. Send request message.
4. Timeout after operation-specific duration (15s-60s).
5. Resolve when matching `*-result` message arrives from DO.

### V2 Parts-Based Streaming Protocol

The primary message streaming protocol:

1. `message.create` — creates placeholder message in DO, broadcasts empty message to clients.
2. `message.part.text-delta` — streams text chunks, broadcast as `chunk` to clients.
3. `message.part.tool-update` — updates tool call parts (status: `pending`/`running`/`completed`/`error`, args, result), broadcast as `message.updated`.
4. `message.finalize` — finalizes turn with complete text and parts, broadcast as `message.updated`. Reason: `end_turn`, `error`, or `canceled`.

Supports hibernation recovery — if DO hibernates mid-turn, `recoverTurnFromSQLite` reconstructs state from the placeholder row.

## Modal Backend

### Endpoints (`app.py`)

| Endpoint | Purpose |
|----------|---------|
| `POST /create-session` | Create sandbox, return tunnel URLs |
| `POST /terminate-session` | Terminate sandbox |
| `POST /hibernate-session` | Snapshot filesystem, terminate |
| `POST /restore-session` | Restore from snapshot |
| `POST /session-status` | Check sandbox status |
| `POST /delete-workspace` | Delete workspace volume |

### Sandbox Creation (`sandboxes.py`)

1. Get image via `_get_image()` (currently always `get_base_image()`).
2. Build secrets: caller-provided `env_vars` + core secrets (`DO_WS_URL`, `RUNNER_TOKEN`, `SESSION_ID`, `JWT_SECRET`, `OPENCODE_SERVER_PASSWORD`).
3. Serialize persona files to `PERSONA_FILES_JSON`.
4. Create Modal sandbox:
   - Command: `/bin/bash /start.sh`
   - Encrypted ports: `[4096, 9000]`
   - Timeout: 24 hours max
   - Idle timeout: user timeout + 30-minute buffer
   - Volumes: workspace (`/workspace`), whisper models (`/models/whisper`)
5. Retrieve tunnel URLs from `sandbox.tunnels`.

### Tunnel URL Structure

Modal returns tunnel URLs for encrypted ports. The worker constructs derived URLs:

```python
tunnel_urls = {
    "opencode": tunnels[4096].url,
    "gateway": tunnels[9000].url,
    "vscode": f"{tunnels[9000].url}/vscode",
    "vnc": f"{tunnels[9000].url}/vnc",
    "ttyd": f"{tunnels[9000].url}/ttyd",
}
```

### Hibernation

```python
image = await sandbox.snapshot_filesystem.aio(timeout=55)
await sandbox.terminate.aio()
return image.object_id
```

Raises `SandboxAlreadyFinishedError` if sandbox already exited (e.g., Modal idle timeout).

### Restore

Uses `modal.Image.from_id(snapshot_image_id)` as base image, creates new sandbox with fresh secrets. Filesystem state (repo, deps, generated files) preserved from snapshot.

## OpenCode Configuration

Base config at `docker/opencode/opencode.json`. The Runner merges this with runtime config (custom providers, tool toggles, instructions) and writes the final config to `{workspace}/.opencode/opencode.json`.

### Custom Tools (68 tools)

All tools communicate through the gateway at `http://localhost:9000/api/*`:

```
OpenCode tool -> HTTP -> Gateway (/api/*) -> GatewayCallbacks -> AgentClient -> WebSocket -> DO
```

Tool categories: session management (10), GitHub/PR (6), memory (4), workflows (13), triggers (4), executions (5), tunnels (4), notifications/tasks (8), secrets (4), channels (2), Parallel AI (4), other (4).

### Skills (3)

- `browser/` — Browser screenshot skill
- `sandbox-tunnels/` — Tunnel management skill
- `workflows/` — Workflow execution skill

## Edge Cases & Failure Modes

### Stale Lock Files After Restore

`start.sh` explicitly cleans X11 and code-server lock files before starting the VNC stack. Without this, services would fail to start after snapshot restore.

### Runner Connect Race Condition

A 3-second delay before first connection attempt mitigates a race where the DO hasn't stored the runner token yet. Further protected by exponential backoff retry.

### OpenCode Crash

`OpenCodeManager` monitors the spawned process. On unexpected exit, `healthy` is set to `false`. The runner can detect this and attempt restart via `applyConfig()`.

### Provider Rate Limiting

The prompt handler implements model failover. When a provider error is detected during SSE consumption, it tries the next model in the user's preference chain without losing the prompt.

### Runner Replacement

If a new runner connects while one is already active, the old runner's WebSocket is closed with code 1000 and reason "Replaced by new runner connection". The old process detects this and exits immediately.

### Message Buffering During Disconnect

Messages sent by the runner while the WebSocket is disconnected are queued in an in-memory buffer. On reconnection, the buffer is flushed before new messages are sent.

## Implementation Status

### Fully Implemented
- Sandbox boot sequence with all services (VNC, code-server, TTYD, OpenCode, Runner, Gateway)
- Auth gateway with JWT validation, session cookies, service proxying, WebSocket proxying
- Full internal API for OpenCode tool communication
- Dynamic tunnel registration and proxying
- Runner initialization with OpenCode management
- OpenCode SQLite persistence on the workspace volume via `OPENCODE_DB`
- V2 parts-based streaming protocol with hibernation recovery
- Per-channel OpenCode session architecture
- Persisted thread-session adoption with fallback-only continuation injection
- Model failover chain
- Modal backend: create, terminate, hibernate, restore, delete-workspace
- Config hot-reload without losing state

### Not Implemented
- Repo-specific images (always uses base image currently)
- Warm sandbox pools
- Image build pipeline
