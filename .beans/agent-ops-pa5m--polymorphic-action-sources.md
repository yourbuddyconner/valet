---
# valet-pa5m
title: Polymorphic Action Sources
status: todo
type: epic
priority: medium
tags:
    - integrations
    - architecture
    - mcp
    - actions
    - packages
created_at: 2026-02-24T00:00:00Z
updated_at: 2026-02-24T00:00:00Z
---

Build the `UnifiedActionRegistry` that discovers and loads action sources from two archetypes: **action packages** (npm modules implementing the `ActionSource` contract from `@valet/action-sdk`) and **MCP connectors** (dynamic tool discovery from external HTTP servers). Both feed into the same policy-gated action service. Core integrations (GitHub, Gmail, Google Calendar) ship as default-installed action packages — the same mechanism that supports built-in functionality also supports third-party and community extensions.

## Problem

After bean cp7w, we have:
- `@valet/action-sdk` — the contract (`ActionPackage`, `ActionSource`, `ActionDefinition`)
- `@valet/actions-github`, `actions-gmail`, `actions-google-calendar` — core action packages
- The policy-gated action service (bean pg9a) — the execution pipeline

What's missing is the **discovery and loading layer**: how does the gateway find installed action packages, instantiate their `ActionSource`s, and merge them with MCP connectors into a unified catalog that the action service can query?

Beyond that, the system needs:
- **MCP connector support** — organizations should be able to plug in any HTTP-accessible MCP server and have its tools appear as actions, without code changes
- **A package install path** — organizations should be able to add extended functionality (Jira, Linear, Salesforce, or custom internal tools) by installing an npm package
- **Unified action catalog** — the agent sees all actions (from packages and connectors) through a single `run_action` tool, with no distinction in UX

## Design

### Package Loading

The gateway discovers installed action packages at startup. In the CF Workers build, packages are bundled at deploy time. In a future Node/Bun deployment, they could be loaded dynamically.

**Build-time manifest approach (CF Workers):**

```typescript
// packages/worker/src/actions/packages.ts
// This file is the "manifest" — it imports installed action packages.
// Adding a new package means adding an import here and redeploying.

import github from '@valet/actions-github';
import gmail from '@valet/actions-gmail';
import gcal from '@valet/actions-google-calendar';
import type { ActionPackage } from '@valet/action-sdk';

// Core packages — always installed
export const installedPackages: ActionPackage[] = [
  github,
  gmail,
  gcal,
];

// To add an extended package:
// 1. pnpm add @valet/actions-jira
// 2. Add: import jira from '@valet/actions-jira';
// 3. Add jira to installedPackages array
// 4. Redeploy
```

**Future: dynamic loading (Node/Bun runtime):**

```typescript
// When running on Node/Bun (bean cf0x), packages could be discovered
// from a config file or DB without redeployment:
import { readActionManifest } from './manifest.js';
const manifest = await readActionManifest(); // reads from config/DB
for (const pkg of manifest) {
  const mod = await import(pkg.moduleName); // dynamic import
  installedPackages.push(mod.default);
}
```

### Unified Action Registry

Merges installed packages + MCP connectors into a single queryable catalog:

```typescript
// packages/worker/src/actions/registry.ts

import type { ActionSource, ActionDefinition } from '@valet/action-sdk';
import { installedPackages } from './packages.js';
import { McpConnectorActionSource } from './mcp-connector.js';

export class UnifiedActionRegistry {
  private packageSources: ActionSource[] = [];
  private connectorSources: Map<string, McpConnectorActionSource> = new Map();

  /** Initialize from installed packages */
  init(): void {
    for (const pkg of installedPackages) {
      this.packageSources.push(pkg.createActionSource());
    }
  }

  /** Load MCP connectors for an org from DB */
  async loadConnectors(env: Env, orgId: string): Promise<void> {
    const connectors = await db.getOrgConnectors(env.DB, orgId);
    for (const connector of connectors) {
      if (connector.status === 'active') {
        this.connectorSources.set(connector.id, new McpConnectorActionSource(connector));
      }
    }
  }

  /** List all available actions (packages + connectors) */
  async listAllActions(): Promise<ActionDefinition[]> {
    const results: ActionDefinition[] = [];

    for (const source of this.packageSources) {
      results.push(...await source.listActions());
    }

    for (const source of this.connectorSources.values()) {
      try {
        results.push(...await source.listActions());
      } catch (error) {
        console.error(`Failed to discover tools from connector ${source.sourceId}:`, error);
        // Partial results — don't fail the whole catalog
      }
    }

    return results;
  }

  /** Get the source that can execute a given action */
  getSource(actionId: string): ActionSource | null {
    // MCP connector actions are prefixed with 'mcp:'
    if (actionId.startsWith('mcp:')) {
      const connectorId = actionId.split('.')[0].slice(4); // 'mcp:abc.tool' → 'abc'
      return this.connectorSources.get(connectorId) || null;
    }

    // Package actions use service prefix: 'github.create_issue' → look for sourceId='github'
    const service = actionId.split('.')[0];
    return this.packageSources.find(s => s.sourceId === service) || null;
  }

  /** List installed package names */
  listPackages(): string[] {
    return installedPackages.map(p => p.name);
  }

  /** List connector IDs */
  listConnectors(): string[] {
    return Array.from(this.connectorSources.keys());
  }
}
```

