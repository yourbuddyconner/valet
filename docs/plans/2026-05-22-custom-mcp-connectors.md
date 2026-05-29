# Custom Remote MCP Connectors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add admin-managed custom remote MCP connectors with no-auth, OAuth (admin-provided client credentials), and API key/bearer support. Custom connector tools integrate into existing tool discovery, action policy, approval, and audit paths.

**Architecture:** New `custom_mcp_connectors` D1 table stores connector configuration. A worker-side custom connector service builds request-scoped connector context from D1; `IntegrationRegistry` stays a static singleton and only consumes that request context as a fallback. OAuth uses admin-provided `client_id`/`client_secret` instead of dynamic registration. `McpClient` gains static header support, injectable safe fetch, and protocol version updates. Admin UI follows the existing section pattern in settings; user-facing connection flow reuses the existing integration OAuth path.

**Tech Stack:** TypeScript, Hono, Drizzle ORM, Cloudflare D1, React 19, TanStack Query, Vitest, pnpm.

---

## Source Documents

- Spec: `docs/specs/2026-05-22-custom-mcp-connectors-design.md`
- MCP client: `packages/sdk/src/mcp/client.ts`
- MCP action source: `packages/sdk/src/mcp/action-source.ts`
- MCP OAuth: `packages/sdk/src/mcp/oauth.ts`
- MCP types: `packages/sdk/src/mcp/types.ts`
- Integration registry: `packages/worker/src/integrations/registry.ts`
- Integration packages (generated): `packages/worker/src/integrations/packages.ts`
- Integration routes: `packages/worker/src/routes/integrations.ts`
- Session tools: `packages/worker/src/services/session-tools.ts`
- Credentials service: `packages/worker/src/services/credentials.ts`
- Action policy: `packages/worker/src/services/action-policy.ts`, `actions.ts`
- Disabled actions: `packages/worker/src/services/disabled-actions.ts`
- Admin settings UI: `packages/client/src/routes/settings/admin.tsx`
- Integration dialog: `packages/client/src/components/integrations/connect-integration-dialog.tsx`
- OAuth callback: `packages/client/src/routes/integrations/callback.tsx`

## File Map

### Migration & Schema

- Create `packages/worker/migrations/0015_custom_mcp_connectors.sql`
  - Creates `custom_mcp_connectors` table with all columns from spec.
  - Adds `oauth_token_endpoint_auth_method` with `none | client_secret_basic | client_secret_post`.
  - Unique index on `service_slug` (global uniqueness). Downstream service-keyed tables are not org-scoped today, so per-org slug reuse would leak cache/policy state.
  - `created_by` is nullable with `ON DELETE SET NULL`, matching durable admin-owned config patterns.
  - Additional static request headers are stored in `encrypted_additional_headers`, not plaintext.
  - Adds cleanup/performance indexes: `idx_custom_mcp_connectors_org_status`, `idx_disabled_actions_service_cleanup`, `idx_action_policies_service_cleanup`, `idx_uapo_service_cleanup`, `idx_ai_policy_id`, `idx_ai_org_policy_id`, and `idx_ai_user_override_id`.
- Create `packages/worker/src/lib/schema/custom-mcp-connectors.ts`
  - Drizzle table definition for `customMcpConnectors`.
  - Export from `schema/index.ts`.

### DB Helpers

- Create `packages/worker/src/lib/db/custom-mcp-connectors.ts`
  - `listConnectors(db, orgId = 'default')` — all connectors for an org, for admin listing.
  - `listActiveConnectors(db, orgId = 'default')` — active connectors only, for runtime tool/OAuth paths. MVP callers pass explicit org ID where available and default to `'default'` otherwise.
  - `getConnector(db, id)` — single connector by ID.
  - `getConnectorBySlug(db, slug)` — single connector by globally unique slug.
  - `createConnector(db, data)` — insert with ID generation.
  - `updateConnector(db, id, data)` — partial update.
  - `deleteConnector(db, id)` — hard delete for the connector row only. Cleanup cascade is performed by `services/custom-mcp-connectors.ts` using one raw `D1Database.batch()` across all affected tables.
  - Add delete-by-service helpers for `mcp_tool_cache`, `disabled_actions`, `action_policies`, and `user_action_policy_overrides` instead of embedding route-local SQL.
  - Export from `lib/db.ts`.

### Worker Service Boundary

