# Remote Workflow Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Serve the 22 baked workflow/trigger/execution/proposal OpenCode tools as worker-side actions via the existing `list_tools`/`call_tool` path, then delete the baked shims.

**Architecture:** Introduce a credential-less "internal provider" in the action framework that receives a `{ db, env }` handle. A new `workflows` action package delegates each action to the existing `workflowService.*` / `triggerService.*` functions (no logic reimplemented). The `call_tool` dispatch already centralizes risk policy, approval, and audit; we just register a new service and re-enforce the workflow-session guard.

**Tech Stack:** TypeScript, Hono, Drizzle/D1, Zod, vitest, OpenCode plugin tools, Modal image.

Design spec: `docs/specs/2026-05-27-remote-workflow-tools-design.md`

---

## Reference facts (verified against current code)

- `ActionContext`, `ActionSource`, `IntegrationProvider`, `IntegrationPackage`: `packages/sdk/src/integrations/index.ts`.
- `IntegrationProvider.authType` already includes `'none'`.
- `executeAction(appDb, env, userId, toolId, service, actionId, params, actionSource, invocationId, opts)`: `packages/worker/src/services/session-tools.ts:425`. It already special-cases `provider?.authType === 'none'` (line 446) and calls `actionSource.execute(actionId, params, ctx)` at two sites (lines 486 and 506).
- `listTools(...)`: `session-tools.ts:136`. A service is only listed if it appears in `serviceSourceMap`, built from user/org integrations plus `autoServices` (line ~169).
- `handleCallTool(requestId, toolId, params, summary)`: `packages/worker/src/durable-objects/session-agent.ts:6205`. `service`/`actionId` are derived from `toolId` before `executeActionAndSend` (line 6344).
- Workflow service fns: `packages/worker/src/services/workflows.ts` — `syncWorkflow(db, userId, params)` (51), `updateWorkflow(env, userId, id, body)` (175), `deleteWorkflow(db, userId, id)` (246), `createProposal` (271), `reviewProposal` (328), `applyProposal` (367), `rollbackWorkflow` (493), `getWorkflowHistoryWithSnapshot` (578).
- Trigger service fns: `packages/worker/src/services/triggers.ts` — `runWorkflowManually(...)` (54), `runTrigger(...)` (172).
- The 22 current tools live in `docker/opencode/tools/`. Each tool's Zod `args` and the exact worker call it proxies to are the source of truth for the corresponding `ActionDefinition.params` and `execute` branch. Tool → route mapping: read `packages/worker/src/routes/workflows.ts`, `routes/triggers.ts`, `routes/executions.ts` for the exact underlying call each route handler makes.
- Reference hand-written ActionSource (Zod params + riskLevel): `packages/plugin-github/src/actions/actions.ts`.
- Reference internal (`authType:'none'`) provider: `packages/plugin-deepwiki/src/actions/provider.ts`.

---

## Task 1: Add `internal` provider support to the SDK action contract

**Files:**
- Modify: `packages/sdk/src/integrations/index.ts`
- Test: `packages/sdk/src/integrations/internal-provider.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/sdk/src/integrations/internal-provider.test.ts
import { describe, it, expect } from 'vitest';
import type { IntegrationProvider, ActionContext } from './index.js';

describe('internal provider contract', () => {
  it('allows marking a provider internal', () => {
    const p: IntegrationProvider = {
      service: 'workflows',
      displayName: 'Workflows',
      authType: 'none',
      internal: true,
      supportedEntities: [],
      validateCredentials: () => true,
      testConnection: async () => true,
    };
    expect(p.internal).toBe(true);
  });

  it('ActionContext carries an optional internal handle', () => {
    const ctx: ActionContext = {
      credentials: {},
      userId: 'u1',
      internal: { db: {} as unknown, env: {} as unknown },
    };
    expect(ctx.internal).toBeDefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/sdk && pnpm vitest run src/integrations/internal-provider.test.ts`
Expected: FAIL — `internal` not assignable on `IntegrationProvider` / `ActionContext`.

