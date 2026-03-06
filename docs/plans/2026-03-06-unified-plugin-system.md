# Unified Plugin System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the fragmented `packages/actions-*`, `packages/channel-*`, `docker/opencode/skills/`, and `docker/opencode/plugins/` with a unified `plugins/` directory, backed by a D1 registry that delivers content plugins (skills, personas, tools) to sandboxes via the Runner WebSocket.

**Architecture:** Platform plugins live in `plugins/<name>/` with a `plugin.yaml` manifest. Code plugins (actions/channels) stay compiled into the worker via registry generation. Content plugins (skills/personas/tools) are synced to D1 at worker startup and delivered to the Runner over WebSocket at session boot. Per-repo content (`.valet/skills/`, `.valet/personas/`, `.valet/tools/`) is scanned by the Runner at boot, gated by an org setting.

**Tech Stack:** TypeScript, Drizzle ORM, D1 (SQLite), Hono, Bun, Cloudflare Workers

**Design doc:** `docs/plans/2026-03-05-unified-plugin-system-design.md`

---

## Phase 1: Plugin Directory Structure & Registry Generation

Restructure existing packages into `plugins/` and update the registry generation script to scan the new location. No behavior change — just file moves and build system updates.

---

### Task 1: Create plugin directory structure for action packages

Move all 12 action packages from `packages/actions-*/` to `plugins/*/actions/`. Each plugin gets a `plugin.yaml` manifest.

**Files:**
- Create: `plugins/github/plugin.yaml`, `plugins/github/actions/` (move from `packages/actions-github/src/`)
- Create: `plugins/slack/plugin.yaml`, `plugins/slack/actions/` (move from `packages/actions-slack/src/`)
- Create: `plugins/gmail/plugin.yaml`, `plugins/gmail/actions/` (move from `packages/actions-gmail/src/`)
- Create: `plugins/google-calendar/plugin.yaml`, `plugins/google-calendar/actions/` (move from `packages/actions-google-calendar/src/`)
- Create: `plugins/google-drive/plugin.yaml`, `plugins/google-drive/actions/` (move from `packages/actions-google-drive/src/`)
- Create: `plugins/google-sheets/plugin.yaml`, `plugins/google-sheets/actions/` (move from `packages/actions-google-sheets/src/`)
- Create: `plugins/linear/plugin.yaml`, `plugins/linear/actions/` (move from `packages/actions-linear/src/`)
- Create: `plugins/notion/plugin.yaml`, `plugins/notion/actions/` (move from `packages/actions-notion/src/`)
- Create: `plugins/stripe/plugin.yaml`, `plugins/stripe/actions/` (move from `packages/actions-stripe/src/`)
- Create: `plugins/cloudflare/plugin.yaml`, `plugins/cloudflare/actions/` (move from `packages/actions-cloudflare/src/`)
- Create: `plugins/sentry/plugin.yaml`, `plugins/sentry/actions/` (move from `packages/actions-sentry/src/`)
- Create: `plugins/deepwiki/plugin.yaml`, `plugins/deepwiki/actions/` (move from `packages/actions-deepwiki/src/`)
- Create: Each plugin gets its own `package.json` and `tsconfig.json`

**Step 1: Create the plugins directory and one example plugin (github)**

Create `plugins/github/plugin.yaml`:
```yaml
name: github
version: 0.0.1
description: GitHub integration — repos, issues, PRs, commits, webhooks
icon: 🐙
```

Create `plugins/github/package.json`:
```json
{
  "name": "@valet/plugin-github",
  "version": "0.0.1",
  "type": "module",
  "exports": {
    ".": "./src/actions/index.ts"
  },
  "dependencies": {
    "@valet/sdk": "workspace:*",
    "@valet/shared": "workspace:*",
    "zod": "^3.22.4"
  }
}
```

Create `plugins/github/tsconfig.json` (same pattern as existing action packages).

Move `packages/actions-github/src/*.ts` → `plugins/github/src/actions/*.ts`. Preserve all file contents exactly.

**Step 2: Repeat for remaining 11 action packages**

Follow the same pattern. For each `packages/actions-{name}/`:
1. Create `plugins/{name}/plugin.yaml` with appropriate name, description, icon
2. Create `plugins/{name}/package.json` as `@valet/plugin-{name}`
3. Move `packages/actions-{name}/src/*.ts` → `plugins/{name}/src/actions/*.ts`
4. Adjust import paths if needed (relative imports should stay the same since directory structure is preserved)

Service key mapping (important — these must match the `provider.service` string in each provider.ts):
- `actions-google-calendar` → `plugins/google-calendar` (service: `google_calendar`)
- `actions-google-drive` → `plugins/google-drive` (service: `google_drive`)
- `actions-google-sheets` → `plugins/google-sheets` (service: `google_sheets`)
- All others: package suffix matches service key

**Step 3: Verify TypeScript compiles**

Run: `pnpm typecheck`
Expected: All plugins compile (imports from `@valet/sdk` and `@valet/shared` resolve via workspace protocol)

**Step 4: Commit**

```bash
git add plugins/
git commit -m "refactor: move action packages to plugins/ directory"
```

---

### Task 2: Merge channel packages into existing plugins

Slack has both actions and a channel. Telegram is channel-only.

**Files:**
- Move: `packages/channel-slack/src/*.ts` → `plugins/slack/src/channels/*.ts`
- Create: `plugins/telegram/plugin.yaml`, move `packages/channel-telegram/src/*.ts` → `plugins/telegram/src/channels/*.ts`
- Modify: `plugins/slack/package.json` — add channel test dependencies if any

**Step 1: Move Slack channel into the slack plugin**

