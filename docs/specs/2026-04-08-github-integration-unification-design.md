# GitHub Integration Unification Design

**Goal:** Make GitHub tools visible to all org users when a GitHub App is installed, remove the legacy built-in `list-repos` handler, and add a generic credential resolution endpoint so sandboxes can fetch credentials on demand.

**Status:** Design

**Does NOT cover:** Integration sandbox hooks (generic plugin lifecycle hooks at sandbox creation), pre-baked sandbox images for repos, GitLab/Bitbucket support, personal GitHub identity linking for commit attribution.

---

## Problem Statement

Three issues prevent the GitHub integration from working after a GitHub App is installed via the manifest flow:

1. **Tools are invisible.** `listTools` queries D1 for integration records, but no org-scoped integration record is created when the GitHub App is installed. Without the record, credential resolution is never attempted and all GitHub tools are hidden from the agent.

2. **Two `list_repos` implementations.** The built-in `list-repos` DO handler reads a static `org_repositories` D1 table. The GitHub plugin's `github.list_repos` action queries the GitHub API. The agent calls the built-in one (which returns nothing) instead of the plugin action (which would work).

3. **No way for the sandbox to fetch credentials.** Sandbox boot needs a GitHub token to clone repos, but tokens are currently baked into env vars at spawn time. Short-lived tokens (1-hour GitHub App installation tokens) can expire before the sandbox finishes booting. There's no way for sandbox processes to resolve credentials on demand.

---

## Design

### 1. Org-Scoped Integration Record

When the GitHub App install callback completes (in `repo-providers.ts`), create an org-scoped integration record in D1 for the `github` service. This is the record that `listTools` queries to discover available integrations.

**Foreign key constraint:** The `integrations` table has a FK on `userId` referencing `users.id`, and a unique index on `(userId, service)`. Org-scoped records use the **admin's actual userId** (the user who performed the installation, available from the signed JWT state in the callback). This satisfies the FK constraint (the admin is a real user) and avoids collision with the admin's personal GitHub OAuth integration because the unique index is on `(userId, service)` — the org record has `scope = 'org'` but the same `(userId, service)` pair cannot have two rows.

**Resolution:** Add `scope` to the unique index: `(userId, service, scope)`. This allows the same user to have both a personal (`scope = 'user'`) and org (`scope = 'org'`) integration record for the same service. This is a D1 migration (drop the old index, create the new one).

The record should be created alongside the `app_install` credential that's already stored. Use `INSERT ... ON CONFLICT DO UPDATE` to handle re-installation.

When the admin deletes the GitHub config (DELETE `/api/admin/github/oauth`), delete the org-scoped integration record (where `scope = 'org'` and `service = 'github'`).

**GitHub App lifecycle events:** The install callback handler in `repo-providers.ts` should check `setup_action`:
- `setup_action=install` — create the org integration record + store credentials (current behavior + new record)
- `setup_action=update` — refresh app metadata (permissions may have changed)
- `setup_action=delete` — delete the org integration record + delete the `app_install` credential. Without this cleanup, `listTools` would show GitHub tools that fail on every credential resolution.

**Effect:** Any user in the org who calls `list_tools` will see GitHub tools, because `listTools` finds the org integration record, resolves the org `app_install` credential, mints an installation token, and returns the tool list.

**Note on `listTools` deduplication:** `listTools` (session-tools.ts ~line 161) deduplicates by service, with user integrations listed first. If a user has both personal OAuth and the org app install, the user's personal record wins and the resolver is called with `scope: 'user'`. The org resolver's fallback logic (Section 3) only matters for users who do NOT have a personal GitHub integration record.

### 2. Remove Built-in `list-repos` Handler

**Delete:**
- The `list-repos` WebSocket message handler in `session-agent.ts` that calls `listOrgRepositories`
- The `list-repos-result` case handler in the Runner's `agent-client.ts`
- The `list-repos` and `list-repos-result` type definitions in `packages/shared/src/types/runner-protocol.ts`
- Any runner-side code that sends `list-repos` type WebSocket messages

**Keep:**
- The `org_repositories` D1 table — internal infrastructure for future pre-baked sandbox images
- The `/api/repos` HTTP routes — admin UI uses these to manage registered repos
- The sandbox boot logic that reads `org_repositories` — unchanged for now; sessions spawned with a registered repo still work

**Agent behavior after removal:** The agent uses `call_tool` with `github:list_repos` to list repos. No built-in `list_repos` tool exists.

### 3. Custom GitHub Credential Resolver

Register a custom `CredentialResolver` for the `github` service in the `IntegrationRegistry`, replacing the `defaultCredentialResolver` for GitHub.

**Location:** `packages/worker/src/integrations/resolvers/github.ts` — following the exact pattern of `packages/worker/src/integrations/resolvers/slack.ts`. The resolver lives in the worker package (not the plugin package) because `CredentialResolver` is a worker-internal type. The resolver imports `mintGitHubInstallationToken` from `packages/worker/src/services/github-app-jwt.ts` for token minting.

