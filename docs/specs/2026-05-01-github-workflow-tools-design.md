# GitHub Workflow Tools Design

**Date:** 2026-05-01
**Status:** Draft
**Scope:** Add 6 new GitHub Actions tools to `plugin-github` for workflow run inspection, log retrieval, and workflow management — achieving parity with `gh run` and `gh workflow` CLI commands.

## Problem

The GitHub plugin has a single workflow tool (`github.list_workflow_runs`) that returns run metadata but no logs. When a CI check fails, the agent can see *that* something failed but has no way to read *why*. This forces users to manually inspect logs or clone repos, defeating the purpose of an agent that can autonomously fix CI failures.

The `gh` CLI provides `gh run view --log-failed` for exactly this use case. We need equivalent capability as agent tools.

## Motivation (Slack thread, 2026-05-01)

An agent was asked to fix failing checks on a PR. It called `list_workflow_runs`, saw `rust-build` had failed, but had no tool to fetch the log output. It tried unauthenticated API calls (failed — private repo), then gave up and suggested spawning a child session to clone the repo. A simple "read the CI error" should be a single tool call.

## Design

### Tool Set (6 new tools)

#### 1. `github.get_workflow_run` (risk: low)

**Purpose:** Triage — understand what happened in a run. Returns structured metadata including jobs, steps, and check run annotations. For many failures, annotations alone pinpoint the problem (file, line, error message) without needing logs.

**Parameters:**
```
owner: string          — Repository owner
repo: string           — Repository name
run_id: number         — Workflow run ID
```

**GitHub API calls:**
- `GET /repos/{owner}/{repo}/actions/runs/{run_id}` — run metadata
- `GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs` — jobs + steps
- `GET /repos/{owner}/{repo}/commits/{head_sha}/check-runs` — annotations

**Returns:**
```typescript
{
  id: number,
  name: string,
  status: string,            // "completed", "in_progress", "queued"
  conclusion: string | null, // "success", "failure", "cancelled", etc.
  event: string,
  branch: string,
  commit_sha: string,
  url: string,
  created_at: string,
  updated_at: string,
  run_attempt: number,
  jobs: Array<{
    id: number,
    name: string,
    status: string,
    conclusion: string | null,
    started_at: string | null,
    completed_at: string | null,
    steps: Array<{
      name: string,
      status: string,
      conclusion: string | null,
      number: number,
    }>,
  }>,
  annotations: Array<{      // from check runs
    path: string,
    start_line: number,
    end_line: number,
    annotation_level: string,  // "failure", "warning", "notice"
    message: string,
    title: string | null,
  }>,
}
```

**Permission hint:** `actions:read, checks:read`

---

#### 2. `github.get_job_logs` (risk: low)

**Purpose:** Diagnosis — read actual log output from a specific job. Parses GitHub's raw log format into steps, filters to failed steps by default, strips noise, and truncates to keep context window usage reasonable.

**Parameters:**
```
owner: string               — Repository owner
repo: string                — Repository name
job_id: number              — Job ID (from get_workflow_run response)
failed_only: boolean = true — Only return output from failed steps
step_name: string?          — Filter to a specific step by name
tail_lines: number = 500    — Max lines to return per step (tail-biased)
include_timestamps: boolean = false — Include ISO timestamp prefixes
```

**GitHub API call:**
- `GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs` — returns plain text (302 redirect to download URL)

**Log parsing logic:**

GitHub job logs contain step markers and annotations:
```
2024-01-15T10:30:05.100Z ##[group]Run cargo build
2024-01-15T10:30:45.000Z error[E0277]: the trait bound...
2024-01-15T10:30:50.000Z ##[error]Process completed with exit code 1.
2024-01-15T10:30:50.100Z ##[endgroup]
```

The implementation fetches step metadata from the jobs API (`GET /repos/{owner}/{repo}/actions/jobs/{job_id}`) to get step names and conclusions, then cross-references with the parsed log sections.

Processing pipeline:
1. Fetch job details to get step metadata (names + conclusions)
2. Split raw log into steps using `##[group]`/`##[endgroup]` markers, matching each section to step metadata by name
3. If `failed_only=true`, discard steps that succeeded
4. If `step_name` is set, filter to that step only
5. Strip ANSI escape codes
6. Strip ISO timestamp prefixes (`YYYY-MM-DDTHH:MM:SS.NNNNNNNZ `) unless `include_timestamps=true`
7. If a step exceeds `tail_lines`, truncate from the head, keeping the last N lines. Preserve any `##[error]` annotation lines even if outside the tail window.
8. Prepend a `[truncated {N} lines]` marker when truncation occurs

**Returns:**
```typescript
{
  job_id: number,
  job_name: string,
  steps: Array<{
    name: string,
    conclusion: string,
    log: string,           // processed log output
    truncated: boolean,
    total_lines: number,   // original line count before truncation
  }>,
}
```

**Permission hint:** `actions:read`

**Edge cases:**
- Logs unavailable (expired, run in progress): return error with explanation
- Empty log: return step entry with empty `log` string
- No `##[group]` markers (non-standard log format): return entire log as a single unnamed step

---

