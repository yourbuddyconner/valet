# Auth & Access Control

> Defines authentication flows, authorization model, token management, org configuration, and session-level access control.

## Scope

This spec covers:

- OAuth flows (GitHub, Google)
- Session token and API token authentication
- Auth middleware chain
- Admin role and middleware
- JWT issuance (OAuth state, sandbox access)
- User model and profile management
- Org model (settings, email gating, invites, LLM keys, custom providers)
- Session-level access control (role hierarchy, participants, org visibility)
- API key management (personal tokens)
- Encryption of stored secrets
- Client-side auth state

### Boundary Rules

- This spec does NOT cover per-sandbox JWT validation or the auth gateway (see [sandbox-runtime.md](sandbox-runtime.md))
- This spec does NOT cover session lifecycle or prompt routing (see [sessions.md](sessions.md))
- This spec does NOT cover orchestrator identity or memory (see [orchestrator.md](orchestrator.md))

## Data Model

### `users` table

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | text PK | — | UUID |
| `email` | text NOT NULL UNIQUE | — | Primary identity |
| `name` | text | — | Display name |
| `avatarUrl` | text | — | Profile image |
| `githubId` | text | — | Set on GitHub OAuth. Unique index. |
| `githubUsername` | text | — | Set on GitHub OAuth |
| `gitName` | text | — | User-configurable; auto-populated from OAuth |
| `gitEmail` | text | — | User-configurable; auto-populated from OAuth |
| `onboardingCompleted` | boolean | `false` | First-use flag |
| `idleTimeoutSeconds` | integer | `900` | Per-user idle timeout (min 300, max 3600) |
| `role` | text NOT NULL | `'member'` | `'admin'` or `'member'` |
| `modelPreferences` | JSON text | — | Ordered list of preferred model IDs |
| `discoveredModels` | JSON text | — | Cached available models from sandbox |
| `maxActiveSessions` | integer | — | Per-user override (default 10 from constants) |
| `uiQueueMode` | text | `'followup'` | `'followup'` / `'collect'` / `'steer'` |
| `createdAt` / `updatedAt` | text | `datetime('now')` | ISO datetime |

### `auth_sessions` table

Server-side session tokens created after OAuth.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `userId` | text NOT NULL | FK to users, CASCADE DELETE |
| `tokenHash` | text NOT NULL UNIQUE | SHA-256 hash of the plaintext token |
| `provider` | text NOT NULL | `'github'` or `'google'` |
| `expiresAt` | text NOT NULL | 7-day expiry from creation |
| `lastUsedAt` | text | Updated on each authenticated request |

Tokens are 32 random bytes, hex-encoded (64 chars). The plaintext is returned once at login and never stored.

### `api_tokens` table

Personal API keys for programmatic access.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `userId` | text NOT NULL | FK to users, CASCADE DELETE |
| `name` | text NOT NULL | User-assigned name |
| `tokenHash` | text NOT NULL UNIQUE | SHA-256 hash |
| `prefix` | text | Display prefix: `sk_abc1...ef23` |
| `scopes` | text | `'[]'` — **declared but never checked** |
| `lastUsedAt` | text | Updated on use |
| `expiresAt` | text | Optional expiry |
| `revokedAt` | text | Soft-delete timestamp |

Token format: `sk_` + 64 hex chars (32 random bytes). Revocation is soft-delete via `revokedAt`; the auth middleware excludes revoked tokens.

### `oauth_tokens` table

Stored OAuth provider tokens.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `userId` | text NOT NULL | FK to users, CASCADE DELETE |
| `provider` | text NOT NULL | `'github'` or `'google'` |
| `encryptedAccessToken` | text NOT NULL | AES-256-GCM encrypted |
| `encryptedRefreshToken` | text | AES-256-GCM encrypted (Google only) |
| `scopes` | text | Granted scopes |
| `expiresAt` | text | Token expiry |

**Unique constraint** on `(userId, provider)` — one token set per provider per user.

### `user_credentials` table

Per-user integration secrets (e.g., 1Password service account token).

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `userId` | text NOT NULL | FK to users, CASCADE DELETE |
| `provider` | text NOT NULL | Currently only `'1password'` |
| `encryptedKey` | text NOT NULL | AES-256-GCM encrypted |

**Unique constraint** on `(userId, provider)`.

### `org_settings` table

