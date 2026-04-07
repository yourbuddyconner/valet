# GitHub Identity Card, Admin Config & Repo-Aware Credential Resolution

**Date:** 2026-03-18
**Status:** Draft
**Branch:** feat/github-dual-repo-provider

## Problem

Three related gaps in the GitHub integration:

1. **No user identity linking.** Users have no way to link their personal GitHub account through the integrations page. The dual repo provider infrastructure (OAuth + App) is built, but there's no UI to provision a personal OAuth credential or understand which credential mode sessions use.

2. **No admin config UI.** GitHub OAuth App credentials (`GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`) and GitHub App credentials (`GITHUB_APP_ID`, `GITHUB_APP_PRIVATE_KEY`) are hardcoded as worker env vars. Admins can't configure them through the app. Slack has a separate D1 table (`org_slack_installs`) but there's no generic pattern — each new service would need its own table. We need a generic `org_service_configs` table that stores all service configurations, and migrate Slack into it.

3. **Broken credential resolution.** `resolveRepoCredential()` uses a global priority chain that doesn't account for the fact that user App installations and org App installations cover different, non-overlapping repo sets (personal vs org-scoped repos). They're parallel access paths, not a fallback chain.

## Goals

1. Generic `org_service_configs` table for all service configurations, with Slack migration
2. Admin UI for configuring GitHub OAuth App and GitHub App credentials (org settings)
3. Dedicated GitHub card on the integrations page for personal identity linking
4. Surface credential mode and commit attribution implications in the UI
5. Repo-aware credential resolution using stored accessible owners

## Non-Goals

- Abstracting a generic identity-link card component (future work when a third consumer exists)
- Explicit per-session provider selection (`repoProviderId` on sessions table)

---

## Design

### 1. Generic Org Service Config Table

#### Motivation

Integration configs are currently scattered: Slack uses `org_slack_installs` (D1), GitHub uses env vars (`GITHUB_CLIENT_ID`, etc.), Google uses env vars. Rather than creating another per-service table for GitHub, we introduce a single `org_service_configs` table that stores all service configurations. Slack is migrated into it, and GitHub is the first new consumer.

#### Data model

```sql
CREATE TABLE org_service_configs (
  service TEXT PRIMARY KEY,       -- e.g. 'github', 'slack'
  encrypted_config TEXT NOT NULL, -- encrypted JSON blob (secrets: tokens, keys, client secrets)
  metadata TEXT,                  -- unencrypted JSON (non-sensitive: teamName, accessibleOwners, etc.)
  configured_by TEXT NOT NULL REFERENCES users(id),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**`encrypted_config`** holds secrets, encrypted with `ENCRYPTION_KEY` (same pattern as credentials table). Each service defines its own config shape in TypeScript:

```typescript
// GitHub config (encrypted_config blob)
interface GitHubServiceConfig {
  oauthClientId: string;
  oauthClientSecret: string;
  appId?: string;
  appPrivateKey?: string;
  appSlug?: string;
  appWebhookSecret?: string;
}

// GitHub metadata (unencrypted, queryable)
interface GitHubServiceMetadata {
  appInstallationId?: string;
  accessibleOwners?: string[];         // repo owners this App installation can access
  accessibleOwnersRefreshedAt?: string; // ISO timestamp of last refresh
}

// Slack config (encrypted_config blob)
interface SlackServiceConfig {
  botToken: string;
  signingSecret?: string;
}

// Slack metadata (unencrypted)
interface SlackServiceMetadata {
  teamId: string;
  teamName?: string;
  botUserId: string;
  appId?: string;
}
```

**`metadata`** holds non-sensitive data needed for display or lookups without decryption (e.g., `accessibleOwners` for credential resolution, `teamName` for display).

Drizzle schema: `packages/worker/src/lib/schema/service-configs.ts`.

#### Generic DB helpers

```typescript
// Type-safe get/set with per-service config shapes
async function getServiceConfig<TConfig, TMeta>(
  db: AppDb, env: Env, service: string
): Promise<{ config: TConfig; metadata: TMeta } | null>

async function setServiceConfig<TConfig, TMeta>(
  db: AppDb, env: Env, service: string,
  config: TConfig, metadata: TMeta, configuredBy: string
): Promise<void>

async function deleteServiceConfig(
  db: AppDb, service: string
): Promise<boolean>

