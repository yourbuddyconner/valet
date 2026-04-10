# GitHub App Unified Authentication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the classic OAuth App + GitHub App dual-credential system with a unified GitHub App model that supports multiple installations (org + personal), uses the App's built-in OAuth for user access tokens, adopts Octokit as the SDK, and injects user attribution when acting via bot tokens.

**Architecture:** Single GitHub App per Valet instance. User access tokens (via the App's OAuth client) are primary; installation access tokens mint on-demand via Octokit (no external cache — fresh mint per resolver call, relying on Octokit's within-instance caching) and serve as the anonymous-access fallback with attribution injection. A new `github_installations` table tracks all installations. A new `/auth/github/*` router intercepts GitHub-specific auth flows before the generic identity dispatcher. All raw GitHub fetch code is replaced with Octokit.

**Tech Stack:** Cloudflare Workers + Hono + Drizzle (D1), Octokit (`octokit`, `@octokit/auth-app`, `@octokit/oauth-app`, `@octokit/webhooks`, `@octokit/plugin-throttling`), TypeScript, vitest

**Source spec:** [`docs/specs/2026-04-09-github-app-unified-auth-design.md`](../specs/2026-04-09-github-app-unified-auth-design.md)

**Superseded plan:** `docs/plans/2026-04-08-github-multi-credential-routing.md` — parts of that plan were implemented and this plan must revert the reversible portions (`CredentialSourceInfo` plumbing, `source` param on actions, `githubCredentialResolver` logic, `accessibleOwners` cache).

**Critical reference: existing `CredentialResult` shape**

The credential resolver infrastructure uses a discriminated union where the successful case wraps an inner `credential: ResolvedCredential`, NOT a flat object. From `packages/worker/src/services/credentials.ts`:

```typescript
export interface ResolvedCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes?: string[];
  credentialType: CredentialType;
  refreshed: boolean;
}

export type CredentialResult =
  | { ok: true; credential: ResolvedCredential }
  | { ok: false; error: CredentialResolutionError };
```

All code in this plan that constructs or consumes `CredentialResult` must use this wrapped shape — `result.credential.accessToken`, not `result.accessToken`. Task 8 adds `attribution` to `ResolvedCredential` (not at the top level of `CredentialResult`).

**Pre-existing refresh dispatch:** `attemptRefresh` in `credentials.ts` has a switch on provider name. The current `case 'github'` returns an error ("GitHub tokens do not support refresh"). Task 11 replaces that case with an Octokit-based refresh.

**Pending approval backward-compat shim location:** `packages/worker/src/durable-objects/session-agent.ts` lines ~5654-5658 contain a shim that converts `isOrgScoped: boolean` in persisted approval contexts into `credentialSources: CredentialSourceInfo[]`. Task 12 removes this shim AND must handle in-flight pending approvals (see Task 12 step 7).

---

## File Structure

**New files**

| Path | Responsibility |
|---|---|
| `packages/worker/src/services/github-app.ts` | Octokit `App` factory, installation token minting, OAuth helper wrappers |
| `packages/worker/src/services/github-installations.ts` | CRUD + discovery/reconciliation logic for `github_installations` |
| `packages/worker/src/routes/github-auth.ts` | GitHub-specific login/link router (mounted before `oauthRouter`) |
| `packages/worker/src/lib/schema/github-installations.ts` | Drizzle schema |
| `packages/worker/src/lib/db/github-installations.ts` | Query helpers (upsert, findByLogin, findByUser, reconcile) |
| `packages/worker/migrations/0006_create_github_installations.sql` | DDL for the new table |
| `packages/worker/src/services/github-app.test.ts` | Tests for token minting |
| `packages/worker/src/integrations/resolvers/github.test.ts` | Tests for the new resolver chain |
| `packages/worker/src/services/github-installations.test.ts` | Tests for discovery/reconciliation |
| `packages/worker/src/routes/github-auth.test.ts` | Tests for login/link dispatch |

**Files rewritten or heavily modified**

| Path | Change |
|---|---|
| `packages/worker/src/integrations/resolvers/github.ts` | Rewrite with new 4-step chain (user → installation → fail) |
| `packages/worker/src/integrations/registry.ts` | Revert `CredentialSourceInfo` plumbing; simplify `CredentialResolverContext` |
| `packages/worker/src/integrations/resolvers/default.ts` | Revert to simple shape |
| `packages/worker/src/services/credentials.ts` | Octokit-based refresh for GitHub; remove `app_install` handling; add `attribution` field on `CredentialResult` |
| `packages/worker/src/services/session-tools.ts` | Revert `credentialSources[]` plumbing |
| `packages/worker/src/durable-objects/session-agent.ts` | Revert `credentialType` dim on CredentialCache; remove `accessibleOwners` cache |
| `packages/worker/src/services/github-config.ts` | Drop classic `oauthClientId`/`oauthClientSecret` from types; make App OAuth required |
| `packages/worker/src/routes/admin-github.ts` | Remove classic-OAuth endpoints; add installations list endpoint; add toggles; remove single-install enforcement |
| `packages/worker/src/routes/github-me.ts` | `POST /link` uses App OAuth via Octokit; remove `githubMeCallbackRouter` entirely (moved to `github-auth.ts`) |
| `packages/worker/src/routes/webhooks.ts` | Rewrite `POST /github` with Octokit `verifyAndReceive`, installation lifecycle handlers; preserve PR/push session state handlers |
| `packages/worker/src/routes/repo-providers.ts` | Install callback: verify signed state JWT, upsert installation, drop classic-OAuth path |
| `packages/worker/src/index.ts` | Mount `githubAuthRouter` at `/auth/github` before `oauthRouter` |
| `packages/plugin-github/src/identity.ts` | Stub: `configKeys = []`, `handleCallback` throws |
| `packages/plugin-github/src/actions/actions.ts` | Remove `source` param from all actions; use `ctx.attribution`; switch `list_repos` by attribution presence; inject attribution in commit/PR/issue/comment bodies |
| `packages/plugin-github/src/actions/api.ts` | Delete `githubFetch`; actions construct Octokit internally |
| `packages/plugin-github/src/actions/provider.ts` | Type updates |
| `packages/plugin-github/src/repo-app.ts` | `mintToken` delegates to worker `services/github-app.ts`; git config uses attribution |
| `packages/plugin-github/src/repo-oauth.ts` | Rename logically to `githubUserRepoProvider`; `mintToken` becomes no-op |
| `packages/plugin-github/src/repo-shared.ts` | Remove `mintInstallationToken` (moved to worker) |
| `packages/plugin-github/skills/github.md` | Rewrite to reflect unified model, no `source` param, attribution behavior |
| `packages/sdk/src/integrations/index.ts` (or equivalent) | Add optional `attribution?: { name, email }` to `ActionContext` |
| `packages/worker/src/env.ts` | Remove `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` |
| `packages/worker/package.json` | Add `octokit`, `@octokit/plugin-throttling` |
| `packages/plugin-github/package.json` | Add `octokit` |
| `packages/client/src/api/admin-github.ts` | Drop classic OAuth endpoints; add installations list + toggle mutations |
| `packages/client/src/api/me-github.ts` (or equivalent) | Update: remove scopes; show installations |
| `packages/client/src/components/settings/github-config.tsx` | Rewrite: drop OAuth panel; add installations sections; add toggles |

**Phases & ordering:** The plan is ordered so each task leaves the system in a compilable state. Phase 1 is additive-only (new files, no removals). Phase 2 rewrites the resolver but keeps actions working via compatibility shims. Phase 3+ progressively retire the old paths.

---

## Phase 1: Foundations (additive, no behavior change)

### Task 1: Add Octokit dependencies

**Files:**
- Modify: `packages/worker/package.json`
- Modify: `packages/plugin-github/package.json`
- Modify: `pnpm-lock.yaml` (auto-updated)

- [ ] **Step 1: Add octokit to worker**

```bash
cd packages/worker
pnpm add octokit @octokit/plugin-throttling
```

- [ ] **Step 2: Add octokit to plugin-github**

```bash
cd packages/plugin-github
pnpm add octokit
```

- [ ] **Step 3: Typecheck the workspace**

```bash
cd /Users/connerswann/code/valet
pnpm typecheck
```

