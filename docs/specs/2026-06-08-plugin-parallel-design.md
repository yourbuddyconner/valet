# Plugin Parallel — Design Spec

**Date:** 2026-06-08

## Problem

Parallel.ai is currently wired as a built-in LLM provider alongside Anthropic, OpenAI, and Google. This is wrong: Parallel is a web research/task API, not an LLM. The result is:

- The model picker tries (and fails) to load Parallel models from models.dev
- The API key is stored in `org_api_keys` alongside LLM keys, confusing the admin UI
- The four tools run as OpenCode-native sandbox tools, bypassing the worker action system

## Solution

Migrate Parallel AI to a proper action integration (`packages/plugin-parallel/`) using the same plugin pattern as Slack and GitHub. The API key is stored in `org_service_configs`. Four actions replace the four sandbox tools. A skill file teaches OpenCode when and how to call them.

## Scope

This spec covers:
- Plugin package structure and action definitions
- Credential storage and resolver pattern
- Admin API endpoints
- `buildCredentials` extension in `session-tools.ts`
- Cleanup of LLM provider references
- Skill content

This spec does NOT cover UI changes to the admin settings page (the new endpoints are sufficient; frontend wiring is out of scope).

---

## Plugin Package: `packages/plugin-parallel/`

```
packages/plugin-parallel/
├── plugin.yaml
├── package.json
├── tsconfig.json
├── skills/
│   └── parallel.md
└── src/
    └── actions/
        ├── index.ts
        ├── provider.ts
        └── actions.ts
```

**plugin.yaml:**
```yaml
name: parallel
version: 0.0.1
description: Parallel AI integration for web search, extraction, and async research tasks
icon: "🔍"
```

**provider.ts:** `authType: 'api_key'`, `service: 'parallel'`. `validateCredentials` checks `!!credentials.api_key`. `testConnection` does the same (no live probe — the key is already validated on save).

---

## Actions

Four actions under the `parallel` service:

### `parallel.web_search`

Synchronous call to `POST /v1beta/search` (beta endpoint). Returns search results immediately.

**Params:** `objective: string`, `queries: string[]`, `max_results?: number`, `mode?: "fast" | "one-shot" | "agentic"`

### `parallel.web_extract`

Synchronous call to `POST /v1beta/extract`. Returns extracted page content.

**Params:** `urls: string[]`, `objective?: string`, `full_content?: boolean`

### `parallel.submit_task`

Calls `POST /v1/tasks/runs`. Returns immediately with `{ run_id, status }` — does not poll. The agent is responsible for checking back with `get_task_result`.

**Params:** `task_type: "research" | "enrichment"`, `input: string`, `output_schema?: string`, `processor?: string`

**Returns:** `{ run_id: string, status: string }`

### `parallel.get_task_result`

Calls `GET /v1/tasks/runs/{run_id}` to check status. If status is `"completed"`, also fetches `GET /v1/tasks/runs/{run_id}/result` and returns the full result. If still running, returns `{ run_id, status: "running" }` — no polling.

**Params:** `run_id: string`

**Returns:** `{ run_id, status, result? }`

---

## Credential Storage

Key is stored in `org_service_configs` as an AES-256-GCM encrypted blob:

```json
{ "apiKey": "<the key>" }
```

Keyed by `service: 'parallel'`. This is the same table and encryption path used by Slack's bot token and the GitHub App config.

### Credential Resolver

New file: `packages/worker/src/integrations/resolvers/parallel.ts`

```typescript
export const parallelCredentialResolver: CredentialResolver = async (service, env) => {
  const db = getDb(env.DB);
  const config = await getServiceConfig<{ apiKey: string }>(db, env.ENCRYPTION_KEY, 'parallel');
  if (config?.config.apiKey) {
    return { ok: true, credential: { accessToken: config.config.apiKey, credentialType: 'api_key', refreshed: false } };
  }
  return { ok: false, error: { service, reason: 'not_found', message: 'Parallel API key not configured. Ask an admin to add it in Settings.' } };
};
```

Registered in `IntegrationRegistry.init()`:
```typescript
this.credentialResolvers.set('parallel', parallelCredentialResolver);
```

### `buildCredentials` Extension

`session-tools.ts:buildCredentials` currently only special-cases `bot_token`; everything else maps to `access_token`. Add `api_key` so actions receive `ctx.credentials.api_key`:

```typescript
const credentials: Record<string, string> =
  credentialType === 'bot_token' ? { bot_token: token } :
  credentialType === 'api_key'   ? { api_key: token } :
  { access_token: token };
```

---

## Admin API

Two new endpoints on `adminRouter` in `packages/worker/src/routes/admin.ts`:

```
PUT  /admin/integrations/parallel   body: { key: string }  → saves to org_service_configs
DELETE /admin/integrations/parallel                        → removes from org_service_configs
```

`PUT` validates the key is non-empty, encrypts, and upserts via `setServiceConfig`. `DELETE` calls `deleteServiceConfig`.

---

## Plugin Registration

1. Add `"@valet/plugin-parallel": "workspace:*"` to `packages/worker/package.json` dependencies
2. Add package reference to root `tsconfig.json` and `packages/worker/tsconfig.json`
3. Run `make generate-registries` to regenerate `src/integrations/packages.ts`

---

## Cleanup: LLM Provider Removals

| File | Change |
|---|---|
| `packages/worker/src/routes/admin.ts` | Remove `'parallel'` from `VALID_PROVIDERS` and `BUILT_IN_PROVIDER_IDS` |
| `packages/worker/src/services/model-catalog.ts` | Remove `parallel` from `PROVIDER_DISPLAY_NAMES` and `PROVIDER_ENV_KEYS` |
| `packages/worker/src/lib/env-assembly.ts` | Remove `parallel` entry from `providerEnvMap` |
| `packages/worker/src/env.ts` | Remove `PARALLEL_API_KEY?: string` |
| `packages/worker/src/durable-objects/session-agent.ts` | Remove the `if (!envVars.PARALLEL_API_KEY)` tool-disabling block |
| `packages/runner/src/bin.ts` | Remove `if (!process.env.PARALLEL_API_KEY)` tool-disabling block |
| `docker/opencode/tools/parallel_web_search.ts` | Delete |
| `docker/opencode/tools/parallel_web_extract.ts` | Delete |
| `docker/opencode/tools/parallel_deep_research.ts` | Delete |
| `docker/opencode/tools/parallel_data_enrichment.ts` | Delete |

---

## Skill: `skills/parallel.md`

Teaches OpenCode when and how to use the four actions:

- **Use `web_search`** for quick lookups, news, current documentation — returns immediately
- **Use `web_extract`** when you have specific URLs and need their content
- **Use `submit_task`** for deep research (competitive analysis, technical deep dives, market research) or structured data enrichment. Always save the returned `run_id`.
- **Use `get_task_result`** to check back on a submitted task. If status is `"running"`, the agent should continue other work and check again later.
- `task_type: "research"` for open-ended questions; `task_type: "enrichment"` for structured output with `output_schema`
- Processor tiers: `"fast"/"one-shot"/"agentic"` for search; `"pro"/"ultra"` for research; `"base"/"core"` for enrichment
- Tasks can take several minutes — don't block on them; submit and move on
