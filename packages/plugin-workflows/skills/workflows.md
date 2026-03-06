---
name: workflows
description: End-to-end Valet workflow operations. Use when creating, updating, deleting, running, scheduling, debugging, rolling back, or self-modifying workflows; when managing workflow executions and approvals; when configuring trigger behavior; when passing repository context into workflow runs; and when using agent_message workflow steps.
---

# Workflows

## Use the workflow tools, not raw API calls

Use these tools for lifecycle operations:

- `list_workflows`, `get_workflow`, `sync_workflow`, `update_workflow`, `delete_workflow`
- `list_workflow_history`, `rollback_workflow`
- `list_workflow_proposals`, `create_workflow_proposal`, `review_workflow_proposal`, `apply_workflow_proposal`
- `run_workflow`, `list_workflow_executions`, `get_execution`, `get_execution_steps`, `debug_execution`, `approve_execution`, `cancel_execution`
- `list_triggers`, `sync_trigger`, `run_trigger`, `delete_trigger`

## Think in 4 layers

1. Workflow definition: versioned JSON with non-empty `steps`.
2. Trigger configuration: dispatch rules for `manual`, `webhook`, or `schedule`.
3. Execution record: immutable run state, status, step traces, and approval token lifecycle.
4. Workflow session: dedicated sandbox session (`purpose: workflow`) started/woken by the workflow executor.

## Choose the right lifecycle tool

- Use `sync_workflow` for create or full-definition upsert.
- Use `update_workflow` for partial metadata/definition patch (`name`, `description`, `slug`, `version`, `enabled`, `tags`, `data`).
- Use `delete_workflow` to remove workflows (and linked triggers).
- Use `list_workflow_history` before rollback or forensic comparison.
- Use `rollback_workflow` with a `target_workflow_hash` from history.

## Use proposal flow for self-modifying workflows

Follow this sequence:

1. Use `get_workflow` and compute/use current workflow hash as `base_workflow_hash`.
2. Use `create_workflow_proposal`.
3. Use `review_workflow_proposal` (`approve=true/false`).
4. Use `apply_workflow_proposal` after approval.

Notes:

- Proposal creation enforces base-hash matching.
- Workflow must allow self-modification (`constraints.allowSelfModification === true`).
- Use `list_workflow_proposals` to inspect status transitions (`pending`, `approved`, `rejected`, `applied`, `failed`).

## Run and operate executions

Run:

- Use `run_workflow` with `workflow_id`.
- Optionally pass `variables_json`.
- Optionally pass repo context: `repo_url`, `repo_branch`, `repo_ref`, `source_repo_full_name`.

Inspect:

- Use `list_workflow_executions` for recent runs.
- Use `get_execution` for authoritative status and current `resumeToken`.
- Use `get_execution_steps` for ordered normalized step traces.
- Use `debug_execution` first when a run stalls/fails.

Approval/cancel:

- Use `approve_execution` with the latest `resume_token` from `get_execution`.
- Use `cancel_execution` for stuck/inconsistent runs.

## Configure triggers and scheduling

Use `sync_trigger` for create/update:

- `type=manual`
- `type=webhook` requires `webhook_path` (optional method/secret)
- `type=schedule` requires `schedule_cron`

Schedule specifics:

- `schedule_cron` must be a 5-field cron expression.
- `schedule_timezone` uses IANA TZ names.
- `schedule_target=workflow` (default): dispatches workflow execution.
- `schedule_target=orchestrator`: dispatches `schedule_prompt` to orchestrator session.
- `schedule_prompt` is required when `schedule_target=orchestrator`.

Use `run_trigger` to test behavior immediately.

Use `delete_trigger` to remove stale triggers.

Variable mapping note:

- Keep `variable_mapping_json` paths simple (`$.field`), since extraction is shallow.

## Understand workflow execution context

Workflow runs do not execute in the orchestrator sandbox.

Execution context behavior:

