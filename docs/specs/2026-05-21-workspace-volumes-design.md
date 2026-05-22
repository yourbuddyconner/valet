# Workspace Volumes Design

> Pre-cached repo volumes and shared personal volumes for fast sandbox boot and cross-session state.

## Status: Draft

## Problem

Every new session does a full `git clone` at boot. For large repos this adds 30-60+ seconds to startup. The orchestrator's persistent state (dotfiles, memory, preferences) is tied to a single workspace volume that can't be shared with child sessions. There's no mechanism for the orchestrator to push configuration to children.

## Design

Replace the current single `/workspace` volume with a layered mount structure:

```
/mnt/personal/                     # Personal volume (orchestrator r/w, children r/o)
├── .gitconfig                     # Git identity
├── .valet/
│   ├── memory/                    # Orchestrator long-term memory
│   └── persona/                   # Persona context files
└── profile.d/                     # Custom shell snippets sourced on boot
    └── custom.sh

/home/user/                        # Container-local HOME (ephemeral, not a volume)
├── .bashrc                        # Baked in image, or copied from personal vol
├── .gitconfig                     # Copied from /mnt/personal on boot
├── .local/share/opencode/         # Runtime agent state — NEVER persisted to volume
│   └── auth.json                  # LLM API keys — session-local only
├── .opencode/                     # OpenCode runtime state — session-local
├── .agent-browser-profile/        # Browser profile — session-local
├── .agents/                       # Agent skills/plugins — session-local
└── .valet/                        # Symlink → /mnt/personal/.valet (orchestrator)
                                   # or copy from /mnt/personal/.valet (children)

/workspace/                        # Container-local working directory (ephemeral)
└── <repo-name>/                   # Working tree from cache clone

/repo-cache/<owner>/<repo>/        # Repo cache volume (bare clone, read-only to sessions)
```

Three volume types:

| Volume | Naming | Writer | Readers | Mount |
|--------|--------|--------|---------|-------|
| **Personal** | `personal-{userId}` | Orchestrator session | All user's sessions | `/mnt/personal` |
| **Repo cache** | `repo-cache-{orgId}-{owner}-{repo}` | Cache-warming job | All sessions using that repo | `/repo-cache/{owner}/{repo}` |
| **Whisper models** | `whisper-models` (unchanged) | Setup job | All sessions | `/models/whisper` |

### Personal Volume

The orchestrator session mounts `personal-{userId}` at `/mnt/personal` with read-write access. It owns this volume — writes git config, memory, persona context.

Child sessions mount the same volume at `/mnt/personal` with **read-only** access via Modal's `volume.with_mount_options(read_only=True)`. This prevents children from mutating orchestrator state (Modal auto-syncs volume changes on sandbox termination, so skipping `.commit()` alone is not sufficient).

On boot, `start.sh` copies select files from `/mnt/personal/` into the container-local `/home/user/`:

```bash
# Copy orchestrator-managed config into ephemeral HOME
if [ -d /mnt/personal ]; then
  cp -a /mnt/personal/.gitconfig /home/user/.gitconfig 2>/dev/null || true
  # For orchestrator: symlink .valet so writes persist to volume
  # For children: copy .valet (read-only volume can't be symlinked for writes)
  if [ "${IS_ORCHESTRATOR:-}" = "true" ]; then
    ln -sf /mnt/personal/.valet /home/user/.valet
  else
    cp -a /mnt/personal/.valet /home/user/.valet 2>/dev/null || true
  fi
  # Source custom shell snippets
  for f in /mnt/personal/profile.d/*.sh; do
    [ -f "$f" ] && . "$f"
  done
fi
```

This means:
- HOME is always writable (container-local) — code-server, OpenCode, fluxbox, etc. write freely
- Secrets (`auth.json`, API keys) stay in container-local HOME, never persist to the volume
- Orchestrator config propagates to children at boot time via the copy
- Empty personal volume on first-ever session = user gets image-baked defaults (no bootstrap needed)

**What lives on the personal volume (`/mnt/personal`):**
- Git identity (`.gitconfig` with name/email)
- Valet orchestrator state (`.valet/memory/`, `.valet/persona/`)
- Custom shell snippets (`profile.d/`)