- Create `packages/worker/src/services/custom-mcp-connectors.ts`
  - `resolveOrgIdOrDefault(db): Promise<string>` — returns the current org when available, otherwise `'default'`.
  - `listConnectorSummaries(db, orgId = 'default')` — redacted admin list data with tool counts.
  - `loadCustomMcpConnectorContext(env, db, orgId = 'default')` — loads active connectors, decrypts secrets/headers, validates header policy, and returns a request-scoped `CustomMcpConnectorContext`.
  - `getCustomMcpConnectorBySlug(env, db, slug, orgId = 'default')` — built-in-first slug resolver support for routes/services.
  - `getCustomMcpOAuthConfig(env, db, slug, orgId = 'default')` — returns OAuth endpoints/client config with decrypted secret and token endpoint auth method.
  - `createCustomMcpConnector(...)`, `updateCustomMcpConnector(...)`, `deleteCustomMcpConnectorCascade(...)` — centralize validation, encryption, cache invalidation, safe URL validation, and D1 batch cleanup.
  - Routes, session tools, credential refresh, and DO approval continuation must call this service. Do not duplicate connector decryption/header composition in `session-tools.ts` or route-local helpers.

### Shared Types

- Modify `packages/shared/src/types/index.ts`
  - Widen integration service fields that can hold runtime custom slugs:
    - `Integration.service: string`
    - `ConfigureIntegrationRequest.service: string`
  - Keep `IntegrationService` as the built-in service union for static-service-specific code.
  - Add `CustomMcpConnector` type (id, orgId, serviceSlug, displayName, serverUrl, authType, status, toolCount, lastDiscoveredAt, createdBy: string | null, createdAt, updatedAt, oauthClientId, oauthScopes, oauthAuthorizationEndpoint, oauthTokenEndpoint, oauthTokenEndpointAuthMethod, apiKeyHeaderName, apiKeyPrefix, hasClientSecret, hasApiKey, hasAdditionalHeaders).
  - Add `CustomMcpConnectorAuthType` union: `'none' | 'oauth' | 'api_key' | 'bearer'`.
  - Add `CustomMcpConnectorTokenEndpointAuthMethod` union: `'none' | 'client_secret_basic' | 'client_secret_post'`.
  - Add `CreateCustomMcpConnectorRequest` and `UpdateCustomMcpConnectorRequest` types.
  - Request types include explicit non-secret `authType`, nullable endpoint override fields, `clearClientSecret?: boolean`, and `clearAdditionalHeaders?: boolean`.
  - Note: sensitive fields (secrets, encrypted values) are excluded from response types. The API returns `hasClientSecret`, `hasApiKey`, and `hasAdditionalHeaders` boolean flags instead.
- Modify `packages/sdk/src/integrations/index.ts`
  - Add optional `isCustomConnector?: boolean` metadata to `IntegrationProvider`.
  - Keep existing required provider fields/methods unchanged; synthetic custom providers must implement them.

### MCP Client Updates

- Modify `packages/sdk/src/mcp/client.ts`
  - Add `additionalHeaders?: Record<string, string>` for validated non-auth static headers and `staticAuthHeader?: { name: string; value: string }` for generated API-key/bearer auth headers to constructor options.
  - Add `fetch?: typeof fetch` to constructor options so the worker can inject `safeFetchOutbound()` for custom connector calls.
  - Merge headers in `buildFetchOpts()` so both `rpc()` and `notify()` include them. Merge order is validated non-auth `additionalHeaders`, client transport defaults, exactly one auth source, then negotiated MCP protocol/session headers.
  - Header names are case-insensitive. Reject invalid names, duplicate names after normalization, values containing CR/LF/NUL, protected header collisions, and auth ambiguity.
  - Arbitrary `additionalHeaders` must not set `authorization`, `content-type`, `accept`, `mcp-session-id`, `mcp-protocol-version`, hop-by-hop headers, fetch-controlled headers, or any `proxy-*` / `sec-*` header. API-key/bearer connectors can set `Authorization` only through `staticAuthHeader`.
  - Update the latest supported protocol version constant from `2025-03-26` to `2025-11-25`.
  - Add an explicit supported-version set (including `2025-03-26`, `2025-06-18`, and `2025-11-25`).
  - Store the protocol version returned by `initialize`.
  - Reject initialization if the server returns an unsupported protocol version.
  - Send `MCP-Protocol-Version` from `buildFetchOpts()` on post-initialization requests using the negotiated version, not blindly the latest constant. This includes `notifications/initialized`.
  - In `rpc()`, detect 404 + existing `Mcp-Session-Id` → clear session, re-initialize, retry once.