Registered in `IntegrationRegistry.init()` alongside the Slack resolver:
```typescript
this.credentialResolvers.set('github', githubCredentialResolver);
```

**Resolution logic:**

The `CredentialResolver` signature is `(service, env, userId, scope, options)`. To distinguish explicit scope overrides (from `resolveScope`) from implicit scope (from the integration record), the `options` parameter is extended with an `explicit` flag:

```typescript
options?: { forceRefresh?: boolean; credentialType?: string; explicit?: boolean }
```

`session-tools.ts` sets `explicit: true` when the scope comes from `resolveScope`.

```
resolveGitHubCredential(service, env, userId, scope, options):
  1. If options.explicit is true and scope is 'user':
     → look up user oauth2 credential only
     → return token (with refresh if expired)
     → if not found, return not_found error (no fallback)

  2. If options.explicit is true and scope is 'org':
     → look up org app_install credential only (ownerType='org', ownerId='default')
     → mint installation token, cache it (see below)
     → return token with credentialType='app_install'
     → if not found, return not_found error (no fallback)

  3. If options.explicit is false/undefined (default — scope from integration record):
     → try user oauth2 first
     → if not found, try org app_install
     → if neither found, return not_found error
```

**Installation token caching:** GitHub rate-limits installation token creation to 60 requests/hour/installation. The resolver caches minted installation tokens keyed by `installation_id` with a TTL of 55 minutes (1 hour minus 5-minute safety margin). The cache lives in the DO's `credentialCache` (already exists for OAuth tokens). This means `listTools` calls and rapid action executions reuse the same token instead of minting fresh ones.

**Revoked OAuth fallback:** If the user has a personal OAuth token that is revoked, the resolver returns it as "valid" (the row exists and decrypts). The action then fails with a 401 from GitHub. To handle this, `executeAction` in `session-tools.ts` (~line 536) already retries on 401 with `forceRefresh: true`. The custom resolver should detect `forceRefresh` on a revoked GitHub OAuth and fall through to the org `app_install` credential instead of attempting a refresh (GitHub OAuth tokens cannot be refreshed). This ensures the org credential is used as a fallback when the user's personal token is dead.

### 4. `list_repos` Source Parameter

Add an optional `source` parameter to the `github.list_repos` action definition:

```typescript
params: z.object({
  source: z.enum(['org', 'personal']).optional().describe(
    'Which credential to use. "org" uses the GitHub App (org repos), "personal" uses your OAuth token (personal repos). Defaults to trying personal first, then org.'
  ),
  sort: z.enum(['created', 'updated', 'pushed', 'full_name']).optional(),
  perPage: z.number().int().min(1).max(100).optional(),
  page: z.number().int().min(1).optional(),
})
```

**Execution behavior:**
- `source: 'org'` → resolve credential with `scope: 'org', explicit: true` → call `/installation/repositories`
- `source: 'personal'` → resolve credential with `scope: 'user', explicit: true` → call `/user/repos`
- No source → resolve credential with default scope (resolver tries user OAuth first, falls back to org app install). The action reads `ctx.credentials._credential_type` (already set by `session-tools.ts` at line 499) to determine which endpoint to call.

**`resolveScope` interface:** Add an optional method to the `ActionSource` interface in `packages/sdk/src/integrations/index.ts`:

```typescript
interface ActionSource {
  listActions(ctx?: ActionListContext): ActionDefinition[] | Promise<ActionDefinition[]>;
  execute(actionId: string, params: unknown, ctx: ActionContext): Promise<ActionResult>;
  // NEW: optional scope resolution based on action params
  resolveScope?(actionId: string, params: unknown): 'user' | 'org' | undefined;
}
```

Called in `executeAction` of `session-tools.ts` (~line 481), before credential resolution:

```typescript
const actionSource = integrationRegistry.getActions(service);
const pluginScope = actionSource?.resolveScope?.(actionId, params);
const scope = pluginScope ?? (isOrgScoped ? 'org' as const : 'user' as const);
const explicit = pluginScope !== undefined;
// Pass explicit flag to credential resolver
let credResult = await integrationRegistry.resolveCredentials(service, env, userId, scope, { explicit });
```

The GitHub plugin implements `resolveScope` to read `source` from `list_repos` params and map `'personal'` → `'user'`, `'org'` → `'org'`. For all other actions, it returns `undefined`.

### 5. Session Spawn with Arbitrary Repo

The session spawn request accepts an optional `repo` parameter. Note: `CreateSessionParams` already has a `repoUrl` field in `sessions.ts`. The new `repo` param is a shorthand (`owner/repo`) that gets normalized to `repoUrl` (`https://github.com/owner/repo`) during session creation. If both are present, `repo` takes precedence. Existing `repoUrl` callers continue to work unchanged.

```typescript
interface SessionSpawnRequest {
  // ... existing fields ...
  repo?: string; // e.g., "owner/repo" — normalized to repoUrl during creation
}
```

