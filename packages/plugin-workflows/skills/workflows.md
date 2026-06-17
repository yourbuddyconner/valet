---
name: workflows
description: Guidance for understanding Valet workflows, including the worker-backed workflow tools available through list_tools/call_tool.
---

# Workflows

Workflows are a `dag/v1` graph of nodes (`trigger`, `llm`, `tool`, `set`, `if`, `wait`, `approval`, `foreach`, `orchestrator`, `session`, `stop`) connected by edges. They run on the `ValetWorkflowInterpreter` Cloudflare Workflow entrypoint in the worker.

## Where workflows are managed

- **Web UI** — `/workflows` is the canonical surface: draft editor, validate, publish, version history, executions list, pending-approval resolution.
- **Worker HTTP API** — `/api/workflows/*`, `/api/triggers/*`, `/api/executions/*` (auth required; called by the web UI and external clients).
- **Agent remote tools** — `list_tools service=workflows` exposes worker-backed workflow actions through the runner gateway.

## Inside a session

Use the remote integration tool surface, not local scripts or OpenCode-native tools:

```text
list_tools service=workflows
call_tool workflows:workflows.list params={} summary="List workflows"
```

Available actions:

- `workflows.list` — list the current user's workflows.
- `workflows.get` — fetch metadata plus published definition and draft by workflow ID or slug.
- `workflows.create` — create a new workflow draft.
- `workflows.save_draft` — save a structurally valid `dag/v1` draft. Drafts may still be semantically incomplete. Pass `validate: true` to return grouped validation after save.
- `workflows.validate` — validate a saved draft or supplied definition. Returns blocking `errors` separately from non-blocking `warnings`.
- `workflows.publish` — publish the current draft. This is high risk and may require approval.
- `workflows.test_run` — start a draft execution with sample trigger data and optional declared inputs. Returns an execution id/status.

Prefer the web UI for visual graph editing. Use tools for inspection, small edits, validation, publishing, and test runs when the user asks the agent to operate on workflows directly. Malformed drafts are not saved; the tool returns validation details instead.

## Authoring Reference

A workflow definition has this top-level shape:

```json
{
  "version": "dag/v1",
  "inputs": {},
  "nodes": [],
  "edges": []
}
```

Node IDs may contain letters, numbers, `_`, and `-`. They must be unique across top-level nodes and foreach body nodes. Edges connect top-level nodes only.

### Templates and Data

String fields and JSON values on most nodes support `{{ expression }}` templates.

Common references:

- `{{trigger.data}}` — invocation payload (webhook body/query/headers or test-run sample data).
- `{{trigger.metadata}}` — trigger metadata such as mode, initiator, or webhook context.
- `{{trigger.type}}` / `{{trigger.timestamp}}` — trigger envelope fields.
- `{{inputs.name}}` — declared workflow input values.
- `{{nodes.node_id.data}}` — output data from a previous node.
- `{{nodes.llm_id.data.response}}` — LLM text response.
- `{{nodes.tool_id.data}}` — tool action result data.
- Inside `foreach`, the defaults are `{{item}}` and `{{index}}` unless aliases are set.

Do not use `outputs.*`; the runtime context is `nodes.*`.

### Edges

```json
{ "from": "start", "to": "next" }
```

Edges from an `if` node must include `fromOutput`:

```json
{ "from": "route", "fromOutput": "true", "to": "on_true" }
{ "from": "route", "fromOutput": "false", "to": "on_false" }
```

`when` is an optional expression predicate for advanced edge gating.

### Node Schemas

`trigger` represents the invocation source and exposes trigger payload data:

```json
{ "id": "trigger", "type": "trigger" }
```

`set` writes structured values to `nodes.<id>.data`:

```json
{ "id": "prepare", "type": "set", "values": { "message": "hello {{trigger.data.name}}" } }
```

`llm` generates text or structured data:

```json
{
  "id": "summarize",
  "type": "llm",
  "model": "anthropic:claude-sonnet-4-20250514",
  "system": "Optional system prompt",
  "prompt": "Summarize {{trigger.data.text}}",
  "maxOutputTokens": 800
}
```

Model IDs use `provider:model`, not `provider/model`. Supported providers are `anthropic`, `openai`, and `google`. The provider API key must be configured in the worker environment or validation/test-run will return an environment error. `maxOutputTokens` is not required, but omitting it returns a warning.

`tool` calls a remote integration action:

```json
{
  "id": "list_issues",
  "type": "tool",
  "service": "github",
  "action": "github.list_issues",
  "params": { "owner": "tkhq", "repo": "valet" },
  "summary": "List GitHub issues",
  "onPolicyDeny": "fail",
  "retries": 1
}
```

`if` branches on conditions:

```json
{
  "id": "route",
  "type": "if",
  "combinator": "and",
  "conditions": [
    { "left": "trigger.data.priority", "dataType": "string", "operation": "equals", "right": "high" }
  ]
}
```

Condition fields are `left`, `dataType`, `operation`, and optional `right`. Use `operation`, not `operator` or `op`.

`foreach` iterates over an array expression and runs one body node per item:

```json
{
  "id": "each_issue",
  "type": "foreach",
  "items": "{{nodes.list_issues.data.issues}}",
  "itemAlias": "issue",
  "indexAlias": "i",
  "maxItems": 25,
  "concurrency": 3,
  "onItemError": "fail",
  "body": {
    "id": "shape_issue",
    "type": "set",
    "values": { "title": "{{issue.title}}", "number": "{{issue.number}}" }
  }
}
```

Foreach `body` may be `llm`, `tool`, `set`, `stop`, `orchestrator`, or `session`.

`approval` pauses until a human approves or denies:

```json
{ "id": "approve", "type": "approval", "prompt": "Approve deploy?", "summary": "Deploy approval", "timeout": "24h", "onDeny": "fail" }
```

`wait` sleeps for a duration:

```json
{ "id": "pause", "type": "wait", "mode": "duration", "duration": "10m" }
```

`orchestrator` prompts the user's orchestrator:

```json
{ "id": "ask_orchestrator", "type": "orchestrator", "prompt": "Investigate {{trigger.data.issue}}", "wait": { "mode": "until_idle", "timeout": "30m" } }
```

`session` either starts a new session or prompts an existing one:

```json
{ "id": "start_session", "type": "session", "mode": "start", "workspace": "/workspace", "prompt": "Run tests", "wait": { "mode": "until_idle", "timeout": "1h" } }
```

```json
{ "id": "prompt_session", "type": "session", "mode": "prompt", "sessionId": "{{nodes.start_session.data.sessionId}}", "prompt": "Continue", "wait": { "mode": "none" } }
```

`stop` ends a branch with optional output:

```json
{ "id": "done", "type": "stop", "outcome": "success", "output": { "ok": true }, "message": "Complete" }
```

## Known Valid Examples

Minimal workflow:

```json
{
  "version": "dag/v1",
  "nodes": [
    { "id": "trigger", "type": "trigger" },
    { "id": "hello", "type": "set", "values": { "message": "hello {{trigger.data.name}}" } },
    { "id": "done", "type": "stop", "outcome": "success", "output": "{{nodes.hello.data}}" }
  ],
  "edges": [
    { "from": "trigger", "to": "hello" },
    { "from": "hello", "to": "done" }
  ]
}
```

Branching workflow:

```json
{
  "version": "dag/v1",
  "nodes": [
    { "id": "trigger", "type": "trigger" },
    {
      "id": "route",
      "type": "if",
      "conditions": [
        { "left": "trigger.data.priority", "dataType": "string", "operation": "equals", "right": "high" }
      ]
    },
    { "id": "high", "type": "stop", "outcome": "success", "message": "High priority" },
    { "id": "normal", "type": "stop", "outcome": "success", "message": "Normal priority" }
  ],
  "edges": [
    { "from": "trigger", "to": "route" },
    { "from": "route", "fromOutput": "true", "to": "high" },
    { "from": "route", "fromOutput": "false", "to": "normal" }
  ]
}
```

## Lifecycle (dag/v1)

Workflows use a draft → publish lifecycle:

1. Author or edit a `dag/v1` draft (web UI `/workflows/:id` editor → save).
2. Validate the draft (editor's Validate button → `POST /api/workflows/:id/validate`).
3. Publish to create an immutable `workflow_definition_versions` row. Triggers and executions reference the published definition.

## Triggers + approvals

- Webhook triggers authenticate with a server-issued `X-Valet-Trigger-Token` (shown once at create time in the web UI).
- Approval nodes (and tool nodes with `require_approval` policy) park the execution on `step.waitForEvent`. Resolve in the web UI under the execution detail; the API path `POST /api/executions/:id/approvals/:approvalId/approve` (or `/deny`) is what the UI calls.

See `docs/specs/workflows.md` for the full data model, state machine, validator rules, and runtime semantics.
