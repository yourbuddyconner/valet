# Custom Remote MCP Connectors

**Status:** Draft
**Author:** Conner Swann
**Date:** 2026-05-22
**Linear:** TKAI-109

## Problem

Valet supports MCP-backed tools only through compile-time plugin packages. Each integration requires a `packages/plugin-*` directory, a build-time registry generation step, and a worker redeploy. Admins cannot add a custom remote MCP server by URL from the admin UI.

The immediate driver is Salesforce's hosted MCP servers (`https://api.salesforce.com/platform/mcp/v1/<server-name>`). Salesforce uses standard OAuth 2.0 with an admin-created External Client App — the admin's consumer key (OAuth Client ID) drives the OAuth flow, and the resulting per-user access token is sent as a standard bearer token on MCP requests. This cannot be wired up through the existing dynamic-registration-only MCP OAuth path because Salesforce does not support RFC 7591 dynamic client registration.

More broadly, any MCP server that uses admin-managed OAuth credentials (as opposed to RFC 7591 dynamic registration) is blocked today. This feature adds a runtime connector path alongside the existing plugin-backed path.

## Goals

- Admin can add a custom remote MCP connector by URL, with no code changes or redeploy.
- Support three auth modes: no-auth, OAuth (admin-provided client credentials), and API key/bearer.
- OAuth connectors support admin-provided `client_id`/`client_secret` for the OAuth flow (authorization, token exchange, refresh). The resulting access token is sent as a standard bearer token on MCP requests.
- Users authenticate per-connector through the existing integration connection flow.
- Custom connector tools appear in agent tool discovery and execute through the same action policy, approval, audit, and disabled-action paths as built-in tools.
- Custom connectors appear in action policy and enablement UI.
- Existing plugin-backed MCP integrations are unaffected.

## Non-Goals

- stdio/local MCP servers. Remote Streamable HTTP only.
- MCP prompts or resources. Tools only.
- Old HTTP+SSE transport fallback.
- Per-user connector creation (admin-only).
- Connector marketplace or sharing across orgs.
- Automatic migration of existing plugin-backed MCP integrations to the connector model.

## Current State

### MCP Client Layer (`packages/sdk/src/mcp/`)

`McpClient` implements JSON-RPC 2.0 over Streamable HTTP. It handles session management (`Mcp-Session-Id`), SSE response parsing, and initialization handshake. Auth is bearer token via `Authorization` header, with an `authQueryParam` option for servers that need the token as a query parameter.

Protocol version is hardcoded to `2025-03-26`. The client does not send `MCP-Protocol-Version` on subsequent requests and does not handle 404 session resets.

`McpActionSource` adapts MCP tools to Valet's `ActionSource` interface. It extracts `access_token` from credentials and passes it to `McpClient`. It does not support passing additional auth context (like `client_id`) alongside the token.

`oauth.ts` implements RFC 8414 auth server discovery, RFC 7591 dynamic client registration (public client, no secret), and PKCE (RFC 7636). It does not support admin-provided `client_id`/`client_secret` — it always dynamically registers.

### Integration Registry (`packages/worker/src/integrations/`)

`IntegrationRegistry` is a static `Map<string, IntegrationPackage>` populated at compile time from auto-generated `packages.ts`. There is no runtime registration path. `getActions(service)` and `getProvider(service)` only resolve against this static map.

### Tool Discovery & Execution (`packages/worker/src/services/session-tools.ts`)

`listTools()` iterates all active services, detects MCP-backed sources via `provider.mcpServerUrl`, resolves credentials, calls `actionSource.listActions()`, filters by disabled actions, and returns tool descriptors. MCP tool metadata is cached in `mcp_tool_cache` for the action catalog UI.

`executeAction()` resolves credentials, calls `actionSource.execute()`, handles 401 auto-refresh, and records invocation audit rows. Action policy resolution is connector-agnostic — it operates on `service` + `actionId` strings.

### Existing MCP Tables

- `mcp_oauth_clients`: Stores dynamically registered OAuth client metadata per service (endpoints, client ID, scopes).
- `mcp_tool_cache`: Caches discovered MCP tools per service for offline catalog display.

### Credentials

Encrypted with PBKDF2 using `ENCRYPTION_KEY`. Stored in `credentials` table with `ownerType` (user/org), `ownerId`, `provider` (service slug), and `encryptedData`. Auto-refresh on expiry via service-specific refresh handlers.

## Design

### Data Model

New table `custom_mcp_connectors`:

```sql
CREATE TABLE custom_mcp_connectors (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL DEFAULT 'default',
  service_slug TEXT NOT NULL,
  display_name TEXT NOT NULL,
  server_url TEXT NOT NULL,
  auth_type TEXT NOT NULL DEFAULT 'none'
    CHECK(auth_type IN ('none', 'oauth', 'api_key', 'bearer')),
  credential_scope TEXT NOT NULL DEFAULT 'org'
    CHECK(credential_scope IN ('org', 'user')),

  -- OAuth fields (used when auth_type = 'oauth')
  oauth_client_id TEXT,
  encrypted_oauth_client_secret TEXT,
  oauth_token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none'
    CHECK(oauth_token_endpoint_auth_method IN ('none', 'client_secret_basic', 'client_secret_post')),
  oauth_scopes TEXT,                    -- space-separated scope list
  oauth_authorization_endpoint TEXT,    -- override if discovery fails
  oauth_token_endpoint TEXT,            -- override if discovery fails

  -- API key / Bearer fields (used when auth_type IN ('api_key', 'bearer'))
  encrypted_api_key TEXT,
  api_key_placement TEXT NOT NULL DEFAULT 'header'
    CHECK(api_key_placement IN ('header', 'query')),
  api_key_header_name TEXT DEFAULT 'Authorization',
  api_key_prefix TEXT DEFAULT 'Bearer', -- e.g. 'Bearer', 'Api-Key', ''
  api_key_query_param TEXT,

  -- Additional request headers (encrypted JSON object: {"Header-Name": "value"})
  -- Sent on every MCP request. Escape hatch for servers that require
  -- custom headers beyond the standard Authorization bearer token.
  encrypted_additional_headers TEXT,

  -- Metadata
  status TEXT NOT NULL DEFAULT 'active'
    CHECK(status IN ('active', 'disabled', 'error')),
  last_discovered_at TEXT,
  last_error TEXT,
  created_by TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(service_slug)
);
```

Migration also adds indexes for runtime/admin listing and cleanup: `idx_custom_mcp_connectors_org_status(org_id, status)`, `idx_disabled_actions_service_cleanup(service)`, `idx_action_policies_service_cleanup(service)`, `idx_uapo_service_cleanup(service)`, `idx_ai_policy_id(policy_id)`, `idx_ai_org_policy_id(org_policy_id)`, and `idx_ai_user_override_id(user_override_id)`.

**Org scoping:** MVP callers pass explicit `orgId` where available and default to `'default'` where auth/session service signatures do not yet carry it. The table keeps `org_id` for future multi-org plumbing, but custom connector slugs are globally unique today because downstream service-keyed tables (`credentials.provider`, `integrations.service`, `mcp_tool_cache.service`, `disabled_actions.service`, `action_policies.service`, and `user_action_policy_overrides.service`) are not org-scoped. Future true multi-org slug reuse would require adding `org_id` to those downstream tables first.

**Slug collision prevention:** On create, validate that `service_slug` does not match any key in the static `installedIntegrations` registry.

**Slug immutability:** `service_slug` is immutable after creation. It is used as a foreign key across `credentials.provider`, `integrations.service`, `mcp_tool_cache.service`, `disabled_actions`, `action_policies`, and `user_action_policy_overrides`. Allowing slug changes would require cascading renames across all of these — not worth the complexity. Admins can delete and recreate a connector if the slug needs to change.

**Encrypted fields:** `encrypted_oauth_client_secret`, `encrypted_api_key`, and `encrypted_additional_headers` use the same PBKDF2 encryption as the `credentials` table. They are never returned in API responses — only `hasClientSecret: boolean`, `hasApiKey: boolean`, and `hasAdditionalHeaders: boolean` flags are exposed. API responses still return non-secret editable config (`authType`, `oauthClientId`, scopes, endpoint overrides, token endpoint auth method, API key header name/prefix, status, and URL).

**Auth mode in API payloads:** The frontend sends explicit non-secret `authType: 'none' | 'oauth' | 'api_key' | 'bearer'` on create and update. The backend validates it against the submitted fields and stores it as `auth_type`. Do not infer update mode from secret presence, because omitted secret fields mean "preserve existing secret" for unchanged modes.

Secret fields use existing admin settings semantics:
- omitted secret field = preserve existing encrypted value, but only when `authType` stays in the same compatible mode
- non-empty string = replace encrypted value
- empty string = normalized to omitted; it is not a clear sentinel
- explicit clear flags perform clears where clearing is valid

