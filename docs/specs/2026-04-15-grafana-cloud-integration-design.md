# Grafana Cloud Integration

**Date:** 2026-04-15
**Status:** Draft
**Scope:** New `plugin-grafana` package exposing Grafana Assistant (via A2A) and direct observability queries; generic `integration_accounts` pattern replacing the legacy `integrations` table across the worker.

## Problem

Valet users do serious observability work in Grafana Cloud — metrics, logs, traces, dashboards, alerts, incidents, and (increasingly) conversations with Grafana Assistant. Today, a Valet agent has no first-class way to pull data out of or delegate work into a Grafana stack. End-to-end debugging stops at Valet's boundary.

This spec introduces a first Grafana plugin with two capability shapes:

1. **Grafana Assistant as a sub-agent** — the Valet agent can hand off a debugging question to Grafana Assistant, get streaming or polled responses back, and read conversation history.
2. **Direct observability queries** — the Valet agent can independently query Prometheus, Loki, and Tempo and inspect dashboards, alert rules, firing alerts, and incidents.

A second, load-bearing concern: **Valet's current integration-state storage doesn't scale** to integrations that can have multiple instances per org (multiple Grafana stacks, multiple Cloudflare accounts, multiple Slack workspaces, and so on). Rather than bolt per-integration tables on for each new plugin, this spec introduces a single generic pattern — `integration_accounts` — and migrates existing integrations onto it in one go, so the codebase has exactly one shape for this data going forward.

## Solution overview

