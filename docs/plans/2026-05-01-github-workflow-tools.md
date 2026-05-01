# GitHub Workflow Tools Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add 6 new GitHub Actions tools to `plugin-github` for workflow run inspection, log retrieval, and management — achieving `gh run`/`gh workflow` CLI parity.

**Architecture:** All new tools follow the existing pattern in `actions.ts`: Zod-validated `ActionDefinition` + `case` block in `executeAction()` + Octokit API calls. The only new logic is `parseJobLog()`, a pure function that parses GitHub's raw log format into structured steps with filtering and truncation. Extracted for testability.

**Tech Stack:** TypeScript, Zod, Octokit, Vitest

**Design Spec:** `docs/specs/2026-05-01-github-workflow-tools-design.md`

---

### Task 1: Add `parseJobLog` helper with tests

The log parser is the only non-trivial logic in this feature. Build and test it first.

**Files:**
- Create: `packages/plugin-github/src/actions/parse-job-log.ts`
- Create: `packages/plugin-github/src/actions/parse-job-log.test.ts`

- [ ] **Step 1: Write the `parseJobLog` function**

Create `packages/plugin-github/src/actions/parse-job-log.ts`:

```typescript
/** Parsed step from a GitHub Actions job log. */
export interface ParsedStep {
  name: string;
  conclusion: string;
  log: string;
  truncated: boolean;
  total_lines: number;
}

export interface ParseJobLogOptions {
  failedOnly: boolean;
  stepName?: string;
  tailLines: number;
  includeTimestamps: boolean;
}

interface StepMeta {
  name: string;
  conclusion: string | null;
}

// Matches the ISO timestamp prefix GitHub adds to every log line:
// "2024-01-15T10:30:45.0000000Z " (28 chars + space)
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d+Z /;

// ANSI escape codes: ESC[ ... m  (SGR sequences)
const ANSI_RE = /\x1b\[[0-9;]*m/g;

// GitHub step markers
const GROUP_START_RE = /##\[group\](.*)/;
const GROUP_END = '##[endgroup]';
const ERROR_MARKER = '##[error]';

/**
 * Parse raw GitHub Actions job log into structured steps.
 *
 * Processing pipeline:
 * 1. Split into steps by ##[group]/##[endgroup] markers
 * 2. Match steps to metadata (names + conclusions) from the jobs API
 * 3. Filter by failedOnly / stepName
 * 4. Strip ANSI codes
 * 5. Strip timestamps (unless includeTimestamps)
 * 6. Truncate to tailLines (tail-biased), preserving ##[error] lines
 */
export function parseJobLog(
  rawLog: string,
  steps: StepMeta[],
  options: ParseJobLogOptions,
): ParsedStep[] {
  const sections = splitIntoSections(rawLog);
  const matched = matchSectionsToSteps(sections, steps);

  let filtered = matched;
  if (options.failedOnly) {
    filtered = filtered.filter((s) => s.conclusion === 'failure');
  }
  if (options.stepName) {
    const target = options.stepName.toLowerCase();
    filtered = filtered.filter((s) => s.name.toLowerCase().includes(target));
  }

  return filtered.map((s) => {
    let lines = s.lines;

    // Strip ANSI escape codes
    lines = lines.map((l) => l.replace(ANSI_RE, ''));

    // Strip timestamps unless requested
    if (!options.includeTimestamps) {
      lines = lines.map((l) => l.replace(TIMESTAMP_RE, ''));
    }

    // Truncate with tail bias, preserving ##[error] lines
    const totalLines = lines.length;
    let truncated = false;
    if (lines.length > options.tailLines) {
      const tail = lines.slice(-options.tailLines);
      // Preserve any ##[error] lines from the head that got cut
      const headErrors = lines
        .slice(0, -options.tailLines)
        .filter((l) => l.includes(ERROR_MARKER));
      truncated = true;
      lines = [
        ...headErrors,
        `[truncated ${totalLines - options.tailLines - headErrors.length} lines]`,
        ...tail,
      ];
    }

    return {
      name: s.name,
      conclusion: s.conclusion,
      log: lines.join('\n'),
      truncated,
      total_lines: totalLines,
    };
  });
}

interface RawSection {
  name: string;
  lines: string[];
}

function splitIntoSections(rawLog: string): RawSection[] {
  const sections: RawSection[] = [];
  let currentName = '(setup)';
  let currentLines: string[] = [];

  for (const line of rawLog.split('\n')) {
    // Strip timestamp for marker detection (but keep original line in output)
    const stripped = line.replace(TIMESTAMP_RE, '');

    const groupMatch = stripped.match(GROUP_START_RE);
    if (groupMatch) {
      // Save previous section if it has content
      if (currentLines.length > 0) {
        sections.push({ name: currentName, lines: currentLines });
      }
      currentName = groupMatch[1];
      currentLines = [];
      continue;
    }

    if (stripped === GROUP_END || stripped.startsWith(GROUP_END)) {
      sections.push({ name: currentName, lines: currentLines });
      currentName = '(between steps)';
      currentLines = [];
      continue;
    }

    currentLines.push(line);
  }

  // Flush remaining lines
  if (currentLines.length > 0) {
    sections.push({ name: currentName, lines: currentLines });
  }

  return sections;
}

function matchSectionsToSteps(
  sections: RawSection[],
  steps: StepMeta[],
): Array<{ name: string; conclusion: string; lines: string[] }> {
  return sections.map((section) => {
    // Try to match section name to a step from the API metadata
    const match = steps.find(
      (s) => s.name.toLowerCase() === section.name.toLowerCase(),
    );
    return {
      name: section.name,
      conclusion: match?.conclusion ?? 'unknown',
      lines: section.lines,
    };
  });
}
```

