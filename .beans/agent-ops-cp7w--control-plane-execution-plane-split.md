---
# valet-cp7w
title: Control Plane / Execution Plane Split
status: todo
type: epic
priority: high
tags:
    - integrations
    - architecture
    - refactor
created_at: 2026-02-24T00:00:00Z
updated_at: 2026-02-24T00:00:00Z
---

Decompose the monolithic `BaseIntegration` class into three distinct concerns: a **control plane** (connection management + credential references), a **trigger plane** (inbound event processing), and an **action plane** (outbound operations packaged as standalone npm modules). Currently a single 800-line integration class (e.g., `gmail.ts`) handles all three. The target architecture separates "is this service connected?" from "something happened on that service" from "do something on that service" — each with its own interface, registration, and lifecycle.

The action plane is the biggest shift: outbound operations move from methods on a god-class into **standalone npm packages** (`@valet/actions-github`, `@valet/actions-gmail`, etc.) that implement a shared `ActionSource` contract defined by `@valet/action-sdk`. Core integrations ship as packages that are installed by default. Extended functionality (Jira, Linear, Salesforce) ships as additional packages. This means the same architecture that supports built-in integrations also supports third-party and community extensions.

## Problem

The `BaseIntegration` abstract class (`packages/worker/src/integrations/base.ts`) bundles six unrelated responsibilities into one interface:

```typescript
abstract class BaseIntegration {
  // Control plane: "is this connected?"
  abstract validateCredentials(): boolean;
  abstract testConnection(): Promise<boolean>;
  getOAuthUrl?(): string;
  exchangeOAuthCode?(): Promise<IntegrationCredentials>;
  refreshOAuthTokens?(): Promise<IntegrationCredentials>;

  // Trigger plane: "something happened externally"
  abstract handleWebhook(event: string, payload: unknown): Promise<void>;

  // Action plane: "do something externally"
  abstract fetchEntity(entityType: string, id: string): Promise<unknown>;
  abstract pushEntity(entityType: string, data: unknown): Promise<string>;

  // Sync: hybrid of all three
  abstract sync(options: SyncOptions): Promise<SyncResult>;
}
```

### Why this is a problem

1. **God-class integration files.** `gmail.ts` is 765 lines. `google-calendar.ts` is 758 lines. They handle OAuth token refresh, email sending, calendar CRUD, and webhook stubs all in one file. Adding a new capability (e.g., Gmail label sync) means editing a file that also handles email composition.

2. **Webhook handling is a stub.** `GitHubIntegration.handleWebhook()` logs and returns. `GmailIntegration.handleWebhook()` logs and returns. The real webhook handling happens elsewhere (`services/webhooks.ts`), making the `BaseIntegration.handleWebhook()` method a dead abstraction that every integration must implement but never uses.

3. **`sync()` conflates data retrieval with data storage.** The current sync implementations (e.g., `github.ts:sync()`) fetch data from the external API and count records, but never persist to the `synced_entities` table. The abstraction promises sync but doesn't deliver it, because sync is a coordination concern (when to run, where to store, how to page) — not a per-integration concern.

4. **Untyped entity operations.** `fetchEntity(entityType: string, id: string): Promise<unknown>` and `pushEntity(entityType: string, data: unknown): Promise<string>` are stringly-typed and return `unknown`. Every caller must cast. There's no way to know what entity types an integration supports without reading the implementation.

5. **Credentials baked into the instance.** `setCredentials()` mutates instance state. The integration class is both a credential holder and an operation executor. This prevents credential resolution from being centralized (see token boundary bean).

6. **Cannot add capabilities independently.** Want to add "create GitHub issue from session"? Must go through `GitHubIntegration.pushEntity()`. Want to add "react to PR review comment"? Must add to `GitHubIntegration.handleWebhook()`. Both changes touch the same class even though they're unrelated.

7. **No extensibility path.** An organization that uses an internal tool or a service we don't support (Jira, Linear, Salesforce) has no way to add it without forking valet and modifying the core integration code. The class-based architecture is closed to extension.

## Current Architecture

### Integration Registry

```
IntegrationRegistry (Map<service, factory>)
  → GitHubIntegration (validates, tests, syncs, fetches, pushes, handles webhooks)
  → GmailIntegration (validates, tests, syncs, fetches, pushes, handles webhooks)
  → GoogleCalendarIntegration (validates, tests, syncs, fetches, pushes, handles webhooks)
```

### How integrations are consumed