Singleton row (id=`'default'`) for org-level configuration.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | text PK | `'default'` | Singleton |
| `name` | text NOT NULL | `'My Organization'` | Org display name |
| `allowedEmailDomain` | text | — | e.g. `"acme.com"` |
| `allowedEmails` | text | — | Comma-separated email list |
| `domainGatingEnabled` | boolean | `false` | Enable domain check |
| `emailAllowlistEnabled` | boolean | `false` | Enable email list check |
| `defaultSessionVisibility` | text NOT NULL | `'private'` | `'private'` / `'org_visible'` / `'org_joinable'` |
| `modelPreferences` | JSON text | — | Org-level model preference list |

### `org_api_keys` table

Org-level LLM provider API keys (admin-managed).

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `provider` | text NOT NULL UNIQUE | `'anthropic'` / `'openai'` / `'google'` / `'parallel'` |
| `encryptedKey` | text NOT NULL | AES-256-GCM encrypted |
| `setBy` | text NOT NULL | FK to users |

### `invites` table

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `code` | text NOT NULL UNIQUE | 12-char alphanumeric code |
| `email` | text | Optional: restrict to specific email |
| `role` | text NOT NULL | `'member'` (default) or `'admin'` |
| `invitedBy` | text NOT NULL | FK to users |
| `acceptedAt` | text | ISO datetime |
| `acceptedBy` | text | FK to users |
| `expiresAt` | text NOT NULL | 7-day expiry |

### `custom_providers` table

Custom OpenAI-compatible LLM providers.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `providerId` | text NOT NULL UNIQUE | Slug format (`/^[a-z0-9-]+$/`), no collision with built-in providers |
| `displayName` | text NOT NULL | UI display name |
| `baseUrl` | text NOT NULL | OpenAI-compatible API endpoint |
| `encryptedKey` | text | AES-256-GCM encrypted API key |
| `models` | JSON text NOT NULL | Array of `{ id, name?, contextLimit?, outputLimit? }` |
| `setBy` | text NOT NULL | User ID who configured |

### TypeScript Types

```typescript
type AuthProvider = 'github' | 'google';
type UserRole = 'admin' | 'member';
type SessionParticipantRole = 'owner' | 'collaborator' | 'viewer';
```

## Authentication

### OAuth Flows

Both GitHub and Google follow the same pattern. Routes are mounted at `/auth` (no auth middleware — these handle the login flow itself).

**Initiation:**
1. Frontend redirects to `GET /auth/{provider}`.
2. Server creates a state JWT (5-minute expiry, HMAC-SHA256) containing provider name, random `sid`, and optional `invite_code`.
3. Server redirects to provider's authorization URL with appropriate scopes.

**Callback:**
1. Provider redirects to `GET /auth/{provider}/callback` with `code` and `state`.
2. Server verifies state JWT.
3. Exchanges code for access token at provider's token endpoint.
4. Fetches user profile from provider API.

**GitHub specifics:**
- Scopes: `repo read:user user:email`.
- If email is private, fetches from `/user/emails` (picks primary verified, falls back to any verified).
- Stores access token (encrypted) in `oauth_tokens`.