- Modify `packages/sdk/src/mcp/action-source.ts`
  - Add `additionalHeaders?: Record<string, string>`, `staticAuthHeader?: { name: string; value: string }`, and `fetch?: typeof fetch` to `McpActionSourceOptions`.
  - Pass through to `McpClient` constructor.
- Modify `packages/sdk/src/mcp/oauth.ts`
  - Add `exchangeCodeWithClientCredentials()` — code exchange using admin-provided `client_id` + optional `client_secret` + PKCE. Handles both confidential (with secret) and public (PKCE-only) clients, accepts `tokenEndpointAuthMethod`, and accepts optional `resource` so custom MCP OAuth matches the built-in MCP path. Send Basic auth for `client_secret_basic`, form-body `client_secret` for `client_secret_post`, and omit the secret for `none`.
  - Add `refreshTokenWithClientCredentials()` — token refresh with admin `client_id` + optional `client_secret`, `tokenEndpointAuthMethod`, and `resource`.
  - Existing functions unchanged (still used by dynamic-registration path).

### Outbound URL Policy + Safe Fetch

- Create `packages/worker/src/services/outbound-url-policy.ts`
  - Validate every admin-provided or discovery-derived URL before storing and before each outbound fetch: `server_url`, OAuth authorization endpoint, OAuth token endpoint, and redirect targets.
  - Require `https:` URLs, default port 443 only, no credentials/fragments, no empty or single-label hostnames, and no `localhost`, `*.localhost`, `.local`, `.internal`, or IP-literal hosts.
  - Do not query DNS directly from the Worker. Admin-configured connector endpoints are trusted org configuration; the URL policy is a guardrail against accidental local/private URL shapes, not a DNS-based SSRF firewall.
  - Re-validate every redirect target. Do not support private-network/VPC/Tunnel connector targets in this MVP.
- Create `packages/worker/src/services/safe-fetch-outbound.ts`
  - Export `safeFetchOutbound()` for connector outbound calls. It wraps `fetch()` with `redirect: 'manual'`, URL policy checks, a timeout that stays active until the returned response body finishes, and redirect-chain caps. Successful MCP responses are not size-capped.
  - OAuth token exchange and refresh reject redirects.
  - MCP JSON-RPC requests reject redirects, especially cross-origin redirects carrying Authorization/API-key/additional headers.
  - OAuth discovery may follow up to 3 redirects only if each target passes the outbound URL policy.
  - Never forward `Authorization`, API-key, bearer, `Cookie`, or configured additional headers to a different origin.

### Integration Registry

- Modify `packages/worker/src/integrations/registry.ts`
  - Add optional `customContext?: CustomMcpConnectorContext` parameter to `getActions(service, customContext?)` and `getProvider(service, customContext?)`. No shared mutable state — the context is request-scoped.
  - Define `ResolvedCustomMcpConnector` as a worker-local runtime type derived from the DB row plus parsed/decrypted `additionalHeaders?: Record<string, string>` and `staticAuthHeader?: { name: string; value: string }`.
  - `getActions()` fallback: if not in static packages, check `customContext.connectors` and build `McpActionSource`.
  - `getActions()` passes `connector.additionalHeaders` and `connector.staticAuthHeader` to `McpActionSource`; API-key connector auth headers are pre-composed by `services/custom-mcp-connectors.ts`.
  - For `McpActionSource`, set `noAuth: connector.authType !== 'oauth'`. In this context `noAuth` means no per-user credential is required; API-key/bearer auth is still sent through `staticAuthHeader`.
  - `getProvider()` fallback: build a full synthetic `IntegrationProvider` from connector record, with `service`, `displayName`, `supportedEntities: []`, `isCustomConnector: true`, `validateCredentials()`, and `testConnection()`. Map `auth_type` correctly: `'none'` → `'none'`, `'oauth'` → `'oauth2'`, `'api_key'` / `'bearer'` → `'api_key'`.
  - Add `isBuiltinService(slug): boolean` static helper for slug collision checks.

### Admin Routes