When `repo` is specified:
1. The spawn flow no longer reads `org_repositories` to determine what to clone.
2. The repo URL is passed to the sandbox as an env var (e.g., `SESSION_REPO=owner/repo`).
3. The sandbox boot script calls the Runner credential endpoint (Section 6) to get a token, then clones.

When `repo` is NOT specified:
- The current behavior is preserved — the sandbox uses whatever is configured in `org_repositories` (if anything). This is the backwards-compatible path.

**Future direction:** When pre-baked sandbox images are implemented, the spawn flow checks if a cached image exists for the `repo` and uses it instead of cloning fresh. The spawn request stays the same.

### 6. Runner Credential Endpoint

New endpoint on the Runner gateway (`packages/runner/src/gateway.ts`):

```
POST /api/credentials/resolve
Body: { service: string, scope?: 'user' | 'org', context?: Record<string, unknown> }
Response: { token: string, type: string, expiresAt?: string } | { error: string }
```

**Flow:**
1. Sandbox process (boot script, git credential helper, any tool) calls the endpoint
2. Runner receives request, sends WebSocket message to DO: `{ type: 'resolve-credential', requestId, service, scope, context }`
3. DO calls `integrationRegistry.resolveCredentials(service, env, userId, scope)` using the session's `userId`
4. DO returns `{ type: 'resolve-credential-result', requestId, token, type, expiresAt }` or error
5. Runner returns the token to the caller

**Security:** The endpoint is on the Runner's internal API, following the same pattern as `/api/tools` and `/api/tools/call`. The Runner's `/api/*` routes are NOT individually JWT-gated — they rely on being accessible only from within the sandbox (localhost). This is the same trust model as `call-tool`, which can already execute arbitrary integration actions. The credential endpoint does not expand the attack surface beyond what `call-tool` already provides.

The `service` parameter accepts any integration name. A sandbox process could request tokens for any configured integration (GitHub, Slack, Gmail). This is equivalent to calling `call-tool` with a tool from that integration, so it is not a privilege escalation. All credential resolution calls should be **logged with `service` and `sessionId`** for audit purposes.

**Readiness:** If the Runner's WebSocket to the DO is not yet established when the endpoint is called, return HTTP 503 with a `Retry-After: 1` header. The boot script should retry with exponential backoff.

**Git credential helper integration:** The sandbox boot script configures git to use the endpoint. The sandbox has `RUNNER_TOKEN` available as an env var (set by `sandboxes.py`):

```bash
git config --global credential.helper '!f() {
  TOKEN=$(curl -s http://localhost:9000/api/credentials/resolve \
    -H "Content-Type: application/json" \
    -d "{\"service\": \"github\"}" | jq -r .token)
  echo "username=x-access-token"
  echo "password=$TOKEN"
}; f'
```

Note: since the `/api/*` routes are not individually JWT-gated, no `Authorization` header is needed for intra-sandbox calls. The gateway's JWT middleware only applies to proxied external service routes (`/vscode/*`, `/vnc/*`, `/ttyd/*`), not to `/api/*`.

The existing `GitCredentialManager` in `packages/runner/src/git-credentials.ts` should be wired to use the credential endpoint (via the `onResolveCredential` callback) rather than relying on pre-baked env vars. This ensures token caching and deduplication of concurrent refresh calls at the runner level, on top of the DO-level installation token cache.

**DO handler:** Add `resolve-credential` to the runner message handlers in `session-agent.ts`, alongside existing handlers like `list-tools` and `call-tool`.

**Protocol types:** Add `resolve-credential` and `resolve-credential-result` message types to `packages/shared/src/types/runner-protocol.ts`.

---

## Migration

- **D1 migration required:** Drop the unique index `idx_integrations_user_service` on `(userId, service)` and recreate it as `(userId, service, scope)`. This allows a user to have both a personal and org integration record for the same service.
- **No other schema changes.** The `org_repositories` table is unchanged.
- **Backwards compatible spawn.** Sessions without a `repo` param work as before.
- **Built-in `list-repos` removal** is a breaking change for the internal DO handler. Since the agent uses `call_tool` for GitHub actions, the impact is limited.
- **Old clients** that don't pass `repo` in spawn requests continue to work.
- **Spec updates required:** `docs/specs/integrations.md` should document org-scoped integration records. `docs/specs/sandbox-runtime.md` should document the credential resolution endpoint replacing the `GITHUB_TOKEN` env var approach.

---

## Boundary

This spec covers:
- Org-level GitHub tool visibility
- Built-in `list-repos` removal
- Custom GitHub credential resolver (with token caching and revocation fallback)
- `list_repos` source parameter
- Arbitrary repo in session spawn
- Runner credential resolution endpoint

This spec does NOT cover:
- Integration sandbox hooks (generic plugin lifecycle at sandbox creation)
- Pre-baked sandbox images
- GitLab/Bitbucket integration
- Personal GitHub identity linking (commit attribution)
- OAuth scope escalation UI
