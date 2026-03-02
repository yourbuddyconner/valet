import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { formatOutput } from "./_format"

export default tool({
  description:
    "Approve or deny a waiting workflow approval checkpoint for an execution. " +
    "Requires the current resume token from get_execution.",
  args: {
    execution_id: z.string().min(1).describe("Workflow execution ID"),
    approve: z.boolean().describe("Set true to approve, false to deny"),
    resume_token: z.string().min(1).describe("Current resume token from execution.resumeToken"),
    reason: z.string().optional().describe("Optional reason when denying approval"),
  },
  async execute(args) {
    try {
      const res = await fetch(`http://localhost:9000/api/executions/${encodeURIComponent(args.execution_id)}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          approve: args.approve,
          resumeToken: args.resume_token,
          reason: args.reason,
        }),
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to apply approval decision: ${errText}`
      }

      const data = (await res.json()) as { success?: boolean; status?: string }
      return formatOutput({
        success: data.success === true,
        executionId: args.execution_id,
        status: data.status || "unknown",
        approved: args.approve,
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to apply approval decision: ${msg}`
    }
  },
})