**What does NOT live on the personal volume:**
- LLM API keys / OAuth tokens (`auth.json` stays in container-local `$HOME/.local/share/opencode/`)
- OpenCode runtime state (`.opencode/` — session-local)
- Browser profile (`.agent-browser-profile/` — session-local)
- Agent skills/plugins (`.agents/` — delivered via Runner WebSocket, session-local)
- Shell config (`.bashrc` — baked into image, session-local)
- Repo working trees (`/workspace/` — container-local)

### Repo Cache Volumes

Pre-warmed bare clones of repositories, mounted by sessions to accelerate `git clone`.

#### Cache-Warming Flow

```
┌──────────────┐     ┌──────────────────┐     ┌─────────────────┐     ┌──────────────┐
│ Session      │────▶│ warm_repo_cache() │────▶│ Repo Cache Vol  │────▶│ Sandbox      │
│ create       │     │ (blocking)        │     │ ready           │     │ mounts cache │
└──────────────┘     └──────────────────┘     └─────────────────┘     └──────────────┘
```

**Every session with a repo blocks on `warm_repo_cache()` before sandbox creation.** The warm function is idempotent — if the cache volume already exists and has a bare clone, it does a fast `git fetch` (seconds). If the volume doesn't exist, it does a full bare clone (one-time cost). Either way, the sandbox always gets a cache volume mounted.

This means one code path in the Runner: always `--dissociate --reference` from the cache. No "with cache" vs "without cache" branching.