### Integration with Action Service

The action service (bean pg9a) uses the registry:

```typescript
// In services/actions.ts:invokeAction()
export async function invokeAction(env: Env, params: InvokeActionParams): Promise<InvokeActionResult> {
  const registry = new UnifiedActionRegistry();
  registry.init(); // loads installed packages

  if (params.orgId) {
    await registry.loadConnectors(env, params.orgId); // loads org MCP connectors
  }

  const source = registry.getSource(params.actionId);
  if (!source) throw new ValidationError(`Unknown action: ${params.actionId}`);

  const definitions = await source.listActions();
  const definition = definitions.find(d => d.id === params.actionId);
  if (!definition) throw new ValidationError(`Action not found: ${params.actionId}`);

  // Policy resolution uses the definition's risk level — same for packages and connectors
  const mode = await resolveMode(env, params.orgId, definition);

  // ... rest of invocation lifecycle (same as bean pg9a)
}
```

From the agent's perspective, there is zero difference between a package action and a connector action. The `run_action` OpenCode tool presents them all uniformly.

### MCP Connector (`McpConnectorActionSource`)

For dynamically discovered tools from external MCP servers. Implements the same `ActionSource` contract that packages implement.

```typescript
// packages/worker/src/actions/mcp-connector.ts

import type { ActionSource, ActionDefinition, ActionContext, ActionResult } from '@valet/action-sdk';

export class McpConnectorActionSource implements ActionSource {
  readonly sourceId: string;

  private connector: OrgConnector;
  private cachedTools?: McpTool[];
  private cacheExpiry?: number;

  constructor(connector: OrgConnector) {
    this.sourceId = `mcp:${connector.id}`;
    this.connector = connector;
  }

  async listActions(): Promise<ActionDefinition[]> {
    const tools = await this.discoverTools();

    return tools.map(tool => ({
      id: `mcp:${this.connector.id}.${tool.name}`,
      name: tool.name,
      description: tool.description || '',
      risk: this.deriveRisk(tool),
      params: jsonSchemaToZod(tool.inputSchema),
    }));
  }

  async execute(actionId: string, params: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
    const toolName = actionId.split('.').pop()!;

    const response = await this.callMcpServer('tools/call', {
      name: toolName,
      arguments: params,
    });

    return { data: response.content, executed: true };
  }

  private async discoverTools(): Promise<McpTool[]> {
    if (this.cachedTools && this.cacheExpiry && Date.now() < this.cacheExpiry) {
      return this.cachedTools;
    }

    const response = await this.callMcpServer('tools/list', {});
    this.cachedTools = response.tools;
    this.cacheExpiry = Date.now() + 5 * 60 * 1000; // 5 min cache
    return this.cachedTools;
  }

  private deriveRisk(tool: McpTool): RiskLevel {
    // 1. Explicit per-tool override from connector config
    const override = this.connector.toolOverrides?.[tool.name]?.risk;
    if (override) return override;

    // 2. MCP annotations (if server provides them)
    if (tool.annotations?.destructiveHint === true) return 'danger';
    if (tool.annotations?.readOnlyHint === true) return 'read';

    // 3. Connector default risk
    if (this.connector.defaultRisk) return this.connector.defaultRisk;

    // 4. System default: assume write (safe default)
    return 'write';
  }

  private async callMcpServer(method: string, params: unknown): Promise<any> {
    const secret = await resolveConnectorSecret(this.connector);

    const response = await fetch(this.connector.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(secret ? { Authorization: `Bearer ${secret}` } : {}),
        ...(this.connector.customHeaders || {}),
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: crypto.randomUUID(), method, params }),
    });

    if (!response.ok) throw new Error(`MCP server error: ${response.status} ${response.statusText}`);

    const result = await response.json();
    if (result.error) throw new Error(`MCP error: ${result.error.message}`);

    return result.result;
  }
}
```

