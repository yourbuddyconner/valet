---
name: workflows
description: Guidance for understanding Valet workflows, including the worker-backed workflow tools available through list_tools/call_tool.
---

# Workflows

Workflows are a `dag/v1` graph of nodes (`llm`, `tool`, `set`, `if`, `wait`, `approval`, `foreach`, `orchestrator`, `session`, `stop`) connected by edges. They run on the `ValetWorkflowInterpreter` Cloudflare Workflow entrypoint in the worker.

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
- `workflows.save_draft` — save a `dag/v1` draft. Drafts may be incomplete.
- `workflows.validate` — validate a saved draft or supplied definition.
- `workflows.publish` — publish the current draft. This is high risk and may require approval.
- `workflows.test_run` — run the draft with sample trigger data and optional declared inputs.

Prefer the web UI for visual graph editing. Use tools for inspection, small edits, validation, publishing, and test runs when the user asks the agent to operate on workflows directly.

## Lifecycle (dag/v1)

Workflows use a draft → publish lifecycle:

1. Author or edit a `dag/v1` draft (web UI `/workflows/:id` editor → save).
2. Validate the draft (editor's Validate button → `POST /api/workflows/:id/validate`).
3. Publish to create an immutable `workflow_definition_versions` row. Triggers and executions reference the published definition.

## Triggers + approvals

- Webhook triggers authenticate with a server-issued `X-Valet-Trigger-Token` (shown once at create time in the web UI).
- Approval nodes (and tool nodes with `require_approval` policy) park the execution on `step.waitForEvent`. Resolve in the web UI under the execution detail; the API path `POST /api/executions/:id/approvals/:approvalId/approve` (or `/deny`) is what the UI calls.

See `docs/specs/workflows.md` for the full data model, state machine, validator rules, and runtime semantics.
