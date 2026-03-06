# Unified Plugin System Design

> **Status:** Implemented. See commits on `main` branch. Directory structure uses `packages/plugin-*/` (not `plugins/` as originally planned).

> Replaces the fragmented `packages/actions-*`, `packages/channel-*`, `docker/opencode/skills/`, and `docker/opencode/plugins/` with a single plugin abstraction.

## Problem

Today, extending Valet requires understanding four different extension mechanisms:

- **Actions** (`packages/actions-*/`) — TypeScript packages implementing `@valet/sdk/integrations`
- **Channels** (`packages/channel-*/`) — TypeScript packages implementing `@valet/sdk/channels`
- **Skills** (`docker/opencode/skills/`) — Markdown files baked into the Docker image
- **Plugins** (`docker/opencode/plugins/`) — TypeScript files baked into the Docker image
- **Personas** (`agent_personas` + `agent_persona_files` in D1) — Markdown files stored in DB

Each has its own discovery mechanism, directory convention, SDK contract, and delivery path. Skills and plugins are static (image-baked) while personas are dynamic (DB-backed). There's no way for an org to install third-party capabilities, and repos can't ship agent skills alongside their code.

## Design

### Plugin Package Format

A **plugin** is a directory with a `plugin.yaml` manifest and optional capability directories:

```
my-plugin/
  plugin.yaml          # Required — metadata
  skills/              # Optional — *.md files (OpenCode skills)
  personas/            # Optional — *.md files (persona fragments)
  tools/               # Optional — *.json (OpenCode tool definitions)
  actions/             # Optional — TypeScript action package
    index.ts
    provider.ts
    actions.ts
    triggers.ts
  channels/            # Optional — TypeScript channel transport
    index.ts
    transport.ts
  sandbox/             # Optional — Dockerfile.layer for image build
    Dockerfile.layer
  package.json         # Required if actions/ or channels/ present
```

#### `plugin.yaml`

```yaml
name: kubernetes
version: 1.0.0
description: Kubernetes cluster management for Valet agents
icon: ☸️
author: acme-corp

# Optional — override auto-detected entry points
capabilities:
  actions:
    entry: actions/index.ts
  channels:
    entry: channels/index.ts
```

Capabilities are auto-detected from directory structure. The manifest provides metadata; entry point overrides are optional.

#### Auto-detection rules

| Directory exists | Capability registered |
|---|---|
| `skills/*.md` | Each `.md` -> OpenCode skill |
| `personas/*.md` | Each `.md` -> persona file injected at boot |
| `tools/*.json` | Each `.json` -> OpenCode custom tool definition |
| `actions/index.ts` | Action package (provider + actions + triggers) |
| `channels/index.ts` | Channel transport |
| `sandbox/Dockerfile.layer` | Docker layer added to sandbox image at build time |

A plugin with only `plugin.yaml` + `skills/debugging.md` is valid. No code required.

### Capability Categories

| Category | Capabilities | Where it runs | When it takes effect | Needs rebuild? |
|---|---|---|---|---|
| **Content** | skills, personas, tools | Sandbox filesystem | Next session boot | No |
| **Code** | actions, channels | Worker (compiled in) | Next deploy | Yes |
| **Image** | sandbox layers | Docker image | Next image build | Yes |

Content plugins are dynamic — artifacts stored in D1, injected at session boot. Code plugins are static — compiled into the worker via registry generation, same as today.

### Plugin Sources

#### Source 1: Platform plugins (`packages/plugin-*/` in the monorepo)

```
packages/
  plugin-github/           # was packages/actions-github
  plugin-slack/            # was packages/actions-slack + packages/channel-slack
  plugin-telegram/         # was packages/channel-telegram
  plugin-kubernetes/       # new — skills + tools
  plugin-browser/          # was docker/opencode/skills/browser
  ...
```

Full plugin packages with `plugin.yaml`. Can contain any capability type. Forks add plugins by putting new directories here and adding npm dependencies as needed. Each is an npm workspace package (`@valet/plugin-*`).

#### Source 2: Per-repo content (`.valet/` in any cloned repo)