### Connector Data Model

#### `org_connectors` D1 Table

```sql
CREATE TABLE org_connectors (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,                    -- Display name (e.g., "Internal Deploy API")
  url TEXT NOT NULL,                     -- MCP server URL
  auth_type TEXT NOT NULL DEFAULT 'none', -- 'none' | 'bearer' | 'custom_header'
  secret_id TEXT,                        -- FK to org_secrets (encrypted auth token)
  custom_headers TEXT,                   -- JSON: additional headers
  default_risk TEXT NOT NULL DEFAULT 'write', -- Default risk for discovered tools
  tool_overrides TEXT,                   -- JSON: { toolName: { risk, mode } }
  status TEXT NOT NULL DEFAULT 'active', -- 'active' | 'error' | 'disabled'
  last_discovery_at TEXT,
  tools_hash TEXT,                       -- Hash of discovered tools (for drift detection)
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_org_connectors_org ON org_connectors(org_id);
CREATE UNIQUE INDEX idx_org_connectors_org_name ON org_connectors(org_id, name);
```

#### `org_secrets` D1 Table

```sql
CREATE TABLE org_secrets (
  id TEXT PRIMARY KEY,
  org_id TEXT NOT NULL,
  name TEXT NOT NULL,
  encrypted_value TEXT NOT NULL,         -- AES-256-GCM encrypted
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX idx_org_secrets_org ON org_secrets(org_id);
CREATE UNIQUE INDEX idx_org_secrets_org_name ON org_secrets(org_id, name);
```

### Tool Drift Detection

MCP servers can change their tool offerings. Drift detection catches this:

```typescript
export async function checkConnectorDrift(
  env: Env,
  connector: OrgConnector,
): Promise<{ drifted: boolean; added: string[]; removed: string[] }> {
  const source = new McpConnectorActionSource(connector);
  const currentTools = await source.listActions();
  const currentHash = await sha256Hex(JSON.stringify(currentTools.map(t => t.id).sort()));

  if (currentHash === connector.tools_hash) {
    return { drifted: false, added: [], removed: [] };
  }

  const previousToolIds = connector.previous_tools ? JSON.parse(connector.previous_tools) : [];
  const currentToolIds = currentTools.map(t => t.id);

  const added = currentToolIds.filter(id => !previousToolIds.includes(id));
  const removed = previousToolIds.filter((id: string) => !currentToolIds.includes(id));

  await db.updateConnectorToolsHash(env.DB, connector.id, currentHash, currentToolIds);

  return { drifted: true, added, removed };
}
```

Run on a cron schedule (e.g., hourly) for all active connectors.

### Connector Management API Routes

```
POST   /api/admin/connectors                  — Create connector (with optional atomic secret)
GET    /api/admin/connectors                  — List org connectors
GET    /api/admin/connectors/:id              — Get connector details
PATCH  /api/admin/connectors/:id              — Update connector config
DELETE /api/admin/connectors/:id              — Delete connector
POST   /api/admin/connectors/:id/test         — Test connectivity (call tools/list)
POST   /api/admin/connectors/:id/refresh      — Force re-discovery of tools
GET    /api/admin/connectors/:id/tools        — List discovered tools with risk levels

POST   /api/admin/secrets                     — Create org secret
GET    /api/admin/secrets                     — List org secrets (names only, not values)
DELETE /api/admin/secrets/:id                 — Delete org secret
```

### How the Agent Uses Actions

From the agent's perspective, all action sources are identical:

```
Agent: I need to deploy the user-service to staging.

[Agent calls run_action("mcp:deploy-api.deploy_service", { service: "user-service", env: "staging" })]
→ Registry resolves to McpConnectorActionSource
→ Policy check: write risk → require_approval → user approves
→ MCP server called → result returned

Agent: Now create a Jira ticket to track this deployment.

[Agent calls run_action("jira.create_issue", { project: "OPS", summary: "Deploy user-service v2.3.1" })]
→ Registry resolves to JiraActionSource (from @valet/actions-jira package)
→ Policy check: write risk → allow (org policy: jira.* → allow)
→ Jira API called → result returned

Agent: And update the GitHub issue.

[Agent calls run_action("github.add_comment", { owner: "myorg", repo: "user-service", issue: 42, body: "Deployed to staging" })]
→ Registry resolves to GithubActionSource (from @valet/actions-github package)
→ Policy check: write risk → allow
→ GitHub API called → result returned
```

Three different sources (MCP connector, extended package, core package), same UX, same policy gate.

### Third-Party Package Authoring

Publishing a community action package:

```bash
mkdir valet-actions-notion && cd valet-actions-notion
npm init
npm install @valet/action-sdk zod
```

```typescript
// src/index.ts
import type { ActionPackage } from '@valet/action-sdk';
import { NotionActionSource } from './source.js';

export default {
  name: 'notion',
  version: '1.0.0',
  createActionSource: (config) => new NotionActionSource(config),
} satisfies ActionPackage;
```

