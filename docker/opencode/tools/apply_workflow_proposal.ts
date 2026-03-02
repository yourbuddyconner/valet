import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { formatOutput } from "./_format"

export default tool({
  description: "Apply an approved workflow proposal to update the workflow definition.",
  args: {
    workflow_id: z.string().min(1).describe("Workflow ID or slug"),
    proposal_id: z.string().min(1).describe("Workflow proposal ID"),
    review_notes: z.string().optional().describe("Optional apply notes"),
    version: z.string().optional().describe("Optional explicit version after apply"),
  },
  async execute(args) {
    try {
      const res = await fetch(
        `http://localhost:9000/api/workflows/${encodeURIComponent(args.workflow_id)}/proposals/${encodeURIComponent(args.proposal_id)}/apply`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            reviewNotes: args.review_notes,
            version: args.version,
          }),
        },
      )

      if (!res.ok) {
        const errText = await res.text()
        return `Failed to apply workflow proposal: ${errText}`
      }

      const data = (await res.json()) as Record<string, unknown>
      return formatOutput(data)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      return `Failed to apply workflow proposal: ${msg}`
    }
  },
})
