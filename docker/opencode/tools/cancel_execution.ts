import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { formatOutput } from "./_format"

export default tool({
  description:
    "Cancel a workflow execution. " +
    "Useful for stopping stuck runs or resetting after a failed approval/resume path.",
  args: {
    execution_id: z.string().min(1).describe("Workflow execution ID"),
    reason: z.string().optional().describe("Optional cancellation reason"),
  },
  async execute(args) {
    try {
      const res = await fetch(`http://localhost:9000/api/executions/${encodeURIComponent(args.execution_id)}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          reason: args.reason,
        }),
      })

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to cancel execution: ${errText}`
      }

      const data = (await res.json()) as { success?: boolean; status?: string }
      return formatOutput({
        success: data.success === true,
        executionId: args.execution_id,
        status: data.status || "unknown",
      })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to cancel execution: ${msg}`
    }
  },
})