**Credential scope:** `credential_scope` only affects `api_key` and `bearer` connectors. `org` scope stores the API key/bearer token on the connector record and makes tools available without a per-user connection. `user` scope stores no connector-level API key; each user connects the custom connector from the integrations page and the token is stored in the user's `credentials` row with `credentialType = 'api_key'`. OAuth connectors are always user-scoped, and no-auth connectors are effectively org-scoped.

### Outbound URL Policy

Custom MCP connectors may only target public HTTPS endpoints. Apply this policy to every admin-provided or discovery-derived URL before storing and before each outbound fetch: `server_url`, `oauth_authorization_endpoint`, `oauth_token_endpoint`, and every redirect target.

Validation rules:
- Protocol must be `https:`.
- Reject username/password, fragments, empty hostnames, single-label hosts, `localhost`, `*.localhost`, `.local`, `.internal`, and IP-literal hosts unless a later explicit allowlist design permits them.
- MVP allows only default HTTPS port 443. Reject explicit non-443 ports.
- Do not query DNS directly from the Worker. Admin-configured connector endpoints are trusted org configuration; the URL policy is a guardrail against accidental local/private URL shapes, not a DNS-based SSRF firewall.
- Re-validate every redirect target with the same URL policy. Do not rely only on create/update-time validation.
- Do not support private-network/VPC/Tunnel connector targets in this MVP.

### Safe Fetch

All connector outbound calls must use a central Worker-side `safeFetchOutbound()` helper, not raw `fetch()`. The helper uses `redirect: 'manual'`, applies the outbound URL policy before each request, enforces an AbortController timeout through response body consumption, and caps redirect chains. It must not cap successful MCP response sizes.

Redirect policy:
- OAuth token exchange and refresh: reject all redirects.
- MCP JSON-RPC requests carrying Authorization/API-key/additional headers: reject redirects; surface a connector error so admins update the URL.
- OAuth discovery GET: may follow up to 3 redirects only if each target passes the outbound URL policy.
- Never forward `Authorization`, API-key, bearer, `Cookie`, or configured additional headers to a different origin.

### Dynamic Connector Resolution

`IntegrationRegistry` is a module-level singleton in the CF Worker isolate — it may be shared across concurrent requests for different orgs. Custom connectors are org-scoped, so mutating the singleton with `loadCustomConnectors()` would create cross-request data races.

Instead, `getActions()` and `getProvider()` accept an optional request-scoped `CustomMcpConnectorContext`. The SDK `IntegrationProvider` type gains an optional metadata field `isCustomConnector?: boolean`; synthetic providers still must satisfy the existing contract (`service`, `supportedEntities`, `validateCredentials()`, and `testConnection()`). `ResolvedCustomMcpConnector` is a worker-local runtime type that starts from the connector DB row and adds `additionalHeaders?: Record<string, string>` for validated non-auth static headers plus `staticAuthHeader?: { name: string; value: string }` for generated API-key/bearer auth.

```typescript
// New overloads on IntegrationRegistry
getActions(
  service: string,
  customContext?: CustomMcpConnectorContext,
): ActionSource | undefined {
  const pkg = this.packages.get(service);
  if (pkg) return pkg.actions;

  const connector = customContext?.connectors.get(service);
  if (!connector || connector.status !== 'active') return undefined;

  return new McpActionSource({
    mcpUrl: connector.serverUrl,
    serviceName: connector.serviceSlug,
    // noAuth means "do not require a per-user token"; API-key auth is supplied
    // through staticAuthHeader.
    noAuth: connector.authType !== 'oauth',
    additionalHeaders: connector.additionalHeaders,
    staticAuthHeader: connector.staticAuthHeader,
    fetch: connector.fetch,
  });
}

getProvider(
  service: string,
  customContext?: CustomMcpConnectorContext,
): IntegrationProvider | undefined {
  const pkg = this.packages.get(service);
  if (pkg) return pkg.provider;

  const connector = customContext?.connectors.get(service);
  if (!connector) return undefined;

  return {
    service: connector.serviceSlug,
    displayName: connector.displayName,
    authType: connector.authType === 'none' ? 'none'
            : connector.authType === 'oauth' ? 'oauth2'
            : 'api_key',
    supportedEntities: [],
    mcpServerUrl: connector.serverUrl,
    oauthScopes: connector.oauthScopes?.split(' '),
    isCustomConnector: true,
    validateCredentials: (credentials) => connector.authType !== 'oauth' || !!credentials.access_token,
    testConnection: async () => true,
  };
}

// Static helper for slug validation
isBuiltinService(slug: string): boolean {
  return this.packages.has(slug);
}
```