Move `packages/channel-slack/src/transport.ts` → `plugins/slack/src/channels/transport.ts`
Move `packages/channel-slack/src/provider.ts` → `plugins/slack/src/channels/provider.ts`
Move `packages/channel-slack/src/format.ts` → `plugins/slack/src/channels/format.ts`
Move `packages/channel-slack/src/verify.ts` → `plugins/slack/src/channels/verify.ts`
Move `packages/channel-slack/src/index.ts` → `plugins/slack/src/channels/index.ts`
Move test files alongside their source files.

Update `plugins/slack/plugin.yaml`:
```yaml
name: slack
version: 0.0.1
description: Slack integration — messaging, channels, and bot transport
icon: 💬
```

Update `plugins/slack/package.json` exports:
```json
{
  "exports": {
    "./actions": "./src/actions/index.ts",
    "./channels": "./src/channels/index.ts"
  }
}
```

**Step 2: Create telegram plugin**

Create `plugins/telegram/plugin.yaml`:
```yaml
name: telegram
version: 0.0.1
description: Telegram bot messaging and transport
icon: 📱
```

Create `plugins/telegram/package.json`:
```json
{
  "name": "@valet/plugin-telegram",
  "version": "0.0.1",
  "type": "module",
  "exports": {
    "./channels": "./src/channels/index.ts"
  },
  "dependencies": {
    "@valet/sdk": "workspace:*"
  }
}
```

Move `packages/channel-telegram/src/*.ts` → `plugins/telegram/src/channels/*.ts`

**Step 3: Verify TypeScript compiles**

Run: `pnpm typecheck`

**Step 4: Commit**

```bash
git add plugins/slack/src/channels/ plugins/telegram/
git commit -m "refactor: move channel packages into plugins/ directory"
```

---

### Task 3: Move skills and OpenCode plugins into plugin directories

**Files:**
- Create: `plugins/browser/plugin.yaml`, move `docker/opencode/skills/browser/SKILL.md` → `plugins/browser/skills/browser.md`
- Create: `plugins/workflows/plugin.yaml`, move `docker/opencode/skills/workflows/SKILL.md` → `plugins/workflows/skills/workflows.md`
- Create: `plugins/sandbox-tunnels/plugin.yaml`, move `docker/opencode/skills/sandbox-tunnels/SKILL.md` → `plugins/sandbox-tunnels/skills/sandbox-tunnels.md`
- Create: `plugins/memory-compaction/plugin.yaml`, move `docker/opencode/plugins/memory-compaction.ts` → `plugins/memory-compaction/tools/memory-compaction.ts`

**Step 1: Create content-only plugins**

For each skill, create a plugin directory with `plugin.yaml` and a `skills/` subdirectory.

`plugins/browser/plugin.yaml`:
```yaml
name: browser
version: 0.0.1
description: Browser control via agent-browser CLI
icon: 🌐
```

`plugins/workflows/plugin.yaml`:
```yaml
name: workflows
version: 0.0.1
description: Workflow lifecycle and operations
icon: 🔄
```

`plugins/sandbox-tunnels/plugin.yaml`:
```yaml
name: sandbox-tunnels
version: 0.0.1
description: Sandbox tunnel management
icon: 🔗
```

`plugins/memory-compaction/plugin.yaml`:
```yaml
name: memory-compaction
version: 0.0.1
description: Memory compaction plugin for OpenCode
icon: 🧠
```

Move the actual content files into the plugin structure.

**Step 2: Commit**

```bash
git add plugins/browser/ plugins/workflows/ plugins/sandbox-tunnels/ plugins/memory-compaction/
git commit -m "refactor: move skills and OpenCode plugins into plugins/ directory"
```

---

### Task 4: Update registry generation script

Update `packages/worker/scripts/generate-plugin-registry.ts` to scan `plugins/*/` instead of reading `package.json` dependencies.

**Files:**
- Modify: `packages/worker/scripts/generate-plugin-registry.ts`
- Modify: `packages/worker/package.json` — update dependencies from `@valet/actions-*` / `@valet/channel-*` to `@valet/plugin-*`

**Step 1: Rewrite the registry generation script**

The script should:
1. Scan `plugins/*/` directories at the monorepo root
2. For each plugin, check if `src/actions/index.ts` exists → add to integrations registry
3. For each plugin, check if `src/channels/index.ts` exists → add to channels registry
4. Read `plugin.yaml` or `package.json` for the package name
5. Generate the same output format as today

```typescript
// packages/worker/scripts/generate-plugin-registry.ts
import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const workerRoot = resolve(__dirname, '..');
const monorepoRoot = resolve(workerRoot, '../..');
const pluginsDir = resolve(monorepoRoot, 'plugins');

const HEADER = '// AUTO-GENERATED by scripts/generate-plugin-registry.ts — do not edit\n';

const pluginDirs = readdirSync(pluginsDir, { withFileTypes: true })
  .filter(d => d.isDirectory())
  .map(d => d.name)
  .sort();

const actionPlugins: { name: string; pkgName: string }[] = [];
const channelPlugins: { name: string; pkgName: string }[] = [];

for (const dir of pluginDirs) {
  const pluginPath = resolve(pluginsDir, dir);
  const pkgJsonPath = resolve(pluginPath, 'package.json');
  if (!existsSync(pkgJsonPath)) continue;

  const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf-8'));
  const pkgName = pkg.name as string;

  if (existsSync(resolve(pluginPath, 'src/actions/index.ts'))) {
    actionPlugins.push({ name: dir, pkgName });
  }
  if (existsSync(resolve(pluginPath, 'src/channels/index.ts'))) {
    channelPlugins.push({ name: dir, pkgName });
  }
}

// Integration packages
const intLines = [
  HEADER,
  "import type { IntegrationPackage } from '@valet/sdk';",
  ...actionPlugins.map((p, i) => `import pkg${i} from '${p.pkgName}/actions';`),
  '',
  `export const installedIntegrations: IntegrationPackage[] = [${actionPlugins.map((_, i) => `pkg${i}`).join(', ')}];`,
  '',
];
writeFileSync(resolve(workerRoot, 'src/integrations/packages.ts'), intLines.join('\n'));

// Channel packages
const chLines = [
  HEADER,
  "import type { ChannelPackage } from '@valet/sdk';",
  ...channelPlugins.map((p, i) => `import pkg${i} from '${p.pkgName}/channels';`),
  '',
  `export const installedChannels: ChannelPackage[] = [${channelPlugins.map((_, i) => `pkg${i}`).join(', ')}];`,
  '',
];
writeFileSync(resolve(workerRoot, 'src/channels/packages.ts'), chLines.join('\n'));

console.log(`Generated plugin registries: ${actionPlugins.length} integration(s), ${channelPlugins.length} channel(s)`);
```