- **Generic integration-account pattern**: new `integration_accounts` table, provider-contract additions (`supportsMultipleAccounts`, `configSchema`), SDK helpers (`resolveAccount`, `listAccounts`, etc.). Migrates all existing integrations into the new table in the same PR. `github_installations` stays (legitimate protocol-specific exception, documented in the boundary rule).
- **`@valet/sdk/a2a`**: a thin client wrapper around the Agent-to-Agent protocol, usable by any future plugin that needs to speak A2A. Uses [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk) as the underlying implementation; falls back to a hand-rolled client (in the same location, same public API) if the upstream SDK is incompatible with the Cloudflare Workers runtime.
- **`packages/plugin-grafana`**: 13 read-only tools hand-rolled in TypeScript, using the shapes and parameter schemas from [`grafana/mcp-grafana`](https://github.com/grafana/mcp-grafana) as reference. A2A-backed Assistant tools + direct HTTP queries for everything else.
- **Auth**: service account tokens (`authType: 'api_key'`). Each registered stack is an `integration_accounts` row with `config = { grafanaUrl }` and a linked `credentials` row.

## The generic integration-account pattern

### Conceptual model

Every integration in Valet has the same shape: an **owner** (user or org) has zero or more named **accounts** on a service, each with its own credentials and service-specific config. "Single-instance" integrations (Slack) just never create a second account. "Multi-instance" integrations (Grafana, future multi-org Cloudflare) create as many accounts as needed. The storage, resolver, and install flow are identical.

### `integration_accounts` table

```sql
CREATE TABLE integration_accounts (
  id TEXT PRIMARY KEY,

  -- Ownership
  owner_type TEXT NOT NULL,               -- 'user' | 'org'
  owner_id TEXT NOT NULL,

  -- Identity
  service TEXT NOT NULL,                  -- matches IntegrationProvider.service
  handle TEXT NOT NULL DEFAULT 'default', -- user-chosen slug ('prod', 'staging', 'acme')
  display_name TEXT NOT NULL,

  -- Selection
  is_default INTEGER NOT NULL DEFAULT 0,

  -- Lifecycle
  status TEXT NOT NULL DEFAULT 'active',  -- 'pending' | 'active' | 'error'
  error_message TEXT,
  last_used_at TEXT,
  last_synced_at TEXT,

  -- Service-specific config, validated by provider.configSchema
  config TEXT NOT NULL DEFAULT '{}',

  -- Credential linkage (1:1)
  credential_id TEXT REFERENCES credentials(id) ON DELETE SET NULL,

  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now')),

  UNIQUE(owner_type, owner_id, service, handle)
);

-- At most one default per (owner, service)
CREATE UNIQUE INDEX idx_integration_accounts_default
  ON integration_accounts(owner_type, owner_id, service) WHERE is_default = 1;

CREATE INDEX idx_integration_accounts_lookup
  ON integration_accounts(owner_type, owner_id, service);
```

### Provider contract additions

Two new fields on `IntegrationProvider` in `@valet/sdk`:

```ts
export interface IntegrationProvider<TConfig = unknown> {
  // ... existing fields ...

  /** If false, only one account per (owner, service) can exist. Default: false. */
  readonly supportsMultipleAccounts?: boolean;

  /**
   * Zod schema validating the JSON stored in integration_accounts.config.
   * Single source of truth: drives install-form rendering and typed reads from tool code.
   */
  readonly configSchema?: z.ZodType<TConfig>;
}
```

Plugins that need neither leave both unset (current behavior preserved). Grafana declares:

```ts
export const grafanaProvider: IntegrationProvider<{ grafanaUrl: string }> = {
  service: 'grafana',
  displayName: 'Grafana Cloud',
  authType: 'api_key',
  supportedEntities: ['metrics', 'logs', 'traces', 'alerts', 'dashboards', 'incidents'],
  supportsMultipleAccounts: true,
  configSchema: z.object({ grafanaUrl: z.string().url() }),
  validateCredentials, testConnection,
};
```

### SDK helpers (the only API plugin authors need)

Added to `@valet/sdk/integrations/accounts`:

```ts
export async function resolveAccount<TConfig>(
  db: Database,
  provider: IntegrationProvider<TConfig>,
  params: { ownerType: 'user' | 'org'; ownerId: string; handle?: string }
): Promise<{
  account: IntegrationAccount;
  config: TConfig;        // parsed + validated by provider.configSchema
  credentials: Credentials;
}>;

export async function listAccounts(
  db: Database,
  params: { ownerType: 'user' | 'org'; ownerId: string; service: string }
): Promise<IntegrationAccount[]>;

export async function createAccount(
  db: Database,
  provider: IntegrationProvider,
  params: {
    ownerType: 'user' | 'org';
    ownerId: string;
    handle: string;
    displayName: string;
    config: unknown;       // validated against provider.configSchema
    credentials: unknown;  // encrypted and stored in credentials table
    isDefault?: boolean;
  }
): Promise<IntegrationAccount>;

export async function updateAccount(
  db: Database,
  id: string,
  patch: Partial<{ displayName: string; handle: string; config: unknown; status: string }>
): Promise<IntegrationAccount>;

export async function deleteAccount(db: Database, id: string): Promise<void>;

export async function setDefaultAccount(db: Database, id: string): Promise<void>;
```

Plugin code is a one-liner:

```ts
const { config, credentials } = await resolveAccount(db, grafanaProvider, {
  ownerType, ownerId, handle,
});
// config.grafanaUrl is typed.
```

If `handle` is omitted, `resolveAccount` returns the `is_default` row. If zero accounts exist, it throws a typed `NotConfiguredError` that the agent-tools layer surfaces as a clear message.

### Changes to `credentials` table

Drop the unique index `credentials_owner_unique(ownerType, ownerId, provider, credentialType)`. It enforces one credential per provider per owner, which blocks multi-instance. Navigation moves to `integration_accounts.credential_id`. Orphan credentials (no linking account) are rows we can GC or reject at write time.

### Migration of existing integrations

In the same PR as the new table:

1. For every row in the legacy `integrations` table, create an `integration_accounts` row:
   - `handle='default'`, `is_default=1`, `display_name` = service's `displayName`
   - Copy `config`, `status`, `errorMessage` → `error_message`, `lastSyncedAt` → `last_synced_at`
   - Derive `owner_type`/`owner_id` from `scope` (`'user'` → `owner_type='user', owner_id=userId`; `'org'` → `owner_type='org', owner_id=<user's primary org>`)
   - Link `credential_id` by joining `credentials` on `(ownerType, ownerId, provider=service)`
2. Rows whose owner can't be resolved are **dropped silently** (we're still pre-prod; no audit ceremony needed).
3. Drop the `integrations` table.
4. Update all 7 call sites (`lib/db/integrations.ts` deleted; `services/integrations.ts`, `routes/integrations.ts`, `session-agent.ts`, `services/slack.ts`, `routes/plugins.ts`, and React components `integration-list`, `connect-integration-dialog`, `integration-card`) to use the new helpers.
5. Bump the client-side TanStack query-key namespace so caches reset on deploy.

### `github_installations` — the documented exception

The `github_installations` table stays. It holds GitHub App protocol state (installation_id indexed for webhook lookups, cached installation tokens with independent TTL, repository-selection state) that does not fit the generic `config` JSON shape. This is the legitimate exception, not the pattern.

### Boundary rule (added to `docs/specs/integrations.md`)