1. A workflow session is created as a dedicated session (`purpose: workflow`) and initially hibernated.
2. `WorkflowExecutorDO` wakes/boots that workflow sandbox when enqueue/resume happens.
3. The executor dispatches a workflow-run prompt into that workflow session.

Repository context behavior:

- Repo context is stored in `session_git_state` for the workflow session.
- Executor injects `REPO_URL`, `REPO_BRANCH`, `REPO_REF` env vars into the sandbox.
- Sandbox startup clones `REPO_URL` into `/workspace/<repo>`, checks out branch/ref when provided, and sets working directory to the clone.

## Author workflow definitions with current runtime behavior

Minimum requirement:

- `workflow.steps` must be a non-empty array.
- Each step must have `id` (string), `name` (string), and `type` (string).

Valid step types: `bash`, `tool`, `approval`, `conditional`, `parallel`, `agent`, `agent_message`.

### `bash` step (preferred for shell commands)

Use `type: "bash"` for shell commands. This is a first-class step type.

Required fields:
- `command` (string): The shell command to execute.

Optional fields:
- `description` (string): Human-readable description of what this command does.
- `cwd` (string): Working directory.
- `timeoutMs` (number): Timeout in milliseconds (default 120000, max 600000).
- `outputVariable` (string): Variable name to store command output.

Example:
```json
{
  "id": "1",
  "name": "Run tests",
  "type": "bash",
  "command": "npm test",
  "description": "Run the test suite"
}
```

**Do NOT use `type: "tool"` with `tool: "bash"` for shell commands.** Use `type: "bash"` instead.

### `tool` step

For non-bash tools only. Requires `tool` (string) and optionally `arguments` (object).

### `approval` step

Pauses execution and waits for human approval.

Optional fields:
- `prompt` (string): Message shown to the approver.

### `conditional` step

Evaluates a condition and runs `then` or `else` branch.

Required fields:
- `condition`: Boolean value, or object like `{ "variable": "varName", "equals": "value" }`.

Optional fields:
- `then` (array of steps): Steps to run when condition is true.
- `else` (array of steps): Steps to run when condition is false.

### `parallel` step

Runs nested steps. Requires `steps` (array of steps).

### `agent` step

Dispatches work to an AI agent.

Optional fields:
- `goal` (string): What the agent should accomplish.
- `context` (string): Additional context for the agent.

### `agent_message` step

Sends a message to the workflow session agent.

Required: Provide message via `content` (preferred), or `message`, or `goal`.

Optional fields:
- `interrupt` (boolean).
- `await_response` (or `awaitResponse`) boolean.
- `await_timeout_ms` (or `awaitTimeoutMs`) number, minimum 1000.

Behavior:
- Non-await mode sends a message to the current workflow session agent.
- Await mode runs a temporary OpenCode session and returns response text in step output.

### Complete workflow example

```json
{
  "steps": [
    {
      "id": "1",
      "name": "Install dependencies",
      "type": "bash",
      "command": "npm install",
      "description": "Install project dependencies"
    },
    {
      "id": "2",
      "name": "Run linter",
      "type": "bash",
      "command": "npm run lint",
      "description": "Check code quality"
    },
    {
      "id": "3",
      "name": "Run tests",
      "type": "bash",
      "command": "npm test",
      "outputVariable": "test_results"
    },
    {
      "id": "4",
      "name": "Approve deployment",
      "type": "approval",
      "prompt": "Tests passed. Deploy to production?"
    },
    {
      "id": "5",
      "name": "Deploy",
      "type": "bash",
      "command": "npm run deploy"
    }
  ]
}
```

## Reliable operating playbook

1. Use `list_workflows` and `list_triggers` before creating/updating to avoid duplicates.
2. Use `get_workflow` before patching critical definitions.
3. Use `run_workflow` or `run_trigger` for tests.
4. Use `debug_execution` first for incidents.
5. Use fresh `resume_token` from `get_execution` before `approve_execution`.
6. Use `cancel_execution` when state is inconsistent, then rerun cleanly.
7. Use `list_workflow_history` and `rollback_workflow` for safe recovery.
