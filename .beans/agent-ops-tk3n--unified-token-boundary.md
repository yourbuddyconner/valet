---
# valet-tk3n
title: Unified Credential Boundary
status: completed
type: epic
priority: high
tags:
    - integrations
    - architecture
    - security
    - refactor
created_at: 2026-02-24T00:00:00Z
updated_at: 2026-02-25T00:00:00Z
---

Consolidate four independent credential stores into a single `credentials` D1 table, delete the API_KEYS Durable Object, and expose a single `getCredential()` / `storeCredential()` boundary service that all consumers use. This is a real simplification — fewer stores, fewer encryption code paths, fewer moving parts — not just an abstraction layer over the existing mess.

## Problem

Agent-ops currently has **four independent credential stores** that are largely redundant:

| Store | Location | Encryption | Key Derivation | What It Holds |
|---|---|---|---|---|
| `API_KEYS` Durable Object | `src/durable-objects/api-keys.ts` | AES-256-GCM | PBKDF2 (100k iterations, hardcoded salt `'valet-salt'`) | Integration tokens (GitHub, Gmail, GCal) |
| `oauth_tokens` D1 table | `src/lib/db/oauth.ts` | AES-256-GCM | `secret.padEnd(32, '0').slice(0, 32)` raw import | Login OAuth tokens (GitHub, Google) |
| `user_credentials` D1 table | `src/lib/db/oauth.ts` | AES-256-GCM | Same padEnd derivation | 1Password service account token (literally one provider) |
| `user_telegram_config` D1 table | `src/lib/db/telegram.ts` | AES-256-GCM | Same padEnd derivation | Telegram bot token + bot metadata |

### What's actually redundant

**The API_KEYS DO is a 232-line Durable Object doing what a D1 row does.** It stores encrypted credentials keyed by `(userId, service)`. That's a table. The DO adds: per-user instance addressing (`idFromName(userId)`), HTTP-over-loopback for every read/write (`stub.fetch('http://internal/store', ...)`), a separate PBKDF2 key derivation path, and a whole class that needs to be exported from `index.ts` and configured in `wrangler.toml`. All for encrypted key-value storage that D1 handles fine.

**`oauth_tokens` and `user_credentials` are structurally identical tables.** Both store `(userId, provider, encryptedToken)` with the same encryption. `user_credentials` exists solely for 1Password service account tokens. There's no reason these can't be rows in the same table with a `provider` discriminator.

**`user_telegram_config` bundles a token with metadata.** The encrypted bot token (`botTokenEncrypted`) could live in the unified credentials table. The metadata columns (`botUsername`, `botInfo`, `webhookUrl`, `webhookActive`) are Telegram-specific and should stay in their own table — but without the token.

**Two different key derivation schemes for the same algorithm.** The DO uses PBKDF2 with 100k iterations and a hardcoded salt. D1 tables use `padEnd(32, '0')` — which is weaker (no key stretching, deterministic). Both produce AES-256-GCM ciphertext. There's no reason for two schemes.

### Real-world consequences

1. **GitHub credential duality.** A user's GitHub token lives in `oauth_tokens` (from login) AND potentially in the API_KEYS DO (from integration setup). `routes/repos.ts` reads from D1. `services/integrations.ts` reads from the DO. The env assembly for sandboxes (`lib/env-assembly.ts:136`) reads from D1. If the user reauthorizes GitHub via the integration flow, the DO gets a new token but the D1 row doesn't update — and the sandbox gets the old one.

2. **Each consumer knows its own retrieval path.** `services/integrations.ts:130-143` does HTTP fetch to DO. `routes/repos.ts` calls `db.getOAuthToken()` + `decryptString()`. `routes/telegram.ts` calls `db.getUserTelegramToken()`. `lib/env-assembly.ts` calls `db.getOAuthToken()` + `decryptString()` again. Four code paths, four places to get wrong.

3. **The DO's encryption is not portable.** If we ever decouple from Cloudflare (see bean cf0x), the API_KEYS DO and its `DurableObjectState` storage would need a complete migration. D1 data is just SQLite — portable anywhere.

## Design

### Single `credentials` D1 Table

Replace all four stores with one table:

```sql
CREATE TABLE credentials (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  provider TEXT NOT NULL,          -- 'github', 'gmail', 'google_calendar', 'telegram', '1password', etc.
  credential_type TEXT NOT NULL,   -- 'oauth2', 'api_key', 'bot_token', 'service_account'
  encrypted_data TEXT NOT NULL,    -- AES-256-GCM encrypted JSON blob: { accessToken, refreshToken, ... }
  scopes TEXT,                     -- Space-separated scopes (nullable)
  expires_at TEXT,                 -- ISO timestamp (nullable, for OAuth tokens)
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE(user_id, provider)
);

CREATE INDEX idx_credentials_user ON credentials(user_id);
CREATE INDEX idx_credentials_provider ON credentials(provider);
```

The `encrypted_data` column holds a JSON blob encrypted with a single, consistent scheme:

```typescript
// Encrypted JSON shape varies by credential_type:
// oauth2:          { access_token, refresh_token?, token_type?, ... }
// api_key:         { api_key }
// bot_token:       { bot_token }
// service_account: { token }
```

### Standardized Encryption

Standardize on PBKDF2 key derivation for all credentials. The current D1 `padEnd(32, '0')` scheme is weak — no key stretching means brute-force is faster.

**Migration strategy:** A one-time batch script decrypts all existing rows from `oauth_tokens` and `user_credentials` using the old `padEnd` scheme, re-encrypts with PBKDF2, and inserts into the new `credentials` table. After migration, only PBKDF2 encryption exists. No runtime fallback needed.

```typescript
// packages/worker/src/lib/crypto.ts — add PBKDF2 variant

export async function encryptStringPBKDF2(plaintext: string, secret: string): Promise<string> {
  const keyMaterial = new TextEncoder().encode(secret);
  const baseKey = await crypto.subtle.importKey('raw', keyMaterial, 'PBKDF2', false, ['deriveKey']);
  const key = await crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: new TextEncoder().encode('valet-credentials'), iterations: 100000, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );

  const iv = crypto.getRandomValues(new Uint8Array(12));
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, new TextEncoder().encode(plaintext));

  const combined = new Uint8Array(iv.length + encrypted.byteLength);
  combined.set(iv);
  combined.set(new Uint8Array(encrypted), iv.length);

  return btoa(String.fromCharCode(...combined));
}
```

### Credential Boundary Service

```typescript
// packages/worker/src/services/credentials.ts

export interface ResolvedCredential {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scopes?: string[];
  credentialType: 'oauth2' | 'api_key' | 'bot_token' | 'service_account';
  /** Whether a refresh was performed to get this credential */
  refreshed: boolean;
}

export interface CredentialResolutionError {
  service: string;
  reason: 'not_found' | 'expired' | 'refresh_failed' | 'decryption_failed' | 'revoked';
  message: string;
}

export type CredentialResult =
  | { ok: true; credential: ResolvedCredential }
  | { ok: false; error: CredentialResolutionError };

/**
 * Single entry point for all credential resolution.
 * Reads from the unified `credentials` table. Handles decryption,
 * expiration checking, and auto-refresh.
 */
export async function getCredential(
  env: Env,
  userId: string,
  provider: string,
  options?: { forceRefresh?: boolean }
): Promise<CredentialResult>;

/**
 * Single entry point for credential storage.
 * Encrypts and writes to the unified `credentials` table.
 */
export async function storeCredential(
  env: Env,
  userId: string,
  provider: string,
  credentials: Record<string, string>,
  options?: {
    credentialType?: 'oauth2' | 'api_key' | 'bot_token' | 'service_account';
    scopes?: string;
    expiresAt?: string;
  }
): Promise<void>;

/**
 * Revoke (delete) credentials for a provider.
 */
export async function revokeCredential(
  env: Env,
  userId: string,
  provider: string,
): Promise<void>;

/**
 * List all credentials for a user (without decrypting).
 */
export async function listCredentials(
  env: Env,
  userId: string,
): Promise<Array<{ provider: string; credentialType: string; scopes?: string; expiresAt?: string; createdAt: string }>>;

/**
 * Resolve credentials for multiple providers in one call.
 */
export async function resolveCredentials(
  env: Env,
  userId: string,
  providers: string[],
): Promise<Map<string, CredentialResult>>;
```

No more `substrate` field — there's only one store. No resolution chains or priority ordering — each (userId, provider) pair has exactly one row.

