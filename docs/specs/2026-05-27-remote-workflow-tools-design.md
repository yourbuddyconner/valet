# Design: Remote Workflow Tools (move baked OpenCode shims to worker actions)

**Date:** 2026-05-27
**Status:** Approved (design); implementation plan to follow.

## Problem

The 22 workflow/trigger/execution/proposal tools live as standalone OpenCode
plugin files in `docker/opencode/tools/*.ts`, baked into the sandbox image. Each
is a thin shim that `fetch`es `http://localhost:9000/api/workflows|triggers|executions/...`
(the auth gateway → worker). The real logic already lives in the worker
(`workflowService`).

Two consequences:

1. **Image-rebuild tax.** Any change to a tool — even a one-line validator fix —
   requires bumping `IMAGE_BUILD_VERSION` in `backend/images/base.py`, a Modal
   image rebuild, and a fresh session before it takes effect. Existing sandboxes
   never pick it up.
2. **Validator drift.** Because the shims duplicate logic that also lives in the
   worker, the two can diverge. This recently caused `sync_workflow` to reject
   valid `agent_prompt`/`notify` steps while `update_workflow` accepted them
   (the tool carried a stale step-type allowlist the worker had since migrated).

Integration tools (github, slack, gmail, …) already avoid both problems: they
are **not** baked per-tool. The agent discovers them via `list_tools` and
invokes them via `call_tool`, which routes to worker-side `ActionSource`s. The
workflow tools are the odd ones out.

## Goal

Serve the workflow tool set as worker-side actions through the existing
`list_tools` / `call_tool` path, and delete the baked `.ts` shims. After this,
workflow tool changes are pure worker deploys, and there is a single
implementation + validator shared by the API routes and the agent tools.

Non-goals: migrating the *other* baked tools (browser, channel, memory,
sessions, skills, secrets). This is scoped to workflows/triggers as the first
internal-tool migration; the `internal provider` mechanism it introduces is
designed to be reused by those later.

## Background: how `call_tool` works today

```
OpenCode call_tool(toolId, params, summary)
  → gateway :9000/api/tools/call            (packages/runner/src/gateway.ts:1650)
  → runner onCallTool callback              (packages/runner/src/bin.ts:350)
  → WS → SessionAgentDO.handleCallTool      (session-agent.ts:6205)
      → resolveActionPolicy                 (risk level, disabled check, approval gate)
      → [optional human approval]
      → executeAction                       (services/session-tools.ts:425)
          → resolve ActionSource for service
          → resolve credentials for service (session-tools.ts:443)
          → actionSource.execute(actionId, params, ctx)   (session-tools.ts:486)
  → ActionResult → back to agent
```

`list_tools(service?, query?)` flows analogously through `onListTools` →
`listTools` (session-tools.ts:136) → `actionSource.listActions(ctx)`.

Action contracts (`packages/sdk/src/integrations/index.ts`):

- `ActionSource = { listActions(ctx?), execute(actionId, params, ctx) }`
- `ActionContext = { credentials, userId, orgId?, callerIdentity?, analytics?, attribution?, guardConfig? }`
- `IntegrationProvider.authType: 'oauth2' | 'bot_token' | 'api_key' | 'app_install' | 'none'`
- `IntegrationPackage = { name, version, service, provider, actions?, triggers? }`

The gap: `ActionContext` carries **no DB/env handle**. Integration actions call
external APIs with `credentials`; an internal action that must read/write local
D1 has no path to it.

## Design

### 1. "Internal provider" in the shared action framework

Add a first-class notion of a credential-less, worker-internal provider — built
into the framework so future internal tools (memory, sessions, skills) reuse it.

- **SDK** (`packages/sdk/src/integrations/index.ts`):
  - `IntegrationProvider` already supports `authType: 'none'`. Add
    `readonly internal?: boolean` to mark a provider as worker-internal.
  - Add an optional handle to `ActionContext`:
    ```ts
    /** Present only for internal providers. Gives worker-side data access. */
    internal?: { db: AppDb; env: Env };
    ```
    Typed loosely in the SDK to avoid a worker→sdk dependency cycle (e.g. a
    small structural interface or generics), resolved concretely in the worker.

- **Worker** (`services/session-tools.ts`):
  - `executeAction`: when the resolved provider is `internal` (or
    `authType === 'none'` with `internal: true`), **skip credential resolution**
    (no "connect in Settings" error) and pass `internal: { db, env }` in the
    `ActionContext`. All other branches (policy, audit, analytics) unchanged.
  - `listTools`: internal providers are always listable (no credentials needed),
    so they appear under their service without a connected integration.

### 2. Workflows action package

`packages/plugin-workflows/` is content-only today (the workflows skill). Add a
code capability mirroring an existing minimal package (e.g. plugin-deepwiki):

- `package.json` with `@valet/sdk` dep and an `./actions` export; `tsconfig.json`
  extending root; add to root `tsconfig.json` and `packages/worker/package.json`.
- `src/actions/provider.ts`: `IntegrationProvider` with `service: 'workflows'`,
  `displayName: 'Workflows'`, `authType: 'none'`, `internal: true`,
  `validateCredentials` → `true`, `testConnection` → `true`.
