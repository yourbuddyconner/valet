# GitHub Identity Card, Service Config & Credential Resolution — Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a generic org service config table, admin GitHub config UI, a user-facing GitHub identity card with OAuth linking, and repo-aware credential resolution.

**Architecture:** Generic `org_service_configs` table replaces per-service config tables (migrating Slack). GitHub admin config stored via this table with env var fallback. User GitHub identity linked via OAuth flow with JWT state tokens. Credential resolution rewritten to be repo-aware using stored accessible owners.

**Tech Stack:** D1/Drizzle (schema + migration), Hono (routes), React/TanStack Query (UI), GitHub OAuth API

**Spec:** `docs/specs/2026-03-18-github-identity-card-design.md`

---

## Chunk 1: Generic Service Config Table + Slack Migration

### Task 1: D1 Migration — `org_service_configs` table

**Files:**
- Create: `packages/worker/migrations/0071_service_configs.sql`

- [ ] **Step 1: Write the migration SQL**

```sql
-- Create generic service config table
CREATE TABLE org_service_configs (
  service TEXT PRIMARY KEY,
  encrypted_config TEXT NOT NULL,
  metadata TEXT,
  configured_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

Note: This migration only creates the table. Slack data migration happens in application code (Task 4) because existing Slack secrets are encrypted per-field with AES-GCM (`encryptString`), while the new generic table stores the entire config blob encrypted as one string. SQL cannot re-encrypt — the migration helper runs at startup or via a one-time script.

- [ ] **Step 2: Verify migration number is correct**

Check `packages/worker/migrations/` for the latest migration number. The file should be `0071_service_configs.sql` (after `0070_analytics_events.sql`).

Run: `ls packages/worker/migrations/ | tail -5`

- [ ] **Step 3: Commit**

```bash
git add packages/worker/migrations/0071_service_configs.sql
git commit -m "feat: add org_service_configs table"
```

---

### Task 2: Drizzle Schema for `org_service_configs`

**Files:**
- Create: `packages/worker/src/lib/schema/service-configs.ts`
- Modify: `packages/worker/src/lib/schema/index.ts`

- [ ] **Step 1: Create the Drizzle schema**

```typescript
// packages/worker/src/lib/schema/service-configs.ts
import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { users } from './users.js';

export const orgServiceConfigs = sqliteTable('org_service_configs', {
  service: text().primaryKey(),
  encryptedConfig: text('encrypted_config').notNull(),
  metadata: text(),
  configuredBy: text('configured_by').notNull().references(() => users.id),
  createdAt: text('created_at').notNull().default(sql`(datetime('now'))`),
  updatedAt: text('updated_at').notNull().default(sql`(datetime('now'))`),
});
```

- [ ] **Step 2: Re-export from schema index**

Add to `packages/worker/src/lib/schema/index.ts`:

```typescript
export * from './service-configs.js';
```

- [ ] **Step 3: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`
Expected: PASS (no consumers yet)

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/lib/schema/service-configs.ts packages/worker/src/lib/schema/index.ts
git commit -m "feat: add Drizzle schema for org_service_configs"
```

---

### Task 3: Generic Service Config DB Helpers

**Files:**
- Create: `packages/worker/src/lib/db/service-configs.ts`
- Create: `packages/worker/src/lib/db/service-configs.test.ts`
- Modify: `packages/worker/src/lib/db.ts`

- [ ] **Step 1: Write failing tests**

```typescript
// packages/worker/src/lib/db/service-configs.test.ts
import { describe, it, expect, beforeEach, vi } from 'vitest';

// Test the types and helpers conceptually:
// We'll test the actual DB operations once the helpers are written.