> **New integrations use `integration_accounts` + `config` JSON.** Only add a dedicated table if the integration has:
>
> - Structured fields that must be queryable/indexable (e.g., `github_installations.githubInstallationId` looked up by webhooks)
> - Protocol-specific lifecycle state (cached tokens with independent expiry, permission grants, etc.)
> - Foreign-key targets from other tables
>
> Otherwise: one row in `integration_accounts`, service-specific metadata in `config`, validated by `provider.configSchema`.

## A2A client in `@valet/sdk`

### Location and shape

```
packages/sdk/src/a2a/
├── index.ts           # Public exports
├── client.ts          # A2AClient wrapper
├── types.ts           # Task, Message, Artifact, TaskStatus
└── sse-stream.ts      # Present only if we hand-roll; SSE parser
```

Public API:

```ts
import { A2AClient } from '@valet/sdk/a2a';

const client = new A2AClient({
  endpoint: 'https://acme.grafana.net',
  authHeader: `Bearer ${token}`,
});

// Fetch agent card (cached by caller)
const card = await client.getAgentCard();

// Send a message, optionally continuing an existing context
const { taskId, contextId, status, messages } = await client.sendMessage({
  prompt,
  contextId,
  timeoutMs: 45_000, // 0 = return immediately after submit (no wait for completion)
});

// Poll
const task = await client.getTask(taskId);

// Cancel
await client.cancelTask(taskId);

// Read full context history
const context = await client.getContext(contextId);
```

Implementation uses [`@a2a-js/sdk`](https://www.npmjs.com/package/@a2a-js/sdk) v0.3.0 under the hood. If that SDK turns out to have Node-only dependencies that block use in Cloudflare Workers, we hand-roll the client in the same file with the same public API — it's roughly 200 lines of JSON-RPC 2.0 + SSE parsing against the A2A v0.3.0 spec. Verifying Workers compatibility is the **first implementation step**, before any plugin work.

### Agent Card discovery

A2A servers expose an `AgentCard` at `/.well-known/agent-card.json`. The plugin fetches the card from the stack's Grafana URL on first use per account, caches it in `integration_accounts.config.agentCard` with a 24h TTL, and uses it to configure the client (endpoint, supported transports, auth schemes).

**What's not yet known** (part of step 1 spike): the exact path the Grafana Assistant A2A server is mounted at within a Grafana Cloud stack. Candidates include `<grafanaUrl>/.well-known/agent-card.json` (if Grafana Assistant owns the stack's well-known namespace) or a plugin-scoped path like `<grafanaUrl>/api/plugins/grafana-assistant-app/resources/.well-known/agent-card.json`. The spike confirms this and we wire the client accordingly. If it turns out the Assistant A2A endpoint is not on the same origin as the Grafana HTTP API (e.g., lives behind `assistant.grafana.com` with a separate auth flow), the provider's `configSchema` gains an optional `assistantEndpoint` field and the install UI exposes it.

### Streaming & Worker time budget

A2A tasks can run for minutes; Cloudflare Workers have a short CPU budget but generous wall-clock on subrequest streaming. The plugin exploits this:

- `grafana_assistant_send` with `wait: true`: the tool passes `timeoutMs: 45_000` to the A2A client's `sendMessage`, which opens the SSE stream and accumulates messages until the task reaches a terminal state **or** the timeout expires (clamped to 60s max, to stay inside Worker limits). On timeout, the tool returns `{ status: 'running', taskId, contextId, partial: [...] }` so the agent can poll.
- `grafana_assistant_send` with `wait: false` (default): the tool passes `timeoutMs: 0` to the client and returns immediately with `{ status: 'submitted', taskId, contextId }`. Agent polls via `grafana_assistant_get_task`.
- `grafana_assistant_get_task`: single GET, no streaming; returns a snapshot.

The tool-level `wait: boolean` is a simple knob for the agent; the underlying A2A client accepts `timeoutMs` for future callers that want finer-grained control.

### Message-part handling

A2A messages carry parts of type `text`, `file`, or `data`. The tool layer surfaces:

- `text` parts → joined string in the tool result
- `data` parts → verbatim JSON (preserves structured outputs like query results or dashboard refs)
- `file` parts → `{ url, mimeType }` only; agent fetches blob if needed

Artifacts (deliberate Assistant outputs) surface as a separate `artifacts[]` field, distinct from conversational `messages[]`.

## Tool surface — `packages/plugin-grafana`

13 read-only tools. Every tool accepts an optional `account?: string` (handle). Omitted → default account. Unknown handle → `ValidationError` listing available handles.