**Step 2: Update worker package.json dependencies**

Replace all `@valet/actions-*` and `@valet/channel-*` deps with `@valet/plugin-*`:
```json
{
  "dependencies": {
    "@valet/plugin-github": "workspace:*",
    "@valet/plugin-slack": "workspace:*",
    "@valet/plugin-gmail": "workspace:*",
    "@valet/plugin-google-calendar": "workspace:*",
    "@valet/plugin-google-drive": "workspace:*",
    "@valet/plugin-google-sheets": "workspace:*",
    "@valet/plugin-linear": "workspace:*",
    "@valet/plugin-notion": "workspace:*",
    "@valet/plugin-stripe": "workspace:*",
    "@valet/plugin-cloudflare": "workspace:*",
    "@valet/plugin-sentry": "workspace:*",
    "@valet/plugin-deepwiki": "workspace:*",
    "@valet/plugin-telegram": "workspace:*"
  }
}
```

**Step 3: Update pnpm-workspace.yaml**

Add `plugins/*` to the workspace packages list.

**Step 4: Run registry generation and verify**

Run: `make generate-registries`
Run: `pnpm typecheck`
Expected: Generated registries import from `@valet/plugin-*/actions` and `@valet/plugin-*/channels`. Worker compiles.

**Step 5: Commit**

```bash
git add packages/worker/scripts/ packages/worker/package.json packages/worker/src/integrations/packages.ts packages/worker/src/channels/packages.ts pnpm-workspace.yaml
git commit -m "refactor: update registry generation to scan plugins/ directory"
```

---

### Task 5: Remove old package directories

**Files:**
- Delete: `packages/actions-github/`, `packages/actions-slack/`, `packages/actions-gmail/`, `packages/actions-google-calendar/`, `packages/actions-google-drive/`, `packages/actions-google-sheets/`, `packages/actions-linear/`, `packages/actions-notion/`, `packages/actions-stripe/`, `packages/actions-cloudflare/`, `packages/actions-sentry/`, `packages/actions-deepwiki/`
- Delete: `packages/channel-slack/`, `packages/channel-telegram/`
- Delete: `docker/opencode/skills/`, `docker/opencode/plugins/`

**Step 1: Delete old directories**

```bash
rm -rf packages/actions-* packages/channel-*
rm -rf docker/opencode/skills docker/opencode/plugins
```

**Step 2: Update pnpm-workspace.yaml — remove old patterns**

Remove `packages/actions-*` and `packages/channel-*` from workspace patterns.

**Step 3: Run pnpm install to update lockfile**

Run: `pnpm install`

**Step 4: Full build verification**

Run: `pnpm typecheck`
Run: `make generate-registries`

**Step 5: Commit**

```bash
git add -A
git commit -m "refactor: remove old action/channel/skill package directories"
```

---

## Phase 2: D1 Plugin Registry

Add database tables to track installed plugins and their content artifacts. Add sync-on-startup to populate the registry from the compiled plugin set.

---

### Task 6: Add D1 migration for plugin tables

**Files:**
- Create: `packages/worker/migrations/0059_plugin_registry.sql`

**Step 1: Write the migration**

```sql
-- Plugin registry: tracks installed plugins per org
CREATE TABLE org_plugins (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'default',
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  description TEXT,
  icon TEXT,
  source TEXT NOT NULL DEFAULT 'builtin',
  capabilities TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL DEFAULT 'active',
  installed_by TEXT NOT NULL DEFAULT 'system',
  installed_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_org_plugins_name ON org_plugins(org_id, name);

-- Content artifacts extracted from plugins (skills, personas, tools)
CREATE TABLE org_plugin_artifacts (
  id TEXT PRIMARY KEY,
  plugin_id TEXT NOT NULL REFERENCES org_plugins(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  filename TEXT NOT NULL,
  content TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0
);

CREATE UNIQUE INDEX idx_plugin_artifacts_file ON org_plugin_artifacts(plugin_id, type, filename);
CREATE INDEX idx_plugin_artifacts_plugin ON org_plugin_artifacts(plugin_id);

-- Org-level plugin settings
CREATE TABLE org_plugin_settings (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  allow_repo_content INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX idx_org_plugin_settings_org ON org_plugin_settings(org_id);
```

**Step 2: Commit**

```bash
git add packages/worker/migrations/0059_plugin_registry.sql
git commit -m "feat: add D1 migration for plugin registry tables"
```

---

### Task 7: Add Drizzle schema for plugin tables

**Files:**
- Create: `packages/worker/src/lib/schema/plugins.ts`
- Modify: `packages/worker/src/lib/schema/index.ts` — add export

**Step 1: Write the Drizzle schema**