**Loading:** Runtime paths fetch custom connectors from D1 once per request through `packages/worker/src/services/custom-mcp-connectors.ts` and build a `CustomMcpConnectorContext` that is threaded through all registry calls for the duration of that request. This applies to `listTools()`, `resolveActionPolicy()`, `executeAction()`, `SessionAgentDO`'s post-approval execution continuation, OAuth initiation/callback routes, `GET /api/integrations/available`, `GET /api/integrations/actions`, and the integration configure service. The service owns decryption, header composition, safe fetch injection, and built-in-first slug resolution so routes and session tools do not duplicate that logic. The query is cheap (one small table, ~10 rows) and eliminates any caching/staleness concerns. No shared state is mutated.

**Service enumeration:** `listTools()` currently iterates services from user integrations + auto-enabled services. Custom connectors with `authType: 'none'` or `api_key` are auto-included (no per-user credential needed). Custom connectors with `authType: 'oauth'` are included when the user has a credential for that service slug.

**Execution validation:** `resolveActionPolicy()` must treat active no-auth/API-key connectors as active services even without an `integrations` row. OAuth connectors still require an active user integration row. The action source returned from policy resolution and the provider lookup used by `executeAction()` must both use the same request-scoped connector context, otherwise custom tools can be listed but fail before execution.

**`McpActionSource` lifecycle:** A new `McpActionSource` (and underlying `McpClient`) is constructed on each `getActions()` call. This means MCP session IDs are not reused across requests, and the initialization handshake runs each time. This is acceptable for the initial implementation — built-in MCP integrations already create action sources per-package, so the overhead is comparable. Session caching across requests can be added later if latency becomes a concern.

### Auth Modes

#### No-Auth

`McpActionSource` is constructed with `noAuth: true`. No credential resolution. Tools are available to all users immediately after admin creates the connector.

#### OAuth (Admin-Provided Credentials)

This is the Salesforce path. The admin provides the `client_id` (consumer key) from a pre-registered OAuth application (e.g., a Salesforce External Client App). `client_secret` is optional — Salesforce External Client Apps can use PKCE-only (public client) or confidential client flows depending on configuration.

**Salesforce example:** The admin creates an External Client App in their Salesforce org, copies the consumer key, and pastes it as the OAuth Client ID when creating the connector.

Production standard/custom server examples:
- `https://api.salesforce.com/platform/mcp/v1/platform/sobject-all`
- `https://api.salesforce.com/platform/mcp/v1/custom/myserver`

Sandbox/scratch examples:
- `https://api.salesforce.com/platform/mcp/v1/sandbox/platform/sobject-all`
- `https://api.salesforce.com/platform/mcp/v1/sandbox/custom/myserver`

Salesforce Hosted MCP MVP uses admin-provided OAuth endpoints rather than relying on discovery. Salesforce's documented hosted MCP setup uses:
- Production: `https://login.salesforce.com/services/oauth2/authorize` and `https://login.salesforce.com/services/oauth2/token`
- Sandbox/scratch: `https://test.salesforce.com/services/oauth2/authorize` and `https://test.salesforce.com/services/oauth2/token`

Do not derive these endpoints from the MCP `server_url` host (`api.salesforce.com`). For Salesforce, the authorization server host is different from the MCP resource server host.

Salesforce External Client App settings for MVP:
- Enable OAuth.
- Callback URL: Valet integration callback URL.
- OAuth scopes: `mcp_api refresh_token`.
- Security: enable JWT-based access tokens and require PKCE.
- Default PKCE/no-secret mode: leave `Require Secret for Web Server Flow` and `Require Secret for Refresh Token Flow` disabled.
- Optional confidential mode: admins may enable `Require Secret for Web Server Flow`, generate a client secret, and enter it in Valet. Valet should include the secret on code exchange when configured.

**Discovery:** MVP supports explicit `oauth_authorization_endpoint` and `oauth_token_endpoint` fields. The generic connector flow does not derive provider-specific defaults; admins enter provider-specific endpoints manually when the authorization server differs from the MCP resource server. Do not assume `discoverAuthServer(server_url)` works for Salesforce. Future discovery should follow current MCP auth: RFC 9728 protected resource metadata first, then RFC 8414 authorization server metadata. The existing helper that fetches `${server_url}/.well-known/oauth-authorization-server` is not sufficient for pathful MCP resource URLs and should not be the Salesforce dependency.

