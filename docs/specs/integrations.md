# Integrations

> Defines all external service integrations — GitHub (OAuth, webhooks, API proxy), Telegram bot, the generic integration framework, custom LLM providers, and the channel binding system that routes messages across platforms.

## Scope

This spec covers:

- Generic integration framework (BaseIntegration, registry, sync lifecycle)
- Concrete integrations: GitHub (sync class), Gmail, Google Calendar
- GitHub production path (login OAuth, API proxy for repos/PRs/issues, webhooks)
- Telegram bot (setup, webhook handler, bidirectional messaging)
- Channel binding system (scope keys, prompt routing)
- Custom LLM providers (admin CRUD)
- Credential storage architecture
- Slack status (schema-only)

### Boundary Rules

- This spec does NOT cover OAuth login flows or auth middleware (see [auth-access.md](auth-access.md))
- This spec does NOT cover session lifecycle or access control (see [sessions.md](sessions.md))
- This spec does NOT cover channel routing to the orchestrator (see [orchestrator.md](orchestrator.md))
- This spec does NOT cover sandbox-internal tool implementations (see [sandbox-runtime.md](sandbox-runtime.md))

## Data Model

### `integrations` table

One row per user-service connection in the generic framework.

| Column | Type | Default | Notes |
|--------|------|---------|-------|
| `id` | text PK | — | UUID |
| `userId` | text NOT NULL | — | FK to users, CASCADE DELETE |
| `service` | text NOT NULL | — | e.g. `'github'`, `'gmail'`, `'google_calendar'` |
| `config` | JSON text NOT NULL | `{ syncFrequency: 'manual', entities: [] }` | Sync config |
| `status` | text NOT NULL | `'pending'` | `'active'` / `'error'` / `'pending'` / `'disconnected'` |
| `errorMessage` | text | — | Last error |
| `lastSyncedAt` | text | — | ISO datetime |
| `scope` | text NOT NULL | `'user'` | `'user'` or `'org'` |

**Indexes:** unique on `(userId, service)`.

### `sync_logs` table

One row per sync attempt.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `integrationId` | text NOT NULL | FK to integrations, CASCADE DELETE |
| `status` | text NOT NULL | `'pending'` / `'running'` / `'completed'` / `'failed'` |
| `recordsSynced` | integer | Count of records processed |
| `error` | text | Error message |
| `startedAt` / `completedAt` | text | ISO datetime |

### `synced_entities` table

Individual records fetched during syncs.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `integrationId` | text NOT NULL | FK to integrations, CASCADE DELETE |
| `entityType` | text NOT NULL | e.g. `'repository'`, `'issue'` |
| `externalId` | text NOT NULL | Provider-specific ID |
| `data` | JSON text | Entity data |

**Note:** This table exists in the schema but syncs currently **do not persist data to it**. Sync handlers fetch and count records but discard the actual data.

### `user_telegram_config` table

One Telegram bot per user.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `userId` | text NOT NULL UNIQUE | FK to users, CASCADE DELETE |
| `botTokenEncrypted` | text NOT NULL | AES-256-GCM encrypted |
| `botUsername` | text NOT NULL | Bot's @username |
| `botInfo` | text NOT NULL | JSON-serialized BotInfo from grammy |
| `webhookUrl` | text | Registered webhook URL |
| `webhookActive` | boolean | `false` |

### `org_repositories` table

Registered org repos.

| Column | Type | Notes |
|--------|------|-------|
| `id` | text PK | UUID |
| `orgId` | text NOT NULL | `'default'` |
| `provider` | text NOT NULL | `'github'` |
| `owner` | text NOT NULL | GitHub owner |
| `name` | text NOT NULL | Repo name |
| `fullName` | text NOT NULL | `owner/name` |
| `enabled` | boolean NOT NULL | `true` |

### `custom_providers` table

Custom OpenAI-compatible LLM providers (documented in [auth-access.md](auth-access.md), referenced here for completeness).

### TypeScript Types

```typescript
type IntegrationService = 'github' | 'gmail' | 'google_calendar' | 'google_drive'
                        | 'notion' | 'hubspot' | 'ashby' | 'discord' | 'xero';

type ChannelType = 'web' | 'slack' | 'github' | 'api' | 'telegram';
```