### Auto-Refresh Logic (OAuth)

Credential refresh moves out of individual integration classes and into the boundary:

```typescript
async function getCredential(env, userId, provider, options): Promise<CredentialResult> {
  const row = await db.getCredential(env.DB, userId, provider);
  if (!row) return { ok: false, error: { service: provider, reason: 'not_found', message: `No credentials for ${provider}` } };

  const data = await decryptCredentialData(row.encryptedData, env.ENCRYPTION_KEY);

  // Check expiration (with 60-second buffer)
  if (row.expiresAt && new Date(row.expiresAt).getTime() - Date.now() < 60_000) {
    if (data.refresh_token) {
      const refreshed = await attemptRefresh(env, userId, provider, data);
      if (refreshed.ok) return refreshed;
    }
    if (options?.forceRefresh) {
      return { ok: false, error: { service: provider, reason: 'expired', message: 'Token expired and refresh failed' } };
    }
    // Return potentially expired credential — caller can decide
  }

  return {
    ok: true,
    credential: {
      accessToken: data.access_token || data.api_key || data.bot_token || data.token,
      refreshToken: data.refresh_token,
      expiresAt: row.expiresAt ? new Date(row.expiresAt) : undefined,
      scopes: row.scopes?.split(' '),
      credentialType: row.credentialType,
      refreshed: false,
    },
  };
}
```

Per-provider refresh handlers:

```typescript
async function attemptRefresh(env, userId, provider, data): Promise<CredentialResult> {
  switch (provider) {
    case 'gmail':
    case 'google_calendar':
      return refreshGoogleToken(env, userId, provider, data);
    case 'github':
      // GitHub OAuth tokens don't expire (PATs) or use OAuth app refresh
      return { ok: false, error: { service: provider, reason: 'refresh_failed', message: 'GitHub tokens do not support refresh' } };
    default:
      return { ok: false, error: { service: provider, reason: 'refresh_failed', message: `No refresh handler for ${provider}` } };
  }
}
```

## Migration Plan

### Phase 1: Create unified table and credential service

1. Create D1 migration for `credentials` table
2. Add PBKDF2 encryption functions to `lib/crypto.ts`
3. Create `services/credentials.ts` with `getCredential()`, `storeCredential()`, `revokeCredential()`, `listCredentials()`
4. Create `lib/db/credentials.ts` with DB helpers for the new table

### Phase 2: Data migration — copy existing credentials

Write a one-time migration script that:

1. Reads all `oauth_tokens` rows → decrypts with old `padEnd` scheme → re-encrypts with PBKDF2 → inserts into `credentials`
2. Reads all `user_credentials` rows → same decrypt/re-encrypt → inserts into `credentials`
3. Reads all `user_telegram_config` rows → extracts `botTokenEncrypted` → re-encrypts → inserts into `credentials` with provider='telegram'

The API_KEYS DO is **not migrated** — users reconnect their integrations. The migration script must be idempotent (use `ON CONFLICT DO UPDATE`) so it can be re-run safely.

### Phase 3: Migrate consumers to use `getCredential()` / `storeCredential()`

Update consumers one at a time. Each migration is a small, testable change:

| Consumer | Current Code | After |
|---|---|---|
| `services/integrations.ts:62-73` | `env.API_KEYS.idFromName(userId)` → DO stub fetch | `storeCredential(env, userId, service, credentials, { credentialType: 'oauth2' })` |
| `services/integrations.ts:130-143` | DO stub fetch to retrieve | `getCredential(env, userId, service)` |
| `routes/repos.ts` | `db.getOAuthToken()` + `decryptString()` | `getCredential(env, userId, 'github')` |
| `lib/env-assembly.ts:136-140` | `db.getOAuthToken()` + `decryptString()` | `getCredential(env, userId, 'github')` |
| `lib/env-assembly.ts:63-68` | `db.getUserCredential()` + `decryptString()` | `getCredential(env, userId, '1password')` |
| `routes/auth.ts:113` | `db.setUserCredential()` | `storeCredential(env, userId, '1password', { token }, { credentialType: 'service_account' })` |
| `routes/auth.ts:91` | `db.listUserCredentials()` | `listCredentials(env, userId)` |
| OAuth callback routes | `db.upsertOAuthToken()` | `storeCredential(env, userId, 'github', { access_token, refresh_token }, { credentialType: 'oauth2', scopes })` |
| `services/telegram.ts` | `db.saveUserTelegramConfig()` with encrypted token | `storeCredential(env, userId, 'telegram', { bot_token }, { credentialType: 'bot_token' })` + separate metadata save |
| `routes/telegram.ts` | `db.getUserTelegramToken()` | `getCredential(env, userId, 'telegram')` + `db.getTelegramConfig()` for metadata |