Discovery results are stored on the connector record itself — custom connectors do NOT write to the `mcp_oauth_clients` table (that table is reserved for dynamically registered clients from the plugin path).

**Token endpoint auth method:** `oauth_token_endpoint_auth_method` controls how the optional client secret is sent to the token endpoint. Defaulting rules:
- no `client_secret` configured → `none`
- `client_secret` configured and discovery metadata says only `client_secret_post` → `client_secret_post`
- `client_secret` configured and discovery is absent, ambiguous, or includes Basic → `client_secret_basic`
- admins can override to `client_secret_basic` or `client_secret_post` in advanced settings

Code exchange and refresh must use the stored method: send HTTP Basic client authentication for `client_secret_basic`, send form-body `client_secret` for `client_secret_post`, and omit the secret for `none`.

**Redirect URI:** The OAuth redirect URI is `https://<app-host>/integrations/callback` — the same callback used by built-in integrations. The admin form displays this URI in a read-only helper text so admins know what to register with their OAuth provider (e.g., as the callback URL in a Salesforce External Client App).

**User connection flow:**

1. User navigates to Integrations page, sees the custom connector listed.
2. User clicks "Connect." Frontend calls `GET /api/integrations/{serviceSlug}/oauth`.
3. The integrations route resolves the service against static packages first, then the active custom connector table. For a custom connector, it builds the authorization URL using the admin's `oauth_client_id` + PKCE challenge. The OAuth endpoints come from the connector record, not from `mcp_oauth_clients`. It passes `resource = connector.serverUrl`, matching the existing MCP OAuth path so resource-scoped MCP tokens have the correct audience.
4. User is redirected to the provider's authorization server (e.g., their Salesforce org login). If already authenticated, the challenge may be skipped.
5. Callback hits `/integrations/callback`. Code exchange uses the admin's `client_id` + PKCE verifier. If a `client_secret` is configured, it is included according to the stored token endpoint auth method; otherwise the exchange is public-client PKCE only. It also passes `resource = connector.serverUrl`, matching the authorization request.
6. The callback returns credentials to the existing frontend callback page, which then calls the generic configure endpoint. That endpoint must accept active custom OAuth connector slugs in addition to static packages, validate the returned token shape with the synthetic provider, store `access_token` + `refresh_token` in `credentials` with `provider = serviceSlug`, and upsert the user's `integrations` row. If the user already has an integration for the slug (popup reauth/reconnect), update credentials/config/status instead of throwing `INTEGRATION_ALREADY_EXISTS`. The access token is sent as a standard `Authorization: Bearer` header on subsequent MCP requests.

**OAuth state format:** Keep the existing browser state shape: random `oauth_state`, `oauth_service`, and optional `oauth_code_verifier` in sessionStorage/localStorage. Do not rely on a browser-provided `customConnector` flag for server-side branching. The backend callback endpoint resolves custom connector behavior from the path service slug and D1 connector lookup.

**Token refresh:** The generic MCP PKCE refresh path in `credentials.ts` already receives the `Env` binding and service slug. When a refresh is needed, it checks whether the slug matches a custom connector by querying `custom_mcp_connectors`. If a connector is found, it uses the connector's `oauth_token_endpoint`, admin's `client_id`, optional decrypted `client_secret`, stored `oauth_token_endpoint_auth_method`, and `resource = connector.serverUrl` in the refresh request. If the slug is not a custom connector, it falls through to the existing `mcp_oauth_clients` lookup and public-client PKCE refresh.

#### API Key / Bearer Token

Admin chooses either an org-scoped or user-scoped credential.

- Org-scoped API key/bearer connectors store the static secret encrypted in `encrypted_api_key`. No per-user connection step is needed, and connector tools are available to all users immediately.
- User-scoped API key/bearer connectors do not store a connector-level secret. They appear in the user integrations page; each user enters their own key/token, which is stored in the unified `credentials` table as `credentialType = 'api_key'`.

API-key connectors support either header placement (`api_key_header_name` plus optional `api_key_prefix`) or query placement (`api_key_query_param`). Bearer-token connectors always use `Authorization: Bearer <token>`.

When a user connects a user-scoped API-key/bearer connector, the configure endpoint validates the submitted token by calling the MCP server with that token before creating the integration row. A failed initialize/tools-list request must reject the connection and leave no integration or credential row behind.

