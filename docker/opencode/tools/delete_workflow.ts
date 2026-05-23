import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { denyInWorkflowSession } from "./_workflow_session_guard"

export default tool({
  description: "Delete a workflow by ID or slug.",
  args: {
    workflow_id: z.string().min(1).describe("Workflow ID or slug"),
  },
  async execute(args) {
    const denied = denyInWorkflowSession("delete_workflow")
    if (denied) return denied

    const endpoint = `http://localhost:9000/api/workflows/${encodeURIComponent(args.workflow_id)}`

    // Use curl subprocess to avoid Bun fetch() connection reuse bugs
    // that cause "socket connection was closed unexpectedly" errors.
    const proc = Bun.spawn(["curl", "-sf", "-X", "DELETE", "-H", "Content-Type: application/json", endpoint], {
      stdout: "pipe",
      stderr: "pipe",
    })

    const [stdout, stderr] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
    ])
    const exitCode = await proc.exited

    if (exitCode !== 0) {
      // curl -f returns exit code 22 for HTTP errors (4xx/5xx)
      const detail = stderr.trim() || stdout.trim() || `curl exit code ${exitCode}`
      return `Failed to delete workflow: ${detail}`
    }

    try {
      const data = JSON.parse(stdout)
      if (data.error) {
        return `Failed to delete workflow: ${data.error}`
      }
    } catch {
      // Non-JSON response is fine — success with no body
    }

    return `Workflow deleted: ${args.workflow_id}`
  },
})
