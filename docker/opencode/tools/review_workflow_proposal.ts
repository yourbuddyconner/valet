import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { formatOutput } from "./_format"

export default tool({
  description: "Approve or reject a workflow proposal before apply.",
  args: {
    workflow_id: z.string().min(1).describe("Workflow ID or slug"),
    proposal_id: z.string().min(1).describe("Workflow proposal ID"),
    approve: z.boolean().describe("Set true to approve, false to reject"),
    notes: z.string().optional().describe("Optional review notes"),
  },
  async execute(args) {
    try {
      const res = await fetch(
        `http://localhost:9000/api/workflows/${encodeURIComponent(args.workflow_id)}/proposals/${encodeURIComponent(args.proposal_id)}/review`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            approve: args.approve,
            notes: args.notes,
          }),
        },
      )

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to review workflow proposal: ${errText}`
      }

      const data = (await res.json()) as Record<string, unknown>
      return formatOutput(data)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to review workflow proposal: ${msg}`
    }
  },
})