- `src/actions/actions.ts`: an `ActionSource`.
  - `listActions()` returns one `ActionDefinition` per tool (Zod `params`
    mirroring each current tool's args; `riskLevel` per the tiers below).
  - `execute(actionId, params, ctx)` switches on `actionId` and calls the
    existing `workflowService.*` function with `ctx.internal.db` / `ctx.internal.env`,
    returning `ActionResult`. **No logic is reimplemented** — it delegates to the
    same service functions the HTTP routes use, so validation (including the
    step-type allowlist) can never re-diverge.
- `src/actions/index.ts`: default-export the `IntegrationPackage`.
- Run `make generate-registries` to add it to `src/integrations/packages.ts`.

### Tool set (22, all under service `workflows`)

Triggers live under the same `workflows` service (the skill treats them together).

| Group | Tools | Risk |
|-------|-------|------|
| Workflows (read) | `list_workflows`, `get_workflow`, `list_workflow_history` | low |
| Workflows (mutate) | `sync_workflow`, `update_workflow`, `run_workflow` | low |
| Workflows (destructive) | `delete_workflow`, `rollback_workflow` | medium |
| Proposals | `create_workflow_proposal`, `list_workflow_proposals`, `review_workflow_proposal`, `apply_workflow_proposal` | low |
| Executions (read) | `list_workflow_executions`, `get_execution`, `get_execution_steps`, `debug_execution` | low |
| Executions (control) | `approve_execution`, `cancel_execution` | low |
| Triggers (read) | `list_triggers` | low |
| Triggers (mutate) | `sync_trigger`, `run_trigger` | low |
| Triggers (destructive) | `delete_trigger` | medium |

`medium` actions pass through `resolveActionPolicy`; org action-policy decides
whether they require human approval. This is a new guardrail (the baked shims
had none).

Tool ids become namespaced: `workflows:sync_workflow`, etc.

### 3. Preserve the workflow-session guard

The baked shims call `denyInWorkflowSession(...)` so workflow tools can't be
invoked from inside a `purpose: workflow` session (prevents recursion). Re-enforce
this in `SessionAgentDO.handleCallTool`: when the current session's purpose is
`workflow`, deny any `workflows:*` toolId with the same message. The DO already
knows its own purpose, so no extra context plumbing is needed.

### 4. Result rendering

The baked tools returned human-readable formatted strings; `executeAction`
returns `ActionResult.data`. Confirm how `call_tool` results are surfaced to the
agent and ensure `ActionResult.data` carries a readable summary (reusing the
existing `_format` shaping where it added value) so output quality does not
regress.

### 5. Skill + cleanup

- Update the `workflows` skill (`packages/plugin-workflows/skills/...`): instruct
  the agent to `list_tools service=workflows` first, then `call_tool` with
  namespaced ids; drop references to calling the named tools directly.
- Delete the 22 baked files from `docker/opencode/tools/` (and the now-unused
  `_workflow_session_guard.ts` if nothing else uses it).
- One final `IMAGE_BUILD_VERSION` bump in `backend/images/base.py` to drop the
  files from the image. After this, workflow tool changes need no rebuild.

## Data flow (after)

```
OpenCode list_tools service=workflows
  → ... → workflows ActionSource.listActions() → ActionDefinition[22]

OpenCode call_tool workflows:sync_workflow {data_json|...}
  → ... → handleCallTool
      → resolveActionPolicy (low → no approval)
      → executeAction (internal provider: skip creds, inject {db,env})
      → workflows ActionSource.execute('sync_workflow', params, ctx)
      → workflowService.syncWorkflow(ctx.internal.db, userId, ...)
  → ActionResult → agent
```

## Error handling

- Validation failures (e.g. invalid step type) propagate as
  `ActionResult.error` strings — the same messages the routes produce, now from
  a single source.
- Internal providers never hit the credential path, so the
  "No credentials found … connect in Settings" branch is skipped for them.
- `medium`-risk actions denied by policy return the standard policy-denied error.
- Workflow-session guard returns the standard deny message for `workflows:*`.

## Testing

- **ActionSource.execute mapping** — for each `actionId`, asserts it calls the
  right `workflowService` fn against a real test D1 and that a known validation
  error (bad step type) propagates unchanged into `ActionResult.error`.
- **executeAction internal branch** — asserts that for an internal provider it
  skips credential resolution and passes `internal: { db, env }`.
- **listTools** — asserts the `workflows` service lists all 22 actions with no
  credentials connected.
- **handleCallTool guard** — asserts `workflows:*` is denied in a
  `purpose: workflow` session and allowed otherwise.
- Existing `workflowService` and `validateWorkflowDefinition` tests already cover
  the underlying logic and are unaffected.

## Risks / trade-offs

- **Discovery behavior change.** The agent must `list_tools service=workflows`
  before calling — one extra call per session. Mitigated by the skill update.
- **New approval friction.** Destructive ops are now `medium`; depending on org
  policy they may prompt for approval where the shims never did. Intended.
- **SDK type coupling.** `ActionContext.internal` references worker types; keep
  it structurally typed / generic in the SDK to avoid a dependency cycle.
- **One last image rebuild** is still required to remove the baked files; it is
  the final one for this tool set.

## Rollout

1. Land SDK + worker `internal provider` support (no behavior change alone).
2. Land the `workflows` action package + registry regen.
3. Land the `handleCallTool` guard + skill update.
4. Delete baked files + bump `IMAGE_BUILD_VERSION`.
5. Deploy worker, then Modal image; new sessions use remote tools.
