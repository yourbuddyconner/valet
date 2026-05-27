# Sandbox Images

> Defines the sandbox container image — its composition, build process, version management, cache busting, and the relationship between the image, start script, and runtime configuration.

## Scope

This spec covers:

- Base image definition (Modal Python SDK)
- Layer order and software inventory
- Version pinning and cache busting strategy
- Image selection (currently always base image)
- Environment variable assembly (worker → Modal backend → sandbox)
- Dockerfile (non-production reference)
- Docker Compose (local dev)
- Snapshot/restore image lifecycle
- Workspace volumes and persistence
- OpenCode configuration template

### Boundary Rules

- This spec does NOT cover the sandbox boot sequence or service topology (see [sandbox-runtime.md](sandbox-runtime.md))
- This spec does NOT cover session lifecycle or sandbox orchestration (see [sessions.md](sessions.md))
- This spec does NOT cover the Runner process or auth gateway behavior (see [sandbox-runtime.md](sandbox-runtime.md))

## Image Architecture

### Build Paths

| Path | File | Used In |
|------|------|---------|
| **Modal SDK** (production) | `backend/images/base.py` | All production sandboxes |
| **Dockerfile** (reference) | `docker/Dockerfile.sandbox` | Not used in production; reference/local testing |
| **Docker Compose** (local dev) | `Dockerfile` + `docker-compose.yml` | Local dev only (OpenCode standalone) |

Production sandboxes are built exclusively via `backend/images/base.py` using Modal's Python image API. The Dockerfile exists for reference but has drifted from the Modal image.

### Image Selection

```python
def _get_image(self, image_type: str) -> modal.Image:
    # Phase 1: always use base image
    # Future: repo-specific images
    return get_base_image()
```

The `image_type` parameter is accepted and threaded through the entire call chain but is always `"base"` and always ignored. Repo-specific images are explicitly deferred.

## Base Image Definition

### Base OS

```python
modal.Image.from_registry("debian:bookworm-slim", add_python="3.12")
```

Debian 12 (Bookworm) slim, GLIBC 2.36, Python 3.12 (added by Modal).

### Layer Order

| # | Layer | Method | Version |
|---|-------|--------|---------|
| 1 | System packages | `.apt_install()` | Latest from apt |
| 2 | Node.js | `.run_commands()` | 22 (pinned via `NODE_VERSION`) |
| 3 | Bun | `.run_commands()` | Latest (curl installer, unpinned) |
| 4 | OpenCode CLI + agent-browser | `.run_commands()` | `1.1.52` (pinned via `OPENCODE_VERSION`) |
| 5 | Playwright Chromium | `.run_commands()` | Matches agent-browser's Playwright |
| 6 | code-server | `.run_commands()` | Latest (installer, unpinned) |
| 7 | VNC stack + Chromium | `.apt_install()` | Latest from apt |
| 8 | TTYD | `.run_commands()` | `1.7.7` (pinned) |
| 9 | whisper.cpp | `.apt_install("cmake")` + `.run_commands()` | HEAD (`--depth 1`, unpinned) |
| 10 | Cache-bust echo | `.run_commands()` | `RUNNER_VERSION` string |
| 11 | Runner package | `.add_local_dir()` + `.run_commands()` | From local source |
| 12 | Workflow CLI wrapper | `.run_commands()` | N/A |
| 13 | start.sh | `.add_local_file()` | From local source |
| 14 | OpenCode config + tools | `.add_local_dir()` | From local source |
| 15 | Workspace dir + bashrc | `.run_commands()` | N/A |
| 16 | Environment variables | `.env()` | Contains `IMAGE_BUILD_VERSION` |

### System Packages (Layer 1)

```
git, curl, wget, jq, ripgrep, build-essential,
ca-certificates, gnupg, sudo, unzip, openssh-client, bash, procps
```

### VNC Stack Packages (Layer 7)

```
xvfb, fluxbox, x11vnc, websockify, novnc,
chromium, imagemagick, xdotool, ffmpeg
```

### Software Installed