**Configuration flow** (`services/integrations.ts:configureIntegration()`):
```
1. integrationRegistry.get(service) → new GitHubIntegration()
2. handler.setCredentials(credentials)
3. handler.validateCredentials() → true/false
4. handler.testConnection() → true/false
5. Store credentials via credential boundary (bean tk3n)
6. Create integration row in D1
```

Only uses control plane methods. The sync/fetch/push/webhook methods are unused.

**Sync flow** (`services/integrations.ts:triggerIntegrationSync()`):
```
1. integrationRegistry.get(service) → new GitHubIntegration()
2. handler.setCredentials(credentials)
3. handler.sync(options) → SyncResult
```

Only uses the sync method. Could be a standalone function.

**Entity operations** (no callers yet):
`fetchEntity()` and `pushEntity()` are defined but never called from routes or services. They exist in anticipation of future use.

**Webhook handling** (not used via BaseIntegration):
Real webhook handling goes through `services/webhooks.ts` → `handlePullRequestWebhook()` / `handlePushWebhook()`. These don't use `BaseIntegration.handleWebhook()` at all.

## Design

### Three Separate Concern Layers

#### 1. Integration Control Plane (`services/integration-control.ts`)

Manages connection lifecycle. Knows how to connect, disconnect, test, and refresh credentials. Does NOT execute external operations.

```typescript
export interface IntegrationProvider {
  readonly service: string;
  readonly displayName: string;
  readonly authType: 'oauth2' | 'api_key' | 'bot_token';

  /** Validate that credentials have the required shape */
  validateCredentials(credentials: Record<string, string>): boolean;

  /** Test that credentials actually work (makes one API call) */
  testConnection(credentials: Record<string, string>): Promise<boolean>;

  /** OAuth methods (only for oauth2 authType) */
  oauth?: {
    getAuthUrl(redirectUri: string, state: string): string;
    exchangeCode(code: string, redirectUri: string): Promise<Record<string, string>>;
    refreshTokens(refreshToken: string): Promise<Record<string, string>>;
    scopes: string[];
  };
}
```

Key difference from `BaseIntegration`: credentials are **passed as arguments**, not set as instance state. The provider is stateless.

```typescript
// Registry becomes a simple map of providers
export const integrationProviders = new Map<string, IntegrationProvider>();

// Registration
integrationProviders.set('github', {
  service: 'github',
  displayName: 'GitHub',
  authType: 'oauth2',
  validateCredentials: (creds) => !!creds.access_token || !!creds.token,
  testConnection: async (creds) => {
    const res = await fetch('https://api.github.com/user', {
      headers: { Authorization: `Bearer ${creds.access_token || creds.token}` },
    });
    return res.ok;
  },
  oauth: { /* ... */ },
});
```

#### 2. Trigger Handlers (per-provider, standalone)

Webhook/event handlers are standalone functions, not methods on an integration class. They receive resolved credentials via the credential boundary (bean tk3n).

```typescript
// packages/worker/src/triggers/github.ts
export async function handleGitHubPullRequest(env: Env, payload: GitHubPRPayload): Promise<void>;
export async function handleGitHubPush(env: Env, payload: GitHubPushPayload): Promise<void>;
export async function handleGitHubIssueComment(env: Env, payload: GitHubCommentPayload): Promise<void>;

// packages/worker/src/triggers/telegram.ts
export async function handleTelegramMessage(env: Env, userId: string, update: TelegramUpdate): Promise<void>;
export async function handleTelegramCommand(env: Env, userId: string, command: string, args: string): Promise<void>;
```

This is essentially what we already have in `services/webhooks.ts` and `services/telegram.ts`, just reorganized and decoupled from the `BaseIntegration` class.

#### 3. Action Packages (standalone npm modules)

This is the key architectural shift. Outbound operations are **not** defined as files inside the gateway. They are standalone npm packages that implement the `ActionSource` contract from `@valet/action-sdk`.