- [ ] **Step 3: Add the fields**

In `packages/sdk/src/integrations/index.ts`, add to `IntegrationProvider` (after `mcpServerUrl?`):

```ts
  /** Worker-internal provider: no credentials; receives a worker-side data handle.
   *  Internal services are always listable and skip credential resolution. */
  readonly internal?: boolean;
```

Add to `ActionContext` (after `guardConfig?`). Keep it structurally typed so the SDK does not depend on worker types:

```ts
  /** Present only for internal providers. Opaque worker-side data handle
   *  ({ db, env }); cast to concrete types inside the worker action source. */
  internal?: { db: unknown; env: unknown };
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/sdk && pnpm vitest run src/integrations/internal-provider.test.ts`
Expected: PASS

- [ ] **Step 5: Typecheck + commit**

```bash
cd packages/sdk && pnpm typecheck
cd ../.. && git add packages/sdk/src/integrations/index.ts packages/sdk/src/integrations/internal-provider.test.ts
git commit -m "feat(sdk): add internal provider flag and ActionContext.internal handle"
```

---

## Task 2: Inject the internal handle in `executeAction`

**Files:**
- Modify: `packages/worker/src/services/session-tools.ts:486,506`
- Test: `packages/worker/src/services/session-tools.internal.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/worker/src/services/session-tools.internal.test.ts
import { describe, it, expect, vi } from 'vitest';
import { executeAction } from './session-tools.js';
import { integrationRegistry } from '../integrations/registry.js'; // adjust import to actual registry module

describe('executeAction internal provider', () => {
  it('passes internal { db, env } and skips credential resolution', async () => {
    const captured: { ctx?: any } = {};
    const fakeSource = {
      listActions: () => [],
      execute: async (_id: string, _p: unknown, ctx: any) => { captured.ctx = ctx; return { success: true, data: 'ok' }; },
    };
    vi.spyOn(integrationRegistry, 'getProvider').mockReturnValue({ service: 'workflows', authType: 'none', internal: true } as any);
    const resolveSpy = vi.spyOn(integrationRegistry, 'resolveCredentials');

    const appDb = { __db: true } as any;
    const env = { __env: true } as any;
    const res = await executeAction(appDb, env, 'u1', 'workflows:list_workflows', 'workflows', 'list_workflows', {}, fakeSource as any, 'inv1', {} as any);

    expect(res.success).toBe(true);
    expect(resolveSpy).not.toHaveBeenCalled();
    expect(captured.ctx.internal).toEqual({ db: appDb, env });
    expect(captured.ctx.credentials).toEqual({});
  });
});
```

NOTE: confirm the registry import path (`grep -rn "integrationRegistry" packages/worker/src/services/session-tools.ts`) and the `markFailed`/`markExecuted` DB calls don't throw on the fake `appDb` — if they do, stub them via `vi.mock` of their module.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/worker && pnpm vitest run src/services/session-tools.internal.test.ts`
Expected: FAIL — `captured.ctx.internal` is `undefined`.

- [ ] **Step 3: Add the internal handle at both execute sites**

In `session-tools.ts`, compute once before line 486:

```ts
  const internalHandle = provider?.internal ? { db: appDb, env } : undefined;
```

Change the first `.execute(...)` (line 486) ctx to include it:

```ts
  let actionResult = await actionSource.execute(actionId, params, { credentials, userId, attribution, callerIdentity, analytics: actionAnalytics, guardConfig: opts.guardConfig, internal: internalHandle });
```

Add the same `internal: internalHandle` key to the retry `.execute(...)` ctx (line 506). (The 401-retry branch is gated by `authType !== 'none'`, so internal providers never reach it, but keep the ctx shape consistent.)

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/worker && pnpm vitest run src/services/session-tools.internal.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/services/session-tools.ts packages/worker/src/services/session-tools.internal.test.ts
git commit -m "feat(worker): inject internal {db,env} handle for internal action providers"
```

---

## Task 3: Always-list internal providers in `listTools`

**Files:**
- Modify: `packages/worker/src/services/session-tools.ts` (the `serviceSourceMap` build, after the autoServices injection ~line 169)
- Test: `packages/worker/src/services/session-tools.listinternal.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// packages/worker/src/services/session-tools.listinternal.test.ts
import { describe, it, expect, vi } from 'vitest';
import { listTools } from './session-tools.js';
import { integrationRegistry } from '../integrations/registry.js'; // adjust path