- [ ] **Step 2: Write tests for `parseJobLog`**

Create `packages/plugin-github/src/actions/parse-job-log.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import { parseJobLog } from './parse-job-log.js';
import type { ParsedStep, ParseJobLogOptions } from './parse-job-log.js';

const defaults: ParseJobLogOptions = {
  failedOnly: false,
  tailLines: 500,
  includeTimestamps: false,
};

function makeLogs(steps: Array<{ name: string; lines: string[] }>): string {
  return steps
    .map((s) => [
      `2024-01-15T10:30:00.0000000Z ##[group]${s.name}`,
      ...s.lines.map((l) => `2024-01-15T10:30:01.0000000Z ${l}`),
      `2024-01-15T10:30:02.0000000Z ##[endgroup]`,
    ].join('\n'))
    .join('\n');
}

describe('parseJobLog', () => {
  it('parses steps from group markers', () => {
    const raw = makeLogs([
      { name: 'Run checkout', lines: ['Cloning repo...', 'Done.'] },
      { name: 'Run tests', lines: ['PASS test_a', 'PASS test_b'] },
    ]);
    const steps = [
      { name: 'Run checkout', conclusion: 'success' },
      { name: 'Run tests', conclusion: 'success' },
    ];

    const result = parseJobLog(raw, steps, defaults);

    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('Run checkout');
    expect(result[0].conclusion).toBe('success');
    expect(result[0].log).toContain('Cloning repo...');
    expect(result[1].name).toBe('Run tests');
  });

  it('filters to failed steps when failedOnly=true', () => {
    const raw = makeLogs([
      { name: 'Run checkout', lines: ['OK'] },
      { name: 'Run build', lines: ['error: something broke'] },
    ]);
    const steps = [
      { name: 'Run checkout', conclusion: 'success' },
      { name: 'Run build', conclusion: 'failure' },
    ];

    const result = parseJobLog(raw, steps, { ...defaults, failedOnly: true });

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Run build');
    expect(result[0].conclusion).toBe('failure');
  });

  it('filters by step name (case-insensitive partial match)', () => {
    const raw = makeLogs([
      { name: 'Run checkout', lines: ['OK'] },
      { name: 'Run cargo build', lines: ['compiling...'] },
    ]);
    const steps = [
      { name: 'Run checkout', conclusion: 'success' },
      { name: 'Run cargo build', conclusion: 'success' },
    ];

    const result = parseJobLog(raw, steps, { ...defaults, stepName: 'cargo' });

    expect(result).toHaveLength(1);
    expect(result[0].name).toBe('Run cargo build');
  });

  it('strips timestamps by default', () => {
    const raw = '2024-01-15T10:30:00.0000000Z ##[group]Step\n2024-01-15T10:30:01.0000000Z hello world\n2024-01-15T10:30:02.0000000Z ##[endgroup]';
    const steps = [{ name: 'Step', conclusion: 'success' }];

    const result = parseJobLog(raw, steps, defaults);

    expect(result[0].log).toBe('hello world');
    expect(result[0].log).not.toContain('2024-01-15');
  });

  it('preserves timestamps when includeTimestamps=true', () => {
    const raw = '2024-01-15T10:30:00.0000000Z ##[group]Step\n2024-01-15T10:30:01.0000000Z hello world\n2024-01-15T10:30:02.0000000Z ##[endgroup]';
    const steps = [{ name: 'Step', conclusion: 'success' }];

    const result = parseJobLog(raw, steps, { ...defaults, includeTimestamps: true });

    expect(result[0].log).toContain('2024-01-15');
  });

  it('truncates to tailLines and preserves ##[error] lines from head', () => {
    const logLines = Array.from({ length: 100 }, (_, i) => `line ${i}`);
    logLines[5] = '##[error]Root cause error here';
    const raw = makeLogs([{ name: 'Build', lines: logLines }]);
    const steps = [{ name: 'Build', conclusion: 'failure' }];

    const result = parseJobLog(raw, steps, { ...defaults, tailLines: 10 });

    expect(result[0].truncated).toBe(true);
    expect(result[0].total_lines).toBe(100);
    // ##[error] line from the head should be preserved
    expect(result[0].log).toContain('Root cause error here');
    // Last line should be the tail
    expect(result[0].log).toContain('line 99');
    // Truncation marker should be present
    expect(result[0].log).toContain('[truncated');
  });

  it('strips ANSI escape codes', () => {
    const raw = '2024-01-15T10:30:00.0000000Z ##[group]Step\n2024-01-15T10:30:01.0000000Z \x1b[31merror\x1b[0m: bad thing\n2024-01-15T10:30:02.0000000Z ##[endgroup]';
    const steps = [{ name: 'Step', conclusion: 'failure' }];

    const result = parseJobLog(raw, steps, defaults);

    expect(result[0].log).toBe('error: bad thing');
    expect(result[0].log).not.toContain('\x1b');
  });

  it('handles logs without group markers as a single unnamed step', () => {
    const raw = '2024-01-15T10:30:01.0000000Z just some output\n2024-01-15T10:30:02.0000000Z more output';
    const steps = [{ name: 'Run tests', conclusion: 'failure' }];

    const result = parseJobLog(raw, steps, defaults);

    expect(result.length).toBeGreaterThanOrEqual(1);
    expect(result[0].log).toContain('just some output');
  });

  it('returns empty array when failedOnly=true and no steps failed', () => {
    const raw = makeLogs([{ name: 'Step', lines: ['OK'] }]);
    const steps = [{ name: 'Step', conclusion: 'success' }];

    const result = parseJobLog(raw, steps, { ...defaults, failedOnly: true });

    expect(result).toHaveLength(0);
  });

  it('does not truncate when under tailLines limit', () => {
    const raw = makeLogs([{ name: 'Step', lines: ['line 1', 'line 2', 'line 3'] }]);
    const steps = [{ name: 'Step', conclusion: 'success' }];

    const result = parseJobLog(raw, steps, { ...defaults, tailLines: 500 });

    expect(result[0].truncated).toBe(false);
    expect(result[0].total_lines).toBe(3);
  });
});
```

- [ ] **Step 3: Run tests to verify they pass**

```bash
cd packages/plugin-github && npx vitest run src/actions/parse-job-log.test.ts
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/plugin-github/src/actions/parse-job-log.ts packages/plugin-github/src/actions/parse-job-log.test.ts
git commit -m "feat(plugin-github): add parseJobLog helper with tests