Expected: passes. If Octokit has Workers compat issues under `nodejs_compat`, Task 3 surfaces them — don't fix here.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/package.json packages/plugin-github/package.json pnpm-lock.yaml
git commit -m "chore: add octokit dependencies for GitHub App unified auth"
```

---

### Task 2: Create `github_installations` table schema + migration

**Files:**
- Create: `packages/worker/migrations/0006_create_github_installations.sql`
- Create: `packages/worker/src/lib/schema/github-installations.ts`
- Modify: `packages/worker/src/lib/schema/index.ts` (re-export)

- [ ] **Step 1: Write the SQL migration**

Create `packages/worker/migrations/0006_create_github_installations.sql`:

```sql
-- Tracks GitHub App installations (both org and personal).
-- github_installation_id and account_id stored as TEXT to avoid JS number
-- precision issues — Octokit returns them as JS numbers, we cast at the boundary.
-- cached_token_encrypted / cached_token_expires_at: short-TTL cache of the
-- installation access token to avoid re-minting on every resolver call.
CREATE TABLE github_installations (
  id TEXT PRIMARY KEY,
  github_installation_id TEXT NOT NULL UNIQUE,
  account_login TEXT NOT NULL,
  account_id TEXT NOT NULL,
  account_type TEXT NOT NULL CHECK(account_type IN ('Organization', 'User')),
  linked_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active', 'suspended', 'removed')),
  repository_selection TEXT NOT NULL CHECK(repository_selection IN ('all', 'selected')),
  permissions TEXT, -- JSON
  cached_token_encrypted TEXT,      -- encrypted installation access token (PBKDF2 via ENCRYPTION_KEY)
  cached_token_expires_at TEXT,     -- ISO timestamp
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_github_installations_account_login ON github_installations(account_login);
CREATE INDEX idx_github_installations_account_id ON github_installations(account_id);
CREATE INDEX idx_github_installations_linked_user ON github_installations(linked_user_id)
  WHERE linked_user_id IS NOT NULL;
```

- [ ] **Step 2: Write the Drizzle schema**

Create `packages/worker/src/lib/schema/github-installations.ts`:

```typescript
import { sqliteTable, text, index } from 'drizzle-orm/sqlite-core';
import { users } from './users.js';

export const githubInstallations = sqliteTable(
  'github_installations',
  {
    id: text('id').primaryKey(),
    githubInstallationId: text('github_installation_id').notNull().unique(),
    accountLogin: text('account_login').notNull(),
    accountId: text('account_id').notNull(),
    accountType: text('account_type', { enum: ['Organization', 'User'] }).notNull(),
    linkedUserId: text('linked_user_id').references(() => users.id, { onDelete: 'set null' }),
    status: text('status', { enum: ['active', 'suspended', 'removed'] }).notNull().default('active'),
    repositorySelection: text('repository_selection', { enum: ['all', 'selected'] }).notNull(),
    permissions: text('permissions'),
    cachedTokenEncrypted: text('cached_token_encrypted'),
    cachedTokenExpiresAt: text('cached_token_expires_at'),
    createdAt: text('created_at').notNull().default(`(datetime('now'))`),
    updatedAt: text('updated_at').notNull().default(`(datetime('now'))`),
  },
  (t) => ({
    byAccountLogin: index('idx_github_installations_account_login').on(t.accountLogin),
    byAccountId: index('idx_github_installations_account_id').on(t.accountId),
    byLinkedUser: index('idx_github_installations_linked_user').on(t.linkedUserId),
  }),
);

export type GithubInstallation = typeof githubInstallations.$inferSelect;
export type NewGithubInstallation = typeof githubInstallations.$inferInsert;
```

- [ ] **Step 3: Re-export from schema barrel**

Add to `packages/worker/src/lib/schema/index.ts`:

```typescript
export * from './github-installations.js';
```

- [ ] **Step 4: Apply migration locally**

```bash
make db-migrate
```

Expected: migration 0006 applied.

- [ ] **Step 5: Verify schema via sqlite**

```bash
cd packages/worker && wrangler d1 execute valet-local --local --command ".schema github_installations"
```

Expected: CREATE TABLE output matching the migration.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/migrations/0006_create_github_installations.sql \
        packages/worker/src/lib/schema/github-installations.ts \
        packages/worker/src/lib/schema/index.ts
git commit -m "feat(db): add github_installations table"
```

---

### Task 3: Write query helpers for `github_installations` (TDD)

**Files:**
- Create: `packages/worker/src/lib/db/github-installations.ts`
- Create: `packages/worker/src/lib/db/github-installations.test.ts`
- Modify: `packages/worker/src/lib/db.ts` (barrel re-export)

- [ ] **Step 1: Write failing tests**

Create `packages/worker/src/lib/db/github-installations.test.ts`. Follow existing test patterns in `packages/worker/src/lib/db/credentials.test.ts` for in-memory SQLite setup. Tests to write:

```typescript
import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDb } from '../test-utils.js'; // existing util, check pattern
import type { AppDb } from '../drizzle.js';
import { users } from '../schema/users.js';
import {
  upsertGithubInstallation,
  getGithubInstallationByLogin,
  getGithubInstallationById,
  listGithubInstallationsByAccountType,
  listGithubInstallationsByUser,
  updateGithubInstallationStatus,
  updateGithubInstallationAccountLogin,
  linkGithubInstallationToUser,
} from './github-installations.js';

// Helper: seed a test user for FK-linked tests
async function seedUser(db: AppDb, id: string, email = `${id}@example.com`) {
  await db.insert(users).values({
    id,
    email,
    name: id,
    passwordHash: null,
    role: 'user',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

describe('github-installations db', () => {
  let db: AppDb;

  beforeEach(async () => {
    db = await createTestDb(); // applies migrations
  });

  it('upserts a new installation', async () => {
    await upsertGithubInstallation(db, {
      githubInstallationId: '12345',
      accountLogin: 'acme',
      accountId: '98765',
      accountType: 'Organization',
      repositorySelection: 'all',
      permissions: { contents: 'write' },
    });
    const row = await getGithubInstallationByLogin(db, 'acme');
    expect(row?.githubInstallationId).toBe('12345');
    expect(row?.accountType).toBe('Organization');
  });

  it('upserts an existing installation (preserves id, updates fields)', async () => {
    await upsertGithubInstallation(db, {
      githubInstallationId: '12345',
      accountLogin: 'acme',
      accountId: '98765',
      accountType: 'Organization',
      repositorySelection: 'selected',
      permissions: { contents: 'read' },
    });
    const first = await getGithubInstallationByLogin(db, 'acme');
    await upsertGithubInstallation(db, {
      githubInstallationId: '12345',
      accountLogin: 'acme',
      accountId: '98765',
      accountType: 'Organization',
      repositorySelection: 'all',
      permissions: { contents: 'write' },
    });
    const second = await getGithubInstallationByLogin(db, 'acme');
    expect(second?.id).toBe(first?.id);
    expect(second?.repositorySelection).toBe('all');
  });

  it('lists installations by account type', async () => {
    await upsertGithubInstallation(db, { githubInstallationId: '1', accountLogin: 'acme', accountId: '100', accountType: 'Organization', repositorySelection: 'all' });
    await upsertGithubInstallation(db, { githubInstallationId: '2', accountLogin: 'alice', accountId: '200', accountType: 'User', repositorySelection: 'all' });
    const orgs = await listGithubInstallationsByAccountType(db, 'Organization');
    const users = await listGithubInstallationsByAccountType(db, 'User');
    expect(orgs).toHaveLength(1);
    expect(users).toHaveLength(1);
  });

  it('soft-deletes via updateGithubInstallationStatus', async () => {
    await upsertGithubInstallation(db, { githubInstallationId: '1', accountLogin: 'acme', accountId: '100', accountType: 'Organization', repositorySelection: 'all' });
    await updateGithubInstallationStatus(db, '1', 'removed');
    const row = await getGithubInstallationByLogin(db, 'acme');
    expect(row?.status).toBe('removed');
  });

  it('updates account_login on rename', async () => {
    await upsertGithubInstallation(db, { githubInstallationId: '1', accountLogin: 'oldname', accountId: '100', accountType: 'Organization', repositorySelection: 'all' });
    await updateGithubInstallationAccountLogin(db, '1', 'newname');
    const row = await getGithubInstallationByLogin(db, 'newname');
    expect(row).toBeTruthy();
    const oldRow = await getGithubInstallationByLogin(db, 'oldname');
    expect(oldRow).toBeUndefined();
  });

  it('links installation to user', async () => {
    await seedUser(db, 'valet-user-id');
    await upsertGithubInstallation(db, { githubInstallationId: '1', accountLogin: 'alice', accountId: '200', accountType: 'User', repositorySelection: 'all' });
    await linkGithubInstallationToUser(db, '1', 'valet-user-id');
    const row = await getGithubInstallationByLogin(db, 'alice');
    expect(row?.linkedUserId).toBe('valet-user-id');
  });

  it('lists orphaned personal installations (linked_user_id IS NULL)', async () => {
    await upsertGithubInstallation(db, { githubInstallationId: '1', accountLogin: 'alice', accountId: '200', accountType: 'User', repositorySelection: 'all' });
    await upsertGithubInstallation(db, { githubInstallationId: '2', accountLogin: 'acme', accountId: '300', accountType: 'Organization', repositorySelection: 'all' });
    const orphaned = await listGithubInstallationsByAccountType(db, 'User', { orphanedOnly: true });
    expect(orphaned).toHaveLength(1);
    expect(orphaned[0].accountLogin).toBe('alice');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/worker && pnpm vitest run src/lib/db/github-installations.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement query helpers**

Create `packages/worker/src/lib/db/github-installations.ts`:

```typescript
import { eq, and, isNull } from 'drizzle-orm';
import type { AppDb } from '../drizzle.js';
import { githubInstallations, type GithubInstallation, type NewGithubInstallation } from '../schema/github-installations.js';

export interface UpsertInstallationInput {
  githubInstallationId: string;
  accountLogin: string;
  accountId: string;
  accountType: 'Organization' | 'User';
  repositorySelection: 'all' | 'selected';
  permissions?: Record<string, unknown>;
  linkedUserId?: string | null;
}

export async function upsertGithubInstallation(
  db: AppDb,
  input: UpsertInstallationInput,
): Promise<GithubInstallation> {
  const existing = await db.select().from(githubInstallations)
    .where(eq(githubInstallations.githubInstallationId, input.githubInstallationId))
    .get();

  const now = new Date().toISOString();
  const permissionsJson = input.permissions ? JSON.stringify(input.permissions) : null;

  if (existing) {
    const updated = await db.update(githubInstallations)
      .set({
        accountLogin: input.accountLogin,
        accountId: input.accountId,
        accountType: input.accountType,
        repositorySelection: input.repositorySelection,
        permissions: permissionsJson,
        linkedUserId: input.linkedUserId ?? existing.linkedUserId,
        status: existing.status === 'removed' ? 'active' : existing.status, // un-remove on re-install
        updatedAt: now,
      })
      .where(eq(githubInstallations.id, existing.id))
      .returning()
      .get();
    return updated;
  }

  const row: NewGithubInstallation = {
    id: crypto.randomUUID(),
    githubInstallationId: input.githubInstallationId,
    accountLogin: input.accountLogin,
    accountId: input.accountId,
    accountType: input.accountType,
    repositorySelection: input.repositorySelection,
    permissions: permissionsJson,
    linkedUserId: input.linkedUserId ?? null,
    status: 'active',
    createdAt: now,
    updatedAt: now,
  };
  return db.insert(githubInstallations).values(row).returning().get();
}

export async function getGithubInstallationByLogin(
  db: AppDb, accountLogin: string,
): Promise<GithubInstallation | undefined> {
  return db.select().from(githubInstallations)
    .where(and(
      eq(githubInstallations.accountLogin, accountLogin),
      eq(githubInstallations.status, 'active'),
    ))
    .get();
}

export async function getGithubInstallationById(
  db: AppDb, githubInstallationId: string,
): Promise<GithubInstallation | undefined> {
  return db.select().from(githubInstallations)
    .where(eq(githubInstallations.githubInstallationId, githubInstallationId))
    .get();
}

export async function getGithubInstallationByAccountId(
  db: AppDb, accountId: string,
): Promise<GithubInstallation | undefined> {
  return db.select().from(githubInstallations)
    .where(eq(githubInstallations.accountId, accountId))
    .get();
}

export interface ListInstallationsOpts {
  orphanedOnly?: boolean; // only include rows with linked_user_id IS NULL
}

export async function listGithubInstallationsByAccountType(
  db: AppDb,
  accountType: 'Organization' | 'User',
  opts: ListInstallationsOpts = {},
): Promise<GithubInstallation[]> {
  const conditions = [eq(githubInstallations.accountType, accountType)];
  if (opts.orphanedOnly) conditions.push(isNull(githubInstallations.linkedUserId));
  return db.select().from(githubInstallations).where(and(...conditions)).all();
}

export async function listGithubInstallationsByUser(
  db: AppDb, userId: string,
): Promise<GithubInstallation[]> {
  return db.select().from(githubInstallations)
    .where(eq(githubInstallations.linkedUserId, userId))
    .all();
}

export async function listAllActiveInstallations(db: AppDb): Promise<GithubInstallation[]> {
  return db.select().from(githubInstallations)
    .where(eq(githubInstallations.status, 'active'))
    .all();
}

export async function updateGithubInstallationStatus(
  db: AppDb, githubInstallationId: string, status: 'active' | 'suspended' | 'removed',
): Promise<void> {
  await db.update(githubInstallations)
    .set({ status, updatedAt: new Date().toISOString() })
    .where(eq(githubInstallations.githubInstallationId, githubInstallationId));
}

export async function updateGithubInstallationAccountLogin(
  db: AppDb, githubInstallationId: string, accountLogin: string,
): Promise<void> {
  await db.update(githubInstallations)
    .set({ accountLogin, updatedAt: new Date().toISOString() })
    .where(eq(githubInstallations.githubInstallationId, githubInstallationId));
}

export async function linkGithubInstallationToUser(
  db: AppDb, githubInstallationId: string, userId: string,
): Promise<void> {
  await db.update(githubInstallations)
    .set({ linkedUserId: userId, updatedAt: new Date().toISOString() })
    .where(eq(githubInstallations.githubInstallationId, githubInstallationId));
}

export async function deleteGithubInstallationsForAccount(
  db: AppDb, accountId: string,
): Promise<void> {
  await db.delete(githubInstallations).where(eq(githubInstallations.accountId, accountId));
}
```

- [ ] **Step 4: Re-export from db barrel**

Add to `packages/worker/src/lib/db.ts`:

```typescript
export * from './db/github-installations.js';
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd packages/worker && pnpm vitest run src/lib/db/github-installations.test.ts
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/lib/db/github-installations.ts \
        packages/worker/src/lib/db/github-installations.test.ts \
        packages/worker/src/lib/db.ts
git commit -m "feat(db): add github_installations query helpers"
```

---

### Task 4: Create `services/github-app.ts` — Octokit App factory + D1-cached installation tokens

**Files:**
- Create: `packages/worker/src/services/github-app.ts`
- Create: `packages/worker/src/services/github-app.test.ts`

**Note on caching**: installation access tokens expire in 1 hour and cost ~200ms to mint (JWT sign + HTTP POST to GitHub). We cache them in D1 on the `github_installations` row itself — two extra columns (`cached_token_encrypted`, `cached_token_expires_at`). The resolver already SELECTs the installation row to look it up by `account_login`, so cache hits are free (same SELECT). Cache misses add one UPDATE (at most once per hour per installation).

Tokens are encrypted at rest using the same PBKDF2 helper as `credentials.ts` (`encryptStringPBKDF2` / `decryptStringPBKDF2` from `lib/crypto.ts`). The cached token is not a long-lived credential — it's a ~1-hour memo of a recent mint — but we still encrypt because it grants GitHub API access.

- [ ] **Step 1: Write failing tests for `github-app.ts`**

Create `packages/worker/src/services/github-app.test.ts`:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { createGitHubApp, mintInstallationToken } from './github-app.js';

vi.mock('octokit', () => ({
  App: vi.fn().mockImplementation((opts) => ({
    appId: opts.appId,
    octokit: {
      request: vi.fn(async () => ({
        data: {
          token: 'ghs_test',
          expires_at: new Date(Date.now() + 3600_000).toISOString(),
        },
      })),
    },
    oauth: {
      getWebFlowAuthorizationUrl: vi.fn(() => ({ url: 'https://github.com/login/oauth/authorize?...' })),
      createToken: vi.fn(),
      refreshToken: vi.fn(),
      deleteToken: vi.fn(),
    },
    webhooks: {
      verifyAndReceive: vi.fn(),
      on: vi.fn(),
      onAny: vi.fn(),
    },
  })),
  Octokit: vi.fn().mockImplementation((opts) => ({ __auth: opts?.auth })),
}));

describe('createGitHubApp', () => {
  it('instantiates an App with provided credentials', () => {
    const app = createGitHubApp({
      appId: '12345',
      privateKey: 'test-key',
      oauthClientId: 'client-id',
      oauthClientSecret: 'client-secret',
      webhookSecret: 'webhook-secret',
    });
    expect(app.appId).toBe('12345');
  });
});

describe('mintInstallationToken', () => {
  it('mints a fresh installation token via POST /app/installations/{id}/access_tokens', async () => {
    const app = createGitHubApp({
      appId: '12345',
      privateKey: 'test-key',
      oauthClientId: 'client-id',
      oauthClientSecret: 'client-secret',
      webhookSecret: 'webhook-secret',
    });

    const result = await mintInstallationToken(app, '98765');
    expect(result.token).toBe('ghs_test');
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(app.octokit.request).toHaveBeenCalledWith(
      'POST /app/installations/{installation_id}/access_tokens',
      { installation_id: 98765 },
    );
  });

  it('throws on invalid installation id', async () => {
    const app = createGitHubApp({
      appId: '12345',
      privateKey: 'test-key',
      oauthClientId: 'client-id',
      oauthClientSecret: 'client-secret',
      webhookSecret: 'webhook-secret',
    });
    await expect(mintInstallationToken(app, 'not-a-number')).rejects.toThrow(/Invalid installation ID/);
  });
});

describe('getOrMintInstallationToken (D1-backed cache)', () => {
  let db: AppDb;
  let app: App;
  const ENCRYPTION_KEY = 'test-encryption-key';

  beforeEach(async () => {
    db = await createTestDb();
    app = createGitHubApp({
      appId: '12345',
      privateKey: 'test-key',
      oauthClientId: 'client-id',
      oauthClientSecret: 'client-secret',
      webhookSecret: 'webhook-secret',
    });
  });

  it('mints fresh when no cache exists and writes back to D1', async () => {
    // Seed installation row with no cached token
    const row = await upsertGithubInstallation(db, {
      githubInstallationId: '98765',
      accountLogin: 'acme',
      accountId: '5000',
      accountType: 'Organization',
      repositorySelection: 'all',
    });

    const result = await getOrMintInstallationToken(app, db, ENCRYPTION_KEY, row);
    expect(result.token).toBe('ghs_test');
    expect(app.octokit.request).toHaveBeenCalledOnce();

    // Verify cache was written
    const updated = await getGithubInstallationByLogin(db, 'acme');
    expect(updated?.cachedTokenEncrypted).toBeTruthy();
    expect(updated?.cachedTokenExpiresAt).toBeTruthy();
  });

  it('returns cached token without minting when cache is fresh', async () => {
    const row = await upsertGithubInstallation(db, {
      githubInstallationId: '98765',
      accountLogin: 'acme',
      accountId: '5000',
      accountType: 'Organization',
      repositorySelection: 'all',
    });
    // Pre-populate cache manually
    const encrypted = await encryptStringPBKDF2('ghs_cached', ENCRYPTION_KEY);
    await db.update(githubInstallations).set({
      cachedTokenEncrypted: encrypted,
      cachedTokenExpiresAt: new Date(Date.now() + 3000_000).toISOString(), // 50 min out
    }).where(eq(githubInstallations.id, row.id));

    // Fetch the updated row
    const cachedRow = await getGithubInstallationByLogin(db, 'acme');
    const result = await getOrMintInstallationToken(app, db, ENCRYPTION_KEY, cachedRow!);
    expect(result.token).toBe('ghs_cached');
    expect(app.octokit.request).not.toHaveBeenCalled();
  });

  it('re-mints when cached token is near expiry (within 5-min safety margin)', async () => {
    const row = await upsertGithubInstallation(db, {
      githubInstallationId: '98765',
      accountLogin: 'acme',
      accountId: '5000',
      accountType: 'Organization',
      repositorySelection: 'all',
    });
    const encrypted = await encryptStringPBKDF2('ghs_stale', ENCRYPTION_KEY);
    await db.update(githubInstallations).set({
      cachedTokenEncrypted: encrypted,
      cachedTokenExpiresAt: new Date(Date.now() + 2 * 60 * 1000).toISOString(), // 2 min out, under margin
    }).where(eq(githubInstallations.id, row.id));

    const cachedRow = await getGithubInstallationByLogin(db, 'acme');
    const result = await getOrMintInstallationToken(app, db, ENCRYPTION_KEY, cachedRow!);
    expect(result.token).toBe('ghs_test'); // fresh mint from mock, not 'ghs_stale'
    expect(app.octokit.request).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/worker && pnpm vitest run src/services/github-app.test.ts
```

Expected: FAIL (module not found).

- [ ] **Step 3: Implement `github-app.ts`**

Create `packages/worker/src/services/github-app.ts`:

```typescript
import { App } from 'octokit';
import type { Env } from '../env.js';
import type { AppDb } from '../lib/drizzle.js';
import { getServiceConfig } from '../lib/db/service-configs.js';
import type { GitHubServiceConfig } from './github-config.js';

export interface CreateGitHubAppInput {
  appId: string;
  privateKey: string;
  oauthClientId: string;
  oauthClientSecret: string;
  webhookSecret: string;
}

export function createGitHubApp(input: CreateGitHubAppInput): App {
  return new App({
    appId: input.appId,
    privateKey: input.privateKey,
    oauth: {
      clientId: input.oauthClientId,
      clientSecret: input.oauthClientSecret,
    },
    webhooks: {
      secret: input.webhookSecret,
    },
  });
}

/**
 * Load the GitHub App config from D1 and instantiate the Octokit App.
 * Returns null if the App is not configured.
 */
export async function loadGitHubApp(env: Env, db: AppDb): Promise<App | null> {
  const svc = await getServiceConfig<GitHubServiceConfig>(db, env.ENCRYPTION_KEY, 'github');
  if (!svc) return null;
  const c = svc.config;
  if (!c.appId || !c.appPrivateKey || !c.appOauthClientId || !c.appOauthClientSecret || !c.appWebhookSecret) {
    return null;
  }
  return createGitHubApp({
    appId: c.appId,
    privateKey: c.appPrivateKey,
    oauthClientId: c.appOauthClientId,
    oauthClientSecret: c.appOauthClientSecret,
    webhookSecret: c.appWebhookSecret,
  });
}

export interface InstallationTokenResult {
  token: string;
  expiresAt: number; // ms since epoch
}

/**
 * Mint a fresh installation access token by calling
 * POST /app/installations/{installation_id}/access_tokens.
 *
 * Raw mint — no caching. Use `getOrMintInstallationToken` if you want the
 * D1-backed cache path, which is usually what callers want.
 */
export async function mintInstallationToken(
  app: App,
  githubInstallationId: string,
): Promise<InstallationTokenResult> {
  const installationId = Number(githubInstallationId);
  if (!Number.isFinite(installationId)) {
    throw new Error(`Invalid installation ID: ${githubInstallationId}`);
  }
  const response = await app.octokit.request(
    'POST /app/installations/{installation_id}/access_tokens',
    { installation_id: installationId },
  );
  return {
    token: response.data.token,
    expiresAt: new Date(response.data.expires_at).getTime(),
  };
}

const CACHE_SAFETY_MARGIN_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Get an installation token from the D1 cache on `github_installations` if still
 * valid (expires > now + 5min buffer), else mint fresh and write back to the row.
 *
 * The caller passes the already-loaded `installation` row (from
 * `getGithubInstallationByLogin` etc.) — we don't re-SELECT it here. Cache-hit
 * path is free; cache-miss path is mint + encrypt + one UPDATE (at most once
 * per hour per installation).
 */
export async function getOrMintInstallationToken(
  app: App,
  db: AppDb,
  encryptionKey: string,
  installation: { id: string; githubInstallationId: string; cachedTokenEncrypted: string | null; cachedTokenExpiresAt: string | null },
): Promise<InstallationTokenResult> {
  // Cache hit path
  if (installation.cachedTokenEncrypted && installation.cachedTokenExpiresAt) {
    const expiresAt = new Date(installation.cachedTokenExpiresAt).getTime();
    const safeUntil = expiresAt - CACHE_SAFETY_MARGIN_MS;
    if (Date.now() < safeUntil) {
      try {
        const token = await decryptStringPBKDF2(installation.cachedTokenEncrypted, encryptionKey);
        return { token, expiresAt };
      } catch {
        // Corrupt / unreadable cache — fall through to fresh mint
      }
    }
  }

  // Fresh mint
  const result = await mintInstallationToken(app, installation.githubInstallationId);

  // Encrypt + write back to D1
  const encrypted = await encryptStringPBKDF2(result.token, encryptionKey);
  await db
    .update(githubInstallations)
    .set({
      cachedTokenEncrypted: encrypted,
      cachedTokenExpiresAt: new Date(result.expiresAt).toISOString(),
      updatedAt: new Date().toISOString(),
    })
    .where(eq(githubInstallations.id, installation.id));

  return result;
}
```

Add the necessary imports at the top of `github-app.ts`:

```typescript
import { eq } from 'drizzle-orm';
import { encryptStringPBKDF2, decryptStringPBKDF2 } from '../lib/crypto.js';
import { githubInstallations } from '../lib/schema/github-installations.js';
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/worker && pnpm vitest run src/services/github-app.test.ts
```

Expected: all pass.

- [ ] **Step 5: Typecheck the worker**

```bash
cd packages/worker && pnpm typecheck
```

Expected: passes. If Octokit has `workerd` compatibility issues, this is where we surface them. If there are errors:
- Try `import { App } from '@octokit/app'` instead of `from 'octokit'`
- Verify `@octokit/auth-app` version pulled uses `universal-github-app-jwt` (check `pnpm why universal-github-app-jwt`)
- If blocked: document the specific error in the commit message and consult the spec's "Cloudflare Worker runtime compatibility" section for the fallback plan

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/services/github-app.ts \
        packages/worker/src/services/github-app.test.ts
git commit -m "feat(github): add Octokit App factory + installation token minting"
```

---

### Task 5: Create `services/github-installations.ts` — discovery & reconciliation (TDD)

**Files:**
- Create: `packages/worker/src/services/github-installations.ts`
- Create: `packages/worker/src/services/github-installations.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/worker/src/services/github-installations.test.ts`. Test the three discovery paths:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { createTestDb } from '../lib/test-utils.js'; // follow existing convention
import type { AppDb } from '../lib/drizzle.js';
import { users } from '../lib/schema/users.js';
import { githubInstallations } from '../lib/schema/github-installations.js';
import {
  refreshAllInstallations,
  reconcileUserInstallations,
  handleInstallationWebhook,
} from './github-installations.js';
import {
  getGithubInstallationByLogin,
  listGithubInstallationsByUser,
  upsertGithubInstallation,
} from '../lib/db/github-installations.js';

async function seedUser(db: AppDb, id: string, githubId: string) {
  await db.insert(users).values({
    id,
    email: `${id}@example.com`,
    name: id,
    githubId,
    githubUsername: id,
    passwordHash: null,
    role: 'user',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

describe('refreshAllInstallations', () => {
  it('upserts installations from GET /app/installations', async () => {
    const db = await createTestDb();
    const mockApp: any = {
      octokit: {
        paginate: vi.fn(async () => [
          {
            id: 100,
            account: { login: 'acme', id: 5000, type: 'Organization' },
            repository_selection: 'all',
            permissions: { contents: 'write' },
          },
          {
            id: 200,
            account: { login: 'alice', id: 6000, type: 'User' },
            repository_selection: 'selected',
            permissions: { contents: 'read' },
          },
        ]),
      },
    };

    await refreshAllInstallations(mockApp, db);

    const acme = await getGithubInstallationByLogin(db, 'acme');
    expect(acme).toBeTruthy();
    expect(acme?.accountType).toBe('Organization');
    expect(acme?.githubInstallationId).toBe('100');

    const alice = await getGithubInstallationByLogin(db, 'alice');
    expect(alice?.accountType).toBe('User');
  });

  it('auto-links personal installations by matching account_id to users.github_id', async () => {
    const db = await createTestDb();
    // Seed user
    await seedUser(db, 'valet-alice', '6000');
    const mockApp: any = {
      octokit: {
        paginate: vi.fn(async () => [
          { id: 200, account: { login: 'alice', id: 6000, type: 'User' }, repository_selection: 'all', permissions: {} },
        ]),
      },
    };
    await refreshAllInstallations(mockApp, db);
    const row = await getGithubInstallationByLogin(db, 'alice');
    expect(row?.linkedUserId).toBe('valet-alice');
  });
});

describe('reconcileUserInstallations', () => {
  it('links orphaned personal install to user via GET /user/installations', async () => {
    const db = await createTestDb();
    await seedUser(db, 'valet-alice', '6000');
    // Seed orphaned install
    await upsertGithubInstallation(db, {
      githubInstallationId: '200',
      accountLogin: 'alice',
      accountId: '6000',
      accountType: 'User',
      repositorySelection: 'all',
    });
    // Mock user-token Octokit
    const mockUserOctokit: any = {
      paginate: vi.fn(async () => [
        { id: 200, account: { login: 'alice', id: 6000, type: 'User' }, repository_selection: 'all' },
      ]),
    };
    await reconcileUserInstallations(mockUserOctokit, db, 'valet-alice', '6000');
    const row = await getGithubInstallationByLogin(db, 'alice');
    expect(row?.linkedUserId).toBe('valet-alice');
  });

  it('does not link installations for a different github account', async () => {
    // valet-alice's github_id is 6000 but the install is for a different user (id 9999)
    // should NOT link
    const db = await createTestDb();
    await seedUser(db, 'valet-alice', '6000');
    await upsertGithubInstallation(db, {
      githubInstallationId: '300', accountLogin: 'bob', accountId: '9999', accountType: 'User', repositorySelection: 'all',
    });
    const mockUserOctokit: any = {
      paginate: vi.fn(async () => [
        { id: 300, account: { login: 'bob', id: 9999, type: 'User' }, repository_selection: 'all' },
      ]),
    };
    await reconcileUserInstallations(mockUserOctokit, db, 'valet-alice', '6000');
    const row = await getGithubInstallationByLogin(db, 'bob');
    expect(row?.linkedUserId).toBeNull(); // not linked
  });
});

describe('handleInstallationWebhook', () => {
  it('upserts on installation.created', async () => {
    const db = await createTestDb();
    await handleInstallationWebhook(db, {
      action: 'created',
      installation: {
        id: 500,
        account: { login: 'new-org', id: 7000, type: 'Organization' },
        repository_selection: 'all',
        permissions: { contents: 'write' },
      },
    });
    const row = await getGithubInstallationByLogin(db, 'new-org');
    expect(row).toBeTruthy();
  });

  it('marks installation.deleted as removed', async () => {
    const db = await createTestDb();
    await upsertGithubInstallation(db, {
      githubInstallationId: '500', accountLogin: 'new-org', accountId: '7000', accountType: 'Organization', repositorySelection: 'all',
    });
    await handleInstallationWebhook(db, {
      action: 'deleted',
      installation: { id: 500, account: { login: 'new-org', id: 7000, type: 'Organization' }, repository_selection: 'all', permissions: {} },
    });
    // After delete, row should still exist but status=removed
    const row = await db.select().from(githubInstallations)
      .where(eq(githubInstallations.githubInstallationId, '500')).get();
    expect(row?.status).toBe('removed');
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/worker && pnpm vitest run src/services/github-installations.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `github-installations.ts`**

Create `packages/worker/src/services/github-installations.ts`:

```typescript
import type { App, Octokit } from 'octokit';
import type { AppDb } from '../lib/drizzle.js';
import { eq } from 'drizzle-orm';
import { users } from '../lib/schema/users.js';
import {
  upsertGithubInstallation,
  updateGithubInstallationStatus,
  updateGithubInstallationAccountLogin,
  linkGithubInstallationToUser,
  getGithubInstallationById,
} from '../lib/db/github-installations.js';

/**
 * Refresh all installations from GitHub's API. Called by admin refresh action
 * and by the data migration script.
 *
 * Authenticates as the App (via JWT), paginates GET /app/installations,
 * upserts rows. For personal installations, auto-links by matching account_id
 * to users.github_id.
 */
export async function refreshAllInstallations(app: App, db: AppDb): Promise<{ count: number }> {
  const installations = await app.octokit.paginate('GET /app/installations', { per_page: 100 });
  let count = 0;

  for (const inst of installations) {
    let linkedUserId: string | undefined;

    if (inst.account && inst.account.type === 'User') {
      // Try to auto-link by GitHub account ID → users.github_id
      const accountId = String(inst.account.id);
      const user = await db.select({ id: users.id })
        .from(users)
        .where(eq(users.githubId, accountId))
        .get();
      if (user) linkedUserId = user.id;
    }

    await upsertGithubInstallation(db, {
      githubInstallationId: String(inst.id),
      accountLogin: inst.account?.login ?? 'unknown',
      accountId: String(inst.account?.id ?? ''),
      accountType: (inst.account?.type ?? 'Organization') as 'Organization' | 'User',
      repositorySelection: (inst.repository_selection ?? 'all') as 'all' | 'selected',
      permissions: inst.permissions as Record<string, unknown>,
      linkedUserId,
    });
    count++;
  }

  return { count };
}

/**
 * After a user completes OAuth, call GET /user/installations with their token
 * and link any matching personal installations to this Valet user.
 *
 * Only links installations where installation.account.id matches the user's
 * expected githubUserId (passed in explicitly, sourced from GET /user).
 */
export async function reconcileUserInstallations(
  userOctokit: Octokit,
  db: AppDb,
  valetUserId: string,
  expectedGithubUserId: string,
): Promise<{ linked: number }> {
  let linked = 0;
  const installations = await userOctokit.paginate(
    'GET /user/installations' as any,
    { per_page: 100 },
  );

  for (const inst of installations) {
    if (inst.account?.type !== 'User') continue;
    if (String(inst.account?.id) !== expectedGithubUserId) continue;

    // Ensure the row exists (upsert, in case webhook hasn't arrived yet)
    await upsertGithubInstallation(db, {
      githubInstallationId: String(inst.id),
      accountLogin: inst.account.login,
      accountId: String(inst.account.id),
      accountType: 'User',
      repositorySelection: (inst.repository_selection ?? 'all') as 'all' | 'selected',
      permissions: inst.permissions as Record<string, unknown>,
      linkedUserId: valetUserId,
    });
    linked++;
  }

  return { linked };
}

export interface InstallationWebhookPayload {
  action: 'created' | 'deleted' | 'suspend' | 'unsuspend' | 'new_permissions_accepted';
  installation: {
    id: number;
    account: { login: string; id: number; type: 'Organization' | 'User' };
    repository_selection: 'all' | 'selected';
    permissions: Record<string, unknown>;
  };
}

/**
 * Handle `installation.*` webhook events.
 */
export async function handleInstallationWebhook(
  db: AppDb,
  payload: InstallationWebhookPayload,
): Promise<void> {
  const { action, installation } = payload;
  const installationId = String(installation.id);

  if (action === 'created') {
    // Try auto-link by account_id for personal installs
    let linkedUserId: string | undefined;
    if (installation.account.type === 'User') {
      const accountId = String(installation.account.id);
      const user = await db.select({ id: users.id })
        .from(users)
        .where(eq(users.githubId, accountId))
        .get();
      if (user) linkedUserId = user.id;
    }
    await upsertGithubInstallation(db, {
      githubInstallationId: installationId,
      accountLogin: installation.account.login,
      accountId: String(installation.account.id),
      accountType: installation.account.type,
      repositorySelection: installation.repository_selection,
      permissions: installation.permissions,
      linkedUserId,
    });
    return;
  }

  if (action === 'deleted') {
    await updateGithubInstallationStatus(db, installationId, 'removed');
    return;
  }

  if (action === 'suspend') {
    await updateGithubInstallationStatus(db, installationId, 'suspended');
    return;
  }

  if (action === 'unsuspend') {
    await updateGithubInstallationStatus(db, installationId, 'active');
    return;
  }

  if (action === 'new_permissions_accepted') {
    // Update permissions field only; preserve other fields
    const existing = await getGithubInstallationById(db, installationId);
    if (existing) {
      await upsertGithubInstallation(db, {
        githubInstallationId: installationId,
        accountLogin: installation.account.login,
        accountId: String(installation.account.id),
        accountType: installation.account.type,
        repositorySelection: installation.repository_selection,
        permissions: installation.permissions,
      });
    }
    return;
  }
}

/**
 * Handle `installation_target.renamed` — updates account_login.
 */
export async function handleInstallationRenamedWebhook(
  db: AppDb,
  payload: { installation: { id: number }; account: { login: string } },
): Promise<void> {
  await updateGithubInstallationAccountLogin(
    db,
    String(payload.installation.id),
    payload.account.login,
  );
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/worker && pnpm vitest run src/services/github-installations.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/services/github-installations.ts \
        packages/worker/src/services/github-installations.test.ts
git commit -m "feat(github): add installation discovery and reconciliation service"
```

---

## Phase 2: Credential resolution rewrite

### Task 6: Update `services/github-config.ts` types

**Files:**
- Modify: `packages/worker/src/services/github-config.ts`

- [ ] **Step 1: Update `GitHubServiceConfig`**

Edit the type to remove classic OAuth fields and make App OAuth required:

```typescript
export interface GitHubServiceConfig {
  appId: string;
  appPrivateKey: string;
  appSlug: string;
  appWebhookSecret: string;
  appOauthClientId: string;
  appOauthClientSecret: string;
}
```

- [ ] **Step 2: Update `GitHubServiceMetadata`**

```typescript
export interface GitHubServiceMetadata {
  appOwner?: string;
  appOwnerType?: string;
  appName?: string;
  allowPersonalInstallations?: boolean;
  allowAnonymousGitHubAccess?: boolean;
}
```

- [ ] **Step 3: Update `GitHubConfig` (public-facing type)**

```typescript
export interface GitHubConfig {
  appId: string;
  appPrivateKey: string;
  appSlug: string;
  appWebhookSecret: string;
  appOauthClientId: string;
  appOauthClientSecret: string;
}
```

- [ ] **Step 4: Rewrite `getGitHubConfig`**

```typescript
export async function getGitHubConfig(env: Env, db: AppDb): Promise<GitHubConfig | null> {
  try {
    const svc = await getServiceConfig<GitHubServiceConfig, GitHubServiceMetadata>(
      db, env.ENCRYPTION_KEY, 'github',
    );
    if (!svc || !svc.config.appId || !svc.config.appOauthClientId) return null;
    return {
      appId: svc.config.appId,
      appPrivateKey: svc.config.appPrivateKey,
      appSlug: svc.config.appSlug,
      appWebhookSecret: svc.config.appWebhookSecret,
      appOauthClientId: svc.config.appOauthClientId,
      appOauthClientSecret: svc.config.appOauthClientSecret,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 5: Remove env var fallback**

The current `getGitHubConfig` falls back to env vars `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_APP_*`. Delete the entire env-var fallback branch — config must come from D1 only.

- [ ] **Step 6: Typecheck**

```bash
cd packages/worker && pnpm typecheck
```

Expected: **many callers will break** (admin-github.ts, github-me.ts, webhooks.ts, etc.). Record the error list — these callers will be fixed in subsequent tasks. DO NOT fix them in this task; leave the typecheck failing.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/services/github-config.ts
git commit -m "refactor(github): simplify GitHubServiceConfig to App-only fields

Drops classic oauthClientId/oauthClientSecret and env var fallback.
Callers (admin-github, github-me, webhooks, etc.) will be updated in
subsequent commits; typecheck intentionally broken during transition."
```

---

### Task 7: Update SDK `ActionContext` to include `attribution`

**Files:**
- Modify: `packages/sdk/src/integrations/index.ts` (or wherever `ActionContext` is defined — find it with grep)

- [ ] **Step 1: Locate the ActionContext type**

```bash
grep -rn "interface ActionContext\|type ActionContext" packages/sdk/src/
```

- [ ] **Step 2: Add the optional `attribution` field**

Add to `ActionContext`:

```typescript
export interface ActionContext {
  // ... existing fields ...
  /** Present when the credential is a bot token being used on behalf of a user. */
  attribution?: {
    name: string;
    email: string;
  };
}
```

- [ ] **Step 3: Build the SDK**

```bash
cd packages/sdk && pnpm typecheck
```

Expected: passes (additive change).

- [ ] **Step 4: Commit**

```bash
git add packages/sdk/src/
git commit -m "feat(sdk): add optional attribution field to ActionContext"
```

---

### Task 8: Add `attribution` to `CredentialResult` and revert `CredentialSourceInfo` plumbing in registry

**Files:**
- Modify: `packages/worker/src/integrations/registry.ts`
- Modify: `packages/worker/src/services/credentials.ts` (just the `CredentialResult` type)

- [ ] **Step 1: Add `attribution` to `ResolvedCredential`**

In `packages/worker/src/services/credentials.ts`, add the `attribution` field to the existing `ResolvedCredential` interface (NOT to `CredentialResult`, which wraps `ResolvedCredential`):

```typescript
export interface ResolvedCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes?: string[];
  credentialType: CredentialType;
  refreshed: boolean;
  /** Present when this credential is a bot token being used on behalf of a user. */
  attribution?: { name: string; email: string };
}
```

Do NOT modify the `CredentialResult` discriminated union — it already wraps `credential: ResolvedCredential` correctly.

- [ ] **Step 2: Simplify `CredentialResolverContext`**

In `packages/worker/src/integrations/registry.ts`, replace:

```typescript
export interface CredentialSourceInfo {
  scope: 'user' | 'org';
  integrationId: string;
  userId: string;
}

export interface CredentialResolverContext {
  params?: Record<string, unknown>;
  credentialSources: CredentialSourceInfo[];
  forceRefresh?: boolean;
  skipScope?: 'user' | 'org';
  accessibleOwners?: string[];
}
```

with:

```typescript
export interface CredentialResolverContext {
  params?: Record<string, unknown>;
  forceRefresh?: boolean;
}
```

Delete `CredentialSourceInfo` entirely.

- [ ] **Step 3: Typecheck**

```bash
cd packages/worker && pnpm typecheck
```

Expected: callers that pass `credentialSources` / `skipScope` / `accessibleOwners` now error. Record them — they'll be fixed in Tasks 9-11. Do NOT fix here.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/services/credentials.ts \
        packages/worker/src/integrations/registry.ts
git commit -m "refactor(integrations): simplify CredentialResolverContext, add attribution to CredentialResult"
```

---

### Task 9: Update `resolvers/default.ts` to new contract

**Files:**
- Modify: `packages/worker/src/integrations/resolvers/default.ts`

- [ ] **Step 1: Read current implementation**

```bash
cat packages/worker/src/integrations/resolvers/default.ts
```

- [ ] **Step 2: Rewrite to match simplified contract**

Remove any references to `credentialSources`, `skipScope`, `accessibleOwners`. The default resolver should simply call `getCredential(env, 'user', userId, service, { forceRefresh })`. Preserve any org-scope fallback logic that predates the multi-credential routing plan (e.g., if the original pre-multi-cred version tried both user and org, restore that behavior).

Reference the git log to see the pre-multi-credential version:

```bash
git log --all --follow -p packages/worker/src/integrations/resolvers/default.ts
```

- [ ] **Step 3: Typecheck**

```bash
cd packages/worker && pnpm typecheck
```

Expected: `default.ts` compiles clean. Other files may still have errors.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/integrations/resolvers/default.ts
git commit -m "refactor(integrations): revert default resolver to pre-multi-cred shape"
```

---

### Task 10: Rewrite `integrations/resolvers/github.ts` with new chain (TDD)

**Files:**
- Modify: `packages/worker/src/integrations/resolvers/github.ts`
- Create: `packages/worker/src/integrations/resolvers/github.test.ts`

- [ ] **Step 1: Write failing tests**

Create `packages/worker/src/integrations/resolvers/github.test.ts`:

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { githubCredentialResolver } from './github.js';
import { createTestDb } from '../../lib/test-utils.js';

// Mocks
vi.mock('../../services/credentials.js');
vi.mock('../../services/github-app.js');

describe('githubCredentialResolver', () => {
  let mockEnv: any;
  let mockDb: any;

  beforeEach(async () => {
    mockDb = await createTestDb();
    mockEnv = {
      DB: {} as any,
      ENCRYPTION_KEY: 'test-encryption-key',
    };
  });

  it('returns user access token when user has linked GitHub', async () => {
    const { getCredential } = await import('../../services/credentials.js');
    (getCredential as any).mockResolvedValue({
      ok: true,
      credential: {
        accessToken: 'ghu_user_token',
        credentialType: 'oauth2',
        refreshed: false,
      },
    });

    const result = await githubCredentialResolver('github', mockEnv, 'valet-user-1', {});
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credential.accessToken).toBe('ghu_user_token');
      expect(result.credential.attribution).toBeUndefined(); // user tokens don't need attribution
    }
  });

  it('falls back to org installation bot token when user not linked, anonymous allowed', async () => {
    const { getCredential } = await import('../../services/credentials.js');
    (getCredential as any).mockResolvedValueOnce({
      ok: false, error: { service: 'github', reason: 'not_found', message: '' },
    });

    // Seed org install and anonymous-access metadata
    await upsertGithubInstallation(mockDb, {
      githubInstallationId: '100',
      accountLogin: 'acme',
      accountId: '5000',
      accountType: 'Organization',
      repositorySelection: 'all',
    });
    // Seed allowAnonymousGitHubAccess = true in metadata (use setServiceConfig helper)
    // Seed user with name + email (use seedUser helper)

    const { loadGitHubApp, getOrMintInstallationToken } = await import('../../services/github-app.js');
    (loadGitHubApp as any).mockResolvedValue({ /* mock app */ });
    (getOrMintInstallationToken as any).mockResolvedValue({
      token: 'ghs_install_token',
      expiresAt: Date.now() + 3600_000,
    });

    const result = await githubCredentialResolver('github', mockEnv, 'valet-user-1', {
      params: { owner: 'acme' },
    });

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.credential.accessToken).toBe('ghs_install_token');
      expect(result.credential.credentialType).toBe('app_install');
      expect(result.credential.attribution).toBeDefined();
      expect(result.credential.attribution?.email).toBeTruthy();
    }
  });

  it('fails when repo owner is specified but no matching installation exists', async () => {
    // per B3 fix: owner specified + no match → fail, NOT fall through to any-installation
    const { getCredential } = await import('../../services/credentials.js');
    (getCredential as any).mockResolvedValueOnce({
      ok: false, error: { service: 'github', reason: 'not_found', message: '' },
    });
    // Seed allowAnonymousGitHubAccess = true + load App
    // Seed an org installation for a DIFFERENT owner
    await upsertGithubInstallation(mockDb, {
      githubInstallationId: '100',
      accountLogin: 'other-org',
      accountId: '5000',
      accountType: 'Organization',
      repositorySelection: 'all',
    });

    const result = await githubCredentialResolver('github', mockEnv, 'valet-user-1', {
      params: { owner: 'acme' }, // no installation for 'acme'
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/owner "acme"/);
    }
  });

  it('fails when user not linked and anonymous access disabled', async () => {
    const { getCredential } = await import('../../services/credentials.js');
    (getCredential as any).mockResolvedValueOnce({
      ok: false, error: { service: 'github', reason: 'not_found', message: '' },
    });
    // Seed metadata with allowAnonymousGitHubAccess = false

    const result = await githubCredentialResolver('github', mockEnv, 'valet-user-1', {});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.message).toMatch(/not connected/i);
    }
  });

  it('fails when no installation matches repo owner', async () => {
    // user not linked, anonymous allowed, but no matching installation
    // → should fail
  });

  it('falls back to any available org installation for no-repo-context actions', async () => {
    // user not linked, no repo owner in params, but an org install exists → use it
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/worker && pnpm vitest run src/integrations/resolvers/github.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Rewrite the resolver**

Replace the contents of `packages/worker/src/integrations/resolvers/github.ts`:

```typescript
import { getCredential } from '../../services/credentials.js';
import { getDb } from '../../lib/drizzle.js';
import { getServiceMetadata } from '../../lib/db/service-configs.js';
import { eq } from 'drizzle-orm';
import { users } from '../../lib/schema/users.js';
import {
  getGithubInstallationByLogin,
  listGithubInstallationsByAccountType,
} from '../../lib/db/github-installations.js';
import { loadGitHubApp, getOrMintInstallationToken } from '../../services/github-app.js';
import type { CredentialResolver } from '../registry.js';
import type { CredentialResult } from '../../services/credentials.js';
import type { GitHubServiceMetadata } from '../../services/github-config.js';

/**
 * GitHub credential resolver — unified GitHub App model.
 *
 * Resolution chain:
 *   1. User has linked GitHub (oauth2 credential) → return user token
 *   2. If anonymous access disabled → fail
 *   3. If repo owner specified: match an active installation by owner
 *      → mint bot token + attribution. If owner doesn't match any installation → fail.
 *   4. If no repo owner specified: use any active org installation
 *      (prefer Organization over User) → mint bot token + attribution
 *   5. No installation available → fail
 *
 * IMPORTANT: step 3 and step 4 are mutually exclusive based on whether owner is
 * specified. An unmatched owner does NOT fall through to step 4 — that would let
 * actions against unrelated repos silently use an unrelated installation's token.
 */
export const githubCredentialResolver: CredentialResolver = async (
  service,
  env,
  userId,
  context,
) => {
  const { params, forceRefresh } = context;

  // Step 1: user access token
  const userCred = await getCredential(env, 'user', userId, service, { forceRefresh });
  if (userCred.ok) return userCred;

  // Step 2: anonymous access allowed?
  // Default: deny when metadata is missing or flag is absent. The admin UI seeds
  // metadata.allowAnonymousGitHubAccess=true on fresh App creation, so existing
  // installations will have it set explicitly. Missing metadata = unconfigured =
  // fail safe.
  const db = getDb(env.DB);
  const meta = await getServiceMetadata<GitHubServiceMetadata>(db, 'github');
  if (!meta?.allowAnonymousGitHubAccess) {
    return {
      ok: false,
      error: {
        service,
        reason: 'not_found',
        message: 'GitHub account not connected. Connect GitHub in Settings > Integrations.',
      },
    };
  }

  // Load the GitHub App (required for bot tokens)
  const app = await loadGitHubApp(env, db);
  if (!app) {
    return {
      ok: false,
      error: { service, reason: 'not_found', message: 'GitHub App is not configured.' },
    };
  }

  // Resolve installation based on whether a repo owner was specified
  const owner = typeof params?.owner === 'string' ? params.owner : undefined;
  let installation;

  if (owner) {
    // Step 3: strict owner match. If no match → fail (do NOT fall through to any-installation).
    installation = await getGithubInstallationByLogin(db, owner);
    if (!installation) {
      return {
        ok: false,
        error: {
          service,
          reason: 'not_found',
          message: `No GitHub installation available for owner "${owner}".`,
        },
      };
    }
  } else {
    // Step 4: no owner specified (e.g., list_repos) → prefer org installations
    const orgInstalls = await listGithubInstallationsByAccountType(db, 'Organization');
    installation = orgInstalls.find((i) => i.status === 'active');
    if (!installation) {
      return {
        ok: false,
        error: { service, reason: 'not_found', message: 'No GitHub installation available.' },
      };
    }
  }

  // Get a cached or freshly-minted installation token (D1-backed cache)
  try {
    const { token, expiresAt } = await getOrMintInstallationToken(
      app, db, env.ENCRYPTION_KEY, installation,
    );

    // Fetch attribution for the Valet user
    const user = await db.select({ name: users.name, email: users.email })
      .from(users).where(eq(users.id, userId)).get();

    return {
      ok: true,
      credential: {
        accessToken: token,
        expiresAt: new Date(expiresAt),
        credentialType: 'app_install',
        refreshed: false,
        attribution: user ? { name: user.name ?? 'Unknown', email: user.email } : undefined,
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: {
        service,
        reason: 'refresh_failed',
        message: `Failed to mint installation token: ${err instanceof Error ? err.message : String(err)}`,
      },
    };
  }
};
```

**Note**: the returned `CredentialResult` uses the nested `{ ok: true, credential: {...} }` shape matching the existing `ResolvedCredential` type. Attribution lives on `ResolvedCredential`, not flat on `CredentialResult`.

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/worker && pnpm vitest run src/integrations/resolvers/github.test.ts
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/integrations/resolvers/github.ts \
        packages/worker/src/integrations/resolvers/github.test.ts
git commit -m "refactor(github): rewrite credential resolver for unified App model"
```

---

### Task 11: Update `services/credentials.ts` for Octokit-based refresh

**Files:**
- Modify: `packages/worker/src/services/credentials.ts`

**Reference points from the actual file** (verified during plan writing):
- Line 11: `CredentialType` union includes `'app_install'` — this stays for now (removed in a later cleanup once all callers are fixed); it's the runtime data we're eliminating.
- Lines 138-156: `attemptRefresh` has a switch on provider. The current `case 'github'` returns an error ("GitHub tokens do not support refresh"). This is what gets replaced.
- Lines 283, 324, 344: references to `app_install` in the credential row reading path. These read app_install rows and return them via `ResolvedCredential` with special handling. All of this is removed.
- The refresh function writes a new row via `credentialDb.upsertCredential(db, {...})` and returns a wrapped `{ ok: true, credential: ResolvedCredential }` — NOT a flat object.

- [ ] **Step 1: Replace the `case 'github':` in `attemptRefresh`**

Find the switch statement around line 146 and replace the GitHub case:

```typescript
case 'github':
  return refreshGitHubToken(env, ownerType, ownerId, provider, data);
```

- [ ] **Step 2: Add the `refreshGitHubToken` helper**

Add near the other refresh helpers (e.g., after `refreshGoogleToken`):

```typescript
import { loadGitHubApp } from './github-app.js';

async function refreshGitHubToken(
  env: Env,
  ownerType: string,
  ownerId: string,
  provider: string,
  data: CredentialData,
): Promise<CredentialResult> {
  if (!data.refresh_token) {
    return {
      ok: false,
      error: { service: provider, reason: 'refresh_failed', message: 'No refresh token available' },
    };
  }

  const db = getDb(env.DB);
  const app = await loadGitHubApp(env, db);
  if (!app) {
    return {
      ok: false,
      error: { service: provider, reason: 'refresh_failed', message: 'GitHub App not configured' },
    };
  }

  try {
    const { authentication } = await app.oauth.refreshToken({
      refreshToken: data.refresh_token,
    });

    const newData: CredentialData = {
      access_token: authentication.token,
      refresh_token: authentication.refreshToken,
    };
    const expiresAt = authentication.expiresAt; // ISO string from Octokit
    const encrypted = await encryptCredentialData(newData, env.ENCRYPTION_KEY);

    await credentialDb.upsertCredential(db, {
      id: crypto.randomUUID(),
      ownerType,
      ownerId,
      provider,
      credentialType: 'oauth2',
      encryptedData: encrypted,
      expiresAt,
    });

    return {
      ok: true,
      credential: {
        accessToken: authentication.token,
        refreshToken: authentication.refreshToken,
        expiresAt: expiresAt ? new Date(expiresAt) : undefined,
        credentialType: 'oauth2',
        refreshed: true,
      },
    };
  } catch (err) {
    // Refresh failed — delete credential row so the user is forced to reconnect
    await credentialDb.deleteCredential(db, ownerType, ownerId, provider, 'oauth2');
    return {
      ok: false,
      error: {
        service: provider,
        reason: 'refresh_failed',
        message: 'GitHub connection expired, please reconnect',
      },
    };
  }
}
```

- [ ] **Step 3: Remove `app_install` handling from the credential read path**

Around line 283, there's a comment about "app_install rows for integration calls". Remove any branch that reads or returns app_install credentials. Delete the dead code at lines 324 and 344 referenced above — the resolver mints installation tokens on-demand, never stores them.

Specifically:
- In `getCredential`, when filtering rows, drop any `credentialType === 'app_install'` special-casing.
- Remove any code that constructs a `ResolvedCredential` with `credentialType: 'app_install'` from a stored row.

- [ ] **Step 4: Keep `'app_install'` in the `CredentialType` union for now**

Do NOT remove `'app_install'` from the `CredentialType` union in this task. The resolver in Task 10 constructs a `ResolvedCredential` with `credentialType: 'app_install'` for bot tokens it mints on-demand — this is the single remaining valid use. The union stays; only the stored-row handling goes away.

- [ ] **Step 5: Typecheck and run existing tests**

```bash
cd packages/worker && pnpm typecheck
cd packages/worker && pnpm vitest run src/services/credentials.test.ts
```

Expected: existing tests pass (or fail only for `app_install` cases, which should be removed from the test file).

- [ ] **Step 6: Remove `app_install` tests from `credentials.test.ts`**

Delete any test cases that assert `app_install` credentials can be stored/refreshed/retrieved.

- [ ] **Step 7: Commit**

```bash
git add packages/worker/src/services/credentials.ts \
        packages/worker/src/services/credentials.test.ts
git commit -m "refactor(credentials): use Octokit for GitHub user token refresh, drop app_install handling"
```

---

### Task 12: Revert `session-tools.ts` and `session-agent.ts` credential plumbing

**Files:**
- Modify: `packages/worker/src/services/session-tools.ts`
- Modify: `packages/worker/src/durable-objects/session-agent.ts`

This is the biggest mechanical revert. The multi-credential routing plan added `credentialSources[]` arrays, `skipScope` fallthrough retry, `accessibleOwners` cache, and a `credentialType` dimension to `CredentialCache`. All of it needs to come out.

- [ ] **Step 1: Read `session-tools.ts`**

```bash
cat packages/worker/src/services/session-tools.ts
```

Identify every function that touches `credentialSources`, `skipScope`, or `CredentialSourceInfo`.

- [ ] **Step 2: Revert `resolveActionPolicy`**

Change its return type to remove `credentialSources: CredentialSourceInfo[]`. It should return whatever it returned before the multi-credential routing plan — probably a simpler boolean or nothing related to credentials (credentials are resolved per-action in `executeAction`).

Check git history for the pre-plan version:

```bash
git log --all --follow -p packages/worker/src/services/session-tools.ts | head -500
```

- [ ] **Step 3: Revert `executeAction`**

Remove the fallthrough retry loop (try alt scope on 401/403). Keep only the "force-refresh on first failure, retry once" behavior that existed before the multi-credential plan.

After resolving the credential via `integrationRegistry.resolveCredentials(service, env, userId, { params, forceRefresh })`, thread `result.attribution` into the `ActionContext` passed to the action:

```typescript
const actionContext: ActionContext = {
  credentials: { access_token: result.accessToken, _credential_type: result.credentialType },
  userId,
  attribution: result.attribution, // NEW
  // ... other existing fields
};
```

- [ ] **Step 4: Revert `listTools`**

If `listTools` uses `credentialSources` grouping, revert to its pre-plan shape. Reference git history.

- [ ] **Step 5: Revert `session-agent.ts` CredentialCache adapter**

Find the `credentialCacheAdapter`. It currently has a `credentialType` param on `get` / `set` / `invalidate`. Remove the param:

```typescript
// Before:
get(ownerType, ownerId, service, credentialType?) { ... }
// After:
get(ownerType, ownerId, service) { ... }
```

- [ ] **Step 6: Remove `accessibleOwners` cache from session-agent**

Delete any cache or state related to `accessibleOwners`. Delete the `accessibleOwners` field from `CredentialResolverContext` calls (already gone from the type after Task 8).

- [ ] **Step 7: Remove approval-context backward-compat shim + invalidate stale approvals**

Location: `packages/worker/src/durable-objects/session-agent.ts` lines ~5654-5658 contain a shim:

```typescript
// Backward compat: approvals created before multi-credential routing stored isOrgScoped: boolean.
let credentialSources: CredentialSourceInfo[] = context.credentialSources as CredentialSourceInfo[] ?? [];
if (credentialSources.length === 0 && 'isOrgScoped' in context) {
  credentialSources = [{ scope: context.isOrgScoped ? 'org' : 'user', integrationId: '', userId }];
}
```

Remove this entire shim. The approval-resume path must use whatever shape the reverted `executeAction` expects (no `credentialSources` at all — credentials are resolved fresh on resume by calling `integrationRegistry.resolveCredentials` with the original `params`).

**Handling in-flight approvals**: pending approvals persisted in D1 with the old shape will fail to resume cleanly after deploy. Options:
- (a) **Invalidate on resume**: if the approval context has `credentialSources` or `isOrgScoped` fields, treat the approval as stale — return an error to the user asking them to re-run the action. This is simple and safe; any approval older than the deploy is discarded.
- (b) **Write a one-shot cleanup query** at deploy time that deletes all pending approvals.

**Decision**: use (a). Add a check at the top of the approval-resume path:

```typescript
// After reverting the shim, add:
if ('credentialSources' in context || 'isOrgScoped' in context) {
  // Approval was created before the unified-auth migration; credentials are
  // now resolved fresh at execution time. The old context is not usable.
  await this.sendMessage(/* "This approval is stale (created before a recent
    system update). Please re-run the action." */);
  return;
}
```

The exact error-surfacing mechanism should match the existing pattern in `session-agent.ts` for rejecting an approval.

- [ ] **Step 8: Typecheck**

```bash
cd packages/worker && pnpm typecheck
```

Expected: much closer to passing. Remaining errors should be in admin-github.ts, github-me.ts, webhooks.ts (Phase 3).

- [ ] **Step 9: Commit**

```bash
git add packages/worker/src/services/session-tools.ts \
        packages/worker/src/durable-objects/session-agent.ts
git commit -m "refactor(session): revert multi-credential routing plumbing

Reverts credentialSources[] arrays, skipScope fallthrough,
credentialType cache dimension, and accessibleOwners cache.
Threads attribution field through ActionContext to actions."
```

---

## Phase 3: Admin routes rewrite

### Task 13: Rewrite `routes/admin-github.ts` — remove classic OAuth, add installations

**Files:**
- Modify: `packages/worker/src/routes/admin-github.ts`

This is a large rewrite. Break it into sub-steps.

- [ ] **Step 1: Delete classic OAuth endpoints**

Remove:
- `PUT /api/admin/github/oauth` (store classic OAuth credentials)
- `DELETE /api/admin/github/oauth-credentials` (delete classic OAuth only)

Keep the App manifest endpoints and the overall router structure.

- [ ] **Step 2: Update `GET /api/admin/github` response shape**

Remove every read of `c.env.GITHUB_CLIENT_ID` / `c.env.GITHUB_CLIENT_SECRET` from this handler (they are still declared on the `Env` interface and will be removed in Task 26; but the handler must not reference them anymore, because Task 6 already removed the env-var fallback from `getGitHubConfig`, and Task 26 will break compilation on any remaining reference).

Return exactly this shape (used by Task 14 hooks and Task 23 UI):

```typescript
{
  appStatus: 'not_configured' | 'configured',
  app: {
    appId: string,
    appSlug: string,
    appOwner: string,
    appOwnerType: string,
    appName: string,
  } | null,
  settings: {
    allowPersonalInstallations: boolean,
    allowAnonymousGitHubAccess: boolean,
  },
  installations: {
    organizations: GithubInstallation[],
    personal: GithubInstallation[],  // only those with linked_user_id
    orphaned: GithubInstallation[],   // personal installs with linked_user_id IS NULL
  },
}
```

Populate `installations` via `listGithubInstallationsByAccountType(db, 'Organization')` + splitting `listGithubInstallationsByAccountType(db, 'User')` based on `linkedUserId`.

**Important for Task 23 alignment**: `settings` is a nested object. The client UI component (Task 23) reads `config?.settings?.allowPersonalInstallations` — this shape MUST match. Do not flatten `allowPersonalInstallations` to the top level.

- [ ] **Step 3: Update `POST /api/admin/github/app/manifest`**

Change the default permissions in the manifest to match the spec exactly. Set `request_oauth_on_install: false` (was previously `true` or absent). Set `public: true`. `callback_urls` must include `{workerUrl}/auth/github/callback`.

- [ ] **Step 4: Rewrite `GET /github/app/setup` (manifest callback)**

After exchanging the manifest code, the response includes `id`, `pem`, `webhook_secret`, `client_id`, `client_secret`. Store these in the new `GitHubServiceConfig` shape:

```typescript
await setServiceConfig(db, env.ENCRYPTION_KEY, 'github', {
  config: {
    appId: String(data.id),
    appPrivateKey: data.pem,
    appSlug: data.slug,
    appWebhookSecret: data.webhook_secret,
    appOauthClientId: data.client_id,
    appOauthClientSecret: data.client_secret,
  },
  metadata: {
    appOwner: data.owner?.login,
    appOwnerType: data.owner?.type,
    appName: data.name,
    allowPersonalInstallations: true,
    allowAnonymousGitHubAccess: true,
  },
});
```

Remove all previous storage of `oauthClientId` / `oauthClientSecret` separately.

- [ ] **Step 5: Rewrite `POST /api/admin/github/app/refresh`**

Replace the hand-rolled JWT minting + single-installation enforcement + `storeCredential(app_install)` with:

```typescript
const app = await loadGitHubApp(c.env, db);
if (!app) return c.json({ error: 'App not configured' }, 400);
const { count } = await refreshAllInstallations(app, db);
return c.json({ refreshed: true, installationCount: count });
```

Rate-limit to 1 per minute. In a Cloudflare Worker, module-level `let` is not guaranteed to persist across requests (new isolates may be spawned), so this is best-effort. For a single-tenant admin action at small scale that's acceptable — the worst case is an admin getting 2 refreshes through in a single minute instead of 1.

```typescript
// Best-effort in-memory rate limit. Not a strict guarantee across isolates,
// but adequate for a single-tenant admin action.
const REFRESH_RATE_LIMIT_MS = 60_000;
let lastRefreshAt = 0;

// In the handler:
const now = Date.now();
if (now - lastRefreshAt < REFRESH_RATE_LIMIT_MS) {
  return c.json({ error: 'rate_limited', retryAfter: Math.ceil((REFRESH_RATE_LIMIT_MS - (now - lastRefreshAt)) / 1000) }, 429);
}
lastRefreshAt = now;
```

- [ ] **Step 6: Add new endpoints**

```typescript
// PUT /api/admin/github/settings — toggle allowPersonalInstallations / allowAnonymousGitHubAccess
adminGithubRouter.put('/settings', async (c) => {
  const body = await c.req.json<{ allowPersonalInstallations?: boolean; allowAnonymousGitHubAccess?: boolean }>();
  const meta = await getGitHubMetadata(c.get('db')) ?? {};
  const updated = {
    ...meta,
    ...(body.allowPersonalInstallations !== undefined && { allowPersonalInstallations: body.allowPersonalInstallations }),
    ...(body.allowAnonymousGitHubAccess !== undefined && { allowAnonymousGitHubAccess: body.allowAnonymousGitHubAccess }),
  };
  await updateServiceMetadata(c.get('db'), 'github', updated);
  return c.json({ success: true, settings: updated });
});

// GET /api/admin/github/installations — detailed installations list
adminGithubRouter.get('/installations', async (c) => {
  const db = c.get('db');
  const orgs = await listGithubInstallationsByAccountType(db, 'Organization');
  const personal = await listGithubInstallationsByAccountType(db, 'User');
  const linkedUsers = await /* batch-fetch users for personal.linkedUserId values */;
  return c.json({
    organizations: orgs,
    personal: personal.filter(p => p.linkedUserId),
    orphaned: personal.filter(p => !p.linkedUserId),
    linkedUsers,
  });
});
```

- [ ] **Step 7: Rewrite `DELETE /api/admin/github` (danger zone)**

Replace the current delete-config endpoint with one that:
1. Deletes all `github_installations` rows (or marks as removed)
2. Deletes all `credentials` rows where `provider = 'github'`
3. Deletes the `org_service_configs` row for `service = 'github'`
4. Does NOT call `app.oauth.deleteToken` for each user (per spec decision)

- [ ] **Step 8: Typecheck**

```bash
cd packages/worker && pnpm typecheck
```

Expected: admin-github.ts is now clean.

- [ ] **Step 9: Commit**

```bash
git add packages/worker/src/routes/admin-github.ts
git commit -m "refactor(admin-github): rewrite for unified GitHub App model

- Remove classic OAuth endpoints (PUT /oauth, DELETE /oauth-credentials)
- Update GET / response to include installations sections + toggles
- Rewrite manifest flow to match new GitHubServiceConfig shape
- Rewrite refresh endpoint using loadGitHubApp + refreshAllInstallations
- Add PUT /settings for toggles
- Add GET /installations for detailed list
- Rewrite danger-zone delete to clear installations and credentials"
```

---

### Task 14: Update admin-github API client hooks

**Files:**
- Modify: `packages/client/src/api/admin-github.ts`

- [ ] **Step 1: Remove classic OAuth hooks**

Delete `useSetGitHubOAuth`, `useDeleteGitHubOAuth` (the one that deletes only OAuth credentials).

- [ ] **Step 2: Update `useAdminGitHubConfig` response type**

Update the types to match the new `GET /api/admin/github` response (installations sections, toggles).

- [ ] **Step 3: Add new hooks**

```typescript
export function useUpdateGitHubSettings() {
  return useMutation({
    mutationFn: async (settings: { allowPersonalInstallations?: boolean; allowAnonymousGitHubAccess?: boolean }) => {
      const res = await apiClient('/admin/github/settings', { method: 'PUT', body: JSON.stringify(settings) });
      return res.json();
    },
    // invalidate config query
  });
}

export function useGitHubInstallations() {
  return useQuery({
    queryKey: ['admin-github', 'installations'],
    queryFn: async () => {
      const res = await apiClient('/admin/github/installations');
      return res.json();
    },
  });
}
```

- [ ] **Step 4: Typecheck**

```bash
cd packages/client && pnpm typecheck
```

Expected: `github-config.tsx` will break — that's Task 22. Record errors, commit this.

- [ ] **Step 5: Commit**

```bash
git add packages/client/src/api/admin-github.ts
git commit -m "refactor(client): update admin-github API hooks for unified App model"
```

---

## Phase 4: GitHub auth router (login + link)

### Task 15: Create `routes/github-auth.ts` (TDD)

**Files:**
- Create: `packages/worker/src/routes/github-auth.ts`
- Create: `packages/worker/src/routes/github-auth.test.ts`
- Modify: `packages/worker/src/index.ts` (mount the router before `oauthRouter`)

- [ ] **Step 1: Write failing tests**

Create `packages/worker/src/routes/github-auth.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Hono } from 'hono';
import { githubAuthRouter } from './github-auth.js';

vi.mock('../services/github-app.js');
vi.mock('../services/oauth.js');

describe('githubAuthRouter', () => {
  it('GET / redirects to GitHub authorize URL', async () => {
    const { loadGitHubApp } = await import('../services/github-app.js');
    (loadGitHubApp as any).mockResolvedValue({
      oauth: {
        getWebFlowAuthorizationUrl: vi.fn(() => ({ url: 'https://github.com/login/oauth/authorize?client_id=test' })),
      },
    });

    const app = new Hono();
    app.route('/auth/github', githubAuthRouter);
    const res = await app.request('/auth/github', { method: 'GET' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toContain('github.com/login/oauth/authorize');
  });

  it('GET /callback with github-link purpose handles link flow', async () => {
    // Setup: state JWT with purpose='github-link'
    // Mock app.oauth.createToken
    // Verify credential is stored
  });

  it('GET /callback with login purpose handles login flow', async () => {
    // Setup: state JWT without github-link purpose
    // Mock app.oauth.createToken
    // Verify finalizeIdentityLogin is called
  });

  it('GET /callback rejects invalid state JWT', async () => {
    const app = new Hono();
    app.route('/auth/github', githubAuthRouter);
    const res = await app.request('/auth/github/callback?code=abc&state=invalid', { method: 'GET' });
    expect(res.status).toBe(302);
    expect(res.headers.get('location')).toMatch(/error=invalid_state/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/worker && pnpm vitest run src/routes/github-auth.test.ts
```

Expected: FAIL.

- [ ] **Step 3: Implement `github-auth.ts`**

Create `packages/worker/src/routes/github-auth.ts`:

```typescript
import { Hono } from 'hono';
import { eq } from 'drizzle-orm';
import type { Env, Variables } from '../env.js';
import { signJWT, verifyJWT } from '../lib/jwt.js';
import { loadGitHubApp } from '../services/github-app.js';
import { storeCredential } from '../services/credentials.js';
import { finalizeIdentityLogin } from '../services/oauth.js';
import { reconcileUserInstallations } from '../services/github-installations.js';
import { users } from '../lib/schema/users.js';
import * as db from '../lib/db.js';
import { getDb } from '../lib/drizzle.js';
import { Octokit } from 'octokit';

export const githubAuthRouter = new Hono<{ Bindings: Env; Variables: Variables }>();

const LOGIN_STATE_TTL_SECONDS = 5 * 60;

function getFrontendUrl(env: Env): string {
  return env.FRONTEND_URL || 'http://localhost:5173';
}

function getWorkerUrl(req: Request): string {
  const url = new URL(req.url);
  return `${url.protocol}//${url.host}`;
}

// GET /auth/github — login initiation
githubAuthRouter.get('/', async (c) => {
  const frontendUrl = getFrontendUrl(c.env);
  const app = await loadGitHubApp(c.env, getDb(c.env.DB));
  if (!app) return c.redirect(`${frontendUrl}/login?error=github_not_configured`);

  const inviteCode = c.req.query('invite_code');
  const now = Math.floor(Date.now() / 1000);
  const state = await signJWT(
    { sub: 'github', sid: crypto.randomUUID(), iat: now, exp: now + LOGIN_STATE_TTL_SECONDS, invite_code: inviteCode } as any,
    c.env.ENCRYPTION_KEY,
  );

  const { url } = app.oauth.getWebFlowAuthorizationUrl({
    state,
    redirectUrl: `${getWorkerUrl(c.req.raw)}/auth/github/callback`,
  });

  return c.redirect(url);
});

// GET /auth/github/callback — handles both login and link
githubAuthRouter.get('/callback', async (c) => {
  const frontendUrl = getFrontendUrl(c.env);
  const code = c.req.query('code');
  const stateParam = c.req.query('state');

  if (!code || !stateParam) {
    return c.redirect(`${frontendUrl}/login?error=missing_params`);
  }

  const payload = await verifyJWT(stateParam, c.env.ENCRYPTION_KEY);
  if (!payload) return c.redirect(`${frontendUrl}/login?error=invalid_state`);

  const app = await loadGitHubApp(c.env, getDb(c.env.DB));
  if (!app) return c.redirect(`${frontendUrl}/login?error=github_not_configured`);

  // Exchange code for user access token via Octokit
  let authentication;
  try {
    const result = await app.oauth.createToken({ code });
    authentication = result.authentication;
  } catch (err) {
    console.error('GitHub OAuth token exchange failed:', err);
    return c.redirect(`${frontendUrl}/login?error=token_exchange_failed`);
  }

  // Fetch user profile
  const userOctokit = new Octokit({ auth: authentication.token });
  const { data: profile } = await userOctokit.request('GET /user');
  let email: string | null = profile.email;
  if (!email) {
    const { data: emails } = await userOctokit.request('GET /user/emails');
    email = emails.find((e: any) => e.primary && e.verified)?.email ?? null;
  }
  if (!email) return c.redirect(`${frontendUrl}/login?error=no_email`);

  const githubId = String(profile.id);
  const githubLogin = profile.login;
  const appDb = getDb(c.env.DB);

  // Branch: link vs login
  if ((payload as any).purpose === 'github-link') {
    const valetUserId = (payload as any).sub as string;

    // Check for account collision with a different Valet user
    const existingUser = await appDb.select({ id: users.id })
      .from(users).where(eq(users.githubId, githubId)).get();
    if (existingUser && existingUser.id !== valetUserId) {
      return c.redirect(`${frontendUrl}/integrations?github=error&reason=account_already_linked`);
    }

    // Store credential
    await storeCredential(c.env, 'user', valetUserId, 'github', {
      access_token: authentication.token,
      refresh_token: authentication.refreshToken,
    }, {
      credentialType: 'oauth2',
      expiresAt: authentication.expiresAt,
      metadata: { github_login: githubLogin, github_user_id: githubId },
    });

    // Update user record
    await db.updateUserGitHub(appDb, valetUserId, {
      githubId,
      githubUsername: githubLogin,
      name: profile.name ?? undefined,
      avatarUrl: profile.avatar_url,
    });

    // Create/update identity link
    await db.deleteIdentityLinkByExternalId(appDb, 'github', githubId);
    await db.createIdentityLink(appDb, {
      id: crypto.randomUUID(),
      userId: valetUserId,
      provider: 'github',
      externalId: githubId,
      externalName: githubLogin,
    });

    // Ensure integration row
    await db.ensureIntegration(appDb, valetUserId, 'github');

    // Reconcile installations
    await reconcileUserInstallations(userOctokit, appDb, valetUserId, githubId);

    return c.redirect(`${frontendUrl}/integrations?github=linked`);
  }

  // Login flow
  try {
    const result = await finalizeIdentityLogin(
      c.env,
      {
        externalId: githubId,
        email,
        name: profile.name || profile.login,
        avatarUrl: profile.avatar_url,
        username: profile.login,
        accessToken: authentication.token,
        scopes: '', // App OAuth uses permissions, not scopes
      },
      'github',
      (payload as any).invite_code,
    );

    if (!result.ok) {
      return c.redirect(`${frontendUrl}/login?error=${result.error}`);
    }

    // finalizeIdentityLogin returns { ok: true; sessionToken: string } — no userId.
    // Look up the user by email (the login just created or matched the user by email).
    const user = await db.findUserByEmail(appDb, email);
    if (!user) {
      console.error('GitHub login: user not found after finalizeIdentityLogin', { email });
      return c.redirect(`${frontendUrl}/login?error=login_failed`);
    }

    // Also store the token as an integration credential so the user's
    // login implicitly links the integration (single-click UX).
    await storeCredential(c.env, 'user', user.id, 'github', {
      access_token: authentication.token,
      refresh_token: authentication.refreshToken,
    }, {
      credentialType: 'oauth2',
      expiresAt: authentication.expiresAt,
      metadata: { github_login: githubLogin, github_user_id: githubId },
    });
    await db.ensureIntegration(appDb, user.id, 'github');
    await reconcileUserInstallations(userOctokit, appDb, user.id, githubId);

    return c.redirect(
      `${frontendUrl}/auth/callback?token=${encodeURIComponent(result.sessionToken)}&provider=github`,
    );
  } catch (err) {
    console.error('GitHub login error:', err);
    return c.redirect(`${frontendUrl}/login?error=login_failed`);
  }
});
```

**Confirmed signatures** (checked during plan writing):
- `finalizeIdentityLogin(env, identity, providerId, inviteCode?)` returns `{ ok: true; sessionToken: string } | { ok: false; error: string }` — NO userId field.
- After login, fetch the user via `db.findUserByEmail(appDb, email)` to get the id.

- [ ] **Step 4: Mount in `index.ts` before `oauthRouter`**

Find the line `app.route('/auth', oauthRouter)` and add **above** it:

```typescript
import { githubAuthRouter } from './routes/github-auth.js';
// ...
app.route('/auth/github', githubAuthRouter);
app.route('/auth', oauthRouter);
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
cd packages/worker && pnpm vitest run src/routes/github-auth.test.ts
```

Expected: pass.

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/routes/github-auth.ts \
        packages/worker/src/routes/github-auth.test.ts \
        packages/worker/src/index.ts
git commit -m "feat(auth): add github-auth router for unified login + link flow"
```

---

### Task 16: Update `routes/github-me.ts` — remove callback, update link initiation

**Files:**
- Modify: `packages/worker/src/routes/github-me.ts`
- Modify: `packages/worker/src/index.ts` (remove the `githubMeCallbackRouter` mount)

- [ ] **Step 1: Delete `githubMeCallbackRouter` entirely**

Remove the entire `githubMeCallbackRouter` export and its `GET /callback` handler. The callback now lives in `github-auth.ts`.

- [ ] **Step 2: Update `POST /api/me/github/link`**

Replace the hand-rolled authorize URL construction with:

```typescript
import { loadGitHubApp } from '../services/github-app.js';

githubMeRouter.post('/link', async (c) => {
  const user = c.get('user');
  const app = await loadGitHubApp(c.env, c.get('db'));
  if (!app) return c.json({ error: 'GitHub App not configured' }, 400);

  // 10-minute state JWT with purpose
  const now = Math.floor(Date.now() / 1000);
  const state = await signJWT(
    { sub: user.id, purpose: 'github-link', sid: crypto.randomUUID(), iat: now, exp: now + 10 * 60 } as any,
    c.env.ENCRYPTION_KEY,
  );

  const workerOrigin = c.env.API_PUBLIC_URL || new URL(c.req.url).origin;
  const { url } = app.oauth.getWebFlowAuthorizationUrl({
    state,
    redirectUrl: `${workerOrigin}/auth/github/callback`,
  });

  return c.json({ redirectUrl: url });
});
```

- [ ] **Step 3: Simplify `DELETE /api/me/github/link`**

The current version explicitly preserves `app_install` credentials. Since those no longer exist, simplify:

```typescript
// Delete the GitHub OAuth credential
await deleteCredential(appDb, 'user', user.id, 'github', 'oauth2');
```

Update the comment to remove the stale reference.

- [ ] **Step 4: Update `GET /api/me/github`**

Replace references to `ghMeta.accessibleOwners` with a query against `github_installations` filtered by `linked_user_id = user.id`:

```typescript
import { listGithubInstallationsByUser } from '../lib/db/github-installations.js';

const userInstallations = await listGithubInstallationsByUser(appDb, user.id);
```

Return installations in the response instead of the old `orgApp.accessibleOwners`.

- [ ] **Step 5: Remove scopes from the link request body**

The `POST /link` handler no longer needs `body.scopes` (GitHub Apps ignore scopes). Remove the scope handling.

- [ ] **Step 6: Update `index.ts`**

Remove the mount for `githubMeCallbackRouter`:

```typescript
// DELETE this line:
// app.route('/auth/github', githubMeCallbackRouter);
```

The `/auth/github/callback` path is now handled by `githubAuthRouter` mounted in Task 15.

- [ ] **Step 7: Typecheck**

```bash
cd packages/worker && pnpm typecheck
```

- [ ] **Step 8: Commit**

```bash
git add packages/worker/src/routes/github-me.ts \
        packages/worker/src/index.ts
git commit -m "refactor(github-me): delegate callback to github-auth, use App OAuth for link"
```

---

### Task 17: Stub `plugin-github/src/identity.ts`

**Files:**
- Modify: `packages/plugin-github/src/identity.ts`

- [ ] **Step 1: Replace with stub**

Replace the entire contents with:

```typescript
import type { IdentityProvider, ProviderConfig, CallbackData, IdentityResult } from '@valet/sdk/identity';

/**
 * GitHub identity provider — stub.
 *
 * The GitHub OAuth flow is handled directly by `packages/worker/src/routes/github-auth.ts`
 * using the GitHub App's built-in OAuth client loaded from D1, not via this provider.
 * This stub exists solely so that GitHub still appears in the identity registry for
 * enumeration purposes (e.g., the `/auth/providers` endpoint).
 */
export const githubIdentityProvider: IdentityProvider = {
  id: 'github',
  displayName: 'GitHub',
  icon: 'github',
  brandColor: '#24292e',
  protocol: 'oauth2',
  configKeys: [], // no env vars

  getAuthUrl(): string {
    throw new Error('GitHub auth URL is built by the github-auth router, not this provider.');
  },

  async handleCallback(): Promise<IdentityResult> {
    throw new Error('GitHub callback is handled by the github-auth router, not this provider.');
  },
};
```

- [ ] **Step 2: Typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 3: Commit**

```bash
git add packages/plugin-github/src/identity.ts
git commit -m "refactor(plugin-github): stub identity provider (handled by github-auth router)"
```

---

## Phase 5: Webhooks

### Task 18: Rewrite `routes/webhooks.ts` GitHub handler

**Files:**
- Modify: `packages/worker/src/routes/webhooks.ts`

- [ ] **Step 1: Read current implementation**

```bash
cat packages/worker/src/routes/webhooks.ts
```

Note the existing PR and push handlers — they call `webhookService.handlePullRequestWebhook` and `handlePushWebhook`. These MUST be preserved.

- [ ] **Step 2: Rewrite the GitHub handler**

Replace the `POST /github` handler with:

```typescript
import { loadGitHubApp } from '../services/github-app.js';
import {
  handleInstallationWebhook,
  handleInstallationRenamedWebhook,
} from '../services/github-installations.js';

webhooksRouter.post('/github', async (c) => {
  const event = c.req.header('X-GitHub-Event');
  const deliveryId = c.req.header('X-GitHub-Delivery');
  const signature = c.req.header('X-Hub-Signature-256');

  if (!event || !signature) {
    return c.json({ error: 'Missing required headers' }, 400);
  }

  const db = getDb(c.env.DB);
  const app = await loadGitHubApp(c.env, db);
  if (!app) {
    return c.json({ error: 'GitHub App not configured' }, 503);
  }

  // Read raw body ONCE (before any middleware consumes it)
  const rawBody = await c.req.raw.clone().text();

  // Verify via Octokit
  try {
    await app.webhooks.verifyAndReceive({
      id: deliveryId ?? crypto.randomUUID(),
      name: event as any,
      signature,
      payload: rawBody,
    });
  } catch (err) {
    console.error('GitHub webhook verification failed:', err);
    return c.json({ error: 'Invalid signature' }, 401);
  }

  // Parse payload for our own handlers (Octokit's `on` handlers are registered below
  // but they'd require per-request app.webhooks.on wiring which is awkward here.
  // Simpler: parse and dispatch manually after verification.)
  const payload = JSON.parse(rawBody);

  console.log(`GitHub webhook: ${event}.${payload.action ?? ''} (${deliveryId})`);

  try {
    // Installation lifecycle
    if (event === 'installation') {
      await handleInstallationWebhook(db, payload);
    } else if (event === 'installation_target' && payload.action === 'renamed') {
      await handleInstallationRenamedWebhook(db, payload);
    } else if (event === 'installation_repositories') {
      // No-op for now; spec says we don't track per-repo access
    }

    // Session state handlers — MUST be preserved from the previous implementation
    if (event === 'pull_request') {
      await webhookService.handlePullRequestWebhook(c.env, payload);
    } else if (event === 'push') {
      await webhookService.handlePushWebhook(c.env, payload);
    }

    // TODO(event-routing): Route workflow-trigger events (issues, issue_comment,
    // release, workflow_run, etc.) to the correct orchestrator. Requires building
    // an event router that determines whether an event targets a personal
    // orchestrator (based on installation.account.id matching a linked_user_id in
    // github_installations) or an org orchestrator, then dispatches through the
    // orchestrator mailbox. Tracked separately.
    const handled = new Set([
      'installation', 'installation_repositories', 'installation_target',
      'pull_request', 'push',
    ]);
    if (!handled.has(event)) {
      console.log(`[github webhook] unhandled event: ${event}.${payload.action ?? ''}`);
    }
  } catch (err) {
    console.error(`GitHub webhook handler error (${event}):`, err);
    // Still return 200 — failing to ACK would cause GitHub to retry, amplifying errors
  }

  return c.json({ received: true, event, deliveryId });
});
```

- [ ] **Step 3: Write a smoke test**

```typescript
// packages/worker/src/routes/webhooks-github.test.ts
import { describe, it, expect, vi } from 'vitest';

describe('POST /webhooks/github', () => {
  it('rejects invalid signature with 401', async () => {
    // Use Hono test client, post a body with bogus signature
    // Expect 401
  });

  it('processes installation.created and upserts row', async () => {
    // Generate a valid signature using the test webhook secret
    // POST the payload
    // Verify DB row exists
  });
});
```

- [ ] **Step 4: Run tests**

```bash
cd packages/worker && pnpm vitest run src/routes/webhooks-github.test.ts
```

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/routes/webhooks.ts \
        packages/worker/src/routes/webhooks-github.test.ts
git commit -m "refactor(webhooks): rewrite GitHub handler with Octokit verification

- Use app.webhooks.verifyAndReceive for HMAC verification
- Add installation lifecycle handlers (created/deleted/suspend/unsuspend)
- Preserve existing pull_request/push session state handlers
- Add TODO for event routing to orchestrators"
```

---

### Task 19: Update `routes/repo-providers.ts` install callback

**Files:**
- Modify: `packages/worker/src/routes/repo-providers.ts`

- [ ] **Step 1: Read the current install callback**

```bash
grep -n "install/callback\|install_id\|installation_id" packages/worker/src/routes/repo-providers.ts
```

- [ ] **Step 2: Rewrite the install callback**

The current handler:
- Takes `orgId` from a state JWT
- Calls `storeCredential('org', orgId, 'github', { credentialType: 'app_install' })`
- Stores `accessibleOwners` / `repositoryCount` in metadata

New behavior:
- State JWT purpose `'github-install'`, `sub` = Valet user ID
- Fetches the installation via `app.octokit.request('GET /app/installations/{id}')`
- Calls `upsertGithubInstallation` with `linkedUserId = valetUserId` if `account.id` matches `users.githubId`
- Does NOT store credentials
- Does NOT write metadata backfill

```typescript
import { loadGitHubApp } from '../services/github-app.js';
import { upsertGithubInstallation } from '../lib/db/github-installations.js';
import { verifyJWT } from '../lib/jwt.js';

repoProvidersRouter.get('/github/install/callback', async (c) => {
  const frontendUrl = c.env.FRONTEND_URL || 'http://localhost:5173';
  const installationId = c.req.query('installation_id');
  const stateParam = c.req.query('state');

  if (!installationId) {
    return c.redirect(`${frontendUrl}/integrations?github=error&reason=missing_installation_id`);
  }

  // Optional: if state is provided, verify and extract the Valet user ID for linking
  let valetUserId: string | undefined;
  if (stateParam) {
    const payload = await verifyJWT(stateParam, c.env.ENCRYPTION_KEY);
    if (payload && (payload as any).purpose === 'github-install') {
      valetUserId = (payload as any).sub as string;
    }
  }

  const db = getDb(c.env.DB);
  const app = await loadGitHubApp(c.env, db);
  if (!app) {
    return c.redirect(`${frontendUrl}/integrations?github=error&reason=app_not_configured`);
  }

  // Fetch the installation
  const { data: inst } = await app.octokit.request(
    'GET /app/installations/{installation_id}',
    { installation_id: Number(installationId) },
  );

  // Cross-check: if state claims a Valet user, their github_id must match
  if (valetUserId) {
    const user = await db.select({ githubId: users.githubId })
      .from(users).where(eq(users.id, valetUserId)).get();
    if (user?.githubId && String(inst.account.id) !== user.githubId) {
      return c.redirect(`${frontendUrl}/integrations?github=error&reason=account_mismatch`);
    }
  }

  await upsertGithubInstallation(db, {
    githubInstallationId: String(inst.id),
    accountLogin: inst.account.login,
    accountId: String(inst.account.id),
    accountType: inst.account.type as 'Organization' | 'User',
    repositorySelection: inst.repository_selection as 'all' | 'selected',
    permissions: inst.permissions as Record<string, unknown>,
    linkedUserId: valetUserId,
  });

  return c.redirect(`${frontendUrl}/integrations?github=installed`);
});
```

- [ ] **Step 3: Typecheck**

```bash
cd packages/worker && pnpm typecheck
```

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/routes/repo-providers.ts
git commit -m "refactor(repo-providers): update github install callback for installations table"
```

---

### Task 19.5: Typecheck checkpoint — end of Phase 5

**Files:** none (gating verification)

Tasks 6 and 8 deliberately broke typecheck. Tasks 9, 10, 11, 12, 13, 16, 18, 19 were expected to fix the chain. Before proceeding to Phase 6, verify the whole worker + plugin-github + shared + sdk workspace compiles clean.

- [ ] **Step 1: Run full workspace typecheck**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Expected: **clean pass** across all packages.

- [ ] **Step 2: If errors remain, triage before proceeding**

If there are lingering errors they almost certainly fall into one of these categories:
- Missed reference to `CredentialSourceInfo` — grep and delete
- Missed reference to `credentialSources` — grep and delete
- Missed reference to `accessibleOwners` — grep and delete
- Missed reference to `c.env.GITHUB_CLIENT_ID` / `c.env.GITHUB_CLIENT_SECRET` — delete
- Missed reference to `storeCredential(... 'app_install')` — delete (installation tokens mint on-demand)
- Shape mismatch between `CredentialResult` consumers and the wrapped `{ credential: ... }` form — fix the consumer

Do NOT proceed to Phase 6 until `pnpm typecheck` is clean.

- [ ] **Step 3: Run full test suite**

```bash
pnpm test
```

Expected: all tests pass. Fix any failures before proceeding.

- [ ] **Step 4: Commit any triage fixes (if any)**

```bash
git add -A
git commit -m "fix: resolve lingering references from unified-auth revert chain"
```

---

## Phase 6: Plugin-github updates

### Task 20: Rewrite `plugin-github/src/actions/` to use Octokit + attribution

**Files:**
- Modify: `packages/plugin-github/src/actions/actions.ts`
- Delete: `packages/plugin-github/src/actions/api.ts` (no longer needed)
- Modify: `packages/plugin-github/src/actions/provider.ts`
- Modify: `packages/plugin-github/src/actions/index.ts`

This is another large rewrite. Break into sub-steps.

- [ ] **Step 1: Remove `source` parameter from every action definition**

Find every `source: z.enum(['personal', 'org']).optional()...` and delete. Also update action descriptions to remove mentions of `source`.

- [ ] **Step 2: Create an Octokit helper**

Add at the top of `actions.ts`:

```typescript
import { Octokit } from 'octokit';
import type { ActionContext } from '@valet/sdk';

function getOctokit(ctx: ActionContext): Octokit {
  const token = ctx.credentials.access_token || ctx.credentials.token;
  if (!token) throw new Error('Missing access token');
  return new Octokit({ auth: token });
}

/**
 * Whether this action is running under a bot (installation) token.
 * Per the spec, the discriminator is the presence of attribution — when the
 * credential resolver returns a bot token, it attaches attribution from the
 * initiating Valet user. User tokens never have attribution.
 */
function isBotToken(ctx: ActionContext): boolean {
  return !!ctx.attribution;
}

function attributionSuffix(ctx: ActionContext): string {
  if (!ctx.attribution) return '';
  return `\n\n---\n> Created on behalf of ${ctx.attribution.name} <${ctx.attribution.email}>`;
}

function attributionCommentPrefix(ctx: ActionContext): string {
  if (!ctx.attribution) return '';
  return `*On behalf of ${ctx.attribution.name} <${ctx.attribution.email}>:*\n\n`;
}

function attributionCommitTrailer(ctx: ActionContext): string {
  if (!ctx.attribution) return '';
  return `\n\nCo-Authored-By: ${ctx.attribution.name} <${ctx.attribution.email}>`;
}
```

- [ ] **Step 3: Rewrite `executeAction` case by case**

For each action, replace `githubFetch(...)` with Octokit REST calls. Example for `list_repos`:

```typescript
case 'github.list_repos': {
  const p = listRepos.params.parse(params);
  const octokit = getOctokit(ctx);
  try {
    if (isBotToken(ctx)) {
      // Bot token → GET /installation/repositories
      const { data } = await octokit.request('GET /installation/repositories', {
        sort: p.sort, per_page: p.perPage, page: p.page,
      });
      return { success: true, data: data.repositories };
    }
    // User token → GET /user/repos
    const { data } = await octokit.request('GET /user/repos', {
      sort: p.sort, per_page: p.perPage, page: p.page,
    });
    return { success: true, data };
  } catch (err: any) {
    return { success: false, error: `List repos: ${err.status ?? 'unknown'} ${err.message}` };
  }
}
```

For write actions that produce user-visible content, inject attribution:

```typescript
case 'github.create_issue': {
  const { owner, repo, title, body } = createIssue.params.parse(params);
  const octokit = getOctokit(ctx);
  const finalBody = (body ?? '') + attributionSuffix(ctx);
  try {
    const { data } = await octokit.request('POST /repos/{owner}/{repo}/issues', {
      owner, repo, title, body: finalBody,
    });
    return { success: true, data };
  } catch (err: any) {
    return { success: false, error: `Create issue: ${err.status ?? 'unknown'} ${err.message}` };
  }
}

case 'github.create_comment': {
  const { owner, repo, issueNumber, body } = createComment.params.parse(params);
  const octokit = getOctokit(ctx);
  const finalBody = attributionCommentPrefix(ctx) + body;
  const { data } = await octokit.request(
    'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
    { owner, repo, issue_number: issueNumber, body: finalBody },
  );
  return { success: true, data };
}
```

Repeat for every action. Ensure attribution is applied to:
- `create_issue`, `update_issue`
- `create_pull_request`, `update_pull_request`
- `create_comment`, `create_review_comment`
- Any commit creation action
- Any other action producing user-visible text

- [ ] **Step 4: Delete `api.ts`**

```bash
rm packages/plugin-github/src/actions/api.ts
```

Remove the import from `actions.ts`. Any other references to `githubFetch` should be updated.

- [ ] **Step 5: Update `provider.ts`**

If `provider.ts` references types from `api.ts`, update imports.

- [ ] **Step 6: Typecheck**

```bash
cd packages/plugin-github && pnpm typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/plugin-github/src/actions/
git commit -m "refactor(plugin-github): use Octokit for all API calls, inject attribution

- Remove source parameter from all actions
- Replace githubFetch with Octokit REST client
- Inject Co-Authored-By trailer in commits
- Inject 'on behalf of' suffix in PRs/issues
- Inject 'on behalf of' prefix in comments"
```

---

### Task 21: Update `plugin-github` repo providers

**Files:**
- Modify: `packages/plugin-github/src/repo-app.ts`
- Modify: `packages/plugin-github/src/repo-oauth.ts`
- Modify: `packages/plugin-github/src/repo-shared.ts`
- Modify: `packages/plugin-github/src/repo.ts` (re-exports)

- [ ] **Step 1: Update `repo-oauth.ts`**

Rename logically to `githubUserRepoProvider`. `mintToken` becomes a no-op (user tokens are refreshed by the credential service). Update the `id` to `'github-user'` to reflect the new meaning.

- [ ] **Step 2: Update `repo-app.ts`**

`repo-app.ts` runs in the **worker** (verified at `packages/worker/src/lib/env-assembly.ts` line ~230, which imports and calls `mintToken`). So `mintToken` can delegate directly to the new `services/github-app.ts`.

Rewrite `mintToken` to delegate to the worker's `mintInstallationToken` helper:

```typescript
import { loadGitHubApp, mintInstallationToken } from '../../worker/src/services/github-app.js';
// NOTE: cross-package import — adjust path based on pnpm workspace layout.
// If a direct import isn't clean, inject the App factory as a parameter
// to `mintToken` from env-assembly.ts instead.

async mintToken(credential) {
  if (!credential.installationId) {
    throw new Error('Cannot mint token without installationId');
  }
  const app = credential._app; // or load via env
  if (!app) throw new Error('GitHub App not available for token minting');
  const { token, expiresAt } = await mintInstallationToken(app, credential.installationId);
  return { accessToken: token, expiresAt: new Date(expiresAt) };
}
```

**Cleaner alternative**: change the `RepoProvider.mintToken` signature in `@valet/sdk/repos` to accept an `{ env, app }` context object. Then `env-assembly.ts` passes the `App` instance in. This avoids cross-package imports and awkward `credential._app` injection.

Choose the cleaner alternative if the `RepoProvider` contract can be updated without breaking other repo providers; otherwise, fall back to injection via a `credential._app` field.

- [ ] **Step 3: Clean up `repo-shared.ts`**

If `mintInstallationToken` exists in `repo-shared.ts`, remove it (installation token minting now lives in `services/github-app.ts` in the worker).

- [ ] **Step 4: Attribution in `assembleSessionEnv`**

In `repo-app.ts`, the `assembleSessionEnv` method hardcodes `'user.name': 'valet[bot]'` and `'user.email': 'valet[bot]@users.noreply.github.com'`. If `RepoCredential` includes attribution (from the credential resolver), use those values instead:

```typescript
async assembleSessionEnv(credential, opts) {
  const attribution = credential.attribution;
  return {
    envVars: { /* as before */ },
    gitConfig: {
      'user.name': attribution?.name ?? 'valet[bot]',
      'user.email': attribution?.email ?? 'valet[bot]@users.noreply.github.com',
    },
  };
}
```

This requires `RepoCredential` to have an `attribution` field; add it to the SDK type if not present.

- [ ] **Step 5: Typecheck**

```bash
pnpm typecheck
```

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-github/src/
git commit -m "refactor(plugin-github): update repo providers for unified App model"
```

---

### Task 22: Update `plugin-github/skills/github.md`

**Files:**
- Modify: `packages/plugin-github/skills/github.md`

- [ ] **Step 1: Rewrite the skill documentation**

Read the current version, then rewrite to reflect:
- No more `source` parameter on actions
- Single token model (user access token is primary; bot token is anonymous fallback)
- Attribution behavior (commits/PRs/issues/comments get user identity injected automatically)
- Users should connect GitHub via integrations page for best UX

Key sections to update:
- "Credential routing" section → remove entirely or replace with "Credentials are resolved automatically"
- "Actions" section → remove `source` param mentions
- "List repos" → no more `source=personal` vs `source=org`; one call returns all accessible repos

- [ ] **Step 2: Regenerate the plugin registry**

```bash
make generate-registries
```

- [ ] **Step 3: Commit**

```bash
git add packages/plugin-github/skills/github.md \
        packages/worker/src/plugins/content-registry.ts
git commit -m "docs(plugin-github): update skill doc for unified credential model"
```

---

## Phase 7: Client UI

### Task 23: Rewrite admin `github-config.tsx`

**Files:**
- Modify: `packages/client/src/components/settings/github-config.tsx`

- [ ] **Step 1: Read the current component**

```bash
cat packages/client/src/components/settings/github-config.tsx
```

- [ ] **Step 2: Delete the classic OAuth panel**

Remove the entire OAuth-credentials form section (client ID / client secret inputs).

- [ ] **Step 3: Add the installations section**

Using `useGitHubInstallations`:

```tsx
const { data: installations } = useGitHubInstallations();

// Render:
<section>
  <h3>Organization installations</h3>
  <InstallationTable rows={installations?.organizations ?? []} />
</section>

<Collapsible>
  <CollapsibleTrigger>
    Personal installations ({installations?.personal.length ?? 0})
  </CollapsibleTrigger>
  <CollapsibleContent>
    <InstallationTable rows={installations?.personal ?? []} showUser />
  </CollapsibleContent>
</Collapsible>

{(installations?.orphaned.length ?? 0) > 0 && (
  <Collapsible>
    <CollapsibleTrigger>
      Orphaned installations ({installations.orphaned.length})
    </CollapsibleTrigger>
    <CollapsibleContent>
      <InstallationTable rows={installations.orphaned} />
    </CollapsibleContent>
  </Collapsible>
)}
```

- [ ] **Step 4: Add settings toggles**

```tsx
<Switch
  checked={config?.settings?.allowPersonalInstallations ?? true}
  onCheckedChange={(v) => updateSettings({ allowPersonalInstallations: v })}
  label="Allow personal installations"
/>
<Switch
  checked={config?.settings?.allowAnonymousGitHubAccess ?? true}
  onCheckedChange={(v) => updateSettings({ allowAnonymousGitHubAccess: v })}
  label="Allow anonymous GitHub access"
/>
```

- [ ] **Step 5: Update the danger zone**

Add a clearer confirmation dialog warning that removing the App config clears all stored credentials and interrupts active sessions.

- [ ] **Step 6: Typecheck**

```bash
cd packages/client && pnpm typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/client/src/components/settings/github-config.tsx
git commit -m "refactor(client): rewrite admin github-config for unified App model"
```

---

### Task 24: Update user integrations UI

**Files:**
- Modify: `packages/client/src/components/settings/github-integration-card.tsx` (or equivalent — find it)

- [ ] **Step 1: Locate the user-facing GitHub card**

```bash
grep -rn "github.*integration\|github.*card" packages/client/src/components
```

- [ ] **Step 2: Update the connected state**

Show the list of installations accessible to the user (from the updated `GET /api/me/github` response which now includes installations from `listGithubInstallationsByUser`).

- [ ] **Step 3: Add "Install on personal account" link**

When `allowPersonalInstallations === true` and the user does not yet have a personal installation:

```tsx
<button onClick={async () => {
  // Get install URL with signed state from backend
  const res = await apiClient.post('/me/github/install-url');
  window.open(res.data.url, '_blank');
}}>
  Install on personal account
</button>
```

This requires a new backend endpoint: `POST /api/me/github/install-url` that generates a signed state JWT and returns `https://github.com/apps/{appSlug}/installations/new?state={jwt}`.

- [ ] **Step 4: Add the `install-url` endpoint to github-me.ts**

```typescript
githubMeRouter.post('/install-url', async (c) => {
  const user = c.get('user');
  const config = await getGitHubConfig(c.env, c.get('db'));
  if (!config) return c.json({ error: 'GitHub App not configured' }, 400);

  const now = Math.floor(Date.now() / 1000);
  const state = await signJWT(
    { sub: user.id, purpose: 'github-install', iat: now, exp: now + 10 * 60 } as any,
    c.env.ENCRYPTION_KEY,
  );

  return c.json({
    url: `https://github.com/apps/${config.appSlug}/installations/new?state=${encodeURIComponent(state)}`,
  });
});
```

- [ ] **Step 5: Update the "not connected" banner states**

Based on `allowAnonymousGitHubAccess`, show either:
- "GitHub is available via shared access — connecting your account enables better attribution"
- "GitHub connection required for agent sessions"

Fetch the toggle value from a new API endpoint or include it in `GET /api/me/github`.

- [ ] **Step 6: Typecheck**

```bash
cd packages/client && pnpm typecheck
cd packages/worker && pnpm typecheck
```

- [ ] **Step 7: Commit**

```bash
git add packages/client/src packages/worker/src/routes/github-me.ts
git commit -m "feat(client): update user GitHub integration UI with installations"
```

---

## Phase 8: Cleanup & deployment

**Note on data migration**: there is no data migration. The existing GitHub state (service config, credentials, identity links) is simply dropped and re-set up from scratch after deploy. The project is small enough that asking the admin to re-run the manifest flow and users to reconnect is cheaper than writing migration code. The danger-zone "Remove App configuration" button (already covered in Task 13) handles the wipe; the admin clicks it, then re-runs "Create GitHub App". Users reconnect via the integrations page on next use.

**Task 25 has been removed** — no migration endpoint is needed.

---

### Task 26: Remove env vars and run full typecheck

**Files:**
- Modify: `packages/worker/src/env.ts`
- Modify: `packages/worker/wrangler.toml` (remove `GITHUB_CLIENT_ID`/`GITHUB_CLIENT_SECRET` from vars list if present)

- [ ] **Step 1: Remove env var references**

```bash
grep -rn "GITHUB_CLIENT_ID\|GITHUB_CLIENT_SECRET" packages/worker/src
```

Delete every reference. The only remaining reference should be in `plugin-github/src/identity.ts` as a stub with empty `configKeys`.

- [ ] **Step 2: Full workspace typecheck**

```bash
cd /Users/connerswann/code/valet && pnpm typecheck
```

Expected: clean pass across all packages. If there are errors, fix them.

- [ ] **Step 3: Full test run**

```bash
pnpm test
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/env.ts packages/worker/wrangler.toml
git commit -m "chore(github): remove classic OAuth env vars from worker"
```

---

### Task 27: Local smoke test

**Files:** none (verification only)

- [ ] **Step 1: Reset local DB and run migrations**

```bash
make db-reset
```

- [ ] **Step 2: Start the worker in dev mode**

```bash
make dev-worker
```

- [ ] **Step 3: Start the client in dev mode**

```bash
cd packages/client && VITE_API_URL=http://localhost:8787/api pnpm dev
```

- [ ] **Step 4: Manually verify**

Using the web UI:
1. Log in as admin (use an existing local test user)
2. Navigate to Settings → Integrations → GitHub (admin page)
3. Click "Create GitHub App" → walk through manifest flow → verify App is created
4. Verify "Refresh installations" works → check the installations section populates
5. Log in as a regular user → navigate to integrations → click "Connect GitHub"
6. Complete the OAuth flow → verify the user's installations appear
7. Start a new session and run a GitHub action (e.g., `list_repos`) → verify it works
8. Create an issue in a test repo → verify attribution trailer appears

- [ ] **Step 5: If any step fails, debug and fix**

Do NOT skip broken steps. File bugs or fix in-place.

- [ ] **Step 6: Commit any bug fixes**

---

### Task 28: Deploy to staging/production

**Files:** none (deployment task)

- [ ] **Step 1: Ensure migrations are staged**

```bash
git status
```

Expected: clean. All changes committed.

- [ ] **Step 2: Wipe existing GitHub state in production D1**

Since we're not writing a migration, drop the existing GitHub state directly. From the project root, run:

```bash
cd packages/worker