#### 3. `github.rerun_workflow` (risk: medium)

**Purpose:** Re-run a workflow after fixing code.

**Parameters:**
```
owner: string              — Repository owner
repo: string               — Repository name
run_id: number             — Workflow run ID to re-run
failed_only: boolean = false — Only re-run failed jobs (saves CI time)
```

**GitHub API calls:**
- `failed_only=false`: `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun`
- `failed_only=true`: `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs`

**Returns:**
```typescript
{
  message: string,  // confirmation message
  url: string,      // link to the run
}
```

**Note:** GitHub creates a new run attempt, not a new run ID. The existing run URL will show the new attempt.

**Permission hint:** `actions:write`

---

#### 4. `github.cancel_workflow_run` (risk: medium)

**Purpose:** Cancel an in-progress workflow run.

**Parameters:**
```
owner: string   — Repository owner
repo: string    — Repository name
run_id: number  — Workflow run ID to cancel
```

**GitHub API call:**
- `POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel`

**Returns:**
```typescript
{
  message: string,  // confirmation message
}
```

**Permission hint:** `actions:write`

---

#### 5. `github.list_workflows` (risk: low)

**Purpose:** Discover what workflow definitions exist in a repository.

**Parameters:**
```
owner: string   — Repository owner
repo: string    — Repository name
```

**GitHub API call:**
- `GET /repos/{owner}/{repo}/actions/workflows`

**Returns:**
```typescript
{
  total_count: number,
  workflows: Array<{
    id: number,
    name: string,
    path: string,     // e.g. ".github/workflows/ci.yml"
    state: string,    // "active", "disabled_manually", etc.
  }>,
}
```

**Permission hint:** `actions:read`

---

#### 6. `github.trigger_workflow` (risk: medium)

**Purpose:** Manually trigger a workflow via `workflow_dispatch` event.

**Parameters:**
```
owner: string                        — Repository owner
repo: string                         — Repository name
workflow_id: string | number         — Workflow filename (e.g. "ci.yml") or numeric ID
ref: string                          — Branch or tag to run on
inputs: Record<string, string>?      — Workflow dispatch input values
```

**GitHub API call:**
- `POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches`

**Returns:**
```typescript
{
  message: string,  // confirmation that dispatch was accepted
}
```

**Note:** The dispatch API returns 204 with no body. The tool confirms the dispatch was accepted but cannot return the new run ID (GitHub creates it asynchronously). The agent can poll `list_workflow_runs` to find it.

**Permission hint:** `actions:write`

---

### What's NOT included

These `gh` capabilities are deliberately excluded:

| Capability | `gh` command | Reason |
|---|---|---|
| Delete workflow run | `gh run delete` | Destructive, no agent use case |
| Watch/poll a run | `gh run watch` | Agent can poll with `list_workflow_runs` |
| Enable/disable workflow | `gh workflow enable/disable` | Admin operation, not agent work |
| Download artifacts | `gh run download` | Artifacts are binary blobs; listing artifact metadata is included in `get_workflow_run` if needed later |

### Agent Workflow Examples

**Fix failing CI (most common):**
```
list_workflow_runs(owner, repo, status: "failure")
  → run 123 failed
get_workflow_run(owner, repo, run_id: 123)
  → job "Build" failed at step "Run cargo build"
  → annotation: src/lib.rs:42 — "trait bound not satisfied"
  → (often enough to fix without logs)
get_job_logs(owner, repo, job_id: 456)
  → last 500 lines of failed step output
  → (agent reads compiler error, fixes code)
rerun_workflow(owner, repo, run_id: 123, failed_only: true)
```

**Trigger a deploy:**
```
list_workflows(owner, repo)
  → finds "deploy.yml" (id: 789)
trigger_workflow(owner, repo, workflow_id: "deploy.yml", ref: "main")
  → dispatch accepted
list_workflow_runs(owner, repo, event: "workflow_dispatch")
  → find new run, monitor status
```

### Implementation Location

All changes are within `packages/plugin-github/src/actions/actions.ts`, following the existing pattern:

1. Add 6 `ActionDefinition` objects with Zod schemas (after `listWorkflowRuns`, before `readRepoFile`)
2. Add them to the `allActions` array
3. Add `case` blocks in `executeAction()` switch statement
4. Add permission hints to `PERMISSION_HINTS` map
5. Add a `parseJobLog()` helper function (in the helpers section at top of file) for step parsing, ANSI stripping, timestamp removal, and truncation

No new files, no new dependencies. The existing `octokit` package supports all required API endpoints.

### Log Parsing Helper

The `parseJobLog` function handles the log processing pipeline. Extracted as a pure function for testability:

```typescript
interface ParsedStep {
  name: string;
  conclusion: string;
  log: string;
  truncated: boolean;
  total_lines: number;
}

function parseJobLog(
  rawLog: string,
  steps: Array<{ name: string; conclusion: string | null }>,
  options: {
    failedOnly: boolean;
    stepName?: string;
    tailLines: number;
    includeTimestamps: boolean;
  },
): ParsedStep[]
```

This is the only non-trivial logic in the implementation. Everything else follows the existing Octokit request + map response pattern.