describe('listTools internal providers', () => {
  it('lists an internal service with no connected integration', async () => {
    // Stub registry: workflows is internal with one action.
    vi.spyOn(integrationRegistry, 'listServices' as any).mockReturnValue(['workflows']); // adjust to real enumeration API
    vi.spyOn(integrationRegistry, 'getProvider').mockImplementation((s: string) =>
      s === 'workflows' ? ({ service: 'workflows', authType: 'none', internal: true } as any) : undefined);
    vi.spyOn(integrationRegistry, 'getActions').mockImplementation((s: string) =>
      s === 'workflows' ? ({ listActions: () => [{ id: 'list_workflows', name: 'List', description: '', riskLevel: 'low', params: { } }], execute: async () => ({ success: true }) } as any) : undefined);

    const appDb = {} as any; const env = {} as any; const d1 = {} as any;
    const result = await listTools(appDb, d1, env, 'u1', { service: 'workflows' } as any);
    expect(result.tools.some(t => t.id === 'workflows:list_workflows')).toBe(true);
  });
});
```

NOTE: `listTools` makes several DB reads at the top (`getUserIntegrations`, `getOrgIntegrations`, `getAutoEnabledServices`, `getDisabledActionsIndex`, `getDisabledPluginServices`). Stub those modules with `vi.mock` to return empty arrays/sets so the fake `appDb`/`d1` don't error. Inspect lines 136–200 to get exact module paths.

- [ ] **Step 2: Run test to verify it fails**

Run: `cd packages/worker && pnpm vitest run src/services/session-tools.listinternal.test.ts`
Expected: FAIL — `workflows` not in `serviceSourceMap`, no tool listed.

- [ ] **Step 3: Inject internal providers into `serviceSourceMap`**

Immediately after the `autoServices` injection loop (the `for (const svc of autoServices)` block ~line 169), add:

```ts
  // Inject internal providers (workflows, etc.) — always listable, no credentials.
  for (const svc of integrationRegistry.listServices()) {
    const prov = integrationRegistry.getProvider(svc);
    if (prov?.internal && !serviceSourceMap.has(svc)) {
      serviceSourceMap.set(svc, [{ id: `internal:${svc}`, scope: 'user' as const, userId }]);
    }
  }