- Create `packages/worker/src/routes/admin-mcp-connectors.ts`
  - `GET /` — list connectors (strips secrets, adds boolean flags, joins `mcp_tool_cache` for tool count).
  - `POST /` — create connector. Auto-generate slug from name. Validate slug format + uniqueness + no collision with built-in. Validate explicit `authType` and store as `auth_type`. Encrypt secrets. Validate all configured URLs with the outbound URL policy. For OAuth connectors, require explicit stored authorization/token endpoints in this MVP. Do not use provider-specific runtime defaults or block connector creation on current `discoverAuthServer(server_url)`. Return created record.
  - `PUT /:id` — update connector. Reject slug changes (400). Require explicit `authType`. Re-encrypt secrets if a non-empty replacement is provided; preserve existing encrypted values if omitted and auth mode is unchanged. Empty string is normalized to omitted, not clear. `clearClientSecret: true` clears OAuth secret while staying in OAuth/public-PKCE mode. `clearAdditionalHeaders: true` or `{}` clears the encrypted headers. Clear obsolete auth-specific fields when auth mode changes. Preserve additional headers across auth mode changes unless explicitly replaced/cleared. Clear `last_error` on URL change.
  - On URL/auth/status/header changes, delete `mcp_tool_cache` rows for the service so policy/enablement UI cannot show stale or disabled tools.
  - `DELETE /:id` — call `deleteCustomMcpConnectorCascade()`. Cascade in one raw `D1Database.batch()`: delete from `mcp_tool_cache`, `integrations`, `credentials`, `disabled_actions`, `action_policies`, `user_action_policy_overrides`, then `custom_mcp_connectors`. Preserve historical `action_invocations`.
  - All routes protected by `adminMiddleware`.
- Modify `packages/worker/src/index.ts`
  - Mount admin connector routes at `/api/admin/mcp-connectors`.

### OAuth Flow for Custom Connectors

- Modify `packages/worker/src/routes/integrations.ts`
  - Resolve service slugs through `services/custom-mcp-connectors.ts` (static packages first, then active custom connectors from D1), not a route-local helper.
  - Extend `GET /` to filter out integrations whose custom connector has been deleted or disabled, alongside the existing disabled-plugin filtering.
  - Extend `GET /available` to merge active OAuth custom connectors with built-in integrations. Return `isCustomConnector: true`, `supportedEntities: []`, `hasActions: true`, and `hasTriggers: false`.
  - Extend `GET /actions` to merge active custom connector display names and exclude cached `mcp_tool_cache` entries for deleted/disabled custom connectors.
  - In the OAuth initiation handler: when the resolved provider is a custom connector, load connector from D1, use admin's `oauth_client_id` to build auth URL with PKCE (skip dynamic registration). OAuth endpoints come from the connector record (`oauth_authorization_endpoint`, `oauth_token_endpoint`) and are used exactly, even when the authorization server host differs from `connector.serverUrl`. Pass `resource: connector.serverUrl` to `buildAuthorizationUrl()` per MCP/RFC 8707. Continue returning the existing `{ url, state, code_verifier }` shape; the browser already stores `oauth_state`, `oauth_service`, and `oauth_code_verifier`.
  - In the OAuth callback handler: resolve the service slug against custom connectors when no static MCP client exists, then use `exchangeCodeWithClientCredentials()` with connector's `client_id` + optional decrypted `client_secret` + PKCE verifier + stored `oauth_token_endpoint_auth_method`. Token endpoint comes from the connector record. Pass `resource: connector.serverUrl` to match the authorization request.
- Modify `packages/worker/src/services/integrations.ts`
  - Update configure integration validation so `/api/integrations` accepts either a static package service or an active custom OAuth connector service.
  - For custom OAuth connectors, use the synthetic provider to validate the returned token shape, skip `testConnection()` because the MCP OAuth token is scoped to the MCP server, store credentials with `provider = serviceSlug`, and upsert the user `integrations` row.
  - If the user already has an integration for the service (popup reauth/reconnect), update credentials/config/status and return the existing integration instead of throwing `INTEGRATION_ALREADY_EXISTS`.
- Modify `packages/worker/src/routes/integrations.ts` configure schema
  - Remove the synchronous `integrationRegistry.getPackage(s) !== undefined` Zod refinement. Keep `service` as a string in the schema, then validate it in the handler/service with the async static-or-custom resolver because custom OAuth connectors are D1-backed and not registry packages.
- Modify `packages/worker/src/services/credentials.ts`
  - Extend MCP token refresh logic: when refreshing, if the service slug is not a built-in service, query `custom_mcp_connectors` by slug. If found, use the connector's `oauth_token_endpoint` + admin's `client_id` + optional decrypted `client_secret` + stored `oauth_token_endpoint_auth_method` via `refreshTokenWithClientCredentials()`. Pass `resource: connector.serverUrl`. Otherwise fall through to existing `mcp_oauth_clients` lookup.

### Session Tools Integration