1. **On session create**: `create_sandbox` calls `await warm_repo_cache(org_id, repo_owner, repo_name)` (blocking). Once it returns, the cache volume is guaranteed to exist and be current. Mount it and create the sandbox.
2. **Scheduled refresh**: a Modal cron function queries the worker for the list of tracked repo caches (see [Cache Tracking](#cache-tracking)) and runs `git fetch` on each. This keeps caches current between sessions so the blocking warm on session create is a no-op fetch (fast).
3. **On-demand**: orchestrator or admin triggers a cache-warm for a specific repo.

#### Concurrent Cache-Warm Protection

Two sessions creating against the same cold repo could trigger concurrent `warm_repo_cache()` calls that race on the same volume. To prevent this, the `repo_cache_volumes` table includes a `status` column and lease:

```
status: 'idle' | 'warming'
warming_lease_expires_at: ISO 8601 timestamp
```

Before starting a cache-warm, the function atomically checks-and-sets:
```sql
UPDATE repo_cache_volumes
SET status = 'warming', warming_lease_expires_at = datetime('now', '+10 minutes')
WHERE org_id = ? AND repo_owner = ? AND repo_name = ?
  AND (status = 'idle' OR warming_lease_expires_at < datetime('now'))
```

If no row is updated, another warm is in progress — the caller polls until the lease expires or status returns to `idle`, then mounts the volume. If the lease expires (warm job crashed), the next caller takes over.

#### Authenticating Cache-Warm Jobs (Private Repos)

Cache-warming runs outside any user session, so user OAuth tokens aren't available. The solution uses the org's GitHub App installation token — the same mechanism already used as a fallback for sandbox git access.

**Token flow for cache-warming:**

```
Cache-warm job
  → calls worker API: POST /api/internal/repo-cache/token
  → worker resolves org's GitHub App installation for repo owner
  → mints installation access token (1-hour lifetime)
  → returns token to cache-warm job
  → job uses token via git credential helper (never baked into remote URL)
  → token discarded after use (never stored in volume)
```

**Auth endpoint** (`POST /api/internal/repo-cache/token`):
- Authenticated via internal service token (Modal ↔ Worker shared secret). Requires adding `INTERNAL_SERVICE_SECRET` to the worker's `Env` bindings and the Modal secret.
- Request: `{ orgId, repoOwner, repoName }`
- Response: `{ token, expiresAt }`
- Uses the existing `getOrMintInstallationToken()` to get an installation-wide token. This is acceptable for cache-warming because: the token is ephemeral (used once, discarded), never persisted to the volume, and the cache-warm sandbox is trusted internal infrastructure.
- Looks up the installation via `getGithubInstallationByLogin(db, repoOwner)` using the org's D1 database (resolved from `orgId`)
- Fails cleanly if no installation covers the repo — session falls back to direct clone (see [Fallback](#fallback-no-github-app))

**Token handling in the cache sandbox — no baking into remote URLs:**

The cache-warm sandbox must NOT clone with `https://x-access-token:TOKEN@github.com/...` because git stores the remote URL in the bare repo's config, persisting the expired token. Instead:

```bash
# Set remote URL without token
REPO_URL="https://github.com/${REPO_OWNER}/${REPO_NAME}.git"

# Use git credential helper to inject token for this operation only
git -c credential.helper="!f() { echo username=x-access-token; echo password=${TOKEN}; }; f" \
    clone --bare "$REPO_URL" /cache

# For fetch on existing cache:
git -C /cache -c credential.helper="!f() { echo username=x-access-token; echo password=${TOKEN}; }; f" \
    fetch --all --prune
```

This ensures the bare repo's `origin` remote stores the token-free URL, and future fetches (by the refresh job) supply a fresh token via the credential helper.

#### <a name="fallback-no-github-app"></a>Fallback: No GitHub App Installation

If the org hasn't installed the GitHub App, the cache-warm job can't authenticate to clone private repos. In this case:
- `warm_repo_cache()` skips caching (returns without creating a volume)
- No cache volume is mounted on the sandbox
- The Runner detects no cache at `/repo-cache/...` and falls back to a direct `git clone` using the user's OAuth token (current behavior)
- Public repos can always be cached without auth regardless

This is the **only** case where the Runner has two code paths. The fallback is identical to today's behavior — no regression.

#### How Sessions Use Repo Cache

Sessions clone using `--dissociate --reference`, which copies objects from the cache into the clone's own object store:

```bash
# Cache volume mounted at /repo-cache/{owner}/{repo} (bare clone)
# Working tree at /workspace/{repo} (local filesystem)

git clone --dissociate --reference "/repo-cache/${OWNER}/${REPO}" \
  "${REPO_URL}" "/workspace/${REPO}"
```

**How this interacts with the remote:** The clone still fetches from `REPO_URL` (GitHub) — the cache is used only as a local object store to avoid re-downloading objects that already exist. Git negotiates with the remote to determine what's missing, downloads only the delta (commits since last cache refresh), and copies everything else from the cache volume. This means:
- The clone always gets the latest tip / requested ref from GitHub
- The cache being stale (up to 4 hours between refreshes) just means a slightly larger delta fetch, not missing data
- Auth for the fetch uses the user's OAuth token (delivered via `repo-config` WebSocket), same as today

After the clone, the Runner checks out the requested branch or ref:

```typescript
if (config.branch) await $`git -C ${targetDir} checkout ${config.branch}`;
if (config.ref) await $`git -C ${targetDir} checkout ${config.ref}`;
```

**Why `--dissociate`:** Without it, git creates a permanent `alternates` link from the working tree to the cache volume path. If the cache volume is not re-mounted on restore (e.g., evicted, or restore path doesn't include it), git operations (`log`, `diff`, `status`) silently fail or produce incomplete output. `--dissociate` copies referenced objects into the clone's own store, making the working tree fully self-contained after the initial clone. This is slightly slower than pure `--reference` but eliminates a class of corruption bugs.

**Edge cases:**
- **Git LFS**: LFS objects are pointer files in the git object store. The cache accelerates the pointer checkout; LFS smudge filter still fetches large files from the LFS server at clone time. No special handling needed.
- **Submodules**: not cached. `git submodule update --init` runs normally after clone, fetching from remotes. Submodule caching can be added later if needed.
- **Arbitrary SHAs**: `git clone` only fetches advertised refs. If `config.ref` is an arbitrary commit SHA not reachable from a branch/tag, the clone won't have it. The Runner already handles this by doing `git fetch origin <sha>` after clone when the checkout fails. No change needed.

Benefits:
- Working tree is on local filesystem — no volume commit/reload semantics
- Cache volume is never written to by sessions
- Working tree is fully self-contained (no alternates dependency on cache mount)
- Clone always gets the current remote state, cache just reduces transfer size
- Survives hibernation/restore via snapshot (working tree is container-local)

### Volume Versioning

Use **Modal Volumes v2** for all new volumes. Key advantages:
- No 50k file limit (v1 caps at 500k inodes, recommends <50k)
- Supports concurrent reads from hundreds of containers
- Better performance for irregular access patterns
- Large monorepos with node_modules easily exceed v1 limits

```python
vol = modal.Volume.from_name("personal-abc123", create_if_missing=True, version=2)
```

## Sandbox Creation Changes

Both `create_sandbox` and `restore_sandbox` in `sandboxes.py` must be updated — they both currently mount the workspace volume.

Current (`create_sandbox` and `restore_sandbox`):
```python
volumes = {
    "/workspace": modal.Volume.from_name(workspace_vol_name, create_if_missing=True),
    WHISPER_MODELS_MOUNT: modal.Volume.from_name(WHISPER_MODELS_VOLUME),
}
```

Proposed (both paths):
```python
personal_vol = modal.Volume.from_name(
    f"personal-{user_id}", create_if_missing=True, version=2
)

volumes = {
    # Whisper models (unchanged)
    WHISPER_MODELS_MOUNT: modal.Volume.from_name(WHISPER_MODELS_VOLUME),
}

# Personal volume — orchestrator r/w, children r/o
if is_orchestrator:
    volumes["/mnt/personal"] = personal_vol
else:
    volumes["/mnt/personal"] = personal_vol.with_mount_options(read_only=True)

# Repo cache — always present after warm_repo_cache() succeeds
if repo_cache_vol_name:
    volumes[f"/repo-cache/{repo_owner}/{repo_name}"] = modal.Volume.from_name(
        repo_cache_vol_name, version=2
    )
```

Environment variables updated:
```python
env = {
    "HOME": "/home/user",
    "IS_ORCHESTRATOR": "true" if is_orchestrator else "",
    # ... other vars
}
```

The `/home/user` and `/workspace` directories are container-local (created by `start.sh`). Not volumes.

## HOME Directory Migration

The current HOME is `/workspace` (set in `docker/start.sh` line 5 and `backend/images/base.py` env vars). Changing HOME to `/home/user` requires updating:

### `docker/start.sh`
- `export HOME=/workspace` → `export HOME=/home/user`
- Add `mkdir -p /home/user` before any `$HOME` references
- Add personal volume copy-on-start block (see [Personal Volume](#personal-volume) section)
- All existing `$HOME` references (`.bashrc`, `.fluxbox/init`, `.gitignore_global`) resolve correctly since they use `$HOME`, not hardcoded `/workspace`
- `WORK_DIR=/workspace` stays — this is the repo working directory, not HOME

### `backend/images/base.py`
- `"HOME": "/workspace"` → `"HOME": "/home/user"`
- `"PATH": "/workspace/.local/bin:..."` → `"/home/user/.local/bin:..."`
- `"AGENT_BROWSER_PROFILE": "/workspace/.agent-browser-profile"` → `"/home/user/.agent-browser-profile"`
- `"REVIEWS_SKILLS_DIR": "/workspace/.agents/skills"` → `"/home/user/.agents/skills"`

### `packages/runner/src/bin.ts`
- Line 155: `process.env.WORK_DIR || "/workspace"` — stays, WORK_DIR is the repo directory
- Line 157: `process.env.HOME || "/workspace"` → `process.env.HOME || "/home/user"`
- Line 505: `process.env.HOME || '/workspace'` → `process.env.HOME || '/home/user'` (`.opencode/` dir)
- Line 506: `process.env.HOME || '/workspace'` → `process.env.HOME || '/home/user'` (`.agents/` dir)
- Line 511: `'/workspace/.valet/persona'` → stays as `/workspace/.valet/persona` OR changes to `${HOME}/.valet/persona` — depends on whether persona context belongs with the repo or the user. Since orchestrator symlinks `.valet` from the personal volume, use `$HOME/.valet/persona`.

### `packages/runner/src/git-setup.ts`
- Line 32: `opts.workdir || "/workspace"` — stays, this is the repo clone target

### Image-baked defaults
An empty personal volume on first session means `/mnt/personal` is empty, so nothing gets copied to `/home/user`. The image must bake sensible defaults:
- `.bashrc` is already copied from `/root/.bashrc` in `start.sh` line 8 — change to copy to `/home/user/.bashrc`
- The `mkdir -p /home/user/.local/bin` in `start.sh` line 9 stays

## Migration from Current Workspace Volume

No legacy migration needed. On deploy:

1. **New sessions** use the new volume layout immediately. Personal volume starts empty (image defaults apply).
2. **Existing sessions** continue on their current workspace volume until they end naturally. No special restore path.
3. **Old workspace volumes** can be garbage-collected in bulk after a rollout period (e.g., 30 days).

## Runner Changes

### git-setup.ts

The `repo-config` WebSocket message must be extended with `repoOwner` and `repoName` fields (currently only `repoUrl` is sent, and owner/name are parsed from the URL). These fields are needed to construct the cache volume path.

```typescript
async function cloneRepo(config: RepoConfig, workdir: string) {
  const repoName = config.repoName || extractRepoName(config.repoUrl);
  const repoOwner = config.repoOwner || extractRepoOwner(config.repoUrl);
  const targetDir = path.join(workdir, repoName);
  const cacheDir = `/repo-cache/${repoOwner}/${repoName}`;

  if (await exists(targetDir + "/.git")) {
    // Restored from snapshot — just fetch latest
    await $`git -C ${targetDir} fetch origin`;
    if (config.ref) await $`git -C ${targetDir} checkout ${config.ref}`;
    return;
  }

  if (await exists(cacheDir + "/HEAD")) {
    // Cache volume mounted — reference clone (copies objects locally, no alternates dependency)
    await $`git clone --dissociate --reference ${cacheDir} ${config.repoUrl} ${targetDir}`;
  } else {
    // No cache (GitHub App not installed for this repo's org) — direct clone
    await $`git clone ${config.repoUrl} ${targetDir}`;
  }

  if (config.branch) await $`git -C ${targetDir} checkout ${config.branch}`;
  if (config.ref) await $`git -C ${targetDir} checkout ${config.ref}`;
}
```

## Cache-Warm Modal Function

The volume must be declared in the function's `volumes=` parameter — calling `Volume.from_name()` alone does not mount it. Since the volume name depends on runtime arguments, we spawn a helper sandbox that mounts the specific volume:

```python
@app.function(
    secrets=[modal.Secret.from_name("valet-internal-secret")],
    timeout=600,
)
async def warm_repo_cache(org_id: str, repo_owner: str, repo_name: str):
    """Clone or fetch a repo into its cache volume. Idempotent."""
    import os

    vol_name = f"repo-cache-{org_id}-{repo_owner}-{repo_name}"
    vol = modal.Volume.from_name(vol_name, create_if_missing=True, version=2)

    # Acquire lease via worker API (see Concurrent Cache-Warm Protection)
    worker_url = os.environ["WORKER_URL"]
    internal_secret = os.environ["INTERNAL_SERVICE_SECRET"]
    lease = await acquire_cache_lease(worker_url, internal_secret, org_id, repo_owner, repo_name)
    if not lease:
        # Another warm in progress — wait for it
        await poll_cache_ready(worker_url, internal_secret, org_id, repo_owner, repo_name)
        return

    try:
        # Mint installation token for this repo's org
        token = await mint_cache_token(worker_url, internal_secret, org_id, repo_owner, repo_name)

        # Spawn helper sandbox with the volume mounted
        sandbox = modal.Sandbox.create(
            "bash", "-c", _build_cache_script(repo_owner, repo_name),
            image=modal.Image.debian_slim().apt_install("git"),
            volumes={"/cache": vol},
            environment={"TOKEN": token},
            timeout=600,
        )
        sandbox.wait()

        if sandbox.returncode != 0:
            stderr = sandbox.stderr.read()
            raise RuntimeError(f"Cache-warm failed for {repo_owner}/{repo_name}: {stderr}")

    finally:
        # Release lease
        await release_cache_lease(worker_url, internal_secret, org_id, repo_owner, repo_name)


def _build_cache_script(repo_owner: str, repo_name: str) -> str:
    """Shell script for the cache sandbox. Token passed via env, never in remote URL."""
    return f"""
set -e
REPO_URL="https://github.com/{repo_owner}/{repo_name}.git"
CRED_HELPER='!f() {{ echo username=x-access-token; echo "password=$TOKEN"; }}; f'

if [ -f "/cache/HEAD" ]; then
    # Existing cache — fetch latest
    git -C /cache -c "credential.helper=$CRED_HELPER" fetch --all --prune
else
    # Fresh cache — bare clone with token-free remote URL
    git -c "credential.helper=$CRED_HELPER" clone --bare "$REPO_URL" /cache
fi

# v2 volumes: explicit sync to persist
sync /cache
"""
```

## <a name="cache-tracking"></a>Cache Tracking

Repo cache metadata is tracked in D1 so the refresh job can enumerate caches and eviction can be time-based.

### Schema

```sql
CREATE TABLE repo_cache_volumes (
    id TEXT PRIMARY KEY DEFAULT (lower(hex(randomblob(16)))),
    org_id TEXT NOT NULL REFERENCES org_settings(id),
    repo_owner TEXT NOT NULL,
    repo_name TEXT NOT NULL,
    repo_full_name TEXT NOT NULL,      -- '{owner}/{name}' for display
    volume_name TEXT NOT NULL,          -- Modal volume name
    status TEXT NOT NULL DEFAULT 'idle', -- 'idle' | 'warming'
    warming_lease_expires_at TEXT,      -- ISO 8601, null when idle
    last_warmed_at TEXT,               -- ISO 8601, last successful cache-warm
    last_accessed_at TEXT,             -- ISO 8601, last session mount
    last_error TEXT,                   -- Last warming error message, null on success
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(org_id, repo_owner, repo_name)
);

CREATE INDEX idx_repo_cache_last_accessed ON repo_cache_volumes(last_accessed_at);
CREATE INDEX idx_repo_cache_status ON repo_cache_volumes(status, warming_lease_expires_at);
```

**Field usage:**
- **`status` + `warming_lease_expires_at`**: used by the concurrent-warm lease mechanism. Lease auto-expires after 10 minutes if the warm job crashes.
- **`last_warmed_at`**: updated after successful clone/fetch.
- **`last_accessed_at`**: updated by `create_sandbox` / `restore_sandbox` when the cache volume is mounted. Used for eviction (30-day threshold).
- **`last_error`**: stores the last warming failure message for debugging. Cleared on next success.

### Worker API Endpoints

```
POST /api/internal/repo-cache/token    — mint installation token for cache-warm
POST /api/internal/repo-cache/lease    — acquire/release warming lease
GET  /api/internal/repo-cache/list     — list active caches for refresh job
GET  /api/internal/repo-cache/status   — check if a specific cache is ready
```

All authenticated via `INTERNAL_SERVICE_SECRET` header.

## Scheduled Cache Refresh

```python
@app.function(schedule=modal.Cron("0 */4 * * *"))  # every 4 hours
async def refresh_repo_caches():
    """Fetch latest for all cached repos."""
    import os
    worker_url = os.environ["WORKER_URL"]
    internal_secret = os.environ["INTERNAL_SERVICE_SECRET"]

    caches = await fetch_active_caches(worker_url, internal_secret)
    for cache in caches:
        # Spawn each warm as a separate function call (parallel, non-blocking)
        warm_repo_cache.spawn(cache["org_id"], cache["repo_owner"], cache["repo_name"])
```

## Cache Eviction

```python
@app.function(schedule=modal.Cron("0 3 * * *"))  # daily at 3am
async def evict_stale_caches():
    """Delete repo cache volumes not accessed in 30 days."""
    import os
    worker_url = os.environ["WORKER_URL"]
    internal_secret = os.environ["INTERNAL_SERVICE_SECRET"]

    stale = await fetch_stale_caches(worker_url, internal_secret, days=30)
    for cache in stale:
        try:
            vol = modal.Volume.from_name(cache["volume_name"])
            vol.delete()
        except modal.exception.NotFoundError:
            pass  # Already gone
        await delete_cache_record(worker_url, internal_secret, cache["id"])
```

## Decisions

1. **Cache eviction** — evict by last-access time. Track `last_accessed_at` in `repo_cache_volumes` table, updated on each session mount. Evict volumes not accessed in 30 days.
2. **Multi-provider** — GitHub only. GitLab/Bitbucket repos fall back to direct clone. Revisit if needed.
3. **Monorepo sparse checkout** — not needed yet. Full bare clone for all repos. Revisit if specific repos cause problems.
4. **Personal volume bootstrap** — no bootstrap step. Image bakes defaults into `/home/user`; personal volume contents are copied on top at boot. Empty personal volume = image defaults.
5. **Volume count scaling** — not a concern at current scale. One volume per org×repo is fine.
6. **Installation token scope** — use installation-wide tokens (not repo-scoped) for cache-warming. The token is ephemeral, never persisted, and the cache sandbox is trusted internal infra. Avoids needing a new code path in `github-app.ts`.

## Not Covered

- Changes to the hibernation/snapshot flow (orthogonal — snapshots capture container filesystem, not volumes)
- VNC/terminal/code-server configuration (unchanged)
- Plugin content delivery (unchanged — still via Runner WebSocket)
- LLM provider key management (unchanged — still via env vars)
- Git LFS large file caching (LFS smudge filter fetches from LFS server regardless)
- Submodule caching (submodules fetch from remotes, not cached)