```
.valet/
  personas/        # *.md -> layered on top of org persona
  skills/          # *.md -> registered as OpenCode skills for this session
  tools/           # *.json -> registered as OpenCode tools for this session
```

No `plugin.yaml` needed. Content only — no actions, channels, or sandbox layers. Detected by the Runner at boot from the cloned repo. This is a repo saying "when an agent works on this codebase, give it these skills and context."

Repo content can be disabled per org for security (see Org Plugin Settings below).

> **TODO:** Expand `allowRepoContent` to per-repo granularity.

### Data Model

#### `org_plugins` table

Tracks installed plugins per org.

| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | text PK | | UUID |
| `orgId` | text NOT NULL | `'default'` | Org scope |
| `name` | text NOT NULL | | Plugin name from `plugin.yaml` |
| `version` | text NOT NULL | | Semver or git SHA |
| `description` | text | | From manifest |
| `icon` | text | | From manifest |
| `source` | text NOT NULL | | `'builtin'` (platform plugins) |
| `capabilities` | text NOT NULL | | JSON array: `["skills","actions","sandbox"]` |
| `status` | text NOT NULL | `'active'` | `'active'`, `'disabled'` |
| `installedBy` | text NOT NULL | | User who installed / `'system'` for sync |
| `installedAt` | text | `datetime('now')` | |
| `updatedAt` | text | `datetime('now')` | |

**Unique index:** `(orgId, name)`

#### `org_plugin_artifacts` table

Stores resolved content so the DO doesn't need filesystem access.

| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | text PK | | UUID |
| `pluginId` | text NOT NULL | | FK to `org_plugins` |
| `type` | text NOT NULL | | `'skill'`, `'persona'`, `'tool'` |
| `filename` | text NOT NULL | | Relative path (e.g. `skills/debugging.md`) |
| `content` | text NOT NULL | | File content |
| `sortOrder` | integer | `0` | For persona ordering |

**Unique index:** `(pluginId, type, filename)`

#### `org_plugin_settings` table

| Column | Type | Default | Notes |
|---|---|---|---|
| `id` | text PK | | UUID |
| `orgId` | text NOT NULL | | Unique per org |
| `allowRepoContent` | boolean NOT NULL | `true` | Whether `.valet/` from repos is injected |

### API

| Method | Path | Description |
|---|---|---|
| GET | `/api/plugins` | List active plugins for org |
| GET | `/api/plugins/:id` | Plugin detail with artifacts |
| POST | `/api/plugins/sync` | Trigger sync from compiled registry to D1 (admin) |
| PUT | `/api/plugins/:id` | Update plugin status — enable/disable (admin) |
| GET | `/api/plugins/settings` | Get org plugin settings |
| PUT | `/api/plugins/settings` | Update org plugin settings (admin) |

### Sync Mechanism

Content plugins are synced to D1 via two paths:

1. **Worker cold start** — on first request, the worker reads the compiled plugin registry and upserts `org_plugins` + `org_plugin_artifacts`. Automatic, no manual step needed.
2. **Manual** — `POST /api/plugins/sync` for debugging or forced re-sync.

Code capabilities (actions/channels) are not stored in D1 — they're compiled into the worker.

### Session Boot: Content Delivery via Runner

Content flows from D1 to sandbox via the Runner's existing WebSocket connection to the DO:

1. **DO assembles content** — queries `org_plugin_artifacts` for active org plugins, plus `agent_persona_files` for the selected persona.
2. **DO sends to Runner** — plugin content payload included in session config over WebSocket.
3. **Runner writes files** — before starting OpenCode:
   - Personas -> `/root/.opencode/personas/`
   - Skills -> `/root/.opencode/skills/`
   - Tools/plugins -> `/root/.opencode/plugins/valet/`
4. **Runner scans repo** — if `allowRepoContent` is enabled, reads `.valet/personas/`, `.valet/skills/`, `.valet/tools/` from the cloned repo and merges on top (repo content overrides org content for same-named files).
5. **Runner starts OpenCode**.

`PERSONA_FILES_JSON` env var and the `start.sh` persona injection block are removed. Content is now delivered via the Runner WebSocket `plugin-content` message.

