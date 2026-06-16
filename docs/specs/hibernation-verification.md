# Hibernation Verification Checklist

Manual ops checklist for verifying that Cloudflare Workflow instance
hibernation works correctly across worker deploys. Run on every M1
release candidate.

This is intentionally a manual procedure: Cloudflare's hibernation +
replay semantics cannot be faithfully mocked in vitest, and `wrangler
dev` doesn't reliably trigger hibernation. Real verification requires a
deployed worker.

## Prerequisites

- Dev environment configured (`ENVIRONMENT=dev` in `.env.deploy`).
- A `dag/v1` workflow saved in dev with a single `wait` node (`duration:
  "2m"`) followed by a `set` node that writes a marker, followed by a
  `stop` node. Manual trigger.

## Procedure

1. **Baseline deploy.** Run `ENVIRONMENT=dev make deploy` and wait for
   it to complete cleanly. Confirm the workflow is published.
2. **Trigger the workflow** via the manual-run API (or UI). Capture the
   `executionId` from the response.
3. **Confirm it started.** Hit the execution detail API; status should
   be `running` or `waiting_time`, with the `wait` node's trace row in
   `running`/`waiting_time` state.
4. **Wait ~30 seconds**, then `ENVIRONMENT=dev make deploy` again
   (mid-wait redeploy). This restarts the worker. Confirm the deploy
   succeeds.
5. **Wait for the workflow's `wait` to elapse** (~90 more seconds after
   the redeploy, depending on timing).
6. **Verify completion.** Hit the execution detail API. Expected:
   - Execution status: `completed`.
   - `wait` node trace: `completed`, `duration` close to 2 minutes.
   - `set` node trace: `completed`, output contains the marker value.
   - `stop` node trace: `completed`.
7. **No stuck `cancelling` rows.** Query `workflow_executions` for any
   row in `cancelling` status — should be empty.

## Failure cases

If step 6 shows the execution stuck in `waiting_time` past its scheduled
resume time, hibernation replay is broken. Capture worker logs from the
window spanning the redeploy and file the regression. Do not ship M1.

If step 6 shows the execution in `failed` with a replay-related error,
the interpreter is reading non-deterministic state across the wake.
Audit any use of `Date.now()` / `Math.random()` / `new Date()` outside
`step.do` returns.

If step 7 shows `cancelling` rows, the cron cleanup sweep didn't run
during the test window (cron interval is 5 minutes). Re-run after the
next cron tick. If still stuck, the cleanup helper has a bug.

## Cadence

- Every M1 release candidate (before tagging).
- After any change to `runWorkflowDag`, the `wait` node executor, or the
  cancel/cleanup helpers.
- After any change to worker `compatibility_date` or the Workflows
  binding configuration.