Implementation detail: org-scoped API-key/bearer connectors compose the configured static auth source into `staticAuthHeader` or `staticAuthQueryParam` before constructing `McpActionSource`. User-scoped API-key/bearer connectors pass the resolved user token through `tokenAuthHeader` or `authQueryParam`. Additional static headers go through `additionalHeaders` only after validation as non-auth extension headers. Do not treat custom API keys as standard OAuth bearer tokens unless the connector is explicitly bearer-token auth, because that would ignore custom header/query placement or double-prefix preformatted values.

### MCP Client Updates

Targeted changes to `McpClient`:

1. **Protocol version:** Update the client's latest supported version constant to `2025-11-25` and maintain an explicit supported-version set (`2025-03-26`, `2025-06-18`, and `2025-11-25`). Store the protocol version returned by `initialize` and send `MCP-Protocol-Version` with that negotiated version on all requests after initialization. If a server negotiates an unsupported version, fail initialization instead of caching a session. If a server negotiates an older supported version, the header must use the negotiated value rather than blindly sending the latest constant.

2. **Session reset on 404:** When a request returns 404 and the client has a cached `Mcp-Session-Id`, clear the session cache for that service and re-initialize. Retry the original request once.

3. **Static headers and custom auth sources:** Add `additionalHeaders?: Record<string, string>` for validated non-auth extension headers, `staticAuthHeader?: { name: string; value: string }`, `staticAuthQueryParam?: { name: string; value: string }`, and `tokenAuthHeader?: { name: string; prefix?: string | null }` to `McpClient` constructor options. Merge these into every outgoing request in `buildFetchOpts()` so both `rpc()` and `notify()` requests include them. Existing `authQueryParam` continues to support per-user tokens sent in a query parameter. `buildFetchOpts()` also owns adding `MCP-Protocol-Version` when a negotiated version exists, so `notifications/initialized` and later requests are versioned consistently.

**Header merge and validation:** `additionalHeaders` are static non-auth extension headers only. Header names are case-insensitive; normalize names for validation, reject duplicates after normalization, reject invalid HTTP field names, and reject values containing CR, LF, or NUL.

Do not allow `additionalHeaders` to set client-owned, auth-owned, hop-by-hop, or fetch-controlled headers. The blocked set includes `authorization`, `content-type`, `accept`, `mcp-session-id`, `mcp-protocol-version`, `connection`, `keep-alive`, `proxy-authenticate`, `proxy-authorization`, `te`, `trailer`, `transfer-encoding`, `upgrade`, `host`, `content-length`, `cookie`, `date`, `dnt`, `expect`, `origin`, `referer`, `accept-charset`, `accept-encoding`, `access-control-request-headers`, `access-control-request-method`, `permissions-policy`, and any `proxy-*` or `sec-*` header.

Generated API-key/bearer auth headers are not arbitrary `additionalHeaders`. Preserve their provenance separately until `McpClient.buildFetchOpts()` merges headers. The generated API-key/bearer header may use `Authorization`, but only from the dedicated connector auth fields. If it collides with an additional header, fail connector resolution/config validation.

`buildFetchOpts()` must fail closed on auth ambiguity. It must not send more than one token-derived auth source (`Authorization` bearer, custom token header, or token query parameter), and it must not combine a token-derived source with a generated static auth source. It must not let any caller-provided header override `Content-Type`, `Accept`, `Authorization`, `MCP-Session-Id`, or `MCP-Protocol-Version`.

Merge order is: validated non-auth additional headers, client transport defaults, exactly one auth source, then negotiated MCP protocol/session headers.

### Admin CRUD Routes