Pure function that parses GitHub Actions raw job logs into structured
steps with filtering (failed-only, step name), ANSI/timestamp stripping,
and tail-biased truncation."
```

---

### Task 2: Add `get_workflow_run` action definition and execution

**Files:**
- Modify: `packages/plugin-github/src/actions/actions.ts:323-375` (definitions section) and `:905-932` (execution section)

- [ ] **Step 1: Add action definition**

In `packages/plugin-github/src/actions/actions.ts`, after the `listWorkflowRuns` definition (line 336) and before `readRepoFile` (line 338), add:

```typescript
const getWorkflowRun: ActionDefinition = {
  id: 'github.get_workflow_run',
  name: 'Get Workflow Run',
  description: 'Get details of a workflow run including jobs, steps, and check annotations. Use this to triage failures before fetching logs.',
  riskLevel: 'low',
  params: z.object({
    owner: z.string().describe('Repository owner'),
    repo: z.string().describe('Repository name'),
    run_id: z.number().int().describe('Workflow run ID'),
  }),
};
```

- [ ] **Step 2: Add to `allActions` array**

In the `allActions` array (line 351), add `getWorkflowRun` after `listWorkflowRuns`:

```typescript
  listWorkflowRuns,
  getWorkflowRun,
  readRepoFile,