# Drop the github service config (contains the old App + classic OAuth fields)
wrangler d1 execute $D1_DATABASE_NAME --remote \
  --command "DELETE FROM org_service_configs WHERE service = 'github';"

# Drop all GitHub credentials (oauth2 and app_install rows)
wrangler d1 execute $D1_DATABASE_NAME --remote \
  --command "DELETE FROM credentials WHERE provider = 'github';"

# Drop any identity links pointing to GitHub
wrangler d1 execute $D1_DATABASE_NAME --remote \
  --command "DELETE FROM user_identity_links WHERE provider = 'github';"

# Clear github_id / github_username on users so they can re-link cleanly
wrangler d1 execute $D1_DATABASE_NAME --remote \
  --command "UPDATE users SET github_id = NULL, github_username = NULL;"

# Clear any existing integration rows for github
wrangler d1 execute $D1_DATABASE_NAME --remote \
  --command "DELETE FROM integrations WHERE service = 'github';"
```

The `github_installations` table is new (added by migration 0006) and starts empty — no action needed.

- [ ] **Step 3: Apply migrations to production**

```bash
make deploy-migrate
```

This applies migration 0006 (create `github_installations`). All other schema is unchanged.

- [ ] **Step 4: Deploy worker + client**

```bash
make deploy
```

- [ ] **Step 5: Re-setup the GitHub App (admin)**

Log into the deployed frontend as an admin:
1. Navigate to Settings → Integrations → GitHub
2. Click "Create GitHub App" → walk through the manifest flow → completes App creation
3. Click "Refresh installations" → verify installations appear
4. (If desired) install the App on additional GitHub orgs via the GitHub UI → click "Refresh installations" again to pick them up

- [ ] **Step 6: Smoke test production**

Same steps as Task 27 but against production URLs.

---

## Verification Checklist

After all tasks complete, verify:

- [ ] All tests pass: `pnpm test`
- [ ] Typecheck clean: `pnpm typecheck`
- [ ] No references to classic OAuth env vars: `grep -rn "GITHUB_CLIENT_ID\|GITHUB_CLIENT_SECRET" packages/worker/src packages/plugin-github/src` (should be empty)
- [ ] No references to classic OAuth config fields: `grep -rn "oauthClientId\|oauthClientSecret" packages/worker/src` (should be empty, since we use `appOauthClientId`/`appOauthClientSecret`)
- [ ] No references to `CredentialSourceInfo` / `credentialSources` / `skipScope`: `grep -rn "CredentialSourceInfo\|credentialSources\|skipScope" packages/worker/src` (should be empty)
- [ ] No references to `accessibleOwners`: `grep -rn "accessibleOwners" packages/worker/src packages/plugin-github/src` (should be empty)
- [ ] No `_credential_type === 'app_install'` discriminator anywhere: `grep -rn "_credential_type.*app_install" packages/plugin-github/src` (should be empty — use `ctx.attribution` presence instead)
- [ ] No `source` parameter on GitHub actions: `grep -n "source.*personal.*org" packages/plugin-github/src/actions/actions.ts` (should be empty)
- [ ] No reads of `ctx.env.GITHUB_CLIENT_*` in any route: `grep -rn "env\.GITHUB_CLIENT" packages/worker/src` (should be empty)
- [ ] No `storeCredential(... 'app_install')`: `grep -rn "storeCredential.*app_install\|credentialType: 'app_install'" packages/worker/src` (only the Task 10 resolver's in-memory construction should match)
- [ ] `github_installations` table populated after admin re-runs "Refresh installations" post-deploy
- [ ] GitHub login works with App OAuth credentials (test end-to-end)
- [ ] GitHub integration connect works with App OAuth credentials (test end-to-end)
- [ ] Personal installation flow works end-to-end (Install on personal account → callback → reconciliation)
- [ ] Attribution appears in commits/PRs/issues/comments when using bot token (manual verification by creating an issue as a non-linked user)
- [ ] Rate limit on "Refresh installations" admin action is respected (call twice in quick succession, second should 429)

---

## Rollback Plan

If production deployment reveals critical bugs:

1. **Credential resolver broken / GitHub actions failing**: revert the worker deploy to the previous release tag. The wiped state (empty `org_service_configs`, no credentials) is not restored by revert — the old code will show "GitHub not configured" on the admin page, and the admin must re-create the classic OAuth App + old-style GitHub App setup under the previous worker. Only revert if the unified-auth path is unrecoverable; the re-setup cost is real but bounded.
2. **Webhook handler broken**: webhooks will fail verification. This is isolated — revert only `packages/worker/src/routes/webhooks.ts` and redeploy, leaving everything else in place.
3. **Admin app creation flow broken**: the admin cannot re-setup GitHub. Revert the worker. Files involved: `routes/admin-github.ts`, `services/github-app.ts`, `services/github-config.ts`.
4. **Full revert**: `git revert` the merge commit and redeploy. The `github_installations` table remains (unused, harmless). The admin must then re-set up under the previous worker's (old) flow.

Because there is no data migration, rollback is straightforward: revert code, the empty DB state can be re-populated by the admin using whichever worker version is running.