New routes under `/api/admin/mcp-connectors`, protected by `adminMiddleware`:

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/` | List all connectors for the org. Includes `tool_count` from `mcp_tool_cache` join. |
| `POST` | `/` | Create a connector. Validates slug, explicit auth mode, safe URLs, endpoints, and secrets. |
| `PUT` | `/:id` | Update a connector. Slug is immutable — rejected if changed. |
| `DELETE` | `/:id` | Delete a connector + cascade cleanup. |

No test endpoint. Tool discovery happens lazily through the normal `listTools()` path when a user with valid credentials (or no-auth) triggers a session. The `tool_count` shown in the admin table is derived from `mcp_tool_cache` rows for the service slug, updated as a side effect of normal tool discovery.

**Create validation:**
- `display_name`: required
- `server_url`: required, passes the outbound URL policy
- `service_slug`: auto-generated from display name on create, validated as lowercase alphanumeric + hyphens, 3-64 chars, not in static `installedIntegrations` registry
- `authType`: required by the API and defaulted to `none` by the UI. Backend validates it and stores it as `auth_type`.
- OAuth requires `oauth_client_id`; `oauth_client_secret` is optional. Authorization/token endpoints are required in the MVP and are stored explicitly. Optional `oauth_scopes` are stored as a space-separated string.
- `oauth_token_endpoint_auth_method`: stored as `none`, `client_secret_basic`, or `client_secret_post` using the defaulting rules in the OAuth section unless explicitly overridden.
- API key/bearer defaults to `credential_scope = 'org'`. Org-scoped connectors require a non-empty secret on create and encrypt it into `encrypted_api_key`. User-scoped connectors reject connector-level secrets and require each user to connect with their own key/token.
- API key placement defaults to header. Query placement requires `api_key_query_param`. Bearer-token connectors always use the `Authorization` header with `Bearer` prefix.
- `additional_headers`: if provided, must be a valid JSON object with string keys/values, pass header policy validation, and is encrypted into `encrypted_additional_headers`. Provided object replaces the whole header object.

**Update validation:**
- `service_slug` is immutable — return 400 if the request attempts to change it
- `authType` is required
- If `authType` is unchanged:
  - omitted `oauth_client_secret` / `api_key` preserves the current encrypted value
  - non-empty secret replaces it
  - `clearClientSecret: true` clears `encrypted_oauth_client_secret` while staying in OAuth/public-PKCE mode
  - Org-scoped API-key/bearer cannot remain active without an existing or replacement key
  - User-scoped API-key/bearer must not store an org secret
- If `authType` changes:
  - leaving OAuth clears `encrypted_oauth_client_secret`, `oauth_client_id`, scopes, and OAuth endpoints unless the new mode is OAuth
  - leaving API-key/bearer clears `encrypted_api_key`, `api_key_header_name`, `api_key_prefix`, `api_key_placement`, and `api_key_query_param`
  - entering org-scoped API-key/bearer requires a replacement secret
  - entering user-scoped API-key/bearer requires no connector-level secret and existing per-user credentials are collected through the integrations flow
- If the user credential contract changes (`oauth` ↔ user-scoped `api_key`/`bearer`, or any user-scoped connector becomes org-scoped/no-auth), delete existing user integration rows and credentials for the connector slug. Users must reconnect under the new credential contract; do not let stale `oauth2` and `api_key` rows compete for the same provider slug.
- Endpoint override fields are non-secret and are returned/pre-populated. Omitted means preserve; explicit `null` or empty string clears.
- Additional headers are write-only as values. Omitted means preserve the whole encrypted object; provided object replaces the whole object; `{}` or `clearAdditionalHeaders: true` clears it. Individual header value editing is not supported unless header names/metadata are separately stored and returned.
- Additional headers are auth-mode independent and should be preserved across auth mode changes unless explicitly replaced/cleared.
- Changing `server_url`, auth mode, status, or additional headers deletes `mcp_tool_cache` rows for the service so policy/enablement UI cannot show stale/deactivated tools

**D1 atomicity:** Admin update/delete cleanup MUST use raw `env.DB.batch()` with prepared statements. Do not use sequential Drizzle deletes for cascade cleanup. If any statement fails, D1 rolls back the entire batch and the route returns an error; no compensating cleanup is attempted.

**Delete cleanup:** First load connector by id to get `service_slug`; then run one D1 batch:
1. `DELETE FROM mcp_tool_cache WHERE service = ?`
2. `DELETE FROM integrations WHERE service = ?`
3. `DELETE FROM credentials WHERE provider = ?`
4. `DELETE FROM disabled_actions WHERE service = ?`
5. `DELETE FROM action_policies WHERE service = ?`
6. `DELETE FROM user_action_policy_overrides WHERE service = ?`
7. `DELETE FROM custom_mcp_connectors WHERE id = ? AND service_slug = ?`

Historical `action_invocations` rows are preserved. FK `ON DELETE SET NULL` may clear policy/override id references, but denormalized audit fields remain.

### Frontend

#### Add Connector Dialog

Modeled after Claude.ai's "Add custom connector" dialog. A dialog (not an inline form) with minimal fields:

- **Name** (text input)
- **Remote MCP server URL** (text input, HTTPS)
- **Advanced settings** (collapsible, collapsed by default):
  - **Auth type** (radio or select: None / OAuth / API Key / Bearer, default None)
  - If OAuth: **Client ID** (text), **Client Secret** (password, optional), **Token endpoint auth method** (Auto / Client secret basic / Client secret post), **Scopes** (text, optional), **Authorization Endpoint**, and **Token Endpoint**
  - If API Key: **Credential scope** (Organization key / Per-user key), optional org-level **API Key** (password), **Placement** (Header / Query), **Header Name** + **Prefix** or **Query Parameter**
  - If Bearer: **Credential scope** (Organization token / Per-user token), optional org-level **Bearer Token** (password), always sent as `Authorization: Bearer <token>`
  - Optional custom request headers are accepted as advanced static headers and stored encrypted. They must not be shown back to the client; only a `hasAdditionalHeaders` flag is returned.
- Read-only helper text showing the **OAuth redirect URI** (e.g., `https://app.valet.dev/integrations/callback`) so admins know what to register with their OAuth provider
- **Cancel** / **Add** buttons