async function getServiceMetadata<TMeta>(
  db: AppDb, service: string
): Promise<TMeta | null>

async function updateServiceMetadata<TMeta>(
  db: AppDb, service: string, metadata: TMeta
): Promise<void>
```

`getServiceMetadata` reads only the unencrypted metadata column — useful for credential resolution where we just need `accessibleOwners` without decrypting the full config.

#### GitHub config resolution (env var fallback)

All code that currently reads `c.env.GITHUB_CLIENT_ID` etc. switches to a helper:

```typescript
async function getGitHubConfig(env: Env, db: AppDb): Promise<GitHubServiceConfig | null>
```

This calls `getServiceConfig<GitHubServiceConfig>('github')` first. If no row exists, falls back to env vars for backward compatibility. Once an admin configures via UI, the D1 row takes precedence. This lets existing deployments keep working without migration.

**Important:** All direct reads of `c.env.GITHUB_*` must be migrated to use `getGitHubConfig()` to avoid split-brain credential resolution where D1 and env vars point to different apps. The files changed table reflects this — `repo-providers.ts`, `oauth.ts`, `integrations.ts`, and `env-assembly.ts` all switch to the helper.

#### Slack migration

The existing `org_slack_installs` table is migrated into `org_service_configs`:

- `encryptedBotToken` + `encryptedSigningSecret` → `encrypted_config` (as `SlackServiceConfig`)
- `teamId`, `teamName`, `botUserId`, `appId` → `metadata` (as `SlackServiceMetadata`)
- `installedBy` → `configured_by`

A D1 migration copies existing data. The old table is kept temporarily (read-only) for rollback safety but all code switches to read from `org_service_configs`. The `slackLinkVerifications` table is unaffected (it's verification-flow specific, not config).

All callers of `getOrgSlackInstall()` / `getOrgSlackInstallAny()` / `saveOrgSlackInstall()` / `deleteOrgSlackInstall()` switch to the generic helpers. The Slack-specific DB helpers in `packages/worker/src/lib/db/slack.ts` are updated to wrap the generic helpers with Slack types.

#### Admin endpoints

**GitHub-specific:**

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `GET /api/admin/github` | GET | Get current GitHub config (secrets redacted) |
| `PUT /api/admin/github/oauth` | PUT | Set OAuth App client ID + secret |
| `POST /api/admin/github/app/manifest` | POST | Generate manifest + GitHub form URL for App creation |
| `POST /api/admin/github/app/refresh` | POST | Re-sync installation metadata from GitHub |
| `DELETE /api/admin/github/oauth` | DELETE | Remove entire GitHub config (app + OAuth + credential) |

> **Note:** `PUT /app`, `DELETE /app`, and `POST /app/verify` were replaced by the manifest flow in `docs/specs/2026-04-07-github-app-manifest-flow-design.md`.

The refresh endpoint mints a JWT from the App credentials, lists installations (enforcing single-installation model), and updates `installationId`, `accessibleOwners`, and `repositoryCount` in the metadata column.

#### Admin UI

New section in org settings (alongside existing LLM key config). Two collapsible panels:

**OAuth App panel:** Client ID (text input) + Client Secret (password input) + Save button. Shows "Configured" badge when set. Required for user identity linking.

**GitHub App panel:** App ID (text input) + Private Key (textarea) + App Slug (text input) + Save & Verify button. Verification fetches installation info and displays accessible orgs/owners. Required for org-level repo access.

#### Identity provider integration

The `githubIdentityProvider` in `plugin-github/src/identity.ts` currently declares `configKeys: ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']` and the identity provider contract (`ProviderConfig`) passes these from env vars. The `getAuthUrl` and `handleCallback` methods receive a `ProviderConfig` with `clientId` and `clientSecret`.

Rather than changing the identity provider contract, the caller in `routes/oauth.ts` that builds the `ProviderConfig` will be updated to resolve config from D1 first (via `getGitHubConfig`), falling back to env vars. The identity provider itself doesn't need to change.

---

### 2. User GitHub Card

#### Card states

The GitHub card appears on the integrations page as a dedicated component (same pattern as `SlackCard`). Four states:

**1. Not connected** — No org app, no personal OAuth. Card shows "Not connected" badge and a "Connect GitHub" button that initiates OAuth with full scopes.