describe('service-configs', () => {
  describe('getServiceConfig', () => {
    it('returns null when no config exists for service', async () => {
      // Will test with actual DB mock
    });

    it('returns decrypted config and parsed metadata', async () => {
      // Will test with actual DB mock
    });
  });

  describe('setServiceConfig', () => {
    it('inserts new config with encrypted data', async () => {
      // Will test with actual DB mock
    });

    it('upserts existing config', async () => {
      // Will test with actual DB mock
    });
  });

  describe('getServiceMetadata', () => {
    it('returns parsed metadata without decrypting config', async () => {
      // Will test with actual DB mock
    });

    it('returns null when no config exists', async () => {
      // Will test with actual DB mock
    });
  });

  describe('deleteServiceConfig', () => {
    it('deletes config and returns true', async () => {
      // Will test with actual DB mock
    });

    it('returns false when config does not exist', async () => {
      // Will test with actual DB mock
    });
  });
});
```

- [ ] **Step 2: Implement the helpers**

```typescript
// packages/worker/src/lib/db/service-configs.ts
import type { AppDb } from '../drizzle.js';
import { eq, sql } from 'drizzle-orm';
import { orgServiceConfigs } from '../schema/index.js';
import { encryptString, decryptString } from '../crypto.js';

export async function getServiceConfig<TConfig = Record<string, unknown>, TMeta = Record<string, unknown>>(
  db: AppDb,
  encryptionKey: string,
  service: string,
): Promise<{ config: TConfig; metadata: TMeta; configuredBy: string; updatedAt: string } | null> {
  const row = await db
    .select()
    .from(orgServiceConfigs)
    .where(eq(orgServiceConfigs.service, service))
    .get();
  if (!row) return null;

  const decrypted = await decryptString(row.encryptedConfig, encryptionKey);
  const config = JSON.parse(decrypted) as TConfig;
  const metadata = row.metadata ? (JSON.parse(row.metadata) as TMeta) : ({} as TMeta);

  return { config, metadata, configuredBy: row.configuredBy, updatedAt: row.updatedAt! };
}

export async function setServiceConfig<TConfig = Record<string, unknown>, TMeta = Record<string, unknown>>(
  db: AppDb,
  encryptionKey: string,
  service: string,
  config: TConfig,
  metadata: TMeta,
  configuredBy: string,
): Promise<void> {
  const encrypted = await encryptString(JSON.stringify(config), encryptionKey);
  const metaJson = JSON.stringify(metadata);
  const now = new Date().toISOString();

  await db.insert(orgServiceConfigs).values({
    service,
    encryptedConfig: encrypted,
    metadata: metaJson,
    configuredBy,
    createdAt: now,
    updatedAt: now,
  }).onConflictDoUpdate({
    target: orgServiceConfigs.service,
    set: {
      encryptedConfig: sql`excluded.encrypted_config`,
      metadata: sql`excluded.metadata`,
      configuredBy: sql`excluded.configured_by`,
      updatedAt: sql`excluded.updated_at`,
    },
  });
}

export async function getServiceMetadata<TMeta = Record<string, unknown>>(
  db: AppDb,
  service: string,
): Promise<TMeta | null> {
  const row = await db
    .select({ metadata: orgServiceConfigs.metadata })
    .from(orgServiceConfigs)
    .where(eq(orgServiceConfigs.service, service))
    .get();
  if (!row?.metadata) return null;
  return JSON.parse(row.metadata) as TMeta;
}