```

If the registry has no `listServices()` enumeration, add one to the registry module that returns all registered service ids (check `packages/worker/src/integrations/registry.ts` or equivalent — `grep -rn "getProvider\|getActions\|installedIntegrations" packages/worker/src/integrations/`). Implement `listServices()` to return the keys of the registry's internal service map.

- [ ] **Step 4: Run test to verify it passes**

Run: `cd packages/worker && pnpm vitest run src/services/session-tools.listinternal.test.ts`
Expected: PASS

- [ ] **Step 5: Commit**

```bash
git add packages/worker/src/services/session-tools.ts packages/worker/src/services/session-tools.listinternal.test.ts packages/worker/src/integrations/registry.ts
git commit -m "feat(worker): always list internal action providers in list_tools"
```

---

## Task 4: Scaffold the `workflows` action code package

**Files:**
- Create: `packages/plugin-workflows/package.json` (or extend if it exists)
- Create: `packages/plugin-workflows/tsconfig.json`
- Modify: root `tsconfig.json` (add reference), `packages/worker/package.json` (add dep), `packages/worker/tsconfig.json` (add reference)

- [ ] **Step 1: Inspect the existing content-only package**

Run: `cat packages/plugin-workflows/plugin.yaml; ls packages/plugin-workflows`
Confirm whether `package.json`/`tsconfig.json` already exist (content-only plugins may lack them). Mirror a code plugin: `cat packages/plugin-github/package.json packages/plugin-github/tsconfig.json`.

- [ ] **Step 2: Create `package.json`**

```json
{
  "name": "@valet/plugin-workflows",
  "version": "0.0.1",
  "type": "module",
  "exports": {
    "./actions": "./src/actions/index.ts"
  },
  "dependencies": {
    "@valet/sdk": "workspace:*",
    "zod": "^3.23.0"
  }
}
```

(Match `zod` version and any `devDependencies`/`scripts` from `plugin-github/package.json`.)

- [ ] **Step 3: Create `tsconfig.json`**

Copy `packages/plugin-github/tsconfig.json` verbatim (it extends the root config).

- [ ] **Step 4: Wire references**

- Add `"@valet/plugin-workflows": "workspace:*"` to `packages/worker/package.json` dependencies.
- Add a project reference to `packages/plugin-workflows` in root `tsconfig.json` and `packages/worker/tsconfig.json` (match how `plugin-github` is referenced).

- [ ] **Step 5: Install + commit**

```bash
pnpm install
git add packages/plugin-workflows/package.json packages/plugin-workflows/tsconfig.json package.json packages/worker/package.json packages/worker/tsconfig.json pnpm-lock.yaml
git commit -m "chore(plugin-workflows): scaffold code capability (actions export)"
```

---

## Task 5: Implement the internal provider

**Files:**
- Create: `packages/plugin-workflows/src/actions/provider.ts`

- [ ] **Step 1: Write the provider** (mirrors `plugin-deepwiki/src/actions/provider.ts`, plus `internal: true`)

```ts
// packages/plugin-workflows/src/actions/provider.ts
import type { IntegrationProvider, IntegrationCredentials } from '@valet/sdk';

export const workflowsProvider: IntegrationProvider = {
  service: 'workflows',
  displayName: 'Workflows',
  authType: 'none',
  internal: true,
  supportedEntities: ['workflows', 'triggers', 'executions'],
  oauthScopes: [],
  validateCredentials(_c: IntegrationCredentials): boolean { return true; },
  async testConnection(_c: IntegrationCredentials): Promise<boolean> { return true; },
};
```

- [ ] **Step 2: Typecheck + commit** (committed with Task 6, since `index.ts` needs both)

---

## Task 6: Implement the `workflows` ActionSource (22 actions)

**Files:**
- Create: `packages/plugin-workflows/src/actions/actions.ts`
- Create: `packages/plugin-workflows/src/actions/index.ts`
- Test: `packages/plugin-workflows/src/actions/actions.test.ts`

The `ActionContext.internal` handle is typed `{ db: unknown; env: unknown }` in the SDK. Define a local concrete type and cast once:

```ts
// top of actions.ts
import { z } from 'zod';
import type { ActionDefinition, ActionSource, ActionContext, ActionResult } from '@valet/sdk';
import type { AppDb } from '@valet/worker/...'; // if a worker type import is awkward, type as the structural shape the service fns need
import * as workflowService from '../../../worker/src/services/workflows.js'; // see NOTE below
import * as triggerService from '../../../worker/src/services/triggers.js';

type Internal = { db: AppDb; env: unknown };
function internalOf(ctx: ActionContext): Internal {
  if (!ctx.internal) throw new Error('workflows actions require an internal context');
  return ctx.internal as Internal;
}
```

NOTE on imports: the worker compiles plugin actions into itself, so importing `workflowService` directly couples the package to the worker source. If the worker package layout makes a cross-package import awkward, the cleaner option is to pass the service functions in via the `env`/`internal` handle, OR keep the action source in the worker tree. **Decide during Step 1 below** by checking how `plugin-github/src/actions` imports its API layer — github keeps its API self-contained, but workflows must call worker services. If a clean import isn't available, place `actions.ts` under `packages/worker/src/integrations/internal/workflows-actions.ts` and register it as an internal package directly in `packages/worker/src/integrations/packages.ts` (it is generated, so add the internal package in the generator or via a manual merge step — see Task 7). This keeps worker-service imports in-package.

- [ ] **Step 1: Decide source location** — run `sed -n '1,20p' packages/plugin-github/src/actions/index.ts packages/worker/src/integrations/packages.ts` and confirm whether a `plugin-*` package can import `@valet/worker` services. If not, use the worker-internal location noted above. Record the decision in a one-line comment at the top of the file.

- [ ] **Step 2: Write the failing test**

```ts
// actions.test.ts (co-located with chosen source location)
import { describe, it, expect } from 'vitest';
import { workflowsActions } from './actions.js';