```typescript
// packages/worker/src/lib/schema/plugins.ts
import { sqliteTable, text, integer, index, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const orgPlugins = sqliteTable('org_plugins', {
  id: text().primaryKey(),
  orgId: text().notNull().default('default'),
  name: text().notNull(),
  version: text().notNull(),
  description: text(),
  icon: text(),
  source: text().notNull().default('builtin'),
  capabilities: text({ mode: 'json' }).notNull().$type<string[]>().default([]),
  status: text().notNull().default('active'),
  installedBy: text().notNull().default('system'),
  installedAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_org_plugins_name').on(table.orgId, table.name),
]);

export const orgPluginArtifacts = sqliteTable('org_plugin_artifacts', {
  id: text().primaryKey(),
  pluginId: text().notNull(),
  type: text().notNull(),
  filename: text().notNull(),
  content: text().notNull(),
  sortOrder: integer().notNull().default(0),
}, (table) => [
  uniqueIndex('idx_plugin_artifacts_file').on(table.pluginId, table.type, table.filename),
  index('idx_plugin_artifacts_plugin').on(table.pluginId),
]);

export const orgPluginSettings = sqliteTable('org_plugin_settings', {
  id: text().primaryKey(),
  orgId: text().notNull(),
  allowRepoContent: integer({ mode: 'boolean' }).notNull().default(true),
  createdAt: text().notNull().default(sql`(datetime('now'))`),
  updatedAt: text().notNull().default(sql`(datetime('now'))`),
}, (table) => [
  uniqueIndex('idx_org_plugin_settings_org').on(table.orgId),
]);
```

**Step 2: Export from schema index**

Add to `packages/worker/src/lib/schema/index.ts`:
```typescript
export * from './plugins.js';
```

**Step 3: Verify**

Run: `cd packages/worker && pnpm typecheck`

**Step 4: Commit**

```bash
git add packages/worker/src/lib/schema/plugins.ts packages/worker/src/lib/schema/index.ts
git commit -m "feat: add Drizzle schema for plugin registry"
```

---

### Task 8: Add DB helper functions for plugins

**Files:**
- Create: `packages/worker/src/lib/db/plugins.ts`
- Modify: `packages/worker/src/lib/db.ts` — add export

**Step 1: Write DB helpers**

```typescript
// packages/worker/src/lib/db/plugins.ts
import type { D1Database } from '@cloudflare/workers-types';
import type { AppDb } from '../drizzle.js';
import { eq, and, sql } from 'drizzle-orm';
import { getDb } from '../drizzle.js';
import { orgPlugins, orgPluginArtifacts, orgPluginSettings } from '../schema/index.js';

export interface PluginRecord {
  id: string;
  orgId: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  source: string;
  capabilities: string[];
  status: string;
}

export interface PluginArtifact {
  id: string;
  pluginId: string;
  type: string;
  filename: string;
  content: string;
  sortOrder: number;
}

export interface PluginSettings {
  allowRepoContent: boolean;
}

// ── Plugin CRUD ──

export async function listPlugins(db: D1Database, orgId: string = 'default'): Promise<PluginRecord[]> {
  const drizzle = getDb(db);
  const rows = await drizzle
    .select()
    .from(orgPlugins)
    .where(eq(orgPlugins.orgId, orgId));
  return rows.map(r => ({
    id: r.id,
    orgId: r.orgId,
    name: r.name,
    version: r.version,
    description: r.description ?? undefined,
    icon: r.icon ?? undefined,
    source: r.source,
    capabilities: r.capabilities as string[],
    status: r.status,
  }));
}

export async function getPlugin(db: D1Database, id: string): Promise<(PluginRecord & { artifacts: PluginArtifact[] }) | null> {
  const drizzle = getDb(db);
  const row = await drizzle.select().from(orgPlugins).where(eq(orgPlugins.id, id)).get();
  if (!row) return null;

  const artifacts = await drizzle
    .select()
    .from(orgPluginArtifacts)
    .where(eq(orgPluginArtifacts.pluginId, id));

  return {
    id: row.id,
    orgId: row.orgId,
    name: row.name,
    version: row.version,
    description: row.description ?? undefined,
    icon: row.icon ?? undefined,
    source: row.source,
    capabilities: row.capabilities as string[],
    status: row.status,
    artifacts: artifacts.map(a => ({
      id: a.id,
      pluginId: a.pluginId,
      type: a.type,
      filename: a.filename,
      content: a.content,
      sortOrder: a.sortOrder,
    })),
  };
}

export async function upsertPlugin(db: AppDb, data: {
  id: string;
  orgId: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  source: string;
  capabilities: string[];
}): Promise<void> {
  await db.insert(orgPlugins).values({
    id: data.id,
    orgId: data.orgId,
    name: data.name,
    version: data.version,
    description: data.description ?? null,
    icon: data.icon ?? null,
    source: data.source,
    capabilities: data.capabilities,
  }).onConflictDoUpdate({
    target: [orgPlugins.orgId, orgPlugins.name],
    set: {
      version: sql`excluded.version`,
      description: sql`excluded.description`,
      icon: sql`excluded.icon`,
      source: sql`excluded.source`,
      capabilities: sql`excluded.capabilities`,
      updatedAt: sql`datetime('now')`,
    },
  });
}

export async function updatePluginStatus(db: AppDb, id: string, status: string): Promise<void> {
  await db.update(orgPlugins).set({ status, updatedAt: sql`datetime('now')` }).where(eq(orgPlugins.id, id));
}

// ── Artifacts ──

export async function upsertPluginArtifact(db: AppDb, data: {
  id: string;
  pluginId: string;
  type: string;
  filename: string;
  content: string;
  sortOrder?: number;
}): Promise<void> {
  await db.insert(orgPluginArtifacts).values({
    id: data.id,
    pluginId: data.pluginId,
    type: data.type,
    filename: data.filename,
    content: data.content,
    sortOrder: data.sortOrder ?? 0,
  }).onConflictDoUpdate({
    target: [orgPluginArtifacts.pluginId, orgPluginArtifacts.type, orgPluginArtifacts.filename],
    set: {
      content: sql`excluded.content`,
      sortOrder: sql`excluded.sort_order`,
    },
  });
}

export async function deletePluginArtifacts(db: AppDb, pluginId: string): Promise<void> {
  await db.delete(orgPluginArtifacts).where(eq(orgPluginArtifacts.pluginId, pluginId));
}

export async function getActivePluginArtifacts(db: D1Database, orgId: string = 'default'): Promise<PluginArtifact[]> {
  const result = await db
    .prepare(
      `SELECT a.* FROM org_plugin_artifacts a
       JOIN org_plugins p ON p.id = a.plugin_id
       WHERE p.org_id = ? AND p.status = 'active'
       ORDER BY a.type, a.sort_order, a.filename`
    )
    .bind(orgId)
    .all();

  return (result.results || []).map((r: any) => ({
    id: r.id,
    pluginId: r.plugin_id,
    type: r.type,
    filename: r.filename,
    content: r.content,
    sortOrder: r.sort_order,
  }));
}

// ── Settings ──

export async function getPluginSettings(db: D1Database, orgId: string = 'default'): Promise<PluginSettings> {
  const drizzle = getDb(db);
  const row = await drizzle
    .select()
    .from(orgPluginSettings)
    .where(eq(orgPluginSettings.orgId, orgId))
    .get();
  return { allowRepoContent: row?.allowRepoContent ?? true };
}

export async function upsertPluginSettings(db: AppDb, orgId: string, settings: Partial<PluginSettings>): Promise<void> {
  const id = crypto.randomUUID();
  await db.insert(orgPluginSettings).values({
    id,
    orgId,
    allowRepoContent: settings.allowRepoContent ?? true,
  }).onConflictDoUpdate({
    target: orgPluginSettings.orgId,
    set: {
      ...(settings.allowRepoContent !== undefined ? { allowRepoContent: settings.allowRepoContent } : {}),
      updatedAt: sql`datetime('now')`,
    },
  });
}
```