**2. Org app only** — Org has a GitHub App configured but user hasn't linked their personal account. Card shows "Org app only" badge, lists capabilities provided via the org app (actions, repo access as `valet[bot]`), and prompts user to "Connect Personal Account" for commit attribution.

**3. Connected (no repo scope)** — User completed OAuth without `repo` scope. Card shows identity (avatar, username, email), actions as enabled, repo access with an "Enable" button for scope escalation. Warning banner: "Commits attributed to `valet[bot]` via org app."

**4. Fully connected** — User OAuth with `repo` scope. Both capabilities green. Success banner: "Commits attributed to `@username`." Disconnect link at bottom.

#### Backend endpoints

All user-scoped under `/api/me/github`, mirroring the Slack pattern (`/api/me/slack`).

##### `GET /api/me/github`

Returns the user's GitHub connection status. Response fields are assembled from multiple sources:
- `orgApp.installed` and `orgApp.accessibleOwners` — from `org_service_configs` table (service `'github'` metadata)
- `personal.linked`, `personal.githubUsername`, `personal.githubId` — from `users` table (`githubId`, `githubUsername` columns)
- `personal.avatarUrl` — from `users` table (`avatarUrl` column)
- `personal.email` — from `users` table (`email` column, the login email)
- `personal.scopes` — from `credentials` table (user credential for provider `'github'`, `credentialType: 'oauth2'`)

Response:
```json
{
  "oauthConfigured": true,
  "orgApp": {
    "installed": true,
    "accessibleOwners": ["my-org", "other-org"]
  },
  "personal": {
    "linked": false,
    "githubUsername": null,
    "githubId": null,
    "email": null,
    "avatarUrl": null,
    "scopes": null
  }
}
```

When `oauthConfigured` is false (no OAuth App client ID in D1 or env vars), the card shows a message indicating GitHub is not configured by an admin and the connect button is disabled.

##### `POST /api/me/github/link`

Initiates the OAuth flow. Accepts an optional scope set for escalation.

Request:
```json
{
  "scopes": ["repo", "read:user", "read:org", "user:email"]
}
```

If `scopes` is omitted, defaults to `["read:user", "read:org", "user:email"]` (identity + actions, no repo access). The `user:email` scope is always included to ensure email retrieval from `/user/emails` works for private emails.

Response:
```json
{
  "redirectUrl": "https://github.com/login/oauth/authorize?client_id=...&scope=...&state=..."
}
```

The backend generates a signed JWT state token (same pattern as the existing OAuth login flow in `routes/oauth.ts` — signed with `ENCRYPTION_KEY`, 10-minute expiry, encodes user ID and requested scopes). No server-side state storage needed. The frontend redirects the browser to the returned URL.

##### `GET /auth/github/link/callback`

OAuth callback. Mounted on a **public route** outside `/api/*` to avoid auth middleware (the browser is redirecting from GitHub without a session token). Same pattern as the existing `repoProviderCallbackRouter` in `routes/repo-providers.ts`. The user is identified from the JWT state token, not from session auth.

Flow:
1. Validate and decode JWT `state` token (verify signature, check expiry, extract user ID)
2. Exchange `code` for access token via `POST https://github.com/login/oauth/access_token`
3. Store the **actual granted scopes** from GitHub's response (not the requested scopes). If `repo` was requested but not granted (user deselected it during authorization), the UI will reflect the real capabilities
4. Fetch user profile via `GET https://api.github.com/user` (and `/user/emails` if email is private — requires `user:email` scope)
5. Create or update `UserIdentityLink` record (provider: `'github'`, externalId: GitHub user ID, externalName: GitHub username, teamId: null)
6. Store token as user-level credential (provider: `'github'`, credentialType: `'oauth2'`). Scopes are always explicitly set from the response (never null) to prevent stale scope data on re-authorization
7. Update user record with `githubId`, `githubUsername`
8. Redirect to `/integrations?github=linked`

On scope escalation (user already linked), steps 5-6 update existing records rather than creating duplicates.

##### `DELETE /api/me/github/link`

Disconnects the user's personal GitHub connection.

Flow:
1. Delete `UserIdentityLink` record for provider `'github'`
2. Delete user credential for provider `'github'`, credentialType `'oauth2'`
3. Clear `githubId`, `githubUsername` from user record