#### Assembly pseudocode

```typescript
async function assemblePluginContent(db: D1Database, orgId: string, personaId?: string) {
  const artifacts = await getActivePluginArtifacts(db, orgId);
  const personaFiles = personaId
    ? await getPersonaFiles(db, personaId)
    : [];

  return {
    personas: [
      ...artifacts.filter(a => a.type === 'persona'),
      ...personaFiles,
    ],
    skills: artifacts.filter(a => a.type === 'skill'),
    tools: artifacts.filter(a => a.type === 'tool'),
    allowRepoContent: (await getPluginSettings(db, orgId)).allowRepoContent,
  };
}
```

### SDK Changes

Existing contracts (`PluginProvider`, `ChannelTransport`) stay the same. They're re-exported from a new unified entrypoint:

```typescript
// @valet/sdk/plugins
export { type PluginProvider } from './integrations';
export { type ChannelTransport } from './channels';
export { type PluginManifest } from './manifest'; // parsed plugin.yaml type
```

### Registry Generation

`make generate-registries` is updated to scan `packages/plugin-*/` instead of `packages/actions-*/` and `packages/channel-*/`. It checks for `actions/index.ts` and `channels/index.ts` to determine what to register. Output format unchanged — worker import maps.

## Migration Path

### Phase 1: Restructure directories

Move existing packages into `packages/plugin-*/`:

| From | To |
|---|---|
| `packages/actions-github/src/*` | `packages/plugin-github/actions/*` |
| `packages/actions-slack/src/*` | `packages/plugin-slack/actions/*` |
| `packages/channel-slack/src/*` | `packages/plugin-slack/channels/*` |
| `packages/channel-telegram/src/*` | `packages/plugin-telegram/channels/*` |
| `packages/actions-gmail/src/*` | `packages/plugin-gmail/actions/*` |
| `packages/actions-google-calendar/src/*` | `packages/plugin-google-calendar/actions/*` |
| `packages/actions-linear/src/*` | `packages/plugin-linear/actions/*` |
| `packages/actions-notion/src/*` | `packages/plugin-notion/actions/*` |
| `packages/actions-stripe/src/*` | `packages/plugin-stripe/actions/*` |
| `packages/actions-cloudflare/src/*` | `packages/plugin-cloudflare/actions/*` |
| `packages/actions-sentry/src/*` | `packages/plugin-sentry/actions/*` |
| `packages/actions-deepwiki/src/*` | `packages/plugin-deepwiki/actions/*` |
| `docker/opencode/skills/browser/` | `packages/plugin-browser/skills/` |
| `docker/opencode/skills/workflows/` | `packages/plugin-workflows/skills/` |
| `docker/opencode/skills/sandbox-tunnels/` | `packages/plugin-sandbox-tunnels/skills/` |

Add `plugin.yaml` to each. Update `make generate-registries` to scan `packages/plugin-*/`.

### Phase 2: Content delivery via Runner

- Add `org_plugins`, `org_plugin_artifacts`, `org_plugin_settings` tables (D1 migration)
- Add sync-on-startup to worker
- Update DO to assemble plugin content and send via WebSocket
- Update Runner to receive content, write files, scan `.valet/` from repo
- Remove `PERSONA_FILES_JSON` env var and `start.sh` persona injection block
- Remove skills/tools from Docker image (they come from D1 now)

### Phase 3: Cleanup

- Delete old `packages/actions-*` and `packages/channel-*` directories (now under `packages/plugin-*/actions` and `packages/plugin-*/channels`)
- Delete `packages/sdk/src/integrations/` and `packages/sdk/src/channels/` (re-export from `@valet/sdk/plugins`)
- Update `docker/opencode/opencode.json` path globs
- Update all docs/specs

### What doesn't change

- `@valet/sdk` contracts (PluginProvider, ChannelTransport) — same interfaces, new home
- `packages/shared`, `packages/client`, `packages/worker`, `packages/runner` — still separate workspace packages
- Session persona selection UI — still picks from `agent_personas`, coexists with plugin-provided personas
- Sandbox image build — still Modal-based, but now includes `sandbox/Dockerfile.layer` from plugins