```

- [ ] **Step 3: Add permission hints**

In the `PERMISSION_HINTS` object (line 379), add:

```typescript
  'github.get_workflow_run': 'actions:read + checks:read',
```

- [ ] **Step 4: Add execution case**

After the `github.list_workflow_runs` case block (after line 932), add:

```typescript
      case 'github.get_workflow_run': {
        const p = getWorkflowRun.params.parse(params);
        try {
          const [runResp, jobsResp] = await Promise.all([
            octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', {
              owner: p.owner, repo: p.repo, run_id: p.run_id,
            }),
            octokit.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}/jobs', {
              owner: p.owner, repo: p.repo, run_id: p.run_id, per_page: 100,
            }),
          ]);

          const run = runResp.data;
          const jobs = jobsResp.data.jobs;

          // Fetch check-run annotations for the head SHA
          let annotations: Array<{
            path: string;
            start_line: number;
            end_line: number;
            annotation_level: string;
            message: string;
            title: string | null;
          }> = [];
          if (run.head_sha) {
            try {
              const checksResp = await octokit.request('GET /repos/{owner}/{repo}/commits/{ref}/check-runs', {
                owner: p.owner, repo: p.repo, ref: run.head_sha, per_page: 100,
              });
              for (const cr of checksResp.data.check_runs) {
                if (cr.output?.annotations_count && cr.output.annotations_count > 0) {
                  try {
                    const annResp = await octokit.request('GET /repos/{owner}/{repo}/check-runs/{check_run_id}/annotations', {
                      owner: p.owner, repo: p.repo, check_run_id: cr.id,
                    });
                    for (const a of annResp.data) {
                      annotations.push({
                        path: a.path,
                        start_line: a.start_line,
                        end_line: a.end_line ?? a.start_line,
                        annotation_level: a.annotation_level,
                        message: a.message,
                        title: a.title ?? null,
                      });
                    }
                  } catch {
                    // skip if annotations endpoint fails
                  }
                }
              }
            } catch {
              // skip if check-runs endpoint fails (e.g. missing checks:read permission)
            }
          }

          return {
            success: true,
            data: {
              id: run.id,
              name: run.name,
              status: run.status,
              conclusion: run.conclusion,
              event: run.event,
              branch: run.head_branch,
              commit_sha: run.head_sha,
              url: run.html_url,
              created_at: run.created_at,
              updated_at: run.updated_at,
              run_attempt: run.run_attempt,
              jobs: jobs.map((j) => ({
                id: j.id,
                name: j.name,
                status: j.status,
                conclusion: j.conclusion,
                started_at: j.started_at,
                completed_at: j.completed_at,
                steps: (j.steps ?? []).map((s) => ({
                  name: s.name,
                  status: s.status,
                  conclusion: s.conclusion,
                  number: s.number,
                })),
              })),
              annotations,
            },
          };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'Get workflow run');
        }
      }