Sessions that were using the personal OAuth token fall back to the org App installation (if available) on next token resolution.

#### Relationship to existing integration OAuth

The existing `githubProvider` in `plugin-github/src/actions/provider.ts` provides a generic integration OAuth flow (used by the `ConnectIntegrationDialog`). The new `/me/github/link` flow replaces this for users — it creates both the identity link and the credential in one flow. The `IntegrationCard` for `service="github"` is suppressed (added to the `dedicatedServices` set in `integration-list.tsx`) and the `GitHubCard` renders in its place.

The existing `githubIdentityProvider` in `plugin-github/src/identity.ts` handles GitHub OAuth for login (creating user accounts). This is a separate concern and remains unchanged.

#### Frontend components

**`GitHubCard`** — New file: `packages/client/src/components/integrations/github-card.tsx`

Fetches status from `GET /me/github` via React Query. Renders one of the four states. "Connect GitHub" / "Connect Personal Account" buttons call the link mutation, which returns a redirect URL. "Enable" (repo scope) calls the same mutation with expanded scopes. "Disconnect" calls the delete mutation.

**`github.ts`** — New file: `packages/client/src/api/github.ts`

```typescript
export const githubKeys = {
  status: ['me', 'github'] as const,
};

useGitHubStatus()         // GET /me/github
useGitHubLink()           // POST /me/github/link (mutation)
useGitHubDisconnect()     // DELETE /me/github/link (mutation)
```

---

### 3. Credential Resolution (Rewritten)

#### Current behavior (broken)

`resolveRepoCredential(provider, orgId, userId)` uses a global priority chain:
1. User OAuth token
2. Org App installation
3. User App installation
4. Null

This is wrong because org App and user App cover different repo sets. They're parallel access paths, not a fallback chain.

#### New behavior

`resolveRepoCredential(provider, repoOwner, orgId, userId)` — new `repoOwner` parameter.

Resolution logic:
1. **User OAuth token exists** → return it (covers all repos the user can see)
2. **No OAuth** → find the App installation whose `accessibleOwners` includes `repoOwner`:
   - Check `org_service_configs` metadata for service `'github'` (org-level App)
   - Check user-level credential metadata for user-level App installations
3. **No match** → return null

For operations that are not repo-scoped (e.g., listing all repos), the user OAuth token is the only viable option. App installation tokens can only operate within their installation's scope. `getGitHubToken()` callers that don't have a repo context must handle the null case when no OAuth token exists.

#### Storing and refreshing accessible owners

The `accessibleOwners` list in the `org_service_configs` metadata for `'github'` is populated:
- When the admin refreshes the GitHub App config (`POST /api/admin/github/app/refresh`)
- On `installation_repositories` webhook events (not currently handled — noted as day-one gap, manual re-verify via admin UI as interim)
- Lazily: if `resolveRepoCredential` can't find a match, and the metadata's `accessibleOwnersRefreshedAt` is older than 1 hour, refresh the list inline and retry. Cap at one refresh attempt per resolution to avoid loops. Store the refresh timestamp to prevent thundering herd.

#### Callers that need updating

**`getGitHubToken()` in `session-agent.ts`** (line ~7382): Currently calls `getCredential()` directly for `oauth2` type only. Needs rewriting to call the new `resolveRepoCredential()`. Important: the current implementation has multiplayer logic — it tries the prompt author's token first, then falls back to the session creator's. This priority chain must be preserved: for each user in the chain, apply the new repo-aware resolution.

Most callers (`handleListPullRequests`, `handleInspectPullRequest`, `handleCreatePullRequest`, etc.) have `owner` available as a parameter and can pass it through.

`handleListRepos` does not have a single `repoOwner`. For that operation, the handler should: (a) use OAuth token if available (covers all repos), (b) if no OAuth, collect repos from each available App installation by iterating over known installations and calling `GET /installation/repositories` for each. This means `handleListRepos` returns a merged, deduplicated list.

**`getGitHubToken()` in `routes/repos.ts`** (line ~82): Separate helper that calls current `resolveRepoCredential`. Routes like `/repos/:owner/:repo/pulls` and `/repos/:owner/:repo/issues` have `:owner` available. Update to pass `owner` through.

**`assembleRepoEnv()` in `env-assembly.ts`**: Already has repo context. Pass repo owner to credential resolution.

---