| Software | Version | Source | Notes |
|----------|---------|-------|-------|
| Node.js | 22.x | NodeSource apt repo | Pinned major version |
| Bun | Latest | `bun.sh/install` | Unpinned |
| OpenCode (`opencode-ai`) | 1.1.52 | npm global install | Pinned |
| agent-browser | Latest | npm global install | Unpinned |
| Playwright + Chromium | Matches agent-browser | `npx playwright install` | |
| code-server | Latest | install.sh | Unpinned |
| TTYD | 1.7.7 | GitHub release | Pinned |
| whisper.cpp | HEAD | `git clone --depth 1` | Unpinned |
| Chromium (system) | Latest | Debian apt | Unpinned |
| Xvfb, fluxbox, x11vnc, websockify, noVNC | Latest | Debian apt | Unpinned |
| imagemagick, xdotool, ffmpeg | Latest | Debian apt | Unpinned |

### Runner Installation

Copied from a local directory mount (not from a registry):

```python
.add_local_dir(
    "/root/packages/runner",
    "/runner",
    copy=True,
    ignore=["node_modules", "*.log"],
)
.run_commands("cd /runner && /root/.bun/bin/bun install")
```

`node_modules` is excluded because it contains symlinks to the monorepo root that cause Modal timeouts. Bun install runs inside the container.

### OpenCode Configuration

Copied into the image at `/opencode-config/`:
- `opencode.json` — template config with system instructions
- `tools/` — 63 custom TypeScript tool files
- `skills/` — 3 skill directories (`browser/`, `workflows/`, `sandbox-tunnels/`)

At runtime, the Runner's `OpenCodeManager` reads from `/opencode-config/`, merges with runtime config (custom providers, tool toggles, instructions), and writes the final config to `${OPENCODE_RUNTIME_DIR}/config/opencode/opencode.json`. Generated OpenCode config/state is ephemeral; `/workspace` remains reserved for the working tree and user-visible files.

### Baked-In Environment Variables

```python
.env({
    "BUN_INSTALL": "/root/.bun",
    "PATH": "/root/.bun/bin:/usr/local/sbin:...",
    "DISPLAY": ":99",
    "HOME": "/root",
    "IMAGE_BUILD_VERSION": "2026-02-23-v116-fix-skills-copy-recursive",
    "AGENT_BROWSER_EXECUTABLE_PATH": "/usr/bin/chromium",
    "AGENT_BROWSER_PROFILE": "/root/.agent-browser-profile",
    "PLAYWRIGHT_BROWSERS_PATH": "/ms-playwright",
})
```

## Cache Busting

No automated version bumping. The process is fully manual.

### Two Mechanisms

**1. `RUNNER_VERSION` echo (layer 10):**

```python
.run_commands("echo 'RUNNER_VERSION=2026-02-22-v113-v2-turn-id-fix'")
```

Placed before `add_local_dir` for the runner. Changing this string invalidates the runner copy layer and **all subsequent layers** (runner install, workflow CLI, start.sh, opencode config, workspace, env vars). Use this when changing runner source, docker files, or OpenCode config.

**2. `IMAGE_BUILD_VERSION` env var (layer 16):**

```python
"IMAGE_BUILD_VERSION": "2026-02-23-v116-fix-skills-copy-recursive",
```

Set in the final `.env()` block. Changing this only invalidates the env layer itself. Serves primarily as a documentation marker for deployed version.

### Deployment Process

```bash
# 1. Bump version in backend/images/base.py
# 2. Deploy
make deploy-modal
# 3. New sessions use updated image; existing sandboxes unaffected
```

`make deploy-modal` runs `uv run --project backend modal deploy backend/app.py`.

## App-Level File Mounting

`backend/app.py` defines a `fn_image` for the Modal web endpoint functions that mounts local files:

```python
fn_image = (
    modal.Image.debian_slim()
    .add_local_python_source("session", "sandboxes", "config", "images")
    .add_local_dir("docker", remote_path="/root/docker")
    .add_local_dir("packages/runner", remote_path="/root/packages/runner")
)
```

This is why `base.py` references paths like `/root/docker/start.sh` and `/root/packages/runner` — these are paths inside the Modal function container, not local filesystem paths. The paths in `app.py` are relative to the project root at deploy time.

## Environment Variable Assembly

The worker assembles environment variables before passing them to the Modal backend.

### Assembly Functions (`packages/worker/src/lib/env-assembly.ts`)

**`assembleProviderEnv()`** — LLM API keys. Checks org-level D1 keys first, falls back to worker env vars. Providers: `anthropic`, `openai`, `google`, `parallel`.

**`assembleCredentialEnv()`** — Per-user credentials. Currently only 1Password (`OP_SERVICE_ACCOUNT_TOKEN`).