```

- [ ] **Step 5: Run typecheck**

```bash
cd packages/plugin-github && pnpm typecheck
```

Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-github/src/actions/actions.ts
git commit -m "feat(plugin-github): add get_workflow_run action

Returns run metadata, jobs with steps, and check-run annotations.
Equivalent to 'gh run view' — the triage step before fetching logs."
```

---

### Task 3: Add `get_job_logs` action definition and execution

**Files:**
- Modify: `packages/plugin-github/src/actions/actions.ts` (definitions + execution sections)

- [ ] **Step 1: Add import for `parseJobLog`**

At the top of `actions.ts` (after the existing imports, line 3), add:

```typescript
import { parseJobLog } from './parse-job-log.js';
```

- [ ] **Step 2: Add action definition**

After `getWorkflowRun` definition, add:

```typescript
const getJobLogs: ActionDefinition = {
  id: 'github.get_job_logs',
  name: 'Get Job Logs',
  description: 'Get log output from a specific workflow job. Parses logs into steps, filters to failed steps by default, strips noise, and truncates. Use after get_workflow_run to read failure details.',
  riskLevel: 'low',
  params: z.object({
    owner: z.string().describe('Repository owner'),
    repo: z.string().describe('Repository name'),
    job_id: z.number().int().describe('Job ID (from get_workflow_run response)'),
    failed_only: z.boolean().optional().default(true).describe('Only return failed step output (default: true)'),
    step_name: z.string().optional().describe('Filter to a specific step by name (partial match)'),
    tail_lines: z.number().int().min(10).max(5000).optional().default(500).describe('Max lines per step, tail-biased (default: 500)'),
    include_timestamps: z.boolean().optional().default(false).describe('Include ISO timestamp prefixes (default: false)'),
  }),
};
```

- [ ] **Step 3: Add to `allActions` array**

```typescript
  listWorkflowRuns,
  getWorkflowRun,
  getJobLogs,
  readRepoFile,
```

- [ ] **Step 4: Add permission hint**

```typescript
  'github.get_job_logs': 'actions:read',
```

- [ ] **Step 5: Add execution case**

After the `github.get_workflow_run` case block, add:

```typescript
      case 'github.get_job_logs': {
        const p = getJobLogs.params.parse(params);
        try {
          // Fetch job metadata (for step names + conclusions) and logs in parallel
          const [jobResp, logsResp] = await Promise.all([
            octokit.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}', {
              owner: p.owner, repo: p.repo, job_id: p.job_id,
            }),
            octokit.request('GET /repos/{owner}/{repo}/actions/jobs/{job_id}/logs', {
              owner: p.owner, repo: p.repo, job_id: p.job_id,
              headers: { accept: 'application/vnd.github.v3.raw' },
            }),
          ]);

          const job = jobResp.data;
          const rawLog = typeof logsResp.data === 'string'
            ? logsResp.data
            : new TextDecoder().decode(logsResp.data as ArrayBuffer);

          const stepsMeta = (job.steps ?? []).map((s) => ({
            name: s.name,
            conclusion: s.conclusion ?? null,
          }));

          const parsed = parseJobLog(rawLog, stepsMeta, {
            failedOnly: p.failed_only,
            stepName: p.step_name,
            tailLines: p.tail_lines,
            includeTimestamps: p.include_timestamps,
          });

          return {
            success: true,
            data: {
              job_id: job.id,
              job_name: job.name,
              steps: parsed,
            },
          };
        } catch (err: any) {
          if (err.status === 410) {
            return { success: false, error: 'Logs have expired. GitHub retains logs for 90 days by default.' };
          }
          return handleOctokitError(err, actionId, 'Get job logs');
        }
      }
```

- [ ] **Step 6: Run typecheck**

```bash
cd packages/plugin-github && pnpm typecheck
```

Expected: passes.