### Assistant (4 tools) — via `@valet/sdk/a2a`

| Tool | Purpose | Key params |
|---|---|---|
| `grafana_assistant_send` | Start a new conversation or continue an existing one. | `prompt: string`, `contextId?: string`, `wait?: boolean` (default false) |
| `grafana_assistant_get_task` | Status of an in-flight task. | `taskId: string` |
| `grafana_assistant_cancel_task` | Abort a running task. | `taskId: string` |
| `grafana_assistant_get_context` | Read full message history of a context. | `contextId: string` |

Naming mirrors A2A's own `message/send`, `tasks/get`, `tasks/cancel` verbs for discoverability.

### Observability queries (3 tools) — raw HTTP

| Tool | Purpose | Key params |
|---|---|---|
| `grafana_query_metrics` | PromQL instant or range query. Returns `{ resultType, result[] }`. | `query`, `datasource?` (uid or name), `range?: { from, to, step }`, `limit?` |
| `grafana_query_logs` | LogQL query against Loki. Returns streams + entries. | `query`, `datasource?`, `range: { from, to }`, `limit?`, `direction?` |
| `grafana_query_traces` | TraceQL search or fetch by ID against Tempo. | Either `query` + `range`, or `traceId` |

**Datasource resolution**: accepts UID or friendly name. Defaults to the first datasource of the matching type on the stack. Errors include the list of available datasources of the matching type so the agent can self-correct without a second round-trip.

### Dashboards (2 tools)

| Tool | Purpose | Key params |
|---|---|---|
| `grafana_list_dashboards` | Search by text/tags/folder. Paginated. | `query?`, `tag?: string[]`, `folderUid?`, `limit?` |
| `grafana_get_dashboard` | Full dashboard JSON (panels, queries, variables). | `uid: string` |

### Alerts (2 tools)

| Tool | Purpose | Key params |
|---|---|---|
| `grafana_list_alert_rules` | Rules + current state. | `folder?`, `ruleGroup?`, `state?: 'firing' \| 'pending' \| 'normal' \| 'error'` |
| `grafana_list_firing_alerts` | Active firing instances with annotations/labels/startsAt. | `labelMatchers?: Record<string, string>` |

### Incidents (2 tools)

| Tool | Purpose | Key params |
|---|---|---|
| `grafana_list_incidents` | Open/recent incidents with status, severity, createdAt. | `status?: 'active' \| 'resolved'`, `severity?`, `limit?` |
| `grafana_get_incident` | Full incident details: timeline, roles, linked resources. | `incidentId: string` |

### Risk levels

Every tool is `low` risk in MVP; all are read-only. The Assistant can itself take write actions via its internal tool set — that risk is delegated to whatever guardrails Grafana Assistant enforces.

**Explicit note for future contributors**: no write tools (silence alert, declare incident, edit dashboard) are added without a separate design review. This spec does not authorize them.

### Not in MVP (and why)

- Dashboard / alert / incident **writes** — risk review required first
- Grafana OnCall schedules — low-value for autonomous debugging
- Synthetic monitoring, k6 tests, ML features — outside observability-debugging scope
- Folder / user / team admin — provisioning, not observability

## Package structure

```
packages/plugin-grafana/
├── plugin.yaml              # name: grafana, actionType: actions
├── package.json             # deps: @valet/sdk, @valet/shared, zod, @a2a-js/sdk
├── tsconfig.json
└── src/
    └── actions/
        ├── index.ts         # IntegrationPackage export
        ├── provider.ts      # grafanaProvider (api_key + configSchema)
        ├── actions.ts       # ActionSource registering all tools
        ├── client.ts        # HTTP client: base URL + auth + error mapping
        ├── datasources.ts   # Default-datasource resolution helpers
        └── tools/
            ├── assistant.ts
            ├── metrics.ts
            ├── logs.ts
            ├── traces.ts
            ├── dashboards.ts
            ├── alerts.ts
            └── incidents.ts
```

Tools run in the **Worker**, dispatched by `packages/worker/src/services/session-tools.ts` — same path as every other action-type plugin.

## Install flow

1. User hits "Connect Grafana Cloud" in integration settings.
2. Dialog collects: `grafanaUrl` (URL), `displayName` (string), `handle` (slug, defaults to `"default"`; hidden behind "advanced" disclosure when `supportsMultipleAccounts` and zero existing accounts), `apiKey` (password).
3. Worker validates:
   - `grafanaUrl` format
   - Token via `provider.testConnection` (hits `GET /api/user` against the stack)