- Modify `packages/worker/src/services/session-tools.ts`
  - Add `orgId?: string` to `ListToolsOpts`, `resolveActionPolicy` options, and `ExecuteActionOpts`, defaulting to `'default'`.
  - At the top of `listTools()`: call `loadCustomMcpConnectorContext()` and pass this context to all `registry.getActions()` and `registry.getProvider()` calls.
  - For API-key/bearer connectors, `services/custom-mcp-connectors.ts` decrypts `encrypted_api_key`; decrypts `encrypted_additional_headers`; validates non-auth additional headers; composes the configured header (`api_key_header_name` + optional `api_key_prefix`) into `staticAuthHeader`; and does not pass the decrypted key as `access_token`.
  - Include custom connector services in the service iteration:
    - No-auth connectors: always included (no credential needed).
    - OAuth connectors: included when user has a credential for the slug.
    - API key / bearer connectors: always included (org-level credential handled through request headers).
  - In `resolveActionPolicy()`: fetch the same connector context, pass it to registry lookups, and treat active no-auth/API-key connectors as active services even without an `integrations` row. OAuth connectors still require an active user integration row.
  - In `executeAction()`: fetch the same connector context for provider lookup, set empty credentials for no-auth/API-key connectors, and let the custom `McpActionSource` send API-key/bearer auth via `staticAuthHeader`.
  - MCP tool cache writes already handle arbitrary service slugs — no schema change needed.
- Modify `packages/worker/src/durable-objects/session-agent.ts`
  - Pass `await resolveOrgId() ?? 'default'` into `listTools()`, `resolveActionPolicy()`, and `executeAction()` service calls.
  - Update the post-approval execution path to re-resolve custom connector action sources before calling `executeActionAndSend()`. The current path calls `integrationRegistry.getActions(service)` directly after approval; it must use the same connector-aware resolver as `resolveActionPolicy()`/`executeAction()`.
  - Revalidate deleted/disabled custom connector state before executing an approved action; if the connector is no longer active, mark the invocation failed and return an error to the runner.

### Disabled Actions Integration

- No schema changes. The `disabled_actions` table already supports arbitrary service slugs.
- Do not overload `getDisabledPluginServices()` for connector status; it is plugin-specific. Custom connector `status = 'disabled'` is enforced by only loading active connectors into the request-scoped connector context.
- Verify service/action-level entries in `disabled_actions` apply to custom connector slugs through the existing `getDisabledActionsIndex()` and `isActionDisabled()` paths.

### Frontend — Admin Section

- Create `packages/client/src/components/settings/add-mcp-connector-dialog.tsx`
  - Dialog modeled after Claude.ai's "Add custom connector."
  - Fields: Name, Remote MCP server URL.
  - Collapsible "Advanced settings":
    - Auth type selector (None / OAuth / API Key / Bearer, default None).
    - If OAuth: Client ID, Client Secret (optional), Token endpoint auth method (Auto / Client secret basic / Client secret post), Scopes (optional), Authorization Endpoint, and Token Endpoint.
    - If API Key: API Key, Header Name, Prefix.
    - If Bearer: Bearer Token. Backend stores it as `auth_type = 'bearer'`, `api_key_header_name = 'Authorization'`, `api_key_prefix = 'Bearer'`.
    - Optional additional request headers as static header key/value pairs; values are encrypted and never echoed back.
  - Read-only helper text showing the OAuth redirect URI.
  - On edit, password fields are blank and use `(unchanged)` placeholders when the corresponding `has*` flag is true. Typing a new value replaces the secret.
  - OAuth client secret has a "Remove secret" control when `hasClientSecret` is true. API-key/bearer secrets cannot be cleared while staying in that auth mode; switch auth type or delete the connector.
  - Additional headers are not pre-populated because values are secret. Show "configured" from `hasAdditionalHeaders`; offer Replace and Clear controls. Replacement submits the complete new header object.
  - Cancel / Add buttons.
- Create `packages/client/src/components/settings/custom-mcp-connectors-section.tsx`
  - Table of connectors: Name, URL, Auth Type, Status, Tool Count, Edit/Delete actions.
  - "Add Connector" button opens the dialog.
  - Tool count populated lazily from `mcp_tool_cache`.
  - Edit opens dialog pre-populated (slug read-only). Delete with AlertDialog confirmation.
- Create `packages/client/src/api/custom-mcp-connectors.ts`
  - Query key factory: `mcpConnectorKeys.all`, `mcpConnectorKeys.list()`, `mcpConnectorKeys.detail(id)`.
  - `useCustomMcpConnectors()` — list query.
  - `useCreateCustomMcpConnector()` — create mutation.
  - `useUpdateCustomMcpConnector()` — update mutation.
  - `useDeleteCustomMcpConnector()` — delete mutation.