**Step 2: Export from DB barrel**

Add to `packages/worker/src/lib/db.ts`:
```typescript
export * from './db/plugins.js';
```

**Step 3: Verify**

Run: `cd packages/worker && pnpm typecheck`

**Step 4: Commit**

```bash
git add packages/worker/src/lib/db/plugins.ts packages/worker/src/lib/db.ts
git commit -m "feat: add DB helpers for plugin registry"
```

---

### Task 9: Add plugin sync service

Create a service that reads `plugin.yaml` manifests and content files from the compiled plugin set, and upserts them into D1. This runs once at worker cold start.

**Files:**
- Create: `packages/worker/src/services/plugin-sync.ts`

**Step 1: Create the plugin manifest type and compiled registry**

The sync service needs a compiled list of plugins and their content. Since we can't read the filesystem at runtime in Cloudflare Workers, we need to generate a content registry alongside the code registries.

Create a new generation output: `packages/worker/src/plugins/content-registry.ts` — this is auto-generated by `make generate-registries` and contains the content (skills, personas, tools) from all plugins, inlined as strings.

Update `packages/worker/scripts/generate-plugin-registry.ts` to also generate the content registry:

For each plugin directory, scan for:
- `skills/*.md` files → read content, include in registry
- `personas/*.md` files → read content, include in registry
- `tools/*.json` files → read content, include in registry

The generated file looks like:
```typescript
// AUTO-GENERATED — do not edit
export interface PluginContentEntry {
  name: string;
  version: string;
  description?: string;
  icon?: string;
  capabilities: string[];
  artifacts: Array<{ type: string; filename: string; content: string; sortOrder: number }>;
}

export const pluginContentRegistry: PluginContentEntry[] = [
  {
    name: 'browser',
    version: '0.0.1',
    description: 'Browser control via agent-browser CLI',
    icon: '🌐',
    capabilities: ['skills'],
    artifacts: [
      { type: 'skill', filename: 'browser.md', content: `...full SKILL.md content...`, sortOrder: 0 },
    ],
  },
  // ... all plugins with content
];
```

**Step 2: Write the sync service**

```typescript
// packages/worker/src/services/plugin-sync.ts
import type { D1Database } from '@cloudflare/workers-types';
import { getDb } from '../lib/drizzle.js';
import * as db from '../lib/db.js';
import { pluginContentRegistry } from '../plugins/content-registry.js';

let synced = false;

export async function syncPluginsOnce(d1: D1Database, orgId: string = 'default'): Promise<void> {
  if (synced) return;
  synced = true;

  const appDb = getDb(d1);

  for (const plugin of pluginContentRegistry) {
    const pluginId = `builtin:${plugin.name}`;

    await db.upsertPlugin(appDb, {
      id: pluginId,
      orgId,
      name: plugin.name,
      version: plugin.version,
      description: plugin.description,
      icon: plugin.icon,
      source: 'builtin',
      capabilities: plugin.capabilities,
    });

    // Replace all artifacts for this plugin
    await db.deletePluginArtifacts(appDb, pluginId);
    for (const artifact of plugin.artifacts) {
      await db.upsertPluginArtifact(appDb, {
        id: crypto.randomUUID(),
        pluginId,
        type: artifact.type,
        filename: artifact.filename,
        content: artifact.content,
        sortOrder: artifact.sortOrder,
      });
    }
  }
}
```

**Step 3: Wire sync into worker startup**

Add to `packages/worker/src/index.ts`, inside the middleware chain:
```typescript
import { syncPluginsOnce } from './services/plugin-sync.js';

// After dbMiddleware, before routes:
app.use('/api/*', async (c, next) => {
  await syncPluginsOnce(c.env.DB);
  return next();
});
```

**Step 4: Update the registry generation script**

Extend `packages/worker/scripts/generate-plugin-registry.ts` to also generate `src/plugins/content-registry.ts` by reading `skills/*.md`, `personas/*.md`, `tools/*.json` from each plugin directory and inlining the content. Also read `plugin.yaml` (using a simple YAML parser or just read the fields manually since the format is trivial).

**Step 5: Verify**

