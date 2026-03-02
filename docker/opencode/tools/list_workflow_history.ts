import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { formatOutput } from "./_format"

interface WorkflowHistoryResponse {
  currentWorkflowHash?: string
  history?: unknown[]
}

export default tool({
  description: "List immutable workflow history snapshots for rollback and auditing.",
  args: {
    workflow_id: z.string().min(1).describe("Workflow ID or slug"),
    limit: z.number().int().min(1).max(200).optional().describe("Max history entries to return (default 50)"),
    offset: z.number().int().min(0).optional().describe("Offset for pagination (default 0)"),
  },
  async execute(args) {
    try {
      const params = new URLSearchParams()
      if (args.limit) params.set("limit", String(args.limit))
      if (args.offset !== undefined) params.set("offset", String(args.offset))

      const qs = params.toString()
      const res = await fetch(
        `http://localhost:9000/api/workflows/${encodeURIComponent(args.workflow_id)}/history${qs ? `?${qs}` : ""}`,
      )

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to list workflow history: ${errText}`
      }

      const data = (await res.json()) as WorkflowHistoryResponse
      return formatOutput({
          workflowId: args.workflow_id,
          currentWorkflowHash: data.currentWorkflowHash || null,
          history: data.history || [],
        })
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to list workflow history: ${msg}`
    }
  },
})