Services beyond `github`, `gmail`, and `google_calendar` are defined in the type union but have no `BaseIntegration` implementation.

## Generic Integration Framework

### Architecture

```
BaseIntegration (abstract class)
    ├── GitHubIntegration
    ├── GmailIntegration
    └── GoogleCalendarIntegration

IntegrationRegistry (factory map)
    └── register(service, factory)
    └── get(service) → new instance
```

### BaseIntegration Contract

```typescript
abstract class BaseIntegration {
  abstract readonly service: IntegrationService;
  abstract readonly supportedEntities: string[];

  setCredentials(credentials): void;
  abstract validateCredentials(): boolean;
  abstract testConnection(): Promise<boolean>;
  abstract sync(options: SyncOptions): Promise<SyncResult>;
  abstract fetchEntity(entityType, id): Promise<unknown>;
  abstract pushEntity(entityType, data): Promise<string>;
  abstract handleWebhook(event, payload): Promise<void>;

  // Optional OAuth:
  getOAuthUrl?(redirectUri, state): string;
  exchangeOAuthCode?(code, redirectUri): Promise<IntegrationCredentials>;
  refreshOAuthTokens?(refreshToken): Promise<IntegrationCredentials>;
}
```

The registry creates **fresh instances** each time — credentials must be set before every use.

### Configuration Flow

1. Client calls `POST /api/integrations` with service name and credentials.
2. Service looks up handler from registry, sets credentials, validates, tests connection.
3. Credentials stored in `API_KEYS` Durable Object (not D1).
4. Integration record created in D1 with status `'active'`.

### Sync Flow

1. Client calls `POST /api/integrations/:id/sync`.
2. Service validates integration is active, retrieves credentials from DO.
3. Sync runs in background via `ctx.waitUntil()`.
4. Sync log created and updated with results.
5. **Data is fetched and counted but not persisted to `synced_entities`.**

### Concrete Implementations

**GitHubIntegration:**
- Entities: `repositories`, `issues`, `pull_requests`, `commits`.
- Sync: fetches user repos (all pages), then issues + PRs for up to 10 most recent repos (50 each).
- `fetchEntity`: supports `repository`, `issue`, `pull_request` by `owner/repo/number`.
- `pushEntity`: supports `issue` (create) and `comment` (create on issue).
- `handleWebhook`: **stub** — logs only.
- OAuth: requests `repo read:user read:org` scopes.

**GmailIntegration:**
- Entities: `messages`, `threads`, `labels`, `drafts`.
- Full email operations: send, reply, draft, labels, attachments.
- Auto token refresh via `gmailFetch()` (checks `expires_at`, refreshes if within 1 minute).
- MIME email construction with multipart support.
- OAuth scopes: `gmail.readonly`, `gmail.send`, `gmail.compose`, `gmail.modify`, `gmail.labels`.

**GoogleCalendarIntegration:**
- Entities: `calendars`, `events`.
- Full event CRUD, quick-add, RSVP, free/busy queries, available slot computation.
- Google Meet conference data support.
- Recurring events via RRULE.
- Same auto token refresh pattern as Gmail.
- OAuth scopes: `calendar`, `calendar.events`.

## GitHub (Production Path)