export async function updateServiceMetadata<TMeta = Record<string, unknown>>(
  db: AppDb,
  service: string,
  metadata: TMeta,
): Promise<void> {
  await db.update(orgServiceConfigs)
    .set({
      metadata: JSON.stringify(metadata),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(orgServiceConfigs.service, service));
}

export async function deleteServiceConfig(
  db: AppDb,
  service: string,
): Promise<boolean> {
  const result = await db
    .delete(orgServiceConfigs)
    .where(eq(orgServiceConfigs.service, service));
  return (result.meta?.changes ?? 0) > 0;
}
```

- [ ] **Step 3: Re-export from db barrel**

Add to `packages/worker/src/lib/db.ts`:

```typescript
export * from './db/service-configs.js';
```

- [ ] **Step 4: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`

- [ ] **Step 5: Run tests**

Run: `cd packages/worker && pnpm test -- service-configs`

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/lib/db/service-configs.ts packages/worker/src/lib/db/service-configs.test.ts packages/worker/src/lib/db.ts
git commit -m "feat: add generic service config DB helpers with encryption"
```

---

### Task 4: Migrate Slack Callers to Generic Service Config

**Files:**
- Modify: `packages/worker/src/lib/db/slack.ts` (lines 1-116 — org install helpers)
- Modify: `packages/worker/src/services/slack.ts`
- Modify: `packages/worker/src/integrations/resolvers/slack.ts`

**Important encryption note:** Existing Slack data in `org_slack_installs` stores secrets as individually encrypted strings (AES-GCM via `encryptString`). The new `org_service_configs` table stores the entire `encrypted_config` blob as a single encrypted string. The Slack DB helpers must handle the data migration: read from `org_slack_installs`, decrypt individual fields, re-encrypt as a single JSON blob into `org_service_configs`. This happens lazily on first read or eagerly via `saveOrgSlackInstall`.

- [ ] **Step 1: Add Slack service config types to `slack.ts`**

```typescript
export interface SlackServiceConfig {
  botToken: string;
  signingSecret?: string;
}

export interface SlackServiceMetadata {
  teamId: string;
  teamName?: string;
  botUserId: string;
  appId?: string;
}
```

- [ ] **Step 2: Rewrite Slack DB helpers**

Update function signatures to accept `encryptionKey: string` parameter. This is a breaking change to the function signatures — all callers must be updated in Step 3.

- `getOrgSlackInstallAny(db, encryptionKey)` → reads from `org_service_configs` via `getServiceConfig<SlackServiceConfig, SlackServiceMetadata>`. If not found, falls back to reading `org_slack_installs` (legacy), decrypts individual fields, writes to `org_service_configs` (one-time migration), and returns the result.
- `getOrgSlackInstall(db, encryptionKey, teamId)` → same pattern, checks metadata `teamId` match.
- `saveOrgSlackInstall(db, encryptionKey, data)` → writes to `org_service_configs` via `setServiceConfig`. Secrets (`botToken`, `signingSecret`) go in config, rest in metadata.
- `deleteOrgSlackInstall(db, teamId)` → calls `deleteServiceConfig(db, 'slack')`.

The fallback-and-migrate pattern ensures existing Slack installs are migrated on first access without a separate migration script.

- [ ] **Step 3: Update all Slack helper callers**

Update `packages/worker/src/services/slack.ts` and `packages/worker/src/integrations/resolvers/slack.ts` to pass `env.ENCRYPTION_KEY` to the Slack DB helpers. Grep for all callers:

Run: `rg "getOrgSlackInstall|saveOrgSlackInstall|deleteOrgSlackInstall" packages/worker/src/ --files-with-matches`

Update each call site.

- [ ] **Step 4: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`

- [ ] **Step 5: Run all tests**

Run: `pnpm test`

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/lib/db/slack.ts packages/worker/src/services/slack.ts packages/worker/src/integrations/resolvers/slack.ts
git commit -m "refactor: migrate Slack config to generic org_service_configs table"
```

---

## Chunk 2: GitHub Admin Config

### Task 5: GitHub Config Helper with Env Var Fallback

**Files:**
- Create: `packages/worker/src/services/github-config.ts`
- Create: `packages/worker/src/services/github-config.test.ts`

- [ ] **Step 1: Define GitHub config types and helper**

```typescript
// packages/worker/src/services/github-config.ts
import type { AppDb } from '../lib/drizzle.js';
import type { Env } from '../env.js';
import { getServiceConfig, getServiceMetadata } from '../lib/db/service-configs.js';

export interface GitHubServiceConfig {
  oauthClientId: string;
  oauthClientSecret: string;
  appId?: string;
  appPrivateKey?: string;
  appSlug?: string;
  appWebhookSecret?: string;
}

export interface GitHubServiceMetadata {
  appInstallationId?: string;
  accessibleOwners?: string[];
  accessibleOwnersRefreshedAt?: string;
}

export interface GitHubConfig {
  oauthClientId: string;
  oauthClientSecret: string;
  appId?: string;
  appPrivateKey?: string;
  appSlug?: string;
  appWebhookSecret?: string;
  appInstallationId?: string;
  appAccessibleOwners?: string[];
}

/**
 * Resolve GitHub config from D1 first, fall back to env vars.
 */
export async function getGitHubConfig(env: Env, db: AppDb): Promise<GitHubConfig | null> {
  // Try D1 first
  const svc = await getServiceConfig<GitHubServiceConfig, GitHubServiceMetadata>(
    db, env.ENCRYPTION_KEY, 'github',
  );

  if (svc) {
    return {
      oauthClientId: svc.config.oauthClientId,
      oauthClientSecret: svc.config.oauthClientSecret,
      appId: svc.config.appId,
      appPrivateKey: svc.config.appPrivateKey,
      appSlug: svc.config.appSlug,
      appWebhookSecret: svc.config.appWebhookSecret,
      appInstallationId: svc.metadata.appInstallationId,
      appAccessibleOwners: svc.metadata.accessibleOwners,
    };
  }

  // Fall back to env vars
  if (!env.GITHUB_CLIENT_ID || !env.GITHUB_CLIENT_SECRET) return null;

  return {
    oauthClientId: env.GITHUB_CLIENT_ID,
    oauthClientSecret: env.GITHUB_CLIENT_SECRET,
    appId: env.GITHUB_APP_ID,
    appPrivateKey: env.GITHUB_APP_PRIVATE_KEY,
    appSlug: env.GITHUB_APP_SLUG,
    appWebhookSecret: env.GITHUB_APP_WEBHOOK_SECRET,
  };
}

/**
 * Get just the GitHub metadata (accessible owners) without decrypting secrets.
 */
export async function getGitHubMetadata(db: AppDb): Promise<GitHubServiceMetadata | null> {
  return getServiceMetadata<GitHubServiceMetadata>(db, 'github');
}
```

- [ ] **Step 2: Write tests**

Test the env var fallback logic and the D1-first behavior.

- [ ] **Step 3: Run tests**

Run: `cd packages/worker && pnpm test -- github-config`

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/services/github-config.ts packages/worker/src/services/github-config.test.ts
git commit -m "feat: add getGitHubConfig helper with D1-first, env var fallback"
```

---

### Task 6: Migrate All `c.env.GITHUB_*` Reads to `getGitHubConfig()`

**Files:**
- Modify: `packages/worker/src/routes/repo-providers.ts` (lines 28, 149-150, 201, 211)
- Modify: `packages/worker/src/routes/oauth.ts` (lines 292-293)
- Modify: `packages/worker/src/routes/integrations.ts` (around line 159)
- Modify: `packages/worker/src/lib/env-assembly.ts` (if it reads GitHub env vars directly)

- [ ] **Step 1: Update `repo-providers.ts`**

Replace all `c.env.GITHUB_CLIENT_ID`, `c.env.GITHUB_CLIENT_SECRET`, `c.env.GITHUB_APP_ID`, `c.env.GITHUB_APP_PRIVATE_KEY` with calls to `getGitHubConfig(c.env, c.get('db'))`.

- [ ] **Step 2: Update `oauth.ts`**

Update the `ProviderConfig` builder for GitHub to resolve from `getGitHubConfig()` instead of `env.GITHUB_CLIENT_ID`.

- [ ] **Step 3: Update `integrations.ts`**

The `GET /integrations/available` endpoint checks env vars to decide which services are available. Switch to `getGitHubConfig()`.

- [ ] **Step 4: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`

- [ ] **Step 5: Run tests**

Run: `pnpm test`

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/routes/repo-providers.ts packages/worker/src/routes/oauth.ts packages/worker/src/routes/integrations.ts
git commit -m "refactor: migrate all GitHub env var reads to getGitHubConfig helper"
```

---

### Task 7: Admin GitHub Config Endpoints

**Files:**
- Create: `packages/worker/src/routes/admin-github.ts`
- Modify: `packages/worker/src/index.ts`

- [ ] **Step 1: Create the admin route file**

Implements the endpoints from the spec:
- `GET /api/admin/github` — returns config with secrets redacted
- `PUT /api/admin/github/oauth` — sets OAuth App client ID + secret
- `POST /api/admin/github/app/manifest` — generates manifest + GitHub form URL for App creation
- `POST /api/admin/github/app/refresh` — re-syncs installation metadata from GitHub
- `DELETE /api/admin/github/oauth` — removes entire GitHub config (app + OAuth + credential)

> **Note:** `PUT /app`, `DELETE /app`, and `POST /app/verify` were replaced by the manifest flow. See `docs/specs/2026-04-07-github-app-manifest-flow-design.md`.

All endpoints use `adminMiddleware`. Uses `setServiceConfig<GitHubServiceConfig, GitHubServiceMetadata>` for storage.

The refresh endpoint:
1. Mints a JWT from App ID + private key
2. Calls `GET https://api.github.com/app/installations` to find the installation (enforces single-installation model)
3. Calls `GET https://api.github.com/installation/repositories` with installation token to get accessible owners
4. Stores `installationId`, `accessibleOwners`, `accessibleOwnersRefreshedAt`, `repositoryCount` in metadata
5. Returns the list of accessible owners for display

- [ ] **Step 2: Mount in index.ts**

Add to `packages/worker/src/index.ts`:

```typescript
import { adminGitHubRouter } from './routes/admin-github.js';
// Mount under /api/admin/github (inside the authenticated /api/* block)
app.route('/api/admin/github', adminGitHubRouter);
```

- [ ] **Step 3: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/routes/admin-github.ts packages/worker/src/index.ts
git commit -m "feat: add admin GitHub config endpoints"
```

---

### Task 8: Admin GitHub Config UI

**Files:**
- Create: `packages/client/src/components/settings/github-config.tsx`
- Create: `packages/client/src/api/admin-github.ts`
- Modify: `packages/client/src/routes/settings/admin.tsx`

- [ ] **Step 1: Create React Query hooks for admin GitHub config**

```typescript
// packages/client/src/api/admin-github.ts
// Pattern: follow packages/client/src/api/slack.ts
export const adminGitHubKeys = {
  config: ['admin', 'github'] as const,
};

useAdminGitHubConfig()           // GET /api/admin/github
useSetGitHubOAuth()              // PUT /api/admin/github/oauth
useCreateGitHubAppManifest()     // POST /api/admin/github/app/manifest
useRefreshGitHubApp()            // POST /api/admin/github/app/refresh
useDeleteGitHubConfig()          // DELETE /api/admin/github/oauth
```

- [ ] **Step 2: Create the GitHub config component**

`packages/client/src/components/settings/github-config.tsx` — Two collapsible panels (OAuth App, GitHub App) as described in spec. Follow existing patterns in `admin.tsx`.

- [ ] **Step 3: Add to admin settings page**

Import and render `GitHubConfigSection` in `packages/client/src/routes/settings/admin.tsx`.

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/api/admin-github.ts packages/client/src/components/settings/github-config.tsx packages/client/src/routes/settings/admin.tsx
git commit -m "feat: add admin GitHub config UI in org settings"
```

---

## Chunk 3: User GitHub Identity Card

### Task 9: User GitHub Status + Link Endpoints

**Files:**
- Create: `packages/worker/src/routes/github-me.ts`
- Modify: `packages/worker/src/index.ts`

- [ ] **Step 1: Create the route file**

Implements:
- `GET /api/me/github` — assembles status from `org_service_configs` (GitHub metadata), `users` table, and `credentials` table. Returns `{ oauthConfigured, orgApp: { installed, accessibleOwners }, personal: { linked, githubUsername, githubId, email, avatarUrl, scopes } }`.
- `POST /api/me/github/link` — accepts `{ scopes?: string[] }`, resolves GitHub config via `getGitHubConfig()`, generates JWT state token (signed with `ENCRYPTION_KEY`, 10min expiry, encodes userId + scopes), returns `{ redirectUrl }`.
- `DELETE /api/me/github/link` — deletes `UserIdentityLink` for provider `'github'`, deletes user credential, clears `githubId`/`githubUsername` on user record.

- [ ] **Step 2: Mount in index.ts**

```typescript
import { githubMeRouter } from './routes/github-me.js';
app.route('/api/me/github', githubMeRouter);
```

- [ ] **Step 3: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/routes/github-me.ts packages/worker/src/index.ts
git commit -m "feat: add user GitHub status and link endpoints"
```

---

### Task 10: GitHub OAuth Callback (Public Route)

**Files:**
- Modify: `packages/worker/src/routes/github-me.ts` (add callback)
- Modify: `packages/worker/src/index.ts` (mount public callback)

- [ ] **Step 1: Add callback route**

Export a separate `githubMeCallbackRouter` (unauthenticated) from `github-me.ts`, following the `repoProviderCallbackRouter` pattern in `repo-providers.ts`.

`GET /auth/github/link/callback`:
1. Validate + decode JWT state token
2. Exchange code for access token
3. Check actual granted scopes (store what GitHub returns, not what was requested)
4. Fetch user profile + emails
5. Upsert `UserIdentityLink` (provider: `'github'`, externalId: GitHub user ID, externalName: username, teamId: null)
6. Upsert user credential (provider: `'github'`, credentialType: `'oauth2'`, scopes always explicitly set)
7. Update user record (`githubId`, `githubUsername`)
8. Redirect to `${FRONTEND_URL}/integrations?github=linked`

- [ ] **Step 2: Mount public callback in index.ts**

```typescript
import { githubMeCallbackRouter } from './routes/github-me.js';
// Mount OUTSIDE /api/* to avoid auth middleware (line ~150 area, near repoProviderCallbackRouter)
app.route('/auth/github/link', githubMeCallbackRouter);
```

- [ ] **Step 3: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/routes/github-me.ts packages/worker/src/index.ts
git commit -m "feat: add GitHub OAuth callback for identity linking"
```

---

### Task 11: GitHub Card Frontend

**Files:**
- Create: `packages/client/src/api/github.ts`
- Create: `packages/client/src/components/integrations/github-card.tsx`
- Modify: `packages/client/src/components/integrations/integration-list.tsx`

- [ ] **Step 1: Create React Query hooks**

```typescript
// packages/client/src/api/github.ts
// Follow packages/client/src/api/slack.ts pattern
export const githubKeys = {
  status: ['me', 'github'] as const,
};

useGitHubStatus()         // GET /api/me/github
useGitHubLink()           // POST /api/me/github/link → returns { redirectUrl }
useGitHubDisconnect()     // DELETE /api/me/github/link
```

The `useGitHubLink` mutation's `onSuccess` does `window.location.href = data.redirectUrl` to redirect to GitHub.

- [ ] **Step 2: Create GitHubCard component**

`packages/client/src/components/integrations/github-card.tsx` — renders one of 4 states based on `useGitHubStatus()` response:

1. **Not connected** (`!oauthConfigured`): "GitHub not configured" message, disabled button
2. **Not connected** (`oauthConfigured && !orgApp.installed && !personal.linked`): "Connect GitHub" button
3. **Org app only** (`orgApp.installed && !personal.linked`): Shows org app capabilities, "Connect Personal Account" button
4. **Connected no repo** (`personal.linked && scopes doesn't include 'repo'`): Identity shown, Actions ✓, Repo access "Enable" button, warning about valet[bot] commits
5. **Fully connected** (`personal.linked && scopes includes 'repo'`): Both ✓, success banner, Disconnect link

Follow the `SlackCard` component pattern (lines 304-378 of `integration-list.tsx`).

- [ ] **Step 3: Add GitHubCard to integration list**

In `packages/client/src/components/integrations/integration-list.tsx`:
- Add `'github'` to the `dedicatedServices` set (alongside slack, 1password, telegram)
- Render `<GitHubCard />` in the dedicated cards section

- [ ] **Step 4: Run typecheck**

Run: `pnpm typecheck`

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/api/github.ts packages/client/src/components/integrations/github-card.tsx packages/client/src/components/integrations/integration-list.tsx
git commit -m "feat: add GitHub identity card to integrations page"
```

---

## Chunk 4: Repo-Aware Credential Resolution

### Task 12: Rewrite `resolveRepoCredential` to Be Repo-Aware

**Files:**
- Modify: `packages/worker/src/lib/db/credentials.ts` (lines 178-196)
- Modify: `packages/worker/src/lib/db/credentials.test.ts` (lines 231-359)

- [ ] **Step 1: Update tests for new signature**

Update existing tests to pass `repoOwner` parameter. Add new tests:
- "uses org App when repoOwner matches org App's accessibleOwners"
- "uses user App when repoOwner matches user App's accessibleOwners"
- "returns null when repoOwner matches no installation"
- "OAuth token wins regardless of repoOwner"

The new function needs access to `org_service_configs` metadata. Pass `db` (already available) to read GitHub metadata.

- [ ] **Step 2: Run tests to verify they fail**

Run: `cd packages/worker && pnpm test -- credentials`
Expected: FAIL (signature mismatch)

- [ ] **Step 3: Implement new resolution logic**

New signature:
```typescript
export async function resolveRepoCredential(
  db: AppDb,
  provider: string,
  repoOwner: string | undefined,
  orgId: string | undefined,
  userId: string,
): Promise<{ credential: CredentialRow; credentialType: 'oauth2' | 'app_install' } | null>
```

Import `getServiceMetadata` from `'./service-configs.js'` and `GitHubServiceMetadata` from `'../../services/github-config.js'` at the top of `credentials.ts`.

Logic:
1. User OAuth token → return it (no change)
2. If `repoOwner` is provided, read GitHub metadata from `org_service_configs` (via `getServiceMetadata<GitHubServiceMetadata>(db, 'github')`). If `metadata.accessibleOwners` includes `repoOwner`, use org App installation credential
3. Check user-level App installation credentials for matching `accessibleOwners` in their metadata JSON
4. If `repoOwner` is undefined (non-repo-scoped operation), fall back to the old behavior: org App install → user App install
5. Null

**Known gap:** Lazy refresh of `accessibleOwners` when stale (spec says refresh if older than 1 hour) is deferred to a follow-up task. For now, admins can re-verify via the admin UI to refresh.

- [ ] **Step 4: Run tests to verify they pass**

Run: `cd packages/worker && pnpm test -- credentials`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/lib/db/credentials.ts packages/worker/src/lib/db/credentials.test.ts
git commit -m "feat: rewrite resolveRepoCredential to be repo-aware"
```

---

### Task 13: Update All `resolveRepoCredential` Callers

**Files:**
- Modify: `packages/worker/src/routes/repos.ts` (line ~85)
- Modify: `packages/worker/src/lib/env-assembly.ts` (line ~171)
- Modify: `packages/worker/src/durable-objects/session-agent.ts` (line ~7382)
- Modify: `packages/worker/src/services/sessions.ts` (if it calls `resolveRepoCredential`)

- [ ] **Step 1: Update `getGitHubToken()` in `repos.ts`**

The routes that call this already have `:owner` available as a route param. Thread the `owner` param through to `resolveRepoCredential`. For the repo listing route that doesn't have an owner, pass `undefined` as `repoOwner`.

- [ ] **Step 2: Update `assembleRepoEnv()` in `env-assembly.ts`**

This function has the repo context (owner/name). Extract the owner and pass it to `resolveRepoCredential`.

- [ ] **Step 3: Update `getGitHubToken()` in `session-agent.ts`**

This is the most complex change. The function needs a `repoOwner` parameter. Important: preserve the multiplayer priority chain (prompt author first, then session creator). For each user in the chain, call `resolveRepoCredential` with the `repoOwner`.

Update the method signature to accept `repoOwner?: string`. Callers that have owner info (e.g., `handleListPullRequests`, `handleCreatePullRequest`) pass it through. `handleListRepos` passes `undefined`.

Note: `getGitHubToken()` currently returns a decrypted `accessToken` string. The new version must also handle the App installation case (mint a token via the provider), not just return the OAuth token. Follow the pattern from `getGitHubToken()` in `repos.ts` which already handles both credential types.

- [ ] **Step 4: Update `services/sessions.ts` if applicable**

Check if `services/sessions.ts` calls `resolveRepoCredential`. If so, thread `repoOwner` through.

- [ ] **Step 5: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`

- [ ] **Step 6: Run all tests**

Run: `pnpm test`

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/routes/repos.ts packages/worker/src/lib/env-assembly.ts packages/worker/src/durable-objects/session-agent.ts packages/worker/src/services/sessions.ts
git commit -m "feat: update all resolveRepoCredential callers with repo owner"
```

---

### Task 14: Scope Reconciliation

**Files:**
- Modify: `packages/plugin-github/src/actions/provider.ts` (line 9, line 28)

- [ ] **Step 1: Add `user:email` to actions provider scopes**

Update `oauthScopes` (line 9) and `getOAuthUrl` scope string (line 28) to include `user:email`:

```typescript
oauthScopes: ['repo', 'read:user', 'read:org', 'user:email'],
// ...
scope: 'repo read:user read:org user:email',
```

- [ ] **Step 2: Run typecheck**

Run: `cd packages/worker && pnpm typecheck`

- [ ] **Step 3: Commit**

```bash
git add packages/plugin-github/src/actions/provider.ts
git commit -m "fix: add user:email to GitHub actions provider OAuth scopes"
```