**`assembleCustomProviders()`** — Custom OpenAI-compatible providers with decrypted API keys. Passed as structured data (not env vars), written to `opencode.json` by the Runner.

**`assembleGitHubEnv()`** — Git/repo config: `GITHUB_TOKEN`, `REPO_URL`, `REPO_BRANCH`, `REPO_REF`, `GIT_USER_NAME`, `GIT_USER_EMAIL`.

### Full Spawn Request

```typescript
const spawnRequest = {
    sessionId, userId, workspace,
    imageType: 'base',
    doWsUrl, runnerToken,
    jwtSecret: env.ENCRYPTION_KEY,
    idleTimeoutSeconds,
    envVars,           // LLM keys + credentials + GitHub config
    personaFiles,      // structured persona file data
    customProviders,   // custom LLM provider configs
};
```

### Core Secrets (Set by Modal Backend)

These are added by `sandboxes.py` and **cannot be overridden** by caller-provided env vars:

| Variable | Source |
|----------|--------|
| `DO_WS_URL` | From spawn request |
| `RUNNER_TOKEN` | From spawn request |
| `SESSION_ID` | From spawn request |
| `JWT_SECRET` | From spawn request |
| `OPENCODE_SERVER_PASSWORD` | From Modal secrets |

## Sandbox Creation

```python
sandbox = await modal.Sandbox.create.aio(
    "/bin/bash", "/start.sh",
    app=self.app,
    image=image,
    encrypted_ports=[4096, 9000],
    timeout=86400,                    # 24 hours max
    secrets=[modal.Secret.from_dict(secrets_dict)],
    volumes={
        "/workspace": modal.Volume.from_name(volume_name, create_if_missing=True),
        "/models/whisper": modal.Volume.from_name("whisper-models"),
    },
)
```

Modal `idle_timeout` is intentionally not set. SessionAgent DO hibernates idle sessions and snapshots the filesystem. Modal's own sandbox idle detector does not treat the runner's outbound WebSocket or active OpenCode work as sandbox activity, so a Modal idle timeout can terminate active Valet sessions.

### Volumes

| Mount | Volume Name | Purpose |
|-------|-------------|---------|
| `/workspace` | `workspace-{sessionId}` | Persistent workspace (repos, deps, generated files) |
| `/models/whisper` | `whisper-models` | Shared whisper.cpp GGML models (read-only) |

**Orchestrator volume naming:** strips rotation UUID suffix so the volume persists across restarts: `orchestrator:{userId}:{uuid}` → `workspace-orchestrator-{userId}`.

### Tunnel URLs

Modal creates encrypted tunnels for ports 4096 and 9000. The backend constructs derived URLs:

```python
tunnel_urls = {
    "opencode": tunnels[4096].url,
    "gateway": tunnels[9000].url,
    "vscode": f"{tunnels[9000].url}/vscode",
    "vnc": f"{tunnels[9000].url}/vnc",
    "ttyd": f"{tunnels[9000].url}/ttyd",
}
```

## Snapshot/Restore

### Hibernation (Snapshot)

```python
image = await sandbox.snapshot_filesystem.aio(timeout=55)
await sandbox.terminate.aio()
return image.object_id
```

- Uses Modal's `snapshot_filesystem` API with 55-second timeout.
- Returns a Modal image reference (`object_id`).
- If sandbox already exited, `ConflictError` -> `SandboxAlreadyFinishedError`.
- Sandbox terminated **after** snapshot succeeds.
- Snapshot ID stored in D1 `sessions.snapshot_image_id`.

The snapshot captures everything **outside** of mounted volumes. The `/workspace` volume is persistent and separate.

### Restore

```python
image = modal.Image.from_id(snapshot_image_id)
# Create new sandbox with snapshot image + fresh secrets
```

- Uses `modal.Image.from_id()` to load the snapshotted filesystem.
- Creates a **new sandbox** with same configuration but snapshot image instead of base image.
- Fresh secrets injected (new DO_WS_URL, RUNNER_TOKEN, etc.).
- Workspace volume still mounted — file state preserved.
- `start.sh` runs again; cleans stale lock files for safe restart.

## Dockerfile (Non-Production)

`docker/Dockerfile.sandbox` is a multi-stage build that mirrors the Modal image but has **significant drift**:

