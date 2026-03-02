import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { formatOutput } from "./_format"

export default tool({
  description: "List workflow mutation proposals for a workflow.",
  args: {
    workflow_id: z.string().min(1).describe("Workflow ID or slug"),
    status: z.enum(["pending", "approved", "rejected", "applied", "failed"]).optional().describe("Optional status filter"),
    limit: z.number().int().min(1).max(200).optional().describe("Max proposals to return (default 50)"),
    offset: z.number().int().min(0).optional().describe("Offset for pagination (default 0)"),
  },
  async execute(args) {
    try {
      const params = new URLSearchParams()
      if (args.status) params.set("status", args.status)
      if (args.limit) params.set("limit", String(args.limit))
      if (args.offset !== undefined) params.set("offset", String(args.offset))

      const qs = params.toString()
      const res = await fetch(
        `http://localhost:9000/api/workflows/${encodeURIComponent(args.workflow_id)}/proposals${qs ? `?${qs}` : ""}`,
      )

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to list workflow proposals: ${errText}`
      }

      const data = (await res.json()) as { proposals?: unknown[] }
      const proposals = data.proposals || []
      if (proposals.length === 0) {
        return "No workflow proposals found."
      }
      return formatOutput(proposals)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to list workflow proposals: ${msg}`
    }
  },
})
