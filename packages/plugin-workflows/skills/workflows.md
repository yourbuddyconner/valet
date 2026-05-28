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

Triggers are identified by name. `sync_trigger` is idempotent — calling with the same name updates the existing trigger, preserving its creation time and history. No need to look up trigger IDs first.

Use `sync_trigger` for create/update:

- `type=manual`
- `type=webhook` requires `webhook_path` (optional method/secret)
- `type=schedule` requires `schedule_cron`

Schedule specifics:

- `schedule_cron` is a 5-field cron expression evaluated in `schedule_timezone` (default: UTC). Example: `0 8 * * *` with timezone `America/Denver` fires at 8:00 AM Mountain Time daily.
- `schedule_target=workflow` (default): dispatches workflow execution.
- `schedule_target=orchestrator`: dispatches `schedule_prompt` to orchestrator session.
- `schedule_prompt` is required when `schedule_target=orchestrator`.

Use `run_trigger` to test behavior immediately.

Use `delete_trigger` to remove stale triggers (by ID or name).

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

Valid step types: `bash`, `tool`, `agent_prompt`, `notify`, `approval`, `conditional`, `loop`, `parallel`.

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
  "description": "Run the test suite",
  "outputVariable": "test_results"
}
```

When `outputVariable` is set, the bash step publishes `{stdout, stderr, exitCode, command, cwd, timeoutMs, durationMs}` under that name. Downstream interpolation reaches into it with `{{outputs.test_results.stdout}}` / `.exitCode`.

**Do NOT use `type: "tool"` with `tool: "bash"` for shell commands.** Use `type: "bash"` instead.

### `tool` step

For non-bash tools only. Requires `tool` (string) and optionally `arguments` (object). Output shape is tool-specific and persisted as-is.

### `approval` step

Pauses execution and waits for human approval.

Optional fields:
- `prompt` (string): Message shown to the approver.

### `conditional` step

Evaluates a condition and runs the `then` branch on truthy, `else` branch on falsy. The taken branch is recorded in step output as `{condition, branch: "then"|"else"}`.

Required:
- `condition`: preferred form is a string expression. Supports comparisons (`===`, `!==`, `==`, `!=`, `>`, `>=`, `<`, `<=`), logical operators (`&&`, `||`, `!`), parentheses, string/number literals, and path references (`variables.x`, `outputs.y.z`, `loop.item`, `loop.index`). Tokens of the form `{{variables.flag}}` or `{{outputs.x}}` are interpolated first so authors can mix templated values with raw paths. A boolean literal is also accepted. A legacy `{variable, equals}` object shape is honored for backward compatibility but new workflows should use the expression form.

Optional fields:
- `then` (array of steps): Steps to run when condition is truthy.
- `else` (array of steps): Steps to run when condition is falsy.

Example:
```json
{
  "id": "check",
  "name": "Tests passed?",
  "type": "conditional",
  "condition": "outputs.test_results.exitCode === 0",
  "then": [{ "id": "deploy", "name": "Deploy", "type": "bash", "command": "npm run deploy" }],
  "else": [{ "id": "notify-fail", "name": "Notify", "type": "notify", "content": "Tests failed" }]
}
```

### `parallel` step

Runs each child in `steps` as its own concurrent branch (one branch per child, not all-children-per-branch). Each branch sees a snapshot of `outputs`/`variables` at parallel entry — siblings do not see each other's writes during execution. After all branches finish, new keys are merged back to the parent context (last writer wins on collision; use distinct `outputVariable` names across branches to avoid this).

Required:
- `steps` (array of steps): each element is one branch.

Status: fails if any branch fails; cancels if any branch cancels.

### `loop` step

Iterates `steps` over a sequence. Each iteration runs the body once with `{{loop.item}}` and `{{loop.index}}` available for interpolation. Inside an iteration `outputVariable` writes are namespaced to the iteration so iterations don't clobber each other's downstream-visible state.

Required (one of):
- `over` as a string path: `"outputs.list"` or `"variables.items"`. Must resolve to an array.
- `over` as an inline array literal: `["a", "b", "c"]`. Useful for small fixed iterations without a setup step.

Optional fields:
- `itemVar` (string identifier): name for the per-iteration value. Defaults to `item`. `{{loop.item}}` always works regardless.
- `indexVar` (string identifier): name for the per-iteration index. Defaults to `index`. `{{loop.index}}` always works regardless.
- `steps` (array of steps): body executed per iteration.

Failure semantics: if an iteration fails, the loop fails and outputs published by completed iterations are rolled back to the snapshot taken at loop entry. Predictable strict semantics, no half-state.

Common author bugs:
- `over: outputs.someResult.field` where `field` is a string, not an array → `loop_over_not_array`. Either iterate over an array (build one upstream), or replace the loop with explicit per-item steps.
- Forgetting that `outputVariable` writes inside the loop are per-iteration — referencing them after the loop won't pick up "the last iteration's value" as a simple top-level key.

### `agent_prompt` step

Dispatches a prompt to the workflow session's AI agent and waits for a reply. This is the primary way to call models from a workflow.

Required (one of):
- `prompt` (string), or
- `content` (string), or
- `message` (string), or
- `goal` (string).

Optional fields:
- `thread` (string): named conversation thread. Multiple `agent_prompt` steps with the same `thread` share context across calls. Use `@new` to force a fresh, ephemeral thread that's torn down after the step (useful for loops).
- `persona` (string): persona id to override the default system prompt for this single call. Fail-loud if the id doesn't resolve.
- `interrupt` (boolean): aborts any in-flight OpenCode session on this thread before sending.
- `await_timeout_ms` (or `awaitTimeoutMs`) (number): per-call timeout in ms (default 120000, clamped to [1000, 900000]).
- `outputSchema` (object): structured-output schema. Field names map to `{type, description}`. When set, the agent's reply is parsed against the schema and the parsed object is the step's response payload. Without a schema, the bare reply string is the response.
- `outputVariable` (string): variable name to publish the response under.

Output shape:
- Persisted on the step row as `{response, model, inputTokens, outputTokens, durationMs}`.
- Variable publication unwraps to just the `response` payload, so `{{outputs.var.field}}` resolves directly against a structured response (e.g. `outputs.review.verdict`). With no schema, `{{outputs.var}}` is the raw string.

Example with structured output:
```json
{
  "id": "review",
  "name": "Review PR",
  "type": "agent_prompt",
  "prompt": "Review this PR. Return verdict + reason.",
  "persona": "code-reviewer-v1",
  "outputVariable": "review",
  "outputSchema": {
    "verdict": { "type": "string", "description": "approve | reject | needs_changes" },
    "reason":  { "type": "string", "description": "one-line explanation" }
  }
}
```

Then `outputs.review.verdict` and `outputs.review.reason` are available to downstream steps.

### `notify` step

Sends a notification message. v1 only supports the orchestrator target (delivery to the user's orchestrator session); channel routing (Slack, Telegram, etc.) is not yet implemented.

Required:
- `content` (string): message body. Supports `{{...}}` interpolation.

Optional:
- `target` (string): currently only `"orchestrator"` (the default) is supported. Other values fail with `notify_unsupported_target`.

Output shape: `{type: "notify", target, delivered, error?}`. The notify card in the UI reads these fields.

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

1. Use `list_workflows` before creating/updating to avoid duplicates. Triggers are idempotent by name — no need to list first.
2. Use `get_workflow` before patching critical definitions.
3. Use `run_workflow` or `run_trigger` for tests.
4. Use `debug_execution` first for incidents.
5. Use fresh `resume_token` from `get_execution` before `approve_execution`.
6. Use `cancel_execution` when state is inconsistent, then rerun cleanly.
7. Use `list_workflow_history` and `rollback_workflow` for safe recovery.