| Aspect | Modal Image | Dockerfile |
|--------|-------------|-----------|
| OpenCode package | `opencode-ai@1.1.52` | `@opencode-ai/cli` (old name, unpinned) |
| whisper.cpp | Included | Not included |
| imagemagick, xdotool, ffmpeg | Included | Not included |
| Runner build | Source copy + `bun install` | Multi-stage `bun build` to dist |
| OpenCode config/tools | Copied from `/opencode-config` | Not copied |
| Python | 3.12 | Not included |
| Custom bashrc | Included | Not included |

The Dockerfile uses a true multi-stage build pattern (compile in build stage, copy artifacts). The Modal image copies source and runs `bun install` directly.

## Docker Compose (Local Dev)

`docker-compose.yml` runs OpenCode standalone for local development:

```yaml
services:
  opencode:
    build: .   # Root Dockerfile (ghcr.io/anomalyco/opencode:latest)
    ports: ["4096:4096"]
    volumes: ["./workspaces:/workspace"]
```

No Runner, no VNC, no code-server, no TTYD, no gateway. Only exposes port 4096. Used with `make dev-opencode` alongside `make dev-worker`.

## Configuration Constants

```python
# backend/config.py
DEFAULT_IDLE_TIMEOUT_SECONDS = 15 * 60    # 15 minutes
MAX_TIMEOUT_SECONDS = 24 * 60 * 60       # 24 hours
OPENCODE_PORT = 4096
GATEWAY_PORT = 9000
NODE_VERSION = "22"
WHISPER_MODELS_VOLUME = "whisper-models"
WHISPER_MODELS_MOUNT = "/models/whisper"
```

**Unused constants:** `BASE_IMAGE_TAG` (`"debian:bookworm-slim"`) and `BUN_VERSION` (`"latest"`) are defined but never imported. The actual values are hardcoded in `base.py`.

## Edge Cases & Failure Modes

### Stale Lock Files After Restore

`start.sh` cleans X11 and code-server lock files before starting the VNC stack. Without this, services fail to start after snapshot restore.

### Snapshot Timeout

Modal's `snapshot_filesystem` has a 55-second timeout. Large filesystem states (many installed packages, large repos) may exceed this. Recognized snapshot creation failures are surfaced to SessionAgent DO as snapshot failures; the DO terminates the sandbox and records the session as `terminated` with reason `snapshot_failed`.

### Snapshot vs. Volume Boundary

The snapshot captures everything *except* mounted volumes. The `/workspace` directory is a volume mount, so repo contents persist independently of snapshots. Everything else (installed packages, Runner state, OpenCode cache, etc.) is captured in the snapshot.

### Image Layer Cache Invalidation

Changing a layer invalidates all subsequent layers. The `RUNNER_VERSION` echo is strategically placed before the runner copy to allow runner-only updates without rebuilding OS/tool layers. However, OS package updates require changing an earlier layer, which rebuilds everything below.

### Existing Sandboxes After Deploy

New image deploys only affect **new** sandboxes. Existing running or hibernated sandboxes continue using their original image (or snapshot). There is no mechanism to update running sandboxes in-place.

## Implementation Status

### Fully Implemented
- Single base image via Modal Python SDK with 16 build layers
- Full dev environment: Node 22, Bun, OpenCode 1.1.52, code-server, VNC, TTYD, Chromium, whisper.cpp
- 63 custom OpenCode tools + 3 skills baked into image
- Runner from local source with dependency install
- Environment variable assembly from org keys, user credentials, GitHub OAuth, custom providers
- Hibernate via `snapshot_filesystem` and restore via `Image.from_id()`
- Persistent workspace volumes per session
- Shared whisper models volume
- Two cache-bust mechanisms
- Stale lock cleanup for snapshot restore
- Manual version bumping workflow

### Not Implemented
- **Repo-specific images:** `_get_image()` always returns base image. Comment: "Future: repo-specific images."
- **`images/webapp.py` and `images/core.py`:** referenced in CLAUDE.md but do not exist.
- **Automated version bumping:** entirely manual.
- **Image build pipeline:** no CI/CD for image builds.
- **Warm sandbox pools:** no pre-warmed sandboxes.
- **Version pinning** for: Bun, code-server, apt packages, whisper.cpp.

### Known Drift
- `Dockerfile.sandbox` has diverged significantly from the Modal image (missing whisper, imagemagick, xdotool, ffmpeg, OpenCode config; uses old package name).
- `config.py` constants `BASE_IMAGE_TAG` and `BUN_VERSION` are orphaned (defined but unused).