The service slug is auto-generated from the display name (lowercased, spaces to hyphens, non-alphanumeric stripped) and is immutable after creation.

On edit, password fields are blank and use `(unchanged)` placeholders when the corresponding `has*` flag is true. Typing a new value replaces the secret. OAuth client secret has a "Remove secret" control when `hasClientSecret` is true. API-key/bearer secrets cannot be cleared while staying in that auth mode; switch auth type or delete the connector.

Additional headers are not pre-populated because values are secret. Show "configured" from `hasAdditionalHeaders`; offer Replace and Clear controls. Replacement submits the complete new header object.

The admin settings page shows a "Custom MCP Connectors" section with a table of existing connectors (Name, URL, Status, Tool Count) and an "Add Connector" button that opens the dialog. Each row has Edit/Delete actions. Tool count is populated lazily — it updates when a user session triggers tool discovery for that connector.

#### User Integrations Page

Custom connectors with `authType: 'oauth'` or user-scoped `authType: 'api_key' | 'bearer'` appear in the integrations list alongside built-in integrations, visually distinguished with a "Custom" badge and a generic MCP icon (no per-connector icon in MVP). The existing `ConnectIntegrationDialog` handles OAuth and API-key entry — the backend routes branch by resolving the requested service slug against active custom connectors. Client-side `AvailableService` and `ResolvedService` types must preserve `isCustomConnector`, and shared integration request/response types must allow arbitrary string service slugs for custom connectors while keeping the built-in `IntegrationService` union available for static services.

Custom connectors with `authType: 'none'` or org-scoped `api_key`/`bearer` do not appear in the user integrations page because no per-user connection is needed.

#### Action Policy UI

Custom connector tools appear in the action policy section after discovery. The existing `mcp_tool_cache` table provides this, but `/api/integrations/actions` must filter cached rows for deleted/disabled custom connectors and use active custom connector display names when merging cache entries. Cache rows are deleted when connector URL/auth/status/header settings change or when a connector is deleted.

### Security

- OAuth client secrets, org-scoped API keys/bearer tokens, per-user custom MCP API keys/bearer tokens, and additional static request headers are encrypted at rest with PBKDF2, same as existing credentials.
- Secrets are never returned in API responses. The API returns boolean flags such as `hasClientSecret`, `hasApiKey`, and `hasAdditionalHeaders`.
- Admin-only CRUD. Users can only connect/disconnect their own credentials.
- Custom connector slugs cannot collide with built-in services (validated at creation), are globally unique, and are immutable after creation.
- MCP requests to custom server URLs are made server-side from the worker, not from the client browser. No CORS concerns.
- Connector outbound requests use `safeFetchOutbound()` and the outbound URL policy. Private-network URL shapes, custom ports, unsafe redirects, and raw `fetch()` are not allowed in the MVP; the Worker does not perform direct DNS lookups for connector validation.
- Additional request headers are treated as static config, not templates. No variable interpolation that could leak user data. They cannot override client-owned, auth-owned, hop-by-hop, or fetch-controlled headers.
- Deleting a connector invalidates all user credentials and cached tools for that service.
- Custom connectors do not write to `mcp_oauth_clients` — OAuth metadata lives on the connector record itself. This avoids data duplication and keeps the dynamic-registration table clean.

## Boundary

This spec covers the custom MCP connector data model, admin CRUD, dynamic registry resolution, auth flows (no-auth + OAuth + API key), MCP client protocol updates, and frontend UI for admin and user flows.

This spec does NOT cover:
- Changes to the plugin package system or auto-generated registries
- stdio/local MCP transports
- MCP prompts or resources
- Connector health monitoring or auto-disable on repeated failures (future enhancement)
- Bulk import/export of connector configs