- Modify `packages/client/src/routes/settings/admin.tsx`
  - Import and render `CustomMcpConnectorsSection` in the admin page.

### Frontend — User Integration Flow

- Modify `packages/client/src/components/integrations/connect-integration-dialog.tsx`
  - Use the extended `/integrations/available` response that includes OAuth custom connectors.
  - Update `AvailableService` typing to include `isCustomConnector?: boolean`.
  - Thread `isCustomConnector` through `ResolvedService` / `resolveService()`, then render OAuth-requiring custom connectors with a "Custom" badge and generic MCP icon.
  - Connection flow is identical to existing MCP OAuth — the backend handles the branching.
- No flow changes to `packages/client/src/routes/integrations/callback.tsx` — it already stores the service slug and calls the generic configure endpoint after token exchange. Backend configure validation must be updated as described above.

---

## Implementation Steps

### Step 1: Migration + Schema + DB Helpers

- [x] Write `0015_custom_mcp_connectors.sql` migration
  - [x] Include `oauth_token_endpoint_auth_method`
  - [x] Include cleanup/performance indexes for connector status, service cleanup, and action invocation FK columns
- [x] Write Drizzle schema in `custom-mcp-connectors.ts`, export from `schema/index.ts`
- [x] Write DB helpers in `db/custom-mcp-connectors.ts`, export from `lib/db.ts`
- [x] Add shared connector types and widen dynamic integration service fields in `packages/shared/src/types/index.ts`
- [x] Add optional `isCustomConnector?: boolean` to SDK `IntegrationProvider`
- [x] Run `pnpm typecheck`

### Step 2: MCP Client + OAuth Updates

- [x] Add `additionalHeaders`, `staticAuthHeader`, and injectable `fetch` support to `McpClient` constructor and `buildFetchOpts()`
- [x] Implement header validation/merge rules: no protected-header overrides, no duplicate normalized names, no invalid values, exactly one auth source
- [x] Update latest supported protocol version constant to `2025-11-25`
- [x] Add supported-version validation for initialize responses, including `2025-03-26`, `2025-06-18`, and `2025-11-25`
- [x] Store negotiated protocol version from `initialize`
- [x] Add `MCP-Protocol-Version` header from `buildFetchOpts()` on post-initialization requests using the negotiated version
- [x] Add 404 session reset + retry logic in `rpc()`
- [x] Add `additionalHeaders`, `staticAuthHeader`, and `fetch` passthrough to `McpActionSource`
- [x] Add `exchangeCodeWithClientCredentials()` and `refreshTokenWithClientCredentials()` to `oauth.ts` with `tokenEndpointAuthMethod` support
- [x] Run `pnpm typecheck`

### Step 3: Worker Service Boundary + Safe Fetch

- [x] Add `services/custom-mcp-connectors.ts` with shared connector CRUD, slug resolution, OAuth config loading, request-scoped context loading, and D1 batch cascade cleanup
- [x] Add outbound URL policy helpers for public HTTPS-only connector URLs, OAuth endpoints, and redirect targets
- [x] Add URL-shape validation for bad schemes, credentials, fragments, single-label hosts, localhost/internal suffixes, custom ports, and IP-literal hosts
- [x] Add `safeFetchOutbound()` with manual redirect handling, timeout-through-body handling, no successful-response size cap, and redirect target revalidation
- [x] Thread safe fetch into custom connector MCP OAuth helpers and `McpClient`/`McpActionSource` via injected fetch
- [x] Add tests for bad schemes, credentials in URL, fragments, single-label hosts, non-443 ports, localhost, IP literals, injected resolver results, redirects, large MCP responses, and timeout-through-body behavior
- [x] Run `pnpm typecheck`

### Step 4: Integration Registry Extension

- [x] Add optional `customContext` parameter to `getActions(service, customContext?)` and `getProvider(service, customContext?)`
- [x] Implement `getActions()` fallback: check custom connector context, build `McpActionSource`, pass connector `additionalHeaders`/`staticAuthHeader`, and set `noAuth` for non-OAuth connectors
- [x] Implement `getProvider()` fallback: build full synthetic `IntegrationProvider` with required fields/methods and correct `authType` mapping (`none`/`oauth2`/`api_key`)
- [x] Add `isBuiltinService(slug)` static helper
- [x] Run `pnpm typecheck`

### Step 5: Admin CRUD Routes