### Scope Reconciliation

Three places currently define GitHub OAuth scopes differently:
- `identity.ts`: `'read:user user:email'` (login only)
- `actions/provider.ts`: `'repo read:user read:org'` (integration)
- This spec's `/me/github/link`: `'read:user read:org user:email'` (default) or `'repo read:user read:org user:email'` (with repo access)

The identity provider (`identity.ts`) scopes are correct for login — minimal. The `/me/github/link` flow supersedes the `actions/provider.ts` flow for user connections. `user:email` must always be included to handle private GitHub emails. The actions provider's scope string should be updated to include `user:email` for consistency.

---

### Files Changed

| File | Change |
|------|--------|
| `packages/worker/migrations/NNNN_service_configs.sql` | **New** — `org_service_configs` table + Slack data migration |
| `packages/worker/src/lib/schema/service-configs.ts` | **New** — Drizzle schema for `org_service_configs` |
| `packages/worker/src/lib/db/service-configs.ts` | **New** — Generic typed DB helpers (`getServiceConfig`, `setServiceConfig`, etc.) |
| `packages/worker/src/routes/admin-github.ts` | **New** — Admin GitHub config endpoints |
| `packages/worker/src/routes/github-me.ts` | **New** — User-scoped GitHub identity endpoints |
| `packages/client/src/components/integrations/github-card.tsx` | **New** — GitHub card component |
| `packages/client/src/api/github.ts` | **New** — React Query hooks for `/me/github` |
| `packages/client/src/components/settings/github-config.tsx` | **New** — Admin GitHub config UI in org settings |
| `packages/worker/src/lib/schema/index.ts` | Re-export `service-configs.ts` |
| `packages/worker/src/lib/db.ts` | Re-export `service-configs.ts` DB helpers |
| `packages/worker/src/lib/db/slack.ts` | Rewrite to wrap generic `getServiceConfig<SlackServiceConfig>` helpers |
| `packages/worker/src/services/slack.ts` | Update to use new Slack config accessors |
| `packages/worker/src/integrations/resolvers/slack.ts` | Update to use new Slack config accessors |
| `packages/worker/src/index.ts` | Mount new routes |
| `packages/worker/src/lib/db/credentials.ts` | Repo-aware `resolveRepoCredential()` |
| `packages/worker/src/lib/env-assembly.ts` | Pass repo owner to credential resolution |
| `packages/worker/src/durable-objects/session-agent.ts` | `getGitHubToken()` uses repo-aware resolution |
| `packages/worker/src/routes/repos.ts` | `getGitHubToken()` passes repo owner |
| `packages/worker/src/services/sessions.ts` | Pass repo owner to credential resolution |
| `packages/worker/src/lib/db/credentials.test.ts` | Update tests for new `resolveRepoCredential` signature |
| `packages/worker/src/routes/oauth.ts` | Resolve GitHub OAuth config from D1, fall back to env |
| `packages/worker/src/routes/integrations.ts` | Resolve GitHub config from D1 for available services |
| `packages/worker/src/routes/repo-providers.ts` | Read GitHub config from D1 instead of env vars |
| `packages/plugin-github/src/actions/provider.ts` | Add `user:email` to OAuth scopes |
| `packages/client/src/components/integrations/integration-list.tsx` | Add `GitHubCard`, add `'github'` to `dedicatedServices` set |
| `packages/client/src/routes/settings/` | Add GitHub config section to org settings page |

### Migration

One new D1 migration that:
1. Creates `org_service_configs` table
2. Copies existing `org_slack_installs` data into it (secrets stay encrypted, non-sensitive fields go to metadata)
3. Keeps `org_slack_installs` as read-only for rollback safety (can be dropped in a follow-up migration)

User-level App installation credentials (if any exist) continue using `metadata.accessibleOwners` on the credentials table.

### Security Considerations

- OAuth App secrets and App private keys are encrypted at rest (same `ENCRYPTION_KEY` pattern as other credentials)
- Admin endpoints require `admin` role (existing `adminMiddleware`)
- OAuth state tokens are signed JWTs with 10-minute expiry (same pattern as login OAuth)
- User tokens are encrypted at rest in the credentials table
- Disconnecting immediately removes the credential
- Granted scopes are stored and verified against what was requested — UI reflects actual capabilities
- Admin can verify App config before saving (test connection)