Run: `make generate-registries`
Run: `pnpm typecheck`

**Step 6: Commit**

```bash
git add packages/worker/src/services/plugin-sync.ts packages/worker/src/plugins/ packages/worker/scripts/ packages/worker/src/index.ts
git commit -m "feat: add plugin sync service with content registry generation"
```

---

### Task 10: Add plugin API routes

**Files:**
- Create: `packages/worker/src/routes/plugins.ts`
- Modify: `packages/worker/src/index.ts` — mount route

**Step 1: Write the routes**

```typescript
// packages/worker/src/routes/plugins.ts
import { Hono } from 'hono';
import { z } from 'zod';
import { zValidator } from '@hono/zod-validator';
import { ForbiddenError } from '@valet/shared';
import type { Env, Variables } from '../env.js';
import * as db from '../lib/db.js';
import { syncPluginsOnce } from '../services/plugin-sync.js';

export const pluginsRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

// GET /api/plugins — list active plugins
pluginsRouter.get('/', async (c) => {
  const plugins = await db.listPlugins(c.env.DB);
  return c.json({ plugins });
});

// GET /api/plugins/:id — plugin detail with artifacts
pluginsRouter.get('/:id', async (c) => {
  const { id } = c.req.param();
  const plugin = await db.getPlugin(c.env.DB, id);
  if (!plugin) return c.json({ error: 'Plugin not found' }, 404);
  return c.json({ plugin });
});

// POST /api/plugins/sync — force re-sync (admin)
pluginsRouter.post('/sync', async (c) => {
  const user = c.get('user');
  if (user.role !== 'admin') throw new ForbiddenError('Admin only');
  // Reset synced flag and re-run
  await syncPluginsOnce(c.env.DB);
  return c.json({ ok: true });
});

// PUT /api/plugins/:id — enable/disable (admin)
pluginsRouter.put('/:id', zValidator('json', z.object({
  status: z.enum(['active', 'disabled']),
})), async (c) => {
  const user = c.get('user');
  if (user.role !== 'admin') throw new ForbiddenError('Admin only');
  const { id } = c.req.param();
  const { status } = c.req.valid('json');
  await db.updatePluginStatus(c.get('db'), id, status);
  return c.json({ ok: true });
});

// GET /api/plugins/settings — org plugin settings
pluginsRouter.get('/settings', async (c) => {
  const settings = await db.getPluginSettings(c.env.DB);
  return c.json({ settings });
});

// PUT /api/plugins/settings — update org plugin settings (admin)
pluginsRouter.put('/settings', zValidator('json', z.object({
  allowRepoContent: z.boolean().optional(),
})), async (c) => {
  const user = c.get('user');
  if (user.role !== 'admin') throw new ForbiddenError('Admin only');
  const body = c.req.valid('json');
  await db.upsertPluginSettings(c.get('db'), 'default', body);
  return c.json({ ok: true });
});
```

**Step 2: Mount in index.ts**

Add to `packages/worker/src/index.ts`:
```typescript
import { pluginsRouter } from './routes/plugins.js';
app.route('/api/plugins', pluginsRouter);
```

**Step 3: Verify**

Run: `cd packages/worker && pnpm typecheck`

**Step 4: Commit**

```bash
git add packages/worker/src/routes/plugins.ts packages/worker/src/index.ts
git commit -m "feat: add plugin API routes"
```

---

## Phase 3: Content Delivery via Runner

Replace the current `PERSONA_FILES_JSON` env var → `start.sh` path with DO → Runner WebSocket delivery.

---

### Task 11: Update DO to assemble and send plugin content

When the Runner connects, the DO should send plugin content (org plugins + session persona) alongside the existing `opencode-config` message.

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts` — add `sendPluginContent()` method, call it after Runner connects
- Modify: `packages/runner/src/types.ts` — add `plugin-content` message type

**Step 1: Add the `plugin-content` message type**

In `packages/runner/src/types.ts`, add to `DOToRunnerMessage`:
```typescript
| {
    type: 'plugin-content';
    content: {
      personas: Array<{ filename: string; content: string; sortOrder: number }>;
      skills: Array<{ filename: string; content: string }>;
      tools: Array<{ filename: string; content: string }>;
      allowRepoContent: boolean;
    };
  }
```

**Step 2: Add content assembly in the DO**

In `packages/worker/src/durable-objects/session-agent.ts`, add a method:

```typescript
private async sendPluginContent(): Promise<void> {
  const spawnRequestStr = this.getStateValue('spawnRequest');
  if (!spawnRequestStr) return;

  const spawnRequest = JSON.parse(spawnRequestStr);
  const orgId = 'default'; // TODO: resolve from user's org

  // Get active plugin artifacts from D1
  const artifacts = await db.getActivePluginArtifacts(this.env.DB, orgId);

  // Get session persona files
  const personaFiles = spawnRequest.personaFiles || [];

  // Get plugin settings
  const settings = await db.getPluginSettings(this.env.DB, orgId);

  const content = {
    personas: [
      ...artifacts.filter(a => a.type === 'persona').map(a => ({
        filename: a.filename,
        content: a.content,
        sortOrder: a.sortOrder,
      })),
      ...personaFiles,
    ],
    skills: artifacts.filter(a => a.type === 'skill').map(a => ({
      filename: a.filename,
      content: a.content,
    })),
    tools: artifacts.filter(a => a.type === 'tool').map(a => ({
      filename: a.filename,
      content: a.content,
    })),
    allowRepoContent: settings.allowRepoContent,
  };

  this.sendToRunner({ type: 'plugin-content', content });
}
```

Call `this.sendPluginContent()` right after (or alongside) `this.sendOpenCodeConfig()` — find the line where `sendOpenCodeConfig` is called after Runner connects (around line 1051) and add the plugin content send there.

**Step 3: Verify**

Run: `cd packages/worker && pnpm typecheck`

**Step 4: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts packages/runner/src/types.ts
git commit -m "feat: DO assembles and sends plugin content to Runner"
```