- [ ] **Step 7: Commit**

```bash
git add packages/plugin-github/src/actions/actions.ts
git commit -m "feat(plugin-github): add get_job_logs action

Fetches and parses job log output into structured steps. Filters to
failed steps by default, strips ANSI/timestamps, tail-truncates at
500 lines. Equivalent to 'gh run view --log-failed'."
```

---

### Task 4: Add `rerun_workflow` and `cancel_workflow_run` actions

**Files:**
- Modify: `packages/plugin-github/src/actions/actions.ts`

- [ ] **Step 1: Add action definitions**

After `getJobLogs` definition, add:

```typescript
const rerunWorkflow: ActionDefinition = {
  id: 'github.rerun_workflow',
  name: 'Rerun Workflow',
  description: 'Re-run a workflow run. Can re-run all jobs or only failed jobs.',
  riskLevel: 'medium',
  params: z.object({
    owner: z.string().describe('Repository owner'),
    repo: z.string().describe('Repository name'),
    run_id: z.number().int().describe('Workflow run ID to re-run'),
    failed_only: z.boolean().optional().default(false).describe('Only re-run failed jobs (default: false)'),
  }),
};

const cancelWorkflowRun: ActionDefinition = {
  id: 'github.cancel_workflow_run',
  name: 'Cancel Workflow Run',
  description: 'Cancel an in-progress workflow run.',
  riskLevel: 'medium',
  params: z.object({
    owner: z.string().describe('Repository owner'),
    repo: z.string().describe('Repository name'),
    run_id: z.number().int().describe('Workflow run ID to cancel'),
  }),
};
```

- [ ] **Step 2: Add to `allActions` array**

```typescript
  listWorkflowRuns,
  getWorkflowRun,
  getJobLogs,
  rerunWorkflow,
  cancelWorkflowRun,
  readRepoFile,
```

- [ ] **Step 3: Add permission hints**

```typescript
  'github.rerun_workflow': 'actions:write',
  'github.cancel_workflow_run': 'actions:write',
```

- [ ] **Step 4: Add execution cases**

After the `github.get_job_logs` case block, add:

```typescript
      case 'github.rerun_workflow': {
        const p = rerunWorkflow.params.parse(params);
        try {
          const endpoint = p.failed_only
            ? 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs'
            : 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun';
          await octokit.request(endpoint, {
            owner: p.owner, repo: p.repo, run_id: p.run_id,
          });
          const url = `https://github.com/${p.owner}/${p.repo}/actions/runs/${p.run_id}`;
          return {
            success: true,
            data: {
              message: p.failed_only
                ? `Re-running failed jobs for run ${p.run_id}`
                : `Re-running all jobs for run ${p.run_id}`,
              url,
            },
          };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'Rerun workflow');
        }
      }

      case 'github.cancel_workflow_run': {
        const p = cancelWorkflowRun.params.parse(params);
        try {
          await octokit.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/cancel', {
            owner: p.owner, repo: p.repo, run_id: p.run_id,
          });
          return {
            success: true,
            data: { message: `Cancelled workflow run ${p.run_id}` },
          };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'Cancel workflow run');
        }
      }
```

- [ ] **Step 5: Run typecheck**

```bash
cd packages/plugin-github && pnpm typecheck
```

Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-github/src/actions/actions.ts
git commit -m "feat(plugin-github): add rerun_workflow and cancel_workflow_run actions

rerun_workflow supports re-running all jobs or only failed ones.
cancel_workflow_run stops an in-progress run."
```

---

### Task 5: Add `list_workflows` and `trigger_workflow` actions

**Files:**
- Modify: `packages/plugin-github/src/actions/actions.ts`

- [ ] **Step 1: Add action definitions**

After `cancelWorkflowRun` definition, add:

```typescript
const listWorkflows: ActionDefinition = {
  id: 'github.list_workflows',
  name: 'List Workflows',
  description: 'List workflow definitions in a repository. Returns workflow names, file paths, and states.',
  riskLevel: 'low',
  params: z.object({
    owner: z.string().describe('Repository owner'),
    repo: z.string().describe('Repository name'),
  }),
};

const triggerWorkflow: ActionDefinition = {
  id: 'github.trigger_workflow',
  name: 'Trigger Workflow',
  description: 'Manually trigger a workflow via workflow_dispatch event. The workflow must have a workflow_dispatch trigger configured.',
  riskLevel: 'medium',
  params: z.object({
    owner: z.string().describe('Repository owner'),
    repo: z.string().describe('Repository name'),
    workflow_id: z.union([z.string(), z.number().int()]).describe('Workflow filename (e.g. "ci.yml") or numeric ID'),
    ref: z.string().describe('Branch or tag to run the workflow on'),
    inputs: z.record(z.string()).optional().describe('Workflow dispatch input values (key-value pairs)'),
  }),
};
```

- [ ] **Step 2: Add to `allActions` array**

```typescript
  listWorkflowRuns,
  getWorkflowRun,
  getJobLogs,
  rerunWorkflow,
  cancelWorkflowRun,
  listWorkflows,
  triggerWorkflow,
  readRepoFile,
```

- [ ] **Step 3: Add permission hints**

```typescript
  'github.list_workflows': 'actions:read',
  'github.trigger_workflow': 'actions:write',
```

- [ ] **Step 4: Add execution cases**

After the `github.cancel_workflow_run` case block, add:

```typescript
      case 'github.list_workflows': {
        const p = listWorkflows.params.parse(params);
        try {
          const { data } = await octokit.request('GET /repos/{owner}/{repo}/actions/workflows', {
            owner: p.owner, repo: p.repo,
          });
          return {
            success: true,
            data: {
              total_count: data.total_count,
              workflows: data.workflows.map((w) => ({
                id: w.id,
                name: w.name,
                path: w.path,
                state: w.state,
              })),
            },
          };
        } catch (err: any) {
          return handleOctokitError(err, actionId, 'List workflows');
        }
      }

      case 'github.trigger_workflow': {
        const p = triggerWorkflow.params.parse(params);
        try {
          await octokit.request('POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches', {
            owner: p.owner, repo: p.repo,
            workflow_id: p.workflow_id,
            ref: p.ref,
            inputs: p.inputs,
          });
          return {
            success: true,
            data: {
              message: `Workflow dispatch accepted for ${p.workflow_id} on ${p.ref}. Use list_workflow_runs to find the new run.`,
            },
          };
        } catch (err: any) {
          if (err.status === 422) {
            return { success: false, error: 'Workflow dispatch failed. Make sure the workflow has a workflow_dispatch trigger and the inputs match the expected schema.' };
          }
          return handleOctokitError(err, actionId, 'Trigger workflow');
        }
      }
```

- [ ] **Step 5: Run typecheck**

```bash
cd packages/plugin-github && pnpm typecheck
```

Expected: passes.

- [ ] **Step 6: Commit**

```bash
git add packages/plugin-github/src/actions/actions.ts
git commit -m "feat(plugin-github): add list_workflows and trigger_workflow actions

list_workflows discovers workflow definitions in a repo.
trigger_workflow fires a workflow_dispatch event."
```

---

### Task 6: Regenerate content registry and final verification

The content registry must be regenerated so the worker discovers the new actions.

**Files:**
- Modify (auto-generated): `packages/worker/src/plugins/content-registry.ts`

- [ ] **Step 1: Regenerate registries**

```bash
make generate-registries
```

Expected: `packages/worker/src/plugins/content-registry.ts` is updated (and possibly `packages/worker/src/integrations/packages.ts` — check the diff).

- [ ] **Step 2: Run full typecheck**

```bash
pnpm typecheck
```

Expected: passes across all packages.

- [ ] **Step 3: Run all plugin-github tests**

```bash
cd packages/plugin-github && npx vitest run
```

Expected: all tests pass.

- [ ] **Step 4: Commit**

```bash
git add packages/worker/src/plugins/content-registry.ts packages/worker/src/integrations/packages.ts
git commit -m "chore: regenerate plugin registries for workflow tools"
```