4. On success, single-transaction: `createAccount()` inserts `integration_accounts` row + encrypted `credentials` row.
5. UI reflects the new stack with "Set as default", "Edit", "Remove" controls.

**Required SA token scopes**, surfaced in the install dialog: viewer-level access to datasources (metrics/logs/traces), dashboards, alerts, and incidents. Editor-level is not required for MVP.

**Schema-driven install UI** — the `configSchema` field is in place to enable generic form rendering later, but for this PR the Grafana install dialog is hand-written to match current UX conventions. Generic rendering is a follow-up.

## Error handling

Tools throw typed errors from `@valet/shared`; the session-tools layer maps them:

| Condition | Error | Agent message |
|---|---|---|
| No account for org | `NotConfiguredError` | "No Grafana stack is connected for this org. Ask an admin to connect one." |
| Unknown `handle` | `ValidationError` | "No Grafana stack named `<handle>`. Available: `prod`, `staging`." |
| Token rejected (401/403) | `UnauthorizedError` | "Grafana rejected the service account token. It may have expired or lost scopes." |
| Rate limited (429) | `RateLimitError` | Passes through retry-after. |
| Upstream 5xx | `UpstreamError` | Includes status + body snippet. |
| Unknown datasource | `ValidationError` | Lists available datasources of the matching type. |
| A2A task failed | `UpstreamError` | Includes `task.status.message` from A2A. |

**No retries in the tool layer.** Retries are an agent-level decision. Transient failures are not masked.

## Testing strategy

- **Unit (vitest, in `packages/plugin-grafana/`)**: stub `fetch` per tool; assert URL shape, auth header, body, response parsing. Especially important for PromQL/LogQL/TraceQL encoding.
- **A2A integration test**: a ~50-line mock A2A server (Hono handler speaking JSON-RPC) exercising `send` → `get_task` → `get_context` → `cancel_task`.
- **SDK helper tests (`packages/sdk/`)**: `resolveAccount` — default selection, missing handles, missing accounts, ownership mismatches, schema-validation errors.
- **Smoke test (`packages/worker/src/routes/sessions.test.ts` style)**: fake Grafana wired into the harness; agent calls `grafana_query_metrics` end-to-end through session-tools; assert tool call + response serialization.
- **Manual acceptance**: against real Grafana Cloud — one session per domain (ask-the-assistant, query-metrics, query-logs, list-firing-alerts, list-incidents).

## Order of implementation

1. **Verify `@a2a-js/sdk` compatibility in Workers runtime** — if it pulls in Node-only deps, decide now whether to hand-roll. Blocks downstream work.
2. `integration_accounts` table + migration + `credentials` index drop.
3. SDK helpers (`resolveAccount`, etc.) + provider contract additions.
4. Migrate legacy `integrations` callers to the new helpers; delete `lib/db/integrations.ts`; drop `integrations` table.
5. Update `docs/specs/integrations.md` with the new pattern + boundary rule.
6. `@valet/sdk/a2a` client wrapper.
7. `packages/plugin-grafana` — provider, client, tools (assistant first, then queries, then dashboards/alerts/incidents).
8. Install UI (hand-written form) + routes wiring.
9. Tests (unit, A2A integration, smoke).
10. Manual acceptance pass.

## Risks and mitigations

- **`@a2a-js/sdk` Workers compatibility** — verified as step 1; fallback is a hand-rolled client in the same location with the same API.
- **Grafana Assistant API evolution** — Grafana is actively shipping here. Mitigation: thin adapter boundary over the A2A client; all Grafana-specific assumptions live in `plugin-grafana`, not in `@valet/sdk/a2a`.
- **SSE streaming in Workers** — we return snapshots, not live streams, and wait-with-timeout caps at 60s to stay inside Worker limits.
- **Multi-stack UX clutter** — MVP single-stack install flow hides the `handle` field. Multi-stack admin UI is a clearly-scoped follow-up.

## Open follow-ups (not in this spec)

- Schema-driven install UI (generic form rendering from `configSchema`)
- Multi-stack admin UI
- Grafana write tools (silence, declare-incident, edit-dashboard) — require separate design review
- OnCall integration (schedules, escalations, acks)
- Folding `org_service_configs` into `integration_accounts` (different problem — admin-global, not per-owner)
- Grafana as a surfaced peer in Valet's own UI (child-session treatment for ongoing Assistant conversations) — interesting direction once the tool-level pattern is validated
