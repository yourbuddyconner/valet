// Guard for destructive workflow/trigger tools when running inside a workflow session.
//
// Workflow sessions are spawned with IS_WORKFLOW_SESSION=true in their sandbox env
// (see packages/worker/src/durable-objects/workflow-executor.ts buildSandboxEnvVars).
// Letting the agent delete/modify the workflow that spawned it (or its triggers) is a
// footgun — the workflow can disappear mid-execution. Route those changes through the
// user via the orchestrator instead.
export function denyInWorkflowSession(toolName: string): string | null {
  if (process.env.IS_WORKFLOW_SESSION === "true") {
    return (
      `Tool \`${toolName}\` is disabled inside workflow sessions. ` +
      `Workflow sessions cannot modify the workflow that spawned them or its triggers. ` +
      `Ask the user via the orchestrator session instead.`
    )
  }
  return null
}
