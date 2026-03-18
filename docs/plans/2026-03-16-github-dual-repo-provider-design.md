# GitHub Dual Repo Provider Design

**Date:** 2026-03-16 (updated 2026-03-18)
**Status:** Draft
**Evolves:** `2026-03-12-identity-repo-providers.md`

## Problem

Valet currently has a single `githubRepoProvider` that handles both GitHub OAuth tokens and GitHub App installation tokens with conditional logic. Different deployment scenarios need different behaviors:

- **Individual developers / small teams** (e.g., Xiangan's team) want OAuth — commits attributed to the human, access to any repo the user can see, no admin setup required.
- **Enterprise / governed orgs** (e.g., Turnkey) want a GitHub App — commits attributed to `valet[bot]`, admin-controlled repo scope, no per-user GitHub login required.
- **Mixed orgs** need both — the App as a baseline so everyone (including non-developers) gets repo access, with optional personal OAuth for developers who want attribution.

## Design

### Principle: Separate Identity from Repo Access

GitHub OAuth login and GitHub OAuth repo access are two different concerns with different scopes:

- **Identity:** `read:user user:email` — proves who the user is. Linked to the user's email-based Valet account alongside other identity providers (Google, email/password).
- **Repo access (OAuth):** `repo` scope — grants access to the user's repositories. A separate OAuth flow from identity login.
- **Repo access (App):** GitHub App installation — grants access to repos the App is installed on. No per-user GitHub link required.

### Two Repo Providers, One Plugin

Split the current `githubRepoProvider` into two implementations within `plugin-github`:

**`GitHubOAuthRepoProvider`**
- `id: 'github-oauth'`
- Credential type: `token`
- `listRepos` → `/user/repos` (user's accessible repos)
- `mintToken` → passthrough (OAuth tokens don't expire)
- Git user: the authenticated user's GitHub name/email
- Commits attributed to the human

**`GitHubAppRepoProvider`**
- `id: 'github-app'`
- Credential type: `installation`
- `listRepos` → `/installation/repositories` (repos the App is installed on)
- `mintToken` → mints short-lived installation token via RS256 JWT
- Git user: `valet[bot]` / `valet[bot]@users.noreply.github.com`
- Commits attributed to the bot

Shared utilities remain common within the plugin: GitHub API client (`githubFetch`), URL pattern matching (`/github\.com/`), repo mapping (`mapGitHubRepo`), and the `mintInstallationToken` helper.

### Explicit Provider Selection on Sessions

Sessions are locked to exactly one repo provider for their entire lifetime. No implicit switching.

**Session creation** accepts an explicit `repoProviderId` parameter (e.g., `'github-oauth'` or `'github-app'`). This is stored on the session record and used for:
- Initial token minting
- Token refresh (same provider, no switching)
- All in-session GitHub operations (PR creation, issue listing, etc.)
- Child session inheritance

**When `repoProviderId` is not specified**, the system resolves a default:
1. User's `preferredRepoProvider` setting (if set)
2. First available credential: user OAuth > user App > org App

**Once a session starts, the provider is fixed.** Token refresh always uses the same provider. If the user unlinks their OAuth mid-session, refresh fails with an explicit error rather than silently switching to a different provider.

### Repo Listing is Comprehensive

Repo listing (read-only) is separate from session creation. It queries ALL available credentials and merges results:

- If user has OAuth linked → list from `github-oauth` (user's personal repos)
- If org has App installed → list from `github-app` (App's installed repos)
- If both exist → merge results from both, deduplicated by `fullName`

This gives users the fullest picture of available repos regardless of which provider they'll use for the session. Each repo in the list includes which provider(s) can access it.

### User Preference Setting

Users can set a `preferredRepoProvider` in their settings:

- `'github-oauth'` — prefer personal attribution (commits as me)
- `'github-app'` — prefer bot attribution (commits as valet[bot])
- `null` — use first available (default)

This preference is used as the default when creating a session without an explicit `repoProviderId`. It does NOT affect repo listing (which always shows everything).

### Credential Resolution

The implicit priority chain is replaced by explicit, context-dependent resolution:

**For session creation (pick one):**
1. Explicit `repoProviderId` param → use that provider's credential
2. User's `preferredRepoProvider` setting → use that provider's credential
3. Fallback: first available — user OAuth > user App > org App

**For repo listing (query all):**
- Query each provider with its OWN credential type directly
- `github-oauth` → look for user `oauth2` credential
- `github-app` → look for org `app_install` credential (then user `app_install`)
- Skip providers where no matching credential exists

**For in-session GitHub operations (locked):**
- Use the session's stored `repoProviderId` to resolve the credential
- No fallback chain — if the credential is gone, fail explicitly

### Credential Deletion

`deleteCredential` is scoped to a specific `credentialType`. "Unlink GitHub OAuth" deletes only the `oauth2` credential, leaving any `app_install` credential intact.

### What Doesn't Change

- **Git credential helper** (`packages/runner/src/git-setup.ts`) — already calls `/git/credentials` and receives a token. No changes needed.
- **GitHub identity provider** (`packages/plugin-github/src/identity.ts`) — stays as login-only with `read:user user:email` scopes. Independent of repo access.
- **Plugin registry auto-generation** — `generate-plugin-registry.ts` discovers and registers both providers from the same plugin package.

## File Changes

### New / Split
- `packages/plugin-github/src/repo-oauth.ts` — `GitHubOAuthRepoProvider`
- `packages/plugin-github/src/repo-app.ts` — `GitHubAppRepoProvider`
- `packages/plugin-github/src/repo-shared.ts` — shared utilities (mapGitHubRepo, mintInstallationToken, URL patterns)

### Modified
- `packages/worker/src/repos/registry.ts` — support multiple providers per URL pattern
- `packages/worker/src/routes/repo-providers.ts` — org-level App installation storage, OAuth repo-link flow
- `packages/worker/src/routes/sessions.ts` — accept `repoProviderId` param
- `packages/worker/src/services/sessions.ts` — store `repoProviderId` on session record
- `packages/worker/src/lib/env-assembly.ts` — resolve credential from explicit provider ID
- `packages/worker/src/durable-objects/session-agent.ts` — use session's `repoProviderId` for all GitHub operations
- `packages/worker/src/routes/repos.ts` — credential-type-aware listing, scoped credential deletion
- `packages/worker/src/lib/db/credentials.ts` — add `credentialType` filter to delete, per-type queries for listing

### Removed
- `packages/plugin-github/src/repo.ts` — replaced by the split files (now a barrel re-export)

## Edge Cases Addressed

| Scenario | Behavior |
|----------|----------|
| User has OAuth + org has App | Repo listing shows both. Session uses user preference or explicit param. |
| User unlinks OAuth mid-session | Token refresh fails explicitly. Session does not silently switch to App. |
| App-only user creates PR | Session's provider is `github-app`, in-session operations use App token. |
| User deletes GitHub credential | Only the specific credential type is removed. |
| Child session spawned | Inherits parent's `repoProviderId`. |
| No credentials at all | Session creation fails with actionable error. |

## Future Considerations

- **GitLab, Bitbucket, GitHub Enterprise** — same pattern applies: explicit provider selection, user preference, per-type credentials.
- **SSH key auth** — could be another provider type in the same model.
- **Per-repo provider overrides** — not in scope, but the explicit model makes this easy to add later.
- **UI provider picker** — session creation UI could show a provider dropdown when multiple are available.