### Phase 4: Decouple Telegram metadata from credential storage

Split `user_telegram_config` into:
- **Credential** → row in `credentials` table (provider='telegram')
- **Metadata** → keep `user_telegram_config` but remove `botTokenEncrypted` column. Keep `botUsername`, `botInfo`, `webhookUrl`, `webhookActive`.

This is a D1 migration: `ALTER TABLE user_telegram_config DROP COLUMN bot_token_encrypted` (SQLite doesn't support DROP COLUMN directly — recreate the table without it).

### Phase 5: Delete old stores

Once all consumers use the credential boundary and data is migrated:

1. **Delete `durable-objects/api-keys.ts`** — the entire DO class
2. **Remove `API_KEYS` from `wrangler.toml`** durable_objects bindings and migrations
3. **Remove `API_KEYS` from `env.ts`** Env interface
4. **Delete `oauth_tokens` D1 table** — migration to drop table
5. **Delete `user_credentials` D1 table** — migration to drop table
6. **Remove `botTokenEncrypted` from `user_telegram_config`**
7. **Delete `lib/db/oauth.ts`** — `upsertOAuthToken`, `getOAuthToken`, `getUserCredential`, `setUserCredential` functions
8. **Delete `routes/api-keys.ts`** if it exists as a standalone route

### Phase 6: Clean up

- Remove `API_KEYS` DO export from `index.ts`
- Remove any remaining references to old table names
- Update `docs/specs/integrations.md` and `docs/specs/auth-access.md`

## What Gets Deleted

| Thing | Lines | Why It Can Go |
|---|---|---|
| `src/durable-objects/api-keys.ts` | 232 | Entire DO replaced by D1 table + `services/credentials.ts` |
| `API_KEYS` wrangler binding | — | No more DO to bind |
| `API_KEYS: DurableObjectNamespace` in `env.ts` | — | No more DO |
| `src/routes/api-keys.ts` | ~100 | Routes were wrappers around DO calls |
| `src/lib/db/oauth.ts` functions | ~124 | Replaced by `lib/db/credentials.ts` |
| `oauth_tokens` D1 table | — | Replaced by `credentials` table |
| `user_credentials` D1 table | — | Replaced by `credentials` table |
| `botTokenEncrypted` column | — | Moved to `credentials` table |
| Credential refresh in `gmail.ts` | ~20 | Moved to `services/credentials.ts` |
| Credential refresh in `google-calendar.ts` | ~20 | Moved to `services/credentials.ts` |

Rough estimate: **~500 lines deleted**, ~250 lines added in `services/credentials.ts` + `lib/db/credentials.ts`.

## Files to Create

| File | Purpose |
|---|---|
| `packages/worker/migrations/NNNN_credentials.sql` | D1 migration for unified `credentials` table |
| `packages/worker/src/services/credentials.ts` | Credential boundary: `getCredential()`, `storeCredential()`, `revokeCredential()`, `listCredentials()`, refresh logic |
| `packages/worker/src/lib/db/credentials.ts` | DB helpers for the `credentials` table |
| `packages/worker/src/lib/schema/credentials.ts` | Drizzle schema for `credentials` table |

## Files to Delete

| File | Reason |
|---|---|
| `packages/worker/src/durable-objects/api-keys.ts` | Entire DO replaced by D1 + service |
| `packages/worker/src/routes/api-keys.ts` | Routes were DO wrappers |

## Files to Modify

| File | Change |
|---|---|
| `packages/worker/src/lib/crypto.ts` | Add `encryptStringPBKDF2()` / `decryptStringPBKDF2()` + fallback-aware `decryptAuto()` |
| `packages/worker/src/env.ts` | Remove `API_KEYS: DurableObjectNamespace` from Env |
| `packages/worker/src/index.ts` | Remove `APIKeysDurableObject` export, remove api-keys route mount |
| `packages/worker/wrangler.toml` | Remove `API_KEYS` from durable_objects bindings |
| `packages/worker/src/services/integrations.ts` | Replace DO fetch with `getCredential()` / `storeCredential()` |
| `packages/worker/src/routes/integrations.ts` | Replace credential storage with `storeCredential()` |
| `packages/worker/src/routes/repos.ts` | Replace `db.getOAuthToken()` + `decryptString()` with `getCredential()` |
| `packages/worker/src/routes/auth.ts` | Replace `db.setUserCredential()` / `db.listUserCredentials()` with `storeCredential()` / `listCredentials()` |
| `packages/worker/src/lib/env-assembly.ts` | Replace `db.getOAuthToken()` and `db.getUserCredential()` with `getCredential()` |
| `packages/worker/src/routes/telegram.ts` | Split: `getCredential()` for bot token, `db.getTelegramConfig()` for metadata only |
| `packages/worker/src/services/telegram.ts` | Use `storeCredential()` for bot token, separate metadata save |
| `packages/worker/src/lib/db/telegram.ts` | Remove `botTokenEncrypted` from saves/reads, keep metadata functions |
| `packages/worker/src/integrations/gmail.ts` | Remove inline credential refresh logic |
| `packages/worker/src/integrations/google-calendar.ts` | Remove inline credential refresh logic |
| `packages/shared/src/types/index.ts` | Remove `StoredAPIKey` type if only used by old DO |

## Relationship to Other Beans

- **valet-cp7w (Control Plane / Execution Plane Split)** — Prerequisite. Once `getCredential()` exists, the control plane can own credential resolution while the execution plane just receives resolved credentials.
- **valet-pg9a (Policy-Gated Actions)** — Action execution needs credentials. The action service calls `getCredential()` to resolve credentials before executing external side effects.
- **valet-pa5m (Polymorphic Action Sources)** — Action sources receive resolved credentials via their execution context, never fetching credentials directly.
- **valet-cf0x (Decouple from Cloudflare)** — Deleting the API_KEYS DO removes one Cloudflare-specific primitive from the codebase. One fewer DO to abstract away.
- **valet-ch4t (Pluggable Channel Transports)** — Channel transports call `getCredential(env, userId, channelType)` to resolve bot credentials or OAuth credentials for outbound message delivery. Telegram's bot token moves from `user_telegram_config.botTokenEncrypted` into the unified `credentials` table with `provider='telegram'`.

## Resolved Questions

1. **Data migration for API_KEYS DO.** Don't migrate. The integration framework has limited adoption — users can reconnect their integrations. The API_KEYS DO gets deleted outright with no data extraction.

2. **Encryption migration rollout.** Batch migration via a one-time script. Decrypt all rows from old D1 stores with the `padEnd` scheme, re-encrypt with PBKDF2, insert into the unified `credentials` table. No lazy fallback needed.

3. **Naming.** "Credentials" everywhere. The table is `credentials`, the service is `services/credentials.ts`, the functions are `getCredential()` / `storeCredential()` / `revokeCredential()`, the types are `ResolvedCredential` / `CredentialResult`.

## Acceptance Criteria

- [x] `credentials` D1 table exists with migration (0041)
- [x] `services/credentials.ts` exists with `getCredential()`, `storeCredential()`, `revokeCredential()`, `listCredentials()`
- [x] All new encryption uses PBKDF2 key derivation
- [x] `durable-objects/api-keys.ts` deleted
- [x] `API_KEYS` removed from `wrangler.toml` and `env.ts`
- [x] `oauth_tokens` table dropped (migration 0042)
- [x] `user_credentials` table dropped (migration 0042)
- [x] `user_telegram_config` no longer stores `botTokenEncrypted` (migration 0042 recreates table without it)
- [x] All consumers use `getCredential()` / `storeCredential()`: integrations, repos, auth, env-assembly, telegram
- [x] Auto-refresh for Gmail and Google Calendar handled in credential boundary (`refreshGoogleToken`)
- [x] No direct credential store access outside `services/credentials.ts` — `lib/db/oauth.ts` deleted, Drizzle schemas for old tables removed
- [x] `StoredAPIKey` type removed from shared package
- [x] `pnpm typecheck` passes
- [x] Old tables dropped instead of migrated — users re-authenticate (acceptable given limited adoption)