```
packages/
├── action-sdk/                    # NEW: contract package
│   ├── package.json               # @valet/action-sdk
│   └── src/
│       └── index.ts               # ActionPackage, ActionSource, ActionDefinition, ActionContext, RiskLevel
├── actions-github/                # NEW: core action package
│   ├── package.json               # @valet/actions-github
│   └── src/
│       ├── index.ts               # exports ActionPackage
│       ├── source.ts              # GithubActionSource implements ActionSource
│       └── actions/
│           ├── issues.ts          # create_issue, list_issues, add_comment
│           ├── pulls.ts           # create_pr, merge_pr, request_review
│           └── repos.ts           # list_repos, get_repo
├── actions-gmail/                 # NEW: core action package
│   ├── package.json               # @valet/actions-gmail
│   └── src/
│       ├── index.ts
│       ├── source.ts
│       └── actions/
│           ├── messages.ts        # send_email, reply, forward
│           ├── drafts.ts          # create_draft, update_draft
│           └── labels.ts          # add_label, remove_label
├── actions-google-calendar/       # NEW: core action package
│   ├── package.json               # @valet/actions-google-calendar
│   └── src/
│       ├── index.ts
│       ├── source.ts
│       └── actions/
│           ├── events.ts          # create_event, update_event, delete_event
│           └── calendars.ts       # list_calendars, free_busy
```

**The SDK contract (`@valet/action-sdk`):**

```typescript
// packages/action-sdk/src/index.ts

import type { z } from 'zod';

export type RiskLevel = 'read' | 'write' | 'danger';

export interface ActionDefinition {
  id: string;                    // e.g., 'github.create_issue'
  name: string;
  description: string;
  risk: RiskLevel;
  params: z.ZodSchema;
}

export interface ActionContext {
  token: string;
  userId: string;
  orgId?: string;
  sessionId?: string;
  metadata?: Record<string, unknown>;
}

export interface ActionResult {
  data: unknown;
  executed: boolean;
}

export interface ActionSource {
  readonly sourceId: string;

  /** Discover available actions */
  listActions(): Promise<ActionDefinition[]>;

  /** Execute a specific action */
  execute(actionId: string, params: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult>;
}

export interface ActionPackage {
  /** Package name (e.g., 'github', 'jira') */
  name: string;
  /** Package version */
  version: string;
  /** Factory: create an ActionSource, optionally with config */
  createActionSource(config?: Record<string, unknown>): ActionSource;
}
```

**A core action package (`@valet/actions-github`):**

```typescript
// packages/actions-github/src/index.ts
import type { ActionPackage } from '@valet/action-sdk';
import { GithubActionSource } from './source.js';

export default {
  name: 'github',
  version: '1.0.0',
  createActionSource: (config) => new GithubActionSource(config),
} satisfies ActionPackage;
```

```typescript
// packages/actions-github/src/source.ts
import type { ActionSource, ActionDefinition, ActionContext, ActionResult } from '@valet/action-sdk';
import { issueActions } from './actions/issues.js';
import { pullActions } from './actions/pulls.js';

export class GithubActionSource implements ActionSource {
  readonly sourceId = 'github';
  private allActions: ActionDefinition[];

  constructor(config?: Record<string, unknown>) {
    this.allActions = [...Object.values(issueActions), ...Object.values(pullActions)];
  }

  async listActions(): Promise<ActionDefinition[]> {
    return this.allActions;
  }

  async execute(actionId: string, params: Record<string, unknown>, ctx: ActionContext): Promise<ActionResult> {
    // Dispatch to the right action's execute function
    // ...
  }
}
```

```typescript
// packages/actions-github/src/actions/issues.ts
import { z } from 'zod';
import type { ActionDefinition, ActionContext } from '@valet/action-sdk';

export const issueActions = {
  createIssue: {
    id: 'github.create_issue',
    name: 'Create GitHub Issue',
    description: 'Create a new issue in a GitHub repository',
    risk: 'write' as const,
    params: z.object({
      owner: z.string(),
      repo: z.string(),
      title: z.string(),
      body: z.string().optional(),
      labels: z.array(z.string()).optional(),
    }),
    execute: async (params: any, ctx: ActionContext) => {
      const res = await fetch(`https://api.github.com/repos/${params.owner}/${params.repo}/issues`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: params.title, body: params.body, labels: params.labels }),
      });
      return res.json();
    },
  },
  listIssues: {
    id: 'github.list_issues',
    name: 'List GitHub Issues',
    description: 'List issues in a repository',
    risk: 'read' as const,
    params: z.object({ owner: z.string(), repo: z.string(), state: z.enum(['open', 'closed', 'all']).optional() }),
    execute: async (params: any, ctx: ActionContext) => {
      const res = await fetch(`https://api.github.com/repos/${params.owner}/${params.repo}/issues?state=${params.state || 'open'}`, {
        headers: { Authorization: `Bearer ${ctx.token}` },
      });
      return res.json();
    },
  },
} satisfies Record<string, ActionDefinition & { execute: Function }>;
```

**Why packages instead of directories:**

- Core integrations (GitHub, Gmail, GCal) are packages that ship with valet — installed by default.
- Extended integrations (Jira, Linear, Salesforce) are additional packages — `npm install @valet/actions-jira`.
- Community/org-specific integrations follow the same pattern — `npm install @myorg/actions-internal-deploy`.
- The gateway loads whatever's installed. No code changes needed to add a new integration.
- Each package has its own `package.json`, dependencies, version, and tests. Gmail changes don't affect GitHub.

### What Happens to `BaseIntegration`

It gets deleted. Its responsibilities are absorbed:

| Old Method | New Home |
|---|---|
| `validateCredentials()` | `IntegrationProvider.validateCredentials()` in gateway |
| `testConnection()` | `IntegrationProvider.testConnection()` in gateway |
| `getOAuthUrl()`, `exchangeOAuthCode()`, `refreshOAuthTokens()` | `IntegrationProvider.oauth.*` in gateway |
| `handleWebhook()` | `triggers/{provider}.ts` standalone functions in gateway |
| `fetchEntity()`, `pushEntity()` | Typed actions in `@valet/actions-{provider}` packages |
| `sync()` | Standalone sync functions in `services/sync/{provider}.ts` (if sync is still needed) |
| `successResult()`, `failedResult()`, `syncError()` | Utility functions in `services/sync/utils.ts` |

### What Happens to `IntegrationRegistry`

Replaced by two registries:

```typescript
// Control plane — lives in gateway
export const integrationProviders = new Map<string, IntegrationProvider>();