---

### Task 12: Update Runner to receive plugin content and write files

**Files:**
- Modify: `packages/runner/src/agent-client.ts` — add `onPluginContent` handler
- Modify: `packages/runner/src/opencode-manager.ts` — add `writePluginContent()` method
- Modify: `packages/runner/src/bin.ts` — wire the handler, ensure content is written before OpenCode starts

**Step 1: Add handler to AgentClient**

In `packages/runner/src/agent-client.ts`, add:

```typescript
// New handler field:
private pluginContentHandler: ((content: { personas: ...; skills: ...; tools: ...; allowRepoContent: boolean }) => void | Promise<void>) | null = null;

// Registration method:
onPluginContent(handler: typeof this.pluginContentHandler): void {
  this.pluginContentHandler = handler;
}

// In the message switch (handleMessage):
case 'plugin-content':
  await this.pluginContentHandler?.(msg.content);
  break;
```

**Step 2: Add writePluginContent to OpenCodeManager**

In `packages/runner/src/opencode-manager.ts`, add a new method:

```typescript
writePluginContent(content: {
  personas: Array<{ filename: string; content: string; sortOrder: number }>;
  skills: Array<{ filename: string; content: string }>;
  tools: Array<{ filename: string; content: string }>;
  allowRepoContent: boolean;
}): void {
  // Write personas to .valet/persona/
  const personaDir = join(this.workspaceDir, '.valet', 'persona');
  mkdirSync(personaDir, { recursive: true });
  for (const p of content.personas) {
    const padded = String(p.sortOrder).padStart(2, '0');
    writeFileSync(join(personaDir, `${padded}-${p.filename}`), p.content);
  }

  // Write skills to .opencode/skills/<name>/SKILL.md
  const skillsDir = join(this.workspaceDir, '.opencode', 'skills');
  for (const s of content.skills) {
    const skillName = s.filename.replace(/\.md$/, '');
    const dir = join(skillsDir, skillName);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'SKILL.md'), s.content);
  }

  // Write tools to .opencode/tools/<name>
  const toolsDir = join(this.workspaceDir, '.opencode', 'tools');
  mkdirSync(toolsDir, { recursive: true });
  for (const t of content.tools) {
    writeFileSync(join(toolsDir, t.filename), t.content);
  }

  // Scan repo .valet/ content if allowed
  if (content.allowRepoContent) {
    this.scanRepoContent();
  }

  console.log(`[OpenCodeManager] Wrote plugin content: ${content.personas.length} personas, ${content.skills.length} skills, ${content.tools.length} tools`);
}

private scanRepoContent(): void {
  // Scan .valet/personas/*.md
  const repoPersonaDir = join(this.workspaceDir, '.valet', 'personas');
  if (existsSync(repoPersonaDir)) {
    const targetDir = join(this.workspaceDir, '.valet', 'persona');
    for (const file of readdirSync(repoPersonaDir)) {
      if (file.endsWith('.md')) {
        copyFileSync(join(repoPersonaDir, file), join(targetDir, `99-repo-${file}`));
      }
    }
  }

  // Scan .valet/skills/*.md
  const repoSkillsDir = join(this.workspaceDir, '.valet', 'skills');
  if (existsSync(repoSkillsDir)) {
    const targetDir = join(this.workspaceDir, '.opencode', 'skills');
    for (const file of readdirSync(repoSkillsDir)) {
      if (file.endsWith('.md')) {
        const skillName = file.replace(/\.md$/, '');
        const dir = join(targetDir, `repo-${skillName}`);
        mkdirSync(dir, { recursive: true });
        copyFileSync(join(repoSkillsDir, file), join(dir, 'SKILL.md'));
      }
    }
  }

  // Scan .valet/tools/*.json
  const repoToolsDir = join(this.workspaceDir, '.valet', 'tools');
  if (existsSync(repoToolsDir)) {
    const targetDir = join(this.workspaceDir, '.opencode', 'tools');
    for (const file of readdirSync(repoToolsDir)) {
      if (file.endsWith('.json')) {
        copyFileSync(join(repoToolsDir, file), join(targetDir, `repo-${file}`));
      }
    }
  }
}
```

**Step 3: Wire into bin.ts**

In `packages/runner/src/bin.ts`, add the handler. The plugin content must be written before OpenCode starts. Find where `resolveFirstConfig` is handled and add:

```typescript
// Promise for plugin content (resolved when received from DO)
let resolvePluginContent: ((content: any) => void) | null = null;
const pluginContentPromise = new Promise<any>((resolve) => {
  resolvePluginContent = resolve;
});

agentClient.onPluginContent(async (content) => {
  if (resolvePluginContent) {
    resolvePluginContent(content);
    resolvePluginContent = null;
    return;
  }
  // Hot-reload: write content and restart OpenCode
  openCodeManager.writePluginContent(content);
  await openCodeManager.applyConfig(openCodeManager.currentConfig!);
});

// In the main startup flow, after receiving first config:
const [config, pluginContent] = await Promise.all([
  firstConfigPromise,
  pluginContentPromise,
]);
openCodeManager.writePluginContent(pluginContent);
await openCodeManager.start(config);
```

**Step 4: Verify**

Run: `cd packages/runner && pnpm typecheck`

**Step 5: Commit**

```bash
git add packages/runner/src/agent-client.ts packages/runner/src/opencode-manager.ts packages/runner/src/bin.ts
git commit -m "feat: Runner receives plugin content from DO and writes files"
```

---

### Task 13: Remove PERSONA_FILES_JSON from the pipeline

**Files:**
- Modify: `docker/start.sh` — remove the "Persona Files Injection" block (lines 101-118)
- Modify: `packages/worker/src/services/sessions.ts` — stop putting `personaFiles` in spawnRequest (the DO now handles this via plugin content)
- Modify: `backend/sandboxes.py` — remove `PERSONA_FILES_JSON` env var injection

