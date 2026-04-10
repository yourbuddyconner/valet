# GitHub App Unified Authentication

## Problem

Valet currently treats GitHub OAuth Apps and GitHub Apps as two parallel integration paths:

- **Classic OAuth App** — user-to-server only, broad scopes, persistent tokens. Used for personal GitHub access in sessions, for GitHub login, and for user-scoped repo access in integrations.
- **GitHub App** — server-to-server via installation tokens, fine-grained permissions, built-in webhooks. Used for org-level repo access in sessions.

This split drove a complex multi-credential routing design (see [`2026-04-08-github-multi-credential-routing-design.md`](./2026-04-08-github-multi-credential-routing-design.md)) to reconcile the two token types in a single session.

The split is unnecessary. A GitHub App is a **superset** of an OAuth App. Per GitHub's own guidance, ["GitHub Apps are preferred over OAuth apps"](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app), and they support three authentication modes:

1. **As the App** (JWT): manage installations, mint tokens
2. **As an installation** (installation access token): server-to-server, attributed to the App, 1hr lifetime
3. **On behalf of a user** (user access token via the App's built-in OAuth client): attributed to a specific user, 8hr lifetime + 6mo refresh

See [About authentication with a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/about-authentication-with-a-github-app).

The App's built-in OAuth flow replaces everything the classic OAuth App did, with better security (fine-grained permissions instead of broad scopes, short-lived tokens with refresh, repository-scoped access). We can remove the classic OAuth path entirely, collapse the two credential types into one, and dramatically simplify credential resolution.

Additionally, the current design assumes a **single** org installation. This is too restrictive. The new design allows:

- **Organization installations**: admin installs the App on one or more GitHub orgs; shared across all Valet users
- **Personal installations**: individual Valet users install the App on their own GitHub accounts, scoped to them

## Goals

- Replace the classic OAuth App path with the GitHub App's built-in OAuth everywhere it is used: integrations, GitHub login, and repo providers
- Support multiple org installations and personal installations simultaneously
- Simplify credential resolution to a clean chain: user token → matching installation bot token → fail
- Adopt [Octokit](https://github.com/octokit/octokit.js) as the GitHub SDK (auth, API calls, webhook verification)
- Preserve attribution: when acting via a bot token, inject the Valet user's identity into commits, PRs, issues, and comments
- Make anonymous GitHub access a first-class admin-controlled feature

## Non-Goals

- Routing workflow-trigger webhook events (`push`, `pull_request`, `issues`, etc.) to personal vs org orchestrators is **partially** in scope: existing session state handlers (PR status updates, commit counts) are preserved. What is deferred is fan-out of these events to workflow triggers and per-installation orchestrator dispatch — see [Webhooks](#webhooks).
- Changes to other integration providers (Google, Gmail, Slack, etc.)
- GitHub Enterprise Server support (the design is compatible but not explicitly validated)
- Gradual migration / backward compatibility with existing stored credentials — single-shot replacement, with an "old tokens fail on first refresh" fallback for in-flight sessions

## Design

### Authentication model

A **single GitHub App** is registered per Valet instance, with:

- One App registration (appId, private key, OAuth client credentials, webhook secret)
- Zero or more **installations**, each on an organization or user account
- Zero or more **linked user access tokens**, stored per Valet user

**Installations** are where the App is installed on GitHub. Each installation grants the App access to specific repositories and organization resources on that account. See [Installing a GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party).

**User access tokens** are user-to-server OAuth tokens generated via the App's OAuth client. A single user access token can access **any repository in any installation the user has permission to access**. See [Authenticating with a GitHub App on behalf of a user](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user).

This has an important implication: we do NOT need per-installation user tokens. One user token covers all installations the user can access. Routing tokens to installations is only needed for the bot-token fallback path.

### App registration

The App is created via the existing [GitHub App manifest flow](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest). This flow lets the admin generate a preconfigured App with a single click, returning the appId, private key, webhook secret, and OAuth client credentials in one shot.

**Manifest target**: The manifest POST URL determines where the App is registered:

- Personal account: `https://github.com/settings/apps/new`
- Organization: `https://github.com/organizations/{org}/settings/apps/new`

The admin chooses which at setup time (existing code already supports a `githubOrg` parameter; we just make it optional).

**App visibility**: The App must be **public** so it can be installed on accounts other than the one that owns the registration. It does NOT need to be listed on the GitHub Marketplace. Public + unlisted keeps it discoverable only via direct link. See [Installing a GitHub App for organizations](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-github-marketplace-for-your-organizations).

**Permissions requested**: The manifest declares the minimum required permissions:

- `contents: write` — clone, commit, push
- `metadata: read` — required default
- `pull_requests: write` — create/update PRs
- `issues: write` — create/update issues
- `actions: read` — view workflow runs
- `checks: read` — view check runs

These match the existing manifest defaults. No change.

**Request user authorization during installation**: The manifest sets `request_oauth_on_install: false`. GitHub's docs don't explicitly specify whether the install-flow `state` parameter round-trips into the auto-triggered OAuth leg, so rather than rely on undocumented behavior, Valet initiates the OAuth flow itself after the install callback, using its own signed state. See the [Installation tracking](#installation-tracking) section for the full post-install reconciliation flow.

**Callback URLs** (in the manifest's `callback_urls` array):

- `{workerUrl}/auth/github/callback` — the single canonical GitHub OAuth callback. Already exists and already has branching logic for login vs link purposes (see [GitHub login & identity integration](#github-login--identity-integration)).
- `{workerUrl}/repo-providers/github/install/callback` — the existing install callback path used post-install for repo-provider reconciliation (kept for continuity).

Both URLs are declared so the same App can service both flows. GitHub allows up to 10 callback URLs per App.

**Config storage**: The App configuration is stored in `org_service_configs` (existing table). The table schema is:

```sql
CREATE TABLE org_service_configs (
  service TEXT PRIMARY KEY,
  encrypted_config TEXT NOT NULL,  -- JSON blob encrypted via ENCRYPTION_KEY
  metadata TEXT,                    -- JSON blob, not encrypted
  ...
);
```

**Important**: the OAuth client ID/secret and App credentials live **inside the `encrypted_config` JSON blob**, not as columns. Schema-level column drops are not applicable.

The new `GitHubServiceConfig` JSON shape:

```typescript
interface GitHubServiceConfig {
  // App credentials (only path)
  appId: string;
  appPrivateKey: string;
  appSlug: string;
  appWebhookSecret: string;
  // The App's built-in OAuth client
  appOauthClientId: string;
  appOauthClientSecret: string;
}
```

**Dropped fields** (removed from the JSON blob via a data migration that decrypts, rewrites, and re-encrypts each row):

```
oauthClientId        // classic OAuth App
oauthClientSecret    // classic OAuth App
```

These are removed by the migration `NNNN_rewrite_github_service_config.sql` (executed by a script run during deployment, not a raw `ALTER TABLE`). See [Migration](#migration).

**Metadata JSON** (`org_service_configs.metadata`):

Removed fields (all replaced by queries against the new `github_installations` table):
- `appInstallationId` — obsolete, many installations supported
- `accessibleOwners`, `accessibleOwnersRefreshedAt` — obsolete
- `repositoryCount` — obsolete

Added fields:
- `allowPersonalInstallations: boolean` (default `true`)
- `allowAnonymousGitHubAccess: boolean` (default `true`)

Preserved fields: `appOwner`, `appOwnerType`, `appName` (still useful for the admin UI).

### GitHub login & identity integration

GitHub is both an integration provider and a login identity provider. The current implementation has two separate paths that both exchange codes for tokens:

- **Login path**: `packages/worker/src/routes/oauth.ts` → generic `/auth/:provider` (initiation) and `/auth/:provider/callback` → calls `identityRegistry.get('github').getAuthUrl(config, callbackUrl, state)` and `provider.handleCallback(config, data)`. The `config` is built by `resolveProviderConfig(env, provider)` walking `provider.configKeys = ['GITHUB_CLIENT_ID', 'GITHUB_CLIENT_SECRET']` — pure env-var lookup, no D1 access. The identity provider (`packages/plugin-github/src/identity.ts`) does the code exchange itself using those env-var credentials.
- **Link path**: `githubMeRouter.post('/link')` initiates using `GitHubConfig.oauthClientId` from D1; the callback lands at `/auth/github/callback` in `githubMeCallbackRouter`, which branches on `payload.purpose === 'github-link'` — handling the link in-place, or delegating to `handleLoginOAuthCallback` for login.

The new design **intercepts both routes with GitHub-specific handlers** that read App OAuth credentials from D1 and use Octokit end-to-end, bypassing the env-var-driven generic dispatcher for GitHub.

**1. New GitHub-specific login route group** — mounted in `packages/worker/src/index.ts` **before** `app.route('/auth', oauthRouter)`, so that Hono's route-order-based matching catches GitHub first:

```typescript
// New in index.ts, mounted before oauthRouter
app.route('/auth/github', githubAuthRouter);
// Existing, catches everything else
app.route('/auth', oauthRouter);
```

`githubAuthRouter` is a new Hono router in `packages/worker/src/routes/github-auth.ts` with two routes:

- `GET /` (matches `/auth/github`) — initiates login. Loads App OAuth credentials from D1 via `services/github-app.ts`, creates the standard login state JWT (matching `oauth.ts::createStateJWT`, 5-minute TTL), builds the authorize URL via `app.oauth.getWebFlowAuthorizationUrl({ state })`, and redirects. Does NOT call `resolveProviderConfig` — no env-var dependency.
- `GET /callback` (matches `/auth/github/callback`) — handles the callback for both login and link. Branches on `payload.purpose`:
  - If `purpose === 'github-link'` → delegates to the existing link handler (which is moved from `githubMeCallbackRouter` into a shared helper, since `githubMeCallbackRouter` is no longer the owner of the callback URL)
  - Otherwise (login) → calls `app.oauth.createToken({ code })` via Octokit, fetches the user profile (`GET /user`, `GET /user/emails`) to build an `IdentityResult`, then calls `oauthService.finalizeIdentityLogin(env, identity, 'github', inviteCode)` and redirects to the frontend. This bypasses `provider.handleCallback` entirely — the identity provider's callback logic is dead code for GitHub.

Because this router is mounted before `oauthRouter`, the generic `/auth/:provider` and `/auth/:provider/callback` handlers are never invoked for GitHub. The `githubMeCallbackRouter.get('/callback')` in `github-me.ts` is removed (or its logic is moved into `github-auth.ts` as the shared branching handler).

**2. Identity provider fate** (`packages/plugin-github/src/identity.ts`):

`githubIdentityProvider.configKeys` is changed to `[]` (empty — no env-var dependencies). `getAuthUrl` and `handleCallback` become unreachable for GitHub because the new `github-auth.ts` router handles both legs directly. They are either:
- **Deleted** entirely (cleanest) and the provider is removed from `installedIdentityProviders` in `identity/packages.ts`, or
- **Kept as dead-code stubs** that throw "use github-auth router instead" if called, so the registry still lists GitHub as an available login provider for `/auth/providers` listing purposes.

Option (b) is simpler — the provider still appears in the `/auth/providers` endpoint and the frontend login page, but the registry's `get()` → `handleCallback()` path is never invoked because the router intercepts first. The registry listing is the only thing the provider is used for.

**3. `/api/me/github/link` initiation endpoint** (`githubMeRouter.post('/link')`):

Remains. Updated to use `appOauthClientId` / `appOauthClientSecret` from D1, build the authorize URL via Octokit, and use a 10-minute state JWT (matching the existing TTL for link flows) with `purpose: 'github-link'`. The callback it redirects to is still `{workerUrl}/auth/github/callback`, now handled by `github-auth.ts` instead of `github-me.ts`.

**4. Env var contract change**: `GITHUB_CLIENT_ID` and `GITHUB_CLIENT_SECRET` are no longer referenced anywhere in the worker. They are removed from the worker's env schema (`packages/worker/src/env.ts`). Any developer tooling or tests that set them is updated. `identity.ts::configKeys` becomes `[]`.

**5. User record fields**: `users.githubId`, `users.githubUsername` continue to exist and are populated on login/link as today. The unique index `idx_users_github_id` is preserved.

**Scopes vs permissions**: classic OAuth requested `read:user user:email read:org` (plus `repo` for integration-linking). GitHub Apps don't use scopes — the `scope` query parameter on the authorize URL is ignored. Instead, the App's declared permissions govern what user access tokens can do. The login flow only needs the user's profile + email, which are always accessible to user access tokens. Integration linking previously requested `repo` scope — with the App, repo access is conveyed by installation, not by the user token's scope. If a user wants the agent to reach their personal repos, they install the App on their personal account.

### Octokit integration

The Valet worker instantiates Octokit's [`App` class](https://github.com/octokit/octokit.js) per request (cached within a request's lifecycle) from the stored App configuration:

```typescript
import { App } from 'octokit';

const app = new App({
  appId: config.appId,
  privateKey: config.appPrivateKey,
  oauth: {
    clientId: config.appOauthClientId,
    clientSecret: config.appOauthClientSecret,
  },
  webhooks: {
    secret: config.appWebhookSecret,
  },
});
```

This single instance provides:

- **JWT generation** via `app.octokit` — used to list installations, manage App metadata
- **Installation Octokit instances** via `app.getInstallationOctokit(installationId)` — mints 1hr installation access tokens
- **OAuth URL generation** via `app.oauth.getWebFlowAuthorizationUrl({ state })`
- **OAuth code exchange** via `app.oauth.createToken({ code })`
- **OAuth token refresh** via `app.oauth.refreshToken({ refreshToken })`
- **OAuth token deletion** via `app.oauth.deleteToken({ token })`
- **Webhook signature verification** via `app.webhooks.verifyAndReceive({ ... })`

#### Cloudflare Worker runtime compatibility

Workers run in `workerd` (V8 isolate) with `nodejs_compat` flag. Not all npm packages work. Before adoption, the implementation must verify:

1. `octokit`, `@octokit/auth-app`, `@octokit/oauth-app`, `@octokit/webhooks` bundle and run under `workerd` with `nodejs_compat`. The risk area is `@octokit/auth-app`, which historically used `jsonwebtoken` (depends on Node `crypto`). Recent versions use `universal-github-app-jwt` which works in Web Crypto; this must be confirmed at the versions we pin.
2. Fetch overrides work — Octokit must use the Workers `fetch` (not Node's).

**Fallback plan**: if any package is incompatible, keep the existing hand-rolled JWT signer (`services/github-app-jwt.ts`, uses `crypto.subtle`) and use Octokit's `customAuthentication` hook to supply externally-signed JWTs (the library supports this via the `createJwt` callback). Only the JWT minting is at risk — the REST client, OAuth client, and webhooks package are pure fetch + Web Crypto and should work.

**Token refresh via Octokit**: `app.oauth.refreshToken({ refreshToken })` works because the `App` class's internal wiring of `OAuthApp` hardcodes `clientType: 'github-app'` when the `oauth` option is provided (verified in `@octokit/app` source: `new OAuthApp({ ...options.oauth, clientType: "github-app", Octokit })`). Refresh support is enabled automatically — no standalone `OAuthApp` instance required.

#### Installation token caching

Octokit's `@octokit/auth-app` caches installation tokens in an in-memory LRU of up to 15,000 entries. In a Cloudflare Worker, **in-memory caches do not survive between requests** reliably — each invocation may get a fresh isolate. Relying on the in-memory cache alone means every request that needs an installation token mints a new one, wasting ~200ms per call.

**Caching strategy**: store the minted installation token directly on the `github_installations` row in D1. Two columns are added to the table:

- `cached_token_encrypted TEXT` — installation access token encrypted via PBKDF2 using `ENCRYPTION_KEY` (same helper as `credentials.ts`)
- `cached_token_expires_at TEXT` — ISO timestamp

The resolver already SELECTs the installation row by `account_login` to find it — including the cached token fields in that same SELECT makes cache hits free. Cache miss = one extra UPDATE per mint, at most once per hour per installation.

A `getOrMintInstallationToken(app, db, encryptionKey, installationRow)` helper wraps the cache-check and fresh-mint logic. It checks the cache (with a 5-minute safety margin before expiry), mints fresh if the cache is missing or near-expiry, and writes the encrypted token back to D1.

**Why not KV**: we're already in D1, installations are a small table (one row per installation, writes are infrequent — at most hourly per installation), the cache state lives naturally alongside the installation metadata, and we avoid adding a new binding. If the project later needs higher-frequency caching across many installations, migrating to KV is a targeted follow-up.

**Dependencies to add**:

- `octokit` (meta-package, pulls in the rest)
- Transitive: `@octokit/auth-app`, `@octokit/oauth-app`, `@octokit/webhooks`, `@octokit/rest`

**API calls**: The GitHub plugin replaces its `githubFetch` wrapper with Octokit REST methods. For user-token calls, construct `new Octokit({ auth: userToken })`; for installation-token calls, use `app.getInstallationOctokit(id)`. Pagination via `octokit.paginate(...)` replaces manual page loops. See [rate limits for the REST API](https://docs.github.com/en/rest/overview/rate-limits-for-the-rest-api).

**Throttle plugin**: `@octokit/plugin-throttling` is not included by default in the `octokit` meta-package. We add it explicitly if we want backoff/retry. **Decision**: opt in to the throttle plugin with a conservative `onRateLimit` handler that retries once after `retry-after`. Backoff delays inside a Worker request must stay under the CPU time budget (30s on paid plans); we cap the total wait at 5 seconds.

### Installation tracking

A new table tracks all installations:

```sql
CREATE TABLE github_installations (
  id TEXT PRIMARY KEY,                      -- UUID
  github_installation_id TEXT NOT NULL UNIQUE,  -- from GitHub; stored as TEXT to avoid JS number precision issues
  account_login TEXT NOT NULL,              -- GitHub user/org login (mutable)
  account_id TEXT NOT NULL,                 -- GitHub numeric user/org ID, stored as TEXT (immutable)
  account_type TEXT NOT NULL,               -- 'Organization' | 'User'
  linked_user_id TEXT REFERENCES users(id) ON DELETE SET NULL,  -- Valet user ID, NULL for org installs and orphaned personal installs
  status TEXT NOT NULL DEFAULT 'active',    -- 'active' | 'suspended' | 'removed'
  repository_selection TEXT NOT NULL,       -- 'all' | 'selected'
  permissions TEXT,                         -- JSON of permissions granted
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_github_installations_account_login
  ON github_installations(account_login);
CREATE INDEX idx_github_installations_account_id
  ON github_installations(account_id);
CREATE INDEX idx_github_installations_linked_user
  ON github_installations(linked_user_id)
  WHERE linked_user_id IS NOT NULL;
```

**Type decisions**:

- `github_installation_id` is stored as **TEXT** (not `INTEGER`). GitHub's REST API returns installation IDs as JSON numbers; current real-world values are well under `Number.MAX_SAFE_INTEGER` (2^53), so the precision risk is theoretical rather than observed. However, Octokit returns these as JS `number` in typed payloads, and Drizzle's SQLite integer type also returns `number` — storing as TEXT is a defensive choice so we never have to audit the math. The `String(n)` conversion happens at the Valet boundary (when writing to the `github_installations` table or reading from webhook payloads); Octokit itself returns `payload.installation.id` as a number.
- `account_id` same reasoning — stored as TEXT. It is the **stable** identifier (unlike `account_login` which is mutable on rename).

**Multi-tenant note**: this table does not include an `org_id` column. Valet's current single-tenant model uses the `'default'` org key throughout (see `getOrgSettings()` in `lib/db.ts`). If multi-tenancy is added later, this schema is extended with `org_id` and the unique constraint becomes `(org_id, github_installation_id)`. Out of scope here.

**Installation discovery happens in three ways:**

1. **Admin refresh** (existing pattern, rewritten). Admin clicks "Refresh installations" on the settings page. Worker authenticates as the App (JWT) and paginates [`GET /app/installations`](https://docs.github.com/en/rest/apps/apps#list-installations-for-the-authenticated-app) via `app.octokit.paginate('GET /app/installations')`. Upserts all installations. For each personal installation (`account_type === 'User'`), the worker tries to link to an existing Valet user by matching **`account_id`** (GitHub numeric user ID) against `users.githubId` — this field is populated during GitHub login/link flows and is the stable identifier. Matching by `account_login` is incorrect because logins are mutable. The existing single-installation-enforcement logic (`Found N installations but expected exactly one`) is removed. The existing `storeCredential(credentialType: 'app_install')` write is removed — installation tokens are minted on-demand, not persisted.

2. **Webhook-driven** — `installation.created`, `installation.deleted`, `installation.suspend`, `installation.unsuspend` events upsert/update rows in real time. See [Webhooks](#webhooks).

3. **User OAuth flow** — when a user completes the OAuth flow (login or link), the worker fetches their GitHub profile (`GET /user`) to get `account_id`, then calls [`GET /user/installations`](https://docs.github.com/en/rest/apps/installations#list-app-installations-accessible-to-the-user-access-token) with the new user token. Any installation returned that has `account_type === 'User'` and matches the user's GitHub `account_id` gets `linked_user_id` set to that Valet user. This reconciles orphaned personal installations into linked installations.

**Post-install callback flow**: when a user clicks "Install on your personal GitHub account" from the Valet integrations page, Valet first generates a signed state JWT (`{ purpose: 'github-install', sub: valetUserId, exp: +10min }`) and redirects the browser to `https://github.com/apps/{appSlug}/installations/new?state={jwt}`. GitHub carries `state` through the install flow and redirects to the App's `setup_url` (`{workerUrl}/repo-providers/github/install/callback`) with `installation_id`, `setup_action`, and `state` query parameters. This callback is unauthenticated from a cookie perspective (GitHub initiates the redirect, so third-party cookies may be blocked); it identifies the Valet user via the signed state JWT:

1. Verify the signed `state` JWT; extract `sub` (Valet user ID) and `purpose` (`'github-install'`)
2. Fetch the installation from GitHub via the App JWT (`GET /app/installations/{installation_id}`)
3. Upsert a `github_installations` row, setting `linked_user_id` to the Valet user from `state.sub` (cross-check that `installation.account.id` matches the Valet user's `users.githubId`, error if mismatch — someone is trying to install on a GitHub account they haven't linked to Valet)
4. Redirect to `/settings/integrations?github=installed`

**`request_oauth_on_install` caveat**: if the manifest sets `request_oauth_on_install: true`, GitHub initiates a fresh OAuth authorize flow **after** the install completes. GitHub's docs do not explicitly specify whether the install `state` parameter round-trips into that subsequent OAuth leg, which makes the user-linkage semantics of the auto-triggered flow non-deterministic from our perspective. **Decision**: set `request_oauth_on_install: false` in the manifest. Rather than rely on undocumented behavior, Valet initiates the OAuth link flow itself after the install callback returns (if the user isn't already linked), using the signed state mechanism it fully controls. This gives us deterministic state handling at the cost of one extra redirect. If a smoke test during implementation shows that state *does* round-trip, we can revisit this decision.

The existing `repo-providers.ts` install callback currently takes an `orgId` from the state JWT and stores an org-scoped `app_install` credential. Under the new design, `orgId` is dropped from the state (single-tenant assumption holds), and `storeCredential(app_install)` is replaced by `upsertGitHubInstallation`. The obsolete metadata backfills (`accessibleOwners`, `repositoryCount`) are also removed — the `github_installations` table is the new source of truth.

### User OAuth flow

Connecting GitHub on the integrations page uses the App's built-in OAuth client. The flow follows GitHub's [user access token generation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app):

1. User clicks "Connect GitHub" on `/settings/integrations`
2. Worker calls `app.oauth.getWebFlowAuthorizationUrl({ state })` where `state` is a **self-contained signed JWT** containing `{ purpose: 'github-link', sub: valetUserId, iat, exp, sid: randomNonce }`. Signed with `ENCRYPTION_KEY`, TTL 10 minutes (matching existing `github-me.ts::POST /link` behavior). The signature alone is enough for CSRF prevention — no server-side nonce store is required. Login flows (via `github-auth.ts` initiation) use the same pattern but with a 5-minute TTL to match `oauth.ts::createStateJWT`.
3. Browser redirects to the GitHub authorize URL
4. User authorizes on GitHub
5. GitHub redirects to `{workerUrl}/auth/github/callback?code=...&state=...`
6. The new `github-auth.ts` callback handler verifies the state JWT. If `payload.purpose === 'github-link'`, handles link; else runs the login flow.
7. For the link path: worker calls `app.oauth.createToken({ code })` via Octokit
8. Octokit exchanges the code and returns `{ authentication: { token, refreshToken, expiresAt, refreshTokenExpiresAt, ... } }`. The token fields are **nested under `authentication`** — this is the actual return shape from `@octokit/oauth-app`'s `createToken()`, not a flattened object. `refreshToken()` returns the same nested shape.
9. Worker calls `GET /user` with `authentication.token` to retrieve the user's GitHub login, id, and email
10. Worker stores the token pair in `credentials` table as `ownerType='user', provider='github', credentialType='oauth2'`, with metadata including `github_login` and `github_user_id` (matching the existing `user_identity_links` schema)
11. Worker calls `GET /user/installations` and reconciles any matching orphaned personal installations by joining on `account_id`
12. Worker creates/updates the `integrations` row with `status='active'` via existing `ensureIntegration` helper
13. Browser redirects back to `/settings/integrations?github=linked`

**Login flow follows the same steps**, except step 6 delegates to `handleLoginOAuthCallback`, which dispatches to the GitHub-specific login handler. The GitHub login handler uses Octokit for the code exchange, then calls `finalizeIdentityLogin` as today. The net effect: login now uses App OAuth credentials instead of classic OAuth env vars, and the resulting user access token is also stored in `credentials` (so login implicitly links the integration). This unification is intentional — having GitHub login also populate the integration credential simplifies the user experience (one click does everything).

**Token refresh**: When a stored user access token is expired or near-expired (within 5 minutes of `expires_at`), the credential service calls `app.oauth.refreshToken({ refreshToken: stored.refresh_token })` via Octokit. The response shape is `{ authentication: { token, refreshToken, expiresAt, refreshTokenExpiresAt } }` — same nested shape as `createToken`. Worker stores the new token pair. The old refresh token is invalidated on refresh (per [refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)), so both tokens must be updated atomically. The existing `credentials.ts` refresh logic is rewritten to use Octokit instead of hand-rolled fetch.

**Refresh token expiry**: If the 6-month refresh token itself is expired, `refreshToken()` fails. The credential service deletes the credential row and marks the integration `status='error'`. The agent surfaces "GitHub connection expired, please reconnect" when a GitHub action is attempted. No automated re-auth.

**Duplicate GitHub account detection**: When a user connects GitHub and the returned `github_user_id` is already stored on a *different* Valet user's record (`users.githubId`), the callback rejects the link with an explicit error. The `users` table has `CREATE UNIQUE INDEX idx_users_github_id ON users(github_id)`, but that only enforces uniqueness on writes — the callback must perform an explicit lookup and error out cleanly with a user-facing message before attempting the write. This avoids silent overwrites or 500 errors from the unique constraint.

**Disconnect**: The user clicks "Disconnect" on the integrations page. Worker calls `app.oauth.deleteToken({ token })` to revoke on GitHub, then deletes the credential row, clears `users.githubId` / `users.githubUsername`, and deletes the identity link. Does NOT uninstall the App from any GitHub accounts — installations persist independently of user-token links.

### Credential resolution

The resolution chain, given a Valet user `U` and an optional repository owner `O`:

```
1. User U has a linked GitHub account (oauth2 credential row)?
   YES → refresh if needed, return the user access token
   NO  → continue

2. allowAnonymousGitHubAccess is true?
   NO  → return error "GitHub account not connected"
   YES → continue

3. Repository owner O is known and matches an active installation in github_installations
   (join: account_login = O, status = 'active')?
   MATCH FOUND → mint installation token via getOrMintInstallationToken (D1-cached on the installation row),
                 return token + attribution metadata (user's name + email)
   NOT FOUND OR REPO CONTEXT ABSENT → continue

4. Any active installation exists at all (for no-repo-context actions like list_repos)?
   YES → use that installation's bot token (prefer org installations over personal) + attribution
   NO  → return error "No GitHub access available"
```

**Rationale for dropping the unauthenticated-Octokit path**: GitHub's unauthenticated rate limit is 60 requests per hour per IP. In a Cloudflare Worker, that IP is shared across all egress traffic from a given datacenter, making the limit effectively useless at scale. Instead, if any installation bot token can be minted, use it — installation tokens get 5,000 req/hr (or more with scaling). Public repos are readable via any valid installation token, so "public fallback" is implicitly handled.

**If no installation exists at all AND the user is unlinked, the action fails**. This is acceptable because an admin installing the App on at least one org is a prerequisite for anonymous GitHub access.

**No more `source` parameter on actions**. The current design adds `source?: 'personal' | 'org'` to every GitHub action. With user tokens covering all accessible installations, the parameter is meaningless and is removed.

**No more `accessibleOwners` cache**. We use a direct DB lookup against `github_installations` when the bot-token fallback is needed. No cache, no TTL, no staleness.

**Resolver return type — backward-compatible with existing contract**:

The existing `CredentialResolver` returns a `CredentialResult` with a plain `accessToken: string`, and this shape is consumed by every other resolver (slack, google, default, etc.) and by `ResolvedCredential` in `services/credentials.ts`. Changing the return type to a discriminated union breaks all of them.

**Decision**: keep the resolver returning `CredentialResult` with a plain `accessToken: string`. Attribution is carried as a separate field on the `CredentialResult`:

```typescript
// Addition to CredentialResult
interface CredentialResult {
  accessToken: string;
  credentialType: string;
  // ... existing fields ...
  /** Present when the credential is a bot token being used on behalf of a user. */
  attribution?: {
    name: string;
    email: string;
  };
}
```

The GitHub plugin actions receive `ctx.credentials.access_token` as today. A new `ctx.attribution` field (optional) is added to `ActionContext` in `@valet/sdk`, populated from `CredentialResult.attribution`. Actions that produce user-visible content check for it and inject identity markers. Actions that don't care ignore it.

This keeps the resolver contract generic, doesn't leak Octokit types across the plugin boundary, and makes attribution opt-in per-action.

**ActionContext change**:

```typescript
// packages/sdk/src/integrations/index.ts (or wherever ActionContext lives)
interface ActionContext {
  credentials: Record<string, string>;
  userId: string;
  sessionId?: string;
  // ... existing fields ...
  /** Set when the resolved credential is a bot token acting on behalf of a user. */
  attribution?: {
    name: string;
    email: string;
  };
}
```

This is a non-breaking additive change. Other plugins ignore the new field.

**Plugin-internal Octokit usage**: the GitHub plugin constructs its own `Octokit` instance from `ctx.credentials.access_token`. It does not import the App-level `Octokit` or receive pre-built instances from the worker. The plugin's `package.json` adds `octokit` as a direct dependency.

**CredentialCache simplifications**: The cache tracks one entry per user for GitHub (`user:{userId}:github:oauth2`). The `credentialType` dimension added by the multi-credential routing design is reverted. **Scope check**: the `credentialType` dimension was added solely to disambiguate GitHub `oauth2` vs `app_install`; no other resolver (slack, google, default) relies on it. Reverting is safe. If another service later needs multiple credential types per user, re-add the dimension at that time. Installation tokens are cached on the `github_installations` row in D1 (see [Installation token caching](#installation-token-caching)), not in `CredentialCache`.

**What gets removed**:

- `packages/worker/src/integrations/resolvers/github.ts` — rewritten (much simpler, implements the new chain)
- `CredentialSourceInfo`, `credentialSources` arrays, `skipScope` / fallthrough retry — reverted in `integrations/registry.ts`, `services/session-tools.ts`, `session-agent.ts`
- `source` parameter from every action in `packages/plugin-github/src/actions/actions.ts`
- `accessibleOwners` field and cache in `session-agent.ts`
- `_credential_type` branching in actions where possible. The `list_repos` action still needs to switch between `GET /user/repos` (user token) and `GET /installation/repositories` (installation token). The switch is driven by the absence/presence of `ctx.attribution` (attribution present ⇒ using bot token ⇒ use `/installation/repositories`).
- `app_install` credential type handling in `credentials.ts` and all stored `app_install` rows in the `credentials` table

### `resolveRepoCredential` and repo providers

The existing `resolveRepoCredential` path (used for sandbox git cloning and the repo-picker UI) relies on two repo providers: `githubOAuthRepoProvider` (uses stored OAuth token) and `githubAppRepoProvider` (mints installation tokens from stored `appId` + `privateKey` in credential metadata).

Under the new design:

- `githubOAuthRepoProvider` is renamed to `githubUserRepoProvider` and operates on user access tokens from `credentials` (`credentialType='oauth2'`). Its `mintToken` is a no-op (user tokens are refreshed via the credential service, not minted fresh).
- `githubAppRepoProvider` is rewritten to not rely on `credential.metadata.appId` / `privateKey` (since `app_install` credential rows are deleted). Instead, its `mintToken` calls into the new `services/github-app.ts` → `app.getInstallationOctokit(installation_id)` directly, using the `installation_id` carried in `RepoCredential`. The installation ID is populated from `github_installations` at credential resolution time.
- Repo listing in `githubAppRepoProvider` uses the Octokit instance from the installation to call `GET /installation/repositories` and `GET /search/repositories`.
- The attribution fields added to `ActionContext` are mirrored in `RepoCredential` so that sandbox git configs can set `user.name`/`user.email` to the Valet user when using a bot token, instead of the current hardcoded `valet[bot]`.

This keeps the sandbox cloning path working without requiring a broader refactor of the repo-provider abstraction.

### Attribution injection

When `ctx.attribution` is present, the action is executing under a bot token but should be attributed to the initiating Valet user. The `attribution` object carries the user's name and email, which actions use to inject identity into any user-facing content:

- **Commits**: `Co-Authored-By: {name} <{email}>` trailer appended to commit message body
- **Pull requests**: body is appended with `\n\n---\n> Created on behalf of {name} <{email}>`
- **Issues**: same pattern as PRs
- **Issue/PR comments**: body is prepended with `*On behalf of {name} <{email}>:*\n\n`
- **Review comments**: same prepend as comments
- **Commit comments**: same prepend as comments
- **Any other action that produces user-visible text**: follows the same pattern; actions without user-visible content (reading data, listing repos, etc.) don't inject anything

Attribution is always included verbatim — both the display name and the email. This makes audit trails unambiguous even when display names collide.

Attribution cannot be forged by the agent: `ctx.attribution` is set by the credential resolver from the authenticated Valet user's profile, not from agent input. The agent cannot inject arbitrary attribution.

### Webhooks

A single webhook endpoint handles all GitHub App events:

**Route**: `POST /webhooks/github` (existing endpoint, handler rewritten to use Octokit verification)

**Verification**: Octokit's `app.webhooks.verifyAndReceive({ id, name, signature, payload })` handles HMAC signature verification using the stored `appWebhookSecret`. See [using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps).

**Raw body handling**: Octokit's `verifyAndReceive` requires the **raw, unparsed request body** (HMAC is computed over the exact bytes). In Hono, `c.req.raw.clone().text()` reads the body while preserving it for later reads. No middleware may consume the body before the webhook route. The current webhook handler already does this pattern (`const rawBody = await c.req.raw.clone().text()`), so no new plumbing is needed — the signature verification call site changes but the body capture stays the same.

**In-scope event handlers**:

**Installation lifecycle** (new):

- `installation.created` → upsert `github_installations` row. If `account_type === 'User'`, try to link to a Valet user by matching `account_id` against `users.githubId`; set `linked_user_id` if matched.
- `installation.deleted` → mark row as `status='removed'` (soft delete, preserves audit trail)
- `installation.suspend` → `status='suspended'`
- `installation.unsuspend` → `status='active'`
- `installation.new_permissions_accepted` → update `permissions` field
- `installation_repositories.added` / `installation_repositories.removed` → no-op for now (we don't track per-repo access)
- `installation_target.renamed` → look up the row by the installation ID from the payload (`payload.installation.id`) and update `account_login` to the new login. `account_id` is the stable identifier and does not change on rename.

**Session state** (preserved from current handler):

- `pull_request` → invoke existing `webhookService.handlePullRequestWebhook` — updates `session_git_state` for sessions tracking the PR, handles state transitions (opened, synchronize, closed, merged), increments commit counts
- `push` → invoke existing `webhookService.handlePushWebhook` — increments commit counts and updates session git state

These are NOT "workflow trigger routing"; they are core session state management that must continue to work. The new webhook handler preserves these calls unchanged.

**Out-of-scope event handlers (deferred)**:

Workflow-trigger fan-out — dispatching events like `issues`, `issue_comment`, `pull_request_review`, `release`, `workflow_run`, etc. to configured workflow triggers or orchestrators (personal vs org) — is NOT in scope for this design. Routing these requires building a cross-cutting event router that determines event targets (personal orchestrator based on `installation.account` matching a `linked_user_id`, or org orchestrator otherwise) and dispatches through the orchestrator mailbox.

The webhook handler includes a catch-all for unhandled events with an explicit TODO comment:

```typescript
app.webhooks.onAny(async ({ id, name, payload }) => {
  // Already handled above: installation.*, pull_request, push.
  const handled = new Set([
    'installation', 'installation_repositories', 'installation_target',
    'pull_request', 'push',
  ]);
  if (handled.has(name)) return;
  // TODO(event-routing): Route workflow-trigger events (issues, issue_comment,
  // release, workflow_run, etc.) to the correct orchestrator. Requires building
  // an event router that determines whether an event targets a personal
  // orchestrator (based on installation.account.id matching a linked_user_id in
  // github_installations) or an org orchestrator, then dispatches through the
  // orchestrator mailbox. Tracked separately.
  console.log('[github webhook] unhandled event', { id, name });
});
```

### Admin UI

Admin settings page at `/settings/integrations/github`:

**App status card**

- **Not configured** state: "Create GitHub App" button. Opens modal with options: "Create under personal account" / "Create under organization (enter org name)". Submits to the existing manifest flow.
- **Configured** state: App name, slug, owner, creation date, link to GitHub App settings page, "Refresh installations" button.
- **Settings block**:
  - Toggle: `Allow personal installations`
  - Toggle: `Allow anonymous GitHub access`

**Refresh rate limit**: the "Refresh installations" admin action is rate-limited to 1 call per minute (best-effort, module-level timestamp). Simple guard, short decision.

**Installations section**

- **Organization installations** (always expanded): table with columns `Account`, `Repos`, `Status`, `Created`, `Actions`. Actions column has a link to GitHub App settings for that installation.
- **Personal installations** (collapsible, collapsed by default, header shows count): table with columns `GitHub login`, `Linked Valet user`, `Repos`, `Status`, `Created`.
- **Orphaned installations** (collapsible, only shown if count > 0): personal installations where `linked_user_id` is NULL. Useful for admin debugging.

**Danger zone**

- "Remove App configuration" — deletes the `org_service_configs` row, soft-deletes all `github_installations` rows, deletes all stored GitHub `oauth2` credentials for all users. Does **not** call `app.oauth.deleteToken` for each user (would require N API calls and the App is about to be removed anyway — GitHub will orphan the tokens). Confirmation dialog warns that this interrupts any active sessions using GitHub, and users will need to reconnect. This is distinct from the migration behavior, which preserves tokens — the danger-zone action is an intentional nuke.

**Removed from admin UI**:

- The entire "OAuth App credentials" panel (classic OAuth fields)
- The OAuth vs App split

### User integration UI

GitHub card on `/settings/integrations`:

**Not connected state**

- "Connect GitHub" button → redirects to `app.oauth.getWebFlowAuthorizationUrl()` URL
- If `allowPersonalInstallations === true`: also shows "Install on personal GitHub account" link → Valet generates a signed `github-install` state JWT and redirects to `https://github.com/apps/{appSlug}/installations/new?state={jwt}` in a new tab (see [Installation tracking](#installation-tracking) for the full post-install flow).
- If `allowAnonymousGitHubAccess === true`: info banner "GitHub is available via shared access — connecting your account enables better attribution"
- If `allowAnonymousGitHubAccess === false` and user has no connection: banner "GitHub connection required for agent sessions"

**Connected state**

- Avatar + GitHub username
- List of installations accessible to this user (from `GET /user/installations`): each row shows account login, account type, repo count
- If `allowPersonalInstallations === true` and user does not yet have a personal installation: "Install on your personal account" link
- "Disconnect" button → revokes token via `app.oauth.deleteToken()`, deletes credential row, sets integration status to `disconnected`

### Data model summary

**New table**: `github_installations` (see [Installation tracking](#installation-tracking))

**`org_service_configs` changes** (data migration, not schema migration):

The table schema is unchanged — `encrypted_config` is a single TEXT blob containing JSON. A data migration script decrypts each row, removes the `oauthClientId` / `oauthClientSecret` fields from the JSON, and re-encrypts. Metadata JSON is similarly updated: remove `appInstallationId`, `accessibleOwners`, `accessibleOwnersRefreshedAt`, `repositoryCount`; add `allowPersonalInstallations`, `allowAnonymousGitHubAccess`.

**`credentials` table changes**:

- Delete all rows with `provider = 'github' AND credentialType = 'app_install'`
- **Keep** rows with `provider = 'github' AND credentialType = 'oauth2'` — users with existing tokens don't lose them immediately. On first refresh attempt, Octokit's `refreshToken` will fail (because those tokens were issued under the classic OAuth client, not the App's OAuth client), and the row will be deleted then. User sees "GitHub connection expired, please reconnect" and reconnects naturally. This avoids interrupting in-flight sessions mid-action — they keep working as long as the stored access token is still valid (until it expires or is rejected).
- No schema change to the table itself

**`integrations` table**: no change. Existing `scope` column still distinguishes user-scoped vs org-scoped. After this design, GitHub integrations are effectively user-scoped only (bot-token fallback doesn't create integration rows). The `scope` column remains for other services.

### File inventory

| File | Change |
|------|--------|
| `packages/worker/src/services/github-app.ts` | **NEW** — Octokit `App` instance factory, config loading, installation token minting with D1-backed cache on `github_installations`, OAuth helpers (getAuthorizeUrl, exchangeCode, refreshToken, revokeToken) |
| `packages/worker/src/services/github-installations.ts` | **NEW** — CRUD, installation discovery, reconciliation |
| `packages/worker/src/services/github-config.ts` | Update `GitHubServiceConfig` / `GitHubConfig` to drop `oauthClientId` / `oauthClientSecret` classic fields; make App OAuth credentials required |
| `packages/worker/src/routes/admin-github.ts` | Rewrite: remove classic OAuth endpoints (`PUT /oauth`, `DELETE /oauth-credentials`), update App setup flow, add installations list endpoint, add toggles, remove single-installation enforcement in refresh, remove `storeCredential(app_install)` write |
| `packages/worker/src/routes/github-me.ts` | Update: `/api/me/github/link` uses `appOauthClientId` / `appOauthClientSecret` via Octokit (10-minute state JWT, `purpose: 'github-link'`); `/api/me/github/link` DELETE simplification (drop the `'preserve any app_install credential'` comment and the `credentialType='oauth2'` filter since `app_install` rows no longer exist); `githubMeCallbackRouter` is removed — the callback is now owned by `github-auth.ts` and mounted at `/auth/github/callback` |
| `packages/worker/src/routes/github-auth.ts` | **NEW** — GitHub-specific auth router mounted at `/auth/github` **before** `oauthRouter` in `index.ts`. Handles `GET /` (login initiation via Octokit) and `GET /callback` (both login and link, branching on state JWT purpose). Bypasses the generic env-var-driven `oauthRouter` dispatch for GitHub entirely. Calls into `oauthService.finalizeIdentityLogin` for login success. |
| `packages/worker/src/routes/oauth.ts` | No functional change — the GitHub-specific router takes precedence via mount order in `index.ts`. The generic `:provider` handler remains for Google and other providers. |
| `packages/worker/src/index.ts` | Mount `githubAuthRouter` at `/auth/github` **before** mounting `oauthRouter` at `/auth`, so Hono's route-matching catches GitHub first. |
| `packages/worker/src/routes/webhooks.ts` | Rewrite the `/webhooks/github` handler: use Octokit `verifyAndReceive`, add installation lifecycle handlers, preserve existing PR/push session state handlers, add catch-all with TODO |
| `packages/worker/src/routes/repo-providers.ts` | Update post-install callback at `/repo-providers/github/install/callback`: verify signed state JWT (`purpose: 'github-install'`, `sub` = Valet user ID); drop the `orgId` field from the state payload (no longer needed); replace `storeCredential(app_install)` with `upsertGitHubInstallation`; remove `accessibleOwners` and `repositoryCount` metadata backfill (obsolete — `github_installations` is the new source of truth); cross-check that `installation.account.id` matches `users.githubId` for the Valet user |
| `packages/worker/src/integrations/resolvers/github.ts` | Rewrite: new resolution chain (user → installation → fail), returns plain `CredentialResult` with optional `attribution` |
| `packages/worker/src/integrations/registry.ts` | Revert `CredentialSourceInfo` plumbing added by multi-credential routing design; `CredentialResolverContext` simplifies back to `{ params?, forceRefresh? }` |
| `packages/worker/src/integrations/resolvers/default.ts` | Revert to match simplified contract |
| `packages/worker/src/services/credentials.ts` | Use Octokit for GitHub user-token refresh; remove `app_install` credential type handling; add `attribution` field to `CredentialResult` |
| `packages/worker/src/services/session-tools.ts` | Revert `credentialSources[]` plumbing; simplify `resolveActionPolicy` / `executeAction`; thread `attribution` through `ActionContext` |
| `packages/worker/src/durable-objects/session-agent.ts` | Remove `accessibleOwners` cache, revert `credentialType` dimension from `CredentialCache`, remove approval-context backward-compat shim for `credentialSources` |
| `packages/worker/src/lib/schema/github-installations.ts` | **NEW** — Drizzle schema for `github_installations` |
| `packages/worker/src/lib/db/github-installations.ts` | **NEW** — query helpers |
| `packages/worker/migrations/NNNN_create_github_installations.sql` | **NEW** — create table + indexes |
| `packages/worker/migrations/NNNN_rewrite_github_service_config.ts` | **NEW** — data migration script (runs during deploy) that decrypts each `org_service_configs` row for `service='github'`, rewrites the JSON to remove classic OAuth fields and set new metadata, re-encrypts. Also deletes `github/app_install` credential rows. |
| `packages/plugin-github/src/identity.ts` | Deprecate to a stub: set `configKeys = []`; `getAuthUrl` and `handleCallback` are no longer invoked for GitHub (intercepted by `github-auth.ts`). Kept only so that `installedIdentityProviders` still lists GitHub for `/auth/providers` enumeration. `handleCallback` throws "use github-auth router" if called. Alternative: delete entirely and remove GitHub from the identity provider registry, with the frontend fetching available login providers from a new source. |
| `packages/plugin-github/src/actions/actions.ts` | Remove `source` parameter from all actions, add attribution injection for relevant actions; use `ctx.attribution` to decide injection; switch `list_repos` endpoint based on attribution presence |
| `packages/plugin-github/src/actions/api.ts` | Remove `githubFetch`; actions construct Octokit from `ctx.credentials.access_token` |
| `packages/plugin-github/src/actions/provider.ts` | Update `ActionContext` type import (attribution field) |
| `packages/plugin-github/src/repo-oauth.ts` | Rename to `githubUserRepoProvider`; operate on user access tokens only; `mintToken` is a no-op |
| `packages/plugin-github/src/repo-app.ts` | Rewrite `mintToken` to delegate to worker-side `services/github-app.ts` for installation token minting (no longer reads `appId`/`privateKey` from credential metadata); git config `user.name`/`user.email` use attribution when present |
| `packages/plugin-github/src/repo-shared.ts` | Update `mintInstallationToken` to use Octokit under the hood (or delete if no longer needed) |
| `packages/plugin-github/skills/github.md` | Rewrite: reflect single-token model, no `source` param, attribution behavior |
| `packages/sdk/src/integrations/*.ts` | Add optional `attribution?: { name, email }` to `ActionContext` type |
| `packages/client/src/api/admin-github.ts` | Update hooks: drop classic OAuth endpoints, add installations list, add toggle mutations |
| `packages/client/src/api/me-github.ts` or similar | Update: remove scopes UI, add installations list for current user |
| `packages/client/src/components/settings/github-config.tsx` | Rewrite: drop OAuth panel, add installations list with sections, add toggles |
| `packages/client/src/components/settings/github-integration-card.tsx` | Update (or new): user-facing integrations card |
| `package.json` (worker, plugin-github) | Add `octokit` dependency; add `@octokit/plugin-throttling` |
| `packages/worker/src/env.ts` | Remove `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` requirements |

### Migration

**No data migration**. The existing GitHub state (service config, credentials, identity links, user `github_id`/`github_username`) is wiped and re-set up from scratch after the new worker deploys. The project is small enough that asking the admin to re-run the manifest flow and users to reconnect is cheaper than writing migration code.

**Deployment steps**:

1. Wipe existing GitHub state in production D1 via `wrangler d1 execute`:
   - `DELETE FROM org_service_configs WHERE service = 'github';`
   - `DELETE FROM credentials WHERE provider = 'github';`
   - `DELETE FROM user_identity_links WHERE provider = 'github';`
   - `UPDATE users SET github_id = NULL, github_username = NULL;`
   - `DELETE FROM integrations WHERE service = 'github';`
2. Apply migration for the new `github_installations` table (includes `cached_token_encrypted` and `cached_token_expires_at` columns)
3. Deploy worker + client
4. Admin logs in, goes to Settings → Integrations → GitHub, and runs "Create GitHub App" (the manifest flow) to recreate the App under the new unified-auth configuration
5. Admin clicks "Refresh installations" to populate `github_installations` (if the App has existing installations on GitHub that weren't removed, they'll reappear; otherwise admin installs fresh on the target org(s))
6. Users reconnect via the integrations page on next use

**In-flight sessions**: any sessions holding old GitHub tokens will find them invalid as soon as they try an API call (the tokens are still valid against GitHub's side, but the resolver will return "GitHub not connected" because the credential rows are gone). Users see the error and reconnect. There's a brief window where some users get friction; this is acceptable for the project's scale.

**What users lose**: existing connections. They reconnect in one click via the new integrations page.

**What admins lose**: nothing structural — the App itself on GitHub persists (since we don't delete it from GitHub). The admin can either recreate a fresh App via the manifest flow, or manually paste the existing App's credentials into the config if that's easier (supported by the existing admin UI).

## Edge cases

- **User connects GitHub before any App installation exists for their account**: they get a user token with no accessible installations. `GET /user/installations` returns empty. Agent can only access public repos via any available org installation token (if anonymous access is enabled). UI prompts the user to install the App on their personal account.

- **User's GitHub login changes**: `installation_target.renamed` webhook fires. We update `account_login` on the matching row (looked up by `github_installation_id`). `account_id` and `linked_user_id` are unaffected. User access tokens are unaffected.

- **User is removed from an org**: `installation_repositories.removed` fires for repos in that org. Their user token still works for other accessible repos. No Valet-side action needed.

- **App is uninstalled from an org**: `installation.deleted` webhook fires. We mark the row `status='removed'`. Future credential resolution for repos owned by that org fails (no matching installation). User tokens for users who had access via that org lose access to those repos (verified by the token itself on API call — GitHub returns 404/403).

- **App's private key is rotated**: admin regenerates the key on GitHub, pastes it into an admin form (or re-runs the manifest flow — the old App is kept). Octokit instances recreated from the new key work immediately. Any cached installation tokens on `github_installations` rows remain valid for their remaining TTL.

- **User authorizes the App but never installs it**: they have a valid user token that can only access repos in installations they already had access to. To access private repos not covered by any installation, they install the App on their personal account.

- **Personal install where the user's GitHub account_id doesn't match any Valet user**: row is created with `linked_user_id = NULL`, appears in the "Orphaned installations" section on admin page. If a user later connects that GitHub account via OAuth, the reconciliation step links it.

- **Two Valet users try to link the same GitHub account**: `users.github_id` has a unique index, but the unique constraint only errors on write — we want a user-friendly error. On the OAuth callback, before storing credentials, look up whether another user has `github_id` matching the incoming `account_id`. If yes, return an error ("This GitHub account is already linked to another Valet user") and abort the link. The `credentials` table does **not** enforce GitHub-account uniqueness — it's scoped per Valet user — so the check must be done explicitly against `users.github_id`.

- **Anonymous access disabled, user without linked GitHub attempts an action**: credential resolver returns error; agent surfaces "GitHub account not connected" to the user.

- **Installation token rate limit exceeded**: GitHub returns 403 with `x-ratelimit-remaining: 0`. Octokit's throttle plugin retries once with backoff (capped at 5s wait). If retries exhaust, the action fails with a clear rate-limit error. See [rate limits for the REST API](https://docs.github.com/en/rest/overview/rate-limits-for-the-rest-api).

- **Refresh token expired (6 months)**: refresh call fails. Credential row deleted, integration marked `error`. User must reconnect.

- **Webhook delivery failure**: GitHub retries delivery. Handlers are idempotent (upserts for installation events use `github_installation_id` as the idempotency key).

- **Octokit package incompatible with Workers at implementation time**: fall back to the existing hand-rolled JWT signer (`services/github-app-jwt.ts`) via Octokit's `createJwt` callback. See [Cloudflare Worker runtime compatibility](#cloudflare-worker-runtime-compatibility).

- **Cached token decryption fails**: if `decryptStringPBKDF2` throws on the cached token (e.g., `ENCRYPTION_KEY` was rotated, or the column is corrupt), fall through to fresh mint and overwrite the bad cache on write-back. No user-visible error.

- **In-flight session's stored token fails on next refresh**: credential row is deleted, user sees "GitHub connection expired, please reconnect" on next GitHub action. Documented as expected behavior; no user-facing migration notice.

## Security considerations

- **Private key storage**: the App's private key is stored encrypted in `org_service_configs.encrypted_config` (AES-256-GCM via `ENCRYPTION_KEY`). Per [managing private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps), GitHub's recommendation is key vault storage; our D1-with-encryption approach is acceptable for this deployment model. Key rotation is supported by GitHub (up to 25 keys per App) but not automated here — admin rotates manually.

- **Webhook secret verification**: every webhook request is verified by Octokit before any handler runs. Unsigned or mis-signed requests are rejected. Raw body is captured via `c.req.raw.clone().text()` before any body-consuming middleware.

- **OAuth state parameter**: the OAuth authorize URL includes a self-contained signed JWT state parameter with the Valet user ID, purpose, a random nonce, and short TTL (5 minutes). The callback verifies the signature to prevent CSRF and replay. No server-side nonce store is needed; signature + TTL is sufficient.

- **PKCE**: enabled on the OAuth flow per [GitHub's recommendation](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app). Octokit supports PKCE parameters via `getWebFlowAuthorizationUrl` if we pass `code_challenge` / `code_challenge_method`.

- **Token scoping**: user access tokens are always scoped to the intersection of the App's permissions and the user's GitHub permissions. There's no way for the agent to exceed this scope, even if the agent attempts to use a token outside its granted permissions.

- **Attribution cannot be forged by the user (agent)**: the `attribution` object is set by the credential resolver from the authenticated Valet user's profile, not from agent input. The agent cannot inject arbitrary attribution.

- **Installation tokens are short-lived**: 1hr lifetime, cached on the `github_installations` row with a 5-minute safety margin before re-minting. No long-lived installation tokens anywhere.

- **Duplicate GitHub account linking**: explicitly checked at link time (see edge cases); the unique index on `users.github_id` is the last line of defense.

- **Cache isolation**: cached tokens live on the `github_installations` row itself (one per installation). No cross-installation leakage. Tokens are encrypted at rest with `ENCRYPTION_KEY` (PBKDF2), matching the encryption used for stored credentials.

## Open questions

None. All previously-open questions resolved:

- **OAuth state JWT TTL**: 5 minutes for login flows (matches `oauth.ts::createStateJWT`), 10 minutes for link flows (matches current `github-me.ts` behavior). No change to either.
- **Refresh installations rate limit**: 1 per minute per worker instance
- **Scheduled installation sync**: not added. Webhooks + manual refresh suffice.
- **Post-install OAuth continuity**: `request_oauth_on_install` is disabled; Valet initiates OAuth itself with its own signed state.
- **Danger zone token revocation**: local delete only; do not per-user `deleteToken`.
- **Identity provider disposition**: kept as a stub for registry enumeration only.

## References

### GitHub documentation

- [About creating GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/about-creating-github-apps)
- [Deciding when to build a GitHub App](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/deciding-when-to-build-a-github-app)
- [Migrating OAuth Apps to GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/about-creating-github-apps/migrating-oauth-apps-to-github-apps)
- [About authentication with a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/about-authentication-with-a-github-app)
- [Authenticating as a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-as-a-github-app)
- [Authenticating on behalf of a user](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/authenticating-with-a-github-app-on-behalf-of-a-user)
- [Generating a JWT for a GitHub App](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-json-web-token-jwt-for-a-github-app)
- [Generating an installation access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-an-installation-access-token-for-a-github-app)
- [Generating a user access token](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/generating-a-user-access-token-for-a-github-app)
- [Refreshing user access tokens](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens)
- [Managing private keys](https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/managing-private-keys-for-github-apps)
- [Registering a GitHub App from a manifest](https://docs.github.com/en/apps/sharing-github-apps/registering-a-github-app-from-a-manifest)
- [Registering a GitHub App](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/registering-a-github-app)
- [Modifying a GitHub App registration](https://docs.github.com/en/apps/maintaining-github-apps/modifying-a-github-app-registration)
- [Using webhooks with GitHub Apps](https://docs.github.com/en/apps/creating-github-apps/registering-a-github-app/using-webhooks-with-github-apps)
- [Installing a GitHub App from a third party](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-a-third-party)
- [Installing a GitHub App for organizations](https://docs.github.com/en/apps/using-github-apps/installing-a-github-app-from-github-marketplace-for-your-organizations)
- [Authorizing GitHub Apps](https://docs.github.com/en/apps/using-github-apps/authorizing-github-apps)
- [Best practices for creating a GitHub App](https://docs.github.com/en/apps/creating-github-apps/setting-up-a-github-app/best-practices-for-creating-a-github-app)
- [Rate limits for the REST API](https://docs.github.com/en/rest/overview/rate-limits-for-the-rest-api)
- [REST API: App Installations](https://docs.github.com/en/rest/apps/installations)

### Octokit documentation

- [octokit.js](https://github.com/octokit/octokit.js) — meta SDK
- [@octokit/auth-app](https://github.com/octokit/auth-app.js) — App JWT + installation token + user token exchange
- [@octokit/oauth-app](https://github.com/octokit/oauth-app.js) — OAuth URL generation, token lifecycle, middleware
- [@octokit/plugin-throttling](https://github.com/octokit/plugin-throttling.js) — rate limit handling

### Internal documents

- [`docs/specs/integrations.md`](./integrations.md) — integration framework spec
- [`docs/specs/auth-access.md`](./auth-access.md) — auth and access control spec
- [`docs/specs/2026-04-08-github-multi-credential-routing-design.md`](./2026-04-08-github-multi-credential-routing-design.md) — the design this replaces
- [`docs/plans/2026-04-08-github-multi-credential-routing.md`](../plans/2026-04-08-github-multi-credential-routing.md) — the implementation plan being superseded