**Google specifics:**
- Scopes: `openid email profile`.
- Requests `access_type: 'offline'`, `prompt: 'consent'` for refresh tokens.
- Decodes `id_token` JWT payload (base64 decode only — **no signature verification**; acceptable since token comes directly from Google's token endpoint over HTTPS).
- Stores access token and refresh token (both encrypted).

**Post-authentication (both providers):**
1. User lookup: by provider ID first, then by email, then create new user.
2. **First-user auto-admin:** if the newly created user is the only user in the system, they are automatically promoted to admin.
3. Backfill `gitName` and `gitEmail` if not already set.
4. Process invite acceptance (by code from state JWT or by email match for new users).
5. Generate session token: 32 random bytes, hex-encoded.
6. SHA-256 hash the token, store in `auth_sessions` with 7-day expiry.
7. Redirect to `${FRONTEND_URL}/auth/callback?token=...&provider=...`.

**Token refresh:** Not implemented. Google refresh tokens are stored but never used for automatic refresh. GitHub tokens do not expire by default.

### Email Gating

Multi-layer signup restriction checked via `isEmailAllowed()`:

1. Existing users always bypass.
2. Valid invite code bypasses.
3. Domain gating: if enabled and email domain matches `allowedEmailDomain`, allow.
4. Email allowlist: if enabled and email is in the comma-separated `allowedEmails` list, allow.
5. Email-based invite: checks for a valid (unexpired, unaccepted) invite targeting that email.
6. Fallback: `ALLOWED_EMAILS` environment variable (backward compat).
7. If no gating mechanism is configured at all, **everyone is allowed**.

### Auth Middleware

Protects all `/api/*` routes. Applied at the app level in `index.ts`.

**Bypass:** Runner WebSocket connections are exempted. If the URL has `?role=runner` and pathname ends with `/ws`, the middleware passes through. The Durable Object validates the runner's token directly.

**Token extraction:** `Authorization: Bearer <token>` header first, fallback to `?token=<token>` query parameter.

**Validation chain:**
1. SHA-256 hash the token.
2. Try `auth_sessions`: match `token_hash`, check `expires_at > now`. Update `last_used_at`.
3. Fall back to `api_tokens`: match `token_hash`, check not expired, check not revoked. Update `last_used_at`.
4. If neither validates: `UnauthorizedError`.

**Context set:** `c.set('user', { id, email, role })`.

**Note:** The middleware uses raw D1 SQL queries, not the Drizzle-based helpers. A Drizzle version (`getAuthSessionByTokenHash`) exists in `db/auth.ts` but is unused.

### Admin Middleware

Simple role check after auth middleware:

```typescript
if (user.role !== 'admin') throw new ForbiddenError('Admin access required');
```

## JWT Issuance

Two JWT use cases, both using HMAC-SHA256 with the `ENCRYPTION_KEY` secret:

### OAuth State JWT (5-minute)

Used during OAuth initiation/callback to prevent CSRF. Payload contains provider name (`sub`), random session ID (`sid`), and optional `invite_code`.

### Sandbox Access JWT (15-minute)

Issued via `GET /api/sessions/:id/sandbox-token`. Used by the frontend to authenticate iframe access to sandbox services (VS Code, VNC, terminal) through the auth gateway.

Payload: `{ sub: userId, sid: sessionId, exp, iat }`.

Guards: rejects if session is in terminal or hibernated status.

## API Contract

### Auth Routes (`/api/auth`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/me` | User profile + connected providers + org model prefs |
| PATCH | `/me` | Update profile (name, git config, idle timeout, model prefs, queue mode) |
| GET | `/me/credentials` | List configured credential providers |
| PUT | `/me/credentials/:provider` | Set a credential (currently only `1password`) |
| DELETE | `/me/credentials/:provider` | Remove a credential |
| POST | `/logout` | Invalidate current session token |

### Admin Routes (`/api/admin`)

All gated by `adminMiddleware`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | Get org settings |
| PUT | `/` | Update org settings |
| GET | `/llm-keys` | List configured LLM provider keys (metadata only) |
| PUT | `/llm-keys/:provider` | Set org LLM key (anthropic/openai/google/parallel) |
| DELETE | `/llm-keys/:provider` | Remove org LLM key |
| GET | `/invites` | List all invites |
| POST | `/invites` | Create invite (12-char code, 7-day expiry) |
| DELETE | `/invites/:id` | Delete invite |
| GET | `/users` | List all users |
| PATCH | `/users/:id` | Update user role (prevents demoting last admin) |
| DELETE | `/users/:id` | Delete user (prevents self-delete, last admin delete) |
| GET | `/custom-providers` | List custom LLM providers |
| PUT | `/custom-providers/:providerId` | Create/update custom provider |
| DELETE | `/custom-providers/:providerId` | Delete custom provider |

### API Key Routes (`/api/api-keys`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List user's API keys (metadata only) |
| POST | `/` | Create API key (returns plaintext once) |
| DELETE | `/:id` | Revoke API key (soft delete) |

### Invite Routes

**Public** (`/invites`, no auth):
| Method | Path | Description |
|--------|------|-------------|
| GET | `/:code` | Validate invite code, return status/role/org name |

**Authenticated** (`/api/invites`):
| Method | Path | Description |
|--------|------|-------------|
| POST | `/:code/accept` | Accept invite, update user role |

### OAuth Routes (`/auth`, no auth)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/github` | Initiate GitHub OAuth |
| GET | `/github/callback` | GitHub OAuth callback |
| GET | `/google` | Initiate Google OAuth |
| GET | `/google/callback` | Google OAuth callback |

## Session Access Control

### Role Hierarchy

```
viewer (0)  <  collaborator (1)  <  owner (2)
```

### Authorization Gate (`assertSessionAccess`)

Central authorization function. Check order:

1. **Session existence:** fetch session from D1. `NotFoundError` if missing.
2. **Owner check:** session `userId` matches requesting user → full access regardless of `requiredRole`.
3. **Orchestrator/workflow exclusion:** orchestrator and workflow sessions are **never** accessible to non-owners. `NotFoundError` (not `ForbiddenError` — avoids leaking existence).
4. **Participant check:** query `session_participants` table. If user is a participant and role meets or exceeds `requiredRole`, access granted.
5. **Org visibility fallback:**
   - `org_joinable`: access granted for any required role.
   - `org_visible` + `requiredRole === 'viewer'`: read-only access granted.
6. **Denial:** `NotFoundError`.

### Route-Level Access

- **viewer**: read-only endpoints (detail, messages, children, audit log, git state, tunnels, sandbox token, participants, files changed)
- **collaborator**: send messages, clear queue, hibernate, wake, delete tunnels
- **owner**: terminate, update title, manage participants, manage share links, delete

## Encryption

### AES-256-GCM (`lib/crypto.ts`)

Used for all stored secrets (OAuth tokens, org LLM keys, user credentials, custom provider keys).

Key derivation: pads/truncates the `ENCRYPTION_KEY` env var to exactly 32 bytes and uses it directly as the AES key. This is simpler than PBKDF2 but acceptable for a single-tenant deployment.

Encryption: generates random 12-byte IV, encrypts, prepends IV to ciphertext, base64 encodes the result.

### APIKeysDurableObject (Legacy)

A separate DO exists for third-party credential storage using PBKDF2 key derivation (100k iterations, SHA-256) with a static salt. It is declared in `wrangler.toml` and exported, but **not actively called from any route**. The D1-based credential tables have superseded it.

## Client-Side Auth

### Zustand Store (`stores/auth.ts`)

Persisted to `localStorage` under `'valet-auth'`:

```typescript
interface AuthState {
  token: string | null;
  user: User | null;
  orgModelPreferences?: string[];
  isAuthenticated: boolean;
}
```

### API Client (`api/client.ts`)

Every request reads `token` from the auth store and injects `Authorization: Bearer ${token}`. On 401 response: clears auth state and navigates to `/login`.

### Auth Callback Flow

1. OAuth redirect lands at `/auth/callback?token=...&provider=...`.
2. Client extracts token, temporarily sets it in store.
3. Calls `GET /api/auth/me` to validate and fetch profile.
4. On success: sets full auth state. Navigates to `/onboarding` if not completed, otherwise `/`.
5. On failure: clears auth, navigates to `/login?error=validation_failed`.

## Edge Cases & Failure Modes

### First User Bootstrap

The first user to complete OAuth becomes admin automatically. This is checked via `getUserCount() === 1` after user creation. No invite is required for the first user.

### Last Admin Protection

`updateUserRoleSafe()` prevents demoting the last admin. `deleteUserSafe()` prevents deleting the last admin or self-deletion.

### API Token Scopes

The `scopes` field exists on `api_tokens` but is **never enforced** by the auth middleware. All API tokens grant the same access as session tokens.

### Revoked Token Handling

Token revocation is a soft delete (`revokedAt` timestamp). The auth middleware explicitly filters out revoked tokens. The token hash remains in the database.

### No Token Rotation

Session tokens are valid for 7 days with no rotation or extension mechanism. Users must re-authenticate when the token expires. There is no refresh flow for auth session tokens.

### Google Token Refresh

Google refresh tokens are stored but **never used** for automatic token refresh. When the access token expires, the OAuth token becomes stale. Re-authentication refreshes it.

## Implementation Status

### Fully Implemented
- GitHub OAuth flow with email resolution and credential helper setup
- Google OAuth flow with id_token decoding
- Session token authentication (SHA-256 hashed, 7-day expiry)
- API token authentication (SHA-256 hashed, optional expiry, soft revocation)
- Auth middleware with dual-path validation (session token + API token)
- Admin middleware with role check
- Org settings (name, domain gating, email allowlist, session visibility, model preferences)
- Org LLM API keys (CRUD with encryption)
- Custom LLM providers (CRUD with model definitions)
- Invite system (create, validate, accept, email-targeted)
- First-user auto-admin
- Last-admin protection
- Session access control (role hierarchy, participants, share links, org visibility)
- JWT issuance for OAuth state and sandbox access
- AES-256-GCM encryption for all stored secrets
- Client-side auth state with localStorage persistence

### Known Gaps
- **API token scopes:** declared but never checked.
- **Google id_token:** payload decoded without signature verification.
- **Google token refresh:** refresh tokens stored but never used.
- **Auth middleware Drizzle migration:** still uses raw SQL; Drizzle version exists but is unused.
- **APIKeysDurableObject:** legacy DO still exported but superseded by D1 tables.
- **No rate limiting** on auth endpoints.
- **No session token rotation** mechanism.
- **Encryption key derivation:** simplistic pad-to-32-bytes approach (vs. PBKDF2 in the unused DO).