```typescript
// src/source.ts
import { z } from 'zod';
import type { ActionSource, ActionDefinition, ActionContext, ActionResult } from '@valet/action-sdk';

export class NotionActionSource implements ActionSource {
  readonly sourceId = 'notion';

  async listActions() {
    return [
      {
        id: 'notion.create_page',
        name: 'Create Notion Page',
        description: 'Create a new page in a Notion database',
        risk: 'write' as const,
        params: z.object({
          databaseId: z.string(),
          title: z.string(),
          properties: z.record(z.unknown()).optional(),
        }),
      },
    ];
  }

  async execute(actionId: string, params: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
    const res = await fetch('https://api.notion.com/v1/pages', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${ctx.token}`,
        'Notion-Version': '2022-06-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        parent: { database_id: (params as any).databaseId },
        properties: { title: { title: [{ text: { content: (params as any).title } }] } },
      }),
    });
    return { data: await res.json(), executed: true };
  }
}
```

```bash
npm publish
# User installs: pnpm add valet-actions-notion
# Add import to packages/worker/src/actions/packages.ts
# Redeploy
```

## Migration Plan

### Phase 1: Action package loading

1. Create `packages/worker/src/actions/packages.ts` manifest with core package imports
2. Create `packages/worker/src/actions/registry.ts` with `UnifiedActionRegistry`
3. Wire the registry into the action service (bean pg9a)
4. At this point, only package sources exist — no MCP connector support yet

### Phase 2: Connector data model

1. Create D1 migrations for `org_connectors` and `org_secrets` tables
2. Create DB helpers and Drizzle schema
3. Create `services/connectors.ts` for connector CRUD

### Phase 3: MCP connector action source

1. Implement `McpConnectorActionSource` with tool discovery and execution
2. Add JSON Schema → Zod conversion utility (`json-schema-to-zod.ts`)
3. Add risk derivation logic (per-tool override → MCP annotations → connector default → `write`)
4. Add MCP JSON-RPC client with error handling

### Phase 4: Admin API and UI

1. Create `routes/connectors.ts` with admin CRUD endpoints
2. Add connector management UI to admin settings
3. Add tool browser UI showing discovered tools with risk levels
4. Add action catalog API endpoint (`GET /api/actions/catalog`) that lists all available actions

### Phase 5: Drift detection and monitoring

1. Add drift detection cron job (hourly)
2. Add connector health status tracking
3. Notify admins when tools change or connectors fail

## Files to Create

| File | Purpose |
|---|---|
| `packages/worker/src/actions/packages.ts` | Manifest of installed action packages |
| `packages/worker/src/actions/registry.ts` | `UnifiedActionRegistry` — merges packages + connectors |
| `packages/worker/src/actions/mcp-connector.ts` | `McpConnectorActionSource` implementation |
| `packages/worker/src/actions/mcp-client.ts` | MCP JSON-RPC client |
| `packages/worker/src/actions/json-schema-to-zod.ts` | JSON Schema → Zod conversion |
| `packages/worker/src/services/connectors.ts` | Connector CRUD service |
| `packages/worker/src/routes/connectors.ts` | Connector admin API routes |
| `packages/worker/src/lib/db/connectors.ts` | Connector DB helpers |
| `packages/worker/src/lib/schema/connectors.ts` | Drizzle schema for connectors/secrets |
| `packages/worker/migrations/NNNN_org_connectors.sql` | D1 migration |
| `packages/worker/migrations/NNNN_org_secrets.sql` | D1 migration |

## Files to Modify

| File | Change |
|---|---|
| `packages/worker/src/services/actions.ts` | Use `UnifiedActionRegistry` for action resolution |
| `packages/worker/src/index.ts` | Mount connector routes, add drift detection to cron |
| `packages/worker/src/routes/admin.ts` | Link to connector management routes |
| `packages/shared/src/types/index.ts` | Add `OrgConnector`, `OrgSecret` types |

## Relationship to Other Beans

- **valet-cp7w (Control Plane / Execution Plane Split)** — Prerequisite. Defines `@valet/action-sdk` (the contract) and creates the core action packages (`actions-github`, `actions-gmail`, `actions-google-calendar`). This bean loads and registers them.
- **valet-pg9a (Policy-Gated Actions)** — Prerequisite. The `invokeAction()` service is the execution engine. This bean provides the registry that `invokeAction()` uses to find action sources and definitions.
- **valet-tk3n (Unified Credential Boundary)** — Used by `McpConnectorActionSource` to resolve connector secrets via `getCredential()`.
- **valet-cf0x (Decouple from Cloudflare)** — On a Node/Bun runtime, the package manifest could be dynamic (read from config/DB) instead of static imports, enabling runtime package installation without redeployment.
- **valet-ch4t (Pluggable Channel Transports)** — Channel packages that include an `actionPackage` property (e.g., `@valet/channel-telegram` with `telegram.pin_message`, `telegram.create_poll`) get their actions registered in the `UnifiedActionRegistry` alongside regular action packages and MCP connectors. The registry treats channel action packages identically to standalone action packages.

## Open Questions

1. **MCP transport.** The design assumes HTTP-based MCP servers (JSON-RPC over HTTP POST). MCP also supports stdio and SSE transports. For org-deployed servers, HTTP is the most natural. stdio is mainly for local development. SSE could be useful for long-running tools.

2. **Tool caching.** `listActions()` on MCP connectors makes a network call. Recommendation: cache in D1 with drift detection on a cron schedule (e.g., hourly). The agent gets fast reads; the cron catches stale tools.

3. **Connector auth flexibility.** The design supports `Bearer` token and custom headers. Some MCP servers might need OAuth2 or mTLS. Start simple, extend later.

4. **JSON Schema → Zod conversion completeness.** MCP tools define input schemas as JSON Schema. Start with the subset that covers most tools: object, string, number, boolean, array, enum, required. Complex features (oneOf, allOf, $ref) can be added as needed.

5. **Connector sandboxing.** An MCP server could return malicious content (prompt injection in tool descriptions, very large responses). Mitigations: truncate responses to a max size, sanitize tool descriptions, rate-limit per connector.

6. **Package config persistence.** Action packages accept a `config` object via `createActionSource(config)`. Where does this config come from? Options: environment variables, D1 table, or the action package manifest. For core packages, env vars are simplest. For extended packages, a `package_configs` D1 table keyed by `(orgId, packageName)`.

7. **Runtime package loading on CF Workers.** CF Workers can't dynamically import packages. The manifest is static. For orgs that need dynamic package loading (install via UI without redeployment), the Node/Bun runtime path (bean cf0x) would be required. Is this acceptable for V1?

## Acceptance Criteria

- [ ] `packages/worker/src/actions/packages.ts` manifest loads core action packages
- [ ] `UnifiedActionRegistry` merges package sources + MCP connector sources
- [ ] `McpConnectorActionSource` discovers tools from MCP HTTP servers
- [ ] `org_connectors` and `org_secrets` D1 tables exist with migrations
- [ ] Admin API routes for connector CRUD and testing
- [ ] Connector auth supports Bearer token and custom headers
- [ ] Risk derivation for MCP tools: per-tool override → MCP annotations → connector default → `write`
- [ ] JSON Schema → Zod conversion for MCP tool input schemas
- [ ] Tool drift detection runs on cron and updates stored tool hash
- [ ] Action service uses `UnifiedActionRegistry` for action resolution
- [ ] Agent sees both package and connector actions via `run_action` tool
- [ ] Adding a new action package requires only: `pnpm add`, import in manifest, redeploy
- [ ] `pnpm typecheck` passes