// Trigger handlers — lives in gateway
export const triggerHandlers = new Map<string, TriggerHandler>();

// Action sources — loaded from installed packages (see bean pa5m)
// No static registry needed; the UnifiedActionRegistry discovers packages at startup
```

## Migration Plan

### Phase 1: Create `@valet/action-sdk`

1. Create `packages/action-sdk/` with `ActionPackage`, `ActionSource`, `ActionDefinition`, `ActionContext`, `RiskLevel` types
2. This is a pure types package — no runtime dependencies, ~50 lines
3. Publish to workspace so other packages can depend on it

### Phase 2: Extract `IntegrationProvider` from existing classes

1. Create `IntegrationProvider` interface and provider registrations by extracting `validateCredentials()`, `testConnection()`, and OAuth methods from existing integration classes
2. The old classes still exist — the new providers call through to them initially as a bridge
3. Update `services/integrations.ts:configureIntegration()` to use `integrationProviders.get()`

### Phase 3: Extract trigger handlers

Move the webhook handling logic from `services/webhooks.ts` (already standalone functions) into `triggers/github.ts`, `triggers/telegram.ts`. These are just file moves + re-exports, since the real handlers are already not using `BaseIntegration.handleWebhook()`.

### Phase 4: Create core action packages

Extract outbound operations from the old integration classes into standalone packages:

1. `packages/actions-github/` — extract from `integrations/github.ts` `fetchEntity`/`pushEntity` logic
2. `packages/actions-gmail/` — extract from `integrations/gmail.ts` email/draft/label operations
3. `packages/actions-google-calendar/` — extract from `integrations/google-calendar.ts` event/calendar operations

Each package depends on `@valet/action-sdk` and exports an `ActionPackage`. Action definitions get Zod schemas and risk levels.

### Phase 5: Remove bridge code and delete `BaseIntegration`

Once all three planes are populated and all consumers are migrated:
1. Delete `packages/worker/src/integrations/base.ts`
2. Delete `packages/worker/src/integrations/github.ts`
3. Delete `packages/worker/src/integrations/gmail.ts`
4. Delete `packages/worker/src/integrations/google-calendar.ts`
5. Delete `integrationRegistry` singleton

### Phase 6: Update routes and services

- `routes/integrations.ts` uses `integrationProviders` for connection management
- `services/integrations.ts` uses `integrationProviders` for configure/disconnect
- `services/webhook-inbox.ts` (from bean wh8d) dispatches to trigger handlers
- Action loading and registration handled by `UnifiedActionRegistry` (bean pa5m)

## Directory Structure After

```
packages/
├── action-sdk/                    # NEW: contract package (@valet/action-sdk)
│   ├── package.json
│   └── src/index.ts               # ActionPackage, ActionSource, ActionDefinition, etc.
├── actions-github/                # NEW: core action package (@valet/actions-github)
│   ├── package.json
│   └── src/
├── actions-gmail/                 # NEW: core action package (@valet/actions-gmail)
│   ├── package.json
│   └── src/
├── actions-google-calendar/       # NEW: core action package
│   ├── package.json
│   └── src/
├── worker/src/
│   ├── integrations/              # DELETE (old monolithic classes)
│   ├── providers/                 # NEW: control plane provider definitions
│   │   ├── registry.ts
│   │   ├── github.ts
│   │   ├── gmail.ts
│   │   └── google-calendar.ts
│   ├── triggers/                  # NEW: inbound event handlers
│   │   ├── github.ts
│   │   ├── telegram.ts
│   │   └── generic.ts
│   └── services/
│       ├── integration-control.ts # configure, disconnect, test (uses providers/)
│       ├── webhook-inbox.ts       # from bean wh8d (uses triggers/)
│       └── credentials.ts         # from bean tk3n
```

## Relationship to Other Beans

- **valet-tk3n (Unified Credential Boundary)** — Prerequisite. Providers call `testConnection(credentials)` with credentials passed in. Action execution calls `getCredential()` to resolve credentials into the `ActionContext`. The control plane never stores or manages credentials directly.
- **valet-wh8d (Durable Webhook Inbox)** — The inbox's `processInboxRow()` dispatches to trigger handlers defined in this bean's `triggers/` directory.
- **valet-pg9a (Policy-Gated Actions)** — The policy gate consumes action definitions from installed packages. The risk level declared in each action definition drives the policy cascade.
- **valet-pa5m (Polymorphic Action Sources)** — The `ActionSource` interface and `ActionPackage` contract defined here (via `action-sdk`) are the foundation for pa5m's `UnifiedActionRegistry`, which discovers installed packages and MCP connectors. pa5m owns the loading and registry; this bean owns the contract and the core packages.
- **valet-ch4t (Pluggable Channel Transports)** — Channel packages (Telegram, Slack, etc.) can bundle an `IntegrationProvider` for connection setup and an `ActionPackage` for platform-specific agent actions. Both use the contracts defined in this bean. Telegram's connection management moves from the gateway into `@valet/channel-telegram`'s provider.

## Open Questions

1. **Keep sync?** The current sync framework fetches data but doesn't persist it (`synced_entities` table is empty). Is sync still a requirement, or should we drop it in favor of on-demand entity fetching via actions? If sync is needed, it becomes a scheduled action (cron-triggered) rather than a method on an integration class.

2. **Provider file size.** Each action package handles its own code organization. Large providers like Gmail can split across `actions/messages.ts`, `actions/drafts.ts`, `actions/labels.ts`. This is a per-package decision, not a gateway concern.

3. **Telegram as an integration?** Resolved: Telegram is a **channel** (bidirectional messaging), not a standard integration. It lives in `@valet/channel-telegram` (see bean ch4t). The channel package bundles an `IntegrationProvider` for bot token setup and an `ActionPackage` for explicit agent actions (pin message, create poll). The bidirectional messaging path goes through the `ChannelTransport` contract, not the action system.

4. **Action package versioning.** When a core action package gets a breaking change, how does that interact with the gateway? Since they're in the same monorepo and installed via workspace dependencies, versioning is implicit. But for third-party packages, we need semver compatibility guarantees on the `action-sdk` contract.

## Acceptance Criteria

- [ ] `packages/action-sdk/` exists with `ActionPackage`, `ActionSource`, `ActionDefinition`, `ActionContext`, `RiskLevel` exports
- [ ] `packages/actions-github/` exists as a standalone package implementing `ActionPackage`
- [ ] `packages/actions-gmail/` exists as a standalone package implementing `ActionPackage`
- [ ] `packages/actions-google-calendar/` exists as a standalone package implementing `ActionPackage`
- [ ] Each action package has typed action definitions with Zod schemas and risk levels
- [ ] `IntegrationProvider` interface defined with stateless `validateCredentials()` and `testConnection()`
- [ ] GitHub, Gmail, Google Calendar providers registered in `providers/registry.ts`
- [ ] `services/integrations.ts:configureIntegration()` uses `IntegrationProvider` instead of `BaseIntegration`
- [ ] Trigger handlers in `triggers/` directory (GitHub PR, push; Telegram message, command)
- [ ] `BaseIntegration` class deleted along with `IntegrationRegistry`
- [ ] Old integration files (`integrations/github.ts`, etc.) deleted
- [ ] `routes/integrations.ts` GET `/available` endpoint uses provider registry
- [ ] No `BaseIntegration` import anywhere in the codebase
- [ ] `pnpm typecheck` passes