GitHub has a **dual integration architecture**. The generic framework class exists for data sync, but the production GitHub functionality is implemented through dedicated routes and services, using OAuth tokens stored in D1 (not the integration framework's DO).

When a user links GitHub through the dedicated `/api/me/github/link` flow, the worker must also mark the `github` integration active so `list_tools(service="github")` exposes the GitHub action catalog immediately.

### API Proxy Routes (`/api/repos`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List user's GitHub repos (paginated) |
| GET | `/validate` | Validate repo URL access (checks push permissions) |
| GET | `/:owner/:repo/pulls` | List open PRs |
| GET | `/:owner/:repo/issues` | List open issues (excludes PRs) |
| POST | `/pull-request` | Create a PR (auto-detects base branch) |

Token retrieval: decrypts from `oauth_tokens` table using `ENCRYPTION_KEY`.

### Org Repository Management

**Admin routes** (`/api/admin/repos`): CRUD for org repositories, persona defaults. Admin-only.

**Read routes** (`/api/repos/org`): List org repositories. All authenticated users.

### Webhook Handling (`/webhooks/github`)

1. Verifies `X-Hub-Signature-256` via HMAC-SHA256 (when `GITHUB_WEBHOOK_SECRET` configured).
2. **`pull_request` events:** Finds sessions by `(repoFullName, prNumber)`, determines PR state (`merged`/`closed`/`draft`/`open`), updates `session_git_state`, notifies session DO.
3. **`push` events:** Finds sessions by `(repoFullName, branch)`, increments commit count in `session_git_state`, notifies session DO.

**Signature verification caveat:** Signature is computed over `JSON.stringify(payload)` (re-serialized), not the original raw body.

## Telegram Bot

### Setup Flow

1. User provides bot token via `POST /api/me/telegram`.
2. Service validates token by calling `bot.api.getMe()`.
3. Saves config with encrypted token.
4. Registers webhook URL: `{workerUrl}/telegram/webhook/{userId}`.
5. Registers slash commands with Telegram.

### Webhook Handler (`POST /telegram/webhook/:userId`)

Per-user webhook endpoint called by Telegram. For each incoming message:

1. Retrieves encrypted bot token and config.
2. Resolves user's orchestrator session ID.
3. Creates grammy Bot instance with pre-loaded `botInfo`.
4. Routes based on message type:

**Slash commands:** `/start`, `/help`, `/status`, `/stop`, `/clear`, `/refresh`, `/sessions` — interact with SessionAgent DO directly.

**Text/Photo/Voice/Audio messages:**
- Text: formats with attribution/quote blocks.
- Media: downloads file, converts to base64 data URL, creates attachment payload.
- **Routing:** checks for channel binding by `telegramScopeKey(userId, chatId)`. If found → bound session. If not → orchestrator via `dispatchOrchestratorPrompt()`.

### Utilities

- `markdownToTelegramHtml()` — converts Markdown to Telegram-compatible HTML (code blocks, bold, italic, links with entity escaping).
- `sendTelegramMessage()` — sends text with HTML parse mode.
- `sendTelegramPhoto()` — sends photos via multipart upload with optional caption.

### Disconnect

1. Retrieves and decrypts bot token.
2. Calls `bot.api.deleteWebhook()` (best-effort).
3. Deletes config row.

## Channel Binding System

### Prompt Routing (`POST /api/prompt`)

The channel-agnostic prompt endpoint:

1. Compute scope key from `channelType + channelId` (or use explicit `scopeKey`).
2. Look up `channel_bindings` by scope key.
3. **If binding found:** route to bound session's DO via `POST http://do/prompt`.
4. **If no binding:** fall back to orchestrator via `dispatchOrchestratorPrompt()`.

**Key principle:** unbound prompts default to the orchestrator.

### Auto-Binding

Every non-orchestrator session gets a web channel binding auto-created at session creation:
```
channelType: 'web', channelId: sessionId, scopeKey: webManualScopeKey(userId, sessionId)
```

### Queue Modes

Each binding has a `queueMode` (`followup`/`collect`/`steer`) and `collectDebounceMs` that determine how the session DO handles incoming prompts on that channel.

## Custom LLM Providers

Admin-managed custom OpenAI-compatible providers. Full details in [auth-access.md](auth-access.md).

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/admin/custom-providers` | List providers |
| PUT | `/api/admin/custom-providers/:providerId` | Create/update |
| DELETE | `/api/admin/custom-providers/:providerId` | Delete |

Provider IDs must be lowercase alphanumeric with hyphens, and cannot collide with built-in providers (`anthropic`, `openai`, `google`, `parallel`).

## Credential Storage Architecture

Four separate credential storage mechanisms coexist:

| Mechanism | Storage | Used By |
|-----------|---------|---------|
| `oauth_tokens` table (D1, AES-256-GCM) | `db.upsertOAuthToken()` | GitHub login, Google login, GitHub API proxy |
| `API_KEYS` Durable Object | `env.API_KEYS.idFromName(userId)` | Generic integration framework |
| `user_credentials` table (D1, AES-256-GCM) | `db.setUserCredential()` | 1Password service account token |
| `user_telegram_config` table (D1, AES-256-GCM) | `db.saveUserTelegramConfig()` | Telegram bot token |

The generic framework and the production GitHub path store credentials **independently**. Configuring GitHub through the framework stores the token in the DO; logging in with GitHub stores it in D1. They are not connected.

## API Contract

### Integration Routes (`/api/integrations`)

| Method | Path | Description |
|--------|------|-------------|
| GET | `/` | List user's + org-scope integrations |
| GET | `/available` | List registered services and supported entities |
| POST | `/` | Configure new integration |
| GET | `/:id` | Get integration details |
| POST | `/:id/sync` | Trigger sync (background) |
| GET | `/:id/sync/:syncId` | Get sync status |
| GET | `/:id/entities/:type` | Get synced entities (paginated) |
| DELETE | `/:id` | Remove integration (revokes credentials) |
| GET | `/:service/oauth` | Get OAuth URL for integration |
| POST | `/:service/oauth/callback` | Exchange OAuth code |

### Telegram Routes (`/api/me/telegram`)

| Method | Path | Description |
|--------|------|-------------|
| POST | `/` | Set up Telegram bot |
| GET | `/` | Get current config (no token) |
| DELETE | `/` | Disconnect bot |

### Telegram Webhook

| Method | Path | Description |
|--------|------|-------------|
| POST | `/telegram/webhook/:userId` | Telegram-to-platform message handler |

### Other Webhook Endpoints

| Method | Path | Status |
|--------|------|--------|
| POST | `/webhooks/github` | Functional (PR events, push events) |
| POST | `/webhooks/notion` | Stub (log only) |
| POST | `/webhooks/hubspot` | Stub (log only) |
| POST | `/webhooks/discord` | Stub (handles ping verification only) |
| POST | `/webhooks/xero` | Stub (log only) |
| ALL | `/webhooks/*` | Catch-all routes to workflow trigger system |

## Edge Cases & Failure Modes

### Credential Storage Duality

GitHub login tokens (in `oauth_tokens`) and GitHub integration framework tokens (in `API_KEYS` DO) are independent. A user who logged in with GitHub has a token in D1 but no integration framework record, and vice versa.

### Sync Data Not Persisted

The `synced_entities` table exists but sync handlers fetch data without writing to it. Sync logs record counts but the actual data is discarded.

### Telegram Webhook per User

Each user's Telegram bot has its own webhook URL (`/telegram/webhook/:userId`). If the user disconnects and reconnects with a different bot token, the old webhook is deleted first (best-effort).

### Integration OAuth vs Login OAuth

The integration routes (`GET /api/integrations/:service/oauth`) provide OAuth URLs for connecting services *within* the integration framework. These are distinct from the login OAuth routes (`GET /auth/github`, `GET /auth/google`). The integration OAuth callback returns raw credentials to the client but does not automatically create the integration record.

### Client-Side Update Hook Mismatch

`useUpdateIntegration()` calls `PATCH /api/integrations/:id` but no PATCH endpoint exists on the server — this would 404.

## Implementation Status

### Fully Implemented
- GitHub login OAuth with token storage in D1
- GitHub API proxy (repos, PRs, issues, PR creation)
- GitHub webhooks (PR state updates, push commit counting)
- Telegram bot (setup, disconnect, bidirectional messaging, slash commands, media support, HTML formatting)
- Channel binding system with scope key routing and queue modes
- Generic integration framework (base class, registry, routes, service layer)
- Three concrete integrations: GitHub, Gmail, Google Calendar (all with full API coverage)
- Custom LLM providers (admin CRUD)
- Org repository management

### Partially Implemented / Stubbed
- **Synced entity persistence:** table exists, sync handlers don't write to it.
- **GitHub integration `handleWebhook`:** logs only, no entity updates.
- **Integration OAuth callback:** returns credentials but doesn't auto-create integration record.
- **Discord webhook:** handles ping verification only.
- **Notion, HubSpot, Xero webhooks:** log and return `{ received: true }`.

### Not Implemented
- **Slack:** schema columns and env vars exist but no routes, service, or bot implementation. Planned for Phase 4.
- **Notion, HubSpot, Ashby, Discord, Xero, Google Drive integrations:** listed in `IntegrationService` type but no `BaseIntegration` subclass exists. Would fail if configured through the framework.
- **Linear:** mentioned in CLAUDE.md as planned but no code or schema exists.