describe('workflowsActions', () => {
  it('lists all 22 actions with risk tiers', () => {
    const defs = workflowsActions.listActions();
    const ids = defs.map(d => d.id).sort();
    expect(ids).toContain('sync_workflow');
    expect(ids).toContain('delete_workflow');
    expect(ids).toContain('sync_trigger');
    expect(defs.length).toBe(22);
    expect(defs.find(d => d.id === 'delete_workflow')!.riskLevel).toBe('medium');
    expect(defs.find(d => d.id === 'rollback_workflow')!.riskLevel).toBe('medium');
    expect(defs.find(d => d.id === 'delete_trigger')!.riskLevel).toBe('medium');
    expect(defs.find(d => d.id === 'list_workflows')!.riskLevel).toBe('low');
  });

  it('rejects unknown actionId', async () => {
    const res = await workflowsActions.execute('nope', {}, { credentials: {}, userId: 'u', internal: { db: {}, env: {} } } as any);
    expect(res.success).toBe(false);
    expect(res.error).toMatch(/unknown/i);
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `pnpm vitest run <path>/actions.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 4: Implement `listActions()` with all 22 definitions**

Transcribe each current tool's Zod `args` into an `ActionDefinition.params`. Risk tiers from the spec table. Three fully-worked examples below; replicate the pattern for the rest, copying `params` from each tool file in `docker/opencode/tools/` (still present until Task 10).

```ts
const defs: ActionDefinition[] = [
  // ── reads ──
  { id: 'list_workflows', name: 'List workflows', description: 'List all workflows.', riskLevel: 'low',
    params: z.object({}) },
  { id: 'get_workflow', name: 'Get workflow', description: 'Get a workflow by id/slug.', riskLevel: 'low',
    params: z.object({ workflow_id: z.string() }) },
  // ── mutate ──
  { id: 'sync_workflow', name: 'Sync workflow', description: 'Create or upsert a workflow definition.', riskLevel: 'low',
    params: z.object({
      id: z.string().optional(), slug: z.string().optional(), name: z.string().min(1),
      description: z.string().optional(), version: z.string().optional(),
      data_json: z.string().optional(), workflow_json: z.string().optional(),
    }) },
  // ── destructive ──
  { id: 'delete_workflow', name: 'Delete workflow', description: 'Delete a workflow and its triggers.', riskLevel: 'medium',
    params: z.object({ workflow_id: z.string() }) },
  // ... remaining 18, copied from the matching docker/opencode/tools/*.ts args ...
];
export const ACTION_IDS = defs.map(d => d.id);
```

Complete id → service-call → risk map (mirror the route handler in `routes/{workflows,triggers,executions}.ts`):

| actionId | service call | risk |
|---|---|---|
| list_workflows | `listWorkflows(db, userId)` (see routes/workflows.ts GET /) | low |
| get_workflow | `getWorkflow(db, userId, id)` | low |
| list_workflow_history | `getWorkflowHistoryWithSnapshot(db, userId, id)` | low |
| sync_workflow | `syncWorkflow(db, userId, {id,slug,name,description,version,data})` | low |
| update_workflow | `updateWorkflow(env, userId, id, body)` | low |
| run_workflow | `runWorkflowManually(...)` (triggers.ts:54) | low |
| delete_workflow | `deleteWorkflow(db, userId, id)` | medium |
| rollback_workflow | `rollbackWorkflow(...)` (workflows.ts:493) | medium |
| create_workflow_proposal | `createProposal(...)` (271) | low |
| list_workflow_proposals | route GET proposals call | low |
| review_workflow_proposal | `reviewProposal(...)` (328) | low |
| apply_workflow_proposal | `applyProposal(...)` (367) | low |
| list_workflow_executions | route GET executions call | low |
| get_execution | route GET execution call | low |
| get_execution_steps | route GET execution steps call | low |
| debug_execution | route debug call | low |
| approve_execution | route approve call | low |
| cancel_execution | route cancel call | low |
| list_triggers | route GET triggers call | low |
| sync_trigger | trigger upsert call (routes/triggers.ts) | low |
| run_trigger | `runTrigger(...)` (triggers.ts:172) | low |
| delete_trigger | trigger delete call | medium |

`sync_workflow` must reproduce the route's body assembly: parse `data_json ?? workflow_json` into `data` and pass `{ id, slug, name, description, version, data }` to `syncWorkflow`. Do NOT re-validate step types here — `syncWorkflow` already calls `validateWorkflowDefinition`.

- [ ] **Step 5: Implement `execute()` dispatch**

```ts
export const workflowsActions: ActionSource = {
  listActions: () => defs,
  async execute(actionId, params, ctx): Promise<ActionResult> {
    const { db, env } = internalOf(ctx);
    const userId = ctx.userId;
    const p = params as Record<string, unknown>;
    try {
      switch (actionId) {
        case 'list_workflows':
          return { success: true, data: await workflowService.listWorkflows(db, userId) };
        case 'sync_workflow': {
          const raw = (p.data_json ?? p.workflow_json) as string | undefined;
          const data = raw ? JSON.parse(raw) : undefined;
          const r = await workflowService.syncWorkflow(db, userId, {
            id: p.id as string | undefined, slug: p.slug as string | undefined,
            name: p.name as string, description: p.description as string | undefined,
            version: p.version as string | undefined, data,
          } as any);
          return { success: true, data: r };
        }
        case 'delete_workflow':
          await workflowService.deleteWorkflow(db, userId, p.workflow_id as string);
          return { success: true, data: { deleted: true } };
        // ... remaining cases, each mirroring its route handler ...
        default:
          return { success: false, error: `Unknown workflows action "${actionId}".` };
      }
    } catch (e) {
      return { success: false, error: e instanceof Error ? e.message : String(e) };
    }
  },
};
```

For each remaining case, call the function named in the Task 6 table with the params the route handler uses. Validation/`ValidationError` messages thrown by services should be returned as `{ success: false, error: e.message }` (the catch block handles this).

- [ ] **Step 6: Create `index.ts`**

```ts
// packages/plugin-workflows/src/actions/index.ts  (or worker-internal equivalent)
import type { IntegrationPackage } from '@valet/sdk';
import { workflowsProvider } from './provider.js';
import { workflowsActions } from './actions.js';

const workflowsPackage: IntegrationPackage = {
  name: '@valet/plugin-workflows',
  version: '0.0.1',
  service: 'workflows',
  provider: workflowsProvider,
  actions: workflowsActions,
};
export default workflowsPackage;
```

- [ ] **Step 7: Run tests + typecheck**

Run: `pnpm vitest run <path>/actions.test.ts && cd packages/worker && pnpm typecheck`
Expected: PASS / clean.

- [ ] **Step 8: Commit**

```bash
git add packages/plugin-workflows/src packages/worker # whichever location was chosen
git commit -m "feat(workflows): worker-side ActionSource for all 22 workflow/trigger tools"
```

---

## Task 7: Register the package

**Files:**
- Modify: `packages/worker/src/integrations/packages.ts` (generated)

- [ ] **Step 1: Regenerate (if the package lives in `packages/plugin-workflows`)**

Run: `make generate-registries`
Then: `grep -n "plugin-workflows" packages/worker/src/integrations/packages.ts`
Expected: the package appears in `installedIntegrations`.

If the source lives worker-internal (Task 6 decision), instead add it to the generator (`scripts/generate-plugin-registry.ts`) or merge it into the generated array via the generator's "extra internal packages" hook. Confirm `make generate-registries` is idempotent and the internal package survives regeneration.

- [ ] **Step 2: Verify it lists end-to-end (integration-style test)**

Add/extend a test that constructs the registry and asserts `integrationRegistry.getActions('workflows')` is defined and `getProvider('workflows')?.internal === true`.

Run: `cd packages/worker && pnpm vitest run <that test>`
Expected: PASS

- [ ] **Step 3: Commit**

```bash
git add packages/worker/src/integrations/packages.ts scripts/generate-plugin-registry.ts
git commit -m "chore(worker): register internal workflows action package"
```

---

## Task 8: Re-enforce the workflow-session guard in `handleCallTool`

**Files:**
- Modify: `packages/worker/src/durable-objects/session-agent.ts` (`handleCallTool`, ~6205)
- Test: extend `packages/worker/src/durable-objects/session-agent.test.ts`

- [ ] **Step 1: Inspect** how the DO knows its session `purpose` and how `service`/`actionId` are derived from `toolId` (run `grep -n "purpose\|workflow'\|splitToolId\|service\b" packages/worker/src/durable-objects/session-agent.ts | head`). The baked guard message is in `docker/opencode/tools/_workflow_session_guard.ts` — reuse its wording.

- [ ] **Step 2: Write the failing test**

```ts
it('denies workflows:* tools inside a workflow-purpose session', async () => {
  // Arrange a DO whose session purpose === 'workflow' (mirror existing test setup).
  // Act: call handleCallTool with toolId 'workflows:sync_workflow'.
  // Assert: a 'call-tool-result' with an error mentioning workflow session is sent, executeAction is NOT reached.
});
```

Model the arrange/assert on existing `handleCallTool`/`call-tool-result` tests in the same file.

- [ ] **Step 3: Run test to verify it fails**

Run: `cd packages/worker && pnpm vitest run src/durable-objects/session-agent.test.ts -t "denies workflows"`
Expected: FAIL.

- [ ] **Step 4: Add the guard** near the top of `handleCallTool` (after `service` is derived):

```ts
    if (service === 'workflows' && this.<sessionPurposeField> === 'workflow') {
      this.runnerLink.send({ type: 'call-tool-result', requestId,
        error: 'Workflow tools are not available inside a workflow session.' } as any);
      return;
    }
```

Replace `<sessionPurposeField>` with the actual property/accessor found in Step 1.

- [ ] **Step 5: Run test to verify it passes**

Run: `cd packages/worker && pnpm vitest run src/durable-objects/session-agent.test.ts -t "denies workflows"`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add packages/worker/src/durable-objects/session-agent.ts packages/worker/src/durable-objects/session-agent.test.ts
git commit -m "feat(worker): deny workflows:* tools inside workflow sessions"
```

---

## Task 9: Update the workflows skill for remote discovery

**Files:**
- Modify: the workflows skill markdown in `packages/plugin-workflows/skills/`

- [ ] **Step 1: Locate the skill** — `ls packages/plugin-workflows/skills/ && grep -rln "sync_workflow" packages/plugin-workflows/skills/`

- [ ] **Step 2: Rewrite the tool-usage section** to:
  - Instruct `list_tools service=workflows` first, then `call_tool` with namespaced ids (`workflows:sync_workflow`, `workflows:run_workflow`, …).
  - Remove the prior claim that the named tools are directly callable.
  - Note that destructive ops (`delete_workflow`, `delete_trigger`, `rollback_workflow`) may require approval.
  - Keep all the conceptual content (step types, the 4 layers, execution context) unchanged.

- [ ] **Step 3: Resync content** — run `make generate-registries` (regenerates content-registry from skill files) and `cd packages/worker && pnpm typecheck`.

- [ ] **Step 4: Commit**

```bash
git add packages/plugin-workflows/skills packages/worker/src/plugins/content-registry.ts
git commit -m "docs(workflows): skill uses list_tools/call_tool for remote workflow tools"
```

---

## Task 10: Delete the baked tool files and bump the image

**Files:**
- Delete: 22 files in `docker/opencode/tools/` + `_workflow_session_guard.ts` (if unused elsewhere)
- Modify: `backend/images/base.py` (`IMAGE_BUILD_VERSION`)

- [ ] **Step 1: Confirm the guard file is unused elsewhere**

Run: `grep -rln "_workflow_session_guard" docker/opencode/tools/`
If only the 22 workflow tools reference it, it can be deleted too. If other tools use it, keep it.

- [ ] **Step 2: Delete the baked tools**

```bash
cd docker/opencode/tools
git rm sync_workflow.ts update_workflow.ts delete_workflow.ts get_workflow.ts list_workflows.ts \
  run_workflow.ts list_workflow_executions.ts list_workflow_history.ts rollback_workflow.ts \
  create_workflow_proposal.ts list_workflow_proposals.ts review_workflow_proposal.ts apply_workflow_proposal.ts \
  get_execution.ts get_execution_steps.ts debug_execution.ts approve_execution.ts cancel_execution.ts \
  sync_trigger.ts run_trigger.ts delete_trigger.ts list_triggers.ts
# and _workflow_session_guard.ts only if Step 1 cleared it
cd ../../..
```

- [ ] **Step 3: Bump the image version**

In `backend/images/base.py`, increment `IMAGE_BUILD_VERSION` (e.g. `2026-05-15-v29-opencode-1.15.0` → `2026-05-27-v30-remote-workflow-tools`).

- [ ] **Step 4: Verify nothing else imports the deleted files**

Run: `grep -rln "sync_workflow\|run_trigger\|workflow_session_guard" docker/opencode/ | grep -v skills`
Expected: no references (other than the skill, which now points at list_tools).

- [ ] **Step 5: Commit**

```bash
git add -A docker/opencode/tools backend/images/base.py
git commit -m "chore(sandbox): remove baked workflow tools; serve them remotely via worker"
```

---

## Task 11: Full verification

- [ ] **Step 1: Typecheck everything**

Run: `pnpm typecheck`
Expected: clean across all packages.

- [ ] **Step 2: Run the worker + sdk + plugin test suites**

Run: `cd packages/sdk && pnpm vitest run && cd ../worker && pnpm vitest run`
Expected: all pass (existing 553 worker tests + the new ones).

- [ ] **Step 3: Client build (only if any client file changed)**

Skip unless a client file was touched (none expected).

- [ ] **Step 4: Manual smoke (post-deploy, out of band)**

After `make deploy-worker` and `make deploy-modal` + a fresh session: in a normal session, `list_tools service=workflows` returns 22 tools; `call_tool workflows:list_workflows` succeeds; `call_tool workflows:delete_workflow` triggers the medium-risk policy path; inside a workflow session, `workflows:*` is denied.

---

## Self-Review

**Spec coverage:** internal provider (Tasks 1–3, 5), workflows action package (Tasks 4–6), trigger tools under `workflows` (Task 6 table), risk tiers (Task 6), registration (Task 7), session guard (Task 8), skill + discovery change (Task 9), delete baked files + image bump (Task 10), testing (each task + Task 11), result rendering (returned as `ActionResult.data`; Task 11 smoke confirms agent-visible output). All spec sections map to a task.

**Open decision flagged, not hidden:** Task 6 Step 1 resolves the cross-package import question (plugin package importing worker services vs. worker-internal source location). Both branches are spelled out; the engineer records the choice. This is the one genuine unknown and it is bounded.

**Type consistency:** `internal?: { db: unknown; env: unknown }` (SDK) is narrowed once via `internalOf()` in the action source. `executeAction` passes `{ db: appDb, env }`. Action ids are bare (`sync_workflow`) in `listActions`; `call_tool` namespaces them as `workflows:<id>` and the DO splits on `:` (verify in Task 8 Step 1). Risk tiers match the spec table.
