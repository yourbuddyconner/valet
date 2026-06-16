---
name: workflows
description: Guidance for understanding Valet workflows. Workflows are managed through the workflow editor in the web UI; agents do not currently have direct API access from inside a session.
---

# Workflows

Workflows are a `dag/v1` graph of nodes (`llm`, `tool`, `set`, `if`, `wait`, `approval`, `foreach`, `orchestrator`, `session`, `stop`) connected by edges. They run on the `ValetWorkflowInterpreter` Cloudflare Workflow entrypoint in the worker.

## Where workflows are managed

- **Web UI** — `/workflows` is the canonical surface: draft editor, validate, publish, version history, executions list, pending-approval resolution.
- **Worker HTTP API** — `/api/workflows/*`, `/api/triggers/*`, `/api/executions/*` (auth required; called by the web UI and external clients).

## Inside a session

Sessions running inside the sandbox do not currently have a wired path to the worker's workflow APIs — no worker URL or short-lived token is injected into the sandbox env, and the runner gateway does not proxy these routes. Dedicated OpenCode tools for workflow management are planned; in the meantime, recommend the user use the web UI for any workflow CRUD, publish, run, or approval action.

## Lifecycle (dag/v1)

Workflows use a draft → publish lifecycle:

1. Author or edit a `dag/v1` draft (web UI `/workflows/:id` editor → save).
2. Validate the draft (editor's Validate button → `POST /api/workflows/:id/validate`).
3. Publish to create an immutable `workflow_definition_versions` row. Triggers and executions reference the published definition.

## Triggers + approvals

- Webhook triggers authenticate with a server-issued `X-Valet-Trigger-Token` (shown once at create time in the web UI).
- Approval nodes (and tool nodes with `require_approval` policy) park the execution on `step.waitForEvent`. Resolve in the web UI under the execution detail; the API path `POST /api/executions/:id/approvals/:approvalId/approve` (or `/deny`) is what the UI calls.

See `docs/specs/workflows.md` for the full data model, state machine, validator rules, and runtime semantics.