**Step 1: Remove from start.sh**

Delete the block from line 101 (`# ─── Persona Files Injection`) through line 118 (`fi`).

**Step 2: Remove from sessions service**

In `packages/worker/src/services/sessions.ts`, the `personaFiles` field on `spawnRequest` (line 348) is no longer needed for the env var path. However, it's still needed by the DO to assemble plugin content. Keep it in the spawnRequest for now — the DO reads it in `sendPluginContent()`.

Actually, review: the DO already stores the full spawnRequest including personaFiles. The `sendPluginContent` method reads `spawnRequest.personaFiles` from state. So no change needed in sessions.ts — the persona files still flow through spawnRequest to the DO, they just don't go to the Modal backend as an env var anymore.

**Step 3: Remove from sandboxes.py**

In `backend/sandboxes.py`, remove the block that converts `config.persona_files` to `PERSONA_FILES_JSON`. Find lines ~89-92 and remove:
```python
if config.persona_files:
    import json
    secrets_dict["PERSONA_FILES_JSON"] = json.dumps(config.persona_files)
```

**Step 4: Verify the full pipeline**

Run: `pnpm typecheck`

**Step 5: Commit**

```bash
git add docker/start.sh backend/sandboxes.py
git commit -m "refactor: remove PERSONA_FILES_JSON env var pipeline"
```

---

### Task 14: Remove skills/plugins from Docker image build

Since skills and tools are now delivered via the Runner, they don't need to be baked into the sandbox image.

**Files:**
- Modify: `backend/images/base.py` — remove lines that copy `docker/opencode/skills/` and `docker/opencode/plugins/` into the image
- Modify: `backend/app.py` — remove `docker/opencode/skills` and `docker/opencode/plugins` from `add_local_dir` if present
- Bump `IMAGE_BUILD_VERSION` in `backend/images/base.py`

**Step 1: Review and update image definition**

Check `backend/images/base.py` and `backend/app.py` for references to `docker/opencode/skills` and `docker/opencode/plugins`. Remove the lines that copy those directories into the image.

The `docker/opencode/tools/` directory (OpenCode custom tools like `spawn_session.ts`, etc.) should still be in the image — those are different from plugin-provided tools. Only remove the skills and plugins directories that are now delivered dynamically.

**Step 2: Bump image version**

In `backend/images/base.py`, increment `IMAGE_BUILD_VERSION`.

**Step 3: Commit**

```bash
git add backend/images/base.py backend/app.py
git commit -m "refactor: remove skills/plugins from sandbox image, deliver via Runner"
```

---

## Phase 4: Shared Types & Documentation

---

### Task 15: Add shared types for plugins

**Files:**
- Modify: `packages/shared/src/types/index.ts` — add plugin-related types

**Step 1: Add types**

```typescript
// Plugin types
export interface OrgPlugin {
  id: string;
  orgId: string;
  name: string;
  version: string;
  description?: string;
  icon?: string;
  source: string;
  capabilities: string[];
  status: string;
  installedBy: string;
  installedAt: string;
  updatedAt: string;
}

export interface OrgPluginArtifact {
  id: string;
  pluginId: string;
  type: 'skill' | 'persona' | 'tool';
  filename: string;
  content: string;
  sortOrder: number;
}

export interface OrgPluginSettings {
  allowRepoContent: boolean;
}

export interface PluginContentPayload {
  personas: Array<{ filename: string; content: string; sortOrder: number }>;
  skills: Array<{ filename: string; content: string }>;
  tools: Array<{ filename: string; content: string }>;
  allowRepoContent: boolean;
}
```

**Step 2: Verify**

Run: `pnpm typecheck`

**Step 3: Commit**

```bash
git add packages/shared/src/types/index.ts
git commit -m "feat: add shared types for plugin system"
```

---

### Task 16: Update documentation

**Files:**
- Modify: `CLAUDE.md` — update project structure, code conventions, and common patterns sections
- Modify: `docs/specs/sandbox-runtime.md` — update persona injection flow
- Modify: `docs/specs/sandbox-images.md` — note that skills/tools are no longer image-baked
- Modify: `Makefile` — update `generate-registries` target if needed

**Step 1: Update CLAUDE.md project structure**

Replace the `packages/actions-*` and `packages/channel-*` entries with:
```
├── plugins/                 # Unified plugin packages
│   ├── github/              # GitHub integration (actions + triggers)
│   ├── slack/               # Slack (actions + channels)
│   ├── telegram/            # Telegram (channels)
│   ├── browser/             # Browser control (skills)
│   ├── workflows/           # Workflow operations (skills)
│   └── ...                  # More plugins
```

Update the "Adding a new integration" and "Adding a new channel" patterns to reference `plugins/` instead.

Add a new pattern: "Adding a content-only plugin" showing the minimal `plugin.yaml` + `skills/*.md` approach.

**Step 2: Update specs**

Update `docs/specs/sandbox-runtime.md` to describe the new flow: DO → Runner WebSocket → file writes → OpenCode.

Update `docs/specs/sandbox-images.md` to note skills and tools are no longer part of the image.

**Step 3: Commit**

```bash
git add CLAUDE.md docs/specs/ Makefile
git commit -m "docs: update documentation for unified plugin system"
```

---

## Summary

| Phase | Tasks | What changes |
|-------|-------|-------------|
| 1: Directory restructure | 1-5 | Move files to `plugins/`, update registry generation, delete old dirs |
| 2: D1 registry | 6-10 | Migration, schema, DB helpers, sync service, API routes |
| 3: Runner delivery | 11-14 | DO sends content via WS, Runner writes files, remove PERSONA_FILES_JSON |
| 4: Types & docs | 15-16 | Shared types, documentation updates |