- [x] Create `routes/admin-mcp-connectors.ts` with GET/POST/PUT/DELETE
- [x] Implement slug auto-generation from display name + validation (format, global uniqueness, no built-in collision)
- [x] Validate explicit `authType` and store as `auth_type`
- [x] Implement secret/header encryption on create/update, preserve-if-omitted only when auth mode is unchanged
- [x] Implement edit semantics: empty secret means omitted, `clearClientSecret` removes OAuth secret, `clearAdditionalHeaders` or `{}` clears headers, API-key/bearer cannot remain active without an existing or replacement key
- [x] Clear obsolete encrypted secret fields when auth mode changes
- [x] Implement slug immutability check on PUT (reject changes)
- [x] Implement explicit OAuth endpoint/scopes fields without provider-specific runtime presets
- [x] Store and validate OAuth token endpoint auth method (`none`, `client_secret_basic`, `client_secret_post`) with auto defaulting
- [x] Clear `mcp_tool_cache` on connector URL/auth/status/header changes
- [x] Implement update cache invalidation and delete cascade with raw `D1Database.batch()`
- [x] Add tests that a failed batch leaves all rows intact
- [x] Mount at `/api/admin/mcp-connectors` in `index.ts`
- [x] Run `pnpm typecheck`

### Step 6: OAuth + Credentials for Custom Connectors

- [x] Use the shared static-or-custom connector resolver from `services/custom-mcp-connectors.ts` for integration routes
- [x] Extend `GET /integrations/available` to include active OAuth custom connectors
- [x] Extend `GET /integrations/actions` to filter deleted/disabled custom connector cached tools and use custom display names
- [x] Extend OAuth initiation in `routes/integrations.ts`: resolve custom connector by slug, load connector, build auth URL from connector record (not `mcp_oauth_clients`), pass `resource: connector.serverUrl`, return existing `{ url, state, code_verifier }` shape
- [x] Use stored OAuth endpoints exactly; do not derive them from the MCP `serverUrl`
- [x] Extend OAuth callback: resolve custom connector by slug, use `exchangeCodeWithClientCredentials()` with connector's credentials, stored token endpoint auth method, and `resource: connector.serverUrl`
- [x] Extend `/api/integrations` configure schema/service to accept active custom OAuth connector slugs and upsert integration rows for first connect and reconnect
- [x] Extend credential refresh in `credentials.ts`: query `custom_mcp_connectors` for non-built-in slugs, use `refreshTokenWithClientCredentials()` with connector's token endpoint + credentials + token endpoint auth method + `resource`
- [x] Run `pnpm typecheck`

### Step 7: Session Tools Integration

- [x] Add `orgId?: string` through `ListToolsOpts`, `resolveActionPolicy` opts, and `ExecuteActionOpts`
- [x] Fetch custom connector context from `loadCustomMcpConnectorContext()` at top of `listTools()`
- [x] Compose API-key/bearer connector `staticAuthHeader` and non-auth `additionalHeaders` in `services/custom-mcp-connectors.ts`
- [x] Thread connector context through all `registry.getActions()` and `registry.getProvider()` calls
- [x] Include custom connector services in service iteration (no-auth/api_key auto-included, oauth when user has credential)
- [x] Thread connector context through `resolveActionPolicy()` registry lookups and active-service checks
- [x] Handle API key connector execution with `staticAuthHeader`, not `access_token`
- [x] Same connector fetch + context in `executeAction()` path
- [x] Add connector-aware action-source resolution and deleted/disabled revalidation to `SessionAgentDO` post-approval execution
- [x] Pass `await resolveOrgId() ?? 'default'` into session-tools service calls from `SessionAgentDO`
- [x] Verify disabled actions work with custom connector slugs
- [x] Run `pnpm typecheck`

### Step 8: Frontend — API Layer + Admin Section

- [x] Create `api/custom-mcp-connectors.ts` with query keys, hooks, mutations
- [x] Create `components/settings/add-mcp-connector-dialog.tsx`
  - Dialog with Name, URL fields
  - Collapsible "Advanced settings" with auth type selector (None/OAuth/API Key/Bearer)
  - Conditional fields per auth type, including OAuth endpoint/scopes fields, token endpoint auth method, and encrypted additional headers
  - Edit mode with blank secret inputs, `(unchanged)` placeholders, explicit remove OAuth secret, and replace/clear all additional headers
  - Read-only redirect URI helper text for OAuth
- [x] Create `components/settings/custom-mcp-connectors-section.tsx`
  - Table of connectors with auth type, status, tool count
  - "Add Connector" button opens dialog
  - Edit (slug read-only) / Delete per row
- [x] Add section to admin settings page
- [x] Run `cd packages/client && pnpm build` to verify

### Step 9: Frontend — User Integration Flow

- [x] Update available-integration client type to include `isCustomConnector?: boolean`
- [x] Thread `isCustomConnector` through `ResolvedService` and extend integration dialog to render custom OAuth connectors with "Custom" badge + generic MCP icon
- [ ] Verify OAuth connect/disconnect flow works end-to-end
- [x] Run `cd packages/client && pnpm build` to verify

Note: OAuth initiation, callback exchange, configure/upsert, and refresh behavior are covered by in-process route/service tests. Browser-level OAuth connect/disconnect remains a live-environment E2E check because it requires a real remote MCP OAuth provider and redirect flow.

## Test Strategy

Use in-process tests rather than a local TCP server. SDK MCP protocol tests should use a fetch-compatible fake MCP/OAuth handler. Worker route tests should use Hono route apps plus fetch stubs, following existing route-test patterns.

- SDK `packages/sdk/src/mcp/client.test.ts`: verify API-key/static headers on `initialize`, `notifications/initialized`, `tools/list`, and `tools/call`; negotiated `MCP-Protocol-Version`; unsupported protocol failure; and 404 stale-session reset/retry.
- SDK `packages/sdk/src/mcp/oauth.test.ts`: verify PKCE auth URLs include `S256` and `resource`, code verifier is not leaked in auth URL, token exchange includes verifier/client ID/optional secret/resource, and `client_secret_basic`/`client_secret_post`/`none` behavior.
- Worker `routes/integrations.test.ts`: verify custom OAuth initiation/callback skip dynamic registration, use connector endpoints/client ID, return `{ url, state, code_verifier }`, and send `resource = connector.serverUrl`.
- Worker `services/session-tools.test.ts`: cover no-auth/API-key/OAuth service inclusion, credentials/no credentials behavior, header composition, cache writes, and disabled-action filtering.
- Worker `session-agent.test.ts`: prove approved custom actions execute through connector-aware resolution, and deleted/disabled connectors fail before post-approval execution.
- Admin route/service tests: cover URL policy rejection, header policy rejection, explicit authType validation, edit preserve/replace/clear semantics, D1 batch rollback behavior, cache invalidation, and delete cleanup.

### Step 10: End-to-End Verification

- [ ] Test no-auth connector: admin creates, tools appear in agent, tools execute
- [ ] Test OAuth connector: admin creates with client credentials, user connects via OAuth, tools appear, tools execute, token refresh works
- [ ] Test OAuth connector sends MCP `resource` during authorization and code exchange
- [ ] Test provider-specific OAuth endpoint/scopes entry using Salesforce production/sandbox values as manual examples, including PKCE/no-secret flow
- [ ] Test OAuth client secret modes: public PKCE (`none`), `client_secret_basic`, and `client_secret_post`; verify refresh parity
- [ ] Test OAuth reconnect/reauth updates the existing integration instead of failing as duplicate
- [ ] Test API key connector: admin creates with key, tools appear for all users, tools execute
- [ ] Test action policy: custom connector tools appear in policy UI, can be disabled/policy-controlled
- [ ] Test approval flow: a custom connector tool requiring approval executes successfully after approval
- [ ] Test connector disable/update clears stale cached tools from action policy/enablement UI
- [ ] Test delete: deleting connector removes tools, integration rows, credentials, cache entries, disabled actions, org policies, and user policy overrides
- [ ] Test slug collision: verify built-in slug is rejected on create
- [ ] Test slug immutability: verify PUT rejects slug changes
- [ ] Verify existing plugin-backed MCP integrations are unaffected
- [x] Run full `pnpm typecheck` from root

Automated verification completed locally:

- [x] `cd packages/sdk && pnpm exec vitest run src/mcp/client.test.ts src/mcp/oauth.test.ts` — 10 tests passed
- [x] `cd packages/worker && pnpm exec vitest run src/routes/admin-mcp-connectors.test.ts src/routes/integrations.test.ts src/services/custom-mcp-connectors.test.ts src/services/session-tools.test.ts src/services/credentials.test.ts src/services/integrations.test.ts src/integrations/registry.test.ts src/services/outbound-url-policy.test.ts src/services/safe-fetch-outbound.test.ts src/lib/db/custom-mcp-connectors.test.ts` — 54 tests passed
- [x] `cd packages/client && pnpm build` — passed with existing Vite chunk/dynamic import warnings
- [x] `pnpm typecheck` — passed

The remaining unchecked items above are live E2E checks against actual connector/provider infrastructure, not local implementation blockers.
